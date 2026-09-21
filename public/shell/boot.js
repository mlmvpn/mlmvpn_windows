/* =====================================================================
   Shell boot — builds the desktop, dock and menu bar over the running
   app, and points every old entry point at the window manager.
   ---------------------------------------------------------------------
   Runs after every panel's init (last script in <body>), so all the
   roots it adopts already exist. The old layout stays in the document,
   hidden by html.mv-shell, so any id the logic looks up is still there.

   Per-user lever: Settings › ظاهر › «چیدمان قدیمی» (stored as
   mv-shell = 'off') skips all of this and leaves the previous layout —
   for anyone the new shell gets in the way of while the redesign is
   still in progress.
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  function $(id) { return document.getElementById(id); }

  function shellOff() {
    try {
      if (/[?&]legacy=1\b/.test(location.search)) return true;
      var v = window.PersistentStorage ? PersistentStorage.getItem('mv-shell') : null;
      return v === 'off';
    } catch (e) { return false; }
  }

  // ── Old entry points → windows ───────────────────────────────────────────
  function installShims() {
    var O = MV.apps.orig;
    window.toggleLeftSidebar = function (name) {
      // Called with no name by the old sidebar's own close button — there is no sidebar now.
      if (!name) return;
      // Five callers (cloud, combo, vodi, github-tunnel) use this to TAKE the user to a panel
      // after a connect or deploy. As a toggle it would close a window that is already open.
      MV.wm.open(MV.apps.byLegacy(name) || name);
    };
    window.toggleBottomPanel = function (view) {
      if (view === 'monitor') MV.wm.open('monitor');
      else MV.wm.open('console', { tab: view === 'terminal' ? 'terminal' : 'core' });
    };
    window.toggleSettings = function () { MV.wm.open('settings'); };
    window.switchSettingsTab = function (pane) {
      MV.wm.open('settings');
      // All arguments: the pane's ‹ › history passes a second one (settings.js › settingsGo).
      var r = O.switchSettingsTab ? O.switchSettingsTab.apply(this, arguments) : undefined;
      if (pane === 'notifications' && MV.notify) MV.notify.renderSettings();
      return r;
    };
    window.openChangelogTab = function () { MV.wm.open('changelog'); };
    window.openGuideTab = function () { MV.wm.open('guide'); };
    window.openDnsCleanTab = function () { MV.wm.open('dnsclean'); };
    window.openFixedIpTab = function () { MV.wm.open('fixedip'); };
    // «ورکرهای کلودفلر» is no longer an app: Settings › «منابع حساب» lists the same workers
    // per account, with D1 and KV beside them. Old callers land there rather than nowhere.
    window.openWorkersManagerTab = function () { MV.wm.open('settings', { pane: 'cf' }); };
    window.openNetDiagTab = function (opts) {
      MV.wm.open('netdiag');
      // The network nudge opens it with autorun — «بررسی کن» should start the check.
      if (opts && opts.autorun) {
        try { if (!ndState.running && typeof ndStart === 'function') ndStart('full'); } catch (e) { /* not loaded */ }
      }
    };
    if (O.promptNewTab) window.promptNewTab = function () { MV.wm.open('scanner'); return O.promptNewTab.apply(this, arguments); };
    if (O.duplicateTab) window.duplicateTab = function () { MV.wm.open('scanner'); return O.duplicateTab.apply(this, arguments); };
    // History restore and every other path that makes a scan tab should show it.
    if (O.createTab) window.createTab = function () { var r = O.createTab.apply(this, arguments); MV.wm.open('scanner'); return r; };
    // The archive and the combination centre are windows now (apps.js › sheetWindow). Their
    // windows run the original open/close, so every caller — toolbar, menus, the archive's
    // «انتقال به پنل ترکیب», the combination centre's export — keeps its behaviour.
    if (O.openIpArchive) window.openIpArchive = function () { MV.wm.open('archive'); };
    if (O.closeIpArchive) window.closeIpArchive = function () { MV.wm.close('archive'); };
    if (O.openCombinationCenter) window.openCombinationCenter = function () { MV.wm.open('combo'); };
    if (O.closeCombinationCenter) window.closeCombinationCenter = function () { MV.wm.close('combo'); };
    // «کانفیگ رایگان» too: V2Ray's button, the home icon and «انتقال به V2Ray» go through these.
    if (O.openFreeConfigsModal) window.openFreeConfigsModal = function () { MV.wm.open('free'); };
    if (O.closeFreeConfigsModal) window.closeFreeConfigsModal = function () { MV.wm.close('free'); };
  }

  // Dialogs that live inside a panel's template would be trapped under the dock once
  // the panel sits in a window (a window is its own stacking context). They carry no
  // container-scoped CSS and are always looked up by id, so they move to <body> as is.
  var PANEL_DIALOGS = ['modal-backdrop', 'v2ray-switch-modal', 'cloud-add-account-modal', 'cloud-guide-modal',
    'undeployed-modal', 'zeus-combiner-modal', 'sni-import-modal',
    // V2Ray's own dialogs (import, edit, delete, cancel test, delete all, subscription,
    // share) and two of the cloud panel's: inside the window they sat under the dock and
    // the menu bar, and a tall one (import) ran under the dock.
    'importModal', 'editModal', 'deleteModal', 'cancelTestModal', 'deleteAllModal', 'subModal', 'shareModal',
    'cloudDeleteModal', 'edgeSettingsModal',
    // The archive's own alert/confirm live inside its layer, which is now a window.
    'archive-alert-modal', 'archive-confirm-modal',
    // …and the combination centre's three, for the same reason: it is a window too, so its
    // retest sheets and its delete confirm were sitting under the dock.
    'retest-config-modal', 'retest-confirm-modal', 'deleteComboModal'];
  function portalDialogs() {
    PANEL_DIALOGS.forEach(function (id) {
      var el = $(id);
      if (el && el.parentNode !== document.body) document.body.appendChild(el);
    });
  }

  // ── Keyboard: e.code, so the shortcuts work on a Persian layout too ─────
  function onKey(e) {
    if (!e.ctrlKey || e.altKey || e.metaKey) return;
    var c = e.code, act = MV.wm.active();
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    var hit = true;
    if (c === 'KeyK' && !e.shiftKey) MV.spotlight.toggle();
    else if (c === 'Comma') MV.wm.open('settings');
    else if (c === 'KeyW' && !e.shiftKey && act) MV.wm.close(act);
    else if (c === 'KeyM' && !e.shiftKey && act) MV.wm.minimize(act);
    else if (c === 'Backquote') MV.wm.cycle();
    else if (c === 'KeyD' && e.shiftKey) MV.wm.showDesktop();
    else if (c === 'KeyT' && !e.shiftKey && act === 'scanner') window.promptNewTab();
    else if (c === 'Enter' && act === 'scanner' && !typing && typeof toggleScan === 'function') toggleScan();
    else if (/^Digit[1-5]$/.test(c) && !e.shiftKey) {
      var id = MV.dock.pins()[+c.slice(5) - 1];
      if (id) MV.wm.open(id); else hit = false;
    } else hit = false;
    if (hit) e.preventDefault();
  }

  function tick() {
    try {
      MV.dock.render();
      MV.desktop.updateLamps();
      MV.menubar.updateEngine();
      if (MV.widgets) MV.widgets.tick();
    } catch (e) { console.error('[shell] tick failed:', e); }
  }

  function boot() {
    if (shellOff()) { console.info('[shell] off for this user — previous layout kept.'); return; }
    try {
      MV.apps.capture();
      MV.icons.inject();
      var mag = window.PersistentStorage && PersistentStorage.getItem('mv-dock-magnify');
      if (mag === 'off') document.documentElement.setAttribute('data-dock-magnify', 'off');
      // Settings › صفحه نمایش (components/android-settings.js), before the first frame.
      MV.displayPrefs.apply();

      var layer = MV.desktop.build();
      MV.wm.init(layer);
      MV.menubar.build();
      MV.dock.build();
      portalDialogs();
      installShims();
      MV.notify.init();
      MV.arrange.init();
      document.documentElement.classList.add('mv-shell');
      document.addEventListener('keydown', onKey);
      MV.wm.restore();
      tick();
      setInterval(tick, 2000);
    } catch (e) {
      // Whatever got built stays harmless; without the class the old layout shows.
      document.documentElement.classList.remove('mv-shell');
      console.error('[shell] boot failed — previous layout kept:', e);
      if (typeof window.toast === 'function') window.toast('⚠️ چیدمان جدید بالا نیامد؛ چیدمان قبلی نمایش داده شد.');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  MV.shell = { off: shellOff };
})();
