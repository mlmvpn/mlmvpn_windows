// What must come down when «وارپ» goes down — server.js.
//
// THE REPORT (2026-09-21): «وارپ رو قطع کردم، چراغش هم خاموش شده ولی حس میکنم کامل قطع نشده.
// حتی برنامه های بیرونی هم نمیتونن وصل بشن … برنامه mlmvpn رو کامل بستم بعد درست شد.»
//
// The engine really had stopped. What had not stopped was everything standing on it:
//
//   · sing-box still owned the machine's default route and was handing every packet to a SOCKS
//     port with nothing behind it — and `tun.checkLive()` calls that HEALTHY (the process is
//     alive, the adapter is up, the route is ours), so the watchdog never complained;
//   · the front-end Xray was still listening under the Windows system proxy;
//   · the resolvers still pointed at a bridge whose upstream was gone.
//
// Quitting the app cured it because main.js's `before-quit` tears all three down. The teardown
// existed — it was written for aether, and every guard in it asked whether AETHER was connected.
// With «وارپ» carrying the tunnel those guards read false while it was healthy and false again
// once it was dead, so none of them could tell «nothing to repair» from «nothing left to repair
// it for».
//
// These are source assertions, like relay.test.js's lifecycle block: the faults are all about
// WHICH CALLS EXIST AND IN WHAT ORDER on a route that cannot be exercised without taking over
// the machine's routing, DNS and firewall.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.resolve(__dirname, '../../server.js'), 'utf8');
const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

/** The body of `app.post('/api/<p>/stop', …)`, up to the closing `});` of the route. */
function route(method, url) {
    const head = `app.${method}('${url}',`;
    const i = src.indexOf(head);
    if (i < 0) return '';
    const j = src.indexOf('\n});', i);
    return j < 0 ? src.slice(i) : src.slice(i, j);
}
/** The body of a top-level function declaration. */
function fn(name) {
    const m = src.match(new RegExp('\\n(?:async )?function ' + name + '\\([^)]*\\) \\{'));
    if (!m) return '';
    const i = m.index;
    const j = src.indexOf('\n}\n', i);
    return j < 0 ? src.slice(i) : src.slice(i, j);
}

const warpStop = route('post', '/api/warp/stop');
const warpStart = route('post', '/api/warp/start');
const teardown = fn('aetherTearDownAfterDisconnect');
const rearm = fn('aetherRearmTunIfWanted');
const refresh = fn('aetherRefreshTunUplink');
const watchdog = fn('aetherStartWatchdog');
const lifecycle = fn('engineTunnelLifecycle');
const warpStatus = fn('warpStatus');

// ── the route the user pressed ───────────────────────────────────────────────────────────────
t('there is a /api/warp/stop route to judge', !!warpStop);
t('it takes the tunnel down', /aetherTearDownAfterDisconnect\(\{ userInitiated: true \}\)/.test(warpStop));
t('…and waits for it, so the reply means the machine is settled',
    /await aetherTearDownAfterDisconnect/.test(warpStop));
t('it releases the fail-closed firewall', /await aetherReleaseFailClosed\(/.test(warpStop));
t('it puts Windows\' resolvers back — AWAITED, not fire-and-forget',
    /await stopAetherDnsBridge\(\)/.test(warpStop));
t('it stops the tunnel watchdog, so nothing rebuilds what was just torn down',
    /aetherStopWatchdog\(\)/.test(warpStop));

// ORDER. `warp.stop()` pushes its own `connected:false`, which reaches engineTunnelLifecycle.
// Cancelling the grace FIRST is what stops a deliberate disconnect from arming a 150-second
// kill switch on its way out.
{
    const cancel = warpStop.indexOf('aetherCancelDisconnectGrace()');
    const stop = warpStop.indexOf('await warp.stop()');
    t('the disconnect grace is cancelled BEFORE the engine is stopped',
        cancel >= 0 && stop >= 0 && cancel < stop, `cancel@${cancel} stop@${stop}`);
    const tear = warpStop.indexOf('aetherTearDownAfterDisconnect');
    const release = warpStop.indexOf('aetherReleaseFailClosed');
    t('…and the guard is released after the tunnel is gone, never leaving a block with no tunnel',
        tear >= 0 && release > tear);
}
t('a fresh start begins from «never connected»',
    /aetherCancelDisconnectGrace\(\);/.test(warpStart) && /warpFrontendStarted = false;/.test(warpStart));

// ── the teardown itself ──────────────────────────────────────────────────────────────────────
t('the teardown stops the front-end Xray raised by EITHER engine',
    /if \(aetherFrontendStarted \|\| warpFrontendStarted\)/.test(teardown));
t('…and clears both flags, so a second stop is not fooled into skipping it',
    /aetherFrontendStarted = false;[\s\S]{0,40}warpFrontendStarted = false;/.test(teardown));
t('it never blocks the click: the async tunnel stop, not the execSync one',
    /await tun\.stopTunAsync\(/.test(teardown) && !/[^c]\btun\.stopTun\(/.test(teardown));
t('…and the async Xray stop, not the one with a 5-second execSync taskkill in it',
    /await xray\.stopXrayAsync\(\)/.test(teardown) && !/xray\.stopXray\(\)/.test(teardown));
t('it proves the adapter is really gone instead of assuming it',
    /await tun\.verifyTornDown\(/.test(teardown));

// ── everything under the tunnel must name the engine that is carrying it ─────────────────────
t('there is one place that answers «is any engine still under the tunnel?»',
    /function aetherLikeConnected\(\)/.test(src));
t('the re-arm asks which engine is carrying the tunnel, not aether by assumption',
    /const carrying = aetherLikeActive\(\);/.test(rearm) && !/aether\.getStatus\(\)\.connected/.test(rearm));
t('…and rebuilds on THAT engine\'s port', /tun\.startTun\(carrying\.port,/.test(rearm));
t('…with THAT engine\'s uplink exclusions', /carrying\.mgr\.getUplinkIps\(\)/.test(rearm));
t('the uplink refresh does the same — reading aether\'s stale endpoints rebuilt a live «وارپ» '
    + 'tunnel around a dead port',
    /const carrying = aetherLikeActive\(\);/.test(refresh)
    && /tun\.startTun\(carrying\.port,/.test(refresh)
    && !/aether\.getUplinkIps\(\)/.test(refresh));
t('the watchdog repairs for either engine', /if \(aetherLikeConnected\(\)\) \{/.test(watchdog));

// An unhealthy tunnel with NO engine under it is an outage, not a leak: arming the kill switch
// there closes a machine whose traffic has nowhere to go and then opens it 180 seconds later.
t('an orphaned tunnel is handed back instead of being held closed',
    /if \(!aetherLikeConnected\(\) && !aetherDisconnectTimer\) \{/.test(watchdog));
{
    const orphan = watchdog.indexOf('if (!aetherLikeConnected() && !aetherDisconnectTimer)');
    const engage = watchdog.indexOf('await aetherEngageFailClosed(');
    t('…and that check comes BEFORE the kill switch, so it is never armed just to be released',
        orphan >= 0 && engage >= 0 && orphan < engage, `orphan@${orphan} engage@${engage}`);
}

// ── one lifecycle, both engines ──────────────────────────────────────────────────────────────
t('the grace/kill-switch/re-arm lifecycle is a function, not aether\'s private tail',
    /function engineTunnelLifecycle\(connected\)/.test(lifecycle));
t('aether goes through it', /engineTunnelLifecycle\(state\.connected\);/.test(src));
t('«وارپ» goes through the same one', /engineTunnelLifecycle\(!!\(st && st\.connected\)\);/.test(warpStatus));
t('…and no longer drops the DNS bridge on every re-handshake blip',
    !/if \(st && !st\.connected && warpFrontendStarted\)/.test(warpStatus));
t('the grace timer re-checks the engine the tunnel is on, not aether',
    /if \(aetherLikeConnected\(\)\) return;/.test(lifecycle));

// ── the tunnel switch ────────────────────────────────────────────────────────────────────────
{
    const tunRoute = route('post', '/api/tun');
    t('the tunnel switch keeps DNS protected for whichever engine stays up',
        (tunRoute.match(/if \(aetherLikeConnected\(\)\) await startAetherDnsBridge\(\);/g) || []).length >= 2);
    t('«VPN همیشه روشن» records the tunnel against the engine that is carrying it',
        /updateConnection\(active\.kind, \{ tun: true \}\)/.test(tunRoute)
        && /updateConnection\(carried \? carried\.kind : 'aether', \{ tun: false \}\)/.test(tunRoute));
}

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
assert.ok(true);
process.exit(failed ? 1 : 0);
