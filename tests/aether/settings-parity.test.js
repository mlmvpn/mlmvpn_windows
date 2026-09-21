// Settings, as Android has them — the server pieces behind the rows, and the rows themselves.
//
//   update-manager   never offers a downgrade, and picks the file that matches this install;
//   crash-reporter   records without changing what a crash does, reads back only its own files;
//   display-settings the text size: follow Windows, or 60–140%, and the old four steps migrate;
//   system-settings  Always-On's memory: kept while a connection is up, gone once the user ends it;
//   cf-resources     the credential rule the Workers list has always used;
//   android-settings every row of Android's Settings, in Android's words, is on a Windows pane.
//
// USERPROFILE points at a throwaway directory; the real ~/.mlmvpn is never read or written.
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-settings-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

(async () => {
    // ── update-manager ──
    const up = require(ROOT + '/update-manager');
    t('update: versions compare by number, "v" or not', up.compare('v1.2.10', '1.2.9') === 1 && up.compare('1.0.9', '1.2.2') === -1 && up.compare('1.2.2', 'v1.2.2') === 0);
    const assets = [
        { name: 'mlm-vpn-Setup-1.3.0-x64.exe' }, { name: 'mlm-vpn-Portable-1.3.0-x64.exe' },
        { name: 'mlm-vpn-Setup-1.3.0-ia32.exe' }, { name: 'latest.yml' },
    ];
    t('update: the installed build gets the installer for its architecture', up.pickAsset(assets, 'Setup', 'x64').name === 'mlm-vpn-Setup-1.3.0-x64.exe');
    t('update: the portable build gets the portable exe', up.pickAsset(assets, 'Portable', 'x64').name === 'mlm-vpn-Portable-1.3.0-x64.exe');
    t('update: a release with no matching exe offers nothing', up.pickAsset([{ name: 'app.apk' }], 'Setup', 'x64') === null);
    t('update: it is the Windows repository, not the Android one', up.REPO === 'mlmvpn/mlmvpn_windows');
    const st = up.status();
    t('update: nothing checked yet says so (no invented "up to date")', st.latest === null && !st.lastCheckAt && st.autoDownload === true);
    t('update: nothing to download before a newer version is known', !!throws(() => up.startDownload()));
    const upSrc = fs.readFileSync(ROOT + '/update-manager.js', 'utf8');
    t('update: every request goes through the GitHub route chain (direct → proxy → own engine)', /gtFetch/.test(upSrc) && !/axios/.test(upSrc));
    t('update: the big download carries no whole-request deadline (a stall is cut instead)',
        !/fetchViaChain\(l\.asset\.url, \{[^}]*timeoutMs/.test(upSrc) && /reader\.cancel\(\)/.test(upSrc));

    // ── crash-reporter ──
    const cr = require(ROOT + '/crash-reporter');
    const before = process.listeners('uncaughtException').length;
    cr.install();
    t('crash: installs a monitor only — no uncaughtException handler that would swallow a crash',
        process.listeners('uncaughtException').length === before && process.listeners('uncaughtExceptionMonitor').length >= 1);
    const f1 = cr.record('main', new Error('boom in test'));
    const f2 = cr.record('renderer', new Error('render-process-gone: oom'), { reason: 'oom' });
    const list = cr.list();
    t('crash: each crash is one file, newest first, with its kind', !!f1 && !!f2 && list.length === 2 && list.some((r) => r.kind === 'renderer'));
    t('crash: the report says what broke', /boom in test/.test(cr.read(path.basename(f1))) && /MLM VPN/.test(cr.read(path.basename(f1))));
    t('crash: only its own files can be read back', !!throws(() => cr.read('..\\..\\secret.txt')) && !!throws(() => cr.read('user_data.json')));
    t('crash: clear removes them', cr.clear() === 2 && cr.list().length === 0);

    // ── display-settings ──
    const ds = require(ROOT + '/display-settings');
    t('text size: follows Windows by default', ds.get().textAuto === true && ds.get().textZoom === 1);
    ds.set({ textAuto: false, textScale: 125 });
    t('text size: the slider value is the zoom when not following Windows', ds.get().textZoom === 1.25);
    ds.set({ textScale: 400 });
    t('text size: 60–140%, as on Android', ds.get().textScale === 140);
    ds.set({ textAuto: true });
    t('text size: following Windows again keeps the slider value for later', ds.get().textZoom === 1 && ds.get().textScale === 140);
    fs.writeFileSync(ds.FILE, JSON.stringify({ textZoom: 1.1 }));
    t('text size: the first 1.2.2 build\'s four steps migrate', ds.get().textAuto === false && ds.get().textScale === 110);

    // ── system-settings ──
    const sys = require(ROOT + '/system-settings');
    t('system: Always-On is off and the lock rule is "stay connected" until chosen', sys.get().alwaysOn === false && sys.get().lockMinutes === 0);
    t('system: the lock choices are Android\'s screen-off ones', JSON.stringify(sys.LOCK_CHOICES) === JSON.stringify([0, 1, 5, 30, 60]));
    t('system: anything else is refused', !!throws(() => sys.setLockMinutes(7)));
    sys.setLockMinutes(5);
    t('system: a choice is kept', sys.get().lockMinutes === 5);
    sys.rememberConnection({ kind: 'v2ray', uri: 'vless://x@h:443', useSystemProxy: true, tun: false });
    sys.updateConnection('v2ray', { tun: true, useSystemProxy: false });
    t('always-on: the path of the connection follows the user (proxy → full tunnel)', sys.lastConnection().tun === true && sys.lastConnection().useSystemProxy === false);
    sys.updateConnection('aether', { tun: false });
    t('always-on: another engine\'s change does not touch this record', sys.lastConnection().kind === 'v2ray' && sys.lastConnection().tun === true);
    sys.forgetConnection('aether');
    t('always-on: another engine\'s stop does not forget this one', !!sys.lastConnection());
    sys.forgetConnection('v2ray');
    t('always-on: the user ending the connection forgets it — nothing comes back', sys.lastConnection() === null);
    const srv = fs.readFileSync(ROOT + '/server.js', 'utf8');
    t('always-on: the server remembers on start, forgets on the user\'s stop, replays only with the switch on',
        /rememberConnection\(\{ kind: 'v2ray'/.test(srv) && /rememberConnection\(\{ kind: 'aether'/.test(srv)
        && /forgetConnection\('v2ray'\)/.test(srv) && /forgetConnection\('aether'\)/.test(srv)
        && /if \(!sys\.get\(\)\.alwaysOn\) return;/.test(srv));
    t('lock: the watcher ends connections through the panels\' own endpoints',
        /installLockWatcher\(disconnectEverything/.test(srv) && /post\('\/api\/aether\/stop'\)/.test(srv) && /post\('\/api\/v2ray\/stop'\)/.test(srv));

    // ── cf-resources ──
    const cf = require(ROOT + '/cf-resources');
    t('cloudflare: an API token is sent as a Bearer token', cf.headersFor({ token: 'cfat_abc', email: 'a@b.c' }).Authorization === 'Bearer cfat_abc');
    const legacy = cf.headersFor({ token: 'k'.repeat(37), email: 'a@b.c' });
    t('cloudflare: a global key is sent with its e-mail', legacy['X-Auth-Key'] === 'k'.repeat(37) && legacy['X-Auth-Email'] === 'a@b.c');
    t('cloudflare: no token, no request', !!throws(() => cf.headersFor({ email: 'a@b.c' })));
    t('cloudflare: the token rides in a POST body, never a URL', /app\.post\('\/api\/cf\/overview'/.test(srv) && !/app\.get\('\/api\/cf\//.test(srv));

    // ── the rows ──
    const ui = fs.readFileSync(ROOT + '/public/components/android-settings.js', 'utf8');
    const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');
    const ROWS = [
        // the account card and the hub
        'حساب کلادفلر وصل نیست', 'برای ساخت سرور شخصی وارد شوید', 'منابع حساب', 'حساب‌های متصل', 'مدیریت در صفحهٔ ابری',
        'وورکرها', 'پایگاه‌داده‌های D1', 'فضاهای KV', 'انتخاب همه', 'لغو انتخاب همه', 'حذف همه',
        // شبکه
        'پورت محلی (Local Port)', 'سرور DNS بک‌اند', 'رفع فیلتر کانفیگ‌ها (کلادفلر)', 'حالت پروکسی', 'اتصال شبکه محلی',
        'شبکه محلی', 'تنظیمات پیشرفته VPN (تونل / برنامه‌ها)',
        // تنظیمات VPN
        'VPN همیشه روشن (Always-On)', 'تنظیمات اتصال', 'برای هر روش', 'یک مقدار برای هر روش', 'همهٔ روش‌ها یکجا',
        'پیدا کردن بهترین مقدار برای این خط', 'تعداد سرور اتصال سریع', 'حالت‌های مسیریابی (تونل)', 'حالت مسیریابی',
        'همه برنامه‌ها', 'انتخابی', 'عدم تونل', 'برنامه‌های انتخاب‌شده', 'جستجوی برنامه...',
        // صفحه نمایش
        'تصویر زمینه', 'ظاهر برنامه', 'خودکار', 'اندازه آیکون', 'اندازه متن', 'اندازه متن پیش‌فرض سیستم',
        'اندازه عنوان آیکون‌ها', 'نمایش عنوان آیکون‌های داک', 'تصویر زمینه در همه صفحات',
        'نمایش ترافیک لحظه‌ای در هدر', 'زبان اپلیکیشن (Language)', 'زبان سیستم',
        // مصرف
        'ثبت و مانیتورینگ مصرف کل', 'ثبت روزانه دیتای مصرفی', 'مصرف کل', 'مصرف امروز', '۷ روز گذشته', '۳۰ روز گذشته',
        // سیستم
        'رفتار هنگام قفل شدن ویندوز', 'همیشه متصل بماند (بدون قطعی)', 'بازنشانی چیدمان صفحه اصلی',
        // درباره
        'نسخه', 'به‌روزرسانی نرم‌افزار', 'بررسی نسخهٔ جدید و نصب آن', 'دانلود و نصب', 'آخرین به‌روزرسانی',
        'گزارش خطا', 'درباره ما', 'سازنده، راه‌های ارتباط و لیست تغییرات', 'لیست تغییرات', 'تلگرام', 'گیت‌هاب', 'یوتیوب',
    ];
    const missing = ROWS.filter((r) => !ui.includes(r));
    t('every row of Android\'s Settings is on a Windows pane, in Android\'s words', !missing.length, missing.join(' | '));
    const order = ['btn-set-account', 'btn-set-cf', 'btn-set-network', 'btn-set-tunnel', 'btn-set-appearance', 'btn-set-usage', 'btn-set-system', 'btn-set-about'];
    const pos = order.map((id) => html.indexOf(`id="${id}"`));
    t('the sidebar runs in Android\'s order: account, resources, network, VPN, display, usage, system, about',
        pos.every((p) => p > 0) && pos.every((p, i) => i === 0 || p > pos[i - 1]));
    t('every pane the sidebar opens exists', ['cf', 'network', 'tunnel', 'appearance', 'usage', 'system', 'about'].every((id) => html.includes(`id="panel-set-${id}"`)));
    t('the MTU rows are Windows\' methods, with a measure page each',
        ['masque', 'wireguard', 'gool', 'quick', 'sni', 'v2ray', 'gst'].every((m) => new RegExp(`\\['${m}',`).test(ui)) && /mtu-measure/.test(ui));
    t('the English choice is shown as not ready, not offered as if it worked', /pickRow\('lang-pick', 'en', 'English', '[^']+', false, true\)/.test(ui));
    t('a route the running server lacks says "restart the app", not "could not read"', /status === 404/.test(ui) && /خروج کامل/.test(ui));

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* in use */ }
    process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
