// --- Learned route cache ---
//
// The built-in tables in tun-routes.js cover the sites everyone hits, and nothing else.
// A domain outside them is a guess: route it direct and a blocked site fails, route it
// through the tunnel and an ordinary site pays for nothing. Neither is acceptable as a
// permanent answer, and re-deciding on every connection is not an option either — the
// decision costs TCP and TLS round trips.
//
// So each domain is classified ONCE, the verdict is written down, and every later
// connection reads the answer instead of measuring it again.
//
// Verdicts, and why each one implies a different route:
//   iran          Iranian service. Direct — its servers are next door and many refuse
//                 foreign IPs outright.
//   dns-poisoned  The ISP forges the DNS answer, but the real IP is reachable. Direct,
//                 with an honest answer from the DoH worker. No tunnel, no speed lost.
//   filtered      Blocked at the IP or TLS-SNI layer. Only a foreign exit reaches it.
//   sanctioned    The site itself refuses Iranian IPs. Same cure, different cause.
//   clean         Reachable directly with nothing special done. Direct.
//   unknown       Not measured yet. Falls back to the configured default.
//
// Verdicts expire: filtering changes, sanctions are lifted, a CDN moves. A stale verdict
// that says "clean" about a now-blocked site is worse than no verdict at all, because it
// is trusted silently.

const fs = require('fs');
const os = require('os');
const net = require('net');
const tls = require('tls');
const path = require('path');
const https = require('https');
const dnsPromises = require('dns').promises;

const DATA_DIR = path.join(os.homedir(), '.mlmvpn');
const CACHE_FILE = path.join(DATA_DIR, 'route-cache.json');

const VERDICTS = ['iran', 'dns-poisoned', 'filtered', 'sanctioned', 'clean', 'unknown'];

// How long a verdict is trusted. Blocks are re-imposed and lifted often enough that a
// month-old answer is fiction; a positive result is cheaper to re-confirm than a negative
// one is to live with, so "clean" expires sooner than a block.
const TTL_MS = {
    iran: 90 * 24 * 3600e3,        // a domain does not stop being Iranian
    filtered: 14 * 24 * 3600e3,
    sanctioned: 14 * 24 * 3600e3,
    'dns-poisoned': 14 * 24 * 3600e3,
    clean: 7 * 24 * 3600e3,
};

// Iranian ISPs answer a DNS-blocked name with one of these.
const POISON_IPS = ['10.10.34.34', '10.10.34.35', '10.10.34.36'];

const PROBE_TIMEOUT_MS = 5000;

let cache = null; // domain -> { verdict, at, source }

// ── store ────────────────────────────────────────────────────────────────────

function load() {
    if (cache) return cache;
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        cache = raw && typeof raw.domains === 'object' ? raw.domains : {};
    } catch (e) {
        cache = {};
    }
    return cache;
}

let saveTimer = null;

function writeNow() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: 1, domains: load() }, null, 2));
        return true;
    } catch (e) {
        return false; // a cache that cannot be written is still a working cache in memory
    }
}

function save() {
    // Coalesced: a classification sweep touches the file once, not once per domain.
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; writeNow(); }, 500);
}

/** Write immediately. For app shutdown, and for anything that reads the file back. */
function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    return writeNow();
}

function normalizeDomain(domain) {
    return String(domain || '').trim().toLowerCase()
        .replace(/^https?:\/\//, '')
        .split('/')[0]
        .split(':')[0]
        .replace(/^\*?\./, '');
}

// Verdicts are stored per registrable-ish domain, not per hostname: classifying
// `www.youtube.com` and `m.youtube.com` separately would measure the same block twice and
// let them drift apart. Two labels is the right granularity for the common ccTLD cases
// here (.ir, .co.uk) without pulling in a public-suffix list.
function baseDomain(domain) {
    const parts = normalizeDomain(domain).split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const twoLevelTlds = ['co.uk', 'co.ir', 'ac.ir', 'gov.ir', 'org.ir', 'net.ir', 'com.br', 'co.jp', 'com.au'];
    const lastTwo = parts.slice(-2).join('.');
    if (twoLevelTlds.includes(lastTwo)) return parts.slice(-3).join('.');
    return lastTwo;
}

function isFresh(entry) {
    if (!entry || !entry.verdict) return false;
    const ttl = TTL_MS[entry.verdict];
    if (!ttl) return false;
    return Date.now() - (entry.at || 0) < ttl;
}

/** The stored verdict for a domain, or 'unknown' if absent or expired. */
function get(domain) {
    const key = baseDomain(domain);
    if (!key) return { verdict: 'unknown' };
    const entry = load()[key];
    if (!isFresh(entry)) return { verdict: 'unknown', stale: !!entry };
    return { ...entry, domain: key };
}

function set(domain, verdict, source = 'probe') {
    const key = baseDomain(domain);
    if (!key || !VERDICTS.includes(verdict) || verdict === 'unknown') return null;
    const entry = { verdict, at: Date.now(), source };
    load()[key] = entry;
    save();
    return { ...entry, domain: key };
}

function remove(domain) {
    const key = baseDomain(domain);
    if (load()[key]) { delete load()[key]; save(); return true; }
    return false;
}

function clear() {
    cache = {};
    save();
}

/** Everything currently known, grouped by verdict — what the routing tables consume. */
function byVerdict() {
    const out = { iran: [], 'dns-poisoned': [], filtered: [], sanctioned: [], clean: [] };
    const all = load();
    for (const [domain, entry] of Object.entries(all)) {
        if (!isFresh(entry)) continue;
        if (out[entry.verdict]) out[entry.verdict].push(domain);
    }
    return out;
}

function stats() {
    const all = load();
    const fresh = Object.values(all).filter(isFresh);
    const counts = {};
    for (const e of fresh) counts[e.verdict] = (counts[e.verdict] || 0) + 1;
    return { total: Object.keys(all).length, fresh: fresh.length, stale: Object.keys(all).length - fresh.length, counts };
}

// ── classification ───────────────────────────────────────────────────────────

/**
 * Resolve through the user's DoH worker: the answer the ISP cannot forge.
 *
 * Accepts either the worker's base URL or its /dns-query endpoint, because both are in
 * circulation in this codebase — the JSON contract lives at /resolve either way, and
 * quietly hitting the wrong path just returns "no address" and poisons every verdict
 * downstream with `unknown`.
 */
async function resolveHonest(domain, dohUrl) {
    if (!dohUrl) return [];
    try {
        const u = new URL(dohUrl);
        const base = u.pathname.replace(/\/(dns-query|resolve)\/?$/, '').replace(/\/$/, '');
        const path = `${base}/resolve?domain=${encodeURIComponent(domain)}`;

        // Reach the worker by IP, never through the machine's configured resolver.
        //
        // That resolver is frequently the thing being replaced — during a bridge session it
        // is 127.0.0.1, and if the bridge is not up it answers nothing at all. Depending on
        // it made every classification fail with EAI_AGAIN and record `unknown`, which is
        // the one verdict that teaches the cache nothing.
        const ip = await resolveViaBootstrap(u.hostname);
        const body = await new Promise((resolve, reject) => {
            const req = https.request({
                host: ip, servername: u.hostname,
                headers: { Host: u.host }, // by-IP dialling makes Node default Host to the IP -> 403
                port: u.port || 443,
                path,
                method: 'GET', timeout: PROBE_TIMEOUT_MS,
            }, (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => (res.statusCode === 200 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error('HTTP ' + res.statusCode))));
            });
            req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
            req.on('error', reject);
            req.end();
        });
        const json = JSON.parse(body);
        return (json.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
    } catch (e) {
        return [];
    }
}

// Public resolvers used only to find the worker's own address, cached for the process.
// workers.dev is not a filtered name, so a plain lookup is fine here.
const BOOTSTRAP_RESOLVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
const bootstrapCache = new Map(); // hostname -> { ip, at }

async function resolveViaBootstrap(hostname) {
    const hit = bootstrapCache.get(hostname);
    if (hit && Date.now() - hit.at < 3600e3) return hit.ip;

    let lastError = null;
    for (const server of BOOTSTRAP_RESOLVERS) {
        try {
            const r = new dnsPromises.Resolver();
            r.setServers([server]);
            const addrs = await r.resolve4(hostname);
            if (addrs && addrs.length) {
                bootstrapCache.set(hostname, { ip: addrs[0], at: Date.now() });
                return addrs[0];
            }
        } catch (e) { lastError = e; }
    }
    throw lastError || new Error(`cannot resolve ${hostname}`);
}

/** Resolve through whatever the machine is configured to use — the forgeable answer. */
async function resolveLocal(domain) {
    try {
        return await dnsPromises.resolve4(domain);
    } catch (e) {
        return [];
    }
}

/**
 * Open a real TLS connection with the real SNI.
 *
 * This is the measurement that separates "DNS lie" from "actually blocked". DPI that
 * blocks by SNI lets the TCP handshake complete and then kills the connection as the
 * ClientHello goes past — so a TCP connect that succeeds while TLS fails is the
 * signature of SNI filtering, and it has to be probed for specifically.
 */
function probeTls(ip, servername) {
    return new Promise((resolve) => {
        const started = Date.now();
        let tcpOk = false;
        const sock = tls.connect({
            host: ip, port: 443, servername,
            rejectUnauthorized: false,
            timeout: PROBE_TIMEOUT_MS,
        }, () => {
            resolve({ ok: true, tcpOk: true, ms: Date.now() - started });
            sock.destroy();
        });
        sock.on('secureConnect', () => { tcpOk = true; });
        sock.on('connect', () => { tcpOk = true; });
        sock.on('timeout', () => { sock.destroy(); resolve({ ok: false, tcpOk, reason: 'timeout', ms: Date.now() - started }); });
        sock.on('error', (e) => { resolve({ ok: false, tcpOk, reason: e.code || e.message, ms: Date.now() - started }); });
    });
}

function probeTcp(ip, port = 443) {
    return new Promise((resolve) => {
        const started = Date.now();
        const sock = net.connect({ host: ip, port, timeout: PROBE_TIMEOUT_MS });
        const done = (ok, reason) => { try { sock.destroy(); } catch (e) {} resolve({ ok, reason, ms: Date.now() - started }); };
        sock.on('connect', () => done(true));
        sock.on('timeout', () => done(false, 'timeout'));
        sock.on('error', (e) => done(false, e.code || e.message));
    });
}

/** Does the site itself refuse this IP? That is a sanction, not a filter. */
async function probeSanction(ip, servername) {
    return new Promise((resolve) => {
        const req = https.request({
            host: ip, servername, port: 443, path: '/', method: 'GET',
            rejectUnauthorized: false, timeout: PROBE_TIMEOUT_MS,
            headers: { Host: servername, 'User-Agent': 'Mozilla/5.0' },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c.slice(0, 2048)));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf8').toLowerCase();
                // 403/451 plus the wording these services actually use. A bare 403 is not
                // enough: plenty of sites 403 a bot with no cookies.
                const geoWorded = /not available in your (country|region)|access denied.*country|unsupported[_ ]country|geo.?block|restricted.*region|sanction/.test(body);
                resolve({ status: res.statusCode, sanctioned: res.statusCode === 451 || (res.statusCode === 403 && geoWorded) });
            });
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, sanctioned: false }); });
        req.on('error', () => resolve({ status: 0, sanctioned: false }));
        req.end();
    });
}

/**
 * Work out what a domain is, from the outside, once.
 *
 * The order matters: each step rules out a cheaper explanation before paying for the next
 * measurement, and the cheap answers are the common ones.
 */
async function classify(domain, { dohUrl, iranDomains = [] } = {}) {
    const key = baseDomain(domain);
    const host = normalizeDomain(domain);
    if (!key) return { domain: key, verdict: 'unknown', reason: 'invalid domain' };

    // 1. Iranian by name. No network needed, and it is the answer that must never be got
    //    wrong: routing an Iranian bank through a foreign exit tends to lock the account.
    if (key.endsWith('.ir') || iranDomains.includes(key)) {
        return { ...set(key, 'iran', 'tld'), reason: 'دامنه ایرانی' };
    }

    // 2. Compare the honest answer with the local one. A forged reply is the single most
    //    common block in Iran and it is fixed by DNS alone — no tunnel, no lost speed.
    const [honest, local] = await Promise.all([resolveHonest(host, dohUrl), resolveLocal(host)]);
    const poisonedLocally = local.some((ip) => POISON_IPS.includes(ip));

    if (!honest.length) {
        // Without an honest IP nothing below can be measured, and guessing here would
        // write a wrong verdict that is then trusted for two weeks.
        return { domain: key, verdict: 'unknown', reason: 'آدرس واقعی به‌دست نیامد' };
    }

    // 3. Can the real IP actually be reached, with the real SNI?
    const ip = honest[0];
    const tlsProbe = await probeTls(ip, host);

    if (tlsProbe.ok) {
        // Reachable. If the local resolver was lying, DNS was the whole block.
        if (poisonedLocally) {
            return { ...set(key, 'dns-poisoned', 'probe'), reason: `جعل DNS (${local[0]}) — با DNS تمیز باز می‌شود`, ms: tlsProbe.ms };
        }
        // Reachable and honest — but the site may still refuse an Iranian IP.
        const sanction = await probeSanction(ip, host);
        if (sanction.sanctioned) {
            return { ...set(key, 'sanctioned', 'probe'), reason: `سایت آی‌پی ایران را رد می‌کند (HTTP ${sanction.status})` };
        }
        return { ...set(key, 'clean', 'probe'), reason: 'مستقیم باز می‌شود', ms: tlsProbe.ms };
    }

    // 4. TLS failed. Whether TCP survived tells us where the block sits — but either way
    //    the cure is the same, so both land on 'filtered'.
    const tcp = await probeTcp(ip);
    const where = tcp.ok ? 'SNI' : 'IP';
    return { ...set(key, 'filtered', 'probe'), reason: `مسدود روی ${where} (${tlsProbe.reason}) — تونل لازم است` };
}

/** Classify several domains without hammering the network. */
async function classifyMany(domains, options = {}, concurrency = 4) {
    const queue = [...new Set(domains.map(baseDomain).filter(Boolean))];
    const results = [];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) {
            const d = queue.shift();
            results.push(await classify(d, options));
        }
    });
    await Promise.all(workers);
    return results;
}

module.exports = {
    get, set, remove, clear, byVerdict, stats, flush,
    classify, classifyMany,
    baseDomain, normalizeDomain, isFresh,
    VERDICTS, TTL_MS, POISON_IPS, CACHE_FILE,
};
