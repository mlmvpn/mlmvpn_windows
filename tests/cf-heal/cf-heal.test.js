// Unit tests for the IPv4 → IPv6 self-healing layer that need no network:
// cf-uri (rewrite/parse/bareAddress), cf-edge-heal (which configs count as Cloudflare-fronted),
// cf-family (sampleV6 shape, verdict lifetime per network), scan-scout (target).
// Run: node tests/cf-heal/cf-heal.test.js
const assert = require('assert');
const fs = require("fs");
const vm = require("vm");
const C = require('../../public/cf-uri');
const H = require('../../cf-edge-heal');
const F = require('../../cf-family');
const S = require('../../scan-scout');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t("browser global and CommonJS export coexist", () => {
    const browser = {};
    browser.window = browser;
    browser.self = browser;
    browser.module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(require.resolve("../../public/cf-uri"), "utf8"), browser);
    assert.strictEqual(typeof browser.window.CfUri.rewrite, "function");
    assert.strictEqual(typeof browser.module.exports.rewrite, "function");
});

const WS = 'vless://11111111-2222-3333-4444-555555555555@abc.acc.workers.dev:443?encryption=none&security=tls&type=ws&path=%2Fvl%3Fed%3D2560#BPB';

t('rewrite writes IPv6 in brackets and pins sni+host', () => {
    const out = C.rewrite(WS, '2606:4700:3031::1');
    assert.ok(out.includes('@[2606:4700:3031::1]:443?'));
    const p = C.parse(out);
    assert.strictEqual(p.address, '2606:4700:3031::1');
    assert.strictEqual(p.sni, 'abc.acc.workers.dev');
    assert.strictEqual(p.host, 'abc.acc.workers.dev');
});
t('rewrite replaces an existing [v6] address and keeps the port unless given', () => {
    const v6 = C.rewrite(WS, '2606:4700:10::5');
    assert.strictEqual(C.parse(C.rewrite(v6, '104.16.1.1')).address, '104.16.1.1');
    assert.strictEqual(C.parse(C.rewrite(v6, '104.16.1.1', 8443)).port, 8443);
});
t('rewrite never pins an IP literal as the name', () => {
    const lit = 'vless://id@104.21.69.66:443?security=tls&type=ws&sni=x.workers.dev#a';
    const p = C.parse(C.rewrite(lit, '2606:4700:10::5'));
    assert.strictEqual(p.sni, 'x.workers.dev');
    assert.strictEqual(p.host, '');
});
t('vmess keeps the address bare in JSON and pins the name', () => {
    const vm = 'vmess://' + Buffer.from(JSON.stringify({ add: 'a.workers.dev', port: '443', id: 'x', net: 'ws', tls: 'tls' })).toString('base64');
    const j = JSON.parse(Buffer.from(C.rewrite(vm, '2606:4700:10::1').slice(8), 'base64').toString());
    assert.strictEqual(j.add, '2606:4700:10::1');
    assert.strictEqual(j.sni, 'a.workers.dev');
});
t('bareAddress: port split only for dotted addresses', () => {
    assert.strictEqual(C.bareAddress('[2606::1]:443'), '2606::1');
    assert.strictEqual(C.bareAddress('1.2.3.4:2053'), '1.2.3.4');
    assert.strictEqual(C.bareAddress('2606:4700:10:0:1:2:3:4'), '2606:4700:10:0:1:2:3:4');
});
t('isCfFronted: workers.dev name or CF IPv4 over TLS, never IPv6 or plain', () => {
    assert.ok(H.isCfFronted(C.parse(WS)));
    assert.ok(H.isCfFronted(C.parse('vless://id@172.67.1.1:443?security=tls&sni=example.com#x')));
    assert.ok(!H.isCfFronted(C.parse('vless://id@8.8.8.8:443?security=tls&sni=example.com#x')));
    assert.ok(!H.isCfFronted(C.parse(C.rewrite(WS, '2606:4700:10::1'))));
    assert.ok(!H.isCfFronted(C.parse('vless://id@abc.workers.dev:80?security=none&type=ws#x')));
});
t('isCfV4 covers 172.64.0.0/13 and 104.16.0.0/13', () => {
    assert.ok(H.isCfV4('172.67.154.11'));
    assert.ok(H.isCfV4('104.21.4.61'));
    assert.ok(!H.isCfV4('172.72.0.1'));
});
t('sampleV6: prefix + five groups, spread over the prefixes', () => {
    const s = F.sampleV6(32);
    assert.strictEqual(s.length, 32);
    for (const ip of s) {
        assert.strictEqual(ip.split(':').length, 8);
        assert.ok(F.V6_PREFIXES.includes(F.prefixOf(ip)));
    }
    assert.strictEqual(new Set(s.map(F.prefixOf)).size, F.V6_PREFIXES.length);
});
t('verdict: recorded for this network, preferV6 only when v4 dead and v6 alive', () => {
    F.record(false, true);
    assert.ok(F.preferV6());
    F.record(null, true);
    assert.ok(!F.preferV6());
    F.record(true, true);
    assert.strictEqual(F.current().v4, true);
});
t('scout target: ws path, name and host from the base config; REALITY unjudged', () => {
    const tg = S.target(WS);
    assert.deepStrictEqual([tg.sni, tg.host, tg.path, tg.ws, tg.tls], ['abc.acc.workers.dev', 'abc.acc.workers.dev', '/vl?ed=2560', true, true]);
    assert.strictEqual(S.target('vless://id@1.2.3.4:443?security=reality&pbk=x#r'), null);
});
console.log(`${n} passed`);
