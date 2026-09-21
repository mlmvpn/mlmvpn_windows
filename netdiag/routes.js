/*
 * NetDiag HTTP surface.
 *
 * Self-mounting, following the convention the rest of the app uses
 * (`require('./systemcheck')(app)` at server.js:3841).
 *
 * The guards below are here from the first commit rather than added in a later hardening
 * pass. This process runs as Administrator and binds 127.0.0.1 with no authentication on any
 * existing route; adding one more open privileged endpoint "for now" is how "for now" becomes
 * permanent. They are also cheap — three checks and a token.
 *
 * What they do and do not buy, stated plainly so nobody mistakes their reach:
 *
 *   Host allowlist   THE anti-rebinding control. A page that rebinds DNS to 127.0.0.1 still
 *                    carries its own hostname in Host, and that is what this rejects.
 *   Origin check     stops ordinary cross-origin CSRF from any browser page.
 *   token            defence in depth only. It is injected into index.html, which is served
 *                    by an unauthenticated GET /, so any local process can read it in one
 *                    request. It raises the bar for blind callers and nothing more.
 *
 * A malicious process running as the same Windows user is explicitly OUT of scope, and that
 * is a documented boundary rather than an oversight: POST /api/proxy/system (server.js:1885)
 * already performs the same privileged registry write with no authentication at all, so
 * hardening only these routes would imply a protection that does not exist.
 *
 * Repairs are not mounted here. They arrive in phase 6 with the journal, the mutex and the
 * generation-bound confirmToken, and until then this surface is read-only by construction.
 */

'use strict';

const crypto = require('crypto');

const S = require('./session');
const D = require('./diagnose');
const engine = require('./engine');
const defaultCollectors = require('./collectors');
const rules = require('./rules');
const repairs = require('./repairs');
const tokens = require('./tokens');
const live = require('./live');
const verify = require('./verify');
const V = verify;
const journal = require('./journal');
const report = require('./report');

/** Per-process, regenerated every start. Never persisted, never logged. */
const TOKEN = crypto.randomBytes(24).toString('hex');

/** Sessions live in memory for the life of the process; disk copies are redacted (§28). */
const sessions = new Map();
const running = new Map();
const MAX_LIVE_SESSIONS = 10;

/**
 * The port the request actually arrived on.
 *
 * Read from the socket rather than from a variable captured at mount time: the server falls
 * back to a random port when its preferred one is taken (server.js:3640), so a captured value
 * can be wrong — and a Host check comparing against the wrong port either rejects everything
 * or, worse, is quietly disabled.
 */
function localPortOf(req) {
    return (req.socket && req.socket.localPort) || 0;
}

function hostAllowed(req) {
    const port = localPortOf(req);
    const h = String(req.headers.host || '').toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

function originAllowed(req) {
    const o = req.headers.origin;
    if (o === undefined) {
        // Absent Origin is fine for a plain GET a user typed, but never for a state-changing
        // request: some cross-origin requests omit it, so absence must not be a free pass.
        return req.method === 'GET';
    }
    const port = localPortOf(req);
    const ok = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
    return ok.includes(String(o).toLowerCase());
}

function guard() {
    return (req, res, next) => {
        if (!hostAllowed(req)) {
            return res.status(403).json({ ok: false, error: 'bad host' });
        }
        if (!originAllowed(req)) {
            return res.status(403).json({ ok: false, error: 'bad origin' });
        }
        if (req.method !== 'GET' && !/^application\/json/i.test(String(req.headers['content-type'] || ''))) {
            return res.status(415).json({ ok: false, error: 'content-type must be application/json' });
        }
        if (req.headers['x-netdiag-token'] !== TOKEN) {
            return res.status(401).json({ ok: false, error: 'missing or invalid token' });
        }
        return next();
    };
}

/** Trim the in-memory set; the on-disk copies are pruned by session.persist(). */
function remember(session) {
    sessions.set(session.sessionId, session);
    if (sessions.size > MAX_LIVE_SESSIONS) {
        const oldest = [...sessions.keys()][0];
        sessions.delete(oldest);
    }
}

/**
 * What the client is allowed to see.
 *
 * The redacted session plus the narrative. Repairs are reported as ids only — there is no
 * execution path behind them yet, and shipping a button before its safety machinery exists is
 * how a "temporary" endpoint applies an unguarded privileged change.
 */
function present(session, result) {
    return {
        session: S.redact(session),
        narrative: result ? {
            headline: result.headline,
            rootCauses: result.rootCauses.map(slim),
            consequences: result.consequences.map(slim),
            independent: result.independent.map(slim),
            unresolved: result.unresolved.map(slim),
            byDesign: result.byDesign.map(slim),
            missingEvidence: result.missingEvidence,
        } : null,
    };
}

function slim(e) {
    return {
        id: e.id, title: e.title, verdict: e.verdict, category: e.category,
        consequenceOf: e.consequenceOf, caps: e.caps, conflicts: e.conflicts,
        unknownMass: Number(e.unknownMass.toFixed(2)), missing: e.missing,
        repairs: e.repairs, reason: e.reason,
    };
}

/**
 * Turn the repair ids a diagnosis produced into concrete offers, each with its own token.
 *
 * This is where the capability model is actually enforced. A repair that appears here was
 * offered by the engine, for a hypothesis that survived, against the machine as it is in this
 * generation — and a caller with no token for it cannot invoke it at all, because the gate has
 * nothing to check and refuses.
 */
function offersFor(session, result) {
    if (!result) return [];
    const out = [];
    const seen = new Set();
    for (const e of [...result.rootCauses, ...result.independent]) {
        for (const repairId of e.repairs || []) {
            if (seen.has(repairId)) continue;
            const repair = repairs.byId.get(repairId);
            if (!repair) continue;                     // a rule naming a repair we do not ship
            seen.add(repairId);
            const tier = repairs.tierOf(repair, session.facts);
            out.push({
                repairId,
                forHypothesis: e.id,
                label: repair.label,
                hint: repair.hint,
                tier,
                tierReason: repairs.tierReason(repair, session.facts),
                exposure: repair.exposure,
                reversible: repair.reversible,
                requiresReboot: repair.requiresReboot,
                confirmToken: tokens.issue(session.sessionId, repairId, session.generation.current, tier),
            });
        }
    }
    return out;
}

/**
 * Verify a repair, at all three levels.
 *
 * Re-collection is a fresh run of only the collectors the repair declared in `verifyWith`, not
 * a whole wave set: verifying is not diagnosing again, and a full re-run would take the machine
 * further from the state the repair just produced.
 *
 * The baseline for the functional level comes from the pre-repair session, which is why the
 * pre-repair facts are kept rather than overwritten — «۳ از ۵ کار می‌کند» means nothing without
 * knowing it was 1 of 5 before.
 */
async function verifyAfter(session, repair, applied, deps) {
    const d = deps || {};
    const beforeFacts = session.facts;

    // A second, independent fact map. Facts are immutable, so this is a diff rather than an
    // overwrite — the evidence the diagnosis rests on survives the repair.
    const after = {};
    const probe = { session: Object.assign({}, session, { facts: after }), put: f => { after[f.id] = f; } };
    try {
        const collectors = (d.collectors || defaultCollectors)
            .filter(c => (repair.verifyWith || []).includes(c.id));
        for (const c of collectors) {
            await c.run({
                session: probe.session,
                put: probe.put,
                cancelled: false,
                capNetwork: 4,
                budgetFor: ms => Math.min(ms, 8000),
                deps: d.repairDeps || {},
                log: () => {},
            });
        }
    } catch (e) {
        // A failed re-collection is lost visibility, not a regression. The levels below will
        // report `unverifiable` rather than blaming the repair.
    }

    const hypothesis = (rules.byId && rules.byId.get)
        ? rules.byId.get((repair.forHypotheses || [])[0])
        : null;

    const direct = V.direct(hypothesis, Object.assign({}, beforeFacts, after), D.diagnose);
    const functionalTargets = functionalFrom(after);
    const functional = V.functional(functionalTargets, functionalFrom(beforeFacts));
    const regression = V.regression(beforeFacts, after, repair.expectedChanges || []);
    return Object.assign(V.decide({ direct, functional, regression }), { atWall: new Date().toISOString() });
}

/**
 * The functional level's targets, read out of a fact map.
 *
 * Grouped so the majority rule counts independent networks rather than addresses — one lucky
 * endpoint is not proof the user's problem is gone.
 */
function functionalFrom(facts) {
    const pick = (id, group) => {
        const f = facts[id];
        if (!f) return null;
        return { id, group, ok: f.status === 'observed' ? !!f.value : null };
    };
    return [
        pick('proxy.http.bypass.ok', 'direct'),
        pick('proxy.http.via.ok', 'proxy'),
        pick('dns.resolve.ok.v4', 'dns'),
        pick('reach.foreign.status.v4', 'foreign'),
    ].filter(Boolean).map(x => (x.id === 'reach.foreign.status.v4'
        ? { id: x.id, group: x.group, ok: x.ok === null ? null : (facts[x.id].value === 'ok') }
        : x));
}

/** Run under the shared network-mutation lock, reporting a busy lock rather than throwing. */
async function mutexWrapped(fn) {
    const mutex = require('./mutex');
    try {
        return await mutex.withLock('netdiag:repair', fn);
    } catch (e) {
        if (e.code === 'MUTEX_BUSY' || e.code === 'MUTEX_TIMEOUT') {
            return { ok: false, mutexBusy: true, heldBy: e.heldBy, outcome: 'busy' };
        }
        throw e;
    }
}

module.exports = function mountNetdiag(app, deps) {
    const d = deps || {};
    const broadcast = d.broadcast || (() => {});
    // Injectable so the HTTP contract can be tested against a stub wave set — the guards and
    // the session lifecycle are what those tests are about, and making them wait on real
    // sockets would put the network back into a suite that must not depend on it.
    const collectors = d.collectors || defaultCollectors;
    const g = guard();

    /**
     * Progress only — never facts.
     *
     * The shared /ws accepts any Origin (server.js:36), so anything published there is
     * readable by any local process. Adapter names, local addresses, DNS servers and proxy
     * endpoints stay on the authenticated REST route; the socket carries a stage id and a
     * percentage.
     */
    const emit = (sessionId, p) => broadcast('netdiag', {
        sessionId, phase: p.phase, percent: p.percent, collectorId: p.collectorId || null,
    });

    app.post('/api/netdiag/start', g, async (req, res) => {
        try {
            const mode = req.body && req.body.mode === 'quick' ? 'quick' : 'full';
            const session = S.createSession({ mode });
            remember(session);
            running.set(session.sessionId, session);
            res.json({ ok: true, sessionId: session.sessionId, mode, budgetMs: session.budgetMs });

            // Runs after the response: the client polls or listens on /ws. A 35-second request
            // would hit every proxy and client timeout between here and the renderer.
            engine.run({
                session, collectors,
                readFingerprint: d.readFingerprint,
                onProgress: p => emit(session.sessionId, p),
            }).then(done => {
                done.diagnosis = D.diagnose(done.facts, rules);
                S.persist(done);
                running.delete(done.sessionId);
                emit(done.sessionId, { phase: 'done', percent: 100 });
            }).catch(err => {
                running.delete(session.sessionId);
                session.events.push({ type: 'run-failed', reason: err.message });
                emit(session.sessionId, { phase: 'done', percent: 100 });
            });
        } catch (e) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/netdiag/session/:id', g, (req, res) => {
        const s = sessions.get(req.params.id);
        if (!s) return res.status(404).json({ ok: false, error: 'unknown session' });
        const result = s.diagnosis || (s.finishedAtMono ? D.diagnose(s.facts, rules) : null);

        // Offers, and their tokens, are minted here — when the user is actually shown the
        // choice. Minting them earlier would hand out confirmations for a machine state nobody
        // has looked at yet; minting them at repair time would make them meaningless.
        if (result && s.finishedAtMono && !s.offers) s.offers = offersFor(s, result);

        res.json(Object.assign({ ok: true, done: !!s.finishedAtMono, offers: s.offers || [] },
            present(s, result)));
    });

    app.post('/api/netdiag/cancel', g, (req, res) => {
        const s = running.get(req.body && req.body.sessionId);
        if (!s) return res.status(404).json({ ok: false, error: 'no such running session' });
        s.cancelled = true;
        res.json({ ok: true });
    });

    /**
     * The capability-style repair endpoint.
     *
     * The body carries `{ sessionId, repairId, confirmToken }` and NOTHING else. No adapter
     * name, no interface index, no MTU value, no free string — every argument a privileged
     * operation will use comes from the server-side session and from fresh reads at gate time.
     * Command injection is impossible by construction rather than by escaping, and it stays
     * impossible even for a caller that is otherwise fully trusted, which matters because the
     * same-user local process is a documented out-of-scope attacker.
     */
    app.post('/api/netdiag/repair', g, async (req, res) => {
        try {
            const body = req.body || {};
            // Shape first. Anything but three strings is rejected before it reaches state.
            for (const k of ['sessionId', 'repairId', 'confirmToken']) {
                if (typeof body[k] !== 'string' || body[k].length > 128) {
                    return res.status(400).json({ ok: false, error: `bad ${k}` });
                }
            }
            const extra = Object.keys(body).filter(k => !['sessionId', 'repairId', 'confirmToken'].includes(k));
            if (extra.length) {
                // An extra field is a caller trying to reach a parameter path that does not
                // exist. Refusing is cheaper than proving each one is ignored.
                return res.status(400).json({ ok: false, error: `unexpected field(s): ${extra.join(', ')}` });
            }

            const session = sessions.get(body.sessionId);
            if (!session) return res.status(404).json({ ok: false, error: 'unknown session' });

            const repair = repairs.byId.get(body.repairId);
            if (!repair) return res.status(404).json({ ok: false, error: 'unknown repair' });

            // The offer must have come from THIS session's diagnosis. A repair that exists in
            // the registry but was never offered here cannot be invoked.
            const offered = (session.offers || []).some(o => o.repairId === body.repairId);
            if (!offered) return res.status(409).json({ ok: false, error: 'this repair was not offered for this session' });

            const check = tokens.check(body.confirmToken, body.sessionId, body.repairId, session.generation.current);
            tokens.consume(body.confirmToken);      // burned on attempt, not on success
            if (!check.valid) return res.status(409).json({ ok: false, error: check.reason });

            const liveState = live.make(session, d);
            const outcome = await mutexWrapped(() => repairs.apply(repair, session, check, liveState, Object.assign({ holdForVerification: true }, d.repairDeps || {})));
            if (outcome.mutexBusy) {
                return res.status(409).json({ ok: false, error: 'یک عملیات شبکهٔ دیگر در حال اجراست', heldBy: outcome.heldBy });
            }

            session.actions.push(Object.assign({ repairId: body.repairId, atWall: new Date().toISOString() }, outcome));

            let verification = null;
            if (outcome.ok) {
                // The repair's own return value is not evidence that the user's problem is
                // gone, so verification runs here and its answer — not the apply result — is
                // what the report's last two sections are built from.
                verification = await verifyAfter(session, repair, outcome, d);
                session.verifications.push(Object.assign({ repairId: body.repairId }, verification));

                if (verification.rollbackAdvised && repair.reversible && typeof repair.rollback === 'function') {
                    // A genuine regression outranks a fix: the repair solved its target and
                    // broke something else, which makes it a rollback candidate rather than a
                    // success.
                    try {
                        const rb = await repair.rollback(outcome.pre, d.repairDeps || {});
                        verification.rolledBack = !!(rb && rb.ok);
                        verification.rollbackReason = rb && rb.reason;
                    } catch (e) {
                        verification.rolledBack = false;
                        verification.rollbackReason = e.message;
                    }
                }
                // The journal was held open for exactly this decision; it can be resolved now.
                journal.resolve(body.sessionId, body.repairId, verification.outcome);

                // Every other offer was computed against the machine as it was BEFORE this
                // change, so every other token now describes a state that no longer holds.
                tokens.revokeSession(body.sessionId);
                session.offers = null;
            }
            return res.json({
                ok: outcome.ok,
                outcome: outcome.outcome,
                reason: outcome.reason || null,
                verification: verification && {
                    outcome: verification.outcome,
                    wording: verify.WORDING[verification.outcome] || null,
                    rolledBack: verification.rolledBack || false,
                    rediagnose: !!verification.rediagnose,
                },
            });
        } catch (e) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    /**
     * The report, generated server-side from the session.
     *
     * One generator, not two. The panel used to build its own text, which meant the wording
     * contract lived in two places and could drift — and the half that drifts is the half a
     * user pastes into a support chat.
     */
    app.get('/api/netdiag/report/:id', g, (req, res) => {
        const s = sessions.get(req.params.id);
        if (!s) return res.status(404).json({ ok: false, error: 'unknown session' });
        const result = s.diagnosis || (s.finishedAtMono ? D.diagnose(s.facts, rules) : null);
        res.json({ ok: true, text: report.buildReport(s, result) });
    });

    app.get('/api/netdiag/history', g, (req, res) => {
        res.json({
            ok: true,
            sessions: [...sessions.values()].map(s => ({
                sessionId: s.sessionId, mode: s.mode,
                startedAtWall: s.startedAtWall, finishedAtWall: s.finishedAtWall,
                cancelled: s.cancelled, factCount: Object.keys(s.facts).length,
                headline: s.diagnosis ? s.diagnosis.headline : null,
            })),
        });
    });

    return { TOKEN, sessions };
};

module.exports.TOKEN = TOKEN;
