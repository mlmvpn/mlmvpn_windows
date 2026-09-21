#!/usr/bin/env node
/*
 * dev-sync.js — copy changed source files into the portable test build
 * (dist/win-unpacked/resources/app) WITHOUT rebuilding.
 *
 * The portable build was converted from app.asar to a plain `app/` folder
 * (app.asar -> app.asar.disabled), so Electron loads files straight from disk.
 * That means a simple file copy is enough to test a change.
 *
 * Usage:
 *   node dev-sync.js                       # sync default set (public/ + root *.js)
 *   node dev-sync.js public/components/cloud.js [more files...]
 *   node dev-sync.js --build=win-ia32-unpacked main.js   # the 32-bit test build
 *
 * Paths are relative to the project root.
 */
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
// --build=win-ia32-unpacked syncs the 32-bit test build instead. Both exist after a full
// electron-builder run, and the 32-bit one is the build most of the "black window" reports
// come from, so it is the one that most needs testing.
const buildArg = (process.argv.find((a) => a.startsWith("--build=")) || "").slice(8);
const BUILD = buildArg || "win-unpacked";
const DEST = path.join(ROOT, "dist", BUILD, "resources", "app");

if (!fs.existsSync(DEST)) {
  console.error("Portable app folder not found:", DEST);
  console.error("Run the one-time asar->folder conversion first.");
  process.exit(1);
}

function copyRecursive(relSrc) {
  const abs = path.join(ROOT, relSrc);
  if (!fs.existsSync(abs)) {
    console.warn("skip (missing):", relSrc);
    return 0;
  }
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    let n = 0;
    for (const entry of fs.readdirSync(abs)) {
      n += copyRecursive(path.join(relSrc, entry));
    }
    return n;
  }
  const dest = path.join(DEST, relSrc);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  console.log("synced:", relSrc);
  return 1;
}

// Default set kept intentionally small (UI + main-process JS).
const DEFAULT_TARGETS = ["public", "main.js"];

const targets = process.argv.slice(2).filter((a) => !a.startsWith("--build="));
const list = targets.length ? targets : DEFAULT_TARGETS;

let total = 0;
for (const t of list) total += copyRecursive(t.replace(/\\/g, "/"));
console.log(`\nDone. ${total} file(s) synced to ${BUILD}.`);
