// --- Game acceleration: the button ---
//
// Routes ONE game's traffic through an engine the app already has, and leaves everything
// else on the physical interface. This is architecture option 1 from the research — "a
// route selector over the engines that already exist" — and it is the only accelerator
// that can ship without the user owning a server.
//
// THE RULE THIS MODULE IS BUILT AROUND
// The research measured, on this very line, that routing through an engine usually makes a
// game WORSE: every path out of Iran crosses the same international gateway, so a relay
// adds a hop without removing one. Turning acceleration on by default would therefore harm
// most users, and a "boost" button that quietly costs 30ms is exactly the product this
// project exists not to be.
//
// So: the button is gated on evidence. `evaluate()` looks at what was actually measured
// for this game and this engine and answers one of
//
//   'recommended'  measurement says the engine beats direct — turn it on
//   'neutral'      no measured difference — the user may try it, told plainly
//   'discouraged'  measurement says direct is better — the button warns before proceeding
//   'unmeasured'   nothing has been measured yet — say so, do not guess
//
// The user can always override. What they cannot do is be misled about which case they
// are in.
//
// WHY IT FAILS SAFE
// The TUN config is built with `final: direct` (see tun-manager.buildGameTunConfig), so a
// dead engine costs the game and nothing else. That is the difference between this and the
// full tunnel, and it is why this mode is safe to leave switched on.

'use strict';

const tun = require('../tun-manager');
const catalog = require('./catalog');
const detect = require('./detect');
const probe = require('./probe');
const evidence = require('./evidence');
const engines = require('./engines');

/**
 * The engines this app can route a game through.
 *
 * Only engines that expose a local SOCKS5 listener qualify, because that is the handle
 * sing-box needs. An engine that can only take over the whole machine cannot be used to
 * accelerate one process.
 */
const ENGINES = {
    aether: {
        id: 'aether', fa: 'موتورهای وارپ',
        socksPort: 20810, processName: 'aether.exe',
        why: 'رایگان و همیشه در دسترس. مسیرش از ستون فقرات Cloudflare می‌گذرد.',
    },
    'github-tunnel': {
        id: 'github-tunnel', fa: 'GitHub Tunnel',
        socksPort: 20812, processName: 'tailscaled.exe',
        why: 'WireGuard واقعی، ولی خروجی‌اش روی رانر گیت‌هاب است و منطقه‌اش انتخاب‌شدنی نیست.',
    },
    v2ray: {
        id: 'v2ray', fa: 'نود V2Ray',
        get socksPort() { return require('../xray-manager').getPorts().socks; }, processName: 'xray.exe',
        why: 'اگر نودت UDP واقعی حمل کند. نودهای Cloudflare Worker این کار را نمی‌کنند.',
    },
};

/**
 * An engine id can now be a VARIANT — `aether:wg:balanced`, `v2ray:free:…` — because the
 * tournament ranks variants, not families, and offering the winner has to mean offering
 * exactly what won. Profiles, labels and the three ENGINES entries above still work at the
 * FAMILY level, so everything that reads them maps down first.
 */
function familyOf(engineId) {
    if (!engineId) return 'aether';
    if (engineId.startsWith('aether')) return 'aether';
    if (engineId.startsWith('v2ray')) return 'v2ray';
    if (engineId.startsWith('github-tunnel')) return 'github-tunnel';
    return engineId;
}

/**
 * Turn an id into something startable.
 *
 * Falls back to the family default rather than failing: a saved node that has since been
 * deleted, or a bare `aether` from an older panel build, should still give the user a
 * working button instead of an error about an id they never typed.
 */
function resolveSpec(engineId, { nodes = [], freeNodes = [] } = {}) {
    const spec = engines.parseId(engineId, { nodes, freeNodes });
    if (spec) return spec;
    const family = familyOf(engineId);
    if (family === 'aether') return engines.aetherSpecs({ protocols: ['masque'], scans: ['turbo'] })[0];
    if (family === 'github-tunnel') return engines.githubTunnelSpec();
    if (family === 'v2ray' && nodes.length) return engines.v2raySpec(nodes[0], { source: 'saved', index: 0 });
    return null;
}

let active = null;   // { gameId, engineId, startedAt, procs, ips, startedEngine, spec }

function status() {
    return {
        on: !!active && tun.isRunning(),
        ...(active || {}),
        tunRunning: tun.isRunning(),
    };
}

/**
 * The proof, not the promise.
 *
 * "Your game is going through Aether" is the one claim in this feature the user cannot
 * verify for themselves, so it is backed by sing-box's own per-connection log rather than
 * by our bookkeeping. Scoped to the current session's start time — counting lines from an
 * earlier full-tunnel run would confirm every boost the instant it began.
 */
async function proof() {
    if (!active) {
        return { verdict: 'off', fa: 'شتاب روشن نیست', reasons: [], engine: 0, direct: 0 };
    }
    const running = await detect.runningGames();
    const gameRunning = running.some(r => r.id === active.gameId);
    return {
        ...evidence.summarise({
            // The sing-box outbound is tagged with the FAMILY (`aether`, `v2ray`), not the
            // variant — a tag that changes with the scan mode would make the log unreadable
            // and the parser fragile for no gain.
            engineTag: familyOf(active.engineId),
            sinceMs: active.startedAt,
            gameRunning,
            engineFa: active.engineFa,
        }),
        gameRunning,
    };
}

/**
 * Everything the user may pick, whether or not it is running.
 *
 * This list used to be "engines that are up", which quietly made the panel a status
 * display: if Aether was off, there was nothing to choose and the user was sent to another
 * tab to switch it on. Now the button starts whatever is chosen, so the list is the whole
 * field — six Aether variants, every saved node, the free pool when the caller passes it,
 * and the GitHub Tunnel — with `live` saying which one happens to be up already.
 *
 * `udp` is only knowable for something that is currently listening. For everything else it
 * stays `null`, which the panel must render as "not measured yet", never as a red cross.
 */
async function availableEngines({ probeUdp = true, nodes = [], freeNodes = [] } = {}) {
    const specs = [
        ...engines.aetherSpecs(),
        ...nodes.slice(0, 40).map((n, i) => engines.v2raySpec(n, { source: 'saved', index: i })),
        ...freeNodes.slice(0, 20).map((n, i) => engines.v2raySpec(n, { source: 'free', index: i })),
        engines.githubTunnelSpec(),
    ];

    // One liveness check per PORT, not per variant: the six Aether variants share 20810,
    // and probing it six times would spend six seconds proving the same thing.
    const portState = new Map();
    for (const port of new Set(specs.map(s => s.socksPort))) {
        const live = await portAlive(port);
        let udp = null;
        if (live && probeUdp) {
            // Same reason as in start(): the DNS-on-53 probe reports false for WARP, and a
            // red "no UDP" chip against a perfectly good engine is a lie the user acts on.
            try {
                const anchor = catalog.UDP_ANCHORS[0];
                const screen = await engines.screenUdp({
                    socksPort: port, host: anchor.host,
                    ip: await probe.resolve4(anchor.host), port: anchor.port,
                });
                udp = screen.udp;
            } catch { udp = null; }
        }
        portState.set(port, { live, udp });
    }

    return specs.map(s => {
        const st = portState.get(s.socksPort) || { live: false, udp: null };
        return {
            id: s.id,
            fa: s.fa,
            kind: s.kind,
            source: s.source || null,
            why: s.why,
            exclusive: !!s.exclusive,
            socksPort: s.socksPort,
            // `available: true` now means "we can start it", which is true of everything
            // here — the old meaning (already running) moved to `live`.
            available: true,
            live: st.live,
            udp: st.live ? st.udp : null,
            // Said plainly rather than hidden behind a disabled button: a TCP-only engine
            // can be selected and will simply not help a game that speaks UDP.
            warning: s.exclusive
                ? 'این یکی کل ترافیک سیستم را می‌برد، نه فقط بازی را — UDP فقط در همان حالت دارد.'
                : (st.live && st.udp === false
                    ? 'این موتور UDP حمل نمی‌کند. برای بازی‌هایی که روی UDP کار می‌کنند (تقریباً همه) بی‌فایده است.'
                    : null),
        };
    });
}

function portAlive(port, timeoutMs = 1200) {
    const net = require('net');
    return new Promise(resolve => {
        const s = new net.Socket();
        let done = false;
        const fin = v => { if (done) return; done = true; try { s.destroy(); } catch {}; resolve(v); };
        s.setTimeout(timeoutMs, () => fin(false));
        s.once('error', () => fin(false));
        s.connect(port, '127.0.0.1', () => fin(true));
    });
}

/**
 * Should this engine be used for this game?
 *
 * Reads the profile store rather than measuring again — the whole point of storing
 * profiles was so this question could be answered instantly. Never guesses: with no data
 * the answer is 'unmeasured', which the UI is required to show as such.
 */
function evaluate(gameId, engineId, profiles) {
    // Profiles are keyed by family: a measurement of Aether-MASQUE-turbo is still evidence
    // about Aether, and splitting the store six ways would leave every variant unmeasured
    // forever. The tournament is where variants are compared against each other.
    const family = familyOf(engineId);
    const rows = profiles.forGame(gameId);
    if (!rows.length) {
        return {
            verdict: 'unmeasured',
            fa: 'هنوز اندازه‌گیری نشده',
            reasons: ['برای این بازی هنوز سنجشی ذخیره نشده. اول «شروع سنجش» را بزن تا معلوم شود این موتور کمک می‌کند یا نه.'],
        };
    }

    // The most recent row that saw both a direct path and this engine.
    let direct = null, viaEngine = null;
    for (const row of rows) {
        for (const [pathKey, v] of Object.entries(row.paths || {})) {
            if (pathKey === 'direct' || pathKey.startsWith('direct:')) {
                if (!direct || v.score > direct.score) direct = v;
            }
            if (pathKey === 'engine:' + family) {
                if (!viaEngine || v.score > viaEngine.score) viaEngine = v;
            }
        }
    }

    if (!viaEngine) {
        return {
            verdict: 'unmeasured',
            fa: 'این موتور سنجیده نشده',
            reasons: [
                `مسیر مستقیم سنجیده شده ولی «${(ENGINES[family] || {}).fa || family}» نه.`,
                'یک «مسابقه‌ی موتورها» بگیر — خودش موتورها را روشن و خاموش می‌کند و مقایسه‌ی واقعی می‌دهد.',
            ],
        };
    }
    if (!direct) {
        return { verdict: 'neutral', fa: 'مقایسه ناقص', reasons: ['مسیر مستقیم در پروفایل‌ها نیست، پس مقایسه‌ای ممکن نیست.'] };
    }

    const d = viaEngine.score - direct.score;
    if (d >= 8) {
        return {
            verdict: 'recommended', fa: 'اندازه‌گیری می‌گوید کمک می‌کند',
            reasons: [
                `از داخل این موتور: min ${viaEngine.min}ms · p95 ${viaEngine.p95}ms · اتلاف ${viaEngine.loss}٪ (امتیاز ${viaEngine.score}).`,
                `مستقیم: min ${direct.min}ms · p95 ${direct.p95}ms · اتلاف ${direct.loss}٪ (امتیاز ${direct.score}).`,
            ],
        };
    }
    if (d <= -8) {
        return {
            verdict: 'discouraged', fa: 'اندازه‌گیری می‌گوید بدترش می‌کند',
            reasons: [
                `مستقیم امتیاز ${direct.score} گرفت و از داخل این موتور ${viaEngine.score}.`,
                `p95 مستقیم ${direct.p95}ms در برابر ${viaEngine.p95}ms از داخل موتور.`,
                'روشن کردنش احتمالاً بازی را بدتر می‌کند. اگر باز هم می‌خواهی امتحان کنی، آزادی — ولی این را بدان.',
            ],
        };
    }
    return {
        verdict: 'neutral', fa: 'تفاوت معناداری دیده نشد',
        reasons: [
            `امتیاز مستقیم ${direct.score} و از داخل موتور ${viaEngine.score} — اختلاف در حد نویز.`,
            'اگر مشکل تو NAT یا فیلتر شدن ترافیک بازی است، موتور باز هم می‌تواند مفید باشد؛ اگر مشکل پینگ است، نه.',
        ],
    };
}

/**
 * Turn acceleration on.
 *
 * `force` is required to proceed against a 'discouraged' verdict, so the harmful case can
 * only be reached deliberately.
 *
 * IT STARTS THE ENGINE ITSELF. The old version refused with "turn the engine on first",
 * which meant the player had to leave the game tab, find the right panel, pick a protocol
 * that may not have been the one measured, and come back. `drivers` is server.js's engine
 * lifecycle; when it is not supplied (an older caller) the behaviour falls back to the old
 * refusal rather than pretending.
 */
async function start({
    gameId, engineId = 'aether', force = false, profiles, onLog = () => {},
    drivers = null, nodes = [], freeNodes = [],
}) {
    if (active) throw new Error('شتاب بازی از قبل روشن است.');
    const spec = resolveSpec(engineId, { nodes, freeNodes });
    if (!spec) throw new Error('این موتور شناخته نشد.');
    const family = familyOf(spec.id);
    const engine = ENGINES[family];
    if (!engine) throw new Error('این موتور شناخته نشد.');

    const game = catalog.byId(gameId);
    if (!game) throw new Error('این بازی در کاتالوگ نیست.');

    // A game we cannot name a process for cannot be routed by process, and routing it by
    // address alone would need server IPs we do not have. Refuse rather than start a TUN
    // that accelerates nothing.
    const procs = (game.procs || []).filter(p => !p.endsWith('*'));
    const wildcards = (game.procs || []).filter(p => p.endsWith('*'));
    if (!procs.length && !wildcards.length) throw new Error('برای این بازی نام پراسسی ثبت نشده است.');

    const evalr = evaluate(gameId, engineId, profiles);
    if (evalr.verdict === 'discouraged' && !force) {
        const err = new Error('اندازه‌گیری می‌گوید این موتور بازی را بدتر می‌کند.');
        err.needsForce = true;
        err.evaluation = evalr;
        throw err;
    }

    // ── bring the engine up ──────────────────────────────────────────────────────
    // Whether it was already running or not, the user pressed one button and expects one
    // outcome. `ensure` restarts Aether when the requested variant is not the one that
    // happens to be up, because accelerating through `wg` while the panel says `masque` is
    // a lie the player has no way to catch.
    let startedEngine = false;
    if (!(await portAlive(spec.socksPort))) {
        if (!drivers) {
            throw new Error(`${spec.fa} روشن نیست (پورت ${spec.socksPort} خالی است). اول موتور را وصل کن.`);
        }
        onLog(`[GAME] ${spec.fa} روشن نیست — خودم روشنش می‌کنم…`);
        const r = await engines.ensure(spec, drivers, { log: onLog });
        startedEngine = r.started;
    } else if (drivers && spec.kind === 'aether') {
        // Something is listening on Aether's port, but nothing here knows which protocol it
        // is unless this module started it. Re-assert the requested variant.
        const cur = engines.running();
        if (!cur || cur.specId !== spec.id) {
            onLog(`[GAME] موتور ${spec.fa} بالا می‌آید…`);
            const r = await engines.ensure(spec, drivers, { log: onLog });
            startedEngine = r.started;
        }
    }

    // The GitHub Tunnel is not a per-game accelerator and never can be: it carries UDP only
    // in full-tunnel mode, where it owns the machine's route and there is no SOCKS listener
    // for sing-box to point a process rule at. So there is no game TUN to build — the whole
    // machine is already going through it, and the game rides along with everything else.
    if (spec.exclusive) {
        active = {
            gameId, gameFa: game.fa, engineId: spec.id, engineFa: spec.fa,
            startedAt: Date.now(), procs: [], ips: [], udp: true,
            exclusive: true, startedEngine, evaluation: evalr,
        };
        onLog('[GAME] تونل GitHub روشن است — کل ترافیک سیستم (از جمله بازی) از آن می‌رود.');
        return status();
    }

    // sing-box matches process_name against the executable name, so the wildcard entries
    // in the catalogue (FiveM's per-build name) have to be resolved to what is actually
    // running before the config is written.
    const runningNow = await detect.processes();
    const expanded = new Set(procs);
    for (const w of wildcards) {
        const pre = w.slice(0, -1).toLowerCase();
        for (const p of runningNow) if (p.name.toLowerCase().startsWith(pre)) expanded.add(p.name);
    }

    // Whatever destinations the game is already talking to, matched by address as well —
    // this is the fallback for when Windows refuses the process lookup.
    let gameIps = [];
    const mine = (await detect.runningGames()).find(r => r.id === gameId);
    if (mine) {
        try {
            const ep = await detect.endpointsFor(mine.pids);
            gameIps = [...new Set((ep.tcp || []).map(e => e.ip))].slice(0, 12);
        } catch { /* not fatal — the process rule is the primary path */ }
    }

    // NOT tun.socksCarriesUdp(): it asks by querying DNS on port 53, and WARP swallows
    // UDP/53 while carrying every other UDP port perfectly — measured. Answering "false"
    // here is not cosmetic: `supportsUdp` decides whether the game TUN gets its UDP rule at
    // all, so the wrong answer builds a tunnel that drops exactly the traffic a game sends.
    // The STUN screen asks with the traffic that matters. See engines.screenUdp.
    let udp = false;
    try {
        const anchor = catalog.UDP_ANCHORS[0];
        const screen = await engines.screenUdp({
            socksPort: spec.socksPort, host: anchor.host,
            ip: await probe.resolve4(anchor.host), port: anchor.port,
        });
        udp = !!screen.udp;
        if (!udp) onLog(`[GAME] هشدار: ${screen.reason}`);
    } catch { udp = false; }

    onLog(`[GAME] شتاب «${game.fa}» از طریق ${spec.fa}`);
    try {
        await tun.startTun(spec.socksPort, onLog, {
            mode: 'game',
            processName: engine.processName,
            engineLabel: spec.fa,
            // Family, not variant — see proof() above.
            engineTag: family,
            supportsUdp: udp,
            gameProcesses: [...expanded],
            gameIps,
            // Aether's static Cloudflare exclusions are meaningless for the other engines,
            // and handing them someone else's uplink list would push a slice of the
            // ordinary web out of a tunnel it was never in. Only Aether gets the defaults.
            uplinkCidrs: family === 'aether' ? undefined : [],
            stack: 'gvisor',
            // 'info', not the usual 'warn'. sing-box logs one line per connection naming
            // the outbound it chose, and that line is the ONLY proof that the process rule
            // actually matched — at 'warn' the log holds nothing but errors and the user is
            // left taking our word for it. See game/evidence.js, which reads those lines.
            logLevel: 'info',
        });
    } catch (err) {
        // The TUN failed, so nothing is accelerated — and an engine this function switched
        // on would otherwise be left running with no feature using it, quietly rerouting
        // nothing and confusing the next thing that asks who owns the adapter.
        await engines.release(spec, drivers, { started: startedEngine, log: onLog });
        throw err;
    }

    active = {
        gameId, gameFa: game.fa, engineId: spec.id, engineFa: spec.fa,
        startedAt: Date.now(), procs: [...expanded], ips: gameIps, udp,
        exclusive: false, startedEngine, evaluation: evalr,
    };
    onLog(`[GAME] فعال شد — فقط ${[...expanded].join('، ')} از موتور می‌رود، بقیه‌ی سیستم مستقیم.`);
    return status();
}

/**
 * Turn it off, and put back whatever this module switched on.
 *
 * `startedEngine` is the whole reason the flag is recorded: an engine the user had running
 * before they pressed the button stays running, and one that only exists because of the
 * button goes away with it. Anything else surprises somebody.
 */
async function stop(onLog = () => {}, drivers = null) {
    const was = active;
    if (tun.isRunning()) {
        onLog('[GAME] خاموش کردن شتاب بازی');
        tun.stopTun(onLog);
        await tun.verifyTornDown(onLog);
    }
    active = null;
    if (was && was.startedEngine && drivers) {
        const spec = resolveSpec(was.engineId) || { kind: familyOf(was.engineId), id: was.engineId, fa: was.engineFa };
        await engines.release(spec, drivers, { started: true, log: onLog });
    }
    return status();
}

module.exports = { ENGINES, status, proof, availableEngines, evaluate, start, stop, familyOf, resolveSpec };
