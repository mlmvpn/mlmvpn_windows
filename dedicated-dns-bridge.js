// --- Dedicated DNS bridge (system-wide) ---
//
// WHY THIS EXISTS.
// The dedicated DNS worker was only ever wired into Xray's `dns` block, which means it
// applied to proxied lookups and nothing else: with no tunnel up, the browser never went
// near it. That is why a worker that demonstrably works for other people did nothing here
// — it was correct code plugged into the wrong socket.
//
// Windows cannot be pointed at a DoH URL. `Set-DnsClientServerAddress` takes IP addresses,
// and Windows 11's own DoH support only accepts a template bound to a known resolver IP.
// So this listens on 127.0.0.1:53 as an ordinary UDP/TCP resolver, and forwards every
// query to the user's worker over DoH. Windows talks plain DNS to localhost; localhost
// talks encrypted DoH to Cloudflare's edge. The ISP sees neither the question nor a chance
// to forge the answer.
//
// What this fixes: sites blocked by DNS poisoning (the answer is hijacked to 10.10.34.34)
// open, at full speed, because the traffic itself still goes direct — only the lookup is
// rerouted. What it cannot fix: sites blocked at the IP or SNI layer. Nothing that only
// changes DNS can fix those, and claiming otherwise is how this feature got its
// reputation for being decorative.
//
// Bootstrap: the worker's OWN hostname cannot be resolved through the worker, so that one
// name is answered from the upstream resolvers directly and then pinned in the cache.

const dgram = require('dgram');
const net = require('net');
const https = require('https');
const dnsPromises = require('dns').promises;

// Candidate listen addresses, in order.
//
// 127.0.0.1:53 is the obvious one and frequently taken: Shecan, AdGuard, Pi-hole clients,
// Docker and WSL all like that address, and Windows reports the conflict as EACCES rather
// than EADDRINUSE — which reads as a permissions problem and sends the user hunting for an
// elevation bug that does not exist (this app already runs elevated).
//
// The whole 127.0.0.0/8 range is loopback on Windows with no extra configuration, and
// Set-DnsClientServerAddress accepts any of it. So a taken 127.0.0.1 is not a dead end:
// bind the next address instead and point Windows at that one.
const LISTEN_CANDIDATES = ['127.0.0.1', '127.0.0.2', '127.0.0.53', '127.53.53.53'];
const LISTEN_PORT = 53;

// Whichever candidate actually bound. Read by the DNS manager when it tells Windows which
// resolver to use, so the two can never disagree.
let LISTEN_ADDR = LISTEN_CANDIDATES[0];
const UPSTREAM_TIMEOUT_MS = 5000;
const NEGATIVE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 5000;

// Bootstrap resolvers used ONLY to resolve the worker's own hostname. Plain DNS is fine
// here: workers.dev is not a filtered name, and this happens once.
const BOOTSTRAP_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

let server = null;         // UDP socket
let tcpServer = null;      // TCP fallback (large answers, some clients)
let state = {
    running: false,
    dohUrl: '',
    startedAt: 0,
    queries: 0,
    cacheHits: 0,
    errors: 0,
    lastError: '',
};

// name+type -> { answer: Buffer (without the ID), expires: ms }
const cache = new Map();

// ── DNS message helpers ──────────────────────────────────────────────────────

// The transaction ID is per-client, but the rest of the message is identical for the same
// question — so the cache stores the body and each reply gets the caller's own ID stamped
// back in. Caching the whole message would hand client B client A's ID and be discarded.
function withId(body, id) {
    const out = Buffer.from(body);
    out.writeUInt16BE(id, 0);
    return out;
}

function questionKey(msg) {
    try {
        if (msg.length < 12) return null;
        let pos = 12;
        const labels = [];
        while (pos < msg.length) {
            const len = msg[pos++];
            if (len === 0) break;
            if ((len & 0xc0) === 0xc0) return null; // no compression in a question
            labels.push(msg.slice(pos, pos + len).toString('latin1'));
            pos += len;
        }
        if (pos + 4 > msg.length) return null;
        const qtype = msg.readUInt16BE(pos);
        const qclass = msg.readUInt16BE(pos + 2);
        return `${labels.join('.').toLowerCase()}|${qtype}|${qclass}`;
    } catch (e) {
        return null;
    }
}

// Smallest TTL across the answer section, which is how long the whole reply stays true.
function answerTtlMs(msg) {
    try {
        const qdcount = msg.readUInt16BE(4);
        const ancount = msg.readUInt16BE(6);
        if (ancount === 0) return NEGATIVE_TTL_MS;

        let pos = 12;
        for (let q = 0; q < qdcount; q++) {
            while (pos < msg.length) { const len = msg[pos++]; if (len === 0) break; pos += len; }
            pos += 4;
        }
        let min = Infinity;
        for (let a = 0; a < ancount; a++) {
            if (pos >= msg.length) break;
            if ((msg[pos] & 0xc0) === 0xc0) pos += 2;
            else { while (pos < msg.length) { const len = msg[pos++]; if (len === 0) break; pos += len; } }
            if (pos + 10 > msg.length) break;
            const ttl = msg.readUInt32BE(pos + 4);
            const rdlength = msg.readUInt16BE(pos + 8);
            pos += 10 + rdlength;
            if (ttl < min) min = ttl;
        }
        if (!Number.isFinite(min)) return NEGATIVE_TTL_MS;
        return Math.max(1, Math.min(min, 3600)) * 1000;
    } catch (e) {
        return NEGATIVE_TTL_MS;
    }
}

function servfail(msg) {
    const out = Buffer.alloc(12);
    if (msg && msg.length >= 12) msg.copy(out, 0, 0, 12);
    out.writeUInt16BE(0x8182, 2); // QR=1, RD copied loosely, RCODE=2 (SERVFAIL)
    out.writeUInt16BE(0, 6);      // ANCOUNT
    out.writeUInt16BE(0, 8);      // NSCOUNT
    out.writeUInt16BE(0, 10);     // ARCOUNT
    // Keep the question section so clients that match on it do not discard the reply.
    return msg && msg.length > 12 ? Buffer.concat([out, msg.slice(12)]) : out;
}

// ── upstream: the user's worker, over DoH ────────────────────────────────────

// The worker hostname is resolved once via plain public DNS and the IP is reused, so the
// bridge never depends on the very resolver it is replacing.
let workerHost = '';
let workerIps = [];
let workerIpAt = 0;

async function resolveWorkerHost(host) {
    if (workerIps.length && workerHost === host && Date.now() - workerIpAt < 3600_000) return workerIps;
    const resolver = new dnsPromises.Resolver();
    resolver.setServers(BOOTSTRAP_RESOLVERS);
    const addrs = await resolver.resolve4(host);
    if (!addrs || !addrs.length) throw new Error(`cannot resolve ${host}`);
    workerHost = host;
    // Keep every address: workers.dev answers with several, and one being unreachable on
    // this network is not the same as the worker being down.
    workerIps = addrs;
    workerIpAt = Date.now();
    return workerIps;
}

function postDoh(url, ip, query) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const req = https.request({
            // Connect to the pinned IP but keep SNI/Host on the real name, so no lookup is
            // needed at connect time and TLS still validates.
            host: ip,
            servername: target.hostname,
            port: target.port || 443,
            path: target.pathname + target.search,
            method: 'POST',
            headers: {
                // MUST be set explicitly. Connecting by IP makes Node default the Host
                // header to that IP, Cloudflare finds no zone by that name, and every
                // request comes back 403 Forbidden — the worker is never even reached.
                Host: target.host,
                'Content-Type': 'application/dns-message',
                'Accept': 'application/dns-message',
                'Content-Length': query.length,
            },
            timeout: UPSTREAM_TIMEOUT_MS,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`worker HTTP ${res.statusCode}`));
                resolve(Buffer.concat(chunks));
            });
        });
        req.on('timeout', () => req.destroy(new Error('worker timeout')));
        req.on('error', reject);
        req.write(query);
        req.end();
    });
}

async function askUpstream(query) {
    const target = new URL(state.dohUrl);
    const ips = await resolveWorkerHost(target.hostname);

    // Try each address before giving up. Cloudflare hands out several and, on a filtered
    // network, some of them are reachable while others black-hole — a single pinned
    // address turns that into a total outage.
    let lastError = null;
    for (const ip of ips) {
        try {
            return await postDoh(state.dohUrl, ip, query);
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError || new Error('no upstream address');
}

// ── query handling ───────────────────────────────────────────────────────────

async function handleQuery(msg) {
    if (!msg || msg.length < 12) throw new Error('short query');
    const id = msg.readUInt16BE(0);
    const key = questionKey(msg);

    if (key) {
        const hit = cache.get(key);
        if (hit && hit.expires > Date.now()) {
            state.cacheHits++;
            return withId(hit.answer, id);
        }
        if (hit) cache.delete(key);
    }

    const answer = await askUpstream(msg);
    state.queries++;

    if (key && answer.length >= 12) {
        // A crude cap beats an unbounded map in a process that runs for days.
        if (cache.size >= MAX_CACHE_ENTRIES) {
            for (const k of cache.keys()) { cache.delete(k); if (cache.size < MAX_CACHE_ENTRIES * 0.9) break; }
        }
        cache.set(key, { answer: withId(answer, 0), expires: Date.now() + answerTtlMs(answer) });
    }
    return withId(answer, id);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

/** Who is holding a loopback DNS port, by name — so the error can say so. */
function findPortOwner(address, port) {
    try {
        const { execSync } = require('child_process');
        const out = execSync(
            `powershell -NoProfile -Command "$p=(Get-NetUDPEndpoint -LocalAddress ${address} -LocalPort ${port} -ErrorAction SilentlyContinue).OwningProcess; if ($p) { (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName }"`,
            { timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
        ).toString().trim();
        return out || '';
    } catch (e) {
        return '';
    }
}

/**
 * Does our own listener actually receive packets?
 *
 * A successful bind is not proof. DNS-forcing clients (Shecan and friends) install a
 * driver-level filter that captures ALL port-53 traffic, including loopback: the socket
 * binds, reports itself healthy, and never sees a single query. Measured on this machine —
 * a packet to 127.0.0.2:15353 arrives, the same packet to 127.0.0.2:53 disappears.
 *
 * So the listener is asked to prove itself with a real query before Windows is handed over
 * to it. Without this check the feature "starts", the machine is pointed at a resolver
 * that answers nothing, and the user loses all DNS with a green light on screen.
 */
function verifyListener(address, timeoutMs = 2500) {
    return new Promise((resolve) => {
        // A minimal A query for localhost. Answered from upstream like any other, but the
        // only thing that matters is whether the socket sees it at all.
        const probe = Buffer.from([
            0x5a, 0x5a, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0,
            9, 0x6c, 0x6f, 0x63, 0x61, 0x6c, 0x68, 0x6f, 0x73, 0x74, 0,
            0, 1, 0, 1,
        ]);
        const before = state.queries + state.cacheHits + state.errors;
        const sock = dgram.createSocket('udp4');
        const finish = (ok) => { try { sock.close(); } catch (e) {} resolve(ok); };
        const timer = setTimeout(() => {
            // A reply is ideal, but "the handler ran" is enough: upstream may legitimately
            // fail for this name while the listener itself is perfectly reachable.
            finish(state.queries + state.cacheHits + state.errors > before);
        }, timeoutMs);
        sock.on('message', () => { clearTimeout(timer); finish(true); });
        sock.on('error', () => { clearTimeout(timer); finish(false); });
        sock.send(probe, LISTEN_PORT, address);
    });
}

async function start(dohUrl) {
    if (state.running) return { ok: true, alreadyRunning: true, port: LISTEN_PORT, address: LISTEN_ADDR };
    if (!dohUrl || !/^https?:\/\//i.test(dohUrl)) throw new Error('آدرس Worker معتبر نیست.');

    // Try each loopback address until one binds AND proves it receives traffic.
    const conflicts = [];
    let hijacked = false;
    for (const candidate of LISTEN_CANDIDATES) {
        try {
            const started = await startOn(candidate, dohUrl);
            if (await verifyListener(candidate)) return started;

            // Bound but deaf: something below the socket layer is eating port 53.
            hijacked = true;
            await stop();
            const owner = findPortOwner(candidate, LISTEN_PORT);
            conflicts.push(`${candidate}${owner ? ` (${owner})` : ' (ربوده‌شده)'}`);
        } catch (e) {
            if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
            const owner = findPortOwner(candidate, LISTEN_PORT);
            conflicts.push(`${candidate}${owner ? ` (${owner})` : ''}`);
        }
    }

    const names = [...new Set(conflicts.map((c) => (c.match(/\(([^)]+)\)/) || [])[1]).filter(Boolean)
        .filter((n) => n !== 'ربوده‌شده'))];
    throw new Error(
        hijacked
            ? 'یک برنامه‌ی دیگر کل ترافیک پورت ۵۳ را در سطح درایور می‌گیرد' +
              (names.length ? ` (${names.join('، ')})` : '') + '.\n' +
              'برنامه‌های DNS مثل شکن این کار را می‌کنند. آن را ببند و دوباره امتحان کن — ' +
              'یا به‌جای این، «باز کردن سایت‌های فیلترشده از راه تونل» را روشن کن که DNS را داخل تونل حل می‌کند و به پورت ۵۳ کاری ندارد.'
            : `پورت ۵۳ روی هیچ آدرس محلی آزاد نبود: ${conflicts.join('، ')}.\n` +
              'یک سرویس DNS دیگر (مثل شکن، AdGuard یا Pi-hole) آن را گرفته — آن را ببند و دوباره امتحان کن.'
    );
}

function startOn(address, dohUrl) {
    return new Promise((resolve, reject) => {
        state = { running: false, dohUrl, startedAt: 0, queries: 0, cacheHits: 0, errors: 0, lastError: '' };
        cache.clear();

        // NOT reuseAddr. On Windows SO_REUSEADDR lets a second socket bind an address another
        // process already owns; the bind "succeeds", the packets keep going to the first
        // listener, and this resolver answers nothing while reporting itself healthy. That
        // silent half-start is worse than a clean failure — and it also hides the conflict
        // from the fallback below, which exists precisely to step around it.
        const udp = dgram.createSocket({ type: 'udp4' });

        udp.on('message', async (msg, rinfo) => {
            try {
                const reply = await handleQuery(msg);
                udp.send(reply, rinfo.port, rinfo.address);
            } catch (e) {
                state.errors++;
                state.lastError = e.message;
                try { udp.send(servfail(msg), rinfo.port, rinfo.address); } catch (_) {}
            }
        });

        udp.on('error', (err) => {
            state.running = false;
            state.lastError = err.message;
            try { udp.close(); } catch (_) {}
            // Pass the code up untouched: start() decides whether a conflict means "try the
            // next address" or "give up", and it can only tell them apart from the code.
            reject(err);
        });

        udp.bind(LISTEN_PORT, address, () => {
            server = udp;
            LISTEN_ADDR = address;

            // TCP/53 as well: a client that gets a truncated (TC=1) answer retries over TCP,
            // and without a listener there that retry is a dead end rather than a fallback.
            const tcp = net.createServer((sock) => {
                let buf = Buffer.alloc(0);
                sock.on('data', async (chunk) => {
                    buf = Buffer.concat([buf, chunk]);
                    while (buf.length >= 2) {
                        const len = buf.readUInt16BE(0);
                        if (buf.length < 2 + len) break;
                        const msg = buf.slice(2, 2 + len);
                        buf = buf.slice(2 + len);
                        try {
                            const reply = await handleQuery(msg);
                            const framed = Buffer.alloc(2 + reply.length);
                            framed.writeUInt16BE(reply.length, 0);
                            reply.copy(framed, 2);
                            sock.write(framed);
                        } catch (e) {
                            state.errors++;
                            state.lastError = e.message;
                            sock.destroy();
                        }
                    }
                });
                sock.on('error', () => sock.destroy());
                sock.setTimeout(15000, () => sock.destroy());
            });
            tcp.on('error', () => { /* UDP alone is still a working resolver */ });
            tcp.listen(LISTEN_PORT, address, () => { tcpServer = tcp; });

            state.running = true;
            state.startedAt = Date.now();
            resolve({ ok: true, port: LISTEN_PORT, address });
        });
    });
}

function stop() {
    return new Promise((resolve) => {
        const closers = [];
        if (server) closers.push(new Promise(r => server.close(r)));
        if (tcpServer) closers.push(new Promise(r => tcpServer.close(r)));
        Promise.all(closers).then(() => {
            server = null;
            tcpServer = null;
            state.running = false;
            cache.clear();
            resolve({ ok: true });
        }).catch(() => { server = null; tcpServer = null; state.running = false; resolve({ ok: true }); });
    });
}

function getStatus() {
    return {
        ...state,
        address: LISTEN_ADDR,
        port: LISTEN_PORT,
        cacheSize: cache.size,
        uptimeSec: state.running ? Math.round((Date.now() - state.startedAt) / 1000) : 0,
        workerIps,
    };
}

// Resolve one name THROUGH the bridge, for the panel's "is it really working?" check.
async function testResolve(domain = 'www.google.com') {
    if (!state.running) throw new Error('سرویس محلی در حال اجرا نیست.');
    const query = buildQuery(domain);
    const start = Date.now();
    const reply = await handleQuery(query);
    return { domain, ms: Date.now() - start, ips: parseAnswers(reply), poisoned: parseAnswers(reply).some(isPoisonedIp) };
}

// Iranian ISPs answer a DNS-blocked name with one of these. Seeing one here means the
// lookup did NOT come from the worker — which is the single most useful thing this panel
// can tell the user, so it is checked explicitly rather than left to look like success.
const POISON_IPS = ['10.10.34.34', '10.10.34.35', '10.10.34.36'];
function isPoisonedIp(ip) {
    return POISON_IPS.includes(ip);
}

function buildQuery(domain) {
    const labels = domain.split('.').filter(Boolean);
    const nameLen = labels.reduce((s, l) => s + 1 + Buffer.byteLength(l), 0) + 1;
    const buf = Buffer.alloc(12 + nameLen + 4);
    buf.writeUInt16BE(Math.floor(Math.random() * 0xffff), 0);
    buf.writeUInt16BE(0x0100, 2); // recursion desired
    buf.writeUInt16BE(1, 4);      // QDCOUNT
    let pos = 12;
    for (const label of labels) {
        buf.writeUInt8(Buffer.byteLength(label), pos++);
        pos += buf.write(label, pos);
    }
    buf.writeUInt8(0, pos++);
    buf.writeUInt16BE(1, pos); pos += 2; // QTYPE A
    buf.writeUInt16BE(1, pos);           // QCLASS IN
    return buf;
}

function parseAnswers(msg) {
    const ips = [];
    try {
        const qdcount = msg.readUInt16BE(4);
        const ancount = msg.readUInt16BE(6);
        let pos = 12;
        for (let q = 0; q < qdcount; q++) {
            while (pos < msg.length) { const len = msg[pos++]; if (len === 0) break; pos += len; }
            pos += 4;
        }
        for (let a = 0; a < ancount; a++) {
            if (pos >= msg.length) break;
            if ((msg[pos] & 0xc0) === 0xc0) pos += 2;
            else { while (pos < msg.length) { const len = msg[pos++]; if (len === 0) break; pos += len; } }
            if (pos + 10 > msg.length) break;
            const type = msg.readUInt16BE(pos);
            const rdlength = msg.readUInt16BE(pos + 8);
            pos += 10;
            if (type === 1 && rdlength === 4) ips.push(Array.from(msg.slice(pos, pos + 4)).join('.'));
            pos += rdlength;
        }
    } catch (e) { /* return whatever parsed */ }
    return ips;
}

module.exports = {
    start, stop, getStatus, testResolve,
    isPoisonedIp, POISON_IPS,
    // A getter, not a value: `LISTEN_ADDR` is decided at bind time, and a plain export
    // would freeze the placeholder — so Windows would be pointed at 127.0.0.1 while the
    // resolver is actually listening on 127.0.0.2, and every lookup would go nowhere.
    get LISTEN_ADDR() { return LISTEN_ADDR; },
    LISTEN_CANDIDATES, LISTEN_PORT,
    // exported for tests
    _internal: { buildQuery, parseAnswers, questionKey, answerTtlMs, handleQuery },
};
