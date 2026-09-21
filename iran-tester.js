// --- iran-tester.js — «کدام کانفیگ ایران مناسب خط من است؟» ---
//
// The serverless configs have no server. They reach the internet with two independent tricks,
// and EITHER can fail on a given line while the other is fine:
//
//   1. a DoH resolver, to get an honest answer for a poisoned name;
//   2. a fragmented TLS ClientHello, to get past SNI inspection.
//
// Measured on one Iranian mobile line (2026-09-12) — and the point is that another line will
// answer differently:
//
//   resolver reachability   Google ✅ 493ms · AdGuard ✅ 1036ms · Cloudflare ❌ reset after 11s
//                           · Quad9 ❌ HTTP 505 · cloudflare-dns.com by NAME ❌
//   fragment suitability    v50's profile could not open www.cloudflare.com AT ALL (22s), while
//                           the identical config without it answered in 3.9s
//
// With 10,000 users on 10,000 lines, telling someone "try them one by one" is not an answer.
// This measures instead, and it measures the two axes SEPARATELY — which is what makes it fast:
// a resolver is tested ONCE for every profile that uses it, so a line that cannot reach
// Cloudflare loses five rows in about a second instead of five Xray runs.
//
// What each profile is asked, in order, stopping at the first failure:
//   dns       does its resolver answer from this line?       (no Xray — a plain DoH query)
//   open      does an ORDINARY site open through it?          (proves the config runs at all)
//   filtered  does a FILTERED site open through it?           (proves the fragmentation works)
//
// Upstream says «از کانفیگ‌ها تست نگیرید» and is right about latency: a ping through a direct
// config measures the user's own line, not a tunnel. These three questions are not that. They
// are the only questions whose answers differ between the profiles.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const { SocksTlsAgent } = require('./socks-agents');
const tester = require('./xray-tester');

// Not filtered and not IP-blocked from Iran: if this does not open, the config itself is dead
// rather than merely out-fought by the DPI. (The user's own Cloudflare nodes reach it daily.)
const OPEN_SITE = { host: 'www.cloudflare.com', path: '/cdn-cgi/trace' };
// SNI-filtered, and the site people actually complain about.
const FILTERED_SITE = { host: 'www.youtube.com', path: '/' };

// A minimal DNS query for one A record — enough to prove a resolver answers.
const DNS_QUERY = Buffer.from('AAABAAABAAAAAAAAA3d3dwd5b3V0dWJlA2NvbQAAAQAB', 'base64');

function unpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

/**
 * Can this line reach that DoH endpoint? Asked WITHOUT Xray, because the answer is a property
 * of the line, and because it is then one question for every profile that shares the resolver.
 */
function probeResolver(doh, timeoutMs = 7000) {
    return new Promise((resolve) => {
        let u;
        try { u = new URL(doh); } catch (e) { return resolve({ ok: false, why: 'آدرس نامعتبر' }); }
        const started = Date.now();
        const isIp = /^[0-9.]+$/.test(u.hostname);
        const req = https.request({
            host: u.hostname,
            port: u.port || 443,
            path: u.pathname || '/dns-query',
            method: 'POST',
            // An IP literal must not be sent as SNI (RFC 6066), and Node warns about it.
            servername: isIp ? undefined : u.hostname,
            headers: { 'Content-Type': 'application/dns-message', 'Content-Length': DNS_QUERY.length },
            timeout: timeoutMs,
        }, (res) => {
            let n = 0;
            res.on('data', (c) => { n += c.length; });
            res.on('end', () => resolve(res.statusCode === 200 && n > 0
                ? { ok: true, ms: Date.now() - started }
                : { ok: false, ms: Date.now() - started, why: `پاسخ ${res.statusCode}` }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - started, why: 'بی‌پاسخ' }); });
        req.on('error', (e) => resolve({ ok: false, ms: Date.now() - started, why: e.message.slice(0, 60) }));
        req.end(DNS_QUERY);
    });
}

/** One HTTPS request through a local SOCKS port. Resolves { ok, ms, why }. */
function fetchThrough(port, site, timeoutMs) {
    return new Promise((resolve) => {
        const agent = new SocksTlsAgent(port);
        const started = Date.now();
        let settled = false;
        const done = (ok, why) => {
            if (settled) return;
            settled = true;
            try { agent.destroy(); } catch (e) { }
            resolve({ ok, ms: Date.now() - started, why: why || '' });
        };
        const req = https.request({
            host: site.host, port: 443, path: site.path, method: 'GET', agent,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept': '*/*' },
        }, (res) => {
            // The first bytes of a response are the proof; the rest is bandwidth.
            res.on('data', () => { try { req.destroy(); } catch (e) { } done(true); });
            res.on('end', () => done(true));
        });
        req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (e) { } done(false, 'بی‌پاسخ'); });
        req.on('error', (e) => done(false, e.message.slice(0, 60)));
        req.end();
    });
}

/** Start one profile's config on its own port. Resolves { port, stop } or null. */
async function startProfile(configJson, log) {
    let cfg;
    try { cfg = JSON.parse(configJson); } catch (e) { return null; }

    let reserved;
    try { reserved = await tester.reservePorts(1, 21800); } catch (e) { return null; }
    const port = reserved.ports[0];

    // The profile's own listener is replaced, exactly as the live path does it (xray-manager ›
    // full custom config): same reason, and it keeps the test on ports nothing else owns.
    // The client inbound's sniffing is KEPT — these configs route by domain through fakedns,
    // and sniffing without "fakedns" breaks the routing this test is here to measure.
    const CLIENT = new Set(['socks', 'http', 'mixed']);
    const clientIn = (cfg.inbounds || []).find((i) => i && CLIENT.has(String(i.protocol)));
    const ownIn = (cfg.inbounds || [])
        .filter((i) => i && !CLIENT.has(String(i.protocol)) && i.tag !== 'api')
        .map((i) => Object.assign({}, i, { listen: i.listen || '127.0.0.1' }));
    cfg.inbounds = [
        {
            tag: 'probe-in', port, listen: '127.0.0.1', protocol: 'socks',
            settings: { udp: true },
            sniffing: (clientIn && clientIn.sniffing) || { enabled: true, destOverride: ['fakedns', 'tls', 'http', 'quic'] },
        },
        ...ownIn,
    ];
    // Nothing from the app's own session: no stats, no api, no shared file.
    delete cfg.api; delete cfg.stats;
    if (cfg.routing && Array.isArray(cfg.routing.rules)) {
        cfg.routing.rules = cfg.routing.rules.filter((r) => !(Array.isArray(r.inboundTag) && r.inboundTag.includes('api')));
    }
    if (cfg.log) { cfg.log.access = 'none'; cfg.log.loglevel = 'warning'; }

    const dir = path.join(os.homedir(), '.mlmvpn');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { }
    const configPath = path.join(dir, 'config_iran_test.json');
    try { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2)); }
    catch (e) { await reserved.release(); return null; }

    const exePath = require('./core-paths').file('xray', 'xray.exe', path.join(unpackedDir(), 'core', 'xray.exe'));
    if (!fs.existsSync(exePath)) { await reserved.release(); return null; }

    await reserved.release();
    const proc = spawn(exePath, ['-config', configPath], { windowsHide: true });
    let said = '';
    const grab = (d) => { said = (said + d.toString()).slice(-2000); };
    if (proc.stdout) proc.stdout.on('data', grab);
    if (proc.stderr) proc.stderr.on('data', grab);

    const up = await tester.waitForPort(port, 8000);
    const stop = () => { try { proc.kill(); } catch (e) { } };
    if (!up) {
        stop();
        if (log) log(`[Iran] هسته برای این کانفیگ بالا نیامد: ${(said.match(/Failed to start:.*/) || [''])[0].slice(0, 120)}`);
        return null;
    }
    return { port, stop };
}

/**
 * Measure every profile and say which one this line should use.
 *
 * @param profiles  [{ id, dns, config }] — `dns` is the profile's DoH endpoint, when it has one.
 * @param onResult  called per profile as soon as its verdict exists.
 */
async function testProfiles({ profiles = [], onResult = () => { }, isAborted = () => false, log = () => { } } = {}) {
    const results = [];
    const emit = (r) => { results.push(r); onResult(r); };

    // ── the resolver, once per distinct endpoint ────────────────────────────────
    const resolvers = new Map();
    for (const p of profiles) {
        if (p.dns && !resolvers.has(p.dns)) resolvers.set(p.dns, null);
    }
    for (const doh of resolvers.keys()) {
        if (isAborted()) return { results, resolvers: {} };
        const r = await probeResolver(doh);
        resolvers.set(doh, r);
        log(`[Iran] DNS ${doh}: ${r.ok ? `✅ ${r.ms}ms` : `❌ ${r.why}`}`);
        onResult({ kind: 'resolver', dns: doh, ok: r.ok, ms: r.ms, why: r.why });
    }

    // ── then each profile, stopping at its first failure ────────────────────────
    for (const p of profiles) {
        if (isAborted()) break;

        // A profile whose resolver is unreachable cannot open ONE site. Saying so costs
        // nothing, where running it would cost an Xray start and two timeouts.
        const rr = p.dns ? resolvers.get(p.dns) : null;
        if (rr && !rr.ok) {
            emit({ id: p.id, stage: 'dns', ok: false, score: 0, why: `سرور DNS این کانفیگ جواب نداد (${rr.why})` });
            continue;
        }

        const started = await startProfile(p.config, log);
        if (!started) {
            emit({ id: p.id, stage: 'core', ok: false, score: 0, why: 'هسته با این کانفیگ بالا نیامد' });
            continue;
        }
        try {
            const open = await fetchThrough(started.port, OPEN_SITE, 12000);
            if (!open.ok) {
                emit({ id: p.id, stage: 'open', ok: false, score: 0, ms: open.ms, why: `سایت معمولی هم باز نشد (${open.why})` });
                continue;
            }
            const filtered = await fetchThrough(started.port, FILTERED_SITE, 12000);
            emit({
                id: p.id,
                stage: filtered.ok ? 'filtered' : 'open',
                ok: true,
                // 2 = opens filtered sites, 1 = opens ordinary ones only. The ranking the
                // panel shows is this, then speed.
                score: filtered.ok ? 2 : 1,
                ms: open.ms,
                filteredMs: filtered.ok ? filtered.ms : undefined,
                why: filtered.ok ? '' : `سایت فیلترشده باز نشد (${filtered.why})`,
            });
        } finally {
            started.stop();
            // Windows needs a moment to release the listener before the next profile takes one.
            await new Promise((r) => setTimeout(r, 250));
        }
    }

    return { results, resolvers: Object.fromEntries(resolvers) };
}

module.exports = { testProfiles, probeResolver, OPEN_SITE, FILTERED_SITE };
