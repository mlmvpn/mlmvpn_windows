/*
 * NetDiag — the wave runner.
 *
 * Runs collectors in fixed coarse stages W0…W5, inside ONE total wall-clock budget, and hands
 * whatever was gathered to the pure diagnosis engine. Its job is to make sure that a broken
 * machine still produces a diagnosis, and that a changing machine cannot produce a confident
 * wrong one.
 *
 * Four properties are non-negotiable, and each of them is a lesson rather than a preference:
 *
 *   never abort a wave        `Promise.allSettled` throughout. One collector throwing must not
 *                             cost the twelve readable facts collected beside it.
 *
 *   a deadline is not an error
 *                             Whatever exists when time runs out gets diagnosed. W0 is
 *                             local-only and always completes, so even a completely dead line
 *                             produces a substantial answer.
 *
 *   gate by fact, never by pass/fail
 *                             A collector self-skips only when a pure predicate over already
 *                             collected facts proves it pointless, and the skip is RECORDED as
 *                             a fact with that predicate as its reason. Skipping dependent
 *                             work because "the previous layer failed" is what destroys the
 *                             evidence needed to tell two causes apart.
 *
 *   sample the machine, not a photograph
 *                             The fingerprint is taken at wave boundaries. If it changes, the
 *                             generation advances and nothing spanning the boundary may ever
 *                             be `confirmed` — the app itself can bring a tunnel up mid-run.
 */

'use strict';

const F = require('./facts');
const S = require('./session');
const P = require('./probe');

/** Concurrency caps. A broken line plus twenty parallel sockets manufactures its own faults. */
const CAP = Object.freeze({ network: 6, powershell: 3 });

const WAVES = Object.freeze(['w0', 'w1', 'w2', 'w3', 'w4', 'w5']);

/**
 * Run one diagnostic session.
 *
 * `deps` is injected so the whole runner can be exercised with fake collectors and a fake
 * fingerprint — no Windows, no network, no clock.
 */
async function run(opts) {
    const o = opts || {};
    const collectors = o.collectors || require('./collectors');
    const readFingerprint = o.readFingerprint || (async () => S.fingerprint({}));
    const onProgress = o.onProgress || (() => {});
    const session = o.session || S.createSession({ mode: o.mode || 'full', host: o.host });

    const ctx = {
        session,
        cancelled: false,
        cancel() { ctx.cancelled = true; },
        log: o.log || (() => {}),
        capNetwork: CAP.network,
        put(fact) { return S.putFact(session, fact); },
        /** Milliseconds a collector may take, never more than what remains of the total. */
        budgetFor(ms) { return Math.max(0, Math.min(ms, S.remainingMs(session))); },
        deps: o.deps || {},
    };
    if (o.signal) o.signal.onCancel = () => ctx.cancel();

    // ── W0 opens with a fingerprint so every later sample has something to compare against.
    await sample(session, readFingerprint, 'start');

    for (const wave of WAVES) {
        if (ctx.cancelled) break;
        if (S.remainingMs(session) <= session.subBudgetMs.diagnose + session.subBudgetMs.reserve) {
            recordWaveSkip(session, wave, 'global deadline reached');
            continue;
        }
        onProgress({ phase: wave, percent: percentFor(session), collectorId: null });
        await runWave(ctx, collectors.filter(c => c.wave === wave), wave, onProgress);

        // After W2 and after W5 — the two points where the machine has had time to change and
        // where a change would silently corrupt the correlation.
        if (wave === 'w2' || wave === 'w5') await sample(session, readFingerprint, `after-${wave}`);
    }

    // ── the bounded discriminator round ──
    //
    // Eligibility depends on elapsed time, which is not a fact, so the DECISION is written to
    // the session. Replay then reads the recorded decision instead of re-timing, which keeps
    // the collection path reproducible while still allowing a time-bounded round at run time.
    const budget = S.discriminatorBudget(session);
    session.discriminator.eligible = budget.eligible;
    session.discriminator.reason = budget.reason;
    if (budget.eligible && !ctx.cancelled && typeof o.selectDiscriminators === 'function') {
        const chosen = o.selectDiscriminators(session.facts) || [];
        session.discriminator.selected = chosen.map(c => c.id);
        if (chosen.length) {
            onProgress({ phase: 'discriminate', percent: percentFor(session), collectorId: null });
            await runWave(ctx, chosen, 'discriminate', onProgress, budget.ms);
        }
    }

    onProgress({ phase: 'diagnose', percent: 95, collectorId: null });
    S.finish(session, ctx.cancelled);
    onProgress({ phase: 'done', percent: 100, collectorId: null });
    return session;
}

/**
 * Run every collector in one wave.
 *
 * Collectors inside a wave are independent by construction — that is what makes a wave a
 * wave — so they run together under a concurrency cap rather than in sequence, and a broken
 * machine's timeouts overlap instead of adding up.
 */
async function runWave(ctx, list, waveName, onProgress, waveBudgetMs) {
    const started = P.monoNow();
    await P.pool(list, ctx.capNetwork, async (c) => {
        if (ctx.cancelled) return recordCollector(ctx.session, c, 'cancelled', 0, null, 'run cancelled');

        if (waveBudgetMs && P.monoNow() - started > waveBudgetMs) {
            return recordCollector(ctx.session, c, 'skipped', 0, null, 'wave budget exhausted');
        }

        // Declarative precondition. A pure predicate over the facts collected so far, and its
        // verdict is recorded so the report can say WHY something was not measured — which is
        // the difference the user sees between "we checked and it was fine" and "we never
        // looked".
        if (typeof c.when === 'function') {
            let gate;
            try { gate = c.when(ctx.session.facts); } catch (e) { gate = { skip: `precondition threw: ${e.message}` }; }
            if (gate && gate.skip) {
                for (const id of c.produces || []) {
                    safePut(ctx.session, F.skipped(id, gate.skip));
                }
                return recordCollector(ctx.session, c, 'skipped', 0, null, gate.skip);
            }
        }

        onProgress({ phase: waveName, percent: percentFor(ctx.session), collectorId: c.id });
        const t0 = P.monoNow();
        const timeout = ctx.budgetFor(c.timeout || 5000);
        let state = 'ok', error = null;
        try {
            await P.withDeadline(
                Promise.resolve(c.run(ctx)),
                timeout,
                () => { throw new Error(`timed out after ${timeout}ms`); },
            );
        } catch (e) {
            state = /timed out/.test(e.message) ? 'timeout' : 'error';
            error = e.message;
            // Anything the collector promised but did not deliver becomes UNKNOWN — never
            // false. A collector that dies must not look like a collector that observed
            // absence.
            for (const id of c.produces || []) {
                safePut(ctx.session, F.unknown(id, `${c.id}: ${error}`));
            }
        }
        // The same backstop for a collector that returned normally but forgot a fact it
        // declared. Silence about a promised observation is unknown, by definition.
        for (const id of c.produces || []) {
            safePut(ctx.session, F.unknown(id, `${c.id}: not produced`));
        }
        recordCollector(ctx.session, c, state, P.monoNow() - t0, error, null);
    });
}

/** Write only if absent — a real observation always wins over a backstop unknown. */
function safePut(session, fact) {
    if (Object.prototype.hasOwnProperty.call(session.facts, fact.id)) return null;
    return S.putFact(session, fact);
}

function recordCollector(session, c, state, ms, error, skippedReason) {
    session.collectors.push({
        id: c.id, wave: c.wave, label: c.label || null,
        state, ms, error: error || null, skippedReason: skippedReason || null,
        whenPredicate: c.whenText || null,
    });
}

function recordWaveSkip(session, wave, reason) {
    session.events.push({ atMono: P.monoNow(), type: 'wave-skipped', wave, reason });
}

async function sample(session, readFingerprint, label) {
    try {
        const fp = await readFingerprint();
        return S.sampleGeneration(session, fp, label);
    } catch (e) {
        S.markUnstable(session, `fingerprint unreadable at ${label}: ${e.message}`);
        return null;
    }
}

function percentFor(session) {
    const used = S.elapsedMs(session);
    return Math.max(1, Math.min(94, Math.round((used / session.budgetMs) * 94)));
}

module.exports = { run, runWave, CAP, WAVES };
