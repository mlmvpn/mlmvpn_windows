/*
 * Security, exercised over real sockets by a client that is deliberately hostile.
 *
 * The threat model this defends, stated so the tests are read for what they are:
 *
 *   IN SCOPE      hostile web pages, DNS rebinding, CSRF, accidental browser-origin access —
 *                 attackers who cannot choose their own HTTP headers or host name.
 *
 *   OUT OF SCOPE  a malicious process running as the same Windows user. Not an oversight: the
 *                 pre-existing `POST /api/proxy/system` (server.js:1885) already performs the
 *                 same privileged registry write with no authentication at all, so hardening
 *                 only these routes would imply a protection that does not exist.
 *
 * What DOES hold even against that out-of-scope attacker is the capability model: the request
 * carries no parameters, so the blast radius is bounded to repairs the engine itself offered,
 * with values the engine itself measured. Several cases below are about proving that bound.
 */
const express = require('express');
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-sec-'));
process.env.USERPROFILE = SANDBOX;
process.env.ProgramData = SANDBOX;
os.homedir = () => SANDBOX;

const ROOT = path.resolve(__dirname, '..', '..');
const S = require(ROOT + '/netdiag/session');
const F = require(ROOT + '/netdiag/facts');
const tokens = require(ROOT + '/netdiag/tokens');
const { IDS } = require(ROOT + '/netdiag/rules/ids');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

const STUB = [{
    id: 'stub', wave: 'w0', produces: [IDS.SVC_BFE_RUNNING], timeout: 500,
    async run(ctx) { ctx.put(F.observed(IDS.SVC_BFE_RUNNING, true, { quality: F.QUALITY.REPORTED })); },
}];

const app = express();
app.use(express.json());
const mounted = require(ROOT + '/netdiag/routes')(app, {
    broadcast: () => {},
    collectors: STUB,
    // No ownership resolver and no engine-quiet answer: both default to the fail-safe, which
    // is what a repair attempt below is expected to run into.
});
const TOKEN = mounted.TOKEN;
const srv = app.listen(0, '127.0.0.1', run);

function request(method, urlPath, opt) {
    const o = opt || {};
    const port = srv.address().port;
    const raw = o.raw !== undefined ? o.raw : (o.body === undefined ? null : JSON.stringify(o.body));
    const headers = {};
    headers.Host = o.host === undefined ? `127.0.0.1:${port}` : o.host;
    if (o.origin !== null) headers.Origin = o.origin || `http://127.0.0.1:${port}`;
    if (o.token !== null) headers['X-Netdiag-Token'] = o.token === undefined ? TOKEN : o.token;
    if (o.ctype !== null) headers['Content-Type'] = o.ctype || 'application/json';
    if (raw) headers['Content-Length'] = Buffer.byteLength(raw);
    return new Promise(resolve => {
        const r = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, res => {
            let b = '';
            res.on('data', c => { b += c; });
            res.on('end', () => resolve({ code: res.statusCode, body: b }));
        });
        r.on('error', e => resolve({ code: 0, body: e.message }));
        if (raw) r.write(raw);
        r.end();
    });
}

/** A finished session with one offered repair, seeded directly so no machine state is touched. */
function seedSession(gen) {
    const s = S.createSession({ mode: 'full' });
    s.generation.current = gen || 0;
    s.finishedAtMono = S.monoNow();
    S.putFact(s, F.observed(IDS.SVC_BFE_RUNNING, false, { quality: F.QUALITY.REPORTED }));
    s.offers = [{ repairId: 'svc.start-bfe', tier: 'confirm' }];
    mounted.sessions.set(s.sessionId, s);
    return s;
}

async function run() {
    const port = srv.address().port;

    // ── the repair endpoint's shape ─────────────────────────────────────────────────────
    const s1 = seedSession(0);
    const tok = tokens.issue(s1.sessionId, 'svc.start-bfe', 0, 'confirm');

    let r = await request('POST', '/api/netdiag/repair', { token: null, body: { sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: tok } });
    t('repair without the app token => 401', r.code === 401);
    r = await request('POST', '/api/netdiag/repair', { host: 'evil.example.com', body: { sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: tok } });
    t('repair from a rebinding-shaped request => 403', r.code === 403, JSON.stringify(r));
    r = await request('POST', '/api/netdiag/repair', { origin: 'http://evil.example.com', body: { sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: tok } });
    t('repair from a foreign Origin => 403', r.code === 403);
    r = await request('POST', '/api/netdiag/repair', { ctype: 'text/plain', raw: JSON.stringify({ sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: tok }) });
    t('repair with a non-JSON content-type => 415', r.code === 415);

    // ── injection attempts through every field ──────────────────────────────────────────
    //
    // None of these can reach a shell even in principle — the endpoint takes no parameters
    // that any privileged operation consumes — but they must be REJECTED rather than merely
    // ignored, so that a future field cannot inherit a permissive path.
    const payloads = [
        '; Start-Process calc.exe',
        '`n Remove-Item C:\\ -Recurse',
        '$(whoami)',
        '| Out-File C:\\evil.txt',
        '../../../../windows/system32',
        '\u0000null-byte',
        "' -and (Invoke-Expression 'calc') -and '",
        '<script>alert(1)</script>',
        'svc.start-bfe & shutdown /s',
    ];
    let allRejected = true;
    for (const p of payloads) {
        const a = await request('POST', '/api/netdiag/repair', { body: { sessionId: p, repairId: 'svc.start-bfe', confirmToken: tok } });
        const b = await request('POST', '/api/netdiag/repair', { body: { sessionId: s1.sessionId, repairId: p, confirmToken: tok } });
        const c = await request('POST', '/api/netdiag/repair', { body: { sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: p } });
        if (![a, b, c].every(x => x.code >= 400)) { allRejected = false; break; }
    }
    t('every injection payload, in every field, is rejected', allRejected);

    r = await request('POST', '/api/netdiag/repair', {
        body: { sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: tok, serviceName: 'TrustedInstaller' },
    });
    t('an EXTRA field is rejected rather than ignored — no future field inherits a permissive path',
        r.code === 400 && /unexpected field/.test(r.body), JSON.stringify(r));

    r = await request('POST', '/api/netdiag/repair', {
        body: { sessionId: s1.sessionId, repairId: 'x'.repeat(500), confirmToken: tok },
    });
    t('an oversized field is rejected', r.code === 400);
    r = await request('POST', '/api/netdiag/repair', { body: { sessionId: s1.sessionId, repairId: 12345, confirmToken: tok } });
    t('a non-string field is rejected', r.code === 400);

    // ── the capability bound ────────────────────────────────────────────────────────────
    r = await request('POST', '/api/netdiag/repair', { body: { sessionId: s1.sessionId, repairId: 'winsock.reset', confirmToken: tok } });
    t('a repair that does not exist in the registry => 404', r.code === 404, JSON.stringify(r));

    const s2 = seedSession(0);
    s2.offers = [];      // a finished session that offered nothing
    const tok2 = tokens.issue(s2.sessionId, 'dns.flush', 0, 'auto');
    r = await request('POST', '/api/netdiag/repair', { body: { sessionId: s2.sessionId, repairId: 'dns.flush', confirmToken: tok2 } });
    t('a real repair that was NOT offered for this session => 409',
        r.code === 409 && /not offered/.test(r.body), JSON.stringify(r));

    r = await request('POST', '/api/netdiag/repair', { body: { sessionId: 'f'.repeat(32), repairId: 'dns.flush', confirmToken: tok } });
    t('an unknown session => 404', r.code === 404);

    // ── the confirm token ───────────────────────────────────────────────────────────────
    r = await request('POST', '/api/netdiag/repair', {
        body: { sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: 'a'.repeat(48) },
    });
    t('a forged token => 409', r.code === 409, JSON.stringify(r));

    const s3 = seedSession(0);
    const crossTok = tokens.issue(s3.sessionId, 'svc.start-bfe', 0, 'confirm');
    r = await request('POST', '/api/netdiag/repair', {
        body: { sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: crossTok },
    });
    t('a token issued for a DIFFERENT session is refused', r.code === 409 && /بررسی دیگری/.test(r.body), r.body);

    const wrongRepairTok = tokens.issue(s1.sessionId, 'dns.flush', 0, 'auto');
    r = await request('POST', '/api/netdiag/repair', {
        body: { sessionId: s1.sessionId, repairId: 'svc.start-bfe', confirmToken: wrongRepairTok },
    });
    t('a token issued for a different REPAIR is refused — agreeing to one thing is not agreeing to another',
        r.code === 409 && /کار دیگری/.test(r.body), r.body);

    const s4 = seedSession(3);
    const oldGenTok = tokens.issue(s4.sessionId, 'svc.start-bfe', 2, 'confirm');   // an earlier generation
    r = await request('POST', '/api/netdiag/repair', {
        body: { sessionId: s4.sessionId, repairId: 'svc.start-bfe', confirmToken: oldGenTok },
    });
    t('a token from a PREVIOUS generation is refused — the machine it described is gone',
        r.code === 409 && /تغییر کرده/.test(r.body), r.body);

    // Replay. The first attempt is expected to be refused by the gate (no ownership resolver
    // is wired in this harness), which is itself the point: the token is burned on ATTEMPT.
    const s5 = seedSession(0);
    const replayTok = tokens.issue(s5.sessionId, 'svc.start-bfe', 0, 'confirm');
    const first = await request('POST', '/api/netdiag/repair', {
        body: { sessionId: s5.sessionId, repairId: 'svc.start-bfe', confirmToken: replayTok },
    });
    const second = await request('POST', '/api/netdiag/repair', {
        body: { sessionId: s5.sessionId, repairId: 'svc.start-bfe', confirmToken: replayTok },
    });
    t('a token is single-use: the replay is refused', second.code === 409 && /قبلاً استفاده/.test(second.body),
        `first=${first.code} second=${second.code} ${second.body}`);

    const expTok = tokens.issue(s1.sessionId, 'svc.start-bfe', 0, 'confirm');
    const entry = [...(function* () { yield null; })()];   // no-op, keeps lint quiet
    void entry;
    t('the token TTL is short enough that a machine cannot drift far', tokens.TTL_MS <= 5 * 60 * 1000, String(tokens.TTL_MS));
    t('checking an unknown token does not create one', tokens.check('nope', s1.sessionId, 'svc.start-bfe', 0).valid === false);
    void expTok;

    // ── the gate refuses when its dependencies are absent ───────────────────────────────
    //
    // This harness supplies no ownership resolver and no engine-quiet answer. Both default to
    // the fail-safe, so a well-formed, correctly-tokened request STILL does not change the
    // machine. A missing dependency must never silently authorise a write.
    t('a well-formed request with a valid token still does not apply when ownership cannot be proved',
        first.code === 200 ? /false/.test(first.body) : first.code >= 400,
        `${first.code} ${first.body}`);

    // ── session identifiers ─────────────────────────────────────────────────────────────
    const ids = new Set();
    for (let i = 0; i < 200; i++) ids.add(S.createSession().sessionId);
    t('session ids are unguessable and do not collide',
        ids.size === 200 && [...ids].every(x => /^[0-9a-f]{32}$/.test(x)));
    // The property that actually distinguishes random from time-derived is the ABSENCE of a
    // shared prefix — ids minted milliseconds apart from a clock share most of their leading
    // characters. An earlier version asserted "does not start with 13 digits", which fires by
    // chance on roughly one run in four with 200 hex ids: a flaky test that says nothing.
    const list = [...ids].sort();
    let common = 0;
    while (common < 32 && list.every(x => x[common] === list[0][common])) common++;
    t('...and share no leading prefix, which a timestamp-derived id could never manage',
        common < 4 && ![...ids].some(x => /^nd-/.test(x)), `longest common prefix = ${common}`);

    // ── what leaves the process ─────────────────────────────────────────────────────────
    const red = S.redact(Object.assign(S.createSession(), {
        app: {
            uuid: '11111111-2222-3333-4444-555555555555',
            token: 'abcdef',
            pacUrl: 'http://alice:s3cret@proxy.corp/proxy.pac',
            password: 'hunter2',
        },
    }));
    const blob = JSON.stringify(red);
    t('the redaction deny-list holds: no config uuid, key, token or embedded credential survives',
        !/11111111-2222/.test(blob) && !/hunter2/.test(blob) && !/s3cret/.test(blob) && !/abcdef/.test(blob),
        blob.slice(0, 200));

    // ── PowerShell invocation ───────────────────────────────────────────────────────────
    const ps = require(ROOT + '/netdiag/ps');
    t('PowerShell always runs with -NoProfile and -NonInteractive',
        ps.PS_ARGS.includes('-NoProfile') && ps.PS_ARGS.includes('-NonInteractive'));
    t('scripts are fed over stdin, so there is no argv string to inject into and no temp file to plant',
        ps.PS_ARGS[ps.PS_ARGS.length - 2] === '-Command' && ps.PS_ARGS[ps.PS_ARGS.length - 1] === '-');

    // The structural guarantee: no repair reads a value out of an HTTP request.
    const repairSrc = fs.readdirSync(path.join(ROOT, 'netdiag', 'repairs'))
        .filter(f => f.endsWith('.js'))
        .map(f => fs.readFileSync(path.join(ROOT, 'netdiag', 'repairs', f), 'utf8')).join('\n');
    t('no repair module ever reads req/body/query — every value comes from server-side state',
        !/\breq\b|\.body\b|\.query\b|\.params\b/.test(repairSrc));
    t('no repair builds a PowerShell command by concatenating an incoming value',
        !/\+\s*(req|body|input|userValue)/.test(repairSrc));

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
