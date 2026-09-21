'use strict';

/**
 * --- Watching the line WHILE the game is running ---
 *
 * THE QUESTION THIS ANSWERS, AND WHY NOTHING ELSE IN THIS FEATURE COULD
 *
 * Every other lever here acts BEFORE a match: measure, free the line, pick a route, cap the queue.
 * Then the player goes and plays, and twenty minutes later says «وسط بازی لگ خوردم» — and the panel
 * has nothing. It measured a minute that has passed and cannot say a word about the minute that
 * mattered.
 *
 * This samples continuously while the game is up and, afterwards, names what each spike coincided
 * with. Not "your ping was bad" — the player already knows that — but *which of the things that can
 * cause it actually moved at that second*.
 *
 * WHAT IS SAMPLED, AND WHY EACH ONE
 *
 * A tick carries only things a spike can be BLAMED on, because a number nobody can act on is
 * decoration:
 *
 *   latency/loss   a short STUN train from this process. ~10 packets, about a kilobyte — the
 *                  measurement must not become the problem.
 *   rx/tx          the user's own traffic. The most common cause by far, and the only one they
 *                  can fix in the moment.
 *   wifi rate      on Wi-Fi this is the largest jitter source there is and it moves in seconds.
 *                  A rate that falls from 150 to 6 Mbit/s explains a spike completely, and no
 *                  amount of routing will.
 *   cpu            a frame-time stall and a network stall feel identical to a player. If the CPU
 *                  was pinned, the answer is not the network and saying so saves them an evening.
 *
 * ONE PROCESS, NOT ONE PER SAMPLE
 *
 * A session is an hour; a sample every five seconds is 720 of them. Spawning PowerShell each time
 * would cost more CPU than the booster just freed — so a single long-lived process emits one JSON
 * line per tick and this module reads its stdout. That is the same shape every engine here uses,
 * and it is the rule this project already has about repeating paths (see the V2Ray disconnect
 * freeze: nothing synchronous or expensive on anything that repeats).
 *
 * WHAT IT DOES NOT DO
 *
 * It does not change anything. Not one setting, not one rule — it only looks. A diagnosis that
 * also acts is a diagnosis nobody can trust, because you can no longer tell which of the two you
 * are looking at.
 */

const path = require('path');
const { spawn } = require('child_process');
const probe = require('./probe');
const catalog = require('./catalog');

/** How often a sample is taken. Five seconds is frequent enough to catch a spike and cheap. */
const TICK_MS = 5000;

/**
 * Samples kept. At five seconds a tick this is about three hours — longer than any session, and
 * bounded so a window left open overnight cannot grow without limit.
 */
const MAX_SAMPLES = 2200;

/** A tick's latency train: short on purpose. Ten packets is a kilobyte of STUN. */
const TRAIN = { pps: 10, seconds: 1, warmupMs: 0 };

const state = {
    running: false,
    startedAt: null,
    gameId: null,
    gameFa: null,
    samples: [],
    anchor: null,
    error: null,
};

let proc = null;
let timer = null;
let onEvent = () => { };

// ── spike detection ─────────────────────────────────────────────────────────────────────────
//
// A spike is relative to THIS session, not to an absolute number. A player on a 300ms line has a
// perfectly good game at 300ms and a terrible one at 900; a player at 40ms has the same experience
// at 40 and 120. An absolute threshold would report one of them constantly and the other never.

/** Median — used rather than the mean because one 2000ms tick would drag a mean anywhere. */
function median(values) {
    const v = values.filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Which samples are spikes, given the session they belong to.
 *
 * Two independent ways to be one, because they are different failures: latency that climbed, and
 * packets that vanished. A tick can have either without the other — a Wi-Fi rate collapse usually
 * shows as loss first.
 */
function findSpikes(samples, { minSamples = 6 } = {}) {
    const usable = samples.filter(s => s && s.ok);
    if (usable.length < minSamples) return [];

    const base = median(usable.map(s => s.p50));
    const baseLoss = median(usable.map(s => s.loss)) || 0;
    if (base === null) return [];

    // Both a ratio AND a floor. A ratio alone makes a 12ms line report a spike at 25ms, which is
    // true and useless; a floor alone never fires on a slow line that got twice as slow.
    const latencyLimit = Math.max(base * 2, base + 60);
    const lossLimit = Math.max(baseLoss + 5, 8);

    return usable
        .filter(s => s.p95 > latencyLimit || s.loss > lossLimit)
        .map(s => ({ ...s, base: Math.round(base), why: s.loss > lossLimit ? 'loss' : 'latency' }));
}

/**
 * What moved at the same moment as this spike.
 *
 * The point of the whole module. Each candidate cause is compared to its own session median, and
 * only a real deviation is named — a list of everything that was happening would be as useless as
 * nothing at all.
 *
 * Ordered by how actionable it is: a user can pause a download in a second, move closer to the
 * router in a minute, and can do nothing at all about an international route.
 */
function blameFor(spike, samples) {
    const usable = samples.filter(s => s && s.ok);
    const out = [];

    const txBase = median(usable.map(s => s.txKbps)) || 0;
    const rxBase = median(usable.map(s => s.rxKbps)) || 0;
    const rateBase = median(usable.map(s => s.wifiRate).filter(x => x != null));
    const cpuBase = median(usable.map(s => s.cpu).filter(x => x != null));

    // Upload first: it is the one that fills the modem's queue, and the queue is the thing that
    // turns a 126ms line into a 2681ms one. Measured — see the modem-queue card.
    if (spike.txKbps > Math.max(txBase * 3, txBase + 500) && spike.txKbps > 500) {
        out.push({ kind: 'upload', fa: `آپلود شما در همان لحظه ${Math.round(spike.txKbps)} کیلوبیت بر ثانیه بود`, actionable: true });
    }
    if (spike.rxKbps > Math.max(rxBase * 3, rxBase + 2000) && spike.rxKbps > 2000) {
        out.push({ kind: 'download', fa: `دانلود شما در همان لحظه ${Math.round(spike.rxKbps / 1000)} مگابیت بر ثانیه بود`, actionable: true });
    }
    if (rateBase != null && spike.wifiRate != null && spike.wifiRate < rateBase * 0.6) {
        out.push({ kind: 'wifi', fa: `نرخ وای‌فای از ${Math.round(rateBase)} به ${Math.round(spike.wifiRate)} مگابیت افتاد`, actionable: true });
    }
    if (spike.wifiSignal != null && spike.wifiSignal < 45) {
        out.push({ kind: 'signal', fa: `سیگنال وای‌فای ${spike.wifiSignal}٪ بود`, actionable: true });
    }
    if (cpuBase != null && spike.cpu != null && spike.cpu > 90 && spike.cpu > cpuBase + 25) {
        out.push({ kind: 'cpu', fa: `پردازنده ${spike.cpu}٪ مشغول بود — این لگِ تصویر است، نه شبکه`, actionable: true });
    }

    // NOTHING MOVED ON THIS MACHINE. That is a finding, not a gap: it means the spike came from
    // outside, and the user can stop looking for something to switch off.
    if (!out.length) {
        out.push({
            kind: 'upstream',
            fa: 'هیچ‌چیز روی این دستگاه تغییر نکرده بود — این پرش از مسیر بیرونی آمده، نه از کاری که شما کردید',
            actionable: false,
        });
    }
    return out;
}

// ── the session ─────────────────────────────────────────────────────────────────────────────

function samplerScript() {
    // Written as an argument rather than a file so nothing has to ship or be found at runtime.
    return `
$ErrorActionPreference='SilentlyContinue'
$adapter = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
if (-not $adapter) { Write-Output '{"error":"no adapter"}'; exit }
$prev = Get-NetAdapterStatistics -Name $adapter.Name
$prevAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$isWifi = $adapter.InterfaceDescription -match 'wireless|wi-?fi|802\\.11'
while ($true) {
  Start-Sleep -Milliseconds ${TICK_MS}
  $now = Get-NetAdapterStatistics -Name $adapter.Name
  $at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $span = [Math]::Max(1, $at - $prevAt)
  $rx = [math]::Round(($now.ReceivedBytes - $prev.ReceivedBytes) * 8000 / $span / 1000)
  $tx = [math]::Round(($now.SentBytes - $prev.SentBytes) * 8000 / $span / 1000)
  $prev = $now; $prevAt = $at
  $rate = $null; $signal = $null; $channel = $null
  if ($isWifi) {
    $w = netsh wlan show interfaces 2>$null
    foreach ($line in $w) {
      if ($line -match 'Receive rate \\(Mbps\\)\\s*:\\s*([\\d.]+)') { $rate = [double]$Matches[1] }
      elseif ($line -match 'Signal\\s*:\\s*(\\d+)%') { $signal = [int]$Matches[1] }
      elseif ($line -match 'Channel\\s*:\\s*(\\d+)') { $channel = [int]$Matches[1] }
    }
  }
  $cpu = $null
  try { $cpu = [math]::Round((Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime) } catch { }
  [PSCustomObject]@{ at=$at; rxKbps=$rx; txKbps=$tx; wifiRate=$rate; wifiSignal=$signal; wifiChannel=$channel; cpu=$cpu } | ConvertTo-Json -Compress
}`;
}

async function start({ game = null, emit = () => { } } = {}) {
    if (state.running) return { ok: true, already: true };

    const anchor = catalog.UDP_ANCHORS[0];
    let ip;
    try { ip = await probe.resolve4(anchor.host); }
    catch (e) { throw new Error('لنگر سنجش در دسترس نیست: ' + e.message); }

    onEvent = emit;
    state.running = true;
    state.startedAt = Date.now();
    state.gameId = game ? game.id : null;
    state.gameFa = game ? game.fa : null;
    state.samples = [];
    state.anchor = { host: anchor.host, ip, port: anchor.port };
    state.error = null;

    proc = spawn('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', samplerScript()],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    let buf = '';
    proc.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let row;
            try { row = JSON.parse(line); } catch { continue; }
            if (row.error) { state.error = row.error; continue; }
            onTick(row);
        }
    });
    proc.on('exit', () => { if (state.running) state.error = 'نمونه‌گیر بسته شد'; });

    return { ok: true };
}

/**
 * A tick arrived from the sampler; add the latency half.
 *
 * The train runs here rather than inside the PowerShell because it is a socket, not a shell
 * command — and doing it in Node keeps it to one kilobyte and no process at all.
 */
let probing = false;
async function onTick(row) {
    if (!state.running || probing) return;
    probing = true;
    let train = null;
    try {
        train = await probe.udpTrain({
            host: state.anchor.host, ip: state.anchor.ip, port: state.anchor.port,
            proto: 'stun', ...TRAIN,
        });
    } catch { train = null; }
    probing = false;
    if (!state.running) return;

    const s = {
        at: row.at || Date.now(),
        ok: !!(train && train.ok),
        p50: train && train.ok ? Math.round(train.p50) : null,
        p95: train && train.ok ? Math.round(train.p95) : null,
        loss: train && train.ok ? Number(train.loss) : 100,
        rxKbps: Number(row.rxKbps) || 0,
        txKbps: Number(row.txKbps) || 0,
        wifiRate: row.wifiRate == null ? null : Number(row.wifiRate),
        wifiSignal: row.wifiSignal == null ? null : Number(row.wifiSignal),
        cpu: row.cpu == null ? null : Number(row.cpu),
    };
    state.samples.push(s);
    if (state.samples.length > MAX_SAMPLES) state.samples.shift();
    try { onEvent({ type: 'sample', sample: s }); } catch { /* nobody listening */ }
}

function stop() {
    const was = state.running;
    state.running = false;
    if (proc) { try { proc.kill(); } catch { } proc = null; }
    if (timer) { clearInterval(timer); timer = null; }
    return was;
}

function status() {
    return {
        running: state.running,
        startedAt: state.startedAt,
        gameId: state.gameId, gameFa: state.gameFa,
        samples: state.samples.length,
        error: state.error,
    };
}

/**
 * The session, in the form a player can act on.
 *
 * Deliberately not a chart with a shrug attached. Every spike is named with a time and a cause,
 * and when the cause is "nothing here", it says that too — a player who knows the problem is
 * upstream can stop turning things off in the hope that one of them was it.
 */
function report() {
    const samples = state.samples.slice();
    const usable = samples.filter(s => s && s.ok);
    if (usable.length < 6) {
        return {
            ok: false,
            reason: `هنوز ${usable.length} نمونه گرفته شده — برای حکم دادن کم است. چند دقیقه بازی کنید.`,
            samples: samples.length,
        };
    }

    const spikes = findSpikes(samples).map(s => ({ ...s, blame: blameFor(s, samples) }));
    const base = median(usable.map(s => s.p50));
    const worst = usable.reduce((a, b) => (b.p95 > a.p95 ? b : a), usable[0]);

    // Which cause appeared most. That is the sentence worth putting first.
    const counts = new Map();
    for (const sp of spikes) for (const b of sp.blame) counts.set(b.kind, (counts.get(b.kind) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || null;

    const minutes = Math.max(1, Math.round((Date.now() - (state.startedAt || Date.now())) / 60000));
    let headline;
    if (!spikes.length) {
        headline = `${minutes} دقیقه پایش شد و هیچ پرشی پیدا نشد — پایهٔ خط ${Math.round(base)} میلی‌ثانیه بود و همان‌جا ماند.`;
    } else if (top && top[0] === 'upstream') {
        headline = `${spikes.length} پرش در ${minutes} دقیقه، و هیچ‌کدام از این دستگاه نبود — مسیر بیرونی مقصر است، نه چیزی که اینجا قابل عوض کردن باشد.`;
    } else {
        const name = { upload: 'آپلود خودتان', download: 'دانلود خودتان', wifi: 'افت نرخ وای‌فای', signal: 'ضعف سیگنال وای‌فای', cpu: 'پر شدن پردازنده' }[top && top[0]] || 'چند عامل';
        headline = `${spikes.length} پرش در ${minutes} دقیقه، و بیشترشان با ${name} هم‌زمان بود.`;
    }

    return {
        ok: true,
        headline,
        minutes,
        baseP50: Math.round(base),
        worstP95: Math.round(worst.p95),
        samples: samples.length,
        spikes: spikes.map(s => ({
            at: s.at, p50: s.p50, p95: s.p95, loss: Math.round(s.loss), why: s.why,
            blame: s.blame,
        })),
        series: samples.map(s => ({ at: s.at, p50: s.p50, p95: s.p95, loss: s.loss, tx: s.txKbps, rx: s.rxKbps })),
    };
}

module.exports = {
    start, stop, status, report,
    // Exported for the suite: these two are the whole judgement, and they are pure.
    findSpikes, blameFor, median,
    TICK_MS,
};
