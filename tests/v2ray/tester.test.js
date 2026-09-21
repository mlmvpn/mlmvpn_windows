// The delay/ping tester's contract — xray-tester.js.
//
// Every case here is the defect that produced «کانفیگ ها دیلی نمیدن» on configs that work
// perfectly well in other clients. The old tester put one socks inbound per node into ONE
// xray process on a RANDOM base port in 20000–29999 and never checked the ports were free.
// Xray binds every inbound up front and one failure is fatal to the whole process, so a
// single busy port turned every node in the batch into "-1" at once — and the route then
// answered 500, which the panel swallowed and drew as "Timeout" on every row.
//
// Nothing here reaches the internet. The port cases use real loopback listeners (closed at
// the end); the fallback cases replace child_process so the "core" is a child that never
// binds anything, which is exactly the failure being tested.
const path = require('path');
const os = require('os');
const fs = require('fs');
const net = require('net');

const ROOT = path.resolve(__dirname, '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-v2ray-tester-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── the core, replaced by a child that binds nothing ────────────────────────────
const rec = { spawns: [] };
const fakeChild = () => {
    const child = {
        pid: 7000 + rec.spawns.length,
        killed: false,
        stdout: { on() { } },
        stderr: { on() { } },
        on() { return this; },
        once() { return this; },
        kill() { this.killed = true; },
    };
    return child;
};
const realCp = require('child_process');
const cpStub = Object.assign({}, realCp, {
    spawn(exe, args) { rec.spawns.push([exe, args]); return fakeChild(); },
});
require.cache[require.resolve('child_process')] = {
    id: 'child_process', filename: 'child_process', loaded: true, exports: cpStub,
};

const tester = require(ROOT + '/xray-tester');

const listeners = [];
const hold = (port) => new Promise((resolve) => {
    const s = net.createServer((c) => c.on('error', () => { }));
    s.on('error', () => resolve(null));
    s.listen(port, '127.0.0.1', () => { listeners.push(s); resolve(s); });
});

const URI = (host) => `vless://11111111-2222-3333-4444-555555555555@${host}:443?type=ws&security=tls#n`;
const quiet = () => { };

(async () => {
    // ── 1. ports are FOUND, not guessed ─────────────────────────────────────────
    //
    // The one defect that took whole batches down. Squat on the first ports of the tester's
    // range and it must hand back ports that are actually free, skipping them.
    await hold(tester.BASE_PORT);
    await hold(tester.BASE_PORT + 1);
    await hold(tester.BASE_PORT + 3);

    const reserved = await tester.reservePorts(4);
    t('a reservation skips every port already in use',
        !reserved.ports.includes(tester.BASE_PORT)
        && !reserved.ports.includes(tester.BASE_PORT + 1)
        && !reserved.ports.includes(tester.BASE_PORT + 3),
        JSON.stringify(reserved.ports));
    t('…and hands back as many as were asked for', reserved.ports.length === 4, JSON.stringify(reserved.ports));
    t('…all of them distinct', new Set(reserved.ports).size === 4, JSON.stringify(reserved.ports));

    // Held until released, so nothing can take them between the scan and the spawn.
    const stolen = await tester.portIsFree(reserved.ports[0]);
    t('…and holds them so nothing can take one in the meantime', stolen === null,
        stolen ? 'the port was still bindable' : 'held');
    await reserved.release();
    const freed = await tester.portIsFree(reserved.ports[0]);
    t('…then gives them up for the core', freed !== null, freed ? 'free' : 'still held');
    if (freed) await new Promise(r => freed.close(r));

    // ── 2. tcping needs no core at all ──────────────────────────────────────────
    //
    // «پینگ سرور» used to fall through to the download branch (the route had no 'ping' case
    // whatsoever) and print megabytes per second in a column labelled ms. It is v2rayN's
    // Tcping now: a bare socket connect, so it cannot fail for a neighbour's reason.
    const pingPort = reserved.ports[1];
    await hold(pingPort);
    const live = await tester.tcpPing('127.0.0.1', pingPort);
    t('tcping measures a reachable port', live > 0, String(live));
    const dead = await tester.tcpPing('127.0.0.1', 1, 700);
    t('…and reports an unreachable one as -1', dead === -1, String(dead));
    t('…and refuses IPv6 rather than hanging on it', await tester.tcpPing('2606:4700::1111', 443, 700) === -1);

    rec.spawns = [];
    const pinged = [];
    await tester.testNodes({
        nodes: [{ id: 'a', uri: URI('127.0.0.1') }],
        testType: 'ping', log: quiet,
        onResult: (r) => pinged.push(r),
    });
    t('a ping sweep starts no core at all', rec.spawns.length === 0, `${rec.spawns.length} spawns`);
    t('…and still produces a figure', pinged.length === 1 && typeof pinged[0].val === 'number', JSON.stringify(pinged));

    // ── 3. an unrepresentable node is reported, not blackholed ──────────────────
    //
    // These used to become `blackhole` outbounds that silently timed out, so a protocol Xray
    // cannot speak looked exactly like a dead server, and each one still cost a test slot.
    rec.spawns = [];
    const junk = [];
    await tester.testNodes({
        nodes: [
            { id: 'h2', uri: 'hysteria2://user@example.com:443#x' },
            { id: 'nouser', uri: 'socks://127.0.0.1:20810' },
            { id: 'json', uri: '{"protocol":"vless"}' },
        ],
        testType: 'delay', log: quiet,
        onResult: (r) => junk.push(r),
    });
    t('every unrepresentable node is answered', junk.length === 3, JSON.stringify(junk));
    t('…each with the parser\'s own reason, not a timeout',
        junk.every(r => r.val === -1 && r.reason && r.reason !== 'timeout'), JSON.stringify(junk.map(r => r.reason)));
    t('…and no core is started for a list with nothing to test', rec.spawns.length === 0, `${rec.spawns.length} spawns`);

    // ── 4. a page whose core does not come up is HALVED, then run one per node ───
    //
    // v2rayN's RunRealPingBatchAsync → half the page → RunMixedTestAsync (one core per node).
    // Without it, one node that cannot be placed takes every other node in its batch with it.
    // The stub core binds nothing, so every page fails and the whole ladder is walked.
    rec.spawns = [];
    const laddered = [];
    const eight = Array.from({ length: 8 }, (_, i) => ({ id: i, uri: URI(`h${i}.example`) }));
    const summary = await tester.testNodes({
        nodes: eight, testType: 'delay',
        settings: { concurrency: 4 },
        timings: { portBudgetMs: 400 },
        log: quiet,
        onResult: (r) => laddered.push(r),
    });
    // 8 in one page → two pages of 4 → below MIN_PAGE, so one core each: 1 + 2 + 8 = 11.
    t('a failed page is retried at half the size, down to one core per node',
        rec.spawns.length === 11, `${rec.spawns.length} cores spawned (expected 11)`);
    t('…every node still gets an answer', laddered.length === 8, `${laddered.length} results`);
    t('…and it says the CORE failed, not that the node timed out',
        laddered.every(r => r.reason === 'core'), JSON.stringify(laddered.map(r => r.reason)));
    t('…and the count is reported back so the panel can say so',
        summary.coreFailures === 8, String(summary.coreFailures));

    // ── 5. abort stops it ───────────────────────────────────────────────────────
    rec.spawns = [];
    const partial = [];
    await tester.testNodes({
        nodes: eight, testType: 'delay',
        timings: { portBudgetMs: 300 },
        isAborted: () => true, log: quiet,
        onResult: (r) => partial.push(r),
    });
    t('an aborted sweep starts nothing', rec.spawns.length === 0, `${rec.spawns.length} spawns`);

    // ── 6. the core is given a config it can actually load ──────────────────────
    //
    // One inbound per node, one outbound per node, one rule tying them together — and the
    // ports in the config are the ones that were reserved.
    rec.spawns = [];
    await tester.testNodes({
        nodes: [{ id: 'x', uri: URI('a.example') }, { id: 'y', uri: URI('b.example') }],
        testType: 'delay', timings: { portBudgetMs: 300 }, log: quiet,
    });
    const cfgPath = rec.spawns.length ? rec.spawns[0][1][rec.spawns[0][1].indexOf('-config') + 1] : null;
    let cfg = null;
    try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { }
    t('the config pairs one inbound with one outbound per node',
        !!cfg && cfg.inbounds.length === 2 && cfg.outbounds.length === 2 && cfg.routing.rules.length === 2,
        cfg ? `${cfg.inbounds.length}/${cfg.outbounds.length}/${cfg.routing.rules.length}` : 'no config written');
    t('…each rule pointing at its own outbound',
        !!cfg && cfg.routing.rules.every((r, i) => r.inboundTag[0] === `in-${i}` && r.outboundTag === `out-${i}`),
        cfg ? JSON.stringify(cfg.routing.rules) : '');
    t('…on the ports that were reserved, none of them repeated',
        !!cfg && new Set(cfg.inbounds.map(i => i.port)).size === cfg.inbounds.length
        && cfg.inbounds.every(i => i.port >= tester.BASE_PORT),
        cfg ? JSON.stringify(cfg.inbounds.map(i => i.port)) : '');

    await Promise.all(listeners.splice(0).map(s => new Promise(r => s.close(r))));

    module.exports = results;
    if (require.main === module) {
        results.forEach(r => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass || !r.detail ? '' : '\n      ' + r.detail)));
        const bad = results.filter(r => !r.pass).length;
        console.log(`\n${results.length - bad}/${results.length} passed`);
        process.exit(bad ? 1 : 0);
    }
})();
