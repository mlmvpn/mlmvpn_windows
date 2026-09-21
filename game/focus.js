// --- Giving the machine to the game ---
//
// THE REQUEST, VERBATIM: «معطوف سازی باید کامل باشه یعنی ۱۰۰درصد منابع فیزیکی و اینترنتی
// برای بازی» — and it came with a screenshot of Task Manager in which THIS APP was using
// 9.5% CPU and 307MB while claiming to hand the machine over. That is the first thing this
// file fixes, because a booster that does not get out of the way itself is a joke.
//
// WHAT IS REAL HERE AND WHAT IS NOT
// Every "game booster" on the internet advertises the same four things. Three of them are
// real and one is a lie, and this file ships exactly the three:
//
//   REAL — CPU scheduling. Windows schedules by priority class. Raising the game and
//          lowering everything else genuinely changes who gets the core when they collide.
//   REAL — the power plan. On a laptop or a machine on Balanced, the CPU parks cores and
//          drops frequency between frames; High Performance stops it doing that.
//   REAL — Windows Game Mode. Microsoft's own scheduler hint, and it costs nothing.
//   REAL, BUT ONLY IN ONE PLACE — trimming a working set. Doing this to a RUNNING process is
//          the internet's favourite placebo and is worse than useless: the pages it discards
//          are faulted straight back in, and the next frame pays for it. Doing it to a
//          process that has just been SUSPENDED is a different thing entirely — that process
//          will not run again until the user stops accelerating, so nothing faults anything
//          back, and the physical RAM is genuinely returned. That is the only case where
//          this file trims, and it is why the earlier "never" in this comment was wrong.
//          The user found it: «آره متوقف شدن ولی فقط cpu، هنوز رم رو اشغال کردن».
//
// SUSPENDING, AND WHY THE FIRST VERSION WAS WRONG NOT TO
// This file originally refused to freeze anything, on the grounds that Idle priority gets
// substantially the same result without the ways a suspended process ruins an afternoon.
// The user disproved it in one move: they played music in Telegram, switched acceleration
// on, and the music kept playing with its network intact. Of course it did — audio playback
// needs almost no CPU, so "run only when nothing else wants the core" is a limit it never
// reaches. Their requirement, and it is the right one:
//
//   «باید کل منابع سیستم و کل اینترنت معطوف بشه به لانچر بازی و خود بازی. تمام.»
//
// So `mode: 'full'` genuinely suspends. The dangers are real and each one is handled here
// rather than argued away:
//
//   * A frozen process cannot be resumed by a crashed app. Every pid is written to disk
//     BEFORE it is suspended, and `recover()` runs at server start to thaw anything a crash
//     left behind. That file is the whole safety net and nothing may be suspended before it
//     is on disk.
//   * The launcher must keep running. Steam, Epic, Battle.net and friends hold the session
//     the game authenticates against; freezing them is how you get "logged out" mid-match.
//     LAUNCHERS is whitelisted alongside the game itself.
//   * The window the user is actually looking at is never frozen, and neither is this app —
//     it is the only thing that can undo any of this.
//
// EVERY CHANGE IS RECORDED BEFORE IT IS MADE, exactly as tweaks.js and shaper.js do, and
// restore() puts each one back individually.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const BACKUP_FILE = path.join(os.homedir(), '.mlmvpn', 'game-focus-backup.json');

// Never touched, at any aggression level. Lowering these does not free anything for the
// game; it breaks the machine in ways that look exactly like the lag the user came here to
// fix — audio stutter, input latency, a desktop that stops redrawing.
const NEVER = new Set([
    'system', 'idle', 'registry', 'memory compression', 'smss', 'csrss', 'wininit', 'winlogon',
    'services', 'lsass', 'svchost', 'dwm', 'explorer', 'audiodg', 'fontdrvhost', 'sihost',
    'ctfmon', 'taskmgr', 'conhost', 'runtimebroker', 'searchhost', 'startmenuexperiencehost',
    'shellexperiencehost', 'textinputhost', 'wudfhost', 'spoolsv', 'nvcontainer', 'nvdisplay.container',
    'amddvr', 'atieclxx', 'igfxem', 'rtkngui64', 'realtekaudiouwp',
]);

// The engines that carry the game's own traffic. Starving these starves the game.
//
// READ FROM ONE PLACE, not written out here. This list used to be a hand-typed copy and it went
// stale the moment سایفون, تور, لنترن and گف shipped: four processes that carry the user's whole
// internet, none of them named, all of them therefore eligible to be SUSPENDED by the code below.
// With a full system tunnel over any of them, freezing the engine takes the machine offline.
const ENGINES = new Set(require('../engine-processes').ENGINE_NAMES);

// This app. Lowered rather than protected — see the header. Node is the server process and
// electron is the window; both should yield to a game. Lowered, never SUSPENDED: this is the
// only process that can undo everything below.
const OURS = new Set(['electron', 'node', 'mlmvpn', 'mlm vpn']);

// Game launchers. The game authenticates through these and keeps a session open with them —
// freezing Steam mid-match is how a player gets logged out of the thing they are playing.
// The user named this requirement directly: «کل منابع … معطوف بشه به لانچر بازی و خود بازی».
const LAUNCHERS = new Set([
    'steam', 'steamwebhelper', 'steamservice',
    'epicgameslauncher', 'epicwebhelper',
    'battle.net', 'agent', 'blizzardbrowser',
    'riotclientservices', 'riotclientux', 'riotclientuxrender', 'vanguard', 'vgtray',
    'launcher', 'rockstarservice', 'rockstarerrorhandler', 'socialclubhelper',
    'ubisoftconnect', 'upc', 'uplaybrowser',
    'galaxyclient', 'galaxycommunication',
    'eadesktop', 'eabackgroundservice', 'origin', 'originwebhelperservice',
    'easyanticheat', 'beservice', 'battleye',
]);

// Never frozen even in full mode — and this list is deliberately about CATEGORIES, not
// products. An earlier version named specific applications, which was wrong twice over: it
// privileged whatever software happened to be on the developer's machine, and the user's
// requirement is explicit — «نباید اسم نرم افزار خاصی هارد کد بشه … همه نرم افزارها غیر از
// حیاتی های ویندوز».
//
// What remains is the user's means of rescue: the task manager and a shell. If this file is
// ever wrong, those are what they will reach for, and freezing them would remove the only
// way out. Everything else in the session is fair game, including this developer's own
// tooling — callers that need a temporary exemption pass `neverSuspendExtra`.
const NEVER_SUSPEND = new Set([
    'taskmgr', 'procexp', 'procexp64', 'procmon', 'perfmon', 'resmon',
    'cmd', 'powershell', 'pwsh', 'windowsterminal', 'conhost',
]);

// Trimming a working set writes its pages to the pagefile, and resuming faults them back.
// Doing that to every process at once is a disk storm — measured on the user's machine as a
// mouse that "به زور تکون میخورد" during the thaw. So the trim is bounded: only processes
// large enough to be worth reclaiming, and only the biggest few of those.
const TRIM_MIN_BYTES = 60 * 1024 * 1024;
const TRIM_MAX_PROCS = 25;
/**
 * A BUDGET IN BYTES, which is the cap that was missing.
 *
 * Emptying a working set writes it to the pagefile. `TRIM_MAX_PROCS` bounds how many processes
 * are trimmed and says nothing at all about how much data that is — so the same rule costs more
 * on a better machine, because a machine with more RAM has bigger processes. Measured here on an
 * idle desktop: 11 processes, ~2 GB. Twenty-five browser and editor processes is several times
 * that, written in one uninterrupted loop, and if the pagefile has to grow Windows grows it
 * synchronously. That is a whole-machine stall, and it is exactly the shape of the reports that
 * say powerful systems hang too.
 *
 * One gigabyte is enough to matter to a game and small enough that the write finishes in seconds.
 */
const TRIM_MAX_BYTES = 1024 * 1024 * 1024;
/** A breath between processes, so the loop cannot monopolise the disk queue. */
const TRIM_PAUSE_MS = 120;

/**
 * The processes worth trimming, largest first, until the budget runs out.
 *
 * Shared by the dry run and the real one so the plan cannot promise something different from
 * what happens — the two used to compute this separately with the same expression copied twice.
 */
function trimPlan(freezable) {
    const out = [];
    let budgetMb = TRIM_MAX_BYTES / (1024 * 1024);
    const big = freezable
        .filter(f => (Number(f.ws) || 0) * 1024 * 1024 >= TRIM_MIN_BYTES)
        .sort((a, b) => b.ws - a.ws)
        .slice(0, TRIM_MAX_PROCS);
    for (const f of big) {
        const mb = Number(f.ws) || 0;
        // `continue`, not `break`: one process too large to fit must not end the pass. Skipping it
        // and taking the smaller ones behind it fills the budget instead of abandoning it —
        // measured here, `break` spent 642 MB of 1024 and stopped, because the second candidate
        // was 410 MB and would have gone 28 MB over.
        if (mb > budgetMb) continue;
        budgetMb -= mb;
        out.push(f);
    }
    return out;
}

const HIGH_PERF_GUID = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';

function ps(script, timeoutMs = 30000) {
    return new Promise(resolve => {
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
                const out = (stdout || '').trim();
                if (!out) return resolve({ ok: !err, items: [], error: err ? (stderr || err.message) : null });
                try {
                    const parsed = JSON.parse(out);
                    resolve({ ok: true, items: Array.isArray(parsed) ? parsed : [parsed] });
                } catch {
                    resolve({ ok: !err, items: [], raw: out, error: err ? (stderr || err.message) : null });
                }
            });
    });
}

function loadBackup() {
    try { return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')); } catch { return null; }
}
function saveBackup(b) {
    fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true });
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(b, null, 2), 'utf8');
}
function clearBackup() { try { fs.unlinkSync(BACKUP_FILE); } catch {} }

/**
 * Hand the machine to the game.
 *
 * `gameProcs` are executable names (with or without .exe). Everything that is not the game,
 * not on the never-touch list and not an engine gets dropped a class; this app gets dropped
 * two, because it is the one process here that has no business competing with the game it
 * is supposed to be accelerating.
 */
async function apply({ gameProcs = [], aggressive = false, full = false, neverSuspendExtra = [], plan = false } = {}) {
    if (!plan && loadBackup()) throw new Error('معطوف‌سازی از قبل فعال است. اول برش گردان.');
    // Armed before anything is frozen, never after.
    if (!plan) installExitHooks();

    const game = new Set(gameProcs.map(p => String(p).replace(/\.exe$/i, '').toLowerCase()).filter(Boolean));
    // Launchers are treated exactly like the game: raised, never lowered, never frozen.
    const never = [...NEVER, ...ENGINES].map(s => `'${s}'`).join(',');
    const ours = [...OURS].map(s => `'${s}'`).join(',');
    const gameList = [...game, ...LAUNCHERS].map(s => `'${s}'`).join(',');
    const noFreeze = [...NEVER_SUSPEND, ...neverSuspendExtra.map(s => String(s).replace(/\.exe$/i, '').toLowerCase())]
        .map(s => `'${s}'`).join(',');
    // Idle for the aggressive case, BelowNormal otherwise. Idle means "run only when nothing
    // else wants the core" — which, as the Telegram-music test proved, a media player never
    // reaches. That is what `full` is for.
    const bgClass = (aggressive || full) ? 'Idle' : 'BelowNormal';

    const script = `
$ErrorActionPreference='SilentlyContinue'
$never = @(${never})
$ours  = @(${ours})
$game  = @(${gameList})
$noFreeze = @(${noFreeze})
$changed = @()
$freezable = @()

# The window the user is looking at right now. Never frozen — if this file is ever wrong,
# that is the window they will use to fix it.
$fg = [IntPtr]::Zero
try {
  Add-Type -Name Fg -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();' -ErrorAction SilentlyContinue
  $fg = [W.Fg]::GetForegroundWindow()
} catch { }

# Only this logon session. Session 0 holds the services, and freezing one of those is how a
# machine stops responding to anything at all.
$mySession = (Get-Process -Id $PID).SessionId

# The process ids of everything that looks like an application the user opened, plus every
# descendant of those. A browser keeps its tabs in child processes with no window of their
# own; freezing the parent and leaving fifteen renderers running would free nothing.
# Anything holding a handle on a mouse, keyboard or HID device. Derived from the running
# services and their host processes for the input device classes, so a vendor utility for
# hardware nobody here has heard of is still covered. Belt and braces: the C:\Windows rule
# already excludes the Windows input stack, and this covers the third-party half.
$inputPids = @()
try {
  $inputSvc = Get-CimInstance Win32_Service -Filter "State='Running'" |
    Where-Object { $_.PathName -match 'mouse|keyboard|hid|input|touchpad|synaptics|elan|logi|razer|corsair|steelseries' }
  $inputPids = @($inputSvc | ForEach-Object { $_.ProcessId } | Where-Object { $_ -gt 0 })
} catch { }

$appParents = @()
try {
  $all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,ExecutablePath
  $roots = @(Get-Process | Where-Object {
    $_.SessionId -eq $mySession -and $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne '' -and
    $_.Path -and ($_.Path -notlike "$env:SystemRoot\\*")
  } | ForEach-Object { $_.Id })
  $appParents = $roots
  # Two passes is enough for the shapes that occur in practice (browser -> renderer -> util).
  for ($i = 0; $i -lt 3; $i++) {
    $kids = @($all | Where-Object { $appParents -contains $_.ParentProcessId -and $_.ExecutablePath -and ($_.ExecutablePath -notlike "$env:SystemRoot\\*") } | ForEach-Object { $_.ProcessId })
    $before = $appParents.Count
    $appParents = @($appParents + $kids | Sort-Object -Unique)
    if ($appParents.Count -eq $before) { break }
  }
} catch { }

foreach ($p in Get-Process) {
  $n = $p.ProcessName.ToLower()
  if ($never -contains $n) { continue }
  $before = $null
  try { $before = $p.PriorityClass.ToString() } catch { continue }
  if (-not $before) { continue }

  $want = $null
  $freeze = $false
  if ($game -contains $n) { $want = 'High' }
  elseif ($ours -contains $n) { $want = 'BelowNormal' }
  # AN ALLOW-LIST, BECAUSE THE BLOCK-LIST BROKE A MACHINE.
  #
  # The previous rule froze everything in the interactive session except a hand-written list
  # of critical names. It cost the user their desktop: the mouse stopped, the Windows key
  # stopped, this app stopped, and the only way out was the power button. The list was not
  # missing one entry — the APPROACH was wrong. No hand-written list can enumerate every
  # process that matters across thousands of machines: vendor input drivers, OEM utilities,
  # accessibility tools, UWP window hosts, COM surrogates. Whatever is forgotten is the thing
  # that breaks, and the user cannot even open Task Manager to undo it.
  #
  # So the question is inverted. Not "is this critical?" — which cannot be answered — but
  # "is this obviously an application the user opened?", which can:
  #
  #   * it lives OUTSIDE C:\Windows. Everything under there is a Windows component, whatever
  #     it is called: System32, SystemApps, ImmersiveControlPanel, WinSxS. Never touched.
  #   * it has a VISIBLE WINDOW WITH A TITLE. A tray utility — which is what a mouse driver
  #     or an OEM helper looks like — has no window title and is left alone. A browser, a
  #     messenger, a media player does, and those are the ones actually holding the RAM,
  #     the CPU and the bandwidth the user wants back.
  #   * or its parent is one of those, which is how a browser's own render processes get
  #     included without naming the browser.
  #
  # Everything else keeps running. That is a smaller promise than "100% of the machine", and
  # it is the largest one that can be kept without gambling with someone's desktop.
  elseif ($p.SessionId -eq $mySession) {
    $want = '${bgClass}'
    $isApp = $false
    try {
      $exe = $p.Path
      $outsideWindows = $exe -and ($exe -notlike "$env:SystemRoot\\*")
      $hasWindow = ($p.MainWindowHandle -ne 0) -and ($p.MainWindowTitle -ne '')
      # A process that owns an input device's user-mode half is never an application, no
      # matter where it lives or what window it shows. This is checked against the PnP
      # device tree rather than a list of vendor names, so it holds for hardware nobody here
      # has ever seen: «امکانات ویندوز مثل موس و کیبورد … اصلا خراب نشن».
      $isInput = $inputPids -contains $p.Id
      if ($outsideWindows -and (-not $isInput) -and ($hasWindow -or ($appParents -contains $p.Id))) { $isApp = $true }
    } catch { }
    if (${full ? '$true' : '$false'} -and $isApp -and ($noFreeze -notcontains $n) -and ($p.MainWindowHandle -ne $fg)) { $freeze = $true }
  }

  if ($want -and $want -ne $before) {
    if (${plan ? '$false' : '$true'}) {
      try {
        $p.PriorityClass = $want
        $changed += [PSCustomObject]@{ pid = $p.Id; name = $p.ProcessName; before = $before; after = $want }
      } catch { }
    } else {
      $changed += [PSCustomObject]@{ pid = $p.Id; name = $p.ProcessName; before = $before; after = $want }
    }
  }
  if ($freeze) { $freezable += [PSCustomObject]@{ pid = $p.Id; name = $p.ProcessName; ws = [int]($p.WorkingSet64 / 1MB) } }
}

# The power plan. Recorded as a GUID so restore is exact even if the user has custom plans.
$planBefore = $null
try {
  $active = (powercfg /getactivescheme)
  if ($active -match '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})') { $planBefore = $Matches[1] }
  if (${plan ? '$false' : '$true'}) { powercfg /setactive ${HIGH_PERF_GUID} | Out-Null }
} catch { }

# Windows' own Game Mode. HKCU, so no elevation needed — one of the few levers that works
# even when the app was not started as administrator.
$gameModeBefore = $null
try {
  $k = 'HKCU:\\Software\\Microsoft\\GameBar'
  if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
  $gameModeBefore = (Get-ItemProperty -Path $k -Name 'AutoGameModeEnabled').AutoGameModeEnabled
  if (${plan ? '$false' : '$true'}) { Set-ItemProperty -Path $k -Name 'AutoGameModeEnabled' -Value 1 -Type DWord }
} catch { }

[PSCustomObject]@{
  changed = $changed
  freezable = $freezable
  planBefore = $planBefore
  gameModeBefore = $gameModeBefore
} | ConvertTo-Json -Compress -Depth 4
`;

    const r = await ps(script, 60000);
    const data = (r.items && r.items[0]) || {};
    const changed = Array.isArray(data.changed) ? data.changed : (data.changed ? [data.changed] : []);

    const freezable = Array.isArray(data.freezable) ? data.freezable : (data.freezable ? [data.freezable] : []);

    const backup = {
        at: Date.now(),
        aggressive, full,
        procs: changed,
        planBefore: data.planBefore || null,
        gameModeBefore: (data.gameModeBefore === null || data.gameModeBefore === undefined) ? null : Number(data.gameModeBefore),
        // ON DISK BEFORE ANYTHING IS FROZEN. If this process dies between here and the next
        // line, recover() thaws them at the next start. Nothing may be suspended before this
        // write lands — a frozen process with no record is a process the user cannot rescue
        // except by rebooting.
        suspended: freezable,
    };
    // Dry run: report exactly what WOULD happen and change nothing. This exists so the
    // coverage of the rules above can be checked on a real machine without freezing the
    // machine — the user asked, reasonably, that it not be tested live on the session they
    // are talking to us through.
    if (plan) {
        return {
            ok: true, plan: true,
            wouldLower: changed.filter(c => c.after !== 'High').length,
            wouldRaise: changed.filter(c => c.after === 'High').length,
            wouldFreeze: freezable.map(f => ({ name: f.name, ws: Number(f.ws) || 0 })),
            wouldTrim: trimPlan(freezable).map(f => f.name),
            wouldTrimMb: trimPlan(freezable).reduce((s, f) => s + (Number(f.ws) || 0), 0),
            wouldFreezeMb: freezable.reduce((s, f) => s + (Number(f.ws) || 0), 0),
        };
    }

    saveBackup(backup);

    let froze = 0;
    let freedMb = 0;
    if (full && freezable.length) {
        // Only the big ones get trimmed, largest first — see TRIM_MIN_BYTES.
        const trimSet = new Set(trimPlan(freezable).map(f => f.pid));
        const trimIds = [...trimSet].join(',');
        const ids = freezable.map(f => f.pid).join(',');
        const r2 = await ps(`
$ErrorActionPreference='SilentlyContinue'
Add-Type -Name Nt -Namespace W -MemberDefinition @'
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(System.IntPtr h);
[DllImport("kernel32.dll")] public static extern bool SetProcessWorkingSetSizeEx(System.IntPtr h, System.IntPtr min, System.IntPtr max, uint flags);
'@
$trim = @(${trimIds || ''})
$n = 0
$freedKb = 0
foreach ($id in @(${ids})) {
  try {
    $p = Get-Process -Id $id
    if (-not $p) { continue }
    $beforeKb = [int]($p.WorkingSet64 / 1KB)
    [void][W.Nt]::NtSuspendProcess($p.Handle)
    $n++
    # Trim ONLY now that it is frozen, and only the ones worth trimming: a suspended process
    # cannot fault its pages back in, so this hands the physical memory to the game — but
    # doing it to everything at once turned into a pagefile storm that made the mouse crawl.
    # (-1,-1) is the documented "empty the working set" pair.
    if ($trim -contains $id) {
      [void][W.Nt]::SetProcessWorkingSetSizeEx($p.Handle, [System.IntPtr](-1), [System.IntPtr](-1), 0)
      $p.Refresh()
      $afterKb = [int]($p.WorkingSet64 / 1KB)
      if ($beforeKb -gt $afterKb) { $freedKb += ($beforeKb - $afterKb) }
      # A breath between processes. Back to back, this loop is a single uninterrupted write of
      # every trimmed working set to the pagefile, and the disk queue belongs to the whole
      # machine — including the game that is about to start.
      Start-Sleep -Milliseconds ${TRIM_PAUSE_MS}
    }
  } catch { }
}
[PSCustomObject]@{ frozen = $n; freedKb = $freedKb } | ConvertTo-Json -Compress
`, 90000);
        froze = (r2.items && r2.items[0] && Number(r2.items[0].frozen)) || 0;
        freedMb = Math.round(((r2.items && r2.items[0] && Number(r2.items[0].freedKb)) || 0) / 1024);
    }

    const lowered = changed.filter(c => c.after !== 'High').length;
    const raised = changed.filter(c => c.after === 'High').length;
    return {
        ok: true,
        lowered, raised, froze, freedMb,
        plan: !!data.planBefore,
        gameMode: data.gameModeBefore !== undefined,
        detail: [
            raised ? `${raised} پراسس بازی و لانچر روی اولویت بالا` : null,
            froze ? `${froze} برنامه‌ی دیگر کاملاً متوقف شد${freedMb ? ` و ${freedMb} مگابایت رم آزاد شد` : ''}` : (lowered ? `${lowered} پراسس دیگر کنار زده شد` : null),
            data.planBefore ? 'پلن برق روی حداکثر' : null,
            'Game Mode ویندوز روشن',
        ].filter(Boolean).join(' · '),
    };
}

/** Put every priority, the power plan and Game Mode back exactly as they were. */
async function restore() {
    const b = loadBackup();
    if (!b) return { ok: true, nothing: true };

    const rows = (b.procs || [])
        .map(c => `@{pid=${c.pid};cls='${c.before}'}`)
        .join(',');

    const suspended = (b.suspended || []).map(s => s.pid).join(',');

    const script = `
$ErrorActionPreference='SilentlyContinue'

# THAW FIRST, always. A process that stays frozen because a priority restore threw on the
# line above it is the worst outcome this file can produce, so resuming comes before
# everything else and is not conditional on anything succeeding.
$thawed = 0
${suspended ? `
Add-Type -Name Nt2 -Namespace W -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);'
foreach ($id in @(${suspended})) {
  try { $p = Get-Process -Id $id; if ($p) { [void][W.Nt2]::NtResumeProcess($p.Handle); $thawed++ } } catch { }
}` : ''}

$rows = @(${rows || ''})
$back = 0
foreach ($r in $rows) {
  try {
    $p = Get-Process -Id $r.pid
    # A pid can be reused by a different process between apply and restore. Only put back a
    # priority we are still looking at the same process for.
    if ($p) { $p.PriorityClass = $r.cls; $back++ }
  } catch { }
}
${b.planBefore ? `try { powercfg /setactive ${b.planBefore} | Out-Null } catch { }` : ''}
${b.gameModeBefore === null
        // The value did not exist before we wrote it. Setting it back to 0 would not be a
        // restore — it would be a NEW setting, one that disables Game Mode for a user who
        // had simply never touched it. Removing the property is the only honest undo.
        ? `try { Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\GameBar' -Name 'AutoGameModeEnabled' } catch { }`
        : `try { Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\GameBar' -Name 'AutoGameModeEnabled' -Value ${b.gameModeBefore} -Type DWord } catch { }`}
[PSCustomObject]@{ restored = $back; thawed = $thawed } | ConvertTo-Json -Compress
`;

    const r = await ps(script, 90000);
    clearBackup();
    const row = (r.items && r.items[0]) || {};
    return {
        ok: true,
        restored: Number(row.restored) || 0,
        thawed: Number(row.thawed) || 0,
        plan: !!b.planBefore,
        gameMode: true,
    };
}

function status() {
    const b = loadBackup();
    if (!b) return { on: false };
    return {
        on: true, at: b.at, aggressive: !!b.aggressive,
        count: (b.procs || []).length,
        plan: !!b.planBefore,
        gameMode: b.gameModeBefore !== null,
    };
}

/**
 * Thaw anything a crash left frozen.
 *
 * Called once when the server starts. This is the entire justification for suspending at
 * all: if the app dies while processes are frozen, the user is left with a Telegram that
 * will not respond and no idea why — and no amount of clicking in an app that is no longer
 * running will fix it. The backup file is written before the first process is suspended
 * precisely so that this function has something to read.
 */
async function recover(onLog = () => {}) {
    const b = loadBackup();
    if (!b || !(b.suspended || []).length) return { ok: true, nothing: true };
    onLog(`[GAME] بازیابی: ${b.suspended.length} برنامه از اجرای قبلی متوقف مانده بودند`);
    const r = await restore();
    onLog(`[GAME] ${r.thawed} برنامه از حالت توقف خارج شد`);
    return r;
}

/**
 * Thaw on the way out, synchronously.
 *
 * Learned the hard way, on the user's machine: a test process was killed between suspending
 * and restoring, and forty-seven of their applications stayed frozen — their mouse went
 * sluggish and the only way back was a command they could not have known to run. `recover()`
 * fixes that at the NEXT start, which is too late to be the only answer.
 *
 * This runs on the way out instead. It must be synchronous, because an exit handler gets no
 * event loop: a promise scheduled here never resolves. execFileSync is the point.
 */
function installExitHooks() {
    if (installExitHooks.done) return;
    installExitHooks.done = true;

    const thawSync = () => {
        const b = loadBackup();
        if (!b || !(b.suspended || []).length) return;
        const ids = b.suspended.map(s => s.pid).join(',');
        try {
            require('child_process').execFileSync('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `
$ErrorActionPreference='SilentlyContinue'
Add-Type -Name NtX -Namespace W -MemberDefinition '[DllImport("ntdll.dll")] public static extern int NtResumeProcess(System.IntPtr h);'
foreach ($id in @(${ids})) { try { $p = Get-Process -Id $id; if ($p) { [void][W.NtX]::NtResumeProcess($p.Handle) } } catch { } }
`], { timeout: 4000, windowsHide: true, stdio: 'ignore' });
        } catch { /* nothing better is available at exit */ }
    };

    process.on('exit', thawSync);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
        try { process.on(sig, () => { thawSync(); process.exit(0); }); } catch {}
    }
    process.on('uncaughtException', (err) => { thawSync(); throw err; });
}

module.exports = {
    apply, restore, recover, status, installExitHooks,
    NEVER, ENGINES, OURS, LAUNCHERS, NEVER_SUSPEND, BACKUP_FILE,
    TRIM_MIN_BYTES, TRIM_MAX_PROCS,
};
