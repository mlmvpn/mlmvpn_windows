// --- HTTP(S) agents that dial through a local SOCKS5 port and actually pool sockets ---
//
// Extracted from server.js so the free-config tester measures delay with the SAME code the
// nodes tab uses. Two testers with two implementations produce two different numbers for
// the same node, and then nobody can say which one is lying.
//
// Why not SocksProxyAgent: measured against a live probe URL it opened a brand new
// TCP+SOCKS+TLS connection for every request (four sequential requests, four fresh sockets
// when tagged). Every "ping" it produced was a full cold handshake — 690ms cold vs 158ms
// warm on the same tunnel. Overriding `createConnection` on a real Agent hands Node a ready
// socket and lets its own keep-alive pooling do the job, so the second shot rides the
// tunnel that is already up.

const http = require('http');
const https = require('https');
const tls = require('tls');

class SocksTlsAgent extends https.Agent {
    constructor(socksPort) {
        super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
        this.socksPort = socksPort;
    }
    createConnection(options, cb) {
        const { SocksClient } = require('socks');
        SocksClient.createConnection({
            proxy: { host: '127.0.0.1', port: this.socksPort, type: 5 },
            command: 'connect',
            destination: { host: options.host, port: Number(options.port) || 443 },
            // v2rayN: SocketsHttpHandler.ConnectTimeout = 3s
            timeout: 3000,
        }).then(({ socket }) => {
            cb(null, tls.connect({ socket, servername: options.host, rejectUnauthorized: false }));
        }).catch(err => cb(err));
    }
}

/** Same idea for a plain-HTTP probe URL (e.g. msftconnecttest.com): no TLS layer. */
class SocksHttpAgent extends http.Agent {
    constructor(socksPort) {
        super({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
        this.socksPort = socksPort;
    }
    createConnection(options, cb) {
        const { SocksClient } = require('socks');
        SocksClient.createConnection({
            proxy: { host: '127.0.0.1', port: this.socksPort, type: 5 },
            command: 'connect',
            destination: { host: options.host, port: Number(options.port) || 80 },
            timeout: 3000,
        }).then(({ socket }) => cb(null, socket)).catch(err => cb(err));
    }
}

module.exports = { SocksTlsAgent, SocksHttpAgent };
