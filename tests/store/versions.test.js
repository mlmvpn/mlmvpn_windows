// Comparing the version strings the store actually meets. Every case here is one this project has
// really seen — an alpha ahead of its own stable, a worker versioned by build date, a plain integer.
const v = require('../../store/versions');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const eq = (name, got, want) => t(name + '  (' + JSON.stringify(got) + ')', got === want, 'expected ' + JSON.stringify(want));

// ── the one that made this file necessary ────────────────────────────────────
// sing-box on disk was 1.14.0-alpha.47 while stable 1.14.0 had shipped. A dot-split reads them as
// equal and the store would keep an alpha for ever.
eq('1.14.0 is newer than 1.14.0-alpha.47', v.compare('1.14.0', '1.14.0-alpha.47'), 1);
eq('1.14.0-alpha.47 is older than 1.14.0', v.compare('1.14.0-alpha.47', '1.14.0'), -1);
eq('alpha.47 beats alpha.9', v.compare('1.14.0-alpha.47', '1.14.0-alpha.9'), 1);
eq('rc beats beta beats alpha', v.compare('1.0.0-rc.1', '1.0.0-beta.9'), 1);
eq('a pre-release is older than the release it precedes', v.newer('1.15.0-alpha.1', '1.14.0'), true);

// ── the shapes in this store ─────────────────────────────────────────────────
eq('xray 26.9.9 > 26.7.28', v.compare('26.9.9', '26.7.28'), 1);
eq('four-part tor versions', v.compare('0.4.9.14', '0.4.9.12'), 1);
eq('leading v is ignored', v.compare('v2.0.41', '2.0.39'), 1);
eq('edgetunnel build dates', v.compare('2026-09-04 16:24:13', '2026-08-11 14:45:22'), 1);
eq('same date, later time', v.compare('2026-09-04 16:24:13', '2026-09-04 09:00:00'), 1);
eq('plain integers (our own workers)', v.compare(2, 1), 1);
eq('equal is zero', v.compare('1.2.3', '1.2.3'), 0);
eq('shorter is padded, not shorter', v.compare('1.2', '1.2.0'), 0);

// ── unknown must stay unknown ────────────────────────────────────────────────
// "we cannot tell" turning into "it is older" is how a store offers to install something over a
// build it knows nothing about.
eq('a build hash does not compare', v.compare('build 7a04e1', '2.0.39'), null);
eq('empty does not compare', v.compare('', '1.0.0'), null);
eq('null does not compare', v.compare(null, '1.0.0'), null);
eq('unknown is never "newer"', v.newer('build 7a04e1', '2.0.39'), false);
eq('unknown is never "newer", the other way round', v.newer('2.0.39', 'build 7a04e1'), false);

eq('isPre on an alpha', v.isPre('1.14.0-alpha.47'), true);
eq('isPre on a date', v.isPre('2026-09-04 16:24:13'), false);
eq('isPre on a release', v.isPre('26.9.9'), false);

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
