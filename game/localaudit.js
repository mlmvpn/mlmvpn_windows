// --- The local-line audit ---
//
// WHY THIS EXISTS BEFORE ANY TUNNEL
// The measurements behind this feature kept pointing at the same thing: for a large share
// of players the dominant term is not the route to Frankfurt, it is the last three metres.
// A saturated uplink turns a 90ms line into a 900ms one; Wi-Fi power saving injects tens of
// milliseconds of jitter; a background download does both. None of that is fixed by a
// tunnel, and a "game accelerator" that switches a tunnel on while the real cause sits in
// the room is selling a placebo.
//
// So this module answers, in order: is the problem in this house? Every check below is
// free, works for 100% of users, needs no server, and cannot be filtered.
//
// EVERY CHECK RETURNS A VERDICT, NEVER A GUESS
//   'ok'      measured, and fine
//   'warn'    measured, and worth acting on
//   'bad'     measured, and the likely dominant cause
//   'unknown' could not be measured — said plainly, never dressed up as 'ok'
//
// The last one matters. The MTU ladder is ICMP-based and ICMP is widely dropped, so an
// all-failed ladder means "we learned nothing", not "your MTU is broken". netdiag already
// learned that lesson the hard way; this file inherits it rather than repeating it.

'use strict';

const { execFile } = require('child_process');
const probe = require('./probe');
const detect = require('./detect');
const { UDP_ANCHORS } = require('./catalog');
const nat = require('./nat');

function ps(script, timeoutMs = 15000) {
    return new Promise(resolve => {
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            (err, stdout) => {
                if (!stdout) return resolve(null);
                try { resolve(JSON.parse(stdout.trim())); } catch { resolve(null); }
            });
    });
}

const ADAPTER_PS = String.raw`
$ErrorActionPreference='SilentlyContinue'
$a = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
$mm = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Multimedia\SystemProfile'
$pw = $null
if ($a) { $pw = (Get-NetAdapterPowerManagement -Name $a.Name).AllowComputerToTurnOffDevice }
$ip = Get-NetIPConfiguration -InterfaceIndex $a.ifIndex
[pscustomobject]@{
  name        = $a.Name
  desc        = $a.InterfaceDescription
  media       = $a.MediaType
  linkSpeed   = $a.LinkSpeed
  mtu         = (Get-NetIPInterface -InterfaceIndex $a.ifIndex -AddressFamily IPv4).NlMtu
  ifIndex     = $a.ifIndex
  gateway     = $ip.IPv4DefaultGateway.NextHop
  dns         = @($ip.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses })
  throttling  = $mm.NetworkThrottlingIndex
  responsive  = $mm.SystemResponsiveness
  powerSave   = "$pw"
} | ConvertTo-Json -Depth 4 -Compress
`;

/**
 * Processes that routinely eat an Iranian uplink while a game is running.
 *
 * Detection is by name, not by measured throughput: per-process network counters on
 * Windows need ETW or perf counters that report disk I/O in the same number, and a wrong
 * accusation ("Steam is using your bandwidth" when it is idle) is worse than none. So this
 * reports PRESENCE — "these are running and are known to download in the background" —
 * and lets the bufferbloat test decide whether the line is actually loaded.
 */
const HOGS = [
    { procs: ['steam.exe', 'steamwebhelper.exe'], fa: 'Steam', hint: 'دانلود و آپدیت خودکار بازی‌ها' },
    { procs: ['EpicGamesLauncher.exe'], fa: 'Epic Games', hint: 'دانلود و آپدیت' },
    { procs: ['Battle.net.exe', 'Agent.exe'], fa: 'Battle.net', hint: 'دانلود و آپدیت' },
    { procs: ['upc.exe', 'UbisoftConnect.exe'], fa: 'Ubisoft Connect', hint: 'دانلود و آپدیت' },
    { procs: ['EADesktop.exe', 'EABackgroundService.exe'], fa: 'EA App', hint: 'دانلود و آپدیت' },
    { procs: ['OneDrive.exe'], fa: 'OneDrive', hint: 'همگام‌سازی فایل' },
    { procs: ['Dropbox.exe'], fa: 'Dropbox', hint: 'همگام‌سازی فایل' },
    { procs: ['qbittorrent.exe', 'utorrent.exe', 'BitComet.exe', 'transmission-qt.exe'], fa: 'تورنت', hint: 'آپلود تورنت گلوگاه آپلود را پر می‌کند و بدترین دشمن پینگ است' },
    { procs: ['IDMan.exe'], fa: 'Internet Download Manager', hint: 'دانلود فعال' },
    { procs: ['Telegram.exe', 'Discord.exe'], fa: 'تلگرام / دیسکورد', hint: 'دانلود رسانه در پس‌زمینه' },
    { procs: ['MsMpEng.exe'], fa: 'Windows Defender', hint: 'اسکن — CPU، نه پهنای باند', cpuOnly: true },
];

async function adapter() {
    const a = await ps(ADAPTER_PS);
    if (!a || !a.name) {
        return { id: 'adapter', fa: 'کارت شبکه', verdict: 'unknown', detail: 'اطلاعات آداپتر خوانده نشد', data: null };
    }
    const isWifi = /802\.11|wireless|wi-?fi/i.test(`${a.media} ${a.desc}`);
    const speedMbps = (() => {
        const m = String(a.linkSpeed || '').match(/([\d.]+)\s*(G|M|K)?bps/i);
        if (!m) return null;
        const n = parseFloat(m[1]);
        return m[2] === 'G' ? n * 1000 : m[2] === 'K' ? n / 1000 : n;
    })();

    const findings = [];
    let verdict = 'ok';
    let band = null;
    if (isWifi) {
        verdict = 'warn';
        findings.push('اتصال بی‌سیم است. Wi-Fi حتی وقتی سرعتش کافی است، چند میلی‌ثانیه jitter تولید می‌کند که هیچ تونلی آن را درست نمی‌کند.');

        // WHICH BAND, and — more importantly — whether the other one is even possible.
        //
        // «برو روی ۵ گیگاهرتز» is the standard advice and it is wrong on hardware that cannot do
        // it. This machine's dongle declares IEEE 802.11b/g/n: no 'a', so 2.4 GHz only, so there
        // is nothing to switch to and saying otherwise sends the user hunting through a driver
        // dialog for a setting that is not there.
        band = await wifiBand();
        if (band) {
            if (band.ghz === 2.4 && band.canDo5) {
                verdict = 'bad';
                findings.push(`روی باند ۲.۴ گیگاهرتز هستید (کانال ${band.channel}) ولی کارت شما ۵ گیگاهرتز هم دارد. باند ۲.۴ با مایکروویو، مانیتور بی‌سیم و وای‌فای همهٔ همسایه‌ها مشترک است — روی ۵ گیگاهرتز، jitter معمولاً چند برابر کمتر می‌شود. در تنظیمات مودم، شبکهٔ ۵ گیگاهرتز را جدا کنید و به آن وصل شوید.`);
            } else if (band.ghz === 2.4) {
                findings.push(`روی باند ۲.۴ گیگاهرتز هستید (کانال ${band.channel})، و این کارت شبکه فقط همین را دارد — ${band.mode}. یعنی سقف این سخت‌افزار همین است؛ بهبود بعدی یک دانگل دوباندی یا کابل شبکه است، نه یک تنظیم.`);
            } else if (band.ghz === 5) {
                findings.push(`روی باند ۵ گیگاهرتز هستید (کانال ${band.channel}) — همان چیزی که برای بازی درست است.`);
            }
        }
        if (speedMbps && speedMbps < 150) {
            findings.push(`نرخ لینک ${a.linkSpeed} است — یعنی 802.11n یا ضعیف‌تر. کابل شبکه بزرگ‌ترین بهبود ممکن برای این سیستم است.`);
        }
        if (String(a.powerSave).toLowerCase() === 'true') {
            verdict = 'bad';
            findings.push('«اجازه به ویندوز برای خاموش کردن این دستگاه جهت صرفه‌جویی در انرژی» روشن است. این تنظیم روی کارت بی‌سیم مستقیماً پرش پینگ می‌سازد.');
        }
    }
    if (a.mtu && a.mtu !== 1500) findings.push(`MTU آداپتر ${a.mtu} است (پیش‌فرض ۱۵۰۰).`);

    return {
        id: 'adapter', fa: 'کارت شبکه و آخرین متر', verdict,
        detail: `${a.desc} — ${a.linkSpeed}${isWifi ? ' · بی‌سیم' : ' · کابلی'}`,
        findings,
        data: { ...a, isWifi, speedMbps, band },
    };
}

/**
 * Which Wi-Fi band, and whether the adapter is even capable of the other one.
 *
 * Channel number decides the band without ambiguity: 1-14 is 2.4 GHz, 32 and above is 5 GHz.
 * Capability comes from the driver's own declared `WirelessMode` — an 'a' or 'ac' or 'ax' in it
 * means 5 GHz exists on this hardware, and its absence means it does not.
 */
async function wifiBand() {
    // `String.raw`, like ADAPTER_PS above — a plain template literal drops unknown escapes,
    // so `\s` and `\d` reached PowerShell as `s` and `d` and the pattern matched nothing.
    const r = await ps(String.raw`
$ErrorActionPreference='SilentlyContinue'
$ch = $null
foreach ($line in (netsh wlan show interfaces)) {
  if ($line -match 'Channel\s*:\s*(\d+)') { $ch = [int]$Matches[1] }
}
$a = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
$mode = $null
if ($a) {
  $p = Get-NetAdapterAdvancedProperty -Name $a.Name -RegistryKeyword 'WirelessMode' -EA SilentlyContinue
  if ($p) { $mode = "$($p.DisplayValue)" }
}
[pscustomobject]@{ channel = $ch; mode = $mode } | ConvertTo-Json -Compress`);
    if (!r || r.channel == null) return null;
    return classifyBand(Number(r.channel), String(r.mode || ''));
}

/**
 * Channel and declared mode → which band, and whether the other one exists on this hardware.
 *
 * Pure, and separated out because it decides what the user is TOLD. Getting it wrong means
 * advising somebody to move to a band their adapter does not have, which sends them hunting
 * through a driver dialog for a setting that is not there.
 *
 * Channel is unambiguous: 1-14 is 2.4 GHz, 32 and above is 5 GHz. Capability comes from the
 * driver's declared mode — 802.11a, ac and ax all imply 5 GHz; 'n' alone does NOT, because n
 * exists on both bands. That distinction is the whole point: this machine declares
 * `IEEE 802.11b/g/n` and is 2.4-only, and a rule that treated 'n' as 5 GHz-capable would have
 * told its owner to switch to a band the dongle does not have.
 */
function classifyBand(channel, mode) {
    const ch = Number(channel);
    if (!isFinite(ch) || ch <= 0) return null;
    const m = String(mode || '');
    // `802.11` is replaced by a space FIRST, then the letters are looked for as standalone tokens.
    // A word-boundary test cannot work here: in "802.11ax" the `1` and the `a` are both word
    // characters, so `\bax\b` never matches and an 802.11ax adapter was classified as 2.4-only.
    const letters = m.replace(/802\.11/gi, ' ');
    const canDo5 = /(^|[^a-z])(ac|ax|a)([^a-z]|$)/i.test(letters);
    return { channel: ch, ghz: ch >= 32 ? 5 : 2.4, mode: m || 'نامشخص', canDo5 };
}

async function windowsTuning() {
    const a = await ps(ADAPTER_PS);
    if (!a) return { id: 'windows', fa: 'تنظیمات ویندوز', verdict: 'unknown', detail: 'خوانده نشد', findings: [], data: null };

    const findings = [];
    let verdict = 'ok';

    // The multimedia class scheduler throttles non-multimedia network traffic to roughly
    // 10 packets/ms by default. 0xFFFFFFFF disables it. This is one of the few classic
    // "gaming tweaks" that is real, documented by Microsoft, and safely reversible.
    const thr = a.throttling;
    if (thr === undefined || thr === null) {
        findings.push('NetworkThrottlingIndex تنظیم نشده — یعنی مقدار پیش‌فرض ۱۰ اعمال است و ترافیک غیرچندرسانه‌ای محدود می‌شود.');
        verdict = 'warn';
    } else if (thr !== 0xFFFFFFFF) {
        findings.push(`NetworkThrottlingIndex برابر ${thr} است. مقدار 0xFFFFFFFF این محدودیت را برمی‌دارد.`);
        verdict = 'warn';
    }
    if (a.responsive !== undefined && a.responsive !== null && a.responsive > 10) {
        findings.push(`SystemResponsiveness برابر ${a.responsive} است؛ برای بازی معمولاً ۱۰ یا کمتر پیشنهاد می‌شود.`);
        if (verdict === 'ok') verdict = 'warn';
    }
    return {
        id: 'windows', fa: 'تنظیمات پاسخ‌گویی ویندوز', verdict,
        detail: `throttling=${thr === 0xFFFFFFFF ? 'غیرفعال' : thr} · responsiveness=${a.responsive}`,
        findings,
        data: { throttling: thr, responsiveness: a.responsive },
    };
}

async function backgroundLoad() {
    const names = HOGS.flatMap(h => h.procs);
    const found = await detect.anyRunning(names);
    const hits = [];
    for (const h of HOGS) {
        const on = found.filter(f => h.procs.some(p => p.toLowerCase() === f.name.toLowerCase()));
        if (on.length) hits.push({ fa: h.fa, hint: h.hint, procs: [...new Set(on.map(o => o.name))], cpuOnly: !!h.cpuOnly });
    }
    const heavy = hits.filter(h => !h.cpuOnly);
    return {
        id: 'background', fa: 'ترافیک پس‌زمینه',
        verdict: heavy.length >= 3 ? 'bad' : heavy.length ? 'warn' : 'ok',
        detail: heavy.length ? `${heavy.length} برنامه‌ی دانلودی در حال اجراست` : 'هیچ برنامه‌ی دانلودی شناخته‌شده‌ای در حال اجرا نیست',
        findings: hits.map(h => `${h.fa} (${h.procs.join('، ')}) — ${h.hint}`),
        data: { hits },
    };
}

/**
 * The MTU ladder, by exit code only.
 *
 * Never parsed from output text: "Packet needs to be fragmented" is localised, and a
 * Persian or German Windows would make every rung look like a failure. ping exits 0 only
 * when a reply actually arrived, in every locale.
 */
function pingDF(ip, size, timeoutMs = 4000) {
    return new Promise(resolve => {
        execFile('ping', ['-n', '1', '-f', '-l', String(size), '-w', '1200', ip],
            { timeout: timeoutMs, windowsHide: true },
            (err) => resolve(!err));
    });
}

async function mtu() {
    const LADDER = [1472, 1400, 1300, 1200, 1000];
    const SMALL = 64;
    const targets = ['1.1.1.1', '8.8.8.8'];
    const results = [];

    for (const ip of targets) {
        const small = await pingDF(ip, SMALL);
        if (!small) { results.push({ ip, icmp: false }); continue; }
        let best = null;
        for (const size of LADDER) {
            if (await pingDF(ip, size)) { best = size; break; }
        }
        results.push({ ip, icmp: true, largest: best });
    }

    const usable = results.filter(r => r.icmp);
    if (!usable.length) {
        return {
            id: 'mtu', fa: 'MTU مسیر', verdict: 'unknown',
            detail: 'ICMP روی این مسیر پاسخ نمی‌دهد، پس MTU قابل اندازه‌گیری نیست',
            findings: ['این «MTU خراب» نیست — یعنی ابزار اندازه‌گیری در دسترس نیست.'],
            data: { results },
        };
    }
    const largest = Math.max(...usable.map(r => r.largest || 0));
    const pathMtu = largest ? largest + 28 : null;
    const findings = [];
    let verdict = 'ok';
    if (pathMtu && pathMtu < 1500) {
        verdict = 'warn';
        findings.push(`MTU مؤثر مسیر حدود ${pathMtu} است، نه ۱۵۰۰. بسته‌های بزرگ‌تر بی‌صدا دور ریخته می‌شوند.`);
    }
    if (!largest) {
        verdict = 'bad';
        findings.push('حتی کوچک‌ترین پله‌ی نردبان هم رد نشد در حالی که ICMP کار می‌کند — نشانه‌ی سیاه‌چاله‌ی MTU.');
    }
    return {
        id: 'mtu', fa: 'MTU مسیر', verdict,
        detail: pathMtu ? `حدود ${pathMtu} بایت` : 'قابل تعیین نبود',
        findings, data: { results, pathMtu },
    };
}

/**
 * Does this line carry sustained UDP at a game's cadence?
 *
 * Three independent anchors, deduped by operator, measured with a real train. This is the
 * check that separates "the internet is bad" from "UDP is bad here" — and on a line where
 * UDP is throttled, no amount of route optimisation helps until that is known.
 */
async function udpHealth({ seconds = 6, pps = 20, signal = null } = {}) {
    const runs = [];
    for (const a of UDP_ANCHORS) {
        if (signal && signal.aborted) break;
        let ip;
        try { ip = await probe.resolve4(a.host); } catch { runs.push({ ...a, ok: false, error: 'نام حل نشد' }); continue; }
        const r = await probe.udpTrain({ host: a.host, ip, port: a.port, proto: 'stun', pps, seconds, warmupMs: 1000, signal });
        runs.push({ ...a, ...r, series: undefined });
    }
    const good = runs.filter(r => r.ok);
    if (!good.length) {
        return {
            id: 'udp', fa: 'سلامت UDP خط', verdict: 'bad',
            detail: 'هیچ‌کدام از سه لنگر UDP پاسخ ندادند',
            findings: ['UDP روی پورت بالا از این خط عبور نمی‌کند. بدون UDP، هیچ بازی آنلاینی درست کار نخواهد کرد.'],
            data: { runs },
        };
    }
    const best = good.reduce((a, b) => (b.score > a.score ? b : a));
    const findings = [];
    let verdict = 'ok';
    if (good.length < UDP_ANCHORS.length) {
        verdict = 'warn';
        findings.push(`${UDP_ANCHORS.length - good.length} لنگر از ${UDP_ANCHORS.length} پاسخ نداد — ممکن است سیاست همان سرور باشد، نه خط شما.`);
    }
    const worstLoss = Math.max(...good.map(r => r.loss));
    if (worstLoss > 1) { verdict = 'bad'; findings.push(`اتلاف بسته تا ${worstLoss}٪ روی UDP دیده شد.`); }
    const worstSpread = Math.max(...good.map(r => r.spread));
    if (worstSpread > 60) { if (verdict === 'ok') verdict = 'warn'; findings.push(`پراکندگی p95 تا ${worstSpread}ms — خط زیر بار یا شلوغ است.`); }

    return {
        id: 'udp', fa: 'سلامت UDP خط', verdict,
        detail: `بهترین لنگر: ${best.fa} — min ${best.min}ms · p95 ${best.p95}ms · اتلاف ${best.loss}٪`,
        findings, data: { runs, best: best.fa },
    };
}

/**
 * Is the line busy RIGHT NOW?
 *
 * This exists because of a real hole found during testing: the user was streaming video
 * while an assessment ran, and the tail latencies it produced (p95 of 457ms and 637ms to
 * Frankfurt) looked exactly like a bad international route. They were not — they were the
 * user's own downstream filling the same queue.
 *
 * An engine that cannot tell those apart will confidently blame the wrong thing, send
 * someone to buy a VPS they do not need, and be wrong in a way that is impossible for them
 * to check. So every assessment now carries a load reading taken while it ran, and the
 * verdict is required to mention it.
 *
 * Measured from the adapter's own byte counters over a short window — no traffic of ours,
 * no guessing from process names.
 */
async function lineLoad({ sampleMs = 2000 } = {}) {
    const script = `
$ErrorActionPreference='SilentlyContinue'
$a = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
if (-not $a) { '{}' ; exit }
$s1 = Get-NetAdapterStatistics -Name $a.Name
Start-Sleep -Milliseconds ${sampleMs}
$s2 = Get-NetAdapterStatistics -Name $a.Name
[pscustomobject]@{
  name = $a.Name
  rxBps = [math]::Round((($s2.ReceivedBytes - $s1.ReceivedBytes) * 1000 / ${sampleMs}))
  txBps = [math]::Round((($s2.SentBytes - $s1.SentBytes) * 1000 / ${sampleMs}))
} | ConvertTo-Json -Compress`;
    const r = await ps(script, sampleMs + 12000);
    if (!r || r.rxBps == null) {
        return { id: 'load', fa: 'بار فعلی خط', verdict: 'unknown', detail: 'خوانده نشد', findings: [], data: null };
    }
    const rxMbps = +(r.rxBps * 8 / 1e6).toFixed(2);
    const txMbps = +(r.txBps * 8 / 1e6).toFixed(2);

    // Thresholds are about the QUEUE, not the pipe. A few hundred kbps of chat traffic
    // changes nothing; a video stream or an upload does, and upload matters far more
    // because the home uplink is the narrow side and games live on it.
    let verdict = 'ok';
    const findings = [];
    if (txMbps > 1.5) {
        verdict = 'bad';
        findings.push(`آپلود شما همین حالا ${txMbps} مگابیت بر ثانیه است. آپلود شلوغ، گلوگاه باریک خانه است و بیشترین اثر را روی پینگ بازی می‌گذارد.`);
    }
    if (rxMbps > 3) {
        if (verdict === 'ok') verdict = 'warn';
        findings.push(`دانلود شما همین حالا ${rxMbps} مگابیت بر ثانیه است — مثلاً پخش ویدیو، دانلود یا آپدیت.`);
    }
    if (verdict !== 'ok') {
        findings.push('هر عددی که در این سنجش دیده می‌شود، زیر همین بار اندازه‌گیری شده و از حالت بی‌کار بدتر است. برای مقایسه‌ی منصفانه، سنجش را با خط آزاد تکرار کن.');
    }
    return {
        id: 'load', fa: 'بار فعلی خط', verdict,
        detail: `دانلود ${rxMbps} · آپلود ${txMbps} مگابیت بر ثانیه`,
        findings, data: { rxMbps, txMbps, adapter: r.name },
    };
}

/**
 * Bufferbloat: the single most under-diagnosed cause of "my ping spikes while gaming".
 *
 * COSTS REAL DATA — up to about 80MB — which is why it is a separate, explicit action and
 * never part of the automatic audit. On a metered Iranian mobile line that is a decision
 * only the user gets to make.
 *
 * Measure the same UDP train twice — once on a quiet line, once while the downlink is
 * saturated — and compare p95. A line whose latency triples under its own load has a
 * queue problem in the modem, and no relay on earth fixes that.
 *
 * Bounded on purpose: the download is capped and cancelled the moment the second train
 * ends, because this runs on metered Iranian connections.
 */
async function bufferbloat({ seconds = 7, pps = 20, onProgress = null, signal = null } = {}) {
    const anchor = UDP_ANCHORS[0];
    let ip;
    try { ip = await probe.resolve4(anchor.host); }
    catch { return { id: 'bufferbloat', fa: 'باف‌ربلوت', verdict: 'unknown', detail: 'لنگر UDP در دسترس نبود', findings: [], data: null }; }

    if (onProgress) onProgress({ phase: 'idle' });
    const idle = await probe.udpTrain({ host: anchor.host, ip, port: anchor.port, proto: 'stun', pps, seconds, warmupMs: 800, signal });
    if (!idle.ok) return { id: 'bufferbloat', fa: 'باف‌ربلوت', verdict: 'unknown', detail: 'اندازه‌گیری پایه ناموفق بود', findings: [], data: { idle } };

    if (onProgress) onProgress({ phase: 'load' });
    const stop = startLoad();
    const startedAt = Date.now();
    let loaded;
    try {
        await new Promise(r => setTimeout(r, 1200));   // let the queue actually fill
        loaded = await probe.udpTrain({ host: anchor.host, ip, port: anchor.port, proto: 'stun', pps, seconds, warmupMs: 500, signal });
    } finally { stop(); }

    if (!loaded.ok) {
        return { id: 'bufferbloat', fa: 'باف‌ربلوت (تأخیر زیر بار)', verdict: 'bad',
                 detail: 'زیر بار، لنگر UDP کاملاً از دست رفت', findings: ['خط زیر بار عملاً UDP را رها می‌کند — این دقیقاً همان چیزی است که در بازی به‌صورت قطع شدن حس می‌شود.'],
                 data: { idle: strip(idle), loaded: strip(loaded) } };
    }

    const delta = loaded.p95 - idle.p95;
    let verdict = 'ok';
    const findings = [];
    if (delta > 300) { verdict = 'bad'; }
    else if (delta > 80) { verdict = 'warn'; }
    if (verdict !== 'ok') {
        findings.push(`زیر بار، p95 از ${idle.p95}ms به ${loaded.p95}ms رفت (+${delta}ms). صف مودم/خط شما پر می‌شود.`);
        findings.push('راه‌حل: محدود کردن سرعت دانلود، فعال کردن QoS روی مودم، یا مکث دانلودها هنگام بازی. هیچ تونلی این را درست نمی‌کند.');
    }
    if (loaded.loss - idle.loss > 1) findings.push(`اتلاف بسته زیر بار ${(loaded.loss - idle.loss).toFixed(1)}٪ افزایش یافت.`);

    return {
        id: 'bufferbloat', fa: 'باف‌ربلوت (تأخیر زیر بار)', verdict,
        detail: `p95 بی‌کار ${idle.p95}ms → زیر بار ${loaded.p95}ms (${delta >= 0 ? '+' : ''}${delta}ms)`,
        findings,
        data: { idle: strip(idle), loaded: strip(loaded), delta, loadSeconds: Math.round((Date.now() - startedAt) / 1000) },
    };
}

function strip(r) { const { series, ...rest } = r; return rest; }

/**
 * Saturate the UPLINK, and report how much went out.
 *
 * `write()` returning false means the socket buffer is full; waiting for `drain` before writing
 * again is what makes this measure the LINE rather than how fast Node can fill a buffer.
 *
 * Bounded by BOTH a byte budget and the caller's stop(), because this is somebody's mobile data.
 */
function startUplinkLoad({ streams = 3, chunk = 64 * 1024, budgetBytes = 24 * 1024 * 1024 } = {}) {
    const https = require('https');
    let stopped = false;
    let sent = 0;
    const reqs = [];
    for (let i = 0; i < streams; i++) {
        const req = https.request('https://speed.cloudflare.com/__up', { method: 'POST' }, res => {
            res.on('data', () => {});
            res.on('error', () => {});
        });
        req.on('error', () => {});
        const buf = Buffer.alloc(chunk, 0x61);
        const pump = () => {
            if (stopped || sent >= budgetBytes) { try { req.end(); } catch (e) {} return; }
            sent += chunk;
            if (req.write(buf)) setImmediate(pump);
            else req.once('drain', pump);
        };
        pump();
        reqs.push(req);
    }
    return {
        stop() { stopped = true; for (const r of reqs) { try { r.destroy(); } catch (e) {} } },
        get bytes() { return sent; },
    };
}

/**
 * The last upload-bloat measurement, kept on disk.
 *
 * It belongs to the LINE, not to a game, so it does not go in the per-game profile store. It is
 * remembered at all so the cure can be free: measuring costs the user's mobile data, applying a
 * cap costs nothing, and a user who paid for the measurement once should not pay again on every
 * acceleration.
 */
const UPBLOAT_FILE = require('path').join(require('os').homedir(), '.mlmvpn', 'game-upbloat.json');

function lastUpbloat() {
    try { return JSON.parse(require('fs').readFileSync(UPBLOAT_FILE, 'utf8')); } catch { return null; }
}

function saveUpbloat(r) {
    try {
        const fs2 = require('fs');
        fs2.mkdirSync(require('path').dirname(UPBLOAT_FILE), { recursive: true });
        fs2.writeFileSync(UPBLOAT_FILE, JSON.stringify({
            at: Date.now(), verdict: r.verdict, delta: r.data && r.data.delta,
            capacityKbps: r.data && r.data.capacityKbps,
            suggestKbps: r.data && r.data.suggestKbps,
        }, null, 2), 'utf8');
    } catch { /* a lost record only costs one more measurement */ }
}

/**
 * Upload bufferbloat — the half of it that can actually be cured from this machine.
 *
 * Returns the latency delta AND the measured upstream capacity, because the cure needs a number:
 * a cap set below what the line can do, so the modem's queue never fills. See shaper.capEgress.
 *
 * Measured on this line 2026-09-14: p95 126ms idle, 2681ms saturated, 29% loss, ~18.5 Mbit/s up.
 * That is not a slow game, it is a disconnected one — and it is the largest single effect anything
 * in this feature has produced.
 */
async function uploadBloat({ seconds = 6, pps = 20, onProgress = null, signal = null } = {}) {
    const anchor = UDP_ANCHORS[0];
    let ip;
    try { ip = await probe.resolve4(anchor.host); }
    catch { return { id: 'upbloat', fa: 'باف‌ربلوت آپلود', verdict: 'unknown', detail: 'لنگر UDP در دسترس نبود', findings: [], data: null }; }

    // IS THE LINE ACTUALLY IDLE? A before/after comparison against a busy line measures the
    // user's own download, not their modem's queue — which is the whole reason lineLoad() exists.
    if (onProgress) onProgress({ phase: 'check' });
    let load = null;
    try { load = await lineLoad({ sampleMs: 1500 }); } catch (e) { load = null; }
    const busyKbps = load ? Math.round(((Number(load.rxBps) || 0) + (Number(load.txBps) || 0)) * 8 / 1000) : 0;
    if (busyKbps > 400) {
        return {
            id: 'upbloat', fa: 'باف‌ربلوت آپلود', verdict: 'unknown',
            detail: `خط همین حالا مشغول است (حدود ${busyKbps} کیلوبیت بر ثانیه) — این سنجش به یک خط بی‌کار نیاز دارد.`,
            findings: ['اول دانلودها و همگام‌سازی‌ها را متوقف کنید، بعد دوباره بگیرید. سنجیدن صف مودم وقتی خط از قبل پر است، بارِ خودتان را اندازه می‌گیرد نه صف را.'],
            data: { busyKbps },
        };
    }

    if (onProgress) onProgress({ phase: 'idle' });
    const idle = await probe.udpTrain({ host: anchor.host, ip, port: anchor.port, proto: 'stun', pps, seconds, warmupMs: 800, signal });
    if (!idle.ok) return { id: 'upbloat', fa: 'باف‌ربلوت آپلود', verdict: 'unknown', detail: 'اندازه‌گیری پایه ناموفق بود', findings: [], data: { idle } };

    // …and is the baseline itself usable? Measured once at 3646ms, which is not a baseline — it is
    // a line already in trouble. Comparing anything to that produces a confident number about
    // nothing.
    if (idle.p95 > 1200) {
        return {
            id: 'upbloat', fa: 'باف‌ربلوت آپلود', verdict: 'unknown',
            detail: `خط بدون هیچ باری هم p95 برابر ${Math.round(idle.p95)}ms دارد — مبنایی برای مقایسه نیست.`,
            findings: ['مشکل این خط در همین لحظه بزرگ‌تر از باف‌ربلوت است. اول «سنجش مستقیم» و «ممیزی خط» را ببینید.'],
            data: { idle: strip(idle) },
        };
    }

    if (onProgress) onProgress({ phase: 'load' });
    const up = startUplinkLoad();
    const t0 = Date.now();
    let loaded;
    try {
        await new Promise(r => setTimeout(r, 1500));   // let the modem's queue actually fill
        loaded = await probe.udpTrain({ host: anchor.host, ip, port: anchor.port, proto: 'stun', pps, seconds, warmupMs: 500, signal });
    } finally { up.stop(); }

    const secs = Math.max(0.5, (Date.now() - t0) / 1000);
    const mbit = (up.bytes * 8) / secs / 1e6;
    const capacityKbps = Math.round(mbit * 1000);

    if (!loaded || !loaded.ok) {
        return {
            id: 'upbloat', fa: 'باف‌ربلوت آپلود', verdict: 'bad',
            detail: 'زیر بار آپلود، لنگر UDP کاملاً از دست رفت',
            findings: ['وقتی آپلود پر می‌شود، خط شما عملاً UDP را رها می‌کند — در بازی این یعنی قطع شدن، نه کند شدن.'],
            data: { idle: strip(idle), capacityKbps, mbytes: Math.round(up.bytes / 1048576) },
        };
    }

    const delta = Math.round(loaded.p95 - idle.p95);
    const lossUp = Number(loaded.loss) - Number(idle.loss);
    // The sign is written once. `+${delta}` printed «+-2477» the first time this ran.
    const signed = (n) => (n >= 0 ? '+' : '') + n;

    // A NEGATIVE delta is not a pass and not a failure — it means the two samples cannot be
    // compared, because latency does not improve when a queue fills. Loss is still worth
    // reporting, because a line that drops 16% of packets under load has a real problem
    // whichever sample was the odd one.
    if (delta < -40) {
        return {
            id: 'upbloat', fa: 'باف‌ربلوت آپلود', verdict: 'unknown',
            detail: `دو نمونه قابل مقایسه نیستند (p95 زیر بار ${Math.abs(delta)}ms کمتر از حالت بی‌کار درآمد) — خط در این چند ثانیه ناپایدار بوده.`,
            findings: lossUp > 5
                ? [`ولی یک چیز قطعی است: زیر بار آپلود ${lossUp.toFixed(0)}٪ از بسته‌ها گم شدند. این به‌تنهایی برای خراب کردن بازی کافی است.`]
                : ['چند ثانیه بعد دوباره بگیرید.'],
            data: { idle: strip(idle), loaded: strip(loaded), delta, capacityKbps },
        };
    }

    let verdict = 'ok';
    if (delta > 300 || lossUp > 5) verdict = 'bad';
    else if (delta > 80) verdict = 'warn';

    const findings = [];
    if (verdict !== 'ok') {
        findings.push(`وقتی آپلود پر شد، p95 از ${Math.round(idle.p95)}ms به ${Math.round(loaded.p95)}ms رفت (${signed(delta)}ms)` +
            (lossUp > 1 ? ` و اتلاف بسته ${lossUp.toFixed(0)}٪ بالا رفت` : '') + '.');
        // The important half: unlike download bloat, this one IS curable from here.
        findings.push(`صف مودم شما پر می‌شود. برخلاف باف‌ربلوت دانلود، این یکی از همین‌جا قابل درمان است: سقف آپلود کل دستگاه کمی زیر ظرفیت خط (حدود ${Math.round(capacityKbps * 0.9)} کیلوبیت بر ثانیه) بسته شود تا صف هیچ‌وقت پر نشود.`);
    }

    return {
        id: 'upbloat', fa: 'باف‌ربلوت آپلود (تأخیر زیر بار آپلود)', verdict,
        detail: `p95 بی‌کار ${Math.round(idle.p95)}ms → زیر بار ${Math.round(loaded.p95)}ms (${signed(delta)}ms) · ظرفیت آپلود حدود ${mbit.toFixed(1)} مگابیت`,
        findings,
        data: {
            idle: strip(idle), loaded: strip(loaded), delta,
            capacityKbps, suggestKbps: Math.round(capacityKbps * 0.9),
            mbytes: Math.round(up.bytes / 1048576),
        },
    };
}

/** Measure and remember, which is what every caller actually wants. */
async function measureUploadBloat(opts) {
    const r = await uploadBloat(opts);
    if (r && (r.verdict === 'ok' || r.verdict === 'warn' || r.verdict === 'bad')) saveUpbloat(r);
    return r;
}

/**
 * Saturate the downlink for as long as the returned stop() is not called.
 *
 * Cloudflare's speed endpoint is used because it is reachable from Iran without a tunnel
 * and lets the size be chosen, so nothing is downloaded that is not needed. Four parallel
 * streams, because one TCP flow will not fill a line with a large bandwidth-delay product.
 */
function startLoad({ perStreamBytes = 20 * 1024 * 1024, streams = 4 } = {}) {
    const https = require('https');
    const reqs = [];
    let stopped = false;
    // Bounded on purpose. Iranian connections are very often metered mobile data, and an
    // open-ended download for a diagnostic is not a cost the app gets to decide for the
    // user. Four streams of 20MB is enough to fill a home downlink for the eight seconds
    // this test needs, and it is the WORST case — the sockets are destroyed the moment the
    // second train ends, so the real figure is usually far lower.
    for (let i = 0; i < streams; i++) {
        const r = https.get(`https://speed.cloudflare.com/__down?bytes=${perStreamBytes}`, res => {
            res.on('data', () => { if (stopped) res.destroy(); });
            res.on('error', () => {});
        });
        r.on('error', () => {});
        reqs.push(r);
    }
    return () => {
        stopped = true;
        for (const r of reqs) { try { r.destroy(); } catch {} }
    };
}

/**
 * NAT, as an audit check.
 *
 * It belongs here rather than beside the route measurements because it is a property of
 * the user's own connection, needs no server of ours, and — for every peer-to-peer game —
 * it outranks latency entirely. A player with a strict NAT does not have a slow session,
 * they have no session.
 */
async function natCheck({ signal = null } = {}) {
    const r = await nat.detectNat({ signal });
    const verdict = r.type === 'open' ? 'ok'
        : r.type === 'moderate' ? 'warn'
        : r.type === 'unknown' ? 'unknown'
        : 'bad';
    return {
        id: 'nat', fa: `نوع NAT — ${r.fa}`, verdict,
        detail: r.detail,
        findings: [...(r.reasons || []), ...(r.impact || [])],
        data: { natType: r.type, ...(r.data || {}) },
    };
}

/** Everything except bufferbloat, which is opt-in because it uses real bandwidth. */
async function quickAudit({ signal = null } = {}) {
    const [load, ad, win, bg, m, udp, n] = await Promise.all([
        lineLoad(), adapter(), windowsTuning(), backgroundLoad(), mtu(), udpHealth({ signal }), natCheck({ signal }),
    ]);
    const checks = [load, ad, win, bg, m, udp, n];
    const bad = checks.filter(c => c.verdict === 'bad').length;
    const warn = checks.filter(c => c.verdict === 'warn').length;
    return {
        at: Date.now(),
        overall: bad ? 'bad' : warn ? 'warn' : 'ok',
        summary: bad
            ? 'گلوگاه در خودِ سیستم یا خط شماست — قبل از هر تونلی باید این حل شود.'
            : warn
                ? 'چند نکته‌ی قابل بهبود در سمت شما هست، ولی گلوگاه اصلی نیست.'
                : 'سمت شما تمیز است؛ اگر مشکلی هست، در مسیر بین‌الملل است.',
        checks,
    };
}

module.exports = { adapter, windowsTuning, backgroundLoad, mtu, udpHealth, natCheck, lineLoad, bufferbloat, uploadBloat, measureUploadBloat, lastUpbloat, UPBLOAT_FILE, classifyBand, quickAudit, HOGS };
