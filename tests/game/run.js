#!/usr/bin/env node
/*
 * Game path engine test suite.
 *
 *   node tests/game/run.js
 *
 * Safe on a working machine by construction:
 *   * no test touches the internet — the query-protocol fixtures are UDP servers this
 *     suite starts on 127.0.0.1 and closes in a finally block;
 *   * nothing starts PowerShell, so nothing reads the registry or the adapter list;
 *   * nothing writes to ~/.mlmvpn, so a run cannot disturb a real profile store or a
 *     tweak backup.
 *
 * The suites, and what each one guards:
 *
 *   probe.test.js    The numbers. Every verdict this feature reaches is built on
 *                    game/probe.js, and on the open internet there is no ground truth to
 *                    check it against — if it claimed 3% loss, nobody could say whether the
 *                    line dropped packets or the parser did. So the fixtures misbehave on
 *                    purpose (drop every fifth packet, add a 25ms floor, answer nothing at
 *                    all) and the reported statistics are compared against what was
 *                    deliberately injected. It also pins the ranking thesis — a steady
 *                    200ms path must beat a 90ms path that spikes — and the interleaving
 *                    methodology, because a regression to sequential passes would silently
 *                    turn every A-vs-B comparison into a comparison of two different
 *                    minutes on an Iranian international link.
 *
 *   catalog.test.js  The 196 hand-written rows. A typo there does not throw; it mislabels
 *                    a game or measures the wrong continent. Unique ids (they end up inside
 *                    stored profile keys), executables that no other row already claims,
 *                    regions that resolve to real anchors, and the kernel-anti-cheat flag —
 *                    which is a safety boundary, not a label.
 *
 *   evidence.test.js The claim that acceleration is actually happening. game/evidence.js
 *                    parses sing-box's own connection lines out of ~/.mlmvpn/tun.log, and
 *                    that parse is the only thing standing between "your game goes through
 *                    the engine" and a green switch that means nothing. The fixtures are
 *                    real captured log lines, including the coloured ones and the
 *                    "failed to search process" line that explains a silent fall-through to
 *                    direct — so a log-format change fails here instead of turning into a
 *                    confident lie in the panel.
 *
 *   engines.test.js  The catalogue and the lifecycle behind "you never switch an engine on
 *                    by hand". Ids have to round-trip, or a tournament winner cannot be
 *                    handed to the boost button; every Aether variant has to stay distinct,
 *                    or a run measures one protocol and labels it another; and `release`
 *                    must never stop an engine it did not start, which would tear down a
 *                    tunnel the user set up themselves. Fakes for the drivers and loopback
 *                    listeners for liveness — it cannot start a real engine.
 *
 *   shaper.test.js   The refusals. game/shaper.js is the only part of this feature that
 *                    makes MACHINE-WIDE changes — a firewall rule and a QoS policy — so what
 *                    is pinned is everything that must NOT happen: the tunnel's own engines
 *                    can never be throttled (a user who throttles aether.exe would blame the
 *                    accelerator for the result), a firewall block without an executable
 *                    path is refused rather than created as a rule that matches nothing, and
 *                    restore acts only on what this app wrote down. It also pins the
 *                    ORDERING — every guard runs before anything is written — which is what
 *                    keeps this suite's "nothing writes to ~/.mlmvpn" promise true.
 *
 *   uplinks.test.js  Which adapters count as a real internet connection (offering the user
 *                    "switch to the TAP adapter" would be offering a loop), and every fence
 *                    around the one thing in this feature that acts on its own. The failover
 *                    thresholds are not arbitrary constants — each one is a promise the card
 *                    makes in Persian, so a future edit that makes failover eager fails here
 *                    instead of swapping someone's connection mid-match. The watcher tests
 *                    run with the gate held shut, so no route is added and no metric moves.
 *
 *   accelerate.test.js
 *                    The one button's two chances to lie. `buildSummary` decides what the
 *                    user is told happened — its first version counted only successes, so a
 *                    run whose biggest step FAILED for want of admin rights announced
 *                    «هیچ کاری لازم نبود», which is the exact sentence that made the feature
 *                    look decorative. `pickBestDns` decides which resolver a sanctioned game
 *                    gets, where picking by latency is obviously right and obviously wrong.
 *                    Both are pure, so neither test starts an engine or touches DNS.
 *
 *   focus.test.js    The never-touch boundary. game/focus.js rewrites the scheduling priority
 *                    of every process on the machine, so what is pinned is the boundary, not
 *                    the mechanism: the compositor, the audio engine and the session services
 *                    are never lowered (each would surface as exactly the stutter the user
 *                    came to fix), the engines carrying the game are never starved, and THIS
 *                    APP is deliberately NOT protected — a booster that exempts itself while
 *                    burning 9.5% CPU is a joke, which is what the user caught it doing.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const SUITES = [
    'probe.test.js',
    'catalog.test.js',
    'customgames.test.js',
    'evidence.test.js',
    'shaper.test.js',
    'egress.test.js',
    'watch.test.js',
    'nic.test.js',
    'uplinks.test.js',
    'accelerate.test.js',
    'dnspick.test.js',
    'exitwatch.test.js',
    'focus.test.js',
    'engines.test.js',
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
