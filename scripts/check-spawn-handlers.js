#!/usr/bin/env node
/*
 * Every spawned child must have an 'error' listener.
 *
 *   node scripts/check-spawn-handlers.js
 *
 * On Windows a failed spawn does NOT throw. `spawn()` returns a ChildProcess and the failure
 * arrives later as an 'error' event — so a try/catch around the spawn call catches nothing. And
 * an 'error' event with no listener is not ignored by Node: EventEmitter re-throws it as an
 * uncaught exception, which ends the process.
 *
 * So a missing listener turns "this engine's binary is not where I looked" into "the whole
 * application closed", with the user watching. That is exactly what happened on 2026-09-22:
 * lantern-manager's sweep (drawOne) spawned up to nine children with no listener, the binary was
 * at the wrong path, and MLM VPN vanished mid-connect.
 *
 * This finds a `spawn(` and looks for `<that variable>.on('error'` nearby. It is deliberately
 * simple: it reports what to look at, and a false positive costs one line of reading.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'backup', 'android', 'core',
  'aether-src', 'gst-src', 'graphify-out', 'cloud-web-panel', '.freebuff', 'tests']);

// How far after the spawn we are willing to look. Handlers are normally attached within a few
// lines; anything further away is worth a human deciding about anyway.
const WINDOW = 60;

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

const findings = [];

for (const file of walk(ROOT)) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (rel.startsWith('scripts/')) continue;                 // the checkers themselves
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  lines.forEach((line, i) => {
    // `x = spawn(...)`, `const x = spawn(...)`, `spawn(...)` with no binding at all.
    const m = line.match(/(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?spawn\s*\(/)
      || (/[^.\w]spawn\s*\(/.test(line) ? [null, null] : null);
    if (!m) return;

    const varName = m[1];
    const near = lines.slice(i, i + WINDOW).join('\n');

    if (!varName) {
      // Nothing to attach a listener to — the child is discarded. Fine only if it is detached
      // and unref'd, which we cannot tell from here, so report it.
      findings.push([rel, i + 1, 'spawn result is not bound to a variable — nothing can listen for its error', line.trim()]);
      return;
    }
    const re = new RegExp(varName.replace(/[$]/g, '\\$') + "\\s*\\.on\\s*\\(\\s*['\"]error['\"]");
    if (!re.test(near)) {
      findings.push([rel, i + 1, "no " + varName + ".on('error') within " + WINDOW + ' lines', line.trim()]);
    }
  });
}

if (findings.length) {
  console.error('Spawned children with no error listener:\n');
  for (const [f, ln, why, src] of findings) {
    console.error('  ' + f + ':' + ln);
    console.error('      ' + why);
    console.error('      ' + src.slice(0, 100));
    console.error('');
  }
  console.error("A failed spawn arrives as an 'error' EVENT, not an exception. With no listener,");
  console.error('Node re-throws it and the application exits.');
  process.exit(1);
}

console.log('every spawned child has an error listener');
