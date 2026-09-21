'use strict';

// Tunnel diagnostics: speed and drop-outs, recorded where they can be read AFTER the fact.
//
// WHY THIS EXISTS. «مدام قطع و وصل می‌شود و سرعتش خیلی پایین است» was, until now, impossible to
// answer. Everything the app knew about a live tunnel went to one of two places:
//
//   · tun.log   — truncated on every start, so the run BEFORE the one being looked at is gone,
//                 and it holds sing-box's own lines but none of the orchestrator's decisions
//                 («موتور پاسخ نمی‌دهد», «مسیر پیش‌فرض دزدیده شد», every teardown and rebuild).
//   · the UI's core-log panel — memory only, gone the moment the app closes.
//
// So a user reporting a tunnel that flaps could hand over nothing at all, and the one number that
// settles "is the tunnel slow or is the ENGINE slow" was never measured on the same line twice.
//
// Three things are recorded here, in ~/.mlmvpn/tunnel-events.log, which SURVIVES restarts:
//
//   1. every transition, with its reason and how long the previous state lasted — the flap log;
//   2. a passive speed sample every few seconds, taken from bytes the tunnel already carried, so
//      it costs no bandwidth and cannot itself slow anything down — plus an explicit `stall`
//      event when a tunnel that was carrying traffic goes silent, and `resume` with the gap;
//   3. an A/B throughput probe: the same download through the TUN and straight into the engine's
//      SOCKS port. That comparison is the whole diagnosis — a tunnel measuring far below the
//      engine behind it means the loss is in the tunnel layer (stack, MTU, DNS, the machine),
//      while the two within a few per cent of each other means the engine is simply that slow and
//      no amount of tunnel tuning will help.
//
// Nothing in here can break a tunnel: every function swallows its own errors, the sampler reads
// counters that already exist, and the probe only downloads.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

// `MLMVPN_HOME` exists for ONE reason: the tests must not write into the user's diary.
//
// The front-engine suites run the real managers with a fake core, and every fake connect and
// fake drop went straight into `~/.mlmvpn/tunnel-events.log` — forty lines of `heldFor=0s` and
// `ms=3` in the middle of a real session's history, in the file whose whole value is that every
// line in it happened. The suites set this to a temp directory; nothing else ever does.
const DIR = path.join(process.env.MLMVPN_HOME || os.homedir(), '.mlmvpn');
const EVENTS_FILE = path.join(DIR, 'tunnel-events.log');
// Two files, rotated by hand. This is a diary, not a firehose: one line per transition and one
// per sampling window, so a month of ordinary use fits in the first file.
const EVENTS_MAX_BYTES = 2 * 1024 * 1024;

function rotateIfNeeded() {
    try {
        const st = fs.statSync(EVENTS_FILE);
        if (st.size < EVENTS_MAX_BYTES) return;
        try { fs.unlinkSync(`${EVENTS_FILE}.1`); } catch (e) { /* first rotation */ }
        fs.renameSync(EVENTS_FILE, `${EVENTS_FILE}.1`);
    } catch (e) { /* no file yet */ }
}

/**
 * One structured line. `kind` is the event, `fields` are key=value pairs, and `note` (optional)
 * is the Persian sentence a user can read. Key=value because this file is read by eye AND
 * grepped — `grep stall tunnel-events.log` has to be enough to see the shape of a bad session.
 */
function event(kind, fields = {}, note = '') {
    try {
        fs.mkdirSync(DIR, { recursive: true });
        rotateIfNeeded();
        const pairs = Object.keys(fields)
            .filter(k => fields[k] !== undefined && fields[k] !== null && fields[k] !== '')
            .map(k => `${k}=${String(fields[k]).replace(/\s+/g, ' ')}`)
            .join(' ');
        const line = `[${new Date().toISOString()}] ${kind}${pairs ? ' ' + pairs : ''}${note ? ' :: ' + note : ''}\n`;
        fs.appendFileSync(EVENTS_FILE, line);
    } catch (e) { /* a diary that cannot be written must not stop the tunnel */ }
}

// ── the session: one tunnel, from start to stop ───────────────────────────────────────────────
// `uptime` on the stop line is the number that makes a flap obvious at a glance: a column of
// `stop … uptime=7s` is a tunnel being torn down and rebuilt, which reads completely differently
// from one `stop … uptime=3h`.
let session = null;

function startSession(info = {}) {
    session = { at: Date.now(), info, stalls: 0, lastSample: null };
    event('start', Object.assign({}, info));
}

function readySession(extra = {}) {
    if (!session) return;
    session.readyAt = Date.now();
    event('ready', Object.assign({ ms: Date.now() - session.at }, extra));
}

/**
 * Close the entry — and ONLY when there is one open. Every stop path in the app calls this,
 * including the ones that stop a tunnel that was never running (a failed start unwinding, the
 * app quitting with nothing up), and a `stop` line for a tunnel that never existed is noise in
 * the one file whose value is that every line means something.
 */
function stopSession(reason, extra = {}) {
    if (!session) return;
    const up = Math.round((Date.now() - session.at) / 1000);
    event('stop', Object.assign({
        reason: reason || 'unknown',
        uptime: `${up}s`,
        stalls: session.stalls,
    }, extra));
    session = null;
}

function sessionUptimeMs() {
    return session ? Date.now() - session.at : 0;
}

// ── passive speed sampling ────────────────────────────────────────────────────────────────────
//
// The bytes are already counted: sing-box's clash API keeps a running total per connection and
// tun-manager already folds it into { up, down } for the live-speed display. Reading it again
// here costs one loopback request every few seconds and NOT ONE EXTRA BYTE of the user's line,
// which is the only honest way to measure a connection somebody is trying to use.
//
// STALL DETECTION IS THE POINT. A tunnel that drops does not usually die — the adapter stays up,
// the process stays alive, every health check keeps saying "healthy", and the bytes simply stop.
// That is invisible to everything else in this app and it is exactly what the user sees as
// «قطع شد». Here it becomes one line with a duration on it.

const SAMPLE_MS = 5000;
// Long enough not to fire on an idle machine between page loads, short enough that a real
// drop-out is named while the user is still looking at it.
const STALL_AFTER_MS = 20000;
// One rolled-up line per minute, so a long session stays readable. Stalls are written the moment
// they are detected, never held for the summary.
const SUMMARY_MS = 60000;

let sampler = null;

function fmtMbit(bytesPerSec) {
    return (bytesPerSec * 8 / 1e6).toFixed(2);
}

/**
 * @param read   () => Promise<{up,down}|null>  cumulative byte totals (tun.readTrafficCounters)
 * @param alive  () => boolean                  is the tunnel still supposed to be up
 * @param onLine (line) => void                 optional, for the app's own log
 */
function startSampler({ read, alive, onLine } = {}) {
    stopSampler();
    let prev = null;
    let prevAt = 0;
    let lastMoveAt = Date.now();
    let stalledSince = 0;
    let winStart = Date.now();
    let winDown = 0, winUp = 0, winPeak = 0, winSamples = 0;

    const tick = async () => {
        try {
            if (typeof alive === 'function' && !alive()) return;
            const now = Date.now();
            const cur = await read();
            if (!cur) return;
            // The two counters are unrelated magnitudes (see tallyCounters). A delta taken across
            // a switch between them is not slow or fast traffic — it is traffic that never
            // happened, and it would land in this file as a speed line or a stall.
            if (prev && prev.series !== cur.series) { prev = cur; prevAt = now; lastMoveAt = now; return; }
            if (prev) {
                const secs = Math.max(0.5, (now - prevAt) / 1000);
                const down = Math.max(0, cur.down - prev.down) / secs;
                const up = Math.max(0, cur.up - prev.up) / secs;
                winDown += down; winUp += up; winSamples++;
                if (down + up > winPeak) winPeak = down + up;

                if (down + up > 1024) {          // a kilobyte a second is "carrying traffic"
                    if (stalledSince) {
                        const gap = Math.round((now - stalledSince) / 1000);
                        if (session) session.stalls++;
                        event('resume', { gap: `${gap}s`, down: fmtMbit(down), up: fmtMbit(up) },
                            `ترافیک بعد از ${gap} ثانیه سکوت دوباره برقرار شد`);
                        if (onLine) onLine(`[TUN] ↻ تونل بعد از ${gap} ثانیه بی‌حرکتی دوباره دیتا رد می‌کند.`);
                        stalledSince = 0;
                    }
                    lastMoveAt = now;
                } else if (!stalledSince && now - lastMoveAt > STALL_AFTER_MS) {
                    stalledSince = lastMoveAt;
                    const idle = Math.round((now - lastMoveAt) / 1000);
                    event('stall', { idle: `${idle}s` },
                        `تونل بالاست ولی ${idle} ثانیه است هیچ بایتی رد نشده`);
                    if (onLine) onLine(`[TUN] ⚠️ ${idle} ثانیه است هیچ دیتایی از تونل رد نمی‌شود (تونل هنوز بالاست).`);
                }
            }
            prev = cur; prevAt = now;

            if (now - winStart >= SUMMARY_MS && winSamples) {
                event('speed', {
                    window: `${Math.round((now - winStart) / 1000)}s`,
                    down: fmtMbit(winDown / winSamples),
                    up: fmtMbit(winUp / winSamples),
                    peak: fmtMbit(winPeak),
                    unit: 'Mbit/s',
                });
                winStart = now; winDown = 0; winUp = 0; winPeak = 0; winSamples = 0;
            }
        } catch (e) { /* a sampler that throws must not take the server with it */ }
    };

    sampler = setInterval(tick, SAMPLE_MS);
    if (sampler.unref) sampler.unref();
}

function stopSampler() {
    if (sampler) clearInterval(sampler);
    sampler = null;
}

// ── the A/B probe ─────────────────────────────────────────────────────────────────────────────
//
// Same host, same path, same byte accounting, twice: once the way an application reaches the
// internet (which, with the tunnel up, is through the adapter), and once straight into the
// engine's SOCKS port on loopback — a path the TUN never touches, because loopback is not
// captured by auto_route and the engine's own process is excluded from it.
//
// Both numbers start counting at the first BODY byte, so the connect, the request and the far
// end's think-time are charged to latency (reported separately as ttfb) and not to bandwidth.
//
// PLAIN HTTP, AND DELIBERATELY SO. Not for speed — TLS costs nothing measurable on a megabyte —
// but because the alternative is `tls.connect({ socket })`, which is the only way to put TLS on
// a socket somebody else dialled (the SOCKS half needs exactly that). Measured here on Windows,
// Node 24: that call takes the process down with an access violation when the underlying socket
// is reset mid-handshake — no exception, no stack, the whole app gone. A diagnostic that can
// crash the program it is diagnosing is worse than no diagnostic. The endpoint answers the same
// exact byte count on port 80 (verified: HTTP 200, 1000000 bytes), the payload is
// incompressible filler either way, and — the part that matters — BOTH halves use the identical
// code path, so the comparison between them is unaffected.

const PROBE_HOST = 'speed.cloudflare.com';
const PROBE_PORT = 80;

function downloadFrom(makeSocket, bytes, timeoutMs) {
    return new Promise((resolve) => {
        let sock;
        try { sock = makeSocket(); } catch (e) { return resolve({ ok: false, error: e.message, kbps: 0, bytes: 0, ms: 0 }); }

        let got = 0, headerDone = false, started = 0, settled = false;
        const askedAt = Date.now();
        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { sock.destroy(); } catch (e) {}
            const ms = started ? Date.now() - started : 0;
            resolve({
                ok: !error && got > 0,
                kbps: ms > 0 ? Math.round((got / 1024) / (ms / 1000)) : 0,
                bytes: got, ms, ttfbMs: started ? started - askedAt : 0,
                error: error || null,
            });
        };
        const timer = setTimeout(() => finish(null), timeoutMs);

        const request = () => sock.write(
            `GET /__down?bytes=${bytes} HTTP/1.1\r\n` +
            `Host: ${PROBE_HOST}\r\n` +
            'User-Agent: mlmvpn-tunnel-check\r\n' +
            'Connection: close\r\n\r\n'
        );
        // An already-connected socket (the SOCKS half hands one over) never emits 'connect' again.
        if (sock.connecting) sock.once('connect', request); else request();

        sock.on('data', (chunk) => {
            if (!headerDone) {
                const idx = chunk.indexOf('\r\n\r\n');
                if (idx === -1) return;
                headerDone = true;
                started = Date.now();
                got += chunk.length - (idx + 4);
                return;
            }
            got += chunk.length;
            if (got >= bytes) finish(null);
        });
        sock.on('error', (e) => finish(e.message));
        sock.on('end', () => finish(null));
        sock.on('close', () => finish(null));
    });
}

/** Through whatever the operating system decides — i.e. through the tunnel, when one is up. */
function throughTunnel(bytes, timeoutMs) {
    return downloadFrom(() => net.connect(PROBE_PORT, PROBE_HOST), bytes, timeoutMs);
}

/** Straight into the engine's SOCKS5 port: loopback, so the adapter is not involved at all. */
function throughSocks(socksPort, bytes, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let step = 0, settled = false;
        const fail = (msg) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch (e) {}
            resolve({ ok: false, error: msg, kbps: 0, bytes: 0, ms: 0 });
        };
        const timer = setTimeout(() => fail('socks timeout'), 9000);
        sock.on('error', (e) => { clearTimeout(timer); fail(e.message); });
        sock.on('data', (buf) => {
            if (step === 0) {
                if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail('socks greeting refused');
                step = 1;
                const host = Buffer.from(PROBE_HOST, 'ascii');
                sock.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host,
                    Buffer.from([PROBE_PORT >> 8, PROBE_PORT & 0xff]),
                ]));
                return;
            }
            if (step === 1) {
                if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(`socks connect failed (0x${(buf[1] || 0).toString(16)})`);
                step = 2;
                clearTimeout(timer);
                settled = true;
                sock.removeAllListeners('data');
                // Hand the live socket to the same downloader the tunnel side uses, so the two
                // figures are produced by identical code and can honestly be compared.
                downloadFrom(() => sock, bytes, timeoutMs).then(resolve);
            }
        });
        sock.connect(socksPort, '127.0.0.1', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    });
}

/**
 * Several downloads at once, through the tunnel, reported as one figure.
 *
 * THE NUMBER THIS APP WAS NEVER MEASURING, and the reason a working tunnel kept being reported
 * as unusably slow. Every throughput figure here was a SINGLE connection — and a single
 * connection is the one thing these engines are worst at. Measured on سایفون, 2026-09-19, same
 * tunnel, same minute:
 *
 *     one stream   0.65 Mbit/s
 *     six streams  3.13 Mbit/s      ← what a browser actually gets
 *
 * Nearly five times. The ceiling is PER CONNECTION — a domain-fronted meek stream carries about
 * that much and no more, whatever the line underneath can do — so reporting one stream as "the
 * speed" understates ordinary browsing by that factor, and every decision made from that number
 * (is it working? is it worth keeping? should it reconnect?) was made from the wrong one.
 *
 * The two are kept separate rather than one replacing the other, because they answer different
 * questions: a single big download really is that slow, and a page full of requests really is
 * not.
 */
function parallelThroughTunnel(streams, bytes, timeoutMs) {
    const each = Math.max(65536, Math.round(bytes / streams));
    const startedAt = Date.now();
    return Promise.all(Array.from({ length: streams }, () => throughTunnel(each, timeoutMs)))
        .then((rs) => {
            const total = rs.reduce((n, r) => n + (r.bytes || 0), 0);
            const secs = Math.max(0.001, (Date.now() - startedAt) / 1000);
            return {
                ok: rs.some((r) => r.ok), streams, okCount: rs.filter((r) => r.ok).length,
                bytes: total, ms: Math.round(secs * 1000),
                kbps: Math.round((total / 1024) / secs),
            };
        });
}

/**
 * The same, straight into an engine's SOCKS port — no adapter involved.
 *
 * This is what an engine is WORTH, measured the way it will actually be used. It exists so a
 * connect can ask "is this server any good?" before the machine's route is handed to it: a
 * single stream through a domain-fronted meek tunnel reads about the same whether the server is
 * excellent or barely alive (0.5–0.9 Mbit/s either way, measured), while several at once
 * separates them clearly — 3.1 Mbit/s from a good one against 0.4 from a bad one on the same
 * line, minutes apart.
 */
function parallelThroughSocks(socksPort, streams, bytes, timeoutMs) {
    const each = Math.max(65536, Math.round(bytes / streams));
    const startedAt = Date.now();
    return Promise.all(Array.from({ length: streams }, () => throughSocks(socksPort, each, timeoutMs)))
        .then((rs) => {
            const total = rs.reduce((n, r) => n + (r.bytes || 0), 0);
            const secs = Math.max(0.001, (Date.now() - startedAt) / 1000);
            return {
                ok: rs.some((r) => r.ok), streams, okCount: rs.filter((r) => r.ok).length,
                bytes: total, ms: Math.round(secs * 1000),
                kbps: Math.round((total / 1024) / secs),
                mbit: +(((total * 8 / 1e6) / secs).toFixed(2)),
                errors: [...new Set(rs.filter((r) => !r.ok).map((r) => r.error))].slice(0, 3),
            };
        });
}

/**
 * Measure both paths and say, in one sentence, where the speed is being lost.
 *
 * `socksPort` is the engine behind the tunnel. Returns the two results plus a Persian verdict;
 * writes everything to the events log and, through `onLog`, to the app's own log.
 */
async function diagnose({ socksPort, engineLabel = 'موتور', bytes = 2_000_000, timeoutMs = 15000, streams = 6, onLog } = {}) {
    const say = (line) => { if (onLog) onLog(`[TUN] ${line}`); };
    say('سنجش سرعت تونل شروع شد (یک بار از داخل تونل، یک بار مستقیم از خود موتور)…');

    // Sequential, never parallel: two downloads on one line would each get half of it and the
    // comparison would be meaningless.
    const viaTun = await throughTunnel(bytes, timeoutMs);
    const viaEngine = socksPort ? await throughSocks(socksPort, bytes, timeoutMs) : null;
    // …and the same total split across several connections, which is what a browser does. Same
    // number of bytes as one side above, so this costs the line one more pass and not six.
    const viaMany = streams > 1 ? await parallelThroughTunnel(streams, bytes, timeoutMs) : null;

    const mbit = (r) => (r && r.ok ? (r.kbps * 8 / 1000).toFixed(2) : '0');
    const tunM = Number(mbit(viaTun));
    const engM = viaEngine ? Number(mbit(viaEngine)) : 0;
    const manyM = viaMany ? Number(mbit(viaMany)) : 0;

    let verdict, note;
    if (!viaTun.ok && viaEngine && viaEngine.ok) {
        verdict = 'tunnel-dead';
        note = `از داخل تونل هیچ دیتایی نرسید (${viaTun.error || 'بدون خطا'}) ولی خود ${engineLabel} دارد ${engM} مگابیت می‌گیرد — مشکل از لایه‌ی تونل است، نه از موتور.`;
    } else if (!viaTun.ok && (!viaEngine || !viaEngine.ok)) {
        verdict = 'both-dead';
        note = 'نه از تونل و نه مستقیم از موتور دیتایی نرسید — یا موتور قطع است یا خودِ خط اینترنت.';
    } else if (!viaEngine || !viaEngine.ok) {
        verdict = 'engine-unmeasured';
        note = `تونل ${tunM} مگابیت داد؛ اندازه‌گیری مستقیم موتور ممکن نشد (${viaEngine ? viaEngine.error : 'پورت موتور داده نشد'}).`;
    } else if (engM > 0.2 && tunM < engM * 0.6) {
        verdict = 'tunnel-loss';
        note = `تونل ${tunM} مگابیت، ولی همان موتور مستقیماً ${engM} مگابیت می‌دهد — یعنی حدود ${Math.round((1 - tunM / engM) * 100)}٪ سرعت در لایه‌ی تونل از بین می‌رود.`;
    } else {
        verdict = 'engine-bound';
        note = `تونل ${tunM} مگابیت و موتور ${engM} مگابیت — تقریباً برابرند، پس سرعت را خود ${engineLabel} تعیین می‌کند نه حالت تونل.`;
    }

    // The figure that matches what the user sees in a browser, said plainly — a tunnel whose
    // single stream is 0.5 and whose six streams are 3.1 is not "half a megabit", and being told
    // it is half a megabit is why a usable tunnel gets turned off.
    if (viaMany && viaMany.ok && manyM > tunM * 1.3) {
        note += ` ضمناً با چند اتصال هم‌زمان — کاری که مرورگر می‌کند — همین تونل ${manyM} مگابیت می‌دهد، یعنی سقف روی «هر اتصال» است نه روی خط.`;
    }
    event('speedtest', {
        tun: mbit(viaTun), engine: viaEngine ? mbit(viaEngine) : '-',
        parallel: viaMany ? mbit(viaMany) : '-', streams: viaMany ? viaMany.okCount : 0,
        unit: 'Mbit/s',
        tunBytes: viaTun.bytes, engineBytes: viaEngine ? viaEngine.bytes : 0,
        parallelBytes: viaMany ? viaMany.bytes : 0,
        tunTtfb: `${viaTun.ttfbMs || 0}ms`, verdict,
    }, note);
    say(`نتیجه‌ی سنجش: ${note}`);
    return { viaTun, viaEngine, viaMany, verdict, note, tunMbit: tunM, engineMbit: engM, parallelMbit: manyM };
}

module.exports = {
    EVENTS_FILE,
    event,
    startSession, readySession, stopSession, sessionUptimeMs,
    startSampler, stopSampler,
    diagnose, throughTunnel, throughSocks, parallelThroughTunnel, parallelThroughSocks,
};
