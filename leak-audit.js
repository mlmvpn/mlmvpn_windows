// --- leak-audit.js — بررسی واقعی نشت، نه بررسی کد ---
//
// WHY THIS EXISTS
// The TUN config is careful, but "the config looks right" and "nothing leaks" are two
// different claims, and only one of them can be measured. Windows has too many ways to put
// a packet on the wire behind the routing table's back: smart multi-homed name resolution
// querying every adapter's resolver in parallel, a physical default route that survives
// alongside the tunnel's, an IPv6 path that stays up when the tunnel is v4-only, and any
// application that keeps a socket bound to the old interface.
//
// So this asks the network, from outside, what it can see about the user — and compares
// that with the real identity recorded while the tunnel was off. A check that cannot
// answer honestly reports 'unknown' rather than guessing; a false "clean" here is worse
// than no test at all.
//
// EVERY PROBE HERE MUST BYPASS THIS APP'S OWN PROXIES. Sending a leak test through the
// tunnel guarantees a clean-looking answer and proves nothing. `proxy: false` on every
// axios call is load-bearing, not decoration.

const os = require('os');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const axios = require('axios');
const { execFile } = require('child_process');

const DATA_DIR = path.join(os.homedir(), '.mlmvpn');
const BASELINE_FILE = path.join(DATA_DIR, 'leak-baseline.json');

const PROBE_TIMEOUT = 8000;

function sh(cmd, args) {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout: 10000, windowsHide: true }, (err, stdout) => {
            resolve(err ? '' : String(stdout || ''));
        });
    });
}

/** Cloudflare's trace endpoint: public IP, colo, and whether WARP is carrying us. */
async function cfTrace(url) {
    const res = await axios.get(url, {
        timeout: PROBE_TIMEOUT,
        proxy: false,
        headers: { 'User-Agent': 'Mozilla/5.0' },
        transformResponse: [(d) => d],
    });
    const out = {};
    String(res.data).split('\n').forEach(line => {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
    });
    return out;
}

// More than one way to ask, because the obvious one does not work where it is needed.
//
// Measured on the target network: https://1.1.1.1/cdn-cgi/trace TIMES OUT (TLS to 1.1.1.1:443
// is blocked on this line) while https://cloudflare.com/cdn-cgi/trace answers normally. The
// audit used the 1.1.1.1 URL alone, so on precisely the censored networks this tool exists
// for it reported 'unknown' and proved nothing. A leak test that cannot run is indistinguish-
// able from one that passes, which is the worst failure mode available to it.
const V4_TRACE_URLS = [
    'https://cloudflare.com/cdn-cgi/trace',
    'https://www.cloudflare.com/cdn-cgi/trace',
    'https://1.1.1.1/cdn-cgi/trace',
];
const V6_TRACE_URLS = [
    'https://[2606:4700:4700::1111]/cdn-cgi/trace',
    'https://[2606:4700::6810:85e5]/cdn-cgi/trace',
];

async function cfTraceAny(urls) {
    let lastErr = null;
    for (const url of urls) {
        try { return await cfTrace(url); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no trace endpoint answered');
}

/**
 * Which resolver actually answered — reported by the resolver itself.
 *
 * This is the DNS check that matters. Reading the adapter's configured servers only says
 * what Windows was told to use; this says who really saw the query.
 */
function resolverIdentity() {
    return new Promise(resolve => {
        const timer = setTimeout(() => resolve(null), PROBE_TIMEOUT);
        dns.resolveTxt('o-o.myaddr.l.google.com', (err, records) => {
            clearTimeout(timer);
            if (err || !records || !records.length) return resolve(null);
            resolve(records.flat().join(' ').trim());
        });
    });
}

/**
 * Is some OTHER tunnel already carrying this machine's traffic?
 *
 * This guard was added because the very first run of this tool got it wrong. It recorded a
 * "real line" baseline of 4.154.142.176 / colo SEA while the GitHub Tunnel adapter was up —
 * an Azure address in Seattle, i.e. that tunnel's exit, not the user's ISP. A baseline like
 * that poisons every later comparison: the Aether run would show a different IP, the tool
 * would print "clean", and it would have proven nothing at all. Recording no baseline is
 * far better than recording a confident wrong one.
 */
async function detectOtherTunnel() {
    const names = await sh('powershell', ['-NoProfile', '-Command',
        "Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | Select-Object -ExpandProperty Name"]);
    const up = names.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    // mlmvpn-gt = GitHub Tunnel (Tailscale). Anything WireGuard/TUN-shaped counts too.
    //
    // Our OWN adapter is excluded by exact name. It is called 'MLMVPN', which the pattern
    // below matches — so without this the audit would flag the very tunnel it is auditing as
    // "a second tunnel is active" and downgrade every result to unattributable, on every run.
    const OURS = 'MLMVPN';
    const suspects = up.filter(n => n !== OURS && /mlmvpn|wintun|wireguard|tailscale|tun|singbox|sing-box/i.test(n));
    return suspects;
}

function saveBaseline(data) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(BASELINE_FILE, JSON.stringify({ ...data, savedAt: Date.now() }, null, 2));
    } catch (e) { /* best effort */ }
}

function loadBaseline() {
    try {
        if (fs.existsSync(BASELINE_FILE)) return JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8'));
    } catch (e) { }
    return null;
}

/**
 * @param {boolean} tunnelUp  what the caller believes the tunnel state to be. With it
 *        false the run is a BASELINE: it records the real identity so a later run has
 *        something to compare against. Without a baseline a "clean" verdict is unfalsifiable.
 */
async function runLeakAudit({ tunnelUp = false } = {}) {
    const checks = [];
    const add = (c) => checks.push(c);
    const baseline = loadBaseline();
    const otherTunnels = await detectOtherTunnel();

    if (otherTunnels.length && tunnelUp) {
        // Two tunnels up at once means a failed check cannot be attributed to either.
        add({ id: 'conflict', state: 'warn', title: 'بیش از یک تونل فعال است',
              detail: `آداپتورهای فعال: ${otherTunnels.join('، ')}. نتیجه‌ی این بررسی به تونل مشخصی قابل نسبت دادن نیست.` });
    }

    // ── 1. Public IPv4 ────────────────────────────────────────────────────────────
    let v4 = null, warp = null, colo = null;
    try {
        const t = await cfTraceAny(V4_TRACE_URLS);
        v4 = t.ip || null;
        warp = t.warp || null;
        colo = t.colo || null;
    } catch (e) { /* recorded as unknown below */ }

    if (!v4) {
        add({ id: 'ipv4', state: 'unknown', title: 'آی‌پی عمومی IPv4',
              detail: 'قابل تشخیص نبود — نتیجه‌ی این اجرا قابل استناد نیست.' });
    } else if (!tunnelUp) {
        // Only call it "your real line" when nothing else is carrying traffic — otherwise
        // this is some other tunnel's exit and saying so plainly avoids a false conclusion.
        add({ id: 'ipv4', state: 'info',
              title: otherTunnels.length ? 'آی‌پی عمومی IPv4 (از مسیر تونل دیگر)' : 'آی‌پی عمومی IPv4 (خط واقعی)',
              detail: `${v4}${colo ? ` — نزدیک‌ترین مرکز: ${colo}` : ''}` });
    } else if (baseline && baseline.ipv4 && baseline.ipv4 === v4) {
        add({ id: 'ipv4', state: 'fail', title: 'نشت آی‌پی — ترافیک از تونل رد نمی‌شود',
              detail: `آی‌پی دیده‌شده (${v4}) دقیقاً همان آی‌پی واقعی خط شماست.` });
    } else {
        add({ id: 'ipv4', state: 'ok', title: 'آی‌پی عمومی IPv4',
              detail: `${v4}${colo ? ` — مرکز: ${colo}` : ''}${warp ? ` — WARP: ${warp}` : ''}`
                + (baseline && baseline.ipv4 ? ' — با آی‌پی واقعی خط شما فرق دارد.' : ' — مبنایی برای مقایسه ذخیره نشده.') });
    }

    // ── 2. Public IPv6 ────────────────────────────────────────────────────────────
    // The tunnel rejects v6 on purpose, so with it up this probe SHOULD fail. A v6
    // address answering here while v4 goes through the tunnel is the classic split leak:
    // the site sees a Cloudflare v4 and an Iranian v6 from the same browser.
    let v6 = null;
    try {
        const t6 = await cfTraceAny(V6_TRACE_URLS);
        v6 = t6.ip || null;
    } catch (e) { v6 = null; }

    if (!v6) {
        add({ id: 'ipv6', state: 'ok', title: 'IPv6',
              detail: tunnelUp
                ? 'هیچ مسیر IPv6 مستقلی به بیرون باز نیست — درست است، تونل عمداً IPv6 را می‌بندد.'
                : 'روی این خط IPv6 عمومی فعال نیست.' });
    } else if (tunnelUp) {
        add({ id: 'ipv6', state: 'fail', title: 'نشت IPv6',
              detail: `با وجود روشن بودن تونل، IPv6 مستقل به بیرون راه دارد: ${v6}` });
    } else {
        add({ id: 'ipv6', state: 'info',
              title: otherTunnels.length ? 'IPv6 (از مسیر تونل دیگر)' : 'IPv6 (خط واقعی)', detail: v6 });
    }

    // ── 3. Which resolver really saw the query ────────────────────────────────────
    const resolver = await resolverIdentity();
    if (!resolver) {
        add({ id: 'dns', state: 'unknown', title: 'DNS',
              detail: 'پاسخ‌دهنده‌ی واقعی DNS تشخیص داده نشد.' });
    } else if (!tunnelUp) {
        add({ id: 'dns', state: 'info',
              title: otherTunnels.length ? 'پاسخ‌دهنده‌ی DNS (از مسیر تونل دیگر)' : 'پاسخ‌دهنده‌ی DNS (خط واقعی)',
              detail: resolver });
    } else if (baseline && baseline.resolver && baseline.resolver === resolver) {
        add({ id: 'dns', state: 'fail', title: 'نشت DNS',
              detail: `همان پاسخ‌دهنده‌ی قبل از تونل هنوز درخواست‌ها را می‌بیند: ${resolver}` });
    } else {
        add({ id: 'dns', state: 'ok', title: 'پاسخ‌دهنده‌ی DNS',
              detail: `${resolver} — با پاسخ‌دهنده‌ی خط واقعی فرق دارد.` });
    }

    // ── 4. Is a physical default route still alive next to the tunnel's? ──────────
    // A second 0.0.0.0/0 with a lower metric is how traffic quietly keeps using the real
    // interface even though the tunnel is up and looks healthy.
    const routes = await sh('route', ['print', '-4']);
    if (!routes) {
        add({ id: 'route', state: 'unknown', title: 'جدول مسیریابی', detail: 'خوانده نشد.' });
    } else {
        const defaults = routes.split(/\r?\n/)
            .filter(l => /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s/.test(l))
            .map(l => l.trim().split(/\s+/))
            .map(p => ({ gateway: p[2], iface: p[3], metric: Number(p[4]) }))
            .filter(r => Number.isFinite(r.metric));
        if (!defaults.length) {
            add({ id: 'route', state: 'unknown', title: 'مسیر پیش‌فرض', detail: 'مسیر پیش‌فرضی پیدا نشد.' });
        } else {
            const best = defaults.reduce((a, b) => (a.metric <= b.metric ? a : b));
            const viaTun = best.iface && best.iface.startsWith('172.19.');
            if (tunnelUp && !viaTun) {
                add({ id: 'route', state: 'fail', title: 'مسیر پیش‌فرض از تونل رد نمی‌شود',
                      detail: `مسیر با کمترین متریک از ${best.iface} (متریک ${best.metric}) می‌رود، نه از آداپتور تونل.` });
            } else {
                add({ id: 'route', state: tunnelUp ? 'ok' : 'info',
                      title: 'مسیر پیش‌فرض',
                      detail: `${defaults.length} مسیر پیش‌فرض؛ فعال: ${best.iface} (متریک ${best.metric})` });
            }
        }
    }

    // ── 5. Resolvers configured on every adapter ─────────────────────────────────
    // Informational: Windows' multi-homed resolution can query these in parallel, so a
    // live ISP resolver on the physical adapter is a standing risk even when rule 3 passes.
    const dnsCfg = await sh('powershell', ['-NoProfile', '-Command',
        "Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object {$_.ServerAddresses} | ForEach-Object { $_.InterfaceAlias + ' :: ' + ($_.ServerAddresses -join ',') }"]);
    if (dnsCfg.trim()) {
        add({ id: 'adapters', state: 'info', title: 'DNS تنظیم‌شده روی کارت‌های شبکه',
              detail: dnsCfg.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean).join(' | ') });
    }

    // Record the real identity only when nothing else is carrying traffic.
    if (!tunnelUp) {
        if (otherTunnels.length) {
            add({ id: 'baseline', state: 'warn', title: 'مبنای مقایسه ثبت نشد',
                  detail: `تونل دیگری فعال است (${otherTunnels.join('، ')})، پس آنچه بیرون دیده می‌شود خط واقعی شما نیست. `
                        + 'برای ثبت مبنا، همه‌ی تونل‌ها را خاموش کنید و دوباره اجرا کنید.' });
        } else if (v4) {
            saveBaseline({ ipv4: v4, ipv6: v6, resolver });
            add({ id: 'baseline', state: 'ok', title: 'مبنای مقایسه ثبت شد',
                  detail: 'هویت واقعی خط ذخیره شد؛ اجرای بعدی با تونل روشن با همین مقایسه می‌شود.' });
        }
    } else if (!baseline) {
        add({ id: 'baseline', state: 'warn', title: 'مبنای مقایسه وجود ندارد',
              detail: 'بدون مبنا نمی‌توان ثابت کرد آی‌پی دیده‌شده واقعاً با خط شما فرق دارد. '
                    + 'یک‌بار با تونل خاموش اجرا کنید.' });
    }

    const failed = checks.filter(c => c.state === 'fail').length;
    const unknown = checks.filter(c => c.state === 'unknown').length;
    return {
        tunnelUp,
        hasBaseline: !!baseline,
        verdict: failed ? 'leak' : (unknown ? 'inconclusive' : (tunnelUp ? 'clean' : 'baseline')),
        failed,
        unknown,
        checks,
    };
}

module.exports = { runLeakAudit, loadBaseline };
