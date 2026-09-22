# MLM VPN — «گزارش مشکل»
#
# Runs when the application does not. No Node, no Electron, nothing from the app itself —
# only Windows PowerShell. A user whose app opens black, hangs before the loading screen, or
# closes itself can still double-click this.
#
# It does three things, in this order:
#   1. READS the logs and says, in plain Persian, how far the last launch got and what stopped it.
#   2. Opens that verdict in Notepad — because Persian in a console window depends on the font
#      and the code page, and this has to be readable on a machine we know nothing about.
#   3. Puts the evidence in one .zip on the Desktop, so "send us the log" is one file.
#
# Launched by MLMVPN-Report.cmd. This file must keep its UTF-8 byte-order mark: without it,
# PowerShell 5.1 reads it as ANSI and every Persian string becomes mojibake.

$ErrorActionPreference = 'Continue'

$mlm   = Join-Path $env:USERPROFILE '.mlmvpn'
$log   = Join-Path $mlm 'startup.log'
$crash = Join-Path $mlm 'crashlogs'

# Everything said is kept, so the console, Notepad and the zip all get the same words.
$out = New-Object System.Collections.ArrayList
function Say { param($t = '', $c = 'White') [void]$out.Add($t); Write-Host "  $t" -ForegroundColor $c }
function Rule { param($c = 'DarkCyan') [void]$out.Add('─' * 60); Write-Host ('  ' + ('─' * 60)) -ForegroundColor $c }
function Head { param($t) Say ''; Say $t 'Cyan'; Rule }

Clear-Host
Write-Host ''
Say 'MLM VPN — گزارش مشکل' 'Cyan'
Rule
Say ("ساخته شد: " + (Get-Date -Format 'yyyy/MM/dd  HH:mm')) 'DarkGray'

$verdict = 'unknown'
$advice  = New-Object System.Collections.ArrayList

if (-not (Test-Path $mlm)) {
    Head 'نتیجه'
    Say 'پوشهٔ اطلاعات برنامه پیدا نشد.' 'Yellow'
    Say ''
    Say 'یعنی MLM VPN روی این کامپیوتر هنوز یک بار هم اجرا نشده، یا با کاربر' 'Gray'
    Say 'ویندوزِ دیگری اجرا شده است. اگر برنامه را نصب کرده‌اید، یک بار بازش کنید' 'Gray'
    Say '(حتی اگر بالا نیامد) و دوباره همین فایل را بزنید.' 'Gray'
    $txt = Join-Path $env:TEMP 'MLMVPN-report.txt'
    $out | Set-Content $txt -Encoding UTF8
    Start-Process notepad.exe $txt
    Write-Host ''
    Read-Host '  برای بستن، Enter بزنید'
    exit
}

# ── 1. how far did the last launch get? ─────────────────────────────────────────────────
Head 'آخرین اجرای برنامه'

if (Test-Path $log) {
    $all = @(Get-Content $log -Encoding UTF8 -ErrorAction SilentlyContinue)
    # Each launch begins with a "launch" line; read only the last block.
    $starts = @()
    for ($i = 0; $i -lt $all.Count; $i++) { if ($all[$i] -match '\slaunch\s') { $starts += $i } }
    $block  = if ($starts.Count) { $all[$starts[-1]..($all.Count - 1)] } else { $all }
    $joined = ($block -join "`n")

    if ($joined -match '"app":"([^"]+)"')     { Say ("نسخهٔ برنامه : " + $Matches[1]) }
    if ($joined -match '"arch":"([^"]+)"')    {
        Say ("معماری      : " + $(if ($Matches[1] -eq 'ia32') { '۳۲ بیتی' } else { '۶۴ بیتی' }))
    }
    if ($joined -match '"windows":"([^"]+)"') { Say ("ویندوز      : " + $Matches[1]) }
    if ($joined -match '"gpuOff":true')       { Say 'کارت گرافیک : خاموش (صفحه با پردازنده کشیده می‌شود)' 'Yellow' }
    Say ''

    # Each stage reached rules out every stage before it.
    if     ($joined -match 'desktop:ready')  { $verdict = 'ready' }
    elseif ($joined -match 'page:loaded')    { $verdict = 'loaded' }
    elseif ($joined -match 'page:dom-ready') { $verdict = 'dom' }
    elseif ($joined -match 'page:start')     { $verdict = 'pagestart' }
    elseif ($joined -match 'page:loading')   { $verdict = 'loading' }
    elseif ($joined -match 'server:up')      { $verdict = 'server' }
    elseif ($joined -match 'modules:loaded') { $verdict = 'modules' }
    elseif ($joined -match '\slaunch\s')     { $verdict = 'launch' }

    switch ($verdict) {
      'ready' {
        Say 'آخرین اجرا کامل و سالم بالا آمد.' 'Green'
        Say 'یعنی مشکل در باز شدن برنامه نیست. اگر برنامه وسط کار بسته شده،' 'Gray'
        Say 'بخش «خطاهای ثبت‌شده» پایین را ببینید.' 'Gray'
      }
      { $_ -in 'loaded','dom' } {
        Say 'صفحه بارگذاری شد ولی برنامه هیچ‌وقت نگفت که آماده است.' 'Yellow'
        Say 'این نشانهٔ گیر کردن روی صفحهٔ لودینگ، یا سیاه ماندن صفحه است.' 'Gray'
        [void]$advice.Add('روی آیکون برنامه کنار ساعت ویندوز راست‌کلیک کنید، «کشیدن صفحه با کارت گرافیک» را خاموش کنید و برنامه را دوباره باز کنید.')
      }
      { $_ -in 'pagestart','loading' } {
        Say 'برنامه شروع به بارگذاری صفحه کرد ولی صفحه هرگز نیامد.' 'Yellow'
        Say 'معمولاً یعنی چیزی جلوی سرور داخلی برنامه را گرفته است.' 'Gray'
        [void]$advice.Add('آنتی‌ویروس را موقتاً غیرفعال کنید و دوباره امتحان کنید.')
        [void]$advice.Add('اگر موقع اولین اجرا فایروال ویندوز سؤالی پرسیده و Cancel زده‌اید، برنامه را حذف و دوباره نصب کنید.')
      }
      'server' {
        Say 'سرور داخلی بالا آمد ولی پنجره هیچ‌وقت شروع به بارگذاری نکرد.' 'Yellow'
        [void]$advice.Add('این فایل zip را برای پشتیبانی بفرستید — نیاز به بررسی دارد.')
      }
      'modules' {
        Say 'برنامه وسط بارگذاری بخش‌های داخلی‌اش متوقف شد.' 'Red'
        Say 'این همان حالتی است که «قبل از صفحهٔ لودینگ گیر می‌کند».' 'Gray'
        [void]$advice.Add('این فایل zip را حتماً برای پشتیبانی بفرستید.')
      }
      'launch' {
        Say 'برنامه شروع شد ولی حتی بارگذاری بخش‌های داخلی‌اش هم تمام نشد.' 'Red'
        [void]$advice.Add('این فایل zip را حتماً برای پشتیبانی بفرستید.')
      }
      default { Say 'چیزی از آخرین اجرا خوانده نشد.' 'Yellow' }
    }
} else {
    Say 'فایل گزارش راه‌اندازی پیدا نشد.' 'Yellow'
    Say 'اگر نسخهٔ برنامه قدیمی‌تر از ۱.۲.۳ است، این فایل هنوز ساخته نمی‌شده.' 'Gray'
}

# ── 2. recorded errors ──────────────────────────────────────────────────────────────────
Head 'خطاهای ثبت‌شده'

$reports = @()
if (Test-Path $crash) {
    $reports = @(Get-ChildItem $crash -Filter *.txt -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
}

if ($reports.Count -eq 0) {
    Say 'هیچ خطایی ثبت نشده است.' 'Green'
} else {
    Say ("تعداد: " + $reports.Count) 'Yellow'
    Say ''
    foreach ($r in ($reports | Select-Object -First 3)) {
        Say ("• " + $r.LastWriteTime.ToString('yyyy/MM/dd HH:mm')) 'Yellow'
        $body = @(Get-Content $r.FullName -Encoding UTF8 -ErrorAction SilentlyContinue)
        $err  = $body | Where-Object { $_ -match '^(Error|TypeError|RangeError)' } | Select-Object -First 1
        if ($err) { Say ("  " + $err.Trim()) 'Gray' }
    }
    if ($reports.Count -gt 3) { Say ''; Say ("و " + ($reports.Count - 3) + " مورد دیگر — همه داخل فایل zip هستند.") 'DarkGray' }
}

# ── 3. what to do ───────────────────────────────────────────────────────────────────────
if ($advice.Count) {
    Head 'پیشنهاد'
    foreach ($a in $advice) { Say ("• " + $a) }
}

# ── 4. one file to send ─────────────────────────────────────────────────────────────────
Head 'بسته‌بندی برای ارسال'

$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop) { $desktop = $env:USERPROFILE }
$stamp   = Get-Date -Format 'yyyy-MM-dd-HHmm'
$zip     = Join-Path $desktop ("MLMVPN-report-$stamp.zip")
$staging = Join-Path $env:TEMP "mlmvpn-report-$stamp"
$txtPath = Join-Path $env:TEMP 'MLMVPN-report.txt'

try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null

    if (Test-Path $log)   { Copy-Item $log   -Destination $staging -ErrorAction SilentlyContinue }
    if (Test-Path $crash) { Copy-Item $crash -Destination $staging -Recurse -ErrorAction SilentlyContinue }
    foreach ($extra in @('tunnel-events.log', 'startup.json', 'display.json')) {
        $p = Join-Path $mlm $extra
        if (Test-Path $p) { Copy-Item $p -Destination $staging -ErrorAction SilentlyContinue }
    }

    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    @(
        "collected : $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
        "windows   : $($os.Caption) $($os.Version) $($os.OSArchitecture)",
        "verdict   : $verdict",
        "installed : $(if (Test-Path 'C:\Program Files\MLM VPN') { 'C:\Program Files\MLM VPN' } else { '(not in Program Files)' })"
    ) | Set-Content (Join-Path $staging 'system.txt') -Encoding UTF8

    Say 'فایل ساخته شد، روی دسکتاپ شما:' 'Green'
    Say ''
    Say ("    " + (Split-Path $zip -Leaf)) 'White'
    Say ''
    Say 'همین یک فایل را برای پشتیبانی بفرستید — تلگرام: t.me/mlmvpn' 'Gray'
    Rule

    # The verdict goes into the zip too, so whoever reads it sees what the user saw.
    $out | Set-Content (Join-Path $staging 'summary.txt') -Encoding UTF8
    $out | Set-Content $txtPath -Encoding UTF8

    if (Test-Path $zip) { Remove-Item $zip -Force -ErrorAction SilentlyContinue }
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $zip)
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue

    # Notepad, not the console: Persian here must be readable on a machine we know nothing about.
    Start-Process notepad.exe $txtPath
    Start-Process explorer.exe "/select,`"$zip`""
}
catch {
    Say 'ساخت فایل zip ممکن نشد.' 'Red'
    Say ("علت: " + $_.Exception.Message) 'Gray'
    Say ''
    Say 'به‌جایش این پوشه را دستی بفرستید:' 'Gray'
    Say ("    " + $mlm) 'White'
    $out | Set-Content $txtPath -Encoding UTF8
    Start-Process notepad.exe $txtPath
    Start-Process explorer.exe $mlm
}

Write-Host ''
Read-Host '  برای بستن، Enter بزنید'
