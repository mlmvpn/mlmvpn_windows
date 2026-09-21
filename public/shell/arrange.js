/* =====================================================================
   Arranging — drag icons on the home grid and in the dock.
   ---------------------------------------------------------------------
   • Home: press, move a few pixels, and the icon lifts; the grid makes
     room as it passes. Drop it on the dock to pin it there too. Held
     over the middle of another icon it lights it up instead: let go and
     the two become a folder, or the app joins that folder (desktop.js).
   • Dock: drag a pinned icon along the dock to reorder it; drag it up
     out of the dock and let go to take it off. «میزکار» stays put.
   The icons move in the DOM only when the drop target changes (never per
   pointer move), and the ghost follows through style.transform only.
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var drag = null;
  var suppressClickUntil = 0;
  var THRESHOLD = 6;

  function ghostFor(icon, x, y) {
    var r = icon.getBoundingClientRect();
    var g = icon.cloneNode(true);
    g.classList.add('mv-drag-ghost');
    g.style.width = r.width + 'px';
    g.style.height = r.height + 'px';
    g.style.left = '0px';
    g.style.top = '0px';
    document.body.appendChild(g);
    return { el: g, ox: x - r.left, oy: y - r.top };
  }
  function moveGhost(x, y) { drag.ghost.el.style.transform = 'translate(' + (x - drag.ghost.ox) + 'px,' + (y - drag.ghost.oy) + 'px) scale(1.08)'; }

  function overDock(x, y) {
    var dock = document.querySelector('.mv-dock');
    if (!dock) return false;
    var r = dock.getBoundingClientRect();
    return x >= r.left - 12 && x <= r.right + 12 && y >= r.top - 18 && y <= r.bottom + 8;
  }

  // ── Home grid ────────────────────────────────────────────────────────────
  function homeDown(e) {
    var b = e.target.closest('.mv-app');
    if (!b || e.button !== 0 || !b.closest('.mv-home-grid')) return;
    drag = { kind: 'home', src: b, x0: e.clientX, y0: e.clientY, started: false, ghost: null, target: null, merge: null };
    document.addEventListener('pointermove', homeMove);
    document.addEventListener('pointerup', homeUp, { once: true });
  }

  function homeMove(e) {
    if (!drag || drag.kind !== 'home') return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < THRESHOLD) return;
      drag.started = true;
      drag.ghost = ghostFor(drag.src.querySelector('.mv-ic'), drag.x0, drag.y0);
      drag.src.classList.add('is-drag-src');
      document.documentElement.classList.add('mv-arranging');
    }
    moveGhost(e.clientX, e.clientY);
    var dockHot = overDock(e.clientX, e.clientY) && !!drag.src.dataset.app && !(MV.apps.get(drag.src.dataset.app) || {}).run;
    var dock = document.querySelector('.mv-dock');
    if (dock) dock.classList.toggle('is-drop-target', dockHot);
    if (dockHot) { setMerge(null); return; }
    var under = document.elementFromPoint(e.clientX, e.clientY);
    var over = under && under.closest('.mv-home-grid .mv-app');
    if (!over || over === drag.src) { setMerge(null); return; }
    // The middle of another icon means "put them together" (a folder, as on a phone's home
    // screen); its edges still mean "move here". Only an app can go into a folder.
    var ic = over.querySelector('.mv-ic').getBoundingClientRect();
    var inset = ic.width * 0.22;
    var centre = e.clientX > ic.left + inset && e.clientX < ic.right - inset && e.clientY > ic.top + inset && e.clientY < ic.bottom - inset;
    if (centre && drag.src.dataset.app) { setMerge(over); return; }
    setMerge(null);
    var r = over.getBoundingClientRect();
    // RTL grid: the left half of an icon is "after" it.
    var after = e.clientX < r.left + r.width / 2;
    var ref = after ? over.nextSibling : over;
    if (ref !== drag.src && drag.target !== over.dataset.app + after) {
      drag.target = over.dataset.app + after;
      over.parentNode.insertBefore(drag.src, ref);
    }
  }

  function setMerge(el) {
    if (!drag) return;
    if (drag.merge && drag.merge !== el) drag.merge.classList.remove('is-merge-target');
    drag.merge = el;
    if (el) el.classList.add('is-merge-target');
  }

  function homeUp(e) {
    document.removeEventListener('pointermove', homeMove);
    if (!drag || drag.kind !== 'home') return;
    var d = drag; drag = null;
    if (!d.started) return;
    suppressClickUntil = Date.now() + 250;
    d.ghost.el.remove();
    d.src.classList.remove('is-drag-src');
    document.documentElement.classList.remove('mv-arranging');
    var dock = document.querySelector('.mv-dock');
    if (dock) dock.classList.remove('is-drop-target');
    if (d.merge) {
      d.merge.classList.remove('is-merge-target');
      MV.desktop.saveOrder();
      if (d.merge.dataset.folder) MV.desktop.folders.add(d.merge.dataset.folder, d.src.dataset.app);
      else MV.desktop.folders.create(d.merge.dataset.app, d.src.dataset.app);
      return;
    }
    if (overDock(e.clientX, e.clientY) && d.src.dataset.app) {
      if (MV.dock.pin(d.src.dataset.app)) window.toast('✅ «' + MV.apps.label(MV.apps.get(d.src.dataset.app)) + '» در داک نگه داشته شد');
    }
    MV.desktop.saveOrder();
  }

  // ── Dock ─────────────────────────────────────────────────────────────────
  function dockDown(e) {
    var b = e.target.closest('.mv-dock-item');
    if (!b || e.button !== 0 || b.dataset.app === 'desk') return;
    if (MV.dock.pins().indexOf(b.dataset.app) < 0) return;   // running-only icons are not arranged
    drag = { kind: 'dock', src: b, x0: e.clientX, y0: e.clientY, started: false, ghost: null, out: false };
    document.addEventListener('pointermove', dockMove);
    document.addEventListener('pointerup', dockUp, { once: true });
  }

  function dockMove(e) {
    if (!drag || drag.kind !== 'dock') return;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < THRESHOLD) return;
      drag.started = true;
      drag.ghost = ghostFor(drag.src.querySelector('.mv-ic'), drag.x0, drag.y0);
      drag.src.classList.add('is-drag-src');
      document.documentElement.classList.add('mv-arranging');
    }
    moveGhost(e.clientX, e.clientY);
    var dock = drag.src.parentNode, r = dock.getBoundingClientRect();
    drag.out = e.clientY < r.top - 60;
    drag.ghost.el.classList.toggle('is-leaving', drag.out);
    if (drag.out) return;
    var items = Array.prototype.filter.call(dock.querySelectorAll('.mv-dock-item'), function (x) {
      return x.dataset.app !== 'desk' && MV.dock.pins().indexOf(x.dataset.app) > -1;
    });
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it === drag.src) continue;
      var ir = it.getBoundingClientRect();
      if (e.clientX >= ir.left && e.clientX <= ir.right) {
        var after = e.clientX < ir.left + ir.width / 2;   // RTL: left half = after
        dock.insertBefore(drag.src, after ? it.nextSibling : it);
        break;
      }
    }
  }

  function dockUp() {
    document.removeEventListener('pointermove', dockMove);
    if (!drag || drag.kind !== 'dock') return;
    var d = drag; drag = null;
    if (!d.started) return;
    suppressClickUntil = Date.now() + 250;
    d.ghost.el.remove();
    d.src.classList.remove('is-drag-src');
    document.documentElement.classList.remove('mv-arranging');
    if (d.out) { MV.dock.unpin(d.src.dataset.app); return; }
    var order = Array.prototype.map.call(d.src.parentNode.querySelectorAll('.mv-dock-item'), function (x) { return x.dataset.app; })
      .filter(function (id) { return id !== 'desk' && MV.dock.pins().indexOf(id) > -1; });
    MV.dock.setPins(order);
  }

  function init() {
    var grid = MV.desktop.grid();
    if (grid) grid.addEventListener('pointerdown', homeDown);
    var dock = document.querySelector('.mv-dock');
    if (dock) {
      dock.addEventListener('pointerdown', dockDown);
      // A drag ends in a click on the item under the pointer; that click is not a launch.
      dock.addEventListener('click', function (e) { if (Date.now() < suppressClickUntil) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    }
  }

  MV.arrange = { init: init, justDragged: function () { return Date.now() < suppressClickUntil; } };
})();
