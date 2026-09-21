#!/usr/bin/env node
/*
 * dev-unpack.js — turn the portable build's app.asar back into a plain folder,
 * so dev-sync.js can drop changed source files straight into it.
 *
 * dev-sync.js has always said "run the one-time asar->folder conversion first"
 * without shipping it. This is it. It is not one-time in practice: every
 * `electron-builder` run writes a fresh app.asar and the folder has to be made
 * again.
 *
 *   node dev-unpack.js                 # dist/win-unpacked  (x64)
 *   node dev-unpack.js win-ia32-unpacked
 *
 * What it does, in order:
 *   1. extracts resources/app.asar into resources/app — @electron/asar pulls the
 *      asarUnpack'd files (core binaries, data) out of app.asar.unpacked itself,
 *      so the folder comes out complete;
 *   2. renames app.asar to app.asar.disabled, because Electron prefers app.asar
 *      over an app/ folder when both are there.
 *
 * Nothing is deleted: app.asar.disabled and app.asar.unpacked both stay, so the
 * build can be put back by renaming one file.
 *
 * WINDOWS WILL BLOCK THIS WHILE THE APP IS RUNNING — the .exe holds app.asar
 * open. Close MLM VPN (including the tray icon) first.
 */
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const ROOT = __dirname;
const build = process.argv[2] || 'win-unpacked';
const RES = path.join(ROOT, 'dist', build, 'resources');
const ASAR = path.join(RES, 'app.asar');
const APP = path.join(RES, 'app');
const DISABLED = path.join(RES, 'app.asar.disabled');

if (!fs.existsSync(RES)) {
  console.error('No such build:', RES);
  process.exit(1);
}

if (fs.existsSync(APP) && !fs.existsSync(ASAR)) {
  console.log('Already a folder build:', APP);
  console.log('Nothing to do — run `node dev-sync.js <files>`.');
  process.exit(0);
}

if (!fs.existsSync(ASAR)) {
  console.error('No app.asar and no app/ folder in', RES);
  process.exit(1);
}

// A leftover app/ from an older build would shadow this one file by file.
if (fs.existsSync(APP)) {
  console.log('Removing stale app/ …');
  fs.rmSync(APP, { recursive: true, force: true });
}

console.log('Extracting app.asar → app/  (this takes a minute)');
const t0 = Date.now();
asar.extractAll(ASAR, APP);
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

try {
  if (fs.existsSync(DISABLED)) fs.rmSync(DISABLED, { force: true });
  fs.renameSync(ASAR, DISABLED);
} catch (e) {
  console.error('\nCould not rename app.asar — is the app still running?');
  console.error(e.message);
  process.exit(1);
}

console.log('\nReady. Electron now loads from', APP);
console.log('Sync changes with:  node dev-sync.js <files…>');
