#!/usr/bin/env node
/*
 * NetDiag test suite.
 *
 *   node tests/netdiag/run.js
 *
 * Safe on a working machine by construction, and it stays that way as the feature grows:
 *   * no test starts PowerShell, opens a socket, or touches the network — the parsers are
 *     pure functions and the fixtures are captured text;
 *   * USERPROFILE is redirected to a sandbox before netdiag/session is required, so nothing
 *     can read or write the real ~/.mlmvpn;
 *   * nothing here changes machine state. Repairs arrive in phase 6 and will be driven by a
 *     PowerShell recorder, exactly as tests/aether drives the kill switch.
 *
 * The suites, and what each one guards:
 *
 *   facts.test.js    The Prime Directive: "could not observe" must never become `false`.
 *                    Every wrong-root-cause failure this engine was designed against starts
 *                    with that collapse, so the three-valued logic is pinned here rather
 *                    than trusted.
 *   session.test.js  Generations, and the single timing budget. A run lasts up to 35s while
 *                    the app itself can bring a tunnel up; without a generation boundary,
 *                    facts from before and after get correlated into a verdict about a
 *                    machine that never existed — and the repair lands on the live tunnel.
 *   parse.test.js    The parsers, against real captured output plus the two PS 5.1 traps this
 *                    machine actually produced (a UTF-8 BOM, and a single-row result that
 *                    serialises as an object rather than a one-element array), plus localised
 *                    output that must degrade to unknown instead of to "no routes".
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
    'facts.test.js',
    'session.test.js',
    'parse.test.js',
    'topology.test.js',
    'ownership.test.js',
    'diagnosis.test.js',
    'http.test.js',
    'replay.test.js',
    'verify.test.js',
    'security.test.js',
    'ui.test.js',
    'report.test.js',
    'journal.test.js',
    'repair.test.js',
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
