// --- Settings › «منابع کلادفلر»: what this app made on the user's Cloudflare accounts ---
//
// Android's Cloudflare resources hub (CloudResourcesScreens.kt): for every connected account,
// its Workers (with the last 24 hours' requests, errors and p99 CPU), its D1 databases (tables,
// size, created) and its KV namespaces (key count) — each listable, each deletable one at a
// time, several at once, or all. The accounts themselves are the ones the Cloud panel keeps
// (cf_accounts); the page sends an account's credentials with each request, exactly as the
// Workers list always has, and nothing here stores them.
//
// Calls for one account go one after another, never in parallel: Cloudflare rate-limits per
// account, and a burst of a dozen requests is how a listing comes back 429 with no rows.

const axios = require('axios');

const API = 'https://api.cloudflare.com/client/v4';

/** The same credential rule the Workers list has always used: an API token, or email + global key. */
function headersFor(acc) {
    const token = String((acc && acc.token) || '').trim();
    const email = String((acc && acc.email) || '').trim();
    if (!token) throw new Error('توکن این حساب ذخیره نشده است.');
    const h = { 'Content-Type': 'application/json' };
    if (token.startsWith('cfat_') || token.length === 40 || !email) h.Authorization = `Bearer ${token}`;
    else { h['X-Auth-Email'] = email; h['X-Auth-Key'] = token; }
    return h;
}

function cfError(e) {
    const m = e && e.response && e.response.data && e.response.data.errors && e.response.data.errors[0];
    return (m && m.message) || (e && e.message) || 'خطای ناشناخته';
}

async function get(acc, path, timeout = 12000) {
    const r = await axios.get(API + path, { headers: headersFor(acc), timeout });
    if (r.data && r.data.success === false) throw new Error(cfError({ response: r }));
    return r.data;
}

/** The account id and its Cloudflare name. */
async function account(acc) {
    if (acc && acc._account) return acc._account;
    const d = await get(acc, '/accounts');
    const a = d.result && d.result[0];
    if (!a) throw new Error('اکانتی روی این توکن یافت نشد.');
    return { id: a.id, name: a.name || '' };
}

async function workers(acc) {
    const { id } = await account(acc);
    let subdomain = '';
    try {
        const s = await get(acc, `/accounts/${id}/workers/subdomain`, 6000);
        subdomain = (s.result && (s.result.subdomain || s.result.name)) || '';
    } catch (e) { /* no workers.dev subdomain yet */ }
    const list = (await get(acc, `/accounts/${id}/workers/scripts`)).result || [];

    // Analytics is a different API with a different scope. A token that can list scripts but not
    // read analytics still gets its list — without a stats line, rather than zeros that read as
    // idle workers.
    let stats = null;
    try {
        const end = new Date();
        const start = new Date(end.getTime() - 24 * 3600 * 1000);
        const q = {
            query: `query($accountTag: String!, $s: String!, $e: String!) { viewer { accounts(filter: {accountTag: $accountTag}) {
                workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $s, datetime_leq: $e}) {
                    sum { requests, errors } quantiles { cpuTimeP99 } dimensions { scriptName } } } } }`,
            variables: { accountTag: id, s: start.toISOString(), e: end.toISOString() },
        };
        const g = await axios.post(API + '/graphql', q, { headers: headersFor(acc), timeout: 8000 });
        const rows = g.data && g.data.data && g.data.data.viewer && g.data.data.viewer.accounts && g.data.data.viewer.accounts[0]
            && g.data.data.viewer.accounts[0].workersInvocationsAdaptive;
        if (Array.isArray(rows) && !(g.data.errors && g.data.errors.length)) {
            stats = {};
            for (const r of rows) {
                const n = r.dimensions && r.dimensions.scriptName;
                if (!n) continue;
                const cur = stats[n] || { requests: 0, errors: 0, cpu: 0 };
                cur.requests += (r.sum && r.sum.requests) || 0;
                cur.errors += (r.sum && r.sum.errors) || 0;
                cur.cpu = Math.max(cur.cpu, (r.quantiles && r.quantiles.cpuTimeP99) || 0);
                stats[n] = cur;
            }
        }
    } catch (e) { stats = null; }

    return {
        subdomain,
        statsAvailable: !!stats,
        items: list.map((w) => {
            const s = (stats && stats[w.id]) || { requests: 0, errors: 0, cpu: 0 };
            return { id: w.id, name: w.id, modifiedOn: w.modified_on || '', requests: s.requests, errors: s.errors, cpu: s.cpu };
        }),
    };
}

async function d1(acc) {
    const { id } = await account(acc);
    const list = (await get(acc, `/accounts/${id}/d1/database?per_page=100`)).result || [];
    return {
        items: list.map((db) => ({
            id: db.uuid, name: db.name, createdAt: db.created_at || '',
            sizeBytes: Number(db.file_size) || 0, tables: Number(db.num_tables) || 0,
        })),
    };
}

/**
 * Every namespace, page by page. Paged rather than one `per_page=100`: the account with more
 * than a hundred is exactly the one that hit the free plan's cap, and a cut-off list would
 * under-report the thing this screen exists to explain (Android: CloudManager.getKvNamespaces).
 */
async function kvNamespaces(acc, accountId) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
        const d = await get(acc, `/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`);
        const rows = d.result || [];
        out.push(...rows);
        const info = d.result_info || {};
        if (rows.length < 100 || (info.total_pages && page >= info.total_pages)) break;
    }
    return out;
}

/** The namespaces, names only. Key counts come per row afterwards — see kvKeys(). */
async function kv(acc) {
    const { id } = await account(acc);
    const list = await kvNamespaces(acc, id);
    return { items: list.map((ns) => ({ id: ns.id, name: ns.title, keys: null, more: false })) };
}

/**
 * How many keys one namespace holds. KV has no count endpoint, so the keys are walked a thousand
 * at a time — at most ten pages; past that the answer is "10000+" (`more`), not twenty round
 * trips for a figure nobody acts on. Fetched per row after the list is on screen, as on Android.
 */
async function kvKeys(acc, nsId) {
    const { id } = await account(acc);
    let count = 0, cursor = '', pages = 0;
    do {
        const q = `limit=1000${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`;
        const d = await get(acc, `/accounts/${id}/storage/kv/namespaces/${encodeURIComponent(nsId)}/keys?${q}`, 10000);
        count += (d.result || []).length;
        cursor = (d.result_info && d.result_info.cursor) || '';
        pages++;
    } while (cursor && pages < 10);
    return { count, more: !!cursor };
}

/** Counts for the hub: -1 where the token could not read that resource. */
async function overview(acc) {
    const a = await account(acc);
    const withAcc = Object.assign({}, acc, { _account: a });
    const count = async (fn) => { try { return (await fn(withAcc)).length; } catch (e) { return -1; } };
    return {
        account: a,
        workers: await count(async (x) => (await get(x, `/accounts/${a.id}/workers/scripts`)).result || []),
        d1: await count(async (x) => (await d1(x)).items),
        kv: await count((x) => kvNamespaces(x, a.id)),
    };
}

const DELETE_PATH = {
    workers: (acc, id) => `/accounts/${acc}/workers/scripts/${encodeURIComponent(id)}`,
    d1: (acc, id) => `/accounts/${acc}/d1/database/${encodeURIComponent(id)}`,
    kv: (acc, id) => `/accounts/${acc}/storage/kv/namespaces/${encodeURIComponent(id)}`,
};

/** Delete ids of one kind, one after another. Returns how many went and which failed, and why. */
async function remove(acc, kind, ids) {
    const path = DELETE_PATH[kind];
    if (!path) throw new Error('نوع منبع شناخته نشد.');
    const { id } = await account(acc);
    let removed = 0;
    const failed = [];
    for (const item of ids || []) {
        try {
            await axios.delete(API + path(id, item), { headers: headersFor(acc), timeout: 15000 });
            removed++;
        } catch (e) {
            failed.push({ id: item, error: cfError(e) });
        }
    }
    return { removed, failed };
}

module.exports = { overview, workers, d1, kv, kvKeys, remove, headersFor };
