/*
 * The network-mutation mutex.
 *
 * One lock, shared by everything in this app that changes network state: NetDiag repairs,
 * auto-connect, DNS ownership changes, engine start/stop, kill-switch operations, proxy
 * changes, route changes.
 *
 * It lives here rather than inside the repair engine because a NetDiag-private lock would be
 * theatre. The dangerous race is not two repairs colliding with each other — that one is
 * solved by running them sequentially. It is a repair colliding with the REST OF THE APP: the
 * user pressing «همه را درست کن» at the moment `auto-connect` brings a tunnel up. Then
 * `proxy.wininet.disable` and the engine's `enableSystemProxy(true)` interleave, the guard
 * records a pre-state that describes a machine which existed for 200ms, and rollback restores
 * something that was never true.
 *
 * Deliberately in-process and non-reentrant. Every mutator in this app lives in the one server
 * process, so a cross-process lock would add a failure mode (a stale lock file after a crash
 * leaving the app unable to touch its own network state) without closing anything real.
 */

'use strict';

const waiters = [];
let held = null;

function nowMono() { return Number(process.hrtime.bigint() / 1000000n); }

/**
 * Take the lock.
 *
 * Resolves with a release function. `timeoutMs: 0` means "fail immediately if busy" — which is
 * what NetDiag uses, because making the user wait behind an unknown operation is worse than
 * telling them another operation is running.
 */
function acquire(owner, opts) {
    const o = opts || {};
    const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 0;

    return new Promise((resolve, reject) => {
        const grant = () => {
            held = { owner, since: nowMono() };
            let released = false;
            resolve(function release() {
                if (released) return;          // double release must not hand the lock away twice
                released = true;
                held = null;
                const next = waiters.shift();
                if (next) next.grant();
            });
        };

        if (!held) return grant();

        if (timeoutMs <= 0) {
            const e = new Error(`network mutation lock is held by ${held.owner}`);
            e.code = 'MUTEX_BUSY';
            e.heldBy = held.owner;
            e.heldForMs = nowMono() - held.since;
            return reject(e);
        }

        const entry = {
            grant() {
                clearTimeout(entry.timer);
                grant();
            },
            timer: setTimeout(() => {
                const i = waiters.indexOf(entry);
                if (i >= 0) waiters.splice(i, 1);
                const e = new Error(`timed out after ${timeoutMs}ms waiting for the network mutation lock`);
                e.code = 'MUTEX_TIMEOUT';
                e.heldBy = held && held.owner;
                reject(e);
            }, timeoutMs),
        };
        waiters.push(entry);
    });
}

/**
 * Run `fn` under the lock, releasing it even if `fn` throws.
 *
 * A repair that dies mid-apply must not leave the whole app unable to touch the network — the
 * journal is what makes the half-applied change recoverable, and it can only run if the lock
 * comes back.
 */
async function withLock(owner, fn, opts) {
    const release = await acquire(owner, opts);
    try {
        return await fn();
    } finally {
        release();
    }
}

/** Who holds it, for the user-facing «یک عملیات شبکه دیگر در حال اجراست» message. */
function status() {
    return held
        ? { held: true, owner: held.owner, heldForMs: nowMono() - held.since, waiting: waiters.length }
        : { held: false, owner: null, heldForMs: 0, waiting: waiters.length };
}

module.exports = { acquire, withLock, status };
