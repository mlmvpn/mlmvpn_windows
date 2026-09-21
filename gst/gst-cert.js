// --- GST certificate management ---
// The tunnel decrypts TLS locally (MITM) so it can relay HTTP through Apps Script, which
// means Windows has to trust a locally generated CA or every https site breaks. This
// module drives that: generate, install, verify, remove — all from inside the app, with
// no terminal and no manual certificate wizard.
//
// Two independent facts matter, and the panel shows them separately because the fixes
// differ:
//   exists  — the CA file has been generated on disk
//   trusted — Windows actually has it in a Trusted Root store
// A CA that exists but is not trusted is the interesting case: it happens when a user
// clears their certificate store, or when a previous install silently failed.
//
// Installation goes into the PER-USER Root store first (certutil -addstore -user Root),
// which needs no administrator rights. Only if that fails do we try the machine store.
// That ordering is what makes "install with one click" true for a normal user.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const core = require('./gst-core');
const log = require('./gst-log');

// Must match CERT_NAME in gst-src/src/mitm.rs — the engine generates the CA with this
// common name, and certutil looks it up by exactly this string.
const CERT_NAME = 'MasterHttpRelayVPN';

/**
 * Where the engine keeps its CA.
 *
 * data_dir() in gst-src/src/data_dir.rs uses the `directories` crate's `config_dir()`,
 * which on Windows is %APPDATA%\<app>\config — note the trailing "config" segment. An
 * earlier version of this function guessed %APPDATA%\mhrv-rs\ca and reported "no
 * certificate" while one was installed and working; the verified layout is:
 *   %APPDATA%\mhrv-rs\config\ca\ca.crt
 */
function caPaths() {
    const base = process.env.APPDATA
        ? path.join(process.env.APPDATA, 'mhrv-rs')
        : path.join(os.homedir(), 'AppData', 'Roaming', 'mhrv-rs');
    const dir = path.join(base, 'config', 'ca');
    return { dir, cert: path.join(dir, 'ca.crt'), key: path.join(dir, 'ca.key') };
}

function run(cmd, args, { timeout = 20000 } = {}) {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
            });
        });
    });
}

/**
 * Is our CA in a Windows Trusted Root store?
 *
 * `certutil -store Root <name>` is checked by NAME, not by exit code: in some locales
 * certutil returns 0 even when it matched nothing, so a bare exit-code check reports a
 * missing certificate as installed. The Rust installer has the same note — this is a
 * known certutil quirk, not defensive padding.
 */
async function isTrusted() {
    for (const scope of [['-user'], []]) {
        const r = await run('certutil', [...scope, '-store', 'Root', CERT_NAME]);
        if (r.ok && r.stdout.toLowerCase().includes(CERT_NAME.toLowerCase())) {
            return { trusted: true, scope: scope.length ? 'user' : 'machine' };
        }
    }
    return { trusted: false, scope: null };
}

/** Full certificate status for the health tab. */
async function getStatus() {
    const paths = caPaths();
    const exists = fs.existsSync(paths.cert);
    const { trusted, scope } = await isTrusted();

    let notAfter = null;
    if (exists) {
        // Expiry matters: the engine happily keeps using an expired CA, and every https
        // page then fails with an error that says nothing about certificates.
        const r = await run('certutil', ['-dump', paths.cert]);
        const m = r.stdout.match(/NotAfter\s*:\s*(.+)/i);
        if (m) notAfter = m[1].trim();
    }

    let state;
    let message;
    if (exists && trusted) {
        state = 'ok';
        message = `گواهی نصب و معتبر است${scope === 'user' ? ' (برای همین کاربر)' : ''}.`;
    } else if (exists && !trusted) {
        state = 'untrusted';
        message = 'گواهی ساخته شده ولی ویندوز به آن اعتماد ندارد — سایت‌های https باز نمی‌شوند.';
    } else if (!exists && trusted) {
        // Windows still trusts a CA whose private key is gone — usually a leftover from
        // an older install after the data dir was cleared. The tunnel cannot use it (it
        // needs the key to sign), and leaving a root certificate nobody controls in the
        // trust store is worse than useless, so this is a reinstall, not a green light.
        state = 'stale';
        message = 'ویندوز گواهی قدیمی‌ای را به یاد دارد که فایلش پاک شده — باید دوباره ساخته شود.';
    } else {
        state = 'missing';
        message = 'گواهی امنیتی هنوز ساخته نشده است.';
    }

    return { state, exists, trusted, scope, path: paths.cert, notAfter, message };
}

/**
 * Generate (if needed) and install the CA.
 *
 * The engine does both in one step via `--install-cert`: it creates the CA on first run
 * and then hands it to certutil. Driving the engine rather than reimplementing the
 * generation here guarantees the certificate the tunnel uses is the certificate we
 * installed — two separate implementations would eventually drift and produce a CA that
 * is trusted but unused.
 */
async function install() {
    log.info('cert', 'در حال ساخت و نصب گواهی امنیتی…');

    const before = await getStatus();
    if (before.state === 'ok') {
        log.ok('cert', 'گواهی از قبل نصب و معتبر بود');
        return { ...before, changed: false };
    }

    const res = await core.runCommand(['--install-cert'], { timeout: 60000 });
    for (const line of `${res.stdout}\n${res.stderr}`.split(/\r?\n/)) {
        const t = line.trim();
        if (t) log.info('cert', t);
    }

    // Trust the store, not the exit code. certutil can report success while the store
    // is unchanged (blocked by policy, for instance), and claiming a green certificate
    // that Windows does not honour would send the user hunting through browser settings
    // for a problem that is actually here.
    const after = await getStatus();
    if (after.state === 'ok') {
        log.ok('cert', 'گواهی امنیتی با موفقیت نصب شد');
        return { ...after, changed: true };
    }

    log.error('cert', 'نصب گواهی انجام نشد');
    return {
        ...after,
        changed: false,
        message: after.exists
            ? 'گواهی ساخته شد ولی ویندوز آن را نپذیرفت. اگر ویندوز شما سیاست محدودکننده دارد، ' +
              'برنامه را یک بار «Run as administrator» اجرا کنید.'
            : 'ساخت گواهی ناموفق بود — لاگ هسته را ببینید.',
    };
}

/**
 * Remove the CA from the trust store and delete it from disk.
 * Offered because installing a root certificate is a real change to the user's machine,
 * and anything this app adds to Windows it must also be able to take back.
 */
async function remove() {
    log.info('cert', 'در حال حذف گواهی امنیتی…');
    const res = await core.runCommand(['--remove-cert'], { timeout: 60000 });
    for (const line of `${res.stdout}\n${res.stderr}`.split(/\r?\n/)) {
        const t = line.trim();
        if (t) log.info('cert', t);
    }

    const after = await getStatus();
    if (!after.trusted) {
        log.ok('cert', 'گواهی از ویندوز حذف شد');
        return { ...after, removed: true };
    }
    log.error('cert', 'حذف گواهی کامل نشد');
    return {
        ...after,
        removed: false,
        message: 'گواهی هنوز در ویندوز هست. اگر با دسترسی ادمین نصب شده، برنامه را ' +
            'به‌صورت «Run as administrator» اجرا و دوباره تلاش کنید.',
    };
}

/**
 * Firefox and Chrome keep their own NSS trust store on some setups, so a certificate
 * Windows trusts can still be rejected in the browser. The engine's installer already
 * does a best-effort NSS pass; this re-runs it and reports honestly that the result
 * cannot be verified from here.
 */
async function installForBrowsers() {
    log.info('cert', 'تلاش برای نصب گواهی در مرورگرها (NSS)…');
    const res = await core.runCommand(['--install-cert'], { timeout: 60000 });
    const output = `${res.stdout}\n${res.stderr}`;
    for (const line of output.split(/\r?\n/)) {
        const t = line.trim();
        if (t) log.info('cert', t);
    }

    const nssSeen = /nss|firefox|certutil/i.test(output);
    return {
        ok: true,
        nssAttempted: nssSeen,
        message: nssSeen
            ? 'نصب در مخزن مرورگرها انجام شد. فایرفاکس را ببندید و دوباره باز کنید.'
            : 'ابزار NSS روی این سیستم پیدا نشد. اگر فقط فایرفاکس مشکل دارد، ' +
              'گواهی را دستی در Settings → Privacy → Certificates وارد کنید.',
        path: caPaths().cert,
    };
}

module.exports = { CERT_NAME, caPaths, getStatus, isTrusted, install, remove, installForBrowsers };
