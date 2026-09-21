// Horizontal drag-reordering for the editor tab bar, plus the IDE tab styling.
//
// renderTabs() rebuilds the bar's innerHTML on every state change, so the drag
// handlers are (re)attached from there via wireTabDrag(bar) rather than bound
// once at startup. The authoritative order lives in the global `tabs` array —
// dropping rewrites that array and re-renders, so the new order survives.

(function () {
  const style = document.createElement('style');
  style.id = 'ws-tab-styles';
  style.textContent = `
    .ws-tab {
      display: flex; align-items: center; gap: 8px;
      flex-shrink: 0; min-width: 132px; max-width: 220px;
      height: 26px; margin: 3px; padding: 0 8px;
      border-radius: 5px; cursor: pointer;
      font-size: 13px; line-height: 1; color: var(--ide-text-dim, #9AA0A6);
      background: transparent; border: 1px solid transparent;
      transition: background .15s, color .15s;
      user-select: none;
    }
    .ws-tab:hover { background: var(--mv-fill); color: var(--ide-text-main, #EDEDED); }
    .ws-tab.is-active {
      background: var(--mv-accent);
      border-color: transparent;
      color: #FFFFFF;
      font-weight: 500;
    }
    /* Icons stay monochrome so the strip reads as one row, not a color mix. */
    .ws-tab-icon { display: flex; align-items: center; justify-content: center; width: 16px; height: 16px; opacity: .7; }
    .ws-tab-icon svg { color: currentColor !important; }
    .ws-tab.is-active .ws-tab-icon { opacity: 1; color: var(--mv-label); }
    /* Persian glyphs (descenders, parentheses) are taller than a 16px line box:
       clamping the height clips them and the text reads as sitting too high.
       Give the line box room and let flex do the vertical centering. */
    .ws-tab-label {
      flex: 1; min-width: 0; overflow: hidden;
      line-height: 20px;
      text-overflow: ellipsis; white-space: nowrap; text-align: right;
    }
    .ws-tab-close {
      flex: none; font-size: 10px; line-height: 1; padding: 0;
      width: 16px; height: 16px;
      display: flex; align-items: center; justify-content: center;
      border: none; background: none; border-radius: 3px; cursor: pointer;
      color: var(--ide-text-dim, #9AA0A6); opacity: 0;
      transition: opacity .15s, background .15s, color .15s;
    }
    /* An SVG cross, not the ✕ glyph: glyph metrics put it off-centre. */
    .ws-tab-close svg { width: 10px; height: 10px; display: block; }
    .ws-tab:hover .ws-tab-close, .ws-tab.is-active .ws-tab-close { opacity: 1; }
    .ws-tab.is-active .ws-tab-close { color: var(--mv-label); }
    .ws-tab-close:hover { background: var(--mv-fill-3); color: var(--mv-red-ink); }

    .ws-tab.tab-dragging { opacity: .4; }
    /* Insertion marker between tabs while dragging. */
    .ws-tab-drop {
      flex: none; width: 3px; margin: 5px 1px; border-radius: 2px;
      background: var(--mv-accent); box-shadow: 0 0 6px color-mix(in srgb, var(--mv-blue) 60%, transparent);
    }
  `;
  document.head.appendChild(style);

  let dragId = null;
  let marker = null;

  function clearMarker() {
    if (marker) marker.remove();
    marker = null;
  }

  // Which tab the cursor sits *before*, in visual order. The bar is RTL, so
  // "before" means to the right of the midpoint, not the left.
  function anchorAt(bar, x) {
    const items = [...bar.querySelectorAll('.ws-tab:not(.tab-dragging)')];
    return (
      items.find((el) => {
        const r = el.getBoundingClientRect();
        return x > r.left + r.width / 2;
      }) || null
    );
  }

  window.wireTabDrag = function wireTabDrag(bar) {
    if (!bar) return;

    bar.querySelectorAll('.ws-tab').forEach((el) => {
      el.addEventListener('dragstart', (e) => {
        dragId = el.dataset.tabId;
        el.classList.add('tab-dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', dragId); // required by some engines
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('tab-dragging');
        clearMarker();
        dragId = null;
      });
    });

    if (bar.dataset.tabDndWired) return; // bar element survives re-renders
    bar.dataset.tabDndWired = '1';

    bar.addEventListener('dragover', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!marker) {
        marker = document.createElement('div');
        marker.className = 'ws-tab-drop';
      }
      bar.insertBefore(marker, anchorAt(bar, e.clientX));
    });

    bar.addEventListener('dragleave', (e) => {
      if (!bar.contains(e.relatedTarget)) clearMarker();
    });

    bar.addEventListener('drop', (e) => {
      if (dragId === null) return;
      e.preventDefault();
      const anchor = anchorAt(bar, e.clientX);
      clearMarker();

      // data-tab-id is always a string; tab ids may be numbers.
      const sameId = (t, id) => String(t.id) === String(id);
      const from = tabs.findIndex((t) => sameId(t, dragId));
      if (from < 0) return;
      const moved = tabs.splice(from, 1)[0];
      const to = anchor ? tabs.findIndex((t) => sameId(t, anchor.dataset.tabId)) : -1;
      if (to < 0) tabs.push(moved);
      else tabs.splice(to, 0, moved);

      dragId = null;
      renderTabs();
    });
  };
})();
