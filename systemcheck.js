// --- System check (بررسی سیستم) ---------------------------------------------
// Runs at app start, before the user touches anything, and answers one question per
// feature: "will this actually work on THIS machine and THIS internet connection?"
//
// Every probe here does real work — a real socket, a real HTTP round-trip, a real read
// of the machine's DNS configuration. Nothing is simulated, because the whole point is
// to tell an Iranian user *which* feature their line is currently blocking, before they
// spend ten minutes deploying a panel that was never going to be reachable.
//
// Two hard rules, both about not hanging:
//   * every probe is wrapped in `withDeadline`, so a probe that never settles still
//     resolves as a failure at the cutoff instead of leaving the modal spinning;
//   * no probe depends on another probe's result, so the client can run them in any
//     order, skip any of them, or abandon the whole run mid-flight.

const axios = require('axios');
const net = require('net');
const https = require('https');
const dnsPromises = require('dns').promises;

const sanction = require('./sanction-manager');
const dedicatedDns = require('./dedicated-dns-manager');
const aether = require('./aether-manager');
const dnsManager = require('./dns-manager');

// Per-probe ceiling. Deliberately short: on a line where a host is blocked, the failure
// mode is a silent black-hole rather than a refusal, so the timeout IS the answer and
// waiting longer only makes the modal feel broken.
const PROBE_TIMEOUT = 8000;

/**
 * Resolve to a failure result at `ms` no matter what the underlying promise does.
 * `Promise.race` and not an abort signal, because a probe can hang inside DNS
 * resolution or a PowerShell child process, neither of which honours an AbortController.
 */
function withDeadline(promise, ms, onTimeout) {
    let timer;
    const deadline = new Promise(resolve => {
        timer = setTimeout(() => resolve(onTimeout()), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function now() { return Date.now(); }

/** TCP connect timing — the closest thing to a true "ping" for a host behind HTTPS. */
function tcpProbe(host, port, timeout) {
    return new Promise(resolve => {
        const started = now();
        const sock = new net.Socket();
        let settled = false;
        const done = result => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve(result);
        };
        sock.setTimeout(timeout);
        sock.once('connect', () => done({ ok: true, latency: now() - started }));
        sock.once('timeout', () => done({ ok: false, error: 'مهلت اتصال تمام شد' }));
        sock.once('error', err => done({ ok: false, error: err.code || err.message }));
        sock.connect(port, host);
    });
}

/**
 * An HTTP round-trip that treats ANY status code as reachable.
 *
 * This is on purpose. `api.cloudflare.com` answers 400 without a token and a bare
 * `*.workers.dev` host answers 404 — both prove the edge is reachable from this line,
 * which is the only thing being asked. Only a transport-level failure (DNS, reset,
 * timeout) counts as "blocked".
 */
async function httpProbe(url, timeout, opts = {}) {
    // Latency is measured warm, not cold.
    //
    // A first request to a host pays for DNS resolution, the TCP handshake, the full TLS
    // handshake and only then the HTTP round trip — commonly 600–1500ms on an Iranian
    // line. Reporting that as "پینگ" is what made the opening system check look alarming
    // when the connection was actually fine. The reachability verdict still comes from
    // that first request (it is the one that proves the host is not blocked), but the
    // number shown to the user comes from a second request over the SAME pooled socket,
    // which is a genuine round trip. Same method as the node delay test, so the two
    // screens finally agree with each other.
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
    try {
        const first = await httpProbeOnce(url, timeout, opts, agent);
        if (!first.ok) return first;

        // Only worth a second shot when the first proved the host answers; on a blocked
        // host this would just burn another full timeout for nothing.
        const second = await httpProbeOnce(url, timeout, opts, agent);
        if (second.ok) {
            return { ok: true, latency: Math.min(first.latency, second.latency), status: second.status };
        }
        return first;
    } finally {
        try { agent.destroy(); } catch (e) { }
    }
}

async function httpProbeOnce(url, timeout, opts = {}, agent = undefined) {
    const started = now();
    try {
        const res = await axios.request({
            url,
            httpsAgent: agent,
            method: opts.method || 'GET',
            timeout,
            maxRedirects: 0,
            // Any HTTP response at all means the connection survived; that is the signal.
            validateStatus: () => true,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
            // A landing page can be megabytes; we only need the response to start.
            maxContentLength: 64 * 1024,
            maxBodyLength: 64 * 1024,
            proxy: false,
        });
        return { ok: true, latency: now() - started, status: res.status };
    } catch (err) {
        // maxContentLength trips only after headers arrived, so the host answered.
        if (err.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED') {
            return { ok: true, latency: now() - started, status: 200 };
        }
        return { ok: false, latency: now() - started, error: describeNetError(err) };
    }
}

/** Turn a Node error code into something a non-technical Persian user can act on. */
function describeNetError(err) {
    const code = err && (err.code || err.errno);
    switch (code) {
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
            return 'نام دامنه پیدا نشد (DNS پاسخ نداد یا مسدود است)';
        case 'ECONNREFUSED':
            return 'اتصال رد شد';
        case 'ECONNRESET':
            return 'اتصال قطع شد (نشانه‌ی فیلترینگ)';
        case 'ETIMEDOUT':
        case 'ECONNABORTED':
            return 'پاسخی دریافت نشد (مهلت تمام شد)';
        case 'CERT_HAS_EXPIRED':
        case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
            return 'گواهی SSL معتبر نیست (احتمال دستکاری مسیر)';
        default:
            return (err && err.message) || 'خطای نامشخص شبکه';
    }
}

// ── individual probes ────────────────────────────────────────────────────────
// Each returns { state, latency?, detail, hint? }.
//   state: 'ok' | 'warn' | 'fail'
// 'warn' means "works, but not the way you probably want" — an inactive feature or a
// filtering resolver. It never blocks the user; it is information.

/**
 * Is there internet at all?
 *
 * Three anchors, first success wins. One is a bare IP (no DNS involved), which is what
 * separates "no internet" from "internet is fine but DNS is broken" — a distinction that
 * matters a lot here, because a hijacked resolver is far more common than a dead line.
 */
async function probeInternet() {
    const rawIp = await tcpProbe('1.1.1.1', 443, 4000);
    const anchors = [
        { name: 'gstatic', url: 'https://www.gstatic.com/generate_204' },
        { name: 'cloudflare', url: 'https://cloudflare.com/cdn-cgi/trace' },
    ];

    for (const a of anchors) {
        const r = await httpProbe(a.url, 5000);
        if (r.ok) {
            return {
                state: 'ok',
                latency: r.latency,
                detail: `اتصال برقرار است (${a.name} در ${r.latency} میلی‌ثانیه پاسخ داد)`,
            };
        }
    }

    if (rawIp.ok) {
        return {
            state: 'warn',
            latency: rawIp.latency,
            detail: 'اینترنت وصل است ولی هیچ سایتی باز نشد — به احتمال زیاد DNS شما مشکل دارد.',
            hint: 'از بخش «پاکسازی عمیق DNS» یک DNS سالم انتخاب کنید.',
        };
    }

    return {
        state: 'fail',
        detail: 'هیچ اتصالی به اینترنت پیدا نشد.',
        hint: 'کابل/وای‌فای و فایروال ویندوز را بررسی کنید.',
    };
}

/**
 * What resolver is this machine actually on?
 *
 * Reuses the same enumeration the deep-clean panel uses, so the two never disagree.
 * A known Iranian filtering resolver is reported as a warning with its name, because
 * "Shecan" explains a dozen downstream failures at once.
 */
const FILTERING_RESOLVER_IDS = ['shecan', 'radar', 'begzar', '403', 'electro', 'pishgaman'];

async function probeDns() {
    const diag = await dnsManager.diagnose();
    const eff = diag.effective;

    if (!eff || !eff.dns || !eff.dns.length) {
        return {
            state: 'warn',
            detail: 'هیچ DNS فعالی روی کارت شبکه پیدا نشد.',
            sources: diag.sources,
        };
    }

    const servers = eff.dns.join(' · ');
    const provider = eff.provider;
    const extra = diag.sources.length > 1
        ? ` — ${diag.sources.length} منبع DNS روی سیستم فعال است`
        : '';

    if (provider && FILTERING_RESOLVER_IDS.includes(provider.id)) {
        return {
            state: 'warn',
            detail: `DNS فعلی: ${provider.name} (${servers})${extra}`,
            hint: 'این یک DNS داخلی فیلترشکن‌محور است و برای دیپلوی پنل ابری و ریلوی مشکل‌ساز می‌شود.',
            sources: diag.sources,
        };
    }

    return {
        state: 'ok',
        detail: `DNS فعلی: ${provider ? provider.name : 'سفارشی'} (${servers})${extra}`,
        sources: diag.sources,
    };
}

/** Cloudflare API — the dependency for deploying every cloud panel. */
async function probeCloudflareApi() {
    const r = await httpProbe('https://api.cloudflare.com/client/v4/user/tokens/verify', 7000);
    if (r.ok) {
        return {
            state: 'ok',
            latency: r.latency,
            detail: `API کلادفلر در دسترس است (کد ${r.status})`,
        };
    }
    return {
        state: 'fail',
        latency: r.latency,
        detail: `دسترسی به api.cloudflare.com برقرار نشد — ${r.error}`,
        hint: 'بدون این، دیپلوی پنل‌های ابری کار نمی‌کند. تحریم‌شکن را روشن کنید.',
    };
}

/**
 * The workers.dev edge — where a deployed panel actually lives.
 *
 * Separate from the API probe because the two are blocked independently in practice:
 * the API can be reachable while the workers.dev zone is not, which shows up as "deploy
 * succeeded but the panel never opens" and is otherwise very hard to diagnose.
 *
 * `target` lets the client point this at the user's own deployed worker. Without one,
 * any subdomain works: workers.dev is a DNS wildcard, so an unclaimed name still lands
 * on the Cloudflare edge and answers — which is exactly what is being measured.
 */
async function probeWorkerDomain(target) {
    let url = target && /^https?:\/\//i.test(target) ? target : '';
    let own = !!url;

    // Falling back to the user's own DNS worker before a generic name keeps this probe
    // testing a host they actually depend on whenever one exists.
    if (!url) {
        const cfg = dedicatedDns.getConfig() || {};
        // Either mode's worker is equally good as a probe target; prefer the active one.
        const candidate = dedicatedDns.workerUrlFor(cfg.mode, cfg) || cfg.workerUrl || cfg.dohWorkerUrl;
        if (candidate && /^https?:\/\//i.test(candidate)) {
            url = candidate;
            own = true;
        }
    }
    // No worker of their own yet. workers.dev is NOT a wildcard zone — an unclaimed
    // subdomain is a plain NXDOMAIN, which would report as "blocked" and be wrong — so
    // the fallback targets the service host instead and says so.
    if (!url) url = 'https://workers.cloudflare.com/';

    const r = await httpProbe(url, 7000);
    if (r.ok) {
        return {
            state: 'ok',
            latency: r.latency,
            detail: own
                ? `ورکر شما پاسخ داد (کد ${r.status})`
                : `سرویس ورکر کلادفلر در دسترس است (کد ${r.status}) — هنوز ورکری نساخته‌اید`,
        };
    }
    return {
        state: 'fail',
        latency: r.latency,
        detail: `دسترسی به دامنه‌ی ورکر برقرار نشد — ${r.error}`,
        hint: 'پنل‌های ساخته‌شده روی این دامنه باز نمی‌شوند. تحریم‌شکن یا DNS اختصاصی را فعال کنید.',
    };
}

/** Railway — the host for the «کانفیگ آیپی ثابت» gateway. */
async function probeRailway() {
    const r = await httpProbe('https://railway.com/', 7000);
    if (r.ok) {
        return { state: 'ok', latency: r.latency, detail: `railway.com در دسترس است (کد ${r.status})` };
    }
    return {
        state: 'fail',
        latency: r.latency,
        detail: `دسترسی به railway.com برقرار نشد — ${r.error}`,
        hint: 'برای «کانفیگ آیپی ثابت» لازم است. ریلوی پشت کلادفلر نیست، پس تحریم‌شکن آن را باز نمی‌کند — به فیلترشکن نیاز دارید.',
    };
}

/** script.google.com — the exact host the Google Script Tunnel deploys against. */
async function probeGoogleScript() {
    const r = await httpProbe('https://script.google.com/', 7000);
    if (r.ok) {
        return { state: 'ok', latency: r.latency, detail: `script.google.com در دسترس است (کد ${r.status})` };
    }
    return {
        state: 'fail',
        latency: r.latency,
        detail: `دسترسی به script.google.com برقرار نشد — ${r.error}`,
        hint: 'بدون این، تونل گوگل اسکریپت ساخته نمی‌شود.',
    };
}

/** تحریم‌شکن — is the hosts-file relay routing currently in effect? */
async function probeSanction() {
    const enabled = sanction.isEnabled();
    return enabled
        ? { state: 'ok', detail: 'تحریم‌شکن فعال است و مسیردهی روی سیستم اعمال شده.' }
        : {
            state: 'warn',
            detail: 'تحریم‌شکن خاموش است.',
            hint: 'برای دیپلوی روی کلادفلر و باز شدن سایت‌های تحریمی آن را روشن کنید.',
        };
}

/** DNS اختصاصی — deployed, and pointing at which region? */
async function probeDediDns() {
    const cfg = dedicatedDns.getConfig() || {};
    const activeUrl = dedicatedDns.workerUrlFor(cfg.mode, cfg);
    // Checked per mode: the other mode being deployed says nothing about the one Xray
    // is actually configured to use.
    if (!activeUrl || !/^https?:\/\//i.test(activeUrl)) {
        const other = cfg.mode === 'doh' ? 'مکان‌یابی سرور' : 'سرعت و پینگ';
        const hasOther = !!dedicatedDns.workerUrlFor(cfg.mode === 'doh' ? 'ecs' : 'doh', cfg);
        return {
            state: 'warn',
            detail: 'DNS اختصاصی برای حالت انتخاب‌شده ساخته نشده است.',
            hint: hasOther
                ? `فقط حالت «${other}» مستقر است — یا به آن سوییچ کنید یا این حالت را هم مستقر کنید.`
                : 'از تب «DNS اختصاصی» یک ورکر DoH روی کلادفلر خودتان بسازید.',
        };
    }
    const parts = [];
    parts.push(cfg.mode === 'doh' ? `حالت سرعت (${cfg.dohGroup || 'standard'})` : `ریجن ${cfg.region}`);
    parts.push(activeUrl);
    const where = ' — ' + parts.join(' · ');

    // Deployed but not switched on is a real state, and a common one: the worker exists,
    // Xray just is not using it. Saying "فعال" there would be a lie.
    if (!cfg.enabled) {
        return {
            state: 'warn',
            detail: `DNS اختصاصی ساخته شده ولی خاموش است${where}`,
            hint: 'از تب «DNS اختصاصی» آن را روشن کنید تا روی کانفیگ‌ها اعمال شود.',
        };
    }
    return { state: 'ok', detail: `DNS اختصاصی فعال است${where}` };
}

/** وایرگارد (Aether/WARP) — installed, and running? */
async function probeWireguard() {
    const installed = aether.isInstalled();
    if (!installed) {
        return {
            state: 'warn',
            detail: 'هسته‌ی وایرگارد روی سیستم نصب نیست.',
            hint: 'از تب وایرگارد یک بار آن را نصب کنید.',
        };
    }
    const status = aether.getStatus() || {};
    if (status.running) {
        // `connected` is the stronger signal: the process can be up while the tunnel is
        // still negotiating, and reporting that as "ready" sends the user off to debug
        // a config that was merely mid-handshake.
        const where = `پورت SOCKS ${aether.SOCKS_PORT}`;
        return status.connected
            ? { state: 'ok', detail: `وایرگارد متصل است — ${where}` }
            : { state: 'warn', detail: `وایرگارد در حال اجراست ولی هنوز متصل نشده (${status.stageFa || status.stage || 'در حال اتصال'})` };
    }
    return { state: 'warn', detail: 'وایرگارد نصب است ولی الان اجرا نمی‌شود.' };
}

// ── registry ─────────────────────────────────────────────────────────────────

const PROBES = {
    internet: probeInternet,
    dns: probeDns,
    cloudflare: probeCloudflareApi,
    worker: probeWorkerDomain,
    railway: probeRailway,
    google: probeGoogleScript,
    sanction: probeSanction,
    dedidns: probeDediDns,
    wireguard: probeWireguard,
};

async function runProbe(id, target) {
    const fn = PROBES[id];
    if (!fn) throw new Error(`probe نامعتبر: ${id}`);

    const started = now();
    return withDeadline(
        Promise.resolve()
            .then(() => fn(target))
            .catch(err => ({
                state: 'fail',
                detail: `بررسی انجام نشد — ${(err && err.message) || err}`,
            })),
        PROBE_TIMEOUT,
        () => ({
            state: 'fail',
            latency: now() - started,
            detail: 'بررسی در مهلت مقرر تمام نشد.',
            hint: 'این معمولاً یعنی مسیر مسدود است و پاسخی برنمی‌گردد.',
        })
    );
}

module.exports = function mountSystemCheck(app) {
    app.post('/api/systemcheck/probe', async (req, res) => {
        const { id, target } = req.body || {};
        try {
            const result = await runProbe(id, target);
            res.json({ ok: true, id, ...result });
        } catch (err) {
            res.status(400).json({ ok: false, id, error: err.message });
        }
    });
};

module.exports.runProbe = runProbe;
