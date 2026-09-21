// Which resolver the full tunnel asks — measured through the engine, not assumed.
//
// The V2Ray tunnel used a fixed 1.1.1.1 for every lookup. On the user's own worker node
// (trojan over WebSocket to workers.dev) that address is unreachable — a Cloudflare Worker
// may not open a socket to a Cloudflare address — so UDP failed, the TCP fallback failed the
// same way, and the tunnel came up with every name lookup dead: "the tunnel is on and
// nothing passes". These tests drive tun.pickTunnelResolver against fake SOCKS5 engines that
// behave like that worker, like a VPS, and like a node that carries nothing.
//
// Loopback only; nothing reaches the network.
const ROOT = require('path').resolve(__dirname, '..', '..');
const net = require('net');
const dgram = require('dgram');
const tun = require(ROOT + '/tun-manager');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

/**
 * A SOCKS5 engine. `tcp(ip)` says whether a TCP connect to ip:53 reaches a resolver,
 * `udp` whether UDP ASSOCIATE works at all (and `udpTo(ip)` for which targets). Like Xray,
 * it reports CONNECT success before it knows whether the far side is reachable.
 */
function fakeEngine({ tcp = () => false, udp = false, udpTo = () => true, wrongId = false } = {}) {
    const relay = dgram.createSocket('udp4');
    relay.on('message', (msg, rinfo) => {
        const ip = `${msg[4]}.${msg[5]}.${msg[6]}.${msg[7]}`;
        if (!udpTo(ip)) return;                                   // dropped, as a worker does
        relay.send(Buffer.concat([msg.slice(0, 10), msg.slice(10, 12), Buffer.from([0x81, 0x80])]), rinfo.port, rinfo.address);
    });
    const server = net.createServer((sock) => {
        let stage = 'greeting';
        let target = null;
        sock.on('error', () => {});
        sock.on('data', (buf) => {
            if (stage === 'greeting') { stage = 'request'; sock.write(Buffer.from([0x05, 0x00])); return; }
            if (stage === 'request') {
                if (buf[1] === 0x03) {                                // UDP ASSOCIATE
                    if (!udp) { sock.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])); return; }
                    const p = relay.address().port;
                    sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, p >> 8, p & 0xff]));
                    stage = 'udp';
                    return;
                }
                target = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
                sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                stage = 'connected';
                return;
            }
            if (stage === 'connected') {
                if (!tcp(target)) { sock.destroy(); return; }         // the worker's connect() refused
                const id = wrongId ? Buffer.from([0x00, 0x00]) : buf.slice(2, 4);
                const reply = Buffer.concat([id, Buffer.from([0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0])]);
                const len = Buffer.alloc(2);
                len.writeUInt16BE(reply.length);
                sock.write(Buffer.concat([len, reply]));
            }
        });
    });
    return new Promise((resolve) => relay.bind(0, '127.0.0.1', () =>
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            close: () => { server.close(); relay.close(); },
        }))));
}

const CLOUDFLARE = new Set(['1.1.1.1', '1.0.0.1']);

(async () => {
    const quick = { timeoutMs: 1500 };

    // The user's worker: no UDP, and no socket to a Cloudflare address.
    let e = await fakeEngine({ tcp: (ip) => !CLOUDFLARE.has(ip), udp: false });
    t('worker node: 1.1.1.1 over TCP is dead (the old fixed resolver)', (await tun.socksResolvesTcp(e.port, { host: '1.1.1.1', ...quick })) === false);
    t('worker node: 8.8.8.8 over TCP answers', (await tun.socksResolvesTcp(e.port, { host: '8.8.8.8', ...quick })) === true);
    let pick = await tun.pickTunnelResolver(e.port, quick);
    t('worker node: the tunnel is built on 8.8.8.8 over TCP', pick && pick.server === '8.8.8.8' && pick.udp === false, JSON.stringify(pick));
    e.close();

    // A worker that carries UDP for DNS, but whose UDP to a Cloudflare address goes nowhere.
    e = await fakeEngine({ tcp: (ip) => !CLOUDFLARE.has(ip), udp: true, udpTo: (ip) => !CLOUDFLARE.has(ip) });
    pick = await tun.pickTunnelResolver(e.port, quick);
    t('worker with UDP: 8.8.8.8 over UDP', pick && pick.server === '8.8.8.8' && pick.udp === true, JSON.stringify(pick));
    e.close();

    // A VPS: everything works; Google first, over UDP.
    e = await fakeEngine({ tcp: () => true, udp: true });
    pick = await tun.pickTunnelResolver(e.port, quick);
    t('VPS node: the first candidate, over UDP', pick && pick.server === '8.8.8.8' && pick.udp === true, JSON.stringify(pick));
    e.close();

    // A node that reaches only one resolver still gets a tunnel.
    e = await fakeEngine({ tcp: (ip) => ip === '9.9.9.9', udp: false });
    pick = await tun.pickTunnelResolver(e.port, quick);
    t('a node that reaches only 9.9.9.9 is built on 9.9.9.9', pick && pick.server === '9.9.9.9' && pick.udp === false, JSON.stringify(pick));
    e.close();

    // A node that carries no lookups at all: no tunnel.
    e = await fakeEngine({ tcp: () => false, udp: false });
    pick = await tun.pickTunnelResolver(e.port, quick);
    t('a node that carries no lookups gets NO tunnel (null), instead of one where nothing resolves', pick === null, JSON.stringify(pick));
    e.close();

    // "Connect succeeded" is not an answer; neither is someone else's reply.
    e = await fakeEngine({ tcp: () => true, wrongId: true });
    t('a reply that is not to our query does not count', (await tun.socksResolvesTcp(e.port, { host: '8.8.8.8', ...quick })) === false);
    e.close();
    t('nothing listening is a clean false, not a throw', (await tun.socksResolvesTcp(1, { host: '8.8.8.8', ...quick })) === false);
    t('a malformed address is refused up front', (await tun.socksResolvesTcp(1, { host: 'dns.google', ...quick })) === false);

    // The measured resolver lands in the config; Aether keeps its own.
    const v2 = tun.buildTunConfig(20808, { processName: 'xray.exe', engineTag: 'v2ray', uplinkCidrs: [], remoteDns: '8.8.8.8', supportsUdp: false });
    const remote = v2.dns.servers.find((s) => s.tag === 'remote');
    t('config: the tunnel asks the measured resolver, through the engine',
        remote.server === '8.8.8.8' && remote.type === 'tcp' && remote.detour === 'v2ray', JSON.stringify(remote));
    const aether = tun.buildTunConfig(20810, {});
    t('config: Aether (WARP, where 1.1.1.1 is reachable) is unchanged',
        aether.dns.servers.find((s) => s.tag === 'remote').server === '1.1.1.1');

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
