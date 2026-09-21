/* =====================================================================
   App registry — the single list of tools the home screen, dock, menu bar
   and window manager draw from. Only features the Windows app really has.
   ---------------------------------------------------------------------
   Each app adopts an EXISTING root instead of rebuilding it: the element
   is moved (never copied) into its window, so every listener, timer and
   live connection inside keeps working, and every getElementById still
   finds it.

   Panels that used to live in the left sidebar are shown and hidden with
   the same inline style.display the old sidebar used — several of them
   poll the server only while `display !== 'none'`, and the monitor stops
   its 2-second poll the moment its view is hidden.
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  function $(id) { return document.getElementById(id); }

  // Original entry points, captured before shell/boot.js installs its shims.
  var ORIG = {};
  function capture() {
    ['openChangelogTab', 'openGuideTab', 'openDnsCleanTab', 'openNetDiagTab', 'openFixedIpTab',
      'switchSettingsTab', 'toggleSettings', 'toggleLeftSidebar',
      'toggleBottomPanel', 'promptNewTab', 'duplicateTab', 'createTab', 'renderTabs',
      'openIpArchive', 'closeIpArchive', 'openCombinationCenter', 'closeCombinationCenter',
      'openFreeConfigsModal', 'closeFreeConfigsModal'].forEach(function (n) {
      if (typeof window[n] === 'function' && !ORIG[n]) ORIG[n] = window[n];
    });
  }

  // Engine lamps read the state each panel already keeps; nothing here calls the server.
  function probe(fn) { return function () { try { return !!fn(); } catch (e) { return false; } }; }

  function whenEl(id, cb) {
    var el = $(id);
    if (el) { cb(el); return; }
    var tries = 0;
    var t = setInterval(function () {
      el = $(id);
      if (el || ++tries > 50) { clearInterval(t); if (el) cb(el); }
    }, 100);
  }

  function restoreCrumb() {
    try {
      var t = typeof getActiveTab === 'function' ? getActiveTab() : null;
      if (typeof updateBreadcrumb === 'function') updateBreadcrumb(t && !t.type && t.id !== 'settings' ? (t.isp || '—') : '—');
    } catch (e) { /* breadcrumb is decoration */ }
  }

  // ── Kinds of app ─────────────────────────────────────────────────────────
  // A panel from the old left sidebar (#ls-*).
  function panel(root, extra) {
    return Object.assign({
      mount: function (w) {
        var el = $(root);
        if (!el) return;
        w.body.appendChild(el);
        el.style.display = 'flex';
      },
      onShow: function (w) {
        var el = $(root);
        if (!el) return;
        if (el.parentNode !== w.body) w.body.appendChild(el);
        el.style.display = 'flex';
      },
      onHide: function () { var el = $(root); if (el) el.style.display = 'none'; },
    }, extra || {});
  }

  // A page that used to open as a tab in the scanner's tab strip. Its own open…Tab()
  // builds it once (inside #editor-content-wrap, through the tab system); the page is
  // then lifted into its window and the tab it needed is dropped again.
  function page(type, openName, rootId, renderName) {
    return {
      flush: true,
      mount: function (w) {
        var root = $(rootId);
        if (!root && ORIG[openName]) {
          var prev = typeof activeTabId !== 'undefined' ? activeTabId : null;
          try { ORIG[openName](); } catch (e) { console.error('[apps] ' + openName + ' failed:', e); }
          root = $(rootId);
          try {
            var t = tabs.find(function (x) { return x.type === type; });
            if (t) closeTab(t.id);
            if (prev != null && tabs.some(function (x) { return x.id === prev; }) && activeTabId !== prev) switchTab(prev);
          } catch (e) { /* tab system unavailable: the page still opened */ }
        }
        if (root) {
          root.classList.add('mv-page-root');
          w.body.appendChild(root);
        }
        restoreCrumb();
      },
      onShow: function () {
        var fn = renderName && window[renderName];
        if (fn && $(rootId)) { try { fn(); } catch (e) { console.error(e); } restoreCrumb(); }
      },
    };
  }

  // One of the three WARP engines (components/aether.js). Each page is its own root, so the
  // three windows can be open side by side; they share the one running engine.
  // 'warp' is this app's name for wg-with-Cloudflare's-own-endpoint (components/aether.js);
  // the engine itself only ever reports the three it really speaks.
  var WARP_APPS = { warp: 'warp', masque: 'masque', wg: 'wireguard', gool: 'warp_on_warp' };
  function warpEngine(id, proto, title, icon, tint, art, artBg, artScale) {
    var base = panel('ae-page-' + proto);
    return {
      // The split engine page (components/aether.js): glass sidebar, hero, no window title bar of
      // its own — the same window سایفون and تور open in.
      id: id, title: title, icon: icon, tint: tint, art: art || undefined, artBg: artBg || undefined, artScale: artScale || undefined, flush: true, chrome: 'split',
      size: [900, 680], min: [700, 470],
      // «وارپ» has its OWN engine now (warp-manager.js) with its own state and its own SOCKS
      // port, so its lamp is read from there and not from aether's. The other three are still
      // the aether engine, which only ever says masque | wg | gool — and since «وارپ» used to be
      // wg too, the page still has to record which app was started so «وایرگارد» does not light
      // up for a session that was never its.
      engine: probe(function () {
        if (proto === 'warp') return !!(window.warpState && window.warpState.connected === true);
        if (!(aetherState && aetherState.connected === true)) return false;
        var started = window.aeStartedProto || null;
        if (!started) { try { started = PersistentStorage.getItem('aether_started_as'); } catch (e) { started = null; } }
        if (aetherState.protocol !== proto) return false;
        return !(proto === 'wg' && started === 'warp');
      }),
      mount: base.mount,
      onShow: function (w) {
        base.onShow(w);
        if (typeof aetherViewed === 'function') aetherViewed(proto);
        if (typeof renderAetherStatus === 'function') renderAetherStatus();
      },
      onHide: base.onHide,
    };
  }
  // What the old single-panel name opens now: the engine that is running, else the last one used.
  function lastWarpApp() {
    var p = null;
    try { p = (aetherState && (aetherState.running || aetherState.connected) && aetherState.protocol) || null; } catch (e) { /* not loaded */ }
    if (!p) { try { p = PersistentStorage.getItem('aether_tab'); } catch (e) { /* none */ } }
    return WARP_APPS[p] || 'masque';
  }

  // A full-screen dialog that became a window (the IP archive, the combination centre). Its
  // own layer is moved into the window and laid flat (shell.css › .mv-sheetwin), and its own
  // open/close still run — so its data loads as before, and code that reads its "open"
  // state (archive.js skips auto-archiving while the archive is open) still sees it.
  function sheetWindow(rootId, openName, closeName) {
    function adopt(w) {
      var el = $(rootId);
      if (!el) return null;
      el.classList.add('mv-sheetwin');
      if (el.parentNode !== w.body) w.body.appendChild(el);
      return el;
    }
    return {
      flush: true,
      mount: adopt,
      onShow: function (w) {
        adopt(w);
        if (ORIG[openName]) { try { ORIG[openName](); } catch (e) { console.error('[apps] ' + openName + ' failed:', e); } }
      },
      onHide: function () {
        if (ORIG[closeName]) { try { ORIG[closeName](); } catch (e) { console.error('[apps] ' + closeName + ' failed:', e); } }
      },
    };
  }

  // ── The registry ─────────────────────────────────────────────────────────
  // icon: sprite id · tint: token · art: 'white' | 'graphite' tile for brand marks.
  var LIST = [
    // Dock (pinned), in the Android dock's order.
    // chrome:'split' — the page is a .mv-split (components/scan.js) like Settings and the engines:
    // it brings its own inset sidebar, so the window must hide its title bar and raise .mv-side-top
    // out from under the traffic lights. `row` is gone with the old two-column layout, and the
    // toolbar with it: every control it carried now lives in the page.
    Object.assign({ id: 'scanner', title: 'اسکنر آی‌پی', short: 'اسکنر', icon: 'g-radar', tint: 'blue',
      flush: true, chrome: 'split', size: [1200, 760], min: [820, 520] }, scannerKind()),
    // The Android app's V2Ray artwork (icons.js › ART), not the monochrome glyph.
    panel('ls-v2ray', { id: 'v2ray', title: 'نودهای V2Ray', short: 'V2Ray', icon: 'g-v2ray-art', image: true, tint: 'indigo', size: [1000, 700], min: [760, 500],
      // WHOEVER OWNS THE LIVE CONFIG OWNS THE LAMP.
      //
      // There is ONE Xray engine and six apps drive it: this list, «کانفیگ ایران»,
      // «اتصال سریع», «ضد فیلتر SNI», «دامین فرانتینگ» and «railway». All of them end at
      // markV2rayConnected(), which sets v2rayIsConnected — so connecting an Iran profile lit
      // the V2Ray icon as well as its own, and the desktop showed two engines running where
      // there is one. Each of those apps already knows whether the LIVE config is its own
      // (MVProbe.iran, for instance, matches /api/v2ray/traffic › uri against its profiles),
      // so V2Ray's lamp is the engine minus everyone else's claim.
      // `MVProbe.owns.X` when a panel publishes one, else its plain probe. The distinction is
      // real: «ضد فیلتر SNI»'s own lamp means "my front is listening", which it can be while
      // the ENGINE is carrying an ordinary V2Ray node — and reading that as a claim would put
      // the V2Ray icon's lamp out for a connection SNI had nothing to do with.
      legacy: 'v2ray', engine: probe(function () {
        if (window.v2rayIsConnected !== true) return false;
        var P = window.MVProbe || {};
        var owns = P.owns || {};
        return !['iran', 'quick', 'sni', 'fronting', 'vodi'].some(function (app) {
          var fn = typeof owns[app] === 'function' ? owns[app] : P[app];
          try { return typeof fn === 'function' && fn() === true; } catch (e) { return false; }
        });
      }),
      mountExtra: function (w) { var p = $('v2ray-footer-progress-container'); if (p) w.status.appendChild(p); } }),
    // The same finished artwork as the Android app's Settings icon (icons.js › ART).
    Object.assign({ id: 'settings', title: 'تنظیمات', icon: 'g-settings-art', image: true, tint: 'gray', flush: true, noZoom: true, chrome: 'split', size: [920, 660], min: [700, 440] }, settingsKind()),
    // «اپ‌استور» — one window for every updatable thing: engine cores, cloud panels, the app.
    // `flush`, like the engine windows: the page draws its own hero, sections and bottom bar, so
    // the window body's own padding would read as a gap between the content and the frame.
    panel('ls-store', { id: 'store', title: 'ام‌ال‌ام استور', short: 'استور', icon: 'g-store-art', image: true, tint: 'blue',
      // `chrome: 'split'` and `flush`, exactly as Settings: the page draws the App Store's own
      // glass sidebar with `.mv-split` / `.mv-side` / `.mv-pane`, so the window must give it the
      // split frame (traffic lights over the sidebar) and no body padding of its own.
      flush: true, chrome: 'split', size: [1040, 740], min: [620, 480],
      onShow: function (w) { panel('ls-store').onShow(w); if (typeof window.storeRender === 'function') window.storeRender(); } }),
    // A split page (components/cloud.js) like Settings and the engines: sections in an inset
    // sidebar instead of a second column of its own.
    panel('ls-cloud', { id: 'cloud', title: 'زیرساخت ابری', short: 'ابری', icon: 'g-cloudflare-art', art: 'cover', artBg: '#FFFFFF',
      flush: true, chrome: 'split', size: [980, 720], min: [760, 480], legacy: 'cloud',
      onShow: function (w) { panel('ls-cloud').onShow(w); if (typeof window.cloudRenderIdent === 'function') window.cloudRenderIdent(); } }),

    // Home grid, by expected use: connections, then config sources and tunnels, then tools.
    // The rocket, as on Android: the bolt is MASQUE's.
    panel('ls-quick', { id: 'quick', title: 'اتصال سریع', icon: 'g-rocket', tint: 'blue', flush: true, chrome: 'split', size: [900, 700], min: [700, 470], legacy: 'quick',
      engine: probe(function () { return window.MVProbe && window.MVProbe.quick && window.MVProbe.quick(); }) }),
    // The three WARP engines are three apps, as on Android: an icon and a window each.
    warpEngine('warp', 'warp', 'وارپ', 'g-warp-art', 'teal', 'cover', '#f06d6c'),
    warpEngine('masque', 'masque', 'ماسک', 'g-masque-art', 'blue', 'cover', '#FFFFFF'),
    warpEngine('wireguard', 'wg', 'وایرگارد', 'g-wireguard-art', 'green', 'cover', '#88171a', '84%'),
    warpEngine('warp_on_warp', 'gool', 'وارپ در وارپ', 'g-layers', 'orange'),
    // «گیت‌وی MLM» — the public SoftEther gateway network. Its own app, like every other engine.
    // No lamp shared with anything: it routes through the SoftEther client's own adapter, so it is
    // not the Xray the config panels drive and not the sing-box tunnel either.
    panel('ls-gateway', { id: 'gateway', title: 'گیت‌وی MLM', short: 'گیت‌وی', icon: 'g-gateway-art', art: 'cover', artBg: '#FFFFFF', tint: 'indigo', flush: true, chrome: 'split', size: [900, 700], min: [700, 470],
      engine: probe(function () { return window.MVProbe && window.MVProbe.gateway && window.MVProbe.gateway(); }),
      onShow: function (w) { panel('ls-gateway').onShow(w); if (typeof window.gatewayRefresh === 'function') window.gatewayRefresh(); } }),
    // `flush`, so the page runs edge to edge: these three draw their own hero, sections and
    // bottom bar, which already carry the spacing. The window body's own 12px would sit OUTSIDE
    // all of it and read as a gap between the content and the frame.
    // «سایفون», «تور» and «لنترن» — three more engines, an icon and a window each. Psiphon wears
    // its own mark (the Android drawable, redrawn as SVG), Tor wears the shield its Android tile
    // has, and Lantern wears its own logo — the cyan circle and yellow lantern from their
    // lantern_logo.svg, on this app's squircle. Each lamp is its own: these engines do not share
    // the Xray that the config panels drive, so a live Psiphon must not light V2Ray and vice versa.
    panel('ls-psiphon', { id: 'psiphon', title: 'سایفون', icon: 'g-psiphon-art', image: true, tint: 'red', flush: true, chrome: 'split', size: [900, 660], min: [700, 460],
      engine: probe(function () { return window.MVProbe && window.MVProbe.psiphon && window.MVProbe.psiphon(); }),
      onShow: function (w) { panel('ls-psiphon').onShow(w); if (typeof window.frontRefresh === 'function') window.frontRefresh('psiphon'); } }),
    panel('ls-tor', { id: 'tor', title: 'تور', icon: 'g-tor-art', art: 'white', big: true, tint: 'purple', flush: true, chrome: 'split', size: [900, 660], min: [700, 460],
      engine: probe(function () { return window.MVProbe && window.MVProbe.tor && window.MVProbe.tor(); }),
      onShow: function (w) { panel('ls-tor').onShow(w); if (typeof window.frontRefresh === 'function') window.frontRefresh('tor'); } }),
    panel('ls-lantern', { id: 'lantern', title: 'لنترن', icon: 'g-lantern-art', image: true, tint: 'teal', flush: true, chrome: 'split', size: [900, 640], min: [700, 460],
      engine: probe(function () { return window.MVProbe && window.MVProbe.lantern && window.MVProbe.lantern(); }),
      onShow: function (w) { panel('ls-lantern').onShow(w); if (typeof window.frontRefresh === 'function') window.frontRefresh('lantern'); } }),
    // «گف» — the fourth front engine. Blue, and flush like the other three, because it draws the
    // same hero/sections/bottom bar. Its own lamp: a live گف must not light تور.
    panel('ls-geph', { id: 'geph', title: 'گف', icon: 'g-geph-art', art: 'cover', artBg: '#FFFFFF', tint: 'blue', flush: true, chrome: 'split', size: [900, 680], min: [700, 460],
      engine: probe(function () { return window.MVProbe && window.MVProbe.geph && window.MVProbe.geph(); }),
      onShow: function (w) { panel('ls-geph').onShow(w); if (typeof window.frontRefresh === 'function') window.frontRefresh('geph'); } }),
    panel('ls-sni', { id: 'sni', title: 'موتور ضد فیلتر SNI', short: 'ضد فیلتر SNI', icon: 'g-sni', tint: 'purple', flush: true, chrome: 'split', size: [900, 700], min: [700, 470], legacy: 'sni',
      engine: probe(function () { return window.MVProbe && window.MVProbe.sni && window.MVProbe.sni(); }),
      onShow: function (w) { panel('ls-sni').onShow(w); if (typeof window.refreshSni === 'function') window.refreshSni(); } }),
    // Wider than it was, and flush: the window now holds a table of every site against every
    // engine, and an application picker — neither reads in a 480px strip with a 12px frame
    // around it. `sanctionEnabled` was a global the old panel set; the lamp asks the panel
    // itself now, the way every other engine's does.
    panel('ls-sanction', { id: 'sanction', title: 'تحریم‌شکن', icon: 'g-shield-check', tint: 'green', flush: true, chrome: 'split',
      size: [900, 700], min: [700, 470], legacy: 'sanction',
      engine: probe(function () { return window.MVProbe && window.MVProbe.sanction && window.MVProbe.sanction(); }),
      onShow: function (w) { panel('ls-sanction').onShow(w); if (typeof window.refreshSanction === 'function') window.refreshSanction(); } }),
    // The built-in serverless configs, out of V2Ray's list and onto the desktop, as on Android
    // (the country's outline on white — icons.js › ART).
    panel('ls-iran', { id: 'iran', title: 'کانفیگ ایران', icon: 'g-iran-art', image: true, tint: 'green', flush: true, chrome: 'split', size: [900, 700], min: [700, 470], legacy: 'iran',
      engine: probe(function () { return window.MVProbe && window.MVProbe.iran && window.MVProbe.iran(); }),
      onShow: function (w) { panel('ls-iran').onShow(w); if (typeof window.refreshIranConfigs === 'function') window.refreshIranConfigs(); } }),
    // Domain fronting with no server — its own icon, as on Android (SwapHoriz, yellow).
    panel('ls-fronting', { id: 'fronting', title: 'دامین فرانتینگ', icon: 'g-swap', tint: 'yellow', flush: true, chrome: 'split', size: [900, 700], min: [700, 470], legacy: 'fronting',
      engine: probe(function () { return window.MVProbe && window.MVProbe.fronting && window.MVProbe.fronting(); }),
      onShow: function (w) { panel('ls-fronting').onShow(w); if (typeof window.refreshFronting === 'function') window.refreshFronting(); } }),
    // «DNS اختصاصی» has no window of its own any more: it is one of «تحریم‌شکن»'s engines,
    // and its Worker is installed, updated and removed from there. A second place to set up
    // one engine was a menu entry for a decision made somewhere else.
    // A split page (components/openvpn.js). Its own engine: openvpn.exe from core/openvpn,
    // dialling the VPN Gate pool through the auto-ovpn mirror, which refreshes every 5 minutes.
    openvpnKind(),
    panel('ls-gst', { id: 'gst', title: 'تونل گوگل‌اسکریپت', short: 'گوگل‌اسکریپت', icon: 'g-google', art: 'white', flush: true, chrome: 'split', size: [900, 700], min: [700, 470], legacy: 'gst',
      engine: probe(function () { return gstState && gstState.running === true; }) }),
    panel('ls-github-tunnel', { id: 'github', title: 'گیت‌هاب تانل', short: 'گیت‌هاب', icon: 'g-github', art: 'graphite', flush: true, chrome: 'split', size: [900, 700], min: [700, 470], legacy: 'github-tunnel',
      engine: probe(function () { return gtState && gtState.engine && gtState.engine.engine && gtState.engine.engine.connected === true; }) }),
    panel('ls-vodi', { id: 'vodi', title: 'railway', short: 'railway', icon: 'g-railway-art', art: 'cover', artBg: '#FFFFFF', flush: true, chrome: 'split', size: [900, 700], min: [700, 470], legacy: 'vodi',
      engine: probe(function () { return window.MVProbe && window.MVProbe.vodi && window.MVProbe.vodi(); }) }),
    panel('ls-game', { id: 'game', title: 'شتاب‌دهی بازی', icon: 'g-pad', tint: 'green', flush: true, chrome: 'split', size: [900, 700], min: [700, 470], legacy: 'game',
      engine: probe(function () { return window.MVProbe && window.MVProbe.game && window.MVProbe.game(); }) }),
    Object.assign({ id: 'monitor', title: 'مانیتور مصرف', icon: 'g-bars', tint: 'yellow', kind: 'utility', flush: true, chrome: 'split', size: [900, 700], min: [700, 470] }, monitorKind()),
    Object.assign({ id: 'console', title: 'کنسول', icon: 'g-term', art: 'graphite', kind: 'utility', flush: true, chrome: 'split', size: [900, 620], min: [700, 420] }, consoleKind()),
    Object.assign({ id: 'guide', title: 'راهنما', icon: 'g-book', tint: 'orange', size: [960, 680], min: [560, 380] }, page('guide', 'openGuideTab', 'guide-root', 'renderGuideTab')),
    // A split page (components/changelog.js): the sidebar is the version index, with the kit's
    // own search over it; each release is its own page instead of an accordion in one long scroll.
    Object.assign({ id: 'changelog', title: 'تغییرات', icon: 'g-list', tint: 'indigo',
      chrome: 'split', size: [1000, 720], min: [760, 460] }, page('changelog', 'openChangelogTab', 'changelog-root', 'renderChangelogTab')),

    // The «ابزارها» folder.
    // A split page (components/netdiag.js): the verdict is the home section, the evidence and the
    // full report are their own, and the sidebar says what the last run concluded.
    Object.assign({ id: 'netdiag', title: 'دیاگ اینترنت', icon: 'g-pulse', tint: 'red', folder: 'tools',
      chrome: 'split', size: [960, 700], min: [740, 460] }, page('net-diag', 'openNetDiagTab', 'net-diag-root', 'renderNetDiagTab')),
    // A split page (components/dnsclean.js): the current resolver and the deep clean are the
    // home section, the resolver list and the "where is my DNS from" report are their own.
    Object.assign({ id: 'dnsclean', title: 'پاک‌سازی عمیق DNS', short: 'پاک‌سازی DNS', icon: 'g-sparkle', tint: 'blue', folder: 'tools',
      chrome: 'split', size: [960, 700], min: [740, 460] }, page('dns-clean', 'openDnsCleanTab', 'dns-clean-root', 'renderDnsCleanTab')),
    { id: 'speed', title: 'تست سرعت', icon: 'g-gauge', tint: 'green', folder: 'tools',
      run: function () { MV.wm.open('settings', { pane: 'speed' }); } },
    { id: 'syscheck', title: 'بررسی سیستم', icon: 'g-checkc', tint: 'orange', folder: 'tools',
      run: function () { if (typeof window.openSystemCheck === 'function') window.openSystemCheck(); } },
    Object.assign({ id: 'fixedip', title: 'آیپی لوکیشن', icon: 'g-pin', tint: 'pink', folder: 'tools', chrome: 'split', size: [900, 700], min: [700, 470] }, page('fixed-ip', 'openFixedIpTab', 'fixed-ip-root', 'renderFixedIpTab')),

    // The scanner's two big dialogs, now windows of their own: opened from its toolbar, its
    // «اسکن» menu and Ctrl+K — not from the home screen.
    Object.assign({ id: 'archive', title: 'آرشیو آی‌پی', icon: 'g-archive', tint: 'teal', size: [1000, 660], min: [620, 400] },
      sheetWindow('ip-archive-wrapper', 'openIpArchive', 'closeIpArchive')),
    // Its retest progress used to be appended to the SCANNER window's status bar — left over
    // from when the combination centre was a sheet inside the scanner. It is its own window.
    Object.assign({ id: 'combo', title: 'مرکز ترکیب کانفیگ‌ها', short: 'مرکز ترکیب', icon: 'g-combine', tint: 'indigo', size: [860, 660], min: [560, 400],
      mountExtra: function (w) { var p = $('combo-footer-progress-container'); if (p) w.status.appendChild(p); } },
      sheetWindow('combination-center-modal', 'openCombinationCenter', 'closeCombinationCenter')),
  ];

  var DOCK = ['scanner', 'v2ray', 'store', 'settings', 'cloud'];
  var HOME = ['warp', 'masque', 'wireguard', 'warp_on_warp', 'psiphon', 'tor', 'lantern', 'geph', 'gateway', 'openvpn', 'quick', 'sni', 'sanction', 'iran', 'fronting', 'free', 'gst', 'github', 'vodi', 'game', 'store', 'monitor', 'console', 'guide', 'changelog', '@tools'];
  // Folders are the user's ('mv-folders'): made by dropping one icon on another, renamed, emptied
  // and deleted on the desktop. «ابزارها» is only the one they start with — it can be renamed,
  // emptied and deleted like any other.
  var DEFAULT_FOLDERS = { tools: { title: 'ابزارها', apps: ['netdiag', 'dnsclean', 'speed', 'syscheck', 'fixedip'] } };
  function cloneFolders(f) { return JSON.parse(JSON.stringify(f)); }
  function readFolders() {
    try {
      var raw = window.PersistentStorage && PersistentStorage.getItem('mv-folders');
      var saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        var out = {}, taken = {};
        Object.keys(saved).forEach(function (k) {
          var f = saved[k];
          if (!/^[a-z0-9_-]{1,40}$/i.test(k) || !f || !Array.isArray(f.apps)) return;
          var apps = f.apps.filter(function (id) { if (!BY_ID[id] || taken[id]) return false; taken[id] = true; return true; });
          if (!apps.length) return;   // an empty folder is no folder
          out[k] = { title: String(f.title || 'پوشه').slice(0, 60), apps: apps };
        });
        return out;
      }
    } catch (e) { /* default */ }
    return cloneFolders(DEFAULT_FOLDERS);
  }
  function saveFolders(f) {
    var clean = {};
    Object.keys(f).forEach(function (k) { if (f[k] && f[k].apps && f[k].apps.length) clean[k] = f[k]; });
    MV.store('mv-folders', JSON.stringify(clean));
    return clean;
  }

  var BY_ID = {};
  LIST.forEach(function (a) {
    // Apps built with panel() carry their extra hook separately so mount stays one function.
    if (a.mountExtra) {
      var base = a.mount;
      a.mount = function (w) { base(w); try { a.mountExtra(w); } catch (e) { console.error(e); } };
    }
    BY_ID[a.id] = a;
  });

  // ── The special windows ──────────────────────────────────────────────────

  function scannerKind() {
    return {
      mount: function (w) {
        // #editor-area still hosts the legacy tab chrome that the other tab types are built
        // inside; the scan page itself is #scan-root within it (components/scan.js). Its five
        // toolbar buttons are gone — «تنظیمات اسکن» is the page's own sidebar, «تب اسکن جدید» is
        // the ＋ in it, «تاریخچه» is a section, and آرشیو/ترکیب are .mv-side-go rows. The three
        // controls that used to be moved up here (ذخیرهٔ خودکار, اسکن مجدد, شروع/توقف) are drawn
        // by the page: the round button IS #btn-top-scan.
        var ed = $('editor-area');
        if (ed) w.body.appendChild(ed);

        // The scan's own progress stays in the window's status bar. It is not the scan page's to
        // own: the fixed-ip tester (app.js) and the combination centre write to the same bar.
        var fp = $('footer-progress-container'); if (fp) w.status.appendChild(fp);

        // is-split hides the window title, so this line is no longer read on screen — the page's
        // bottom strip carries the same facts. Kept because w.state.subtitle is part of the
        // window contract and costs nothing.
        w.state.subtitle = function () {
          var t = typeof getActiveTab === 'function' ? getActiveTab() : null;
          var sub = !t ? 'اسکنی باز نیست' : (t.state === 'running' ? (t.isp || '') + ' · ' + (t.tested || 0) + ' از ' + (t.total || 0) : (t.isp || ''));
          w.setTitle('اسکنر آی‌پی', sub);
        };
        w.state.subtitle();
        if (ORIG.renderTabs) {
          window.renderTabs = function () { var r = ORIG.renderTabs.apply(this, arguments); try { w.state.subtitle(); } catch (e) { /* ignore */ } return r; };
        }
      },
      onShow: function () {
        // A window that has been hidden misses every repaint; catch it up on the way back.
        if (typeof window.scanPaint === 'function') window.scanPaint();
        if (typeof window.renderTabs === 'function') window.renderTabs();
      },
    };
  }

  function settingsKind() {
    return {
      mount: function (w) {
        var el = $('settings-tab-wrap');
        if (!el) return;
        el.classList.add('mv-page-root');
        w.body.appendChild(el);
        // The wallpaper picker belongs to the desktop, so it only exists with the shell on. It is
        // mounted into a hidden holder; Settings › صفحه نمایش › «تصویر زمینه» shows it
        // (components/android-settings.js moves it onto that page and back).
        var slot = $('mv-set-wallpaper-slot');
        if (slot && MV.wallpaper && !document.querySelector('.mv-wp-picker')) MV.wallpaper.mountPicker(slot);
      },
      onShow: function (w, opts) {
        if (opts && opts.pane && ORIG.switchSettingsTab) ORIG.switchSettingsTab(opts.pane);
        if (opts && opts.pane === 'notifications' && MV.notify) MV.notify.renderSettings();
        if (opts && opts.focus === 'wallpaper' && window.AndroidSettings) window.AndroidSettings.open('appearance', 'wallpaper');
      },
    };
  }

  /**
   * «کنسول» — the two logs, on the same split page every other window wears.
   *
   * They used to be a segmented control in the toolbar. Two things that are each a whole
   * screenful are two sections, not two halves of a button: the sidebar names them, the
   * pane shows one, and `select` keeps working for the callers that open a particular one.
   */
  var CONSOLE_SECS = [
    { id: 'core', label: 'لاگ هسته', icon: 'ph-fill ph-code', tint: 'var(--mv-green)' },
    { id: 'terminal', label: 'ترمینال اسکنر', icon: 'ph-fill ph-terminal-window', tint: 'var(--mv-blue)' },
  ];

  function consoleKind() {
    return {
      mount: function (w) {
        var core = $('view-core'), term = $('view-terminal');

        var wrap = document.createElement('div');
        wrap.className = 'mv-split';
        wrap.dir = 'rtl';
        wrap.style.cssText = 'position:relative; z-index:0; flex:1 1 auto; min-height:0;';
        wrap.innerHTML =
          '<aside class="mv-side" aria-label="بخش‌های کنسول">' +
            '<div class="mv-side-top"></div>' +
            '<div class="mv-eng-ident">' +
              '<span class="mv-side-tile" style="--tint:var(--mv-graphite, var(--mv-label-2)); width:54px; height:54px; border-radius:14px; font-size:26px">' +
                '<i class="ph-fill ph-terminal-window"></i></span>' +
              '<b>کنسول</b><small>دو گزارش زنده</small>' +
            '</div>' +
            '<nav class="mv-side-list"><div class="mv-side-group">' +
              CONSOLE_SECS.map(function (x) {
                return '<button type="button" class="mv-side-item" data-con-sec="' + x.id + '">' +
                  '<span class="mv-side-tile" style="--tint:' + x.tint + '"><i class="' + x.icon + '"></i></span>' +
                  '<span>' + x.label + '</span></button>';
              }).join('') +
            '</div></nav>' +
          '</aside>' +
          '<section class="mv-pane">' +
            '<header class="mv-pane-bar"><h1 class="mv-pane-title"></h1></header>' +
            '<div class="mv-pane-scroll custom-scrollbar" style="padding:0; display:flex; flex-direction:column; min-height:0">' +
              '<div class="mv-eng-sec is-on" data-sec="core" style="flex:1; min-height:0; display:flex; flex-direction:column"></div>' +
              '<div class="mv-eng-sec" data-sec="terminal" style="flex:1; min-height:0"></div>' +
            '</div>' +
          '</section>';
        w.body.appendChild(wrap);

        var slotCore = wrap.querySelector('[data-sec="core"]');
        var slotTerm = wrap.querySelector('[data-sec="terminal"]');
        // Each view keeps the display its own stylesheet gives it; the SECTION decides which
        // one is on screen, so the two settings never fight.
        if (core) { slotCore.appendChild(core); core.style.display = 'flex'; }
        if (term) { slotTerm.appendChild(term); term.style.display = 'block'; }

        var title = wrap.querySelector('.mv-pane-title');
        function select(v) {
          var found = CONSOLE_SECS.filter(function (x) { return x.id === v; })[0] || CONSOLE_SECS[0];
          wrap.querySelectorAll('.mv-eng-sec').forEach(function (n) {
            n.classList.toggle('is-on', n.getAttribute('data-sec') === found.id);
            // A section that IS the scroller needs its flex box back when it is shown.
            if (n.getAttribute('data-sec') === found.id) n.style.display = found.id === 'core' ? 'flex' : 'block';
            else n.style.display = 'none';
          });
          wrap.querySelectorAll('.mv-side-item[data-con-sec]').forEach(function (b) {
            b.classList.toggle('active', b.getAttribute('data-con-sec') === found.id);
          });
          if (title) title.textContent = found.label;
          w.state.view = found.id;
        }
        wrap.querySelectorAll('.mv-side-item[data-con-sec]').forEach(function (b) {
          b.onclick = function () { select(b.getAttribute('data-con-sec')); };
        });
        w.state.select = select;
        select('core');
      },
      onShow: function (w, opts) { if (opts && opts.tab && w.state.select) w.state.select(opts.tab); },
    };
  }

  // «اوپن‌وی‌پی‌ان». panel() only MOVES the element; the page still has to be told to refresh,
  // so its onShow chains onto the one panel() supplies rather than replacing it — replacing it
  // is how a panel ends up adopted into a window and never painted.
  //
  // It calls REFRESH, not init. The module builds itself once at boot (safeInit) and its init
  // ends with `display:none` on the container, exactly as the gateway's does; calling it again
  // from onShow re-hid the panel immediately after panel() had shown it, so the window opened
  // to an empty body with the whole page present underneath it.
  function openvpnKind() {
    var base = panel('ls-openvpn');
    return Object.assign({}, base, {
      id: 'openvpn', title: 'اوپن‌وی‌پی‌ان', short: 'OpenVPN',
      icon: 'g-openvpn-art', art: 'white', flush: true, chrome: 'split',
      size: [960, 700], min: [760, 480],
      legacy: 'openvpn',
      engine: probe(function () { return window.MVProbe && MVProbe.openvpn && MVProbe.openvpn(); }),
      onShow: function (w) {
        base.onShow(w);
        if (typeof window.openvpnRefresh === 'function') {
          try { window.openvpnRefresh(); } catch (e) { console.error(e); }
        }
      },
    });
  }

  function monitorKind() {
    return {
      mount: function (w) { whenEl('view-monitor', function (el) { w.body.appendChild(el); el.style.display = 'flex'; }); },
      onShow: function () { var el = $('view-monitor'); if (el) el.style.display = 'flex'; },
      onHide: function () { var el = $('view-monitor'); if (el) el.style.display = 'none'; },
    };
  }

  // ── Icons ────────────────────────────────────────────────────────────────
  function iconHTML(app, size) {
    // Artwork that carries its own ground is drawn as is, not on a tinted tile.
    if (app.image) return '<span class="mv-ic is-image" style="--sz:' + size + 'px">' + MV.icons.svg(app.icon) + '</span>';
    var cls = 'mv-ic'
      + (app.art === 'cover' ? ' is-cover'
        : app.art === 'white' ? ' is-art'
        : app.art === 'graphite' ? ' is-graphite' : '')
      + (app.big ? ' is-big' : '');
    var style = '--sz:' + size + 'px;'
      + (app.tint ? '--tint:var(--mv-' + app.tint + ');' : '')
      + (app.artBg ? '--art-bg:' + app.artBg + ';' : '')
      + (app.artScale ? '--art-scale:' + app.artScale + ';' : '')
      + (app.artColor ? 'color:' + app.artColor + ';' : '');
    return '<span class="' + cls + '" style="' + style + '">' + MV.icons.svg(app.icon) + '</span>';
  }

  function folderIconHTML(key, size) {
    var f = readFolders()[key] || { apps: [] };
    var dots = f.apps.slice(0, 9).map(function (id) {
      var a = BY_ID[id];
      return '<i style="--t:var(--mv-' + (a.tint || 'gray') + ')"></i>';
    }).join('');
    return '<span class="mv-ic is-folder" style="--sz:' + size + 'px">' + dots + '</span>';
  }

  MV.apps = {
    capture: capture,
    orig: ORIG,
    get: function (id) { return BY_ID[id] || null; },
    all: function () { return LIST.slice(); },
    dock: function () { return DOCK.slice(); },
    home: function () { return HOME.slice(); },
    folder: function (key) { return readFolders()[key] || null; },
    folders: readFolders,
    saveFolders: saveFolders,
    defaultFolders: function () { return cloneFolders(DEFAULT_FOLDERS); },
    // Every app the home screen shows somewhere — on the grid or in a folder.
    homeApps: function () {
      var ids = HOME.filter(function (id) { return id.charAt(0) !== '@'; });
      Object.keys(DEFAULT_FOLDERS).forEach(function (k) { ids = ids.concat(DEFAULT_FOLDERS[k].apps); });
      return ids;
    },
    defaultFolderOf: function (id) {
      var keys = Object.keys(DEFAULT_FOLDERS);
      for (var i = 0; i < keys.length; i++) if (DEFAULT_FOLDERS[keys[i]].apps.indexOf(id) > -1) return keys[i];
      return null;
    },
    byLegacy: function (name) {
      if (name === 'aether') return lastWarpApp();
      for (var i = 0; i < LIST.length; i++) if (LIST[i].legacy === name) return LIST[i].id;
      return null;
    },
    // Saved layouts from before the split name 'aether'; they get the three engines instead.
    warpApps: function () { return ['masque', 'wireguard', 'warp_on_warp']; },
    lastWarpApp: lastWarpApp,
    iconHTML: iconHTML,
    folderIconHTML: folderIconHTML,
    label: function (app) { return app.short || app.title; },
    engineUp: function (id) { var a = BY_ID[id]; return !!(a && a.engine && a.engine()); },
  };
})();
