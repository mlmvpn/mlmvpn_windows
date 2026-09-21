// The V2Ray routes, exercised end to end against the real server.js.
//
// The unit suite beside this one pins what xray-manager does; this one pins what the ROUTES
// do with it — the order of operations that decides whether the panel and the machine agree.
//
// server.js is loaded with everything that would touch this computer replaced in the module
// cache first: child_process (so nothing spawns), tun-manager (so no adapter is built), the
// two startup recovery paths (they rewrite firewall rules and DNS), and the modules that
// reach the network. Nothing here listens on a real port either — the express app is called
// directly through a fake request/response pair.
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-v2ray-routes-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
process.env.MV_NO_LISTEN = '1';

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const stub = (mod, exports) => {
    const p = require.resolve(mod.startsWith('.') ? ROOT + mod.slice(1) : mod);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

// ── nothing spawns ──────────────────────────────────────────────────────────────
const rec = { order: [], reg: [] };
const fakeChild = () => ({
    pid: 9000 + rec.order.length, killed: false,
    stdout: { on() {}, pipe() {} }, stderr: { on() {}, pipe() {} },
    on() { return this; }, kill() { this.killed = true; },
});
stub('child_process', {
    spawn(exe) { rec.order.push('spawn:' + path.basename(String(exe))); return fakeChild(); },
    execFile(exe, args, opts, cb) {
        const done = typeof opts === 'function' ? opts : cb;
        rec.order.push(String(exe));
        if (exe === 'reg') rec.reg.push(args);
        if (done) setImmediate(() => done(null, 'ProxyEnable    REG_DWORD    0x0', ''));
        return fakeChild();
    },
    execFileSync() { return ''; },
    execSync(cmd) { rec.order.push('execSync:' + String(cmd).split(' ')[0]); return 'ProxyEnable    REG_DWORD    0x0'; },
});

// ── the tunnel, watched but never built ─────────────────────────────────────────
const tun = {
    running: false, engine: 'xray.exe', started: 0, stopped: 0, verified: 0, failStart: null,
    isRunning() { return this.running; },
    currentEngine() { return this.running ? this.engine : null; },
    checkPrerequisites() {},
    async startTun() {
        if (this.failStart) { const e = this.failStart; this.failStart = null; throw new Error(e); }
        this.started++; this.running = true; rec.order.push('tun.start');
    },
    stopTun() { this.stopped++; this.running = false; rec.order.push('tun.stopTun'); },
    async stopTunAsync() { this.stopped++; this.running = false; rec.order.push('tun.stopTunAsync'); },
    async verifyTornDown() { this.verified++; rec.order.push('tun.verifyTornDown'); return { ok: true }; },
    async pickTunnelResolver() { return { server: '8.8.8.8', udp: true }; },
    async socksCarriesUdp() { return true; },
    async verifyTunCarriesTraffic() { return true; },
    async socksResolvesTcp() { return true; },
    readTrafficCounters() { return null; },
    tallyCounters() { return null; },
    async inspectAdapter() { return { adapter: false, defaultViaTun: false }; },
    async checkLive() { return { ok: this.running }; },
    async waitForReady() { return { ok: true }; },
    binPaths() { return { exe: 'sing-box.exe', config: 'c.json' }; },
    TUN_IFACE_NAME: 'MLMVPN',
    buildTunConfig() { return {}; }, buildGameTunConfig() { return {}; }, buildSmartTunConfig() { return {}; },
    async rebuild() { return true; }, async probeTunThroughput() {}, async probeTunReachableByIp() { return true; },
    async tunnelCarriesData() { return { ok: true, why: 'stub', ms: 1, target: '1.1.1.1:80' }; }, uncoveredUplinks() { return []; },
};
stub('./tun-manager', tun);

// ── the two startup recovery paths: they rewrite firewall rules and DNS ─────────
stub('./aether-guard', {
    restoreIfStale() {}, bailSync() {},
    async engage() {}, async release() {}, async state() { return {}; },
    isEngaged() { return false; },
});
stub('./netdiag/journal', { restoreIfStale: async () => {} });

const app = (() => {
    try { require(ROOT + '/server.js'); } catch (e) { console.error('server.js failed to load:', e.message); process.exit(1); }
    return require(ROOT + '/server.js').app;
})();

// ── a request, without a socket ─────────────────────────────────────────────────
function call(method, url, body) {
    return new Promise((resolve) => {
        const EventEmitter = require('events');
        const req = new EventEmitter();
        Object.assign(req, { method, url, originalUrl: url, headers: { 'content-type': 'application/json', host: '127.0.0.1' }, body: body || {}, query: {}, params: {}, connection: {}, socket: {} });
        req.get = (h) => req.headers[String(h).toLowerCase()];
        req.header = req.get;
        let code = 200, chunks = '';
        const res = new EventEmitter();
        Object.assign(res, {
            statusCode: 200, writableEnded: false, headersSent: false, locals: {},
            status(c) { code = c; this.statusCode = c; return this; },
            set() { return this; }, setHeader() { return this; }, getHeader() {}, type() { return this; },
            write(s) { chunks += s; return true; },
            json(o) { this.writableEnded = true; resolve({ code, body: o }); return this; },
            send(o) { this.writableEnded = true; resolve({ code, body: o }); return this; },
            end(s) { if (s) chunks += s; this.writableEnded = true; resolve({ code, body: chunks }); return this; },
        });
        app(req, res, () => resolve({ code: 404, body: null }));
        // REAL EXPRESS EMITS THIS, AND IT IS NOT A DISCONNECT.
        //
        // express.json() reads the request body to the end before the handler runs, so the
        // REQUEST stream closes on the very first tick while the client is still perfectly
        // connected (measured: `req close @0ms`, `res close @3039ms`). A handler that treats
        // `req` 'close' as "the user went away" therefore cancels itself instantly. That
        // shipped in /api/v2ray/test-nodes and was invisible here, because this harness's
        // fake request never fired the event. It fires now, for every route.
        setImmediate(() => req.emit('close'));
    });
}

const URI = 'vless://11111111-2222-3333-4444-555555555555@example.com:443?type=ws&security=tls#node-a';
const URI2 = 'vless://11111111-2222-3333-4444-555555555555@other.example:443?type=ws&security=tls#node-b';

// The routes refuse to build a tunnel over a dead SOCKS port — correctly, since pointing the
// default route at nothing takes the machine offline with no way back. Nothing real is spawned
// here, so stand in for the engine's listeners with two loopback sockets that accept and say
// nothing. This is the one thing in these tests that touches the machine, and it is a pair of
// 127.0.0.1 listeners closed at the end.
const net = require('net');
const listeners = [];
function hold(port) {
    return new Promise((resolve) => {
        const s = net.createServer((c) => c.on('error', () => {}));
        s.on('error', () => resolve(null));
        s.listen(port, '127.0.0.1', () => { listeners.push(s); resolve(s); });
    });
}

(async () => {
    const P = require(ROOT + '/xray-manager').getPorts();
    await hold(P.socks);
    await hold(P.http);

    // ── connect ─────────────────────────────────────────────────────────────────
    let r = await call('POST', '/api/v2ray/start', { uri: URI, useSystemProxy: false });
    t('a connect answers 200', r.code === 200, JSON.stringify(r));

    // ── the full tunnel comes up ────────────────────────────────────────────────
    r = await call('POST', '/api/v2ray/tun', { enabled: true });
    t('the full tunnel comes up over a live engine', r.code === 200 && r.body && r.body.running === true, JSON.stringify(r.body));

    r = await call('GET', '/api/v2ray/tun/status');
    t('…and the panel is told so', r.body && r.body.running === true && r.body.wanted === true, JSON.stringify(r.body));

    // ── THE BUG: switching node used to leave the switch on over no tunnel ──────
    //
    // startXray() opened with the synchronous stopXray(), which stops the TUN. The refresh
    // that should rebuild it around the new node then saw no adapter and returned, leaving
    // `wanted: true` with nothing running — a green «بدون نشتی» switch over a machine routing
    // normally, and Xray still in its full-tunnel shape so its split rules were gone too.
    const startedBefore = tun.started;
    r = await call('POST', '/api/v2ray/start', { uri: URI2, useSystemProxy: false });
    t('switching node keeps the connection', r.code === 200, JSON.stringify(r));
    t('…and rebuilds the tunnel around the new node instead of losing it',
        tun.started === startedBefore + 1 && tun.running === true,
        `startTun ${startedBefore} → ${tun.started}, running=${tun.running}`);

    r = await call('GET', '/api/v2ray/tun/status');
    t('…so the switch still tells the truth afterwards',
        r.body && r.body.running === true && r.body.wanted === true, JSON.stringify(r.body));

    // ── a rebuild that FAILS must turn the switch off, not leave it lying ───────
    tun.failStart = 'adapter busy';
    r = await call('POST', '/api/v2ray/start', { uri: URI, useSystemProxy: false });
    const st = await call('GET', '/api/v2ray/tun/status');
    t('a tunnel that cannot be rebuilt turns its own switch off',
        st.body && st.body.running === false && st.body.wanted === false, JSON.stringify(st.body));

    // ── the proxy and the tunnel are alternatives, in both directions ───────────
    await call('POST', '/api/v2ray/start', { uri: URI, useSystemProxy: true });
    r = await call('POST', '/api/v2ray/tun', { enabled: true });
    t('the tunnel comes up over a connection made with the system proxy', r.body && r.body.running === true, JSON.stringify(r.body));
    const lastEnable = rec.reg.filter(a => a.includes('ProxyEnable')).pop();
    t('…and the rebuild it does on the way up does not turn the proxy back on',
        lastEnable && lastEnable[lastEnable.indexOf('/d') + 1] === '0', JSON.stringify(lastEnable));

    // ── turning it off hands the proxy back ────────────────────────────────────
    r = await call('POST', '/api/v2ray/tun', { enabled: false });
    t('turning the tunnel off answers cleanly', r.code === 200 && r.body.running === false, JSON.stringify(r.body));
    const afterOff = rec.reg.filter(a => a.includes('ProxyServer')).length;
    t('…and gives back the system proxy it had taken away', afterOff > 0, String(afterOff));
    t('…without blocking the main process', !rec.order.includes('tun.stopTun'), rec.order.slice(-12).join(' → '));

    // ── a sweep must survive the request stream closing ────────────────────────
    //
    // THE BUG: /api/v2ray/test-nodes cancelled itself on `req` 'close', which real express
    // fires immediately (see the note in call() above). The test config was written, the core
    // came up, every worker returned at its abort check, and the panel received a `done` line
    // with no results in it — «تست دیلی میگیرم جلوی همشون خط فاصله میاد». The tcping path is
    // used here because it needs no core and so runs in milliseconds, while going through
    // exactly the abort check that was firing.
    // Three nodes down ONE lane, so the sweep is still running when 'close' arrives: with
    // every node in flight at once they all finish inside the first tick and the abort has
    // nothing left to cancel, which is how a one-node version of this test passed against
    // the broken code.
    r = await call('POST', '/api/v2ray/test-nodes', {
        // port 9 (discard) on loopback: refused instantly, so this is fast and offline.
        nodes: [0, 1, 2].map(i => ({ id: i, uri: `vless://11111111-2222-3333-4444-555555555555@127.0.0.1:${9 + i}?type=tcp` })),
        testType: 'ping',
        settings: { concurrency: 1 },
    });
    const swept = String(r.body).trim().split('\n').map(l => { try { return JSON.parse(l); } catch (e) { return {}; } });
    t('a sweep is not cancelled by the request stream closing',
        [0, 1, 2].every(i => swept.some(l => l.id === i && typeof l.val === 'number')),
        JSON.stringify(swept));
    t('…and the summary counts what was really tested',
        swept.some(l => l.done === true && l.tested === 3), JSON.stringify(swept.filter(l => l.done)));

    // ── refusing rather than taking the machine offline ────────────────────────
    //
    // With no engine behind the SOCKS port the default route would point at nothing, and the
    // user would have no way back — not even a page to read the reason on. The stand-in
    // listeners go first, because they are what makes that port look alive here.
    await call('POST', '/api/v2ray/stop');
    await Promise.all(listeners.splice(0).map(s => new Promise(res2 => s.close(res2))));
    r = await call('POST', '/api/v2ray/tun', { enabled: true });
    t('the tunnel is refused when no engine is behind the port',
        r.code === 409 && /XRAY_NOT_RUNNING/.test(JSON.stringify(r.body)), JSON.stringify(r.body));

    module.exports = results;
    if (require.main === module) {
        results.forEach(r2 => console.log((r2.pass ? 'PASS  ' : 'FAIL  ') + r2.name + (r2.pass || !r2.detail ? '' : '\n      ' + r2.detail)));
        const bad = results.filter(r2 => !r2.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})();
