// «تست واقعی» — gateway-probe.js.
//
// WHY IT EXISTS. The gateway's other test opens a TCP connection and times it, and on a filtered
// line that is close to meaningless: the port answers, the number looks healthy, and the connect
// fails anyway — because what answered was the operator's middlebox, or a host that listens on
// 443 and speaks something that is not SoftEther. This one carries a real session offer:
// TCP → TLS → POST /vpnsvc/connect.cgi with SoftEther's watermark → HTTP 200 whose body parses
// as a property pack with a server random and no error.
//
// Everything below runs against loopback stand-ins; nothing reaches the network.

const assert = require('assert');
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const probe = require('../../gateway-probe');

const { readPack, readHttp, sniFor, WATERMARK } = probe._internal;
const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── the watermark ────────────────────────────────────────────────────────────────────────────
//
// Byte-identical to the Android client's copy, which is SoftEther's own. A watermark that is
// merely CLOSE is answered by nothing, and the whole test would report every relay as broken.
t('the watermark is SoftEther\'s, byte for byte',
    crypto.createHash('sha256').update(WATERMARK).digest('hex')
    === '96a706bbab378ec37dfef21e02b1a3c177fbebeffa039eb0efac918630df12a0');
t('…and it is the GIF it claims to be', WATERMARK.length === 1411 && WATERMARK.toString('latin1', 0, 6) === 'GIF89a');

// ── SNI ──────────────────────────────────────────────────────────────────────────────────────
//
// Connecting by IP produces a ClientHello with no server_name, and on Iranian operators a
// nameless handshake to a non-whitelisted address dies as a read timeout — the hello leaves and
// nothing comes back. SoftEther ignores the name; the operator does not.
t('a bare IP still gets a name in the hello', sniFor('219.100.37.54') === 'www.opengw.net');
t('…and a relay gets its own', sniFor('public-vpn-182.opengw.net') === 'public-vpn-182.opengw.net');
t('…and an empty host does not produce an empty SNI', sniFor('') === 'www.opengw.net');

// ── the property pack ────────────────────────────────────────────────────────────────────────

/** Build a pack the way SoftEther writes one. */
function pack(entries) {
    const parts = [];
    const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
    parts.push(i32(entries.length));
    for (const [key, type, values] of entries) {
        parts.push(i32(key.length + 1), Buffer.from(key, 'ascii'), i32(type), i32(values.length));
        for (const v of values) {
            if (type === 0) parts.push(i32(v));
            else if (type === 4) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(v)); parts.push(b); }
            else { const p = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'ascii'); parts.push(i32(p.length), p); }
        }
    }
    return Buffer.concat(parts);
}

{
    const p = readPack(pack([
        ['random', 1, [Buffer.alloc(20, 7)]],
        ['version', 0, [444]],
        ['hostname', 2, ['relay']],
        ['bytes', 4, [123456789]],
    ]));
    t('a real pack parses', !!p.random && p.random.values[0].length === 20);
    t('…every value type is walked, not just the one we want',
        p.version.values[0] === 444 && p.hostname.values[0].toString('ascii') === 'relay' && p.bytes.values[0] === 123456789n);
}
{
    // The Android client reads against a table of known keys and gives up on an unknown one —
    // and «gave up» is indistinguishable from «not a SoftEther server». This walks the wire
    // format instead, so a key we have never heard of costs nothing.
    const p = readPack(pack([['a_key_nobody_has_seen', 2, ['x']], ['random', 1, [Buffer.alloc(20)]]]));
    t('an unknown key does not condemn the server', !!p.random);
}
{
    const full = pack([['random', 1, [Buffer.alloc(20, 3)]]]);
    let threw = false;
    try { readPack(full.subarray(0, full.length - 4)); } catch (e) { threw = /truncated/.test(e.message); }
    t('a truncated pack throws rather than returning half an answer', threw);
}
{
    let threw = false;
    const bad = Buffer.alloc(4); bad.writeInt32BE(999999);
    try { readPack(bad); } catch (e) { threw = true; }
    t('a hostile property count is refused', threw);
}
{
    let threw = false;
    try { readPack(Buffer.from('<html><body>hello</body></html>')); } catch (e) { threw = true; }
    t('a web page is not a property pack', threw);
}

// ── the HTTP frame ───────────────────────────────────────────────────────────────────────────
{
    const body = Buffer.from('BODY');
    const buf = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n'), body]);
    const r = readHttp(buf);
    t('a complete response is split into its start line and body',
        r && r.start === 'HTTP/1.1 200 OK' && r.body.toString() === 'BODY');
    t('…and half a header is not mistaken for one',
        readHttp(Buffer.from('HTTP/1.1 200 OK\r\nContent-Len')) === null);
    const over = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n'), Buffer.from('BODYEXTRA')]);
    t('…and Content-Length bounds the body', readHttp(over).body.toString() === 'BODY');
}

// ── end to end, against stand-ins ────────────────────────────────────────────────────────────

/**
 * A stand-in relay. `mode` decides how far it plays along, which is the whole point: the value of
 * this test is that it says WHICH step failed.
 */
function standIn(mode) {
    return new Promise((resolve) => {
        const opts = { key: CERT.key, cert: CERT.cert };
        const server = tls.createServer(opts, (sock) => {
            if (mode === 'silent') return;                       // accepts, never answers
            sock.on('data', () => {
                if (mode === 'webpage') {
                    sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno');
                } else if (mode === 'garbage') {
                    const b = Buffer.from('<html>not softether</html>');
                    sock.end(`HTTP/1.1 200 OK\r\nContent-Length: ${b.length}\r\n\r\n` + b.toString());
                } else if (mode === 'error') {
                    const b = pack([['error', 0, [12]], ['random', 1, [Buffer.alloc(20)]]]);
                    sock.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${b.length}\r\n\r\n`), b]));
                } else if (mode === 'split') {
                    // VPN Gate's real reply is ~4 KB and crosses a segment boundary almost every
                    // time. Waiting for a PARSE rather than for a length is what makes that
                    // harmless — this is the bug the Android client had to fix too.
                    const b = pack([['random', 1, [Buffer.alloc(20, 9)]], ['pencore', 2, ['x'.repeat(2000)]]]);
                    const head = Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${b.length}\r\n\r\n`);
                    sock.write(Buffer.concat([head, b.subarray(0, 12)]));
                    setTimeout(() => sock.end(b.subarray(12)), 60);
                } else {
                    const b = pack([['random', 1, [Buffer.alloc(20, 5)]]]);
                    sock.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${b.length}\r\n\r\n`), b]));
                }
            });
            sock.on('error', () => { });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

/** A plain TCP listener that is not TLS at all — the «middlebox terminated it» shape. */
function notTls() {
    return new Promise((resolve) => {
        const s = net.createServer((sock) => { sock.on('error', () => { }); sock.end('hello'); });
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
}

/**
 * A throwaway SELF-SIGNED certificate for the stand-ins, and it has to be self-signed.
 *
 * The volunteer relays run self-signed certificates, and those are exactly the ones a filtered
 * line can still reach — the operator blocks the well-known range first. A probe that verified
 * the chain would throw all of them away before a byte of SoftEther was exchanged and report the
 * whole list as broken. So the stand-ins present an untrusted chain on purpose.
 */
const CERT = {
    key: fs.readFileSync(path.join(__dirname, 'fixtures', 'test-key.pem'), 'utf8'),
    cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'test-cert.pem'), 'utf8'),
};

(async () => {
    const cases = [
        ['ok', true, null],
        ['split', true, null],
        ['webpage', false, 'http'],
        ['garbage', false, 'not-softether'],
        ['error', false, 'refused'],
    ];
    for (const [mode, ok, reason] of cases) {
        const server = await standIn(mode);
        const r = await probe.probe('127.0.0.1', server.address().port, { readTimeoutMs: 2500, hardTimeoutMs: 6000 });
        server.close();
        t(`a stand-in in «${mode}» mode is judged correctly`,
            r.ok === ok && (ok || r.reason === reason),
            JSON.stringify(r));
    }

    {
        const s = await notTls();
        const r = await probe.probe('127.0.0.1', s.address().port, { readTimeoutMs: 1500, hardTimeoutMs: 5000 });
        s.close();
        // WHICH PHASE IS THE WHOLE VALUE. «the relay is down» and «something between here and it
        // is reading the handshake» are different facts about the user's line.
        t('a listener that is not TLS is reported as a TLS failure, not as unreachable',
            r.ok === false && r.reason === 'tls', JSON.stringify(r));
    }
    {
        const r = await probe.probe('127.0.0.1', 1, { connectTimeoutMs: 1200, hardTimeoutMs: 4000 });
        t('a closed port is «unreachable»', r.ok === false && r.reason === 'unreachable', JSON.stringify(r));
    }
    {
        // Nothing covers a peer that completes the TCP connect and then goes silent mid-handshake;
        // a worker parked there never returns to the pool, and a sweep with enough of them stops
        // partway through and abandons the rest of the list.
        const server = await standIn('silent');
        const t0 = Date.now();
        const r = await probe.probe('127.0.0.1', server.address().port, { readTimeoutMs: 9000, hardTimeoutMs: 1500 });
        const took = Date.now() - t0;
        server.close();
        t('a peer that goes silent is bounded by the hard timeout, not left to hang',
            r.ok === false && took < 4000, `${took}ms ${JSON.stringify(r)}`);
    }

    // ── the sweep ────────────────────────────────────────────────────────────────────────────
    {
        const server = await standIn('ok');
        const port = server.address().port;
        const targets = Array.from({ length: 12 }, () => ({ host: '127.0.0.1', port }));
        const seen = [];
        const out = await probe.probeAll(targets, { concurrency: 4, onResult: (x, r) => seen.push(r.ok) });
        server.close();
        t('every target in a sweep is reported', out.done === 12 && seen.length === 12 && seen.every(Boolean));
    }
    {
        const server = await standIn('ok');
        const port = server.address().port;
        const targets = Array.from({ length: 40 }, () => ({ host: '127.0.0.1', port }));
        let n = 0;
        const out = await probe.probeAll(targets, {
            concurrency: 2,
            onResult: () => { n++; },
            shouldStop: () => n >= 4,
        });
        server.close();
        // «توقف تست» has to actually stop it, and soon — a cancel that runs to the end of a
        // 350-relay list is not a cancel.
        t('a cancelled sweep stops early and says so', out.stopped === true && n < 20, `results=${n}`);
    }

    let failed = 0;
    for (const r of results) {
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();

assert.ok(true);
