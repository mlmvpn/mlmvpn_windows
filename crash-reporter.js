// --- Settings › درباره › «گزارش خطا»: Android's CrashReporter, for the Windows build ---
//
// Android records every crash to files/crashlogs/ and the Settings row shows how many there are
// and sends them on. Here the same record is kept in ~/.mlmvpn/crashlogs, one text file per
// crash: the version, Windows, the time, what broke and its stack.
//
// Two kinds of crash exist on this side:
//   * the main process (where the server and every engine manager run) — an exception nobody
//     caught, or a promise nobody handled. It is recorded through `uncaughtExceptionMonitor`,
//     which WATCHES and changes nothing: whatever the process did about such an error before
//     this file existed, it still does. (A plain 'uncaughtException' listener would swallow the
//     crash and leave the app running in whatever state the error left behind.)
//   * the page — the renderer dying (out of memory on a weak PC, a GPU fault). main.js reports
//     that one, from Electron's render-process-gone.
// Nothing is sent anywhere. Android's row shares the files; here the row opens the folder with
// the newest report selected and copies it, for the user to send wherever they choose.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.mlmvpn', 'crashlogs');
const KEEP = 30;

let installed = false;

function version() {
    try { return require('./package.json').version; } catch (e) { return '?'; }
}

function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** Write one report. Never throws: a crash reporter that crashes hides the crash it was for. */
function record(kind, error, extra) {
    try {
        fs.mkdirSync(DIR, { recursive: true });
        const err = error instanceof Error ? error : new Error(typeof error === 'string' ? error : JSON.stringify(error));
        const lines = [
            `MLM VPN ${version()} — ${kind === 'renderer' ? 'صفحه‌ی برنامه از کار افتاد' : 'خطای کنترل‌نشده در برنامه'}`,
            `زمان: ${new Date().toISOString()}`,
            `ویندوز: ${os.release()} (${os.arch()})  ·  ${process.versions.electron ? 'Electron ' + process.versions.electron : 'Node ' + process.version}`,
            extra ? `جزئیات: ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '',
            '',
            err.stack || String(err),
        ].filter((x) => x !== '');
        const file = path.join(DIR, `crash-${stamp()}-${kind}.txt`);
        fs.writeFileSync(file, lines.join('\n') + '\n');
        prune();
        return file;
    } catch (e) {
        return null;
    }
}

function prune() {
    const all = list();
    for (const r of all.slice(KEEP)) { try { fs.unlinkSync(r.file); } catch (e) { /* in use */ } }
}

/** Newest first. */
function list() {
    let names = [];
    try { names = fs.readdirSync(DIR).filter((n) => /^crash-.*\.txt$/.test(n)); } catch (e) { return []; }
    return names.map((n) => {
        const file = path.join(DIR, n);
        let at = 0, title = '';
        try { at = fs.statSync(file).mtimeMs; } catch (e) { /* gone */ }
        try {
            const body = fs.readFileSync(file, 'utf8').split('\n');
            // The first line is the header; the first line of the stack says what broke.
            title = (body.find((l, i) => i > 3 && l.trim()) || body[0] || '').trim().slice(0, 160);
        } catch (e) { /* unreadable */ }
        return { file, name: n, at, kind: /-renderer\.txt$/.test(n) ? 'renderer' : 'main', title };
    }).sort((a, b) => b.at - a.at);
}

function read(name) {
    const safe = path.basename(String(name || ''));
    if (!/^crash-.*\.txt$/.test(safe)) throw new Error('نام گزارش معتبر نیست.');
    return fs.readFileSync(path.join(DIR, safe), 'utf8');
}

function clear() {
    let removed = 0;
    for (const r of list()) { try { fs.unlinkSync(r.file); removed++; } catch (e) { /* in use */ } }
    return removed;
}

/** Show the folder in Explorer with the newest report selected (Electron), or just the folder. */
function reveal() {
    fs.mkdirSync(DIR, { recursive: true });
    const newest = list()[0];
    if (process.versions && process.versions.electron) {
        try {
            const { shell } = require('electron');
            if (newest) shell.showItemInFolder(newest.file); else shell.openPath(DIR);
            return true;
        } catch (e) { /* fall through */ }
    }
    require('child_process').spawn('explorer.exe', newest ? ['/select,', newest.file] : [DIR], { detached: true, stdio: 'ignore' }).unref();
    return true;
}

function install() {
    if (installed) return;
    installed = true;
    process.on('uncaughtExceptionMonitor', (err, origin) => {
        record('main', err, origin === 'unhandledRejection' ? 'promise رد‌شده‌ای که کسی به آن رسیدگی نکرد' : null);
    });
}

module.exports = { install, record, list, read, clear, reveal, DIR };
