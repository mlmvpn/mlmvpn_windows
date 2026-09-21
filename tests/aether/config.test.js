// The sing-box configuration this app generates.
//
// Rule ORDER is the behaviour here, not a stylistic choice — sing-box takes the first
// matching rule, so a rule placed below a broader one is dead weight. Several of the
// orderings below have already been the cause of a real leak or a real outage, and nothing
// in the config file itself says so. These tests are what stops a tidy-up from silently
// reintroducing one.
const ROOT = require('path').resolve(__dirname, '..', '..');
const tun = require(ROOT + '/tun-manager');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const full = tun.buildTunConfig(20810, {});
const smart = tun.buildSmartTunConfig(20810, { dohUrl: 'https://example.workers.dev/dns-query' });

const idxOf = (cfg, pred) => cfg.route.rules.findIndex(pred);

// ── DNS must never fall back to cleartext ────────────────────────────────────────
// `final` decides what happens to every lookup no rule matched. Setting it to the direct
// resolver is the DNS leak this whole config exists to prevent, and the on-disk config left
// by an older build had exactly that (`"final": "local"`, i.e. straight to 8.8.8.8).
t('full tunnel: unmatched DNS goes through the tunnel, not direct',
    full.dns.final === 'remote', full.dns.final);
t('full tunnel: the remote resolver is detoured through the engine',
    full.dns.servers.find(s => s.tag === 'remote').detour === 'aether');
t('full tunnel: the direct resolver exists ONLY for bootstrap, never as the default',
    full.dns.servers.some(s => s.tag === 'local' && !s.detour) && full.dns.final !== 'local');
t('smart mode: unmatched DNS goes to the DoH worker, not the ISP',
    smart.dns.final === 'doh', smart.dns.final);

// ── IPv6 containment ─────────────────────────────────────────────────────────────
// The data plane is IPv4. Handing an application a AAAA record invites a connection the
// tunnel cannot carry; letting a v6 packet reach `direct` is a plain leak.
t('full tunnel: no AAAA is ever handed out (ipv4_only, not prefer_ipv4)',
    full.dns.strategy === 'ipv4_only', full.dns.strategy);
t('smart mode: same',
    smart.dns.strategy === 'ipv4_only', smart.dns.strategy);
t('full tunnel: the adapter claims an IPv6 address, or auto_route installs no v6 routes and v6 escapes',
    full.inbounds[0].address.some(a => a.includes(':')), JSON.stringify(full.inbounds[0].address));
t('full tunnel: IPv6 is rejected, never sent direct',
    full.route.rules.some(r => r.ip_version === 6 && r.action === 'reject'));
t('smart mode: IPv6 is rejected, never sent direct',
    smart.route.rules.some(r => r.ip_version === 6 && r.action === 'reject'));
t('full tunnel: no rule sends IPv6 to a direct outbound',
    !full.route.rules.some(r => r.ip_version === 6 && r.outbound === 'direct'));

// ── loop prevention ──────────────────────────────────────────────────────────────
// The engine's own uplink must leave the machine, not be handed back to the SOCKS port the
// engine is serving. Windows refuses the process lookup for some sockets, so the address
// rule is not redundant with the process rule — it is the one that holds when the other
// cannot match.
const procIdx = idxOf(full, r => Array.isArray(r.process_name));
const cidrIdx = idxOf(full, r => Array.isArray(r.ip_cidr) && (r.ip_cidr[0] || '').startsWith('162.159'));
const hijackIdx = idxOf(full, r => r.action === 'hijack-dns');
t('full tunnel: the engine process is excluded', procIdx >= 0);
t('full tunnel: the engine uplink is ALSO excluded by address', cidrIdx >= 0);
t('full tunnel: both exclusions come BEFORE DNS hijacking, or the engine cannot resolve to connect',
    procIdx < hijackIdx && cidrIdx < hijackIdx, `proc=${procIdx} cidr=${cidrIdx} hijack=${hijackIdx}`);

// The static range list cannot be the whole answer: the engine also lands on Cloudflare CDN
// anycast addresses (104.16.24.84 was in this machine's identity file), and 104.16.0.0/12 is
// too much of the ordinary web to exclude wholesale. The live address goes in as a /32.
const live = tun.buildTunConfig(20810, { uplinkIps: ['104.16.24.84', '2606:4700::1', 'garbage'] });
const liveRule = live.route.rules.find(r => Array.isArray(r.ip_cidr) && r.outbound === 'direct');
t("full tunnel: the engine's live edge is excluded as a single host",
    liveRule.ip_cidr.includes('104.16.24.84/32'), JSON.stringify(liveRule.ip_cidr.slice(-3)));
t('...v6 as /128, and it never widens the exclusion beyond that host',
    liveRule.ip_cidr.includes('2606:4700::1/128')
    && !liveRule.ip_cidr.some(c => /^104\.16\.0\.0/.test(c)));
t('...and an unparseable address is dropped rather than written into the config',
    !liveRule.ip_cidr.some(c => c.includes('garbage')));
t('the engine control plane resolves and routes OFF the tunnel (it must work before one exists)',
    full.route.rules.some(r => (r.domain_suffix || []).includes('cloudflareclient.com') && r.outbound === 'direct')
    && full.dns.rules.some(r => (r.domain_suffix || []).includes('cloudflareclient.com') && r.server === 'local'));

// ── filter sinkhole vs LAN ───────────────────────────────────────────────────────
// A censored name resolves to a private address (10.10.34.x). The LAN rule would send that
// straight out the physical interface to the ISP's block page, and because the sinkhole
// ACCEPTS the connection there is no dial error anywhere to notice.
const sinkIdx = idxOf(full, r => Array.isArray(r.ip_cidr) && r.ip_cidr.includes('10.10.34.0/24'));
const privIdx = idxOf(full, r => r.ip_is_private === true);
t('full tunnel: the filter sinkhole is rejected BEFORE the private-address rule',
    sinkIdx >= 0 && privIdx >= 0 && sinkIdx < privIdx, `sinkhole=${sinkIdx} private=${privIdx}`);
const sSinkIdx = idxOf(smart, r => Array.isArray(r.ip_cidr) && r.ip_cidr.includes('10.10.34.0/24'));
const sPrivIdx = idxOf(smart, r => r.ip_is_private === true);
t('smart mode: same ordering (worse here — this mode sends Iranian traffic direct on purpose)',
    sSinkIdx >= 0 && sPrivIdx >= 0 && sSinkIdx < sPrivIdx, `sinkhole=${sSinkIdx} private=${sPrivIdx}`);

// ── adapter identity ─────────────────────────────────────────────────────────────
// The readiness check, the watchdog and the firewall allow-rule all locate the adapter by
// name. An auto-generated name makes all three unreliable, and a kill switch whose allow
// rule names the wrong adapter is a machine with no internet.
t('the adapter has a fixed, known name', full.inbounds[0].interface_name === 'MLMVPN',
    full.inbounds[0].interface_name);
t('smart mode uses the same name', smart.inbounds[0].interface_name === 'MLMVPN');
t('tun-manager exports that name so the guard and watchdog agree with the config',
    tun.TUN_IFACE_NAME === full.inbounds[0].interface_name);

// ── MTU ──────────────────────────────────────────────────────────────────────────
// The real path is a MASQUE/QUIC datagram with ~1400 bytes of usable payload, and QUIC sets
// DF — so anything sized to a 9000-byte interface MTU is dropped, silently, with nothing
// logged. An older on-disk config had mtu 9000.
t('MTU fits inside a QUIC datagram', full.inbounds[0].mtu <= 1420 && full.inbounds[0].mtu >= 1280,
    String(full.inbounds[0].mtu));

// ── UDP-less engines ─────────────────────────────────────────────────────────────
const noUdp = tun.buildTunConfig(20810, { supportsUdp: false });
t('a UDP-less engine still resolves THROUGH the tunnel, over TCP — not direct',
    noUdp.dns.servers.find(s => s.tag === 'remote').type === 'tcp'
    && noUdp.dns.servers.find(s => s.tag === 'remote').detour === 'aether');
t('a UDP-less engine rejects QUIC so the browser falls back at once instead of stalling',
    noUdp.route.rules.some(r => r.protocol === 'quic' && r.action === 'reject'));
t('a UDP-capable engine does NOT reject QUIC',
    !full.route.rules.some(r => r.protocol === 'quic' && r.action === 'reject'));

// ── strict route ─────────────────────────────────────────────────────────────────
t('strict_route is on (Windows multihomed DNS escapes without it)',
    full.inbounds[0].strict_route === true && smart.inbounds[0].strict_route === true);
t('auto_route is on', full.inbounds[0].auto_route === true);

// ── the engine that owns the SOCKS port is the one excluded ──────────────────────
const gst = tun.buildTunConfig(9999, { processName: 'gst.exe', uplinkCidrs: ['203.0.113.0/24'] });
t('a different engine excludes ITS OWN process, not aether.exe',
    gst.route.rules.find(r => r.process_name).process_name[0] === 'gst.exe');
t('a different engine excludes ITS OWN uplink range',
    gst.route.rules.find(r => Array.isArray(r.ip_cidr) && r.ip_cidr.includes('203.0.113.0/24')) !== undefined);
t('the SOCKS port in the outbound is the one passed in',
    gst.outbounds.find(o => o.type === 'socks').server_port === 9999);

// ── A RULE WITH NO CONDITIONS MATCHES EVERYTHING ────────────────────────────────
//
// sing-box rules are sets of conditions, and a rule whose lists are all empty has none — so
// it matches every connection, at whatever position it sits. `sing-box check` accepts it
// without a word. This shipped: `{ ip_cidr: uplinkCidrs, outbound: 'direct' }` was emitted
// unconditionally, and `uplinkCidrs` is EMPTY for every config whose address is a name rather
// than a clean IP (most Cloudflare configs). Third in the list, it turned the whole tunnel
// into a passthrough — ordinary sites kept working so the payload check passed and the switch
// went green, filtered sites were reset by the ISP the moment they left in the clear, and
// «بدون نشتی» was on over a connection carrying the user's real address.
const byName = tun.buildTunConfig(20810, {
    processName: 'xray.exe', engineTag: 'v2ray', mode: 'full',
    uplinkCidrs: [], uplinkDomains: ['worker.example.workers.dev'],
    supportsUdp: false, rejectQuic: true, remoteDns: '8.8.8.8',
});
const VERBS = new Set(['action', 'outbound', 'server', 'invert', 'strategy',
    'disable_cache', 'rewrite_ttl', 'client_subnet', 'override_address', 'override_port']);
const routesSomewhere = (r) => !!(r.outbound || r.server) || !['sniff', 'resolve'].includes(r.action);
const conditionless = (rules) => (rules || []).filter(r =>
    !Object.keys(r).some(k => {
        if (VERBS.has(k)) return false;
        const v = r[k];
        return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
    }) && routesSomewhere(r));

t('a node addressed by NAME produces no rule that matches everything',
    conditionless(byName.route.rules).length === 0, JSON.stringify(conditionless(byName.route.rules)));
t('…and none in its DNS rules either',
    conditionless(byName.dns.rules).length === 0, JSON.stringify(conditionless(byName.dns.rules)));
t('…while the exclusion it CAN express is still there',
    byName.route.rules.some(r => (r.domain_suffix || []).includes('worker.example.workers.dev')));

// A node addressed by a clean IP is the other half: the address rule must appear then.
const byIp = tun.buildTunConfig(20810, {
    processName: 'xray.exe', engineTag: 'v2ray', mode: 'full',
    uplinkCidrs: ['104.21.69.66/32'], uplinkDomains: [],
    supportsUdp: false, rejectQuic: true, remoteDns: '8.8.8.8',
});
t('a node addressed by a clean IP still gets its address excluded',
    byIp.route.rules.some(r => (r.ip_cidr || []).includes('104.21.69.66/32')));
t('…and it too has no rule that matches everything',
    conditionless(byIp.route.rules).length === 0, JSON.stringify(conditionless(byIp.route.rules)));

// ── AN ENGINE WITH NO UDP MUST NEVER BE HANDED UDP ──────────────────────────────
//
// The QUIC rule only catches what sniffing RECOGNISES as QUIC; everything else on UDP fell
// through to `final` and was handed to a node that cannot carry a datagram — a black hole,
// not a refusal. Measured from a real run (2026-09-12): 28 UDP/443 datagrams from chrome.exe
// to Google addresses and not one TCP connection to them, while 135 TCP connections went
// through the tunnel fine. That is «سایت‌های بدون فیلتر باز می‌شوند ولی یوتیوب نه».
const workerNode = tun.buildTunConfig(20810, {
    processName: 'xray.exe', engineTag: 'v2ray', mode: 'full',
    uplinkCidrs: [], uplinkDomains: ['w.example.workers.dev'],
    supportsUdp: false, rejectQuic: true, remoteDns: '8.8.8.8',
});
const at = (cfg, pred) => cfg.route.rules.findIndex(pred);
const udpRejectAt = at(workerNode, r => r.network === 'udp' && r.action === 'reject');
t('a UDP-less node refuses UDP outright instead of swallowing it',
    udpRejectAt >= 0, JSON.stringify(workerNode.route.rules));
t('…telling the client, so the browser falls back to TCP rather than waiting',
    udpRejectAt >= 0 && workerNode.route.rules[udpRejectAt].method === 'default');
// Order is the behaviour: before the DNS hijack it would kill every lookup, and before the
// LAN rule it would take mDNS, SMB, printers and DHCP with it.
t('…after the DNS hijack, so lookups still work over TCP through the tunnel',
    udpRejectAt > at(workerNode, r => r.action === 'hijack-dns'));
t('…and after the LAN rule, so local UDP is untouched',
    udpRejectAt > at(workerNode, r => r.ip_is_private === true));
t('a node that DOES carry UDP gets no such rule',
    at(tun.buildTunConfig(20810, {
        processName: 'xray.exe', engineTag: 'v2ray', mode: 'full',
        uplinkCidrs: [], uplinkDomains: [], supportsUdp: true, rejectQuic: false, remoteDns: '1.1.1.1',
    }), r => r.network === 'udp' && r.action === 'reject') === -1);
// A rejection the client never hears about is a black hole with extra steps.
t('QUIC is rejected in a way the client is told about',
    (workerNode.route.rules.find(r => r.protocol === 'quic') || {}).method === 'default');

// The net behind the guards: a builder that forgets one must not be able to ship a passthrough.
const poisoned = {
    route: { rules: [{ action: 'sniff' }, { ip_cidr: [], outbound: 'direct' }, { ip_is_private: true, outbound: 'direct' }] },
    dns: { rules: [{ domain_suffix: [], server: 'local' }, { inbound: 'tun-in', server: 'remote' }] },
};
tun.dropConditionlessRules(poisoned);
t('the safety net removes a conditionless ROUTING rule',
    !poisoned.route.rules.some(r => r.ip_cidr && !r.ip_cidr.length), JSON.stringify(poisoned.route.rules));
t('…and a conditionless DNS rule',
    !poisoned.dns.rules.some(r => r.domain_suffix && !r.domain_suffix.length), JSON.stringify(poisoned.dns.rules));
t('…while keeping the ones that are unconditional on purpose (sniff)',
    poisoned.route.rules[0] && poisoned.route.rules[0].action === 'sniff', JSON.stringify(poisoned.route.rules));
t('…and keeping every real rule',
    poisoned.route.rules.length === 2 && poisoned.dns.rules.length === 1,
    `${poisoned.route.rules.length} route / ${poisoned.dns.rules.length} dns`);

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
