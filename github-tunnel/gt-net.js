// --- GitHub Tunnel: control-plane fetch with an automatic fallback ---
//
// THE PROBLEM
// Setting a session up needs three services that are all reachable-until-they-aren't from
// Iran: GitHub's API, Cloudflare's API, and the broker Worker on workers.dev. When any of
// them is blocked the whole feature dies at "fetch failed" — and it dies precisely when a
// user most needs a tunnel, because they have no working VPN to fix it with. Telling them
// to turn on some other VPN first is not a product.
//
// THE FIX
// The Android app already solved this: a small edge proxy that forwards a request given as
// a query parameter (see emergency/EmergencyInterceptor.kt). This reuses the same,
// already-deployed proxy.
//
// It is a FALLBACK, not a mode. The direct request is always tried first, so nothing is
// slower or routed through a third party when the network is fine; the proxy is used only
// after a direct attempt fails at the network level. That means there is no switch to
// forget to turn off, and no state left behind — which is what was asked for, arrived at
// from the other direction.
//
// SCOPE: control-plane HTTPS only — API calls this app makes about a session. The tunnel's
// own data never touches it.
//
// THE ORDER (2026-09-11): direct → the user's own system proxy → the app's own connected
// engine (Xray's HTTP inbound) → the edge proxy. The edge proxy stopped working from Iran and
// its deployment now answers every request with 402 DEPLOYMENT_DISABLED, so it is the last
// resort, and its own failures are never handed to a caller as if the host had answered.

const VERCEL_PROXY = 'https://mlm-proxy.vercel.app/api?url=';

// --- attempt 3 of 4: the app's own engine ---
//
// Whenever a V2Ray node or a WARP engine (ماسک، وایرگارد، وارپ در وارپ, chained through Xray)
// is connected, Xray listens as an HTTP proxy on 127.0.0.1:20809 and exits outside the block.
// Nothing ever chains Xray into this tunnel, so setup traffic sent there cannot loop back into
// the tunnel it is setting up. MLMVPN_GT_LOCAL_ENGINE_PORT=0 turns it off (the tests do).
// The env var pins it (the tests set 0 to turn the path off); otherwise it is wherever the
// app's Xray serves HTTP right now — «پورت محلی» in Settings can move it off 20809.
// Read once, at load, as it always was: the tests pin it for one module instance and then reset
// the variable for the next.
const LOCAL_ENGINE_PORT_PIN = process.env.MLMVPN_GT_LOCAL_ENGINE_PORT;
function localEnginePort() {
    if (LOCAL_ENGINE_PORT_PIN !== undefined) return Number(LOCAL_ENGINE_PORT_PIN);
    try { return require('../xray-manager').getPorts().http; } catch (e) { return 20809; }
}
let localEngineCheck = { at: 0, up: false };
let localEngineAgentCache = null;

/** Is the app's Xray listening? A quick local connect, remembered for a few seconds. */
function localEngineUp() {
    if (!localEnginePort()) return Promise.resolve(false);
    if (Date.now() - localEngineCheck.at < 5000) return Promise.resolve(localEngineCheck.up);
    return new Promise((resolve) => {
        const net = require('net');
        const s = net.connect({ host: '127.0.0.1', port: localEnginePort() });
        const done = (up) => { s.destroy(); localEngineCheck = { at: Date.now(), up }; resolve(up); };
        s.setTimeout(400, () => done(false));
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
    });
}

function localEngineAgent() {
    if (localEngineAgentCache) return localEngineAgentCache;
    try {
        const { ProxyAgent } = require('undici');
        localEngineAgentCache = new ProxyAgent(`http://127.0.0.1:${localEnginePort()}`);
    } catch (e) {
        localEngineAgentCache = null;
    }
    return localEngineAgentCache;
}

// The edge proxy's own failure — a disabled deployment, a payload over its limit — carries
// this header. It is not the requested host speaking and must never be read as if it were.
function isEdgeProxyFailure(res) {
    try { return !!(res && res.headers && res.headers.get('x-vercel-error')); } catch (e) { return false; }
}

const ALL_PATHS_FAILED =
    'دسترسی به سرویس‌های موردنیاز برقرار نشد: مسیر مستقیم بسته است و مسیر جایگزین هم در دسترس نیست. ' +
    'یکی از موتورها (V2Ray، ماسک، وایرگارد یا وارپ در وارپ) را وصل کنید و دوباره امتحان کنید؛ ' +
    'تنظیم تونل خودکار از همان عبور می‌کند.';

// --- attempt 2 of 3: the proxy the user already turned on ---
//
// Node's fetch does NOT read Windows' proxy settings. So a user who switches the app's
// proxy on precisely BECAUSE github.com / api.cloudflare.com are unreachable gets no
// benefit from it here: every control-plane call still goes out direct, fails, and lands
// on the third-party edge proxy — or fails outright. That is most of the "sometimes it
// works, sometimes it doesn't" in tunnel setup, and it looks random because it depends on
// which of the three hosts happens to be reachable at that moment.
//
// So when the system proxy is on and is NOT one of our own listeners, route the retry
// through it. Our own ports are excluded deliberately: sending the tunnel's setup traffic
// into the tunnel it is still setting up is the loop that cannot complete.
const OWN_PROXY_PORTS_FIXED = ['20810', '20812', '20813'];
function ownProxyPorts() {
    const set = new Set(OWN_PROXY_PORTS_FIXED);
    try { const p = require('../xray-manager').getPorts(); set.add(String(p.http)); set.add(String(p.socks)); } catch (e) { set.add('20809'); }
    return set;
}
const WIN_PROXY_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

let proxyAgentCache = { server: '', agent: null };

/** The system proxy's "host:port", or '' when it is off / ours / unreadable. */
function systemProxyServer() {
    if (process.platform !== 'win32') return '';
    try {
        const { execSync } = require('child_process');
        const out = execSync(`reg query "${WIN_PROXY_KEY}" /v ProxyEnable`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/i);
        if (!m || !parseInt(m[1], 16)) return '';
        const s = execSync(`reg query "${WIN_PROXY_KEY}" /v ProxyServer`,
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const sm = s.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
        const server = sm ? sm[1].trim() : '';
        // A per-protocol value ("http=host:port;https=…") — take the https/http entry.
        const picked = server.includes('=')
            ? (server.match(/https?=([^;]+)/i) || [])[1] || ''
            : server;
        if (!picked) return '';
        const port = picked.split(':').pop();
        if (ownProxyPorts().has(port)) return '';
        return picked;
    } catch (e) {
        return '';
    }
}

function systemProxyAgent() {
    const server = systemProxyServer();
    if (!server) return null;
    if (proxyAgentCache.server === server && proxyAgentCache.agent) return proxyAgentCache.agent;
    try {
        const { ProxyAgent } = require('undici');
        proxyAgentCache = { server, agent: new ProxyAgent(`http://${server}`) };
        return proxyAgentCache.agent;
    } catch (e) {
        return null;
    }
}

// A failed direct attempt is remembered briefly so a burst of calls during setup doesn't
// each pay the full timeout before falling back.
let directFailedUntil = 0;
const DIRECT_COOLDOWN_MS = 60 * 1000;

function proxied(url) {
    return VERCEL_PROXY + encodeURIComponent(url);
}

/** True for the kind of failure that means "couldn't reach the host", as opposed to the
 *  host answering with an error.
 *
 *  An HTTP status never reaches this function: fetch() RESOLVES for a 403, so a refusal is
 *  not an error here at all. Refusals are handled by `fallbackOnStatus` in gtFetch. */
function isNetworkFailure(err) {
    // A timeout IS a "couldn't reach the host" failure here — a filtered domain black-holes
    // the connection rather than refusing it, so hitting the deadline is the normal way it
    // fails and must trigger the fallback rather than propagate.
    const name = (err && err.name) || '';
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    const m = ((err && err.message) || '').toLowerCase();
    const cause = ((err && err.cause && (err.cause.code || err.cause.message)) || '').toString().toLowerCase();
    return /fetch failed|network|econnreset|enotfound|etimedout|econnrefused|socket hang up|aborted|timeout/.test(m + ' ' + cause);
}

/**
 * fetch(), with the edge proxy as a second attempt.
 * Same signature as fetch, so call sites read normally.
 *
 * Extra option `fallbackOnStatus: [403, 451]` — see BLOCKED-BY-STATUS below.
 */
async function gtFetch(url, options = {}) {
    const useProxyFirst = Date.now() < directFailedUntil;

    // BLOCKED BY STATUS, not by silence.
    //
    // A sanctions geo-block is not a network failure: pkgs.tailscale.com sits behind a CDN
    // that answers an Iranian IP with a perfectly well-formed 403. fetch() resolves, the
    // catch below never runs, and the response is returned as if the host had spoken its
    // mind about the request — so the direct attempt short-circuits the two fallbacks that
    // exist for exactly this case. That is how the engine download died at "(403)" while
    // the edge proxy sitting one line away could fetch the file fine.
    //
    // OPT-IN, per call. A 403 from the GitHub or Cloudflare API is a real answer ABOUT THE
    // REQUEST — a missing workflow scope, a spent allowance — and those callers must keep
    // receiving it untouched (gt-deployer.js and gt-allocator.js both read it). Only a
    // caller that knows its host has no legitimate reason to say 403 passes this.
    const { fallbackOnStatus, ...fetchOptions } = options;
    const blockedStatuses = new Set(fallbackOnStatus || []);
    const isBlocked = (res) => blockedStatuses.has(res.status);
    // A response walked away from still holds its socket until the body is drained.
    const discard = (res) => {
        try { if (res && res.body && !res.bodyUsed) res.body.cancel().catch(() => {}); } catch (e) {}
    };
    // The ORIGIN's verdict, kept in case every fallback also fails. Reporting the proxy's
    // version of the failure instead would point the user at the wrong problem.
    let blockedRes = null;

    // Each attempt gets its OWN deadline.
    //
    // Passing a single `signal` in and reusing it for both attempts silently disables the
    // fallback: the direct attempt to a filtered host runs until the signal fires, and the
    // proxy attempt then starts with an already-aborted signal and dies instantly. The
    // symptom is a plain fetch error that looks like the proxy is unreachable, when in
    // fact it was never really tried. Callers pass `timeoutMs` and get a fresh timeout per
    // attempt; an explicitly supplied `signal` still works and is combined with it.
    const { timeoutMs, signal: callerSignal, ...rest } = fetchOptions;
    const attemptOptions = () => {
        if (!timeoutMs) return callerSignal ? { ...rest, signal: callerSignal } : rest;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const signal = callerSignal && AbortSignal.any
            ? AbortSignal.any([callerSignal, timeoutSignal])
            : timeoutSignal;
        return { ...rest, signal };
    };

    if (!useProxyFirst) {
        try {
            const res = await fetch(url, attemptOptions());
            if (isBlocked(res)) {
                // Deliberately NOT setting directFailedUntil: that cooldown is global across
                // every host, and one sanctioned CDN refusing us must not shove unrelated
                // GitHub and Cloudflare calls onto the third-party proxy for a minute.
                blockedRes = res;
            } else {
                directFailedUntil = 0;
                return res;
            }
        } catch (e) {
            if (!isNetworkFailure(e)) throw e;
            directFailedUntil = Date.now() + DIRECT_COOLDOWN_MS;
        }
    }

    // Between direct and the third-party hop: the user's own proxy, if they have one on.
    const agent = systemProxyAgent();
    if (agent) {
        try {
            const res = await fetch(url, { ...attemptOptions(), dispatcher: agent });
            if (isBlocked(res)) {
                // The user's own proxy exits somewhere just as sanctioned. One hop left.
                discard(res);
            } else {
                try { Object.defineProperty(res, 'viaSystemProxy', { value: true, enumerable: false }); } catch (e2) {}
                discard(blockedRes);
                return res;
            }
        } catch (e) {
            if (!isNetworkFailure(e)) throw e;
        }
    }

    // The app's own connected engine, if any.
    if (await localEngineUp()) {
        const local = localEngineAgent();
        if (local) {
            try {
                const res = await fetch(url, { ...attemptOptions(), dispatcher: local });
                if (isBlocked(res)) {
                    // That engine exits somewhere just as sanctioned. One hop left.
                    discard(res);
                } else {
                    try { Object.defineProperty(res, 'viaLocalEngine', { value: true, enumerable: false }); } catch (e2) {}
                    discard(blockedRes);
                    return res;
                }
            } catch (e) {
                if (!isNetworkFailure(e)) throw e;
            }
        }
    }

    try {
        const res = await fetch(proxied(url), attemptOptions());
        if (isEdgeProxyFailure(res)) {
            // The edge proxy itself is down or refused the request. Report the origin's
            // answer when there is one, otherwise the plain fact that no path worked.
            discard(res);
            if (blockedRes) return blockedRes;
            throw new Error(ALL_PATHS_FAILED);
        }
        // Marked so callers can tell a real answer from the host apart from whatever came
        // back through a hop we do not control. It matters most for authentication: if the
        // proxy does not forward the Authorization header, GitHub answers 401, and reading
        // that as "your token is dead" sends the user off to disconnect and reconnect an
        // account that was never the problem. See gt-github.js.
        if (blockedRes && !res.ok) {
            // Everything refused. The origin's own answer is the one that names the cause.
            discard(res);
            return blockedRes;
        }
        try { Object.defineProperty(res, 'viaFallback', { value: true, enumerable: false }); } catch (e2) {}
        discard(blockedRes);
        return res;
    } catch (e) {
        if (e && e.message === ALL_PATHS_FAILED) throw e;
        // Every path is gone: report the original problem, not the proxy's version of it.
        if (blockedRes) return blockedRes;
        throw new Error(ALL_PATHS_FAILED);
    }
}

/** Lets callers show whether the fallback is currently carrying traffic. */
function isUsingFallback() {
    return Date.now() < directFailedUntil;
}

module.exports = { gtFetch, isUsingFallback, VERCEL_PROXY };
