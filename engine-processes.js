'use strict';

/**
 * Every executable this app runs that CARRIES SOMEBODY'S TRAFFIC — in one place.
 *
 * WHY THIS FILE EXISTS
 *
 * Two modules keep a list of "engines that must never be starved": `game/focus.js` (which
 * suspends and de-prioritises processes to give the machine to a game) and `game/shaper.js`
 * (which throttles or firewall-blocks processes to give the LINE to a game). Both lists were
 * written by hand, both said aether/xray/sing-box/tailscaled/gst, and both were correct on the
 * day they were written.
 *
 * Then سایفون, تور, لنترن and گف shipped — four more engines, four more processes that carry the
 * user's entire internet — and neither list was touched. The guard in `shaper.apply()` says, in
 * its own error message, «محدود کردنش خودِ تونل یا ویندوز را می‌شکند». It was right; it just did
 * not know about four of the six things it was protecting against.
 *
 * A hand-written list in two places drifts the moment a fifth engine lands. So there is one list,
 * here, and both modules read it. Adding an engine to this app now means adding one line HERE,
 * and every guard that needs to know finds out.
 *
 * WHAT BELONGS IN IT
 *
 * Anything whose suspension or throttling would take the user's connection away. That includes
 * the pluggable transports: on a bridge rung it is `lyrebird.exe`, not `tor.exe`, that holds the
 * outbound connection, so freezing it kills تور just as dead.
 *
 * It is deliberately NOT the same list as a tunnel's process exclusions (see `frontTunOptions` in
 * server.js). Those answer "whose packets must skip the tunnel"; this answers "who must keep
 * running". The overlap is large and the questions are different.
 */

/** Bare names, lower-case, no extension — the form PowerShell's `ProcessName` gives. */
const ENGINE_NAMES = [
    // WARP family (ماسک / وایرگارد / وارپ در وارپ) and the Xray/sing-box cores every panel uses
    'aether',
    'xray',
    'sing-box',
    'warp-svc',
    // «تونل گوگل‌اسکریپت» and «تونل گیت‌هاب»
    'gst',
    'tailscaled',
    'tailscale',
    // The four SOCKS-front engines
    'psiphon',
    'tor',
    'lyrebird',         // تور's pluggable transport — obfs4/meek/snowflake/webtunnel live here
    'conjure-client',   // …and Conjure has its own binary
    'lantern',
    'geph5-client',
];

/** The same list with `.exe`, which is the form firewall rules and QoS policies match on. */
const ENGINE_EXES = ENGINE_NAMES.map(n => `${n}.exe`);

const NAME_SET = new Set(ENGINE_NAMES);
const EXE_SET = new Set(ENGINE_EXES);

/** Is this process one of ours, whichever form the caller happens to hold? */
function isEngine(nameOrExe) {
    const s = String(nameOrExe || '').trim().toLowerCase();
    if (!s) return false;
    return NAME_SET.has(s) || EXE_SET.has(s) || NAME_SET.has(s.replace(/\.exe$/, ''));
}

module.exports = { ENGINE_NAMES, ENGINE_EXES, isEngine };
