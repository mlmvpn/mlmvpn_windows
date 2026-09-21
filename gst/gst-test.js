// --- GST real probes ---
// Every test here is a real network round-trip. Nothing is simulated, and nothing
// reports PASS on a status line alone: Apps Script keeps deleted deployments serving
// a placeholder page for a grace period, and several failure modes come back HTTP 200
// with an HTML error inside. Only the relay's own JSON envelope counts as success.
//
// Ported from the Android app's GstDiagnostics.kt, with the quota-exhaustion cases it
// does not have — telling "your daily budget ran out, back at 11:30" apart from "your
// script is broken" is the difference between the user waiting and the user pointlessly
// rebuilding a working relay.
//
// Probes run OUTSIDE the tunnel, over plain HTTPS. That is deliberate: the point is to
// judge the relay itself, so routing the probe through the thing under test would make
// a broken relay look unreachable and a bypassed one look healthy.

const https = require('https');
const { URL } = require('url');
const log = require('./gst-log');
const gstDns = require('./gst-dns');

// Tiny, always-up, returns 204 with an empty body — the cheapest possible thing to
// relay, so a slow probe means a slow relay rather than a slow target.
const PROBE_TARGET = 'https://www.gstatic.com/generate_204';

const RESULT = {
    OK: 'ok',
    AUTH_MISMATCH: 'auth_mismatch',
    NOT_FOUND: 'not_found',
    NOT_AUTHORIZED: 'not_authorized',
    NOT_CONFIGURED: 'not_configured',
    REDIRECT_BLOCKED: 'redirect_blocked',
    QUOTA: 'quota',
    UNREACHABLE: 'unreachable',
    BAD_RESPONSE: 'bad_response',
};

/** Apps Script web-app URL for a raw deployment id. */
function execUrl(deploymentId) {
    return `https://script.google.com/macros/s/${String(deploymentId).trim()}/exec`;
}

/**
 * POST JSON and follow redirects manually, so we can see WHERE we ended up.
 * Apps Script legitimately bounces /exec -> script.googleusercontent.com, but a bounce
 * to accounts.google.com means the deployment is not public — and that distinction is
 * invisible if the client follows redirects silently.
 */
function postJson(targetUrl, payload, { timeout = 20000, maxRedirects = 5 } = {}) {
    return new Promise((resolve, reject) => {
        const body = Buffer.from(JSON.stringify(payload), 'utf8');
        const started = Date.now();

        const go = (urlStr, depth, method, sendBody) => {
            if (depth > maxRedirects) {
                return reject(new Error('تعداد تغییر مسیرها بیش از حد بود'));
            }
            let u;
            try { u = new URL(urlStr); } catch (e) { return reject(new Error('آدرس نامعتبر است')); }

            const headers = { 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0' };
            if (sendBody) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = body.length;
            }

            const req = https.request({
                hostname: u.hostname,
                port: u.port || 443,
                path: u.pathname + u.search,
                method,
                headers,
                timeout,
                // Do not trust the system resolver for these probes. On the target
                // network `workers.dev` does not resolve through the ISP at all, which
                // made a live, healthy Worker report as unreachable.
                lookup: gstDns.lookup,
            }, res => {
                const loc = res.headers.location;
                if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
                    res.resume();   // drain, otherwise the socket stays open
                    // Redirects after a POST become GETs, exactly like a browser does.
                    return go(new URL(loc, urlStr).toString(), depth + 1, 'GET', false);
                }
                const chunks = [];
                let size = 0;
                res.on('data', d => {
                    // A relay pointed at the wrong thing can stream megabytes; we only
                    // ever need the first slice to classify the response.
                    if (size < 65536) { chunks.push(d); size += d.length; }
                });
                res.on('end', () => resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8'),
                    finalUrl: urlStr,
                    latency: Date.now() - started,
                }));
            });

            req.on('timeout', () => { req.destroy(new Error('پاسخی در زمان مجاز نیامد')); });
            req.on('error', reject);
            if (sendBody) req.write(body);
            req.end();
        };

        go(targetUrl, 0, 'POST', true);
    });
}

/** Google's quota walls say so in plain text; catching them early avoids a false "broken". */
function detectGoogleQuota(text) {
    return /Service invoked too many times|too many times for one day|Exceeded maximum execution time|quota|rate limit/i.test(text);
}

/** Cloudflare's are numeric: 1015 rate-limited, 1013/1102 CPU/duration, 429 generic. */
function detectCloudflareQuota(status, text) {
    return status === 429 || /\b(1015|1013|1102|1027)\b|Daily request limit|exceeded.*limit/i.test(text);
}

/**
 * Relay one probe through an endpoint that speaks the {k,u,m,h,b} protocol —
 * either an Apps Script /exec URL or a Cloudflare Worker URL. Both legs are tested
 * with the same function because both speak the same wire protocol; what differs is
 * only which secret they expect.
 */
async function probeEndpoint(endpointUrl, authKey, { label = 'relay', timeout = 20000 } = {}) {
    const started = Date.now();
    let res;
    try {
        res = await postJson(endpointUrl, {
            k: authKey,
            m: 'GET',
            u: PROBE_TARGET,
            h: {},
            r: true,
        }, { timeout });
    } catch (err) {
        return {
            result: RESULT.UNREACHABLE,
            state: 'error',
            latency: Date.now() - started,
            httpCode: 0,
            message: `در دسترس نیست: ${err.message}`,
        };
    }

    const { status, body, finalUrl, latency } = res;
    const preview = body.slice(0, 300);
    const base = { latency, httpCode: status, preview };

    // 1) The happy path: our own JSON envelope. `s` is the relayed upstream status.
    const trimmed = body.trimStart();
    if (trimmed.startsWith('{')) {
        let json = null;
        try { json = JSON.parse(body); } catch (e) { /* not our envelope after all */ }

        if (json && Object.prototype.hasOwnProperty.call(json, 's')) {
            const upstream = Number(json.s);
            // The probe target answers 204. Anything else means the relay reached
            // *something*, but not what we asked for — worth flagging, not failing.
            const healthy = upstream >= 200 && upstream < 400;
            return {
                ...base,
                result: RESULT.OK,
                // A working-but-slow relay is a real state the user should see before
                // it starts timing out mid-page.
                state: healthy ? (latency > 3000 ? 'slow' : 'ok') : 'error',
                message: healthy
                    ? `${latency > 3000 ? 'سالم ولی کند' : 'سالم'} — پاسخ مقصد: ${upstream}، ${latency}ms`
                    : `رله کار می‌کند ولی مقصد کد ${upstream} برگرداند`,
            };
        }

        if (json && json.e) {
            const e = String(json.e);
            if (/unauthorized/i.test(e)) {
                return {
                    ...base,
                    result: RESULT.AUTH_MISMATCH,
                    state: 'error',
                    message: 'رمز با اسکریپت مستقرشده یکی نیست — اسکریپت را با رمز فعلی دوباره Deploy کنید.',
                };
            }
            if (detectGoogleQuota(e) || detectCloudflareQuota(status, e)) {
                return { ...base, result: RESULT.QUOTA, state: 'quota', message: `سهمیه تمام شده: ${e}` };
            }
            return { ...base, result: RESULT.BAD_RESPONSE, state: 'error', message: `رله خطا برگرداند: ${e}` };
        }
    }

    // 2) Quota walls arrive as HTML/plain text, before any JSON is produced.
    if (detectCloudflareQuota(status, body)) {
        return {
            ...base,
            result: RESULT.QUOTA,
            state: 'quota',
            message: 'سهمیه‌ی روزانه‌ی Worker کلادفلر تمام شده است.',
        };
    }
    if (detectGoogleQuota(body)) {
        return {
            ...base,
            result: RESULT.QUOTA,
            state: 'quota',
            message: 'سهمیه‌ی روزانه‌ی این حساب گوگل تمام شده است.',
        };
    }

    // 3) Decoy / placeholder HTML. Both our Apps Script and our Worker answer a bland
    //    page when the key is wrong, precisely so a scanner cannot fingerprint them —
    //    which means "decoy" is the signature of a bad key or a stale deployment id.
    if (/<title>\s*Web App\s*<\/title>/i.test(body) || /did not return anything/i.test(body)) {
        return {
            ...base,
            result: RESULT.AUTH_MISMATCH,
            state: 'error',
            message: 'صفحه‌ی جایگزین برگشت — یعنی رمز اشتباه است یا این Deployment دیگر وجود ندارد.',
        };
    }

    // 4) 404 means "no such endpoint", but WHAT is missing depends on which leg we are
    //    probing — this same function serves both. On the Google side it is a wrong or
    //    stale Deployment ID; on the Cloudflare side it is usually a Worker that was
    //    deployed seconds ago and is not live at the edge yet, or one that was deleted
    //    from the dashboard. Telling a user redeploying a Worker that their "Google
    //    deployment id is wrong" sends them to fix something that is not broken.
    //
    //    This check must also come BEFORE the 403 branch below: Google serves its
    //    generic Docs error page for a missing deployment, and that page carries the
    //    same "docs.google.com" markers as the not-authorized page.
    if (status === 404) {
        const isWorker = label === 'worker' || label === 'worker-reach';
        return {
            ...base,
            result: RESULT.NOT_FOUND,
            state: 'error',
            message: isWorker
                ? 'Worker روی این آدرس پاسخ نداد — اگر همین الان ساخته شده چند ثانیه صبر کنید، ' +
                  'وگرنه احتمالاً از داشبورد کلادفلر حذف شده است.'
                : 'گوگل چنین Deployment‌ای ندارد — شناسه‌ی دیپلویمنت اشتباه است یا آن دیپلویمنت حذف شده.',
        };
    }

    // 5) Deployed but never authorized: the single most common failure right after a
    //    manual deploy, and the one users misread as "the app is broken".
    if (status === 403 && /docs\.google\.com|userscripts|پردازش کلمه/i.test(body)) {
        return {
            ...base,
            result: RESULT.NOT_AUTHORIZED,
            state: 'error',
            message: `اسکریپت هنوز تأیید (Authorize) نشده. این آدرس را در مرورگر باز کنید و Review Permissions → Advanced → Allow را بزنید:\n${endpointUrl}`,
        };
    }

    // 5) Bounced to the Google sign-in wall: deployment access is not "Anyone".
    if (/accounts\.google\.com/i.test(body) || /accounts\.google\.com/i.test(finalUrl)) {
        return {
            ...base,
            result: RESULT.REDIRECT_BLOCKED,
            state: 'error',
            message: 'به صفحه‌ی ورود گوگل هدایت شد — هنگام Deploy باید «Who has access: Anyone» و «Execute as: Me» باشد.',
        };
    }

    log.warn('test', `پاسخ ناشناخته از ${label} (HTTP ${status}): ${preview.replace(/\s+/g, ' ').slice(0, 120)}`);
    return {
        ...base,
        result: RESULT.BAD_RESPONSE,
        state: 'error',
        message: `پاسخ ناشناخته (HTTP ${status}). جزئیات در لاگ هسته.`,
    };
}

/** Probe a relay's Google (Apps Script) leg. */
async function testGoogleLeg(relay, authKey) {
    // A half-built relay is not a fault — the user simply has not finished the wizard.
    // Reporting it as "broken" (as an earlier version did) sends them hunting for a
    // problem that does not exist.
    if (!relay.deploymentId) {
        return {
            result: RESULT.NOT_CONFIGURED,
            state: 'unknown',
            message: 'هنوز اسکریپت گوگل برای این ریلی ساخته نشده.',
        };
    }
    log.info('test', `تست پای گوگلِ ریلی «${relay.name}» (${log.redact(relay.deploymentId)})…`);
    const r = await probeEndpoint(execUrl(relay.deploymentId), authKey, { label: 'apps-script' });
    // 'slow' means the relay answered correctly, just late — logging it with ✗ produced
    // the contradictory «✗ … : سالم» line. Only genuine failures get the error mark.
    (r.state === 'ok' ? log.ok : (r.state === 'slow' || r.state === 'quota') ? log.warn : log.error)
        ('test', `گوگلِ «${relay.name}»: ${r.message}`);
    return r;
}

/**
 * Probe a relay's Cloudflare leg — directly, not through Apps Script.
 * Hitting the Worker on its own URL is what makes the two legs separately diagnosable:
 * if Google fails and Cloudflare passes, the script is at fault, and vice versa.
 */
async function testCloudflareLeg(relay) {
    if (!relay.workerUrl) {
        return { result: RESULT.BAD_RESPONSE, state: 'off', message: 'برای این ریلی Worker ساخته نشده.' };
    }
    log.info('test', `تست پای کلادفلرِ ریلی «${relay.name}»…`);
    const r = await probeEndpoint(relay.workerUrl, relay.cfAuthKey, { label: 'worker', timeout: 15000 });
    // 'slow' means the relay answered correctly, just late — logging it with ✗ produced
    // the contradictory «✗ … : سالم» line. Only genuine failures get the error mark.
    (r.state === 'ok' ? log.ok : (r.state === 'slow' || r.state === 'quota') ? log.warn : log.error)
        ('test', `کلادفلرِ «${relay.name}»: ${r.message}`);
    return r;
}

/**
 * Is script.google.com reachable from this machine at all?
 * Used by the wizard's "open the road to Google" step; a plain GET is enough because
 * we only care whether the host answers, not what it says.
 */
function testGoogleReachable({ timeout = 12000 } = {}) {
    return new Promise(resolve => {
        const started = Date.now();
        const req = https.request({
            hostname: 'script.google.com',
            port: 443,
            path: '/',
            method: 'GET',
            timeout,
            headers: { 'User-Agent': 'Mozilla/5.0' },
            lookup: gstDns.lookup,
        }, res => {
            res.resume();
            // Any HTTP answer proves the TLS path is open — even a 302 to a login page.
            resolve({ reachable: true, status: res.statusCode, latency: Date.now() - started });
        });
        req.on('timeout', () => { req.destroy(); resolve({ reachable: false, error: 'زمان پاسخ تمام شد' }); });
        req.on('error', err => resolve({ reachable: false, error: err.message }));
        req.end();
    });
}

// Cloudflare's own trace endpoint. Returns a tiny key=value body including the caller's
// egress IP and the datacentre that served it — no API key, no rate limit worth worrying
// about, and it is the authority on whether a request arrived from inside Cloudflare.
const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

function parseTrace(text) {
    const out = {};
    for (const line of String(text).split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return out;
}

/** Relay a trace request through an endpoint and report the egress it came out of. */
async function traceThrough(endpointUrl, authKey, label) {
    const res = await probeEndpointRaw(endpointUrl, authKey, TRACE_URL, label);
    if (!res.ok) return { ok: false, error: res.error };

    const t = parseTrace(res.body);
    return { ok: true, ip: t.ip || '', colo: t.colo || '', loc: t.loc || '', latency: res.latency };
}

/** Like probeEndpoint, but returns the relayed BODY rather than a health verdict. */
async function probeEndpointRaw(endpointUrl, authKey, targetUrl, label) {
    const started = Date.now();
    let res;
    try {
        res = await postJson(endpointUrl, { k: authKey, m: 'GET', u: targetUrl, h: {}, r: true },
            { timeout: 25000 });
    } catch (err) {
        return { ok: false, error: err.message };
    }

    let json = null;
    try { json = JSON.parse(res.body); } catch (e) { /* not our envelope */ }
    if (!json || !Object.prototype.hasOwnProperty.call(json, 'b')) {
        return { ok: false, error: json && json.e ? String(json.e) : `پاسخ نامعتبر (HTTP ${res.status})` };
    }

    let body = '';
    try { body = Buffer.from(json.b, 'base64').toString('utf8'); } catch (e) { /* leave empty */ }
    return { ok: true, body, status: json.s, latency: Date.now() - started };
}

/**
 * Is this relay ACTUALLY going through Cloudflare?
 *
 * The switch in the panel only records intent; what decides the real path is the
 * WORKER_URL constant inside the user's deployed Apps Script, which this app cannot
 * read. And the script fails OPEN by design — if the Worker misbehaves it quietly
 * fetches directly — so "the Worker is healthy" does not prove traffic uses it.
 *
 * So compare egress instead of trusting configuration:
 *   A) through the Apps Script  — client -> Google -> (Worker?) -> target
 *   B) through the Worker alone — client -> Worker -> target
 * If the Apps Script path exits from the SAME address as the Worker path, the script is
 * forwarding. If it exits from a different address, it is fetching directly from Google
 * and the combination is not in effect, whatever the panel says.
 */
async function testCombination(relay, authKey) {
    if (!relay.deploymentId) {
        return { ok: false, message: 'برای این ریلی اسکریپت گوگل ساخته نشده است.' };
    }
    if (!relay.workerUrl || !relay.cfAuthKey) {
        return { ok: false, message: 'برای این ریلی Worker کلادفلر ساخته نشده است.' };
    }

    log.info('test', `بررسی ترکیب کلادفلر برای ریلی «${relay.name}»…`);

    const [viaScript, viaWorker] = await Promise.all([
        traceThrough(execUrl(relay.deploymentId), authKey, 'apps-script'),
        traceThrough(relay.workerUrl, relay.cfAuthKey, 'worker'),
    ]);

    if (!viaWorker.ok) {
        log.error('test', `Worker پاسخ نداد: ${viaWorker.error}`);
        return { ok: false, viaScript, viaWorker, message: `Worker پاسخ نداد: ${viaWorker.error}` };
    }
    if (!viaScript.ok) {
        log.error('test', `اسکریپت گوگل پاسخ نداد: ${viaScript.error}`);
        return { ok: false, viaScript, viaWorker, message: `اسکریپت گوگل پاسخ نداد: ${viaScript.error}` };
    }

    const combined = !!viaScript.ip && viaScript.ip === viaWorker.ip;

    const result = {
        ok: true,
        combined,
        viaScript,
        viaWorker,
        message: combined
            ? `✅ ترکیب فعال است — هر دو مسیر از ${viaScript.ip} (${viaScript.colo || '—'}) خارج می‌شوند.`
            : `⚠ ترکیب فعال نیست. اسکریپت گوگل مستقیم خارج می‌شود (${viaScript.ip}) ولی Worker از ` +
              `${viaWorker.ip} — یعنی WORKER_URL داخل اسکریپت گوگل خالی است یا اشتباه.`,
        // Only meaningful when combined; comparing latencies otherwise compares two
        // different routes rather than the same route with and without the accelerator.
        latency: { viaScript: viaScript.latency, viaWorker: viaWorker.latency },
    };

    (combined ? log.ok : log.warn)('test', result.message);
    return result;
}

module.exports = {
    RESULT,
    PROBE_TARGET,
    TRACE_URL,
    execUrl,
    probeEndpoint,
    testGoogleLeg,
    testCloudflareLeg,
    testGoogleReachable,
    testCombination,
    traceThrough,
};
