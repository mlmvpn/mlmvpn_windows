// --- Live speed and usage, from whichever engine is carrying the traffic ---
//
// The header's live speed, the «ترافیک امروز» widget and the usage monitor all read
// traffic-manager. Until 1.2.2 only two things ever fed it — Xray's stats API (V2Ray, and
// the WARP engines when chained through Xray) and the SNI engine's log markers — so a
// GitHub-tunnel connection, a full-system tunnel to a WARP engine, or the Google Script
// tunnel moved gigabytes while every figure sat at zero. This module is the one place an
// engine reports its bytes. It adds them to the day's usage and pushes the same
// `traffic_update` message the UI has always listened for, so live speed moves too.
//
// TWO KINDS OF SOURCE
//   counter — an engine that can be ASKED for cumulative byte counters (tailscaled, sing-box,
//             the Google Script core). Registered once; read here once a second while it is
//             active. The first reading is a baseline, and a counter that goes backwards
//             (the engine restarted, a daily bucket rolled over) becomes the new baseline —
//             neither is ever counted as traffic.
//   push    — an engine that reports deltas itself (Xray's own poll, SNI's log markers).
//             `immediate` ones (Xray, already once a second) are emitted as they arrive, so
//             live speed keeps their rhythm; the rest are buffered into the next tick.
//
// ONE COUNT PER BYTE
// Engines nest: V2Ray behind the full-system tunnel, Xray behind the SNI front, anything
// inside the GitHub tunnel's kernel adapter. Counting each layer would double the figures, so
// a source that another active source COVERS (carries the same bytes) is not counted; it only
// keeps its baseline current. By default the ranking in PRIORITY decides — the GitHub tunnel
// first, then the engines that count their own traffic, the full-system tunnel last — which
// makes the highest-ranked active source the only one counted.
//
// A source may instead say exactly whom it covers (`covers(other)`), because "outer" depends
// on the moment: the GitHub tunnel carries everything only in its TUNNEL mode — in proxy mode
// a WARP engine beside it moves bytes it never sees — and Xray carries the full-system
// tunnel's bytes only when Xray is the engine behind it; under a WARP engine the Xray that
// stands ready for the system proxy is idle, and letting it win left a WARP tunnel reading
// zero. Sources that cover none of each other are all counted, summed into one update a tick.

const trafficMgr = require('./traffic-manager');

// Psiphon sits with the other engines that count their own bytes. Tor is deliberately absent:
// it has no counter of its own, so a Tor session is counted by 'tun' — see server.js.
// «گیت‌وی MLM» sits with the engines that count their own bytes. It covers nothing and
// nothing covers it: it routes through the SoftEther client's own adapter, so there is no
// inner engine whose traffic it could be counting twice.
const PRIORITY = ['github-tunnel', 'xray', 'gst', 'gateway', 'psiphon', 'sni', 'tun'];
const TICK_MS = 1000;

const sources = new Map();   // name -> { kind, active, read, covers, last, lastAt, buf }
let emitter = null;
let timer = null;
let busy = false;
let wasReporting = false;

function rank(name) {
    const i = PRIORITY.indexOf(name);
    return i < 0 ? PRIORITY.length : i;
}

function setEmitter(fn) { emitter = typeof fn === 'function' ? fn : null; }

/** An engine that can be asked for { up, down } cumulative bytes. */
function registerCounter(name, { active, read, covers }) {
    sources.set(name, { kind: 'counter', active, read, covers: covers || null, last: null, lastAt: 0, buf: null });
}

/** An engine that reports its own deltas through push(). `active` says whether it is on. */
function registerPush(name, { active, immediate = false, covers }) {
    sources.set(name, { kind: 'push', active, immediate, covers: covers || null, read: null, last: null, lastAt: 0, buf: { up: 0, down: 0 } });
}

function isActive(s) {
    try { return !!s.active(); } catch (e) { return false; }
}

/** Does `name` (active) carry the bytes of `other` (active)? */
function covers(name, other) {
    const s = sources.get(name);
    if (s && s.covers) {
        try { return !!s.covers(other); } catch (e) { return false; }
    }
    return rank(name) < rank(other);
}

/** The active sources that no other active source covers — the ones counted now, ranked. */
/**
 * Every source that reports itself active, including ones another source covers.
 *
 * countedNames() answers «whose bytes do we count» and deliberately drops a source that
 * another one carries. The netdiag repair gate is asking a different question — «is anything
 * running at all» — and for that a covered engine still counts.
 */
function activeNames() {
    return [...sources.entries()].filter(([, s]) => isActive(s)).map(([n]) => n);
}

function countedNames() {
    const active = [...sources.entries()].filter(([, s]) => isActive(s)).map(([n]) => n);
    return active
        .filter((n) => !active.some((o) => o !== n && covers(o, n)))
        .sort((a, b) => rank(a) - rank(b));
}

/** The first counted source, or null (kept for callers that ask "who is counting"). */
function winnerName() {
    const c = countedNames();
    return c.length ? c[0] : null;
}

/** Bytes moved since the engine's previous push. */
function push(name, upBytes, downBytes) {
    const s = sources.get(name);
    if (!s || s.kind !== 'push') return;
    const up = Math.max(0, Number(upBytes) || 0);
    const down = Math.max(0, Number(downBytes) || 0);
    if (s.immediate) {
        const now = Date.now();
        const seconds = s.lastAt ? Math.max(0.25, (now - s.lastAt) / 1000) : 1;
        if (!trafficMgr.isEnabled()) { s.lastAt = now; return; }
        const counted = countedNames();
        if (!counted.includes(name)) { s.lastAt = now; return; }
        // Counted alone: report at once, in its own rhythm. Counted beside another engine:
        // gather into the next tick, so one update carries both and live speed does not
        // alternate between two figures.
        if (counted.length === 1) { s.lastAt = now; emit(up, down, seconds); wasReporting = true; return; }
    }
    s.buf.up += up;
    s.buf.down += down;
}

function emit(up, down, seconds) {
    if (up || down) trafficMgr.addTraffic(up, down);
    if (!emitter) return;
    const st = trafficMgr.getTrafficStats();
    try {
        emitter({
            __traffic_update__: true,
            speed: { up: up / seconds, down: down / seconds },
            today: st.today,
            sessionUp: st.sessionUp,
            sessionDown: st.sessionDown,
            totalUp: st.totalUp,
            totalDown: st.totalDown,
            daily: st.daily,
        });
    } catch (e) { /* a broken socket must not stop the counting */ }
}

async function tick() {
    if (busy) return;
    busy = true;
    try {
        // «غیرفعال شدن مانیتورینگ مصرف»: no reads at all, and nothing half-measured is kept.
        if (!trafficMgr.isEnabled()) {
            for (const s of sources.values()) { s.last = null; if (s.buf) s.buf = { up: 0, down: 0 }; }
            wasReporting = false;
            return;
        }

        const now = Date.now();
        const active = [...sources.entries()]
            .filter(([, s]) => isActive(s))
            .sort((a, b) => rank(a[0]) - rank(b[0]));
        const counted = countedNames();

        // Read every active counter, so a covered one keeps a fresh baseline and can take
        // over the moment the engine covering it stops.
        const deltas = new Map();
        for (const [name, s] of active) {
            if (s.kind === 'push') {
                // An immediate source counted alone reported itself (see push()); when it is
                // counted beside another, what it pushed since the last tick is in its buffer.
                if (s.immediate && !(counted.length > 1 && counted.includes(name))) { s.buf = { up: 0, down: 0 }; continue; }
                deltas.set(name, {
                    up: s.buf.up, down: s.buf.down,
                    seconds: s.immediate ? TICK_MS / 1000 : (s.lastAt ? (now - s.lastAt) / 1000 : 1),
                });
                s.buf = { up: 0, down: 0 };
                s.lastAt = now;
                continue;
            }
            let c = null;
            try { c = await s.read(); } catch (e) { c = null; }
            if (!c || !Number.isFinite(c.up) || !Number.isFinite(c.down)) continue;
            if (s.last && c.up >= s.last.up && c.down >= s.last.down) {
                deltas.set(name, { up: c.up - s.last.up, down: c.down - s.last.down, seconds: (now - s.lastAt) / 1000 });
            }
            s.last = c;
            s.lastAt = now;
        }
        // Sources that went quiet start from a fresh baseline next time.
        for (const [name, s] of sources) {
            if (!active.some(([n]) => n === name) && !(s.kind === 'push' && s.immediate)) {
                s.last = null; if (s.buf) s.buf = { up: 0, down: 0 }; s.lastAt = 0;
            }
        }

        // The counted sources' bytes, in one update. A push source with nothing to say this
        // tick still counts as present — its engine is on, it just moved no bytes.
        if (counted.length === 1) {
            const only = sources.get(counted[0]);
            if (only && only.kind === 'push' && only.immediate) return;   // it reports itself
        }
        let up = 0, down = 0, seconds = 0, any = false;
        for (const name of counted) {
            const d = deltas.get(name);
            if (!d) continue;
            any = true;
            up += d.up;
            down += d.down;
            seconds = Math.max(seconds, d.seconds || 0);
        }
        if (any) {
            emit(up, down, Math.max(0.25, seconds || 1));
            wasReporting = true;
        } else if (!counted.length && wasReporting) {
            // Everything stopped: say so once, so live speed does not freeze on its last value.
            emit(0, 0, 1);
            wasReporting = false;
        }
    } finally {
        busy = false;
    }
}

function start() {
    if (timer) return;
    timer = setInterval(tick, TICK_MS);
    if (timer.unref) timer.unref();
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
}

module.exports = { setEmitter, registerCounter, registerPush, push, start, stop, tick, winnerName, countedNames, activeNames, PRIORITY };
