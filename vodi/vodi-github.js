// --- GitHub connection (OAuth Device Flow) ---
// WHY THIS EXISTS: Railway will not lift its "Limited Trial" network restriction until the
// account is verified, and verifying with GitHub only succeeds if that GitHub account owns
// **at least one repository**. A brand-new, empty GitHub account is rejected. That single
// undocumented requirement is what silently broke every deploy: the service ran fine and
// the domain never answered.
//
// So this module makes sure the user ends up with a GitHub account that has a repo:
//   1. sign in with the Device Flow (built for desktop apps — no secret, no redirect URI;
//      the user types a short code in their browser),
//   2. if they already own a repo, do nothing,
//   3. otherwise create one small public repo for them.
//
// It deliberately does NOT claim to verify Railway: linking GitHub to Railway is Railway's
// own OAuth handshake and can only be clicked inside Railway. We just guarantee the
// precondition and then send the user to the right page.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CLIENT_ID = process.env.GITHUB_CLIENT_ID || 'Ov23liWP55HtVHdmfZ9P';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const API = 'https://api.github.com';
// public_repo is the narrowest scope that still allows creating a repository. We never ask
// for private-repo access: the goal is one throwaway public repo, nothing more.
const SCOPE = 'public_repo';

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STORE_FILE = path.join(HOME_DIR, 'vodi-github.json');

// Where this file lived before the feature was renamed. Read once if the new one is
// absent, so a user who already signed in to GitHub is not asked to do it again.
const LEGACY_STORE_FILE = path.join(HOME_DIR, 'x4g-github.json');

function load() {
    for (const file of [STORE_FILE, LEGACY_STORE_FILE]) {
        try {
            const s = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(s.accounts)) s.accounts = [];
            return s;
        } catch (e) { if (e.code !== 'ENOENT') break; }
    }
    return { accounts: [] };
}

function save(s) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    return s;
}

function findAcc(s, id) {
    if (!id) return s.accounts[0] || null;
    return s.accounts.find(a => a.id === id) || null;
}

// ── GitHub API ───────────────────────────────────────────────────────────────────

async function gh(token, method, endpoint, body = null) {
    const res = await fetch(`${API}${endpoint}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            // GitHub rejects API calls without a User-Agent.
            'User-Agent': 'MLM-VPN-App',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = (data && data.message) || `خطای گیت‌هاب (${res.status})`;
        const err = new Error(msg);
        err.status = res.status;
        throw err;
    }
    return data;
}

// ── device flow ──────────────────────────────────────────────────────────────────

let pending = null;   // { deviceCode, interval, expiresAt, userCode, verificationUri, state, error, run }
// Every device flow gets a serial number, and only the loop whose number still matches the
// live `pending` keeps polling. Without it a second «اتصال گیت‌هاب» left the FIRST loop
// running against the SECOND device code: two pollers on one code, which GitHub answers
// with slow_down, so the login appeared to hang and the user started it again.
let runSeq = 0;

/** Kick off the device flow: returns the short code the user types into GitHub. */
async function startLogin() {
    // Abandon whatever was in flight before asking GitHub for a new code.
    if (pending && pending.state === 'waiting') pending.state = 'cancelled';
    const res = await fetch(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
    });
    const d = await res.json().catch(() => ({}));
    if (!d.device_code) throw new Error(d.error_description || 'شروع ورود گیت‌هاب ناموفق بود.');

    const run = ++runSeq;
    pending = {
        run,
        deviceCode: d.device_code,
        userCode: d.user_code,
        verificationUri: d.verification_uri,
        interval: Math.max(5, Number(d.interval || 5)),
        expiresAt: Date.now() + (Number(d.expires_in || 900) * 1000),
        state: 'waiting',
        error: '',
    };

    // Open the page for them; the code still has to be typed, so it is shown in the panel too.
    try { require('electron').shell.openExternal(d.verification_uri); } catch (e) {}

    pollLoop(run).catch(() => {});
    return { userCode: pending.userCode, verificationUri: pending.verificationUri };
}

async function pollLoop(run) {
    while (pending && pending.run === run && pending.state === 'waiting') {
        await new Promise(r => setTimeout(r, pending.interval * 1000));
        // A newer flow (or a cancel) retires this loop: `pending` is module state, so
        // without this check the old loop would poll the NEW code alongside the new loop.
        if (!pending || pending.run !== run || pending.state !== 'waiting') return;
        if (Date.now() > pending.expiresAt) {
            pending.state = 'error';
            pending.error = 'مهلت کد تمام شد — دوباره تلاش کنید.';
            return;
        }
        let d;
        try {
            const res = await fetch(TOKEN_URL, {
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

        if (d.access_token) {
            await onToken(d.access_token, d.scope || SCOPE);
            return;
        }
        // These two are normal parts of the flow, not failures.
        if (d.error === 'authorization_pending') continue;
        if (d.error === 'slow_down') { pending.interval = Math.max(pending.interval + 5, Number(d.interval || 10)); continue; }

        pending.state = 'error';
        pending.error = d.error === 'access_denied'
            ? 'دسترسی رد شد.'
            : (d.error_description || d.error || 'ورود ناموفق بود.');
        return;
    }
}

async function onToken(token, scope) {
    let me = null;
    try { me = await gh(token, 'GET', '/user'); } catch (e) { /* cosmetic */ }

    const s = load();
    let acc = me ? s.accounts.find(a => a.login === me.login) : null;
    if (!acc) {
        acc = { id: 'gh_' + crypto.randomBytes(5).toString('hex'), addedAt: Date.now() };
        s.accounts.push(acc);
    }
    acc.token = token;
    acc.scope = scope || '';
    acc.login = me ? me.login : (acc.login || '');
    acc.name = me ? (me.name || me.login) : acc.login;
    save(s);

    pending.state = 'done';
    pending.accountId = acc.id;
    pending.login = acc.login;
}

// ── the actual requirement: an account that owns at least one repo ────────────────

/**
 * Guarantee the account owns a repository, creating a throwaway public one if not.
 * Returns { login, hadRepo, repo }.
 */
async function ensureRepo(accountId) {
    const s = load();
    const acc = findAcc(s, accountId);
    if (!acc || !acc.token) throw new Error('به گیت‌هاب وارد نشده‌اید.');

    // Only the user's OWN repos count for Railway's check, hence affiliation=owner.
    const repos = await gh(acc.token, 'GET', '/user/repos?per_page=1&affiliation=owner');
    if (Array.isArray(repos) && repos.length > 0) {
        acc.repoCount = repos.length;
        save(s);
        return { login: acc.login, hadRepo: true, repo: repos[0].full_name };
    }

    // Name is deliberately boring and unique-ish; auto_init gives it a commit so it is a
    // real, non-empty repository.
    const name = 'my-project-' + crypto.randomBytes(3).toString('hex');
    let created;
    try {
        created = await gh(acc.token, 'POST', '/user/repos', {
            name,
            private: false,
            auto_init: true,
            description: 'Personal project',
        });
    } catch (e) {
        if (e.status === 403 || e.status === 404) {
            throw new Error('اجازه‌ی ساخت ریپازیتوری داده نشد. در صفحه‌ی گیت‌هاب هنگام ورود، ' +
                'دسترسی ساخت ریپو (public_repo) را تأیید کنید یا خودتان یک ریپوی ساده بسازید.');
        }
        throw e;
    }
    acc.repoCount = 1;
    save(s);
    return { login: acc.login, hadRepo: false, repo: created.full_name };
}

function status() {
    const s = load();
    return {
        connected: s.accounts.length > 0,
        accounts: s.accounts.map(a => ({
            id: a.id, login: a.login || '', name: a.name || a.login || 'GitHub',
            repoCount: typeof a.repoCount === 'number' ? a.repoCount : null,
            addedAt: a.addedAt || 0,
        })),
        pending: pending ? {
            state: pending.state,
            userCode: pending.userCode,
            verificationUri: pending.verificationUri,
            error: pending.error || '',
            login: pending.login || '',
            accountId: pending.accountId || '',
        } : null,
    };
}

function disconnect(accountId) {
    const s = load();
    if (!accountId) { s.accounts = []; } else { s.accounts = s.accounts.filter(a => a.id !== accountId); }
    save(s);
    return { ok: true };
}

function cancelPending() {
    if (pending && pending.state === 'waiting') pending.state = 'cancelled';
    pending = null;
    return { ok: true };
}

module.exports = { startLogin, ensureRepo, status, disconnect, cancelPending, CLIENT_ID };
