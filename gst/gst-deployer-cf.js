// --- GST Cloudflare Worker deployer ---
// Deploys public/gst/relay_worker.js to the user's own Cloudflare account, using the
// credentials they already entered in the cloud module (Global API Key + email, or an
// API token). Nothing new to fill in — that is the point.
//
// Per relay, not per app: each relay gets its own Worker with its own secret, so the
// Cloudflare switch on one relay card is genuinely independent of the others.
//
// The deployed Worker serves both roles described in relay_worker.js: the acceleration
// hop for normal traffic, and the anti-sanction path the wizard uses to reach
// script.google.com in the first place. That is why deployment happens BEFORE the user
// is asked to touch Google.

const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('./gst-config');
const log = require('./gst-log');
const { generateSafeWorkerName, generateSafeSubdomain, containsBlacklistedKeyword } =
    require('../anti-dpi');

const API = 'https://api.cloudflare.com/client/v4';

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

const ROOT = path.dirname(getUnpackedDir());
const WORKER_SOURCE = path.join(ROOT, 'public', 'gst', 'relay_worker.js');

// WHERE THE CLOUD PANEL ACTUALLY KEEPS ACCOUNTS.
// There are two parallel stores in this app and only one of them is what the user fills
// in. cloud-manager.js (backend) writes data/cloud-accounts.json, but the cloud PANEL
// writes through PersistentStorage, which server.js backs with ~/.mlmvpn/user_data.json
// under the key `cf_accounts`. Reading only the backend file made the wizard report
// "no Cloudflare account" for a user who plainly had one on screen. Both are read here,
// panel store first, so either path works.
const PANEL_STORE = path.join(os.homedir(), '.mlmvpn', 'user_data.json');
const MANAGER_STORE = path.join(ROOT, 'data', 'cloud-accounts.json');

/**
 * Header set for a credential pair.
 *
 * Cloudflare takes either a bearer token or the legacy Global API Key + email pair, and
 * the prefix is NOT a reliable signal — the key in use here starts with `cfk_`, which
 * matches neither the old hex Global Key nor the `cfat_` token prefix. So both styles
 * are produced and the caller tries them in turn rather than guessing wrong and
 * reporting an authentication failure for a perfectly good key.
 */
function authHeaderCandidates(token, email) {
    const candidates = [];
    if (email) candidates.push({ 'X-Auth-Email': email, 'X-Auth-Key': token });
    candidates.push({ Authorization: `Bearer ${token}` });
    return candidates;
}

function authHeaders(token, email, chosen) {
    return chosen || authHeaderCandidates(token, email)[0];
}

function readPanelAccounts() {
    try {
        const data = JSON.parse(fs.readFileSync(PANEL_STORE, 'utf8'));
        const raw = data.cf_accounts;
        if (!raw) return [];
        // PersistentStorage stores values as strings, but tolerate an already-parsed array.
        const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function readManagerAccounts() {
    try {
        const raw = JSON.parse(fs.readFileSync(MANAGER_STORE, 'utf8'));
        return Array.isArray(raw) ? raw : [];
    } catch (e) {
        return [];
    }
}

/**
 * Accounts the user has already added — the whole point is not asking them twice.
 *
 * `accountId` (the real Cloudflare account id) is NOT stored by the panel; it only keeps
 * {id, email, token, name}. It is therefore resolved from the API on demand — see
 * resolveAccountId — rather than required up front, which is what previously filtered
 * every account out of the list.
 */
function getAccounts() {
    const seen = new Set();
    const out = [];

    for (const a of [...readPanelAccounts(), ...readManagerAccounts()]) {
        const token = a.token || a.apiKey || '';
        if (!token || seen.has(token)) continue;
        seen.add(token);
        out.push({
            id: String(a.id || token.slice(-8)),   // local record id, used by the <select>
            cfAccountId: a.accountId || '',        // may be empty; resolved when needed
            name: a.name || a.email || String(a.id || ''),
            email: a.email || '',
            token,
        });
    }
    return out;
}

function findAccount(accountId) {
    // Accept either id so a caller holding the Cloudflare id directly still works.
    const acc = getAccounts().find(a => a.id === accountId || (a.cfAccountId && a.cfAccountId === accountId));
    if (!acc) {
        throw new Error('این حساب کلادفلر پیدا نشد — از پنل «استقرار خودکار ابری» اضافه‌اش کنید.');
    }
    return acc;
}

// Resolved account ids and the header style that worked, keyed by token. Avoids a extra
// round-trip per API call within a run.
const resolvedCache = new Map();

/**
 * Ask Cloudflare which account this credential belongs to, trying each header style.
 * Populates acc.cfAccountId and acc.authHeader in place.
 */
async function resolveAccountId(acc) {
    const cached = resolvedCache.get(acc.token);
    if (cached) {
        acc.cfAccountId = cached.cfAccountId;
        acc.authHeader = cached.authHeader;
        return acc;
    }

    let lastError = 'پاسخی از کلادفلر نیامد';
    for (const headers of authHeaderCandidates(acc.token, acc.email)) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 15000);
            let res, data;
            try {
                res = await fetch(`${API}/accounts`, { headers, signal: controller.signal });
                data = await res.json().catch(() => ({}));
            } finally {
                clearTimeout(timer);
            }

            if (res.ok && data.success && data.result && data.result.length) {
                acc.cfAccountId = data.result[0].id;
                acc.authHeader = headers;
                if (!acc.name || acc.name === acc.email) acc.name = data.result[0].name || acc.name;
                resolvedCache.set(acc.token, { cfAccountId: acc.cfAccountId, authHeader: headers });
                log.info('worker', `حساب کلادفلر شناسایی شد: ${acc.name}`);
                return acc;
            }
            if (data && data.errors && data.errors[0]) lastError = data.errors[0].message;
        } catch (e) {
            lastError = e.message;
        }
    }

    throw new Error(`اتصال به حساب کلادفلر ممکن نشد: ${lastError} — ` +
        'ایمیل و کلید را در پنل «استقرار خودکار ابری» بررسی کنید.');
}

async function callApi(acc, method, endpoint, body = null, { accountScoped = true } = {}) {
    const url = `${API}${accountScoped ? `/accounts/${acc.cfAccountId}` : ''}${endpoint}`;
    // Use the header style that resolveAccountId proved works for this credential.
    const headers = { ...authHeaders(acc.token, acc.email, acc.authHeader) };
    if (body) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
        const res = await fetch(url, {
            method, headers, signal: controller.signal,
            body: body ? JSON.stringify(body) : undefined,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            const msg = (data.errors && data.errors[0] && data.errors[0].message)
                || `خطای کلادفلر (${res.status})`;
            const err = new Error(msg);
            err.cfCode = data.errors && data.errors[0] && data.errors[0].code;
            throw err;
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Ensure the account has a workers.dev subdomain, and that it is not something a DPI
 * keyword filter would flag. A subdomain containing "vpn" or "proxy" gets the whole
 * *.workers.dev host blocked, which looks to the user like the Worker never deployed.
 */
async function ensureSubdomain(acc, onLog) {
    let current = null;
    try {
        const res = await callApi(acc, 'GET', '/workers/subdomain');
        current = res.result && res.result.subdomain;
    } catch (e) {
        // No subdomain yet — a normal state for a fresh account.
    }

    if (current && !containsBlacklistedKeyword(current)) return current;

    const wanted = generateSafeSubdomain();
    onLog(current
        ? `نام ساب‌دامین فعلی («${current}») ممکن است فیلتر شود — در حال تعویض…`
        : 'این حساب هنوز ساب‌دامین workers.dev ندارد — در حال ساخت…');

    try {
        await callApi(acc, 'PUT', '/workers/subdomain', { subdomain: wanted });
        return wanted;
    } catch (e) {
        // Losing the rename is survivable: the existing subdomain still works, it is
        // just more likely to be blocked. Failing the whole deploy here would be worse.
        onLog(`تعویض ساب‌دامین ممکن نشد (${e.message}) — با نام فعلی ادامه می‌دهیم.`);
        return current || '';
    }
}

/**
 * Upload the Worker with its secret bound as AUTH_KEY.
 *
 * The secret goes in as a secret_text binding rather than being baked into the source:
 * a binding is not readable from the Cloudflare dashboard's editor view and does not sit
 * in plain text in the script body.
 */
async function uploadWorker(acc, workerName, source, authKey) {
    const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2024-11-01',
        bindings: [{ type: 'secret_text', name: 'AUTH_KEY', text: authKey }],
    };

    const form = new FormData();
    form.append('metadata',
        new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
    form.append('worker.js',
        new Blob([source], { type: 'application/javascript+module' }), 'worker.js');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch(`${API}/accounts/${acc.cfAccountId}/workers/scripts/${workerName}`, {
            method: 'PUT',
            // No Content-Type here: FormData sets its own multipart boundary.
            headers: { ...authHeaders(acc.token, acc.email, acc.authHeader) },
            body: form,
            signal: controller.signal,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
            throw new Error((data.errors && data.errors[0] && data.errors[0].message)
                || 'آپلود کد Worker ناموفق بود.');
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

/** Turn on the *.workers.dev route, creating the account subdomain if that is what is missing. */
async function enableWorkersDev(acc, workerName, onLog) {
    try {
        await callApi(acc, 'POST', `/workers/scripts/${workerName}/subdomain`, { enabled: true });
    } catch (e) {
        if (!/workers\.dev|subdomain/i.test(e.message)) throw e;
        await ensureSubdomain(acc, onLog);
        await callApi(acc, 'POST', `/workers/scripts/${workerName}/subdomain`, { enabled: true });
    }
}

/**
 * Deploy (or redeploy) the relay Worker for one relay.
 *
 * @param relayId    relay to attach the Worker to
 * @param accountId  Cloudflare account from the cloud module
 * @param onLog      optional progress sink; every line also goes to the core log
 */
async function deployForRelay(relayId, accountId, onLog = () => {}) {
    const relay = store.getRelay(relayId);
    if (!relay) throw new Error('ریلی پیدا نشد.');

    const emit = (msg) => { log.info('worker', msg); onLog(msg); };

    const acc = findAccount(accountId);
    // The panel never stored the real Cloudflare account id, so every API path below
    // depends on this resolving first.
    await resolveAccountId(acc);
    emit(`استقرار Worker روی حساب «${acc.name}»…`);

    let source;
    try {
        source = fs.readFileSync(WORKER_SOURCE, 'utf8');
    } catch (e) {
        throw new Error(`فایل کد Worker پیدا نشد: ${WORKER_SOURCE}`);
    }

    // Reuse the existing name on redeploy so the URL already written into the user's
    // Apps Script keeps working. A new name would silently orphan that script.
    const workerName = relay.workerName || generateSafeWorkerName();
    const authKey = relay.cfAuthKey || store.generateAuthKey();

    const subdomain = await ensureSubdomain(acc, emit);

    emit('در حال آپلود کد Worker…');
    await uploadWorker(acc, workerName, source, authKey);

    emit('فعال‌سازی روی workers.dev…');
    await enableWorkersDev(acc, workerName, emit);

    // Read the subdomain back rather than trusting what we tried to set — a rename can
    // be rejected server-side, and a URL built from the wrong subdomain 404s in a way
    // that looks like the deploy itself failed.
    let finalSub = subdomain;
    try {
        const res = await callApi(acc, 'GET', '/workers/subdomain');
        if (res.result && res.result.subdomain) finalSub = res.result.subdomain;
    } catch (e) { /* fall back to what ensureSubdomain reported */ }

    if (!finalSub) {
        throw new Error('ساب‌دامین workers.dev این حساب مشخص نشد — یک بار از داشبورد کلادفلر آن را بسازید.');
    }

    const workerUrl = `https://${workerName}.${finalSub}.workers.dev`;

    store.updateRelay(relayId, {
        workerName,
        workerUrl,
        cfAuthKey: authKey,
        cfAccountId: accountId,
    });

    log.ok('worker', `Worker ریلی «${relay.name}» مستقر شد: ${workerUrl}`);
    emit('Worker با موفقیت مستقر شد.');

    // Deliberately NOT flipping cfEnabled here. The switch means "this relay's Apps
    // Script forwards through the Worker", and that only becomes true once the user
    // pastes the new WORKER_URL into the script. Turning it on now would make the panel
    // claim a route that does not exist yet.
    return { workerName, workerUrl, authKey, accountId, subdomain: finalSub };
}

/** Delete a relay's Worker from Cloudflare — so the app can clean up after itself. */
async function deleteForRelay(relayId) {
    const relay = store.getRelay(relayId);
    if (!relay) throw new Error('ریلی پیدا نشد.');
    if (!relay.workerName || !relay.cfAccountId) {
        return { deleted: false, message: 'برای این ریلی Worker ثبت نشده است.' };
    }

    const acc = findAccount(relay.cfAccountId);
    await resolveAccountId(acc);
    try {
        await callApi(acc, 'DELETE', `/workers/scripts/${relay.workerName}`);
        log.ok('worker', `Worker ریلی «${relay.name}» از کلادفلر حذف شد`);
    } catch (e) {
        // Already gone is a success from the caller's point of view.
        if (!/not found|10007|10090/i.test(`${e.message} ${e.cfCode || ''}`)) throw e;
        log.info('worker', `Worker ریلی «${relay.name}» از قبل روی کلادفلر نبود`);
    }

    store.updateRelay(relayId, { workerName: '', workerUrl: '', cfEnabled: false });
    return { deleted: true };
}

/** Does the Worker still exist on the account? Used by the health tab's repair advice. */
async function workerExists(relay) {
    if (!relay.workerName || !relay.cfAccountId) return false;
    try {
        const acc = findAccount(relay.cfAccountId);
        await resolveAccountId(acc);
        await callApi(acc, 'GET', `/workers/scripts/${relay.workerName}`);
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = { getAccounts, deployForRelay, deleteForRelay, workerExists, WORKER_SOURCE };
