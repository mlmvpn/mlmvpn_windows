#!/usr/bin/env node
/*
 * Aether / TUN / DNS test suite.
 *
 *   node tests/aether/run.js
 *
 * Everything here is safe to run on a working machine, by construction:
 *   * USERPROFILE is redirected to a sandbox before any module is required, so no test can
 *     read or write the real ~/.mlmvpn;
 *   * PowerShell is replaced by a recorder in the guard tests. That code sets
 *     DefaultOutboundAction=Block on every firewall profile and rewrites the machine's
 *     resolvers — it must NEVER actually run during a test, and the recorder is what makes
 *     asserting on it possible instead;
 *   * the DNS tests speak to a fake SOCKS5 engine on loopback, never to the network.
 *
 * The suites, and what each one is guarding against:
 *
 *   config.test.js     The generated sing-box configuration. Rule ORDER is the behaviour —
 *                      first match wins — and several orderings here have each been a real
 *                      leak: DNS `final` pointing at a direct resolver, the filter sinkhole
 *                      (10.10.34.x) falling through to the LAN rule, IPv6 reaching `direct`,
 *                      the engine's own uplink being fed back into the engine.
 *   guard.test.js      The fail-closed kill switch and crash recovery. Pins the
 *                      NetSecurity.Action enum (NotConfigured=0, Allow=2, Block=4) — reading
 *                      Allow as Block makes the restore path itself set Block permanently —
 *                      and the refusal to engage while the GitHub Tunnel guard holds the
 *                      firewall, which would otherwise record ITS Block as the original state.
 *   dns-bridge.test.js The resolver. Covers the transaction-id handling that once shifted
 *                      every cached reply two bytes and made Windows fall back to the ISP,
 *                      the in-flight de-duplication, and the UDP->TCP learning that replaced
 *                      a per-query 5s timeout.
 *   engine.test.js     Configuration validation and the log -> stage parser. That parser is
 *                      the ONLY thing that knows the tunnel is alive; a line it fails to
 *                      classify is a dead tunnel with a green badge over it.
 *   resolver.test.js   Which resolver the full tunnel asks, measured through the engine. A
 *                      fixed 1.1.1.1 is unreachable from a Cloudflare Worker node, and the
 *                      V2Ray tunnel came up on the user's worker with every lookup dead.
 *   app-routing.test.js «مسیر برنامه‌ها»: where the per-app rules land in the full and smart
 *                      tunnels (first match wins), what `final` becomes, that the engine can
 *                      never be routed into itself, and that startTun hands the builders both
 *                      the per-app choice and V2Ray's measured resolver.
 *   network-settings.test.js  Settings › «شبکه»: with nothing set the Xray config is exactly the
 *                      old one; ports, LAN sharing and backend DNS reach Xray and pass
 *                      `xray run -test`; bad values are refused whole; MTU per method.
 *   settings-parity.test.js  Every row of Android's Settings on a Windows pane, and the server
 *                      pieces behind them: the updater never downgrades, crash reports only
 *                      watch, Always-On forgets what the user ended.
 *   lifecycle.test.js  The orchestration invariants behind every reported symptom: the grace
 *                      period vs the engine's real reconnect budget, fail-closed ordering,
 *                      the TUN re-arm, readiness by fact rather than by stopwatch, the
 *                      awaited DNS restore, and a UI that cannot claim protection it does
 *                      not have.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
    'config.test.js',
    'engine.test.js',
    'guard.test.js',
    'dns-bridge.test.js',
    'lifecycle.test.js',
    'packaging.test.js',
    'resolver.test.js',
    'app-routing.test.js',
    'network-settings.test.js',
    'settings-parity.test.js',
];

let failed = 0;
for (const suite of SUITES) {
    console.log(`\n${'─'.repeat(64)}\n${suite}\n${'─'.repeat(64)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}

console.log(`\n${'═'.repeat(64)}`);
console.log(failed ? `${failed} suite(s) FAILED` : `all ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
