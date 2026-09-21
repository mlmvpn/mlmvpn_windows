/*
 * The engine catalogue and the tournament's field.
 *
 * What this guards is the promise the user actually made the feature for: "I never have to
 * go and switch an engine on by hand". That promise is kept by two things — a catalogue
 * where every variant is a real, distinct configuration, and a lifecycle that starts what
 * it is asked for and puts back exactly what it started.
 *
 * The failure modes worth a test are quiet ones:
 *   * an Aether variant whose id collides with another, so the tournament measures `wg` and
 *     labels the row `masque` — a wrong answer that looks like a right one;
 *   * `parseId` failing to round-trip, so the winner of a tournament cannot be handed to
 *     the boost button and the whole flow dead-ends;
 *   * `release` switching off an engine this module never started, which would kill a
 *     tunnel the user set up themselves;
 *   * the GitHub Tunnel losing its `exclusive` flag, after which the tournament would try
 *     to measure it through a SOCKS port that carries no UDP and report it as broken.
 *
 * Safe by construction: the only sockets are loopback listeners this file opens and closes,
 * the drivers are fakes that record calls, and nothing here can start a real engine.
 */
'use strict';

const net = require('net');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const engines = require(ROOT + '/game/engines');
const tournament = require(ROOT + '/game/tournament');
const boost = require(ROOT + '/game/boost');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

/** A listener that makes `portAlive` true, on a port the OS picks. */
function listener() {
    return new Promise(resolve => {
        const srv = net.createServer(s => s.destroy());
        srv.listen(0, '127.0.0.1', () => resolve({ port: srv.address().port, close: () => new Promise(r => srv.close(r)) }));
    });
}

function fakeDrivers() {
    const calls = [];
    return {
        calls,
        async startAether(protocol, scan) { calls.push(['startAether', protocol, scan]); },
        async stopAether() { calls.push(['stopAether']); },
        async startV2ray(node) { calls.push(['startV2ray', node && node.uri]); },
        async stopV2ray() { calls.push(['stopV2ray']); },
        async startGithubTunnel() { calls.push(['startGithubTunnel']); },
        async stopGithubTunnel() { calls.push(['stopGithubTunnel']); },
    };
}

const node = (name, ping) => ({ name, ping, uri: 'vless://x@' + name + ':443' });

(async () => {

// ── the catalogue ────────────────────────────────────────────────────────────────
{
    const all = engines.aetherSpecs();
    t('three protocols on two scan modes is six real variants, not six labels',
        all.length === 6, String(all.length));
    t('every Aether variant has a unique id', new Set(all.map(s => s.id)).size === 6);
    t('…and a unique protocol+scan pair', new Set(all.map(s => s.protocol + '/' + s.scan)).size === 6);
    t('every variant carries the scan mode, because it changes which datacentre is used',
        all.every(s => s.scan === 'turbo' || s.scan === 'balanced'));
    t('all six share Aether\'s single SOCKS port',
        all.every(s => s.socksPort === engines.AETHER_SOCKS));
    t('balanced is given a longer startup budget than turbo — it searches up to six gateways',
        all.find(s => s.scan === 'balanced' && s.protocol === 'masque').startupMs >
        all.find(s => s.scan === 'turbo' && s.protocol === 'masque').startupMs);
    t('warp-in-warp gets more still, because it pays for two handshakes',
        all.find(s => s.protocol === 'gool' && s.scan === 'turbo').startupMs >
        all.find(s => s.protocol === 'masque' && s.scan === 'turbo').startupMs);

    const filtered = engines.aetherSpecs({ protocols: ['wg'], scans: ['turbo'] });
    t('the field can be narrowed to one variant', filtered.length === 1 && filtered[0].id === 'aether:wg:turbo',
        filtered.map(s => s.id).join(','));

    const gt = engines.githubTunnelSpec();
    t('the GitHub Tunnel is marked exclusive — it carries UDP only while it owns the route',
        gt.exclusive === true);
    t('…and nothing else is', all.every(s => !s.exclusive));
}

// ── ids round-trip, or the tournament winner cannot be applied ───────────────────
{
    const saved = [node('alpha', 90), node('beta', 40)];
    const free = [node('free-one', 200)];

    for (const s of engines.aetherSpecs()) {
        const back = engines.parseId(s.id);
        if (!back || back.id !== s.id || back.protocol !== s.protocol || back.scan !== s.scan) {
            t(`parseId round-trips ${s.id}`, false, JSON.stringify(back));
        }
    }
    t('parseId round-trips every Aether variant',
        engines.aetherSpecs().every(s => { const b = engines.parseId(s.id); return b && b.id === s.id && b.scan === s.scan; }));

    const savedSpec = engines.v2raySpec(saved[1], { source: 'saved', index: 1 });
    const backSaved = engines.parseId(savedSpec.id, { nodes: saved, freeNodes: free });
    t('parseId finds a saved node by id and brings the node object with it',
        !!backSaved && backSaved.node === saved[1], backSaved && backSaved.fa);

    const freeSpec = engines.v2raySpec(free[0], { source: 'free', index: 0 });
    const backFree = engines.parseId(freeSpec.id, { nodes: saved, freeNodes: free });
    t('…and a free-pool node from the free list, not the saved one',
        !!backFree && backFree.node === free[0] && backFree.source === 'free');

    t('a free node is labelled as free, so "this won" cannot be mistaken for one of yours',
        freeSpec.fa.startsWith('رایگان'), freeSpec.fa);

    t('parseId returns null for junk rather than guessing', engines.parseId('nonsense:1:2') === null);
    t('parseId returns null for a node that no longer exists',
        engines.parseId('v2ray:saved:deleted-node', { nodes: [], freeNodes: [] }) === null);
}

// ── the field the tournament actually races ─────────────────────────────────────
{
    const saved = [node('slow', 300), node('fast', 40), node('mid', 120)];
    const free = [node('f1'), node('f2'), node('f3')];

    const full = tournament.buildCandidates({
        nodes: saved, freeNodes: free,
        include: { aether: true, v2raySaved: true, v2rayFree: true, githubTunnel: true },
        maxNodes: 2, maxFree: 2,
    });
    t('the whole field is Aether variants + capped saved + capped free + گف + the tunnel',
        full.length === 6 + 2 + 2 + 1 + 1, String(full.length));
    // گف is in the field because it is the only SOCKS-front engine here that carries UDP at all —
    // measured 2026-09-14, while سایفون, لنترن and تور each refuse UDP ASSOCIATE outright.
    t('…and گف is one of them', full.some(c => c.id === 'geph'), full.map(c => c.id).join(','));
    t('maxNodes actually caps the saved list',
        full.filter(c => c.source === 'saved').length === 2);
    t('maxFree caps the free list separately',
        full.filter(c => c.source === 'free').length === 2);
    t('saved nodes are ordered by the user\'s own ping column, not by list order',
        full.filter(c => c.source === 'saved').map(c => c.node.name).join(',') === 'fast,mid',
        full.filter(c => c.source === 'saved').map(c => c.node.name).join(','));
    t('the disruptive candidate runs last, so an abort costs the least',
        full[full.length - 1].kind === 'github-tunnel', full[full.length - 1].id);

    const free_off = tournament.buildCandidates({
        nodes: saved, freeNodes: free, include: { aether: false, v2raySaved: true }, maxNodes: 5,
    });
    t('the free pool is opt-IN — absent unless explicitly requested',
        free_off.every(c => c.source !== 'free'));
    t('the GitHub Tunnel is opt-in too', free_off.every(c => c.kind !== 'github-tunnel'));
    t('Aether can be excluded entirely', free_off.every(c => c.kind !== 'aether'));

    const narrowed = tournament.buildCandidates({
        nodes: [], include: { aetherProtocols: ['masque'], aetherScans: ['turbo'] },
    });
    // About the AETHER part of the field, deliberately: گف is not an Aether variant and narrowing
    // the protocols says nothing about it. Asserting the total length here would break every time
    // anything else joins the field, for a reason unrelated to what this pins.
    const narrowedAether = narrowed.filter(c => c.kind === 'aether');
    t('a narrowed Aether selection races exactly what was ticked',
        narrowedAether.length === 1 && narrowedAether[0].id === 'aether:masque:turbo', narrowed.map(c => c.id).join(','));

    // "Nothing selected" means every family that is on by default, turned off — and گف is now a
    // third one. The point of the assertion is unchanged: an explicit empty selection must race
    // nothing, never fall back to a default the user just removed.
    t('nothing selected produces an empty field rather than a surprise default',
        tournament.buildCandidates({
            nodes: [], include: { aether: false, v2raySaved: false, geph: false },
        }).length === 0);
    t('…and turning گف off alone leaves the rest of the field intact',
        !tournament.buildCandidates({ nodes: [], include: { geph: false } }).some(c => c.id === 'geph'));
}

// ── lifecycle: start what was asked for, put back only what we started ───────────
{
    const srv = await listener();
    const drivers = fakeDrivers();
    const spec = { id: 'aether:wg:balanced', kind: 'aether', fa: 'تست', protocol: 'wg', scan: 'balanced', socksPort: srv.port, startupMs: 4000 };

    const r = await engines.ensure(spec, drivers, {});
    t('ensure() starts the engine through the drivers, never directly',
        r.started === true && drivers.calls[0][0] === 'startAether', JSON.stringify(drivers.calls[0]));
    t('…and passes BOTH protocol and scan, because the scan is part of what is measured',
        drivers.calls[0][1] === 'wg' && drivers.calls[0][2] === 'balanced', JSON.stringify(drivers.calls[0]));

    const again = await engines.ensure(spec, drivers, {});
    t('asking for the same variant that is already up starts nothing a second time',
        again.started === false && again.reused === true && drivers.calls.length === 1);

    await engines.release(spec, drivers, { started: false });
    t('release() does NOT stop an engine it did not start — that would kill the user\'s own tunnel',
        drivers.calls.length === 1, JSON.stringify(drivers.calls));

    await engines.release(spec, drivers, { started: true });
    t('release() stops one it did start', drivers.calls[drivers.calls.length - 1][0] === 'stopAether');

    await srv.close();
}

// ── an open port is not a connected engine ──────────────────────────────────────
//
// This is the regression test for the first real tournament run: aether.exe binds its SOCKS
// port immediately, so every candidate was measured against a listener with nothing behind
// it and all six reported "carries no UDP" in ten seconds each. Readiness must come from the
// engine, not from the socket.
{
    const srv = await listener();
    const drivers = fakeDrivers();
    let connected = false;
    drivers.engineReady = () => connected;
    const spec = { id: 'aether:masque:turbo', kind: 'aether', fa: 'تست', protocol: 'masque', scan: 'turbo', socksPort: srv.port, startupMs: 5000 };

    setTimeout(() => { connected = true; }, 1500);
    const t0 = Date.now();
    const r = await engines.ensure(spec, drivers, {});
    const waited = Date.now() - t0;
    t('ensure() waits for the engine\'s own connected state, not just an open port',
        r.started === true && waited >= 1500, waited + 'ms');
    await engines.release(spec, drivers, { started: true });
    await srv.close();
}

{
    const srv = await listener();
    const drivers = fakeDrivers();
    drivers.engineReady = () => false;   // listens forever, never connects
    const spec = { id: 'aether:wg:turbo', kind: 'aether', fa: 'تست', protocol: 'wg', scan: 'turbo', socksPort: srv.port, startupMs: 2500 };
    let threw = null;
    try { await engines.ensure(spec, drivers, {}); } catch (e) { threw = e; }
    t('an engine whose port opens but never connects is a failure, not a measurement',
        !!threw, threw && threw.message);
    t('…and it says WHY, so the row does not read as "this engine has no UDP"',
        threw && threw.message.includes('وصل نشد'), threw && threw.message);
    t('…and it is stopped rather than left running',
        drivers.calls.some(c => c[0] === 'stopAether'));
    await srv.close();
}

{
    // A port nothing is listening on: the engine "starts" but never comes up.
    const drivers = fakeDrivers();
    const spec = { id: 'v2ray:saved:x', kind: 'v2ray', fa: 'نود تست', node: node('x'), socksPort: 1, startupMs: 1200 };
    let threw = null;
    try { await engines.ensure(spec, drivers, {}); } catch (e) { threw = e; }
    t('an engine that never comes up is an error, not a silent zero-latency win', !!threw, threw && threw.message);
    t('…and it is torn back down rather than left running',
        drivers.calls.some(c => c[0] === 'stopV2ray'), JSON.stringify(drivers.calls));
}

// ── the UDP screen ──────────────────────────────────────────────────────────────
//
// The regression that matters here is historical: the screen used to ask "can you carry
// UDP?" by sending a DNS query to 1.1.1.1:53. WARP swallows UDP/53 while carrying every
// other port perfectly, so two entire live tournaments eliminated all six Aether variants
// with a verdict that was false — while a STUN train through the very same SOCKS port ran
// 67 packets with zero loss. What is pinned below is the cheap half: a path that refuses
// UDP ASSOCIATE (every Cloudflare Worker) is rejected fast and for the right stated reason.
{
    // A SOCKS5 server that greets politely and then refuses UDP — a Worker, in miniature.
    const srv = await new Promise(resolve => {
        const s = net.createServer(sock => {
            let stage = 'greeting';
            sock.on('data', () => {
                if (stage === 'greeting') { stage = 'request'; sock.write(Buffer.from([0x05, 0x00])); return; }
                // 0x07 = command not supported, which is exactly what a Worker answers.
                sock.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                sock.end();
            });
            sock.on('error', () => {});
        });
        s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise(r => s.close(r)) }));
    });

    const t0 = Date.now();
    const r = await engines.screenUdp({ socksPort: srv.port, host: 'stun.l.google.com', ip: '127.0.0.1', port: 19302 });
    const took = Date.now() - t0;
    t('a path that refuses UDP ASSOCIATE is screened out', r.udp === false, JSON.stringify(r));
    t('…and says so specifically, rather than blaming the measurement',
        /UDP ASSOCIATE/.test(r.reason || ''), r.reason);
    t('…cheaply, which is what makes a hundred-node list affordable', took < 3500, took + 'ms');
    await srv.close();
}

// ── boost speaks the same ids ───────────────────────────────────────────────────
{
    t('a variant id maps to its family, so profiles stay one store per engine',
        boost.familyOf('aether:gool:balanced') === 'aether' && boost.familyOf('v2ray:free:abc') === 'v2ray');
    t('the tunnel is its own family', boost.familyOf('github-tunnel') === 'github-tunnel');
    t('an old bare id from a previous build still resolves', boost.familyOf('aether') === 'aether');

    const spec = boost.resolveSpec('aether:wg:turbo');
    t('boost can resolve a tournament winner id straight into something startable',
        !!spec && spec.protocol === 'wg' && spec.scan === 'turbo', spec && spec.id);
    const fallback = boost.resolveSpec('aether');
    t('a bare family id falls back to the cheapest variant rather than failing',
        !!fallback && fallback.id === 'aether:masque:turbo', fallback && fallback.id);
}

// ── the tournament has to teach the boost button ────────────────────────────────
//
// These two features share exactly one thing: the profile store. `profiles.record()`
// understands an assessment's shape and a tournament report fell straight through it, so
// for a while the panel would finish racing every engine in the app and then, seconds
// later, tell the user «هنوز اندازه‌گیری نشده» about the engine it had just crowned.
//
// Written against a throwaway file, never the machine's real store.
{
    const os = require('os');
    const fs = require('fs');
    const profiles = require(ROOT + '/game/profiles');
    const tmp = path.join(os.tmpdir(), 'mlmvpn-profiles-test-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.json');
    profiles.useFileForTests(tmp);
    try {
        const report = {
            gameId: 'test-game', verdict: { code: 'winner' },
            ranked: [
                { id: 'aether:gool:turbo', fa: 'وارپ در وارپ', ok: true, score: 70, min: 110, p95: 150, loss: 0, n: 95 },
                { id: 'aether:wg:turbo', fa: 'وایرگارد', ok: true, score: 55, min: 130, p95: 190, loss: 1, n: 95 },
                { id: 'direct', fa: 'مستقیم', ok: true, score: 40, min: 100, p95: 200, loss: 0, n: 90 },
                { id: 'v2ray:saved:x', fa: 'worker', ok: false, score: 0, reason: 'no udp' },
            ],
        };
        profiles.recordTournament(report, { isp: 'TEST' });
        const row = profiles.forGame('test-game')[0];

        t('a tournament is written to the profile store at all', !!row, JSON.stringify(row && row.key));
        t('the control lands under `direct`', !!(row && row.paths.direct), Object.keys(row ? row.paths : {}).join(','));
        t('engines land under the FAMILY key the boost verdict reads',
            !!(row && row.paths['engine:aether']), Object.keys(row ? row.paths : {}).join(','));
        t('the BEST variant of a family wins the slot, not the last one measured',
            row && row.paths['engine:aether'].score === 70 && row.paths['engine:aether'].via === 'aether:gool:turbo',
            row && JSON.stringify({ s: row.paths['engine:aether'].score, via: row.paths['engine:aether'].via }));
        t('a candidate that failed is not recorded as a measurement',
            row && !row.paths['engine:v2ray'], Object.keys(row ? row.paths : {}).join(','));

        // The whole point: the button now has an opinion.
        const ev = boost.evaluate('test-game', 'aether:gool:turbo', profiles);
        t('and the boost button can now answer, instead of "not measured yet"',
            ev.verdict === 'recommended', ev.verdict + ' / ' + ev.fa);
    } finally {
        profiles.useFileForTests(null);
        try { fs.unlinkSync(tmp); } catch {}
    }
}

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);

})();
