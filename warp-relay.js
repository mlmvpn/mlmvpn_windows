// --- «وارپ»: the shim that lets a NORMAL WireGuard talk to Cloudflare WARP ---
//
// THE PROBLEM, measured 2026-09-21. Cloudflare's WARP edge does not speak plain WireGuard. It
// carries the account's `client_id` in the three "reserved" bytes of the header — and it ECHOES
// them back on every packet it sends:
//
//     our initiation  ... client_id = [7, 9, 86]
//     its response    ... reserved  = [7, 9, 86]   <- not zero
//
// The spec says those bytes are reserved and zero, and a normal implementation discards a packet
// where they are not. So `core/xray.exe` and `core/sing-box.exe` both send handshake initiations
// for ever and never see a single response:
//
//     peer(bmXO…fgyo) - Sending handshake initiation
//     peer(bmXO…fgyo) - Sending handshake initiation     (every 5 s, no reply logged)
//
// …while aether, on the very same edge in the same minute, carries traffic. It does so because it
// patches the bytes itself at the socket: `inject_client_id` on the way out, `strip_client_id` on
// the way in (wireguard.rs). Nothing else in this app does that, which is the whole reason a WARP
// engine built on our own shipped binaries could not connect.
//
// THE SHIM. A UDP relay on loopback that performs exactly those two edits:
//
//     xray  --(reserved = 0)-->  relay  --(reserved = client_id)-->  Cloudflare
//     xray  <--(reserved = 0)--  relay  <--(reserved = client_id)--  Cloudflare
//
// The engine then points its WireGuard peer at `127.0.0.1:<relay>` and needs to know nothing
// about WARP at all. Sixty lines instead of a new binary, and it works with any WireGuard that
// can be told to dial a local address.
//
// Only WireGuard's own message types are touched (1 initiation, 2 response, 3 cookie, 4 data).
// Anything else is passed through untouched rather than corrupted — a relay that rewrites bytes
// it does not understand is worse than no relay.

'use strict';

const dgram = require('dgram');

const WG_MSG_MIN = 1;
const WG_MSG_MAX = 4;

/** Write the three bytes, but only into something that really is a WireGuard packet. */
function patch(buf, a, b, c) {
    if (buf.length < 4) return buf;
    if (buf[0] < WG_MSG_MIN || buf[0] > WG_MSG_MAX) return buf;
    buf[1] = a; buf[2] = b; buf[3] = c;
    return buf;
}

/**
 * Start a relay in front of one Cloudflare edge.
 *
 * @param {{ip:string, port:number}} target    the WARP endpoint
 * @param {number[]} reserved                  the account's client_id, three bytes
 * @returns {Promise<{port:number, close:Function, stats:Function}>} the loopback port to dial
 */
function createRelay(target, reserved) {
    const [r0, r1, r2] = reserved && reserved.length === 3 ? reserved : [0, 0, 0];
    return new Promise((resolve, reject) => {
        // TWO sockets, and this is not tidiness. A socket bound to 127.0.0.1 can only reach the
        // loopback interface, so a single-socket relay accepts the engine's packets and then
        // sends them nowhere — measured as `up=2 down=0`, which reads exactly like a dead edge.
        // So: `inbound` is loopback-only, which is what keeps this from being an open relay for
        // anything else on the network, and `outbound` is unbound and talks to Cloudflare.
        const inbound = dgram.createSocket('udp4');
        const outbound = dgram.createSocket('udp4');

        // WireGuard is one peer over one socket, so the first sender IS the engine; remembering
        // where it spoke from is how the replies find their way home.
        let client = null;
        let up = 0;
        let down = 0;
        let settled = false;

        const fail = (e) => {
            if (!settled) { settled = true; try { inbound.close(); } catch (x) {} try { outbound.close(); } catch (x) {} reject(e); return; }
        };
        inbound.on('error', fail);
        outbound.on('error', fail);

        inbound.on('message', (buf, rinfo) => {
            if (rinfo.address !== '127.0.0.1') return;
            client = rinfo;
            up++;
            outbound.send(patch(buf, r0, r1, r2), target.port, target.ip);
        });

        outbound.on('message', (buf, rinfo) => {
            if (rinfo.address !== target.ip || rinfo.port !== target.port) return;
            if (!client) return;                    // nothing has asked yet
            down++;
            // Zero them, so an ordinary WireGuard accepts the packet instead of discarding it.
            inbound.send(patch(buf, 0, 0, 0), client.port, client.address);
        });

        outbound.bind(0, () => {
            inbound.bind(0, '127.0.0.1', () => {
                settled = true;
                resolve({
                    port: inbound.address().port,
                    stats: () => ({ up, down, client: !!client }),
                    close: () => new Promise((res) => {
                        let n = 2;
                        const one = () => { if (--n <= 0) res(); };
                        try { inbound.close(one); } catch (e) { one(); }
                        try { outbound.close(one); } catch (e) { one(); }
                    }),
                });
            });
        });
    });
}

module.exports = { createRelay, _internal: { patch } };
