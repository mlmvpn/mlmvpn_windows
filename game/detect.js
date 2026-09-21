// --- What is running right now, and who is it talking to ---
//
// Two jobs that look like one and are not.
//
// RUNNING GAMES is cheap and exact: `tasklist` gives every process name, the catalogue
// maps names to games. This is what makes the panel feel alive — the user launches GTA and
// the panel already knows.
//
// LIVE DESTINATIONS is where Windows fights back, and the limit is worth stating plainly
// because it shapes the whole feature:
//
//   TCP  Get-NetTCPConnection returns RemoteAddress + RemotePort + OwningProcess. Exact.
//        For GTA Online this yields the Rockstar service endpoints, which is enough to
//        identify the region the session was matched into.
//   UDP  Get-NetUDPEndpoint returns ONLY the local address, port and PID. There is no
//        remote column, because a UDP socket has no connection to report. Verified on this
//        machine 2026-08-19. So the peer a game is exchanging packets with cannot be read
//        from any ordinary Windows API.
//
// That is not a defect to work around with a worse API — it is a property of UDP. The
// honest paths to a UDP peer are ETW's kernel network provider, or watching the traffic
// from inside our own TUN once it is up. Until either exists, a UDP game's destination is
// INFERRED from its TCP service connections and its region anchors, and everything built
// on top says "inferred" rather than pretending.

'use strict';

const { execFile } = require('child_process');
const catalog = require('./catalog');

function run(cmd, args, timeoutMs = 8000) {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            (err, stdout) => resolve(stdout || ''));
    });
}

/** Every running process as { name, pid }. tasklist is ~40ms; Get-Process is ~400ms. */
async function processes() {
    const out = await run('tasklist', ['/fo', 'csv', '/nh']);
    const list = [];
    for (const line of out.split(/\r?\n/)) {
        if (!line.trim()) continue;
        // "name.exe","1234","Console","1","12,345 K"
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (m) list.push({ name: m[1], pid: Number(m[2]) });
    }
    return list;
}

/**
 * Games running right now.
 *
 * A game can appear under several PIDs (launcher + game); they are grouped so the UI shows
 * one row per game with every PID that belongs to it.
 */
async function runningGames() {
    const procs = await processes();
    const byGame = new Map();
    for (const p of procs) {
        const g = catalog.byProcess(p.name);
        if (!g) continue;
        if (!byGame.has(g.id)) byGame.set(g.id, { id: g.id, fa: g.fa, en: g.en, klass: g.klass, probe: g.probe, regions: g.regions, pids: [], procs: [] });
        const rec = byGame.get(g.id);
        rec.pids.push(p.pid);
        if (!rec.procs.includes(p.name)) rec.procs.push(p.name);
    }
    return [...byGame.values()];
}

/** True if any process with one of these names is up. Used by the background-hog check. */
async function anyRunning(names) {
    const set = new Set(names.map(n => n.toLowerCase()));
    const procs = await processes();
    return procs.filter(p => set.has(p.name.toLowerCase()));
}

const CONN_PS = String.raw`
$ErrorActionPreference='SilentlyContinue'
$pids = @(PIDS_HERE)
$tcp = Get-NetTCPConnection -State Established |
  Where-Object { $pids -contains $_.OwningProcess } |
  Select-Object RemoteAddress, RemotePort, OwningProcess
$udp = Get-NetUDPEndpoint |
  Where-Object { $pids -contains $_.OwningProcess -and $_.LocalPort -gt 1024 } |
  Select-Object LocalAddress, LocalPort, OwningProcess
[pscustomobject]@{ tcp=@($tcp); udp=@($udp) } | ConvertTo-Json -Depth 4 -Compress
`;

const PRIVATE_RE = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0|::|fe80:)/i;

/**
 * Live endpoints for a set of PIDs.
 *
 * Returns { tcp: [{ip, port, pid}], udpLocalPorts: [...], note }. Loopback and LAN are
 * dropped: a game's connection to its own launcher says nothing about the path to its
 * servers, and leaving them in makes the "destination" list look busy and useless.
 */
async function endpointsFor(pids) {
    if (!pids || !pids.length) return { tcp: [], udpLocalPorts: [], note: null };
    const script = CONN_PS.replace('PIDS_HERE', pids.map(Number).filter(Boolean).join(','));
    const out = await run('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 12000);
    let j;
    try { j = JSON.parse(out.trim()); } catch { return { tcp: [], udpLocalPorts: [], note: 'خواندن اتصال‌ها ناموفق بود' }; }

    const tcpArr = Array.isArray(j.tcp) ? j.tcp : (j.tcp ? [j.tcp] : []);
    const udpArr = Array.isArray(j.udp) ? j.udp : (j.udp ? [j.udp] : []);

    const seen = new Set();
    const tcp = [];
    for (const c of tcpArr) {
        const ip = String(c.RemoteAddress || '');
        if (!ip || PRIVATE_RE.test(ip) || ip.includes(':')) continue;   // v4 public only
        const key = ip + ':' + c.RemotePort;
        if (seen.has(key)) continue;
        seen.add(key);
        tcp.push({ ip, port: Number(c.RemotePort), pid: Number(c.OwningProcess) });
    }
    const udpLocalPorts = [...new Set(udpArr.map(u => Number(u.LocalPort)).filter(Boolean))].sort((a, b) => a - b);

    return {
        tcp,
        udpLocalPorts,
        // Said once, here, so every consumer carries the same caveat.
        note: udpLocalPorts.length
            ? 'پورت‌های UDP بازی شناسایی شد، ولی ویندوز طرف مقابل یک سوکت UDP را گزارش نمی‌کند — مقصد بازی از روی اتصال‌های TCP و لنگرهای منطقه استنتاج می‌شود.'
            : null,
    };
}

module.exports = { processes, runningGames, anyRunning, endpointsFor };
