// Android-Studio-style activity rails.
//
// Wraps the two existing `.activity-bar` columns without touching their markup:
// every button keeps its original onclick, we only decide where it lives.
//
// Four slots exist, one per rail group:
//   rail-tools:top / rail-tools:bottom      (right rail, RTL)
//   rail-modules:top / rail-modules:bottom  (left rail)
//
// Behaviour mirrors Android Studio's tool-window rail:
//   - a small set of icons is pinned by default; the rest park in the "…" menu
//   - clicking an entry in "…" pins it back
//   - right-click offers «مخفی کردن» and «انتقال آیکون» (submenu of the 4 slots)
//   - icons can also be dragged between slots
//   - icons entering a *top* slot stack downward (newest last); icons entering a
//     *bottom* slot stack upward (newest first) — they grow away from the edge
//   - exactly one icon app-wide carries the blue "newest" highlight; the one
//     before it fades to grey
//
// State lives in localStorage under RAIL_KEY so the layout survives restarts.

(function () {
  // v4: global placement map, cross-rail moves, single blue highlight.
  const RAIL_KEY = 'ide.activityRail.v4';

  // Icons pinned on a fresh install. Rails not listed keep everything visible.
  const DEFAULT_PINNED = {
    // «زیرساخت ابری» (first) and «نودهای V2RAY» (last) of the top group.
    'rail-modules': ['rail-modules#0', 'rail-modules#6'],
    'rail-tools': '*',
  };

  const SLOTS = [
    { id: 'rail-modules:top', label: 'چپ بالا' },
    { id: 'rail-modules:bottom', label: 'چپ پایین' },
    { id: 'rail-tools:top', label: 'راست بالا' },
    { id: 'rail-tools:bottom', label: 'راست پایین' },
  ];

  const RAILS = {}; // railId -> { top, bottom, more, divider }
  const BUTTONS = new Map(); // key -> button element

  let state = load();

  function load() {
    let s;
    try {
      s = JSON.parse(localStorage.getItem(RAIL_KEY));
    } catch {
      s = null;
    }
    s = s || {};
    s.hidden = s.hidden || []; // keys hidden app-wide
    s.place = s.place || {}; // key -> slot id, only for icons the user moved/pinned
    s.order = s.order || {}; // slot id -> [key, …] in placement order
    s.anchor = s.anchor || {}; // key -> key it was dropped directly above
    s.focus = s.focus || null; // key with the blue highlight
    s.prev = s.prev || null; // key that just lost it
    s.lastAdded = s.lastAdded || null; // most recently pinned/moved icon
    return s;
  }

  function save() {
    try {
      localStorage.setItem(RAIL_KEY, JSON.stringify(state));
    } catch {
      /* storage full or blocked — layout just won't persist */
    }
  }

  const slotOf = (id) => {
    const [railId, which] = id.split(':');
    const rail = RAILS[railId];
    return rail ? rail[which] : null;
  };
  const isTop = (id) => id.endsWith(':top');

  /* ---------------------------------------------------------------- styling */

  function injectStyles() {
    if (document.getElementById('activity-rail-styles')) return;
    const el = document.createElement('style');
    el.id = 'activity-rail-styles';
    el.textContent = `
      .activity-bar .rail-divider {
        width: 31px; height: 1px; flex: none;
        background: rgba(255,255,255,.11);
        margin: 5px auto 3px;
      }
      .activity-bar button.rail-focus {
        background: #3574F0; color: #fff;
        box-shadow: 0 0 0 1px rgba(53,116,240,.55), 0 2px 10px rgba(53,116,240,.45);
      }
      .activity-bar button.rail-focus:hover { background: #4a83f4; color: #fff; }
      .activity-bar button.rail-prev {
        background: rgba(255,255,255,.09);
        color: var(--ide-text-main, #EDEDED);
      }
      .activity-bar button.rail-more { color: var(--ide-text-dim); }
      .activity-bar button.rail-dragging { opacity: .4; }
      .activity-bar .rail-drop-slot {
        width: 32px; height: 32px; flex: none;
        border-radius: 8px; background: #2B4B8F;
        box-shadow: 0 0 0 1px rgba(53,116,240,.55) inset;
      }

      .rail-menu {
        position: fixed; z-index: 9999; min-width: 200px;
        padding: 5px; border-radius: 10px;
        background: var(--ide-panel, #2b2d30);
        border: 1px solid rgba(255,255,255,.10);
        box-shadow: 0 12px 34px rgba(0,0,0,.55);
        direction: rtl; font-size: 12px;
      }
      .rail-menu button {
        display: flex; align-items: center; gap: 9px; width: 100%;
        padding: 7px 9px; border: none; border-radius: 7px;
        background: none; cursor: pointer; text-align: right;
        color: var(--ide-text-main, #EDEDED); font-family: inherit; font-size: 12px;
      }
      .rail-menu button:hover:not([disabled]) { background: #3574F0; color: #fff; }
      .rail-menu button[disabled] { opacity: .38; cursor: default; }
      .rail-menu button svg { width: 16px; height: 16px; flex: none; }
      .rail-menu button .rail-caret { margin-inline-start: auto; opacity: .7; }
      .rail-menu .rail-menu-empty {
        padding: 8px 10px; color: var(--ide-text-dim, #9AA0A6); font-size: 11px;
      }
    `;
    document.head.appendChild(el);
  }

  // Little slot glyphs, mirroring the highlighted-corner icons in the IDE menu.
  function slotIcon(id) {
    const box = '<rect x="2.5" y="2.5" width="19" height="19" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.4"/>';
    const fills = {
      'rail-modules:top': '<rect x="3.5" y="3.5" width="6" height="8" rx="1" fill="currentColor"/>',
      'rail-modules:bottom': '<rect x="3.5" y="12.5" width="6" height="8" rx="1" fill="currentColor"/>',
      'rail-tools:top': '<rect x="14.5" y="3.5" width="6" height="8" rx="1" fill="currentColor"/>',
      'rail-tools:bottom': '<rect x="14.5" y="12.5" width="6" height="8" rx="1" fill="currentColor"/>',
    };
    return '<svg viewBox="0 0 24 24">' + box + (fills[id] || '') + '</svg>';
  }

  const ICON_HIDE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
    '<path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 002.8 2.8"/>' +
    '<path d="M9.4 5.2A9.7 9.7 0 0112 5c5 0 9 4.5 9 7a12 12 0 01-2.2 3.2"/>' +
    '<path d="M6.3 6.6C3.9 8.2 3 10.4 3 12c0 2.5 4 7 9 7 1.4 0 2.6-.3 3.7-.8"/></svg>';
  const ICON_MOVE =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">' +
    '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';
  const CARET =
    '<svg class="rail-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M15 6l-6 6 6 6"/></svg>';

  /* ------------------------------------------------------------------- menu */

  let menus = []; // open menu stack: [root, submenu, …]

  function closeMenus(fromDepth = 0) {
    menus.splice(fromDepth).forEach((m) => m.remove());
  }
  document.addEventListener('click', () => closeMenus());
  document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenus());

  function showMenu(x, y, items, depth = 0, flushRightOf = null) {
    closeMenus(depth);
    const menu = document.createElement('div');
    menu.className = 'rail-menu';
    if (!items.length) {
      menu.innerHTML = '<div class="rail-menu-empty">موردی برای نمایش نیست</div>';
    }
    items.forEach((it) => {
      const b = document.createElement('button');
      b.innerHTML =
        (it.icon || '') + '<span>' + it.label + '</span>' + (it.submenu ? CARET : '');
      if (it.disabled) b.disabled = true;
      if (it.submenu) {
        // Hovering opens the child list beside this row, IDE-style.
        b.addEventListener('mouseenter', () => {
          const r = b.getBoundingClientRect();
          // flushRightOf: the child is placed only after its real width is known,
          // so it butts against this menu's left edge instead of overlapping it.
          showMenu(0, r.top - 4, it.submenu(), depth + 1, menu);
        });
        b.addEventListener('click', (e) => e.stopPropagation());
      } else {
        // Moving onto a plain row must dismiss any submenu opened by a sibling,
        // otherwise the child list stays stranded on screen.
        b.addEventListener('mouseenter', () => closeMenus(depth + 1));
        b.onclick = (e) => {
          e.stopPropagation();
          closeMenus();
          it.action();
        };
      }
      menu.appendChild(b);
    });
    menu.style.visibility = 'hidden';
    document.body.appendChild(menu);
    // Keep the menu on screen — rails sit hard against the window edges.
    const r = menu.getBoundingClientRect();
    // A submenu opens leftwards (RTL): sit flush against the parent's left edge,
    // and only flip to its right side if there is no room on the left.
    if (flushRightOf) {
      const p = flushRightOf.getBoundingClientRect();
      x = p.left - r.width + 2;
      if (x < 4) x = p.right - 2;
    }
    menu.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    menu.style.visibility = 'visible';
    menus[depth] = menu;
    return menu;
  }

  function contextMenu(e, btn) {
    e.preventDefault();
    e.stopPropagation();
    const key = btn.dataset.railKey;
    showMenu(e.clientX, e.clientY, [
      { label: 'مخفی کردن', icon: ICON_HIDE, action: () => hide(key) },
      {
        label: 'انتقال آیکون',
        icon: ICON_MOVE,
        submenu: () =>
          SLOTS.map((s) => ({
            label: s.label,
            icon: slotIcon(s.id),
            disabled: s.id === currentSlot(key),
            action: () => move(key, s.id),
          })),
      },
    ]);
  }

  /* ------------------------------------------------------------- drag & drop */

  let dragKey = null;

  function wireDrag(btn) {
    btn.draggable = true;
    btn.addEventListener('dragstart', (e) => {
      dragKey = btn.dataset.railKey;
      btn.classList.add('rail-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox/Electron refuse to start a drag without payload.
      e.dataTransfer.setData('text/plain', dragKey);
    });
    btn.addEventListener('dragend', () => {
      btn.classList.remove('rail-dragging');
      clearGhost();
      dragKey = null;
    });
  }

  // A blue block that rides along with the cursor, occupying the exact spot the
  // icon will take, so the landing position is never a guess.
  let ghost = null;
  function clearGhost() {
    if (ghost) ghost.remove();
    ghost = null;
  }

  // The visible button the cursor currently sits *before*, or null for "at the end".
  function dropAnchor(group, y) {
    const items = [...group.children].filter(
      (e) =>
        e.tagName === 'BUTTON' &&
        e.style.display !== 'none' &&
        !e.classList.contains('rail-more') &&
        !e.classList.contains('rail-dragging')
    );
    return (
      items.find((el) => {
        const r = el.getBoundingClientRect();
        return y < r.top + r.height / 2;
      }) || null
    );
  }

  function wireDropTarget(group, slotId) {
    group.addEventListener('dragover', (e) => {
      if (!dragKey) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!ghost) {
        ghost = document.createElement('div');
        ghost.className = 'rail-drop-slot';
      }
      const anchor = dropAnchor(group, e.clientY);
      const more = RAILS[slotId.split(':')[0]].more;
      group.insertBefore(ghost, anchor || (more && more.parentElement === group ? more : null));
    });
    group.addEventListener('dragleave', (e) => {
      // Only clear when the cursor truly left the group, not on child transitions.
      if (!group.contains(e.relatedTarget)) clearGhost();
    });
    group.addEventListener('drop', (e) => {
      if (!dragKey) return;
      e.preventDefault();
      const anchor = dropAnchor(group, e.clientY);
      clearGhost();
      move(dragKey, slotId, anchor ? anchor.dataset.railKey : null);
    });
  }

  /* ------------------------------------------------------------------ state */

  function homeSlot(key) {
    const b = BUTTONS.get(key);
    return b ? b._railHomeSlot : null;
  }
  const currentSlot = (key) => state.place[key] || homeSlot(key);

  function dropFromOrder(key) {
    Object.keys(state.order).forEach((s) => {
      state.order[s] = state.order[s].filter((k) => k !== key);
    });
  }

  // Give `key` the blue highlight and demote whoever had it to grey.
  function focusKey(key) {
    if (state.focus === key) return;
    state.prev = state.focus;
    state.focus = key;
  }

  function hide(key) {
    if (!state.hidden.includes(key)) state.hidden.push(key);
    dropFromOrder(key);
    delete state.place[key];
    if (state.focus === key) {
      state.focus = state.prev;
      state.prev = null;
    }
    if (state.prev === key) state.prev = null;
    save();
    renderAll();
  }

  // `anchorKey` is the icon the dropped one should land *above*; null means the
  // slot's default growth direction (top slots append, bottom slots prepend).
  function place(key, slotId, anchorKey) {
    if (key === anchorKey) return;
    state.hidden = state.hidden.filter((k) => k !== key);
    dropFromOrder(key);
    state.place[key] = slotId;
    if (anchorKey) state.anchor[key] = anchorKey;
    else delete state.anchor[key];
    (state.order[slotId] = state.order[slotId] || []).push(key);
    state.lastAdded = key;
    focusKey(key);
    save();
    renderAll();
  }

  const pin = (key) => place(key, currentSlot(key)); // back from "…", same slot
  const move = (key, slotId, anchorKey) => place(key, slotId, anchorKey);

  /* ----------------------------------------------------------------- render */

  function renderAll() {
    Object.values(RAILS).forEach((r) => {
      if (r.more) r.top.appendChild(r.more); // "…" stays last
    });

    BUTTONS.forEach((b, key) => {
      const hidden = state.hidden.includes(key);
      b.style.display = hidden ? 'none' : '';
      b.classList.toggle('rail-focus', !hidden && state.focus === key);
      // Only a freshly added icon keeps a grey plate after losing the blue one;
      // an icon demoted by a panel click goes back to plain.
      b.classList.toggle(
        'rail-prev',
        !hidden && state.prev === key && state.prev === state.lastAdded
      );
    });

    // Explicitly placed icons stack away from the rail's anchored edge: top slots
    // append (newest last), bottom slots prepend (newest first). Untouched icons
    // keep their markup position, so nothing enforces a canonical order.
    SLOTS.forEach((s) => {
      const group = slotOf(s.id);
      if (!group) return;
      const rail = RAILS[s.id.split(':')[0]];
      (state.order[s.id] || []).forEach((key) => {
        const b = BUTTONS.get(key);
        if (!b || state.hidden.includes(key)) return;
        // A drag records the icon it was dropped above; honour that when the
        // anchor is still in this group, otherwise fall back to the edge rule.
        const anchor = BUTTONS.get(state.anchor[key]);
        if (anchor && anchor.parentElement === group && !state.hidden.includes(state.anchor[key])) {
          group.insertBefore(b, anchor);
        } else if (isTop(s.id)) {
          group.insertBefore(b, (rail && rail.more) || null);
        } else {
          group.insertBefore(b, group.firstElementChild);
        }
      });
    });

    // A hairline shows only once something has been added to a top group, sitting
    // between the defaults above and the additions below.
    Object.values(RAILS).forEach((r) => {
      const slotId = r.railId + ':top';
      const def = DEFAULT_PINNED[r.railId];
      // Default icons can end up in `order` too (a move re-registers them), so
      // the line anchors to the first *non-default* icon, not the first ordered
      // one — otherwise it drifts to the top of the rail.
      const added = (state.order[slotId] || []).filter(
        (k) =>
          !state.hidden.includes(k) &&
          BUTTONS.get(k) &&
          !(def !== '*' && (def || []).includes(k))
      );
      if (added.length) {
        r.top.insertBefore(r.divider, BUTTONS.get(added[0]));
        // The line only reads as a separator while it sits under the original
        // pair. With nothing above it, or once the group above has grown past
        // two, it stops meaning anything — so it fades out.
        const above = [...r.top.children]
          .slice(0, [...r.top.children].indexOf(r.divider))
          .filter((e) => e.tagName === 'BUTTON' && e.style.display !== 'none').length;
        r.divider.style.display = above === 2 ? '' : 'none';
      } else {
        r.divider.style.display = 'none';
      }
    });
  }

  /* ------------------------------------------------------------------ rails */

  function setup(rail, railId) {
    rail.id = rail.id || railId;
    const groups = [...rail.children].filter((c) => c.tagName === 'DIV');
    const top = groups[0];
    const bottom = groups[1] || groups[0];
    if (!top) return;

    const buttons = [...rail.querySelectorAll('button')].filter(
      (b) => !b.classList.contains('rail-more')
    );
    buttons.forEach((b, i) => {
      // The tooltip layer rewrites `title` at startup, so a title-derived key is
      // a race: lose it and every button collapses onto the same empty key and
      // nothing can be told apart in the "…" menu. Markup position is stable, so
      // that is the identity; the title is only used for the human label.
      const key = b.dataset.railKey || railId + '#' + i;
      b.dataset.railKey = key;
      b._railLabel =
        b.title || b.getAttribute('aria-label') || b.getAttribute('data-tooltip') || key;
      b._railHomeSlot = railId + (b.parentElement === top ? ':top' : ':bottom');
      BUTTONS.set(key, b);
      if (!b.dataset.railWired) {
        b.dataset.railWired = '1';
        b.addEventListener('contextmenu', (e) => contextMenu(e, b));
        // Capture phase: settle which side the panel docks on *before* the
        // button's own onclick opens it. Opening a panel also hands that icon
        // the blue highlight, so it always marks the most recent thing opened.
        b.addEventListener(
          'click',
          () => {
            dockPanel(b);
            if (!opensPanel(b)) return; // «تب جدید» and friends aren't panels
            focusKey(b.dataset.railKey);
            save();
            renderAll();
          },
          true
        );
        wireDrag(b);
      }
    });

    // Seed defaults on first run.
    const def = DEFAULT_PINNED[railId];
    if (!state[railId + ':seeded']) {
      if (def !== '*') {
        // Only the top group is collapsed by default; bottom icons stay pinned.
        buttons.forEach((b) => {
          if (b._railHomeSlot.endsWith(':top') && !def.includes(b.dataset.railKey)) {
            state.hidden.push(b.dataset.railKey);
          }
        });
      }
      state[railId + ':seeded'] = true;
      save();
    }

    let divider = top.querySelector('.rail-added-divider');
    if (!divider) {
      divider = document.createElement('div');
      divider.className = 'rail-divider rail-added-divider';
      top.appendChild(divider);
    }

    // Only the modules rail carries a "…" button — its menu already lists the
    // hidden icons of both rails, so a second one on the right was redundant.
    let more = top.querySelector('.rail-more');
    if (!more && railId === 'rail-modules') {
      more = document.createElement('button');
      more.className = 'rail-more';
      more.title = 'موارد بیشتر';
      more.innerHTML =
        '<svg style="width:24px;height:24px" viewBox="0 0 24 24" fill="currentColor">' +
        '<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
      const openOverflow = (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Second click on "…" closes the list again.
        if (menus.length) return closeMenus();
        const r = more.getBoundingClientRect();
        showMenu(r.right + 6, r.top, overflowItems());
      };
      more.addEventListener('click', openOverflow);
      more.addEventListener('contextmenu', openOverflow);
      top.appendChild(more);
    }

    wireDropTarget(top, railId + ':top');
    if (bottom !== top) wireDropTarget(bottom, railId + ':bottom');

    RAILS[railId] = { railId, top, bottom, divider, more };
  }

  /* ------------------------------------------------------- panel docking side */

  // A panel must open on the same side as the icon that opens it — an icon on the
  // right rail opening a drawer on the far left reads as a bug. The workspace row
  // is [scanner-sidebar, editor, left-sidebar]; flex `order` re-seats a panel on
  // the other side without moving anything in the DOM.
  const PANEL_FOR = [
    { fn: 'toggleLeftSidebar', panel: 'left-sidebar' },
    { fn: 'toggleSidebar', panel: 'scan-sidebar' },
  ];

  // Buttons that open a panel/view — the ones eligible for the blue highlight.
  const PANEL_OPENERS = [
    'toggleLeftSidebar',
    'toggleSidebar',
    'toggleBottomPanel',
    'toggleSettings',
    'toggleHistoryMenu',
  ];
  const opensPanel = (btn) => {
    const code = btn.getAttribute('onclick') || '';
    return PANEL_OPENERS.some((fn) => code.includes(fn));
  };

  function panelOf(btn) {
    const code = btn.getAttribute('onclick') || '';
    const hit = PANEL_FOR.find((p) => code.includes(p.fn));
    return hit ? document.getElementById(hit.panel) : null;
  }

  // Right rail sits at the start of an RTL row, so its panels take order 0;
  // left-rail panels take order 2, with the editor pinned between them at 1.
  function dockPanel(btn) {
    const panel = panelOf(btn);
    if (!panel) return;
    const editor = document.getElementById('editor-area');
    if (editor) editor.style.order = '1';
    const onRight = (currentSlot(btn.dataset.railKey) || '').startsWith('rail-tools');
    panel.style.order = onRight ? '0' : '2';
    // The resize handle lives on the edge facing the editor; flip it with the panel.
    const resizer = panel.querySelector('#ls-resizer');
    if (resizer) {
      resizer.style.right = onRight ? 'auto' : '-4px';
      resizer.style.left = onRight ? '-4px' : 'auto';
    }
  }

  // Every hidden icon, from either rail, in one list.
  function overflowItems() {
    return state.hidden
      .filter((key) => BUTTONS.has(key))
      .map((key) => {
        const btn = BUTTONS.get(key);
        return {
          label: btn._railLabel || key,
          icon: btn.innerHTML,
          action: () => pin(key),
        };
      });
  }

  function init() {
    injectStyles();
    const bars = [...document.querySelectorAll('.main-area .activity-bar')];
    // Markup order: tools rail first, module rail second.
    if (bars[0]) setup(bars[0], 'rail-tools');
    if (bars[1]) setup(bars[1], 'rail-modules');
    renderAll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
