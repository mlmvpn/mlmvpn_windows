// What the store is allowed to believe. Every refusal here is the difference between "a mirror can
// offer a new engine version" and "anyone who can answer an HTTP request can run code as admin".
const crypto = require('crypto');
const trust = require('../../store/trust');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
const KEYS = { 'test-key': trust.rawPublicKey(pem) };
const manifest = { schema: 1, sequence: 7, items: { xray: { version: '26.9.9' } } };
const good = trust.sealEnvelope(manifest, pem, 'test-key');

const throws = (name, fn, match) => {
    try { fn(); t(name, false, 'did not throw'); }
    catch (e) { t(name, match ? match.test(e.message) : true, e.message); }
};

// ── a real envelope opens ────────────────────────────────────────────────────
try {
    const m = trust.openEnvelope(good, { keys: KEYS });
    t('a signed manifest opens and keeps its content', m.sequence === 7 && m.items.xray.version === '26.9.9');
} catch (e) { t('a signed manifest opens and keeps its content', false, e.message); }

// ── and every way of faking one does not ─────────────────────────────────────
throws('a changed payload is refused', () => {
    const env = JSON.parse(good);
    env.payload = Buffer.from(JSON.stringify({ schema: 1, sequence: 8, items: { xray: { version: '99.0.0' } } })).toString('base64');
    trust.openEnvelope(JSON.stringify(env), { keys: KEYS });
}, /امضا/);

throws('a signature from another key is refused', () => {
    const other = crypto.generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
    trust.openEnvelope(trust.sealEnvelope(manifest, other, 'test-key'), { keys: KEYS });
}, /امضا/);

throws('an unknown key id is refused', () => {
    trust.openEnvelope(trust.sealEnvelope(manifest, pem, 'someone-elses-key'), { keys: KEYS });
}, /کلید/);

throws('a missing signature is refused', () => {
    const env = JSON.parse(good); delete env.sig;
    trust.openEnvelope(JSON.stringify(env), { keys: KEYS });
});

throws('a plain unsigned manifest is not a channel file', () => {
    trust.openEnvelope(JSON.stringify(manifest), { keys: KEYS });
}, /کانال/);

throws('a manifest of a schema this build does not know is refused', () => {
    trust.openEnvelope(trust.sealEnvelope({ schema: 99, sequence: 1, items: {} }, pem, 'test-key'), { keys: KEYS });
}, /ساختار/);

throws('a manifest with no sequence is refused', () => {
    trust.openEnvelope(trust.sealEnvelope({ schema: 1, items: {} }, pem, 'test-key'), { keys: KEYS });
});

// ── the shipping key is real ─────────────────────────────────────────────────
t('the build ships a usable public key', !!trust.publicKeyFor('mlm-store-2026-1'));
t('a placeholder key is not usable', !trust.publicKeyFor('nope'));

// ── digests ──────────────────────────────────────────────────────────────────
t('a 64-hex digest is accepted', trust.isSha256('a'.repeat(64)));
t('a short digest is not', !trust.isSha256('abc'));
t('an upper-case digest is not silently accepted', !trust.isSha256('A'.repeat(64)));
t('no digest at all is not', !trust.isSha256(undefined));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
