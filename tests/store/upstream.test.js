// What the developers have published, and the line between «we noticed» and «install it».
//
// THE BUG THIS EXISTS FOR (reported 2026-09-15, «وقتی توسعه دهنده نسخه جدید میده استور ما باید
// متوجه بشه — چرا نشده؟»): the store read a project's releases only when someone pressed «بررسی
// مخزن», showed the list once and kept nothing. Aether 2.0.0 had been out for three days, our
// build was 1.9.0, and no part of the window said so.
//
// The rule that must NOT be lost while fixing it: only a version that has been tested and signed
// into the channel is ever installed. What upstream published is information — so these cases are
// mostly about `isNewer` staying false whenever the answer would otherwise become a button.
const up = require('../../store/upstream');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const eq = (name, got, want) => t(name + '  (' + JSON.stringify(got) + ')', got === want, 'expected ' + JSON.stringify(want));

const item = (tagRe) => ({ id: 'x', upstream: { type: 'github', repo: 'a/b', tagRe } });
const rel = (tag, updated) => ({ tag, updated: updated || '2026-09-01T00:00:00Z' });

// ── reading a tag ────────────────────────────────────────────────────────────
eq('a plain v-tag is the version', up.versionOf(item(), 'v2.0.0'), '2.0.0');
eq('geph carries its component in the tag', up.versionOf(item('^geph5-client-v(.+)$'), 'geph5-client-v0.3.10'), '0.3.10');
eq('a tag with no number is not a version', up.versionOf(item(), 'nightly'), '');

// ── which release is the newest ──────────────────────────────────────────────
// The feed is newest-FIRST by date, and that is not the same as the highest version: a project
// that patches an old branch publishes a smaller number later. Xray did exactly this.
eq('the highest version wins, not the first entry',
    (up.newestOf(item(), [rel('v26.7.29', '2026-09-10T00:00:00Z'), rel('v26.9.9', '2026-09-08T00:00:00Z')]) || {}).version, '26.9.9');
eq('entries without a version are skipped',
    (up.newestOf(item(), [rel('nightly'), rel('v1.2.3')]) || {}).version, '1.2.3');
t('nothing to read gives nothing', up.newestOf(item(), []) === null);

// ── a pre-release is news, not an update ─────────────────────────────────────
// sing-box publishes an alpha most weeks; calling that «the developer released a new version» in
// the same voice as a stable release would make the notice meaningless within a month.
eq('an alpha is marked as a pre-release', (up.newestOf(item(), [rel('v1.15.0-alpha.4')]) || {}).pre, true);
eq('a stable release is not', (up.newestOf(item(), [rel('v1.14.0')]) || {}).pre, false);

// ── the line: noticed vs installable ─────────────────────────────────────────
const latest = (version, pre) => ({ version, pre: !!pre });

eq('a newer release over an older install is noticed', up.isNewer(latest('2.0.0'), '1.9.0', null), true);
eq('the same version is not', up.isNewer(latest('1.9.0'), '1.9.0', null), false);
eq('an older release is not', up.isNewer(latest('1.8.0'), '1.9.0', null), false);
eq('a pre-release is never counted', up.isNewer(latest('1.15.0-alpha.4', true), '1.14.0', null), false);

// The channel already offers it → the window must not say the same thing twice in two voices.
eq('not when the tested target already covers it', up.isNewer(latest('26.9.9'), '26.7.28', { version: '26.9.9' }), false);
eq('but yes when upstream is ahead of even the tested target', up.isNewer(latest('27.0.0'), '26.7.28', { version: '26.9.9' }), true);

// «Unknown» must stay unknown: with nothing to compare against, nothing is claimed.
eq('an unreadable installed version claims nothing', up.isNewer(latest('2.0.0'), '', null), false);
eq('nothing published claims nothing', up.isNewer(null, '1.9.0', null), false);

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
