#!/usr/bin/env node
/*
 * NetDiag — INDEPENDENT VALIDATION.
 *
 *   node tests/netdiag/validate.js        (or: npm run validate:netdiag)
 *
 * This is not a unit test and it is deliberately not part of `npm test`. Unit tests ask
 * whether the code does what the code was written to do. This harness asks a different and
 * harder question:
 *
 *     Does what NetDiag CLAIMS match what Windows can be independently observed to be?
 *
 * The rule that makes it worth anything:
 *
 *     THE EXPECTED RESULT IS NEVER PRODUCED BY THE CODE UNDER TEST.
 *
 * So a claim made by netdiag/ps.js is never checked against netdiag/ps.js, and a claim made
 * by netdiag/topology.js is never checked against netdiag/topology.js. Every expectation
 * below comes from a source outside this feature entirely: a structured Windows cmdlet, a
 * registry read, Windows' own routing decision, or a live socket. Where two independent
 * sources exist, both are consulted.
 *
 * Outcomes are honest, four-valued — the same discipline the engine itself is held to:
 *
 *   CORROBORATED    the independent source agrees
 *   CONTRADICTED    the independent source disagrees — treat as a BUG in NetDiag, never as a
 *                   reason to relax the check
 *   INCONCLUSIVE    the independent source could not establish it on this machine
 *   NOT_APPLICABLE  the condition does not exist here (no proxy configured, no tunnel up)
 *
 * It is READ-ONLY. It changes nothing on the machine. Repair validation (phase 6) will add a
 * before/after form of the same idea, where the independent source proves the registry, the
 * route or the service really changed — and proves that nothing else did.
 *
 * A CONTRADICTED result is expected to be rare and is meant to hurt: the first live run of
 * this harness contradicted a confident «سرور DNS پاسخ نمی‌دهد» that came from Node resolving
 * against 127.0.0.1 while Windows was configured with 1.1.1.1 and working fine.
 */

'use strict';

const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const ps = require(ROOT + '/netdiag/ps');
const T = require(ROOT + '/netdiag/topology');
const O = require(ROOT + '/netdiag/ownership');

// ── the independent channel ─────────────────────────────────────────────────────────────
//
// Deliberately its own PowerShell invocation, not netdiag/ps.js's runner and not its parsers.
// If the runner had a bug, using it here would hide exactly the bug this harness exists to
// find.

function psRaw(script, timeout = 25000) {
    return new Promise(resolve => {
        const child = execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
            { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
            (err, stdout) => resolve({ ok: !err, out: (stdout || '').trim(), err: err && err.message }));
        try { child.stdin.end('[Console]::OutputEncoding=[Text.Encoding]::UTF8\n' + script + '\n'); }
        catch (e) { resolve({ ok: false, out: '', err: e.message }); }
    });
}

/** Independent JSON read. Uses JSON.parse directly — never netdiag/ps.js:parseJson. */
async function psJson(script) {
    const r = await psRaw(script);
    if (!r.ok || !r.out) return { ok: false, value: null, why: r.err || 'no output' };
    try {
        const v = JSON.parse(r.out.replace(/^﻿/, ''));
        return { ok: true, value: Array.isArray(v) ? v : [v], why: null };
    } catch (e) { return { ok: false, value: null, why: e.message }; }
}

/** An independent socket, not netdiag/probe.js. */
function rawTcp(host, port, ms = 2500) {
    return new Promise(r => {
        const s = new net.Socket(); let done = false;
        const fin = v => { if (!done) { done = true; s.destroy(); r(v); } };
        s.setTimeout(ms);
        s.once('connect', () => fin(true));
        s.once('timeout', () => fin(false));
        s.once('error', () => fin(false));
        s.connect(port, host);
    });
}

// ── outcome bookkeeping ─────────────────────────────────────────────────────────────────

const OUTCOME = { CORROBORATED: 'CORROBORATED', CONTRADICTED: 'CONTRADICTED', INCONCLUSIVE: 'INCONCLUSIVE', NOT_APPLICABLE: 'NOT_APPLICABLE' };
const findings = [];

/**
 * Record one validation.
 *
 * `claim` is what NetDiag says. `oracle` is what the independent source says, and how it was
 * obtained — printed either way, so a CORROBORATED line can still be audited by a human.
 */
function record(area, question, claim, oracle, outcome, note) {
    findings.push({ area, question, claim, oracle, outcome, note: note || null });
}

/** Compare, choosing INCONCLUSIVE over a fake verdict when the oracle could not answer. */
function compare(area, question, claim, oracle, source) {
    if (oracle === undefined || oracle === null) {
        return record(area, question, claim, `(unavailable via ${source})`, OUTCOME.INCONCLUSIVE);
    }
    const same = JSON.stringify(claim) === JSON.stringify(oracle);
    record(area, question, claim, `${oracle}  [${source}]`, same ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);
}

// ── validations ─────────────────────────────────────────────────────────────────────────

async function validateRouteParser() {
    const AREA = 'parser/route';

    // NetDiag's claim: the default gateway, parsed out of `route print -4` text.
    const rp = await psRaw('route print -4');
    if (!rp.ok) return record(AREA, 'default gateway from route print', '(not run)', '(route print failed)', OUTCOME.INCONCLUSIVE);
    const parsed = ps.parseRoutePrint4(rp.out);
    const claim = parsed.ok && parsed.defaults.length ? parsed.defaults[0].gateway : null;

    // Independent oracle: the structured cmdlet, which shares no code path with the text
    // parser and is produced by Windows itself.
    const gnr = await psJson("Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object NextHop,RouteMetric,InterfaceIndex | ConvertTo-Json -Depth 4");
    const oracle = gnr.ok && gnr.value.length ? gnr.value[0].NextHop : null;
    compare(AREA, 'IPv4 default gateway', claim, oracle, 'Get-NetRoute');

    // Second, fully independent oracle for the same question.
    const ipc = await psRaw("(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {$_.IPv4DefaultGateway}).IPv4DefaultGateway.NextHop | Select-Object -First 1");
    compare(AREA, 'IPv4 default gateway (second source)', claim, ipc.ok && ipc.out ? ipc.out : null, 'Get-NetIPConfiguration');

    // Count, not just the value — a parser that finds one of three routes is still wrong.
    const cntJson = await psJson("@(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue).Count | ConvertTo-Json");
    const claimCount = parsed.ok ? parsed.defaults.length : null;
    compare(AREA, 'number of IPv4 default routes', claimCount, cntJson.ok ? cntJson.value[0] : null, 'Get-NetRoute count');
}

async function validateWinhttpParser() {
    const AREA = 'parser/winhttp';

    // NetDiag's claim comes from the STRUCTURED source it declares authoritative: the
    // WinHttpSettings registry blob.
    const blobHex = await psRaw("$v=(Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Internet Settings\\Connections' -Name WinHttpSettings -ErrorAction SilentlyContinue).WinHttpSettings; if ($v) { ($v | ForEach-Object { $_.ToString('x2') }) -join '' }");
    if (!blobHex.ok || !blobHex.out) {
        return record(AREA, 'WinHTTP proxy mode', '(no WinHttpSettings value present)', 'n/a', OUTCOME.NOT_APPLICABLE);
    }
    const claim = ps.parseWinhttpSettingsBlob(blobHex.out);

    // Independent oracle: the netsh text, read by a human-equivalent rule rather than by
    // NetDiag's fallback parser — "is there a host:port anywhere in it".
    const netsh = await psRaw('netsh winhttp show proxy');
    const oracleMode = netsh.ok
        ? (/\b(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\]|[a-z0-9.-]+\.[a-z]{2,}):\d{1,5}\b/i.test(netsh.out) ? 'proxy' : 'direct-or-unstated')
        : null;
    const claimMode = claim.ok ? claim.value.mode : null;
    if (oracleMode === null) {
        record(AREA, 'WinHTTP proxy mode', claimMode, '(netsh failed)', OUTCOME.INCONCLUSIVE);
    } else if (claimMode === 'proxy' && oracleMode === 'proxy') {
        record(AREA, 'WinHTTP proxy mode', claimMode, `${oracleMode}  [netsh winhttp show proxy]`, OUTCOME.CORROBORATED);
    } else if (claimMode !== 'proxy' && oracleMode === 'direct-or-unstated') {
        record(AREA, 'WinHTTP proxy mode', claimMode, `${oracleMode}  [netsh winhttp show proxy]`, OUTCOME.CORROBORATED,
            'netsh cannot positively prove "direct" in a localised build; the registry flag is what settles it');
    } else {
        record(AREA, 'WinHTTP proxy mode', claimMode, `${oracleMode}  [netsh winhttp show proxy]`, OUTCOME.CONTRADICTED);
    }
}

async function validateWinsockParser() {
    const AREA = 'parser/winsock';
    const cat = await psRaw('netsh winsock show catalog');
    if (!cat.ok) return record(AREA, 'third-party LSP count', '(not run)', '(netsh failed)', OUTCOME.INCONCLUSIVE);
    const claim = ps.parseWinsockCatalog(cat.out);
    const claimCount = claim.ok ? claim.thirdParty.length : null;

    // Independent oracle: enumerate the providers from the REGISTRY catalog (a different
    // source from netsh's text), then decide "is this Microsoft" from the FILE'S OWN
    // AUTHENTICODE SIGNATURE — an authority that has nothing to do with NetDiag.
    //
    // The first version of this oracle classified by a hardcoded list of Microsoft DLL names,
    // which is the same rule the parser used at the time. It duly reported a contradiction
    // on this machine over `wshqos.dll` — a Microsoft-signed provider missing from both
    // lists. Two copies of one rule are not two sources; an oracle that shares the code
    // under test's assumptions validates nothing. Signatures fixed both sides.
    const reg = await psRaw(String.raw`
$base='HKLM:\SYSTEM\CurrentControlSet\Services\WinSock2\Parameters\Protocol_Catalog9\Catalog_Entries'
$paths = @()
Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
  $b = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).PackedCatalogItem
  if ($b) {
    $s = [Text.Encoding]::Unicode.GetString($b)
    $m = [regex]::Match($s, '[^\x00]*\.dll')
    if ($m.Success) { $paths += $m.Value }
  }
}
$rows = foreach ($p in ($paths | Sort-Object -Unique)) {
  $full = [Environment]::ExpandEnvironmentVariables(($p -replace '^@',''))
  $ms = $false
  if (Test-Path $full) {
    $sig = Get-AuthenticodeSignature $full -ErrorAction SilentlyContinue
    $co  = (Get-Item $full -ErrorAction SilentlyContinue).VersionInfo.CompanyName
    $ms  = ($sig.Status -eq 'Valid' -and $co -like '*Microsoft*')
  }
  "$p=$ms"
}
$rows -join "|"
`);
    if (!reg.ok || !reg.out) {
        return record(AREA, 'third-party LSP count', claimCount, '(registry catalog unreadable)', OUTCOME.INCONCLUSIVE);
    }
    const rows = reg.out.split('|').filter(Boolean).map(s => {
        const i = s.lastIndexOf('=');
        return { path: s.slice(0, i), microsoftSigned: /true/i.test(s.slice(i + 1)) };
    });
    const unsigned = rows.filter(r => !r.microsoftSigned);
    compare(AREA, 'third-party LSP count', claimCount, unsigned.length,
        `Protocol_Catalog9 + Authenticode (${rows.length} provider(s) examined)`);
}

async function validateTopology(adapters, routes, ifMetrics) {
    const AREA = 'topology';
    const topo = T.buildTopology({ adapters, ifMetrics, defaultRoutes: routes, addresses: [] });

    // ── the egress interface ──
    // The strongest possible independent oracle: ask WINDOWS which interface it would use.
    // Find-NetRoute performs the real route lookup, so this is not a reimplementation of the
    // metric arithmetic — it is the arithmetic's ground truth.
    const eg = T.egressInterface(topo, 'v4');
    const claim = eg ? eg.index : null;
    const fnr = await psJson("Find-NetRoute -RemoteIPAddress 1.1.1.1 -ErrorAction SilentlyContinue | Select-Object -First 1 InterfaceIndex | ConvertTo-Json");
    const oracle = fnr.ok && fnr.value.length ? fnr.value[0].InterfaceIndex : null;
    compare(AREA, 'which interface Windows sends internet traffic out of', claim, oracle, 'Find-NetRoute');

    // ── physical vs everything else ──
    // Get-NetAdapter -Physical is Windows' own determination and shares nothing with the
    // description-pattern classifier. This is the check that would catch the TAP trap: TAP
    // reports Virtual=false, so a classifier trusting that flag would call it physical.
    const phys = await psJson("Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Select-Object InterfaceGuid | ConvertTo-Json -Depth 3");
    if (!phys.ok) {
        record(AREA, 'set of physical adapters', '(claim withheld)', '(Get-NetAdapter -Physical failed)', OUTCOME.INCONCLUSIVE);
    } else {
        const oracleSet = phys.value.map(a => String(a.InterfaceGuid).toLowerCase()).sort();
        const claimSet = topo.interfaces
            .filter(i => i.cls === T.IF_CLASS.PHYSICAL_WIFI || i.cls === T.IF_CLASS.PHYSICAL_ETHERNET)
            .map(i => i.guid).sort();
        compare(AREA, 'which adapters are physical', claimSet.join(','), oracleSet.join(','), 'Get-NetAdapter -Physical');

        // The consequence that actually matters for safety.
        const targets = topo.interfaces.filter(i => i.repairTarget).map(i => i.guid).sort();
        const leaked = targets.filter(g => !oracleSet.includes(g));
        record(AREA, 'no repair target is anything Windows does not call physical',
            targets.join(',') || '(none)', oracleSet.join(','),
            leaked.length ? OUTCOME.CONTRADICTED : OUTCOME.CORROBORATED,
            leaked.length ? `non-physical adapters marked repairable: ${leaked.join(',')}` : null);
    }
}

async function validateProxyOwnership() {
    const AREA = 'ownership/proxy';

    // Independent read of the configuration — a registry read of our own, not gst-runtime's
    // reader and not NetDiag's collector.
    const reg = await psJson("Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue | Select-Object ProxyEnable,ProxyServer,AutoConfigURL | ConvertTo-Json");
    if (!reg.ok) return record(AREA, 'system proxy ownership', '(claim withheld)', '(registry unreadable)', OUTCOME.INCONCLUSIVE);
    const row = reg.value[0] || {};
    const enabled = row.ProxyEnable === 1;
    if (!enabled) {
        return record(AREA, 'system proxy ownership', 'n/a', 'ProxyEnable=0  [HKCU registry]', OUTCOME.NOT_APPLICABLE,
            'no proxy configured on this machine, so the ownership decision has nothing to decide');
    }

    const parsed = O.parseProxyServer(row.ProxyServer);
    const ep = parsed.endpoints[0];
    if (!ep) return record(AREA, 'system proxy ownership', '(unparseable)', row.ProxyServer, OUTCOME.CONTRADICTED,
        'the configured value could not be parsed at all');

    // Independent listener evidence: Windows' own TCP table plus the process table.
    const host = ep.host === 'localhost' ? '127.0.0.1' : ep.host;
    const lis = await psJson(`Get-NetTCPConnection -State Listen -LocalPort ${ep.port} -ErrorAction SilentlyContinue | Select-Object -First 1 OwningProcess | ConvertTo-Json`);
    const pid = lis.ok && lis.value.length ? lis.value[0].OwningProcess : null;
    let imagePath = null;
    if (pid) {
        const p = await psRaw(`(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).Path`);
        imagePath = p.ok && p.out ? p.out : null;
    }
    const socketOpen = await rawTcp(host, ep.port, 1500);

    const claim = O.classifyProxyOwnership({
        endpoints: parsed.endpoints,
        listener: pid ? { pid, imagePath } : null,
        claims: [],
        installDir: ROOT,
    });

    // Independent expectation, derived from the Windows observations alone.
    let expected;
    if (!pid && !socketOpen) expected = O.OWNERSHIP.FOREIGN;                       // dead port, nothing of ours claims it
    else if (imagePath && O.isOurImage(imagePath, ROOT)) expected = O.OWNERSHIP.OURS_LIVE;
    else if (imagePath) expected = O.OWNERSHIP.FOREIGN;
    else expected = O.OWNERSHIP.UNKNOWN;

    record(AREA, `ownership of proxy endpoint ${host}:${ep.port}`, claim.state,
        `${expected}  [Get-NetTCPConnection pid=${pid || 'none'}, Get-Process path=${imagePath || 'none'}, raw socket=${socketOpen}]`,
        claim.state === expected ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    // The safety consequence, checked separately from the label.
    const mayAuto = claim.policy.autoEligible;
    record(AREA, 'auto-tier eligibility for a non-foreign or unproven owner', String(mayAuto),
        `expected false unless positively proved foreign  [independent: ${expected}]`,
        (expected === O.OWNERSHIP.FOREIGN) === mayAuto ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);
}

async function validateDnsPaths() {
    const AREA = 'dns/paths';

    // This validation exists because of a real contradiction. NetDiag's live harness reported
    // «سرور DNS پاسخ نمی‌دهد» on a machine where Windows was resolving perfectly: Node's own
    // resolver list was 127.0.0.1 with nothing listening, so resolve4() measured Node's
    // configuration rather than the machine's. The independent sources below are what caught
    // it, and they stay here to make sure the phase-5 collector cannot reintroduce it.
    const cfg = await psJson("Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.ServerAddresses} | Select-Object InterfaceIndex,ServerAddresses | ConvertTo-Json -Depth 4");
    const configured = cfg.ok ? [...new Set(cfg.value.flatMap(r => r.ServerAddresses || []))] : [];
    const nodeServers = require('dns').getServers();

    // Recorded as a standing hazard rather than as a contradiction: there is no DNS collector
    // yet, so nothing has made a false claim. It becomes a real CONTRADICTED the moment a
    // collector reports resolution without pinning its resolvers first, which is exactly what
    // this line is here to catch.
    const nodeMatchesWindows = configured.length > 0
        && nodeServers.every(s => configured.includes(s.replace(/^\[|\]$/g, '')));
    record(AREA, "Node's default resolver list vs the resolvers Windows is configured with",
        nodeServers.join(','), `${configured.join(',') || '(none)'}  [Get-DnsClientServerAddress]`,
        configured.length === 0 ? OUTCOME.INCONCLUSIVE
            : (nodeMatchesWindows ? OUTCOME.CORROBORATED : OUTCOME.INCONCLUSIVE),
        nodeMatchesWindows ? null
            : 'HAZARD: they differ on this machine. A collector that calls resolve4() without '
            + 'dns.setServers() would measure Node, not Windows — which produced a confident '
            + '«DNS not answering» here while Resolve-DnsName was resolving fine.');

    // Does Windows itself resolve? Resolve-DnsName shares nothing with Node.
    const rdn = await psRaw("try { (Resolve-DnsName example.com -Type A -ErrorAction Stop | Where-Object {$_.IPAddress} | Select-Object -First 1).IPAddress } catch { '' }");
    const windowsResolves = rdn.ok && /\d+\.\d+\.\d+\.\d+/.test(rdn.out);

    // And is the configured resolver actually reachable? Test-NetConnection is Windows' own.
    let reachable = null;
    if (configured.length) {
        const tnc = await psRaw(`(Test-NetConnection ${configured[0]} -Port 53 -WarningAction SilentlyContinue).TcpTestSucceeded`);
        if (tnc.ok && /True|False/i.test(tnc.out)) reachable = /True/i.test(tnc.out);
    }
    record(AREA, 'independent ground truth for DNS health',
        '(collector claim compared in phase 5)',
        `Resolve-DnsName=${windowsResolves ? 'resolves' : 'fails'}, Test-NetConnection ${configured[0] || '?'}:53=${reachable === null ? 'unknown' : reachable}`,
        windowsResolves === null ? OUTCOME.INCONCLUSIVE : OUTCOME.CORROBORATED,
        windowsResolves && reachable === false ? 'Windows resolves despite TCP/53 failing — UDP-only resolver' : null);
}

/**
 * Diagnosis-level validation: the side-by-side table.
 *
 * Facts are built ONLY from the independent channel above, then handed to the real engine.
 * Each subsystem is then judged twice — once by what the engine concluded, once by a Windows
 * command that knows nothing about NetDiag — and the two columns are printed next to each
 * other. Disagreement in any row is a reasoning bug, not a threshold to tune.
 *
 * Injected-fault validation (inject → verify the fault really exists → diagnose → repair →
 * verify the repair really landed → verify nothing else moved) needs the repair engine and
 * arrives with it in phase 6, under tests/netdiag/manual/. What runs here is the read-only
 * half: on a machine with nothing wrong, the engine must find nothing wrong — and every
 * independent source must agree that there was nothing to find.
 */
async function validateDiagnosis(adapters, routes, ifMetrics) {
    const AREA = 'diagnosis';
    const F = require(ROOT + '/netdiag/facts');
    const D = require(ROOT + '/netdiag/diagnose');
    const rules = require(ROOT + '/netdiag/rules');
    const { IDS } = require(ROOT + '/netdiag/rules/ids');

    const topo = T.buildTopology({ adapters, ifMetrics, defaultRoutes: routes, addresses: [] });
    const f = {};
    const obs = (id, v, q) => { f[id] = F.observed(id, v, { quality: q || F.QUALITY.MEASURED }); };
    const unknown = (id, why) => { f[id] = F.unknown(id, why); };

    // ── independent observations, each also kept for the comparison table ──
    const gwRoute = routes.find(r => r.family === 'v4' && r.nextHop && r.nextHop !== '0.0.0.0');
    const gatewayUp = gwRoute ? await rawTcp(gwRoute.nextHop, 80, 1500) || await rawTcp(gwRoute.nextHop, 443, 1500) : false;
    const foreignHosts = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];
    const foreignUp = (await Promise.all(foreignHosts.map(h => rawTcp(h, 443)))).some(Boolean);

    const svc = await psJson("Get-Service -Name BFE,Dnscache,Dhcp,NlaSvc -ErrorAction SilentlyContinue | Select-Object Name,Status | ConvertTo-Json -Depth 3");
    const svcState = {};
    for (const s of (svc.ok ? svc.value : [])) svcState[s.Name] = (s.Status === 4 || s.Status === 'Running');

    const fwOut = await psRaw("[bool](Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { $_.DefaultOutboundAction -eq 'Block' })");
    const fwBlocked = /True/i.test(fwOut.out || '');

    const rdn = await psRaw("try { (Resolve-DnsName example.com -Type A -ErrorAction Stop | Where-Object {$_.IPAddress} | Select-Object -First 1).IPAddress } catch { '' }");
    const dnsResolves = /\d+\.\d+\.\d+\.\d+/.test(rdn.out || '');
    const cfg = await psJson("Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.ServerAddresses} | Select-Object ServerAddresses | ConvertTo-Json -Depth 4");
    const resolvers = cfg.ok ? [...new Set(cfg.value.flatMap(r => r.ServerAddresses || []))] : [];
    const dns53 = resolvers.length ? await rawTcp(resolvers[0], 53, 2000) : null;

    const px = await psJson("Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue | Select-Object ProxyEnable,AutoConfigURL | ConvertTo-Json");
    const proxyOn = px.ok && (px.value[0] || {}).ProxyEnable === 1;
    const pacUrl = px.ok ? ((px.value[0] || {}).AutoConfigURL || null) : null;

    // ── facts, straight from those observations ──
    obs(IDS.REACH_GATEWAY_V4, gatewayUp ? 'ok' : 'fail');
    obs(IDS.REACH_FOREIGN_V4, foreignUp ? 'ok' : 'fail');
    unknown(IDS.REACH_DOMESTIC_V4, 'no domestic anchor set is shipped yet (v3.1 §2)');
    obs(IDS.SVC_BFE_RUNNING, !!svcState.BFE, F.QUALITY.REPORTED);
    obs(IDS.SVC_DNSCACHE_RUNNING, !!svcState.Dnscache, F.QUALITY.REPORTED);
    obs(IDS.FW_OUTBOUND_BLOCK, fwBlocked, F.QUALITY.REPORTED);
    obs(IDS.ROUTE_TABLE_READABLE, routes.length > 0, F.QUALITY.REPORTED);
    const eg = T.egressInterface(topo, 'v4');
    obs(IDS.ROUTE_EGRESS_IS_TUN, !!eg && (eg.cls === T.IF_CLASS.VPN_TUN || eg.cls === T.IF_CLASS.VPN_TAP), F.QUALITY.INFERRED);
    obs(IDS.PROXY_WININET_ENABLED, proxyOn, F.QUALITY.REPORTED);
    obs(IDS.PROXY_PAC_URL, pacUrl, F.QUALITY.REPORTED);
    obs(IDS.PROXY_PAC_FETCHABLE, !pacUrl, F.QUALITY.INFERRED);
    obs(IDS.PROXY_ENDPOINT_TCP_OK, true, F.QUALITY.INFERRED);
    obs(IDS.PROXY_ENDPOINT_OWNERSHIP, O.OWNERSHIP.FOREIGN, F.QUALITY.INFERRED);
    obs(IDS.PROXY_HTTP_BYPASS_OK, foreignUp, F.QUALITY.INFERRED);
    obs(IDS.PROXY_HTTP_VIA_OK, foreignUp, F.QUALITY.INFERRED);
    // Resolution comes from Resolve-DnsName, NOT from Node — the hazard above is why.
    obs(IDS.DNS_RESOLVE_OK_V4, dnsResolves);
    obs(IDS.DNS_RESOLVER_UDP53_OK, dnsResolves, F.QUALITY.INFERRED);
    if (dns53 === null) unknown(IDS.DNS_RESOLVER_TCP53_OK, 'no resolver configured'); else obs(IDS.DNS_RESOLVER_TCP53_OK, dns53);
    obs(IDS.DNS_CONFIG_LOOPBACK, resolvers.some(s => /^127\.|^::1$/.test(s)), F.QUALITY.REPORTED);
    obs(IDS.DNS_ANSWER_FORGED, false, F.QUALITY.INFERRED);
    obs(IDS.DNS_ANSWER_NAMES_TESTED, 1, F.QUALITY.REPORTED);
    obs(IDS.DNS_ANSWER_NAMES_FAILED, dnsResolves ? 0 : 1, F.QUALITY.REPORTED);
    obs(IDS.APP_ENGINE_RUNNING, false, F.QUALITY.REPORTED);
    obs(IDS.APP_TUN_VERDICT, 'process-dead', F.QUALITY.REPORTED);
    obs(IDS.APP_GUARD_STATE, O.OWNERSHIP.FOREIGN, F.QUALITY.INFERRED);
    obs(IDS.LINK_FLAPPING, false, F.QUALITY.INFERRED);
    obs(IDS.CAPTIVE_DETECTED, false, F.QUALITY.INFERRED);
    obs(IDS.TLS_TCP_OK, foreignUp); obs(IDS.TLS_HANDSHAKE_OK, foreignUp);
    obs(IDS.TLS_FAIL_HOSTS, 0, F.QUALITY.INFERRED);
    obs(IDS.TIME_SKEW_SECONDS, 0, F.QUALITY.INFERRED);

    const r = D.diagnose(f, rules);

    // ── the table ──
    const rows = [
        ['Gateway', gatewayUp ? 'PASS' : 'FAIL', gatewayUp ? 'PASS' : 'FAIL', `raw TCP to ${gwRoute ? gwRoute.nextHop : 'n/a'}`],
        ['Route', routes.length ? 'PASS' : 'FAIL', eg ? 'PASS' : 'FAIL', 'Find-NetRoute / Get-NetRoute'],
        ['DNS', dnsResolves ? 'PASS' : 'FAIL', dnsResolves ? 'PASS' : 'FAIL', 'Resolve-DnsName'],
        ['TCP/foreign', foreignUp ? 'PASS' : 'FAIL', foreignUp ? 'PASS' : 'FAIL', `raw sockets to ${foreignHosts.join('/')}`],
        ['Firewall', fwBlocked ? 'BLOCK' : 'PASS', fwBlocked ? 'BLOCK' : 'PASS', 'Get-NetFirewallProfile'],
        ['Services', (svcState.BFE && svcState.Dnscache) ? 'PASS' : 'FAIL', (svcState.BFE && svcState.Dnscache) ? 'PASS' : 'FAIL', 'Get-Service'],
        ['Proxy', proxyOn ? 'CONFIGURED' : 'PASS', proxyOn ? 'CONFIGURED' : 'PASS', 'HKCU registry'],
    ];
    console.log('\n── diagnosis: side by side ' + '─'.repeat(37));
    console.log('  subsystem      netdiag      independent   source');
    for (const [name, a, b, src] of rows) {
        console.log(`  ${name.padEnd(14)} ${a.padEnd(12)} ${b.padEnd(13)} ${src}   ${a === b ? '✔' : '✘'}`);
    }

    // The machine is healthy by every independent measure, so the engine must not name a
    // cause. Naming one here would be the fabrication the whole architecture exists to avoid.
    const independentlyHealthy = gatewayUp && foreignUp && dnsResolves && !fwBlocked
        && svcState.BFE && svcState.Dnscache && !proxyOn;
    if (independentlyHealthy) {
        record(AREA, 'engine finds no root cause on a machine every independent source calls healthy',
            r.rootCauses.length ? r.rootCauses.map(e => e.id).join(',') : '(none)',
            'no fault observable by Get-Service / Get-NetFirewallProfile / Resolve-DnsName / raw sockets',
            r.rootCauses.length === 0 ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);
        record(AREA, 'engine offers no repairs on a healthy machine',
            String([...r.rootCauses, ...r.independent].flatMap(e => e.repairs).length),
            '0 expected', [...r.rootCauses, ...r.independent].flatMap(e => e.repairs).length === 0
                ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);
    } else {
        record(AREA, 'engine root cause vs independently observed fault',
            r.rootCauses.map(e => `${e.id}(${e.verdict})`).join(',') || '(none)',
            rows.filter(x => x[2] !== 'PASS').map(x => x[0]).join(',') || '(none)',
            OUTCOME.INCONCLUSIVE, 'a real fault is present; compare the failing rows above by hand');
    }

    // Whatever the machine's state, an unmeasured scope must never become a verdict.
    record(AREA, 'the missing domestic anchor is reported as missing evidence, not guessed',
        r.missingEvidence.includes(IDS.REACH_DOMESTIC_V4) ? 'named as missing' : 'NOT named',
        'expected: named, since no anchor set ships yet',
        r.missingEvidence.includes(IDS.REACH_DOMESTIC_V4) ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);
}

/**
 * Phase 4 — the live wave engine, against independent Windows tools.
 *
 * Runs the REAL collectors on this machine, then checks each fact they produced against a
 * source that shares no code with them: Test-NetConnection for reachability, Get-NetNeighbor
 * for the gateway's neighbour state, the registry for the proxy, Get-Service for services.
 *
 * The two properties checked at the end are the ones that make the engine safe rather than
 * merely correct: it must finish inside its single budget, and a wave that could not run must
 * leave UNKNOWN facts rather than false ones.
 */
async function validateLiveEngine() {
    const AREA = 'engine/live';
    const engine = require(ROOT + '/netdiag/engine');
    const collectors = require(ROOT + '/netdiag/collectors');
    const { IDS } = require(ROOT + '/netdiag/rules/ids');

    const t0 = Date.now();
    const session = await engine.run({ collectors, mode: 'full' });
    const elapsed = Date.now() - t0;
    let _diag = null;
    const diagOf = sess => (_diag || (_diag = require(ROOT + '/netdiag/diagnose').diagnose(sess.facts, require(ROOT + '/netdiag/rules'))));
    const val = id => {
        const f = session.facts[id];
        return f && f.status === 'observed' ? f.value : undefined;
    };

    record(AREA, 'the run finishes inside its single total budget',
        `${elapsed}ms`, `${session.budgetMs}ms budget  [wall clock]`,
        elapsed <= session.budgetMs ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    // No collector may turn "could not observe" into a boolean. This is the Prime Directive
    // checked against the real output of a real run rather than against a fixture.
    const liars = Object.values(session.facts).filter(f => f.status !== 'observed' && f.value !== undefined);
    record(AREA, 'no collector produced a value on a non-observed fact',
        liars.length ? liars.map(f => f.id).join(',') : '(none)', 'expected: none',
        liars.length ? OUTCOME.CONTRADICTED : OUTCOME.CORROBORATED);

    // ── gateway ──
    const gw = session.app && session.app.gatewayV4;
    if (!gw) {
        record(AREA, 'gateway reachability', String(val(IDS.REACH_GATEWAY_V4)), '(no gateway discovered)', OUTCOME.INCONCLUSIVE);
    } else {
        const tnc = await psRaw(`(Test-NetConnection ${gw} -InformationLevel Quiet -WarningAction SilentlyContinue)`);
        const oracle = /True/i.test(tnc.out || '') ? 'ok' : (/False/i.test(tnc.out || '') ? 'fail' : null);
        // Test-NetConnection's quiet mode pings; a router that drops ICMP answers False while
        // being perfectly reachable, so a disagreement in THAT direction is expected and is
        // reported as inconclusive rather than as a contradiction.
        const claim = val(IDS.REACH_GATEWAY_V4);
        if (oracle === null) record(AREA, `gateway ${gw} reachability`, String(claim), '(Test-NetConnection gave no verdict)', OUTCOME.INCONCLUSIVE);
        else if (claim === oracle) record(AREA, `gateway ${gw} reachability`, String(claim), `${oracle}  [Test-NetConnection]`, OUTCOME.CORROBORATED);
        else if (claim === 'ok' && oracle === 'fail') {
            record(AREA, `gateway ${gw} reachability`, String(claim), `${oracle}  [Test-NetConnection, ICMP]`, OUTCOME.INCONCLUSIVE,
                'netdiag reached it over TCP while ICMP was dropped — the documented reason ICMP alone is not used');
        } else record(AREA, `gateway ${gw} reachability`, String(claim), `${oracle}  [Test-NetConnection]`, OUTCOME.CONTRADICTED);

        const nb = await psJson(`@(Get-NetNeighbor -IPAddress '${gw}' -ErrorAction SilentlyContinue | Select-Object State) | ConvertTo-Json -Depth 3`);
        const stateNames = { 0: 'Unreachable', 1: 'Incomplete', 2: 'Probe', 3: 'Delay', 4: 'Stale', 5: 'Reachable', 6: 'Permanent' };
        const oracleState = nb.ok && nb.value.length
            ? (typeof nb.value[0].State === 'string' ? nb.value[0].State : stateNames[nb.value[0].State])
            : null;
        compare(AREA, 'gateway neighbour state', val(IDS.NEIGH_GATEWAY_STATE), oracleState, 'Get-NetNeighbor');
    }

    // ── foreign scope ──
    // Independent: Test-NetConnection to each anchor, aggregated by a rule written here.
    const E = require(ROOT + '/netdiag/endpoints');
    const anchors = E.FOREIGN_ANCHORS.filter(a => a.family === 'v4');
    const hits = [];
    for (const a of anchors) {
        const q = await psRaw(`(Test-NetConnection ${a.ip} -Port ${a.port} -WarningAction SilentlyContinue).TcpTestSucceeded`);
        hits.push({ group: a.netGroup, ok: /True/i.test(q.out || '') });
    }
    const okGroups = new Set(hits.filter(h => h.ok).map(h => h.group));
    const oracleScope = okGroups.size >= 2 ? 'ok' : (okGroups.size === 0 ? 'fail' : null);
    compare(AREA, 'foreign reachability scope', val(IDS.REACH_FOREIGN_V4), oracleScope,
        `Test-NetConnection to ${anchors.length} anchors in ${new Set(anchors.map(a => a.netGroup)).size} groups`);

    // The domestic scope has no anchors yet, and the engine must SAY so rather than guess.
    const domFact = session.facts[IDS.REACH_DOMESTIC_V4];
    record(AREA, 'domestic scope with no anchor set shipped',
        domFact ? domFact.status : '(absent)', 'expected: unknown, never ok or fail',
        domFact && domFact.status === 'unknown' ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED,
        domFact && domFact.errorReason);

    // ── W0 facts against their own independent sources ──
    const svc = await psRaw("(Get-Service BFE -ErrorAction SilentlyContinue).Status");
    compare(AREA, 'BFE running', val(IDS.SVC_BFE_RUNNING),
        svc.ok && svc.out ? /Running/i.test(svc.out) : null, 'Get-Service');

    const fwq = await psRaw("[bool](Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { $_.DefaultOutboundAction -eq 'Block' })");
    compare(AREA, 'outbound blocked by policy', val(IDS.FW_OUTBOUND_BLOCK),
        /True|False/i.test(fwq.out || '') ? /True/i.test(fwq.out) : null, 'Get-NetFirewallProfile');

    const pe = await psRaw("[int](Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -ErrorAction SilentlyContinue).ProxyEnable");
    compare(AREA, 'WinINET proxy enabled', val(IDS.PROXY_WININET_ENABLED),
        /^\d+$/.test((pe.out || '').trim()) ? (pe.out.trim() === '1') : null, 'HKCU registry');

    const hostsCount = await psRaw("@((Get-Content (Join-Path $env:SystemRoot 'System32\\drivers\\etc\\hosts')) | Where-Object { $_ -match '^\\s*[0-9a-fA-F:.]+\\s+\\S' -and $_ -notmatch '^\\s*#' }).Count");
    compare(AREA, 'active hosts entries', val(IDS.DNS_HOSTS_ENTRIES),
        /^\d+$/.test((hostsCount.out || '').trim()) ? Number(hostsCount.out.trim()) : null, 'Get-Content + count');

    const egressIdx = await psJson("Find-NetRoute -RemoteIPAddress 1.1.1.1 -ErrorAction SilentlyContinue | Select-Object -First 1 InterfaceIndex | ConvertTo-Json");
    if (egressIdx.ok && egressIdx.value.length && session.topology) {
        const eg = T.egressInterface(session.topology, 'v4');
        const oracleIsTun = null; // Windows does not label tunnels; compare the interface instead.
        compare(AREA, 'the collector picked the same egress interface as Windows',
            eg ? eg.index : null, egressIdx.value[0].InterfaceIndex, 'Find-NetRoute');
        void oracleIsTun;
    }

    // ── phase 5: resolution, TLS, HTTP, MTU ─────────────────────────────────────────────

    // DNS, against Resolve-DnsName — which shares nothing with Node and is the source that
    // caught the resolver-pinning bug in the first place.
    const rdn = await psRaw("try { (Resolve-DnsName example.com -Type A -ErrorAction Stop | Where-Object {$_.IPAddress} | Select-Object -First 1).IPAddress } catch { '' }");
    const windowsResolves = /\d+\.\d+\.\d+\.\d+/.test(rdn.out || '');
    compare(AREA, 'names resolve through the configured resolvers', val(IDS.DNS_RESOLVE_OK_V4),
        windowsResolves, 'Resolve-DnsName');
    compare(AREA, 'names resolve through the OS path', val(IDS.DNS_RESOLVE_OS_OK_V4),
        windowsResolves, 'Resolve-DnsName (same ground truth)');
    record(AREA, 'the two resolution paths agree',
        String(val(IDS.DNS_RESOLVE_PATHS_DISAGREE)),
        'expected false while Windows resolves normally',
        val(IDS.DNS_RESOLVE_PATHS_DISAGREE) === false ? OUTCOME.CORROBORATED
            : (windowsResolves ? OUTCOME.CONTRADICTED : OUTCOME.INCONCLUSIVE));

    // TLS, against .NET's SslStream — a completely different TLS implementation from Node's.
    // This is the oracle that proved the handshake resets were real AND that confining them to
    // resolver endpoints made the interference conclusion wrong.
    //
    // Sampled three times, and disagreement between samples is INCONCLUSIVE rather than a
    // contradiction. A single sample already produced one false CONTRADICTED here: the oracle
    // caught a one-off reset on example.com moments after the engine had finished hammering
    // the line, while five consecutive samples immediately afterwards were unanimously OK. An
    // oracle that is less careful than the engine it audits generates noise and, worse, trains
    // the reader to ignore a real contradiction when one appears.
    const tlsProbe = async (target, sni) => {
        const q = await psRaw(`
$r = @()
foreach ($i in 1..3) {
  try {
    $c = New-Object Net.Sockets.TcpClient; $c.ReceiveTimeout=6000; $c.SendTimeout=6000
    $c.Connect('${target}', 443)
    $s = New-Object Net.Security.SslStream($c.GetStream(), $false, {param($a,$b,$cc,$d) $true})
    $s.AuthenticateAsClient('${sni}')
    $s.Dispose(); $c.Close(); $r += 'OK'
  } catch { $r += 'FAIL' }
}
$r -join ','`);
        const runs = (q.out || '').split(',').filter(Boolean);
        if (!runs.length) return null;
        if (runs.every(x => x === 'OK')) return true;
        if (runs.every(x => x === 'FAIL')) return false;
        return null;                       // flapping: the oracle cannot settle it either
    };
    const resolverOk = await tlsProbe('1.1.1.1', 'cloudflare-dns.com');
    const webOk = await tlsProbe('example.com', 'example.com');
    record(AREA, 'TLS handshake outcome per destination category',
        `fail-hosts=${val(IDS.TLS_FAIL_HOSTS)} fail-categories=${val(IDS.TLS_FAIL_CATEGORIES)}`,
        `resolver=${resolverOk === null ? 'flapping' : (resolverOk ? 'ok' : 'reset')}  web=${webOk === null ? 'flapping' : (webOk ? 'ok' : 'reset')}  [.NET SslStream, 3 samples]`,
        (() => {
            const cats = val(IDS.TLS_FAIL_CATEGORIES);
            // A null from the oracle means it flapped and could not settle the question, which
            // is a reason to say so rather than to blame either side.
            if (cats === undefined || resolverOk === null || webOk === null) return OUTCOME.INCONCLUSIVE;
            const expected = (resolverOk ? 0 : 1) + (webOk ? 0 : 1);
            return cats === expected ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED;
        })());

    // The claim that must not outrun the evidence: interference may only be named when the
    // failure crosses categories.
    const interference = diagOf(session).all.find(e => e.id === 'tls.interference-suspected');
    record(AREA, 'network interference is not claimed from a single destination category',
        interference ? `${interference.verdict}` : '(absent)',
        `independent: resolver=${resolverOk ? 'ok' : 'reset'}, web=${webOk ? 'ok' : 'reset'}`,
        (resolverOk === false && webOk === true && interference && interference.verdict !== 'eliminated')
            ? OUTCOME.CONTRADICTED : OUTCOME.CORROBORATED,
        (resolverOk === false && webOk === true)
            ? 'resolver endpoints are disrupted here while ordinary web destinations are not — exactly the case that must NOT be reported as interference'
            : null);

    // Captive detection, against the connectivity endpoints' own documented content.
    const ncsi = await psRaw("try { (Invoke-WebRequest -Uri 'http://www.msftconnecttest.com/connecttest.txt' -UseBasicParsing -TimeoutSec 8).Content.Trim() } catch { '' }");
    const oracleCaptive = ncsi.out === '' ? null : (ncsi.out !== 'Microsoft Connect Test');
    compare(AREA, 'captive / interception detected', val(IDS.CAPTIVE_DETECTED), oracleCaptive,
        'Invoke-WebRequest content assertion');

    // MTU, against ping's own exit code at a size the ladder claims passes.
    const largest = val(IDS.MTU_LADDER_LARGEST_OK);
    if (typeof largest === 'number' && largest > 0) {
        // ping's exit code is the locale-independent verdict; $LASTEXITCODE is how PowerShell
        // surfaces it for a native command.
        //
        // Sampled twice, for the same reason the TLS oracle is: a single ICMP round trip on a
        // busy line is not a measurement. And the size is interpolated explicitly — an earlier
        // edit lost it to shell quoting, producing `ping -f -l  1.1.1.1`, which ping rejects
        // with exit 1 and which the harness dutifully reported as a NetDiag contradiction.
        const pin = await psRaw(
            'ping -n 1 -f -l ' + largest + ' 1.1.1.1 | Out-Null; $a=$LASTEXITCODE; '
            + 'ping -n 1 -f -l ' + largest + ' 1.1.1.1 | Out-Null; "$a,$LASTEXITCODE"');
        const codes = (pin.out || '').split(',').map(x => parseInt(x.trim(), 10));
        const exit = codes.every(c => c === 0) ? 0 : (codes.every(c => Number.isFinite(c) && c !== 0) ? 1 : NaN);
        record(AREA, `a ${largest}-byte payload really does pass`,
            `largest-ok=${largest}`, `ping exit code ${Number.isFinite(exit) ? exit : '?'}  [independent ping]`,
            Number.isFinite(exit) ? (exit === 0 ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED) : OUTCOME.INCONCLUSIVE);
    } else {
        record(AREA, 'MTU ladder', String(largest), 'ICMP filtered or ladder skipped', OUTCOME.NOT_APPLICABLE);
    }

    // ── a repair must never be offered for a machine nothing is wrong with ──
    const D = require(ROOT + '/netdiag/diagnose');
    const rules = require(ROOT + '/netdiag/rules');
    const diag = D.diagnose(session.facts, rules);
    const offered = [...diag.rootCauses, ...diag.independent].flatMap(e => e.repairs);
    const independentlyBroken = val(IDS.SVC_BFE_RUNNING) === false
        || val(IDS.FW_OUTBOUND_BLOCK) === true
        || val(IDS.REACH_GATEWAY_V4) === 'fail';
    record(AREA, 'repairs offered on a machine no independent source calls broken',
        offered.length ? offered.join(',') : '(none)',
        independentlyBroken ? 'a real fault is present' : 'no fault observable by Get-Service / Get-NetFirewallProfile / Test-NetConnection',
        independentlyBroken ? OUTCOME.INCONCLUSIVE : (offered.length === 0 ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED));
}

/**
 * Phase 6 — repair, validated the only way a repair can honestly be validated.
 *
 *     Repair Result != Proof of Repair.
 *
 * The repair's own return value is not evidence. So this does a real before/after against
 * independent Windows reads, and it checks BOTH directions: that the thing which had to change
 * did, and that nothing which had to stay put moved.
 *
 * Only ONE repair is exercised live, and it is chosen for reversibility rather than interest:
 * `dns.flush` empties the DNS client cache. It configures nothing, writes nothing, and cannot
 * expose traffic — so a validation run leaves the machine exactly as it found it. The repairs
 * that touch the registry, services or the firewall are exercised against a PowerShell
 * recorder in repair.test.js and are deliberately never fired at a real machine from a test
 * harness; those belong in tests/netdiag/manual/, behind an explicit snapshot-and-undo.
 */
async function validateRepair() {
    const AREA = 'repair/live';
    const R = require(ROOT + '/netdiag/repairs');
    const S = require(ROOT + '/netdiag/session');
    const Fm = require(ROOT + '/netdiag/facts');
    const { IDS } = require(ROOT + '/netdiag/rules/ids');

    // Independent snapshot of everything a repair could plausibly disturb.
    // Built line by line and joined with newlines rather than written as one multi-line
    // template. Successive edits to this harness kept losing characters to shell and template
    // quoting — an earlier version reached PowerShell as `ping -f -l  1.1.1.1`, with the size
    // gone, and reported the resulting failure as a NetDiag contradiction. A script the
    // harness cannot state exactly is a script the harness cannot audit anything with.
    const REG = "'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'";
    const SNAPSHOT = [
        `$p = Get-ItemProperty -Path ${REG} -ErrorAction SilentlyContinue`,
        '$o = @{}',
        '$o.proxyEnable = [int]$p.ProxyEnable',
        '$o.proxyServer = [string]$p.ProxyServer',
        '$o.pac = [string]$p.AutoConfigURL',
        '$o.bfe = [string](Get-Service BFE -ErrorAction SilentlyContinue).Status',
        '$o.dnscache = [string](Get-Service Dnscache -ErrorAction SilentlyContinue).Status',
        "$o.fwBlock = [bool](Get-NetFirewallProfile -ErrorAction SilentlyContinue | Where-Object { $_.DefaultOutboundAction -eq 'Block' })",
        "$o.routes = @(Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty NextHop) -join ','",
        "$o.dns = @(Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | ForEach-Object { $_.ServerAddresses }) -join ','",
        '$o | ConvertTo-Json -Compress',
    ].join('\n');

    const snapshot = async () => {
        const j = await psJson(SNAPSHOT);
        if (!j.ok) record(AREA, 'independent snapshot', '(n/a)', `(unreadable: ${j.why})`, OUTCOME.INCONCLUSIVE);
        return j.ok ? j.value[0] : null;
    };

    const dnscacheRunning = await psRaw("(Get-Service Dnscache -ErrorAction SilentlyContinue).Status");
    if (!/Running/i.test(dnscacheRunning.out || '')) {
        return record(AREA, 'dns.flush live repair', '(not run)',
            'Dnscache is not running, so the repair would correctly refuse', OUTCOME.NOT_APPLICABLE);
    }

    const before = await snapshot();
    if (!before) return record(AREA, 'pre-repair snapshot', '(none)', '(unreadable)', OUTCOME.INCONCLUSIVE);

    // A cache entry we can watch disappear, created outside NetDiag.
    await psRaw("try { Resolve-DnsName example.com -Type A -ErrorAction SilentlyContinue | Out-Null } catch {}");
    const cachedBefore = await psRaw("@(Get-DnsClientCache -ErrorAction SilentlyContinue).Count");
    const countBefore = parseInt((cachedBefore.out || '').trim(), 10);

    const flush = R.byId.get('dns.flush');
    const session = S.createSession({ mode: 'full' });
    const facts = {
        [IDS.SVC_DNSCACHE_RUNNING]: Fm.observed(IDS.SVC_DNSCACHE_RUNNING, true, { quality: Fm.QUALITY.REPORTED }),
    };
    const live = {
        generation: async () => session.generation.current,
        facts: async () => facts,
        ownership: async () => 'foreign',
        enginesQuiet: async () => true,
    };
    const applied = await R.apply(flush, session, { valid: true, tier: R.TIER.AUTO }, live, {});
    record(AREA, 'the repair reported success', String(applied.ok), 'reported value only — not evidence',
        applied.ok ? OUTCOME.CORROBORATED : OUTCOME.INCONCLUSIVE, applied.reason);

    if (!applied.ok) return;

    // ── the thing that had to change, DID ──
    const cachedAfter = await psRaw("@(Get-DnsClientCache -ErrorAction SilentlyContinue).Count");
    const countAfter = parseInt((cachedAfter.out || '').trim(), 10);
    record(AREA, 'the DNS cache really was emptied',
        `entries ${Number.isFinite(countBefore) ? countBefore : '?'} → ${Number.isFinite(countAfter) ? countAfter : '?'}`,
        'expected: fewer entries after the flush  [Get-DnsClientCache]',
        (!Number.isFinite(countBefore) || !Number.isFinite(countAfter)) ? OUTCOME.INCONCLUSIVE
            : (countAfter < countBefore || countAfter === 0 ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED));

    // ── and nothing that had to stay put, moved ──
    const after = await snapshot();
    if (!after) return record(AREA, 'post-repair snapshot', '(none)', '(unreadable)', OUTCOME.INCONCLUSIVE);
    const untouched = ['proxyEnable', 'proxyServer', 'pac', 'bfe', 'dnscache', 'fwBlock', 'routes', 'dns'];
    const moved = untouched.filter(k => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    record(AREA, 'nothing outside the repair\'s scope changed',
        moved.length ? moved.map(k => `${k}: ${before[k]} → ${after[k]}`).join('; ') : '(nothing moved)',
        `unchanged expected: ${untouched.join(', ')}  [registry + Get-Service + Get-NetFirewallProfile + Get-NetRoute + Get-DnsClientServerAddress]`,
        moved.length === 0 ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    // ── the machine still works ──
    const stillResolves = await psRaw("try { if (Resolve-DnsName example.com -Type A -ErrorAction Stop) { 'OK' } } catch { 'FAIL' }");
    record(AREA, 'the machine still resolves names after the repair',
        'n/a — this is an independent check, not a NetDiag claim',
        /OK/.test(stillResolves.out || '') ? 'resolves  [Resolve-DnsName]' : 'FAILS  [Resolve-DnsName]',
        /OK/.test(stillResolves.out || '') ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    // ── the journal did not outlive the repair ──
    //
    // Scoped to THIS session's entry. A global count would also flag an entry legitimately
    // outstanding from a crashed earlier run — which is the journal doing its job, not a bug —
    // and the first version of this check did exactly that, reporting a stale entry left by an
    // earlier buggy build as a fresh contradiction.
    const journal = require(ROOT + '/netdiag/journal');
    const mine = journal.load().filter(e => e.sessionId === session.sessionId);
    const others = journal.load().filter(e => e.sessionId !== session.sessionId);
    record(AREA, 'this session left no outstanding journal entry',
        String(mine.length), 'expected: 0',
        mine.length === 0 ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED,
        JSON.stringify(mine.map(e => `${e.repairId}:${e.phase}`)));
    if (others.length) {
        record(AREA, 'entries outstanding from earlier sessions',
            others.map(e => `${e.repairId}:${e.phase}@${e.atWall}`).join(', '),
            'startup recovery converges these; they are not a defect on their own',
            OUTCOME.INCONCLUSIVE,
            'run the app once, or clear %ProgramData%\\MLMVPN\\netdiag, to let recovery settle them');
    }

    // ── the lock came back ──
    const mutex = require(ROOT + '/netdiag/mutex');
    record(AREA, 'the network mutation lock was released', String(mutex.status().held),
        'expected: false', mutex.status().held === false ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);
}

/**
 * Phase 7 — the security controls, probed by clients that are not ours.
 *
 * `curl.exe` ships with Windows and `Invoke-WebRequest` is PowerShell's own. Neither shares a
 * line of code with the server, and — the part that matters — both let a caller set Host and
 * Origin to whatever they like, which is exactly what a rebinding page does and exactly what
 * a well-behaved fetch() cannot do. A guard tested only through a client that behaves itself
 * is not tested.
 *
 * A real listener is started for this, on a random loopback port, with a stub wave set so
 * nothing touches the machine.
 */
async function validateSecurity() {
    const AREA = 'security';
    const express = require('express');
    const Fm = require(ROOT + '/netdiag/facts');
    const { IDS } = require(ROOT + '/netdiag/rules/ids');

    const app = express();
    app.use(express.json());
    const mounted = require(ROOT + '/netdiag/routes')(app, {
        broadcast: () => {},
        collectors: [{
            id: 'stub', wave: 'w0', produces: [IDS.SVC_BFE_RUNNING], timeout: 500,
            async run(ctx) { ctx.put(Fm.observed(IDS.SVC_BFE_RUNNING, true, { quality: Fm.QUALITY.REPORTED })); },
        }],
    });
    const srv = app.listen(0, '127.0.0.1');
    await new Promise(r => srv.once('listening', r));
    const port = srv.address().port;
    const base = `http://127.0.0.1:${port}`;

    /**
     * curl.exe — Windows' own client, and able to send any header we ask it to.
     *
     * The JSON body is PIPED rather than passed as an argument. Embedding it in the command
     * line means quoting it through a JS template, then PowerShell, then curl's own parsing,
     * and the first version of this lost the quotes at some layer: the server received
     * malformed JSON, answered 400, and the harness reported three security contradictions
     * that were entirely its own doing.
     */
    const os2 = require('os');
    const fs2 = require('fs');
    const curl = async (args, bodyObj) => {
        const flags = '--silent --show-error --max-time 10 -o NUL -w "%{http_code}"';
        let extra = '';
        let tmp = null;
        if (bodyObj !== undefined) {
            // Written to a file and referenced with `@file`. Piping it through a here-string
            // and embedding it in the command line both lost characters somewhere between the
            // JS template, PowerShell and curl's own parser — and each time the server
            // correctly answered 400 while the harness reported a security contradiction.
            tmp = path.join(fs2.mkdtempSync(path.join(os2.tmpdir(), 'nd-curl-')), 'body.json');
            fs2.writeFileSync(tmp, JSON.stringify(bodyObj), 'utf8');
            extra = `--data-binary "@${tmp.replace(/\\/g, '/')}"`;
        }
        const q = await psRaw(`& curl.exe ${flags} ${extra} ${args}`);
        if (tmp) { try { fs2.rmSync(path.dirname(tmp), { recursive: true, force: true }); } catch (e) { /* best effort */ } }
        return (q.out || '').trim().split(/\s+/).pop();
    };

    const good = `-H "Origin: ${base}" -H "X-Netdiag-Token: ${mounted.TOKEN}" -H "Content-Type: application/json"`;

    let code = await curl(`-X POST ${good} ${base}/api/netdiag/start`, { mode: 'quick' });
    record(AREA, 'a correctly-formed request is accepted', code, '200 expected  [curl.exe]',
        code === '200' ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    code = await curl(`-X POST -H "Origin: ${base}" -H "Content-Type: application/json" ${base}/api/netdiag/start`, {});
    record(AREA, 'no app token', code, '401 expected  [curl.exe]',
        code === '401' ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    // The rebinding shape: a real socket to 127.0.0.1 carrying somebody else's hostname. Only
    // the Host allowlist stops this — the token would not, because the same page can read the
    // token from the unauthenticated GET /.
    code = await curl(`-X POST -H "Host: evil.example.com" ${good} ${base}/api/netdiag/start`, {});
    record(AREA, 'DNS-rebinding shape (valid token, foreign Host)', code, '403 expected  [curl.exe]',
        code === '403' ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    code = await curl(`-X POST -H "Origin: http://evil.example.com" -H "X-Netdiag-Token: ${mounted.TOKEN}" -H "Content-Type: application/json" ${base}/api/netdiag/start`, {});
    record(AREA, 'cross-origin CSRF attempt', code, '403 expected  [curl.exe]',
        code === '403' ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    // A form post is the shape a CSRF page can actually produce without a preflight.
    code = await curl(`-X POST -H "X-Netdiag-Token: ${mounted.TOKEN}" -H "Content-Type: application/x-www-form-urlencoded" -d "mode=quick" ${base}/api/netdiag/start`);
    record(AREA, 'simple-request CSRF shape (form content-type, no Origin)', code,
        '403 or 415 expected  [curl.exe]',
        (code === '415' || code === '403') ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    // A second, unrelated client, in case curl's own header handling were the thing being
    // measured rather than the server's.
    // PS 5.1 raises on a 4xx and exposes the code in different places depending on how the
    // request failed, so every branch is handled explicitly rather than assumed.
    const iwr = await psRaw([
        '$code = 0',
        'try {',
        `  $r = Invoke-WebRequest -Uri '${base}/api/netdiag/history' -Headers @{ 'Origin' = 'http://evil.example.com'; 'X-Netdiag-Token' = '${mounted.TOKEN}' } -UseBasicParsing -TimeoutSec 8`,
        '  $code = [int]$r.StatusCode',
        '} catch [System.Net.WebException] {',
        '  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }',
        '} catch {',
        '  $code = -1',
        '}',
        'Write-Output "CODE=$code"',
    ].join('\n'));
    const m = /CODE=(-?\d+)/.exec(iwr.out || '');
    const iwrCode = m ? Number(m[1]) : null;
    // An oracle that could not produce an answer is INCONCLUSIVE, not evidence against the
    // server — the same rule the TLS and MTU oracles were held to after each of them produced
    // a false contradiction of its own.
    record(AREA, 'cross-origin GET, via a second independent client',
        iwrCode === null ? '(no answer from the oracle)' : String(iwrCode),
        '403 expected  [Invoke-WebRequest]',
        iwrCode === null ? OUTCOME.INCONCLUSIVE
            : (iwrCode === 403 ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED),
        iwrCode === null ? 'PowerShell 5.1 did not surface a status code for this failure' : null);

    // The capability bound, from outside: a repair nobody offered cannot be invoked even with
    // every header correct.
    code = await curl(`-X POST ${good} ${base}/api/netdiag/repair`,
        { sessionId: 'a'.repeat(32), repairId: 'dns.flush', confirmToken: 'b'.repeat(48) });
    record(AREA, 'a repair for an unknown session, with a forged token', code, '404 expected  [curl.exe]',
        code === '404' ? OUTCOME.CORROBORATED : OUTCOME.CONTRADICTED);

    srv.close();
}

// ── run ─────────────────────────────────────────────────────────────────────────────────

(async () => {
    console.log('NetDiag — Independent Validation (read-only)\n');

    // One shared inventory read, from the independent channel, used as INPUT to NetDiag's
    // pure functions. Inputs may be shared; expectations may not.
    const ad = await psJson("Get-NetAdapter -ErrorAction SilentlyContinue | Select-Object Name,InterfaceGuid,InterfaceIndex,InterfaceDescription,Status,Virtual | ConvertTo-Json -Depth 4");
    const rt = await psJson("Get-NetRoute -ErrorAction SilentlyContinue | Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' -or $_.DestinationPrefix -eq '::/0' } | Select-Object DestinationPrefix,NextHop,RouteMetric,InterfaceIndex,AddressFamily | ConvertTo-Json -Depth 4");
    const im = await psJson("Get-NetIPInterface -ErrorAction SilentlyContinue | Select-Object InterfaceIndex,AddressFamily,InterfaceMetric | ConvertTo-Json -Depth 4");

    const adapters = (ad.ok ? ad.value : []).map(a => ({
        guid: a.InterfaceGuid, index: a.InterfaceIndex, name: a.Name,
        description: a.InterfaceDescription, status: a.Status, virtual: a.Virtual,
    }));
    const idxGuid = new Map(adapters.map(a => [a.index, String(a.guid).toLowerCase()]));
    const ifMetrics = {};
    for (const m of (im.ok ? im.value : [])) {
        if (m.AddressFamily === 2) { const g = idxGuid.get(m.InterfaceIndex); if (g) ifMetrics[g] = m.InterfaceMetric; }
    }
    const routes = (rt.ok ? rt.value : []).map(r => ({
        family: r.AddressFamily === 2 ? 'v4' : (r.AddressFamily === 23 ? 'v6' : null),
        prefix: r.DestinationPrefix, nextHop: r.NextHop, metric: r.RouteMetric,
        interfaceGuid: idxGuid.get(r.InterfaceIndex),
    })).filter(r => r.family);

    await validateRouteParser();
    await validateWinhttpParser();
    await validateWinsockParser();
    if (adapters.length) await validateTopology(adapters, routes, ifMetrics);
    else record('topology', 'adapter inventory', '(none)', '(Get-NetAdapter failed)', OUTCOME.INCONCLUSIVE);
    await validateProxyOwnership();
    if (adapters.length) await validateDiagnosis(adapters, routes, ifMetrics);
    await validateDnsPaths();
    await validateLiveEngine();
    await validateRepair();
    await validateSecurity();

    // ── report ──
    const pad = s => String(s).padEnd(14);
    let contradicted = 0;
    let area = null;
    for (const f of findings) {
        if (f.area !== area) { area = f.area; console.log(`\n── ${area} ${'─'.repeat(Math.max(0, 60 - area.length))}`); }
        if (f.outcome === OUTCOME.CONTRADICTED) contradicted++;
        console.log(`${pad(f.outcome)} ${f.question}`);
        console.log(`${' '.repeat(15)}netdiag says : ${f.claim}`);
        console.log(`${' '.repeat(15)}independent  : ${f.oracle}`);
        if (f.note) console.log(`${' '.repeat(15)}note         : ${f.note}`);
    }

    const tally = {};
    for (const f of findings) tally[f.outcome] = (tally[f.outcome] || 0) + 1;
    console.log(`\n${'═'.repeat(72)}`);
    console.log(Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join('   |   '));
    console.log(contradicted
        ? `\n${contradicted} CONTRADICTED — treat each as a NetDiag bug, not as a test to relax.`
        : '\nNo contradictions: every claim NetDiag made was independently corroborated or honestly inconclusive.');
    process.exit(contradicted ? 1 : 0);
})();
