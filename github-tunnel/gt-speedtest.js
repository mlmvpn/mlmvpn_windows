// --- GitHub Tunnel: path quality / speed diagnostics ---
//
// The single biggest determinant of speed here is NOT bandwidth — it is whether the
// WireGuard association to the cloud session is DIRECT or bouncing through a relay.
// A direct path is a straight line to the exit; a relayed one detours through a third
// machine that may be on another continent, which can turn a 90ms ping into 400ms and cap
// throughput for reasons no amount of tuning will fix. So that is the first thing measured
// and the first thing reported, in plain language.
//
// Everything else here exists to separate "the tunnel is slow" from "the internet is
// slow": baseline latency is measured OUTSIDE the tunnel too, so the overhead the tunnel
// actually adds is a number rather than a feeling.

const { execFile } = require('child_process');
const http = require('http');
const https = require('https');

function run(exe, args, timeout = 30000) {
    return new Promise((resolve) => {
        execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ ok: !err, out: (stdout || '').toString(), err: (stderr || '').toString() });
        });
    });
}

/** Time a plain HTTPS GET, following the machine's current routing. */
function timedGet(url, timeout = 15000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const mod = url.startsWith('https') ? https : http;
        const req = mod.get(url, (res) => {
            res.resume();
            res.on('end', () => resolve({ ok: true, ms: Date.now() - started, status: res.statusCode }));
        });
        req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, ms: timeout }); });
        req.on('error', () => resolve({ ok: false, ms: Date.now() - started }));
    });
}

/**
 * Download a payload and report BOTH the naive average and the steady-state rate.
 *
 * The average alone is misleading on a high-latency link: TCP starts slow and takes
 * several round trips to open its window, so on a 300ms path a short transfer can spend
 * most of its life ramping up. Reporting that as "your speed" invites optimising against
 * a number that was never the real ceiling. The steady-state figure ignores the ramp and
 * measures what the link actually sustains.
 */
function measureThroughput(url, timeout = 30000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const RAMP_MS = 4000; // ignore the slow-start window
        let bytes = 0;
        let steadyBytes = 0;
        let steadyStart = null;

        const req = https.get(url, (res) => {
            res.on('data', (c) => {
                bytes += c.length;
                const elapsed = Date.now() - started;
                if (elapsed >= RAMP_MS) {
                    if (steadyStart === null) { steadyStart = Date.now(); steadyBytes = 0; }
                    else steadyBytes += c.length;
                }
            });
            res.on('end', () => {
                const seconds = (Date.now() - started) / 1000;
                const steadySeconds = steadyStart ? (Date.now() - steadyStart) / 1000 : 0;
                resolve({
                    ok: bytes > 0,
                    bytes,
                    seconds,
                    mbps: seconds > 0 ? (bytes * 8) / seconds / 1e6 : 0,
                    steadyMbps: steadySeconds > 0.5 ? (steadyBytes * 8) / steadySeconds / 1e6 : null,
                });
            });
        });
        req.setTimeout(timeout, () => { req.destroy(); resolve({ ok: false, bytes, seconds: timeout / 1000, mbps: 0, steadyMbps: null }); });
        req.on('error', () => resolve({ ok: false, bytes: 0, seconds: 0, mbps: 0, steadyMbps: null }));
    });
}

/**
 * @param cliExe        path to the tailscale CLI
 * @param controlPipe   its control socket
 * @param exitNodeIp    the cloud session's overlay address
 */
// Last measured throughput with the tunnel OFF. Without this the report can say the
// tunnel is slow while never having checked what the line does on its own — which is how
// a connection gets blamed for a ceiling it did not impose.
let baselineMbps = null;

async function run_(cliExe, controlPipe, exitNodeIp) {
    const results = [];
    const add = (name, verdict, detail, hint) => results.push({ name, verdict, detail, hint: hint || '' });
    const isBaseline = !exitNodeIp;

    // ── 1. direct vs relayed ────────────────────────────────────────────────────
    let pathKind = 'unknown';
    let pingMs = null;
    if (exitNodeIp) {
        // `tailscale ping` reports the path it actually took, which is the only
        // authoritative answer — status alone can lag behind a path change.
        const p = await run(cliExe, [`--socket=${controlPipe}`, 'ping', '--c', '5', '--until-direct=false', exitNodeIp], 25000);
        const text = p.out;
        const direct = /via\s+\d+\.\d+\.\d+\.\d+:\d+/i.test(text) || /direct/i.test(text);
        const relay = /via DERP|via derp/i.test(text);
        const m = text.match(/in\s+(\d+)ms/);
        if (m) pingMs = Number(m[1]);
        pathKind = relay ? 'relay' : (direct ? 'direct' : 'unknown');

        if (pathKind === 'direct') {
            add('مسیر اتصال', 'PASS', `مستقیم (بدون رله)${pingMs != null ? ` — ${pingMs}ms` : ''}`);
        } else if (pathKind === 'relay') {
            add('مسیر اتصال', 'FAIL',
                `از طریق رله${pingMs != null ? ` — ${pingMs}ms` : ''}`,
                'رله بزرگ‌ترین عامل کندی و پینگ بالاست. معمولاً یعنی NAT شما اجازه‌ی اتصال مستقیم نمی‌دهد؛ UPnP روی مودم یا تغییر شبکه می‌تواند حلش کند.');
        } else {
            add('مسیر اتصال', 'WARN', 'قابل تشخیص نبود');
        }
    } else {
        add('حالت اندازه‌گیری', 'PASS', 'خط پایه — بدون تونل');
    }

    // ── 2. relay-fleet latency (why a relay is or isn't cheap) ───────────────────
    const nc = isBaseline ? { ok: false } : await run(cliExe, [`--socket=${controlPipe}`, 'netcheck'], 30000);
    if (nc.ok) {
        const latencies = [...nc.out.matchAll(/- \w+:\s*([\d.]+)ms/g)].map(x => Number(x[1])).filter(Boolean);
        const best = latencies.length ? Math.min(...latencies) : null;
        const varies = /MappingVariesByDestIP:\s*true/i.test(nc.out);
        if (best != null) {
            add('نزدیک‌ترین رله', best < 150 ? 'PASS' : 'WARN', `${best.toFixed(0)}ms`);
        }
        // Hard NAT is the usual reason a direct path never forms.
        add('نوع NAT', varies ? 'WARN' : 'PASS',
            varies ? 'سخت‌گیر (Hard NAT)' : 'سازگار',
            varies ? 'NAT سخت‌گیر جلوی اتصال مستقیم را می‌گیرد و اتصال را به رله می‌اندازد.' : '');
    }

    // ── 3. what the tunnel actually costs ───────────────────────────────────────
    const a = await timedGet('https://www.gstatic.com/generate_204');
    const b = await timedGet('https://www.gstatic.com/generate_204');
    const rtt = Math.min(a.ms, b.ms);
    const rttLabel = isBaseline ? 'تأخیر وب (بدون تونل)' : 'تأخیر وب از داخل تونل';
    if (a.ok || b.ok) {
        add(rttLabel, rtt < 400 ? 'PASS' : 'WARN', `${rtt}ms`);
    } else {
        add(rttLabel, 'FAIL', 'پاسخی دریافت نشد');
    }

    // ── 4. throughput ───────────────────────────────────────────────────────────
    const tp = await measureThroughput('https://speed.cloudflare.com/__down?bytes=10000000');
    if (tp.ok && tp.mbps > 0) {
        const rate = tp.steadyMbps != null ? tp.steadyMbps : tp.mbps;
        if (isBaseline) {
            // Remember it, so the next tunnelled run has something to be measured against.
            baselineMbps = rate;
            add('سرعت دانلود (بدون تونل)', 'PASS', `${rate.toFixed(1)} Mbps`,
                'حالا تونل را روشن کنید و دوباره تست بگیرید تا تفاوت مشخص شود.');
        } else if (baselineMbps != null) {
            // The only number that says anything about the tunnel is the ratio: an
            // absolute figure cannot distinguish a slow tunnel from a slow line.
            const pct = Math.round((rate / baselineMbps) * 100);
            const verdict = pct >= 70 ? 'PASS' : pct >= 40 ? 'WARN' : 'FAIL';
            add('سرعت دانلود', verdict,
                `${rate.toFixed(1)} Mbps — ${pct}% از سرعت بدون تونل (${baselineMbps.toFixed(1)})`,
                pct >= 70
                    ? 'تونل تقریباً تمام پهنای باند خط شما را رد می‌کند؛ محدودیت از خودِ اینترنت است نه تونل.'
                    : 'تونل بخش قابل‌توجهی از سرعت را می‌گیرد.');
        } else {
            add('سرعت دانلود', rate >= 10 ? 'PASS' : 'WARN', `${rate.toFixed(1)} Mbps پایدار (میانگین: ${tp.mbps.toFixed(1)})`,
                'برای اینکه معلوم شود این سقف از تونل است یا از خط شما، یک‌بار با تونل خاموش هم تست بگیرید.');
        }
    } else {
        add('سرعت دانلود', 'WARN', 'اندازه‌گیری نشد');
    }

    // ── 5. MTU ──────────────────────────────────────────────────────────────────
    // Fragmentation shows up as "works but slow / stalls on big responses", which is easy
    // to misread as a bandwidth problem.
    const mtu = await run('powershell.exe', ['-NoProfile', '-Command',
        `(Get-NetIPInterface -InterfaceAlias 'mlmvpn-gt' -AddressFamily IPv4 -ErrorAction SilentlyContinue).NlMtu`], 15000);
    const mtuVal = Number((mtu.out || '').trim());
    if (mtuVal) {
        add('MTU تونل', mtuVal >= 1280 ? 'PASS' : 'WARN', String(mtuVal),
            mtuVal < 1280 ? 'MTU پایین باعث تکه‌تکه شدن بسته‌ها و افت سرعت می‌شود.' : '');
    }

    return {
        pathKind,
        pingMs,
        results,
        summary: results.some(r => r.verdict === 'FAIL') ? 'FAIL'
            : results.some(r => r.verdict === 'WARN') ? 'WARN' : 'PASS',
    };
}

module.exports = { run: run_ };
