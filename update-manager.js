// --- Settings › درباره › «به‌روزرسانی نرم‌افزار»: Android's updater, for the Windows build ---
//
// Android checks GitHub's latest release of mlmvpn/mlmvpn_android against the installed version
// (UpdateChecker.kt). The Windows builds are published the same way, in mlmvpn/mlmvpn_windows,
// with the names this app's own build produces (package.json › build: mlm-vpn-Setup-<v>-<arch>.exe
// and mlm-vpn-Portable-<v>-<arch>.exe). The same rules hold:
//   * `/releases/latest` is GitHub's answer — never a draft or a pre-release;
//   * whatever it returns is still compared with the installed version, so the app never
//     downgrades (the newest Windows release today is older than this build, and says so);
//   * GitHub is often unreachable from Iran, so every request goes through gt-net's chain —
//     direct, then the Windows proxy, then this app's own engine — and a failure is SAID, not
//     swallowed: a user who pressed "check" is owed an answer.
// The file matching this install is picked: the portable build gets the portable exe, the
// installed one the installer, for this machine's architecture.
//
// «دانلود خودکار»: Android downloads in the background only on Wi-Fi without a data limit. The
// Windows counterpart of "a limit" is a connection marked metered, so the background download
// runs only when Windows reports the connection as Unrestricted.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');

const REPO = 'mlmvpn/mlmvpn_windows';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const DIR = path.join(os.homedir(), '.mlmvpn', 'updates');
const FILE = path.join(os.homedir(), '.mlmvpn', 'update.json');

let state = { checking: false, latest: null, error: '', download: null };

function saved() {
    try { return Object.assign({ autoDownload: true }, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { return { autoDownload: true }; }
}
function persist(patch) {
    const next = Object.assign(saved(), patch);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    return next;
}

function currentVersion() {
    try { return require('./package.json').version; } catch (e) { return '0.0.0'; }
}

/** 1 when a is newer than b, -1 older, 0 equal — by the dotted numbers, "v" or not. */
function compare(a, b) {
    const pa = String(a || '').replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '').replace(/^v/i, '').split(/[.\-+]/).map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
    }
    return 0;
}

function installKind() { return process.env.PORTABLE_EXECUTABLE_FILE ? 'Portable' : 'Setup'; }
function arch() { return process.arch === 'ia32' ? 'ia32' : 'x64'; }

/** The release file for this install, or null. */
function pickAsset(assets, kind = installKind(), a = arch()) {
    const exes = (assets || []).filter((x) => /\.exe$/i.test(x.name));
    const exact = new RegExp(`-${kind}-[\\d.]+-${a}\\.exe$`, 'i');
    return exes.find((x) => exact.test(x.name))
        || exes.find((x) => new RegExp(kind, 'i').test(x.name) && new RegExp(a, 'i').test(x.name))
        || exes.find((x) => new RegExp(kind, 'i').test(x.name))
        || null;
}

function fetchViaChain(url, options) {
    return require('./github-tunnel/gt-net').gtFetch(url, options);
}

async function check() {
    if (state.checking) return status();
    state.checking = true;
    state.error = '';
    try {
        const res = await fetchViaChain(API_URL, {
            timeoutMs: 15000,
            headers: { 'User-Agent': 'mlmvpn-windows', Accept: 'application/vnd.github+json' },
        });
        if (!res.ok) throw new Error(res.status === 404 ? 'هنوز نسخه‌ای منتشر نشده است' : `پاسخ ${res.status} از گیت‌هاب`);
        const j = await res.json();
        const version = String(j.tag_name || j.name || '').replace(/^v/i, '');
        const asset = pickAsset(j.assets);
        state.latest = {
            version,
            name: j.name || version,
            body: String(j.body || '').slice(0, 8000),
            publishedAt: j.published_at || '',
            newer: compare(version, currentVersion()) > 0,
            asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url } : null,
        };
        persist({ lastCheckAt: Date.now() });
    } catch (e) {
        state.error = e.message || String(e);
    } finally {
        state.checking = false;
    }
    return status();
}

function downloadedFile() {
    const s = saved();
    if (!s.downloadedFile || !fs.existsSync(s.downloadedFile)) return null;
    return { file: s.downloadedFile, version: s.downloadedVersion };
}

async function download() {
    const l = state.latest;
    if (!l || !l.newer) throw new Error('نسخه‌ی جدیدتری برای دانلود نیست.');
    if (!l.asset) throw new Error('آخرین نسخه برای این نصب فایلی ندارد.');
    if (state.download && state.download.running) return status();
    fs.mkdirSync(DIR, { recursive: true });
    const target = path.join(DIR, l.asset.name);
    const part = target + '.part';
    const done = downloadedFile();
    if (done && done.file === target && done.version === l.version) return status();

    state.download = { running: true, bytes: 0, total: l.asset.size || 0, error: '' };
    let lastByteAt = Date.now();
    let stalled = false;
    let reader = null;
    // No deadline on the request itself: gtFetch's per-attempt timeout covers the body too, and
    // on a throttled line a 170 MB file takes a long — but steady — time. A dead route still
    // fails fast (the connect timeout), and a transfer that stops moving is cut after a minute
    // of silence by cancelling the body, which leaves the route chain's own attempts untouched.
    const stall = setInterval(() => {
        if (reader && Date.now() - lastByteAt > 60000) { stalled = true; reader.cancel().catch(() => {}); }
    }, 5000);
    try {
        const res = await fetchViaChain(l.asset.url, { redirect: 'follow', headers: { 'User-Agent': 'mlmvpn-windows' } });
        if (!res.ok || !res.body) throw new Error(`پاسخ ${res.status} هنگام دانلود`);
        const out = fs.createWriteStream(part);
        reader = res.body.getReader();
        lastByteAt = Date.now();
        try {
            for (;;) {
                const { value, done: end } = await reader.read();
                if (end) break;
                lastByteAt = Date.now();
                state.download.bytes += value.length;
                if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
            }
        } finally {
            await new Promise((r) => out.end(r));
        }
        if (stalled) throw new Error('دانلود یک دقیقه جلو نرفت و متوقف شد');
        if (l.asset.size && state.download.bytes !== l.asset.size) throw new Error('دانلود پیش از کامل شدن فایل قطع شد');
        fs.renameSync(part, target);
        persist({ downloadedFile: target, downloadedVersion: l.version });
        state.download = { running: false, bytes: state.download.bytes, total: state.download.total, done: true };
    } catch (e) {
        try { fs.unlinkSync(part); } catch (x) { /* nothing written */ }
        state.download = { running: false, bytes: 0, total: l.asset.size || 0, error: e.message || String(e) };
    } finally {
        clearInterval(stall);
    }
    return status();
}

/** Start a download without waiting for it; the page follows it through status(). */
function startDownload() {
    const l = state.latest;
    if (!l || !l.newer) throw new Error('نسخه‌ی جدیدتری برای دانلود نیست.');
    if (!l.asset) throw new Error('آخرین نسخه برای این نصب فایلی ندارد.');
    if (!(state.download && state.download.running)) download().catch(() => {});
    return status();
}

/**
 * The installer runs, and the app gets out of its way; the portable build's new exe is shown in
 * Explorer, since a portable app is replaced by the user, not by an installer.
 */
function install() {
    const d = downloadedFile();
    if (!d) throw new Error('فایل به‌روزرسانی دانلود نشده است.');
    let electron = null;
    if (process.versions && process.versions.electron) { try { electron = require('electron'); } catch (e) { electron = null; } }
    if (/Portable/i.test(path.basename(d.file))) {
        if (electron && electron.shell) electron.shell.showItemInFolder(d.file);
        return { opened: 'folder', file: d.file };
    }
    spawn(d.file, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    persist({ lastInstalledAt: Date.now(), lastInstalledVersion: d.version });
    // The installer cannot replace files the running app holds open.
    if (electron && electron.app) setTimeout(() => { try { electron.app.quit(); } catch (e) { /* already going */ } }, 1500);
    return { opened: 'installer', file: d.file };
}

/** When this build was put on the machine: the date of the exe itself, as Windows has it. */
function installedOn() {
    try {
        const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
        const st = fs.statSync(exe);
        return (st.birthtimeMs || st.mtimeMs) || null;
    } catch (e) { return null; }
}

function status() {
    const s = saved();
    return {
        currentVersion: currentVersion(),
        kind: installKind(),
        arch: arch(),
        checking: state.checking,
        latest: state.latest,
        error: state.error,
        download: state.download,
        downloaded: downloadedFile(),
        autoDownload: s.autoDownload !== false,
        lastCheckAt: s.lastCheckAt || null,
        installedOn: installedOn(),
        repo: REPO,
    };
}

function setAutoDownload(on) { persist({ autoDownload: !!on }); return status(); }

/** Is the current connection unmetered? (Windows' own cost flag; unknown counts as metered.) */
function unmetered() {
    return new Promise((resolve) => {
        const ps = '[void][Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime];' +
            '$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile(); if($p){$p.GetConnectionCost().NetworkCostType}';
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000, windowsHide: true }, (err, out) => {
            resolve(!err && /Unrestricted/i.test(String(out || '')));
        });
    });
}

/**
 * At start: check at most every twelve hours, and fetch a newer build in the background when the
 * user allows it and the connection is not metered. A failed check here is silent — nobody asked —
 * and is simply tried again next start; the page's own «بررسی» always says what happened.
 */
async function background(log = () => {}) {
    const s = saved();
    if (s.lastCheckAt && Date.now() - s.lastCheckAt < 12 * 3600 * 1000) return;
    await check();
    if (!state.latest || !state.latest.newer) return;
    log(`[UPDATE] نسخه‌ی ${state.latest.version} منتشر شده است — تنظیمات › درباره › به‌روزرسانی نرم‌افزار.`);
    if (!saved().autoDownload || !state.latest.asset) return;
    if (!(await unmetered())) { log('[UPDATE] اتصال فعلی محدود (metered) است — دانلود خودکار انجام نشد.'); return; }
    log(`[UPDATE] نسخه‌ی ${state.latest.version} در پس‌زمینه دانلود می‌شود…`);
    await download().catch(() => {});
}

module.exports = { check, download, startDownload, install, status, setAutoDownload, background, compare, pickAsset, REPO };
