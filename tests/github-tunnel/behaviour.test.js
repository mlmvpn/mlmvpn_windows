// GitHub Tunnel — behavioural checks against the real modules.
//
// USERPROFILE is redirected to a throwaway directory before anything is required, so every
// module's ~/.mlmvpn lands in the sandbox and the developer's real state is never read or
// written. Network is stubbed at global.fetch, so nothing leaves the machine.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SANDBOX = path.join(__dirname, 'home');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
// Off unless a test opts in: see "the app's own engine" below and run.js.
process.env.MLMVPN_GT_LOCAL_ENGINE_PORT = '0';
assert.strictEqual(os.homedir(), SANDBOX, 'sandbox homedir not in effect — refusing to touch the real one');

const GT = ROOT + '/github-tunnel';
const results = [];
function t(name, fn) {
    try { const d = fn(); results.push({ name, pass: true, detail: d || '' }); }
    catch (e) { results.push({ name, pass: false, detail: e.message }); }
}
const pending = [];
function ta(name, fn) { pending.push([name, fn]); }
async function runPending() {
    for (const [name, fn] of pending) {
        try { const d = await fn(); results.push({ name, pass: true, detail: d || '' }); }
        catch (e) { results.push({ name, pass: false, detail: e.message }); }
    }
}

// ── 1. client/worker signature parity ────────────────────────────────────────────
const secretMod = require(`${GT}/gt-secret`);
t('install secret is created once and is 256-bit', () => {
    const a = secretMod.getInstallSecret();
    const b = secretMod.getInstallSecret();
    assert.strictEqual(a, b);
    assert.strictEqual(a.length, 64);
    assert.ok(fs.existsSync(path.join(SANDBOX, '.mlmvpn', 'github-tunnel-broker.json')));
    return `${a.slice(0, 8)}…`;
});

// ── 2. the guard's crash record ──────────────────────────────────────────────────
const guard = require(`${GT}/gt-guard`);
t('guard state file is absent before anything engages', () => {
    assert.ok(!fs.existsSync(guard.STATE_FILE));
});

// ── 3. session store lifecycle ───────────────────────────────────────────────────
const store = require(`${GT}/gt-config`);
t('a fresh session is not active until it has a deadline', () => {
    const s = store.addSession({ repository: 'u/r', status: 'SETTING_UP' });
    assert.strictEqual(store.getActiveSession(), null, 'SETTING_UP must not count as active');
    store.updateSession(s.id, { status: 'READY', expiresAt: Date.now() + 60000, tailscaleIp: '100.1.2.3' });
    assert.ok(store.getActiveSession(), 'READY with a future deadline must be active');
    return s.id;
});
t('an expired deadline is never reported active', () => {
    const s = store.getActiveSession();
    store.updateSession(s.id, { expiresAt: Date.now() - 1000 });
    assert.strictEqual(store.getActiveSession(), null);
});
t('session history is capped so the store cannot grow forever', () => {
    for (let i = 0; i < 30; i++) store.addSession({ repository: 'u/r' });
    assert.ok(store.getSessions().length <= 20, `got ${store.getSessions().length}`);
    return `${store.getSessions().length} kept`;
});

// ── 4. deployer state machine ────────────────────────────────────────────────────
const deployer = require(`${GT}/gt-deployer`);
t('tick: READY -> ACTIVE -> EXPIRING_SOON -> EXPIRED', () => {
    const s = store.addSession({ repository: 'u/r', status: 'READY' });
    let cur = store.updateSession(s.id, { expiresAt: Date.now() + 60 * 60 * 1000 });
    cur = deployer.tick(cur);
    assert.strictEqual(cur.status, 'ACTIVE', 'plenty of time left');
    cur = deployer.tick(store.updateSession(s.id, { expiresAt: Date.now() + 5 * 60 * 1000 }));
    assert.strictEqual(cur.status, 'EXPIRING_SOON', 'under ten minutes');
    cur = deployer.tick(store.updateSession(s.id, { expiresAt: Date.now() - 1 }));
    assert.strictEqual(cur.status, 'EXPIRED', 'past the deadline');
});
t('the RDP-password code path is gone from the deployer surface', () => {
    assert.strictEqual(typeof deployer.launchTunnel, 'undefined');
    assert.strictEqual(typeof deployer.buildRdpFileContent, 'undefined');
});

// ── 5. dispatchWorkflow identifies its OWN run, on a skewed clock ────────────────
// This is the regression that mattered: the old code matched runs by comparing GitHub's
// created_at against the LOCAL wall clock.
const github = require(`${GT}/gt-github`);
// gt-github holds no credential of its own any more — the token is passed per call.

function stubGitHub({ existingRuns, newRun }) {
    let dispatched = false;
    global.fetch = async (url, opts = {}) => {
        const u = String(url);
        const reply = (obj, status = 200) => new Response(JSON.stringify(obj), {
            status, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() },
        });
        // 204 must carry a null body, which is what GitHub actually answers a dispatch with.
        if (u.includes('/dispatches')) {
            dispatched = true;
            return new Response(null, { status: 204, headers: { Date: new Date().toUTCString() } });
        }
        if (u.includes('/runs?')) {
            return reply({ workflow_runs: dispatched ? [newRun, ...existingRuns] : existingRuns });
        }
        return reply({}, 404);
    };
    return () => dispatched;
}

const OLD_RUN = { id: 1000, created_at: '2026-08-16T09:00:00Z', status: 'completed', conclusion: 'success' };
const NEW_RUN = { id: 1001, created_at: '2026-08-16T10:00:00Z', status: 'queued' };

ta('dispatch picks the new run when the local clock is CORRECT', async () => {
    stubGitHub({ existingRuns: [OLD_RUN], newRun: NEW_RUN });
    const id = await github.dispatchWorkflow('tok_test', 'u/r', 'main', { session_id: 'S' });
    assert.strictEqual(id, 1001);
});

ta('dispatch picks the new run when the local clock is 2h BEHIND (used to adopt the old run)', async () => {
    stubGitHub({ existingRuns: [OLD_RUN], newRun: NEW_RUN });
    const realNow = Date.now;
    Date.now = () => realNow() - 2 * 60 * 60 * 1000;
    try {
        const id = await github.dispatchWorkflow('tok_test', 'u/r', 'main', { session_id: 'S' });
        assert.strictEqual(id, 1001, 'must not adopt the previous session run');
    } finally { Date.now = realNow; }
});

ta('dispatch picks the new run when the local clock is 2h AHEAD (used to time out)', async () => {
    stubGitHub({ existingRuns: [OLD_RUN], newRun: NEW_RUN });
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60 * 60 * 1000;
    try {
        const id = await github.dispatchWorkflow('tok_test', 'u/r', 'main', { session_id: 'S' });
        assert.strictEqual(id, 1001, 'must not report "did not start in time"');
    } finally { Date.now = realNow; }
});

ta('dispatch works on a repo whose workflow has never run', async () => {
    stubGitHub({ existingRuns: [], newRun: { id: 7, created_at: '2026-08-16T10:00:00Z', status: 'queued' } });
    const id = await github.dispatchWorkflow('tok_test', 'u/r', 'main', { session_id: 'S' });
    assert.strictEqual(id, 7);
});

// ── 6. the fallback proxy must not be read as a dead GitHub token ────────────────
const { gtFetch } = require(`${GT}/gt-net`);
ta('a 401 that arrived over the fallback is tagged, not blamed on the user', async () => {
    let call = 0;
    global.fetch = async (url) => {
        call++;
        if (!String(url).includes('mlm-proxy')) throw new Error('fetch failed');
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 });
    };
    const res = await gtFetch('https://api.github.com/user');
    assert.strictEqual(res.viaFallback, true, 'fallback responses must be marked');
    assert.strictEqual(res.status, 401);
    assert.ok(call >= 2, 'direct attempt must be tried first');
});

// ── 6b. a sanctions 403 must fall through, an API 403 must not ───────────────────
//
// The engine download died at "(403)" for every user on an unaided Iranian connection:
// pkgs.tailscale.com's CDN refuses the region with a well-formed 403, fetch() resolves, and
// gtFetch returned it as an answer — so neither fallback was ever tried, though the edge
// proxy could fetch the file fine. A FRESH copy of the module, because the test above
// leaves directFailedUntil armed and the direct attempt must actually run here.
delete require.cache[require.resolve(`${GT}/gt-net`)];
const { gtFetch: gtFetchIsolated } = require(`${GT}/gt-net`);

ta('a 403 from a sanctioned host falls through to the edge proxy', async () => {
    let direct = 0, viaProxy = 0;
    global.fetch = async (url) => {
        if (String(url).includes('mlm-proxy')) { viaProxy++; return new Response('MSI', { status: 200 }); }
        direct++;
        return new Response('Access Denied', { status: 403 });
    };
    const res = await gtFetchIsolated('https://pkgs.tailscale.com/x.msi', { fallbackOnStatus: [403, 451] });
    assert.strictEqual(direct, 1, 'direct must still be tried first');
    assert.ok(viaProxy >= 1, 'a refused 403 must reach the fallback');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.viaFallback, true);
    return await res.text();
});

ta('a 403 WITHOUT fallbackOnStatus still reaches the caller untouched', async () => {
    let viaProxy = 0;
    global.fetch = async (url) => {
        if (String(url).includes('mlm-proxy')) { viaProxy++; return new Response('{}', { status: 200 }); }
        return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403 });
    };
    // gt-deployer and gt-allocator read this exact status to tell the user their token is
    // missing the workflow scope. Rerouting it through a proxy would lose that answer.
    const res = await gtFetchIsolated('https://api.github.com/repos/u/r/dispatches');
    assert.strictEqual(res.status, 403, 'an API 403 is a real answer and must be returned');
    assert.strictEqual(viaProxy, 0, 'the fallback must NOT be used for an unflagged 403');
});

ta("when every path is refused, the origin's 403 is what the caller sees", async () => {
    global.fetch = async (url) => {
        if (String(url).includes('mlm-proxy')) throw new Error('fetch failed');
        return new Response('Access Denied', { status: 403 });
    };
    const res = await gtFetchIsolated('https://pkgs.tailscale.com/x.msi', { fallbackOnStatus: [403, 451] });
    assert.strictEqual(res.status, 403, 'must report the geo-block, not the proxy transport error');
});

// ── 6c. the edge proxy went dark; its failure must never pose as the host's answer ─
//
// 2026-09-11: mlm-proxy.vercel.app answers every request with 402 DEPLOYMENT_DISABLED (and
// Vercel is unreachable from Iran). gtFetch returned that 402 to callers as if GitHub or
// Cloudflare had said it. Fresh module copies: each test needs the direct attempt to run.
function freshNet(port) {
    delete require.cache[require.resolve(`${GT}/gt-net`)];
    process.env.MLMVPN_GT_LOCAL_ENGINE_PORT = String(port || 0);
    const mod = require(`${GT}/gt-net`);
    process.env.MLMVPN_GT_LOCAL_ENGINE_PORT = '0';
    return mod;
}
const deadEdge = () => new Response('Payment required', { status: 402, headers: { 'x-vercel-error': 'DEPLOYMENT_DISABLED' } });

ta('a disabled edge proxy is reported as "no path worked", not as a 402 from the host', async () => {
    const { gtFetch: f } = freshNet(0);
    global.fetch = async (url) => {
        if (String(url).includes('mlm-proxy')) return deadEdge();
        throw new Error('fetch failed');
    };
    let err = null;
    try { await f('https://api.github.com/user', { timeoutMs: 1000 }); } catch (e) { err = e; }
    assert.ok(err, 'must not resolve with the proxy platform error');
    assert.ok(/موتورها/.test(err.message), 'the message must say what to do: connect an engine');
});

ta("with a sanctioned 403 and a dead edge proxy, the origin's 403 is what the caller sees", async () => {
    const { gtFetch: f } = freshNet(0);
    global.fetch = async (url) => {
        if (String(url).includes('mlm-proxy')) return deadEdge();
        return new Response('Access Denied', { status: 403 });
    };
    const res = await f('https://pkgs.tailscale.com/x.msi', { fallbackOnStatus: [403, 451] });
    assert.strictEqual(res.status, 403);
});

ta("the app's own connected engine carries the call before the edge proxy", async () => {
    const net = require('net');
    const srv = net.createServer((c) => c.destroy());
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
        const { gtFetch: f } = freshNet(srv.address().port);
        let local = 0, edge = 0;
        global.fetch = async (url, opts) => {
            if (String(url).includes('mlm-proxy')) { edge++; return new Response('{}', { status: 200 }); }
            if (opts && opts.dispatcher) { local++; return new Response('{"ok":true}', { status: 200 }); }
            throw new Error('fetch failed');
        };
        const res = await f('https://api.cloudflare.com/client/v4/user', { timeoutMs: 1000 });
        assert.strictEqual(local, 1, 'the local engine must be tried');
        assert.strictEqual(edge, 0, 'the edge proxy must not be needed');
        assert.strictEqual(res.viaLocalEngine, true, 'local-engine responses must be marked');
    } finally {
        srv.close();
    }
});

t('the engine flags its Tailscale hosts and nothing else', () => {
    const src = fs.readFileSync(`${GT}/gt-engine.js`, 'utf8');
    const flagged = src.match(/fallbackOnStatus: BLOCKED_STATUSES/g) || [];
    assert.strictEqual(flagged.length, 2, 'both tailscale.com fetches must carry it');
    assert.ok(/const BLOCKED_STATUSES = \[403, 451\]/.test(src), 'the status list must stay pinned');
    for (const f of ['gt-github.js', 'gt-deployer.js', 'gt-allocator.js', 'gt-broker.js']) {
        assert.ok(!/fallbackOnStatus/.test(fs.readFileSync(`${GT}/${f}`, 'utf8')),
            `${f} must never reroute a 403 — it reads that status as an answer`);
    }
    return `${flagged.length} call sites`;
});

// ── 7. workflow template invariants ──────────────────────────────────────────────
const wf = require(`${GT}/gt-workflow-template`);
t('the promised window always ends BEFORE the machine does', () => {
    assert.ok(wf.USABLE_SESSION_MINUTES < wf.KEEP_ALIVE_MINUTES, 'countdown must run out first');
    assert.ok(wf.KEEP_ALIVE_MINUTES < wf.SESSION_LIFETIME_MINUTES, 'keep-alive must end before GitHub kills the job');
    assert.ok(wf.SESSION_LIFETIME_MINUTES < 360, 'must stay under GitHub 6h cap');
    return `${wf.SESSION_LIFETIME_MINUTES}/${wf.KEEP_ALIVE_MINUTES}/${wf.USABLE_SESSION_MINUTES}`;
});
t('the workflow never prints the session password into the log', () => {
    const y = wf.buildWorkflowYaml();
    assert.ok(!/Write-Output\s+"?\$password/.test(y));
    assert.ok(!/Write-Host.*\$password/.test(y));
    assert.ok(y.includes('details withheld from the log'));
});

// ── 8. the MSI pin ───────────────────────────────────────────────────────────────
t('gt-engine pins a sha256 for the binary it executes as admin', () => {
    const src = fs.readFileSync(`${GT}/gt-engine.js`, 'utf8');
    const m = src.match(/const MSI_SHA256 = '([0-9a-f]{64})'/);
    assert.ok(m, 'no pinned digest found');
    assert.ok(/digest !== MSI_SHA256/.test(src), 'digest is pinned but never compared');
    assert.ok(src.indexOf("const digest = crypto.createHash('sha256')") < src.indexOf('msiexec.exe'),
        'the digest must be checked before msiexec runs');
    return m[1].slice(0, 12) + '…';
});

// ── 9. a fresh Windows needs no download ────────────────────────────────────────
//
// Reported 2026-09-11: on a new machine «تونل گیت‌هاب» stopped at «دانلود موتور اتصال رد شد
// (۴۰۳)» — pkgs.tailscale.com refuses Iran and the edge proxy is gone. The engine now ships in
// core/tailscale/ and is installed from there; the download path must not even be touched.
t('the bundled engine files are the ones gt-engine pins', () => {
    const src = fs.readFileSync(`${GT}/gt-engine.js`, 'utf8');
    const crypto = require('crypto');
    const names = ['tailscaled.exe', 'tailscale.exe', 'wintun.dll'];
    for (const n of names) {
        const m = src.match(new RegExp("'" + n.replace('.', '\\.') + "': '([0-9a-f]{64})'"));
        assert.ok(m, 'no pinned digest for ' + n);
        const file = path.join(ROOT, 'core', 'tailscale', n);
        assert.ok(fs.existsSync(file), 'core/tailscale/' + n + ' must ship with the app');
        const got = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
        assert.strictEqual(got, m[1], n + ' does not match its pin — bump both together');
    }
    return names.length + ' files';
});

ta('ensureBinaries installs the bundled engine without any network call', async () => {
    delete require.cache[require.resolve(`${GT}/gt-net`)];
    delete require.cache[require.resolve(`${GT}/gt-engine`)];
    const engine = require(`${GT}/gt-engine`);
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('fetch failed'); };
    assert.strictEqual(engine.binariesReady(), false, 'the sandbox must start without binaries');
    const lines = [];
    await engine.ensureBinaries((m) => lines.push(m));
    assert.strictEqual(calls, 0, 'no download may be attempted when the app carries the engine');
    assert.strictEqual(engine.binariesReady(), true);
    assert.ok(engine.DAEMON_EXE.startsWith(SANDBOX), 'must install into the (sandboxed) user profile');
    return lines.join(' | ');
});

// ── report ───────────────────────────────────────────────────────────────────────
runPending().then(() => {
    let failed = 0;
    for (const r of results) {
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `   (${r.detail})` : ''}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
});
