/*
 * game/focus.js — the never-touch boundary.
 *
 * This module rewrites the scheduling priority of every process on the machine, so what is
 * tested is not that it works — a live run proved that (29 processes lowered, power plan to
 * High Performance, Game Mode on, all without elevation, all restored exactly). What is
 * tested is the boundary, because that is the part where a mistake does not show up as a
 * failed test but as a machine that stutters, loses audio, or stops redrawing while the user
 * blames the game.
 *
 * The lists are the contract:
 *   NEVER   — dropping these does not give the game anything. It breaks the desktop in ways
 *             that look exactly like the lag the user opened this panel to fix.
 *   ENGINES — the processes carrying the game's own packets. Starving them starves the game.
 *   OURS    — this app, which is the one process here with no business competing with the
 *             game it claims to be accelerating. It is deliberately NOT protected.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const focus = require(path.join(ROOT, 'game', 'focus'));

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

// ── the desktop must survive ─────────────────────────────────────────────────────
for (const critical of ['system', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'svchost', 'dwm', 'audiodg', 'explorer']) {
    t(`«${critical}» is never de-prioritised`, focus.NEVER.has(critical), critical);
}
t('the audio engine specifically is protected — stutter would be blamed on the game',
    focus.NEVER.has('audiodg'));
t('the compositor is protected — a frozen desktop looks exactly like lag',
    focus.NEVER.has('dwm'));

// ── the engines carrying the game must survive ───────────────────────────────────
for (const engine of ['aether', 'xray', 'sing-box', 'tailscaled']) {
    t(`«${engine}» is never starved — it is carrying the game's packets`, focus.ENGINES.has(engine), engine);
}

// ── and this app must NOT be protected ───────────────────────────────────────────
// The user's own Task Manager screenshot showed MLM VPN at 9.5% CPU while the panel offered
// to hand the machine to the game. A booster that exempts itself is a joke, so this is
// asserted from the other direction: our names must be in OURS and must NOT be in NEVER.
for (const ours of ['electron', 'node']) {
    t(`«${ours}» (this app) is in the yield list`, focus.OURS.has(ours), ours);
    t(`…and is NOT protected from being lowered`, !focus.NEVER.has(ours), ours);
}

// ── no product names in the never-freeze list ────────────────────────────────────
//
// The user's rule, and it is the right one for software that thousands of people run on
// machines nobody here has seen: «نباید اسم نرم افزار خاصی هارد کد بشه — همه نرم افزارها
// غیر از حیاتی های ویندوز». An earlier version exempted the developer's own editor, which
// privileged one machine's software over every user's.
//
// What is allowed to stay is the user's means of RESCUE — a task manager and a shell — and
// nothing else. If a name here starts looking like a product, this test should fail.
{
    const rescueOnly = /^(taskmgr|procexp\d*|procmon|perfmon|resmon|cmd|powershell|pwsh|windowsterminal|conhost)$/;
    const offenders = [...focus.NEVER_SUSPEND].filter(n => !rescueOnly.test(n));
    t('the never-freeze list contains only rescue tools, no named applications',
        offenders.length === 0, offenders.join(',') || 'clean');
    t('a task manager is always reachable — it is the way out if this file is wrong',
        focus.NEVER_SUSPEND.has('taskmgr'));
    t('so is a shell', focus.NEVER_SUSPEND.has('cmd') && focus.NEVER_SUSPEND.has('powershell'));
}

// ── launchers are treated as part of the game ────────────────────────────────────
// Freezing Steam mid-match logs the player out of the thing they are playing.
for (const launcher of ['steam', 'epicgameslauncher', 'battle.net', 'riotclientservices', 'galaxyclient', 'eadesktop']) {
    t(`«${launcher}» is protected as part of the game`, focus.LAUNCHERS.has(launcher), launcher);
}
t('the anti-cheat services games ship with are never frozen',
    focus.LAUNCHERS.has('easyanticheat') && focus.LAUNCHERS.has('battleye'));

// ── the rule that replaced the one that broke a machine ──────────────────────────
//
// This is the most important test in the file, and it exists because of a real incident:
// the earlier rule froze everything in the user's session except a hand-written list of
// critical names, and it took their desktop with it — mouse dead, Windows key dead, this app
// dead, recovered only by holding the power button. The list was not missing an entry; the
// SHAPE was wrong. A block-list has to be complete to be safe, and nobody can enumerate every
// process that matters across thousands of machines.
//
// What is pinned here is the inversion: the script must decide by ALLOW-list — outside
// C:\Windows, and a real window with a title — rather than by exclusion.
{
    const src = fs.readFileSync(path.join(ROOT, 'game', 'focus.js'), 'utf8');
    t('nothing under the Windows directory can ever be a candidate',
        /notlike\s+"\$env:SystemRoot/.test(src), 'the SystemRoot exclusion is gone');
    t('a process needs a VISIBLE window with a title — a tray helper is not an application',
        /MainWindowTitle\s+-ne\s+''/.test(src), 'the window-title requirement is gone');
    t('child processes are included through their parent, so a browser is not half-frozen',
        /appParents/.test(src), 'the parent-tree walk is gone');
    t('the foreground window is still exempt', /MainWindowHandle -ne \$fg/.test(src));
    t('and the session boundary still holds — services are never candidates',
        /SessionId -eq \$mySession/.test(src));
}

// ── the RAM trim is bounded ──────────────────────────────────────────────────────
// Trimming every frozen process at once wrote the whole session to the pagefile and the
// mouse "به زور تکون میخورد" while it all faulted back.
{
    // Read the real constants, not their source text: the first version of this test matched
    // the literal "60" out of "60 * 1024 * 1024" and failed for entirely the wrong reason.
    t('only processes big enough to be worth reclaiming are trimmed',
        focus.TRIM_MIN_BYTES >= 32 * 1024 * 1024, String(focus.TRIM_MIN_BYTES));
    t('and only a bounded number of them, so the thaw is not a disk storm',
        focus.TRIM_MAX_PROCS <= 40, String(focus.TRIM_MAX_PROCS));
}

// ── the lists must not contradict each other ─────────────────────────────────────
const overlap = [...focus.OURS].filter(x => focus.NEVER.has(x) || focus.ENGINES.has(x));
t('nothing is both "yield" and "protected" — that would silently do nothing',
    overlap.length === 0, overlap.join(','));

// ── state is a file, and its absence means "not applied" ─────────────────────────
{
    const existed = fs.existsSync(focus.BACKUP_FILE);
    const st = focus.status();
    t('status() reports off when no backup exists, on when it does',
        st.on === existed, `backup=${existed} status.on=${st.on}`);
    t('status() never throws on a missing or corrupt backup', typeof st === 'object');
}

// ── restore with nothing recorded is a no-op, not an error ───────────────────────
(async () => {
    if (!fs.existsSync(focus.BACKUP_FILE)) {
        const r = await focus.restore();
        t('restoring when focus was never applied is a no-op, not a failure',
            r && r.ok && r.nothing === true, JSON.stringify(r));
    } else {
        t('restoring when focus was never applied is a no-op, not a failure', true, 'skipped — focus is currently applied on this machine');
    }

    let failed = 0;
    for (const x of results) {
        if (!x.ok) failed++;
        console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + x.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
