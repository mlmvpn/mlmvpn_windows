/*
 * The repair registry, the tier derivation, and the apply-time gate.
 *
 * Tiers are DERIVED from five independent properties, never hand-assigned, because a
 * hand-assigned tier drifts from the thing it is supposed to describe. The fifth property is
 * the one that earns its place:
 *
 *   exposure   Reversibility describes the MECHANISM; it says nothing about the consequence
 *              while the change is in effect. `proxy.wininet.disable` is trivially reversible
 *              and can de-anonymise an Iranian user for the seconds it is active. Anything
 *              that can route real traffic outside a tunnel, reveal the real IP, or weaken
 *              leak protection is `traffic-visible` and can NEVER be in the auto tier,
 *              however cleanly it rolls back.
 *
 * And the gate. Eight checks, all against FRESH reads rather than against the session that
 * offered the repair, because everything the offer was based on can be false by the time the
 * user clicks: the machine changes, the app brings a tunnel up, another process takes the
 * proxy. A repair that acts on a stale offer is a repair aimed at a machine that no longer
 * exists.
 */

'use strict';

const F = require('../facts');
const S = require('../session');
const O = require('../ownership');
const journal = require('../journal');
const mutex = require('../mutex');

const TIER = Object.freeze({ AUTO: 'auto', CONFIRM: 'confirm', DANGER: 'confirm-danger' });
const EXPOSURE = Object.freeze({ NONE: 'none', TRAFFIC_VISIBLE: 'traffic-visible' });

const registry = [].concat(
    require('./dns-flush'),
    require('./svc-start'),
    require('./proxy-wininet-disable'),
    require('./proxy-pac-clear'),
    require('./guard-restore-stale'),
);

const byId = new Map(registry.map(r => [r.id, r]));
if (byId.size !== registry.length) throw new Error('duplicate repair id in the registry');

/**
 * Derive the tier.
 *
 * Ownership is an input, not an afterthought: a repair whose target's ownership could not be
 * established is never auto, because absence of evidence is not authority to act.
 */
function tierOf(repair, ctxFacts) {
    const exposure = repair.exposure || EXPOSURE.NONE;
    if (!repair.reversible || repair.requiresReboot) return TIER.DANGER;
    if (exposure === EXPOSURE.TRAFFIC_VISIBLE) return TIER.CONFIRM;
    if (repair.disruptive || repair.blastRadius === 'machine') return TIER.CONFIRM;
    if (typeof repair.ownershipFactId === 'string' && ctxFacts) {
        const own = F.valueOf(ctxFacts, repair.ownershipFactId);
        if (own !== O.OWNERSHIP.FOREIGN) return TIER.CONFIRM;
    }
    return TIER.AUTO;
}

/** Which of the five axes forced the tier — named to the user in the confirm dialog. */
function tierReason(repair, ctxFacts) {
    if (!repair.reversible) return 'این کار برگشت‌پذیر نیست';
    if (repair.requiresReboot) return 'برای کامل شدن به راه‌اندازی مجدد ویندوز نیاز دارد';
    if ((repair.exposure || EXPOSURE.NONE) === EXPOSURE.TRAFFIC_VISIBLE) {
        return 'تا وقتی این تغییر برقرار است، ترافیک شما ممکن است بدون تونل و با IP واقعی خارج شود';
    }
    if (repair.disruptive) return 'ارتباط‌های باز را قطع می‌کند';
    if (repair.blastRadius === 'machine') return 'روی کل سیستم اثر می‌گذارد، نه فقط یک کارت شبکه';
    if (typeof repair.ownershipFactId === 'string' && ctxFacts
        && F.valueOf(ctxFacts, repair.ownershipFactId) !== O.OWNERSHIP.FOREIGN) {
        return 'مطمئن نیستیم این تنظیم را خودِ برنامه انجام داده یا نه';
    }
    return null;
}

const GATE_FAIL = (step, reason) => ({ ok: false, step, reason });

/**
 * The eight-step apply-time gate.
 *
 * `live` supplies fresh reads: `generation()`, `facts()`, `ownership(repair)`, `enginesQuiet()`.
 * Injected so every branch is testable without a machine.
 */
async function gate(repair, session, tokenCheck, live) {
    // 1 — the machine must still be the machine the offer described.
    const gen = await live.generation();
    if (gen !== session.generation.current) {
        return GATE_FAIL('generation', `وضعیت شبکه از زمان پیشنهاد تغییر کرده است (${session.generation.current} → ${gen})`);
    }

    // 2 — ownership, re-derived. Anything other than proved FOREIGN aborts: `ours-live` is
    // by-design, `ours-orphaned` belongs to its owner's recovery path, and `unknown` is the
    // fail-safe that stops us tearing down protection we simply failed to recognise.
    if (repair.ownershipFactId) {
        const own = await live.ownership(repair);
        if (own !== O.OWNERSHIP.FOREIGN) {
            return GATE_FAIL('ownership', `مالکیت این تنظیم «${own}» است و تعمیر مستقیم مجاز نیست`);
        }
    }

    // 3 & 4 — the hypothesis's own preconditions, re-evaluated against fresh facts, plus the
    // engine-quiet check. A listener that appeared since the offer means the diagnosis is
    // stale, not that the repair is urgent.
    const fresh = await live.facts();
    if (typeof repair.preconditions === 'function') {
        const p = repair.preconditions(fresh);
        if (p !== true && !(p && p.ok)) {
            return GATE_FAIL('preconditions', (p && p.reason) || 'شرایط لازم دیگر برقرار نیست');
        }
    }
    if (repair.requiresEnginesQuiet !== false) {
        const quiet = await live.enginesQuiet();
        if (!quiet) return GATE_FAIL('engines', 'یکی از موتورهای برنامه در حال اجرا یا تغییر وضعیت است');
    }

    // 5 — the tier, recomputed. If exposure has become traffic-visible since the offer, a
    // confirmation the user gave for a lower tier no longer covers it.
    const tier = tierOf(repair, fresh);
    if (tier !== tokenCheck.tier) {
        return GATE_FAIL('tier', `سطح خطر این کار از «${tokenCheck.tier}» به «${tier}» تغییر کرده و باید دوباره تأیید شود`);
    }

    // 6 — the token: single-use, bound to (session, repair, generation), unexpired.
    if (!tokenCheck.valid) return GATE_FAIL('token', tokenCheck.reason || 'تأیید معتبر نیست');

    return { ok: true, tier, facts: fresh };
}

/**
 * Run one repair: gate → capture → journal(intent) → apply → journal(applied) → settle.
 *
 * Verification is NOT here. It is a separate engine with its own three levels, because
 * "the command returned 0" and "the user's problem is gone" are different claims and fusing
 * them is how a repair reports success on a machine that is still broken.
 */
async function apply(repair, session, tokenCheck, live, deps) {
    const d = deps || {};
    const g = await gate(repair, session, tokenCheck, live);
    if (!g.ok) return { ok: false, outcome: 'gate-refused', step: g.step, reason: g.reason };

    const pre = await repair.capture(g.facts, d);
    journal.writeIntent({
        sessionId: session.sessionId,
        repairId: repair.id,
        generation: session.generation.current,
        target: repair.target ? repair.target(g.facts) : { kind: 'machine' },
        preState: pre,
    });

    let result;
    try {
        result = await repair.apply({ facts: g.facts, pre, deps: d });
    } catch (e) {
        result = { ok: false, reason: e.message };
    }
    // Written whether it succeeded or not: recovery has to be able to tell "we tried" from
    // "we never got there", and only this marker distinguishes them.
    journal.markApplied(session.sessionId, repair.id, result);

    if (!result.ok) {
        if (repair.reversible && typeof repair.rollback === 'function') {
            try { await repair.rollback(pre, d); } catch (e) { /* reported by verification */ }
        }
        journal.resolve(session.sessionId, repair.id, 'failed');
        return { ok: false, outcome: 'failed', reason: result.reason, pre };
    }

    // Settle by CONDITION, not by sleeping. DHCP and adapter changes are not instant, and a
    // fixed sleep is simultaneously too short (a working repair looks failed) and too long.
    if (repair.settle && typeof repair.settle.condition === 'function') {
        const cap = repair.settle.maxMs || 5000;
        const start = S.monoNow();
        for (;;) {
            let ok = false;
            try { ok = await repair.settle.condition(d); } catch (e) { ok = false; }
            if (ok || S.monoNow() - start > cap) break;
            await new Promise(r => setTimeout(r, 250));
        }
    }

    // Resolve the journal entry on the SUCCESS path too.
    //
    // Leaving it outstanding was a real bug, caught by independent validation: a completed
    // `dns.flush` left `dns.flush:applied` on disk, and startup recovery — whose table says
    // "applied and the change is still present ⇒ restore the pre-state" — would have rolled
    // back a repair that worked, at the next launch, with nobody watching. The journal exists
    // for INTERRUPTED repairs; a repair that reached a decision is not interrupted.
    //
    // `holdForVerification` is for the caller that intends to verify and may need to roll back
    // on a genuine regression. It must resolve the entry itself once the outcome is known, and
    // until it does, a crash correctly leaves recovery able to undo the change.
    if (!d.holdForVerification) {
        journal.resolve(session.sessionId, repair.id, 'applied');
    }

    return { ok: true, outcome: 'applied', pre, log: result.log || null, journalHeld: !!d.holdForVerification };
}

/**
 * The «همه را درست کن» batch.
 *
 * Sequential, under one lock held for the WHOLE batch, and it stops at the first failure. Two
 * auto repairs running together is not a speed-up: flushing the DNS cache while the Dnscache
 * service is starting produces a state that is neither the pre-state nor the post-state, and
 * the journal then holds a pre-state that never described reality.
 */
async function applyAuto(repairs, session, tokens, live, deps) {
    const outcomes = [];
    try {
        await mutex.withLock('netdiag:repair-batch', async () => {
            for (const r of repairs) {
                const res = await apply(r, session, tokens[r.id] || { valid: false, reason: 'no token' }, live, deps);
                outcomes.push(Object.assign({ repairId: r.id }, res));
                if (!res.ok) break;                    // abort the batch, then re-diagnose
            }
        });
    } catch (e) {
        if (e.code === 'MUTEX_BUSY') {
            return { ok: false, reason: 'یک عملیات شبکهٔ دیگر در حال اجراست', heldBy: e.heldBy, outcomes };
        }
        throw e;
    }
    return { ok: outcomes.every(o => o.ok), outcomes };
}

module.exports = {
    TIER, EXPOSURE, registry, byId, tierOf, tierReason, gate, apply, applyAuto,
};
