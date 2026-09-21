// --- GitHub Tunnel: fail-closed guard (kill-switch + IPv6 containment) ---
//
// WHAT THIS PREVENTS
// Without it, the tunnel failing is *silent and worse than being disconnected*: tailscaled
// dies or the exit node drops, Windows quietly falls back to the physical route, and the
// next packet from a browser that is already mid-session carries the user's real address.
// Nothing errors. Nothing pops up. The user finds out from the far end. For someone in the
// middle of a trade on an exchange that geo-bans them, that is the whole ballgame.
//
// HOW
// Windows firewall profiles get DefaultOutboundAction=Block, plus a narrow allow-list:
//   * anything leaving through the tunnel adapter,
//   * the engine itself (tailscaled must reach relays or it can never reconnect),
//   * this app (it needs the control plane to rebuild the session — otherwise a dropped
//     tunnel is unrecoverable without the user turning the guard off by hand),
//   * loopback and the local subnet, so LAN/printers/router UI keep working.
// Everything else, including ALL IPv6 (the exit node has no v6 egress, so v6 can only ever
// be a leak path), is dropped.
//
// THE DANGEROUS PART, AND WHY THE RESTORE PATH IS THE WAY IT IS
// A block-by-default firewall that outlives the process would leave the machine with no
// internet and no obvious cause. So the previous profile state is captured before any
// change, and restored from: normal disengage, process exit, SIGINT/SIGTERM, and an
// uncaught exception. The exit paths use SYNCHRONOUS calls on purpose — an async restore
// scheduled during 'exit' never runs.

// ── THE HOLE THIS FILE USED TO HAVE, AND WHY IT WAS THE WORST ONE ──────────────────
// Every restore path above is an in-process one. None of them run when the process does
// not get to run code: Task Manager "End task", a hard crash, a bluescreen, power loss,
// an antivirus killing the app. In every one of those the machine is left with
// DefaultOutboundAction=Block and an allow-list whose only useful entry points at a tunnel
// adapter that no longer exists — that is a PC with no internet, no error message, and no
// way for its owner to connect the two facts. Reinstalling the app does not fix it either.
//
// So the pre-change firewall state is also written to disk the moment it is captured, and
// restoreIfStale() puts it back at startup before anything else happens. The file is the
// record that survives us; the in-memory copy is only the fast path.

const { execFileSync, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const RULE_PREFIX = 'MLMVPN-GT';
const GROUP = 'MLMVPN GitHub Tunnel';

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STATE_FILE = path.join(HOME_DIR, 'gt-guard-state.json');

let engaged = false;
let savedOutboundActions = null; // [{ name, action }]
let restoreHooksInstalled = false;

function writeStateFile(profiles) {
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        const tmp = `${STATE_FILE}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ engagedAt: Date.now(), profiles }, null, 2), 'utf8');
        fs.renameSync(tmp, STATE_FILE);
    } catch (e) { /* see clearStateFile: a missing record only costs us the safety net */ }
}

function readStateFile() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        return Array.isArray(s.profiles) && s.profiles.length ? s.profiles : null;
    } catch (e) { return null; }
}

function clearStateFile() {
    try { fs.rmSync(STATE_FILE, { force: true }); } catch (e) {}
}

function ps(script, { sync = false } = {}) {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    if (sync) {
        return execFileSync('powershell.exe', args, { windowsHide: true, timeout: 30000, encoding: 'utf8' });
    }
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', args, { windowsHide: true, timeout: 45000 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message || '').toString().trim()));
            resolve((stdout || '').toString());
        });
    });
}

function installRestoreHooks() {
    if (restoreHooksInstalled) return;
    restoreHooksInstalled = true;
    const bail = () => { try { disengageSync(); } catch (e) {} };
    process.on('exit', bail);
    process.on('SIGINT', () => { bail(); process.exit(130); });
    process.on('SIGTERM', () => { bail(); process.exit(143); });
    process.on('uncaughtException', (e) => { bail(); throw e; });
}

function removeRulesScript() {
    return `Remove-NetFirewallRule -Group '${GROUP}' -ErrorAction SilentlyContinue`;
}

// The only values Set-NetFirewallProfile accepts for these two. Everything read back from
// PowerShell is checked against them before it is ever interpolated into a script: a value
// that is not on this list is not a firewall setting, it is either corruption or an
// injection attempt, and either way must not be executed.
const OUTBOUND_VALUES = ['NotConfigured', 'Allow', 'Block'];
const ENABLED_VALUES = ['NotConfigured', 'True', 'False'];

/**
 * What the firewall looked like before this feature touched it.
 *
 * Read as STRINGS, deliberately.
 *
 * The numeric form of this enum is a trap, and the previous version fell straight into it.
 * Microsoft's NetSecurity.Action is NotConfigured=0, **Allow=2, Block=4** — while the code
 * treated 2 as Block. So on any machine that had an explicit Allow (value 2) the guard
 * recorded "Block", and then its own restore path — the thing whose entire job is to give
 * the user their internet back — set DefaultOutboundAction=Block permanently. The safety
 * mechanism was the thing that bricked the machine, and it would have done it on
 * disengage, on quit, and on crash recovery alike. Reading '.ToString()' removes the whole
 * class of bug, and the strings it produces are exactly the values Set-NetFirewallProfile
 * takes back.
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

/**
 * Turn the guard on.
 * @param adapterName  the tunnel adapter (traffic through it is always allowed)
 * @param allowPrograms absolute paths permitted to talk outside the tunnel
 */
async function engage({ adapterName, allowPrograms = [], onLog } = {}) {
    const log = (m) => { try { onLog && onLog(m); } catch (e) {} };
    installRestoreHooks();

    if (!savedOutboundActions) {
        // A record left by a run that died engaged is the ONLY honest source for what the
        // machine looked like before this feature touched it — reading the live profiles
        // now would just capture our own Block and make it permanent. restoreIfStale()
        // normally clears this at startup; this is the belt for the case where it could
        // not run (no admin rights at the time, PowerShell unavailable, etc.).
        const stale = readStateFile();
        if (stale) {
            savedOutboundActions = stale;
        } else {
            savedOutboundActions = await captureProfiles();
        }
    }
    // Written BEFORE the firewall is touched. Written after, a crash in between is exactly
    // the case with no record and no way back.
    writeStateFile(savedOutboundActions);

    // A profile whose firewall is switched OFF ignores DefaultOutboundAction completely.
    // Engaging on such a machine used to "succeed" and block precisely nothing, while the
    // panel showed the kill-switch lit — the exact false sense of protection this whole
    // module exists to prevent. Machines with a third-party security suite are usually in
    // that state. So the profile is switched on for the duration and put back byte-for-byte
    // by the same restore path as everything else.
    const disabled = savedOutboundActions.filter(p => p.enabled === 'False');
    if (disabled.length) {
        log(`دیوارآتش ویندوز (${disabled.map(p => p.name).join('، ')}) خاموش بود و برای کار کردن محافظ نشت موقتاً روشن شد؛ هنگام قطع اتصال به حالت قبل برمی‌گردد.`);
    }

    const progRules = allowPrograms
        .filter(Boolean)
        .map((p, i) => `New-NetFirewallRule -DisplayName '${RULE_PREFIX}-prog-${i}' -Group '${GROUP}' -Direction Outbound -Program '${p.replace(/'/g, "''")}' -Action Allow -Profile Any | Out-Null`)
        .join('\n');

    const script = `
$ErrorActionPreference = 'Stop'
${removeRulesScript()}

# Allow-list FIRST, block-by-default LAST. Doing it the other way round means a window,
# however short, where the machine has no working network path at all.
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-tunnel' -Group '${GROUP}' -Direction Outbound -InterfaceAlias '${adapterName}' -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-loopback' -Group '${GROUP}' -Direction Outbound -RemoteAddress 127.0.0.1/8 -Action Allow -Profile Any | Out-Null
# ::1 as well. Windows does not filter loopback in practice, but a v6-only local service
# (and there are a few, mDNS responders among them) hanging for 20s on a blocked connect
# reads to the user as "the app froze when I turned the tunnel on".
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-loopback6' -Group '${GROUP}' -Direction Outbound -RemoteAddress ::1/128 -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-lan' -Group '${GROUP}' -Direction Outbound -RemoteAddress LocalSubnet -Action Allow -Profile Any | Out-Null
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-dhcp' -Group '${GROUP}' -Direction Outbound -Protocol UDP -RemotePort 67,68 -Action Allow -Profile Any | Out-Null
${progRules}

# IPv6 is not carried by the exit node, so every v6 packet that leaves this machine is by
# definition outside the tunnel. It is already dropped by DefaultOutboundAction=Block
# below — that default is address-family agnostic — and the two -Program allow rules are
# the only holes, which is deliberate: the daemon and this app must reach the control
# plane over whatever the machine has.
#
# (An earlier version claimed this next rule was what blocked IPv6. It is not: -Protocol
# ICMPv6 matches ICMPv6 only, not TCP or UDP over v6. It is kept because dropping Router
# Advertisement / Neighbor Discovery chatter stops Windows re-deriving a v6 default route
# and re-trying AAAA behind our back, which is the actual cause of the stalls.)
New-NetFirewallRule -DisplayName '${RULE_PREFIX}-block-v6' -Group '${GROUP}' -Direction Outbound -Protocol ICMPv6 -Action Block -Profile Any | Out-Null

# -Enabled True as well as the block action: on a profile that is switched off, the block
# action is inert and the guard protects nothing at all (see engage()).
Set-NetFirewallProfile -All -Enabled True -DefaultOutboundAction Block
`;
    await ps(script);
    engaged = true;
    log('محافظ نشت فعال شد — اگر تونل قطع شود، هیچ ترافیکی با آی‌پی واقعی خارج نمی‌شود.');
}

function buildRestoreScript() {
    const restores = (savedOutboundActions || [])
        // Re-validated at USE time, not only at capture time: this list can also come off
        // disk, written by an older build or edited by hand, and it is about to become a
        // PowerShell command line.
        .filter(p => p && /^[A-Za-z]+$/.test(p.name || '') && OUTBOUND_VALUES.includes(p.action))
        .map((p) => {
            const enabled = ENABLED_VALUES.includes(p.enabled) ? p.enabled : null;
            // Records written before profile Enabled was tracked have no `enabled` field.
            // Leave the switch alone rather than guessing at it.
            return `Set-NetFirewallProfile -Name '${p.name}' -DefaultOutboundAction ${p.action}`
                + (enabled ? ` -Enabled ${enabled}` : '');
        })
        .join('\n');
    // If the saved state was somehow never captured, fall back to Allow: leaving a user
    // with no internet is a worse failure than briefly leaving the guard off.
    return `
$ErrorActionPreference = 'SilentlyContinue'
${restores || 'Set-NetFirewallProfile -All -DefaultOutboundAction Allow'}
${removeRulesScript()}
`;
}

async function disengage(onLog) {
    if (!engaged && !savedOutboundActions) return;
    try { await ps(buildRestoreScript()); } catch (e) {}
    engaged = false;
    savedOutboundActions = null;
    // Last: while this file exists, the machine is considered "possibly still firewalled",
    // and clearing it before the restore actually ran would throw away the only record of
    // how to undo a change that is still in place.
    clearStateFile();
    try { onLog && onLog('محافظ نشت غیرفعال شد.'); } catch (e) {}
}

/** Synchronous twin of disengage(), for exit handlers where promises never settle. */
function disengageSync() {
    if (!engaged && !savedOutboundActions) return;
    try { ps(buildRestoreScript(), { sync: true }); } catch (e) {}
    engaged = false;
    savedOutboundActions = null;
    clearStateFile();
}

/**
 * Undo a guard that outlived the process that engaged it.
 *
 * Called once at startup, before anything else this feature does. If the previous run was
 * killed while engaged, this is the ONLY thing standing between the user and a PC that
 * has no internet for reasons nothing on screen explains — so it runs even when the app
 * has no session, no GitHub account, and the user has never opened the panel.
 *
 * @returns {Promise<{restored: boolean, error?: string}>}
 */
async function restoreIfStale(onLog) {
    const stale = readStateFile();
    if (!stale) return { restored: false };
    savedOutboundActions = stale;
    try {
        await ps(buildRestoreScript());
    } catch (e) {
        // Leave the file in place: not restoring is recoverable on the next launch, losing
        // the record is not.
        savedOutboundActions = null;
        return { restored: false, error: e.message };
    }
    engaged = false;
    savedOutboundActions = null;
    clearStateFile();
    try { onLog && onLog('محافظ نشت که از اجرای قبلی باقی مانده بود برداشته شد — اینترنت سیستم آزاد شد.'); } catch (e) {}
    return { restored: true };
}

function isEngaged() { return engaged; }

module.exports = { engage, disengage, disengageSync, restoreIfStale, isEngaged, STATE_FILE };
