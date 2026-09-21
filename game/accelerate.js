// --- «شتاب‌دهی بازی» — one button ---
//
// WHY THIS FILE EXISTS, WRITTEN DOWN SO IT IS NOT UNDONE
// Every lever in this feature was built and then left on its own card: audit here, traffic
// shaping there, tweaks in a third place, a tournament in a fourth. A player pressed the one
// that sounded most like acceleration, got «مستقیم بمان», and concluded the whole thing was
// useless. They were right to. The measurement was honest and the product was not, because
// the panel had six things it could do for them and did one.
//
// ExitLag — the thing Iranian gamers actually pay for — has ONE button. Pick the game, press
// it, done. That is the part of the research worth copying, more than any of its technology.
//
// SO: ONE ENTRY POINT, AND IT PULLS EVERY LEVER THAT HELPS.
//
// The order is not arbitrary. It runs cheapest-and-surest first, so that by the time the
// expensive, uncertain step arrives (the tunnel), the sure wins are already banked:
//
//   1. FREE THE LINE.       Measured on this very machine: with a video streaming, p95 to
//                           Frankfurt was 457ms; idle, the same anchor was 124ms. That is a
//                           3.7x improvement and it has nothing to do with tunnels. It is the
//                           single largest lever this project has ever measured, so it goes
//                           first and it runs whether or not any tunnel is ever used.
//   2. GIVE THE GAME THE PC. Not a gesture and not a priority nudge: in full mode every
//                           background app is SUSPENDED outright — proved necessary when the
//                           user played music in Telegram, switched acceleration on, and it
//                           kept playing, because audio never reaches the limit Idle imposes.
//                           The game and its LAUNCHER are raised and never touched; this app
//                           is lowered but never frozen (it is the only way back). Power plan
//                           to maximum, Game Mode on. No admin rights needed. See focus.js.
//   3. FIX DNS.             Never wired into this panel before, and for a sanctioned or
//                           filtered game it is often the ONLY thing standing between the
//                           player and a login screen.
//   4. MEASURE DIRECT.      The control. If it is dead, that is not a failure to report — it
//                           is the finding that makes step 5 mandatory.
//   5. PICK A PATH.         Race the engines. Take one ONLY if it wins, or if direct is
//                           closed. This is where the honest "stay direct" still lives — but
//                           now it means "the tunnel was not needed", not "nothing was done".
//   6. NAME THE REGION.     The in-game server choice, which on an Iranian line routinely
//                           matters more than everything above combined.
//
// EVERY STEP IS REVERSIBLE AND EVERY STEP CAN SAY "I DID NOT DO THIS, AND HERE IS WHY".
// A step that is skipped is reported as skipped with its reason. A step that fails does not
// stop the ones after it: a machine that cannot set a registry key can still have its line
// freed and its route chosen.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const localaudit = require('./localaudit');
const shaper = require('./shaper');
const tweaks = require('./tweaks');
const catalog = require('./catalog');
const dnspick = require('./dnspick');
const detect = require('./detect');
const probe = require('./probe');
const boost = require('./boost');
const session = require('./session');
const tournament = require('./tournament');
const profiles = require('./profiles');
const focus = require('./focus');

const STEPS = [
    { id: 'detect', fa: 'شناسایی بازی و وضعیت خط' },
    { id: 'line', fa: 'معطوف‌سازی اینترنت فقط به بازی' },
    { id: 'pc', fa: 'معطوف‌سازی کامپیوتر به بازی' },
    { id: 'dns', fa: 'اصلاح DNS بازی' },
    { id: 'direct', fa: 'سنجش مسیر مستقیم' },
    { id: 'path', fa: 'انتخاب سریع‌ترین مسیر' },
    { id: 'region', fa: 'بهترین منطقه‌ی سرور بازی' },
];

let running = null;

function isRunning() { return !!running; }
function abort() { if (running) running.aborted = true; }

// A marker for "acceleration is currently ON".
//
// WHY A FILE AND NOT A VARIABLE
// The user pressed the button, everything applied, and the button still said «شتاب‌دهی
// بازی» — so they pressed it again and the whole pipeline re-ran from the top. Their words:
// «اگر واقعا شتابدهی انجام شده نمایش این دکمه باعث سردرگمی میشه». The fix is a real ACTIVE
// state, and it has to survive the app being closed and reopened — otherwise a restart
// would show "not accelerated" while the machine still had every change applied, and the
// user would have no way back except finding each card by hand.
const STATE_FILE = path.join(os.homedir(), '.mlmvpn', 'game-accel-state.json');

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function writeState(s) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
    } catch { /* the panel falls back to reading the machine */ }
}
function clearState() { try { fs.unlinkSync(STATE_FILE); } catch {} }

/**
 * Is acceleration on right now, and what exactly is applied?
 *
 * Read from the MACHINE wherever possible — the focus backup, the shaper's own rule list,
 * the boost state — rather than trusting the marker alone. A marker can outlive a manual
 * revert done from one of the advanced cards, and a panel that insists acceleration is on
 * when it is not is the same lie in the other direction.
 */
function status() {
    const marker = readState();
    const parts = [];
    let on = false;

    try {
        const f = focus.status();
        if (f.on) { on = true; parts.push(`اولویت ${f.count} پراسس و پلن برق`); }
    } catch {}
    try {
        const rules = shaper.list();
        if (rules.length) { on = true; parts.push(`${rules.length} برنامه محدود/قطع`); }
    } catch {}
    try {
        const b = boost.status();
        if (b.on) { on = true; parts.push(`مسیر بازی از «${b.engineFa || 'موتور'}»`); }
    } catch {}
    if (marker && marker.dns) { on = true; parts.push(`DNS روی ${marker.dns.fa}`); }
    if (marker && marker.tweaks) parts.push(`${marker.tweaks} تنظیم ویندوز`);

    return {
        on,
        since: marker ? marker.at : null,
        gameId: marker ? marker.gameId : null,
        gameFa: marker ? marker.gameFa : null,
        parts,
    };
}

/**
 * Run the whole pipeline.
 *
 * `onEvent` receives one event per state change, and the panel renders exactly that: a line
 * per step that goes pending → running → done/skipped/failed, each ending with one sentence
 * of what actually happened. Nothing here is decorative — every tick corresponds to a change
 * that was made or a measurement that was taken.
 */
async function run({
    gameId, engineDrivers, readNodes = () => [], readFreeNodes = async () => [],
    // SUSPENSION IS OFF BY DEFAULT, and that is a correction rather than a preference.
    //
    // The freeze rule is careful about what it will not touch — nothing in C:\Windows, nothing
    // in the input stack, no UWP host, no system broker — and all of that is still true. What it
    // does touch, by construction, is every application the user opened: a visible titled window
    // outside C:\Windows is a browser, a messenger, a music player. Freezing those is a
    // legitimate thing to want and a terrible thing to do without being asked.
    //
    // It reached users as a silent default with no way to turn it off and nothing to undo it when
    // the match ended, and it came back as «سیستمشون هنگ میکنه» — from people with fast machines,
    // because none of this has anything to do with how fast the machine is. Alt-tab out of the
    // game and every window is dead until you find this panel again.
    //
    // Priority-only is what remains on by default. It is not a placebo — it is the same lever
    // Windows' own Game Mode pulls — and it cannot make a machine look hung.
    dnsManager = null, aggressive = false, full = false,
    // The last region comparison, which routes.js owns — this module must not re-run a
    // ten-region sweep inside a pipeline the user expects to take a minute.
    lastRegions = null,
    onEvent = () => {}, log = () => {},
} = {}) {
    if (running) throw new Error('شتاب‌دهی از قبل در حال اجراست.');
    running = { aborted: false, startedAt: Date.now() };
    const state = { aborted: false };

    const emit = (e) => { try { onEvent(e); } catch {} };
    // Every outcome is remembered, not just the wins. The first version of the summary
    // counted successes only, so a run where the line step FAILED for want of admin rights
    // and everything else was already fine reported «هیچ کاری لازم نبود» — which is the
    // exact species of dishonesty this whole rewrite exists to remove.
    const outcomes = {};
    const step = (id, status, detail, extra) => {
        outcomes[id] = { status, detail: detail || null };
        emit({ type: 'step', id, status, detail: detail || null, ...(extra || {}) });
    };

    const game = catalog.byId(gameId) || { id: gameId, fa: gameId, regions: ['eu-central'], procs: [] };
    const done = {};        // what each step achieved, for the final summary
    const undo = [];        // human-readable list of what would need undoing

    emit({ type: 'start', gameId: game.id, gameFa: game.fa, steps: STEPS });
    log(`شتاب‌دهی «${game.fa}» شروع شد`);

    try {
        // ── 1. detect ────────────────────────────────────────────────────────────
        step('detect', 'running');
        let liveEndpoints = null;
        let runningGame = null;
        try {
            const runningGames = await detect.runningGames();
            runningGame = runningGames.find(r => r.id === game.id) || null;
            if (runningGame) liveEndpoints = await detect.endpointsFor(runningGame.pids).catch(() => null);
            const load = await localaudit.lineLoad({ seconds: 3 }).catch(() => null);
            done.load = load;
            done.running = !!runningGame;
            step('detect', 'done',
                `${runningGame ? 'بازی در حال اجراست' : 'بازی اجرا نیست (اشکالی ندارد)'} · بار خط: ${load ? load.detail : 'نامعلوم'}`);
        } catch (err) {
            step('detect', 'failed', err.message);
        }
        if (running.aborted) throw new Error('لغو شد');

        // ── 2. free the line ─────────────────────────────────────────────────────
        //
        // The largest measured lever, and the one nobody thinks of as "acceleration".
        // Conservative by default: the obvious bandwidth hogs are throttled, not blocked,
        // and only the ones this app can name. `aggressive` blocks them instead, which is
        // what a player who is about to start a ranked match actually wants.
        step('line', 'running');
        try {
            const cands = await shaper.candidates();
            const gameProcs = new Set((game.procs || []).map(p => p.toLowerCase()));
            const targets = cands.filter(c =>
                !c.protected && !c.shaped && c.fa && !gameProcs.has(String(c.name).toLowerCase()));

            const bits = [];
            if (!targets.length) {
                bits.push('هیچ برنامه‌ی پرمصرفی روی خط نبود');
            } else {
                const applied = [];
                for (const t of targets.slice(0, 6)) {
                    try {
                        await shaper.apply({
                            exe: t.name, path: t.path,
                            mode: aggressive && t.path ? 'block' : 'limit',
                            kbps: 256,
                        });
                        applied.push(t.name);
                    } catch { /* one refusal must not stop the rest */ }
                }
                done.shaped = applied;
                if (applied.length) {
                    undo.push(`${applied.length} برنامه محدود شد`);
                    bits.push(`${applied.length} برنامه‌ی پرمصرف کنار زده شد: ${applied.join('، ')}`);
                } else {
                    bits.push('⚠ محدود کردن ممکن نشد — برنامه را با دسترسی مدیر اجرا کن');
                }
            }

            // THE MODEM'S OWN QUEUE, which is a different problem from a heavy application.
            //
            // Measured on this line: with the uplink saturated, p95 went from 126ms to 2681ms and
            // 29% of packets were lost. No engine, region or resolver touches that — it is the
            // user's own upstream queue filling, and the only cure is not filling it.
            //
            // The MEASUREMENT is deliberately not run here. It costs megabytes of somebody's
            // mobile data, and this project's rule is that a bufferbloat test is bounded and
            // explicitly asked for. The CURE costs nothing — so a line that has already been
            // measured gets it on every run, and a line that has not is told so rather than
            // silently getting nothing.
            try {
                const known = localaudit.lastUpbloat();
                const capNow = shaper.egressCap();
                if (capNow.on) {
                    bits.push(`سقف آپلود از قبل روی ${capNow.kbps} کیلوبیت بر ثانیه بود`);
                } else if (known && (known.verdict === 'bad' || known.verdict === 'warn') && known.suggestKbps > 0) {
                    await shaper.capEgress({ kbps: known.suggestKbps });
                    undo.push('سقف آپلود کل خط');
                    done.egressCap = known.suggestKbps;
                    bits.push(`صف مودم این خط قبلاً سنجیده شده بود، پس سقف آپلود روی ${known.suggestKbps} کیلوبیت بر ثانیه بسته شد`);
                } else if (!known) {
                    bits.push('صف مودم هنوز سنجیده نشده — از کارت «صف مودم» یک بار بگیرید');
                }
            } catch (err) {
                bits.push('⚠ سقف آپلود اعمال نشد: ' + err.message);
            }

            const anyWin = (done.shaped && done.shaped.length) || done.egressCap;
            const anyFail = bits.some(b => b.startsWith('⚠'));
            step('line', anyFail && !anyWin ? 'failed' : anyWin ? 'done' : 'skipped', bits.join(' · '));
        } catch (err) {
            step('line', 'failed', err.message);
        }
        if (running.aborted) throw new Error('لغو شد');

        // ── 3. give the PC to the game ───────────────────────────────────────────
        step('pc', 'running');
        try {
            const list = await tweaks.list();
            const applicable = list.filter(t => t.available && !t.applied);
            const okNames = [];
            for (const t of applicable) {
                try { await tweaks.apply(t.id); okNames.push(t.fa); } catch { /* keep going */ }
            }
            // …and then the machine itself. This is the step the user asked to be total:
            // «معطوف سازی باید کامل باشه یعنی ۱۰۰درصد منابع فیزیکی و اینترنتی برای بازی».
            // focus.js raises the game, drops everything else — INCLUDING THIS APP, which was
            // caught in the user's own Task Manager burning 9.5% CPU while claiming to hand
            // the machine over — sets the power plan to maximum and turns on Windows Game
            // Mode. None of it needs administrator rights, which makes it the part of the
            // pipeline that always works.
            let focused = null;
            try {
                focused = await focus.apply({
                    gameProcs: (game.procs || []).filter(p => !p.endsWith('*')),
                    aggressive, full,
                    // `focus.apply` has taken this parameter since it was written and no caller
                    // ever passed anything. The static list inside it is now shared and current
                    // (see engine-processes.js); this is the belt to that pair of braces — an
                    // engine started under a name we did not predict is still spared, because
                    // this is asked of the machine at the moment of freezing rather than typed
                    // out in advance.
                    neverSuspendExtra: await liveEngineProcesses(),
                });
            } catch (err) {
                // "already on" is not a failure worth stopping for.
                if (!/از قبل فعال/.test(err.message)) throw err;
            }

            done.tweaks = okNames;
            done.focus = focused;
            if (okNames.length) undo.push(`${okNames.length} تنظیم ویندوز عوض شد`);
            if (focused) undo.push('اولویت پراسس‌ها و پلن برق عوض شد');

            const bits = [];
            if (okNames.length) bits.push(`${okNames.length} تنظیم ویندوز`);
            if (focused && focused.detail) bits.push(focused.detail);
            if (!bits.length) step('pc', 'skipped', 'همه‌چیز از قبل روی حالت بازی بود.');
            else step('pc', 'done', bits.join(' · '));
        } catch (err) {
            step('pc', 'failed', err.message);
        }
        if (running.aborted) throw new Error('لغو شد');

        // ── 4. DNS ───────────────────────────────────────────────────────────────
        //
        // The lever this panel never had. For a sanctioned game the launcher's own domains
        // are frequently what fails first, and a resolver that answers honestly is worth
        // more than any amount of route optimisation to a server the client never finds.
        step('dns', 'running');
        try {
            if (!dnsManager) {
                step('dns', 'skipped', 'ماژول DNS در دسترس نیست.');
            } else {
                const st = await dnsManager.getStatus().catch(() => null);
                const current = st && st.current ? st.current.dns : null;

                // MEASURED, NOT PREFERRED.
                //
                // This used to call `dnsManager.pingAll()`, which asks every resolver for
                // `www.google.com` — a liveness check, not a capability one — and then rank the
                // answers with a hard-coded name at the top. Electro therefore won every run it
                // survived, whatever anything else could do, and that is what users complained
                // about.
                //
                // `dnspick.rank` asks each resolver for the domains THIS GAME's platform needs,
                // rejects a sinkhole or a root-server address as the non-answer it is, and does a
                // real TLS handshake against what came back. Then it ranks: coverage, then whether
                // the answer works, then speed. No vendor name anywhere.
                const scan = await dnspick.rank(dnsManager.PROVIDERS, game, {
                    onProgress: (row) => emit({ type: 'dns-row', row }),
                });
                const rows = scan.rows;
                const answered = rows.filter(r => r.resolved > 0).length;
                // The incumbent keeps the slot when it is as capable — eight providers tie here,
                // and swapping the machine's resolver because one of them replied 40ms sooner is
                // churn, not improvement.
                const best = dnspick.best(rows, { current });
                done.dnsScan = { domains: scan.domains, rows };
                // Said out loud, and now it says something: how many could actually open the
                // game's own domains, not how many are switched on.
                const scanned = `${rows.length} رزولور با دامنه‌های خودِ این بازی سنجیده شد (${answered} بازشان کرد)`;
                if (!best) {
                    step('dns', 'skipped', `${scanned} — هیچ‌کدام پاسخ قابل اتکایی ندادند، پس DNS دست‌نخورده ماند.`);
                } else if (current && sameServers(current, best.servers)) {
                    step('dns', 'done', `${scanned} · بهترین برای بازی «${best.fa}» بود (${best.ms}ms) و از قبل فعال است — ${best.why}`);
                } else {
                    await dnsManager.applyProvider(best.id);
                    done.dns = best;
                    undo.push('DNS عوض شد');
                    step('dns', 'done', `${scanned} · DNS روی «${best.fa}» رفت (${best.ms}ms) — ${best.why}`);
                }
            }
        } catch (err) {
            step('dns', 'failed', err.message);
        }
        if (running.aborted) throw new Error('لغو شد');

        // ── 5. direct, then the race ─────────────────────────────────────────────
        step('direct', 'running');
        let directResult = null;
        try {
            const anchor = catalog.UDP_ANCHORS[0];
            let ip = null;
            try { ip = await probe.resolve4(anchor.host); } catch { /* handled below */ }
            if (!ip) {
                directResult = { ok: false, blocked: true };
                step('direct', 'done', 'مسیر مستقیم حتی نام لنگر را resolve نکرد — یعنی مسیر مستقیم بسته است. پس تونل اینجا انتخاب نیست، لازم است.', { blocked: true });
            } else {
                const r = await probe.udpTrain({
                    host: anchor.host, ip, port: anchor.port, proto: 'stun',
                    pps: 20, seconds: 5, warmupMs: 800,
                });
                directResult = r;
                step('direct', r.ok ? 'done' : 'done',
                    r.ok
                        ? `مستقیم: min ${r.min}ms · p95 ${r.p95}ms · اتلاف ${r.loss}٪ (امتیاز ${r.score}).`
                        : 'مسیر مستقیم پاسخی نداد — یعنی برای این مقصد بسته است و تونل لازم می‌شود.',
                    { blocked: !r.ok });
            }
        } catch (err) {
            step('direct', 'failed', err.message);
        }
        if (running.aborted) throw new Error('لغو شد');

        step('path', 'running');
        try {
            const directBlocked = !directResult || !directResult.ok;
            // Held rather than fetched twice: boost.start needs the SAME lists to resolve a
            // winning node id back into something it can start. Re-reading could return a
            // different list — the free pool refreshes — and the winner would then not exist.
            const nodes = readNodes();
            const freeList = await readFreeNodes().catch(() => []);
            const report = await tournament.run({
                gameId: game.id,
                nodes,
                freeNodes: freeList,
                include: { aether: true, v2raySaved: true, v2rayFree: directBlocked, githubTunnel: false },
                maxNodes: directBlocked ? 10 : 6,
                drivers: engineDrivers,
                onEvent: ev => emit({ type: 'race', event: ev }),
                log,
            });
            done.race = report;
            try { profiles.recordTournament(report, {}); } catch { /* never fatal */ }

            const w = report.winner;
            if (report.verdict.code === 'must-tunnel' && w) {
                await boost.start({ gameId: game.id, engineId: w.id, profiles, drivers: engineDrivers, nodes, freeNodes: freeList, onLog: log });
                done.engine = w;
                undo.push('شتاب روشن شد');
                step('path', 'done', `مسیر مستقیم بسته بود؛ «${w.fa}» برداشته شد — min ${w.min}ms · p95 ${w.p95}ms.`);
            } else if (report.beatsDirect && w) {
                await boost.start({ gameId: game.id, engineId: w.id, profiles, drivers: engineDrivers, nodes, freeNodes: freeList, onLog: log });
                done.engine = w;
                undo.push('شتاب روشن شد');
                step('path', 'done', `«${w.fa}» از مستقیم بهتر بود (${w.score} در برابر ${report.direct.score}) — بازی از همان می‌رود.`);
            } else {
                step('path', 'skipped', 'هیچ تونلی از خط مستقیم تو بهتر نشد، پس لایه‌ی اضافه‌ای اضافه نکردم. بقیه‌ی کارها انجام شد.');
            }
        } catch (err) {
            step('path', 'failed', err.message);
        }
        if (running.aborted) throw new Error('لغو شد');

        // ── 6. the region ────────────────────────────────────────────────────────
        step('region', 'running');
        try {
            const advice = catalog.REGION_PICK && catalog.REGION_PICK[game.id];
            const cached = lastRegions;
            if (!advice) {
                step('region', 'skipped', 'این بازی انتخاب منطقه‌ی دستی ندارد.');
            } else if (!cached) {
                step('region', 'skipped', 'مقایسه‌ی مناطق هنوز گرفته نشده — از کارت «مقایسه‌ی مناطق» یک بار بگیر، بعد اینجا توصیه می‌آید.');
            } else {
                const rec = session.regionAdviceFor(game, cached.ranked);
                done.region = rec;
                // `reasons[0]` is the sentence written to be acted on — it names the region
                // and, when the game has a picker, where the setting lives.
                const line = rec && rec.reasons && rec.reasons.length
                    ? rec.reasons[0]
                    : (rec && rec.best ? `بهترین منطقه برای خط تو: ${rec.best.fa}` : 'بهترین منطقه مشخص شد.');
                step('region', 'done', line);
            }
        } catch (err) {
            step('region', 'failed', err.message);
        }

        // The marker that turns the button into "acceleration is on". Written only when
        // something was actually changed — a run that measured and concluded "nothing needed"
        // leaves nothing to switch off, and offering a stop button for it would be theatre.
        if (undo.length) {
            writeState({
                at: Date.now(), gameId: game.id, gameFa: game.fa,
                dns: done.dns || null,
                tweaks: (done.tweaks || []).length || 0,
                engine: done.engine ? done.engine.fa : null,
            });
        }

        // Give it all back when the match is over — see [armExitWatch]. Only when something
        // was actually applied, and only for a run that got far enough to have a game.
        if (undo.length) armExitWatch({ game, dnsManager, log, emit });

        const summary = buildSummary({ game, done, directResult, undo, outcomes });
        emit({ type: 'done', summary, done });
        log(`شتاب‌دهی «${game.fa}» تمام شد — ${summary.headline}`);
        return summary;
    } finally {
        running = null;
        state.aborted = true;
    }
}

/**
 * The engine processes that are ALIVE right now, by name.
 *
 * Asked of the machine rather than assumed, so an engine whose executable this app has not been
 * taught about is still spared. Cheap: one `tasklist` that game/detect.js already runs for its
 * own purposes, filtered against the shared list.
 */
async function liveEngineProcesses() {
    try {
        const { isEngine } = require('../engine-processes');
        // The same tasklist game/detect.js already runs, rather than a second one of our own.
        const procs = await require('./detect').processes();
        const names = new Set();
        for (const p of procs) {
            if (isEngine(p.name)) names.add(String(p.name).toLowerCase().replace(/\.exe$/, ''));
        }
        return [...names];
    } catch { return []; }
}

// ── Giving it back when the match ends ───────────────────────────────────────────────────────
//
// Acceleration is a claim about the time the user is PLAYING. Before this, the only automatic
// restore was at app shutdown: press the button, and every application stays suspended, the line
// stays throttled and the DNS stays swapped until the panel is found again. That is most of what
// «سیستم هنگ میکنه» actually was.
//
// Two shapes have to work, because both are legitimate:
//
//   * boost first, then launch the game. This is the architectural advantage over ExitLag —
//     the route is already in place when the first packet leaves — so the watch must WAIT for
//     the game to appear rather than concluding it has already ended.
//   * boost while already playing. Then it is running from the first tick.
//
// And the case with no match at all: a user who accelerates and walks away. After GRACE with no
// game ever seen, everything goes back rather than being left applied indefinitely.
let exitWatch = null;

/** Poll interval. The same six seconds the panel already uses to spot a running game. */
const WATCH_EVERY_MS = 6000;
/** How long to wait for the game to appear before concluding it is not coming. */
const WATCH_GRACE_MS = 20 * 60 * 1000;
/** A game is only "gone" after this many consecutive misses — launchers restart processes. */
const WATCH_MISSES = 3;

function cancelExitWatch() {
    if (exitWatch) { clearInterval(exitWatch.timer); exitWatch = null; }
}

function armExitWatch({ game, dnsManager, log = () => {}, emit = () => {} }) {
    cancelExitWatch();
    const procs = (game.procs || []).filter(p => !p.endsWith('*')).map(p => p.toLowerCase());
    if (!procs.length) return null;   // nothing to watch for; the manual stop stays the only way

    const state = { seen: false, misses: 0, armedAt: Date.now() };
    const detect = require('./detect');

    const finish = async (why) => {
        cancelExitWatch();
        log(`[GAME] ${why} — شتاب‌دهی برگردانده می‌شود.`);
        try {
            const r = await revert({ dnsManager, onLog: log });
            emit({ type: 'auto-revert', why, ok: r.ok, reverted: r.reverted, failed: r.failed });
            log(`[GAME] ${r.ok ? 'همه‌چیز برگشت.' : 'بعضی موارد برنگشت: ' + r.failed.join(' · ')}`);
        } catch (e) {
            emit({ type: 'auto-revert', why, ok: false, failed: [e.message] });
        }
    };

    exitWatch = {
        timer: setInterval(async () => {
            let hits = [];
            try { hits = (await detect.anyRunning(procs)) || []; } catch { return; }  // a bad poll is not an exit
            const up = hits.length > 0;

            if (up) { state.seen = true; state.misses = 0; return; }
            if (!state.seen) {
                if (Date.now() - state.armedAt > WATCH_GRACE_MS) {
                    finish('بازی در ۲۰ دقیقه اجرا نشد');
                }
                return;
            }
            // It was running and now it is not. Confirm over three polls: a launcher restarting
            // the game between rounds must not look like the end of the session.
            if (++state.misses >= WATCH_MISSES) finish('بازی بسته شد');
        }, WATCH_EVERY_MS),
    };
    // `unref` so a watch can never hold the process open at shutdown.
    if (exitWatch.timer.unref) exitWatch.timer.unref();
    log('[GAME] وقتی بازی بسته شود، همه‌چیز خودکار برمی‌گردد.');
    return exitWatch;
}

/**
 * Ask Windows to schedule the game ahead of background work.
 *
 * This is the ONLY thing in this project that resembles the "FPS boost" every competitor
 * advertises, and it is included because it is the only one that is real: it changes a
 * scheduling class. It does not free memory, close processes, or promise frames.
 */
function raisePriority(pids) {
    const { execFile } = require('child_process');
    const list = (pids || []).slice(0, 8).join(',');
    if (!list) return Promise.resolve(null);
    return new Promise(resolve => {
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
                `$ErrorActionPreference='SilentlyContinue'
foreach ($id in @(${list})) { $p = Get-Process -Id $id; if ($p) { $p.PriorityClass = 'High' } }
[PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress`],
            { timeout: 15000, windowsHide: true },
            (err) => resolve(err ? null : true));
    });
}


function sameServers(a, b) {
    if (!a || !b) return false;
    const norm = (x) => (Array.isArray(x) ? x : String(x).split(/[,\s]+/)).filter(Boolean).sort().join(',');
    return norm(a) === norm(b);
}

/**
 * One paragraph the player can act on, plus the honest list of what was and was not done.
 *
 * This is deliberately not a score out of ten. The measurements behind it are real numbers
 * with units, and flattening them into a grade would hide exactly the thing that makes them
 * trustworthy.
 */
function buildSummary({ game, done, directResult, undo, outcomes = {} }) {
    const wins = [];
    if (done.shaped && done.shaped.length) wins.push(`${done.shaped.length} برنامه از روی خط کنار رفت`);
    if (done.tweaks && done.tweaks.length) wins.push(`${done.tweaks.length} تنظیم ویندوز`);
    if (done.dns) wins.push(`DNS روی ${done.dns.fa}`);
    if (done.engine) wins.push(`مسیر از «${done.engine.fa}»`);
    if (done.region) wins.push('منطقه‌ی سرور مشخص شد');

    const failed = Object.entries(outcomes).filter(([, o]) => o.status === 'failed');
    const needsAdmin = failed.some(([, o]) => /دسترسی مدیر|administrator/i.test(o.detail || ''));

    // The headline has to be true even when it is unwelcome. Order matters: a failure is
    // reported before a success, because a user who is told "all good" while the single
    // biggest lever silently failed will (correctly) conclude the feature is a decoration.
    const headline = needsAdmin
        ? `${failed.length} کار انجام نشد چون برنامه دسترسی مدیر ندارد — با «Run as administrator» دوباره بزن`
        : failed.length
            ? `${failed.length} مرحله شکست خورد؛ ${wins.length} کار انجام شد`
            : done.engine
                ? `بازی از «${done.engine.fa}» می‌رود${wins.length > 1 ? ` و ${wins.length - 1} کار دیگر هم انجام شد` : ''}`
                : wins.length
                    ? `تونل لازم نبود؛ ${wins.length} کار دیگر انجام شد`
                    : 'همه‌چیز از قبل برای بازی مهیا بود — چیزی برای بهتر کردن پیدا نشد';

    // When nothing helped and the line itself is poor, say THAT rather than leaving the
    // player to conclude the tool does nothing. A bad p95 on a quiet line is a finding.
    const notes = [];
    if (!done.engine && directResult && directResult.ok && (directResult.score || 0) < 30) {
        notes.push(`خطت همین الان بد است (p95 ${directResult.p95}ms) و هیچ تونلی هم بهترش نکرد — یعنی مشکل از مسیر بین‌الملل خودِ اپراتور است، نه از چیزی که این‌جا قابل عوض کردن باشد. در ساعت آرام‌تر دوباره بگیر.`);
    }
    for (const [id, o] of failed) notes.push(`«${(STEPS.find(s => s.id === id) || {}).fa || id}»: ${o.detail || 'ناموفق'}`);

    return {
        at: Date.now(),
        gameFa: game.fa,
        headline,
        wins,
        notes,
        outcomes,
        undo,
        direct: directResult && directResult.ok
            ? { min: directResult.min, p95: directResult.p95, loss: directResult.loss, score: directResult.score }
            : null,
        directBlocked: !(directResult && directResult.ok),
        engine: done.engine || null,
    };
}

/** Put back everything the pipeline changed, in the reverse order it changed it. */
async function revert({ dnsManager = null, onLog = () => {} } = {}) {
    // Whatever the reason for reverting, the watch has nothing left to watch for.
    cancelExitWatch();
    const out = [];
    const failed = [];

    try { await boost.stop(onLog); out.push('شتاب خاموش شد'); } catch { /* may not have been on */ }

    // Every failure is COLLECTED, not swallowed. The first version caught and discarded them,
    // so a revert that could not remove a QoS policy for want of admin rights reported
    // success — while the throttle stayed on the machine and the panel stopped showing it.
    try {
        const r = await shaper.restoreAll();
        const okRows = (r.restored || []).filter(x => x.ok);
        const badRows = (r.restored || []).filter(x => !x.ok);
        if (okRows.length) out.push(`${okRows.length} محدودیت ترافیک برداشته شد`);
        for (const b of badRows) failed.push(b.error || `«${b.exe}» برنداشته شد`);
    } catch (e) { failed.push(e.message); }

    try { const r = await tweaks.restoreAll(); if (r && r.length) out.push(`${r.length} تنظیم ویندوز برگشت`); }
    catch (e) { failed.push('تنظیمات ویندوز: ' + e.message); }

    try { const r = await focus.restore(); if (!r.nothing) out.push(`اولویت ${r.restored} پراسس و پلن برق برگشت`); }
    catch (e) { failed.push('اولویت پراسس‌ها: ' + e.message); }

    if (dnsManager) {
        try { await dnsManager.restoreBackup(); out.push('DNS برگشت'); }
        catch (e) { failed.push('DNS: ' + e.message); }
    }

    // The marker is cleared only when everything really came back. Leaving it when something
    // did not is what keeps the card saying "still on" — which is the truth.
    if (!failed.length) clearState();
    return { ok: failed.length === 0, reverted: out, failed };
}

module.exports = {
    run, revert, isRunning, abort, status, STEPS,
    cancelExitWatch,
    // Exported for the suite. The watch is what decides that a match is over, and getting
    // that wrong either strands a user with everything suspended or tears their boost down
    // between rounds — both are worth pinning.
    armExitWatch,
    // Exported for the suite. These two are where the pipeline's honesty actually lives —
    // one decides what the user is told happened, the other decides which resolver a
    // sanctioned game gets — and both are pure, so they can be pinned without a machine.
    buildSummary,
    // `pickBestDns` was removed on 2026-09-14. It ranked resolvers by a hard-coded name —
    // «الکترو» first, unconditionally — because the data it was given (a `www.google.com` ping)
    // could not tell it anything about capability. game/dnspick.js measures capability instead.
};
