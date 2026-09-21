// --- GST API routes ---
// Mounted from server.js with a single line:
//     require('./gst/routes')(app, { broadcastLog });
// Everything the panel needs lives under /api/gst/*.

const store = require('./gst-config');
const core = require('./gst-core');
const health = require('./gst-health');
const cert = require('./gst-cert');
const cfDeployer = require('./gst-deployer-cf');
const scriptBuilder = require('./gst-script-builder');
const reach = require('./gst-google-reach');
const scan = require('./gst-scan');
const runtime = require('./gst-runtime');
const backup = require('./gst-backup');
const quota = require('./gst-quota');
const test = require('./gst-test');
const log = require('./gst-log');

/**
 * Wrap an async handler so a rejected promise becomes a 500 with a Persian message
 * instead of an unhandled rejection that silently hangs the request. Every route in
 * this file talks to a child process or the filesystem, so this is not optional.
 */
function handle(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req, res);
            if (!res.headersSent) res.json(result ?? { ok: true });
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            log.error('api', message);
            if (!res.headersSent) res.status(500).json({ ok: false, error: message });
        }
    };
}

module.exports = function registerGstRoutes(app, { broadcastLog } = {}) {
    if (broadcastLog) log.setBroadcaster(broadcastLog);

    // ── status & logs ─────────────────────────────────────────────────────────

    app.get('/api/gst/status', handle(async () => ({
        ok: true,
        ...core.getStatus(),
        relays: store.getRelays(),
        network: store.getNetwork(),
        // The shared key is shown in the wizard, so the panel needs it — but only
        // ever as the real value the user must paste into Apps Script. There is no
        // point redacting it here and then serving it unredacted from /script.
        authKey: store.load().authKey,
    })));

    app.get('/api/gst/logs', handle(async () => ({ ok: true, logs: log.getLogs() })));

    // ── tunnel control ────────────────────────────────────────────────────────

    app.post('/api/gst/start', handle(async () => ({ ok: true, ...(await core.start()) })));
    app.post('/api/gst/stop', handle(async () => ({ ok: true, ...(await core.stop()) })));
    app.post('/api/gst/restart', handle(async () => ({ ok: true, ...(await core.restart()) })));

    // ── relays (unlimited) ────────────────────────────────────────────────────

    app.get('/api/gst/relays', handle(async () => ({ ok: true, relays: store.getRelays() })));

    app.post('/api/gst/relays', handle(async (req) => ({
        ok: true,
        relay: store.addRelay(req.body || {}),
    })));

    app.post('/api/gst/relays/:id', handle(async (req) => {
        const relay = store.updateRelay(req.params.id, req.body || {});
        if (!relay) throw new Error('ریلی پیدا نشد.');
        return { ok: true, relay };
    }));

    app.delete('/api/gst/relays/:id', handle(async (req) => {
        if (!store.removeRelay(req.params.id)) throw new Error('ریلی پیدا نشد.');
        return { ok: true };
    }));

    app.post('/api/gst/relays/reorder', handle(async (req) => ({
        ok: true,
        relays: store.reorderRelays((req.body && req.body.ids) || []),
    })));

    // The per-relay Cloudflare switch — separate from the generic update route so the
    // "no Worker deployed yet" guard cannot be bypassed by a plain field write.
    app.post('/api/gst/relays/:id/cloudflare', handle(async (req) => {
        const enabled = !!(req.body && req.body.enabled);
        const relay = store.setCloudflare(req.params.id, enabled);
        if (!relay) throw new Error('ریلی پیدا نشد.');

        // IMPORTANT: this switch alone does NOT change where traffic goes.
        //
        // The actual route is decided by the WORKER_URL constant inside the user's
        // deployed Apps Script, which lives on Google's servers and cannot be edited
        // from here. Flipping the switch and saying nothing produced exactly the
        // confusion it should have prevented: the panel said Cloudflare was off while
        // every IP-check site still reported a Cloudflare address, because the script
        // kept forwarding. So hand back the two lines that have to change, and let the
        // panel say plainly that the change is not live yet.
        const patch = scriptBuilder.cloudflarePatch(relay, enabled);

        return {
            ok: true,
            relay,
            pending: true,
            patch,
            message: enabled
                ? 'سوییچ روشن شد، ولی تا وقتی اسکریپت گوگل به‌روزرسانی نشود ترافیک از کلادفلر عبور نمی‌کند.'
                : 'سوییچ خاموش شد، ولی تا وقتی اسکریپت گوگل به‌روزرسانی نشود ترافیک همچنان از کلادفلر می‌رود.',
        };
    }));

    // ── network path (tab 3) ──────────────────────────────────────────────────

    app.get('/api/gst/network', handle(async () => ({ ok: true, network: store.getNetwork() })));

    app.post('/api/gst/network', handle(async (req) => {
        const network = store.setNetwork(req.body || {});
        // Applying a new IP/SNI while connected must not require the user to manually
        // reconnect — the panel promises "without dropping the connection".
        if (core.isRunning()) await core.restart();
        return { ok: true, network };
    }));

    // ── network path scanning ─────────────────────────────────────────────────
    // All three are slow on purpose: they are real TLS handshakes, run through the same
    // engine the tunnel uses, so a green row means a path that actually carries traffic.

    app.post('/api/gst/scan/ips', handle(async () => ({ ok: true, ...(await scan.scanIps()) })));

    app.post('/api/gst/scan/snis', handle(async () => ({ ok: true, ...(await scan.scanSnis()) })));

    app.post('/api/gst/scan/optimize', handle(async (req) => {
        const result = await scan.optimize({ scan: !(req.body && req.body.skipIpScan) });
        // Apply immediately when connected, so "optimise" means the tunnel is faster
        // now rather than after the next manual reconnect.
        if (core.isRunning() && result.changed) await core.restart();
        return { ok: true, ...result, network: store.getNetwork() };
    }));

    // ── backup / restore / sharing ────────────────────────────────────────────

    app.post('/api/gst/backup/export', handle(async (req) => ({
        ok: true,
        ...backup.exportLink(req.body || {}),
    })));

    // Read-only look at a link, so the panel can show what an import would do before it
    // touches anything.
    app.post('/api/gst/backup/preview', handle(async (req) => ({
        ok: true,
        preview: backup.preview((req.body || {}).link, (req.body || {}).passphrase),
    })));

    app.post('/api/gst/backup/import', handle(async (req) => {
        const { link, passphrase, mode } = req.body || {};
        const result = backup.importLink(link, passphrase, { mode });
        // New relays change the engine's config, so a running tunnel has to pick them up.
        if (core.isRunning()) await core.restart();
        return { ok: true, ...result, relays: store.getRelays() };
    }));

    // ── connection modes ──────────────────────────────────────────────────────
    // Two of them: local only, and system proxy. The full-tunnel mode was removed — see the
    // header of gst-runtime.js for what was measured before giving up on it.

    app.get('/api/gst/mode', handle(async () => ({ ok: true, ...(await runtime.getState()) })));

    app.post('/api/gst/mode/sysproxy', handle(async (req) => ({
        ok: true,
        ...(await runtime.setSystemProxy(!!(req.body && req.body.enabled))),
    })));


    // ── runtime settings (ports, auto-optimise flag) ──────────────────────────

    app.post('/api/gst/runtime', handle(async (req) => ({
        ok: true,
        runtime: store.setRuntime(req.body || {}),
    })));

    // ── Apps Script text + deployment id ──────────────────────────────────────

    // The exact text to paste. Built per relay so the Worker URL and keys are already in.
    app.get('/api/gst/script/:id', handle(async (req) => {
        const relay = store.getRelay(req.params.id);
        if (!relay) throw new Error('ریلی پیدا نشد.');
        const withCf = req.query.cf === undefined ? undefined : req.query.cf === '1';
        return {
            ok: true,
            ...scriptBuilder.buildForRelay(relay, store.load().authKey, { withCloudflare: withCf }),
        };
    }));

    // Two-line diff for turning Cloudflare on/off on an existing relay — far less
    // error-prone than re-pasting the whole script to change two constants.
    app.get('/api/gst/script/:id/patch', handle(async (req) => {
        const relay = store.getRelay(req.params.id);
        if (!relay) throw new Error('ریلی پیدا نشد.');
        return { ok: true, ...scriptBuilder.cloudflarePatch(relay, req.query.enable !== '0') };
    }));

    // Save the deployment id the user pasted, then immediately prove it works.
    app.post('/api/gst/relays/:id/deployment', handle(async (req) => {
        const check = scriptBuilder.validateDeploymentId(req.body && req.body.deploymentId);
        if (!check.valid) throw new Error(check.message);

        const relay = store.updateRelay(req.params.id, { deploymentId: check.cleaned });
        if (!relay) throw new Error('ریلی پیدا نشد.');

        const probe = await test.testGoogleLeg(relay, store.load().authKey);
        return { ok: true, relay, probe };
    }));

    // ── reaching Google (sanction handling, silent) ───────────────────────────

    app.post('/api/gst/reach/open', handle(async () => ({ ok: true, ...(await reach.open()) })));

    app.post('/api/gst/reach/restore', handle(async () => ({ ok: true, ...(await reach.restore()) })));

    // ── Cloudflare Worker ─────────────────────────────────────────────────────

    // Accounts come from the cloud panel; the wizard shows them in a <select>.
    app.get('/api/gst/cf/accounts', handle(async () => ({
        ok: true,
        accounts: cfDeployer.getAccounts().map(a => ({ id: a.id, name: a.name, email: a.email })),
    })));

    app.post('/api/gst/cf/deploy/:id', handle(async (req) => {
        const accountId = req.body && req.body.accountId;
        if (!accountId) throw new Error('حساب کلادفلر انتخاب نشده است.');

        const result = await cfDeployer.deployForRelay(req.params.id, accountId);

        // Prove it works before telling the user it does. A Worker that uploaded but
        // does not answer is the failure mode that would otherwise surface much later,
        // as a mysteriously dead relay.
        //
        // Retried, because a freshly deployed Worker is briefly not live at the edge:
        // measured here, the first probe came back 404 and the next one succeeded with
        // HTTP 204 in 463ms. Reporting that first 404 as a failure would tell the user
        // their brand-new Worker is broken while it is simply still coming up.
        let probe = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
            probe = await test.probeEndpoint(result.workerUrl, result.authKey,
                { label: 'worker', timeout: 15000 });
            if (probe.state === 'ok' || probe.state === 'slow') break;
            if (attempt < 4) {
                log.info('worker', `Worker هنوز آماده نیست (تلاش ${attempt}) — چند ثانیه صبر…`);
                await new Promise(r => setTimeout(r, 6000));
            }
        }

        return { ok: true, worker: result, probe, relay: store.getRelay(req.params.id) };
    }));

    app.post('/api/gst/cf/delete/:id', handle(async (req) => ({
        ok: true,
        result: await cfDeployer.deleteForRelay(req.params.id),
    })));

    // ── certificate ───────────────────────────────────────────────────────────

    app.get('/api/gst/cert', handle(async () => ({ ok: true, cert: await cert.getStatus() })));

    app.post('/api/gst/cert/install', handle(async () => ({ ok: true, cert: await cert.install() })));

    app.post('/api/gst/cert/browsers', handle(async () => ({
        ok: true,
        result: await cert.installForBrowsers(),
    })));

    // Removing a root certificate is a real change to the user's machine, so it is its
    // own explicit endpoint rather than a flag on install.
    app.post('/api/gst/cert/remove', handle(async () => ({ ok: true, cert: await cert.remove() })));

    // ── health, quota, repair ─────────────────────────────────────────────────

    // Cached sweep — cheap, so the panel can call it on every open without probing.
    app.get('/api/gst/health', handle(async () => ({
        ok: true,
        report: health.getLastReport(),
        reset: quota.getResetInfo(),
    })));

    // Real 2n-probe sweep. Slow by nature (it is doing actual network work), so the
    // panel shows a progress bar rather than blocking silently.
    app.post('/api/gst/health/check', handle(async () => ({
        ok: true,
        report: await health.runFullCheck(),
    })));

    app.post('/api/gst/health/check/:id', handle(async (req) => ({
        ok: true,
        report: await health.checkOne(req.params.id),
    })));

    // "Is Cloudflare really in the path?" — decided by comparing egress addresses, not
    // by trusting the panel's switch. See testCombination.
    app.post('/api/gst/health/combination/:id', handle(async (req) => {
        const relay = store.getRelay(req.params.id);
        if (!relay) throw new Error('ریلی پیدا نشد.');
        return { ok: true, result: await test.testCombination(relay, store.load().authKey) };
    }));

    app.get('/api/gst/quota', handle(async () => ({
        ok: true,
        fleet: quota.getFleetSummary(store.getRelays()),
        reset: quota.getResetInfo(),
    })));

    // Is script.google.com reachable at all? Used by the wizard and by the health tab's
    // "دسترسی به گوگل" row.
    app.get('/api/gst/reach', handle(async () => ({
        ok: true,
        google: await test.testGoogleReachable(),
    })));

    // Background sweeps keep the activity-bar badge honest without the user opening the
    // panel — but only once relays exist (see startPeriodic).
    // Before anything else: undo machine-wide state a previous run may have left behind
    // after being killed rather than closed. See healAfterCrash.
    runtime.healAfterCrash().catch(err => log.warn('runtime', `پاک‌سازی اولیه ناموفق بود: ${err.message}`));

    health.startPeriodic();
    scan.startAutoOptimize();

    log.info('api', 'مسیرهای تونل گوگل اسکریپت ثبت شد');
};
