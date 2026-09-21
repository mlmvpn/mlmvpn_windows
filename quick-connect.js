/**
 * «اتصال سریع» — a ready-to-use server pool with a country picker and one-tap connect.
 *
 * What this module owns:
 *   • fetching and caching public share-link feeds, merged and de-duplicated
 *   • giving every node a country (see geo-label.js) so the UI can group by flag
 *   • finding a working node — the two-stage TCP→real-request funnel from free-configs.js
 *   • verifying, after connecting, where traffic ACTUALLY leaves
 *
 * What it does not own: the connection itself. Starting Xray, the system proxy and the
 * full tunnel already have one correct implementation each in xray-manager / tun-manager,
 * reached through the same /api/v2ray/* routes the nodes tab uses. Re-implementing any of
 * them here would mean two code paths that can disagree about whether the machine is
 * protected, which is the one bug class this app cannot afford.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const { gtFetch } = require('./github-tunnel/gt-net');
const geo = require('./geo-label');
const freeConfigs = require('./free-configs');
const xrayTester = require('./xray-tester');

// ── sources ─────────────────────────────────────────────────────────────────────────────
//
// Two feeds, on purpose. The first is large and carries a country label on almost every
// entry, which is what makes a location picker possible at all. The second is small but
// pre-verified from a vantage point outside Iran, so it seeds the list with nodes that are
// more likely to answer. Either one alone is a single point of failure; together, one
// source being down or filtered still leaves a usable list.
const SOURCES = [
    {
        id: 'global',
        title: 'مخزن جهانی',
        url: 'https://raw.githubusercontent.com/iampedii/whitedns-sub/refs/heads/main/base64.txt',
        mirror: 'https://cdn.jsdelivr.net/gh/iampedii/whitedns-sub@main/base64.txt',
        format: 'base64',
    },
    {
        id: 'verified',
        title: 'تأییدشده',
        pool: 'verified',          // served by free-configs.js, already parsed and de-duped
    },
];

const CACHE_DIR = path.join(os.homedir(), '.mlmvpn');
const CACHE_FILE = path.join(CACHE_DIR, 'quick-servers.json');
// Bumped whenever the shape of a cached node changes — OR WHEN THE SET DOES. Without it, an
// upgrade keeps serving yesterday's file for up to half an hour and the user sees rows built
// by the old code.
//
// 3: `parseVlessUri` now rejects plaintext vless to a public address, which the core refuses to
// build. `toEntries` drops those at feed-parse time, so a cache written before this fix still
// holds ~150 entries that cannot work — they would keep filling country rows and consuming
// delay-test slots until it expired.
const CACHE_VERSION = 3;

// Matches the refresh cadence of the upstream feeds. Re-downloading megabytes because the
// user reopened a panel helps nobody, and a list this size does not go stale in minutes.
const TTL_MS = 30 * 60 * 1000;

const BRAND = '@mlmvpn';

let memory = null;          // { at, nodes, sources }
let loading = null;         // in-flight promise, so two panels opening at once fetch once

// ── feed parsing ────────────────────────────────────────────────────────────────────────

async function fetchText(url, mirror) {
    const attempts = [url, mirror].filter(Boolean);
    let lastErr = null;
    for (const target of attempts) {
        try {
            const r = await gtFetch(target, { timeoutMs: 30000 });
            if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
            return await r.text();
        } catch (e) { lastErr = e; }
    }
    throw new Error(lastErr ? lastErr.message : 'دریافت نشد');
}

/** Feeds ship either raw links or one big base64 blob; accept both without being told. */
function decodeFeed(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return [];
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed.split(/\r?\n/);
    try {
        const decoded = Buffer.from(trimmed.replace(/\s+/g, ''), 'base64').toString('utf8');
        if (/:\/\//.test(decoded)) return decoded.split(/\r?\n/);
    } catch (e) { /* not base64 after all */ }
    return trimmed.split(/\r?\n/);
}

/** The remark a feed puts after `#`, with any foreign channel handle replaced by ours. */
function remarkOf(uri) {
    const hash = uri.indexOf('#');
    if (hash === -1) return '';
    let raw;
    try { raw = decodeURIComponent(uri.slice(hash + 1)).trim(); }
    catch (e) { raw = uri.slice(hash + 1).trim(); }
    return raw.replace(/@[A-Za-z0-9_]{2,}/g, BRAND);
}

function withRemark(uri, remark) {
    const hash = uri.indexOf('#');
    const base = hash === -1 ? uri : uri.slice(0, hash);
    return `${base}#${encodeURIComponent(remark)}`;
}

/**
 * A short, honest name for one node.
 *
 * Feed remarks are built for a different audience: «🇳🇱 | @Channel | NL1|31.4MB/s|GPT-NL|
 * GM-NL|CL-NL|SP-NL» is eight fields of provider bookkeeping. None of it survives into the
 * list — the country is shown as a flag column, and what is left is a stable per-node tag
 * so two servers in the same country are still tellable apart.
 */
function endpointTag(host, port, used) {
    // FNV-1a over the endpoint, rendered base36. Derived from the address rather than the
    // position, so a server keeps the same tag between refreshes even when the feed reorders
    // itself — which is what lets a user say "I was on K3P9" and mean something.
    //
    // The width matters more than it looks. A previous version used `hash % 900`, giving 900
    // tags per country against 473 Canadian servers: measured on the live feed, 1424 servers
    // shared a name with at least one other and a single tag was worn by twenty different
    // machines. 36^4 is 1.68 million, and the loop below closes the remainder.
    const key = `${host}:${port}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    for (let salt = 0; salt < 64; salt++) {
        let v = h;
        if (salt) {
            v ^= salt;
            v = Math.imul(v, 0x01000193) >>> 0;
        }
        const tag = (v % 1679616).toString(36).toUpperCase().padStart(4, '0');
        if (!used || !used.has(tag)) {
            if (used) used.add(tag);
            return tag;
        }
    }
    return (h % 1679616).toString(36).toUpperCase().padStart(4, '0');
}

/** The label a row shows: country prefix plus the endpoint's own tag. */
function composeName(code, tag) {
    return `${code || 'XX'}-${tag}`;
}

/**
 * Turn a list of share links into runnable, country-tagged entries.
 *
 * Parsing IS the filter. `parseVlessUri` rejects protocols the core cannot speak, transports
 * it removed, ciphers it does not implement and malformed REALITY parameters — every one of
 * which is fatal to the WHOLE Xray config rather than to the single node, so none of them
 * may ever reach the tester.
 */
function toEntries(uris, sourceId, seen, stats, usedTags) {
    const { parseVlessUri } = require('./xray-manager');
    const out = [];

    for (const raw of uris) {
        const uri = String(raw || '').trim();
        if (!uri || uri.startsWith('#')) continue;

        let outbound;
        try { outbound = parseVlessUri(uri); }
        catch (e) { stats.unusable++; continue; }

        const key = freeConfigs.endpointKey(outbound);
        if (seen.has(key)) { stats.duplicate++; continue; }
        seen.add(key);

        const s = outbound.settings || {};
        const v = (s.vnext && s.vnext[0]) || (s.servers && s.servers[0]) || {};
        const host = v.address;
        const port = v.port;
        if (!host || !port) { stats.unusable++; continue; }

        const remark = remarkOf(uri);
        // The host is included in the search text on purpose: plenty of feeds carry no
        // remark at all but use names like `de-fra-01.example.net`.
        const country = geo.countryFromText([remark, host]);
        const tag = endpointTag(host, port, usedTags);
        const name = composeName(country ? country.code : null, tag);

        out.push({
            id: key,
            uri: withRemark(uri, country ? `${country.flag} ${country.name} · ${name}` : name),
            protocol: outbound.protocol,
            host,
            port,
            tag,
            name,
            country: country ? country.code : null,
            flag: country ? country.flag : null,
            countryName: country ? country.name : null,
            source: sourceId,
        });
    }
    return out;
}

// ── measured countries beat claimed ones ────────────────────────────────────────────────
//
// A node's flag is whatever the feed decided to call it. Once the traffic has actually gone
// through it, we know better: the trace reports the country the far end really sees. When
// the two disagree — the feed says Germany, the exit is Sweden — the measurement wins, and
// it is remembered.
//
// Why persist rather than just fix the label on screen: the reason to pick a country is to
// come out in it. A node filed under the wrong flag is not a cosmetic problem, it is the
// list lying about the one thing it is for. So a verified node moves into its real country
// for good — it shows up when that country is picked, and stops showing up under the one it
// was falsely claiming.
//
// Only trustworthy readings are stored:
//   • `countryTrusted` must hold — WARP reports the USER's country by design, so a WARP
//     path would file every node under Iran.
//   • the reading must belong to the node that was actually connected at the time.
//
// Entries expire: server addresses get reassigned, and a year-old verdict about an IP is
// not evidence about the machine answering on it today.

const VERIFIED_FILE = path.join(CACHE_DIR, 'quick-verified.json');
const VERIFIED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFIED_MAX = 4000;

let verifiedCache = null;   // id -> { code, at }

function loadVerified() {
    if (verifiedCache) return verifiedCache;
    let raw = {};
    try {
        if (fs.existsSync(VERIFIED_FILE)) raw = JSON.parse(fs.readFileSync(VERIFIED_FILE, 'utf8')) || {};
    } catch (e) { raw = {}; }

    const now = Date.now();
    const kept = {};
    for (const [id, rec] of Object.entries(raw)) {
        if (!rec || typeof rec.code !== 'string' || typeof rec.at !== 'number') continue;
        if (now - rec.at > VERIFIED_TTL_MS) continue;
        kept[id] = rec;
    }
    verifiedCache = kept;
    return verifiedCache;
}

function saveVerified() {
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(VERIFIED_FILE, JSON.stringify(verifiedCache || {}));
    } catch (e) { /* a store that cannot be written must not fail the connection */ }
}

/**
 * Remember what a node's exit really was.
 *
 * Returns what happened, so the caller can tell the user when a node just moved country
 * rather than silently rewriting the list under them.
 */
function recordVerified(nodeId, rawCode) {
    const code = geo.normalizeCode(rawCode);
    if (!nodeId || !code) return { ok: false };

    const store = loadVerified();
    const previous = store[nodeId] ? store[nodeId].code : null;

    // Oldest-first eviction, so a long-running install does not grow this file without end.
    const ids = Object.keys(store);
    if (!store[nodeId] && ids.length >= VERIFIED_MAX) {
        ids.sort((a, b) => store[a].at - store[b].at);
        for (const id of ids.slice(0, Math.max(1, Math.floor(VERIFIED_MAX / 10)))) delete store[id];
    }

    store[nodeId] = { code, at: Date.now() };
    saveVerified();

    // The in-memory list is what the panel is looking at right now; move the node there too
    // instead of waiting for the next fetch.
    let moved = false;
    if (memory && Array.isArray(memory.nodes)) {
        const node = memory.nodes.find(n => n.id === nodeId);
        if (node) {
            const claimed = node.claimedCountry || node.country;
            moved = claimed !== code;
            applyVerifiedTo(node, code);
        }
    }
    return { ok: true, code, previous, moved };
}

/** Overwrite a node's country with a measured one, keeping the feed's claim for reference. */
function applyVerifiedTo(node, code) {
    const country = geo.countryFromCode(code);
    if (!country) return;
    if (node.claimedCountry === undefined) node.claimedCountry = node.country;
    node.country = country.code;
    node.flag = country.flag;
    node.countryName = country.name;
    // The prefix is part of the label, so leaving it alone would file a server under Italy
    // while still calling it FR-838. The tag is the stable half and does not move.
    if (node.tag) node.name = composeName(country.code, node.tag);
    node.verified = true;
}

/** Fold every stored reading into a freshly built list. */
function applyVerified(nodes) {
    const store = loadVerified();
    if (!Object.keys(store).length) return nodes;
    for (const node of nodes) {
        const rec = store[node.id];
        if (rec) applyVerifiedTo(node, rec.code);
    }
    return nodes;
}

function verifiedCount() {
    return Object.keys(loadVerified()).length;
}

function forgetVerified() {
    verifiedCache = {};
    saveVerified();
    if (memory && Array.isArray(memory.nodes)) memory = null;   // rebuilt from the feed next read
}

// ── catalog ─────────────────────────────────────────────────────────────────────────────

function readDiskCache() {
    try {
        if (!fs.existsSync(CACHE_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (!parsed || !Array.isArray(parsed.nodes) || !parsed.nodes.length) return null;
        if (parsed.v !== CACHE_VERSION) return null;
        applyVerified(parsed.nodes);
        return parsed;
    } catch (e) { return null; }
}

function writeDiskCache(payload) {
    try {
        if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(payload));
    } catch (e) { /* a cache that cannot be written is not a reason to fail the fetch */ }
}

async function fetchAll() {
    const seen = new Set();
    const usedTags = new Set();
    const nodes = [];
    const sources = [];

    for (const src of SOURCES) {
        const stats = { unusable: 0, duplicate: 0 };
        try {
            let added;
            if (src.pool) {
                // Already parsed and de-duped by free-configs; re-key it against the merged
                // set so the same server appearing in both feeds is listed once.
                const entries = await freeConfigs.loadPool(src.pool);
                added = toEntries(entries.map(e => e.uri), src.id, seen, stats, usedTags);
            } else {
                added = toEntries(decodeFeed(await fetchText(src.url, src.mirror)), src.id, seen, stats, usedTags);
            }
            nodes.push(...added);
            sources.push({ id: src.id, title: src.title, ok: true, usable: added.length, ...stats });
        } catch (e) {
            // One dead feed must not empty the list — that is why there is more than one.
            sources.push({ id: src.id, title: src.title, ok: false, error: e.message, usable: 0 });
        }
    }

    if (!nodes.length) throw new Error('هیچ سروری دریافت نشد — اینترنت یا مسیر دسترسی را بررسی کنید.');
    return { v: CACHE_VERSION, at: Date.now(), nodes: applyVerified(nodes), sources };
}

/**
 * The server list, from memory, then disk, then the network.
 *
 * A stale list is always preferable to no list: the user opened this panel to get online,
 * and yesterday's servers can do that while a failed download cannot.
 */
async function load({ force = false } = {}) {
    if (!force && memory && Date.now() - memory.at < TTL_MS) return memory;
    if (loading) return loading;

    loading = (async () => {
        try {
            const fresh = await fetchAll();
            memory = fresh;
            writeDiskCache(fresh);
            return fresh;
        } catch (err) {
            const cached = memory || readDiskCache();
            if (cached) {
                memory = cached;
                return Object.assign({}, cached, { stale: true, error: err.message });
            }
            throw err;
        } finally {
            loading = null;
        }
    })();

    return loading;
}

/** Countries present in the list, most servers first, with «نامشخص» always last. */
function summarise(data) {
    const byCode = new Map();
    let unknown = 0;

    for (const n of data.nodes) {
        if (!n.country) { unknown++; continue; }
        const row = byCode.get(n.country) || { code: n.country, flag: n.flag, name: n.countryName, count: 0 };
        row.count++;
        byCode.set(n.country, row);
    }

    const countries = Array.from(byCode.values())
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'fa'));

    return {
        total: data.nodes.length,
        countries,
        unknown,
        verified: data.nodes.reduce((n, x) => n + (x.verified ? 1 : 0), 0),
        sources: data.sources,
        updatedAt: data.at,
        stale: !!data.stale,
        error: data.error || null,
    };
}

async function catalog(opts) {
    return summarise(await load(opts));
}

/** Every node, or only those in one country. `'unknown'` selects the unlabelled ones. */
async function nodesFor(country, opts) {
    const data = await load(opts);
    if (!country || country === 'all') return data.nodes;
    if (country === 'unknown') return data.nodes.filter(n => !n.country);
    const code = geo.normalizeCode(country);
    return data.nodes.filter(n => n.country === code);
}

/**
 * The top `count` countries by how many servers they have, each with its own list.
 *
 * This is what «چند سرور از چند کشور» is built on, and it is the same shape the Android app
 * uses (`QuickConnectRepository.nodesByTopCountries`). Richest-first rather than alphabetical:
 * a country with four entries contributes four chances, and spending a fifth of the sweep on it
 * is how a balanced search returns fewer servers than an unbalanced one.
 */
async function nodesByTopCountries(count, opts) {
    const data = await load(opts);
    const byCode = new Map();
    for (const n of data.nodes) {
        if (!n.country) continue;                 // unlabelled nodes belong to no country
        if (!byCode.has(n.country)) byCode.set(n.country, []);
        byCode.get(n.country).push(n);
    }
    return [...byCode.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, Math.max(1, count))
        .map(([code, nodes]) => ({ code, nodes }));
}

/**
 * Round-robin the countries together, so the sweep works on all of them at once.
 *
 * Concatenating the pools instead would finish the first country before starting the second —
 * and since the run stops the moment it has enough, the later countries would never be reached
 * and «از ۵ کشور» would quietly mean «از ۱ کشور».
 */
function interleave(pools) {
    const lists = pools.map((p) => shuffle(p.nodes.slice()));
    const out = [];
    for (let i = 0; ; i++) {
        let appended = false;
        for (const list of lists) {
            if (i < list.length) { out.push(list[i]); appended = true; }
        }
        if (!appended) break;
    }
    return out;
}

/**
 * Re-measure servers the user already has, without sweeping the catalogue again.
 *
 * The Android app has had this since it shipped («تست همهٔ سرورهای من»): a saved list goes stale
 * — a node that answered in 140 ms last week may be gone today — and re-running the whole
 * two-stage sweep to find that out is minutes of work for a question about twenty known rows.
 *
 * Same tester, same numbers as everything else on this screen.
 */
async function retestNodes(nodes, onEvent = () => {}) {
    if (activeScan) throw new Error('یک جست‌وجو در حال اجراست.');
    const list = (nodes || []).filter((n) => n && n.uri);
    if (!list.length) return [];

    const job = { stopped: false, results: [] };
    activeScan = job;
    const emit = (type, data) => { try { onEvent(Object.assign({ type }, data)); } catch (e) { /* the UI is gone */ } };
    try {
        emit('stage', { stage: 'delay', total: list.length, target: list.length, retest: true });
        let checked = 0;
        await xrayTester.testNodes({
            nodes: list,
            testType: 'delay',
            isAborted: () => job.stopped,
            onResult: (r) => {
                checked++;
                const entry = list.find((n) => n.id === r.id);
                // A row that stopped working is reported too, with `delay: 0` — dropping it
                // silently would leave the user looking at a number that is no longer true.
                if (entry) {
                    const out = Object.assign({}, entry, { delay: r.val > 0 ? r.val : 0 });
                    if (r.val > 0) job.results.push(out);
                    emit('retested', { node: out, tested: checked, total: list.length });
                }
                emit('progress', { stage: 'delay', tested: checked, found: job.results.length, total: list.length, target: list.length });
            },
        });
        job.results.sort((a, b) => a.delay - b.delay);
        emit('done', { results: job.results, stopped: job.stopped, found: job.results.length, target: list.length, retest: true });
        return job.results;
    } finally {
        activeScan = null;
    }
}

// ── finding a server that works ─────────────────────────────────────────────────────────

let activeScan = null;

function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

/**
 * Find `want` working servers, optionally within one country.
 *
 * Stage 1 is a TCP connect against every candidate — cheap enough to sweep thousands, and
 * it removes the dead majority. Stage 2 stands up one Xray holding twenty nodes at once and
 * makes a REAL request through each. Only stage 2 proves anything: on a filtered line most
 * hosts accept the connection and then carry nothing.
 *
 * `want` is a target, not a quota. The run ends when it is met, when candidates run out, or
 * the moment the user stops — and whatever was proven by then is kept.
 */
async function startScan({ country = 'all', want = 12, countries = 0, onEvent = () => {} } = {}) {
    if (activeScan) throw new Error('یک جست‌وجو در حال اجراست.');

    // BALANCED MODE — «چند سرور از چند کشور», the same control the Android app has.
    //
    // Without it the only question the panel could ask was «find me some servers», and the
    // answer clumped: the feed is sorted by nothing in particular, the sweep stops as soon as
    // it has enough, and the result was routinely a dozen servers from two countries. A user
    // who wants a choice of exits could not ask for one.
    //
    // `perCountry` is the cap each country gets. The candidate list is round-robined so every
    // country is being worked on from the first second (see [interleave]) — concatenating them
    // would finish the richest country and stop, which is the same clumping wearing a new name.
    let all;
    let perCountry = 0;
    const pools = countries > 0 ? await nodesByTopCountries(countries) : null;
    if (pools && pools.length) {
        all = interleave(pools);
        perCountry = Math.max(1, Math.ceil(want / pools.length));
    } else {
        all = await nodesFor(country);
    }
    if (!all.length) throw new Error('برای این کشور سروری در فهرست نیست.');

    const job = { stopped: false, results: [] };
    activeScan = job;
    const emit = (type, data) => { try { onEvent(Object.assign({ type }, data)); } catch (e) {} };

    // Already interleaved in balanced mode, and shuffling it again would undo exactly that.
    const takenPerCountry = new Map();
    const withinQuota = (node) => {
        if (!perCountry) return true;
        const code = node.country || '??';
        const used = takenPerCountry.get(code) || 0;
        if (used >= perCountry) return false;
        takenPerCountry.set(code, used + 1);
        return true;
    };

    try {
        const candidates = perCountry ? all : shuffle(all.slice());
        const target = Math.max(1, Math.min(want, candidates.length));

        // Sized from measurement, not intuition: on a filtered line roughly one in twelve
        // hosts with an open port went on to answer a real request. A generous cushion costs
        // nothing when nodes are plentiful and is the difference between finding three and
        // finding twenty when they are not.
        const cushion = Math.min(candidates.length, Math.max(target * 25, 250));

        emit('stage', {
            stage: 'tcp', total: candidates.length, target, country,
            countries: pools ? pools.length : 0, perCountry,
        });

        const survivors = [];
        let tested = 0;
        await freeConfigs.pool(candidates, 64, async (entry) => {
            const ms = await freeConfigs.tcpOpen(entry.host, entry.port, 1500);
            tested++;
            if (ms >= 0) survivors.push(Object.assign({ tcp: ms }, entry));
            if (tested % 25 === 0 || ms >= 0) {
                emit('progress', { stage: 'tcp', tested, open: survivors.length, total: candidates.length, target });
            }
        }, () => job.stopped || survivors.length >= cushion);

        emit('progress', { stage: 'tcp', tested, open: survivors.length, total: candidates.length, target });

        if (job.stopped) { emit('done', { results: [], stopped: true, found: 0, target }); return []; }
        if (!survivors.length) {
            emit('done', { results: [], stopped: false, found: 0, target, empty: true });
            return [];
        }

        emit('stage', { stage: 'delay', total: survivors.length, target, country });

        // Fastest handshake first: a low TCP time predicts a low real delay well enough that
        // good nodes surface in the first batches — which matters precisely because the user
        // can stop at any moment and keep what is already on screen.
        survivors.sort((a, b) => a.tcp - b.tcp);

        // MEASURED BY xray-tester, NOT BY A SHARED CORE — and that is the whole fix.
        //
        // This used to call `freeConfigs.testBatch`, which stands up ONE Xray holding twenty
        // nodes at once. Xray builds every outbound up front and refuses the entire file if a
        // single one is unrepresentable, so one poisoned entry killed its nineteen neighbours:
        // the core exited, no inbound ever bound, and `testBatch` returned SILENTLY. Measured
        // on the live feed, that is what the user was looking at —
        //
        //     STAGE tcp    1257 candidates -> 161 with an open port
        //     STAGE delay  161 survivors   -> tested=1, found=0
        //
        // One node measured out of a hundred and sixty-one, and «هیچ سرور سالمی پیدا نشد».
        //
        // `xray-tester` is the module written for this exact failure on the V2Ray panel: it
        // bind-probes its ports from a fixed base, waits on every one of them rather than the
        // first, and HALVES a page whose core did not come up — down to one core per node — so
        // a bad entry can only ever cost itself. It is also how the mobile app behaves, where
        // each outbound is measured on its own through the library and neighbours are never at
        // risk. The delay figure is the same one both screens already show: pooled agent, two
        // shots, smallest positive (see delay-measurement).
        let checked = 0;
        await xrayTester.testNodes({
            nodes: survivors,
            testType: 'delay',
            isAborted: () => job.stopped || job.results.length >= target,
            onResult: (r) => {
                checked++;
                if (r.val > 0) {
                    const entry = survivors.find((s2) => s2.id === r.id);
                    // A proven server past its country's share is dropped on purpose: the whole
                    // point of asking for five countries is not to be handed five from one.
                    if (entry && withinQuota(entry)) {
                        const found = Object.assign({}, entry, { delay: r.val });
                        delete found.tcpOnly;
                        job.results.push(found);
                        emit('found', { node: found, found: job.results.length, target });
                    }
                }
                emit('progress', {
                    stage: 'delay', tested: checked, found: job.results.length,
                    total: survivors.length, target,
                });
            },
        });

        job.results.sort((a, b) => a.delay - b.delay);
        emit('done', { results: job.results, stopped: job.stopped, found: job.results.length, target });
        return job.results;
    } finally {
        activeScan = null;
    }
}

function stopScan() {
    if (!activeScan) return false;
    activeScan.stopped = true;
    return true;
}

function scanRunning() { return !!activeScan; }

// ── where traffic actually leaves ───────────────────────────────────────────────────────

/**
 * Read Cloudflare's own view of the connection through a local SOCKS port.
 *
 * This is the only statement about location in the whole panel that is evidence rather than
 * a label. `loc` is the country Cloudflare assigns the client it sees; `colo` is the edge
 * datacenter that answered; `warp` says whether the request arrived over Cloudflare's own
 * network.
 *
 * One caveat the UI must respect: when the path is WARP, `loc` reports the USER's country by
 * design, not the exit's — a WARP session from Tehran reads `loc=IR colo=FRA` even though
 * the traffic really does leave in Frankfurt. So a WARP result is reported as "verified
 * transit" rather than "verified country".
 */
function traceEgress(socksPort, timeoutMs = 8000) {
    return new Promise((resolve) => {
        let agent;
        try {
            const { SocksTlsAgent } = require('./socks-agents');
            agent = new SocksTlsAgent(socksPort);
        } catch (e) { return resolve({ ok: false, error: 'مسیر پروکسی ساخته نشد.' }); }

        const done = (v) => {
            try { agent.destroy(); } catch (e) {}
            resolve(v);
        };

        const req = https.request({
            host: 'www.cloudflare.com',
            port: 443,
            path: '/cdn-cgi/trace',
            method: 'GET',
            agent,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
            timeout: timeoutMs,
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return done({ ok: false, error: `پاسخ ${res.statusCode}` });
                }
                const fields = {};
                for (const line of body.split('\n')) {
                    const eq = line.indexOf('=');
                    if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
                }
                const warp = fields.warp === 'on' || fields.warp === 'plus';
                const country = geo.countryFromCode(fields.loc);
                done({
                    ok: true,
                    ip: fields.ip || null,
                    loc: fields.loc || null,
                    colo: fields.colo || null,
                    warp,
                    country,
                    // WARP preserves the user's country on purpose, so `loc` is not the exit
                    // there. Say so, rather than letting the UI print a wrong flag.
                    countryTrusted: !warp,
                });
            });
        });

        req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'پاسخی نرسید (تایم‌اوت)' }); });
        req.on('error', (e) => done({ ok: false, error: e.message }));
        req.end();
    });
}

module.exports = {
    SOURCES,
    catalog,
    nodesFor,
    nodesByTopCountries,
    load,
    startScan,
    retestNodes,
    stopScan,
    scanRunning,
    traceEgress,
    remarkOf,
    recordVerified,
    verifiedCount,
    forgetVerified,
};
