// --- No spawn failure may ever close the application ---
//
// On Windows, `spawn()` does not throw when the binary is missing or cannot be run. It returns a
// ChildProcess and the failure arrives later as an 'error' event. So the try/catch that every
// call site wraps around the spawn call catches nothing at all.
//
// And Node does not ignore an 'error' event nobody listens for: EventEmitter re-throws it as an
// uncaught exception. With no listener, "this engine's binary is not where I looked" becomes
// "MLM VPN closed itself", with no window, no message, and nothing on screen to explain it.
//
// That is not hypothetical. 2026-09-22, «لنترن», on an installed build, while the developer was
// recording a tutorial:
//
//     Error: spawn C:\Program Files\MLM VPN\resources\app.asar\core\lantern.exe ENOENT
//         at ChildProcess._handle.onexit (node:internal/child_process:287:19)
//
// The path was wrong (core/ is unpacked beside the asar, not inside it — see core-paths.bundled),
// and the sweep in lantern-manager.drawOne spawned up to nine children with no listener between
// them. The first one took the whole application down.
//
// So: every child this process spawns gets a listener at birth. It does nothing but record —
// whatever the call site does about the failure, it still does, because adding a listener does
// not stop other listeners from running. The ONLY behaviour this changes is that Node no longer
// re-throws, which is never what we want for a child process we chose to start.
//
// This is deliberately a wrapper around the module rather than a rule everyone must remember.
// scripts/check-spawn-handlers.js still reports call sites with no handler of their own, because
// surviving is not the same as telling the user what went wrong — this guard buys the chance to
// report, it does not do the reporting.

'use strict';

const childProcess = require('child_process');

let installed = false;
const seen = [];          // the last few failures, for Settings › درباره › «گزارش خطا»

/** What has failed to spawn in this run, newest last. Read by the diagnostics routes. */
function failures() { return seen.slice(); }

function install(log) {
    if (installed) return false;
    installed = true;

    const wrap = (name) => {
        const real = childProcess[name];
        if (typeof real !== 'function') return;
        childProcess[name] = function guardedSpawn(...args) {
            const child = real.apply(this, args);
            // A ChildProcess is returned even for the failure cases. `spawnSync` is not wrapped:
            // it reports through its return value and has no events.
            if (child && typeof child.on === 'function') {
                child.on('error', (err) => {
                    const file = (args && args[0]) || '?';
                    const entry = {
                        at: new Date().toISOString(),
                        file: String(file),
                        code: err && err.code ? err.code : '',
                        message: err && err.message ? err.message : String(err),
                    };
                    seen.push(entry);
                    if (seen.length > 20) seen.shift();
                    const line = `spawn failed: ${entry.file} — ${entry.code || ''} ${entry.message}`;
                    try { (log || console.error)(line); } catch (e) { /* not even logging works */ }
                    // Recorded where the user can already find it, without inventing a new place.
                    try {
                        require('./crash-reporter').record('spawn', err, entry);
                    } catch (e) { /* no record; the app is still alive, which is the point */ }
                });
            }
            return child;
        };
    };

    wrap('spawn');
    return true;
}

module.exports = { install, failures };
