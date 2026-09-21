// --- Reversible local fixes ---
//
// The audit finds problems in the user's own machine. This applies the ones that are safe,
// documented and reversible — because telling someone "your SystemResponsiveness is 20"
// and leaving them to find a registry editor is not help, it is homework.
//
// THE RULES EVERY TWEAK HERE OBEYS, WITHOUT EXCEPTION
//
//   1. NOTHING is applied without an explicit click. There is no "optimise everything"
//      button and no tweak runs as a side effect of opening a panel or running a scan.
//   2. The ORIGINAL VALUE IS WRITTEN TO DISK BEFORE THE CHANGE. Not the default value —
//      the value this machine actually had. A "restore" that guesses is not a restore.
//      Same discipline as aether-guard: record state before touching Windows.
//   3. Every tweak is individually reversible, and `restoreAll()` puts the machine back
//      exactly as it was found.
//   4. Anything that needs a reboot says so. A tweak that silently does nothing until
//      next Tuesday is worse than no tweak, because the user will draw conclusions from
//      a measurement it never affected.
//
// WHAT IS DELIBERATELY NOT HERE
// The "gaming tweaks" that circulate online are mostly cargo cult: disabling Nagle per
// interface, TCP autotuning off, "Ultimate Performance" power plans, MSMQ registry keys.
// They range from irrelevant for UDP game traffic to actively harmful for throughput.
// Three entries is the honest number of settings on a modern Windows that are worth
// changing and provably related to network latency.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const BACKUP_FILE = path.join(os.homedir(), '.mlmvpn', 'game-tweaks-backup.json');
const MM_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile';

function ps(script, timeoutMs = 20000) {
    return new Promise(resolve => {
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
                const out = (stdout || '').trim();
                if (!out) return resolve({ ok: !err, raw: '', error: err ? (stderr || err.message) : null });
                try { resolve({ ok: true, ...JSON.parse(out) }); }
                catch { resolve({ ok: !err, raw: out, error: err ? (stderr || err.message) : null }); }
            });
    });
}

function loadBackup() {
    try { return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')); } catch { return {}; }
}
function saveBackup(b) {
    try {
        fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true });
        fs.writeFileSync(BACKUP_FILE, JSON.stringify(b, null, 2), 'utf8');
    } catch { /* a backup we cannot write means the tweak must not be applied — see apply() */ }
}

/**
 * One advanced property of the active adapter, by its STANDARDISED NDIS keyword.
 *
 * The `*`-prefixed keywords are Microsoft's, not the vendor's, so `*InterruptModeration` means the
 * same thing on an Intel card and a Realtek one. Anything without the star is a vendor invention
 * and is deliberately not touched.
 *
 * Returns null when the adapter does not expose it — which is most keywords on most adapters, and
 * is why every tweak below sets `nullMeans: 'unavailable'`.
 */
function advReadFn(keyword) {
    return async function read() {
        const r = await ps(`
$a = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
if (-not $a) { '{}'; exit }
$p = Get-NetAdapterAdvancedProperty -Name $a.Name -RegistryKeyword '${keyword}' -EA SilentlyContinue
if (-not $p) { '{}'; exit }
[pscustomobject]@{ value = "$($p.DisplayValue)"; adapter = $a.Name } | ConvertTo-Json -Compress`);
        if (!r || r.value === undefined || r.value === '') return null;
        return String(r.value);
    };
}

/**
 * Write one back.
 *
 * `-DisplayValue` rather than `-RegistryValue`: the display strings are what the driver declares as
 * valid, and a numeric value that a particular driver does not accept is refused silently. Restore
 * passes the exact string that was read, so whatever the original was — «Enabled», «Rx & Tx
 * Enabled», a vendor's own wording — it goes back unchanged.
 */
function advWriteFn(keyword) {
    return async function write(v) {
        if (v === null) return { done: true };   // it was never set; nothing to put back
        const safe = String(v).replace(/'/g, "''");
        return ps(`
$a = Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1
if ($a) { Set-NetAdapterAdvancedProperty -Name $a.Name -RegistryKeyword '${keyword}' -DisplayValue '${safe}' -NoRestart -EA SilentlyContinue }
[pscustomobject]@{ done = $true } | ConvertTo-Json -Compress`);
    };
}

/** «Disabled» in the several spellings drivers actually use. */
const isOff = (v) => v !== null && /^(disabled|off|0)$/i.test(String(v).trim());

const TWEAKS = {
    /**
     * The multimedia class scheduler caps non-multimedia network traffic at roughly ten
     * packets per millisecond. It exists so audio never starves, and it predates the idea
     * that a game might be the latency-critical thing on the machine. Microsoft documents
     * 0xFFFFFFFF as "no throttling".
     */
    throttling: {
        fa: 'برداشتن محدودیت شبکه‌ی زمان‌بند چندرسانه‌ای',
        why: 'ویندوز به‌صورت پیش‌فرض ترافیک غیرچندرسانه‌ای را به حدود ۱۰ بسته در میلی‌ثانیه محدود می‌کند. این تنظیم برای زمانی ساخته شد که صدا مهم‌ترین چیز روی سیستم بود، نه بازی.',
        target: 'NetworkThrottlingIndex = 0xFFFFFFFF',
        needsReboot: true,
        // For a registry value, null genuinely means "not set", which is a normal state
        // the tweak can act on.
        nullMeans: 'unset',
        async read() {
            const r = await ps(`$v=(Get-ItemProperty '${MM_KEY}' -Name NetworkThrottlingIndex -EA SilentlyContinue).NetworkThrottlingIndex; [pscustomobject]@{value=$v} | ConvertTo-Json -Compress`);
            return r.value === undefined ? null : r.value;
        },
        isApplied(v) { return v === 4294967295; },
        async write(v) {
            if (v === null) {
                return ps(`Remove-ItemProperty '${MM_KEY}' -Name NetworkThrottlingIndex -EA SilentlyContinue; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress`);
            }
            return ps(`New-ItemProperty '${MM_KEY}' -Name NetworkThrottlingIndex -PropertyType DWord -Value ${v >>> 0} -Force | Out-Null; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress`);
        },
        applyValue: 0xFFFFFFFF,
    },

    /**
     * SystemResponsiveness is the share of CPU the scheduler reserves for background
     * (non-multimedia) work — 20% by default on a desktop. Lowering it to 10 is the value
     * Microsoft's own multimedia guidance uses for latency-sensitive foreground work.
     * Not taken to 0: that starves audio, and a game with stuttering sound is not a win.
     */
    responsiveness: {
        fa: 'کاهش سهم پس‌زمینه‌ی زمان‌بند به ۱۰٪',
        why: 'ویندوز ۲۰٪ از زمان پردازنده را برای کارهای پس‌زمینه کنار می‌گذارد. مقدار ۱۰ همان چیزی است که راهنمای خود مایکروسافت برای کارهای حساس به تأخیر پیشنهاد می‌کند. عمداً صفر نمی‌شود — صفر باعث لکنت صدا می‌شود.',
        target: 'SystemResponsiveness = 10',
        needsReboot: true,
        nullMeans: 'unset',
        async read() {
            const r = await ps(`$v=(Get-ItemProperty '${MM_KEY}' -Name SystemResponsiveness -EA SilentlyContinue).SystemResponsiveness; [pscustomobject]@{value=$v} | ConvertTo-Json -Compress`);
            return r.value === undefined ? null : r.value;
        },
        isApplied(v) { return v !== null && v <= 10; },
        async write(v) {
            if (v === null) {
                return ps(`Remove-ItemProperty '${MM_KEY}' -Name SystemResponsiveness -EA SilentlyContinue; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress`);
            }
            return ps(`New-ItemProperty '${MM_KEY}' -Name SystemResponsiveness -PropertyType DWord -Value ${v} -Force | Out-Null; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress`);
        },
        applyValue: 10,
    },

    /**
     * "Allow the computer to turn off this device to save power" on a wireless adapter.
     * On a USB Wi-Fi dongle this is the single largest source of jitter available, because
     * the radio genuinely sleeps between frames. Takes effect immediately, no reboot.
     */
    wifipower: {
        fa: 'خاموش کردن حالت صرفه‌جویی انرژی کارت شبکه',
        why: 'وقتی ویندوز اجازه دارد کارت شبکه را برای صرفه‌جویی خاموش کند، رادیو بین فریم‌ها می‌خوابد و بیدار شدنش هر بار چند میلی‌ثانیه تأخیر اضافه می‌کند. روی دانگل USB بی‌سیم، بزرگ‌ترین منبع jitter همین است.',
        target: 'AllowComputerToTurnOffDevice = Disabled',
        needsReboot: false,
        // Here null means the DRIVER does not expose power management at all — which is the
        // case on this machine's USB dongle. Reporting that as "off, click to fix" would
        // offer a button that silently does nothing.
        nullMeans: 'unavailable',
        async read() {
            const r = await ps(`$a=Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1; if(-not $a){'{}';exit}; $p=Get-NetAdapterPowerManagement -Name $a.Name -EA SilentlyContinue; [pscustomobject]@{value="$($p.AllowComputerToTurnOffDevice)"; adapter=$a.Name} | ConvertTo-Json -Compress`);
            if (!r || r.value === undefined || r.value === '') return null;
            return String(r.value);
        },
        isApplied(v) { return v !== null && String(v).toLowerCase() === 'disabled'; },
        async write(v) {
            const want = v === null ? 'Enabled' : v;
            return ps(`$a=Get-NetAdapter -Physical | Where-Object { $_.Status -eq 'Up' } | Select-Object -First 1; if($a){ Set-NetAdapterPowerManagement -Name $a.Name -AllowComputerToTurnOffDevice ${'$'}(if('${want}' -eq 'Disabled'){'Disabled'}else{'Enabled'}) -EA SilentlyContinue }; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress`);
        },
        applyValue: 'Disabled',
    },

    /**
     * USB selective suspend. Present and ENABLED on this machine's dongle — measured.
     *
     * Windows suspends the USB device when it looks idle, and a game's traffic is bursty enough
     * to look idle between bursts. Every wake costs milliseconds, and they land exactly where a
     * player notices them.
     */
    usbsuspend: {
        fa: 'خاموش کردن خواب USB کارت شبکه',
        why: 'ویندوز دستگاه USB را وقتی بی‌کار به‌نظر برسد می‌خواباند — و ترافیک بازی بین بسته‌ها دقیقاً بی‌کار به‌نظر می‌رسد. هر بار بیدار شدن چند میلی‌ثانیه خرج دارد و درست همان‌جایی می‌افتد که بازیکن حسش می‌کند. روی دانگل USB این تنظیم واقعاً روشن است (سنجیده شد).',
        target: '*SelectiveSuspend = Disabled',
        needsReboot: false,
        nullMeans: 'unavailable',
        read: advReadFn('*SelectiveSuspend'),
        isApplied: isOff,
        write: advWriteFn('*SelectiveSuspend'),
        applyValue: 'Disabled',
    },

    /**
     * Interrupt moderation batches interrupts so the CPU is disturbed less often. The batching is
     * the delay: a packet waits until the batch is worth raising an interrupt for. Off trades CPU
     * — which a gaming machine has — for latency, which is what it wants.
     */
    intmod: {
        fa: 'خاموش کردن تجمیع وقفه‌های کارت شبکه',
        why: 'کارت شبکه وقفه‌ها را دسته‌ای به پردازنده می‌دهد تا کمتر مزاحمش شود. همان دسته‌بندی، خودِ تأخیر است: بسته منتظر می‌ماند تا دسته ارزش وقفه دادن پیدا کند. خاموش کردنش کمی پردازنده بیشتر مصرف می‌کند و تأخیر را کم می‌کند — معاملهٔ درستی برای یک ماشین بازی.',
        target: '*InterruptModeration = Disabled',
        needsReboot: false,
        nullMeans: 'unavailable',
        read: advReadFn('*InterruptModeration'),
        isApplied: isOff,
        write: advWriteFn('*InterruptModeration'),
        applyValue: 'Disabled',
    },

    /**
     * 802.3x flow control. A pause frame stops the ENTIRE link when any queue fills, so a game's
     * packets wait behind a file transfer's — head-of-line blocking by design.
     */
    flowctl: {
        fa: 'خاموش کردن Flow Control کارت شبکه',
        why: 'فریم Pause در 802.3x کل لینک را متوقف می‌کند وقتی هر صفی پر شود — یعنی بسته‌های بازی پشت بسته‌های یک انتقال فایل معطل می‌مانند. این دقیقاً همان چیزی است که به‌عنوان لگ حس می‌شود.',
        target: '*FlowControl = Disabled',
        needsReboot: false,
        nullMeans: 'unavailable',
        read: advReadFn('*FlowControl'),
        isApplied: isOff,
        write: advWriteFn('*FlowControl'),
        applyValue: 'Disabled',
    },

    /**
     * Energy-Efficient Ethernet powers the PHY down between frames. Same trade as selective
     * suspend, same answer for a game — and on a wired machine this is the one that usually exists.
     */
    eee: {
        fa: 'خاموش کردن صرفه‌جویی انرژی اترنت (EEE)',
        why: 'EEE لایهٔ فیزیکی کارت شبکه را بین فریم‌ها کم‌مصرف می‌کند و بیدار شدنش تأخیر می‌گذارد. برای یک کامپیوتر رومیزی که در حال بازی است، این صرفه‌جویی چیزی نیست که ارزشش را داشته باشد.',
        target: '*EEE = Disabled',
        needsReboot: false,
        nullMeans: 'unavailable',
        read: advReadFn('*EEE'),
        isApplied: isOff,
        write: advWriteFn('*EEE'),
        applyValue: 'Disabled',
    },

    /**
     * Windows' background game recording.
     *
     * The Game Bar keeps the last stretch of play buffered so it can be saved after something
     * happens. That buffer is encoded continuously — CPU, GPU and disk — for a feature most
     * players never use once. Measured on this machine: it is ON.
     *
     * This is the one setting in this file that plausibly touches frame times, and it does so by
     * REMOVING work rather than by any tuning magic. No promise beyond that.
     */
    gamedvr: {
        fa: 'خاموش کردن ضبط پس‌زمینهٔ ویندوز (Game DVR)',
        why: 'نوار بازی ویندوز مدام آخرین تکهٔ بازی را ضبط و نگه می‌دارد تا اگر خواستید ذخیره‌اش کنید. این ضبط دائمی پردازنده و کارت گرافیک و دیسک می‌خورد، برای قابلیتی که بیشتر بازیکن‌ها یک بار هم استفاده‌اش نمی‌کنند. خاموش کردنش کار را کم می‌کند — نه اینکه چیزی را جادویی تنظیم کند.',
        target: 'GameDVR_Enabled = 0',
        needsReboot: false,
        nullMeans: 'unset',
        async read() {
            const r = await ps(`$v=(Get-ItemProperty 'HKCU:\\System\\GameConfigStore' -Name GameDVR_Enabled -EA SilentlyContinue).GameDVR_Enabled; [pscustomobject]@{value=$v} | ConvertTo-Json -Compress`);
            return r.value === undefined ? null : Number(r.value);
        },
        isApplied(v) { return v === 0; },
        async write(v) {
            if (v === null) {
                return ps(`Remove-ItemProperty 'HKCU:\\System\\GameConfigStore' -Name GameDVR_Enabled -EA SilentlyContinue; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress`);
            }
            return ps(`if (-not (Test-Path 'HKCU:\\System\\GameConfigStore')) { New-Item -Path 'HKCU:\\System\\GameConfigStore' -Force | Out-Null }; New-ItemProperty 'HKCU:\\System\\GameConfigStore' -Name GameDVR_Enabled -PropertyType DWord -Value ${Number(v)} -Force | Out-Null; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress`);
        },
        applyValue: 0,
    },

    /**
     * Hardware-accelerated GPU scheduling.
     *
     * Independent benchmarks put it at about -2% to +3% average FPS with a small but consistent
     * improvement in INPUT latency — worth having, on hardware that supports it.
     *
     * OFFERED ONLY WHERE WINDOWS ITSELF REPORTS SUPPORT, and that caution is deliberate. It needs
     * WDDM 2.7+ and a driver that declares it; forcing the value on hardware that cannot do it has
     * produced black screens. The two failure directions are not equal:
     *
     *   a wrong "unavailable" on a capable machine  -> the user misses one small tweak
     *   a wrong "available" on an incapable one     -> the user may lose their display
     *
     * So anything inconclusive reads as unavailable. On the machine this was written on — an AMD
     * R7 200 and an Intel HD 4600, both 2013 parts — that is the correct answer.
     */
    hags: {
        fa: 'زمان‌بندی سخت‌افزاری GPU (HAGS)',
        why: 'زمان‌بندی کارهای کارت گرافیک را به‌جای پردازنده به خودِ کارت می‌سپارد. بنچمارک‌های مستقل می‌گویند FPS تقریباً بدون تغییر می‌ماند (بین منفی ۲ تا مثبت ۳ درصد) ولی تأخیر ورودی کمی و پیوسته بهتر می‌شود. فقط جایی پیشنهاد می‌شود که خود ویندوز پشتیبانی‌اش را اعلام کرده باشد — روشن کردن اجباری‌اش روی سخت‌افزاری که پشتیبانی نمی‌کند، گزارش‌های صفحهٔ سیاه دارد.',
        target: 'HwSchMode = 2',
        needsReboot: true,
        nullMeans: 'unavailable',
        async read() {
            const r = await ps(`
$k = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers'
$sup = (Get-ItemProperty $k -Name 'HwSchModeSupport' -EA SilentlyContinue).HwSchModeSupport
$mode = (Get-ItemProperty $k -Name 'HwSchMode' -EA SilentlyContinue).HwSchMode
[pscustomobject]@{ support = $sup; mode = $mode } | ConvertTo-Json -Compress`);
            // No declared support means not offered. `HwSchMode` alone is not enough: the value
            // can linger from an earlier driver that did support it.
            if (!r || r.support === undefined || r.support === null) return null;
            if (Number(r.support) < 2) return null;
            return r.mode === undefined || r.mode === null ? 1 : Number(r.mode);
        },
        isApplied(v) { return Number(v) === 2; },
        async write(v) {
            const val = v === null ? 1 : Number(v);
            return ps(`New-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers' -Name HwSchMode -PropertyType DWord -Value ${val} -Force | Out-Null; [pscustomobject]@{done=$true} | ConvertTo-Json -Compress`);
        },
        applyValue: 2,
    },
};

/** Current state of every tweak, plus whether we hold a backup we could restore to. */
async function list() {
    const backup = loadBackup();
    const out = [];
    for (const [id, t] of Object.entries(TWEAKS)) {
        let current = null, readable = true;
        try { current = await t.read(); } catch { readable = false; }
        const unavailable = current === null && t.nullMeans === 'unavailable';
        out.push({
            id, fa: t.fa, why: t.why, target: t.target, needsReboot: t.needsReboot,
            current: unavailable ? 'در این سیستم پشتیبانی نمی‌شود'
                : current === null ? 'تنظیم نشده' : String(current),
            applied: unavailable || !readable ? null : !!t.isApplied(current),
            available: readable && !unavailable,
            readable,
            hasBackup: Object.prototype.hasOwnProperty.call(backup, id),
            backupValue: backup[id] === undefined ? null : (backup[id] === null ? 'تنظیم نشده' : String(backup[id])),
        });
    }
    return out;
}

/**
 * Apply one tweak.
 *
 * The backup is written FIRST and the change is refused if it could not be written —
 * an irreversible "optimisation" is not something this app is willing to make.
 */
async function apply(id) {
    const t = TWEAKS[id];
    if (!t) throw new Error('این تنظیم شناخته نشد.');

    // Refuse rather than pretend: a driver that does not expose the setting will accept
    // the command and change nothing, and the panel would then show a tweak as applied
    // while the machine behaves exactly as before.
    if (t.nullMeans === 'unavailable' && (await t.read()) === null) {
        throw new Error('کارت شبکه‌ی این سیستم این تنظیم را در اختیار ویندوز نمی‌گذارد، پس اعمالش بی‌اثر است.');
    }

    const backup = loadBackup();
    if (!Object.prototype.hasOwnProperty.call(backup, id)) {
        const before = await t.read();
        backup[id] = before;
        saveBackup(backup);
        const verify = loadBackup();
        if (!Object.prototype.hasOwnProperty.call(verify, id)) {
            throw new Error('مقدار فعلی قابل ذخیره نبود، پس تغییری اعمال نشد — بدون امکان بازگشت چیزی را عوض نمی‌کنیم.');
        }
    }

    await t.write(t.applyValue);
    const after = await t.read();
    return {
        id, applied: !!t.isApplied(after), current: after === null ? null : String(after),
        needsReboot: t.needsReboot,
        note: t.needsReboot
            ? 'این تغییر تا ری‌استارت ویندوز اثر نمی‌کند. تا آن موقع اندازه‌گیری‌ها هنوز وضعیت قبلی را نشان می‌دهند.'
            : 'بلافاصله اعمال شد.',
    };
}

/** Put one setting back exactly as it was found. */
async function restore(id) {
    const t = TWEAKS[id];
    if (!t) throw new Error('این تنظیم شناخته نشد.');
    const backup = loadBackup();
    if (!Object.prototype.hasOwnProperty.call(backup, id)) {
        throw new Error('نسخه‌ی پشتیبانی از مقدار اولیه نداریم، پس بازگردانی انجام نمی‌شود.');
    }
    await t.write(backup[id]);
    delete backup[id];
    saveBackup(backup);
    const after = await t.read();
    return { id, restored: true, current: after === null ? null : String(after), needsReboot: t.needsReboot };
}

async function restoreAll() {
    const backup = loadBackup();
    const done = [];
    for (const id of Object.keys(backup)) {
        try { done.push(await restore(id)); } catch (e) { done.push({ id, restored: false, error: e.message }); }
    }
    return done;
}

module.exports = { list, apply, restore, restoreAll, BACKUP_FILE, TWEAKS };
