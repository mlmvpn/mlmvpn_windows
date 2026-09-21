/*
 * The session store: generations, the one timing budget, immutability, and redaction.
 *
 * USERPROFILE is redirected to a sandbox BEFORE netdiag/session is required, exactly as
 * tests/aether does, so nothing here can read or write the real ~/.mlmvpn.
 *
 * The generation cases are the important ones. A full run lasts up to 35 seconds and this app
 * mutates the network itself — auto-connect can bring a tunnel up halfway through. Without a
 * generation boundary, facts collected before and after that moment get correlated into a
 * verdict about a machine that never existed, and the repair that follows is applied to the
 * live tunnel.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-session-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
os.homedir = () => SANDBOX;                 // os.homedir() prefers USERPROFILE, but be explicit

const ROOT = path.resolve(__dirname, '..', '..');
const S = require(ROOT + '/netdiag/session');
const F = require(ROOT + '/netdiag/facts');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };

// ── identity and budget ─────────────────────────────────────────────────────────────────

const s = S.createSession({ mode: 'full' });
t('sessionId is 128 bits of randomness, not a timestamp (a predictable id is addressable)',
    /^[0-9a-f]{32}$/.test(s.sessionId) && !/^nd-/.test(s.sessionId), s.sessionId);
t('two sessions do not collide', S.createSession().sessionId !== S.createSession().sessionId);

t('full mode has ONE total budget of 35s', s.budgetMs === 35000);
t('quick mode has ONE total budget of 8s', S.createSession({ mode: 'quick' }).budgetMs === 8000);
t('the sub-budgets fit inside the total, with the reserve intact',
    s.subBudgetMs.collect + s.subBudgetMs.discriminate + s.subBudgetMs.diagnose + s.subBudgetMs.reserve
    === s.budgetMs, JSON.stringify(s.subBudgetMs));

// The discriminator round lives INSIDE the total — v3.1 §3 chose option (A) precisely so the
// user-visible number cannot become "35s that is sometimes 43s".
const fresh = S.createSession({ mode: 'full', startedAtMono: S.monoNow() });
const dEarly = S.discriminatorBudget(fresh, fresh.startedAtMono + 1000);
t('discriminator: eligible early in the run, and bounded by its sub-budget',
    dEarly.eligible && dEarly.ms === 5000, JSON.stringify(dEarly));
const dLate = S.discriminatorBudget(fresh, fresh.startedAtMono + 30000);
t('discriminator: NOT eligible when under 8s of the total remains',
    dLate.eligible === false && /remained/.test(dLate.reason), JSON.stringify(dLate));
t('discriminator: the eligibility threshold is DERIVED from the sub-budget plus the tail reserve, so the two cannot drift apart',
    S.DISCRIMINATOR_MIN_REMAINING_MS === S.SUB_BUDGET_MS.full.discriminate + S.DISCRIMINATOR_TAIL_RESERVE_MS,
    String(S.DISCRIMINATOR_MIN_REMAINING_MS));
// The invariant that actually matters: whenever the round runs, its budget plus the tail
// still fit inside what is left of the ONE total. Swept across the whole run rather than
// asserted at one hand-picked instant.
let budgetViolation = null;
for (let at = 0; at <= 35000; at += 250) {
    const d = S.discriminatorBudget(fresh, fresh.startedAtMono + at);
    const left = S.remainingMs(fresh, fresh.startedAtMono + at);
    if (d.eligible && d.ms + S.DISCRIMINATOR_TAIL_RESERVE_MS > left) budgetViolation = { at, d, left };
    if (d.eligible && d.ms > S.SUB_BUDGET_MS.full.discriminate) budgetViolation = { at, d, left };
}
t('discriminator: at every instant of the run, an eligible round plus the tail reserve fits in what remains',
    budgetViolation === null, JSON.stringify(budgetViolation));
t('discriminator: never runs in quick mode',
    S.discriminatorBudget(S.createSession({ mode: 'quick' }), S.monoNow()).eligible === false);
t('remainingMs never goes negative past the deadline',
    S.remainingMs(fresh, fresh.startedAtMono + 99999) === 0);

// ── monotonic clock ─────────────────────────────────────────────────────────────────────
//
// Clock skew is one of the diagnoses and W32Time may sync mid-run, so a Date.now() delta is
// not a duration. This is the reason the whole engine measures with hrtime.

const m1 = S.monoNow();
const m2 = S.monoNow();
t('monoNow() is monotonic and independent of the wall clock', m2 >= m1 && typeof m1 === 'number');

// ── facts are immutable and generation-stamped ──────────────────────────────────────────

S.putFact(s, F.observed('route.default.count', 1));
t('a recorded fact is stamped with the current generation', s.facts['route.default.count'].gen === 0);
t('recording the same fact twice throws — a second observation belongs in a second map',
    throws(() => S.putFact(s, F.observed('route.default.count', 2))));
t('a hand-built fact carrying a value while not observed is refused',
    throws(() => S.putFact(s, Object.assign(F.unknown('fw.outbound.action', 'denied'), { value: false }))));

// ── the fingerprint and generation advance ──────────────────────────────────────────────

const base = {
    interfaces: ['{aaa}|up', '{bbb}|up'],
    addresses: ['v4|192.168.1.153|24|Preferred'],
    defaultRoutes: ['v4|0.0.0.0/0|192.168.1.1|{aaa}|50'],
    dnsServers: ['{aaa}|v4|192.168.1.1'],
    proxy: 'disabled',
    engines: ['aether|false', 'xray|false'],
};
const fpA = S.fingerprint(base);
const fpSame = S.fingerprint(JSON.parse(JSON.stringify(base)));
t('fingerprint is stable for identical input', fpA.hash === fpSame.hash);

const reordered = Object.assign({}, base, { interfaces: ['{bbb}|up', '{aaa}|up'] });
t('fingerprint ignores ordering — enumeration order is not a network change',
    S.fingerprint(reordered).hash === fpA.hash);

// The exact mid-run scenario: the tunnel comes up.
const vpnUp = Object.assign({}, base, {
    dnsServers: ['{aaa}|v4|127.0.0.1'],
    engines: ['aether|true', 'xray|false'],
    defaultRoutes: ['v4|0.0.0.0/0|10.0.0.1|{ccc}|5'],
});
const fpB = S.fingerprint(vpnUp);
t('fingerprint changes when the VPN comes up mid-run', fpB.hash !== fpA.hash);

const g = S.createSession({ mode: 'full' });
S.sampleGeneration(g, fpA, 'w0');
S.putFact(g, F.observed('dns.config.loopback', false));
const adv = S.sampleGeneration(g, fpB, 'after-w2');
t('a changed fingerprint advances the generation', adv.gen === 1 && adv.changed === true);
t('the session is marked unstable, and WHICH keys changed is recorded as evidence',
    g.generation.unstable === true
    && adv.changedKeys.includes('dnsServers') && adv.changedKeys.includes('engines'),
    JSON.stringify(adv.changedKeys));
S.putFact(g, F.observed('dns.config.servers', ['127.0.0.1']));
t('facts recorded after the change carry the new generation',
    g.facts['dns.config.servers'].gen === 1 && g.facts['dns.config.loopback'].gen === 0);

t('mayConfirm(): REFUSED for evidence spanning generations — this is the live-tunnel case',
    S.mayConfirm(g, ['dns.config.loopback', 'dns.config.servers']) === false);
t('mayConfirm(): allowed within one generation',
    S.mayConfirm(g, ['dns.config.servers']) === true);

const unread = S.fingerprint({});
t('an unreadable fingerprint yields the literal "unknown" for every key, never a short hash',
    unread.keys.interfaces === 'unknown' && unread.keys.proxy === 'unknown');
S.markUnstable(g, 'fingerprint unreadable twice');
t('markUnstable() is recorded as an event, so the report can explain the downgrade',
    g.generation.unstable && g.events.some(e => e.type === 'generation-unstable'));

// ── redaction ───────────────────────────────────────────────────────────────────────────

const r = S.createSession({ mode: 'full' });
r.app = {
    engineUuid: '11111111-2222-3333-4444-555555555555',
    password: 'hunter2',
    pac: 'http://alice:s3cret@proxy.corp.local/proxy.pac',
    interfaceGuid: '{2A1B9E44-0000-4000-8000-ABCDEF012345}',
    localIp: '192.168.1.153',
    adapter: 'Wi-Fi 3',
};
const red = S.redact(r);
t('redaction: a password key is replaced', red.app.password === '[redacted]');
t('redaction: a bare config UUID is replaced', /redacted-uuid/.test(red.app.engineUuid));
t('redaction: credentials inside a PAC URL are replaced, the host is kept',
    /\[redacted\]:\[redacted\]@proxy\.corp\.local/.test(red.app.pac), red.app.pac);
t('redaction: a braced interface GUID SURVIVES — it is diagnostic identity, not a secret',
    red.app.interfaceGuid === r.app.interfaceGuid);
t('redaction: local IPs and adapter names survive — they are the diagnostic content',
    red.app.localIp === '192.168.1.153' && red.app.adapter === 'Wi-Fi 3');
t('redaction does not mutate the live session',
    r.app.password === 'hunter2');

// ── persistence, inside the sandbox ─────────────────────────────────────────────────────

const w = S.persist(r);
t('persist() writes into the sandboxed home, not the real ~/.mlmvpn',
    w.ok && w.file.startsWith(SANDBOX), JSON.stringify(w));
const back = S.load(w.file);
t('a persisted session loads back', back && back.sessionId === r.sessionId);
t('the file on disk is the REDACTED copy', back && back.app.password === '[redacted]');

for (let i = 0; i < 14; i++) S.persist(S.createSession({ mode: 'quick' }));
t('only the last 10 sessions are kept', S.list().length <= 10, String(S.list().length));

t('load() returns null for garbage rather than throwing',
    (() => { const p = path.join(S.sessionDir(), 'session-bad.json'); fs.writeFileSync(p, 'not json'); return S.load(p) === null; })());

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* best effort */ }
process.exit(failed ? 1 : 0);
