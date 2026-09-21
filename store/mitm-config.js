// --- «ام‌ال‌ام استور» — the «دامین فرانتینگ» config, as an updatable item ---
//
// Same shape as store/iran-configs.js and for the same reason: @patterniha's MITM-DomainFronting
// publishes no releases — one `Xray-config/MITM-DomainFronting.json` that changes by commit — so
// «is there something new» is a digest comparison, not a version comparison.
//
// ONE transform, and it is the whole difference between their file and ours. Upstream's config
// names its certificate `mycert.crt` / `mycert.key` beside the executable, because their setup is
// a .bat that mints one there. This app mints a certificate PER MACHINE into ~/.mlmvpn/mitm and
// writes its real path in at start-up, so the stored copy carries placeholders instead. The
// transform swaps those two names for the placeholders — and checks that it found exactly the two
// it expected, so a moved upstream file cannot leave a real path behind and have this app quietly
// terminate TLS with a certificate nobody trusts.
//
// Before anything is activated: the file must parse, it must still be SERVERLESS (no outbound may
// point at anyone's machine — the property that makes an unsigned source safe to run), and xray
// itself must accept it, tested with a real certificate.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const netio = require('./net');
const cores = require('./cores');
const catalog = require('./catalog');
const corePaths = require('../core-paths');
const guard = require('../iran-profiles-gen');       // normalizeSource + assertServerless live there

const ITEM_ID = 'mitm-config';

const UPSTREAM = {
    repo: 'patterniha/MITM-DomainFronting',
    branch: 'main',
    file: 'Xray-config/MITM-DomainFronting.json',
};

// What the app's own copy is called, and the two names upstream uses for its certificate.
const LOCAL_NAME = 'mitm_domainfronting_v23.json';
const CERT_PLACEHOLDER = '__MLM_CERT_PATH__';
const KEY_PLACEHOLDER = '__MLM_KEY_PATH__';
const UPSTREAM_CERT = 'mycert.crt';
const UPSTREAM_KEY = 'mycert.key';

const WATCH_FILE = path.join(os.homedir(), '.mlmvpn', 'store', 'mitm-upstream.json');
const WATCH_TTL = 6 * 60 * 60 * 1000;

const unpackedDir = () => (__dirname.toLowerCase().includes('.asar')
    ? path.join(__dirname, '..').replace(/\.asar/gi, '.asar.unpacked')
    : path.join(__dirname, '..'));
const shippedFile = () => path.join(unpackedDir(), 'core', 'mitm', LOCAL_NAME);
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

function activeRecord() {
    const rec = readActive()[ITEM_ID];
    if (!rec || !rec.dir) return null;
    try { if (!fs.existsSync(path.join(rec.dir, LOCAL_NAME))) return null; } catch (e) { return null; }
    return rec;
}

/** The config file the app should run: the installed one, or the one it shipped with. */
function file() {
    const rec = activeRecord();
    return rec ? path.join(rec.dir, LOCAL_NAME) : shippedFile();
}

function currentDigest() {
    try { return sha(guard.normalizeSource(fs.readFileSync(file(), 'utf8'))); } catch (e) { return ''; }
}

function state() {
    const rec = activeRecord();
    return {
        id: ITEM_ID,
        source: rec ? 'store' : 'shipped',
        version: rec ? rec.version : shippedVersion(),
        file: file(),
        installedAt: rec ? rec.installedAt : '',
        digest: currentDigest(),
        canRollback: !!(rec && rec.previous),
        rollbackTo: rec && rec.previous ? rec.previous.version : (rec ? 'نسخهٔ همراه برنامه' : ''),
    };
}

/** The config's own `remarks` is its version — upstream writes `MITM-DomainFronting_v23` there. */
function shippedVersion() {
    try {
        const j = JSON.parse(guard.normalizeSource(fs.readFileSync(shippedFile(), 'utf8')));
        const m = String(j.remarks || '').match(/v\d+/i);
        return m ? m[0] : (j.remarks || 'همراه برنامه');
    } catch (e) { return 'همراه برنامه'; }
}

/**
 * Their certificate names → this app's placeholders.
 *
 * Counted, not hoped for: two of each, because the config has two TLS inbounds. A file that has
 * moved on and no longer carries them would otherwise install with a path pointing at a file that
 * does not exist on this machine, and the browser would meet a certificate nobody trusts.
 */
function withOurCertPaths(text) {
    const obj = JSON.parse(text);
    let certs = 0;
    let keys = 0;
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        for (const k of Object.keys(node)) {
            const v = node[k];
            if (k === 'certificateFile' && typeof v === 'string') { node[k] = CERT_PLACEHOLDER; certs++; }
            else if (k === 'keyFile' && typeof v === 'string') { node[k] = KEY_PLACEHOLDER; keys++; }
            else walk(v);
        }
    };
    walk(obj);
    if (certs !== 2 || keys !== 2) {
        throw new Error(`انتظار دو گواهی و دو کلید در کانفیگ بود، ${certs} و ${keys} پیدا شد — شکل فایل سازنده عوض شده و باید برنامه بروز شود.`);
    }
    return JSON.stringify(obj, null, 2);
}

// ── what upstream has ────────────────────────────────────────────────────────────────────────

async function lastCommit(opts = {}) {
    const url = `https://github.com/${UPSTREAM.repo}/commits/${UPSTREAM.branch}/${encodeURI(UPSTREAM.file)}.atom`;
    const r = await netio.fetchText(url, Object.assign({ timeoutMs: 25000 }, opts));
    const all = String(r.text).match(/<updated>([^<]+)<\/updated>/g) || [];
    const dates = all.map((x) => x.replace(/<\/?updated>/g, '')).filter(Boolean);
    return dates.length > 1 ? dates[1] : (dates[0] || '');
}

async function check(opts = {}) {
    const url = `https://raw.githubusercontent.com/${UPSTREAM.repo}/${UPSTREAM.branch}/${encodeURI(UPSTREAM.file)}`;
    const r = await netio.fetchText(url, Object.assign({ timeoutMs: 25000, maxBytes: 2 * 1024 * 1024 }, opts));
    const normalised = guard.normalizeSource(r.text);
    guard.assertServerless(normalised, 'دامین فرانتینگ');
    const ours = withOurCertPaths(normalised);        // compare like for like: their file, our paths
    let at = '';
    try { at = await lastCommit(opts); } catch (e) { /* the date is decoration */ }
    const obj = JSON.parse(ours);
    const m = String(obj.remarks || '').match(/v\d+/i);
    return {
        changed: sha(ours) !== currentDigest(),
        at,
        version: m ? m[0] : (at ? String(at).slice(0, 10) : ''),
        url: `https://github.com/${UPSTREAM.repo}`,
        sha256: sha(ours),
        route: r.route,
        text: ours,
    };
}

// ── the watcher ──────────────────────────────────────────────────────────────────────────────

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
    } catch (e) { /* in memory is still a cache */ }
}

function upstream() {
    if (!watch.at) return null;
    return {
        version: watch.version || '',
        at: watch.at,
        commitAt: watch.commitAt || '',
        url: watch.url || ('https://github.com/' + UPSTREAM.repo),
        error: watch.error || '',
        changed: !!(watch.sha256 && watch.sha256 !== currentDigest()),
    };
}

async function refreshWatch({ force = false } = {}) {
    if (watching) return upstream();
    if (!force && Date.now() - (watch.at || 0) < WATCH_TTL) return upstream();
    watching = true;
    try {
        const r = await check();
        watch = { at: Date.now(), commitAt: r.at, version: r.version, url: r.url, sha256: r.sha256, error: '' };
    } catch (e) {
        watch = Object.assign({}, watch, { at: Date.now(), error: e.message || String(e) });
    } finally {
        watching = false;
        saveWatch();
    }
    return upstream();
}

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

function runFile(exe, args, timeout = 25000) {
    return new Promise((resolve) => {
        execFile(exe, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) => {
            resolve({ ok: !err, out: String(out || ''), err: String(errOut || '') });
        });
    });
}

/**
 * Give xray the config it will actually run.
 *
 * The placeholders are swapped for a real certificate first — this machine's own when it has one,
 * otherwise a throwaway pair minted for the test and thrown away with the scratch folder. Testing
 * the file with the placeholders still in it would only prove that xray can read a path that does
 * not exist.
 */
async function validate(text, scratch, log) {
    const xray = cores.effectiveFile(catalog.BY_ID.xray, 'xray.exe');
    if (!xray || !fs.existsSync(xray)) return { ok: false, detail: 'فایل xray.exe پیدا نشد؛ بدون آن نمی‌شود کانفیگ را آزمود.' };

    const mine = path.join(os.homedir(), '.mlmvpn', 'mitm', 'mlmvpn_mitm');
    let cert = mine + '.crt';
    let key = mine + '.key';
    if (!fs.existsSync(cert) || !fs.existsSync(key)) {
        const base = path.join(scratch, 'probe');
        const made = await runFile(xray, ['tls', 'cert', '-ca', '-name=MLM VPN Config Test', '-expire=1h', '-file=' + base]);
        cert = base + '.crt';
        key = base + '.key';
        if (!fs.existsSync(cert) || !fs.existsSync(key)) {
            return { ok: false, detail: 'برای آزمایش، گواهی موقت ساخته نشد' + (made.out ? ': ' + made.out.trim().slice(-160) : '.') };
        }
        if (log) log('گواهی موقت برای آزمایش ساخته شد.');
    }

    const runnable = text.split(CERT_PLACEHOLDER).join(cert.replace(/\\/g, '\\\\')).split(KEY_PLACEHOLDER).join(key.replace(/\\/g, '\\\\'));
    const cfgFile = path.join(scratch, 'test-config.json');
    await fsp.writeFile(cfgFile, runnable);
    const r = await runFile(xray, ['-test', '-config', cfgFile]);
    if (!r.ok) return { ok: false, detail: 'xray این کانفیگ را رد کرد: ' + (r.out + r.err).trim().slice(-300) };
    return { ok: true, detail: 'xray کانفیگ تازه را قبول کرد.' };
}

async function install({ onPhase, log, signal } = {}) {
    const say = (fn, x) => { try { if (fn) fn(x); } catch (e) { } };
    const g = await cores.protectRoot();
    if (!g.ok) throw fail(g.reason, g.message);

    say(onPhase, 'download');
    const found = await check({ signal });
    if (!found.changed) throw fail('current', 'همان چیزی است که الان استفاده می‌شود — چیز تازه‌ای نیست.');
    say(log, 'کانفیگ مرجع گرفته شد (' + (found.route || 'مستقیم') + ').');

    say(onPhase, 'build');
    say(log, 'مسیر گواهی این کامپیوتر جای مسیر نمونهٔ پروژه نشست.');

    const stamp = ((found.version || '') + '-' + found.sha256.slice(0, 8)).replace(/^-/, '');
    const finalDir = path.join(dataRoot(), stamp.replace(/[^0-9A-Za-z.\-]/g, '_'));
    const staging = path.join(dataRoot(), '.staging-' + Date.now());
    const scratch = path.join(os.tmpdir(), 'mlmvpn-mitm-check-' + Date.now());

    try {
        await fsp.mkdir(staging, { recursive: true });
        await fsp.mkdir(scratch, { recursive: true });

        say(onPhase, 'validate');
        const v = await validate(found.text, scratch, log);
        if (!v.ok) throw fail('validation', v.detail);
        say(log, v.detail);

        say(onPhase, 'activate');
        await fsp.writeFile(path.join(staging, LOCAL_NAME), found.text);
        await fsp.writeFile(path.join(staging, 'meta.json'), JSON.stringify({
            source: UPSTREAM.repo, branch: UPSTREAM.branch, file: UPSTREAM.file,
            at: found.at, version: found.version, sha256: found.sha256,
            installedAt: new Date().toISOString(),
        }, null, 2));

        await fsp.rm(finalDir, { recursive: true, force: true });
        await fsp.rename(staging, finalDir);

        const record = {
            version: found.version || stamp,
            dir: finalDir,
            sha256: found.sha256,
            installedAt: new Date().toISOString(),
            check: v.detail,
        };
        await writeActive((data) => {
            const prev = data[ITEM_ID];
            data[ITEM_ID] = Object.assign(record, {
                previous: prev ? { version: prev.version, dir: prev.dir, installedAt: prev.installedAt } : null,
            });
            return data;
        });
        say(log, 'کانفیگ تازه فعال شد؛ از اتصال بعدی استفاده می‌شود.');
        return { version: record.version, check: v.detail };
    } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => { });
        await fsp.rm(scratch, { recursive: true, force: true }).catch(() => { });
    }
}

async function rollback() {
    const rec = activeRecord();
    if (!rec) throw fail('none', 'چیزی از استور نصب نشده؛ همان کانفیگ همراه برنامه در حال استفاده است.');
    let to = '';
    await writeActive((data) => {
        const prev = rec.previous;
        if (prev && prev.dir && fs.existsSync(path.join(prev.dir, LOCAL_NAME))) {
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
    ITEM_ID, UPSTREAM, state, check, install, rollback, file, currentDigest, shippedVersion,
    withOurCertPaths, upstream, refreshWatch, maybeRefresh, dataRoot,
};
