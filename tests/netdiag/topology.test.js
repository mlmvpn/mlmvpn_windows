/*
 * Interface topology, against this machine's real adapter inventory.
 *
 * The fixture is not a constructed example: it is `Get-NetAdapter` from the development
 * machine, and it already contains the trap. TAP-Windows Adapter V9 — the adapter every
 * OpenVPN-family client installs — reports `Virtual: false`, and Windows named it
 * "Ethernet 3". Anything that classifies adapters by the Virtual flag or by the alias treats
 * somebody's VPN tunnel as a physical NIC it is free to repair.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const T = require(ROOT + '/netdiag/topology');
const ps = require(ROOT + '/netdiag/ps');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

const raw = ps.parseJson(fs.readFileSync(path.join(__dirname, 'fixtures', 'get-netadapter.json'), 'utf8'));
const adapters = raw.value.map(a => ({
    guid: a.InterfaceGuid, index: a.InterfaceIndex, name: a.Name,
    description: a.InterfaceDescription, status: a.Status, virtual: a.Virtual,
}));
const byDesc = rx => adapters.find(a => rx.test(a.description));

// ── classification on real drivers ──────────────────────────────────────────────────────

const tap = byDesc(/TAP-Windows/i);
t('the fixture really does contain the trap: TAP-Windows reports Virtual=false',
    tap && tap.virtual === false, JSON.stringify(tap && { v: tap.virtual, n: tap.name }));
t('TAP-Windows is classified as a VPN adapter DESPITE Virtual=false',
    T.classifyInterface(tap).cls === T.IF_CLASS.VPN_TAP, JSON.stringify(T.classifyInterface(tap)));
t('...and its alias "Ethernet 3" does not make it an Ethernet NIC',
    tap.name === 'Ethernet 3' && T.classifyInterface(tap).cls !== T.IF_CLASS.PHYSICAL_ETHERNET);

t('the Realtek USB Wi-Fi is physical wifi',
    T.classifyInterface(byDesc(/Realtek RTL8188/i)).cls === T.IF_CLASS.PHYSICAL_WIFI);
t('the Intel NIC is physical ethernet',
    T.classifyInterface(byDesc(/Intel\(R\) Ethernet/i)).cls === T.IF_CLASS.PHYSICAL_ETHERNET);
t('the Kerio virtual adapter is a VPN adapter, not a NIC',
    T.classifyInterface(byDesc(/Kerio/i)).cls === T.IF_CLASS.VPN_TUN);
t('"VPN Client Adapter - VPN" is a VPN adapter',
    T.classifyInterface(byDesc(/VPN Client Adapter/i)).cls === T.IF_CLASS.VPN_TUN);

// Ordering: these descriptions each contain a physical keyword and must not win on it.
t('Hyper-V vEthernet is virtual-host, not ethernet (pattern order is behaviour)',
    T.classifyInterface({ description: 'Hyper-V Virtual Ethernet Adapter' }).cls === T.IF_CLASS.VIRTUAL_HOST);
t('Wi-Fi Direct Virtual Adapter is virtual-host, not wifi',
    T.classifyInterface({ description: 'Microsoft Wi-Fi Direct Virtual Adapter #5' }).cls === T.IF_CLASS.VIRTUAL_HOST);
t('WSL is virtual-host',
    T.classifyInterface({ description: 'Hyper-V Virtual Ethernet Adapter (WSL)' }).cls === T.IF_CLASS.VIRTUAL_HOST);
t('Docker is virtual-host',
    T.classifyInterface({ description: 'Hyper-V Virtual Ethernet Adapter', name: 'vEthernet (Docker)' }).cls === T.IF_CLASS.VIRTUAL_HOST);
t('VMware is virtual-host',
    T.classifyInterface({ description: 'VMware Virtual Ethernet Adapter for VMnet8' }).cls === T.IF_CLASS.VIRTUAL_HOST);
t('VirtualBox is virtual-host',
    T.classifyInterface({ description: 'VirtualBox Host-Only Ethernet Adapter' }).cls === T.IF_CLASS.VIRTUAL_HOST);
t('Wintun is a VPN tunnel', T.classifyInterface({ description: 'Wintun Userspace Tunnel' }).cls === T.IF_CLASS.VPN_TUN);
t('loopback is loopback', T.classifyInterface({ index: 1, description: 'Software Loopback Interface 1' }).cls === T.IF_CLASS.LOOPBACK);

// The Prime Directive, applied to classification.
const mystery = T.classifyInterface({ description: 'Acme 9000 Series Controller', virtual: false });
t('an unrecognised adapter is OTHER with confidence "none" — never assumed physical',
    mystery.cls === T.IF_CLASS.OTHER && mystery.confidence === 'none', JSON.stringify(mystery));
t('Virtual=true is believed when no driver string matched (weak, but a true is informative)',
    T.classifyInterface({ description: 'Acme 9000', virtual: true }).cls === T.IF_CLASS.VIRTUAL_HOST);

// ── repair targets ──────────────────────────────────────────────────────────────────────

t('a virtual-host adapter is NEVER a repair target (the "fixed the Docker NIC" failure)',
    T.isRepairTarget({ cls: T.IF_CLASS.VIRTUAL_HOST }) === false);
t('loopback is never a repair target', T.isRepairTarget({ cls: T.IF_CLASS.LOOPBACK }) === false);
t('a VPN adapter is never a DIRECT repair target — only its owner may recover it',
    T.isRepairTarget({ cls: T.IF_CLASS.VPN_TUN }) === false
    && T.isRepairTarget({ cls: T.IF_CLASS.VPN_TAP }) === false);
t('an unclassified adapter is never a repair target',
    T.isRepairTarget({ cls: T.IF_CLASS.OTHER }) === false);
t('physical adapters are repair targets',
    T.isRepairTarget({ cls: T.IF_CLASS.PHYSICAL_WIFI }) && T.isRepairTarget({ cls: T.IF_CLASS.PHYSICAL_ETHERNET }));

// ── egress selection ────────────────────────────────────────────────────────────────────

const WIFI = '{bec3b2ce-5ef3-4297-b49d-b253e42e2805}';
const TUNG = '{c19bee7a-9a60-4b54-9261-fcd4d3d340f3}';
const ETH = '{13556269-8cf6-4e4d-92c8-8027637e678b}';

const ifaces = [
    { guid: WIFI, status: 'Up', metric: 45, cls: T.IF_CLASS.PHYSICAL_WIFI },
    { guid: TUNG, status: 'Up', metric: 5, cls: T.IF_CLASS.VPN_TUN },
    { guid: ETH, status: 'Disconnected', metric: 25, cls: T.IF_CLASS.PHYSICAL_ETHERNET },
];
const dr = (guid, metric, family) => ({ family: family || 'v4', prefix: '0.0.0.0/0', interfaceGuid: guid, metric });

let e = T.selectEgress(ifaces, [dr(WIFI, 5)], 'v4');
t('egress: the single default route wins', e.guid === WIFI && !e.ambiguous, JSON.stringify(e));

e = T.selectEgress(ifaces, [dr(WIFI, 5), dr(TUNG, 0)], 'v4');
t('egress: the tunnel wins on RouteMetric+InterfaceMetric, as Windows would decide',
    e.guid === TUNG, `${e.guid} :: ${e.reason}`);

e = T.selectEgress(ifaces, [dr(WIFI, 5), dr(ETH, 0)], 'v4');
t('egress: a default route on a Disconnected adapter cannot win',
    e.guid === WIFI, JSON.stringify(e));

e = T.selectEgress(ifaces, [dr(WIFI, 5), dr(TUNG, 45)], 'v4');
t('egress: a genuine tie is resolved deterministically AND flagged ambiguous',
    e.ambiguous === true && e.tiedWith.length === 2 && e.guid === T.selectEgress(ifaces, [dr(TUNG, 45), dr(WIFI, 5)], 'v4').guid,
    JSON.stringify(e));

e = T.selectEgress(ifaces, [], 'v4');
t('egress: no default route yields null with a reason, not a fabricated winner',
    e.guid === null && /no default route/.test(e.reason));

e = T.selectEgress([{ guid: WIFI, status: 'Up', metric: null }], [dr(WIFI, null)], 'v4');
t('egress: an unreadable metric yields null — an interface we cannot rank must not win by default',
    e.guid === null && /metric/.test(e.reason), JSON.stringify(e));

e = T.selectEgress(ifaces, [dr(WIFI, 5, 'v6')], 'v4');
t('egress: families are selected independently', e.guid === null);

// ── the assembled topology ──────────────────────────────────────────────────────────────

const topo = T.buildTopology({
    adapters,
    ifMetrics: { [WIFI]: 45, [TUNG]: 5 },
    defaultRoutes: [dr(WIFI, 5), dr(TUNG, 0)],
    addresses: [{ interfaceGuid: WIFI, family: 'v4', ip: '192.168.1.153', addressState: 'Preferred' }],
});
t('topology: every adapter from the fixture is present', topo.interfaces.length === 5);
t('topology: identity is the guid, lower-cased, on every interface',
    topo.interfaces.every(i => /^\{[0-9a-f-]+\}$/.test(i.guid)));
t('topology: addresses are attached to the right interface',
    topo.interfaces.find(i => i.guid === WIFI).addrs.length === 1);
t('topology: only the two physical adapters are repair targets',
    topo.interfaces.filter(i => i.repairTarget).length === 2,
    JSON.stringify(topo.interfaces.filter(i => i.repairTarget).map(i => i.description)));
t('topology: the VPN adapter is a repair target for nothing, even while Up',
    topo.interfaces.find(i => i.guid === TUNG).repairTarget === false);

t('topology: multiple default routes are REPORTED, not treated as a fault',
    topo.multipleDefaults.v4 === true && typeof topo.multipleDefaults.v6 === 'boolean');
// The VPN adapter in this fixture is Disconnected, so despite holding the cheaper default
// route it cannot be the egress — which is the correct answer and the reason the status check
// is not an optimisation. A stale route left behind by a disconnected tunnel must never be
// read as the path traffic is taking.
t('topology: a cheaper default route on a DISCONNECTED VPN adapter does not win the egress',
    T.egressInterface(topo, 'v4').guid === WIFI,
    JSON.stringify({ chosen: topo.egress.v4.guid, tunStatus: topo.interfaces.find(i => i.guid === TUNG).status }));
t('topology: an empty inventory is marked unreadable rather than "no adapters"',
    T.buildTopology({}).readable === false);

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
