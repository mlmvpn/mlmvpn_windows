// The DNS bridge: message handling, caching, transport learning and de-duplication.
//
// Nothing here touches the network. The SOCKS forwarder is replaced so the bridge's own
// logic — which is where the real bugs have been — can be exercised deterministically.
const ROOT = require('path').resolve(__dirname, '..', '..');
const net = require('net');
const dgram = require('dgram');
const assert = require('assert');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── a fake SOCKS5 engine ─────────────────────────────────────────────────────────
// Speaks just enough of the protocol for the bridge, and counts what it is asked to do so
// the de-duplication and transport-learning claims can be measured rather than assumed.
function makeFakeSocks({ allowUdp = true } = {}) {
    const stats = { tcpConnects: 0, udpAssociates: 0, tcpQueries: 0, udpQueries: 0 };
    const relay = dgram.createSocket('udp4');
    relay.on('message', (msg, rinfo) => {
        stats.udpQueries++;
        // strip the SOCKS5 UDP request header (RSV RSV FRAG ATYP + 4-byte addr + 2-byte port)
        const query = msg.slice(10);
        const answer = buildAnswer(query);
        const head = Buffer.from([0x00, 0x00, 0x00, 0x01, 1, 1, 1, 1, 0, 53]);
        relay.send(Buffer.concat([head, answer]), rinfo.port, rinfo.address);
    });

    const srv = net.createServer((sock) => {
        stats.tcpConnects++;
        let phase = 'greet';
        let buf = Buffer.alloc(0);
        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (phase === 'greet') {
                if (buf.length < 3) return;
                buf = buf.slice(3);
                phase = 'cmd';
                sock.write(Buffer.from([0x05, 0x00]));
                if (buf.length === 0) return;
            }
            if (phase === 'cmd') {
                if (buf.length < 10) return;
                const cmd = buf[1];
                buf = buf.slice(10);
                if (cmd === 0x03) {                       // UDP ASSOCIATE
                    stats.udpAssociates++;
                    if (!allowUdp) { sock.write(Buffer.from([0x05, 0x07, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
                    const p = relay.address().port;
                    const rep = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, p >> 8, p & 0xff]);
                    sock.write(rep);
                    phase = 'udp';
                    return;
                }
                sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 1, 1, 1, 1, 0, 53]));
                phase = 'tcpdns';
                if (buf.length === 0) return;
            }
            if (phase === 'tcpdns') {
                while (buf.length >= 2) {
                    const len = buf.readUInt16BE(0);
                    if (buf.length < 2 + len) break;
                    const query = buf.slice(2, 2 + len);
                    buf = buf.slice(2 + len);
                    stats.tcpQueries++;
                    const a = buildAnswer(query);
                    const out = Buffer.alloc(2 + a.length);
                    out.writeUInt16BE(a.length, 0);
                    a.copy(out, 2);
                    sock.write(out);
                }
            }
        });
        sock.on('error', () => {});
    });
    return { srv, relay, stats };
}

// A minimal well-formed answer: echo the question, one A record, TTL 60.
function buildAnswer(query) {
    let pos = 12;
    while (pos < query.length && query[pos] !== 0) pos += query[pos] + 1;
    const qEnd = pos + 5;                       // null label + qtype(2) + qclass(2)
    const head = Buffer.from(query.slice(0, qEnd));
    head.writeUInt16BE(0x8180, 2);              // response, no error
    head.writeUInt16BE(1, 6);                   // ANCOUNT = 1
    const rr = Buffer.concat([
        Buffer.from([0xc0, 0x0c]),              // pointer to the question name
        Buffer.from([0x00, 0x01, 0x00, 0x01]),  // A, IN
        Buffer.from([0x00, 0x00, 0x00, 0x3c]),  // TTL 60
        Buffer.from([0x00, 0x04]),              // RDLENGTH
        Buffer.from([93, 184, 216, 34]),
    ]);
    return Buffer.concat([head, rr]);
}

function makeQuery(name, id) {
    const q = [id >> 8, id & 0xff, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    for (const label of name.split('.')) {
        q.push(label.length);
        for (let i = 0; i < label.length; i++) q.push(label.charCodeAt(i));
    }
    q.push(0x00, 0x00, 0x01, 0x00, 0x01);
    return Buffer.from(q);
}

(async () => {
    const bridge = require(ROOT + '/aether-dns-bridge');

    // ── UDP path ─────────────────────────────────────────────────────────────────
    const fake = makeFakeSocks({ allowUdp: true });
    await new Promise(r => fake.relay.bind(0, '127.0.0.1', r));
    await new Promise(r => fake.srv.listen(0, '127.0.0.1', r));
    const port = fake.srv.address().port;

    bridge.resetTransport();
    await bridge.testResolve('example.com', port);
    t('a lookup is carried over SOCKS5 UDP when the engine supports it', fake.stats.udpQueries >= 1,
        JSON.stringify(fake.stats));

    // ── transaction IDs ──────────────────────────────────────────────────────────
    // The cache stores the answer body; each caller must get ITS OWN id stamped back in.
    // Storing answer.slice(2) once shifted every cached reply two bytes left and overwrote
    // the FLAGS field — malformed for every repeated lookup, which Windows answers by giving
    // up on the resolver and falling back to the ISP's. The leak-free bridge leaking.
    await new Promise(r => setTimeout(r, 50));
    // Replies are correlated by transaction ID, not by arrival order.
    //
    // A `once('message')` per request looks right and is not: Node delivers each datagram to
    // every registered listener, so five concurrent requests all resolve with the FIRST reply
    // and the test then "proves" that every caller got the same id. That is a bug in the
    // harness, and it would have been reported as a bug in the bridge.
    const sock = dgram.createSocket('udp4');
    const pending = new Map();
    sock.on('message', (m) => {
        if (m.length < 2) return;
        const id = m.readUInt16BE(0);
        const waiter = pending.get(id);
        if (waiter) { pending.delete(id); clearTimeout(waiter.timer); waiter.resolve(m); }
    });
    const ask = (name, id) => new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 6000);
        pending.set(id, { resolve, timer });
        sock.send(makeQuery(name, id), bridgePort, '127.0.0.1');
    });

    let bridgePort;
    const started = await bridge.start(port);
    bridgePort = started.port;

    const a1 = await ask('cache-check.example', 0x1234);
    t('the reply carries the caller transaction id', a1.readUInt16BE(0) === 0x1234,
        '0x' + a1.readUInt16BE(0).toString(16));
    t('the reply is a well-formed response (QR set, no error)', (a1.readUInt16BE(2) & 0x8000) !== 0,
        '0x' + a1.readUInt16BE(2).toString(16));
    t('the reply carries an answer record', a1.readUInt16BE(6) === 1);

    const before = fake.stats.udpQueries + fake.stats.tcpQueries;
    const a2 = await ask('cache-check.example', 0xbeef);
    const after = fake.stats.udpQueries + fake.stats.tcpQueries;
    t('a repeated question is served from cache, not re-asked upstream', after === before,
        `${before} -> ${after}`);
    t('the CACHED reply still carries the second caller own id, not the first one',
        a2.readUInt16BE(0) === 0xbeef, '0x' + a2.readUInt16BE(0).toString(16));
    t('the cached reply is not shifted: flags survive intact', (a2.readUInt16BE(2) & 0x8000) !== 0,
        '0x' + a2.readUInt16BE(2).toString(16));
    t('the cached reply still has its answer record', a2.readUInt16BE(6) === 1);

    // ── in-flight de-duplication ─────────────────────────────────────────────────
    // Windows asks the same question on every configured resolver at once. Without folding
    // them, each one opens its own control connection and its own UDP socket through the
    // tunnel — the single largest source of latency here, and a real risk of ephemeral port
    // exhaustion under load.
    const beforeDup = fake.stats.udpQueries + fake.stats.tcpQueries;
    const many = await Promise.all([0xaa01, 0xaa02, 0xaa03, 0xaa04, 0xaa05]
        .map(id => ask('burst.example', id).catch(e => e)));
    const afterDup = fake.stats.udpQueries + fake.stats.tcpQueries;
    t('five simultaneous identical questions cost ONE upstream round trip',
        afterDup - beforeDup === 1, `${beforeDup} -> ${afterDup}`);
    t('and every one of them still gets its own transaction id back',
        many.every(m => Buffer.isBuffer(m)) &&
        new Set(many.map(m => m.readUInt16BE(0))).size === 5,
        many.map(m => Buffer.isBuffer(m) ? '0x' + m.readUInt16BE(0).toString(16) : String(m)).join(','));

    sock.close();
    await bridge.stop();
    fake.srv.close(); fake.relay.close();

    // ── a UDP-less engine ────────────────────────────────────────────────────────
    // The old code retried UDP on EVERY query, paying a 5s timeout each time before falling
    // back to TCP. Windows gives up on a resolver after about a second and moves to the next
    // configured one — the ISP's. The timeout structure of the leak-prevention was itself
    // the leak.
    const noUdp = makeFakeSocks({ allowUdp: false });
    await new Promise(r => noUdp.relay.bind(0, '127.0.0.1', r));
    await new Promise(r => noUdp.srv.listen(0, '127.0.0.1', r));
    const p2 = noUdp.srv.address().port;

    bridge.resetTransport();
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await bridge.testResolve(`no-udp-${i}.example`, p2);
    const elapsed = Date.now() - t0;

    t('a UDP-less engine still resolves — over TCP, inside the tunnel', noUdp.stats.tcpQueries >= 5,
        JSON.stringify(noUdp.stats));
    t('the engine is only probed for UDP a few times, then remembered',
        noUdp.stats.udpAssociates <= 3, `associates=${noUdp.stats.udpAssociates}`);
    t('so five lookups do not cost five UDP timeouts', elapsed < 5000, `${elapsed}ms`);

    noUdp.srv.close(); noUdp.relay.close();

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('SUITE CRASHED:', e); process.exit(1); });
