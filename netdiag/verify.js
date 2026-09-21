/*
 * The verification engine.
 *
 * It answers "did the user's problem go away", not "did the command return 0". Those are
 * different claims, and fusing them is how a repair reports success on a machine that is
 * still broken.
 *
 * Three independent levels, all evaluated:
 *
 *   DIRECT      the facts that produced the hypothesis are re-collected and its gates no
 *               longer hold. Necessary, never sufficient — it only says the mechanism moved.
 *
 *   FUNCTIONAL  the user's actual complaint. A MAJORITY of independent targets must pass, and
 *               the comparison is against the PRE-REPAIR baseline rather than an absolute
 *               threshold: on a line that was already partly degraded for unrelated reasons,
 *               "3 of 5 work" means nothing without knowing it was 1 of 5 before.
 *
 *   REGRESSION  did we break something else. Computed only OUTSIDE the repair's declared
 *               `expectedChanges`, because several repairs MUST change facts to work —
 *               `dhcp.renew` changes the IP, the lease and the default route by design, and a
 *               naive diff would call that a regression, trigger a rollback, and perform a
 *               privileged write to undo a repair that had just succeeded.
 *
 * And the rule that keeps regression honest in the other direction: `observed → unknown` is
 * NOT a regression. It is lost visibility. Treating it as breakage would fire spurious
 * rollbacks on any machine with flaky WMI or a slow PowerShell.
 */

'use strict';

const F = require('./facts');

const OUTCOME = Object.freeze({
    FIXED: 'fixed',
    PARTIALLY_FIXED: 'partially-fixed',
    NOT_FIXED: 'not-fixed',
    REGRESSED: 'regressed',
    UNVERIFIABLE: 'unverifiable',
});

/** Does a fact id fall inside a repair's declared expected-change set? Supports `a.b.*`. */
function isExpected(factId, patterns) {
    return (patterns || []).some(p => {
        if (p === factId) return true;
        if (p.endsWith('*')) return factId.startsWith(p.slice(0, -1));
        return false;
    });
}

/**
 * Level 1 — direct.
 *
 * The hypothesis is re-evaluated against the fresh facts. Its gates must no longer hold.
 */
function direct(hypothesis, freshFacts, diagnoseFn) {
    if (!hypothesis) return { level: 'direct', pass: null, reason: 'no hypothesis to re-check' };
    const again = diagnoseFn(freshFacts, [hypothesis]).all[0];
    const stillHolds = again.verdict === 'confirmed' || again.verdict === 'likely';
    return {
        level: 'direct',
        pass: !stillHolds,
        verdict: again.verdict,
        reason: stillHolds ? 'the hypothesis still holds against fresh evidence' : null,
    };
}

/**
 * Level 2 — functional.
 *
 * `results` is `[{ id, group, ok }]` from the post-repair application probes, and `baseline`
 * is the same shape from before. Majority of USABLE targets across ≥2 independent groups, and
 * the previously-failing members must now pass.
 */
function functional(results, baseline, opts) {
    const o = opts || {};
    const minGroups = o.minGroups || 2;
    const attempted = (results || []).filter(r => r && r.ok !== null && r.ok !== undefined);

    if (!attempted.length) {
        return { level: 'functional', pass: null, reason: 'no functional target could be evaluated' };
    }
    const groups = new Set(attempted.map(r => r.group));
    if (groups.size < minGroups) {
        // One lucky endpoint is not proof the user's problem is gone.
        return {
            level: 'functional', pass: null,
            reason: `only ${groups.size} independent target group(s) answered; ${minGroups} required before calling anything fixed`,
        };
    }
    const passing = attempted.filter(r => r.ok);
    const majority = passing.length * 2 > attempted.length;

    const before = new Map((baseline || []).map(r => [r.id, r.ok]));
    const wasFailing = attempted.filter(r => before.get(r.id) === false);
    const nowFixed = wasFailing.filter(r => r.ok);
    const baselineKnown = wasFailing.length > 0;

    return {
        level: 'functional',
        pass: majority && (!baselineKnown || nowFixed.length === wasFailing.length),
        majority,
        recovered: nowFixed.length,
        wasFailing: wasFailing.length,
        passing: passing.length,
        attempted: attempted.length,
        groups: groups.size,
        reason: majority
            ? (baselineKnown && nowFixed.length < wasFailing.length
                ? `${nowFixed.length}/${wasFailing.length} of the previously failing targets recovered`
                : null)
            : `only ${passing.length} of ${attempted.length} targets pass`,
    };
}

/**
 * Level 3 — regression.
 *
 * Only `observed(ok) → observed(fail)` outside `expectedChanges` counts.
 */
function regression(beforeFacts, afterFacts, expectedChanges) {
    const regressions = [];
    const expectedEffects = [];
    const lostVisibility = [];

    for (const [id, before] of Object.entries(beforeFacts || {})) {
        const after = (afterFacts || {})[id];
        if (!after) continue;
        if (before.status !== 'observed') continue;

        if (after.status !== 'observed') {
            // Lost visibility, not breakage. Recorded so the report can mention it, never
            // acted on: a rollback is a privileged write, and firing one because WMI hiccupped
            // would make the tool the thing that breaks the machine.
            lostVisibility.push({ id, from: before.value, to: after.status });
            continue;
        }
        if (JSON.stringify(before.value) === JSON.stringify(after.value)) continue;

        const worse = wentWorse(before.value, after.value);
        if (!worse) continue;
        if (isExpected(id, expectedChanges)) expectedEffects.push({ id, from: before.value, to: after.value });
        else regressions.push({ id, from: before.value, to: after.value });
    }
    return { level: 'regression', pass: regressions.length === 0, regressions, expectedEffects, lostVisibility };
}

/** "Worse" for the value shapes this engine actually stores. */
function wentWorse(before, after) {
    if (before === true && after === false) return true;
    if (before === 'ok' && (after === 'fail')) return true;
    if (typeof before === 'number' && typeof after === 'number') return false;   // counts are context
    return false;
}

/**
 * Combine the three levels into one outcome.
 *
 * Order matters. A genuine regression outranks a fix, because a repair that solved the target
 * problem and broke something else is not a success — it is a rollback candidate. And an
 * unevaluable functional level is `unverifiable`, never `fixed`: the report must say
 * «نتوانستیم تأیید کنیم که مشکل حل شده» rather than «حل شد».
 */
function decide(levels) {
    const d = levels.direct || {};
    const f = levels.functional || {};
    const r = levels.regression || {};

    if (r.pass === false) return { outcome: OUTCOME.REGRESSED, levels, rollbackAdvised: true };
    if (f.pass === null || f.pass === undefined) return { outcome: OUTCOME.UNVERIFIABLE, levels, rollbackAdvised: false };
    if (f.pass === true && d.pass !== false) return { outcome: OUTCOME.FIXED, levels, rollbackAdvised: false };
    // The mechanism changed but the user's problem did not: another cause exists, and saying
    // so — then re-diagnosing — is more useful than either "fixed" or "failed".
    if (d.pass === true && f.pass === false) {
        return { outcome: OUTCOME.PARTIALLY_FIXED, levels, rollbackAdvised: false, rediagnose: true };
    }
    return { outcome: OUTCOME.NOT_FIXED, levels, rollbackAdvised: false };
}

/** The Persian sentence for an outcome. Never stronger than the outcome allows. */
const WORDING = Object.freeze({
    fixed: 'مشکل برطرف شد و بررسی مستقل هم آن را تأیید کرد.',
    'partially-fixed': 'آن مورد درست شد، ولی مشکل شما هنوز پابرجاست — یعنی علت دیگری هم وجود دارد.',
    'not-fixed': 'این کار انجام شد ولی تغییری در وضعیت ایجاد نکرد.',
    regressed: 'این کار چیز دیگری را خراب کرد؛ پیشنهاد می‌کنیم آن را برگردانیم.',
    unverifiable: 'نتوانستیم تأیید کنیم که مشکل حل شده است.',
});

module.exports = { OUTCOME, WORDING, direct, functional, regression, decide, isExpected, wentWorse };
