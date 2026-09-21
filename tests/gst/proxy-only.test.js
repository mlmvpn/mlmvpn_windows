/*
 * «تونل گوگل اسکریپت» has two connection modes, and the third one stays gone.
 *
 * The full tunnel — a sing-box adapter feeding the whole machine into the engine's SOCKS port —
 * was removed on 2026-09-20 after three rounds of fixes, each of which uncovered the next
 * failure rather than the last one. What the rounds established, and what this suite protects:
 *
 *   · the engine is an HTTP relay. From its own dispatch log:
 *       example.com:443 -> MITM + Apps Script relay (TLS detected)
 *       github.com:22   -> raw-tcp (direct) (non-HTTP, non-TLS client payload)
 *       1.1.1.1:53      -> raw-tcp (direct) (non-HTTP, non-TLS client payload)
 *     A TUN hands an engine EVERY protocol the machine speaks; this one carries two of them.
 *
 * So the mode is not coming back by accident. The two things that can still go wrong are a
 * route quietly reappearing, and — much worse — a machine that HAD the mode switched on being
 * left with the adapter still holding the default route and nothing behind it. The teardown
 * paths are therefore kept, and tested here.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// A scratch home BEFORE anything loads the store: gst-relays.json holds the user's own relays,
// their deployment ids and their Worker keys.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-gst-'));
process.env.MLMVPN_HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const ROOT = path.resolve(__dirname, '..', '..');

// tun-manager is replaced before gst-runtime loads it: the teardown test has to observe that
// `stopTun` was CALLED, and calling the real one would take this machine's route away.
const tunFile = require.resolve(path.join(ROOT, 'tun-manager.js'));
const tunStub = {
    running: true,
    stopped: 0,
    isRunning() { return this.running; },
    stopTun() { this.stopped++; this.running = false; },
    checkPrerequisites() {},
    startTun() { throw new Error('startTun must never be reached: the full tunnel was removed'); },
};
require.cache[tunFile] = { id: tunFile, filename: tunFile, loaded: true, exports: tunStub, children: [], paths: [] };

const store = require(path.join(ROOT, 'gst', 'gst-config'));
const runtime = require(path.join(ROOT, 'gst', 'gst-runtime'));

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

// ── the mode is gone from the backend ────────────────────────────────────────────────────

t('the runtime exposes no way to turn a full tunnel on',
    typeof runtime.setTun !== 'function' && typeof runtime.refreshUplink !== 'function',
    Object.keys(runtime).join(', '));


// ── a machine that had it on must be put back ────────────────────────────────────────────
//
// This is the part that matters after an update. The stored flag and the adapter both survive
// the version that removed the feature, and an adapter holding the default route with no engine
// behind it is a machine with no internet and no visible cause.

(async () => {
    tunStub.running = true;
    tunStub.stopped = 0;
    store.setRuntime({ tun: true, systemProxy: false });

    await runtime.healAfterCrash();
    t('a leftover adapter from the removed mode is torn down on startup', tunStub.stopped === 1,
        'stopTun called ' + tunStub.stopped + ' times');
    t('…and the stored flag is cleared, so nothing reads it as a live mode',
        store.getRuntime().tun === false, JSON.stringify(store.getRuntime()));

    tunStub.running = true;
    tunStub.stopped = 0;
    store.setRuntime({ tun: true });
    await runtime.releaseAll();
    t('stopping the engine also releases a leftover adapter', tunStub.stopped === 1);
    t('…and clears the flag with it', store.getRuntime().tun === false);

    const state = await runtime.getState();
    t('the state the panel reads offers exactly two modes',
        !('tun' in state) && !('tunReady' in state) && 'systemProxy' in state,
        JSON.stringify(state));

    // ── and the route is gone ────────────────────────────────────────────────────────────
    const routes = [];
    const app = {
        get(p) { routes.push('GET ' + p); },
        post(p) { routes.push('POST ' + p); },
        delete(p) { routes.push('DELETE ' + p); },
        put(p) { routes.push('PUT ' + p); },
    };
    try { require(path.join(ROOT, 'gst', 'routes'))(app, {}); } catch (e) { /* only the paths matter */ }
    t('no HTTP route can switch a full tunnel on',
        !routes.some((r) => /mode\/tun/.test(r)),
        routes.filter((r) => /mode/.test(r)).join(' | '));
    t('…while the proxy mode is still routed, which is the mode that works',
        routes.some((r) => r === 'POST /api/gst/mode/sysproxy'),
        routes.filter((r) => /mode/.test(r)).join(' | '));

    // ── report ──────────────────────────────────────────────────────────────────────────
    let failed = 0;
    for (const r of results) {
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* a temp dir is not worth failing over */ }
    process.exit(failed ? 1 : 0);
})();
