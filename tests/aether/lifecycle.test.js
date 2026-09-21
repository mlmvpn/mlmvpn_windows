// Lifecycle invariants, asserted against the real server.js orchestration source.
//
// These are the behaviours behind every symptom in the audit, and each one is a property of
// how the pieces are wired rather than of any single function — so they are checked here,
// where a refactor that quietly undoes one will fail, rather than trusted to a comment.
//
// Nothing is executed: requiring server.js starts an HTTP server, spawns pollers and touches
// the user profile. The source is read and asserted on instead, which is a weaker check than
// running it and an honest one — it catches the reintroduction of a removed guard, which is
// what these regressions actually looked like.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const path = require('path');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const tunMgr = fs.readFileSync(path.join(ROOT, 'tun-manager.js'), 'utf8');
const mainJs = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const sidebar = fs.readFileSync(path.join(ROOT, 'public', 'components', 'scanner-sidebar.js'), 'utf8');
const panel = fs.readFileSync(path.join(ROOT, 'public', 'components', 'aether.js'), 'utf8');

// ── the grace period vs the engine's own reconnect budget ────────────────────────
// lib.rs:723-776 — a normal MASQUE recovery is: 2s delay, quick-verify, and on failure a
// full rescan ('balanced' runs up to 120s) plus up to 10s of data-plane validation. A grace
// shorter than that fires DURING almost every recovery, tears the stack down, and the engine
// then reconnects into a machine that is no longer tunnelled: green badge, real IP.
const graceMatch = server.match(/AETHER_DISCONNECT_GRACE_MS\s*=\s*(\d+)/);
const grace = graceMatch ? Number(graceMatch[1]) : 0;
t('the disconnect grace covers a real rescan, not just a re-handshake',
    grace >= 130000, `${grace}ms`);
t('there is an upper bound on how long traffic may be held closed',
    /AETHER_FAILCLOSED_MAX_MS\s*=\s*\d+/.test(server));

// ── fail-closed ordering ─────────────────────────────────────────────────────────
// Waiting through a long grace is only defensible because nothing can escape during it.
t('a disconnect engages the kill switch before starting the grace timer',
    server.indexOf('aetherEngageFailClosed(\'تونل قطع شد\')') > 0 &&
    server.indexOf('aetherEngageFailClosed(\'تونل قطع شد\')') <
        server.indexOf('aetherDisconnectTimer = setTimeout'));
// Order inside the give-up path, checked by position rather than by a proximity regex — the
// two calls are separated by a log line whose length is nobody's business but its own.
const giveUp = server.slice(server.indexOf('aetherDisconnectTimer = setTimeout'));
const relAt = giveUp.indexOf('aetherReleaseFailClosed');
const tearAt = giveUp.indexOf('aetherTearDownAfterDisconnect()');
t('the guard is RELEASED before the tunnel is torn down, so there is never a moment with neither',
    relAt > 0 && tearAt > 0 && relAt < tearAt, `release@${relAt} teardown@${tearAt}`);
// The whole connect/disconnect lifecycle became `engineTunnelLifecycle(connected)` on
// 2026-09-21, so that «وارپ» — which is its own engine — gets the same grace period, kill
// switch, re-arm and teardown instead of none of them.
t('recovery is automatic: the guard is released when the tunnel returns',
    /function engineTunnelLifecycle\(connected\) \{\s*\n\s*if \(connected\) \{[\s\S]{0,600}?aetherReleaseFailClosed/.test(server));

// ── the re-arm asymmetry ─────────────────────────────────────────────────────────
// The DNS bridge and the front-end proxy came back on reconnect; the whole-system tunnel did
// not. That is the mechanism behind "it says Connected but my traffic is not protected".
t('the user intent to tunnel is tracked separately from whether it is currently running',
    /let aetherTunWanted/.test(server));
t('a reconnect re-arms the whole-system tunnel', /aetherRearmTunIfWanted\(\)/.test(server));
t('re-arming is serialised, or two starts fight over the same adapter',
    /aetherRearmInFlight/.test(server));
t('switching TUN off by hand clears the intent, so nothing helpfully brings it back',
    /aetherTunWanted = false;[\s\S]{0,200}aetherStopWatchdog\(\)/.test(server));

// ── the watchdog ─────────────────────────────────────────────────────────────────
// The old code verified the tunnel exactly once, 1500ms after starting it, and never again.
t('a watchdog exists', /aetherStartWatchdog/.test(server) && /setInterval/.test(server));
t('it distinguishes process death, adapter loss and a stolen route',
    ['process-dead', 'adapter-gone', 'adapter-down', 'route-stolen'].every(k => server.includes(k)));
t('the watchdog closes traffic BEFORE trying to repair',
    server.indexOf('await aetherEngageFailClosed(FA[live.verdict]') <
        server.indexOf('await aetherRearmTunIfWanted();'));

// ── readiness is a fact, not a stopwatch ─────────────────────────────────────────
// Measured: warm, sing-box died at 1.29s and was caught; cold, it had not finished dying at
// 1.5s and the app reported success for a tunnel that never existed.
t('startTun no longer decides success on a fixed sleep', !/setTimeout\(r, 1500\)/.test(tunMgr));
t('it waits for the adapter to exist and own the default route',
    /waitForReady/.test(tunMgr) && /defaultViaTun/.test(tunMgr));
t('the liveness check asks Windows, not our own bookkeeping',
    /Get-NetAdapter -Name/.test(tunMgr) && /Get-NetRoute -DestinationPrefix/.test(tunMgr));
t('a failed start does not leave a half-started engine holding the route',
    /if \(!ready\.ok\) \{[\s\S]{0,900}?stopTun\(null\)/.test(tunMgr));

// ── teardown must leave the machine routable ─────────────────────────────────────
t('stopTun asks politely before forcing, so sing-box can unwind its own changes',
    /taskkill \/pid \$\{proc\.pid\} \/T`/.test(tunMgr) && /\/T \/F`/.test(tunMgr));
t('teardown is VERIFIED rather than assumed', /verifyTornDown/.test(tunMgr) && /verifyTornDown/.test(server));

// ── the DNS restore ──────────────────────────────────────────────────────────────
// Measured: stop returned {"ok":true}, the process was killed 3s later, and Windows was left
// on 127.0.0.1 / ::1 with nothing listening. Every lookup failed, and it survived the app.
t('the stop handler AWAITS the DNS restore before replying',
    /await stopAetherDnsBridge\(\)/.test(server));
t('a second teardown caller awaits the first instead of returning on a cleared flag',
    /aetherDnsBridgeStopping/.test(server));
t('ownership of the resolvers is recorded BEFORE Windows is changed',
    server.indexOf('aetherGuard.armDns(') < server.indexOf("dnsManager.applyServers(targets"));
t('a failed apply gives ownership back rather than leaving a false claim',
    /aetherGuard\.disarmDns\(\);/.test(server));

// ── the DNS bridge and TUN are mutually exclusive ────────────────────────────────
// Running both is not redundancy, it is a dead tunnel. Measured twice: traffic flowed
// through TUN until the exact second the bridge repointed Windows at 127.0.0.1, then
// stopped completely and the Wi-Fi indicator dropped to "no internet". Loopback never
// enters the TUN, so sing-box's hijack-dns never sees those queries, and they go through a
// per-query Node relay over a 1.76s-RTT gateway instead of sing-box's cached resolver.
t('the bridge refuses to start while the whole-system tunnel is up',
    /async function doStartAetherDnsBridge\(\)[\s\S]{0,200}?if \(tunTookOverDns\(\)\)[\s\S]{0,200}?return;/.test(server));
// The door check alone is not enough, and this is the 2026-08-17 outage: the start then spends
// 5-15s in awaits (listener, test lookup, adapter snapshot, elevated DNS apply), and a tunnel
// that comes up inside that window gets loopback resolvers planted on top of it — measured at
// 13:52:20 adapter up, 13:52:28 "DNS سیستم به تونل متصل شد". Every await needs the re-check.
const startBody = server.slice(
    server.indexOf('async function doStartAetherDnsBridge'),
    server.indexOf('let aetherDnsBridgeStopping'));
t('...and re-checks after EVERY await, not only at the door',
    (startBody.match(/tunTookOverDns\(\)/g) || []).length >= 4,
    `checkpoints=${(startBody.match(/tunTookOverDns\(\)/g) || []).length}`);
t('...including one immediately before the DNS change is applied to Windows',
    startBody.lastIndexOf('tunTookOverDns()', startBody.indexOf('dnsManager.applyServers')) >
    startBody.indexOf('snapshotCurrent'));
t('...and if the tunnel wins the race after the change lands, the change is undone',
    /tunTookOverDns\(\)\) \{[\s\S]{0,300}?await doStopAetherDnsBridge\(\);/.test(startBody));
// The other half of the same race: a start in flight holds no flag, so a stop that tests only
// `aetherDnsBridgeStarted` returns "nothing to do" and lets the start finish behind the
// tunnel's back. That is why the tunnel's own teardown could not prevent the outage.
t('a stop AWAITS a start that is still in flight instead of skipping it',
    /if \(aetherDnsBridgeStarting\) \{[\s\S]{0,400}?aetherDnsBridgeStarting[\s\S]{0,200}?doStopAetherDnsBridge\(\)/.test(server));
t('a second start is joined to the one in flight rather than run twice',
    /function startAetherDnsBridge\(\)[\s\S]{0,300}?if \(aetherDnsBridgeStarting\) return aetherDnsBridgeStarting;/.test(server));
// ORDER, not just presence. startTun begins by probing the SOCKS port, and the bridge opens
// a fresh control connection plus a UDP socket per DNS query. Tearing the bridge down AFTER
// startTun means the probe is starved by the very thing we are about to switch off — which
// is precisely what stopped the tunnel from ever starting ("io: early eof" on the probe,
// "dns timeout from 1.0.0.1:53" moments later, while the same probe passes in 247ms on a
// quiet port).
const enableTun = server.slice(server.indexOf("app.post('/api/tun'"));
const stopBridgeAt = enableTun.indexOf('await stopAetherDnsBridge()');
const startTunAt = enableTun.indexOf('await tun.startTun(');
t('the bridge is shut down BEFORE startTun probes the SOCKS port, not after',
    stopBridgeAt > 0 && startTunAt > 0 && stopBridgeAt < startTunAt,
    `stopBridge@${stopBridgeAt} startTun@${startTunAt}`);
// Checked by POSITION inside the re-arm function, not by a proximity window. A char-budget
// regex silently turns into a false failure the moment a comment is added between the two
// calls, which teaches the reader to loosen the budget rather than to look at the behaviour.
const rearmBody = server.slice(server.indexOf('async function aetherRearmTunIfWanted'));
const rearmStopBridge = rearmBody.indexOf('await stopAetherDnsBridge()');
const rearmStartTun = rearmBody.indexOf('await tun.startTun(');
t('the same ordering is used by the watchdog re-arm path',
    rearmStopBridge > 0 && rearmStartTun > 0 && rearmStopBridge < rearmStartTun,
    `stopBridge@${rearmStopBridge} startTun@${rearmStartTun}`);
t('a failed TUN start puts the bridge back, so proxy-only mode keeps its DNS protection',
    /catch \(e\) \{[\s\S]*?await startAetherDnsBridge\(\);\s*\n\s*throw e;/.test(server));
t('the data-plane check retries instead of refusing on a single dropped connection',
    /for \(let attempt = 1; attempt <= 3 && !\(carries && carries\.ok\); attempt\+\+\)/.test(tunMgr));
// ...AND NOT AT THE SAME ADDRESS EVERY TIME.
//
// A node can be healthy and still refuse one destination. Measured 2026-09-12 against the
// user's own configs: a Zeus worker node closed 1.1.1.1:80 at the HTTP stage after 11.8 s and
// then answered 1.0.0.1:80 in 2.6 s. Knocking three times on one address cannot tell "this
// tunnel is dead" from "this node will not talk to that address", and the user is told the
// first while the truth is the second — a tunnel switch that will not turn on, for no reason.
t('…at a different address each attempt, so one refused destination is not a dead tunnel',
    /PROBE_TARGETS\[\(attempt - 1\) % PROBE_TARGETS\.length\]/.test(tunMgr));
t('…and there are at least three of them to rotate through',
    require(ROOT + '/tun-manager').PROBE_TARGETS.length >= 3);
// The probe's verdict must carry a reason: this is the check that refuses to hand the machine's
// default route to the engine, and "it failed" is not something a user can act on.
t('…and the probe says WHY it failed, not just that it did',
    /resolve\(\{ ok, why/.test(tunMgr));
// Recorded from the first line: this failure used to leave no tun.log, no tun-config and no
// sing-box at all, so the only way to investigate it was to reproduce it while watching.
// A tunnel that is "up" while the exit address is the user's own line is the one failure this
// app must never report as success — and until 2026-09-12 nothing asked. The verdict runs
// AFTER the payload check (the tunnel is already committed) and must never be able to fail it.
const tunOnBody = server.slice(server.indexOf("app.post('/api/v2ray/tun'"));
const verifyAt = tunOnBody.indexOf('verifyTunCarriesTraffic');
const verdictAt = tunOnBody.indexOf('tun.tunVerdict(');
t('a started tunnel reports what it is really doing (route, uplink DNS, exit address)',
    verdictAt > 0, 'tunVerdict is never called');
t('…after the payload check, not before it',
    verifyAt > 0 && verdictAt > verifyAt, `verify@${verifyAt} verdict@${verdictAt}`);
t('…and it can never fail a tunnel that already passed',
    /try \{ await tun\.tunVerdict\([\s\S]{0,200}?\}\s*\n\s*catch \(e\)/.test(tunOnBody));
// `info` names every connection and the outbound it took, which is the only thing that tells a
// tunnel carrying nothing from a healthy one. It is also thousands of lines a minute through a
// pipe into the main thread, where sing-box's own log write then waits — the diagnosis taking
// throughput from the thing it is diagnosing. So it became a lever: the default is quiet, and
// what must not regress is that the lever exists and can still reach `info`.
t('the tunnel log level is a lever, not a constant',
    /logLevel: tunLogLevel\(\)/.test(server.slice(server.indexOf('function v2rayTunOptions'), server.indexOf('function v2rayTunOptions') + 1800)));
t('…the same lever for the front engines, so asking for detail does not get half of it',
    /logLevel: tunLogLevel\(\)/.test(server.slice(server.indexOf('function frontTunOptions'), server.indexOf('function frontTunOptions') + 6000)));
t('…and it still reaches `info`, which is what names every connection',
    /tunLogVerbose \? 'info' : 'warn'/.test(fs.readFileSync(path.join(ROOT, 'network-settings.js'), 'utf8')));

t('a failed pre-flight is written to the tunnel log',
    tunMgr.indexOf('openTunLog(`preflight') > 0
    && tunMgr.indexOf('openTunLog(`preflight') < tunMgr.indexOf('carries = await tunnelCarriesData'),
    'the log must open BEFORE the probe runs');
// …for WHICHEVER engine is still up. Spelled `aether.getStatus().connected`, this did nothing
// when «وارپ» held the tunnel, and stepping down to proxy-only silently lost its DNS.
t('taking TUN down puts the bridge back, so proxy-only mode is not left resolving in cleartext',
    /if \(aetherLikeConnected\(\)\) await startAetherDnsBridge\(\);/.test(server));
// Unconditional on purpose. Gating this on `aetherDnsBridgeStarted` skipped the teardown for
// a bridge that was still starting — and the re-arm path runs right after a disconnect, which
// is exactly when one is in flight, because the disconnect handler asked for the bridge back.
t('re-arming TUN after a drop performs the same handover, even mid-start',
    rearmStopBridge > 0 && !rearmBody.slice(0, rearmStopBridge).includes('if (aetherDnsBridgeStarted)'));

// ── every tunnel transition is serialised ────────────────────────────────────────
// startTun DELETES any adapter named MLMVPN before creating its own (removeStaleAdapter), so
// two overlapping starts are not slow — they are permanently broken. Measured 2026-08-17:
//   14:05:12 ✅ آداپتور ساخته شد / 14:05:12 آداپتور از اجرای قبلی باقی مانده بود — حذف می‌شود
//   14:05:15 FATAL configure tun interface: Cannot create a file when that file already exists
//   14:05:18 ❌ تلاش 0 ناموفق بود        <- "attempt 0": two paths sharing one counter
// It repeated every ~15s until the app was closed.
t('a lock exists and it releases even when the holder throws',
    /function withTunLock\([\s\S]{0,400}?tunLock = run\.catch\(\(\) => \{\}\)/.test(server));
const TRANSITIONS = [
    ["the user's switch (on)", 'tun-on'],
    ["the user's switch (off)", 'tun-off'],
    ['the watchdog re-arm', 'tun-rearm'],
    ['the uplink refresh', 'tun-uplink-refresh'],
    ['the system-proxy handover', 'system-proxy'],
];
TRANSITIONS.forEach(([label, tag]) => {
    t(`${label} takes the lock`, server.includes(`withTunLock('${tag}'`));
});
// A queued transition can be stale by the time it runs: the user may have switched the
// tunnel off, or another path may have already rebuilt it. Acting on the intent captured
// before the wait is how a switch turns itself back on after the user turned it off.
const rearmLockBody = rearmBody.slice(rearmBody.indexOf("withTunLock('tun-rearm'"));
t('the re-arm re-reads the intent under the lock instead of trusting a stale check',
    /if \(!aetherTunWanted \|\| tun\.isRunning\(\)\) return;/.test(rearmLockBody.slice(0, 600)));

// ── the tunnel and the system proxy must not take turns ──────────────────────────
// Same log: proxy-on stopped the tunnel but left `aetherTunWanted` set, so the watchdog put
// the tunnel back five seconds later, which switched the proxy off again — 14:04:53,
// 14:05:06, 14:05:26, 14:05:41. Choosing the proxy has to CLEAR the tunnel's intent.
const proxyHandler = server.slice(
    server.indexOf("app.post('/api/proxy/system'"),
    server.indexOf("app.post('/api/tun'"));
t('choosing the system proxy clears the tunnel intent, not just the tunnel',
    /aetherTunWanted = false;[\s\S]{0,200}?aetherStopWatchdog\(\);/.test(proxyHandler));
t('...and it releases the kill switch, so the machine is not left held closed',
    proxyHandler.includes('aetherReleaseFailClosed'));
t('...and it reports the new intent to the UI, so the switch does not stay lit',
    /broadcast\('tun', \{ running: false, wanted: false \}\)/.test(proxyHandler));

// ── the watchdog must not fight the thing it is watching ─────────────────────────
// Field log, repeating for as long as the tunnel was left on:
//   sing-box started (0.63s) / ✅ آداپتور ساخته شد / تونل متوقف شد (خاتمه‌ی اجباری)
// The watchdog fired while startTun was still in waitForReady, saw an adapter that did not
// yet own the default route, and killed the process the start was waiting on.
// Widened after 2026-08-17: `aetherRearmInFlight` guards only the re-arm, and the user's
// switch, the system-proxy handover and the uplink refresh build tunnels too. The watchdog
// has to stand down for ANY transition, which is what the lock depth reports.
t('the watchdog stands down while a start or re-arm is in flight',
    /if \(aetherRearmInFlight \|\| tunTransitionInProgress\(\)\) return;/.test(server));
t('and it gives a freshly built tunnel time to settle before judging it',
    /AETHER_SETTLE_MS/.test(server)
    && /Date\.now\(\) - aetherTunSettledAt < AETHER_SETTLE_MS/.test(server));
t('the retry budget only clears once a tunnel has actually held, or it never accumulates',
    /Date\.now\(\) - aetherTunSettledAt > AETHER_SETTLE_MS\) aetherRearmAttempts = 0/.test(server));

// ── DNS through the tunnel must be cached ────────────────────────────────────────
// The only reachable Cloudflare edge on the target line answers at rtt=1.76s. Uncached,
// measured lookups took 2.80s (www.google.com) and 4.70s (play.google.com) — a browser that
// looks frozen while traffic is in fact flowing.
const full = require(ROOT + '/tun-manager').buildTunConfig(20810, {});
t('the full-tunnel DNS has a cache', (full.dns.cache_capacity || 0) >= 1024,
    String(full.dns.cache_capacity));
t('and it does not use the option sing-box 1.14 deprecates',
    !('independent_cache' in full.dns));

// ── crash recovery ───────────────────────────────────────────────────────────────
t('startup undoes anything a dead run left on the machine',
    /require\('\.\/aether-guard'\)\.restoreIfStale/.test(server));
t('quitting synchronously undoes both the firewall and the DNS',
    /require\('\.\/aether-guard'\)\.bailSync\(\)/.test(mainJs));

// ── the UI must not lie ──────────────────────────────────────────────────────────
// The server always broadcast these; nothing listened, so the toggle stayed green over a
// tunnel the server had already torn down.
t("the websocket dispatcher handles the 'tun' event", /msg\.type === 'tun'/.test(sidebar));
t("it handles the kill-switch event", /msg\.type === 'aether_guard'/.test(sidebar));
t("it handles the system-proxy event", /msg\.type === 'system_proxy'/.test(sidebar));
t('the panel can render a server-reported tunnel state', /function applyTunState/.test(panel));
t('the panel distinguishes "off" from "down and recovering"',
    /wanted/.test(panel) && /در حال بازیابی/.test(panel));
t('the panel surfaces the kill switch, so a closed machine is never a mystery',
    /function applyGuardState/.test(panel));

// ── startServer must be able to report its own failure ───────────────────────────
// `fail()` called an undefined `reject`, so a port-bind failure threw a ReferenceError out
// of an async callback and took the process down instead of showing the startup dialog.
t('the startServer promise exposes reject, so a bind failure is reportable',
    /return new Promise\(\(resolve, reject\) =>/.test(server));

// ── a measurement must not ask the user to choose a route ────────────────────────
// The game booster's race brings each of the six Aether variants up and down in turn, and the
// panel asks «تونل کامل یا پراکسی سیستم؟» the moment it sees `connected` go true. The
// measurement status used to be byte-identical to a real connect, so the user got that dialog
// six times during one race — for a decision they were not making, since the race measures
// through SOCKS and touches neither the route nor the proxy.
//
// Both halves are pinned: the server has to tag it, and the panel has to honour the tag. Either
// one alone silently restores the interruption.
t('measurement statuses are tagged, so the panel can tell them from a real connect',
    /function aetherMeasurementStatus[\s\S]{0,900}?measuring:\s*true/.test(server));
t('…and the routing question is skipped for them',
    /state\.connected\s*&&\s*!wasConnected\s*&&\s*!state\.measuring/.test(panel));
// The other direction: a connect the user asked for must clear the flag, or a race that ended
// badly would leave every later connect silently treated as a measurement.
t('a user-initiated start always clears measurement mode first',
    /app\.post\('\/api\/aether\/start'[\s\S]{0,1400}?aetherMeasurementMode\s*=\s*false/.test(server));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
