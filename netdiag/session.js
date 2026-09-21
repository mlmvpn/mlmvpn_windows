/*
 * NetDiag — the Session Store (SystemSnapshot).
 *
 * One serializable record of one diagnostic run. Everything else reads and writes only this,
 * which is what makes the reasoning replayable from a file, testable with no Windows and no
 * network, and reportable without re-probing a machine that has since changed.
 *
 * The part that is easy to underestimate is the GENERATION model.
 *
 * A full run takes up to 35 seconds, and on this product the app itself is a mutator —
 * auto-connect can bring a tunnel up mid-run. Without generations, W0 can record "no engine
 * running, DNS from DHCP" and W3 can then see loopback DNS, and the pair looks like a
 * decisive "stranded loopback DNS" — whose repair rips DNS out from under a live tunnel.
 * Facts being immutable and timestamped is necessary but not sufficient: immutability says
 * WHAT was seen, generations say whether two facts may safely be correlated at all.
 *
 * The mechanism is deliberately one integer plus a cheap fingerprint, not a state-versioning
 * subsystem. Sample the fingerprint at the run's boundaries; if it changed, the generation
 * advances; evidence spanning generations can never be `confirmed`.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const F = require('./facts');

const SESSION_DIR = path.join(os.homedir(), '.mlmvpn', 'netdiag');
const KEEP_SESSIONS = 10;
const SCHEMA_VERSION = 3;

/** Total wall-clock budgets. One number per mode; nothing is ever added to them (v3.1 §3). */
const BUDGET_MS = Object.freeze({
    full: 35000,
    quick: 8000,
});

/** Sub-budgets carved out of the total, so the user-visible number stays predictable. */
const SUB_BUDGET_MS = Object.freeze({
    full: { collect: 27000, discriminate: 5000, diagnose: 1000, reserve: 2000 },
    quick: { collect: 6500, discriminate: 0, diagnose: 1000, reserve: 500 },
});

/**
 * Time that must survive the discriminator round: diagnosis, narrative, and the reserve.
 * Nothing may spend into it, which is what keeps the total honest.
 */
const DISCRIMINATOR_TAIL_RESERVE_MS = 3000;

/**
 * The round runs only if its full sub-budget AND the tail both still fit.
 *
 * Derived, not typed in twice. When these were two independent constants they happened to be
 * 5000 and 3000 against a threshold of 8000, which made the clamp inside discriminatorBudget
 * unreachable — a branch that looked like a safety net and could never fire. Deriving the
 * threshold keeps them from drifting apart, and the clamp stays as genuine defence in depth
 * for the day someone changes one of them.
 */
const DISCRIMINATOR_MIN_REMAINING_MS = SUB_BUDGET_MS.full.discriminate + DISCRIMINATOR_TAIL_RESERVE_MS;

// ── monotonic time ──────────────────────────────────────────────────────────────────────
//
// Every duration, deadline and timeout uses the monotonic clock. This is not stylistic:
// clock skew is one of the things this engine diagnoses, W32Time may sync mid-session, and a
// time repair may run — any of which makes a Date.now() delta meaningless, including the
// deltas that decide whether a probe timed out.

function monoNow() {
    return Number(process.hrtime.bigint() / 1000000n);
}

// ── the state fingerprint ───────────────────────────────────────────────────────────────

/**
 * Hash the machine's network identity.
 *
 * `parts` is supplied by the caller (collectors/topology in later phases) so that this module
 * stays pure and testable. Anything the caller could not read must be passed as the literal
 * string 'unknown' rather than omitted — a fingerprint that silently shortens when a read
 * fails would hide the very change it exists to detect.
 */
function fingerprint(parts) {
    const norm = normaliseForFingerprint(parts);
    const json = JSON.stringify(norm);
    return {
        hash: crypto.createHash('sha256').update(json).digest('hex').slice(0, 32),
        keys: norm,
    };
}

/** Stable key order and lower-cased identities, so cosmetic differences do not fake a change. */
function normaliseForFingerprint(parts) {
    const p = parts || {};
    const arr = v => (Array.isArray(v) ? v.map(x => String(x).toLowerCase()).sort() : 'unknown');
    return {
        interfaces: arr(p.interfaces),        // guid|luid|status per adapter
        addresses: arr(p.addresses),          // family|ip|prefix|addressState
        defaultRoutes: arr(p.defaultRoutes),  // family|prefix|nexthop|ifguid|metric
        dnsServers: arr(p.dnsServers),        // ifguid|family|server
        proxy: typeof p.proxy === 'string' ? p.proxy.toLowerCase() : 'unknown',
        engines: arr(p.engines),              // engineId|running
    };
}

/** Which fingerprint keys differ. Reportable evidence in its own right, not just a flag. */
function changedKeys(a, b) {
    const out = [];
    for (const k of Object.keys(a || {})) {
        if (JSON.stringify(a[k]) !== JSON.stringify((b || {})[k])) out.push(k);
    }
    return out;
}

// ── session lifecycle ───────────────────────────────────────────────────────────────────

/**
 * A 128-bit random session id.
 *
 * Not `nd-<timestamp>`: a predictable id lets a caller that has the token address a live
 * session it never created, and the whole capability-repair model rests on a repair being
 * addressable only through the session that offered it.
 */
function newSessionId() {
    return crypto.randomBytes(16).toString('hex');
}

function createSession(opts) {
    const o = opts || {};
    const mode = o.mode === 'quick' ? 'quick' : 'full';
    return {
        version: SCHEMA_VERSION,
        sessionId: o.sessionId || newSessionId(),
        mode,
        budgetMs: BUDGET_MS[mode],
        subBudgetMs: SUB_BUDGET_MS[mode],
        startedAtWall: o.startedAtWall || new Date().toISOString(),
        startedAtMono: typeof o.startedAtMono === 'number' ? o.startedAtMono : monoNow(),
        finishedAtWall: null,
        finishedAtMono: null,
        cancelled: false,
        host: o.host || {},
        generation: { current: 0, unstable: false, samples: [] },
        topology: null,
        app: {},
        facts: {},
        collectors: [],
        hypotheses: [],
        narrative: { rootCauses: [], consequences: [], independent: [], unresolved: [], scopeNotes: [] },
        actions: [],
        verifications: [],
        discriminator: { eligible: null, selected: [], reason: null },
        events: [],
    };
}

/** Milliseconds consumed so far, on the monotonic clock. */
function elapsedMs(session, nowMono) {
    return (typeof nowMono === 'number' ? nowMono : monoNow()) - session.startedAtMono;
}

/** Milliseconds left in the ONE total budget. Never negative. */
function remainingMs(session, nowMono) {
    return Math.max(0, session.budgetMs - elapsedMs(session, nowMono));
}

/**
 * May the bounded discriminator round run, and for how long?
 *
 * The decision is recorded on the session rather than recomputed later, because replay must
 * reproduce the collection decisions as well as the reasoning — and elapsed time is not a
 * fact. Selection stays a pure function of the fact map; only the permission to run was ever
 * time-dependent (v3.1 §6).
 */
function discriminatorBudget(session, nowMono) {
    if (session.mode === 'quick') {
        return { eligible: false, ms: 0, reason: 'quick-mode' };
    }
    const left = remainingMs(session, nowMono);
    if (left < DISCRIMINATOR_MIN_REMAINING_MS) {
        return { eligible: false, ms: 0, reason: `only ${left}ms of the total budget remained` };
    }
    const ms = Math.min(session.subBudgetMs.discriminate, left - DISCRIMINATOR_TAIL_RESERVE_MS);
    return { eligible: ms > 0, ms: Math.max(0, ms), reason: ms > 0 ? null : 'no room after tail reserve' };
}

// ── facts ───────────────────────────────────────────────────────────────────────────────

/**
 * Record a fact, stamped with the current generation and the monotonic clock.
 *
 * Refuses to overwrite. Facts are immutable: a second observation of the same thing belongs
 * in a second fact map (post-repair), which is what verification diffs. Overwriting would
 * destroy the evidence the original diagnosis was built on.
 */
function putFact(session, fact) {
    if (!fact || !fact.id) throw new Error('putFact requires a fact with an id');
    if (Object.prototype.hasOwnProperty.call(session.facts, fact.id)) {
        throw new Error(`fact ${fact.id} already recorded — facts are immutable within a session`);
    }
    if (fact.status !== F.STATUS.OBSERVED && fact.value !== undefined) {
        // Belt and braces: facts.js already refuses this, but a hand-built fact could slip
        // through, and a value on a non-observed fact is exactly how "could not read" becomes
        // "false" three layers later.
        throw new Error(`fact ${fact.id} is ${fact.status} but carries a value`);
    }
    fact.gen = session.generation.current;
    if (!fact.atMono) fact.atMono = monoNow();
    session.facts[fact.id] = fact;
    return fact;
}

function putFacts(session, facts) {
    for (const f of facts || []) putFact(session, f);
}

// ── generations ─────────────────────────────────────────────────────────────────────────

/**
 * Take a fingerprint sample. Returns the (possibly advanced) generation number.
 *
 * Called at: start of W0, after W2, after W5, immediately before every repair apply, and
 * before each verification level.
 */
function sampleGeneration(session, fp, label) {
    const prev = session.generation.samples[session.generation.samples.length - 1] || null;
    const diff = prev ? changedKeys(prev.keys, fp.keys) : [];
    const changed = !!prev && prev.hash !== fp.hash;

    if (changed) {
        session.generation.current += 1;
        session.generation.unstable = true;
    }
    session.generation.samples.push({
        gen: session.generation.current,
        label: label || null,
        atMono: monoNow(),
        atWall: new Date().toISOString(),
        hash: fp.hash,
        keys: fp.keys,
        changedKeys: diff,
    });
    return { gen: session.generation.current, changed, changedKeys: diff };
}

/**
 * A defensive advance for when the fingerprint itself could not be read twice running.
 *
 * Marking the session unstable costs some certainty; assuming stability we could not observe
 * costs a wrong repair on a machine we were not actually watching.
 */
function markUnstable(session, reason) {
    session.generation.unstable = true;
    session.events.push({ atMono: monoNow(), type: 'generation-unstable', reason });
}

/**
 * May a verdict built from these facts be `confirmed`?
 *
 * No, if the evidence spans generations. Callers cap at `possible` and say so in the report
 * («وضعیت شبکه در حین بررسی تغییر کرد»).
 */
function mayConfirm(session, factIds) {
    return !F.spansGenerations(session.facts, factIds);
}

// ── persistence ─────────────────────────────────────────────────────────────────────────

/**
 * Strip anything that must not appear in a file the user may paste into a support chat.
 *
 * Local IPs and adapter names stay — they are the diagnostic content and the file never
 * leaves the machine on its own. What goes is anything that would let someone else use the
 * user's configuration: engine UUIDs, keys, tokens, and the credentials that are legal
 * inside a PAC URL.
 */
const REDACT_KEY_PATTERNS = [
    /(^|[._-])(uuid|password|passwd|secret|token|apikey|api_key|key|psk|auth)($|[._-])/i,
];

function redact(session) {
    const clone = JSON.parse(JSON.stringify(session));
    walkRedact(clone);
    delete clone.__token;
    return clone;
}

function walkRedact(node) {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
        const v = node[k];
        if (REDACT_KEY_PATTERNS.some(rx => rx.test(k))) {
            node[k] = '[redacted]';
            continue;
        }
        if (typeof v === 'string') {
            node[k] = redactString(v);
        } else {
            walkRedact(v);
        }
    }
}

const UUID_RX = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const URL_CRED_RX = /(\b[a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+):([^/@\s]+)@/gi;

function redactString(s) {
    // Interface GUIDs are braced and are load-bearing diagnostic identity, so they survive;
    // a bare UUID in a config string is a credential-shaped value and does not.
    return s
        .replace(URL_CRED_RX, '$1[redacted]:[redacted]@')
        .replace(UUID_RX, m => (s.includes(`{${m}}`) ? m : '[redacted-uuid]'));
}

function sessionDir() { return SESSION_DIR; }

function sessionPath(sessionId) {
    return path.join(SESSION_DIR, `session-${sessionId}.json`);
}

/**
 * Persist a redacted copy. Write failure is non-fatal by design — the in-memory session is
 * authoritative, and a full disk must not cost the user their diagnosis.
 */
function persist(session) {
    try {
        fs.mkdirSync(SESSION_DIR, { recursive: true });
        const file = sessionPath(session.sessionId);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(redact(session), null, 2), 'utf8');
        fs.renameSync(tmp, file);      // atomic, same pattern aether-guard uses for its state
        prune();
        return { ok: true, file };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

function prune(keep = KEEP_SESSIONS) {
    try {
        const files = fs.readdirSync(SESSION_DIR)
            .filter(f => /^session-.+\.json$/.test(f))
            .map(f => ({ f, t: fs.statSync(path.join(SESSION_DIR, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t);
        for (const old of files.slice(keep)) {
            try { fs.unlinkSync(path.join(SESSION_DIR, old.f)); } catch (e) { /* best effort */ }
        }
    } catch (e) { /* the directory may not exist yet; nothing to prune */ }
}

/** Load a saved session for replay. Returns null rather than throwing on anything unusable. */
function load(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
        const s = JSON.parse(raw);
        if (!s || s.version !== SCHEMA_VERSION) return null;
        return s;
    } catch (e) {
        return null;
    }
}

function list() {
    try {
        return fs.readdirSync(SESSION_DIR)
            .filter(f => /^session-.+\.json$/.test(f))
            .map(f => path.join(SESSION_DIR, f));
    } catch (e) {
        return [];
    }
}

function finish(session, cancelled) {
    session.finishedAtMono = monoNow();
    session.finishedAtWall = new Date().toISOString();
    session.cancelled = !!cancelled;
    return session;
}

module.exports = {
    SCHEMA_VERSION, BUDGET_MS, SUB_BUDGET_MS,
    DISCRIMINATOR_MIN_REMAINING_MS, DISCRIMINATOR_TAIL_RESERVE_MS,
    monoNow, fingerprint, changedKeys, newSessionId,
    createSession, elapsedMs, remainingMs, discriminatorBudget,
    putFact, putFacts,
    sampleGeneration, markUnstable, mayConfirm,
    redact, persist, load, list, prune, finish,
    sessionDir, sessionPath,
};
