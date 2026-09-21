// --- «ام‌ال‌ام استور» — getting bytes in from a network that does not want them to arrive ---
//
// Measured from this machine on 2026-09-14, the day this was written:
//
//   github.com release pages        200, ~7 s      (reachable, slow)
//   dist.torproject.org             no answer      (blocked outright)
//   pkgs.tailscale.com downloads    403            (sanctions page, not an answer about the file)
//   api.github.com                  4 of 60 left   (the per-IP quota is shared with a whole NAT)
//   a 20.9 MB release asset         142 s through گف
//
// So there is no single route, and the app's control-plane fetch (gt-net) is the wrong tool: it
// knows only Xray's port, its last resort is an edge proxy that has been answering 402 since
// 2026-09-11, and it reads the Windows proxy with a synchronous exec on Electron's main thread.
//
// ROUTES, in order, each tried before the next:
//   1. direct — which already rides a full tunnel when one is up
//   2. the user's own system proxy, when it is not one of ours
//   3. every local engine that is listening: V2Ray, گف, سایفون, تور, لنترن, تونل گیت‌هاب
//
// And for a big file on a line that drops:
//   * RESUME with a Range request rather than start over — the bytes already on disk are hashed
//     first, so the digest still covers the whole file;
//   * a STALL (no bytes for 45 s) is a dead route, not a slow one: the next route resumes from where
//     this one stopped;
//   * 403/451/429/5xx are ROUTE failures (a sanctions page, a gateway giving up) — try elsewhere;
//     404/410 are URL failures — try the next mirror, not the same URL over another route;
//   * the digest is checked against the one the caller already trusts, and a mismatch deletes the
//     file. Nothing downloaded here is ever returned unverified.

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFile } = require('child_process');

let undiciMod = null;
const undici = () => (undiciMod || (undiciMod = require('undici')));

const USER_AGENT = (() => {
    let v = '0';
    try { v = require('../package.json').version; } catch (e) { /* not packaged */ }
    return 'MLM-VPN-Store/' + v;
})();

// ── routes ────────────────────────────────────────────────────────────────────

function portOpen(port, ms = 400) {
    return new Promise((resolve) => {
        if (!port) return resolve(false);
        const sock = net.connect({ host: '127.0.0.1', port });
        let done = false;
        const end = (ok) => { if (!done) { done = true; try { sock.destroy(); } catch (e) { } resolve(ok); } };
        sock.setTimeout(ms, () => end(false));
        sock.once('connect', () => end(true));
        sock.once('error', () => end(false));
    });
}

/** The local engines that can carry HTTPS, with the port each one serves right now. */
function enginePorts() {
    const out = [];
    const add = (id, label, port) => { if (port && !out.some((x) => x.port === port)) out.push({ id, label, port }); };
    let xrayHttp = 20809;
    try { xrayHttp = require('../xray-manager').getPorts().http || 20809; } catch (e) { /* not built in */ }
    add('xray', 'V2Ray', xrayHttp);
    // گف first among the fronts: on this line it is the one that connects when the others do not.
    add('geph', 'گف', 20851);
    add('psiphon', 'سایفون', 20831);
    add('tor', 'تور', 20822);        // HTTPTunnelPort — CONNECT only, which is all HTTPS needs
    add('lantern', 'لنترن', 20841);
    add('github', 'تونل گیت‌هاب', 20813);
    return out;
}

const OWN_PORTS = () => new Set(enginePorts().map((e) => String(e.port)).concat(['20810', '20812']));

/** "host:port" of the Windows proxy when it is on and not ours — asynchronously. */
function systemProxy() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') return resolve('');
        const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
        execFile('reg', ['query', key], { windowsHide: true, timeout: 5000 }, (err, out) => {
            if (err) return resolve('');
            const text = String(out || '');
            const en = text.match(/ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i);
            if (!en || !parseInt(en[1], 16)) return resolve('');
            const sv = text.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
            let server = sv ? sv[1].trim() : '';
            if (server.includes('=')) server = (server.match(/https?=([^;]+)/i) || [])[1] || '';
            if (!server || OWN_PORTS().has(server.split(':').pop())) return resolve('');
            resolve(server);
        });
    });
}

const agents = new Map();
function agentFor(proxyUrl) {
    if (!agents.has(proxyUrl)) agents.set(proxyUrl, new (undici().ProxyAgent)(proxyUrl));
    return agents.get(proxyUrl);
}

/** Every route worth trying right now, cheapest first. */
async function routes() {
    const list = [{ id: 'direct', label: 'مستقیم', dispatcher: undefined }];
    // A proxy named by the environment goes FIRST: it is set by someone who knows this machine's
    // network better than any heuristic here (the maintainer's own tooling uses it to reach the
    // hosts that refuse Iranian addresses outright).
    const forced = String(process.env.MLMVPN_STORE_PROXY || '').trim();
    if (/^https?:\/\//i.test(forced)) list.unshift({ id: 'forced', label: 'پروکسی تعیین‌شده', dispatcher: agentFor(forced) });
    const sys = await systemProxy();
    if (sys) list.push({ id: 'system', label: 'پروکسی سیستم', dispatcher: agentFor('http://' + sys) });
    const engines = enginePorts();
    const open = await Promise.all(engines.map((e) => portOpen(e.port)));
    engines.forEach((e, i) => {
        if (open[i]) list.push({ id: 'engine:' + e.id, label: e.label, dispatcher: agentFor('http://127.0.0.1:' + e.port) });
    });
    return list;
}

// ── classification ────────────────────────────────────────────────────────────

const ROUTE_STATUSES = new Set([403, 407, 408, 425, 429, 451, 500, 502, 503, 504, 520, 521, 522, 523, 524]);
const URL_STATUSES = new Set([404, 410]);

class RouteError extends Error { constructor(msg) { super(msg); this.route = true; } }
class UrlError extends Error { constructor(msg) { super(msg); this.url = true; } }

// ── small fetches ─────────────────────────────────────────────────────────────

/**
 * A small text resource (a manifest, a feed, a worker script) through the first route that
 * answers. `maxBytes` guards against a captive portal handing back a page of unbounded size.
 */
async function fetchText(url, { timeoutMs = 25000, maxBytes = 8 * 1024 * 1024, headers = {}, signal } = {}) {
    let lastErr = null;
    for (const route of await routes()) {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        const onAbort = () => ctl.abort();
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        try {
            const res = await undici().fetch(url, {
                dispatcher: route.dispatcher, redirect: 'follow', signal: ctl.signal,
                headers: Object.assign({ 'User-Agent': USER_AGENT }, headers),
            });
            if (URL_STATUSES.has(res.status)) {
                try { await res.body?.cancel(); } catch (e) { }
                throw new UrlError('HTTP ' + res.status);
            }
            if (!res.ok) {
                try { await res.body?.cancel(); } catch (e) { }
                throw new RouteError('HTTP ' + res.status);
            }
            const chunks = [];
            let got = 0;
            for await (const chunk of res.body) {
                got += chunk.length;
                if (got > maxBytes) throw new RouteError('پاسخ بزرگ‌تر از حد انتظار بود');
                chunks.push(Buffer.from(chunk));
            }
            return { text: Buffer.concat(chunks).toString('utf8'), route: route.label, status: res.status, url: res.url || url };
        } catch (e) {
            if (e && e.url) throw e;
            if (signal && signal.aborted) throw new Error('لغو شد');
            lastErr = e;
        } finally {
            clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
        }
    }
    throw new Error(describeFailure(lastErr));
}

function describeFailure(e) {
    const m = (e && e.message) || '';
    if (/HTTP 403|HTTP 451/.test(m)) return 'میزبان به این آدرس جواب رد داد (معمولاً تحریم) و هیچ مسیر دیگری هم باز نبود. یکی از موتورها را وصل کنید و دوباره بزنید.';
    if (/abort|timeout/i.test(m)) return 'در زمان مقرر جوابی نیامد — مستقیم و از همهٔ موتورهای روشن امتحان شد.';
    return 'به میزبان نرسید (' + (m || 'خطای شبکه') + ') — مستقیم و از همهٔ موتورهای روشن امتحان شد.';
}

// ── downloads ─────────────────────────────────────────────────────────────────

function hashExisting(file) {
    return new Promise((resolve) => {
        const h = crypto.createHash('sha256');
        let bytes = 0;
        fs.createReadStream(file)
            .on('data', (c) => { bytes += c.length; h.update(c); })
            .on('error', () => resolve({ h: crypto.createHash('sha256'), bytes: 0, failed: true }))
            .on('end', () => resolve({ h, bytes }));
    });
}

function waitDrain(ws) { return new Promise((r) => ws.once('drain', r)); }
function closeStream(ws) { return new Promise((r) => ws.end(r)); }

/**
 * One attempt over one route. Resolves `{ bytes, sha256 }` for a complete body; throws RouteError /
 * UrlError / Error otherwise. Resumes from `part` when it already holds some of the file.
 */
async function attempt(url, route, part, { size, onProgress, signal, stallMs, headersMs }) {
    let have = 0;
    try { have = fs.statSync(part).size; } catch (e) { have = 0; }
    if (size && have >= size) { try { fs.unlinkSync(part); } catch (e) { } have = 0; }

    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const headerTimer = setTimeout(() => ctl.abort(), headersMs);

    let ws = null;
    let stall = null;
    try {
        const headers = { 'User-Agent': USER_AGENT, 'Accept-Encoding': 'identity' };
        if (have > 0) headers.Range = 'bytes=' + have + '-';
        const res = await undici().fetch(url, { dispatcher: route.dispatcher, redirect: 'follow', signal: ctl.signal, headers });
        clearTimeout(headerTimer);

        if (URL_STATUSES.has(res.status)) { try { await res.body?.cancel(); } catch (e) { } throw new UrlError('HTTP ' + res.status); }
        if (res.status === 416) { try { await res.body?.cancel(); } catch (e) { } try { fs.unlinkSync(part); } catch (e) { } throw new RouteError('HTTP 416'); }
        if (!(res.status === 200 || res.status === 206)) {
            try { await res.body?.cancel(); } catch (e) { }
            throw (ROUTE_STATUSES.has(res.status) ? new RouteError('HTTP ' + res.status) : new UrlError('HTTP ' + res.status));
        }

        let h;
        let got;
        if (res.status === 206 && have > 0) {
            const cr = String(res.headers.get('content-range') || '');
            const start = Number((cr.match(/bytes\s+(\d+)-/) || [])[1]);
            if (start !== have) { try { await res.body?.cancel(); } catch (e) { } try { fs.unlinkSync(part); } catch (e) { } throw new RouteError('بازهٔ ادامهٔ دانلود نامعتبر بود'); }
            const prev = await hashExisting(part);
            if (prev.failed || prev.bytes !== have) { try { await res.body?.cancel(); } catch (e) { } try { fs.unlinkSync(part); } catch (e) { } throw new RouteError('فایل نیمه‌کاره خوانده نشد'); }
            h = prev.h; got = have;
            ws = fs.createWriteStream(part, { flags: 'a' });
        } else {
            // 200: the server ignored the range (or there was none) — start clean.
            h = crypto.createHash('sha256'); got = 0;
            ws = fs.createWriteStream(part, { flags: 'w' });
        }
        const total = size || (Number(res.headers.get('content-length')) + (res.status === 206 ? have : 0)) || 0;

        let lastByteAt = Date.now();
        stall = setInterval(() => { if (Date.now() - lastByteAt > stallMs) ctl.abort(); }, 2000);

        for await (const chunk of res.body) {
            lastByteAt = Date.now();
            const buf = Buffer.from(chunk);
            got += buf.length;
            if (size && got > size) throw new UrlError('فایل از اندازهٔ اعلام‌شده بزرگ‌تر است');
            h.update(buf);
            if (!ws.write(buf)) await waitDrain(ws);
            if (onProgress) onProgress(got, total);
        }
        await closeStream(ws); ws = null;
        if (size && got !== size) throw new RouteError('دانلود پیش از کامل شدن قطع شد');
        return { bytes: got, sha256: h.digest('hex') };
    } catch (e) {
        if (signal && signal.aborted) { const c = new Error('لغو شد'); c.cancelled = true; throw c; }
        if (e && (e.url || e.route)) throw e;
        // Network-level: reset, refused, a stall abort, a TLS failure on an interception box.
        throw new RouteError((e && e.message) || 'خطای شبکه');
    } finally {
        clearTimeout(headerTimer);
        if (stall) clearInterval(stall);
        if (ws) { try { await closeStream(ws); } catch (e) { } }
        if (signal) signal.removeEventListener('abort', onAbort);
    }
}

/**
 * Download to `dest`, verified. `sha256` is REQUIRED — this function has no mode that returns bytes
 * it could not check.
 *
 * Returns `{ file, bytes, route, url }`. Throws with `.code`:
 *   'hash-mismatch'  every mirror served bytes that are not the file we trust
 *   'unreachable'    no route reached any mirror
 *   'cancelled'
 */
async function download({ urls, sha256, size = 0, dest, onProgress, onRoute, signal, stallMs = 45000, headersMs = 30000 }) {
    if (!/^[0-9a-f]{64}$/.test(String(sha256 || ''))) throw new Error('بدون هش مورد اعتماد هیچ دانلودی انجام نمی‌شود.');
    if (fs.existsSync(dest)) {
        // A previous run already verified this exact file (the cache is content-addressed).
        const prev = await hashExisting(dest);
        if (!prev.failed && prev.h.digest('hex') === sha256) return { file: dest, bytes: prev.bytes, route: 'حافظهٔ محلی', url: '' };
        try { fs.unlinkSync(dest); } catch (e) { }
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    let lastErr = null;
    let mismatches = 0;

    for (const url of urls || []) {
        let urlDead = false;
        for (const route of await routes()) {
            if (signal && signal.aborted) { const c = new Error('لغو شد'); c.code = 'cancelled'; throw c; }
            if (onRoute) onRoute(route.label, url);
            try {
                const out = await attempt(url, route, part, { size, onProgress, signal, stallMs, headersMs });
                if (out.sha256 !== sha256) {
                    // Not a route problem and not retryable on this URL: the bytes are wrong.
                    mismatches++;
                    try { fs.unlinkSync(part); } catch (e) { }
                    urlDead = true;
                    break;
                }
                fs.renameSync(part, dest);
                return { file: dest, bytes: out.bytes, route: route.label, url };
            } catch (e) {
                if (e && e.cancelled) { const c = new Error('لغو شد'); c.code = 'cancelled'; throw c; }
                lastErr = e;
                if (e && e.url) { urlDead = true; break; }
                // RouteError: keep the .part and let the next route resume it.
            }
        }
        if (urlDead) { try { fs.unlinkSync(part); } catch (e) { } continue; }
    }

    try { fs.unlinkSync(part); } catch (e) { }
    if (mismatches) {
        const err = new Error('فایل دریافت شد اما هشش با نسخهٔ مورد اعتماد یکی نیست — پاک شد و نصب نمی‌شود.');
        err.code = 'hash-mismatch';
        throw err;
    }
    const err = new Error(describeFailure(lastErr));
    err.code = 'unreachable';
    throw err;
}

module.exports = { routes, enginePorts, systemProxy, fetchText, download, USER_AGENT };
