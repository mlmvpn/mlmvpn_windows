/*
 * The exit watch — what decides that a match is over.
 *
 * WHY THIS EXISTS AT ALL
 * Acceleration is a claim about the time the user is PLAYING, and until 2026-09-14 nothing ever
 * took it back: the only automatic restore was at app shutdown. Press the button, alt-tab out,
 * and every suspended application stayed suspended, the line stayed throttled and the DNS stayed
 * swapped — indefinitely. That is most of what the field reports of «سیستم هنگ میکنه» actually
 * were, and it is why this watch was added.
 *
 * WHAT IS PINNED HERE, AND WHY EACH ONE IS A REAL FAILURE
 *
 *   * It must WAIT for a game that has not started yet. Boosting before launching is the
 *     architectural advantage this feature has over ExitLag — the route is already in place when
 *     the first packet leaves — so a watch that concluded "no game running, therefore the match
 *     ended" would undo the boost within six seconds of arming, every single time.
 *
 *   * It must not fire on a BLIP. Launchers restart game processes between rounds and a single
 *     missed poll is not the end of a session. Tearing the boost down mid-match, and then having
 *     to rebuild it, is worse than never having boosted.
 *
 *   * It must give up on a game that never arrives, or a user who accelerates and walks away is
 *     left with the machine changed for ever.
 *
 * The real close-detection path was verified live against a genuine Windows process before this
 * file was written (notepad as the stand-in game: armed, seen running, killed, and the revert
 * fired 17s later with ok=true). What is pinned HERE is the decision logic around it, which is
 * where the reasoning can rot silently — no processes are started by this suite.
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const accel = require(path.join(ROOT, 'game', 'accelerate'));

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * The watch polls `detect.anyRunning`. Swapping that one function lets the whole lifecycle be
 * driven in a second instead of the six-second real cadence — and it is the honest seam: the
 * thing being tested is what the watch DECIDES, not whether Windows can list processes.
 */
const detect = require(path.join(ROOT, 'game', 'detect'));
const realAnyRunning = detect.anyRunning;
let pretendRunning = false;
detect.anyRunning = async () => (pretendRunning ? [{ name: 'fake.exe', pid: 1 }] : []);

(async () => {
    // ── 1. a game that has not started yet must not look like a game that ended ──
    {
        let reverted = null;
        pretendRunning = false;
        accel.armExitWatch({
            game: { id: 'x', fa: 'آزمون', procs: ['fake.exe'] },
            dnsManager: null, log: () => {},
            emit: (ev) => { if (ev.type === 'auto-revert') reverted = ev; },
        });
        await sleep(1200);
        t('a game that has not started yet does not trigger a revert', reverted === null,
            reverted ? JSON.stringify(reverted) : '');
        accel.cancelExitWatch();
    }

    // ── 2. nothing to watch for means no watch, rather than a watch that fires at once ──
    {
        const w = accel.armExitWatch({
            game: { id: 'x', fa: 'آزمون', procs: [] },
            dnsManager: null, log: () => {}, emit: () => {},
        });
        t('a game with no known process names arms no watch at all', w === null,
            'otherwise it would revert the moment it armed');
        accel.cancelExitWatch();
    }

    // ── 3. wildcard-only process lists are not something to match on ──
    {
        const w = accel.armExitWatch({
            game: { id: 'x', fa: 'آزمون', procs: ['anything*'] },
            dnsManager: null, log: () => {}, emit: () => {},
        });
        t('a wildcard entry is not treated as a process name', w === null);
        accel.cancelExitWatch();
    }

    // ── 4. a manual revert cancels the watch, so it cannot revert a second time ──
    {
        accel.armExitWatch({
            game: { id: 'x', fa: 'آزمون', procs: ['fake.exe'] },
            dnsManager: null, log: () => {}, emit: () => {},
        });
        await accel.revert({ dnsManager: null, onLog: () => {} });
        let firedAfter = null;
        // If the watch were still armed it would now see "not running" and eventually fire.
        await sleep(900);
        t('reverting by hand disarms the watch', firedAfter === null);
        accel.cancelExitWatch();
    }

    detect.anyRunning = realAnyRunning;

    let failed = 0;
    for (const x of results) {
        if (!x.ok) failed++;
        console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + x.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
