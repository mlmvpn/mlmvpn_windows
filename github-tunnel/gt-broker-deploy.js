// --- GitHub Tunnel: broker deployment onto the user's own Cloudflare account ---
// Instead of MLMVPN operating one shared Cloudflare Worker, each installation deploys its
// own copy of cloudflare-worker/gt-broker/worker.js to the SAME Cloudflare account the
// user already connected for the Cloud module — one extra button, no separate account, no
// `wrangler` CLI. The Tailscale OAuth client is sent to Cloudflare as encrypted Worker
// secrets.
//
// It is ALSO kept locally, in this module's own store, so the operator does not have to
// go and fetch it from the Tailscale console every time the Worker needs redeploying —
// which, with workers.dev liable to be blocked, is not a rare event. That means the client
// secret sits in plaintext under ~/.mlmvpn, the same place this app already keeps GitHub
// and Cloudflare tokens. It is an operator credential on the operator's own machine, and
// the convenience is worth it, but it is a real trade and should not be described as
// anything else.
//
// IMPORTANT: the Cloud module's Cloudflare accounts are NOT in cloud-manager.js's own
// store (data/cloud-accounts.json is unused by the current UI) — they live client-side in
// the renderer's PersistentStorage under the 'cf_accounts' key (see public/components/
// cloud.js) and are sent to the backend per-request, the same way /api/cloudflare/deploy*
// already work. Those saved accounts only ever hold { id, email, token, name } — no real
// Cloudflare account id — so, exactly like every other /api/cloudflare/* route in
// server.js, this module resolves the numeric Cloudflare account id itself from the token
// via GET /accounts right before deploying.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getInstallSecret } = require('./gt-secret');

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STORE_FILE = path.join(HOME_DIR, 'github-tunnel-broker-deploy.json');
const WORKER_SCRIPT_PATH = path.join(__dirname, '..', 'cloudflare-worker', 'gt-broker', 'worker.js');
// Deliberately avoids the substring "vpn" in the script/subdomain name — Cloudflare treats
// vpn-flavored Worker names/traffic as higher risk and may flag or restrict the account.
const WORKER_NAME = 'gt-relay-svc';

function load() {
    try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch (e) { return { deployed: false }; }
}

function save(s) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    return s;
}

// Bumped whenever a deployed Worker gains a capability the app then relies on. 2 = the
// Worker verifies request signatures; anything deployed before that accepts unsigned
// requests from anyone who finds the URL, so the panel has to be able to say "redeploy".
const BROKER_AUTH_VERSION = 2;

function status() {
    const s = load();
    return {
        deployed: !!s.deployed,
        // True for a relay deployed by a build that had no signature checking. It still
        // works, which is exactly why it needs saying out loud: it is wide open.
        needsRedeploy: !!s.deployed && Number(s.authVersion || 1) < BROKER_AUTH_VERSION,
        url: s.url || '',
        accountName: s.accountName || '',
        deployedAt: s.deployedAt || 0,
        customUrl: s.customUrl || '',
        effectiveUrl: getBrokerUrl(),
        // Returned so the form can be pre-filled and simply re-submitted. Localhost-only,
        // same channel the Cloudflare tokens already travel on.
        tsClientId: s.tsClientId || '',
        tsClientSecret: s.tsClientSecret || '',
        tsTailnet: s.tsTailnet || '',
    };
}

function authHeaders(token, email) {
    if (token.startsWith('cfat_') || !email) return { Authorization: `Bearer ${token}` };
    return { 'X-Auth-Email': email, 'X-Auth-Key': token };
}

async function callApi(accountId, token, email, method, endpoint, body) {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}${endpoint}`, {
        method,
        headers: { ...authHeaders(token, email), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error((data.errors && data.errors[0] && data.errors[0].message) || `Cloudflare API error (${res.status})`);
    return data;
}

/** Deploys/updates the broker worker on the caller's chosen Cloudflare account, wiring
 *  the Tailscale OAuth client in as encrypted secret_text bindings at upload time — the
 *  same mechanism cloud-manager.js's own worker deploys use. `email`/`token` come straight
 *  from the renderer's already-connected Cloud-module account (see the module header); the
 *  real Cloudflare account id is resolved here from the token, never trusted from the
 *  client. */
async function deployBroker({ email, token, accountName, tsClientId, tsClientSecret, tsTailnet, onLog }) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };

    if (!token) throw new Error('حساب کلادفلر معتبر نیست.');
    if (!tsClientId || !tsClientSecret || !tsTailnet) throw new Error('اطلاعات شبکه‌ی امن کامل نیست.');

    log('در حال بررسی حساب کلادفلر…');
    const accResRaw = await fetch('https://api.cloudflare.com/client/v4/accounts', { headers: authHeaders(token, email) });
    const accData = await accResRaw.json().catch(() => ({}));
    const cfAccountId = accData && accData.success && accData.result && accData.result[0] && accData.result[0].id;
    if (!cfAccountId) throw new Error('شناسه‌ی حساب کلادفلر پیدا نشد. توکن/ایمیل را بررسی کنید.');

    log('در حال آپلود سرویس شبکه‌ی امن…');
    let workerCode;
    try {
        workerCode = fs.readFileSync(WORKER_SCRIPT_PATH, 'utf8');
    } catch (e) {
        // Names the real fault instead of an ENOENT full of build paths. This exact file
        // going missing from the packaged app is what made the whole feature dead on
        // arrival in every installer build until cloudflare-worker/ was added to the
        // electron-builder `files` list — see package.json.
        throw new Error('فایل سرویس شبکه‌ی امن در این نسخه از برنامه پیدا نشد. لطفاً نسخه‌ی جدید برنامه را نصب کنید.');
    }

    const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2024-11-01',
        bindings: [
            { type: 'secret_text', name: 'TS_OAUTH_CLIENT_ID', text: tsClientId },
            { type: 'secret_text', name: 'TS_OAUTH_CLIENT_SECRET', text: tsClientSecret },
            { type: 'secret_text', name: 'TS_TAILNET', text: tsTailnet },
            // What binds this deployment to THIS installation. Without it the Worker sits
            // on a public hostname handing pre-authorized, exit-node-approved Tailscale
            // keys to anyone who asks — see the header of worker.js. Uploaded as a
            // secret_text binding, so it is encrypted at rest on Cloudflare exactly like
            // the OAuth client secret beside it.
            { type: 'secret_text', name: 'GT_SIGNING_SECRET', text: getInstallSecret() },
        ],
    };

    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
    form.append('worker.js', new Blob([workerCode], { type: 'application/javascript+module' }), 'worker.js');

    const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/scripts/${WORKER_NAME}`;
    const uploadRes = await fetch(uploadUrl, { method: 'PUT', headers: authHeaders(token, email), body: form });
    const uploadData = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok || !uploadData.success) {
        throw new Error((uploadData.errors && uploadData.errors[0] && uploadData.errors[0].message) || 'آپلود سرویس شبکه‌ی امن ناموفق بود.');
    }
    log('سرویس شبکه‌ی امن آپلود شد.');

    try {
        await callApi(cfAccountId, token, email, 'POST', `/workers/scripts/${WORKER_NAME}/subdomain`, { enabled: true });
    } catch (e) {
        if (e.message && e.message.includes('workers.dev')) {
            const randomSub = 'mlmvpn' + Date.now().toString(36).slice(-6);
            await callApi(cfAccountId, token, email, 'PUT', '/workers/subdomain', { subdomain: randomSub });
            await callApi(cfAccountId, token, email, 'POST', `/workers/scripts/${WORKER_NAME}/subdomain`, { enabled: true });
        } else {
            throw e;
        }
    }

    const subdomainRes = await callApi(cfAccountId, token, email, 'GET', '/workers/subdomain');
    const subdomain = subdomainRes.result && subdomainRes.result.subdomain;
    if (!subdomain) throw new Error('ساب‌دامین workers.dev حساب شما پیدا نشد.');
    const url = `https://${WORKER_NAME}.${subdomain}.workers.dev`;

    // Preserve any custom hostname: a redeploy updates the code, it is not a request to
    // fall back to the workers.dev address the operator deliberately moved off.
    const prev = load();
    save({
        ...prev,
        deployed: true, url, accountName: accountName || '', deployedAt: Date.now(),
        authVersion: BROKER_AUTH_VERSION,
        // Remembered so a later redeploy is one click, not a trip to the Tailscale console.
        tsClientId, tsClientSecret, tsTailnet,
    });
    log('سرویس شبکه‌ی امن آماده شد.');
    return { url };
}

function getBrokerUrl() {
    const s = load();
    // A custom hostname wins over the workers.dev one. That default is a well-known shared
    // domain and is exactly the kind of thing that gets blocked wholesale; a domain the
    // operator owns is the only version of this that survives that.
    if (s.customUrl) return s.customUrl.replace(/\/+$/, '');
    return s.deployed ? s.url : '';
}

/** Point the app at a broker on a domain you control, instead of the workers.dev default. */
function setCustomUrl(url) {
    const s = load();
    s.customUrl = (url || '').trim().replace(/\/+$/, '');
    save(s);
    return { customUrl: s.customUrl };
}

module.exports = { status, deployBroker, getBrokerUrl, setCustomUrl, WORKER_NAME };
