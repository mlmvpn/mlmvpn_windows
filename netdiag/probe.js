/*
 * NetDiag — probe primitives.
 *
 * These exist rather than reusing systemcheck.js for two reasons, one mechanical and one
 * semantic:
 *
 *   mechanical  systemcheck.js exports a mount function with only runProbe attached
 *               (`module.exports = function mountSystemCheck(app)` at :441, `.runProbe` at
 *               :453). Its withDeadline/tcpProbe/httpProbe are not importable at all.
 *
 *   semantic    even if they were, they answer a different question. systemcheck's httpProbe
 *               treats ANY response as reachability — correct for "is this host blocked on
 *               this line", useless for "is a captive portal answering everything with a
 *               login page". And its tcpProbe has no address family, which is how an
 *               IPv4-only probe set reports "no internet" on a machine whose IPv6 works.
 *
 * Nothing here judges. Every function returns an observation plus, on failure, a reason —
 * because "we could not connect" and "we did not try" are different facts, and the caller
 * needs to be able to tell them apart when it writes them down.
 *
 * All timing is monotonic. Clock skew is one of the diagnoses; a Date.now() delta stops being
 * a duration the moment W32Time syncs mid-run.
 */

'use strict';

const net = require('net');
const dgram = require('dgram');

function monoNow() {
    return Number(process.hrtime.bigint() / 1000000n);
}

/**
 * Resolve to a fallback at `ms`, whatever the underlying promise does.
 *
 * `Promise.race`, not an AbortController — the same conclusion systemcheck.js:36 reached and
 * documented, for the same reason: a probe can hang inside a PowerShell child or inside DNS
 * resolution, and neither honours an abort signal.
 */
function withDeadline(promise, ms, onTimeout) {
    let timer;
    // `onTimeout` may THROW instead of returning a fallback — three call sites do exactly
    // that to turn a deadline into a rejection they can catch:
    //     withDeadline(resolver.resolve4(name), 2500, () => { throw new Error('timeout'); })
    //
    // Without this try/catch that throw happens inside a bare timer callback, which is not
    // inside any promise: nothing can catch it, so it becomes an uncaught exception and
    // Electron kills the run with "A JavaScript error occurred in the main process". It only
    // fires when a probe actually times out — i.e. when the network is broken, which is the
    // one moment the diagnostics exist for, and precisely when they crashed instead.
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
            try { resolve(onTimeout()); } catch (e) { reject(e); }
        }, ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Sleep, cancellable by a ctx that may flip `cancelled` under us. */
function delay(ms, ctx) {
    return new Promise(resolve => {
        const t = setTimeout(resolve, ms);
        if (ctx && ctx.onCancel) ctx.onCancel(() => { clearTimeout(t); resolve(); });
    });
}

/**
 * TCP connect.
 *
 * `family` is explicit and required by convention: 4, 6, or 0 for "let the stack choose".
 * Passing 0 is only correct for a literal whose family is already unambiguous.
 */
function tcpProbe(host, port, timeoutMs, family) {
    return new Promise(resolve => {
        const started = monoNow();
        const sock = new net.Socket();
        let settled = false;
        const done = r => {
            if (settled) return;
            settled = true;
            sock.destroy();
            resolve(Object.assign({ ms: monoNow() - started }, r));
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => done({ ok: true }));
        sock.once('timeout', () => done({ ok: false, reason: 'timeout' }));
        sock.once('error', e => done({ ok: false, reason: e.code || e.message }));
        try {
            sock.connect({ host, port, family: family || 0 });
        } catch (e) {
            done({ ok: false, reason: e.message });
        }
    });
}

/**
 * UDP reachability, which is a weaker claim than TCP and is labelled as such.
 *
 * UDP has no handshake, so silence is ambiguous: a filtered path and a server that simply
 * chose not to answer this packet look identical from here. A reply proves reachability; the
 * absence of one proves nothing on its own, and `ok: false` is therefore always accompanied
 * by `weak: true` so a rule cannot treat it as a measured negative.
 */
function udpProbe(host, port, payload, timeoutMs, family) {
    return new Promise(resolve => {
        const started = monoNow();
        const sock = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
        let settled = false;
        const done = r => {
            if (settled) return;
            settled = true;
            try { sock.close(); } catch (e) { /* already closing */ }
            resolve(Object.assign({ ms: monoNow() - started }, r));
        };
        const timer = setTimeout(() => done({ ok: false, weak: true, reason: 'no reply' }), timeoutMs);
        sock.once('message', () => { clearTimeout(timer); done({ ok: true }); });
        sock.once('error', e => { clearTimeout(timer); done({ ok: false, weak: true, reason: e.code || e.message }); });
        try {
            sock.send(payload, port, host);
        } catch (e) {
            clearTimeout(timer);
            done({ ok: false, weak: true, reason: e.message });
        }
    });
}

/**
 * A minimal DNS A query, used only to see whether a resolver answers at all on UDP/53.
 *
 * Deliberately hand-rolled rather than routed through Node's resolver: Node resolves against
 * whatever is in `dns.getServers()`, which on the development machine was 127.0.0.1 while
 * Windows was configured with 1.1.1.1 and working perfectly. A collector that measures Node's
 * configuration and reports it as the machine's DNS health produces a confident, wrong
 * «سرور DNS پاسخ نمی‌دهد» — independent validation caught exactly that.
 */
function dnsQueryPacket(name) {
    const labels = String(name).split('.').filter(Boolean);
    const qname = Buffer.concat([
        ...labels.map(l => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')])),
        Buffer.from([0]),
    ]);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(Math.floor(Math.random() * 0xffff), 0);   // transaction id
    header.writeUInt16BE(0x0100, 2);                               // standard query, recursion desired
    header.writeUInt16BE(1, 4);                                    // one question
    const tail = Buffer.alloc(4);
    tail.writeUInt16BE(1, 0);                                      // QTYPE A
    tail.writeUInt16BE(1, 2);                                      // QCLASS IN
    return Buffer.concat([header, qname, tail]);
}

/** Does this resolver answer on UDP/53 at all? Reachability only — never answer quality. */
function dnsUdpProbe(server, timeoutMs, family) {
    return udpProbe(server, 53, dnsQueryPacket('example.com'), timeoutMs, family);
}

/**
 * Run the same probe more than once and report disagreement as its own result.
 *
 * Retry disagreement is a diagnosis — an unstable link — not noise to smooth away. Reporting
 * a hard failure for a line that answers every other attempt sends the user chasing a cause
 * that is not there. tun-manager.js:startTun already reached this conclusion the hard way for
 * the tunnel data-path probe, and retries three times before believing a negative.
 */
async function repeated(fn, attempts, gapMs, ctx) {
    const runs = [];
    for (let i = 0; i < attempts; i++) {
        if (ctx && ctx.cancelled) break;
        runs.push(await fn(i));
        if (i < attempts - 1) await delay(gapMs, ctx);
    }
    if (!runs.length) return { ok: false, reason: 'cancelled', runs, flapping: false };
    const oks = runs.filter(r => r.ok).length;
    return {
        ok: oks > 0,
        allOk: oks === runs.length,
        flapping: oks > 0 && oks < runs.length,
        attempts: runs.length,
        ms: Math.min(...runs.map(r => r.ms)),
        reason: oks ? null : (runs[runs.length - 1].reason || 'failed'),
        runs,
    };
}

/**
 * Bounded-concurrency map.
 *
 * A broken line plus twenty parallel sockets produces its own artefacts — timeouts caused by
 * the probing rather than by the fault — so the wave runner caps everything that touches the
 * network.
 */
async function pool(items, limit, worker) {
    const out = new Array(items.length);
    let next = 0;
    const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            out[i] = await worker(items[i], i);
        }
    });
    await Promise.all(runners);
    return out;
}

module.exports = { monoNow, withDeadline, delay, tcpProbe, udpProbe, dnsUdpProbe, dnsQueryPacket, repeated, pool };
