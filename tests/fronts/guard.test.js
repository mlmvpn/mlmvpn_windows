'use strict';
// front-guard.js — what it does when an engine dies under a live tunnel.
//
// Worth testing precisely because it is the one part of this path that ACTS: it closes the
// machine's firewall, restarts an engine and tears down the adapter that holds the default
// route. Every one of those is a way to leave a user with no internet, so the order and the
// conditions are the whole design and must not drift.
//
// The modules it reaches for are replaced through require.cache rather than mocked in place:
// engaging the real kill switch would take THIS machine off the internet, and a test that can
// do that is not one anybody will run twice.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '../..');
process.env.MLMVPN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-guard-'));

function stub(rel, exports) {
    const file = require.resolve(path.join(ROOT, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
    return exports;
}

const tunStub = stub('tun-manager.js', {
    TUN_IFACE_NAME: 'MLMVPN',
    running: true, engine: 'psiphon.exe',
    isRunning() { return this.running; },
    currentEngine() { return this.engine; },
    async fastLive() { return { ok: true, defaultViaTun: true, defaultVia: 'MLMVPN' }; },
    async readTrafficCounters() { return { up: 0, down: 0 }; },
});
const guardStub = stub('aether-guard.js', {
    engaged: false, calls: [],
    getStatus() { return { killSwitch: this.engaged }; },
    async engageKillSwitch(o) { this.engaged = true; this.calls.push(['engage', o.allowPrograms]); return { ok: true }; },
    async releaseKillSwitch() { this.engaged = false; this.calls.push(['release']); return { ok: true }; },
});

const front = require(path.join(ROOT, 'front-guard.js'));

// A SOCKS5 listener that answers the greeting, and can be told to stop existing.
const net = require('node:net');
function socksServer(port) {
    const srv = net.createServer((c) => {
        c.on('error', () => {});
        c.once('data', () => c.write(Buffer.from([0x05, 0x00])));
    });
    return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

function fakeEngine() {
    return {
        connected: true, running: true,
        SOCKS_PORT: 0,
        getStatus() { return { connected: this.connected, running: this.running, stage: 'connected', protocol: 'FRONTED-MEEK-OSSH', rung: 'A' }; },
        readTrafficCounters() { return { up: 0, down: 0 }; },
    };
}

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

test('a dead engine is restarted before the tunnel is touched, and the machine is held closed meanwhile', async (t) => {
    const port = 21971;
    let srv = await socksServer(port);
    const mgr = fakeEngine(); mgr.SOCKS_PORT = port;
    tunStub.running = true; guardStub.engaged = false; guardStub.calls.length = 0;

    let restarts = 0, blackHoles = 0;
    front.start({
        engine: 'psiphon', label: 'سایفون', exe: 'psiphon.exe', socksPort: port, mgr,
        busy: () => false, onLog: () => {},
        tickMs: 300, goneMisses: 2, restartBackoffMs: [0, 200, 400],
        allowPrograms: ['C:/core/psiphon.exe'],
        onBlackHole: async () => { blackHoles++; },
        onRestart: async () => {
            restarts++;
            srv = await socksServer(port);   // the engine comes back up
            mgr.connected = true;
            return true;
        },
    });
    t.after(() => { front.stop('test over'); try { srv.close(); } catch (e) {} });

    // The engine vanishes: port gone, process gone.
    await new Promise((r) => srv.close(r));
    mgr.connected = false; mgr.running = false;

    // Two misses at the test's own 300 ms cadence, plus the restart itself.
    await tick(3000);

    assert.equal(restarts, 1, 'the engine is restarted once');
    assert.equal(blackHoles, 0, 'the tunnel is NOT torn down while a restart is still possible');
    assert.ok(guardStub.calls.some((c) => c[0] === 'engage'), 'the machine is held closed during the gap');
    assert.ok(guardStub.calls.find((c) => c[0] === 'engage')[1].includes('C:/core/psiphon.exe'),
        'the engine itself stays allowed through the firewall, or it could never come back');
});

test('when the restarts are spent the firewall is released BEFORE the adapter comes down', async (t) => {
    const port = 21972;
    const srv = await socksServer(port);
    const mgr = fakeEngine(); mgr.SOCKS_PORT = port;
    tunStub.running = true; guardStub.engaged = false; guardStub.calls.length = 0;

    const order = [];
    front.start({
        engine: 'psiphon', label: 'سایفون', exe: 'psiphon.exe', socksPort: port, mgr,
        busy: () => false, onLog: () => {},
        tickMs: 300, goneMisses: 2, restartBackoffMs: [0, 200, 400],
        allowPrograms: ['C:/core/psiphon.exe'],
        onBlackHole: async () => { order.push('teardown'); },
        onRestart: async () => { order.push('restart'); return false; },   // never recovers
    });
    t.after(() => front.stop('test over'));

    await new Promise((r) => srv.close(r));
    mgr.connected = false; mgr.running = false;

    // Long enough for the misses, all three restart attempts with their backoff, and the
    // teardown that follows them — at the compressed cadence this test sets.
    await tick(6000);

    assert.ok(order.includes('teardown'), 'the tunnel does come down once the restarts are spent');
    const release = guardStub.calls.findIndex((c) => c[0] === 'release');
    assert.ok(release >= 0, 'the firewall is released');
    assert.ok(order.filter((o) => o === 'restart').length >= 2, 'it really did try more than once');
    assert.equal(guardStub.engaged, false,
        'the machine is never left closed with no tunnel — that is offline with no way back');
});

test('a guard with no tunnel never closes the machine', async (t) => {
    const port = 21973;
    const srv = await socksServer(port);
    const mgr = fakeEngine(); mgr.SOCKS_PORT = port;
    // Proxy-only mode: the adapter never took the route, so there is nothing to hold closed and
    // closing it would take the machine off the internet for a tunnel it was not carrying.
    tunStub.running = false; guardStub.engaged = false; guardStub.calls.length = 0;

    let blackHoles = 0, restarts = 0;
    front.start({
        engine: 'psiphon', label: 'سایفون', exe: 'psiphon.exe', socksPort: port, mgr,
        busy: () => false, onLog: () => {},
        tickMs: 300, goneMisses: 2, restartBackoffMs: [0, 200, 400],
        onBlackHole: async () => { blackHoles++; },
        onRestart: async () => { restarts++; return false; },
    });
    t.after(() => front.stop('test over'));

    await new Promise((r) => srv.close(r));
    mgr.connected = false; mgr.running = false;
    await tick(3000);

    assert.equal(guardStub.calls.length, 0, 'the firewall is never touched without a tunnel');
    assert.equal(blackHoles, 0, 'and there is no adapter to tear down');
    assert.equal(restarts, 0, 'nor anything to restart on behalf of a route we do not own');
});
