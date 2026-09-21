/*
 * Fresh reads for the apply-time gate.
 *
 * Everything the gate checks has to come from RIGHT NOW, not from the session that offered the
 * repair. The session is a description of a machine at a moment; by the time a user reads a
 * dialog and clicks, the tunnel may be up, another process may have taken the proxy, or the
 * adapter may have changed. Gating on the session would be gating on a memory.
 *
 * Deliberately narrow: it re-reads only what a gate decision needs, not a whole wave. A full
 * re-collection between the click and the change would open a wider window than the one it is
 * trying to close.
 */

'use strict';

const F = require('./facts');
const S = require('./session');
const ps = require('./ps');
const O = require('./ownership');
const { IDS } = require('./rules/ids');

/**
 * One batched read of the state the gates care about, shaped as facts so `preconditions()`
 * evaluates against exactly the same fact model the diagnosis used.
 */
const GATE_SCRIPT = [
    "$p = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue",
    '$o = @{}',
    '$o.proxyEnable = [int]$p.ProxyEnable',
    '$o.proxyServer = [string]$p.ProxyServer',
    '$o.pac = [string]$p.AutoConfigURL',
    '$o.bfe = [string](Get-Service BFE -ErrorAction SilentlyContinue).Status',
    '$o.dnscache = [string](Get-Service Dnscache -ErrorAction SilentlyContinue).Status',
    "$o.fwBlock = [bool](Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { $_.DefaultOutboundAction -eq 'Block' })",
    '$o | ConvertTo-Json -Compress',
].join('\n');

/**
 * Build the `live` object the repair gate consumes.
 *
 * `deps` supplies the app-side answers — which engines are running, who owns what — so this
 * module never reaches into engine internals and stays testable without them.
 */
function make(session, deps) {
    const d = deps || {};

    let cached = null;
    async function read() {
        if (cached) return cached;
        const r = await ps.run(GATE_SCRIPT, { timeout: 10000 });
        const j = r.ok ? ps.parseJson(r.stdout) : { ok: false };
        cached = (j.ok && j.value[0]) || null;
        return cached;
    }

    return {
        /**
         * The current generation.
         *
         * Sampled with the same fingerprint the run used, so "changed" means the same thing
         * here as it did during collection. A different notion of change on either side would
         * make the gate either paranoid or useless.
         */
        async generation() {
            if (typeof d.readFingerprint !== 'function') return session.generation.current;
            try {
                const fp = await d.readFingerprint();
                const last = session.generation.samples[session.generation.samples.length - 1];
                if (!last) return session.generation.current;
                return fp.hash === last.hash ? session.generation.current : session.generation.current + 1;
            } catch (e) {
                // Unreadable fingerprint means we cannot prove the machine is the same one. The
                // gate must refuse, so return something that will not match.
                return session.generation.current + 1;
            }
        },

        /** Fresh facts, in the same shape the rules and preconditions already speak. */
        async facts() {
            const v = await read();
            const out = {};
            const put = f => { out[f.id] = f; };
            if (!v) {
                // Nothing readable: every gate fact is unknown, and `preconditions` will refuse
                // rather than proceed on assumptions.
                for (const id of [IDS.PROXY_WININET_ENABLED, IDS.PROXY_WININET_SERVER, IDS.PROXY_PAC_URL,
                    IDS.SVC_BFE_RUNNING, IDS.SVC_DNSCACHE_RUNNING, IDS.FW_OUTBOUND_BLOCK]) {
                    put(F.unknown(id, 'gate-time state could not be read'));
                }
                return out;
            }
            put(F.observed(IDS.PROXY_WININET_ENABLED, v.proxyEnable === 1, { quality: F.QUALITY.REPORTED }));
            put(F.observed(IDS.PROXY_WININET_SERVER, v.proxyServer || '', { quality: F.QUALITY.REPORTED }));
            put(F.observed(IDS.PROXY_PAC_URL, v.pac || null, { quality: F.QUALITY.REPORTED }));
            put(F.observed(IDS.SVC_BFE_RUNNING, v.bfe === 'Running', { quality: F.QUALITY.REPORTED }));
            put(F.observed(IDS.SVC_DNSCACHE_RUNNING, v.dnscache === 'Running', { quality: F.QUALITY.REPORTED }));
            put(F.observed(IDS.FW_OUTBOUND_BLOCK, !!v.fwBlock, { quality: F.QUALITY.REPORTED }));

            // Re-probe the proxy endpoint. A listener that came back since the offer means the
            // diagnosis is stale — and this is the single most important gate-time read,
            // because it is the difference between disabling a dead proxy and disabling a live
            // tunnel's proxy.
            const parsed = O.parseProxyServer(v.proxyServer || '');
            const ep = parsed.endpoints[0];
            if (v.proxyEnable === 1 && ep) {
                const P = require('./probe');
                const host = ep.host === 'localhost' ? '127.0.0.1' : ep.host;
                const live = await P.tcpProbe(host, ep.port, 1500, 4);
                put(F.observed(IDS.PROXY_ENDPOINT_TCP_OK, live.ok, { quality: F.QUALITY.MEASURED }));
                put(F.observed(IDS.PROXY_ENDPOINT_OWNERSHIP, await this.ownership({ ownershipFactId: IDS.PROXY_ENDPOINT_OWNERSHIP }),
                    { quality: F.QUALITY.INFERRED }));
            } else {
                put(F.observed(IDS.PROXY_ENDPOINT_TCP_OK, true, { quality: F.QUALITY.INFERRED, note: 'no proxy configured' }));
                put(F.observed(IDS.PROXY_ENDPOINT_OWNERSHIP, O.OWNERSHIP.FOREIGN, { quality: F.QUALITY.INFERRED }));
            }
            put(F.observed(IDS.APP_ENGINE_RUNNING, !(await this.enginesQuiet()), { quality: F.QUALITY.REPORTED }));
            put(F.observed(IDS.APP_GUARD_STATE,
                typeof d.guardOwnership === 'function' ? await d.guardOwnership() : O.OWNERSHIP.UNKNOWN,
                { quality: F.QUALITY.INFERRED }));
            return out;
        },

        /**
         * Ownership, re-derived at gate time.
         *
         * Without a supplied resolver the answer is UNKNOWN, never FOREIGN — and UNKNOWN is
         * what stops the repair. Defaulting the other way would mean a missing dependency
         * silently authorises the write.
         */
        async ownership(repair) {
            if (typeof d.ownership !== 'function') return O.OWNERSHIP.UNKNOWN;
            try {
                return await d.ownership(repair);
            } catch (e) {
                return O.OWNERSHIP.UNKNOWN;
            }
        },

        /** Is nothing of ours starting, stopping, or mid-transition? Unknown counts as busy. */
        async enginesQuiet() {
            if (typeof d.enginesQuiet !== 'function') return false;
            try {
                return !!(await d.enginesQuiet());
            } catch (e) {
                return false;
            }
        },
    };
}

module.exports = { make, GATE_SCRIPT };
