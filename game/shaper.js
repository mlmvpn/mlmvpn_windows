// --- Traffic shaping: keeping the user's own machine out of the way ---
//
// WHY THIS IS THE HIGHEST-VALUE THING IN THE PANEL
// The single largest latency effect this project has ever measured was not the route. It
// was the user's own line: with a video streaming, p95 to two Frankfurt anchors read 457ms
// and 637ms and looked exactly like a broken international path; on an idle line the SAME
// anchors read 124ms and 125ms — while `min` moved 101→100. A player watching that would
// blame the ISP, buy a tunnel, and change nothing that mattered.
//
// `localaudit.lineLoad()` already DETECTS this and every assessment carries the caveat. But
// detection without a remedy is just a nicer way of saying "you are on your own". This is
// the remedy.
//
// WHAT WINDOWS CAN AND CANNOT DO, STATED HONESTLY
// ExitLag ships an NDIS lightweight-filter driver (ndextlag.sys) and a WFP redirect driver,
// so it sits in the packet path and can police traffic in BOTH directions — it can throttle
// a download. We ship no kernel driver, deliberately, and that has a hard consequence:
//
//   * OUTBOUND (upload) can be throttled, using Windows' own QoS policy mechanism.
//   * INBOUND (download) CANNOT be throttled locally. The bytes have already crossed the
//     bottleneck — the user's downlink — by the time this machine sees them. Nothing that
//     runs in user space can undo that.
//
// So a big Steam download is not "limited", it is BLOCKED or it is left alone, and the UI
// has to say so. Claiming a download limiter we cannot build would be the same overselling
// this project exists not to do — and the user would keep lagging while a green switch told
// them otherwise.
//
// THE RULES, SAME AS tweaks.js
//   1. Nothing is applied without an explicit click.
//   2. What we created is written to disk BEFORE it exists, so restore is exact and can
//      never remove a firewall rule or QoS policy that belonged to someone else.
//   3. Every rule is individually reversible, and restoreAll() puts the machine back.
//   4. The game, and this app's own engines, can never be shaped. A user who throttles
//      aether.exe has been handed a footgun by us, not by Windows.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const BACKUP_FILE = path.join(os.homedir(), '.mlmvpn', 'game-shaper.json');

// Everything this app uses to carry traffic. Shaping any of these would throttle the very
// tunnel the game is running through — the user cannot be allowed to do it by accident.
const PROTECTED = new Set([
    // Every engine this app can run, from the one list that knows them all. Typed out here, this
    // set went stale the moment a new engine shipped — and the error message below («محدود کردنش
    // خودِ تونل را می‌شکند») would then be right about a danger it could no longer detect.
    ...require('../engine-processes').ENGINE_EXES,
    'mlmvpn.exe', 'electron.exe', 'node.exe',
    // Windows itself: shaping these breaks name resolution and updates in ways that look
    // like a network fault long after the user has forgotten they clicked anything.
    'svchost.exe', 'system', 'lsass.exe', 'services.exe', 'dwm.exe', 'explorer.exe',
]);

// Names worth surfacing first, because they are the usual culprits behind a sudden p95
// spike. Not a blocklist — a sort order, so the list opens on what is probably to blame.
const USUAL_SUSPECTS = [
    { match: /^steam(webhelper)?\.exe$/i, fa: 'استیم (دانلود/آپدیت بازی)' },
    { match: /^epicgameslauncher\.exe$/i, fa: 'اپیک گیمز' },
    { match: /^battle\.net\.exe$/i, fa: 'بتل‌نت' },
    { match: /^onedrive\.exe$/i, fa: 'وان‌درایو (همگام‌سازی ابری)' },
    { match: /^dropbox\.exe$/i, fa: 'دراپ‌باکس' },
    { match: /^googledrivefs\.exe$/i, fa: 'گوگل درایو' },
    { match: /^(chrome|msedge|firefox|brave)\.exe$/i, fa: 'مرورگر (دانلود یا ویدیو)' },
    { match: /^(idman|idman64)\.exe$/i, fa: 'دانلود منیجر' },
    { match: /^(utorrent|qbittorrent|bittorrent|transmission).*\.exe$/i, fa: 'تورنت — بدترین همسایه‌ی ممکن برای بازی' },
    { match: /^(telegram|whatsapp|discord)\.exe$/i, fa: 'پیام‌رسان (آپلود فایل)' },
    { match: /^(vlc|potplayer)\.exe$/i, fa: 'پخش‌کننده‌ی ویدیو' },
    { match: /^wuauclt\.exe$|^usoclient\.exe$/i, fa: 'آپدیت ویندوز' },
];

function suspect(name) {
    const hit = USUAL_SUSPECTS.find(s => s.match.test(name));
    return hit ? hit.fa : null;
}

function ps(script, timeoutMs = 25000) {
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
    try { return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')); } catch { return { v: 1, rules: {} }; }
}

function saveBackup(b) {
    fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true });
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(b, null, 2), 'utf8');
}

// ── who is actually talking to the internet right now ────────────────────────────
//
// WHAT THIS DOES NOT CLAIM. Windows exposes no per-process bandwidth counter outside ETW,
// so this cannot say "Steam is using 4 Mbps". It says who holds live connections to the
// outside world, and how many — which, combined with `lineLoad()`'s total, is enough for
// the user to recognise the culprit without us inventing a number we did not measure.
//
// Loopback and LAN peers are excluded: a process talking to 127.0.0.1 or the router is not
// what is eating an international uplink.
const CANDIDATES_PS = `
$ErrorActionPreference='SilentlyContinue'
$conns = Get-NetTCPConnection -State Established
$rows = @{}
foreach ($c in $conns) {
  $ip = $c.RemoteAddress
  if (-not $ip) { continue }
  if ($ip -eq '127.0.0.1' -or $ip -eq '::1' -or $ip -like '169.254.*') { continue }
  if ($ip -like '192.168.*' -or $ip -like '10.*' -or $ip -like '172.1[6-9].*' -or $ip -like '172.2*.*' -or $ip -like '172.3[0-1].*') { continue }
  $p = Get-Process -Id $c.OwningProcess
  if (-not $p) { continue }
  $key = $p.ProcessName + '.exe'
  if (-not $rows.ContainsKey($key)) {
    $rows[$key] = [PSCustomObject]@{ name = $key; path = $p.Path; conns = 0; sample = $ip }
  }
  $rows[$key].conns = $rows[$key].conns + 1
}
$rows.Values | Sort-Object -Property conns -Descending | Select-Object -First 40 | ConvertTo-Json -Compress
`;

async function candidates() {
    const r = await ps(CANDIDATES_PS);
    const back = loadBackup();
    return (r.items || [])
        .filter(x => x && x.name)
        .map(x => ({
            name: x.name,
            path: x.path || null,
            conns: Number(x.conns) || 0,
            sample: x.sample || null,
            fa: suspect(x.name),
            protected: PROTECTED.has(String(x.name).toLowerCase()),
            shaped: !!back.rules[String(x.name).toLowerCase()],
        }))
        // Suspects first, then by how much they are talking. A list sorted purely by
        // connection count opens on svchost every single time, which helps nobody.
        .sort((a, b) => (b.fa ? 1 : 0) - (a.fa ? 1 : 0) || b.conns - a.conns);
}

// ── applying a class ─────────────────────────────────────────────────────────────
//
// Two mechanisms, because Windows gives us two and they are not equivalent:
//
//   'block'  A firewall rule. Reliable, immediate, and works in both directions in the
//            only sense that matters — the process cannot open the connections it would
//            have downloaded through. This is the honest answer to a Steam download.
//
//   'limit'  A native QoS policy. Best-effort by nature: it caps OUTBOUND throughput only,
//            it applies to connections opened after it exists, and on some editions the
//            policy is not read until a group-policy refresh. All of that is said in the
//            returned `note` rather than hidden, because a limiter the user believes in and
//            that silently does nothing is worse than no limiter at all.
const QOS_KEY = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\QoS';
const RULE_PREFIX = 'MLMVPN-Game-Shaper';

function policyNameFor(exe) { return `${RULE_PREFIX}-${exe.replace(/[^a-z0-9._-]/gi, '_')}`; }

async function apply({ exe, path: exePath = null, mode = 'block', kbps = 512 } = {}) {
    const name = String(exe || '').trim();
    if (!name) throw new Error('نام برنامه مشخص نیست.');
    const key = name.toLowerCase();
    if (PROTECTED.has(key)) throw new Error('این پروسه محافظت‌شده است — محدود کردنش خودِ تونل یا ویندوز را می‌شکند.');
    if (mode !== 'block' && mode !== 'limit') throw new Error('این حالت شناخته نشد.');

    // A firewall rule matches an executable by FULL PATH, not by name — Windows offers no
    // "block anything called steam.exe". Without the path there is no rule to create, and
    // saying so is better than creating a rule that matches nothing and looks applied.
    if (mode === 'block' && !exePath) {
        throw new Error('مسیر فایل اجرایی این برنامه خوانده نشد (معمولاً یعنی با دسترسی بالاتر اجرا شده). «محدود کردن» را امتحان کن.');
    }

    const back = loadBackup();
    if (back.rules[key]) throw new Error('برای این برنامه از قبل یک قاعده هست. اول برش گردان.');

    const policy = policyNameFor(name);
    // Written BEFORE the change exists, exactly as tweaks.js does with original values: if
    // the app dies between creating the rule and recording it, the next launch would have
    // no idea a machine-wide rule belonged to us — and that rule would outlive the feature.
    back.rules[key] = { exe: name, path: exePath || null, mode, kbps: mode === 'limit' ? Number(kbps) : null, policy, at: Date.now() };
    try { saveBackup(back); }
    catch (e) { throw new Error('نتوانستم سابقه را ذخیره کنم، پس تغییری هم نمی‌دهم: ' + e.message); }

    let script, note;
    if (mode === 'block') {
        script = `
$ErrorActionPreference='Stop'
New-NetFirewallRule -DisplayName '${policy}' -Direction Outbound -Action Block -Program '${exePath.replace(/'/g, "''")}' -Enabled True | Out-Null
[PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress
`;
        note = 'ترافیک این برنامه تا وقتی برش نگردانی قطع است.';
    } else {
        const bytesPerSec = Math.max(8, Math.round(Number(kbps) * 125)); // kbit/s -> bytes/s
        script = `
$ErrorActionPreference='Stop'
if (-not (Test-Path '${QOS_KEY}')) { New-Item -Path '${QOS_KEY}' -Force | Out-Null }
$p = Join-Path '${QOS_KEY}' '${policy}'
if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
New-ItemProperty -Path $p -Name 'Version' -Value '1.0' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $p -Name 'Application Name' -Value '${name}' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $p -Name 'Throttle Rate' -Value '${bytesPerSec}' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $p -Name 'DSCP Value' -Value '-1' -PropertyType String -Force | Out-Null
foreach ($n in @('Local Port','Local IP','Local IP Prefix Length','Remote Port','Remote IP','Remote IP Prefix Length','Protocol')) {
  New-ItemProperty -Path $p -Name $n -Value '*' -PropertyType String -Force | Out-Null
}
gpupdate /target:computer /force | Out-Null
[PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress
`;
        note = 'این سقف فقط روی آپلود کار می‌کند و روی اتصال‌های تازه اعمال می‌شود — دانلود را ویندوز بدون درایور کرنلی محدود نمی‌کند.';
    }

    const r = await ps(script, 40000);
    if (!r.ok) {
        // Roll the record back: a rule that was never created must not be remembered as one,
        // or restore() will later report a failure the user cannot act on.
        const b2 = loadBackup();
        delete b2.rules[key];
        try { saveBackup(b2); } catch { /* the next restoreAll will still find nothing to do */ }
        // Never hand the user PowerShell's stderr. Both mechanisms here are machine-wide, so
        // by far the most common failure is simply "not elevated" — and that has an action
        // attached to it, which a wall of English stack trace does not.
        const raw = String(r.error || '');
        throw new Error(/denied|Requested registry access|elevat/i.test(raw)
            ? 'برای این کار برنامه باید با دسترسی مدیر اجرا شود (قاعده‌ی فایروال و سیاست QoS هر دو ماشین‌گستر هستند). برنامه را «Run as administrator» باز کن.'
            : 'اعمال نشد: ' + (raw.split('\n')[0] || 'علت نامشخص'));
    }
    return { ok: true, exe: name, mode, note };
}

async function restore(exe) {
    const key = String(exe || '').toLowerCase();
    const back = loadBackup();
    const rec = back.rules[key];
    if (!rec) throw new Error('برای این برنامه قاعده‌ای از ما ثبت نشده است.');

    // Only ever removes the policy name WE recorded. A blanket "remove every rule matching
    // *Game*" would eventually delete something a user or another tool created.
    //
    // AND IT VERIFIES. The first version ran the removal under SilentlyContinue and then
    // printed ok:$true unconditionally — so on a machine without admin rights the removal
    // failed, the script still reported success, and the record was deleted. Caught in the
    // act: the QoS policy MLMVPN-Game-Shaper-chrome.exe was still throttling Chrome's upload
    // while the panel showed nothing applied and offered no way to undo it. A revert that
    // cannot be verified is worse than one that refuses.
    const script = rec.mode === 'block'
        ? `$ErrorActionPreference='SilentlyContinue'
Remove-NetFirewallRule -DisplayName '${rec.policy}'
$left = @(Get-NetFirewallRule -DisplayName '${rec.policy}').Count
[PSCustomObject]@{ gone = ($left -eq 0) } | ConvertTo-Json -Compress`
        : `$ErrorActionPreference='SilentlyContinue'
$p = Join-Path '${QOS_KEY}' '${rec.policy}'
Remove-Item -Path $p -Recurse -Force
gpupdate /target:computer /force | Out-Null
[PSCustomObject]@{ gone = (-not (Test-Path $p)) } | ConvertTo-Json -Compress`;

    const r = await ps(script, 40000);
    const gone = !!(r.items && r.items[0] && r.items[0].gone);
    if (!gone) {
        // The record STAYS, so the panel keeps showing this as applied and the user can try
        // again from an elevated instance. Forgetting it here is how a machine ends up with a
        // throttle nobody can find.
        throw new Error(`«${rec.exe}» هنوز محدود است — برداشتنش دسترسی مدیر می‌خواهد. برنامه را «Run as administrator» باز کن و دوباره بزن.`);
    }
    delete back.rules[key];
    saveBackup(back);
    return { ok: true, exe: rec.exe };
}

/**
 * Put everything back — including the machine-wide cap.
 *
 * The cap is deliberately part of this rather than a separate call: it was applied as part of
 * acceleration, and a «توقف شتاب» that left the whole machine throttled would be the single most
 * confusing thing this feature could do.
 */
async function restoreAll() {
    const back = loadBackup();
    const out = [];
    for (const key of Object.keys(back.rules || {})) {
        try { out.push(await restore(key)); }
        catch (e) { out.push({ ok: false, exe: key, error: e.message }); }
    }
    // The machine-wide cap goes with them. It was applied as part of acceleration, and a
    // «توقف شتاب» that left the whole machine throttled would be the most confusing thing this
    // feature could possibly do.
    if (back.egress) {
        try {
            const r = await uncapEgress();
            out.push({ ok: !!r.ok, exe: 'سقف آپلود کل خط', error: r.error });
        } catch (e) { out.push({ ok: false, exe: 'سقف آپلود کل خط', error: e.message }); }
    }
    return { ok: true, restored: out };
}

/** What we currently have applied — read from our own record, never from Windows. */
function list() {
    const back = loadBackup();
    return Object.values(back.rules || {}).map(r => ({
        exe: r.exe, mode: r.mode, kbps: r.kbps, at: r.at,
        fa: suspect(r.exe) || r.exe,
    }));
}

// ── the whole line, not one application ──────────────────────────────────────────────────────
//
// Everything above shapes ONE program. This shapes the machine, and it is a different lever for a
// different problem: bufferbloat is not caused by a particular application, it is caused by ANY
// flow that fills the upstream queue, and the fix is to make sure none of them can.
//
// Measured on this line: with the uplink saturated, p95 went from 126ms to 2681ms and 29% of
// packets were lost. Capped, the queue never fills and the game keeps the latency the line is
// actually capable of.
//
// `Application Name = '*'` is how the policy store expresses "every program". A cap set at 90% of
// measured capacity binds only flows that would have saturated — a game's own upload is tens of
// kbit/s and never comes close — so the game needs no exemption and this does not have to rely on
// Windows' policy-precedence rules.
const EGRESS_POLICY = `${RULE_PREFIX}-Egress`;

/**
 * Cap everything this machine sends.
 *
 * @param kbps  the cap in kbit/s. Comes from a measurement — see localaudit.uploadBloat. A guessed
 *              cap is worse than none: too low and it throttles the user's own life for nothing,
 *              too high and the queue still fills.
 */
async function capEgress({ kbps } = {}) {
    const rate = Math.round(Number(kbps) || 0);
    if (!(rate > 0)) throw new Error('سقف آپلود مشخص نیست.');

    const back = loadBackup();
    if (back.egress) throw new Error('سقف آپلود از قبل اعمال شده است. اول برش گردان.');

    // Recorded BEFORE it exists, the same rule the per-application path follows: a machine-wide
    // policy that outlives the app because it died between creating and recording it is the worst
    // thing this file could leave behind.
    back.egress = { kbps: rate, policy: EGRESS_POLICY, at: Date.now() };
    try { saveBackup(back); }
    catch (e) { throw new Error('نتوانستم سابقه را ذخیره کنم، پس تغییری هم نمی‌دهم: ' + e.message); }

    const bytesPerSec = Math.max(8, Math.round(rate * 125));   // kbit/s -> bytes/s
    const r = await ps(`
$ErrorActionPreference='Stop'
if (-not (Test-Path '${QOS_KEY}')) { New-Item -Path '${QOS_KEY}' -Force | Out-Null }
$p = Join-Path '${QOS_KEY}' '${EGRESS_POLICY}'
if (-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
New-ItemProperty -Path $p -Name 'Version' -Value '1.0' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $p -Name 'Application Name' -Value '*' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $p -Name 'Throttle Rate' -Value '${bytesPerSec}' -PropertyType String -Force | Out-Null
New-ItemProperty -Path $p -Name 'DSCP Value' -Value '-1' -PropertyType String -Force | Out-Null
foreach ($n in @('Local Port','Local IP','Local IP Prefix Length','Remote Port','Remote IP','Remote IP Prefix Length','Protocol')) {
  New-ItemProperty -Path $p -Name $n -Value '*' -PropertyType String -Force | Out-Null
}
[PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress
`);
    if (!r || !r.items || !r.items[0] || r.items[0].ok !== true) {
        // Undo the record rather than leaving a claim about a policy that was never written.
        const b2 = loadBackup(); delete b2.egress; try { saveBackup(b2); } catch (e) { /* best effort */ }
        throw new Error('سقف آپلود اعمال نشد — معمولاً یعنی برنامه دسترسی مدیر ندارد.');
    }
    return {
        ok: true, kbps: rate,
        // Said rather than hidden, exactly as the per-application limiter says its own caveat.
        note: 'سیاست QoS ویندوز فقط روی اتصال‌هایی اثر می‌گذارد که بعد از ساختنش باز می‌شوند، و روی بعضی نسخه‌های ویندوز تا یک بار بازخوانی سیاست‌ها خوانده نمی‌شود.',
    };
}

/** Take the cap off. Idempotent: nothing recorded means nothing to undo. */
async function uncapEgress() {
    const back = loadBackup();
    if (!back.egress) return { ok: true, nothing: true };
    const r = await ps(`
$ErrorActionPreference='SilentlyContinue'
$p = Join-Path '${QOS_KEY}' '${EGRESS_POLICY}'
if (Test-Path $p) { Remove-Item -Path $p -Recurse -Force }
[PSCustomObject]@{ ok = -not (Test-Path $p) } | ConvertTo-Json -Compress
`);
    const gone = !!(r && r.items && r.items[0] && r.items[0].ok);
    if (gone) { delete back.egress; saveBackup(back); }
    return { ok: gone, error: gone ? undefined : 'سقف آپلود برداشته نشد — دسترسی مدیر لازم است.' };
}

/** Is a cap on right now, and at what rate? Read from the record, like every other state here. */
function egressCap() {
    const back = loadBackup();
    return back.egress ? { on: true, kbps: back.egress.kbps, at: back.egress.at } : { on: false };
}

module.exports = {
    candidates, apply, restore, restoreAll, list, PROTECTED, BACKUP_FILE,
    capEgress, uncapEgress, egressCap, EGRESS_POLICY,
};
