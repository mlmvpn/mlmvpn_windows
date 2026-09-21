// --- System DNS manager ---
// Sets the machine's resolvers, and cleans out ones that survive the obvious routes.
//
// WHY A "DEEP" CLEAN IS NEEDED AT ALL.
// Setting the adapter to "obtain DNS automatically" does NOT remove a resolver that the
// ROUTER hands out over DHCP — automatic means "use whatever DHCP says", and on a
// network configured with Shecan, DHCP says Shecan. That is why the user could reset
// IPv4 properties in both the Wi-Fi dialog and Control Panel and still resolve through
// it. Verified on this machine: netsh reported
//     Wi-Fi 3:  DNS servers configured through DHCP: 178.22.122.101 / 185.51.200.1
// The only Windows-side cure is an explicit STATIC resolver, plus clearing the places a
// stale one can hide:
//   1. per-adapter static NameServer            (registry + netsh)
//   2. DHCP-supplied DhcpNameServer cache       (registry)
//   3. Windows 11 DoH templates per interface   (registry)
//   4. NRPT rules (per-namespace resolvers)     (policy)
//   5. the resolver cache itself
// Dead adapters matter too: a leftover static entry on a disconnected VPN/TAP adapter
// keeps answering for its own namespace and looks like the setting "came back".

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

const DATA_DIR = path.join(os.homedir(), '.mlmvpn');
const BACKUP_FILE = path.join(DATA_DIR, 'dns-backup.json');

// ── Provider catalogue ────────────────────────────────────────────────────────
// Grouped so the panel can explain WHY you would pick one. The Iranian entries are
// anti-sanction resolvers: they answer for services that block Iranian IPs, and several
// of them deliberately return NXDOMAIN for everything else — which is exactly how
// workers.dev broke earlier in this project. That trade-off is stated per provider
// rather than left for the user to discover.
const PROVIDERS = [
    // Global
    { id: 'cloudflare', name: 'کلادفلر', en: 'Cloudflare', servers: ['1.1.1.1', '1.0.0.1'], v6: ['2606:4700:4700::1111', '2606:4700:4700::1001'],
      group: 'global', note: 'سریع و بدون فیلتر داخلی. برای بیشتر کارها بهترین انتخاب.' },
    { id: 'google', name: 'گوگل', en: 'Google', servers: ['8.8.8.8', '8.8.4.4'], v6: ['2001:4860:4860::8888', '2001:4860:4860::8844'],
      group: 'global', note: 'پایدار و جهانی. تحریم را دور نمی‌زند.' },
    { id: 'quad9', name: 'کواد۹', en: 'Quad9', servers: ['9.9.9.9', '149.112.112.112'], v6: ['2620:fe::fe', '2620:fe::9'],
      group: 'global', note: 'مسدودسازی دامنه‌های مخرب.' },
    { id: 'opendns', name: 'اوپن‌دی‌ان‌اس', en: 'OpenDNS', servers: ['208.67.222.222', '208.67.220.220'], v6: ['2620:119:35::35', '2620:119:53::53'],
      group: 'global', note: 'قدیمی و قابل اعتماد.' },
    { id: 'adguard', name: 'ادگارد', en: 'AdGuard', servers: ['94.140.14.14', '94.140.15.15'], v6: ['2a10:50c0::ad1:ff', '2a10:50c0::ad2:ff'],
      group: 'global', note: 'حذف تبلیغات و ردیاب‌ها.' },
    { id: 'level3', name: 'لول‌تری', en: 'Level3', servers: ['209.244.0.3', '209.244.0.4'],
      group: 'global', note: 'زیرساخت قدیمی، گاهی روی برخی شبکه‌ها سریع‌تر.' },

    // Iranian anti-sanction
    { id: 'shecan', name: 'شکن', en: 'Shecan', servers: ['178.22.122.100', '185.51.200.2'],
      group: 'iran', note: 'تحریم را باز می‌کند، ولی دامنه‌های خارج از فهرستش را NXDOMAIN می‌دهد.' },
    { id: 'shecan-pro', name: 'شکن (پرو)', en: 'Shecan Pro', servers: ['178.22.122.101', '185.51.200.1'],
      group: 'iran', note: 'نسخه‌ی دوم شکن. همان محدودیت را دارد.' },
    { id: '403', name: '۴۰۳', en: '403.online', servers: ['10.202.10.202', '10.202.10.102'],
      group: 'iran', note: 'مخصوص ابزارهای برنامه‌نویسی و سرویس‌های تحریمی.' },
    { id: 'begzar', name: 'بگذر', en: 'Begzar', servers: ['185.55.226.26', '185.55.225.25'],
      group: 'iran', note: 'پوشش گسترده‌ی سایت‌های تحریمی.' },
    { id: 'electro', name: 'الکترو', en: 'Electro', servers: ['78.157.42.100', '78.157.42.101'],
      group: 'iran', note: 'تحریم‌شکن با تمرکز روی بازی.' },
    { id: 'radar', name: 'رادار', en: 'RadarGame', servers: ['10.202.10.10', '10.202.10.11'],
      group: 'iran', note: 'کاهش پینگ بازی‌های آنلاین.' },
    { id: 'shelter', name: 'شلتر', en: 'Shelter', servers: ['94.103.125.157', '94.103.125.158'],
      group: 'iran', note: 'تحریم‌شکن با تمرکز روی بازی.' },
    { id: 'beshkan', name: 'بشکن', en: 'Beshkan', servers: ['181.41.194.177', '181.41.194.186'],
      group: 'iran', note: 'تحریم‌شکن عمومی.' },
    { id: 'pishgaman', name: 'پیشگامان', en: 'Pishgaman', servers: ['5.202.100.100', '5.202.100.101'],
      group: 'iran', note: 'سرویس‌دهنده‌ی داخلی.' },
    { id: 'shatel', name: 'شاتل', en: 'Shatel', servers: ['85.15.1.14', '85.15.1.15'],
      group: 'iran', note: 'مخصوص مشترکین شاتل.' },
];

function run(cmd, args, { timeout = 25000 } = {}) {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
    });
}

// Are we already running as Administrator?
//
// This matters far more than it looks. The packaged app ALWAYS runs elevated
// (build.win.requestedExecutionLevel = requireAdministrator), yet every DNS change below
// used to spawn a NESTED elevated PowerShell through `Start-Process -Verb RunAs -Wait`.
// That round trip costs seconds even when it prompts for nothing — and those seconds are
// the window in which `/api/aether/stop` returns success while the adapters are still
// pointed at a 127.0.0.1 resolver that is about to stop existing. Measured on this machine:
// stop returned, the process was killed three seconds later, and Windows was left with no
// working DNS at all.
//
// Cached because the answer cannot change inside one process, and the check itself spawns
// a process.
let _isElevated = null;
function isElevated() {
    if (_isElevated !== null) return _isElevated;
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command',
            '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
            '.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
        ], { timeout: 15000, windowsHide: true, encoding: 'utf8' });
        _isElevated = /true/i.test(String(out));
    } catch (e) {
        _isElevated = false;
    }
    return _isElevated;
}

/**
 * Run a PowerShell script elevated and wait for it.
 * DNS changes need administrator; without elevation Set-DnsClientServerAddress fails with
 * an opaque CIM error that reads like a bug rather than a permission problem.
 *
 * When this process is already elevated the script is run DIRECTLY — same privileges, none
 * of the Start-Process latency. The nested-elevation path is kept for the development case
 * (`node server.js` from an ordinary shell), where it is the only way to get the rights.
 */
function runElevated(script, { timeout = 120000 } = {}) {
    if (isElevated()) return runDirect(script, { timeout });
    return new Promise(resolve => {
        const file = path.join(os.tmpdir(), `mlm-dns-${Date.now()}.ps1`);
        const logFile = file + '.log';
        // The script writes its own result, because a UAC-elevated child's stdout is not
        // piped back to us.
        fs.writeFileSync(file, `$ErrorActionPreference='Continue'\n${script}\n`, 'utf8');

        const psArgs = [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
            '-Command',
            `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
            `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${file}'`,
        ];

        execFile('powershell', psArgs, { timeout, windowsHide: true }, (err) => {
            let log = '';
            try { log = fs.readFileSync(logFile, 'utf8'); } catch (e) { /* script may not log */ }
            try { fs.unlinkSync(file); } catch (e) {}
            try { fs.unlinkSync(logFile); } catch (e) {}
            resolve({ ok: !err, log, elevationRefused: !!err });
        });
    });
}

/**
 * The already-elevated fast path.
 *
 * The scripts written for runElevated() report their result by writing to
 * "$PSCommandPath.log", because a UAC-elevated child's stdout is not piped back. Running
 * from a file keeps $PSCommandPath meaningful, so the same script text works unchanged on
 * both paths — a second dialect here is how the two would silently drift apart.
 */
function runDirect(script, { timeout = 120000 } = {}) {
    return new Promise(resolve => {
        const file = path.join(os.tmpdir(), `mlm-dns-${Date.now()}-${process.pid}.ps1`);
        const logFile = file + '.log';
        try {
            fs.writeFileSync(file, `$ErrorActionPreference='Continue'\n${script}\n`, 'utf8');
        } catch (e) {
            return resolve({ ok: false, log: '', elevationRefused: false, error: e.message });
        }
        execFile('powershell', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-WindowStyle', 'Hidden', '-File', file,
        ], { timeout, windowsHide: true }, (err) => {
            let log = '';
            try { log = fs.readFileSync(logFile, 'utf8'); } catch (e) { /* script may not log */ }
            try { fs.unlinkSync(file); } catch (e) {}
            try { fs.unlinkSync(logFile); } catch (e) {}
            // `elevationRefused` stays false here on purpose: we ARE elevated, so a failure
            // is a script failure and must not be reported to the user as a refused prompt.
            resolve({ ok: !err, log, elevationRefused: false });
        });
    });
}

// ── inspection ────────────────────────────────────────────────────────────────

/** Adapters that are up and carry a default gateway — the ones that matter. */
async function getAdapters() {
    const ps = `
$out = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $i = $_.InterfaceIndex
  $dns = (Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses
  $cfg = Get-NetIPConfiguration -InterfaceIndex $i -ErrorAction SilentlyContinue
  [pscustomobject]@{
    name = $_.Name; index = $i; desc = $_.InterfaceDescription
    gateway = if ($cfg.IPv4DefaultGateway) { $cfg.IPv4DefaultGateway.NextHop } else { '' }
    dns = @($dns)
  }
}
$out | ConvertTo-Json -Depth 4 -Compress`;
    const r = await run('powershell', ['-NoProfile', '-Command', ps]);
    try {
        const parsed = JSON.parse(r.stdout.trim() || '[]');
        return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
        return [];
    }
}

/** Which known provider (if any) the current resolvers belong to. */
function identify(servers) {
    const set = new Set((servers || []).map(s => String(s).trim()));
    for (const p of PROVIDERS) {
        if (p.servers.some(s => set.has(s))) return p;
    }
    return null;
}

async function getStatus() {
    const adapters = await getAdapters();
    const active = adapters.filter(a => a.gateway);
    const primary = active[0] || adapters[0] || null;

    return {
        adapters,
        active: active.map(a => ({ ...a, provider: identify(a.dns) })),
        current: primary ? { name: primary.name, dns: primary.dns, provider: identify(primary.dns) } : null,
        hasBackup: fs.existsSync(BACKUP_FILE),
    };
}

// ── where is this resolver coming from? ───────────────────────────────────────

/**
 * Enumerate every place on this machine that can impose a resolver, and say which one
 * is actually in effect.
 *
 * This exists because "I set DNS to automatic and it is still Shecan" is not one bug —
 * it is five possible causes that look identical from the Wi-Fi dialog:
 *   dhcp        the ROUTER advertises it; "automatic" means "obey the router"
 *   static      set on the adapter (the only one the Wi-Fi dialog shows)
 *   stale-nic   left on a disconnected VPN/TAP adapter; still answers for its namespace
 *   doh         Windows 11 DNS-over-HTTPS template, independent of the plain resolver
 *   nrpt        a policy rule that redirects only certain domains
 *   hosts       a hosts-file entry, which wins over DNS entirely
 * Each entry carries its own `clearable` id so the panel can remove exactly one source
 * instead of offering an all-or-nothing button.
 */
async function diagnose() {
    const ps = `
$res = @()

# Adapters: static vs DHCP, connected vs not.
Get-NetAdapter | ForEach-Object {
  $i = $_.InterfaceIndex
  $name = $_.Name
  $up = $_.Status -eq 'Up'
  $servers = (Get-DnsClientServerAddress -InterfaceIndex $i -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses
  if (-not $servers -or $servers.Count -eq 0) { return }

  $guid = $_.InterfaceGuid
  $reg = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid"
  $static = ''
  $dhcp = ''
  if (Test-Path $reg) {
    $p = Get-ItemProperty $reg -ErrorAction SilentlyContinue
    $static = [string]$p.NameServer
    $dhcp = [string]$p.DhcpNameServer
  }

  $source = if ($static -and $static.Trim()) { 'static' } elseif ($dhcp -and $dhcp.Trim()) { 'dhcp' } else { 'unknown' }
  if (-not $up) { $source = 'stale-nic' }

  $res += [pscustomobject]@{
    kind = $source; adapter = $name; index = $i; up = $up
    servers = @($servers); detail = if ($source -eq 'dhcp') { 'از روتر (DHCP)' } else { '' }
  }
}

# Windows 11 DoH templates.
$doh = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\InterfaceSpecificParameters'
if (Test-Path $doh) {
  Get-ChildItem $doh -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -eq 'DohInterfaceSettings' } | ForEach-Object {
      Get-ChildItem $_.PSPath -ErrorAction SilentlyContinue | ForEach-Object {
        $ip = Split-Path $_.PSPath -Leaf
        $res += [pscustomobject]@{ kind='doh'; adapter=''; index=0; up=$true; servers=@($ip); detail='DNS رمزنگاری‌شده' }
      }
    }
}

# NRPT rules pin a resolver for specific namespaces only.
try {
  Get-DnsClientNrptRule -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.NameServers) {
      $res += [pscustomobject]@{ kind='nrpt'; adapter=[string]$_.Name; index=0; up=$true
                                 servers=@($_.NameServers); detail=[string]$_.Namespace }
    }
  }
} catch {}

$res | ConvertTo-Json -Depth 5 -Compress`;

    const r = await run('powershell', ['-NoProfile', '-Command', ps], { timeout: 45000 });
    let raw = [];
    try {
        const parsed = JSON.parse(r.stdout.trim() || '[]');
        raw = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) { raw = []; }

    const LABELS = {
        dhcp: { title: 'از روتر (DHCP)', why: 'روتر شما این DNS را پخش می‌کند. تنظیم «خودکار» در ویندوز یعنی همین را بپذیر — برای همین پاک نمی‌شود.' },
        static: { title: 'تنظیم دستی روی کارت شبکه', why: 'در تنظیمات IPv4 همین کارت ثبت شده است.' },
        'stale-nic': { title: 'کارت شبکه‌ی غیرفعال', why: 'این کارت وصل نیست ولی تنظیم DNS روی آن مانده و می‌تواند برگردد.' },
        doh: { title: 'DNS رمزنگاری‌شده (DoH)', why: 'ویندوز ۱۱ جداگانه از این استفاده می‌کند، حتی وقتی DNS معمولی عوض شده باشد.' },
        nrpt: { title: 'قانون NRPT', why: 'فقط برای بعضی دامنه‌ها اعمال می‌شود — به همین دلیل بعضی سایت‌ها فرق می‌کنند.' },
    };

    const sources = raw.filter(Boolean).map((s, i) => {
        const provider = identify(s.servers);
        const label = LABELS[s.kind] || { title: s.kind, why: '' };
        return {
            id: `${s.kind}:${s.index || s.adapter || i}`,
            kind: s.kind,
            title: label.title,
            why: label.why,
            adapter: s.adapter || '',
            index: s.index || 0,
            active: !!s.up,
            servers: s.servers || [],
            provider: provider ? { id: provider.id, name: provider.name } : null,
            detail: s.detail || '',
        };
    });

    // The hosts file overrides DNS completely, so a hijack there survives every resolver
    // change and looks like "DNS is ignoring me".
    const hostsPath = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
    let hostsEntries = [];
    try {
        hostsEntries = fs.readFileSync(hostsPath, 'utf8')
            .split(/\r?\n/)
            .map(l => l.trim())
            .filter(l => l && !l.startsWith('#'));
    } catch (e) { /* unreadable without elevation on some systems */ }

    const status = await getStatus();
    return {
        sources,
        effective: status.current,
        hosts: { path: hostsPath, count: hostsEntries.length, sample: hostsEntries.slice(0, 8) },
        summary: sources.length
            ? `${sources.length} منبع DNS روی این سیستم پیدا شد.`
            : 'هیچ منبع DNS مشخصی پیدا نشد.',
    };
}

/** Remove exactly one source, so the user is not forced into an all-or-nothing clean. */
async function clearSource(sourceId) {
    const [kind, key] = String(sourceId || '').split(':');
    if (!kind) throw new Error('منبع مشخص نشده است.');

    await saveBackup();
    let script = '';

    if (kind === 'dhcp' || kind === 'static' || kind === 'stale-nic') {
        const idx = parseInt(key, 10);
        if (isNaN(idx)) throw new Error('کارت شبکه مشخص نیست.');
        script = `
try { Set-DnsClientServerAddress -InterfaceIndex ${idx} -ResetServerAddresses -ErrorAction Stop } catch {}
$g = (Get-NetAdapter -InterfaceIndex ${idx} -ErrorAction SilentlyContinue).InterfaceGuid
if ($g) {
  $reg = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$g"
  if (Test-Path $reg) {
    Set-ItemProperty -Path $reg -Name 'NameServer' -Value '' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $reg -Name 'DhcpNameServer' -ErrorAction SilentlyContinue
  }
}
Clear-DnsClientCache
"cleared ${kind} on ${idx}" | Out-File "$PSCommandPath.log" -Encoding utf8`;
    } else if (kind === 'doh') {
        script = `
$doh = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\InterfaceSpecificParameters'
if (Test-Path $doh) {
  Get-ChildItem $doh -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -eq 'DohInterfaceSettings' } |
    ForEach-Object { Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
}
Clear-DnsClientCache
"cleared doh" | Out-File "$PSCommandPath.log" -Encoding utf8`;
    } else if (kind === 'nrpt') {
        script = `
Get-DnsClientNrptRule -ErrorAction SilentlyContinue | ForEach-Object {
  Remove-DnsClientNrptRule -Name $_.Name -Force -ErrorAction SilentlyContinue
}
Clear-DnsClientCache
"cleared nrpt" | Out-File "$PSCommandPath.log" -Encoding utf8`;
    } else {
        throw new Error('این نوع منبع قابل پاک کردن نیست.');
    }

    const res = await runElevated(script);
    const after = await diagnose();
    return {
        ok: !res.elevationRefused,
        sources: after.sources,
        effective: after.effective,
        message: res.elevationRefused
            ? 'برای پاک کردن به دسترسی مدیر نیاز است — درخواست رد شد.'
            : 'این منبع پاک شد.',
    };
}

// ── ping ──────────────────────────────────────────────────────────────────────

/**
 * Measure a resolver by asking it something, not by ICMP.
 *
 * Many of these hosts drop ping while answering DNS perfectly well, and some networks
 * block ICMP outright — a ping-based test would show a working resolver as dead. What
 * matters is whether it RESOLVES, so that is what gets measured.
 */
async function pingProvider(provider) {
    const server = provider.servers[0];
    const ps = `
$sw = [System.Diagnostics.Stopwatch]::StartNew()
try {
  $r = Resolve-DnsName -Name 'www.google.com' -Server '${server}' -Type A -QuickTimeout -DnsOnly -ErrorAction Stop
  $sw.Stop()
  if ($r) { "OK $($sw.ElapsedMilliseconds)" } else { "FAIL no-answer" }
} catch { $sw.Stop(); "FAIL $($_.Exception.Message -replace '\\s+',' ')" }`;

    const r = await run('powershell', ['-NoProfile', '-Command', ps], { timeout: 12000 });
    const out = r.stdout.trim();

    if (out.startsWith('OK')) {
        const ms = parseInt(out.split(/\s+/)[1], 10);
        return { id: provider.id, ok: true, latency: isNaN(ms) ? null : ms };
    }
    return { id: provider.id, ok: false, latency: null, error: 'پاسخ نداد' };
}

/** Test every provider, a few at a time so a slow one does not stall the rest. */
async function pingAll(onProgress = () => {}) {
    const results = [];
    const queue = PROVIDERS.slice();
    const workers = new Array(4).fill(0).map(async () => {
        while (queue.length) {
            const p = queue.shift();
            const r = await pingProvider(p);
            results.push(r);
            onProgress(results.length, PROVIDERS.length, r);
        }
    });
    await Promise.all(workers);

    // Working first, fastest first.
    results.sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        return (a.latency ?? 1e9) - (b.latency ?? 1e9);
    });
    return results;
}

// ── backup / apply / clean ────────────────────────────────────────────────────

async function saveBackup() {
    try {
        const status = await getStatus();
        fs.mkdirSync(DATA_DIR, { recursive: true });
        // Never overwrite the FIRST backup: it is the only record of what the machine
        // looked like before this app touched it.
        if (!fs.existsSync(BACKUP_FILE)) {
            fs.writeFileSync(BACKUP_FILE, JSON.stringify({
                at: Date.now(),
                adapters: status.adapters.map(a => ({ name: a.name, index: a.index, dns: a.dns })),
            }, null, 2), 'utf8');
        }
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Point every active adapter at `servers`.
 * A STATIC assignment on purpose — see the file header on why "automatic" cannot
 * displace a resolver the router is handing out.
 */
async function applyProvider(providerId) {
    const provider = PROVIDERS.find(p => p.id === providerId);
    if (!provider) throw new Error('این DNS در فهرست نیست.');
    // BOTH FAMILIES, when the provider publishes them.
    //
    // Windows keeps a resolver list per address family and prefers the IPv6 one, and the IPv6 list
    // it starts with is whatever the router advertised. The only thing that displaces that is a
    // static IPv6 resolver — see the note in applyServers, which measured the alternative and found
    // it does nothing. So a provider with IPv6 addresses must install them, or choosing it changes
    // which resolver answers only half the time.
    return applyServers(provider.servers.concat(provider.v6 || []), provider.name, provider);
}

/**
 * Point every active adapter at an arbitrary resolver list.
 *
 * Split out of applyProvider so the dedicated-DNS bridge can hand Windows 127.0.0.1
 * through exactly the same elevation, verification and backup path as a catalogue
 * provider — a second copy of this script is how the two would drift apart.
 */
async function applyServers(servers, label, provider = null) {
    if (!Array.isArray(servers) || !servers.length) throw new Error('فهرست DNS خالی است.');

    await saveBackup();

    // Windows keeps one resolver list PER ADDRESS FAMILY, and prefers the IPv6 list whenever
    // the adapter has a usable IPv6 address. Handing Set-DnsClientServerAddress an IPv4-only
    // list sets the IPv4 list and leaves the IPv6 one exactly as the ISP's router advertised
    // it — so on any dual-stack connection every lookup still went out in cleartext to the
    // ISP resolver. That is the leak the DNS-leak test sites reported as an Iranian resolver
    // even with the tunnel up. Both families are now set explicitly, and when the caller has
    // no IPv6 resolver to offer the v6 list is emptied rather than left pointing at the ISP.
    const v4 = servers.filter(s => !String(s).includes(':'));
    const v6 = servers.filter(s => String(s).includes(':'));
    const list4 = v4.map(s => `'${s}'`).join(',');
    const list6 = v6.map(s => `'${s}'`).join(',');

    // `Set-DnsClientServerAddress` has NO -AddressFamily parameter.
    //
    // It accepts only -InterfaceIndex, -ServerAddresses and -ResetServerAddresses (verified
    // on this machine with `(Get-Command Set-DnsClientServerAddress).Parameters`). The old
    // code passed -AddressFamily anyway, so EVERY call failed with "A parameter cannot be
    // found that matches parameter name 'AddressFamily'" and `applied=0` — the DNS bridge
    // could never take effect on any adapter, on any machine, ever. The cmdlet infers the
    // family from each address, so one call with the mixed list sets both lists at once,
    // which is what the two calls were trying to achieve.
    //
    // `netsh` handles the per-family cases the cmdlet cannot express: clearing ONLY the
    // IPv6 list (the cmdlet's reset clears both) is what stops Windows preferring a
    // router-advertised IPv6 resolver on a dual-stack line.
    const allList = servers.map(s => `'${s}'`).join(',');

    const script = `
$log = @()
$ok = 0
Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $i = $_.InterfaceIndex
  $n = $_.Name
  try {
    Set-DnsClientServerAddress -InterfaceIndex $i -ServerAddresses @(${allList}) -ErrorAction Stop
    $log += "set $n"
    $ok++
  } catch {
    $log += "fail $n : $($_.Exception.Message)"
  }
${v6.length ? '' : `
  # No IPv6 resolver of our own to install: clear the v6 list for this adapter alone, so a
  # router-advertised ISP resolver cannot keep answering over IPv6 while v4 goes to us.
  #
  # THIS BRANCH CANNOT CLOSE THE LEAK, and both spellings of it were measured on this machine
  # on 2026-09-14. It is kept because it is right for a STATIC v6 resolver and harmless otherwise,
  # but the comment above overstated it and the real fix is a v6 list on the provider.
  #
  #   source=dhcp             -- the original. The opposite of clearing: it tells Windows to take
  #                              the resolver the ROUTER advertises, which is the one to be rid of.
  #   source=static address=none -- reports success, logs no error, and leaves the list UNCHANGED:
  #                              IPv4 1.1.1.1, 1.0.0.1 (ours) / IPv6 fe80::c89e:ceff:fe95:d2c6
  #                              (still the router), verified straight after an ok=true apply.
  #
  # The reason is that a router-advertised resolver is not static configuration at all: it arrives
  # by Router Advertisement (RFC 8106 RDNSS) and lives outside the static list these commands edit.
  # What DOES displace it is installing a static IPv6 resolver -- measured, same session:
  # after applying Cloudflare with its v6 addresses the list read 2606:4700:4700::1111, ::1001.
  #
  # Hence a v6 list in the catalogue. For the Iranian providers, which publish no IPv6 resolver, the
  # honest position is that this cannot be fixed from here: emptying the list is not possible and
  # pointing IPv6 at somebody else's resolver would silently defeat the anti-sanction DNS the user
  # chose, because Windows would ask the wrong one half the time. Only disabling router discovery
  # would do it, and that takes IPv6 routing down with it -- not something to do behind the user's
  # back for a DNS choice.
  #
  # What the leak cost, concretely: لنترن resolves cloudflare-dns.com for its DoH, and on this line
  # the answer came back 2001:4188:2:600:10:10:34:36 -- inside IRAN's own IPv6 allocation, tail
  # mirroring the filter sinkhole 10.10.34.36 -- so the engine could not resolve its own resolver.
  try {
    netsh interface ipv6 set dnsservers name="$n" source=static address=none | Out-Null
    $log += "v6clear $n"
  } catch {
    $log += "failv6clear $n : $($_.Exception.Message)"
  }`}
}
Clear-DnsClientCache
ipconfig /flushdns | Out-Null
$log += "applied=$ok"
$log -join "\`n" | Out-File "$PSCommandPath.log" -Encoding utf8`;

    const res = await runElevated(script);
    const after = await getStatus();

    // The verdict is taken across EVERY active adapter, not just `current`.
    //
    // The script above sets each adapter that is Up, but the check used to look at
    // `after.current` alone — `active[0]`, whichever gateway-bearing adapter the enumeration
    // happened to yield first. On a machine with more than one (a VM host adapter, a Wintun
    // device, a second NIC) that can easily be an adapter the change did not land on, and the
    // whole call was then reported as failed even though every adapter that matters had taken
    // the new resolver. The caller treats that as fatal: it stops the DNS bridge and logs
    // "سرویس DNS محلی روشن نشد", leaving the machine on the ISP resolver — a reported leak
    // caused purely by looking at the wrong adapter.
    const carries = (a) => servers.some(s => (a.dns || []).includes(s));
    const took = (after.active || []).filter(carries);
    const missed = (after.active || []).filter(a => !carries(a));
    const applied = took.length > 0;

    return {
        ok: applied,
        provider,
        servers,
        current: after.current,
        appliedTo: took.map(a => a.name),
        missed: missed.map(a => a.name),
        log: res.log,
        message: applied
            ? (missed.length
                ? `DNS روی «${label}» تنظیم شد (${took.map(a => a.name).join('، ')}). این آداپتورها تغییر نکردند: ${missed.map(a => a.name).join('، ')}`
                : `DNS روی «${label}» تنظیم شد.`)
            : res.elevationRefused
                ? 'برای تغییر DNS به دسترسی مدیر نیاز است — درخواست دسترسی رد شد.'
                : 'تغییر اعمال نشد. لاگ را ببینید.',
    };
}

/**
 * Deep clean.
 *
 * Everything here targets a specific way a resolver survives the obvious reset — see the
 * file header. `resetToAuto` decides the end state: back to DHCP, or an explicit
 * resolver. On a network whose router advertises a filtering DNS, "auto" hands the user
 * straight back to it, so the panel defaults to setting Cloudflare instead.
 */
async function deepClean({ resetToAuto = false, thenApply = 'cloudflare' } = {}) {
    await saveBackup();

    const applyList = resetToAuto
        ? null
        : (PROVIDERS.find(p => p.id === thenApply) || PROVIDERS[0]).servers;

    const script = `
$log = @()

# 1. Every adapter, not just the connected one: a stale static entry on a disconnected
#    VPN or TAP adapter keeps resolving for its own namespace and looks like the setting
#    "came back" after being cleared.
Get-NetAdapter | ForEach-Object {
  try {
    Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ResetServerAddresses -ErrorAction Stop
    $log += "reset $($_.Name)"
  } catch { $log += "reset-skip $($_.Name)" }
}

# 2. Registry leftovers. Set-DnsClientServerAddress clears NameServer but leaves the
#    cached DhcpNameServer, which some tools read back and re-apply.
$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces'
Get-ChildItem $base -ErrorAction SilentlyContinue | ForEach-Object {
  try {
    Set-ItemProperty -Path $_.PSPath -Name 'NameServer' -Value '' -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $_.PSPath -Name 'DhcpNameServer' -ErrorAction SilentlyContinue
  } catch {}
}
$log += "registry cleared"

# 3. Windows 11 DNS-over-HTTPS templates, which keep resolving through the old provider
#    even after the plain resolver is replaced.
$doh = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\InterfaceSpecificParameters'
if (Test-Path $doh) {
  Get-ChildItem $doh -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -eq 'DohInterfaceSettings' } |
    ForEach-Object { Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue }
  $log += "doh cleared"
}

# 4. NRPT rules can pin a resolver for specific namespaces only, which looks like DNS
#    working everywhere except a few sites.
try {
  Get-DnsClientNrptRule -ErrorAction SilentlyContinue | ForEach-Object {
    Remove-DnsClientNrptRule -Name $_.Name -Force -ErrorAction SilentlyContinue
  }
  $log += "nrpt cleared"
} catch {}

# 5. Caches.
Clear-DnsClientCache
ipconfig /flushdns | Out-Null
netsh winsock reset catalog | Out-Null
$log += "cache flushed"

${applyList ? `
# 6. Apply an explicit resolver. Leaving the machine on DHCP would hand it straight back
#    to whatever the router advertises, which is the situation that made this feature
#    necessary in the first place.
Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  try {
    Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses @(${applyList.map(s => `'${s}'`).join(',')}) -ErrorAction Stop
    $log += "applied $($_.Name)"
  } catch { $log += "apply-fail $($_.Name)" }
}
Clear-DnsClientCache` : '$log += "left on DHCP (automatic)"'}

$log -join "\`n" | Out-File "$PSCommandPath.log" -Encoding utf8`;

    const res = await runElevated(script, { timeout: 180000 });
    const after = await getStatus();

    return {
        ok: !res.elevationRefused,
        current: after.current,
        steps: (res.log || '').split('\n').map(s => s.trim()).filter(Boolean),
        message: res.elevationRefused
            ? 'برای پاک‌سازی به دسترسی مدیر نیاز است — درخواست رد شد.'
            : resetToAuto
                ? 'پاک‌سازی انجام شد. DNS روی حالت خودکار (از روتر) است.'
                : 'پاک‌سازی انجام شد و DNS جدید تنظیم شد.',
    };
}

// A backed-up adapter is addressed by NAME first, index second.
//
// InterfaceIndex is not stable: it changes when an adapter is disabled/re-enabled, when a
// virtual adapter is installed, or across some driver updates. A restore keyed on the old
// index writes to whatever adapter now holds it — or to nothing — and the `catch {}`
// swallows the failure, so the operation reports success while the real adapter keeps the
// resolver it was supposed to lose. That is how a machine ended up stuck on 127.0.0.1
// with the local resolver no longer running: no DNS at all, and a UI claiming it restored.
function restoreScriptFor(adapter) {
    const byName = adapter.name ? `Get-NetAdapter -Name '${String(adapter.name).replace(/'/g, "''")}' -ErrorAction SilentlyContinue` : null;
    const pick = byName
        ? `$a = ${byName}; if (-not $a) { $a = Get-NetAdapter -InterfaceIndex ${adapter.index} -ErrorAction SilentlyContinue }`
        : `$a = Get-NetAdapter -InterfaceIndex ${adapter.index} -ErrorAction SilentlyContinue`;
    // Snapshots record IPv4 resolvers only, so restoring the recorded list must be paired
    // with an explicit IPv6 reset. Without it, the ::1 that applyServers set stays behind:
    // the bridge that answered on it is gone, Windows still prefers the IPv6 list, and the
    // machine is left waiting out a DNS timeout on every lookup after disconnecting.
    const action = (!adapter.dns || !adapter.dns.length)
        ? `Set-DnsClientServerAddress -InterfaceIndex $a.InterfaceIndex -ResetServerAddresses -ErrorAction Stop`
        // Same -AddressFamily trap as applyServers: the cmdlet has no such parameter, so
        // this restore silently failed too — the machine kept pointing at a bridge that was
        // already gone. netsh is the only way to clear ONE family, which is what the v6
        // half needs.
        : `Set-DnsClientServerAddress -InterfaceIndex $a.InterfaceIndex -ServerAddresses @(${adapter.dns.map(s => `'${s}'`).join(',')}) -ErrorAction Stop
    netsh interface ipv6 set dnsservers name="$($a.Name)" source=dhcp | Out-Null`;
    return `${pick}\nif ($a) { try { ${action} } catch {} }`;
}

// Any adapter still pointing at the local bridge after a restore is a machine with no
// resolver. Whatever the backup said, that state must not survive this function.
// Matches the WHOLE 127.0.0.0/8 range, not just 127.0.0.1: when another DNS tool already
// owns the usual address the bridge binds 127.0.0.2 (or another loopback address) instead,
// and a sweep that only knows about 127.0.0.1 would walk straight past the adapter it was
// written to rescue.
// The IPv6 half sweeps ::1 for the same reason: the bridge now sets both families, so a
// sweep blind to IPv6 would leave the adapter preferring a resolver that no longer exists.
const SWEEP_LOOPBACK = `
Get-NetAdapter | Where-Object { $_.Status -eq 'Up' } | ForEach-Object {
  $cur = (Get-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue).ServerAddresses
  if ($cur | Where-Object { $_ -like '127.*' }) {
    try { Set-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -ServerAddresses @('1.1.1.1','1.0.0.1') -ErrorAction Stop } catch {}
  }
  $cur6 = (Get-DnsClientServerAddress -InterfaceIndex $_.InterfaceIndex -AddressFamily IPv6 -ErrorAction SilentlyContinue).ServerAddresses
  if ($cur6 | Where-Object { $_ -eq '::1' }) {
    try { netsh interface ipv6 set dnsservers name="$($_.Name)" source=dhcp | Out-Null } catch {}
  }
}`;

/** Put back whatever the machine had before this app first touched it. */
async function restoreBackup() {
    if (!fs.existsSync(BACKUP_FILE)) throw new Error('پشتیبانی ذخیره نشده است.');
    const backup = JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));

    const parts = (backup.adapters || []).map(restoreScriptFor);
    const res = await runElevated(
        `${parts.join('\n')}\n${SWEEP_LOOPBACK}\nClear-DnsClientCache\n"restored" | Out-File "$PSCommandPath.log" -Encoding utf8`
    );

    // Report what the machine actually looks like now, not what was attempted.
    const after = await getStatus();
    const stillLoopback = (after.adapters || []).some(a => (a.dns || []).some(ip => String(ip).startsWith('127.')));
    return {
        ok: !res.elevationRefused && !stillLoopback,
        stillLoopback,
        current: after.current,
        backupAt: backup.at,
    };
}

/**
 * Snapshot the CURRENT resolvers under a caller-owned file.
 *
 * saveBackup() deliberately never overwrites, because it is the record of the machine
 * before this app ever touched it — on this machine that record was nine days old and
 * still named an adapter index that no longer existed. The dedicated-DNS bridge needs
 * something different: what the user had thirty seconds ago, so switching the feature off
 * puts back exactly that.
 */
function snapshotCurrent(file) {
    return getStatus().then((status) => {
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            const adapters = (status.adapters || [])
                // An adapter already pointing at any loopback resolver would restore the
                // machine into the very state this snapshot exists to escape.
                .map(a => ({ name: a.name, index: a.index, dns: (a.dns || []).filter(ip => !String(ip).startsWith('127.')) }));
            fs.writeFileSync(file, JSON.stringify({ at: Date.now(), adapters }, null, 2), 'utf8');
            return adapters;
        } catch (e) {
            return null;
        }
    });
}

/** Restore a snapshot written by snapshotCurrent(), then sweep any leftover loopback. */
async function restoreSnapshot(file) {
    let parts = [];
    try {
        const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
        parts = (snap.adapters || []).map(restoreScriptFor);
    } catch (e) { /* no snapshot: the sweep below still rescues the machine */ }

    const res = await runElevated(`${parts.join('\n')}\n${SWEEP_LOOPBACK}\nClear-DnsClientCache\n"restored" | Out-File "$PSCommandPath.log" -Encoding utf8`);
    const after = await getStatus();
    const stillLoopback = (after.adapters || []).some(a => (a.dns || []).some(ip => String(ip).startsWith('127.')));
    return { ok: !res.elevationRefused && !stillLoopback, stillLoopback, current: after.current };
}

/**
 * Synchronous restore, for `before-quit`.
 *
 * The dedicated-DNS bridge points every adapter at 127.0.0.1. If the app exits while that
 * is in place, the listener dies with us and the machine is left with a resolver that
 * answers nothing — no internet, and no running application to undo it. `before-quit` does
 * not await promises, so the async path above would be cut off mid-flight; this one blocks.
 * Best effort by design: a refused UAC prompt must not stop the app from quitting.
 */
function restoreBackupSync({ timeout = 25000, snapshotFile = null, sweepOnly = false } = {}) {
    try {
        const { execFileSync } = require('child_process');
        let parts = [];
        // `sweepOnly` means "free the machine, restore nothing".
        //
        // The BACKUP_FILE fallback is a trap and it fired in the field: that file records what
        // the machine looked like the FIRST time this app ever ran, which on a real install was
        // 26 days stale and named Shecan Pro. Reinstating it on every startup recovery meant the
        // app kept putting back a filtering resolver the user had deliberately left. When there
        // is no fresh, caller-owned snapshot, sweeping loopback addresses off the adapters is
        // the whole job — anything more is guessing with someone else's network settings.
        const source = sweepOnly ? null
            : (snapshotFile && fs.existsSync(snapshotFile) ? snapshotFile
            : (fs.existsSync(BACKUP_FILE) ? BACKUP_FILE : null));
        if (source) {
            try {
                const backup = JSON.parse(fs.readFileSync(source, 'utf8'));
                // Defence in depth against the stale-record trap, for every caller rather than
                // just the ones that remembered to pass sweepOnly. A resolver list recorded
                // weeks ago is not "what the user has", it is archaeology — and writing it back
                // onto live adapters is how this app kept resurrecting a Shecan configuration
                // the user had abandoned. Old record, no restore; the sweep still runs.
                const MAX_AGE_MS = 24 * 60 * 60 * 1000;
                if (backup.at && Date.now() - backup.at > MAX_AGE_MS) parts = [];
                else parts = (backup.adapters || []).map(restoreScriptFor);
            } catch (e) { /* the sweep below still rescues the machine */ }
        }

        const file = path.join(os.tmpdir(), `mlm-dns-restore-${Date.now()}-${process.pid}.ps1`);
        // The loopback sweep runs unconditionally, backup or not: leaving the machine on a
        // 127.0.0.1 resolver that dies with this process is the one outcome that must be
        // impossible, and it is exactly what a missing or stale backup used to produce.
        fs.writeFileSync(file, `$ErrorActionPreference='Continue'\n${parts.join('\n')}\n${SWEEP_LOOPBACK}\nClear-DnsClientCache\n`, 'utf8');

        // Already elevated (the packaged app always is): run it directly. The nested
        // `Start-Process -Verb RunAs -Wait` this used to always do costs seconds, and this
        // function is called from exit handlers where seconds are exactly what we do not
        // have — the process can be gone before the elevated child has done anything.
        if (isElevated()) {
            execFileSync('powershell', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-WindowStyle', 'Hidden', '-File', file,
            ], { timeout, windowsHide: true, stdio: 'ignore' });
        } else {
            execFileSync('powershell', [
                '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command',
                `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
                `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${file}'`,
            ], { timeout, windowsHide: true, stdio: 'ignore' });
        }
        try { fs.unlinkSync(file); } catch (e) {}
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Is any adapter currently pointing at a resolver that only exists while we do?
 *
 * Used by the startup recovery path: a previous run that was killed (Task Manager, crash,
 * power loss) leaves the machine on 127.x / ::1 with nothing listening, which is a PC that
 * resolves nothing at all and gives its owner no clue why. Reinstalling does not fix it.
 *
 * ── ONE CIM CALL, NOT N+1 ────────────────────────────────────────────────────────────────
 * This used to enumerate adapters and then ask each one for its resolvers, which is one CIM
 * round trip per adapter. Measured here, on a laptop with a SINGLE adapter up: 2167 ms.
 * `Get-DnsClientServerAddress` with no `-InterfaceIndex` already returns every interface in
 * one call — 757 ms for all sixteen — and the cost no longer grows with the machine. That
 * matters because the machines that have ten or twenty adapters (Hyper-V, WSL, Docker,
 * VMware, Bluetooth PAN, other VPNs) are exactly the "powerful" ones this was slowest on.
 */
const STRANDED_PS = "$a=@(Get-DnsClientServerAddress -ErrorAction SilentlyContinue |"
    + " Where-Object { $_.ServerAddresses -and (@($_.ServerAddresses) |"
    + " Where-Object { $_ -like '127.*' -or $_ -eq '::1' }).Count -gt 0 }); ($a.Count -gt 0)";

/**
 * The same question, asynchronously — which is how the startup path must ask it.
 *
 * The sync version below blocks Electron's MAIN process, and the startup recovery runs
 * BEFORE the window is created: every launch paid the full cost with nothing on screen, and
 * on a machine with many adapters it approached the 20-second timeout. That is the «برنامه
 * باز نمی‌شود / سیستم هنگ می‌کند» report. See [[main-process-blocking]] — server.js lives in
 * the main thread, so a synchronous spawn here is a frozen application.
 */
function hasStrandedLoopbackDns({ timeout = 20000 } = {}) {
    return new Promise((resolve) => {
        try {
            const { execFile } = require('child_process');
            execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', STRANDED_PS],
                { timeout, windowsHide: true, encoding: 'utf8' },
                (err, out) => resolve(!err && /true/i.test(String(out))));
        } catch (e) { resolve(false); }
    });
}

/**
 * The blocking form. Kept for the teardown paths only — `before-quit` and `bailSync()` do not
 * await, and there a synchronous call is the correct tool. Never call it on a start-up path.
 */
function hasStrandedLoopbackDnsSync({ timeout = 20000 } = {}) {
    try {
        const { execFileSync } = require('child_process');
        const out = execFileSync('powershell', [
            '-NoProfile', '-NonInteractive', '-Command', STRANDED_PS,
        ], { timeout, windowsHide: true, encoding: 'utf8' });
        return /true/i.test(String(out));
    } catch (e) {
        return false;
    }
}

module.exports = {
    PROVIDERS,
    getStatus,
    getAdapters,
    diagnose,
    clearSource,
    identify,
    pingProvider,
    pingAll,
    applyProvider,
    applyServers,
    deepClean,
    restoreBackup,
    restoreBackupSync,
    hasStrandedLoopbackDns,
    hasStrandedLoopbackDnsSync,
    isElevated,
    snapshotCurrent,
    restoreSnapshot,
    saveBackup,
    DATA_DIR,
    BACKUP_FILE,
};
