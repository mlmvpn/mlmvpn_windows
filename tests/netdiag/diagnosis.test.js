/*
 * The reasoning engine. Hand-built fact sets in, expected narrative out.
 *
 * No network, no Windows, no PowerShell, no clock — every case here is a pure function call.
 * That is the whole reason collectors and rules were separated: a reasoning layer that can
 * only be exercised by breaking a real machine never gets exercised.
 *
 * The combination cases matter more than the isolated ones. Any tool can report "the proxy is
 * dead" when the proxy is the only thing wrong. What separates a diagnostic engine from a
 * probe runner is what it says when a dead proxy ALSO makes DNS time out and HTTP fail — and
 * whether it can still say "I don't know" when the evidence does not reach.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const F = require(ROOT + '/netdiag/facts');
const D = require(ROOT + '/netdiag/diagnose');
const rules = require(ROOT + '/netdiag/rules');
const { IDS } = require(ROOT + '/netdiag/rules/ids');
const { OWNERSHIP } = require(ROOT + '/netdiag/ownership');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

/** Build a fact map. `undefined` means "not collected"; use unk() for "we looked and could not tell". */
function facts(spec) {
    const out = {};
    for (const [id, v] of Object.entries(spec)) {
        if (v && v.__unknown) out[id] = F.unknown(id, v.reason);
        else if (v && v.__gen !== undefined) out[id] = Object.assign(F.observed(id, v.value), { gen: v.__gen });
        else out[id] = F.observed(id, v);
    }
    return out;
}
const unk = reason => ({ __unknown: true, reason: reason || 'not observable' });
const atGen = (value, g) => ({ __gen: g, value });

const run = spec => D.diagnose(facts(spec), rules);
const ids = list => list.map(e => e.id);
const find = (r, id) => r.all.find(e => e.id === id);

// A machine where nothing is wrong, used as the base for single-fault scenarios.
const HEALTHY = {
    [IDS.REACH_GATEWAY_V4]: 'ok',
    [IDS.REACH_DOMESTIC_V4]: 'ok',
    [IDS.REACH_FOREIGN_V4]: 'ok',
    [IDS.SVC_BFE_RUNNING]: true,
    [IDS.SVC_DNSCACHE_RUNNING]: true,
    [IDS.FW_OUTBOUND_BLOCK]: false,
    [IDS.TIME_SKEW_SECONDS]: 2,
    [IDS.LINK_FLAPPING]: false,
    [IDS.CAPTIVE_DETECTED]: false,
    [IDS.WINSOCK_THIRDPARTY_COUNT]: 0,
    [IDS.DNS_HOSTS_ENTRIES]: 0,
    [IDS.DNS_RESOLVE_OK_V4]: true,
    [IDS.DNS_RESOLVER_UDP53_OK]: true,
    [IDS.DNS_RESOLVER_TCP53_OK]: true,
    [IDS.DNS_CONFIG_LOOPBACK]: false,
    [IDS.DNS_ANSWER_FORGED]: false,
    [IDS.DNS_ANSWER_NAMES_TESTED]: 8,
    [IDS.DNS_ANSWER_NAMES_FAILED]: 0,
    [IDS.PROXY_WININET_ENABLED]: false,
    [IDS.PROXY_HTTP_BYPASS_OK]: true,
    [IDS.PROXY_HTTP_VIA_OK]: true,
    [IDS.PROXY_WINHTTP_MODE]: 'direct',
    [IDS.PROXY_PAC_URL]: null,
    [IDS.PROXY_PAC_FETCHABLE]: true,
    [IDS.PROXY_ENDPOINT_OWNERSHIP]: OWNERSHIP.FOREIGN,
    [IDS.PROXY_ENDPOINT_TCP_OK]: true,
    [IDS.DNS_CONFIG_OWNERSHIP]: OWNERSHIP.FOREIGN,
    [IDS.APP_GUARD_STATE]: OWNERSHIP.FOREIGN,
    [IDS.APP_TUN_CARRIES_DATA]: false,
    [IDS.TLS_CERT_DATE_INVALID]: false,
    [IDS.APP_ENGINE_RUNNING]: false,
    [IDS.APP_TUN_VERDICT]: 'process-dead',
    [IDS.ROUTE_TABLE_READABLE]: true,
    [IDS.ROUTE_EGRESS_IS_TUN]: false,
    [IDS.TLS_TCP_OK]: true,
    [IDS.TLS_HANDSHAKE_OK]: true,
    [IDS.TLS_FAIL_HOSTS]: 0,
    [IDS.TLS_FAIL_CATEGORIES]: 0,
};
const scenario = over => Object.assign({}, HEALTHY, over);

// ── everything green ────────────────────────────────────────────────────────────────────

let r = run(HEALTHY);
t('healthy machine: no root cause, and nothing to repair',
    r.rootCauses.length === 0 && r.headline.kind === 'nothing-found',
    JSON.stringify({ h: r.headline, roots: ids(r.rootCauses), ind: ids(r.independent) }));

// ── the flagship case: a dead system proxy ──────────────────────────────────────────────

const DEAD_PROXY = scenario({
    [IDS.PROXY_WININET_ENABLED]: true,
    [IDS.PROXY_WININET_SERVER]: 'http=127.0.0.1:10809;https=127.0.0.1:10809',
    [IDS.PROXY_ENDPOINT_TCP_OK]: false,
    [IDS.PROXY_ENDPOINT_OWNERSHIP]: OWNERSHIP.FOREIGN,
    [IDS.PROXY_HTTP_VIA_OK]: false,
    [IDS.PROXY_HTTP_BYPASS_OK]: true,
});
r = run(DEAD_PROXY);
t('dead proxy: confirmed, and it is the single root cause',
    r.headline.kind === 'single-root' && r.headline.id === 'proxy.dead-listener'
    && find(r, 'proxy.dead-listener').verdict === D.VERDICT.CONFIRMED,
    JSON.stringify({ h: r.headline, roots: ids(r.rootCauses) }));
t('dead proxy: the repair offered is the scoped WinINET one, not a generic "disable proxy"',
    find(r, 'proxy.dead-listener').repairs.join() === 'proxy.wininet.disable');

// The consequence-satisfies-a-decisive-gate case. This is why causal reduction must run over
// confirmed hypotheses, not only over the scored ones.
const DEAD_PROXY_WITH_FALLOUT = Object.assign({}, DEAD_PROXY, {
    [IDS.DNS_RESOLVER_UDP53_OK]: false,
    [IDS.DNS_RESOLVER_TCP53_OK]: false,
    [IDS.DNS_RESOLVE_OK_V4]: false,
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
});
r = run(DEAD_PROXY_WITH_FALLOUT);
t('dead proxy + DNS timeouts + HTTP failure: still EXACTLY ONE root cause',
    r.rootCauses.length === 1 && r.rootCauses[0].id === 'proxy.dead-listener',
    JSON.stringify({ roots: ids(r.rootCauses), cons: ids(r.consequences) }));
t('...and the DNS finding is demoted to a consequence even though its own gate was decisive',
    find(r, 'dns.resolver-unreachable').verdict === D.VERDICT.CONFIRMED
    && find(r, 'dns.resolver-unreachable').consequenceOf === 'proxy.dead-listener',
    JSON.stringify(find(r, 'dns.resolver-unreachable')));
t('...so no DNS repair is offered for a proxy problem',
    r.rootCauses.every(e => !e.repairs.some(x => x.startsWith('dns.'))));

// ── ownership: the same firewall Block, two opposite meanings ───────────────────────────

r = run(scenario({
    [IDS.FW_OUTBOUND_BLOCK]: true,
    [IDS.APP_GUARD_STATE]: OWNERSHIP.OURS_LIVE,
    [IDS.APP_ENGINE_RUNNING]: true,
}));
t('kill switch with a LIVE owner: by-design, zero repairs, never a root cause',
    r.rootCauses.length === 0
    && find(r, 'vpn.protection-active').ownership === 'by-design'
    && find(r, 'vpn.stale-protection').verdict === D.VERDICT.ELIMINATED,
    JSON.stringify({ roots: ids(r.rootCauses), byDesign: ids(r.byDesign) }));

r = run(scenario({
    [IDS.FW_OUTBOUND_BLOCK]: true,
    [IDS.APP_GUARD_STATE]: OWNERSHIP.OURS_ORPHANED,
    [IDS.APP_ENGINE_RUNNING]: false,
}));
t('the SAME Block with an orphaned owner: root cause vpn.stale-protection',
    r.headline.id === 'vpn.stale-protection' && find(r, 'vpn.stale-protection').verdict === D.VERDICT.CONFIRMED,
    JSON.stringify(r.headline));
t('...repaired through the guard\'s own recovery path, never a blanket firewall Allow',
    find(r, 'vpn.stale-protection').repairs.join() === 'guard.restore-stale');

r = run(scenario({
    [IDS.FW_OUTBOUND_BLOCK]: true,
    [IDS.APP_GUARD_STATE]: OWNERSHIP.UNKNOWN,
}));
t('a Block whose ownership is UNKNOWN is never confirmed as a fault and offers no repair',
    find(r, 'vpn.stale-protection').verdict !== D.VERDICT.CONFIRMED
    && !ids(r.rootCauses).includes('vpn.stale-protection'),
    JSON.stringify(find(r, 'vpn.stale-protection')));

// ── tunnel up, no data ──────────────────────────────────────────────────────────────────

r = run(scenario({
    [IDS.APP_TUN_VERDICT]: 'healthy',
    [IDS.APP_TUN_CARRIES_DATA]: false,
    [IDS.APP_ENGINE_RUNNING]: true,
}));
t('tunnel healthy but carrying no data: confirmed root',
    r.headline.id === 'vpn.tunnel-no-data', JSON.stringify(r.headline));
t('...and the reported-vs-measured contradiction is named, not hidden',
    find(r, 'vpn.tunnel-no-data').conflicts.some(c => c.kind === 'contradiction'),
    JSON.stringify(find(r, 'vpn.tunnel-no-data').conflicts));

// ── the clock, which must pre-empt any interference claim ───────────────────────────────

const SKEW = scenario({
    [IDS.TIME_SKEW_SECONDS]: 3 * 24 * 3600,
    [IDS.TLS_TCP_OK]: true,
    [IDS.TLS_HANDSHAKE_OK]: false,
    [IDS.TLS_CERT_DATE_INVALID]: true,
    [IDS.TLS_FAIL_HOSTS]: 4,
    [IDS.TLS_FAIL_CATEGORIES]: 2,
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
});
r = run(SKEW);
t('clock three days out: root cause is the clock',
    r.rootCauses.some(e => e.id === 'time.skew' && e.verdict === D.VERDICT.CONFIRMED),
    JSON.stringify(ids(r.rootCauses)));
t('...and interference is ELIMINATED, not reported alongside it',
    find(r, 'tls.interference-suspected').verdict === D.VERDICT.ELIMINATED,
    JSON.stringify(find(r, 'tls.interference-suspected')));
t('...no rule anywhere claims to have detected DPI',
    !JSON.stringify(rules).match(/DPI/i));

// With the clock ruled out and several hosts affected, the label is "suspected", never proven.
r = run(scenario({
    [IDS.TLS_TCP_OK]: true, [IDS.TLS_HANDSHAKE_OK]: false, [IDS.TLS_FAIL_HOSTS]: 3, [IDS.TLS_FAIL_CATEGORIES]: 2,
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
}));
t('clock fine + several hosts failing at the handshake: interference SUSPECTED, and the title says so',
    ids(r.rootCauses).includes('tls.interference-suspected')
    && /احتمال/.test(find(r, 'tls.interference-suspected').title));
r = run(scenario({
    [IDS.TLS_TCP_OK]: true, [IDS.TLS_HANDSHAKE_OK]: false, [IDS.TLS_FAIL_HOSTS]: 1, [IDS.TLS_FAIL_CATEGORIES]: 1,
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
}));
t('one host failing is a destination problem, not a path problem — interference eliminated',
    find(r, 'tls.interference-suspected').verdict === D.VERDICT.ELIMINATED);


// The exact false root cause independent validation caught on the development machine: both
// public DNS resolvers had their TLS handshakes reset (real, reproducible) while every
// ordinary web destination completed TLS and every page in the browser opened.
r = run(scenario({
    [IDS.TLS_TCP_OK]: true,
    [IDS.TLS_HANDSHAKE_OK]: false,
    [IDS.TLS_FAIL_HOSTS]: 2,
    [IDS.TLS_FAIL_CATEGORIES]: 1,      // both failures were resolver endpoints
}));
t('two resolver endpoints reset while ordinary web destinations work: NOT interference',
    find(r, 'tls.interference-suspected').verdict === D.VERDICT.ELIMINATED
    && !ids(r.rootCauses).includes('tls.interference-suspected'),
    JSON.stringify(find(r, 'tls.interference-suspected')));
t('...and the machine is not handed a root cause it does not have',
    r.rootCauses.length === 0, JSON.stringify(ids(r.rootCauses)));

// ── the healthy machine on a filtered line ──────────────────────────────────────────────

const INTERNATIONAL_ONLY = scenario({
    [IDS.REACH_GATEWAY_V4]: 'ok',
    [IDS.REACH_DOMESTIC_V4]: 'ok',
    [IDS.REACH_FOREIGN_V4]: 'fail',
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
});
r = run(INTERNATIONAL_ONLY);
t('gateway ok + domestic ok + all foreign groups failing => international-only, confirmed',
    ids(r.rootCauses).includes('scope.international-only')
    && find(r, 'scope.international-only').verdict === D.VERDICT.CONFIRMED,
    JSON.stringify(ids(r.rootCauses)));
t('...and ZERO repairs are offered anywhere — there is nothing wrong with this machine',
    r.rootCauses.every(e => e.repairs.length === 0),
    JSON.stringify(r.rootCauses.map(e => [e.id, e.repairs])));
t('...the downstream symptoms collapse into it rather than standing as separate findings',
    find(r, 'http.all-fail').consequenceOf === 'scope.international-only'
    && find(r, 'link.no-transport').consequenceOf === 'scope.international-only',
    JSON.stringify({ http: find(r, 'http.all-fail').consequenceOf, link: find(r, 'link.no-transport').consequenceOf }));

// The same foreign failure WITHOUT the domestic evidence must not become a machine fault.
r = run(scenario({
    [IDS.REACH_GATEWAY_V4]: 'ok',
    [IDS.REACH_DOMESTIC_V4]: unk('both domestic anchors unreachable; the anchor set may be stale'),
    [IDS.REACH_FOREIGN_V4]: 'fail',
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
}));
t('domestic anchors unavailable: international-only is NOT claimed',
    find(r, 'scope.international-only').verdict !== D.VERDICT.CONFIRMED,
    JSON.stringify(find(r, 'scope.international-only')));
t('...and no local-stack root cause is fabricated in its place',
    !ids(r.rootCauses).some(id => /^(svc|route|link\.no)/.test(id)),
    JSON.stringify(ids(r.rootCauses)));

// ── BFE: one stopped service, one story ─────────────────────────────────────────────────

r = run(scenario({
    [IDS.SVC_BFE_RUNNING]: false,
    [IDS.REACH_GATEWAY_V4]: 'fail',
    [IDS.REACH_DOMESTIC_V4]: 'fail',
    [IDS.REACH_FOREIGN_V4]: 'fail',
    [IDS.DNS_RESOLVER_UDP53_OK]: false,
    [IDS.DNS_RESOLVER_TCP53_OK]: false,
    [IDS.DNS_RESOLVE_OK_V4]: false,
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
}));
t('BFE stopped: it is the root, and it is not misread as firewall policy',
    r.headline.id === 'svc.bfe-stopped' && r.rootCauses.length === 1,
    JSON.stringify({ h: r.headline, roots: ids(r.rootCauses) }));
t('...everything it caused is listed as a consequence, not as more problems',
    r.consequences.length >= 2 && r.rootCauses.length === 1, JSON.stringify({roots:ids(r.rootCauses),cons:ids(r.consequences)}));

// ── independent findings stay out of the headline ───────────────────────────────────────

r = run(Object.assign({}, DEAD_PROXY, {
    [IDS.DNS_HOSTS_ENTRIES]: 3,
    [IDS.WINSOCK_THIRDPARTY_COUNT]: 1,
}));
t('dead proxy + hosts entries + a third-party LSP: one root, two independent findings',
    r.rootCauses.length === 1 && r.rootCauses[0].id === 'proxy.dead-listener'
    && ids(r.independent).includes('dns.hosts-entry')
    && ids(r.independent).includes('winsock.thirdparty-lsp'),
    JSON.stringify({ roots: ids(r.rootCauses), ind: ids(r.independent) }));
t('a third-party LSP is never a root cause — presence is provable, blame is not',
    find(r, 'winsock.thirdparty-lsp').bucket === 'independent');

// ── two genuinely independent roots ─────────────────────────────────────────────────────

r = run(scenario({
    [IDS.SVC_DNSCACHE_RUNNING]: false,
    [IDS.CAPTIVE_DETECTED]: true,
    [IDS.CAPTIVE_LOCATION]: 'http://portal.example/login',
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
}));
t('two co-equal roots are BOTH reported, neither picked arbitrarily',
    r.headline.kind === 'multiple-roots' && r.headline.ids.length === 2
    && r.headline.ids.includes('svc.dnscache-stopped') && r.headline.ids.includes('captive.portal'),
    JSON.stringify(r.headline));

// ── refusing to guess ───────────────────────────────────────────────────────────────────

r = run({
    [IDS.ROUTE_TABLE_READABLE]: false,
    [IDS.REACH_GATEWAY_V4]: unk('could not read the routing table'),
    [IDS.REACH_DOMESTIC_V4]: unk('no route to test through'),
    [IDS.REACH_FOREIGN_V4]: unk('no route to test through'),
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
});
t('routing table unreadable: nothing is confirmed and no cause is fabricated',
    r.rootCauses.every(e => e.verdict !== D.VERDICT.CONFIRMED),
    JSON.stringify(ids(r.rootCauses)));
t('...the headline says undetermined and the missing evidence is named for the report',
    (r.headline.kind === 'undetermined' || r.headline.kind === 'nothing-found')
    && r.missingEvidence.length > 0,
    JSON.stringify({ h: r.headline, missing: r.missingEvidence.slice(0, 4) }));

// ── flapping is a diagnosis, not a hard failure ─────────────────────────────────────────

r = run(scenario({ [IDS.LINK_FLAPPING]: true, [IDS.PROXY_HTTP_BYPASS_OK]: false }));
t('probe retry disagreement becomes link.unstable rather than a hard outage',
    ids(r.rootCauses).includes('link.unstable'), JSON.stringify(ids(r.rootCauses)));

// ── generations: two machines cannot make one confirmed verdict ─────────────────────────

const SPLIT = {};
for (const [k, v] of Object.entries(DEAD_PROXY)) SPLIT[k] = atGen(v, 0);
SPLIT[IDS.PROXY_ENDPOINT_TCP_OK] = atGen(false, 1);      // observed AFTER the machine changed
r = run(SPLIT);
const dp = find(r, 'proxy.dead-listener');
t('evidence spanning two generations cannot be CONFIRMED, however decisive it looks',
    dp.verdict !== D.VERDICT.CONFIRMED && dp.caps.includes('generation-span'),
    JSON.stringify({ v: dp.verdict, caps: dp.caps, cappedFrom: dp.cappedFrom }));
t('...it is capped at "possible", not eliminated — the evidence is real, just not correlatable',
    dp.verdict === D.VERDICT.POSSIBLE);

// ── unknown never satisfies a gate ──────────────────────────────────────────────────────

r = run(scenario({
    [IDS.PROXY_WININET_ENABLED]: true,
    [IDS.PROXY_ENDPOINT_TCP_OK]: unk('could not probe the proxy port'),
    [IDS.PROXY_ENDPOINT_OWNERSHIP]: OWNERSHIP.FOREIGN,
    [IDS.PROXY_HTTP_VIA_OK]: unk('no result'),
}));
t('an unobservable decisive fact yields indeterminate, never a confirmed guess',
    find(r, 'proxy.dead-listener').verdict === D.VERDICT.INDETERMINATE,
    JSON.stringify(find(r, 'proxy.dead-listener')));
t('...and the specific missing fact is recorded so a discriminator can settle exactly it',
    find(r, 'proxy.dead-listener').indeterminateOn === IDS.PROXY_ENDPOINT_TCP_OK);
t('...and it appears in the report\'s missing-evidence list',
    r.missingEvidence.includes(IDS.PROXY_ENDPOINT_TCP_OK), JSON.stringify(r.missingEvidence));

// ── determinism ─────────────────────────────────────────────────────────────────────────

const a = JSON.stringify(run(DEAD_PROXY_WITH_FALLOUT).rootCauses.map(e => [e.id, e.verdict]));
const shuffled = Object.fromEntries(Object.entries(DEAD_PROXY_WITH_FALLOUT).reverse());
const b = JSON.stringify(D.diagnose(facts(shuffled), rules).rootCauses.map(e => [e.id, e.verdict]));
t('the outcome does not depend on fact insertion order (replay stability)', a === b, `${a}\n${b}`);
const c = JSON.stringify(D.diagnose(facts(DEAD_PROXY_WITH_FALLOUT), rules.slice().reverse())
    .rootCauses.map(e => [e.id, e.verdict]));
t('the outcome does not depend on rule registration order — ranking is by evidence, not position',
    a === c, `${a}\n${c}`);

// ── structural invariants over the whole rule set ───────────────────────────────────────

const { ALL_IDS } = require(ROOT + '/netdiag/rules/ids');
const referenced = new Set();
for (const h of rules) {
    for (const g of [].concat(h.necessary || [], h.decisive || [], h.supporting || [], h.refuting || [])) referenced.add(g.factId);
    if (h.byDesignWhen) referenced.add(h.byDesignWhen.factId);
    for (const cw of h.conflictWhen || []) { referenced.add(cw.a.factId); referenced.add(cw.b.factId); }
}
const strays = [...referenced].filter(id => !ALL_IDS.includes(id));
t('every fact id referenced by a rule exists in the id catalog (a typo would be a permanently UNKNOWN gate)',
    strays.length === 0, JSON.stringify(strays));
t('every referenced id is structurally valid',
    [...referenced].every(F.isValidId), JSON.stringify([...referenced].filter(x => !F.isValidId(x))));
t('every hypothesis has an id, a Persian title and an explain()',
    rules.every(h => h.id && h.title && typeof h.explain === 'function'
        && /[؀-ۿ]/.test(h.title)),
    JSON.stringify(rules.filter(h => !/[؀-ۿ]/.test(h.title || '')).map(h => h.id)));
t('every repair a rule offers is namespaced to its subsystem — no bare "proxy.disable" anywhere',
    rules.every(h => (h.repairs || []).every(x => x.includes('.') && x !== 'proxy.disable')),
    JSON.stringify(rules.flatMap(h => h.repairs || [])));
t('every causes target names a real hypothesis',
    (() => {
        const known = new Set(rules.map(h => h.id));
        const bad = rules.flatMap(h => (h.causes || []).filter(c => !known.has(c)));
        return bad.length === 0 || JSON.stringify(bad);
    })() === true,
    JSON.stringify(rules.flatMap(h => (h.causes || []).filter(c => !new Set(rules.map(x => x.id)).has(c)))));
t('diagnose.js does no I/O',
    !/require\(['"](child_process|fs|net|dns|http|https|tls)['"]\)/
        .test(require('fs').readFileSync(ROOT + '/netdiag/diagnose.js', 'utf8')));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
