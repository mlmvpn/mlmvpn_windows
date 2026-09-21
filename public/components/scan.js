// --- «اسکنر آی‌پی» ---
//
// The whole scan page: sidebar, sections, hero, steps, results table. Built with the page kit
// (ui/page-kit.css) on the engine-page template from components/fronts.js, so this window reads
// as part of the same program as Settings, the Store and the engines.
//
// WHAT THIS REPLACED, AND WHY.
//
// The old page carried two navigation systems at once — a tab strip and a breadcrumb — inside a
// window that already has a title and a sidebar, while its 320px "sidebar" was not navigation at
// all but a form with 21 checkboxes. The tabs were never concurrent (the server keeps ONE
// scanState, and startScan marks every other running tab done), so they are what they always
// were: saved scan profiles. They now live in the sidebar, where a list of documents belongs,
// and the sidebar's second group is the sections.
//
// The other thing this page never said out loud is that a scan is a PIPELINE: build the list,
// scan the ports, pick the best, then test those for real through the user's own config. That is
// why the progress bar appeared to restart near the end. The four stages are now drawn as steps
// under the button that starts them.
//
// Renders into #scan-root. Every id the rest of the app reads — btn-top-scan, stat-*, chk-*,
// .port-chk, param-*, ip-textarea, results-body, history-list … — is kept by name; this file
// only changes where they sit and what they look like.

(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Persian digits, so a number inside a Persian sentence is not half Latin. */
    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);

    // ── What the page is made of ───────────────────────────────────────────

    const SECTIONS = [
        { id: 'scan', label: 'اسکن', icon: 'ph-fill ph-radar', tint: 'var(--mv-blue)' },
        { id: 'sources', label: 'منابع و پورت‌ها', icon: 'ph-fill ph-stack', tint: 'var(--mv-teal)' },
        { id: 'settings', label: 'تنظیمات اسکن', icon: 'ph-fill ph-sliders-horizontal', tint: 'var(--mv-gray)' },
        { id: 'history', label: 'تاریخچه', icon: 'ph-fill ph-clock-counter-clockwise', tint: 'var(--mv-orange)' },
    ];
    const SEC_TITLE = { scan: 'اسکن', sources: 'منابع و پورت‌ها', settings: 'تنظیمات اسکن', history: 'تاریخچه' };

    // The ids and the values are the contract with getSelectedCdns() (components/scanner-sidebar.js)
    // and loadTabSettings() (app.js) — both address these checkboxes by id. Only the drawing changed.
    const CDNS = [
        { id: 'chk-cf', label: 'کلودفلر', note: 'رایج‌ترین منبع؛ اگر نمی‌دانید، همین کافی است' },
        { id: 'chk-ak', label: 'آکامای' },
        { id: 'chk-fl', label: 'فستلی' },
        { id: 'chk-aws', label: 'کلودفرانت' },
        { id: 'chk-goog', label: 'گوگل CDN' },
        { id: 'chk-az', label: 'آژور' },
        { id: 'chk-gc', label: 'Gcore' },
        { id: 'chk-warp-main', label: 'WARP اصلی' },
        { id: 'chk-warp-alt', label: 'WARP جایگزین' },
        { id: 'chk-warp-ipv6', label: 'WARP طلایی IPv6' },
    ];
    const PORTS = [443, 80, 8080, 8443, 53, 2053, 2083, 2087, 2096, 8880];

    // ── Page state (drawing only — the scan itself lives in app.js › tabs) ──
    const ui = {
        sec: 'scan',
        /** Set while startScan is fetching the IP list, so stage 1 can show as active. */
        fetching: false,
        built: false,
    };

    // ── The page's own styles ──────────────────────────────────────────────
    //
    // Everything structural comes from page-kit.css. What is here is only what the kit has no
    // component for: the results scroller, the port chips, and the sidebar's scan rows.
    const CSS = `
<style id="sc-css">
  /* #scan-root is a flex child of #editor-area, which is the window body's child. The page has
     to claim the whole of it in both layouts — no z-index, no transform: a window-body child
     that carries its own stacking context covers the window's transparent drag bar. */
  .sc-wrap { height:100%; min-height:0; flex:1; min-width:0; }

  /* Hiding inside a kit page: .hidden / [hidden] is (0,1,0) and loses to the kit's own
     display rules, so every page that needs it re-declares it scoped to its own root. */
  .sc-wrap [hidden] { display:none !important; }

  /* THE HOME SECTION FILLS THE PANE AND ONLY THE ROWS SCROLL.
     A scan can produce thousands of rows. Letting the pane scroll would push the button that
     stops the scan off the top of the window. */
  .sc-wrap .mv-pane-scroll:has(> .mv-eng-sec[data-sec="scan"].is-on) {
    display:flex; flex-direction:column; overflow:hidden; padding-bottom:0;
  }
  .sc-wrap .mv-eng-sec[data-sec="scan"].is-on {
    display:flex; flex-direction:column; flex:1; min-height:0; gap:0;
  }
  .sc-wrap .sc-results {
    flex:1; min-height:140px; overflow:auto;
    margin:0 0 14px; border-radius:12px;
    background:var(--mv-group);
    box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge);
  }
  /* FIXED LAYOUT, NOT AUTO.
     The body is replaced wholesale once a second while a scan runs. With the kit table's auto
     layout every column re-measures on every one of those writes, so the columns visibly jitter
     as rows arrive. Fixed layout also removes the measuring cost. */
  .sc-wrap .sc-results .mv-table { font-size:12px; table-layout:fixed; }
  .sc-wrap .sc-results thead th {
    position:sticky; top:0; z-index:1;
    background:var(--mv-group);
    box-shadow:0 var(--mv-hl) 0 0 var(--mv-sep);
  }
  .sc-wrap .sc-results td, .sc-wrap .sc-results th { padding:7px 12px; }
  .sc-wrap .sc-n { width:52px; text-align:center; color:var(--mv-label-3);
    font-family:var(--mv-font-tech); font-variant-numeric:tabular-nums; }
  .sc-wrap .sc-act { width:38px; text-align:center; }
  .sc-wrap .sc-row-copy {
    border:0; background:transparent; cursor:pointer; padding:2px 4px; line-height:1;
    color:var(--mv-label-3); opacity:0; transition:opacity var(--mv-d-1) var(--mv-ease-out);
  }
  .sc-wrap .mv-table tbody tr:hover .sc-row-copy { opacity:1; }
  .sc-wrap .sc-row-copy:hover { color:var(--mv-accent); }
  .sc-wrap .sc-row-copy:focus-visible { opacity:1; outline:2px solid var(--mv-accent); border-radius:5px; }
  .sc-wrap .sc-none { text-align:center; padding:38px 16px; color:var(--mv-label-3); }
  .sc-wrap .sc-more { text-align:center; padding:6px 0; color:var(--mv-label-3); font-size:11px; }
  .sc-wrap .sc-ok { color:var(--mv-green-ink); font-weight:650; }
  .sc-wrap .sc-mid { color:var(--mv-orange-ink); }
  .sc-wrap .sc-low { color:var(--mv-blue-ink); }
  .sc-wrap .sc-bad { color:var(--mv-red-ink); }
  .sc-wrap .sc-dim { color:var(--mv-label-3); }

  /* Four figures need more room than the engine pages' one chart: at the kit's 210px the labels
     elided to «تست ...» and «بهتر...», which is worse than no label. */
  .sc-wrap .mv-eng-stage-side { flex:0 1 330px; }
  .sc-wrap .mv-eng-stat { padding:0 8px; }

  /* A figure with a unit is one left-to-right run. Left to the page's RTL it came out «ms ۱۸۰». */
  .sc-wrap .sc-fig { direction:ltr; unicode-bidi:isolate; }

  /* The sidebar holds two different kinds of thing, so they cannot both be the accent fill: the
     section you are on is the page's primary state, the scan you are on is a document. */
  .sc-wrap .sc-tab.active {
    background:var(--mv-fill); color:var(--mv-label); font-weight:650;
    box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-sep);
  }

  /* The live network line under the headline (startScan writes straight into these ids). */
  .sc-wrap .sc-net { display:none; align-items:center; gap:14px; margin-top:12px;
    font-size:11.5px; color:var(--mv-label-2); }
  .sc-wrap .sc-net b { font-weight:650; color:var(--mv-label); font-family:var(--mv-font-tech); }

  /* Port chips — ten switch rows would be a wall; a port is a tag, not a preference. */
  .sc-wrap .sc-chips { display:flex; flex-wrap:wrap; gap:7px; width:100%; }
  .sc-wrap .sc-chip { position:relative; cursor:pointer; }
  .sc-wrap .sc-chip input { position:absolute; inset:0; opacity:0; margin:0; cursor:pointer; }
  .sc-wrap .sc-chip span {
    display:inline-flex; align-items:center; justify-content:center; min-width:52px; height:28px;
    padding:0 10px; border-radius:999px; font-size:12px; font-weight:600;
    font-family:var(--mv-font-tech); font-variant-numeric:tabular-nums;
    color:var(--mv-label-2); background:var(--mv-fill);
    box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-sep);
    transition:background var(--mv-d-1) var(--mv-ease-out), color var(--mv-d-1) var(--mv-ease-out);
  }
  /* tokenize:off — white on the accent fill is the fixed pair, the same one .mv-side-item.active
     and .mv-table tr.is-selected use: in macOS a chosen thing is the accent with white on it. */
  .sc-wrap .sc-chip input:checked + span {
    color:#FFFFFF; background:var(--mv-accent); box-shadow:none;
  }
  /* tokenize:on */
  .sc-wrap .sc-chip input:focus-visible + span { outline:2px solid var(--mv-accent); outline-offset:2px; }

  /* A scan in the sidebar. It is a row with its own close control, so it cannot be a <button>. */
  .sc-wrap .sc-tab { position:relative; }
  .sc-wrap .sc-tab > span:nth-child(2) { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .sc-wrap .sc-tab-x {
    flex:none; border:0; background:transparent; cursor:pointer; padding:2px; line-height:1;
    border-radius:5px; color:inherit; opacity:0; font-size:11px;
    transition:opacity var(--mv-d-1) var(--mv-ease-out);
  }
  .sc-wrap .sc-tab:hover .sc-tab-x, .sc-wrap .sc-tab-x:focus-visible { opacity:.75; }
  .sc-wrap .sc-tab-x:hover { opacity:1; background:var(--mv-fill-2); }

  .sc-wrap .sc-ta {
    width:100%; min-height:120px; resize:vertical; margin:0;
    border-radius:8px; padding:9px 11px; font-size:11.5px; line-height:1.8;
    direction:ltr; text-align:left;
    font-family:var(--mv-font-mono); color:var(--mv-label);
    background:var(--mv-field); border:var(--mv-hl) solid var(--mv-sep);
  }
  .sc-wrap .sc-ta:focus { outline:none; border-color:var(--mv-accent); }
  .sc-wrap .sc-ta--sm { min-height:64px; }

  /* A drawn ring, not a rotating glyph — a glyph's optical centre is not its box centre. */
  @keyframes sc-spin { to { transform:rotate(360deg); } }
  .sc-wrap .sc-spin { display:inline-flex; align-items:center; justify-content:center; line-height:1; }
  /* A drawn ring, never a glyph with a ring on top — see the note in components/assistant.js. */
  .sc-wrap .sc-spin::before {
    content:'' !important; display:block; box-sizing:border-box; width:.8em; height:.8em;
    border:.14em solid currentColor; border-top-color:transparent; border-radius:50%;
    animation:sc-spin .8s linear infinite;
  }
  html[data-motion="reduced"] .sc-wrap .sc-spin::before { animation:none; }

  .sc-wrap .sc-note { color:var(--mv-label-3); }
</style>`;

    // ── The markup ─────────────────────────────────────────────────────────

    function sideItems() {
        return SECTIONS.map(s => `
        <button type="button" class="mv-side-item" data-sec="${s.id}">
          <span class="mv-side-tile" style="--tint:${s.tint}"><i class="${s.icon}"></i></span><span>${esc(s.label)}</span>
        </button>`).join('');
    }

    function cdnRows() {
        return CDNS.map(c => `
          <div class="mv-form-row">
            <span class="mv-form-label">${esc(c.label)}${c.note ? `<small>${esc(c.note)}</small>` : ''}</span>
            <span class="mv-form-control"><input type="checkbox" class="mv-switch-input" id="${c.id}" data-sc-save="1"></span>
          </div>`).join('');
    }

    function portChips() {
        return PORTS.map(p => `
            <label class="sc-chip"><input type="checkbox" class="port-chk" value="${p}" data-sc-save="1"><span>${p}</span></label>`).join('');
    }

    function template() {
        return CSS + `
<div id="scan-wrap" dir="rtl" class="sc-wrap mv-split">
  <!-- id kept: toggleSidebar() (index.html), the menu bar's «تنظیمات اسکن» checkmark and the
       legacy activity rail all read exactly this element's style.display. .mv-side is
       display:flex, so the old two values still mean the same thing. -->
  <aside class="mv-side" id="scan-sidebar" aria-label="بخش‌های اسکنر">
    <div class="mv-side-top"></div>
    <nav class="mv-side-list custom-scrollbar">
      <div class="mv-side-group">
        <div class="mv-side-head">اسکن‌ها</div>
        <div id="scan-tabs"></div>
        <button type="button" class="mv-side-item" id="scan-new" title="یک اسکن تازه با تنظیمات پیش‌فرض">
          <span class="mv-side-tile" style="--tint:var(--mv-green)"><i class="ph-bold ph-plus"></i></span><span>اسکن تازه</span>
        </button>
      </div>
      <div class="mv-side-group">
        <div class="mv-side-head">بخش‌ها</div>
        ${sideItems()}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="scan-go-archive" title="آی‌پی‌های سالمِ همهٔ اسکن‌ها">
          <span class="mv-side-tile" style="--tint:var(--mv-indigo)"><i class="ph-fill ph-archive"></i></span>
          <span>آرشیو آی‌پی</span><i class="ph-bold ph-arrow-up-left" aria-hidden="true"></i>
        </button>
        <button type="button" class="mv-side-item mv-side-go" id="scan-go-combo" title="ساختن کانفیگ از آی‌پی‌های پیداشده">
          <span class="mv-side-tile" style="--tint:var(--mv-purple)"><i class="ph-fill ph-puzzle-piece"></i></span>
          <span>مرکز ترکیب</span><i class="ph-bold ph-arrow-up-left" aria-hidden="true"></i>
        </button>
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="scan-back" aria-label="برگشت به اسکن" title="برگشت به اسکن" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="scan-title">اسکن</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar">

      <!-- ── اسکن (home) ── -->
      <div class="mv-eng-sec is-on" data-sec="scan">
        <div class="mv-eng-stage" id="scan-stage" style="--tint:var(--mv-blue)"></div>
        <!-- The run itself: one line, right under the button that starts it. -->
        <div class="mv-eng-flow" id="scan-flow" hidden><div class="mv-steps" id="scan-steps"></div></div>

        <div class="mv-toolbar">
          <!-- «اسکن مجدد» belongs beside the results, not in the pane bar: the home section hides
               that bar (is-home), so an action left there could never be reached from here. -->
          <div class="mv-tb-group" role="group" aria-label="اسکن">
            <button type="button" class="mv-tb-btn" id="btn-top-restart" data-act="restart" title="اسکن دوباره از ابتدا — نتایج فعلی پاک می‌شود" aria-label="اسکن دوباره از ابتدا"><i class="ph-bold ph-arrow-counter-clockwise"></i></button>
          </div>
          <div class="mv-tb-group" role="group" aria-label="نتایج">
            <button type="button" class="mv-tb-btn" data-act="copy" title="کپی همهٔ آی‌پی‌های سالم" aria-label="کپی همهٔ آی‌پی‌های سالم"><i class="ph-bold ph-copy"></i></button>
            <button type="button" class="mv-tb-btn" data-act="export" title="خروجی گرفتن (TXT / CSV / JSON)" aria-label="خروجی گرفتن"><i class="ph-bold ph-download-simple"></i></button>
            <button type="button" class="mv-tb-btn" data-act="save" title="ذخیرهٔ این اسکن در تاریخچه" aria-label="ذخیره در تاریخچه"><i class="ph-bold ph-floppy-disk"></i></button>
          </div>
          <div class="mv-tb-group" role="group" aria-label="بردن نتایج جای دیگر">
            <button type="button" class="mv-tb-btn" data-act="archive" title="آرشیو آی‌پی تمیز" aria-label="آرشیو آی‌پی تمیز"><i class="ph-bold ph-archive"></i></button>
            <button type="button" class="mv-tb-btn" data-act="combo" title="مرکز ترکیب" aria-label="مرکز ترکیب"><i class="ph-bold ph-puzzle-piece"></i></button>
          </div>
        </div>

        <div class="sc-results custom-scrollbar">
          <table class="mv-table">
            <colgroup><col style="width:52px"><col><col style="width:88px"><col style="width:116px"><col style="width:132px"><col style="width:38px"></colgroup>
            <thead>
              <tr>
                <th class="sc-n">#</th>
                <th class="is-sortable" data-sort="ip">آدرس آی‌پی</th>
                <th class="is-num is-sortable" data-sort="port">پورت</th>
                <th class="is-num is-sortable" data-sort="tcp">پینگ TCP</th>
                <th class="is-num is-sortable" data-sort="realDelay">تأخیر واقعی</th>
                <th class="sc-act"></th>
              </tr>
            </thead>
            <tbody id="results-body"></tbody>
          </table>
        </div>
      </div>

      <!-- ── منابع و پورت‌ها ── -->
      <div class="mv-eng-sec" data-sec="sources">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="mv-form-header">ارائه‌دهندگان آی‌پی</div>
            <div class="mv-form-group">
              ${cdnRows()}
              <div class="mv-form-row">
                <span class="mv-form-label">هیچ منبعی<small>فقط از فهرست دستی پایین استفاده کن</small></span>
                <span class="mv-form-control"><input type="checkbox" class="mv-switch-input" id="chk-none" data-sc-save="1"></span>
              </div>
            </div>
            <div class="mv-form-footer">رِنج آی‌پی‌های عمومی هر شبکه. هرچه بیشتر انتخاب کنید اسکن طولانی‌تر می‌شود، نه لزوماً بهتر.</div>
          </div>

          <div class="mv-form-section">
            <div class="mv-form-header">پورت‌های هدف</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack"><div class="sc-chips">${portChips()}</div></div>
            </div>
            <div class="mv-form-footer">هر آی‌پی روی هر پورت انتخاب‌شده یک‌بار تست می‌شود؛ دو پورت یعنی دو برابر زمان. <b>۴۴۳</b> پورتی است که تقریباً همیشه جواب می‌دهد.</div>
          </div>

          <div class="mv-form-section is-wide">
            <div class="mv-form-header">فهرست آی‌پی</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack">
                <textarea id="ip-textarea" class="sc-ta custom-scrollbar" dir="ltr" spellcheck="false" placeholder="# اینجا خالی بماند، خودِ برنامه فهرست را از منابع بالا می‌سازد"></textarea>
              </div>
              <div class="mv-form-row">
                <span class="mv-form-label">ساختن فهرست<small>لازم نیست — «شروع اسکن» خودش این کار را می‌کند</small></span>
                <span class="mv-form-control">
                  <button type="button" class="mv-btn" data-act="upload"><i class="ph-bold ph-file-arrow-up"></i> بارگذاری فایل</button>
                  <button type="button" class="mv-btn" id="btn-fetch"><i class="ph-bold ph-download-simple"></i> دریافت</button>
                  <input type="file" id="file-upload" accept=".txt,.csv,.list" hidden>
                </span>
              </div>
            </div>
            <div class="mv-form-footer">اگر آی‌پی یا رِنج خودتان را دارید اینجا بگذارید (هر خط یکی)؛ آن‌وقت منابع بالا نادیده گرفته می‌شوند.</div>
          </div>
        </div>
      </div>

      <!-- ── تنظیمات اسکن ── -->
      <div class="mv-eng-sec" data-sec="settings">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="mv-form-header">سرعت و حجم</div>
            <div class="mv-form-group">
              <div class="mv-form-row">
                <span class="mv-form-label">هم‌زمانی<small>چند آی‌پی با هم — بالاتر یعنی سریع‌تر و پرمصرف‌تر</small></span>
                <span class="mv-form-control"><input type="number" id="param-conc" class="mv-field mv-field--compact" dir="ltr" min="1" max="500" value="50" data-sc-save="1"></span>
              </div>
              <div class="mv-form-row">
                <span class="mv-form-label">تایم‌اوت<small>تا چند میلی‌ثانیه منتظر جواب بماند</small></span>
                <span class="mv-form-control"><input type="number" id="param-tout" class="mv-field mv-field--compact" dir="ltr" min="500" max="30000" step="500" value="5000" data-sc-save="1"><span class="sc-note">ms</span></span>
              </div>
              <div class="mv-form-row">
                <span class="mv-form-label">حداکثر آی‌پی</span>
                <span class="mv-form-control"><input type="number" id="param-max" class="mv-field mv-field--compact" dir="ltr" min="10" value="400" data-sc-save="1"></span>
              </div>
              <div class="mv-form-row is-sub">
                <span class="mv-form-label">تا پیدا شود ادامه بده<small>سقف را بردار و همهٔ آی‌پی‌های منبع را بگرد</small></span>
                <span class="mv-form-control"><input type="checkbox" class="mv-switch-input" id="chk-scan-all" data-sc-save="1"></span>
              </div>
              <div class="mv-form-row">
                <span class="mv-form-label">تعداد تست نهایی<small>از میان بهترین‌ها، چندتا با کانفیگ شما تست شوند</small></span>
                <span class="mv-form-control"><input type="number" id="param-final-count" class="mv-field mv-field--compact" dir="ltr" min="1" max="500" value="50" data-sc-save="1"></span>
              </div>
            </div>
            <div class="mv-form-footer">این تنظیم‌ها مال همین اسکن است؛ هر اسکن در نوار کناری مال خودش را دارد.</div>
          </div>

          <div class="mv-form-section">
            <div class="mv-form-header">این اسکن</div>
            <div class="mv-form-group">
              <div class="mv-form-row">
                <span class="mv-form-label">نام<small>اپراتور یا هر اسمی که خودتان بشناسید</small></span>
                <span class="mv-form-control"><input type="text" id="param-isp" class="mv-field" placeholder="ایرانسل" data-sc-save="1"></span>
              </div>
              <div class="mv-form-row" id="auto-save-container">
                <span class="mv-form-label">ذخیرهٔ خودکار<small>حین اسکن، هرچه پیدا شده در تاریخچه می‌ماند</small></span>
                <span class="mv-form-control"><input type="checkbox" class="mv-switch-input" id="scan-autosave"></span>
              </div>
            </div>
            <div class="mv-form-footer">فاصلهٔ ذخیرهٔ خودکار در «تنظیمات › اسکن» تعیین می‌شود.</div>
          </div>

          <div class="mv-form-section is-wide">
            <div class="mv-form-header">کانفیگ پایه برای تست قطعی</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack">
                <textarea id="v2ray-configs-input" class="sc-ta sc-ta--sm custom-scrollbar" dir="ltr" spellcheck="false" rows="2" placeholder="vless://...  یا  trojan://..."></textarea>
              </div>
            </div>
            <div class="mv-form-footer">مرحلهٔ آخر اسکن، آی‌پی‌های برتر را <b>با همین کانفیگ</b> امتحان می‌کند و تأخیر واقعی را می‌سنجد. خالی بگذارید و آن مرحله رد می‌شود — آن‌وقت فقط پینگ TCP دارید، نه اینکه واقعاً از فیلتر رد می‌شود یا نه.</div>
          </div>
        </div>
      </div>

      <!-- ── تاریخچه ── -->
      <div class="mv-eng-sec" data-sec="history">
        <div class="mv-toolbar">
          <div class="mv-tb-group" role="group" aria-label="تاریخچه">
            <button type="button" class="mv-tb-btn" data-act="save" title="ذخیرهٔ اسکن فعلی" aria-label="ذخیرهٔ اسکن فعلی"><i class="ph-bold ph-floppy-disk"></i></button>
            <button type="button" class="mv-tb-btn" data-act="clear-history" title="پاک کردن کل تاریخچه" aria-label="پاک کردن کل تاریخچه"><i class="ph-bold ph-trash"></i></button>
          </div>
        </div>
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">اسکن‌های ذخیره‌شده</div>
            <div class="mv-form-group"><div class="mv-list" id="history-list"></div></div>
            <div class="mv-form-footer"><span id="history-count-text">۰ مورد ذخیره شده</span> — حداکثر ۲۰ مورد نگه داشته می‌شود. روی هر کدام بزنید تا به‌صورت یک اسکن تازه باز شود.</div>
          </div>
        </div>
      </div>

    </div>

    <div class="mv-eng-foot" id="scan-foot"></div>
  </section>
</div>`;
    }

    // ── One place that decides what the page says ──────────────────────────
    //
    // The headline, the sidebar dot, the ring and the bottom strip all read this, so the page can
    // never say «در حال اسکن» in one corner and «آماده» in another.

    function aliveRows(tab) {
        if (!tab || !tab.results) return [];
        return tab.results.filter(r => r.alive || (r.tcp && r.tcp.latency > 0) || r.realDelay > 0);
    }

    /** «۴ منبع · پورت ۴۴۳ و ۸۰ · سقف ۴۰۰» — what this scan is about to do. */
    function contextLine(tab) {
        if (!tab) return '';
        const s = tab.settings || {};
        const bits = [];
        const custom = (s.customInput || '').trim();
        if (custom) bits.push('فهرست دستی');
        else bits.push(`${fa((s.cdns || []).length)} منبع`);
        const ports = s.ports || [];
        if (ports.length) bits.push('پورت ' + ports.slice(0, 3).map(fa).join('، ') + (ports.length > 3 ? ` و ${fa(ports.length - 3)} تای دیگر` : ''));
        if (s.maxIps && s.maxIps < 1000000) bits.push(`سقف ${fa(s.maxIps)} آی‌پی`);
        else bits.push('بدون سقف');
        return bits.join(' · ');
    }

    function vState() {
        const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
        if (!tab) return { tone: '', word: 'اسکنی باز نیست', head: 'آمادهٔ اسکن', line: 'از نوار کناری یک اسکن تازه بسازید.' };

        // An auto-generated name («اسکن ۲») is not a name: pasting it into the headline produced
        // «آمادهٔ اسکن اسکن ۲». Only a name the user chose is worth saying twice.
        const raw = (tab.isp || '').trim();
        const name = /^اسکن[\s‌]*[0-9۰-۹]*$/.test(raw) ? '' : raw;
        if (ui.fetching) {
            return { tone: 'busy', word: 'آماده‌سازی', head: 'ساختن فهرست آی‌پی', line: 'رِنج‌های منابع انتخاب‌شده گرفته می‌شود…' };
        }
        if (tab.state === 'running') {
            if (tab.stage3Total) {
                return {
                    tone: 'busy', word: 'تست قطعی',
                    head: 'تست قطعی با کانفیگ شما',
                    line: `از ${fa(tab.stage3Total)} آی‌پی برتر، ${fa(tab.stage3Tested || 0)} تا امتحان شد. <b>برای توقف دوباره همین دکمه را بزنید.</b>`,
                };
            }
            return {
                tone: 'busy', word: 'در حال اسکن',
                head: name ? `در حال اسکن ${esc(name)}` : 'در حال اسکن',
                line: `${esc(contextLine(tab))} — <b>برای توقف دوباره همین دکمه را بزنید.</b>`,
            };
        }
        if (tab.state === 'paused') {
            return {
                tone: 'bad', word: 'متوقف — قطعی اینترنت',
                head: 'اینترنت قطع شد، اسکن نگه داشته شد',
                line: 'به‌محض برگشتن خط، از همان‌جا خودش ادامه می‌دهد. چیزی از دست نرفته.',
            };
        }
        const found = aliveRows(tab).length;
        if (tab.state === 'done' || tab.state === 'stopped') {
            if (found) {
                return {
                    tone: 'on', word: 'تمام شد',
                    head: `${fa(found)} آی‌پی سالم پیدا شد`,
                    line: 'از جدول پایین کپی بگیرید، یا با «مرکز ترکیب» کانفیگ بسازید.',
                };
            }
            return {
                tone: '', word: 'تمام شد — بدون نتیجه',
                head: 'چیزی پیدا نشد',
                line: 'منبع یا پورت دیگری امتحان کنید، یا سقف آی‌پی را بالاتر ببرید.',
            };
        }
        return {
            tone: found ? 'on' : '', word: 'آماده',
            head: name ? `آمادهٔ اسکن ${esc(name)}` : 'آمادهٔ اسکن',
            line: esc(contextLine(tab)),
        };
    }

    // ── The hero ───────────────────────────────────────────────────────────

    function renderStage() {
        const host = $('scan-stage');
        if (!host) return;
        const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
        const v = vState();
        const busy = v.tone === 'busy';

        // BUILT ONCE, THEN PATCHED. Replacing a node restarts its CSS animation from zero, and this
        // one repaints on every socket batch — the ring would stutter several times a second.
        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
        <div class="sc-net" id="network-isp-wrap">
          <span>شبکه: <b id="isp-status">—</b></span>
          <span>اپراتور: <b id="isp-name">—</b></span>
          <span>موقعیت: <b id="isp-loc">—</b></span>
        </div>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" id="btn-top-scan" data-act="toggle" title="شروع اسکن آی‌پی‌ها در تب فعلی">
          <i class="ph-fill ph-play" id="icon-top-play"></i>
          <i class="ph-fill ph-stop" id="icon-top-stop" style="display:none"></i>
        </button>
      </div>
      <div class="mv-eng-stage-side">
        <div class="mv-eng-stats">
          <div class="mv-eng-stat"><div class="mv-eng-stat-k">تست شده</div><div class="mv-eng-stat-v" id="stat-tested">۰</div></div>
          <div class="mv-eng-stat"><div class="mv-eng-stat-k">پورت باز</div><div class="mv-eng-stat-v" id="stat-alive">۰</div></div>
          <div class="mv-eng-stat"><div class="mv-eng-stat-k">مسدود</div><div class="mv-eng-stat-v" id="stat-dead">۰</div></div>
          <div class="mv-eng-stat"><div class="mv-eng-stat-k">بهترین</div><div class="mv-eng-stat-v is-quiet" id="stat-ttfb">—</div></div>
        </div>
      </div>`;
            host.dataset.built = '1';
            wire(host);
        }

        const part = (n) => host.querySelector(`[data-part="${n}"]`);
        part('head').innerHTML = v.head;
        part('line').innerHTML = v.line;

        const btn = $('btn-top-scan');
        if (btn) {
            const want = 'mv-eng-power' + (v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : '');
            if (btn.className !== want) btn.className = want;
            btn.disabled = !tab;
            const label = busy ? 'توقف اسکن' : (tab && tab.state === 'paused') ? 'ادامهٔ اسکن' : 'شروع اسکن';
            btn.setAttribute('aria-label', label);
        }
        const play = $('icon-top-play'), stop = $('icon-top-stop');
        if (play) play.style.display = busy ? 'none' : '';
        if (stop) stop.style.display = busy ? '' : 'none';
    }

    // ── The four stages, as steps ──────────────────────────────────────────

    function step(cls, icon, label, note, spin) {
        return `
      <div class="mv-step ${cls}">
        <i class="${spin ? 'sc-spin' : 'ph-bold ' + icon}"></i>
        <span>${esc(label)}${note ? ` <small class="sc-note">— ${esc(note)}</small>` : ''}</span>
      </div>`;
    }

    function renderSteps() {
        const flow = $('scan-flow'), host = $('scan-steps');
        if (!flow || !host) return;
        const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
        const live = !!tab && (ui.fetching || tab.state === 'running' || tab.state === 'paused' ||
            ((tab.state === 'done' || tab.state === 'stopped') && tab.tested > 0));
        flow.hidden = !live;
        if (!live) { host.innerHTML = ''; return; }

        // Where the run is. The server announces stage 2 and 3 over the socket; scanner-sidebar.js
        // records them on the tab (`status`, `stage3Total`), so the phase is readable from the tab.
        const done = tab.state === 'done' || tab.state === 'stopped';
        const sorting = tab.status === 'مرتب‌سازی' && tab.state === 'running';
        const finalTest = !!tab.stage3Total;
        const scanning = tab.state === 'running' && !sorting && !finalTest;

        const rows = [];

        rows.push(ui.fetching
            ? step('is-active', 'ph-circle-notch', 'آماده‌سازی فهرست', 'رِنج‌ها از منابع گرفته می‌شود', true)
            : step('is-done', 'ph-check', 'آماده‌سازی فهرست', tab.total ? `${fa(tab.total)} ترکیب آی‌پی×پورت` : '', false));

        if (!ui.fetching) {
            rows.push(scanning
                ? step('is-active', 'ph-circle-notch', 'اسکن پورت‌ها', `${fa(tab.tested || 0)} از ${fa(tab.total || 0)}`, true)
                : (tab.tested > 0 || sorting || finalTest || done)
                    ? step('is-done', 'ph-check', 'اسکن پورت‌ها', `${fa(tab.alive || 0)} پورت باز`, false)
                    : step('', 'ph-circle', 'اسکن پورت‌ها', '', false));

            rows.push(sorting
                ? step('is-active', 'ph-circle-notch', 'انتخاب برترین‌ها', 'مرتب‌سازی بر اساس پینگ', true)
                : (finalTest || done) ? step('is-done', 'ph-check', 'انتخاب برترین‌ها', '', false)
                    : step('', 'ph-circle', 'انتخاب برترین‌ها', '', false));

            const hasBase = !!(($('v2ray-configs-input') || {}).value || '').trim();
            rows.push(finalTest && tab.state === 'running'
                ? step('is-active', 'ph-circle-notch', 'تست قطعی با کانفیگ', `${fa(tab.stage3Tested || 0)} از ${fa(tab.stage3Total)}`, true)
                : finalTest
                    ? step('is-done', 'ph-check', 'تست قطعی با کانفیگ', '', false)
                    : done && !hasBase
                        ? step('', 'ph-minus-circle', 'تست قطعی با کانفیگ', 'رد شد — کانفیگ پایه‌ای داده نشده بود', false)
                        : step('', 'ph-circle', 'تست قطعی با کانفیگ', '', false));
        }

        if (tab.state === 'paused') {
            rows.push(step('is-failed', 'ph-wifi-slash', 'قطعی اینترنت', 'به‌محض وصل شدن ادامه می‌دهد', false));
        }

        host.innerHTML = rows.join('');
    }

    // ── The bottom strip and the pane-bar action ───────────────────────────

    function renderFoot() {
        const host = $('scan-foot');
        if (!host) return;
        const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
        const v = vState();
        const dot = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : '';
        let side = '';
        if (tab && tab.total) {
            const found = aliveRows(tab).length;
            side = `${fa(tab.tested || 0)} از ${fa(tab.total)}` + (found ? ` · ${fa(found)} سالم` : '');
        }
        host.innerHTML = `<i class="mv-eng-dot${dot}"></i><span>${esc(v.word)}</span>` +
            (side ? `<span class="mv-eng-foot-end" dir="rtl">${esc(side)}</span>` : '');
    }

    /**
     * The results band.
     *
     * ONLY THE BUTTONS THAT ACT ON THIS SCAN'S ROWS ARE DIMMED. The first version dimmed the
     * whole band, آرشیو and مرکز ترکیب included — and those two open their own windows with
     * their own data, so on a freshly opened app every icon was grey and the band read as
     * broken. A control is disabled only when it genuinely has nothing to do.
     */
    const NEEDS_ROWS = { copy: 1, export: 1, save: 1 };

    function renderToolbar() {
        const wrap = $('scan-wrap');
        if (!wrap) return;
        const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
        const has = aliveRows(tab).length > 0;
        wrap.querySelectorAll('.mv-eng-sec[data-sec="scan"] .mv-tb-btn').forEach(b => {
            const act = b.getAttribute('data-act');
            if (act === 'restart') {
                // Nothing to redo until a run has produced something and stopped.
                b.disabled = !(tab && tab.tested > 0 && tab.state !== 'running');
                b.title = b.disabled ? 'اسکن دوباره از ابتدا — هنوز اسکنی انجام نشده' : 'اسکن دوباره از ابتدا — نتایج فعلی پاک می‌شود';
            } else if (NEEDS_ROWS[act]) {
                b.disabled = !has;
                if (b.disabled) b.title = BASE_TIP[act] + ' — هنوز نتیجه‌ای نیست';
                else b.title = BASE_TIP[act];
            }
            // archive / combo are never disabled: they are other windows, not this scan's rows.
            if (b.hasAttribute('data-tooltip')) b.setAttribute('data-tooltip', b.title);
        });
    }

    const BASE_TIP = {
        copy: 'کپی همهٔ آی‌پی‌های سالم',
        export: 'خروجی گرفتن (TXT / CSV / JSON)',
        save: 'ذخیرهٔ این اسکن در تاریخچه',
    };

    // ── The scans, in the sidebar ──────────────────────────────────────────

    function renderSideTabs() {
        const host = $('scan-tabs');
        if (!host || typeof tabs === 'undefined') return;
        const list = tabs.filter(t => t && t.id !== 'settings' && !t.type);
        host.innerHTML = list.map(t => {
            const on = t.id === activeTabId;
            const running = t.state === 'running';
            const tint = running ? 'var(--mv-orange)' : t.state === 'paused' ? 'var(--mv-red)'
                : t.state === 'done' || t.state === 'stopped' ? 'var(--mv-green)' : 'var(--mv-blue)';
            const icon = running ? 'sc-spin'
                : t.state === 'paused' ? 'ph-fill ph-warning'
                    : (t.state === 'done' || t.state === 'stopped') ? 'ph-fill ph-check'
                        : 'ph-fill ph-crosshair';
            return `
        <div class="mv-side-item sc-tab${on ? ' active' : ''}" role="button" tabindex="0"
             data-tab="${esc(String(t.id))}" title="${esc(t.isp || '')}">
          <span class="mv-side-tile" style="--tint:${tint}"><i class="${icon}"></i></span>
          <span>${esc(t.isp || 'اسکن')}</span>
          <button type="button" class="sc-tab-x" data-close="${esc(String(t.id))}" title="بستن این اسکن" aria-label="بستن این اسکن"><i class="ph-bold ph-x"></i></button>
        </div>`;
        }).join('');
        wire(host);
    }

    // ── Section routing ────────────────────────────────────────────────────

    function scanGo(sec) {
        const wrap = $('scan-wrap');
        if (!wrap) return;
        ui.sec = SECTIONS.some(s => s.id === sec) ? sec : 'scan';
        wrap.querySelectorAll('.mv-eng-sec').forEach(n => n.classList.toggle('is-on', n.getAttribute('data-sec') === ui.sec));
        wrap.querySelectorAll('.mv-side-item[data-sec]').forEach(b => b.classList.toggle('active', b.getAttribute('data-sec') === ui.sec));
        // On the home section the bar carries nothing: a «برگشت» that goes where you already are,
        // over a title naming the page you are looking at. The 52px band itself stays — the
        // window's own drag bar lies over it.
        const pane = wrap.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', ui.sec === 'scan');
        const title = $('scan-title');
        if (title) title.textContent = SEC_TITLE[ui.sec] || '';
        const back = $('scan-back');
        if (back) back.disabled = ui.sec === 'scan';
        const scroll = wrap.querySelector('.mv-pane-scroll');
        if (scroll) scroll.scrollTop = 0;
        if (ui.sec === 'history' && typeof window.renderHistoryList === 'function') window.renderHistoryList();
        paint();
    }

    function paint() {
        renderStage(); renderSteps(); renderFoot(); renderToolbar();
    }

    // ── The results table ──────────────────────────────────────────────────

    function sortResults(results, col, asc) {
        return [...results].sort((a, b) => {
            let va, vb;
            if (col === 'ip') {
                // Sort an address the way a person reads it: by octet, not as text.
                const n = (ip) => String(ip || '').split('.').reduce((acc, p) => acc * 256 + (+p || 0), 0);
                va = n(a.ip); vb = n(b.ip);
            }
            else if (col === 'port') { va = a.port; vb = b.port; }
            else if (col === 'tcp') { va = a.tcp?.latency || 9999; vb = b.tcp?.latency || 9999; }
            else if (col === 'http.latency') { va = a.http?.latency || 9999; vb = b.http?.latency || 9999; }
            else if (col === 'http.speed') { va = a.http?.speed || 0; vb = b.http?.speed || 0; }
            else if (col === 'realDelay') { va = a.realDelay > 0 ? a.realDelay : 9999; vb = b.realDelay > 0 ? b.realDelay : 9999; }
            else { va = 0; vb = 0; }
            return asc ? (va - vb) : (vb - va);
        });
    }

    function renderResults(tab) {
        const tbody = $('results-body');
        if (!tbody) return;
        if (!tab) { tbody.innerHTML = `<tr><td colspan="6" class="sc-none">اسکنی باز نیست.</td></tr>`; return; }

        const alives = aliveRows(tab);
        if (!alives.length) {
            const msg = ui.fetching ? 'در حال ساختن فهرست…'
                : tab.state === 'running' ? 'در حال اسکن…'
                    : (tab.state === 'done' || tab.state === 'stopped') ? 'آی‌پی سالمی یافت نشد.'
                        : 'دکمهٔ گرد بالا را بزنید تا اسکن شروع شود.';
            tbody.innerHTML = `<tr><td colspan="6" class="sc-none">${esc(msg)}</td></tr>`;
            return;
        }

        // While the scan runs nothing is sorted (it frees the CPU for the scan itself) and only the
        // newest 300 rows are drawn — the rest arrive when it finishes.
        const isLive = tab.state === 'running';
        const toRender = isLive ? alives : sortResults(alives, tab.sortCol, tab.sortAsc);
        const MAX_LIVE_ROWS = 300;
        const displayRows = isLive && toRender.length > MAX_LIVE_ROWS ? toRender.slice(toRender.length - MAX_LIVE_ROWS) : toRender;
        const hiddenCount = toRender.length - displayRows.length;

        let html = '';
        if (hiddenCount > 0) {
            html += `<tr><td colspan="6" class="sc-more">${fa(hiddenCount)} ردیف دیگر — پس از پایان اسکن نمایش داده می‌شود</td></tr>`;
        }

        for (let i = 0; i < displayRows.length; i++) {
            const r = displayRows[i];
            const tcp = r.tcp?.latency || 0;
            const tcpCls = tcp <= 0 ? 'sc-dim' : tcp <= 150 ? 'sc-low' : tcp <= 300 ? 'sc-ok' : 'sc-mid';
            const tcpTxt = tcp > 0 ? `<span class="sc-fig">${fa(tcp)} ms</span>` : '—';
            const rd = r.realDelay;
            const rdHtml = rd > 0 ? `<span class="sc-ok sc-fig">${fa(rd)} ms</span>`
                : rd === -1 ? '<span class="sc-bad">ناموفق</span>'
                    : '<span class="sc-dim">—</span>';
            html += `<tr>`
                + `<td class="sc-n">${fa(hiddenCount + i + 1)}</td>`
                + `<td class="is-ltr">${esc(r.ip)}</td>`
                + `<td class="is-num">${fa(r.port)}</td>`
                + `<td class="is-num ${tcpCls}">${tcpTxt}</td>`
                + `<td class="is-num">${rdHtml}</td>`
                + `<td class="sc-act"><button type="button" class="sc-row-copy" data-copy="${esc(r.ip)}" title="کپی این آی‌پی" aria-label="کپی این آی‌پی"><i class="ph-bold ph-copy"></i></button></td>`
                + `</tr>`;
        }
        tbody.innerHTML = html;
    }

    function updateStats(tab) {
        const set = (id, txt, quiet) => {
            const el = $(id);
            if (!el) return;
            el.textContent = txt;
            el.classList.toggle('is-quiet', !!quiet);
        };
        if (!tab) { set('stat-tested', '۰'); set('stat-alive', '۰'); set('stat-dead', '۰'); set('stat-ttfb', '—', true); return; }
        set('stat-tested', fa(tab.tested || 0));
        set('stat-alive', fa(tab.alive || 0), !tab.alive);
        set('stat-dead', fa(tab.dead || 0), !tab.dead);

        // The best ping we actually measured. Stage 1 is TCP only, so tcp.latency is the honest
        // figure here; realDelay (through the user's config) wins when it exists.
        const rows = aliveRows(tab);
        const nums = [];
        rows.forEach(r => {
            if (r.realDelay > 0) nums.push(r.realDelay);
            else if (r.tcp && r.tcp.latency > 0) nums.push(r.tcp.latency);
        });
        const best = $('stat-ttfb');
        if (best) {
            if (nums.length) { best.innerHTML = `<span class="sc-fig">${fa(Math.min.apply(null, nums))} ms</span>`; best.classList.remove('is-quiet'); }
            else { best.textContent = '—'; best.classList.add('is-quiet'); }
        }
    }

    /**
     * Called on every socket event of a running scan (components/scanner-sidebar.js), so it is the
     * page's repaint hook as well as the progress writer.
     */
    function updateProgress(tab, customMsg) {
        let p = 0;
        if (tab && tab.stage3Total) p = (tab.stage3Tested / tab.stage3Total * 100) || 0;
        else if (tab && tab.total) p = (tab.tested / tab.total * 100) || 0;

        // The window's status bar. It is shared with the «کانفیگ آیپی ثابت» panel and the
        // combination centre, so it keeps its ids and its own stop button.
        const cont = $('footer-progress-container');
        const bar = $('footer-progress-bar');
        const text = $('footer-progress-text');
        const running = !!tab && (tab.state === 'running' || ui.fetching);

        if (running || (tab && tab.state === 'paused')) {
            if (cont) cont.style.display = 'flex';
            if (bar) bar.style.width = p + '%';
            if (text) {
                if (customMsg) text.textContent = customMsg;
                else if (ui.fetching) text.textContent = 'آماده‌سازی فهرست آی‌پی…';
                else if (tab.state === 'paused') text.textContent = `توقف به‌دلیل قطعی اینترنت (${tab.tested}/${tab.total})`;
                else if (tab.stage3Total) text.textContent = `تست قطعی (${tab.stage3Tested}/${tab.stage3Total})`;
                else text.textContent = `در حال اسکن (${tab.tested}/${tab.total})`;
            }
        } else if (cont) {
            cont.style.display = 'none';
        }

        // The button's tooltip follows its meaning. The tooltip layer copies `title` into
        // `data-tooltip` on first hover, so once that has happened only `data-tooltip` is read.
        const btn = $('btn-top-scan');
        if (btn) {
            const tip = running ? 'توقف اسکن — نتایج به‌دست‌آمده تا این لحظه حفظ می‌شود'
                : (tab && tab.state === 'paused') ? 'ادامهٔ اسکن متوقف‌شده از همان نقطه'
                    : 'شروع اسکن آی‌پی‌ها';
            btn.setAttribute('title', tip);
            if (btn.hasAttribute('data-tooltip')) btn.setAttribute('data-tooltip', tip);
        }
        paint();
    }

    /**
     * One coalescing render for the whole live path.
     *
     * The port-scan branches threw away renders faster than once a second, but `stage3_progress`
     * rebuilt the entire tbody for EVERY tested IP with no throttle at all — the heaviest rows in
     * the table, drawn the most often. All three socket branches call this instead.
     */
    let renderTimer = 0, renderAt = 0;
    function scheduleRender(tab) {
        if (!tab) return;
        const now = Date.now();
        const final = tab.state !== 'running' || (tab.total && tab.tested >= tab.total);
        if (final || now - renderAt >= 1000) {
            clearTimeout(renderTimer); renderTimer = 0; renderAt = now;
            renderResults(tab);
            return;
        }
        if (renderTimer) return;
        renderTimer = setTimeout(() => {
            renderTimer = 0; renderAt = Date.now();
            renderResults(tab);
        }, 1000 - (now - renderAt));
    }

    function sortBy(col) {
        const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
        if (!tab) return;
        if (tab.sortCol === col) tab.sortAsc = !tab.sortAsc;
        else { tab.sortCol = col; tab.sortAsc = true; }
        renderResults(tab);
    }

    // ── Wiring ─────────────────────────────────────────────────────────────

    function wire(root) {
        root.querySelectorAll('[data-act]:not([data-wired])').forEach(b => {
            b.setAttribute('data-wired', '1');
            b.addEventListener('click', () => act(b.getAttribute('data-act')));
        });
        root.querySelectorAll('[data-copy]:not([data-wired])').forEach(b => {
            b.setAttribute('data-wired', '1');
            b.addEventListener('click', (e) => { e.stopPropagation(); window.copyText(b.getAttribute('data-copy')); });
        });
        root.querySelectorAll('.sc-tab:not([data-wired])').forEach(row => {
            row.setAttribute('data-wired', '1');
            const id = row.getAttribute('data-tab');
            const real = /^\d+$/.test(id) ? +id : id;
            row.addEventListener('click', (e) => {
                if (e.target.closest('.sc-tab-x')) return;
                window.switchTab(real);
            });
            row.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.switchTab(real); }
            });
            const x = row.querySelector('.sc-tab-x');
            if (x) x.addEventListener('click', (e) => { e.stopPropagation(); window.closeTab(real); });
        });
    }

    function act(what) {
        switch (what) {
            case 'toggle': window.toggleScan(); break;
            case 'restart': window.restartScan(); break;
            case 'copy': window.copyAllIps(); break;
            case 'save': window.saveCurrentTabManual(); break;
            case 'clear-history': window.clearAllHistory(); break;
            case 'archive': window.openIpArchive(); break;
            case 'combo': window.openCombinationCenter(); break;
            case 'upload': { const f = $('file-upload'); if (f) f.click(); break; }
            case 'export': openExportMenu(); break;
        }
    }

    function openExportMenu() {
        const anchor = document.querySelector('#scan-wrap [data-act="export"]');
        if (window.MV && MV.menu && anchor) {
            MV.menu.open({
                // A RECT, not the element — MV.menu reads .right/.bottom off it (shell/menubar.js
                // does the same). Passed the element itself, the menu landed in the top corner.
                anchor: anchor.getBoundingClientRect(),
                keepFor: anchor,
                items: [
                    { label: 'خروجی متنی (TXT)', action: () => window.exportTxt() },
                    { label: 'خروجی جدولی (CSV)', action: () => window.exportCsv() },
                    { label: 'خروجی خام (JSON)', action: () => window.exportJson() },
                ],
            });
        } else {
            window.exportTxt();
        }
    }

    // ── Boot ───────────────────────────────────────────────────────────────

    function initScanModule() {
        const root = $('scan-root');
        if (!root || ui.built) return;
        root.innerHTML = template();
        ui.built = true;

        const wrap = $('scan-wrap');
        wrap.querySelectorAll('.mv-side-item[data-sec]').forEach(b => {
            b.addEventListener('click', () => scanGo(b.getAttribute('data-sec')));
        });
        const back = $('scan-back');
        if (back) back.addEventListener('click', () => scanGo('scan'));
        const fresh = $('scan-new');
        if (fresh) fresh.addEventListener('click', () => window.promptNewTab());
        const arch = $('scan-go-archive');
        if (arch) arch.addEventListener('click', () => window.openIpArchive());
        const comb = $('scan-go-combo');
        if (comb) comb.addEventListener('click', () => window.openCombinationCenter());
        wire(wrap);

        // Sorting: one listener on the header instead of an onclick per column.
        wrap.querySelectorAll('.sc-results th[data-sort]').forEach(th => {
            th.addEventListener('click', () => sortBy(th.getAttribute('data-sort')));
        });

        // Every control that belongs to a scan writes back into the active tab the moment it
        // changes — the old page only saved on «شروع», so a switch away lost the edit.
        wrap.addEventListener('change', (e) => {
            const t = e.target;
            if (!t || !(t.matches('[data-sc-save]') || t.classList.contains('port-chk'))) return;
            if (typeof window.saveTabSettings === 'function') window.saveTabSettings();
            if (t.id === 'chk-scan-all') syncScanAll();
            if (t.id === 'param-isp' && typeof window.renderTabs === 'function') window.renderTabs();
            paint();
        });

        const file = $('file-upload');
        if (file) file.addEventListener('change', (e) => window.handleFileUpload(e));
        const fetchBtn = $('btn-fetch');
        if (fetchBtn) fetchBtn.addEventListener('click', () => window.fetchIps());
        const autosave = $('scan-autosave');
        if (autosave) autosave.addEventListener('change', () => {
            if (!!window.autoSaveEnabled !== autosave.checked) window.toggleAutoSave();
        });

        scanGo('scan');
        syncScanAll();
    }

    /** «تا پیدا شود» owns the ceiling field — a number that is ignored must not look editable. */
    function syncScanAll() {
        const all = $('chk-scan-all'), max = $('param-max');
        if (all && max) max.disabled = !!all.checked;
    }

    // ── Exports ────────────────────────────────────────────────────────────
    window.initScanModule = initScanModule;
    window.scanGo = scanGo;
    window.scanSection = () => ui.sec;
    window.scanPaint = paint;
    window.scanRenderSideTabs = renderSideTabs;
    window.scanSyncScanAll = syncScanAll;
    window.scanSetFetching = function (on) { ui.fetching = !!on; paint(); };
    window.scanScheduleRender = scheduleRender;
    window.renderResults = renderResults;
    window.updateStats = updateStats;
    window.updateProgress = updateProgress;
    window.sortResults = sortResults;
    window.sortBy = sortBy;
})();
