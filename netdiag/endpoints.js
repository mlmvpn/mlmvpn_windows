/*
 * NetDiag — the endpoint model.
 *
 * This module exists to prevent one specific, damaging false diagnosis: concluding that a
 * healthy Iranian machine has a broken Windows stack because foreign endpoints were
 * unreachable. During a filtering event, 1.1.1.1, 8.8.8.8 and 9.9.9.9 can all go dark at once
 * while the gateway, the ISP link and every domestic destination are perfectly fine. A design
 * that aggregates those three into "no connectivity" reports a dead link, a stopped BFE
 * service, or a broken route — and offers privileged repairs — on a machine with nothing
 * wrong with it.
 *
 * Two ideas do the work.
 *
 *   SCOPES separate what an observation can prove. The gateway proves the local link. Domestic
 *   anchors prove the local stack, the ISP and routing. Foreign anchors prove international
 *   reachability and NOTHING about the machine.
 *
 *   netGroup separates independent evidence from repeated evidence. Two endpoints in the same
 *   operator's network are ONE observation, however many addresses they have. It is a
 *   compiled-in label chosen by a human, never inferred at runtime: this engine cannot observe
 *   network topology and must not pretend to.
 *
 * Aggregation then answers a question the older design could not express — the difference
 * between "several independent endpoints failed" and "several probes observed the same
 * upstream condition" — without claiming to know a cause it cannot see.
 */

'use strict';

const SCOPE = Object.freeze({
    GATEWAY: 'gateway',
    DOMESTIC: 'domestic',
    FOREIGN: 'foreign',
});

/** Independent groups a scope needs before it may state anything. Gateway is singular. */
const MIN_GROUPS = Object.freeze({ gateway: 1, domestic: 2, foreign: 2 });

/**
 * Per-endpoint evidential state, derived from siblings — never configured.
 *
 * `suspect` is the one that matters: a target that failed while every independent sibling
 * succeeded is more likely to be down itself than to be evidence about this machine, so it is
 * excluded from the scope verdict rather than counted against the user.
 */
const EP_STATE = Object.freeze({
    USABLE: 'usable',
    WEAK: 'weak',
    SUSPECT: 'suspect',
    UNAVAILABLE: 'unavailable',
    EXCLUDED: 'excluded',
});

/**
 * Foreign anchors: three operators, three netGroups.
 *
 * Chosen for independence rather than popularity — three addresses at one provider would be
 * one observation wearing three hats.
 */
const FOREIGN_ANCHORS = Object.freeze([
    { id: 'cf-v4', scope: SCOPE.FOREIGN, family: 'v4', ip: '1.1.1.1', port: 443, netGroup: 'cloudflare' },
    { id: 'goog-v4', scope: SCOPE.FOREIGN, family: 'v4', ip: '8.8.8.8', port: 443, netGroup: 'google' },
    { id: 'quad9-v4', scope: SCOPE.FOREIGN, family: 'v4', ip: '9.9.9.9', port: 443, netGroup: 'quad9' },
    { id: 'cf-v6', scope: SCOPE.FOREIGN, family: 'v6', ip: '2606:4700:4700::1111', port: 443, netGroup: 'cloudflare' },
    { id: 'goog-v6', scope: SCOPE.FOREIGN, family: 'v6', ip: '2001:4860:4860::8888', port: 443, netGroup: 'google' },
]);

/**
 * Domestic anchors — INTENTIONALLY EMPTY until the release checklist fills it in.
 *
 * The contract is fixed and implemented; only the addresses are outstanding, and inventing
 * two plausible-looking Iranian IPs here would be the exact failure this architecture exists
 * to prevent: asserting something nobody measured. Requirements, all mandatory:
 *
 *   * IP literals only — a hostname would entangle DNS in a probe whose entire purpose is to
 *     be DNS-independent;
 *   * hosted in Iran and domestically routed for domestic users;
 *   * TCP-reachable on 443 or 80. ANSWERING IS NOT REQUIRED — a completed handshake is the
 *     whole measurement, and no payload is ever sent: no HTTP request, no TLS ClientHello, no
 *     SNI. An anchor therefore learns nothing about the user beyond a connection attempt;
 *   * operationally stable, and neutral — not political, not governmental, not a bank, not
 *     news, nothing whose reachability could be read as a statement;
 *   * not CDN-fronted or anycast, so reachability means what it appears to mean;
 *   * at least two, in DIFFERENT netGroups (a build-time test enforces this).
 *
 * Until then `reach.domestic` is UNKNOWN, and the scope matrix refuses to name a local-stack
 * root cause without it. That is the designed degradation, and it is verified by test.
 */
const DOMESTIC_ANCHORS = Object.freeze([]);

/** Everything except the gateway, which is discovered per-run from the routing table. */
function staticEndpoints() {
    return [].concat(FOREIGN_ANCHORS, DOMESTIC_ANCHORS);
}

function gatewayEndpoint(ip, family) {
    return { id: `gw-${family}`, scope: SCOPE.GATEWAY, family, ip, port: null, netGroup: 'gateway' };
}

// ── aggregation ─────────────────────────────────────────────────────────────────────────

/**
 * Turn per-endpoint results into a scope verdict.
 *
 * `results` is `[{ endpoint, ok: true|false|null, reason }]`, where `null` means the probe was
 * not attempted (no route, deadline, cancelled) rather than that it failed.
 *
 * Returns `{ status, correlated, groups, states, why }` where status is one of:
 *
 *   'ok'       enough independent groups answered
 *   'fail'     enough independent groups all failed — a real, broad failure
 *   'unknown'  not enough independent evidence to say either way. NEVER a negative verdict:
 *              a scope below its minimum group count is silence, not failure.
 *
 * `correlated` names a netGroup when every failure came from that one group while others
 * succeeded. That is the observable half of "one upstream path is down"; the cause itself is
 * not observable from this machine, and the narrative says so rather than naming a mechanism.
 */
function aggregateScope(scope, results, opts) {
    const minGroups = (opts && opts.minGroups) || MIN_GROUPS[scope] || 2;
    const attempted = results.filter(r => r.ok !== null && r.ok !== undefined);
    const states = new Map();

    if (!attempted.length) {
        return {
            status: 'unknown', correlated: null, groups: { ok: [], fail: [] }, states,
            why: 'no endpoint in this scope could be probed',
        };
    }

    const okCount = attempted.filter(r => r.ok).length;
    const failed = attempted.filter(r => !r.ok);

    // Per-endpoint suspicion, relative to siblings in OTHER groups — an endpoint is never
    // judged against another address on the same operator's network.
    for (const r of results) {
        if (r.ok === null || r.ok === undefined) { states.set(r.endpoint.id, EP_STATE.UNAVAILABLE); continue; }
        if (r.ok) { states.set(r.endpoint.id, EP_STATE.USABLE); continue; }
        const otherGroupOk = attempted.some(o => o.ok && o.endpoint.netGroup !== r.endpoint.netGroup);
        const allOtherGroupsOk = attempted
            .filter(o => o.endpoint.netGroup !== r.endpoint.netGroup)
            .every(o => o.ok);
        const hasOtherGroups = attempted.some(o => o.endpoint.netGroup !== r.endpoint.netGroup);
        if (hasOtherGroups && allOtherGroupsOk) states.set(r.endpoint.id, EP_STATE.SUSPECT);
        else if (otherGroupOk) states.set(r.endpoint.id, EP_STATE.WEAK);
        else states.set(r.endpoint.id, EP_STATE.USABLE);
    }

    const usable = attempted.filter(r => states.get(r.endpoint.id) === EP_STATE.USABLE);
    const groupOk = new Set(usable.filter(r => r.ok).map(r => r.endpoint.netGroup));
    const groupFail = new Set(usable.filter(r => !r.ok).map(r => r.endpoint.netGroup));
    const usableGroups = new Set(usable.map(r => r.endpoint.netGroup));

    // R2 — every failure in one group while other groups answered. Not a scope failure.
    let correlated = null;
    if (okCount > 0 && failed.length) {
        const failGroups = new Set(failed.map(r => r.endpoint.netGroup));
        if (failGroups.size === 1) correlated = [...failGroups][0];
    }

    // R1 — independence. Below the minimum number of distinct groups, the scope is silent.
    if (usableGroups.size < minGroups) {
        return {
            status: 'unknown', correlated, groups: { ok: [...groupOk], fail: [...groupFail] }, states,
            why: `only ${usableGroups.size} independent network group(s) gave usable evidence; ${minGroups} required`,
        };
    }
    if (groupOk.size >= minGroups) {
        return { status: 'ok', correlated, groups: { ok: [...groupOk], fail: [...groupFail] }, states, why: null };
    }
    // R3 — every independent group failed. Real and broad; the CAUSE remains unobservable.
    if (groupOk.size === 0 && groupFail.size >= minGroups) {
        return {
            status: 'fail', correlated: null, groups: { ok: [], fail: [...groupFail] }, states,
            why: `all ${groupFail.size} independent network groups failed; the cause is upstream and not observable from this machine`,
        };
    }
    return {
        status: 'unknown', correlated, groups: { ok: [...groupOk], fail: [...groupFail] }, states,
        why: 'independent groups disagreed without reaching the threshold either way',
    };
}

/**
 * May this scope satisfy a DECISIVE gate?
 *
 * Five conditions, all required. A scope that fails any of them is `unknown` to the gate, and
 * a necessary-and-unknown gate makes its hypothesis indeterminate rather than eliminated.
 * This is the rule that stops a partially-observed scope from proving anything.
 */
function mayBeDecisive(agg, opts) {
    const minGroups = (opts && opts.minGroups) || 2;
    if (!agg) return { ok: false, why: 'no aggregate' };
    if (agg.status !== 'ok' && agg.status !== 'fail') return { ok: false, why: agg.why || 'scope is unknown' };
    const groups = agg.status === 'ok' ? agg.groups.ok : agg.groups.fail;
    if (groups.length < minGroups) return { ok: false, why: `fewer than ${minGroups} independent groups agree` };
    if (agg.correlated) return { ok: false, why: `failures were correlated within ${agg.correlated}` };
    const mixed = agg.groups.ok.length && agg.groups.fail.length;
    if (mixed) return { ok: false, why: 'usable endpoints were not unanimous' };
    return { ok: true, why: null };
}

/** Build-time sanity: a scope whose endpoints share one operator can never satisfy R1. */
function auditEndpointTable() {
    const problems = [];
    for (const scope of [SCOPE.FOREIGN, SCOPE.DOMESTIC]) {
        for (const family of ['v4', 'v6']) {
            const eps = staticEndpoints().filter(e => e.scope === scope && e.family === family);
            if (!eps.length) continue;
            const groups = new Set(eps.map(e => e.netGroup));
            if (groups.size < MIN_GROUPS[scope]) {
                problems.push(`${scope}/${family}: ${eps.length} endpoint(s) in only ${groups.size} netGroup(s), needs ${MIN_GROUPS[scope]}`);
            }
        }
    }
    return problems;
}

module.exports = {
    SCOPE, MIN_GROUPS, EP_STATE,
    FOREIGN_ANCHORS, DOMESTIC_ANCHORS, staticEndpoints, gatewayEndpoint,
    aggregateScope, mayBeDecisive, auditEndpointTable,
};
