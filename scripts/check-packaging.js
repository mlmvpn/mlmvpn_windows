#!/usr/bin/env node
/*
 * Does the built app contain everything it requires?
 *
 *   node scripts/check-packaging.js
 *
 * `package.json` → `build.files` is an ALLOW-LIST. electron-builder packages what it names and
 * nothing else, so a module that is required at runtime but missing from that list is simply not
 * in the package — and the application crashes on `require()` when a user runs it, while working
 * perfectly from source on the machine of whoever added it.
 *
 * That has happened more than once (startup-health.js, openvpn-catalog.js), which is why this
 * runs in CI on every pull request as well as in tests/aether.
 *
 * It checks the real invariant — "everything something requires is packaged" — rather than
 * "every file at the top level is packaged", because build-time-only files (tailwind.config.js)
 * and files nothing imports are correctly absent.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);

const listed = new Set(
  (require('../package.json').build.files || []).filter((s) => typeof s === 'string')
);

/** Every tracked .js file, without shelling out to git — this also runs where git is absent. */
function jsFiles(dir, out) {
  out = out || [];
  const skip = new Set(['node_modules', '.git', 'dist', 'backup', 'android', 'core',
    'aether-src', 'gst-src', 'graphify-out', 'cloud-web-panel']);
  for (const name of fs.readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) jsFiles(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

// require('./x'), require('../x'), require('../../x') — the module name is what matters, because
// build.files names files at the top level.
const REQUIRE = /require\(\s*['"]\.[.\/]*\/([A-Za-z0-9_.-]+?)(?:\.js)?['"]\s*\)/g;

const required = new Map();          // module file → the first file that requires it
for (const file of jsFiles(ROOT)) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { continue; }
  let m;
  while ((m = REQUIRE.exec(src)) !== null) {
    const mod = m[1].endsWith('.json') ? m[1] : m[1] + '.js';
    if (!required.has(mod)) required.set(mod, path.relative(ROOT, file).replace(/\\/g, '/'));
  }
}

const missing = [];
for (const [mod, by] of required) {
  if (!fs.existsSync(path.join(ROOT, mod))) continue;   // not a top-level module
  if (listed.has(mod)) continue;
  missing.push({ mod, by });
}

if (missing.length) {
  console.error('Required at runtime but NOT in package.json build.files:\n');
  for (const { mod, by } of missing) console.error('  ' + mod + '   (required by ' + by + ')');
  console.error('\nbuild.files is an allow-list: an unlisted module is left out of the package');
  console.error('and crashes on require() when a user runs the built app.');
  process.exit(1);
}

console.log('every required top-level module is packaged (' + required.size + ' requires checked)');
