// --- «وارپ»: finding a Cloudflare edge that is actually alive, without any engine ---
//
// WHY THIS EXISTS. «وارپ» is meant to be OURS, independent of the aether engine, so that a fault
// in that engine — MASQUE has been failing every gateway with a TLS `handshake_failure` — cannot
// take WARP down with it. Registration is ours (warp-manager.js) and the data plane is Xray's
// WireGuard outbound. The missing piece was the one thing neither of them does: deciding WHICH of
// Cloudflare's edges to talk to.
//
// It has to be measured, not guessed. Measured on an Iranian line, 2026-09-20: a WireGuard scan
// of 2532 candidates found about twelve live ones — roughly half a percent. Twelve random picks
// therefore find nothing, which is exactly what a first attempt with twelve full Xray outbounds
// did. Getting a real answer means probing hundreds of candidates, and a whole userspace network
// stack per candidate cannot do that.
//
// WHAT THIS DOES. It speaks the first message of WireGuard's handshake and nothing else: build a
// valid 148-byte initiation, send it over UDP, and see whether a 92-byte type-2 response comes
// back from that address. The response is NOT decrypted — an endpoint that answers a correctly
// MAC'd initiation is live, and that is the whole question here. Everything after that (does it
// actually carry data?) is decided later by a real HTTPS fetch through the finished tunnel,
// because today proved that a healthy handshake says nothing about the data plane.
//
// The crypto is Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s, all of it in Node's own `crypto`:
// BLAKE2s-256, HMAC-BLAKE2s, X25519 and ChaCha20-Poly1305. No dependency, no binary.

'use strict';

const crypto = require('crypto');
const dgram = require('dgram');

const CONSTRUCTION = Buffer.from('Noise_IKpsk2_25519_ChaChaPoly_BLAKE2s', 'utf8');
const IDENTIFIER = Buffer.from('WireGuard v1 zx2c4 Jason@zx2c4.com', 'utf8');
const LABEL_MAC1 = Buffer.from('mac1----', 'utf8');

const MSG_INITIATION = 1;
const MSG_RESPONSE = 2;
const INITIATION_LEN = 148;
const RESPONSE_LEN = 92;

const ZERO_NONCE = Buffer.alloc(12);

const hash = (...parts) => {
    const h = crypto.createHash('blake2s256');
    for (const p of parts) h.update(p);
    return h.digest();
};

// ── BLAKE2s, only because Node will not key it ───────────────────────────────────────────────
// RFC 7693. Unkeyed hashing goes through Node above; this exists for mac1 alone.
const B2S_IV = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
const B2S_SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const rotr32 = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;

function b2sCompress(h, block, t, last) {
    const v = new Uint32Array(16);
    v.set(h, 0);
    v.set(B2S_IV, 8);
    v[12] = (v[12] ^ (t & 0xffffffff)) >>> 0;
    v[13] = (v[13] ^ Math.floor(t / 0x100000000)) >>> 0;
    if (last) v[14] = (~v[14]) >>> 0;
    const m = new Uint32Array(16);
    for (let i = 0; i < 16; i++) m[i] = block.readUInt32LE(i * 4);
    const mix = (a, b, c, d, x, y) => {
        v[a] = (v[a] + v[b] + x) >>> 0; v[d] = rotr32(v[d] ^ v[a], 16);
        v[c] = (v[c] + v[d]) >>> 0;     v[b] = rotr32(v[b] ^ v[c], 12);
        v[a] = (v[a] + v[b] + y) >>> 0; v[d] = rotr32(v[d] ^ v[a], 8);
        v[c] = (v[c] + v[d]) >>> 0;     v[b] = rotr32(v[b] ^ v[c], 7);
    };
    for (let r = 0; r < 10; r++) {
        const s = B2S_SIGMA[r];
        mix(0, 4, 8, 12, m[s[0]], m[s[1]]);
        mix(1, 5, 9, 13, m[s[2]], m[s[3]]);
        mix(2, 6, 10, 14, m[s[4]], m[s[5]]);
        mix(3, 7, 11, 15, m[s[6]], m[s[7]]);
        mix(0, 5, 10, 15, m[s[8]], m[s[9]]);
        mix(1, 6, 11, 12, m[s[10]], m[s[11]]);
        mix(2, 7, 8, 13, m[s[12]], m[s[13]]);
        mix(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (let i = 0; i < 8; i++) h[i] = (h[i] ^ v[i] ^ v[i + 8]) >>> 0;
}

function blake2s(input, key = Buffer.alloc(0), outLen = 32) {
    const h = new Uint32Array(B2S_IV);
    h[0] = (h[0] ^ 0x01010000 ^ (key.length << 8) ^ outLen) >>> 0;
    let data = Buffer.from(input);
    if (key.length) {
        const keyBlock = Buffer.alloc(64);
        key.copy(keyBlock);
        data = Buffer.concat([keyBlock, data]);
    }
    let t = 0;
    let off = 0;
    while (data.length - off > 64) {
        t += 64;
        b2sCompress(h, data.subarray(off, off + 64), t, false);
        off += 64;
    }
    const lastLen = data.length - off;
    const last = Buffer.alloc(64);
    data.copy(last, 0, off);
    t += lastLen;
    b2sCompress(h, last, t, true);
    const out = Buffer.alloc(32);
    for (let i = 0; i < 8; i++) out.writeUInt32LE(h[i], i * 4);
    return out.subarray(0, outLen);
}

/**
 * WireGuard's MAC: **keyed** BLAKE2s with a 16-byte digest — NOT HMAC-BLAKE2s, which is a
 * different construction and produces a different tag. Node's `createHash` has no keyed mode and
 * `createHmac` is the wrong function here, so the keyed variant is done by hand: BLAKE2s keying
 * is defined as prepending one zero-padded 64-byte block containing the key, with the key length
 * recorded in the parameter block. A wrong mac1 is silently dropped by every implementation, so
 * getting this exactly right is the difference between a prober and a black hole.
 */
function macFallback(key, data) {
    return blake2s(data, key, 16);
}

const hmac = (key, ...parts) => {
    const h = crypto.createHmac('blake2s256', key);
    for (const p of parts) h.update(p);
    return h.digest();
};

/** HKDF over HMAC-BLAKE2s, as WireGuard uses it. Returns `n` 32-byte keys. */
function kdf(n, chainingKey, input) {
    const t0 = hmac(chainingKey, input);
    const out = [];
    let prev = Buffer.alloc(0);
    for (let i = 1; i <= n; i++) {
        prev = hmac(t0, prev, Buffer.from([i]));
        out.push(prev);
    }
    return out;
}

function aead(key, nonceCounter, plaintext, aad) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(BigInt(nonceCounter), 4);
    const c = crypto.createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    c.setAAD(aad, { plaintextLength: plaintext.length });
    return Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]);
}

/** TAI64N, WireGuard's timestamp: 8 bytes of seconds since the TAI epoch, then 4 of nanoseconds. */
function tai64n() {
    const now = Date.now();
    const b = Buffer.alloc(12);
    b.writeBigUInt64BE(BigInt(Math.floor(now / 1000)) + 4611686018427387914n, 0);
    b.writeUInt32BE((now % 1000) * 1e6, 8);
    return b;
}

const rawPublic = (key) => key.export({ type: 'spki', format: 'der' }).subarray(-32);
const rawPrivate = (key) => key.export({ type: 'pkcs8', format: 'der' }).subarray(-32);

function publicFromRaw(raw) {
    return crypto.createPublicKey({
        key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]),
        format: 'der', type: 'spki',
    });
}

function privateFromRaw(raw) {
    return crypto.createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]),
        format: 'der', type: 'pkcs8',
    });
}

/**
 * One valid handshake initiation from `identity` to Cloudflare's static key.
 *
 * `reserved` is the account's client_id in bytes 1..3 of the header — Cloudflare routes on it, and
 * an initiation without it is answered by nothing.
 */
function buildInitiation(identity) {
    const staticPubRaw = Buffer.from(identity.peerPub, 'base64');
    const staticPriv = privateFromRaw(Buffer.from(identity.priv, 'base64'));
    const staticPubSelf = rawPublic(crypto.createPublicKey(staticPriv));
    const responderPub = publicFromRaw(staticPubRaw);

    let c = hash(CONSTRUCTION);
    let h = hash(c, IDENTIFIER);
    h = hash(h, staticPubRaw);

    const eph = crypto.generateKeyPairSync('x25519');
    const ephPubRaw = rawPublic(eph.publicKey);
    [c] = kdf(1, c, ephPubRaw);
    h = hash(h, ephPubRaw);

    let k;
    [c, k] = kdf(2, c, crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: responderPub }));
    const encStatic = aead(k, 0, staticPubSelf, h);
    h = hash(h, encStatic);

    [c, k] = kdf(2, c, crypto.diffieHellman({ privateKey: staticPriv, publicKey: responderPub }));
    const encTimestamp = aead(k, 0, tai64n(), h);
    h = hash(h, encTimestamp);

    const msg = Buffer.alloc(INITIATION_LEN);
    msg[0] = MSG_INITIATION;
    crypto.randomFillSync(msg, 4, 4);          // sender index, ours to choose
    ephPubRaw.copy(msg, 8);
    encStatic.copy(msg, 40);
    encTimestamp.copy(msg, 88);

    // mac1 FIRST, over a header whose three reserved bytes are still ZERO — then the client_id
    // goes in on top. That order is not cosmetic: a standard WireGuard stack computes mac1 over
    // the packet it built (reserved = 0) and Cloudflare's client overwrites the bytes afterwards,
    // so a mac1 that covers the client_id is wrong and the packet is dropped without a word.
    // aether does the same thing, one layer down: `inject_client_id` runs on the finished packet
    // boringtun handed back, and `strip_client_id` zeroes them again on the way in.
    const macKey = hash(LABEL_MAC1, staticPubRaw);
    macFallback(macKey, msg.subarray(0, 116)).copy(msg, 116);
    // mac2 stays zero: it only carries a cookie, and we have not been asked for one.

    if (identity.reserved && identity.reserved.length === 3) {
        msg[1] = identity.reserved[0]; msg[2] = identity.reserved[1]; msg[3] = identity.reserved[2];
    }

    return msg;
}

/**
 * Probe many endpoints at once over ONE socket.
 *
 * One socket, because a few hundred sockets is a few hundred file handles and Windows starts
 * refusing them; the reply's source address is what identifies which candidate answered.
 *
 * `identities` are used round-robin. A handshake is only meaningful with a registered account,
 * but the same account may initiate to as many edges as we like — it is a concurrent DATA session
 * from one key that WireGuard treats as one roaming peer, and none of this reaches that stage.
 *
 * @returns {Promise<Array<{ip:string, port:number, rtt:number}>>} live endpoints, fastest first.
 */
function probe(candidates, identities, { timeoutMs = 4000, onFound } = {}) {
    return new Promise((resolve) => {
        if (!candidates.length || !identities.length) return resolve([]);
        const sock = dgram.createSocket('udp4');
        const sentAt = new Map();
        const found = [];
        const seen = new Set();
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            try { sock.close(); } catch (e) { /* already closing */ }
            found.sort((a, b) => a.rtt - b.rtt);
            resolve(found);
        };

        sock.on('error', finish);

        sock.on('message', (buf, rinfo) => {
            if (buf.length !== RESPONSE_LEN || buf[0] !== MSG_RESPONSE) return;
            const key = rinfo.address + ':' + rinfo.port;
            if (seen.has(key) || !sentAt.has(key)) return;
            seen.add(key);
            const hit = { ip: rinfo.address, port: rinfo.port, rtt: Date.now() - sentAt.get(key) };
            found.push(hit);
            if (onFound) { try { onFound(hit); } catch (e) { /* a listener must not stop the sweep */ } }
        });

        sock.bind(0, () => {
            candidates.forEach(([ip, port], i) => {
                const msg = buildInitiation(identities[i % identities.length]);
                sentAt.set(ip + ':' + port, Date.now());
                sock.send(msg, port, ip, () => { /* a send that fails is a candidate that answers nothing */ });
            });
            setTimeout(finish, timeoutMs);
        });
    });
}

module.exports = { probe, buildInitiation, _internal: { kdf, hash, tai64n, macFallback } };
