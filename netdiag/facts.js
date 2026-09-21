/*
 * NetDiag — the Fact model.
 *
 * A Fact is one observation. It is NOT a verdict. Collectors produce facts; only the rules
 * in netdiag/rules/ are allowed to judge, and they judge a pure fact map with no I/O.
 *
 * Three properties here are load-bearing, and each of them exists because getting it wrong
 * produces a confident wrong answer on a user's machine:
 *
 *   status   `unknown` (we could not observe) is NOT `false` (we observed absence). "The
 *            routing table could not be read" and "there is no default route" demand
 *            opposite handling, and a rule that cannot tell them apart will invent a cause.
 *            This is the single most important distinction in the whole engine.
 *
 *   quality  `Get-NetAdapter Status = Up` is something Windows *reports*. A completed TCP
 *            handshake is something we *measured*. `checkLive()`'s `route-stolen` verdict is
 *            *inferred* — it is the else-branch of three other checks, and it is also the
 *            correct state for a deliberate split tunnel. Believing a report as if it were a
 *            measurement is precisely how the built-in Windows troubleshooter fails, and the
 *            disagreement between the two IS the signature of "connected but nothing opens".
 *
 *   family   Every reachability and resolution fact is IPv4/IPv6 tagged. Without it, an
 *            IPv4-only probe set reports "no internet" on a machine whose IPv6 is fine and
 *            whose browser works.
 *
 * Facts are immutable. A post-repair collection writes a SECOND fact map and verification
 * diffs the two; the evidence behind the original diagnosis is never overwritten.
 */

'use strict';

// ── enumerations ────────────────────────────────────────────────────────────────────────

/** Observation state. `value` is meaningful ONLY for `observed`. */
const STATUS = Object.freeze({
    OBSERVED: 'observed',   // we looked, and this is what was there
    UNKNOWN: 'unknown',     // we could not look, or the answer was unreadable
    ERROR: 'error',         // we looked and the attempt failed in a way worth reporting
    SKIPPED: 'skipped',     // we deliberately did not look; `skippedReason` says why
});

/** How much the value is worth. Rules weight these differently. */
const QUALITY = Object.freeze({
    MEASURED: 'measured',   // a round trip we performed ourselves
    REPORTED: 'reported',   // Windows told us
    INFERRED: 'inferred',   // derived from other observations, not observed directly
});

const SCOPE = Object.freeze({
    MACHINE: 'machine',
    INTERFACE: 'interface',
    ENDPOINT: 'endpoint',
    APP: 'app',
});

const FAMILY = Object.freeze({
    V4: 'v4',
    V6: 'v6',
    NONE: 'none',           // not an address-family-specific observation
});

/**
 * Fact-id namespaces. Every fact id must begin with one of these, which is what stops a
 * typo'd id from silently becoming a fact nobody ever reads.
 */
const NAMESPACES = Object.freeze([
    'host',        // OS build, locale, PowerShell version, elevation, app version
    'svc',         // BFE, Dnscache, Dhcp, NlaSvc, nsi, WinHttpAutoProxySvc, W32Time
    'topo',        // interface inventory, egress selection, virtual/physical classification
    'nic',         // adapter status as Windows reports it
    'ip',          // addresses, AddressState (Duplicate/Tentative/Invalid)
    'dhcp',        // lease state
    'route',       // routing table, default routes, metrics
    'neigh',       // ARP / neighbour state
    'dns',         // dns.config.* and dns.answer.*
    'proxy',       // proxy.wininet.* / proxy.winhttp.* / proxy.machine.* / proxy.pac.*
    'fw',          // firewall profiles and outbound policy
    'wfp',         // WFP providers
    'winsock',     // LSP / catalog providers
    'probe',       // raw probe results
    'reach',       // aggregated scope verdicts (gateway / domestic / foreign)
    'mtu',
    'ipv6',
    'time',        // clock skew, W32Time sync state
    'ncsi',        // what Windows itself thinks "Connected" means
    'app',         // ownership: what THIS app is deliberately doing right now
    'anchor',      // domestic anchor set health
]);

// ── fact ids ────────────────────────────────────────────────────────────────────────────

const IF_SEP = '@if:';
const EP_SEP = '@ep:';

/**
 * Scope a fact id to an interface.
 *
 * The key is always InterfaceGuid — never InterfaceIndex (Windows reuses indices) and never
 * the alias (users and drivers rename them). A repair that captured "interface 33" and
 * rolls back onto whatever is index 33 an hour later is a repair applied to the wrong NIC.
 */
function ifScoped(id, interfaceGuid) {
    if (!interfaceGuid) throw new Error(`ifScoped(${id}) requires an InterfaceGuid`);
    return `${id}${IF_SEP}${String(interfaceGuid).toLowerCase()}`;
}

/** Scope a fact id to a named endpoint from the compiled-in endpoint table. */
function epScoped(id, endpointId) {
    if (!endpointId) throw new Error(`epScoped(${id}) requires an endpoint id`);
    return `${id}${EP_SEP}${endpointId}`;
}

/** Split a scoped id back into `{ base, interfaceGuid, endpointId }`. */
function parseId(factId) {
    const s = String(factId);
    const ifAt = s.indexOf(IF_SEP);
    const epAt = s.indexOf(EP_SEP);
    if (ifAt >= 0) return { base: s.slice(0, ifAt), interfaceGuid: s.slice(ifAt + IF_SEP.length), endpointId: null };
    if (epAt >= 0) return { base: s.slice(0, epAt), interfaceGuid: null, endpointId: s.slice(epAt + EP_SEP.length) };
    return { base: s, interfaceGuid: null, endpointId: null };
}

function namespaceOf(factId) {
    return parseId(factId).base.split('.')[0];
}

function isValidId(factId) {
    if (typeof factId !== 'string' || !factId) return false;
    const { base } = parseId(factId);
    if (!/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(base)) return false;
    return NAMESPACES.includes(base.split('.')[0]);
}

// ── construction ────────────────────────────────────────────────────────────────────────

function baseFact(id, status, opts) {
    if (!isValidId(id)) throw new Error(`invalid fact id: ${JSON.stringify(id)}`);
    const o = opts || {};
    return {
        id,
        status,
        value: undefined,
        quality: o.quality || QUALITY.REPORTED,
        scope: o.scope || (parseId(id).interfaceGuid ? SCOPE.INTERFACE : SCOPE.MACHINE),
        family: o.family || FAMILY.NONE,
        gen: typeof o.gen === 'number' ? o.gen : 0,
        atMono: typeof o.atMono === 'number' ? o.atMono : 0,
        ms: typeof o.ms === 'number' ? o.ms : 0,
        source: o.source || null,
        raw: o.raw === undefined ? null : trimRaw(o.raw),
        note: o.note || null,
        skippedReason: null,
        errorReason: null,
    };
}

/** A raw sample for the report appendix. Bounded, because some catalogs are megabytes. */
function trimRaw(raw, limit = 2000) {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (s == null) return null;
    return s.length > limit ? `${s.slice(0, limit)}\n…[${s.length - limit} more chars]` : s;
}

/**
 * We looked and this is what was there.
 *
 * `value` must be supplied. `undefined` here would be a collector accidentally reporting an
 * observation it did not make, which is the exact failure the status field exists to prevent.
 */
function observed(id, value, opts) {
    if (value === undefined) {
        throw new Error(`observed(${id}) called without a value — use unknown() if it could not be read`);
    }
    const f = baseFact(id, STATUS.OBSERVED, opts);
    f.value = value;
    return f;
}

/**
 * We could not observe it.
 *
 * Every caller must give a reason, because "unknown" with no reason is indistinguishable
 * from a forgotten code path, and the report has to name the missing evidence to the user.
 */
function unknown(id, reason, opts) {
    if (!reason) throw new Error(`unknown(${id}) requires a reason`);
    const f = baseFact(id, STATUS.UNKNOWN, opts);
    f.note = f.note || reason;
    f.errorReason = reason;
    return f;
}

/** We tried, and the attempt itself failed in a way worth reporting. */
function errored(id, reason, opts) {
    if (!reason) throw new Error(`errored(${id}) requires a reason`);
    const f = baseFact(id, STATUS.ERROR, opts);
    f.errorReason = reason;
    return f;
}

/** We deliberately did not look. The predicate that decided so is the reason. */
function skipped(id, reason, opts) {
    if (!reason) throw new Error(`skipped(${id}) requires a reason`);
    const f = baseFact(id, STATUS.SKIPPED, opts);
    f.skippedReason = reason;
    return f;
}

// ── three-valued (Kleene) logic ─────────────────────────────────────────────────────────
//
// Gates are evaluated in three-valued logic, not boolean. `UNKNOWN` propagates: a necessary
// gate that is UNKNOWN makes the hypothesis indeterminate, never eliminated and never
// confirmed. Collapsing UNKNOWN to false here is how an engine invents a cause it never saw
// evidence for, so the collapse is not available anywhere in this module.

const TRUE = 'true';
const FALSE = 'false';
const UNKNOWN = 'unknown';

function not3(a) {
    if (a === TRUE) return FALSE;
    if (a === FALSE) return TRUE;
    return UNKNOWN;
}

function and3(...vals) {
    if (vals.some(v => v === FALSE)) return FALSE;      // one false settles it
    if (vals.some(v => v === UNKNOWN)) return UNKNOWN;
    return vals.length ? TRUE : UNKNOWN;
}

function or3(...vals) {
    if (vals.some(v => v === TRUE)) return TRUE;        // one true settles it
    if (vals.some(v => v === UNKNOWN)) return UNKNOWN;
    return vals.length ? FALSE : UNKNOWN;
}

/** `true` only for a definite TRUE. Never treats UNKNOWN as satisfied. */
function isTrue(v) { return v === TRUE; }
/** `true` only for a definite FALSE. Never treats UNKNOWN as refuted. */
function isFalse(v) { return v === FALSE; }
function isUnknown(v) { return v === UNKNOWN; }

// ── reading a fact map ──────────────────────────────────────────────────────────────────

function get(facts, id) {
    return (facts && facts[id]) || null;
}

/** Was this actually observed? Anything else — missing, unknown, error, skipped — is false. */
function isObserved(facts, id) {
    const f = get(facts, id);
    return !!(f && f.status === STATUS.OBSERVED);
}

/**
 * The observed value, or `undefined`.
 *
 * Deliberately has no default-value parameter. A default silently converts "we do not know"
 * into a number a rule will happily reason about; callers must go through `test()` or check
 * `isObserved()` so the unknown stays visible.
 */
function valueOf(facts, id) {
    const f = get(facts, id);
    return f && f.status === STATUS.OBSERVED ? f.value : undefined;
}

/**
 * Evaluate a predicate against a fact, in three-valued logic.
 *
 * An absent fact, or one that is unknown/error/skipped, yields UNKNOWN — never FALSE. This
 * one function is where the Prime Directive ("absence of evidence is never authority to
 * act") is actually enforced for the whole reasoning layer.
 */
function test(facts, id, predicate) {
    const f = get(facts, id);
    if (!f || f.status !== STATUS.OBSERVED) return UNKNOWN;
    let r;
    try {
        r = predicate(f.value, f);
    } catch (e) {
        return UNKNOWN;                                  // a throwing predicate is not evidence
    }
    if (r === true) return TRUE;
    if (r === false) return FALSE;
    return UNKNOWN;                                      // a predicate may itself abstain
}

function equals(facts, id, expected) {
    return test(facts, id, v => v === expected);
}

/** Every fact whose base id matches, across all interface/endpoint scopes. */
function allScoped(facts, baseId) {
    const out = [];
    for (const k of Object.keys(facts || {})) {
        if (parseId(k).base === baseId) out.push(facts[k]);
    }
    return out;
}

/**
 * Fraction of the given ids that could not be observed — the hypothesis's `unknownMass`.
 * High unknownMass caps a verdict at `possible` no matter how good the score looks, which is
 * how incomplete evidence stays visible instead of being rounded away.
 */
function unknownMass(facts, ids) {
    if (!ids || !ids.length) return 0;
    let missing = 0;
    for (const id of ids) if (!isObserved(facts, id)) missing++;
    return missing / ids.length;
}

/** The distinct generations the given facts were collected in (see session.js). */
function generationsOf(facts, ids) {
    const gens = new Set();
    for (const id of ids || []) {
        const f = get(facts, id);
        if (f && f.status === STATUS.OBSERVED) gens.add(f.gen);
    }
    return [...gens].sort((a, b) => a - b);
}

/**
 * Does this evidence span more than one generation?
 *
 * If it does, the machine changed underneath the run and the facts describe two different
 * machines. Such evidence may never produce a `confirmed` verdict — a VPN coming up halfway
 * through a 35-second run is enough to make a stale-DNS diagnosis look decisive while the
 * tunnel it would tear DNS away from is live.
 */
function spansGenerations(facts, ids) {
    return generationsOf(facts, ids).length > 1;
}

module.exports = {
    STATUS, QUALITY, SCOPE, FAMILY, NAMESPACES,
    ifScoped, epScoped, parseId, namespaceOf, isValidId,
    observed, unknown, errored, skipped, trimRaw,
    TRUE, FALSE, UNKNOWN, not3, and3, or3, isTrue, isFalse, isUnknown,
    get, isObserved, valueOf, test, equals, allScoped,
    unknownMass, generationsOf, spansGenerations,
};
