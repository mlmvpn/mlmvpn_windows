// --- leak-check.js — snapshot everything that decides where a packet goes ---
//
// Run this WHILE the leak is happening. The leak audit alone says "you leaked"; this adds
// the state needed to say WHY, captured at the same instant:
//   * which processes are actually up (a tunnel that died looks identical to one that
//     never captured traffic, from the outside),
//   * every default route and its metric — the physical one winning is the single most
//     common cause and is invisible from a browser,
//   * per-adapter DNS, the Windows system proxy, and the TUN adapter's presence.
//
// Usage:  node leak-check.js        (from the app folder)

const { execFile } = require('child_process');
const { runLeakAudit } = require('./leak-audit');

function sh(cmd, args) {
    return new Promise(resolve => {
        execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout) =>
            resolve(err ? '' : String(stdout || '')));
    });
}

const ps = (script) => sh('powershell', ['-NoProfile', '-Command', script]);

(async () => {
    const out = [];
    const say = (s = '') => { out.push(s); console.log(s); };

    say('════════ گزارش نشت ════════');
    say(new Date().toISOString());
    say();

    // ── processes ────────────────────────────────────────────────────────────
    const tasks = await sh('tasklist', []);
    const running = ['aether.exe', 'sing-box.exe', 'xray.exe'].map(
        n => `${n}: ${tasks.includes(n) ? 'در حال اجرا' : 'اجرا نیست'}`);
    say('— پروسه‌ها —');
    running.forEach(r => say('  ' + r));
    say();

    // ── adapters ─────────────────────────────────────────────────────────────
    say('— کارت‌های شبکه‌ی فعال —');
    say((await ps("Get-NetAdapter | Where-Object {$_.Status -eq 'Up'} | ForEach-Object { '  ' + $_.Name + '  |  ' + $_.InterfaceDescription }")).trimEnd());
    say();

    // ── default routes ───────────────────────────────────────────────────────
    // The decisive one is the lowest metric. If that is not the TUN adapter while the
    // tunnel is on, everything leaves in the clear no matter how the tunnel is configured.
    say('— مسیرهای پیش‌فرض (کمترین متریک برنده است) —');
    const routes = await sh('route', ['print', '-4']);
    routes.split(/\r?\n/).filter(l => /^\s*0\.0\.0\.0\s+0\.0\.0\.0\s/.test(l))
        .forEach(l => say('  ' + l.trim()));
    say();

    // ── DNS + system proxy ───────────────────────────────────────────────────
    say('— DNS هر کارت شبکه —');
    say((await ps("Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object {$_.ServerAddresses} | ForEach-Object { '  ' + $_.InterfaceAlias + ' :: ' + ($_.ServerAddresses -join ',') }")).trimEnd());
    say();

    say('— پراکسی سیستم ویندوز —');
    const proxy = await ps("$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; $p=Get-ItemProperty $k; '  ProxyEnable=' + $p.ProxyEnable + '  ProxyServer=' + $p.ProxyServer");
    say(proxy.trimEnd());
    say();

    // ── the audit itself ─────────────────────────────────────────────────────
    say('— بررسی نشت —');
    let tunnelUp = false;
    try { tunnelUp = require('./tun-manager').isRunning(); } catch (e) { }
    // isRunning() only knows about a TUN this process started; a tunnel started by the app
    // in another process would read as false and mislabel every check. Fall back to the
    // adapter actually existing.
    if (!tunnelUp) tunnelUp = (await ps("Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {$_.IPAddress -like '172.19.*'} | Measure-Object | Select-Object -ExpandProperty Count")).trim() !== '0';

    const audit = await runLeakAudit({ tunnelUp });
    say(`  حالت تونل: ${tunnelUp ? 'روشن' : 'خاموش'}   |   نتیجه: ${audit.verdict}`);
    audit.checks.forEach(c => say(`  [${c.state.toUpperCase().padEnd(7)}] ${c.title} — ${c.detail}`));
    say();
    say('════════ پایان گزارش ════════');

    try {
        require('fs').writeFileSync('leak-report.txt', out.join('\n'), 'utf8');
        console.log('\nذخیره شد در: leak-report.txt');
    } catch (e) { }
})();
