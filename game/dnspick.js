'use strict';

/**
 * --- Choosing a resolver for a game, by measuring instead of by name ---
 *
 * WHY THIS FILE EXISTS
 *
 * The DNS step used to pick «الکترو» every single time, and users were right to complain. The
 * reasoning behind it was sound and the implementation did not carry it out:
 *
 *   The reasoning: do NOT pick by latency. Lookup latency is not packet latency, so a resolver
 *   that is 135ms quicker and cannot resolve a sanctioned launcher has optimised the player out
 *   of a game entirely. Pick by CAPABILITY, then by speed.
 *
 *   The implementation: `dns-manager.pingProvider` asks every resolver for `www.google.com` and
 *   nothing else — which measures whether the server is alive, not whether it can do the one job
 *   this step exists for. With no capability data to rank on, `pickBestDns` substituted a
 *   hard-coded name: `if (id === 'electro') return 0`. So as long as Electro answered at all, it
 *   won, whatever anything else could do.
 *
 * That is a preference wearing the costume of a measurement. This file does the measurement.
 *
 * WHAT IS MEASURED, AND WHY EACH PART IS NEEDED
 *
 * Measured on this line, 2026-09-14, against eight game-platform domains:
 *
 *     electro      8/8   in  1.2s
 *     begzar       8/8   in  2.7s     ← but see BOGUS below
 *     google       8/8   in  1.0s
 *     cloudflare   8/8   in  1.2s
 *     shecan       4/8   in 41.2s
 *     radar        0/8   in 52.3s     ← a "gaming DNS", resolving nothing
 *     shelter      0/8   in 56.2s     ← the same
 *
 * Three things in that table are invisible to the old code and decide the answer:
 *
 *   1. Two of the resolvers marketed for gaming resolve NOTHING. They would have been ranked
 *      above the global ones by the old `group === 'iran'` rule.
 *   2. Electro is genuinely good here — but it is not uniquely good, and Google was FASTER with
 *      the same coverage. A user whose Electro is slow or blocked had no way to learn that.
 *   3. A resolver can fail slowly. Radar burned 52 seconds to answer nothing. Per-query timeouts
 *      are therefore tight: a dead resolver must cost seconds, not a minute.
 *
 * AND AN ANSWER IS NOT AUTOMATICALLY A GOOD ANSWER
 *
 *   sinkhole  10.10.34.x and friends — a refusal wearing a success's clothes.
 *   bogus     `begzar` returns the ROOT NAMESERVER addresses mixed into its A records
 *             (198.41.0.4, 192.33.4.12, 199.7.91.13 …). Measured, not theorised. A client that
 *             picks one of those gets a connection to a root server instead of to Steam.
 *   unreachable  the address resolves and nothing is listening. One domain per provider is
 *             connect-tested, because this project's own rule is that a port that opens is not
 *             an engine that works — and a name that resolves is not a service that answers.
 *
 * NO VENDOR NAME APPEARS IN THE RANKING. That is the whole point.
 */

const dns = require('dns');
const net = require('net');
const tls = require('tls');

/**
 * The domains that decide whether a game can start from Iran.
 *
 * Not the game's own servers — those are usually reachable and rarely the problem. It is the
 * PLATFORM's authentication and content endpoints that get sanctioned, and a player who cannot
 * resolve them never reaches a match to have latency in.
 *
 * Keyed by the store a game was installed from (`installed.js` reports it), with a shared set
 * that everything is tested against.
 */
const PLATFORM_DOMAINS = {
    steam: ['steamcommunity.com', 'api.steampowered.com', 'store.steampowered.com'],
    epic: ['epicgames.com', 'launcher-public-service-prod06.ol.epicgames.com'],
    riot: ['auth.riotgames.com', 'riotgames.com'],
    battlenet: ['us.battle.net', 'battle.net'],
    rockstar: ['rockstargames.com', 'socialclub.rockstargames.com'],
    ea: ['ea.com', 'accounts.ea.com'],
    ubisoft: ['ubisoft.com', 'public-ubiservices.ubi.com'],
    gog: ['gog.com'],
};

/** Tested for every game: the two platforms most Iranian players pass through regardless. */
const BASE_DOMAINS = ['steamcommunity.com', 'epicgames.com'];

/** Answers that mean "refused", whatever the RCODE said. */
const SINKHOLE_PREFIXES = ['10.10.34.', '10.10.35.', '0.0.0.0', '127.'];

/**
 * The thirteen root nameservers.
 *
 * Present because one resolver on this line really does mix them into its A records — an answer
 * that looks complete and is partly nonsense. Any of these appearing as the address of a game
 * domain means the resolver is misbehaving, whatever else it got right.
 */
const ROOT_SERVERS = new Set([
    '198.41.0.4', '170.247.170.2', '192.33.4.12', '199.7.91.13', '192.203.230.10',
    '192.5.5.241', '192.112.36.4', '198.97.190.53', '192.36.148.17', '192.58.128.30',
    '193.0.14.129', '199.7.83.42', '202.12.27.33',
]);

function classify(addrs) {
    const list = (addrs || []).filter(Boolean);
    if (!list.length) return { ok: false, why: 'empty' };
    if (list.some(a => SINKHOLE_PREFIXES.some(p => a.startsWith(p)))) return { ok: false, why: 'sinkhole' };
    if (list.some(a => ROOT_SERVERS.has(a))) return { ok: false, why: 'bogus' };
    return { ok: true, addrs: list };
}

/**
 * One A lookup against one server, with our own timeout.
 *
 * `dns.Resolver` rather than `dns.lookup`: this has to ask a NAMED server, not the machine's. The
 * timeout is ours because a dead resolver answers nothing and the platform default is far too
 * patient — measured, that is the difference between a provider costing 3 seconds and 52.
 */
function resolveVia(server, name, timeoutMs) {
    return new Promise(resolve => {
        const r = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
        try { r.setServers([server]); } catch { return resolve({ ok: false, why: 'bad-server' }); }
        let done = false;
        const finish = (v) => { if (!done) { done = true; try { r.cancel(); } catch { } resolve(v); } };
        const timer = setTimeout(() => finish({ ok: false, why: 'timeout' }), timeoutMs + 250);
        r.resolve4(name, (err, addrs) => {
            clearTimeout(timer);
            if (err) return finish({ ok: false, why: err.code === 'ENOTFOUND' ? 'nxdomain' : (err.code || 'error').toLowerCase() });
            finish(classify(addrs));
        });
    });
}

/**
 * Does the address a resolver handed back actually answer?
 *
 * One domain per provider, one address, a real TLS handshake. This project has been wrong three
 * times by trusting something short of a completed handshake, and a resolver that returns a
 * plausible address nothing is listening on is exactly that failure in DNS form.
 */
function connects(host, addr, timeoutMs = 6000) {
    return new Promise(resolve => {
        const sock = net.connect({ host: addr, port: 443, timeout: timeoutMs });
        let secure = null;
        let done = false;
        const end = (v) => {
            if (done) return;
            done = true;
            try { if (secure) secure.destroy(); } catch { }
            try { sock.destroy(); } catch { }
            resolve(v);
        };
        sock.on('timeout', () => end(false));
        sock.on('error', () => end(false));
        sock.on('connect', () => {
            secure = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => end(true));
            secure.on('error', () => end(false));
        });
    });
}

/** The domains to test for a given game. */
function domainsFor(game) {
    const out = new Set(BASE_DOMAINS);
    const store = String((game && game.store) || '').toLowerCase();
    for (const d of PLATFORM_DOMAINS[store] || []) out.add(d);
    // A game the user added themselves has no platform, so the base set is what it gets — which
    // is honest: we do not know what its launcher talks to.
    return [...out].slice(0, 5);
}

/**
 * Rank every provider by what it can actually do for THIS game.
 *
 * @param providers  [{ id, name, servers, note, group }] — dns-manager's own list
 * @param game       the selected game, for its platform domains
 */
async function rank(providers, game, { timeoutMs = 2500, concurrency = 4, onProgress = () => { } } = {}) {
    const domains = domainsFor(game);
    const queue = providers.slice();
    const rows = [];

    const worker = async () => {
        while (queue.length) {
            const p = queue.shift();
            const server = (p.servers || [])[0];
            if (!server) continue;

            const started = Date.now();
            const failures = [];
            let resolved = 0;
            let firstGood = null;

            for (let i = 0; i < domains.length; i++) {
                const d = domains[i];
                const r = await resolveVia(server, d, timeoutMs);
                if (r.ok) {
                    resolved++;
                    if (!firstGood) firstGood = { host: d, addr: r.addrs[0] };
                } else {
                    failures.push({ domain: d, why: r.why });
                }
                // GIVE UP EARLY ON A DEAD RESOLVER. Six of the sixteen answer nothing at all, and
                // at four domains apiece they were two thirds of the whole run — measured: 29.5s
                // total, of which ~11s each for providers that resolved zero. Two consecutive
                // timeouts is enough: nothing that fails twice goes on to answer the rest.
                if (resolved === 0 && i >= 1 && failures.every(f => f.why === 'timeout')) {
                    for (let k = i + 1; k < domains.length; k++) {
                        failures.push({ domain: domains[k], why: 'skipped' });
                    }
                    break;
                }
            }
            const ms = Date.now() - started;

            // Only worth connect-testing a provider that resolved something.
            let reachable = null;
            if (firstGood) reachable = await connects(firstGood.host, firstGood.addr);

            const row = {
                id: p.id, fa: p.name || p.id, group: p.group || null,
                servers: p.servers || null, note: p.note || null,
                resolved, total: domains.length, ms, reachable,
                failures,
            };
            rows.push(row);
            onProgress(row, rows.length, providers.length);
        }
    };

    await Promise.all(new Array(Math.max(1, concurrency)).fill(0).map(worker));
    return { domains, rows: rows.sort(compare) };
}

/**
 * The ranking, and it contains no vendor names.
 *
 * Coverage first — a resolver that cannot open the launcher has optimised the wrong thing,
 * however fast it is. Then whether its answer actually connected. Then speed, which is the
 * tie-breaker it should always have been.
 */
function compare(a, b) {
    if (a.resolved !== b.resolved) return b.resolved - a.resolved;
    const ra = a.reachable === true ? 1 : 0, rb = b.reachable === true ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return a.ms - b.ms;
}

/**
 * The winner, or null when nothing could resolve anything.
 *
 * STABLE ON PURPOSE. Eight of the sixteen providers tie at full coverage on this line, so a strict
 * sort re-orders them on latency noise and two runs a minute apart name two different winners.
 * Changing the machine's resolver because one of eight equals came back 40ms quicker is churn, not
 * optimisation — so a resolver that is ALREADY ACTIVE keeps the slot whenever it is as capable as
 * the front-runner. Only a real difference in what it can open moves it.
 *
 * @param current  the servers in use right now, so an incumbent can defend its place
 */
function best(rows, { current = null } = {}) {
    const usable = (rows || []).filter(r => r.resolved > 0);
    if (!usable.length) return null;
    let w = usable[0];

    if (current) {
        const norm = (x) => (Array.isArray(x) ? x : String(x).split(/[,\s]+/)).filter(Boolean).sort().join(',');
        const now = norm(current);
        const incumbent = usable.find(r => norm(r.servers || []) === now);
        // As capable, and its answer works: leave it alone.
        if (incumbent && incumbent.resolved === w.resolved && (incumbent.reachable === true) === (w.reachable === true)) {
            w = incumbent;
        }
    }
    return {
        id: w.id, fa: w.fa, ms: w.ms, servers: w.servers,
        resolved: w.resolved, total: w.total, reachable: w.reachable,
        why: `${w.resolved} از ${w.total} دامنهٔ لازم برای این بازی را باز کرد` +
            (w.reachable ? ' و آدرسی که داد واقعاً جواب داد' : '') + `، در ${Math.round(w.ms)} میلی‌ثانیه`,
    };
}

module.exports = {
    rank, best, domainsFor, compare, classify,
    PLATFORM_DOMAINS, BASE_DOMAINS, ROOT_SERVERS, SINKHOLE_PREFIXES,
    _internal: { resolveVia, connects },
};
