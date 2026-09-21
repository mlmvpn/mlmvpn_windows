// The «کانفیگ ایران» sources as an updatable item — including a REAL install, end to end.
//
// Why this suite exists: the store can now take two files straight from @patterniha's repository
// and rebuild every profile from them, with no signature of ours in between. Three things have to
// hold, and each one is a way this could hurt somebody:
//
//   1. a file that is not a serverless config must never be installed — the whole safety of an
//      unsigned source rests on «no outbound may point at anyone's server»;
//   2. «there is an update» must mean a real content change, not a reformat;
//   3. the install must be reversible, and what it activates must be what the app then reads.
//
// The download is the only stubbed part (store/net.js › fetchText); the generator, the validator,
// xray -test, the locked folder and the active pointer are all the real ones.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-iran-test-'));
process.env.MLMVPN_STORE_ROOT = path.join(scratch, 'store');

const gen = require(path.join(ROOT, 'iran-profiles-gen'));
const netio = require(path.join(ROOT, 'store', 'net'));
const iran = require(path.join(ROOT, 'store', 'iran-configs'));

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const eq = (name, got, want) => t(name + '  (' + JSON.stringify(got) + ')', got === want, 'expected ' + JSON.stringify(want));

const SRC = path.join(ROOT, 'data', 'serverless');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

// ── jsonc, the format upstream actually publishes ────────────────────────────
eq('a // comment goes', gen.stripJsonComments('{"a":1} // tail').trim(), '{"a":1}');
eq('a /* block */ goes', gen.stripJsonComments('{/* x */"a":1}').replace(/\s/g, ''), '{"a":1}');
// The one that would be silent and fatal: a URL inside a string is not a comment.
eq('a URL inside a string survives',
    JSON.parse(gen.stripJsonComments('{"u":"https://8.8.8.8/dns-query"}')).u, 'https://8.8.8.8/dns-query');
eq('a trailing comma is tolerated', JSON.parse(gen.stripJsonComments('{"a":1,}')).a, 1);

// ── the invariant that makes an unsigned source safe ─────────────────────────
const refuses = (label, cfg) => {
    let threw = false;
    try { gen.assertServerless(cfg, 'تست'); } catch (e) { threw = true; }
    t(label, threw, 'expected assertServerless to refuse it');
};
refuses('an outbound with a server (vless) is refused', { outbounds: [{ protocol: 'vless', settings: { vnext: [{ address: '1.2.3.4' }] } }] });
refuses('an outbound with a server (socks) is refused', { outbounds: [{ protocol: 'socks', settings: { servers: [{ address: '5.6.7.8' }] } }] });
refuses('even a `direct` outbound with an address is refused', { outbounds: [{ protocol: 'direct', settings: { address: '9.9.9.9' } }] });
refuses('a config with no outbounds at all is refused', { outbounds: [] });
t('the real upstream shapes pass', (() => {
    try { gen.assertServerless(read('serverless-v50-fragA.json'), 'fragA'); return true; } catch (e) { return false; }
})());

// ── the generator ────────────────────────────────────────────────────────────
const sources = {
    v50A: read('serverless-v50-fragA.json'),
    v50B: read('serverless-v50-fragB.json'),
    v48low: read('serverless-v48-low.json'),
    v48high: read('serverless-v48-high.json'),
};
const built = gen.build(sources);
eq('nineteen profiles come out of four sources', built.length, 19);
eq('the first two are the upstream files, untouched', built[0].config === sources.v50A && built[1].config === sources.v50B, true);
t('every profile is a distinct config', new Set(built.map((p) => p.config)).size === built.length);

// ── an install, for real ─────────────────────────────────────────────────────
//
// Upstream is stubbed with a CHANGED fragA (a different DoH address in one field) so the digest
// differs the way a real commit would; everything after the download runs as it does in the app.
const changedA = (() => {
    const o = JSON.parse(sources.v50A);
    o.dns.servers.forEach((s) => { if (s && s.tag === 'no-filter-dns') s.address = 'https://dns.quad9.net/dns-query'; });
    return JSON.stringify(o, null, 2);
})();
const FEED = '<feed><updated>2026-09-20T00:00:00Z</updated><entry><updated>2026-09-19T10:00:00Z</updated></entry></feed>';
const realFetch = netio.fetchText;
netio.fetchText = async (url) => {
    // The commits feed FIRST: its URL ends in the file's own name too, so matching the file branch
    // first would hand a config back as if it were a feed (which is what this order is for).
    if (url.indexOf('/commits/') >= 0) return { text: FEED, route: 'تست' };
    if (url.indexOf('fragA.jsonc') >= 0) return { text: '// upstream ships jsonc\n' + changedA, route: 'تست' };
    if (url.indexOf('fragB.jsonc') >= 0) return { text: sources.v50B, route: 'تست' };
    throw new Error('unexpected url ' + url);
};

(async () => {
    const before = iran.state();
    eq('with nothing installed, the app’s own copy is the one in use', before.source, 'shipped');
    eq('and nothing can be rolled back yet', before.canRollback, false);

    const found = await iran.check();
    eq('a changed upstream file is seen as changed', found.changed, true);
    eq('the commit date becomes the version', found.version, '2026-09-19');

    const installed = await iran.install({});
    eq('the install reports the rebuilt count', installed.count, 19);
    const after = iran.state();
    eq('the store copy is now the one in use', after.source, 'store');
    eq('and it carries the upstream date', after.version, '2026-09-19');
    const list = iran.profiles();
    t('the profiles the app will read come from the installed copy',
        Array.isArray(list) && list.length === 19 && /quad9/.test(list[0].config));
    eq('a second install with the same files is refused as «nothing new»',
        await iran.install({}).then(() => 'installed').catch((e) => e.code), 'current');

    const back = await iran.rollback();
    eq('rollback goes to the app’s own copy', back.to, 'نسخهٔ همراه برنامه');
    eq('and the app reads its own list again', iran.state().source, 'shipped');
    t('nothing is left pointing at the removed copy', iran.profiles() === null);

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
