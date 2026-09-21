// --- Which games are actually on this PC ---
//
// The catalogue says what a game IS. This says what the user HAS. They are different
// questions and conflating them produces the two failures that make a game list useless:
// a wall of 80 titles the user does not own, or a list that silently misses the one game
// they actually play.
//
// HOW A GAME IS FOUND
// Every launcher records its installs somewhere readable. One PowerShell pass collects
// them all — Steam library manifests, Epic's .item files, the Rockstar/Ubisoft/GOG/EA
// registry keys, Blizzard and generic uninstall entries, and UWP packages for Game Pass
// titles. That gives a set of install directories with display names.
//
// HOW A DIRECTORY BECOMES A CATALOGUE ENTRY
// By finding the executable, not by matching the name. Names are localised, punctuated
// differently by every store, and renamed between editions ("FIFA 23" → "EA SPORTS FC");
// the .exe is what Windows reports for a running process and therefore the only thing that
// can also be used for routing later. So each install directory is scanned (depth-limited)
// for executables and matched against catalogue `procs`. Name matching exists only as a
// fallback for the display list.
//
// WHAT HAPPENS TO A GAME WE DO NOT KNOW
// It is still listed, marked `known: false`, with its directory and executables recorded.
// A catalogue can never be complete — new titles ship weekly — so an unknown game must
// degrade to "we can still measure your line and your region for this", not disappear.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const catalog = require('./catalog');

const CACHE_FILE = path.join(os.homedir(), '.mlmvpn', 'game-installed.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;   // a scan is not free; six hours is plenty

/**
 * The collector.
 *
 * Deliberately ONE PowerShell process: spawning it costs ~400ms on a cold machine, and
 * doing that per launcher turned a 2-second scan into a 15-second one. Every source is
 * wrapped in its own try/catch so a missing launcher or a locked registry key cannot
 * abort the rest — a machine without Epic must still report its Steam library.
 */
const COLLECT_PS = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$out = New-Object System.Collections.ArrayList

function Add-Entry($src, $name, $dir, $id) {
  if (-not $name) { return }
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { $dir = $null }
  [void]$out.Add([pscustomobject]@{ source=$src; name=$name; dir=$dir; id=$id })
}

# ── Steam ───────────────────────────────────────────────────────────────────────
try {
  $steam = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam' -Name InstallPath).InstallPath
  if (-not $steam) { $steam = (Get-ItemProperty 'HKCU:\SOFTWARE\Valve\Steam' -Name SteamPath).SteamPath }
  if ($steam) {
    $libs = @($steam)
    $vdf = Join-Path $steam 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $vdf) {
      foreach ($m in [regex]::Matches((Get-Content -LiteralPath $vdf -Raw), '"path"\s+"([^"]+)"')) {
        $libs += $m.Groups[1].Value -replace '\\\\','\'
      }
    }
    foreach ($lib in ($libs | Select-Object -Unique)) {
      $apps = Join-Path $lib 'steamapps'
      if (-not (Test-Path -LiteralPath $apps)) { continue }
      foreach ($acf in Get-ChildItem -LiteralPath $apps -Filter 'appmanifest_*.acf' -File) {
        $t = Get-Content -LiteralPath $acf.FullName -Raw
        $nm = [regex]::Match($t, '"name"\s+"([^"]+)"').Groups[1].Value
        $idr = [regex]::Match($t, '"installdir"\s+"([^"]+)"').Groups[1].Value
        $appid = [regex]::Match($t, '"appid"\s+"([^"]+)"').Groups[1].Value
        if ($nm -and $idr) { Add-Entry 'steam' $nm (Join-Path $apps ('common\' + $idr)) $appid }
      }
    }
  }
} catch {}

# ── Epic Games ──────────────────────────────────────────────────────────────────
try {
  $man = 'C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests'
  if (Test-Path -LiteralPath $man) {
    foreach ($f in Get-ChildItem -LiteralPath $man -Filter '*.item' -File) {
      $j = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json
      if ($j.DisplayName) { Add-Entry 'epic' $j.DisplayName $j.InstallLocation $j.AppName }
    }
  }
} catch {}

# ── Rockstar Games Launcher ─────────────────────────────────────────────────────
try {
  foreach ($k in Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\Rockstar Games') {
    $p = (Get-ItemProperty $k.PSPath).InstallFolder
    if (-not $p) { $p = (Get-ItemProperty $k.PSPath).'Install Folder' }
    if ($p) { Add-Entry 'rockstar' $k.PSChildName $p $null }
  }
} catch {}

# ── Ubisoft Connect ─────────────────────────────────────────────────────────────
try {
  foreach ($k in Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs') {
    $p = (Get-ItemProperty $k.PSPath).InstallDir
    if ($p) { Add-Entry 'ubisoft' (Split-Path $p -Leaf) $p $k.PSChildName }
  }
} catch {}

# ── GOG ─────────────────────────────────────────────────────────────────────────
try {
  foreach ($k in Get-ChildItem 'HKLM:\SOFTWARE\WOW6432Node\GOG.com\Games') {
    $pr = Get-ItemProperty $k.PSPath
    if ($pr.path) { Add-Entry 'gog' $pr.gameName $pr.path $k.PSChildName }
  }
} catch {}

# ── Riot Games ──────────────────────────────────────────────────────────────────
try {
  $pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
  foreach ($base in @('C:\Riot Games', (Join-Path $env:ProgramFiles 'Riot Games'), (Join-Path $pf86 'Riot Games'))) {
    if (Test-Path -LiteralPath $base) {
      foreach ($d in Get-ChildItem -LiteralPath $base -Directory) { Add-Entry 'riot' $d.Name $d.FullName $null }
    }
  }
} catch {}

# ── UWP / Xbox Game Pass ────────────────────────────────────────────────────────
try {
  foreach ($p in Get-AppxPackage) {
    if ($p.InstallLocation -and $p.Name -match 'Minecraft|Forza|Halo|SeaofThieves|Gears|FlightSimulator|AgeOf') {
      Add-Entry 'xbox' $p.Name $p.InstallLocation $p.PackageFullName
    }
  }
} catch {}

# ── generic uninstall entries ───────────────────────────────────────────────────
try {
  $roots = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*'
  )
  foreach ($r in $roots) {
    foreach ($k in Get-ItemProperty $r) {
      if ($k.DisplayName -and $k.InstallLocation) {
        Add-Entry 'uninstall' $k.DisplayName $k.InstallLocation $null
      }
    }
  }
} catch {}

$out | ConvertTo-Json -Depth 3 -Compress
`;

function runCollector(timeoutMs = 90000) {
    return new Promise(resolve => {
        const tmp = path.join(os.tmpdir(), `mlmvpn-gamescan-${process.pid}.ps1`);
        try { fs.writeFileSync(tmp, '\ufeff' + COLLECT_PS, 'utf8'); } catch { return resolve([]); }
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmp],
            { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
            (err, stdout) => {
                try { fs.unlinkSync(tmp); } catch {}
                if (!stdout) return resolve([]);
                try {
                    const parsed = JSON.parse(stdout.trim());
                    resolve(Array.isArray(parsed) ? parsed : [parsed]);
                } catch { resolve([]); }
            });
    });
}

// Directories that are never the game itself. Walking them is the difference between a
// two-second scan and a two-minute one — Unreal's Engine tree alone holds thousands of
// files, and every redistributable folder is a dead end by definition.
const SKIP_DIRS = new Set([
    '_commonredist', 'commonredist', 'redist', 'redistributables', '__installer',
    'directx', 'vcredist', 'dotnet', 'sdk', 'engine', 'content', 'paks', 'movies',
    'sounds', 'audio', 'textures', 'localization', 'docs', 'manual', 'support',
    'crashreportclient', 'thirdparty', 'node_modules', 'cache',
]);

/** Depth- and budget-limited executable hunt. Returns lowercase basenames. */
function findExes(root, { maxDepth = 3, budget = 2500 } = {}) {
    const found = new Set();
    let visited = 0;
    const walk = (dir, depth) => {
        if (depth > maxDepth || visited > budget) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (visited++ > budget) return;
            if (e.isDirectory()) {
                if (SKIP_DIRS.has(e.name.toLowerCase())) continue;
                walk(path.join(dir, e.name), depth + 1);
            } else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) {
                found.add(e.name);
            }
        }
    };
    walk(root, 0);
    return [...found];
}

// Launcher/updater/redistributable executables that live beside real games and would
// otherwise match nothing useful or, worse, match a generic catalogue entry.
const NOISE_EXE = /^(unins|setup|install|vcredist|dxsetup|dxwebsetup|ue4prereq|ue5prereq|epicwebhelper|crashreport|steam_|touchup|launcher_|activation|dotnetfx|oalinst|directx)/i;

// Launchers and support apps sit in the same registry hives as the games they launch and
// look identical to this scanner — a "Rockstar Games Launcher" entry is a directory with
// an .exe in it, exactly like a game. Listing them as playable titles is the fastest way
// to make the whole list look untrustworthy, so they are dropped by name.
const NOISE_NAME = /(launcher|social club|redistributable|redist|runtime|prerequisit|anti[- ]?cheat|easyanticheat|battleye|overlay|companion|bootstrap|updater|helper|crash|driver|directx|visual c\+\+|\.net )/i;

function normaliseName(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/[™®©]/g, '')
        .replace(/\b(deluxe|ultimate|standard|gold|goty|edition|remastered|definitive)\b/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Loose name match, used only when no executable matched. */
function nameMatch(displayName) {
    const n = normaliseName(displayName);
    if (!n) return null;
    let best = null, bestLen = 0;
    for (const g of catalog.GAMES) {
        for (const cand of [g.en, g.fa]) {
            const c = normaliseName(cand);
            if (!c || c.length < 4) continue;
            if (n === c || n.startsWith(c + ' ') || n.includes(' ' + c + ' ') || n.endsWith(' ' + c)) {
                if (c.length > bestLen) { best = g; bestLen = c.length; }
            }
        }
    }
    return best;
}

/**
 * Scan the machine.
 *
 * Returns one row per install directory, deduped by resolved catalogue id (a game owned
 * on two stores is one game), plus every unknown install kept as its own row.
 */
async function scan({ force = false, onProgress = null } = {}) {
    if (!force) {
        try {
            const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
            if (c && c.at && Date.now() - c.at < CACHE_TTL_MS && Array.isArray(c.items)) {
                return { ...c, cached: true };
            }
        } catch {}
    }

    const raw = await runCollector();
    if (onProgress) { try { onProgress({ phase: 'collected', count: raw.length }); } catch {} }

    // Uninstall entries are noisy — thousands of non-games. Only keep those whose
    // directory actually contains an executable we recognise, which the exe pass decides.
    const byId = new Map();
    const unknown = [];
    let scanned = 0;

    for (const row of raw) {
        if (!row || !row.dir) continue;
        if (NOISE_NAME.test(row.name)) continue;
        scanned++;
        if (onProgress && scanned % 15 === 0) {
            try { onProgress({ phase: 'scanning', done: scanned, total: raw.length, name: row.name }); } catch {}
        }

        const exes = findExes(row.dir).filter(e => !NOISE_EXE.test(e));
        let game = null, matchedExe = null;
        for (const e of exes) {
            const hit = catalog.byProcess(e);
            if (hit) { game = hit; matchedExe = e; break; }
        }

        if (game) {
            const prev = byId.get(game.id);
            // Prefer the row that found the executable over one that only matched a name.
            if (!prev || (!prev.exe && matchedExe)) {
                byId.set(game.id, {
                    id: game.id, fa: game.fa, en: game.en, cat: game.cat, klass: game.klass,
                    probe: game.probe, regions: game.regions, anticheat: game.anticheat,
                    kernelAnticheat: catalog.usesKernelAnticheat(game),
                    note: game.note || null, tips: game.tips || [],
                    known: true, source: row.source, store: row.source,
                    displayName: row.name, dir: row.dir, exe: matchedExe,
                    exePath: matchedExe ? path.join(row.dir, matchedExe) : null,
                    procs: game.procs,
                });
            }
            continue;
        }

        // No executable matched. Only entries from a real game launcher are worth keeping
        // as "unknown game" — the uninstall registry is mostly drivers and toolbars.
        if (row.source === 'uninstall') continue;
        const guess = nameMatch(row.name);
        if (guess && !byId.has(guess.id)) {
            byId.set(guess.id, {
                id: guess.id, fa: guess.fa, en: guess.en, cat: guess.cat, klass: guess.klass,
                probe: guess.probe, regions: guess.regions, anticheat: guess.anticheat,
                kernelAnticheat: catalog.usesKernelAnticheat(guess),
                note: guess.note || null, tips: guess.tips || [],
                known: true, matchedBy: 'name', source: row.source, store: row.source,
                displayName: row.name, dir: row.dir, exe: null, exePath: null, procs: guess.procs,
            });
        } else if (!guess && exes.length) {
            unknown.push({
                id: 'unknown:' + normaliseName(row.name).replace(/\s+/g, '-'),
                fa: row.name, en: row.name, cat: 'other', klass: 'dedicated',
                probe: 'anchors', regions: ['eu-central'], anticheat: null, kernelAnticheat: false,
                known: false, source: row.source, store: row.source,
                displayName: row.name, dir: row.dir,
                exe: exes[0], exePath: path.join(row.dir, exes[0]), procs: exes.slice(0, 6),
                note: 'این بازی در کاتالوگ نیست. سنجش خط و منطقه همچنان کار می‌کند، ولی معماری شبکه‌اش را نمی‌دانیم.',
                tips: [],
            });
        }
    }

    const items = [...byId.values(), ...unknown]
        .sort((a, b) => (b.known ? 1 : 0) - (a.known ? 1 : 0) || a.fa.localeCompare(b.fa, 'fa'));

    const result = { at: Date.now(), items, sources: raw.length, cached: false };
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(result), 'utf8');
    } catch {}
    return result;
}

function cached() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return null; }
}

module.exports = { scan, cached, findExes, CACHE_FILE };
