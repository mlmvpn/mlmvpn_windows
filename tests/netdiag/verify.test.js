/*
 * Verification: what "fixed" is allowed to mean.
 *
 * Two failure directions, and both have teeth:
 *
 *   claiming FIXED too easily     one lucky endpoint, or a captive portal answering 200 to
 *                                 everything, and the user is told their problem is solved
 *                                 while nothing opens.
 *
 *   claiming REGRESSED too easily a repair that MUST change facts to work — dhcp.renew changes
 *                                 the IP, the lease and the default route by design — looks
 *                                 like breakage, fires a rollback, and performs a privileged
 *                                 write to undo a repair that had just succeeded.
 *
 * The third case is the honest one this engine exists to be able to say: the mechanism moved,
 * the user's problem did not, so another cause exists — `partially-fixed`, and re-diagnose.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const F = require(ROOT + '/netdiag/facts');
const V = require(ROOT + '/netdiag/verify');
const D = require(ROOT + '/netdiag/diagnose');
const { IDS } = require(ROOT + '/netdiag/rules/ids');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

const obs = (id, v) => F.observed(id, v, { quality: F.QUALITY.MEASURED });
const unk = (id, why) => F.unknown(id, why);
const map = list => Object.fromEntries(list.map(f => [f.id, f]));

// ── functional ──────────────────────────────────────────────────────────────────────────

const targets = spec => spec.map(([id, group, ok]) => ({ id, group, ok }));

let f = V.functional(targets([['a', 'g1', true], ['b', 'g2', true], ['c', 'g3', true]]),
    targets([['a', 'g1', false], ['b', 'g2', false], ['c', 'g3', false]]));
t('all previously failing targets now pass => functional pass', f.pass === true, JSON.stringify(f));

f = V.functional(targets([['a', 'g1', true], ['b', 'g2', false], ['c', 'g3', false]]),
    targets([['a', 'g1', false], ['b', 'g2', false], ['c', 'g3', false]]));
t('ONE lucky endpoint out of three is not a fix', f.pass === false, JSON.stringify(f));

f = V.functional(targets([['a', 'g1', true]]), targets([['a', 'g1', false]]));
t('a single target group cannot establish anything, however green it is',
    f.pass === null && /independent target group/.test(f.reason), JSON.stringify(f));

f = V.functional(targets([['a', 'g1', true], ['b', 'g2', true], ['c', 'g3', false]]),
    targets([['a', 'g1', false], ['b', 'g2', false], ['c', 'g3', false]]));
t('a majority that leaves a previously failing target still failing is not a fix',
    f.pass === false && f.recovered === 2 && f.wasFailing === 3, JSON.stringify(f));

f = V.functional(targets([['a', 'g1', null], ['b', 'g2', null]]), []);
t('nothing evaluable => pass is null, which becomes unverifiable rather than fixed',
    f.pass === null, JSON.stringify(f));

f = V.functional(targets([['a', 'g1', true], ['b', 'g2', true]]), []);
t('with no baseline, a clean majority across two groups is accepted',
    f.pass === true, JSON.stringify(f));

// ── regression ──────────────────────────────────────────────────────────────────────────

const before = map([
    obs(IDS.REACH_GATEWAY_V4, 'ok'),
    obs(IDS.REACH_FOREIGN_V4, 'ok'),
    obs(IDS.PROXY_WININET_ENABLED, true),
    obs(IDS.DNS_RESOLVE_OK_V4, true),
    obs(IDS.SVC_BFE_RUNNING, true),
]);

let r = V.regression(before, map([
    obs(IDS.REACH_GATEWAY_V4, 'ok'),
    obs(IDS.REACH_FOREIGN_V4, 'ok'),
    obs(IDS.PROXY_WININET_ENABLED, false),      // the repair's own effect
    obs(IDS.DNS_RESOLVE_OK_V4, true),
    obs(IDS.SVC_BFE_RUNNING, true),
]), ['proxy.wininet.enabled', 'proxy.http.via.ok']);
t('a repair\'s own declared effect is an EXPECTED CHANGE, not a regression',
    r.pass === true && r.expectedEffects.length === 1, JSON.stringify(r));

r = V.regression(before, map([
    obs(IDS.REACH_GATEWAY_V4, 'ok'),
    obs(IDS.REACH_FOREIGN_V4, 'fail'),          // collateral damage
    obs(IDS.PROXY_WININET_ENABLED, false),
    obs(IDS.DNS_RESOLVE_OK_V4, true),
    obs(IDS.SVC_BFE_RUNNING, true),
]), ['proxy.wininet.enabled']);
t('a fact that went ok -> fail OUTSIDE the expected set is a genuine regression',
    r.pass === false && r.regressions[0].id === IDS.REACH_FOREIGN_V4, JSON.stringify(r.regressions));

r = V.regression(before, map([
    obs(IDS.REACH_GATEWAY_V4, 'ok'),
    unk(IDS.REACH_FOREIGN_V4, 'PowerShell timed out this time'),
    obs(IDS.PROXY_WININET_ENABLED, false),
    obs(IDS.DNS_RESOLVE_OK_V4, true),
    obs(IDS.SVC_BFE_RUNNING, true),
]), ['proxy.wininet.enabled']);
t('observed -> unknown is LOST VISIBILITY, never a regression (a rollback is a privileged write)',
    r.pass === true && r.lostVisibility.length === 1, JSON.stringify(r));

// A wildcard expected set, as dhcp.renew and svc.start-bfe declare.
r = V.regression(before, map([
    obs(IDS.REACH_GATEWAY_V4, 'fail'),
    obs(IDS.REACH_FOREIGN_V4, 'fail'),
    obs(IDS.PROXY_WININET_ENABLED, true),
    obs(IDS.DNS_RESOLVE_OK_V4, true),
    obs(IDS.SVC_BFE_RUNNING, true),
]), ['reach.*']);
t('a wildcard expected set covers the family it names', r.pass === true, JSON.stringify(r.regressions));
t('...and does not cover anything else',
    V.isExpected('dns.resolve.ok.v4', ['reach.*']) === false);

// ── the combined decision ───────────────────────────────────────────────────────────────

const dec = (d, fn, rg) => V.decide({ direct: d, functional: fn, regression: rg });

t('direct pass + functional pass + no regression => fixed',
    dec({ pass: true }, { pass: true }, { pass: true }).outcome === V.OUTCOME.FIXED);

t('a genuine regression outranks a fix and advises rollback',
    (() => {
        const o = dec({ pass: true }, { pass: true }, { pass: false, regressions: [{ id: 'x' }] });
        return o.outcome === V.OUTCOME.REGRESSED && o.rollbackAdvised === true;
    })());

t('mechanism changed but the user\'s problem did not => partially-fixed, and re-diagnose',
    (() => {
        const o = dec({ pass: true }, { pass: false }, { pass: true });
        return o.outcome === V.OUTCOME.PARTIALLY_FIXED && o.rediagnose === true;
    })());

t('functional could not be evaluated => unverifiable, NEVER fixed',
    dec({ pass: true }, { pass: null }, { pass: true }).outcome === V.OUTCOME.UNVERIFIABLE);

t('nothing moved => not-fixed',
    dec({ pass: false }, { pass: false }, { pass: true }).outcome === V.OUTCOME.NOT_FIXED);

// ── the wording contract ────────────────────────────────────────────────────────────────

t('the unverifiable sentence never says «حل شد»',
    /نتوانستیم تأیید کنیم/.test(V.WORDING.unverifiable) && !/^حل شد/.test(V.WORDING.unverifiable));
t('partially-fixed tells the user another cause exists',
    /علت دیگری/.test(V.WORDING['partially-fixed']));
t('every outcome has a Persian sentence and none of them overclaims',
    Object.values(V.OUTCOME).every(o => typeof V.WORDING[o] === 'string' && /[؀-ۿ]/.test(V.WORDING[o])),
    JSON.stringify(Object.keys(V.WORDING)));
t('only the fixed outcome is allowed to say the problem is resolved',
    Object.entries(V.WORDING).filter(([, s]) => /برطرف شد/.test(s)).map(([k]) => k).join() === 'fixed',
    Object.entries(V.WORDING).filter(([, s]) => /برطرف شد/.test(s)).map(([k]) => k).join());

// ── direct, against the real diagnose engine ────────────────────────────────────────────

const hypo = {
    id: 'test.h', title: 'آزمایشی', layer: 1,
    necessary: [{ factId: IDS.PROXY_WININET_ENABLED, predicate: v => v === true }],
    decisive: [{ factId: IDS.PROXY_ENDPOINT_TCP_OK, predicate: v => v === false }],
    explains: ['symptom.nothing-opens'], causes: [], repairs: [], explain: () => ({}),
};
let d = V.direct(hypo, map([obs(IDS.PROXY_WININET_ENABLED, true), obs(IDS.PROXY_ENDPOINT_TCP_OK, false)]), D.diagnose);
t('direct: the hypothesis still holds against fresh facts => did not pass', d.pass === false, JSON.stringify(d));
d = V.direct(hypo, map([obs(IDS.PROXY_WININET_ENABLED, false), obs(IDS.PROXY_ENDPOINT_TCP_OK, true)]), D.diagnose);
t('direct: the hypothesis no longer holds => passed', d.pass === true, JSON.stringify(d));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
