// --- GitHub Tunnel: session orchestration + state machine ---
// Drives one Cloud Session from "user clicked Continue" to "configuration ready", and
// later from "user clicked Activate Again" to a brand new one. Every step here is exactly
// what item 3 of the product spec lists — the UI only ever sees the state name and a
// human-readable log line, never a GitHub/Tailscale term.
//
// State machine (see gt-config session.status):
//   SETTING_UP -> STARTING -> INSTALLING -> CONNECTING_NETWORK -> READY -> ACTIVE
//                                                                       -> EXPIRING_SOON -> EXPIRED
//   any step -> FAILED (self-healing retry happens inside run(); FAILED is only reached
//               after retries are exhausted, and a FAILED session is never reported ACTIVE)

const store = require('./gt-config');
const github = require('./gt-github');
const broker = require('./gt-broker');
const accounts = require('./gt-accounts');
const allocator = require('./gt-allocator');
const quota = require('./gt-quota');
const { buildWorkflowYaml, USABLE_SESSION_MINUTES } = require('./gt-workflow-template');

const SECRET_NAME = 'MLMVPN_TS_AUTHKEY';
const POLL_INTERVAL_MS = 5000;
const MAX_WAIT_MS = 8 * 60 * 1000; // cloud VMs boot in ~1-2min normally; 8min covers cold queues
// How many DIFFERENT accounts a single create may burn through before giving up. Not a
// retry count: each pass is a different account, and the previous one has been marked so
// it will not be picked again.
const MAX_ACCOUNT_ATTEMPTS = 4;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** True if an existing session is still usable (not expired, not failed). */
function activeSession() {
    return store.getActiveSession();
}

/** Ids of accounts that currently own a live session — ranked last, never excluded. */
function busyAccountIds() {
    return store.getSessions()
        .filter(s => ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status) && s.accountId)
        .map(s => s.accountId);
}

/**
 * The token for the account a session belongs to.
 *
 * Every lifecycle operation on an existing session goes through here rather than reaching
 * for "the" token. That is the whole of session affinity: a session records which account
 * created it, and cancel/monitor/cleanup can only ever use that account's credential. With
 * a pool, the alternative is cancelling account #3's runner with account #1's token —
 * which does not fail loudly, it 404s, and the runner keeps running and keeps billing.
 */
function tokenForSession(session) {
    if (!session) return '';
    if (session.accountId) return accounts.token(session.accountId);
    // Sessions created before the pool existed have no accountId. Fall back to the single
    // migrated account, which by definition is the one that made them.
    const all = accounts.list();
    return all.length === 1 ? accounts.token(all[0].id) : '';
}

async function createSession({ onLog, onState } = {}) {
    const log = (msg) => { try { onLog && onLog(msg); } catch (e) {} };
    const state = (s, session) => { try { onState && onState(s, session); } catch (e) {} };

    const tried = [];
    let lastErr = null;

    for (let attempt = 0; attempt < MAX_ACCOUNT_ATTEMPTS; attempt++) {
        // Leased synchronously inside claim(), so two concurrent creates can never be
        // handed the same account (gt-allocator.js).
        const { account } = allocator.claim({ busyIds: busyAccountIds(), exclude: tried });
        if (!account) {
            const why = allocator.explainEmptyPool();
            if (!tried.length) {
                state('FAILED', null);
                throw Object.assign(new Error(why.message), { code: why.code });
            }
            break; // tried some, ran out of alternatives — report the last real failure
        }

        tried.push(account.id);
        const label = account.login ? `@${account.login}` : 'حساب گیت‌هاب';
        if (attempt > 0) log(`تلاش با حساب بعدی (${label})…`);

        try {
            const session = await runOnce({ log, state, account });
            accounts.markHealthy(account.id, { lastUsedAt: Date.now() });
            accounts.recordUsage(account.id, quota.currentCycle(), { sessionsDelta: 1 });
            return session;
        } catch (e) {
            lastErr = e;
            const verdict = allocator.classifyFailure(e);

            if (verdict.health) {
                accounts.markUnhealthy(account.id, verdict.health, e.message);
                log(accountFailureLine(label, verdict.health));
            }
            // Shared infrastructure — the broker, not this account. Another account would
            // hit exactly the same wall, so stop and let the UI show the relay step.
            if (!verdict.retryable) break;
        } finally {
            // Always. A lease left behind by a thrown error would take a healthy account
            // out of the pool for three minutes for no reason.
            allocator.release(account.id);
        }
    }

    state('FAILED', null);
    const err = new Error(friendlyError(lastErr));
    err.code = lastErr && lastErr.code;
    throw err;
}

/**
 * Why a run that never got going ended.
 *
 * The overwhelmingly likely answer, and the one nothing in this feature used to name, is
 * the Actions quota. The arithmetic is not close: this job asks for 345 minutes on a
 * WINDOWS runner, Windows bills at a 2x multiplier, and a free account gets 2,000 included
 * minutes a month for private repositories. That is ~690 minutes per session — so roughly
 * TWO full sessions a month, after which every dispatch produces a run that starts and
 * dies immediately. Told only "the cloud session ended unexpectedly (failure)", the user
 * retries forever against a wall, and the retry itself costs nothing to GitHub and
 * everything to them.
 */
function explainDeadRun(run, sawInProgress) {
    const conclusion = run && run.conclusion;
    if (conclusion === 'cancelled') {
        return 'نشست ابری لغو شد (احتمالاً از خود گیت‌هاب یا با ساخت نشست جدید).';
    }
    if (!sawInProgress && (conclusion === 'failure' || conclusion === 'startup_failure')) {
        return 'نشست ابری بلافاصله بعد از شروع متوقف شد — معمولاً یعنی سهم اجرای این حساب گیت‌هاب تمام شده است. '
            + 'حساب علامت‌گذاری شد و اگر حساب دیگری متصل باشد، خودکار از آن استفاده می‌شود.';
    }
    return `نشست ابری به‌طور غیرمنتظره پایان یافت (${conclusion || 'نامشخص'}).`;
}

/** One line, naming the account and what happened to it, so failover is visible rather
 *  than mysterious. Logins are not secrets; tokens never appear here. */
function accountFailureLine(label, health) {
    const H = accounts.HEALTH;
    if (health === H.EXHAUSTED) return `${label}: سهم اجرا تمام شده — کنار گذاشته شد.`;
    if (health === H.AUTH_REQUIRED) return `${label}: دسترسی منقضی شده — نیاز به اتصال دوباره.`;
    if (health === H.RATE_LIMITED) return `${label}: گیت‌هاب موقتاً محدودش کرده — کمی بعد دوباره.`;
    if (health === H.REPO_ERROR) return `${label}: زیرساخت این حساب آماده نشد.`;
    return `${label}: ناموفق بود — کنار گذاشته شد.`;
}

function friendlyError(e) {
    const msg = (e && e.message) || '';
    if (e && (e.code === 'BROKER_NOT_DEPLOYED' || e.code === 'BROKER_UNAVAILABLE'
        || e.code === 'ACL_TAG_NOT_PERMITTED')) return msg;
    // The pool ran out of places to try. That message already names the real reason
    // (all spent / all need re-auth / all cooling down), so do not bury it under a generic one.
    if (e && ['NO_ACCOUNTS', 'ALL_EXHAUSTED', 'ALL_AUTH_REQUIRED', 'ALL_COOLING_DOWN', 'NONE_AVAILABLE'].includes(e.code)) return msg;
    if (e && e.code === 'RUN_DIED_EARLY') return msg;
    // GitHub answers a dispatch past the spending limit with a 403 that says so. Without
    // this it falls through to the "reconnect your GitHub account" branch below, which
    // sends the user to disconnect a credential that was never the problem.
    if (/spending limit|billing|payment|quota|minutes/i.test(msg)) {
        return 'سهم اجرای رایگان حساب گیت‌هاب شما تمام شده است. در Settings ← Billing گیت‌هاب قابل بررسی است؛ سهم ابتدای هر ماه از نو شارژ می‌شود.';
    }
    if (/rate limit/i.test(msg)) return 'گیت‌هاب موقتاً شلوغ است. کمی بعد دوباره تلاش می‌شود.';
    if (/not connected/i.test(msg)) return 'گیت‌هاب متصل نیست.';
    // Revoking the app from github.com/settings/applications leaves a stored token that
    // fails every call. Without naming it, the user retries forever against a dead
    // credential and the message never mentions the one thing that fixes it.
    if (e && e.code === 'PROXY_AUTH_STRIPPED') return msg;
    if ((e && e.status === 401) || /bad credentials|requires authentication/i.test(msg)) {
        return 'دسترسی گیت‌هاب دیگر معتبر نیست. یک‌بار «قطع اتصال گیت‌هاب» بزنید و دوباره متصل شوید.';
    }
    if ((e && e.status === 403) && /workflow|scope/i.test(msg)) {
        return 'دسترسی لازم روی گیت‌هاب داده نشده است. یک‌بار «قطع اتصال گیت‌هاب» بزنید و هنگام اتصال دوباره، همه‌ی دسترسی‌های خواسته‌شده را تأیید کنید.';
    }
    return 'نتوانستیم تونل ابری شما را راه‌اندازی کنیم. MLMVPN به‌طور خودکار دوباره تلاش می‌کند.';
}

async function runOnce({ log, state, account }) {
    const token = accounts.token(account.id);
    if (!token) {
        throw Object.assign(new Error('توکن این حساب گیت‌هاب خوانده نشد.'), { status: 401 });
    }

    state('SETTING_UP');
    log(`در حال بررسی دسترسی گیت‌هاب${account.login ? ` (@${account.login})` : ''}…`);
    const repo = await github.ensureRepo(token);
    // Remembered ON THE ACCOUNT, not globally: every account has its own repository, and a
    // single global "the repo" is meaningless the moment there are two.
    accounts.update(account.id, { repository: repo.fullName, defaultBranch: repo.defaultBranch });
    store.setRepo(repo);
    log('زیرساخت ابری آماده شد.');

    const workflowResult = await github.ensureWorkflow(token, repo.fullName, buildWorkflowYaml());
    accounts.update(account.id, { workflowSyncedAt: Date.now() });
    log(workflowResult.changed ? 'زیرساخت ابری پیکربندی شد.' : 'زیرساخت ابری از قبل به‌روز است.');

    // accountId is written at creation and never changes. It is what every later
    // operation — monitor, reconcile, cancel, cleanup — resolves its credential from.
    const session = store.addSession({
        repository: repo.fullName, status: 'SETTING_UP',
        accountId: account.id, accountLogin: account.login,
    });
    state('SETTING_UP', session);
    // The lease covers the whole create, which is longer than its default TTL.
    allocator.renew(account.id);

    log('در حال پیکربندی شبکه‌ی امن…');
    let authKey;
    try {
        // The broker is shared by every account and knows nothing about GitHub — it signs
        // with the per-INSTALL secret and mints against the one tailnet. This is the line
        // that would have needed a Worker per account if the design were different, and it
        // does not.
        authKey = await broker.mintAuthKey(session.id);
    } catch (e) {
        store.updateSession(session.id, { status: 'FAILED', lastError: e.message });
        throw e;
    }
    await github.setRepoSecret(token, repo.fullName, SECRET_NAME, authKey.key);

    // Mint THIS machine's key now, not at connect time. The broker lives on a Cloudflare
    // Worker, and workers.dev is not dependably reachable from Iran — if connecting needed
    // it, the tunnel would be unusable exactly when it is most needed. Session setup
    // already requires the broker, so the key is taken here, given the session's own
    // lifetime, and stored; connecting then needs nothing but GitHub and the tunnel itself.
    let clientKey = '';
    try {
        const ck = await broker.mintAuthKey(`client-${session.id}`, USABLE_SESSION_MINUTES * 60, true);
        clientKey = ck.key || '';
    } catch (e) {
        log('کلید اتصال از پیش گرفته نشد؛ هنگام اتصال دوباره تلاش می‌شود.');
    }
    log('شبکه‌ی امن پیکربندی شد.');

    state('STARTING', session);
    log('در حال راه‌اندازی سرور ابری ویندوز…');
    const runId = await github.dispatchWorkflow(token, repo.fullName, repo.defaultBranch, { session_id: session.id });
    store.updateSession(session.id, { workflowRunId: runId, status: 'STARTING' });

    // FROM HERE ON A CLOUD MACHINE IS RUNNING ON THE USER'S ACCOUNT, and it will keep
    // running for five and three quarter hours whether or not this function succeeds.
    // Every failure path below therefore has to cancel it. Leaving it up does not just
    // waste an idle VM: a Windows runner on a private repo bills at 2x, so one abandoned
    // run eats ~690 of the 2000 minutes a free account gets for a whole month — a third of
    // the user's entire monthly budget spent on a session they never got to use, three
    // times over if the retry loop above runs to its limit.
    try {
        // clientKey is passed EXPLICITLY. It is created here but consumed at the very end
        // of awaitSession, and when that function was split out of this one it kept
        // referring to the closure variable it no longer had — a ReferenceError on the
        // last line of every SUCCESSFUL session, i.e. the one path that had no test.
        return await awaitSession({ log, state, repo, session, runId, token, clientKey });
    } catch (e) {
        try { await github.cancelRun(token, repo.fullName, runId); } catch (_) {}
        // The key is single-use, but a key sitting in a repo secret after a failed setup is
        // still a credential left lying around for no reason.
        try { await github.deleteRepoSecret(token, repo.fullName, SECRET_NAME); } catch (_) {}
        throw e;
    }
}

/** Wait for the dispatched run to publish its session data, or fail trying. */
async function awaitSession({ log, state, repo, session, runId, token, clientKey }) {
    state('INSTALLING', session);
    log('در حال آماده‌سازی تونل…');

    const deadline = Date.now() + MAX_WAIT_MS;
    let summary = null;
    let sawInProgress = false;
    let runStartedAt = null;
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const run = await github.getRun(token, repo.fullName, runId);
        // GitHub's own timestamp for when the job began. The countdown is anchored to this,
        // not to when this app noticed — those differ by however long the runner took to
        // boot, and that gap would otherwise be handed to the user as free time.
        if (run.run_started_at) runStartedAt = Date.parse(run.run_started_at);

        if (run.status === 'in_progress') {
            if (!sawInProgress) { sawInProgress = true; state('CONNECTING_NETWORK', session); log('در حال برقراری شبکه‌ی امن…'); }
            summary = await github.getSessionData(token, repo.fullName, session.id);
            if (summary && summary.ip) break;
        } else if (run.status === 'completed') {
            // Job ended before we ever saw session data — real failure, not just "still booting".
            const err = new Error(explainDeadRun(run, sawInProgress));
            err.code = err.code || (sawInProgress ? '' : 'RUN_DIED_EARLY');
            store.updateSession(session.id, { status: 'FAILED', lastError: `workflow ${run.conclusion}` });
            throw err;
        }
    }

    if (!summary || !summary.ip) {
        store.updateSession(session.id, { status: 'FAILED', lastError: 'timed out waiting for tunnel' });
        throw new Error('مهلت آماده شدن نشست ابری تمام شد.');
    }

    // The auth key was already consumed by the runner; remove it from the repo immediately —
    // it must never sit there for the life of the session. Same for the session data file:
    // we've read it, so the RDP password shouldn't keep sitting in the repo either.
    await github.deleteRepoSecret(token, repo.fullName, SECRET_NAME);
    await github.deleteSessionFile(token, repo.fullName, session.id);

    log('در حال ساخت کانفیگ…');
    // Anchored to GitHub's clock and GitHub's start time, never to this machine's — see
    // gt-workflow-template.js for why the promised window is shorter than the real one.
    const anchor = runStartedAt || github.serverNow();
    const expiresAt = anchor + (USABLE_SESSION_MINUTES * 60 * 1000);
    const updated = store.updateSession(session.id, {
        status: 'READY',
        tailscaleIp: summary.ip,
        expiresAt,
        runStartedAt: anchor,
        clientKey,
        rdp: { host: summary.ip, port: summary.port || 3389, username: summary.username, password: summary.password },
        lastError: '',
    });
    state('READY', updated);
    log('کانفیگ MLMVPN شما آماده است.');
    return updated;
}

/** Activate Again / Renew — reuses "existing tunnel active" guard from spec §14. */
async function renewSession({ force = false, onLog, onState } = {}) {
    if (!force) {
        const existing = activeSession();
        if (existing) return { existing: true, session: existing };
    }
    const prev = store.getSessions().find(s => ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status));
    if (prev) {
        try { onLog && onLog('در حال پایان دادن به نشست ابری قبلی…'); } catch (e) {}
        // The PREVIOUS session's own account, not whichever one is about to be chosen for
        // the new session. Cancelling account #3's runner with account #1's token quietly
        // 404s, and the runner keeps running and keeps spending #3's allowance for another
        // five hours — the most expensive possible way to get this wrong.
        await endSession(prev, onLog);
    }
    try { onState && onState('RENEWING'); } catch (e) {}
    try { onState && onState('STARTING_NEW_SESSION'); } catch (e) {}
    const session = await createSession({ onLog, onState });
    return { existing: false, session };
}

function tick(session) {
    if (!session || !session.expiresAt) return session;
    // github.serverNow(), not Date.now(): the deadline is an absolute instant on GitHub's
    // clock, so it must be compared against that clock.
    const remaining = session.expiresAt - github.serverNow();
    let status = session.status;
    if (remaining <= 0 && !['EXPIRED', 'FAILED'].includes(status)) status = 'EXPIRED';
    else if (remaining <= 10 * 60 * 1000 && ['READY', 'ACTIVE'].includes(status)) status = 'EXPIRING_SOON';
    else if (status === 'READY') status = 'ACTIVE';
    if (status !== session.status) return store.updateSession(session.id, { status });
    return session;
}

// Arithmetic alone cannot be trusted here. A run can also end EARLY — cancelled, a GitHub
// incident, the runner evicted — and in that case a countdown computed from the start time
// keeps happily ticking against a machine that no longer exists. That is the failure that
// silently drops someone back onto their real IP mid-session, so the countdown is
// reconciled against the actual run state as well.
let lastReconcile = 0;
const RECONCILE_INTERVAL_MS = 60 * 1000;

async function reconcile(session, { force = false } = {}) {
    if (!session || !session.workflowRunId || !session.repository) return session;
    if (['EXPIRED', 'FAILED'].includes(session.status)) return session;
    if (!force && Date.now() - lastReconcile < RECONCILE_INTERVAL_MS) return session;
    lastReconcile = Date.now();

    const token = tokenForSession(session);
    if (!token) return session; // the owning account was removed — nothing to ask

    let run;
    try {
        run = await github.getRun(token, session.repository, session.workflowRunId);
    } catch (e) {
        return session; // transient API trouble is not evidence the session died
    }

    if (run.status === 'completed') {
        return store.updateSession(session.id, {
            status: 'EXPIRED',
            lastError: `cloud session ended (${run.conclusion || 'completed'})`,
        });
    }

    // Re-anchor if GitHub's start time disagrees with what we stored (e.g. the session was
    // adopted from a previous app run).
    if (run.run_started_at) {
        const anchor = Date.parse(run.run_started_at);
        const expected = anchor + (USABLE_SESSION_MINUTES * 60 * 1000);
        if (Math.abs((session.expiresAt || 0) - expected) > 30 * 1000) {
            return store.updateSession(session.id, { expiresAt: expected, runStartedAt: anchor });
        }
    }
    return session;
}

// An earlier design let the user RDP into the cloud session, and the code for it lived
// here: write a .rdp file to %TEMP% and stash the password with `cmdkey /pass:...`.
// It was removed rather than left unreferenced. Nothing routed to it any more, and both
// halves leak the VM's administrator password on a machine that may be shared — cmdkey
// puts it in a command line, which every process on the box can read out of
// Win32_Process, and the .rdp file was written and never deleted. Dead code that hands
// out credentials is not harmless dead code.
//
// If interactive access is ever wanted again, it needs the password passed through stdin
// or the credential store directly, and a temp file that is removed after mstsc exits.

/**
 * End one session on the account that owns it: cancel its runner, tell the broker, mark it.
 *
 * The single place any session is torn down, so the "use the owning account's token" rule
 * is enforced in one readable spot rather than repeated at every call site — which is
 * exactly how it would drift back to using an ambient credential.
 */
async function endSession(session, onLog) {
    if (!session) return;
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    const token = tokenForSession(session);
    if (session.repository && session.workflowRunId) {
        if (token) {
            try { await github.cancelRun(token, session.repository, session.workflowRunId); }
            catch (e) { log('نشست ابری قبلی لغو نشد (ممکن است هنوز در حال اجرا باشد).'); }
        } else {
            // Says so out loud rather than pretending: a runner nobody can cancel keeps
            // spending an allowance, and the user is the only one who can stop it.
            log('نشست ابری قبلی قابل لغو نبود چون حساب گیت‌هابِ سازنده‌اش دیگر متصل نیست.');
        }
    }
    await broker.revokeSession(session.id);
    store.updateSession(session.id, { status: 'EXPIRED' });
}

module.exports = {
    createSession, renewSession, activeSession, tick, reconcile,
    endSession, tokenForSession, busyAccountIds,
};
