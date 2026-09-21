'use strict';

/**
 * The guard for the SOCKS-front engines — سایفون، تور، لنترن، گف.
 *
 * ## Why this file exists
 *
 * Three tunnel arrangements ship in this app and until now only two of them were watched:
 *
 *   · **وارپ family** (`aether.exe`) — a full 5-second watchdog in server.js, with a kill switch
 *     and a re-arm path.
 *   · **V2Ray** (`xray.exe`) — `v2rayTunStartGuard`, single-purpose but real.
 *   · **the four SOCKS fronts** — NOTHING. Not one timer, not one health check.
 *
 * What that means in practice, and it is the whole of «وصل می‌شود بعد قطع می‌شود»: the engine
 * publishes a SOCKS port, sing-box takes the machine's default route and points it at that port,
 * and from that moment on nobody ever asks again whether anything is behind it. When the core
 * loses its tunnel — or exits, which psiphon-tunnel-core's ConsoleClient does by itself once
 * `EstablishTunnelTimeoutSeconds` passes with no tunnel — the adapter stays up, the default route
 * stays on it, the switch in the UI stays green, and every packet on the machine is handed to a
 * listener that is not there. The user is offline AND cannot open a page to find out why.
 *
 * ## What it does, and deliberately does not do
 *
 * It **records**, always. Every transition goes into the same `~/.mlmvpn/tunnel-events.log` the
 * TUN layer writes to, so one file, read top to bottom, tells the whole story of a session:
 * sing-box's start/ready/stop lines and the engine's own connect/drop lines interleaved on one
 * timeline. Two files with two formats is how the last round of this question went unanswered.
 *
 * It **acts** in exactly one case: the engine's port is gone for three consecutive ticks while
 * the adapter still holds the default route. That is the black hole above, nothing recovers from
 * it on its own, and tearing the adapter down puts the machine back on its normal routing —
 * un-tunnelled, but online and able to say so.
 *
 * It does **not** act on a core that merely reports "no tunnel right now". Psiphon re-establishes
 * by itself and usually wins; a guard that tore the tunnel down on the first bad second would be
 * the flap it is supposed to diagnose.
 *
 * ## The leak check that costs nothing
 *
 * Both sides already count bytes: sing-box's clash API counts what entered the adapter, and each
 * engine counts what crossed its own tunnel. Reading both and comparing them is free, and the
 * comparison is a real leak detector — bytes that entered the adapter and never reached the
 * engine left through some other outbound. That is precisely the failure an empty rule condition
 * produces (see the `direct` passthrough in tun-manager's rule builder), and it is invisible to
 * every other check in this app because the tunnel is up, the route is ours and the engine is
 * healthy the entire time.
 */

const net = require('net');

const TICK_MS = 5000;
// Three misses, not one, and for the same reason the V2Ray guard uses three: this check runs in
// Electron's MAIN thread, so a loopback connect can time out because the thread was busy parsing
// an engine's log rather than because anything died. A tunnel torn down by the app's own load is
// indistinguishable, from the outside, from the flap being investigated.
const GONE_MISSES = 3;
// A minute of byte totals per summary line. Short enough to see a slow stretch, long enough that
// a day of ordinary use stays readable by eye.
const SUMMARY_MS = 60_000;
// Bytes that entered the adapter but never reached the engine, per summary window, before it is
// worth a line. One megabyte, because small numbers are ordinary: the clash API counts the
// connection's own framing and a few probes of our own also cross the adapter.
const LEAK_BYTES = 1_000_000;
// How long the engine may report "carrying nothing" before it is called a drop rather than a
// pause. The core emits `Tunnels {"count":0}` for a moment during its own reconnects.
const DROP_GRACE_MS = 8000;
// How many times the engine may be brought back automatically in one session, and how long to
// wait between tries. Bounded, because an engine that dies the moment it starts would otherwise
// be respawned for ever — and each attempt costs the user a minute of a closed machine.
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = [0, 5000, 15000];

/**
 * Is the engine's SOCKS5 server actually SERVING — asked without making it complain.
 *
 * A bare connect-and-hang-up is the obvious check and it is the wrong one, twice over.
 *
 * It proves less: something is bound to the port. The engine can be mid-shutdown, or another
 * process can have taken the port, and a plain accept still succeeds.
 *
 * And it POISONS THE LOG IT IS SUPPOSED TO HELP READ. Measured here the first time this guard
 * ran against the real سایفون core, one line per tick, for the whole session:
 *
 *     08:40:06  Warning  SOCKS proxy accept error: AcceptSocks: socksPeekByte() failed: EOF
 *     08:40:11  Warning  SOCKS proxy accept error: AcceptSocks: socksPeekByte() failed: EOF
 *     08:40:16  …every five seconds, exactly
 *
 * The core accepted the connection, went to read the first byte of the greeting, and got EOF
 * because we had already hung up. Fifteen warnings in a ninety-second session, in the one file
 * that exists so a real failure can be spotted among them.
 *
 * So: send the greeting, read the two-byte reply, then close. One extra round trip on loopback,
 * a stronger answer, and nothing in the engine's log.
 */
function portIsLive(port, timeoutMs = 2500) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (ok) => { if (!done) { done = true; try { sock.destroy(); } catch (e) {} resolve(ok); } };
        sock.setTimeout(timeoutMs);
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        sock.once('close', () => finish(false));
        // No authentication offered, which is what every engine here publishes.
        sock.once('connect', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
        sock.on('data', (buf) => finish(buf.length >= 2 && buf[0] === 0x05 && buf[1] === 0x00));
        sock.connect(port, '127.0.0.1');
    });
}

function diary(kind, fields, note) {
    try { require('./tun-diag').event(kind, fields, note); } catch (e) { /* no diary, same tunnel */ }
}

// ── fail-closed ───────────────────────────────────────────────────────────────────────────────
//
// THE LEAK THESE ENGINES HAD AND وارپ DID NOT.
//
// When وارپ loses its tunnel the machine is held closed by a firewall rule until it comes back
// (`aetherEngageFailClosed`), so waiting out a reconnect costs connectivity and costs nothing
// else. The four SOCKS fronts never had that. Two ways it showed:
//
//   · while the adapter was still up, packets went to a SOCKS port with nothing behind it —
//     no leak, but no internet either, and nothing said so;
//   · and the moment this guard tears that adapter down to give the machine its routing back,
//     every application resumes ON THE REAL INTERFACE, with the real address. That is the
//     leak, and it is one this guard would be CAUSING.
//
// So the outage is held closed first, and the adapter only comes down when the engine is
// genuinely gone. The engine's own executable, sing-box and this app stay allowed — without
// them the engine could never reconnect and a temporary outage would be a permanent one.
//
// aether-guard is not Aether-specific: `engageKillSwitch` takes an adapter and an allow list.
// One firewall state for the machine, so this must never run while WARP's guard holds it —
// and it cannot, because one adapter means one tunnel at a time.
async function engageFailClosed(s, reason) {
    if (s.closed) return;
    try {
        const guard = require('./aether-guard');
        if (guard.getStatus().killSwitch) { s.closed = 'external'; return; }
        const r = await guard.engageKillSwitch({
            adapterAlias: require('./tun-manager').TUN_IFACE_NAME,
            allowPrograms: (s.allowPrograms || []).concat([process.execPath]),
            onLog: s.onLog,
        });
        if (r.ok) {
            s.closed = 'ours';
            diary('front-failclosed', { engine: s.engine, reason }, 'ترافیک تا بازگشت موتور بسته شد');
            if (s.onLog) s.onLog(`[${s.label}] 🔒 تا بازگشت اتصال، ترافیک بسته شد تا چیزی با آی‌پی واقعی بیرون نرود.`);
        } else {
            // Say so plainly: a kill switch that silently did not engage is worse than none,
            // because the user believes they are protected.
            diary('front-failclosed-failed', { engine: s.engine, reason: r.reason });
            if (s.onLog) s.onLog(`[${s.label}] ⚠️ محافظ نشت روشن نشد (${r.reason}) — ممکن است تا بازگشت تونل ترافیک با آی‌پی واقعی خارج شود.`);
        }
    } catch (e) { diary('front-failclosed-error', { engine: s.engine, error: e.message }); }
}

async function releaseFailClosed(s, why) {
    // Only what we engaged. A guard another module holds is its own to release.
    if (s.closed !== 'ours') { s.closed = null; return; }
    s.closed = null;
    try {
        await require('./aether-guard').releaseKillSwitch(s.onLog);
        diary('front-failopen', { engine: s.engine, reason: why });
        if (s.onLog) s.onLog(`[${s.label}] 🔓 ترافیک آزاد شد (${why}).`);
    } catch (e) { diary('front-failopen-error', { engine: s.engine, error: e.message }); }
}

let timer = null;
let busyTick = false;
let g = null;   // the guard's own state, null when nothing is being watched

/**
 * Start watching one front engine.
 *
 * @param o.engine      'psiphon' | 'tor' | 'lantern' | 'geph'
 * @param o.label       the Persian name, for the lines a user reads
 * @param o.exe         'psiphon.exe' — how tun-manager names the owner of the adapter
 * @param o.socksPort   the engine's SOCKS listener
 * @param o.mgr         the engine's manager module (getStatus / readTrafficCounters)
 * @param o.busy        () => boolean — is a TUN transition in flight (never judge mid-transition)
 * @param o.onLog       (line) => void — the app's own log panel
 * @param o.onBlackHole (reason) => Promise — called ONCE when the engine is gone under a live TUN
 */
function start(o) {
    // Idempotent for the same engine: this is called from the engine's own connect AND from the
    // tunnel switch, and restarting it there would zero the drop count — the one number that
    // says whether a session flapped.
    if (g && g.engine === o.engine && timer) return;
    stop('replaced');
    g = {
        // The timings are overridable so the tests can drive a whole restart-and-give-up
        // sequence in seconds instead of the minute the real cadence takes. Nothing in the app
        // passes them; the defaults above are the shipped behaviour.
        tickMs: TICK_MS,
        goneMisses: GONE_MISSES,
        restartBackoffMs: RESTART_BACKOFF_MS,
        maxRestarts: MAX_RESTARTS,
        ...o,
        startedAt: Date.now(),
        misses: 0,
        restarts: 0,
        // Engine-side connectivity as last seen, so only CHANGES are written.
        wasConnected: null,
        downSince: 0,
        drops: 0,
        lastUpAt: 0,
        reported: false,
        // Route ownership as last seen, same rule.
        wasOurs: null,
        // 'ours' while THIS guard holds the firewall closed, 'external' when somebody else does.
        closed: null,
        // Byte totals at the start of the current summary window.
        winAt: Date.now(),
        winEngine: null,
        winTun: null,
        lastEngine: null,
        lastTun: null,
    };
    diary('front-guard-on', { engine: o.engine, exe: o.exe, socks: o.socksPort });
    timer = setInterval(tick, g.tickMs);
    if (timer.unref) timer.unref();
}

function stop(reason) {
    if (timer) clearInterval(timer);
    timer = null;
    // Never leave the machine closed behind us: the guard stopping means nobody is left to open
    // it again, and a user with no internet and no explanation is worse off than one with a leak.
    if (g && g.closed === 'ours') { const s = g; releaseFailClosed(s, `نگهبان متوقف شد (${reason || '-'})`).catch(() => {}); }
    if (g) diary('front-guard-off', { engine: g.engine, reason: reason || 'unspecified', drops: g.drops, uptime: `${Math.round((Date.now() - g.startedAt) / 1000)}s` });
    g = null;
}

function status() {
    if (!g) return { watching: null };
    return {
        watching: g.engine, drops: g.drops, misses: g.misses,
        downSince: g.downSince || null, since: g.startedAt,
    };
}

async function tick() {
    if (!g || busyTick) return;
    busyTick = true;
    const s = g;
    try {
        const tun = require('./tun-manager');
        // Mid-transition there is no honest answer: the adapter is half-built, the port may be
        // being rebound, and every field below would be read at the one moment it means nothing.
        if (typeof s.busy === 'function' && s.busy()) { s.misses = 0; return; }

        const now = Date.now();
        const tunUp = tun.isRunning() && tun.currentEngine() === s.exe;
        let st = {};
        try { st = s.mgr.getStatus() || {}; } catch (e) { st = {}; }
        const live = await portIsLive(s.socksPort);

        // ── 1. the black hole ────────────────────────────────────────────────────────────────
        if (!live) {
            s.misses++;
            diary('front-miss', { engine: s.engine, port: s.socksPort, miss: s.misses, tun: tunUp ? 'up' : 'down' });
            if (s.misses >= s.goneMisses) {
                const why = `موتور ${s.label} دیگر روی پورت ${s.socksPort} جواب نمی‌دهد`;
                diary('front-gone', { engine: s.engine, misses: s.misses, tun: tunUp ? 'up' : 'down', stage: st.stage || '-' }, why);
                if (s.onLog) s.onLog(`[TUN] ⚠️ ${why}.`);
                s.misses = 0;

                // BRING IT BACK BEFORE GIVING UP ON IT.
                //
                // The engine dying is not the same as the user wanting it gone, and until now the
                // two were treated identically: the tunnel came down and the machine went back to
                // its own address until somebody noticed and clicked. psiphon-tunnel-core's
                // ConsoleClient exits by itself — `EstablishTunnelTimeoutSeconds` is one way, a
                // fatal config or network error is another — so this is the ordinary case, not
                // the exotic one.
                //
                // The adapter and the firewall both stay as they are across the attempt: the
                // machine is held closed, so the gap costs connectivity that was already gone and
                // leaks nothing. Only when the restarts are spent does the tunnel come down.
                if (tunUp && typeof s.onRestart === 'function' && s.restarts < s.maxRestarts) {
                    if (!s.closed) await engageFailClosed(s, 'engine process gone');
                    const attempt = ++s.restarts;
                    const wait = s.restartBackoffMs[Math.min(attempt - 1, s.restartBackoffMs.length - 1)];
                    diary('front-restart', { engine: s.engine, attempt, of: s.maxRestarts, waitMs: wait },
                        `${s.label} خودش بسته شده بود؛ تلاش ${attempt} برای اجرای دوباره`);
                    if (s.onLog) s.onLog(`[${s.label}] ↻ موتور بسته شده بود — تلاش ${attempt} از ${s.maxRestarts} برای اجرای دوباره…`);
                    if (wait) await new Promise((r) => setTimeout(r, wait));
                    let ok = false;
                    try { ok = await s.onRestart(); } catch (e) { diary('front-restart-failed', { engine: s.engine, attempt, error: e.message }); }
                    if (ok) {
                        diary('front-restarted', { engine: s.engine, attempt }, `${s.label} دوباره اجرا شد`);
                        if (s.onLog) s.onLog(`[${s.label}] ✅ موتور دوباره بالا آمد؛ تونل دست‌نخورده ماند.`);
                        s.wasConnected = null;
                        return;
                    }
                    diary('front-restart-gaveup', { engine: s.engine, attempt, of: s.maxRestarts });
                    if (attempt < s.maxRestarts) return;   // the next tick tries again
                }
                if (tunUp && typeof s.onBlackHole === 'function') {
                    // The adapter holds the default route with nothing behind it. Everything on
                    // this machine is being handed to a dead port; put the routing back.
                    // The firewall comes off FIRST and deliberately: from here the machine goes
                    // back to its own interface, so leaving the block in place would leave the
                    // user with no internet and no tunnel — the state they can neither diagnose
                    // nor undo. Protection ends when the tunnel does, and they are told which.
                    if (s.closed) await releaseFailClosed(s, 'تونل برداشته شد');
                    try { await s.onBlackHole(why); } catch (e) { diary('front-teardown-failed', { engine: s.engine, error: e.message }); }
                }
                // Stop watching a corpse. Without this the diary fills with one `front-miss`
                // every five seconds for as long as the app stays open, and the file whose value
                // is that every line means something becomes unreadable.
                if (!st.running) stop('engine process is gone');
            }
            return;
        }
        s.misses = 0;

        // ── 2. the engine's own tunnel: up, down, and how long down ──────────────────────────
        const connected = !!st.connected;
        if (s.wasConnected === null) {
            s.wasConnected = connected;
            if (connected) s.lastUpAt = now;
        } else if (connected !== s.wasConnected) {
            if (!connected) {
                s.downSince = now;
                s.reported = false;
            } else {
                const gap = s.downSince ? Math.round((now - s.downSince) / 1000) : 0;
                // Written whether or not the outage lasted long enough to have been announced
                // while it was happening. A SHORT drop that healed before the grace period is
                // the flap itself — «وصل می‌شود، قطع می‌شود، دوباره وصل می‌شود» — and a guard
                // that only recorded the long ones would have nothing to say about exactly the
                // complaint it exists to answer.
                s.drops++;
                diary(s.reported ? 'front-back' : 'front-flap', {
                    engine: s.engine, gap: `${gap}s`, drops: s.drops,
                    protocol: st.protocol || '-', rung: st.rung || '-', region: st.egressRegion || '-',
                }, `اتصال ${s.label} بعد از حدود ${gap} ثانیه برگشت`);
                if (s.onLog) s.onLog(`[${s.label}] ↻ اتصال بعد از حدود ${gap} ثانیه دوباره برقرار شد (قطعی شمارهٔ ${s.drops}).`);
                s.downSince = 0;
                s.lastUpAt = now;
                if (s.closed) await releaseFailClosed(s, 'اتصال برگشت');
            }
            s.wasConnected = connected;
        }
        // Written once per drop, and only after the grace period — the core blinks `count:0`
        // during its own reconnects and a line per blink would bury the real ones.
        if (!connected && s.downSince && !s.reported && now - s.downSince >= DROP_GRACE_MS) {
            s.reported = true;
            const up = s.lastUpAt ? Math.round((s.downSince - s.lastUpAt) / 1000) : 0;
            diary('front-drop', {
                engine: s.engine, heldFor: `${up}s`, stage: st.stage || '-',
                protocol: st.protocol || '-', rung: st.rung || '-', tun: tunUp ? 'up' : 'down',
            }, `${s.label} تونلش را بعد از ${up} ثانیه از دست داد؛ هسته دارد دوباره وصل می‌شود`);
            if (s.onLog) s.onLog(`[${s.label}] ⚠️ تونل بعد از ${up} ثانیه قطع شد — هسته خودش در حال اتصال مجدد است.`);
            // Only while the adapter holds the machine's route. In proxy-only mode nothing was
            // ever redirected, so there is nothing to hold closed and closing it would take the
            // machine off the internet for a tunnel it was not carrying.
            if (tunUp) await engageFailClosed(s, 'engine tunnel lost');
        }

        // ── 3. who owns the default route ────────────────────────────────────────────────────
        // Cheap on purpose: `fastLive` spawns nothing, it reads the interface table and asks the
        // OS which source address it would use. A route check that shelled out could not run
        // every five seconds without costing more than it is worth.
        if (tunUp) {
            try {
                const r = await tun.fastLive();
                if (r && r.ok) {
                    const ours = !!r.defaultViaTun;
                    if (s.wasOurs === null) s.wasOurs = ours;
                    else if (ours !== s.wasOurs) {
                        s.wasOurs = ours;
                        diary('front-route', { engine: s.engine, viaTun: ours, defaultVia: r.defaultVia || '-' },
                            ours ? 'مسیر پیش‌فرض دوباره روی تونل است'
                                 : 'مسیر پیش‌فرض از تونل خارج شد — ترافیک دارد مستقیم می‌رود');
                        if (!ours && s.onLog) s.onLog(`[TUN] ⚠️ مسیر پیش‌فرض از تونل خارج شد (الان «${r.defaultVia || '؟'}») — ترافیک بیرون تونل می‌رود.`);
                    }
                }
            } catch (e) { /* the route check is advisory */ }
        }

        // ── 4. bytes: speed, and the leak the comparison exposes ─────────────────────────────
        let engineCounters = null;
        try { engineCounters = s.mgr.readTrafficCounters ? s.mgr.readTrafficCounters() : null; } catch (e) { engineCounters = null; }
        let tunCounters = null;
        try { tunCounters = tunUp ? await tun.readTrafficCounters() : null; } catch (e) { tunCounters = null; }
        if (engineCounters && Number.isFinite(engineCounters.down)) s.lastEngine = engineCounters;
        if (tunCounters && Number.isFinite(tunCounters.down)) s.lastTun = tunCounters;
        if (s.winEngine === null && s.lastEngine) s.winEngine = s.lastEngine;
        if (s.winTun === null && s.lastTun) s.winTun = s.lastTun;

        // A window that straddles a counter-series switch cannot be summarised — the two are
        // unrelated magnitudes. Start a fresh window instead of publishing a made-up number.
        if (s.winTun && s.lastTun && s.winTun.series !== s.lastTun.series) {
            s.winAt = now; s.winEngine = s.lastEngine; s.winTun = s.lastTun;
        }
        if (now - s.winAt >= SUMMARY_MS) {
            const secs = (now - s.winAt) / 1000;
            const dEng = s.lastEngine && s.winEngine
                ? { down: Math.max(0, s.lastEngine.down - s.winEngine.down), up: Math.max(0, s.lastEngine.up - s.winEngine.up) }
                : null;
            const dTun = s.lastTun && s.winTun
                ? { down: Math.max(0, s.lastTun.down - s.winTun.down), up: Math.max(0, s.lastTun.up - s.winTun.up) }
                : null;
            const mbit = (bytes) => (bytes * 8 / secs / 1e6).toFixed(2);
            if (dEng || dTun) {
                diary('front-speed', {
                    engine: s.engine, window: `${Math.round(secs)}s`,
                    engineDown: dEng ? mbit(dEng.down) : '-', engineUp: dEng ? mbit(dEng.up) : '-',
                    tunDown: dTun ? mbit(dTun.down) : '-', tunUp: dTun ? mbit(dTun.up) : '-',
                    unit: 'Mbit/s', connected,
                });
            }
            // The leak line. Bytes went INTO the adapter that the engine never saw leave, which
            // means some other outbound carried them — with the user's own address on them.
            if (dEng && dTun) {
                const gap = (dTun.down + dTun.up) - (dEng.down + dEng.up);
                if (gap > LEAK_BYTES && dTun.down + dTun.up > 0) {
                    const pct = Math.round(gap / (dTun.down + dTun.up) * 100);
                    diary('front-leak', {
                        engine: s.engine, window: `${Math.round(secs)}s`,
                        tunBytes: dTun.down + dTun.up, engineBytes: dEng.down + dEng.up, gapBytes: gap, pct,
                    }, `${pct}٪ از بایت‌هایی که وارد آداپتور شدند از موتور رد نشدند — یعنی از مسیر دیگری بیرون رفته‌اند`);
                    if (s.onLog) s.onLog(`[TUN] ⚠️ حدود ${pct}٪ ترافیک وارد آداپتور شد ولی از ${s.label} رد نشد — احتمال نشتی.`);
                }
            }
            s.winAt = now;
            s.winEngine = s.lastEngine;
            s.winTun = s.lastTun;
        }
    } catch (e) {
        // A guard that throws must never take the server with it.
        diary('front-guard-error', { error: e.message });
    } finally { busyTick = false; }
}

module.exports = { start, stop, status, portIsLive, TICK_MS };
