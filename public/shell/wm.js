/* =====================================================================
   Window manager — every tool of the app lives in a window on the desktop.
   ---------------------------------------------------------------------
   MV.wm.open(id, opts)   create on first use, then show / restore / focus
   MV.wm.close(id)        hide only: the panel inside keeps its state and
                          anything it runs (a connection stays connected)
   MV.wm.minimize(id)     into its dock icon;   MV.wm.zoom(id)  fill the desktop
   MV.wm.showDesktop()    everything aside, and back again

   Rules this file keeps:
   • Windows never carry a transform at rest — a transformed ancestor would
     turn every position:fixed inside a panel into position:absolute.
     Transforms appear only for the length of an open/minimise animation.
   • Moving and resizing touch only style.left/top/width/height. Runtime
     Tailwind rescans the document on every class change, so no class is
     toggled per pointer move.
   • Frames, open windows and the focused one are remembered per user
     ('mv-wm'); the next launch puts the desk back the way it was left.
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var svg = MV.icons.svg;
  var DOCK_RESERVE = 84;   // the dock's height plus its gap: new windows open above it
  // A maximised or edge-snapped window takes the whole height and runs under the dock; the dock
  // then shrinks (html.mv-dock-compact, shell.css) so it takes less of the user's attention.
  var CASCADE = 28;
  var EDGE = 6;            // px from the desktop edge that triggers snapping

  var wins = {};           // id -> window state
  var order = [];          // open windows, bottom -> top
  var activeId = null;
  var stash = null;        // windows put aside by showDesktop()
  var listeners = [];
  var layer = null;
  var snapEl = null;
  var saveTimer = null;
  var persisted = read();

  function read() {
    try {
      var raw = window.PersistentStorage && PersistentStorage.getItem('mv-wm');
      var v = raw ? JSON.parse(raw) : null;
      return v && typeof v === 'object' ? v : {};
    } catch (e) { return {}; }
  }

  // Is any window on screen reaching down into the dock? Then the dock goes compact. Measured
  // against the dock's full (unscaled) width, so shrinking it can never flip the answer back.
  function syncDock() {
    if (!layer) return;
    var a = area();
    var dock = document.querySelector('.mv-dock');
    var dw = dock ? dock.offsetWidth : 0;
    var dl = (a.w - dw) / 2, dr = dl + dw;
    var under = order.some(function (id) {
      var w = wins[id];
      if (!w || !w.open || w.minimized) return false;
      var f = w.zoomed ? zoomFrame() : w.frame;
      if (!f) return false;
      return f.y + f.h > a.h - DOCK_RESERVE + 6 && f.x < dr && f.x + f.w > dl;
    });
    document.documentElement.classList.toggle('mv-dock-compact', under);
  }

  function persist() {
    syncDock();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      var frames = Object.assign({}, persisted.frames || {});
      Object.keys(wins).forEach(function (id) {
        var w = wins[id];
        frames[id] = { x: w.frame.x, y: w.frame.y, w: w.frame.w, h: w.frame.h, z: !!w.zoomed };
      });
      var data = {
        v: 1,
        frames: frames,
        open: order.filter(function (id) { return wins[id] && wins[id].open; }),
        min: order.filter(function (id) { return wins[id] && wins[id].minimized; }),
        active: activeId,
      };
      persisted = data;
      MV.store('mv-wm', JSON.stringify(data));
    }, 400);
  }

  function emit() {
    listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error('[wm] listener failed:', e); } });
  }

  function ms(token) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    var n = parseFloat(v);
    return isNaN(n) ? 240 : (v.indexOf('ms') > -1 ? n : n * 1000);
  }

  function area() { return { w: layer.clientWidth, h: layer.clientHeight }; }

  function minSize(app) { return app.min || [360, 280]; }

  function clampFrame(f, app) {
    var a = area(), m = minSize(app);
    var w = Math.max(m[0], Math.min(f.w, a.w));
    var h = Math.max(m[1], Math.min(f.h, a.h));
    var x = Math.max(-(w - 120), Math.min(f.x, a.w - 120));
    var y = Math.max(0, Math.min(f.y, a.h - 60));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  function defaultFrame(app) {
    var a = area(), size = app.size || [520, 640];
    var w = Math.min(size[0], a.w - 40);
    var h = Math.min(size[1], a.h - DOCK_RESERVE - 24);
    var n = Object.keys(wins).length % 6;
    return {
      x: Math.round((a.w - w) / 2) + (n - 2) * CASCADE,
      y: Math.max(12, Math.round((a.h - DOCK_RESERVE - h) / 2) + (n - 2) * CASCADE),
      w: w,
      h: h,
    };
  }

  function zoomFrame() { var a = area(); return { x: 0, y: 0, w: a.w, h: a.h }; }

  function applyFrame(w) {
    var f = w.zoomed ? zoomFrame() : w.frame;
    var s = w.el.style;
    s.left = f.x + 'px';
    s.top = f.y + 'px';
    s.width = f.w + 'px';
    s.height = f.h + 'px';
  }

  function fireResize(w) {
    setTimeout(function () {
      try { w.el.dispatchEvent(new CustomEvent('mv:resize', { bubbles: false })); } catch (e) { /* ignore */ }
      if (w.app.onResize) { try { w.app.onResize(api(w)); } catch (e) { console.error(e); } }
    }, 0);
  }

  // What mount()/onShow() get to work with.
  function api(w) {
    return {
      id: w.id,
      app: w.app,
      el: w.el,
      body: w.el.querySelector('.mv-win-body'),
      tools: w.el.querySelector('.mv-win-tools'),
      status: w.el.querySelector('.mv-win-status'),
      state: w.state,
      setTitle: function (title, sub) {
        var t = w.el.querySelector('.mv-win-title');
        t.textContent = title;
        if (sub) { var s = document.createElement('small'); s.textContent = sub; t.appendChild(s); }
      },
    };
  }

  // ── Building a window ────────────────────────────────────────────────────
  function create(app) {
    var el = document.createElement('section');
    el.className = 'mv-win is-hidden' + (app.toolbar ? ' has-toolbar' : '') + (app.kind === 'utility' ? ' is-utility' : '') +
      // A sidebar window (System Settings style): no title bar of its own — see shell.css.
      (app.chrome === 'split' ? ' is-split' : '');
    el.dataset.app = app.id;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', app.title);
    el.tabIndex = -1;   // focusable by script only (see open), never a Tab stop itself
    el.innerHTML =
      '<header class="mv-win-bar">' +
        '<div class="mv-tl">' +
          '<button type="button" class="is-close" data-act="close" aria-label="بستن">' + svg('g-tl-c') + '</button>' +
          '<button type="button" class="is-min" data-act="min" aria-label="کوچک کردن">' + svg('g-tl-m') + '</button>' +
          '<button type="button" class="is-zoom" data-act="zoom" aria-label="بزرگ کردن"' + (app.noZoom ? ' disabled' : '') + '>' + svg('g-tl-z') + '</button>' +
        '</div>' +
        '<div class="mv-win-title"></div>' +
        '<div class="mv-win-tools"></div>' +
      '</header>' +
      '<div class="mv-win-body' + (app.flush ? ' is-flush' : '') + (app.row ? ' is-row' : '') + '"></div>' +
      '<div class="mv-win-status"></div>' +
      ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(function (e) { return '<div class="mv-rs" data-e="' + e + '"></div>'; }).join('');
    el.querySelector('.mv-win-title').textContent = app.title;
    return el;
  }

  function wire(w) {
    var el = w.el, bar = el.querySelector('.mv-win-bar');

    el.addEventListener('pointerdown', function () { if (activeId !== w.id) focus(w.id); }, true);

    el.querySelector('.mv-tl').addEventListener('click', function (e) {
      var b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      if (b.dataset.act === 'close') close(w.id);
      else if (b.dataset.act === 'min') minimize(w.id);
      else if (b.dataset.act === 'zoom') zoom(w.id);
    });

    bar.addEventListener('dblclick', function (e) {
      if (e.target.closest('.mv-tl, .mv-win-tools')) return;
      if (w.app.noZoom) return;
      zoom(w.id);
    });

    bar.addEventListener('pointerdown', function (e) {
      if (e.button !== 0 || e.target.closest('.mv-tl, .mv-win-tools, button, input, select, textarea, a')) return;
      startDrag(w, e);
    });

    el.querySelectorAll('.mv-rs').forEach(function (h) {
      h.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        e.stopPropagation();
        startResize(w, h.dataset.e, e);
      });
    });
  }

  // ── Moving, snapping, resizing ───────────────────────────────────────────
  function snapFor(px, py, a) {
    if (py <= 0) return { kind: 'zoom', frame: zoomFrame() };
    if (px <= EDGE) return { kind: 'half', frame: { x: 0, y: 0, w: Math.round(a.w / 2), h: a.h } };
    if (px >= a.w - EDGE) return { kind: 'half', frame: { x: Math.round(a.w / 2), y: 0, w: a.w - Math.round(a.w / 2), h: a.h } };
    return null;
  }

  function showSnap(s) {
    if (!s) { if (snapEl) snapEl.style.display = 'none'; return; }
    if (!snapEl) { snapEl = document.createElement('div'); snapEl.className = 'mv-snap'; layer.appendChild(snapEl); }
    snapEl.style.display = 'block';
    snapEl.style.left = s.frame.x + 'px';
    snapEl.style.top = s.frame.y + 'px';
    snapEl.style.width = s.frame.w + 'px';
    snapEl.style.height = s.frame.h + 'px';
  }

  function startDrag(w, e) {
    var target = e.currentTarget;
    var origin = layer.getBoundingClientRect();
    var start = { px: e.clientX, py: e.clientY, x: w.el.offsetLeft, y: w.el.offsetTop };
    var moved = false, snap = null;
    try { target.setPointerCapture(e.pointerId); } catch (err) { /* old engine */ }

    function move(ev) {
      var dx = ev.clientX - start.px, dy = ev.clientY - start.py;
      if (!moved) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        document.documentElement.classList.add('mv-dragging');
        if (w.zoomed) {
          // A zoomed window comes back to its own size under the pointer, as on macOS.
          var ratio = (ev.clientX - origin.left) / Math.max(1, area().w);
          w.zoomed = false;
          w.el.classList.remove('is-zoomed');
          start.x = Math.round(ev.clientX - origin.left - ratio * w.frame.w);
          start.y = 0;
          start.px = ev.clientX;
          start.py = ev.clientY;
          dx = 0; dy = 0;
          w.el.style.width = w.frame.w + 'px';
          w.el.style.height = w.frame.h + 'px';
        }
      }
      var f = clampFrame({ x: start.x + dx, y: start.y + dy, w: w.frame.w, h: w.frame.h }, w.app);
      w.frame.x = f.x;
      w.frame.y = f.y;
      w.el.style.left = f.x + 'px';
      w.el.style.top = f.y + 'px';
      snap = snapFor(ev.clientX - origin.left, ev.clientY - origin.top, area());
      showSnap(snap);
    }

    function up() {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('mv-dragging');
      showSnap(null);
      if (!moved) return;
      if (snap && snap.kind === 'zoom' && !w.app.noZoom) {
        zoom(w.id, true);
      } else if (snap && snap.kind === 'half') {
        w.frame = clampFrame(snap.frame, w.app);
        applyFrame(w);
        fireResize(w);
      }
      persist();
    }

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  function startResize(w, edge, e) {
    var target = e.currentTarget;
    var start = { px: e.clientX, py: e.clientY, f: Object.assign({}, w.frame) };
    var m = minSize(w.app), a = area();
    document.documentElement.classList.add('mv-resizing');
    try { target.setPointerCapture(e.pointerId); } catch (err) { /* old engine */ }

    function move(ev) {
      var dx = ev.clientX - start.px, dy = ev.clientY - start.py, s = start.f;
      var f = { x: s.x, y: s.y, w: s.w, h: s.h };
      if (edge.indexOf('e') > -1) f.w = Math.max(m[0], Math.min(s.w + dx, a.w - s.x));
      if (edge.indexOf('w') > -1) {
        var nw = Math.max(m[0], Math.min(s.w - dx, s.x + s.w));
        f.x = s.x + s.w - nw;
        f.w = nw;
      }
      if (edge.indexOf('s') > -1) f.h = Math.max(m[1], Math.min(s.h + dy, a.h - s.y));
      if (edge.indexOf('n') > -1) {
        var nh = Math.max(m[1], Math.min(s.h - dy, s.y + s.h));
        f.y = s.y + s.h - nh;
        f.h = nh;
      }
      w.frame = f;
      applyFrame(w);
    }

    function up() {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('mv-resizing');
      fireResize(w);
      persist();
    }

    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }

  // ── Showing, focusing, hiding ────────────────────────────────────────────
  function topVisible() {
    for (var i = order.length - 1; i >= 0; i--) {
      var w = wins[order[i]];
      if (w && w.open && !w.minimized) return w.id;
    }
    return null;
  }

  function focus(id) {
    var w = wins[id];
    if (!w || !w.open) return;
    order = order.filter(function (x) { return x !== id; });
    order.push(id);
    order.forEach(function (x, i) {
      var o = wins[x];
      o.el.style.zIndex = String(10 + i);
      o.el.classList.toggle('is-active', x === id && !o.minimized);
    });
    activeId = w.minimized ? topVisible() : id;
    emit();
    persist();
  }

  function show(w, animate) {
    w.el.classList.remove('is-hidden');
    if (animate) {
      w.el.classList.add('is-opening');
      setTimeout(function () { w.el.classList.remove('is-opening'); }, ms('--mv-d-3') + 40);
    }
  }

  function dockTarget(w) {
    var r = MV.dock && MV.dock.iconRect ? MV.dock.iconRect(w.id) : null;
    var me = w.el.getBoundingClientRect();
    return {
      dx: r ? (r.left + r.width / 2) - (me.left + me.width / 2) : 0,
      dy: r ? (r.top + r.height / 2) - (me.top + me.height / 2) : (window.innerHeight - me.top),
    };
  }

  function open(id, opts) {
    opts = opts || {};
    var app = MV.apps && MV.apps.get(id);
    if (!app) return null;
    if (app.run) { try { app.run(opts); } catch (e) { console.error('[wm] ' + id + ' failed:', e); } return null; }

    var w = wins[id];
    if (!w) {
      w = wins[id] = { id: id, app: app, el: create(app), state: {}, frame: null, zoomed: false, minimized: false, open: false, mounted: false };
      layer.appendChild(w.el);
      var pf = persisted.frames && persisted.frames[id];
      w.frame = clampFrame(pf ? { x: pf.x, y: pf.y, w: pf.w, h: pf.h } : defaultFrame(app), app);
      w.zoomed = !!(pf && pf.z) && !app.noZoom;
      w.el.classList.toggle('is-zoomed', w.zoomed);
      wire(w);
    }
    if (!w.mounted) {
      w.mounted = true;
      try { if (app.mount) app.mount(api(w)); } catch (e) { console.error('[wm] mount failed for ' + id + ':', e); }
    }

    var wasVisible = w.open && !w.minimized;
    if (w.minimized) {
      unminimize(w);
    } else if (!w.open) {
      w.open = true;
      applyFrame(w);
      show(w, !opts.quiet);
    }
    w.open = true;
    if (order.indexOf(id) < 0) order.push(id);
    focus(id);
    if (app.onShow) { try { app.onShow(api(w), opts, wasVisible); } catch (e) { console.error('[wm] onShow failed for ' + id + ':', e); } }
    // Keyboard focus follows the window that came forward, so Tab walks its controls rather
    // than the dock's. Left alone when the panel already focused one of its own fields, when
    // the user is typing somewhere (a deploy that finishes opens its result window), and for
    // quiet restores at boot.
    var ae = document.activeElement;
    var typing = ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable);
    if (!opts.quiet && !typing && !w.el.contains(ae)) {
      try { w.el.focus({ preventScroll: true }); } catch (e) { /* detached: nothing to focus */ }
    }
    if (!wasVisible) fireResize(w);
    persist();
    emit();
    return w;
  }

  function close(id) {
    var w = wins[id];
    if (!w || !w.open) return;
    w.open = false;
    w.minimized = false;
    w.el.classList.add('is-hidden');
    w.el.classList.remove('is-active');
    order = order.filter(function (x) { return x !== id; });
    if (w.app.onHide) { try { w.app.onHide(api(w)); } catch (e) { console.error(e); } }
    var next = topVisible();
    if (next) focus(next); else { activeId = null; emit(); }
    persist();
  }

  function minimize(id, instant) {
    var w = wins[id];
    if (!w || !w.open || w.minimized) return;
    var el = w.el, d = dockTarget(w), dur = instant ? 0 : ms('--mv-d-4');
    w.minimized = true;
    el.classList.remove('is-active');
    if (dur > 0) {
      el.style.transition = 'transform ' + dur + 'ms var(--mv-ease-in), opacity ' + dur + 'ms var(--mv-ease-in)';
      void el.offsetWidth;
      el.style.transform = 'translate(' + d.dx + 'px,' + d.dy + 'px) scale(.08)';
      el.style.opacity = '0';
    }
    setTimeout(function () {
      if (!w.minimized) return;
      el.classList.add('is-hidden');
      el.style.transition = '';
      el.style.transform = '';
      el.style.opacity = '';
    }, dur + 20);
    var next = topVisible();
    if (next) focus(next); else { activeId = null; emit(); }
    persist();
  }

  function unminimize(w) {
    var el = w.el, dur = ms('--mv-d-4');
    w.minimized = false;
    el.classList.remove('is-hidden');
    applyFrame(w);
    if (dur > 1) {
      var d = dockTarget(w);
      el.style.transition = 'none';
      el.style.transform = 'translate(' + d.dx + 'px,' + d.dy + 'px) scale(.08)';
      el.style.opacity = '0';
      void el.offsetWidth;
      el.style.transition = 'transform ' + dur + 'ms var(--mv-ease-spring), opacity ' + Math.round(dur * .6) + 'ms var(--mv-ease-out)';
      el.style.transform = '';
      el.style.opacity = '';
      setTimeout(function () { el.style.transition = ''; }, dur + 20);
    }
  }

  function zoom(id, force) {
    var w = wins[id];
    if (!w || !w.open || w.app.noZoom) return;
    w.zoomed = force === true ? true : !w.zoomed;
    w.el.classList.toggle('is-zoomed', w.zoomed);
    var dur = ms('--mv-d-3');
    if (dur > 1) {
      w.el.style.transition = ['left', 'top', 'width', 'height'].map(function (p) { return p + ' ' + dur + 'ms var(--mv-ease-spring)'; }).join(',');
      setTimeout(function () { w.el.style.transition = ''; }, dur + 20);
    }
    applyFrame(w);
    fireResize(w);
    persist();
  }

  function showDesktop() {
    var visible = order.filter(function (id) { return wins[id].open && !wins[id].minimized; });
    if (visible.length) {
      stash = visible.slice();
      visible.forEach(function (id) { minimize(id); });
    } else if (stash) {
      var back = stash; stash = null;
      back.forEach(function (id) { open(id, { quiet: true }); });
    }
  }

  function cycle() {
    var visible = order.filter(function (id) { return wins[id].open && !wins[id].minimized; });
    if (visible.length > 1) focus(visible[0]);
  }

  function restore() {
    var ids = (persisted.open || []).filter(function (id) { return MV.apps.get(id) && !MV.apps.get(id).run; });
    ids.forEach(function (id) { open(id, { quiet: true, restoring: true }); });
    (persisted.min || []).forEach(function (id) { if (wins[id]) minimize(id, true); });
    if (persisted.active && wins[persisted.active] && wins[persisted.active].open && !wins[persisted.active].minimized) focus(persisted.active);
  }

  function onViewportResize() {
    Object.keys(wins).forEach(function (id) {
      var w = wins[id];
      if (!w.zoomed) w.frame = clampFrame(w.frame, w.app);
      applyFrame(w);
    });
    syncDock();
  }

  function init(layerEl) {
    layer = layerEl;
    var t = null;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(onViewportResize, 120);
    });
  }

  MV.wm = {
    init: init,
    open: open,
    close: close,
    minimize: minimize,
    zoom: zoom,
    focus: focus,
    showDesktop: showDesktop,
    cycle: cycle,
    restore: restore,
    active: function () { return activeId; },
    isOpen: function (id) { return !!(wins[id] && wins[id].open); },
    isMinimized: function (id) { return !!(wins[id] && wins[id].minimized); },
    list: function () {
      return order.map(function (id) { return { id: id, open: wins[id].open, minimized: wins[id].minimized, active: id === activeId }; });
    },
    onChange: function (fn) { listeners.push(fn); },
  };
})();
