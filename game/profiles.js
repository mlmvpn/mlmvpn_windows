// --- Route profiles ---
//
// The point of the whole feature, stored: "for THIS user, THIS ISP, THIS game and THIS
// destination, at THIS time of day, here is what was actually measured."
//
// THE KEY IS THE DESIGN
//   game      obvious
//   isp       from the public IP's operator, not from the adapter — two people on the same
//             Wi-Fi can be on different ISPs via different modems, and the international
//             route belongs to the operator
//   region    the destination's region, not a single server IP: game servers are replaced
//             constantly and a profile pinned to an IP is dead within weeks
//   hour      four buckets. Iranian international congestion changes on a daily cycle, so
//             a profile that averages 3am and 10pm is the average of two different networks
//             and describes neither
//
// EVERY PROFILE EXPIRES. The route between an Iranian ISP and Frankfurt is renegotiated,
// rerouted and re-congested on a scale of days. A three-week-old recommendation is worse
// than no recommendation, because the user trusts it.
//
// SHARING IS DESIGNED FOR, NOT BUILT YET. `exportable()` produces the anonymous shape that
// could one day be pooled — no IP, no machine id, no game server address, just
// (isp, region, hour) → statistics. The rule it must obey when that day comes: the client
// keeps working, unchanged, when the pool is unreachable. It is an optimisation, never a
// dependency.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.mlmvpn', 'game-profiles.json');
const TTL_MS = 7 * 24 * 60 * 60 * 1000;    // a week; anything older is misinformation
const MAX_ENTRIES = 400;

let cache = null;

/**
 * Where the store lives.
 *
 * Redirectable ONLY so the suite can exercise the real read/write path against a throwaway
 * file. The alternative — patching the module's constant from a test — is the mistake the
 * evidence suite already made once: `read()` closed over the const, the patch did nothing,
 * and every assertion silently ran against this machine's real data and "passed" for the
 * wrong reason. Nothing in the app calls this.
 */
let activeFile = FILE;
function useFileForTests(p) { activeFile = p || FILE; cache = null; }

function load() {
    if (cache) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
        cache = raw && typeof raw === 'object' ? raw : { v: 1, items: {} };
    } catch { cache = { v: 1, items: {} }; }
    if (!cache.items) cache.items = {};
    return cache;
}

function save() {
    if (!cache) return;
    try {
        fs.mkdirSync(path.dirname(activeFile), { recursive: true });
        fs.writeFileSync(activeFile, JSON.stringify(cache), 'utf8');
    } catch { /* a profile that cannot be written is not worth an error to the user */ }
}

/** Four buckets, chosen around when Iranian international links are actually congested. */
function hourBucket(d = new Date()) {
    const h = d.getHours();
    if (h >= 2 && h < 9) return 'dawn';      // سحر — quietest
    if (h >= 9 && h < 16) return 'day';      // روز
    if (h >= 16 && h < 20) return 'evening'; // بعدازظهر
    return 'peak';                            // اوج شب
}

const BUCKET_FA = { dawn: 'سحر (۲ تا ۹)', day: 'روز (۹ تا ۱۶)', evening: 'بعدازظهر (۱۶ تا ۲۰)', peak: 'اوج شب (۲۰ تا ۲)' };

function keyFor({ gameId, isp, region, bucket }) {
    return [gameId || '?', (isp || '?').replace(/\s+/g, '_'), region || '?', bucket || hourBucket()].join('|');
}

/**
 * Record one assessment.
 *
 * Only the numbers are kept, never the raw sample series — a series is tens of kilobytes
 * and its only consumer is the chart that was already drawn.
 */
function record(report, { isp } = {}) {
    if (!report || !report.results) return null;
    const store = load();
    const bucket = hourBucket();
    const written = [];

    const primaryKeys = Object.keys(report.results).filter(k => k === 'game' || k.startsWith('live'));
    const anchorKeys = Object.keys(report.results).filter(k => k.startsWith('anchor:'));

    const put = (region, path_, r) => {
        if (!r || !r.ok) return;
        const k = keyFor({ gameId: report.game.id, isp, region, bucket });
        const item = store.items[k] || { key: k, gameId: report.game.id, isp: isp || null, region, bucket, paths: {}, at: 0 };
        item.paths[path_] = {
            min: r.min, p50: r.p50, p95: r.p95, p99: r.p99,
            jitter: r.jitter, spread: r.spread, loss: r.loss,
            spikes: r.spikes, spikePct: r.spikePct, score: r.score,
            n: r.n, proto: r.proto, correlation: r.correlation, label: r.label,
        };
        item.at = Date.now();
        item.verdict = report.verdict ? { code: report.verdict.code, detour: report.verdict.detour } : null;
        store.items[k] = item;
        written.push(k);
    };

    for (const k of primaryKeys) put('game', 'direct', report.results[k]);
    for (const k of anchorKeys) {
        const r = report.results[k];
        const target = (report.targets || []).find(t => t.key === k);
        put(target && target.region ? target.region : 'unknown', 'direct:' + k.replace('anchor:', ''), r);
    }
    for (const e of report.engines || []) {
        if (e.available && e.result && e.result.ok) put('anchor-udp', 'engine:' + e.id, e.result);
    }

    prune(store);
    save();
    return { keys: written, bucket };
}

/**
 * Record one ENGINE TOURNAMENT.
 *
 * WHY THIS EXISTS SEPARATELY
 * `record()` above understands the shape of an assessment: `results` keyed by target, plus
 * an `engines` array. A tournament report is a different animal — one shared anchor, a
 * `direct` control and a `ranked` list — so it fell straight through and was never stored.
 * The consequence was absurd and was caught the moment the two features met: seconds after
 * the tournament finished measuring every engine the app has, the boost button still said
 * «هنوز اندازه‌گیری نشده» and offered no opinion, because the only thing it reads is this
 * store.
 *
 * KEYED BY FAMILY, NOT BY VARIANT. `boost.evaluate()` asks "is Aether good for this game",
 * and it has to be able to answer that after a race between six Aether variants. So the
 * best-scoring variant of each family is what lands under `engine:aether` — the same key an
 * assessment writes, which is what lets the two features share one memory.
 *
 * Region is 'anchor-udp': everything here was measured against the same UDP anchor, and
 * pretending it says something about the game's own region would be a lie the profile store
 * would repeat for a week.
 */
function recordTournament(report, { isp } = {}) {
    if (!report || !Array.isArray(report.ranked)) return null;
    const store = load();
    const bucket = hourBucket();
    const k = keyFor({ gameId: report.gameId, isp, region: 'anchor-udp', bucket });
    const item = store.items[k]
        || { key: k, gameId: report.gameId, isp: isp || null, region: 'anchor-udp', bucket, paths: {}, at: 0 };

    const familyOf = (id) => (
        !id ? null
            : id.startsWith('aether') ? 'aether'
                : id.startsWith('v2ray') ? 'v2ray'
                    : id.startsWith('github-tunnel') ? 'github-tunnel'
                        : id === 'direct' ? 'direct' : null);

    const shape = (r) => ({
        min: r.min, p50: r.p50, p95: r.p95, p99: r.p99,
        jitter: r.jitter, spread: r.spread, loss: r.loss,
        spikes: r.spikes, spikePct: r.spikePct, score: r.score,
        n: r.n, proto: r.proto, correlation: r.correlation, label: r.fa,
        // Kept so a later reader can tell a whole-field race from a single measurement —
        // and so the winning VARIANT is not lost just because the key is the family.
        via: r.id, from: 'tournament',
    });

    for (const row of report.ranked) {
        if (!row || !row.ok) continue;
        const family = familyOf(row.id);
        if (!family) continue;
        const path_ = family === 'direct' ? 'direct' : 'engine:' + family;
        const prev = item.paths[path_];
        // Best of the family wins the slot: a race between six Aether variants should teach
        // the button what Aether can do at its best, not what its worst protocol did.
        if (prev && (prev.score || 0) >= (row.score || 0) && prev.from === 'tournament') continue;
        item.paths[path_] = shape(row);
    }

    item.at = Date.now();
    item.verdict = report.verdict ? { code: report.verdict.code, detour: null } : null;
    store.items[k] = item;
    prune(store);
    save();
    return { keys: [k], bucket };
}

function prune(store) {
    const now = Date.now();
    const entries = Object.entries(store.items);
    for (const [k, v] of entries) if (now - (v.at || 0) > TTL_MS) delete store.items[k];
    const left = Object.entries(store.items);
    if (left.length > MAX_ENTRIES) {
        left.sort((a, b) => (a[1].at || 0) - (b[1].at || 0));
        for (const [k] of left.slice(0, left.length - MAX_ENTRIES)) delete store.items[k];
    }
}

/** Everything known about one game, freshest first, with age so the UI can distrust it. */
function forGame(gameId) {
    const store = load();
    prune(store);
    const now = Date.now();
    return Object.values(store.items)
        .filter(i => i.gameId === gameId)
        .map(i => ({ ...i, ageMs: now - i.at, bucketFa: BUCKET_FA[i.bucket] || i.bucket }))
        .sort((a, b) => b.at - a.at);
}

function all() {
    const store = load();
    prune(store);
    const now = Date.now();
    return Object.values(store.items)
        .map(i => ({ ...i, ageMs: now - i.at, bucketFa: BUCKET_FA[i.bucket] || i.bucket }))
        .sort((a, b) => b.at - a.at);
}

function clear() {
    cache = { v: 1, items: {} };
    save();
}

/**
 * The anonymous shape that could be pooled across users one day.
 * Deliberately drops: the public IP, any machine identifier, the game server address, and
 * the raw timestamps (only the bucket survives).
 */
function exportable() {
    return all().map(i => ({
        game: i.gameId, isp: i.isp || null, region: i.region, bucket: i.bucket,
        paths: Object.fromEntries(Object.entries(i.paths).map(([p, v]) => [p, {
            min: v.min, p95: v.p95, jitter: v.jitter, loss: v.loss, score: v.score, n: v.n,
        }])),
        verdict: i.verdict ? i.verdict.code : null,
    }));
}

module.exports = { record, recordTournament, forGame, all, clear, exportable, hourBucket, BUCKET_FA, FILE, useFileForTests };
