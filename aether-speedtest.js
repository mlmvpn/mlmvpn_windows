// --- Aether post-connect throughput probe ---
//
// WHY THIS EXISTS.
// Aether's gateway scan decides a candidate is good when it completes a MASQUE handshake.
// That is a liveness test, not a quality test: a Cloudflare edge can answer a handshake in
// 80ms and still be congested or shaped down to a trickle. In `turbo` mode the scan stops at
// the FIRST such candidate (prober.rs Strategy: target_successes 1, early_exit_first true),
// so the connection quality is decided by whichever edge happens to reply first.
//
// Measured on a 23 Mbit line: a healthy gateway carried ~2.3 MB/s, a bad one ~0.12 MB/s.
// Same settings, same binary, same minute — an 18x spread decided by luck. Worse, the winner
// is written to aether-masque-lastconn.toml and reused on every later connect after only a
// 5-second handshake re-verify, so a bad draw persists across restarts. That is why wiping
// the identity "fixed" the slowness: it deleted the cached gateway along with everything else.
//
// This module measures what actually matters — bytes per second through the finished tunnel —
// so the caller can throw a dud back and rescan instead of living with it.
//
// Speaks SOCKS5 and HTTP/1.1 by hand rather than adding a proxy-agent dependency: a raw
// CONNECT, Node's own tls.connect() layered on the returned socket, then a plain GET whose
// body is counted and discarded.

const net = require('net');
const tls = require('tls');

// Cloudflare's own speed endpoint. It is the right target for three reasons: it is reachable
// from inside WARP by definition, it streams an exact byte count, and it terminates at the
// same edge network the tunnel already exits from — so the number reflects the tunnel rather
// than some unrelated transit path.
const PROBE_HOST = 'speed.cloudflare.com';
const PROBE_PORT = 443;
const PROBE_BYTES = 3_000_000;
const PROBE_PATH = `/__down?bytes=${PROBE_BYTES}`;

// Below this the tunnel is not merely slow, it is broken. Set well under any real line so a
// genuinely modest connection is never mistaken for a dud: 2 Mbit is slower than the worst
// usable ADSL, while the bad gateways measured here sat around 1 Mbit.
const DUD_THRESHOLD_KBPS = 250;

// Long enough that a slow-but-usable line finishes, short enough that a dead one does not
// stall the connect sequence.
const PROBE_TIMEOUT_MS = 12_000;

/** SOCKS5 CONNECT to host:port through the local engine. Resolves with the live socket. */
function socksConnect(socksPort, host, port) {
    return new Promise((resolve, reject) => {
        const sock = new net.Socket();
        let step = 0;
        let settled = false;

        const fail = (msg) => {
            if (settled) return;
            settled = true;
            try { sock.destroy(); } catch (e) {}
            reject(new Error(msg));
        };

        const timer = setTimeout(() => fail('socks timeout'), 8000);

        sock.on('error', (e) => { clearTimeout(timer); fail(e.message); });

        sock.on('data', function onData(buf) {
            if (step === 0) {
                if (buf.length < 2 || buf[0] !== 0x05 || buf[1] !== 0x00) {
                    clearTimeout(timer);
                    return fail('SOCKS5 greeting rejected');
                }
                step = 1;
                // CONNECT by HOSTNAME (ATYP 0x03), never by IP: resolving the name locally
                // would send the lookup outside the tunnel, which is the leak this whole
                // stack exists to prevent — and the answer would point at the wrong edge.
                const name = Buffer.from(host, 'ascii');
                const req = Buffer.alloc(7 + name.length);
                req[0] = 0x05; req[1] = 0x01; req[2] = 0x00; req[3] = 0x03;
                req[4] = name.length;
                name.copy(req, 5);
                req.writeUInt16BE(port, 5 + name.length);
                sock.write(req);
                return;
            }

            if (step === 1) {
                if (buf.length < 2 || buf[0] !== 0x05 || buf[1] !== 0x00) {
                    clearTimeout(timer);
                    return fail(`SOCKS5 connect refused (rep=${buf[1]})`);
                }
                clearTimeout(timer);
                settled = true;
                sock.removeListener('data', onData);
                resolve(sock);
            }
        });

        sock.connect(socksPort, '127.0.0.1', () => {
            sock.write(Buffer.from([0x05, 0x01, 0x00]));
        });
    });
}

/**
 * Measure download throughput through the engine's SOCKS5 port.
 *
 * Returns { ok, kbps, bytes, ms, error }. Never throws: a probe failure must not be able to
 * take down a tunnel that is otherwise working, so every error path resolves instead.
 */
async function measure(socksPort, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    let raw;
    try {
        raw = await socksConnect(socksPort, PROBE_HOST, PROBE_PORT);
    } catch (e) {
        return { ok: false, kbps: 0, bytes: 0, ms: 0, error: e.message };
    }

    return new Promise((resolve) => {
        let bytes = 0;
        let headerDone = false;
        let started = 0;
        let settled = false;

        const finish = (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { secure.destroy(); } catch (e) {}
            try { raw.destroy(); } catch (e) {}
            const ms = started ? Date.now() - started : 0;
            // Only the body counts, and only from the moment the body started arriving:
            // including the TLS handshake and time-to-first-byte would charge latency to
            // the bandwidth figure and make a distant-but-fast edge look like a dud.
            const kbps = ms > 0 ? Math.round((bytes / 1024) / (ms / 1000)) : 0;
            resolve({ ok: !error && bytes > 0, kbps, bytes, ms, error: error || null });
        };

        const timer = setTimeout(() => finish(null), timeoutMs);

        const secure = tls.connect({ socket: raw, servername: PROBE_HOST }, () => {
            secure.write(
                `GET ${PROBE_PATH} HTTP/1.1\r\n` +
                `Host: ${PROBE_HOST}\r\n` +
                `User-Agent: aether-speedcheck\r\n` +
                `Connection: close\r\n\r\n`
            );
        });

        secure.on('data', (chunk) => {
            if (!headerDone) {
                // Everything before the blank line is headers and must not be counted.
                const idx = chunk.indexOf('\r\n\r\n');
                if (idx === -1) return;
                headerDone = true;
                started = Date.now();
                bytes += chunk.length - (idx + 4);
                return;
            }
            bytes += chunk.length;
            if (bytes >= PROBE_BYTES) finish(null);
        });

        secure.on('error', (e) => finish(e.message));
        secure.on('end', () => finish(null));
        secure.on('close', () => finish(null));
    });
}

module.exports = {
    measure,
    DUD_THRESHOLD_KBPS,
    PROBE_BYTES,
};
