#!/usr/bin/env node
/*
 * Parses every JavaScript file in the tree, and validates every JSON file.
 *
 *   node scripts/check-syntax.js
 *
 * Cheap, and it catches the damage that is embarrassing rather than interesting: a stray merge
 * marker, a half-saved file, a trailing comma in a config.
 *
 * A file is accepted if it parses as EITHER CommonJS or an ES module. Both live here: the
 * application is CommonJS, and the Cloudflare Workers under public/ and cloudflare-worker/ are
 * ES modules (`export default { fetch() {} }`). Checking each one only as CommonJS reports the
 * Workers as broken, which is how this script came to exist.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

/**
 * The file list. git's is preferred because it is exactly what CI sees — .gitignore'd scratch
 * (a zero-byte t.json, a local config) is not the repository's problem. The walk is the fallback
 * for a tree that was downloaded rather than cloned.
 */
function tracked() {
  try {
    return execFileSync('git', ['ls-files', '*.js', '*.json'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean)
      .filter((f) => !f.startsWith('node_modules/'))
      .map((f) => path.join(ROOT, f));
  } catch (e) {
    return walk(ROOT);
  }
}
const SKIP = new Set(['node_modules', '.git', 'dist', 'backup', 'android', 'core',
  'aether-src', 'gst-src', 'graphify-out', 'cloud-web-panel', '.freebuff']);

function walk(dir, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    let st;
    try { st = fs.statSync(p); } catch (e) { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.js') || name.endsWith('.json')) out.push(p);
  }
  return out;
}

/** node --check, first as CommonJS and then as an ES module. Returns null when it parses. */
function parses(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (cjs) {
    try {
      execFileSync(process.execPath, ['--check', '--input-type=module'],
        { input: fs.readFileSync(file), stdio: 'pipe' });
      return null;                                   // a Worker or other ES module
    } catch (esm) {
      return String(cjs.stderr || cjs.message).split('\n').slice(0, 3).join(' ').trim();
    }
  }
}

let js = 0, json = 0;
const bad = [];

for (const file of tracked()) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  if (file.endsWith('.json')) {
    json++;
    try { JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); }
    catch (e) { bad.push([rel, e.message.split('\n')[0]]); }
  } else {
    js++;
    const err = parses(file);
    if (err) bad.push([rel, err]);
  }
}

if (bad.length) {
  console.error('Files that do not parse:\n');
  for (const [f, why] of bad) console.error('  ' + f + '\n      ' + why);
  process.exit(1);
}

console.log(js + ' JavaScript and ' + json + ' JSON files all parse');
