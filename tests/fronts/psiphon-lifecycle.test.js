'use strict';
// Never the user's own diary: these suites drive the real managers with a fake core, and every
// fake connect would otherwise land in ~/.mlmvpn/tunnel-events.log — see MLMVPN_HOME in
// tun-diag.js. run.js sets this too; doing it here as well is what makes running ONE file
// directly, which is how these get debugged, safe as well.
if (!process.env.MLMVPN_HOME) {
    process.env.MLMVPN_HOME = require('node:fs').mkdtempSync(
        require('node:path').join(require('node:os').tmpdir(), 'mlm-diag-'));
}
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const file = path.resolve(__dirname, '../../psiphon-manager.js');
const localRequire = createRequire(file);

function harness(t, overrides = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-psiphon-test-'));
    const children = [], updates = [];
    const module = { exports: {} };
    const cp = { spawn() {
        const child = new EventEmitter();
        child.pid = 4000 + children.length;
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        child.kill = () => {};
        child.notice = (noticeType, data) => child.stdout.emit('data', Buffer.from(JSON.stringify({ noticeType, data }) + '\n'));
        children.push(child);
        return child;
    } };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        module, exports: module.exports, __dirname: path.dirname(file), Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
        // The module reads process.env (MLMVPN_HOME marks a test, so the orphan-core
        // pre-flight is skipped). A sandbox without `process` turns that read into a
        // ReferenceError inside startPsiphon, which surfaces as «no rung connected».
        process,
        require: id => overrides[id] || (id === 'child_process' ? cp : id === 'os' ? { homedir: () => home } : localRequire(id)),
    }, { filename: file });
    const mgr = module.exports;
    t.after(() => { mgr.stopPsiphon(); fs.rmSync(home, { recursive: true, force: true }); });
    const start = () => mgr.startPsiphon({ rung: 'A' }, () => {}, s => updates.push(s));
    // The core is no longer spawned in the same tick as the call: `startPsiphon` first checks
    // whether a core from a previous run is still holding the SOCKS port and the datastore lock
    // (see waitForProcExit — losing that race fails every rung, not one). So wait for the child
    // to exist rather than assuming it already does.
    const nextChild = async (from = children.length) => {
        for (let i = 0; i < 200 && children.length <= from; i++) await new Promise(r => setTimeout(r, 5));
        return children.at(-1);
    };
    const connect = async () => {
        const before = children.length;
        const p = start();
        (await nextChild(before)).notice('Tunnels', { count: 1 });
        await p;
    };
    return { mgr, children, updates, start, connect, nextChild };
}

test('a lost tunnel clears connected and recovery restores it without restarting the core', async t => {
    const h = harness(t); await h.connect();
    const child = h.children[0];
    child.notice('Tunnels', { count: 0 });
    assert.equal(h.mgr.getStatus().connected, false);
    assert.equal(h.mgr.getStatus().running, true);
    assert.equal(h.mgr.getStatus().stage, 'reconnecting');
    assert.equal(h.updates.at(-1).connected, false);
    child.notice('Tunnels', { count: 1 });
    assert.equal(h.mgr.getStatus().connected, true);
    assert.equal(h.mgr.getStatus().stage, 'connected');
    assert.equal(h.children.length, 1);
});

test('core exit after connection clears its live status and publishes an error', async t => {
    const h = harness(t); await h.connect();
    h.children[0].emit('exit', 1);
    assert.equal(h.mgr.getStatus().running, false);
    assert.equal(h.mgr.getStatus().connected, false);
    assert.equal(h.mgr.isRunning(), false);
    assert.ok(h.updates.at(-1).error);
});

test('starting an already-running core returns the live pid for route validation', async t => {
    const h = harness(t); await h.connect();
    const again = await h.mgr.startPsiphon({ rung: 'A' }, () => {}, () => {});
    assert.equal(again.pid, h.mgr.getStatus().pid);
    assert.equal(again.socks, '127.0.0.1:20830');
    assert.equal(h.children.length, 1);
});

test('a queued success cannot revive a session that the user stopped', async t => {
    const h = harness(t); const p = h.start();
    (await h.nextChild(0)).notice('Tunnels', { count: 1 });
    h.mgr.stopPsiphon();
    await assert.rejects(p);
    assert.equal(h.mgr.getStatus().connected, false);
    assert.equal(h.mgr.getStatus().stage, 'idle');
});

test('late notices and exit from the previous core cannot corrupt a new session', async t => {
    const h = harness(t); await h.connect();
    const old = h.children[0]; h.mgr.stopPsiphon(); await h.connect();
    old.notice('BytesTransferred', { sent: 999, received: 999 });
    old.notice('Tunnels', { count: 0 }); old.emit('exit', 1);
    assert.equal(h.mgr.getStatus().connected, true);
    assert.equal(h.mgr.getStatus().received, 0);
});

function socksPeer({ http = true, fragmented = false } = {}) {
    return { Socket: class extends EventEmitter {
        setTimeout() {}
        connect(_port, _host, ready) { queueMicrotask(ready); }
        destroy() { this.dead = true; }
        write(data) {
            let reply;
            if (Buffer.isBuffer(data) && data.length === 3) reply = Buffer.from([5, 0]);
            else if (Buffer.isBuffer(data)) reply = Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]);
            else if (http) reply = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK');
            if (!reply) return queueMicrotask(() => this.emit('close'));
            queueMicrotask(() => {
                if (this.dead) return;
                if (fragmented) { for (const byte of reply) { if (!this.dead) this.emit('data', Buffer.from([byte])); } }
                else this.emit('data', reply);
            });
        }
    } };
}

test('a SOCKS handshake without any returned HTTP data is not a working data path', async t => {
    const h = harness(t, { net: socksPeer({ http: false }) });
    assert.equal(await h.mgr.socksCarriesStream(100), false);
});

test('the data probe accepts actual HTTP traffic even with fragmented SOCKS replies', async t => {
    const h = harness(t, { net: socksPeer({ fragmented: true }) });
    assert.equal(await h.mgr.socksCarriesStream(100), true);
});
