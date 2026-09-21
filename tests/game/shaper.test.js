/*
 * game/shaper.js — the guards.
 *
 * This module is the only thing in the feature that makes MACHINE-WIDE changes a user did
 * not otherwise ask for: a firewall rule and a QoS policy. So what is pinned here is not the
 * happy path (which needs elevation and a real machine to prove) but the refusals — the
 * cases where applying anything at all would be wrong.
 *
 * Every assertion below runs BEFORE the module would touch PowerShell or the backup file:
 * apply() validates, then rejects, and only afterwards writes anything. That ordering is
 * itself part of what is being tested — if a future edit moves the backup write above the
 * guards, these tests start leaving rules on the machine that runs them, and the suite's
 * "nothing writes to ~/.mlmvpn" promise quietly breaks.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const shaper = require(path.join(ROOT, 'game', 'shaper'));

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

async function rejects(name, fn, matcher) {
    try {
        await fn();
        t(name, false, 'did not throw');
    } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        t(name, matcher ? matcher.test(msg) : true, msg.slice(0, 90));
    }
}

(async () => {
    const before = fs.existsSync(shaper.BACKUP_FILE) ? fs.readFileSync(shaper.BACKUP_FILE, 'utf8') : null;

    // ── the protected list ───────────────────────────────────────────────────────
    // Shaping the engine is the one mistake that would look exactly like the problem the
    // panel is trying to solve: the user throttles aether.exe, their game gets worse, and
    // the accelerator gets the blame.
    await rejects('the tunnel engine itself can never be shaped',
        () => shaper.apply({ exe: 'aether.exe', path: 'C:\\x\\aether.exe', mode: 'block' }), /محافظت/);
    await rejects('…nor Xray', () => shaper.apply({ exe: 'xray.exe', path: 'C:\\x\\xray.exe', mode: 'block' }), /محافظت/);
    await rejects('…nor sing-box', () => shaper.apply({ exe: 'sing-box.exe', path: 'C:\\x\\s.exe', mode: 'block' }), /محافظت/);
    await rejects('…nor svchost, which would take name resolution down with it',
        () => shaper.apply({ exe: 'svchost.exe', path: 'C:\\x\\svchost.exe', mode: 'block' }), /محافظت/);

    t('the protected set is matched case-insensitively',
        shaper.PROTECTED.has('aether.exe') && !shaper.PROTECTED.has('Aether.exe'),
        'lookup is lowercase — apply() lowercases before checking');
    await rejects('…proved through the real entry point, with shouty casing',
        () => shaper.apply({ exe: 'AETHER.EXE', path: 'C:\\x\\a.exe', mode: 'block' }), /محافظت/);

    // ── blocking needs a path, and says so ───────────────────────────────────────
    // Windows firewall rules match an executable by full path. A rule created from a bare
    // name matches nothing, and a rule that matches nothing is worse than a refusal: the
    // switch reads "blocked" while the download carries on.
    await rejects('blocking without an executable path is refused, not faked',
        () => shaper.apply({ exe: 'steam.exe', mode: 'block' }), /مسیر فایل اجرایی/);

    // ── input validation ─────────────────────────────────────────────────────────
    await rejects('an empty program name is refused', () => shaper.apply({ exe: '   ', mode: 'block' }), /نام برنامه/);
    await rejects('an unknown mode is refused rather than defaulted',
        () => shaper.apply({ exe: 'steam.exe', path: 'C:\\x\\steam.exe', mode: 'throttle-everything' }), /حالت/);

    // ── restore only ever touches what we recorded ───────────────────────────────
    // The dangerous version of this function removes every firewall rule matching a pattern.
    // This one refuses to act on anything it did not write down.
    await rejects('restoring something we never shaped is refused',
        () => shaper.restore('some-app-we-never-touched.exe'), /ثبت نشده/);

    // ── the module keeps its hands off the disk until it acts ────────────────────
    const after = fs.existsSync(shaper.BACKUP_FILE) ? fs.readFileSync(shaper.BACKUP_FILE, 'utf8') : null;
    t('none of the refusals wrote to the backup file', before === after,
        before === after ? 'unchanged' : 'THE FILE CHANGED — a guard now runs after the write');

    // ── list() is a read of our own record, never of Windows ─────────────────────
    const list = shaper.list();
    t('list() returns an array without touching the system', Array.isArray(list), typeof list);
    t('every listed rule names the program it applies to',
        list.every(r => r && typeof r.exe === 'string'), JSON.stringify(list).slice(0, 60));

    let failed = 0;
    for (const x of results) {
        if (!x.ok) failed++;
        console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + x.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
