// --- VodiWalker API routes ---
// Mounted from server.js with one line:
//     require('./vodi/routes')(app, { broadcastLog });
// Everything the «کانفیگ آیپی ثابت» panel needs lives under /api/vodi/*.
//
// User management (create/list/edit/delete configs on the panel) is proxied through here
// rather than called from the renderer: the admin credentials stay server-side and we dodge
// the CORS trouble of the panel's allow_origins:* + credentials.

const store = require('./vodi-config');
const deployer = require('./vodi-deployer-railway');
const oauth = require('./vodi-oauth');
const github = require('./vodi-github');

function handle(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req, res);
            if (!res.headersSent) res.json(result ?? { ok: true });
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (!res.headersSent) res.status(500).json({ ok: false, error: message });
        }
    };
}

function gwOr404(id) {
    const gw = store.getGateway(id);
    if (!gw) throw new Error('gateway پیدا نشد.');
    return gw;
}

module.exports = function registerVodiRoutes(app, { broadcastLog } = {}) {
    // aetherBroadcastLog takes a single string line and fans it out as a core_log WS
    // message. Tag with [VodiWalker] so the panel (and the wizard's WS tap) can pick it out.
    const emitLog = (msg) => {
        try { if (broadcastLog) broadcastLog(`[VodiWalker] ${msg}`); } catch (e) {}
    };

    // ── static metadata ─────────────────────────────────────────────────────────
    app.get('/api/vodi/regions', handle(async () => ({ ok: true, regions: deployer.REGIONS })));

    // Railway accounts the user has saved (token never returned to the UI).
    app.get('/api/vodi/railway/accounts', handle(async () => ({
        ok: true,
        accounts: deployer.getAccounts().map(a => ({ id: a.id, name: a.name })),
    })));

    app.post('/api/vodi/railway/verify', handle(async (req) => {
        const accountId = req.body && req.body.accountId;
        if (!accountId) throw new Error('حساب Railway انتخاب نشده است.');
        const acc = await deployer.resolveAccount(accountId);
        const who = await deployer.verifyToken(acc.token);
        return { ok: true, account: who };
    }));

    // ── Login with Railway (OAuth 2.0 + PKCE) ────────────────────────────────────
    // Replaces manual token entry. start() opens the system browser and returns; the
    // panel polls status() until the loopback callback has completed the exchange.

    app.get('/api/vodi/oauth/status', handle(async () => ({ ok: true, ...oauth.status() })));

    app.post('/api/vodi/oauth/start', handle(async (req) => {
        const clientId = req.body && req.body.clientId;
        const r = await oauth.startLogin({ clientId });
        emitLog('پنجرهٔ ورود Railway در مرورگر باز شد…');
        return { ok: true, ...r };
    }));

    // No accountId = sign out of every connected Railway account.
    app.post('/api/vodi/oauth/disconnect', handle(async (req) => ({
        ok: true, ...oauth.disconnect(req.body && req.body.accountId),
    })));

    // ── GitHub (Device Flow) ─────────────────────────────────────────────────────
    // Railway only verifies an account whose linked GitHub owns at least one repository,
    // so this exists purely to guarantee that precondition.

    app.get('/api/vodi/github/status', handle(async () => ({ ok: true, ...github.status() })));

    app.post('/api/vodi/github/start', handle(async () => {
        const r = await github.startLogin();
        emitLog(`ورود گیت‌هاب: کد ${r.userCode} را در مرورگر وارد کنید.`);
        return { ok: true, ...r };
    }));

    app.post('/api/vodi/github/ensure-repo', handle(async (req) => {
        const r = await github.ensureRepo(req.body && req.body.accountId);
        emitLog(r.hadRepo
            ? `گیت‌هاب «${r.login}» از قبل ریپازیتوری دارد (${r.repo}).`
            : `ریپازیتوری «${r.repo}» برای «${r.login}» ساخته شد.`);
        return { ok: true, ...r };
    }));

    app.post('/api/vodi/github/disconnect', handle(async (req) => ({
        ok: true, ...github.disconnect(req.body && req.body.accountId),
    })));

    app.post('/api/vodi/github/cancel', handle(async () => ({ ok: true, ...github.cancelPending() })));

    // ── gateways ─────────────────────────────────────────────────────────────────
    app.get('/api/vodi/gateways', handle(async () => ({
        ok: true,
        gateways: store.getGateways().map(g => ({
            id: g.id, name: g.name, region: g.region, domain: g.domain,
            adminUsername: g.adminUsername || store.DEFAULT_ADMIN_USERNAME,
            adminPassword: g.adminPassword, source: g.source || '', createdAt: g.createdAt,
        })),
    })));

    app.post('/api/vodi/deploy', handle(async (req) => {
        const { accountId, name, region, adminUsername, adminPassword } = req.body || {};
        if (!accountId) throw new Error('حساب Railway انتخاب نشده است.');
        const result = await deployer.deployGateway({
            accountId, name, region, adminUsername, adminPassword, onLog: emitLog,
        });
        return { ok: true, ...result };
    }));

    app.delete('/api/vodi/gateways/:id', handle(async (req) => {
        gwOr404(req.params.id);
        return { ok: true, ...(await deployer.deleteGateway(req.params.id)) };
    }));

    // Two separate diagnostics: reachability (ping) and whether the stored admin password
    // actually logs in. ?what=ping|auth|all
    app.get('/api/vodi/gateways/:id/test', handle(async (req) => {
        gwOr404(req.params.id);
        const what = (req.query && req.query.what) || 'all';
        return { ok: true, result: await deployer.testGateway(req.params.id, what) };
    }));

    // Admin (default) config — the panel creates this link at startup.
    app.get('/api/vodi/gateways/:id/admin-config', handle(async (req) => {
        gwOr404(req.params.id);
        return { ok: true, config: await deployer.getAdminConfig(req.params.id) };
    }));

    // ── user management (proxied to the panel) ────────────────────────────────────
    app.get('/api/vodi/gateways/:id/users', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        const data = await deployer.vodiApi(gw, 'GET', '/api/links');
        return { ok: true, users: (data && data.links) || [] };
    }));

    app.post('/api/vodi/gateways/:id/users', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        const data = await deployer.vodiApi(gw, 'POST', '/api/links', req.body || {});
        return { ok: true, user: data };
    }));

    app.patch('/api/vodi/gateways/:id/users/:uid', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        const data = await deployer.vodiApi(gw, 'PATCH', `/api/links/${req.params.uid}`, req.body || {});
        return { ok: true, result: data };
    }));

    app.delete('/api/vodi/gateways/:id/users/:uid', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        const data = await deployer.vodiApi(gw, 'DELETE', `/api/links/${req.params.uid}`);
        return { ok: true, result: data };
    }));

    // Live stats/connections passthrough (optional, used by the panel header).
    app.get('/api/vodi/gateways/:id/stats', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        const data = await deployer.vodiApi(gw, 'GET', '/stats');
        return { ok: true, stats: data };
    }));

    // The panel's own protocol table, so the create-user form offers exactly what this
    // server build supports instead of a list hard-coded in the renderer.
    app.get('/api/vodi/gateways/:id/protocols', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        return { ok: true, protocols: await deployer.vodiApi(gw, 'GET', '/api/protocols') };
    }));

    // ── what the panel knows about itself ────────────────────────────────────────
    // Live CPU/RAM/uptime of the Railway container. Worth surfacing because this is the
    // user's OWN server: "is it slow, or is my line slow" is otherwise unanswerable from
    // here, and the alternative is opening Railway's dashboard in a browser.
    app.get('/api/vodi/gateways/:id/telemetry', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        return { ok: true, telemetry: await deployer.vodiApi(gw, 'GET', '/api/telemetry') };
    }));

    // Zero one config's used traffic without touching its limits or its link.
    app.post('/api/vodi/gateways/:id/users/:uid/reset-usage', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        return { ok: true, result: await deployer.vodiApi(gw, 'POST', `/api/links/${req.params.uid}/reset-usage`) };
    }));

    // Mint a NEW uuid for a config, keeping its limits and label. This is the "someone
    // shared my link" button: the old uuid stops working the moment this returns.
    app.post('/api/vodi/gateways/:id/users/:uid/regenerate', handle(async (req) => {
        const gw = gwOr404(req.params.id);
        const data = await deployer.vodiApi(gw, 'POST', `/api/links/${req.params.uid}/regenerate`, req.body || {});
        return { ok: true, user: data };
    }));

    if (broadcastLog) emitLog('مسیرهای «کانفیگ آیپی ثابت» ثبت شد');
};
