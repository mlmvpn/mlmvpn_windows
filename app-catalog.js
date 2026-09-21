// --- The apps «مسیر برنامه‌ها» offers: what is installed, with its real icon ---
//
// Android asks the package manager for every launchable app and its icon. Windows has no one
// list like that, so this builds one from the two places a person's apps actually show up:
//   * the Start menu (all users' and this user's) — every installed program leaves a shortcut
//     there, and the shortcut's target is the exe that will own the connections;
//   * the processes running right now — which is how apps with no shortcut get in: portable
//     programs, and Microsoft Store apps, whose exe lives in the locked WindowsApps folder.
// The icon is Windows' own for that exe (Electron's app.getFileIcon), so the list reads like the
// Start menu does. Anything else can still be added by picking its exe (browse()).
//
// The server runs in Electron's main process, which is what makes shell.readShortcutLink and
// app.getFileIcon reachable here. Outside Electron (tests, the UI preview) shortcuts are read
// through PowerShell instead and the rows simply have no icon.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

let electron;
function el() {
    if (electron === undefined) {
        // Only inside Electron. From plain Node, require('electron') is the npm package, whose
        // index.js tries to DOWNLOAD the Electron binary when it is missing.
        electron = null;
        if (process.versions && process.versions.electron) {
            try { const e = require('electron'); electron = e && e.app && e.shell ? e : null; } catch (err) { electron = null; }
        }
    }
    return electron;
}

function startDirs() {
    return [
        path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
        path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    ];
}

// Not apps a person routes: uninstallers, setup and update helpers, manuals and links.
const SKIP_NAME = /(^|\b)(uninstall|uninst|unins\d*|setup|install(er)?|update(r)?|readme|help|manual|documentation|license|website|crash ?report(er)?|maintenance|repair)(\b|$)/i;
// Inside an exe's own name the words run together ("vpnsetup", "unins000"), so no word edges.
const SKIP_EXE = /unins|uninstall|setup|installer|updater|update\.exe$|crashreport|crashpad|setlang|helper\.exe$/i;
// Windows' own components (anything under C:\Windows) never route deliberately and are not
// worth the scroll — Explorer, the registry editor, speech and the like.
const SKIP_PATH = /^[a-z]:\\windows\\/i;

/**
 * Installed things that are not programs anyone would route.
 *
 * Windows' uninstall list registers runtimes, redistributables and shared frameworks exactly
 * the way it registers applications, and they all name an executable. Offering «Microsoft
 * Visual C++ 2012 Redistributable» beside Chrome is noise in a list meant to be scanned by eye.
 */
const SKIP_INSTALLED = /redistributable|\bruntimes?\b|shared framework|\bsdk\b|\bdriver\b|update for|hotfix|language pack|webview2/i;

function walk(dir, depth, out) {
    if (depth > 4) return out;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
    for (const d of entries) {
        const p = path.join(dir, d.name);
        if (d.isDirectory()) walk(p, depth + 1, out);
        else if (/\.lnk$/i.test(d.name)) out.push(p);
    }
    return out;
}

function run(exe, args, timeout = 20000) {
    return new Promise((resolve) => {
        execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    });
}
const ps = (cmd, timeout) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd], timeout);

/** { lnkPath: targetExe } for every shortcut. */
async function resolveShortcuts(links) {
    const e = el();
    if (e) {
        const out = {};
        for (const l of links) { try { out[l] = e.shell.readShortcutLink(l).target || ''; } catch (err) { out[l] = ''; } }
        return out;
    }
    if (!links.length) return {};
    // One PowerShell for all of them: the COM object resolves a .lnk the way Explorer does.
    const list = path.join(os.tmpdir(), `mlmvpn-lnk-${process.pid}.txt`);
    fs.writeFileSync(list, links.join('\n'), 'utf8');
    const outText = await ps(`$s=New-Object -ComObject WScript.Shell; Get-Content -LiteralPath '${list.replace(/'/g, "''")}' -Encoding UTF8 | ForEach-Object { try { $_ + '|' + $s.CreateShortcut($_).TargetPath } catch { $_ + '|' } }`, 60000);
    try { fs.unlinkSync(list); } catch (err) { /* temp */ }
    const out = {};
    for (const line of outText.split(/\r?\n/)) {
        const i = line.lastIndexOf('|');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
    }
    return out;
}

/** [{ Name, Path, Description }] of processes with an exe path this process may read. */
async function runningProcesses() {
    const text = await ps('Get-Process | Where-Object { $_.Path } | Select-Object Name, Path, Description | ConvertTo-Json -Compress', 30000);
    try { const j = JSON.parse(text || '[]'); return Array.isArray(j) ? j : [j]; } catch (e) { return []; }
}

/**
 * Microsoft Store apps, from their own manifests.
 *
 * A Store app's Start Menu entry addresses an application ID rather than a file, so the shortcut
 * walk above never yields one — which left every Store app invisible unless it happened to be
 * running when the list was built. The package manifest names the executable outright, so this
 * needs neither the program to be running nor a readable install directory listing.
 *
 * `DisplayName` is frequently an `ms-resource:` indirection that only Windows can resolve; the
 * package's own short name is used when that is what comes back, rather than showing the user a
 * resource key.
 */
async function storeApps() {
    const text = await ps([
        '$ErrorActionPreference="SilentlyContinue";',
                // SignatureKind 'Store' is the difference between an app someone installed and the
        // dozens Windows ships with. Without it this gained BingWeather, GetHelp, Getstarted,
        // Game Bar, four CrossDevice entries and the Store's own server — none of them things
        // anyone would route.
        // NOT Microsoft's own. SignatureKind was tried first and does not separate anything —
        // Windows delivers its inbox apps through the Store too, so every one of them came
        // back signed "Store": BingWeather, People, Photos, Paint, four CrossDevice entries,
        // Xbox, Zune, three copies of windowscommunicationsapps. The publisher does separate
        // them, and it matches the actual gap: what was missing from this list were THIRD-PARTY
        // Store apps (Telegram, ChatGPT). Windows' own accessories never were.
        'Get-AppxPackage | Where-Object { -not $_.IsFramework -and $_.InstallLocation -and $_.Publisher -notlike "*Microsoft Corporation*" } | ForEach-Object {',
        '  $p=$_; $m=Join-Path $p.InstallLocation "AppxManifest.xml";',
        '  if (Test-Path $m) { try { [xml]$x=Get-Content -LiteralPath $m -Raw;',
        '    foreach ($a in @($x.Package.Applications.Application)) {',
        '      if ($a.Executable) {',
        '        $dn=$a.VisualElements.DisplayName; if (-not $dn -or $dn -like "ms-resource:*") { $dn=$p.Name -replace "^.*\\.","" }',
        '        [pscustomobject]@{ Name=$dn; Exe=$a.Executable; Path=(Join-Path $p.InstallLocation $a.Executable) } } } } catch {} } }',
        '| ConvertTo-Json -Compress',
    ].join(' '), 45000);
    try { const j = JSON.parse(text || '[]'); return Array.isArray(j) ? j : [j]; } catch (e) { return []; }
}

/**
 * Programs registered in Windows' uninstall list, via the exe named in DisplayIcon.
 *
 * A classic installer that writes no Start Menu shortcut is otherwise invisible too. DisplayIcon is
 * usually the program's own executable (sometimes with an icon index after a comma, which is cut).
 */
async function registeredApps() {
    const text = await ps([
        '$ErrorActionPreference="SilentlyContinue";',
        '$k=@("HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
        '"HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",',
        '"HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*");',
        'Get-ItemProperty $k | Where-Object { $_.DisplayName -and $_.DisplayIcon } | ForEach-Object {',
        '  $i=($_.DisplayIcon -split ",")[0].Trim(Chr(34));',
        '  if ($i -like "*.exe") { [pscustomobject]@{ Name=$_.DisplayName; Path=$i } } }',
        '| ConvertTo-Json -Compress',
    ].join(' ').replace('Chr(34)', "'\"'"), 45000);
    try { const j = JSON.parse(text || '[]'); return Array.isArray(j) ? j : [j]; } catch (e) { return []; }
}

const iconCache = new Map();
async function iconFor(exePath) {
    if (iconCache.has(exePath)) return iconCache.get(exePath);
    const e = el();
    let url = null;
    if (e) {
        try { const img = await e.app.getFileIcon(exePath, { size: 'large' }); url = img && !img.isEmpty() ? img.toDataURL() : null; } catch (err) { url = null; }
    }
    iconCache.set(exePath, url);
    return url;
}

async function withIcons(items) {
    const queue = items.slice();
    const workers = Array.from({ length: 8 }, async () => {
        for (let it = queue.shift(); it; it = queue.shift()) it.icon = await iconFor(it.path);
    });
    await Promise.all(workers);
    return items;
}

let cache = null;
let cacheAt = 0;

/** Every app worth offering, sorted by name. Cached for a minute; `fresh` re-reads. */
async function list({ fresh = false } = {}) {
    if (!fresh && cache && Date.now() - cacheAt < 60000) return cache;
    const reserved = require('./app-routing').RESERVED;
    const byExe = new Map();

    const links = startDirs().flatMap((d) => walk(d, 0, []));
    const targets = await resolveShortcuts(links);
    for (const lnk of links) {
        const name = path.basename(lnk, '.lnk');
        const target = targets[lnk];
        if (!target || !/\.exe$/i.test(target) || SKIP_NAME.test(name) || SKIP_PATH.test(target)) continue;
        const exe = path.basename(target).toLowerCase();
        if (SKIP_EXE.test(exe) || reserved.has(exe)) continue;
        // Several shortcuts can start one exe ("VLC media player", "VLC … reset preferences");
        // the shortest name is the app's own.
        const known = byExe.get(exe);
        if (known) { if (name.length < known.name.length) known.name = name; continue; }
        if (!fs.existsSync(target)) continue;
        byExe.set(exe, { exe, name, path: target, running: false });
    }

    // The two sources that do NOT need the program to be running. Added before the running pass so
    // that pass only has to set the flag on what is already known.
    const [store, registered] = await Promise.all([storeApps(), registeredApps()]);
    for (const a of store.concat(registered)) {
        const full = String(a.Path || '');
        if (!/\.exe$/i.test(full)) continue;
        const exe = path.basename(full).toLowerCase();
        if (reserved.has(exe) || SKIP_EXE.test(exe) || SKIP_PATH.test(full)) continue;
        const name = String(a.Name || '').trim() || path.basename(full, path.extname(full));
        if (SKIP_NAME.test(name) || SKIP_INSTALLED.test(name)) continue;
        const known = byExe.get(exe);
        if (known) { if (name.length < known.name.length) known.name = name; continue; }
        byExe.set(exe, { exe, name, path: full, running: false });
    }

    for (const p of await runningProcesses()) {
        const exe = path.basename(String(p.Path)).toLowerCase();
        if (!/\.exe$/.test(exe) || reserved.has(exe)) continue;
        const known = byExe.get(exe);
        if (known) { known.running = true; continue; }
        if (SKIP_PATH.test(p.Path) || SKIP_EXE.test(exe)) continue;
        byExe.set(exe, { exe, name: String(p.Description || p.Name || exe).trim() || exe, path: p.Path, running: true });
    }

    const items = [...byExe.values()].sort((a, b) => a.name.localeCompare(b.name, 'fa'));
    await withIcons(items);
    cache = items;
    cacheAt = Date.now();
    return items;
}

/** Pick an exe by hand, with Windows' own file dialog. Null when cancelled or unavailable. */
async function browse() {
    const e = el();
    if (!e || !e.dialog) return null;
    const r = await e.dialog.showOpenDialog({
        title: 'انتخاب برنامه',
        properties: ['openFile'],
        filters: [{ name: 'برنامه', extensions: ['exe'] }],
    });
    const file = !r.canceled && r.filePaths && r.filePaths[0];
    if (!file) return null;
    const desc = (await ps(`(Get-Item -LiteralPath '${file.replace(/'/g, "''")}').VersionInfo.FileDescription`, 10000)).trim();
    const exe = path.basename(file).toLowerCase();
    return { exe, name: desc || path.basename(file, path.extname(file)), path: file, running: false, icon: await iconFor(file) };
}

module.exports = { list, browse, iconFor };
