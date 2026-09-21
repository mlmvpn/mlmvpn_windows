// --- GitHub Tunnel: the GitHub account pool ---
//
// WHY THIS EXISTS
// A GitHub-hosted Windows runner is billed against the account that owns the repository,
// and the included allowance is per account and per month. One account is therefore a
// fixed, exhaustible amount of tunnel time. The pool turns "the user's GitHub account"
// into "a set of interchangeable Actions capacity sources", so running out on one is a
// routing decision rather than the end of the feature.
//
// WHAT AN ACCOUNT IS AND IS NOT
// An account owns exactly four things: its OAuth token, its private repository, the
// workflow file in it, and the runs it dispatches. It owns NOTHING below that line — the
// Cloudflare broker, its signing secret, the Tailscale OAuth client, the tailnet, the tag,
// the local engine, the kill-switch and the watchdog are all shared by every account and
// completely unaware that more than one exists. That is not an accident of this design, it
// is a property of the existing one: gt-broker.js sends a sessionId and a signature and
// nothing else, so nothing in the tunnel data plane can tell which GitHub account produced
// the runner it is talking to. Adding accounts therefore adds no infrastructure.
//
// HEALTH IS STICKY, ON PURPOSE
// An account that just failed must not be picked again on the next attempt — otherwise a
// failover loop is just a retry loop with extra steps, and a broken account gets tried
// forever while working ones sit idle. So failures are recorded on the account, they
// decay on a cooldown, and the allocator reads them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { protect, unprotect, isProtected } = require('./gt-crypto');

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STORE_FILE = path.join(HOME_DIR, 'github-tunnel-accounts.json');
const LEGACY_FILE = path.join(HOME_DIR, 'github-tunnel-account.json');

// Every state an account can be in from the allocator's point of view. Anything not OK is
// a reason not to pick it, and each one carries a different remedy for the user.
const HEALTH = {
    OK: 'OK',
    UNKNOWN: 'UNKNOWN',                 // never checked yet
    AUTH_REQUIRED: 'AUTH_REQUIRED',     // token revoked, expired or under-scoped
    REPO_ERROR: 'REPO_ERROR',           // repo or workflow could not be prepared
    RATE_LIMITED: 'RATE_LIMITED',       // GitHub API secondary/primary rate limit
    EXHAUSTED: 'EXHAUSTED',             // Actions allowance spent for this cycle
    DISPATCH_FAILED: 'DISPATCH_FAILED', // ran but died immediately, cause unclear
};

// How long an account stays out of the running after each kind of failure. A rate limit
// clears itself in minutes; a spent allowance does not clear until the billing cycle rolls,
// and retrying it before then only burns API calls and the user's patience.
const COOLDOWN_MS = {
    [HEALTH.RATE_LIMITED]: 15 * 60 * 1000,
    [HEALTH.DISPATCH_FAILED]: 10 * 60 * 1000,
    [HEALTH.REPO_ERROR]: 30 * 60 * 1000,
    [HEALTH.EXHAUSTED]: 6 * 60 * 60 * 1000,  // re-probed every 6h in case a limit was raised
    [HEALTH.AUTH_REQUIRED]: 0,               // needs the USER, not time — never auto-retried
};

// ── storage ─────────────────────────────────────────────────────────────────────────

function load() {
    let stored = {};
    try {
        stored = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`[github-tunnel] account store unreadable (${e.message}) — starting empty`);
    }
    return {
        version: stored.version || 2,
        accounts: Array.isArray(stored.accounts) ? stored.accounts : [],
    };
}

function save(cfg) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    return cfg;
}

// Decrypting through DPAPI costs ~300ms, which is fine once and absurd on every GitHub API
// call. Cached per account id for the life of the process, and dropped whenever the stored
// value changes.
const tokenCache = new Map();

function currentCycle(now = Date.now()) {
    const d = new Date(now);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function blankAccount(fields = {}) {
    return {
        id: fields.id || `acc_${crypto.randomBytes(6).toString('hex')}`,
        login: fields.login || '',
        name: fields.name || fields.login || '',
        avatarUrl: fields.avatarUrl || '',
        token: '',
        scopes: fields.scopes || '',
        connectedAt: fields.connectedAt || Date.now(),
        // Filled in the first time a session is built on this account.
        repository: fields.repository || '',
        defaultBranch: fields.defaultBranch || 'main',
        workflowSyncedAt: 0,
        health: HEALTH.UNKNOWN,
        healthReason: '',
        healthSince: Date.now(),
        cooldownUntil: 0,
        consecutiveFailures: 0,
        lastUsedAt: 0,
        lastCheckedAt: 0,
        // Never invented. See gt-quota.js — `source` says where each number came from and
        // 'unknown' is a legitimate, displayable answer.
        quota: { source: 'unknown', includedMinutes: null, usedMinutes: null, remainingMinutes: null, cycle: currentCycle(), checkedAt: 0, note: '' },
        // Kept per cycle and NEVER pruned on rollover: "how much did August cost me" is the
        // question the whole pool exists to answer.
        usage: {},
        disabled: false,
    };
}

// ── migration ───────────────────────────────────────────────────────────────────────

/**
 * Fold the single account written by earlier builds into the pool.
 *
 * Runs at most once and is idempotent. The legacy file is left on disk rather than
 * deleted: if this migration is ever wrong, the original is the only way back, and an
 * orphaned 300-byte file is a much smaller problem than a user who has to re-authorise.
 */
function migrateLegacy() {
    const cfg = load();
    if (cfg.accounts.length) return cfg;

    let legacy;
    try { legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf8')); } catch (e) { return cfg; }
    const a = legacy && legacy.account;
    if (!a || !a.token) return cfg;

    const account = blankAccount({
        login: a.login, name: a.name, avatarUrl: a.avatarUrl,
        scopes: a.scope || '', connectedAt: a.connectedAt,
    });
    account.token = protect(a.token);
    account.health = HEALTH.UNKNOWN;
    cfg.accounts.push(account);
    save(cfg);
    return cfg;
}

// ── reads ───────────────────────────────────────────────────────────────────────────

function list() {
    return migrateLegacy().accounts;
}

function get(id) {
    return list().find(a => a.id === id) || null;
}

function getByLogin(login) {
    const l = String(login || '').toLowerCase();
    return list().find(a => String(a.login).toLowerCase() === l) || null;
}

function count() {
    return list().length;
}

/** The decrypted token. The ONLY place a token leaves this module. */
function token(id) {
    if (tokenCache.has(id)) return tokenCache.get(id);
    const a = get(id);
    if (!a || !a.token) return '';
    const plain = unprotect(a.token);
    if (plain) tokenCache.set(id, plain);
    return plain;
}

// ── writes ──────────────────────────────────────────────────────────────────────────

function update(id, patch = {}) {
    const cfg = load();
    const idx = cfg.accounts.findIndex(a => a.id === id);
    if (idx === -1) return null;
    // id and connectedAt are identity, not state — a patch must never rewrite them.
    const { id: _i, connectedAt: _c, token: _t, ...safe } = patch;
    cfg.accounts[idx] = { ...cfg.accounts[idx], ...safe };
    save(cfg);
    return cfg.accounts[idx];
}

/**
 * Add an account, or refresh the credential on one already present.
 *
 * Keyed on login, not on the token: re-authorising produces a brand new token for the same
 * GitHub identity, and treating that as a new account would duplicate the row, split its
 * usage history in two and let the allocator schedule the same allowance twice.
 */
function upsert({ login, name, avatarUrl, scopes, token: plainToken }) {
    if (!login || !plainToken) throw new Error('account needs a login and a token');
    const cfg = load();
    const idx = cfg.accounts.findIndex(a => String(a.login).toLowerCase() === String(login).toLowerCase());

    if (idx === -1) {
        const account = blankAccount({ login, name, avatarUrl, scopes });
        account.token = protect(plainToken);
        cfg.accounts.push(account);
        save(cfg);
        tokenCache.set(account.id, plainToken);
        return { account, created: true };
    }

    const existing = cfg.accounts[idx];
    existing.token = protect(plainToken);
    existing.scopes = scopes || existing.scopes;
    existing.name = name || existing.name;
    existing.avatarUrl = avatarUrl || existing.avatarUrl;
    // A fresh credential clears exactly the failures a fresh credential can fix.
    if (existing.health === HEALTH.AUTH_REQUIRED) {
        existing.health = HEALTH.UNKNOWN;
        existing.healthReason = '';
        existing.healthSince = Date.now();
        existing.cooldownUntil = 0;
        existing.consecutiveFailures = 0;
    }
    save(cfg);
    tokenCache.set(existing.id, plainToken);
    return { account: existing, created: false };
}

function remove(id) {
    const cfg = load();
    const before = cfg.accounts.length;
    cfg.accounts = cfg.accounts.filter(a => a.id !== id);
    if (cfg.accounts.length === before) return false;
    save(cfg);
    tokenCache.delete(id);
    return true;
}

// ── health ──────────────────────────────────────────────────────────────────────────

/**
 * Record that an account failed, and take it out of the running for as long as that kind
 * of failure deserves.
 *
 * AUTH_REQUIRED gets no cooldown at all, deliberately: no amount of waiting fixes a
 * revoked token, so it stays out until the user re-authorises. Anything else would have
 * the allocator quietly re-picking a dead account every fifteen minutes forever.
 */
function markUnhealthy(id, health, reason = '') {
    const a = get(id);
    if (!a) return null;
    const base = COOLDOWN_MS[health] !== undefined ? COOLDOWN_MS[health] : 10 * 60 * 1000;
    const failures = (a.consecutiveFailures || 0) + 1;
    // Backing off on repeats, capped, so a persistently sick account drifts to the back of
    // the queue instead of being retried at a fixed rate forever.
    const backoff = base ? Math.min(base * Math.pow(2, Math.min(failures - 1, 3)), 12 * 60 * 60 * 1000) : 0;
    return update(id, {
        health,
        healthReason: String(reason || '').slice(0, 300),
        healthSince: Date.now(),
        consecutiveFailures: failures,
        cooldownUntil: backoff ? Date.now() + backoff : 0,
    });
}

function markHealthy(id, patch = {}) {
    return update(id, {
        health: HEALTH.OK,
        healthReason: '',
        healthSince: Date.now(),
        consecutiveFailures: 0,
        cooldownUntil: 0,
        lastCheckedAt: Date.now(),
        ...patch,
    });
}

function markUsed(id) {
    return update(id, { lastUsedAt: Date.now() });
}

function inCooldown(a, now = Date.now()) {
    return !!(a && a.cooldownUntil && a.cooldownUntil > now);
}

/** Available to take a NEW session right now. Says nothing about sessions already running
 *  on it — an exhausted account keeps its live session (see gt-allocator.js). */
function isSelectable(a, now = Date.now()) {
    if (!a || a.disabled) return false;
    if (!a.token) return false;
    if (a.health === HEALTH.AUTH_REQUIRED) return false;
    if (inCooldown(a, now)) return false;
    return true;
}

// ── usage history ───────────────────────────────────────────────────────────────────

/**
 * Fold an observation into the account's history for a billing cycle.
 *
 * History is keyed by cycle and never overwritten downwards: usage only ever grows within
 * a month, so a lower reading is a worse measurement, not a refund.
 */
function recordUsage(id, cycle, { estimatedMinutes, measuredMinutes, sessionsDelta = 0 } = {}) {
    const a = get(id);
    if (!a) return null;
    const usage = { ...(a.usage || {}) };
    const prev = usage[cycle] || { estimatedMinutes: 0, measuredMinutes: null, sessions: 0 };
    usage[cycle] = {
        estimatedMinutes: estimatedMinutes != null
            ? Math.max(prev.estimatedMinutes || 0, Math.round(estimatedMinutes))
            : (prev.estimatedMinutes || 0),
        measuredMinutes: measuredMinutes != null
            ? Math.max(prev.measuredMinutes || 0, Math.round(measuredMinutes))
            : (prev.measuredMinutes === undefined ? null : prev.measuredMinutes),
        sessions: (prev.sessions || 0) + sessionsDelta,
        updatedAt: Date.now(),
    };
    return update(id, { usage });
}

// ── presentation ────────────────────────────────────────────────────────────────────

/**
 * Everything the UI needs and NOTHING it must never see.
 *
 * The token is not in this object and must never be added to it: this shape crosses the
 * local HTTP API, gets logged by the panel on error, and ends up in screenshots users send
 * for support. `hasToken` and `tokenProtected` answer every question the UI actually has.
 */
function publicAccount(a, { activeSessionId = null, inUse = false } = {}) {
    if (!a) return null;
    const cycle = currentCycle();
    const usage = (a.usage && a.usage[cycle]) || null;
    return {
        id: a.id,
        login: a.login,
        name: a.name || a.login,
        avatarUrl: a.avatarUrl || '',
        hasToken: !!a.token,
        tokenProtected: isProtected(a.token),
        // The scope STRING is not a credential — it is what tells the user why a quota
        // number is missing and what re-authorising would buy them.
        scopes: a.scopes || '',
        canReadBilling: /(^|,\s*)user(:|,|$)/.test(a.scopes || '') || /(^|,\s*)user$/.test(a.scopes || ''),
        repository: a.repository || '',
        health: a.health,
        healthReason: a.healthReason || '',
        cooldownUntil: a.cooldownUntil || 0,
        cooldownRemainingMs: Math.max(0, (a.cooldownUntil || 0) - Date.now()),
        consecutiveFailures: a.consecutiveFailures || 0,
        lastUsedAt: a.lastUsedAt || 0,
        disabled: !!a.disabled,
        quota: a.quota || null,
        cycle,
        cycleUsage: usage,
        usageHistory: a.usage || {},
        activeSessionId,
        inUse,
    };
}

module.exports = {
    HEALTH, COOLDOWN_MS,
    list, get, getByLogin, count, token, upsert, update, remove,
    markUnhealthy, markHealthy, markUsed, inCooldown, isSelectable,
    recordUsage, currentCycle, publicAccount, blankAccount,
    STORE_FILE, LEGACY_FILE, migrateLegacy,
    _tokenCache: tokenCache,
};
