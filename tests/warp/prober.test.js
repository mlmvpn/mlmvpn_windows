// «وارپ»'s own WireGuard handshake — warp-prober.js.
//
// WHY THIS IS TESTED AT ALL. A wrong handshake does not fail loudly: every WireGuard
// implementation drops a packet whose mac1 does not verify, without a reply and without a log
// line. The first version of this file got exactly that — zero answers from endpoints that were
// demonstrably alive — because mac1 was computed over a header that already carried the
// client_id. So the cases below pin the two things that have no other symptom: the BLAKE2s
// underneath, and the byte layout of the packet.

const assert = require('assert');
const crypto = require('crypto');
const prober = require('../../warp-prober');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const { macFallback, tai64n } = prober._internal;

// ── BLAKE2s ──────────────────────────────────────────────────────────────────────────────────
// Node has BLAKE2s but will not KEY it, so the algorithm is implemented here and the unkeyed
// path is checked against Node's — same compression function, same padding, same finalisation,
// so agreement across many lengths is what makes the keyed path trustworthy too.
const blake2s = (() => {
    const src = require('fs').readFileSync(require('path').resolve(__dirname, '../../warp-prober.js'), 'utf8');
    const body = src.slice(src.indexOf('const B2S_IV'), src.indexOf('function blake2s'));
    const fn = src.slice(src.indexOf('function blake2s'), src.indexOf('/**\n * WireGuard\'s MAC'));
    return new Function('crypto', body + fn + '; return blake2s;')(crypto);
})();

let mismatches = 0;
for (const n of [0, 1, 31, 55, 63, 64, 65, 127, 128, 129, 1000, 4096]) {
    const data = crypto.randomBytes(n);
    if (blake2s(data).toString('hex') !== crypto.createHash('blake2s256').update(data).digest('hex')) mismatches++;
}
t('BLAKE2s matches Node at every boundary (empty, sub-block, exact block, multi-block)', mismatches === 0,
    mismatches + ' lengths disagreed');
t('a keyed digest is not the unkeyed one', blake2s(Buffer.from('abc'), Buffer.alloc(32, 7), 16).toString('hex')
    !== blake2s(Buffer.from('abc'), Buffer.alloc(0), 16).toString('hex'));
t('the digest length is honoured', blake2s(Buffer.from('abc'), Buffer.alloc(0), 16).length === 16);
// HMAC-BLAKE2s is a DIFFERENT construction, and using it for mac1 is the mistake this guards.
t('WireGuard\'s MAC is keyed BLAKE2s, not HMAC-BLAKE2s',
    macFallback(Buffer.alloc(32, 1), Buffer.from('x')).toString('hex')
    !== crypto.createHmac('blake2s256', Buffer.alloc(32, 1)).update('x').digest().subarray(0, 16).toString('hex'));

// ── the initiation packet ────────────────────────────────────────────────────────────────────
const kp = crypto.generateKeyPairSync('x25519');
const peer = crypto.generateKeyPairSync('x25519');
const identity = {
    priv: kp.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64'),
    peerPub: peer.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
    reserved: [0x11, 0x22, 0x33],
};
const msg = prober.buildInitiation(identity);

t('an initiation is exactly 148 bytes', msg.length === 148, 'got ' + msg.length);
t('…of message type 1', msg[0] === 1);
t('…carrying the account\'s client_id in the three reserved bytes',
    msg[1] === 0x11 && msg[2] === 0x22 && msg[3] === 0x33);
t('…with a sender index that is not a constant',
    prober.buildInitiation(identity).subarray(4, 8).toString('hex') !== msg.subarray(4, 8).toString('hex'));
t('…and a fresh ephemeral key every time',
    prober.buildInitiation(identity).subarray(8, 40).toString('hex') !== msg.subarray(8, 40).toString('hex'));
t('mac2 is left zero — no cookie has been asked for', msg.subarray(132, 148).every((b) => b === 0));
t('mac1 is present', !msg.subarray(116, 132).every((b) => b === 0));

// THE bug: mac1 has to cover a header whose reserved bytes are still zero, because that is the
// packet a normal WireGuard stack built before Cloudflare's client wrote the client_id over it.
// Recompute it here the way the wire expects and insist the two agree.
{
    const staticPubRaw = Buffer.from(identity.peerPub, 'base64');
    const macKey = crypto.createHash('blake2s256').update(Buffer.from('mac1----', 'utf8')).update(staticPubRaw).digest();
    const zeroed = Buffer.from(msg);
    zeroed[1] = 0; zeroed[2] = 0; zeroed[3] = 0;
    const expected = macFallback(macKey, zeroed.subarray(0, 116));
    t('mac1 is computed over ZEROED reserved bytes, not over the client_id',
        expected.equals(msg.subarray(116, 132)),
        'this is the exact fault that made the prober silent');
    // And prove the wrong order really would differ, so the case above cannot pass by accident.
    t('…and computing it the other way round gives a different tag',
        !macFallback(macKey, msg.subarray(0, 116)).equals(msg.subarray(116, 132)));
}

// ── TAI64N ───────────────────────────────────────────────────────────────────────────────────
{
    const ts = tai64n();
    t('a timestamp is 12 bytes', ts.length === 12);
    // TAI64 labels seconds from 1970 with 2^62 added; anything else and the responder treats the
    // handshake as a replay of something ancient and ignores it.
    const secs = ts.readBigUInt64BE(0) - 4611686018427387914n;
    const drift = Math.abs(Number(secs) - Math.floor(Date.now() / 1000));
    t('…whose seconds are now, in TAI64 form', drift <= 2, 'drift ' + drift + 's');
}

// ── an identity without a client_id still produces a valid packet ────────────────────────────
{
    const bare = prober.buildInitiation({ priv: identity.priv, peerPub: identity.peerPub });
    t('a missing client_id leaves the reserved bytes zero rather than throwing',
        bare.length === 148 && bare[1] === 0 && bare[2] === 0 && bare[3] === 0);
}

// ── the sweep itself ─────────────────────────────────────────────────────────────────────────
(async () => {
    // Nothing is listening on these, so this is about the sweep terminating and not about WARP.
    const t0 = Date.now();
    const hits = await prober.probe(
        [['127.0.0.1', 9], ['127.0.0.1', 10], ['127.0.0.1', 11]], [identity], { timeoutMs: 600 });
    const took = Date.now() - t0;
    t('a sweep resolves on its own deadline', took >= 500 && took < 3000, took + 'ms');
    t('…with nothing found when nothing answers', Array.isArray(hits) && hits.length === 0);
    t('an empty candidate list resolves immediately',
        (await prober.probe([], [identity], { timeoutMs: 5000 })).length === 0);
    t('…as does a sweep with no identity',
        (await prober.probe([['127.0.0.1', 9]], [], { timeoutMs: 5000 })).length === 0);

    let failed = 0;
    for (const r of results) {
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();

assert.ok(true);
