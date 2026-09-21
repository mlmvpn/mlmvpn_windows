// Live speed and daily usage: traffic-feed.js, and the byte counts the engines hand it.
//
// Until 1.2.2 only Xray and the SNI engine ever reported bytes, so the GitHub tunnel, the
// full-system tunnel to a WARP engine and the Google Script tunnel moved real traffic while
// every figure sat at zero. The fix reads each engine's own counters — and the risk that
// comes with that is counting the same byte twice, because engines nest. These tests pin
// both halves: every engine is counted, and no byte is counted by two of them.
//
// Nothing here touches the network or the real ~/.mlmvpn: traffic-manager is replaced by a
// recorder before anything requires it, and USERPROFILE points at a throwaway directory.
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-traffic-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;

// ── traffic-manager, recorded ────────────────────────────────────────────────────
const tm = {
    enabled: true,
    up: 0, down: 0, calls: 0,
    setEnabled(v) { this.enabled = !!v; },
    isEnabled() { return this.enabled; },
    addTraffic(u, d) { this.up += u; this.down += d; this.calls++; },
    getTrafficStats() { return { today: { up: this.up, down: this.down }, sessionUp: 0, sessionDown: 0, totalUp: this.up, totalDown: this.down, daily: {} }; },
    startSession() {}, resetSession() {}, reset() { this.up = 0; this.down = 0; this.calls = 0; },
};
const tmPath = require.resolve(ROOT + '/traffic-manager');
require.cache[tmPath] = { id: tmPath, filename: tmPath, loaded: true, exports: tm };

const feed = require(ROOT + '/traffic-feed');
const tun = require(ROOT + '/tun-manager');
const { sumTrafficStats } = require(ROOT + '/xray-manager');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── fake engines ─────────────────────────────────────────────────────────────────
const on = { 'github-tunnel': false, tun: false, xray: false, gst: false, sni: false };
const counters = { 'github-tunnel': { up: 0, down: 0 }, tun: { up: 0, down: 0 }, gst: { up: 0, down: 0 } };
const emitted = [];
feed.setEmitter((p) => emitted.push(p));
for (const name of ['github-tunnel', 'tun', 'gst']) {
    feed.registerCounter(name, { active: () => on[name], read: async () => ({ ...counters[name] }) });
}
feed.registerPush('xray', { active: () => on.xray, immediate: true });
feed.registerPush('sni', { active: () => on.sni });

const move = (name, up, down) => { counters[name].up += up; counters[name].down += down; };

(async () => {
    // ── one engine: the first reading is a baseline, never traffic ──
    on['github-tunnel'] = true;
    counters['github-tunnel'] = { up: 5e9, down: 9e9 };      // what tailscaled carried before we looked
    await feed.tick();
    t('the first reading of a counter is a baseline, not traffic', tm.up === 0 && tm.down === 0, `${tm.up}/${tm.down}`);
    move('github-tunnel', 1000, 20000);
    await feed.tick();
    t('the GitHub tunnel is counted (it used to read zero for its whole life)', tm.up === 1000 && tm.down === 20000, `${tm.up}/${tm.down}`);
    t('…and live speed goes out as the traffic_update the UI listens for',
        emitted.length > 0 && emitted[emitted.length - 1].__traffic_update__ === true
        && emitted[emitted.length - 1].speed.down > 0);

    // ── a counter that goes backwards is a restart, not negative traffic ──
    counters['github-tunnel'] = { up: 10, down: 10 };
    tm.reset();
    await feed.tick();
    t('a counter that went backwards (engine restarted) becomes the new baseline', tm.up === 0 && tm.down === 0 && tm.calls === 0, `${tm.up}/${tm.down}`);
    move('github-tunnel', 7, 70);
    await feed.tick();
    t('…and counting resumes from it', tm.up === 7 && tm.down === 70, `${tm.up}/${tm.down}`);

    // ── nesting: the outermost engine counts, the inner one only keeps its baseline ──
    tm.reset();
    on.tun = true;
    counters.tun = { up: 100, down: 100 };
    await feed.tick();                                          // tun's baseline
    move('github-tunnel', 500, 500);
    move('tun', 400, 400);                                      // the same bytes, one layer in
    await feed.tick();
    t('two engines carrying the same bytes: only the outer one is counted', tm.up === 500 && tm.down === 500, `${tm.up}/${tm.down}`);
    on['github-tunnel'] = false;
    tm.reset();
    move('tun', 300, 3000);
    await feed.tick();
    t('when the outer one stops, the inner one takes over from a fresh baseline — none of its past is counted',
        tm.up === 300 && tm.down === 3000, `${tm.up}/${tm.down}`);

    // ── an engine that counts itself beats the tunnel that only fronts it ──
    tm.reset();
    on.xray = true;
    move('tun', 999, 999);
    await feed.tick();
    t('V2Ray behind the full-system tunnel: the tunnel stops counting once Xray is on', tm.up === 0 && tm.down === 0, `${tm.up}/${tm.down}`);
    feed.push('xray', 1200, 34000);
    t('…and Xray is counted, the moment it reports', tm.up === 1200 && tm.down === 34000, `${tm.up}/${tm.down}`);
    on.xray = false;
    on.tun = false;

    // ── a push source that is not the winner is not counted ──
    tm.reset();
    on.gst = true;
    counters.gst = { up: 0, down: 0 };
    await feed.tick();
    feed.push('xray', 5000, 5000);                              // xray is off: nothing should land
    t('a report from an engine that is off is ignored', tm.up === 0 && tm.down === 0, `${tm.up}/${tm.down}`);
    move('gst', 64, 4096);
    await feed.tick();
    t('the Google Script tunnel is counted', tm.up === 64 && tm.down === 4096, `${tm.up}/${tm.down}`);

    // ── buffered push (SNI): summed into the next tick ──
    on.gst = false;
    on.sni = true;
    tm.reset();
    await feed.tick();                                          // sni becomes the winner
    feed.push('sni', 10, 0);
    feed.push('sni', 0, 20);
    feed.push('sni', 5, 5);
    await feed.tick();
    t('SNI markers between two ticks are counted once, together', tm.up === 15 && tm.down === 25, `${tm.up}/${tm.down}`);

    // ── everything stops: live speed says zero once, instead of freezing ──
    on.sni = false;
    emitted.length = 0;
    await feed.tick();
    await feed.tick();
    t('when every engine stops, one zero-speed update goes out (not one a second)',
        emitted.length === 1 && emitted[0].speed.up === 0 && emitted[0].speed.down === 0, `${emitted.length} updates`);

    // ── monitoring switched off ──
    tm.setEnabled(false);
    tm.reset();
    on['github-tunnel'] = true;
    await feed.tick();
    move('github-tunnel', 1e6, 1e6);
    await feed.tick();
    feed.push('xray', 1, 1);
    t('«غیرفعال شدن مانیتورینگ مصرف»: nothing is read or counted', tm.calls === 0, `${tm.calls} calls`);
    tm.setEnabled(true);
    on['github-tunnel'] = false;

    // ── who covers whom, as server.js registers it ──
    // ماسک / وایرگارد / وارپ در وارپ read zero speed and usage: their tunnel was outranked by
    // the Xray that stands idle for the system proxy, and a GitHub tunnel in PROXY mode
    // outranked everything although it carries none of their bytes.
    let tunEngine = 'aether.exe';
    let gtMode = 'proxy';
    feed.registerCounter('github-tunnel', { active: () => on['github-tunnel'], read: async () => ({ ...counters['github-tunnel'] }), covers: () => gtMode === 'tun' });
    feed.registerCounter('tun', { active: () => on.tun, read: async () => ({ ...counters.tun }), covers: () => false });
    feed.registerPush('xray', { active: () => on.xray, immediate: true, covers: (o) => (o === 'tun' ? tunEngine === 'xray.exe' : o === 'gst' || o === 'sni') });
    for (const k of Object.keys(on)) on[k] = false;

    // a WARP engine's full tunnel, the Xray front idle beside it
    tm.reset();
    on.tun = true; on.xray = true; tunEngine = 'aether.exe';
    await feed.tick();                                          // baselines
    move('tun', 2000, 50000);
    await feed.tick();
    t('WARP full tunnel: counted although the idle Xray front is on (it read zero before)',
        tm.up === 2000 && tm.down === 50000, `${tm.up}/${tm.down}`);
    t('…both are counted sources, the idle one simply adds nothing', JSON.stringify(feed.countedNames()) === '["xray","tun"]', JSON.stringify(feed.countedNames()));

    // V2Ray's full tunnel: the same bytes pass Xray, so the tunnel stays covered
    tm.reset();
    tunEngine = 'xray.exe';
    move('tun', 700, 700);
    await feed.tick();
    feed.push('xray', 700, 700);
    t('V2Ray full tunnel: Xray counts, the tunnel in front of it does not (no double count)',
        tm.up === 700 && tm.down === 700, `${tm.up}/${tm.down}`);
    on.tun = false;

    // GitHub tunnel as a PROXY beside a WARP engine behind Xray: two independent paths
    tm.reset();
    on['github-tunnel'] = true; gtMode = 'proxy';
    await feed.tick();                                          // GitHub baseline
    emitted.length = 0;
    move('github-tunnel', 100, 1000);
    feed.push('xray', 30, 300);                                 // counted beside another: buffered
    await feed.tick();
    t('GitHub tunnel in proxy mode + a WARP engine: both are counted, in ONE update',
        tm.up === 130 && tm.down === 1300 && emitted.length === 1, `${tm.up}/${tm.down}, ${emitted.length} updates`);

    // …and in TUNNEL mode its exit carries everything else
    tm.reset();
    gtMode = 'tun';
    move('github-tunnel', 500, 5000);
    feed.push('xray', 500, 5000);                               // the same bytes, one layer in
    await feed.tick();
    t('GitHub tunnel in tunnel mode carries the rest: counted once, by it',
        tm.up === 500 && tm.down === 5000, `${tm.up}/${tm.down}`);
    for (const k of Object.keys(on)) on[k] = false;

    const srv = fs.readFileSync(ROOT + '/server.js', 'utf8');
    t('server.js registers those rules (GitHub covers all only in tun mode; Xray covers the tunnel only as its engine)',
        /covers: \(\) => gtCarriesAll\(\)/.test(srv) && /s\.mode === 'tun'/.test(srv)
        && /other === 'tun' \? tun\.currentEngine\(\) === 'xray\.exe'/.test(srv));

    // ── the full-system tunnel: the engine's uplink, not the grand totals ──
    // sing-box sees every byte twice: the app's connection into the engine (outbound
    // 'aether'), then the engine's own encrypted uplink leaving on 'direct'.
    const api = () => ({ isUplink: tun.uplinkMatcher('aether.exe', {}), seen: new Map(), up: 0, down: 0, sawUplink: false });
    const conn = (id, chains, processPath, destinationIP, upload, download) =>
        ({ id, chains, upload, download, metadata: { processPath, destinationIP } });

    const a = api();
    let r = tun.tallyCounters(a, {
        uploadTotal: 2200, downloadTotal: 44000,
        connections: [
            conn('app1', ['aether'], 'C:\\Program Files\\Browser\\browser.exe', '142.250.1.1', 1000, 20000),
            conn('up1', ['direct'], 'G:\\ip scanner\\core\\aether.exe', '162.159.198.2', 1100, 22000),
            conn('dns', ['direct'], 'C:\\Windows\\System32\\svchost.exe', '192.168.1.1', 100, 2000),
        ],
    });
    t('tunnel: only the engine\'s uplink is counted, not the grand total that holds it twice', r.up === 1100 && r.down === 22000, JSON.stringify(r));
    r = tun.tallyCounters(a, {
        connections: [conn('up1', ['direct'], 'G:\\ip scanner\\core\\aether.exe', '162.159.198.2', 1600, 30000)],
    });
    t('tunnel: the same uplink connection is followed by its growth', r.up === 1600 && r.down === 30000, JSON.stringify(r));
    r = tun.tallyCounters(a, {
        connections: [conn('up2', ['direct'], '', '162.159.198.9', 50, 500)],
    });
    t('tunnel: a reconnect (new connection id) adds on — the total never goes backwards', r.up === 1650 && r.down === 30500, JSON.stringify(r));
    t('tunnel: a Windows-refused process lookup still finds the uplink by its address', r.up === 1650);
    t('tunnel: the process path may carry a " (user)" suffix',
        tun.uplinkMatcher('aether.exe', {})(conn('x', ['direct'], 'C:\\core\\aether.exe (DESKTOP\\me)', '8.8.8.8', 0, 0)) === true);
    t('tunnel: the app\'s own connection into the engine is never the uplink',
        tun.uplinkMatcher('aether.exe', {})(conn('x', ['aether'], 'C:\\core\\aether.exe', '162.159.198.2', 0, 0)) === false);
    t('tunnel: another engine\'s tunnel follows ITS uplink (gst.exe), not aether.exe',
        tun.uplinkMatcher('gst.exe', { uplinkCidrs: ['203.0.113.0/24'] })(conn('x', ['direct'], '', '203.0.113.7', 0, 0)) === true
        && tun.uplinkMatcher('gst.exe', { uplinkCidrs: ['203.0.113.0/24'] })(conn('x', ['direct'], '', '162.159.198.2', 0, 0)) === false);
    t('tunnel: a live uplink address passed as an exact IP is matched too',
        tun.uplinkMatcher('x.exe', { uplinkCidrs: [], uplinkIps: ['198.51.100.4'] })(conn('x', ['direct'], '', '198.51.100.4', 0, 0)) === true);

    const b = api();
    r = tun.tallyCounters(b, {
        uploadTotal: 900, downloadTotal: 9000,
        connections: [conn('app1', ['aether'], 'C:\\b.exe', '1.1.1.1', 900, 9000)],
    });
    t('tunnel: an engine whose uplink never enters the adapter falls back to the totals (which then hold each byte once)',
        r.up === 900 && r.down === 9000, JSON.stringify(r));

    // ── Xray's counters ──
    const stats = (list) => list.map(([name, value]) => ({ name, value }));
    let s = sumTrafficStats(stats([
        ['inbound>>>api>>>traffic>>>uplink', 900], ['inbound>>>api>>>traffic>>>downlink', 900],
        ['outbound>>>proxy>>>traffic>>>uplink', 1000], ['outbound>>>proxy>>>traffic>>>downlink', 50000],
        ['outbound>>>direct>>>traffic>>>uplink', 10], ['outbound>>>direct>>>traffic>>>downlink', 20],
    ]));
    t('Xray: the stats listener\'s own queries are not traffic (an idle connection used to show ~1 KB/s)',
        s.up === 1010 && s.down === 50020, JSON.stringify(s));
    s = sumTrafficStats(stats([
        ['inbound>>>socks-in>>>traffic>>>uplink', 300], ['inbound>>>socks-in>>>traffic>>>downlink', 3000],
        ['inbound>>>http-in>>>traffic>>>uplink', 200], ['inbound>>>http-in>>>traffic>>>downlink', 2000],
        ['inbound>>>api>>>traffic>>>uplink', 999],
        ['user>>>x>>>traffic>>>uplink', 500],
    ]));
    t('Xray: where the listeners are tagged, they are the count — each byte once', s.up === 500 && s.down === 5000, JSON.stringify(s));
    t('Xray: nothing reported is zero, not NaN', JSON.stringify(sumTrafficStats([])) === '{"up":0,"down":0}');

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
