/*
 * The measurement core, against servers whose behaviour is known exactly.
 *
 * WHY THIS SUITE EXISTS
 * Every number this feature shows a user — and every verdict built on those numbers —
 * comes out of game/probe.js. On the open internet there is no ground truth: if the engine
 * reported 3% loss to a STUN server, nobody could say whether the line dropped packets or
 * the parser did. So the servers here are ours, on loopback, and they misbehave on purpose:
 * a fixture that drops exactly every fifth packet lets "loss = 20%" be checked rather than
 * believed.
 *
 * Loopback also removes the one thing that makes network tests flaky — the network. These
 * suites open sockets, but only to 127.0.0.1, and every server is closed in a finally block.
 *
 * WHAT EACH FIXTURE PINS
 *   fiveM/raknet   the token-correlated path: a reply is tied to its request, so RTT is
 *                  exact even when replies arrive out of order.
 *   a2s            the FIFO path, including the challenge handshake that modern Source
 *                  servers require. This is the weaker correlation and it is labelled as
 *                  such in every result; the suite pins that label.
 *   loss           injected, known, and compared against what stats() reports.
 *   latency        injected as a fixed floor plus jitter, so min/p95 can be bounded.
 *   silence        a server that answers nothing must produce ok:false and 100% loss —
 *                  never a cheerful zero.
 */
'use strict';

const path = require('path');
const dgram = require('dgram');
const ROOT = path.resolve(__dirname, '..', '..');
const probe = require(ROOT + '/game/probe');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const near = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;

/**
 * A UDP server that speaks one of the game query protocols back at us.
 *
 * `behaviour` decides how it misbehaves:
 *   dropEvery   drop every Nth request outright (0 = never)
 *   delayMs     fixed delay before answering
 *   jitterMs    extra uniform random delay on top
 */
function fixture(proto, { dropEvery = 0, delayMs = 0, jitterMs = 0 } = {}) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        let n = 0;
        const timers = new Set();

        sock.on('message', (msg, rinfo) => {
            n++;
            if (dropEvery && n % dropEvery === 0) return;

            let reply = null;
            if (proto === 'fivem') {
                // Echo the challenge exactly the way a cfx server does.
                const token = msg.slice(4).toString('ascii').replace('getinfo ', '').trim();
                reply = Buffer.from(
                    '\xff\xff\xff\xffinfoResponse\n\\challenge\\' + token + '\\sv_maxclients\\48\\clients\\7',
                    'latin1');
            } else if (proto === 'raknet') {
                // 0x1C + the 8-byte time field we sent, echoed back.
                reply = Buffer.concat([Buffer.from([0x1C]), msg.slice(1, 9), Buffer.alloc(8)]);
            } else if (proto === 'a2s') {
                // A2S carries no transaction id at all: the reply is just "here is the info".
                reply = Buffer.concat([Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x49]), Buffer.from('MLMVPN test')]);
            }
            if (!reply) return;

            const wait = delayMs + (jitterMs ? Math.random() * jitterMs : 0);
            const send = () => sock.send(reply, rinfo.port, rinfo.address, () => {});
            if (wait > 0) {
                const id = setTimeout(() => { timers.delete(id); send(); }, wait);
                timers.add(id);
            } else send();
        });

        sock.bind(0, '127.0.0.1', () => resolve({
            port: sock.address().port,
            close() { for (const id of timers) clearTimeout(id); try { sock.close(); } catch {} },
        }));
    });
}

/** A server that binds a port and then says nothing at all. */
function silent() {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        sock.bind(0, '127.0.0.1', () => resolve({
            port: sock.address().port,
            close() { try { sock.close(); } catch {} },
        }));
    });
}

(async () => {
    // ── stats(), on synthetic samples where every answer is known by hand ────────────
    {
        // 70 is deliberately above min+50, not exactly on it: `spikes` counts strictly
        // greater, so a sample sitting exactly on the threshold is not a spike.
        const s = probe.stats(
            [10, 12, 11, 70, 13, 14].map((rtt, seq) => ({ seq, rtt })),
            8);   // 8 sent, 6 answered
        t('stats(): loss comes from what was SENT, not from the survivors',
            s.loss === 25, `got ${s.loss}`);
        t('stats(): min is the floor', s.min === 10, `got ${s.min}`);
        t('stats(): a single outlier moves p95 but not p50',
            s.p50 <= 14 && s.p95 >= 14, `p50=${s.p50} p95=${s.p95}`);
        t('stats(): spikes counts samples above min+50ms',
            s.spikes === 1, `got ${s.spikes}`);
        t('stats(): spread is p95 minus min — the felt jitter',
            s.spread === s.p95 - s.min, `${s.spread} vs ${s.p95 - s.min}`);

        const empty = probe.stats([], 20);
        t('stats(): nothing answered means 100% loss, not 0',
            empty.loss === 100 && empty.n === 0, JSON.stringify(empty));
        t('stats(): nothing answered leaves latencies null, never 0',
            empty.min === null && empty.p95 === null, JSON.stringify(empty));

        const reordered = probe.stats(
            [{ seq: 0, rtt: 10 }, { seq: 2, rtt: 10 }, { seq: 1, rtt: 10 }], 3);
        t('stats(): a reply arriving after a later-sequenced one is counted as reordering',
            reordered.reorder === 1, `got ${reordered.reorder}`);
    }

    // ── score(), the ranking philosophy ──────────────────────────────────────────────
    {
        const steady = probe.stats(Array.from({ length: 60 }, (_, seq) => ({ seq, rtt: 200 + (seq % 3) })), 60);
        const spiky = probe.stats(Array.from({ length: 60 }, (_, seq) => ({ seq, rtt: seq % 10 === 0 ? 600 : 90 })), 60);
        t('score(): a steady 200ms path beats a 90ms path that spikes — the whole ranking thesis',
            probe.score(steady) > probe.score(spiky),
            `steady=${probe.score(steady)} spiky=${probe.score(spiky)}`);

        const lossy = probe.stats(Array.from({ length: 45 }, (_, seq) => ({ seq, rtt: 90 })), 60);
        const clean = probe.stats(Array.from({ length: 60 }, (_, seq) => ({ seq, rtt: 120 })), 60);
        t('score(): 25% loss loses to 30ms of extra latency',
            probe.score(clean) > probe.score(lossy),
            `clean=${probe.score(clean)} lossy=${probe.score(lossy)}`);
        t('score(): an empty measurement scores 0, never a default',
            probe.score(probe.stats([], 10)) === 0);
    }

    // ── the token-correlated path, clean ─────────────────────────────────────────────
    {
        const srv = await fixture('fivem');
        try {
            const r = await probe.udpTrain({
                host: '127.0.0.1', ip: '127.0.0.1', port: srv.port,
                proto: 'fivem', pps: 50, seconds: 1.5, warmupMs: 200,
            });
            t('fivem: a healthy loopback server answers everything', r.ok && r.loss === 0, `loss=${r.loss} n=${r.n}`);
            t('fivem: is reported as token-correlated', r.correlation === 'token', r.correlation);
            t('fivem: loopback RTT is sub-millisecond, not a fabricated number',
                near(r.min, 0, 5), `min=${r.min}`);
            // Windows cannot actually deliver 50pps — its timer resolution flattens the
            // achieved rate out around 30/s. What matters is that the result SAYS what it
            // achieved instead of repeating what was asked for.
            t('fivem: the achieved cadence is reported, not assumed',
                r.ppsAchieved !== null && r.ppsAchieved !== r.ppsRequested,
                `requested=${r.ppsRequested} achieved=${r.ppsAchieved}`);
            t('fivem: the sample count is consistent with the achieved cadence',
                near(r.n, r.ppsAchieved * 1.0, r.ppsAchieved * 1.6),
                `n=${r.n} achieved=${r.ppsAchieved}/s over ~1.3s`);
        } finally { srv.close(); }
    }

    // ── injected loss, checked against ground truth ──────────────────────────────────
    {
        const srv = await fixture('fivem', { dropEvery: 5 });
        try {
            const r = await probe.udpTrain({
                host: '127.0.0.1', ip: '127.0.0.1', port: srv.port,
                proto: 'fivem', pps: 50, seconds: 2, warmupMs: 200,
            });
            t('fivem: a server dropping every 5th packet is measured as ~20% loss',
                near(r.loss, 15, 25), `got ${r.loss}%`);
            t('fivem: the surviving samples are still timed correctly',
                near(r.min, 0, 5), `min=${r.min}`);
        } finally { srv.close(); }
    }

    // ── injected latency and jitter ──────────────────────────────────────────────────
    {
        const srv = await fixture('fivem', { delayMs: 25, jitterMs: 40 });
        try {
            const r = await probe.udpTrain({
                host: '127.0.0.1', ip: '127.0.0.1', port: srv.port,
                proto: 'fivem', pps: 40, seconds: 2, warmupMs: 300,
            });
            t('fivem: a 25ms floor shows up as min >= 25',
                near(r.min, 24, 45), `min=${r.min}`);
            t('fivem: 40ms of added jitter widens p95 well past min',
                r.p95 - r.min > 10, `min=${r.min} p95=${r.p95}`);
            t('fivem: RFC3550 jitter is non-zero on a jittery path',
                r.jitter > 1, `jitter=${r.jitter}`);
        } finally { srv.close(); }
    }

    // ── RakNet, the other token protocol ─────────────────────────────────────────────
    {
        const srv = await fixture('raknet');
        try {
            const r = await probe.udpTrain({
                host: '127.0.0.1', ip: '127.0.0.1', port: srv.port,
                proto: 'raknet', pps: 40, seconds: 1.2, warmupMs: 200,
            });
            t('raknet: unconnected ping round-trips and is correlated',
                r.ok && r.loss === 0 && r.correlation === 'token', `loss=${r.loss} n=${r.n}`);
        } finally { srv.close(); }
    }

    // ── A2S, the FIFO path ───────────────────────────────────────────────────────────
    {
        const srv = await fixture('a2s');
        try {
            const r = await probe.udpTrain({
                host: '127.0.0.1', ip: '127.0.0.1', port: srv.port,
                proto: 'a2s', pps: 30, seconds: 1.5, warmupMs: 200,
            });
            t('a2s: A2S_INFO round-trips', r.ok && r.n > 10, `n=${r.n}`);
            t('a2s: is labelled FIFO, because the protocol has no transaction id',
                r.correlation === 'fifo', r.correlation);
        } finally { srv.close(); }
    }

    // ── a server that never answers ──────────────────────────────────────────────────
    {
        const srv = await silent();
        try {
            const r = await probe.udpTrain({
                host: '127.0.0.1', ip: '127.0.0.1', port: srv.port,
                proto: 'fivem', pps: 25, seconds: 1, warmupMs: 100, timeoutMs: 400,
            });
            t('silence: ok is false, not a cheerful empty result', r.ok === false, JSON.stringify(r.error));
            t('silence: loss is 100%', r.loss === 100, `got ${r.loss}`);
            t('silence: an error is stated rather than left null', !!r.error, String(r.error));
            t('silence: score is 0', r.score === 0, `got ${r.score}`);
        } finally { srv.close(); }
    }

    // ── interleaving actually alternates ─────────────────────────────────────────────
    //
    // The methodology claim behind every comparison this feature makes is that targets are
    // measured round-robin rather than back to back. If that ever regressed into sequential
    // passes, every A-vs-B verdict would be comparing two different minutes of an Iranian
    // international link. So the order of progress events is pinned.
    {
        const a = await fixture('fivem');
        const b = await fixture('fivem', { delayMs: 15 });
        try {
            const order = [];
            const out = await probe.interleaved([
                { key: 'a', label: 'A', mode: 'udp', proto: 'fivem', host: '127.0.0.1', ip: '127.0.0.1', port: a.port },
                { key: 'b', label: 'B', mode: 'udp', proto: 'fivem', host: '127.0.0.1', ip: '127.0.0.1', port: b.port },
            ], { slices: 3, secondsPerSlice: 0.5, pps: 40, onProgress: p => order.push(p.key) });

            t('interleaved: targets alternate rather than running back to back',
                order.join(',') === 'a,b,a,b,a,b', order.join(','));
            t('interleaved: every target produces a result', out.a && out.b && out.a.ok && out.b.ok);
            // Three slices of 0.5s. Even at the ~30pps ceiling Windows imposes, pooling all
            // three must produce meaningfully more than one slice would on its own.
            t('interleaved: samples from all slices are pooled, not just the last',
                out.a.n > 25, `n=${out.a.n}`);
            t('interleaved: the slower fixture measures slower — the comparison is real',
                out.b.min > out.a.min, `a=${out.a.min} b=${out.b.min}`);
        } finally { a.close(); b.close(); }
    }

    // ── SOCKS5 refusal is reported, not silently swallowed ───────────────────────────
    {
        const r = await probe.udpTrainViaSocks({
            host: '127.0.0.1', ip: '127.0.0.1', port: 9, proto: 'stun',
            socksPort: 1, pps: 10, seconds: 0.5,
        });
        t('socks: a dead SOCKS port yields ok:false with a stated reason, not a crash',
            r.ok === false && !!r.error, JSON.stringify(r.error));
    }

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('SUITE CRASHED', e); process.exit(1); });
