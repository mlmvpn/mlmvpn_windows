// --- «ام‌ال‌ام استور» — one window where every part of this app is updated, for real ---
//
// Three kinds of thing are listed, and they are genuinely different, so the store does not pretend
// otherwise:
//
//   هسته‌ها   executable engines on THIS machine (Xray, sing-box, تور, سایفون, گف, لنترن, ماسک,
//             تونل گوگل اسکریپت, تونل گیت‌هاب). Updating one means: download against a digest this
//             app trusts, prove the new binary runs and accepts the app's own config, then activate
//             it as a separate version directory — store/cores.js. The engine that is running is
//             never touched; the new version is used the next time it starts, and one click goes
//             back.
//
//   وورکرها   panels on the user's OWN Cloudflare account (BPB, Zeus, Edge, DNS اختصاصی, رلهٔ GST,
//             سرویس کلید تونل گیت‌هاب). Updating one replaces its CODE and nothing else: bindings,
//             secrets, KV, D1 and routes stay exactly as they are — store/workers.js. Workers the
//             store does not recognise are never touched, and the ones the Android app deploys are
//             shown but left to it.
//
//   برنامه    MLM VPN itself, through the updater it already had (update-manager.js).
//
// WHAT THIS FILE IS. The facade: it collects state without touching the network, starts jobs for
// anything that does, and keeps a cache so opening the window is instant. server.js lives in
// Electron's MAIN THREAD, so nothing here is synchronous beyond reading a small JSON file.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const catalog = require('./store/catalog');
const cores = require('./store/cores');
const workersMod = require('./store/workers');
const channel = require('./store/channel');
const jobs = require('./store/jobs');
const versions = require('./store/versions');
const netio = require('./store/net');
const github = require('./store/github');
const corePaths = require('./core-paths');
const upstreamWatch = require('./store/upstream');
const directUpstream = require('./store/direct');
const iranConfigs = require('./store/iran-configs');
const mitmConfig = require('./store/mitm-config');

/**
 * Every data item's own module, by id. They share the shape (state/check/install/rollback and a
 * watcher) and nothing else: one rebuilds nineteen profiles from two files, the other swaps a
 * certificate path in one. The row below is written once against that shape.
 */
const DATA_MODULES = { 'iran-configs': iranConfigs, 'mitm-config': mitmConfig };
const { SHIPPED } = require('./store/shipped');

const CACHE_FILE = path.join(os.homedir(), '.mlmvpn', 'store', 'workers-cache.json');

// ── the trusted target for an item ────────────────────────────────────────────────────────────
//
// Three places can offer a version, and the newest of them wins:
//
//   app        the pin compiled into this build — the floor, always available offline.
//   channel    the signed manifest (store/channel.js): a version we tested and vouched for.
//   upstream   the DEVELOPER's own published build, for the cores that opted into it
//              (store/direct.js). Only Aether does today, because CluvexStudio publish the very
//              archive this app ships; every other core is either built by us or waits for a test.
//
// «Newest wins» and `newer()` is strict, so when the channel and the developer are on the same
// number the channel's copy is kept: at equal versions, tested beats untested.

function targetFor(item) {
    const own = item.pin ? Object.assign({}, item.pin, { from: 'app' }) : null;
    const fromChannel = channel.pin(item.id);
    const fromUpstream = directUpstream.get(item.id);
    let best = own;
    if (fromChannel && (!best || versions.newer(fromChannel.version, best.version))) {
        best = Object.assign({}, fromChannel, { from: 'channel' });
    }
    if (fromUpstream && (!best || versions.newer(fromUpstream.version, best.version))) {
        best = fromUpstream;
    }
    return best;
}

// ── cores ────────────────────────────────────────────────────────────────────────────────────

/**
 * `unknown` is a real answer and keeps its own name. A core whose version cannot be read must never
 * be dressed up as "up to date" — that is a claim with no evidence behind it.
 */
function coreState(item, st, target) {
    if (!st.present) return 'missing';
    if (item.floor && st.version && versions.compare(st.version, item.floor) === -1) return 'update';
    if (!target) return st.version ? 'current' : 'unknown';
    const c = versions.compare(target.version, st.version);
    if (c === null) return 'unknown';
    return c === 1 ? 'update' : 'current';
}

async function coreRow(item) {
    const st = await cores.state(item);
    const target = targetFor(item);
    const job = jobs.view(jobs.get('core:' + item.id));
    // What the project itself has published lately (store/upstream.js). It is INFORMATION: the
    // store still installs only what has been tested and signed into the channel, but «the
    // developer released 2.0.0 and we are on 1.9.0» is a fact the window has to be able to say.
    const up = upstreamWatch.get(item.id);
    // …and, for a core that installs the developer's own build, whether that release has already
    // been priced into an installable target (store/direct.js). When it has, «the developer
    // released 2.1.0» and «press this to install 2.1.0» are the same sentence.
    const isDirect = !!(item.upstream && item.upstream.direct);
    return {
        id: item.id, kind: 'core', group: 'cores', title: item.title, usedBy: item.usedBy || '',
        repo: (item.upstream && (item.upstream.repo || item.upstream.url)) || '',
        builtByUs: !!(item.upstream && item.upstream.builtBy === 'mlm'),
        direct: isDirect,
        version: st.version,
        reported: st.reported,
        source: st.source,
        shipped: st.shipped,
        present: st.present,
        file: st.file,
        installedAt: st.installedAt,
        canRollback: st.canRollback,
        rollbackTo: st.previous ? st.previous.version : (st.shipped || null),
        missingKeys: st.missingKeys,
        target: target ? { version: target.version, notes: target.notes || '', released: target.released || '', from: target.from } : null,
        state: coreState(item, st, target),
        upstreamLatest: up ? { version: up.version, tag: up.tag, at: up.at, pre: !!up.pre, url: up.url, checkedAt: up.checkedAt } : null,
        // Same test for every core. For a direct one it normally answers false — the release IS
        // the target, so the update button already says it — and it goes true exactly when the
        // release could NOT be turned into something installable (CI still running, no asset for
        // Windows, a digest GitHub never computed). That gap is worth a sentence of its own, and
        // `direct` on this row is what lets the window write the right one.
        upstreamNewer: upstreamWatch.isNewer(up, st.version, target),
        upstreamError: (up && up.error) || (isDirect ? directUpstream.error(item.id) : ''),
        job,
    };
}

// ── workers ──────────────────────────────────────────────────────────────────────────────────

function readCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) { return { accounts: [], at: 0 }; }
}

async function writeCache(data) {
    try {
        await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
        await fsp.writeFile(CACHE_FILE, JSON.stringify(data, null, 2));
    } catch (e) { /* the cache is a convenience, not state */ }
}

/**
 * The Cloudflare accounts the user has already connected.
 *
 * Two stores, because there are two: the cloud PANEL writes through PersistentStorage into
 * ~/.mlmvpn/user_data.json (`cf_accounts`), while cloud-manager.js keeps data/cloud-accounts.json.
 * Reading only one of them is how a wizard once reported "no Cloudflare account" to a user who
 * plainly had one on screen (gst-deployer-cf.js hit exactly this).
 */
function cloudflareAccounts() {
    const out = [];
    const seen = new Set();
    const push = (a) => {
        const token = (a && (a.token || a.apiKey)) || '';
        if (!token || seen.has(token)) return;
        seen.add(token);
        out.push({ id: String(a.id || token.slice(-8)), name: a.name || a.email || 'حساب کلودفلر', email: a.email || '', token });
    };
    try {
        const d = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8'));
        let list = d.cf_accounts;
        if (typeof list === 'string') list = JSON.parse(list);
        (Array.isArray(list) ? list : []).forEach(push);
    } catch (e) { /* none saved by the panel */ }
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cloud-accounts.json'), 'utf8'));
        (Array.isArray(raw) ? raw : []).forEach(push);
    } catch (e) { /* none saved by the manager */ }
    return out;
}

/** The worker picture from the last survey — no network, so the window opens instantly. */
function workerRows() {
    const cache = readCache();
    const rows = [];
    for (const acc of cache.accounts || []) {
        for (const w of acc.workers || []) {
            // One shape for the window: whatever the row is, `version` is what is in use and
            // `target` is what the store would put there.
            rows.push(Object.assign({}, w, {
                kind: 'worker', group: 'workers',
                accountId: acc.id, accountName: acc.name,
                version: w.deployedVersion === null || w.deployedVersion === undefined ? null : String(w.deployedVersion),
                target: w.targetVersion === null || w.targetVersion === undefined
                    ? null : { version: String(w.targetVersion), notes: w.notes || '', released: '', from: 'app' },
                job: jobs.view(jobs.get('worker:' + acc.id + ':' + w.script)),
            }));
        }
    }
    return { rows, at: cache.at || 0, accounts: (cache.accounts || []).map((a) => ({ id: a.id, name: a.name, error: a.error || '', workers: (a.workers || []).length })) };
}

/** Survey every connected account. Network, so it runs as a job. */
function refreshWorkers() {
    return jobs.start('workers:refresh', { kind: 'workers', title: 'بررسی ورکرها' }, async (job) => {
        const accounts = cloudflareAccounts();
        if (!accounts.length) {
            await writeCache({ accounts: [], at: Date.now() });
            return { accounts: 0, workers: 0 };
        }
        const out = [];
        let total = 0;
        for (const acc of accounts) {
            jobs.phase(job, 'scan', acc.name);
            try {
                const s = await workersMod.survey(acc, {
                    onProgress: (i, n, name) => { jobs.progress(job, i, n); jobs.phase(job, 'scan', acc.name + ' — ' + name); },
                });
                out.push({ id: acc.id, name: acc.name, subdomain: s.subdomain, workers: s.workers });
                total += s.workers.length;
                jobs.log(job, acc.name + ': ' + s.workers.length + ' مورد شناسایی شد');
            } catch (e) {
                out.push({ id: acc.id, name: acc.name, workers: [], error: e.message });
                jobs.log(job, acc.name + ': ' + e.message);
            }
        }
        await writeCache({ accounts: out, at: Date.now() });
        return { accounts: out.length, workers: total };
    });
}

// ── the app itself ───────────────────────────────────────────────────────────────────────────

function appRow() {
    let st = null;
    try { st = require('./update-manager').status(); } catch (e) { st = null; }
    const latest = st && st.latest;
    return {
        id: 'mlmvpn', kind: 'app', group: 'app', title: 'MLM VPN',
        usedBy: 'خود برنامه',
        repo: (st && st.repo) || 'mlmvpn/mlmvpn_windows',
        version: (st && st.currentVersion) || null,
        installKind: st ? st.kind : '',
        target: latest && latest.newer ? { version: latest.version, notes: latest.body || '', released: latest.publishedAt || '', from: 'github' } : null,
        state: latest && latest.newer ? 'update' : (st && st.lastCheckAt ? 'current' : 'unchecked'),
        download: st ? st.download : null,
        downloaded: st ? st.downloaded : null,
        error: st ? st.error : '',
        lastCheckAt: st ? st.lastCheckAt : 0,
        job: null,
    };
}

// ── data items ───────────────────────────────────────────────────────────────────────────────
//
// Not a program: files the app ships and can take a newer copy of. «کانفیگ ایران» is the only one
// so far, and it is compared by DIGEST because its project publishes no versions (store/iran-configs.js).

function dataRow(item) {
    const mod = DATA_MODULES[item.id];
    if (!mod) return null;
    const st = mod.state();
    const up = mod.upstream();
    const job = jobs.view(jobs.get('data:' + item.id));
    const changed = !!(up && up.changed);
    return {
        id: item.id, kind: 'data', group: 'data', title: item.title, usedBy: item.usedBy || '',
        repo: (item.upstream && item.upstream.repo) || '',
        builtByUs: true,
        version: st.version,
        source: st.source,
        shipped: mod.shippedVersion(),
        present: true,
        file: st.dir || st.file,
        count: st.count || null,
        installedAt: st.installedAt,
        canRollback: st.canRollback,
        rollbackTo: st.rollbackTo,
        missingKeys: [],
        target: changed ? {
            version: up.version || 'تازه‌ترین',
            released: String(up.commitAt || '').slice(0, 10),
            notes: 'فایل‌های مرجع پروژه عوض شده‌اند. بروزرسانی همان دو فایل را می‌گیرد، همهٔ کانفیگ‌ها را از نو می‌سازد، سه‌تایشان را به خود xray می‌دهد تا قبول کند، و بعد فعال می‌کند — با امکان برگشت.',
            from: 'upstream',
        } : null,
        state: changed ? 'update' : 'current',
        // For this item «the developer changed something» IS the update, so it is the state above;
        // the block on the product page still shows when it was last looked at.
        upstreamLatest: up ? { version: up.version, at: up.commitAt, url: up.url, checkedAt: up.at, pre: false } : null,
        upstreamNewer: false,
        upstreamError: (up && up.error) || '',
        job,
    };
}

// ── the catalogue the window draws ───────────────────────────────────────────────────────────

async function catalogRows() {
    // Stale? Start reading the projects' releases in the background. NEVER awaited: this answer
    // must reach the window even on a line where github.com times out.
    upstreamWatch.maybeRefresh();
    // A release the watcher already saw still has to be priced — its asset and that asset's digest
    // — before the window can offer it. Background too, for the same reason.
    directUpstream.maybeRefresh();
    Object.values(DATA_MODULES).forEach((m) => m.maybeRefresh());
    const rows = [];
    for (const item of catalog.CORES) rows.push(await coreRow(item));
    const w = workerRows();
    rows.push(...w.rows);
    rows.push(...vodiRows());
    rows.push(...catalog.DATA.map(dataRow).filter(Boolean));
    rows.push(appRow());
    return {
        ok: true,
        rows,
        workersCheckedAt: w.at,
        accounts: w.accounts,
        channel: channel.status(),
        upstream: upstreamWatch.status(),
        storeRoot: corePaths.storeRoot(),
        checkedAt: Date.now(),
    };
}

// ── actions ──────────────────────────────────────────────────────────────────────────────────

function updateCore(id, { force = false } = {}) {
    const item = catalog.BY_ID[id];
    if (!item || item.kind !== 'core') throw new Error('هستهٔ «' + id + '» شناخته نشد.');
    let target = targetFor(item);
    if (!target && !(item.upstream && item.upstream.direct)) {
        const e = new Error('برای این هسته هنوز نسخهٔ تأییدشده‌ای منتشر نشده است. تا وقتی نسخه‌ای آزموده و امضا نشده باشد، استور چیزی نصب نمی‌کند.');
        e.code = 'no-target';
        throw e;
    }
    return jobs.start('core:' + id, { kind: 'core', title: item.title }, async (job) => {
        // The user pressed the button and is watching a progress bar, so here — and only here —
        // the developer's release may be read on the spot. It covers the cold cache and the gap
        // between «a release appeared» and the background resolve finishing.
        if (item.upstream && item.upstream.direct) {
            jobs.phase(job, 'resolve');
            const live = await directUpstream.ensure(item, { signal: job.controller.signal })
                .catch((e) => { jobs.log(job, 'خواندن انتشار سازنده نشد: ' + e.message); return null; });
            if (live && (!target || versions.newer(live.version, target.version))) target = live;
        }
        if (!target) {
            const e = new Error('انتشار تازه‌ای از سازنده خوانده نشد. اتصال را بررسی کنید و دوباره بزنید.');
            e.code = 'no-target';
            throw e;
        }
        return cores.install(item, target, {
            force,
            signal: job.controller.signal,
            onPhase: (p, d) => jobs.phase(job, p, d),
            onProgress: (done, total) => jobs.progress(job, done, total),
            onRoute: (label) => { job.route = label; },
            log: (line) => jobs.log(job, line),
        });
    });
}

function rollbackCore(id) {
    const item = catalog.BY_ID[id];
    if (!item || item.kind !== 'core') throw new Error('هستهٔ «' + id + '» شناخته نشد.');
    return jobs.start('core:' + id, { kind: 'core', title: item.title }, async (job) => {
        jobs.phase(job, 'rollback');
        const r = await cores.rollback(item);
        jobs.log(job, r.source === 'bundled'
            ? 'به نسخهٔ همراه برنامه برگشت' + (r.version ? ' (' + r.version + ')' : '')
            : 'به نسخهٔ ' + r.version + ' برگشت');
        return r;
    });
}

function updateWorker(accountId, script, expectId) {
    const acc = cloudflareAccounts().find((a) => a.id === String(accountId));
    if (!acc) throw new Error('این حساب کلودفلر دیگر در برنامه ذخیره نیست.');
    return jobs.start('worker:' + accountId + ':' + script, { kind: 'worker', title: script }, async (job) => {
        jobs.phase(job, 'read');
        const r = await workersMod.update(acc, script, { expectId });
        jobs.log(job, r.title + ': ' + r.from + ' → ' + r.to);
        // Re-survey just this account so the row is right immediately after.
        try {
            const s = await workersMod.survey(acc);
            const cache = readCache();
            const idx = (cache.accounts || []).findIndex((a) => a.id === acc.id);
            const rec = { id: acc.id, name: acc.name, subdomain: s.subdomain, workers: s.workers };
            if (idx >= 0) cache.accounts[idx] = rec; else (cache.accounts = cache.accounts || []).push(rec);
            cache.at = Date.now();
            await writeCache(cache);
        } catch (e) { /* the update itself succeeded; the picture refreshes on the next look */ }
        return r;
    });
}

/** Everything the store can update right now, in one press. Cores first, then workers. */
/** Put back the code that was live before the last update of one worker. */
function rollbackWorker(accountId, script) {
    const acc = cloudflareAccounts().find((a) => a.id === String(accountId));
    if (!acc) throw new Error('این حساب کلودفلر دیگر در برنامه ذخیره نیست.');
    return jobs.start('worker:' + accountId + ':' + script, { kind: 'worker', title: script }, async (job) => {
        jobs.phase(job, 'rollback');
        const r = await workersMod.rollback(acc, script);
        jobs.log(job, 'کد قبلی برگردانده شد' + (r.restored ? ' (' + r.restored + ')' : ''));
        try {
            const s2 = await workersMod.survey(acc);
            const cache = readCache();
            const idx = (cache.accounts || []).findIndex((a) => a.id === acc.id);
            const rec = { id: acc.id, name: acc.name, subdomain: s2.subdomain, workers: s2.workers };
            if (idx >= 0) cache.accounts[idx] = rec; else (cache.accounts = cache.accounts || []).push(rec);
            cache.at = Date.now();
            await writeCache(cache);
        } catch (e) { /* the restore itself succeeded */ }
        return r;
    });
}

/** The «کانفیگ آیپی ثابت» servers on the user's Railway account, as store rows. */
function vodiRows() {
    let gateways = [];
    let source = '';
    try {
        const mod = require('./vodi');
        gateways = mod.store.getGateways() || [];
        source = `${mod.deployer.VODI_REPO}@${mod.deployer.VODI_BRANCH}`;
    } catch (e) { return []; }
    return gateways.map((g) => ({
        id: 'vodi', kind: 'vodi', group: 'workers', gatewayId: g.id,
        title: 'railway — ' + (g.name || g.id),
        usedBy: g.domain || '', repo: (g.source || source).replace(/^repo:/, ''),
        version: null, target: null,
        // A branch has no version to read from here: a redeploy rebuilds whatever that branch
        // points at now, so the honest state is "can be redeployed", not "up to date".
        state: 'unknown',
        accountName: 'Railway', script: g.id,
        job: jobs.view(jobs.get('vodi:' + g.id)),
    }));
}

function updateAll() {
    return jobs.start('all', { kind: 'all', title: 'بروزرسانی همه' }, async (job) => {
        const done = [];
        const failed = [];
        const cat = await catalogRows();
        for (const row of cat.rows) {
            if (row.state !== 'update') continue;
            if (row.kind === 'core') {
                jobs.phase(job, 'core', row.title);
                try { updateCore(row.id); } catch (e) { failed.push({ id: row.id, title: row.title, error: e.message }); continue; }
                // One at a time on purpose: two 30 MB downloads over one filtered line finish later
                // than the same two in turn, and the progress bar stops meaning anything.
                await waitFor('core:' + row.id);
                const j = jobs.get('core:' + row.id);
                (j && j.error ? failed : done).push({ id: row.id, title: row.title, error: j && j.error ? j.error.message : '' });
            } else if (row.kind === 'worker' && row.updatable) {
                jobs.phase(job, 'worker', row.title);
                updateWorker(row.accountId, row.script, row.id);
                await waitFor('worker:' + row.accountId + ':' + row.script);
                const j = jobs.get('worker:' + row.accountId + ':' + row.script);
                (j && j.error ? failed : done).push({ id: row.id, title: row.title, error: j && j.error ? j.error.message : '' });
            }
        }
        return { done, failed };
    });
}

function waitFor(key) {
    return new Promise((resolve) => {
        const tick = () => {
            const j = jobs.get(key);
            if (!j || !j.running) return resolve();
            setTimeout(tick, 500);
        };
        tick();
    });
}

/** What the upstream project has published lately — information, never an instruction to install. */
function upstream(id) {
    const item = catalog.BY_ID[id];
    if (!item || !item.upstream) throw new Error('مورد شناخته نشد.');
    return jobs.start('upstream:' + id, { kind: 'upstream', title: item.title }, async () => {
        if (item.upstream.type !== 'github' || !item.upstream.repo) {
            return { kind: item.upstream.type, url: item.upstream.url || '', note: 'این مورد از مخزن گیت‌هاب پیگیری نمی‌شود.' };
        }
        const rels = await github.releases(item.upstream.repo);
        const tagRe = item.upstream.tagRe ? new RegExp(item.upstream.tagRe) : null;
        const rows = rels.slice(0, 8).map((r) => ({
            tag: r.tag, at: r.updated,
            version: tagRe ? ((r.tag.match(tagRe) || [])[1] || r.tag) : r.tag.replace(/^v/i, ''),
        }));
        // What the button just learned is remembered, so the badge on the item agrees with it.
        upstreamWatch.note(item.id, upstreamWatch.newestOf(item, rels));
        // For a core installed straight from the developer, «بررسی مخزن» is also the check for an
        // update: price the release now so the button that appears next is «install», not «wait».
        if (item.upstream.direct) await directUpstream.refresh({ force: true }).catch(() => {});
        return { kind: 'github', repo: item.upstream.repo, releases: rows };
    });
}

/**
 * Update a data item: download, rebuild, validate, activate. The work is in the item's own module;
 * this only gives it a job so the window can watch it like every other long operation.
 */
function updateData(id) {
    const item = catalog.BY_ID[id];
    if (!item || item.kind !== 'data') throw new Error('مورد شناخته نشد.');
    const mod = DATA_MODULES[id];
    if (!mod) throw new Error('این مورد بروزرسانی ندارد.');
    return jobs.start('data:' + id, { kind: 'data', title: item.title }, async (job) => {
        return mod.install({
            onPhase: (p) => jobs.phase(job, p),
            log: (line) => jobs.log(job, line),
            signal: job.controller.signal,
        });
    });
}

function rollbackData(id) {
    const item = catalog.BY_ID[id];
    if (!item || item.kind !== 'data') throw new Error('مورد شناخته نشد.');
    const mod = DATA_MODULES[id];
    if (!mod) throw new Error('این مورد برگشتی ندارد.');
    return jobs.start('data:' + id, { kind: 'data', title: item.title }, async (job) => {
        const r = await mod.rollback();
        jobs.log(job, 'برگشت به ' + r.to);
        return r;
    });
}

/** The «دامین فرانتینگ» config file in use: the store's copy when there is one, else the app's. */
function mitmConfigFile() {
    try { return mitmConfig.file(); } catch (e) { return ''; }
}

/** The profiles «کانفیگ ایران» should show: the installed ones, or null for the app's own. */
function iranProfiles() {
    try { return iranConfigs.profiles(); } catch (e) { return null; }
}

/** Check every tracked project at once — «بررسی انتشارهای سازنده‌ها» in the window. */
function refreshUpstreamAll() {
    return jobs.start('upstream-all', { kind: 'upstream', title: 'انتشارهای سازنده‌ها' }, async () => {
        const r = await upstreamWatch.refresh({ force: true });
        // Whatever that found, turn it into something installable where the catalogue allows it.
        await directUpstream.refresh({ force: true }).catch(() => {});
        // The data items keep their own watch (they are compared by digest, not by tag).
        for (const m of Object.values(DATA_MODULES)) await m.refreshWatch({ force: true }).catch(() => { });
        return r;
    });
}

function refreshChannel() {
    return jobs.start('channel', { kind: 'channel', title: 'کانال استور' }, async () => {
        await channel.refresh({ force: true });
        return channel.status();
    });
}

// ── app updates, through the updater that already existed ─────────────────────────────────────

const appUpdate = {
    check: () => require('./update-manager').check(),
    download: () => require('./update-manager').startDownload(),
    install: () => require('./update-manager').install(),
};

module.exports = {
    catalogRows, coreRow, workerRows, refreshWorkers, cloudflareAccounts,
    updateCore, rollbackCore, updateWorker, rollbackWorker, updateAll, upstream, refreshChannel, refreshUpstreamAll, updateData, rollbackData, iranProfiles, mitmConfigFile,
    appUpdate, targetFor,
    jobs, channel, cores, workers: workersMod, catalog, versions,
};
