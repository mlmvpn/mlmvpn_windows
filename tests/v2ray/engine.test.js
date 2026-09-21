// The V2Ray engine's start/stop contract — xray-manager.js.
//
// Every case here is a bug that shipped, and each one looked like one of three complaints:
// «قطع کردن فریز می‌شود», «قطع است ولی می‌زند در حال اتصال» and «وصل است ولی هیچ دیتایی رد
// نمی‌شود». They share a cause: a connect that reached past the engine and tore down things it
// did not own — the tunnel adapter, the Windows proxy, other xray.exe processes.
//
// Nothing here spawns a process or touches the machine: child_process, fs and tun-manager are
// replaced in the module cache before xray-manager is required, so every spawn, taskkill and
// registry write is recorded instead of run.
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-v2ray-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── the recorder ────────────────────────────────────────────────────────────────
const rec = {
    order: [],        // every side effect, in the order it happened
    spawns: [],       // [exe, args]
    kills: [],        // taskkill argv
    reg: [],          // `reg add` argv
    reset() { this.order = []; this.spawns = []; this.kills = []; this.reg = []; },
};

function fakeChild() {
    const listeners = {};
    return {
        pid: 4242 + rec.spawns.length,
        killed: false,
        stdout: { on() {}, pipe() {} },
        stderr: { on() {}, pipe() {} },
        on(ev, fn) { listeners[ev] = fn; return this; },
        kill() { this.killed = true; },
    };
}

const cp = {
    spawn(exe, args) {
        rec.order.push('spawn');
        rec.spawns.push([exe, args]);
        return fakeChild();
    },
    execFile(exe, args, opts, cb) {
        const done = typeof opts === 'function' ? opts : cb;
        if (exe === 'taskkill') { rec.order.push('taskkill'); rec.kills.push(args); }
        else if (exe === 'reg') { rec.order.push('reg'); rec.reg.push(args); }
        else rec.order.push(exe);
        if (done) setImmediate(() => done(null, '', ''));
        return fakeChild();
    },
    execSync(cmd) { rec.order.push('execSync:' + String(cmd).split(' ')[0]); return ''; },
};
require.cache[require.resolve('child_process')] = {
    id: 'child_process', filename: 'child_process', loaded: true, exports: cp,
};

// ── the tunnel, watched ─────────────────────────────────────────────────────────
// The point of most of these tests is that the ENGINE never reaches in here.
const tunStub = {
    running: false,
    engine: 'xray.exe',
    stopCalls: 0,
    isRunning() { return this.running; },
    currentEngine() { return this.running ? this.engine : null; },
    stopTun() { this.stopCalls++; rec.order.push('tun.stopTun'); },
    async stopTunAsync() { this.stopCalls++; rec.order.push('tun.stopTunAsync'); },
    async verifyTornDown() { rec.order.push('tun.verifyTornDown'); return { ok: true }; },
};
const tunPath = require.resolve(ROOT + '/tun-manager');
require.cache[tunPath] = { id: tunPath, filename: tunPath, loaded: true, exports: tunStub };

// ── the config builder, stubbed out ─────────────────────────────────────────────
// generateXrayConfig reaches the network (cloud-manager). Its ORDER relative to the kill is
// the thing under test, so it records itself and returns a minimal valid config.
const cloudPath = require.resolve(ROOT + '/cloud-manager');
require.cache[cloudPath] = {
    id: cloudPath, filename: cloudPath, loaded: true,
    exports: { async fetchCloudConfigs() { rec.order.push('network'); return { configs: [] }; } },
};

// fs, with writes recorded and the exe pretended into existence.
const realFs = Object.assign({}, fs);
const fsStub = Object.assign({}, fs, {
    existsSync(p) { return /xray\.exe$/i.test(p) ? true : realFs.existsSync(p); },
    writeFileSync(p, data) { rec.order.push('write:' + path.basename(p)); },
    writeFile(p, data, cb) { rec.order.push('write:' + path.basename(p)); if (cb) cb(null); },
    unlink(p, cb) { if (cb) cb(null); },
});
require.cache[require.resolve('fs')] = { id: 'fs', filename: 'fs', loaded: true, exports: fsStub };

const xray = require(ROOT + '/xray-manager');

// ── a stand-in for the engine's own listener ────────────────────────────────────
// startXray now refuses to report success until the SOCKS inbound accepts a connection: it
// used to spawn xray.exe and return `true` on the spot, so a core that had already died was
// reported as a live connection. Nothing real is spawned here, so hold that port on loopback
// for the duration. This and the pair in routes.test.js are the only things in these suites
// that touch the machine, and both are closed at the end.
const net = require('net');
const listeners = [];
const hold = (port) => new Promise((resolve) => {
    const s = net.createServer((c) => c.on('error', () => {}));
    s.on('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => { listeners.push(s); resolve(s); });
});
const releaseListeners = () => Promise.all(listeners.splice(0).map(s => new Promise(r => s.close(r))));

const URI = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?type=ws&security=tls#node-a';
const URI2 = 'vless://11111111-2222-3333-4444-555555555555@other.example:443?type=ws&security=tls#node-b';
const quiet = () => {};

(async () => {
    await hold(xray.getPorts().socks);

    // ── 1. a connect must not touch the tunnel ───────────────────────────────────
    //
    // startXray() used to open with the synchronous stopXray(), whose FIRST act is to stop the
    // TUN. Switching node with the full tunnel on therefore destroyed the tunnel as a side
    // effect — and /api/v2ray/start's `v2rayTunRefreshUplink()`, the code that exists to
    // rebuild it around the new node, returned at its `!tun.isRunning()` guard. The machine
    // was left with the switch green, Xray still in its full-tunnel shape, and no tunnel.
    rec.reset();
    tunStub.running = true;
    tunStub.stopCalls = 0;
    await xray.startXray(URI, null, null, null, false, quiet);
    t('a connect leaves the tunnel adapter alone', tunStub.stopCalls === 0, `stopTun called ${tunStub.stopCalls}×`);
    t('…and switching node does not either', await (async () => {
        tunStub.stopCalls = 0;
        await xray.startXray(URI2, null, null, null, false, quiet);
        return tunStub.stopCalls === 0;
    })(), `stopTun called ${tunStub.stopCalls}×`);

    // ── 2. nothing on the connect path may block the main process ────────────────
    //
    // The server runs inside Electron's main process. stopXray's execSync taskkill, the three
    // execSync `reg add` calls behind the system proxy and the tunnel teardown's 3 s
    // Atomics.wait added up to a window frozen for as long as thirteen seconds, every time.
    rec.reset();
    await xray.startXray(URI, null, null, null, true, quiet);
    t('a connect runs no synchronous child process',
        !rec.order.some(o => o.startsWith('execSync')),
        rec.order.filter(o => o.startsWith('execSync')).join(', '));

    // ── 3. the config is built while the old engine is still carrying traffic ────
    //
    // Under a live full tunnel every packet goes through xray.exe, so killing it before
    // generateXrayConfig meant that function's network call waited out its own timeout with
    // the whole machine offline — on every single connect.
    t('the config is built before the engine is killed',
        rec.order.indexOf('network') < rec.order.indexOf('taskkill') && rec.order.indexOf('network') !== -1,
        rec.order.join(' → '));

    // ── 4. the kill is aimed at OUR process ──────────────────────────────────────
    //
    // `taskkill /IM xray.exe` takes every xray.exe on the machine — including the delay
    // test's own engine and the scanner's. Connecting during a delay test killed the test,
    // and every node reported "-1ms" with nothing anywhere saying why.
    const byPid = rec.kills.find(k => k.includes('/PID'));
    t('a restart kills the running engine by PID, not every xray.exe',
        !!byPid && !rec.kills.some(k => k.includes('/IM')),
        JSON.stringify(rec.kills));

    // ── 5. the system proxy is set both ways, after the new listener exists ──────
    //
    // It used to be cleared at the top of startXray (inside stopXray) and turned back on at
    // the bottom, so a connect asking for NO proxy depended on that teardown — and there was a
    // window in between where a browser bypassed the proxy entirely.
    const enable = rec.reg.filter(a => a.includes('ProxyEnable'));
    t('the system proxy is written after the engine is up',
        rec.order.lastIndexOf('reg') > rec.order.lastIndexOf('spawn'),
        rec.order.join(' → '));
    t('…and asking for a proxy sets it on', enable.some(a => a[a.indexOf('/d') + 1] === '1'), JSON.stringify(enable));

    rec.reset();
    await xray.startXray(URI, null, null, null, false, quiet);
    const off = rec.reg.filter(a => a.includes('ProxyEnable'));
    t('…and asking for none sets it off, rather than relying on a teardown',
        off.length === 1 && off[0][off[0].indexOf('/d') + 1] === '0', JSON.stringify(off));

    // ── 6. the proxy intent survives a rebuild ──────────────────────────────────
    //
    // restartXray replays lastStartArgs, and only a connect ever wrote useSystemProxy. So the
    // full-tunnel path, which switches the proxy off because the two cannot coexist, had it
    // put straight back by its own rebuild two steps later — both live at once, and the panel's
    // switch showing neither. The other direction was just as wrong: a proxy turned on from its
    // own switch was silently turned off by the next settings change.
    rec.reset();
    xray.setSystemProxyIntent(true);
    await xray.restartXray(quiet);
    t('a proxy turned on outside a connect survives the next rebuild',
        rec.reg.some(a => a.includes('ProxyServer')), JSON.stringify(rec.reg));

    rec.reset();
    xray.setSystemProxyIntent(false);
    await xray.restartXray(quiet);
    t('…and one turned off for the full tunnel is not resurrected by it',
        !rec.reg.some(a => a.includes('ProxyServer')), JSON.stringify(rec.reg));

    // ── 7. the scanner's engine is not the user's engine ────────────────────────
    //
    // startBatchXray opened with stopXray() and wrote over core/config.json, so starting an IP
    // scan killed whatever node the user was connected to and tore their tunnel down with it —
    // while the panel went on saying «متصل است».
    rec.reset();
    const uriBefore = xray.getCurrentUri();
    const batch = await xray.startBatchXray(URI, [{ ip: '1.2.3.4', port: 443 }, { ip: '5.6.7.8', port: 443 }]);
    t('a scan kills nothing of the user\'s', rec.order.every(o => !/taskkill/.test(o)), rec.order.join(' → '));
    t('…and does not claim its identity', xray.getCurrentUri() === uriBefore, String(xray.getCurrentUri()));
    t('…and writes its own config file, not the live one',
        rec.order.includes('write:config_scan.json') && !rec.order.includes('write:config.json'),
        rec.order.join(' → '));
    t('…and reports the ports it actually bound', batch && batch.basePort === 31000, JSON.stringify(batch));
    t('…on ports the node delay test cannot collide with', batch.basePort >= 30000, String(batch.basePort));

    rec.reset();
    await xray.stopBatchXray();
    t('stopping a scan kills only the scan engine',
        rec.kills.length === 1 && rec.kills[0].includes('/PID') && xray.isRunning(),
        JSON.stringify(rec.kills));

    // ── 8. a disconnect verifies the tunnel really went ─────────────────────────
    //
    // stopTunAsync ends in `taskkill /F` whenever sing-box does not unwind in three seconds,
    // and a forced kill runs none of its shutdown code: auto_route, strict_route and its WFP
    // filters stay as they are, so the adapter keeps the default route with nothing behind it.
    // That is «وصل است ولی هیچ دیتایی رد نمی‌شود», reached by pressing disconnect.
    rec.reset();
    tunStub.running = true;
    tunStub.engine = 'xray.exe';
    await xray.stopXrayAsync();
    t('a disconnect checks the tunnel is really down', rec.order.includes('tun.verifyTornDown'), rec.order.join(' → '));
    t('…without blocking the main process', !rec.order.includes('tun.stopTun'), rec.order.join(' → '));
    t('…and clears the system proxy', rec.reg.some(a => a.includes('ProxyEnable') && a[a.indexOf('/d') + 1] === '0'), JSON.stringify(rec.reg));

    // …but only a tunnel THIS engine is carrying. There is one MLMVPN adapter and several
    // engines want it, so disconnecting a V2Ray node while a WARP engine held it used to take
    // the WARP tunnel down too — a feature the user was not touching, killed from another panel.
    rec.reset();
    tunStub.running = true;
    tunStub.engine = 'aether.exe';
    await xray.stopXrayAsync();
    t('a disconnect leaves another engine\'s tunnel alone',
        !rec.order.some(o => o.startsWith('tun.stop')), rec.order.join(' → '));

    // ── 9. the orphan case still works ──────────────────────────────────────────
    //
    // With no handle of our own there IS nothing to aim at: a process left holding the SOCKS
    // port by a previous run of the app is cleared by image name, which is what lets the next
    // start bind at all.
    rec.reset();
    tunStub.running = false;
    await xray.startXray(URI, null, null, null, false, quiet);
    t('with no engine of ours running, a stale xray.exe is still cleared',
        rec.kills.some(k => k.includes('/IM')), JSON.stringify(rec.kills));

    await releaseListeners();

    module.exports = results;
    if (require.main === module) {
        results.forEach(r => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass || !r.detail ? '' : '\n      ' + r.detail)));
        const bad = results.filter(r => !r.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})();
