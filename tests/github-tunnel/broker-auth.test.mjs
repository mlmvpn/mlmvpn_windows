// End-to-end check of the broker Worker's request authentication, driving the REAL
// worker.js default export with a fake env and real Request/Response objects, and signing
// exactly the way the desktop client does.
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// worker.js is an ES module, but the project's package.json declares "type": "commonjs",
// so Node would load it as CJS and fail on `export default`. Copying it to a .mjs outside
// the project is enough, and leaves the shipped tree alone — the file is uploaded to
// Cloudflare as text, so it must not gain a package.json of its own just to be testable.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'cloudflare-worker', 'gt-broker', 'worker.js');
const COPY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gt-worker-')), 'worker.mjs');
fs.copyFileSync(SRC, COPY);
const { default: worker } = await import(pathToFileURL(COPY).href);

const SECRET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

// Same string the client builds in github-tunnel/gt-secret.js.
const sign = (secret, sessionId, ts) =>
    createHmac('sha256', secret).update(`${sessionId}.${ts}`).digest('hex');

let tsCalls = 0;
globalThis.fetch = async (url) => {
    tsCalls++;
    if (String(url).includes('/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 });
    }
    return new Response(JSON.stringify({ key: 'tskey-FAKE', expires: '2030-01-01T00:00:00Z' }), { status: 200 });
};

const env = {
    TS_OAUTH_CLIENT_ID: 'id', TS_OAUTH_CLIENT_SECRET: 'sec', TS_TAILNET: '-',
    GT_SIGNING_SECRET: SECRET,
};

const post = (path, body, e = env) => worker.fetch(
    new Request(`https://broker.test${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }), e);

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass, detail }); };

// 1. a correctly signed request mints a key
{
    const ts = Date.now();
    const res = await post('/mint', { sessionId: 'GT-2026-ABCD', ts, sig: sign(SECRET, 'GT-2026-ABCD', ts) });
    const body = await res.json();
    check('signed /mint succeeds', res.status === 200 && body.key === 'tskey-FAKE', `${res.status} ${JSON.stringify(body)}`);
}

// 2. THE HOLE THAT USED TO BE OPEN: no signature at all
{
    tsCalls = 0;
    const res = await post('/mint', { sessionId: 'GT-2026-ABCD', ts: Date.now() });
    const body = await res.json();
    check('unsigned /mint rejected', res.status === 401 && body.code === 'BAD_SIG', `${res.status} ${JSON.stringify(body)}`);
    check('unsigned /mint never reaches Tailscale', tsCalls === 0, `tailscale calls: ${tsCalls}`);
}

// 3. signature computed under a different install secret
{
    const ts = Date.now();
    const res = await post('/mint', { sessionId: 'GT-2026-ABCD', ts, sig: sign(OTHER, 'GT-2026-ABCD', ts) });
    const body = await res.json();
    check('wrong-secret signature rejected', res.status === 401 && body.code === 'BAD_SIG', `${res.status} ${JSON.stringify(body)}`);
}

// 4. a valid signature replayed for a DIFFERENT session id
{
    const ts = Date.now();
    const res = await post('/mint', { sessionId: 'GT-2026-EVIL', ts, sig: sign(SECRET, 'GT-2026-ABCD', ts) });
    const body = await res.json();
    check('signature is bound to sessionId', res.status === 401 && body.code === 'BAD_SIG', `${res.status} ${JSON.stringify(body)}`);
}

// 5. an old capture is not replayable, and the reply carries the clock the client needs
{
    const ts = Date.now() - 60 * 60 * 1000;
    const res = await post('/mint', { sessionId: 'GT-2026-ABCD', ts, sig: sign(SECRET, 'GT-2026-ABCD', ts) });
    const body = await res.json();
    check('stale timestamp rejected', res.status === 401 && body.code === 'STALE', `${res.status} ${JSON.stringify(body)}`);
    check('STALE reply carries broker now', Math.abs(body.now - Date.now()) < 5000, `now=${body.now}`);
}

// 6. a Worker deployed before signing existed fails closed, and says what fixes it
{
    tsCalls = 0;
    const ts = Date.now();
    const res = await post('/mint', { sessionId: 'GT-2026-ABCD', ts, sig: sign(SECRET, 'GT-2026-ABCD', ts) },
        { ...env, GT_SIGNING_SECRET: undefined });
    const body = await res.json();
    check('missing secret fails closed', res.status === 503 && body.code === 'NO_SECRET', `${res.status} ${JSON.stringify(body)}`);
    check('missing secret never reaches Tailscale', tsCalls === 0, `tailscale calls: ${tsCalls}`);
}

// 7. /revoke is behind the same gate
{
    const res = await post('/revoke', { sessionId: 'GT-2026-ABCD', ts: Date.now(), sig: 'zz' });
    check('unsigned /revoke rejected', res.status === 401, String(res.status));
}
{
    const ts = Date.now();
    const res = await post('/revoke', { sessionId: 'GT-2026-ABCD', ts, sig: sign(SECRET, 'GT-2026-ABCD', ts) });
    check('signed /revoke succeeds', res.status === 200, String(res.status));
}

// 8. non-POST and unknown paths
{
    const res = await worker.fetch(new Request('https://broker.test/mint'), env);
    check('GET rejected', res.status === 405, String(res.status));
}
{
    const res = await post('/whatever', { sessionId: 'x', ts: Date.now(), sig: 'y' });
    check('unknown path 404 before auth work', res.status === 404, String(res.status));
}

// 9. clamping of caller-chosen expiry still applies
{
    let captured = null;
    globalThis.fetch = async (url, init) => {
        if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({ key: 'k', expires: 'e' }), { status: 200 });
    };
    const ts = Date.now();
    await post('/mint', { sessionId: 'S', ts, sig: sign(SECRET, 'S', ts), expirySeconds: 99999999 });
    check('expiry clamped to 6h', captured && captured.expirySeconds === 6 * 60 * 60, JSON.stringify(captured && captured.expirySeconds));
    check('key is tagged + ephemeral', captured
        && captured.capabilities.devices.create.ephemeral === true
        && captured.capabilities.devices.create.tags[0] === 'tag:mlmvpn-gt', 'tags/ephemeral');
}

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : `   -> ${r.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
