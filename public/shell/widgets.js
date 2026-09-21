/* =====================================================================
   Desktop widgets — every number on them comes from the app itself.
   ---------------------------------------------------------------------
   • وضعیت اتصال — the engine probes in shell/apps.js; for quick connect,
     the path and the exit country as measured from inside the tunnel.
   • ترافیک امروز — the same payload the old header counter received
     (updateHeaderTrafficUI) and the live speed (updateLiveSpeed); both
     are wrapped, never re-fetched. The user's «disable» settings win.
   • پنل‌های ابری — the three lamps updatePanelStatusLights() keeps.
   • ساعت — Persian and Gregorian date.  • تازه‌ها — CHANGELOG.
   Nothing is invented: with no data a widget says so.
   Visibility per user: 'mv-widgets' = { hidden: [...] }.
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var host = null;
  var hidden = readHidden();
  var LIST = [
    { id: 'conn', title: 'وضعیت اتصال', side: 'start' },
    { id: 'traffic', title: 'ترافیک امروز', side: 'start' },
    { id: 'cloud', title: 'پنل‌های ابری', side: 'start' },
    { id: 'clock', title: 'ساعت', side: 'end' },
    { id: 'news', title: 'تازه‌ها', side: 'end' },
  ];
  var els = {};
  var upSince = {};          // engine id -> time we first saw it up (this session)
  var speeds = [];           // last download speeds, for the sparkline
  var lastTraffic = null;

  function readHidden() {
    try {
      var raw = window.PersistentStorage && PersistentStorage.getItem('mv-widgets');
      var v = raw ? JSON.parse(raw) : null;
      if (v && Array.isArray(v.hidden)) return v.hidden;
    } catch (e) { /* default */ }
    return [];
  }
  function saveHidden() { MV.store('mv-widgets', JSON.stringify({ hidden: hidden })); }

  function fmtBytes(n) {
    if (typeof window.formatBytes === 'function') return window.formatBytes(n || 0);
    return (n || 0) + ' B';
  }
  function checked(id) { var el = document.getElementById(id); return !!(el && el.checked); }
  function esc(s) { return MV.esc(s); }

  // ── وضعیت اتصال ──────────────────────────────────────────────────────────
  // EVERY ENGINE THAT CAN BE UP, or the widget says «قطع» over a live connection.
  //
  // The list is written out rather than derived because not every app in the registry is an
  // engine — but that also means a new engine has to be added HERE as well as to the registry,
  // and three of them (gateway, psiphon, tor) were missing until 2026-09-12: their windows said
  // "connected" while the desktop's own status widget said nothing was.
  //
  // Ordered by what a user would consider the headline when two are up at once: the gateway and
  // the WARP engines carry the whole machine, the rest carry what is pointed at them.
  // Same hand-written list as menubar.js ENGINE_ORDER, and the same trap: «اوپن‌وی‌پی‌ان» was
  // missing, so a live OpenVPN tunnel left this widget saying «هیچ مسیری فعال نیست».
  var ENGINES = ['quick', 'v2ray', 'gateway', 'openvpn', 'masque', 'wireguard', 'warp_on_warp', 'psiphon', 'tor',
    'lantern', 'geph', 'gst', 'github', 'vodi', 'sni', 'sanction'];

  function renderConn() {
    var el = els.conn;
    if (!el) return;
    var up = ENGINES.filter(function (id) { return MV.apps.engineUp(id); });
    var now = Date.now();
    ENGINES.forEach(function (id) { if (up.indexOf(id) > -1) { if (!upSince[id]) upSince[id] = now; } else delete upSince[id]; });
    var body;
    if (!up.length) {
      body =
        '<div class="mv-wg-head"><span>وضعیت اتصال</span><span class="mv-pill"><span class="mv-lampdot"></span>قطع</span></div>' +
        '<p class="mv-wg-muted">هیچ مسیری فعال نیست؛ ترافیک مستقیم از خط شما می‌رود.</p>' +
        '<button type="button" class="mv-btn mv-btn--primary mv-btn--sm mv-wg-cta" data-open="quick">اتصال سریع</button>';
    } else {
      var main = MV.apps.get(up[0]);
      var extra = '';
      if (up[0] === 'quick' && window.MVProbe && window.MVProbe.quickInfo) {
        var info = window.MVProbe.quickInfo();
        var mode = info.mode === 'tunnel' ? 'تونل کامل' : info.mode === 'proxy' ? 'پروکسی سیستم' : '';
        if (info.country) {
          var name = typeof window.getCountryName === 'function' ? window.getCountryName(info.country) : info.country;
          extra += '<div class="mv-wg-country"><img alt="" src="assets/flags/' + esc(info.country.toLowerCase()) + '.svg" onerror="this.remove()"><div><b>' + esc(name) + '</b><small>کشور خروج از داخل خود تونل تأیید شد</small></div></div>';
        }
        if (mode) extra += '<div class="mv-wg-line"><span>مسیر</span><b>' + mode + '</b></div>';
      }
      // What a gateway session can say about itself that the icon cannot: which relay, and how
      // many parallel streams are carrying it — the second one is the number that explains the
      // speed, so it belongs where the user is looking.
      if (up[0] === 'gateway' && window.MVProbe && window.MVProbe.gatewayInfo) {
        var gi = window.MVProbe.gatewayInfo();
        if (gi.host) extra += '<div class="mv-wg-line"><span>سرور</span><b style="direction:ltr">' + esc(gi.host) + '</b></div>';
        if (gi.tcp) extra += '<div class="mv-wg-line"><span>اتصال موازی</span><b>' + esc(gi.tcp) + ' از ' + esc(gi.maxTcp) + '</b></div>';
      }
      var since = upSince[up[0]];
      var mins = since ? Math.floor((now - since) / 60000) : null;
      var others = up.slice(1).map(function (id) { return MV.apps.label(MV.apps.get(id)); });
      body =
        '<div class="mv-wg-head"><span>وضعیت اتصال</span><span class="mv-pill is-ok"><span class="mv-lampdot"></span>متصل</span></div>' +
        '<div class="mv-wg-engine">' + MV.apps.iconHTML(main, 30) + '<div><b>' + esc(main.title) + '</b>' +
          (mins != null ? '<small>' + (mins < 1 ? 'همین حالا وصل شد' : mins.toLocaleString('fa-IR') + ' دقیقه است که وصل است') + '</small>' : '') + '</div></div>' +
        extra +
        (others.length ? '<div class="mv-wg-line"><span>همچنین روشن</span><b>' + esc(others.join('، ')) + '</b></div>' : '') +
        '<button type="button" class="mv-btn mv-btn--sm mv-wg-cta" data-open="' + esc(up[0]) + '">باز کردن ' + esc(MV.apps.label(main)) + '</button>';
    }
    if (el.__last !== body) { el.__last = body; el.querySelector('.mv-wg-body').innerHTML = body; }
  }

  // ── ترافیک امروز ─────────────────────────────────────────────────────────
  function renderTraffic() {
    var el = els.traffic;
    if (!el) return;
    // «غیرفعال شدن مانیتورینگ مصرف»: no figures arrive at all, so none are shown as current.
    var monOff = checked('setting-disable-monitoring');
    var off = checked('setting-disable-total-traffic');
    var speedOff = monOff || checked('setting-disable-live-speed');
    var t = lastTraffic;
    var now = speeds.length ? speeds[speeds.length - 1] : 0;
    var html =
      '<div class="mv-wg-head"><span>ترافیک امروز</span>' + (speedOff ? '' : '<span class="mv-wg-muted">اکنون ' + esc(fmtBytes(now)) + '/ث</span>') + '</div>';
    if (monOff) {
      html += '<p class="mv-wg-muted">مانیتورینگ مصرف در تنظیمات › برنامه خاموش است.</p>';
    } else if (off) {
      html += '<p class="mv-wg-muted">آمار حجم در تنظیمات › برنامه خاموش است.</p>';
    } else if (!t || !t.today) {
      html += '<p class="mv-wg-muted">هنوز داده‌ای از موتور نرسیده است.</p>';
    } else {
      html +=
        '<div class="mv-wg-traffic"><div><small>↓ دانلود</small><b>' + esc(fmtBytes(t.today.down)) + '</b></div>' +
        '<div><small>↑ آپلود</small><b>' + esc(fmtBytes(t.today.up)) + '</b></div></div>';
    }
    if (!speedOff && speeds.length > 1) html += spark();
    el.querySelector('.mv-wg-body').innerHTML = html;
  }

  function spark() {
    var W = 232, H = 34, n = speeds.length, max = Math.max.apply(null, speeds.concat([1]));
    var pts = speeds.map(function (v, i) { return [Math.round(i / (n - 1) * W), Math.round(H - 3 - v / max * (H - 8))]; });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ' ' + p[1]; }).join(' ');
    var last = pts[pts.length - 1];
    return '<svg class="mv-wg-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="' + line + ' L' + W + ' ' + H + ' L0 ' + H + 'Z" fill="var(--mv-accent-soft)"/>' +
      '<path d="' + line + '" fill="none" stroke="var(--mv-accent)" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.6" fill="var(--mv-accent)"/></svg>';
  }

  function hookTraffic() {
    var origT = window.updateHeaderTrafficUI;
    if (typeof origT === 'function') {
      window.updateHeaderTrafficUI = function (data) {
        var r = origT.apply(this, arguments);
        lastTraffic = data;
        renderTraffic();
        return r;
      };
    }
    var origS = window.updateLiveSpeed;
    if (typeof origS === 'function') {
      window.updateLiveSpeed = function (t) {
        var r = origS.apply(this, arguments);
        if (t && t.speed) { speeds.push(Math.max(0, t.speed.down || 0)); if (speeds.length > 40) speeds.shift(); }
        return r;
      };
    }
  }

  // ── پنل‌های ابری ──────────────────────────────────────────────────────────
  var LAMP_STATE = { '#81c995': 'is-ok', '#fde293': 'is-warn', '#f28b82': 'is-bad' };
  function renderCloud() {
    var el = els.cloud;
    if (!el) return;
    var panels = [['bpb', 'BPB'], ['edge', 'Edge'], ['zeus', 'Zeus']].map(function (p) {
      var lamp = document.getElementById('light-' + p[0]);
      var bg = lamp ? String(lamp.style.background || '').toLowerCase() : '';
      var hex = (bg.match(/#[0-9a-f]{6}/) || [])[0] || rgbToHex(bg);
      return { name: p[1], state: LAMP_STATE[hex] || '', tip: lamp ? (lamp.getAttribute('data-tooltip') || lamp.getAttribute('title') || '') : '' };
    });
    var html = '<div class="mv-wg-head"><span>پنل‌های ابری</span></div>';
    // With no Cloudflare account all three lamps say the same thing; say it once.
    if (panels.every(function (p) { return !p.state && p.tip === panels[0].tip; })) {
      html += '<p class="mv-wg-muted">' + esc(panels[0].tip || 'هنوز حساب کلودفلری وصل نشده است.') + '</p>';
    } else {
      html += panels.map(function (p) {
        return '<div class="mv-wg-cloud-row ' + p.state + '"><span class="mv-lampdot"></span><b class="mv-latin">' + p.name + '</b><span title="' + esc(p.tip) + '">' + esc(p.tip) + '</span></div>';
      }).join('');
    }
    el.querySelector('.mv-wg-body').innerHTML = html + '<button type="button" class="mv-btn mv-btn--sm mv-wg-cta" data-open="cloud">باز کردن ابری</button>';
  }
  function rgbToHex(s) {
    var m = s.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return '';
    return '#' + [m[1], m[2], m[3]].map(function (x) { return (+x).toString(16).padStart(2, '0'); }).join('');
  }
  function hookCloud() {
    ['light-bpb', 'light-edge', 'light-zeus'].forEach(function (id) {
      var l = document.getElementById(id);
      if (l) new MutationObserver(renderCloud).observe(l, { attributes: true, attributeFilter: ['style', 'data-tooltip'] });
    });
  }

  // ── ساعت ─────────────────────────────────────────────────────────────────
  var fT = null, fD = null, fG = null;
  function renderClock() {
    var el = els.clock;
    if (!el) return;
    try {
      fT = fT || new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false });
      fD = fD || new Intl.DateTimeFormat('fa-IR-u-ca-persian', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      fG = fG || new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
      var d = new Date();
      el.querySelector('.mv-wg-body').innerHTML = '<div class="mv-wg-time">' + fT.format(d) + '</div><div class="mv-wg-date">' + fD.format(d) + '</div><div class="mv-wg-greg mv-latin">' + fG.format(d) + '</div>';
    } catch (e) { /* no Intl: leave it */ }
  }

  // ── تازه‌ها ──────────────────────────────────────────────────────────────
  function renderNews() {
    var el = els.news;
    if (!el) return;
    var list = [];
    try { list = (typeof CHANGELOG !== 'undefined' ? CHANGELOG : []).slice(0, 3); } catch (e) { list = []; }
    var html = '<div class="mv-wg-head"><span>تازه‌ها</span><button type="button" class="mv-wg-link" data-open="changelog">همه</button></div>';
    if (!list.length) html += '<p class="mv-wg-muted">فهرست تغییرات در دسترس نیست.</p>';
    list.forEach(function (v) {
      html += '<button type="button" class="mv-wg-news" data-open="changelog"><b>' + esc(v.title) + '</b><small>نسخه‌ی ' + esc(v.version) + (v.date ? ' · ' + esc(v.date) : '') + '</small></button>';
    });
    el.querySelector('.mv-wg-body').innerHTML = html;
  }

  // ── Frame ────────────────────────────────────────────────────────────────
  function applyVisibility() {
    LIST.forEach(function (w) { if (els[w.id]) els[w.id].hidden = hidden.indexOf(w.id) > -1; });
    host.dataset.start = String(LIST.some(function (w) { return w.side === 'start' && hidden.indexOf(w.id) < 0; }));
    host.dataset.end = String(LIST.some(function (w) { return w.side === 'end' && hidden.indexOf(w.id) < 0; }));
    document.documentElement.dataset.widgetsStart = host.dataset.start;
    document.documentElement.dataset.widgetsEnd = host.dataset.end;
  }

  function editMenu(at) {
    MV.menu.open({
      anchor: at,
      atPoint: true,
      items: LIST.map(function (w) {
        var on = hidden.indexOf(w.id) < 0;
        return { label: w.title, checked: on, action: function () {
          if (on) hidden.push(w.id); else hidden = hidden.filter(function (x) { return x !== w.id; });
          saveHidden();
          applyVisibility();
        } };
      }),
    });
  }

  function build(container) {
    host = container;
    var cols = { start: document.createElement('div'), end: document.createElement('div') };
    cols.start.className = 'mv-widgets-col is-start';
    cols.end.className = 'mv-widgets-col is-end';
    LIST.forEach(function (w) {
      var el = document.createElement('section');
      el.className = 'mv-widget mv-widget--' + w.id;
      el.setAttribute('aria-label', w.title);
      el.innerHTML = '<div class="mv-wg-body"></div>';
      cols[w.side].appendChild(el);
      els[w.id] = el;
    });
    host.appendChild(cols.start);
    host.appendChild(cols.end);
    host.addEventListener('click', function (e) {
      var b = e.target.closest('[data-open]');
      if (b) MV.wm.open(b.dataset.open);
    });
    host.addEventListener('contextmenu', function (e) {
      if (!e.target.closest('.mv-widget')) return;
      e.preventDefault();
      editMenu({ x: e.clientX, y: e.clientY });
    });
    applyVisibility();
    hookTraffic();
    // A switch in Settings › برنامه changes what this widget may show (settings.js).
    document.addEventListener('mv-traffic-prefs', renderTraffic);
    hookCloud();
    renderConn(); renderTraffic(); renderCloud(); renderClock(); renderNews();
    setInterval(renderClock, 15000);
  }

  MV.widgets = { build: build, tick: renderConn, editMenu: editMenu };
})();
