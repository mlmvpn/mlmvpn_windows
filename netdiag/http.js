/*
 * NetDiag — the diagnostic HTTP collector.
 *
 * `systemcheck.js:74 httpProbe` exists and is correct for its own question ("is this host
 * reachable from this line"), which is why it is left alone. It cannot answer this one:
 * `validateStatus: () => true` means any response counts as success, `maxRedirects: 0` means
 * a redirect is invisible, and it returns only `{ok, latency, status}` — no body, no headers.
 *
 * Behind a captive portal every request is answered with 200 and a login page, so that helper
 * reports a perfectly healthy network to a user who cannot open anything. Detecting
 * interception needs CONTENT, not a status code, so this collector returns the few extra
 * fields that make a content assertion possible — and nothing beyond them.
 *
 * Deliberately bounded, because a diagnostic must not become a browser:
 *   * at most 512 bytes of body are kept, and at most 64KB are read off the wire;
 *   * redirects are NEVER followed — the Location header is evidence, and following it would
 *     turn one measurement into an unbounded walk through someone else's portal;
 *   * no cookie jar, no credentials, no persistent state between calls;
 *   * no user data is ever sent: a plain GET with a browser-shaped User-Agent, nothing else.
 */

'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');

const BODY_PREFIX_MAX = 512;
const READ_MAX = 64 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

function monoNow() { return Number(process.hrtime.bigint() / 1000000n); }

function emptyResult(extra) {
    return Object.assign({
        transport: 'error', status: null, headers: {}, bodyPrefix: '', bodyBytes: 0,
        redirected: false, redirectHost: null, tlsPeer: null, proxyPath: 'direct',
        ms: 0, reason: null,
    }, extra || {});
}

/** Map a Node socket error to the transport-level story a rule can reason about. */
function classify(err) {
    const c = err && (err.code || err.errno);
    if (c === 'ECONNREFUSED') return 'refused';
    if (c === 'ECONNRESET' || c === 'EPIPE') return 'reset';
    if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT' || c === 'timeout') return 'timeout';
    if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return 'dns-fail';
    if (c && String(c).startsWith('ERR_TLS')) return 'tls-fail';
    if (c === 'CERT_HAS_EXPIRED' || c === 'DEPTH_ZERO_SELF_SIGNED_CERT'
        || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || c === 'SELF_SIGNED_CERT_IN_CHAIN') return 'tls-fail';
    return 'error';
}

/**
 * One HTTP request, direct or through a proxy.
 *
 * `opts.proxy` is `{ host, port }`. Only plain-HTTP targets are supported through a proxy, and
 * that is a deliberate boundary rather than an omission: the questions this collector exists
 * to answer through the proxy path — does the proxy answer at all, does it speak HTTP, does it
 * hand back the expected content — are all answerable over HTTP, and the connectivity
 * endpoints Windows itself uses are HTTP. Reproducing a browser's full HTTPS-through-CONNECT
 * behaviour would put OUR client's fidelity into the verdict, which §15 rules out.
 */
function httpDiag(target, opts) {
    const o = opts || {};
    const timeout = o.timeoutMs || 6000;
    const started = monoNow();
    const url = new URL(target);
    const secure = url.protocol === 'https:';
    const viaProxy = !!o.proxy;

    if (viaProxy && secure) {
        return Promise.resolve(emptyResult({
            transport: 'error', proxyPath: 'proxy',
            reason: 'https through a proxy is out of scope for this collector by design',
            ms: 0,
        }));
    }

    return new Promise(resolve => {
        let settled = false;
        const done = r => {
            if (settled) return;
            settled = true;
            resolve(Object.assign(emptyResult(), r, { ms: monoNow() - started }));
        };

        const requestOpts = viaProxy
            ? {
                host: o.proxy.host, port: o.proxy.port, method: 'GET',
                // Absolute-form request-target: how a client speaks to an HTTP proxy.
                path: url.href,
                headers: { Host: url.host, 'User-Agent': UA, Connection: 'close' },
            }
            : {
                host: url.hostname, port: url.port || (secure ? 443 : 80), method: 'GET',
                path: url.pathname + url.search,
                headers: { Host: url.host, 'User-Agent': UA, Connection: 'close' },
                family: o.family === 'v6' ? 6 : (o.family === 'v4' ? 4 : 0),
                servername: secure ? url.hostname : undefined,
                rejectUnauthorized: false,   // a bad certificate is EVIDENCE here, not a refusal
            };

        const mod = (!viaProxy && secure) ? https : http;
        const req = mod.request(requestOpts, res => {
            let bytes = 0;
            let prefix = Buffer.alloc(0);
            res.on('data', chunk => {
                bytes += chunk.length;
                if (prefix.length < BODY_PREFIX_MAX) {
                    prefix = Buffer.concat([prefix, chunk]).slice(0, BODY_PREFIX_MAX);
                }
                if (bytes > READ_MAX) res.destroy();   // a portal page can be megabytes
            });
            const finish = () => {
                const loc = res.headers.location || null;
                let redirectHost = null;
                if (loc) { try { redirectHost = new URL(loc, target).host; } catch (e) { redirectHost = loc; } }
                let peer = null;
                if (secure && res.socket && typeof res.socket.getPeerCertificate === 'function') {
                    const c = res.socket.getPeerCertificate();
                    if (c && c.subject) {
                        peer = {
                            subject: c.subject.CN || null,
                            issuer: (c.issuer && c.issuer.CN) || null,
                            notBefore: c.valid_from || null,
                            notAfter: c.valid_to || null,
                        };
                    }
                }
                done({
                    transport: 'ok',
                    status: res.statusCode,
                    headers: {
                        location: loc,
                        contentType: res.headers['content-type'] || null,
                        server: res.headers.server || null,
                    },
                    bodyPrefix: prefix.toString('utf8'),
                    bodyBytes: bytes,
                    redirected: res.statusCode >= 300 && res.statusCode < 400 && !!loc,
                    redirectHost,
                    tlsPeer: peer,
                    proxyPath: viaProxy ? 'proxy' : 'direct',
                });
            };
            res.on('end', finish);
            res.on('close', finish);
        });

        req.setTimeout(timeout, () => {
            req.destroy();
            done({ transport: 'timeout', proxyPath: viaProxy ? 'proxy-failed' : 'direct', reason: 'timeout' });
        });
        req.on('error', e => done({
            transport: classify(e),
            proxyPath: viaProxy ? 'proxy-failed' : 'direct',
            reason: e.code || e.message,
        }));
        req.end();
    });
}

/**
 * A TLS handshake to a literal address with an explicit SNI.
 *
 * Separated from httpDiag because the question is different: not "what did the server say"
 * but "did the handshake complete, and if not, how did it fail". TCP establishing and then
 * the handshake being reset is a very different observation from TCP never connecting, and
 * only the first is even a candidate for interference (§17.3).
 *
 * The certificate is captured whether or not it validates: an expired-looking certificate is
 * usually a wrong clock, and a certificate from an unexpected issuer is usually local
 * interception. Both are conclusions the rules draw — this only records what was seen.
 */
function tlsDiag(ip, servername, opts) {
    const o = opts || {};
    const timeout = o.timeoutMs || 6000;
    const port = o.port || 443;
    const started = monoNow();

    return new Promise(resolve => {
        let settled = false;
        let tcpOk = false;
        const done = r => {
            if (settled) return;
            settled = true;
            resolve(Object.assign({
                tcpOk, handshakeOk: false, peer: null, alert: null, reason: null,
                ms: monoNow() - started,
            }, r));
        };

        const sock = net.connect({ host: ip, port, family: o.family === 'v6' ? 6 : 4 });
        sock.setTimeout(timeout);
        sock.once('timeout', () => { sock.destroy(); done({ reason: 'tcp timeout' }); });
        sock.once('error', e => done({ reason: e.code || e.message }));
        sock.once('connect', () => {
            tcpOk = true;
            const secured = tls.connect({
                socket: sock, servername,
                rejectUnauthorized: false,     // validation failure is evidence, not an error
                timeout,
            });
            secured.once('secureConnect', () => {
                const c = secured.getPeerCertificate();
                secured.destroy();
                done({
                    handshakeOk: true,
                    peer: c && c.subject ? {
                        subject: c.subject.CN || null,
                        issuer: (c.issuer && c.issuer.CN) || null,
                        notBefore: c.valid_from || null,
                        notAfter: c.valid_to || null,
                    } : null,
                });
            });
            secured.once('error', e => {
                secured.destroy();
                // A reset or a TLS alert AFTER the TCP connection came up is the shape that
                // matters; the rules require it on two hosts and a ruled-out clock before they
                // will call it anything.
                done({ alert: e.code || null, reason: e.code || e.message });
            });
            secured.once('timeout', () => { secured.destroy(); done({ reason: 'tls timeout' }); });
        });
    });
}

module.exports = { httpDiag, tlsDiag, BODY_PREFIX_MAX, READ_MAX };
