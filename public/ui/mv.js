/* =====================================================================
   MLMVPN UI runtime — the behaviour half of the design system.
   ---------------------------------------------------------------------
   Loaded right after persistent-storage.js, before any panel initialises.

   • MV.appearance  dark / light (the only two), decided at boot by
                    ui/appearance-boot.js; set() persists and repaints.
   • MV.prefs       «کاهش شفافیت» and «کاهش حرکت», per user, reversible.
   • applyTheme()   the old entry point, kept so any caller still works:
                    every legacy theme name folds onto dark or light.
   • toast()        same signature as before (msg, dur); now a macOS-style
                    banner, top-left (the RTL mirror of macOS's top-right).
   • MV.tech(s)     markup for a technical value (IP, port, host, config).
   ===================================================================== */
(function () {
  'use strict';

  var root = document.documentElement;
  var boot = window.MVBoot || {
    LIGHT_READY: false, lightUnlocked: false, preferred: 'dark', effective: 'dark',
    needsSave: false, read: function () { return null; },
  };

  function store(key, value) {
    try {
      if (window.PersistentStorage) { window.PersistentStorage.setItem(key, value); return; }
    } catch (e) { /* fall through */ }
    try { localStorage.setItem(key, value); } catch (e) { /* storage blocked: the choice lasts this session */ }
  }

  function setFlag(attr, value, on) {
    if (on) root.setAttribute(attr, value); else root.removeAttribute(attr);
  }

  var listeners = [];
  function emit() {
    listeners.forEach(function (fn) { try { fn(); } catch (e) { console.error('[MV] listener failed:', e); } });
  }

  function systemPrefers() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }
  function paintAppearance(name) {
    var wanted = name === 'auto' ? systemPrefers() : name;
    root.setAttribute('data-appearance', (wanted === 'light' && !boot.lightUnlocked) ? 'dark' : wanted);
  }

  var appearance = {
    // 'dark' | 'light' | 'auto' — «خودکار» follows Windows' own light/dark, live.
    preferred: boot.preferred,
    get effective() { return root.getAttribute('data-appearance') || 'dark'; },
    get lightUnlocked() { return !!boot.lightUnlocked; },
    set: function (name) {
      if (name !== 'light' && name !== 'dark' && name !== 'auto') return;
      appearance.preferred = name;
      store('mv-appearance', name);
      paintAppearance(name);
      emit();
    },
  };
  // Windows switched between light and dark while «خودکار» is chosen: follow it at once.
  try {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', function () {
      if (appearance.preferred !== 'auto') return;
      paintAppearance('auto');
      emit();
    });
  } catch (e) { /* no matchMedia: stays as painted */ }

  var prefs = {
    get reduceTransparency() { return root.getAttribute('data-transparency') === 'reduced'; },
    set reduceTransparency(on) {
      setFlag('data-transparency', 'reduced', !!on);
      store('mv-reduce-transparency', on ? '1' : '0');
      emit();
    },
    get reduceMotion() { return root.getAttribute('data-motion') === 'reduced'; },
    set reduceMotion(on) {
      setFlag('data-motion', 'reduced', !!on);
      store('mv-reduce-motion', on ? '1' : '0');
      emit();
    },
    // «چیدمان قدیمی»: shell/boot.js skips the desktop, dock and windows. Takes a reload.
    get legacyLayout() {
      try { return (window.PersistentStorage ? PersistentStorage.getItem('mv-shell') : boot.read('mv-shell')) === 'off'; }
      catch (e) { return false; }
    },
    set legacyLayout(on) {
      store('mv-shell', on ? 'off' : 'on');
      if (window.PersistentStorage && PersistentStorage.flush) PersistentStorage.flush();
      window.toast('برنامه با چیدمان ' + (on ? 'قدیمی' : 'جدید') + ' دوباره بارگذاری می‌شود…');
      setTimeout(function () { location.reload(); }, 900);
    },
  };

  // Record the one-time migration from the eight old themes, so the next boot reads
  // the new key directly.
  if (boot.needsSave) store('mv-appearance', boot.preferred);

  // ── Settings › صفحه نمایش: the desktop's sizes and the window tint ───────
  // Android's display page: icon size and caption size (60–140%), names under the dock icons,
  // and «تصویر زمینه در همه صفحات». Stored per user; shell/boot.js applies them before the
  // desktop's first frame (shell.css › "Settings › صفحه نمایش").
  var SCALE_MIN = 60, SCALE_MAX = 140;
  function readPref(key) {
    try { return window.PersistentStorage ? window.PersistentStorage.getItem(key) : boot.read(key); }
    catch (e) { return null; }
  }
  function scalePref(key, oldKey, oldSteps) {
    var v = parseInt(readPref(key), 10);
    if (v >= SCALE_MIN && v <= SCALE_MAX) return v;
    // 1.2.2's first build had three steps; they become the matching percentages.
    return oldSteps[readPref(oldKey)] || 100;
  }
  function applyScale(kind, v) {
    if (v === 100) { root.removeAttribute('data-' + kind + '-scale'); root.style.removeProperty('--mv-' + kind + '-scale'); }
    else { root.setAttribute('data-' + kind + '-scale', String(v)); root.style.setProperty('--mv-' + kind + '-scale', String(v / 100)); }
  }
  var displayPrefs = {
    SCALE_MIN: SCALE_MIN,
    SCALE_MAX: SCALE_MAX,
    get: function () {
      return {
        iconScale: scalePref('mv-icon-scale', 'mv-icon-size', { small: 81, large: 119 }),
        labelScale: scalePref('mv-label-scale', 'mv-label-size', { small: 92, large: 112 }),
        dockLabels: readPref('mv-dock-labels') === 'on',
        wallpaperTint: readPref('mv-wallpaper-tint') !== 'off',
      };
    },
    apply: function () {
      var p = displayPrefs.get();
      applyScale('icon', p.iconScale);
      applyScale('label', p.labelScale);
      setFlag('data-dock-labels', 'on', p.dockLabels);
      root.setAttribute('data-wallpaper-tint', p.wallpaperTint ? 'on' : 'off');
      var tint = readPref('mv-wall-tint');
      if (tint && /^#[0-9a-f]{6}$/i.test(tint)) root.style.setProperty('--mv-wall-tint', tint);
    },
    set: function (name, value) {
      if (name === 'iconScale' || name === 'labelScale') {
        var n = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(Number(value) || 100)));
        store(name === 'iconScale' ? 'mv-icon-scale' : 'mv-label-scale', String(n));
      } else if (name === 'dockLabels') store('mv-dock-labels', value ? 'on' : 'off');
      else if (name === 'wallpaperTint') store('mv-wallpaper-tint', value ? 'on' : 'off');
      else return;
      displayPrefs.apply();
      emit();
    },
    // The wallpaper's average colour, from shell/wallpaper.js each time it is drawn.
    setTint: function (hex) {
      if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return;
      root.style.setProperty('--mv-wall-tint', hex);
      if (readPref('mv-wall-tint') !== hex) store('mv-wall-tint', hex);
    },
  };

  // ── The legacy entry point ───────────────────────────────────────────────
  window.applyTheme = function (name) {
    appearance.set(name === 'light' || name === 'macLight' ? 'light' : 'dark');
  };

  // ── Technical values ─────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function tech(value) { return '<bdi class="mv-tech">' + esc(value) + '</bdi>'; }

  // ── toast() → banner ─────────────────────────────────────────────────────
  // Callers prefix messages with an emoji to say how it went. That prefix becomes the
  // banner's tinted icon, so the text itself reads clean.
  var TONES = [
    { re: /^\s*(✅|✔️|✔|🟢)\s*/u, tint: 'var(--mv-green)', icon: 'ph-bold ph-check' },
    { re: /^\s*(❌|⛔|🚫|🔴)\s*/u, tint: 'var(--mv-red)', icon: 'ph-bold ph-x' },
    { re: /^\s*(⚠️|⚠|🟡)\s*/u, tint: 'var(--mv-orange)', icon: 'ph-bold ph-warning' },
    { re: /^\s*(📋)\s*/u, tint: 'var(--mv-blue)', icon: 'ph-bold ph-copy' },
  ];
  var NEUTRAL = { tint: 'var(--mv-blue)', icon: 'ph-bold ph-info' };
  var MAX_BANNERS = 3;
  var stack = null;
  var MV_bannerHook = null;   // set by shell/notify.js through MV.onBanner()

  function ensureStack() {
    if (stack && stack.isConnected) return stack;
    stack = document.createElement('div');
    stack.className = 'mv-banners';
    stack.setAttribute('role', 'status');
    stack.setAttribute('aria-live', 'polite');
    document.body.appendChild(stack);
    return stack;
  }

  function dismiss(el) {
    if (!el || el.__mvLeaving) return;
    el.__mvLeaving = true;
    clearTimeout(el.__mvTimer);
    el.classList.add('is-leaving');
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
  }

  function showBanner(msg, dur) {
    var text = String(msg == null ? '' : msg);
    var tone = NEUTRAL;
    for (var i = 0; i < TONES.length; i++) {
      if (TONES[i].re.test(text)) { tone = TONES[i]; text = text.replace(TONES[i].re, ''); break; }
    }
    var host = ensureStack();
    var el = document.createElement('div');
    el.className = 'mv-banner';
    el.innerHTML =
      '<span class="mv-banner-ic" style="--tint:' + tone.tint + '"><i class="' + tone.icon + '"></i></span>' +
      '<div class="mv-banner-body">' +
        '<div class="mv-banner-title"><b class="mv-latin">MLMVPN</b><span>اکنون</span></div>' +
        '<div class="mv-banner-text"></div>' +
      '</div>';
    el.querySelector('.mv-banner-text').textContent = text;
    host.insertBefore(el, host.firstChild);
    while (host.children.length > MAX_BANNERS) dismiss(host.lastChild);

    // Errors and warnings are worth finding again later: the Notification Centre keeps them.
    if ((tone.tint === 'var(--mv-red)' || tone.tint === 'var(--mv-orange)') && typeof MV_bannerHook === 'function') {
      try { MV_bannerHook({ text: text, tint: tone.tint, icon: tone.icon }); } catch (e) { /* history is optional */ }
    }

    var life = Math.max(2500, Number(dur) || 2500);
    var arm = function () { el.__mvTimer = setTimeout(function () { dismiss(el); }, life); };
    el.addEventListener('mouseenter', function () { clearTimeout(el.__mvTimer); });
    el.addEventListener('mouseleave', arm);
    el.addEventListener('click', function () { dismiss(el); });
    arm();
  }

  window.toast = function (msg, dur) {
    try {
      if (document.body) { showBanner(msg, dur); return; }
    } catch (e) { console.error('[MV] banner failed:', e); }
    // No body yet, or the banner broke: the old single-line toast still exists.
    var t = document.getElementById('toast');
    if (t) { t.textContent = msg; t.classList.add('show'); setTimeout(function () { t.classList.remove('show'); }, dur || 2500); }
  };
  root.setAttribute('data-mv-toast', '');

  // ── Switches built from .mv-switch[role=switch] ──────────────────────────
  function flip(sw) {
    if (sw.getAttribute('aria-disabled') === 'true') return;
    var on = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(on));
    sw.dispatchEvent(new CustomEvent('mv-change', { bubbles: true, detail: { checked: on } }));
  }
  document.addEventListener('click', function (e) {
    var sw = e.target.closest && e.target.closest('.mv-switch[role="switch"]');
    if (sw) flip(sw);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    var sw = e.target.closest && e.target.closest('.mv-switch[role="switch"]');
    if (sw) { e.preventDefault(); flip(sw); }
  });

  // ── Settings › ظاهر ──────────────────────────────────────────────────────
  function syncAppearancePanel() {
    var panel = document.getElementById('panel-set-appearance');
    if (!panel) return;
    panel.querySelectorAll('[data-mv-appearance]').forEach(function (card) {
      var name = card.getAttribute('data-mv-appearance');
      card.setAttribute('aria-pressed', String(name === appearance.preferred));
      card.disabled = name === 'light' && !boot.lightUnlocked;
    });
    var note = document.getElementById('mv-light-note');
    if (note) {
      note.hidden = boot.lightUnlocked;
      note.textContent = appearance.preferred === 'light'
        ? 'ظاهر روشن را انتخاب کرده‌اید و انتخابتان ذخیره شده. بعد از اینکه همه‌ی پنل‌ها به طراحی جدید منتقل شوند، خودکار روشن می‌شود؛ تا آن موقع برنامه تیره نمایش داده می‌شود.'
        : 'ظاهر روشن بعد از اینکه همه‌ی پنل‌ها به طراحی جدید منتقل شوند فعال می‌شود.';
    }
    panel.querySelectorAll('[data-mv-pref]').forEach(function (sw) {
      sw.setAttribute('aria-checked', String(!!prefs[sw.getAttribute('data-mv-pref')]));
    });
  }

  function wireAppearancePanel() {
    var panel = document.getElementById('panel-set-appearance');
    if (!panel || panel.__mvWired) return;
    panel.__mvWired = true;
    panel.addEventListener('click', function (e) {
      var card = e.target.closest('[data-mv-appearance]');
      if (card && !card.disabled) appearance.set(card.getAttribute('data-mv-appearance'));
    });
    panel.addEventListener('mv-change', function (e) {
      var key = e.target.getAttribute('data-mv-pref');
      if (key) prefs[key] = e.detail.checked;
    });
    listeners.push(syncAppearancePanel);
    syncAppearancePanel();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireAppearancePanel);
  else wireAppearancePanel();

  // ── Menus (menu bar, dock, right-click) ──────────────────────────────────
  // MV.menu.open({ items, anchor: DOMRect | {x,y}, onClose })
  //   item: { label, sc, checked, disabled, danger, action } | { sep: true }
  // One menu at a time. Closes on an outside press, Escape, a resize, or a choice.
  var openMenu = null;

  function closeMenu() {
    if (!openMenu) return;
    var m = openMenu;
    openMenu = null;
    document.removeEventListener('mousedown', m.onDown, true);
    document.removeEventListener('keydown', m.onKey, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('blur', closeMenu);
    if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
    if (m.onClose) { try { m.onClose(); } catch (e) { /* caller's problem */ } }
  }

  function menuOpen(opts) {
    closeMenu();
    var items = (opts.items || []).filter(Boolean);
    var el = document.createElement('div');
    el.className = 'mv-menu';
    el.setAttribute('role', 'menu');
    el.style.position = 'fixed';
    el.style.visibility = 'hidden';
    items.forEach(function (it, i) {
      if (it.sep) { var s = document.createElement('div'); s.className = 'mv-msep'; el.appendChild(s); return; }
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'mv-mi' + (it.danger ? ' is-danger' : '');
      b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
      if (it.checked !== undefined) b.setAttribute('aria-checked', String(!!it.checked));
      b.disabled = !!it.disabled;
      b.dataset.i = String(i);
      b.innerHTML = '<span class="mv-mi-check" aria-hidden="true">' + (it.checked ? '✓' : '') + '</span>' +
        '<span class="mv-mi-label"></span>' + (it.sc ? '<span class="mv-sc"></span>' : '');
      b.querySelector('.mv-mi-label').textContent = it.label;
      if (it.sc) b.querySelector('.mv-sc').textContent = it.sc;
      el.appendChild(b);
    });
    // Pressing an item must not pull focus out of the field it acts on (Edit › Copy).
    el.addEventListener('mousedown', function (e) { e.preventDefault(); });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('.mv-mi');
      if (!b || b.disabled) return;
      var it = items[+b.dataset.i];
      closeMenu();
      if (it && typeof it.action === 'function') {
        try { it.action(); } catch (err) { console.error('[MV] menu action failed:', err); }
      }
    });
    document.body.appendChild(el);

    // Position: under the anchor, aligned to its start (right) edge, kept on screen.
    var r = opts.anchor || { left: 0, right: 0, top: 0, bottom: 0 };
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = (r.right !== undefined ? r.right : r.x) - w;
    var top = r.bottom !== undefined ? r.bottom + 4 : r.y;
    if (opts.atPoint) { left = r.x - w; top = r.y; }
    left = Math.max(6, Math.min(left, window.innerWidth - w - 6));
    if (top + h > window.innerHeight - 6) top = Math.max(6, (r.top !== undefined ? r.top : r.y) - h - 4);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    el.style.visibility = '';

    var m = {
      el: el, onClose: opts.onClose,
      onDown: function (e) { if (!el.contains(e.target) && !(opts.keepFor && opts.keepFor.contains(e.target))) closeMenu(); },
      onKey: function (e) {
        var btns = Array.prototype.filter.call(el.querySelectorAll('.mv-mi'), function (b) { return !b.disabled; });
        var cur = btns.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); closeMenu(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); (btns[cur + 1] || btns[0]).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (btns[cur - 1] || btns[btns.length - 1]).focus(); }
      },
    };
    openMenu = m;
    document.addEventListener('mousedown', m.onDown, true);
    document.addEventListener('keydown', m.onKey, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('blur', closeMenu);
    return closeMenu;
  }

  // ── Sheets: Escape dismisses the topmost panel dialog, as it does a macOS sheet ──────
  // Dialogs opened through showModal() already have this (components/ui-modal.js); the
  // rest (archive, combination centre, SNI import, zeus, free configs…) are opened by
  // their own code. Escape presses the dialog's OWN close or cancel control, so whatever
  // that dialog does on close — clearing state, restoring a selection — still happens.
  var SHEET_SEL = '[id$="-modal"], [id$="Modal"], #ip-archive-wrapper';
  var CLOSE_RE = /\b(close|hide|cancel|dismiss)\w*\s*\(|toggleHistoryMenu|style\.display\s*=\s*'none'/i;
  var NOT_CLOSE_RE = /confirm|save|deploy|delete|remove|start|\(\s*true\b/i;
  function sheetShown(el) {
    if (!el.isConnected || el.classList.contains('hidden')) return false;
    var cs = getComputedStyle(el);
    return cs.position === 'fixed' && cs.display !== 'none' && cs.visibility !== 'hidden' &&
      cs.pointerEvents !== 'none' && parseFloat(cs.opacity) > 0.05;
  }
  function topSheet() {
    var best = null, bestZ = -Infinity;
    [].forEach.call(document.querySelectorAll(SHEET_SEL), function (el) {
      if (!sheetShown(el)) return;
      var z = parseInt(getComputedStyle(el).zIndex, 10) || 0;
      if (z >= bestZ) { best = el; bestZ = z; }
    });
    return best;
  }
  function closeControl(sheet) {
    var own = sheet.getAttribute('onclick') || '';
    if (CLOSE_RE.test(own) && !NOT_CLOSE_RE.test(own)) return sheet;
    var list = sheet.querySelectorAll('[onclick], [aria-label="بستن"]');
    for (var i = 0; i < list.length; i++) {
      var oc = list[i].getAttribute('onclick') || '';
      if (list[i].getAttribute('aria-label') === 'بستن' || (CLOSE_RE.test(oc) && !NOT_CLOSE_RE.test(oc))) return list[i];
    }
    return null;
  }
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.altKey || e.metaKey) return;
    if (openMenu || document.querySelector('.uim-backdrop, .mv-spot')) return;   // they own Escape
    var sheet = topSheet();
    if (!sheet || sheet.__uimEsc) return;                                       // showModal's handler runs
    var ctl = closeControl(sheet);
    if (!ctl) return;
    e.preventDefault();
    ctl.click();
  });

  // ── Page kit behaviour (ui/page-kit.css) ─────────────────────────────────
  // The sidebar's search narrows its items by their label and data-kw; Enter opens the first
  // match. Persian ي/ك and ZWNJ fold, as in Ctrl+K.
  function fold(s) {
    return String(s || '').toLowerCase().replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
      .replace(/\u200C/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function sideItems(input) {
    var side = input.closest('.mv-side');
    return side ? [].slice.call(side.querySelectorAll('.mv-side-item')) : [];
  }
  document.addEventListener('input', function (e) {
    var input = e.target;
    if (!input.matches || !input.matches('[data-mv-side-search]')) return;
    var q = fold(input.value), shown = 0;
    sideItems(input).forEach(function (it) {
      var hit = !q || fold(it.textContent + ' ' + (it.dataset.kw || '')).indexOf(q) > -1;
      it.hidden = !hit;
      if (hit) shown++;
    });
    var side = input.closest('.mv-side');
    var empty = side && side.querySelector('[data-mv-side-empty]');
    if (empty) empty.hidden = shown > 0;
  });
  document.addEventListener('keydown', function (e) {
    var input = e.target;
    if (e.key !== 'Enter' || !input.matches || !input.matches('[data-mv-side-search]')) return;
    var first = sideItems(input).filter(function (it) { return !it.hidden; })[0];
    if (first) { e.preventDefault(); first.click(); }
  });
  // A hard scroll edge under the pane's title band once the form has scrolled under it.
  document.addEventListener('scroll', function (e) {
    var sc = e.target;
    if (!sc.classList || !sc.classList.contains('mv-pane-scroll')) return;
    var pane = sc.closest('.mv-pane');
    if (pane) pane.classList.toggle('is-scrolled', sc.scrollTop > 2);
  }, true);

  window.MV = {
    appearance: appearance,
    prefs: prefs,
    displayPrefs: displayPrefs,
    tech: tech,
    esc: esc,
    toast: window.toast,
    store: store,
    menu: { open: menuOpen, close: closeMenu, isOpen: function () { return !!openMenu; } },
    onChange: function (fn) { listeners.push(fn); },
    onBanner: function (fn) { MV_bannerHook = fn; },
    // The banner stack under the menu bar, for panels that post their own notification-style
    // offers (netdiag's «اتصال شبکه مشکل دارد») so they queue with the banners, not over them.
    bannerStack: ensureStack,
  };
})();
