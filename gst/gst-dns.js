// --- GST resilient DNS ---
// The app's own probes must not depend on the resolver the app exists to work around.
//
// Measured on the target network: `workers.dev` does not resolve through the ISP's
// resolver at all, while 1.1.1.1 answers it immediately. Without this module, a Worker
// that is deployed and perfectly healthy is reported as "unreachable", the health tab
// shows a red lamp, and the repair advice tells the user to rebuild something that was
// never broken.
//
// Strategy: try the system resolver first (fast, and correct on a clean network), then
// fall back to public resolvers. Results are cached for a short while so a sweep of ten
// relays does not repeat the same lookups.

const dns = require('dns');
const log = require('./gst-log');

// Public resolvers used only as a fallback. Two operators rather than two addresses from
// one, so a single blocked operator does not take the fallback down with it.
const FALLBACK_SERVERS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map();   // hostname -> { address, family, at }

function fromCache(hostname) {
    const hit = cache.get(hostname);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) { cache.delete(hostname); return null; }
    return hit;
}

function systemLookup(hostname, family) {
    return new Promise(resolve => {
        dns.lookup(hostname, { family: family || 0 }, (err, address, fam) => {
            resolve(err ? null : { address, family: fam });
        });
    });
}

function resolverLookup(hostname, server) {
    return new Promise(resolve => {
        const r = new dns.Resolver({ timeout: 4000, tries: 1 });
        try { r.setServers([server]); } catch (e) { return resolve(null); }

        // A4 first: the tunnel's transport is IPv4 throughout, and handing back a v6
        // address on a v4-only path produces a connect error that looks like a dead host.
        r.resolve4(hostname, (err, addrs) => {
            if (!err && addrs && addrs.length) return resolve({ address: addrs[0], family: 4 });
            r.resolve6(hostname, (err6, addrs6) => {
                if (!err6 && addrs6 && addrs6.length) return resolve({ address: addrs6[0], family: 6 });
                resolve(null);
            });
        });
    });
}

/**
 * Resolve a hostname, falling back past a poisoned or unhelpful system resolver.
 * @returns {Promise<{address, family, via}|null>}
 */
async function resolve(hostname, family) {
    const cached = fromCache(hostname);
    if (cached) return { ...cached, via: 'cache' };

    const sys = await systemLookup(hostname, family);
    if (sys) {
        cache.set(hostname, { ...sys, at: Date.now() });
        return { ...sys, via: 'system' };
    }

    for (const server of FALLBACK_SERVERS) {
        const hit = await resolverLookup(hostname, server);
        if (hit) {
            cache.set(hostname, { ...hit, at: Date.now() });
            // Worth a log line: it means the user's ISP is filtering this name, which is
            // the difference between "your Worker is broken" and "your ISP blocks it".
            log.info('dns', `${hostname} از DNS سیستم حل نشد — با ${server} حل شد (${hit.address})`);
            return { ...hit, via: server };
        }
    }
    return null;
}

/**
 * Drop-in replacement for the `lookup` option of http/https requests.
 * Node calls this instead of dns.lookup when resolving the request's host.
 */
function lookup(hostname, options, callback) {
    // Node calls lookup(hostname, callback) in some paths.
    if (typeof options === 'function') { callback = options; options = {}; }
    const family = (options && options.family) || 0;

    resolve(hostname, family).then(hit => {
        if (!hit) {
            const err = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
            err.code = 'ENOTFOUND';
            return callback(err);
        }
        // `all: true` callers expect an array.
        if (options && options.all) return callback(null, [{ address: hit.address, family: hit.family }]);
        callback(null, hit.address, hit.family);
    }).catch(err => callback(err));
}

/** Human-readable check used by the health tab and diagnostics. */
async function diagnose(hostname) {
    const sys = await systemLookup(hostname);
    if (sys) return { ok: true, via: 'system', address: sys.address };

    for (const server of FALLBACK_SERVERS) {
        const hit = await resolverLookup(hostname, server);
        if (hit) {
            return {
                ok: true,
                via: server,
                address: hit.address,
                blocked: true,
                message: `«${hostname}» روی DNS اینترنت شما مسدود است — برنامه خودش دور می‌زند.`,
            };
        }
    }
    return { ok: false, message: `«${hostname}» با هیچ DNS‌ای حل نشد.` };
}

function clearCache() { cache.clear(); }

module.exports = { lookup, resolve, diagnose, clearCache, FALLBACK_SERVERS };
