// --- Aether: fail-closed guard + machine-state safety net ---
//
// This module owns the two machine-wide changes the Aether path makes that MUST NOT outlive
// the process that made them:
//
//   1. Windows' resolver list pointed at a loopback address that only answers while our DNS
//      bridge is alive.
//   2. A block-by-default Windows Firewall profile, so a dead tunnel cannot silently fall
//      back to the physical interface with the user's real address.
//
// WHY EACH ONE IS HERE
//
// (1) was measured, not theorised. `POST /api/aether/stop` returned {"ok":true} and the
// process was killed three seconds later; the restore had not finished, and the machine was
// left with Wi-Fi pointing at 127.0.0.1 / ::1 with nothing listening. Every lookup failed.
// That state survives the app exiting and survives reinstalling it. The user experiences it
// as "the internet died and I don't know why".
//
// (2) is the leak the whole audit is about. Without it, sing-box dying — for any reason:
// crash, adapter removed, laptop resumed from sleep — hands the default route straight back
// to Wi-Fi. Nothing errors, nothing pops up, and the next packet carries the real IP.
//
// THE PART THAT MATTERS MOST: EVERY CHANGE IS RECORDED ON DISK BEFORE IT IS MADE.
//
// In-process restore paths (disengage, before-quit, SIGINT) do not run when the process does
// not get to run code — Task Manager "End task", a hard crash, an antivirus kill, power loss.
// So the pre-change state goes to a file first, and restoreIfStale() puts it back at startup
// before anything else happens. The file is the record that survives us; memory is only the
// fast path.

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RULE_PREFIX = 'MLMVPN-AE';
const GROUP = 'MLMVPN Aether';

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STATE_FILE = path.join(HOME_DIR, 'aether-guard-state.json');

// The GitHub Tunnel guard sets the very same DefaultOutboundAction. If it is engaged and we
// captured the live profiles now, we would record ITS Block as "what the machine looked like
// before", and our restore would then make block-by-default permanent — the safety mechanism
// bricking the machine, which is the exact bug gt-guard.js documents in its own header.
const GT_STATE_FILE = path.join(HOME_DIR, 'gt-guard-state.json');

const OUTBOUND_VALUES = ['NotConfigured', 'Allow', 'Block'];
const ENABLED_VALUES = ['NotConfigured', 'True', 'False'];

let state = {
    dnsOwned: false,        // Windows resolvers currently point at our loopback bridge
    dnsSnapshot: null,      // file holding what they were before
    firewallEngaged: false,
    savedProfiles: null,    // [{ name, action, enabled }]
};
let hooksInstalled = false;

// ── state file ────────────────────────────────────────────────────────────────

function writeState() {
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        const tmp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({
            at: Date.now(),
            pid: process.pid,
            dnsOwned: state.dnsOwned,
            dnsSnapshot: state.dnsSnapshot,
            firewallEngaged: state.firewallEngaged,
            profiles: state.savedProfiles,
        }, null, 2), 'utf8');
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) { /* a missing record only costs us the safety net, never correctness */ }
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return null; }
}

function clearState() {
    try { fs.rmSync(STATE_FILE, { force: true }); } catch (e) {}
}

function gtGuardEngaged() {
    try { return fs.existsSync(GT_STATE_FILE); } catch (e) { return false; }
}

// ── powershell ────────────────────────────────────────────────────────────────

function ps(script, { sync = false, timeout = 45000 } = {}) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    if (sync) {
        return execFileSync('powershell.exe', args, { windowsHide: true, timeout, encoding: 'utf8' });
    }
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', args, { windowsHide: true, timeout }, (err, stdout, stderr) => {
            if (err) return reject(new Error(String(stderr || err.message || '').trim()));
            resolve(String(stdout || ''));
        });
    });
}

// ── DNS ownership marker ──────────────────────────────────────────────────────

/**
 * Record that Windows' resolvers are about to be pointed at our loopback bridge.
 * MUST be called BEFORE the change. Called after, a crash in between is exactly the case
 * with no record and no way back.
 */
function armDns(snapshotFile) {
    state.dnsOwned = true;
    state.dnsSnapshot = snapshotFile || null;
    installHooks();
    writeState();
}

/** The change has been undone by the normal path; stop claiming ownership. */
function disarmDns() {
    state.dnsOwned = false;
    state.dnsSnapshot = null;
    if (!state.firewallEngaged) clearState(); else writeState();
}

/**
 * Synchronous restore, for exit handlers where promises never settle.
 * Best effort by design: a failure here must not stop the app from quitting, but it must
 * always be ATTEMPTED, because the alternative is a machine that resolves nothing.
 */
function disarmDnsSync() {
    if (!state.dnsOwned) return false;
    let ok = false;
    try {
        ok = require('./dns-manager').restoreBackupSync({ snapshotFile: state.dnsSnapshot });
    } catch (e) { /* fall through: the marker is cleared either way, see below */ }
    state.dnsOwned = false;
    state.dnsSnapshot = null;
    if (!state.firewallEngaged) clearState(); else writeState();
    return ok;
}

// ── firewall kill switch ──────────────────────────────────────────────────────

/**
 * What the firewall looked like before we touched it.
 *
 * Read as STRINGS. The numeric form of NetSecurity.Action is a trap: NotConfigured=0,
 * **Allow=2, Block=4**. Code that reads 2 as Block makes its own restore path set Block
 * permanently — the failure gt-guard.js hit and documents. '.ToString()' produces exactly
 * the values Set-NetFirewallProfile accepts back.
 */
async function captureProfiles() {
    const raw = await ps(
        `Get-NetFirewallProfile | Select-Object -Property Name,` +
        `@{Name='Outbound';Expression={$_.DefaultOutboundAction.ToString()}},` +
        `@{Name='Enabled';Expression={$_.Enabled.ToString()}} | ConvertTo-Json -Compress`,
    );
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed])
        .filter(p => p && typeof p.Name === 'string' && /^[A-Za-z]+$/.test(p.Name))
        .map(p => ({
            name: p.Name,
            // Anything unrecognised falls back to the value that cannot leave a user
            // offline. Being briefly less strict than they were is recoverable; being
            // stricter is the failure with no way out.
            action: OUTBOUND_VALUES.includes(p.Outbound) ? p.Outbound : 'Allow',
            enabled: ENABLED_VALUES.includes(p.Enabled) ? p.Enabled : 'NotConfigured',
        }));
}

function quote(s) { return String(s).replace(/'/g, "''"); }

/**
 * Turn the kill switch on.
 *
 * @param adapterAlias   our TUN adapter; everything leaving through it is allowed
 * @param allowPrograms  absolute paths permitted to talk OUTSIDE the tunnel. This must
 *   include the engine (it has to reach the Cloudflare edge or it can never reconnect and
 *   the guard becomes a permanent outage) and sing-box (it owns the socket for every packet
 *   the routing rules send `direct`, including the engine's own uplink).
 */
async function engageKillSwitch({ adapterAlias, allowPrograms = [], onLog } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    if (state.firewallEngaged) return { ok: true, alreadyEngaged: true };

    // Refuse rather than corrupt. Two modules both driving DefaultOutboundAction is how one
    // of them records the other's Block as the machine's original state.
    if (gtGuardEngaged()) {
        log('[GUARD] محافظ نشت GitHub Tunnel فعال است؛ محافظ وارپ روشن نشد تا تنظیمات فایروال خراب نشود.');
        return { ok: false, reason: 'gt-guard-engaged' };
    }
    if (!adapterAlias) return { ok: false, reason: 'no-adapter' };

    installHooks();

    if (!state.savedProfiles) {
        // A record left by a run that died engaged is the ONLY honest source for the
        // pre-change state; reading the live profiles now would capture our own Block.
        const stale = readState();
        state.savedProfiles = (stale && Array.isArray(stale.profiles) && stale.profiles.length)
            ? stale.profiles
            : await captureProfiles();
    }
    // Written BEFORE the firewall is touched.
    state.firewallEngaged = true;
    writeState();

    // A profile whose firewall is switched OFF ignores DefaultOutboundAction completely.
    //
    // The old behaviour was to switch it on for the duration. That is too much to do to
    // someone's machine behind their back, and it went wrong exactly as you would fear: on a
    // machine with all three profiles disabled the guard turned the firewall ON, then the
    // rule build failed halfway, and the user was left with a firewall they had deliberately
    // switched off — and no internet. A third-party security suite is the usual reason those
    // profiles are off, and fighting it is not our business.
    //
    // So: if the firewall is off, we do not turn it on. We say the kill switch is
    // unavailable, which is honest, and the caller surfaces that rather than showing
    // protection that does not exist.
    const disabled = state.savedProfiles.filter(p => p.enabled === 'False');
    if (disabled.length === state.savedProfiles.length) {
        state.firewallEngaged = false;
        state.savedProfiles = null;
        if (!state.dnsOwned) clearState(); else writeState();
        log('[GUARD] دیوارآتش ویندوز روی این سیستم خاموش است، پس محافظ نشت نمی‌تواند کار کند. برنامه فایروال شما را روشن نمی‌کند.');
        return { ok: false, reason: 'firewall-disabled' };
    }
    if (disabled.length) {
        log(`[GUARD] دیوارآتش ${disabled.map(p => p.name).join('، ')} خاموش است؛ محافظ فقط روی پروفایل‌های روشن اعمال می‌شود.`);
    }

    const progRules = allowPrograms.filter(Boolean).map((p, i) =>
        `New-NetFirewallRule -DisplayName '${RULE_PREFIX}-prog-${i}' -Group '${GROUP}' ` +
        `-Direction Outbound -Program '${quote(p)}' -Action Allow -Profile Any | Out-Null`
    ).join('\n');

    const script = `
$ErrorActionPreference = 'Stop'
Remove-NetFirewallRule -Group '${GROUP}' -ErrorAction SilentlyContinue

# Allow-list FIRST, block-by-default LAST. The other order leaves a window, however short,
# in which the machine has no working network path at all.
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-tunnel' -Group '${GROUP}' -Direction Outbound -InterfaceAlias '${quote(adapterAlias)}' -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-loopback' -Group '${GROUP}' -Direction Outbound -RemoteAddress 127.0.0.0/8 -Action Allow -Profile Any | Out-Null
# NO ::1 RULE. Windows Firewall rejects a loopback address as -RemoteAddress outright:
#   "An unspecified, multicast, broadcast, or loopback IPv6 address was specified."
# $ErrorActionPreference='Stop' then aborts the whole script, so the allow-list is only
# half built when Set-NetFirewallProfile would have run — the guard reports failure and,
# worse, it has already switched profiles on. Windows does not filter loopback traffic
# anyway, so the rule bought nothing even when it was accepted.
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-lan' -Group '${GROUP}' -Direction Outbound -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-dhcp' -Group '${GROUP}' -Direction Outbound -Protocol UDP -RemotePort 67,68 -Action Allow -Profile Any | Out-Null
${progRules}

Set-NetFirewallProfile -All -Enabled True -DefaultOutboundAction Block
`;
    try {
        await ps(script);
    } catch (e) {
        // Engaging failed halfway. Undo whatever landed rather than leaving a partial
        // block-by-default state behind.
        try { await releaseKillSwitch(); } catch (_) {}
        return { ok: false, reason: e.message };
    }
    log('[GUARD] ✅ محافظ نشت فعال شد — اگر تونل بمیرد، ترافیک با آی‌پی واقعی بیرون نمی‌رود.');
    return { ok: true };
}

function buildReleaseScript() {
    const restores = (state.savedProfiles || [])
        // Re-validated at USE time, not only at capture time: this list can also come off
        // disk, written by an older build, and it is about to become a command line.
        .filter(p => p && /^[A-Za-z]+$/.test(p.name || '') && OUTBOUND_VALUES.includes(p.action))
        .map((p) => {
            const enabled = ENABLED_VALUES.includes(p.enabled) ? p.enabled : null;
            return `Set-NetFirewallProfile -Name '${p.name}' -DefaultOutboundAction ${p.action}`
                + (enabled ? ` -Enabled ${enabled}` : '');
        })
        .join('\n');
    // If the saved state was somehow never captured, fall back to Allow: leaving a user with
    // no internet is a worse failure than briefly leaving the guard off.
    return `
$ErrorActionPreference = 'SilentlyContinue'
${restores || 'Set-NetFirewallProfile -All -DefaultOutboundAction Allow'}
Remove-NetFirewallRule -Group '${GROUP}' -ErrorAction SilentlyContinue
`;
}

async function releaseKillSwitch(onLog) {
    if (!state.firewallEngaged && !state.savedProfiles) return false;
    try { await ps(buildReleaseScript()); } catch (e) { /* best effort */ }
    state.firewallEngaged = false;
    state.savedProfiles = null;
    // Last: while the record exists the machine is considered "possibly still firewalled",
    // and clearing it before the restore ran would throw away the only way to undo a change
    // that is still in place.
    if (!state.dnsOwned) clearState(); else writeState();
    try { onLog && onLog('[GUARD] محافظ نشت غیرفعال شد.'); } catch (e) {}
    return true;
}

function releaseKillSwitchSync() {
    if (!state.firewallEngaged && !state.savedProfiles) return false;
    try { ps(buildReleaseScript(), { sync: true, timeout: 25000 }); } catch (e) {}
    state.firewallEngaged = false;
    state.savedProfiles = null;
    if (!state.dnsOwned) clearState(); else writeState();
    return true;
}

// ── crash recovery ────────────────────────────────────────────────────────────

/**
 * Undo anything a previous run left behind, before this run changes anything.
 *
 * Runs unconditionally at startup — even when the user has never opened the Aether panel —
 * because a machine left block-by-default, or resolving through a dead loopback address, has
 * no internet and nothing on screen connecting the two facts.
 */
async function restoreIfStale(onLog) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    const stale = readState();
    const result = { firewall: false, dns: false };

    // The DNS half is checked against the LIVE machine, not only against our record: a run
    // killed before it could write the marker still leaves the adapters stranded, and that is
    // precisely the case with no record to read.
    let stranded = false;
    // ASYNC, deliberately. This function is already async and start-up calls it without
    // awaiting — precisely so a slow PowerShell cannot delay the window. The sync form
    // here defeated that: it blocked Electron's main process on every launch, before the
    // window existed. Measured at 2167 ms with one adapter up, and it grew with every
    // extra adapter on the machine.
    try { stranded = await require('./dns-manager').hasStrandedLoopbackDns(); } catch (e) {}

    if (stale && stale.firewallEngaged) {
        state.savedProfiles = Array.isArray(stale.profiles) ? stale.profiles : null;
        state.firewallEngaged = true;
        try {
            await ps(buildReleaseScript());
            state.firewallEngaged = false;
            state.savedProfiles = null;
            result.firewall = true;
            log('[GUARD] محافظ نشتِ باقی‌مانده از اجرای قبلی برداشته شد — اینترنت سیستم آزاد شد.');
        } catch (e) {
            // Leave the record in place: not restoring is recoverable next launch, losing the
            // record is not.
            log(`[GUARD] ⚠️ برداشتن محافظ قبلی ناموفق بود: ${e.message}`);
        }
    }

    if (stranded) {
        // ONLY a snapshot this run's predecessor actually wrote, and only a fresh one.
        //
        // The fallback used to be dns-backup.json — "what the machine looked like the first
        // time this app ever ran". On this machine that file was 26 days old and recorded
        // Shecan Pro (178.22.122.101), so every single app start silently reinstated a
        // filtering Iranian resolver the user had long since moved off. Startup recovery
        // exists to rescue a stranded machine, not to restore month-old state nobody asked
        // for, and getting that wrong is worse than doing nothing: it is the app changing
        // the user's DNS behind their back, on every launch, forever.
        //
        // With no trustworthy record the loopback sweep alone is the right answer — it puts
        // adapters back on DHCP/known-good and stops there.
        const FRESH_MS = 24 * 60 * 60 * 1000;
        let snapshot = null;
        try {
            if (stale && stale.dnsSnapshot && fs.existsSync(stale.dnsSnapshot)) {
                const snap = JSON.parse(fs.readFileSync(stale.dnsSnapshot, 'utf8'));
                if (snap && Date.now() - (snap.at || 0) < FRESH_MS) snapshot = stale.dnsSnapshot;
                else log('[GUARD] عکس DNS قبلی خیلی قدیمی بود و استفاده نشد.');
            }
        } catch (e) { /* no usable snapshot; the sweep still rescues the machine */ }

        try {
            require('./dns-manager').restoreBackupSync({ snapshotFile: snapshot, sweepOnly: !snapshot });
            result.dns = true;
            log('[GUARD] DNS سیستم روی آدرس لوپ‌بکِ مرده مانده بود و آزاد شد.');
        } catch (e) {
            log(`[GUARD] ⚠️ برگرداندن DNS ناموفق بود: ${e.message}`);
        }
    }

    state.dnsOwned = false;
    state.dnsSnapshot = null;
    if (!state.firewallEngaged) clearState();
    return result;
}

// ── exit hooks ────────────────────────────────────────────────────────────────

function installHooks() {
    if (hooksInstalled) return;
    hooksInstalled = true;
    const bail = () => {
        try { disarmDnsSync(); } catch (e) {}
        try { releaseKillSwitchSync(); } catch (e) {}
    };
    process.on('exit', bail);
    process.on('SIGINT', () => { bail(); process.exit(130); });
    process.on('SIGTERM', () => { bail(); process.exit(143); });
    // Rethrown deliberately: swallowing it would keep a process alive in an unknown state,
    // which is worse than crashing with the machine already put back.
    process.on('uncaughtException', (e) => { bail(); throw e; });
}

/** Everything, synchronously. The single call `before-quit` needs. */
function bailSync() {
    let did = false;
    try { did = disarmDnsSync() || did; } catch (e) {}
    try { did = releaseKillSwitchSync() || did; } catch (e) {}
    return did;
}

function getStatus() {
    return {
        dnsOwned: state.dnsOwned,
        dnsSnapshot: state.dnsSnapshot,
        killSwitch: state.firewallEngaged,
    };
}

module.exports = {
    armDns, disarmDns, disarmDnsSync,
    engageKillSwitch, releaseKillSwitch, releaseKillSwitchSync,
    restoreIfStale, bailSync, getStatus, installHooks,
    STATE_FILE, GROUP,
    // exposed for tests: the restore script is the thing that must never be wrong
    _internal: { buildReleaseScript, captureProfiles, readState, writeState, clearState },
};
