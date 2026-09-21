// --- «اتصال سریع» panel ---
//
// Renders into #ls-quick. A ready-made server pool with flags, a country picker, and one
// button that goes from nothing to a verified connection.
//
// THREE RULES THIS PANEL IS BUILT AROUND
//
// 1. One primary action at a time. When disconnected there is exactly one button worth
//    pressing; when connected it becomes the one button that undoes it. Everything else is
//    secondary and looks it. A panel with four equally-loud buttons is a panel nobody
//    understands.
//
// 2. Never claim a state we have not confirmed. Every switch reads back from
//    /api/quick/status after it settles, and the tunnel is drawn from the server's own
//    view — not from the fact that a request returned 200. A switch that says "protected"
//    over an unprotected machine is the worst thing this screen can do.
//
// 3. Say where the traffic really goes. The flag on a server row is what the server calls
//    itself; the flag in the status card is a live measurement through the engine. They are
//    labelled differently on purpose, because they are different claims.

(function () {
    'use strict';

    const $q = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));

    /**
     * The proven list, kept between sessions — the way the Android app keeps it.
     *
     * It used to live only in `state.proven`, so closing the window threw away every server the
     * user had just spent minutes proving, and the section greeted them next time with «هنوز
     * سروری آزمایش نشده» over an empty box. That is the same sentence it showed a user who had
     * never scanned at all, which is why the message read as broken rather than as empty.
     *
     * localStorage and not a file on the server side: the country and the mode already live
     * here, the renderer is the only reader, and this store reaches ~/.mlmvpn/user_data.json
     * with everything else the panel remembers.
     */
    const PROVEN_KEY = 'quick-proven';

    function loadProven() {
        try {
            const raw = JSON.parse(localStorage.getItem(PROVEN_KEY) || '[]');
            return Array.isArray(raw) ? raw.filter((n) => n && n.uri && n.id) : [];
        } catch (e) { return []; }
    }

    function saveProven(list) {
        // Capped, but generously: the list is meant to GROW across searches now, so a bound
        // sized for one run's worth would quietly start discarding the user's oldest finds the
        // moment they used the feature as intended. Two hundred rows of share links is a few
        // hundred kilobytes, which this store carries without noticing.
        try { localStorage.setItem(PROVEN_KEY, JSON.stringify((list || []).slice(0, 200))); }
        catch (e) { /* a full or blocked store is not worth an error here */ }
    }

    /**
     * Fastest first, and everything that stopped answering at the bottom.
     *
     * A dead row carries `delay: 0`, so a plain numeric sort would float it to the very top —
     * directly above the servers the user actually wants.
     */
    const byDelay = (a, b) => {
        const ad = a.dead || !(a.delay > 0), bd = b.dead || !(b.delay > 0);
        if (ad !== bd) return ad ? 1 : -1;
        return (a.delay || 0) - (b.delay || 0);
    };

    /** Persian digits. The rest of this file converts inline; this is the same conversion named. */
    const fa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

    /** The Persian name of a country code, from the catalogue the panel already holds. */
    function countryName(code) {
        if (!code || code === 'all') return 'همه';
        if (code === 'unknown') return 'بدون برچسب';
        const row = (state.catalog && state.catalog.countries || []).find((c) => c.code === code);
        return (row && row.name) || String(code).toUpperCase();
    }

    /**
     * A flag as a bundled SVG, not as an emoji.
     *
     * Windows ships no glyphs for regional-indicator pairs, so an emoji flag renders as the
     * two boxed letters — on the one screen whose whole point is showing flags. The app
     * already carries `public/assets/flags/{cc}.svg`, which covers every country in the
     * feed, so those are used instead.
     *
     * The code sits behind the image as text: if a future feed names a region we have no
     * file for, the <img> removes itself and the reader still sees «PT» rather than a hole.
     */
    function flagImg(code, w) {
        const h = Math.round(w * 0.72);
        if (!code) {
            return `<span class="qk-flag qk-flag-none" style="width:${w}px;height:${h}px;"></span>`;
        }
        const cc = String(code).toLowerCase();
        return `<span class="qk-flag" style="width:${w}px;height:${h}px;">${esc(code)}` +
               `<img src="/assets/flags/${esc(cc)}.svg" alt="" onerror="this.remove()"></span>`;
    }

    /** "everywhere" — drawn at the same size and shape as a flag chip so the row aligns. */
    function globeIcon(w) {
        const h = Math.round(w * 0.72);
        return `<span class="qk-flag" style="width:${w}px;height:${h}px;">` +
               `<i class="ph-bold ph-globe-hemisphere-west" style="font-size:${Math.round(h * 0.75)}px; color:var(--mv-label-2);"></i></span>`;
    }

    // ── state ───────────────────────────────────────────────────────────────────

    const MODES = {
        proxy: {
            id: 'proxy',
            title: 'پروکسی سیستم',
            icon: 'ph-browser',
            short: 'مرورگر و برنامه‌های سازگار',
            detail: 'سریع، بدون دسترسی مدیر. مرورگرها و برنامه‌هایی که پروکسی ویندوز را می‌خوانند از تونل رد می‌شوند؛ بقیه مستقیم می‌مانند و DNS هم از ISP پرسیده می‌شود.',
            step: 'روشن کردن پروکسی سیستم',
        },
        tunnel: {
            id: 'tunnel',
            title: 'تونل کامل',
            icon: 'ph-shield-check',
            short: 'تمام ترافیک سیستم',
            detail: 'همه‌ی برنامه‌ها، خود ویندوز و DNS از تونل رد می‌شوند — بدون نشت. به دسترسی مدیر نیاز دارد.',
            step: 'بالا آوردن تونل کامل',
        },
    };

    const STEP_IDS = ['list', 'find', 'engine', 'mode', 'verify'];

    const state = {
        catalog: null,
        country: 'all',
        proven: [],           // servers that answered a real request, fastest first (restored below)
        browse: [],           // the raw list for the chosen country (untested)
        browseTotal: 0,
        scan: null,           // { stage, tested, total, found, target }
        status: null,
        mode: 'proxy',
        connecting: false,
        disconnecting: false,
        modeBusy: null,       // 'proxy' | 'tunnel' while a switch is mid-flight
        steps: {},            // id -> { s:'pending'|'run'|'ok'|'fail'|'skip', note }
        fatal: null,
        egress: null,
        egressBusy: false,
        current: null,        // the node we connected to
        pickerOpen: false,
        pickerQuery: '',
        listBusy: false,
        // «چند سرور از چند کشور» — the same two controls the Android catalogue has. Defaults
        // match it: twenty is enough to pick from without a sweep that outlasts the user's
        // patience, and five countries is a real choice of exit rather than a token one.
        wantCount: 20,
        wantCountries: 5,
        moved: null,          // set when a measurement just re-filed the connected node
    };

    try {
        state.proven = loadProven();
        const saved = localStorage.getItem('quick-mode');
        if (saved === 'proxy' || saved === 'tunnel') state.mode = saved;
        const savedCountry = localStorage.getItem('quick-country');
        if (savedCountry) state.country = savedCountry;
    } catch (e) { /* private mode; defaults are fine */ }

    // ── the page ────────────────────────────────────────────────────────────────
    //
    // The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one every other
    // window wears: a sidebar of sections, a hero built around ONE button with the live
    // traffic beside it, and each of this window's three decisions — which path, which
    // country, which server — as a card of its own.
    //
    // The country picker used to be a sheet over the page. It is a section now: a list of
    // sixty countries is a list, and this app does not open modals for lists.

    const QK_SECTIONS = [
        { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
        { id: 'servers', label: 'سرورها', icon: 'ph-fill ph-hard-drives', tint: 'var(--mv-blue)' },
        { id: 'location', label: 'موقعیت', icon: 'ph-fill ph-globe-hemisphere-west', tint: 'var(--mv-indigo)' },
    ];

    let qkSec = 'connect';

    const HTML = `
<div id="qk-root" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های اتصال سریع">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="qk-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${QK_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-qk-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="qk-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="qk-pane-title">اتصال</h1>
      <div class="mv-eng-bar-action" id="qk-bar-actions" hidden>
        <button type="button" id="qk-scan-btn" class="mv-tb-btn" title="جست‌وجوی سرور" aria-label="جست‌وجوی سرور"><i class="ph-bold ph-magnifying-glass"></i></button>
        <button type="button" id="qk-refresh-btn" class="mv-tb-btn" title="دریافت دوباره‌ی فهرست از منبع" aria-label="دریافت دوباره‌ی فهرست"><i class="ph-bold ph-arrows-clockwise"></i></button>
      </div>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="qk-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="qk-stage" style="--tint:var(--mv-blue)"></div>
        <div class="mv-eng-flow" id="qk-flow" style="display:none"><div class="mv-steps" id="qk-steps"></div></div>
        <div class="mv-eng-grid" id="qk-cards"></div>
      </div>

      <div class="mv-eng-sec" data-sec="servers">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">سرورهای آزمایش‌شده</div>
            <div id="qk-sweep"></div>
            <div id="qk-scanbar"></div>
            <div class="mv-form-group" id="qk-servers"></div>
            <p class="mv-form-footer" id="qk-sources"></p>
          </div>
        </div>
      </div>

      <div class="mv-eng-sec" data-sec="location">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">از کدام کشور خارج شود</div>
            <div class="qk-picker-search">
              <label class="mv-side-search"><i class="ph-bold ph-magnifying-glass"></i>
                <input id="qk-picker-search" type="search" placeholder="جست‌وجوی کشور…" spellcheck="false" aria-label="جست‌وجوی کشور">
              </label>
            </div>
            <div id="qk-picker-list" class="mv-list"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="mv-eng-foot" id="qk-foot"></div>
  </section>
</div>

<style>
  #qk-root { position:relative; z-index:0; flex:1 1 auto; min-height:0; color:var(--mv-label); }

  /* The flag chip: a bundled SVG behind the country code (see flagImg). */
  #qk-root .qk-flag {
    position:relative; display:inline-flex; align-items:center; justify-content:center;
    border-radius:3px; overflow:hidden; flex-shrink:0; vertical-align:middle;
    background:var(--mv-fill); box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-sep-2);
    font-size:8px; font-weight:800; color:var(--mv-label-3); letter-spacing:.4px;
  }
  #qk-root .qk-flag img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
  #qk-root .qk-flag-none { background:repeating-linear-gradient(45deg, var(--mv-fill), var(--mv-fill) 3px, var(--mv-fill-2) 3px, var(--mv-fill-2) 4px); }

  #qk-root .qk-exit { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:12.5px; color:var(--mv-label); }
  #qk-root .qk-ip { direction:ltr; unicode-bidi:isolate; font-family:var(--mv-font-tech); color:var(--mv-label-2); }
  #qk-root .qk-ms { font-family:var(--mv-font-tech); font-variant-numeric:tabular-nums; }

  /* «چند سرور از چند کشور» — the two numbers and the button that acts on them. It sits above
     the list because it is the thing that FILLS the list, and on a fresh install the list is
     the empty half of the screen. */
  #qk-root .qk-sweep { padding:0 0 12px; }
  #qk-root .qk-sweep-row { display:flex; align-items:flex-end; gap:10px; flex-wrap:wrap; }
  #qk-root .qk-num { display:flex; flex-direction:column; gap:5px; font-size:11.5px; color:var(--mv-label-2); }
  #qk-root .qk-num input {
    width:92px; padding:7px 10px; border-radius:9px; text-align:center;
    border:1px solid var(--mv-separator); background:var(--mv-fill); color:var(--mv-label);
    font-family:var(--mv-font-tech); font-variant-numeric:tabular-nums; font-size:14px;
  }
  #qk-root .qk-num input:focus { outline:none; border-color:var(--mv-blue); }
  #qk-root .qk-num input:disabled { opacity:.5; }
  /* The spinners are noise at this size and the field is three characters wide. */
  #qk-root .qk-num input::-webkit-outer-spin-button,
  #qk-root .qk-num input::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
  #qk-root .qk-sweep-note { margin:9px 0 0; font-size:11.5px; line-height:1.8; color:var(--mv-label-3); }

  /* A server that failed its last re-test: kept, dimmed, and removable — never silently gone. */
  #qk-root .mv-li.qk-dead { opacity:.62; }
  #qk-root .qk-dead-note { font-size:11px; color:var(--mv-label-3); white-space:nowrap; }
  /* The per-row remove. Faint until the row is hovered, so a list of twenty is not a wall of Xs. */
  #qk-root .qk-row-del {
    flex:0 0 auto; width:24px; height:24px; margin-inline-start:6px;
    display:grid; place-items:center; border:0; border-radius:50%;
    background:transparent; color:var(--mv-label-3); cursor:pointer; opacity:0; transition:opacity .12s;
  }
  #qk-root .mv-li:hover .qk-row-del, #qk-root .qk-row-del:focus-visible { opacity:1; }
  #qk-root .qk-row-del:hover { background:var(--mv-fill); color:var(--mv-red-ink, #ff453a); }
  #qk-root .mv-li.qk-dead .qk-row-del { opacity:.8; }

  /* The country list uses the width the window has — sixty rows in one narrow column is
     the shape a phone sheet had to take, not the one a window does. */
  #qk-root .qk-picker-search { padding:0 0 10px; }
  #qk-root .qk-picker-search .mv-side-search { width:100%; margin:0; }
  #qk-root #qk-picker-list { display:grid; gap:2px; grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); }
  #qk-root #qk-picker-list .mv-li { border-radius:var(--mv-r-sm, 8px); cursor:pointer; }
  #qk-root #qk-picker-list .mv-li + .mv-li::before { content:none; }
  #qk-root #qk-picker-list .mv-li:hover { background:var(--mv-fill); }

  @keyframes qk-pulse { 0%,100% { opacity:.35; } 50% { opacity:1; } }
  #qk-root .qk-pulse { animation:qk-pulse 1.4s ease-in-out infinite; }
  html[data-motion="reduced"] #qk-root .qk-pulse { animation:none; }
</style>`;

    // ── data ────────────────────────────────────────────────────────────────────

    async function api(path, opts) {
        const r = await fetch(path, opts);
        let body = null;
        try { body = await r.json(); } catch (e) { body = {}; }
        if (!r.ok && !body.error) body.error = `پاسخ ${r.status}`;
        return body;
    }

    const post = (path, data) => api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data || {}),
    });

    async function loadCatalog(force) {
        state.listBusy = true;
        renderServers();
        renderCountry();
        const r = await api('/api/quick/catalog' + (force ? '?force=1' : ''));
        state.listBusy = false;
        if (r.error && !r.total) { state.catalog = null; state.fatal = r.error; }
        else { state.catalog = r; state.fatal = null; }
        renderCountry();
        renderSources();
        return state.catalog;
    }

    async function loadBrowse() {
        const r = await api(`/api/quick/nodes?country=${encodeURIComponent(state.country)}&limit=200`);
        state.browse = r.nodes || [];
        state.browseTotal = r.total || 0;
        renderServers();
    }

    async function refreshStatus() {
        const r = await api('/api/quick/status');
        if (r && r.ok) state.status = r;
        return state.status;
    }

    async function refreshEgress() {
        if (!state.status || !state.status.engine) { state.egress = null; return null; }
        state.egressBusy = true;
        renderHero();
        // Naming the node lets the server file the measured country against it for good.
        const q = state.current ? `?node=${encodeURIComponent(state.current.id)}` : '';
        const r = await api('/api/quick/egress' + q);
        state.egressBusy = false;
        state.egress = r && r.ok ? r : null;

        // The node just changed country. Say so — the list is about to show it somewhere
        // else, and a row moving on its own with no explanation is worse than the error it
        // corrects.
        if (r && r.moved && r.country && state.current) {
            const was = r.previousCountry || state.current.countryName || state.current.country;
            applyMoved(state.current.id, r.country);
            state.moved = { name: state.current.name, from: was, to: r.country.name };
            if (typeof toast === 'function') {
                toast(`این سرور واقعاً در ${r.country.name} است — به همان دسته منتقل شد`, 4200);
            }
            loadCatalog(false).then(() => { renderCountry(); renderSources(); });
        }

        renderHero();
        renderServers();
        return state.egress;
    }

    /** Move a node in the lists this panel is holding, so the correction is visible at once. */
    function applyMoved(id, country) {
        for (const list of [state.proven, state.browse]) {
            for (const n of list) {
                if (n.id !== id) continue;
                n.country = country.code;
                n.countryName = country.name;
                n.flag = country.flag;
                n.verified = true;
            }
        }
        if (state.current && state.current.id === id) {
            state.current.country = country.code;
            state.current.countryName = country.name;
            state.current.verified = true;
        }
    }

    // ── connection state ────────────────────────────────────────────────────────

    /** Connected means the engine is up AND a path is actually carrying traffic. */
    function isOn() {
        const s = state.status;
        return !!(s && s.engine && (s.systemProxy || s.tunnel));
    }

    // Read-only, for the shell's "engine is up" lamp on the dock and home icons
    // (public/shell/apps.js). Connected through THIS panel, not just "Xray is up".
    window.MVProbe = window.MVProbe || {};
    window.MVProbe.quick = function () { return isOn() && !!state.current; };
    // …and what the desktop's connection widget shows about it: the path in use and the
    // exit country, only once it has been measured from inside the tunnel.
    window.MVProbe.quickInfo = function () {
        const e = state.egress;
        return {
            mode: activeMode(),
            country: e && e.ok && e.countryTrusted && e.loc ? String(e.loc).toUpperCase() : null,
        };
    };

    function activeMode() {
        const s = state.status;
        if (!s) return null;
        if (s.tunnel) return 'tunnel';
        if (s.systemProxy) return 'proxy';
        return null;
    }

    // ── steps ───────────────────────────────────────────────────────────────────

    function resetSteps() {
        state.steps = {};
        STEP_IDS.forEach(id => { state.steps[id] = { s: 'pending', note: '' }; });
    }

    function setStep(id, s, note) {
        state.steps[id] = { s, note: note || '' };
        renderAction();
    }

    function stepLabel(id) {
        if (id === 'list') return 'آماده‌سازی فهرست سرورها';
        if (id === 'find') return 'یافتن سریع‌ترین سرور سالم';
        if (id === 'engine') return 'اتصال موتور به سرور';
        if (id === 'mode') return MODES[state.mode].step;
        if (id === 'verify') return 'بررسی مسیر خروج';
        return id;
    }

    // ── the one button ──────────────────────────────────────────────────────────

    /**
     * Everything between "nothing is running" and "verified connection".
     *
     * The steps are sequential because each genuinely depends on the last: there is no
     * engine to point the proxy at until a node is chosen, and nothing to verify until the
     * path is up. A failure stops the run and says which step failed and why — a half-open
     * state is never left behind silently.
     */
    async function connect() {
        if (state.connecting || state.disconnecting) return;
        state.connecting = true;
        state.fatal = null;
        state.egress = null;
        state.moved = null;
        resetSteps();
        renderAll();

        try {
            await ensureScanStopped();
            // 1 — the list
            setStep('list', 'run');
            if (!state.catalog) await loadCatalog(false);
            if (!state.catalog || !state.catalog.total) {
                setStep('list', 'fail', state.fatal || 'فهرست سرورها خالی است.');
                throw new Error('SILENT');
            }
            const where = state.country === 'all'
                ? `${state.catalog.total} سرور`
                : `${(state.catalog.countries.find(c => c.code === state.country) || {}).count || 0} سرور`;
            setStep('list', 'ok', where);

            // 2 — a server that actually answers
            //
            // `find` and not `[0]`: since the list keeps rows that failed their last re-test
            // (marked, so the user can see and remove them), the first row is not necessarily a
            // live one — and the big button reconnecting to a server known to be down is the
            // worst possible reading of "quick connect".
            let node = state.proven.find((n) => !n.dead && n.delay > 0) || null;
            if (node && !nodeMatchesCountry(node)) node = null;
            if (node) {
                setStep('find', 'skip', `از جست‌وجوی قبلی — ${node.countryName || node.name} · ${node.delay} میلی‌ثانیه`);
            } else {
                setStep('find', 'run');
                // Settings › تنظیمات پیشرفته VPN › «تعداد سرور اتصال سریع»: how many healthy
                // servers are compared before the fastest is taken (Android's quick_tile_count).
                const found = await runScan(quickServerCount());
                if (!found.length) {
                    setStep('find', 'fail', 'هیچ سروری پاسخ نداد. کشور دیگری را امتحان کنید.');
                    throw new Error('SILENT');
                }
                node = found[0];
                setStep('find', 'ok', `${found.length} سرور سالم — بهترین ${node.delay} میلی‌ثانیه`);
            }

            // 3 — the engine
            setStep('engine', 'run');
            const started = await post('/api/v2ray/start', { uri: node.uri, useSystemProxy: false, solo: true });
            if (started.error) { setStep('engine', 'fail', started.error); throw new Error('SILENT'); }
            state.current = node;
            setStep('engine', 'ok', `${node.countryName ? node.countryName + ' · ' : ''}${node.name}`);

            // 4 — the path
            setStep('mode', 'run');
            const applied = await applyMode(state.mode);
            if (!applied.ok) { setStep('mode', 'fail', applied.error); throw new Error('SILENT'); }
            setStep('mode', 'ok');

            // 5 — proof
            setStep('verify', 'run');
            const eg = await refreshEgress();
            if (!eg) setStep('verify', 'fail', 'مسیر خروج خوانده نشد — اتصال برقرار است ولی تأیید نشد.');
            else if (!eg.countryTrusted) setStep('verify', 'ok', `خروج تأیید شد — ${eg.ip || ''}`);
            else setStep('verify', 'ok', `${eg.country ? eg.country.name : eg.loc} — ${eg.ip || ''}`);

            if (typeof toast === 'function') toast('✅ متصل شدید');
        } catch (err) {
            if (err.message !== 'SILENT') {
                state.fatal = err.message;
                const running = STEP_IDS.find(id => state.steps[id] && state.steps[id].s === 'run');
                if (running) setStep(running, 'fail', err.message);
            }
        } finally {
            state.connecting = false;
            await refreshStatus();
            renderAll();
        }
    }

    /** Undo everything, path first — see the ordering note in /api/v2ray/stop. */
    async function disconnect() {
        if (state.connecting || state.disconnecting) return;
        state.disconnecting = true;
        renderAll();
        try {
            await ensureScanStopped();
            const s = state.status || {};
            if (s.tunnel || s.tunnelWanted) await post('/api/v2ray/tun', { enabled: false });
            if (s.systemProxy) await post('/api/v2ray/sysproxy', { enable: false });
            await post('/api/v2ray/stop', {});
            state.egress = null;
            state.current = null;
            state.moved = null;
            state.steps = {};
            if (typeof toast === 'function') toast('اتصال قطع شد');
        } catch (e) {
            state.fatal = e.message;
        } finally {
            state.disconnecting = false;
            await refreshStatus();
            renderAll();
        }
    }

    /**
     * Put exactly one path in charge.
     *
     * The proxy and the tunnel are alternatives, never layers — with both on, a browser
     * sends traffic to the engine whose own replies are then captured by the adapter and fed
     * back in. The server enforces this too, but doing it here as well means the UI never
     * shows both as lit even for the moment in between.
     */
    /**
     * Wait for the engine's SOCKS port to be listening.
     *
     * /api/v2ray/start resolves when the process has been spawned, but the inbound is bound
     * a moment later — and /api/v2ray/tun refuses outright when that port is empty, because
     * pointing the default route at a dead proxy takes the machine offline with no way back.
     * Without this wait, connecting in tunnel mode failed with «موتور Xray اجرا نیست» over an
     * engine that was, in fact, still binding.
     */
    async function waitForEngine(timeoutMs = 10000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await refreshStatus();
            if (state.status && state.status.engine) return true;
            await new Promise(r => setTimeout(r, 250));
        }
        return false;
    }

    async function applyMode(mode) {
        if (!(await waitForEngine())) {
            return { ok: false, error: 'موتور بالا نیامد — یک‌بار دیگر امتحان کنید.' };
        }
        if (mode === 'tunnel') {
            const off = await post('/api/v2ray/sysproxy', { enable: false });
            if (off.error && !/اجرا نیست/.test(off.error)) return { ok: false, error: off.error };
            // `source` so the tunnel takes «اتصال سریع»'s own MTU (Settings › MTU).
            const on = await post('/api/v2ray/tun', { enabled: true, source: 'quick' });
            if (on.error) return { ok: false, error: on.error };
        } else {
            const off = await post('/api/v2ray/tun', { enabled: false });
            if (off.error) return { ok: false, error: off.error };
            const on = await post('/api/v2ray/sysproxy', { enable: true });
            if (on.error) return { ok: false, error: on.error };
        }

        // Read the state back rather than trusting the 200. This is the check that keeps a
        // failed elevation prompt from being drawn as a live tunnel.
        await refreshStatus();
        const now = activeMode();
        if (now !== mode) {
            return {
                ok: false,
                error: mode === 'tunnel'
                    ? 'تونل بالا نیامد — معمولاً یعنی دسترسی مدیر داده نشد.'
                    : 'پروکسی سیستم روشن نشد.',
            };
        }
        return { ok: true };
    }

    /** Switching path while already connected: no disconnect, no re-scan. */
    async function switchMode(mode) {
        if (state.modeBusy || state.connecting || state.disconnecting) return;
        if (mode === state.mode && (!isOn() || activeMode() === mode)) return;

        const previous = state.mode;
        state.mode = mode;
        try { localStorage.setItem('quick-mode', mode); } catch (e) {}

        if (!isOn()) { renderAll(); return; }   // nothing running yet — remember it for later

        state.modeBusy = mode;
        renderAll();
        const r = await applyMode(mode);
        state.modeBusy = null;
        if (!r.ok) {
            state.mode = previous;
            try { localStorage.setItem('quick-mode', previous); } catch (e) {}
            await applyMode(previous).catch(() => {});
            if (typeof uiAlert === 'function') uiAlert(r.error, 'مسیر عوض نشد');
            else if (typeof toast === 'function') toast(r.error);
        } else {
            await refreshEgress();
        }
        await refreshStatus();
        qkGoSec('connect');
    }

    // ── scanning ────────────────────────────────────────────────────────────────

    let scanResolve = null;

    function nodeMatchesCountry(node) {
        if (state.country === 'all') return true;
        if (state.country === 'unknown') return !node.country;
        return node.country === state.country;
    }

    /** Settings › «تعداد سرور اتصال سریع» — 1 to 200; six (the one button's old fixed number) when unset. */
    function quickServerCount() {
        let n = NaN;
        try { n = parseInt(PersistentStorage.getItem('quick-server-count'), 10); } catch (e) { /* unset */ }
        return n >= 1 && n <= 200 ? n : 6;
    }

    /** Start a run and resolve with its results when the server says it is done. */
    /**
     * @param want       how many working servers to stop at
     * @param countries  spread them over this many countries; 0 keeps the chosen country only
     */
    function runScan(want, countries = 0) {
        return new Promise(async (resolve) => {
            // The list is NOT cleared here. Searching again adds to what the user already has —
            // see the note in handleQuickEvent. `found` in the progress bar counts this run;
            // the list counts everything.
            state.scan = { stage: 'tcp', tested: 0, total: 0, found: 0, target: want, open: 0, countries };
            renderServers();
            renderAction();

            const r = await post('/api/quick/scan', { country: state.country, want, countries });
            if (r.error) {
                state.scan = null;
                renderServers();
                return resolve([]);
            }
            scanResolve = resolve;
        });
    }

    async function stopScan() {
        await post('/api/quick/scan/stop', {});
    }

    /**
     * Never connect while a sweep is in flight.
     *
     * The delay tester runs xray.exe of its own, and starting the real engine begins with
     * `taskkill /F /IM xray.exe` — which kills the tester too. The sweep does not notice: it
     * keeps probing ports that no longer exist and reports every remaining node as dead. So the
     * sweep is stopped and waited for first, and only then does anything touch the engine.
     */
    async function ensureScanStopped() {
        if (!state.scan) return;
        await stopScan();
        const deadline = Date.now() + 8000;
        while (state.scan && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 150));
        }
        state.scan = null;
        renderScanBar();
    }

    /**
     * Take servers off the list — one row, or every row that stopped answering.
     *
     * The list is the user's now: it grows across searches and survives restarts, so removing
     * from it is a thing they have to be able to do rather than something the app decides on
     * their behalf while they watch.
     */
    function dropServers(ids) {
        const set = new Set(ids || []);
        if (!set.size) return;
        state.proven = state.proven.filter((n) => !set.has(n.id));
        saveProven(state.proven);
        renderServers();
        renderAction();
    }

    /** Server-streamed progress. Registered on window for the shared socket dispatcher. */
    window.handleQuickEvent = function (ev) {
        if (!ev || !ev.type) return;

        if (ev.type === 'stage' || ev.type === 'progress') {
            // THE LIST GROWS. A sweep used to clear it first, so searching again threw away
            // everything the previous searches had proven — and since each run stops at its
            // target, the list could never get bigger than one run's worth however many times
            // the user pressed the button.
            //
            // Now a run adds to what is there, matched by id so the same server found twice is
            // one row with the newer number. The counter in the progress bar still belongs to
            // THIS run (`found`), which is why it is kept apart from the list's own length.
            state.scan = Object.assign(state.scan || {}, ev);
            renderScanBar();
            renderServers();
            renderAction();
            return;
        }
        if (ev.type === 'found') {
            // Re-found servers replace their old row: a fresher measurement of the same
            // endpoint is the same server, not a second one, and `dead` is lifted because it
            // just answered.
            const at = state.proven.findIndex((n) => n.id === ev.node.id);
            if (at >= 0) state.proven[at] = Object.assign({}, state.proven[at], ev.node, { dead: false });
            else state.proven.push(Object.assign({ dead: false }, ev.node));
            state.proven.sort(byDelay);
            saveProven(state.proven);
            state.scan = Object.assign(state.scan || {}, { found: ev.found, target: ev.target });
            renderServers();
            renderAction();
            return;
        }
        if (ev.type === 'retested') {
            const i = state.proven.findIndex((n) => n.id === ev.node.id);
            // MARKED, NOT DROPPED. An earlier version spliced a server out the moment it failed
            // one re-test, which is a decision the user did not make: a node can be down for a
            // minute, and having it vanish mid-sweep leaves them watching their own list shrink
            // with no way to tell a dead server from one that was never there. It is flagged
            // instead, shown as «جواب نداد», and removed only when they ask.
            if (i >= 0) {
                state.proven[i] = Object.assign({}, state.proven[i], ev.node, { dead: ev.node.delay <= 0 });
            }
            state.proven.sort(byDelay);
            saveProven(state.proven);
            state.scan = Object.assign(state.scan || {}, { tested: ev.tested, total: ev.total });
            renderServers();
            return;
        }
        if (ev.type === 'done' || ev.type === 'error') {
            // A re-test has already written every row it touched; taking its `results` here
            // would throw away the servers it did not re-measure.
            // Never `ev.results`: that is only what THIS run proved, and taking it would wipe
            // every server the list already had — the exact behaviour being removed here.
            const results = state.proven.slice().sort(byDelay);
            state.proven = results;
            saveProven(state.proven);
            state.scan = null;
            if (ev.type === 'error' && typeof toast === 'function') toast(ev.message || 'جست‌وجو شکست خورد');
            // The bar is its own element; without this it kept showing the last progress
            // line — a stopped sweep still looked like a running one until something else
            // happened to repaint.
            renderScanBar();
            renderServers();
            renderAction();
            const done = scanResolve;
            scanResolve = null;
            if (done) done(results);
        }
    };

    // ── connecting to one chosen server ─────────────────────────────────────────

    async function connectTo(node) {
        if (state.connecting || state.disconnecting) return;
        state.connecting = true;
        state.fatal = null;
        state.moved = null;
        resetSteps();
        state.steps.list = { s: 'skip', note: 'انتخاب دستی' };
        state.steps.find = { s: 'skip', note: `${node.countryName ? node.countryName + ' · ' : ''}${node.name}` };
        renderAll();
        try {
            await ensureScanStopped();
            setStep('engine', 'run');
            const started = await post('/api/v2ray/start', { uri: node.uri, useSystemProxy: false, solo: true });
            if (started.error) { setStep('engine', 'fail', started.error); return; }
            state.current = node;
            setStep('engine', 'ok', `${node.countryName ? node.countryName + ' · ' : ''}${node.name}`);

            setStep('mode', 'run');
            const applied = await applyMode(state.mode);
            if (!applied.ok) { setStep('mode', 'fail', applied.error); return; }
            setStep('mode', 'ok');

            setStep('verify', 'run');
            const eg = await refreshEgress();
            if (!eg) setStep('verify', 'fail', 'مسیر خروج خوانده نشد.');
            else setStep('verify', 'ok', `${eg.countryTrusted && eg.country ? eg.country.name + ' — ' : ''}${eg.ip || ''}`);
        } finally {
            state.connecting = false;
            await refreshStatus();
            renderAll();
        }
    }

    // ── rendering ───────────────────────────────────────────────────────────────

    function renderAll() {
        renderIdent();
        renderFoot();
        if (qkSec === 'connect') { renderStage(); renderFlow(); renderCards(); }
        renderScanBar();
        renderServers();
        if (qkSec === 'location') renderPicker();
        qkWire();
    }

    /* The three names the rest of this file already calls. The hero owns all of them now:
       the status head, the run's steps and the country row were three separate blocks, and
       they are one page. Keeping the names means every call site stays honest. */
    function renderHero() { renderIdent(); renderStage(); renderFoot(); }
    function renderAction() {
        renderFlow(); renderFoot();
        if (qkSec === 'connect') { renderStage(); renderCards(); }
        qkWire();
    }
    function renderCountry() { if (qkSec === 'connect') { renderCards(); qkWire(); } }

    function qkDot(tone) {
        return `<i class="mv-eng-dot${tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : ''}"></i>`;
    }

    /** What the hero says and what its button does — the one place that decides. */
    function qkView() {
        const on = isOn();
        const busy = state.connecting || state.disconnecting || !!state.modeBusy;
        if (busy) {
            return { tone: 'busy', act: '', on,
                head: state.disconnecting ? 'در حال قطع' : 'در حال اتصال',
                line: state.disconnecting ? 'چند لحظه…' : 'خط بالای کارت‌ها می‌گوید کجای کار است.' };
        }
        if (on) {
            const m = MODES[activeMode() || state.mode];
            // The exit is a MEASUREMENT, not the server's own claim — they are different
            // things and the page says which one it is showing.
            let where = '';
            const eg = state.egress;
            if (state.egressBusy) where = '<span class="qk-pulse">در حال بررسی مسیر خروج…</span>';
            else if (eg && eg.countryTrusted && eg.country) {
                where = `خروج اندازه‌گیری‌شده: <b>${esc(eg.country.name)}</b> <span class="qk-ip">${esc(eg.ip || '')}</span>`;
            } else if (eg && !eg.countryTrusted) {
                where = `خروج از شبکهٔ کلادفلر <span class="qk-ip">${esc(eg.ip || '')}</span>`;
            } else if (eg) where = 'مسیر خروج تأیید نشد.';
            return { tone: 'on', act: 'off', on,
                head: 'متصل',
                line: `${esc(m.title)} — ${esc(m.short)}. ${where}` };
        }
        return { tone: 'off', act: 'on', on,
            head: 'آمادهٔ اتصال',
            line: 'یک ضربه: سرور را خودش پیدا می‌کند، وصل می‌شود و بعد مسیر خروج را اندازه می‌گیرد. هیچ‌چیز «متصل» گفته نمی‌شود تا وقتی خودِ سرویس تأییدش کند.' };
    }

    function renderIdent() {
        const host = $q('qk-ident');
        if (!host) return;
        const v = qkView();
        const word = v.tone === 'on' ? 'متصل' : v.tone === 'busy' ? 'در حال کار' : 'قطع';
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('quick');
        const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
            : '<span class="mv-side-tile" style="--tint:var(--mv-blue)"><svg aria-hidden="true"><use href="#g-rocket"/></svg></span>';
        host.innerHTML = `${icon}
      <b>اتصال سریع</b>
      <small>${qkDot(v.tone)}${word}</small>`;
    }

    /** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
    function renderStage() {
        const host = $q('qk-stage');
        if (!host) return;
        const v = qkView();

        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-qk-act="power" data-part="power">
          <i data-part="glyph"></i>
        </button>
      </div>
      <div class="mv-eng-stage-side">
        <div class="mv-eng-live" data-part="live"></div>
      </div>`;
            host.dataset.built = '1';
        }

        const q = (n) => host.querySelector(`[data-part="${n}"]`);
        q('head').innerHTML = v.head;
        q('line').innerHTML = v.line;

        const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : '';
        const btn = q('power');
        const want = 'mv-eng-power' + ring;
        if (btn.className !== want) btn.className = want;
        btn.disabled = !v.act;
        const aria = v.act === 'off' ? 'قطع اتصال' : 'اتصال سریع';
        btn.setAttribute('aria-label', aria);
        btn.title = aria;
        const glyph = v.tone === 'busy' ? 'mv-spin-ring' : (v.on ? 'ph-fill ph-power' : 'ph-bold ph-power');
        const gl = q('glyph');
        if (gl.className !== glyph) gl.className = glyph;

        const el = q('live');
        if (el && window.MVEngineLive) MVEngineLive.mount(el);
    }

    /** The five steps of one connect, as one line — on screen only while a run has begun. */
    function renderFlow() {
        const wrap = $q('qk-flow');
        const host = $q('qk-steps');
        if (!wrap || !host) return;
        const anyStep = STEP_IDS.some((id) => state.steps[id] && state.steps[id].s !== 'pending');
        wrap.style.display = anyStep ? 'flex' : 'none';
        if (!anyStep) return;

        host.innerHTML = STEP_IDS.map((id, i) => {
            const st = state.steps[id] || { s: 'pending', note: '' };
            let cls = 'pending', mark = String(i + 1).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
            if (st.s === 'ok' || st.s === 'skip') { cls = 'done'; mark = '✓'; }
            else if (st.s === 'fail') { cls = 'failed'; mark = '✕'; }
            else if (st.s === 'run') { cls = 'active'; mark = '●'; }

            // While the search is running, the step carries its own count — that is the one
            // number that says the wait is going somewhere.
            let note = st.note;
            if (id === 'find' && st.s === 'run' && state.scan) {
                const sc = state.scan;
                note = sc.stage === 'tcp'
                    ? `پینگ ${sc.tested || 0}/${sc.total || 0}`
                    : `تأخیر — ${sc.found || 0} سالم`;
            }
            return `<span class="mv-step is-${cls}"><i>${mark}</i>${esc(stepLabel(id))}${note ? ' — ' + esc(note) : ''}</span>`;
        }).join('');
    }

    /** The three decisions this window has, each one a card. */
    function renderCards() {
        const host = $q('qk-cards');
        if (!host) return;
        const on = isOn();
        const live = activeMode();
        const locked = state.connecting || state.disconnecting;
        const server = state.current;
        const eg = state.egress;

        const c = state.catalog;
        let cFlag, cName, cSub;
        if (state.country === 'all') {
            cFlag = globeIcon(22); cName = 'خودکار — سریع‌ترین';
            cSub = state.listBusy ? 'در حال دریافت فهرست…'
                : c ? `${c.total} سرور در ${c.countries.length} کشور` : 'فهرست هنوز دریافت نشده';
        } else if (state.country === 'unknown') {
            cFlag = flagImg(null, 22); cName = 'بدون کشور مشخص'; cSub = c ? `${c.unknown} سرور` : '';
        } else {
            const row = c && c.countries.find((x) => x.code === state.country);
            cFlag = row ? flagImg(row.code, 22) : globeIcon(22);
            cName = row ? row.name : state.country;
            cSub = row ? `${row.count} سرور` : 'در فهرست فعلی نیست';
        }

        const modeDetail = (() => {
            const m = MODES[state.mode];
            const blocked = m.id === 'tunnel' && state.status && !state.status.tunnelReady;
            return blocked
                ? `<b style="color:var(--mv-orange-ink)">${esc(state.status.tunnelReason || 'تونل کامل روی این سیستم آماده نیست.')}</b>`
                : esc(m.detail) + (on ? ' می‌توانید بدون قطع‌شدن عوضش کنید.' : '');
        })();

        host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-green)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-arrows-split"></i></span>
          <h3>مسیر ترافیک</h3>
          <span class="mv-eng-card2-end">${esc(MODES[state.mode].title)}</span>
        </div>
        <div class="mv-eng-card2-body" role="radiogroup" aria-label="مسیر ترافیک">
          ${Object.values(MODES).map((m) => {
            const selected = state.mode === m.id;
            const running = live === m.id;
            const busy = state.modeBusy === m.id;
            const disabled = locked || !!state.modeBusy || (m.id === 'tunnel' && state.status && !state.status.tunnelReady);
            return `
          <button type="button" class="mv-eng-pick${selected ? ' is-on' : ''}${running ? ' is-live' : ''}"
                  data-qk-mode="${m.id}" role="radio" aria-checked="${selected}" ${disabled ? 'disabled' : ''}>
            <i class="${busy ? 'mv-spin-ring' : selected ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>
            <span class="mv-eng-pick-text"><b>${esc(m.title)}</b><small>${running ? 'در حال حمل ترافیک — ' : ''}${esc(m.short)}</small></span>
          </button>`;
        }).join('')}
        </div>
        <div class="mv-eng-card2-foot">${modeDetail}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <button type="button" class="mv-eng-card2-head" data-qk-go="location">
          <span class="mv-eng-glyph"><i class="ph-fill ph-globe-hemisphere-west"></i></span>
          <h3>موقعیت</h3>
          <span class="mv-eng-card2-end">${esc(cName)}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          <div class="mv-eng-pick" aria-disabled="true">
            <span style="flex:none;margin-top:1px">${cFlag}</span>
            <span class="mv-eng-pick-text"><b>${esc(cName)}</b><small>${cSub}</small></span>
          </div>
        </div>
        <div class="mv-eng-card2-foot">این انتخاب می‌گوید از کدام کشور دنبال سرور بگردد. کشوری که سرور خودش ادعا می‌کند با کشوری که بعد از اتصال اندازه گرفته می‌شود یکی نیست — دومی در سربرگ نوشته می‌شود.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-qk-go="servers">
            <span class="mv-eng-glyph"><i class="ph-fill ph-hard-drives"></i></span>
            <h3>سرور</h3>
            <span class="mv-eng-card2-end">${state.proven.length ? state.proven.length.toLocaleString('fa-IR') + ' آزمایش‌شده' : '—'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-qk-act="scan"
                  title="جست‌وجوی سرور" aria-label="جست‌وجوی سرور"
                  ${state.scan || locked ? 'disabled' : ''}>
            <i class="${state.scan ? 'mv-spin-ring' : 'ph-bold ph-magnifying-glass'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${on && server ? `
          <div class="mv-eng-pick is-on is-live" aria-disabled="true">
            <i class="ph-fill ph-check-circle"></i>
            <span class="mv-eng-pick-text"><b>${esc(server.name)}</b><small>${server.delay ? `تأخیر <span class="qk-ms">${server.delay}</span>ms` : 'در حال حمل ترافیک'}</small></span>
          </div>`
            : state.proven.length ? state.proven.slice(0, 3).map((n, i) => `
          <button type="button" class="mv-eng-pick" data-qk-connect="${esc(n.id)}" ${locked ? 'disabled' : ''}>
            <i class="ph-bold ph-circle"></i>
            <span class="mv-eng-pick-text"><b>${esc(n.name)}</b><small>تأخیر <span class="qk-ms">${n.delay}</span>ms${i === 0 ? ' · سریع‌ترین' : ''}</small></span>
          </button>`).join('')
                : '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز سروری آزمایش نشده — دکمهٔ بالا خودش این کار را می‌کند.</div>'}
        </div>
        <div class="mv-eng-card2-foot">فقط سرورهایی فهرست می‌شوند که یک درخواست واقعی از داخلشان رد شده؛ عدد، تأخیر همان درخواست است.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-pink, #FF2D55)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-map-pin"></i></span>
          <h3>مسیر خروج</h3>
          <span class="mv-eng-card2-end">${on ? (eg && eg.countryTrusted && eg.country ? esc(eg.country.name) : eg ? 'اندازه‌گیری‌نشده' : '…') : 'قطع'}</span>
        </div>
        <div class="mv-eng-card2-body">
          ${!on ? '<div class="mv-eng-card2-foot" style="padding-top:6px">تا وصل نشوید، ترافیک مستقیم از خط خودتان می‌رود.</div>'
            : state.egressBusy ? '<div class="mv-eng-card2-foot qk-pulse" style="padding-top:6px">در حال بررسی مسیر خروج…</div>'
                : eg && eg.countryTrusted && eg.country ? `
          <div class="mv-eng-pick is-live" aria-disabled="true">
            <span style="flex:none;margin-top:1px">${flagImg(eg.country.code, 22)}</span>
            <span class="mv-eng-pick-text"><b>${esc(eg.country.name)}</b><small class="qk-ip">${esc(eg.ip || '')}</small></span>
          </div>`
                    : eg ? `<div class="mv-eng-card2-foot" style="padding-top:6px">خروج از شبکهٔ کلادفلر — <span class="qk-ip">${esc(eg.ip || '')}</span>. کشور این آی‌پی چیزی دربارهٔ محل خروج نمی‌گوید.</div>`
                        : '<div class="mv-eng-card2-foot" style="padding-top:6px">مسیر خروج تأیید نشد.</div>'}
          ${state.moved ? `<div class="mv-eng-card2-foot" style="color:var(--mv-orange-ink)">این سرور خودش را «${esc(state.moved.from)}» معرفی کرده بود، ولی خروجش ${esc(state.moved.to)} است — از این پس در همان دسته فهرست می‌شود.</div>` : ''}
        </div>
        <div class="mv-eng-card2-foot">این یک اندازه‌گیری از داخل تونل است، نه ادعای سرور — برای همین ممکن است با کشور کارت بالا فرق کند.</div>
      </div>`;
    }

    function renderFoot() {
        const host = $q('qk-foot');
        if (!host) return;
        const v = qkView();
        const server = state.current;
        const word = v.tone === 'on' ? 'متصل' : v.tone === 'busy' ? (state.disconnecting ? 'در حال قطع' : 'در حال اتصال') : 'قطع';
        const end = v.on ? esc(MODES[activeMode() || state.mode].title) : 'ترافیک مستقیم';
        host.innerHTML = `
      ${qkDot(v.tone)}
      <span>${word}${v.on && server ? ' — ' + esc(server.name) : ''}</span>
      <span class="mv-eng-foot-end">${v.on && server && server.delay ? `<code dir="ltr">${server.delay}ms</code>` : ''}<span>${end}</span></span>`;
    }

    function qkGoSec(id) {
        const wrap = $q('qk-root');
        if (!wrap) return;
        qkSec = QK_SECTIONS.some((x) => x.id === id) ? id : 'connect';
        wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === qkSec));
        wrap.querySelectorAll('.mv-side-item[data-qk-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-qk-sec') === qkSec));
        const found = QK_SECTIONS.find((x) => x.id === qkSec);
        const title = $q('qk-pane-title');
        if (title) title.textContent = found ? found.label : '';
        const back = $q('qk-back');
        if (back) back.disabled = qkSec === 'connect';
        const acts = $q('qk-bar-actions');
        if (acts) acts.hidden = qkSec !== 'servers';
        const pane = wrap.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', qkSec === 'connect');
        const sc = $q('qk-scroll');
        if (sc) sc.scrollTop = 0;

        // The country list is a megabyte over a filtered line; fetch it when it is asked for.
        if (qkSec === 'location' && !state.catalog && !state.listBusy) loadCatalog(false).then(renderAll);
        renderAll();
    }

    function renderScanBar() {
        const el = $q('qk-scanbar');
        if (!el) return;
        const sc = state.scan;
        if (!sc) { el.innerHTML = ''; return; }

        const pct = sc.total ? Math.min(100, Math.round((sc.tested || 0) / sc.total * 100)) : 0;
        // THE TWO STAGES ARE NAMED, in the order they run. «بررسی اولیه» and «آزمایش واقعی»
        // described them accurately and said nothing about what they do — so a user watching a
        // sweep could not tell that the second stage only ever sees servers the first one
        // proved reachable, which is exactly the question they asked about it.
        const label = sc.stage === 'tcp'
            ? `۱ · پینگ TCP — ${sc.open || 0} سرور از ${sc.tested || 0} جواب دادند`
            : `۲ · تست تأخیر روی همان‌ها — ${sc.found || 0} سالم از ${sc.tested || 0}`;

        el.innerHTML = `
      <div class="mv-form-group" style="margin-bottom:8px;">
        <div class="mv-form-row">
          <span class="mv-form-label"><i class="mv-spin-ring"></i> ${esc(label)}</span>
          <span class="mv-form-control"><button type="button" id="qk-stop-scan" class="mv-btn mv-btn--sm">توقف</button></span>
        </div>
        <div class="mv-form-row is-stack">
          <div class="mv-prog${pct ? '' : ' is-indeterminate'}"><i style="width:${pct}%"></i></div>
        </div>
      </div>`;
        const stop = $q('qk-stop-scan');
        if (stop) stop.onclick = stopScan;
    }

    function renderServers() {
        renderSweepControls();
        const el = $q('qk-servers');
        if (!el) return;

        const scanBtn = $q('qk-scan-btn');
        if (scanBtn) {
            scanBtn.disabled = !!state.scan || state.connecting || state.disconnecting;
            const t = state.proven.length ? 'جست‌وجوی دوباره' : 'جست‌وجوی سرور';
            scanBtn.title = t;
            scanBtn.setAttribute('aria-label', t);
        }

        if (state.listBusy && !state.proven.length) { el.innerHTML = skeleton(3); return; }

        if (state.proven.length) {
            el.innerHTML = `<div class="mv-list">${state.proven.map(serverRow).join('')}</div>`;
            const foot = $q('qk-sources');
            if (foot) { foot.dataset.listNote = '1'; renderSources(); }
            el.querySelectorAll('[data-connect]').forEach((b) => {
                b.onclick = () => {
                    const node = state.proven.find(n => n.id === b.getAttribute('data-connect'));
                    if (node) connectTo(node);
                };
            });
            el.querySelectorAll('[data-drop]').forEach((b) => {
                b.onclick = () => dropServers([b.getAttribute('data-drop')]);
            });
            return;
        }

        if (state.scan) { el.innerHTML = skeleton(3); return; }

        const count = state.catalog
            ? (state.country === 'all' ? state.catalog.total
                : state.country === 'unknown' ? state.catalog.unknown
                    : ((state.catalog.countries.find(c => c.code === state.country) || {}).count || 0))
            : 0;

        const foot = $q('qk-sources');
        if (foot) { delete foot.dataset.listNote; renderSources(); }
        el.innerHTML = `
      <div class="mv-empty">
        <i class="ph-bold ph-magnifying-glass mv-empty-ic"></i>
        <b>هنوز سروری آزمایش نشده</b>
        <p>${count
            ? `${fa(count)} سرور در فهرست هست. تا آزمایش نشوند معلوم نیست کدام از خط شما کار می‌کند — بالا بگویید چند تا و از چند کشور.`
            : 'اول فهرست سرورها باید دریافت شود — دکمهٔ دریافت در سربرگ همین بخش است.'}</p>
      </div>`;
    }

    /**
     * «چند سرور از چند کشور» — the ask that had nowhere to be made.
     *
     * The section listed tested servers and nothing else, so on a fresh install it said «هیچ
     * سروری آزمایش نشده» over an empty box with no way to change that from where the user was
     * standing. The only control was an unlabelled magnifier in the title bar that swept a fixed
     * twelve.
     *
     * The Android catalogue has had these two numbers from the start, and they are the same two
     * numbers here, with the same defaults and the same meaning — one of the places where the
     * two apps were needlessly different for no reason anybody chose.
     */
    function renderSweepControls() {
        const host = $q('qk-sweep');
        if (!host) return;
        const s = state;
        const busy = !!s.scan || s.connecting || s.disconnecting;
        const deadCount = s.proven.filter((n) => n.dead || !(n.delay > 0)).length;
        const total = s.catalog ? s.catalog.total : 0;
        const ready = total > 0;

        const num = (id, value, min, max, label) => `
      <label class="qk-num">
        <span>${esc(label)}</span>
        <input type="number" id="${id}" min="${min}" max="${max}" value="${value}"
               inputmode="numeric" ${busy ? 'disabled' : ''} aria-label="${esc(label)}">
      </label>`;

        host.innerHTML = `
      <div class="qk-sweep">
        <div class="qk-sweep-row">
          ${num('qk-want-count', s.wantCount, 1, 100, 'چند سرور')}
          ${num('qk-want-countries', s.wantCountries, 1, 20, 'از چند کشور')}
          <button type="button" id="qk-sweep-go" class="mv-btn mv-btn--lg"${busy || !ready ? ' disabled' : ''}>
            <i class="ph-bold ph-magnifying-glass"></i> پیدا کن
          </button>
        </div>
        <p class="qk-sweep-note">${ready
            ? `از ${fa(total)} سرورِ فهرست، به‌ترتیب کشورهای پرسرورتر — اول پینگ TCP، بعد تست تأخیر روی همان‌ها.`
              + (s.proven.length ? ' نتیجه به فهرست شما <b>اضافه</b> می‌شود؛ چیزی پاک نمی‌شود.' : '')
            : 'فهرست هنوز دریافت نشده.'}</p>
        ${s.proven.length ? `<div class="qk-sweep-row" style="margin-top:8px">
          <button type="button" class="mv-btn" id="qk-retest"${busy ? ' disabled' : ''}>
            <i class="ph-bold ph-arrows-clockwise"></i> آزمایش دوبارهٔ ${fa(s.proven.length)} سرور من
          </button>
          ${deadCount ? `<button type="button" class="mv-btn" id="qk-drop-dead"${busy ? ' disabled' : ''}>
            <i class="ph-bold ph-trash"></i> حذف ${fa(deadCount)} سرورِ جواب‌نداده
          </button>` : ''}
          <button type="button" class="mv-link" id="qk-forget"${busy ? ' disabled' : ''}>پاک کردن فهرست</button>
        </div>` : ''}
        ${s.country !== 'all' ? `<p class="qk-sweep-note">
          کشور «${esc(countryName(s.country))}» در بخش «موقعیت» انتخاب شده — برای جست‌وجوی همان یک کشور
          <button type="button" class="mv-link" id="qk-sweep-one">فقط همین کشور را بگرد</button>.</p>` : ''}
      </div>`;

        const go = $q('qk-sweep-go');
        if (go) go.onclick = () => {
            const c = Math.max(1, Math.min(parseInt(($q('qk-want-count') || {}).value, 10) || s.wantCount, 100));
            const n = Math.max(1, Math.min(parseInt(($q('qk-want-countries') || {}).value, 10) || s.wantCountries, 20));
            s.wantCount = c; s.wantCountries = n;
            if (!s.scan) runScan(c, n);
        };
        // «آزمایش دوباره» — the saved rows go stale, and re-sweeping the whole catalogue to
        // learn that a known server stopped answering is minutes of work for a question about
        // twenty rows. Same tester, same numbers.
        const retest = $q('qk-retest');
        if (retest) retest.onclick = async () => {
            if (s.scan) return;
            s.scan = { stage: 'delay', tested: 0, total: s.proven.length, found: 0, target: s.proven.length, retest: true };
            renderServers(); renderAction();
            const r = await post('/api/quick/retest', {
                nodes: s.proven.map((n) => ({ id: n.id, uri: n.uri })),
            });
            if (r.error) { s.scan = null; renderServers(); if (typeof toast === 'function') toast(r.error); }
        };
        const dropDead = $q('qk-drop-dead');
        if (dropDead) dropDead.onclick = () => {
            dropServers(s.proven.filter((n) => n.dead || !(n.delay > 0)).map((n) => n.id));
        };

        const forget = $q('qk-forget');
        if (forget) forget.onclick = async () => {
            const ok = window.uiModal && typeof uiModal.confirm === 'function'
                ? await uiModal.confirm({
                    title: 'فهرست سرورهای آزمایش‌شده پاک شود؟',
                    message: 'سرورها از فهرست اصلی پاک نمی‌شوند — فقط نتیجهٔ آزمایش‌های شما برداشته می‌شود و باید دوباره بگردید.',
                    confirmLabel: 'پاک کن', cancelLabel: 'انصراف', danger: true,
                })
                : true;
            if (!ok) return;
            s.proven = [];
            saveProven(s.proven);
            renderServers(); renderAction();
        };

        const one = $q('qk-sweep-one');
        if (one) one.onclick = () => {
            const c = Math.max(1, Math.min(parseInt(($q('qk-want-count') || {}).value, 10) || s.wantCount, 100));
            s.wantCount = c;
            if (!s.scan) runScan(c, 0);
        };
    }

    function qkWire() {
        const wrap = $q('qk-root');
        if (!wrap) return;
        wrap.querySelectorAll('[data-qk-go]').forEach((b) => {
            b.onclick = () => qkGoSec(b.getAttribute('data-qk-go'));
        });
        wrap.querySelectorAll('[data-qk-mode]').forEach((b) => {
            b.onclick = () => switchMode(b.getAttribute('data-qk-mode'));
        });
        wrap.querySelectorAll('[data-qk-connect]').forEach((b) => {
            b.onclick = () => {
                const node = state.proven.find((n) => n.id === b.getAttribute('data-qk-connect'));
                if (node) connectTo(node);
            };
        });
        wrap.querySelectorAll('[data-qk-act]').forEach((b) => {
            b.onclick = () => {
                const k = b.getAttribute('data-qk-act');
                if (k === 'power') { if (isOn()) disconnect(); else connect(); }
                else if (k === 'scan') { if (!state.scan) runScan(12); }
            };
        });
    }

    function serverRow(n) {
        const isCurrent = state.current && state.current.id === n.id && isOn();
        const dead = !!n.dead || !(n.delay > 0);
        const tone = dead ? 'var(--mv-label-3)'
            : n.delay < 300 ? 'var(--mv-green-ink)' : n.delay < 900 ? 'var(--mv-orange-ink)' : 'var(--mv-red-ink)';
        return `
      <div class="mv-li${isCurrent ? ' is-on' : ''}${dead ? ' qk-dead' : ''}">
        <span class="mv-li-lead">${flagImg(n.country, 22)}</span>
        <span class="mv-li-text">
          <b>${esc(n.countryName || 'نامشخص')}${n.verified
                ? ` <i class="ph-fill ph-seal-check" title="این کشور اندازه‌گیری شده، نه از روی نام سرور" style="font-size:11px; color:var(--mv-green);"></i>`
                : ''}</b>
          <small dir="ltr">${esc(n.name)} · ${esc(n.protocol)}</small>
        </span>
        ${dead
                ? '<span class="mv-li-num qk-dead-note">جواب نداد</span>'
                : `<span class="mv-li-num" style="color:${tone}">${n.delay}<small>ms</small></span>`}
        ${isCurrent
                ? `<span class="mv-li-end" style="color:var(--mv-green-ink); font-weight:600;">متصل</span>`
                : dead
                    ? ''
                    : `<button type="button" class="mv-btn mv-btn--sm mv-li-end" data-connect="${esc(n.id)}" ${state.connecting ? 'disabled' : ''}>وصل شو</button>`}
        <button type="button" class="qk-row-del" data-drop="${esc(n.id)}" title="حذف از فهرست"
                aria-label="حذف ${esc(n.name)} از فهرست"><i class="ph-bold ph-x"></i></button>
      </div>`;
    }

    function skeleton(rows) {
        return `<div class="mv-list">${
            Array.from({ length: rows }, () => '<div class="mv-li"><span class="mv-skel" style="flex:1;height:26px;"></span></div>').join('')
        }</div>`;
    }

    function renderSources() {
        const el = $q('qk-sources');
        if (!el || !state.catalog) return;
        const c = state.catalog;
        const when = c.updatedAt ? new Date(c.updatedAt).toLocaleTimeString('fa-IR', { hour: '2-digit', minute: '2-digit' }) : '—';
        const bad = (c.sources || []).filter(s => !s.ok);
        const listed = el.dataset.listNote === '1';
        el.innerHTML = `
      ${listed ? `<div>این‌ها سرورهایی هستند که یک درخواست واقعی از داخلشان رد شده — عدد، تأخیر همان درخواست است.${
          state.proven.some(n => n.verified)
              ? ' نشان <i class="ph-fill ph-seal-check" style="color:var(--mv-green)"></i> یعنی کشور این سرور بعد از اتصال اندازه‌گیری شده، نه حدسی از روی نامش.'
              : ''}</div>` : ''}
      <div>فهرست: ${c.total} سرور · ${c.countries.length} کشور · به‌روزرسانی ${esc(when)}${c.stale ? ' (نسخه‌ی ذخیره‌شده)' : ''}</div>
      ${c.verified ? `<div>${c.verified} سرور کشورشان اندازه‌گیری شده و در دسته‌ی واقعی خودشان فهرست شده‌اند.</div>` : ''}
      ${bad.length ? `<div style="color:var(--mv-orange-ink)">${bad.length} منبع در دسترس نبود — فهرست از بقیه ساخته شد.</div>` : ''}`;
    }

    // ── country picker ──────────────────────────────────────────────────────────

    /** Kept as the name the other call sites use: it opens the section now. */
    function openPicker() {
        state.pickerQuery = '';
        const s = $q('qk-picker-search');
        if (s) { s.value = ''; setTimeout(() => s.focus(), 50); }
        qkGoSec('location');
    }

    function renderPicker() {
        const el = $q('qk-picker-list');
        if (!el) return;
        // Without the list there is nothing to choose from, and an empty panel with a search
        // box in it reads as broken rather than as «not fetched yet».
        if (!state.catalog) {
            el.innerHTML = state.listBusy
                ? '<div class="mv-empty"><b>در حال دریافت فهرست کشورها…</b></div>'
                : '<div class="mv-empty"><i class="ph-bold ph-cloud-slash mv-empty-ic"></i><b>فهرست سرورها دریافت نشد</b><p>بدون آن، کشوری برای انتخاب نیست. دکمهٔ دریافت دوباره در بخش «سرورها» است.</p></div>';
            return;
        }

        const q = state.pickerQuery.trim().toLowerCase();
        const rows = state.catalog.countries.filter(c =>
            !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));

        const item = (code, flagHtml, name, sub, on) => `
      <button type="button" class="mv-li${on ? ' is-sel' : ''}" data-country="${esc(code)}" role="option" aria-selected="${on}">
        <span class="mv-li-lead">${flagHtml}</span>
        <span class="mv-li-text"><b>${esc(name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>
        ${on ? `<i class="ph-bold ph-check mv-li-end" style="color:var(--mv-accent)"></i>` : ''}
      </button>`;

        el.innerHTML =
            (!q ? item('all', globeIcon(26), 'خودکار — سریع‌ترین',
                `${state.catalog.total} سرور از همه‌ی کشورها`, state.country === 'all') : '') +
            (rows.length
                ? rows.map(c => item(c.code, flagImg(c.code, 26), c.name, `${c.count} سرور`, state.country === c.code)).join('')
                : `<div class="mv-empty"><b>کشوری پیدا نشد</b></div>`) +
            (!q && state.catalog.unknown
                ? item('unknown', flagImg(null, 26), 'بدون کشور مشخص', `${state.catalog.unknown} سرور`, state.country === 'unknown')
                : '');

        el.querySelectorAll('[data-country]').forEach((b) => {
            b.onclick = () => {
                const next = b.getAttribute('data-country');
                if (next !== state.country) {
                    state.country = next;
                    try { localStorage.setItem('quick-country', next); } catch (e) {}
                    // The list is NOT cleared. It used to be, on the reasoning that results from
                    // another country would be misleading under a new label — but the list is a
                    // collection the user builds up now, and «چند سرور از چند کشور» fills it from
                    // several countries on purpose. Throwing it away because they looked at a
                    // different country would delete work they did not ask to delete.
                }
                // Picking one is the answer to the question this section asks, so it goes
                // back to where the button that will use it is.
                qkGoSec('connect');
            };
        });
    }

    // ── mount ───────────────────────────────────────────────────────────────────

    window.initQuickModule = async function () {
        const host = $q('ls-quick');
        if (!host) return;
        host.innerHTML = HTML;

        host.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent;';
        if (host.parentElement) {
            host.parentElement.style.position = 'relative';
            host.parentElement.style.padding = '0';
            host.parentElement.style.overflow = 'hidden';
        }
        $q('qk-root').querySelectorAll('.mv-side-item[data-qk-sec]').forEach((b) => {
            b.onclick = () => qkGoSec(b.getAttribute('data-qk-sec'));
        });
        $q('qk-back').onclick = () => qkGoSec('connect');
        $q('qk-picker-search').oninput = (e) => { state.pickerQuery = e.target.value; renderPicker(); };
        $q('qk-scan-btn').onclick = () => { if (!state.scan) runScan(12); };
        $q('qk-refresh-btn').onclick = async () => {
            // Refreshing the CATALOGUE does not invalidate servers the user has already proven
            // on their own line, so their list is left alone.
            await loadCatalog(true);
            renderAll();
            if (typeof toast === 'function') toast('فهرست سرورها به‌روز شد');
        };

        await refreshStatus();
        renderAll();
        // The list is a megabyte over a filtered line; do not hold the first paint for it.
        loadCatalog(false).then(() => { renderAll(); });
        if (isOn()) refreshEgress();

        // The engine, the proxy and the tunnel can all be changed from other panels — and
        // the server tears the tunnel down on its own when the engine dies. Poll while this
        // panel is visible so the switches never keep claiming a state that has ended.
        setInterval(async () => {
            const el = $q('ls-quick');
            if (!el || el.style.display === 'none') return;
            if (state.connecting || state.disconnecting || state.modeBusy) return;
            const before = `${isOn()}|${activeMode()}`;
            await refreshStatus();
            if (`${isOn()}|${activeMode()}` !== before) {
                if (!isOn()) { state.egress = null; state.current = null; }
                renderAll();
                if (isOn() && !state.egress) refreshEgress();
            }
        }, 5000);
    };
})();
