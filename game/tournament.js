// --- The engine tournament ---
//
// WHY THIS REPLACED THE OLD FLOW
// The first version of the accelerator asked the user to turn each engine on by hand, run
// an assessment, turn it off, turn the next one on, and compare the numbers themselves.
// That is not a feature, it is homework — and nobody with a hundred V2Ray nodes was ever
// going to do it. The panel drives it now: it starts each candidate, measures it, stops it,
// ranks them, and offers the winner with a button. The user never leaves the game tab and
// never switches an engine on by hand.
//
// WHAT IS IN THE FIELD
// Everything this app has that could plausibly carry a game — Aether's three protocols on
// both worthwhile scan modes, the user's saved V2Ray nodes, the free public config pools,
// and the GitHub Tunnel. The catalogue and the lifecycle live in game/engines.js; this
// file is the race itself.
//
// THE THREE HONEST CONSTRAINTS, BECAUSE THEY SHAPE EVERYTHING HERE
//
//   1. IT IS SEQUENTIAL AND IT DISRUPTS. Aether's protocols are one process with different
//      flags, and Xray serves one node at a time. Testing means starting and stopping the
//      user's own engines, so their connection wobbles while it runs. That is stated before
//      it starts and it never runs on its own.
//
//   2. A HUNDRED NODES CANNOT ALL BE DEEP-TESTED. A real UDP train is ~10 seconds plus
//      engine startup; a hundred of those is most of an hour. So this is a FUNNEL, the same
//      shape free-configs uses: a cheap screen first, a real measurement only on what
//      survives.
//
//   3. THE CHEAP SCREEN IS UDP CAPABILITY, AND IT IS BRUTAL. Most V2Ray nodes in this app
//      are Cloudflare Workers, and a Worker carries UDP for port 53 and nothing else —
//      measured, not assumed. For a game that is fatal, so a node that fails the UDP probe
//      is eliminated in about three seconds instead of being latency-tested for ten. On a
//      typical node list this removes most of the field before any real measurement starts.
//
// THE ONE EXCEPTION TO "NEVER TOUCH THE ROUTE"
// Every candidate is measured through its own SOCKS listener, so the machine's routing is
// untouched — except the GitHub Tunnel, which carries UDP only in full-tunnel mode where it
// owns the default route. It is therefore `exclusive`: opt-in, announced, measured directly
// from the machine while it owns the connection, and torn down immediately afterwards. It
// always runs LAST so that a failure there cannot cost the rest of the results.
//
// WHAT IT NEVER DOES
// It does not leave an engine running that it started, unless that engine wins and the user
// asks for it.

'use strict';

const probe = require('./probe');
const catalog = require('./catalog');
const engines = require('./engines');
const localaudit = require('./localaudit');

let running = null;   // { controller, startedAt, total, done }

function isRunning() { return !!running; }
function abort() { if (running) running.controller.aborted = true; }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Build the candidate list.
 *
 * Order is deliberate: cheap and non-disruptive first, expensive and disruptive last, so
 * an abort halfway through still leaves the user with the results that mattered most.
 */
function buildCandidates({
    nodes = [], freeNodes = [], include = {}, maxNodes = 12, maxFree = 8,
} = {}) {
    const out = [];

    if (include.aether !== false) {
        out.push(...engines.aetherSpecs({
            protocols: include.aetherProtocols || null,
            scans: include.aetherScans || null,
        }));
    }

    if (include.v2raySaved !== false && nodes.length) {
        // Newest first is the wrong order for this: the user's own ping column is a better
        // prior than recency, when one exists. Nodes without one keep their list order.
        const sorted = nodes.slice().sort((a, b) => {
            const pa = Number(a.ping) || Infinity, pb = Number(b.ping) || Infinity;
            return pa - pb;
        });
        sorted.slice(0, Math.max(0, maxNodes)).forEach((n, i) => out.push(engines.v2raySpec(n, { source: 'saved', index: i })));
    }

    // The free pools are opt-in and capped tighter than the saved list. They are large,
    // overwhelmingly Cloudflare Workers, and the user did not choose any of them — so they
    // are a bonus round, not the main field.
    if (include.v2rayFree === true && freeNodes.length) {
        freeNodes.slice(0, Math.max(0, maxFree)).forEach((n, i) => out.push(engines.v2raySpec(n, { source: 'free', index: i })));
    }

    // «گف», after the WARP variants and the user's own nodes and before the expensive ones.
    //
    // It earns a place by measurement: it is the ONLY one of this app's four SOCKS-front engines
    // that carries UDP at all. سایفون, لنترن and تور each refuse UDP ASSOCIATE outright, so none
    // of them can carry a game — for تور that is architectural, since it is a TCP overlay with no
    // UDP transport to offer. Putting them in the field would spend a minute of every race
    // rediscovering it.
    //
    // On by default rather than opt-in: unlike the free pools and the cloud runner it costs
    // nothing but its own startup, and it needs no account of the user's beyond the anonymous one
    // the app already made.
    if (include.geph !== false) out.push(engines.gephSpec());

    // Last, and only when asked: bringing up a cloud runner takes minutes, burns the
    // account's Actions quota, and takes the machine's route for the length of the test.
    if (include.githubTunnel === true) out.push(engines.githubTunnelSpec());

    return out;
}

/**
 * Measure one candidate that is already up.
 *
 * The UDP screen runs FIRST and short-circuits: a node that cannot carry UDP is useless for
 * a game no matter how good its latency is, and finding that out costs three seconds
 * instead of the fifteen a full train would.
 *
 * An `exclusive` candidate owns the machine's route while it is up, so it is measured with
 * the ordinary direct probe — there is no SOCKS listener carrying UDP to measure through,
 * and the traffic is going over the tunnel either way.
 */
async function measureOne(spec, target, signal) {
    if (spec.exclusive) {
        const r = await probe.udpTrain({
            host: target.host, ip: target.ip, port: target.port, proto: target.proto || 'stun',
            pps: 20, seconds: 6, warmupMs: 1000, signal,
        });
        return {
            ok: !!r.ok, udp: !!r.ok, exclusive: true,
            min: r.min, p50: r.p50, p95: r.p95, p99: r.p99,
            jitter: r.jitter, spread: r.spread, loss: r.loss, spikes: r.spikes,
            n: r.n, score: r.score || 0, ppsAchieved: r.ppsAchieved,
            reason: r.ok ? null : (r.error || 'پاسخی نیامد'),
        };
    }

    // The screen speaks STUN to the very anchor this function is about to measure. It used
    // to send a DNS query to 1.1.1.1:53, which WARP swallows — and that one wrong choice
    // eliminated every Aether variant from two complete tournaments with a verdict that was
    // simply false. See engines.screenUdp for the measurements.
    const screen = await engines.screenUdp({
        socksPort: spec.socksPort, host: target.host, ip: target.ip, port: target.port, signal,
    });
    if (!screen.udp) return { ok: false, udp: false, score: 0, reason: screen.reason };
    if (signal && signal.aborted) return { ok: false, udp: true, score: 0, reason: 'لغو شد' };

    const r = await probe.udpTrainViaSocks({
        host: target.host, ip: target.ip, port: target.port, proto: target.proto || 'stun',
        socksPort: spec.socksPort, pps: 20, seconds: 6, warmupMs: 1000, signal,
    });
    return {
        ok: !!r.ok, udp: true,
        min: r.min, p50: r.p50, p95: r.p95, p99: r.p99,
        jitter: r.jitter, spread: r.spread, loss: r.loss, spikes: r.spikes,
        n: r.n, score: r.score || 0,
        ppsAchieved: r.ppsAchieved,
        reason: r.ok ? null : (r.error || 'پاسخی نیامد'),
    };
}

/**
 * Run the whole tournament.
 *
 * `drivers` is server.js's engine lifecycle — see game/engines.js for why nothing here
 * touches aether-manager or xray-manager directly.
 */
async function run({
    gameId, nodes = [], freeNodes = [], include = {}, maxNodes = 12, maxFree = 8,
    drivers, onEvent = () => {}, log = () => {},
} = {}) {
    if (running) throw new Error('یک مسابقه‌ی موتورها از قبل در حال اجراست.');
    const controller = { aborted: false };
    const signal = controller;
    const emit = (e) => { try { onEvent(e); } catch {} };

    const game = catalog.byId(gameId) || { id: gameId, fa: gameId, regions: ['eu-central'] };

    // One fixed target for every candidate, so the comparison is about the engines and
    // nothing else. A UDP anchor is used rather than a game server because it is the only
    // destination guaranteed to answer from inside every engine.
    // THIS USED TO ABORT THE WHOLE RACE, AND IT WAS EXACTLY BACKWARDS.
    //
    // The old code resolved ONE anchor and, if that failed, threw «لنگر UDP در دسترس نیست».
    // But a user whose direct path cannot even reach a STUN server is not a user for whom
    // the comparison is meaningless — they are the user who NEEDS a tunnel, and telling them
    // "no fair comparison is possible" is the single least useful thing this feature could
    // say. Sanctioned and filtered games in Iran land here constantly.
    //
    // So: try every anchor, and treat total failure as a FINDING, not an error. The race
    // continues, `directBlocked` is set, and the verdict logic below stops requiring an
    // engine to beat a control that does not exist.
    let anchor = null;
    let target = null;
    for (const a of catalog.UDP_ANCHORS) {
        try {
            target = { host: a.host, ip: await probe.resolve4(a.host), port: a.port, proto: 'stun' };
            anchor = a;
            break;
        } catch { /* try the next operator */ }
    }
    if (!target) {
        // Not even a name resolved. The engines still have to be measured — from inside a
        // tunnel the same host usually resolves fine — so fall back to Google's STUN by
        // literal address and let the direct control fail honestly on its own.
        anchor = { ...catalog.UDP_ANCHORS[0], fa: catalog.UDP_ANCHORS[0].fa + ' (بدون DNS)' };
        target = { host: anchor.host, ip: '142.250.82.127', port: anchor.port, proto: 'stun' };
        emit({ type: 'dns-blocked' });
        log('هیچ لنگری از مسیر مستقیم resolve نشد — یعنی DNS یا خود مسیر بسته است. مسابقه ادامه می‌دهد.');
    }

    const candidates = buildCandidates({ nodes, freeNodes, include, maxNodes, maxFree });
    if (!candidates.length) throw new Error('هیچ موتوری برای آزمایش پیدا نشد.');

    running = { controller, startedAt: Date.now(), total: candidates.length + 1, done: 0 };
    const results = [];

    try {
        emit({
            type: 'start', total: candidates.length + 1, gameFa: game.fa, targetFa: anchor.fa,
            candidates: candidates.map(c => ({ id: c.id, fa: c.fa, kind: c.kind, exclusive: !!c.exclusive })),
        });

        // How busy is the line before anything starts?
        //
        // The assessment has carried this caveat since the evening it was proved: with a
        // video streaming, p95 to Frankfurt read 457ms and looked exactly like a broken
        // international route; on an idle line the same anchors read 124ms. A tournament is
        // even more exposed — it compares candidates measured MINUTES apart, so a download
        // that starts halfway through does not just inflate the numbers, it inflates the
        // numbers of whichever engine happened to be under test at the time.
        let lineLoad = null;
        try { lineLoad = await localaudit.lineLoad({ seconds: 3 }); } catch { /* never fatal */ }
        if (lineLoad) emit({ type: 'line', load: lineLoad });

        // ── the control: direct ──────────────────────────────────────────────────
        // Without it a "winner" is only the best of a bad field. Measured first, while
        // nothing has been started or stopped yet.
        log('مسیر مستقیم (شاهد) سنجیده می‌شود');
        emit({ type: 'candidate', id: 'direct', fa: 'مستقیم (بدون موتور)', phase: 'measuring', index: 0 });
        const directRun = await probe.udpTrain({
            host: target.host, ip: target.ip, port: target.port, proto: 'stun',
            pps: 20, seconds: 6, warmupMs: 1000, signal,
        });
        const direct = {
            id: 'direct', fa: 'مستقیم (بدون موتور)', kind: 'direct', udp: !!directRun.ok,
            ok: !!directRun.ok, min: directRun.min, p50: directRun.p50, p95: directRun.p95,
            jitter: directRun.jitter, spread: directRun.spread, loss: directRun.loss,
            spikes: directRun.spikes, n: directRun.n, score: directRun.score || 0,
            reason: directRun.ok ? null : (directRun.error || 'پاسخی نیامد'),
        };
        results.push(direct);
        running.done = 1;
        emit({ type: 'result', result: direct, done: 1, total: candidates.length + 1 });

        // ── each engine in turn ──────────────────────────────────────────────────
        for (const [i, cand] of candidates.entries()) {
            if (signal.aborted) break;
            const index = i + 1;
            emit({
                // `engineKind`, NOT `kind`: routes.js wraps every one of these as
                // `{ kind: 'tournament', ...ev }`, so a top-level `kind` here would
                // overwrite the envelope and the panel would silently drop the event as
                // belonging to some other feature. Found by a test that did exactly that.
                type: 'candidate', id: cand.id, fa: cand.fa, engineKind: cand.kind,
                exclusive: !!cand.exclusive, phase: 'starting', index, total: candidates.length + 1,
            });
            log(`آزمایش ${cand.fa}`);

            let started = false;
            let row = { id: cand.id, fa: cand.fa, kind: cand.kind, source: cand.source || null, ok: false, score: 0, reason: null };

            try {
                emit({ type: 'candidate', id: cand.id, fa: cand.fa, phase: 'waiting', index });
                const r = await engines.ensure(cand, drivers, { log, signal });
                started = r.started;

                if (signal.aborted) {
                    row.reason = 'لغو شد';
                } else {
                    emit({ type: 'candidate', id: cand.id, fa: cand.fa, phase: 'measuring', index });
                    row = { ...row, ...(await measureOne(cand, target, signal)) };
                }
            } catch (err) {
                row.reason = err && err.message ? err.message : String(err);
            } finally {
                // Always put the machine back. A tournament that leaves the last-tested
                // engine running would silently change the user's connection.
                await engines.release(cand, drivers, { started, log });
            }

            results.push(row);
            running.done = index + 1;
            emit({ type: 'result', result: row, done: index + 1, total: candidates.length + 1 });
            await sleep(200);
        }

        const ranked = results.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
        const winner = ranked.find(r => r.ok) || null;
        const beatsDirect = !!(winner && direct.ok && winner.id !== 'direct' && winner.score - direct.score >= 8);

        // The case that used to abort the run: direct never answered. For a sanctioned or
        // filtered game that is the NORMAL state, and the right answer is not "no fair
        // comparison is possible" — it is "the direct path is closed, so the fastest tunnel
        // that works is the answer, and here it is". No 8-point margin is required against a
        // control that does not exist.
        const directBlocked = !direct.ok;

        const verdict = !winner ? {
            code: 'none', tone: 'bad', title: 'هیچ مسیری کار نکرد',
            reasons: ['نه مسیر مستقیم و نه هیچ موتوری پاسخ نداد. مشکل بزرگ‌تری در اتصال هست.'],
        } : (directBlocked && winner.id !== 'direct') ? {
            code: 'must-tunnel', tone: 'ok', title: `مسیر مستقیم بسته است — «${winner.fa}» را بردار`,
            reasons: [
                'مسیر مستقیم به هیچ لنگری جواب نداد. برای بازی‌های تحریم‌شده یا فیلترشده این حالت عادی است، نه خرابی خط تو.',
                `بهترین مسیری که کار کرد: «${winner.fa}» — min ${winner.min}ms · p95 ${winner.p95}ms · اتلاف ${winner.loss}٪.`,
                'اینجا تونل انتخاب نیست، تنها راه است — پس معیار «بهتر از مستقیم» معنا ندارد و سریع‌ترین تونلِ کارکننده برنده است.',
            ],
        } : winner.id === 'direct' || !beatsDirect ? {
            code: 'stay-direct', tone: 'ok', title: 'مستقیم بمان — هیچ موتوری بهتر نبود',
            reasons: [
                `مستقیم: min ${direct.min}ms · p95 ${direct.p95}ms · اتلاف ${direct.loss}٪ (امتیاز ${direct.score}).`,
                winner.id === 'direct'
                    ? 'هیچ موتوری از خط خودت بهتر نشد.'
                    : `بهترین موتور «${winner.fa}» بود با امتیاز ${winner.score} — اختلافش با مستقیم آن‌قدر نیست که ارزش یک لایه‌ی اضافه را داشته باشد.`,
                'این نتیجه‌ی خوبی است، نه شکست: یعنی مسیر بین‌الملل تو برای این مقصد سالم است.',
            ],
        } : {
            code: 'winner', tone: 'ok', title: `«${winner.fa}» بهترین است`,
            reasons: [
                `از داخل آن: min ${winner.min}ms · p95 ${winner.p95}ms · اتلاف ${winner.loss}٪ (امتیاز ${winner.score}).`,
                `مستقیم: min ${direct.min}ms · p95 ${direct.p95}ms · اتلاف ${direct.loss}٪ (امتیاز ${direct.score}).`,
                'می‌توانی همین‌جا با یک دکمه شتاب را روی همین موتور روشن کنی.',
            ],
        };

        const noUdp = results.filter(r => r.udp === false).length;
        if (noUdp) verdict.reasons.push(`${noUdp} مسیر به‌خاطر نداشتن UDP همان اول کنار گذاشته شد.`);

        // Said as a caveat on the result, not as a separate card nobody reads: if the line
        // was busy when the race started, every number below is about a loaded line and the
        // ranking may be about nothing but the order things were tested in.
        if (lineLoad && lineLoad.verdict !== 'ok') {
            verdict.reasons.push(
                `⚠️ وقتی مسابقه شروع شد خط تو مشغول بود (${lineLoad.detail}). ` +
                'اعداد این جدول را با احتیاط بخوان و در خط آزاد دوباره بگیر.');
        }

        const report = {
            at: Date.now(), gameId, gameFa: game.fa,
            target: `${anchor.fa} (${anchor.host}:${anchor.port})`,
            ranked, direct, winner, beatsDirect, directBlocked, verdict, lineLoad,
            aborted: signal.aborted,
        };
        emit({ type: 'done', report });
        return report;
    } finally {
        running = null;
    }
}

module.exports = { run, isRunning, abort, buildCandidates };
