// --- «ام‌ال‌ام استور» — the signed channel: new versions without a new build of the app ---
//
// The app ships with a pinned version per item (store/catalog.js). That is enough to update the
// cores it already knows about, but it freezes the moment the build is released: an engine that
// rots next month needs an app release to fix, which is the exact problem the store exists to end.
//
// So there is one more input: a small signed file. It carries, per item, the version this project
// has TESTED, where to get it and its SHA-256. It is signed with a key whose private half never
// leaves the maintainer's machine (store/trust.js), so it does not matter which mirror it came
// through, and a compromised GitHub account cannot make the app install anything.
//
// It can only ever move numbers and URLs. Everything about HOW an item is installed, validated and
// rolled back lives in code that the channel cannot touch.
//
// Failing to fetch it is not an error: the app's own pins still work, and the store says when it
// last managed to look.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const corePaths = require('../core-paths');
const trust = require('./trust');
const netio = require('./net');
const versions = require('./versions');

const URLS = [
    'https://github.com/mlmvpn/mlmvpn_windows/releases/download/store-channel/store-channel.json',
    'https://raw.githubusercontent.com/mlmvpn/mlmvpn_windows/store-channel/store-channel.json',
];

const cacheFile = () => path.join(corePaths.storeRoot(), 'channel.json');

let memory = null;         // { manifest, fetchedAt, source }
let lastError = '';

function appVersion() {
    try { return require('../package.json').version; } catch (e) { return '0.0.0'; }
}

/** Read the cached envelope, verifying it again — a file on disk is not evidence of anything. */
function loadCached() {
    if (memory) return memory;
    try {
        const raw = fs.readFileSync(cacheFile(), 'utf8');
        const manifest = trust.openEnvelope(raw);
        let fetchedAt = 0;
        try { fetchedAt = fs.statSync(cacheFile()).mtimeMs; } catch (e) { fetchedAt = 0; }
        memory = { manifest, fetchedAt, source: 'cache' };
    } catch (e) {
        memory = null;
        if (fs.existsSync(cacheFile())) lastError = e.message;
    }
    return memory;
}

/**
 * Fetch and verify the channel. Refuses to go backwards: a manifest with a lower sequence than the
 * one already held is a replay of an older, still-validly-signed file, and is dropped.
 */
async function refresh({ force = false, maxAgeMs = 6 * 3600 * 1000 } = {}) {
    const held = loadCached();
    if (!force && held && Date.now() - held.fetchedAt < maxAgeMs) return held;

    let raw = null, source = '';
    let err = null;
    for (const url of URLS) {
        try {
            const r = await netio.fetchText(url, { timeoutMs: 25000, maxBytes: 2 * 1024 * 1024 });
            raw = r.text; source = r.route;
            break;
        } catch (e) { err = e; }
    }
    if (raw == null) {
        lastError = (err && err.message) || 'کانال در دسترس نبود';
        return held;
    }

    let manifest;
    try { manifest = trust.openEnvelope(raw); } catch (e) {
        lastError = e.message;
        return held;
    }
    if (held && held.manifest && manifest.sequence < held.manifest.sequence) {
        lastError = 'نسخهٔ قدیمی‌تری از فایل کانال آمد و پذیرفته نشد.';
        return held;
    }
    if (manifest.minApp && versions.compare(appVersion(), manifest.minApp) === -1) {
        lastError = 'این کانال به نسخهٔ ' + manifest.minApp + ' برنامه یا بالاتر نیاز دارد.';
        return held;
    }

    memory = { manifest, fetchedAt: Date.now(), source };
    lastError = '';
    try {
        await fsp.mkdir(path.dirname(cacheFile()), { recursive: true });
        await fsp.writeFile(cacheFile(), raw);
    } catch (e) { /* not elevated, or read-only: the manifest still works for this run */ }
    return memory;
}

/** The channel's entry for one item, or null. */
function pin(id) {
    const held = loadCached();
    const item = held && held.manifest && held.manifest.items && held.manifest.items[id];
    if (!item || !item.version) return null;
    return Object.assign({ from: 'channel' }, item);
}

function status() {
    const held = loadCached();
    return {
        have: !!held,
        sequence: held ? held.manifest.sequence : null,
        issuedAt: held ? held.manifest.issuedAt || '' : '',
        fetchedAt: held ? held.fetchedAt : 0,
        source: held ? held.source : '',
        error: lastError,
        items: held ? Object.keys(held.manifest.items || {}).length : 0,
    };
}

/** Tests and the maintainer's tooling load a manifest from a file instead of the network. */
function useEnvelope(raw, { source = 'local' } = {}) {
    const manifest = trust.openEnvelope(raw);
    memory = { manifest, fetchedAt: Date.now(), source };
    return memory;
}

module.exports = { refresh, pin, status, useEnvelope, URLS, loadCached };
