/*
 * NetDiag — ownership and self-awareness.
 *
 * The question this module answers, before anything on the machine is called a fault:
 *
 *     Is THIS app deliberately doing this, right now, and is the thing maintaining it alive?
 *
 * Two questions, not one, and conflating them is what makes ownership dangerous. "Did we set
 * this?" and "are we still maintaining it?" have different answers after a crash, and the two
 * wrong answers fail in opposite directions:
 *
 *   a false FOREIGN tears down live protection. The repository's own
 *     gst/gst-runtime.js:46 systemProxyIsOurs() answers with
 *         state.server === `127.0.0.1:${rt.httpPort}`
 *     — exact string equality, HKCU only, against GST's port only. Windows legitimately
 *     stores `http=127.0.0.1:10809;https=127.0.0.1:10809`, and xray-manager.js:509 sets a
 *     different port entirely, so a proxy this app owns reads as "not ours". Acting on that
 *     disables the system proxy of a live tunnel and sends an Iranian user's traffic out in
 *     the clear, while the UI reports success.
 *
 *   a false OURS-LIVE dismisses a real fault. aether-guard.js:67 records `pid: process.pid`
 *     and nothing else. Windows reuses PIDs, especially across a reboot, so after a crash the
 *     recorded pid can belong to an unrelated process — and a stuck kill switch (every
 *     firewall profile at DefaultOutboundAction=Block) then reads as "by design, nothing to
 *     fix" on a machine with no internet at all. That is this feature failing at the exact
 *     symptom it exists for.
 *
 * Hence: four states, not a boolean; positive proof required for FOREIGN; liveness folded
 * into the decision; and process identity that survives PID reuse.
 *
 * The pure functions here take already-collected evidence, so every case below is testable
 * with no Windows, no registry and no running engine.
 */

'use strict';

/** The four states. `unknown` is a real answer, and it is the fail-safe one. */
const OWNERSHIP = Object.freeze({
    OURS_LIVE: 'ours-live',          // we set it, the owner is alive, its data path answers
    OURS_ORPHANED: 'ours-orphaned',  // we set it, but nothing of ours is maintaining it now
    FOREIGN: 'foreign',              // positively proved not ours
    UNKNOWN: 'unknown',              // we could not determine it — never assume either way
});

/**
 * May a repair touch state in this ownership state?
 *
 *   ours-live      no — it is deliberate, and tearing it down is the leak this engine exists
 *                  to avoid causing.
 *   ours-orphaned  yes, but ONLY through the owning module's own recovery path
 *                  (aether-guard.restoreIfStale, dnsManager.restoreBackup, the engine's own
 *                  stop) — never a generic reset and never a blanket firewall Allow.
 *   foreign        yes, normal repair rules.
 *   unknown        no auto tier, and any repair whose gate requires `foreign` is blocked.
 */
function repairPolicy(state) {
    switch (state) {
        case OWNERSHIP.OURS_LIVE: return { mayRepair: false, autoEligible: false, via: null, reason: 'by-design' };
        case OWNERSHIP.OURS_ORPHANED: return { mayRepair: true, autoEligible: false, via: 'owner-recovery', reason: 'stale app state' };
        case OWNERSHIP.FOREIGN: return { mayRepair: true, autoEligible: true, via: 'repair', reason: 'proved foreign' };
        default: return { mayRepair: false, autoEligible: false, via: null, reason: 'ownership unknown — absence of evidence is not authority to act' };
    }
}

// ── process identity ────────────────────────────────────────────────────────────────────

/**
 * Does a recorded owner still match the process that is running under that pid?
 *
 * A bare pid is not identity. The triple (pid, imagePath, createTime) is, and any recorded
 * state that carries only a pid — which is what the existing guard writes — is deliberately
 * reported as `unknown` rather than as a match. Guessing "still alive" there is precisely the
 * reboot-plus-PID-reuse case that hides a stuck kill switch.
 */
function processIdentityMatches(recorded, actual) {
    if (!recorded || typeof recorded.pid !== 'number') {
        return { match: 'unknown', reason: 'no recorded process identity' };
    }
    if (!actual) {
        return { match: 'no', reason: `pid ${recorded.pid} is not running` };
    }
    if (recorded.pid !== actual.pid) {
        return { match: 'no', reason: 'pid differs' };
    }
    const haveRecordedDetail = !!(recorded.imagePath || recorded.createTime);
    if (!haveRecordedDetail) {
        // The pid is alive, but the record predates identity tracking. Windows reuses pids,
        // so "alive" proves nothing about whether it is OUR process.
        return {
            match: 'unknown',
            reason: 'record carries only a pid; pid reuse makes liveness meaningless as proof of identity',
        };
    }
    if (recorded.imagePath && actual.imagePath
        && normalisePath(recorded.imagePath) !== normalisePath(actual.imagePath)) {
        return { match: 'no', reason: 'pid was reused by a different executable' };
    }
    if (recorded.createTime && actual.createTime && recorded.createTime !== actual.createTime) {
        return { match: 'no', reason: 'pid was reused; process start time differs' };
    }
    if ((recorded.imagePath && !actual.imagePath) || (recorded.createTime && !actual.createTime)) {
        return { match: 'unknown', reason: 'could not read the running process identity to compare' };
    }
    return { match: 'yes', reason: 'pid, image path and start time all match' };
}

function normalisePath(p) {
    return String(p).toLowerCase().replace(/\//g, '\\').replace(/^"|"$/g, '');
}

/** Is this executable one of ours? Path containment under the install directory, normalised. */
function isOurImage(imagePath, installDir) {
    if (!imagePath || !installDir) return false;
    const a = normalisePath(imagePath);
    const b = normalisePath(installDir).replace(/\\+$/, '');
    return a === b || a.startsWith(b + '\\');
}

// ── proxy string parsing ────────────────────────────────────────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0:0:0:0:0:0:0:1']);

/**
 * Parse a Windows `ProxyServer` value into endpoints, tolerantly.
 *
 * Windows accepts several spellings for the same configuration and the app itself produces
 * more than one of them: xray-manager writes a bare `127.0.0.1:20809`, while a per-protocol
 * value like `http=127.0.0.1:10809;https=127.0.0.1:10809;ftp=…` is equally normal. Anything
 * that only understands the first spelling declares the second foreign.
 */
function parseProxyServer(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return { ok: true, endpoints: [], perProtocol: false };

    const out = [];
    let perProtocol = false;
    for (const part of s.split(';')) {
        const chunk = part.trim();
        if (!chunk) continue;
        let scheme = null;
        let hostport = chunk;
        const eq = chunk.indexOf('=');
        if (eq > 0) {
            perProtocol = true;
            scheme = chunk.slice(0, eq).trim().toLowerCase();
            hostport = chunk.slice(eq + 1).trim();
        }
        const ep = splitHostPort(hostport);
        if (!ep) continue;
        out.push({ scheme, host: ep.host, port: ep.port, loopback: isLoopbackHost(ep.host) });
    }
    if (!out.length) {
        return { ok: false, endpoints: [], perProtocol, reason: `unrecognised ProxyServer value: ${s}` };
    }
    return { ok: true, endpoints: out, perProtocol };
}

function splitHostPort(s) {
    const str = String(s).trim().replace(/^[a-z]+:\/\//i, '');
    const v6 = str.match(/^\[([^\]]+)\]:(\d{1,5})$/);           // [::1]:8080
    if (v6) return { host: v6[1].toLowerCase(), port: parseInt(v6[2], 10) };
    const m = str.match(/^([^:\s]+):(\d{1,5})$/);
    if (!m) return null;
    return { host: m[1].toLowerCase(), port: parseInt(m[2], 10) };
}

function isLoopbackHost(host) {
    const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
    return LOOPBACK_HOSTS.has(h) || /^127\./.test(h);
}

// ── the proxy ownership decision ────────────────────────────────────────────────────────

/**
 * Decide who owns the configured system proxy.
 *
 * Evidence, all of it optional — whatever is missing pushes the answer toward `unknown`:
 *
 *   endpoints   from parseProxyServer()
 *   listener    { pid, imagePath } of whatever is listening on that loopback port, or null
 *               for "nothing is listening", or undefined for "we could not look"
 *   claims      the EngineAdapters that say they own this endpoint
 *   installDir  our install directory, for image-path containment
 *
 * Identity comes from the LISTENER, not from the string. That is the fix for the string
 * equality problem: however the value is spelled, if it points at a loopback port whose
 * listening process is one of our binaries, it is ours.
 */
function classifyProxyOwnership(ev) {
    const e = ev || {};
    const endpoints = e.endpoints || [];
    const claims = e.claims || [];

    if (!endpoints.length) {
        return decision(OWNERSHIP.UNKNOWN, 'no proxy endpoint could be parsed from the configuration');
    }
    // A non-loopback proxy cannot be one of ours: every engine in this app listens on
    // loopback. This is the one direction where absence of a claim IS positive proof.
    const anyLoopback = endpoints.some(x => x.loopback);
    if (!anyLoopback) {
        if (claims.length) {
            return decision(OWNERSHIP.UNKNOWN,
                'an engine claims a non-loopback proxy endpoint, which contradicts how our engines listen');
        }
        return decision(OWNERSHIP.FOREIGN, 'the proxy points at a non-loopback host, which no engine of ours can be');
    }

    if (e.listener === undefined) {
        return decision(OWNERSHIP.UNKNOWN, 'could not determine which process is listening on the proxy port');
    }

    if (e.listener === null) {
        // Nothing is listening. If one of ours claims the endpoint, this is our own state left
        // behind by a dead engine — a fault, and the highest-value one this engine finds.
        if (claims.length) {
            return decision(OWNERSHIP.OURS_ORPHANED,
                `no process is listening on the proxy port, but ${claims.join(', ')} claims it — stale state from a dead engine`,
                { claims });
        }
        return decision(OWNERSHIP.FOREIGN,
            'the proxy points at a dead loopback port that no engine of ours claims');
    }

    const ours = isOurImage(e.listener.imagePath, e.installDir);
    if (ours) {
        return decision(OWNERSHIP.OURS_LIVE,
            `the proxy port is served by our own process (${e.listener.imagePath})`,
            { claims, listener: e.listener });
    }
    if (!e.listener.imagePath) {
        return decision(OWNERSHIP.UNKNOWN,
            'something is listening on the proxy port but its executable could not be identified');
    }
    if (claims.length) {
        // An engine claims it, but a foreign binary answers there. Neither conclusion is safe
        // and saying so is the honest result.
        return decision(OWNERSHIP.UNKNOWN,
            `${claims.join(', ')} claims this endpoint but a different executable is listening (${e.listener.imagePath})`,
            { claims, listener: e.listener });
    }
    return decision(OWNERSHIP.FOREIGN,
        `the proxy port is served by a process outside this app (${e.listener.imagePath})`,
        { listener: e.listener });
}

function decision(state, reason, extra) {
    return Object.assign({ state, reason, policy: repairPolicy(state) }, extra || {});
}

// ── VPN protection: deliberate, or left behind? ─────────────────────────────────────────

/**
 * Distinguish «the VPN is intentionally blocking traffic» from «the VPN's protection is
 * stale». They look identical in the firewall, DNS and route facts and differ only in
 * liveness and in whether the guard's own record still describes reality.
 *
 * The third outcome is the one v2 was missing: when what the guard recorded and what the
 * machine shows disagree, NEITHER "by design" nor "fault" is safe, and the answer is unknown
 * with an offer to run the guard's own restore.
 */
function classifyGuardState(ev) {
    const e = ev || {};
    if (e.engaged === undefined) {
        return decision(OWNERSHIP.UNKNOWN, 'could not read the firewall or DNS state the guard would have set');
    }
    if (!e.stateFilePresent) {
        if (e.engaged) {
            // Something set a machine-wide block and we have no record of doing it. Reported,
            // never silently reversed — this is why firewall.allow-out does not exist.
            return decision(OWNERSHIP.FOREIGN, 'outbound is blocked but this app has no record of engaging protection');
        }
        return decision(OWNERSHIP.FOREIGN, 'no guard state recorded and nothing engaged');
    }
    if (!e.engaged) {
        // We recorded engaging, the machine says otherwise. The record has drifted.
        return decision(OWNERSHIP.UNKNOWN,
            'the guard recorded engaging protection but the machine does not show it — the record has drifted from reality');
    }
    const idm = processIdentityMatches(e.recordedOwner, e.actualOwner);
    if (idm.match === 'yes') {
        if (e.dataPathOk === false) {
            return decision(OWNERSHIP.OURS_ORPHANED,
                'the owning engine is alive but its data path does not carry traffic');
        }
        if (e.dataPathOk === undefined) {
            return decision(OWNERSHIP.UNKNOWN,
                'the owning engine matches but we could not prove its data path carries traffic');
        }
        return decision(OWNERSHIP.OURS_LIVE, 'protection is engaged and the owning engine is alive and carrying traffic');
    }
    if (idm.match === 'no') {
        return decision(OWNERSHIP.OURS_ORPHANED, `protection is engaged but the owner is gone: ${idm.reason}`);
    }
    return decision(OWNERSHIP.UNKNOWN, `protection is engaged but ownership could not be proved: ${idm.reason}`);
}

// ── engine adapters ─────────────────────────────────────────────────────────────────────

/**
 * The interface every engine is seen through. Rules never touch a concrete engine module, so
 * adding an engine is adding a shim and changes no rule.
 *
 * Shims are injected rather than required at module load: pulling in aether-manager,
 * xray-manager and the tunnel modules would drag half the app — and its side effects — into
 * a unit test of a pure decision.
 */
function makeAdapter(spec) {
    const noop = () => undefined;
    return Object.assign({
        id: 'unknown',
        label: 'unknown',
        isRunning: noop,
        processIdentity: noop,
        socksPort: noop,
        httpPort: noop,
        claimsProxyEndpoint: () => false,
        claimsDnsServers: () => false,
        claimsRoute: () => false,
        carriesData: noop,
        recoveryPath: () => null,
    }, spec || {});
}

/** Which adapters claim a given proxy endpoint. Adapter throws are contained, not fatal. */
function claimantsForProxy(adapters, host, port) {
    const out = [];
    for (const a of adapters || []) {
        try {
            if (a.claimsProxyEndpoint(host, port)) out.push(a.id);
        } catch (e) { /* a broken shim must not decide ownership */ }
    }
    return out;
}

module.exports = {
    OWNERSHIP, repairPolicy,
    processIdentityMatches, isOurImage, normalisePath,
    parseProxyServer, splitHostPort, isLoopbackHost,
    classifyProxyOwnership, classifyGuardState,
    makeAdapter, claimantsForProxy,
};
