// The install pipeline's refusals and its two pieces of low-level plumbing. The happy path needs a
// real download and is exercised by hand (measured 2026-09-14: Xray 26.9.9 in 22 s, sing-box 1.14.0
// in 23 s, the Tor bundle and the Tailscale MSI through a tunnel); what belongs in a test suite is
// everything that must NOT happen.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-store-cores-'));
process.env.MLMVPN_STORE_ROOT = ROOT;

const cores = require('../../store/cores');
const catalog = require('../../store/catalog');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── the ACL check that decides whether installing is safe at all ─────────────
// Written from real SDDL: these are the strings Windows actually returns.
const LOCKED = 'O:BAG:SYD:PAI(A;OICI;0x1200a9;;;AU)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)';
t('a folder only SYSTEM and Administrators can write is accepted', cores.sddlIsLocked(LOCKED));
t('a folder where Users have full control is refused',
    !cores.sddlIsLocked('O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;BU)'));
t('a folder where an ordinary account has full control is refused',
    !cores.sddlIsLocked('O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;S-1-5-21-1-2-3-1001)'));
t('a folder that still inherits permissions is refused',
    !cores.sddlIsLocked('O:BAG:SYD:AI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)'));
t('an empty DACL is refused', !cores.sddlIsLocked('O:BAG:SYD:P'));
t('nonsense is refused', !cores.sddlIsLocked('not an sddl'));
t('write access for Authenticated Users is refused',
    !cores.sddlIsLocked('O:BAG:SYD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;AU)'));

// ── finding the right file inside an unpacked archive ────────────────────────
const tree = path.join(ROOT, 'tree');
fs.mkdirSync(path.join(tree, 'tor', 'pluggable_transports'), { recursive: true });
fs.mkdirSync(path.join(tree, 'data'), { recursive: true });
fs.mkdirSync(path.join(tree, 'decoy'), { recursive: true });
for (const p of ['tor/tor.exe', 'tor/pluggable_transports/lyrebird.exe', 'data/geoip', 'decoy/tor.exe']) {
    fs.writeFileSync(path.join(tree, p), 'x');
}
const all = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else all.push(p); } })(tree);
t('a path with a slash matches that exact path', cores.locate(all, tree, 'tor/tor.exe') === path.join(tree, 'tor', 'tor.exe'));
t('a nested path matches too', cores.locate(all, tree, 'tor/pluggable_transports/lyrebird.exe') === path.join(tree, 'tor', 'pluggable_transports', 'lyrebird.exe'));
t('a bare name prefers the shallowest match', cores.locate(all, tree, 'geoip') === path.join(tree, 'data', 'geoip'));
t('a file that is not there is null', cores.locate(all, tree, 'nothing.exe') === null);

// ── install refusals ────────────────────────────────────────────────────────
(async () => {
    const xray = catalog.BY_ID.xray;
    const tries = [
        ['an item that is not a core', catalog.BY_ID.zeus, { version: '9.9.9', artifacts: [{ sha256: 'a'.repeat(64), urls: ['x'] }] }, /هسته/],
        ['a target with no artifacts', xray, { version: '99.0.0', artifacts: [] }, /منتشر نشده/],
        ['an artifact with no digest', xray, { version: '99.0.0', artifacts: [{ name: 'x', urls: ['https://x/y'] }] }, /هش معتبر/],
        ['an artifact with a bogus digest', xray, { version: '99.0.0', artifacts: [{ name: 'x', sha256: 'zz', urls: ['https://x/y'] }] }, /هش معتبر/],
        ['an artifact with a digest but nowhere to get it', xray, { version: '99.0.0', artifacts: [{ name: 'x', sha256: 'a'.repeat(64), urls: [] }] }, /هش معتبر/],
        ['a version that is not newer than what is installed', xray, { version: '0.0.1', artifacts: [{ name: 'x', sha256: 'a'.repeat(64), urls: ['https://x/y'] }] }, /جدیدتر نیست/],
    ];
    for (const [name, item, target, match] of tries) {
        let msg = '';
        try { await cores.install(item, target, {}); } catch (e) { msg = e.message; }
        t('refused: ' + name, match.test(msg), msg || 'no error thrown');
    }

    // Rolling back something that was never installed must say so, not half-do it.
    let msg = '';
    try { await cores.rollback(catalog.BY_ID.gst); } catch (e) { msg = e.message; }
    t('refused: rolling back a core the store never installed', /نصب نشده/.test(msg), msg);

    // state() works with nothing installed, and reports the shipped version.
    const st = await cores.state(catalog.BY_ID.xray);
    t('state() reports the app\'s own copy when the store has none', st.source === 'bundled' && !!st.version, JSON.stringify(st.version));
    t('state() reads the version off the binary itself', st.reported === st.version, st.reported + ' vs ' + st.version);

    // ── the MSI extraction path ──────────────────────────────────────────────
    // msiexec writes NOTHING to stdout or stderr, so a failure used to surface as the bare
    // words «باز کردن بسته نشد:» with nothing after the colon — which is what the GitHub
    // tunnel update showed. The regression guarded here is an EMPTY explanation, and the
    // target path deliberately contains a space: that is what broke the real install
    // (msiexec wants TARGETDIR="value", while Node's argv escaping produces "TARGETDIR=value").
    if (process.platform === 'win32') {
        const spaced = path.join(ROOT, 'with space', '.x-test');
        fs.mkdirSync(spaced, { recursive: true });
        const r = await cores.runMsiAdmin(path.join(spaced, 'no-such-package.msi'), spaced);
        t('a failed MSI extraction reports a non-zero code', r.code !== 0, String(r.code));
        t('a failed MSI extraction explains itself instead of returning an empty message',
            !!(r.detail && r.detail.trim().length > 10), JSON.stringify(r.detail));
        t('msiexec exit codes are translated, not printed as numbers',
            typeof cores.MSI_CODES[1619] === 'string' && typeof cores.MSI_CODES[1603] === 'string');
    }

    fs.rmSync(ROOT, { recursive: true, force: true });

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
