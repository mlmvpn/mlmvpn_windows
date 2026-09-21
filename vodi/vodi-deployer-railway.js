// --- VodiWalker Railway deployer ---
// Deploys the VodiWalker panel to the user's OWN Railway account and reads back the
// *.up.railway.app domain, so the app can mint a VLESS node from it. Mirrors the GST
// Cloudflare deployer in shape: bring-your-own account, one token, progress via onLog,
// prove it works before reporting success.
//
// SOURCE: VodiWalker ships as source (FastAPI + uvicorn), not as a published image, so the
// service is created straight from the public repository and Railway builds it. There is no
// registry to maintain and no image to keep in step with upstream. Two details make that
// build deterministic rather than a guess:
//   • the repo carries `Dockerfile.txt`, NOT `Dockerfile`, so Railway's builder never sees
//     a Dockerfile and falls through to Nixpacks' Python provider,
//   • Nixpacks would then infer a start command, so we set one explicitly instead.
// If a Railway account refuses repository sources (some do, when no GitHub identity is
// linked), VODI_IMAGE lets an image tag be used instead — see deployService().
//
// Railway is NOT a CDN — *.up.railway.app lives on Railway's own /24 (69.46.46.0/24), not
// Cloudflare — so clean-IP "combine" does not apply here; the config uses the Railway
// domain directly.
//
// TWO TOKEN TYPES are supported, because Railway hands users both and they look identical
// (a UUID):
//   • Account/Team token  → Authorization: Bearer <t>.  Can `me` + projectCreate, so we
//     make a fresh project per gateway.
//   • Project token       → Project-Access-Token: <t>.  Scoped to ONE existing project; it
//     cannot make projects, so we deploy a service INTO that project.
// resolveContext() probes which one it is.
//
// NOTE: the API host is backboard.railway.APP. backboard.railway.COM sits behind Cloudflare
// bot-protection and 403s server-to-server calls — that was the original "token 403".

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./vodi-config');
const oauth = require('./vodi-oauth');

// The upstream panel. Public, so Railway can clone and build it without the user holding
// any GitHub identity of their own.
const VODI_REPO = process.env.VODI_REPO || 'Vodiwalker/vodiwalker_panel';
const VODI_BRANCH = process.env.VODI_BRANCH || 'main';
// Nixpacks' Python provider would run `python main.py`, which works only because the repo
// happens to carry a __main__ block. Naming the ASGI entrypoint ourselves removes that
// coincidence, and binds the port Railway actually injects.
const VODI_START = process.env.VODI_START || 'uvicorn main:app --host 0.0.0.0 --port $PORT';
// Optional escape hatch: set this and the service is built from an image instead of the
// repo. Empty by default — nothing in this feature depends on a registry existing.
const VODI_IMAGE = process.env.VODI_IMAGE || '';
const GQL = 'https://backboard.railway.app/graphql/v2';

const REGIONS = [
    { value: 'us-west2',       label: 'آمریکا — غرب (California)' },
    { value: 'us-east4',       label: 'آمریکا — شرق (Virginia)' },
    { value: 'europe-west4',   label: 'اروپا — آمستردام' },
    { value: 'asia-southeast1',label: 'آسیا — سنگاپور' },
    { value: 'us-east4-eqdc4', label: 'آمریکا — شرق (Metal)' },
];

const PANEL_STORE = path.join(os.homedir(), '.mlmvpn', 'user_data.json');

// ── account token store ─────────────────────────────────────────────────────────

function readPanelAccounts() {
    try {
        const data = JSON.parse(fs.readFileSync(PANEL_STORE, 'utf8'));
        const raw = data.railway_accounts;
        if (!raw) return [];
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function getAccounts() {
    const seen = new Set();
    const out = [];
    for (const a of readPanelAccounts()) {
        const token = a.token || a.apiKey || '';
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push({ id: String(a.id || token.slice(-8)), name: a.name || a.email || 'Railway', token });
    }
    return out;
}

function findAccount(accountId) {
    const acc = getAccounts().find(a => a.id === accountId);
    if (!acc) throw new Error('این حساب Railway پیدا نشد — از همین پنل اضافه‌اش کنید.');
    return acc;
}

// OAuth logins are exposed as pseudo-accounts with ids of the form `oauth:<accountId>`,
// so every call site (deploy, delete, verify) is identical whether the user pasted a token
// or signed in — and several Railway accounts can be connected at once.
const OAUTH_ACCOUNT_ID = 'oauth';

function isOauthId(accountId) {
    return accountId === OAUTH_ACCOUNT_ID || String(accountId || '').startsWith('oauth:');
}

async function resolveAccount(accountId) {
    if (isOauthId(accountId)) {
        // Bare 'oauth' is the pre-multi-account form; it means "the first one".
        const sub = String(accountId).startsWith('oauth:') ? String(accountId).slice(6) : '';
        const token = await oauth.getAccessToken(sub);   // refreshes if the hour is up
        const st = oauth.status();
        const entry = (st.accounts || []).find(a => a.id === sub) || (st.accounts || [])[0];
        return { id: accountId, name: (entry && entry.name) || 'Railway (ورود با Railway)', token };
    }
    return findAccount(accountId);
}

// ── GraphQL helper ──────────────────────────────────────────────────────────────
// ctx = { token, authMode: 'bearer' | 'project' }

function authHeader(ctx) {
    return ctx.authMode === 'project'
        ? { 'Project-Access-Token': ctx.token }
        : { Authorization: `Bearer ${ctx.token}` };
}

async function gql(ctx, query, variables = {}, { timeout = 30000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(GQL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader(ctx) },
            body: JSON.stringify({ query, variables }),
            signal: controller.signal,
        });
        // railway.app returns JSON even for GraphQL errors (HTTP 200). A non-JSON body
        // (e.g. a Cloudflare 403 HTML page) means the wrong host/blocked — say so plainly.
        const text = await res.text();
        let data;
        try { data = JSON.parse(text); }
        catch (e) { throw new Error(`پاسخ نامعتبر از Railway (${res.status}) — احتمالاً دسترسی مسدود شده.`); }
        if (data.errors && data.errors.length) {
            throw new Error(data.errors.map(e => e.message).join(' | '));
        }
        if (!res.ok) throw new Error(`خطای Railway (${res.status})`);
        return data.data || {};
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Figure out what kind of token this is and return a ready-to-use context.
 * For a project token, projectId/environmentId come from the token itself.
 */
async function resolveContext(token) {
    // Try project token first — it is the more restrictive one and gives us the project
    // context directly.
    try {
        const d = await gql({ token, authMode: 'project' },
            `query { projectToken { projectId environmentId } }`, {}, { timeout: 15000 });
        if (d.projectToken && d.projectToken.projectId) {
            return {
                token, authMode: 'project',
                projectId: d.projectToken.projectId,
                environmentId: d.projectToken.environmentId,
            };
        }
    } catch (e) { /* not a project token — fall through */ }

    // Account/team token (this is also what an OAuth access token looks like).
    // Ask for workspaces in the same round-trip: an OAuth token is scoped to the workspace
    // the user picked on the consent screen, and projectCreate needs that workspaceId or it
    // has nowhere to put the project.
    try {
        const d = await gql({ token, authMode: 'bearer' },
            `query { me { name email workspaces { id name plan } } }`, {}, { timeout: 15000 });
        if (d.me) {
            const ws = (d.me.workspaces || [])[0];
            return {
                token, authMode: 'bearer', me: d.me,
                workspaceId: ws ? ws.id : '',
                // FREE == Railway's "Limited Trial": the service deploys and runs, but its
                // network is restricted, so the public domain never answers. That is the
                // single most confusing failure in this whole flow — surface it up front.
                plan: ws ? ws.plan : '',
            };
        }
    } catch (e) { /* older/limited tokens may not expose workspaces — try without */ }

    try {
        const d = await gql({ token, authMode: 'bearer' },
            `query { me { name email } }`, {}, { timeout: 15000 });
        if (d.me) return { token, authMode: 'bearer', me: d.me, workspaceId: '' };
    } catch (e) { /* fall through to the shared error */ }

    throw new Error('توکن معتبر نیست یا نوعش پشتیبانی نمی‌شود. یک توکن از Railway → Account → Tokens بساز (یا Project Token).');
}

/** Validate a token for the wizard's "بررسی اعتبار". */
async function verifyToken(token) {
    const ctx = await resolveContext(token);
    if (ctx.authMode === 'project') {
        return { type: 'project', name: `پروژه‌ی موجود (${String(ctx.projectId).slice(0, 8)}…)` };
    }
    return { type: 'account', name: (ctx.me && (ctx.me.name || ctx.me.email)) || 'حساب Railway' };
}

// ── Railway mutations (centralized so they are trivial to correct against the live
// schema during the first real deploy). All take the resolved ctx. ────────────────

async function projectCreate(ctx, name) {
    const q = `mutation($input: ProjectCreateInput!) {
        projectCreate(input: $input) { id environments { edges { node { id name } } } }
    }`;
    // workspaceId is optional in the schema, but an OAuth token only has rights inside the
    // workspace the user shared — omitting it there fails with "Not Authorized".
    const input = { name };
    if (ctx.workspaceId) input.workspaceId = ctx.workspaceId;
    const d = await gql(ctx, q, { input });
    const p = d.projectCreate;
    if (!p || !p.id) throw new Error('ساخت پروژه‌ی Railway ناموفق بود.');
    const edges = (p.environments && p.environments.edges) || [];
    const envEdge = edges.find(e => e.node && e.node.name === 'production') || edges[0];
    const environmentId = envEdge && envEdge.node && envEdge.node.id;
    if (!environmentId) throw new Error('محیط (environment) پروژه پیدا نشد.');
    return { projectId: p.id, environmentId };
}

/**
 * Create the service. `source` is either { repo, branch } or { image }.
 * Returns the service id.
 */
async function serviceCreate(ctx, projectId, environmentId, name, source) {
    const q = `mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }`;
    const input = { projectId, environmentId, name, source: source.image
        ? { image: source.image }
        : { repo: source.repo } };
    if (source.repo && source.branch) input.branch = source.branch;
    const d = await gql(ctx, q, { input });
    const id = d.serviceCreate && d.serviceCreate.id;
    if (!id) throw new Error('ساخت سرویس ناموفق بود.');
    return id;
}

/**
 * Everything that lives on the service INSTANCE rather than the service: region, start
 * command, and the builder. One mutation, because Railway applies them together and
 * issuing three separate ones is three chances to half-apply.
 *
 * Each field is optional; only what is passed gets sent.
 */
async function serviceInstanceUpdate(ctx, serviceId, environmentId, patch) {
    const input = {};
    if (patch.region) input.region = patch.region;
    if (patch.startCommand) input.startCommand = patch.startCommand;
    if (patch.builder) input.builder = patch.builder;
    if (!Object.keys(input).length) return;
    const q = `mutation($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
        serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
    }`;
    await gql(ctx, q, { serviceId, environmentId, input });
}

async function volumeCreate(ctx, projectId, environmentId, serviceId, mountPath) {
    const q = `mutation($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }`;
    const d = await gql(ctx, q, { input: { projectId, environmentId, serviceId, mountPath } });
    return d.volumeCreate && d.volumeCreate.id;
}

async function variableUpsert(ctx, projectId, environmentId, serviceId, name, value) {
    const q = `mutation($input: VariableUpsertInput!) { variableUpsert(input: $input) }`;
    await gql(ctx, q, { input: { projectId, environmentId, serviceId, name, value } });
}

async function serviceDomainCreate(ctx, environmentId, serviceId) {
    const q = `mutation($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) { domain }
    }`;
    const d = await gql(ctx, q, { input: { environmentId, serviceId } });
    const domain = d.serviceDomainCreate && d.serviceDomainCreate.domain;
    if (!domain) throw new Error('ساخت دامنه‌ی سرویس ناموفق بود.');
    return domain;
}

async function serviceRedeploy(ctx, serviceId, environmentId) {
    const primary = `mutation($serviceId: String!, $environmentId: String!) {
        serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId)
    }`;
    try { await gql(ctx, primary, { serviceId, environmentId }); return; }
    catch (e) {
        const fallback = `mutation($serviceId: String!, $environmentId: String!) {
            serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
        }`;
        await gql(ctx, fallback, { serviceId, environmentId });
    }
}

// ── health probe (retry: freshly-built services are briefly not live at the edge) ──

// First deploy has to pull a ~200MB image, mount the volume and start the container before
// the edge stops returning 502 — comfortably longer than the old 12×5s = 60s window, which
// expired while the container was still starting and made a perfectly good deploy look
// broken. ~5 minutes of patience costs nothing here; a false failure costs a redeploy.
async function probeHealth(domain, { attempts = 40, delayMs = 8000, onLog = () => {} } = {}) {
    const url = `https://${domain}/health`;
    for (let i = 1; i <= attempts; i++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 10000);
            let res;
            try { res = await fetch(url, { signal: controller.signal }); }
            finally { clearTimeout(timer); }
            if (res.ok) {
                const j = await res.json().catch(() => ({}));
                if (j && j.status === 'ok') return true;
            }
        } catch (e) { /* still coming up */ }
        if (i < attempts) {
            // Only speak up every few tries: 40 near-identical lines is noise, not progress.
            if (i === 1 || i % 5 === 0) {
                const waited = Math.round((i * delayMs) / 1000);
                onLog(`هنوز آماده نیست (${waited} ثانیه) — اولین اجرا نیاز به دانلود ایمیج دارد، صبر می‌کنیم…`);
            }
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    return false;
}

// ── error reporting ──────────────────────────────────────────────────────────────
// Node's fetch throws a bare `TypeError: fetch failed` and hides the real reason in
// `cause`. Surfacing that turned "fetch failed" — which tells the user nothing — into an
// actionable message.
function describeNetError(e) {
    const cause = (e && e.cause) || {};
    const code = cause.code || cause.errno || e.code || '';
    const map = {
        ENOTFOUND: 'دامنه پیدا نشد (DNS) — شاید هنوز فعال نشده',
        EAI_AGAIN: 'خطای موقت DNS',
        ECONNREFUSED: 'اتصال رد شد',
        ECONNRESET: 'اتصال قطع شد',
        ETIMEDOUT: 'اتصال تایم‌اوت شد',
        UND_ERR_CONNECT_TIMEOUT: 'اتصال تایم‌اوت شد',
        UND_ERR_HEADERS_TIMEOUT: 'سرور دیر پاسخ داد',
        UND_ERR_SOCKET: 'ارتباط قطع شد',
        CERT_HAS_EXPIRED: 'گواهی TLS منقضی شده',
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'گواهی TLS تأیید نشد',
    };
    const base = map[code] || cause.message || e.message || 'خطای شبکه';
    return code ? `${base} (${code})` : base;
}

async function fetchWithTimeout(url, opts = {}, ms = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try { return await fetch(url, { ...opts, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

/**
 * Ask Railway itself what the latest deployment is doing. This is the only way to tell
 * "the server is broken" apart from "the server is fine but its IP is unreachable from
 * here" — an outside probe cannot distinguish them, and the two need opposite fixes.
 */
async function getDeploymentStatus(gw) {
    if (!gw.railwayAccountId || !gw.railwayServiceId) return null;
    const acc = await resolveAccount(gw.railwayAccountId);
    const ctx = await resolveContext(acc.token);
    const q = `query($input: DeploymentListInput!) {
        deployments(input: $input, first: 1) {
            edges { node { id status createdAt staticUrl } }
        }
    }`;
    const d = await gql(ctx, q, {
        input: {
            projectId: gw.railwayProjectId,
            environmentId: gw.railwayEnvId,
            serviceId: gw.railwayServiceId,
        },
    });
    const edges = (d.deployments && d.deployments.edges) || [];
    return { deployment: (edges[0] && edges[0].node) || null, plan: ctx.plan || '' };
}

/**
 * Two independent checks the panel exposes per gateway:
 *   ping — is the server reachable and healthy at all (GET /health, timed)
 *   auth — does the stored admin password actually log into the panel (POST /api/login)
 * They are separate because they fail for completely different reasons, and conflating
 * them is what made "fetch failed" impossible to act on.
 */
async function testGateway(gatewayId, what = 'all') {
    const gw = store.getGateway(gatewayId);
    if (!gw) throw new Error('gateway پیدا نشد.');
    const out = { domain: gw.domain };

    if (what === 'ping' || what === 'all') {
        const t0 = Date.now();
        try {
            const res = await fetchWithTimeout(`https://${gw.domain}/health`, {}, 15000);
            out.ms = Date.now() - t0;
            out.httpStatus = res.status;
            const j = await res.json().catch(() => ({}));
            out.reachable = res.ok && j && j.status === 'ok';
            if (!out.reachable) {
                out.pingError = res.status === 502 || res.status === 503
                    ? `سرور هنوز بالا نیامده (${res.status})`
                    : `پاسخ غیرمنتظره (${res.status})`;
            }
        } catch (e) {
            out.ms = Date.now() - t0;
            out.reachable = false;
            out.pingError = describeNetError(e);
        }

        // Unreachable from here? Ask Railway whether the service is actually healthy, so
        // the user is told which of the two problems they have.
        if (!out.reachable) {
            try {
                const info = await getDeploymentStatus(gw);
                const dep = info && info.deployment;
                out.plan = (info && info.plan) || '';
                if (dep) {
                    out.deployStatus = dep.status;
                    out.verdict = /SUCCESS|RUNNING/i.test(dep.status)
                        ? (out.plan === 'FREE' ? 'limited-trial' : 'server-ok-network-blocked')
                        : 'server-not-running';
                }
            } catch (e) { out.deployStatusError = e.message; }
        }
    }

    if (what === 'auth' || what === 'all') {
        try {
            const res = await fetchWithTimeout(`https://${gw.domain}/api/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loginBody(gw)),
            }, 15000);
            if (res.ok) {
                out.authOk = true;
                // Prove the cookie is usable, not just that login returned 200.
                out.gotSession = !!sessionCookie(res);
            } else if (res.status === 401) {
                out.authOk = false;
                out.authError = 'نام کاربری یا رمز اشتباه است — مشخصات ذخیره‌شده با سرور یکی نیست';
            } else if (res.status === 429) {
                // The panel locks an IP out after repeated failures; that is not a wrong
                // password and retrying immediately makes it worse.
                out.authOk = false;
                out.authError = 'سرور ورود را موقتاً مسدود کرده — چند دقیقه صبر کنید';
            } else {
                out.authOk = false;
                out.authError = `خطای ورود (${res.status})`;
            }
        } catch (e) {
            out.authOk = false;
            out.authError = describeNetError(e);
        }
    }
    return out;
}

// ── gateway API session (login once, cache the cookie) ───────────────────────────

const sessionCache = new Map();

/**
 * The panel takes { username, password }. A gateway carried over from the previous
 * generation of this feature has no stored username — its server ignores the field
 * entirely and matches on the password alone, so sending it is harmless there and
 * required here.
 */
function loginBody(gw) {
    return { username: gw.adminUsername || store.DEFAULT_ADMIN_USERNAME, password: gw.adminPassword };
}

/**
 * Pull the session cookie out of a login response.
 *
 * Both cookie names are accepted on purpose: servers deployed by the previous generation
 * of this feature are still running and still the user's, and this is the entire cost of
 * keeping them manageable from the app. `Set-Cookie` can legitimately carry several
 * cookies, so match the named one rather than taking the header's first value.
 */
function sessionCookie(res) {
    const raw = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie().join(', ')
        : (res.headers.get('set-cookie') || '');
    const m = raw.match(/(?:vodiwalker_session|x4g_session)=[^;,\s]+/);
    return m ? m[0] : '';
}

async function loginGateway(gw) {
    const cached = sessionCache.get(gw.id);
    if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.cookie;
    let res;
    try {
        res = await fetchWithTimeout(`https://${gw.domain}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(loginBody(gw)),
        }, 15000);
    } catch (e) {
        throw new Error(`اتصال به سرور برقرار نشد: ${describeNetError(e)}`);
    }
    if (res.status === 401) throw new Error('نام کاربری یا رمز ادمین اشتباه است — با «تست رمز» بررسی کنید.');
    if (res.status === 429) throw new Error('سرور ورود را موقتاً مسدود کرده است — چند دقیقه صبر کنید.');
    if (!res.ok) throw new Error(`ورود به پنل ناموفق بود (${res.status}).`);
    const cookie = sessionCookie(res);
    if (!cookie) throw new Error('کوکی سشن از پنل دریافت نشد.');
    sessionCache.set(gw.id, { cookie, at: Date.now() });
    return cookie;
}

/**
 * The connect URI of one link row, whichever field the server put it in.
 *
 * `vless_full` is the panel's real answer and `vless` is the same string blanked out when
 * the row stands for SEVERAL configs (many clean IPs, or config_count > 1) — so `vless`
 * alone would silently hand back nothing for exactly the rows a user is most likely to
 * build. `vless_link` is what servers from the previous generation of this feature return.
 */
function linkUri(row) {
    if (!row) return '';
    return row.vless_full || row.vless || row.vless_link || '';
}

async function vodiApi(gw, method, endpoint, body = null) {
    const cookie = await loginGateway(gw);
    const doCall = (ck) => fetchWithTimeout(`https://${gw.domain}${endpoint}`, {
        method,
        headers: { Cookie: ck, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    }, 20000);
    let res;
    try {
        res = await doCall(cookie);
        if (res.status === 401) {
            sessionCache.delete(gw.id);
            res = await doCall(await loginGateway(gw));
        }
    } catch (e) {
        throw new Error(`اتصال به سرور برقرار نشد: ${describeNetError(e)}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data && data.detail) || `خطای پنل (${res.status})`);
    return data;
}

// ── the deploy flow ──────────────────────────────────────────────────────────────

/**
 * Create the panel's service, preferring the public repository.
 *
 * Railway builds a public repo without the user owning any GitHub identity, which is what
 * keeps this deploy a single automatic step. It is not guaranteed though — an account with
 * no GitHub link at all can be refused — so a rejection falls back to an image tag when one
 * is configured, and otherwise says plainly which of the two problems happened instead of
 * failing with a raw GraphQL error.
 *
 * Returns { serviceId, source } where `source` is recorded on the gateway, so a later
 * redeploy repeats whatever actually worked rather than guessing again.
 */
async function createPanelService(ctx, projectId, environmentId, svcName, emit) {
    emit(`ساخت سرویس از روی سورس پنل (${VODI_REPO})…`);
    try {
        const serviceId = await serviceCreate(ctx, projectId, environmentId, svcName,
            { repo: VODI_REPO, branch: VODI_BRANCH });
        return { serviceId, source: `repo:${VODI_REPO}@${VODI_BRANCH}` };
    } catch (e) {
        if (!VODI_IMAGE) {
            throw new Error(
                `Railway نتوانست سرویس را از سورس بسازد: ${e.message}\n` +
                'معمولاً یعنی این حساب Railway هنوز به گیت‌هاب وصل نشده. از مرحلهٔ «گیت‌هاب» ' +
                'همین پنل حساب را وصل کنید و دوباره تلاش کنید.');
        }
        emit(`ساخت از سورس ناموفق بود (${e.message}) — با ایمیج ${VODI_IMAGE} تلاش می‌کنیم…`);
        const serviceId = await serviceCreate(ctx, projectId, environmentId, svcName,
            { image: VODI_IMAGE });
        return { serviceId, source: `image:${VODI_IMAGE}` };
    }
}

async function deployGateway({ accountId, name, region, adminUsername, adminPassword, onLog = () => {} }) {
    const emit = (m) => { try { onLog(m); } catch (e) {} };
    const acc = await resolveAccount(accountId);

    emit(`بررسی توکن Railway «${acc.name}»…`);
    const ctx = await resolveContext(acc.token);
    emit(ctx.authMode === 'project'
        ? 'نوع توکن: Project — سرویس داخل پروژه‌ی همین توکن ساخته می‌شود.'
        : 'نوع توکن: Account — یک پروژه‌ی جدید ساخته می‌شود.');

    if (ctx.plan === 'FREE') {
        emit('⚠️ هشدار: این حساب Railway روی پلن Limited Trial (رایگان) است. در این پلن ' +
             'شبکه محدود است و دامنه‌ی سرور از بیرون جواب نمی‌دهد — سرور ساخته می‌شود ولی ' +
             'قابل استفاده نیست. برای رفعش حساب را وریفای کنید (اتصال GitHub یا افزودن روش پرداخت).');
    }

    const secretKey = store.generateSecret();
    const password = (adminPassword && String(adminPassword).trim()) || store.generatePassword();
    const username = (adminUsername && String(adminUsername).trim()) || store.DEFAULT_ADMIN_USERNAME;

    let projectId, environmentId;
    if (ctx.authMode === 'project') {
        projectId = ctx.projectId;
        environmentId = ctx.environmentId;
    } else {
        emit('ساخت پروژه‌ی جدید در Railway…');
        ({ projectId, environmentId } = await projectCreate(ctx, name || 'vodi-panel'));
    }

    // Unique service name so a second gateway in the same project (project-token case)
    // does not collide.
    const svcName = 'vodi-' + Math.random().toString(36).slice(2, 7);
    const { serviceId, source } = await createPanelService(
        ctx, projectId, environmentId, svcName, emit);

    // Region and start command both live on the service instance, so they go together.
    // The start command is what makes the Nixpacks build deterministic; a region that
    // Railway rejects must not take it down with it, hence the retry without region.
    const instancePatch = { startCommand: VODI_START };
    if (region) {
        emit('تعیین لوکیشن سرویس…');
        instancePatch.region = region;
    }
    try {
        await serviceInstanceUpdate(ctx, serviceId, environmentId, instancePatch);
    } catch (e) {
        emit(`تنظیم لوکیشن/دستور اجرا ناموفق بود (${e.message}) — بدون لوکیشن دوباره تلاش می‌کنیم.`);
        try { await serviceInstanceUpdate(ctx, serviceId, environmentId, { startCommand: VODI_START }); }
        catch (e2) { emit(`تعیین دستور اجرا هم نشد (${e2.message}) — Railway خودش تشخیص می‌دهد.`); }
    }

    emit('ساخت فضای ذخیره‌سازی پایدار (/data)…');
    let volumeId = '';
    try { volumeId = await volumeCreate(ctx, projectId, environmentId, serviceId, '/data') || ''; }
    catch (e) { emit(`ساخت volume ناموفق بود (${e.message}) — کاربران با ری‌استارت ممکن است پاک شوند.`); }

    emit('تنظیم متغیرهای محیطی…');
    await variableUpsert(ctx, projectId, environmentId, serviceId, 'ADMIN_USERNAME', username);
    await variableUpsert(ctx, projectId, environmentId, serviceId, 'ADMIN_PASSWORD', password);
    await variableUpsert(ctx, projectId, environmentId, serviceId, 'SECRET_KEY', secretKey);
    // The panel reads RAILWAY_VOLUME_MOUNT_PATH first (Railway injects it once a volume is
    // attached) and falls back to DATA_DIR. Setting DATA_DIR too means a deploy whose
    // volume failed above still writes somewhere predictable instead of the image's CWD.
    await variableUpsert(ctx, projectId, environmentId, serviceId, 'DATA_DIR', '/data');

    emit('ساخت دامنه‌ی عمومی…');
    const domain = await serviceDomainCreate(ctx, environmentId, serviceId);
    emit(`دامنه: ${domain}`);

    emit('اعمال تغییرات و دیپلوی…');
    try { await serviceRedeploy(ctx, serviceId, environmentId); }
    catch (e) { emit(`دیپلوی مجدد خودکار نشد (${e.message}) — معمولاً Railway خودش دیپلوی می‌کند.`); }

    const gw = store.addGateway({
        name: name || 'سرور من', region: region || '',
        adminUsername: username, adminPassword: password, secretKey,
        railwayProjectId: projectId, railwayServiceId: serviceId,
        railwayEnvId: environmentId, railwayVolumeId: volumeId,
        railwayAccountId: acc.id, railwayAuthMode: ctx.authMode,
        domain, source,
    });

    // On the FREE plan the network is restricted and the domain will NEVER answer, so a
    // full five-minute wait is pure dead time. Probe briefly (in case the plan changed
    // since we read it) and then say what is actually wrong.
    // A repo source is BUILT, not pulled: pip has to install FastAPI/uvicorn/cryptography
    // before the container even starts, which is slower than the image pull this wait was
    // originally sized for. Give a build the longer window and an image the old one.
    const shortWait = ctx.plan === 'FREE';
    const building = source.startsWith('repo:');
    emit(shortWait
        ? 'بررسی کوتاه وضعیت سرور (به‌خاطر محدودیت پلن رایگان، انتظار طولانی بی‌فایده است)…'
        : building
            ? 'در انتظار ساخته‌شدن و بالا آمدن سرور (بار اول ۳ تا ۶ دقیقه طول می‌کشد)…'
            : 'در انتظار بالا آمدن سرور (ممکن است ۱ تا ۳ دقیقه طول بکشد)…');
    const alive = await probeHealth(domain,
        shortWait ? { attempts: 3, delayMs: 5000, onLog: emit }
                  : { attempts: building ? 60 : 40, delayMs: 8000, onLog: emit });
    // A failed probe does NOT mean the deploy failed — the gateway is already saved and the
    // first container start (build + volume mount) can outlast any sane wait. Say that
    // plainly instead of implying a build problem.
    emit(alive
        ? 'سرور با موفقیت بالا آمد. ✅'
        : shortWait
            ? '❌ سرور ساخته شد ولی به‌خاطر پلن Limited Trial شبکه‌اش محدود است و در دسترس نیست. ' +
              'حساب Railway را وریفای کنید (اتصال GitHub یا افزودن روش پرداخت)، سپس «تست اتصال» را بزنید.'
            : 'دیپلوی انجام شد، ولی سرور در این مدت هنوز آماده نشد. ' +
              'سرور ذخیره شد — چند دقیقه بعد از «مدیریت کاربران» یا دکمهٔ «تست اتصال» دوباره امتحان کنید.');

    return { gateway: gw, alive };
}

async function deleteGateway(gatewayId) {
    const gw = store.getGateway(gatewayId);
    if (!gw) throw new Error('gateway پیدا نشد.');
    if (gw.railwayAccountId) {
        try {
            const acc = await resolveAccount(gw.railwayAccountId);
            const ctx = await resolveContext(acc.token);
            if (ctx.authMode === 'bearer' && gw.railwayProjectId) {
                // We created the whole project — remove it.
                await gql(ctx, `mutation($id: String!) { projectDelete(id: $id) }`,
                    { id: gw.railwayProjectId });
            } else if (gw.railwayServiceId) {
                // Project token: the project pre-existed; only remove our service.
                await gql(ctx, `mutation($id: String!) { serviceDelete(id: $id) }`,
                    { id: gw.railwayServiceId });
            }
        } catch (e) { /* already gone / token missing — still remove locally */ }
    }
    sessionCache.delete(gatewayId);
    store.removeGateway(gatewayId);
    return { deleted: true };
}

/**
 * Rebuild the service from its source and restart it — what «بروزرسانی» means here.
 *
 * With a repo source this re-clones the branch and runs the build again, so the gateway picks up
 * whatever upstream has published since. With an image source it re-resolves the tag. Either way
 * the volume, the domain and every variable (admin credentials, secrets, the user database on the
 * mounted volume) belong to the SERVICE, not to the deployment, so they survive untouched.
 *
 * The health probe afterwards is not decoration: a redeploy that builds something broken leaves a
 * gateway that answers nothing, and the user needs to hear that from the store rather than from
 * their own users.
 */
async function redeployGateway(gatewayId, { onLog = () => {} } = {}) {
    const gw = store.getGateway(gatewayId);
    if (!gw) throw new Error('سرور پیدا نشد.');
    if (!gw.railwayAccountId || !gw.railwayServiceId || !gw.railwayEnvId) {
        throw new Error('این سرور اطلاعات سرویس Railway را ندارد — باید دوباره مستقر شود.');
    }
    const acc = await resolveAccount(gw.railwayAccountId);
    const ctx = await resolveContext(acc.token);
    const source = gw.source || `repo:${VODI_REPO}@${VODI_BRANCH}`;
    onLog(`استقرار دوبارهٔ «${gw.name}» از ${source}…`);
    await serviceRedeploy(ctx, gw.railwayServiceId, gw.railwayEnvId);
    // A rebuild takes longer than an image pull, so wait proportionally rather than
    // reporting a perfectly good build as a failure.
    const building = source.startsWith('repo:');
    const live = await probeHealth(gw.domain,
        { attempts: building ? 50 : 24, delayMs: 7000, onLog });
    if (!live) {
        return { ok: false, domain: gw.domain, source,
            message: building
                ? 'استقرار شروع شد ولی سرویس تا ۶ دقیقه جواب سالم نداد — لاگ ساخت را در Railway ببینید.'
                : 'استقرار شروع شد ولی سرویس تا ۳ دقیقه جواب سالم نداد — وضعیتش را در Railway ببینید.' };
    }
    onLog('سرور دوباره بالا آمد.');
    return { ok: true, domain: gw.domain, source };
}

/**
 * The panel's own default («مدیر») config.
 *
 * The panel creates this link at STARTUP, so unlike the previous generation of this feature
 * there is no dashboard page to poke first to bring it into existence — a plain read is
 * enough. The explicit create below is still kept as a fallback for a server whose state
 * file was wiped between startup and this call.
 */
async function getAdminConfig(gatewayId) {
    const gw = store.getGateway(gatewayId);
    if (!gw) throw new Error('سرور پیدا نشد.');
    let data = await vodiApi(gw, 'GET', '/api/links');
    let links = (data && data.links) || [];
    let def = links.find(l => l.is_default) || links[0];
    if (!def) {
        def = await vodiApi(gw, 'POST', '/api/links', { label: 'مدیر' });
    }
    const link = linkUri(def);
    if (!link) throw new Error('ساخت کانفیگ مدیر ممکن نشد — چند لحظه بعد دوباره امتحان کنید.');
    return { vless_link: link, sub_url: (def && (def.sub_url || def.sub)) || '', label: def.label };
}

module.exports = {
    REGIONS, VODI_REPO, VODI_BRANCH, VODI_IMAGE, VODI_START, OAUTH_ACCOUNT_ID,
    getAccounts, resolveAccount, verifyToken, resolveContext, testGateway,
    deployGateway, deleteGateway, redeployGateway, getDeploymentStatus,
    getAdminConfig, vodiApi, linkUri,
};
