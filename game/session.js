// --- The assessment run ---
//
// One orchestrated pass that answers the only question worth asking:
//
//     "For THIS game, on THIS line, right now — is anything better than direct,
//      and if not, where is the actual problem?"
//
// THE ORDER IS THE ARGUMENT
//   1. audit the local line first. If the bottleneck is in the room, say so and stop
//      recommending routes — a relay cannot fix a saturated uplink or a sleeping Wi-Fi
//      radio, and pretending otherwise is how "gaming VPNs" lose their credibility.
//   2. measure the real destination if the game's protocol lets us. FiveM answers
//      `getinfo`, Source answers A2S_INFO, a running game exposes its TCP endpoints.
//   3. measure regional anchors in the same breath, interleaved, never sequentially.
//   4. only then compare, and be willing to conclude "stay direct".
//
// THE ROUTE-DETOUR TEST
// A relay can only beat direct when the direct route is detoured, because every path out
// of Iran crosses the same international gateway and therefore pays the same first leg.
// The test is a subtraction:
//
//     detour = RTT(direct → game server) − RTT(direct → a well-peered DC in that region)
//
// Both terms are measurable from the client, with no server anywhere. A small detour means
// the route is healthy and a relay is a waste of money. A large one is the recoverable
// part, and it is the only honest basis for telling someone to buy a VPS.

'use strict';

const probe = require('./probe');
const catalog = require('./catalog');
const detect = require('./detect');
const localaudit = require('./localaudit');
const engines = require('./engines');

let current = null;   // only one assessment at a time — they fight over the same line

function isRunning() { return !!current; }
function abort() { if (current) current.controller.abort(); }

/** A cheap AbortController-alike that also works on older runtimes. */
function makeController() {
    const c = { aborted: false };
    return { signal: c, abort() { c.aborted = true; } };
}

/**
 * Parse "1.2.3.4:30120" / "host.example:27015" / "1.2.3.4" into { host, port }.
 * Returns null rather than guessing when the input is nonsense.
 */
function parseServer(input, defaultPort) {
    if (!input) return null;
    const s = String(input).trim().replace(/^\w+:\/\//, '');
    const m = s.match(/^\[?([A-Za-z0-9._-]+|[0-9a-fA-F:]+)\]?(?::(\d{1,5}))?$/);
    if (!m) return null;
    const port = m[2] ? Number(m[2]) : defaultPort;
    if (!port || port < 1 || port > 65535) return null;
    return { host: m[1], port };
}

const DEFAULT_PORT = { fivem: 30120, a2s: 27015, raknet: 19132, minecraft: 25565 };

/**
 * Build the target set.
 *
 * `real` targets talk to the game's own servers and are labelled as such. `anchor` targets
 * stand in for a region. The distinction is carried all the way to the UI, because a
 * number measured against the actual server and a number measured against a datacentre in
 * roughly the same place are not the same claim.
 */
async function buildTargets(game, { serverAddr, liveEndpoints, quick }) {
    const targets = [];
    const seconds = quick ? 2 : 3;

    // 1. The real thing, when the game's protocol answers.
    if (serverAddr && game.probe && DEFAULT_PORT[game.probe]) {
        const parsed = parseServer(serverAddr, DEFAULT_PORT[game.probe]);
        if (parsed) {
            try {
                const ip = await probe.resolve4(parsed.host);
                targets.push({
                    key: 'game', label: `سرور بازی — ${parsed.host}:${parsed.port}`,
                    kind: 'real', mode: 'udp', proto: game.probe,
                    host: parsed.host, ip, port: parsed.port, seconds,
                });
            } catch { /* name did not resolve — fall through to anchors */ }
        }
    }

    // 2. A running game's own TCP endpoints. For a TCP game this IS the destination; for a
    //    UDP game it is the service/matchmaking side, which still reveals the region the
    //    session was placed in — and that is exactly what the detour test needs.
    if (liveEndpoints && liveEndpoints.tcp && liveEndpoints.tcp.length) {
        const pick = liveEndpoints.tcp
            .filter(e => e.port === 443 || e.port === 80 || e.port > 1024)
            .slice(0, 2);
        pick.forEach((e, i) => targets.push({
            key: 'live' + i, label: `اتصال زنده‌ی بازی — ${e.ip}:${e.port}`,
            kind: 'real', mode: 'tcp', ip: e.ip, host: e.ip, port: e.port, seconds,
        }));
    }

    // 3. Regional anchors — always, because they are the denominator of the detour test.
    for (const a of catalog.anchorsFor(game)) {
        try {
            const ip = await probe.resolve4(a.host);
            targets.push({
                key: 'anchor:' + a.group, label: `${a.regionFa} — ${a.group}`,
                kind: 'anchor', region: a.region, mode: 'tcp',
                host: a.host, ip, port: a.port, seconds,
            });
        } catch { /* skip an anchor we cannot resolve */ }
    }

    return targets;
}

/**
 * Compare the same UDP anchor through every engine that can be measured concurrently.
 *
 * Only SOCKS5-with-UDP engines qualify. A TUN-based engine owns the whole machine, so
 * "measuring through it" means switching the user's entire connection over — that belongs
 * behind an explicit action, not inside an assessment run.
 */
async function measureEngines({ signal, onEvent, drivers = null, autoStart = true }) {
    const out = [];
    const candidates = [
        { id: 'aether', fa: 'موتورهای وارپ', socksPort: 20810 },
    ];
    const anchor = catalog.UDP_ANCHORS[0];
    let ip;
    try { ip = await probe.resolve4(anchor.host); } catch { return out; }

    // The assessment used to skip this whole phase when nothing was running, and told the
    // user to go and switch an engine on somewhere else. It starts one itself now — the
    // cheapest variant only (MASQUE on turbo), because the assessment answers "is my line
    // the problem?", not "which of six variants is best". That second question is the
    // tournament's, and it is one button away.
    let startedSpec = null;
    if (autoStart && drivers && !(await engines.portAlive(20810))) {
        const spec = engines.aetherSpecs({ protocols: ['masque'], scans: ['turbo'] })[0];
        if (onEvent) onEvent({ type: 'engine', id: 'aether', phase: 'starting', fa: spec.fa });
        try {
            const r = await engines.ensure(spec, drivers, { signal });
            if (r.started) startedSpec = spec;
        } catch (err) {
            out.push({ ...candidates[0], available: false, reason: err.message });
            return out;
        }
    }

    try {
        for (const c of candidates) {
            if (signal && signal.aborted) break;
            // Cheap liveness check first: associating against a dead port wastes four seconds.
            let alive = false;
            try {
                const { ctl } = await probe.socksUdpAssociate(c.socksPort, 1500);
                try { ctl.destroy(); } catch {}
                alive = true;
            } catch { alive = false; }
            if (!alive) { out.push({ ...c, available: false, reason: 'موتور روشن نیست یا UDP نمی‌دهد' }); continue; }

            if (onEvent) onEvent({ type: 'engine', id: c.id, phase: 'measuring' });
            const r = await probe.udpTrainViaSocks({
                host: anchor.host, ip, port: anchor.port, proto: 'stun',
                socksPort: c.socksPort, pps: 20, seconds: 5, warmupMs: 800, signal,
            });
            out.push({ ...c, available: true, result: { ...r, series: undefined } });
        }
        return out;
    } finally {
        // Leave the machine as it was found. An engine the assessment started is the
        // assessment's to put back; one the user had running is not.
        if (startedSpec) await engines.release(startedSpec, drivers, { started: true });
    }
}

/**
 * The verdict.
 *
 * Written so that "stay direct" is a first-class, respectable outcome. If this function
 * cannot say that, the whole feature is dishonest.
 */
function verdictFrom({ audit, results, game, hasRealTarget }) {
    const anchors = Object.entries(results).filter(([k]) => k.startsWith('anchor:')).map(([, v]) => v).filter(v => v.ok);
    const gameRes = results.game && results.game.ok ? results.game : null;
    const live = Object.entries(results).filter(([k]) => k.startsWith('live')).map(([, v]) => v).filter(v => v.ok);
    const primary = gameRes || live[0] || null;

    const bestAnchor = anchors.length ? anchors.reduce((a, b) => (b.score > a.score ? b : a)) : null;
    const detour = (primary && bestAnchor) ? primary.min - bestAnchor.min : null;

    const reasons = [];
    let code, title, tone;

    // If the user's own line was busy while this ran, EVERY number below is worse than the
    // truth. Found the hard way: an assessment taken during a video stream produced p95
    // values to Frankfurt that looked like a broken international route. This caveat is
    // prepended to whatever verdict follows rather than replacing it, because the
    // measurement is still real — it is just a measurement of a loaded line.
    const loadChk = audit && (audit.checks || []).find(c => c.id === 'load');
    const busy = loadChk && (loadChk.verdict === 'warn' || loadChk.verdict === 'bad');
    const busyNote = busy
        ? `توجه: خط شما حین این سنجش مشغول بود (${loadChk.detail}). همه‌ی اعداد زیر زیر همان بار گرفته شده‌اند و از حالت بی‌کار بدترند — برای قضاوت نهایی، سنجش را با خط آزاد تکرار کن.`
        : null;

    // A peer-to-peer game with a broken NAT has ONE problem, and it is not the route.
    // Saying "your ping to Frankfurt is fine" to someone who cannot join their friend's
    // session is technically true and completely useless, so this outranks everything.
    const natChk = audit && (audit.checks || []).find(c => c.id === 'nat');
    const natType = natChk && natChk.data ? natChk.data.natType : null;
    if (game.klass === 'p2p' && (natType === 'strict' || natType === 'cgnat')) {
        return {
            code: 'nat', tone: 'bad',
            title: natType === 'cgnat'
                ? 'مشکل اصلی شما CGNAT است، نه مسیر'
                : 'مشکل اصلی شما NAT سخت‌گیرانه است، نه مسیر',
            reasons: [
                ...(busyNote ? [busyNote] : []),
                `«${game.fa}» یک بازی همتا‌به‌همتاست: حریف شما خودش میزبان است، پس چیزی به نام «پینگ به سرور» وجود ندارد و آنچه جلسه را می‌سازد یا خراب می‌کند عبور NAT است.`,
                ...(natChk.findings || []),
                primary
                    ? `برای مقایسه، کیفیت مسیر شما بد نیست: min ${primary.min}ms · p95 ${primary.p95}ms. بهبود مسیر اینجا مشکل شما را حل نمی‌کند.`
                    : 'کیفیت مسیر در این اجرا سنجیده نشد، ولی حتی اگر عالی باشد این مشکل را حل نمی‌کند.',
            ],
            detour, bestAnchor: bestAnchor ? bestAnchor.label : null, primary: primary ? primary.label : null,
        };
    }

    // The local line wins the argument whenever it is the problem.
    if (audit && audit.overall === 'bad') {
        code = 'local';
        tone = 'bad';
        title = 'گلوگاه در سمت شماست، نه در مسیر';
        if (busyNote) reasons.push(busyNote);
        reasons.push('ممیزی خط محلی یک مشکل جدی پیدا کرد. تا وقتی آن حل نشود، هیچ تونل و هیچ رله‌ای تفاوت محسوسی نمی‌سازد.');
        for (const c of audit.checks.filter(c => c.verdict === 'bad')) reasons.push(`${c.fa}: ${c.detail}`);
        return { code, tone, title, reasons, detour, bestAnchor: bestAnchor ? bestAnchor.label : null, primary: primary ? primary.label : null };
    }

    if (!primary) {
        code = 'no-target';
        tone = 'neutral';
        title = 'مقصد واقعی بازی در دسترس نبود';
        if (busyNote) reasons.push(busyNote);
        reasons.push(game.probe === 'anchors'
            ? 'این بازی به هیچ کوئری عمومی جواب نمی‌دهد و در حال اجرا هم نبود، پس فقط منطقه‌ها سنجیده شدند.'
            : 'آدرس سرور وارد نشد و بازی در حال اجرا نبود.');
        if (bestAnchor) reasons.push(`بهترین منطقه برای این بازی از خط شما: ${bestAnchor.label} — min ${bestAnchor.min}ms · p95 ${bestAnchor.p95}ms.`);
        reasons.push('برای حکم دقیق: بازی را اجرا کن و دوباره بزن، یا اگر سرور اختصاصی داری آدرسش را وارد کن.');
        return { code, tone, title, reasons, detour, bestAnchor: bestAnchor ? bestAnchor.label : null, primary: null };
    }

    const unstable = (primary.spread != null && primary.spread > 40) || primary.loss > 1 || primary.spikePct > 5;

    if (busyNote) reasons.push(busyNote);

    if (detour != null && detour >= 30) {
        code = 'detour';
        tone = 'warn';
        title = `مسیر مستقیم شما حدود ${Math.round(detour)} میلی‌ثانیه انحراف دارد`;
        reasons.push(`مسیر به مقصد بازی ${primary.min}ms است، ولی به «${bestAnchor.label}» — که عملاً در همان منطقه است — فقط ${bestAnchor.min}ms.`);
        reasons.push(`این اختلاف همان بخشِ قابل بازپس‌گیری است. یک رله در آن منطقه می‌تواند تا حدود ${Math.max(0, Math.round(detour - 5))}ms برگرداند.`);
        reasons.push('این تخمین است، نه وعده: پای دوم (رله تا سرور بازی) فقط وقتی دقیق اندازه‌گیری می‌شود که رله واقعاً وجود داشته باشد.');
    } else if (unstable) {
        code = 'unstable';
        tone = 'warn';
        title = 'سرعت مسیر مشکلی ندارد، پایداری‌اش دارد';
        reasons.push(`min برابر ${primary.min}ms است ولی p95 برابر ${primary.p95}ms — یعنی ${primary.spread}ms پراکندگی${primary.loss > 0 ? ` و ${primary.loss}٪ اتلاف` : ''}.`);
        reasons.push('این همان چیزی است که در بازی به‌صورت پرش و لاستیکی شدن حس می‌شود، حتی وقتی «پینگ» خوب نشان داده می‌شود.');
        if (audit && audit.overall === 'warn') reasons.push('ممیزی محلی هم نکاتی داشت — اول آن‌ها را رفع کن، ارزان‌ترین بهبود همان‌هاست.');
        reasons.push('اگر بعد از رفع موارد محلی باز هم ناپایدار بود، یک رله می‌تواند این قطعه را بپوشاند — بدون اینکه لزوماً پینگ را کم کند.');
    } else {
        code = 'stay-direct';
        tone = 'ok';
        title = 'مستقیم بمان — هیچ مسیری بهتر از خط خودت نیست';
        reasons.push(`مسیر مستقیم به مقصد بازی: min ${primary.min}ms · p95 ${primary.p95}ms · اتلاف ${primary.loss}٪${primary.spikes ? ` · ${primary.spikes} پرش` : ' · بدون پرش'}.`);
        if (detour != null) reasons.push(`انحراف مسیر فقط ${Math.round(detour)}ms است؛ یعنی مسیر بین‌الملل شما برای این مقصد سالم است.`);
        reasons.push('روشن کردن تونل روی این مسیر تقریباً حتماً بدترش می‌کند. این نتیجه‌ی خوبی است، نه شکست.');
    }

    return { code, tone, title, reasons, detour, bestAnchor: bestAnchor ? bestAnchor.label : null, primary: primary.label };
}

/**
 * Run a full assessment.
 *
 * onEvent is called throughout so the panel can draw progress and live samples instead of
 * showing a spinner for a minute.
 */
async function assess(opts = {}) {
    if (current) throw new Error('یک سنجش دیگر در حال اجراست.');
    const {
        gameId, serverAddr = null, quick = false,
        includeAudit = true, includeEngines = true, onEvent = () => {},
        // server.js's engine lifecycle. With it, the assessment can switch an engine on for
        // the comparison and switch it back off; without it, the engine phase only reports
        // what happens to be running already.
        drivers = null, autoEngines = true,
    } = opts;

    const game = catalog.byId(gameId) || {
        id: gameId, fa: gameId, en: gameId, klass: 'dedicated', probe: 'anchors',
        regions: ['eu-central'], procs: [], anticheat: null,
    };

    const controller = makeController();
    current = { controller, gameId, startedAt: Date.now() };
    const emit = (e) => { try { onEvent(e); } catch {} };

    try {
        emit({ type: 'phase', phase: 'start', game: { id: game.id, fa: game.fa } });

        // ── running game + live endpoints ───────────────────────────────────────
        emit({ type: 'phase', phase: 'detect' });
        const running = await detect.runningGames();
        const mine = running.find(r => r.id === game.id) || null;
        let liveEndpoints = null;
        if (mine) {
            liveEndpoints = await detect.endpointsFor(mine.pids);
            emit({ type: 'live', running: true, pids: mine.pids, endpoints: liveEndpoints });
        } else {
            emit({ type: 'live', running: false });
        }

        // ── local line ──────────────────────────────────────────────────────────
        let audit = null;
        if (includeAudit) {
            emit({ type: 'phase', phase: 'audit' });
            audit = await localaudit.quickAudit({ signal: controller.signal });
            emit({ type: 'audit', audit });
        }
        if (controller.signal.aborted) throw new Error('لغو شد');

        // ── targets + interleaved measurement ───────────────────────────────────
        emit({ type: 'phase', phase: 'targets' });
        const targets = await buildTargets(game, { serverAddr, liveEndpoints, quick });
        if (!targets.length) throw new Error('هیچ مقصد قابل سنجشی پیدا نشد.');
        emit({ type: 'targets', targets: targets.map(t => ({ key: t.key, label: t.label, kind: t.kind, mode: t.mode })) });

        emit({ type: 'phase', phase: 'measure' });
        const results = await probe.interleaved(targets, {
            slices: quick ? 2 : 4,
            secondsPerSlice: quick ? 2 : 3,
            pps: 20,
            signal: controller.signal,
            // Carry a downsampled slice of the samples with each progress tick. Sending
            // every packet would be ~80 messages a second across four targets; one
            // summarised slice per target per pass is 16 messages for the whole run and
            // is enough for the panel to draw a line that grows while it measures.
            onProgress: p => emit({
                type: 'progress', step: p.step, total: p.total, key: p.key, slice: p.slice,
                min: p.run && p.run.min, p50: p.run && p.run.p50, p95: p.run && p.run.p95,
                points: p.run && p.run.series
                    ? p.run.series.filter((_, i) => i % 2 === 0).slice(0, 30).map(x => x.rtt)
                    : [],
            }),
        });
        emit({ type: 'results', results: Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ...v, series: undefined }])) });

        // ── engines that can be measured side by side ───────────────────────────
        // Named `engineResults` rather than `engines`: the module-level import of
        // game/engines.js is what measureEngines uses to start one, and a local of the same
        // name inside this block is a shadow waiting to become a very confusing bug.
        let engineResults = [];
        if (includeEngines && !controller.signal.aborted) {
            emit({ type: 'phase', phase: 'engines' });
            engineResults = await measureEngines({
                signal: controller.signal, onEvent: emit, drivers, autoStart: autoEngines,
            });
            emit({ type: 'engines', engines: engineResults });
        }

        const verdict = verdictFrom({ audit, results, game, hasRealTarget: targets.some(t => t.kind === 'real') });
        const report = {
            at: Date.now(),
            game: { id: game.id, fa: game.fa, en: game.en, klass: game.klass, probe: game.probe, anticheat: game.anticheat, kernelAnticheat: catalog.usesKernelAnticheat(game) },
            running: !!mine,
            serverAddr: serverAddr || null,
            audit, results, engines: engineResults, verdict,
            targets: targets.map(t => ({ key: t.key, label: t.label, kind: t.kind, mode: t.mode, region: t.region || null })),
        };
        emit({ type: 'done', report });
        return report;
    } finally {
        current = null;
    }
}

module.exports = { assess, isRunning, abort, parseServer, verdictFrom };

// ── region comparison ───────────────────────────────────────────────────────────
//
// The highest-value thing this feature can do without any infrastructure at all.
//
// Forty-six of the catalogue's games let the player pick their own server region, and on
// an Iranian line the difference between two of them is routinely larger than anything a
// tunnel could recover — the datacentre measurements behind this project spanned 76ms to
// 223ms across regions, on one connection, at one moment. Yet the choice is almost always
// left on "auto", which picks by geography or by a single ping and gets it wrong for
// exactly the reasons this engine exists.
//
// So: measure every region, interleaved, rank by playability rather than by ping, and hand
// the user a sentence they can act on inside the game's own menu.
//
// TWO ANCHORS PER REGION, NOT ONE. A single anchor cannot tell "this region is far" from
// "this one prefix is badly peered" — the very confusion that produced a 457ms p95 from one
// Frankfurt host and 124ms from another in the same minute. Two independent operators per
// region make the regional verdict about the region.

async function compareRegions({ onEvent = () => {}, signal = null, quick = false } = {}) {
    const emit = (e) => { try { onEvent(e); } catch {} };
    emit({ type: 'phase', phase: 'targets' });

    const targets = [];
    for (const [id, reg] of Object.entries(catalog.REGIONS)) {
        for (const t of reg.tcp.slice(0, 2)) {
            try {
                const ip = await probe.resolve4(t.host);
                targets.push({
                    key: `${id}#${t.group}`, label: `${reg.fa} — ${t.group}`,
                    region: id, regionFa: reg.fa, group: t.group,
                    mode: 'tcp', host: t.host, ip, port: t.port,
                });
            } catch { /* an anchor that will not resolve is simply not evidence */ }
        }
    }
    if (!targets.length) throw new Error('هیچ لنگری قابل دسترسی نبود.');

    emit({ type: 'targets', count: targets.length, regions: [...new Set(targets.map(t => t.region))].length });
    emit({ type: 'phase', phase: 'measure' });

    const results = await probe.interleaved(targets, {
        slices: quick ? 2 : 3,
        secondsPerSlice: 1.2,
        signal,
        onProgress: p => emit({ type: 'progress', step: p.step, total: p.total, key: p.key }),
    });

    // Roll anchors up into regions. The region takes its BEST anchor's score, not the mean:
    // a user only has to reach one good host in a region for the region to be usable, and
    // averaging in a badly-peered prefix would condemn a region for a problem the player
    // will never touch.
    const byRegion = new Map();
    for (const t of targets) {
        const r = results[t.key];
        if (!r || !r.ok) continue;
        const cur = byRegion.get(t.region);
        const rec = { region: t.region, fa: t.regionFa, best: r, group: t.group, anchors: (cur ? cur.anchors : []).concat([{ group: t.group, ...r, series: undefined }]) };
        if (!cur || r.score > cur.best.score) byRegion.set(t.region, rec);
        else { cur.anchors = rec.anchors; }
    }

    const ranked = [...byRegion.values()]
        .map(x => ({
            region: x.region, fa: x.fa, group: x.group,
            min: x.best.min, p50: x.best.p50, p95: x.best.p95, p99: x.best.p99,
            jitter: x.best.jitter, spread: x.best.spread, loss: x.best.loss,
            spikes: x.best.spikes, score: x.best.score,
            anchors: x.anchors.map(a => ({ group: a.group, min: a.min, p95: a.p95, jitter: a.jitter, score: a.score })),
        }))
        .sort((a, b) => b.score - a.score);

    const unreachable = [...new Set(targets.map(t => t.region))].filter(r => !byRegion.has(r));

    emit({ type: 'done', ranked, unreachable });
    return { at: Date.now(), ranked, unreachable, targets: targets.length };
}

/**
 * Turn the ranking into advice for one game.
 *
 * Only the regions the game actually operates in are considered — telling a player whose
 * game has no Moscow servers that Moscow is their best region is worse than saying nothing.
 */
function regionAdviceFor(game, ranked) {
    if (!game || !ranked || !ranked.length) return null;
    const hint = catalog.regionHint(game.id);
    const gameRegions = new Set(game.regions || []);
    const relevant = ranked.filter(r => gameRegions.has(r.region));
    const pool = relevant.length ? relevant : ranked;
    const best = pool[0];
    const worst = pool[pool.length - 1];

    const reasons = [];
    if (relevant.length) {
        reasons.push(`از میان مناطقی که «${game.fa}» در آن‌ها سرور دارد، بهترین گزینه برای خط شما ${best.fa} است — min ${best.min}ms · p95 ${best.p95}ms · اتلاف ${best.loss}٪.`);
    } else {
        reasons.push(`مناطق سرور این بازی در فهرست ما نبود، پس رتبه‌بندی کلی نشان داده می‌شود: بهترین منطقه برای خط شما ${best.fa} است.`);
    }
    if (pool.length > 1 && worst.score < best.score) {
        reasons.push(`اختلاف با بدترین گزینه (${worst.fa}) در p95 برابر ${worst.p95 - best.p95} میلی‌ثانیه است — و این تفاوت رایگان و فوری به دست می‌آید.`);
    }
    if (hint) reasons.push(`کجا عوضش کنی: ${hint}`);
    else reasons.push('این بازی انتخاب منطقه‌ی دستی ندارد؛ عدد بالا فقط برای اینکه بدانی مسیرت به کجا بهتر است.');

    return { best, hint, hasPicker: !!hint, reasons, considered: pool.length };
}

module.exports.compareRegions = compareRegions;
module.exports.regionAdviceFor = regionAdviceFor;
