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
const harness = require('./panel-harness');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const response = (data = {}, ok = true) => ({ ok, json: async () => data });

test('disconnect immediately spins and locks the power button until stop finishes', async () => {
    const stop = deferred(); let stops = 0;
    const h = harness(url => url.endsWith('/stop') ? (stops++, stop.promise) : Promise.resolve(response({ installed: true, status: {} })));
    const pending = h.toggle('psiphon');
    const during = { tone: h.state('psiphon').tone, spin: h.parts.glyph.className, disabled: h.parts.power.disabled };
    const duplicate = h.toggle('psiphon');
    stop.resolve(response()); await Promise.all([pending, duplicate]);
    assert.equal(during.tone, 'busy');
    assert.match(during.spin, /fr-spin/);
    assert.equal(during.disabled, true);
    assert.equal(stops, 1);
    assert.equal(h.st.psiphon.stopping, false);
});

test('stop errors are shown instead of claiming a successful disconnect', async () => {
    const h = harness(url => Promise.resolve(url.endsWith('/stop')
        ? response({ error: 'cleanup failed' }, false)
        : response({ installed: true, status: { running: true, connected: true }, tun: true })));
    await h.toggle('psiphon');
    assert.ok(h.st.psiphon.log.some(line => line.includes('cleanup failed')));
    assert.equal(h.st.psiphon.log.some(line => line.includes('— قطع شد')), false);
    assert.equal(h.parts.power.disabled, false);
});

test('switching from full tunnel to proxy shows progress while the engine remains connected', async () => {
    const stop = deferred();
    const h = harness(url => url === '/api/front/tun' ? stop.promise : Promise.resolve(response({ installed: true, status: { connected: true, running: true }, tun: false })));
    const pending = h.setCoverage('psiphon', 'proxy');
    const during = { tone: h.state('psiphon').tone, spin: h.parts.glyph.className, disabled: h.parts.power.disabled };
    stop.resolve(response()); await pending;
    assert.equal(during.tone, 'busy');
    assert.match(during.spin, /fr-spin/);
    assert.equal(during.disabled, true);
    assert.equal(h.st.psiphon.payload.status.connected, true);
});

test('a late start response after cancel never enables the system tunnel', async () => {
    const start = deferred(); const calls = [];
    const h = harness((url, options) => {
        calls.push({ url, options });
        return url.endsWith('/start') ? start.promise : Promise.resolve(response({ installed: true, status: {}, tun: false }));
    });
    h.st.psiphon.payload.status = {}; h.st.psiphon.coverage = 'tunnel';
    const pending = h.toggle('psiphon'); await h.toggle('psiphon');
    start.resolve(response()); await pending;
    assert.equal(calls.some(c => c.url === '/api/front/tun'), false);
});
