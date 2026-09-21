'use strict';

/**
 * «کدام روش روی خط من کار می‌کند؟» — every engine, measured for real, at the same time.
 *
 * The question this answers is the one a stuck user actually has, and the app could not answer it:
 * on any given line some engines work and some do not, and finding out meant trying them one at a
 * time. Most people will not.
 *
 * ── Why it is parallel, and why that is the whole design ──────────────────────────────────────
 *
 * Measured on this line, the honest cost of connecting each engine ONCE:
 *
 *     تور, cold cache ......... 337 s
 *     لنترن, new profile ...... up to 214 s
 *     سایفون, full ladder ..... up to 180 s
 *
 * Run in sequence that is over ten minutes, which is not a button. But these engines do not share
 * anything: each is its own process on its own loopback port (سایفون 20830, تور 20820, لنترن 20840),
 * and none of them touches system routing while it is only publishing a proxy. So they can all be up
 * at once, and the sweep costs the SLOWEST one rather than the sum — under a minute for everything
 * except a cold Tor, which streams in late on its own.
 *
 * The two exceptions are handled rather than ignored:
 *
 *   • `aether-manager` keeps ONE module-level state (`currentState`), and `startAether` begins by
 *     calling `stopAether`. So ماسک/وایرگارد/وارپ‌در‌وارپ are a SERIAL lane — and if one of them is
 *     already live, that whole lane is skipped, because testing it would tear down the user's own
 *     connection.
 *   • «گیت‌وی MLM» routes the machine through the SoftEther client's own adapter, so connecting it
 *     is not a test, it is a takeover. It is measured for REACHABILITY only and never started.
 *
 * ── Why every result is real ─────────────────────────────────────────────────────────────────
 *
 * Nothing here is inferred from a ping or a port scan. Every engine is actually brought up and then
 * asked to carry a stream, with its own prover — the same one its panel uses before it will say
 * "connected". A port that opens is not an engine that works; this app has been bitten by that
 * three times (Lantern answers SOCKS "success" before it dials at all).
 *
 * The one thing this deliberately does NOT report is SPEED. Ten tunnels sharing one line all
 * measure slow, and a wrong number is worse than no number. Speed belongs to whichever engine the
 * user then connects, alone.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const psiphon = require('./psiphon-manager');
const torEngine = require('./tor-manager');
const lantern = require('./lantern-manager');
const gateway = require('./gateway-manager');
const aether = require('./aether-manager');

// ── Budgets ────────────────────────────────────────────────────────────────
//
// Per engine, and generous rather than tight: a budget shorter than the handshake reports a working
// engine as broken, which is the single most expensive kind of wrong answer here. These come from
// measured connects, not from taste.
const BUDGET = {
    psiphon: 70_000,     // rung A alone is a 60 s budget in the ladder
    tor_warm: 45_000,    // measured 7 s on a warm cache; 45 covers a bad day
    tor_cold: 420_000,   // measured 337 s, once, and only on a first ever run
    lantern: 60_000,     // measured 15 s typical, 214 s worst — see lantern-manager
    aether: 90_000,      // per protocol, and the gateway scan inside it owns most of that
    gateway: 20_000,     // a TCP sweep over the relay list, nothing is started
};

/** Tor's consensus cache is the difference between 7 seconds and 337. */
function torCacheIsWarm() {
    try {
        return fs.existsSync(path.join(os.homedir(), '.mlmvpn', 'tor', 'cached-microdesc-consensus'));
    } catch (e) { return false; }
}

/** Resolve after `ms`, or when `p` settles — whichever comes first. Never rejects. */
function within(p, ms) {
    return new Promise((resolve) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, ms);
        Promise.resolve(p).then(
            (v) => { if (!done) { done = true; clearTimeout(t); resolve({ value: v }); } },
            (e) => { if (!done) { done = true; clearTimeout(t); resolve({ error: e }); } },
        );
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Wait for an engine's own data-path prover to say yes, inside a budget.
 *
 * `carries` is the engine's own function — psiphon.socksCarriesStream and friends — because each
 * one knows what proof means for its own core, and re-implementing that here would be a second
 * definition of "connected" to drift from the first.
 */
async function waitForData(carries, budgetMs, isAborted) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (isAborted()) return false;
        const left = deadline - Date.now();
        if (await carries(Math.min(12_000, Math.max(2_000, left)))) return true;
        if (Date.now() >= deadline) break;
        await sleep(1500);
    }
    return false;
}

// ── The engines that are their own process ─────────────────────────────────

/**
 * One SOCKS-front engine, brought up for real and then proven.
 *
 * The three rules that keep this from being destructive are all here:
 *   – an engine that is ALREADY connected is reported, not restarted;
 *   – an engine that is already starting is left alone, because killing it would cancel whatever
 *     the user themselves just clicked;
 *   – an engine this sweep started is stopped again afterwards, and one it found running is not.
 */
function frontProbe({ id, group, title, mgr, start, budget, extra }) {
    return async ({ log, isAborted, emit }) => {
        const t0 = Date.now();
        const say = (o) => emit(Object.assign({ id, group, title, ms: Date.now() - t0 }, o));

        if (!mgr.isInstalled()) {
            return say({ ok: false, reason: 'فایل موتور نصب نیست', skipped: true });
        }

        let status = {};
        try { status = mgr.getStatus() || {}; } catch (e) { /* treat as idle */ }

        if (status.connected) {
            return say({ ok: true, reason: 'همین حالا وصل است', untouched: true });
        }
        if (status.running) {
            return say({ ok: false, reason: 'همین حالا در حال اتصال است — دست نخورد', skipped: true, untouched: true });
        }

        let started = false;
        try {
            log(`[جارو] ${title}: شروع`);
            const r = await within(start({ log }), budget);
            if (r.error) {
                return say({ ok: false, reason: r.error.message || 'بالا نیامد' });
            }
            started = true;
            if (isAborted()) return say({ ok: false, reason: 'لغو شد', skipped: true });

            const left = Math.max(5_000, budget - (Date.now() - t0));
            const ok = await waitForData((ms) => mgr.socksCarriesStream(ms), left, isAborted);
            const det = extra ? extra(mgr) : null;
            return say(ok
                ? { ok: true, reason: 'ترافیک رد شد', detail: det }
                : { ok: false, reason: (det && det.blocked) || 'بالا آمد ولی ترافیکی رد نکرد', detail: det });
        } catch (e) {
            return say({ ok: false, reason: e.message || 'خطا' });
        } finally {
            // Only what this sweep started. An engine the user had running is never stopped.
            if (started) { try { mgr[`stop${id[0].toUpperCase()}${id.slice(1)}`](); } catch (e) { /* already down */ } }
        }
    };
}

const probePsiphon = frontProbe({
    id: 'psiphon', group: 'موتورها', title: 'سایفون', mgr: psiphon, budget: BUDGET.psiphon,
    // Rung A only. The full ladder is up to 180 s and the other two rungs are direct-address
    // strategies that a line blocking rung A has almost certainly blocked too; what the user needs
    // to know is whether Psiphon can work here at all, and A is the rung that answers that.
    start: ({ log }) => psiphon.startPsiphon({ rung: 'A' }, log, () => { }),
    extra: (m) => { const s = m.getStatus(); return { rung: s.rung, protocol: s.protocol, exit: s.egressRegion }; },
});

const probeLantern = frontProbe({
    id: 'lantern', group: 'موتورها', title: 'لنترن', mgr: lantern, budget: BUDGET.lantern,
    start: ({ log }) => lantern.startLantern({}, log, () => { }),
    extra: (m) => {
        const s = m.getStatus();
        return { exit: s.egressRegion, blocked: s.blocked ? 'سرورهایش از این خط بسته‌اند' : null };
    },
});

const probeTor = frontProbe({
    id: 'tor', group: 'موتورها', title: 'تور', mgr: torEngine,
    budget: torCacheIsWarm() ? BUDGET.tor_warm : BUDGET.tor_cold,
    start: ({ log }) => torEngine.startTor({ mode: 'auto' }, log, () => { }),
    extra: (m) => { const s = m.getStatus(); return { mode: s.mode || s.detail }; },
});

// ── The WARP engines: one at a time, and only if none of them is live ──────

/**
 * ماسک / وایرگارد / وارپ در وارپ, in sequence.
 *
 * Serial because `aether-manager` holds a single `currentState` and `startAether` stops whatever
 * is running before it starts — so two at once is not "slower", it is "each one kills the last".
 * And for exactly that reason the whole lane is skipped when one of them is already up: the first
 * probe would disconnect the user.
 */
const WARP_ENGINES = [
    { id: 'masque', title: 'ماسک', proto: 'masque' },
    { id: 'wireguard', title: 'وایرگارد', proto: 'wireguard' },
    { id: 'warp_on_warp', title: 'وارپ در وارپ', proto: 'warp_on_warp' },
];

async function warpLane({ log, isAborted, emit }) {
    const group = 'موتورها';

    let live = null;
    try { const s = aether.getStatus(); if (s && (s.connected || s.running)) live = s; } catch (e) { /* idle */ }
    if (live) {
        // Name nothing we cannot prove: the status says which protocol owns the engine.
        for (const e of WARP_ENGINES) {
            emit({
                id: e.id, group, title: e.title, ok: false, ms: 0, skipped: true, untouched: true,
                reason: 'یکی از این سه همین حالا روشن است — برای سنجش باید قطعش کند، پس دست نخورد',
            });
        }
        return;
    }

    if (!aether.isInstalled()) {
        for (const e of WARP_ENGINES) {
            emit({ id: e.id, group, title: e.title, ok: false, ms: 0, skipped: true, reason: 'فایل موتور نصب نیست' });
        }
        return;
    }

    for (const e of WARP_ENGINES) {
        if (isAborted()) {
            emit({ id: e.id, group, title: e.title, ok: false, ms: 0, skipped: true, reason: 'لغو شد' });
            continue;
        }
        const t0 = Date.now();
        try {
            log(`[جارو] ${e.title}: شروع`);
            const r = await within(aether.startAether({ proto: e.proto }, log, () => { }), BUDGET.aether);
            if (r.error) {
                emit({ id: e.id, group, title: e.title, ok: false, ms: Date.now() - t0, reason: r.error.message || 'بالا نیامد' });
                continue;
            }
            const left = Math.max(5_000, BUDGET.aether - (Date.now() - t0));
            const ok = await waitForData((ms) => socksCarries(aether.SOCKS_PORT, ms), left, isAborted);
            const s = (() => { try { return aether.getStatus() || {}; } catch (x) { return {}; } })();
            emit({
                id: e.id, group, title: e.title, ok, ms: Date.now() - t0,
                reason: ok ? 'ترافیک رد شد' : (s.stageFa || 'بالا آمد ولی ترافیکی رد نکرد'),
                detail: { transport: s.transport || s.proto || null },
            });
        } catch (err) {
            emit({ id: e.id, group, title: e.title, ok: false, ms: Date.now() - t0, reason: err.message || 'خطا' });
        } finally {
            try { aether.stopAether(); } catch (x) { /* already down */ }
            await sleep(800);   // let the port actually come free before the next one binds it
        }
    }
}

/**
 * A generic "does this SOCKS port carry a stream" for engines that do not ship their own prover.
 *
 * A full CONNECT to a DNS-poisoned host and then a real TLS handshake: the reply alone proves
 * nothing (Lantern answers success before it dials), and an unpoisoned host would pass even on a
 * connection that only reaches Iranian addresses.
 */
function socksCarries(port, timeoutMs = 12_000) {
    const HOST = 'www.youtube.com';
    return new Promise((resolve) => {
        const tls = require('tls');
        const sock = new net.Socket();
        let stage = 0, done = false, secure = null;
        const end = (ok) => {
            if (done) return;
            done = true;
            try { if (secure) secure.destroy(); } catch (e) { }
            try { sock.destroy(); } catch (e) { }
            resolve(ok);
        };
        sock.setTimeout(timeoutMs, () => end(false));
        sock.on('error', () => end(false));
        sock.on('close', () => end(false));
        sock.connect(port, '127.0.0.1', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
        sock.on('data', (d) => {
            if (stage === 0) {
                if (d[0] !== 0x05 || d[1] !== 0x00) return end(false);
                stage = 1;
                const h = Buffer.from(HOST, 'utf8');
                return sock.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([0x01, 0xBB]),
                ]));
            }
            if (stage === 1) {
                if (d[0] !== 0x05 || d[1] !== 0x00) return end(false);
                stage = 2;
                sock.removeAllListeners('data');
                sock.setTimeout(0);
                secure = tls.connect({ socket: sock, servername: HOST, rejectUnauthorized: false });
                secure.setTimeout(timeoutMs, () => end(false));
                secure.on('secureConnect', () => end(true));
                secure.on('error', () => end(false));
                secure.on('close', () => end(false));
            }
        });
    });
}

// ── «گیت‌وی MLM»: reachability only, by decision ───────────────────────────

/**
 * The relay list, TCP-probed. Nothing is started.
 *
 * Connecting the gateway routes the whole machine through the SoftEther client's own adapter, so a
 * "test" would be a takeover — and this was an explicit product decision, not a shortcut. What CAN
 * be answered honestly without connecting is whether its relays are reachable at all, which on this
 * line is the thing that actually varies: eight of the fastest advertised relays were measured
 * completely closed while every official one answered.
 */
async function gatewayLane({ log, isAborted, emit }) {
    const t0 = Date.now();
    const base = { id: 'gateway', group: 'موتورها', title: 'گیت‌وی MLM' };
    const say = (o) => emit(Object.assign({ ms: Date.now() - t0 }, base, o));
    try {
        if (!gateway.isInstalled()) return say({ ok: false, skipped: true, reason: 'کلاینت سافت‌اتر نصب نیست' });
        try { if (gateway.getStatus().connected) return say({ ok: true, reason: 'همین حالا وصل است', untouched: true }); } catch (e) { }

        const list = gateway.servers();
        const rows = (list.rows || []);
        if (!rows.length) return say({ ok: false, reason: 'فهرست سروری ندارد' });

        // The official relays first: they are the ones that answered when the advertised-fast ones
        // did not, so a sample that leads with them answers the question soonest.
        const sample = rows.filter(r => r.official).concat(rows.filter(r => !r.official)).slice(0, 24);
        log(`[جارو] گیت‌وی: سنجش ${sample.length} رله`);
        const r = await within(gateway.measure(sample, { concurrency: 12, timeoutMs: 4000 }), BUDGET.gateway);
        if (r.error) return say({ ok: false, reason: r.error.message || 'سنجش نشد' });
        if (r.timedOut) return say({ ok: false, reason: 'سنجش در زمان مقرر تمام نشد' });

        // A Map of host -> ms, and 0 means it never answered — `tcpPing`'s own convention.
        const map = r.value instanceof Map ? r.value : new Map();
        const alive = sample.map(x => ({ host: x.host, ms: map.get(x.host) || 0 })).filter(x => x.ms > 0);
        if (!alive.length) {
            return say({ ok: false, reason: `هیچ‌کدام از ${sample.length} رله جواب نداد` });
        }
        alive.sort((a, b) => a.ms - b.ms);
        return say({
            ok: true,
            reason: `${alive.length} رله از ${sample.length} در دسترس‌اند`,
            // Said plainly, because it is the one row in this list that was not actually connected.
            detail: { reachOnly: true, best: alive[0].ms, host: alive[0].host },
        });
    } catch (e) {
        return say({ ok: false, reason: e.message || 'خطا' });
    }
}

// ── Everything that is an Xray config ──────────────────────────────────────

/**
 * کانفیگ ایران, دامین فرانتینگ, SNI, اتصال سریع and the user's own V2Ray nodes.
 *
 * All of these are ultimately an Xray outbound, and the app already has the right harness for
 * measuring a pile of those: `xray-tester.testNodes` reserves a FREE loopback port per node
 * (bind-probed, not assumed — one busy port used to kill an entire batch) and runs them in
 * parallel. So this lane is a delegation, not a second implementation.
 *
 * The caller supplies the list, because the generators for these live in the panels themselves
 * (`IRAN_PROFILES`, the SNI builder, the fronting panel's own config). Re-deriving them here would
 * be a second copy to drift from the first.
 */
async function xrayLane({ nodes, log, isAborted, emit }) {
    if (!nodes || !nodes.length) return;
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const t0 = Date.now();
    log(`[جارو] کانفیگ‌ها: ${nodes.length} مورد، موازی`);
    try {
        await require('./xray-tester').testNodes({
            nodes: nodes.map(n => ({ id: String(n.id), uri: n.uri })),
            testType: 'delay',
            isAborted,
            log: () => { },
            onResult: (r) => {
                const n = byId.get(String(r.id)) || {};
                const ok = Number(r.val) > 0;
                emit({
                    id: n.id, group: n.group || 'کانفیگ‌ها', title: n.title || String(n.id),
                    ok, ms: ok ? Number(r.val) : (Date.now() - t0),
                    reason: ok ? `پاسخ در ${Math.round(Number(r.val))} میلی‌ثانیه` : (r.reason || 'جواب نداد'),
                    detail: { latency: ok ? Math.round(Number(r.val)) : null },
                });
            },
        });
    } catch (e) {
        // One harness failure must not swallow the whole list: say it against every node that has
        // not reported yet, rather than leaving them spinning for ever.
        for (const n of nodes) {
            emit({ id: n.id, group: n.group || 'کانفیگ‌ها', title: n.title, ok: false, ms: 0, reason: e.message || 'سنجش نشد' });
        }
    }
}

// ── The sweep ──────────────────────────────────────────────────────────────

/**
 * @param targets.fronts   ['psiphon','tor','lantern']
 * @param targets.warp     true to include the three WARP engines
 * @param targets.gateway  true to include the gateway's reachability
 * @param targets.nodes    [{ id, group, title, uri }] — every Xray-shaped thing
 */
async function sweep({ targets = {}, onResult = () => { }, isAborted = () => false, log = () => { } } = {}) {
    const results = [];
    const emit = (r) => {
        const row = Object.assign({ at: Date.now() }, r);
        results.push(row);
        try { onResult(row); } catch (e) { /* the UI went away */ }
    };

    const lanes = [];
    const want = (id) => !Array.isArray(targets.fronts) || targets.fronts.includes(id);

    if (want('psiphon')) lanes.push(probePsiphon({ log, isAborted, emit }));
    if (want('lantern')) lanes.push(probeLantern({ log, isAborted, emit }));
    if (want('tor')) lanes.push(probeTor({ log, isAborted, emit }));
    if (targets.warp !== false) lanes.push(warpLane({ log, isAborted, emit }));
    if (targets.gateway !== false) lanes.push(gatewayLane({ log, isAborted, emit }));
    if (targets.nodes && targets.nodes.length) lanes.push(xrayLane({ nodes: targets.nodes, log, isAborted, emit }));

    // allSettled, not all: one lane throwing must not cancel the others, or a single bad engine
    // would take the whole answer down with it.
    await Promise.allSettled(lanes);
    return { results };
}

/** What a sweep WOULD cost, so the panel can say it before the user commits to waiting. */
function estimate(targets = {}) {
    const warm = torCacheIsWarm();
    const warpCount = targets.warp === false ? 0 : WARP_ENGINES.length;
    // The slowest LANE, because they run together — not the sum, which is what makes this a button.
    const slowest = Math.max(
        BUDGET.psiphon,
        BUDGET.lantern,
        warm ? BUDGET.tor_warm : BUDGET.tor_cold,
        warpCount * BUDGET.aether,
        BUDGET.gateway,
    );
    return { seconds: Math.round(slowest / 1000), torCold: !warm };
}

module.exports = {
    sweep, estimate, torCacheIsWarm,
    WARP_ENGINES, BUDGET,
    _internal: { socksCarries, waitForData, within, gatewayLane, xrayLane, warpLane },
};
