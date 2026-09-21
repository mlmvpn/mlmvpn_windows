// --- GitHub Tunnel: which account runs the next session ---
//
// THE CONCURRENCY PROBLEM THIS SOLVES, STATED PLAINLY
// Choosing an account is a read-then-write across an await: read the pool, pick the best,
// then dispatch a workflow that takes seconds to come back. JavaScript being
// single-threaded does not help here at all — it only guarantees that no two lines
// interleave, and the gap between "picked #2" and "#2 is now busy" is not a line, it is
// several network round trips. Two clicks, or a click landing on top of the watchdog
// rebuilding, and both allocations read the same pool state and both pick account #2.
// The result is two billable Windows runners on one account for one tunnel — the exact
// thing the pool exists to avoid.
//
// So an account is LEASED, synchronously, in the same tick it is chosen. The lease is
// taken before any await, which makes the choice atomic with respect to every other
// caller. A lease that is never released (a crash mid-dispatch, an exception nobody
// catches) expires on its own, because the alternative is an account that is permanently
// unavailable with nothing running on it.
//
// SELECTION IS NOT ROUND-ROBIN
// Cycling 1 -> 2 -> 3 spreads load evenly, which is precisely wrong here: it spends every
// account's allowance at the same rate, so they all run out in the same week. It also
// keeps re-picking an account that is failing. Accounts are scored instead, and the score
// is dominated by "can this actually work right now".

const accounts = require('./gt-accounts');
const quota = require('./gt-quota');

// Long enough to cover a slow dispatch (the workflow-run lookup alone can take ~18s), far
// shorter than a session. Renewed while a create is in flight.
const LEASE_TTL_MS = 3 * 60 * 1000;

// accountId -> { until, reason }
const leases = new Map();

function leaseActive(id, now = Date.now()) {
    const l = leases.get(id);
    if (!l) return false;
    if (l.until <= now) { leases.delete(id); return false; }
    return true;
}

/** Take the lease. SYNCHRONOUS and must stay that way — an await in here reopens the race
 *  it exists to close. */
function acquire(id, reason = '') {
    if (leaseActive(id)) return false;
    leases.set(id, { until: Date.now() + LEASE_TTL_MS, reason });
    return true;
}

function renew(id) {
    if (!leases.has(id)) return false;
    leases.set(id, { ...leases.get(id), until: Date.now() + LEASE_TTL_MS });
    return true;
}

function release(id) {
    return leases.delete(id);
}

function leasedIds() {
    const now = Date.now();
    return [...leases.keys()].filter(id => leaseActive(id, now));
}

// ── scoring ─────────────────────────────────────────────────────────────────────────

/**
 * Higher is better. Anything that cannot be used at all returns null and is not ranked.
 *
 * `busyIds` are accounts already hosting a live session. They are ranked LAST rather than
 * excluded: with a single account in the pool — which is every existing user — excluding
 * it would mean "renew" could never find anywhere to run, and the feature would regress
 * for exactly the people who never asked for a pool.
 */
function score(a, { busyIds = [], now = Date.now() } = {}) {
    if (!accounts.isSelectable(a, now)) return null;

    let s = 1000;

    // 1. Known-empty accounts go to the very back. Not excluded: a measured zero is the
    //    only reliable exhaustion signal, and if EVERY account reads empty we would rather
    //    try one and let GitHub give the real answer than refuse to try at all.
    if (quota.isExhausted(a.quota)) s -= 10000;

    // 2. Free capacity, when it is actually known. Estimates are deliberately NOT used to
    //    rank: an estimate is a lower bound on spend with no allowance to compare against,
    //    so ordering by it would rank "an account we have watched closely" below "an
    //    account we know nothing about", which is backwards.
    const sessions = quota.sessionsRemaining(a.quota);
    if (sessions != null) s += Math.min(sessions, 20) * 40;
    else if (a.quota && a.quota.source === 'unknown') s -= 5;   // mild: unknown is normal

    // 3. Recent trouble. markUnhealthy already applies a cooldown; this keeps a flaky
    //    account behind a clean one even after the cooldown lapses.
    s -= Math.min(a.consecutiveFailures || 0, 5) * 120;
    if (a.health && a.health !== accounts.HEALTH.OK && a.health !== accounts.HEALTH.UNKNOWN) s -= 200;

    // 4. Already carrying a session.
    if (busyIds.includes(a.id)) s -= 3000;

    // 5. Least-recently-used tiebreak, so a pool of equals rotates instead of hammering
    //    whichever one happens to sort first. Capped at a week so an account untouched for
    //    a year does not outrank a healthy one on age alone.
    const idleMs = now - (a.lastUsedAt || 0);
    s += Math.min(idleMs, 7 * 24 * 3600 * 1000) / (24 * 3600 * 1000) * 10;

    return s;
}

/** Every account, ranked, with the reason each unusable one was skipped. Drives the UI. */
function rank({ busyIds = [] } = {}) {
    const now = Date.now();
    const all = accounts.list();
    const ranked = [];
    const skipped = [];
    for (const a of all) {
        const sc = score(a, { busyIds, now });
        if (sc === null) {
            skipped.push({ id: a.id, login: a.login, reason: skipReason(a, now) });
        } else if (leaseActive(a.id, now)) {
            skipped.push({ id: a.id, login: a.login, reason: 'ALLOCATING' });
        } else {
            ranked.push({ account: a, score: sc });
        }
    }
    ranked.sort((x, y) => y.score - x.score);
    return { ranked, skipped };
}

function skipReason(a, now = Date.now()) {
    if (!a.token) return 'NO_TOKEN';
    if (a.disabled) return 'DISABLED';
    if (a.health === accounts.HEALTH.AUTH_REQUIRED) return 'AUTH_REQUIRED';
    if (accounts.inCooldown(a, now)) return a.health || 'COOLDOWN';
    return 'UNAVAILABLE';
}

/**
 * Claim the best available account for a new session.
 *
 * The lease is taken in the SAME synchronous block as the choice — that is the whole
 * point. Callers must release() when done, and every failure path in gt-deployer.js does.
 *
 * @param exclude ids already tried in this attempt, so a failover never re-picks one
 * @returns the account, already leased, or null when the pool has nothing to offer
 */
function claim({ busyIds = [], exclude = [] } = {}) {
    const { ranked, skipped } = rank({ busyIds });
    for (const { account } of ranked) {
        if (exclude.includes(account.id)) continue;
        if (acquire(account.id, 'create-session')) return { account, skipped };
    }
    return { account: null, skipped };
}

/** Why the pool could not offer anything — so the UI says the true reason instead of a
 *  generic failure. */
function explainEmptyPool() {
    const all = accounts.list();
    if (!all.length) return { code: 'NO_ACCOUNTS', message: 'هیچ حساب گیت‌هابی متصل نیست. یک حساب اضافه کنید.' };

    const now = Date.now();
    const authNeeded = all.filter(a => a.health === accounts.HEALTH.AUTH_REQUIRED);
    const cooling = all.filter(a => accounts.inCooldown(a, now));
    const exhausted = all.filter(a => quota.isExhausted(a.quota));

    if (exhausted.length === all.length) {
        return {
            code: 'ALL_EXHAUSTED',
            message: 'سهمیه‌ی ماهانه‌ی همه‌ی حساب‌های گیت‌هاب تمام شده است. یک حساب دیگر اضافه کنید یا تا شروع دوره‌ی بعد صبر کنید.',
        };
    }
    if (authNeeded.length === all.length) {
        return {
            code: 'ALL_AUTH_REQUIRED',
            message: 'دسترسی همه‌ی حساب‌های گیت‌هاب منقضی شده است. حداقل یک حساب را دوباره متصل کنید.',
        };
    }
    if (cooling.length) {
        const soonest = Math.min(...cooling.map(a => a.cooldownUntil));
        const mins = Math.max(1, Math.ceil((soonest - now) / 60000));
        return {
            code: 'ALL_COOLING_DOWN',
            message: `همه‌ی حساب‌ها موقتاً در حالت انتظار هستند (حدود ${mins} دقیقه‌ی دیگر دوباره تلاش کنید).`,
        };
    }
    return { code: 'NONE_AVAILABLE', message: 'هیچ حساب گیت‌هاب قابل استفاده‌ای پیدا نشد.' };
}

/**
 * Classify a GitHub failure so the pool reacts correctly.
 *
 * Getting this mapping wrong is what turns failover into either an infinite retry or a
 * dead pool, so each branch names the evidence it keys on.
 */
function classifyFailure(err) {
    const msg = ((err && err.message) || '').toLowerCase();
    const status = err && err.status;

    // A 401 that came back over the fallback proxy is not evidence about the token at all
    // (gt-net.js) — the proxy may simply not forward Authorization. Retryable, and the
    // account must NOT be marked dead.
    if (err && err.code === 'PROXY_AUTH_STRIPPED') return { health: null, retryable: true, sameAccount: true };

    if (status === 401 || /bad credentials|requires authentication/.test(msg)) {
        return { health: accounts.HEALTH.AUTH_REQUIRED, retryable: true, sameAccount: false };
    }
    // Missing scope reads as 403/404 with a scope complaint. Same remedy as a dead token:
    // the user has to re-authorise.
    if (/scope|not accessible by personal access token|resource not accessible/.test(msg)) {
        return { health: accounts.HEALTH.AUTH_REQUIRED, retryable: true, sameAccount: false };
    }
    if (status === 429 || /rate limit|secondary rate/.test(msg)) {
        return { health: accounts.HEALTH.RATE_LIMITED, retryable: true, sameAccount: false };
    }
    if (/spending limit|billing|payment|minutes|quota|exceeded/.test(msg)) {
        return { health: accounts.HEALTH.EXHAUSTED, retryable: true, sameAccount: false };
    }
    if (err && err.code === 'RUN_DIED_EARLY') {
        // A run that started and died instantly is, overwhelmingly, the allowance wall —
        // GitHub does not always say so in words, but it is the only thing that reliably
        // kills a job before it does anything.
        return { health: accounts.HEALTH.EXHAUSTED, retryable: true, sameAccount: false };
    }
    // Infrastructure, shared by every account: the Cloudflare relay, its signing secret,
    // the Tailscale client behind it. Trying another GitHub account cannot possibly help —
    // it walks the entire pool, fails identically on each, and leaves ten healthy accounts
    // marked broken over a fault that belongs to none of them.
    if (err && (err.code === 'BROKER_NOT_DEPLOYED' || err.code === 'BROKER_UNAVAILABLE'
        || err.code === 'ACL_TAG_NOT_PERMITTED')) {
        return { health: null, retryable: false, sameAccount: false };
    }
    if (status === 404 || /repository|workflow|not found/.test(msg)) {
        return { health: accounts.HEALTH.REPO_ERROR, retryable: true, sameAccount: false };
    }
    return { health: accounts.HEALTH.DISPATCH_FAILED, retryable: true, sameAccount: false };
}

module.exports = {
    claim, release, renew, acquire, rank, score, leasedIds, leaseActive,
    explainEmptyPool, classifyFailure, skipReason,
    LEASE_TTL_MS,
    _leases: leases,
};
