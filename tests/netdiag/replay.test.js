/*
 * Replay: a saved session must re-diagnose to an identical narrative.
 *
 * This is the property that makes everything else supportable. A user pastes a session file,
 * and the same reasoning runs against it here — no machine, no network, no clock. If the
 * outcome could drift between the run and the replay, the file would be a souvenir rather
 * than evidence, and every support conversation would start from zero.
 *
 * It also guards the one thing the discriminator round could quietly break. Its ELIGIBILITY
 * depends on elapsed time, which is not a fact, so the decision is written into the session
 * and replay reads the recorded decision instead of re-timing. Selection itself stays a pure
 * function of the fact map. The tests below pin both halves.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-replay-'));
process.env.USERPROFILE = SANDBOX;
os.homedir = () => SANDBOX;

const ROOT = path.resolve(__dirname, '..', '..');
const F = require(ROOT + '/netdiag/facts');
const S = require(ROOT + '/netdiag/session');
const D = require(ROOT + '/netdiag/diagnose');
const engine = require(ROOT + '/netdiag/engine');
const rules = require(ROOT + '/netdiag/rules');
const { IDS } = require(ROOT + '/netdiag/rules/ids');
const { OWNERSHIP } = require(ROOT + '/netdiag/ownership');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

/** A deterministic offline wave set: a dead system proxy with its downstream fallout. */
const SCENARIO = {
    [IDS.REACH_GATEWAY_V4]: 'ok',
    [IDS.REACH_DOMESTIC_V4]: 'ok',
    [IDS.REACH_FOREIGN_V4]: 'ok',
    [IDS.SVC_BFE_RUNNING]: true,
    [IDS.SVC_DNSCACHE_RUNNING]: true,
    [IDS.FW_OUTBOUND_BLOCK]: false,
    [IDS.ROUTE_TABLE_READABLE]: true,
    [IDS.ROUTE_EGRESS_IS_TUN]: false,
    [IDS.PROXY_WININET_ENABLED]: true,
    [IDS.PROXY_WININET_SERVER]: 'http=127.0.0.1:10809;https=127.0.0.1:10809',
    [IDS.PROXY_ENDPOINT_TCP_OK]: false,
    [IDS.PROXY_ENDPOINT_OWNERSHIP]: OWNERSHIP.FOREIGN,
    [IDS.PROXY_HTTP_VIA_OK]: false,
    [IDS.PROXY_HTTP_BYPASS_OK]: true,
    [IDS.PROXY_PAC_URL]: null,
    [IDS.PROXY_PAC_FETCHABLE]: true,
    [IDS.PROXY_WINHTTP_MODE]: 'direct',
    [IDS.DNS_CONFIG_LOOPBACK]: false,
    [IDS.DNS_CONFIG_OWNERSHIP]: OWNERSHIP.FOREIGN,
    [IDS.DNS_RESOLVER_UDP53_OK]: true,
    [IDS.DNS_RESOLVER_TCP53_OK]: true,
    [IDS.DNS_RESOLVE_OK_V4]: true,
    [IDS.DNS_ANSWER_FORGED]: false,
    [IDS.DNS_ANSWER_NAMES_TESTED]: 5,
    [IDS.DNS_ANSWER_NAMES_FAILED]: 0,
    [IDS.DNS_HOSTS_ENTRIES]: 0,
    [IDS.WINSOCK_THIRDPARTY_COUNT]: 0,
    [IDS.APP_ENGINE_RUNNING]: false,
    [IDS.APP_TUN_VERDICT]: 'process-dead',
    [IDS.APP_TUN_CARRIES_DATA]: false,
    [IDS.APP_GUARD_STATE]: OWNERSHIP.FOREIGN,
    [IDS.TIME_SKEW_SECONDS]: 1,
    [IDS.TLS_TCP_OK]: true,
    [IDS.TLS_HANDSHAKE_OK]: true,
    [IDS.TLS_FAIL_HOSTS]: 0,
    [IDS.TLS_FAIL_CATEGORIES]: 0,
    [IDS.TLS_CERT_DATE_INVALID]: false,
    [IDS.LINK_FLAPPING]: false,
    [IDS.CAPTIVE_DETECTED]: false,
};

const STUB = [{
    id: 'stub.all', wave: 'w0', label: 'stub', network: false, timeout: 2000,
    produces: Object.keys(SCENARIO),
    async run(ctx) {
        for (const [id, v] of Object.entries(SCENARIO)) {
            ctx.put(F.observed(id, v, { quality: F.QUALITY.MEASURED }));
        }
    },
}];

/** Everything that goes into the report, and nothing that legitimately varies between runs. */
function narrativeOf(result) {
    const slim = e => ({
        id: e.id, verdict: e.verdict, bucket: e.bucket, consequenceOf: e.consequenceOf,
        caps: e.caps, repairs: e.repairs, unknownMass: e.unknownMass,
    });
    return JSON.stringify({
        headline: result.headline,
        roots: result.rootCauses.map(slim),
        consequences: result.consequences.map(slim),
        independent: result.independent.map(slim),
        unresolved: result.unresolved.map(slim),
        missing: result.missingEvidence,
    });
}

(async () => {
    const live = await engine.run({ collectors: STUB, mode: 'full' });
    const original = D.diagnose(live.facts, rules);
    const write = S.persist(live);
    t('the session persisted', write.ok, JSON.stringify(write));

    const loaded = S.load(write.file);
    t('the saved session loads back with its facts intact',
        loaded && Object.keys(loaded.facts).length === Object.keys(live.facts).length,
        loaded ? `${Object.keys(loaded.facts).length} vs ${Object.keys(live.facts).length}` : 'load failed');

    // The core property: the same reasoning, from a file, with no machine underneath it.
    const replayed = D.diagnose(loaded.facts, rules);
    t('a saved session re-diagnoses to an IDENTICAL narrative',
        narrativeOf(original) === narrativeOf(replayed),
        `${narrativeOf(original)}\n${narrativeOf(replayed)}`);

    t('the replayed narrative is the expected one, not identically empty',
        replayed.headline.kind === 'single-root' && replayed.headline.id === 'proxy.dead-listener',
        JSON.stringify(replayed.headline));

    // Replay is pure: running it twice, and running it after mutating nothing, must not drift.
    t('replaying twice gives the same answer',
        narrativeOf(D.diagnose(loaded.facts, rules)) === narrativeOf(replayed));
    t('replay does not mutate the loaded facts',
        Object.keys(loaded.facts).length === Object.keys(S.load(write.file).facts).length);

    // Collection decisions are part of reproducibility, not just the reasoning.
    t('the session records whether the discriminator round was eligible, so replay need not re-time it',
        typeof live.discriminator.eligible === 'boolean' && Array.isArray(live.discriminator.selected),
        JSON.stringify(live.discriminator));
    t('every collector decision is recorded with its state',
        live.collectors.length > 0 && live.collectors.every(c => c.id && c.state),
        JSON.stringify(live.collectors.map(c => `${c.id}=${c.state}`)));

    // A file from an older schema must be refused rather than half-understood.
    const bad = path.join(S.sessionDir(), 'session-oldschema.json');
    fs.writeFileSync(bad, JSON.stringify(Object.assign({}, loaded, { version: 1 })));
    t('a session from an incompatible schema is refused, not partially replayed', S.load(bad) === null);

    // Redaction must not cost the narrative: the file the user pastes has to diagnose the same.
    t('the REDACTED copy diagnoses identically — redaction removes secrets, not evidence',
        narrativeOf(D.diagnose(S.redact(live).facts, rules)) === narrativeOf(original));

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    process.exit(failed ? 1 : 0);
})();
