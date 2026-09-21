/* =====================================================================
   Spotlight — Ctrl K. One field over the desk that reaches every tool,
   a short list of actions, and each settings pane.
   ---------------------------------------------------------------------
   Actions are functions the app already had, named here so they can be
   found — the search itself never invents a capability. Persian and
   English both match («دی ان اس» and «dns»), Arabic ي/ك are folded into
   Persian ی/ک, and the half-space does not count.
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var ov = null, input = null, list = null, results = [], sel = 0, recent = [];

  // Extra words a person might type for each app.
  var KW = {
    scanner: 'scan scanner ip clean cdn cloudflare اسکن آیپی آی پی تمیز',
    v2ray: 'v2ray xray vless vmess trojan node config وی تو ری نود کانفیگ اشتراک ساب sub',
    settings: 'settings preferences تنظیمات',
    cloud: 'cloud cloudflare worker bpb zeus edge panel ابری کلودفلر ورکر پنل زئوس',
    quick: 'quick connect vpn سریع وصل اتصال کشور',
    masque: 'masque warp cloudflare ماسک وارپ',
    wireguard: 'wireguard wg warp cloudflare وایرگارد وارپ',
    warp_on_warp: 'warp in warp wiw gool double وارپ در وارپ دو لایه',
    sni: 'sni dpi anti filter ضد فیلتر',
    sanction: 'dns doh ecs دی ان اس اختصاصی sanction تحریم شکن',
    free: 'free config pool رایگان کانفیگ',
    gst: 'google apps script gst گوگل اسکریپت تونل',
    github: 'github tunnel codespace گیت هاب تونل',
    vodi: 'railway ریلوی ریل وی vodiwalker static fixed ip آیپی ثابت پنل',
    game: 'game gaming ping latency بازی شتاب گیم',
    monitor: 'monitor usage traffic مصرف ترافیک آمار مانیتور',
    console: 'console log logs terminal core کنسول لاگ ترمینال هسته',
    guide: 'help guide tutorial راهنما آموزش',
    changelog: 'changelog whats new release version تغییرات نسخه تازه',
    netdiag: 'diag diagnose network internet دیاگ اینترنت عیب یابی',
    dnsclean: 'dns clean flush cache دی ان اس پاکسازی پاک سازی',
    speed: 'speed test سرعت تست',
    syscheck: 'system check health بررسی سیستم',
    fixedip: 'fixed ip location لوکیشن آیپی ثابت کشور',
    archive: 'archive saved clean ip آرشیو آیپی سالم',
    combo: 'combine combination merge ترکیب کانفیگ',
  };

  function call(name) { var fn = window[name]; if (typeof fn === 'function') { try { fn(); } catch (e) { console.error(e); } } }

  var ACTIONS = [
    { label: 'دستیار', kw: 'assistant دستیار کمک راهنما', icon: 'g-launch', run: function () { if (window.MVAssistant) MVAssistant.open(); } },
    { label: 'کدام موتور برای خط من؟', kw: 'engine race compare موتور بهترین مقایسه سنجش', icon: 'g-shield', run: function () { if (window.MVAssistant) MVAssistant.raceEngines(); } },
    { label: 'شروع یا توقف اسکن', kw: 'start stop scan شروع توقف اسکن', icon: 'g-radar', run: function () { MV.wm.open('scanner'); call('toggleScan'); } },
    { label: 'تب اسکن جدید', kw: 'new tab scan تب جدید', icon: 'g-plus', run: function () { window.promptNewTab(); } },
    { label: 'تاریخچه‌ی اسکن‌ها', kw: 'history تاریخچه', icon: 'g-clock', run: function () { MV.wm.open('scanner'); call('scanGo', 'history'); } },
    { label: 'کپی همه‌ی آی‌پی‌ها', kw: 'copy ips کپی', icon: 'g-list', run: function () { call('copyAllIps'); } },
    { label: 'کپی لاگ‌های هسته', kw: 'copy logs کپی لاگ', icon: 'g-term', run: function () { call('copyLogs'); } },
    { label: 'پاک کردن لاگ‌های هسته', kw: 'clear logs پاک لاگ', icon: 'g-term', run: function () { call('clearCoreLogs'); } },
    { label: 'نمایش میزکار', kw: 'desktop show desk میزکار', icon: 'g-launch', run: function () { MV.wm.showDesktop(); } },
  ];

  var PANES = [
    { label: 'ظاهر', kw: 'appearance dark light theme ظاهر تیره روشن شفافیت حرکت', pane: 'appearance' },
    { label: 'تصویر زمینه', kw: 'wallpaper background تصویر زمینه والپیپر', pane: 'appearance', focus: 'wallpaper' },
    { label: 'تنظیمات اسکن', kw: 'scan settings autosave اسکن ذخیره', pane: 'scan' },
    { label: 'تنظیمات برنامه', kw: 'app settings log monitor برنامه', pane: 'app' },
    { label: 'پیشرفته V2Ray', kw: 'v2ray advanced fingerprint fragment فینگرپرینت فرگمنت', pane: 'v2ray' },
    { label: 'تست سرعت', kw: 'speed test سرعت', pane: 'speed' },
    { label: 'اعلان‌ها', kw: 'notifications اعلان نوتیفیکیشن', pane: 'notifications' },
    { label: 'منابع حساب', kw: 'cloudflare workers d1 kv account ورکر وورکر کلادفلر کلودفلر حساب منابع حذف', pane: 'cf' },
  ];

  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/[يى]/g, "ی").replace(/ك/g, "ک").replace(/ة/g, "ه").replace(/[أإآ]/g, "ا")
      .replace(/[ً-ٰٟ]/g, "").replace(/‌/g, " ").replace(/\s+/g, " ").trim();
  }

  function score(q, title, hay) {
    var t = norm(title), h = norm(hay);
    var parts = q.split(' ');
    for (var i = 0; i < parts.length; i++) if (h.indexOf(parts[i]) < 0 && t.indexOf(parts[i]) < 0) return 0;
    if (t.indexOf(q) === 0) return 4;
    if ((' ' + t).indexOf(' ' + q) > -1) return 3;
    if (t.indexOf(q) > -1) return 2;
    return 1;
  }

  function search(raw) {
    var q = norm(raw);
    var out = [];
    MV.apps.all().forEach(function (a) {
      var s = q ? score(q, a.title + ' ' + (a.short || ''), a.title + ' ' + (a.short || '') + ' ' + (KW[a.id] || '')) : 0;
      if (!q && recent.indexOf(a.id) > -1) s = 1 + (recent.length - recent.indexOf(a.id)) / 100;
      if (s) out.push({ kind: 'app', group: 'برنامه‌ها', label: a.title, app: a, s: s });
    });
    if (q) {
      ACTIONS.forEach(function (x) { var s = score(q, x.label, x.label + ' ' + x.kw); if (s) out.push({ kind: 'action', group: 'اقدام‌ها', label: x.label, action: x, s: s }); });
      PANES.forEach(function (x) { var s = score(q, x.label, x.label + ' ' + x.kw); if (s) out.push({ kind: 'pane', group: 'تنظیمات', label: x.label, pane: x, s: s }); });
    } else {
      ACTIONS.slice(0, 3).forEach(function (x) { out.push({ kind: 'action', group: 'اقدام‌ها', label: x.label, action: x, s: .5 }); });
    }
    var order = { 'برنامه‌ها': 0, 'اقدام‌ها': 1, 'تنظیمات': 2 };
    out.sort(function (a, b) { return order[a.group] - order[b.group] || b.s - a.s; });
    return out.slice(0, 14);
  }

  function rowIcon(r) {
    if (r.kind === 'app') return MV.apps.iconHTML(r.app, 26);
    if (r.kind === 'pane') return '<span class="mv-spot-glyph" style="--tint:var(--mv-gray)">' + MV.icons.svg('g-gear') + '</span>';
    return '<span class="mv-spot-glyph">' + MV.icons.svg(r.action.icon) + '</span>';
  }

  function render() {
    results = search(input.value);
    sel = Math.min(sel, Math.max(0, results.length - 1));
    if (!results.length) {
      list.innerHTML = '<div class="mv-spot-empty">چیزی با «' + MV.esc(input.value) + '» پیدا نشد.</div>';
      return;
    }
    var html = '', group = null;
    results.forEach(function (r, i) {
      if (r.group !== group) { group = r.group; html += '<div class="mv-spot-group">' + (input.value ? group : (group === 'برنامه‌ها' ? 'اخیر' : 'پیشنهاد')) + '</div>'; }
      html += '<button type="button" class="mv-spot-row' + (i === sel ? ' is-sel' : '') + '" data-i="' + i + '">' + rowIcon(r) +
        '<span class="mv-spot-label">' + MV.esc(r.label) + '</span>' +
        (i === sel ? '<span class="mv-kbd">Enter</span>' : '') + '</button>';
    });
    list.innerHTML = html;
    var cur = list.querySelector('.is-sel');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function choose(i) {
    var r = results[i];
    if (!r) return;
    close();
    if (r.kind === 'app') {
      recent = [r.app.id].concat(recent.filter(function (x) { return x !== r.app.id; })).slice(0, 6);
      MV.wm.open(r.app.id);
    } else if (r.kind === 'action') {
      r.action.run();
    } else {
      MV.wm.open('settings', { pane: r.pane.pane, focus: r.pane.focus });
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
  }

  function open() {
    if (ov) { input.focus(); input.select(); return; }
    MV.menu.close();
    ov = document.createElement('div');
    ov.className = 'mv-spot';
    ov.innerHTML =
      '<div class="mv-spot-box" role="dialog" aria-label="جست‌وجو">' +
        '<div class="mv-spot-field">' + MV.icons.svg('g-search') +
          '<input type="text" placeholder="جست‌وجوی ابزارها، اقدام‌ها و تنظیمات" aria-label="جست‌وجو" autocomplete="off" spellcheck="false">' +
          '<span class="mv-kbd">Esc</span></div>' +
        '<div class="mv-spot-list" role="listbox"></div>' +
      '</div>';
    input = ov.querySelector('input');
    list = ov.querySelector('.mv-spot-list');
    ov.addEventListener('mousedown', function (e) { if (!e.target.closest('.mv-spot-box')) close(); });
    list.addEventListener('mousedown', function (e) { e.preventDefault(); });
    list.addEventListener('click', function (e) { var b = e.target.closest('.mv-spot-row'); if (b) choose(+b.dataset.i); });
    list.addEventListener('mousemove', function (e) {
      var b = e.target.closest('.mv-spot-row');
      if (b && +b.dataset.i !== sel) { sel = +b.dataset.i; render(); }
    });
    input.addEventListener('input', function () { sel = 0; render(); });
    input.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    sel = 0;
    render();
    input.focus();
  }

  function close() {
    if (!ov) return;
    ov.remove();
    ov = null;
  }

  MV.spotlight = { open: open, close: close, toggle: function () { if (ov) close(); else open(); } };
})();
