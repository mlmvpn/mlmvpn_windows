/* =====================================================================
   Desktop — wallpaper, the home grid of apps, its folders,
   the widgets and the right-click menu of the desk itself.
   ---------------------------------------------------------------------
   Home order is the user's ('mv-home'): icons are dragged into place
   (shell/arrange.js). An app the saved order has never seen — a new one
   after an update — is appended at the end instead of resetting the
   layout, the same rule as Android's HomeLayoutStore.

   Folders are the user's too ('mv-folders', shell/apps.js), the way a
   phone's home screen has them: drop one icon on another to make one and
   name it; drop an icon on a folder to add it; in the folder, rename it,
   drag an app out of the box (or right-click it) to take it out, or
   delete the folder and its apps return to the desk where it stood.
   «ابزارها» is only the folder the desk starts with.
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var root = null, grid = null;
  var DRAG_OUT = 6;

  // ── The order, and who is where ────────────────────────────────────────
  function readOrder() {
    var folders = MV.apps.folders();
    var inFolder = {};
    Object.keys(folders).forEach(function (k) { folders[k].apps.forEach(function (id) { inFolder[id] = k; }); });
    var visible = MV.apps.homeApps();
    var saved = null;
    try {
      var raw = window.PersistentStorage && PersistentStorage.getItem('mv-home');
      saved = raw ? JSON.parse(raw) : null;
    } catch (e) { saved = null; }
    if (!Array.isArray(saved)) saved = MV.apps.home();
    var at = saved.indexOf('aether');
    if (at > -1) saved.splice.apply(saved, [at, 1].concat(MV.apps.warpApps().filter(function (id) { return saved.indexOf(id) < 0; })));

    var order = [], seen = {};
    saved.forEach(function (id) {
      if (seen[id]) return;
      if (id.charAt(0) === '@') {
        if (folders[id.slice(1)]) { order.push(id); seen[id] = true; }
        return;
      }
      if (!MV.apps.get(id) || inFolder[id] || visible.indexOf(id) < 0) return;
      order.push(id); seen[id] = true;
    });
    Object.keys(folders).forEach(function (k) { if (!seen['@' + k]) { order.push('@' + k); seen['@' + k] = true; } });
    // Anything that is nowhere is new since the layout was saved: into its own folder when that
    // folder is still there, onto the desk otherwise.
    var changed = false;
    visible.forEach(function (id) {
      if (seen[id] || inFolder[id]) return;
      var home = MV.apps.defaultFolderOf(id);
      if (home && folders[home]) { folders[home].apps.push(id); inFolder[id] = home; changed = true; }
      else { order.push(id); seen[id] = true; }
    });
    if (changed) MV.apps.saveFolders(folders);
    return order;
  }
  function saveOrder() {
    var ids = Array.prototype.map.call(grid.querySelectorAll('.mv-app'), function (b) {
      return b.dataset.folder ? '@' + b.dataset.folder : b.dataset.app;
    });
    MV.store('mv-home', JSON.stringify(ids));
  }
  function refill() {
    if (!grid) return;
    grid.innerHTML = '';
    fill();
  }

  function appButton(app, size) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mv-app';
    b.dataset.app = app.id;
    b.innerHTML = MV.apps.iconHTML(app, size) + '<span class="mv-app-label"></span>';
    b.querySelector('.mv-app-label').textContent = MV.apps.label(app);
    return b;
  }

  function folderButton(key) {
    var f = MV.apps.folder(key);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'mv-app';
    b.dataset.folder = key;
    b.innerHTML = MV.apps.folderIconHTML(key, 64) + '<span class="mv-app-label"></span>';
    b.querySelector('.mv-app-label').textContent = f.title;
    return b;
  }

  // ── Folder operations ──────────────────────────────────────────────────
  function newKey(folders) {
    var n = 1;
    while (folders['f' + n]) n++;
    return 'f' + n;
  }

  // The order as it stands on screen. Edits start from this, not from readOrder(): that one
  // files an app it finds nowhere back into its default folder, which is exactly where an app
  // just taken out of «ابزارها» is for a moment.
  function currentOrder() {
    return Array.prototype.map.call(grid.querySelectorAll('.mv-app'), function (b) {
      return b.dataset.folder ? '@' + b.dataset.folder : b.dataset.app;
    });
  }

  /** Put `ids` into the order after `at` (or in its place with `replace`), or at the end. */
  function placeInOrder(ids, at, replace) {
    var order = currentOrder().filter(function (x) { return ids.indexOf(x) < 0; });
    var i = at ? order.indexOf(at) : -1;
    if (i < 0) order = order.concat(ids);
    else order.splice.apply(order, [replace ? i : i + 1, replace ? 1 : 0].concat(ids));
    MV.store('mv-home', JSON.stringify(order));
  }

  /** Drop app `src` on app `target`: a new folder of the two, where `target` stood. */
  function createFolder(targetId, srcId) {
    var folders = MV.apps.folders();
    var key = newKey(folders);
    folders[key] = { title: 'پوشه‌ی جدید', apps: [targetId, srcId] };
    var order = currentOrder().filter(function (x) { return x !== srcId; });
    var t = order.indexOf(targetId);
    if (t > -1) order.splice(t, 1, '@' + key); else order.push('@' + key);
    MV.apps.saveFolders(folders);
    MV.store('mv-home', JSON.stringify(order));
    refill();
    openFolder(key, { rename: true });
  }

  function addToFolder(key, id) {
    var folders = MV.apps.folders();
    if (!folders[key] || folders[key].apps.indexOf(id) > -1) return;
    folders[key].apps.push(id);
    MV.apps.saveFolders(folders);
    // It is in the folder now, not on the desk.
    MV.store('mv-home', JSON.stringify(currentOrder().filter(function (x) { return x !== id; })));
    refill();
    if (window.toast) window.toast('«' + MV.apps.label(MV.apps.get(id)) + '» به «' + folders[key].title + '» رفت');
  }

  /** Take `id` out of folder `key`; it lands right after the folder on the desk. */
  function removeFromFolder(key, id) {
    var folders = MV.apps.folders();
    var f = folders[key];
    if (!f) return;
    f.apps = f.apps.filter(function (x) { return x !== id; });
    var gone = !f.apps.length;
    if (gone) delete folders[key];
    MV.apps.saveFolders(folders);
    placeInOrder([id], '@' + key, gone);
    refill();
  }

  function renameFolder(key, title) {
    var t = String(title || '').trim().slice(0, 60);
    var folders = MV.apps.folders();
    if (!folders[key] || !t || folders[key].title === t) return;
    folders[key].title = t;
    MV.apps.saveFolders(folders);
    refill();
  }

  /** Delete the folder; its apps take its place on the desk, in its order. */
  function deleteFolder(key) {
    var folders = MV.apps.folders();
    var f = folders[key];
    if (!f) return;
    delete folders[key];
    MV.apps.saveFolders(folders);
    placeInOrder(f.apps.slice(), '@' + key, true);
    refill();
    if (window.toast) window.toast('پوشه‌ی «' + f.title + '» حذف شد؛ برنامه‌هایش روی میزکار برگشتند.');
  }

  // ── The open folder ────────────────────────────────────────────────────
  var openOverlay = null;
  function closeFolder() { if (openOverlay) openOverlay.close(); }

  function openFolder(key, opts) {
    var f = MV.apps.folder(key);
    if (!f) return;
    closeFolder();
    var ov = document.createElement('div');
    ov.className = 'mv-folder';
    ov.innerHTML = '<div class="mv-folder-box" role="dialog" aria-label="پوشه">' +
      '<div class="mv-folder-head"><input class="mv-folder-title" type="text" maxlength="60" aria-label="نام پوشه" spellcheck="false">' +
      '<button type="button" class="mv-folder-del" title="حذف پوشه — برنامه‌ها روی میزکار برمی‌گردند" aria-label="حذف پوشه"><i class="ph-bold ph-trash"></i></button></div>' +
      '<div class="mv-folder-grid"></div>' +
      '<p class="mv-folder-hint">برای خارج کردن، برنامه را بیرون از کادر بکشید.</p></div>';
    var box = ov.querySelector('.mv-folder-box');
    var title = ov.querySelector('.mv-folder-title');
    title.value = f.title;
    var g = ov.querySelector('.mv-folder-grid');
    f.apps.forEach(function (id) { var a = MV.apps.get(id); if (a) g.appendChild(appButton(a, 56)); });

    var drag = null, suppress = 0;
    function commitTitle() { renameFolder(key, title.value); var now = MV.apps.folder(key); if (now) title.value = now.title; }
    function close() {
      if (!ov.isConnected) return;
      if (document.activeElement === title) commitTitle();
      ov.remove();
      openOverlay = null;
      document.removeEventListener('keydown', onKey, true);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); if (document.activeElement === title) { title.value = (MV.apps.folder(key) || f).title; title.blur(); } else close(); }
    }
    // Enter commits by itself rather than through blur: a window without focus never fires one.
    title.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commitTitle(); title.blur(); } });
    title.addEventListener('blur', commitTitle);
    title.addEventListener('change', commitTitle);
    ov.querySelector('.mv-folder-del').addEventListener('click', function () { close(); deleteFolder(key); });

    ov.addEventListener('click', function (e) {
      if (Date.now() < suppress) return;
      var b = e.target.closest('.mv-app');
      if (b) { close(); MV.wm.open(b.dataset.app); return; }
      if (!e.target.closest('.mv-folder-box')) close();
    });
    ov.addEventListener('contextmenu', function (e) {
      var b = e.target.closest('.mv-folder-grid .mv-app');
      if (!b) return;
      e.preventDefault();
      MV.menu.open({
        anchor: { x: e.clientX, y: e.clientY }, atPoint: true,
        items: [
          { label: 'باز کردن', action: function () { close(); MV.wm.open(b.dataset.app); } },
          { label: 'خارج کردن از پوشه', action: function () { close(); removeFromFolder(key, b.dataset.app); } },
        ],
      });
    });

    // Drag an app out of the box to take it out of the folder.
    g.addEventListener('pointerdown', function (e) {
      var b = e.target.closest('.mv-app');
      if (!b || e.button !== 0) return;
      drag = { b: b, x0: e.clientX, y0: e.clientY, ghost: null };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once: true });
    });
    function onMove(e) {
      if (!drag) return;
      if (!drag.ghost) {
        if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < DRAG_OUT) return;
        var ic = drag.b.querySelector('.mv-ic'), r = ic.getBoundingClientRect();
        var gh = ic.cloneNode(true);
        gh.classList.add('mv-drag-ghost');
        gh.style.width = r.width + 'px'; gh.style.height = r.height + 'px'; gh.style.left = '0px'; gh.style.top = '0px';
        document.body.appendChild(gh);
        drag.ghost = { el: gh, ox: drag.x0 - r.left, oy: drag.y0 - r.top };
        drag.b.classList.add('is-drag-src');
      }
      drag.ghost.el.style.transform = 'translate(' + (e.clientX - drag.ghost.ox) + 'px,' + (e.clientY - drag.ghost.oy) + 'px) scale(1.08)';
      var br = box.getBoundingClientRect();
      drag.out = e.clientX < br.left || e.clientX > br.right || e.clientY < br.top || e.clientY > br.bottom;
      box.classList.toggle('is-dropping-out', !!drag.out);
    }
    function onUp() {
      document.removeEventListener('pointermove', onMove);
      var d = drag; drag = null;
      if (!d || !d.ghost) return;
      suppress = Date.now() + 250;
      d.ghost.el.remove();
      d.b.classList.remove('is-drag-src');
      box.classList.remove('is-dropping-out');
      if (d.out) { close(); removeFromFolder(key, d.b.dataset.app); }
    }

    document.addEventListener('keydown', onKey, true);
    root.appendChild(ov);
    openOverlay = { close: close };
    if (opts && opts.rename) { title.focus(); title.select(); }
    else { var first = g.querySelector('.mv-app'); if (first) first.focus(); }
  }

  function updateLamps() {
    if (!grid) return;
    grid.querySelectorAll('.mv-app[data-app]').forEach(function (b) {
      var ic = b.querySelector('.mv-ic');
      var on = MV.apps.engineUp(b.dataset.app);
      var lamp = ic.querySelector('.mv-lamp');
      if (on && !lamp) { lamp = document.createElement('span'); lamp.className = 'mv-lamp'; ic.appendChild(lamp); }
      if (!on && lamp) lamp.remove();
    });
  }

  // Arrow keys walk the grid. RTL: → goes to the previous icon, ← to the next.
  function onGridKey(e) {
    var btns = Array.prototype.slice.call(grid.querySelectorAll('.mv-app'));
    var i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    var cols = Math.max(1, Math.round(grid.clientWidth / 118));
    var next = { ArrowLeft: i + 1, ArrowRight: i - 1, ArrowDown: i + cols, ArrowUp: i - cols }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    if (btns[next]) btns[next].focus();
  }

  function resetOrder() {
    MV.store('mv-folders', JSON.stringify(MV.apps.defaultFolders()));
    MV.store('mv-home', JSON.stringify(MV.apps.home()));
    refill();
  }

  function fill() {
    readOrder().forEach(function (id) {
      if (id.charAt(0) === '@') { var f = MV.apps.folder(id.slice(1)); if (f) grid.appendChild(folderButton(id.slice(1))); return; }
      var app = MV.apps.get(id);
      if (app) grid.appendChild(appButton(app, 64));
    });
    updateLamps();
  }

  function onGridMenu(e) {
    var b = e.target.closest('.mv-app[data-folder]');
    if (!b) return;
    e.preventDefault();
    var key = b.dataset.folder;
    MV.menu.open({
      anchor: { x: e.clientX, y: e.clientY },
      atPoint: true,
      items: [
        { label: 'باز کردن', action: function () { openFolder(key); } },
        { label: 'تغییر نام…', action: function () { openFolder(key, { rename: true }); } },
        { sep: true },
        { label: 'حذف پوشه (برنامه‌ها روی میزکار برمی‌گردند)', danger: true, action: function () { deleteFolder(key); } },
      ],
    });
  }

  function onDeskMenu(e) {
    // Only the desk itself: icons, widgets and windows have their own business.
    if (e.target.closest('.mv-app, .mv-widget, .mv-win, .mv-folder')) return;
    e.preventDefault();
    MV.menu.open({
      anchor: { x: e.clientX, y: e.clientY },
      atPoint: true,
      items: [
        { label: 'تغییر تصویر زمینه…', action: function () { MV.wm.open('settings', { pane: 'appearance', focus: 'wallpaper' }); } },
        { label: 'ویرایش ویجت‌ها…', action: function () { if (MV.widgets) MV.widgets.editMenu({ x: e.clientX, y: e.clientY }); } },
        { sep: true },
        { label: 'چیدمان پیش‌فرض آیکون‌ها و پوشه‌ها', action: resetOrder },
        { label: 'جست‌وجو…', sc: 'Ctrl K', action: function () { if (MV.spotlight) MV.spotlight.open(); } },
      ],
    });
  }

  function build() {
    root = document.createElement('div');
    root.id = 'mv-desktop';

    var canvas = document.createElement('canvas');
    canvas.className = 'mv-wallpaper';
    canvas.setAttribute('aria-hidden', 'true');
    root.appendChild(canvas);

    var home = document.createElement('div');
    home.className = 'mv-home';
    var brand = document.createElement('div');
    brand.className = 'mv-home-brand';
    var bt = document.getElementById('brand-title');
    if (bt) brand.appendChild(bt);
    var search = document.createElement('button');
    search.type = 'button';
    search.className = 'mv-home-search';
    search.innerHTML = MV.icons.svg('g-search') + '<span>جست‌وجو در ابزارها و تنظیمات</span><span class="mv-kbd">Ctrl K</span>';
    search.addEventListener('click', function () { if (MV.spotlight) MV.spotlight.open(); });
    brand.appendChild(search);
    home.appendChild(brand);

    grid = document.createElement('div');
    grid.className = 'mv-home-grid';
    grid.setAttribute('role', 'group');
    grid.setAttribute('aria-label', 'برنامه‌ها');
    fill();
    grid.addEventListener('click', function (e) {
      var b = e.target.closest('.mv-app');
      if (!b || (MV.arrange && MV.arrange.justDragged())) return;
      if (b.dataset.folder) openFolder(b.dataset.folder);
      else MV.wm.open(b.dataset.app);
    });
    grid.addEventListener('keydown', onGridKey);
    grid.addEventListener('contextmenu', onGridMenu);
    home.appendChild(grid);
    root.appendChild(home);

    var widgets = document.createElement('div');
    widgets.className = 'mv-widgets';
    root.appendChild(widgets);

    var layer = document.createElement('div');
    layer.id = 'mv-windows';
    root.appendChild(layer);

    root.addEventListener('contextmenu', onDeskMenu);
    document.body.appendChild(root);

    MV.wallpaper.init(canvas);
    if (MV.widgets) MV.widgets.build(widgets);
    return layer;
  }

  MV.desktop = {
    build: build,
    updateLamps: updateLamps,
    grid: function () { return grid; },
    saveOrder: saveOrder,
    redraw: function () { MV.wallpaper.redraw(); },
    folders: { create: createFolder, add: addToFolder, takeOut: removeFromFolder, rename: renameFolder, del: deleteFolder, open: openFolder },
  };
})();
