// --- Free public configs: fetch, filter, and prove which ones actually work ---
//
// The pool comes from the @Raydikalx aggregator, which merges ~21 public sources every 15
// minutes and publishes them as plain text on GitHub. This module turns that firehose into
// a short list of nodes that are verified WORKING ON THIS USER'S LINE — which is the only
// verification that means anything, because a node that answers from Frankfurt says nothing
// about whether it answers from here.
//
// THE SHAPE OF THE WORK (and why it is two stages, not one)
//
// Measured on the aggregator's own pipeline and confirmed on this pool of 9,959:
//   * ~20% of entries are DUPLICATE ENDPOINTS — the same host:port published under several
//     names. Testing them separately is pure waste, so they are collapsed first.
//   * only ~56% have an open TCP port at all. A TCP connect costs milliseconds and needs no
//     proxy, while a real delay test costs seconds and a whole Xray process — so the cheap
//     test runs first and throws out the corpses.
//   * whatever survives gets a REAL request through Xray, because an open port proves a
//     machine is listening, not that a proxy is behind it.
//
// The delay test deliberately reuses this app's existing measurement (pooled agent, two
// shots, keep the minimum), so a number here means the same thing as a number in the nodes
// tab rather than being a second, differently-wrong opinion.

const fs = require('fs');
const net = require('net');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { gtFetch } = require('./github-tunnel/gt-net');

const INDEX_URL = 'https://raw.githubusercontent.com/0xRadikal/Free-v2ray-Configs/main/index.json';
const INDEX_MIRROR = 'https://cdn.jsdelivr.net/gh/0xRadikal/Free-v2ray-Configs@main/index.json';

// Pools, best-first. The aggregator already runs its own cascade, and its labels are worth
// surfacing verbatim: a user who picks "verified" is starting from configs that passed a
// real proxied request minutes ago, so their own test finds working nodes far sooner.
const POOLS = [
    { id: 'verified', title: 'تأییدشده', why: 'در همه‌ی دورهای آزمایش، درخواست واقعی از آن‌ها رد شده', path: 'verified/configs.txt' },
    { id: 'fast', title: 'سریع', why: 'تأییدشده و میانه‌ی تأخیرشان زیر آستانه بوده', path: 'fast/configs.txt' },
    { id: 'secure', title: 'امن', why: 'تأییدشده، با forward secrecy و بدون غیرفعال کردن بررسی گواهی', path: 'secure/configs.txt' },
    { id: 'all', title: 'همه', why: 'کل مجموعه، بدون پیش‌آزمایش — بیشترین تعداد، کمترین شانس', path: 'all/configs.txt' },
];

// Cache the downloaded text briefly: the source refreshes every 15 minutes, so re-fetching
// megabytes because the user reopened the modal helps nobody.
const POOL_TTL_MS = 5 * 60 * 1000;
const poolCache = new Map();   // id -> { at, entries }

let catalogCache = null;
let catalogAt = 0;

/** Fetch text, primary first then the jsDelivr mirror — raw.githubusercontent is filtered. */
async function fetchText(url, mirror) {
    const attempts = mirror ? [url, mirror] : [url];
    let lastErr = null;
    for (const target of attempts) {
        try {
            const r = await gtFetch(target, { timeoutMs: 30000 });
            if (!r.ok) { lastErr = new Error(`HTTP ${r.status}`); continue; }
            return await r.text();
        } catch (e) { lastErr = e; }
    }
    throw new Error(`دریافت فهرست کانفیگ‌های رایگان ناموفق بود: ${lastErr ? lastErr.message : 'نامشخص'}`);
}

/**
 * What is on offer right now: pool sizes, freshness, and how many sources are healthy.
 *
 * Read from the aggregator's own index.json rather than hard-coded, so the counts the user
 * sees are the counts they will actually get.
 */
async function getCatalog({ force = false } = {}) {
    if (!force && catalogCache && Date.now() - catalogAt < POOL_TTL_MS) return catalogCache;

    const text = await fetchText(INDEX_URL, INDEX_MIRROR);
    const idx = JSON.parse(text);
    const base = idx.raw_base || 'https://raw.githubusercontent.com/0xRadikal/Free-v2ray-Configs/main';
    const mirrorBase = idx.cdn_base || 'https://cdn.jsdelivr.net/gh/0xRadikal/Free-v2ray-Configs@main';

    const counts = {};
    for (const [k, v] of Object.entries(idx.cascade_categories || {})) counts[k] = v.unique;
    for (const [k, v] of Object.entries(idx.categories || {})) counts[k] = v.unique;

    catalogCache = {
        pools: POOLS.map(p => ({
            id: p.id,
            title: p.title,
            why: p.why,
            count: counts[p.id] || 0,
            url: `${base}/${p.path}`,
            mirror: `${mirrorBase}/${p.path}`,
        })).filter(p => p.count > 0),
        updatedAt: idx.updated_at || null,
        intervalMinutes: idx.update_interval_minutes || null,
        sources: idx.sources ? { total: idx.sources.total_count, healthy: idx.sources.healthy } : null,
        protocols: (idx.categories && idx.categories.all && idx.categories.all.protocols) || null,
    };
    catalogAt = Date.now();
    return catalogCache;
}

/** A stable identity for "the same server", so duplicates collapse before any testing. */
function endpointKey(outbound) {
    const s = outbound.settings || {};
    const v = (s.vnext && s.vnext[0]) || (s.servers && s.servers[0]) || {};
    const id = (v.users && v.users[0] && v.users[0].id) || v.password || '';
    return `${outbound.protocol}|${v.address}|${v.port}|${id}`;
}

/** Country flag + a short label, taken from the config's own name when it has one. */
const BRAND = '@mlmvpn';

function labelOf(uri) {
    const hash = uri.indexOf('#');
    if (hash === -1) return '';
    let raw;
    try { raw = decodeURIComponent(uri.slice(hash + 1)).trim(); }
    catch (e) { raw = uri.slice(hash + 1).trim(); }
    // The aggregator stamps its own Telegram handle into every remark, e.g.
    // "DE 🇩🇪 | @Raydikalx | 1A9ADE". These names end up in the user's own node list and on
    // their own screen, so the handle is replaced with this app's. The country, the flag and
    // the short id are the parts that carry information, and they are left alone.
    return raw.replace(/@[A-Za-z0-9_]{2,}/g, BRAND);
}

/** The same rename applied to the link itself, so a shared or re-copied config matches what
 *  the user saw. Only the fragment (the remark) changes — the config is untouched. */
function rebrandUri(uri) {
    const hash = uri.indexOf('#');
    if (hash === -1) return uri;
    const label = labelOf(uri);
    return uri.slice(0, hash + 1) + encodeURIComponent(label);
}

/**
 * Download a pool and reduce it to entries this app can actually run.
 *
 * Parsing is the filter: `parseVlessUri` rejects protocols the core cannot speak
 * (hysteria2, tuic, ssr), transports it removed (h2), ciphers it does not implement, and
 * malformed REALITY parameters — every one of which is fatal to the WHOLE Xray config
 * rather than to the single node, so they must never reach the tester.
 */
async function loadPool(poolId) {
    const cached = poolCache.get(poolId);
    if (cached && Date.now() - cached.at < POOL_TTL_MS) return cached.entries;

    const catalog = await getCatalog();
    const pool = catalog.pools.find(p => p.id === poolId);
    if (!pool) throw new Error('این دسته وجود ندارد.');

    const text = await fetchText(pool.url, pool.mirror);
    const { parseVlessUri } = require('./xray-manager');

    const seen = new Set();
    const entries = [];
    let unusable = 0;

    for (const raw of text.split('\n')) {
        const uri = raw.trim();
        if (!uri || uri.startsWith('#')) continue;
        let outbound;
        try { outbound = parseVlessUri(uri); } catch (e) { unusable++; continue; }

        const key = endpointKey(outbound);
        if (seen.has(key)) continue;
        seen.add(key);

        const v = (outbound.settings.vnext && outbound.settings.vnext[0])
            || (outbound.settings.servers && outbound.settings.servers[0]);
        entries.push({
            // Rebranded here, once, so the modal list, the node that lands in V2Ray and the
            // link the user shares all say the same thing.
            uri: rebrandUri(uri),
            protocol: outbound.protocol,
            host: v.address,
            port: v.port,
            label: labelOf(uri),
        });
    }

    poolCache.set(poolId, { at: Date.now(), entries, unusable });
    return entries;
}

function poolStats(poolId) {
    const c = poolCache.get(poolId);
    return c ? { usable: c.entries.length, unusable: c.unusable } : null;
}

/** TCP connect, nothing more: is anything listening at all? */
function tcpOpen(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        const started = Date.now();
        let done = false;
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) {}
            resolve(ok ? Date.now() - started : -1);
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        try { sock.connect(port, host); } catch (e) { finish(false); }
    });
}

/** Run `jobs` with a bounded number in flight, stopping early when the job is cancelled. */
async function pool(items, limit, worker, shouldStop) {
    let next = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        while (true) {
            if (shouldStop && shouldStop()) return;
            const i = next++;
            if (i >= items.length) return;
            try { await worker(items[i], i); } catch (e) { /* one bad node must not stop the sweep */ }
        }
    });
    await Promise.all(runners);
}

// ── the two-stage tester ────────────────────────────────────────────────────────────

const DELAY_BATCH = 20;          // nodes per Xray process — one core holds these ports
                                 // comfortably, and it keeps a 100-node run to seconds
const TCP_CONCURRENCY = 64;      // a TCP connect costs nothing; this is what makes 10k feasible
const TCP_TIMEOUT_MS = 1500;
const PROBE_URL = 'https://clients3.google.com/generate_204';

let activeJob = null;

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

/** Fisher-Yates. Without it every run tests the same head of the list and rediscovers the
 *  same dead nodes; the pool is not ordered by quality, so a random slice is a fair sample. */
function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

async function waitForLocalPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ((await tcpOpen('127.0.0.1', port, 400)) >= 0) return true;
        await new Promise(r => setTimeout(r, 100));
    }
    return false;
}

/**
 * Real delay through a real proxy, measured the way the nodes tab measures it: one pooled
 * agent, two shots, keep the smallest. The first shot pays for the TCP+SOCKS+TLS setup; the
 * second rides the tunnel that is already up, and that is the number a user can compare
 * against other clients instead of a cold-handshake figure four times too large.
 */
async function probeDelay(socksPort) {
    const https = require('https');
    const { SocksTlsAgent } = require('./socks-agents');
    const agent = new SocksTlsAgent(socksPort);
    const url = new URL(PROBE_URL);

    const shot = () => new Promise((resolve) => {
        const started = Date.now();
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
        const req = https.request({
            host: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'GET',
            agent,
            headers: { 'User-Agent': 'Mozilla/5.0', Accept: '*/*' },
            timeout: 6000,
        }, (res) => {
            res.resume();
            res.on('end', () => finish(res.statusCode > 0 && res.statusCode < 400 ? Date.now() - started : -1));
        });
        req.on('timeout', () => { req.destroy(); finish(-1); });
        req.on('error', () => finish(-1));
        req.end();
    });

    const first = await shot();
    if (first < 0) { agent.destroy(); return -1; }
    await new Promise(r => setTimeout(r, 100));
    const second = await shot();
    agent.destroy();
    return second > 0 ? Math.min(first, second) : first;
}

/**
 * Delay-test one batch by standing up a single Xray with one inbound per node.
 *
 * One process for twenty nodes, not twenty processes. A node that cannot be represented
 * becomes a blackhole outbound rather than being dropped: Xray validates the whole file at
 * once and the ports are assigned by index, so a hole in the numbering would silently shift
 * every later node onto the wrong port and report other people's results.
 */
async function testBatch(batch, { onResult, shouldStop, onBatchFailed }) {
    const { parseVlessUri } = require('./xray-manager');
    const basePort = 24000 + Math.floor(Math.random() * 4000);
    const inbounds = [];
    const outbounds = [];
    const rules = [];

    batch.forEach((entry, i) => {
        inbounds.push({
            port: basePort + i, listen: '127.0.0.1', protocol: 'socks',
            settings: { udp: false }, tag: 'in-' + i,
        });
        let outbound;
        try { outbound = parseVlessUri(entry.uri); } catch (e) { outbound = { protocol: 'blackhole' }; }
        outbound.tag = 'out-' + i;
        outbounds.push(outbound);
        rules.push({ type: 'field', inboundTag: ['in-' + i], outboundTag: 'out-' + i });
    });

    const dir = path.join(os.homedir(), '.mlmvpn');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const cfgPath = path.join(dir, 'free-configs-test.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
        log: { loglevel: 'none' },
        inbounds,
        outbounds,
        routing: { rules },
    }));

    const exe = require('./core-paths').file('xray', 'xray.exe', path.join(getUnpackedDir(), 'core', 'xray.exe'));
    const proc = spawn(exe, ['-config', cfgPath], { windowsHide: true });
    // KEPT, NOT DISCARDED. These two were `resume()` — drained and thrown away — and that is
    // what made a whole class of failure invisible. Xray builds every outbound in a file up
    // front and refuses the entire file if ONE is unrepresentable, so a single bad entry takes
    // its nineteen neighbours with it: the core exits, no port binds, and every node in the page
    // reads as dead with nothing written anywhere. It cost hours to find in «اتصال سریع», where
    // the message had been sitting in a pipe going to /dev/null the whole time:
    //
    //     failed to build outbound config with tag out-2 >
    //     vless without TLS or other encryption is prohibited
    //
    // A bounded tail is enough to name the culprit and costs nothing.
    let coreSaid = '';
    const keep = (d) => { coreSaid = (coreSaid + d.toString('utf8')).slice(-1500); };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);

    try {
        if (!(await waitForLocalPort(basePort, 6000))) {
            // Reported, not swallowed. The caller counts results, so returning quietly here is
            // indistinguishable from "every one of these nodes is dead".
            const tail = coreSaid.trim().split(/\r?\n/).pop() || '';
            const why = (coreSaid.match(/Failed to start:.*/) || [tail])[0];
            if (onBatchFailed) onBatchFailed(why.slice(0, 300));
            else console.warn('[free-configs] batch core did not start:', why.slice(0, 300));
            return;
        }
        await pool(batch, DELAY_BATCH, async (entry, i) => {
            if (shouldStop && shouldStop()) return;
            const ms = await probeDelay(basePort + i);
            onResult(entry, ms);
        }, shouldStop);
    } finally {
        try { proc.kill(); } catch (e) {}
    }
}

/**
 * The whole run: take a random slice, drop what has no open port, then prove the rest.
 *
 * `want` is a target, not a quota to be filled at any cost — the run ends when it is
 * reached, when the candidates run out, or the moment the user says stop, and whatever has
 * been found by then is kept. Ten proven nodes are worth more than a hundred hopeful ones.
 */
async function startJob({ poolId, want, onEvent }) {
    if (activeJob) throw new Error('یک جست‌وجو در حال اجراست.');

    const entries = shuffle((await loadPool(poolId)).slice());
    const job = { stopped: false, results: [] };
    activeJob = job;

    const emit = (type, data) => { try { onEvent(Object.assign({ type }, data)); } catch (e) {} };

    try {
        const target = Math.max(1, Math.min(want, entries.length));
        // How many stage-1 survivors to gather before moving on.
        //
        // Sized from a measured run, not a guess: on this line, 38 nodes with an open TCP
        // port yielded 3 that answered a real request — about 8%, not the 50% that seems
        // reasonable. The aggregator's "verified" label means verified from ITS vantage
        // point (its own trace reports a US exit); from a filtered line most of those hosts
        // answer on the port and then go nowhere. So the cushion is generous and the run
        // simply stops early once the target is met — costing nothing when nodes are
        // plentiful, and being the difference between 3 and 100 when they are not.
        const cushion = Math.min(entries.length, Math.max(target * 25, 200));

        emit('stage', { stage: 'tcp', total: entries.length, target });

        const survivors = [];
        let tested = 0;
        await pool(entries, TCP_CONCURRENCY, async (entry) => {
            const ms = await tcpOpen(entry.host, entry.port, TCP_TIMEOUT_MS);
            tested++;
            if (ms >= 0) survivors.push(Object.assign({ tcp: ms }, entry));
            if (tested % 25 === 0 || ms >= 0) {
                emit('progress', { stage: 'tcp', tested, open: survivors.length, total: entries.length });
            }
        }, () => job.stopped || survivors.length >= cushion);

        emit('progress', { stage: 'tcp', tested, open: survivors.length, total: entries.length });
        emit('stage', { stage: 'delay', total: survivors.length, target });

        // Fastest handshake first: a low TCP time predicts a low real delay well enough that
        // the good nodes surface in the first batches — which matters precisely because the
        // user can stop at any moment and keep what is already on screen.
        survivors.sort((a, b) => a.tcp - b.tcp);

        let checked = 0;
        for (let i = 0; i < survivors.length; i += DELAY_BATCH) {
            if (job.stopped || job.results.length >= target) break;
            const batch = survivors.slice(i, i + DELAY_BATCH);
            await testBatch(batch, {
                shouldStop: () => job.stopped || job.results.length >= target,
                // A page whose core never started is not a page of dead servers, and the panel
                // has to be able to tell the two apart — otherwise the only visible difference
                // between "these configs are bad" and "the tester broke" is the number zero.
                onBatchFailed: (why) => emit('batch-failed', { size: batch.length, why }),
                onResult: (entry, ms) => {
                    checked++;
                    if (ms > 0) {
                        job.results.push({
                            uri: entry.uri, protocol: entry.protocol, host: entry.host,
                            port: entry.port, label: entry.label, delay: ms, tcp: entry.tcp,
                        });
                        emit('found', {
                            node: job.results[job.results.length - 1],
                            found: job.results.length, target,
                        });
                    }
                    emit('progress', {
                        stage: 'delay', tested: checked, found: job.results.length,
                        total: survivors.length, target,
                    });
                },
            });
        }

        job.results.sort((a, b) => a.delay - b.delay);
        emit('done', { results: job.results, stopped: job.stopped, found: job.results.length, target });
        return job.results;
    } finally {
        activeJob = null;
    }
}

function stopJob() {
    if (!activeJob) return false;
    activeJob.stopped = true;
    return true;
}

function jobRunning() { return !!activeJob; }

module.exports = {
    POOLS,
    getCatalog,
    loadPool,
    poolStats,
    startJob,
    stopJob,
    jobRunning,
    tcpOpen,
    pool,
    testBatch,
    probeDelay,
    endpointKey,
    labelOf,
    rebrandUri,
};
