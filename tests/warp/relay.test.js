// The client_id shim — warp-relay.js.
//
// WHY IT EXISTS AT ALL (measured 2026-09-21): Cloudflare's WARP edge carries the account's
// client_id in WireGuard's three "reserved" header bytes and ECHOES them back on everything it
// sends. The spec says those bytes are zero, so an ordinary implementation discards the reply —
// `core/xray.exe` logged «Sending handshake initiation» every five seconds and never once logged
// a response, on the very edge aether was carrying traffic through in the same minute. With this
// relay in front, the same xray logs «Received handshake response».
//
// Two faults are pinned here because both produced silence rather than an error:
//   · a single socket bound to 127.0.0.1 cannot reach the internet, so the relay accepted the
//     engine's packets and sent them nowhere (`up=2 down=0`, which reads exactly like a dead edge);
//   · patching bytes in something that is not a WireGuard packet corrupts it.

const assert = require('assert');
const dgram = require('dgram');
const { createRelay, _internal } = require('../../warp-relay');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const { patch } = _internal;

// ── the edit itself ──────────────────────────────────────────────────────────────────────────
for (const type of [1, 2, 3, 4]) {
    const b = Buffer.alloc(16); b[0] = type;
    patch(b, 9, 8, 7);
    t('a WireGuard message of type ' + type + ' gets the three bytes', b[1] === 9 && b[2] === 8 && b[3] === 7);
}
{
    const b = Buffer.alloc(16); b[0] = 5;          // not a WireGuard type
    patch(b, 9, 8, 7);
    t('anything that is not a WireGuard message is passed through untouched',
        b[1] === 0 && b[2] === 0 && b[3] === 0);
    const short = Buffer.from([1, 2]);
    patch(short, 9, 8, 7);
    t('…and a runt packet cannot overflow the buffer', short.length === 2);
    const body = Buffer.alloc(16); body[0] = 1; body[8] = 0x42;
    patch(body, 1, 2, 3);
    t('…while the rest of the packet is never altered', body[8] === 0x42 && body[0] === 1);
}

// ── the relay end to end, against a stand-in "Cloudflare" ────────────────────────────────────
(async () => {
    const edge = dgram.createSocket('udp4');
    const seen = [];
    await new Promise((r) => edge.bind(0, '127.0.0.1', r));
    edge.on('message', (buf, rinfo) => {
        seen.push(Buffer.from(buf));
        // Answer the way the real edge does: a type-2 response that ECHOES the reserved bytes.
        const reply = Buffer.alloc(92);
        reply[0] = 2; reply[1] = buf[1]; reply[2] = buf[2]; reply[3] = buf[3];
        reply[8] = 0x77;
        edge.send(reply, rinfo.port, rinfo.address);
    });

    const relay = await createRelay({ ip: '127.0.0.1', port: edge.address().port }, [11, 22, 33]);
    t('the relay listens on loopback', relay.port > 0);

    const engine = dgram.createSocket('udp4');
    const got = new Promise((resolve) => engine.once('message', (b) => resolve(Buffer.from(b))));
    await new Promise((r) => engine.bind(0, '127.0.0.1', r));
    const init = Buffer.alloc(148); init[0] = 1; init[8] = 0x55;
    engine.send(init, relay.port, '127.0.0.1');

    const back = await Promise.race([got, new Promise((r) => setTimeout(() => r(null), 4000))]);

    t('what reached the edge carries the client_id',
        seen.length === 1 && seen[0][1] === 11 && seen[0][2] === 22 && seen[0][3] === 33,
        seen.length ? 'reserved=[' + seen[0][1] + ',' + seen[0][2] + ',' + seen[0][3] + ']' : 'nothing arrived');
    t('…and is otherwise the engine\'s own packet', seen.length === 1 && seen[0][8] === 0x55);
    t('the reply reaches the engine at all', !!back, 'this is the single-socket fault');
    t('…with the reserved bytes back to ZERO, so an ordinary WireGuard accepts it',
        !!back && back[1] === 0 && back[2] === 0 && back[3] === 0,
        back ? 'reserved=[' + back[1] + ',' + back[2] + ',' + back[3] + ']' : 'no reply');
    t('…and its body untouched', !!back && back[8] === 0x77);

    const st = relay.stats();
    t('the relay counts both directions', st.up === 1 && st.down === 1, JSON.stringify(st));

    await relay.close();
    engine.close();
    edge.close();

    // ── the engine's lifecycle, from the two faults the user reported ────────────────────────
    const mgr = require('fs').readFileSync(require('path').resolve(__dirname, '../../warp-manager.js'), 'utf8');

    // «اول میگه وصل است … و زیر آیکون وارپ مینویسه مشکل دارد … در صورتی که باید هنوز لودینگ
    // نمایش میداد». getStatus() added `running`, but the LIVE status pushed to the page is the
    // `state` object and it had no such field — so all through a connect the page saw
    // `running: undefined` and drew a broken engine instead of a spinner.
    t('every broadcast carries `running`, not just getStatus()',
        /state\.running = active;/.test(mgr));
    t('…and it is true from the first moment of a connect, before any child exists',
        /active = true;[\s\S]{0,40}setStage\('starting'/.test(mgr));
    t('…and false again the moment the user stops',
        /sessionId\+\+;[\s\S]{0,20}active = false;/.test(mgr));
    t('…so getStatus and the broadcast cannot disagree', /\{ running: active \}\)/.test(mgr));

    // «وقتی روی دکمه قطع میزنم میگه در حال جستجوی اندپوینت جدید و دوباره وصل میشه» — the
    // watchdog's own `await stop()` clears `proc`/`connected`, so those guards could not tell its
    // restart apart from one racing a user's disconnect. It needs the session it was watching.
    t('the watchdog belongs to one session', /const sid = sessionId;/.test(mgr));
    t('…which it re-checks at every await', (mgr.match(/sessionId !== sid/g) || []).length >= 3);
    t('…and it only restarts the session it itself just stopped',
        /if \(sessionId !== sid \+ 1\) return;/.test(mgr));

    let failed = 0;
    for (const r of results) {
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();

assert.ok(true);
