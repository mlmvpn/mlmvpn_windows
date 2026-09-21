/* =====================================================================
   Dock — the main navigation.
   ---------------------------------------------------------------------
   «میزکار» first, then the pinned apps (scanner, V2Ray, settings, cloud —
   the Android dock's order), a divider, and every other app that has a
   window open or an engine up. A dot under an icon = its window is open;
   the green lamp on it = that engine is carrying traffic right now; the
   thin bar = the scan / combine / V2Ray test in progress.

   Magnification is pure CSS (:hover and :has), so the pointer never makes
   the page change a class. Pins are remembered per user ('mv-dock').
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var el = null;
  var pins = readPins();

  function readPins() {
    try {
      var raw = window.PersistentStorage && PersistentStorage.getItem('mv-dock');
      var v = raw ? JSON.parse(raw) : null;
      if (v && Array.isArray(v.pins)) {
        return v.pins
          .map(function (id) { return id === 'aether' ? MV.apps.lastWarpApp() : id; })
          .filter(function (id, i, all) { return MV.apps.get(id) && all.indexOf(id) === i; });
      }
    } catch (e) { /* default */ }
    return MV.apps.dock();
  }
  function savePins() { MV.store('mv-dock', JSON.stringify({ pins: pins })); }

  function item(id, label, iconHTML, short) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mv-dock-item';
    b.dataset.app = id;
    b.setAttribute('aria-label', label);
    // The full title is the hover tooltip; the short name is what sits under the icon when
    // Settings › ظاهر › «نام زیر آیکون‌های داک» is on, the way Android shows dock names.
    b.innerHTML = iconHTML + '<span class="mv-dock-label"></span><span class="mv-dock-name" dir="auto"></span>';
    b.querySelector('.mv-dock-label').textContent = label;
    b.querySelector('.mv-dock-name').textContent = short || label;
    return b;
  }

  function render() {
    if (!el) return;
    var running = MV.wm.list().filter(function (w) { return w.open; }).map(function (w) { return w.id; });
    MV.apps.all().forEach(function (a) { if (a.engine && MV.apps.engineUp(a.id) && running.indexOf(a.id) < 0) running.push(a.id); });
    var extra = running.filter(function (id) { return pins.indexOf(id) < 0 && MV.apps.get(id) && !MV.apps.get(id).run; });

    var want = ['desk'].concat(pins, extra.length ? ['|'] : [], extra).join(',');
    if (el.dataset.layout !== want) {
      el.dataset.layout = want;
      el.innerHTML = '';
      var desk = item('desk', 'میزکار', '<span class="mv-ic" style="--sz:48px;--tint:#6A7797">' + MV.icons.svg('g-launch') + '</span>');
      el.appendChild(desk);
      pins.concat(extra.length ? ['|'] : [], extra).forEach(function (id) {
        if (id === '|') { var s = document.createElement('span'); s.className = 'mv-dock-sep'; el.appendChild(s); return; }
        var app = MV.apps.get(id);
        if (!app) return;
        el.appendChild(item(id, app.title, MV.apps.iconHTML(app, 48), MV.apps.label(app)));
      });
    }
    // Dots and lamps change far more often than the layout.
    el.querySelectorAll('.mv-dock-item').forEach(function (b) {
      var id = b.dataset.app;
      if (id === 'desk') return;
      b.classList.toggle('is-running', MV.wm.isOpen(id));
      setLamp(b.querySelector('.mv-ic'), MV.apps.engineUp(id));
    });
    // A rebuilt row starts without its progress bars; put the last known ones back.
    Object.keys(progress).forEach(function (id) { drawProgress(id, progress[id]); });
  }

  var progress = {};

  function setLamp(ic, on) {
    if (!ic) return;
    var lamp = ic.querySelector('.mv-lamp');
    if (on && !lamp) { lamp = document.createElement('span'); lamp.className = 'mv-lamp'; ic.appendChild(lamp); }
    if (!on && lamp) lamp.remove();
  }

  function setProgress(id, fraction) {
    if (fraction == null) delete progress[id]; else progress[id] = fraction;
    drawProgress(id, fraction);
  }

  function drawProgress(id, fraction) {
    if (!el) return;
    var b = el.querySelector('.mv-dock-item[data-app="' + id + '"]');
    var ic = b && b.querySelector('.mv-ic');
    if (!ic) return;
    var bar = ic.querySelector('.mv-dock-prog');
    if (fraction == null) { if (bar) bar.remove(); return; }
    if (!bar) { bar = document.createElement('span'); bar.className = 'mv-dock-prog'; bar.innerHTML = '<i></i>'; ic.appendChild(bar); }
    bar.firstChild.style.width = Math.max(0, Math.min(100, fraction * 100)) + '%';
  }

  function onClick(e) {
    var b = e.target.closest('.mv-dock-item');
    if (!b) return;
    var id = b.dataset.app;
    if (id === 'desk') { MV.wm.showDesktop(); return; }
    // A second click on the focused, visible app puts it in the dock — as on macOS.
    if (MV.wm.active() === id && MV.wm.isOpen(id) && !MV.wm.isMinimized(id)) { MV.wm.minimize(id); return; }
    if (!MV.wm.isOpen(id)) bounce(b);
    MV.wm.open(id);
  }

  function bounce(b) {
    b.classList.add('is-bouncing');
    setTimeout(function () { b.classList.remove('is-bouncing'); }, 650);
  }

  function onContext(e) {
    var b = e.target.closest('.mv-dock-item');
    if (!b) return;
    e.preventDefault();
    var id = b.dataset.app;
    if (id === 'desk') return;
    var app = MV.apps.get(id);
    var pinned = pins.indexOf(id) > -1;
    var open = MV.wm.isOpen(id);
    MV.menu.open({
      anchor: b.getBoundingClientRect(),
      items: [
        { label: open ? 'نمایش پنجره' : 'باز کردن', action: function () { MV.wm.open(id); } },
        { sep: true },
        { label: 'نگه‌داشتن در داک', checked: pinned, action: function () {
          if (pinned) pins = pins.filter(function (x) { return x !== id; }); else pins.push(id);
          savePins();
          render();
        } },
        { sep: true },
        { label: 'بستن پنجره', disabled: !open, action: function () { MV.wm.close(id); } },
      ],
    });
    // Menus open under their anchor; from the dock they belong above it.
    var m = document.querySelector('.mv-menu');
    if (m && app) {
      var r = b.getBoundingClientRect();
      m.style.top = Math.max(6, r.top - m.offsetHeight - 8) + 'px';
      m.style.left = Math.max(6, Math.min(r.left + r.width / 2 - m.offsetWidth / 2, window.innerWidth - m.offsetWidth - 6)) + 'px';
    }
  }

  // Mirror the progress rows (scan, combine, V2Ray test) onto their dock icons. Scan and
  // combine both belong to the scanner; whichever is running shows.
  var sources = {};
  function watchProgress(containerId, barId, appId) {
    var box = document.getElementById(containerId), bar = document.getElementById(barId);
    if (!box || !bar) return;
    sources[appId] = sources[appId] || {};
    function sync() {
      sources[appId][containerId] = box.style.display === 'none' ? null : (parseFloat(bar.style.width) || 0) / 100;
      var shown = null;
      Object.keys(sources[appId]).forEach(function (k) { if (sources[appId][k] != null && shown == null) shown = sources[appId][k]; });
      setProgress(appId, shown);
    }
    new MutationObserver(sync).observe(box, { attributes: true, attributeFilter: ['style'] });
    new MutationObserver(sync).observe(bar, { attributes: true, attributeFilter: ['style'] });
    sync();
  }

  function build() {
    el = document.createElement('nav');
    el.className = 'mv-dock';
    el.setAttribute('aria-label', 'داک');
    el.addEventListener('click', onClick);
    el.addEventListener('contextmenu', onContext);
    document.body.appendChild(el);
    render();
    MV.wm.onChange(render);
    watchProgress('footer-progress-container', 'footer-progress-bar', 'scanner');
    watchProgress('combo-footer-progress-container', 'combo-footer-progress-bar', 'scanner');
    watchProgress('v2ray-footer-progress-container', 'v2ray-footer-progress-bar', 'v2ray');
  }

  MV.dock = {
    build: build,
    render: render,
    iconRect: function (id) {
      if (!el) return null;
      var b = el.querySelector('.mv-dock-item[data-app="' + id + '"]') || el.querySelector('.mv-dock-item[data-app="desk"]');
      return b ? b.getBoundingClientRect() : null;
    },
    pins: function () { return pins.slice(); },
    pin: function (id) {
      var app = MV.apps.get(id);
      if (!app || app.run || pins.indexOf(id) > -1) return false;
      pins.push(id); savePins(); relayout();
      return true;
    },
    unpin: function (id) { pins = pins.filter(function (x) { return x !== id; }); savePins(); relayout(); },
    setPins: function (order) {
      pins = order.filter(function (id) { return MV.apps.get(id) && !MV.apps.get(id).run; });
      savePins(); relayout();
    },
  };

  function relayout() { if (el) { el.dataset.layout = ''; render(); } }
})();
