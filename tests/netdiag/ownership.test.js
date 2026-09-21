/*
 * Ownership — the subsystem where a wrong answer is most expensive.
 *
 * Two failure directions, and this suite pins both:
 *
 *   a false FOREIGN disables a live tunnel's system proxy and sends an Iranian user's
 *   traffic out in the clear while reporting success. The repository's own
 *   systemProxyIsOurs() compares `state.server === '127.0.0.1:' + rt.httpPort` — exact
 *   string, HKCU only, GST's port only — so every alternative spelling Windows accepts, and
 *   every proxy set by xray-manager (port 20809), reads as "not ours". The string cases below
 *   are that bug, written down.
 *
 *   a false OURS-LIVE reports a stuck kill switch as "by design, nothing to fix" on a machine
 *   with no internet. aether-guard.js:67 records only `pid: process.pid`, and Windows reuses
 *   pids across a reboot. The pid-reuse cases below are that bug, written down.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const O = require(ROOT + '/netdiag/ownership');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

const INSTALL = 'C:\\Program Files\\MLMVPN';
const OURS = INSTALL + '\\core\\xray.exe';
const THEIRS = 'C:\\Program Files\\Fiddler\\Fiddler.exe';

// ── ProxyServer spellings — all of these are the same configuration ─────────────────────

const spellings = [
    ['bare host:port (what xray-manager writes)', '127.0.0.1:20809', 20809],
    ['per-protocol (what Windows stores when set through the UI)', 'http=127.0.0.1:10809;https=127.0.0.1:10809', 10809],
    ['per-protocol with a trailing separator', 'http=127.0.0.1:10809;https=127.0.0.1:10809;', 10809],
    ['localhost instead of the literal', 'localhost:10809', 10809],
    ['an IPv6 loopback literal', '[::1]:10809', 10809],
    ['a scheme prefix', 'http://127.0.0.1:10809', 10809],
    ['surrounding whitespace', '  127.0.0.1:20809  ', 20809],
];
for (const [label, value, port] of spellings) {
    const p = O.parseProxyServer(value);
    t(`ProxyServer: ${label} parses to a loopback endpoint on ${port}`,
        p.ok && p.endpoints.some(x => x.port === port && x.loopback), JSON.stringify(p));
}
t('ProxyServer: an empty value is "no endpoints", which is not a parse failure',
    O.parseProxyServer('').ok === true && O.parseProxyServer('').endpoints.length === 0);
t('ProxyServer: an unrecognisable value is a parse FAILURE, not silently zero endpoints',
    O.parseProxyServer('this is not a proxy').ok === false);
t('ProxyServer: a real external proxy is not loopback',
    O.parseProxyServer('proxy.corp.local:8080').endpoints[0].loopback === false);

// ── the decision ────────────────────────────────────────────────────────────────────────

const ep = v => O.parseProxyServer(v).endpoints;

let d = O.classifyProxyOwnership({
    endpoints: ep('http=127.0.0.1:10809;https=127.0.0.1:10809'),
    listener: { pid: 4321, imagePath: OURS },
    claims: ['xray'], installDir: INSTALL,
});
t('OURS-LIVE: a per-protocol string served by our own binary is ours, however it is spelled',
    d.state === O.OWNERSHIP.OURS_LIVE, `${d.state} :: ${d.reason}`);
t('OURS-LIVE: no repair may touch it, and it is not auto-eligible',
    d.policy.mayRepair === false && d.policy.autoEligible === false);

d = O.classifyProxyOwnership({
    endpoints: ep('[::1]:10809'), listener: { pid: 1, imagePath: OURS }, claims: [], installDir: INSTALL,
});
t('OURS-LIVE: identity comes from the LISTENER, so it holds even with no adapter claim',
    d.state === O.OWNERSHIP.OURS_LIVE, d.reason);

d = O.classifyProxyOwnership({
    endpoints: ep('127.0.0.1:20809'), listener: null, claims: ['xray'], installDir: INSTALL,
});
t('OURS-ORPHANED: a dead port that one of ours claims is stale state, not a foreign proxy',
    d.state === O.OWNERSHIP.OURS_ORPHANED, `${d.state} :: ${d.reason}`);
t('OURS-ORPHANED: repairable, but only through the owner\'s own recovery path, never auto',
    d.policy.mayRepair === true && d.policy.via === 'owner-recovery' && d.policy.autoEligible === false);

d = O.classifyProxyOwnership({ endpoints: ep('127.0.0.1:9999'), listener: null, claims: [], installDir: INSTALL });
t('FOREIGN: a dead loopback port nobody of ours claims is proved foreign',
    d.state === O.OWNERSHIP.FOREIGN && d.policy.autoEligible === true, d.reason);

d = O.classifyProxyOwnership({ endpoints: ep('127.0.0.1:8888'), listener: { pid: 9, imagePath: THEIRS }, claims: [], installDir: INSTALL });
t('FOREIGN: another program\'s proxy is proved foreign by its image path',
    d.state === O.OWNERSHIP.FOREIGN, d.reason);

d = O.classifyProxyOwnership({ endpoints: ep('proxy.corp.local:8080'), claims: [], installDir: INSTALL });
t('FOREIGN: a non-loopback proxy cannot be ours — every engine here listens on loopback',
    d.state === O.OWNERSHIP.FOREIGN, d.reason);

// ── unknown must fail safe, in every direction ──────────────────────────────────────────

const unknowns = [
    ['the listening process could not be looked up', { endpoints: ep('127.0.0.1:20809'), claims: [], installDir: INSTALL }],
    ['something listens but its executable is unidentifiable',
        { endpoints: ep('127.0.0.1:20809'), listener: { pid: 5, imagePath: null }, claims: [], installDir: INSTALL }],
    ['an engine claims the port but a foreign binary answers there',
        { endpoints: ep('127.0.0.1:20809'), listener: { pid: 5, imagePath: THEIRS }, claims: ['gst'], installDir: INSTALL }],
    ['the configuration could not be parsed at all', { endpoints: [], claims: [], installDir: INSTALL }],
    ['we could not read our own install directory',
        { endpoints: ep('127.0.0.1:20809'), listener: { pid: 5, imagePath: OURS }, claims: ['xray'], installDir: null }],
];
for (const [label, ev] of unknowns) {
    const r = O.classifyProxyOwnership(ev);
    const safe = r.state !== O.OWNERSHIP.FOREIGN && r.policy.autoEligible === false;
    t(`UNKNOWN fails safe: ${label} => never FOREIGN, never auto`, safe, `${r.state} :: ${r.reason}`);
}
t('the unknown policy says why, in the words of the Prime Directive',
    /absence of evidence/i.test(O.repairPolicy(O.OWNERSHIP.UNKNOWN).reason));

// ── process identity and pid reuse ──────────────────────────────────────────────────────

t('identity: pid + image path + start time all matching is a match',
    O.processIdentityMatches({ pid: 100, imagePath: OURS, createTime: 't1' },
        { pid: 100, imagePath: OURS, createTime: 't1' }).match === 'yes');
t('identity: the SAME pid running a different executable is pid reuse, not our process',
    O.processIdentityMatches({ pid: 100, imagePath: OURS, createTime: 't1' },
        { pid: 100, imagePath: THEIRS, createTime: 't9' }).match === 'no');
t('identity: the same pid and path with a different start time is pid reuse',
    O.processIdentityMatches({ pid: 100, imagePath: OURS, createTime: 't1' },
        { pid: 100, imagePath: OURS, createTime: 't2' }).match === 'no');
t('identity: a dead pid is not a match', O.processIdentityMatches({ pid: 100 }, null).match === 'no');

// The one that matters most: what the existing guard actually writes.
const legacy = O.processIdentityMatches({ pid: 100 }, { pid: 100, imagePath: THEIRS, createTime: 't9' });
t('identity: a record carrying ONLY a pid is UNKNOWN even when that pid is alive — this is the reboot + pid-reuse case that hid a stuck kill switch',
    legacy.match === 'unknown' && /pid reuse/i.test(legacy.reason), JSON.stringify(legacy));
t('identity: no record at all is unknown, not "not ours"',
    O.processIdentityMatches(null, { pid: 1 }).match === 'unknown');
t('identity: a record with detail we cannot compare against is unknown',
    O.processIdentityMatches({ pid: 100, imagePath: OURS }, { pid: 100, imagePath: null }).match === 'unknown');

t('install-dir containment is case- and separator-insensitive',
    O.isOurImage('c:/program files/mlmvpn/core/xray.exe', INSTALL) === true);
t('install-dir containment is not fooled by a sibling directory with the same prefix',
    O.isOurImage('C:\\Program Files\\MLMVPN-evil\\x.exe', INSTALL) === false);

// ── guard state: deliberate, stale, or drifted ──────────────────────────────────────────

let g = O.classifyGuardState({
    engaged: true, stateFilePresent: true,
    recordedOwner: { pid: 10, imagePath: OURS, createTime: 't1' },
    actualOwner: { pid: 10, imagePath: OURS, createTime: 't1' },
    dataPathOk: true,
});
t('guard: engaged + owner alive + data path proven => by-design, zero repairs',
    g.state === O.OWNERSHIP.OURS_LIVE && g.policy.mayRepair === false, g.reason);

g = O.classifyGuardState({
    engaged: true, stateFilePresent: true,
    recordedOwner: { pid: 10, imagePath: OURS, createTime: 't1' },
    actualOwner: null,
});
t('guard: engaged with a dead owner => stale protection, a first-class fault',
    g.state === O.OWNERSHIP.OURS_ORPHANED && g.policy.via === 'owner-recovery', g.reason);

g = O.classifyGuardState({
    engaged: true, stateFilePresent: true,
    recordedOwner: { pid: 10 },
    actualOwner: { pid: 10, imagePath: THEIRS, createTime: 't9' },
});
t('guard: after a reboot with the pid reused, a stuck kill switch is NOT called by-design',
    g.state !== O.OWNERSHIP.OURS_LIVE && g.policy.mayRepair === false, `${g.state} :: ${g.reason}`);

g = O.classifyGuardState({
    engaged: true, stateFilePresent: true,
    recordedOwner: { pid: 10, imagePath: OURS, createTime: 't1' },
    actualOwner: { pid: 10, imagePath: OURS, createTime: 't1' },
    dataPathOk: false,
});
t('guard: owner alive but carrying no data => orphaned, not healthy',
    g.state === O.OWNERSHIP.OURS_ORPHANED, g.reason);

g = O.classifyGuardState({ engaged: false, stateFilePresent: true, recordedOwner: { pid: 10 } });
t('guard: we recorded engaging but the machine disagrees => UNKNOWN, the record has drifted',
    g.state === O.OWNERSHIP.UNKNOWN && /drifted/.test(g.reason), g.reason);

g = O.classifyGuardState({ engaged: true, stateFilePresent: false });
t('guard: a block we never recorded setting is FOREIGN — reported, never silently reversed',
    g.state === O.OWNERSHIP.FOREIGN, g.reason);

g = O.classifyGuardState({ stateFilePresent: true });
t('guard: unreadable firewall state is unknown, never "not engaged"',
    g.state === O.OWNERSHIP.UNKNOWN);

// ── adapters ────────────────────────────────────────────────────────────────────────────

const good = O.makeAdapter({ id: 'xray', claimsProxyEndpoint: (h, p) => p === 20809 });
const broken = O.makeAdapter({ id: 'boom', claimsProxyEndpoint: () => { throw new Error('module not loaded'); } });
t('a default adapter claims nothing', O.makeAdapter({}).claimsProxyEndpoint('127.0.0.1', 1) === false);
t('claimants are collected from the adapters that say yes',
    O.claimantsForProxy([good, broken], '127.0.0.1', 20809).join() === 'xray');
t('a throwing adapter shim cannot decide ownership or crash the pass',
    O.claimantsForProxy([broken], '127.0.0.1', 1).length === 0);

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
