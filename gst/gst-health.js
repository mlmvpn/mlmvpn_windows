// --- GST health checks ---
// Runs the real probes across every relay and assembles the verdict the health tab
// renders. For n relays this is 2n probes — one per leg — because the whole promise of
// the health tab is telling the user WHICH leg is broken, and a single combined probe
// through the chain cannot distinguish them.
//
// Probes run in parallel with a concurrency cap: ten relays fired at once from an Iranian
// connection produce timeouts caused by our own burst rather than by the relays.

const store = require('./gst-config');
const test = require('./gst-test');
const quota = require('./gst-quota');
const repair = require('./gst-repair');
const log = require('./gst-log');

const CONCURRENCY = 6;

let lastReport = null;
let inFlight = null;      // de-dupes concurrent callers onto one run
let periodicTimer = null;

/** Run `jobs` (thunks) with a bounded number in flight; results keep input order. */
async function pool(jobs, limit = CONCURRENCY) {
    const results = new Array(jobs.length);
    let next = 0;
    const workers = new Array(Math.min(limit, jobs.length)).fill(0).map(async () => {
        while (true) {
            const i = next++;
            if (i >= jobs.length) return;
            try { results[i] = await jobs[i](); }
            catch (err) { results[i] = { state: 'error', result: 'bad_response', message: err.message }; }
        }
    });
    await Promise.all(workers);
    return results;
}

/** Probe both legs of one relay. The CF leg is skipped when the user turned it off. */
async function checkRelay(relay, authKey) {
    const jobs = [() => test.testGoogleLeg(relay, authKey)];
    if (relay.cfEnabled && relay.workerUrl) jobs.push(() => test.testCloudflareLeg(relay));

    const [google, cf] = await pool(jobs, 2);
    return { google, cf: cf || null };
}

/**
 * Full sweep across every relay.
 * @param onProgress optional (done, total) => void, so the panel's progress bar reflects
 *   real completions rather than a fake animation.
 */
async function runFullCheck({ onProgress } = {}) {
    // Two callers (the user's button and the periodic timer) must not double the probe
    // load; the second one rides along on the first one's results.
    if (inFlight) return inFlight;

    inFlight = (async () => {
        const cfg = store.load();
        const relays = cfg.relays.slice().sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
        const reset = quota.getResetInfo();

        // Count the legs we will actually probe so the progress bar's denominator is honest.
        const legTotal = relays.reduce(
            (n, r) => n + 1 + (r.cfEnabled && r.workerUrl ? 1 : 0), 0);
        log.info('health', `شروع بررسی سلامت: ${relays.length} ریلی، ${legTotal} بررسی`);

        let done = 0;
        const bump = () => { done++; if (onProgress) onProgress(done, legTotal); };

        const jobs = relays.map(relay => async () => {
            const legs = await checkRelay(relay, cfg.authKey);
            bump();
            if (legs.cf) bump();

            const verdict = repair.summarize(relay, legs.google, legs.cf);
            const q = quota.getRelayQuota(relay.id);

            // Advice is attached per leg, so the panel never has to decide which message
            // belongs to which lamp.
            const googleAdvice = (legs.google && ['ok', 'slow'].includes(legs.google.state))
                ? null : repair.adviseGoogle(legs.google || {}, relay, reset);
            const cfAdvice = (!legs.cf || ['ok', 'slow'].includes(legs.cf.state))
                ? null : repair.adviseCloudflare(legs.cf, relay, reset);

            return {
                id: relay.id,
                name: relay.name,
                cfEnabled: !!relay.cfEnabled,
                google: legs.google,
                cf: legs.cf,
                verdict,
                quota: q,
                advice: { google: googleAdvice, cloudflare: cfAdvice },
            };
        });

        const relayReports = await pool(jobs, Math.max(1, Math.floor(CONCURRENCY / 2)));

        const counts = { ok: 0, degraded: 0, quota: 0, incomplete: 0, error: 0 };
        for (const r of relayReports) counts[r.verdict.state] = (counts[r.verdict.state] || 0) + 1;

        lastReport = {
            at: Date.now(),
            relays: relayReports,
            counts,
            fleet: quota.getFleetSummary(cfg.relays),
            reset,
        };

        // Warn, not info, when anything is off: in a quiet (background) sweep info lines
        // are dropped, and a sweep that found broken relays must still say so.
        const allWell = counts.degraded + counts.quota + counts.incomplete + counts.error === 0;
        (allWell ? log.info : log.warn)('health',
            `پایان بررسی: ${counts.ok} سالم، ${counts.degraded} نیمه‌سالم، ` +
            `${counts.quota} سهمیه تمام، ${counts.incomplete} ناتمام، ${counts.error} خراب`);
        return lastReport;
    })();

    try { return await inFlight; }
    finally { inFlight = null; }
}

/** Probe a single relay on demand (the per-card "تست" button). */
async function checkOne(relayId) {
    const cfg = store.load();
    const relay = cfg.relays.find(r => r.id === relayId);
    if (!relay) throw new Error('ریلی پیدا نشد.');

    const reset = quota.getResetInfo();
    const legs = await checkRelay(relay, cfg.authKey);
    const verdict = repair.summarize(relay, legs.google, legs.cf);

    const report = {
        id: relay.id,
        name: relay.name,
        cfEnabled: !!relay.cfEnabled,
        google: legs.google,
        cf: legs.cf,
        verdict,
        quota: quota.getRelayQuota(relay.id),
        advice: {
            google: (legs.google && ['ok', 'slow'].includes(legs.google.state))
                ? null : repair.adviseGoogle(legs.google || {}, relay, reset),
            cloudflare: (!legs.cf || ['ok', 'slow'].includes(legs.cf.state))
                ? null : repair.adviseCloudflare(legs.cf, relay, reset),
        },
    };

    // Fold the fresh result into the cached sweep so the panel does not show a stale
    // lamp next to a freshly tested one.
    if (lastReport) {
        const i = lastReport.relays.findIndex(r => r.id === relayId);
        if (i >= 0) lastReport.relays[i] = report;
    }
    return report;
}

function getLastReport() {
    return lastReport;
}

/**
 * Background sweep every `intervalMs`. Skipped entirely when there are no relays, so a
 * fresh install never runs probes nobody asked for.
 */
function startPeriodic(intervalMs = 5 * 60 * 1000) {
    stopPeriodic();
    periodicTimer = setInterval(() => {
        if (!store.getUsableRelays().length) return;
        // Quiet: nobody asked for this run, so it may only interrupt the core log when it
        // has bad news. The user-triggered sweep stays fully verbose.
        log.quiet(() => runFullCheck())
            .catch(err => log.warn('health', `بررسی دوره‌ای ناموفق بود: ${err.message}`));
    }, intervalMs);
    // Node keeps the process alive for pending timers; this one must not hold the app open.
    if (periodicTimer.unref) periodicTimer.unref();
}

function stopPeriodic() {
    if (periodicTimer) clearInterval(periodicTimer);
    periodicTimer = null;
}

module.exports = { runFullCheck, checkOne, getLastReport, startPeriodic, stopPeriodic };
