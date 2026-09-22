// --- Which copy of a core to run: the store's verified install, or the one the app shipped ---
//
// «ام‌ال‌ام استور» never writes into the app's own core/ directory, for two measured reasons:
//
//   * the PORTABLE build unpacks itself into a fresh temp directory on every launch, so a core
//     replaced in place is silently back to the old one the next time the app starts;
//   * the INSTALLED build keeps core/ under app.asar.unpacked in Program Files, which an upgrade
//     wipes — and a half-replaced executable there is a broken engine with nothing to roll back to.
//
// So every store install is its own directory — %ProgramData%\MLM VPN\store\cores\<id>\<version>\ —
// and this file decides, per start, whether an engine runs from there or from core/. A running
// engine is never touched: the new version is picked up the next time that engine starts, and the
// old directory stays until nothing needs it.
//
// THE RULES, and why each exists:
//
//   * A store install is used only when it is NEWER than what this build ships (store/shipped.js).
//     An app upgrade that brings a newer core must beat an older store install, not be shadowed by
//     it.
//   * The recorded directory must sit inside the store root, and every recorded file must still be
//     there at its recorded size. active.json is data; a record that points elsewhere, or a file
//     that has changed since it was verified, sends the engine back to core/.
//   * Nothing here executes anything or touches the network. It runs on the connect path, in
//     Electron's main thread — a few stat calls and a cached JSON read, nothing more.
//
// The directory itself is created with an ACL that lets only SYSTEM and Administrators write
// (store/cores.js › protectRoot). That matters more than any check here: these binaries are run by
// an elevated app, so a folder an ordinary user could write to would be a privilege escalation.
//
// MLMVPN_STORE_DISABLE=1 ignores the store entirely — the escape hatch for "is it the new core?".

'use strict';

const fs = require('fs');
const path = require('path');
const { SHIPPED } = require('./store/shipped');
const versions = require('./store/versions');

function storeRoot() {
    if (process.env.MLMVPN_STORE_ROOT) return path.resolve(process.env.MLMVPN_STORE_ROOT);
    const programData = process.env.ProgramData || process.env.ALLUSERSPROFILE || 'C:\\ProgramData';
    return path.join(programData, 'MLM VPN', 'store');
}

const activeFile = () => path.join(storeRoot(), 'active.json');

let cache = { file: '', mtimeMs: -1, size: -1, data: {} };

/** active.json, re-read only when it changes on disk. */
function readActive() {
    const file = activeFile();
    let st;
    try { st = fs.statSync(file); } catch (e) { return {}; }
    if (cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.data;
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        cache = { file, mtimeMs: st.mtimeMs, size: st.size, data: data && typeof data === 'object' ? data : {} };
    } catch (e) {
        cache = { file, mtimeMs: st.mtimeMs, size: st.size, data: {} };
    }
    return cache.data;
}

/** Is `dir` a real directory inside the store's area for `id`? */
function insideStore(id, dir) {
    const root = path.resolve(storeRoot(), 'cores', id) + path.sep;
    return path.resolve(dir).startsWith(root);
}

/** Does every file the record lists still exist at the size it was verified at? */
function intact(dir, files) {
    for (const rel of Object.keys(files)) {
        const meta = files[rel];
        if (!meta || typeof meta.size !== 'number') return false;
        try {
            if (fs.statSync(path.join(dir, rel)).size !== meta.size) return false;
        } catch (e) { return false; }
    }
    return true;
}

/**
 * The store install to run for `id`, or null. Checked on every call, never assumed.
 * `{ version, dir, files, previous }` — `previous` is the install it replaced, if any.
 */
function activeInstall(id) {
    if (process.env.MLMVPN_STORE_DISABLE === '1') return null;
    const rec = readActive()[id];
    if (!rec || !rec.version || !rec.dir || !rec.files || typeof rec.files !== 'object') return null;
    const shipped = SHIPPED[id];
    if (shipped && !versions.newer(rec.version, shipped.version)) return null;
    if (!insideStore(id, rec.dir)) return null;
    if (!intact(rec.dir, rec.files)) return null;
    return rec;
}

/**
 * A path to a file this build SHIPS — the one thing every engine needs and six of them got wrong.
 *
 * In the packaged app, `__dirname` is inside `app.asar`, and `core/` is not: electron-builder
 * unpacks it to `app.asar.unpacked/core/` because **Windows cannot execute a file inside an
 * archive**. So `path.join(__dirname, 'core', 'x.exe')` names a path that does not exist, and
 * spawning it fails with ENOENT.
 *
 * It is invisible during development, and that is why it shipped: from source, and in the
 * asar-to-folder test build (dev-unpack.js), `__dirname` is an ordinary directory with `core/`
 * right there, so the wrong path is the right path. Only the installer exposes it.
 *
 * 2026-09-22: that is exactly how «لنترن» closed the whole application on a user's machine —
 *   spawn C:\Program Files\MLM VPN\resources\app.asar\core\lantern.exe ENOENT
 * with سایفون, تور, وارپ, اوپن‌وی‌پی‌ان and گیت‌وی all one click from the same crash.
 *
 * Use this instead of building the path by hand. The test in tests/aether/packaging.test.js
 * fails the build if a manager goes back to a raw `__dirname`.
 */
function bundled(...segments) {
    // Idempotent on purpose: rewriting an already-unpacked path would give .asar.unpacked.unpacked.
    const root = /\.asar(?!\.unpacked)/i.test(__dirname)
        ? __dirname.replace(/\.asar(?!\.unpacked)/gi, '.asar.unpacked')
        : __dirname;
    return path.join(root, ...segments);
}

/** Directory holding `id`'s files: the active store install, else `bundledDir`. */
function dir(id, bundledDir) {
    const a = activeInstall(id);
    return a ? path.resolve(a.dir) : bundledDir;
}

/** One file of `id`: from the active store install when it carries that file, else `bundledPath`. */
function file(id, rel, bundledPath) {
    const a = activeInstall(id);
    return a && a.files[rel] ? path.join(path.resolve(a.dir), rel) : bundledPath;
}

/**
 * Every place `id`'s `rel` may be running from right now.
 *
 * For allow-lists — the kill switch permits engines by absolute path. An engine started before the
 * store switched versions is still running from the OLD directory, and a guard that only allowed the
 * new one would lock the live engine out of the internet: fail-closed turned into a permanent outage.
 */
function candidates(id, rel, bundledPath) {
    const out = [];
    const add = (p) => { if (p && out.indexOf(p) < 0) out.push(p); };
    const a = activeInstall(id);
    if (a && a.files[rel]) add(path.join(path.resolve(a.dir), rel));
    if (a && a.previous && a.previous.dir && insideStore(id, a.previous.dir)) {
        add(path.join(path.resolve(a.previous.dir), rel));
    }
    add(bundledPath);
    return out;
}

/** The version the next start of `id` will run, when the store is providing it; else null. */
function activeVersion(id) {
    const a = activeInstall(id);
    return a ? a.version : null;
}

module.exports = { storeRoot, activeFile, readActive, activeInstall, bundled, dir, file, candidates, activeVersion };
