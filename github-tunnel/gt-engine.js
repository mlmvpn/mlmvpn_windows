// --- GitHub Tunnel: the local data-plane engine ---
//
// WHY THIS SHAPE (and not "generate a VLESS config and hand it to Xray"):
// The cloud session is a GitHub-hosted runner, which sits behind NAT with no inbound
// ports. Nothing can dial it directly. The only way in is a NAT-traversing overlay, and
// the one already running on the VM is Tailscale — i.e. WireGuard. So the fastest possible
// path is the one that is *already there*: a direct WireGuard association between this
// machine and the VM (falling back to a DERP relay only when hole-punching fails).
// Wrapping Xray/VLESS around that would mean encrypting twice and adding a second
// congestion-control loop on top of WireGuard — strictly slower and strictly less stable.
// So this module joins the same tailnet and routes through the VM as an exit node.
//
// TWO MODES, because no single one is both fastest and universally usable:
//
//   'tun'   — the real thing. tailscaled drives a kernel WireGuard adapter (Wintun) and
//             the exit node takes the default route. Full UDP, so QUIC, voice and GAMES
//             work, and latency is as low as it gets: packets go NIC -> WireGuard -> exit,
//             with no userspace proxy and no sing-box anywhere in the data path. DNS is
//             handled by Tailscale itself through the exit node, so it cannot leak.
//             This is the default.
//
//   'proxy' — fallback. tailscaled runs in `userspace-networking`, exposing local SOCKS5
//             and HTTP listeners; Windows' system proxy points at the HTTP one. Installs
//             no driver and needs no adapter, so it survives restrictive networks and
//             machines where a TUN adapter cannot come up — but SOCKS5 here has no UDP
//             ASSOCIATE, so it is TCP-only: fine for browsing, useless for games.
//
// Switching modes restarts the daemon, because the tun flag is set at process start.
//
// The binaries SHIP WITH THE APP (core/tailscale/, since 1.2.2) and are copied into the
// user's profile on first connect. They used to be fetched from Tailscale's MSI on first
// connect instead, to keep the installer ~44MB smaller — but pkgs.tailscale.com answers
// Iranian IPs with 403 and the edge-proxy fallback went dark, so on a fresh Windows the
// feature could not start at all ("دانلود موتور اتصال رد شد (۴۰۳)"). The MSI path below
// stays as the last resort for a build without the bundled copies: an administrative
// extraction (`msiexec /a`) that unpacks files WITHOUT installing the Tailscale service or
// touching the user's network stack.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { gtFetch } = require('./gt-net');

const MSI_URL = 'https://pkgs.tailscale.com/stable/tailscale-setup-1.102.2-amd64.msi';
// The digest Tailscale publishes for exactly that file, at MSI_URL + '.sha256'.
//
// THIS IS NOT BELT-AND-BRACES. ensureBinaries() downloads through gtFetch, which falls
// back to a third-party edge proxy when the direct request fails — and TLS on that path
// terminates at the proxy, not at pkgs.tailscale.com. Without a pin, whoever controls
// that hop (or its domain, one expiry away) hands every user an arbitrary MSI, which is
// then unpacked by msiexec and executed with administrator rights. The pin is the only
// thing that makes it safe to fetch a binary over the fallback at all.
//
// When MSI_URL is bumped, this MUST be bumped with it — fetch <MSI_URL>.sha256.
const MSI_SHA256 = 'd2eb69e103b08a5b77de9d7cb8555541aa99f7dfc6048850b2286a1048c885f9';

// Tailscale's own hosts are the one place in this feature where a 403 is NOT an answer
// about the request. Both of them sit behind CDNs that refuse sanctioned regions outright,
// so an Iranian IP gets a well-formed 403 that fetch() treats as success — which used to
// hand the user "دانلود موتور اتصال ناموفق بود (403)" without ever trying either fallback.
// Passing this to gtFetch makes a refusal fall through to the proxies like a dead link.
// It stays local to this file: no GitHub or Cloudflare call may ever carry it.
const BLOCKED_STATUSES = [403, 451];

// xray uses 20809, Aether uses 20810 — keep these clear of both.
//
// TWO listeners, because the app's two traffic paths speak different protocols and mixing
// them up silently breaks the proxy path:
//   SOCKS_PORT -> sing-box's `socks` outbound (full-tunnel mode)
//   HTTP_PORT  -> Windows' WinINET ProxyServer, which is an HTTP proxy and CANNOT talk
//                 SOCKS5. Pointing the system proxy at the SOCKS port looks fine in the
//                 registry and then fails on every single request.
const SOCKS_PORT = 20812;
const HTTP_PORT = 20813;
const CONTROL_PIPE = '\\\\.\\pipe\\mlmvpn-gt';
const PROCESS_NAME = 'tailscaled.exe';
const ENGINE_LABEL = 'GitHub Tunnel';

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

// The engine's binaries live in the USER's profile, NOT beside the app. Three separate
// things broke when they lived in core/:
//   * the portable build unpacks itself into a fresh temp directory on every launch, so
//     anything written next to the app is gone by the next start — a 38MB re-download
//     each time the user opens the app, on the exact connections least able to afford it;
//   * an installed build sits in Program Files, so writing there needs administrator
//     rights and is wiped by every upgrade and by uninstall;
//   * ~/.mlmvpn is already where every other piece of this feature's state lives, and
//     resetAll() already knows how to clear it.
const CORE_DIR = path.join(os.homedir(), '.mlmvpn', 'gt-core');
// Where earlier builds put them. Moved, not re-downloaded, when found.
const LEGACY_CORE_DIR = path.join(getUnpackedDir(), '..', 'core');
// The copies the app ships: the three files of exactly the release MSI_URL names, as
// extracted from that MSI (Authenticode: Tailscale Inc. / WireGuard LLC). A file here whose
// digest does not match — a damaged install, an antivirus half-quarantine — is not adopted,
// and the download path takes over. When MSI_URL is bumped, bump these with it.
const BUNDLED_CORE_DIR = path.join(LEGACY_CORE_DIR, 'tailscale');
const BUNDLED_SHA256 = {
    'tailscaled.exe': 'dc1aa013ae85f2e31a2b680977e732e18cf9af31f03d18cf09480f0d48ee5699',
    'tailscale.exe': '9bce6da3e01fa74dfc2aeaed1577c2c3c8901bbdae8222027fa3876e3e09cef5',
    'wintun.dll': 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce',
};
const DAEMON_EXE = path.join(CORE_DIR, 'tailscaled.exe');
const CLI_EXE = path.join(CORE_DIR, 'tailscale.exe');
// What actually runs: a newer copy installed by «ام‌ال‌ام استور», or the one placed here on first
// connect. Resolved per call so an install takes effect on the next start without a restart.
const daemonExe = () => require('../core-paths').file('tailscale', 'tailscaled.exe', DAEMON_EXE);
const cliExe = () => require('../core-paths').file('tailscale', 'tailscale.exe', CLI_EXE);
// Loaded by tailscaled from its own directory to create the kernel adapter. Counted as a
// required binary, not an optional extra: without it the daemon runs but can never build
// the tunnel, which is a far worse failure than not starting at all.
const WINTUN_DLL = path.join(CORE_DIR, 'wintun.dll');
const STATE_DIR = path.join(os.homedir(), '.mlmvpn', 'gt-state');
const DAEMON_LOG = path.join(os.homedir(), '.mlmvpn', 'gt-daemon.log');

const TUN_ADAPTER = 'mlmvpn-gt';

let lastDaemonLines = [];
let daemonProc = null;
let daemonLogStream = null;
let state = { running: false, connected: false, exitNodeIp: '', mode: '', error: '' };

// Machine-wide changes made on this engine's behalf that MUST come back off if the process
// dies, whoever made them. routes.js owns the Windows proxy switch, so it registers the
// undo here rather than the engine reaching across into xray-manager itself.
const emergencyUndo = [];
/** Register a SYNCHRONOUS undo to run on process exit / signal / engine teardown. */
function registerEmergencyUndo(fn) { if (typeof fn === 'function') emergencyUndo.push(fn); }
function runEmergencyUndo() {
    for (const fn of emergencyUndo) { try { fn(); } catch (e) {} }
}

function run(exe, args, { timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || stdout || err.message).toString().trim()));
            resolve((stdout || '').toString());
        });
    });
}

// ── binaries ────────────────────────────────────────────────────────────────────────

function binariesReady() {
    return fs.existsSync(DAEMON_EXE) && fs.existsSync(CLI_EXE) && fs.existsSync(WINTUN_DLL);
}

// Copy to a side name and rename into place. binariesReady() is nothing but an existence
// check, so a copy interrupted half-way — a crash, a full disk, an antivirus grabbing the
// handle — would otherwise leave a truncated tailscaled.exe that looks ready forever and
// fails at every launch with no path back except a manual delete.
function placeFile(from, to) {
    const staging = `${to}.part`;
    fs.copyFileSync(from, staging);
    fs.renameSync(staging, to);
}

function sha256File(p) {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Install the engine the app ships with. True when the binaries are ready afterwards. */
function adoptBundledBinaries() {
    if (binariesReady()) return true;
    const src = (f) => path.join(BUNDLED_CORE_DIR, f);
    const files = Object.keys(BUNDLED_SHA256);
    if (!files.every((f) => fs.existsSync(src(f)))) return false;
    try {
        for (const f of files) {
            if (sha256File(src(f)) !== BUNDLED_SHA256[f]) return false;
        }
        fs.mkdirSync(CORE_DIR, { recursive: true });
        placeFile(src('tailscaled.exe'), DAEMON_EXE);
        placeFile(src('tailscale.exe'), CLI_EXE);
        placeFile(src('wintun.dll'), WINTUN_DLL);
    } catch (e) {
        return false;
    }
    return binariesReady();
}

/** Adopt binaries an older build left in the app directory, so upgrading users don't pay
 *  for the download a second time. */
function adoptLegacyBinaries() {
    if (binariesReady()) return;
    const legacyDaemon = path.join(LEGACY_CORE_DIR, 'tailscaled.exe');
    const legacyCli = path.join(LEGACY_CORE_DIR, 'tailscale.exe');
    const legacyWintun = path.join(LEGACY_CORE_DIR, 'wintun.dll');
    if (!fs.existsSync(legacyDaemon) || !fs.existsSync(legacyCli)) return;
    try {
        fs.mkdirSync(CORE_DIR, { recursive: true });
        fs.copyFileSync(legacyDaemon, DAEMON_EXE);
        fs.copyFileSync(legacyCli, CLI_EXE);
        // Adopting only the two executables is what left installs with a daemon that could
        // never create its adapter. The app ships this DLL for sing-box, so it is here.
        if (fs.existsSync(legacyWintun)) fs.copyFileSync(legacyWintun, WINTUN_DLL);
    } catch (e) { /* fall through to a normal download */ }
}

// One download, however many callers. Without this, two connects racing (a double click,
// or a reconnect landing on top of a connect) both start a 38MB fetch into the same
// directory and then copyFileSync over a file the other one is still writing — which
// fails with EBUSY and leaves a truncated tailscaled.exe behind.
let ensureBinariesInFlight = null;

function ensureBinaries(onLog) {
    if (binariesReady()) return Promise.resolve();
    if (ensureBinariesInFlight) return ensureBinariesInFlight;
    ensureBinariesInFlight = ensureBinariesOnce(onLog).finally(() => { ensureBinariesInFlight = null; });
    return ensureBinariesInFlight;
}

async function ensureBinariesOnce(onLog) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (adoptBundledBinaries()) { log('موتور اتصال آماده شد.'); return; }
    adoptLegacyBinaries();
    if (binariesReady()) return;

    fs.mkdirSync(CORE_DIR, { recursive: true });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-gt-'));
    const msiPath = path.join(tmpDir, 'ts.msi');

    log('در حال آماده‌سازی موتور اتصال (فقط بار اول، حدود ۳۸ مگابایت)…');
    // gtFetch: this runs exactly once, on a machine that by definition has no working
    // tunnel yet. If the download host is blocked there is no other way in, and the
    // feature is dead before it starts — so it gets the same fallback as every other
    // control-plane call.
    const res = await gtFetch(MSI_URL, { fallbackOnStatus: BLOCKED_STATUSES });
    if (!res.ok) {
        // A 403 that survived all three paths is the geo-block, not a broken link, and no
        // amount of retrying changes it — only a different exit IP does. Saying so is the
        // difference between a number the user cannot act on and one instruction that works.
        if (BLOCKED_STATUSES.includes(res.status)) {
            throw new Error(
                'دانلود موتور اتصال رد شد (۴۰۳) — سازنده‌ی این فایل آن را به آی‌پی ایران نمی‌دهد (تحریم). ' +
                'یک‌بار V2Ray یا یکی از موتورهای ماسک، وایرگارد و وارپ در وارپ را وصل کنید (یا تحریم‌شکن را روشن کنید) و دوباره وصل شوید؛ دانلود از همان عبور می‌کند و فقط بار اول لازم است.'
            );
        }
        throw new Error(`دانلود موتور اتصال ناموفق بود (${res.status}).`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    // A blocked network does not always fail loudly: a captive portal, or the fallback proxy
    // hitting its own response-size ceiling, answers 200 with a short HTML page. Written to
    // disk that becomes a corrupt .msi and msiexec fails with a number nobody can act on. A
    // size floor turns that into a sentence that names the real problem.
    if (body.length < 20 * 1024 * 1024) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        throw new Error('دانلود موتور اتصال ناقص بود — فایل دریافتی معتبر نیست. احتمالاً اینترنت شما این دانلود را مسدود می‌کند؛ یک‌بار با تحریم‌شکن یا یک اتصال دیگر امتحان کنید (این دانلود فقط بار اول لازم است).');
    }

    // The gate that makes the fallback path safe: this file is about to be handed to
    // msiexec and then executed with administrator rights, and it may have arrived through
    // a proxy we do not control. A size floor catches a captive portal; only the digest
    // catches a substitution.
    const digest = crypto.createHash('sha256').update(body).digest('hex');
    if (digest !== MSI_SHA256) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
        throw new Error(
            'فایل موتور اتصال با نسخه‌ی معتبر مطابقت ندارد و به همین دلیل اجرا نشد. ' +
            'یعنی چیزی بین شما و سرور اصلی فایل را عوض کرده است. با یک اینترنت دیگر (یا تحریم‌شکن) دوباره تلاش کنید.'
        );
    }

    fs.writeFileSync(msiPath, body);

    // /a = administrative install: unpack only. No service, no driver, no network change.
    const extractDir = path.join(tmpDir, 'x');
    fs.mkdirSync(extractDir, { recursive: true });
    await run('msiexec.exe', ['/a', msiPath, '/qn', `TARGETDIR=${extractDir}`]);

    const found = {};
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.name === 'tailscaled.exe') found.daemon = p;
            else if (entry.name === 'tailscale.exe') found.cli = p;
            // The kernel-mode adapter is created through this DLL, which tailscaled loads
            // from its OWN directory. Without it the daemon starts, reports nothing wrong,
            // and then spins forever in `tstunNew: backoff` — never creating mlmvpn-gt, so
            // `up` blocks until it is killed and the whole connect looks frozen with no
            // error anywhere the user can see. It was missing until now.
            else if (entry.name.toLowerCase() === 'wintun.dll') found.wintun = p;
        }
    })(extractDir);

    if (!found.daemon || !found.cli) throw new Error('استخراج موتور اتصال ناموفق بود.');
    placeFile(found.daemon, DAEMON_EXE);
    placeFile(found.cli, CLI_EXE);
    // The app already ships one for sing-box, so fall back to that rather than fail: the
    // DLL is the same component, and a missing one costs the user a working tunnel.
    const wintunSrc = found.wintun || path.join(LEGACY_CORE_DIR, 'wintun.dll');
    if (fs.existsSync(wintunSrc)) placeFile(wintunSrc, WINTUN_DLL);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    log('موتور اتصال آماده شد.');
}

// ── lifecycle ───────────────────────────────────────────────────────────────────────

function daemonAlive() {
    return !!(daemonProc && daemonProc.exitCode === null);
}

async function startDaemon(onLog, mode) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (daemonAlive()) return;

    // A fresh state dir per connect. The auth keys are single-use and the nodes are
    // ephemeral, so carrying old state over would only risk re-using a node identity that
    // the control plane has already reaped.
    try { fs.rmSync(STATE_DIR, { recursive: true, force: true }); } catch (e) {}
    fs.mkdirSync(STATE_DIR, { recursive: true });

    // In 'tun' mode the local proxy listeners are deliberately NOT started: the adapter
    // carries everything, and an extra userspace hop would only add latency.
    const args = mode === 'proxy'
        ? [
            '--tun=userspace-networking',
            `--socks5-server=127.0.0.1:${SOCKS_PORT}`,
            `--outbound-http-proxy-listen=127.0.0.1:${HTTP_PORT}`,
        ]
        : [`--tun=${TUN_ADAPTER}`];

    daemonProc = spawn(daemonExe(), [
        ...args,
        `--statedir=${STATE_DIR}`,
        `--socket=${CONTROL_PIPE}`,
        // Let WireGuard bind a real UDP port instead of 0. A stable port gives NAT
        // mappings a chance to persist, which is what keeps a direct peer-to-peer path
        // (and therefore the low ping) instead of falling back to a relay.
        '--port=41641',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    // Keep the daemon's own output. Without it every failure downstream (bad flag, denied
    // control pipe, refused auth key) surfaces only as a generic "didn't work", which is
    // exactly the hole that made the first round of this feature undiagnosable.
    //
    // The stream is held and closed on exit rather than left to the GC: a mode switch, a
    // watchdog rebuild and a reconnect all pass through here, and one leaked file handle
    // per pass eventually pins the log file open so the next run cannot truncate it.
    try { if (daemonLogStream) daemonLogStream.end(); } catch (e) {}
    daemonLogStream = fs.createWriteStream(DAEMON_LOG, { flags: 'w' });
    const sink = daemonLogStream;
    sink.on('error', () => {});
    daemonProc.stdout.pipe(sink);
    daemonProc.stderr.pipe(sink);
    daemonProc.stderr.on('data', (b) => {
        lastDaemonLines.push(b.toString());
        if (lastDaemonLines.length > 40) lastDaemonLines.shift();
    });
    daemonProc.on('exit', (code) => {
        state.running = false;
        state.connected = false;
        try { sink.end(); } catch (e) {}
        if (daemonLogStream === sink) daemonLogStream = null;
        if (code !== 0 && code !== null) log(`موتور اتصال متوقف شد (کد ${code}).`);
    });

    // If the daemon dies immediately (the usual symptom of a rejected flag or a control
    // pipe it may not create), fail here with its own words instead of timing out later.
    await new Promise(r => setTimeout(r, 1200));
    if (!daemonAlive()) {
        throw new Error('موتور اتصال بالا نیامد:\n' + lastDaemonLines.slice(-6).join('').trim());
    }

    // Give the control socket a moment to come up before `up` is issued against it.
    await new Promise(r => setTimeout(r, 2500));
    state.running = true;
    log('موتور اتصال اجرا شد.');
}

/**
 * Report what the daemon is saying for as long as `up` is blocked, and return the stopper.
 *
 * Deliberately echoes the daemon's own words rather than a reassuring "still trying…":
 * a line like `dial tcp ...controlplane...: i/o timeout` tells the user their line is
 * blocking Tailscale, which is something they can act on. A spinner tells them nothing,
 * and this feature has already shipped one round of undiagnosable silence.
 */
function beatWhileConnecting(log) {
    let seen = lastDaemonLines.length;
    let elapsed = 0;
    const timer = setInterval(() => {
        elapsed += 8;
        const fresh = lastDaemonLines.slice(seen);
        seen = lastDaemonLines.length;
        const notable = fresh.join('').split(/\r?\n/)
            // Routine chatter would drown the one line that matters.
            .filter(l => /error|timeout|refused|unreachable|blocked|failed|retry|dial|login|auth/i.test(l))
            .slice(-2);
        if (notable.length) notable.forEach(l => log(`موتور: ${l.trim()}`));
        else log(`هنوز در حال اتصال… (${elapsed} ثانیه)`);
    }, 8000);
    timer.unref && timer.unref();
    return () => clearInterval(timer);
}

/** Turn a failed/timed-out `up` into something the user can act on. */
function explainUpFailure(e) {
    const raw = ((e && e.message) || '').trim();
    const tail = lastDaemonLines.slice(-8).join('').trim();
    // execFile's own timeout kill produces no useful message at all — just a dead process.
    const timedOut = !raw || /timed? ?out|ETIMEDOUT|killed/i.test(raw);
    if (timedOut) {
        return 'اتصال به سرویس هماهنگی شبکه برقرار نشد و زمان تمام شد. '
            + 'این معمولاً یعنی اینترنت شما دسترسی به آن سرویس را مسدود کرده است — '
            + 'یک تونل دیگر (مثلاً ماسک یا وایرگارد) را روشن کنید و دوباره «اتصال» را بزنید.'
            + (tail ? `\n\nآخرین پیام‌های موتور:\n${tail}` : '');
    }
    return raw + (tail ? `\n\nآخرین پیام‌های موتور:\n${tail}` : '');
}

/**
 * Join the session's network and route everything through the cloud machine.
 * @param exitNodeIp the cloud session's overlay IP (session.tailscaleIp)
 * @param authKey    a single-use ephemeral key minted for THIS machine
 */
async function connect({ exitNodeIp, authKey, mode = 'tun', onLog }) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (!exitNodeIp) throw new Error('نشست ابری آماده نیست.');
    if (!authKey) throw new Error('کلید اتصال دریافت نشد.');

    await ensureBinaries(log);
    installExitHooks();
    await startDaemon(log, mode);

    log(mode === 'tun' ? 'در حال اتصال (حالت تونل کامل)…' : 'در حال اتصال (حالت پراکسی)…');
    // `up` blocks until the control plane answers, and on a censored line that can be the
    // full two minutes with not one character printed — the connect looks frozen, and the
    // one component that KNOWS why (the daemon, which is writing dial failures to its own
    // log the whole time) is being ignored. Mirror it while we wait.
    const stopHeartbeat = beatWhileConnecting(log);
    try {
    await run(cliExe(), [
        `--socket=${CONTROL_PIPE}`, 'up',
        `--authkey=${authKey}`,
        `--exit-node=${exitNodeIp}`,
        '--exit-node-allow-lan-access=true',
        `--hostname=mlmvpn-${os.hostname()}`.slice(0, 60),
        // In tun mode Tailscale owns the resolver and sends every query through the exit
        // node, which is what makes that mode leak-proof without sing-box. In proxy mode
        // it must NOT touch system DNS: the adapter isn't there to carry it.
        mode === 'tun' ? '--accept-dns=true' : '--accept-dns=false',
        // WITHOUT THIS the daemon logs `serverMode=false`, and the moment this one-shot CLI
        // call exits it treats that as "the user left" and tears the tunnel back down
        // ("client disconnected: disconnecting Tailscale"). The connection then reports
        // success while actually sitting in NeedsLogin with no peers and no exit node.
        '--unattended',
        '--reset',
    ]);
    } catch (e) {
        throw new Error(explainUpFailure(e));
    } finally {
        stopHeartbeat();
    }

    // "up" returning 0 only means the control plane accepted us — it does NOT mean the
    // exit node is actually carrying traffic (an unapproved exit node reports connected
    // and then blackholes everything). Verify real egress before claiming success.
    log('در حال بررسی عبور واقعی ترافیک…');
    const verdict = await verifyTunnel(mode);
    if (!verdict.ok) {
        state.error = verdict.code;
        throw new Error(verdict.message);
    }

    state.connected = true;
    state.exitNodeIp = exitNodeIp;
    state.mode = mode;
    state.error = '';
    repairFailures = 0;
    startWatchdog();
    log(mode === 'tun'
        ? 'اتصال برقرار شد — تونل کامل با پشتیبانی UDP.'
        : 'اتصال برقرار شد — حالت پراکسی (فقط TCP).');
    return { mode, socksPort: SOCKS_PORT, httpPort: HTTP_PORT };
}

/**
 * Decide whether traffic is REALLY going through the cloud session.
 *
 * A plain "can I fetch a URL" probe is not enough and actively misleads: when the node
 * isn't logged in, or the exit node was never approved, the local HTTP proxy happily
 * falls back to the machine's normal internet path — the probe returns 204 and the app
 * declares success while nothing is tunnelled. That is the false "connected" state this
 * check exists to make impossible. So: confirm the backend is actually Running AND that
 * an exit node is genuinely selected, before trusting any egress result.
 */
async function verifyTunnel(mode = 'tun') {
    let parsed;
    try {
        parsed = JSON.parse(await run(cliExe(), [`--socket=${CONTROL_PIPE}`, 'status', '--json'], { timeout: 25000 }));
    } catch (e) {
        return { ok: false, code: 'NO_STATUS', message: 'وضعیت اتصال خوانده نشد: ' + e.message };
    }

    if (parsed.BackendState !== 'Running') {
        return {
            ok: false, code: 'NOT_RUNNING',
            message: `اتصال برقرار نشد (وضعیت: ${parsed.BackendState}). کلید اتصال پذیرفته نشد یا اتصال قطع شده است.`,
        };
    }

    const peers = Object.values(parsed.Peer || {});
    if (!peers.some(p => p.ExitNode)) {
        const offered = peers.filter(p => p.ExitNodeOption).length;
        return {
            ok: false, code: 'EXIT_NODE_NOT_APPROVED',
            message: offered
                ? 'نشست ابری هنوز به‌عنوان خروجی انتخاب نشده است.'
                : 'نشست ابری اجازه‌ی خروجی ندارد — در تنظیمات دسترسی (ACL) بخش autoApprovers تأیید نشده است.',
        };
    }

    // In proxy mode the probe dials the engine's own local HTTP listener; in tun mode there
    // is no listener to dial, so it goes out through the machine's default route — which,
    // with the adapter up, IS the tunnel.
    //
    // tun mode used to skip this entirely, on the theory that "an exit node is selected"
    // was proof enough. It is not, and the gap is the worst state this feature can reach:
    // the cloud session can stop forwarding while its node is still present and still
    // selected (the runner's job ended, IP forwarding lost, the VM evicted). Every status
    // field then reads healthy while not one packet gets through — and because the guard
    // is engaged, the user has no internet at all and the app is telling them everything
    // is fine. Verifying real egress is what turns that into a fault the watchdog and the
    // fail-closed path can act on.
    if (!(await (mode === 'proxy' ? probeEgress() : probeEgressDirect()))) {
        return { ok: false, code: 'NO_EGRESS', message: 'تونل برقرار است ولی داده‌ای از آن عبور نمی‌کند.' };
    }
    return { ok: true };
}

/**
 * Is anything at all getting out, following the machine's own routing?
 *
 * Two independent 204 endpoints, either of which is enough: one blocked target is a
 * normal Tuesday on the networks this app exists for, and treating that as a dead tunnel
 * would tear down working connections. 204-with-no-body specifically, not "any 2xx" — an
 * ISP sinkhole or captive portal answers 200 with an HTML page, and accepting that is how
 * a probe ends up certifying the exact state it was written to catch.
 */
function probeEgressDirect(timeout = 9000) {
    const targets = [
        { host: 'www.gstatic.com', path: '/generate_204' },
        { host: 'cp.cloudflare.com', path: '/generate_204' },
    ];
    return new Promise((resolve) => {
        let pending = targets.length;
        let settled = false;
        const done = (ok) => {
            if (settled) return;
            if (ok) { settled = true; return resolve(true); }
            if (--pending === 0) { settled = true; resolve(false); }
        };
        for (const t of targets) {
            const req = require('http').request({
                host: t.host, port: 80, method: 'GET', path: t.path, timeout,
                headers: { Host: t.host, 'Cache-Control': 'no-cache' },
            }, (res) => { res.resume(); done(res.statusCode === 204); });
            req.on('error', () => done(false));
            req.on('timeout', () => { req.destroy(); done(false); });
            req.end();
        }
    });
}

/** Fetches a tiny URL through the engine's own HTTP proxy. Only meaningful AFTER
 *  verifyTunnel() has confirmed an exit node is selected — on its own it can succeed via
 *  the untunnelled path. */
function probeEgress() {
    return new Promise((resolve) => {
        const req = require('http').request({
            host: '127.0.0.1', port: HTTP_PORT, method: 'GET',
            path: 'http://www.gstatic.com/generate_204',
            headers: { Host: 'www.gstatic.com' },
            timeout: 12000,
        }, (res) => { res.resume(); resolve(res.statusCode === 204 || res.statusCode === 200); });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.end();
    });
}

// `tailscaled --cleanup` removes the system state the daemon installs — the NRPT DNS
// rules above all. Those rules are what keep DNS inside the tunnel, and they OUTLIVE the
// process: if the daemon is force-killed (app crash, task manager, power loss) they stay
// behind pointing at a resolver that no longer exists, and every name lookup on the
// machine fails. To the user that is simply "the internet is gone", with no clue why.
// So cleanup runs on every teardown, and again on process exit, synchronously.
function cleanupSystemState({ sync = false } = {}) {
    if (!binariesReady()) return;
    const args = ['--cleanup'];
    if (sync) {
        try { require('child_process').execFileSync(daemonExe(), args, { windowsHide: true, timeout: 20000 }); } catch (e) {}
        return;
    }
    return run(daemonExe(), args, { timeout: 25000 }).catch(() => {});
}

let exitHooksInstalled = false;
/** Everything this engine changed about the machine, undone synchronously. Safe to call
 *  more than once, and safe to call when nothing was ever started. */
function bailSync() {
    // Proxy/firewall FIRST: a half-torn-down machine that can still reach the internet is
    // recoverable, one that is pointed at a dead proxy is not, and the daemon kill below
    // is what makes the proxy dead.
    runEmergencyUndo();
    try { if (daemonProc) daemonProc.kill(); } catch (e) {}
    try { cleanupSystemState({ sync: true }); } catch (e) {}
}

function installExitHooks() {
    if (exitHooksInstalled) return;
    exitHooksInstalled = true;
    process.on('exit', bailSync);
    process.on('SIGINT', () => { bailSync(); process.exit(130); });
    process.on('SIGTERM', () => { bailSync(); process.exit(143); });
}

/** Clear anything a previous, unclean run left behind. Safe when nothing is stale. */
async function sweepStaleState() {
    adoptLegacyBinaries();
    if (!binariesReady()) return;
    if (daemonAlive()) return;
    await cleanupSystemState();
}

async function disconnect(onLog) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    stopWatchdog();
    try {
        if (binariesReady()) await run(cliExe(), [`--socket=${CONTROL_PIPE}`, 'logout'], { timeout: 20000 });
    } catch (e) {}
    // Wait for it to actually be gone before cleaning up. `--cleanup` run against a
    // daemon that is still holding the adapter silently half-succeeds, and the half it
    // leaves behind is the NRPT DNS policy — i.e. a machine that resolves nothing.
    const dying = daemonProc;
    try { if (dying) dying.kill(); } catch (e) {}
    if (dying && dying.exitCode === null) {
        await new Promise((resolve) => {
            const t = setTimeout(resolve, 5000);
            dying.once('exit', () => { clearTimeout(t); resolve(); });
        });
    }
    daemonProc = null;
    // AFTER the process is gone: leaving the DNS policy in place is what turns a
    // disconnect into "the whole machine lost the internet".
    await cleanupSystemState();
    state = { running: false, connected: false, exitNodeIp: '', mode: '', error: '' };
    log('اتصال قطع شد.');
}

// ── watchdog ────────────────────────────────────────────────────────────────────────
// The connection can degrade without the daemon dying: the exit node stops being selected,
// the node gets logged out, the peer relationship lapses. Nothing in the OS reports that —
// traffic just quietly stops being tunnelled. So the health of the tunnel is polled, and a
// degraded tunnel is treated as a fault to recover from, not a state to sit in.

const WATCHDOG_INTERVAL_MS = 20000;
// Repair attempts are bounded. An unbounded retry loop does not heal anything — it just
// thrashes: each pass tears the connection down, re-engages the kill-switch, and starts
// again, so the user watches the tunnel connect and drop forever while their traffic is
// repeatedly blocked. After this many consecutive failures the engine stops trying and
// says so, which is recoverable; a loop is not.
const MAX_REPAIR_ATTEMPTS = 3;
// A single bad verdict is not a degraded tunnel. `status --json` can time out because the
// machine is loaded or the line stalled for a moment, and treating that like a real fault
// tears down a perfectly good connection — which, on the weak links this app is built for,
// is far more common than an actual degrade. Only a bad verdict that SURVIVES a re-check
// counts.
const BAD_VERDICTS_BEFORE_DEGRADE = 2;
let watchdogTimer = null;
let onDegraded = null;
let onRebuild = null;
let onWatchdogLog = null;
let reconnectInFlight = false;
let repairFailures = 0;
let badStreak = 0;

function wlog(m) { try { onWatchdogLog && onWatchdogLog(m); } catch (e) {} }

function startWatchdog() {
    stopWatchdog();
    badStreak = 0;
    watchdogTimer = setInterval(async () => {
        // Deliberately NOT gated on state.connected: a failed repair sets that false, and
        // gating here would make the first failure permanent — the loop would never retry
        // and never reach the give-up cap.
        if (reconnectInFlight) return;
        try {
            const verdict = await verifyTunnel(state.mode);
            if (verdict.ok) {
                if (badStreak || !state.connected) wlog('تونل دوباره سالم است.');
                badStreak = 0;
                repairFailures = 0;
                state.connected = true;
                state.error = '';
                return;
            }

            badStreak += 1;
            if (badStreak < BAD_VERDICTS_BEFORE_DEGRADE) {
                // Say it, but do nothing yet — most of these never come back.
                wlog(`لغزش لحظه‌ای در تونل (${verdict.code}) — در حال بررسی دوباره…`);
                return;
            }

            state.error = verdict.code;
            wlog(`تونل ناسالم است (${verdict.code}) — تلاش ${repairFailures + 1} از ${MAX_REPAIR_ATTEMPTS} برای بازیابی.`);
            if (repairFailures >= MAX_REPAIR_ATTEMPTS) {
                // Stop the loop and leave the tunnel plainly down. The guard stays engaged
                // (fail-closed) until the user acts.
                stopWatchdog();
                state.connected = false;
                state.error = 'REPAIR_GAVE_UP';
                wlog('بازیابی خودکار ناموفق بود — تونل پایین است و ترافیک مسدود می‌ماند. لطفاً دوباره وصل شوید.');
                if (onDegraded) { try { await onDegraded({ ok: false, code: 'REPAIR_GAVE_UP' }); } catch (e) {} }
                return;
            }
            // Announce BEFORE attempting anything: whoever is listening owns the
            // fail-closed decision, and it must be made while the tunnel is known-bad
            // rather than after a repair attempt has had time to leak traffic.
            if (onDegraded) { try { await onDegraded(verdict); } catch (e) {} }

            reconnectInFlight = true;
            try {
                if (!daemonAlive()) {
                    // The daemon itself is gone (crashed, killed, or it exited when its
                    // adapter was torn out from under it). There is no control socket left
                    // to talk to, so a re-`up` can only fail — which is exactly what it did:
                    // three timeouts, then REPAIR_GAVE_UP, on a fault a restart fixes. Only
                    // a full rebuild recovers this, so ask the owner for one.
                    if (!onRebuild) throw new Error('موتور اتصال اجرا نیست و راهی برای بازسازی ثبت نشده است.');
                    wlog('موتور اتصال از کار افتاده — در حال بازسازی کامل اتصال…');
                    await onRebuild(state.mode || 'tun');
                } else {
                    // A re-`up` is enough when the node is still authenticated and only the
                    // exit-node selection lapsed — the common case, and far cheaper than
                    // tearing the whole session down.
                    await run(cliExe(), [
                        `--socket=${CONTROL_PIPE}`, 'up',
                        `--exit-node=${state.exitNodeIp}`,
                        '--exit-node-allow-lan-access=true',
                        state.mode === 'tun' ? '--accept-dns=true' : '--accept-dns=false',
                        '--unattended',
                    ], { timeout: 45000 });
                }
                // `up` succeeding only means the control plane accepted us again. The next
                // tick's verifyTunnel is what actually clears the counters and re-declares
                // the tunnel healthy.
                wlog('فرمان بازیابی اجرا شد — در حال بررسی نتیجه…');
                badStreak = 0;
            } catch (e) {
                repairFailures += 1;
                state.connected = false; // let the UI/route layer decide to rebuild
                badStreak = 0;
                wlog(`بازیابی ناموفق بود: ${e.message}`);
            } finally {
                reconnectInFlight = false;
            }
        } catch (e) { wlog('بررسی سلامت تونل انجام نشد: ' + e.message); }
    }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
}

function setDegradedHandler(fn) { onDegraded = fn; }
/** How the watchdog rebuilds a connection whose daemon has died. Owned by routes.js,
 *  because a rebuild needs the session and the key, which the engine deliberately does
 *  not keep. */
function setRebuildHandler(fn) { onRebuild = fn; }
/** Where the watchdog narrates itself. Without this its decisions are invisible, and a
 *  mid-session drop arrives with no explanation of what the engine saw. */
function setWatchdogLogger(fn) { onWatchdogLog = fn; }

/** Path-quality report. Only meaningful while connected. */
async function speedtest() {
    // Runs disconnected too: that pass measures the line itself and becomes the baseline
    // the tunnelled runs are compared against.
    return require('./gt-speedtest').run(cliExe(), CONTROL_PIPE, state.connected ? state.exitNodeIp : null);
}

function getStatus() {
    return {
        running: daemonAlive(),
        connected: state.connected && daemonAlive(),
        exitNodeIp: state.exitNodeIp,
        mode: state.mode,
        udp: state.mode === 'tun',
        socksPort: SOCKS_PORT,
        httpPort: HTTP_PORT,
        error: state.error || '',
    };
}

/**
 * Bytes through the exit node since the tunnel came up, for live speed and daily usage
 * (traffic-feed.js). tailscaled counts per peer: TxBytes is what we sent, RxBytes what came
 * back — measured, a 3 MB download raised RxBytes by 3.45 MB. Read through the CLI: the
 * LocalAPI on the same pipe refuses a reader that has not written first ("Unable to
 * impersonate using a named pipe until data has been read"). Null while not connected.
 */
async function readTrafficCounters() {
    if (!state.connected || !daemonAlive()) return null;
    const json = await run(cliExe(), [`--socket=${CONTROL_PIPE}`, 'status', '--json'], { timeout: 4000 });
    const peers = Object.values(JSON.parse(json).Peer || {});
    const exit = peers.find((p) => p.ExitNode);
    if (!exit) return null;
    return { up: Number(exit.TxBytes) || 0, down: Number(exit.RxBytes) || 0 };
}

// The engine's own uplink, which must stay OUTSIDE any TUN that points at it. Relay
// addresses are fetched from the published map rather than hardcoded, because the relay
// fleet changes and a stale list silently reintroduces the loop it exists to prevent.
// Cached for the process lifetime; a failure here is non-fatal (the process-name rule is
// the other half of the same guard).
let uplinkCache = null;

async function getUplinkCidrs() {
    if (uplinkCache) return uplinkCache;
    const out = [];
    try {
        // gtFetch, not fetch: on exactly the filtered networks this app exists for, the
        // direct call fails and the guard silently degrades to empty.
        // Same geo-block as the MSI host: without fallbackOnStatus the 403 arrives as a
        // "success", res.json() chokes on the HTML, and the guard degrades to empty CIDRs
        // silently — on precisely the networks it was written for.
        const res = await gtFetch('https://login.tailscale.com/derpmap/default',
            { fallbackOnStatus: BLOCKED_STATUSES });
        const map = await res.json();
        for (const region of Object.values(map.Regions || {})) {
            for (const node of region.Nodes || []) {
                if (node.IPv4) out.push(`${node.IPv4}/32`);
                if (node.IPv6) out.push(`${node.IPv6}/128`);
            }
        }
    } catch (e) { /* non-fatal — see above */ }
    uplinkCache = out;
    return out;
}

/** Everything needed to tell WHY a connection isn't carrying traffic, in one call:
 *  what the control plane thinks our node is, whether an exit node is actually selected,
 *  and what the daemon itself last said. */
async function diagnose() {
    const out = { binaries: binariesReady(), daemonAlive: daemonAlive(), status: '', netcheckExitNode: '', log: '', egress: null };
    try {
        out.status = await run(cliExe(), [`--socket=${CONTROL_PIPE}`, 'status'], { timeout: 20000 });
    } catch (e) { out.status = 'ERR: ' + e.message; }
    try {
        const json = await run(cliExe(), [`--socket=${CONTROL_PIPE}`, 'status', '--json'], { timeout: 20000 });
        const parsed = JSON.parse(json);
        const peers = Object.values(parsed.Peer || {});
        const exit = peers.find(p => p.ExitNode);
        const offers = peers.filter(p => p.ExitNodeOption).map(p => p.TailscaleIPs && p.TailscaleIPs[0]);
        out.netcheckExitNode = exit
            ? `USING ${exit.TailscaleIPs && exit.TailscaleIPs[0]}`
            : `NONE SELECTED. offered-by: ${offers.join(', ') || '(none — exit node not approved)'}`;
    } catch (e) { out.netcheckExitNode = 'ERR: ' + e.message; }
    try { out.egress = await probeEgress(); } catch (e) { out.egress = false; }
    try { out.log = fs.readFileSync(DAEMON_LOG, 'utf8').split(/\r?\n/).slice(-25).join('\n'); } catch (e) {}
    return out;
}

module.exports = {
    connect, disconnect, getStatus, readTrafficCounters, ensureBinaries, binariesReady, probeEgress, probeEgressDirect,
    diagnose, getUplinkCidrs, setDegradedHandler, setRebuildHandler, setWatchdogLogger, verifyTunnel,
    speedtest, sweepStaleState, registerEmergencyUndo, bailSync, installExitHooks,
    TUN_ADAPTER, DAEMON_EXE, daemonExe, cliExe, CORE_DIR, SOCKS_PORT, HTTP_PORT, PROCESS_NAME, ENGINE_LABEL, DAEMON_LOG,
};
