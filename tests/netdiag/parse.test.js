/*
 * NetDiag parsers, against fixtures captured from real Windows output.
 *
 * The invariant every case here defends is one sentence long:
 *
 *     A parser that cannot read something must say UNKNOWN, never FALSE.
 *
 * That sounds pedantic until you follow it through. `parseRoutePrint4` returning `[]` on
 * output it did not understand is indistinguishable from a machine with no default route,
 * and "no default route" is the top-left cell of the diagnosis matrix — the one that reports
 * a broken link, a dead gateway, or a stopped BFE service, and offers privileged repairs for
 * all three. On a healthy German machine.
 *
 * Two of the fixtures below are here because this machine produced them, not because anyone
 * predicted them:
 *   * every PS 5.1 `Out-File -Encoding utf8` carries a BOM, and JSON.parse throws on it;
 *   * `Get-NetRoute -DestinationPrefix 0.0.0.0/0` returns a bare object, not a one-element
 *     array, whenever there is exactly one default route — i.e. on most machines.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const ps = require(ROOT + '/netdiag/ps');

const FIX = path.join(__dirname, 'fixtures');
const fx = name => fs.readFileSync(path.join(FIX, name), 'utf8');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

// ── route print: the structural parse ───────────────────────────────────────────────────

const r4 = ps.parseRoutePrint4(fx('route-print-4.en.txt'));
t('route print -4: parses', r4.ok, r4.reason);
t('route print -4: finds exactly one default route',
    r4.ok && r4.defaults.length === 1, r4.ok ? String(r4.defaults.length) : r4.reason);
t('route print -4: default route carries gateway and metric',
    r4.ok && r4.defaults[0].gateway === '192.168.1.1' && r4.defaults[0].metric === 50,
    r4.ok && JSON.stringify(r4.defaults[0]));
t('route print -4: on-link rows are flagged, not mistaken for a gateway',
    r4.ok && r4.value.some(x => x.onLink && x.gateway === null));

// The whole reason this parser refuses to read headers.
const rDe = ps.parseRoutePrint4(fx('route-print-4.de.txt'));
t('route print -4: a GERMAN table parses identically (no header/keyword dependence)',
    rDe.ok && rDe.defaults.length === 1 && rDe.defaults[0].gateway === '192.168.1.1',
    rDe.ok ? JSON.stringify(rDe.defaults[0]) : rDe.reason);
t('route print -4: German on-link token is recognised as on-link without knowing the word',
    rDe.ok && rDe.value.some(x => x.onLink && x.gateway === null));

// UNKNOWN, not "no routes".
for (const [label, input] of [
    ['empty output', ''],
    ['whitespace only', '   \r\n  \r\n'],
    ['an error message', 'The requested operation requires elevation.'],
    ['truncated garbage', '=====\r\nInterface List\r\n=====\r\n']]) {
    const r = ps.parseRoutePrint4(input);
    t(`route print -4: ${label} => NOT ok (unknown), never an empty route set`,
        r.ok === false && r.value === null, JSON.stringify(r));
}

const ifs = ps.parseRoutePrintInterfaces(fx('route-print-4.en.txt'));
t('route print: interface list parses every adapter incl. loopback',
    ifs.ok && ifs.value.length === 8, ifs.ok ? String(ifs.value.length) : ifs.reason);
t('route print: loopback has no MAC and that is not an error',
    ifs.ok && ifs.value.some(i => i.index === 1 && i.mac === null));
t('route print: the TAP adapter is present (multi-adapter reality, not a clean lab machine)',
    ifs.ok && ifs.value.some(i => /TAP-Windows/i.test(i.description)));

// ── PowerShell JSON: the three traps ────────────────────────────────────────────────────

const jRoute = ps.parseJson(fx('get-netroute.json'));
t('PS JSON: a UTF-8 BOM does not break the parse (PS 5.1 Out-File always writes one)',
    jRoute.ok && Array.isArray(jRoute.value), jRoute.reason);

const jSingle = ps.parseJson(fx('get-netroute-default-single.json'));
t('PS JSON: a SINGLE row is normalised to a one-element array',
    jSingle.ok && jSingle.value.length === 1, jSingle.ok ? String(jSingle.value.length) : jSingle.reason);
t('PS JSON: the single-row case is flagged as not-originally-an-array',
    jSingle.ok && jSingle.wasArray === false);
t('PS JSON: the single default route survives — this is the "no default route" false alarm',
    jSingle.ok && jSingle.value[0].DestinationPrefix === '0.0.0.0/0'
    && jSingle.value[0].NextHop === '192.168.1.1');

const jTrunc = ps.parseJson(fx('get-netroute-truncated.json'));
t('PS JSON: depth-truncated rows are detected', jTrunc.ok && jTrunc.truncated === true);
t('PS JSON: a truncated FIELD reads as undefined, not as the string "System.Object[]"',
    ps.field(jTrunc.value[0], 'CimInstanceProperties') === undefined);
t('PS JSON: intact fields on the same row are still readable',
    ps.field(jTrunc.value[0], 'NextHop') === '192.168.1.1');

for (const [label, input] of [['empty', ''], ['null literal', 'null'], ['not JSON', 'Access is denied.']]) {
    const r = ps.parseJson(input);
    t(`PS JSON: ${label} => NOT ok, value null`, r.ok === false && r.value === null, r.reason);
}

// ── Windows enumerations ────────────────────────────────────────────────────────────────
//
// Numeric, therefore not localised — but silent if read wrong. AddressFamily 23 read as IPv4
// would file every v6 observation under v4 and make a v6-only outage invisible.

t('AddressFamily: 2 is IPv4, 23 is IPv6',
    ps.familyOf(2) === 'v4' && ps.familyOf(23) === 'v6');
t('AddressFamily: anything else is null, never a defaulted "v4"',
    ps.familyOf(0) === null && ps.familyOf(undefined) === null);
t('Neighbor state: 0 is Unreachable and 5 is Reachable (the L2-vs-routing discriminator)',
    ps.neighborState(0) === 'Unreachable' && ps.neighborState(5) === 'Reachable');
t('Neighbor state: an unrecognised code is null, not a guess', ps.neighborState(99) === null);
t('Neighbor state: a build that emits the name instead of the code still works',
    ps.neighborState('Stale') === 'Stale');

const jNeigh = ps.parseJson(fx('get-netneighbor.json'));
t('Get-NetNeighbor fixture: every row maps to a known family and a known state',
    jNeigh.ok && jNeigh.value.every(r => ps.familyOf(r.AddressFamily) !== null
        && ps.neighborState(r.State) !== null));

// ── WinHTTP: structured primary, text fallback ──────────────────────────────────────────

const direct = ps.parseWinhttpSettingsBlob('180000000100000001000000');
t('WinHttpSettings: the direct-access flag is read structurally, in any locale',
    direct.ok && direct.value.mode === 'direct', JSON.stringify(direct));

// flags=2, then a length-prefixed "127.0.0.1:20809" and an empty bypass list.
const server = '127.0.0.1:20809';
const blob = Buffer.concat([
    Buffer.from([0x18, 0, 0, 0, 0x02, 0, 0, 0, 0x02, 0, 0, 0]),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(server.length); return b; })(),
    Buffer.from(server, 'ascii'),
    Buffer.from([0, 0, 0, 0]),
]);
const cfg = ps.parseWinhttpSettingsBlob(blob);
t('WinHttpSettings: a configured proxy is read structurally',
    cfg.ok && cfg.value.mode === 'proxy' && cfg.value.server === server, JSON.stringify(cfg));
t('WinHttpSettings: a short/garbage blob is unknown, not "direct"',
    ps.parseWinhttpSettingsBlob('00').ok === false);

const wpEn = ps.parseWinhttpShowProxy(fx('winhttp-show-proxy-configured.en.txt'));
t('netsh winhttp (fallback): a configured proxy is found because host:port is not translated',
    wpEn.ok && wpEn.value.server === '127.0.0.1:20809', JSON.stringify(wpEn));

// The important one. "Direct access" is English; the parser must NOT claim direct.
const wpDirect = ps.parseWinhttpShowProxy(fx('winhttp-show-proxy.en.txt'));
t('netsh winhttp (fallback): ENGLISH "Direct access" is reported as unknown, not as direct',
    wpDirect.ok === false && /direct.*cannot be confirmed/i.test(wpDirect.reason), wpDirect.reason);
const wpDe = ps.parseWinhttpShowProxy(fx('winhttp-show-proxy.de.txt'));
t('netsh winhttp (fallback): GERMAN "Direkter Zugriff" is likewise unknown, never false',
    wpDe.ok === false && wpDe.value === null, wpDe.reason);

// ── winsock catalog ─────────────────────────────────────────────────────────────────────

const cat = ps.parseWinsockCatalog(fx('winsock-catalog.en.txt'));
t('winsock catalog: parses', cat.ok, cat.reason);
t('winsock catalog: recognises many entries', cat.ok && cat.entryCount > 10, cat.ok && String(cat.entryCount));
t('winsock catalog: the Microsoft base providers are classified as Microsoft',
    cat.ok && cat.value.some(p => p.base === 'mswsock.dll' && p.microsoft));
t('winsock catalog: this machine has no third-party LSP',
    cat.ok && cat.thirdParty.length === 0,
    cat.ok && JSON.stringify(cat.thirdParty.map(p => p.path)));

const injected = fx('winsock-catalog.en.txt')
    + '\nProvider Path:                      C:\\Program Files\\SomeAV\\avlsp.dll\n';
const catAv = ps.parseWinsockCatalog(injected);
t('winsock catalog: a DLL outside system32 is flagged third-party (the LSP black-hole case)',
    catAv.ok && catAv.thirdParty.length === 1 && /avlsp\.dll$/i.test(catAv.thirdParty[0].path),
    JSON.stringify(catAv.thirdParty));
t('winsock catalog: classification keys on the PATH, so it survives a localised catalog',
    catAv.ok && catAv.value.every(p => typeof p.base === 'string'));
t('winsock catalog: unreadable output is unknown, not "no providers"',
    ps.parseWinsockCatalog('Access is denied.').ok === false);

// ── the runner contract ─────────────────────────────────────────────────────────────────
//
// No test here starts PowerShell; phase 1 is offline. What is asserted is the argument
// vector, because those flags are a security control, not a preference.

t('runner: -NoProfile is present (a profile script must not steer an elevated child)',
    ps.PS_ARGS.includes('-NoProfile'));
t('runner: -NonInteractive is present (never block a deadline on a prompt)',
    ps.PS_ARGS.includes('-NonInteractive'));
t('runner: the script goes over stdin ("-Command -"), so there is no temp file and no argv string',
    ps.PS_ARGS[ps.PS_ARGS.length - 2] === '-Command' && ps.PS_ARGS[ps.PS_ARGS.length - 1] === '-');
t('runner: the preamble forces UTF-8 output (OEM code page mangles adapter names)',
    /OutputEncoding.*UTF8/.test(ps.PS_PREAMBLE));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
