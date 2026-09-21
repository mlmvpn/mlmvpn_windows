/*
 * The recovery observer.
 *
 * Answers one question per journal entry: is the change this repair makes PRESENT on the
 * machine right now? `'present' | 'absent' | 'unknown'`.
 *
 * This is what makes recovery convergent rather than a replay. A journal says what we intended
 * and, in the second phase, that the privileged call returned — but neither says what the
 * machine looks like after a crash, a reboot, or somebody else's change in between. So the
 * machine is asked, and `unknown` is a real answer: an entry whose current state cannot be
 * established is left alone and reported, never guessed at in either direction.
 */

'use strict';

const ps = require('../ps');

const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

const OBSERVERS = {
    async 'proxy.wininet.disable'() {
        const r = await ps.run(`[int](Get-ItemProperty -Path '${KEY}' -ErrorAction SilentlyContinue).ProxyEnable`, { timeout: 6000 });
        if (!r.ok) return 'unknown';
        const v = parseInt((r.stdout || '').trim(), 10);
        if (!Number.isFinite(v)) return 'unknown';
        // The change this repair makes is "ProxyEnable is 0".
        return v === 0 ? 'present' : 'absent';
    },

    async 'proxy.pac.clear'() {
        const r = await ps.run(`$v=(Get-ItemProperty -Path '${KEY}' -ErrorAction SilentlyContinue).AutoConfigURL; if ($null -eq $v) { 'GONE' } else { 'SET' }`, { timeout: 6000 });
        if (!r.ok) return 'unknown';
        if (/GONE/.test(r.stdout)) return 'present';
        if (/SET/.test(r.stdout)) return 'absent';
        return 'unknown';
    },

    // Nothing persists, so there is never anything to undo.
    async 'dns.flush'() { return 'absent'; },

    async 'svc.start-bfe'() { return serviceRunning('BFE'); },
    async 'svc.start-dnscache'() { return serviceRunning('Dnscache'); },

    async 'guard.restore-stale'() {
        // The guard owns its own state file and its own recovery. Reporting `absent` here
        // keeps NetDiag's journal from trying to second-guess it: if anything is outstanding,
        // `aether-guard.restoreIfStale()` — which runs first at startup — is what handles it.
        return 'absent';
    },
};

async function serviceRunning(name) {
    const r = await ps.run(`(Get-Service -Name '${name}' -ErrorAction SilentlyContinue).Status`, { timeout: 6000 });
    if (!r.ok || !(r.stdout || '').trim()) return 'unknown';
    return /Running/i.test(r.stdout) ? 'present' : 'absent';
}

/**
 * `entry` has already been schema-validated by the journal, so `repairId` is known to be one
 * of the allowlisted ids. An id with no observer still yields `unknown` rather than throwing:
 * a missing observer is a gap in our coverage, not grounds for a privileged guess.
 */
module.exports = async function observe(entry) {
    const fn = OBSERVERS[entry && entry.repairId];
    if (!fn) return 'unknown';
    try {
        return await fn();
    } catch (e) {
        return 'unknown';
    }
};

module.exports.OBSERVERS = OBSERVERS;
