'use strict';

/**
 * The «تور» engine: tor itself, plus lyrebird as its pluggable transport.
 *
 * Ported from the Android app's `TorManager.kt`, and deliberately a port rather than a fresh
 * design — every number in here came out of a measurement on a real Iranian line, and the two
 * platforms disagreeing about which transport to try first would mean one of them is wrong.
 *
 * ## What runs
 *
 *   TUN ─► sing-box ─► tor SocksPort 20820 ─► circuit
 *                 └─ DNS ─► tor DNSPort 20821
 *                           tor ─► lyrebird.exe (a managed PT, for the bridge rungs)
 *
 * `core/tor/tor.exe` is 0.4.9.12 and `core/tor/pluggable_transports/lyrebird.exe` is 0.8.1 —
 * the Tor Project's own Windows Expert Bundle 15.0.22, verified against their signed
 * `sha256sums-signed-build.txt`. lyrebird serves obfs4, meek_lite, snowflake and webtunnel from
 * the one executable, so there is exactly one PT process whichever bridge rung is running.
 *
 * ## No UDP, and that is not a limitation to work around
 *
 * Tor carries TCP only. So the tunnel is built with `supportsUdp: false`, QUIC is refused rather
 * than dropped (so browsers fall back to TCP at once instead of waiting out a timeout), and DNS
 * goes to tor's own `DNSPort` on loopback — NOT to a public resolver. That last one is a privacy
 * decision, not a plumbing one: a public resolver in the list would send every app's lookups
 * outside the circuit in cleartext, naming exactly which sites a user who just turned Tor on is
 * visiting.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

// ============================================================
// Ports, paths and budgets
// ============================================================

/**
 * Tor's SOCKS and DNS listeners.
 *
 * Away from every other engine's port: xray is on 20809, the WARP core on 20810, and
 * xray-tester owns 21300–29500 for its throwaway instances. A collision here would not fail
 * loudly — tor would exit with "Could not bind to 127.0.0.1:x: Address already in use" while the
 * UI was still saying "starting".
 */
const SOCKS_PORT = 20820;
const DNS_PORT = 20821;
/**
 * The HTTP proxy, on the same circuits.
 *
 * Not a second process and not a bridge of ours — `HTTPTunnelPort` is tor's own HTTP CONNECT
 * listener. It exists because SOCKS5 is not a proxy setting most software HAS: a program with one
 * «proxy» field means HTTP, Windows' own setting means HTTP, and every one of them gets silence
 * from the SOCKS port. سایفون already publishes 20831 for this and لنترن 20841; تور had nothing,
 * which made it the one engine whose «پروکسی» coverage only worked for SOCKS5-aware programs.
 */
const HTTP_PORT = 20822;

/**
 * Tor's control port — the instrument this engine went without for its whole life.
 *
 * Until it was opened, everything the app knew about «تور» was a bootstrap percentage scraped from
 * stdout. Which relay carries the connection, whether a single circuit is alive, how many bytes
 * crossed, which country the exit sits in, whether a stuck path can be replaced without paying a
 * bootstrap — tor answers all of it here and nowhere else. It is also the only way the three
 * standing complaints could be measured rather than guessed at: the SOCKS port stays open and
 * accepting while every circuit behind it is failing, so a watchdog that asks «is the port alive?»
 * sees a healthy engine on a dead connection.
 *
 * Loopback only, and cookie-authenticated: the cookie is a file inside the data directory that only
 * this user can read, so nothing else on the machine can drive the tunnel.
 */
const CONTROL_PORT = 20823;

/**
 * Where torrc, the PT state and the consensus cache live.
 *
 * `MLMVPN_HOME` is honoured for the same reason tun-diag honours it: the suites drive the real
 * manager, and this directory now holds things a test must never touch — the user's own bridge
 * lines, the remembered rung, and a 38 MB directory cache that took six minutes to build once and
 * is the difference between a ten-second connect and a six-minute one.
 */
const TOR_DATA_DIR = path.join(process.env.MLMVPN_HOME || os.homedir(), '.mlmvpn', 'tor');

/**
 * How long a rung may sit at the same bootstrap percentage before it is abandoned — BELOW 50%.
 *
 * This is the blocked-transport detector, and it is only honest below 50%. Under that mark tor is
 * negotiating: opening a TLS connection to a guard or bridge, fetching the consensus, fetching
 * authority certificates. Ninety seconds without a single percent of movement there does mean the
 * network is eating the transport.
 *
 * It replaced a fixed per-rung budget, which is what made every transport look broken. Measured on
 * Android, one attempt per rung, in ladder order:
 *
 * ```
 *   Direct    45% reached,          killed at its 90s deadline
 *   Meek      45% in 5s, then 50%,  killed at its 60s deadline
 *   obfs4     45% in 23s, then 50%, killed at its 60s deadline
 *   Snowflake 45% in 15s, then 50%, killed at its 60s deadline
 * ```
 *
 * All four reached 45% ("asking for relay descriptors") and moved to 50% ("loading relay
 * descriptors"). Getting that far means the transport carried a TLS handshake, a consensus
 * download and an authority-cert download — it was never the transport that failed.
 */
const STALL_BELOW_50_MS = 90_000;

/**
 * The same window at 50% and above — SEVEN MINUTES, and that number is measured, not padded.
 *
 * At 50% tor is downloading a few megabytes of microdescriptors in batches and reports no
 * percentage between batches. On a slow link that silence is long, and treating it as a stall
 * kills the one phase that was working.
 *
 * Measured here on an Iranian line, direct rung, cold cache:
 *
 * ```
 *   0s    0%
 *   4s   45%      (consensus and certs already crossed)
 *   329s 60%      <-- 325 SECONDS of silence at 50%, then it moved
 *   336s 90%
 *   337s 100%     and the SOCKS port carried a stream
 * ```
 *
 * tor's own congestion log during that window reported round-trip times of 3.1 to 12.7 seconds.
 * Nothing was blocked; the descriptors were arriving at the speed the line allows. A 90-second
 * window — and the 150-second ceiling the rung used to have — both cut that off at the knees, and
 * the whole ladder then reported "no method connected" on a network where the FIRST rung works.
 */
const STALL_AT_50_MS = 420_000;

/**
 * Absolute ceiling per rung, however well it is progressing.
 *
 * A backstop against a transport that dribbles one percent a minute for ever, and nothing more —
 * the stall detector above is what actually decides. Sized so the measured 337-second cold
 * bootstrap fits with room to spare, because a ceiling that cuts a working connection is worse
 * than no ceiling at all.
 */
const DIRECT_TIMEOUT_MS = 600_000;
const BRIDGE_TIMEOUT_MS = 900_000;

/** How long lyrebird gets to announce its listeners. A local process doing no network work. */
const PT_HANDSHAKE_TIMEOUT_MS = 10_000;

/** Bootstrap percentages worth a log line. A full bootstrap emits dozens. */
const LOG_EVERY_PERCENT = 20;

/**
 * Tor's own bootstrap phase tags, in Persian.
 *
 * Tor names every step it is on and the app was reading only the number beside it. The one that
 * matters is `loading_descriptors`: on a machine with nothing cached that single phase is the
 * whole of the long wait, and a bar sitting at 50% with no words next to it is indistinguishable
 * from a hang. Anything unrecognised falls through to an empty string rather than to the English
 * tag — a tag nobody reads is worse than no tag.
 */
const PHASE_FA = {
    starting: 'راه‌اندازی',
    conn_pt: 'اتصال به ترابری',
    conn_done_pt: 'ترابری وصل شد',
    conn_proxy: 'اتصال به پروکسی',
    conn_done_proxy: 'پروکسی وصل شد',
    conn: 'اتصال به رله',
    conn_done: 'رله وصل شد',
    handshake: 'دست‌دادن رمزنگاری',
    handshake_done: 'رمزنگاری برقرار شد',
    onehop_create: 'ساخت مسیر موقت',
    requesting_status: 'درخواست فهرست شبکه',
    loading_status: 'دریافت فهرست شبکه',
    loading_keys: 'دریافت کلیدهای مرجع',
    requesting_descriptors: 'درخواست مشخصات رله‌ها',
    loading_descriptors: 'دریافت مشخصات رله‌ها — طولانی‌ترین مرحله',
    enough_dirinfo: 'فهرست کافی شد',
    ap_conn_pt: 'اتصال مدار به ترابری',
    ap_conn_done_pt: 'ترابری مدار وصل شد',
    ap_conn: 'ساخت مدار',
    ap_conn_done: 'مدار وصل شد',
    ap_handshake: 'دست‌دادن مدار',
    ap_handshake_done: 'مدار رمزنگاری شد',
    circuit_create: 'ساخت مدار',
    done: 'آماده',
};

// ============================================================
// The connection modes
// ============================================================

/**
 * What the user can choose. `auto` is not a transport — it walks the others.
 *
 * The labels are Persian because they are shown; the keys are the engine's own names and must
 * not be translated.
 */
const MODES = [
    { key: 'auto', label: 'خودکار', hint: 'همه را به‌ترتیب امتحان می‌کند تا یکی وصل شود' },
    { key: 'direct', label: 'مستقیم', hint: 'بدون پل؛ سریع‌ترین، جایی که تور بسته نیست' },
    { key: 'meek', label: 'Meek', hint: 'سوار یک CDN می‌شود؛ کند ولی سخت‌ترین برای بلاک شدن' },
    { key: 'obfs4', label: 'obfs4', hint: 'پلی که شکل ترافیک تور را می‌پوشاند' },
    { key: 'webtunnel', label: 'WebTunnel', hint: 'از دید شبکه یک سایت HTTPS معمولی است — سریع و سخت برای تشخیص' },
    { key: 'conjure', label: 'Conjure', hint: 'سروری برای بلاک کردن ندارد — ولی ایستگاه ثبت‌نامش این روزها شلوغ است و ممکن است نپذیرد' },
    { key: 'snowflake', label: 'Snowflake', hint: 'پروکسی‌های داوطلبانهٔ WebRTC' },
];

/**
 * The AUTO ladder: Direct → Meek → obfs4 → Snowflake.
 *
 * Direct first because where it works it is both the fastest to connect and the fastest to use.
 * Meek next, and ahead of obfs4 on purpose: to the network it is an HTTPS connection to a CDN, so
 * it works nearly everywhere, and its cost — an HTTP round trip per cell — is a speed problem
 * rather than a reachability one. obfs4 third: plain TCP obfuscation, fast once up, but public
 * obfs4 bridges are the first thing a serious censor scans for. Snowflake last because finding a
 * volunteer proxy through a broker is the highest-variance step of the four.
 */
/** Conjure's registration station. Measured reachable from this line; also frontable. */
const CONJURE_REGISTRAR = 'https://registration.refraction.network/api';

const LADDER = [
    { mode: 'direct', timeout: DIRECT_TIMEOUT_MS },
    // Ahead of meek on purpose: WebTunnel is as hard to spot — to the network it is an ordinary
    // HTTPS site — and it does not pay meek's HTTP round trip per cell. A dead WebTunnel host fails
    // in a TCP timeout; a working meek is slow for the whole session.
    { mode: 'webtunnel', timeout: BRIDGE_TIMEOUT_MS },
    { mode: 'meek', timeout: BRIDGE_TIMEOUT_MS },
    { mode: 'obfs4', timeout: BRIDGE_TIMEOUT_MS },
    // CONJURE IS DELIBERATELY NOT HERE.
    //
    // It works — the client comes up and answers in under 200 ms — but its registration station is
    // refusing: measured 2026-09-13, eight retries over 85 seconds, every one answered
    // «station is under high load», and tor never got a bridge. That is the network's capacity, not
    // a fault here, and it may clear. But in the automatic ladder it would cost every user whose
    // earlier rungs failed a minute and a half of waiting for a no. It stays a deliberate choice in
    // MODES instead.
    { mode: 'snowflake', timeout: BRIDGE_TIMEOUT_MS },
];

/** lyrebird's own transport name for a mode, or null for the bridge-less rung. */
function transportFor(mode) {
    switch (mode) {
        case 'obfs4': return 'obfs4';
        case 'meek': return 'meek_lite';
        case 'snowflake': return 'snowflake';
        case 'webtunnel': return 'webtunnel';
        case 'conjure': return 'conjure';
        default: return null;
    }
}

/** The label a log line or the UI should use for a mode. */
function labelFor(mode) {
    const m = MODES.find(x => x.key === mode);
    return m ? m.label : mode;
}

// ============================================================
// Exit countries
// ============================================================

/**
 * The countries worth offering as an exit preference, with their running exit-relay counts.
 *
 * The counts are in here because they are the honest predictor of whether a choice will be
 * honoured. Counted from the Tor Project's own onionoo service (`type=relay&running=true&
 * flag=Exit`): 3275 running exits across 52 countries, with the top three holding more than two
 * thirds. The cut is at five exits — Greece, Mexico, Estonia and Portugal have exactly one each,
 * and a control that is obeyed one time in twenty is worse than no control.
 *
 * `StrictNodes 0` is what makes this safe to expose at all: the choice is a PREFERENCE tor
 * abandons when it cannot build a circuit in that country. See [writeTorrc].
 */
const EXIT_COUNTS = {
    US: 1165, NL: 614, DE: 415, SE: 344, AT: 123,
    LU: 93, RO: 70, FR: 67, NO: 54, SG: 35,
    CH: 34, UA: 29, IS: 24, HR: 20, HU: 19,
    BG: 17, IT: 15, DK: 15, FI: 12, ZA: 11,
    CZ: 10, PL: 9, GB: 7, ES: 6, ID: 6,
    HK: 6, CA: 5,
};

const COUNTRY_NAMES = {
    AT: 'اتریش', BG: 'بلغارستان', CA: 'کانادا', CH: 'سوئیس', CZ: 'چک',
    DE: 'آلمان', DK: 'دانمارک', ES: 'اسپانیا', FI: 'فینلاند', FR: 'فرانسه',
    GB: 'بریتانیا', HK: 'هنگ‌کنگ', HR: 'کرواسی', HU: 'مجارستان', ID: 'اندونزی',
    IS: 'ایسلند', IT: 'ایتالیا', LU: 'لوکزامبورگ', NL: 'هلند', NO: 'نروژ',
    PL: 'لهستان', RO: 'رومانی', SE: 'سوئد', SG: 'سنگاپور', UA: 'اوکراین',
    US: 'آمریکا', ZA: 'آفریقای جنوبی',
};

/** The exit list, richest first — which is also most-likely-to-be-honoured first. */
function regions() {
    return Object.keys(EXIT_COUNTS)
        .sort((a, b) => EXIT_COUNTS[b] - EXIT_COUNTS[a])
        .map(code => ({ code, name: COUNTRY_NAMES[code] || code, exits: EXIT_COUNTS[code] }));
}

// ============================================================
// State
// ============================================================

const state = {
    running: false,
    connected: false,
    mode: null,          // the rung that is running or won
    requested: 'auto',   // what the user asked for
    percent: 0,
    phase: '',           // tor's own name for the step it is on, in Persian — see PHASE_FA
    bootBytes: 0,        // what tor has pulled down during this bootstrap, from its own counter
    stage: 'idle',       // idle | starting | bootstrapping | connected | failed
    detail: '',
    region: 'auto',
    since: null,
    error: null,
    // Filled from the control port while tor runs; null before the first poll. See [liveInfo].
    traffic: null,       // {read, written} — tor's own counters, not the adapter's
    circuits: null,      // {built, building}
    rateDown: 0,
    rateUp: 0,
};

let torProc = null;
let ptProc = null;
let ptMethods = {};      // transport -> "host:port" announced by lyrebird
let logs = [];
let cancelled = false;
let upstreamProxy = null; // "host:port" when a chained (Tor-over-WARP) session asked for one
/** Whether the rung that just ran got as far as the descriptor download. See [startTor]. */
let reached50 = false;

// What tor has said since it finished bootstrapping, as raw text rather than parsed lines.
//
// Kept because the log has to remain useful after a connection goes wrong — «کند شد», «قطع شد»,
// a circuit that will not build — and the per-line reader is switched off at that point (see
// `done` in startTor) precisely so that carrying the whole machine does not cost a regex per
// stream in the main thread. 64 KB is a few minutes of an `info` log: enough to see what tor was
// doing when it went wrong, bounded enough to be free.
const RUN_TAIL_BYTES = 64 * 1024;
let runTail = '';

/** Tor's own output since bootstrap finished. Newest last; empty before the first connection. */
function torTail() { return runTail; }

const MAX_LOGS = 300;

function record(line, onLog) {
    const stamped = `[TOR] ${line}`;
    logs.push(stamped);
    if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
    if (typeof onLog === 'function') { try { onLog(stamped); } catch (e) { /* the UI is gone */ } }
}

// ============================================================
// Files
// ============================================================

function binPaths() {
    const root = require('./core-paths').dir('tor', require('./core-paths').bundled('core', 'tor'));
    return {
        tor: path.join(root, 'tor.exe'),
        pt: path.join(root, 'pluggable_transports', 'lyrebird.exe'),
        // Conjure is its OWN executable, not one of lyrebird's methods — see [ptBinFor].
        conjure: path.join(root, 'pluggable_transports', 'conjure-client.exe'),
        ptConfig: path.join(root, 'pluggable_transports', 'pt_config.json'),
        geoip: path.join(root, 'data', 'geoip'),
        geoip6: path.join(root, 'data', 'geoip6'),
    };
}

function isInstalled() {
    const p = binPaths();
    return fs.existsSync(p.tor) && fs.existsSync(p.pt);
}

function ensureDataDir() {
    if (!fs.existsSync(TOR_DATA_DIR)) fs.mkdirSync(TOR_DATA_DIR, { recursive: true });
    return TOR_DATA_DIR;
}

/**
 * The default bridges, read from the bundle rather than copied into this file.
 *
 * `pluggable_transports/pt_config.json` is the Tor Project's own list and it ships beside
 * lyrebird, so it moves when the bundle moves. Hard-coding them — which the Android port did —
 * means a bundle upgrade silently keeps yesterday's bridges, and a dead bridge is indistinguishable
 * from a blocked transport: tor reports the same "general SOCKS server failure" either way.
 *
 * The fallback is one obfs4 and one meek line, enough that a corrupted config file degrades to a
 * working direct rung plus a chance on each bridge rung, instead of to nothing.
 */
function bridgeLinesFor(mode) {
    const group = ['meek', 'obfs4', 'snowflake', 'webtunnel', 'conjure'].includes(mode) ? mode : null;
    if (!group) return [];
    // THE USER'S OWN BRIDGES WIN, and they replace rather than join the defaults. A bridge the
    // user was given personally is unburned precisely because nobody else has it; putting it in a
    // list behind five addresses every censor already knows would have tor spend the rung's whole
    // budget on the burned ones first. See [saveCustomBridges].
    const mine = readCustomBridges()[group];
    if (Array.isArray(mine) && mine.length) return mine.slice();
    try {
        const cfg = JSON.parse(fs.readFileSync(binPaths().ptConfig, 'utf8'));
        const lines = (cfg.bridges || {})[group];
        if (Array.isArray(lines) && lines.length) return lines.slice();
    } catch (e) { /* fall through to the built-in pair */ }
    if (group === 'meek') {
        return ['meek_lite 192.0.2.20:80 url=https://1603026938.rsc.cdn77.org front=www.phpmyadmin.net utls=HelloRandomizedALPN'];
    }
    if (group === 'obfs4') {
        return ['obfs4 51.222.13.177:80 5EDAC3B810E12B01F6FD8050D2FD3E277B289A08 cert=2uplIpLQ0q9+0qMFrK5pkaYRDOe460LL9WHBvatgkuRr/SL31wBOEupaMMJ6koRE6Ld0ew iat-mode=0'];
    }
    if (group === 'conjure') {
        // ONE LINE, and it carries no fingerprint — there is no fixed server to identify. The
        // address is a placeholder the way a WebTunnel line's is; what matters is the registrar.
        return [`conjure 0.0.0.0:1 url=${CONJURE_REGISTRAR} front=cdn.sstatic.net`];
    }
    return [];
}

// ============================================================
// Does this line's IPv6 carry?
// ============================================================

/**
 * One TCP connect to a well-known IPv6 address, remembered for the session.
 *
 * An address alone proves nothing: Iranian mobile lines hand out a global 2a02:… routinely and
 * then drop every packet sent over it, and Windows keeps the address regardless. So the question
 * is answered the only honest way — by opening a connection — and the answer decides
 * `ClientUseIPv6`, which is the difference between tor trying v6 ORPorts that time out and tor
 * not trying them at all.
 *
 * Two addresses, because one provider being unreachable is not the same as no IPv6.
 */
let ipv6Cache = null;
function ipv6Works(timeoutMs = 2500) {
    if (ipv6Cache !== null) return Promise.resolve(ipv6Cache);
    const one = (host) => new Promise(resolve => {
        let done = false;
        const sock = new net.Socket();
        const finish = (ok) => { if (done) return; done = true; try { sock.destroy(); } catch (e) { /* gone */ } resolve(ok); };
        sock.setTimeout(timeoutMs, () => finish(false));
        sock.on('error', () => finish(false));
        try { sock.connect({ host, port: 443, family: 6 }, () => finish(true)); }
        catch (e) { finish(false); }
    });
    return Promise.all([one('2606:4700:4700::1111'), one('2001:4860:4860::8888')])
        .then(([a, b]) => { ipv6Cache = a || b; return ipv6Cache; });
}

/** Forget the measurement — the line may have changed. Called on every fresh connect. */
function forgetIpv6() { ipv6Cache = null; }

// ============================================================
// The user's own bridges
// ============================================================

/**
 * Bridge lines the user pasted in, kept beside the rest of tor's state.
 *
 * This is the one thing a censored user genuinely cannot work around from inside the app: the
 * default bridges ship in the bundle, which means every copy of every Tor client on earth carries
 * the same handful, and in Iran they are the first addresses a censor burns. The Tor Project's own
 * answer is to hand out fresh ones per request (bridges.torproject.org, or the Telegram bot), and
 * until now there was nowhere to put them — «obfs4 نمی‌گیرد» had no remedy but "try another
 * method".
 *
 * Stored per transport, because a bridge line names its own transport and mixing them into one
 * list would hand meek lines to the obfs4 rung.
 */
function bridgesFile() { return path.join(ensureDataDir(), 'bridges.json'); }

function readCustomBridges() {
    try {
        const o = JSON.parse(fs.readFileSync(bridgesFile(), 'utf8'));
        return o && typeof o === 'object' ? o : {};
    } catch (e) { return {}; }
}

/**
 * Sort pasted text into transports.
 *
 * A bridge line starts with its transport name — `obfs4 …`, `webtunnel …`, `meek_lite …` — except
 * for a plain `IP:PORT FINGERPRINT`, which is a bridge with no transport at all and belongs to the
 * direct rung. Anything else is dropped rather than stored, so a paste that included the
 * surrounding page text cannot produce a torrc tor refuses to start with.
 */
function parseBridgeLines(text) {
    const out = {};
    const add = (group, line) => { (out[group] = out[group] || []).push(line); };
    String(text || '').split(/[\r\n]+/).map(l => l.trim()).filter(Boolean).forEach(line => {
        const first = line.split(/\s+/)[0].toLowerCase();
        if (first === 'obfs4') return add('obfs4', line);
        if (first === 'webtunnel') return add('webtunnel', line);
        if (first === 'meek_lite' || first === 'meek') return add('meek', line);
        if (first === 'snowflake') return add('snowflake', line);
        if (first === 'conjure') return add('conjure', line);
        // `Bridge ` prefixes are what the bridges.torproject.org page shows; strip and re-read.
        if (first === 'bridge') {
            const rest = line.replace(/^bridge\s+/i, '');
            if (rest) {
                const sub = parseBridgeLines(rest);
                Object.keys(sub).forEach(k => sub[k].forEach(l => add(k, l)));
            }
            return;
        }
        if (/^\[?[0-9a-f:.]+\]?:\d+\s+[0-9A-F]{40}/i.test(line)) return add('plain', line);
    });
    return out;
}

function saveCustomBridges(text) {
    const parsed = parseBridgeLines(text);
    fs.writeFileSync(bridgesFile(), JSON.stringify(parsed, null, 2), 'utf8');
    return parsed;
}

function clearCustomBridges() {
    try { fs.unlinkSync(bridgesFile()); } catch (e) { /* none saved */ }
    return {};
}

// ============================================================
// torrc
// ============================================================

/**
 * Write the torrc for one rung.
 *
 * @param dataDir    tor's DataDirectory
 * @param mode       direct | obfs4 | meek | snowflake
 * @param region     a two-letter code, or 'auto'
 * @param ipv6       whether this line's IPv6 actually carries — measured, see [ipv6Works]
 */
function writeTorrc(dataDir, mode, region, ipv6 = true) {
    const transport = transportFor(mode);
    const bridges = bridgeLinesFor(mode);
    // No transport means no PT process, which is the ONLY case where the proxy belongs in the
    // torrc — see startPt for where it goes otherwise.
    const proxyGoesInTorrc = !transport && bridges.length === 0;
    const p = binPaths();
    const lines = [];

    // `IPv6Traffic` is not about how tor reaches the network — it is about what a SOCKS client is
    // allowed to ASK for. Without it tor refuses an AF_INET6 destination outright, so every
    // connection sing-box hands over as a v6 literal (anything it did not sniff a name for) dies
    // at the proxy with a general failure and is retried over v4 or not at all.
    lines.push(`SocksPort 127.0.0.1:${SOCKS_PORT} IPv6Traffic`);
    lines.push(`DNSPort 127.0.0.1:${DNS_PORT}`);
    // See HTTP_PORT. Same circuits, no extra process — and the only way a program that has one
    // «proxy» field can use tor at all.
    lines.push(`HTTPTunnelPort 127.0.0.1:${HTTP_PORT}`);
    lines.push(`DataDirectory ${dataDir}`);
    // See CONTROL_PORT. Cookie authentication means the credential is a file in the data
    // directory rather than a password in a config anyone can read.
    lines.push(`ControlPort 127.0.0.1:${CONTROL_PORT}`);
    lines.push('CookieAuthentication 1');
    // ONION ADDRESSES, WHICH NEVER WORKED THROUGH THE TUNNEL.
    //
    // In proxy mode a browser hands `x.onion` to the SOCKS port by name and tor resolves it
    // itself. Through the TUN nothing ever gets that far: the program first asks DNS for the
    // name, tor's DNSPort answers NXDOMAIN for `.onion` (it is not in the DNS), and no TCP
    // connection is ever opened — so sing-box never sniffs anything and the whole of the onion
    // web was unreachable from the one engine that exists to reach it.
    //
    // `AutomapHostsOnResolve` is tor's own answer: the DNSPort hands back an address out of the
    // range below, remembers the mapping, and a connection to that address through the SOCKS port
    // is turned back into the onion. 10.192.0.0/10 rather than tor's 127.192.0.0/10 default,
    // because a loopback destination never reaches the adapter at all.
    lines.push('AutomapHostsOnResolve 1');
    lines.push('AutomapHostsSuffixes .onion,.exit');
    lines.push('VirtualAddrNetworkIPv4 10.192.0.0/10');
    // A client and only ever a client.
    lines.push('ClientOnly 1');
    lines.push('SocksPolicy accept 127.0.0.0/8');
    lines.push('SocksPolicy reject *');
    // `info`, not `notice`, deliberately. Two Android field devices reported tor dying at 0%
    // with nothing in the log but "exited" — at `notice` tor says nothing about what it does
    // between reading the config and opening its first connection, which is exactly the window
    // where those deaths happen. The volume never reaches the user: these lines are kept in the
    // ring buffer above and only replayed when a rung actually fails.
    lines.push('Log info stdout');
    // Tor's own default scrubs addresses from its logs. Without this a dead bridge is invisible —
    // the log says "general SOCKS server failure" and not which bridge produced it. There is no
    // third party to protect here: it is one user's own connection, shown to them.
    lines.push('SafeLogging 0');
    // NO `AvoidDiskWrites 1` HERE, and that is the single biggest difference from the Android
    // port. It is right on a phone, where writes cost battery and flash. On a desktop it throws
    // away the one thing that makes Tor usable on a slow line: the consensus and microdescriptor
    // cache. Measured on this line, same rung, back to back —
    //
    //   cold cache  337s to 100%
    //   warm cache    7s to 100%
    //
    // A user who connects once a day should pay the 337 seconds once, not every day.
    lines.push('DormantClientTimeout 2419200');
    lines.push('ClientBootstrapConsensusAuthorityDownloadInitialDelay 0');
    // ONE ENTRY GUARD MEANS ONE RELAY CARRIES THE WHOLE MACHINE.
    //
    // This line used to be `1` for every rung, and on the direct rung that is a throughput and
    // an uptime ceiling in the same number. Measured from this machine's own tor state on
    // 2026-09-17, while «تور کند است و مدام قطع و وصل می‌شود» was being reported:
    //
    //   the single primary guard was `bigwalkdog`, consensus Bandwidth=8400 — BELOW the
    //   network median of 9200 (p90 is 53000, max 330000) — and tor's own state had it as
    //   `listed=0 unlisted_since=2026-09-14`, i.e. it no longer even carries the Guard flag.
    //
    // Every circuit the user built went through that one relay, sharing its capacity with
    // everyone else on it, with NO warm second primary to fail over to: each time it stumbled,
    // every stream stalled together and tor had to reach back into its sampled set. Three is
    // tor's own default for exactly this reason — the extra two are kept warm and unused until
    // the first one falters.
    //
    // A BRIDGE RUNG KEEPS 1. There the guard set IS the bridge list: the ladder hands tor one
    // bridge at a time on purpose (it is measuring which one works), and asking for three
    // primaries out of a one-entry set buys nothing.
    lines.push(`NumEntryGuards ${bridges.length ? 1 : 3}`);
    lines.push('LearnCircuitBuildTimeout 0');
    // With learning off, this fixed value is the ONLY thing that abandons a hopeless path — and
    // at 60s it was longer than anything that waits on it. No browser, and none of this app's
    // probes, waits a minute for one connection: the stream was dead long before tor gave up on
    // its circuit, which is the error that filled the tunnel log —
    //
    //   ERROR connection: report handshake success: connection refused
    //
    // i.e. sing-box finally got its outbound and found the local application had already left.
    // 25s is still generous for a three-hop build from Iran (a healthy one here is 2–8s) and it
    // lets tor throw a bad path away while the user is still on the page.
    //
    // Meek pays an HTTP round trip per cell, so even 60s is not enough for a three-hop
    // handshake over it. Snowflake adds a broker round trip and a WebRTC negotiation.
    lines.push(`CircuitBuildTimeout ${mode === 'meek' || mode === 'snowflake' ? 120 : 25}`);
    // Short keepalive so an idle HTTP-based transport does not have its bridge connection closed
    // between tor's own keepalive cells.
    lines.push('KeepalivePeriod 30');
    lines.push('ClientUseIPv4 1');
    // IPv6 IS MEASURED NOW, NOT ASSUMED.
    //
    // `ClientUseIPv6 1` was unconditional, and on a line whose IPv6 is advertised but does not
    // carry — which is most Iranian mobile and many DSL lines — every guard with a v6 ORPort
    // costs tor a full TCP timeout before it falls back to v4. That is paid during bootstrap,
    // where it is indistinguishable from a blocked transport, and again on every guard rotation.
    // `ipv6Works()` is one TCP connect to a known address, answered in well under a second, and
    // its result is remembered for the session.
    lines.push(`ClientUseIPv6 ${ipv6 ? 1 : 0}`);
    if (ipv6) lines.push('ClientPreferIPv6ORPort auto');

    // Tor-over-WARP, direct rung only. On a bridge rung this line makes tor reject its own
    // transport line and exit, so there the proxy is handed to the PT instead (TOR_PT_PROXY).
    if (upstreamProxy && proxyGoesInTorrc) lines.push(`Socks5Proxy ${upstreamProxy}`);

    // The exit preference, when the user picked a country.
    //
    // The GeoIP path and the country line go in together or neither does. Tor cannot resolve
    // {cc} to relays without the database: the candidate set comes out empty and bootstrap stalls
    // at 45-50% for ever, which is exactly how the Android build broke in 1.4.3. So if the
    // database is missing, the preference is dropped and the connection is allowed to succeed
    // without it — a wrong country beats no tunnel.
    //
    // `StrictNodes 0` deliberately: this is a preference tor abandons when it cannot build a
    // circuit in that country. With `StrictNodes 1`, a country whose handful of exits are busy
    // becomes "no connection at all" — measured on Android, {gr} sat at 45% for 42 minutes.
    // THE DATABASE GOES IN WHETHER OR NOT A COUNTRY WAS CHOSEN.
    //
    // It used to be written only alongside an `ExitNodes {cc}` line, which made the country a
    // start-time decision: `GeoIPFile` is read once when tor starts and cannot be set afterwards,
    // so a user who had connected on «خودکار» and then wanted Germany had to pay a whole new
    // bootstrap for it. With the database always loaded, `SETCONF ExitNodes={de}` over the
    // control port takes effect on the next circuit — seconds instead of minutes — and
    // `GETINFO ip-to-country/<ip>` can name the country a relay is in, which is what the live
    // circuit view is built from.
    const haveGeoip = fs.existsSync(p.geoip) && fs.existsSync(p.geoip6);
    if (haveGeoip) {
        lines.push(`GeoIPFile ${p.geoip}`);
        lines.push(`GeoIPv6File ${p.geoip6}`);
    }
    const cc = (region || 'auto').trim().toLowerCase();
    if (cc && cc !== 'auto' && haveGeoip) {
        lines.push(`ExitNodes {${cc}}`);
        lines.push('StrictNodes 0');
    }

    if (transport && bridges.length) {
        lines.push('UseBridges 1');
        const listener = ptMethods[transport];
        if (listener) lines.push(`ClientTransportPlugin ${transport} socks5 ${listener}`);
        bridges.forEach(b => lines.push(`Bridge ${b}`));
    }

    const file = path.join(dataDir, 'torrc');
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return file;
}

// ============================================================
// lyrebird, as a managed pluggable transport
// ============================================================

/**
 * Launch lyrebird and learn the port it listens on.
 *
 * The environment variables are the PT spec's client-side contract. Three are worth calling out:
 *
 *  - `TOR_PT_EXIT_ON_STDIN_CLOSE=1` makes lyrebird exit when we do. Without it, killing the app
 *    can leave an orphan PT holding its listener and the next connect cannot bind.
 *  - `TOR_PT_STATE_LOCATION` must end in a separator; lyrebird writes its obfs4 bridge state there.
 *  - `TOR_PT_PROXY` is the ONLY way a bridge rung can join an outer tunnel. With `UseBridges 1`
 *    it is the PT, not tor, that makes the real outbound connection — and putting `Socks5Proxy`
 *    in the torrc instead makes tor refuse to start. Measured on Android: with the variable set,
 *    all 75 of meek's CDN dials crossed the proxy and tor bootstrapped in 36s; without it, 0
 *    crossed.
 *
 * Resolves true only when the transport actually registered a listener. A live process that
 * registered nothing is a failure: it would leave tor with a `ClientTransportPlugin` line
 * pointing nowhere.
 */
/**
 * The executable that speaks a given transport, and the arguments it needs.
 *
 * lyrebird serves obfs4, meek_lite, snowflake and webtunnel from one binary. Conjure is a separate
 * program with a required flag: the registration station it talks to. That station is reachable from
 * here directly (measured: 200 in 6.4 s); it is also frontable, which is what the `front=` on a
 * conjure bridge line is for.
 */
function ptBinFor(transport) {
    const p = binPaths();
    if (transport === 'conjure') {
        return { bin: p.conjure, args: ['-registerURL', CONJURE_REGISTRAR] };
    }
    return { bin: p.pt, args: [] };
}

function startPt(dataDir, transport, onLog) {
    return new Promise(resolve => {
        ptMethods = {};
        const { bin, args: ptArgs } = ptBinFor(transport);
        if (!fs.existsSync(bin)) {
            record(`فایل ترابری در ${bin} نیست`, onLog);
            return resolve(false);
        }
        const stateDir = path.join(dataDir, 'pt_state');
        if (!fs.existsSync(stateDir)) fs.mkdirSync(stateDir, { recursive: true });

        const env = Object.assign({}, process.env, {
            TOR_PT_MANAGED_TRANSPORT_VER: '1',
            TOR_PT_CLIENT_TRANSPORTS: transport,
            TOR_PT_STATE_LOCATION: stateDir + path.sep,
            TOR_PT_EXIT_ON_STDIN_CLOSE: '1',
            HOME: dataDir,
        });
        if (upstreamProxy) env.TOR_PT_PROXY = `socks5://${upstreamProxy}`;

        let proc;
        try {
            proc = spawn(bin, ptArgs, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        } catch (e) {
            record(`اجرای ترابری ممکن نشد: ${e.message}`, onLog);
            return resolve(false);
        }
        ptProc = proc;

        let settled = false;
        const finish = ok => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!ok || !ptMethods[transport]) {
                record(`ترابری ${transport} هیچ پورتی اعلام نکرد`, onLog);
                stopPt();
                return resolve(false);
            }
            resolve(true);
        };

        const timer = setTimeout(() => finish(true), PT_HANDSHAKE_TIMEOUT_MS);

        let buf = '';
        proc.stdout.on('data', chunk => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                // The one thing conjure says that a user needs to hear. Buried in a log nobody opens
                // it looks like the app is hanging; said out loud it is somebody else's queue.
                if (/station is under high load/i.test(line)) {
                    record('ایستگاه ثبت‌نام Conjure شلوغ است و ثبت‌نام را رد می‌کند — روش دیگری را امتحان کنید.', onLog);
                }
                if (line.startsWith('CMETHOD ')) {
                    // CMETHOD <transport> socks5 <host:port>
                    const parts = line.split(/\s+/);
                    if (parts.length >= 4) {
                        ptMethods[parts[1]] = parts[3];
                        record(`ترابری ${parts[1]} روی ${parts[3]}`, onLog);
                    }
                } else if (line === 'CMETHODS DONE') {
                    finish(true);
                } else if (/^(CMETHOD-ERROR|ENV-ERROR|VERSION-ERROR) /.test(line)) {
                    record(`خطای ترابری: ${line}`, onLog);
                    finish(false);
                }
            }
        });
        // Drained so a full pipe cannot block the process, and otherwise dropped: lyrebird's
        // stderr is its own diagnostics and tor's log already names what failed.
        proc.stderr.on('data', () => { });
        proc.on('error', () => finish(false));
        proc.on('exit', () => { if (!settled) finish(false); });
    });
}

function stopPt() {
    if (ptProc) {
        // Closing stdin is the documented way to ask a managed PT to exit; kill() is the
        // fallback for one that ignores it.
        try { ptProc.stdin.end(); } catch (e) { /* already gone */ }
        try { ptProc.kill(); } catch (e) { /* already gone */ }
    }
    ptProc = null;
    ptMethods = {};
}

// ============================================================
// One attempt
// ============================================================

function killTor() {
    if (torProc) {
        try { torProc.kill(); } catch (e) { /* already gone */ }
    }
    torProc = null;
}

/**
 * Start tor once, on one mode, and wait for a full bootstrap.
 *
 * Resolves true only at `Bootstrapped 100%`. Anything less is a failure the caller escalates
 * from — which is the point: a rung that reached 50% and stopped moving is a rung that cannot
 * finish, and the next transport deserves the remaining time.
 */
async function attempt(mode, ceilingMs, region, onLog, onStatus, stallMs) {
    const dataDir = ensureDataDir();
    const transport = transportFor(mode);

    if (transport) {
        const ok = await startPt(dataDir, transport, onLog);
        if (!ok) return false;
    }

    // Written AFTER the PT is up, because the torrc has to name the port lyrebird chose.
    const torrc = writeTorrc(dataDir, mode, region, await ipv6Works());

    return await new Promise(resolve => {
        let proc;
        try {
            proc = spawn(binPaths().tor, ['-f', torrc], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            record(`اجرای tor ممکن نشد: ${e.message}`, onLog);
            stopPt();
            return resolve(false);
        }
        torProc = proc;
        // A new run's tail starts empty, or a later diagnosis reads the previous rung's output.
        runTail = '';

        let percent = 0;
        let lastLogged = -1;
        state.bootBytes = 0;
        reached50 = false;
        let lastMovedAt = Date.now();
        const startedAt = Date.now();
        let settled = false;
        const tail = [];   // the last lines, replayed only when the rung fails

        const done = ok => {
            if (settled) return;
            settled = true;
            clearInterval(watch);
            if (!ok) {
                // The reason a rung failed is in these lines and nowhere else.
                tail.slice(-12).forEach(l => record(`  ${l}`, onLog));
                killTor();
                stopPt();
                resolve(ok);
                return;
            }
            // BOOTSTRAP IS OVER — STOP READING TOR LINE BY LINE.
            //
            // `Log info` is deliberate (see writeTorrc: at `notice` a tor that dies at 0% says
            // nothing about why), but the handler above is not free: it concatenates, splits,
            // trims, pushes into a ring and runs a regex PER LINE, forever, in Electron's main
            // thread — and once this tunnel is carrying the whole machine, tor logs every stream
            // and every circuit. That is the same cost that was just taken out of sing-box and
            // Xray, paid a third time, on the thread whose stalls are what make the guards
            // declare a healthy engine dead (see server.js › v2rayTunStartGuard).
            //
            // After bootstrap the lines are only ever post-mortem material, so the pipe is
            // drained into a rolling window of raw text: one concat and one slice per chunk, no
            // per-line work at all. `torTail()` hands it back if anything later needs it.
            proc.stdout.removeListener('data', onChunk);
            proc.stderr.removeListener('data', onChunk);
            const drain = (chunk) => {
                runTail = (runTail + chunk.toString('utf8')).slice(-RUN_TAIL_BYTES);
            };
            proc.stdout.on('data', drain);
            proc.stderr.on('data', drain);
            resolve(ok);
        };

        let buf = '';
        const onChunk = chunk => {
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                tail.push(line);
                if (tail.length > 40) tail.shift();

                // The phase tag comes with the percentage and was being thrown away. It is the
                // difference between «۴۵٪» and «۴۵٪ — در حال گرفتن مشخصات رله‌ها» during the one
                // stretch of a cold bootstrap that lasts minutes and looks like a hang. Tor's own
                // line is `Bootstrapped 45% (requesting_descriptors): Asking for relay descriptors`.
                const m = /Bootstrapped (\d+)%(?: \(([a-z_]+)\))?(?:: (.+))?/.exec(line);
                if (m) {
                    const p = parseInt(m[1], 10) || 0;
                    if (p > percent) lastMovedAt = Date.now();
                    percent = p;
                    if (p >= 50) reached50 = true;
                    state.percent = p;
                    state.phase = PHASE_FA[m[2]] || '';
                    state.stage = 'bootstrapping';
                    state.detail = `${labelFor(mode)} — ${p}%`;
                    if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
                    if (Math.floor(p / LOG_EVERY_PERCENT) > Math.floor(lastLogged / LOG_EVERY_PERCENT)) {
                        lastLogged = p;
                        record(`${labelFor(mode)}: ${p}٪`, onLog);
                    }
                    if (p >= 100) done(true);
                }
            }
        };
        proc.stdout.on('data', onChunk);
        proc.stderr.on('data', onChunk);
        proc.on('error', e => { record(`tor: ${e.message}`, onLog); done(false); });
        proc.on('exit', code => {
            if (!settled) {
                record(`${labelFor(mode)}: tor با کد ${code} بیرون آمد (در ${percent}٪)`, onLog);
                done(false);
            }
        });

        // A PERCENTAGE IS NOT THE ONLY EVIDENCE OF PROGRESS, and between 50% and 60% it is the
        // wrong one. Measured on a machine with nothing cached: 340 seconds with the number frozen
        // while the relay descriptors came down — against a ceiling of 420. A quarter of a margin
        // on the one connect that decides whether a user thinks تور works at all.
        //
        // Tor's control port knows the truth: `traffic/read` counts the bytes it has received. So
        // arriving data counts as movement, exactly like a percentage does, and a phase that is
        // genuinely working can take as long as it needs while a phase that is genuinely blocked
        // is still cut off in ninety seconds.
        let bootCtrl = null;
        let lastBytes = 0;
        let byteCheck = 0;
        control().then((c) => { bootCtrl = c; }).catch(() => { /* fall back to percentages alone */ });

        // Checked in slices so a stall is noticed while it is happening, rather than at a deadline.
        const watch = setInterval(() => {
            if (settled) return;
            if (cancelled) { record('لغو شد', onLog); return done(false); }
            const now = Date.now();
            // Two windows, because the two phases fail differently — see the constants.
            const window = stallMs || (percent >= 50 ? STALL_AT_50_MS : STALL_BELOW_50_MS);
            // Every five seconds, not every tick: one control round trip per stall window would
            // be enough, and this is already twenty times more often than that.
            if (bootCtrl && now - byteCheck > 5000) {
                byteCheck = now;
                bootCtrl.getInfo('traffic/read').then((r) => {
                    const got = +r['traffic/read'] || 0;
                    // AND SHOWN, not just counted. Measured on a machine with nothing cached, the
                    // percentage reads 50 for five straight minutes while 22 MB of descriptors
                    // come down at a steady 400 KB every six seconds. A progress bar that does not
                    // move for five minutes is how a working connect gets cancelled by the user;
                    // a megabyte counter that climbs is the same wait, legible.
                    state.bootBytes = got;
                    // 16 KB, so that keepalives and a trickle of failed retries do not read as
                    // progress. A descriptor batch is orders of magnitude more than this.
                    if (got - lastBytes > 16384) { lastBytes = got; lastMovedAt = Date.now(); }
                }).catch(() => { bootCtrl = null; });
            }
            if (now - lastMovedAt > window) {
                record(`${labelFor(mode)}: ${Math.round(window / 1000)} ثانیه روی ${percent}٪ بی‌حرکت ماند`, onLog);
                return done(false);
            }
            if (now - startedAt > ceilingMs) {
                record(`${labelFor(mode)}: سقف زمانی تمام شد (${percent}٪)`, onLog);
                return done(false);
            }
        }, 250);
    });
}

// ============================================================
// The ladder
// ============================================================

/** Where the rung that last worked on this machine is remembered. */
function memoryFile() { return path.join(ensureDataDir(), 'last-good.json'); }

function rememberMode(mode) {
    try { fs.writeFileSync(memoryFile(), JSON.stringify({ mode, at: Date.now() }), 'utf8'); }
    catch (e) { /* the next connect just starts from the top */ }
}

function rememberedMode() {
    try { return (JSON.parse(fs.readFileSync(memoryFile(), 'utf8')) || {}).mode || null; }
    catch (e) { return null; }
}

/**
 * Bring Tor up.
 *
 * @param opts.mode      one of MODES' keys; 'auto' walks the ladder
 * @param opts.region    exit-country preference, or 'auto'
 * @param opts.proxy     "host:port" of an outer SOCKS5 to run inside (Tor-over-WARP)
 */
async function startTor(opts, onLog, onStatus) {
    if (state.running) return { ok: true, socks: `127.0.0.1:${SOCKS_PORT}`, mode: state.mode };
    if (!isInstalled()) throw new Error('فایل‌های تور در core/tor موجود نیست.');

    // The line may not be the one the last connect measured — a laptop moves between networks.
    forgetIpv6();

    const o = opts || {};
    const requested = (o.mode || 'auto').trim();
    const region = (o.region || 'auto').trim();
    upstreamProxy = o.proxy || null;
    cancelled = false;
    logs = [];

    state.running = true;
    state.connected = false;
    state.requested = requested;
    state.region = region;
    state.mode = null;
    state.percent = 0;
    state.stage = 'starting';
    state.detail = '';
    state.error = null;
    state.since = null;
    if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }

    // A pinned mode is one attempt, not a ladder: the user who pins has already decided, and
    // walking past their choice would make the setting a suggestion.
    let rungs;
    if (requested !== 'auto') {
        rungs = [{ mode: requested, timeout: transportFor(requested) ? BRIDGE_TIMEOUT_MS : DIRECT_TIMEOUT_MS }];
    } else {
        rungs = LADDER.slice();
        // START WHERE IT WORKED LAST TIME. A machine whose network needs Meek should not pay
        // Direct's 150-second ceiling on every single connect, for ever. The rung moves to the
        // front rather than replacing the ladder, so if the network changed the rest still run.
        const last = rememberedMode();
        if (last) {
            const i = rungs.findIndex(r => r.mode === last);
            if (i > 0) rungs.unshift(rungs.splice(i, 1)[0]);
        }
        // Tor-over-WARP may only try Direct and Meek, and the reason is the absence of evidence
        // rather than evidence of harm. Measured through a real SOCKS5 upstream on Android:
        // Direct reached 100% in 12–15s and meek_lite in 36s with all 75 CDN dials crossing the
        // proxy — while obfs4 landed on 10% and 85% across two runs of the SAME bridge with no
        // proxy at all. Putting a rung that unpredictable inside a tunnel that costs its own
        // handshake means a failure cannot be attributed to either layer. Snowflake has a broker
        // and WebRTC dials a SOCKS5 CONNECT cannot carry. Both stay fully available unchained.
        if (upstreamProxy) rungs = rungs.filter(r => r.mode === 'direct' || r.mode === 'meek');
    }

    record(`شروع — ${requested === 'auto' ? 'خودکار' : labelFor(requested)}${upstreamProxy ? ' (داخل وارپ)' : ''}`, onLog);

    // SAY SO BEFORE IT HAPPENS, not afterwards. A connect that takes minutes with no explanation
    // reads as a broken app; the same minutes with «فهرست رله‌ها باید دانلود شود» reads as a
    // download, and the user knows the next one will be seconds.
    //
    // AND ONLY FOR THE CASE THAT WAS MEASURED. An earlier version also warned whenever the
    // consensus was merely stale, which sounded reasonable and was wrong: a 37-hour-old directory
    // connected in 17 seconds. A warning that fires on a fast connect teaches the user to ignore
    // the one that matters.
    if (!consensusState().have) {
        record('اولین اتصال روی این دستگاه — فهرست رله‌های تور باید یک بار دانلود شود و چند دقیقه طول می‌کشد. از دفعهٔ بعد چند ثانیه است.', onLog);
    }

    for (const rung of rungs) {
        if (cancelled) break;
        state.mode = rung.mode;
        state.percent = 0;
        state.stage = 'bootstrapping';
        state.detail = labelFor(rung.mode);
        if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
        record(`امتحان ${labelFor(rung.mode)}…`, onLog);

        const ok = await attempt(rung.mode, o.ceilingMs || rung.timeout, region, onLog, onStatus, o.stallMs);
        if (!ok && reached50 && rungs.length > 1) {
            // THE FIRST RUNG THAT REACHES 50% OWNS THE ATTEMPT.
            //
            // Reaching 50% proves the transport carried a TLS handshake, the consensus and the
            // authority certificates — so a failure after it is the line's bandwidth, not the
            // transport, and the next rung would pay the same seven-minute descriptor wait to
            // learn the same thing. Measured on this line, ALL FOUR rungs reach 50%: without this
            // rule a bad night costs four times seven minutes and still ends in the same answer.
            //
            // The honest report matters more than another attempt here: "the transport works, the
            // line is too slow right now" tells the user to wait or pick a faster network, while
            // "no method connected" sends them looking for a broken setting.
            record('این روش داده رد کرد ولی دانلود فهرست رله‌ها تمام نشد — خط در این لحظه کند است. بقیهٔ روش‌ها همین انتظار را دوباره می‌دهند، پس اینجا متوقف می‌شویم.', onLog);
            break;
        }
        if (ok) {
            state.connected = true;
            state.stage = 'connected';
            state.percent = 100;
            state.detail = labelFor(rung.mode);
            state.since = Date.now();
            rememberMode(rung.mode);
            record(`وصل شد با ${labelFor(rung.mode)} — SOCKS روی 127.0.0.1:${SOCKS_PORT}`, onLog);
            // The control port, and the watchdog that reads it. Failing to open it costs the
            // extra features and nothing else, so it must never take a working tunnel down with
            // it — hence the catch.
            control().then((c) => { if (c) watchStart({ onLog }); })
                .catch((e) => record(`درگاه کنترل باز نشد: ${e.message}`, onLog));
            if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
            return { ok: true, socks: `127.0.0.1:${SOCKS_PORT}`, mode: rung.mode, pid: torProc ? torProc.pid : null };
        }
    }

    state.running = false;
    state.connected = false;
    state.stage = 'failed';
    state.mode = null;
    state.error = cancelled ? 'لغو شد' : 'هیچ‌کدام از روش‌ها وصل نشد';
    if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
    throw new Error(state.error);
}

function stopTor() {
    const was = state.running;
    cancelled = true;
    watchStop();
    closeControl();
    relayInfo.clear();
    killTor();
    stopPt();
    upstreamProxy = null;
    state.running = false;
    state.connected = false;
    state.stage = 'idle';
    state.percent = 0;
    state.detail = '';
    state.mode = null;
    state.since = null;
    state.traffic = null;
    state.circuits = null;
    state.rateDown = 0;
    state.rateUp = 0;
    return was;
}

function isRunning() { return state.running && !!torProc; }

function getStatus() {
    return {
        running: state.running,
        connected: state.connected,
        mode: state.mode,
        requested: state.requested,
        percent: state.percent,
        phase: state.phase,
        bootBytes: state.bootBytes,
        stage: state.stage,
        detail: state.detail,
        region: state.region,
        since: state.since,
        error: state.error,
        socksPort: SOCKS_PORT,
        httpPort: HTTP_PORT,
        dnsPort: DNS_PORT,
        controlPort: CONTROL_PORT,
        lastGood: rememberedMode(),
        traffic: state.traffic,
        circuits: state.circuits,
        rateDown: state.rateDown,
        rateUp: state.rateUp,
        consensus: consensusState(),
        bridges: (() => { const b = readCustomBridges(); const n = Object.values(b).reduce((s, v) => s + (v || []).length, 0); return { custom: n, groups: Object.keys(b).filter(k => (b[k] || []).length) }; })(),
        path: lastPath ? { at: lastPath.at, ms: lastPath.ms, target: lastPath.target, draws: lastPath.draws.length, current: lastPath.current, best: lastPath.best, keptBest: lastPath.keptBest } : null,
        measuring: pathBusy,
    };
}

function getLogs() { return logs.slice(); }

/**
 * Does the SOCKS port actually carry a stream?
 *
 * `Bootstrapped 100%` is tor's own claim about its circuits, and the tunnel is built on top of
 * this port — so the same rule the rest of the app follows applies here: prove the data path
 * before reporting success. A CONNECT to a well-known address through the proxy is the cheapest
 * proof that costs no exit bandwidth.
 */
function socksCarriesStream(timeoutMs = 12000) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        let stage = 0;
        const fail = () => { try { sock.destroy(); } catch (e) { /* gone */ } resolve(false); };
        sock.setTimeout(timeoutMs, fail);
        sock.on('error', fail);
        sock.connect(SOCKS_PORT, '127.0.0.1', () => {
            sock.write(Buffer.from([0x05, 0x01, 0x00]));
        });
        sock.on('data', data => {
            if (stage === 0) {
                if (data[0] !== 0x05 || data[1] !== 0x00) return fail();
                stage = 1;
                // CONNECT to one.one.one.one:80 by name, so the request also proves that tor's
                // own name resolution is answering — which is what the DNS path depends on.
                const host = Buffer.from('one.one.one.one', 'utf8');
                const req = Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x00, 0x50]),
                ]);
                sock.write(req);
                return;
            }
            try { sock.destroy(); } catch (e) { /* gone */ }
            resolve(data[0] === 0x05 && data[1] === 0x00);
        });
    });
}

// ============================================================
// The control port: what tor can be asked, and told, while it runs
// ============================================================

const { TorControl, parseCircuits, parseStreams, parseNs } = require('./tor-control');

// The same target the rest of the app measures against, so a Tor figure and a سایفون figure are
// produced against the same server and can honestly sit next to each other.
const PROBE_HOST = 'speed.cloudflare.com';
const PROBE_PORT = 80;

let ctrl = null;
let ctrlOpening = null;

/** The live control connection, opened on demand. Null when tor is not up. */
async function control() {
    if (ctrl && ctrl.ready) return ctrl;
    if (!torProc) return null;
    if (ctrlOpening) return ctrlOpening;
    const c = new TorControl();
    ctrlOpening = c.open(CONTROL_PORT, path.join(TOR_DATA_DIR, 'control_auth_cookie'))
        .then(() => { ctrl = c; ctrlOpening = null; return c; })
        .catch((e) => { ctrlOpening = null; ctrl = null; throw e; });
    return ctrlOpening;
}

function closeControl() {
    if (ctrl) { try { ctrl.close(); } catch (e) { /* gone */ } }
    ctrl = null;
    ctrlOpening = null;
}

// --- the country of a relay, cached ------------------------------------------------
//
// Two round trips per relay (`ns/id` for the address, `ip-to-country` for the country) and the
// answer never changes for the life of a connection, so it is remembered. Without the cache the
// circuit view would pay four lookups every time it refreshed.
const relayInfo = new Map();

async function describeRelay(c, fp) {
    if (relayInfo.has(fp)) return relayInfo.get(fp);
    const out = { fp, nick: '', ip: '', country: '' };
    try {
        const ns = parseNs((await c.getInfo(`ns/id/$${fp}`))[`ns/id/$${fp}`]);
        if (ns) { out.nick = ns.nick; out.ip = ns.ip; }
        if (out.ip) {
            const k = `ip-to-country/${out.ip}`;
            const cc = (await c.getInfo(k))[k];
            if (cc && cc !== '??') out.country = cc.toUpperCase();
        }
    } catch (e) { /* a relay that left the consensus has no answer; the fingerprint is enough */ }
    relayInfo.set(fp, out);
    return out;
}

/**
 * What tor is doing right now: the live path, the byte counters, and whether any circuit is up.
 *
 * `circuit-established` is the one that matters for «قطع و وصل». The SOCKS port answers whether or
 * not tor has a usable circuit, so a port check cannot tell a working tunnel from one whose every
 * path has collapsed — this can, and it is what the watchdog below acts on.
 */
async function liveInfo({ withPath = true } = {}) {
    const c = await control().catch(() => null);
    if (!c) return null;
    const info = await c.getInfo(
        'status/circuit-established', 'circuit-status', 'traffic/read', 'traffic/written',
    ).catch(() => null);
    if (!info) return null;

    const circuits = parseCircuits(info['circuit-status']);
    const built = circuits.filter((x) => x.status === 'BUILT');
    // The circuit the user's traffic is actually on: a general-purpose one, newest first, since
    // tor rotates and the freshest BUILT general circuit is the one new streams attach to.
    const general = built.filter((x) => (x.flags.PURPOSE || 'GENERAL') === 'GENERAL');
    const pick = general[general.length - 1] || built[built.length - 1] || null;

    let path = [];
    if (withPath && pick && pick.path.length) {
        path = await Promise.all(pick.path.map(async (h) => {
            const d = await describeRelay(c, h.fp);
            return { fp: h.fp, nick: h.nick || d.nick, country: d.country, ip: d.ip };
        }));
    }
    return {
        established: info['status/circuit-established'] === '1',
        circuits: circuits.length,
        built: built.length,
        building: circuits.length - built.length,
        read: +info['traffic/read'] || 0,
        written: +info['traffic/written'] || 0,
        path,
        exit: path.length ? path[path.length - 1] : null,
    };
}

/**
 * A new path, without a new bootstrap.
 *
 * Tor's speed is very largely the luck of which relays a circuit was built through, and the only
 * remedy a Tor Browser user has ever had is to ask for a different draw. `NEWNYM` is that button:
 * existing circuits are marked unusable for new streams and the next request builds a fresh path.
 * Tor rate-limits it to one every ten seconds internally, so a user leaning on it cannot hurt
 * anything.
 */
async function newIdentity() {
    const c = await control();
    if (!c) throw new Error('تور در حال اجرا نیست.');
    await c.signal('NEWNYM');
    relayInfo.clear();
    return true;
}

/**
 * Change the exit country on a running tor.
 *
 * This used to cost a full restart — stop the engine, write a new torrc, bootstrap again, several
 * minutes on a cold cache — because `GeoIPFile` is only read at startup and the country line was
 * only written when a country had been chosen. With the database always loaded (see [writeTorrc])
 * the change is two control commands and the next circuit honours it.
 *
 * `StrictNodes 0` stays: the country is a preference tor abandons rather than a wall it refuses to
 * climb. A country whose handful of exits are all busy must degrade to "somewhere else" and not to
 * "no connection" — measured on Android, `{gr}` with StrictNodes 1 sat at 45% for 42 minutes.
 */
async function setExitCountry(cc) {
    const c = await control();
    if (!c) throw new Error('تور در حال اجرا نیست.');
    const code = String(cc || 'auto').trim().toLowerCase();
    if (!code || code === 'auto') {
        await c.setConf({ ExitNodes: '', StrictNodes: '0' });
    } else {
        await c.setConf({ ExitNodes: `{${code}}`, StrictNodes: '0' });
    }
    state.region = code || 'auto';
    await c.signal('NEWNYM');
    relayInfo.clear();
    return state.region;
}

// ============================================================
// Drawing a better path
// ============================================================

/**
 * «بهبود مسیر» — measure the path the user is actually on, and draw again while it is bad.
 *
 * ## What was tried first, and why it is not here
 *
 * The obvious feature was the one every other engine in this app has: race the candidates, keep
 * the fastest. Tor even makes it easy — `IsolateSOCKSAuth` means N probes under N usernames get N
 * independent circuits, `circuit-status` names the exit each one used, and `SETCONF ExitNodes`
 * pins the winners. It was built, and it was measured against itself three times in a row,
 * alternating so that line drift could not explain the result:
 *
 * ```
 *                 single stream      four streams
 *   unpinned        7.33 Mbit/s       5.96 Mbit/s
 *   pinned          3.21 Mbit/s       2.19 Mbit/s
 * ```
 *
 * Pinning the three fastest exits made Tor **two and a half times slower**, on both measures, in
 * every round. Two reasons, and both are worth keeping written down:
 *
 *  1. Tor already weights its path selection by relay bandwidth across some two thousand exits.
 *     Narrowing that to three does not select quality, it concentrates load — every circuit the
 *     machine builds then queues behind the same three relays.
 *  2. The measurement the pin was built on was not measuring what it claimed. A brand-new Tor
 *     circuit begins in slow start, so a few hundred kilobytes through a freshly built probe
 *     circuit reads its ramp-up, not its capacity. Settled circuits in the same minute measured
 *     9.6 and 10.4 Mbit/s while the "fastest" probe read 3.9.
 *
 * And the exit is not the variable anyway. Two consecutive draws landed on the SAME exit relay —
 * `F3Netze` — and measured 4.57 and 2.33 Mbit/s, with time-to-first-byte of 557 ms and 4180 ms.
 * What varies is the whole circuit and the load on it at that moment, which no list of favourites
 * can predict.
 *
 * ## What is here instead
 *
 * The one lever the measurements do support: the draw itself. Settled paths on this line ranged
 * from 0.99 to 10.4 Mbit/s with nothing chosen differently between them — so a slow Tor is very
 * often one bad draw away from a fast one, and `NEWNYM` is free. So: measure the real path, and
 * if it is poor, ask for another and measure that. No constraint on tor's own choice, nothing
 * pinned, and every number in the report is a settled path rather than a ramp-up.
 *
 * It stops at the first draw that clears the bar, which means the common case — a path that is
 * already fine — costs one short measurement and changes nothing.
 */

/**
 * The bar, in megabits, for "this path is fine, leave it alone".
 *
 * Measured across nine consecutive settled draws on this line, one stream each:
 *
 *     0   0.27   1.14   3.12   3.88   5.41   6.13   7.58   9.24        median 3.88
 *
 * Nothing was chosen differently between any of them. One draw carried nothing at all, two more
 * were under a megabit, and the best carried nine — which is the whole case for re-drawing. The
 * bar sits below the median on purpose: high enough to reject the bottom third, low enough that a
 * line which genuinely cannot do better is not made to chase itself for ever.
 */
const GOOD_MBIT = 2.5;

/**
 * The floor between two NEWNYM signals — a floor, not a sleep.
 *
 * Tor coalesces signals inside a ten-second window, so two draws closer together than that would
 * measure the same circuit twice and report it as two independent draws. But the measurement
 * itself already takes about six seconds, and sleeping the full eleven on top of it wasted
 * twenty-two seconds of a forty-nine-second run. Only the remainder is waited for.
 */
const NEWNYM_SPACING_MS = 10_500;

/**
 * ONE STREAM, NOT SEVERAL — and for Tor that is the right shape, unlike every other engine here.
 *
 * سایفون and گف are measured with six parallel streams because their per-connection ceiling is
 * far below what the line can carry, so one stream badly understates ordinary browsing. Tor is
 * the opposite: every stream in one isolation group is multiplexed onto ONE circuit, so parallel
 * streams contend with each other instead of adding up. Measured over nine draws, four streams
 * read at or below a single stream on the same circuit in half of them — 1.87 against 7.58 in the
 * worst case, purely from contention.
 *
 * The warm-up is not politeness, it is correctness: a brand-new Tor circuit begins in slow start,
 * so the first few hundred kilobytes read its ramp-up rather than its capacity.
 */
async function measureLivePath({ bytes = 1_200_000, windowMs = 6000 } = {}) {
    const diag = require('./tun-diag');
    await diag.throughSocks(SOCKS_PORT, 64_000, 12_000);       // settle the circuit
    const one = await diag.throughSocks(SOCKS_PORT, bytes, windowMs);
    const via = await pathOfLiveGroup().catch(() => null);
    return {
        mbit: one.kbps ? +((one.kbps * 8 / 1024).toFixed(2)) : 0,
        ok: !!one.ok,
        ttfbMs: one.ttfbMs || 0,
        bytes: one.bytes || 0,
        exit: via && via.length ? via[via.length - 1] : null,
        path: via || [],
    };
}

/**
 * The circuit the user's own traffic is on, identified rather than guessed.
 *
 * `liveInfo` picks the newest BUILT general-purpose circuit, which is a reasonable guess and was
 * wrong often enough to matter: tor pre-builds circuits, so the newest one is frequently a spare
 * that nothing is attached to. Measured that way, five consecutive draws reported the same exit
 * relay while their throughput ranged from 0 to 9.24 Mbit/s — the attribution, not the network,
 * was constant.
 *
 * So the circuit is asked for by holding a real connection open: a SOCKS stream to the probe host
 * with nothing sent down it, whose circuit id is then looked up in `circuit-status` for the path.
 * It costs one connection and no data.
 *
 * THE STREAM IS IDENTIFIED BY ITS EVENT, not by its target. The obvious way — read `stream-status`
 * and find the row whose target is the probe host — silently never matches, because by the time a
 * stream is SUCCEEDED tor has rewritten its target to the address the exit resolved:
 *
 *     12 SUCCEEDED 9 162.159.140.220:80          <- not «speed.cloudflare.com:80»
 *
 * The `STREAM … NEW` event still carries the name that was asked for, so subscribing for the
 * length of this one call gives an exact id with no guessing between our stream and the user's.
 */
async function pathOfLiveGroup() {
    const c = await control();
    if (!c) return null;

    let streamId = null;
    const onEv = (name, rest) => {
        if (name !== 'STREAM') return;
        const p = rest.split(' ');                 // <id> <status> <circId> <target>
        if (p[3] && p[3].indexOf(PROBE_HOST) === 0) streamId = p[0];
    };
    c.onEvent(onEv);
    await c.setEvents('STREAM').catch(() => { /* fall back to the newest general circuit */ });

    const sock = await new Promise((resolve, reject) => {
        const s = new net.Socket();
        let step = 0, settled = false;
        const fail = (m) => { if (settled) return; settled = true; clearTimeout(tm); try { s.destroy(); } catch (e) { /* gone */ } reject(new Error(m)); };
        const tm = setTimeout(() => fail('timeout'), 20_000);
        s.on('error', (e) => fail(e.message));
        s.on('data', (b) => {
            if (step === 0) {
                if (b[0] !== 0x05 || b[1] !== 0x00) return fail('greeting refused');
                step = 1;
                const h = Buffer.from(PROBE_HOST, 'ascii');
                s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([PROBE_PORT >> 8, PROBE_PORT & 0xff])]));
                return;
            }
            if (b[0] !== 0x05 || b[1] !== 0x00) return fail('connect refused');
            settled = true; clearTimeout(tm); resolve(s);
        });
        s.connect(SOCKS_PORT, '127.0.0.1', () => s.write(Buffer.from([0x05, 0x01, 0x00])));
    });
    try {
        const info = await c.getInfo('stream-status', 'circuit-status');
        const streams = parseStreams(info['stream-status']);
        const circuits = parseCircuits(info['circuit-status']);
        const mine = streamId ? streams.find((x) => x.id === streamId) : null;
        // Without the event — an older tor, or a SETEVENTS that was refused — fall back to the
        // newest BUILT general circuit, which is what `liveInfo` uses. Less exact, never wrong
        // enough to matter: it is still a circuit this machine's traffic is on.
        const circ = (mine && circuits.find((x) => x.id === mine.circ))
            || circuits.filter((x) => x.status === 'BUILT' && (x.flags.PURPOSE || 'GENERAL') === 'GENERAL').pop();
        if (!circ || !circ.path.length) return null;
        return await Promise.all(circ.path.map(async (h) => {
            const d = await describeRelay(c, h.fp);
            return { fp: h.fp, nick: h.nick || d.nick, country: d.country, ip: d.ip };
        }));
    } finally {
        try { sock.destroy(); } catch (e) { /* gone */ }
        c.offEvent(onEv);
        // Events back off: nothing else in this app subscribes, and a STREAM event per connection
        // through a tunnel carrying the whole machine is exactly the per-line main-thread cost
        // that was taken out of sing-box, Xray and tor's own log reader.
        c.setEvents().catch(() => { /* the connection is gone; nothing to unsubscribe from */ });
    }
}

let pathBusy = false;
let lastPath = null;

async function improvePath({ rounds = 4, targetMbit = GOOD_MBIT, onProgress } = {}) {
    if (pathBusy) throw new Error('یک سنجش در جریان است.');
    if (!state.connected) throw new Error('اول تور را وصل کنید.');
    const c = await control();
    if (!c) throw new Error('درگاه کنترل تور باز نیست.');

    pathBusy = true;
    const startedAt = Date.now();
    const say = (o) => { if (typeof onProgress === 'function') { try { onProgress(o); } catch (e) { /* the UI is gone */ } } };
    const draws = [];
    // The connection has been up for a while by the time anyone presses the button, so the first
    // redraw owes nothing. Only a second one inside the same run has to respect the window.
    let lastNewnym = 0;

    try {
        for (let i = 0; i < rounds; i++) {
            say({ phase: 'measuring', draw: i + 1, rounds });
            const m = await measureLivePath();
            const row = {
                draw: i + 1,
                mbit: m.mbit,
                ok: m.ok,
                exit: m.exit ? { nick: m.exit.nick, country: m.exit.country, fp: m.exit.fp } : null,
                path: (m.path || []).map((h) => ({ nick: h.nick, country: h.country })),
                good: m.ok && m.mbit >= targetMbit,
            };
            draws.push(row);
            say({ phase: 'draw', row });
            if (row.good) break;
            if (i < rounds - 1) {
                say({ phase: 'redraw', draw: i + 1 });
                // Only the part of the window the measurement did not already spend — see
                // NEWNYM_SPACING_MS. The wait comes BEFORE the signal, so the time is paid while
                // the previous circuit is still carrying, not while nothing is happening.
                const owed = NEWNYM_SPACING_MS - (Date.now() - lastNewnym);
                if (owed > 0) await new Promise((r) => setTimeout(r, owed));
                await newIdentity();
                lastNewnym = Date.now();
            }
        }

        const best = draws.reduce((a, b) => (b.mbit > (a ? a.mbit : -1) ? b : a), null);
        const current = draws[draws.length - 1];
        lastPath = {
            at: Date.now(), ms: Date.now() - startedAt,
            target: targetMbit, draws,
            current, best,
            // The honest distinction. The loop can only END on a draw; it cannot go back to one.
            // So when the best draw was not the last, say so rather than reporting the best as if
            // the user had it.
            keptBest: !!(best && current && best.draw === current.draw),
        };
        say({ phase: 'done', summary: lastPath });
        return lastPath;
    } finally {
        pathBusy = false;
    }
}

function lastPathResult() { return lastPath; }

// ============================================================
// The stability watchdog
// ============================================================

/**
 * The gap `front-guard` cannot see.
 *
 * `front-guard` asks whether the SOCKS port answers, which is the right question for an engine
 * that dies. Tor does not die — it sits there with an open port and no usable circuit, and every
 * connection through it hangs. That is «وصل است ولی قطع و وصل می‌شود»: the engine is up, the
 * watchdog is happy, and nothing loads.
 *
 * So this one asks tor instead. Two consecutive polls with no established circuit is not a blip,
 * and the answer is a new draw rather than a restart, because a restart costs a bootstrap and the
 * circuits are what failed. Only when new draws keep failing does it stop trying and let
 * `front-guard` do the heavier thing.
 */
let watchTimer = null;
let watchMisses = 0;
let watchNewnyms = 0;
let lastTraffic = { read: 0, written: 0, at: 0 };

function watchStart({ tickMs = 20_000, onLog } = {}) {
    watchStop();
    watchMisses = 0;
    watchNewnyms = 0;
    const diary = (kind, fields, note) => {
        try { require('./tun-diag').event(kind, fields, note); } catch (e) { /* diary is advisory */ }
    };
    const tick = async () => {
        if (!state.connected || !torProc) return;
        const info = await liveInfo({ withPath: false }).catch(() => null);
        if (!info) return;                       // the control port is busy or gone; not a verdict

        const now = Date.now();
        if (lastTraffic.at) {
            const secs = Math.max(1, (now - lastTraffic.at) / 1000);
            state.rateDown = Math.max(0, (info.read - lastTraffic.read)) / secs;
            state.rateUp = Math.max(0, (info.written - lastTraffic.written)) / secs;
        }
        lastTraffic = { read: info.read, written: info.written, at: now };
        state.traffic = { read: info.read, written: info.written };
        state.circuits = { built: info.built, building: info.building };

        if (info.established) {
            if (watchMisses) diary('tor-back', { after: watchMisses }, 'circuits are established again');
            watchMisses = 0;
            watchNewnyms = 0;
            return;
        }
        watchMisses++;
        diary('tor-nocircuit', { misses: watchMisses, building: info.building }, 'socks port open, no established circuit');
        if (watchMisses >= 2 && watchNewnyms < 3) {
            watchNewnyms++;
            if (onLog) onLog(`[TOR] هیچ مداری برقرار نیست — مسیر تازه می‌گیریم (${watchNewnyms}/3)`);
            diary('tor-newnym', { attempt: watchNewnyms }, 'watchdog asked for a fresh path');
            await newIdentity().catch(() => { /* front-guard's restart is the fallback */ });
            watchMisses = 0;
        }
    };
    // ONE EARLY TICK, then the slow cadence. The panel's circuit count and byte counters come
    // from this and from nowhere else, so a plain interval left them blank for the first twenty
    // seconds of every connection — which is exactly the twenty seconds a user spends looking at
    // the panel after it goes green. Two seconds in, tor has circuits and something true to say.
    setTimeout(() => { tick().catch(() => { /* advisory */ }); }, 2000).unref?.();
    watchTimer = setInterval(() => { tick().catch(() => { /* advisory */ }); }, tickMs);
    if (watchTimer.unref) watchTimer.unref();
}

function watchStop() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
    lastTraffic = { read: 0, written: 0, at: 0 };
}

// ============================================================
// The directory cache, and why the first connect of the day is slow
// ============================================================

/**
 * How old tor's picture of the network is.
 *
 * ## The theory this was built on, and what measuring it showed
 *
 * Tor cannot build a circuit until it knows which relays exist, and that knowledge expires — so
 * the obvious explanation for «سرعت اتصال پایین» was a stale directory, and the obvious fix was a
 * background refresh that pays the download before the user asks for a connection. Both were
 * built. Then they were measured:
 *
 * ```
 *   consensus 37 HOURS past its validity, microdescriptors 8 days old   ->  17 s
 *   fresh consensus                                                     ->   7-10 s
 *   nothing cached at all (a first connect on a new machine)            ->   minutes
 * ```
 *
 * A stale directory costs about ten seconds, not minutes: tor keeps every microdescriptor it has
 * and only fetches what changed. So the refresh was removed — it would have spent a user's data
 * every few hours to save them ten seconds, which on a metered Iranian line is a bad trade made
 * on an untested assumption.
 *
 * The one case that IS slow is the first connect on a machine with no cache, and no amount of
 * warming helps there: the same megabytes have to come down either way. What that case needs is
 * to be SAID, which is what this is read for — see [startTor].
 */
function consensusState() {
    const file = path.join(TOR_DATA_DIR, 'cached-microdesc-consensus');
    try {
        const txt = fs.readFileSync(file, 'utf8').slice(0, 4096);
        const m = /^valid-until (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/m.exec(txt);
        if (!m) return { have: true, validUntil: null, ageMs: null, usable: false };
        const until = Date.parse(m[1].replace(' ', 'T') + 'Z');
        const pastMs = Date.now() - until;
        return {
            have: true,
            validUntil: until,
            pastMs,
            // Tor keeps using a consensus for about a day past its validity ("reasonably live")
            // before it must fetch a new one. Inside that window a connect is the 7-second kind.
            usable: pastMs < 24 * 3600_000,
            fresh: pastMs < 0,
        };
    } catch (e) {
        return { have: false, validUntil: null, pastMs: null, usable: false, fresh: false };
    }
}

module.exports = {
    startTor, stopTor, isRunning, getStatus, getLogs, isInstalled,
    torTail,            // tor's own output since bootstrap — what a later "it went slow" needs
    socksCarriesStream,
    regions, MODES,
    SOCKS_PORT, HTTP_PORT, DNS_PORT, CONTROL_PORT, TOR_DATA_DIR,
    binPaths,
    // The control-port surface: everything the engine could always answer and was never asked.
    liveInfo, newIdentity, setExitCountry,
    improvePath, measureLivePath, lastPathResult,
    consensusState,
    saveCustomBridges, readCustomBridges, clearCustomBridges, parseBridgeLines,
    ipv6Works,
    // exported for testing: the torrc is the whole configuration surface, and the two lines that
    // decide leakage (SocksPolicy, and the absence of any public resolver) live in it
    _internal: { writeTorrc, transportFor, bridgeLinesFor, LADDER, rememberedMode, rememberMode },
};
