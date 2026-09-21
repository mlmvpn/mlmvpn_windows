// --- «ام‌ال‌ام استور» — watching what the upstream projects publish ---
//
// WHY THIS EXISTS. The store only ever INSTALLS a version that has been tested and signed into the
// channel (store/channel.js) — that rule is what keeps a broken build from reaching anyone, and it
// stays. But until this file, the store also had no idea a developer had published anything: the
// «بررسی مخزن» button fetched a release list, showed it once, and forgot it. So a new Aether or a
// new Xray could sit on GitHub for weeks and nothing in the window would say so.
//
// This watches the releases of every core that is tracked on GitHub, remembers the newest one per
// item on disk, and hands it to the catalogue. What the window does with it is say so — never
// install it by itself.
//
// Cheap on purpose: `releases.atom` is a plain page, not the metered API (see store/github.js —
// api.github.com allows 60 requests an hour per IP, shared across a whole Iranian mobile NAT), and
// it goes through the same route ladder as every other store download (direct → system proxy →
// whichever engine is up), so it also works on a line where github.com is blocked.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const github = require('./github');
const catalog = require('./catalog');
const versions = require('./versions');

const CACHE_FILE = path.join(os.homedir(), '.mlmvpn', 'store', 'upstream-cache.json');

// Six hours. Releases are not a live feed and every check costs a request on a filtered line.
const TTL = 6 * 60 * 60 * 1000;

let cache = read();
let running = false;

function read() {
    try {
        const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (j && typeof j === 'object' && j.items) return { at: +j.at || 0, items: j.items };
    } catch (e) { /* no cache yet */ }
    return { at: 0, items: {} };
}

function write() {
    try {
        fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (e) { /* a cache that cannot be written is still a cache in memory */ }
}

/** The version inside a tag: `v2.0.0` → `2.0.0`, `geph5-client-v0.3.10` → `0.3.10` (item.tagRe). */
function versionOf(item, tag) {
    const re = item.upstream && item.upstream.tagRe ? new RegExp(item.upstream.tagRe) : null;
    const v = re ? ((String(tag).match(re) || [])[1] || '') : String(tag).replace(/^v/i, '');
    return /[0-9]/.test(v) ? v : '';
}

/** Every core whose project publishes releases on GitHub. */
function tracked() {
    return catalog.CORES.filter((i) => i.upstream && i.upstream.type === 'github' && i.upstream.repo);
}

/**
 * The newest release of one project.
 *
 * The feed is newest-first, but «newest» by date is not always the highest version — a project
 * that patches an old branch publishes an older number later. So versions are compared where they
 * can be, and the feed's own order is the fallback for tags that do not compare.
 */
function newestOf(item, rels) {
    const rows = rels
        .map((r) => ({ tag: r.tag, at: r.updated, version: versionOf(item, r.tag) }))
        .filter((r) => r.version);
    if (!rows.length) return null;
    let best = rows[0];
    for (const r of rows.slice(1)) {
        if (versions.compare(r.version, best.version) === 1) best = r;
    }
    // An alpha or a release candidate IS news — sing-box publishes them weekly — but it is not «a
    // new version to move to», so it is labelled rather than counted.
    best.pre = /alpha|beta|rc[-.\d]|preview|dev/i.test(best.tag + ' ' + best.version);
    return best;
}

/**
 * Read every tracked project's releases.
 *
 * One project failing (blocked line, renamed repo, a feed that did not parse) is recorded on that
 * item and never stops the others: a store that gives up on the first timeout tells the user
 * nothing about the nine projects that answered.
 */
async function refresh({ force = false } = {}) {
    if (running) return status();
    if (!force && Date.now() - cache.at < TTL) return status();
    running = true;
    let ok = 0;
    let failed = 0;
    try {
        for (const item of tracked()) {
            try {
                const rels = await github.releases(item.upstream.repo, { timeoutMs: 25000 });
                const best = newestOf(item, rels);
                if (!best) throw new Error('انتشاری با شمارهٔ نسخه پیدا نشد');
                cache.items[item.id] = {
                    repo: item.upstream.repo,
                    version: best.version,
                    tag: best.tag,
                    at: best.at,
                    pre: !!best.pre,
                    url: 'https://github.com/' + item.upstream.repo + '/releases/tag/' + encodeURIComponent(best.tag),
                    checkedAt: Date.now(),
                    error: '',
                };
                ok++;
            } catch (e) {
                const prev = cache.items[item.id] || {};
                // The last good answer is KEPT: «we could not check today» is not «there is nothing».
                cache.items[item.id] = Object.assign({}, prev, { checkedAt: Date.now(), error: e.message || String(e) });
                failed++;
            }
        }
        cache.at = Date.now();
        write();
    } finally {
        running = false;
    }
    return Object.assign(status(), { ok, failed });
}

/** Start a check in the background when the cache is stale. NEVER awaited by a request path. */
function maybeRefresh() {
    if (running || Date.now() - cache.at < TTL) return;
    refresh().catch(() => { /* the next catalogue read tries again */ });
}

/** Record what a manual «بررسی مخزن» just learned, so the badge follows the button. */
function note(id, row) {
    const item = catalog.BY_ID[id];
    if (!item || !row || !row.version) return;
    cache.items[id] = {
        repo: item.upstream.repo,
        version: row.version,
        tag: row.tag,
        at: row.at,
        pre: !!row.pre,
        url: 'https://github.com/' + item.upstream.repo + '/releases/tag/' + encodeURIComponent(row.tag),
        checkedAt: Date.now(),
        error: '',
    };
    write();
}

function get(id) {
    const v = cache.items[id];
    return v && v.version ? v : null;
}

function status() {
    return { at: cache.at, running, items: Object.keys(cache.items).length, tracked: tracked().length };
}

/**
 * Is what the developer published newer than BOTH what is installed and what has been tested?
 *
 * Both halves matter. Newer than the installed file alone would light up every item the channel
 * already offers an update for — the window would then say the same thing twice in two different
 * voices. This is only for the gap the store cannot close on its own.
 */
function isNewer(latest, installed, target) {
    if (!latest || !latest.version || latest.pre) return false;
    if (installed && versions.compare(latest.version, installed) !== 1) return false;
    if (target && target.version && versions.compare(latest.version, target.version) !== 1) return false;
    return !!installed || !!(target && target.version);
}

module.exports = { refresh, maybeRefresh, note, get, status, isNewer, newestOf, versionOf, CACHE_FILE, TTL };
