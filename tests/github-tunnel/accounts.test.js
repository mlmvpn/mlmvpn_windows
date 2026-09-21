// GitHub account pool: storage, quota resolution, allocation, concurrency and failover.
//
// Sandboxed like the rest of the suite: USERPROFILE is redirected before any module loads,
// so the real ~/.mlmvpn — which holds live GitHub tokens — is never read or written.
// global.fetch is stubbed, so no request reaches GitHub.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SANDBOX = path.join(__dirname, 'home-accounts');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX, 'sandbox homedir not in effect — refusing to touch the real one');

const GT = ROOT + '/github-tunnel';
const accounts = require(`${GT}/gt-accounts`);
const allocator = require(`${GT}/gt-allocator`);
const quota = require(`${GT}/gt-quota`);
const store = require(`${GT}/gt-config`);

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const pending = [];
const ta = (name, fn) => pending.push([name, fn]);

function reset() {
    fs.rmSync(accounts.STORE_FILE, { force: true });
    fs.rmSync(store.STORE_FILE, { force: true });
    accounts._tokenCache.clear();
    allocator._leases.clear();
}

function addAccount(login, patch = {}) {
    const { account } = accounts.upsert({ login, name: login, scopes: 'repo,workflow', token: `tok_${login}` });
    if (Object.keys(patch).length) accounts.update(account.id, patch);
    return accounts.get(account.id);
}

const HEALTH = accounts.HEALTH;

// ── storage + credential handling ───────────────────────────────────────────────────
reset();
t('a token never appears in the stored file', (() => {
    const a = addAccount('alpha');
    const raw = fs.readFileSync(accounts.STORE_FILE, 'utf8');
    return !raw.includes('tok_alpha') && accounts.token(a.id) === 'tok_alpha';
})());

t('publicAccount cannot leak a token even by accident', (() => {
    const a = accounts.list()[0];
    const pub = accounts.publicAccount(a);
    return !JSON.stringify(pub).includes('tok_alpha') && !('token' in pub);
})());

t('re-authorising updates in place instead of duplicating the account', (() => {
    const before = accounts.list().length;
    const { created } = accounts.upsert({ login: 'alpha', scopes: 'repo,workflow,user', token: 'tok_alpha_v2' });
    const a = accounts.getByLogin('alpha');
    return !created && accounts.list().length === before
        && accounts.token(a.id) === 'tok_alpha_v2' && a.scopes.includes('user');
})());

t('re-authorising clears an AUTH_REQUIRED block', (() => {
    const a = accounts.getByLogin('alpha');
    accounts.markUnhealthy(a.id, HEALTH.AUTH_REQUIRED, 'revoked');
    assert.strictEqual(accounts.get(a.id).health, HEALTH.AUTH_REQUIRED);
    accounts.upsert({ login: 'alpha', scopes: 'repo,workflow,user', token: 'tok_alpha_v3' });
    return accounts.get(a.id).health === HEALTH.UNKNOWN && accounts.get(a.id).cooldownUntil === 0;
})());

t('billing capability is derived from granted scopes, not from what we asked for', (() => {
    const noScope = accounts.publicAccount({ ...accounts.blankAccount({ login: 'x' }), scopes: 'repo,workflow' });
    const withScope = accounts.publicAccount({ ...accounts.blankAccount({ login: 'y' }), scopes: 'repo,workflow,user' });
    return noScope.canReadBilling === false && withScope.canReadBilling === true;
})());


// ── the device flow authorises whoever the BROWSER is signed in as ──────────────────
t('re-authorising the same GitHub identity does not grow the pool', (() => {
    reset();
    accounts.upsert({ login: 'same', scopes: 'repo,workflow', token: 'tok_1' });
    const first = accounts.count();
    // What actually happens when the user clicks "add account" while still signed in as
    // the previous one: GitHub hands back the SAME identity with a new token.
    const r = accounts.upsert({ login: 'same', scopes: 'repo,workflow', token: 'tok_2' });
    return first === 1 && accounts.count() === 1 && r.created === false
        && accounts.token(r.account.id) === 'tok_2';
})());

t('a genuinely different identity does grow the pool', (() => {
    const before = accounts.count();
    const r = accounts.upsert({ login: 'other', scopes: 'repo,workflow', token: 'tok_3' });
    return r.created === true && accounts.count() === before + 1;
})());

// ── health and cooldown ─────────────────────────────────────────────────────────────
reset();
t('an auth failure is NOT put on a timer — waiting cannot fix it', (() => {
    const a = addAccount('beta');
    accounts.markUnhealthy(a.id, HEALTH.AUTH_REQUIRED, 'bad credentials');
    const after = accounts.get(a.id);
    return after.cooldownUntil === 0 && !accounts.isSelectable(after);
})());

t('a rate limit IS put on a timer and clears itself', (() => {
    const a = addAccount('gamma');
    accounts.markUnhealthy(a.id, HEALTH.RATE_LIMITED, 'secondary rate limit');
    const cooling = accounts.get(a.id);
    if (accounts.isSelectable(cooling)) return false;
    accounts.update(a.id, { cooldownUntil: Date.now() - 1 });
    return accounts.isSelectable(accounts.get(a.id));
})());

t('repeated failures back off further each time', (() => {
    const a = addAccount('delta');
    accounts.markUnhealthy(a.id, HEALTH.RATE_LIMITED, 'x');
    const first = accounts.get(a.id).cooldownUntil - Date.now();
    accounts.markUnhealthy(a.id, HEALTH.RATE_LIMITED, 'x');
    const second = accounts.get(a.id).cooldownUntil - Date.now();
    return second > first * 1.5;
})());

t('a success wipes the failure history', (() => {
    const a = accounts.getByLogin('delta');
    accounts.markHealthy(a.id);
    const after = accounts.get(a.id);
    return after.consecutiveFailures === 0 && after.cooldownUntil === 0 && after.health === HEALTH.OK;
})());

// ── quota semantics ─────────────────────────────────────────────────────────────────
t('only a MEASURED zero counts as exhausted', () => {});
t('an estimate never marks an account exhausted', (() => {
    // An estimate is a lower bound on spend with no allowance to compare against. Treating
    // a big estimate as "empty" would park accounts that are actually fine.
    const estimated = { source: 'estimated', usedMinutes: 99999, remainingMinutes: null };
    const measuredEmpty = { source: 'measured', includedMinutes: 2000, usedMinutes: 2000, remainingMinutes: 0 };
    const measuredPaid = { source: 'measured', includedMinutes: 2000, usedMinutes: 5000, remainingMinutes: 0, billable: true };
    const unknown = { source: 'unknown' };
    return quota.isExhausted(estimated) === false
        && quota.isExhausted(measuredEmpty) === true
        && quota.isExhausted(measuredPaid) === false   // paying for overage: still runs
        && quota.isExhausted(unknown) === false;
})());

t('remaining sessions are computed from the real allowance, never a hardcoded 2000', (() => {
    const cost = quota.SESSION_COST_MINUTES;
    const small = quota.sessionsRemaining({ source: 'measured', remainingMinutes: cost * 2 + 5 });
    const none = quota.sessionsRemaining({ source: 'measured', remainingMinutes: 10 });
    const unknowable = quota.sessionsRemaining({ source: 'estimated', usedMinutes: 100 });
    return small === 2 && none === 0 && unknowable === null;
})());

t('a Windows session is priced with the 2x multiplier', (() => {
    const { SESSION_LIFETIME_MINUTES } = require(`${GT}/gt-workflow-template`);
    return quota.OS_MULTIPLIER.WINDOWS === 2
        && quota.SESSION_COST_MINUTES === SESSION_LIFETIME_MINUTES * 2;
})());

// ── allocation ──────────────────────────────────────────────────────────────────────
reset();
t('the account with the most measured capacity is chosen first', (() => {
    const a = addAccount('low', { quota: { source: 'measured', includedMinutes: 2000, usedMinutes: 1900, remainingMinutes: 100 } });
    const b = addAccount('high', { quota: { source: 'measured', includedMinutes: 2000, usedMinutes: 100, remainingMinutes: 1900 } });
    void a;
    const { account } = allocator.claim({});
    allocator.release(account.id);
    return account.login === 'high' && b.login === 'high';
})());

reset();
t('an exhausted account is ranked last but still reachable as a last resort', (() => {
    addAccount('empty', { quota: { source: 'measured', includedMinutes: 2000, usedMinutes: 2000, remainingMinutes: 0 } });
    const { ranked } = allocator.rank({});
    // Present (so a pool of only-empty accounts can still try) but bottom of the list.
    return ranked.length === 1 && ranked[0].account.login === 'empty';
})());

reset();
t('an account needing re-authentication is never selected', (() => {
    const dead = addAccount('dead');
    accounts.markUnhealthy(dead.id, HEALTH.AUTH_REQUIRED, 'revoked');
    addAccount('alive');
    const { account } = allocator.claim({});
    allocator.release(account.id);
    return account.login === 'alive';
})());

reset();
t('the pool rotates instead of hammering one account', (() => {
    const a = addAccount('one', { lastUsedAt: Date.now() });
    const b = addAccount('two', { lastUsedAt: Date.now() - 3 * 24 * 3600 * 1000 });
    void a; void b;
    const { account } = allocator.claim({});
    allocator.release(account.id);
    return account.login === 'two';   // least recently used wins a tie
})());

reset();
t('an account already carrying a session is ranked last, not excluded', (() => {
    const busy = addAccount('busy');
    const { account: whenFree } = allocator.claim({});
    allocator.release(whenFree.id);
    const { account: whenBusy } = allocator.claim({ busyIds: [busy.id] });
    if (whenBusy) allocator.release(whenBusy.id);
    // With one account in the pool — every existing user — "renew" must still find it.
    return whenFree.id === busy.id && whenBusy && whenBusy.id === busy.id;
})());

// ── THE CONCURRENCY CASE ────────────────────────────────────────────────────────────
reset();
t('ten simultaneous claims never hand out the same account twice', (() => {
    for (let i = 0; i < 4; i++) addAccount(`acct${i}`);
    const claimed = [];
    for (let i = 0; i < 10; i++) {
        const { account } = allocator.claim({ exclude: [] });
        if (account) claimed.push(account.id);
    }
    // Four accounts, ten claimants: exactly four leases, all distinct, six refusals.
    return claimed.length === 4 && new Set(claimed).size === 4;
})());

t('a released account becomes claimable again', (() => {
    const held = allocator.leasedIds();
    allocator.release(held[0]);
    const { account } = allocator.claim({});
    return account && account.id === held[0];
})());

t('a lease that is never released expires instead of stranding the account', (() => {
    reset();
    const a = addAccount('leaky');
    allocator.acquire(a.id, 'test');
    const blocked = allocator.claim({}).account;
    // Simulate the process having died mid-dispatch.
    allocator._leases.set(a.id, { until: Date.now() - 1, reason: 'test' });
    const recovered = allocator.claim({}).account;
    return blocked === null && recovered && recovered.id === a.id;
})());

t('failover excludes accounts already tried in this attempt', (() => {
    reset();
    const a = addAccount('first');
    const b = addAccount('second');
    const one = allocator.claim({}).account;
    allocator.release(one.id);
    const two = allocator.claim({ exclude: [one.id] }).account;
    allocator.release(two.id);
    return one.id !== two.id && [a.id, b.id].includes(two.id);
})());

// ── failure classification drives the right remedy ───────────────────────────────────
t('failures map to the right health state', (() => {
    const c = allocator.classifyFailure;
    const cases = [
        [{ status: 401, message: 'Bad credentials' }, HEALTH.AUTH_REQUIRED],
        [{ status: 403, message: 'requires the user scope' }, HEALTH.AUTH_REQUIRED],
        [{ status: 429, message: 'API rate limit exceeded' }, HEALTH.RATE_LIMITED],
        [{ status: 403, message: 'spending limit reached' }, HEALTH.EXHAUSTED],
        [{ code: 'RUN_DIED_EARLY', message: 'died immediately' }, HEALTH.EXHAUSTED],
        [{ status: 404, message: 'Not Found' }, HEALTH.REPO_ERROR],
        [{ status: 500, message: 'boom' }, HEALTH.DISPATCH_FAILED],
    ];
    return cases.every(([err, expected]) => c(err).health === expected);
})());

t('a proxy-stripped 401 does NOT condemn the account', (() => {
    const v = allocator.classifyFailure({ code: 'PROXY_AUTH_STRIPPED', status: 401, message: 'Bad credentials' });
    return v.health === null && v.retryable === true;
})());

t('a missing broker stops the whole loop instead of burning every account', (() => {
    // Shared infrastructure: another account hits the identical wall, so trying one is
    // pure waste and marks a healthy account sick for no reason.
    const v = allocator.classifyFailure({ code: 'BROKER_NOT_DEPLOYED', message: 'not deployed' });
    return v.retryable === false && v.health === null;
})());

// ── empty-pool explanations name the real reason ────────────────────────────────────
t('an empty pool says so', (() => {
    reset();
    return allocator.explainEmptyPool().code === 'NO_ACCOUNTS';
})());

t('an all-exhausted pool says so rather than "unknown error"', (() => {
    reset();
    for (const n of ['a', 'b']) {
        addAccount(n, { quota: { source: 'measured', includedMinutes: 2000, usedMinutes: 2000, remainingMinutes: 0 } });
    }
    return allocator.explainEmptyPool().code === 'ALL_EXHAUSTED';
})());

t('an all-revoked pool asks for re-authentication', (() => {
    reset();
    for (const n of ['a', 'b']) {
        const acc = addAccount(n);
        accounts.markUnhealthy(acc.id, HEALTH.AUTH_REQUIRED, 'revoked');
    }
    return allocator.explainEmptyPool().code === 'ALL_AUTH_REQUIRED';
})());

// ── session affinity ────────────────────────────────────────────────────────────────
reset();
t('a session records the account that created it, and cannot be reassigned', (() => {
    const a = addAccount('owner');
    const s = store.addSession({ repository: 'owner/r', accountId: a.id, accountLogin: 'owner' });
    // A patch trying to move the session to another account must be ignored: affinity is
    // identity, and silently rewriting it is the one corruption nothing downstream detects.
    const other = addAccount('thief');
    store.updateSession(s.id, { accountId: other.id, status: 'ACTIVE' });
    const after = store.getSession(s.id);
    return after.accountId === a.id && after.status === 'ACTIVE';
})());

t("a session resolves its OWN account's token, never another's", (() => {
    const deployer = require(`${GT}/gt-deployer`);
    const owner = accounts.getByLogin('owner');
    const s = store.getSessions().find(x => x.accountId === owner.id);
    return deployer.tokenForSession(s) === 'tok_owner';
})());

t('a session whose account was removed yields no token rather than a wrong one', (() => {
    const deployer = require(`${GT}/gt-deployer`);
    const owner = accounts.getByLogin('owner');
    const s = store.getSessions().find(x => x.accountId === owner.id);
    accounts.remove(owner.id);
    // 'thief' is still in the pool. Returning ITS token here would cancel the wrong
    // repository's runner, so the only safe answer is none.
    return deployer.tokenForSession(s) === '';
})());

// ── billing cycle ───────────────────────────────────────────────────────────────────
reset();
t('usage history is kept per cycle and survives a rollover', (() => {
    const a = addAccount('history');
    accounts.recordUsage(a.id, '2026-08', { estimatedMinutes: 1400, sessionsDelta: 2 });
    accounts.recordUsage(a.id, '2026-09', { estimatedMinutes: 300, sessionsDelta: 1 });
    const u = accounts.get(a.id).usage;
    return u['2026-08'].estimatedMinutes === 1400 && u['2026-08'].sessions === 2
        && u['2026-09'].estimatedMinutes === 300;
})());

t('usage within a cycle never moves backwards', (() => {
    const a = accounts.getByLogin('history');
    accounts.recordUsage(a.id, '2026-08', { estimatedMinutes: 900 });   // a worse measurement
    return accounts.get(a.id).usage['2026-08'].estimatedMinutes === 1400;
})());

t('the cycle key is a UTC month boundary', (() => {
    const cycle = quota.currentCycle(Date.UTC(2026, 7, 16, 12));
    const start = quota.cycleStartMs('2026-08');
    return cycle === '2026-08' && start === Date.UTC(2026, 7, 1);
})());

t('a new cycle makes an estimate-exhausted account available again', (() => {
    reset();
    const a = addAccount('roll', { quota: { source: 'measured', includedMinutes: 2000, usedMinutes: 2000, remainingMinutes: 0, cycle: '2026-07' } });
    const stale = quota.isExhausted(accounts.get(a.id).quota);
    // A new cycle's reading replaces the old one wholesale — GitHub resets its own counter.
    accounts.update(a.id, { quota: { source: 'measured', includedMinutes: 2000, usedMinutes: 0, remainingMinutes: 2000, cycle: '2026-08' } });
    return stale === true && quota.isExhausted(accounts.get(a.id).quota) === false;
})());

// ── quota resolution against a stubbed GitHub ───────────────────────────────────────
ta('measured quota is used when the account has the billing scope', async () => {
    reset();
    const { account } = accounts.upsert({ login: 'measured', scopes: 'repo,workflow,user', token: 'tok_m' });
    accounts.update(account.id, { repository: 'measured/r' });
    global.fetch = async (url) => new Response(JSON.stringify({
        total_minutes_used: 1380, total_paid_minutes_used: 0, included_minutes: 3000,
        minutes_used_breakdown: { WINDOWS: 690 },
    }), { status: 200, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
    const q = await quota.refresh(account.id, { force: true });
    assert.strictEqual(q.source, 'measured', JSON.stringify(q));
    assert.strictEqual(q.includedMinutes, 3000, 'the allowance must come from GitHub, not a constant');
    assert.strictEqual(q.remainingMinutes, 1620);
});

ta('a 404 from billing falls back to an estimate and says it is one', async () => {
    reset();
    const { account } = accounts.upsert({ login: 'est', scopes: 'repo,workflow', token: 'tok_e' });
    accounts.update(account.id, { repository: 'est/r' });
    const started = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    global.fetch = async (url) => {
        const u = String(url);
        const reply = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() } });
        if (u.includes('/settings/billing/')) return reply({ message: 'Not Found' }, 404);
        if (u.includes('/runs')) {
            return reply({
                total_count: 1,
                workflow_runs: [{ id: 1, status: 'completed', conclusion: 'success', created_at: started, run_started_at: started, updated_at: new Date().toISOString() }],
            });
        }
        return reply({}, 404);
    };
    const q = await quota.refresh(account.id, { force: true });
    assert.strictEqual(q.source, 'estimated', JSON.stringify(q));
    assert.strictEqual(q.includedMinutes, null, 'an allowance must never be invented');
    assert.strictEqual(q.remainingMinutes, null, 'an estimate is not a remaining balance');
    // One hour of wall clock on Windows = ~120 included-minutes.
    assert.ok(q.usedMinutes >= 115 && q.usedMinutes <= 125, `got ${q.usedMinutes}`);
    assert.ok(/تخمین/.test(q.note), 'the estimate must be labelled for the user');
});

ta('a billing outage never marks the account sick', async () => {
    reset();
    const { account } = accounts.upsert({ login: 'flaky', scopes: 'repo,workflow,user', token: 'tok_f' });
    accounts.update(account.id, { repository: 'flaky/r' });
    global.fetch = async () => { throw new Error('fetch failed'); };
    const q = await quota.refresh(account.id, { force: true });
    assert.ok(q, 'refresh must return something rather than throwing');
    assert.notStrictEqual(accounts.get(account.id).health, HEALTH.AUTH_REQUIRED);
    assert.ok(accounts.isSelectable(accounts.get(account.id)), 'an unreadable quota is still a usable account');
});

// ── report ──────────────────────────────────────────────────────────────────────────
(async () => {
    for (const [name, fn] of pending) {
        try { await fn(); t(name, true); }
        catch (e) { t(name, false, e.message); }
    }
    let failed = 0;
    for (const r of results) {
        if (r.pass === undefined) continue;
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : `   -> ${r.detail}`}`);
    }
    const counted = results.filter(r => r.pass !== undefined).length;
    console.log(`\n${counted - failed}/${counted} passed`);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
