// Settings › «شبکه» — network-settings.js and what it changes in Xray's config and the tunnel.
//
// One owner for the local ports, LAN sharing, proxy mode, backend DNS and the tunnel MTU (as
// Android's NetworkSettings). The thing these tests guard hardest is the DEFAULT: with nothing
// set, the generated Xray config must be exactly what every earlier version produced — loopback
// on 20808/20809, no DNS block, no sockopt — so an update changes nobody's connection.
//
// USERPROFILE points at a throwaway directory; the real ~/.mlmvpn is never read or written.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-net-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;

const ns = require(ROOT + '/network-settings');
const xm = require(ROOT + '/xray-manager');
const tun = require(ROOT + '/tun-manager');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const URI = 'vless://11111111-2222-3333-4444-555555555555@w.example.workers.dev:443?security=tls&sni=w.example.workers.dev&type=ws&host=w.example.workers.dev&path=%2F#w';
const xrayOk = (cfg, label) => {
    const f = path.join(SANDBOX, label + '.json');
    fs.writeFileSync(f, JSON.stringify(cfg));
    try { return /Configuration OK/.test(execFileSync(path.join(ROOT, 'core', 'xray.exe'), ['run', '-test', '-c', f], { encoding: 'utf8' })); } catch (e) { return false; }
};

(async () => {
    // ── the defaults are the old behaviour ──
    let s = ns.get();
    t('defaults: 20808 / 20809, loopback, Windows proxy, Windows DNS, automatic MTU',
        s.socksPort === 20808 && s.httpPort === 20809 && !s.allowLan && s.proxyMode === 'system' && s.backendDns === 'system' && s.mtu.global === 0);
    let cfg = await xm.generateXrayConfig(URI, '', '', '', () => {});
    const ins = cfg.inbounds.filter((i) => i.tag !== 'api');
    t('default Xray config: listeners exactly as before (127.0.0.1:20808 socks, :20809 http)',
        ins[0].port === 20808 && ins[0].listen === '127.0.0.1' && ins[1].port === 20809 && ins[1].listen === '127.0.0.1');
    t('default Xray config: no DNS block and no sockopt added', !cfg.dns && !((cfg.outbounds[0].streamSettings || {}).sockopt));
    t('default tunnel MTU is the old fixed 1420 for every engine and method',
        ['xray.exe', 'aether.exe', 'gst.exe', 'other.exe'].every((p) => ns.mtuFor(p) === 1420) && ns.MTU_METHODS.every((m) => ns.mtuFor('x', m) === 1420));

    // ── refusals: nothing half-saved ──
    t('a port owned by another engine is refused, by name', /وارپ/.test(throws(() => ns.set({ socksPort: 20810 })) || ''));
    t('the SNI front\'s port is refused too', !!throws(() => ns.set({ httpPort: 40443 })));
    t('SOCKS and HTTP on one port is refused', !!throws(() => ns.set({ socksPort: 20809 })));
    t('a privileged or out-of-range port is refused', !!throws(() => ns.set({ httpPort: 80 })) && !!throws(() => ns.set({ httpPort: 70000 })));
    t('a DNS that is neither an address nor a DoH/DoT URL is refused', !!throws(() => ns.set({ backendDns: 'dns.google' })));
    t('after all those refusals, nothing changed', JSON.stringify(ns.get()) === JSON.stringify(s));

    // ── ports and LAN reach the config ──
    ns.set({ socksPort: 31080, httpPort: 31081, allowLan: true });
    cfg = await xm.generateXrayConfig(URI, '', '', '', () => {});
    const ins2 = cfg.inbounds.filter((i) => i.tag !== 'api');
    t('new ports reach Xray\'s listeners', ins2[0].port === 31080 && ins2[1].port === 31081);
    t('LAN sharing binds every interface', ins2.every((i) => i.listen === '0.0.0.0'));
    t('the stats listener stays loopback-only whatever LAN sharing says', cfg.inbounds.find((i) => i.tag === 'api').listen === '127.0.0.1');
    t('Xray accepts the config', xrayOk(cfg, 'ports-lan'));
    t('with no engine running, getPorts answers the configured ports', xm.getPorts().socks === 31080 && xm.getPorts().http === 31081);

    // a full custom JSON config (the Iran profiles) gets the same listeners
    global.window = {};
    require(ROOT + '/public/components/iran-profiles.js');
    const iran = await xm.generateXrayConfig(window.IRAN_PROFILES[0].config, '', '', '', () => {});
    t('a full JSON config (Iran #1) listens on the configured ports too',
        iran.inbounds.some((i) => i.port === 31080 && i.listen === '0.0.0.0') && iran.inbounds.some((i) => i.port === 31081));

    // ── backend DNS ──
    ns.set({ backendDns: 'https://1.1.1.1/dns-query', allowLan: false });
    cfg = await xm.generateXrayConfig(URI, '', '', '', () => {});
    t('backend DNS: the server\'s own name is asked of the chosen resolver',
        cfg.dns && cfg.dns.servers[0].address === 'https://1.1.1.1/dns-query' && cfg.dns.servers[0].domains.includes('full:w.example.workers.dev'));
    t('backend DNS: Windows\' resolver stays behind it as the fallback', cfg.dns.servers[1] === 'localhost');
    t('backend DNS: the outbound resolves its server through Xray\'s DNS', cfg.outbounds[0].streamSettings.sockopt.domainStrategy === 'UseIPv4');
    t('backend DNS: the resolver\'s own queries go out direct (never through the proxy they are resolving)',
        cfg.routing.rules.some((r) => (r.inboundTag || []).includes('backend-dns') && r.outboundTag === 'direct'));
    t('Xray accepts the backend-DNS config', xrayOk(cfg, 'backend-dns'));
    const ipCfg = await xm.generateXrayConfig('vless://11111111-2222-3333-4444-555555555555@104.16.1.1:443?security=tls&sni=w.example.workers.dev&type=ws#ip', '', '', '', () => {});
    t('backend DNS: a config that already points at an IP is left alone', !ipCfg.dns);

    // ── MTU precedence (Android: method, then «همهٔ روش‌ها», then default) ──
    t('MTU: one slot per Windows method, in Android\'s order',
        JSON.stringify(ns.MTU_METHODS) === JSON.stringify(['masque', 'wireguard', 'gool', 'quick', 'sni', 'v2ray', 'gst']));
    ns.set({ mtu: { global: 1400 } });
    t('MTU: the app-wide value applies to every method', ns.mtuFor('xray.exe') === 1400 && ns.mtuFor('aether.exe', 'gool') === 1400 && ns.mtuFor('xray.exe', 'sni') === 1400);
    ns.set({ mtu: { wireguard: 1280 } });
    t('MTU: a method\'s own value beats the app-wide one — and only for that method',
        ns.mtuFor('aether.exe', 'wireguard') === 1280 && ns.mtuFor('aether.exe', 'masque') === 1400 && ns.mtuFor('xray.exe') === 1400);
    ns.set({ mtu: { sni: 1500, quick: 1300 } });
    t('MTU: Xray\'s three methods are separate (V2Ray / اتصال سریع / ضد فیلتر SNI)',
        ns.mtuFor('xray.exe', 'sni') === 1500 && ns.mtuFor('xray.exe', 'quick') === 1300 && ns.mtuFor('xray.exe') === 1400);
    ns.set({ mtu: { gool: 90000 } });
    t('MTU: out-of-range values are clamped, as on Android', ns.mtuFor('aether.exe', 'gool') === 1500);
    ns.set({ mtu: { gool: 100 } });
    t('MTU: …in both directions (576 floor)', ns.mtuFor('aether.exe', 'gool') === 576);
    t('MTU: aether\'s protocols map onto the three WARP methods',
        ns.methodOfAether('wg') === 'wireguard' && ns.methodOfAether('gool') === 'gool' && ns.methodOfAether('masque') === 'masque' && ns.methodOfAether(undefined) === 'masque');
    // the first 1.2.2 build saved a single «وارپ» value; it carries over to the three methods
    fs.writeFileSync(ns.FILE, JSON.stringify({ mtu: { global: 0, warp: 1300, masque: 1250 } }));
    ns._resetForTests();
    const mig = ns.get().mtu;
    t('MTU: the old single WARP value becomes each WARP method\'s — unless that method has its own',
        mig.masque === 1250 && mig.wireguard === 1300 && mig.gool === 1300 && mig.v2ray === 0 && mig.warp === undefined);
    const local = await ns.measureMethod('v2ray');
    t('MTU measure: a method that ends connections locally answers 1500 without probing (Android LOCAL_TERMINATION)',
        local.ok && local.localTermination && local.inner === 1500 && local.probes === 0);
    t('MTU measure: the WARP methods subtract Android\'s measured overhead',
        ns.MTU_OVERHEAD.masque === 196 && ns.MTU_OVERHEAD.wireguard === 60 && ns.MTU_OVERHEAD.gool === 280);
    ns.set({ mtu: { masque: 1500 } });
    const c = tun.buildTunConfig(20808, { processName: 'aether.exe', mtu: ns.mtuFor('aether.exe', 'masque') });
    t('MTU: the tunnel adapter is built with it', c.inbounds[0].mtu === 1500);
    const src = fs.readFileSync(ROOT + '/tun-manager.js', 'utf8');
    t('MTU: startTun reads it per method from network-settings and hands it to every builder',
        /mtuFor\(processName, method\)/.test(src) && /options\.mtuMethod/.test(src) && /methodOfAether\(/.test(src)
        && (src.slice(src.indexOf('async function startTun(')).match(/mtu: tunMtu,/g) || []).length >= 3);
    const srv = fs.readFileSync(ROOT + '/server.js', 'utf8');
    t('MTU: the V2Ray tunnel tells startTun which of Xray\'s methods it is',
        /mtuMethod: v2rayTunMethod\(\)/.test(srv) && /40443/.test(srv.slice(srv.indexOf('function v2rayTunMethod'), srv.indexOf('function v2rayTunOptions'))));

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
