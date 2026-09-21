// Boots the REAL GitHub Tunnel routes on a throwaway express app and exercises every
// read-only endpoint plus the transition paths that are safe to run with no session.
//
// USERPROFILE is redirected first, so this reads and writes a sandbox ~/.mlmvpn and never
// the developer's own GitHub token, broker deployment or sessions. Nothing here can engage
// the firewall or start a daemon: with no active session, bringUp() refuses before it
// touches anything machine-wide.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SANDBOX = path.join(__dirname, 'home-routes');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX);

process.chdir(ROOT);
const express = require(ROOT + '/node_modules/express');

const logs = [];
const app = express();
app.use(express.json());
require(ROOT + '/github-tunnel/routes')(app, {
    broadcastLog: (m) => logs.push(m),
    broadcast: () => {},
    readSystemProxy: () => ({ enabled: false, server: '' }),
});

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const server = app.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
    const post = async (p, b) => {
        const r = await fetch(base + p, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}),
        });
        return { status: r.status, body: await r.json() };
    };

    try {
        // ── read-only surface ────────────────────────────────────────────────────
        const gh = await get('/api/github-tunnel/github/status');
        t('GET github/status responds on a clean install', gh.status === 200 && gh.body.connected === false,
            JSON.stringify(gh.body));

        const eng = await get('/api/github-tunnel/engine/status');
        t('GET engine/status responds', eng.status === 200, JSON.stringify(eng.body).slice(0, 160));
        t('nothing is connected, running or engaged on a clean install',
            eng.body.engine.connected === false && eng.body.engine.running === false
            && eng.body.killSwitch.engaged === false);
        t('engine/status now reports server-side busy', typeof eng.body.busy === 'boolean');
        t('engine/status now reports whether the kill-switch can apply',
            typeof eng.body.killSwitch.applicable === 'boolean');

        const st = await get('/api/github-tunnel/status');
        t('GET status responds with no session', st.status === 200 && st.body.session === null);

        const br = await get('/api/github-tunnel/broker/status');
        t('GET broker/status exposes the redeploy flag', br.status === 200 && 'needsRedeploy' in br.body,
            JSON.stringify(br.body));
        t('a never-deployed broker does not ask to be redeployed', br.body.needsRedeploy === false);

        const sess = await get('/api/github-tunnel/sessions');
        t('GET sessions responds', sess.status === 200 && Array.isArray(sess.body.sessions));

        // ── transitions that must refuse rather than half-run ────────────────────
        const conn = await post('/api/github-tunnel/connect');
        t('connect with no session refuses, and says so in Persian',
            conn.status === 500 && /نشست ابری فعالی/.test(conn.body.error), JSON.stringify(conn.body));

        const tunOn = await post('/api/github-tunnel/tun', { enabled: true });
        t('tun-on with no session refuses', tunOn.status === 500);

        // ── teardown paths are always safe, even from a cold start ───────────────
        const dis = await post('/api/github-tunnel/disconnect');
        t('disconnect from a cold start succeeds instead of throwing', dis.status === 200 && dis.body.ok === true,
            JSON.stringify(dis.body));

        const tunOff = await post('/api/github-tunnel/tun', { enabled: false });
        t('tun-off from a cold start succeeds', tunOff.status === 200 && tunOff.body.running === false);

        const pxOff = await post('/api/github-tunnel/proxy', { enabled: false });
        t('proxy-off from a cold start succeeds', pxOff.status === 200 && pxOff.body.enabled === false);

        // ── kill-switch toggle ───────────────────────────────────────────────────
        const ksOff = await post('/api/github-tunnel/killswitch', { enabled: false });
        t('kill-switch can be turned off with nothing running',
            ksOff.status === 200 && ksOff.body.enabled === false && ksOff.body.engaged === false);
        const ksOn = await post('/api/github-tunnel/killswitch', { enabled: true });
        t('kill-switch can be turned back on', ksOn.status === 200 && ksOn.body.enabled === true);
        t('turning the kill-switch ON with nothing connected does NOT engage the firewall',
            ksOn.body.engaged === false, JSON.stringify(ksOn.body));

        // ── serialisation: ten simultaneous transitions must not interleave ──────
        const before = Date.now();
        const many = await Promise.all([
            post('/api/github-tunnel/disconnect'), post('/api/github-tunnel/connect'),
            post('/api/github-tunnel/disconnect'), post('/api/github-tunnel/tun', { enabled: false }),
            post('/api/github-tunnel/proxy', { enabled: false }), post('/api/github-tunnel/disconnect'),
            post('/api/github-tunnel/connect'), post('/api/github-tunnel/tun', { enabled: true }),
            post('/api/github-tunnel/disconnect'), post('/api/github-tunnel/proxy', { enabled: true }),
        ]);
        t('a burst of ten concurrent transitions all settle, none hang',
            many.length === 10 && many.every(r => r.status === 200 || r.status === 500),
            `${Date.now() - before}ms; statuses ${many.map(r => r.status).join(',')}`);
        const after = await get('/api/github-tunnel/engine/status');
        t('the machine is left in a clean state after the burst',
            after.body.engine.connected === false && after.body.killSwitch.engaged === false
            && after.body.systemProxy.enabled === false,
            JSON.stringify(after.body.engine));

        // ── startup self-heal actually ran ───────────────────────────────────────
        t('routes registered and logged', logs.some(l => /routes registered/.test(l)), logs.slice(-3).join(' // '));

        // ── broker url setter ────────────────────────────────────────────────────
        const url1 = await post('/api/github-tunnel/broker/url', { url: 'https://relay.example.com/' });
        t('a custom relay URL is stored without its trailing slash',
            url1.status === 200 && url1.body.customUrl === 'https://relay.example.com', JSON.stringify(url1.body));
        const br2 = await get('/api/github-tunnel/broker/status');
        t('the custom URL becomes the effective one', br2.body.effectiveUrl === 'https://relay.example.com');
        await post('/api/github-tunnel/broker/url', { url: '' });
    } catch (e) {
        t('suite ran to completion', false, e.stack);
    }

    let failed = 0;
    for (const r of results) {
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : `   -> ${r.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    server.close();
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
});
