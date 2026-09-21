// --- «ام‌ال‌ام استور» — installing straight from the DEVELOPER's own release ---
//
// WHY THIS EXISTS. Every other core in this store is installed from the signed channel
// (store/channel.js): we test a version, sign it, and only then does the store offer it. That rule
// is what keeps a broken build from reaching anyone, and for the engines we BUILD ourselves it is
// the only honest option — a binary we compiled has no other anchor.
//
// Aether is not one of those. CluvexStudio publishes a Windows x86_64 build of every release from
// their own CI (`.github/workflows/release.yml` → `aether-windows-x86_64.zip`), and that archive is
// the engine this app ships. So for this core the developer's release IS the source of truth, and
// waiting for us to re-sign it means the user sits on an old core for no reason other than our
// release cadence.
//
// WHAT IS STILL CHECKED. «Direct» is not «unverified». The chain is:
//
//   1. the release list comes from the project's own repo, fixed in the catalogue — never from
//      anything a page said (store/upstream.js, which reads releases.atom, not the metered API);
//   2. the asset's SHA-256 is GITHUB's, computed at upload and read off the release page
//      (store/github.js), and store/net.js refuses a download whose hash does not match it;
//   3. the binary is then run and must report a version (store/cores.js › validate), and the new
//      version directory is ACL-locked like every other install;
//   4. one click rolls back to the version that was working.
//
// What is given up, and it is worth saying plainly: nobody has run this build against this app
// before the user does. That is the trade the user asked for — the developer's engine, untouched,
// as soon as they publish it — and it is why this is opt-in per item in the catalogue
// (`upstream.direct`) and not how the store behaves in general.
//
// CHEAP ON PURPOSE. Resolving a target needs the asset page, which is one more request than the
// release feed. It is cached on disk per tag — the assets of a published release do not change —
// and NEVER fetched on a request path: store-manager asks for what is cached, and the refresh runs
// in the background, exactly like store/upstream.js.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const github = require('./github');
const catalog = require('./catalog');
const versions = require('./versions');
const upstreamWatch = require('./upstream');

const CACHE_FILE = path.join(os.homedir(), '.mlmvpn', 'store', 'direct-cache.json');

let cache = read();
let running = false;

function read() {
    try {
        const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (j && typeof j === 'object' && j.items) return { items: j.items };
    } catch (e) { /* no cache yet */ }
    return { items: {} };
}

function write() {
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (e) { /* in-memory is still a cache */ }
}

/** Every core whose catalogue entry opted into installing the developer's own build. */
function tracked() {
    return catalog.CORES.filter((i) => i.upstream && i.upstream.type === 'github' && i.upstream.repo && i.upstream.direct);
}

/**
 * `{version}` and `{tag}` in an asset name, so a project that versions its files
 * (`sing-box-1.14.0-windows-amd64.zip`) is expressible without a second place to edit.
 */
function assetName(spec, version, tag) {
    return String(spec.asset).replace(/\{version\}/g, version).replace(/\{tag\}/g, tag);
}

/**
 * Turn one published release into the target shape `cores.install` takes.
 *
 * Refuses rather than guesses. An asset that is not on the page, or one GitHub published no digest
 * for (uploads predating their hashing), yields nothing at all: an install with no anchor is not
 * something this store offers, however new the version is.
 */
async function resolve(item, rel, opts = {}) {
    const spec = item.upstream.direct;
    const name = assetName(spec, rel.version, rel.tag);
    const found = await github.assets(item.upstream.repo, rel.tag, opts);
    const hit = found[name];
    if (!hit) throw new Error('فایل «' + name + '» در انتشار ' + rel.tag + ' نیست');
    if (!hit.sha256) throw new Error('گیت‌هاب برای «' + name + '» هشی منتشر نکرده است');
    return {
        version: rel.version,
        released: (rel.at || '').slice(0, 10),
        notes: spec.notes || '',
        tag: rel.tag,
        url: 'https://github.com/' + item.upstream.repo + '/releases/tag/' + encodeURIComponent(rel.tag),
        artifacts: [{
            name,
            format: spec.format || 'zip',
            extract: spec.extract,
            sha256: hit.sha256,
            urls: [hit.url],
            size: 0,
        }],
    };
}

/**
 * Resolve every opted-in core against what store/upstream.js last saw published.
 *
 * A release whose assets cannot be read is recorded as an error on that item and never throws: the
 * window then says «we know 2.1.0 exists, we could not read its files», which is the truth and is
 * more use than an empty panel.
 */
async function refresh({ force = false } = {}) {
    if (running) return status();
    running = true;
    try {
        for (const item of tracked()) {
            const rel = upstreamWatch.get(item.id);
            if (!rel || !rel.version || rel.pre) continue;
            const held = cache.items[item.id];
            if (!force && held && held.tag === rel.tag && held.artifacts) continue;
            try {
                const target = await resolve(item, rel, { timeoutMs: 60000 });
                cache.items[item.id] = Object.assign(target, { checkedAt: Date.now(), error: '' });
            } catch (e) {
                cache.items[item.id] = Object.assign({}, held || {}, {
                    checkedAt: Date.now(), error: e.message || String(e),
                });
            }
        }
        write();
    } finally {
        running = false;
    }
    return status();
}

/** Resolve in the background once the release watcher has something we have not priced yet. */
function maybeRefresh() {
    if (running) return;
    const stale = tracked().some((item) => {
        const rel = upstreamWatch.get(item.id);
        if (!rel || !rel.version || rel.pre) return false;
        const held = cache.items[item.id];
        return !held || held.tag !== rel.tag || !held.artifacts;
    });
    if (stale) refresh().catch(() => { /* the next read tries again */ });
}

/** The installable target for one item, or null. Never touches the network. */
function get(id) {
    const v = cache.items[id];
    if (!v || !v.version || !Array.isArray(v.artifacts) || !v.artifacts.length) return null;
    return Object.assign({}, v, { from: 'upstream' });
}

function error(id) {
    const v = cache.items[id];
    return (v && v.error) || '';
}

/**
 * The item's target, resolving RIGHT NOW if the cache has nothing for the release on offer.
 *
 * This is the install path's own lookup — the user pressed a button and is waiting, so here the
 * network is allowed. It also closes the gap where a release was seen seconds ago and the
 * background resolve has not finished.
 */
async function ensure(item, opts = {}) {
    const rel = upstreamWatch.get(item.id);
    if (!rel || !rel.version) return get(item.id);
    const held = cache.items[item.id];
    if (held && held.tag === rel.tag && Array.isArray(held.artifacts) && held.artifacts.length) return get(item.id);
    const target = await resolve(item, rel, Object.assign({ timeoutMs: 60000 }, opts));
    cache.items[item.id] = Object.assign(target, { checkedAt: Date.now(), error: '' });
    write();
    return get(item.id);
}

function status() {
    return { running, items: Object.keys(cache.items).length, tracked: tracked().length };
}

/** True when the developer's build is newer than what is installed. */
function isNewer(target, installed) {
    if (!target || !target.version) return false;
    return !installed || versions.compare(target.version, installed) === 1;
}

module.exports = { refresh, maybeRefresh, get, ensure, error, status, isNewer, resolve, tracked, assetName, CACHE_FILE };
