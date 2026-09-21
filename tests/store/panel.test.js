// «ام‌ال‌ام استور» — the window itself (public/components/store.js).
//
// Two faults reported on 2026-09-21, both while an update was running:
//
//   1. «در زمان بروزرسانی در استور، نمیشه صفحه رو اسکرول کرد». Scrolling worked; it was undone.
//      `startPolling` calls `refresh() → render()` every 1.5 seconds while any job is running,
//      and `render()` is `root.innerHTML = shell()` — so the scroll container was replaced by a
//      brand-new one at scrollTop 0, faster than the user could read. Same for the search box:
//      typing during an update lost the caret and the text on the next tick.
//
//   2. «عدد بالای سایدبار استور نصفه نمایش داده میشه و جاش اصلا درست نیست». The update count
//      wore a class from a prefix this panel does not own alone. «دستیار» (assistant.js) also
//      prefixes with `as-`, its CSS is injected into the same document, and it had already
//      taken both obvious spellings:
//
//        · `.as-badge` — its launcher's corner dot, `position:absolute; top:-2px;
//          inset-inline-end:-2px`. The store's rule set colours and margins and never mentioned
//          `position`, so the assistant's won by default and the count positioned itself
//          against `.mv-side`. Measured before the fix: the count's box at left 792 / top 36
//          while its own row was at left 802 / top 260, and the sidebar started at 794 — the
//          top-outer corner of the sidebar, half outside it.
//        · `.as-count` — its quantity field, `align-self: stretch`, which pinned the count to
//          the top of its row instead of centring it.
//
//      The tag was the second half: page-kit gives `.mv-side-item > span:last-child` the label's
//      ellipsis, so appending a <span> moved the clipping off the label and onto the count.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '../../', p), 'utf8');
const store = read('public/components/store.js');
const assistant = read('public/components/assistant.js');
const pageKit = read('public/ui/page-kit.css');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

/** Every `as-*` class a file really defines — the ones in prose do not count. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const classesIn = (s) => new Set((strip(s).match(/\.(as-[a-z0-9-]+)/g) || []).map((x) => x.slice(1)));

// ── 2. the count in the sidebar ──────────────────────────────────────────────────────────────
t('the count no longer wears the prefix the two panels share',
    /<b class="st-count">/.test(store) && !/class="as-(badge|count)"/.test(store));
t('…and «دستیار» still owns `.as-badge`, absolutely positioned, so the collision was real',
    /\.as-badge\s*\{/.test(assistant)
    && /position:\s*absolute/.test(assistant.slice(assistant.indexOf('.as-badge'))));
t('…and `.as-count` too, with the align-self that pinned the count to the top of its row',
    /\.as-count \{[^}]*align-self: stretch/.test(assistant));
{
    // The guard that catches the NEXT one: two panels, one document, one prefix.
    const shared = [...classesIn(store)].filter((c) => classesIn(assistant).has(c));
    t('no `as-*` class is defined by both panels', shared.length === 0, shared.join(', '));
}
t('the count states position:static rather than inheriting whatever is lying around',
    /\.st-count \{[^}]*position:static/.test(store));
t('…and flex:none, so it is never squeezed narrower than its own digits',
    /\.st-count \{[^}]*flex:none/.test(store));
t('…and align-self:center, because something was overriding the row to stretch',
    /\.st-count \{[^}]*align-self:center/.test(store));
t('it is a <b>, not a <span>: page-kit clips «the last child span», which is the LABEL',
    /<b class="st-count">/.test(store) && !/<span class="st-count">/.test(store));
t('…and page-kit really does clip that span, so the <b> is load-bearing',
    /\.mv-side-item > span:last-child \{[^}]*text-overflow: ellipsis/.test(pageKit));
t('the label gets its ellipsis back, scoped to this panel',
    /\.as-split \.mv-side-item > span:last-of-type:not\(\.mv-side-tile\)/.test(store));

// ── 1. the page under a running update ───────────────────────────────────────────────────────
t('a re-render carries the pane\'s scroll position across',
    /function captureUi\(root\)/.test(store) && /pane: pane \? pane\.scrollTop : 0/.test(store));
t('…and the sidebar\'s', /side: side \? side\.scrollTop : 0/.test(store));
t('…and the search box, its focus and its caret',
    /qFocus:/.test(store) && /qStart:/.test(store) && /setSelectionRange/.test(store));
t('render() captures before it replaces the DOM',
    /const keep = captureUi\(root\);\s*\n\s*root\.innerHTML = shell\(\);/.test(store));
t('…and restores after the listeners exist, so a carried query redraws its own results',
    /restoreUi\(root, keep\);\s*\n\s*\}/.test(store) && /dispatchEvent\(new Event\('input'\)\)/.test(store));
t('a blank query is never dispatched — that handler calls go(), which renders, which lands here',
    /if \(keep\.q\.trim\(\)\) q\.dispatchEvent/.test(store));
t('navigation still jumps to the top, because that is a navigation and not a redraw',
    /function go\(name, arg\) \{[\s\S]{0,220}pane\.scrollTop = 0;/.test(store));
t('the polling that caused it is still there — the fix is preservation, not silence',
    /setInterval\(async \(\) => \{[\s\S]{0,420}await refresh\(\);/.test(store));

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
assert.ok(true);
process.exit(failed ? 1 : 0);
