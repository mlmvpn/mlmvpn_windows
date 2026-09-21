/*
 * The fact model and its three-valued logic.
 *
 * This suite exists to pin one invariant, stated in the architecture as the Prime Directive:
 *
 *     Absence of evidence is never authority to act.
 *
 * Concretely: there must be no path — not a default parameter, not a catch block, not a
 * predicate that throws — by which "we could not observe this" turns into `false`. A rule
 * reading `false` will eliminate or confirm a hypothesis; a rule reading `unknown` must
 * abstain. Every wrong-root-cause failure mode this engine was designed against starts with
 * that one collapse.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const F = require(ROOT + '/netdiag/facts');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const throws = fn => { try { fn(); return false; } catch (e) { return true; } };

// ── construction refuses the dangerous shapes ───────────────────────────────────────────

t('observed() without a value throws (a collector must not report an observation it did not make)',
    throws(() => F.observed('route.default.exists', undefined)));
t('observed(false) is legal — observing absence is a real observation',
    F.observed('route.default.exists', false).value === false);
t('unknown() without a reason throws (the report has to name the missing evidence)',
    throws(() => F.unknown('route.default.exists')));
t('unknown() carries no value at all',
    F.unknown('route.default.exists', 'table unreadable').value === undefined);
t('skipped() records the predicate that decided it',
    F.skipped('mtu.ladder', 'no default route').skippedReason === 'no default route');
t('an unknown namespace is rejected', throws(() => F.observed('bogus.thing', 1)));
t('a malformed id is rejected', throws(() => F.observed('Route.Default', 1)));

// ── interface scoping ───────────────────────────────────────────────────────────────────
//
// Keyed on InterfaceGuid because Windows reuses InterfaceIndex and users rename aliases. A
// repair that captured "index 33" and rolls back onto whatever is index 33 later is a repair
// applied to the wrong NIC.

const GUID = '{2A1B9E44-0000-4000-8000-ABCDEF012345}';
const scoped = F.ifScoped('dns.config.servers', GUID);
t('ifScoped() produces a parseable, lower-cased key',
    F.parseId(scoped).base === 'dns.config.servers'
    && F.parseId(scoped).interfaceGuid === GUID.toLowerCase(), scoped);
t('ifScoped() without a guid throws', throws(() => F.ifScoped('dns.config.servers', null)));
t('a scoped id still validates and keeps its namespace',
    F.isValidId(scoped) && F.namespaceOf(scoped) === 'dns');
t('a scoped fact defaults to interface scope', F.observed(scoped, ['1.1.1.1']).scope === F.SCOPE.INTERFACE);

// ── three-valued logic ──────────────────────────────────────────────────────────────────

const { TRUE, FALSE, UNKNOWN } = F;
t('and3: one FALSE settles it even with unknowns present', F.and3(TRUE, UNKNOWN, FALSE) === FALSE);
t('and3: an UNKNOWN with no FALSE propagates', F.and3(TRUE, UNKNOWN) === UNKNOWN);
t('or3: one TRUE settles it even with unknowns present', F.or3(FALSE, UNKNOWN, TRUE) === TRUE);
t('or3: an UNKNOWN with no TRUE propagates', F.or3(FALSE, UNKNOWN) === UNKNOWN);
t('not3(UNKNOWN) stays UNKNOWN — negation cannot manufacture knowledge', F.not3(UNKNOWN) === UNKNOWN);
t('isTrue(UNKNOWN) is false — a gate is never satisfied by an unknown', F.isTrue(UNKNOWN) === false);
t('isFalse(UNKNOWN) is false — a hypothesis is never refuted by an unknown', F.isFalse(UNKNOWN) === false);
t('and3() with no arguments is UNKNOWN, not vacuously true', F.and3() === UNKNOWN);

// ── reading a fact map ──────────────────────────────────────────────────────────────────

const facts = {};
const put = f => { facts[f.id] = f; return f; };
put(F.observed('route.default.count', 1, { quality: F.QUALITY.REPORTED }));
put(F.unknown('fw.outbound.action', 'Get-NetFirewallProfile denied by policy'));
put(F.errored('winsock.providers', 'netsh exited 1'));
put(F.skipped('mtu.ladder', 'no default route'));

t('test(): an observed fact evaluates normally',
    F.test(facts, 'route.default.count', v => v === 1) === TRUE);
t('test(): a MISSING fact is UNKNOWN, never FALSE',
    F.test(facts, 'route.default.gateway', v => v === '1.2.3.4') === UNKNOWN);
t('test(): an UNKNOWN fact is UNKNOWN — "could not read the firewall" is not "no block"',
    F.test(facts, 'fw.outbound.action', v => v === 'Block') === UNKNOWN);
t('test(): an ERROR fact is UNKNOWN, not an absence of providers',
    F.test(facts, 'winsock.providers', v => v.length > 0) === UNKNOWN);
t('test(): a SKIPPED fact is UNKNOWN — "not measured" is not "measured false"',
    F.test(facts, 'mtu.ladder', v => v === true) === UNKNOWN);
t('test(): a THROWING predicate yields UNKNOWN rather than crashing the diagnosis',
    F.test(facts, 'route.default.count', () => { throw new Error('boom'); }) === UNKNOWN);
t('test(): a predicate may itself abstain by returning neither true nor false',
    F.test(facts, 'route.default.count', () => null) === UNKNOWN);

t('valueOf(): returns undefined for a non-observed fact and takes no default argument',
    F.valueOf(facts, 'fw.outbound.action') === undefined && F.valueOf.length === 2);
t('isObserved(): false for unknown/error/skipped/missing',
    !F.isObserved(facts, 'fw.outbound.action') && !F.isObserved(facts, 'winsock.providers')
    && !F.isObserved(facts, 'mtu.ladder') && !F.isObserved(facts, 'nope.nope'));

// ── unknownMass ─────────────────────────────────────────────────────────────────────────

t('unknownMass(): counts every non-observed id',
    F.unknownMass(facts, ['route.default.count', 'fw.outbound.action', 'winsock.providers', 'mtu.ladder']) === 0.75);
t('unknownMass(): all observed is 0', F.unknownMass(facts, ['route.default.count']) === 0);
t('unknownMass(): an empty gate list is 0, not NaN', F.unknownMass(facts, []) === 0);

// ── generations ─────────────────────────────────────────────────────────────────────────
//
// The VPN coming up mid-run is the case this guards. W0 sees "no engine, DHCP DNS"; W3 sees
// loopback DNS; together they look like a decisive stranded-loopback finding whose repair
// tears DNS away from a live tunnel. Evidence from two generations describes two machines.

const gf = {};
gf['a'] = Object.assign(F.observed('probe.tcp.ok', true), { id: 'probe.tcp.ok', gen: 0 });
gf['probe.tcp.ok'] = gf['a'];
gf['dns.config.loopback'] = Object.assign(F.observed('dns.config.loopback', true), { gen: 1 });

t('spansGenerations(): true when evidence crosses a generation boundary',
    F.spansGenerations(gf, ['probe.tcp.ok', 'dns.config.loopback']) === true);
t('spansGenerations(): false within one generation',
    F.spansGenerations(gf, ['probe.tcp.ok']) === false);
t('generationsOf(): ignores non-observed facts rather than counting them as a generation',
    F.generationsOf(facts, ['route.default.count', 'fw.outbound.action']).length === 1);

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
