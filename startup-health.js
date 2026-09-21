// --- Did the app actually come up last time? ---
//
// A window that stays black is the worst failure this app has: the renderer is alive, so
// nothing crashes, nothing is logged, and no error dialog fires. The user force-quits and
// reinstalls, and the reinstall changes nothing because the cause is on the machine.
//
// Two causes are known and they need opposite treatment:
//
//   · THE MAIN PROCESS WAS BLOCKED. server.js runs in Electron's main process, so a
//     synchronous spawn there freezes the app AND the local HTTP server the page is loading
//     its 68 scripts from — the page stalls half-built behind a black boot screen. That is a
//     bug, and the ones that were measured are fixed (see dns-manager.hasStrandedLoopbackDns).
//   · THE GPU CANNOT COMPOSITE. Old or 32-bit machines, remote sessions, some drivers: the
//     renderer runs, paints into a surface nothing displays, and the window is black forever.
//     Not a bug we can fix — but `app.disableHardwareAcceleration()` makes it draw on the CPU,
//     and that always works.
//
// This file used to turn acceleration off BY ITSELF after two launches that never reported a
// desktop. That was wrong, and it shipped, and it fired on a healthy app — twice over wrong:
//
//   · the report was not arriving AT ALL (the renderer had no `require`; see main.js's
//     contextIsolation note), so every launch looked like a failure; and
//   · even with the report working it could not have detected the thing it was for. A window
//     that is black because the GPU cannot composite still boots, still runs, and still
//     reports itself ready. The signal and the symptom are simply unrelated.
//
// So the automation is gone — and beginLaunch undoes what it already wrote, because deleting
// the code does not clear the flag off the disks it reached. What remains is the USER'S OWN
// setting, reachable from Settings › صفحه نمایش and from the tray menu (the tray is drawn by
// Windows, so it is the one surface someone with a black window can still use), plus a count of
// launches that never reported a desktop — real evidence of the FIRST cause and of nothing else.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.mlmvpn');
const FILE = path.join(DIR, 'startup.json');

// How long a start is allowed to take before we call it failed. The page's own boot screen
// gives up at 15 s, and a healthy start on a slow laptop is under 10 — so this sits far
// enough past both that it cannot fire on a merely slow machine.
const READY_DEADLINE_MS = 30000;

function read() {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { j = {}; }
    return {
        fails: Number(j.fails) || 0,
        gpuOff: j.gpuOff === true,
        gpuOffAuto: j.gpuOffAuto === true,   // we turned it off, not the user
        lastOkAt: Number(j.lastOkAt) || 0,
        lastFailAt: Number(j.lastFailAt) || 0,
    };
}

function write(next) {
    try {
        fs.mkdirSync(DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(next), 'utf8');
    } catch (e) { /* the app still runs; it just cannot learn from this launch */ }
}

/**
 * Called at the very top of main.js, before `app.whenReady()`.
 *
 * Returns whether this launch should run without the GPU. Marking the launch as "in flight"
 * happens here too: if we never hear that the desktop came up, the count stands.
 */
function beginLaunch() {
    const s = read();

    // ── undo the automatic switch-off, once ──────────────────────────────────────────────
    //
    // The version that shipped this turned the GPU off BY ITSELF on the third launch that had
    // not reported a desktop — and the report could not arrive at all, so every launch counted
    // as a failure. Every machine that opened the app three times ended up drawing on the CPU,
    // permanently, with a note in Settings claiming the app had detected a black screen.
    //
    // Removing the automation does not undo what it already wrote: the flag is on disk and
    // beginLaunch would keep honouring it forever. It says nothing about this machine, so it
    // goes. A choice the USER made writes gpuOffAuto:false and is never touched.
    const undidAuto = s.gpuOffAuto === true;

    const next = Object.assign({}, s, {
        // Counted as failed until the page says otherwise. Nothing acts on this by itself any
        // more — it is shown in Settings, so a user whose app did come up sees nothing and a
        // user whose app did not has something to point at.
        fails: s.fails + 1,
        lastFailAt: Date.now(),
    });
    if (undidAuto) { next.gpuOff = false; next.gpuOffAuto = false; next.fails = 0; }
    write(next);
    return { gpuOff: next.gpuOff, fails: s.fails, undidAuto };
}

/** The page reached a usable desktop. Clears the streak. */
function markReady() {
    const s = read();
    write(Object.assign({}, s, { fails: 0, lastOkAt: Date.now() }));
}

/** Settings › صفحه نمایش. The only thing that ever changes this. */
function setGpuOff(off) {
    const s = read();
    write(Object.assign({}, s, { gpuOff: !!off, gpuOffAuto: false, fails: 0 }));
    return !!off;
}

// ── the startup diary ────────────────────────────────────────────────────────────────────
//
// A black or white window is the one failure the user cannot describe and we cannot see: no
// error, no crash, no log. Every guess about it so far has been a guess, and one of them
// shipped and was wrong. So the launch writes down what it did, in order, with timings —
// which machine, which architecture, which Windows, what the GPU reported, how far the page
// got. One file, and the next report is evidence instead of a description.
//
// It is appended to on every launch and trimmed from the front, so it always holds the last
// few starts: the one that failed and the ones that worked, side by side.

const NL = String.fromCharCode(10);
// Drops the oldest line when the log is trimmed to its ceiling.
const FIRST_LINE = new RegExp('^[^' + NL + ']*' + NL);
const LOG = path.join(DIR, 'startup.log');
const LOG_MAX = 64 * 1024;

const t0 = Date.now();
const lines = [];

function stamp() {
    const ms = Date.now() - t0;
    return '+' + String(ms).padStart(6) + 'ms';
}

/**
 * Record one step of this launch. Never throws — a diary that breaks the start it is
 * describing would be worse than no diary.
 */
function note(event, data) {
    let line = stamp() + '  ' + event;
    if (data !== undefined) {
        try {
            line += '  ' + (typeof data === 'string' ? data : JSON.stringify(data));
        } catch (e) { line += '  [unserialisable]'; }
    }
    lines.push(line);
    try {
        fs.mkdirSync(DIR, { recursive: true });
        let prev = '';
        try { prev = fs.readFileSync(LOG, 'utf8'); } catch (e) { prev = ''; }
        let next = prev + line + NL;
        if (next.length > LOG_MAX) next = next.slice(next.length - LOG_MAX).replace(FIRST_LINE, '');
        fs.writeFileSync(LOG, next, 'utf8');
    } catch (e) { /* the launch matters more than the record of it */ }
}

/** What this launch has written so far, for pasting into a failure report. */
function diary() { return lines.join(NL); }

/** The machine, in the four facts that have ever mattered for this bug. */
function machine() {
    let version = '?';
    try { version = require('./package.json').version; } catch (e) { /* unknown */ }
    return {
        app: version,
        arch: process.arch,                 // ia32 is the population that reports this
        windows: os.release(),
        electron: (process.versions && process.versions.electron) || '?',
    };
}

module.exports = { beginLaunch, markReady, setGpuOff, read, note, diary, machine, FILE, LOG, READY_DEADLINE_MS };
