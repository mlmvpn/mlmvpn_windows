#!/usr/bin/env node
/*
 * GitHub Tunnel test suite.
 *
 *   node tests/github-tunnel/run.js
 *
 * Everything here is safe to run on a working machine, by construction:
 *   * USERPROFILE is redirected to a sandbox directory before any module is required, so
 *     no test can read or write the real ~/.mlmvpn (GitHub token, broker deployment,
 *     sessions, install secret);
 *   * global.fetch is stubbed, so nothing reaches GitHub, Cloudflare or Tailscale;
 *   * PowerShell is replaced by a recorder in the kill-switch tests. That code sets
 *     DefaultOutboundAction=Block on every firewall profile — it must NEVER actually run
 *     during a test, and the recorder is what makes asserting on it possible instead.
 *
 * The suites, and what each one is guarding against:
 *
 *   kill-switch.test.js   The firewall guard, including the crash path: a process killed
 *                         while engaged used to leave the machine block-by-default with no
 *                         record and no way back. Also pins the NetSecurity.Action enum
 *                         (NotConfigured=0, Allow=2, Block=4) — reading Allow as Block made
 *                         the restore path itself set Block permanently.
 *   broker-auth.test.mjs  The Cloudflare Worker's request signing, driven through its real
 *                         default export. The Worker sits on a public URL and mints
 *                         pre-authorized, exit-node-approved Tailscale keys; it shipped
 *                         once with the signature field accepted and never checked.
 *   behaviour.test.js     Session store and state machine, the run-id dispatch matching
 *                         (which must survive a wrong local clock in both directions), the
 *                         fallback-proxy 401 distinction, workflow-template invariants and
 *                         the pinned MSI digest.
 *   routes.test.js        The HTTP surface on a throwaway express app, including a burst of
 *                         concurrent transitions that must serialise rather than interleave.
 *   accounts.test.js      The GitHub account pool: encrypted-at-rest tokens, health and
 *                         cooldown semantics, quota resolution (measured vs estimated vs
 *                         unknown), allocation ranking, session affinity, billing cycles,
 *                         and the concurrency case the leasing exists for — ten
 *                         simultaneous claims must never hand out one account twice.
 *   failover.test.js      The acceptance scenario end to end through the real
 *                         createSession(): two spent accounts, one that works, the session
 *                         bound to the account that actually ran it, and a live session
 *                         surviving its own account running out of allowance.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
    'kill-switch.test.js',
    'broker-auth.test.mjs',
    'behaviour.test.js',
    'routes.test.js',
    'accounts.test.js',
    'failover.test.js',
];

// gt-net tries the app's own Xray (127.0.0.1:20809) before the edge proxy. On a developer
// machine that port may really be open, which would route stubbed calls differently from
// run to run; the suites that exercise that path set their own port.
process.env.MLMVPN_GT_LOCAL_ENGINE_PORT = '0';

let failed = 0;
for (const suite of SUITES) {
    console.log(`\n${'─'.repeat(64)}\n${suite}\n${'─'.repeat(64)}`);
    const r = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
}

console.log(`\n${'═'.repeat(64)}`);
console.log(failed ? `${failed} suite(s) FAILED` : `all ${SUITES.length} suites passed`);
process.exit(failed ? 1 : 0);
