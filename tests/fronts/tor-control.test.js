'use strict';
// The تور control layer: the reply parser, the torrc it writes, and the bridge reader.
//
// These are the three surfaces where a mistake is silent. A control reply mis-parsed gives a
// plausible-looking wrong answer rather than an error; a torrc line dropped or spelled wrong makes
// tor refuse to start, which the user sees as «the button does nothing»; and a bridge line stored
// under the wrong transport hands meek addresses to the obfs4 rung.
//
// MLMVPN_HOME FIRST, before anything requires tor-manager: its data directory holds the user's own
// bridges, the remembered rung and a 38 MB directory cache that cost six minutes to build. A test
// that writes there is a test that damages the thing it is checking.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');

process.env.MLMVPN_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-tor-'));

const ROOT = path.resolve(__dirname, '../..');
const { TorControl, parseCircuits, parseStreams, parseNs } = require(path.join(ROOT, 'tor-control.js'));
const tor = require(path.join(ROOT, 'tor-manager.js'));

// ── The protocol ───────────────────────────────────────────────────────────

/**
 * A control port that answers from a script.
 *
 * Deliberately a real socket rather than a fake object: the whole risk in that module is the line
 * framing — data blocks, dot-stuffing, and 650 events arriving in the middle of a reply — and none
 * of that is exercised by handing the parser a whole string.
 */
function fakeControl(script) {
    // The accepted sockets are held so they can be destroyed at the end. `server.close()` alone
    // stops new connections and leaves the open ones holding the event loop — which does not fail
    // a test, it hangs the whole suite, since the runner drives each file with execFileSync.
    const live = new Set();
    const server = net.createServer((sock) => {
        live.add(sock);
        sock.on('close', () => live.delete(sock));
        sock.on('error', () => { /* the client half is torn down mid-reply on purpose */ });
        sock.on('data', (buf) => {
            const line = buf.toString('utf8').trim();
            const reply = script(line);
            if (reply) sock.write(reply);
        });
    });
    server.stop = () => {
        live.forEach((s) => { try { s.destroy(); } catch (e) { /* already gone */ } });
        server.close();
    };
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('authenticates with the cookie and reads an inline value', async () => {
    const cookie = path.join(process.env.MLMVPN_HOME, 'cookie');
    fs.writeFileSync(cookie, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    let sawAuth = null;
    const server = await fakeControl((line) => {
        if (line.startsWith('AUTHENTICATE')) { sawAuth = line; return '250 OK\r\n'; }
        if (line.startsWith('GETINFO')) return '250-version=0.4.9.12\r\n250 OK\r\n';
        return '510 unknown\r\n';
    });
    const c = new TorControl();
    await c.open(server.address().port, cookie);
    assert.equal(sawAuth, 'AUTHENTICATE deadbeef', 'the cookie must be sent hex-encoded');
    const info = await c.getInfo('version');
    assert.equal(info.version, '0.4.9.12');
    c.close();
    server.stop();
});

test('reads a data block, and an event in the middle of it does not corrupt the reply', async () => {
    const cookie = path.join(process.env.MLMVPN_HOME, 'cookie2');
    fs.writeFileSync(cookie, Buffer.from([0x01]));
    const server = await fakeControl((line) => {
        if (line.startsWith('AUTHENTICATE')) return '250 OK\r\n';
        if (line.startsWith('GETINFO')) {
            // An async event BEFORE the reply — which is exactly how tor behaves once SETEVENTS is
            // on, and the case that turns a naive line reader into a parser of nonsense.
            return '650 STREAM 42 NEW 0 example.com:443\r\n'
                + '250+circuit-status=\r\n'
                + '1 BUILT $AAAA~guard,$BBBB~mid,$CCCC~exit BUILD_FLAGS=NEED_CAPACITY\r\n'
                + '..dotted line\r\n'
                + '.\r\n'
                + '250 OK\r\n';
        }
        return '510 unknown\r\n';
    });
    const c = new TorControl();
    const seen = [];
    c.onEvent((name, rest) => seen.push(name + ' ' + rest));
    await c.open(server.address().port, cookie);
    const info = await c.getInfo('circuit-status');
    assert.match(info['circuit-status'], /^1 BUILT/, 'the block must be the value, not the header line');
    assert.match(info['circuit-status'], /^\.dotted line$/m, 'dot-stuffing must be undone');
    assert.deepEqual(seen, ['STREAM 42 NEW 0 example.com:443']);
    c.close();
    server.stop();
});

test('a non-2xx reply rejects rather than resolving empty', async () => {
    const cookie = path.join(process.env.MLMVPN_HOME, 'cookie3');
    fs.writeFileSync(cookie, Buffer.from([0x02]));
    const server = await fakeControl((line) => (line.startsWith('AUTHENTICATE') ? '250 OK\r\n' : '552 Unrecognized key\r\n'));
    const c = new TorControl();
    await c.open(server.address().port, cookie);
    await assert.rejects(() => c.getInfo('nonsense'), /552/);
    c.close();
    server.stop();
});

// ── The parsers ────────────────────────────────────────────────────────────

test('a circuit path is read entry-first, exit-last', () => {
    const [c] = parseCircuits('7 BUILT $AAA~alpha,$BBB~beta,$CCC~gamma PURPOSE=GENERAL SOCKS_USERNAME="probe1"');
    assert.equal(c.id, '7');
    assert.equal(c.status, 'BUILT');
    assert.equal(c.path.length, 3);
    assert.equal(c.path[0].nick, 'alpha', 'first hop is the guard');
    assert.equal(c.path[2].nick, 'gamma', 'last hop is the exit');
    assert.equal(c.flags.PURPOSE, 'GENERAL');
});

test('a circuit still being extended has no path and is not an error', () => {
    const [c] = parseCircuits('9 LAUNCHED BUILD_FLAGS=IS_INTERNAL PURPOSE=GENERAL');
    assert.equal(c.status, 'LAUNCHED');
    assert.deepEqual(c.path, []);
    assert.equal(c.flags.PURPOSE, 'GENERAL');
});

test('streams and ns lines', () => {
    const [s] = parseStreams('12 SUCCEEDED 7 speed.cloudflare.com:80');
    assert.deepEqual(s, { id: '12', status: 'SUCCEEDED', circ: '7', target: 'speed.cloudflare.com:80' });
    const ns = parseNs('r Unnamed AAAA BBBB 2026-09-20 10:00:00 1.2.3.4 443 80\ns Exit Fast Guard');
    assert.equal(ns.ip, '1.2.3.4');
    assert.equal(ns.nick, 'Unnamed');
});

// ── The torrc ──────────────────────────────────────────────────────────────

function torrcFor(mode, region, ipv6) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-torrc-'));
    return fs.readFileSync(tor._internal.writeTorrc(dir, mode, region, ipv6), 'utf8').split('\n');
}

test('the direct rung: control port, three guards, and no public resolver', () => {
    const lines = torrcFor('direct', 'auto', true);
    assert.ok(lines.includes(`ControlPort 127.0.0.1:${tor.CONTROL_PORT}`));
    assert.ok(lines.includes('CookieAuthentication 1'));
    assert.ok(lines.includes('NumEntryGuards 3'), 'one guard is a throughput and an uptime ceiling in one number');
    assert.ok(lines.includes('SocksPolicy reject *'));
    // The leak that matters: a public resolver here would send every lookup outside the circuit.
    assert.ok(!lines.some((l) => /^DNSPort\s+(?!127\.0\.0\.1)/.test(l)));
    assert.ok(!lines.some((l) => /8\.8\.8\.8|1\.1\.1\.1/.test(l)));
});

test('a bridge rung keeps ONE guard, because the bridge list is the guard set', () => {
    const lines = torrcFor('obfs4', 'auto', true);
    assert.ok(lines.includes('NumEntryGuards 1'));
    assert.ok(lines.includes('UseBridges 1'));
    assert.ok(lines.some((l) => l.startsWith('Bridge obfs4 ')));
});

test('the GeoIP database goes in even on «خودکار», or the country cannot be changed later', () => {
    const auto = torrcFor('direct', 'auto', true);
    assert.ok(auto.some((l) => l.startsWith('GeoIPFile ')), 'GeoIPFile is read once at startup and cannot be SETCONF-ed');
    assert.ok(!auto.some((l) => l.startsWith('ExitNodes ')), 'no country was asked for');

    const de = torrcFor('direct', 'de', true);
    assert.ok(de.includes('ExitNodes {de}'));
    assert.ok(de.includes('StrictNodes 0'), 'a country must degrade to «somewhere else», never to «no connection»');
});

test('IPv6 is written from the measurement, not assumed', () => {
    assert.ok(torrcFor('direct', 'auto', true).includes('ClientUseIPv6 1'));
    const off = torrcFor('direct', 'auto', false);
    assert.ok(off.includes('ClientUseIPv6 0'));
    assert.ok(!off.includes('ClientPreferIPv6ORPort auto'), 'preferring a transport that does not carry costs a timeout per guard');
});

test('onion addresses are mapped into a range the adapter can actually route', () => {
    const lines = torrcFor('direct', 'auto', true);
    assert.ok(lines.includes('AutomapHostsOnResolve 1'));
    assert.ok(lines.includes('VirtualAddrNetworkIPv4 10.192.0.0/10'), 'tor\'s 127.192/10 default never reaches the adapter');
    assert.ok(lines.some((l) => l.startsWith('SocksPort ') && l.includes('IPv6Traffic')));
});

// ── The user's own bridges ─────────────────────────────────────────────────

test('pasted lines are sorted by transport and rubbish is dropped', () => {
    const parsed = tor.parseBridgeLines([
        'Here are your bridges:',
        'obfs4 1.2.3.4:443 0123456789ABCDEF0123456789ABCDEF01234567 cert=abc iat-mode=0',
        'Bridge webtunnel 192.0.2.3:1 0123456789ABCDEF0123456789ABCDEF01234568 url=https://a.example/x ver=0.0.1',
        '',
        'meek_lite 192.0.2.20:80 url=https://example.invalid front=x utls=HelloRandomizedALPN',
    ].join('\n'));
    assert.equal(parsed.obfs4.length, 1);
    assert.equal(parsed.webtunnel.length, 1);
    assert.ok(parsed.webtunnel[0].startsWith('webtunnel '), 'the «Bridge » prefix must be stripped');
    assert.equal(parsed.meek.length, 1);
    assert.ok(!parsed.plain, 'a sentence of English is not a bridge');
});

test('a saved bridge REPLACES the shipped ones for its transport', () => {
    const mine = 'obfs4 9.9.9.9:9001 0123456789ABCDEF0123456789ABCDEF0123456A cert=zzz iat-mode=0';
    tor.saveCustomBridges(mine);
    const used = tor._internal.bridgeLinesFor('obfs4');
    assert.deepEqual(used, [mine], 'a personal bridge is unburned only because nobody else has it');
    // Another transport is untouched — it still gets the bundle's own list.
    assert.ok(tor._internal.bridgeLinesFor('meek').every((l) => l !== mine));
    tor.clearCustomBridges();
    assert.ok(tor._internal.bridgeLinesFor('obfs4').length >= 1, 'clearing must restore the defaults, not empty the rung');
});

test('the status object carries what the panel draws, with no engine running', () => {
    const s = tor.getStatus();
    assert.equal(s.controlPort, tor.CONTROL_PORT);
    assert.equal(s.running, false);
    assert.ok('bootBytes' in s && 'phase' in s, 'the cold bootstrap is legible only through these two');
    assert.ok(s.consensus && typeof s.consensus.have === 'boolean');
});
