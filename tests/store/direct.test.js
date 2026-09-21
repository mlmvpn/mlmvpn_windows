// Installing the DEVELOPER's own build — store/direct.js.
//
// WHERE THIS CAME FROM. upstream.test.js exists because the store did not notice a new release.
// It notices now, and for Aether that was still not enough: CluvexStudio publish the very archive
// this app ships, so «we know 2.0.0 exists but cannot install it» was a wait for nothing but our
// own release cadence. This is the opt-in that closes it (catalogue: `upstream.direct`).
//
// «Direct» is not «unchecked», and that is what most of these cases are about: an asset that is
// missing, or one GitHub published no digest for, must yield NOTHING rather than an install with
// no anchor. A newer version is never a reason to skip the hash.

const assert = require('assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Its cache is a file in the user's profile; give this run its own so a developer's real store is
// not read or written by a test.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-direct-'));
process.env.MLMVPN_STORE_ROOT = path.join(sandbox, 'store');
const home = os.homedir;
os.homedir = () => sandbox;

const direct = require('../../store/direct');
const catalog = require('../../store/catalog');
const github = require('../../store/github');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const eq = (name, got, want) => t(name + '  (' + JSON.stringify(got) + ')', got === want, 'expected ' + JSON.stringify(want));

// ── the catalogue entry ──────────────────────────────────────────────────────
// Aether is the one core installed this way today. If that ever changes, it should change here
// deliberately — a core silently gaining «install whatever the developer just pushed» is exactly
// the kind of thing a test should make someone type out.
const warp = catalog.BY_ID.warp;
t('aether is installed from the developer directly', !!(warp.upstream && warp.upstream.direct));
eq('…from CluvexStudio/Aether', warp.upstream.repo, 'CluvexStudio/Aether');
eq('…and it is no longer built by us', warp.upstream.builtBy, undefined);
eq('exactly one core opts into direct installs', direct.tracked().length, 1);

// ── the asset name ───────────────────────────────────────────────────────────
eq('a fixed asset name is used as is',
    direct.assetName({ asset: 'aether-windows-x86_64.zip' }, '2.0.0', 'v2.0.0'), 'aether-windows-x86_64.zip');
eq('{version} is filled in', direct.assetName({ asset: 'x-{version}-win.zip' }, '1.14.0', 'v1.14.0'), 'x-1.14.0-win.zip');
eq('{tag} is filled in', direct.assetName({ asset: 'x-{tag}.zip' }, '1.14.0', 'v1.14.0'), 'x-v1.14.0.zip');

// ── resolving a release into something installable ───────────────────────────
const item = {
    id: 'warp',
    upstream: {
        type: 'github', repo: 'a/b',
        direct: { asset: 'aether-windows-x86_64.zip', format: 'zip', extract: { 'aether.exe': 'aether.exe' } },
    },
};
const rel = { version: '2.0.0', tag: 'v2.0.0', at: '2026-09-12T16:50:06Z' };
const DIGEST = '95a2abcb34c6bb22207214b32d1e58f55a304b352d26e3bf6a0c05cda7a2c4df';

const realAssets = github.assets;
const withAssets = (map, fn) => {
    github.assets = async () => map;
    return fn().then(
        (v) => { github.assets = realAssets; return { ok: true, value: v }; },
        (e) => { github.assets = realAssets; return { ok: false, error: e }; },
    );
};

(async () => {
    // The happy path: the shape `cores.install` takes, digest and all.
    const good = await withAssets(
        { 'aether-windows-x86_64.zip': { sha256: DIGEST, url: 'https://example/a.zip' } },
        () => direct.resolve(item, rel),
    );
    t('a published release resolves', good.ok, good.ok ? '' : String(good.error));
    if (good.ok) {
        const target = good.value;
        eq('…carrying the release version', target.version, '2.0.0');
        eq('…one artifact', target.artifacts.length, 1);
        eq('…with GitHub\'s own digest', target.artifacts[0].sha256, DIGEST);
        eq('…and a url to fetch', target.artifacts[0].urls[0], 'https://example/a.zip');
        eq('…the release date the window shows', target.released, '2026-09-12');
        // cores.install refuses a target whose artifacts lack either of these, so a resolve that
        // produced one would only fail later, further from the cause.
        t('…the shape install demands', !!(target.artifacts[0].name && target.artifacts[0].format && target.artifacts[0].extract));
    }

    // A release whose Windows build is not there — CI still running, or a platform dropped.
    const missing = await withAssets(
        { 'aether-linux-x86_64.tar.gz': { sha256: DIGEST, url: 'https://example/l.tgz' } },
        () => direct.resolve(item, rel),
    );
    t('a release without the windows asset resolves to nothing', !missing.ok);

    // The case worth being strict about: the asset IS there, and has no digest. GitHub computes
    // one at upload, but not for anything uploaded before they started. Without it there is no
    // anchor, and «newer» is not a substitute for one.
    const noDigest = await withAssets(
        { 'aether-windows-x86_64.zip': { sha256: null, url: 'https://example/a.zip' } },
        () => direct.resolve(item, rel),
    );
    t('an asset with no digest is refused', !noDigest.ok);

    // ── what counts as an update ─────────────────────────────────────────────
    eq('a newer developer build is an update', direct.isNewer({ version: '2.0.0' }, '1.9.0'), true);
    eq('the same version is not', direct.isNewer({ version: '2.0.0' }, '2.0.0'), false);
    eq('an older one is not', direct.isNewer({ version: '1.9.0' }, '2.0.0'), false);
    eq('nothing resolved is never an update', direct.isNewer(null, '1.9.0'), false);

    // ── the cache holds nothing it cannot install ────────────────────────────
    // `get` is what the window and the install path both read. A row recorded as an ERROR (the
    // resolve failed, the last good answer kept) must not come back as a target.
    eq('an unresolved item has no target', direct.get('nothing-here'), null);

    // report
    let bad = 0;
    for (const r of results) {
        if (r.pass) console.log('PASS  ' + r.name);
        else { bad++; console.log('FAIL  ' + r.name + (r.detail ? ' — ' + r.detail : '')); }
    }
    console.log('\n' + (results.length - bad) + '/' + results.length + ' passed');
    os.homedir = home;
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch (e) { /* windows holds files */ }
    if (bad) process.exit(1);
})().catch((e) => { console.log('FAIL  suite threw — ' + e.stack); process.exit(1); });

assert.ok(true);
