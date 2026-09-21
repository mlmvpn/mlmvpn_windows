// --- Game panel API ---
// Mounted from server.js with one line:
//     require('./game/routes')(app, { broadcast, broadcastLog });
//
// Everything the «بازی» panel needs lives under /api/game/*. Long-running work (the
// assessment, the installed-game scan, the bufferbloat test) reports progress over the
// existing websocket as `game_event`, so the panel draws while it works instead of
// staring at a spinner — the same pattern free-configs uses.

'use strict';

const catalog = require('./catalog');
const customGames = require('./customgames');
const installed = require('./installed');
const detect = require('./detect');
const localaudit = require('./localaudit');
const watch = require('./watch');
const session = require('./session');
const profiles = require('./profiles');
const tweaks = require('./tweaks');
const shaper = require('./shaper');
const uplinks = require('./uplinks');
const boost = require('./boost');
const tournament = require('./tournament');
const engines = require('./engines');
const accelerate = require('./accelerate');
const focus = require('./focus');

function handle(fn) {
    return async (req, res) => {
        try {
            const out = await fn(req, res);
            if (!res.headersSent) res.json(out ?? { ok: true });
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (!res.headersSent) res.status(500).json({ ok: false, error: message });
        }
    };
}

module.exports = function registerGameRoutes(app, { broadcast, broadcastLog, claimAdapter, adapterBusy, engineDrivers, readNodes } = {}) {
    const emit = (ev) => { try { if (broadcast) broadcast('game_event', ev); } catch {} };
    const log = (m) => { try { if (broadcastLog) broadcastLog(`[GAME] ${m}`); } catch {} };

    // The ISP name is part of every profile key, and it costs a network round trip, so it
    // is fetched once and reused. A failure is not an error: the profile just says "?".
    let ispCache = { at: 0, isp: null };
    async function isp() {
        if (ispCache.isp && Date.now() - ispCache.at < 10 * 60 * 1000) return ispCache.isp;
        try {
            const { checkIsp } = require('../scanner');
            const r = await checkIsp();
            ispCache = { at: Date.now(), isp: r && r.success ? r.isp : null };
        } catch { ispCache = { at: Date.now(), isp: null }; }
        return ispCache.isp;
    }

    const savedNodes = () => { try { return readNodes ? readNodes() : []; } catch { return []; } };

    // If the app died while acceleration had processes frozen, they are still frozen right
    // now — the user's machine is sluggish and nothing on screen explains why. Thaw first,
    // before anything else this module does.
    focus.recover(m => log(m)).catch(() => {});

    /**
     * Candidates from the free public pools.
     *
     * Fetched only when something actually asks for them: the pools are megabytes, they
     * live behind a mirror because raw.githubusercontent is filtered here, and the user
     * who never ticks the box should never pay for the download. free-configs keeps its
     * own five-minute cache, so repeated asks are free.
     *
     * `fast` rather than `all`: those entries already passed a real request in the pool's
     * own testing, which is the cheapest possible prior before we spend engine startups on
     * them. A failure is not an error — it just means no free candidates this run.
     */
    let freeCache = { at: 0, items: [] };
    async function freeNodes(limit = 12) {
        if (Date.now() - freeCache.at < 5 * 60 * 1000) return freeCache.items.slice(0, limit);
        try {
            const fc = require('../free-configs');
            const entries = await fc.loadPool('fast');
            freeCache = { at: Date.now(), items: entries.slice(0, 40) };
        } catch (err) {
            log(`مخزن کانفیگ رایگان در دسترس نبود: ${err.message}`);
            freeCache = { at: Date.now(), items: [] };
        }
        return freeCache.items.slice(0, limit);
    }

    // ── static ──────────────────────────────────────────────────────────────────
    app.get('/api/game/catalog', handle(async () => ({ ok: true, ...catalog.publicCatalog() })));

    // ── Games the user adds themselves ───────────────────────────────────────────────────────
    //
    // The catalogue ships 196 and will never ship the one a particular person plays. See
    // game/customgames.js for what an entry is and — more importantly — what it deliberately does
    // not claim about a game nobody has measured.

    /**
     * Use this resolver instead of the one the measurement chose.
     *
     * The ranking is honest and it cannot be complete: on this line eight providers open every
     * domain a Steam game needs, and which of them suits a particular person depends on their
     * operator and the hour. So the table is shown and the choice is theirs — and it reverts with
     * everything else when acceleration is switched off, because it was applied as part of it.
     */
    app.post('/api/game/dns/apply', handle(async (req) => {
        const { id } = req.body || {};
        const dnsManager = (() => { try { return require('../dns-manager'); } catch { return null; } })();
        if (!dnsManager) return { ok: false, error: 'ماژول DNS در دسترس نیست.' };
        const p = (dnsManager.PROVIDERS || []).find(x => x.id === id);
        if (!p) return { ok: false, error: 'این رزولور شناخته نشد.' };
        await dnsManager.applyProvider(p.id);
        log(`DNS دستی روی «${p.name || p.id}» رفت`);
        return { ok: true, id: p.id, fa: p.name || p.id, servers: p.servers };
    }));

    // ── the modem's own queue ────────────────────────────────────────────────────────────────
    //
    // Measured on a real Iranian line: with the uplink saturated, p95 went from 126ms to 2681ms
    // and 29% of packets were lost. That is the largest single effect anything in this feature has
    // produced, and no engine, region or resolver touches it — the queue is in the user's modem.
    //
    // The test is its own route rather than part of the one button because it uploads megabytes,
    // and on a metered mobile connection that is the user's money.

    // ── watching the line while the game is up ───────────────────────────────────────────────
    //
    // Everything else in this module acts BEFORE a match. This is the only thing that can answer
    // «وسط بازی لگ خوردم», because it is the only thing that was there.

    app.get('/api/game/watch', handle(async () => ({
        ok: true, status: watch.status(), report: watch.status().samples >= 6 ? watch.report() : null,
    })));

    app.post('/api/game/watch', handle(async (req) => {
        const { gameId, stop } = req.body || {};
        if (stop) {
            const was = watch.stop();
            const r = watch.report();
            log('پایش حین بازی متوقف شد');
            return { ok: true, was, report: r };
        }
        const game = gameId ? catalog.byId(gameId) : null;
        await watch.start({ game, emit: (ev) => emit({ ...ev, kind: 'watch' }) });
        log(`پایش حین بازی شروع شد${game ? ` — ${game.fa}` : ''}`);
        return { ok: true, status: watch.status() };
    }));

    app.get('/api/game/egress', handle(async () => ({
        ok: true,
        cap: shaper.egressCap(),
        last: localaudit.lastUpbloat(),
    })));

    app.post('/api/game/upbloat', handle(async () => {
        const r = await localaudit.measureUploadBloat({
            onProgress: (p) => emit({ kind: 'upbloat', ...p }),
        });
        emit({ kind: 'upbloat', phase: 'done', result: r });
        log(`صف مودم سنجیده شد: ${r.detail || r.verdict}`);
        return { ok: true, result: r, cap: shaper.egressCap() };
    }));

    /** Put a cap on, or take it off. `kbps` omitted with `off` set removes it. */
    app.post('/api/game/egress', handle(async (req) => {
        const { kbps, off } = req.body || {};
        if (off) {
            const r = await shaper.uncapEgress();
            log('سقف آپلود برداشته شد');
            return { ok: !!r.ok, error: r.error, cap: shaper.egressCap() };
        }
        const rate = Math.round(Number(kbps) || 0);
        if (!(rate > 0)) return { ok: false, error: 'سقف مشخص نیست.' };
        const r = await shaper.capEgress({ kbps: rate });
        log(`سقف آپلود روی ${rate} کیلوبیت بر ثانیه بسته شد`);
        return { ok: true, note: r.note, cap: shaper.egressCap() };
    }));

    app.get('/api/game/custom', handle(async () => ({ ok: true, games: customGames.list() })));

    app.post('/api/game/custom', handle(async (req) => {
        const { fa, en, procs, cat, path: exePath } = req.body || {};
        // `add` throws a sentence the user can act on — an empty name, a system process, a
        // duplicate. Letting it reach the panel unchanged is the point.
        const game = customGames.add({ fa, en, procs, cat, path: exePath });
        log(`بازی «${game.fa}» به فهرست اضافه شد (${game.procs.join('، ')})`);
        return { ok: true, game };
    }));

    app.post('/api/game/custom/remove', handle(async (req) => {
        const { id } = req.body || {};
        const gone = customGames.remove(String(id || ''));
        return { ok: gone, error: gone ? undefined : 'این بازی در فهرست شما نبود.' };
    }));

    /**
     * Programs running right now that could be the game, with the obvious ones taken out.
     *
     * Filtered two ways, and both matter. The store's own refusals keep Windows and this app's
     * engines off the list. Removing what the catalogue ALREADY recognises is what keeps the list
     * short enough to read — a user opening this is looking for the one thing that is missing, not
     * for the ninety processes Windows happens to be running.
     */
    app.get('/api/game/custom/candidates', handle(async () => {
        const procs = await detect.processes();
        const seen = new Set();
        const items = [];
        for (const p of procs) {
            const name = String(p.name || '');
            const key = name.toLowerCase();
            if (!name || seen.has(key)) continue;
            seen.add(key);
            if (customGames.isRefused(name)) continue;
            if (catalog.byProcess(name)) continue;   // already known, by us or by the user
            items.push({ name, pid: p.pid });
        }
        items.sort((a, b) => a.name.localeCompare(b.name));
        return { ok: true, items };
    }));

    /** The app's own file dialog, the same one «مسیر برنامه‌ها» uses. */
    app.post('/api/game/custom/browse', handle(async () => {
        const app_ = require('../app-catalog');
        const picked = await app_.browse();
        return { ok: true, app: picked || null };
    }));

    /**
     * Everything that could carry a game, in one list, whether or not it is running.
     *
     * The panel needs this before the user picks anything, and it must not require an
     * engine to be on — the whole point of this round is that the game tab starts them.
     */
    app.get('/api/game/engines', handle(async (req) => {
        const nodes = savedNodes();
        const free = req.query.free === '1' ? await freeNodes(12) : [];
        return {
            ok: true,
            engines: await boost.availableEngines({ probeUdp: req.query.udp === '1', nodes, freeNodes: free }),
            protocols: engines.AETHER_PROTOCOLS,
            scans: engines.SCANS,
            nodeCount: nodes.length,
            freeCount: free.length,
        };
    }));

    // ── what the user owns and what is running ──────────────────────────────────
    app.get('/api/game/installed', handle(async (req) => {
        const force = req.query.force === '1';
        if (!force) {
            const c = installed.cached();
            if (c) return { ok: true, ...c, cached: true };
        }
        log('اسکن بازی‌های نصب‌شده شروع شد');
        const r = await installed.scan({
            force,
            onProgress: p => emit({ kind: 'installed', ...p }),
        });
        log(`اسکن تمام شد — ${r.items.length} بازی از ${r.sources} ورودی لانچر`);
        emit({ kind: 'installed', phase: 'done', count: r.items.length });
        return { ok: true, ...r };
    }));

    app.get('/api/game/running', handle(async () => {
        const games = await detect.runningGames();
        return { ok: true, games };
    }));

    app.get('/api/game/endpoints/:gameId', handle(async (req) => {
        const running = await detect.runningGames();
        const g = running.find(r => r.id === req.params.gameId);
        if (!g) return { ok: true, running: false, endpoints: null };
        const endpoints = await detect.endpointsFor(g.pids);
        return { ok: true, running: true, pids: g.pids, endpoints };
    }));

    // ── the local line ──────────────────────────────────────────────────────────
    app.post('/api/game/audit', handle(async () => {
        log('ممیزی خط محلی شروع شد');
        const audit = await localaudit.quickAudit();
        emit({ kind: 'audit', audit });
        log(`ممیزی تمام شد — وضعیت کلی: ${audit.overall}`);
        return { ok: true, audit };
    }));

    // Standalone because it is the check people re-run after changing a router setting,
    // and making them sit through the whole audit for it would be hostile.
    app.post('/api/game/nat', handle(async () => {
        log('تشخیص نوع NAT');
        const r = await localaudit.natCheck();
        emit({ kind: 'nat', check: r });
        log(`NAT: ${r.fa} — ${r.detail}`);
        return { ok: true, check: r };
    }));

    // Separate endpoint on purpose: this one deliberately saturates the downlink, so it
    // must never run as a side effect of opening a panel.
    app.post('/api/game/bufferbloat', handle(async () => {
        log('تست باف‌ربلوت — این تست عمداً خط را اشباع می‌کند');
        const r = await localaudit.bufferbloat({
            onProgress: p => emit({ kind: 'bufferbloat', ...p }),
        });
        emit({ kind: 'bufferbloat', phase: 'done', result: r });
        log(`باف‌ربلوت: ${r.detail}`);
        return { ok: true, result: r };
    }));

    // ── reversible local fixes ──────────────────────────────────────────────────
    // Read is free and safe. Write is always an explicit, single, named action — there is
    // deliberately no "apply everything" endpoint, because that is how an app ends up
    // changing settings the user never agreed to.
    app.get('/api/game/tweaks', handle(async () => ({ ok: true, tweaks: await tweaks.list() })));

    app.post('/api/game/tweaks/apply', handle(async (req) => {
        const id = req.body && req.body.id;
        if (!id) return { ok: false, error: 'کدام تنظیم؟' };
        const r = await tweaks.apply(id);
        log(`تنظیم «${id}» اعمال شد${r.needsReboot ? ' (نیازمند ری‌استارت)' : ''}`);
        emit({ kind: 'tweaks', list: await tweaks.list() });
        return { ok: true, result: r };
    }));

    app.post('/api/game/tweaks/restore', handle(async (req) => {
        const id = req.body && req.body.id;
        if (!id) return { ok: false, error: 'کدام تنظیم؟' };
        const r = await tweaks.restore(id);
        log(`تنظیم «${id}» به مقدار اولیه برگشت`);
        emit({ kind: 'tweaks', list: await tweaks.list() });
        return { ok: true, result: r };
    }));

    app.post('/api/game/tweaks/restore-all', handle(async () => {
        const r = await tweaks.restoreAll();
        log(`همه‌ی تنظیمات به حالت اولیه برگشتند (${r.length} مورد)`);
        emit({ kind: 'tweaks', list: await tweaks.list() });
        return { ok: true, results: r };
    }));

    // ── the one button ──────────────────────────────────────────────────────────
    //
    // Everything the panel can do, in one action, reporting a line per step. This exists
    // because a panel with twelve cards made a player press the one that sounded like
    // acceleration, receive «مستقیم بمان», and reasonably conclude the feature was useless —
    // while five other levers sat unused. See game/accelerate.js.
    let lastAccel = null;

    app.get('/api/game/accelerate', handle(async () => ({
        ok: true,
        running: accelerate.isRunning(),
        steps: accelerate.STEPS,
        last: lastAccel,
        boost: boost.status(),
        // Read from the machine, not from this process's memory: after an app restart the
        // panel must still know that acceleration is applied, or the user is left with every
        // change in place and no button to undo it.
        active: accelerate.status(),
    })));

    app.post('/api/game/accelerate', handle(async (req) => {
        if (accelerate.isRunning()) return { ok: false, error: 'شتاب‌دهی از قبل در حال اجراست.' };
        // `full` is the one that suspends the user's open applications. It defaults to OFF in
        // accelerate.run and it is only ever true because this line carried an explicit request
        // from the panel — where it is a labelled switch that says what it does.
        const { gameId, aggressive, full } = req.body || {};
        if (!gameId) return { ok: false, error: 'بازی انتخاب نشده است.' };

        (async () => {
            try {
                const summary = await accelerate.run({
                    gameId,
                    aggressive: !!aggressive,
                    full: !!full,
                    engineDrivers,
                    readNodes: () => (readNodes ? readNodes() : []),
                    readFreeNodes: () => freeNodes(20),
                    dnsManager: (() => { try { return require('../dns-manager'); } catch { return null; } })(),
                    lastRegions,
                    onEvent: ev => emit({ kind: 'accel', ...ev }),
                    log,
                });
                lastAccel = summary;
            } catch (err) {
                emit({ kind: 'accel', type: 'error', error: err.message });
                log(`شتاب‌دهی ناموفق: ${err.message}`);
            }
        })();

        return { ok: true, started: true };
    }));

    app.post('/api/game/accelerate/stop', handle(async () => {
        accelerate.abort();
        log('شتاب‌دهی لغو شد');
        return { ok: true };
    }));

    // Undo everything the pipeline changed — one button in, one button out.
    app.post('/api/game/accelerate/revert', handle(async () => {
        const r = await accelerate.revert({
            dnsManager: (() => { try { return require('../dns-manager'); } catch { return null; } })(),
            onLog: log,
        });
        lastAccel = null;
        log(`همه‌چیز برگردانده شد: ${r.reverted.join('، ') || 'چیزی برای برگرداندن نبود'}`);
        emit({ kind: 'accel', type: 'reverted', reverted: r.reverted });
        return r;
    }));

    // ── more than one internet connection ───────────────────────────────────────
    //
    // Comparing is safe and touches nothing on the active uplink; switching is a real
    // change and is its own explicit call. See game/uplinks.js.
    let lastUplinks = null;
    let uplinksRunning = false;

    app.get('/api/game/uplinks', handle(async () => ({
        ok: true,
        uplinks: await uplinks.list(),
        running: uplinksRunning,
        last: lastUplinks,
        canRestore: uplinks.hasBackup(),
        watch: uplinks.watchStatus(),
        boostOn: !!boost.status().on,
    })));

    app.post('/api/game/uplinks/compare', handle(async (req) => {
        if (uplinksRunning) return { ok: false, error: 'مقایسه‌ی اینترنت‌ها در حال اجراست.' };
        uplinksRunning = true;
        log('مقایسه‌ی اینترنت‌ها شروع شد');

        (async () => {
            try {
                const r = await uplinks.compare({
                    seconds: Number((req.body || {}).seconds) || 6,
                    onEvent: ev => emit({ kind: 'uplinks', ...ev }),
                });
                lastUplinks = r;
                log(`مقایسه‌ی اینترنت‌ها تمام شد — ${r.verdict.title}`);
            } catch (err) {
                emit({ kind: 'uplinks', type: 'error', error: err.message });
                log(`مقایسه‌ی اینترنت‌ها ناموفق: ${err.message}`);
            } finally { uplinksRunning = false; }
        })();

        return { ok: true, started: true };
    }));

    app.post('/api/game/uplinks/prefer', handle(async (req) => {
        const r = await uplinks.prefer((req.body || {}).id);
        log(`اینترنت پیش‌فرض → ${r.alias}`);
        emit({ kind: 'uplinks', type: 'changed' });
        return r;
    }));

    app.post('/api/game/uplinks/restore', handle(async () => {
        const r = await uplinks.restore();
        log('اولویت اینترنت‌ها به حالت اول برگشت');
        emit({ kind: 'uplinks', type: 'changed' });
        return r;
    }));

    // The only thing in this feature that acts on its own — so it is opt-in, and it is
    // gated on acceleration actually being on. See the fences in game/uplinks.js.
    app.post('/api/game/uplinks/failover', handle(async (req) => {
        const on = !!(req.body || {}).on;
        if (!on) return { ok: true, watch: uplinks.stopWatch() };
        const watch = uplinks.startWatch({
            shouldRun: () => !!boost.status().on,
            onEvent: ev => emit({ kind: 'uplinks', type: 'failover', event: ev }),
            log,
        });
        return { ok: true, watch };
    }));

    // ── traffic shaping ─────────────────────────────────────────────────────────
    //
    // The remedy for the effect `lineLoad()` has been reporting all along: the user's own
    // machine competing with their game. See game/shaper.js for what Windows can and, more
    // importantly, cannot do here without a kernel driver.
    app.get('/api/game/shaper', handle(async () => ({
        ok: true,
        candidates: await shaper.candidates(),
        rules: shaper.list(),
        // Sampled alongside the list so the panel can put "who is talking" next to "how
        // busy the line actually is" — either number alone invites the wrong conclusion.
        load: await localaudit.lineLoad({ seconds: 3 }).catch(() => null),
    })));

    app.post('/api/game/shaper/apply', handle(async (req) => {
        const { exe, path: exePath, mode, kbps } = req.body || {};
        const r = await shaper.apply({ exe, path: exePath, mode, kbps });
        log(`شکل‌دهی ترافیک: ${exe} → ${mode === 'block' ? 'قطع' : 'محدود'}`);
        emit({ kind: 'shaper', rules: shaper.list() });
        return r;
    }));

    app.post('/api/game/shaper/restore', handle(async (req) => {
        const r = await shaper.restore((req.body || {}).exe);
        log(`شکل‌دهی برگردانده شد: ${r.exe}`);
        emit({ kind: 'shaper', rules: shaper.list() });
        return r;
    }));

    app.post('/api/game/shaper/restore-all', handle(async () => {
        const r = await shaper.restoreAll();
        log('همه‌ی قواعد شکل‌دهی ترافیک برگردانده شدند');
        emit({ kind: 'shaper', rules: shaper.list() });
        return r;
    }));

    // ── the assessment ──────────────────────────────────────────────────────────
    app.post('/api/game/assess', handle(async (req) => {
        if (session.isRunning()) return { ok: false, error: 'یک سنجش دیگر در حال اجراست.' };
        const { gameId, serverAddr, quick, includeAudit, includeEngines } = req.body || {};
        if (!gameId) return { ok: false, error: 'بازی انتخاب نشده است.' };

        log(`سنجش «${gameId}» شروع شد${serverAddr ? ` — سرور ${serverAddr}` : ''}`);

        // Fire and forget: the HTTP call returns immediately and the panel follows the
        // websocket. A 40-second request would be killed by every proxy in between.
        (async () => {
            try {
                const report = await session.assess({
                    gameId, serverAddr: serverAddr || null,
                    quick: !!quick,
                    includeAudit: includeAudit !== false,
                    includeEngines: includeEngines !== false,
                    // So the engine comparison inside an assessment does not depend on the
                    // user having gone to another panel first. It starts Aether if nothing
                    // is up and puts it back afterwards.
                    drivers: engineDrivers,
                    autoEngines: !(adapterBusy && adapterBusy()),
                    onEvent: ev => emit({ kind: 'assess', ...ev }),
                });
                try {
                    const saved = profiles.record(report, { isp: await isp() });
                    emit({ kind: 'assess', type: 'saved', saved });
                } catch (e) { /* a profile write must never fail the run */ }
                log(`سنجش تمام شد — حکم: ${report.verdict.code}`);
            } catch (err) {
                emit({ kind: 'assess', type: 'error', error: err.message });
                log(`سنجش ناموفق: ${err.message}`);
            }
        })();

        return { ok: true, started: true };
    }));

    app.post('/api/game/assess/stop', handle(async () => {
        session.abort();
        log('سنجش لغو شد');
        return { ok: true };
    }));

    app.get('/api/game/assess/status', handle(async () => ({ ok: true, running: session.isRunning() })));

    // ── region comparison ───────────────────────────────────────────────────────
    // Kept out of the assessment run: it measures ten regions rather than one game's two,
    // takes about a minute, and its answer stays useful for hours — so it is its own
    // action with its own cached result, not something re-run on every assessment.
    let lastRegions = null;
    let regionsRunning = false;

    app.get('/api/game/regions', handle(async (req) => {
        const gameId = req.query.game;
        const game = gameId ? catalog.byId(gameId) : null;
        return {
            ok: true, running: regionsRunning, result: lastRegions,
            advice: (game && lastRegions) ? session.regionAdviceFor(game, lastRegions.ranked) : null,
        };
    }));

    app.post('/api/game/regions', handle(async (req) => {
        if (regionsRunning) return { ok: false, error: 'مقایسه‌ی مناطق در حال اجراست.' };
        if (session.isRunning()) return { ok: false, error: 'یک سنجش دیگر در حال اجراست.' };
        const quick = !!(req.body && req.body.quick);
        regionsRunning = true;
        log('مقایسه‌ی مناطق شروع شد');

        (async () => {
            try {
                const r = await session.compareRegions({
                    quick,
                    onEvent: ev => emit({ kind: 'regions', ...ev }),
                });
                lastRegions = r;
                const best = r.ranked[0];
                log(`مقایسه‌ی مناطق تمام شد — بهترین: ${best ? best.fa + ' (' + best.min + 'ms)' : 'هیچ‌کدام'}`);
                emit({ kind: 'regions', type: 'saved', at: r.at });
            } catch (err) {
                emit({ kind: 'regions', type: 'error', error: err.message });
                log(`مقایسه‌ی مناطق ناموفق: ${err.message}`);
            } finally { regionsRunning = false; }
        })();

        return { ok: true, started: true };
    }));

    // ── acceleration ────────────────────────────────────────────────────────────
    //
    // The button. Routes one game through one engine and leaves the rest of the machine
    // on the physical interface — see game/boost.js for why it is gated on measurement
    // rather than offered as an unconditional "make it faster".
    app.get("/api/game/boost", handle(async (req) => {
        const gameId = req.query.game;
        const engineId = req.query.engine || "aether";
        const nodes = savedNodes();
        const free = req.query.free === "1" ? await freeNodes(12) : [];
        return {
            ok: true,
            status: boost.status(),
            engines: await boost.availableEngines({ probeUdp: req.query.udp === "1", nodes, freeNodes: free }),
            evaluation: gameId ? boost.evaluate(gameId, engineId, profiles) : null,
            adapterBusy: adapterBusy ? !!adapterBusy() : false,
        };
    }));

    app.post("/api/game/boost/start", handle(async (req) => {
        const { gameId, engineId, force } = req.body || {};
        if (!gameId) return { ok: false, error: "بازی انتخاب نشده است." };

        // Take the adapter from whoever holds it first. Clearing the other features’
        // INTENT matters as much as stopping the process — Aether’s watchdog would
        // otherwise rebuild its tunnel underneath this one within seconds.
        if (claimAdapter) await claimAdapter("کاربر شتاب بازی را روشن کرد");

        try {
            const st = await boost.start({
                gameId, engineId: engineId || "aether", force: !!force,
                profiles, onLog: log,
                // The button starts the engine itself — the user never leaves this tab.
                drivers: engineDrivers,
                nodes: savedNodes(),
                freeNodes: String(engineId || "").startsWith("v2ray:free") ? await freeNodes(40) : [],
            });
            emit({ kind: "boost", type: "on", status: st });
            return { ok: true, status: st };
        } catch (err) {
            // A refusal because measurement says this would hurt is not a failure — it is
            // the feature working. It comes back as a distinct shape so the panel can ask
            // the user instead of showing a red error.
            if (err.needsForce) {
                return { ok: false, needsForce: true, error: err.message, evaluation: err.evaluation };
            }
            emit({ kind: "boost", type: "error", error: err.message });
            throw err;
        }
    }));

    // Read-only, cheap, and safe to poll: it parses the tail of sing-box's own log. This
    // is what turns "trust us" into "here are the connections it carried".
    app.get("/api/game/boost/proof", handle(async () => ({ ok: true, proof: await boost.proof() })));

    app.post("/api/game/boost/stop", handle(async () => {
        // `engineDrivers` so it can also switch off an engine that only came up because of
        // the boost. One that the user had running before stays running.
        const st = await boost.stop(log, engineDrivers);
        emit({ kind: "boost", type: "off", status: st });
        return { ok: true, status: st };
    }));

    // Survives across requests so the panel can show the last ranking after a reload.
    let lastTournament = null;

    // ── the engine tournament ─────────────────────────────────────────
    //
    // Starts each engine, measures it, stops it, ranks them. Disruptive by nature — it is
    // the user’s own engines being cycled — so it is never automatic and always stoppable.
    app.get("/api/game/tournament", handle(async () => ({
        ok: true,
        running: tournament.isRunning(),
        last: lastTournament,
        nodeCount: savedNodes().length,
        protocols: engines.AETHER_PROTOCOLS,
        scans: engines.SCANS,
        adapterBusy: adapterBusy ? !!adapterBusy() : false,
    })));

    app.post("/api/game/tournament", handle(async (req) => {
        if (tournament.isRunning()) return { ok: false, error: "مسابقه از قبل در حال اجراست." };
        if (session.isRunning()) return { ok: false, error: "یک سنجش دیگر در حال اجراست." };
        if (adapterBusy && adapterBusy()) {
            return { ok: false, error: "اول تونل را خاموش کن — مسابقه نباید مسیر سیستم را عوض کند." };
        }
        if (!engineDrivers) return { ok: false, error: "کنترل موتورها در دسترس نیست." };

        const { gameId, include, maxNodes, maxFree } = req.body || {};
        if (!gameId) return { ok: false, error: "بازی انتخاب نشده است." };

        const inc = include || {};
        const nodes = savedNodes();
        // Downloaded here rather than inside the tournament so a dead mirror fails BEFORE
        // any engine is cycled — a field that turns out to be empty after the user's
        // connection has already been taken up and down twice is the worst of both.
        const free = inc.v2rayFree === true ? await freeNodes(Number(maxFree) || 8) : [];
        const opts = { nodes, freeNodes: free, include: inc, maxNodes: Number(maxNodes) || 12, maxFree: Number(maxFree) || 8 };
        const planned = tournament.buildCandidates(opts);
        if (!planned.length) return { ok: false, error: "هیچ موتوری برای آزمایش انتخاب نشده است." };

        log(`مسابقه‌ی موتورها شروع شد — ${planned.length} کاندیدا (${nodes.length} نود ذخیره‌شده، ${free.length} نود رایگان)`);

        (async () => {
            try {
                const report = await tournament.run({
                    ...opts, gameId,
                    drivers: engineDrivers,
                    // `kind` LAST, so no field inside the event can overwrite the envelope
                    // the renderer routes on.
                    onEvent: ev => emit({ ...ev, kind: "tournament" }),
                    log,
                });
                lastTournament = report;
                // Into the profile store, so the boost button can answer with what this
                // race just proved instead of «هنوز اندازه‌گیری نشده». A profile write must
                // never fail the run that produced it.
                try {
                    const saved = profiles.recordTournament(report, { isp: await isp() });
                    emit({ ...(saved || {}), type: "saved", kind: "tournament" });
                } catch (e) { /* deliberately swallowed */ }
                log(`مسابقه تمام شد — ${report.verdict.title}`);
            } catch (err) {
                emit({ kind: "tournament", type: "error", error: err.message });
                log(`مسابقه ناموفق: ${err.message}`);
            }
        })();

        return {
            ok: true, started: true,
            candidates: planned.length + 1,
            plan: planned.map(c => ({ id: c.id, fa: c.fa, kind: c.kind, exclusive: !!c.exclusive })),
        };
    }));

    app.post("/api/game/tournament/stop", handle(async () => {
        tournament.abort();
        log("مسابقه لغو شد");
        return { ok: true };
    }));

    // ── profiles ───────────────────────────────────────────────────────
    app.get('/api/game/profiles', handle(async (req) => {
        const gameId = req.query.game;
        return {
            ok: true,
            isp: ispCache.isp,
            bucket: profiles.hourBucket(),
            bucketFa: profiles.BUCKET_FA[profiles.hourBucket()],
            items: gameId ? profiles.forGame(gameId) : profiles.all(),
        };
    }));

    app.post('/api/game/profiles/clear', handle(async () => { profiles.clear(); return { ok: true }; }));

    app.get('/api/game/profiles/export', handle(async () => ({ ok: true, items: profiles.exportable() })));
};
