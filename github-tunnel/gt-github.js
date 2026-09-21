// --- GitHub Tunnel: GitHub connection + repo/workflow/run automation ---
// The only thing the user ever does with GitHub directly is type a short device code into
// a browser tab that opens itself. Everything past that — creating the private repo,
// pushing the workflow file, setting the per-session secret, triggering + watching the
// run — happens here, invisibly.
//
// Scopes: 'repo' + 'workflow'. 'repo' is required to create/manage a *private* repository
// and set Actions secrets on it; 'workflow' is required to push files under
// .github/workflows/. Both are the narrowest scopes that make this feature work — we
// deliberately do not ask for 'admin:org', 'delete_repo', or anything account-wide.

// No fs/os/path here any more: this module used to own a credential store on disk, and
// now owns no credential at all — the pool (gt-accounts.js) does, and hands one in per call.
const { gtFetch } = require('./gt-net');

const CLIENT_ID = process.env.GITHUB_TUNNEL_CLIENT_ID || process.env.GITHUB_CLIENT_ID || 'Ov23liWP55HtVHdmfZ9P';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';

// `user` is asked for ON TOP of the two scopes this feature has always needed, and only
// because it is the sole way to read a real Actions allowance:
// GET /users/{login}/settings/billing/actions answers 404 without it, and the API itself
// says so — the rejection carries `X-Accepted-OAuth-Scopes: user`.
//
// It is requested, NOT required. Everything works without it; the difference is whether
// the quota shown to the user is measured or estimated, and gt-quota.js reports which.
// Accounts authorised by earlier builds keep working untouched — they simply report
// estimated numbers, and the panel offers re-authorising as an option rather than a
// demand. What is actually granted is read back from X-OAuth-Scopes rather than assumed,
// because the user can uncheck things on the consent screen.
const SCOPE = 'repo workflow user';

const REPO_NAME = 'mlmvpn-cloud-tunnel';
const WORKFLOW_PATH = '.github/workflows/mlmvpn-tunnel.yml';
const WORKFLOW_FILENAME = 'mlmvpn-tunnel.yml';

// EVERY repo/run/secret call below takes its token as an explicit argument.
//
// It used to read one global store instead, and that was the single most dangerous thing
// about adding an account pool: with a pool, `cancelRun(session.repository, runId)` reading
// "the" token means whichever account happens to be stored — so a session belonging to
// account #3 could be cancelled with account #1's credential. Against a repository that
// account does not own, that is at best a 404 and at worst an operation on somebody else's
// repository of the same name. Passing the token in makes the wrong thing impossible to
// write rather than merely discouraged: there is no ambient credential left to get wrong.
function requireToken(token) {
    if (!token) throw Object.assign(new Error('GitHub is not connected.'), { code: 'NO_TOKEN' });
    return token;
}

// ── low-level GitHub REST client ────────────────────────────────────────────────────

// How far this machine's clock is from GitHub's, in ms (githubNow - localNow). Every API
// response carries an authoritative Date header, so this is measured continuously and for
// free. It matters because a session deadline is only meaningful against real time: a PC
// whose clock is fast by 20 minutes would otherwise show 20 minutes of tunnel that does
// not exist.
let clockOffsetMs = 0;

/** Real "now" in epoch ms, corrected for local clock skew. */
function serverNow() {
    return Date.now() + clockOffsetMs;
}

async function gh(token, method, endpoint, body = null, raw = false) {
    const res = await gtFetch(`${API}${endpoint}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'MLM-VPN-App',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });

    const dateHeader = res.headers.get('date');
    if (dateHeader) {
        const t = Date.parse(dateHeader);
        if (!Number.isNaN(t)) clockOffsetMs = t - Date.now();
    }

    // A 401 that came back over the fallback proxy says nothing about the token: that path
    // may simply not carry the Authorization header. Distinguishing the two is the
    // difference between "retry in a moment" and telling the user to tear down a working
    // GitHub connection — which is what the generic 401 message does, and it never helps
    // because reconnecting produces another token the proxy will strip just the same.
    const proxyStripped = !res.ok && res.status === 401 && res.viaFallback === true;

    // Carried on every error so the pool can decide WHICH account is sick and for how
    // long, rather than treating "GitHub said no" as one undifferentiated failure. A rate
    // limit is a fifteen-minute cooldown; a revoked token is a permanent stop until the
    // user acts. Getting those two the same way round is how an allocator either thrashes
    // or gives up too early.
    const meta = {
        status: res.status,
        scopes: res.headers.get('x-oauth-scopes') || '',
        acceptedScopes: res.headers.get('x-accepted-oauth-scopes') || '',
        rateRemaining: Number(res.headers.get('x-ratelimit-remaining')),
        rateReset: Number(res.headers.get('x-ratelimit-reset')) * 1000 || 0,
        retryAfterMs: Number(res.headers.get('retry-after')) * 1000 || 0,
    };

    if (raw) {
        if (!res.ok) {
            throw Object.assign(new Error(`GitHub API error (${res.status})`), {
                ...meta, ...(proxyStripped ? { code: 'PROXY_AUTH_STRIPPED' } : {}),
            });
        }
        res.ghMeta = meta;
        return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = proxyStripped
            ? 'درخواست از مسیر جایگزین رفت و گیت‌هاب آن را نپذیرفت. اتصال گیت‌هاب شما سالم است؛ کمی بعد دوباره تلاش می‌شود.'
            : ((data && data.message) || `GitHub API error (${res.status})`);
        throw Object.assign(new Error(msg), {
            ...meta, data, ...(proxyStripped ? { code: 'PROXY_AUTH_STRIPPED' } : {}),
        });
    }
    lastMeta = meta;
    return data;
}

// Scopes as GitHub reports them on the last successful call. Read rather than assumed: the
// consent screen lets the user grant less than was asked for, and a token that silently
// lacks `user` must show up as "quota unknown", never as a wrong number.
let lastMeta = null;

/**
 * Who this token belongs to and what it may actually do.
 * The only call that needs the scope header, so the only one that reaches for it.
 */
async function identify(token) {
    requireToken(token);
    const res = await gtFetch(`${API}/user`, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'MLM-VPN-App',
        },
    });
    const scopes = res.headers.get('x-oauth-scopes') || '';
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw Object.assign(new Error((data && data.message) || `GitHub API error (${res.status})`), { status: res.status });
    }
    return {
        login: data.login, name: data.name || data.login, avatarUrl: data.avatar_url || '',
        type: data.type, scopes,
    };
}

/** Does this token carry the scope the billing endpoints demand? */
function hasBillingScope(scopes) {
    return String(scopes || '').split(/\s*,\s*/).includes('user');
}

// ── device flow ──────────────────────────────────────────────────────────────────────

let pending = null;

async function startLogin() {
    const res = await gtFetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
    });
    const d = await res.json().catch(() => ({}));
    if (!d.device_code) throw new Error(d.error_description || 'Could not start GitHub sign-in.');

    pending = {
        deviceCode: d.device_code,
        userCode: d.user_code,
        verificationUri: d.verification_uri,
        interval: Math.max(5, Number(d.interval || 5)),
        expiresAt: Date.now() + (Number(d.expires_in || 900) * 1000),
        state: 'waiting',
        error: '',
    };

    try { require('electron').shell.openExternal(d.verification_uri); } catch (e) {}
    pollLoop().catch(() => {});
    return { userCode: pending.userCode, verificationUri: pending.verificationUri };
}

async function pollLoop() {
    while (pending && pending.state === 'waiting') {
        await new Promise(r => setTimeout(r, pending.interval * 1000));
        if (!pending || pending.state !== 'waiting') return;
        if (Date.now() > pending.expiresAt) {
            pending.state = 'error';
            pending.error = 'The code expired — try connecting again.';
            return;
        }
        let d;
        try {
            const res = await gtFetch(TOKEN_URL, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    device_code: pending.deviceCode,
                    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                }).toString(),
            });
            d = await res.json().catch(() => ({}));
        } catch (e) { continue; }

        if (d.access_token) { await onToken(d.access_token, d.scope || SCOPE); return; }
        if (d.error === 'authorization_pending') continue;
        if (d.error === 'slow_down') { pending.interval = Math.max(pending.interval + 5, Number(d.interval || 10)); continue; }

        pending.state = 'error';
        pending.error = d.error === 'access_denied' ? 'Access was denied.' : (d.error_description || d.error || 'Sign-in failed.');
        return;
    }
}

/**
 * A device-flow sign-in completed.
 *
 * This module no longer owns "the" account: it hands the credential to whoever asked for
 * the sign-in (routes.js -> gt-accounts) and forgets it. That is what makes adding a
 * second, third and tenth account the same operation as adding the first, and it is why
 * there is no store left in this file to accidentally read from.
 */
async function onToken(token, scope) {
    let who = null;
    try { who = await identify(token); } catch (e) {}

    const result = {
        token,
        // What GitHub says was actually granted beats what we asked for. The consent screen
        // lets the user withhold scopes, and the header is the only honest record.
        scopes: (who && who.scopes) || scope || '',
        login: who ? who.login : '',
        name: who ? who.name : '',
        avatarUrl: who ? who.avatarUrl : '',
        connectedAt: Date.now(),
    };

    if (pending) {
        pending.state = 'done';
        pending.login = result.login;
        // Held only until the caller collects it, then wiped by claimPending(). A token
        // sitting in module state for the life of the process is one more place it can be
        // read from for no benefit.
        pending.result = result;
    }
    if (onSignedIn) { try { await onSignedIn(result); } catch (e) {} }
    return result;
}

// Who to hand a completed sign-in to. Set by routes.js so the pool, not this module,
// decides what an account is.
let onSignedIn = null;
function setSignInHandler(fn) { onSignedIn = fn; }

/** The finished credential, removed from memory as it is handed over. */
function claimPending() {
    if (!pending || pending.state !== 'done' || !pending.result) return null;
    const result = pending.result;
    pending.result = null;
    return result;
}

function status() {
    return {
        pending: pending ? {
            state: pending.state, userCode: pending.userCode, verificationUri: pending.verificationUri,
            error: pending.error || '', login: pending.login || '',
        } : null,
    };
}

function cancelPending() { pending = null; return { ok: true }; }

// ── repository (created once, reused forever) ──────────────────────────────────────

async function ensureRepo(token) {
    requireToken(token);
    const me = await gh(token, 'GET', '/user');

    let repo;
    try {
        repo = await gh(token, 'GET', `/repos/${me.login}/${REPO_NAME}`);
    } catch (e) {
        if (e.status !== 404) throw e;
        repo = await gh(token, 'POST', '/user/repos', {
            name: REPO_NAME,
            private: true,
            description: 'MLMVPN GitHub Tunnel — auto-managed, disposable cloud sessions. Safe to delete; it will be recreated automatically.',
            auto_init: true,
        });
    }
    return { fullName: repo.full_name, owner: me.login, name: repo.name, defaultBranch: repo.default_branch || 'main' };
}

// ── workflow file (idempotent push — only writes when content differs) ─────────────

async function ensureWorkflow(token, repoFullName, workflowYaml) {
    requireToken(token);
    const encoded = Buffer.from(workflowYaml, 'utf8').toString('base64');

    let existingSha = null;
    try {
        const existing = await gh(token, 'GET', `/repos/${repoFullName}/contents/${WORKFLOW_PATH}`);
        existingSha = existing.sha;
        const currentContent = Buffer.from(existing.content, 'base64').toString('utf8');
        if (currentContent === workflowYaml) return { changed: false };
    } catch (e) {
        if (e.status !== 404) throw e;
    }

    await gh(token, 'PUT', `/repos/${repoFullName}/contents/${WORKFLOW_PATH}`, {
        message: existingSha ? 'MLMVPN: update tunnel workflow' : 'MLMVPN: add tunnel workflow',
        content: encoded,
        ...(existingSha ? { sha: existingSha } : {}),
    });
    return { changed: true };
}

// ── per-session repo secret (short-lived Tailscale key never touches disk/UI) ──────

async function setRepoSecret(token, repoFullName, secretName, plaintextValue) {
    requireToken(token);
    // Actions secrets are sealed with the repo's own libsodium public key; there is no
    // plaintext path. If the module is missing the whole feature is dead here, so name the
    // cause — a bare MODULE_NOT_FOUND in a Persian UI is unactionable, and this dependency
    // was in fact absent from package.json until it was caught in review.
    let sodium;
    try {
        sodium = require('libsodium-wrappers');
        await sodium.ready;
    } catch (e) {
        throw new Error('یک بخش رمزنگاری در این نسخه از برنامه نصب نشده است. لطفاً نسخه‌ی کامل برنامه را دوباره نصب کنید.');
    }

    const pubKey = await gh(token, 'GET', `/repos/${repoFullName}/actions/secrets/public-key`);
    const messageBytes = sodium.from_string(plaintextValue);
    const keyBytes = sodium.from_base64(pubKey.key, sodium.base64_variants.ORIGINAL);
    const encryptedBytes = sodium.crypto_box_seal(messageBytes, keyBytes);
    const encryptedValue = sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);

    await gh(token, 'PUT', `/repos/${repoFullName}/actions/secrets/${secretName}`, {
        encrypted_value: encryptedValue,
        key_id: pubKey.key_id,
    });
}

async function deleteRepoSecret(token, repoFullName, secretName) {
    requireToken(token);
    try { await gh(token, 'DELETE', `/repos/${repoFullName}/actions/secrets/${secretName}`, null, true); } catch (e) {}
}

// ── dispatch + poll ──────────────────────────────────────────────────────────────────

/**
 * Trigger the workflow and return the id of the run it created.
 *
 * workflow_dispatch does not return a run id, so the run has to be identified afterwards.
 * This used to bracket by time — "any run created after (local now - 5s)" — which is wrong
 * in both directions on a machine whose clock is off, and this module exists partly
 * *because* those machines are common (see clockOffsetMs above):
 *   * clock ahead  -> nothing ever matches, and a session that started perfectly well is
 *                     reported as "did not start in time";
 *   * clock behind -> an OLDER run matches, so the app adopts the previous session's run.
 *                     Then the countdown is anchored to the wrong start, "cancel" cancels
 *                     the wrong machine, and if that old run had already finished the
 *                     session is declared dead the moment it is born.
 *
 * Run ids are assigned by GitHub and strictly increase, so "the first run with an id
 * greater than the newest one that existed before I asked" identifies it exactly, using
 * only GitHub's own ordering and no clock at all.
 */
async function dispatchWorkflow(token, repoFullName, ref, inputs) {
    requireToken(token);
    const listUrl = `/repos/${repoFullName}/actions/workflows/${WORKFLOW_FILENAME}/runs?event=workflow_dispatch&per_page=10`;

    let highestBefore = 0;
    try {
        const prior = await gh(token, 'GET', listUrl);
        for (const r of prior.workflow_runs || []) if (r.id > highestBefore) highestBefore = r.id;
    } catch (e) {
        // A repo whose workflow has never run answers 404 here. That is the first-run case,
        // and 0 is the right floor for it.
        if (e.status !== 404) throw e;
    }

    await gh(token, 'POST', `/repos/${repoFullName}/actions/workflows/${WORKFLOW_FILENAME}/dispatches`, { ref, inputs });

    for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(r => setTimeout(r, 1500));
        let runs;
        try { runs = await gh(token, 'GET', listUrl); } catch (e) { continue; }
        // Ascending, so the oldest run newer than our floor wins — if two dispatches ever
        // race, each takes the one it actually caused rather than both taking the newest.
        const candidates = (runs.workflow_runs || []).filter(r => r.id > highestBefore).sort((a, b) => a.id - b.id);
        if (candidates.length) return candidates[0].id;
    }
    throw new Error('The cloud session did not start in time.');
}

async function getRun(token, repoFullName, runId) {
    requireToken(token);
    return gh(token, 'GET', `/repos/${repoFullName}/actions/runs/${runId}`);
}

/**
 * Recent runs of THIS feature's workflow, newest first.
 *
 * Scoped to our own workflow file rather than the whole repository: the estimate must
 * describe tunnel sessions, and counting some unrelated workflow the user added to the
 * same repo would make it wrong in a direction nobody could explain.
 */
async function listWorkflowRuns(token, repoFullName, { perPage = 100 } = {}) {
    requireToken(token);
    const per = Math.min(Math.max(Number(perPage) || 100, 1), 100);
    try {
        const data = await gh(token, 'GET',
            `/repos/${repoFullName}/actions/workflows/${WORKFLOW_FILENAME}/runs?per_page=${per}`);
        const runs = data.workflow_runs || [];
        return { runs, total: data.total_count || runs.length, truncated: (data.total_count || 0) > runs.length };
    } catch (e) {
        // A repo whose workflow has never run answers 404. That is "no runs", not a fault.
        if (e.status === 404) return { runs: [], total: 0, truncated: false };
        throw e;
    }
}

async function cancelRun(token, repoFullName, runId) {
    requireToken(token);
    try { await gh(token, 'POST', `/repos/${repoFullName}/actions/runs/${runId}/cancel`, null, true); } catch (e) {}
}

/** Reads {ip, port, username, password} once the running workflow has committed
 *  sessions/<id>.json via the Contents API (see gt-workflow-template.js for why this is
 *  used instead of job logs: logs aren't available through the API until the whole job
 *  finishes, and this job intentionally stays alive for hours). */
async function getSessionData(token, repoFullName, sessionId) {
    requireToken(token);
    try {
        const file = await gh(token, 'GET', `/repos/${repoFullName}/contents/sessions/${sessionId}.json`);
        const text = Buffer.from(file.content, 'base64').toString('utf8');
        return JSON.parse(text);
    } catch (e) {
        if (e.status === 404) return null;
        throw e;
    }
}

/** Best-effort cleanup once the app has read the session file — it holds an RDP password. */
async function deleteSessionFile(token, repoFullName, sessionId) {
    requireToken(token);
    try {
        const file = await gh(token, 'GET', `/repos/${repoFullName}/contents/sessions/${sessionId}.json`);
        await gh(token, 'DELETE', `/repos/${repoFullName}/contents/sessions/${sessionId}.json`, {
            message: 'MLMVPN: clear session data', sha: file.sha,
        });
    } catch (e) {}
}

// ── Actions billing ─────────────────────────────────────────────────────────────────

/**
 * The account's real GitHub Actions allowance, or null if this token cannot see it.
 *
 * VERIFIED AGAINST THE LIVE API, not assumed. Called with a `repo, workflow` token the
 * endpoint answers 404 — and the rejection carries `X-Accepted-OAuth-Scopes: user`, with a
 * documentation_url naming this exact route. That is what proves both that the route still
 * exists and that `user` is the one thing missing. (A route GitHub does not know answers
 * differently: no accepted-scopes header and a generic docs link.)
 *
 * Returns null rather than throwing on 403/404 — "cannot see it" is an ordinary state for
 * an account authorised by an older build, and it must degrade to an estimate rather than
 * failing a connect.
 */
async function getActionsBilling(token, login) {
    requireToken(token);
    let data;
    try {
        data = await gh(token, 'GET', `/users/${encodeURIComponent(login)}/settings/billing/actions`);
    } catch (e) {
        if (e.status === 404 || e.status === 403) return null;
        throw e;
    }
    // Read defensively. GitHub is actively reshaping billing APIs, and a field that stops
    // being sent must degrade to "unknown", never to a zero that reads as "no minutes left"
    // and takes a working account out of the pool.
    const included = Number(data.included_minutes);
    const used = Number(data.total_minutes_used);
    const paid = Number(data.total_paid_minutes_used);
    if (!Number.isFinite(included) || !Number.isFinite(used)) return null;
    return {
        includedMinutes: included,
        usedMinutes: used,
        paidMinutesUsed: Number.isFinite(paid) ? paid : 0,
        breakdown: data.minutes_used_breakdown || null,
    };
}

module.exports = {
    startLogin, status, cancelPending, claimPending, setSignInHandler, identify, hasBillingScope,
    ensureRepo, ensureWorkflow, setRepoSecret, deleteRepoSecret, getActionsBilling,
    dispatchWorkflow, getRun, cancelRun, listWorkflowRuns, getSessionData, deleteSessionFile, serverNow,
    REPO_NAME, WORKFLOW_FILENAME, WORKFLOW_PATH, CLIENT_ID, SCOPE,
};
