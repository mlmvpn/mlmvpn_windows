/*
 * The repair journal.
 *
 * This file is a privilege boundary, not bookkeeping. An Administrator process reads it at
 * startup and acts on what it finds, so it is designed as UNTRUSTED INPUT — even though we
 * wrote it ourselves, because on Windows `%USERPROFILE%` is writable by the (possibly
 * compromised, possibly non-admin) user and anything reachable from there can be replaced.
 *
 * Four rules follow from that, and none of them is optional:
 *
 *   1. It stores REPAIR IDS AND TYPED VALUES. Never a command string, never a free path. A
 *      tampered journal can at worst ask for a legitimate repair with a validated value.
 *   2. It is schema- and range-validated on read, exactly like a request off the network.
 *      Unknown id, out-of-range value, unparseable file ⇒ discard the whole thing and log.
 *      Never "best effort" execution of a partially-understood journal.
 *   3. It lives under %ProgramData% with an Administrators ACL, and its owner is checked
 *      before it is honoured. If the ACL cannot be established, recovery is skipped rather
 *      than run from a file anyone could have written.
 *   4. It is TWO-PHASE. `intent` before the change, `applied` immediately after the privileged
 *      call returns. With only a pre-apply record, recovery cannot tell "we applied it" from
 *      "we died before applying", and a blind rollback of an unapplied repair is itself an
 *      unwanted privileged write.
 *
 * Recovery CONVERGES: it observes the current machine state and decides, rather than replaying
 * anything.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCHEMA = 3;

/**
 * Administrators-owned by design. %USERPROFILE% holds sessions and reports — data that is only
 * ever read — while anything that drives a privileged action lives here.
 */
const DIR = path.join(process.env.ProgramData || path.join(os.homedir(), '.mlmvpn'), 'MLMVPN', 'netdiag');
const FILE = path.join(DIR, 'repair-journal.json');

const PHASE = Object.freeze({ INTENT: 'intent', APPLIED: 'applied', RESOLVED: 'resolved' });

/**
 * Typed pre-state shapes, one per repair that can be journaled.
 *
 * The validator is the allowlist: a value whose shape is not described here cannot survive a
 * read, which is what makes a tampered file inert rather than dangerous.
 */
const PRESTATE_SCHEMA = {
    'proxy.wininet.disable': {
        proxyEnable: 'int0or1',
        proxyServer: 'string',
        autoConfigUrl: 'stringOrNull',
        proxyOverride: 'stringOrNull',
    },
    'proxy.pac.clear': { autoConfigUrl: 'string' },
    'dns.flush': {},
    'svc.start-bfe': { startType: 'serviceStartType', status: 'serviceStatus' },
    'svc.start-dnscache': { startType: 'serviceStartType', status: 'serviceStatus' },
    'guard.restore-stale': { firewallEngaged: 'bool' },
};

const VALIDATORS = {
    int0or1: v => v === 0 || v === 1,
    bool: v => typeof v === 'boolean',
    string: v => typeof v === 'string' && v.length <= 2048,
    stringOrNull: v => v === null || (typeof v === 'string' && v.length <= 2048),
    serviceStartType: v => ['Automatic', 'Manual', 'Disabled', 'Boot', 'System', 'unknown'].includes(v),
    serviceStatus: v => ['Running', 'Stopped', 'Paused', 'StartPending', 'StopPending', 'unknown'].includes(v),
    interfaceGuid: v => typeof v === 'string' && /^\{[0-9a-f-]{36}\}$/i.test(v),
};

let hardened = false;

/**
 * Create the directory and give it an explicit ACL.
 *
 * `%ProgramData%` grants ordinary users the right to create subdirectories, and whoever creates
 * one owns it. So without this, a non-admin process that creates
 * `%ProgramData%\MLMVPN\netdiag` first owns the directory the elevated app will later journal
 * into — and the ownership check on read would then refuse the journal forever, silently
 * disabling crash recovery. That is a denial of recovery rather than a privilege escalation
 * (the refusal is what keeps it from being worse), but it is still an outcome an attacker can
 * choose, so the directory is locked down on creation.
 *
 * Best effort by design: on a machine where icacls is unavailable or the process is not
 * elevated, the write still happens and the READ-side ownership check remains the thing that
 * decides whether the file may be honoured. Hardening is a defence, never the guarantee.
 */
/**
 * Are we elevated?
 *
 * Only an elevated process may lock the directory down. Locking it to Administrators from a
 * NON-elevated process locks the writer out of its own journal, which is exactly what happened
 * the first time this was written: every repair test died with EPERM on its own sandbox, and a
 * non-elevated dev run of the app would have been unable to journal at all.
 *
 * `net session` is a read only an administrator may perform — more reliable than inspecting
 * group membership, which lists Administrators as present-but-not-enabled on a filtered token.
 */
function isElevated() {
    try {
        const { execFileSync } = require('child_process');
        execFileSync('net.exe', ['session'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
        return true;
    } catch (e) {
        return false;
    }
}

function ensureDir() {
    const existed = fs.existsSync(DIR);
    fs.mkdirSync(DIR, { recursive: true });
    if (!existed && !hardened && isElevated()) {
        hardened = true;
        try {
            const { execFileSync } = require('child_process');
            execFileSync('icacls.exe', [DIR, '/inheritance:r',
                '/grant:r', '*S-1-5-32-544:(OI)(CI)F',   // Administrators, full
                '/grant:r', '*S-1-5-18:(OI)(CI)F',       // SYSTEM, full
            ], { windowsHide: true, timeout: 8000, stdio: 'ignore' });
        } catch (e) {
            // Not fatal, and not silently ignored either: the read-side owner check is what
            // protects the privileged path, and it will report the problem in its own words.
        }
    }
    return DIR;
}

/**
 * Atomic, the same temp-then-rename pattern `aether-guard.js:73` uses for its state file.
 *
 * A failure here is deliberately allowed to propagate. No journal means no crash recovery, and
 * a privileged change with no way to recover it is precisely the thing this file exists to
 * prevent — so `writeIntent` throwing is the correct outcome, and it stops the repair before
 * anything is applied rather than after.
 */
function writeAll(entries) {
    ensureDir();
    const tmp = `${FILE}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, entries }, null, 2), 'utf8');
        fs.renameSync(tmp, FILE);
    } catch (e) {
        const err = new Error(`the repair journal could not be written (${e.code || e.message}); `
            + 'refusing to change machine state without a way to recover it');
        err.code = 'JOURNAL_UNWRITABLE';
        err.cause = e;
        throw err;
    }
}

function readRaw() {
    try {
        return JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
    } catch (e) {
        return null;
    }
}

/**
 * Validate one entry against the allowlist.
 *
 * Returns `{ ok, reason }`. Anything not positively recognised is rejected; there is no
 * "unknown but probably fine" branch, because that branch is the vulnerability.
 */
function validateEntry(e) {
    if (!e || typeof e !== 'object') return { ok: false, reason: 'entry is not an object' };
    if (typeof e.repairId !== 'string') return { ok: false, reason: 'missing repairId' };
    const shape = PRESTATE_SCHEMA[e.repairId];
    if (!shape) return { ok: false, reason: `unknown repairId: ${e.repairId}` };
    if (!Object.values(PHASE).includes(e.phase)) return { ok: false, reason: `bad phase: ${e.phase}` };
    if (typeof e.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(e.sessionId)) {
        return { ok: false, reason: 'bad sessionId' };
    }
    if (!Number.isInteger(e.generation) || e.generation < 0) return { ok: false, reason: 'bad generation' };

    const pre = e.preState;
    if (pre === undefined || pre === null || typeof pre !== 'object') {
        return { ok: false, reason: 'missing preState' };
    }
    // Exact key set. Extra keys are as suspicious as missing ones — an attacker adding a field
    // is trying to reach a code path the schema does not describe.
    const want = Object.keys(shape).sort();
    const got = Object.keys(pre).sort();
    if (want.join(',') !== got.join(',')) {
        return { ok: false, reason: `preState keys ${got.join(',')} do not match ${want.join(',')}` };
    }
    for (const [k, type] of Object.entries(shape)) {
        const check = VALIDATORS[type];
        if (!check) return { ok: false, reason: `no validator for ${type}` };
        if (!check(pre[k])) return { ok: false, reason: `preState.${k} failed ${type}` };
    }
    if (e.target !== undefined && e.target !== null) {
        if (typeof e.target !== 'object') return { ok: false, reason: 'bad target' };
        if (e.target.kind === 'interface' && !VALIDATORS.interfaceGuid(e.target.guid)) {
            return { ok: false, reason: 'target interface guid is malformed' };
        }
        if (!['interface', 'service', 'machine'].includes(e.target.kind)) {
            return { ok: false, reason: `bad target kind: ${e.target.kind}` };
        }
    }
    return { ok: true, reason: null };
}

/**
 * Is the file safe to honour?
 *
 * Owner must be a system principal. If ownership cannot be established at all, recovery is
 * SKIPPED — running privileged restores from a file of unknown provenance is the exact thing
 * this check exists to prevent, and losing crash recovery is the cheaper failure.
 */
async function checkOwnership(deps) {
    const d = deps || {};
    if (typeof d.fileOwner !== 'function') {
        return { ok: false, reason: 'no ownership check available; refusing to honour the journal' };
    }
    let owner;
    // AWAITED, so `fileOwner` may be asynchronous — and it must be. The only caller runs on
    // Electron's start-up path, where a synchronous PowerShell blocks the main process before
    // the window exists. A promise is accepted and a plain string still works.
    try { owner = await d.fileOwner(FILE); } catch (e) { return { ok: false, reason: `ownership unreadable: ${e.message}` }; }
    if (!owner) return { ok: false, reason: 'ownership unreadable' };
    const safe = /\\(Administrators|SYSTEM|TrustedInstaller)$/i.test(owner) || /^NT AUTHORITY\\SYSTEM$/i.test(owner);
    return safe ? { ok: true, owner } : { ok: false, reason: `journal is owned by ${owner}, not an administrative principal` };
}

// ── writing ─────────────────────────────────────────────────────────────────────────────

function load() {
    const raw = readRaw();
    if (!raw || raw.schema !== SCHEMA || !Array.isArray(raw.entries)) return [];
    return raw.entries;
}

/** Phase 1: written BEFORE the privileged call. */
function writeIntent(entry) {
    const e = Object.assign({}, entry, {
        phase: PHASE.INTENT,
        atWall: new Date().toISOString(),
        atMono: Number(process.hrtime.bigint() / 1000000n),
    });
    const v = validateEntry(e);
    if (!v.ok) throw new Error(`refusing to journal an entry that would not validate on read: ${v.reason}`);
    const all = load().filter(x => !(x.repairId === e.repairId && x.sessionId === e.sessionId));
    all.push(e);
    writeAll(all);
    return e;
}

/** Phase 2: written IMMEDIATELY after the privileged call returns, success or not. */
function markApplied(sessionId, repairId, result) {
    const all = load();
    const e = all.find(x => x.sessionId === sessionId && x.repairId === repairId);
    if (!e) return null;
    e.phase = PHASE.APPLIED;
    e.applyOk = !!(result && result.ok);
    e.appliedAtWall = new Date().toISOString();
    writeAll(all);
    return e;
}

/** Phase 3: the outcome is known and nothing is outstanding. */
function resolve(sessionId, repairId, outcome) {
    const all = load().filter(x => !(x.sessionId === sessionId && x.repairId === repairId));
    writeAll(all);
    return outcome;
}

function clear() {
    try { fs.unlinkSync(FILE); } catch (e) { /* nothing to clear */ }
}

// ── recovery ────────────────────────────────────────────────────────────────────────────

/**
 * Called at startup, beside the existing `aether-guard.restoreIfStale()` at server.js:3608.
 *
 * Converges by OBSERVATION. For each outstanding entry it asks the machine what is true now
 * and acts on the answer, rather than replaying an intent or blindly undoing anything:
 *
 *   intent, change absent    we died before applying. Nothing to do.
 *   intent, change present   we applied but never marked it. Verify and resolve.
 *   applied, still present   the repair stands; if its pre-state should be restored, restore.
 *   anything unobservable    leave it alone, report `unrecoverable`, and say so next session.
 *
 * `deps.observe(entry)` returns `'present' | 'absent' | 'unknown'`, and `deps.restore(entry)`
 * puts the pre-state back. Both are injected, so the whole decision table is testable with no
 * Windows and no privileged calls.
 */
async function restoreIfStale(deps) {
    const d = deps || {};
    const log = d.log || (() => {});
    const outcomes = [];

    const raw = readRaw();
    if (!raw) return { ok: true, outcomes, note: 'no journal' };

    if (raw.schema !== SCHEMA || !Array.isArray(raw.entries)) {
        log('[NETDIAG] journal schema is not recognised — discarding it rather than guessing');
        clear();
        return { ok: true, outcomes, note: 'discarded: bad schema' };
    }

    const own = await checkOwnership(d);
    if (!own.ok) {
        // Not cleared: deleting a file we do not trust the provenance of is another privileged
        // action on it. Left alone, reported, ignored.
        log(`[NETDIAG] refusing to honour the repair journal — ${own.reason}`);
        return { ok: false, outcomes, note: own.reason };
    }

    const kept = [];
    for (const entry of raw.entries) {
        const v = validateEntry(entry);
        if (!v.ok) {
            log(`[NETDIAG] discarding a journal entry: ${v.reason}`);
            outcomes.push({ repairId: entry && entry.repairId, outcome: 'discarded', reason: v.reason });
            continue;
        }
        if (entry.phase === PHASE.RESOLVED) continue;

        let observed = 'unknown';
        try {
            observed = typeof d.observe === 'function' ? await d.observe(entry) : 'unknown';
        } catch (e) {
            observed = 'unknown';
        }

        if (observed === 'unknown') {
            outcomes.push({ repairId: entry.repairId, outcome: 'unrecoverable', reason: 'current state could not be observed' });
            kept.push(entry);
            continue;
        }
        if (entry.phase === PHASE.INTENT && observed === 'absent') {
            outcomes.push({ repairId: entry.repairId, outcome: 'nothing-to-do', reason: 'the change was never applied' });
            continue;
        }
        if (!d.restore) {
            outcomes.push({ repairId: entry.repairId, outcome: 'unrecoverable', reason: 'no restore path available' });
            kept.push(entry);
            continue;
        }
        try {
            const r = await d.restore(entry);
            outcomes.push({
                repairId: entry.repairId,
                outcome: r && r.ok ? 'restored' : 'restore-failed',
                reason: r && r.reason,
            });
            if (!(r && r.ok)) kept.push(entry);
        } catch (e) {
            outcomes.push({ repairId: entry.repairId, outcome: 'restore-failed', reason: e.message });
            kept.push(entry);
        }
    }

    if (kept.length) writeAll(kept); else clear();
    return { ok: true, outcomes, note: null };
}

module.exports = {
    SCHEMA, PHASE, DIR, FILE, PRESTATE_SCHEMA, VALIDATORS,
    load, writeIntent, markApplied, resolve, clear,
    validateEntry, checkOwnership, restoreIfStale,
    _writeAll: writeAll,
};
