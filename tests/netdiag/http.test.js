/*
 * The HTTP contract, exercised over real sockets by an independent client.
 *
 * The requests below are built by hand with Node's http module — headers set explicitly, one
 * at a time — rather than through any helper netdiag ships. A guard tested through a client
 * that shares its assumptions is not tested at all: the whole point of the Host check is that
 * it rejects a header a normal client would never send, so the client here has to be able to
 * send it.
 *
 * The wave set is stubbed. These cases are about the guards and the session lifecycle, and
 * pulling real collectors in would make an offline suite wait on real sockets — the live
 * engine is validated separately in validate.js, against the real machine.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-http-'));
process.env.USERPROFILE = SANDBOX;
os.homedir = () => SANDBOX;

const ROOT = path.resolve(__dirname, '..', '..');
const F = require(ROOT + '/netdiag/facts');
const { IDS } = require(ROOT + '/netdiag/rules/ids');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

/** A stub wave: writes a handful of facts instantly, touches nothing. */
const STUB = [{
    id: 'stub.inventory', wave: 'w0', label: 'stub', network: false, timeout: 1000,
    produces: [IDS.SVC_BFE_RUNNING, IDS.FW_OUTBOUND_BLOCK, IDS.ROUTE_TABLE_READABLE,
        IDS.PROXY_WININET_ENABLED, IDS.REACH_GATEWAY_V4, IDS.REACH_FOREIGN_V4],
    async run(ctx) {
        ctx.put(F.observed(IDS.SVC_BFE_RUNNING, true, { quality: F.QUALITY.REPORTED }));
        ctx.put(F.observed(IDS.FW_OUTBOUND_BLOCK, false, { quality: F.QUALITY.REPORTED }));
        ctx.put(F.observed(IDS.ROUTE_TABLE_READABLE, true, { quality: F.QUALITY.REPORTED }));
        ctx.put(F.observed(IDS.PROXY_WININET_ENABLED, false, { quality: F.QUALITY.REPORTED }));
        ctx.put(F.observed(IDS.REACH_GATEWAY_V4, 'ok', { quality: F.QUALITY.MEASURED }));
        ctx.put(F.observed(IDS.REACH_FOREIGN_V4, 'ok', { quality: F.QUALITY.MEASURED }));
    },
}];

const app = express();
app.use(express.json());
const mounted = require(ROOT + '/netdiag/routes')(app, { broadcast: () => {}, collectors: STUB });
const TOKEN = mounted.TOKEN;

const srv = app.listen(0, '127.0.0.1', run);

function request(method, urlPath, opt) {
    const o = opt || {};
    const port = srv.address().port;
    const data = o.body === undefined ? null : JSON.stringify(o.body);
    const headers = {};
    // `host: null` means "send a deliberately wrong Host", which is what a rebound page does.
    headers.Host = o.host === undefined ? `127.0.0.1:${port}` : o.host;
    // A browser always sends Origin on a non-GET fetch, so the client mimics that by default;
    // 'origin: null' is how a case opts into the no-Origin path deliberately.
    if (o.origin !== null) headers.Origin = o.origin || `http://127.0.0.1:${port}`;
    if (o.token !== null) headers['X-Netdiag-Token'] = o.token === undefined ? TOKEN : o.token;
    if (o.ctype !== null) headers['Content-Type'] = o.ctype || 'application/json';
    if (data) headers['Content-Length'] = Buffer.byteLength(data);
    return new Promise(resolve => {
        const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
            let b = '';
            res.on('data', c => { b += c; });
            res.on('end', () => resolve({ code: res.statusCode, body: b }));
        });
        r.on('error', e => resolve({ code: 0, body: e.message }));
        if (data) r.write(data);
        r.end();
    });
}

async function run() {
    const port = srv.address().port;

    // ── the guards ──────────────────────────────────────────────────────────────────────
    t('no token => 401', (await request('POST', '/api/netdiag/start', { token: null, body: {} })).code === 401);
    t('wrong token => 401', (await request('POST', '/api/netdiag/start', { token: 'f'.repeat(48), body: {} })).code === 401);

    // The anti-rebinding control. A page that rebinds DNS to 127.0.0.1 reaches this socket but
    // still names itself in Host — the token would not stop it, because the same page can read
    // the token from the unauthenticated GET /.
    let r = await request('POST', '/api/netdiag/start', { host: 'evil.example.com', body: {} });
    t('rebinding-shaped request (valid token, foreign Host) => 403', r.code === 403, JSON.stringify(r));
    r = await request('POST', '/api/netdiag/start', { host: `127.0.0.1:${port + 1}`, body: {} });
    t('right hostname but wrong port in Host => 403', r.code === 403, JSON.stringify(r));

    r = await request('POST', '/api/netdiag/start', { origin: 'http://evil.example.com', body: {} });
    t('foreign Origin => 403', r.code === 403, JSON.stringify(r));
    r = await request('POST', '/api/netdiag/start', { origin: `http://127.0.0.1:${port}`, body: {} });
    t('own Origin is accepted', r.code === 200, JSON.stringify(r).slice(0, 120));

    r = await request('POST', '/api/netdiag/start', { origin: null, body: {} });
    t('a state-changing request with NO Origin at all => 403 (absence is not a free pass)',
        r.code === 403, JSON.stringify(r));

    r = await request('POST', '/api/netdiag/start', { ctype: 'text/plain', body: {} });
    t('non-JSON content-type on a state-changing route => 415', r.code === 415, JSON.stringify(r));

    r = await request('POST', '/api/netdiag/cancel', { body: { sessionId: 'no-such-session' } });
    t('cancelling an unknown session => 404', r.code === 404);
    t('unknown session id => 404', (await request('GET', '/api/netdiag/session/deadbeef')).code === 404);

    // ── the lifecycle ───────────────────────────────────────────────────────────────────
    const start = await request('POST', '/api/netdiag/start', { body: { mode: 'quick' } });
    const started = JSON.parse(start.body);
    t('start returns an unguessable session id, not a timestamp',
        start.code === 200 && /^[0-9a-f]{32}$/.test(started.sessionId), start.body.slice(0, 140));

    // The run continues after the response — a 35s request would hit every client timeout
    // between here and the renderer.
    for (let i = 0; i < 40; i++) {
        const s = JSON.parse((await request('GET', `/api/netdiag/session/${started.sessionId}`)).body);
        if (s.done) break;
        await new Promise(x => setTimeout(x, 100));
    }
    const got = await request('GET', `/api/netdiag/session/${started.sessionId}`);
    const j = JSON.parse(got.body);
    t('the finished session is returned with a narrative', got.code === 200 && j.done === true && !!j.narrative,
        `code=${got.code} done=${j.done}`);
    t('the narrative carries the four buckets',
        j.narrative && ['rootCauses', 'consequences', 'independent', 'unresolved'].every(k => Array.isArray(j.narrative[k])));
    t('facts are exposed on the authenticated route', Object.keys(j.session.facts || {}).length >= 6,
        String(Object.keys(j.session.facts || {}).length));
    t('history lists it',
        JSON.parse((await request('GET', '/api/netdiag/history')).body).sessions.some(s => s.sessionId === started.sessionId));

    // ── what must never leave over the shared socket ────────────────────────────────────
    //
    // /ws accepts any Origin (server.js:36), so a progress event is readable by any local
    // process. Adapter names, addresses, resolvers and proxy endpoints stay on the REST route.
    const events = [];
    const app2 = express();
    app2.use(express.json());
    const m2 = require(ROOT + '/netdiag/routes');
    delete require.cache[require.resolve(ROOT + '/netdiag/routes')];
    const fresh = require(ROOT + '/netdiag/routes')(app2, {
        broadcast: (type, data) => events.push({ type, data }), collectors: STUB,
    });
    const srv2 = app2.listen(0, '127.0.0.1');
    await new Promise(res => srv2.once('listening', res));
    const p2 = srv2.address().port;
    await new Promise(resolve => {
        const body = JSON.stringify({ mode: 'quick' });
        const rq = http.request({
            host: '127.0.0.1', port: p2, path: '/api/netdiag/start', method: 'POST',
            headers: { Host: `127.0.0.1:${p2}`, Origin: `http://127.0.0.1:${p2}`, 'Content-Type': 'application/json',
                'X-Netdiag-Token': fresh.TOKEN, 'Content-Length': Buffer.byteLength(body) },
        }, res => { res.resume(); res.on('end', resolve); });
        rq.end(body);
    });
    await new Promise(x => setTimeout(x, 1500));
    t('progress events were emitted', events.length > 0, String(events.length));
    const payloadKeys = new Set(events.flatMap(e => Object.keys(e.data)));
    t('a progress event carries only sessionId/phase/percent/collectorId',
        [...payloadKeys].every(k => ['sessionId', 'phase', 'percent', 'collectorId'].includes(k)),
        [...payloadKeys].join(','));
    const blob = JSON.stringify(events);
    t('no fact, address, adapter name or resolver appears in any progress event',
        !/facts|192\.168|127\.0\.0\.1|Wi-Fi|InterfaceGuid|ServerAddresses/i.test(blob),
        blob.slice(0, 160));
    srv2.close();

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    srv.close();
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    process.exit(failed ? 1 : 0);
}
