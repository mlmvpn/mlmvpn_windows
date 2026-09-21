/*
 * The repair engine: tiers, the apply-time gate, the mutex, and what must never be emitted.
 *
 * PowerShell is replaced by a RECORDER — the same technique tests/aether uses for the kill
 * switch, and for the same reason: this code writes to the registry and starts services, so
 * it must never actually run during a test, and asserting on the exact scripts is only
 * possible because a recorder stands in for the real thing.
 *
 * The cases below are not "does the happy path work". They are the eight ways an apply can be
 * wrong: a machine that changed since the offer, ownership that turned out not to be foreign,
 * a listener that came back, a tier that escalated, a replayed token, a batch racing the rest
 * of the app, a rollback aimed at someone else's value, and a service somebody disabled on
 * purpose.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-repair-'));
process.env.USERPROFILE = SANDBOX;
process.env.ProgramData = SANDBOX;
os.homedir = () => SANDBOX;

const ROOT = path.resolve(__dirname, '..', '..');
const F = require(ROOT + '/netdiag/facts');
const S = require(ROOT + '/netdiag/session');
const O = require(ROOT + '/netdiag/ownership');
const R = require(ROOT + '/netdiag/repairs');
const mutex = require(ROOT + '/netdiag/mutex');
const journal = require(ROOT + '/netdiag/journal');
const { IDS } = require(ROOT + '/netdiag/rules/ids');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

/** Records every script instead of running it. Replies are queued per test. */
function recorder(replies) {
    const scripts = [];
    const queue = (replies || []).slice();
    return {
        scripts,
        parseJson: require(ROOT + '/netdiag/ps').parseJson,
        async run(script) {
            scripts.push(script);
            const next = queue.length ? queue.shift() : { ok: true, stdout: 'done' };
            return Object.assign({ ok: true, stdout: '', stderr: '', reason: null, ms: 1 }, next);
        },
        emitted(rx) { return scripts.some(s => rx.test(s)); },
        all() { return scripts.join('\n---\n'); },
    };
}

const facts = spec => {
    const out = {};
    for (const [id, v] of Object.entries(spec)) out[id] = F.observed(id, v, { quality: F.QUALITY.MEASURED });
    return out;
};

const DEAD_PROXY_FACTS = {
    [IDS.PROXY_WININET_ENABLED]: true,
    [IDS.PROXY_WININET_SERVER]: 'http=127.0.0.1:10809;https=127.0.0.1:10809',
    [IDS.PROXY_ENDPOINT_TCP_OK]: false,
    [IDS.PROXY_ENDPOINT_OWNERSHIP]: O.OWNERSHIP.FOREIGN,
};

function liveFor(over) {
    const o = over || {};
    return {
        generation: async () => (o.generation === undefined ? 0 : o.generation),
        facts: async () => facts(o.facts || DEAD_PROXY_FACTS),
        ownership: async () => (o.ownership === undefined ? O.OWNERSHIP.FOREIGN : o.ownership),
        enginesQuiet: async () => (o.enginesQuiet === undefined ? true : o.enginesQuiet),
    };
}

const sessionAt = gen => {
    const s = S.createSession({ mode: 'full' });
    s.generation.current = gen;
    return s;
};
const okToken = tier => ({ valid: true, tier });

(async () => {
    const proxy = R.byId.get('proxy.wininet.disable');
    const flush = R.byId.get('dns.flush');
    const bfe = R.byId.get('svc.start-bfe');
    const guard = R.byId.get('guard.restore-stale');

    // ── tier derivation ─────────────────────────────────────────────────────────────────
    t('a reversible, non-disruptive, non-exposing repair is auto',
        R.tierOf(flush, facts({})) === R.TIER.AUTO, R.tierOf(flush, facts({})));
    t('traffic-visible is NEVER auto, however cleanly it rolls back',
        proxy.reversible === true && R.tierOf(proxy, facts(DEAD_PROXY_FACTS)) === R.TIER.CONFIRM,
        R.tierOf(proxy, facts(DEAD_PROXY_FACTS)));
    t('...and the dialog can name the axis that forced it',
        /IP واقعی/.test(R.tierReason(proxy, facts(DEAD_PROXY_FACTS))), R.tierReason(proxy, facts(DEAD_PROXY_FACTS)));
    t('unproven ownership pushes a repair out of the auto tier',
        R.tierOf(proxy, facts(Object.assign({}, DEAD_PROXY_FACTS,
            { [IDS.PROXY_ENDPOINT_OWNERSHIP]: O.OWNERSHIP.UNKNOWN }))) !== R.TIER.AUTO);
    t('every registered repair declares all five risk axes',
        R.registry.every(r => typeof r.reversible === 'boolean' && typeof r.disruptive === 'boolean'
            && typeof r.requiresReboot === 'boolean' && r.blastRadius && r.exposure),
        JSON.stringify(R.registry.filter(r => !r.exposure).map(r => r.id)));
    t('every repair declares expectedChanges, or regression will fire on its own effect',
        R.registry.every(r => Array.isArray(r.expectedChanges)),
        JSON.stringify(R.registry.filter(r => !Array.isArray(r.expectedChanges)).map(r => r.id)));

    // ── the eight-step gate ─────────────────────────────────────────────────────────────
    let g = await R.gate(proxy, sessionAt(0), okToken(R.TIER.CONFIRM), liveFor({ generation: 1 }));
    t('gate: the machine changed since the offer => refused', !g.ok && g.step === 'generation', JSON.stringify(g));

    g = await R.gate(proxy, sessionAt(0), okToken(R.TIER.CONFIRM), liveFor({ ownership: O.OWNERSHIP.OURS_LIVE }));
    t('gate: a live tunnel owns the proxy => refused (this is the leak that must not happen)',
        !g.ok && g.step === 'ownership', JSON.stringify(g));
    g = await R.gate(proxy, sessionAt(0), okToken(R.TIER.CONFIRM), liveFor({ ownership: O.OWNERSHIP.UNKNOWN }));
    t('gate: ownership merely UNKNOWN => refused, never "probably fine"',
        !g.ok && g.step === 'ownership', JSON.stringify(g));
    g = await R.gate(proxy, sessionAt(0), okToken(R.TIER.CONFIRM), liveFor({ ownership: O.OWNERSHIP.OURS_ORPHANED }));
    t('gate: ours-orphaned is repaired through its owner, not by this repair',
        !g.ok && g.step === 'ownership');

    g = await R.gate(proxy, sessionAt(0), okToken(R.TIER.CONFIRM), liveFor({
        facts: Object.assign({}, DEAD_PROXY_FACTS, { [IDS.PROXY_ENDPOINT_TCP_OK]: true }),
    }));
    t('gate: a listener came back since the offer => the diagnosis is stale, refused',
        !g.ok && g.step === 'preconditions', JSON.stringify(g));

    g = await R.gate(proxy, sessionAt(0), okToken(R.TIER.CONFIRM), liveFor({ enginesQuiet: false }));
    t('gate: an engine is running or in transition => refused', !g.ok && g.step === 'engines');

    g = await R.gate(proxy, sessionAt(0), okToken(R.TIER.AUTO), liveFor({}));
    t('gate: a confirmation given for a lower tier does not cover an escalated one',
        !g.ok && g.step === 'tier', JSON.stringify(g));

    g = await R.gate(proxy, sessionAt(0), { valid: false, tier: R.TIER.CONFIRM, reason: 'replayed' }, liveFor({}));
    t('gate: an invalid or replayed token => refused', !g.ok && g.step === 'token');

    g = await R.gate(proxy, sessionAt(0), okToken(R.TIER.CONFIRM), liveFor({}));
    t('gate: everything fresh and proven => allowed', g.ok === true, JSON.stringify(g));

    // ── apply, journal, and the exact scripts ───────────────────────────────────────────
    journal.clear();
    let rec = recorder([
        { ok: true, stdout: '{"enable":1,"server":"http=127.0.0.1:10809","pac":null,"bypass":null}' },
        { ok: true, stdout: 'done' },
    ]);
    const sess = sessionAt(0);
    let res = await R.apply(proxy, sess, okToken(R.TIER.CONFIRM), liveFor({}), { ps: rec });
    t('apply: succeeded', res.ok === true, JSON.stringify(res));
    t('apply: wrote ProxyEnable=0 and nothing else in that key',
        rec.emitted(/Set-ItemProperty[^\n]*ProxyEnable[^\n]*-Value 0/), rec.all().slice(0, 200));
    // Reading it during capture is required; WRITING it is the other repair's job. The
    // assertion has to distinguish the two, or it forbids the pre-state capture that makes
    // rollback exact.
    t('apply: never WRITES AutoConfigURL — a dead PAC is a different repair with its own scope',
        !rec.emitted(/(Set|Remove)-ItemProperty[^\n]*AutoConfigURL/), rec.all().slice(0, 200));
    t('apply: NEVER touched WinHTTP — that is not the browser\'s path',
        !rec.emitted(/netsh winhttp|WinHttpSettings/i));
    t('apply: did not delete ProxyServer, so rollback can be byte-exact',
        !rec.emitted(/Remove-ItemProperty[^\n]*ProxyServer/));
    // An earlier version of this matched /TEMP/i, which fires inside "Get-ItemProperty" — a
    // false failure from an assertion that was cheaper to write than to read.
    t('apply: refreshed WinINET without planting a script at a fixed temp path',
        rec.emitted(/InternetSetOption/) && !rec.emitted(/\$env:TEMP|%TEMP%|refresh_proxy\.ps1/i),
        rec.all().slice(0, 200));
    t('apply: captured the full pre-state including values it will not change',
        res.pre && res.pre.proxyEnable === 1 && 'autoConfigUrl' in res.pre && 'proxyOverride' in res.pre,
        JSON.stringify(res.pre));

    // The journal must not outlive a repair that reached a decision. Leaving an `applied`
    // entry on disk means startup recovery — whose table says "applied and still present ⇒
    // restore the pre-state" — undoes a repair that worked, at the next launch, silently.
    // Independent validation caught exactly this after a successful dns.flush.
    t('a successful repair resolves its journal entry',
        journal.load().length === 0, JSON.stringify(journal.load().map(e => `${e.repairId}:${e.phase}`)));

    journal.clear();
    const recHold = recorder([
        { ok: true, stdout: '{"enable":1,"server":"x","pac":null,"bypass":null}' },
        { ok: true, stdout: 'done' },
    ]);
    const held = await R.apply(proxy, sessionAt(0), okToken(R.TIER.CONFIRM), liveFor({}),
        { ps: recHold, holdForVerification: true });
    t('...unless the caller explicitly holds it open for verification',
        held.ok && held.journalHeld === true && journal.load().length === 1,
        JSON.stringify(journal.load().map(e => `${e.repairId}:${e.phase}`)));
    journal.clear();

    // ── rollback ────────────────────────────────────────────────────────────────────────
    rec = recorder([{ ok: true, stdout: '0' }, { ok: true, stdout: 'done' }]);
    let rb = await proxy.rollback({ proxyEnable: 1 }, { ps: rec });
    t('rollback: restores ProxyEnable to what it was', rb.ok && rec.emitted(/ProxyEnable[^\n]*-Value 1/), rec.all().slice(0, 160));

    rec = recorder([{ ok: true, stdout: '1' }]);
    rb = await proxy.rollback({ proxyEnable: 1 }, { ps: rec });
    t('rollback: refuses when the current value is not the one we wrote (someone else changed it)',
        rb.ok === false && /rollback-impossible/.test(rb.reason), JSON.stringify(rb));

    // ── the disabled-service rule ───────────────────────────────────────────────────────
    rec = recorder([]);
    const disabled = await bfe.apply({ facts: facts({}), pre: { status: 'Stopped', startType: 'Disabled' }, deps: { ps: rec } });
    t('a Disabled service is reported, not silently re-enabled',
        disabled.ok === false && /Disabled/.test(disabled.reason), JSON.stringify(disabled));
    t('...and no Set-Service / StartType change was emitted',
        !rec.emitted(/Set-Service|StartupType|StartType/i), rec.all());

    rec = recorder([{ ok: true, stdout: 'done' }]);
    await bfe.apply({ facts: facts({}), pre: { status: 'Stopped', startType: 'Manual' }, deps: { ps: rec } });
    t('starting a service names it literally from the compiled-in whitelist',
        rec.emitted(/Start-Service -Name 'BFE'/), rec.all());
    t('no repair anywhere emits taskkill /IM',
        !JSON.stringify(R.registry.map(String)).includes('taskkill'));

    // ── the guard repair must never become a blanket firewall reset ─────────────────────
    // Comments stripped first: the file's header explains at length why the blanket firewall
    // repair does not exist, and naming it there must not read as using it.
    const guardSrc = fs.readFileSync(ROOT + '/netdiag/repairs/guard-restore-stale.js', 'utf8');
    const guardCode = guardSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    t('guard.restore-stale never emits a DefaultOutboundAction change of its own',
        !/Set-NetFirewallProfile|DefaultOutboundAction/.test(guardCode),
        guardCode.slice(0, 200));
    t('...it delegates to the guard\'s own restoreIfStale',
        /restoreIfStale/.test(guardSrc));
    t('no repair in the registry is a blanket firewall allow',
        !R.registry.some(r => /firewall.*allow|allow-out/i.test(r.id)));
    let gp = guard.preconditions(facts({
        [IDS.FW_OUTBOUND_BLOCK]: true, [IDS.APP_GUARD_STATE]: O.OWNERSHIP.OURS_LIVE,
    }));
    t('guard repair refuses while the protection is live and deliberate', gp.ok === false, JSON.stringify(gp));
    gp = guard.preconditions(facts({
        [IDS.FW_OUTBOUND_BLOCK]: true, [IDS.APP_GUARD_STATE]: O.OWNERSHIP.UNKNOWN,
    }));
    t('guard repair refuses when it cannot prove the block is ours', gp.ok === false, JSON.stringify(gp));

    // ── the batch and the shared mutex ──────────────────────────────────────────────────
    journal.clear();
    const release = await mutex.acquire('auto-connect');       // the rest of the app is busy
    const batch = await R.applyAuto([flush], sessionAt(0), { 'dns.flush': okToken(R.TIER.AUTO) },
        liveFor({ facts: { [IDS.SVC_DNSCACHE_RUNNING]: true } }), { ps: recorder([]) });
    t('the batch refuses while another part of the app holds the network lock',
        batch.ok === false && /عملیات شبکه/.test(batch.reason), JSON.stringify(batch));
    t('...and names who holds it', batch.heldBy === 'auto-connect');
    release();

    const rec2 = recorder([{ ok: true, stdout: 'done' }]);
    const batch2 = await R.applyAuto([flush], sessionAt(0), { 'dns.flush': okToken(R.TIER.AUTO) },
        liveFor({ facts: { [IDS.SVC_DNSCACHE_RUNNING]: true } }), { ps: rec2 });
    t('once the lock is free the batch runs', batch2.ok === true, JSON.stringify(batch2));
    t('the lock is released afterwards, even though a repair ran', mutex.status().held === false);

    // A failing repair must stop the batch rather than marching on through the rest.
    const failing = Object.assign({}, flush, {
        id: 'dns.flush', apply: async () => ({ ok: false, reason: 'simulated failure' }),
    });
    journal.clear();
    const batch3 = await R.applyAuto([failing, flush], sessionAt(0),
        { 'dns.flush': okToken(R.TIER.AUTO) },
        liveFor({ facts: { [IDS.SVC_DNSCACHE_RUNNING]: true } }), { ps: recorder([]) });
    t('the batch aborts at the first failure instead of continuing',
        batch3.ok === false && batch3.outcomes.length === 1, JSON.stringify(batch3.outcomes.map(o => o.repairId)));

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    process.exit(failed ? 1 : 0);
})();
