/*
 * Confirmation tokens.
 *
 * The thing these replace is the first design's `confirmed: true` in the request body — a
 * control an attacker simply sets, and which said nothing about WHICH repair the user agreed
 * to or WHEN. A confirmation has to be unforgeable, unrepeatable, and tied to the exact state
 * the user was looking at when they gave it.
 *
 * So a token is bound to four things, and every one of them is load-bearing:
 *
 *   sessionId    it authorises a repair in ONE diagnostic session, not repairs in general
 *   repairId     agreeing to flush the DNS cache is not agreeing to disable the proxy
 *   generation   the machine the user was looking at. If the network changed since, the
 *                confirmation describes a machine that no longer exists
 *   tier         the risk level shown in the dialog. If exposure has escalated since, the
 *                confirmation the user gave no longer covers what would happen
 *
 * Plus single use and a short life, because a confirmation is a moment, not a standing
 * permission.
 */

'use strict';

const crypto = require('crypto');

/** Two minutes. Long enough to read a dialog, short enough that a machine cannot drift far. */
const TTL_MS = 2 * 60 * 1000;

const tokens = new Map();

function monoNow() { return Number(process.hrtime.bigint() / 1000000n); }

/**
 * Issue a token alongside an offered repair.
 *
 * Called by the server when it presents the narrative — never by the client, and never for a
 * repair the engine did not itself offer. That is what makes the capability model real: a
 * caller cannot invoke a repair that was never on the list, because there is no token for it.
 */
function issue(sessionId, repairId, generation, tier) {
    const value = crypto.randomBytes(24).toString('hex');
    tokens.set(value, {
        sessionId, repairId, generation, tier,
        issuedAtMono: monoNow(),
        used: false,
    });
    return value;
}

/**
 * Check a presented token against what is being asked for RIGHT NOW.
 *
 * Returns `{ valid, tier, reason }` — the shape the repair gate consumes. It deliberately
 * reports WHY, because "your confirmation is for a machine state that has since changed" and
 * "that token was already used" lead to different things to tell the user.
 */
function check(value, sessionId, repairId, currentGeneration) {
    const t = tokens.get(value);
    if (!t) return { valid: false, tier: null, reason: 'تأیید نامعتبر است' };
    if (t.used) return { valid: false, tier: t.tier, reason: 'این تأیید قبلاً استفاده شده است' };
    if (monoNow() - t.issuedAtMono > TTL_MS) {
        tokens.delete(value);
        return { valid: false, tier: t.tier, reason: 'مهلت تأیید تمام شده است' };
    }
    if (t.sessionId !== sessionId) return { valid: false, tier: t.tier, reason: 'تأیید متعلق به بررسی دیگری است' };
    if (t.repairId !== repairId) return { valid: false, tier: t.tier, reason: 'تأیید برای کار دیگری صادر شده است' };
    if (t.generation !== currentGeneration) {
        return { valid: false, tier: t.tier, reason: 'وضعیت شبکه از زمان تأیید تغییر کرده است' };
    }
    return { valid: true, tier: t.tier, reason: null };
}

/** Burn it. Called the moment a repair is attempted, whether or not the attempt succeeds. */
function consume(value) {
    const t = tokens.get(value);
    if (t) t.used = true;
    return !!t;
}

/**
 * Revoke everything for a session.
 *
 * Called after ANY successful repair. Every other offer was computed against the machine as it
 * was before that repair, so every other token now describes a state that no longer holds —
 * and a fresh diagnosis has to earn them again.
 */
function revokeSession(sessionId) {
    let n = 0;
    for (const [value, t] of tokens) {
        if (t.sessionId === sessionId) { tokens.delete(value); n++; }
    }
    return n;
}

/** Drop expired entries so a long-running process does not accumulate them. */
function sweep() {
    const now = monoNow();
    for (const [value, t] of tokens) {
        if (now - t.issuedAtMono > TTL_MS) tokens.delete(value);
    }
}

function size() { return tokens.size; }
function _clear() { tokens.clear(); }

module.exports = { TTL_MS, issue, check, consume, revokeSession, sweep, size, _clear };
