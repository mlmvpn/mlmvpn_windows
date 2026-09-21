// --- GitHub Tunnel: how much Actions capacity an account actually has left ---
//
// WHAT GITHUB REALLY GIVES US — CHECKED AGAINST THE LIVE API, NOT ASSUMED
//
//  1. GET /users/{login}/settings/billing/actions
//     Returns included_minutes, total_minutes_used, total_paid_minutes_used and a
//     per-OS breakdown. This is the ONLY authoritative source, and the only one that
//     knows the account's real allowance — which is plan-dependent, so it is read rather
//     than hardcoded. It requires the `user` OAuth scope: called with this feature's
//     historical `repo, workflow` token it answers 404 with
//     `X-Accepted-OAuth-Scopes: user`.
//
//  2. GET /repos/{owner}/{repo}/actions/runs/{id}/timing -> billable.WINDOWS.total_ms
//     UNUSABLE. It reports 0. Measured on this project's own repository: twelve runs,
//     1,418 minutes of real Windows runner time, `billable` zero on every single one,
//     including a completed 335-minute success. It is a known GitHub bug, not a quirk of
//     one account, and anything built on it would silently report infinite capacity.
//
//  3. The SAME endpoint's run_duration_ms IS correct (335.6 / 264.0 / 64.1 minutes on
//     those runs). So wall-clock time per run is reliable even though billed time is not.
//
// THEREFORE, TWO SOURCES, ALWAYS LABELLED:
//
//   'measured'  — from (1). Real numbers, real allowance, whole account.
//   'estimated' — from (3): sum of run_duration_ms for OUR repository in this cycle,
//                 multiplied by the runner's billing multiplier. This is a LOWER BOUND:
//                 it cannot see minutes the same account spent on its other repositories.
//                 It is presented as a floor, never as a remaining balance.
//   'unknown'   — neither is available. A legitimate answer. Never substituted with a
//                 plausible-looking number.
//
// Nothing here ever invents an allowance. When the allowance is unknown, the account stays
// selectable and the ground truth comes from the only signal that never lies: whether a
// dispatched run actually starts (see gt-deployer.js).

const github = require('./gt-github');
const accounts = require('./gt-accounts');
const { SESSION_LIFETIME_MINUTES } = require('./gt-workflow-template');

// GitHub's published billing multipliers. A minute on a Windows runner costs two of the
// account's included minutes; macOS costs ten. Our workflow is windows-latest, so a
// session's cost is roughly double its wall-clock length — which is exactly why one
// account runs out so much faster than the raw minute figure suggests.
const OS_MULTIPLIER = { UBUNTU: 1, LINUX: 1, WINDOWS: 2, MACOS: 10 };
const RUNNER_OS = 'WINDOWS';

// What one full session costs, in included-minutes. Used for ranking accounts by how many
// more sessions they could take — never as an eligibility gate, because GitHub itself
// checks the allowance at dispatch time and will happily let a run start with less than a
// full session's worth remaining (and simply overrun).
const SESSION_COST_MINUTES = SESSION_LIFETIME_MINUTES * OS_MULTIPLIER[RUNNER_OS];

// Re-reading billing on every status poll would burn a quarter of the API budget for a
// number that moves in minutes, not seconds.
const QUOTA_TTL_MS = 10 * 60 * 1000;

/**
 * The billing cycle key.
 *
 * ASSUMPTION, STATED: GitHub does not expose the account's allowance reset date through
 * any API this token can reach, so the UTC calendar month is used. For GitHub Free — the
 * plan this feature is aimed at — that matches. For paid plans whose cycle is anchored to
 * the signup date it can be off by up to a month.
 *
 * The consequence is bounded on purpose: the cycle key only groups the ESTIMATE and the
 * history. Measured numbers come from GitHub's own counter, which GitHub resets on the
 * real date whatever we think the month is. So a wrong cycle boundary can make the
 * estimate pessimistic for a few days; it can never make a measured figure wrong.
 */
function currentCycle(now = Date.now()) {
    return accounts.currentCycle(now);
}

function cycleStartMs(cycle) {
    const [y, m] = String(cycle).split('-').map(Number);
    return Date.UTC(y, (m || 1) - 1, 1);
}

// ── measured ────────────────────────────────────────────────────────────────────────

async function measure(account, token) {
    if (!github.hasBillingScope(account.scopes)) return null;
    const billing = await github.getActionsBilling(token, account.login);
    if (!billing) return null;

    const remaining = Math.max(0, billing.includedMinutes - billing.usedMinutes);
    return {
        source: 'measured',
        includedMinutes: billing.includedMinutes,
        usedMinutes: billing.usedMinutes,
        remainingMinutes: remaining,
        paidMinutesUsed: billing.paidMinutesUsed,
        // An account already paying for overage is NOT out of capacity — it has a payment
        // method and GitHub keeps running its jobs. Treating it as exhausted would park a
        // perfectly usable account for the rest of the month.
        billable: billing.paidMinutesUsed > 0,
        cycle: currentCycle(),
        checkedAt: Date.now(),
        note: '',
    };
}

// ── estimated ───────────────────────────────────────────────────────────────────────

/**
 * A floor on what this account has spent this cycle, from the runs we can actually see.
 *
 * Only counts runs in OUR repository, because that is all a `repo`-scoped token is asked
 * about here — so the true figure can only be higher. Said plainly in `note`, and the UI
 * repeats it: a number a user reads as a balance when it is a floor is worse than no
 * number at all.
 */
async function estimate(account, token) {
    if (!account.repository) {
        return {
            source: 'unknown', includedMinutes: null, usedMinutes: null, remainingMinutes: null,
            cycle: currentCycle(), checkedAt: Date.now(),
            note: 'هنوز هیچ نشستی روی این حساب ساخته نشده است.',
        };
    }

    const cycle = currentCycle();
    const since = cycleStartMs(cycle);
    let minutes = 0;
    let counted = 0;
    let truncated = false;

    // One page is plenty: a full session is ~5h45m, so a month's worth of them on one
    // account cannot reach 100 runs. If it somehow does, say the number is truncated
    // rather than quietly under-reporting.
    const list = await listRunsSince(token, account.repository, since);
    truncated = list.truncated;
    for (const run of list.runs) {
        // run_duration_ms is only present once a run finishes. For one still going, bill
        // the time it has been alive so far — a running session is spending the allowance
        // right now, and ignoring it makes an account look emptier of usage than it is at
        // exactly the moment that matters.
        const started = Date.parse(run.run_started_at || run.created_at) || 0;
        const ended = run.status === 'completed' ? (Date.parse(run.updated_at) || 0) : Date.now();
        const wallMs = run.durationMs != null ? run.durationMs : Math.max(0, ended - started);
        minutes += (wallMs / 60000) * OS_MULTIPLIER[RUNNER_OS];
        counted++;
    }

    return {
        source: 'estimated',
        includedMinutes: null,      // unknowable without the billing scope — never guessed
        usedMinutes: Math.round(minutes),
        remainingMinutes: null,
        cycle,
        checkedAt: Date.now(),
        countedRuns: counted,
        truncated,
        note: 'تخمینی — فقط اجراهای همین برنامه شمرده شده‌اند، پس مصرف واقعی می‌تواند بیشتر باشد. '
            + 'برای عدد دقیق، این حساب را دوباره متصل کنید تا دسترسی خواندن سهمیه داده شود.',
    };
}

/** Runs in this repo started at or after `since`, newest first. */
async function listRunsSince(token, repository, since) {
    const data = await github.listWorkflowRuns(token, repository, { perPage: 100 });
    const runs = [];
    for (const r of data.runs || []) {
        const t = Date.parse(r.run_started_at || r.created_at) || 0;
        if (t >= since) runs.push(r);
    }
    return { runs, truncated: !!data.truncated };
}

// ── public ──────────────────────────────────────────────────────────────────────────

/**
 * Refresh one account's quota, preferring the real thing.
 *
 * Never throws for a reason that is about billing: an account whose quota cannot be read
 * is an account with unknown quota, which is still a usable account.
 */
async function refresh(accountId, { force = false } = {}) {
    const account = accounts.get(accountId);
    if (!account) return null;

    const prev = account.quota || {};
    const stale = force || !prev.checkedAt || (Date.now() - prev.checkedAt) > QUOTA_TTL_MS
        || prev.cycle !== currentCycle();
    if (!stale) return prev;

    const token = accounts.token(accountId);
    if (!token) return prev;

    let quota = null;
    try {
        quota = await measure(account, token);
    } catch (e) {
        // A billing call failing must not mark the account sick — it says nothing about
        // whether the account can run a workflow.
        quota = null;
    }
    if (!quota) {
        try { quota = await estimate(account, token); } catch (e) { quota = null; }
    }
    if (!quota) {
        quota = {
            source: 'unknown', includedMinutes: null, usedMinutes: null, remainingMinutes: null,
            cycle: currentCycle(), checkedAt: Date.now(), note: 'وضعیت سهمیه خوانده نشد.',
        };
    }

    accounts.update(accountId, { quota, lastCheckedAt: Date.now() });
    accounts.recordUsage(accountId, quota.cycle, {
        estimatedMinutes: quota.source === 'estimated' ? quota.usedMinutes : undefined,
        measuredMinutes: quota.source === 'measured' ? quota.usedMinutes : undefined,
    });
    return quota;
}

/**
 * Is there known to be no capacity left?
 *
 * Deliberately conservative: only a MEASURED zero counts. An estimate is a lower bound on
 * spend, not an upper bound on what remains, so refusing an account on the strength of one
 * would park accounts that are actually fine. When the answer is not knowable, the account
 * is tried and GitHub's own dispatch result decides — which is the only signal that is
 * never wrong.
 */
function isExhausted(quota) {
    if (!quota || quota.source !== 'measured') return false;
    if (quota.billable) return false;                     // paying for overage, still runs
    return quota.remainingMinutes != null && quota.remainingMinutes <= 0;
}

/** Roughly how many more sessions this account could host. null when unknowable. */
function sessionsRemaining(quota) {
    if (!quota || quota.source !== 'measured' || quota.remainingMinutes == null) return null;
    return Math.floor(quota.remainingMinutes / SESSION_COST_MINUTES);
}

module.exports = {
    refresh, isExhausted, sessionsRemaining, currentCycle, cycleStartMs,
    OS_MULTIPLIER, RUNNER_OS, SESSION_COST_MINUTES, QUOTA_TTL_MS,
    _measure: measure, _estimate: estimate,
};
