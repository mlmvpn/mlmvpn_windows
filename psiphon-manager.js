'use strict';

/**
 * The «سایفون» engine: psiphon-tunnel-core's ConsoleClient, driven by a three-rung ladder.
 *
 * Ported from the Android app (`TunnelVpnService.kt`'s Psiphon half), and a port on purpose: the
 * rung order, the protocol lists and the alternate resolvers are all measurements taken on real
 * Iranian carriers, and two platforms disagreeing about them would mean one of them is wrong.
 *
 * ## Why a ladder at all, when Psiphon has its own strategy selection
 *
 * Because on the worst domestic operator measured, EVERY direct dial fails at the **TCP layer**.
 * No reset, no TLS alert, no handshake error — the packets do not arrive, because the operator has
 * null-routed the addresses. So any strategy that offers a blockable server address is dead before
 * it starts, however much budget it is given. Only a small fraction of the bundled server list
 * supports a strategy that survives that, and Psiphon's own default ordering spends its whole
 * budget ringing addresses that will never answer.
 *
 * The ladder puts the surviving strategy first, gives each rung its own budget, and remembers the
 * rung that actually carried the tunnel so this machine starts there next time.
 *
 * ## Binary
 *
 * `core/psiphon.exe` is ConsoleClient built from Psiphon-Labs/psiphon-tunnel-core **v2.0.39** —
 * the same tag as the Android app's `psiphontunnel-2.0.39.aar`, so the two platforms run the same
 * core. It publishes a real SOCKS5 listener; the tunnel is built on top of that.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

// ============================================================
// Ports and paths
// ============================================================

/**
 * Psiphon's SOCKS listener, and the HTTP one it opens only for LAN sharing.
 *
 * Clear of every other engine: xray 20809, WARP core 20810, tor 20820/20821, and xray-tester's
 * throwaway range 21300–29500.
 */
const SOCKS_PORT = 20830;
const HTTP_PORT = 20831;

const PSIPHON_DATA_DIR = path.join(os.homedir(), '.mlmvpn', 'psiphon');
const { createDiagnostics, readTail } = require('./psiphon-diagnostics');
const diagnostics = createDiagnostics(PSIPHON_DATA_DIR);
let trafficTimer = null;

/**
 * Every line the core writes, on disk, exactly as it wrote it.
 *
 * The parser above keeps a 30-line ring of whatever it did not recognise and throws the rest
 * away — which is fine while the failure is one the switch statement already names, and useless
 * the moment it is not. A rung that dies on a config error, a bind failure or a panic leaves its
 * explanation in lines nothing here is looking for, and by the time anyone asks, they are gone.
 *
 * Truncated per connect, capped, and written with a plain appendFileSync from the same thread
 * that is already parsing the line — no stream, so a file that cannot be opened costs nothing
 * and a close that never happens cannot lose the tail.
 */
const CORE_LOG_FILE = path.join(PSIPHON_DATA_DIR, 'core.log');
const CORE_LOG_MAX_BYTES = 8 * 1024 * 1024;
let coreLogBytes = 0;

function openCoreLog(header) {
    try {
        ensureDataDir();
        fs.writeFileSync(CORE_LOG_FILE, `[${new Date().toISOString()}] ${header}\n`, 'utf8');
        coreLogBytes = header.length + 32;
    } catch (e) { coreLogBytes = Infinity; }
}

function writeCoreLog(line) {
    if (coreLogBytes > CORE_LOG_MAX_BYTES) return;
    const text = `[${new Date().toISOString()}] ${line}\n`;
    coreLogBytes += Buffer.byteLength(text);
    try { fs.appendFileSync(CORE_LOG_FILE, text); } catch (e) { coreLogBytes = Infinity; }
}

/** Engine events on the SAME timeline as the tunnel's own. See front-guard.js. */
function diary(kind, fields, note) {
    try { require('./tun-diag').event(kind, fields, note); } catch (e) { /* no diary, same tunnel */ }
}

function binPaths() {
    return {
        exe: require('./core-paths').file('psiphon', 'psiphon.exe', path.join(__dirname, 'core', 'psiphon.exe')),
        // Psiphon's own embedded server list. Platform-independent, so this is the very file the
        // Android app ships in its assets — one list, one place to update it.
        serverList: path.join(__dirname, 'core', 'psiphon_server_entries.txt'),
    };
}

function isInstalled() { return fs.existsSync(binPaths().exe); }

function ensureDataDir() {
    if (!fs.existsSync(PSIPHON_DATA_DIR)) fs.mkdirSync(PSIPHON_DATA_DIR, { recursive: true });
    return PSIPHON_DATA_DIR;
}

// ============================================================
// Protocol sets
// ============================================================

/**
 * The domain-fronted protocols: the tunnel terminates on an Amazon or Cloudflare edge address and
 * never on a Psiphon-owned IP, so a carrier's address blocklist cannot see it.
 *
 * They do need working DNS to resolve the front, which is what the alternate resolvers below are
 * for.
 */
const PROTOCOLS_FRONTED = [
    'FRONTED-MEEK-OSSH',
    'FRONTED-MEEK-HTTP-OSSH',
    'FRONTED-MEEK-QUIC-OSSH',
];

/**
 * Everything that dials a Psiphon server address directly. Used for winner detection only — the
 * direct rung passes no protocol limit at all and lets Psiphon choose.
 */
const PROTOCOLS_DIRECT = [
    'QUIC-OSSH',
    'TLS-OSSH',
    'UNFRONTED-MEEK-HTTPS-OSSH',
    'UNFRONTED-MEEK-OSSH',
    'SHADOWSOCKS-OSSH',
    'CONJURE-OSSH',
    'OSSH',
    'SSH',
];

/**
 * Every protocol that can cross a SOCKS5 upstream — i.e. TCP only. A HARD limit
 * (`LimitTunnelProtocols`) whenever Psiphon runs inside WARP, for two separate reasons:
 *
 *  - `InitialLimitTunnelProtocols` is only a preference: once the candidate budget is spent
 *    Psiphon reverts to its full set, which includes the `INPROXY-WEBRTC-*` entries the bundled
 *    list advertises.
 *  - in-proxy is WebRTC and needs raw UDP sockets. A SOCKS5 upstream cannot carry those, and the
 *    Android field log shows exactly what happens: STUN leaves over the carrier instead of the
 *    tunnel, ICE gathering takes 34s instead of ~130ms, and the broker round trip resolves DNS
 *    *untunnelled* on the very link the operator null-routes.
 *
 * QUIC-OSSH is absent for the same reason — it is UDP, and Psiphon already declines to dial it
 * when an upstream proxy is set (measured: 0 attempts across a full run, against 3 when dialling
 * directly), so naming it here would be a contradiction rather than an option.
 */
const PROTOCOLS_CHAINABLE = [
    'FRONTED-MEEK-OSSH',
    'FRONTED-MEEK-HTTP-OSSH',
    'TLS-OSSH',
    'UNFRONTED-MEEK-HTTPS-OSSH',
    'UNFRONTED-MEEK-OSSH',
    'SHADOWSOCKS-OSSH',
    'OSSH',
    'SSH',
];

/**
 * Public resolvers on NON-standard ports, for Psiphon's own resolver.
 *
 * Why this exists, from a field log where Psiphon could not connect at all: every dial died on
 * `checkDNSAnswerIP: IP is bogon`. The resolver got an ANSWER, and the answer was a private-range
 * address — the operator's DNS hijack. Psiphon correctly refused it, so tactics never loaded and
 * not one of the bundled fronted entries could be resolved. `Tunnels: {"count":0}`.
 *
 * Resolvers set on the TUN do not help: Psiphon's resolver builds its own socket outside the
 * tunnel, straight onto the operator link where UDP/53 is hijacked whatever address is targeted.
 * The PORT is the whole point — the same providers answering on another port were reached cleanly.
 *
 * Scope, so nobody expects too much of it: this fixes name resolution only. On a network that also
 * blocks the transport there is nothing to resolve to.
 */
/**
 * The countries that actually have a domain-fronted server in the list.
 *
 * It matters because the fronted rung's hard protocol limit and the user's country choice can
 * contradict each other. `EgressRegion` is a HARD filter — every server outside that country
 * disappears from the pool — so asking for a country with no fronted entry while rung A also
 * insists on a fronted protocol leaves the rung with an EMPTY candidate set, and the whole budget
 * is spent dialling nothing.
 *
 * These six are where the fronted entries live; the core's own `AvailableEgressRegions` notice
 * reported exactly this set on the first run here (CA, DE, FR, GB, NL, US). When the user asks for
 * one of them, the fronted limit stays. When they ask for anywhere else, the limit is dropped for
 * that rung so the direct entries in their country get the budget instead — the choice the user
 * made is the one they see honoured, and the ladder still has rung D behind it.
 */
const FRONTED_REGIONS = ['US', 'GB', 'DE', 'NL', 'FR', 'CA'];

const ALTERNATE_DNS = [
    '208.67.222.222:5353',   // OpenDNS, alternate port
    '9.9.9.9:9953',          // Quad9, alternate port
    '208.67.220.220:5353',
];

/**
 * Psiphon's own download locations for a fresh server list. Both sets are required together.
 *
 * The URLs are written in the clear here and base64-encoded on the way into the config by
 * [transferUrls], because that is what the core demands: `TransferURL.URL` is documented as
 * *"slightly obfuscated with base64 encoding to mitigate trivial binary executable string
 * scanning"*, and a plain URL is rejected outright — `TransferURLs.DecodeAndValidate: failed to
 * decode URL: illegal base64 data at input byte 5`, which kills the WHOLE config rather than just
 * the download. Keeping them readable in the source is worth the one conversion: an unreadable
 * list is a list nobody can check against upstream.
 */
const REMOTE_SERVER_LIST_URLS = [
    { URL: 'https://s3.amazonaws.com/psiphon/web/iohq-waa4-q4dt/server_list_compressed', SkipVerify: false, OnlyAfterAttempts: 0 },
    { URL: 'https://www.gpallthingsnumberweather.com/web/iohq-waa4-q4dt/server_list_compressed', SkipVerify: true, OnlyAfterAttempts: 2 },
    { URL: 'https://www.storagejsstrategiesfabulous.com/web/iohq-waa4-q4dt/server_list_compressed', SkipVerify: true, OnlyAfterAttempts: 2 },
    { URL: 'https://www.diamondberlingamerplanet.com/web/iohq-waa4-q4dt/server_list_compressed', SkipVerify: true, OnlyAfterAttempts: 2 },
];
const OSL_ROOT_URLS = [
    { URL: 'https://s3.amazonaws.com/psiphon/web/iohq-waa4-q4dt/osl', SkipVerify: false, OnlyAfterAttempts: 0 },
    { URL: 'https://www.gpallthingsnumberweather.com/web/iohq-waa4-q4dt/osl', SkipVerify: true, OnlyAfterAttempts: 2 },
    { URL: 'https://www.storagejsstrategiesfabulous.com/web/iohq-waa4-q4dt/osl', SkipVerify: true, OnlyAfterAttempts: 2 },
    { URL: 'https://www.diamondberlingamerplanet.com/web/iohq-waa4-q4dt/osl', SkipVerify: true, OnlyAfterAttempts: 2 },
];

/** The core's own encoding for a download location. See the note on the URL lists. */
function transferUrls(list) {
    return list.map(u => ({
        URL: Buffer.from(u.URL, 'utf8').toString('base64'),
        SkipVerify: u.SkipVerify,
        OnlyAfterAttempts: u.OnlyAfterAttempts,
    }));
}

const REMOTE_SERVER_LIST_SIGNATURE_KEY = 'MIICIDANBgkqhkiG9w0BAQEFAAOCAg0AMIICCAKCAgEAt7Ls+/39r+T6zNW7GiVpJfzq/xvL9SBH5rIFnk0RXYEYavax3WS6HOD35eTAqn8AniOwiH+DOkvgSKF2caqk/y1dfq47Pdymtwzp9ikpB1C5OfAysXzBiwVJlCdajBKvBZDerV1cMvRzCKvKwRmvDmHgphQQ7WfXIGbRbmmk6opMBh3roE42KcotLFtqp0RRwLtcBRNtCdsrVsjiI1Lqz/lH+T61sGjSjQ3CHMuZYSQJZo/KrvzgQXpkaCTdbObxHqb6/+i1qaVOfEsvjoiyzTxJADvSytVtcTjijhPEV6XskJVHE1Zgl+7rATr/pDQkw6DPCNBS1+Y6fy7GstZALQXwEDN/qhQI9kWkHijT8ns+i1vGg00Mk/6J75arLhqcodWsdeG/M/moWgqQAnlZAGVtJI1OgeF5fsPpXu4kctOfuZlGjVZXQNW34aOzm8r8S0eVZitPlbhcPiR4gT/aSMz/wd8lZlzZYsje/Jr8u/YtlwjjreZrGRmG8KMOzukV3lLmMppXFMvl4bxv6YFEmIuTsOhbLTwFgh7KYNjodLj/LsqRVfwz31PgWQFTEPICV7GCvgVlPRxnofqKSjgTWI4mxDhBpVcATvaoBl1L/6WLbFvBsoAUBItWwctO2xalKxF5szhGm8lccoc5MZr8kfE0uxMgsxz4er68iCID+rsCAQM=';
const SERVER_ENTRY_SIGNATURE_KEY = 'sHuUVTWaRyh5pZwy4UguSgkwmBe0EHtJJkoF5WrxmvA=';
const EXCHANGE_OBFUSCATION_KEY = 'DpXzloJk1Hw6aSzmKKky0xcahsEHubch81Mi6K0XMlU=';

// ============================================================
// The ladder
// ============================================================

/**
 * One rung: a complete config variant plus the time we will spend on it.
 *
 * Ordered by *expected time to first connection on a hostile carrier*, not by how clever the
 * technique is — the cheapest thing that plausibly works goes first so the common case stays fast.
 *
 *  - **A, fronted.** The only path that works on the hostile carrier. Only a handful of the
 *    bundled entries advertise a FRONTED-MEEK protocol, so the candidate count is kept low to make
 *    Psiphon cycle those few with fresh dial parameters instead of opening up to the hundreds of
 *    direct entries that are known-dead there.
 *  - **D, wide-open direct.** The rung that wins where nothing is blocked — one measured carrier
 *    connected this way on QUIC-OSSH in seconds — and the safety net if the CDN fronts are ever
 *    blocked. No protocol limit at all: Psiphon's own replay and tactics ordering is better than
 *    anything we would impose.
 *  - **C, in-proxy.** Routes through other Psiphon users' devices over WebRTC. Their addresses are
 *    residential and in no carrier blocklist, which is what makes this the last resort that can
 *    still work when every server IP and every CDN front is unreachable. Slowest: it needs a
 *    broker plus an ICE negotiation.
 */
/**
 * Turn the server's own tactics off for a rung, and with them in-proxy.
 *
 * THIS IS WHAT MAKES THE LADDER MEAN ANYTHING, and leaving it out is why the fronted rung stopped
 * working on this line. Tactics are downloaded parameters, and among the things they can carry is
 * "prefer the in-proxy protocol" — so a rung configured to try fronted CDN paths and nothing else
 * would have its worker pool spent on WebRTC and ICE instead. Measured here with it absent: rung A
 * ran for its whole 60-second budget and the only thing the log had to say was
 * `webRTC: ice: Failed get server reflexive address … timeout while waiting for XORMappedAddr` —
 * a STUN failure, on a rung that is not supposed to touch WebRTC at all. All three rungs then
 * failed in 180 s on a line where the fronted path had connected in 21 s an hour earlier.
 *
 * With tactics off there are no broker specs either, so in-proxy is dead weight on these rungs and
 * is turned off explicitly rather than left to consume worker slots it cannot use. Rung C is where
 * the peer relay gets its turn, with tactics ON — it needs the broker.
 *
 * Never applied to a chained run: Psiphon rides inside WARP there, its tactics request goes out
 * over a working tunnel, and that path connects on the first try. There is nothing to fix.
 */
function disableTactics(cfg, chained) {
    if (chained) return;
    cfg.DisableTactics = true;
    cfg.InproxyEnabled = false;
    cfg.InproxyAllowClient = false;
}

const LADDER = [
    {
        name: 'A',
        label: 'دامین‌فرانتینگ (CDN)',
        timeout: 60_000,
        preferred: PROTOCOLS_FRONTED,
        apply(cfg) {
            cfg.InitialLimitTunnelProtocols = PROTOCOLS_FRONTED;
            cfg.InitialLimitTunnelProtocolsCandidateCount = 30;
            // A HARD limit as well as the initial preference, so the rung's whole budget is spent
            // on fronted candidates instead of lapsing back to the direct entries that are
            // null-routed on this carrier. Rung D is where those get their turn.
            cfg.LimitTunnelProtocols = PROTOCOLS_FRONTED;
            cfg.ConnectionWorkerPoolSize = 12;
            // CDN paths are legitimately slower than a direct dial; without this Psiphon abandons
            // them as if they were dead.
            cfg.NetworkLatencyMultiplier = 2.0;
            cfg.__noTactics = true;
        },
    },
    {
        name: 'D',
        label: 'همهٔ پروتکل‌ها (مستقیم)',
        timeout: 45_000,
        preferred: PROTOCOLS_DIRECT,
        apply(cfg) {
            cfg.ConnectionWorkerPoolSize = 16;
            // No protocol limit at all on this rung: Psiphon's own replay and ordering is better
            // than anything imposed. But tactics still go, for the same reason as rung A — with
            // them on, this rung was also being pushed onto in-proxy.
            cfg.__noTactics = true;
        },
    },
    {
        name: 'C',
        label: 'رله از طریق کاربران دیگر',
        timeout: 75_000,
        preferred: [],
        apply(cfg) {
            // Deliberately NOT naming the INPROXY-* protocols: they are assembled at runtime
            // inside the core rather than existing as literals, so passing one risks failing
            // config validation and killing the whole rung. These flags are enough — the log then
            // reports "in-proxy protocol preferred" and the core dials INPROXY-WEBRTC-OSSH itself.
            cfg.InproxyEnabled = true;
            cfg.InproxyAllowClient = true;
            cfg.InproxySkipAwaitFullyConnected = true;
            cfg.ConnectionWorkerPoolSize = 16;
            cfg.NetworkLatencyMultiplier = 3.0;
        },
    },
];

/**
 * The rungs a chained (Psiphon-over-WARP) run may use: A and D only.
 *
 * Rung C is WebRTC, a SOCKS5 upstream cannot carry UDP, and the field log shows the failure
 * precisely. Keeping it in the list did not merely waste its budget — the STARTING rung is read
 * from the remembered winner, and a previous unchained run may well have recorded C, so the very
 * first chained attempt would begin on the one rung that cannot work.
 */
function ladderFor(chained) {
    return chained ? LADDER.filter(r => r.name !== 'C') : LADDER.slice();
}

// ============================================================
// State
// ============================================================

const state = {
    running: false,
    connected: false,
    rung: null,           // the rung being tried, or the one that won
    protocol: null,       // what actually carried the tunnel (ActiveTunnel)
    region: 'auto',
    egressRegion: null,   // the country the tunnel came out in, as reported
    available: [],        // the regions Psiphon last said were available
    stage: 'idle',        // idle | starting | dialling | connected | failed
    detail: '',
    // Which rung of how many is running, its budget, and when it began — everything a progress
    // display needs so a two-minute ladder reads as progress instead of a hang.
    rungIndex: 0,
    rungCount: 0,
    rungSeconds: 0,
    rungStartedAt: null,
    since: null,
    error: null,
    sent: 0,
    received: 0,
    // How many times the core lost its tunnel during THIS session, when the current outage
    // began, and how long the last one lasted. `drops` is the number that answers «پایدار
    // نیست»: a session with 0 is a different problem from a session with 9.
    drops: 0,
    droppedAt: 0,
    lastGapSeconds: 0,
    // Destinations the SERVER refused. See the `administratively prohibited` branch.
    refused: 0,
    // What the connected server measured at, and when. See measureTunnel.
    measuredMbit: 0,
    measuredStreams: 0,
    measuredAt: 0,
    // The server that carried it, and where it came out — the two facts that decide whether a
    // slow session is worth reconnecting to get a different one.
    serverRegion: null,
    candidateNumber: null,
};

let proc = null;
// The last core this module spawned, kept after `proc` is cleared so the next rung can wait for
// it to be gone. See waitForProcExit.
let lastChild = null;
let logs = [];
let cancelled = false;
let sessionId = 0;
const MAX_LOGS = 300;

function record(line, onLog) {
    const stamped = `[سایفون] ${line}`;
    logs.push(stamped);
    if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
    diagnostics.record('message', { message: line });
    if (typeof onLog === 'function') { try { onLog(stamped); } catch (e) { /* the UI is gone */ } }
}

// ============================================================
// Config
// ============================================================

/**
 * Build the client config for one rung.
 *
 * @param rung     an entry of [LADDER]
 * @param region   two-letter egress preference, or 'auto'
 * @param proxy    "host:port" of an outer SOCKS5 to dial through, or null
 * @param lan      expose the local proxies on the LAN (opt-in; see the warning in the UI)
 */
function buildConfig(rung, region, proxy, lan) {
    const dir = ensureDataDir();
    const oslDir = path.join(dir, 'osl');
    if (!fs.existsSync(oslDir)) fs.mkdirSync(oslDir, { recursive: true });

    const cfg = {
        PropagationChannelId: 'FFFFFFFFFFFFFFFF',
        SponsorId: '1111111111111111',
        ClientVersion: '1',
        // Empty, not absent: the region is applied per-rung below, because as a top-level constraint
        // it is a HARD filter that removes every server outside that country from the pool.
        EgressRegion: '',
        TunnelProtocol: '',
        // ZERO, WHICH MEANS "NEVER GIVE UP" — and 120 is what made a dropped tunnel permanent.
        //
        // This is not only the first connect's budget: the controller re-arms it whenever it goes
        // back to establishing, so a tunnel that dropped and could not be rebuilt inside two
        // minutes made the controller halt and ConsoleClient EXIT. From outside that is «وصل شد،
        // بعد قطع شد و دیگر برنگشت», and with a full tunnel on top it is a machine with no
        // internet at all — the adapter still holding the default route over a dead port.
        //
        // Giving up is OUR decision to make, not the core's: each rung already has its own
        // budget here (see LADDER) and `runRung` kills the process when it runs out. Handing the
        // core a second, hidden deadline could only ever end a tunnel we still wanted. Se7en-Pro
        // reached the same conclusion on the same core — its config sets this to 0 too.
        EstablishTunnelTimeoutSeconds: 0,
        DataRootDirectory: dir,
        LocalSocksProxyPort: SOCKS_PORT,

        RemoteServerListURLs: transferUrls(REMOTE_SERVER_LIST_URLS),
        DisableRemoteServerListFetcher: false,
        FetchRemoteServerListRetryPeriodMilliseconds: 30000,
        RemoteServerListDownloadFilename: path.join(dir, 'remote_server_list'),
        ObfuscatedServerListRootURLs: transferUrls(OSL_ROOT_URLS),
        ObfuscatedServerListDownloadDirectory: oslDir,
        RemoteServerListSignaturePublicKey: REMOTE_SERVER_LIST_SIGNATURE_KEY,
        ServerEntrySignaturePublicKey: SERVER_ENTRY_SIGNATURE_KEY,
        ExchangeObfuscationKey: EXCHANGE_OBFUSCATION_KEY,

        // Without this the core suppresses the BytesTransferred notice, and the traffic feed and
        // the "is it really carrying data" check would both have nothing to read.
        EmitBytesTransferred: true,
        EmitDiagnosticNotices: true,
        // The server telling the client something is wrong — a disallowed destination, a traffic
        // rule, an expired authorization. The parser has handled `ServerAlert` since it was
        // written; without this the core never sends one, so the branch was dead code.
        EmitServerAlerts: true,
        // Which fronting address, which TLS profile, which resolver — the fields that say WHY one
        // dial worked and the next did not. They only reach the log when this is on.
        EmitDiagnosticNetworkParameters: true,
        // Tell the core where the user is, so Iran-specific tactics — protocol selection, padding,
        // server prioritisation — are downloaded and applied.
        DeviceRegion: 'IR',
        ConnectionWorkerPoolSize: 12,

        // Three keys, each load-bearing. See [ALTERNATE_DNS] for the field evidence.
        //  * Preferred, not plain Alternate: the plain list is only consulted when the system
        //    resolver list is EMPTY, and it never is.
        //  * Probability 1.0, because the default is 0.0 — the list would be configured and then
        //    almost never used.
        //  * 2 attempts per server (default 1), so one lost UDP packet does not drop straight back
        //    to the hijacked system resolver.
        // Not a hard override: the system resolvers stay behind these, so a network with honest
        // DNS still resolves normally if it is the alternate ports that are blocked.
        DNSResolverPreferredAlternateServers: ALTERNATE_DNS,
        DNSResolverPreferAlternateServerProbability: 1.0,
        DNSResolverAttemptsPerPreferredServer: 2,
    };

    if (lan) {
        // "any" is the core's own spelling for 0.0.0.0. The HTTP proxy is only bound when sharing
        // is on: Windows takes an HTTP proxy system-wide while SOCKS has to be set per
        // application, so a shared tunnel needs both and an unshared one should open neither.
        cfg.ListenInterface = 'any';
        cfg.LocalHttpProxyPort = HTTP_PORT;
    }

    if (proxy) {
        cfg.UpstreamProxyURL = `socks5://${proxy}`;
        // A hard limit, not a preference — see [PROTOCOLS_CHAINABLE].
        cfg.LimitTunnelProtocols = PROTOCOLS_CHAINABLE;
    }

    rung.apply(cfg);
    if (cfg.__noTactics) { delete cfg.__noTactics; disableTactics(cfg, !!proxy); }

    // The egress preference, applied AFTER the rung so the rung cannot silently override it.
    const cc = (region || 'auto').trim().toUpperCase();
    if (cc && cc !== 'AUTO') {
        cfg.EgressRegion = cc;
        // A country with no fronted server and a fronted-only rung is an empty candidate set — see
        // [FRONTED_REGIONS]. The limit goes, not the country: the user asked for the country.
        if (!FRONTED_REGIONS.includes(cc) && Array.isArray(cfg.LimitTunnelProtocols) &&
            cfg.LimitTunnelProtocols.every(p => PROTOCOLS_FRONTED.includes(p))) {
            delete cfg.LimitTunnelProtocols;
            delete cfg.InitialLimitTunnelProtocols;
            delete cfg.InitialLimitTunnelProtocolsCandidateCount;
        }
    }

    if (proxy) {
        // A chained run cannot use in-proxy, whatever the rung asked for.
        delete cfg.InproxyEnabled;
        delete cfg.InproxyAllowClient;
        delete cfg.InproxySkipAwaitFullyConnected;
    }

    const file = path.join(dir, `config-${rung.name}.json`);
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    return file;
}

// ============================================================
// One rung
// ============================================================

function killProc() {
    const child = proc;
    proc = null;
    if (child) { try { child.kill(); } catch (e) { /* already gone */ } }
    return child;
}

/**
 * Wait for a killed core to be GONE, not merely told to go.
 *
 * `child.kill()` returns the instant the signal is delivered. What the next rung needs is not the
 * signal — it is the two things the dying process is still holding:
 *
 *   · the SOCKS listener, which a new core cannot bind and does not fall back from, and
 *   · **the datastore lock**, which is worse, because losing that race does not fail one rung,
 *     it fails EVERY rung.
 *
 * Measured here, three rungs in a row, when a core from a previous run was still alive:
 *
 *     Warning: tryDatastoreOpenDB failed: psiphon.tryDatastoreOpenDB#167: timeout
 *     Error: error in init: … psiphon.openDataStore#169: … timeout
 *     [هستهٔ سایفون با کد 1 بسته شد]  ×3, in eleven seconds, on a line that was working
 *
 * boltdb takes an exclusive file lock; the second core waits for it, times out, and exits before
 * it has dialled anything. From outside that is «اصلاً وصل نشد» with no bad network anywhere —
 * and it stayed invisible until the raw core log started being kept, because none of those lines
 * is a notice the parser knew.
 */
function waitForProcExit(child, timeoutMs = 6000) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
        const timer = setTimeout(() => {
            // Still there after the grace period: SIGKILL, then take the answer either way. A
            // rung that starts against a lock will fail fast and be logged; blocking the whole
            // ladder on one stubborn process would be worse.
            try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
            setTimeout(() => finish(false), 500);
        }, timeoutMs);
        child.once('exit', () => finish(true));
        child.once('close', () => finish(true));
    });
}

/**
 * Is anything still listening on the SOCKS port?
 *
 * Between two rungs the previous core is killed and the next one is spawned in the same tick.
 * The process dies immediately; the LISTENING SOCKET does not always go with it that fast, and
 * a core that cannot bind `LocalSocksProxyPort` does not fall back to another port — it fails
 * the whole run. That turns "rung A's budget ran out" into "rungs D and C failed in under a
 * second each", which from the outside is a ladder that does not connect at all.
 *
 * Bounded, and its result is logged either way: if the port is never the problem, this costs one
 * loopback connect per rung and says so.
 */
function portInUse(port, timeoutMs = 400) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (inUse) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(inUse); } };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        sock.connect(port, '127.0.0.1');
    });
}

/**
 * Close a psiphon core left behind by a previous run — and ONLY that.
 *
 * `taskkill /IM psiphon.exe` was the first version of this and it is a loaded gun. It kills by
 * IMAGE NAME, which means every psiphon core on the machine: a second instance of this app, a
 * core the store activated from another directory, and — proved while writing this — the user's
 * OWN LIVE TUNNEL, because running the test suite reaches this path whenever the port is busy.
 * It did not kill it here only because the live core is elevated and the shell was not. That is
 * luck, not a design.
 *
 * So: enumerate, match the executable PATH against the one this module is about to run, and kill
 * by pid. A core running from anywhere else is somebody else's and is left alone — the port stays
 * busy, the caller reports that, and nothing of the user's is destroyed to fix our own mess.
 *
 * Skipped entirely when MLMVPN_HOME is set, which marks a test rather than an installation. A
 * test suite must not be able to take a machine's tunnel down.
 */
function killStrayCores() {
    if (process.env.MLMVPN_HOME) return Promise.resolve(0);
    return new Promise((resolve) => {
        const execFile = require('child_process').execFile;
        if (typeof execFile !== 'function') return resolve(0);
        // Windows hands these paths back with backslashes while ours may carry either, so both
        // sides are flattened to one separator before they are compared.
        const norm = (x) => String(x || '').replace(/[\\/]+/g, '/').toLowerCase();
        let target;
        try { target = norm(binPaths().exe); } catch (e) { return resolve(0); }
        const script = "Get-CimInstance Win32_Process -Filter \"Name = 'psiphon.exe'\" | " +
            'Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress';
        execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, timeout: 10000 }, (err, stdout) => {
                if (err) return resolve(0);
                let rows;
                try { rows = JSON.parse(String(stdout).trim() || 'null'); } catch (e) { return resolve(0); }
                if (!rows) return resolve(0);
                const list = (Array.isArray(rows) ? rows : [rows]).filter(r => norm(r.ExecutablePath) === target);
                if (!list.length) return resolve(0);
                let left = list.length, killed = 0;
                for (const r of list) {
                    execFile('taskkill', ['/F', '/PID', String(r.ProcessId)],
                        { windowsHide: true, timeout: 8000 }, (e) => {
                            if (!e) killed++;
                            if (--left === 0) resolve(killed);
                        });
                }
            });
    });
}

async function waitForSocksFree(onLog, timeoutMs = 4000) {
    const startedAt = Date.now();
    let waited = 0;
    while (Date.now() - startedAt < timeoutMs) {
        if (!(await portInUse(SOCKS_PORT))) {
            if (waited) {
                record(`پورت ${SOCKS_PORT} بعد از ${waited} میلی‌ثانیه آزاد شد`, onLog);
                diagnostics.record('socks-port-freed', { port: SOCKS_PORT, waitedMs: waited });
            }
            return true;
        }
        waited = Date.now() - startedAt;
        await new Promise(r => setTimeout(r, 200));
    }
    record(`⚠️ پورت ${SOCKS_PORT} هنوز اشغال است — این رتبه احتمالاً نمی‌تواند پورت را بگیرد`, onLog);
    diagnostics.record('socks-port-busy', { port: SOCKS_PORT, waitedMs: Date.now() - startedAt });
    diary('psiphon-port-busy', { port: SOCKS_PORT, waited: `${Date.now() - startedAt}ms` },
        'پورت SOCKS سایفون هنگام شروع رتبهٔ بعدی هنوز آزاد نشده بود');
    return false;
}

/**
 * Run one rung and wait for a tunnel.
 *
 * Resolves true only on `Tunnels count=1`. The winning PROTOCOL is read from the live
 * `ActiveTunnel` notice rather than assumed from the rung, because
 * `InitialLimitTunnelProtocols` is a preference: once the candidate budget is spent the core
 * reverts to its full set, so the protocol that ends up carrying the tunnel is often not from the
 * rung's list at all. Both Android field logs proved it — one carrier ended on a fronted protocol
 * while a different rung was active, another on plain OSSH with an in-proxy broker.
 */
function runRung(rung, region, proxy, lan, onLog, onStatus, allRungs) {
    return new Promise(resolve => {
        const rungStartedAt = Date.now();
        const cfgFile = buildConfig(rung, region, proxy, lan);
        const p = binPaths();
        // Keep notices on stderr: -useNoticeFiles diverts diagnostic notices away from this parser.
        const args = ['-config', cfgFile];
        if (fs.existsSync(p.serverList)) args.push('-serverList', p.serverList);

        let child;
        try {
            child = spawn(p.exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            record(`اجرا ممکن نشد: ${e.message}`, onLog);
            return resolve(false);
        }
        proc = child;
        lastChild = child;

        let settled = false;
        const tail = [];
        const done = ok => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (!ok) {
                tail.slice(-10).forEach(l => record(`  ${l}`, onLog));
                if (proc === child) killProc();
            }
            resolve(ok);
        };

        const timer = setTimeout(() => {
            record(`رتبهٔ ${rung.name}: بودجهٔ ${Math.round(rung.timeout / 1000)} ثانیه تمام شد`, onLog);
            done(false);
        }, rung.timeout);

        let buf = '';
        const onChunk = chunk => {
            if (proc !== child) return;
            buf += chunk.toString('utf8');
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                // Before anything is parsed or filtered: the line that explains a failure is
                // usually one nothing below is looking for.
                writeCoreLog(line);
                if (cancelled) return done(false);

                let notice = null;
                try { notice = JSON.parse(line); } catch (e) { /* not a notice line */ }
                if (!notice || !notice.noticeType) { tail.push(line); if (tail.length > 30) tail.shift(); continue; }

                const d = notice.data || {};
                diagnostics.notice(notice.noticeType, d);
                switch (notice.noticeType) {
                    case 'Tunnels':
                        if ((d.count || 0) >= 1) {
                            const wasDown = state.droppedAt;
                            state.connected = true;
                            state.stage = 'connected';
                            state.detail = rung.label;
                            state.error = null;
                            // Kept across a drop, not reset: `since` is how long THIS connection
                            // has existed, and zeroing it on every re-establish made a tunnel
                            // that had flapped four times read as a fresh one.
                            if (!state.since) state.since = Date.now();
                            if (wasDown) {
                                const gap = Math.round((Date.now() - wasDown) / 1000);
                                state.droppedAt = 0;
                                state.lastGapSeconds = gap;
                                record(`اتصال بعد از ${gap} ثانیه برگشت (قطعی شمارهٔ ${state.drops})`, onLog);
                                diary('psiphon-back', { gap: `${gap}s`, drops: state.drops, rung: rung.name, protocol: state.protocol || '-' },
                                    `تونل سایفون بعد از ${gap} ثانیه دوباره برقرار شد`);
                            } else {
                                diary('psiphon-up', { rung: rung.name, protocol: state.protocol || '-', region: state.egressRegion || '-', ms: Date.now() - rungStartedAt });
                            }
                            done(true);
                        } else if (state.connected) {
                            const held = state.since ? Math.round((Date.now() - state.since) / 1000) : 0;
                            state.drops++;
                            state.droppedAt = Date.now();
                            record(`اتصال از دست رفت (بعد از ${held} ثانیه)؛ تلاش خودکار برای اتصال مجدد`, onLog);
                            diary('psiphon-drop', {
                                heldFor: `${held}s`, drops: state.drops, rung: rung.name,
                                protocol: state.protocol || '-', sent: state.sent, received: state.received,
                            }, `هستهٔ سایفون تونلش را بعد از ${held} ثانیه از دست داد`);
                            state.connected = false;
                            state.stage = 'reconnecting';
                            state.detail = 'اتصال سایفون قطع شد؛ هسته در حال اتصال مجدد است';
                        }
                        break;
                    // The core halting itself, which is the failure nothing above can see.
                    //
                    // `EstablishTunnelTimeoutSeconds` (120, set at the top of the config) makes
                    // the controller give up and halt — and ConsoleClient exits with it. Whether
                    // that budget covers only the first connect or is re-armed after a drop is
                    // not something this side can read out of the binary, and guessing is how the
                    // question stayed open: if the notice arrives after a tunnel was already
                    // carrying traffic, it is re-armed, and the line below is the proof.
                    //
                    // Either way the consequence is the same and is what «وصل شد و بعد قطع شد و
                    // دیگر برنگشت» means: with a full tunnel on top, a machine with no internet
                    // at all and a green switch over it.
                    case 'EstablishTunnelTimeout':
                        record('هسته بعد از مهلت مقرر تونلی نساخت و خودش را متوقف می‌کند', onLog);
                        diary('psiphon-establish-timeout', { rung: rung.name, drops: state.drops, seconds: d.timeoutSeconds || '-' },
                            'هستهٔ سایفون مهلت ساختن تونل را تمام کرد و متوقف شد');
                        break;
                    case 'ConnectingServer':
                        // Every dial attempt, with what it is dialling. On a line where nothing
                        // connects, the shape of this list IS the diagnosis: all-fronted and no
                        // answer means the CDN path is blocked, while a list that never appears
                        // at all means tactics or the server list never loaded.
                        diagnostics.record('core-ConnectingServer', { data: d });
                        break;
                    case 'ServerAlert':
                        record(`هشدار سرور: ${d.reason || '?'}`, onLog);
                        break;
                    case 'ActiveTunnel':
                        if (d.protocol) {
                            state.protocol = d.protocol;
                            record(`پروتکل فعال: ${d.protocol}`, onLog);
                            // AND RE-DECIDE WHICH RUNG TO REMEMBER, because this notice arrives
                            // AFTER the one that says a tunnel exists.
                            //
                            // Measured here: `Tunnels count=1` at 112 s, `ActiveTunnel` a moment
                            // later — so at the instant the winner was recorded the protocol was
                            // still unknown, the code fell back to "whichever rung was active",
                            // and it stored **C** for a tunnel that a **fronted** protocol was
                            // carrying. The next connect then began on the slowest rung there is
                            // (a broker plus an ICE negotiation) and took minutes, which from the
                            // outside is indistinguishable from not connecting at all.
                            //
                            // Re-deciding here is self-correcting rather than a race to win: the
                            // rung is stored twice, and the second time with the fact that decides
                            // it. A connect that never emits ActiveTunnel keeps the first answer.
                            if (state.connected) rememberRung(winningRung(rung, allRungs), !!proxy);
                        }
                        break;
                    case 'ConnectedServer':
                        // WHICH server, and how far down the list it was.
                        //
                        // Measured 2026-09-19: `candidateNumber: 0` out of a pool the core
                        // reported as 16 — the fronted protocol limit leaves only that many
                        // entries, and the FIRST one to answer keeps the tunnel for the whole
                        // session however slow it turns out to be. Nothing re-evaluates it. So
                        // the number written here is the answer to «چرا کند است»: not the
                        // tunnel, not the ladder — one server, picked for answering first.
                        if (d.candidateNumber !== undefined) state.candidateNumber = d.candidateNumber;
                        if (d.region) state.serverRegion = d.region;
                        diagnostics.record('core-ConnectedServer', { data: d });
                        diary('psiphon-server', {
                            region: d.region || '-', protocol: d.protocol || '-',
                            candidate: d.candidateNumber, pool: d.uniqueCandidateEstimate,
                            replay: !!d.isReplay, network: d.networkType || '-',
                        });
                        break;
                    case 'ConnectedServerRegion':
                        if (d.serverRegion) state.egressRegion = d.serverRegion;
                        break;
                    case 'AvailableEgressRegions':
                        if (Array.isArray(d.regions)) state.available = d.regions.slice();
                        break;
                    case 'RemoteServerListResourceDownloaded':
                        record('فایل فهرست سرورها دریافت شد؛ بررسی و ورود سرورها را هسته انجام می‌دهد.', onLog);
                        break;
                    case 'BytesTransferred':
                        state.sent += d.sent || 0;
                        state.received += d.received || 0;
                        break;
                    case 'ListeningSocksProxyPort':
                        record(`SOCKS روی 127.0.0.1:${d.port}`, onLog);
                        break;
                    case 'Alert':
                    case 'Warning':
                    case 'Error':
                        // The reason a rung failed is almost always one of these.
                        tail.push(`${notice.noticeType}: ${d.message || JSON.stringify(d)}`);
                        if (tail.length > 30) tail.shift();
                        // THE SERVER REFUSING A DESTINATION, which is otherwise invisible.
                        //
                        // `ssh: rejected: administratively prohibited` is the Psiphon server
                        // declining to open a channel — its own policy, not a network failure.
                        // Downstream it becomes `socks5: request rejected, code=5` in the
                        // tunnel's log and, to the user, a site that simply does not open while
                        // everything else works. Measured here 2026-09-19: two of them, on port
                        // 80, inside a ninety-second session where nothing else went wrong.
                        //
                        // Counted rather than logged per event: a blocked destination that is
                        // retried produces a line per attempt, and the number is what matters.
                        if (/tryDatastoreOpenDB|openDataStore/i.test(d.message || '')) {
                            // The lock, named. Without this the user sees only «با کد ۱ بسته شد».
                            record('پایگاه دادهٔ سایفون قفل است — هستهٔ دیگری هنوز باز است', onLog);
                            diary('psiphon-datastore-locked', { rung: rung.name },
                                'پایگاه دادهٔ هسته قفل بود؛ یعنی یک هستهٔ دیگر هنوز آن را باز نگه داشته');
                        }
                        if (/administratively prohibited/i.test(d.message || '')) {
                            state.refused++;
                            if (state.refused === 1 || state.refused % 10 === 0) {
                                diary('psiphon-refused', { count: state.refused, rung: rung.name, protocol: state.protocol || '-' },
                                    'سرور سایفون باز کردن اتصال به مقصدی را رد کرد (سیاست خود سرور، نه فیلترینگ) — آن سایت باز نمی‌شود');
                                record(`سرور مقصدی را رد کرد (تا حالا ${state.refused} بار) — بعضی سایت‌ها با این سرور باز نمی‌شوند`, onLog);
                            }
                        }
                        break;
                    default:
                        tail.push(`${notice.noticeType}: ${JSON.stringify(d).slice(0, 160)}`);
                        if (tail.length > 30) tail.shift();
                        break;
                }
                if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
            }
        };
        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        const exited = message => {
            if (proc !== child) { done(false); return; }
            record(message, onLog);
            tail.slice(-10).forEach(line => diagnostics.record('core-tail', { line }));
            if (!settled) { done(false); return; }
            // THE PROCESS DIED UNDER A LIVE CONNECTION. Everything pointed at the SOCKS port —
            // the browser, the system proxy, or the whole machine when the full tunnel is on —
            // is now talking to a listener that does not exist. front-guard.js is what notices
            // and puts the routing back; this line is what says why, afterwards.
            diary('psiphon-exit', {
                heldFor: state.since ? `${Math.round((Date.now() - state.since) / 1000)}s` : '0s',
                drops: state.drops, rung: rung.name, protocol: state.protocol || '-',
                sent: state.sent, received: state.received, last: tail.slice(-1)[0] || '-',
            }, `هستهٔ سایفون در حالی که وصل بود بسته شد: ${message}`);
            proc = null;
            clearInterval(trafficTimer); trafficTimer = null;
            diagnostics.sample(readTrafficCounters());
            state.running = false;
            state.connected = false;
            state.stage = 'failed';
            state.since = null;
            state.detail = '';
            state.error = message;
            if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
        };
        child.on('error', e => exited(`خطا: ${e.message}`));
        child.on('exit', code => {
            exited(`هستهٔ سایفون با کد ${code} بسته شد`);
        });
    });
}

// ============================================================
// The ladder walk
// ============================================================

function memoryFile() { return path.join(ensureDataDir(), 'last-good.json'); }

function rememberRung(name, chained) {
    try {
        const all = readMemory();
        all[chained ? 'chained' : 'plain'] = name;
        fs.writeFileSync(memoryFile(), JSON.stringify(all), 'utf8');
    } catch (e) { /* the next connect just starts from the top */ }
}

function readMemory() {
    try { return JSON.parse(fs.readFileSync(memoryFile(), 'utf8')) || {}; } catch (e) { return {}; }
}

/**
 * The rung remembered for this mode.
 *
 * Stored per mode — plain and chained — and NOT shared, because the two ladders are different
 * lists: a plain run can end on rung C, which a chained run must never start from.
 */
function rememberedRung(chained) {
    return readMemory()[chained ? 'chained' : 'plain'] || null;
}

/**
 * Bring Psiphon up.
 *
 * @param opts.region  egress-country preference, or 'auto'
 * @param opts.rung    pin one rung by name ('A' | 'D' | 'C'), else the ladder runs
 * @param opts.proxy   "host:port" of an outer SOCKS5 (Psiphon-over-WARP)
 * @param opts.lan     expose the local proxies on the LAN
 */
async function startPsiphon(opts, onLog, onStatus) {
    if (state.running) {
        return {
            ok: true,
            socks: `127.0.0.1:${SOCKS_PORT}`,
            rung: state.rung,
            protocol: state.protocol,
            pid: proc ? proc.pid : null,
        };
    }
    if (!isInstalled()) throw new Error('فایل core/psiphon.exe موجود نیست.');

    // AN ORPHAN FROM A PREVIOUS RUN IS NOT A RARE CASE. The app can be killed, crash, or be
    // closed while a core is dialling, and what survives holds two things the next connect
    // cannot do without: the SOCKS port and the boltdb lock. Whichever it is, every rung of the
    // next ladder fails in about a second — see waitForProcExit for the log of exactly that.
    //
    // Only when we have no child of our own: a running engine answers this port legitimately,
    // and `startPsiphon` already returned above in that case.
    //
    // And never under MLMVPN_HOME, which marks a test rather than an installation. The suites
    // drive this module with a fake core but a REAL port number, so on a machine where the user's
    // own tunnel is up this pre-flight finds their live core, spends four seconds waiting for a
    // port that will never free, and — before the path check went in — tried to kill it.
    if (!process.env.MLMVPN_HOME && !proc && await portInUse(SOCKS_PORT, 600)) {
        const orphans = await killStrayCores();
        record(orphans > 0
            ? `یک هستهٔ سایفونِ جامانده از اجرای قبلی بسته شد (${orphans} پراسس)`
            : `پورت ${SOCKS_PORT} در اختیار برنامهٔ دیگری است`, onLog);
        diagnostics.record('stray-core', { killed: orphans, port: SOCKS_PORT });
        diary('psiphon-stray', { killed: orphans, port: SOCKS_PORT },
            'هستهٔ جامانده از اجرای قبلی پیدا شد؛ بدون بستن آن هیچ رتبه‌ای وصل نمی‌شد');
        await waitForSocksFree(onLog);
    }

    const o = opts || {};
    const region = (o.region || 'auto').trim();
    const proxy = o.proxy || null;
    const lan = !!o.lan;
    cancelled = false;
    const session = ++sessionId;
    logs = [];

    state.running = true;
    state.connected = false;
    state.region = region;
    state.protocol = null;
    state.egressRegion = null;
    state.rung = null;
    state.stage = 'starting';
    state.detail = '';
    state.error = null;
    state.since = null;
    state.sent = 0;
    state.received = 0;
    state.drops = 0;
    state.droppedAt = 0;
    state.lastGapSeconds = 0;
    state.refused = 0;
    state.serverRegion = null;
    state.candidateNumber = null;
    state.measuredMbit = 0;
    state.measuredStreams = 0;
    state.measuredAt = 0;
    openCoreLog(`connect region=${region} chained=${!!proxy} rung=${o.rung || 'auto'} lastGood=${rememberedRung(!!proxy) || '-'}`);
    clearInterval(trafficTimer);
    diagnostics.resetSample();
    diagnostics.sample(readTrafficCounters());
    diagnostics.record('connect-start', { session, region, chained: !!proxy, requestedRung: o.rung || 'auto' });
    trafficTimer = setInterval(() => diagnostics.sample(readTrafficCounters()), 10000);
    if (trafficTimer.unref) trafficTimer.unref();
    if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }

    let rungs = ladderFor(!!proxy);
    if (o.rung) {
        const pinned = rungs.filter(r => r.name === o.rung);
        if (pinned.length) rungs = pinned;
    } else {
        // START WHERE IT WORKED LAST TIME, so a machine whose carrier needs the fronted rung does
        // not pay the direct rung's budget on every connect for ever. Moved to the front rather
        // than replacing the ladder: if the network changed, the rest still run.
        const last = rememberedRung(!!proxy);
        if (last) {
            const i = rungs.findIndex(r => r.name === last);
            if (i > 0) rungs.unshift(rungs.splice(i, 1)[0]);
        }
    }

    record(`شروع${proxy ? ' (داخل وارپ)' : ''} — ${rungs.map(r => r.name).join(' → ')}`, onLog);

    for (let i = 0; i < rungs.length; i++) {
        const rung = rungs[i];
        if (cancelled) break;
        state.rung = rung.name;
        state.rungIndex = i + 1;
        state.rungCount = rungs.length;
        state.rungSeconds = Math.round(rung.timeout / 1000);
        state.rungStartedAt = Date.now();
        state.stage = 'dialling';
        state.detail = rung.label;
        if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
        record(`رتبهٔ ${rung.name} — ${rung.label} (${Math.round(rung.timeout / 1000)} ثانیه)`, onLog);
        diary('psiphon-rung', { rung: rung.name, of: rungs.length, budget: `${Math.round(rung.timeout / 1000)}s`, chained: !!proxy, region });
        // The previous rung's core was killed a moment ago — wait for it to actually be gone,
        // then for its port. See waitForProcExit: the datastore lock is the one that matters.
        if (i > 0) { await waitForProcExit(lastChild); await waitForSocksFree(onLog); }

        const ok = await runRung(rung, region, proxy, lan, onLog, onStatus, rungs);
        if (session !== sessionId) throw new Error('لغو شد');
        if (ok) {
            // Remember the rung that carried it — which, when the protocol says otherwise, is the
            // rung whose protocol won rather than the one that happened to be active.
            rememberRung(winningRung(rung, rungs), !!proxy);
            record(`وصل شد — رتبهٔ ${rung.name}${state.protocol ? ` روی ${state.protocol}` : ''}, SOCKS روی 127.0.0.1:${SOCKS_PORT}`, onLog);
            // What this server is actually worth, before anyone routes a machine through it.
            const mbit = await measureTunnel();
            if (mbit) record(`ظرفیت این سرور: ${mbit} مگابیت (با ${QUALITY_STREAMS} اتصال هم‌زمان)`, onLog);

            // A SERVER THIS SLOW IS NOT A CONNECTION, whatever the core says about it.
            //
            // The session this came from connected in five seconds, never dropped once in a
            // hundred, and delivered 0.10 Mbit/s — so every check in this app reported success
            // while nothing the user opened would load. The core will not move off that server
            // by itself: it replays it, faster each time, indefinitely.
            //
            // A SEARCH, NOT ONE BLIND SWAP. The first version dialled again exactly once and kept
            // whatever came back, and the very first live run showed why that is not good enough:
            // 0.88 Mbit/s rejected, 0.69 accepted in its place. A redial is a fresh draw from a
            // small pool and is not better by construction — so this keeps drawing until one
            // clears the floor, up to a hard limit, and stops the moment one does.
            //
            // It cannot go back to a server it has already left (dropping the replay entry is
            // what makes the next draw different), so when none of them clears the floor the last
            // one is what there is — and the log says exactly that rather than implying a choice
            // was made.
            let attempts = 1;
            while (state.measuredStreams > 0 && state.measuredMbit < MIN_GOOD_MBIT
                   && attempts < MAX_SERVER_ATTEMPTS && !cancelled) {
                const before = state.measuredMbit;
                attempts++;
                record(`این سرور فقط ${before} مگابیت می‌دهد — سرور دیگری امتحان می‌شود (${attempts} از ${MAX_SERVER_ATTEMPTS})`, onLog);
                diary('psiphon-slow-server', {
                    mbit: before, floor: MIN_GOOD_MBIT, attempt: attempts, of: MAX_SERVER_ATTEMPTS,
                    region: state.serverRegion || '-', candidate: state.candidateNumber, rung: rung.name,
                }, `سرور فعلی زیر آستانه بود (${before} مگابیت)؛ سراغ سرور دیگری می‌رویم`);
                // ORDER IS EVERYTHING HERE. The datastore files are about to be deleted, and
                // deleting boltdb out from under a process that still has it open is how the
                // next core inherits a lock it can never take.
                await waitForProcExit(killProc());
                await waitForSocksFree(onLog);
                dropReplayState();
                state.connected = false;
                state.since = null;
                state.protocol = null;
                state.candidateNumber = null;
                state.serverRegion = null;
                if (!(await runRung(rung, region, proxy, lan, onLog, onStatus, rungs))) {
                    record('سرور بعدی وصل نشد؛ ادامهٔ نردبان', onLog);
                    break;
                }
                const after = await measureTunnel();
                diary('psiphon-slow-server-retry', {
                    before, after, attempt: attempts, region: state.serverRegion || '-',
                    candidate: state.candidateNumber, accepted: after >= MIN_GOOD_MBIT,
                });
                record(after >= MIN_GOOD_MBIT
                    ? `سرور تازه ${after} مگابیت می‌دهد — قبول`
                    : `سرور تازه ${after} مگابیت داد؛ هنوز زیر آستانه`, onLog);
            }
            if (!state.connected) continue;   // the search ran out of servers — next rung
            if (state.measuredStreams > 0 && state.measuredMbit < MIN_GOOD_MBIT) {
                record(`بعد از ${attempts} سرور، بهترین چیزی که این خط داد ${state.measuredMbit} مگابیت بود`, onLog);
                diary('psiphon-all-slow', { attempts, mbit: state.measuredMbit, floor: MIN_GOOD_MBIT },
                    'هیچ‌کدام از سرورهای امتحان‌شده به آستانه نرسید؛ همین آخری نگه داشته شد');
            }
            if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
            return { ok: true, socks: `127.0.0.1:${SOCKS_PORT}`, rung: rung.name, protocol: state.protocol, pid: proc ? proc.pid : null };
        }
    }

    state.running = false;
    clearInterval(trafficTimer); trafficTimer = null;
    state.connected = false;
    state.stage = 'failed';
    state.rung = null;
    state.error = cancelled ? 'لغو شد' : 'هیچ‌کدام از رتبه‌ها وصل نشد';
    if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } }
    throw new Error(state.error);
}

/**
 * How good is the server that just answered?
 *
 * Asked with SEVERAL CONNECTIONS AT ONCE, which is the only way the question has an answer. A
 * single stream through a domain-fronted meek tunnel measures about the same whatever the server
 * is worth — 0.5 to 0.9 Mbit/s on this line whether the server was a good one or the one that
 * later delivered 0.10 Mbit/s in real use. Four at once separates them: measured 2026-09-19 on
 * one line within the same hour, a good US server gave 3.13 Mbit/s and a bad FR one 0.4.
 *
 * Half a megabyte, so it costs about a second and a half of a healthy tunnel. Advisory only:
 * the number is recorded and reported, and a tunnel is never dropped for it here — that decision
 * belongs to whoever asked for the connection.
 */
const QUALITY_BYTES = 768 * 1024;
// SIX, because six is what a browser opens. The whole point of measuring in parallel is that it
// reproduces the workload the user will actually put on this tunnel; measuring with four and
// then comparing against a threshold drawn from six-stream numbers compares two different things.
const QUALITY_STREAMS = 6;

async function measureTunnel() {
    // Not in a test. MLMVPN_HOME marks a suite rather than an installation, and the suites drive
    // this module with a FAKE core but the REAL port constant — so on a machine where the user's
    // own tunnel is up, this pulls three quarters of a megabyte through THEIR line per connect,
    // reports a number that belongs to a different tunnel, and can send the slow-server search
    // off after a server nothing in the test will ever answer for.
    if (process.env.MLMVPN_HOME) { state.measuredMbit = 0; state.measuredStreams = 0; return 0; }
    try {
        const r = await require('./tun-diag').parallelThroughSocks(SOCKS_PORT, QUALITY_STREAMS, QUALITY_BYTES, 12000);
        state.measuredMbit = r && r.ok ? r.mbit : 0;
        // How many of the four actually came back with bytes. It separates "this server is slow"
        // from "nothing comes through at all" — a download that merely timed out still counts as
        // ok, because it reports the rate of what did arrive. Only the first of those is worth
        // dialling again for; the second is the dead-path case the connect endpoint already
        // handles, and retrying it would just spend another ten seconds proving the same thing.
        state.measuredStreams = r ? r.okCount : 0;
        state.measuredAt = Date.now();
        diary('psiphon-quality', {
            mbit: state.measuredMbit, streams: r ? r.okCount : 0, bytes: r ? r.bytes : 0,
            region: state.serverRegion || state.egressRegion || '-', candidate: state.candidateNumber,
            protocol: state.protocol || '-',
        }, `ظرفیت واقعی این سرور با ${QUALITY_STREAMS} اتصال هم‌زمان: ${state.measuredMbit} مگابیت`);
        return state.measuredMbit;
    } catch (e) {
        diary('psiphon-quality-failed', { error: e.message });
        return 0;
    }
}

/**
 * Below this, the server that answered is not worth keeping. Mbit/s, aggregate, as [measureTunnel]
 * reports it.
 *
 * Measured on one line inside one hour: healthy servers gave 2.2–3.2, and the two that made the
 * tunnel unusable gave 0.4 and — in real use, the session this whole investigation started from —
 * 0.10. There is no overlap between those groups, so the line is drawn well clear of both.
 */
/**
 * CALIBRATED, NOT PICKED. Measured with these exact parameters — six streams, 768 KB total, so
 * the connection setup is a real part of the figure:
 *
 *   · a healthy server on this line   1.62 Mbit/s
 *   · the same probe, longer payload  2.2 – 3.4      (setup amortised, so systematically higher)
 *   · the server the user was stuck on, in real use  0.10 – 0.46
 *
 * 0.9 sits clear of both groups. It has to be BELOW the healthy band and not merely inside it:
 * a floor set at the bottom edge of "good" turns an acceptable server into three redials, which
 * costs the user thirty seconds and two megabytes for nothing.
 */
const MIN_GOOD_MBIT = 0.9;

/** How many servers one connect may draw before settling for what it has. See the search below. */
const MAX_SERVER_ATTEMPTS = 3;

/**
 * Forget which server worked last time, so the next dial picks a different one.
 *
 * WHY THIS IS THE ONLY WAY. Psiphon's replay is what makes a reconnect fast — measured 10.1 s on
 * a first dial against 4.1 s replaying — and it is also what pins a client to a bad server for
 * ever: the session that started this had the SAME French server across two connects an hour
 * apart, `isReplay: true` both times, at 0.10 Mbit/s. Turning replay off through the config does
 * not work; `ReplayCandidateCount` and `ReplayDialParametersTTL` are tactics parameters and were
 * both measured to leave `isReplay` true.
 *
 * What does work is removing the datastore the replay entry lives in. Measured: same directory,
 * replay to US candidate 0 at 2.54 Mbit/s; datastore dropped; next dial NL candidate 5 at
 * 3.1 Mbit/s with `isReplay: false`, three seconds slower to connect.
 *
 * ONLY the datastore directory. `remote_server_list` — the list the core downloaded, which can
 * take a whole session to fetch — sits beside it and survives; the core re-imports it, because
 * what it lost was only its record of having already done so.
 */
function dropReplayState() {
    const dir = ensureDataDir();
    const removed = [];
    for (const candidate of [
        path.join(dir, 'ca.psiphon.PsiphonTunnel.tunnel-core', 'datastore'),
        // The pre-migration layout, for a data directory old enough to predate DataRootDirectory.
        path.join(dir, 'datastore'),
    ]) {
        try {
            if (fs.existsSync(candidate)) { fs.rmSync(candidate, { recursive: true, force: true }); removed.push(candidate); }
        } catch (e) { /* a datastore we cannot remove just means the same server again */ }
    }
    diagnostics.record('replay-dropped', { removed });
    return removed.length > 0;
}

/**
 * How long the whole ladder can take, in seconds — the number a panel must be able to show.
 *
 * Nobody waits patiently through something that looks stuck, and this ladder legitimately runs for
 * minutes: measured here, A failed at its 60 s budget, D at its 45 s, and C connected at 112 s.
 * A progress display that cannot say "rung 3 of 3, 75 seconds" turns a working connect into a
 * user pressing the button again.
 */
function ladderBudgetSeconds(chained) {
    return ladderFor(chained).reduce((n, r) => n + Math.round(r.timeout / 1000), 0);
}

/**
 * Which rung to remember, given the protocol that actually carried the tunnel.
 *
 * Not simply the active rung. `InitialLimitTunnelProtocols` is a preference, so a rung can win on
 * a protocol from a different rung's list — and persisting the active rung then makes the next
 * connect start from a strategy that did not actually work. Both Android field logs hit exactly
 * this: one carrier ended on a fronted protocol while another rung was active.
 */
function winningRung(active, rungs) {
    const p = state.protocol;
    if (!p) return active.name;
    if (PROTOCOLS_FRONTED.includes(p) && rungs.some(r => r.name === 'A')) return 'A';
    if (/^INPROXY/.test(p) && rungs.some(r => r.name === 'C')) return 'C';
    if (PROTOCOLS_DIRECT.includes(p) && rungs.some(r => r.name === 'D')) return 'D';
    return active.name;
}

function stopPsiphon() {
    const was = state.running;
    if (was) {
        diary('psiphon-stop', {
            heldFor: state.since ? `${Math.round((Date.now() - state.since) / 1000)}s` : '0s',
            drops: state.drops, rung: state.rung || '-', protocol: state.protocol || '-',
            sent: state.sent, received: state.received,
        });
    }
    diagnostics.sample(readTrafficCounters());
    diagnostics.record('user-stop', { running: was, connected: state.connected, sent: state.sent, received: state.received });
    clearInterval(trafficTimer); trafficTimer = null;
    sessionId++;
    cancelled = true;
    killProc();
    state.running = false;
    state.connected = false;
    state.stage = 'idle';
    state.rung = null;
    state.detail = '';
    state.since = null;
    return was;
}

function isRunning() { return state.running && !!proc; }

function getStatus() {
    return {
        running: state.running,
        pid: proc ? proc.pid : null,
        connected: state.connected,
        rung: state.rung,
        rungIndex: state.rungIndex,
        rungCount: state.rungCount,
        rungSeconds: state.rungSeconds,
        rungStartedAt: state.rungStartedAt,
        protocol: state.protocol,
        region: state.region,
        egressRegion: state.egressRegion,
        available: state.available.slice(),
        stage: state.stage,
        detail: state.detail,
        since: state.since,
        error: state.error,
        sent: state.sent,
        received: state.received,
        // Stability, as a number the panel and the diary agree on.
        drops: state.drops,
        droppedAt: state.droppedAt || null,
        lastGapSeconds: state.lastGapSeconds || 0,
        refused: state.refused,
        candidateNumber: state.candidateNumber,
        serverRegion: state.serverRegion,
        measuredMbit: state.measuredMbit,
        measuredAt: state.measuredAt || null,
        socksPort: SOCKS_PORT,
        httpPort: HTTP_PORT,
        lastGood: rememberedRung(false),
        serverList: diagnostics.serverListStatus(),
    };
}

function getLogs() { return logs.slice(); }

function getDiagnostics() {
    const nativeFiles = ['notices', 'notices.1', 'ca.psiphon.PsiphonTunnel.tunnel-core/notices', 'ca.psiphon.PsiphonTunnel.tunnel-core/notices.1'];
    return { ...diagnostics.snapshot(), status: getStatus(),
        // Raw core output for THIS run, which is where a failure nothing parses leaves its
        // explanation. 128 KB: enough for a full ladder walk, small enough to hand over.
        coreLog: readTail(CORE_LOG_FILE, 128 * 1024),
        coreNotices: nativeFiles.map(file => ({ file, content: readTail(path.join(PSIPHON_DATA_DIR, file)) })).filter(x => x.content) };
}

/**
 * The bytes Psiphon reports itself, for traffic-feed.js.
 *
 * `{ up, down }` and not `{ sent, received }`: the feed reads `c.up`/`c.down` and drops a sample
 * whose fields are not finite numbers — without a word — so the wrong names mean the engine is
 * never counted at all.
 */
function readTrafficCounters() { return { up: state.sent, down: state.received }; }

/**
 * Does the SOCKS port carry a stream?
 *
 * `Tunnels count=1` is the core's own claim. The tunnel is built on this port, so the rule the
 * rest of the app follows applies: prove the data path before reporting success.
 */
function socksCarriesStream(timeoutMs = 12000) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        const startedAt = Date.now();
        let stage = 'greeting', pending = Buffer.alloc(0), finished = false;
        const finish = (ok, reason) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            sock.destroy();
            diagnostics.record('data-probe', { ok, reason, stage, elapsedMs: Date.now() - startedAt });
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
        sock.on('error', e => finish(false, e.message));
        sock.on('close', () => finish(false, 'socket closed before HTTP response'));
        sock.connect(SOCKS_PORT, '127.0.0.1', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
        sock.on('data', data => {
            if (finished) return;
            pending = Buffer.concat([pending, data]);
            if (pending.length > 16384) return finish(false, 'oversized response');
            if (stage === 'greeting') {
                if (pending.length < 2) return;
                if (pending[0] !== 5 || pending[1] !== 0) return finish(false, 'SOCKS authentication rejected');
                pending = pending.subarray(2);
                stage = 'connect';
                const host = Buffer.from('one.one.one.one', 'utf8');
                sock.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, Buffer.from([0x00, 0x50]),
                ]));
            }
            if (stage === 'connect') {
                if (pending.length < 5) return;
                if (pending[0] !== 5 || pending[1] !== 0) return finish(false, `SOCKS connect rejected: ${pending[1]}`);
                const length = pending[3] === 1 ? 10 : pending[3] === 4 ? 22 : pending[3] === 3 ? 7 + pending[4] : 0;
                if (!length) return finish(false, 'invalid SOCKS address type');
                if (pending.length < length) return;
                pending = pending.subarray(length);
                stage = 'http';
                sock.write('GET / HTTP/1.1\r\nHost: one.one.one.one\r\nConnection: close\r\n\r\n');
            }
            if (stage === 'http' && pending.includes('\r\n')) {
                const valid = /^HTTP\/1\.[01] [1-5]\d{2}(?: |\r)/.test(pending.toString('ascii'));
                finish(valid, valid ? 'HTTP response received' : 'invalid HTTP response');
            }
        });
    });
}

module.exports = {
    startPsiphon, stopPsiphon, isRunning, getStatus, getLogs, isInstalled,
    socksCarriesStream, readTrafficCounters, measureTunnel, dropReplayState,
    getDiagnostics, recordDiagnostic: diagnostics.record,
    SOCKS_PORT, HTTP_PORT, PSIPHON_DATA_DIR, CORE_LOG_FILE,
    binPaths,
    LADDER, FRONTED_REGIONS, ladderBudgetSeconds,
    _internal: { buildConfig, ladderFor, winningRung, rememberedRung, rememberRung, transferUrls, disableTactics, PROTOCOLS_FRONTED, PROTOCOLS_CHAINABLE },
};
