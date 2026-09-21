// --- «ام‌ال‌ام استور» — what the store is allowed to believe ---
//
// Everything the store installs runs inside an ELEVATED app. So "downloaded from the right URL" is
// not evidence of anything: the bytes cross a filtered network, then possibly one of this app's own
// engines, then a mirror. The store believes exactly two things:
//
//   1. a SHA-256 written into this app's code (store/catalog.js), or
//   2. a SHA-256 inside a channel manifest signed with a key whose public half is written below.
//
// The channel is what lets a new engine version reach users without shipping a new build of the
// whole app; the signature is what makes that safe. The private key never touches GitHub or any
// server — a compromised GitHub account can replace every file in a release, and still cannot make
// a manifest this code accepts.
//
// One file, not a manifest plus a detached signature: fetched through different routes the two can
// come from different moments of a release being edited, and "signature does not match" is then a
// lie about what happened.
//
// Envelope:  { format: 'mlm-store-channel', kid, alg: 'ed25519', payload: b64(manifest JSON), sig: b64 }

'use strict';

const crypto = require('crypto');
const fs = require('fs');

/**
 * Public keys the store trusts, by key id. Raw 32-byte Ed25519 keys, base64.
 *
 * More than one may be listed so a key can be rotated: ship the new public key in a release first,
 * sign with it only once that release is out. The private key lives on the maintainer's machine —
 * see scripts/store-channel.js.
 */
const TRUSTED_KEYS = {
    // Generated 2026-09-14. Private half: %USERPROFILE%\.mlmvpn-dev\store-signing\mlm-store-2026-1.pem
    'mlm-store-2026-1': 'n4IjFvvq0Ef+ynM99cCPwh3jUBsi08SRzt1CNXZHHww=',
};

// SubjectPublicKeyInfo header for a raw Ed25519 key (RFC 8410): SEQUENCE { SEQUENCE { OID 1.3.101.112 } BIT STRING }.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function publicKeyFor(kid, keys = TRUSTED_KEYS) {
    const raw = keys[kid];
    if (!raw || raw === 'REPLACED_BY_KEYGEN') return null;
    const bytes = Buffer.from(raw, 'base64');
    if (bytes.length !== 32) return null;
    return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
}

/**
 * Open a signed envelope. Returns the manifest object, or throws with a sentence that names which
 * check failed — "the signature is wrong" and "this is not a channel file at all" point at
 * different problems.
 */
function openEnvelope(text, { keys = TRUSTED_KEYS } = {}) {
    let env;
    try { env = JSON.parse(String(text)); } catch (e) { throw new Error('فایل کانال JSON معتبر نیست.'); }
    if (!env || env.format !== 'mlm-store-channel' || env.alg !== 'ed25519') {
        throw new Error('این فایل، فایل کانال استور نیست.');
    }
    const key = publicKeyFor(env.kid, keys);
    if (!key) throw new Error('کلید امضای «' + String(env.kid) + '» در این نسخهٔ برنامه شناخته نمی‌شود.');
    const payload = Buffer.from(String(env.payload || ''), 'base64');
    const sig = Buffer.from(String(env.sig || ''), 'base64');
    if (!payload.length || sig.length !== 64) throw new Error('امضای فایل کانال ناقص است.');
    let ok = false;
    try { ok = crypto.verify(null, payload, key, sig); } catch (e) { ok = false; }
    if (!ok) throw new Error('امضای فایل کانال درست نیست — محتوای آن قابل اعتماد نیست و استفاده نشد.');
    let manifest;
    try { manifest = JSON.parse(payload.toString('utf8')); } catch (e) { throw new Error('محتوای امضاشده JSON معتبر نیست.'); }
    if (!manifest || manifest.schema !== 1 || typeof manifest.sequence !== 'number' || !manifest.items) {
        throw new Error('ساختار فایل کانال با این نسخهٔ برنامه نمی‌خواند.');
    }
    return manifest;
}

/** Build an envelope. Used by the maintainer's tooling, never by the app. */
function sealEnvelope(manifest, privateKeyPem, kid) {
    const payload = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const key = crypto.createPrivateKey(privateKeyPem);
    const sig = crypto.sign(null, payload, key);
    return JSON.stringify({
        format: 'mlm-store-channel', kid, alg: 'ed25519',
        payload: payload.toString('base64'), sig: sig.toString('base64'),
    }, null, 2);
}

/** Raw base64 public key from a PEM private key — what goes into TRUSTED_KEYS. */
function rawPublicKey(privateKeyPem) {
    const der = crypto.createPublicKey(crypto.createPrivateKey(privateKeyPem)).export({ format: 'der', type: 'spki' });
    return der.subarray(ED25519_SPKI_PREFIX.length).toString('base64');
}

const isSha256 = (h) => /^[0-9a-f]{64}$/.test(String(h || ''));

/** SHA-256 of a file, streamed, so an 80 MB core does not sit in memory. */
function sha256File(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('data', (c) => h.update(c))
            .on('error', reject)
            .on('end', () => resolve(h.digest('hex')));
    });
}

module.exports = { TRUSTED_KEYS, openEnvelope, sealEnvelope, rawPublicKey, publicKeyFor, isSha256, sha256File };
