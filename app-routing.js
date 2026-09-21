// --- «مسیر برنامه‌ها»: which apps use the tunnel (Android's split tunnel, on Windows) ---
//
// Android's advanced VPN settings pick per app: every app through the VPN, only the chosen ones,
// or everyone except the chosen ones. Android does it with VpnService.Builder.addAllowed/
// addDisallowedApplication; on Windows the same choice is a routing rule in the full-system
// tunnel — sing-box sees which process owns each connection and routes it by `process_name`.
//
// This module is the one owner of that choice (the way Android's NetworkSettings owns the network
// settings): it is saved in ~/.mlmvpn/app-routing.json, tun-manager reads it every time it builds
// a tunnel, and no engine keeps a copy.
//
// WHAT IT CAN AND CANNOT DO, said plainly because it decides whether the user can trust it:
//   * It acts on the FULL-SYSTEM TUNNEL (V2Ray's «تونل», the WARP engines, Google Script). The
//     system proxy is a suggestion each app takes or ignores, so there is no per-app choice to
//     make there — the Settings page says so.
//   * DNS is not per app on Windows: most programs ask the DNS Client service (svchost), not the
//     network themselves. So lookups stay in the tunnel for everyone and only CONNECTIONS follow
//     the choice. A bypassed app still reaches the right site; it just goes there directly.
//   * The engines' own processes are never offered and never honoured if they slip in: routing
//     an engine's uplink back into itself is the loop tun-manager exists to prevent.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.mlmvpn', 'app-routing.json');
const MODES = ['all', 'allow', 'bypass'];

// Never routable by the user: every engine the app runs, and the app itself.
const RESERVED = new Set([
    'xray.exe', 'sing-box.exe', 'aether.exe', 'gst.exe', 'tailscaled.exe', 'tailscale.exe',
    'mlm vpn.exe', 'electron.exe',
]);

function normalizeExe(exe) {
    const base = String(exe || '').trim().split(/[\\/]/).pop().toLowerCase();
    return /^[^<>:"|?*\x00-\x1f]+\.exe$/.test(base) ? base : null;
}

function sanitize(input) {
    const mode = MODES.includes(input && input.mode) ? input.mode : 'all';
    const seen = new Set();
    const apps = [];
    for (const a of (input && Array.isArray(input.apps) ? input.apps : [])) {
        const exe = normalizeExe(a && (a.exe || a.path));
        if (!exe || RESERVED.has(exe) || seen.has(exe)) continue;
        seen.add(exe);
        apps.push({
            exe,
            name: String((a && a.name) || exe).slice(0, 120),
            path: typeof (a && a.path) === 'string' ? a.path.slice(0, 520) : '',
        });
    }
    return { mode, apps };
}

function get() {
    try { return sanitize(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { return { mode: 'all', apps: [] }; }
}

function set(next) {
    const clean = sanitize(next);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(clean, null, 2));
    return clean;
}

/**
 * The sing-box rules this choice turns into, for a tunnel whose engine outbound is `engineTag`.
 *   bypass → the chosen apps go 'direct'; everything else keeps the tunnel's own routing.
 *   allow  → the chosen apps go to the engine, and the tunnel's `final` becomes 'direct'.
 *   all    → nothing to add.
 * `excludeProcess` is the engine's own executable, never touched whatever is saved.
 */
// sing-box's `process_name` is an exact, CASE-SENSITIVE match against the real file name
// (measured on the bundled 1.14: a rule for "Curl.exe" let curl.exe through). The choice is
// saved lowercased, so every program whose file name has a capital letter — Telegram.exe,
// WhatsApp.exe, Discord.exe, Spotify.exe, Code.exe — was never matched: «عدم تونل» left it in the
// tunnel. The rule is therefore a case-insensitive pattern on the process path, anchored to the
// whole file name so "url.exe" never catches "curl.exe" (both checked against sing-box itself).
function exeMatcher(exes) {
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { process_path_regex: exes.map((e) => '(?i)(?:^|[\\\\/])' + esc(e) + '$') };
}

function tunRules(engineTag, excludeProcess, routing = get()) {
    const own = String(excludeProcess || '').toLowerCase();
    const exes = routing.apps.map(a => a.exe).filter(e => e !== own && !RESERVED.has(e));
    const match = exeMatcher(exes);
    if (routing.mode === 'bypass' && exes.length) {
        return { rules: [Object.assign({}, match, { outbound: 'direct' })], match, exes, final: null, mode: 'bypass', count: exes.length };
    }
    if (routing.mode === 'allow') {
        // AN EMPTY ALLOW-LIST IS AN UNFINISHED SETTING, NOT «CARRY NOTHING».
        //
        // Taken literally, "only these applications" with none listed means the tunnel carries
        // nothing: `final: direct` and no rule pointing at the engine. That is what this returned,
        // and it is how every full tunnel on this machine came to be a passthrough — measured
        // 2026-09-13, saved state {"mode":"allow","apps":[]}.
        //
        // It is worse than not tunnelling. DNS is still hijacked into sing-box and answered through
        // the engine, so a filtered name resolves to its real address and is then dialled DIRECT,
        // where the line refuses it: ordinary sites load, every blocked one fails, and the engine
        // looks broken whichever method is chosen. That was the bug report, and the method list was
        // innocent.
        //
        // The state is one click away — the list is empty until something is added — so it must
        // behave as «not configured yet»: full tunnel, and SAID OUT LOUD by the caller. A user who
        // genuinely wants nothing carried does not turn the tunnel on.
        if (!exes.length) return { rules: [], match, exes, final: null, mode: 'allow-empty', count: 0 };
        return { rules: [Object.assign({}, match, { outbound: engineTag })], match, exes, final: 'direct', mode: 'allow', count: exes.length };
    }
    return { rules: [], match, exes, final: null, mode: 'all', count: 0 };
}

module.exports = { get, set, sanitize, tunRules, exeMatcher, normalizeExe, RESERVED, FILE };
