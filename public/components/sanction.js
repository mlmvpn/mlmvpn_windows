// --- «تحریم‌شکن» ---
//
// Reach the services that refuse an Iranian address, and nothing else.
//
// ── The shape of this window, and why it changed twice ──────────────────────────────────────────
//
// The relay this feature was built on is gone, so the feature became a CHOICE between the engines
// the app already has. The first two attempts at drawing that choice were both too much on one
// screen: seven equal sections, then three numbered stages plus a table plus inline Worker controls
// plus a log. Both read as a wall.
//
// This one follows the phone's: ONE page with two groups, and everything else behind a row that
// opens a page of its own.
//
//     [ state card, with the on/off button in it ]
//
//     خروج            which engine carries it        (three rows, one chosen)
//     چه چیزی باز شود   برنامه‌ها  ۳ ›   سایت‌ها  ۷ ›     (counts; each opens its own page)
//     ابزارها          سنجش ›   Worker ›   گزارش ›
//
// A row with a count and a chevron is the whole of what the main page needs to say about a list;
// the list itself belongs on its own page, where it has room. The measurement, the Cloudflare
// Worker and the live log are tools you reach for occasionally, not three more things to read every
// time the window opens.
//
// «DNS اختصاصی» has no window of its own any more; its Worker lives on the Worker page here.
//
// Renders into #ls-sanction. Talks to /api/sanction/* and /api/dedidns/*.

(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
    const $ = (id) => document.getElementById(id);

    /** The Cloudflare accounts the cloud module keeps — the same two-step `dedidns.js` used. */
    function cloudAccounts() {
        try {
            if (typeof loadCloudAccounts === 'function') return loadCloudAccounts() || [];
            const raw = (typeof PersistentStorage !== 'undefined') ? PersistentStorage.getItem('cf_accounts') : null;
            return raw ? JSON.parse(raw) : [];
        } catch (e) { return []; }
    }

    const st = {
        page: 'connect',     // 'connect' | 'exit' | 'sites' | 'apps' | 'check' | 'worker' | 'log'
        siteDraft: '',       // what is half-typed in «سایت‌ها», so a 6-second refresh cannot eat it
        cfg: { engine: null, enabled: false, apps: [], sites: [] },
        accountId: null,
        engines: [],
        services: [],
        apps: [],
        appQuery: '',
        results: {},
        checking: false,
        stage: '',
        busy: '',
        worker: null,
        log: [],
    };

    const ENGINE_NOTE = {
        dedidns: 'آی‌پی دیتاسنتر کلادفلر — برای گیت‌هاب و استیم و APIها سریع و بی‌محدودیت',
        lantern: 'شبکهٔ خود لنترن — بدون تنظیم، خودش سرور پیدا می‌کند',
        gateway: 'آی‌پی خانگی داوطلبان — همان چیزی که بعضی سرویس‌ها فقط آن را قبول می‌کنند',
    };

    // ── The page ───────────────────────────────────────────────────────────
    //
    // The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one سایفون, ماسک and
    // «ضد فیلتر SNI» wear: a glass sidebar of sections, a hero built around ONE button, and each
    // decision as a card whose header opens the section that explains it in full.
    //
    // The pages this window already had — sites, apps, the measurement, the Worker, the log — became
    // those sections; nothing was dropped, and the one thing that WAS added is the ⏱ on the «خروج»
    // card: measure every engine against your own sites, then take the one that reached most.

    const SN_SECTIONS = [
        { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
        { id: 'exit', label: 'خروج', icon: 'ph-fill ph-sign-out', tint: 'var(--mv-indigo)' },
        { id: 'sites', label: 'سایت‌ها', icon: 'ph-fill ph-globe', tint: 'var(--mv-blue)' },
        { id: 'apps', label: 'برنامه‌ها', icon: 'ph-fill ph-squares-four', tint: 'var(--mv-orange)' },
        { id: 'check', label: 'کدام موتور می‌رسد', icon: 'ph-fill ph-gauge', tint: 'var(--mv-pink, #FF2D55)' },
        { id: 'worker', label: 'Worker کلادفلر', icon: 'ph-fill ph-cloud', tint: 'var(--mv-teal)' },
        { id: 'log', label: 'گزارش', icon: 'ph-fill ph-terminal-window', tint: 'var(--mv-gray)' },
    ];

    const CSS = `
<style id="sn-css">
  .sn-wrap { display:flex; height:100%; min-height:0; }
  .sn-count { color:var(--mv-label-3); font-size:12px; margin-inline-start:auto; padding-inline-end:6px; }
  .sn-dot { font-size:8px; vertical-align:2px; margin-inline-end:5px; }
  .sn-chips { display:flex; flex-wrap:wrap; gap:6px; padding:10px 12px; }
  .sn-chip { display:inline-flex; align-items:center; gap:6px; height:29px; padding-inline:10px 4px;
             border-radius:999px; background:var(--mv-fill); font-size:12px; color:var(--mv-label); }
  .sn-chip.is-add { padding-inline:10px; border:0; cursor:pointer; color:var(--mv-label-2); font:inherit; font-size:12px; }
  .sn-chip.is-add:hover { background:var(--mv-fill-2); color:var(--mv-label); }
  .sn-chip button { width:21px; height:21px; display:grid; place-items:center; padding:0; border:0;
                    border-radius:50%; background:transparent; color:var(--mv-label-3); cursor:pointer; }
  .sn-chip button:hover { background:var(--mv-fill-2); color:var(--mv-label); }
  .sn-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(186px, 1fr)); gap:7px; padding:10px; }
  .sn-app { display:flex; align-items:center; gap:9px; min-width:0; padding:8px 10px; border:0; border-radius:10px;
            background:var(--mv-fill); color:inherit; font:inherit; text-align:start; cursor:pointer; }
  .sn-app:hover { background:var(--mv-fill-2); }
  .sn-app.is-on { background:color-mix(in srgb, var(--mv-accent) 13%, transparent); box-shadow:inset 0 0 0 1.5px var(--mv-accent); }
  .sn-app span { min-width:0; }
  .sn-app b { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; font-weight:600; }
  .sn-app small { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                  font-family:var(--mv-font-tech); font-size:10.5px; color:var(--mv-label-3); }
  .sn-table { width:100%; border-collapse:collapse; font-size:12px; }
  .sn-table th, .sn-table td { padding:9px 10px; text-align:start; border-bottom:1px solid var(--mv-sep); white-space:nowrap; }
  .sn-table th { font-weight:700; color:var(--mv-label-2); font-size:11px; }
  .sn-table tr:last-child td { border-bottom:0; }
  .sn-table td:first-child { white-space:normal; }
  .sn-ok { color:var(--mv-green); }
  .sn-no { color:var(--mv-label-3); }
  .sn-warn { color:var(--mv-orange); }
  .sn-best { display:inline-block; margin-inline-start:6px; padding:1px 7px; border-radius:999px;
             background:color-mix(in srgb, var(--mv-green) 18%, transparent); color:var(--mv-green); font-size:10.5px; }
  .sn-log { margin:0; width:100%; max-height:340px; overflow:auto; font-family:var(--mv-font-latin, ui-monospace), monospace;
            font-size:11px; line-height:1.75; white-space:pre-wrap; text-align:left; color:var(--mv-label-2); }
  /* The engine rows inside the hero's card: the same pick as every other engine page. */
  .sn-wrap .mv-eng-pick small .sn-dot { margin-inline-end:4px; }
</style>`;

    function template() {
        return CSS + `
<div dir="rtl" class="sn-wrap mv-split" id="sn-wrap">
  <aside class="mv-side" aria-label="بخش‌های تحریم‌شکن">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="sn-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${SN_SECTIONS.map(x => `
        <button type="button" class="mv-side-item" data-sn-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="sn-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="sn-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="sn-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="sn-stage" style="--tint:var(--mv-green)"></div>
        <div class="mv-eng-grid" id="sn-cards"></div>
      </div>
      ${SN_SECTIONS.filter(x => x.id !== 'connect').map(x => `
      <div class="mv-eng-sec" data-sec="${x.id}"><div class="mv-form" id="sn-sec-${x.id}"></div></div>`).join('')}
    </div>

    <div class="mv-eng-foot" id="sn-foot"></div>
  </section>
</div>`;
    }

    // ── Small builders ─────────────────────────────────────────────────────

    const section = (header, rows, footer, extra) =>
        `<div class="mv-form-section is-wide">
       ${header ? `<div class="mv-form-header">${header}</div>` : ''}
       <div class="mv-form-group"${extra || ''}>${rows}</div>
       ${footer ? `<div class="mv-form-footer">${footer}</div>` : ''}
     </div>`;

    /** A row that opens a page of its own — the main page's only way of showing a list. */
    const navRow = (id, title, sub, value) =>
        `<button type="button" class="mv-form-row is-action" data-go="${id}">
       <span class="mv-form-label">${title}<small>${sub}</small></span>
       <span class="sn-count">${value || ''}</span>
       <i class="ph-bold ph-caret-left mv-row-end"></i>
     </button>`;

    // ── What the page is saying, in one place ──────────────────────────────

    function snView() {
        const eng = st.engines.find(e => e.id === st.cfg.engine);
        if (st.checking) {
            return { tone: 'busy', head: 'در حال سنجش', line: esc(st.stage || 'موتورها بالا می‌آیند و هر سایت امتحان می‌شود.') };
        }
        if (st.busy) return { tone: 'busy', head: esc(st.busy), line: 'چند لحظه…' };
        if (st.cfg.enabled && eng) {
            return {
                tone: 'on',
                head: 'روشن است',
                line: eng.split
                    ? `${fa(st.cfg.apps.length)} برنامه و ${fa(st.cfg.sites.length)} سایت از «${esc(eng.label)}» رد می‌شوند؛ بقیهٔ ترافیک مستقیم.`
                    : `«${esc(eng.label)}» روشن است — این موتور کل ترافیک سیستم را می‌برد.`,
            };
        }
        if (!eng) {
            return {
                tone: 'off',
                head: 'یک خروج انتخاب کنید',
                line: 'در کارت «خروج» یکی را بردارید — یا دکمهٔ سنجش همان کارت را بزنید تا خودش بسنجد و آن‌که به بیشترین سایت شما رسید را بردارد.',
            };
        }
        return {
            tone: 'off',
            head: 'سرویس‌هایی که آدرس ایران را رد می‌کنند',
            line: `فقط همان‌ها از «${esc(eng.label)}» رد می‌شوند — بانک و سایت ایرانی و بازی دست‌نخورده می‌مانند و سرعتشان هدر نمی‌رود.`,
        };
    }

    // ── The hero, and the two cards ────────────────────────────────────────

    function tally(id) {
        let ok = 0;
        for (const s of st.cfg.sites) {
            const r = st.results[s];
            if (r && r.via && r.via[id] && r.via[id].ok) ok++;
        }
        return ok;
    }

    function bestEngine() {
        let best = null;
        for (const e of st.engines) {
            if (!e.split) continue;
            const n = tally(e.id);
            if (n && (!best || n > best.n)) best = { id: e.id, n };
        }
        return best && best.id;
    }

    /** The sidebar's own card: which window this is, and what it is doing. */
    function snRenderIdent() {
        const host = $('sn-ident');
        if (!host) return;
        const v = snView();
        const word = v.tone === 'on' ? 'روشن است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('sanction');
        const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
            : '<span class="mv-side-tile" style="--tint:var(--mv-green)"><i class="ph-fill ph-shield-check"></i></span>';
        host.innerHTML = `${icon}
      <b>تحریم‌شکن</b>
      <small><i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : ''}"></i>${word}</small>`;
    }

    /** The one button — the same one in the hero and in the title band. */
    function snActionButton(big) {
        const eng = st.engines.find(e => e.id === st.cfg.engine);
        const off = !eng || !!st.busy || st.checking;
        return `<button type="button" class="mv-btn${big ? ' mv-btn--lg' : ' mv-btn--sm'}${st.cfg.enabled ? '' : ' mv-btn--primary'}"
        data-sn-act="toggle"${off ? ' disabled' : ''}>${st.cfg.enabled ? 'خاموش' : 'روشن کن'}</button>`;
    }

    /** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
    function snRenderStage() {
        const host = $('sn-stage');
        if (!host) return;
        const v = snView();
        const eng = st.engines.find(e => e.id === st.cfg.engine);

        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-sn-act="toggle" data-part="power">
          <i data-part="glyph"></i>
        </button>
      </div>
      <div class="mv-eng-stage-side">
        <div class="mv-eng-live" data-part="live"></div>
      </div>`;
            host.dataset.built = '1';
            host.querySelectorAll('[data-sn-act]').forEach((b) => { b.onclick = () => toggle(); });
        }

        const q = (n) => host.querySelector(`[data-part="${n}"]`);
        q('head').innerHTML = v.head;
        q('line').innerHTML = v.line;

        const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : '';
        const btn = q('power');
        const want = 'mv-eng-power' + ring;
        if (btn.className !== want) btn.className = want;
        btn.disabled = !eng || !!st.busy || st.checking;
        const aria = st.cfg.enabled ? 'خاموش کردن' : 'روشن کردن';
        btn.setAttribute('aria-label', aria);
        btn.title = aria;
        // The ring alone while it works: a glyph class beside it would draw a second circle over it.
        const glyph = v.tone === 'busy' ? 'mv-spin-ring' : (st.cfg.enabled ? 'ph-fill ph-power' : 'ph-bold ph-power');
        const gl = q('glyph');
        if (gl.className !== glyph) gl.className = glyph;

        const live = q('live');
        if (live && window.MVEngineLive) MVEngineLive.mount(live);
    }

    function snRenderCards() {
        const host = $('sn-cards');
        if (!host) return;
        const done = Object.keys(st.results).length;
        const best = bestEngine();

        const exits = st.engines.length ? st.engines.map(e => {
            const on = st.cfg.engine === e.id;
            const bits = [ENGINE_NOTE[e.id] || ''];
            if (done && e.split) bits.push(`${fa(tally(e.id))} از ${fa(st.cfg.sites.length)} سایت`);
            if (!e.split) bits.push('کل ترافیک سیستم را می‌برد');
            return `
        <button type="button" class="mv-eng-pick${on ? ' is-on' : ''}${e.live ? ' is-live' : ''}" data-engine="${e.id}" role="radio" aria-checked="${on}">
          <i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i>
          <span class="mv-eng-pick-text"><b>${esc(e.label)}${e.id === best ? '<span class="sn-best">بهترین</span>' : ''}</b>
            <small><i class="ph-fill ph-circle sn-dot sn-${e.live ? 'ok' : 'no'}"></i>${bits.filter(Boolean).map(esc).join(' · ')}</small></span>
        </button>`;
        }).join('') : '<div class="mv-eng-card2-foot">فهرست موتورها خوانده نشد — پنجره را ببندید و باز کنید.</div>';

        const eng = st.engines.find(e => e.id === st.cfg.engine);
        host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-sn-go="exit">
            <span class="mv-eng-glyph"><i class="ph-fill ph-sign-out"></i></span>
            <h3>خروج</h3>
            <span class="mv-eng-card2-end">${esc(eng ? eng.label : '—')}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-sn-act="measure"
                  title="سنجش موتورها روی سایت‌های شما و انتخاب بهترین" aria-label="سنجش و انتخاب بهترین خروج"
                  ${st.checking || st.busy || !st.cfg.sites.length ? 'disabled' : ''}>
            <i class="${st.checking ? 'mv-spin-ring' : 'ph-bold ph-gauge'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body" role="radiogroup">${exits}</div>
        <div class="mv-eng-card2-foot">${st.checking
            ? esc(st.stage || 'در حال سنجش…')
            : !st.cfg.sites.length
                ? 'برای سنجش، اول در «سایت‌ها» چند سایت اضافه کنید.'
                : done
                    ? 'دکمهٔ سنجش (بالا) دوباره می‌سنجد و آن‌که به بیشترین سایت رسید را برمی‌دارد.'
                    : 'نقطهٔ نارنجی یعنی آن موتور الان خاموش است — «روشن کن» خودش بالا می‌آوردش. دکمهٔ سنجش بالا، همه را روی سایت‌های خودتان امتحان می‌کند.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <button type="button" class="mv-eng-card2-head" data-sn-go="sites">
          <span class="mv-eng-glyph"><i class="ph-fill ph-list-checks"></i></span>
          <h3>چه چیزی باز شود</h3>
          <span class="mv-eng-card2-end"><i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          <button type="button" class="mv-eng-pick" data-sn-go="sites">
            <i class="ph-fill ph-globe"></i>
            <span class="mv-eng-pick-text"><b>سایت‌ها</b><small>برای چیزی که در مرورگر باز می‌کنید</small></span>
            <span class="sn-count">${st.cfg.sites.length ? fa(st.cfg.sites.length) : '—'}</span>
          </button>
          <button type="button" class="mv-eng-pick" data-sn-go="apps">
            <i class="ph-fill ph-squares-four"></i>
            <span class="mv-eng-pick-text"><b>برنامه‌ها</b><small>همهٔ ترافیکشان از موتور رد می‌شود</small></span>
            <span class="sn-count">${st.cfg.apps.length ? fa(st.cfg.apps.length) : '—'}</span>
          </button>
        </div>
        <div class="mv-eng-card2-foot">فقط همین‌ها از موتور رد می‌شوند. بانک و سایت ایرانی و بازی دست‌نخورده می‌مانند.</div>
      </div>`;
    }

    /** The strip along the bottom: in one line, what is true right now. */
    function snRenderFoot() {
        const host = $('sn-foot');
        if (!host) return;
        const v = snView();
        const eng = st.engines.find(e => e.id === st.cfg.engine);
        const word = v.tone === 'on' ? `روشن — از «${esc(eng ? eng.label : '')}»`
            : v.tone === 'busy' ? esc(st.busy || 'در حال سنجش')
                : eng ? `خاموش — با «${esc(eng.label)}» روشن می‌شود` : 'خاموش — خروجی انتخاب نشده';
        const end = st.cfg.sites.length || st.cfg.apps.length
            ? `${fa(st.cfg.sites.length)} سایت · ${fa(st.cfg.apps.length)} برنامه` : '';
        host.innerHTML = `
      <i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : ''}"></i>
      <span>${word}</span>
      <span class="mv-eng-foot-end">${end}</span>`;
    }

    /** «خروج» card's ⏱: measure every engine against the user's own sites, then take the best. */
    async function measureAndPick() {
        if (st.checking || !st.cfg.sites.length) return;
        await runCheck();
        const best = bestEngine();
        if (!best) { log('— هیچ موتوری به سایت‌های شما نرسید'); return; }
        const e = st.engines.find(x => x.id === best);
        if (best !== st.cfg.engine) {
            st.cfg.engine = best;
            saveConfig();
            log(`✅ «${(e && e.label) || best}» انتخاب شد — به بیشترین سایت رسید`);
        } else {
            log(`— همان «${(e && e.label) || best}» بهترین است`);
        }
    }

    // ── Page: sites ────────────────────────────────────────────────────────

    function sitesPage() {
        const chips = st.cfg.sites.map(s => `
      <span class="sn-chip"><span dir="ltr">${esc(s)}</span>
        <button type="button" data-drop-site="${esc(s)}" aria-label="برداشتن ${esc(s)}"><i class="ph-bold ph-x"></i></button></span>`).join('');
        const suggest = st.services
            .filter(s => s.tier === 'test' && !st.cfg.sites.includes(String(s.domains[0] || '').toLowerCase()))
            .slice(0, 10);

        return section('', `
        <div class="mv-form-row">
          <span class="mv-form-label">افزودن</span>
          <span class="mv-form-control"><input id="sn-site-input" class="mv-popup" dir="ltr" placeholder="openai.com  ⏎" value="${esc(st.siteDraft)}" style="min-width:210px"></span>
        </div>
        ${st.cfg.sites.length ? `<div class="mv-form-row is-stack"><div class="sn-chips">${chips}</div></div>`
                : '<div class="mv-form-row"><span class="mv-form-label" style="color:var(--mv-label-2)">هنوز سایتی اضافه نشده.</span></div>'}`,
                'آدرس را بدون <span dir="ltr">https://</span> بنویسید و اینتر بزنید. زیردامنه‌ها خودشان هم می‌آیند.')
            + (suggest.length ? section('پیشنهادها',
                `<div class="mv-form-row is-stack"><div class="sn-chips">
          ${suggest.map(s => `<button type="button" class="sn-chip is-add" data-add-site="${esc(String(s.domains[0] || '').toLowerCase())}">
              <i class="ph-bold ph-plus"></i>${esc(s.name)}</button>`).join('')}
        </div></div>`, 'سرویس‌هایی که برنامه می‌شناسد و معمولاً آدرس ایران را رد می‌کنند.') : '');
    }

    // ── Page: apps ─────────────────────────────────────────────────────────

    function appsPage() {
        const q = st.appQuery.trim().toLowerCase();
        const visible = st.apps.filter(a => !q || a.name.toLowerCase().includes(q) || a.exe.includes(q)).slice(0, 80);
        const chips = st.cfg.apps.map(a => `
      <span class="sn-chip"><span dir="ltr">${esc(a)}</span>
        <button type="button" data-drop-app="${esc(a)}" aria-label="برداشتن ${esc(a)}"><i class="ph-bold ph-x"></i></button></span>`).join('');

        return (st.cfg.apps.length ? section('انتخاب‌شده', `<div class="mv-form-row is-stack"><div class="sn-chips">${chips}</div></div>`, '') : '')
            + section('', `
        <div class="mv-form-row">
          <span class="mv-form-label">جستجو</span>
          <span class="mv-form-control"><input id="sn-app-q" class="mv-popup" placeholder="نام برنامه…" value="${esc(st.appQuery)}"></span>
        </div>
        ${st.apps.length ? `<div class="sn-grid">${visible.map(a => {
                const on = st.cfg.apps.includes(a.exe);
                return `<button type="button" class="sn-app${on ? ' is-on' : ''}" data-app="${esc(a.exe)}" aria-pressed="${on}" title="${esc(a.path || a.exe)}">
              <span><b dir="auto">${esc(a.name)}</b><small dir="ltr">${esc(a.exe)}</small></span></button>`;
            }).join('')}</div>`
                : '<div class="mv-form-row"><span class="mv-form-label" style="color:var(--mv-label-2)">در حال خواندن برنامه‌های نصب‌شده…</span></div>'}`,
                'برای سایتی که در مرورگر باز می‌کنید مرورگر را انتخاب نکنید — اسم سایت را در «سایت‌ها» بزنید تا فقط همان رد شود.');
    }

    // ── Page: the measurement ──────────────────────────────────────────────

    function cell(r) {
        if (!r) return '<span class="sn-no">—</span>';
        if (r.ok) return `<span class="sn-ok"><i class="ph-bold ph-check"></i> ${fa(Math.round(r.ms || 0))}ms</span>`;
        if (r.state === 'sanctioned') return '<span class="sn-warn">سایت رد کرد</span>';
        if (r.state === 'offline') return '<span class="sn-no">بالا نیامد</span>';
        // The gateway is measured in a second pass, after everything else is done and stopped.
        if (r.state === 'pending') return '<span class="sn-no sn-spin" style="font-size:11px"></span>';
        if (r.state === 'no-proxy') return '<span class="sn-no">کل سیستم</span>';
        return '<span class="sn-no"><i class="ph-bold ph-x"></i></span>';
    }

    function checkPage() {
        const sites = st.cfg.sites;
        const done = Object.keys(st.results).length;
        const best = bestEngine();
        const b = st.engines.find(e => e.id === best);

        if (!sites.length) {
            return section('', '<div class="mv-form-row"><span class="mv-form-label" style="color:var(--mv-label-2)">'
                    + 'اول در «سایت‌ها» چند سایت اضافه کنید — سنجش روی آن‌ها انجام می‌شود.</span></div>', '');
        }

        const table = done ? `<div class="mv-form-row is-stack" style="overflow-x:auto">
        <table class="sn-table">
          <thead><tr><th>سایت</th><th>مستقیم</th>${st.engines.map(e => `<th>${esc(e.label)}</th>`).join('')}</tr></thead>
          <tbody>${sites.map(s => {
            const r = st.results[s];
            const d = r && r.direct;
            const dCell = !d ? '<span class="sn-no">—</span>'
                : d.state === 'open' ? '<span class="sn-ok">باز است</span>'
                    : d.state === 'open_listed' ? `<span class="sn-warn" title="${esc(d.note || '')}">با حساب تحریم می‌کند</span>`
                        : d.state === 'sanctioned' ? '<span class="sn-warn">تحریم</span>'
                            : d.state === 'filtered' ? '<span class="sn-no">فیلتر</span>'
                                : d.state === 'blocked_download' ? '<span class="sn-no">دانلود، بسته</span>'
                                    : `<span class="sn-no">${esc(d.state)}</span>`;
            return `<tr><td><b dir="ltr">${esc(s)}</b></td><td>${dCell}</td>
              ${st.engines.map(e => `<td>${cell(r && r.via && r.via[e.id])}</td>`).join('')}</tr>`;
        }).join('')}</tbody></table></div>` : '';

        return section('', `
        <button type="button" class="mv-form-row is-action" id="sn-run"${st.checking ? ' disabled' : ''}>
          <span class="mv-form-label">${st.checking ? 'در حال سنجش…' : (done ? 'دوباره بسنج' : 'بسنج')}
            <small>${esc(st.checking ? (st.stage || 'موتورها بالا می‌آیند…')
                : 'خودش موتورها را روشن می‌کند، می‌سنجد، و آن‌هایی را که خودش روشن کرده دوباره خاموش می‌کند')}</small></span>
          ${st.checking ? '<i class="ph-bold ph-circle-notch sn-spin mv-row-end"></i>' : '<i class="ph-bold ph-play mv-row-end"></i>'}
        </button>${table}`,
                done && b
                    ? `بهترین نتیجه: «<b>${esc(b.label)}</b>» — ${fa(tally(best))} از ${fa(sites.length)} سایت.`
                    : done ? 'هیچ موتوری به هیچ‌کدام نرسید. بعداً دوباره بسنجید.'
                        : 'گیت‌وی آخر سنجیده می‌شود، چون روشن کردنش مسیر کل ماشین را می‌گیرد و شبکه را از زیر پای بقیه می‌کشد.');
    }

    // ── Page: the Worker ───────────────────────────────────────────────────

    function workerLine() {
        const w = st.worker;
        if (!w) return { text: 'در حال خواندن…', tone: 'sn-no' };
        const e = (w.workers && w.workers.ecs) || {};
        if (!e.url) return { text: 'نصب نشده', tone: 'sn-warn' };
        if (!e.ok) return { text: e.reason === 'timeout' ? 'در دسترس نیست' : 'خوانده نشد', tone: 'sn-warn' };
        if (e.stale) return { text: `قدیمی — نسخهٔ ${fa(e.version)} در برابر ${fa(w.shipped)}`, tone: 'sn-warn' };
        return { text: `بروز است (نسخهٔ ${fa(e.version)})`, tone: 'sn-ok' };
    }

    function workerPage() {
        const e = (st.worker && st.worker.workers && st.worker.workers.ecs) || {};
        const wl = workerLine();
        const accs = cloudAccounts();
        if (!st.accountId && accs.length) st.accountId = accs[0].id;
        const verb = e.url ? (e.stale ? 'بروزرسانی' : 'نصب دوباره') : 'نصب';

        return section('', `
        <div class="mv-form-row">
          <span class="mv-form-label">وضعیت<small class="${wl.tone}">${esc(wl.text)}</small></span>
          ${e.url ? `<span class="mv-row-end" style="font-size:10.5px;direction:ltr;color:var(--mv-label-3)">${esc(String(e.url).replace(/^https?:\/\//, ''))}</span>` : ''}
        </div>
        ${accs.length > 1 ? `<div class="mv-form-row">
          <span class="mv-form-label">حساب کلادفلر</span>
          <span class="mv-form-control"><select id="sn-w-acc" class="mv-popup">
            ${accs.map(a => `<option value="${esc(a.id)}"${a.id === st.accountId ? ' selected' : ''}>${esc(a.name || a.email || a.id)}</option>`).join('')}
          </select></span>
        </div>` : ''}
        ${accs.length ? '' : '<div class="mv-form-row"><span class="mv-form-label sn-warn">اول یک اکانت کلادفلر در «پنل‌های ابری» وصل کنید.</span></div>'}
        <div class="mv-form-row">
          <span class="mv-form-label">${esc(verb)}<small>${e.url ? 'همان نام و همان آدرس، جایگزین می‌شود' : 'روی حساب کلادفلر خودتان ساخته می‌شود'}</small></span>
          <span class="mv-form-control" style="display:flex;gap:6px">
            <button type="button" class="mv-btn mv-btn--sm" id="sn-w-deploy"${st.busy || !accs.length ? ' disabled' : ''}>${esc(verb)}</button>
            ${e.url ? `<button type="button" class="mv-btn mv-btn--sm" id="sn-w-remove"${st.busy || !accs.length ? ' disabled' : ''}>حذف</button>` : ''}
          </span>
        </div>`,
                'موتور «DNS اختصاصی» روی یک Worker در حساب کلادفلر خودتان کار می‌کند. چون آنجا می‌ماند و با بروزرسانی برنامه عوض نمی‌شود، نسخه‌اش از خودِ Worker پرسیده می‌شود نه از حافظهٔ برنامه.')
            + (st.busy || st.log.length ? section('مراحل',
                `<div class="mv-form-row is-stack"><pre class="sn-log" dir="ltr">${esc(st.log.slice(-40).join('\n')) || '—'}</pre></div>`, '') : '');
    }

    // ── Page: the log ──────────────────────────────────────────────────────

    function logPage() {
        return section('', `<div class="mv-form-row is-stack"><pre class="sn-log" dir="ltr">${esc(st.log.join('\n')) || 'هنوز چیزی ثبت نشده.'}</pre></div>`, '');
    }

    // ── Paint ──────────────────────────────────────────────────────────────

    /** Show one section, and keep the sidebar, the title and the back button in step. */
    function snGoSec(sec) {
        const root = $('sn-wrap');
        if (!root) return;
        st.page = SN_SECTIONS.some(x => x.id === sec) ? sec : 'connect';
        if (st.page === 'apps' && !st.apps.length) loadApps();
        root.querySelectorAll('.mv-eng-sec').forEach(n => n.classList.toggle('is-on', n.getAttribute('data-sec') === st.page));
        root.querySelectorAll('.mv-side-item[data-sn-sec]').forEach(b => b.classList.toggle('active', b.getAttribute('data-sn-sec') === st.page));
        const found = SN_SECTIONS.find(x => x.id === st.page);
        const title = $('sn-title');
        if (title) title.textContent = found ? found.label : '';
        const back = $('sn-back');
        if (back) back.disabled = st.page === 'connect';
        // The home section carries no toolbar at all (page-kit.css › .mv-pane.is-home).
        const pane = root.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', st.page === 'connect');
        const sc = $('sn-scroll');
        if (sc) sc.scrollTop = 0;
        paint();
    }

    function exitPage() {
        const done = Object.keys(st.results).length;
        const best = bestEngine();
        const rows = st.engines.map(e => {
            const on = st.cfg.engine === e.id;
            const bits = [ENGINE_NOTE[e.id] || ''];
            if (done && e.split) bits.push(`${fa(tally(e.id))} از ${fa(st.cfg.sites.length)} سایت رسید`);
            if (!e.split) bits.push('کل ترافیک سیستم را می‌برد، نه فقط انتخاب‌شده‌ها');
            return `
        <button type="button" class="mv-form-row is-action" data-engine="${e.id}" role="radio" aria-checked="${on}">
          <span class="mv-row-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span>
          <span class="mv-form-label">${esc(e.label)}${e.id === best ? '<span class="sn-best">بهترین</span>' : ''}
            <small><i class="ph-fill ph-circle sn-dot sn-${e.live ? 'ok' : 'no'}"></i>${bits.filter(Boolean).map(esc).join(' · ')}</small></span>
        </button>`;
        }).join('');

        return section('خروج', rows || '<div class="mv-form-row"><span class="mv-form-label" style="color:var(--mv-label-2)">فهرست موتورها خوانده نشد.</span></div>',
            'نقطهٔ نارنجی یعنی آن موتور الان خاموش است — لازم نیست خودتان روشنش کنید، دکمهٔ اتصال خودش بالا می‌آوردش. '
            + 'دو موتور اول فقط همان سایت‌ها و برنامه‌های انتخاب‌شده را می‌برند؛ گیت‌وی کل ترافیک سیستم را می‌برد، پس انتخاب‌های «چه چیزی باز شود» روی آن معنایی ندارند.');
    }

    function paint() {
        const root = $('sn-wrap');
        if (!root) return;
        snRenderIdent();
        snRenderFoot();
        if (st.page === 'connect') { snRenderStage(); snRenderCards(); }
        else {
            const host = $('sn-sec-' + st.page);
            if (host) {
                host.innerHTML = st.page === 'exit' ? exitPage()
                    : st.page === 'sites' ? sitesPage()
                        : st.page === 'apps' ? appsPage()
                            : st.page === 'check' ? checkPage()
                                : st.page === 'worker' ? workerPage()
                                    : logPage();
            }
        }
        wire(root);
    }

    function wire(body) {
        body.querySelectorAll('[data-sn-go]').forEach(b => { b.onclick = () => snGoSec(b.getAttribute('data-sn-go')); });
        body.querySelectorAll('[data-sn-act]').forEach(b => {
            b.onclick = () => (b.getAttribute('data-sn-act') === 'measure' ? measureAndPick() : toggle());
        });
        body.querySelectorAll('[data-engine]').forEach(b => b.onclick = () => {
            st.cfg.engine = b.getAttribute('data-engine');
            saveConfig();
        });

        const input = $('sn-site-input');
        if (input) {
            // The draft is kept in state: this window refreshes itself every six seconds, and a
            // repaint used to wipe whatever was half-typed here.
            input.oninput = () => { st.siteDraft = input.value; };
            input.onkeydown = (e) => {
                if (e.key !== 'Enter') return;
                const v = String(input.value || '').trim().toLowerCase()
                    .replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
                if (v && !st.cfg.sites.includes(v)) { st.cfg.sites = st.cfg.sites.concat(v); }
                st.siteDraft = '';
                input.value = '';
                saveConfig();
            };
            if (document.activeElement !== input && !st.siteDraft) input.focus();
        }
        body.querySelectorAll('[data-drop-site]').forEach(b => b.onclick = () => {
            const v = b.getAttribute('data-drop-site');
            st.cfg.sites = st.cfg.sites.filter(x => x !== v);
            delete st.results[v];
            saveConfig();
        });
        body.querySelectorAll('[data-add-site]').forEach(b => b.onclick = () => {
            const v = b.getAttribute('data-add-site');
            if (v && !st.cfg.sites.includes(v)) { st.cfg.sites = st.cfg.sites.concat(v); saveConfig(); }
        });

        const qi = $('sn-app-q');
        if (qi) qi.oninput = () => {
            st.appQuery = qi.value;
            paint();
            const n = $('sn-app-q');
            if (n) { n.focus(); n.selectionStart = n.value.length; }
        };
        body.querySelectorAll('[data-app]').forEach(b => b.onclick = () => {
            const exe = b.getAttribute('data-app');
            st.cfg.apps = st.cfg.apps.includes(exe) ? st.cfg.apps.filter(x => x !== exe) : st.cfg.apps.concat(exe);
            saveConfig();
        });
        body.querySelectorAll('[data-drop-app]').forEach(b => b.onclick = () => {
            st.cfg.apps = st.cfg.apps.filter(x => x !== b.getAttribute('data-drop-app'));
            saveConfig();
        });

        const run = $('sn-run');
        if (run) run.onclick = runCheck;
        const sel = $('sn-w-acc');
        if (sel) sel.onchange = () => { st.accountId = sel.value; };
        const d = $('sn-w-deploy');
        if (d) d.onclick = () => workerAction('deploy');
        const r = $('sn-w-remove');
        if (r) r.onclick = () => workerAction('remove');
    }

    function log(line) {
        st.log.push(line);
        if (st.log.length > 300) st.log = st.log.slice(-300);
        // Only repaint when the lines are actually on screen, so a busy deploy does not redraw the
        // whole window forty times.
        if (st.page === 'log' || st.page === 'worker') paint();
    }

    /** Progress pushed from the server — the Worker deploy narrates itself. */
    window.handleSanctionLog = function (d) { if (d && d.line) log(String(d.line)); };

    // ── Talking to the server ──────────────────────────────────────────────

    async function api(path, body) {
        const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
        const r = await fetch('/api/' + path, opt);
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || `پاسخ ${r.status}`);
        return j;
    }

    async function refresh() {
        try {
            const d = await api('sanction/status');
            st.cfg = d.config; st.engines = d.engines; st.services = d.services || [];
        } catch (e) { /* the server is restarting; keep the last picture */ }
        paint();
        try { st.worker = await api('dedidns/version'); paint(); } catch (e) { /* shown as unread */ }
    }

    async function loadApps() {
        try {
            const d = await fetch('/api/app-routing/apps').then(r => r.json());
            st.apps = d.apps || [];
        } catch (e) { st.apps = []; }
        paint();
    }

    let saveTimer = null;
    function saveConfig() {
        paint();
        clearTimeout(saveTimer);
        saveTimer = setTimeout(async () => {
            try { await api('sanction/config', { apps: st.cfg.apps, sites: st.cfg.sites, engine: st.cfg.engine }); }
            catch (e) { log('✗ ' + e.message); }
        }, 250);
    }

    async function runCheck() {
        if (st.checking) return;
        st.checking = true; st.results = {}; st.stage = ''; paint();
        log('— سنجش شروع شد');
        try {
            const r = await fetch('/api/sanction/check', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sites: st.cfg.sites }),
            });
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const l of lines) {
                    if (!l.trim()) continue;
                    let o; try { o = JSON.parse(l); } catch (e) { continue; }
                    if (o.starting) { st.stage = `${o.label} بالا می‌آید…`; st.log.push(`↑ ${o.label} بالا می‌آید`); paint(); continue; }
                    if (o.engineError) { st.log.push(`✗ ${o.label}: ${o.error}`); continue; }
                    if (o.engines) {
                        st.engines = st.engines.map(e => Object.assign({}, e, o.engines.find(x => x.id === e.id) || {}));
                        st.stage = 'سایت‌ها سنجیده می‌شوند…'; paint(); continue;
                    }
                    if (o.site) {
                        st.results[o.site] = { direct: o.direct, via: o.via };
                        const ok = Object.entries(o.via).filter(([, v]) => v && v.ok)
                            .map(([k]) => (st.engines.find(e => e.id === k) || {}).label || k);
                        const word = { open: 'باز', open_listed: 'با حساب تحریم می‌کند', sanctioned: 'تحریم', filtered: 'فیلتر' }[o.direct.state] || o.direct.state;
                        st.log.push(`${o.site}: مستقیم ${word}${ok.length ? ' · از ' + ok.join('، ') + ' رسید' : ' · از هیچ موتوری نرسید'}`);
                        st.stage = `${fa(Object.keys(st.results).length)} از ${fa(st.cfg.sites.length)} سایت`;
                        paint();
                    }
                    if (o.fatal) st.log.push('✗ ' + o.error);
                }
            }
            log('— سنجش تمام شد');
        } catch (e) {
            log('✗ ' + e.message);
        }
        st.checking = false; st.stage = '';
        await refresh();
    }

    async function toggle() {
        const eng = st.engines.find(e => e.id === st.cfg.engine);
        if (!eng) return;
        st.busy = st.cfg.enabled ? 'در حال خاموش کردن' : 'در حال روشن کردن'; paint();
        try {
            if (st.cfg.enabled) { await api('sanction/disable', {}); log('— خاموش شد'); }
            else {
                const r = await api('sanction/enable', { engine: st.cfg.engine, apps: st.cfg.apps, sites: st.cfg.sites });
                log('✅ ' + (r.message || 'روشن شد'));
            }
        } catch (e) { log('✗ ' + e.message); }
        st.busy = ''; await refresh();
    }

    async function workerAction(kind) {
        const accs = cloudAccounts();
        const acc = accs.find(a => a.id === st.accountId) || accs[0] || null;
        if (!acc || !acc.token) { log('✗ اول یک اکانت کلادفلر در بخش «پنل‌های ابری» وصل کنید.'); return; }
        st.busy = kind === 'remove' ? 'در حال حذف Worker' : 'در حال نصب Worker';
        st.log.push(kind === 'remove' ? '— حذف Worker' : '— نصب Worker');
        paint();
        try {
            const r = kind === 'remove'
                ? await api('dedidns/remove', { token: acc.token, email: acc.email, mode: 'ecs' })
                : await api('dedidns/deploy', { token: acc.token, email: acc.email, mode: 'ecs' });
            log('✅ ' + (r.message || (kind === 'remove' ? 'حذف شد' : 'نصب شد')));
        } catch (e) { log('✗ ' + e.message); }
        st.busy = '';
        try { st.worker = await api('dedidns/version'); } catch (e) { /* keep the last */ }
        paint();
    }

    /** Which engine owns the home-screen lamp. Read by shell/apps.js. */
    window.MVProbe = window.MVProbe || {};
    window.MVProbe.sanction = () => !!st.cfg.enabled;

    window.refreshSanction = refresh;

    window.initSanctionModule = function () {
        const root = $('ls-sanction');
        if (!root) return;
        root.innerHTML = template();
        const wrap = $('sn-wrap');
        if (wrap) {
            wrap.querySelectorAll('.mv-side-item[data-sn-sec]').forEach(b => {
                b.onclick = () => snGoSec(b.getAttribute('data-sn-sec'));
            });
            const back = $('sn-back');
            if (back) back.onclick = () => snGoSec('connect');
        }
        snGoSec('connect');
        refresh();
        setInterval(() => {
            const r = $('ls-sanction');
            if (r && r.style.display !== 'none' && !st.checking && !st.busy) refresh();
        }, 6000);
    };
})();
