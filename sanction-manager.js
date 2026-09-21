'use strict';

/**
 * «تحریم‌شکن» — reach the services that refuse an Iranian address, and nothing else.
 *
 * ── What this is NOT, any more ────────────────────────────────────────────────────────────────
 *
 * The first version of this feature owned a relay in the UAE: an nginx SNI proxy
 * with a DNS server beside it, and the switch pointed the machine's own resolvers at that server so
 * it could answer with the relay's address for allowlisted domains and the truth for everything
 * else. That server is gone. Every line that addressed it has been removed rather than left to look
 * like a feature — including the system-DNS takeover, which was the riskiest thing this app did:
 * it rewrote the adapters' resolver list and restored it from a state file afterwards, so a crash
 * at the wrong moment left the machine pointed at an address that no longer answers.
 *
 * What survives is the part that was never about the relay: deciding what is actually wrong with a
 * destination. A site that refuses you because of where you are is a different problem from a site
 * the network refuses to reach, and only the first one is this feature's business.
 *
 * ── What it is now ────────────────────────────────────────────────────────────────────────────
 *
 * A chooser over the engines the app already has. The user names the applications and sites they
 * need, this measures which engines can actually reach them, and the traffic of those — and only
 * those — is carried by the engine they pick. Everything else keeps going out the ordinary way,
 * which is the whole point: a bank, an Iranian site and a game have nothing to gain from a detour
 * and plenty to lose.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

function getUnpackedDir() {
    // In a packaged build the data folder lives beside the resources, not inside the asar.
    try {
        const p = process.resourcesPath && path.join(process.resourcesPath, 'app');
        if (p && fs.existsSync(p)) return p;
    } catch (e) { /* not packaged */ }
    return __dirname;
}

const DATA_DIR = path.join(getUnpackedDir(), 'data');
const DOMAINS_FILE = path.join(DATA_DIR, 'sanction-domains.json');
const CONFIG_FILE = path.join(DATA_DIR, 'sanction-config.json');
const UNSUPPORTED_LOG = path.join(DATA_DIR, 'sanction-unsupported.log');

function loadJson(file, def) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return def; }
}

function saveJson(file, value) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
        return true;
    } catch (e) { return false; }
}

/**
 * The user's own choices, and the only settings this feature has.
 *
 * No relay address and no DNS server: there is nothing of ours left to address. `targets` is what
 * the user asked to reach — applications by executable, sites by name — and `engine` is which of
 * the app's engines they chose to carry them.
 */
function getConfig() {
    const c = loadJson(CONFIG_FILE, {});
    return {
        engine: c.engine || null,              // 'dedidns' | 'lantern' | 'gateway'
        enabled: !!c.enabled,
        apps: Array.isArray(c.apps) ? c.apps : [],        // ['chrome.exe', …]
        sites: Array.isArray(c.sites) ? c.sites : [],     // ['openai.com', …]
        lastCheck: c.lastCheck || null,
        // A FLOOR, not a default. The value on disk is whatever the relay-era config left there —
        // 6000 — and it won over the new default, which is why two of three services came back
        // `unknown`: gemini answers in 7.0 s on this line and chatgpt in 1.4 s to 6.0 s depending on
        // the minute. A probe shorter than the answer reports a working site as broken.
        detection: { timeoutMs: Math.max(12000, Number((c.detection || {}).timeoutMs) || 0) },
    };
}

function setConfig(patch) {
    const next = Object.assign(getConfig(), patch || {});
    saveJson(CONFIG_FILE, next);
    return next;
}

/** The shipped list of services and the domains that belong to each. Still useful as suggestions. */
function getDomains() { return loadJson(DOMAINS_FILE, {}); }

/**
 * The shipped services, flattened out of their categories.
 *
 * The file's top level is CATEGORIES ('ai', 'gaming_login', …), each holding an array of services —
 * not services directly. Reading it as the latter produced a "service" whose `domains` were service
 * objects, and the panel then called `.toLowerCase()` on one of them.
 *
 * `_meta` and `blocked_download` are skipped: the first is documentation and the second is a list of
 * glob patterns, handled by [isBlockedDownload].
 */
function listServices() {
    const d = getDomains();
    const out = [];
    for (const [category, value] of Object.entries(d)) {
        if (category.startsWith('_') || category === 'blocked_download') continue;
        if (!Array.isArray(value)) continue;
        for (const svc of value) {
            if (!svc || typeof svc !== 'object') continue;
            const domains = (Array.isArray(svc.domains) ? svc.domains : [])
                .filter(x => typeof x === 'string' && x.trim())
                .map(x => x.trim().toLowerCase());
            if (!domains.length) continue;
            out.push({
                name: String(svc.name || domains[0]),
                category,
                tier: svc.tier || 'test',
                domains,
                vpnDetect: !!svc.vpnDetect,
            });
        }
    }
    return out;
}

/** Which shipped service owns a domain (exact or subdomain). */
function serviceForDomain(domain) {
    const dl = String(domain).toLowerCase();
    return listServices().find(s => s.domains.some(d => {
        const dd = String(d).toLowerCase();
        return dl === dd || dl.endsWith('.' + dd);
    }));
}

function isInAllowlist(domain) { return !!serviceForDomain(domain); }

// ── Probes ─────────────────────────────────────────────────────────────────
//
// Two layers, because they fail differently and the difference is the diagnosis: a TCP connection
// that never completes is the network refusing to carry you, while a completed connection answered
// with 403 is the site refusing to serve you. Only the second one is a sanction.

function tcpConnect(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const s = new net.Socket();
        const t0 = Date.now();
        let done = false;
        const end = (ok, reason) => {
            if (done) return;
            done = true;
            try { s.destroy(); } catch (e) { /* gone */ }
            resolve({ ok, reason, ms: Date.now() - t0 });
        };
        s.setTimeout(timeoutMs, () => end(false, 'timeout'));
        s.once('error', (e) => end(false, e.code === 'ECONNRESET' ? 'reset' : (e.code || 'error')));
        s.connect(port, host, () => end(true, null));
    });
}

/**
 * A TLS handshake and one HTTP request, optionally through a SOCKS5 port.
 *
 * `connectHost` and `servername` are separate arguments on purpose: reaching an address while
 * presenting a different name is the whole mechanism this feature used to rely on, and it is still
 * how the state of a destination is told apart from the state of a route.
 */
function httpsProbe({ connectHost, connectPort = 443, servername, timeoutMs = 8000, socksPort = null }) {
    return new Promise((resolve) => {
        const t0 = Date.now();
        let done = false;
        let raw = null, secure = null;
        const end = (r) => {
            if (done) return;
            done = true;
            try { if (secure) secure.destroy(); } catch (e) { /* gone */ }
            try { if (raw) raw.destroy(); } catch (e) { /* gone */ }
            resolve(Object.assign({ ms: Date.now() - t0 }, r));
        };
        const timer = setTimeout(() => end({ ok: false, reason: 'timeout' }), timeoutMs);

        const startTls = (socket) => {
            secure = tls.connect({
                socket, servername,
                // The certificate is not the question — reachability is. A chain this machine does
                // not trust would otherwise be reported as a blocked site.
                rejectUnauthorized: false,
            });
            secure.once('secureConnect', () => {
                secure.write(`HEAD / HTTP/1.1\r\nHost: ${servername}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n`);
            });
            secure.once('data', (b) => {
                clearTimeout(timer);
                const m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(String(b));
                end({ ok: true, status: m ? Number(m[1]) : null });
            });
            secure.once('error', (e) => { clearTimeout(timer); end({ ok: false, reason: e.code === 'ECONNRESET' ? 'reset' : (e.code || 'tls') }); });
            secure.once('close', () => { clearTimeout(timer); end({ ok: false, reason: 'closed' }); });
        };

        raw = new net.Socket();
        raw.once('error', (e) => { clearTimeout(timer); end({ ok: false, reason: e.code || 'error' }); });

        if (!socksPort) {
            raw.connect(connectPort, connectHost, () => startTls(raw));
            return;
        }

        // Through a local SOCKS5 port, BY NAME. The name has to travel to the exit: resolved here
        // it would be whatever this line answers, which for a filtered domain is a sinkhole.
        let stage = 0;
        raw.connect(socksPort, '127.0.0.1', () => raw.write(Buffer.from([0x05, 0x01, 0x00])));
        raw.on('data', (d) => {
            if (stage === 0) {
                if (d[0] !== 0x05 || d[1] !== 0x00) { clearTimeout(timer); return end({ ok: false, reason: 'socks' }); }
                stage = 1;
                const h = Buffer.from(servername, 'utf8');
                return raw.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h,
                    Buffer.from([connectPort >> 8, connectPort & 0xff]),
                ]));
            }
            if (stage === 1) {
                if (d[0] !== 0x05 || d[1] !== 0x00) { clearTimeout(timer); return end({ ok: false, reason: 'socks-refused' }); }
                stage = 2;
                raw.removeAllListeners('data');
                return startTls(raw);
            }
        });
    });
}

/**
 * What is actually wrong with this destination, reached directly.
 *
 * The four answers are different problems with different owners:
 *   open        nothing is wrong
 *   filtered    the network will not carry you there — a VPN's job, not this feature's
 *   sanctioned  the site itself refuses your address — this feature's job
 *   unknown     neither layer said anything conclusive
 */
function classifyDirect(probeTcp, probeHttps) {
    if (probeTcp.ok && probeHttps.ok && probeHttps.status && probeHttps.status < 400) return { state: 'open' };
    if (!probeTcp.ok && ['reset', 'timeout', 'ECONNREFUSED'].includes(probeTcp.reason)) {
        return { state: 'filtered', reason: probeTcp.reason };
    }
    if (probeHttps.ok && probeHttps.status && [403, 451].includes(probeHttps.status)) {
        return { state: 'sanctioned', status: probeHttps.status };
    }
    if (probeTcp.ok && !probeHttps.ok && probeHttps.reason === 'reset') {
        return { state: 'filtered', reason: 'sni-reset' };
    }
    return { state: 'unknown', tcp: probeTcp.reason, https: probeHttps.reason || probeHttps.status };
}

/**
 * The shipped policy list: heavy downloads are refused whatever the route.
 *
 * `blocked_download.patterns` are globs — `*.steamcontent.com`, `*.epicgames.com/*download*` — so
 * they are matched as patterns rather than compared as names. Only the host part is considered,
 * because that is all a domain check has.
 */
function isBlockedDownload(domain) {
    const d = getDomains();
    const patterns = (d && d.blocked_download && d.blocked_download.patterns) || [];
    const host = String(domain || '').trim().toLowerCase();
    if (!host) return false;
    return patterns.some((raw) => {
        const p = String(raw || '').toLowerCase().split('/')[0];   // drop any path part
        if (!p) return false;
        if (!p.includes('*')) return host === p || host.endsWith('.' + p);
        const rx = new RegExp('^' + p.split('*').map(x => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        return rx.test(host);
    });
}

/** One destination, reached directly. No engine involved. */
async function testDirect(domain, timeoutMs) {
    const t = timeoutMs || getConfig().detection.timeoutMs;
    if (isBlockedDownload(domain)) {
        return { domain, state: 'blocked_download', note: 'دانلود طبق سیاست بسته است' };
    }
    const [tcp, https] = await Promise.all([
        tcpConnect(domain, 443, t),
        httpsProbe({ connectHost: domain, servername: domain, timeoutMs: t }),
    ]);
    const cls = classifyDirect(tcp, https);
    const svc = serviceForDomain(domain);

    // "It answered normally" is not "it will serve you".
    //
    // Measured: gemini.google.com returns 200 to an anonymous request on every path, while the user
    // is refused with 403 the moment they are signed in — Google applies the country rule to the
    // ACCOUNT. There is no anonymous request that reveals this, so the honest report is that the
    // page is reachable and this test cannot see the refusal. The shipped list is what says the
    // service refuses Iranian addresses at all; it is not evidence about this particular minute,
    // so it is not reported as «تحریم» either.
    if (cls.state === 'open' && svc) {
        return Object.assign({
            domain, ms: https.ms, state: 'open_listed', status: https.status || null,
            service: svc.name,
            note: 'صفحه باز شد، ولی این سرویس تحریم را روی حساب کاربری اعمال می‌کند و این آزمون بدون حساب است.',
        }, svc.vpnDetect ? { vpnDetect: true } : {});
    }

    return Object.assign({ domain, ms: https.ms }, cls, svc ? { service: svc.name } : {}, svc && svc.vpnDetect ? {
        vpnDetect: true,
        vpnDetectNote: 'این سرویس VPN را فعالانه تشخیص می‌دهد: ورود معمولاً کار می‌کند، ولی ثبت‌نام با آی‌پی سرور رد می‌شود.',
    } : {});
}

/** One destination, reached through one engine's local SOCKS port. */
async function testVia(domain, socksPort, timeoutMs) {
    const t = timeoutMs || getConfig().detection.timeoutMs;
    const r = await httpsProbe({ connectHost: domain, servername: domain, timeoutMs: t, socksPort });
    // 403/451 THROUGH an engine still means the site refused the exit's address — the route worked
    // and the destination did not. Saying "the engine failed" there would send the user to change
    // the one thing that is not the problem.
    if (r.ok && r.status && [403, 451].includes(r.status)) {
        return { ok: false, state: 'sanctioned', status: r.status, ms: r.ms };
    }
    return { ok: !!(r.ok && r.status && r.status < 400), state: r.ok ? 'open' : 'unreachable', status: r.status || null, reason: r.reason || null, ms: r.ms };
}

function logUnsupported(domain, result) {
    const line = `${new Date().toISOString()}\t${domain}\t${result.state}\t${result.note || ''}\n`;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.appendFileSync(UNSUPPORTED_LOG, line); } catch (e) { /* not fatal */ }
}

module.exports = {
    getConfig, setConfig,
    listServices, getDomains, serviceForDomain, isInAllowlist, isBlockedDownload,
    testDirect, testVia, logUnsupported,
    // exported for the tests and for anything that wants one layer on its own
    _internal: { tcpConnect, httpsProbe, classifyDirect, DATA_DIR, CONFIG_FILE },
};
