// --- «ام‌ال‌ام استور» — installing an engine core without ever breaking the one that works ---
//
// The order below is the whole design, and each step exists because skipping it has a concrete way
// of hurting someone:
//
//   1. PROTECT the store folder (only SYSTEM and Administrators may write). The app runs elevated;
//      a folder an ordinary user can write to would let any program on the machine plant a DLL next
//      to an engine and have it loaded with administrator rights.
//   2. DOWNLOAD against a digest this app already trusts (store/trust.js). No digest, no download.
//   3. EXTRACT into a staging directory, take only the named files, never the archive's layout.
//   4. PROVE IT RUNS: ask the new binary its version, and where the app has a real config for that
//      engine, run the new core against it next to the current core. A candidate is refused only
//      when the CURRENT core accepts the config and the new one does not — so a config that was
//      already broken cannot be blamed on the update.
//   5. ACTIVATE by writing one small JSON file. The running engine keeps running from where it
//      started; its next start uses the new directory. Nothing is overwritten, so nothing is locked.
//   6. KEEP the previous version for a one-click rollback; collect the rest.

'use strict';

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

const corePaths = require('../core-paths');
const { SHIPPED } = require('./shipped');
const versions = require('./versions');
const trust = require('./trust');
const netio = require('./net');

const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const MSIEXEC = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msiexec.exe');
const ICACLS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');

function run(cmd, args, { timeout = 120000, cwd, env } = {}) {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout, cwd, env, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out, errOut) => {
            resolve({
                code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
                out: String(out || ''), err: String(errOut || ''),
                timedOut: !!(err && err.killed),
            });
        });
    });
}

const say = (fn, msg) => { try { if (fn) fn(msg); } catch (e) { /* the listener went away */ } };

// ── layout ────────────────────────────────────────────────────────────────────

const root = () => corePaths.storeRoot();
const downloadsDir = () => path.join(root(), 'downloads');
const itemDir = (id) => path.join(root(), 'cores', id);

function unpacked(p) { return p.replace(/app\.asar(?![.\w])/i, 'app.asar.unpacked'); }

/** The app's own core/ directory, wherever this build keeps it. */
function bundledCoreDir() {
    return path.join(unpacked(path.dirname(__dirname)), 'core');
}

function bundledItemDir(item) {
    return path.join(bundledCoreDir(), item.bundledDir || '');
}

/** Where a core's running copy lives when the store is not providing it. */
function baselineFile(item, rel) {
    if (item.id === 'tailscale') {
        // The GitHub tunnel copies its bundled binaries into the user profile on first connect.
        const gt = path.join(os.homedir(), '.mlmvpn', 'gt-core', rel);
        if (fs.existsSync(gt)) return gt;
    }
    return path.join(bundledItemDir(item), rel);
}

/** The file of `item` that the NEXT start of that engine will run. */
function effectiveFile(item, rel) {
    return corePaths.file(item.id, rel, baselineFile(item, rel));
}

// ── protection ────────────────────────────────────────────────────────────────

let protectedOnce = null;

/**
 * Is this SDDL a folder only SYSTEM and Administrators can write to?
 *
 * Read as SDDL rather than icacls' text because icacls prints group names in the Windows display
 * language — "BUILTIN\Users" is not what a Persian Windows says.
 */
function sddlIsLocked(sddl) {
    const dacl = (String(sddl).match(/D:([^()]*)((?:\([^)]*\))*)/) || []);
    if (!dacl.length) return false;
    if (dacl[1].indexOf('P') < 0) return false;   // inheritance must be cut
    const writers = new Set(['SY', 'BA', 'S-1-5-18', 'S-1-5-32-544']);
    const readOnly = new Set(['FR', 'GR', 'GX', 'GRGX', '0x1200a9', '0x120089', '0x1200a0']);
    const aces = dacl[2].match(/\(([^)]*)\)/g) || [];
    for (const raw of aces) {
        const f = raw.slice(1, -1).split(';');
        const type = f[0], rights = f[2], sid = f[5];
        if (type !== 'A') continue;                 // deny entries only ever take rights away
        if (writers.has(sid)) continue;
        if (!readOnly.has(rights)) return false;
    }
    return aces.length > 0;
}

async function isElevated() {
    if (process.platform !== 'win32') return false;
    const r = await run('whoami', ['/groups'], { timeout: 15000 });
    return /S-1-16-12288/.test(r.out);
}

/**
 * Create the store folder and lock it. Idempotent; verified by reading the ACL back.
 * A test or dev run points MLMVPN_STORE_ROOT at a scratch folder and skips the lock.
 */
async function protectRoot() {
    if (process.env.MLMVPN_STORE_ROOT) {
        fs.mkdirSync(root(), { recursive: true });
        return { ok: true, skipped: true };
    }
    if (protectedOnce) return protectedOnce;
    const dir = root();
    const attempt = (async () => {
        if (!(await isElevated())) {
            return { ok: false, reason: 'not-elevated', message: 'برنامه با دسترسی مدیر اجرا نشده؛ استور بدون آن هیچ هسته‌ای نصب نمی‌کند.' };
        }
        fs.mkdirSync(dir, { recursive: true });
        const grant = await run(ICACLS, [dir, '/inheritance:r',
            '/grant:r', '*S-1-5-18:(OI)(CI)F',
            '/grant:r', '*S-1-5-32-544:(OI)(CI)F',
            '/grant:r', '*S-1-5-32-545:(OI)(CI)RX',
            '/grant:r', '*S-1-5-11:(OI)(CI)RX'], { timeout: 30000 });
        await run(ICACLS, [dir, '/setowner', '*S-1-5-32-544'], { timeout: 30000 });
        const read = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            '(Get-Acl -LiteralPath ' + JSON.stringify(dir) + ').Sddl'], { timeout: 30000 });
        if (grant.code !== 0 || !sddlIsLocked(read.out.trim())) {
            return { ok: false, reason: 'acl', message: 'پوشهٔ استور قفل نشد (' + (grant.err || grant.out || 'icacls').trim().slice(0, 120) + ') — بدون آن نصب انجام نمی‌شود.' };
        }
        return { ok: true };
    })();
    protectedOnce = attempt;
    const res = await attempt;
    if (!res.ok) protectedOnce = null;   // let a later attempt try again
    return res;
}

// ── active.json ───────────────────────────────────────────────────────────────

let writeChain = Promise.resolve();

function readActive() {
    try { return JSON.parse(fs.readFileSync(corePaths.activeFile(), 'utf8')) || {}; } catch (e) { return {}; }
}

/** Serialised, atomic edit of active.json. */
function editActive(mutate) {
    const next = writeChain.then(async () => {
        const data = readActive();
        const out = mutate(data) || data;
        const file = corePaths.activeFile();
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.' + process.pid + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify(out, null, 2));
        await fsp.rename(tmp, file);
        return out;
    });
    writeChain = next.catch(() => {});
    return next;
}

// ── probing ───────────────────────────────────────────────────────────────────

const probeCache = new Map();

/** Run `probe` against `exe` and return the captured version (or null). Cached on size+mtime. */
async function probeFile(exe, probe) {
    if (!probe) return null;
    let st;
    try { st = fs.statSync(exe); } catch (e) { return null; }
    const key = exe + '|' + st.size + '|' + st.mtimeMs + '|' + probe.args.join(' ');
    if (probeCache.has(key)) return probeCache.get(key);
    const r = await run(exe, probe.args, { timeout: 15000, cwd: path.dirname(exe) });
    const m = (r.out + '\n' + r.err).match(probe.re);
    const v = m ? m[1] : null;
    probeCache.set(key, v);
    return v;
}

/** Which capability strings a binary contains — read off the file, not guessed from a version. */
async function binaryHasKeys(file, keys) {
    if (!keys || !keys.length) return null;
    let buf;
    try { buf = await fsp.readFile(file); } catch (e) { return null; }
    const text = buf.toString('latin1');
    const out = {};
    for (const k of keys) out[k] = text.indexOf(k) >= 0;
    return out;
}

/**
 * What is in use for `item` right now, without touching the network.
 *   { source: 'store'|'bundled', version, reported, dir, installedAt, previous, shipped, keys }
 */
async function state(item) {
    const shipped = SHIPPED[item.id] || null;
    const act = corePaths.activeInstall(item.id);
    const mainRel = item.probe ? item.probe.file : item.files[0];
    const file = effectiveFile(item, mainRel);
    const present = fs.existsSync(file);
    const reported = present && item.probe ? await probeFile(file, item.probe) : null;
    const keys = present && item.keys ? await binaryHasKeys(file, item.keys) : null;
    const rec = readActive()[item.id];
    return {
        source: act ? 'store' : 'bundled',
        version: act ? act.version : (shipped ? shipped.version : null),
        reported,
        present,
        file,
        installedAt: act ? act.installedAt : null,
        previous: rec && rec.previous ? { version: rec.previous.version } : null,
        canRollback: !!act,
        shipped: shipped ? shipped.version : null,
        keys,
        missingKeys: keys ? Object.keys(keys).filter((k) => !keys[k]) : [],
    };
}

// ── extraction ────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out); else out.push(p);
    }
    return out;
}

/** Find `want` inside an extracted tree: an exact relative suffix when it has a slash, else a basename. */
function locate(files, base, want) {
    const norm = want.replace(/\\/g, '/').toLowerCase();
    const rel = (p) => path.relative(base, p).replace(/\\/g, '/').toLowerCase();
    const hits = files.filter((p) => norm.includes('/')
        ? rel(p) === norm || rel(p).endsWith('/' + norm)
        : path.basename(p).toLowerCase() === norm);
    hits.sort((a, b) => rel(a).length - rel(b).length);
    return hits[0] || null;
}

// What msiexec's exit codes mean, in the words a user can act on. It writes NOTHING to
// stdout or stderr — ever — so without this table a failure surfaced as an empty message.
const MSI_CODES = {
    1602: 'کاربر عملیات را لغو کرد',
    1603: 'خطای جدی هنگام باز کردن بسته',
    1605: 'این بسته نصب نیست',
    1619: 'بستهٔ نصب باز نشد — فایل خراب یا ناقص است',
    1620: 'بستهٔ نصب خوانده نشد — فایل معتبر نیست',
    1622: 'نوشتن فایل لاگ ممکن نشد',
    1623: 'زبان این بسته پشتیبانی نمی‌شود',
    1625: 'سیاست سیستم اجازهٔ این کار را نمی‌دهد',
    1638: 'نسخهٔ دیگری از این بسته از قبل نصب است',
    1639: 'آرگومان نامعتبر به msiexec داده شد',
};

/**
 * Administrative MSI extraction (files only — no service, no driver, nothing registered).
 *
 * THE COMMAND LINE IS BUILT BY HAND, and that is the whole point of this function.
 * msiexec parses a property as `NAME="value"`; Node's ordinary argv escaping turns
 * `TARGETDIR=C:\ProgramData\MLM VPN\...` into `"TARGETDIR=C:\ProgramData\MLM VPN\..."`
 * because of the space in the path, and msiexec rejects that form — silently, with no
 * output at all. Measured: the escaped form extracted 0 files and printed nothing, while
 * the verbatim form below extracted all of them.
 *
 * A trailing backslash would escape the closing quote, so it is trimmed.
 */
function runMsiAdmin(msi, dir, { timeout = 300000 } = {}) {
    const clean = (p) => String(p).replace(/\\+$/, '');
    const log = path.join(path.dirname(clean(dir)), 'msi-' + crypto.randomBytes(3).toString('hex') + '.log');
    const line = `/a "${clean(msi)}" /qn TARGETDIR="${clean(dir)}" /L*v "${log}"`;
    return new Promise((resolve) => {
        let done = false;
        const finish = async (code, extra) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            // 3010 is "worked, wants a reboot" — nothing here installs, so it is a success.
            if (code === 3010) code = 0;
            let detail = extra || MSI_CODES[code] || '';
            if (code !== 0 && !extra) {
                // The verbose log is the only place msiexec says anything. Its last error
                // line is far more useful than a bare number.
                try {
                    const text = await fsp.readFile(log, 'utf16le').catch(() => fsp.readFile(log, 'utf8'));
                    const hit = String(text).split(/\r?\n/).reverse()
                        .find((l) => /Error|error code|returning|failed/i.test(l) && l.trim().length > 12);
                    if (hit) detail = (detail ? detail + ' — ' : '') + hit.trim().slice(0, 180);
                } catch (e) { /* no log is not worse than no message */ }
                if (!detail) detail = `msiexec با کد ${code} بیرون آمد`;
            }
            try { await fsp.rm(log, { force: true }); } catch (e) { /* best effort */ }
            resolve({ code, out: '', err: '', detail });
        };
        const child = spawn(MSIEXEC, [line], {
            windowsVerbatimArguments: true, windowsHide: true, stdio: 'ignore',
        });
        const timer = setTimeout(() => {
            try { child.kill(); } catch (e) {}
            finish(-1, 'باز کردن بسته بیش از حد طول کشید');
        }, timeout);
        child.on('error', (e) => finish(-1, e.message));
        child.on('close', (code) => finish(typeof code === 'number' ? code : -1));
    });
}

async function extractArtifact(artifact, file, staging, scratch) {
    const fmt = artifact.format || 'raw';
    if (fmt === 'raw') {
        const dest = path.join(staging, artifact.dest || artifact.name);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(file, dest);
        return;
    }
    await fsp.rm(scratch, { recursive: true, force: true });
    await fsp.mkdir(scratch, { recursive: true });
    let r;
    if (fmt === 'zip' || fmt === 'tar.gz' || fmt === 'tgz') {
        r = await run(TAR, ['-xf', file, '-C', scratch], { timeout: 300000 });
    } else if (fmt === 'msi') {
        // Administrative extraction: files only. No service, no driver, nothing registered.
        r = await runMsiAdmin(file, scratch);
    } else {
        throw new Error('قالب بسته شناخته نشد: ' + fmt);
    }
    if (r.code !== 0) {
        const said = (r.detail || r.err || r.out || '').trim().slice(0, 300);
        throw new Error('باز کردن بسته نشد' + (said ? ': ' + said : ` (کد ${r.code})`));
    }
    const files = walk(scratch);
    for (const [want, destRel] of Object.entries(artifact.extract || {})) {
        const src = locate(files, scratch, want);
        if (!src) throw new Error('«' + want + '» داخل بستهٔ ' + artifact.name + ' نبود.');
        const dest = path.join(staging, destRel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(src, dest);
    }
    await fsp.rm(scratch, { recursive: true, force: true });
}

// ── validation ────────────────────────────────────────────────────────────────

function freePort() {
    return new Promise((resolve) => {
        const srv = require('net').createServer();
        srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
        srv.on('error', () => resolve(0));
    });
}

/** Start `exe` and report whether it is still alive after `ms` — and what it said if it died. */
function survives(exe, args, { ms = 6000, env, cwd } = {}) {
    return new Promise((resolve) => {
        let said = '';
        let done = false;
        const child = spawn(exe, args, { windowsHide: true, env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const grab = (d) => { said = (said + d.toString()).slice(-4000); };
        child.stdout.on('data', grab);
        child.stderr.on('data', grab);
        const finish = (alive, code) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (alive) { try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch (e) { } }
            resolve({ alive, code, said: said.replace(/\u001b\[[0-9;]*m/g, '') });
        };
        const timer = setTimeout(() => finish(true, null), ms);
        child.on('exit', (code) => finish(false, code));
        child.on('error', (e) => { said += e.message; finish(false, -1); });
    });
}

/** Differential config check: fail only when the current core accepts what the new one rejects. */
async function differential(currentExe, newExe, args, label) {
    const cur = fs.existsSync(currentExe) ? await run(currentExe, args, { timeout: 60000, cwd: path.dirname(currentExe) }) : null;
    const nxt = await run(newExe, args, { timeout: 60000, cwd: path.dirname(newExe) });
    if (nxt.code === 0) return { ok: true, detail: 'کانفیگ فعلی برنامه (' + label + ') با هستهٔ تازه تأیید شد.' };
    if (cur && cur.code !== 0) {
        return { ok: true, detail: 'کانفیگ فعلی (' + label + ') با هستهٔ کنونی هم خطا می‌دهد، پس معیار مقایسه نیست.' };
    }
    return { ok: false, detail: 'هستهٔ تازه کانفیگی را رد کرد که هستهٔ کنونی قبول می‌کند (' + label + '): ' + (nxt.out + nxt.err).trim().slice(-400) };
}

async function validate(item, staging, target, log) {
    const checks = [];
    const mainProbe = item.probe;
    if (mainProbe) {
        const v = await probeFile(path.join(staging, mainProbe.file), mainProbe);
        if (!v && item.validate !== 'probe-optional') return { ok: false, detail: 'هستهٔ تازه اجرا شد اما نسخه‌اش را نگفت — نصب نمی‌شود.' };
        if (v && !item.versionIsBundle && versions.compare(v, target.version) !== 0) {
            return { ok: false, detail: 'فایل تازه خودش را ' + v + ' معرفی می‌کند، نه ' + target.version + ' — نصب نمی‌شود.' };
        }
        if (v) checks.push('نسخهٔ گزارش‌شده: ' + v);
    }
    for (const p of item.probes || []) {
        const v = await probeFile(path.join(staging, p.file), p);
        if (!v) return { ok: false, detail: path.basename(p.file) + ' از بستهٔ تازه اجرا نشد.' };
        checks.push(path.basename(p.file) + ' ' + v);
    }

    if (item.validate === 'xray-config') {
        const cfg = path.join(bundledCoreDir(), 'config.json');
        if (fs.existsSync(cfg)) {
            const r = await differential(effectiveFile(item, 'xray.exe'), path.join(staging, 'xray.exe'), ['-test', '-config', cfg], 'config.json');
            if (!r.ok) return r;
            checks.push(r.detail);
        }
    } else if (item.validate === 'singbox-config') {
        const cfg = path.join(bundledCoreDir(), 'tun-config.json');
        if (fs.existsSync(cfg)) {
            const r = await differential(effectiveFile(item, 'sing-box.exe'), path.join(staging, 'sing-box.exe'), ['check', '-c', cfg], 'tun-config.json');
            if (!r.ok) return r;
            checks.push(r.detail);
        }
    } else if (item.validate === 'geph-config') {
        // geph5-client rejects unknown config keys at startup, so the real question for a new build
        // is "does it accept the config THIS app writes". Run it in dry-run (no listeners, no
        // tunnel) on a spare control port with a throwaway cache, and see whether it stays up.
        let cfgObj = null;
        try { cfgObj = require('../geph-manager')._internal.configObject; } catch (e) { cfgObj = null; }
        if (cfgObj) {
            const scratch = path.join(staging, '.check');
            await fsp.mkdir(scratch, { recursive: true });
            const port = await freePort();
            const cfg = cfgObj({ dryRun: true, controlListen: '127.0.0.1:' + port, cache: path.join(scratch, 'db') });
            const cfgFile = path.join(scratch, 'config.json');
            await fsp.writeFile(cfgFile, JSON.stringify(cfg, null, 2));
            const env = Object.assign({}, process.env, { RUST_LOG: 'geph=info,geph5_client=info' });
            const r = await survives(path.join(staging, 'geph5-client.exe'), ['--config', cfgFile], { ms: 7000, env, cwd: scratch });
            await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
            if (!r.alive && /unknown field|missing field|invalid type|expected|error/i.test(r.said)) {
                return { ok: false, detail: 'هستهٔ تازهٔ گف کانفیگ برنامه را نمی‌پذیرد: ' + r.said.trim().slice(-300) };
            }
            if (!r.alive && r.code !== 0) {
                return { ok: false, detail: 'هستهٔ تازهٔ گف با کانفیگ برنامه بالا نیامد (کد ' + r.code + '): ' + r.said.trim().slice(-300) };
            }
            checks.push('کانفیگ برنامه را پذیرفت و ' + (r.alive ? 'بالا ماند' : 'به‌درستی تمام شد'));
        }
    } else if (item.validate === 'none') {
        const exe = path.join(staging, item.files[0]);
        const r = await run(exe, ['-h'], { timeout: 15000, cwd: staging });
        if (!/usage/i.test(r.out + r.err)) return { ok: false, detail: path.basename(exe) + ' از بستهٔ تازه اجرا نشد.' };
        checks.push('اجرا شد');
    }

    if (item.keys) {
        const keys = await binaryHasKeys(path.join(staging, item.files[0]), item.keys);
        const missing = keys ? Object.keys(keys).filter((k) => !keys[k]) : [];
        checks.push(missing.length ? 'این کلیدها را ندارد: ' + missing.join('، ') : 'همهٔ کلیدهای لازم را دارد');
    }
    if (log) checks.forEach((c) => say(log, c));
    return { ok: true, detail: checks.join(' · ') };
}

// ── install / rollback / gc ───────────────────────────────────────────────────

function fail(code, message) { const e = new Error(message); e.code = code; return e; }

/**
 * Install `target` ({ version, artifacts, notes }) for a core item.
 * Events: onPhase(phase, detail), onProgress(done, total), onRoute(label).
 */
async function install(item, target, { onPhase, onProgress, onRoute, signal, log, force = false } = {}) {
    if (!item || item.kind !== 'core') throw fail('bad-item', 'این مورد هستهٔ موتور نیست.');
    if (!target || !target.version || !Array.isArray(target.artifacts) || !target.artifacts.length) {
        throw fail('no-target', 'برای این هسته هنوز نسخهٔ تأییدشده‌ای منتشر نشده است.');
    }
    for (const a of target.artifacts) {
        if (!trust.isSha256(a.sha256) || !Array.isArray(a.urls) || !a.urls.length) {
            throw fail('no-digest', 'نسخهٔ ' + target.version + ' هش معتبر ندارد — نصب نمی‌شود.');
        }
    }
    const now = await state(item);
    if (!force && now.version && !versions.newer(target.version, now.version)) {
        throw fail('not-newer', 'نسخهٔ ' + target.version + ' از نسخهٔ در حال استفاده (' + now.version + ') جدیدتر نیست.');
    }

    say(onPhase, 'protect');
    const guard = await protectRoot();
    if (!guard.ok) throw fail(guard.reason, guard.message);

    // 2. download
    const fetched = [];
    let totalBytes = target.artifacts.reduce((s, a) => s + (a.size || 0), 0);
    let doneBytes = 0;
    for (const a of target.artifacts) {
        say(onPhase, 'download', a.name);
        const dest = path.join(downloadsDir(), a.sha256);
        const base = doneBytes;
        const got = await netio.download({
            urls: a.urls, sha256: a.sha256, size: a.size || 0, dest, signal,
            onRoute: (label) => say(onRoute, label),
            onProgress: (n, t) => { if (onProgress) onProgress(base + n, totalBytes || t); },
        });
        doneBytes += a.size || got.bytes;
        fetched.push({ artifact: a, file: got.file, route: got.route });
        say(log, a.name + ' دریافت و با هش تأیید شد (' + got.route + ')');
    }

    // 3. extract
    say(onPhase, 'extract');
    const dir = itemDir(item.id);
    const tag = crypto.randomBytes(4).toString('hex');
    const staging = path.join(dir, target.version.replace(/[^0-9A-Za-z.\-]/g, '_') + '.staging-' + tag);
    const scratch = path.join(dir, '.x-' + tag);
    await fsp.rm(staging, { recursive: true, force: true });
    await fsp.mkdir(staging, { recursive: true });
    try {
        for (const f of fetched) await extractArtifact(f.artifact, f.file, staging, scratch);
        for (const c of item.companions || []) {
            const src = path.join(bundledCoreDir(), c.from);
            const dest = path.join(staging, c.rel);
            if (fs.existsSync(dest)) continue;
            if (!fs.existsSync(src) || (await trust.sha256File(src)) !== c.sha256) {
                throw fail('companion', c.rel + ' همراه برنامه نبود یا دست خورده است.');
            }
            await fsp.copyFile(src, dest);
        }
        const files = {};
        for (const rel of item.files) {
            const p = path.join(staging, rel);
            if (!fs.existsSync(p)) throw fail('incomplete', '«' + rel + '» در نسخهٔ تازه نیست.');
            files[rel] = { size: fs.statSync(p).size, sha256: await trust.sha256File(p) };
        }

        // 4. prove it runs
        say(onPhase, 'validate');
        const check = await validate(item, staging, target, log);
        if (!check.ok) throw fail('validation', check.detail);

        // 5. place and activate
        say(onPhase, 'activate');
        const finalDir = path.join(dir, target.version.replace(/[^0-9A-Za-z.\-]/g, '_'));
        const current = readActive()[item.id];
        if (current && path.resolve(current.dir) === path.resolve(finalDir)) {
            throw fail('in-use', 'همین نسخه هم‌اکنون فعال است.');
        }
        await fsp.rm(finalDir, { recursive: true, force: true });
        let renamed = false;
        for (let i = 0; i < 5 && !renamed; i++) {
            try { await fsp.rename(staging, finalDir); renamed = true; } catch (e) {
                // An antivirus scanner holding a freshly written .exe is the usual EPERM here.
                await new Promise((r) => setTimeout(r, 800 * (i + 1)));
            }
        }
        if (!renamed) throw fail('place', 'پوشهٔ نسخهٔ تازه جابه‌جا نشد (احتمالاً آنتی‌ویروس در حال بررسی آن است). چند ثانیه بعد دوباره بزنید.');

        const record = {
            version: target.version, dir: finalDir, files,
            installedAt: new Date().toISOString(),
            route: fetched.map((f) => f.route).join('، '),
            check: check.detail,
        };
        await editActive((data) => {
            const prev = data[item.id];
            data[item.id] = Object.assign(record, {
                previous: prev ? { version: prev.version, dir: prev.dir, files: prev.files, installedAt: prev.installedAt } : null,
            });
            return data;
        });
        say(log, 'نسخهٔ ' + target.version + ' فعال شد؛ از اجرای بعدی موتور استفاده می‌شود.');
        gc(item).catch(() => {});
        return { version: target.version, dir: finalDir, check: check.detail, route: record.route };
    } finally {
        await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
        await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
}

/** Back to the version before the last install — or to the app's own copy when there was none. */
async function rollback(item) {
    const guard = await protectRoot();
    if (!guard.ok) throw fail(guard.reason, guard.message);
    let result = null;
    await editActive((data) => {
        const cur = data[item.id];
        if (!cur) throw fail('nothing', 'این هسته از استور نصب نشده؛ همان نسخهٔ همراه برنامه در حال استفاده است.');
        const prev = cur.previous;
        const prevOk = prev && prev.dir && fs.existsSync(prev.dir) && SHIPPED[item.id] && versions.newer(prev.version, SHIPPED[item.id].version);
        if (prevOk) {
            data[item.id] = Object.assign({}, prev, { previous: null, installedAt: prev.installedAt });
            result = { version: prev.version, source: 'store' };
        } else {
            delete data[item.id];
            result = { version: SHIPPED[item.id] ? SHIPPED[item.id].version : null, source: 'bundled' };
        }
        return data;
    });
    gc(item).catch(() => {});
    return result;
}

/** Remove version directories nothing points at, and downloads no active install came from. */
async function gc(item) {
    const dir = itemDir(item.id);
    const rec = readActive()[item.id];
    const keep = new Set([rec && rec.dir, rec && rec.previous && rec.previous.dir].filter(Boolean).map((p) => path.resolve(p)));
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = path.resolve(dir, e.name);
        if (keep.has(p)) continue;
        // A directory a running engine still executes from cannot be deleted; that is fine — it goes
        // on a later pass, once the engine has restarted from the new one.
        await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
    }
}

async function pruneDownloads(keepDigests) {
    let names = [];
    try { names = await fsp.readdir(downloadsDir()); } catch (e) { return; }
    for (const n of names) {
        const digest = n.replace(/\.part$/, '');
        if (keepDigests.has(digest) && !n.endsWith('.part')) continue;
        await fsp.rm(path.join(downloadsDir(), n), { force: true }).catch(() => {});
    }
}

module.exports = {
    install, rollback, state, gc, pruneDownloads, protectRoot, isElevated,
    effectiveFile, bundledCoreDir, sddlIsLocked, locate, readActive,
    // Exported for tests/store: the MSI path is the one extraction route with no output of
    // its own, so it is the one that has to be exercised directly rather than inferred.
    runMsiAdmin, MSI_CODES,
};
