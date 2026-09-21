/*
 * NetDiag — the diagnosis engine.
 *
 * A pure function from a fact map to a narrative. No I/O, not even a require of anything that
 * touches the system: that is what makes the reasoning replayable from a saved session,
 * testable with no Windows and no network, and provably local. If a future edit needs
 * child_process in here, the design has been violated.
 *
 * The pipeline, in this exact order — the ordering IS the design:
 *
 *   1. evidence evaluation      predicates over facts, in three-valued logic
 *   2. gate resolution          a necessary gate FALSE eliminates; UNKNOWN makes it indeterminate
 *   3. decisive confirmation    all decisive gates TRUE => confirmed, without scoring
 *   4. weighted ranking         survivors only => likely / possible
 *   5. caps                     unknownMass, generation span, conflict
 *   6. causal reduction         over ALL survivors, INCLUDING the confirmed ones
 *   7. bucket classification    root / consequence / independent / unresolved
 *   8. narrative
 *
 * Step 6 running after step 3 and over confirmed hypotheses is the correction that stops a
 * consequence from being promoted to a second root cause. A dead system proxy makes DNS
 * lookups fail; those failures can independently satisfy the decisive gate for "the resolver
 * is unreachable"; and a design that ran dominance only over the *scored* set would then
 * report two root causes where there is one — and offer the user a DNS repair for a proxy
 * problem. `confirmed` means "the evidence is decisive", never "this is the root".
 */

'use strict';

const F = require('./facts');
const { SYMPTOM } = require('./rules/ids');

/** Terminal verdicts. `indeterminate` is a real answer, not a failure to produce one. */
const VERDICT = Object.freeze({
    CONFIRMED: 'confirmed',
    LIKELY: 'likely',
    POSSIBLE: 'possible',
    ELIMINATED: 'eliminated',
    INDETERMINATE: 'indeterminate',
});

const VERDICT_RANK = { confirmed: 4, likely: 3, possible: 2, indeterminate: 1, eliminated: 0 };

/**
 * Above this fraction of unobservable evidence, a hypothesis cannot be promoted past
 * `possible` however well it scores. Incomplete evidence stays visible instead of being
 * rounded into confidence.
 */
const UNKNOWN_MASS_CAP = 0.5;

/** Score needed to be `likely` rather than merely `possible`, once nothing has capped it. */
const LIKELY_THRESHOLD = 1.0;

// ── gate evaluation ─────────────────────────────────────────────────────────────────────

function evalGate(facts, gate) {
    return F.test(facts, gate.factId, gate.predicate);
}

/** Every fact id a hypothesis depends on — the basis for unknownMass and the generation check. */
function evidenceIds(h) {
    const ids = [];
    for (const g of h.necessary || []) ids.push(g.factId);
    for (const g of h.decisive || []) ids.push(g.factId);
    for (const s of h.supporting || []) ids.push(s.factId);
    for (const r of h.refuting || []) ids.push(r.factId);
    return [...new Set(ids)];
}

/**
 * Evaluate one hypothesis against the facts.
 *
 * Ownership is checked first and short-circuits everything: state this app is deliberately
 * maintaining is `by-design`, is not a fault, and no repair may be offered for it. That check
 * living here rather than in the repair layer is deliberate — a by-design finding must never
 * become a "cause" in the narrative in the first place.
 */
function evaluate(facts, h) {
    const ids = evidenceIds(h);
    const out = {
        id: h.id,
        title: h.title,
        category: h.category || null,
        layer: typeof h.layer === 'number' ? h.layer : 99,
        verdict: VERDICT.INDETERMINATE,
        score: 0,
        unknownMass: F.unknownMass(facts, ids),
        evidenceIds: ids,
        missing: ids.filter(id => !F.isObserved(facts, id)),
        conflicts: [],
        caps: [],
        ownership: 'fault',
        explains: h.explains || [],
        causes: h.causes || [],
        repairs: h.repairs || [],
        symptomOnly: h.symptomOnly === true,
        consequenceOf: null,
        bucket: null,
        reason: null,
    };

    // ── by-design short circuit ──
    if (h.byDesignWhen) {
        const bd = evalGate(facts, h.byDesignWhen);
        if (F.isTrue(bd)) {
            out.ownership = 'by-design';
            out.verdict = VERDICT.ELIMINATED;
            out.repairs = [];
            out.reason = 'this state is maintained by the app on purpose';
            return out;
        }
        if (F.isUnknown(bd)) {
            // We could not establish whether this is our own doing. Not a fault we may act on.
            out.ownership = 'unknown';
            out.caps.push('ownership-unknown');
        }
    }

    // ── necessary gates ──
    for (const g of h.necessary || []) {
        const v = evalGate(facts, g);
        if (F.isFalse(v)) {
            out.verdict = VERDICT.ELIMINATED;
            out.reason = g.because || `necessary condition not met: ${g.factId}`;
            return out;
        }
        if (F.isUnknown(v)) {
            out.verdict = VERDICT.INDETERMINATE;
            out.reason = g.because || `necessary condition could not be observed: ${g.factId}`;
            out.indeterminateOn = g.factId;
            // Deliberately does NOT return: refuting evidence is still worth collecting for
            // the report, and a discriminator may be able to settle exactly this fact later.
        }
    }

    // ── refuting evidence: a definite refutation eliminates ──
    for (const r of h.refuting || []) {
        const v = evalGate(facts, r);
        if (F.isTrue(v)) {
            if (r.decisive) {
                out.verdict = VERDICT.ELIMINATED;
                out.reason = r.because || `refuted by ${r.factId}`;
                return out;
            }
            out.score -= (r.weight || 1);
        }
    }

    // ── declared conflicts ──
    //
    // Evaluated before the decisive gates return, because for some hypotheses the
    // contradiction IS the finding — "Windows reports the tunnel healthy while no bytes make
    // the round trip" is the whole diagnosis, not a reason to doubt it. Those declare
    // `capping: false`: the conflict is still named in the report, but it does not hold the
    // verdict down. Every other conflict does.
    for (const c of h.conflictWhen || []) {
        if (F.isTrue(evalGate(facts, c.a)) && F.isTrue(evalGate(facts, c.b))) {
            out.conflicts.push({ kind: 'contradiction', note: c.note, capping: c.capping !== false });
        }
    }

    if (out.verdict === VERDICT.INDETERMINATE && out.indeterminateOn) {
        applyCaps(facts, h, out);
        return out;
    }

    // ── decisive gates: proof, not probability ──
    const decisive = h.decisive || [];
    if (decisive.length) {
        const vals = decisive.map(g => evalGate(facts, g));
        if (vals.every(F.isTrue)) {
            out.verdict = VERDICT.CONFIRMED;
            out.score = Math.max(out.score, LIKELY_THRESHOLD + 1);
            out.reason = h.decisiveBecause || 'all decisive conditions measured true';
            applyCaps(facts, h, out);
            return out;
        }
        if (vals.some(F.isUnknown) && !vals.some(F.isFalse)) {
            // Everything readable agrees, but something decisive is missing. This is the case
            // the bounded discriminator round exists for.
            out.verdict = VERDICT.INDETERMINATE;
            out.indeterminateOn = decisive[vals.findIndex(F.isUnknown)].factId;
            out.reason = 'a decisive condition could not be observed';
            applyCaps(facts, h, out);
            return out;
        }
    }

    // ── weighted ranking among survivors ──
    for (const s of h.supporting || []) {
        const v = evalGate(facts, s);
        if (F.isTrue(v)) out.score += (s.weight || 1);
        else if (F.isUnknown(v)) out.conflicts.push({ factId: s.factId, kind: 'unobserved-support' });
    }
    if (out.score <= 0) {
        out.verdict = VERDICT.ELIMINATED;
        out.reason = out.reason || 'no supporting evidence';
        return out;
    }
    out.verdict = out.score >= LIKELY_THRESHOLD ? VERDICT.LIKELY : VERDICT.POSSIBLE;

    applyCaps(facts, h, out);
    return out;
}

/**
 * Caps never promote; they only hold a verdict down.
 *
 * All three exist because a number that looks confident is worse than an honest hedge:
 * evidence we mostly could not see, evidence describing two different machines, and evidence
 * that contradicts itself must each stop short of a headline.
 */
function applyCaps(facts, h, out) {
    if (out.unknownMass > UNKNOWN_MASS_CAP) out.caps.push('unknown-mass');
    if (F.spansGenerations(facts, out.evidenceIds)) out.caps.push('generation-span');
    if (out.conflicts.some(c => c.kind === 'contradiction' && c.capping)) out.caps.push('conflict');

    if (out.caps.length && VERDICT_RANK[out.verdict] > VERDICT_RANK[VERDICT.POSSIBLE]) {
        out.cappedFrom = out.verdict;
        out.verdict = VERDICT.POSSIBLE;
    }

    // The Prime Directive, enforced structurally rather than left to each rule to remember.
    //
    // If we could not establish whether this state is the app's own doing, no repair may be
    // offered for it — not a downgraded one, not a confirm-tier one, none. A rule that forgets
    // to gate on ownership would otherwise reach `likely` on its supporting evidence alone and
    // hand the user a button that tears down a protection we simply failed to recognise.
    if (out.ownership === 'unknown' && out.repairs.length) {
        out.suppressedRepairs = out.repairs;
        out.repairs = [];
    }
    return out;
}

// ── causal reduction ────────────────────────────────────────────────────────────────────

/**
 * Collapse consequences into their cause.
 *
 * Runs over every surviving hypothesis, confirmed included. Where A causes B and both
 * survive, B becomes `consequence-of: A` and leaves the primary list — a stale TUN route, the
 * DNS timeouts it produces, and the HTTP failures those produce collapse into one story
 * instead of three findings the user is invited to fix separately.
 *
 * Precedence when both are confirmed: the higher verdict wins, then the higher score, then
 * the lower layer (closer to the wire is closer to the cause), then the id, so the outcome is
 * deterministic and replay-stable.
 */
function causalReduction(evaluated) {
    const alive = evaluated.filter(e => e.verdict === VERDICT.CONFIRMED
        || e.verdict === VERDICT.LIKELY || e.verdict === VERDICT.POSSIBLE);
    const byId = new Map(alive.map(e => [e.id, e]));

    /**
     * May A absorb B?
     *
     * The causes edge already states the direction — it was authored knowing that a dead
     * proxy makes DNS time out, not the reverse. So the edge decides, and the ranking only
     * vetoes the case where the would-be cause is the weaker claim of the two.
     *
     * An earlier version added "lower layer wins" as a tiebreak, on the theory that closer to
     * the wire is closer to the cause. It inverted exactly the case this engine exists for: a
     * dead system proxy sits at the application layer and a resolver timeout at the transport
     * layer, so the tiebreak overrode the causal edge and reported both as root causes —
     * handing the user a DNS repair for a proxy problem. Layer is not causality.
     */
    const mayAbsorb = (a, b) => VERDICT_RANK[a.verdict] >= VERDICT_RANK[b.verdict];

    for (const a of alive) {
        for (const causedId of a.causes || []) {
            const b = byId.get(causedId);
            if (!b || b === a) continue;
            if (b.consequenceOf) continue;                 // already collapsed into something
            if (wouldCycle(byId, b, a)) continue;          // A causes B and B causes A: leave both
            if (mayAbsorb(a, b)) b.consequenceOf = a.id;
        }
    }
    return evaluated;
}

/** Does `from` already reach `to` through the causes graph? Guards against mutual collapse. */
function wouldCycle(byId, from, to, seen) {
    const visited = seen || new Set();
    if (from.id === to.id) return true;
    if (visited.has(from.id)) return false;
    visited.add(from.id);
    for (const id of from.causes || []) {
        const next = byId.get(id);
        if (next && wouldCycle(byId, next, to, visited)) return true;
    }
    return false;
}

// ── the narrative ───────────────────────────────────────────────────────────────────────

function bucketise(evaluated, symptom) {
    const target = symptom || SYMPTOM.NOTHING_OPENS;
    const rootCauses = [];
    const consequences = [];
    const independent = [];
    const unresolved = [];
    const symptoms = [];

    for (const e of evaluated) {
        if (e.verdict === VERDICT.ELIMINATED) continue;
        if (e.verdict === VERDICT.INDETERMINATE) {
            // Only worth telling the user about when the missing evidence is what stopped us.
            if (e.unknownMass > 0 || e.indeterminateOn) unresolved.push(e);
            continue;
        }
        if (e.consequenceOf) { consequences.push(e); e.bucket = 'consequence'; continue; }
        // A restatement of the complaint is not a cause.
        //
        // "No page opened" and "nothing reached the internet" exist in the registry as
        // collapse targets so that a real cause can absorb them. When nothing absorbs them,
        // that means the cause was not found — and reporting «علت: هیچ صفحه‌ای باز نمی‌شود»
        // to a user who came here because no page opens is worse than saying nothing.
        if (e.symptomOnly) { symptoms.push(e); e.bucket = 'symptom'; continue; }
        if ((e.explains || []).includes(target)) { rootCauses.push(e); e.bucket = 'root'; continue; }
        independent.push(e);
        e.bucket = 'independent';
    }
    for (const e of unresolved) e.bucket = 'unresolved';

    const order = (a, b) => (VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict])
        || (b.score - a.score) || (a.layer - b.layer) || a.id.localeCompare(b.id);
    rootCauses.sort(order); consequences.sort(order); independent.sort(order); unresolved.sort(order);

    return { rootCauses, consequences, independent, unresolved, symptoms };
}

/**
 * Diagnose. `facts` in, narrative out, nothing else touched.
 *
 * `registry` is injected rather than required, so a test can reason over three hand-built
 * hypotheses instead of the whole rule set.
 */
function diagnose(facts, registry, opts) {
    const o = opts || {};
    const rules = registry || require('./rules');
    const symptom = o.symptom || SYMPTOM.NOTHING_OPENS;

    const evaluated = rules.map(h => evaluate(facts, h));
    causalReduction(evaluated);
    const buckets = bucketise(evaluated, symptom);

    const confirmedRoots = buckets.rootCauses.filter(e => e.verdict === VERDICT.CONFIRMED);
    const headline = decideHeadline(buckets, confirmedRoots);

    return {
        symptom,
        headline,
        rootCauses: buckets.rootCauses,
        consequences: buckets.consequences,
        independent: buckets.independent,
        unresolved: buckets.unresolved,
        symptoms: buckets.symptoms,
        byDesign: evaluated.filter(e => e.ownership === 'by-design'),
        eliminated: evaluated.filter(e => e.verdict === VERDICT.ELIMINATED && e.ownership !== 'by-design'),
        all: evaluated,
        /** Every fact a surviving hypothesis wanted and did not get — the report names these. */
        missingEvidence: [...new Set(
            [...buckets.rootCauses, ...buckets.unresolved].flatMap(e => e.missing)
        )].sort(),
    };
}

/**
 * What the UI leads with.
 *
 * Three shapes, and the third is a first-class product outcome rather than a failure: when
 * nothing is established, the engine says so and names what was missing. A tool that
 * fabricates a cause is worse than no tool, and «علت قطعی پیدا نشد» is a shippable answer.
 */
function decideHeadline(buckets, confirmedRoots) {
    if (confirmedRoots.length === 1) {
        return { kind: 'single-root', id: confirmedRoots[0].id };
    }
    if (confirmedRoots.length > 1) {
        return { kind: 'multiple-roots', ids: confirmedRoots.map(e => e.id) };
    }
    const ranked = buckets.rootCauses;
    if (ranked.length === 1) return { kind: 'single-root', id: ranked[0].id };
    if (ranked.length > 1) return { kind: 'multiple-roots', ids: ranked.map(e => e.id) };
    if (buckets.unresolved.length) return { kind: 'undetermined', reason: 'evidence-incomplete' };
    if (buckets.independent.length) return { kind: 'no-cause-for-symptom', reason: 'findings exist but none explains the symptom' };
    return { kind: 'nothing-found', reason: 'no fault observed' };
}

module.exports = {
    VERDICT, VERDICT_RANK, UNKNOWN_MASS_CAP, LIKELY_THRESHOLD,
    evaluate, evidenceIds, causalReduction, bucketise, diagnose, decideHeadline,
};
