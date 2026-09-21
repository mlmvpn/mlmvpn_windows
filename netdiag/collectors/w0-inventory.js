/*
 * W0 — local inventory. No network. Always completes.
 *
 * This wave is what makes the offline requirement real: it cannot hang on a dead line, and on
 * its own it is enough to diagnose a stopped BFE service, a stranded loopback resolver, a
 * stuck kill switch, a dead proxy endpoint's configuration, and a wrong clock. Every run
 * produces it, however broken the line.
 *
 * Everything is read in ONE PowerShell child emitting ONE JSON document. A dozen spawns cost
 * more than the entire wave's budget on a slow machine, and each one is another chance to
 * fail independently.
 *
 * The rule every field here obeys: unreadable becomes UNKNOWN with a reason, never `false`.
 * `Get-Service` failing is not "the service is stopped", and an unreadable firewall profile is
 * not "outbound is allowed" — those two mistakes alone would produce a fabricated root cause
 * and a missed one.
 */

'use strict';

const F = require('../facts');
const ps = require('../ps');
const T = require('../topology');
const O = require('../ownership');
const { IDS } = require('../rules/ids');

/**
 * One script, one JSON document.
 *
 * `-Depth 6` is not decoration: PS 5.1 defaults to 2 and silently replaces deeper objects
 * with their type name. Every list is wrapped in `@()` so a single-row result serialises as a
 * one-element array instead of a bare object — `Get-NetRoute -DestinationPrefix 0.0.0.0/0` on
 * a single-homed machine returns exactly one row, and reading that as "no default route" is a
 * total-blackout diagnosis on a healthy machine.
 */
const SCRIPT = String.raw`
$o = [ordered]@{}

$o.host = @{
  build   = [string](Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).BuildNumber
  locale  = [string](Get-Culture).Name
  psv     = [string]$PSVersionTable.PSVersion
  elevated = [bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$o.svc = @{}
foreach ($n in 'BFE','Dnscache','Dhcp','NlaSvc','nsi','WinHttpAutoProxySvc','W32Time') {
  $s = Get-Service -Name $n -ErrorAction SilentlyContinue
  if ($s) { $o.svc[$n] = @{ status = $s.Status.ToString(); start = $s.StartType.ToString() } }
}

$fw = @(Get-NetFirewallProfile -ErrorAction SilentlyContinue | Select-Object Name,Enabled,DefaultOutboundAction)
if ($fw.Count) { $o.fw = $fw }

$o.adapters = @(Get-NetAdapter -ErrorAction SilentlyContinue |
  Select-Object Name,InterfaceGuid,InterfaceIndex,InterfaceDescription,Status,Virtual)
$o.addresses = @(Get-NetIPAddress -ErrorAction SilentlyContinue |
  Select-Object InterfaceIndex,IPAddress,PrefixLength,AddressFamily,AddressState,PrefixOrigin)
$o.routes = @(Get-NetRoute -ErrorAction SilentlyContinue |
  Where-Object { $_.DestinationPrefix -eq '0.0.0.0/0' -or $_.DestinationPrefix -eq '::/0' } |
  Select-Object DestinationPrefix,NextHop,RouteMetric,InterfaceIndex,AddressFamily)
$o.ifmetric = @(Get-NetIPInterface -ErrorAction SilentlyContinue |
  Select-Object InterfaceIndex,AddressFamily,InterfaceMetric,Dhcp)
$o.dns = @(Get-DnsClientServerAddress -ErrorAction SilentlyContinue |
  Where-Object { $_.ServerAddresses } |
  Select-Object InterfaceIndex,AddressFamily,ServerAddresses)

$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
if ($p) { $o.proxy = @{ enable = [int]$p.ProxyEnable; server = [string]$p.ProxyServer; pac = [string]$p.AutoConfigURL; bypass = [string]$p.ProxyOverride } }

$c = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Internet Settings\Connections' -Name WinHttpSettings -ErrorAction SilentlyContinue
if ($c -and $c.WinHttpSettings) { $o.winhttp = (($c.WinHttpSettings | ForEach-Object { $_.ToString('x2') }) -join '') }

try {
  $h = Get-Content (Join-Path $env:SystemRoot 'System32\drivers\etc\hosts') -ErrorAction Stop
  $active = @($h | Where-Object { $_ -match '^\s*[0-9a-fA-F:.]+\s+\S' -and $_ -notmatch '^\s*#' })
  # [string] and Select-Object -First are both load-bearing, not tidiness.
  #
  # Get-Content does not return plain strings: PowerShell attaches PSPath, PSDrive and
  # PSProvider to every line, and ConvertTo-Json -Depth 6 expands that provider object graph
  # once per line. This machine's 90-line hosts file serialised to 198,260,643 bytes and the
  # whole inventory timed out at 25s with an empty result — every W0 fact came back UNKNOWN
  # and the engine correctly, uselessly answered «علت قطعی پیدا نشد» on a healthy machine.
  # Casting to [string] drops the metadata; the cap bounds a machine with an ad-blocking
  # hosts file of a few hundred thousand entries. The COUNT is the fact; the lines are only a
  # sample for the report.
  $o.hostsCount = $active.Count
  $o.hosts = [string[]]@($active | Select-Object -First 50 | ForEach-Object { [string]$_ })
} catch { $o.hostsError = $_.Exception.Message }

$o | ConvertTo-Json -Depth 6 -Compress
`;

module.exports = [{
    id: 'w0.inventory',
    wave: 'w0',
    label: 'خواندن تنظیمات شبکهٔ ویندوز',
    network: false,
    timeout: 20000,
    produces: [
        IDS.SVC_BFE_RUNNING, IDS.SVC_BFE_STARTTYPE, IDS.SVC_DNSCACHE_RUNNING,
        IDS.SVC_DHCP_RUNNING, IDS.SVC_NLASVC_RUNNING,
        IDS.FW_OUTBOUND_BLOCK,
        IDS.ROUTE_TABLE_READABLE, IDS.ROUTE_DEFAULT_COUNT_V4, IDS.ROUTE_DEFAULT_COUNT_V6,
        IDS.ROUTE_EGRESS_IS_TUN,
        IDS.PROXY_WININET_ENABLED, IDS.PROXY_WININET_SERVER, IDS.PROXY_PAC_URL,
        IDS.PROXY_WINHTTP_MODE,
        IDS.DNS_CONFIG_LOOPBACK, IDS.DNS_HOSTS_ENTRIES,
    ],

    async run(ctx) {
        const r = await ps.run(SCRIPT, { timeout: ctx.budgetFor(18000) });
        if (!r.ok) {
            // One reason, applied honestly to everything this collector promised. The runner's
            // backstop would do it anyway; doing it here names the actual failure.
            for (const id of module.exports[0].produces) {
                ctx.put(F.unknown(id, `PowerShell inventory failed: ${r.reason}`));
            }
            return;
        }
        const j = ps.parseJson(r.stdout);
        if (!j.ok) {
            for (const id of module.exports[0].produces) {
                ctx.put(F.unknown(id, `inventory JSON unreadable: ${j.reason}`));
            }
            return;
        }
        const w0 = j.value[0] || {};
        const src = 'ps:w0-inventory';
        const obs = (id, v, q, extra) => ctx.put(F.observed(id, v, Object.assign({ quality: q, source: src }, extra || {})));
        const unk = (id, why) => ctx.put(F.unknown(id, why, { source: src }));

        // ── host ──
        ctx.session.host = Object.assign({}, ctx.session.host, w0.host || {});

        // ── services ──
        // A service Get-Service could not see is unknown. It is emphatically not "stopped":
        // svc.bfe-stopped is a confirmed-by-decisive-gate root cause that takes the whole
        // machine offline in its explanation, and inventing it from a failed read would be
        // the worst false positive this engine could produce.
        const svcPairs = [
            ['BFE', IDS.SVC_BFE_RUNNING, IDS.SVC_BFE_STARTTYPE],
            ['Dnscache', IDS.SVC_DNSCACHE_RUNNING, null],
            ['Dhcp', IDS.SVC_DHCP_RUNNING, null],
            ['NlaSvc', IDS.SVC_NLASVC_RUNNING, null],
        ];
        for (const [name, runId, startId] of svcPairs) {
            const s = (w0.svc || {})[name];
            if (!s || !s.status) { unk(runId, `Get-Service ${name} returned nothing`); if (startId) unk(startId, 'not read'); continue; }
            obs(runId, s.status === 'Running', F.QUALITY.REPORTED);
            if (startId) obs(startId, s.start || 'unknown', F.QUALITY.REPORTED);
        }

        // ── firewall ──
        if (!Array.isArray(w0.fw) || !w0.fw.length) {
            unk(IDS.FW_OUTBOUND_BLOCK, 'Get-NetFirewallProfile returned nothing (policy or permissions)');
        } else {
            obs(IDS.FW_OUTBOUND_BLOCK, w0.fw.some(p => p.DefaultOutboundAction === 'Block' || p.DefaultOutboundAction === 4),
                F.QUALITY.REPORTED, { raw: JSON.stringify(w0.fw) });
        }

        // ── topology ──
        const adapters = (w0.adapters || []).map(a => ({
            guid: a.InterfaceGuid, index: a.InterfaceIndex, name: a.Name,
            description: a.InterfaceDescription, status: a.Status, virtual: a.Virtual,
        }));
        const idxGuid = new Map(adapters.map(a => [a.index, String(a.guid).toLowerCase()]));
        const ifMetrics = {};
        for (const m of w0.ifmetric || []) {
            if (ps.familyOf(m.AddressFamily) === 'v4') {
                const g = idxGuid.get(m.InterfaceIndex);
                if (g) ifMetrics[g] = m.InterfaceMetric;
            }
        }
        const addresses = (w0.addresses || []).map(a => ({
            interfaceGuid: idxGuid.get(a.InterfaceIndex), family: ps.familyOf(a.AddressFamily),
            ip: a.IPAddress, prefix: a.PrefixLength, addressState: a.AddressState, origin: a.PrefixOrigin,
        })).filter(a => a.interfaceGuid);
        const defaultRoutes = (w0.routes || []).map(r2 => ({
            family: ps.familyOf(r2.AddressFamily), prefix: r2.DestinationPrefix, nextHop: r2.NextHop,
            metric: r2.RouteMetric, interfaceGuid: idxGuid.get(r2.InterfaceIndex),
        })).filter(r2 => r2.family && r2.interfaceGuid);

        if (!adapters.length) {
            // Without knowing which interface is which, no repair is safe and no route fact
            // means anything. The whole run degrades rather than guessing.
            unk(IDS.ROUTE_TABLE_READABLE, 'no adapters could be enumerated');
            unk(IDS.ROUTE_DEFAULT_COUNT_V4, 'no adapters');
            unk(IDS.ROUTE_DEFAULT_COUNT_V6, 'no adapters');
            unk(IDS.ROUTE_EGRESS_IS_TUN, 'no adapters');
        } else {
            const topo = T.buildTopology({ adapters, ifMetrics, defaultRoutes, addresses });
            ctx.session.topology = topo;
            obs(IDS.ROUTE_TABLE_READABLE, true, F.QUALITY.REPORTED);
            obs(IDS.ROUTE_DEFAULT_COUNT_V4, topo.defaultRoutes.v4.length, F.QUALITY.REPORTED);
            obs(IDS.ROUTE_DEFAULT_COUNT_V6, topo.defaultRoutes.v6.length, F.QUALITY.REPORTED);
            const eg = T.egressInterface(topo, 'v4');
            if (!eg) {
                unk(IDS.ROUTE_EGRESS_IS_TUN, topo.egress.v4.reason || 'no egress interface could be determined');
            } else {
                // `inferred`, not measured: this follows from the classification and the metric
                // arithmetic rather than from anything observed on the wire.
                obs(IDS.ROUTE_EGRESS_IS_TUN,
                    eg.cls === T.IF_CLASS.VPN_TUN || eg.cls === T.IF_CLASS.VPN_TAP,
                    F.QUALITY.INFERRED, { note: `egress: ${eg.name} (${eg.cls})` });
            }
        }

        // ── proxy ──
        const px = w0.proxy;
        if (!px) {
            unk(IDS.PROXY_WININET_ENABLED, 'Internet Settings key unreadable');
            unk(IDS.PROXY_WININET_SERVER, 'Internet Settings key unreadable');
            unk(IDS.PROXY_PAC_URL, 'Internet Settings key unreadable');
        } else {
            obs(IDS.PROXY_WININET_ENABLED, px.enable === 1, F.QUALITY.REPORTED);
            obs(IDS.PROXY_WININET_SERVER, px.server || '', F.QUALITY.REPORTED);
            // An absent AutoConfigURL is an observation, not a gap: `null` means "we looked and
            // there is no PAC", which is what lets proxy.pac-dead be eliminated rather than
            // left indeterminate on every healthy machine.
            obs(IDS.PROXY_PAC_URL, px.pac || null, F.QUALITY.REPORTED);
        }

        // WinHTTP from the STRUCTURED source. netsh's "Direct access (no proxy server)" is
        // localised prose and cannot prove `direct` on a non-English machine; the registry
        // flag bit can, in every locale.
        if (!w0.winhttp) {
            obs(IDS.PROXY_WINHTTP_MODE, 'direct', F.QUALITY.INFERRED,
                { note: 'no WinHttpSettings value exists, which is the default direct state' });
        } else {
            const wh = ps.parseWinhttpSettingsBlob(w0.winhttp);
            if (wh.ok) obs(IDS.PROXY_WINHTTP_MODE, wh.value.mode, F.QUALITY.REPORTED, { raw: w0.winhttp });
            else unk(IDS.PROXY_WINHTTP_MODE, wh.reason);
        }

        // ── DNS configuration ──
        const dnsRows = (w0.dns || []).filter(d => ps.familyOf(d.AddressFamily));
        if (!dnsRows.length) {
            unk(IDS.DNS_CONFIG_LOOPBACK, 'no DNS configuration could be read');
        } else {
            const all = dnsRows.flatMap(d => d.ServerAddresses || []);
            obs(IDS.DNS_CONFIG_LOOPBACK, all.some(s => /^127\./.test(s) || s === '::1'),
                F.QUALITY.REPORTED, { raw: all.join(',') });
            ctx.session.app.dnsServers = all;
            ctx.session.app.dnsByInterface = dnsRows.map(d => ({
                interfaceGuid: idxGuid.get(d.InterfaceIndex),
                family: ps.familyOf(d.AddressFamily),
                servers: d.ServerAddresses || [],
            }));
        }

        // ── hosts ──
        // The count comes from the script, not from the sampled lines — the sample is capped,
        // so counting it would under-report a machine with thousands of entries.
        if (w0.hostsError) unk(IDS.DNS_HOSTS_ENTRIES, `hosts file unreadable: ${w0.hostsError}`);
        else if (typeof w0.hostsCount !== 'number') unk(IDS.DNS_HOSTS_ENTRIES, 'hosts entry count missing from inventory');
        else obs(IDS.DNS_HOSTS_ENTRIES, w0.hostsCount, F.QUALITY.REPORTED,
            { raw: (w0.hosts || []).slice(0, 20).join('\n') });
    },
}];
