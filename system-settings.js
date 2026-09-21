// --- Settings › «VPN همیشه روشن» and › سیستم › «رفتار هنگام قفل شدن ویندوز» ---
//
// ALWAYS-ON. Android's row opens the system's own always-on VPN setting: the OS then starts the
// app's VPN at boot and keeps it up. Windows has no such setting, so its two halves are built
// here: the app starts when the user logs on, and on start it reconnects the last connection.
// The start-with-Windows half cannot be a Run-key entry:
// this app requires Administrator, and Windows silently skips an elevated app in the Run key.
// So it is a logon scheduled task "with highest privileges" — the documented way an elevated
// app starts at logon without a UAC prompt. Created and removed only when the user flips the
// switch, and read back from Windows (schtasks /Query), never assumed. The reconnect half is the
// server's (server.js › alwaysOnReplay), from the record kept below.
//
// SCREEN OFF → LOCK. Android can disconnect after the screen has been off for 1, 5, 30 or 60
// minutes, to save battery. A PC's counterpart of "the screen went off and nobody is using the
// phone" is the session being locked, so: after the chosen minutes of the lock screen, every
// connection is ended; unlocking before that cancels it. Electron's powerMonitor reports both.
//
// Saved in ~/.mlmvpn/system-settings.json.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const FILE = path.join(os.homedir(), '.mlmvpn', 'system-settings.json');
const TASK = 'MLM VPN (Always-On)';
const LOCK_CHOICES = [0, 1, 5, 30, 60];

function get() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { raw = {}; }
    return {
        alwaysOn: raw.alwaysOn === true,
        lockMinutes: LOCK_CHOICES.includes(Number(raw.lockMinutes)) ? Number(raw.lockMinutes) : 0,
    };
}

function save(next) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    return next;
}

function run(exe, args, timeout = 20000) {
    return new Promise((resolve) => {
        execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') + String(stderr || '') });
        });
    });
}

/** The program a logon task should start: the portable exe itself when this is the portable build. */
function launcherPath() {
    // electron-builder's portable build unpacks to a temp folder and runs from there;
    // PORTABLE_EXECUTABLE_FILE is the .exe the user actually has.
    return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
}

async function taskExists() {
    return (await run('schtasks.exe', ['/Query', '/TN', TASK])).code === 0;
}

async function setAlwaysOn(on) {
    const cur = get();
    if (on) {
        const exe = launcherPath();
        if (/[\\/]node\.exe$/i.test(exe)) throw new Error('فقط در برنامه‌ی نصب‌شده کار می‌کند.');
        const r = await run('schtasks.exe', ['/Create', '/TN', TASK, '/TR', `"${exe}"`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']);
        if (r.code !== 0 || !(await taskExists())) throw new Error('ویندوز اجازه‌ی ساختن کار زمان‌بندی‌شده را نداد: ' + r.out.trim().split('\n').pop());
    } else if (await taskExists()) {
        await run('schtasks.exe', ['/Delete', '/TN', TASK, '/F']);
    }
    return save(Object.assign(cur, { alwaysOn: !!on }));
}

function setLockMinutes(m) {
    const n = Number(m);
    if (!LOCK_CHOICES.includes(n)) throw new Error('مقدار شناخته نشد.');
    return save(Object.assign(get(), { lockMinutes: n }));
}

/** State as Windows has it: the saved switch AND whether the logon task really exists. */
async function status() {
    const s = get();
    return Object.assign(s, { taskPresent: await taskExists(), launcher: launcherPath() });
}

// ── The connection Always-On brings back ─────────────────────────────────────────────────
// Recorded by the server when a connection comes up, changed as its path changes (system proxy
// / full tunnel), and forgotten when the USER disconnects it — so a connection that was still up
// when the app closed (or Windows shut down) is the one that returns at the next logon, and one
// the user ended stays ended. One record: the newest connection replaces the last.
const LAST_FILE = path.join(os.homedir(), '.mlmvpn', 'last-connection.json');

function lastConnection() {
    try { const j = JSON.parse(fs.readFileSync(LAST_FILE, 'utf8')); return j && j.kind ? j : null; } catch (e) { return null; }
}
function rememberConnection(rec) {
    try {
        fs.mkdirSync(path.dirname(LAST_FILE), { recursive: true });
        fs.writeFileSync(LAST_FILE, JSON.stringify(Object.assign({ at: Date.now() }, rec), null, 2));
    } catch (e) { /* Always-On simply has nothing to replay */ }
}
/** Change the remembered connection's path, if it is still the one of this kind. */
function updateConnection(kind, patch) {
    const cur = lastConnection();
    if (cur && cur.kind === kind) rememberConnection(Object.assign(cur, patch));
}
function forgetConnection(kind) {
    const cur = lastConnection();
    if (cur && (!kind || cur.kind === kind)) { try { fs.unlinkSync(LAST_FILE); } catch (e) { /* already gone */ } }
}

let lockTimer = null;
/**
 * Watch the lock screen (Electron's powerMonitor, main process — where this server runs).
 * `disconnectAll(reason)` ends every connection; it is the server's to define.
 */
function installLockWatcher(disconnectAll, log = () => {}) {
    if (!(process.versions && process.versions.electron)) return false;
    let pm;
    try { pm = require('electron').powerMonitor; } catch (e) { return false; }
    if (!pm) return false;
    pm.on('lock-screen', () => {
        const m = get().lockMinutes;
        clearTimeout(lockTimer);
        if (!m) return;
        log(`[SYS] ویندوز قفل شد — اگر تا ${m} دقیقه باز نشود، اتصال‌ها قطع می‌شوند.`);
        lockTimer = setTimeout(() => {
            lockTimer = null;
            Promise.resolve(disconnectAll(`ویندوز ${m} دقیقه قفل ماند`)).catch(() => {});
        }, m * 60 * 1000);
    });
    pm.on('unlock-screen', () => { if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; log('[SYS] قفل باز شد — قطع اتصال لغو شد.'); } });
    return true;
}

module.exports = {
    get, status, setAlwaysOn, setLockMinutes, installLockWatcher,
    lastConnection, rememberConnection, updateConnection, forgetConnection,
    LOCK_CHOICES, FILE, LAST_FILE, TASK,
};
