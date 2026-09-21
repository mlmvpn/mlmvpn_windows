// --- Aether engine manager (engine 2.0.0 — CluvexStudio's OWN release build, untouched) ---
// Drives core/aether.exe (Cloudflare WARP / MASQUE / WireGuard censorship-circumvention
// client) as a child process. The Rust binary is used unmodified: every prompt it asks
// interactively has an AETHER_* environment-variable equivalent, so setting those up front
// makes it fully non-interactive.
//
// 2026-09-20: «unmodified» is now literal. Until then core/aether.exe was OUR build of 1.9.0 with
// scan patches on top (backup/aether-1.9.0-mlmvpn-patched.exe and its source beside it); the file
// is now `aether.exe` straight out of the developer's `aether-windows-x86_64.zip`, and the store
// updates it from their releases directly — store/direct.js. `aether-src/` is their 2.0.0 tree,
// byte for byte, so a diff against it stays meaningful.
//
// WHAT TO RE-CHECK ON AN UPGRADE, because both fail silently:
//   - the AETHER_* names `buildEnv` sets, against the engine source. 1.9.0 → 2.0.0 removed none
//     and added AETHER_TOR_* plus AETHER_TCP_*/AETHER_MAX_CLIENTS/AETHER_QUIC_V2.
//   - the wording STAGE_RULES/NOTE_RULES match, against the engine's log strings. The same rules
//     matched 1.9.0 and 2.0.0 identically — the only line that stopped existing is the one OUR
//     patch used to print («tcp handshake unanswered»), kept below because a user can still be
//     running the old binary out of the store.
//
// Responsibilities:
//   - translate the UI's per-protocol settings into AETHER_* env vars
//   - parse stdout/stderr into structured stage events + raw core log lines
//   - own the Windows system-proxy registry keys while connected
//   - structured debug logging with file rotation & stage timing
//
// Talks to the UI through the same `core_log` websocket event xray-manager.js uses,
// plus an `aether_status` event carrying the current stage.

const { spawn, execSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const speedtest = require('./aether-speedtest');

let aetherProcess = null;
let currentState = null;
let logBuffer = [];
let noiseTimer = null;

// Every start gets a new id. A killed engine's stdout/stderr/close events keep arriving for
// a moment AFTER its successor has been spawned — the pipes are already full and Node drains
// them on later ticks. Without this guard those late lines are parsed as if they belonged to
// the new run: a dying process emitting "handshake failed" flips the fresh session to a red
// "failed" state, server.js tears down the front-end Xray and the DNS bridge, and the only
// way out is closing the whole app. Handlers compare against `sessionId` and return early
// when they no longer own the state.
let sessionId = 0;

// How many times a start may throw a slow gateway back and rescan before settling for what
// it has. Bounded because on a genuinely slow line every gateway looks like a dud, and an
// unbounded retry would reconnect forever instead of giving the user their connection.
const MAX_DUD_RETRIES = 2;
// A tunnel the engine calls healthy while nothing passes through it is not a quality judgement,
// so it gets its own, larger allowance — see the «NOTHING AT ALL got through» note in
// `runSpeedGate`. Each retry is a fresh sweep of ~2000 candidates, so the attempts are not
// re-draws of the same card.
const MAX_DEAD_RETRIES = 4;
let dudRetries = 0;

// Gateways this run already measured and threw away. On a filtered line the scan frequently
// has exactly one reachable edge, so a rescan re-selects the very gateway we just rejected and
// the "find something better" loop becomes a guaranteed pair of disconnects that ends on the
// same endpoint anyway. Remembering the rejects lets the retry recognise that situation and
// keep the tunnel instead of tearing it down to prove a point.
let rejectedGateways = [];

const SOCKS_PORT = 20810;           // xray uses 20809 — keep them separate
const MAX_LOG_BUFFER = 2000;
const MAX_DEBUG_LOG_FILES = 5;      // keep the last 5 debug log files, delete older

// Identity/config files are written next to the working directory. The install dir may be
// read-only (Program Files), so keep them under the user profile alongside our other state.
const AETHER_DATA_DIR = path.join(os.homedir(), '.mlmvpn', 'aether');
const CRASH_LOG = path.join(AETHER_DATA_DIR, 'last-crash.log');
const DEBUG_LOG_DIR = path.join(AETHER_DATA_DIR, 'debug-logs');

// ============================================================
// Debug logging system
// ============================================================
let debugMode = false;
let debugLogStream = null;
let debugLogPath = null;
let stageTimings = [];          // {stage, enteredAt, leftAt}
let lastStageEntry = null;
let sessionStartTime = null;
let debugCallbacks = { onDebug: null };

function startDebugSession() {
    sessionStartTime = Date.now();
    stageTimings = [];
    lastStageEntry = null;

    if (!debugMode) return;

    try {
        if (!fs.existsSync(DEBUG_LOG_DIR)) fs.mkdirSync(DEBUG_LOG_DIR, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        debugLogPath = path.join(DEBUG_LOG_DIR, `debug-${ts}.log`);
        debugLogStream = fs.createWriteStream(debugLogPath, { flags: 'a' });
        rotateDebugLogs();
    } catch (e) {
        debugLogStream = null;
    }
}

function stopDebugSession() {
    if (lastStageEntry) {
        lastStageEntry.leftAt = Date.now();
        stageTimings.push(lastStageEntry);
        lastStageEntry = null;
    }
    if (debugLogStream) {
        try {
            debugLogStream.write(`\n=== SESSION SUMMARY ===\n`);
            debugLogStream.write(`Duration: ${((Date.now() - (sessionStartTime || Date.now())) / 1000).toFixed(1)}s\n`);
            stageTimings.forEach(st => {
                const dur = ((st.leftAt - st.enteredAt) / 1000).toFixed(1);
                debugLogStream.write(`  ${st.stage}: ${dur}s\n`);
            });
            debugLogStream.write(`=== END ===\n`);
            debugLogStream.end();
        } catch (e) {}
        debugLogStream = null;
    }
}

function debugLog(level, source, text) {
    const ts = new Date().toISOString();
    const elapsed = sessionStartTime ? `+${((Date.now() - sessionStartTime) / 1000).toFixed(1)}s` : '';
    const line = `[${ts}] [${elapsed}] [${level}] [${source}] ${text}`;

    if (debugLogStream) {
        try { debugLogStream.write(line + '\n'); } catch (e) {}
    }

    if (debugCallbacks.onDebug) {
        debugCallbacks.onDebug({ ts, elapsed, level, source, text });
    }
}

function recordStageChange(newStage) {
    const now = Date.now();
    if (lastStageEntry) {
        lastStageEntry.leftAt = now;
        stageTimings.push(lastStageEntry);
    }
    lastStageEntry = { stage: newStage, enteredAt: now, leftAt: null };
    if (debugMode) {
        const prevDur = stageTimings.length
            ? `(prev: ${((stageTimings[stageTimings.length - 1].leftAt - stageTimings[stageTimings.length - 1].enteredAt) / 1000).toFixed(1)}s)`
            : '';
        debugLog('INFO', 'STAGE', `→ ${newStage} ${prevDur}`);
    }
}

function rotateDebugLogs() {
    try {
        if (!fs.existsSync(DEBUG_LOG_DIR)) return;
        const files = fs.readdirSync(DEBUG_LOG_DIR)
            .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
            .sort();
        while (files.length > MAX_DEBUG_LOG_FILES) {
            const old = files.shift();
            try { fs.unlinkSync(path.join(DEBUG_LOG_DIR, old)); } catch (e) {}
        }
    } catch (e) {}
}

function getDebugSummary() {
    return {
        debugMode,
        sessionStartTime,
        currentStage: currentState ? currentState.stage : null,
        stageTimings: stageTimings.map(st => ({
            stage: st.stage,
            durationMs: (st.leftAt || Date.now()) - st.enteredAt,
        })),
        currentStageDuration: lastStageEntry
            ? Date.now() - lastStageEntry.enteredAt
            : null,
        debugLogPath,
        logBufferSize: logBuffer.length,
    };
}

function getDebugLogFiles() {
    try {
        if (!fs.existsSync(DEBUG_LOG_DIR)) return [];
        return fs.readdirSync(DEBUG_LOG_DIR)
            .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
            .sort()
            .reverse()
            .map(f => ({
                name: f,
                path: path.join(DEBUG_LOG_DIR, f),
                size: fs.statSync(path.join(DEBUG_LOG_DIR, f)).size,
            }));
    } catch (e) { return []; }
}

function readDebugLogFile(filename) {
    try {
        const p = path.join(DEBUG_LOG_DIR, path.basename(filename));
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    } catch (e) { return ''; }
}

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

function getExePath() {
    return require('./core-paths').file('warp', 'aether.exe', path.join(getUnpackedDir(), 'core', 'aether.exe'));
}

function ensureDataDir() {
    if (!fs.existsSync(AETHER_DATA_DIR)) fs.mkdirSync(AETHER_DATA_DIR, { recursive: true });
    return AETHER_DATA_DIR;
}

// ============================================================
// Stage detection
// ============================================================
// Aether's log lines have stable prefixes, so we can map them onto the stages the UI shows.
// Ordered most-specific first; the first match wins.
const STAGE_RULES = [
    { re: /no (warp|masque) identity found|provisioning dedicated/i, stage: 'provision', fa: 'ساخت هویت جدید روی کلادفلر' },
    { re: /enrolling masque key/i, stage: 'provision', fa: 'ثبت کلید MASQUE' },
    { re: /enrolling this device into the zero trust/i, stage: 'provision', fa: 'ثبت‌نام در سازمان Zero Trust' },
    { re: /loaded existing (warp|masque) identity/i, stage: 'identity', fa: 'هویت ذخیره‌شده بارگذاری شد' },
    // Engine 1.9.0 wording (api.rs) for the same two events.
    { re: /loaded an existing identity from/i, stage: 'identity', fa: 'هویت ذخیره‌شده بارگذاری شد' },
    { re: /no identity at .*provisioning a new one/i, stage: 'provision', fa: 'ساخت هویت جدید روی کلادفلر' },
    { re: /provisioned and saved new (warp|masque) identity/i, stage: 'identity', fa: 'هویت تازه ساخته و ذخیره شد' },
    { re: /identity ready: device=(\S+)/i, stage: 'identity', fa: 'هویت آماده است' },
    { re: /reusing the saved enrolment for team/i, stage: 'identity', fa: 'هویت تیمی ذخیره‌شده بارگذاری شد' },
    { re: /verifying cached gateway|verifying cached wireguard endpoint/i, stage: 'quickcheck', fa: 'بررسی گیت‌وی قبلی' },
    { re: /verifying the endpoint the organization assigned/i, stage: 'quickcheck', fa: 'بررسی اندپوینت اختصاص‌داده‌شده سازمان' },
    { re: /the assigned endpoint .* works/i, stage: 'quickcheck', fa: 'اندپوینت سازمان سالم است — بدون اسکن' },
    { re: /the assigned endpoint .* did not (answer|pass validation)/i, stage: 'scan', fa: 'اندپوینت سازمان جواب نداد — اسکن مجدد' },
    { re: /cached (gateway|endpoint) .* still works/i, stage: 'quickcheck', fa: 'گیت‌وی قبلی سالم است — بدون اسکن' },
    { re: /cached (gateway|endpoint) .* no longer works/i, stage: 'scan', fa: 'گیت‌وی قبلی از کار افتاده — اسکن مجدد' },
    { re: /candidate ok (\S+):(\d+)/i, stage: 'scan', fa: 'سرور سالم پیدا شد' },
    { re: /hunting for a working masque gateway/i, stage: 'scan', fa: 'جستجوی گیت‌وی MASQUE' },
    // Engine 1.7.0 interpolates the wanted count into this line — "hunting for 2 working
    // WireGuard endpoint(s)" — so the old literal never matched again. Every rule that spans
    // an interpolated value now uses `.*` for exactly this reason.
    { re: /hunting for .*working wireguard endpoint/i, stage: 'scan', fa: 'جستجوی اندپوینت WireGuard' },
    { re: /retrying last known-good (wireguard endpoint|gateway) .*before rescanning/i,
      stage: 'quickcheck', fa: 'تلاش دوباره با آخرین سرور سالم' },
    { re: /selected masque gateway (\S+):(\d+)/i, stage: 'selected', fa: 'گیت‌وی انتخاب شد' },
    { re: /selected wireguard endpoint (\S+):(\d+)/i, stage: 'selected', fa: 'اندپوینت انتخاب شد' },
    { re: /using forced peer/i, stage: 'selected', fa: 'استفاده از سرور دستی' },
    { re: /using cloudflare edge/i, stage: 'selected', fa: 'اتصال به لبه‌ی کلادفلر' },
    // These two replace `confirming wireguard handshake` and `handshake successful`, which
    // were checked against the engine's source and its shipped binary and exist in NEITHER —
    // they never matched anything, in 1.6.0 either. What the engine actually prints when a
    // handshake succeeds is the profile line below; the per-handshake detail is trace-level
    // and never reaches us at the log level we run.
    { re: /profile .*passed handshake \+ data-plane/i, stage: 'handshake', fa: 'دست‌دادن و عبور داده تأیید شد' },
    { re: /aethernoize (primary )?profile:/i, stage: 'handshake', fa: 'پروفایل استتار انتخاب شد' },
    { re: /validating wireguard tunnel/i, stage: 'handshake', fa: 'اعتبارسنجی تونل WireGuard' },
    { re: /wireguard tunnel validated/i, stage: 'handshake', fa: 'تونل WireGuard تأیید شد' },
    { re: /establishing outer warp tunnel/i, stage: 'handshake', fa: 'برقراری تونل بیرونی' },
    { re: /establishing inner warp tunnel/i, stage: 'handshake', fa: 'برقراری تونل داخلی (تونل در تونل)' },
    { re: /masque transport: http\/3/i, stage: 'tunnel', fa: 'تونل MASQUE روی HTTP/3 (QUIC)' },
    { re: /masque transport: http\/2/i, stage: 'tunnel', fa: 'تونل MASQUE روی HTTP/2 (TCP)' },
    { re: /validating masque data-plane/i, stage: 'validate', fa: 'اعتبارسنجی عبور واقعی داده' },
    { re: /masque tunnel validated/i, stage: 'validate', fa: 'عبور داده تأیید شد' },
    // The peer address sits between these words in the real line, so the literal never hit.
    { re: /inner endpoint .*tunneled through outer warp/i, stage: 'handshake', fa: 'تونل داخلی از دل تونل بیرونی رد شد' },
    { re: /ironclad verified .*real http round trip/i, stage: 'validate', fa: 'یک درخواست واقعی HTTP از سرور رد شد' },
    { re: /socks5 (server )?listening on/i, stage: 'connected', fa: 'متصل شد — پراکسی آماده است' },
    { re: /tunnel (closed|ended|exited).*reconnect/i, stage: 'reconnecting', fa: 'قطع شد — اتصال مجدد' },
    { re: /gool tunnel closed/i, stage: 'reconnecting', fa: 'تونل Gool قطع شد — اتصال مجدد' },
    { re: /gool tunnel ended/i, stage: 'reconnecting', fa: 'تونل Gool قطع شد — اتصال مجدد' },
    { re: /no usable masque gateway found/i, stage: 'scan', fa: 'گیت‌وی سالمی پیدا نشد — اسکن مجدد' },
    { re: /no usable.*endpoint found/i, stage: 'scan', fa: 'اندپوینت سالمی پیدا نشد — اسکن مجدد' },
    // Must precede the fatal rule below: this one means "retrying with another profile",
    // not "give up".
    { re: /found no data-plane endpoint.*trying next profile/i, stage: 'scan', fa: 'این پروفایل جواب نداد — پروفایل بعدی' },
    { re: /prober: no clean endpoint found|no clean endpoint found/i, stage: 'failed', fa: 'هیچ اندپوینت سالمی پیدا نشد' },
    // Both forms, deliberately. Engine 1.7.0's source only raises "handshake init failed",
    // but the binary we ship today also emits a plain "handshake failed: <reason>" — and the
    // app has to classify BOTH correctly during the period when either version may be
    // installed. Narrowing this to the 1.7.0 wording alone is what the suite caught.
    { re: /handshake (init )?failed/i, stage: 'failed', fa: 'دست‌دادن ناموفق' },

    // NEW IN ENGINE 1.7.0, and it names a failure this app has been unable to explain until
    // now: Cloudflare can stop accepting a saved identity, after which the handshake still
    // succeeds and NO TRAFFIC PASSES. That is the "connected but nothing opens" state. The
    // engine now detects it and re-registers the device by itself, so this is reported as
    // progress rather than as an error.
    { re: /cloudflare no longer accepts the saved identity/i,
      stage: 'provision', fa: 'کلادفلر هویت قبلی را نپذیرفت — ساخت هویت تازه' },
    { re: /will handshake but carry no traffic until this identity is replaced/i,
      stage: 'provision', fa: 'تونل بدون هویت معتبر ترافیک عبور نمی‌دهد — در حال تعویض' },
    // Engine 1.9.0: the same replacement, reported per protocol.
    { re: /the saved masque identity was refused/i,
      stage: 'provision', fa: 'کلادفلر هویت MASQUE را نپذیرفت — ساخت هویت تازه' },
    { re: /registering a fresh (wireguard|masque) account to replace the refused identity/i,
      stage: 'provision', fa: 'ساخت حساب تازه به‌جای هویت ردشده' },
    // A scan round that found nothing. The engine rescans on its own right after, so this is
    // progress to report, not the end — the fatal case is still "no clean endpoint" above.
    { re: /scan deadline reached with no (gateway|endpoint)/i,
      stage: 'scan', fa: 'در این دور سروری پیدا نشد — دوباره جستجو می‌شود' },
    // A WireGuard tunnel that went silent, or whose socket kept failing: the data path is gone
    // and the engine is about to rebuild it. Without these the badge stayed green over it.
    { re: /no valid data from peer .*tunnel considered dead/i,
      stage: 'reconnecting', fa: 'از سرور داده‌ای نرسید — اتصال مجدد' },
    { re: /giving up after \d+ consecutive transient failures/i,
      stage: 'reconnecting', fa: 'خطای پیاپی شبکه — اتصال مجدد' },
    { re: /the account moved this device from .*using the assigned address/i,
      stage: 'identity', fa: 'کلادفلر آدرس تازه‌ای به این دستگاه داد' },
    { re: /tunnel failed validation/i, stage: 'failed', fa: 'اعتبارسنجی تونل ناموفق' },
    { re: /zero trust sign-in failed/i, stage: 'failed', fa: 'ورود به Zero Trust ناموفق' },

    // Catch-alls, deliberately LAST so every specific rule above keeps its own wording.
    // The gool inner tunnel (main.rs:1274/1278) and the pre-validation exits (main.rs:806)
    // report a dead data plane WITHOUT the word "reconnect", so the narrower rule further up
    // misses them. Missing them is what left the UI green after the tunnel was already gone.
    { re: /tunnel (closed|ended|exited)|tunnel failed before validation/i,
      stage: 'reconnecting', fa: 'تونل قطع شد — اتصال مجدد' },
    { re: /rescanning|scanning fresh/i, stage: 'scan', fa: 'اسکن مجدد' },
];

// Lines worth calling out in the log even though they don't advance the stage.
const NOTE_RULES = [
    { re: /enrolling masque key for device/i, fa: 'ثبت کلید MASQUE روی حساب' },
    { re: /masque key enrolled/i, fa: 'کلید MASQUE ثبت شد' },
    { re: /host has no ipv6 route/i, fa: '⚠️ این شبکه IPv6 ندارد — به IPv4 برمی‌گردد' },
    { re: /(candidate|wg candidate) ok (\S+):(\d+)/i, fa: 'سرور سالم پیدا شد' },
    { re: /no new (gateways|endpoints) recently, finalizing/i, fa: 'پایان اسکن — انتخاب بهترین' },
    { re: /reached target of \d+ (gateways|endpoints)/i, fa: 'به تعداد هدف رسید — انتخاب بهترین' },
    { re: /profile '.*' passed handshake/i, fa: 'پروفایل مبهم‌سازی جواب داد' },
    { re: /profile '.*' failed on forced peer|found no data-plane endpoint/i, fa: 'این پروفایل جواب نداد — بعدی' },
    { re: /ech auto-fetch failed/i, fa: '⚠️ دریافت ECH ناموفق — بدون ECH ادامه می‌دهد' },
    { re: /performance profile: (\S+)/i, fa: 'سطح عملکرد سخت‌افزار تشخیص داده شد' },
    { re: /gateway filtering active/i, fa: 'فیلتر Gateway سازمان فعال شد' },
    { re: /signed in to team/i, fa: '✅ وارد تیم Zero Trust شد' },
    { re: /staying on personal warp/i, fa: 'ادامه با WARP شخصی (بدون تیم)' },
    { re: /the organization assigned endpoint/i, fa: 'اندپوینت اختصاص‌داده‌شده سازمان' },
    { re: /retrying last known-good/i, fa: 'تلاش مجدد با آخرین سرور سالم' },
    { re: /blacklisting and rescanning/i, fa: '⚠️ سرور بلاک‌لیست شد — اسکن مجدد' },
    { re: /outer endpoint .*failed.*times in a row/i, fa: '⚠️ اندپوینت بیرونی چند بار ناموفق — اسکن مجدد' },
    { re: /endpoint.*failed.*DPI-throttled/i, fa: '⚠️ DPI شناسایی شد — اندپوینت عوض می‌شود' },
    // Engine 1.9.0.
    { re: /registration failed over the direct route|key enrollment failed over the direct route/i,
      fa: 'ثبت‌نام از مسیر مستقیم نشد — از مسیر استتارشده امتحان می‌شود' },
    { re: /retrying over a camouflaged route/i, fa: 'تلاش از مسیر استتارشده (آدرس لبه‌ی تصادفی کلادفلر، بدون DNS)' },
    { re: /went through the camouflaged route/i, fa: '✅ ثبت‌نام از مسیر استتارشده انجام شد' },
    { re: /accepts control but drops traffic/i, fa: '⚠️ این گیت‌وی اتصال را پذیرفت ولی داده رد نکرد — گیت‌وی دیگری امتحان می‌شود' },
    // MLMVPN engine patch (quic.rs / masque_h2.rs): a session whose TCP the edge stalls.
    { re: /tcp handshake unanswered|carries udp but tcp got no answer/i,
      fa: 'این نشست TCP را رد نمی‌کرد (فقط UDP) — یک نشست تازه باز می‌شود' },
    { re: /failed \d+ times in a row; excluding it/i, fa: '⚠️ این سرور چند بار پشت سر هم جواب نداد — موقتاً کنار گذاشته شد' },
    { re: /best (wg )?(gateway|endpoint) /i, fa: 'بهترین سرور این دور انتخاب شد' },
    { re: /found \d+ endpoints on separate addresses/i, fa: 'دو سرور روی دو آدرس جدا پیدا شد (تونل در تونل)' },
    { re: /aether v[\d.]+/i, fa: 'نسخه موتور وارپ' },
];

// Progress hints that are worth surfacing but don't change the stage.
function extractDetail(line) {
    let m;
    if ((m = line.match(/selected (?:MASQUE gateway|WireGuard endpoint) (\S+?):(\d+)(?:.*rtt ([^)]+))?/i))) {
        return { server: `${m[1]}:${m[2]}`, rtt: m[3] || null };
    }
    if ((m = line.match(/using cloudflare edge (\S+)/i))) return { server: m[1] };
    if ((m = line.match(/obfuscation profile: (\S+)|aethernoize (?:primary )?profile: (\S+)/i))) {
        return { profile: m[1] || m[2] };
    }
    if ((m = line.match(/socks5 (?:server )?listening on (\S+)/i))) return { socks: m[1] };
    return null;
}

// At debug level the engine emits tens of lines per second, mostly per-packet obfuscation
// chatter. Running 30+ regexes over each one — then JSON-encoding and broadcasting it — makes
// Node the bottleneck, fills the stdout pipe, and blocks the engine mid-handshake. These lines
// carry no diagnostic value, so drop them before any of that work happens.
// Per-packet QUIC lines are the single largest source of log volume once traffic starts —
// one "recv N bytes" plus one "recv N bytes type=..." for every datagram. At video bitrates
// that is thousands of lines a second, which buries every line that actually matters.
const NOISE_RE = /\] (junk(\[\d+\]|_after\[\d+\])? sent|signature i\d sent|sending \d+ junk|obfuscation pre-handshake complete|verify recv \d+ bytes|recv \d+ bytes (from|type=))/;

function isNoise(line) {
    return NOISE_RE.test(line);
}

function classify(line) {
    for (const rule of STAGE_RULES) {
        if (rule.re.test(line)) return rule;
    }
    return null;
}

function classifyNote(line) {
    for (const rule of NOTE_RULES) {
        if (rule.re.test(line)) return rule;
    }
    return null;
}

// ============================================================
// Configuration validation
// ============================================================
// Every value below reaches the engine as an environment variable and is acted on without
// further checking. A bad one does not fail cleanly: the engine either rejects it late (after
// the UI has already moved to "connecting" and the user has waited through a scan) or accepts
// something nonsensical and behaves oddly for reasons nothing reports. Validating here means
// a wrong setting is a message before anything starts, not a tunnel that half comes up.
const VALID_PROTOCOLS = ['masque', 'wg', 'gool'];
const VALID_SCANS = ['turbo', 'balanced', 'thorough', 'stealth', 'ironclad'];
const VALID_IP = ['v4', 'v6', 'both'];
const VALID_PERF = ['low', 'medium', 'high'];
const VALID_LOG = ['error', 'warn', 'info', 'debug', 'trace'];

// host:port where host is IPv4, IPv6-in-brackets, or a hostname.
const ENDPOINT_RE = /^(?:\[[0-9a-fA-F:]+\]|[0-9]{1,3}(?:\.[0-9]{1,3}){3}|[A-Za-z0-9._-]+):([0-9]{1,5})$/;

function validateEndpoint(value, label, errors) {
    const m = String(value).match(ENDPOINT_RE);
    if (!m) { errors.push(`${label} باید به شکل «آدرس:پورت» باشد (مثلاً 162.159.198.1:443).`); return; }
    const port = parseInt(m[1], 10);
    if (!(port > 0 && port <= 65535)) errors.push(`${label}: پورت ${port} معتبر نیست (۱ تا ۶۵۵۳۵).`);
}

/**
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
function validateOptions(opts) {
    const o = opts || {};
    const errors = [];
    const warnings = [];

    if (o.protocol !== undefined && !VALID_PROTOCOLS.includes(o.protocol)) {
        errors.push(`پروتکل «${o.protocol}» شناخته نشد (${VALID_PROTOCOLS.join(' | ')}).`);
    }
    if (o.scan !== undefined && !VALID_SCANS.includes(o.scan)) {
        errors.push(`حالت اسکن «${o.scan}» شناخته نشد (${VALID_SCANS.join(' | ')}).`);
    }
    if (o.ip !== undefined && !VALID_IP.includes(o.ip)) {
        errors.push(`نسخه‌ی IP «${o.ip}» شناخته نشد (${VALID_IP.join(' | ')}).`);
    }
    if (o.perfProfile !== undefined && !VALID_PERF.includes(o.perfProfile)) {
        errors.push(`سطح عملکرد «${o.perfProfile}» شناخته نشد (${VALID_PERF.join(' | ')}).`);
    }
    if (o.logLevel !== undefined && !VALID_LOG.includes(o.logLevel)) {
        errors.push(`سطح لاگ «${o.logLevel}» شناخته نشد (${VALID_LOG.join(' | ')}).`);
    }

    const port = o.socksPort === undefined ? SOCKS_PORT : Number(o.socksPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        errors.push(`پورت SOCKS «${o.socksPort}» معتبر نیست.`);
    } else if (port === require('./network-settings').get().httpPort || port === require('./network-settings').get().socksPort) {
        // Xray's inbound. Two listeners on one port is a race whose loser fails with an
        // opaque bind error long after the UI has said "connecting".
        errors.push(`پورت SOCKS نمی‌تواند ${port} باشد؛ این پورت متعلق به Xray است.`);
    }

    if (o.peer) validateEndpoint(o.peer, 'سرور دستی', errors);
    // ONE endpoint, never a list: `AETHER_WG_PEER` is parsed with `SocketAddr::parse`, so a
    // comma-joined string makes the engine exit with «bad peer address». «وارپ» used to send
    // eleven of them here and could not start at all — see aeEngineOpts in components/aether.js.
    if (o.wgPeer) validateEndpoint(o.wgPeer, 'سرور دستی WireGuard', errors);

    if (o.keepalive !== undefined) {
        const k = Number(o.keepalive);
        // 0 is a legitimate "off" for WireGuard, but behind NAT it guarantees the tunnel dies
        // silently once the mapping expires — which is one of the shapes of "it works for a
        // few minutes and then stops".
        if (!Number.isInteger(k) || k < 0 || k > 65535) errors.push(`keepalive «${o.keepalive}» معتبر نیست (۰ تا ۶۵۵۳۵ ثانیه).`);
        else if (k === 0) warnings.push('keepalive صفر است: پشت NAT، تونل بعد از چند دقیقه بی‌صدا می‌میرد.');
        else if (k > 120) warnings.push(`keepalive ${k} ثانیه از عمر معمول NAT بیشتر است و ممکن است تونل قطع شود.`);
    }

    for (const [key, label] of [['validateSecs', 'مهلت اعتبارسنجی'], ['reconnectSecs', 'فاصله‌ی اتصال مجدد'],
                                ['wgValidateSecs', 'مهلت اعتبارسنجی WireGuard'], ['wgReconnectSecs', 'فاصله‌ی اتصال مجدد WireGuard']]) {
        if (o[key] === undefined) continue;
        const v = Number(o[key]);
        if (!Number.isInteger(v) || v < 0 || v > 600) errors.push(`${label} «${o[key]}» معتبر نیست (۰ تا ۶۰۰ ثانیه).`);
    }

    if (o.dns !== undefined) {
        const list = String(o.dns).split(',').map(s => s.trim()).filter(Boolean);
        if (!list.length) errors.push('فهرست DNS داخل تونل خالی است.');
        for (const s of list) {
            const v4 = /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(s);
            const v6 = /^[0-9a-fA-F:]+$/.test(s) && s.includes(':');
            if (!v4 && !v6) errors.push(`آدرس DNS «${s}» معتبر نیست.`);
            else if (v4 && s.split('.').some(p => Number(p) > 255)) errors.push(`آدرس DNS «${s}» معتبر نیست.`);
        }
    }

    if (o.bootstrapProxy !== undefined && o.bootstrapProxy) {
        try {
            const u = new URL(o.bootstrapProxy);
            if (!/^(https?|socks5h?):$/.test(u.protocol)) {
                errors.push(`پراکسی ثبت‌نام «${o.bootstrapProxy}»: فقط http/https/socks5 پشتیبانی می‌شود.`);
            }
        } catch (e) {
            errors.push(`پراکسی ثبت‌نام «${o.bootstrapProxy}» یک آدرس معتبر نیست.`);
        }
    }

    if (o.fragmentSize !== undefined) {
        const s = String(o.fragmentSize);
        if (!/^\d+(-\d+)?$/.test(s)) errors.push(`اندازه‌ی فرگمنت «${s}» معتبر نیست (مثلاً 16-32).`);
    }
    if (o.fragmentDelay !== undefined) {
        const s = String(o.fragmentDelay);
        if (!/^\d+(-\d+)?$/.test(s)) errors.push(`تأخیر فرگمنت «${s}» معتبر نیست (مثلاً 2-10).`);
    }

    // Combinations that are individually valid and together meaningless.
    if (o.fragment && o.transport !== 'h2') {
        warnings.push('فرگمنت ClientHello فقط روی ترنسپورت HTTP/2 اثر دارد؛ روی HTTP/3 نادیده گرفته می‌شود.');
    }
    if ((o.protocol === 'wg' || o.protocol === 'gool') && o.ech) {
        warnings.push('ECH فقط برای MASQUE معنا دارد و در حالت WireGuard نادیده گرفته می‌شود.');
    }

    return { ok: errors.length === 0, errors, warnings };
}

// ============================================================
// Environment construction
// ============================================================
// Mirrors aether/src/cli.rs — every flag there just sets one of these variables.
function buildEnv(opts) {
    const o = opts || {};
    const env = Object.assign({}, process.env);

    // Surface Rust panics with a backtrace so a crash tells us the exact line.
    env.RUST_BACKTRACE = o.backtrace === false ? '0' : '1';

    // v1.5.0: AETHER_LOG_LEVEL replaces the old RUST_LOG approach. The engine handles
    // level filtering internally with `aether=<level>` in its env_logger setup.
    const logLevel = o.debug ? 'debug' : (o.logLevel || (o.verbose ? 'debug' : 'info'));
    env.AETHER_LOG_LEVEL = logLevel;
    // Keep RUST_LOG as a fallback in case an older binary is accidentally used.
    env.RUST_LOG = logLevel === 'trace' ? 'trace' : (logLevel === 'debug' ? 'debug' : 'info');

    env.AETHER_SOCKS = `127.0.0.1:${o.socksPort || SOCKS_PORT}`;
    env.AETHER_PROTOCOL = o.protocol || 'masque';       // masque | wg | gool
    env.AETHER_SCAN = o.scan || 'balanced';             // turbo | balanced | thorough | stealth | ironclad
    env.AETHER_IP = o.ip || 'v4';                       // v4 | v6 | both

    // Never let the binary block on a terminal prompt: answer the quick-reconnect question.
    env.AETHER_QUICK_RECONNECT = o.quickReconnect === false ? '0' : '1';

    // Keep identity files inside the per-protocol config path we control.
    env.AETHER_CONFIG = path.join(ensureDataDir(), 'aether.toml');

    if (o.noize) env.AETHER_NOIZE = o.noize;

    // v1.5.0: DNS resolvers used inside the tunnel (default 1.1.1.1,1.0.0.1).
    if (o.dns) env.AETHER_DNS = o.dns;

    // v1.5.0: hardware performance profile override (low | medium | high).
    if (o.perfProfile) env.AETHER_PERF_PROFILE = o.perfProfile;

    if (o.protocol === 'masque' || !o.protocol) {
        if (o.transport === 'h2') env.AETHER_MASQUE_HTTP2 = '1';
        if (o.ech) env.AETHER_ECH = o.ech;              // 'auto' or a base64 ECHConfigList
        if (o.fragment) {
            env.AETHER_MASQUE_H2_FRAGMENT = '1';
            if (o.fragmentSize) env.AETHER_MASQUE_H2_FRAGMENT_SIZE = String(o.fragmentSize);
            if (o.fragmentDelay) env.AETHER_MASQUE_H2_FRAGMENT_DELAY = String(o.fragmentDelay);
        }
        if (o.validateSecs) env.AETHER_MASQUE_VALIDATE_SECS = String(o.validateSecs);
        if (o.reconnectSecs) env.AETHER_MASQUE_RECONNECT_SECS = String(o.reconnectSecs);
        if (o.noDataCheck) {
            env.AETHER_MASQUE_NO_DATA_CHECK = '1';
            env.AETHER_WG_NO_DATA_CHECK = '1';
        }
    }

    if (o.protocol === 'wg' || o.protocol === 'gool') {
        if (o.keepalive) env.AETHER_WG_KEEPALIVE = String(o.keepalive);
        if (o.noProfileRetry) env.AETHER_WG_NO_PROFILE_RETRY = '1';
        // v1.5.0: WireGuard-specific validation and reconnect timeouts.
        if (o.wgValidateSecs) env.AETHER_WG_VALIDATE_SECS = String(o.wgValidateSecs);
        if (o.wgReconnectSecs) env.AETHER_WG_RECONNECT_SECS = String(o.wgReconnectSecs);
    }

    if (o.peer) env.AETHER_PEER = o.peer;
    if (o.wgPeer) env.AETHER_WG_PEER = o.wgPeer;

    // v1.5.0: Zero Trust / WARP for Teams — reserved for future UI integration.
    if (o.team) env.AETHER_TEAM = o.team;
    if (o.accessId) env.AETHER_ACCESS_CLIENT_ID = o.accessId;
    if (o.accessSecret) env.AETHER_ACCESS_CLIENT_SECRET = o.accessSecret;
    if (o.accessToken) env.AETHER_ACCESS_TOKEN = o.accessToken;
    if (o.accessEmail) env.AETHER_ACCESS_EMAIL = o.accessEmail;
    if (o.gateway) env.AETHER_GATEWAY = '1';

    // v1.5.0: Routing rules (block / direct / proxy).
    if (o.routeBlock) env.AETHER_ROUTE_BLOCK = o.routeBlock;
    if (o.routeDirect) env.AETHER_ROUTE_DIRECT = o.routeDirect;
    if (o.routesFile) env.AETHER_ROUTES_FILE = o.routesFile;

    // The first run must register a device against api.cloudflareclient.com to get an identity.
    // That call goes through reqwest, which honours HTTPS_PROXY/HTTP_PROXY; the tunnel data path
    // uses raw sockets and is unaffected. So on networks where the API is unreachable directly,
    // pointing these at an already-working proxy bootstraps registration without routing any
    // tunnel traffic through it. Only set them when the caller explicitly asked for it — the
    // API is reachable directly on many networks, and a dead proxy here breaks an otherwise
    // working setup.
    if (o.bootstrapProxy === 'http://127.0.0.1:20809') {
        // What the page sends to mean "the app's own Xray" — which «پورت محلی» may have moved.
        o.bootstrapProxy = `http://127.0.0.1:${require('./network-settings').get().httpPort}`;
    }
    if (o.bootstrapProxy) {
        env.HTTPS_PROXY = o.bootstrapProxy;
        env.HTTP_PROXY = o.bootstrapProxy;
        env.https_proxy = o.bootstrapProxy;
        env.http_proxy = o.bootstrapProxy;
    } else {
        // Make sure a stale value from the parent environment doesn't leak in.
        delete env.HTTPS_PROXY; delete env.HTTP_PROXY;
        delete env.https_proxy; delete env.http_proxy;
    }

    // In debug mode, log the full environment going to the engine.
    if (debugMode) {
        const aetherEnvs = Object.keys(env)
            .filter(k => k.startsWith('AETHER_') || k.startsWith('RUST_'))
            .map(k => `  ${k}=${env[k]}`)
            .join('\n');
        debugLog('DEBUG', 'ENV', `Environment variables sent to engine:\n${aetherEnvs}`);
    }

    return env;
}

// Human-readable summary of what we're about to run, so the core log explains itself.
function describeOptions(o) {
    const lines = [];
    const protoFa = { masque: 'MASQUE', wg: 'WireGuard', gool: 'WARP-in-WARP (تونل در تونل)' };
    lines.push(`پروتکل: ${protoFa[o.protocol] || o.protocol}`);
    if (o.protocol === 'masque') {
        lines.push(`ترنسپورت: ${o.transport === 'h2' ? 'HTTP/2 (TCP)' : 'HTTP/3 (QUIC)'}`);
        if (o.ech) lines.push(`ECH: ${o.ech}`);
        if (o.fragment) lines.push(`فرگمنت ClientHello: فعال (${o.fragmentSize || '16-32'} بایت / ${o.fragmentDelay || '2-10'}ms)`);
    }
    if (o.protocol === 'wg' || o.protocol === 'gool') {
        lines.push(`keepalive: ${o.keepalive || 5} ثانیه`);
        lines.push(`تلاش مجدد با پروفایل‌های دیگر: ${o.noProfileRetry ? 'خیر' : 'بله'}`);
    }
    const scan = o.scan || 'turbo';
    lines.push(`حالت اسکن: ${scan}`);
    // The scan modes differ in when they stop, not just how fast they are — spell that out so a
    // long scan doesn't look like a hang.
    if (scan === 'balanced') lines.push('  ↳ تا ۶ سرور سالم می‌گردد و بهترین را برمی‌دارد؛ اگر ۱۲ ثانیه سرور تازه‌ای پیدا نشود، با بهترینِ پیداشده وصل می‌شود (حداکثر ۲ دقیقه)');
    else if (scan === 'turbo') lines.push('  ↳ با اولین سرور سالم وصل می‌شود');
    else if (scan === 'thorough') lines.push('  ↳ جستجوی عمیق برای کم‌ترین پینگ — طولانی‌ترین حالت');
    else if (scan === 'stealth') lines.push('  ↳ آرام و کم‌سروصدا — عمداً کند است');
    else if (scan === 'ironclad') lines.push('  ↳ تست واقعی تونل + HTTP برای هر کاندید — مطمئن‌ترین حالت');
    lines.push(`نسخه IP: ${o.ip || 'v4'}`);
    lines.push(`مبهم‌سازی: ${o.noize || (o.protocol === 'masque' ? 'firewall (پیش‌فرض)' : 'balanced (پیش‌فرض)')}`);
    lines.push(`پورت SOCKS: 127.0.0.1:${o.socksPort || SOCKS_PORT}`);
    const ll = o.debug ? 'debug' : (o.logLevel || 'info');
    lines.push(`سطح لاگ: ${ll}`);
    if (o.dns) lines.push(`DNS داخل تونل: ${o.dns}`);
    if (o.perfProfile) lines.push(`سطح عملکرد: ${o.perfProfile}`);
    if (o.team) lines.push(`سازمان Zero Trust: ${o.team}`);
    if (o.debug) lines.push('🔍 حالت دیباگ فعال است — لاگ کامل در فایل ذخیره می‌شود');
    if (o.bootstrapProxy) lines.push(`ثبت‌نام از طریق پراکسی: ${o.bootstrapProxy}`);
    return lines;
}

// Is something actually accepting connections at this proxy URL?
// Cheap TCP connect — enough to tell "engine is up" from "port is empty".
function isProxyAlive(proxyUrl, timeoutMs = 1500) {
    return new Promise((resolve) => {
        let host, port;
        try {
            const u = new URL(proxyUrl);
            host = u.hostname;
            port = parseInt(u.port, 10);
        } catch (e) { return resolve(false); }
        if (!host || !port) return resolve(false);

        const net = require('net');
        const sock = new net.Socket();
        const done = (ok) => { try { sock.destroy(); } catch (e) {} resolve(ok); };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
        sock.connect(port, host);
    });
}


// ============================================================
// Lifecycle
// ============================================================
function pushLog(line) {
    logBuffer.push(line);
    if (logBuffer.length > MAX_LOG_BUFFER) logBuffer.shift();
}

/**
 * Start the engine.
 * @param opts see buildEnv()
 * @param onLog  (text) => void            raw core-log line
 * @param onStage (stateObject) => void    structured stage change
 */
async function startAether(opts, onLog, onStage, onDebug) {
    stopAether();

    // Claim ownership of the module state. Anything still in flight from the previous run
    // now carries a stale id and is ignored.
    const mySession = ++sessionId;
    const owns = () => sessionId === mySession;

    const o = opts || {};

    // Validate BEFORE anything is spawned or any state is claimed. A configuration error that
    // surfaces after the engine is running costs the user a full scan to find out, and can
    // leave a half-started tunnel behind.
    const v = validateOptions(Object.assign({ socksPort: o.socksPort || SOCKS_PORT }, o));
    if (!v.ok) {
        throw new Error('تنظیمات نامعتبر است:\n' + v.errors.map(e => `  • ${e}`).join('\n'));
    }

    // A start the user asked for resets the budget; an automatic rescan spends from it.
    // `__transportLadder` is the same idea for the UDP→TCP retry below: it marks the second
    // rung so the ladder can never become a loop.
    if (!o.__dudRetry && !o.__transportLadder) { dudRetries = 0; rejectedGateways = []; }
    debugMode = !!o.debug;
    debugCallbacks.onDebug = onDebug || null;
    startDebugSession();
    const exePath = getExePath();
    const log = (t) => { pushLog(t); if (onLog) onLog(t); };

    if (!fs.existsSync(exePath)) {
        throw new Error(`فایل aether.exe در پوشه core پیدا نشد: ${exePath}`);
    }

    logBuffer = [];

    // A bootstrap proxy that isn't actually listening turns a working direct setup into a
    // failed run, with an error that looks like censorship. Check it first and drop it if dead.
    if (o.bootstrapProxy) {
        const alive = await isProxyAlive(o.bootstrapProxy);
        if (!alive) {
            log(`[WARP] ⚠️ پراکسی ${o.bootstrapProxy} پاسخ نمی‌دهد (چیزی روی آن پورت گوش نمی‌دهد).`);
            log('[WARP] ثبت‌نام به‌صورت مستقیم انجام می‌شود.');
            o.bootstrapProxy = null;
        } else {
            log(`[WARP] پراکسی ${o.bootstrapProxy} فعال است.`);
        }
    }
    const socksPort = o.socksPort || SOCKS_PORT;

    currentState = {
        running: true,
        stage: 'starting',
        stageFa: 'در حال راه‌اندازی موتور',
        protocol: o.protocol || 'masque',
        socks: `127.0.0.1:${socksPort}`,
        server: null,
        rtt: null,
        profile: null,
        connected: false,
        error: null,
        startedAt: Date.now(),
    };

    const emitStage = () => { if (onStage) onStage(Object.assign({}, currentState)); };

    // Suppressed lines still prove the engine is alive, so summarise them occasionally
    // instead of going silent during a long scan.
    let noiseCount = 0;
    if (noiseTimer) clearInterval(noiseTimer);
    noiseTimer = setInterval(() => {
        if (noiseCount > 0) {
            log(`[WARP] … ${noiseCount} خط جزئیات مبهم‌سازی/بسته (نمایش داده نشد)`);
            noiseCount = 0;
        }
    }, 5000);

    log('════════════════════════════════════════');
    // The engine prints its own version as its first line ("Aether v2.0.0"); naming one here
    // went stale the day the binary was upgraded, and it can now be upgraded from the store
    // without this file changing at all.
    log('[WARP] راه‌اندازی موتور وارپ');
    log(`[WARP] مسیر اجرا: ${exePath}`);
    log(`[WARP] پوشه داده: ${AETHER_DATA_DIR}`);
    if (debugMode && debugLogPath) log(`[WARP] 🔍 لاگ دیباگ: ${debugLogPath}`);
    describeOptions(Object.assign({ socksPort }, o)).forEach(l => log('[WARP] ' + l));
    v.warnings.forEach(w => log(`[WARP] ⚠️ ${w}`));
    log('════════════════════════════════════════');
    if (debugMode) debugLog('INFO', 'START', `Engine started: ${exePath}`);
    emitStage();

    const env = buildEnv(Object.assign({ socksPort }, o));
    ensureDataDir();

    // Held in a local as well as the module slot: every handler below tests `proc` against
    // the module slot, so a handler belonging to a replaced process cannot clear or mutate
    // its successor's state.
    const proc = spawn(exePath, [], {
        env,
        cwd: AETHER_DATA_DIR,
        windowsHide: true,
    });
    aetherProcess = proc;

    // Fires once per engine start. Without it a mid-session reconnect (the engine relogs
    // "socks5 server listening" every time it re-establishes) would re-probe and could
    // restart the engine underneath a user who is mid-download.
    // The engine prints TWO lines that both classify as 'connected', one millisecond apart:
    //
    //     [+] socks5 server listening on 127.0.0.1:20810      (aether)
    //     socks5 listening on 127.0.0.1:20810                 (aether::socks)
    //
    // Only the first may start the measurement. `speedGateRan` blocks the second from starting
    // a duplicate probe, and `speedGateDone` marks that this session has been measured at all,
    // so a later re-establish comes straight back up instead of re-probing.
    let speedGateRan = false;
    let speedGateDone = false;

    // Declare the tunnel usable and tell the UI.
    const markConnected = (note) => {
        if (!owns()) return;
        currentState.connected = true;
        currentState.stage = 'connected';
        currentState.stageFa = 'متصل شد — پراکسی آماده است';
        log('[WARP] ✅ تونل برقرار شد.');
        if (note) log(note);
        // Deliberately no system-proxy change here. Aether is a transport that Xray dials
        // through; Windows proxy settings belong to Xray so the user can toggle them live
        // without touching the tunnel.
        log(`[WARP] SOCKS5 آماده: 127.0.0.1:${socksPort}`);
        log('[WARP] Xray می‌تواند از این پورت خارج شود (زنجیره).');
        emitStage();
    };

    // Measure the finished tunnel — and, by default, do nothing but report the number.
    //
    // WHY THIS NO LONGER TEARS A TUNNEL DOWN.
    //
    // The upstream CLI connects and stops there: scan, handshake, socks5, done, ~3 seconds. The
    // gate was an addition of ours meant to reject a gateway that handshakes but carries almost
    // nothing. In practice it did far more harm than good, for three reasons that only became
    // visible with real measurements side by side:
    //
    //   1. The measurement is not repeatable. The same gateway on the same line in the same
    //      few minutes read 77, 195, 56 and 586 KB/s. A 3 MB download over 12 seconds through a
    //      QUIC connection that is still in slow-start, on a lossy filtered line, is simply not
    //      a stable enough number to base a destructive decision on.
    //   2. There is usually nowhere better to go. Every scan on this network returns the same
    //      single reachable edge (162.159.198.1:443). "Rescan for a better one" cannot succeed
    //      when the candidate list has one survivor — it just costs another two minutes.
    //   3. The cost of being wrong is enormous and lands entirely on the user: a working tunnel
    //      is destroyed, a 120-second `balanced` rescan starts, and everything built on top —
    //      Xray, DNS, the whole-system TUN — comes down with it.
    //
    // So the speed is now information, not a verdict. It is measured after the tunnel is
    // already announced, shown in the log and the UI, and never acted on unless the caller
    // explicitly opts in with speedGate: true. Connecting behaves exactly like upstream; the
    // only thing this app adds on top is the full-system tunnel, which is the point.
    const runSpeedGate = async () => {
        speedGateDone = true;
        markConnected(null);

        // Give the data plane a moment to settle; probing the first packets of a fresh QUIC
        // connection measures slow-start, not the gateway.
        await new Promise(r => setTimeout(r, 1200));
        if (!owns()) return;

        const r = await speedtest.measure(socksPort);
        if (!owns()) return;

        currentState.speedKbps = r.kbps;
        emitStage();

        // ── NOTHING AT ALL got through, which is not a speed measurement ──────────────────
        //
        // Everything above argues that SPEED is too noisy to act on. Zero bytes is not speed:
        // it is the tunnel failing to carry traffic while the engine reports it as validated.
        // Measured 2026-09-20 on the user's line, more than once: the engine picked
        // 162.159.192.147:859, logged «wireguard tunnel validated (end-to-end data confirmed)»
        // and served SOCKS, and 60 real HTTPS requests through that port in a row got nothing.
        // Its own check is two packets inside the tunnel; an edge can pass those and shape
        // everything else away. The scan then has no reason to move, because from where it
        // stands the endpoint is healthy.
        //
        // That is exactly the «وصل شد ولی هیچ صفحه‌ای باز نمی‌شود» report, and it is the one
        // case where throwing the tunnel back is not a judgement call.
        let dead = !r.ok;
        if (dead) {
            // Once is not evidence. A WireGuard handshake that just completed can lose the
            // first packets, and speed.cloudflare.com can have a bad moment of its own.
            log(`[WARP] از تونل چیزی رد نشد (${r.error || 'نامشخص'}) — یک بار دیگر امتحان می‌شود…`);
            await new Promise((res) => setTimeout(res, 2500));
            if (!owns()) return;
            const again = await speedtest.measure(socksPort);
            if (!owns()) return;
            if (again.ok) {
                dead = false;
                currentState.speedKbps = again.kbps;
                emitStage();
                r.kbps = again.kbps;
            }
        }

        if (!dead) {
            const mbps = (r.kbps * 8 / 1024).toFixed(1);
            log(`[WARP] 📊 سرعت تونل: ${r.kbps} KB/s (~${mbps} مگابیت)`);
        } else {
            log('[WARP] ⚠️ موتور می‌گوید تونل سالم است ولی هیچ درخواستی از آن رد نمی‌شود.');
        }

        // Slowness stays opt-in for every reason listed above. A tunnel that carries NOTHING
        // does not: keeping it would leave the user connected to something that cannot open a
        // page, which is worse than the rescan.
        if (!dead && (o.speedGate !== true || r.kbps >= speedtest.DUD_THRESHOLD_KBPS)) return;

        // Already measured and rejected this exact endpoint in this run — on a filtered line the
        // scan often has ONE reachable edge, so a rescan would only land on it again and the
        // "find something better" loop becomes a guaranteed pair of disconnects. Keep what we have.
        //
        // That reasoning is about SPEED and does not carry over to a tunnel carrying nothing: the
        // WireGuard sweep draws from ~2000 candidates, so meeting the same one twice is luck
        // rather than proof that it is the only one. Measured on the user's line, a single scan
        // logged a dozen different healthy candidates.
        if (!dead && currentState.server && rejectedGateways.includes(currentState.server)) {
            log(`[WARP] گزینه‌ی بهتری از ${currentState.server} در دسترس نیست — همین نگه داشته شد.`);
            return;
        }

        // A slow tunnel is a judgement call and gets two tries. A tunnel that carries nothing is
        // not usable at all, so it is worth more of them before settling.
        const budget = dead ? MAX_DEAD_RETRIES : MAX_DUD_RETRIES;
        if (dudRetries >= budget) {
            log(dead
                ? `[WARP] بعد از ${budget} تلاش، سروری که داده رد کند پیدا نشد — همین نگه داشته شد. «وایرگارد» یا «ماسک» را امتحان کنید.`
                : `[WARP] بعد از ${budget} تلاش گیت‌وی بهتری پیدا نشد — همین نگه داشته شد.`);
            return;
        }

        if (currentState.server) rejectedGateways.push(currentState.server);
        dudRetries++;
        const dropped = clearLastConnection();
        // The cached endpoint has to go with it, or the next start re-verifies the same dead one
        // in five seconds and settles straight back onto it.
        log(`[WARP] ${dead ? 'این سرور' : 'گیت‌وی کند'} دور انداخته شد (${dropped.join(', ') || 'کش خالی بود'}).`);
        log(`[WARP] جستجوی سرور ${dead ? 'دیگری که واقعاً داده رد کند' : 'بهتر'} — تلاش ${dudRetries} از ${budget}…`);

        currentState.connected = false;
        currentState.stage = 'scan';
        currentState.stageFa = dead
            ? 'این سرور داده رد نکرد — جستجوی سرور دیگر'
            : 'گیت‌وی کند بود — جستجوی گیت‌وی بهتر';
        emitStage();

        setTimeout(() => {
            startAether(
                Object.assign({}, o, { __dudRetry: true, scan: 'balanced', quickReconnect: false }),
                onLog, onStage, onDebug
            ).catch((e) => log(`[WARP] ❌ اسکن مجدد ناموفق: ${e.message}`));
        }, 0);
    };

    /**
     * The scan swept every candidate and none answered. Decide what that means and say it.
     *
     * MASQUE speaks two transports and they fail independently: HTTP/3 over QUIC (UDP), and
     * HTTP/2 over TCP. Measured the same hour on two Iranian mobile lines, with the identical
     * scan:
     *
     *   line A   QUIC found 162.159.198.1:443 in 3.1s   · TCP found nothing in 120s
     *   line B   QUIC found nothing in 60s (958 cands)  · TCP found 162.159.198.107:443 in 1.0s
     *
     * Neither is the right default for everyone and neither substitutes for the other — which
     * is why this is a ladder tried in order, not a setting. On line B, TCP/443 to the edge was
     * wide open the whole time (95–182 ms to 7 of 8 seeds); only UDP was gone.
     *
     * The two WireGuard engines have no second rung: `wireguard.rs` is `UdpSocket` throughout
     * and «وارپ در وارپ» is two of those hops, so on a network that blocks UDP to the edge they
     * cannot be made to work by any setting. Say which door is still open instead of letting
     * someone try all three for ten minutes.
     */
    let emptyScanHandled = false;
    const handleEmptyScan = () => {
        if (emptyScanHandled || !owns()) return;
        emptyScanHandled = true;

        const isMasque = o.protocol === 'masque' || !o.protocol;
        // `o.transport` is ALWAYS set by the panel ('h3' when nobody touched the menu), so
        // "did the user pin it?" cannot be asked of it. What matters is only whether the rung
        // below has already been used: h2 IS the bottom of the ladder.
        const canLadder = isMasque && o.transport !== 'h2' && !o.__transportLadder;

        if (canLadder) {
            log('[WARP] هیچ گیت‌وی‌ای روی UDP جواب نداد — همین اسکن یک بار دیگر روی TCP انجام می‌شود.');
            log('[WARP] (ترنسپورت HTTP/2؛ شبیه ترافیک عادی HTTPS دیده می‌شود.)');
            currentState = Object.assign(currentState || {}, {
                stage: 'scan', stageFa: 'روی UDP چیزی پیدا نشد — تلاش روی TCP',
            });
            emitStage();
            setTimeout(() => {
                startAether(
                    Object.assign({}, o, { __transportLadder: true, transport: 'h2', quickReconnect: false }),
                    onLog, onStage, onDebug
                ).catch((e) => log(`[WARP] ❌ تلاش روی TCP هم ناموفق بود: ${e.message}`));
            }, 0);
            return;
        }

        // No rung left. The engine will keep rescanning on its own — that is its design and a
        // later sweep can still succeed — so nothing is torn down here. What changes is that
        // the user is told what is happening and what can actually work, once.
        if (!isMasque) {
            log('[WARP] ❌ این شبکه به هیچ‌کدام از آدرس‌های لبه جواب نداد.');
            log('[WARP] این موتور داده را فقط روی UDP می‌برد و راه دومی ندارد.');
            log('[WARP] موتور «ماسک» تنها موتوری است که می‌تواند روی TCP هم برود — آن را امتحان کنید.');
            currentState.stageFa = 'این شبکه UDP را بسته — «ماسک» را امتحان کنید';
        } else {
            log('[WARP] ❌ نه روی UDP و نه روی TCP گیت‌وی‌ای پیدا نشد.');
            log('[WARP] یعنی این شبکه هر دو راه را بسته است. «ضد فیلتر SNI» یا «کانفیگ ایران» را امتحان کنید.');
            currentState.stageFa = 'هر دو راه بسته است — SNI یا کانفیگ ایران';
        }
        currentState.stage = 'failed';
        emitStage();
    };

    const handleLine = (line, isErr) => {
        // Late output from a superseded process must never touch the live session's state.
        if (!owns()) return;
        const text = line.trim();
        if (!text) return;

        // Cheapest possible path for high-volume per-packet chatter: count it and return.
        // Anything more here starves the engine (see NOISE_RE).
        if (isNoise(text)) { noiseCount++; return; }

        log(text);
        if (debugMode) debugLog(isErr ? 'STDERR' : 'STDOUT', 'ENGINE', text);

        // Rust panics arrive on stderr; keep them for post-mortem inspection.
        if (isErr && /panicked at|stack backtrace|RUST_BACKTRACE/i.test(text)) {
            try { fs.appendFileSync(CRASH_LOG, `[${new Date().toISOString()}] ${text}\n`); } catch (e) {}
        }

        const detail = extractDetail(text);
        if (detail) {
            if (detail.server) currentState.server = detail.server;
            if (detail.rtt) currentState.rtt = detail.rtt;
            if (detail.profile) currentState.profile = detail.profile;
        }

        // ── A SCAN THAT FOUND NOTHING — ACT ON THE LINE, NOT ON AN EXIT ────────
        //
        // The engine does NOT stop when a scan comes up empty. Measured on an Iranian mobile
        // line (2026-09-12), it logs
        //     [-] no usable MASQUE gateway found: prober: no clean endpoint found; rescanning shortly
        // and starts the whole sweep again, every 60 s, for as long as it is left running. So
        // the process never closes, and anything hung off `proc.on('close')` — including the
        // first version of this ladder — never runs at all. From the user's side that is the
        // report exactly as it came in: «توی مرحله اسکن گیت وی گیر میکنن».
        if (/no usable (masque gateway|wireguard endpoint) found|prober: no clean endpoint found/i.test(text)) {
            handleEmptyScan();
            return;
        }

        const rule = classify(text);
        if (rule) {
            const prevStage = currentState.stage;
            currentState.stage = rule.stage;
            currentState.stageFa = rule.fa;
            if (rule.stage !== prevStage) recordStageChange(rule.stage);

            if (rule.stage === 'connected' && !currentState.connected && speedGateDone) {
                // The engine re-logs "socks5 server listening" every time it re-establishes
                // after a drop. The gateway was already measured for this session, so come
                // straight back up — without this the stage would read 'connected' while the
                // flag stayed false, and server.js would leave Xray and DNS torn down.
                markConnected('[WARP] اتصال دوباره برقرار شد.');
            } else if (rule.stage === 'connected' && !currentState.connected && speedGateRan) {
                // The twin listening line, arriving while the first one's handler is still
                // running. Nothing to do — it already marked the session connected.
            } else if (rule.stage === 'connected' && !currentState.connected) {
                speedGateRan = true;
                // Announces the tunnel immediately, then measures in the background purely to
                // report a number. No waiting, and nothing here can take the tunnel away.
                runSpeedGate();
            }

            // Any stage that is not 'connected' means the data path is gone. Clearing the
            // flag only on 'reconnecting' left it stuck on true for every other way a tunnel
            // dies — the engine drops back to scanning or reports a failed handshake while
            // the UI still says connected and Xray still dials a SOCKS port with nothing
            // behind it. That is the "fake connection" state: green badge, no traffic.
            if (rule.stage !== 'connected' && currentState.connected) {
                currentState.connected = false;
                log('[WARP] ⚠️ تونل قطع شد؛ موتور خودش دوباره تلاش می‌کند.');
            }

            emitStage();
        } else {
            // Not a stage change, but still worth explaining in Persian next to the raw line.
            const note = classifyNote(text);
            if (note) log('        └─ ' + note.fa);
            if (detail) emitStage();
        }
    };

    let outTail = '';
    proc.stdout.on('data', (chunk) => {
        outTail += chunk.toString();
        const parts = outTail.split('\n');
        outTail = parts.pop();
        parts.forEach(l => handleLine(l, false));
    });

    let errTail = '';
    proc.stderr.on('data', (chunk) => {
        errTail += chunk.toString();
        const parts = errTail.split('\n');
        errTail = parts.pop();
        parts.forEach(l => handleLine(l, true));
    });

    proc.on('error', (err) => {
        if (!owns()) return;
        log(`[WARP] ❌ خطای اجرای پروسه: ${err.message}`);
        currentState.running = false;
        currentState.connected = false;
        currentState.stage = 'failed';
        currentState.stageFa = 'اجرای موتور ناموفق بود';
        currentState.error = err.message;
        emitStage();
    });

    proc.on('close', (code, signal) => {
        // A replaced process closing is not news: its successor already owns the state, and
        // reporting this exit would overwrite a healthy run with "failed".
        if (!owns()) return;

        // Flush any partial trailing line.
        if (outTail.trim()) handleLine(outTail, false);
        if (errTail.trim()) handleLine(errTail, true);

        const wasConnected = currentState && currentState.connected;
        log(`[WARP] پروسه خاتمه یافت (exit code: ${code}${signal ? ', signal: ' + signal : ''})`);

        // Distinguish a Rust panic (real crash) from a clean error exit — they need
        // completely different follow-up, so don't label both "crash".
        const panicked = logBuffer.some(l => /panicked at/i.test(l));
        const apiFailed = logBuffer.some(l => /Api\(.*cloudflareclient\.com/i.test(l));
        const configCorrupt = logBuffer.some(l => /config parse:|damaged file was moved/i.test(l));
        // Nothing to undo in the Windows proxy settings — we never set them.
        void wasConnected;

        currentState = Object.assign(currentState || {}, {
            running: false,
            connected: false,
            stage: code === 0 ? 'stopped' : (panicked ? 'crashed' : 'failed'),
            stageFa: code === 0 ? 'متوقف شد'
                : panicked ? `کرش موتور (کد ${code})`
                : configCorrupt ? 'فایل تنظیمات آسیب‌دیده بود — دوباره وصل شوید'
                : apiFailed ? 'ثبت‌نام ناموفق — API کلادفلر در دسترس نیست'
                : `خطا در اجرا (کد ${code})`,
            exitCode: code,
        });
        if (aetherProcess === proc) aetherProcess = null;
        if (noiseTimer) { clearInterval(noiseTimer); noiseTimer = null; }
        stopDebugSession();
        emitStage();
    });

    return { socks: `127.0.0.1:${socksPort}`, pid: proc.pid };
}

function stopAether() {
    const wasRunning = !!aetherProcess;

    // Invalidate FIRST. The kill below produces a burst of buffered output and a close
    // event that land on later ticks — possibly after startAether() has already spawned a
    // replacement. Bumping the id here is what makes those events no-ops.
    sessionId++;

    if (noiseTimer) { clearInterval(noiseTimer); noiseTimer = null; }

    if (aetherProcess) {
        if (debugMode) debugLog('INFO', 'LIFECYCLE', 'Stopping engine (user or system request)');
        const pid = aetherProcess.pid;
        try { aetherProcess.kill(); } catch (e) {}
        // Target OUR pid, with /T for anything it spawned.
        //
        // This used to be `taskkill /F /IM aether.exe /T`, which kills EVERY aether.exe on the
        // machine — a second copy the user started by hand, one belonging to another Windows
        // user, one under a debugger. Stopping this app's tunnel is not licence to terminate
        // someone else's process, and doing so made "why did my other session die?" an
        // unanswerable question.
        if (pid) { try { execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore', timeout: 8000 }); } catch (e) {} }
        aetherProcess = null;
    }

    if (currentState) {
        currentState = Object.assign(currentState, {
            running: false, connected: false,
            stage: 'stopped', stageFa: 'متوقف شد',
        });
    }
    stopDebugSession();
    return wasRunning;
}

function isRunning() {
    return !!aetherProcess;
}

function getStatus() {
    return currentState || {
        running: false, connected: false, stage: 'idle',
        stageFa: 'خاموش', socks: `127.0.0.1:${SOCKS_PORT}`,
    };
}

function getLogs() {
    return logBuffer.slice();
}

function getCrashLog() {
    try {
        return fs.existsSync(CRASH_LOG) ? fs.readFileSync(CRASH_LOG, 'utf8') : '';
    } catch (e) { return ''; }
}

// Every address this engine dials for its OWN uplink, as bare IPs.
//
// WHY THIS EXISTS. tun-manager keeps the engine's uplink outside the tunnel two ways: by
// process name (unreliable on Windows — "router: failed to search process: Access is denied")
// and by a static list of Cloudflare MASQUE ranges. The static list is not the whole story:
//
//   * `assigned_endpoint` in the identity toml can be a CDN anycast address (measured here:
//     104.16.24.84), and 104.16.0.0/12 is NOT in the static list — it cannot be, because that
//     range is also a large slice of the ordinary web and excluding it wholesale would send
//     every Cloudflare-hosted site out untunnelled.
//   * a future engine build can pick an edge from a range this app has never heard of.
//
// A /32 for the address the engine is actually using has neither problem: it is exact, so it
// can never send anyone else's traffic direct, and it is read from the engine's own state
// rather than from a list that has to be kept in sync by hand. Without it, when the process
// lookup is refused the engine's QUIC packets are captured by auto_route and handed back to
// the SOCKS port the engine itself is serving — the tunnel eats its own uplink and the machine
// goes offline with a green "connected" badge on screen.
function getUplinkIps() {
    const ips = new Set();
    const add = (value) => {
        if (!value) return;
        // Accept "1.2.3.4", "1.2.3.4:500" and "[2606:4700::1]:443".
        let host = String(value).trim().replace(/^\[|\]$/g, '');
        const bracket = host.match(/^\[(.+)\]:\d+$/);
        if (bracket) host = bracket[1];
        else if (/^[\d.]+:\d+$/.test(host)) host = host.split(':')[0];
        else host = host.replace(/^\[(.+)\]$/, '$1');
        if (/^[\d.]+$/.test(host) || host.includes(':')) ips.add(host);
    };

    // The edge the running engine reported picking, parsed out of its log by extractDetail.
    if (currentState && currentState.server) add(currentState.server);

    // What it will pick on the next (re)connect, and what the registration API assigned.
    try {
        if (fs.existsSync(AETHER_DATA_DIR)) {
            fs.readdirSync(AETHER_DATA_DIR)
                .filter(f => f.endsWith('.toml'))
                .forEach((f) => {
                    let text = '';
                    try { text = fs.readFileSync(path.join(AETHER_DATA_DIR, f), 'utf8'); } catch (e) { return; }
                    const m = text.match(/^\s*(?:peer|assigned_endpoint|endpoint)\s*=\s*"([^"]+)"/gm) || [];
                    m.forEach(line => add(line.split('=')[1].replace(/"/g, '')));
                });
        }
    } catch (e) {}

    return [...ips];
}

// Forget the cached gateway WITHOUT touching the Cloudflare identity.
//
// The engine writes the winning gateway to aether-*-lastconn.toml and reuses it on every
// later connect after only a 5-second handshake re-verify (main.rs want_quick_reconnect →
// quick_verify_masque_peer). A handshake says the edge is alive, not that it is fast — so
// once a slow gateway wins the scan it is pinned there indefinitely. Deleting just this file
// forces a fresh scan on the next start. resetIdentity() also achieved that, but only as a
// side effect of deleting the account too, which throws away a perfectly good Cloudflare
// registration and makes the next connect provision a new one.
function clearLastConnection() {
    const removed = [];
    try {
        if (fs.existsSync(AETHER_DATA_DIR)) {
            fs.readdirSync(AETHER_DATA_DIR)
                .filter(f => /lastconn.*\.toml$/i.test(f))
                .forEach(f => {
                    try { fs.unlinkSync(path.join(AETHER_DATA_DIR, f)); removed.push(f); } catch (e) {}
                });
        }
    } catch (e) {}
    return removed;
}

// Wipe stored identities so the next start provisions fresh Cloudflare accounts.
function resetIdentity() {
    let removed = [];
    try {
        if (fs.existsSync(AETHER_DATA_DIR)) {
            fs.readdirSync(AETHER_DATA_DIR)
                .filter(f => f.endsWith('.toml'))
                .forEach(f => {
                    try { fs.unlinkSync(path.join(AETHER_DATA_DIR, f)); removed.push(f); } catch (e) {}
                });
        }
    } catch (e) {}
    return removed;
}

function isInstalled() {
    return fs.existsSync(getExePath());
}

// Should Xray route through Aether? Set from the UI; only takes effect while the tunnel is up.
let chainToXray = false;

function setChainToXray(on) { chainToXray = !!on; }
function getChainToXray() { return chainToXray; }

// The Xray outbound that dials through Aether's SOCKS5, or null when chaining is off or the
// tunnel isn't up. Returning null (rather than an unreachable outbound) matters: a config
// pointing at a dead SOCKS port would break Xray entirely instead of degrading to direct.
function getChainOutbound() {
    if (!chainToXray) return null;
    if (!currentState || !currentState.connected) return null;

    const port = parseInt((currentState.socks || '').split(':')[1], 10) || SOCKS_PORT;
    const tag = 'aether-chain';
    return {
        tag,
        address: '127.0.0.1',
        port,
        outbound: {
            tag,
            protocol: 'socks',
            settings: { servers: [{ address: '127.0.0.1', port }] },
        },
    };
}

function setDebugMode(on) { debugMode = !!on; }
function getDebugMode() { return debugMode; }

module.exports = {
    startAether, stopAether, isRunning, getStatus, getLogs,
    getCrashLog, resetIdentity, clearLastConnection, isInstalled,
    getUplinkIps,       // the engine's own edge addresses — must stay OUTSIDE the TUN
    setChainToXray, getChainToXray, getChainOutbound,
    setDebugMode, getDebugMode,
    getDebugSummary, getDebugLogFiles, readDebugLogFile,
    SOCKS_PORT, AETHER_DATA_DIR,
    validateOptions,
    // exposed for the log-parser test harness
    _internal: { classify, classifyNote, extractDetail, buildEnv, STAGE_RULES },
};
