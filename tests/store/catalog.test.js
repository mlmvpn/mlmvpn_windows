// The catalogue is the store's whole idea of the world: what exists, how to recognise it, what is
// vouched for. A mistake here is not a crash — it is the store touching the wrong thing, or
// offering an update with nothing behind it.
const fs = require('fs');
const path = require('path');
const catalog = require('../../store/catalog');
const trust = require('../../store/trust');
const versions = require('../../store/versions');
const { SHIPPED } = require('../../store/shipped');
const workers = require('../../store/workers');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── cores ────────────────────────────────────────────────────────────────────
for (const item of catalog.CORES) {
    t(item.id + ': the app knows what it ships', !!SHIPPED[item.id], 'missing from store/shipped.js');
    t(item.id + ': names the files an install must contain', Array.isArray(item.files) && item.files.length > 0);
    if (item.probe) {
        t(item.id + ': its probe names a file the item has', item.files.indexOf(item.probe.file) >= 0,
            item.probe.file + ' not in ' + item.files.join(', '));
    }
    if (item.pin) {
        for (const a of item.pin.artifacts) {
            t(item.id + ': the pinned artifact carries a real digest', trust.isSha256(a.sha256), a.sha256);
            t(item.id + ': the pinned artifact has somewhere to come from', Array.isArray(a.urls) && a.urls.length > 0);
            t(item.id + ': every file the item needs is produced by the pin',
                item.files.every((f) => Object.values(a.extract || {}).indexOf(f) >= 0
                    || (item.companions || []).some((c) => c.rel === f) || a.dest === f || (a.format === 'raw' && a.name === f)),
                item.files.join(', ') + ' vs ' + JSON.stringify(a.extract));
            t(item.id + ': the pin is newer than what is shipped, or it is pointless',
                !SHIPPED[item.id] || versions.compare(item.pin.version, SHIPPED[item.id].version) >= 0,
                item.pin.version + ' vs shipped ' + (SHIPPED[item.id] ? SHIPPED[item.id].version : '(not shipped)'));
        }
    }
}

// ── every shipped file is really there, at the size and digest recorded ──────
// This is the table the resolver trusts to decide "is a store install newer than the app's own
// copy", so it going stale is exactly how an update would be silently ignored.
const CORE_DIR = path.join(__dirname, '..', '..', 'core');
const crypto = require('crypto');
for (const [id, rec] of Object.entries(SHIPPED)) {
    for (const [rel, want] of Object.entries(rec.files)) {
        const file = path.join(CORE_DIR, rec.dir || '', rel);
        if (!fs.existsSync(file)) { t(id + '/' + rel + ' exists in core/', false, file); continue; }
        const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        t(id + '/' + rel + ' matches the digest in store/shipped.js', got === want, 'on disk: ' + got);
    }
}

// ── workers: fingerprints must match their own source and nothing else ──────
const WORKER_SOURCES = {};
for (const item of catalog.WORKERS) {
    if (!item.bundled) continue;
    const file = catalog.appFile(item.bundled.file);
    if (!fs.existsSync(file)) { t(item.id + ': its bundled source ships with the app', false, file); continue; }
    WORKER_SOURCES[item.id] = fs.readFileSync(file, 'utf8');
    t(item.id + ': its bundled source ships with the app', true);
}

for (const [id, src] of Object.entries(WORKER_SOURCES)) {
    const item = catalog.BY_ID[id];
    t(id + ': recognises its own code', item.detect(src));
    const v = item.versionOf(src);
    t(id + ': reads its own version out of that code (' + v + ')',
        v === item.bundled.version || String(v) === String(item.bundled.version),
        'source says ' + v + ', catalogue says ' + item.bundled.version);
    // and must not claim anyone else's
    for (const [otherId, otherSrc] of Object.entries(WORKER_SOURCES)) {
        if (otherId === id) continue;
        t(id + ' does not mistake ' + otherId + ' for itself', !item.detect(otherSrc));
    }
}

// classify() picks the right one out of the whole list.
for (const [id, src] of Object.entries(WORKER_SOURCES)) {
    const hit = workers.classify(src);
    t('classify(' + id + ') → ' + (hit && hit.item.id), !!hit && hit.item.id === id);
}
t('classify ignores code that is not ours', workers.classify('export default { async fetch(){ return new Response("hi") } }') === null);
t('classify ignores an empty body', workers.classify('') === null);

// A worker with a pinned version must have a digest for it — the same rule as the cores.
for (const item of catalog.WORKERS) {
    if (!item.pin) continue;
    for (const a of item.pin.artifacts) {
        t(item.id + ': pinned worker code has a digest', trust.isSha256(a.sha256));
        t(item.id + ': pinned worker code has a URL', !!(a.urls && a.urls.length));
        t(item.id + ': the pinned URL is immutable (a commit, not a branch)',
            a.urls.every((u) => !/\/(main|master|HEAD)\//.test(u)), a.urls.join(' '));
    }
}

// Android-deployed kinds are detect-only: no bundled source, and the store must never offer them.
for (const item of catalog.WORKERS.filter((w) => w.managedBy === 'android')) {
    t(item.id + ': is marked as the Android app\'s to manage', !item.bundled && !item.pin);
}

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
