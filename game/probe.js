// --- Game-grade network measurement ---
//
// This is the file the whole feature stands on. If it lies, everything above it lies.
//
// WHY NOT ping.exe
// Measured on an Iranian line 2026-08-19: ICMP to 8.8.8.8 gave a 53ms spread (49→102),
// while a UDP train to the same network on a high port gave 12ms. Routers deprioritise
// ICMP and put it in a different queue, so `ping` answers a question nobody asked. It is
// used here for exactly one thing — the DF/MTU ladder — and never for latency.
//
// WHY A TRAIN AND NOT A HANDFUL OF PACKETS
// Same night, same machine: five STUN packets to stun.l.google.com said "47–59ms, great".
// A 240-packet train at a game's cadence said p95 = 582ms with 30 spikes. Small samples do
// not merely lose precision, they invert the ranking. So: fixed cadence, hundreds of
// samples, and percentiles — never an average, because the average hides the tail and the
// tail is the thing a player feels.
//
// WHAT "CORRELATED" MEANS AND WHY IT IS RECORDED
// A reply can only be tied to its request if the protocol carries a token we chose. STUN,
// FiveM's getinfo and RakNet's unconnected ping all do; A2S_INFO does not. For A2S the
// replies are matched to the oldest unanswered send (FIFO), which is right unless the path
// reorders. Every result therefore carries `correlation: 'token' | 'fifo'`, and the UI is
// expected to say so rather than present both as equally exact.

'use strict';

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const dns = require('dns').promises;

// dns.resolve4() talks to the configured resolvers directly through c-ares, and on a
// machine running this very app that resolver is often a local bridge that is down or
// mid-restart — every lookup then fails while the OS resolves the same name fine.
// getaddrinfo (dns.lookup) uses the Windows resolver, cache and hosts file, which is what
// the game itself uses. Measured: resolve4 failed on all 28 datacentre names, lookup on none.
async function resolve4(host) {
    if (net.isIPv4(host)) return host;
    const { address } = await dns.lookup(host, { family: 4 });
    return address;
}

const now = () => Number(process.hrtime.bigint()) / 1e6;

/**
 * Turn raw RTT samples into the numbers that decide whether a path is playable.
 *
 * `samples` is [{ seq, rtt }] in send order, already warm-up filtered.
 * `sent` is how many were sent in the same window, so loss is not inferred from the
 * survivors alone.
 */
function stats(samples, sent, opts = {}) {
    const spikeOver = opts.spikeOver ?? 50;
    if (!samples.length) {
        return { n: 0, sent, loss: sent ? 100 : 0, min: null, p50: null, p95: null, p99: null,
                 max: null, jitter: null, spread: null, spikes: 0, reorder: 0, mos: null };
    }
    const bySeq = samples.slice().sort((a, b) => a.seq - b.seq);
    const sorted = samples.map(s => s.rtt).sort((a, b) => a - b);
    const at = p => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

    // RFC 3550 interarrival jitter: J += (|D| - J)/16. Comparable with anything that
    // reports "jitter" for RTP, which is the only widely agreed definition there is.
    let J = 0;
    for (let i = 1; i < bySeq.length; i++) J += (Math.abs(bySeq[i].rtt - bySeq[i - 1].rtt) - J) / 16;

    // Reordering: a reply that arrived after a later-sequenced one already had.
    let reorder = 0, high = -1;
    for (const s of samples) { if (s.seq < high) reorder++; else high = s.seq; }

    const min = sorted[0];
    const spikes = sorted.filter(r => r > min + spikeOver).length;
    const lost = Math.max(0, sent - samples.length);

    return {
        n: samples.length, sent,
        loss: sent ? +(lost / sent * 100).toFixed(2) : 0,
        min: Math.round(min), p50: Math.round(at(0.5)), p95: Math.round(at(0.95)),
        p99: Math.round(at(0.99)), max: Math.round(sorted[sorted.length - 1]),
        jitter: +J.toFixed(1),
        spread: Math.round(at(0.95) - min),   // what the player actually feels
        spikes, reorder,
        spikePct: +(spikes / samples.length * 100).toFixed(1),
    };
}

/**
 * A single playability score, 0–100, so paths can be ranked by one number.
 *
 * Deliberately NOT a latency score. The weights come from what breaks a game:
 * a steady 200ms is playable; a 90ms average with 500ms spikes is not.
 */
function score(s) {
    if (!s || s.n === 0) return 0;
    let v = 100;
    v -= Math.min(35, Math.max(0, (s.min - 40)) * 0.18);   // distance floor, gentle
    v -= Math.min(30, s.spread * 0.45);                     // the felt jitter
    v -= Math.min(20, s.jitter * 0.9);                      // RFC jitter
    v -= Math.min(35, s.loss * 12);                         // loss is brutal
    v -= Math.min(20, s.spikePct * 0.8);                    // stalls
    v -= Math.min(5, s.reorder * 0.5);
    return Math.max(0, Math.round(v));
}

/**
 * What cadence did the train ACTUALLY manage?
 *
 * This is reported rather than assumed, because on Windows it is measurably not what was
 * asked for. The default timer resolution is ~15.6ms, so `setInterval` cannot deliver a
 * gap much below that, and the achieved rate flattens out around 30/s. Measured on this
 * machine: 20pps requested → 18.4 achieved; 40 → 29.8; 50 → 30.8.
 *
 * That does not invalidate a measurement — what matters for latency statistics is that the
 * cadence is STEADY, not that it hits a particular number — but a result that claims
 * "20 packets per second" while sending twelve is a small lie, and every number this
 * feature prints is supposed to be checkable. So the achieved rate ships with the result,
 * and anything above ~30pps is understood to be a request, not a promise.
 */
function cadence(sentWindow, t0, requestedPps) {
    if (sentWindow.length < 2) return { ppsRequested: requestedPps, ppsAchieved: null };
    const span = (sentWindow[sentWindow.length - 1].tx - sentWindow[0].tx) / 1000;
    return {
        ppsRequested: requestedPps,
        ppsAchieved: span > 0 ? +((sentWindow.length - 1) / span).toFixed(1) : null,
    };
}

// ── protocol builders ───────────────────────────────────────────────────────────
// Each returns { build(token) -> Buffer, match(msg) -> token|null }. A `match` that can
// return a token gives correlated timing; one that returns MATCH_FIFO does not.

const MATCH_FIFO = Symbol('fifo');

const PROTO = {
    /** STUN binding request — RFC 5389. 96-bit transaction id, echoed verbatim. */
    stun: {
        correlation: 'token',
        build(token) {
            const b = Buffer.alloc(20);
            b.writeUInt16BE(0x0001, 0);            // binding request
            b.writeUInt16BE(0, 2);                 // length
            b.writeUInt32BE(0x2112A442, 4);        // magic cookie
            token.copy(b, 8);
            return b;
        },
        token: () => crypto.randomBytes(12),
        match(msg) {
            if (msg.length < 20) return null;
            if (msg.readUInt32BE(4) !== 0x2112A442) return null;
            return msg.slice(8, 20);
        },
    },

    /**
     * FiveM / RedM `getinfo`. The challenge string we send comes back inside
     * `infoResponse`, so this is a real correlated end-to-end measurement against the
     * actual game server — the best data this feature can get without a relay.
     */
    fivem: {
        correlation: 'token',
        build(token) {
            return Buffer.concat([
                Buffer.from([0xFF, 0xFF, 0xFF, 0xFF]),
                Buffer.from(`getinfo ${token.toString('hex')}`, 'ascii'),
            ]);
        },
        token: () => crypto.randomBytes(6),
        match(msg) {
            const s = msg.toString('latin1');
            if (!s.includes('infoResponse')) return null;
            // Both patterns are bounded. An unbounded /([0-9a-f]{12})/ finds a SHIFTED
            // window inside any longer hex run — including the "e" at the end of the word
            // "challenge" — and returns a token that is in no outstanding map, so the
            // reply is silently counted as loss. Boundaries make a wrong match impossible
            // rather than merely unlikely.
            const m = s.match(/\\challenge\\([0-9a-f]{12})(?![0-9a-f])/i)
                || s.match(/(?:^|[^0-9a-f])([0-9a-f]{12})(?![0-9a-f])/i);
            return m ? Buffer.from(m[1], 'hex') : null;
        },
    },

    /** RakNet unconnected ping (Minecraft Bedrock). The 64-bit send time is echoed. */
    raknet: {
        correlation: 'token',
        build(token) {
            const b = Buffer.alloc(33);
            b.writeUInt8(0x01, 0);
            token.copy(b, 1);                                   // 8-byte "time"
            Buffer.from('00ffff00fefefefefdfdfdfd12345678', 'hex').copy(b, 9);
            b.writeBigUInt64BE(0n, 25);                          // client GUID
            return b;
        },
        token: () => crypto.randomBytes(8),
        match(msg) {
            if (msg.length < 9 || msg.readUInt8(0) !== 0x1C) return null;
            return msg.slice(1, 9);
        },
    },

    /**
     * Source engine A2S_INFO. No transaction id exists in the protocol, so replies are
     * matched FIFO. Modern servers answer the first query with a challenge (0x41) that
     * must be appended to subsequent queries; `challenge` is carried between sends.
     */
    a2s: {
        correlation: 'fifo',
        challengeable: true,
        build(_token, challenge) {
            const head = Buffer.concat([
                Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x54]),
                Buffer.from('Source Engine Query\0', 'ascii'),
            ]);
            return challenge ? Buffer.concat([head, challenge]) : head;
        },
        token: () => null,
        match(msg) {
            if (msg.length < 5) return null;
            const type = msg.readUInt8(4);
            if (type === 0x49) return MATCH_FIFO;               // A2S_INFO reply
            if (type === 0x41) return { challenge: msg.slice(5, 9) };
            return null;
        },
    },
};

/**
 * Send a train of UDP probes at a fixed cadence and measure every reply.
 *
 * The cadence is the point: a game emits packets on a clock, and a path behaves
 * differently under a steady stream than under a burst of five. `pps` therefore defaults
 * to something game-like rather than something polite.
 *
 * onSample(sample) is called live so the UI can draw while it runs.
 */
function udpTrain(opts) {
    const {
        host, ip, port, proto = 'stun',
        pps = 20, seconds = 10, warmupMs = 1500,
        timeoutMs = 2500, onSample = null, signal = null,
        // Measure THROUGH ONE SPECIFIC UPLINK by binding the socket to that adapter's
        // address. Windows has used the strong host model since Vista, so a datagram whose
        // source is an address owned by adapter X leaves through adapter X — which is what
        // makes it possible to compare two internet connections without switching to
        // either one. The caller still has to make sure a route to the target exists via
        // that adapter (see game/uplinks.js, which adds a temporary /32 host route);
        // binding alone does not create one.
        bindAddress = null,
    } = opts;
    const P = PROTO[proto];
    if (!P) return Promise.resolve({ error: `پروتکل ناشناخته: ${proto}` });

    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        const outstanding = new Map();   // key -> { seq, tx }
        const fifo = [];                 // seq numbers awaiting a FIFO reply
        const sent = [];                 // { seq, tx, done }
        const samples = [];
        let challenge = null;
        let seq = 0, closed = false, socketError = null;
        // Not const: when the socket has to bind to a specific uplink first, the clock has
        // to start when the first packet goes out, not when the promise was created —
        // otherwise the bind delay is charged to the warm-up window and to the cadence.
        let t0 = now();

        const finish = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer);
            clearTimeout(stopper);
            try { sock.close(); } catch {}
            const window = sent.filter(s => s.tx - t0 >= warmupMs);
            const kept = samples.filter(s => s.txRel >= warmupMs);
            const st = stats(kept, window.length);
            resolve({
                ok: kept.length > 0,
                target: `${host || ip}:${port}`, ip, port, proto,
                correlation: P.correlation,
                error: kept.length ? null : (socketError || 'هیچ پاسخی نیامد'),
                ...st,
                ...cadence(window, t0, pps),
                score: score(st),
                series: kept.map(s => ({ t: Math.round(s.txRel), rtt: Math.round(s.rtt) })),
            });
        };

        sock.on('error', err => { socketError = err.message; finish(); });

        sock.on('message', msg => {
            const at = now();
            let hit = null;
            const m = P.match(msg);
            if (m === null) return;
            if (m && m.challenge) { challenge = m.challenge; return; }
            if (m === MATCH_FIFO) {
                const s = fifo.shift();
                if (s === undefined) return;
                hit = sent[s];
            } else {
                const key = Buffer.isBuffer(m) ? m.toString('hex') : String(m);
                const rec = outstanding.get(key);
                if (!rec) return;
                outstanding.delete(key);
                hit = sent[rec.seq];
            }
            if (!hit || hit.done) return;
            hit.done = true;
            samples.push({ seq: hit.seq, rtt: at - hit.tx, txRel: hit.tx - t0 });
            if (onSample) { try { onSample({ seq: hit.seq, rtt: at - hit.tx }); } catch {} }
        });

        let timer = null;
        let stopper = null;

        const start = () => {
            if (closed) return;
            t0 = now();
            timer = setInterval(() => {
                if (closed) return;
                if (signal && signal.aborted) return finish();
                const s = seq++;
                const token = P.token();
                const pkt = P.build(token, challenge);
                sent[s] = { seq: s, tx: now(), done: false };
                if (token) outstanding.set(token.toString('hex'), { seq: s });
                else fifo.push(s);
                sock.send(pkt, port, ip, err => { if (err && !socketError) socketError = err.message; });
            }, Math.max(4, 1000 / pps));

            stopper = setTimeout(() => {
                clearInterval(timer);
                // Give the last packets their full timeout before declaring them lost.
                setTimeout(finish, timeoutMs);
            }, seconds * 1000);
        };

        if (bindAddress) {
            // Sending cannot begin until the socket actually owns the address, and a bind
            // to an address this machine does not have fails loudly here rather than
            // silently measuring the default uplink and labelling it as the other one —
            // which would be the worst possible failure for a feature whose entire purpose
            // is telling two connections apart.
            sock.once('listening', start);
            try { sock.bind({ address: bindAddress, exclusive: false }); }
            catch (err) {
                socketError = `سنجش از این اینترنت ممکن نشد (bind روی ${bindAddress}): ${err.message}`;
                finish();
            }
        } else {
            start();
        }
    });
}

/**
 * A train of TCP handshakes.
 *
 * Used where nothing answers UDP — which is every closed platform, GTA Online included.
 * A SYN→SYN/ACK is a real transport round trip through the same queues as data, so it is
 * a far better instrument than ICMP, and unlike ICMP it proves the port is actually
 * reachable. The cadence is kept low: every sample burns an ephemeral port, and Windows
 * holds them in TIME_WAIT.
 */
async function tcpTrain(opts) {
    const {
        host, ip, port = 443, count = 40, gapMs = 120, timeoutMs = 3000,
        onSample = null, signal = null,
    } = opts;
    const samples = [];
    let sentN = 0;
    const t0 = now();

    const one = (seq) => new Promise(res => {
        const s = new net.Socket();
        const start = now();
        let done = false;
        const fin = (rtt) => {
            if (done) return;
            done = true;
            try { s.destroy(); } catch {}
            res(rtt);
        };
        s.setTimeout(timeoutMs, () => fin(null));
        s.once('error', () => fin(null));
        s.connect(port, ip, () => fin(now() - start));
    });

    for (let i = 0; i < count; i++) {
        if (signal && signal.aborted) break;
        sentN++;
        const rtt = await one(i);
        if (rtt != null) {
            samples.push({ seq: i, rtt, txRel: now() - t0 });
            if (onSample) { try { onSample({ seq: i, rtt }); } catch {} }
        }
        if (i < count - 1) await new Promise(r => setTimeout(r, gapMs));
    }
    const st = stats(samples, sentN);
    return {
        ok: samples.length > 0,
        target: `${host || ip}:${port}`, ip, port, proto: 'tcp',
        correlation: 'token',   // a TCP handshake is inherently correlated
        error: samples.length ? null : 'هیچ اتصالی برقرار نشد',
        ...st,
        score: score(st),
        series: samples.map(s => ({ t: Math.round(s.txRel), rtt: Math.round(s.rtt) })),
    };
}

/**
 * One-shot Minecraft Java status ping (handshake + status + ping/pong over TCP).
 * Returns a single RTT — enough to confirm the server is alive and give a first number;
 * the tcpTrain above is what produces the distribution.
 */
function minecraftPing(ip, port = 25565, timeoutMs = 4000) {
    return new Promise(res => {
        const s = new net.Socket();
        let done = false;
        const start = now();
        const fin = v => { if (done) return; done = true; try { s.destroy(); } catch {}; res(v); };
        s.setTimeout(timeoutMs, () => fin(null));
        s.once('error', () => fin(null));
        s.connect(port, ip, () => {
            const varint = n => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
            const hostBuf = Buffer.from(ip, 'utf8');
            const payload = Buffer.concat([
                varint(0x00), varint(0),                 // packet id 0x00, protocol version 0 = "any"
                varint(hostBuf.length), hostBuf,
                Buffer.from([(port >> 8) & 0xff, port & 0xff]),
                varint(1),
            ]);
            s.write(Buffer.concat([varint(payload.length), payload]));
            s.write(Buffer.concat([varint(1), varint(0x00)]));   // status request
        });
        s.once('data', () => fin(now() - start));
    });
}

/**
 * Interleaved measurement across several targets.
 *
 * THIS IS THE METHODOLOGY, not a convenience. Measuring target A for 60s and then B for
 * 60s measures the difference between two *minutes*, and Iranian international congestion
 * moves on exactly that scale. Slicing round-robin makes both targets see the same
 * network conditions, so the comparison survives.
 *
 * `slices` short passes per target rather than one long pass each.
 */
async function interleaved(targets, { slices = 4, secondsPerSlice = 3, pps = 20, onProgress = null, signal = null } = {}) {
    const acc = new Map(targets.map(t => [t.key, { target: t, samples: [], sent: 0, series: [], meta: null }]));
    const total = slices * targets.length;
    let step = 0;

    for (let s = 0; s < slices; s++) {
        for (const t of targets) {
            if (signal && signal.aborted) break;
            const run = t.mode === 'tcp'
                ? await tcpTrain({ ...t, count: Math.round(secondsPerSlice * 8), gapMs: 125, signal })
                : await udpTrain({ ...t, pps, seconds: secondsPerSlice, warmupMs: s === 0 ? 800 : 0, signal });
            const a = acc.get(t.key);
            a.meta = run;
            a.sent += run.sent || 0;
            const base = a.samples.length;
            (run.series || []).forEach((p, i) => a.samples.push({ seq: base + i, rtt: p.rtt }));
            a.series.push(...(run.series || []).map(p => ({ ...p, slice: s })));
            step++;
            if (onProgress) { try { onProgress({ step, total, key: t.key, slice: s, run }); } catch {} }
        }
        if (signal && signal.aborted) break;
    }

    const out = {};
    for (const [key, a] of acc) {
        const st = stats(a.samples, a.sent);
        out[key] = {
            ...st,
            score: score(st),
            ok: a.samples.length > 0,
            target: a.meta ? a.meta.target : key,
            proto: a.target.mode === 'tcp' ? 'tcp' : (a.target.proto || 'stun'),
            correlation: a.meta ? a.meta.correlation : null,
            label: a.target.label || key,
            series: a.series,
        };
    }
    return out;
}

module.exports = {
    resolve4, stats, score, udpTrain, tcpTrain, minecraftPing, interleaved, PROTO,
};

// ── measuring THROUGH an engine ─────────────────────────────────────────────────
//
// Mode 1 promises to compare paths honestly, and there is exactly one path in this app
// that can be measured side by side with `direct`: an engine that exposes SOCKS5 with UDP
// ASSOCIATE (Aether does). Everything else here — GitHub Tunnel, the V2Ray full tunnel —
// owns the single MLMVPN adapter system-wide, so measuring "through" it means bringing it
// up and taking the whole machine with it. Those are measured sequentially and the UI has
// to say so; this one is concurrent, which makes it the only fair comparison available.
//
// The SOCKS5 UDP relay (RFC 1928 §7): the TCP control connection must STAY OPEN for the
// association to live, and every datagram carries a 10-byte header naming the real
// destination. Closing the control socket silently kills the relay, which looks exactly
// like 100% packet loss — so the control socket is held for the whole train.

function socksUdpAssociate(socksPort, timeoutMs = 4000) {
    return new Promise((resolve, reject) => {
        const ctl = new net.Socket();
        let stage = 0;
        const fail = e => { try { ctl.destroy(); } catch {}; reject(e instanceof Error ? e : new Error(String(e))); };
        ctl.setTimeout(timeoutMs, () => fail(new Error('SOCKS5 پاسخ نداد')));
        ctl.once('error', fail);
        ctl.connect(socksPort, '127.0.0.1', () => ctl.write(Buffer.from([0x05, 0x01, 0x00])));
        ctl.on('data', buf => {
            if (stage === 0) {
                if (buf.length < 2 || buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error('SOCKS5 احراز هویت را رد کرد'));
                stage = 1;
                // UDP ASSOCIATE, client address unknown → 0.0.0.0:0
                ctl.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                return;
            }
            if (stage === 1) {
                if (buf.length < 10 || buf[0] !== 0x05) return fail(new Error('پاسخ SOCKS5 نامعتبر'));
                if (buf[1] !== 0x00) return fail(new Error(`موتور UDP را نپذیرفت (کد ${buf[1]})`));
                if (buf[3] !== 0x01) return fail(new Error('آدرس رله‌ی SOCKS5 قابل خواندن نیست'));
                const port = buf.readUInt16BE(8);
                stage = 2;
                ctl.setTimeout(0);
                // 0.0.0.0 from a local engine means "same host" — dial the loopback we know.
                resolve({ relayPort: port, ctl });
                return;
            }
        });
    });
}

/** SOCKS5 UDP request header for an IPv4 destination. */
function socksWrap(ip, port, payload) {
    const head = Buffer.alloc(10);
    head.writeUInt16BE(0, 0);          // RSV
    head.writeUInt8(0, 2);             // FRAG — never fragment
    head.writeUInt8(0x01, 3);          // ATYP = IPv4
    for (const [i, o] of ip.split('.').entries()) head.writeUInt8(Number(o), 4 + i);
    head.writeUInt16BE(port, 8);
    return Buffer.concat([head, payload]);
}

function socksUnwrap(buf) {
    if (buf.length < 10 || buf[2] !== 0x00) return null;   // drop fragments
    if (buf[3] === 0x01) return buf.slice(10);
    if (buf[3] === 0x04) return buf.slice(22);             // IPv6
    if (buf[3] === 0x03) return buf.slice(5 + buf[4] + 2); // domain
    return null;
}

/**
 * The same train as udpTrain(), but every datagram goes through an engine's SOCKS5 relay.
 * Identical statistics, so the two results are directly comparable — which is the point.
 */
function udpTrainViaSocks(opts) {
    const {
        host, ip, port, proto = 'stun', socksPort,
        pps = 20, seconds = 10, warmupMs = 1500, timeoutMs = 2500,
        onSample = null, signal = null,
    } = opts;
    const P = PROTO[proto];
    if (!P) return Promise.resolve({ error: `پروتکل ناشناخته: ${proto}` });

    return socksUdpAssociate(socksPort).then(({ relayPort, ctl }) => new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        const outstanding = new Map();
        const fifo = [];
        const sent = [];
        const samples = [];
        let challenge = null, seq = 0, closed = false, socketError = null;
        const t0 = now();

        const finish = () => {
            if (closed) return;
            closed = true;
            clearInterval(timer); clearTimeout(stopper);
            try { sock.close(); } catch {}
            try { ctl.destroy(); } catch {}
            const window = sent.filter(s => s.tx - t0 >= warmupMs);
            const kept = samples.filter(s => s.txRel >= warmupMs);
            const st = stats(kept, window.length);
            resolve({
                ok: kept.length > 0, target: `${host || ip}:${port}`, ip, port, proto,
                via: 'socks5', socksPort, correlation: P.correlation,
                error: kept.length ? null : (socketError || 'هیچ پاسخی از داخل تونل نیامد'),
                ...st, ...cadence(window, t0, pps), score: score(st),
                series: kept.map(s => ({ t: Math.round(s.txRel), rtt: Math.round(s.rtt) })),
            });
        };

        ctl.once('close', () => { if (!closed) { socketError = 'ارتباط کنترلی SOCKS5 قطع شد'; finish(); } });
        sock.on('error', err => { socketError = err.message; finish(); });

        sock.on('message', raw => {
            const at = now();
            const msg = socksUnwrap(raw);
            if (!msg) return;
            const m = P.match(msg);
            if (m === null) return;
            if (m && m.challenge) { challenge = m.challenge; return; }
            let hit = null;
            if (m === MATCH_FIFO) {
                const s = fifo.shift();
                if (s === undefined) return;
                hit = sent[s];
            } else {
                const rec = outstanding.get(Buffer.isBuffer(m) ? m.toString('hex') : String(m));
                if (!rec) return;
                outstanding.delete(Buffer.isBuffer(m) ? m.toString('hex') : String(m));
                hit = sent[rec.seq];
            }
            if (!hit || hit.done) return;
            hit.done = true;
            samples.push({ seq: hit.seq, rtt: at - hit.tx, txRel: hit.tx - t0 });
            if (onSample) { try { onSample({ seq: hit.seq, rtt: at - hit.tx }); } catch {} }
        });

        const timer = setInterval(() => {
            if (closed) return;
            if (signal && signal.aborted) return finish();
            const s = seq++;
            const token = P.token();
            sent[s] = { seq: s, tx: now(), done: false };
            if (token) outstanding.set(token.toString('hex'), { seq: s });
            else fifo.push(s);
            sock.send(socksWrap(ip, port, P.build(token, challenge)), relayPort, '127.0.0.1',
                err => { if (err && !socketError) socketError = err.message; });
        }, Math.max(4, 1000 / pps));

        const stopper = setTimeout(() => { clearInterval(timer); setTimeout(finish, timeoutMs); }, seconds * 1000);
    })).catch(err => ({
        ok: false, target: `${host || ip}:${port}`, ip, port, proto, via: 'socks5', socksPort,
        error: err.message, n: 0, sent: 0, loss: 100, score: 0, series: [],
    }));
}

module.exports.socksUdpAssociate = socksUdpAssociate;
module.exports.udpTrainViaSocks = udpTrainViaSocks;
