/* =====================================================================
   Notification Centre — the bell in the menu bar.
   ---------------------------------------------------------------------
   Keeps what the app actually announced: every triggerNotification()
   the user has not switched off (scan finished, engine started, …) and
   the error/warning banners. The per-type switches that used to sit in
   the bell's little menu now live in Settings › اعلان‌ها, next to the
   Windows permission they depend on.
   History: last 60 entries, per viewer (localStorage 'mv-notif-history').
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var KEY = 'mv-notif-history';
  var MAX = 60;
  var items = read();
  var unread = 0;
  var panel = null;

  function read() {
    try { var v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX))); } catch (e) { /* storage blocked */ } }

  var TONE_BY_ID = {
    scanFinished: ['var(--mv-blue)', 'ph-bold ph-magnifying-glass'],
    delayFinished: ['var(--mv-indigo)', 'ph-bold ph-clock'],
    pingFinished: ['var(--mv-orange)', 'ph-bold ph-lightning'],
    v2rayStarted: ['var(--mv-indigo)', 'ph-bold ph-engine'],
    sniStarted: ['var(--mv-purple)', 'ph-bold ph-shield-check'],
    fixedIpFinished: ['var(--mv-pink)', 'ph-bold ph-globe-hemisphere-west'],
  };

  function add(entry) {
    items.unshift({ t: Date.now(), title: entry.title || '', text: entry.text || '', tint: entry.tint || 'var(--mv-blue)', icon: entry.icon || 'ph-bold ph-bell' });
    if (items.length > MAX) items.length = MAX;
    save();
    if (!panel) { unread++; badge(); } else renderList();
  }

  function badge() {
    var bell = document.getElementById('btn-notifications');
    if (!bell) return;
    var b = bell.querySelector('.mv-bell-badge');
    if (!unread) { if (b) b.remove(); return; }
    if (!b) { b = document.createElement('span'); b.className = 'mv-bell-badge'; bell.appendChild(b); }
    b.textContent = unread > 9 ? '۹+' : unread.toLocaleString('fa-IR');
  }

  var fTime = null;
  function when(t) {
    var d = Date.now() - t;
    if (d < 60000) return 'اکنون';
    if (d < 3600000) return Math.floor(d / 60000).toLocaleString('fa-IR') + ' دقیقه پیش';
    try { fTime = fTime || new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false }); return fTime.format(new Date(t)); }
    catch (e) { return new Date(t).toLocaleTimeString(); }
  }
  function sameDay(a, b) { var x = new Date(a), y = new Date(b); return x.toDateString() === y.toDateString(); }

  function renderList() {
    if (!panel) return;
    var list = panel.querySelector('.mv-nc-list');
    if (!items.length) {
      list.innerHTML = '<div class="mv-empty"><i class="ph-bold ph-bell-slash mv-empty-ic"></i><b>اعلانی نیست</b><p>پایان اسکن، روشن شدن موتورها و خطاها اینجا جمع می‌شوند.</p></div>';
      return;
    }
    var html = '', group = null, now = Date.now();
    items.forEach(function (n, i) {
      var g = sameDay(n.t, now) ? 'امروز' : 'قبل‌تر';
      if (g !== group) { group = g; html += '<div class="mv-nc-group">' + g + '</div>'; }
      html += '<div class="mv-banner mv-nc-item" data-i="' + i + '">' +
        '<span class="mv-banner-ic" style="--tint:' + n.tint + '"><i class="' + MV.esc(n.icon) + '"></i></span>' +
        '<div class="mv-banner-body"><div class="mv-banner-title"><b>' + MV.esc(n.title || 'MLMVPN') + '</b><span>' + when(n.t) + '</span></div>' +
        (n.text ? '<div class="mv-banner-text">' + MV.esc(n.text) + '</div>' : '') + '</div></div>';
    });
    list.innerHTML = html;
  }

  function open() {
    if (panel) return;
    unread = 0; badge();
    // As on macOS, opening the centre clears the banners: they are in the list now.
    document.querySelectorAll('.mv-banners > .mv-banner').forEach(function (b) { b.remove(); });
    panel = document.createElement('aside');
    panel.className = 'mv-nc';
    panel.setAttribute('aria-label', 'مرکز اعلان‌ها');
    panel.innerHTML =
      '<div class="mv-nc-head"><b>اعلان‌ها</b><button type="button" class="mv-btn mv-btn--plain mv-btn--sm" data-act="clear">پاک کردن همه</button></div>' +
      '<div class="mv-nc-list"></div>' +
      '<div class="mv-nc-foot"><button type="button" class="mv-btn mv-btn--sm" data-act="settings">تنظیمات اعلان‌ها</button></div>';
    panel.addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'clear') { items = []; save(); renderList(); }
      if (b.dataset.act === 'settings') { close(); MV.wm.open('settings', { pane: 'notifications' }); }
    });
    document.body.appendChild(panel);
    renderList();
    setTimeout(function () { document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true); }, 0);
  }
  function outside(e) { if (panel && !panel.contains(e.target) && !e.target.closest('#btn-notifications')) close(); }
  function esc(e) { if (e.key === 'Escape') close(); }
  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', esc, true);
  }

  // ── Settings › اعلان‌ها ─────────────────────────────────────────────────
  // The pane is added at runtime so the old layout (the per-user «چیدمان قدیمی»)
  // keeps its bell menu untouched.
  // Built with the page kit, like every Settings pane: a sidebar item (under «ظاهر», where
  // System Settings keeps Notifications) and a grouped form.
  function mountSettingsPane() {
    var group = document.getElementById('mv-set-group-look');
    var content = document.getElementById('panel-set-appearance');
    if (!group || !content || document.getElementById('panel-set-notifications')) return;

    var btn = document.createElement('button');
    btn.id = 'btn-set-notifications';
    btn.setAttribute('onclick', "switchSettingsTab('notifications')");
    btn.className = 'settings-nav-btn mv-side-item';
    btn.dataset.kw = 'notifications alerts bell permission اعلان زنگ اجازه';
    btn.innerHTML = '<span class="mv-side-tile" style="--tint:var(--mv-red)"><i class="ph-fill ph-bell"></i></span><span>اعلان‌ها</span>';
    group.appendChild(btn);

    var pane = document.createElement('div');
    pane.id = 'panel-set-notifications';
    pane.className = 'settings-panel-content mv-form';
    pane.style.display = 'none';
    // No opening card — System Settings › Notifications starts straight with its groups.
    pane.innerHTML =
      '<div class="mv-form-section"><div class="mv-form-group"><div class="mv-form-row">' +
        '<div class="mv-form-label">اعلان‌های ویندوز<small class="mv-nc-perm"></small></div>' +
        '<span class="mv-form-control mv-nc-perm-btn"></span></div></div></div>' +
      '<div class="mv-form-section"><div class="mv-form-header">کدام رویدادها اعلان شوند</div>' +
        '<div class="mv-form-group mv-nc-types"></div>' +
        '<p class="mv-form-footer">هر رویدادی که روشن باشد، در مرکز اعلان‌ها هم می‌ماند — حتی اگر ویندوز اجازه‌ی نمایش اعلان را نداده باشد.</p></div>';
    content.parentNode.insertBefore(pane, content.nextSibling);

    var list = document.getElementById('notif-settings-list');
    if (list) { list.classList.remove('max-h-[60vh]'); pane.querySelector('.mv-nc-types').appendChild(list); }
    var perm = document.getElementById('btn-notif-perm');
    if (perm) { perm.className = 'mv-btn mv-btn--sm'; pane.querySelector('.mv-nc-perm-btn').appendChild(perm); }
  }

  function syncPerm() {
    var el = document.querySelector('.mv-nc-perm');
    if (!el) return;
    var p = ('Notification' in window) ? Notification.permission : 'unsupported';
    el.textContent = p === 'granted' ? 'اجازه داده شده؛ اعلان‌ها روی ویندوز هم نمایش داده می‌شوند.'
      : p === 'denied' ? 'ویندوز اجازه نداده است. از تنظیمات اعلان‌های ویندوز، MLM VPN را روشن کنید.'
        : p === 'unsupported' ? 'این سیستم اعلان دسکتاپ ندارد.'
          : 'هنوز اجازه گرفته نشده است.';
  }

  function init() {
    // Record what the app announces, only if the user left that type switched on.
    var orig = window.triggerNotification;
    if (typeof orig === 'function') {
      window.triggerNotification = function (id, title, message, bypass) {
        var allowed = bypass || !(window.notificationSettings && window.notificationSettings[id] === false);
        if (allowed && id !== 'test') {
          var tone = TONE_BY_ID[id] || ['var(--mv-blue)', 'ph-bold ph-bell'];
          add({ title: title, text: message, tint: tone[0], icon: tone[1] });
        }
        return orig.apply(this, arguments);
      };
    }
    MV.onBanner(function (b) { add({ title: 'MLMVPN', text: b.text, tint: b.tint, icon: b.icon }); });
    // The bell opens the centre; its old menu of switches moved to Settings.
    window.toggleNotificationMenu = function () { if (panel) close(); else open(); };
    mountSettingsPane();
  }

  MV.notify = { init: init, open: open, close: close, syncPerm: syncPerm, renderSettings: function () {
    syncPerm();
    if (typeof window.renderNotificationMenu === 'function') window.renderNotificationMenu();
    else if (typeof renderNotificationMenu === 'function') renderNotificationMenu();
  } };
})();
