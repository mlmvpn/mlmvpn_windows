// --- «اوپن‌وی‌پی‌ان» — the OpenVPN engine ---
//
// A full-tunnel engine driving the community `openvpn.exe` (2.6.x) that ships in core/openvpn.
// It has no SOCKS listener of its own: OpenVPN builds a TUN adapter and the machine's traffic
// goes through it, which is why this file never starts itself as a side effect of anything —
// only an explicit /api/openvpn/connect starts a tunnel.
//
// THE LIST IS VPN GATE. The source (9xN/auto-ovpn) mirrors the VPN Gate volunteer pool as JSON
// every five minutes, with each row carrying a ready-made `.ovpn` profile. That is the same pool
// «گیت‌وی MLM» dials, and the honest reason to have both is measured: the gateway speaks
// SoftEther with 8 parallel streams (4.29 Mbit/s from Iran) while this speaks OpenVPN over one
// TCP stream — but the mirror is refreshed every five minutes, so it sees servers the gateway's
// merged cache does not, and it connects in about 4 s where an SSTP dial took 8–23 s.
//
// Windows notes that cost time to discover:
//   · `--windows-driver wintun` is MANDATORY, AND THE ADAPTER MUST ALREADY EXIST. OpenVPN 2.6
//     does not create wintun adapters itself — it looks for one and dies at open_tun with "All
//     wintun adapters on this system are currently in use or disabled" if there is none. The
//     installer normally makes one; this app ships the binary alone, so ensureAdapter() creates
//     it with tapctl.exe. That needs elevation, which the app has and a plain shell does not.
//   · the app already runs elevated (package.json requestedExecutionLevel), so no interactive
//     service and no elevation dance is needed.
//   · state and byte counts come from the MANAGEMENT INTERFACE, not from scraping the log. The
//     log's wording changes between releases; `>STATE:` and `>BYTECOUNT:` are a contract.

'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

// The catalogue: the gateway's archive, with this engine's own curation and measurements over
// it. See openvpn-catalog.js for why the rows are shared and the verdicts are not.
const catalog = require('./openvpn-catalog');

const CORE_DIR = path.join(__dirname, 'core', 'openvpn');
const EXE = path.join(CORE_DIR, 'openvpn.exe');
const DATA_DIR = path.join(os.homedir(), '.mlmvpn', 'openvpn');
const LIST_FILE = path.join(DATA_DIR, 'servers.json');
const SEEN_FILE = path.join(DATA_DIR, 'last-seen.json');
const RUN_DIR = path.join(DATA_DIR, 'run');

const SOURCE_URL = 'https://raw.githubusercontent.com/9xN/auto-ovpn/main/json/data.json';
const FORGET_DAYS = 14;      // a volunteer relay unseen this long is gone for good
const MAX_ROWS = 300;        // each row carries its own ~14 KB profile, so this is a size cap too
const MGMT_PORT = 20860;     // outside the front engines' 208xx block (see front-engine ports)

function ensureDirs() {
    for (const d of [DATA_DIR, RUN_DIR]) {
        try { fs.mkdirSync(d, { recursive: true }); } catch (e) { /* exists */ }
    }
}

const TAPCTL = path.join(CORE_DIR, 'tapctl.exe');
const ADAPTER = 'MLMVPN-OpenVPN';

/** tapctl, as a promise. It writes one line per adapter: "{guid}\tName". */
function tapctl(args) {
    return new Promise((resolve) => {
        let out = '', err = '';
        let p;
        try { p = spawn(TAPCTL, args, { cwd: CORE_DIR, windowsHide: true }); }
        catch (e) { return resolve({ ok: false, out: '', err: e.message }); }
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { err += d; });
        p.on('error', e => resolve({ ok: false, out, err: e.message }));
        p.on('exit', code => resolve({ ok: code === 0, code, out, err }));
    });
}

/**
 * Make sure there is a tunnel adapter to open, and give back its name.
 *
 * Called before every connect rather than once at install: a user can delete the adapter from
 * Device Manager at any time, and finding that out at open_tun — after a full handshake — is
 * the worst possible moment.
 */
async function ensureAdapter() {
    const list = await tapctl(['list']);
    const names = String(list.out || '').split(/\r?\n/)
        .map(l => (l.split('\t')[1] || '').trim())
        .filter(Boolean);

    // Ours, and therefore known to be wintun.
    if (names.includes(ADAPTER)) return { name: ADAPTER, driver: 'wintun' };

    // Someone else's. tapctl does not report the driver, and the machines that have one of
    // these got it from an installer that uses tap-windows6 — so drive it as that rather than
    // opening it as wintun, which fails at open_tun the same way having no adapter does.
    if (names.length) return { name: names[0], driver: 'tap-windows6' };

    const made = await tapctl(['create', '--hwid', 'wintun', '--name', ADAPTER]);
    if (made.ok) return { name: ADAPTER, driver: 'wintun' };
    // Elevation is the one failure worth naming precisely, because the fix is not obvious.
    const why = /elevation|denied|EACCES|EPERM|5/i.test(String(made.err || made.code))
        ? 'ساخت کارت شبکه به دسترسی مدیر نیاز دارد. برنامه را با «Run as administrator» باز کنید.'
        : (String(made.err || '').trim().split(/\r?\n/)[0] || 'کارت شبکهٔ تونل ساخته نشد');
    throw new Error(why);
}

function isInstalled() {
    try { return fs.existsSync(EXE); } catch (e) { return false; }
}

// ── the list ──────────────────────────────────────────────────────────────────

function readSeen() {
    try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

function readList() {
    try {
        const j = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8'));
        return Array.isArray(j.servers) ? j : { servers: [], fetchedAt: 0 };
    } catch (e) {
        return { servers: [], fetchedAt: 0 };
    }
}

/**
 * One row, trimmed to what the panel and the dialer actually use.
 *
 * `profile` is the decoded .ovpn and it is the whole point — unlike the gateway's list, which
 * drops it because SoftEther does not need it, here it IS the transport. It is also why
 * MAX_ROWS is low: 300 rows is already about 4 MB on disk.
 */
function slim(s) {
    let profile = '';
    try { profile = Buffer.from(s.openvpn_configdata_base64 || '', 'base64').toString('utf8'); } catch (e) { profile = ''; }
    if (!/^remote\s+\S+\s+\d+/mi.test(profile)) return null;
    const m = profile.match(/^remote\s+(\S+)\s+(\d+)/mi);
    const proto = (profile.match(/^proto\s+(\w+)/mi) || [, 'tcp'])[1].toLowerCase();
    return {
        host: String(s.hostname || '').trim(),
        ip: String(s.ip || '').trim(),
        remote: m[1],
        port: +m[2],
        proto,
        country: String(s.countryshort || '').toUpperCase(),
        countryName: String(s.countrylong || ''),
        ping: +s.ping || 0,
        speed: +s.speed || 0,           // advertised, not measured — the panel labels it as such
        sessions: +s.numvpnsessions || 0,
        official: /^public-vpn-/i.test(String(s.hostname || '')),
        profile,
    };
}

/**
 * Merge, never replace.
 *
 * The pool rotates: two fetches minutes apart return different hundreds, so a refresh that
 * overwrote would throw away a perfectly good server every time. Fetched rows win on the fields
 * that go stale (ping, sessions, and the profile itself, whose embedded certs do get rotated);
 * anything unseen for FORGET_DAYS is dropped. This is the same lesson gateway-manager.js
 * learned — see its mergeLists().
 */
function mergeServers(oldRows, freshRows) {
    const now = Date.now();
    const seen = readSeen();
    const cutoff = now - FORGET_DAYS * 86400000;
    const out = new Map();

    for (const r of oldRows) {
        if (r && r.host && (seen[r.host] || now) >= cutoff) out.set(r.host, r);
    }
    for (const r of freshRows) {
        if (!r || !r.host) continue;
        out.set(r.host, r);
        seen[r.host] = now;
    }

    const rows = Array.from(out.values())
        .sort((a, b) => (b.official - a.official) || (a.ping - b.ping) || (b.speed - a.speed))
        .slice(0, MAX_ROWS);

    const keep = new Set(rows.map(r => r.host));
    for (const h of Object.keys(seen)) if (!keep.has(h)) delete seen[h];
    try { fs.writeFileSync(SEEN_FILE, JSON.stringify(seen)); } catch (e) { /* cache only */ }
    return rows;
}

/**
 * Which of the app's engines is up right now, as a SOCKS port.
 *
 * Copied in shape from gateway-manager.liveSocksPorts() rather than invented: the mirror lives
 * on GitHub, which is exactly what a user who needs this list often cannot reach directly, so
 * the fetch has to be able to go out through whatever tunnel they already have on.
 */
function liveSocksPorts() {
    const ports = [];
    const tryOne = (mod, get) => {
        try {
            const m = require(mod);
            const p = get(m);
            if (p) ports.push(p);
        } catch (e) { /* not loaded */ }
    };
    tryOne('./psiphon-manager', m => (m.getStatus().connected ? m.SOCKS_PORT : null));
    tryOne('./tor-manager', m => (m.getStatus().connected ? m.SOCKS_PORT : null));
    tryOne('./aether-manager', m => (m.getStatus().connected ? m.SOCKS_PORT : null));
    tryOne('./xray-manager', m => (m.isRunning && m.isRunning() ? 20809 : null));
    return ports;
}

/** The engine names behind those ports, for anything that has to tell the user. */
const SOCKS_FA = { 20830: 'سایفون', 20820: 'تور', 20840: 'لنترن', 20850: 'گف', 20810: 'ماسک', 20809: 'V2Ray' };

/**
 * The port the handshake should ride through, or null for direct.
 *
 * 'auto' is the default because on this line the direct path is the one that fails: a front
 * that is ALREADY running costs nothing extra and turns a timeout into a connection.
 */
function resolveVia(via) {
    if (via === 'direct' || via === false) return null;
    if (typeof via === 'number' && via > 0) return via;
    const ports = liveSocksPorts();
    return ports.length ? ports[0] : null;
}

function viaName(port) { return port ? (SOCKS_FA[port] || ('پورت ' + port)) : null; }

/** The front the user chose in the panel, remembered across sessions by the catalogue. */
function frontMode() {
    try { return catalog.lists().front || 'auto'; } catch (e) { return 'auto'; }
}

/**
 * Make sure there is a front to ride through, starting one if the user has not.
 *
 * NOT a precaution — the measurement. On this line, on the same four official relays in the same
 * minute:
 *
 *   SoftEther (what «گیت‌وی MLM» speaks)   all four OK, 1.3–3.0 s
 *   OpenVPN, raw                           all four stalled at «TLS key negotiation failed»
 *   OpenVPN, through Psiphon                all four CONNECTED, 6.8–8.3 s
 *
 * The relays are alive and the profile is right; what fails is the protocol's own visibility.
 * SoftEther's SSL-VPN is literally an HTTPS POST and reads as web traffic, while OpenVPN's
 * control channel is recognisable — and gets dropped right after the server's certificate
 * arrives. So a front is not an optimisation here, it is the difference between a window that
 * works and one that times out on every server in the list.
 *
 * `mode` mirrors the panel's picker: 'auto' starts one if none is up, 'none' insists on the raw
 * path (which is the user's right, and says so when it fails), a number pins one port.
 */
async function ensureFront(mode, onLog) {
    const say = (m) => { pushLog(m); if (typeof onLog === 'function') try { onLog(m); } catch (e) {} };

    if (mode === 'none' || mode === 'direct') return { port: null, started: false };

    const already = resolveVia(typeof mode === 'number' ? mode : 'auto');
    if (already) return { port: already, started: false, name: viaName(already) };
    if (typeof mode === 'number' && mode > 0) {
        // A pinned front that is not running is not something to silently replace with another.
        return { port: null, started: false, error: 'فرانتی که انتخاب کرده‌اید روشن نیست.' };
    }

    // Psiphon, because it is the one that comes up fastest here — measured at 2–3 s from cold,
    // against tens of seconds for tor. A front that takes a minute to appear turns one button
    // into a wait nobody attributes to the right thing.
    let ps;
    try { ps = require('./psiphon-manager'); } catch (e) { return { port: null, started: false, error: 'سایفون در دسترس نیست.' }; }
    if (!ps.isInstalled()) return { port: null, started: false, error: 'هستهٔ سایفون نصب نیست. از «استور» نصبش کنید.' };

    // The hero reads `detail`, and raising a front can take most of a minute. Without this the
    // panel sat on «در حال شروع» for the whole wait with nothing to attribute it to.
    state.detail = 'روشن کردن سایفون (مسیر عبور)';
    say('هیچ فرانتی روشن نیست — سایفون را بالا می‌آورم.');
    try { await ps.startPsiphon({}); } catch (e) { return { port: null, started: false, error: 'سایفون بالا نیامد: ' + e.message }; }

    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const st = ps.getStatus();
        state.detail = 'روشن کردن سایفون — ' + (i + 1) + ' ثانیه';
        if (st && st.connected) {
            state.detail = 'سایفون آماده شد؛ حالا اتصال OpenVPN';
            say('سایفون آماده است؛ اتصال OpenVPN از داخل آن می‌رود.');
            return { port: ps.SOCKS_PORT, started: true, name: viaName(ps.SOCKS_PORT) };
        }
    }
    return { port: null, started: false, error: 'سایفون در ۴۰ ثانیه وصل نشد.' };
}

/** Raw https, not fetch(): undici takes a dispatcher where SocksTlsAgent is a Node agent. */
function fetchJson(url, socksPort, timeoutMs) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const opts = { timeout: timeoutMs || 60000, headers: { 'User-Agent': 'Mozilla/5.0' } };
        if (socksPort) {
            const { SocksTlsAgent } = require('./socks-agents');
            opts.agent = new SocksTlsAgent(socksPort);
        }
        const req = https.get(url, opts, (res) => {
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('پاسخ قابل خواندن نبود')); }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', reject);
    });
}

/**
 * Fetch the mirror: direct first, then through any engine that is already connected.
 *
 * No route that fails silently — if every attempt fails the caller gets the last reason, which
 * is what the panel shows.
 */
async function refresh(opts) {
    ensureDirs();
    const o = opts || {};

    const attempts = [{ name: 'مستقیم', port: null }];
    for (const p of liveSocksPorts()) attempts.push({ name: `از تونل روی پورت ${p}`, port: p });

    let body = null;
    let lastErr = null;
    for (const a of attempts) {
        try {
            body = await fetchJson(o.url || SOURCE_URL, a.port, a.port ? 60000 : 25000);
            break;
        } catch (e) {
            lastErr = new Error(`${a.name}: ${e.message}`);
        }
    }
    if (!body) throw lastErr || new Error('فهرست سرورها دریافت نشد');

    // The file is [ { servers, countries } ] — an array whose first element holds everything.
    const raw = Array.isArray(body) ? (body[0] && body[0].servers) : (body && body.servers);
    if (!Array.isArray(raw) || !raw.length) throw new Error('فهرست دریافت‌شده خالی بود');

    const fresh = raw.map(slim).filter(Boolean);
    const before = readList();
    const servers = mergeServers(before.servers || [], fresh);
    const out = { servers, fetchedAt: Date.now(), sourceCount: fresh.length };
    try { fs.writeFileSync(LIST_FILE, JSON.stringify(out)); } catch (e) { /* cache only */ }
    return { total: servers.length, fetched: fresh.length, added: servers.length - (before.servers || []).length };
}

/** The list without the profiles — the panel never needs 4 MB of certificates. */
function listServers() {
    const l = readList();
    return {
        fetchedAt: l.fetchedAt || 0,
        servers: (l.servers || []).map(s => {
            const { profile, ...rest } = s;
            return rest;
        }),
    };
}

/**
 * One dialable server, whatever we know about it.
 *
 * The ROW comes from the shared archive (355 relays) and the PROFILE is built from it, because
 * the archive carries none — see openvpn-catalog.buildProfile. The auto-ovpn mirror is consulted
 * for one thing only: it is the only source that knows a relay's real OpenVPN port, which VPN
 * Gate's CSV does not carry.
 *
 * Only a TCP entry from the mirror is used. Its UDP rows are left alone deliberately: every VPN
 * Gate UDP port measured dead from here, so preferring one would swap a port that works for one
 * that does not.
 */
function mirrorEntry(host) {
    const h = catalog._internal.bare(host);
    return (readList().servers || []).find(s =>
        catalog._internal.bare(s.host) === h && s.proto === 'tcp') || null;
}

function findServer(host) {
    const h = catalog._internal.full(host);
    const row = catalog.lists().archive.find(r => r.host === h);
    const m = mirrorEntry(host);

    if (row) {
        // The port harvested from VPN Gate's own profile is the truth. The mirror is a fallback
        // for the handful of hosts it carries and the archive refresh has not seen, and 443 is
        // the last resort — right for an official relay, a guess for anyone else.
        const known = catalog.portFor(row.host);
        const port = known.known ? known.port : ((m && m.port) || catalog.DEFAULT_PORT);
        const proto = known.known ? known.proto : ((m && m.proto) || catalog.DEFAULT_PROTO);
        return Object.assign({}, row, {
            port, proto, portKnown: known.known || !!m,
            profile: catalog.buildProfile(row, { port, proto }),
        });
    }
    // A host the mirror carries and the archive does not. Its own profile is already a real one,
    // so it is used as is rather than rebuilt from a row that does not exist.
    return (readList().servers || []).find(s => s.host === host) || null;
}

// ── measuring ─────────────────────────────────────────────────────────────────

/**
 * How long a TCP handshake to the relay takes, from here, now.
 *
 * NOT the advertised speed — that is the operator's own claim about their uplink and says
 * nothing about the path from this line. This is the number the «سریع‌ترین» button sorts on.
 */
function tcpPing(host, port, timeout) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        const s = new net.Socket();
        let done = false;
        const fin = (ok, err) => {
            if (done) return;
            done = true;
            s.destroy();
            resolve({ ok, ms: Date.now() - t0, err: err || null });
        };
        s.setTimeout(timeout || 5000);
        s.on('connect', () => fin(true));
        s.on('timeout', () => fin(false, 'timeout'));
        s.on('error', (e) => fin(false, e.code || e.message));
        try { s.connect(port, host); } catch (e) { fin(false, e.code || e.message); }
    });
}

/** Measure many at once, but not so many that the line itself becomes the bottleneck. */
async function measure(hosts, opts) {
    const o = opts || {};
    const conc = Math.max(1, Math.min(+o.concurrency || 24, 64));
    const timeout = +o.timeout || 5000;
    const all = readList().servers || [];
    const want = Array.isArray(hosts) && hosts.length
        ? all.filter(s => hosts.includes(s.host))
        : all;

    const out = [];
    let i = 0;
    const worker = async () => {
        while (i < want.length) {
            if (o.shouldStop && o.shouldStop()) return;
            const s = want[i++];
            // TCP only: a UDP profile cannot be probed this way, and from Iran every VPN Gate
            // UDP port measured dead anyway, so those rows are reported unreachable rather than
            // given a fake number.
            if (s.proto !== 'tcp') { out.push({ host: s.host, ok: false, ms: 0, err: 'udp' }); continue; }
            const r = await tcpPing(s.ip || s.remote, s.port, timeout);
            out.push({ host: s.host, ok: r.ok, ms: r.ms, err: r.err });
            if (typeof o.onResult === 'function') out.length && o.onResult(out[out.length - 1]);
        }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    return out;
}

/**
 * Verify servers by ACTUALLY CONNECTING to them.
 *
 * Two passes, and only the second one can produce a pass:
 *   1. a TCP touch, to drop the ones whose port is not even open. Cheap, and it can only
 *      remove candidates — never mark one good.
 *   2. a real OpenVPN dial per survivor (`--dev null`): TCP, TLS, certificate verification,
 *      the username/password exchange and the data-channel keys. `ms` is how long that whole
 *      sequence took, which is the only number that answers «will this connect, and how
 *      quickly» — the advertised speed and the raw TCP time both fail to.
 *
 * Several dials run at once because each is its own process waiting on a slow network, not
 * on this machine. Six is a deliberate ceiling: every one of them is a tunnel handshake
 * against the same line, and past that they start measuring each other.
 */
async function verify(hosts, opts) {
    const o = opts || {};
    const conc = Math.max(1, Math.min(+o.concurrency || 8, 16));
    // A working handshake takes ~4.3 s here; anything still silent at 15 s is not going to
    // finish, and every second past that is paid once per dead server.
    const budget = +o.budget || (resolveVia(o.via) ? 30000 : 15000);
    const stopAfter = +o.stopAfter || 0;   // «just find me one that works»
    const socks = resolveVia(o.via);
    let good = 0;
    const all = readList().servers || [];
    const want = (Array.isArray(hosts) && hosts.length ? all.filter(x => hosts.includes(x.host)) : all)
        .filter(x => x.proto === 'tcp');    // a UDP profile cannot be dialled from here at all

    const emit = (r) => { if (typeof o.onResult === 'function') { try { o.onResult(r); } catch (e) { /* caller */ } } };
    if (typeof o.onBegin === 'function') o.onBegin({ total: want.length, via: socks || null, viaName: viaName(socks) });

    // Pass 1 — who is even listening. Fast and wide.
    const open = [];
    {
        let i = 0;
        const w = async () => {
            while (i < want.length) {
                if (o.shouldStop && o.shouldStop()) return;
                const srv = want[i++];
                const t = await tcpPing(srv.ip || srv.remote, srv.port, 4000);
                if (t.ok) open.push(srv);
                else emit({ host: srv.host, ok: false, ms: 0, err: 'unreachable', stage: 'tcp' });
            }
        };
        await Promise.all(Array.from({ length: Math.min(32, want.length) || 1 }, w));
    }

    // Pass 2 — the real dial. This is the measurement.
    const out = [];
    let j = 0;
    const worker = async () => {
        while (j < open.length) {
            if (o.shouldStop && o.shouldStop()) return;
            const srv = open[j++];
            if (stopAfter && good >= stopAfter) return;
            const r = await probe(srv.host, budget, socks || 'direct');
            if (r.ok) good++;
            const row = {
                host: srv.host, ok: !!r.ok, ms: r.ok ? r.ms : 0,
                err: r.ok ? null : (r.err === 'auth' ? 'auth' : r.err === 'timeout' ? 'timeout' : 'handshake'),
                stage: 'dial',
            };
            out.push(row);
            emit(row);
        }
    };
    await Promise.all(Array.from({ length: conc }, worker));
    return out;
}

// ── the tunnel ────────────────────────────────────────────────────────────────

const state = {
    adapter: null,
    adapterDriver: null,
    via: null,
    viaStarted: false,    // whether THIS panel brought the front up, so it can say so
    proc: null,
    host: null,
    since: 0,
    phase: 'idle',        // idle | connecting | connected | stopping | failed
    detail: '',
    localIp: '',
    bytesIn: 0,
    bytesOut: 0,
    log: [],
    mgmt: null,
};

function pushLog(line) {
    if (!line) return;
    state.log.push(String(line).slice(0, 400));
    if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}

function getStatus() {
    return {
        installed: isInstalled(),
        adapter: state.adapter || null,
        adapterDriver: state.adapterDriver || null,
        via: state.via || null,
        viaStarted: !!state.viaStarted,
        viaAvailable: viaName(resolveVia('auto')) || null,
        frontMode: frontMode(),
        sweep: sweepState(),
        running: !!state.proc,
        connected: state.phase === 'connected',
        // The panel's hero reads `connecting` — and it was never sent, so the whole minute
        // between «شروع» and «وصل شد» rendered as «آمادهٔ اتصال»: a flash of the spinner while
        // the POST was in flight, then a page that looked idle while the tunnel was in fact
        // being built, then «وصل است» out of nowhere. Bringing the front up can take 40 s on
        // its own, so this is a long window to be silent in.
        connecting: state.phase === 'connecting' || state.phase === 'stopping',
        error: state.phase === 'failed' ? (state.detail || '') : '',
        phase: state.phase,
        detail: state.detail,
        host: state.host,
        localIp: state.localIp,
        since: state.since,
        bytesIn: state.bytesIn,
        bytesOut: state.bytesOut,
    };
}

function getLogs() { return state.log.slice(-200); }

/** The traffic feed's source. Cumulative for this session, which is what it expects. */
function readTrafficCounters() {
    return { up: state.bytesOut, down: state.bytesIn };
}

function isRunning() { return !!state.proc; }

/**
 * The management interface.
 *
 * `>STATE:` is OpenVPN's own connection state machine and `>BYTECOUNT:` its own accounting, so
 * neither has to be inferred from log wording that changes between releases.
 */
function attachManagement(port) {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
        try {
            sock.write('state on\n');
            sock.write('bytecount 2\n');
        } catch (e) { /* the process may already be going down */ }
    });
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            if (line.startsWith('>BYTECOUNT:')) {
                const [i, o] = line.slice(11).split(',');
                state.bytesIn = +i || 0;
                state.bytesOut = +o || 0;
                continue;
            }
            if (line.startsWith('>STATE:')) {
                // ts,NAME,description,local ip,remote ip,…
                const f = line.slice(7).split(',');
                const name = f[1] || '';
                if (name === 'CONNECTED') {
                    state.phase = 'connected';
                    state.detail = 'وصل شد';
                    state.localIp = f[3] || '';
                    if (!state.since) state.since = Date.now();
                } else if (name === 'RECONNECTING' || name === 'WAIT' || name === 'AUTH'
                    || name === 'GET_CONFIG' || name === 'ASSIGN_IP' || name === 'TCP_CONNECT'
                    || name === 'RESOLVE' || name === 'ADD_ROUTES') {
                    if (state.phase !== 'stopping') {
                        state.phase = 'connecting';
                        state.detail = STATE_FA[name] || name;
                    }
                } else if (name === 'EXITING') {
                    state.detail = 'در حال بستن';
                }
                pushLog(name);
            }
        }
    });
    sock.on('error', () => { /* it closes with the process */ });
    return sock;
}

const STATE_FA = {
    RESOLVE: 'پیدا کردن آدرس سرور',
    TCP_CONNECT: 'اتصال به سرور',
    WAIT: 'منتظر جواب سرور',
    AUTH: 'در حال ورود',
    GET_CONFIG: 'گرفتن تنظیمات از سرور',
    ASSIGN_IP: 'گرفتن آی‌پی',
    ADD_ROUTES: 'تنظیم مسیرها',
    RECONNECTING: 'اتصال دوباره',
};

/**
 * Write the profile the way this app dials it.
 *
 * The upstream profile is left as it came — its certificates and its cipher are the server's
 * business — and only the things that are OUR policy are appended: the wintun driver, the
 * management socket, and the credentials file. Rewriting someone else's crypto lines is how a
 * profile that worked yesterday stops working after an upstream rotation.
 */
function writeProfile(server) {
    ensureDirs();
    const cfg = path.join(RUN_DIR, 'current.ovpn');
    const creds = path.join(RUN_DIR, 'auth.txt');
    fs.writeFileSync(creds, 'vpn\nvpn\n');
    fs.writeFileSync(cfg, server.profile);
    return { cfg, creds };
}

function baseArgs(cfg, creds, mgmtPort, adapter) {
    return [
        '--config', cfg,
        '--auth-user-pass', creds,
        // The driver has to match the adapter we are about to open, not be assumed.
        '--windows-driver', adapter.driver,
        // Named explicitly: the machine may carry adapters from other VPN software, and picking
        // one of those blindly would fight whoever owns it.
        '--dev-node', adapter.name,
        '--management', '127.0.0.1', String(mgmtPort),
        '--management-query-passwords',
        '--verb', '3',
        '--connect-retry-max', '2',
        '--remap-usr1', 'SIGTERM',
        // ── stability, taken from NexVPN's OpenVPN adapter after reading it ──────────
        // None of these is an anti-censorship measure (their own README rates OpenVPN the
        // weakest protocol it ships for that, and its adapter dials plainly). They are about a
        // tunnel that stays up:
        //   ping/ping-restart  a dead tunnel is noticed in a minute instead of hanging forever,
        //                      which matters doubly here because a front can die under us.
        //   mssfix             this path is a tunnel inside a tunnel when a front carries it,
        //                      and the default MSS assumes it is not.
        //   route-delay        Windows needs the adapter to settle before routes point at it.
        //   auth-nocache       the profile's password is not kept in memory for re-auth.
        //   replay-window      a wider window, for a link with real jitter.
        '--ping', '10',
        '--ping-restart', '60',
        '--mssfix', '1360',
        '--route-delay', '2',
        '--auth-nocache',
        '--replay-window', '512', '60',
        '--mute-replay-warnings',
    ];
}

async function connect(host, opts) {
    if (!isInstalled()) throw new Error('هستهٔ OpenVPN نصب نیست. از «استور» نصبش کنید.');
    if (state.proc) throw new Error('یک اتصال OpenVPN از قبل برقرار است.');
    const server = findServer(host);
    if (!server) throw new Error('این سرور در فهرست نیست. فهرست را تازه کنید.');
    if (!server.profile) throw new Error('پروفایل این سرور ذخیره نشده است.');

    const o = opts || {};
    // Before anything else: openvpn.exe will not create this for us, and finding that out
    // after a successful handshake is how a connection dies at the last step.
    const adapter = await ensureAdapter();
    state.adapter = adapter.name;
    state.adapterDriver = adapter.driver;
    const { cfg, creds } = writeProfile(server);
    state.log = [];
    state.phase = 'connecting';
    state.detail = 'در حال شروع';
    state.host = host;
    state.localIp = '';
    state.since = 0;
    state.bytesIn = 0;
    state.bytesOut = 0;

    const args = baseArgs(cfg, creds, MGMT_PORT, adapter);
    // «فقط این برنامه» — pull nothing, so the machine's default route is untouched and only what
    // the caller routes through the adapter goes through it.
    if (o.routeNoPull) args.push('--route-nopull');
    // The front is the tunnel's CARRIER, not just a way in — it must stay up for the whole
    // session. `ensureFront` starts one when there is none, because on this line the raw path
    // does not merely underperform, it never completes a handshake. See its own note.
    const front = await ensureFront(o.via === undefined ? frontMode() : o.via, o.onLog);
    if (front.error && o.via !== 'none' && o.via !== 'direct') {
        state.phase = 'failed';
        state.detail = front.error;
        state.proc = null;
        throw new Error(front.error);
    }
    const socks = front.port;
    if (socks) {
        args.push('--socks-proxy', '127.0.0.1', String(socks));
        state.via = front.name || viaName(socks);
        state.viaStarted = !!front.started;
    } else {
        state.via = null;
        state.viaStarted = false;
    }

    const proc = spawn(EXE, args, { cwd: CORE_DIR, windowsHide: true });
    state.proc = proc;

    proc.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach(l => l.trim() && pushLog(l.trim())));
    proc.stderr.on('data', (d) => String(d).split(/\r?\n/).forEach(l => l.trim() && pushLog(l.trim())));
    proc.on('exit', (code) => {
        if (state.phase !== 'stopping') {
            state.phase = 'failed';
            state.detail = code === 0 ? 'بسته شد' : `بیرون آمد (کد ${code})`;
        } else {
            state.phase = 'idle';
            state.detail = '';
        }
        state.proc = null;
        state.host = null;
        state.localIp = '';
        state.since = 0;
        try { if (state.mgmt) state.mgmt.destroy(); } catch (e) { /* gone */ }
        state.mgmt = null;
    });

    // The management socket is not up the instant the process is.
    await new Promise(r => setTimeout(r, 600));
    try { state.mgmt = attachManagement(MGMT_PORT); } catch (e) { /* status stays coarse */ }

    return { started: true, host };
}

async function disconnect() {
    if (!state.proc) return { stopped: true };
    state.phase = 'stopping';
    state.detail = 'در حال قطع';
    const p = state.proc;
    try {
        if (state.mgmt) state.mgmt.write('signal SIGTERM\n');
    } catch (e) { /* fall through to the kill */ }
    await new Promise((resolve) => {
        const t = setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } resolve(); }, 3000);
        p.once('exit', () => { clearTimeout(t); resolve(); });
    });
    return { stopped: true };
}

/**
 * A real connection test that does NOT take the machine's route.
 *
 * `--dev null` completes the whole handshake — TCP, TLS, auth, and the data-channel key
 * exchange — and then has nowhere to put packets, which is exactly what a probe wants. It is
 * what lets this engine join «کدام موتور برای خط من؟» at all: every other engine there is
 * measured through its own SOCKS port, and OpenVPN has none.
 *
 * Measured on a healthy line: TCP 0.4 s, full sequence 4.3 s.
 */
function probe(host, budgetMs, via) {
    return new Promise((resolve) => {
        if (!isInstalled()) return resolve({ ok: false, err: 'هسته نصب نیست' });
        const server = findServer(host);
        if (!server || !server.profile) return resolve({ ok: false, err: 'سرور در فهرست نیست' });

        ensureDirs();
        // Per-probe filenames: verify() runs several of these at once, and a shared path meant
        // each new probe rewrote the config the running ones were still reading.
        const tag = String(host).replace(/[^A-Za-z0-9_-]/g, '') + '-' + process.pid;
        const cfg = path.join(RUN_DIR, 'probe-' + tag + '.ovpn');
        const creds = path.join(RUN_DIR, 'probe-' + tag + '-auth.txt');
        try {
            fs.writeFileSync(cfg, server.profile);
            fs.writeFileSync(creds, 'vpn\nvpn\n');
        } catch (e) { return resolve({ ok: false, err: e.message }); }

        const t0 = Date.now();
        let done = false;
        const socks = resolveVia(via);
        const args = [
            '--config', cfg, '--auth-user-pass', creds,
            '--dev', 'null', '--route-nopull', '--verb', '3',
            '--connect-retry-max', '1',
        ];
        if (socks) args.push('--socks-proxy', '127.0.0.1', String(socks));
        const p = spawn(EXE, args, { cwd: CORE_DIR, windowsHide: true });

        const fin = (ok, err) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { p.kill(); } catch (e) { /* gone */ }
            try { fs.unlinkSync(cfg); fs.unlinkSync(creds); } catch (e) { /* already gone */ }
            resolve({ ok, ms: Date.now() - t0, err: err || null });
        };
        const timer = setTimeout(() => fin(false, 'timeout'), Math.max(5000, +budgetMs || 45000));

        const onLine = (d) => {
            const t = String(d);
            if (/Initialization Sequence Completed/i.test(t)) fin(true);
            else if (/AUTH_FAILED/i.test(t)) fin(false, 'auth');
            else if (/TLS Error|TLS key negotiation failed/i.test(t)) fin(false, 'tls-cut');
            else if (/Connection reset|Cannot resolve|No route to host|Connection refused/i.test(t)) fin(false, 'unreachable');
        };
        p.stdout.on('data', onLine);
        p.stderr.on('data', onLine);
        // The process ending on its own means `--connect-retry-max 1` was exhausted, which is
        // what an unreachable relay looks like from here. «موتور بیرون آمد» described what the
        // process did and told the user nothing.
        p.on('exit', () => fin(false, 'unreachable'));
        p.on('error', (e) => fin(false, e.code || e.message));
    });
}

// ============================================================
// The sweeps — «پینگ» and «تست واقعی» over a whole list
// ============================================================
//
// The gateway's two tests, measured with THIS engine. One at a time on purpose: both saturate
// the line, and two at once would each make the other's numbers wrong.
//
// «پینگ»      a TCP touch on the relay's OpenVPN port. Cheap, and it can only rule a relay OUT.
// «تست واقعی» a real OpenVPN handshake to «Initialization Sequence Completed» — TCP, TLS, the
//             certificate, the password exchange and the data-channel keys. It is the only test
//             whose pass means «this will connect», and it is why this panel's verdicts cannot be
//             borrowed from the gateway's: SoftEther and OpenVPN disagree about the same relay.

const sweep = { kind: null, done: 0, total: 0, startedAt: 0, stop: false, front: null };

function sweepState() {
    if (!sweep.kind) return null;
    return { kind: sweep.kind, done: sweep.done, total: sweep.total, startedAt: sweep.startedAt,
        front: sweep.front, skipped: sweep.skipped || 0 };
}

function sweepRunning() { return !!sweep.kind; }

function cancelSweep() {
    if (!sweep.kind) return false;
    sweep.stop = true;
    return true;
}

/**
 * @param kind   'ping'  — TCP reachability of the relay's OpenVPN port
 *               'probe' — the real OpenVPN handshake
 * @param hosts  the hostnames to test, in the order the panel is showing them
 */
async function startSweep(kind, hosts, onStatus) {
    if (sweep.kind) return { ok: false, error: 'یک تست در حال اجراست.' };
    if (!isInstalled()) return { ok: false, error: 'هستهٔ OpenVPN نصب نیست.' };

    const rows = catalog.lists().archive;
    const all = (hosts || []).map(catalog._internal.full)
        .map((h) => rows.find((r) => r.host === h))
        .filter(Boolean);

    // A relay whose OpenVPN port we have never seen cannot be tested, and must not be RECORDED
    // as a failure — «never asked» and «answered badly» are different facts, and conflating them
    // is what made 317 healthy volunteer relays read «موتور بیرون آمد». They are skipped and
    // counted, and the panel says how many and what to do about it.
    const targets = all.filter((r) => r.ovpnKnown);
    const skipped = all.length - targets.length;
    if (!targets.length) {
        return {
            ok: false, skipped,
            error: skipped
                ? `پورت OpenVPN هیچ‌کدام از این ${skipped} سرور را نمی‌دانیم. «به‌روزرسانی فهرست» را بزنید — پورت هر سرور از همان‌جا می‌آید.`
                : 'سروری برای تست نیست.',
        };
    }

    sweep.kind = kind === 'probe' ? 'probe' : 'ping';
    sweep.done = 0;
    sweep.total = targets.length;
    sweep.startedAt = Date.now();
    sweep.stop = false;
    sweep.front = null;
    sweep.skipped = skipped;

    const cur = catalog._internal.read();
    let lastPush = 0;
    const push = () => { if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) {} } };
    const tick = () => {
        sweep.done++;
        const now = Date.now();
        if (now - lastPush > 400 || sweep.done === sweep.total) { lastPush = now; push(); }
        catalog._internal.save();
    };

    push();
    try {
        if (sweep.kind === 'ping') {
            let i = 0;
            const worker = async () => {
                while (i < targets.length && !sweep.stop) {
                    const row = targets[i++];
                    const srv = findServer(row.host);
                    const port = (srv && srv.port) || catalog.DEFAULT_PORT;
                    // The IP where we have one: on a filtered line the DDNS name often resolves
                    // to the operator's sinkhole, and a sinkhole answers instantly — which reads
                    // as a 3 ms relay.
                    const r = await tcpPing(row.ip || row.host, port, 5000);
                    cur.pings[row.host] = r.ok ? r.ms : 0;
                    tick();
                }
            };
            await Promise.all(Array.from({ length: Math.min(12, targets.length) }, worker));
        } else {
            // A real handshake has to go through the same carrier a real connection would, or
            // every row would come back «ناموفق» for a reason that has nothing to do with the
            // relay. So the front is raised ONCE for the whole sweep.
            const front = await ensureFront(frontMode());
            sweep.front = front.name || (front.port ? viaName(front.port) : null);
            if (front.error) {
                return { ok: false, error: front.error };
            }
            push();
            let i = 0;
            const worker = async () => {
                while (i < targets.length && !sweep.stop) {
                    const row = targets[i++];
                    const r = await probe(row.host, front.port ? 30000 : 15000, front.port || 'none');
                    cur.probes[row.host] = r.ok
                        ? { ok: true, ms: r.ms, at: Date.now() }
                        : { ok: false, reason: r.err || 'timeout', at: Date.now() };
                    tick();
                }
            };
            // Six at once: each is its own process waiting on a slow network, but every one is a
            // tunnel handshake against the same line, and past that they measure each other.
            await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
        }
    } finally {
        const finished = { kind: sweep.kind, done: sweep.done, total: sweep.total, stopped: sweep.stop,
            front: sweep.front, skipped: sweep.skipped || 0 };
        sweep.kind = null;
        sweep.stop = false;
        catalog._internal.save(true);
        push();
        // eslint-disable-next-line no-unsafe-finally
        return Object.assign({ ok: true }, finished);
    }
}

/** Everything the engine owns, gone. Called on app shutdown and by the fail-closed guard. */
async function stopAll() {
    try { await disconnect(); } catch (e) { /* best effort */ }
}

module.exports = {
    isInstalled, isRunning, getStatus, getLogs, readTrafficCounters,
    refresh, listServers, findServer, measure, verify, tcpPing, ensureAdapter, tapctl,
    resolveVia, viaName, liveSocksPorts, ensureFront, frontMode,
    connect, disconnect, probe, stopAll,
    // «فهرست من» / «آرشیو» and everything the user does to them — the catalogue's, re-exported
    // so the routes have one place to call and the panel never has to know there are two files.
    lists: catalog.lists, keep: catalog.keep, drop: catalog.drop, hide: catalog.hide,
    purge: catalog.purge, restoreHidden: catalog.restoreHidden, forget: catalog.forget,
    select: catalog.select, setFront: catalog.setFront, stampFetched: catalog.stampFetched,
    deadHosts: catalog.deadHosts, healthyHosts: catalog.healthyHosts, suggest: catalog.suggest,
    startSweep, cancelSweep, sweepRunning, sweepState,
    SOURCE_URL, CORE_DIR, EXE, MGMT_PORT,
    _internal: { slim, mergeServers, readList, writeProfile, baseArgs, mirrorEntry, catalog },
};
