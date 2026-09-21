// --- «ام‌ال‌ام استور» — the «کانفیگ ایران» sources, as an updatable item ---
//
// Every other item in this store is a BINARY with a version number. This one is not: the
// serverless configs come from @patterniha's Serverless-for-Iran, a repository with no releases
// and no tags — two `.jsonc` files that change by commit. So «is there something new» cannot be
// a version comparison; it is a digest comparison against the copy this app is using.
//
// What an update does, in order:
//   1. download `Serverless-frag{A,B}.jsonc` through the store's own route ladder,
//   2. strip the comments and PARSE them — a file that is not a full Xray config stops here,
//   3. rebuild all nineteen profiles with the app's own generator (iran-profiles-gen.js), which
//      throws when the upstream shape moves rather than quietly emitting a half-edited config,
//   4. hand three of the results to the REAL xray.exe as `-test -config` — the same rule the
//      cores obey: nothing is activated before the thing that will run it accepts it,
//   5. write them into the locked store folder and switch the active pointer, keeping the
//      previous copy for a one-click rollback.
//
// And a thing it deliberately does NOT do: claim the new files are better. Measured on an Iranian
// line, upstream's own v50 fragA opened nothing while fragB opened YouTube — «newer» is not
// «works here», so after an update the window says to run «سنجش خط» again.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const netio = require('./net');
const github = require('./github');
const cores = require('./cores');
const catalog = require('./catalog');
const corePaths = require('../core-paths');
const gen = require('../iran-profiles-gen');

const ITEM_ID = 'iran-configs';

/** The two files this app takes from upstream, and what the generator calls them. */
const UPSTREAM = {
    repo: 'patterniha/Serverless-for-Iran',
    branch: 'main',
    files: [
        { key: 'v50A', path: 'Serverless-fragA.jsonc', local: 'serverless-v50-fragA.json' },
        { key: 'v50B', path: 'Serverless-fragB.jsonc', local: 'serverless-v50-fragB.json' },
    ],
};

// The pair that does NOT come from upstream any more: v48 was published in an older release and is
// kept because a line where v50 fails may still take it. Vendored with the app, never fetched.
const LOCAL_V48 = [
    { key: 'v48low', local: 'serverless-v48-low.json' },
    { key: 'v48high', local: 'serverless-v48-high.json' },
];

const shippedDir = () => path.join(__dirname, '..', 'data', 'serverless');
const dataRoot = () => path.join(corePaths.storeRoot(), 'data', ITEM_ID);
const activeFile = () => path.join(corePaths.storeRoot(), 'data-active.json');

const sha = (text) => crypto.createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');

function readActive() {
    try {
        const j = JSON.parse(fs.readFileSync(activeFile(), 'utf8'));
        return j && typeof j === 'object' ? j : {};
    } catch (e) { return {}; }
}

async function writeActive(edit) {
    const data = readActive();
    const next = edit(data) || data;
    await fsp.mkdir(path.dirname(activeFile()), { recursive: true });
    await fsp.writeFile(activeFile(), JSON.stringify(next, null, 2));
    return next;
}

/**
 * The record of what is installed, or null when the app's own copy is what runs.
 *
 * A record whose folder has gone (a cleaned ProgramData, a restored machine) counts as absent:
 * pointing at files that are not there would make the window claim an update it cannot use.
 */
function activeRecord() {
    const rec = readActive()[ITEM_ID];
    if (!rec || !rec.dir) return null;
    try {
        if (!fs.existsSync(path.join(rec.dir, 'profiles.json'))) return null;
    } catch (e) { return null; }
    return rec;
}

/** The four source texts in use: the installed pair when there is one, else the app's own. */
function sources() {
    const rec = activeRecord();
    const out = {};
    for (const f of UPSTREAM.files) {
        const dir = rec ? path.join(rec.dir, 'sources') : shippedDir();
        out[f.key] = fs.readFileSync(path.join(dir, f.local), 'utf8');
    }
    for (const f of LOCAL_V48) out[f.key] = fs.readFileSync(path.join(shippedDir(), f.local), 'utf8');
    return out;
}

/**
 * The digests of the two upstream-tracked files as they are being used right now.
 *
 * NORMALISED first, exactly as the upstream copy is (parse → re-serialise). Hashing our file raw
 * and theirs normalised would make every difference in indentation read as «there is an update» —
 * a notice that is wrong the first time it appears is worse than no notice.
 */
function currentDigests() {
    const rec = activeRecord();
    const dir = rec ? path.join(rec.dir, 'sources') : shippedDir();
    const out = {};
    for (const f of UPSTREAM.files) {
        try { out[f.key] = sha(gen.normalizeSource(fs.readFileSync(path.join(dir, f.local), 'utf8'))); } catch (e) { out[f.key] = ''; }
    }
    return out;
}

/** The profiles the app should use, or null when the app's own generated list is the one. */
function profiles() {
    const rec = activeRecord();
    if (!rec) return null;
    try {
        const j = JSON.parse(fs.readFileSync(path.join(rec.dir, 'profiles.json'), 'utf8'));
        return Array.isArray(j) && j.length ? j : null;
    } catch (e) { return null; }
}

function state() {
    const rec = activeRecord();
    return {
        id: ITEM_ID,
        source: rec ? 'store' : 'shipped',
        version: rec ? rec.version : shippedVersion(),
        dir: rec ? rec.dir : shippedDir(),
        installedAt: rec ? rec.installedAt : '',
        digests: currentDigests(),
        count: (profiles() || []).length || null,
        canRollback: !!(rec && rec.previous),
        rollbackTo: rec && rec.previous ? rec.previous.version : (rec ? 'نسخهٔ همراه برنامه' : ''),
    };
}

/** What the app was built with — written by scripts/gen-iran-profiles.js into the sources' meta. */
function shippedVersion() {
    try {
        const m = JSON.parse(fs.readFileSync(path.join(shippedDir(), 'meta.json'), 'utf8'));
        return m.vendoredAt || 'همراه برنامه';
    } catch (e) { return 'همراه برنامه'; }
}

// ── what upstream has ────────────────────────────────────────────────────────────────────────

/** The newest commit touching one path, from GitHub's own plain atom feed (no API, no limit). */
async function lastCommit(pathInRepo, opts = {}) {
    const url = `https://github.com/${UPSTREAM.repo}/commits/${UPSTREAM.branch}/${encodeURI(pathInRepo)}.atom`;
    const r = await netio.fetchText(url, Object.assign({ timeoutMs: 25000 }, opts));
    const m = String(r.text).match(/<updated>([^<]+)<\/updated>/g) || [];
    // The first <updated> is the feed's own; the entries follow. Take the newest entry.
    const dates = m.map((x) => x.replace(/<\/?updated>/g, '')).filter(Boolean);
    return dates.length > 1 ? dates[1] : (dates[0] || '');
}

/**
 * Fetch the upstream pair and say whether it differs from what is in use.
 *
 * The digest is taken of the NORMALISED JSON, not of the raw bytes: a reformat or a changed
 * comment is not a new config, and telling the user «there is an update» for a moved brace would
 * make the notice worthless within a month.
 */
async function check(opts = {}) {
    const mine = currentDigests();
    const got = {};
    for (const f of UPSTREAM.files) {
        const url = `https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.branch}/${encodeURI(f.path)}`;
        const r = await netio.fetchText(url, Object.assign({ timeoutMs: 25000, maxBytes: 2 * 1024 * 1024 }, opts));
        const text = gen.normalizeSource(r.text);       // throws when it is not a full Xray config
        got[f.key] = { text, sha256: sha(text), bytes: r.text.length, route: r.route };
    }
    let at = '';
    try { at = await lastCommit(UPSTREAM.files[0].path, opts); } catch (e) { /* the date is decoration */ }
    const changed = UPSTREAM.files.some((f) => got[f.key].sha256 !== mine[f.key]);
    return {
        changed,
        at,
        url: `https://github.com/${UPSTREAM.repo}`,
        version: at ? String(at).slice(0, 10) : '',
        files: Object.fromEntries(UPSTREAM.files.map((f) => [f.key, { sha256: got[f.key].sha256, bytes: got[f.key].bytes }])),
        texts: got,
    };
}

// ── the watcher ──────────────────────────────────────────────────────────────────────────────
//
// Same idea as store/upstream.js for the cores, but the question is different: not «is there a
// newer tag» (there are no tags) but «do the two files differ from the ones in use». The answer is
// cached on disk so the window can show it without waiting for the network.

const WATCH_FILE = path.join(os.homedir(), '.mlmvpn', 'store', 'iran-upstream.json');
const WATCH_TTL = 6 * 60 * 60 * 1000;

let watch = readWatch();
let watching = false;

function readWatch() {
    try {
        const j = JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
        if (j && typeof j === 'object') return j;
    } catch (e) { /* never checked */ }
    return { at: 0 };
}

function saveWatch() {
    try {
        fs.mkdirSync(path.dirname(WATCH_FILE), { recursive: true });
        fs.writeFileSync(WATCH_FILE, JSON.stringify(watch, null, 2));
    } catch (e) { /* a cache that cannot be written is still a cache in memory */ }
}

/** What the last check found. `changed` is recomputed against what is in use RIGHT NOW. */
function upstream() {
    if (!watch.at) return null;
    const mine = currentDigests();
    const changed = !!(watch.files && Object.keys(watch.files).some((k) => watch.files[k].sha256 !== mine[k]));
    return {
        version: watch.version || '',
        at: watch.at,
        commitAt: watch.commitAt || '',
        url: watch.url || ('https://github.com/' + UPSTREAM.repo),
        error: watch.error || '',
        changed,
    };
}

async function refreshWatch({ force = false } = {}) {
    if (watching) return upstream();
    if (!force && Date.now() - (watch.at || 0) < WATCH_TTL) return upstream();
    watching = true;
    try {
        const r = await check();
        watch = {
            at: Date.now(), commitAt: r.at, version: r.version,
            url: r.url, files: r.files, error: '',
        };
    } catch (e) {
        // Keep the last good answer: «we could not look today» is not «there is nothing».
        watch = Object.assign({}, watch, { at: Date.now(), error: e.message || String(e) });
    } finally {
        watching = false;
        saveWatch();
    }
    return upstream();
}

/** Start a check in the background when the cache is stale. NEVER awaited by a request path. */
function maybeRefresh() {
    if (watching || Date.now() - (watch.at || 0) < WATCH_TTL) return;
    refreshWatch().catch(() => { /* the next catalogue read tries again */ });
}

// ── installing ───────────────────────────────────────────────────────────────────────────────

function fail(code, message) {
    const e = new Error(message);
    e.code = code;
    return e;
}

function runFile(exe, args, timeout = 20000) {
    return new Promise((resolve) => {
        execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
            resolve({ ok: !err, out: String(out || ''), err: String(errOut || '') });
        });
    });
}

/**
 * Hand the generated configs to the REAL xray and see whether it takes them.
 *
 * Three of the nineteen, chosen because they are the three shapes: an untouched upstream file,
 * the other untouched one, and the most heavily transformed profile (cleanDNS). If the generator
 * ever produces something xray refuses, it is one of these.
 */
async function validate(list, scratch, log) {
    const xray = cores.effectiveFile(catalog.BY_ID.xray, 'xray.exe');
    if (!xray || !fs.existsSync(xray)) {
        return { ok: false, detail: 'فایل xray.exe پیدا نشد؛ بدون آن نمی‌شود کانفیگ‌ها را آزمود.' };
    }
    const pick = [list[0], list[1], list[list.length - 1]].filter(Boolean);
    const checked = [];
    for (const p of pick) {
        const file = path.join(scratch, p.id + '.json');
        await fsp.writeFile(file, p.config);
        const r = await runFile(xray, ['-test', '-config', file]);
        if (!r.ok) {
            return { ok: false, detail: `xray کانفیگ «${p.name}» را رد کرد: ${(r.out + r.err).trim().slice(-300)}` };
        }
        checked.push(p.name);
        if (log) log('✓ ' + p.name);
    }
    return { ok: true, detail: 'xray این‌ها را قبول کرد: ' + checked.join('، ') };
}

/**
 * Download, rebuild, validate, install, activate.
 *
 * @param onPhase  'download' | 'build' | 'validate' | 'activate'
 */
async function install({ onPhase, log, signal } = {}) {
    const say = (fn, x) => { try { if (fn) fn(x); } catch (e) { } };
    const guard = await cores.protectRoot();
    if (!guard.ok) throw fail(guard.reason, guard.message);

    say(onPhase, 'download');
    const found = await check({ signal });
    if (!found.changed) throw fail('current', 'همان چیزی است که الان استفاده می‌شود — چیز تازه‌ای نیست.');
    say(log, 'دو فایل مرجع گرفته شد (' + (found.texts.v50A.route || 'مستقیم') + ').');

    say(onPhase, 'build');
    const src = {
        v50A: found.texts.v50A.text,
        v50B: found.texts.v50B.text,
        v48low: fs.readFileSync(path.join(shippedDir(), 'serverless-v48-low.json'), 'utf8'),
        v48high: fs.readFileSync(path.join(shippedDir(), 'serverless-v48-high.json'), 'utf8'),
    };
    let list;
    try { list = gen.build(src); } catch (e) {
        throw fail('build', 'ساختن کانفیگ‌ها از فایل‌های تازه نشد: ' + e.message + ' — شکل فایل‌های سازنده عوض شده و باید برنامه بروز شود.');
    }
    say(log, `${list.length} کانفیگ ساخته شد.`);

    const stamp = (found.version || new Date().toISOString().slice(0, 10)) + '-' + found.files.v50A.sha256.slice(0, 8);
    const finalDir = path.join(dataRoot(), stamp.replace(/[^0-9A-Za-z.\-]/g, '_'));
    const staging = path.join(dataRoot(), '.staging-' + Date.now());
    const scratch = path.join(os.tmpdir(), 'mlmvpn-iran-check-' + Date.now());

    try {
        await fsp.mkdir(path.join(staging, 'sources'), { recursive: true });
        await fsp.mkdir(scratch, { recursive: true });

        say(onPhase, 'validate');
        const check2 = await validate(list, scratch, log);
        if (!check2.ok) throw fail('validation', check2.detail);
        say(log, check2.detail);

        say(onPhase, 'activate');
        for (const f of UPSTREAM.files) await fsp.writeFile(path.join(staging, 'sources', f.local), found.texts[f.key].text);
        await fsp.writeFile(path.join(staging, 'profiles.json'), JSON.stringify(list));
        await fsp.writeFile(path.join(staging, 'meta.json'), JSON.stringify({
            source: UPSTREAM.repo, branch: UPSTREAM.branch, at: found.at, version: found.version,
            files: found.files, count: list.length, installedAt: new Date().toISOString(),
        }, null, 2));

        await fsp.rm(finalDir, { recursive: true, force: true });
        await fsp.rename(staging, finalDir);

        const record = {
            version: found.version || stamp,
            dir: finalDir,
            digests: Object.fromEntries(UPSTREAM.files.map((f) => [f.key, found.files[f.key].sha256])),
            count: list.length,
            installedAt: new Date().toISOString(),
            check: check2.detail,
        };
        await writeActive((data) => {
            const prev = data[ITEM_ID];
            data[ITEM_ID] = Object.assign(record, {
                previous: prev ? { version: prev.version, dir: prev.dir, installedAt: prev.installedAt } : null,
            });
            return data;
        });
        say(log, 'کانفیگ‌های تازه فعال شدند. یک‌بار «سنجش خط» را بزنید — تازه‌تر بودن یعنی تازه‌تر، نه اینکه روی خط شما بهتر کار می‌کند.');
        return { version: record.version, count: list.length, check: check2.detail };
    } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => { });
        await fsp.rm(scratch, { recursive: true, force: true }).catch(() => { });
    }
}

/** Back to the copy before the last install — or to the app's own, when there was none. */
async function rollback() {
    const rec = activeRecord();
    if (!rec) throw fail('none', 'چیزی از استور نصب نشده؛ همان کانفیگ‌های همراه برنامه در حال استفاده‌اند.');
    let to = '';
    await writeActive((data) => {
        const prev = rec.previous;
        if (prev && prev.dir && fs.existsSync(path.join(prev.dir, 'profiles.json'))) {
            data[ITEM_ID] = Object.assign({}, prev, { previous: null });
            to = prev.version;
        } else {
            delete data[ITEM_ID];
            to = 'نسخهٔ همراه برنامه';
        }
        return data;
    });
    return { to };
}

module.exports = {
    ITEM_ID, UPSTREAM, state, check, install, rollback, profiles, sources, currentDigests,
    shippedVersion, dataRoot, activeFile, upstream, refreshWatch, maybeRefresh,
};
