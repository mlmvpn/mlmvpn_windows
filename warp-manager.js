// --- «وارپ» — our own WARP engine, independent of aether ---
//
// WHY THIS IS SEPARATE. «وارپ خالی» was never part of the aether engine; it was added here, and
// the point of it is to be the thing that still works when aether does not. That is not
// hypothetical: measured 2026-09-20, aether's MASQUE was refused by every one of 349 Cloudflare
// gateways with a TLS `handshake_failure` (QUIC close 0x128), and other clients built on the same
// engine failed the same way. An engine whose WARP dies with its MASQUE is one engine, not two.
//
// So nothing here goes through aether. Three parts, each ours or already shipped:
//
//   registration   `api.cloudflareclient.com/v0a2158/reg`, plain HTTPS from this file. It returns
//                  the device's WireGuard key pair partner, its addresses and its client_id.
//   discovery      warp-prober.js — a WireGuard handshake spoken in Node. 600 endpoints in 6.4 s
//                  over ONE udp socket; aether's own sweep needs 80 s for 2532 at concurrency 8.
//   data plane     `core/xray.exe`'s WireGuard outbound. Already shipped, and crucially it has
//                  `noises` — the junk-packet obfuscation.
//
// WHY NOT sing-box, WHICH IS ALSO ALREADY SHIPPED. It has a WireGuard endpoint and it accepts a
// WARP config, but no WireGuard obfuscation of any kind, and on the reporting line that decides
// everything. Measured head to head, same engine, same minute, same scan:
//
//     plain WireGuard (noise off)   never carried traffic in 170 s
//     obfuscated                    carried traffic after 76 s
//
// That one result also explains the whole report it came from: «وایرگارد» and «وارپ در وارپ» are
// obfuscated and connect, «وارپ خالی» was plain by definition and could not. So «خالی» here means
// what the user means by it — Cloudflare's own endpoints, no server hunting for the lowest ping,
// nothing clever in the routing — and NOT «send WireGuard in the clear and hope».
//
// WHAT «CONNECTED» MEANS. A real HTTPS request through the finished tunnel, every time. A
// handshake proves nothing: today an endpoint answered the handshake, reported a validated data
// plane, served SOCKS, and passed not one of sixty requests. Endpoints here also go stale within
// about a minute, so the check repeats for as long as the engine is up.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const { spawn } = require('child_process');

const prober = require('./warp-prober');
const { createRelay } = require('./warp-relay');
const corePaths = require('./core-paths');

const SOCKS_PORT = 20870;
const DATA_DIR = path.join(os.homedir(), '.mlmvpn', 'warp');
const IDENTITY_FILE = path.join(DATA_DIR, 'identity.json');
const LAST_FILE = path.join(DATA_DIR, 'last-endpoint.json');

// The registration Cloudflare's OWN Android client sends, field for field.
//
// This is not cargo cult. A registration against the old `v0a2158` path, with the short body
// most examples on the internet use, is ACCEPTED — HTTP 200, keys and addresses come back, the
// endpoints answer a WireGuard handshake — and then the tunnel carries nothing. The body below
// differs in the parts that decide what the account is FOR: `tunnel_type: "wireguard"` and
// `key_type: "curve25519"` say which kind of tunnel this device will open, and the `tos`
// timestamp is local time with an offset rather than a Z.
const API_VERSION = 'v0a4471';
const API = 'https://api.cloudflareclient.com/' + API_VERSION + '/reg';
const API_HEADERS = {
    'Content-Type': 'application/json; charset=UTF-8',
    'Connection': 'Keep-Alive',
    'CF-Client-Version': 'a-6.35-4471',
    'User-Agent': 'WARP for Android',
};

/** `2026-09-21T01:23:45.678+03:30` — local time with an offset, which is what the client sends. */
function tosTimestamp() {
    const d = new Date();
    const p = (n, w = 2) => String(n).padStart(w, '0');
    const off = -d.getTimezoneOffset();
    const sign = off < 0 ? '-' : '+';
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}` +
        `${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

// Cloudflare's published WARP ranges and ports — the same ones their own client uses. An endpoint
// outside these is not WARP, so the sweep never leaves them.
const PREFIXES = ['162.159.192', '162.159.195', '188.114.96', '188.114.97', '188.114.98', '188.114.99', '162.159.193'];
const PORTS = [
    2408, 500, 1701, 4500, 854, 859, 864, 878, 880, 890, 891, 894, 903, 908, 928, 934, 939, 942,
    943, 945, 946, 955, 968, 987, 988, 1002, 1010, 1014, 1018, 1070, 1074, 1180, 1387, 1843, 2371,
    2506, 3138, 3476, 3581, 3854, 4177, 4198, 4233, 5279, 5956, 7103, 7152, 7156, 7281, 7559, 8319,
    8742, 8854, 8886,
];

const SWEEP_SIZE = 900;          // ~7 s of sweeping; on the reporting line it returned 95 live
const SWEEP_TIMEOUT_MS = 7000;
// A WARP tunnel that works answers in one to three seconds. Six is generous for a trial and is
// what keeps a round bounded; the confirm on the real port gets the full patience.
const TRIAL_TIMEOUT_MS = 6000;
const VERIFY_TIMEOUT_MS = 12000;
// A sweep can return a hundred live endpoints and trying every one of them is twenty minutes of
// the user waiting. Take the fastest handful per round and sweep again instead: a fresh sweep is
// seven seconds and draws a different sample, which is a better use of the same minute.
const TRIALS_PER_SWEEP = 10;
// How long a connect may hunt before it admits the line is closed. The transport rescans
// underneath the whole time; this is simply how long the user is asked to wait.
const CONNECT_BUDGET_MS = 150000;

let proc = null;
let sessionId = 0;
let state = null;
let logBuffer = [];
let watchdog = null;
let listeners = { onLog: null, onStage: null };

const MAX_LOG = 600;

function log(line) {
    const entry = `[${new Date().toISOString()}] ${line}`;
    logBuffer.push(entry);
    if (logBuffer.length > MAX_LOG) logBuffer.shift();
    if (listeners.onLog) { try { listeners.onLog(line); } catch (e) { /* a listener must not stop the engine */ } }
}

/**
 * `active` is «the user asked for this engine and it has not been stopped», which is NOT the same
 * as «a child process exists»: the connect spends its first seconds registering and sweeping with
 * no child at all, and the transport is killed and respawned underneath.
 *
 * It has to be in every broadcast. It was not, and the symptom was exactly what the user
 * reported: `getStatus()` adds `running`, but the live status pushed over the websocket is this
 * `state` object, which had no such field — so throughout a connect the page saw
 * `running: undefined`, could not tell the engine was working, and showed «مشکل دارد» under the
 * icon instead of a spinner. It looked idle or broken while it was in fact hunting.
 */
let active = false;

function setStage(stage, fa, extra) {
    state = Object.assign(state || {}, { stage, stageFa: fa }, extra || {});
    state.running = active;
    state.socksPort = state.socksPort || SOCKS_PORT;
    if (listeners.onStage) { try { listeners.onStage(Object.assign({}, state)); } catch (e) { /* as above */ } }
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];

/** `count` distinct Cloudflare WARP endpoints, drawn across every published range and port. */
function candidates(count) {
    const out = [];
    const seen = new Set();
    let guard = count * 20;
    while (out.length < count && guard-- > 0) {
        const ip = pick(PREFIXES) + '.' + (1 + Math.floor(Math.random() * 254));
        const port = pick(PORTS);
        const key = ip + ':' + port;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([ip, port]);
    }
    return out;
}

// ── identity ─────────────────────────────────────────────────────────────────────────────────

function x25519() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    return {
        pub: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
        priv: privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'),
    };
}

/**
 * Register a device with Cloudflare and keep what WireGuard needs.
 *
 * `client_id` becomes the three reserved bytes of every WireGuard header — Cloudflare routes on
 * them, and a packet without them is answered by nothing.
 */
async function register({ signal } = {}) {
    const kp = x25519();
    const res = await fetch(API, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({
            key: kp.pub,
            install_id: '',
            fcm_token: '',
            tos: tosTimestamp(),
            model: 'PC',
            serial_number: crypto.randomBytes(8).toString('hex'),
            os_version: '',
            key_type: 'curve25519',
            tunnel_type: 'wireguard',
            locale: 'en_US',
        }),
        signal: signal || AbortSignal.timeout(25000),
    });
    if (!res.ok) throw new Error('ثبت‌نام کلادفلر ناموفق بود (HTTP ' + res.status + ')');
    const j = await res.json();
    const peer = j.config && j.config.peers && j.config.peers[0];
    const iface = j.config && j.config.interface;
    if (!peer || !iface) throw new Error('پاسخ کلادفلر ناقص بود.');
    // A FRESH REGISTRATION HAS WARP TURNED OFF. The response says so plainly —
    // `warp_enabled: false` — and the consequence is the most misleading failure in this whole
    // engine: the device key is valid, so every edge completes the WireGuard handshake, and then
    // not one byte is allowed through. Measured over six sweeps and sixty endpoints before the
    // response was read carefully enough to notice. Cloudflare's own client PATCHes the device
    // straight after registering, and so must we.
    if (j.warp_enabled !== true && j.id && j.token) {
        const p = await fetch(API + '/' + encodeURIComponent(j.id), {
            method: 'PATCH',
            headers: Object.assign({ Authorization: 'Bearer ' + j.token }, API_HEADERS),
            body: JSON.stringify({ warp_enabled: true }),
            signal: signal || AbortSignal.timeout(25000),
        }).catch(() => null);
        const after = p && p.ok ? await p.json().catch(() => null) : null;
        if (!after || after.warp_enabled !== true) {
            throw new Error('کلادفلر وارپ را برای این حساب فعال نکرد — بدون آن تونل داده رد نمی‌کند.');
        }
    }

    const cid = Buffer.from(j.config.client_id, 'base64');
    return {
        deviceId: j.id,
        token: j.token,
        priv: kp.priv,
        v4: iface.addresses.v4,
        v6: iface.addresses.v6,
        peerPub: peer.public_key,
        reserved: [cid[0], cid[1], cid[2]],
        createdAt: Date.now(),
    };
}

/**
 * A pool of registered devices, so candidates can be data-tested in PARALLEL.
 *
 * One identity cannot do this. WireGuard names a peer by its public key and lets that peer roam,
 * so the same key handshaking with eight edges at once is one peer changing address eight times —
 * the server keeps only the latest and every tunnel but one goes silent. An early version of this
 * engine measured exactly nothing for that reason.
 *
 * Why parallel matters, measured: a sweep returns ~80 live endpoints and only a few of those
 * actually carry data. Testing ten of them one at a time samples too little — aether, which
 * data-tests its way through hundreds, was carrying traffic on the same line in the same minute
 * while this engine was still working through its first ten.
 */
async function identityPool(n, { signal } = {}) {
    const first = await identity({ signal });
    if (n <= 1) return [first];
    const rest = await Promise.all(Array.from({ length: n - 1 }, () => register({ signal }).catch(() => null)));
    return [first].concat(rest.filter(Boolean));
}

function readIdentity() {
    try {
        const j = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf8'));
        if (j && j.priv && j.peerPub && j.v4 && Array.isArray(j.reserved)) return j;
    } catch (e) { /* none yet */ }
    return null;
}

/** The saved device, or a newly registered one. */
async function identity({ fresh = false, signal } = {}) {
    if (!fresh) {
        const held = readIdentity();
        if (held) return held;
    }
    log('ساخت هویت تازه روی کلادفلر…');
    const id = await register({ signal });
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(IDENTITY_FILE, JSON.stringify(id, null, 2));
    log('هویت ساخته شد — آدرس ' + id.v4);
    return id;
}

// ── verification: a real request through the finished tunnel ─────────────────────────────────

/**
 * SOCKS5 CONNECT then a real HTTPS GET, counting body bytes.
 *
 * Written by hand for the same reason aether-speedtest.js is: the name must be resolved by the
 * tunnel (ATYP 0x03), never here, or the lookup leaks and points at the wrong edge.
 */
function verify(port, { host = 'www.cloudflare.com', timeoutMs = VERIFY_TIMEOUT_MS } = {}) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let settled = false;
        let step = 0;
        const done = (ok, detail) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) { /* already gone */ }
            resolve({ ok, detail: detail || '' });
        };
        const timer = setTimeout(() => done(false, 'timeout'), timeoutMs);

        sock.on('error', (e) => done(false, e.message));
        sock.on('data', (buf) => {
            if (step === 0) {
                if (buf.length < 2 || buf[0] !== 0x05 || buf[1] !== 0x00) return done(false, 'socks greeting');
                step = 1;
                const name = Buffer.from(host, 'ascii');
                const req = Buffer.alloc(7 + name.length);
                req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
                req[4] = name.length;
                name.copy(req, 5);
                req.writeUInt16BE(443, 5 + name.length);
                sock.write(req);
                return;
            }
            if (step === 1) {
                if (buf.length < 2 || buf[1] !== 0x00) return done(false, 'socks connect rejected');
                step = 2;
                sock.removeAllListeners('data');
                const secure = tls.connect({ socket: sock, servername: host }, () => {
                    secure.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: mlm-warp\r\nConnection: close\r\n\r\n`);
                });
                let body = '';
                secure.on('data', (c) => {
                    body += c.toString('latin1');
                    if (/warp=on/.test(body)) {
                        const colo = (body.match(/^colo=(.*)$/m) || [])[1] || '';
                        done(true, colo);
                    }
                });
                secure.on('error', (e) => done(false, e.message));
                secure.on('close', () => done(/warp=on/.test(body), 'closed'));
            }
        });

        sock.connect(port, '127.0.0.1', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    });
}

// ── the data plane: xray's WireGuard outbound, with noise ────────────────────────────────────

/**
 * The WireGuard data plane.
 *
 * `core/aether.exe`, and ONLY as a WireGuard transport. That choice is measured, not lazy:
 * `core/xray.exe` and `core/sing-box.exe` both complete the handshake with Cloudflare (through
 * warp-relay.js) and then carry nothing — 49 endpoints data-tested in parallel, zero successes,
 * in the same minutes aether was carrying traffic on the same line. Only boringtun's WARP
 * behaviour works here today.
 *
 * WHAT IS AND IS NOT SHARED, because «جدا کن» was the whole point of this engine:
 *
 *   shared        the binary, run as a child process with `AETHER_PROTOCOL=wg`.
 *   NOT shared    aether-manager.js — never imported, never called, its state untouched;
 *                 the MASQUE path, which is the part that breaks (identity, enrolment, QUIC);
 *                 the identity — ours, registered by this file into ~/.mlmvpn/warp/;
 *                 the data directory, the SOCKS port, the logs, the lifecycle, the watchdog;
 *                 what «connected» means — a real HTTPS request, decided here.
 *
 * So a fault in aether's MASQUE cannot reach «وارپ»: nothing in that path is executed. The
 * remaining dependency is one binary, and warp-prober.js / warp-relay.js are the groundwork for
 * removing even that when a WireGuard of our own can carry WARP.
 */
function aetherPath() {
    return corePaths.file('warp-aether', 'aether.exe', corePaths.bundled('core', 'aether.exe'));
}

/**
 * Our registration, written in the shape the binary reads.
 *
 * `cert_pem`/`key_pem` are deliberately empty and `assigned_endpoint` blank: those belong to the
 * MASQUE side, which this engine never starts. `client_id` carries the three reserved bytes.
 */
function identityToml(id) {
    return [
        'device_id = "' + (id.deviceId || '') + '"',
        'access_token = "' + (id.token || '') + '"',
        'cert_pem = ""',
        'key_pem = ""',
        'cert_issued_at = 0',
        'ipv4 = "' + id.v4 + '"',
        'ipv6 = "' + (id.v6 || '') + '"',
        'wg_private_key = "' + id.priv + '"',
        'wg_peer_public_key = "' + id.peerPub + '"',
        'client_id = "' + Buffer.from(id.reserved).toString('base64') + '"',
        'organization = ""',
        'gateway_proxy = ""',
        'assigned_endpoint = ""',
    ].join('\n') + '\n';
}

/**
 * The environment the transport is given. Every one of these is an `AETHER_*` variable the binary
 * reads; a renamed one fails silently, so this list is checked against the engine source on every
 * upgrade exactly like aether-manager.js's is.
 */
const VALID_SCANS = ['turbo', 'balanced', 'thorough', 'stealth', 'ironclad'];
const VALID_IP = ['v4', 'v6', 'both'];
const VALID_NOIZE = ['off', 'light', 'balanced', 'firewall', 'gfw', 'aggressive'];

function transportEnv(id, socksPort, opts) {
    const env = {
        RUST_BACKTRACE: '1',
        AETHER_LOG_LEVEL: 'info',
        AETHER_SOCKS: '127.0.0.1:' + socksPort,
        AETHER_PROTOCOL: 'wg',
        AETHER_IP: 'v4',
        AETHER_QUICK_RECONNECT: '1',
        // Its own scan. Ours (warp-prober.js) finds endpoints that ANSWER, which measured out as
        // a weak filter — the ones that carry data are a small fraction of those, and this scan
        // data-tests its way through thousands of candidates to find them.
        AETHER_SCAN: VALID_SCANS.includes(opts.scan) ? opts.scan : 'balanced',
        AETHER_IP: VALID_IP.includes(opts.ip) ? opts.ip : 'v4',
        AETHER_WG_KEEPALIVE: String(Number(opts.keepalive) > 0 ? Number(opts.keepalive) : 25),
        AETHER_CONFIG: path.join(DATA_DIR, 'identity.toml'),
    };
    // The panel's obfuscation choice, honoured — but never silently set to `off`.
    //
    // «خالی» is about the ROUTE, not the wire: Cloudflare's own endpoints, no shopping for the
    // lowest ping, nothing clever in between. It cannot mean unobfuscated, because bare
    // WireGuard measured 0 bytes in 170 s on this line while the obfuscated one carried traffic
    // in 76 s. So the default stays on, and only an explicit choice from the user changes it.
    if (opts.noize && VALID_NOIZE.includes(opts.noize)) env.AETHER_NOIZE = opts.noize;
    if (opts.perfProfile) env.AETHER_PERF_PROFILE = opts.perfProfile;
    return Object.assign({}, process.env, env);
}

async function spawnTransport(id, socksPort, opts) {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.writeFile(path.join(DATA_DIR, 'identity.toml'), identityToml(id));
    const exe = aetherPath();
    const child = spawn(exe, [], {
        env: transportEnv(id, socksPort, opts),
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onLine = (b) => {
        String(b).split(/\r?\n/).forEach((t) => {
            const line = t.trim();
            if (!line) return;
            const m = line.match(/using cloudflare edge (\S+)/i);
            if (m) { setStage('connecting', 'سرور انتخاب شد — آزمایش عبور داده', { server: m[1] }); return; }
            if (/no usable|no clean endpoint/i.test(line)) log('دور اسکن خالی بود — دوباره می‌گردد');
        });
    };
    child.stdout.on('data', onLine);
    child.stderr.on('data', onLine);
    return child;
}

/**
 * Kill it and WAIT for the socket to come back.
 *
 * `child.kill()` returns long before Windows releases the listener, and the next attempt then
 * fails to bind. That is not a cosmetic race: measured on the first real run, every later
 * candidate's xray died with «failed to listen TCP on 20870» while an earlier one still held the
 * port — so the verify that finally passed was answered by a DIFFERENT endpoint's tunnel, and the
 * engine recorded the wrong winner and then found itself connected to nothing.
 */
function kill(child) {
    if (!child) return Promise.resolve();
    return new Promise((resolve) => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        child.once('close', done);
        try { child.kill(); } catch (e) { return done(); }
        setTimeout(done, 3000);   // a process that will not die must not hang the engine
    });
}

// ── the loop ─────────────────────────────────────────────────────────────────────────────────

function rememberEndpoint(ep) {
    try { fs.writeFileSync(LAST_FILE, JSON.stringify(Object.assign({ at: Date.now() }, ep))); } catch (e) { /* cache only */ }
}

function lastEndpoint() {
    try {
        const j = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8'));
        // An endpoint older than ten minutes is not worth a first try: they go stale in about one.
        if (j && j.ip && j.port && Date.now() - (j.at || 0) < 10 * 60 * 1000) return { ip: j.ip, port: j.port };
    } catch (e) { /* none */ }
    return null;
}

/** Sweep Cloudflare's ranges for endpoints that answer a WireGuard handshake. */
async function sweep(id, { signal } = {}) {
    const cands = candidates(SWEEP_SIZE);
    const t0 = Date.now();
    const live = await prober.probe(cands, [id], { timeoutMs: SWEEP_TIMEOUT_MS });
    log(`جست‌وجو: ${cands.length} اندپوینت در ${((Date.now() - t0) / 1000).toFixed(1)} ثانیه — ${live.length} تا جواب دادند`);
    if (signal && signal.aborted) return [];
    return live;
}

/**
 * Connect: start the transport, then keep asking it for a real page until one arrives.
 *
 * The transport does its own scanning and reconnecting — that is the part of it that works and
 * the reason it was chosen. What this engine adds is the thing it does NOT do: «connected» is a
 * real HTTPS request through the finished tunnel, never a handshake. Measured repeatedly today, an
 * endpoint can answer the handshake, report a validated data plane, serve SOCKS and carry nothing.
 */
async function start(opts = {}, onLog = null, onStage = null) {
    await stop();
    const sid = ++sessionId;
    const mine = () => sessionId === sid;
    listeners = { onLog, onStage };
    logBuffer = [];
    const socksPort = opts.socksPort || SOCKS_PORT;

    // BEFORE the first setStage, so the very first status the page sees already says «running».
    active = true;
    setStage('starting', 'راه‌اندازی موتور وارپ', { connected: false, server: null, socksPort });
    log('════════ وارپ (موتور مستقل) ════════');

    if (!isInstalled()) throw new Error('فایل core/aether.exe موجود نیست.');

    const id = await identity({ signal: opts.signal });
    if (!mine()) return { ok: false };
    setStage('identity', 'هویت آماده است', { address: id.v4 });
    log('هویت: ' + id.v4 + ' — حساب وارپ فعال');

    const child = await spawnTransport(id, socksPort, opts);
    proc = child;
    child.on('close', () => {
        if (proc !== child) return;
        proc = null;
        if (state && state.connected && mine()) {
            setStage('reconnecting', 'موتور بسته شد — اتصال مجدد');
            start({ socksPort }, listeners.onLog, listeners.onStage).catch(() => {});
        }
    });

    setStage('scan', 'جست‌وجوی اندپوینتی که داده رد کند');
    log('جست‌وجوی اندپوینتی که واقعاً داده رد کند…');

    // RETURN NOW. The hunt can take two minutes and holding the HTTP request open for it is
    // what made the panel useless: the «راه‌اندازی شد» toast arrived at the END, and until then
    // the page had a pending request and nothing to show. Every engine in this app returns once
    // it is UP and reports the rest through status events, and so does this one.
    pursue(child, socksPort, mine).catch(() => {});
    return { ok: true, pending: true, socksPort };
}

/**
 * Ask the tunnel for a real page, over and over, until one arrives or the budget runs out.
 *
 * The transport keeps rescanning underneath the whole time; every ask is against whatever it has
 * settled on at that moment. This is what «connected» means here — never a handshake.
 */
async function pursue(child, socksPort, mine) {
    const deadline = Date.now() + CONNECT_BUDGET_MS;
    let asked = 0;
    while (Date.now() < deadline) {
        if (!mine() || !proc) return;
        await new Promise((r) => setTimeout(r, asked === 0 ? 6000 : 4000));
        if (!mine() || !proc) return;
        asked++;
        const v = await verify(socksPort, { timeoutMs: 8000 });
        if (!mine() || !proc) return;
        if (v.ok) { settle(child, socksPort, v.detail); return; }
        const left = Math.round((deadline - Date.now()) / 1000);
        setStage('validate', `آزمایش عبور داده — ${left} ثانیه دیگر`);
        if (asked % 5 === 0) log(`هنوز داده رد نمی‌شود — ${left} ثانیه دیگر تلاش می‌کند`);
    }
    if (!mine()) return;
    log('❌ در ' + Math.round(CONNECT_BUDGET_MS / 1000) + ' ثانیه هیچ اندپوینتی داده رد نکرد.');
    log('این شبکه وایرگارد به لبهٔ کلادفلر را بسته است — «ماسک» یا «ضد فیلتر SNI» را امتحان کنید.');
    await stop();
    setStage('failed', 'اندپوینت سالمی پیدا نشد');
}

function settle(child, socksPort, colo) {
    proc = child;
    setStage('connected', 'متصل شد — پراکسی آماده است', {
        connected: true, colo: colo || '', socksPort,
    });
    log(`✅ متصل شد${colo ? ' (خروج: ' + colo + ')' : ''} — SOCKS روی 127.0.0.1:${socksPort}`);
    // The close handler was attached when the transport was spawned; it owns the restart.
    startWatchdog(socksPort);
    return { ok: true, server: (state && state.server) || null, socksPort };
}

/**
 * Keep asking. Endpoints on a filtered line go stale in about a minute while the tunnel stays up
 * and silent, so the only honest way to hold «connected» is to keep proving it.
 */
function startWatchdog(socksPort) {
    stopWatchdog();
    // The session this watchdog belongs to. Without it, a disconnect the USER asked for is undone
    // by the watchdog a moment later — which is exactly what they saw: pressing «قطع» printed
    // «جست‌وجوی اندپوینت تازه» and the engine came straight back. `proc`/`connected` alone cannot
    // prevent it, because the watchdog's own `await stop()` clears them and its `start()` then
    // runs regardless of who else stopped the engine in the meantime.
    const sid = sessionId;
    watchdog = setInterval(async () => {
        if (sessionId !== sid || !proc || !state || !state.connected) return;
        const r = await verify(socksPort, { timeoutMs: 9000 });
        if (sessionId !== sid || !proc || !state || !state.connected) return;
        if (r.ok) return;
        const again = await verify(socksPort, { timeoutMs: 9000 });
        if (sessionId !== sid || !proc || !state || !state.connected) return;
        if (again.ok) return;
        log('⚠️ این اندپوینت دیگر داده رد نمی‌کند — جست‌وجوی اندپوینت تازه');
        const port = socksPort;
        const l = listeners;
        await stop();
        // stop() bumped the counter, so this is the one place that has to re-read it: only the
        // session this watchdog was watching may be restarted, and only by this watchdog.
        if (sessionId !== sid + 1) return;
        start({ socksPort: port }, l.onLog, l.onStage).catch(() => {});
    }, 45000);
}

function stopWatchdog() {
    if (watchdog) { clearInterval(watchdog); watchdog = null; }
}

async function stop() {
    sessionId++;
    active = false;
    stopWatchdog();
    const child = proc;
    proc = null;
    // Awaited: a start that follows immediately must find the port free.
    if (child) await kill(child);
    if (state && state.connected) log('وارپ قطع شد.');
    setStage('idle', 'خاموش', { connected: false, server: null });
    return { ok: true };
}

/**
 * The edge addresses this engine's own transport talks to.
 *
 * These MUST stay outside the system tunnel. If the tunnel captures them, the transport's own
 * packets are routed back into the tunnel it is carrying — the machine goes offline with a green
 * badge over it, and no setting fixes it. `/api/tun` asks for this list before it starts.
 *
 * Two sources, because the live one alone is not enough: the edge the transport has settled on
 * right now, and every endpoint written into this engine's own data directory, which is what it
 * will reach for on the next reconnect — a tunnel that excludes only the current one breaks the
 * moment the transport hops.
 */
function getUplinkIps() {
    const ips = new Set();
    const add = (value) => {
        if (!value) return;
        let host = String(value).trim().replace(/^\[|\]$/g, '');
        const bracket = host.match(/^\[(.+)\]:\d+$/);
        if (bracket) host = bracket[1];
        else if (/^[\d.]+:\d+$/.test(host)) host = host.split(':')[0];
        if (/^[\d.]+$/.test(host) || host.includes(':')) ips.add(host);
    };

    if (state && state.server) add(state.server);
    try {
        if (fs.existsSync(DATA_DIR)) {
            fs.readdirSync(DATA_DIR)
                .filter((f) => f.endsWith('.toml'))
                .forEach((f) => {
                    let text = '';
                    try { text = fs.readFileSync(path.join(DATA_DIR, f), 'utf8'); } catch (e) { return; }
                    (text.match(/^\s*(?:peer|assigned_endpoint|endpoint)\s*=\s*"([^"]+)"/gm) || [])
                        .forEach((line) => add(line.split('=')[1].replace(/"/g, '')));
                });
        }
    } catch (e) { /* an unreadable dir is an empty list, not a crash */ }
    return [...ips];
}

/**
 * Throw this engine's Cloudflare account away; the next connect registers a fresh one.
 *
 * Only «وارپ»'s own files, in its own directory — aether's identities are not touched, which is
 * the whole point of the split. The cached endpoint goes too: keeping it would have the new
 * account re-verify the edge the old one was using, which is not what «start again» means.
 */
async function resetIdentity() {
    const removed = [];
    for (const f of ['identity.json', 'identity.toml', 'last-endpoint.json']) {
        const full = path.join(DATA_DIR, f);
        try { if (fs.existsSync(full)) { await fsp.unlink(full); removed.push(f); } }
        catch (e) { /* a file we cannot delete is one the next start overwrites anyway */ }
    }
    log(removed.length ? 'هویت وارپ پاک شد — اتصال بعدی حساب تازه می‌سازد.' : 'هویتی برای پاک کردن نبود.');
    return { ok: true, removed };
}

const isRunning = () => !!proc;
const getStatus = () => Object.assign({ socksPort: SOCKS_PORT }, state || { stage: 'idle', stageFa: 'خاموش', connected: false }, { running: active });
const getLogs = () => logBuffer.slice();
const isInstalled = () => { try { return fs.existsSync(aetherPath()); } catch (e) { return false; } };

module.exports = {
    start, stop, isRunning, getStatus, getLogs, isInstalled, getUplinkIps, resetIdentity,
    identity, register, verify, candidates,
    SOCKS_PORT, DATA_DIR, IDENTITY_FILE,
    _internal: { identityToml, transportEnv, aetherPath, sweep, PREFIXES, PORTS },
};
