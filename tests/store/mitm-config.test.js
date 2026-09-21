// The «دامین فرانتینگ» config as an updatable item — with a real install, end to end.
//
// This one has a transform of its own and it is the whole difference between upstream's file and
// ours: their config names a certificate beside the executable (`mycert.crt`), this app mints one
// per machine and writes its real path in at start-up, so the stored copy carries placeholders.
// If that transform ever half-applies, the app terminates TLS with a certificate nobody trusts and
// every site in the browser shows a warning — so it is counted, not hoped for.
//
// Only the download is stubbed; the guard, the transform, xray -test (with a throwaway certificate
// it mints for the check), the locked folder and the active pointer are the real ones.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-mitm-test-'));
process.env.MLMVPN_STORE_ROOT = path.join(scratch, 'store');

const guard = require(path.join(ROOT, 'iran-profiles-gen'));
const netio = require(path.join(ROOT, 'store', 'net'));
const mitm = require(path.join(ROOT, 'store', 'mitm-config'));

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const eq = (name, got, want) => t(name + '  (' + JSON.stringify(got) + ')', got === want, 'expected ' + JSON.stringify(want));

const OURS = fs.readFileSync(path.join(ROOT, 'core', 'mitm', 'mitm_domainfronting_v23.json'), 'utf8');
const CERT_PLACEHOLDER = '__MLM_CERT_PATH__';
const KEY_PLACEHOLDER = '__MLM_KEY_PATH__';

// ── the transform ────────────────────────────────────────────────────────────
// Upstream's own file, as it is published: two TLS inbounds, each naming a certificate file.
const upstreamLike = (() => {
    const o = JSON.parse(OURS);
    let n = 0;
    const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(walk); return; }
        for (const k of Object.keys(node)) {
            if (k === 'certificateFile') { node[k] = 'mycert.crt'; n++; }
            else if (k === 'keyFile') { node[k] = 'mycert.key'; n++; }
            else walk(node[k]);
        }
    };
    walk(o);
    return { text: JSON.stringify(o, null, 2), swapped: n };
})();
eq('the fixture really carries upstream-style paths', upstreamLike.swapped, 4);

const converted = mitm.withOurCertPaths(upstreamLike.text);
t('both certificate paths become placeholders', converted.split(CERT_PLACEHOLDER).length - 1 === 2);
t('both key paths become placeholders', converted.split(KEY_PLACEHOLDER).length - 1 === 2);
t('no upstream path survives', converted.indexOf('mycert.') < 0);
t('and the result is the file this app already ships',
    JSON.stringify(JSON.parse(converted)) === JSON.stringify(JSON.parse(guard.normalizeSource(OURS))));

// A file that moved on — one TLS inbound instead of two — must stop here, not install.
const halfConfig = (() => {
    const o = JSON.parse(upstreamLike.text);
    o.inbounds = o.inbounds.slice(0, 2);
    return JSON.stringify(o, null, 2);
})();
t('a config with fewer certificates than expected is refused', (() => {
    try { mitm.withOurCertPaths(halfConfig); return false; } catch (e) { return true; }
})());

// ── the serverless invariant, on this project too ────────────────────────────
t('the shipped config passes the serverless check', (() => {
    try { guard.assertServerless(OURS, 'mitm'); return true; } catch (e) { return false; }
})());

// ── an install, for real ─────────────────────────────────────────────────────
// Upstream is stubbed with a CHANGED file (one routed domain added) so the digest differs the way
// a real commit would; everything after the download runs as it does in the app.
const changed = (() => {
    const o = JSON.parse(upstreamLike.text);
    o.remarks = 'MITM-DomainFronting_v24';
    return JSON.stringify(o, null, 2);
})();
const FEED = '<feed><updated>2026-09-20T00:00:00Z</updated><entry><updated>2026-09-18T09:00:00Z</updated></entry></feed>';
const realFetch = netio.fetchText;
netio.fetchText = async (url) => {
    if (url.indexOf('/commits/') >= 0) return { text: FEED, route: 'تست' };
    if (url.indexOf('MITM-DomainFronting.json') >= 0) return { text: changed, route: 'تست' };
    throw new Error('unexpected url ' + url);
};

(async () => {
    eq('with nothing installed, the app’s own copy is the one in use', mitm.state().source, 'shipped');

    const found = await mitm.check();
    eq('a changed upstream file is seen as changed', found.changed, true);
    eq('the config’s own remarks is the version', found.version, 'v24');

    const done = await mitm.install({});
    eq('the install reports the version it activated', done.version, 'v24');
    const after = mitm.state();
    eq('the store copy is now the one in use', after.source, 'store');
    t('and the file it points at exists', fs.existsSync(after.file));
    const text = fs.readFileSync(after.file, 'utf8');
    t('the installed file carries this machine’s placeholders, not upstream’s paths',
        text.indexOf(CERT_PLACEHOLDER) > 0 && text.indexOf('mycert.') < 0);
    eq('a second install with the same file is refused as «nothing new»',
        await mitm.install({}).then(() => 'installed').catch((e) => e.code), 'current');

    const back = await mitm.rollback();
    eq('rollback goes to the app’s own copy', back.to, 'نسخهٔ همراه برنامه');
    eq('and the app reads its own file again', mitm.state().source, 'shipped');

    netio.fetchText = realFetch;
    fs.rmSync(scratch, { recursive: true, force: true });

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch((e) => {
    console.log('FAIL  the install path threw: ' + e.message);
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (x) { }
    process.exit(1);
});
