// --- GST core process manager ---
// Owns core/gst.exe (the vendored Rust engine, built from gst-src/ — see the build
// recipe in docs/GST-PLAN.md). Generates config.toml from the relay store, spawns the
// process, streams its output into the core log, and stops it cleanly.
//
// The engine listens on two local ports and does nothing to the OS by itself:
//   HTTP  proxy  -> runtime.httpPort   (default 8085)
//   SOCKS5 proxy -> runtime.socksPort  (default 8086)
// System-proxy and TUN are separate layers stacked on top by the panel, exactly like
// the Aether panel does — see the three connection modes in the plan.

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn } = require('child_process');

const store = require('./gst-config');
const log = require('./gst-log');

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

const ROOT = path.dirname(getUnpackedDir());
const CORE_DIR = path.join(ROOT, 'core');
// Generated config, not user data: it is rewritten from the relay store on every start,
// so losing it on uninstall costs nothing. It stays beside the app deliberately —
// writing a file the engine reads into the user's home directory would spread the
// app's runtime across two places for no benefit.
const DATA_DIR = path.join(ROOT, 'data');
// Resolved per use: «ام‌ال‌ام استور» can install a newer core, and it takes effect on the next start.
const exePath = () => require('../core-paths').file('gst', 'gst.exe', path.join(CORE_DIR, 'gst.exe'));
const CONFIG_FILE = path.join(DATA_DIR, 'gst-config.toml');

let proc = null;
let running = false;
let startedAt = 0;
let lastExit = null;   // { code, signal, at } — kept so the panel can explain a crash

// ── config.toml generation ────────────────────────────────────────────────────

/**
 * TOML string escaping. Deployment ids and auth keys are generated from safe
 * alphabets, but relay names and manually-added SNI/IP entries come from the user,
 * and an unescaped quote there would produce a config the engine refuses to parse
 * with an error that points at a line number the user never wrote.
 */
function tomlStr(value) {
    return '"' + String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '')
        .replace(/\t/g, '\\t') + '"';
}

function tomlList(values) {
    return '[' + values.map(tomlStr).join(', ') + ']';
}

/**
 * Build config.toml from the relay store.
 *
 * Only relays with a deployment id are handed to the engine. The per-relay Cloudflare
 * switch is deliberately NOT represented here: whether a relay exits via Cloudflare is
 * decided by the WORKER_URL baked into that relay's Apps Script, so from the engine's
 * point of view every relay is just a deployment id. That is what keeps the two legs
 * independently diagnosable — and what lets a broken Worker degrade to the direct path
 * instead of taking the tunnel down.
 */
function buildConfig() {
    const cfg = store.load();
    const relays = store.getUsableRelays();
    if (!relays.length) {
        throw new Error('هیچ ریلی سالمی تنظیم نشده است — اول از ویزارد یک ریلی بسازید.');
    }

    const net_ = cfg.network;
    const rt = cfg.runtime;
    const ids = relays.map(r => r.deploymentId);

    // google_ip is the single IP the engine dials; the rest of the ticked list is kept
    // in the panel so the user can switch without a rescan. Highest-priority ticked IP
    // wins, which is what the network tab's "auto select" writes to the front.
    const googleIp = (net_.ips && net_.ips[0]) || '216.239.38.120';
    const snis = (net_.snis && net_.snis.length) ? net_.snis : ['www.google.com'];

    const toml = `# ساخته‌شده به‌صورت خودکار توسط MLM VPN Scanner — دستی ویرایش نکنید.
# هر بار که تونل گوگل اسکریپت را روشن کنید این فایل از نو نوشته می‌شود.
# تاریخ ساخت: ${new Date().toISOString()}

[relay]
mode = "apps_script"
script_ids = ${tomlList(ids)}
auth_key = ${tomlStr(cfg.authKey)}
enable_batching = true

[network]
google_ip = ${tomlStr(googleIp)}
front_domain = ${tomlStr(snis[0])}
sni_hosts = ${tomlList(snis)}
listen_host = "127.0.0.1"
listen_port = ${Number(rt.httpPort) || 8085}
socks5_port = ${Number(rt.socksPort) || 8086}
verify_ssl = true

[network.hosts]

[scan]

[logging]
log_level = "info"

[exit_node]
enabled = false
`;

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, toml, 'utf8');

    log.info('core', `پیکربندی ساخته شد: ${ids.length} ریلی، ` +
        `آی‌پی ${googleIp}، ${snis.length} SNI`);
    return { path: CONFIG_FILE, relayCount: ids.length, googleIp, snis };
}

// ── process control ───────────────────────────────────────────────────────────

function isRunning() {
    return running && proc && !proc.killed;
}

/**
 * Bytes the engine has carried, for live speed and daily usage (traffic-feed.js). The core
 * keeps per-relay counters and flushes them to its own quota_state.json every second
 * (gst-src quota_tracker.rs): bytes_up is what it sent to Apps Script, bytes_down what came
 * back. A relay's counters restart when its daily window rolls over; traffic-feed treats a
 * total that went down as a new baseline, never as traffic. Null when it cannot say.
 */
function readTrafficCounters() {
    if (!running) return null;
    try {
        const file = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'mhrv-rs', 'config', 'quota_state.json');
        const st = JSON.parse(fs.readFileSync(file, 'utf8'));
        let up = 0, down = 0;
        for (const b of Object.values(st.buckets || {})) {
            up += Number(b.bytes_up) || 0;
            down += Number(b.bytes_down) || 0;
        }
        return { up, down };
    } catch (e) {
        return null;
    }
}

function getStatus() {
    const rt = store.getRuntime();
    return {
        running: isRunning(),
        pid: isRunning() ? proc.pid : null,
        uptime: isRunning() ? Date.now() - startedAt : 0,
        httpPort: rt.httpPort,
        socksPort: rt.socksPort,
        systemProxy: !!rt.systemProxy,
        tun: !!rt.tun,
        autoOptimize: !!rt.autoOptimize,
        relayCount: store.getUsableRelays().length,
        lastExit,
        exeExists: fs.existsSync(exePath()),
    };
}

/** True once something is accepting connections on `port`. */
function probePort(port, timeout = 800) {
    return new Promise(resolve => {
        const sock = new net.Socket();
        const done = ok => { sock.destroy(); resolve(ok); };
        sock.setTimeout(timeout);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
        sock.connect(port, '127.0.0.1');
    });
}

/**
 * Wait until the engine's HTTP listener answers. Reporting "connected" the moment
 * spawn() returns would be a lie — the engine still has to read config, build the CA
 * and bind. A panel that goes green before the port is live is the single most
 * misleading thing this module could do.
 */
async function waitForListener(port, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!isRunning()) return false;          // died during startup
        if (await probePort(port)) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

/**
 * Engine stdout/stderr -> core log, with the noisiest lines dropped.
 * The engine emits ANSI colour codes (visible in the scan-ips output during the build
 * test); the log panel renders them literally, so they are stripped here.
 */
function handleOutput(chunk) {
    const text = String(chunk).replace(/\[[0-9;]*m/g, '');
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (/ DEBUG | TRACE /.test(line)) continue;

        if (/ ERROR |panicked at/i.test(line)) log.error('engine', line);
        else if (/ WARN /.test(line)) log.warn('engine', line);
        else log.info('engine', line);
    }
}

async function start() {
    if (isRunning()) {
        log.info('core', 'هسته از قبل در حال اجراست');
        return getStatus();
    }
    if (!fs.existsSync(exePath())) {
        throw new Error(`هستهٔ تونل پیدا نشد: ${exePath()}`);
    }

    const built = buildConfig();
    const rt = store.getRuntime();
    const port = Number(rt.httpPort) || 8085;

    // One default route, one Windows proxy setting: two engines fighting over them is
    // how traffic leaks. Required lazily to keep the dependency one-way — gst-runtime
    // reaches into this module, not the other way round at load time.
    try {
        require('./gst-runtime').stopCompetingEngines();
    } catch (e) {
        log.warn('core', `بررسی موتورهای دیگر ناموفق بود: ${e.message}`);
    }

    // A stale listener on our port means either a previous run never died or another
    // program owns it. Starting anyway would leave the engine failing to bind while the
    // panel shows green, so fail loudly instead.
    if (await probePort(port)) {
        throw new Error(`پورت ${port} از قبل اشغال است — یک نمونهٔ دیگر از تونل در حال اجراست یا برنامهٔ دیگری آن را گرفته.`);
    }

    log.info('core', `راه‌اندازی هسته با ${built.relayCount} ریلی…`);
    lastExit = null;

    proc = spawn(exePath(), ['-c', CONFIG_FILE], {
        cwd: CORE_DIR,
        windowsHide: true,
        env: { ...process.env, RUST_LOG: 'info' },
    });

    running = true;
    startedAt = Date.now();

    proc.stdout.on('data', handleOutput);
    proc.stderr.on('data', handleOutput);

    proc.on('error', err => {
        running = false;
        log.error('core', `اجرای هسته ناموفق بود: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
        const wasRunning = running;
        running = false;
        proc = null;
        lastExit = { code, signal, at: Date.now() };

        if (wasRunning && code !== 0 && code !== null) {
            log.error('core', `هسته با کد ${code} بسته شد`);
        } else {
            log.info('core', 'هسته متوقف شد');
        }
    });

    const live = await waitForListener(port);
    if (!live) {
        await stop();
        throw new Error(`هسته بالا آمد ولی روی پورت ${port} پاسخ نداد — لاگ هسته را ببینید.`);
    }

    log.ok('core', `تونل آماده است — HTTP روی ${port}، SOCKS5 روی ${rt.socksPort}`);
    return getStatus();
}

/**
 * Hand the machine back. A stopped tunnel must never leave Windows pointing at a dead
 * proxy port or a TUN adapter with no engine behind it — both strand the user with no
 * internet and no visible cause.
 */
async function releaseSystemState() {
    try {
        await require('./gst-runtime').releaseAll();
    } catch (e) {
        log.warn('core', `بازگرداندن تنظیمات سیستم ناموفق بود: ${e.message}`);
    }
}

function stop() {
    return new Promise(resolve => {
        const finish = async (status) => {
            await releaseSystemState();
            resolve(status);
        };

        if (!proc) {
            running = false;
            return finish(getStatus());
        }
        const target = proc;
        running = false;

        // Give it a moment to close listeners, then make sure it is really gone —
        // a surviving engine would hold the port and block the next start.
        const killTimer = setTimeout(() => {
            try { target.kill('SIGKILL'); } catch (e) { /* already gone */ }
        }, 3000);

        target.once('exit', () => {
            clearTimeout(killTimer);
            finish(getStatus());
        });

        try { target.kill(); } catch (e) {
            clearTimeout(killTimer);
            finish(getStatus());
        }
    });
}

/**
 * Apply a config change to a running tunnel. The engine reads config.toml once at
 * startup, so "reload" is a restart — but the panel calls this from the network tab
 * while the user is browsing, so it is worth doing in one hop rather than making the
 * caller sequence stop/start and handle a half-down state.
 */
async function restart() {
    if (!isRunning()) return start();
    log.info('core', 'اعمال تغییرات — راه‌اندازی مجدد هسته…');

    // stop() hands the machine back (proxy off, TUN down) so a dead tunnel never leaves
    // Windows stranded. On a restart that would silently drop the mode the user chose,
    // so capture it and put it back once the engine is listening again.
    const runtime = require('./gst-runtime');
    const before = await runtime.getState();

    await stop();
    const status = await start();

    try {
        if (before.systemProxy) await runtime.setSystemProxy(true);
        else if (before.tun) await runtime.setTun(true);
    } catch (e) {
        log.warn('core', `بازگرداندن حالت اتصال پس از راه‌اندازی مجدد ناموفق بود: ${e.message}`);
    }
    return status;
}

/** Run a one-shot engine subcommand (test / scan-ips / scan-sni / test-sni). */
function runCommand(args, { timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(exePath())) {
            return reject(new Error(`هستهٔ تونل پیدا نشد: ${exePath()}`));
        }
        // Subcommands need a config file even when the values are irrelevant to them
        // (scan-ips only reads [network]), so reuse the generated one when it exists.
        const argv = fs.existsSync(CONFIG_FILE) ? [...args, '-c', CONFIG_FILE] : args;

        const child = spawn(exePath(), argv, { cwd: CORE_DIR, windowsHide: true });
        let out = '';
        let err = '';

        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
            reject(new Error('اجرای دستور بیش از حد طول کشید'));
        }, timeout);

        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; });
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('exit', code => {
            clearTimeout(timer);
            const clean = s => String(s).replace(/\[[0-9;]*m/g, '');
            resolve({ code, stdout: clean(out), stderr: clean(err) });
        });
    });
}

module.exports = {
    exePath,
    get EXE() { return exePath(); },
    CONFIG_FILE,
    buildConfig,
    isRunning,
    readTrafficCounters,
    getStatus,
    start,
    stop,
    restart,
    runCommand,
    probePort,
};
