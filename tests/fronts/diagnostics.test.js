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
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

test('diagnostics survive restart and retain rates, update results and connection failures', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-front-diag-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const { createDiagnostics } = require('../../psiphon-diagnostics');
    const diag = createDiagnostics(dir);
    diag.record('connect-start', { region: 'auto' });
    diag.record('connect-failed', { error: 'timeout while connecting' });
    diag.sample({ up: 0, down: 0 }, 1000);
    diag.sample({ up: 125000, down: 1250000 }, 11000);
    diag.notice('RemoteServerListResourceDownloaded', { url: 'https://example.com/list' }, 12000);
    diag.notice('Warning', { message: 'signature verification failed' }, 13000);
    const restored = createDiagnostics(dir).snapshot();
    assert.equal(restored.serverList.lastDownloadAt, new Date(12000).toISOString());
    assert.match(restored.recent, /timeout while connecting/);
    assert.match(restored.recent, /"downMbps":1/);
    assert.match(restored.recent, /"upMbps":0.1/);
    assert.match(restored.recent, /signature verification failed/);
});

test('quiet traffic is logged as inactivity, without declaring a broken tunnel', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-front-diag-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const diag = require('../../psiphon-diagnostics').createDiagnostics(dir);
    diag.sample({ up: 0, down: 0 }, 1000);
    diag.sample({ up: 0, down: 0 }, 11000);
    assert.match(diag.snapshot().recent, /"downMbps":0/);
    assert.match(diag.snapshot().recent, /"idleSeconds":10/);
    assert.doesNotMatch(diag.snapshot().recent, /connection-failed/);
});

test('diagnostic logs rotate and bound messages instead of growing without limit', t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-front-diag-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const diag = require('../../psiphon-diagnostics').createDiagnostics(dir);
    for (let i = 0; i < 650; i++) diag.record('warning', { message: 'x'.repeat(5000) });
    const snapshot = diag.snapshot();
    assert.ok(fs.statSync(snapshot.logFile).size < 2 * 1024 * 1024 + 8192);
    assert.ok(fs.existsSync(snapshot.logFile + '.1'));
    assert.ok(snapshot.recent.length < 70000);
});
