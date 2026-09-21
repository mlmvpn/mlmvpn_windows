// «تست واقعی» — does this relay actually agree to start a session with US?
//
// WHY A SECOND TEST EXISTS AT ALL. `gateway-manager.measure()` opens a TCP connection and times
// it. On a filtered line that is close to meaningless: the port answers, the number looks
// healthy, and the connect fails anyway — because what is answering is the operator's middlebox,
// or a host that listens on 443 and speaks something that is not SoftEther. Measured on the
// user's own line, a list whose pings were all green produced a connect that hung on more than
// half of them.
//
// So this carries the exchange far enough to prove the far end is a working SoftEther SSL-VPN
// listener that accepts us, in four steps, and reports WHICH one failed:
//
//   1. TCP connect                          → «در دسترس نیست»
//   2. TLS handshake                        → «TLS بسته است»   (an intercepting middlebox
//                                              terminates TLS itself, so the SoftEther layer
//                                              behind it never answers — this is what an
//                                              Iranian operator's block looks like from here)
//   3. POST /vpnsvc/connect.cgi + watermark → «پاسخ HTTP نامعتبر»
//   4. a property pack with a server random → «سافت‌اتر نیست» / «رد کرد»
//
// A server that clears step 4 has offered to start a session; the elapsed time is the honest
// cost of reaching that point. Ported from the Android app's SoftEtherProbe.kt, which is where
// this test was designed and proven — the two must keep answering the same way, because a user
// who tests a relay on their phone and again here should not see two different verdicts.
//
// Nothing here touches the connect path, and nothing here writes to disk.

'use strict';

const net = require('net');
const tls = require('tls');

/**
 * SoftEther's watermark: a real GIF that every client posts to /vpnsvc/connect.cgi as the first
 * body of a session. The server answers it with a property pack; anything else answers with a
 * web page, a redirect, or silence. Byte-identical to the Android client's copy
 * (sha256 96a706bb…12a0, 1411 bytes, "GIF89a"), which is itself SoftEther's own.
 *
 * Apache-2.0, © the SoftEther VPN project / SoftEther Corporation.
 */
const WATERMARK = Buffer.from(
    "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",
    'base64');

/** How a probe failed, in the order the checks run. The UI turns these into Persian. */
const REASONS = ['unreachable', 'tls', 'http', 'not-softether', 'refused', 'timeout'];

const CONNECT_TIMEOUT_MS = 6000;
const READ_TIMEOUT_MS = 8000;

/**
 * Hard ceiling on one server, enforced by destroying its socket.
 *
 * The per-phase timeouts do not add up to a bound: nothing covers a peer that completes the TCP
 * connect and then goes silent in the middle of the TLS handshake. A worker parked there never
 * returns to the pool, and with enough of them a sweep stops partway through and quietly
 * abandons the rest of the list — which reads as «the test froze».
 */
const HARD_TIMEOUT_MS = 20000;

/** Probes in flight. TLS handshakes are network-bound and most of the cost is dead hosts. */
const CONCURRENCY = 14;

/** Bound on what a hostile or broken server may stream at us. */
const MAX_RESPONSE = 64 * 1024;

/**
 * SoftEther does no virtual hosting, so the server ignores the name — but the CLIENT HELLO does
 * not. Connecting by IP produces a hello with no server_name at all, and on Iranian operators a
 * nameless TLS handshake to a non-whitelisted address dies as a read timeout: the hello leaves
 * and nothing comes back. Sending the relay's own name (or the project's, for a bare IP) is what
 * makes the difference between «TLS بسته است» and a result.
 */
function sniFor(host) {
    const h = String(host || '');
    return (!h || net.isIP(h)) ? 'www.opengw.net' : h;
}

// ── the answer ───────────────────────────────────────────────────────────────────────────────

/**
 * SoftEther's property pack, parsed generically.
 *
 * The Android client reads it against a table of known keys and their types. That is right for a
 * client that will USE the values; here the only questions are «does this parse at all» and «is
 * there a server random and no error», so walking the wire format without a key table is both
 * shorter and stricter — an unknown key makes the Android reader give up, and giving up is
 * indistinguishable from «not a SoftEther server».
 *
 *   int32  property count
 *   ·      int32 keySize (INCLUDING a NUL that is not sent), keySize-1 bytes of ASCII key,
 *          int32 type (0 int/addr · 1 bytes · 2 ascii · 3 utf8 · 4 long), int32 value count,
 *          then each value: 4 bytes for a type-0, 8 for a type-4, and int32 length + payload
 *          for the three variable-width types.
 */
function readPack(buf) {
    let off = 0;
    const need = (n) => { if (off + n > buf.length) throw new Error('truncated'); };

    need(4);
    const count = buf.readInt32BE(off); off += 4;
    if (count < 0 || count > 4096) throw new Error('property count out of range');

    const props = Object.create(null);
    for (let i = 0; i < count; i++) {
        need(4);
        const keySize = buf.readInt32BE(off) - 1; off += 4;
        if (keySize < 0 || keySize > 256) throw new Error('key size out of range');
        need(keySize);
        const key = buf.toString('ascii', off, off + keySize); off += keySize;

        need(8);
        const type = buf.readInt32BE(off); off += 4;
        const values = buf.readInt32BE(off); off += 4;
        if (type < 0 || type > 4) throw new Error('unknown value type ' + type);
        if (values < 0 || values > 4096) throw new Error('value count out of range');

        const got = [];
        for (let v = 0; v < values; v++) {
            if (type === 0) { need(4); got.push(buf.readInt32BE(off)); off += 4; }
            else if (type === 4) { need(8); got.push(buf.readBigInt64BE(off)); off += 8; }
            else {
                need(4);
                const size = buf.readInt32BE(off); off += 4;
                if (size < 0 || size > buf.length) throw new Error('value size out of range');
                need(size);
                got.push(buf.subarray(off, off + size)); off += size;
            }
        }
        props[key] = { type, values: got };
    }
    return props;
}

/** @returns {{start:string, body:Buffer}|null} — null when the bytes are not parseable HTTP. */
function readHttp(buf) {
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) return null;
    const head = buf.toString('latin1', 0, sep);
    const start = head.split('\r\n')[0] || '';
    const rest = buf.subarray(sep + 4);

    // Content-Length is what SoftEther sends. Chunked is answered by nothing that speaks this
    // protocol, so an absent length means «take what arrived», which is also what the Android
    // client does with a connection the server closes.
    const m = head.match(/content-length:\s*(\d+)/i);
    if (!m) return { start, body: rest };
    const len = parseInt(m[1], 10);
    return { start, body: rest.subarray(0, Math.min(len, rest.length)) };
}

// ── one server ───────────────────────────────────────────────────────────────────────────────

/**
 * @param {string} host      the relay's DDNS name — a name, not an IP, wherever one exists
 * @param {number} port      443 for every relay in the public list
 * @returns {Promise<{ok:true, ms:number}|{ok:false, reason:string}>}
 */
function probe(host, port, opts) {
    const o = opts || {};
    const connectMs = o.connectTimeoutMs || CONNECT_TIMEOUT_MS;
    const readMs = o.readTimeoutMs || READ_TIMEOUT_MS;
    const hardMs = o.hardTimeoutMs || HARD_TIMEOUT_MS;

    return new Promise((resolve) => {
        const started = Date.now();
        let phase = 'tcp';           // tcp → tls → http
        let done = false;
        let chunks = [];
        let size = 0;

        // `tls.connect({ host, port })`, never `tls.connect({ socket })`. Wrapping an existing
        // net.Socket is an access violation on this machine — see the note in the scanner's own
        // probes. Letting tls open the socket costs nothing and does not crash.
        const sock = tls.connect({
            host,
            port,
            servername: sniFor(host),
            // A relay is authenticated by the hub credentials and the watermark exchange, not by
            // PKI, and SoftEther's own client does not require a trusted chain either. The
            // volunteer relays therefore run self-signed certificates — and those are exactly the
            // ones a filtered line can still reach, because the operator blocks the well-known
            // range first. Verifying would throw all of them away before a byte of SoftEther was
            // exchanged, and report the whole list as broken.
            rejectUnauthorized: false,
            timeout: connectMs,
        });

        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(hard);
            try { sock.destroy(); } catch (e) { /* already gone */ }
            resolve(result);
        };

        const hard = setTimeout(() => finish({ ok: false, reason: 'timeout' }), hardMs);
        if (hard.unref) hard.unref();

        sock.on('connect', () => {
            phase = 'tls';
            sock.setTimeout(readMs);
        });

        sock.on('secureConnect', () => {
            phase = 'http';
            const head = Buffer.from(
                'POST /vpnsvc/connect.cgi HTTP/1.1\r\n' +
                'Host: ' + host + '\r\n' +
                'Content-Type: image/jpeg\r\n' +
                'Content-Length: ' + WATERMARK.length + '\r\n' +
                'Connection: Keep-Alive\r\n' +
                '\r\n', 'latin1');
            try { sock.write(Buffer.concat([head, WATERMARK])); }
            catch (e) { finish({ ok: false, reason: 'unreachable' }); }
        });

        sock.on('data', (d) => {
            chunks.push(d);
            size += d.length;
            if (size > MAX_RESPONSE) return finish({ ok: false, reason: 'not-softether' });

            const parsed = readHttp(Buffer.concat(chunks, size));
            if (!parsed) return;                                  // headers still arriving

            if (!/^HTTP\/1\.[01] 200\b/.test(parsed.start)) {
                return finish({ ok: false, reason: 'http' });
            }

            // The body arrives split — VPN Gate's reply is about 4 KB and crosses a segment
            // boundary almost every time. Waiting for a parse rather than for a length is what
            // makes that harmless.
            let pack;
            try { pack = readPack(parsed.body); }
            catch (e) { return; }                                 // keep reading; maybe truncated

            const err = pack.error;
            if (err && err.values && err.values.length && err.values[0] !== 0) {
                return finish({ ok: false, reason: 'refused' });
            }
            if (!pack.random) return finish({ ok: false, reason: 'not-softether' });

            finish({ ok: true, ms: Date.now() - started });
        });

        sock.on('timeout', () => {
            finish({ ok: false, reason: phase === 'tcp' ? 'unreachable' : 'timeout' });
        });

        sock.on('error', () => {
            // WHICH PHASE IS THE WHOLE VALUE OF THIS TEST. A refused TCP connect and a TLS
            // handshake that dies mid-way are different facts about the user's line: the first
            // says the relay is down, the second says something between here and it is reading
            // the handshake. Reported identically, the test says nothing a ping did not.
            finish({ ok: false, reason: phase === 'tcp' ? 'unreachable' : phase === 'tls' ? 'tls' : 'not-softether' });
        });

        sock.on('close', () => {
            // The peer hung up with nothing usable. At the HTTP stage that means it answered
            // something that was not a session offer.
            finish({ ok: false, reason: phase === 'http' ? 'not-softether' : 'unreachable' });
        });
    });
}

// ── a list of them ───────────────────────────────────────────────────────────────────────────

/**
 * Probe every target, `CONCURRENCY` at a time, reporting each result as it lands.
 *
 * @param targets   [{ host, port }]
 * @param onResult  (target, result) — called once per target, in completion order
 * @param shouldStop  () => boolean — polled between targets so «توقف تست» is immediate-ish
 */
async function probeAll(targets, opts) {
    const o = opts || {};
    const list = (targets || []).filter((t) => t && t.host);
    const onResult = typeof o.onResult === 'function' ? o.onResult : () => { };
    const shouldStop = typeof o.shouldStop === 'function' ? o.shouldStop : () => false;
    const width = Math.max(1, Math.min(o.concurrency || CONCURRENCY, 32));

    let next = 0;
    let stopped = false;

    const worker = async () => {
        for (;;) {
            if (stopped || shouldStop()) { stopped = true; return; }
            const i = next++;
            if (i >= list.length) return;
            const t = list[i];
            let r;
            try { r = await probe(t.host, t.port || 443, o); }
            catch (e) { r = { ok: false, reason: 'unreachable' }; }
            if (stopped || shouldStop()) { stopped = true; return; }
            try { onResult(t, r); } catch (e) { /* a listener must not stop the sweep */ }
        }
    };

    await Promise.all(Array.from({ length: Math.min(width, list.length) }, worker));
    return { done: Math.min(next, list.length), stopped };
}

module.exports = {
    probe, probeAll, REASONS,
    CONCURRENCY, HARD_TIMEOUT_MS,
    _internal: { readPack, readHttp, sniFor, WATERMARK },
};
