// --- Aether DNS bridge (system-wide, leak-free) ---
//
// WHY THIS EXISTS.
// Aether's own SOCKS5 server resolves names INSIDE the tunnel (socks.rs dns_resolve →
// smoltcp → AETHER_DNS), so a browser pointed at the local proxy never leaks a lookup.
// But Windows itself, and every app that ignores the system proxy, keeps asking the
// machine's configured resolver — the ISP's, in cleartext. That is the DNS leak the
// WireGuard/MASQUE section had: the tunnel was honest, the operating system was not.
//
// This module closes that gap without sing-box. It listens on 127.0.0.1:53 as an ordinary
// UDP/TCP resolver and forwards every query through Aether's SOCKS5 port, so the answer
// comes back from inside the tunnel. Windows talks plain DNS to localhost; localhost talks
// to the tunnel. The ISP sees neither the question nor the answer.
//
// Two ways through the tunnel, tried in order:
//   UDP ASSOCIATE — one control connection per query, datagrams relayed to 1.1.1.1:53.
//   TCP CONNECT   — DNS over TCP (RFC 7766) to 1.1.1.1:53, for engines that cannot carry
//                   UDP. Aether supports both; the fallback keeps the leak closed even
//                   when UDP is unavailable.
//
// Bootstrap: the tunnel endpoint is a literal IP (assigned_endpoint from registration),
// so the engine never needs to resolve its own gateway — pointing Windows at this bridge
// cannot starve the tunnel of the answer it needs to exist.

const dgram = require('dgram');
const net = require('net');

// Candidate listen addresses, in order. 127.0.0.1:53 is the obvious one and frequently
// taken (Shecan, AdGuard, Pi-hole, Docker, WSL); the whole 127.0.0.0/8 range is loopback
// on Windows, so a taken 127.0.0.1 is not a dead end — bind the next one and point
// Windows at that one instead.
const LISTEN_CANDIDATES = ['127.0.0.1', '127.0.0.2', '127.0.0.53', '127.53.53.53'];
const LISTEN_PORT = 53;

// Whichever candidate actually bound. Read by the caller when it tells Windows which
// resolver to use, so the two can never disagree.
let LISTEN_ADDR = LISTEN_CANDIDATES[0];

const UPSTREAM_TIMEOUT_MS = 5000;
const NEGATIVE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 5000;

// Where queries go once they are inside the tunnel. Aether's own resolver default is
// 1.1.1.1:53; using the same target keeps the two paths consistent.
const TUNNEL_DNS = { ip: '1.1.1.1', port: 53 };

let server = null;         // UDP socket
let tcpServer = null;      // TCP fallback (large answers, some clients)

// IPv6 half of the same bridge. Windows keeps a SEPARATE resolver list per address family
// and prefers the IPv6 one when the adapter has a routable IPv6 address. Pointing only the
// IPv4 list at the bridge therefore closed nothing on a dual-stack connection: every lookup
// went to the ISP's IPv6 resolver in cleartext, which is exactly the leak the DNS-leak test
// sites report as an Iranian resolver. Answering on ::1 lets the caller point BOTH families
// at us. Best-effort: a machine with IPv6 disabled simply has no v6 list to hijack.
let server6 = null;
let tcpServer6 = null;
const LISTEN_ADDR6 = '::1';
let listening6 = false;
let state = {
    running: false,
    socksPort: 0,
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
            if (ttl < min) min = ttl;
            pos += 10 + rdlength;
        }
        return min === Infinity ? NEGATIVE_TTL_MS : Math.max(min * 1000, 1000);
    } catch (e) {
        return NEGATIVE_TTL_MS;
    }
}

function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) { cache.delete(key); return null; }
    return hit.answer;
}

function cacheSet(key, answer, ttlMs) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
        // Evict the oldest quarter rather than the single oldest: one pass is cheaper
        // than a Map rebuild on every insert once the table is full.
        const cutoff = Date.now() - ttlMs;
        for (const [k, v] of cache) {
            if (v.expires < cutoff) cache.delete(k);
            if (cache.size < MAX_CACHE_ENTRIES * 0.75) break;
        }
    }
    cache.set(key, { answer, expires: Date.now() + ttlMs });
}

// ── SOCKS5 client ────────────────────────────────────────────────────────────

// One UDP ASSOCIATE per query. The control connection stays open while datagrams flow;
// closing it is what tells Aether the association is done.
function socksUdpQuery(query, socksPort) {
    return new Promise((resolve, reject) => {
        const ctrl = new net.Socket();
        let relay = null;
        let settled = false;

        const done = (err, answer) => {
            if (settled) return;
            settled = true;
            try { if (relay) relay.close(); } catch (e) {}
            try { ctrl.destroy(); } catch (e) {}
            err ? reject(err) : resolve(answer);
        };

        const timer = setTimeout(() => done(new Error('timeout')), UPSTREAM_TIMEOUT_MS);

        ctrl.connect(socksPort, '127.0.0.1', () => {
            // greeting: VER=5, NMETHODS=1, METHOD=0 (no auth)
            ctrl.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        let step = 0;
        let relayPort = 0;

        ctrl.on('data', (chunk) => {
            if (step === 0) {
                if (chunk.length < 2 || chunk[0] !== 0x05 || chunk[1] !== 0x00) {
                    clearTimeout(timer);
                    return done(new Error('SOCKS5 greeting rejected'));
                }
                step = 1;
                // UDP ASSOCIATE request: VER=5 CMD=3 RSV=0 ATYP=1 DST=0.0.0.0:0
                ctrl.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                return;
            }

            if (step === 1) {
                if (chunk.length < 10 || chunk[0] !== 0x05 || chunk[1] !== 0x00) {
                    clearTimeout(timer);
                    return done(new Error(`SOCKS5 UDP associate failed (rep=${chunk[1]})`));
                }
                relayPort = chunk.readUInt16BE(8);
                step = 2;

                relay = dgram.createSocket('udp4');
                relay.on('error', (e) => { clearTimeout(timer); done(e); });
                relay.on('message', (msg) => {
                    // SOCKS5 UDP reply header: RSV(2) FRAG(1) ATYP(1) ADDR PORT
                    if (msg.length < 10) return;
                    const atyp = msg[3];
                    let off;
                    if (atyp === 0x01) off = 4 + 4 + 2;
                    else if (atyp === 0x04) off = 4 + 16 + 2;
                    else if (atyp === 0x03) off = 4 + 1 + msg[4] + 2;
                    else return;
                    clearTimeout(timer);
                    done(null, msg.slice(off));
                });

                // UDP request header: RSV(2) FRAG(1) ATYP(1) 1.1.1.1 :53
                const head = Buffer.from([0x00, 0x00, 0x00, 0x01, 1, 1, 1, 1, 0, 53]);
                relay.send(Buffer.concat([head, query]), relayPort, '127.0.0.1', (e) => {
                    if (e) { clearTimeout(timer); done(e); }
                });
            }
        });

        ctrl.on('error', (e) => { clearTimeout(timer); done(e); });
        ctrl.on('close', () => { if (!settled) { clearTimeout(timer); done(new Error('control closed')); } });
    });
}

// DNS over TCP through the tunnel: CONNECT 1.1.1.1:53, then RFC 7766 framing.
function socksTcpQuery(query, socksPort) {
    return new Promise((resolve, reject) => {
        const sock = new net.Socket();
        let settled = false;

        const done = (err, answer) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch (e) {}
            err ? reject(err) : resolve(answer);
        };

        const timer = setTimeout(() => done(new Error('timeout')), UPSTREAM_TIMEOUT_MS);

        sock.connect(socksPort, '127.0.0.1', () => {
            sock.write(Buffer.from([0x05, 0x01, 0x00]));
        });

        let step = 0;
        let expectedLen = 0;
        let buf = Buffer.alloc(0);

        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);

            if (step === 0) {
                if (buf.length < 2) return;
                if (buf[0] !== 0x05 || buf[1] !== 0x00) {
                    clearTimeout(timer);
                    return done(new Error('SOCKS5 greeting rejected'));
                }
                step = 1;
                buf = buf.slice(2);
                // CONNECT 1.1.1.1:53
                sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 1, 1, 1, 0, 53]));
            }

            if (step === 1) {
                if (buf.length < 10) return;
                if (buf[0] !== 0x05 || buf[1] !== 0x00) {
                    clearTimeout(timer);
                    return done(new Error(`SOCKS5 connect failed (rep=${buf[1]})`));
                }
                step = 2;
                buf = buf.slice(10);
                const len = Buffer.alloc(2);
                len.writeUInt16BE(query.length, 0);
                sock.write(Buffer.concat([len, query]));
            }

            if (step === 2) {
                if (expectedLen === 0) {
                    if (buf.length < 2) return;
                    expectedLen = buf.readUInt16BE(0);
                    buf = buf.slice(2);
                }
                if (buf.length < expectedLen) return;
                clearTimeout(timer);
                done(null, buf.slice(0, expectedLen));
            }
        });

        sock.on('error', (e) => { clearTimeout(timer); done(e); });
        sock.on('close', () => { if (!settled) { clearTimeout(timer); done(new Error('connection closed')); } });
    });
}

// Which transport this engine actually supports, learned once instead of rediscovered per
// query.
//
// The old code tried UDP first and fell back to TCP on ANY failure. On an engine that cannot
// carry UDP that means every single lookup pays a full 5-second UDP timeout before the TCP
// attempt even starts — a 10-second worst case per name, against a Windows DNS client that
// gives up after about a second and moves to the next configured server. That is not a slow
// resolver, it is a resolver Windows stops believing in, and the fallback it moves to is the
// ISP's: the leak, caused by the timeout structure of the thing meant to prevent it.
//
// 'unknown' -> try UDP, remember the answer. After that the working transport is used
// directly. A transport that starts failing resets this, so a changed engine is re-learned
// rather than assumed forever.
let transport = 'unknown';   // 'unknown' | 'udp' | 'tcp'
let udpFailures = 0;
const UDP_FAILURES_BEFORE_TCP = 3;

async function forwardQuery(query, socksPort) {
    if (transport === 'tcp') return socksTcpQuery(query, socksPort);

    try {
        const answer = await socksUdpQuery(query, socksPort);
        transport = 'udp';
        udpFailures = 0;
        return answer;
    } catch (e) {
        // A single failure is not proof the engine is UDP-less — a dropped datagram looks
        // identical. Only a run of them is, and until then the TCP fallback still answers
        // this query, so nothing leaks while we make up our mind.
        if (++udpFailures >= UDP_FAILURES_BEFORE_TCP) transport = 'tcp';
        return socksTcpQuery(query, socksPort);
    }
}

// Reset the learned transport. Called when the tunnel is re-established, because the engine
// behind the SOCKS port may not be the one we measured.
function resetTransport() { transport = 'unknown'; udpFailures = 0; }

// ── in-flight de-duplication ─────────────────────────────────────────────────
//
// Windows asks the same question several times in quick succession — once per configured
// resolver on each adapter (smart multi-homed resolution), plus retries when the first answer
// is slow. A page load makes tens of lookups and many are duplicates. Without this, each one
// opens its own SOCKS control connection and its own UDP socket through the tunnel, which is
// both the largest single source of latency here and a genuine risk of ephemeral-port
// exhaustion on Windows under load.
const inFlight = new Map();   // questionKey -> Promise<Buffer>

function forwardDeduped(key, query, socksPort) {
    if (!key) return forwardQuery(query, socksPort);
    const existing = inFlight.get(key);
    // Share the ANSWER BODY, never the caller's transaction ID: handleQuery stamps each
    // client's own ID back in, so one upstream round trip can satisfy every waiter.
    if (existing) return existing;
    const p = forwardQuery(query, socksPort).finally(() => inFlight.delete(key));
    inFlight.set(key, p);
    return p;
}

// ── local server ─────────────────────────────────────────────────────────────

async function handleQuery(msg, socksPort) {
    const key = questionKey(msg);
    if (key) {
        const cached = cacheGet(key);
        if (cached) {
            state.cacheHits++;
            return withId(cached, msg.readUInt16BE(0));
        }
    }

    // De-duplicated on the question, then stamped with THIS caller's transaction ID below.
    const upstream = await forwardDeduped(key, msg, socksPort);
    const answer = key ? withId(upstream, msg.readUInt16BE(0)) : upstream;
    state.queries++;

    // Cache the WHOLE message. withId() overwrites bytes 0-1 (the transaction ID) of what it
    // is handed, so storing answer.slice(2) meant every cache hit came back with the caller's
    // ID stamped over the FLAGS field and the entire message shifted two bytes left — a
    // malformed reply for every repeated lookup. Windows discards those, retries, eventually
    // gives up on this resolver and falls back to the other configured servers, which is how
    // a "leak-free" bridge ends up leaking to the ISP resolver and the connection feels like
    // it keeps dropping.
    if (key && answer.length >= 12) cacheSet(key, Buffer.from(answer), answerTtlMs(answer));
    return answer;
}

// One implementation, used by both address families. Kept as functions rather than repeated
// inline so the v4 and v6 listeners can never drift apart in behaviour.
function attachUdpHandler(sock, socksPort) {
    sock.on('message', async (msg, rinfo) => {
        try {
            const answer = await handleQuery(msg, socksPort);
            sock.send(answer, rinfo.port, rinfo.address, () => {});
        } catch (e) {
            state.errors++;
            state.lastError = e.message;
            // FORMERR on unparseable queries, SERVFAIL on upstream failure — the
            // client must get an answer, or Windows retries and the log fills.
            const reply = Buffer.from(msg);
            reply[2] = 0x81;
            reply[3] = msg.length >= 12 ? 0x02 : 0x01;
            try { sock.send(reply, rinfo.port, rinfo.address, () => {}); } catch (_) {}
        }
    });
}

function makeTcpServer(socksPort) {
    const srv = net.createServer((sock) => {
        let lenBuf = Buffer.alloc(0);
        sock.on('data', async (chunk) => {
            lenBuf = Buffer.concat([lenBuf, chunk]);
            while (lenBuf.length >= 2) {
                const qLen = lenBuf.readUInt16BE(0);
                if (lenBuf.length < 2 + qLen) break;
                const query = lenBuf.slice(2, 2 + qLen);
                lenBuf = lenBuf.slice(2 + qLen);
                try {
                    const answer = await handleQuery(query, socksPort);
                    const out = Buffer.alloc(2 + answer.length);
                    out.writeUInt16BE(answer.length, 0);
                    answer.copy(out, 2);
                    sock.write(out);
                } catch (e) {
                    state.errors++;
                    state.lastError = e.message;
                }
            }
        });
        sock.on('error', () => {});
    });
    // TCP is a fallback for large answers; losing it must not kill UDP.
    srv.on('error', (e) => { state.lastError = `tcp: ${e.message}`; });
    return srv;
}

// Bring up the ::1 listener. Never rejects: IPv6 may be disabled, or another resolver may
// already hold [::1]:53. Failing here must not take the working IPv4 bridge down with it —
// the caller checks listening6() before it dares point Windows' IPv6 list at us.
function startV6(socksPort) {
    return new Promise((resolve) => {
        let udp;
        try { udp = dgram.createSocket('udp6'); } catch (e) { return resolve(false); }

        udp.on('error', () => { try { udp.close(); } catch (_) {} resolve(false); });
        attachUdpHandler(udp, socksPort);

        udp.bind(LISTEN_PORT, LISTEN_ADDR6, () => {
            server6 = udp;
            const srv = makeTcpServer(socksPort);
            srv.once('error', () => { listening6 = true; resolve(true); }); // UDP is enough
            srv.listen(LISTEN_PORT, LISTEN_ADDR6, () => {
                tcpServer6 = srv;
                listening6 = true;
                resolve(true);
            });
        });
    });
}

function start(socksPort) {
    return new Promise((resolve, reject) => {
        if (state.running) return resolve({ addr: LISTEN_ADDR, port: LISTEN_PORT });

        let candidateIndex = 0;

        const tryBind = () => {
            if (candidateIndex >= LISTEN_CANDIDATES.length) {
                return reject(new Error(
                    'هیچ آدرس loopback برای سرویس DNS آزاد نیست. ' +
                    'یک برنامه‌ی DNS دیگر (Shecan، AdGuard، Pi-hole، Docker، WSL) پورت ۵۳ را گرفته است.'
                ));
            }

            const addr = LISTEN_CANDIDATES[candidateIndex++];
            const udp = dgram.createSocket('udp4');

            udp.on('error', (e) => {
                try { udp.close(); } catch (_) {}
                if (e.code === 'EADDRINUSE' || e.code === 'EACCES') {
                    tryBind();
                } else {
                    reject(e);
                }
            });

            attachUdpHandler(udp, socksPort);

            udp.bind(LISTEN_PORT, addr, () => {
                server = udp;
                LISTEN_ADDR = addr;

                tcpServer = makeTcpServer(socksPort);
                tcpServer.listen(LISTEN_PORT, addr, async () => {
                    state.running = true;
                    state.socksPort = socksPort;
                    state.startedAt = Date.now();
                    // Best-effort, and awaited: the caller decides which address families to
                    // hand Windows based on what actually came up, so it must not race.
                    await startV6(socksPort);
                    resolve({ addr, port: LISTEN_PORT, v6: listening6 ? LISTEN_ADDR6 : null });
                });
            });
        };

        tryBind();
    });
}

function stop() {
    return new Promise((resolve) => {
        state.running = false;
        const closeUdp = () => new Promise((r) => {
            if (!server) return r();
            try { server.close(() => r()); } catch (e) { r(); }
            server = null;
        });
        const closeTcp = () => new Promise((r) => {
            if (!tcpServer) return r();
            try { tcpServer.close(() => r()); } catch (e) { r(); }
            tcpServer = null;
        });
        const closeUdp6 = () => new Promise((r) => {
            if (!server6) return r();
            try { server6.close(() => r()); } catch (e) { r(); }
            server6 = null;
        });
        const closeTcp6 = () => new Promise((r) => {
            if (!tcpServer6) return r();
            try { tcpServer6.close(() => r()); } catch (e) { r(); }
            tcpServer6 = null;
        });
        listening6 = false;
        Promise.all([closeUdp(), closeTcp(), closeUdp6(), closeTcp6()]).then(resolve);
    });
}

function getStatus() {
    return {
        running: state.running,
        addr: LISTEN_ADDR,
        addr6: listening6 ? LISTEN_ADDR6 : null,
        port: LISTEN_PORT,
        socksPort: state.socksPort,
        startedAt: state.startedAt,
        queries: state.queries,
        cacheHits: state.cacheHits,
        errors: state.errors,
        lastError: state.lastError,
    };
}

// Prove the bridge answers before Windows is pointed at it. A resolver that cannot
// resolve is worse than no resolver at all.
async function testResolve(domain, socksPort) {
    const labels = domain.split('.').filter(Boolean);
    const q = [0x00, 0x00, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    for (const label of labels) {
        q.push(label.length);
        for (let i = 0; i < label.length; i++) q.push(label.charCodeAt(i));
    }
    q.push(0x00, 0x00, 0x01, 0x00, 0x01);
    const query = Buffer.from(q);
    const answer = await forwardQuery(query, socksPort || state.socksPort);
    if (answer.length < 12 || answer.readUInt16BE(6) === 0) {
        throw new Error('پاسخ خالی از تونل');
    }
    return true;
}

module.exports = {
    start,
    stop,
    getStatus,
    testResolve,
    resetTransport,
    get LISTEN_ADDR() { return LISTEN_ADDR; },
    // null when IPv6 could not be bound, so the caller can tell "no v6 list to set" from
    // "v6 list set to a resolver that does not exist" — the second one is a black hole.
    get LISTEN_ADDR6() { return listening6 ? LISTEN_ADDR6 : null; },
    LISTEN_PORT,
};
