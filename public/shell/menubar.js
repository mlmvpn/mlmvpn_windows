/* =====================================================================
   Menu bar — mirrored for RTL: logo and the menus at the start (right),
   status items and the clock at the end (left), then the controls of
   the Electron window itself.
   ---------------------------------------------------------------------
   Every menu item calls a function the app already had; nothing here is
   a new capability. The bar's empty area is the drag region for the OS
   window (double-click maximises, as on any Windows title bar).
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var bar = null, appBtn = null, scanBtn = null, clockEl = null, engineEl = null;
  var openKey = null;

  function ipc(name) {
    try { require('electron').ipcRenderer.send(name); return true; } catch (e) { return false; }
  }
  function hasElectron() { try { return !!require('electron').ipcRenderer; } catch (e) { return false; } }
  function call(name) {
    var fn = window[name];
    if (typeof fn === 'function') { try { return fn.apply(null, Array.prototype.slice.call(arguments, 1)); } catch (e) { console.error(e); } }
  }
  function activeScanTab() {
    try { var t = getActiveTab(); return t && !t.type && t.id !== 'settings' ? t : null; } catch (e) { return null; }
  }
  function edit(cmd) { try { document.execCommand(cmd); } catch (e) { /* not allowed here */ } }

  // ── Menus ────────────────────────────────────────────────────────────────
  var MENUS = {
    app: function () {
      return [
        { label: 'درباره‌ی MLMVPN', action: function () { call('showModal', 'about-modal'); } },
        { label: 'تازه‌های نسخه', action: function () { MV.wm.open('changelog'); } },
        { label: 'بررسی سیستم…', action: function () { MV.wm.open('syscheck'); } },
        { sep: true },
        { label: 'تنظیمات…', sc: 'Ctrl ,', action: function () { MV.wm.open('settings'); } },
        { sep: true },
        { label: 'پنهان کردن در سینی', disabled: !hasElectron(), action: function () { ipc('window:close'); } },
        { label: 'خروج کامل', sc: 'Ctrl Q', disabled: !hasElectron(), action: quit },
      ];
    },
    file: function () {
      var tab = activeScanTab(), has = !!(tab && tab.results && tab.results.length);
      return [
        { label: 'تب اسکن جدید', sc: 'Ctrl T', action: function () { window.promptNewTab(); } },
        { label: 'کپی تب فعلی', disabled: !tab, action: function () { window.duplicateTab(); } },
        { sep: true },
        { label: 'خروجی نتایج (TXT)', disabled: !has, action: function () { call('exportTxt'); } },
        { label: 'خروجی نتایج (CSV)', disabled: !has, action: function () { call('exportCsv'); } },
        { label: 'خروجی نتایج (JSON)', disabled: !has, action: function () { call('exportJson'); } },
        { label: 'کپی همه‌ی آی‌پی‌ها', disabled: !has, action: function () { call('copyAllIps'); } },
        { sep: true },
        { label: 'بستن پنجره', sc: 'Ctrl W', disabled: !MV.wm.active(), action: function () { MV.wm.close(MV.wm.active()); } },
      ];
    },
    edit: function () {
      return [
        { label: 'برگرداندن', sc: 'Ctrl Z', action: function () { edit('undo'); } },
        { label: 'انجام دوباره', sc: 'Ctrl Y', action: function () { edit('redo'); } },
        { sep: true },
        { label: 'بریدن', sc: 'Ctrl X', action: function () { edit('cut'); } },
        { label: 'کپی', sc: 'Ctrl C', action: function () { edit('copy'); } },
        { label: 'چسباندن', sc: 'Ctrl V', action: function () { edit('paste'); } },
        { label: 'انتخاب همه', sc: 'Ctrl A', action: function () { edit('selectAll'); } },
      ];
    },
    view: function () {
      var sb = document.getElementById('scan-sidebar');
      var ap = MV.appearance;
      var mag = document.documentElement.getAttribute('data-dock-magnify') !== 'off';
      return [
        { label: 'نوار کناری اسکنر', checked: !!sb && sb.style.display !== 'none' && MV.wm.isOpen('scanner'), action: function () {
          MV.wm.open('scanner');
          call('toggleSidebar');
        } },
        { label: 'کنسول', action: function () { MV.wm.open('console'); } },
        { label: 'مانیتور مصرف', action: function () { MV.wm.open('monitor'); } },
        { sep: true },
        { label: 'ظاهر تیره', checked: ap.effective === 'dark', action: function () { ap.set('dark'); } },
        { label: 'ظاهر روشن' + (ap.lightUnlocked ? '' : ' (به‌زودی)'), checked: ap.effective === 'light', disabled: !ap.lightUnlocked, action: function () { ap.set('light'); } },
        { sep: true },
        { label: 'بزرگ‌نمایی داک', checked: mag, action: function () {
          var next = mag ? 'off' : 'on';
          document.documentElement.setAttribute('data-dock-magnify', next);
          MV.store('mv-dock-magnify', next);
        } },
      ];
    },
    scan: function () {
      var tab = activeScanTab(), running = !!(tab && tab.state === 'running');
      return [
        { label: running ? 'توقف اسکن' : 'شروع اسکن', sc: 'Ctrl Enter', disabled: !tab, action: function () { call('toggleScan'); } },
        { label: 'اسکن دوباره از ابتدا', disabled: !tab, action: function () { call('restartScan'); } },
        { label: 'ذخیره‌ی خودکار', checked: !!window.autoSaveEnabled, action: function () { call('toggleAutoSave'); } },
        { sep: true },
        // The history is a section of the scan page now, so the window has to be up first.
        { label: 'تاریخچه‌ی اسکن‌ها', action: function () { MV.wm.open('scanner'); call('scanGo', 'history'); } },
        { label: 'آرشیو آی‌پی', action: function () { call('openIpArchive'); } },
        { label: 'مرکز ترکیب', action: function () { call('openCombinationCenter'); } },
      ];
    },
    window: function () {
      var act = MV.wm.active();
      var items = [
        { label: 'کوچک کردن', sc: 'Ctrl M', disabled: !act, action: function () { MV.wm.minimize(act); } },
        { label: 'بزرگ کردن', disabled: !act || (MV.apps.get(act) || {}).noZoom, action: function () { MV.wm.zoom(act); } },
        { sep: true },
        { label: 'نمایش میزکار', sc: 'Ctrl Shift D', action: function () { MV.wm.showDesktop(); } },
        { label: 'پنجره‌ی بعدی', sc: 'Ctrl `', action: function () { MV.wm.cycle(); } },
      ];
      var open = MV.wm.list().filter(function (w) { return w.open; });
      if (open.length) {
        items.push({ sep: true });
        open.forEach(function (w) {
          var app = MV.apps.get(w.id);
          items.push({ label: app.title + (w.minimized ? ' (در داک)' : ''), checked: w.active, action: function () { MV.wm.open(w.id); } });
        });
      }
      return items;
    },
    help: function () {
      return [
        { label: 'راهنمای برنامه', action: function () { MV.wm.open('guide'); } },
        { label: 'دیاگ اینترنت', action: function () { MV.wm.open('netdiag'); } },
        { sep: true },
        { label: 'کانال تلگرام MLMVPN', action: function () { window.open('https://t.me/mlmvpn', '_blank'); } },
        { label: 'یوتیوب marketmlm', action: function () { window.open('https://youtube.com/@marketmlm', '_blank'); } },
      ];
    },
  };

  async function quit() {
    var ok = typeof window.uiConfirm === 'function'
      ? await window.uiConfirm({ title: 'خروج کامل از MLMVPN؟', message: 'همه‌ی اتصال‌ها و تونل‌ها قطع می‌شوند و برنامه از سینی ویندوز هم بسته می‌شود.', confirmLabel: 'خروج', cancelLabel: 'لغو', danger: true })
      : true;
    if (ok) ipc('app:quit');
  }

  function openMenu(key, btn) {
    var build = MENUS[key];
    if (!build) return;
    openKey = key;
    btn.setAttribute('aria-expanded', 'true');
    MV.menu.open({
      anchor: btn.getBoundingClientRect(),
      items: build(),
      keepFor: bar,
      onClose: function () {
        btn.setAttribute('aria-expanded', 'false');
        if (openKey === key) openKey = null;
      },
    });
  }

  function menuButton(key, label, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mv-mb-menu' + (cls ? ' ' + cls : '');
    b.dataset.menu = key;
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-expanded', 'false');
    b.textContent = label;
    return b;
  }

  // ── Status: engine, clock ────────────────────────────────────────────────
  // HAND-WRITTEN, and therefore the thing that goes stale when an engine is added: an engine
  // missing here is one the menubar swears is off while its own window says it is connected.
  // «گیت‌وی MLM» and «اوپن‌وی‌پی‌ان» were both absent — they are separate engines (SoftEther's
  // own client, and openvpn.exe), each with its own lamp, so each needs its own row.
  var ENGINE_ORDER = ['quick', 'v2ray', 'masque', 'wireguard', 'warp_on_warp', 'psiphon', 'tor',
    'lantern', 'geph', 'gateway', 'openvpn', 'gst', 'github', 'vodi', 'sni', 'sanction'];

  function updateEngine() {
    if (!engineEl) return;
    var up = ENGINE_ORDER.filter(function (id) { return MV.apps.engineUp(id); });
    engineEl.hidden = !up.length;
    if (!up.length) return;
    var app = MV.apps.get(up[0]);
    engineEl.dataset.app = up[0];
    engineEl.querySelector('span:last-child').textContent = MV.apps.label(app) + (up.length > 1 ? ' +' + (up.length - 1).toLocaleString('fa-IR') : '');
    engineEl.title = up.map(function (id) { return MV.apps.get(id).title; }).join('، ') + ' — وصل';
  }

  var fmtDay = null, fmtTime = null;
  function updateClock() {
    if (!clockEl) return;
    try {
      fmtDay = fmtDay || new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long' });
      fmtTime = fmtTime || new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false });
      var now = new Date();
      clockEl.textContent = fmtDay.format(now) + ' ' + fmtTime.format(now);
    } catch (e) {
      clockEl.textContent = new Date().toLocaleTimeString();
    }
  }

  function updateApp() {
    if (!appBtn) return;
    var id = MV.wm.active();
    var app = id ? MV.apps.get(id) : null;
    appBtn.textContent = app ? MV.apps.label(app) : 'میزکار';
    scanBtn.hidden = id !== 'scanner';
  }

  // ── Build ────────────────────────────────────────────────────────────────
  function build() {
    bar = document.createElement('header');
    bar.className = 'mv-menubar';
    bar.setAttribute('role', 'menubar');

    var start = document.createElement('div');
    start.className = 'mv-mb-start';
    var logo = document.createElement('img');
    logo.className = 'mv-mb-logo';
    logo.src = 'icon.png';
    logo.alt = 'MLMVPN';
    logo.dataset.noDrag = '';
    logo.addEventListener('click', function () { openMenu('app', appBtn); });
    start.appendChild(logo);
    appBtn = menuButton('app', 'میزکار', 'is-app');
    start.appendChild(appBtn);
    start.appendChild(menuButton('file', 'فایل'));
    start.appendChild(menuButton('edit', 'ویرایش'));
    start.appendChild(menuButton('view', 'نمایش'));
    scanBtn = menuButton('scan', 'اسکن');
    scanBtn.hidden = true;
    start.appendChild(scanBtn);
    start.appendChild(menuButton('window', 'پنجره'));
    start.appendChild(menuButton('help', 'راهنما'));

    // Menu titles never take focus: Edit › Copy must act on whatever field had it.
    start.addEventListener('mousedown', function (e) { if (e.target.closest('.mv-mb-menu')) e.preventDefault(); });
    start.addEventListener('click', function (e) {
      var b = e.target.closest('.mv-mb-menu');
      if (!b) return;
      if (openKey === b.dataset.menu) { MV.menu.close(); return; }
      openMenu(b.dataset.menu, b);
    });
    // With one menu open, sliding across the titles opens each in turn.
    start.addEventListener('mouseover', function (e) {
      var b = e.target.closest('.mv-mb-menu');
      if (b && openKey && openKey !== b.dataset.menu) openMenu(b.dataset.menu, b);
    });

    var end = document.createElement('div');
    end.className = 'mv-mb-end';
    var status = document.createElement('div');
    status.className = 'mv-mb-status';

    engineEl = document.createElement('button');
    engineEl.type = 'button';
    engineEl.className = 'mv-mb-si';
    engineEl.hidden = true;
    engineEl.innerHTML = '<span class="mv-mb-lamp"></span><span></span>';
    engineEl.addEventListener('click', function () { if (engineEl.dataset.app) MV.wm.open(engineEl.dataset.app); });
    status.appendChild(engineEl);

    ['live-speed-module-container', 'panel-status-lights', 'btn-notifications'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) status.appendChild(el);
    });

    var find = document.createElement('button');
    find.type = 'button';
    find.className = 'mv-mb-si mv-mb-find';
    find.title = 'جست‌وجو (Ctrl K)';
    find.setAttribute('aria-label', 'جست‌وجو');
    find.innerHTML = MV.icons.svg('g-search');
    find.addEventListener('click', function () { if (MV.spotlight) MV.spotlight.toggle(); });
    status.appendChild(find);

    clockEl = document.createElement('span');
    clockEl.className = 'mv-mb-si mv-mb-clock';
    status.appendChild(clockEl);
    end.appendChild(status);

    if (hasElectron()) {
      var cap = document.createElement('div');
      cap.className = 'mv-caption';
      cap.innerHTML =
        '<button type="button" data-cap="min" aria-label="کوچک کردن برنامه">' + MV.icons.svg('g-cap-min') + '</button>' +
        '<button type="button" data-cap="max" aria-label="بزرگ کردن برنامه">' + MV.icons.svg('g-cap-max') + '</button>' +
        '<button type="button" data-cap="close" class="is-close" aria-label="بستن به سینی">' + MV.icons.svg('g-cap-close') + '</button>';
      cap.addEventListener('click', function (e) {
        var b = e.target.closest('[data-cap]');
        if (!b) return;
        ipc({ min: 'window:minimize', max: 'window:maximize', close: 'window:close' }[b.dataset.cap]);
      });
      end.appendChild(cap);
    }

    bar.appendChild(start);
    bar.appendChild(end);
    document.body.appendChild(bar);

    updateApp();
    updateClock();
    setInterval(updateClock, 15000);
    MV.wm.onChange(updateApp);
  }

  MV.menubar = {
    build: build,
    updateEngine: updateEngine,
    open: function (key) { var b = bar && bar.querySelector('[data-menu="' + key + '"]'); if (b) openMenu(key, b); },
  };
})();
