/*
 * The renderer, and the sentence it is allowed to say.
 *
 * This suite exists because the engine's whole value can be thrown away in the last two
 * inches. An engine that carefully reaches «possible» and a panel that renders «علت پیدا شد»
 * have, between them, produced a confident wrong answer — and the user only ever sees the
 * panel.
 *
 * So the component is loaded into a minimal DOM stub and asked what it renders for each
 * verdict. Two sentences must be structurally impossible to produce:
 *
 *   «حل شد»            for anything that is not a verified fix
 *   «مشکلی پیدا نشد»   when the truth is that the evidence did not reach
 *
 * The second is the one that matters most. Telling a user with no internet that nothing is
 * wrong is worse than telling them nothing.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'components', 'netdiag.js'), 'utf8');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

// ── a DOM small enough to reason about ──────────────────────────────────────────────────

const nodes = new Map();

/**
 * One node shape for both `getElementById` and `createElement`.
 *
 * They used to be two different object literals, and the shorter one is what broke this suite:
 * the panel gained `root.classList.add('nd-split', 'mv-split')` and the created node had no
 * `classList`, so the whole file died on a TypeError before a single verdict was rendered. Two
 * hand-written shapes drift; one factory cannot.
 *
 * `classList` is backed by `className`, so it is the same string the component reads and writes
 * rather than a second, parallel truth. The query methods answer empty — this DOM has no tree,
 * and the component only uses them to attach click handlers to a sidebar that no assertion here
 * touches. That is the stub staying small ON PURPOSE: what is being tested is the sentence the
 * renderer produces, not the browser.
 */
function makeNode(id) {
    const node = {
        id: id || '', innerHTML: '', textContent: '', dir: '', disabled: false, scrollTop: 0,
        className: '',
        style: { setProperty() {} },
        appendChild() {}, remove() {}, addEventListener() {}, setAttribute() {}, getAttribute() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
    };
    const classes = () => node.className.split(/\s+/).filter(Boolean);
    node.classList = {
        add(...names) { node.className = [...new Set(classes().concat(names))].join(' '); },
        remove(...names) { node.className = classes().filter(c => !names.includes(c)).join(' '); },
        contains(name) { return classes().includes(name); },
        toggle(name, on) {
            const want = on === undefined ? !node.classList.contains(name) : !!on;
            if (want) node.classList.add(name); else node.classList.remove(name);
            return want;
        },
    };
    return node;
}

function el(id) {
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
}

global.document = {
    getElementById: id => (nodes.has(id) ? nodes.get(id) : null),
    createElement: () => makeNode(''),
    head: { appendChild() {} },
};
/**
 * `window` that behaves like the browser's: an assignment to it also creates a global.
 *
 * The component both publishes its hooks as `window.ndGo = …` and calls them bare — `ndGo('check')`
 * — which is correct in a browser, where the two are the same binding. A plain object here is not:
 * the property landed on the object and the bare call resolved to nothing, so the file died on
 * `ReferenceError: ndGo is not defined` the moment the panel rendered.
 *
 * Mirroring the assignment is the smallest faithful fix. Special-casing the one name would mean
 * this suite breaks again the next time the panel publishes a hook.
 */
global.window = new Proxy({}, {
    set(target, prop, value) { target[prop] = value; globalThis[prop] = value; return true; },
    get(target, prop) { return prop in target ? target[prop] : globalThis[prop]; },
});
global.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
global.tabs = [];
global.switchTab = () => {};
global.toast = () => {};
global.updateBreadcrumb = () => {};
global.copyText = txt => { global.__copied = txt; };
global.dlFile = (n, txt) => { global.__saved = txt; };
global.uiConfirm = async () => true;

// The panel's render targets have to exist before the component renders into them.
//
// THREE, not one. The panel was a single scroll when this suite was written and is now a sidebar
// with sections, and two of them — `nd-evidence` and `nd-report` — are written by `ndRenderSide`.
// Since `root.innerHTML = ND_SHELL` does nothing in a DOM stub that cannot parse HTML, those two
// elements never existed here, `ndRenderSide` found null and returned, and everything it draws
// silently disappeared from what this file was asserting on. That is how «it names the evidence
// that was missing» and «by-design state is shown as deliberate» came to fail: not a regression
// in the panel, which does both, but a stub that had stopped describing it.
el('net-diag-content');
el('nd-evidence');
el('nd-report');

// Loaded by evaluation rather than require(): it is a browser script with no module wrapper,
// and rewriting it to be requireable would mean testing a different file from the one shipped.
// eslint-disable-next-line no-new-func
new Function('window', 'document', 'tabs', 'switchTab', 'toast', 'updateBreadcrumb',
    'copyText', 'dlFile', 'uiConfirm', 'fetch', SRC)(
    global.window, global.document, global.tabs, global.switchTab, global.toast,
    global.updateBreadcrumb, global.copyText, global.dlFile, global.uiConfirm, global.fetch);

t('the component exposes the tab hooks renderActiveTab expects',
    typeof global.window.openNetDiagTab === 'function' && typeof global.window.renderNetDiagTab === 'function');
t('...and the WS progress hook scanner-sidebar calls',
    typeof global.window.handleNetDiagEvent === 'function');

/** Render a narrative through the real component and return the HTML it produced. */
function renderWith(narrative, extra) {
    global.window.renderNetDiagTab();          // creates state and renders once
    // The component keeps its state in a module-local; the only supported way in is through
    // the public hooks, so the narrative is injected the same way the poll would.
    const inject = new Function('narrative', 'extra', 'render', SRC + `
        ndState.sessionId = 'a'.repeat(32);
        ndState.narrative = narrative;
        ndState.running = false;
        ndState.percent = 100;
        ndState.phase = 'done';
        Object.assign(ndState, extra || {});
        ndRender();
        ndRenderSide();
        // Everything the window shows, from all three of its sections. The user reaches them from
        // one sidebar in one window, so "what the panel says" is their sum — and collecting only
        // the first section would let a sentence this suite forbids hide in the other two.
        return {
            html: ['net-diag-content', 'nd-evidence', 'nd-report']
                .map(id => (document.getElementById(id) || { innerHTML: '' }).innerHTML).join('\\n'),
            report: ndBuildReport(),
        };
    `);
    return inject(narrative, extra);
}

const finding = (id, title, verdict, over) => Object.assign({
    id, title, verdict, category: 'test', consequenceOf: null, caps: [], conflicts: [],
    unknownMass: 0, missing: [], repairs: [], reason: null,
}, over || {});

const narrative = over => Object.assign({
    headline: { kind: 'nothing-found' },
    rootCauses: [], consequences: [], independent: [], unresolved: [], byDesign: [],
    missingEvidence: [],
}, over || {});

// ── the wording contract, verdict by verdict ────────────────────────────────────────────

let out = renderWith(narrative({
    headline: { kind: 'single-root', id: 'proxy.dead-listener' },
    rootCauses: [finding('proxy.dead-listener', 'پراکسی سیستم مرده است', 'confirmed')],
}));
t('confirmed leads with «علت پیدا شد»', /علت پیدا شد/.test(out.html), out.html.slice(0, 200));

out = renderWith(narrative({
    headline: { kind: 'single-root', id: 'x' },
    rootCauses: [finding('x', 'چیزی', 'likely')],
}));
t('likely says «به احتمال زیاد» and never «علت پیدا شد»',
    /به احتمال زیاد/.test(out.html) && !/علت پیدا شد/.test(out.html), out.html.slice(0, 240));

out = renderWith(narrative({
    headline: { kind: 'single-root', id: 'x' },
    rootCauses: [finding('x', 'چیزی', 'possible')],
}));
t('possible says «یکی از احتمال‌ها» and never «علت پیدا شد»',
    /یکی از احتمال‌ها/.test(out.html) && !/علت پیدا شد/.test(out.html));

// The most important case in the file.
out = renderWith(narrative({
    headline: { kind: 'undetermined', reason: 'evidence-incomplete' },
    unresolved: [finding('y', 'یک چیز نامشخص', 'indeterminate', { unknownMass: 0.8 })],
    missingEvidence: ['reach.domestic.status.v4', 'app.tun.verdict'],
}));
t('undetermined says «علت قطعی پیدا نشد» — NOT «مشکلی پیدا نشد»',
    /علت قطعی پیدا نشد/.test(out.html) && !/مشکلی پیدا نشد/.test(out.html), out.html.slice(0, 300));
t('...and it names the evidence that was missing, so «نامشخص» is honest rather than evasive',
    /reach\.domestic\.status\.v4/.test(out.html));

// And the genuinely-clean case, which is a DIFFERENT sentence.
out = renderWith(narrative({ headline: { kind: 'nothing-found' } }));
t('a clean machine says «مشکلی پیدا نشد» and never «علت قطعی پیدا نشد»',
    /مشکلی پیدا نشد/.test(out.html) && !/علت قطعی پیدا نشد/.test(out.html));

// ── never claim a fix ───────────────────────────────────────────────────────────────────

// Comments stripped once, and reused: the header explains at length which sentences are
// forbidden, and naming them there must not read as saying them.
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// «حل شد؟» is a QUESTION — it is one of the report's eight headings, and asking it is the
// point. What must not exist is the assertive form, which would claim a fix the panel has no
// evidence for. The first version of this check banned the substring outright and failed on
// the heading, which would have pushed the fix in the wrong direction: deleting the question.
const assertiveFixed = CODE.replace(/آیا[^\n]*حل شد؟/g, '');
t('the component never ASSERTS «حل شد» — only ever asks it as a report heading',
    !/حل شد/.test(assertiveFixed),
    (assertiveFixed.match(/.{0,50}حل شد.{0,50}/) || [''])[0]);
t('the repair result is reported as «انجام شد», which is what the endpoint actually proves',
    /انجام شد/.test(CODE));

// ── multiple roots are not collapsed into one ───────────────────────────────────────────

out = renderWith(narrative({
    headline: { kind: 'multiple-roots', ids: ['a', 'b'] },
    rootCauses: [finding('a', 'اولی', 'confirmed'), finding('b', 'دومی', 'confirmed')],
}));
t('two co-equal roots are announced as several, not headlined as one',
    /چند علت مستقل/.test(out.html) && /اولی/.test(out.html) && /دومی/.test(out.html));

// ── consequences and by-design are visibly not causes ───────────────────────────────────

out = renderWith(narrative({
    headline: { kind: 'single-root', id: 'a' },
    rootCauses: [finding('a', 'علت', 'confirmed')],
    consequences: [finding('b', 'پیامد', 'confirmed', { consequenceOf: 'a' })],
    byDesign: [finding('c', 'محافظت VPN', 'eliminated')],
}));
t('a consequence is labelled as the result of the cause above it',
    /نتیجهٔ همان مورد بالاست/.test(out.html));
t('by-design state is shown as deliberate, not as a fault',
    /عمدی است، مشکل نیست/.test(out.html));

// ── the generation warning ──────────────────────────────────────────────────────────────

out = renderWith(narrative({ headline: { kind: 'single-root', id: 'a' }, rootCauses: [finding('a', 'x', 'confirmed')] }),
    { generation: { unstable: true, current: 1, samples: [] } });
t('a machine that changed mid-run is flagged, and the result is offered with less confidence',
    /وضعیت شبکه در حین بررسی تغییر کرد/.test(out.html));

// ── the report ──────────────────────────────────────────────────────────────────────────

out = renderWith(narrative({
    headline: { kind: 'undetermined' },
    missingEvidence: ['reach.domestic.status.v4'],
}));
const headings = ['چه اتفاقی افتاده', 'چرا صفحه‌ها باز نمی‌شوند', 'چه چیزی را واقعاً اندازه گرفتیم',
    'چه چیزی نامشخص است', 'چه کاری می‌خواهیم انجام دهیم', 'چه ریسکی دارد',
    'بعد از تعمیر چه چیزی را بررسی کردیم', 'آیا مشکل واقعی حل شد'];
t('the report answers the eight questions, in order',
    headings.every(h => out.report.includes(h))
    && headings.map(h => out.report.indexOf(h)).every((v, i, a) => i === 0 || v > a[i - 1]),
    headings.filter(h => !out.report.includes(h)).join(' | '));
t('the report states «علت قطعی پیدا نشد» rather than inventing one',
    /علت قطعی پیدا نشد/.test(out.report));
t('the report is local text — the component has no upload path at all',
    !/upload/i.test(CODE) && !/fetch\(\s*['"`]https?:\/\//i.test(CODE),
    (CODE.match(/.{0,40}(upload|fetch\(\s*['"`]https?:).{0,40}/i) || [''])[0]);
t('...and every request it makes is to a relative /api/netdiag path on this server',
    (CODE.match(/fetch\(/g) || []).length === (CODE.match(/fetch\(`\/api\/netdiag\//g) || []).length,
    (CODE.match(/fetch\([^)]*/g) || []).join(' | '));

// ── the request the panel sends ─────────────────────────────────────────────────────────

t('the repair request carries only sessionId, repairId and confirmToken',
    /sessionId: ndState\.sessionId,\s*\n\s*repairId: offer\.repairId,\s*\n\s*confirmToken: offer\.confirmToken,/.test(SRC),
    (SRC.match(/ndApi\('repair'[\s\S]{0,220}/) || [''])[0]);
t('every request carries the injected token', /X-Netdiag-Token/.test(SRC));
t('a non-auto repair is confirmed with uiConfirm before it runs',
    /uiConfirm\(/.test(SRC) && /tier !== 'auto'/.test(SRC));
t('a confirm-danger repair uses the red dialog',
    /danger: danger|danger,/.test(SRC) && /confirm-danger/.test(SRC));


// ── the auto-offer: the second entry point ──────────────────────────────────────────────
//
// The locked requirement is a menu entry PLUS an offer when a network operation elsewhere in
// the app fails. The offer has to be an offer: opening a diagnostic tab is one thing, starting
// probes on a machine unasked is another.

t('the component installs a central watcher over /api calls, so no feature needs its own hook',
    CODE.includes('__ndFetchWatched') && CODE.includes('window.fetch = '));
t('...it ignores the netdiag routes, or a failing diagnosis would offer to diagnose itself',
    CODE.includes("includes('/api/netdiag/')") && CODE.includes('const ours'));
t('...it ignores 4xx, which is the app refusing a bad request rather than the network failing',
    CODE.includes('res.status >= 500') && !CODE.includes('status >= 400'));
t('...and it needs several failures in a row, so one timeout is not a prompt',
    CODE.includes('ND_FAIL_THRESHOLD') && CODE.includes('ndFailures.length >= ND_FAIL_THRESHOLD'));
t('the offer is rate-limited, so a repeatedly failing operation does not repeatedly ask',
    CODE.includes('ND_OFFER_COOLDOWN_MS') && CODE.includes('ndLastOfferAt'));
t('the offer does not appear while the panel is already open or a run is in progress',
    CODE.includes('if (ndState.running) return;') && CODE.includes("t.type === 'net-diag'"));
t('accepting the offer auto-runs, because the user has already said something failed',
    CODE.includes('openNetDiagTab({ autorun: true })'));
t('opening from the MENU does not auto-run — a panel opened out of curiosity must not probe',
    CODE.includes('if (opts && opts.autorun) ndStart'));
t('only network-shaped failures count; a validation refusal is not a symptom',
    CODE.includes('ndLooksNetworky') && /ETIMEDOUT|ECONN/.test(CODE));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
