// --- "Login with Railway" (OAuth 2.0 + PKCE) ---
// Replaces the manual "create an API token and paste it" step. The user clicks one button,
// authorises in their browser, and the app holds a refreshable token from then on.
//
// APP TYPE IS **NATIVE (PUBLIC)**: Railway's docs are explicit that native apps
// "authenticate using PKCE exclusively. Do not send a client secret, otherwise the token
// request will fail." So there is no secret in this file — a shipped desktop app cannot
// keep one anyway. PKCE is what proves the token request came from the same client that
// started the flow.
//
// REDIRECT: a loopback HTTP server on a FIXED port. Railway requires the redirect_uri to
// match a registered URI exactly, and the app's own Express port is dynamic, so we cannot
// reuse it. 53682 is a high, unlikely-to-clash port; it is only listening for the seconds
// the login takes.
//
// HOSTS: the browser-facing authorize URL uses backboard.railway.com (a real browser passes
// its Cloudflare check). The token exchange is server-to-server from this process, and
// railway.com's Cloudflare returns an HTML 403 to non-browser clients — the same trap that
// broke the GraphQL endpoint earlier — so token calls try railway.app FIRST and only fall
// back to .com.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STORE_FILE = path.join(HOME_DIR, 'vodi-oauth.json');
// Where this file lived before the feature was renamed. Read once if the new one is
// absent: these are live Railway sessions, and throwing them away would silently sign the
// user out of an account their already-deployed servers still belong to.
const LEGACY_STORE_FILE = path.join(HOME_DIR, 'x4g-oauth.json');

function readStoreFile() {
    for (const file of [STORE_FILE, LEGACY_STORE_FILE]) {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (e) { if (e.code !== 'ENOENT') return null; }
    }
    return null;
}

const REDIRECT_PORT = 53682;
// Railway rejects `localhost` when registering a native redirect URI and requires the
// literal loopback IP, so this must stay 127.0.0.1 — it has to match the registered value
// byte for byte.
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;

// Both the browser-facing authorize URL and the token endpoint use backboard.railway.APP.
// railway.COM sits behind a Cloudflare rule that blocks Iranian IPs outright ("Sorry, you
// have been blocked") and also 403s server-to-server calls; railway.app serves the same
// OAuth endpoints without either problem — verified: /oauth/auth returns a 303 to the
// interaction page and /oauth/token answers with proper JSON.
const AUTH_URL = 'https://backboard.railway.app/oauth/auth';
const TOKEN_HOSTS = ['https://backboard.railway.app', 'https://backboard.railway.com'];

// SCOPES — every one of these is load-bearing:
//   openid                required by Railway.
//   email, profile        required to resolve workspace membership; without them a
//                         workspace scope cannot be evaluated and API calls come back
//                         "Not Authorized".
//   offline_access        yields the refresh token — but ONLY together with prompt=consent
//                         (see the authorize URL below). Without it the user would have to
//                         sign in again every hour.
//   workspace:admin       the resource scope that actually permits projectCreate. Requesting
//                         admin sets the CEILING, not the grant: Railway caps the token at
//                         the user's real role, so a member gets member-level access.
// Missing this last one was why the first real deploy failed with "Not Authorized" right at
// ساخت پروژه.
const DEFAULT_SCOPES = process.env.RAILWAY_OAUTH_SCOPES ||
    'openid email profile offline_access workspace:admin';

// ── store ────────────────────────────────────────────────────────────────────────

// MULTI-ACCOUNT. The first version kept a single token set at the root of this file, so a
// second "Login with Railway" silently overwrote the first — one Railway account, one
// server. Each account has its own project/resource limits, so users legitimately need
// several. Accounts now live in an array; the legacy single-token shape is migrated once.
function load() {
    const s = readStoreFile();
    if (!s || typeof s !== 'object') return { accounts: [] };

    if (!Array.isArray(s.accounts)) {
        s.accounts = [];
        if (s.accessToken || s.refreshToken) {
            s.accounts.push({
                id: 'acc_legacy',
                accessToken: s.accessToken,
                refreshToken: s.refreshToken,
                expiresAt: s.expiresAt,
                scope: s.scope || '',
                profile: s.profile || null,
                addedAt: Date.now(),
            });
        }
        delete s.accessToken; delete s.refreshToken; delete s.expiresAt;
        delete s.scope; delete s.profile;
        try { save(s); } catch (e) { /* migration is best-effort */ }
    }
    return s;
}

function findAcc(s, accountId) {
    if (!accountId) return s.accounts[0] || null;
    return s.accounts.find(a => a.id === accountId) || null;
}

function save(data) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    return data;
}

// The app's own OAuth client id. A client id is PUBLIC by definition — it is sent in the
// browser URL on every login — so it ships with the app and no user ever types it. The
// matching app is registered as Native (Public): PKCE only, no secret.
const DEFAULT_CLIENT_ID = 'rlwy_oaci_89LTOyXZcSB9VNYtGtPkMY6Q';

function getClientId() {
    return process.env.RAILWAY_CLIENT_ID || load().clientId || DEFAULT_CLIENT_ID;
}

function setClientId(id) {
    const s = load();
    s.clientId = String(id || '').trim();
    return save(s);
}

// Optional. A **Native (Public)** app must not send one — Railway rejects the request if
// it does. It is supported only so a Web (Confidential) app can be used during testing;
// shipping a secret inside a desktop app does not keep it secret from anyone who unpacks it.
function getClientSecret() {
    return process.env.RAILWAY_CLIENT_SECRET || load().clientSecret || '';
}

function setClientSecret(secret) {
    const s = load();
    const v = String(secret || '').trim();
    if (v) s.clientSecret = v; else delete s.clientSecret;
    return save(s);
}

// ── PKCE ─────────────────────────────────────────────────────────────────────────

function b64url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makePkce() {
    const verifier = b64url(crypto.randomBytes(48));            // 64 chars, within 43..128
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    return { verifier, challenge };
}

// ── token endpoint ───────────────────────────────────────────────────────────────

async function tokenRequest(params) {
    const body = new URLSearchParams(params).toString();
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
    // Confidential (Web) apps authenticate with HTTP Basic; public (Native) apps must send
    // nothing but PKCE. Probing Railway with a public request on a confidential client
    // returns exactly `invalid_client: client authentication failed`.
    const secret = getClientSecret();
    if (secret) {
        headers.Authorization = 'Basic ' +
            Buffer.from(`${getClientId()}:${secret}`).toString('base64');
    }
    let lastErr = 'پاسخی از Railway نیامد';
    for (const host of TOKEN_HOSTS) {
        try {
            const res = await fetch(`${host}/oauth/token`, {
                method: 'POST',
                headers,
                body,
            });
            const text = await res.text();
            let data;
            try { data = JSON.parse(text); }
            catch (e) {
                // Cloudflare HTML block page — try the next host rather than reporting a
                // bogus "invalid token" to the user.
                lastErr = `پاسخ نامعتبر از ${host} (${res.status})`;
                continue;
            }
            if (!res.ok || data.error) {
                throw new Error(data.error_description || data.error || `خطای توکن (${res.status})`);
            }
            return data;
        } catch (e) {
            lastErr = e.message;
        }
    }
    throw new Error(`تبادل توکن با Railway ناموفق بود: ${lastErr}`);
}

/**
 * Store a token set against an account. `accountId` empty means "a brand-new login":
 * a fresh entry is created, unless the same Railway user signs in again — then their
 * existing entry is refreshed rather than duplicated.
 */
function persistTokens(tok, accountId, profile) {
    const s = load();
    let acc = accountId ? findAcc(s, accountId) : null;

    if (!acc && profile && profile.email) {
        acc = s.accounts.find(a => a.profile && a.profile.email === profile.email) || null;
    }
    if (!acc) {
        acc = { id: 'acc_' + crypto.randomBytes(6).toString('hex'), addedAt: Date.now() };
        s.accounts.push(acc);
    }

    acc.accessToken = tok.access_token;
    if (tok.refresh_token) acc.refreshToken = tok.refresh_token;   // rotated; keep the newest
    acc.expiresAt = Date.now() + (Number(tok.expires_in || 3600) * 1000);
    acc.scope = tok.scope || acc.scope || '';
    if (profile) acc.profile = profile;
    save(s);
    return acc;
}

// ── login flow ───────────────────────────────────────────────────────────────────

let pending = null;      // { server, state, verifier, startedAt }

function stopPending() {
    if (pending && pending.server) { try { pending.server.close(); } catch (e) {} }
    pending = null;
}

/**
 * Begin the browser login. Returns immediately with the URL that was opened; the renderer
 * polls status() until `connected` flips true.
 */
async function startLogin({ clientId, clientSecret } = {}) {
    if (clientId) setClientId(clientId);
    if (clientSecret !== undefined) setClientSecret(clientSecret);
    const cid = getClientId();
    if (!cid) {
        throw new Error('شناسهٔ OAuth (Client ID) ثبت نشده است. اول در Railway یک OAuth App از نوع Native بسازید و Client ID را وارد کنید.');
    }

    stopPending();

    const { verifier, challenge } = makePkce();
    const state = b64url(crypto.randomBytes(16));

    const server = http.createServer(async (req, res) => {
        if (!req.url.startsWith('/callback')) { res.writeHead(404); res.end(); return; }
        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
        const code = url.searchParams.get('code');
        const gotState = url.searchParams.get('state');
        const err = url.searchParams.get('error');

        const reply = (title, msg, ok) => {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(`<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>${title}</title></head>
<body style="font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center;max-width:420px;padding:24px">
  <div style="font-size:44px">${ok ? '✅' : '⚠️'}</div>
  <h2 style="margin:12px 0 8px">${title}</h2>
  <p style="color:#9a97a3;line-height:2">${msg}</p>
</div></body></html>`);
        };

        try {
            if (err) throw new Error(err);
            if (!code) throw new Error('کد بازگشتی دریافت نشد');
            // State check is the CSRF guard: without it, a crafted callback could inject a
            // code obtained under someone else's session.
            if (!pending || gotState !== pending.state) throw new Error('state نامعتبر است');

            const tok = await tokenRequest({
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
                client_id: cid,
                code_verifier: pending.verifier,
            });
            // Identify the account BEFORE storing, so signing in with a second Railway
            // account adds an entry instead of overwriting the first one.
            let profile = null;
            try { profile = await fetchProfileWithToken(tok.access_token); } catch (e) { /* cosmetic */ }
            persistTokens(tok, '', profile);
            const who = profile && (profile.name || profile.email);
            reply('اتصال برقرار شد',
                `حساب Railway${who ? ` «${who}»` : ''} با موفقیت متصل شد. می‌توانید این صفحه را ببندید و به برنامه برگردید.`,
                true);
        } catch (e) {
            reply('اتصال ناموفق بود', String(e.message || e), false);
        } finally {
            setTimeout(stopPending, 500);
        }
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(REDIRECT_PORT, '127.0.0.1', resolve);
    });

    pending = { server, state, verifier, startedAt: Date.now() };
    // Abandoned logins must not leave a listening socket behind.
    setTimeout(() => { if (pending && Date.now() - pending.startedAt >= 300000) stopPending(); }, 300000);

    const authUrl = `${AUTH_URL}?` + new URLSearchParams({
        response_type: 'code',
        client_id: cid,
        redirect_uri: REDIRECT_URI,
        scope: DEFAULT_SCOPES,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        // Railway only issues a refresh token when offline_access is paired with an
        // explicit consent prompt. Omitting this silently downgrades the login to a
        // one-hour session.
        prompt: 'consent',
    }).toString();

    // Open in the user's real browser, where an existing Railway session (and Cloudflare's
    // browser check) just works.
    try { require('electron').shell.openExternal(authUrl); } catch (e) { /* renderer can fall back */ }

    return { authUrl, redirectUri: REDIRECT_URI };
}

// ── tokens ───────────────────────────────────────────────────────────────────────

async function refresh(accountId) {
    const s = load();
    const acc = findAcc(s, accountId);
    if (!acc || !acc.refreshToken) throw new Error('اتصال Railway منقضی شده — دوباره وارد شوید.');
    const tok = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: acc.refreshToken,
        client_id: getClientId(),
    });
    persistTokens(tok, acc.id, acc.profile);
    return tok.access_token;
}

/** A valid access token for one account, refreshed on demand (they live one hour). */
async function getAccessToken(accountId) {
    const s = load();
    const acc = findAcc(s, accountId);
    if (!acc || (!acc.accessToken && !acc.refreshToken)) throw new Error('به Railway وارد نشده‌اید.');
    // 60s of slack so a token cannot expire mid-deploy.
    if (acc.accessToken && acc.expiresAt && Date.now() < acc.expiresAt - 60000) return acc.accessToken;
    return await refresh(acc.id);
}

/** Read the Railway profile for a freshly issued token (used to name/dedupe the account). */
async function fetchProfileWithToken(token) {
    const res = await fetch('https://backboard.railway.app/graphql/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query: 'query { me { name email } }' }),
    });
    const data = await res.json().catch(() => ({}));
    return (data && data.data && data.data.me) || null;
}

function status() {
    const s = load();
    const accounts = (s.accounts || []).map(a => {
        const scope = a.scope || '';
        return {
            id: a.id,
            profile: a.profile || null,
            name: (a.profile && (a.profile.name || a.profile.email)) || 'حساب Railway',
            scope,
            // A token minted before the workspace scope was added authenticates fine but
            // cannot create anything — it fails deep inside a deploy with a bare
            // "Not Authorized". Flag it up front so the panel can ask for one re-login.
            needsReauth: !!scope && !/workspace:/.test(scope),
            addedAt: a.addedAt || 0,
        };
    });
    return {
        connected: accounts.length > 0,
        accounts,
        clientId: getClientId(),
        hasClientId: !!getClientId(),
        redirectUri: REDIRECT_URI,
    };
}

/** Remove one account, or every account when no id is given. */
function disconnect(accountId) {
    stopPending();
    if (!accountId) {
        try { fs.unlinkSync(STORE_FILE); } catch (e) {}
        return { ok: true, removed: 'all' };
    }
    const s = load();
    const before = s.accounts.length;
    s.accounts = s.accounts.filter(a => a.id !== accountId);
    save(s);
    return { ok: true, removed: before - s.accounts.length };
}

module.exports = {
    startLogin, getAccessToken, refresh,
    status, disconnect, setClientId, getClientId, setClientSecret, getClientSecret,
    REDIRECT_URI,
};
