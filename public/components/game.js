// --- «بازی» panel — the game path engine, Mode 1 ---
//
// Renders into #ls-game. Talks to /api/game/*; every long job streams progress over the
// shared websocket as `game_event`, so nothing here ever shows an indeterminate spinner
// for forty seconds.
//
// THE ONE UX RULE THIS PANEL IS BUILT AROUND
// The verdict is allowed to say «مستقیم بمان», and when it does, that must look like a
// GOOD result — a green card, not a greyed-out failure. A tool that can only ever
// recommend switching something on is the thing we are trying not to build, and the
// interface is where that promise is either kept or broken.
//
// Layout is container-query driven, like the V2Ray panel: the sidebar can be 380px or
// maximised, and the same markup has to read well at both.

(function () {
    'use strict';

    const $g = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => (n == null ? '—' : String(n));

    const state = {
        catalog: null,
        installed: [],
        running: [],
        selected: null,
        browseAll: false,
        query: '',
        assess: { active: false, phase: null, step: 0, total: 0, report: null, targets: [], live: {} },
        audit: null,
        bufferbloat: null,
        profiles: [],
        nat: null,
        tweaks: [],
        regions: null,
        regionAdvice: null,
        regionsRunning: false,
        regionProgress: { step: 0, total: 0 },
        boost: { on: false },
        boostEngines: [],
        boostEval: null,
        boostEngineId: 'aether:masque:turbo',
        boostBusy: false,
        // The tournament. `rows` is keyed by candidate id so a `candidate` event and the
        // `result` event that follows it update the same line instead of appending twice.
        tourney: { running: false, rows: [], done: 0, total: 0, report: null, busy: false, current: null },
        tourneyOpts: {
            aether: true,
            protocols: ['masque', 'wg', 'gool'],
            scans: ['turbo', 'balanced'],
            v2raySaved: true,
            v2rayFree: false,
            githubTunnel: false,
            maxNodes: 8,
            maxFree: 6,
        },
        tourneyMeta: { nodeCount: 0, protocols: [], scans: [], adapterBusy: false },
        chart: { series: {}, t0: 0 },
    };

    const TONE = {
        ok: { c: 'var(--mv-green-ink)', bg: 'color-mix(in srgb, var(--mv-green) 10%, transparent)', bd: 'color-mix(in srgb, var(--mv-green) 35%, transparent)', icon: 'ph-check-circle' },
        warn: { c: 'var(--mv-orange-ink)', bg: 'color-mix(in srgb, var(--mv-orange) 10%, transparent)', bd: 'color-mix(in srgb, var(--mv-orange) 35%, transparent)', icon: 'ph-warning' },
        bad: { c: 'var(--mv-red-ink)', bg: 'color-mix(in srgb, var(--mv-red) 10%, transparent)', bd: 'color-mix(in srgb, var(--mv-red) 35%, transparent)', icon: 'ph-x-circle' },
        neutral: { c: 'var(--mv-blue-ink)', bg: 'color-mix(in srgb, var(--mv-accent) 10%, transparent)', bd: 'color-mix(in srgb, var(--mv-accent) 35%, transparent)', icon: 'ph-info' },
    };
    const VERDICT_FA = {
        ok: 'سالم', warn: 'قابل بهبود', bad: 'مشکل جدی', unknown: 'نامشخص',
    };
    const PHASE_FA = {
        start: 'شروع', detect: 'تشخیص بازی در حال اجرا', audit: 'ممیزی خط محلی',
        targets: 'انتخاب مقصدها', measure: 'اندازه‌گیری درهم‌بافته', engines: 'مقایسه با موتورها',
    };
    const STORE_FA = { steam: 'Steam', epic: 'Epic', rockstar: 'Rockstar', ubisoft: 'Ubisoft', gog: 'GOG', riot: 'Riot', xbox: 'Xbox', uninstall: 'نصب‌شده' };

    // ── styles ──────────────────────────────────────────────────────────────────
    //
    // Built with the page kit (ui/page-kit.css). The panel's own class names are kept — every
    // render function below writes them, and this is a change of LOOK, not of logic — so the
    // kit is applied to them here: a `.gp-card` is a form group, a `.gp-h` a section header, a
    // `.gp-btn` the kit's button, `.gp-t` the kit's table, `.gp-verdict` a callout.
    const CSS = `
/* The page is the kit's (.mv-split + .mv-eng-*). The container query that decides the game
   grid's column count now measures the PANE, not the window — the sidebar is not part of the
   space the grid has. */
#game-wrapper{position:relative;z-index:0;flex:1 1 auto;min-height:0;color:var(--mv-label)}
#game-scroll{container-type:inline-size;container-name:gamep}
.gp-sec{display:flex;flex-direction:column;gap:16px;padding-top:6px}
/* The one figure this window is about, in the hero. */
#game-wrapper .gp-hero-parts{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
/* A card is one group in a grouped form: a rounded well, no border, hairlines inside it. */
.gp-card{background:var(--mv-group);border-radius:var(--mv-r-lg, 12px);box-shadow:var(--mv-group-hair, none);padding:12px 14px}
.gp-h{display:flex;align-items:center;gap:8px;margin-bottom:9px;font-weight:700;font-size:13px;color:var(--mv-label)}
.gp-h i{font-size:16px}
.gp-sub{font-size:11.5px;color:var(--mv-label-2);line-height:1.85}
.gp-chip{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}
.gp-chip.b{background:color-mix(in srgb, var(--mv-blue) 14%, transparent);color:var(--mv-blue-ink)}
.gp-chip.g{background:color-mix(in srgb, var(--mv-green) 14%, transparent);color:var(--mv-green-ink)}
.gp-chip.r{background:color-mix(in srgb, var(--mv-red) 14%, transparent);color:var(--mv-red-ink)}
.gp-chip.y{background:color-mix(in srgb, var(--mv-orange) 14%, transparent);color:var(--mv-orange-ink)}
.gp-chip.n{background:var(--mv-fill);color:var(--mv-label-2)}
/* The kit's button (components.css › .mv-btn), reached through the panel's own class. */
.gp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:26px;padding:0 12px;border:0;border-radius:var(--mv-r-sm, 6px);background:var(--mv-control);box-shadow:var(--mv-control-hair);color:var(--mv-label);font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;transition:background var(--mv-d-1) var(--mv-ease-out)}
.gp-btn:hover:not(:disabled){background:var(--mv-control-hover)}
.gp-btn:active:not(:disabled){background:var(--mv-control-press)}
.gp-btn:disabled{opacity:.42;cursor:default}
.gp-btn:focus-visible{outline:none;box-shadow:0 0 0 3px var(--mv-accent-ring), var(--mv-control-hair)}
/* tokenize:off — white on the accent fill is the fixed pair */
.gp-btn.primary{background:var(--mv-accent);color:#FFFFFF}
.gp-btn.primary:hover:not(:disabled){background:color-mix(in srgb, var(--mv-accent) 88%, #FFFFFF)}
.gp-btn.danger{background:var(--mv-control);color:var(--mv-red-ink)}
/* Anything asked to fill its row is a large control, and large controls are capsules. */
.gp-btn[style*="width:100%"]{height:32px;border-radius:999px;font-size:13px;font-weight:600}
.gp-input{width:100%;height:28px;background:var(--mv-field);border:0;border-radius:var(--mv-r-sm, 6px);box-shadow:var(--mv-field-hair, inset 0 0 0 1px var(--mv-sep));padding:0 10px;color:var(--mv-label);font:inherit;font-size:12.5px;font-family:var(--mv-font-tech);outline:none;direction:ltr;text-align:left}
.gp-input:focus{box-shadow:0 0 0 3px var(--mv-accent-ring), var(--mv-field-hair, inset 0 0 0 1px var(--mv-sep))}
.gp-input::placeholder{color:var(--mv-label-3);direction:rtl;text-align:right}
select.gp-input{height:28px;padding-inline:8px}

/* game grid */
#gp-games{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
@container gamep (max-width:420px){#gp-games{grid-template-columns:1fr 1fr}}
.gp-game{position:relative;text-align:right;background:var(--mv-fill);border:0;border-radius:var(--mv-r-md, 10px);padding:9px 10px;cursor:pointer;transition:background var(--mv-d-1) var(--mv-ease-out);display:flex;flex-direction:column;gap:5px;min-height:60px}
.gp-game:hover{background:var(--mv-fill-2)}
.gp-game:focus-visible{outline:2px solid var(--mv-accent);outline-offset:-2px}
.gp-game.sel{background:var(--mv-accent);color:#FFFFFF}
.gp-game.sel .nm{color:#FFFFFF}
.gp-game.sel .gp-chip{background:rgba(255,255,255,.22);color:#FFFFFF}
/* tokenize:on */
.gp-game .nm{font-size:12px;font-weight:600;color:var(--mv-label);line-height:1.5;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.gp-game .mt{display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.gp-live{position:absolute;top:7px;left:7px;width:7px;height:7px;border-radius:50%;background:var(--mv-green);box-shadow:0 0 0 3px color-mix(in srgb, var(--mv-green) 18%, transparent)}
@keyframes gp-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes gp-spin{to{transform:rotate(360deg)}}
.gp-live{animation:gp-pulse 1.6s ease-in-out infinite}
html[data-motion="reduced"] .gp-live{animation:none}

/* verdict — the kit's callout: a tinted well, no border */
.gp-verdict{border-radius:var(--mv-r-md, 10px);padding:12px 13px;border:0}
.gp-verdict .vt{font-size:13.5px;font-weight:700;line-height:1.6;margin-bottom:7px;display:flex;gap:8px;align-items:flex-start}
.gp-verdict .vt i{font-size:18px;flex:0 0 auto;margin-top:1px}
.gp-verdict ul{margin:0;padding-inline-start:16px;display:flex;flex-direction:column;gap:5px}
.gp-verdict li{font-size:12px;line-height:1.9;color:var(--mv-label)}

/* results table — K4's look, on the panel's own markup */
.gp-tw{overflow-x:auto;border-radius:var(--mv-r-md, 10px);background:var(--mv-group);box-shadow:var(--mv-group-hair, none)}
table.gp-t{border-collapse:separate;border-spacing:0;width:100%;font-size:12px;min-width:430px;color:var(--mv-label)}
table.gp-t th{text-align:start;padding:9px 12px 8px;font-weight:600;color:var(--mv-label-2);font-size:11.5px;white-space:nowrap;border-bottom:var(--mv-hl) solid var(--mv-sep)}
table.gp-t td{padding:9px 12px;border-top:var(--mv-hl) solid var(--mv-group-sep);vertical-align:middle}
table.gp-t tbody tr:first-child td{border-top:0}
table.gp-t tbody tr:hover{background:var(--mv-fill)}
table.gp-t td.n,table.gp-t th.n{font-family:var(--mv-font-tech);font-variant-numeric:tabular-nums;text-align:center;direction:ltr;white-space:nowrap}
table.gp-t tr.best td{background:color-mix(in srgb, var(--mv-green) 10%, transparent)}
.gp-scorebar{height:5px;border-radius:999px;background:var(--mv-track);overflow:hidden;min-width:44px}
.gp-scorebar i{display:block;height:100%;border-radius:inherit}

/* audit list — rows of a group */
.gp-check{display:flex;gap:9px;padding:9px 0;border-bottom:var(--mv-hl) solid var(--mv-group-sep)}
.gp-check:last-child{border-bottom:0}
.gp-check .dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;margin-top:6px}
.gp-check .body{flex:1;min-width:0}
.gp-check .t{font-size:12.5px;font-weight:600;color:var(--mv-label)}
.gp-check .d{font-size:11.5px;color:var(--mv-label-2);line-height:1.8;margin-top:2px}
.gp-check ul{margin:5px 0 0;padding-inline-start:15px}
.gp-check li{font-size:11.5px;line-height:1.85;color:var(--mv-label-2);margin-bottom:3px}

/* progress */
.gp-prog{height:5px;border-radius:999px;background:var(--mv-track);overflow:hidden}
.gp-prog i{display:block;height:100%;background:var(--mv-accent);border-radius:inherit;transition:width var(--mv-d-2) var(--mv-ease-out)}
#gp-chart{width:100%;height:96px;display:block;border-radius:var(--mv-r-sm, 8px);background:var(--mv-fill)}
.gp-legend{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
.gp-legend span{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--mv-label-2)}
.gp-legend i{width:9px;height:3px;border-radius:2px;display:inline-block}
.gp-empty{text-align:center;padding:22px 12px;color:var(--mv-label-3);font-size:12.5px;line-height:2}
`;

    // ── the page ────────────────────────────────────────────────────────────────
    //
    // The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one every other
    // window wears. The single «شتاب‌دهی» button is the hero's button now, and the twelve
    // cards that used to live behind one «ابزارهای پیشرفته» fold are two named sections —
    // «سنجش» for the measurements and «سیستم و خط» for the levers.

    const GAME_SECTIONS = [
        { id: 'boost', label: 'شتاب‌دهی', icon: 'ph-fill ph-rocket-launch', tint: 'var(--mv-green)' },
        { id: 'library', label: 'بازی‌ها', icon: 'ph-fill ph-game-controller', tint: 'var(--mv-blue)' },
        { id: 'measure', label: 'سنجش', icon: 'ph-fill ph-pulse', tint: 'var(--mv-pink, #FF2D55)' },
        { id: 'machine', label: 'سیستم و خط', icon: 'ph-fill ph-sliders', tint: 'var(--mv-indigo)' },
    ];

    let gameSec = 'boost';

    const HTML = `
<div id="game-wrapper" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های شتاب‌دهی بازی">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="gp-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${GAME_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-gp-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="gp-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="gp-pane-title">شتاب‌دهی</h1>
      <div class="mv-eng-bar-action" id="gp-lib-actions" hidden>
        <button type="button" class="mv-tb-btn" id="gp-rescan" title="اسکن دوباره‌ی لانچرها" aria-label="اسکن دوباره"><i class="ph-bold ph-arrows-clockwise"></i></button>
        <button type="button" class="mv-tb-btn" id="gp-toggle-all" title="همه بازی‌ها" aria-label="همه بازی‌ها"><i class="ph-bold ph-squares-four"></i></button>
      </div>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="game-scroll">
      <div class="mv-eng-sec is-on" data-sec="boost">
        <div class="mv-eng-stage" id="gp-stage" style="--tint:var(--mv-green)"></div>
        <div class="mv-eng-flow" id="gp-flow" style="display:none"><div class="mv-steps" id="gp-steps"></div></div>
        <div class="mv-eng-grid" id="gp-cards"></div>
        <div class="gp-sec">
          <div id="gp-accel-slot"></div>
          <div id="gp-selected"></div>
        </div>
      </div>

      <div class="mv-eng-sec" data-sec="library">
        <div class="gp-sec">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header" id="gp-lib-title">بازی‌های نصب‌شده</div>
            <div class="gp-card">
              <input class="gp-input" id="gp-search" placeholder="جستجوی بازی…" style="margin-bottom:9px">
              <div id="gp-games"><div class="gp-empty">در حال خواندن…</div></div>
            </div>
          </div>
        </div>
      </div>

      <div class="mv-eng-sec" data-sec="measure">
        <div class="gp-sec">
          <div class="gp-sub" style="margin:0 2px">هر کارت اینجا یکی از همان کارهایی است که دکمهٔ شتاب‌دهی خودش انجام می‌دهد — اینجا هستند تا بتوانی تک‌تک را دستی بگیری و <b>اعداد خامش را ببینی</b>.</div>
          <div class="gp-card" id="gp-run-card">
            <div class="gp-h"><i class="ph-bold ph-pulse" style="color:var(--mv-green-ink)"></i>سنجش</div>
            <div id="gp-run-body"></div>
          </div>
          <div id="gp-verdict-slot"></div>
          <div id="gp-results-slot"></div>
          <div id="gp-audit-slot"></div>
          <div id="gp-bloat-slot"></div>
          <div id="gp-regions-slot"></div>
          <div id="gp-tourney-slot"></div>
        </div>
      </div>

      <div class="mv-eng-sec" data-sec="machine">
        <div class="gp-sec">
          <div id="gp-nat-slot"></div>
          <div id="gp-uplinks-slot"></div>
          <div id="gp-queue-slot"></div>
          <div id="gp-shaper-slot"></div>
          <div id="gp-watch-slot"></div>
          <div id="gp-tweaks-slot"></div>
          <div id="gp-boost-slot"></div>
          <div id="gp-profiles-slot"></div>
        </div>
      </div>
    </div>

    <div class="mv-eng-foot" id="gp-foot"></div>
  </section>
</div>`;

    // ── the hero ────────────────────────────────────────────────────────────────

    function gameDot(tone) {
        return `<i class="mv-eng-dot${tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : ''}"></i>`;
    }

    /** What the hero says, and what its one button does. */
    function gameView() {
        const a = state.accel || {};
        const g = state.selected;
        const active = a.active;
        const on = !!(active && active.on);

        if (a.running) {
            return { tone: 'busy', act: 'stop', on,
                head: 'در حال شتاب‌دهی',
                line: 'خط برای بازی خالی می‌شود، پردازنده به آن اولویت می‌گیرد، DNS اصلاح می‌شود و مسیر سنجیده می‌شود. خط بالای کارت‌ها می‌گوید کجای کار است.' };
        }
        if (on) {
            return { tone: 'on', act: 'revert',
                head: `شتاب فعال است${active.gameFa ? ' — ' + esc(active.gameFa) : ''}`,
                line: 'وقتی بازی بسته شود هرچه عوض شده خودکار برمی‌گردد. دکمهٔ بالا همین حالا همه‌چیز را برمی‌گرداند.', on };
        }
        if (!g) {
            return { tone: 'off', act: '', on,
                head: 'اول یک بازی انتخاب کنید',
                line: 'این پنجره مسیر شبکهٔ بازی را با <b>ترنِ بسته با آهنگ بازی</b> می‌سنجد — نه با پینگ ساده — و صادقانه می‌گوید بهترین کار چیست. اگر مسیر مستقیم بهترین باشد، همین را می‌گوید. بخش «بازی‌ها» کتابخانه را نشان می‌دهد.' };
        }
        return { tone: 'off', act: 'go', on,
            head: `آمادهٔ شتاب‌دهی «${esc(g.fa)}»`,
            line: 'یک دکمه، و پشتش هر کاری که از دستمان برمی‌آید: خالی کردن خط برای بازی، اولویت دادن پردازنده به آن، اصلاح DNS، و بعد سنجش مسیر — تونل فقط اگر واقعاً بهتر باشد، یا اگر مسیر مستقیم بسته باشد.' };
    }

    function renderIdent() {
        const host = $g('gp-ident');
        if (!host) return;
        const v = gameView();
        const word = v.tone === 'on' ? 'شتاب فعال' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('game');
        const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
            : '<span class="mv-side-tile" style="--tint:var(--mv-green)"><svg aria-hidden="true"><use href="#g-pad"/></svg></span>';
        host.innerHTML = `${icon}
      <b>شتاب‌دهی بازی</b>
      <small>${gameDot(v.tone)}${word}</small>`;
    }

    /** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
    function renderStage() {
        const host = $g('gp-stage');
        if (!host) return;
        const v = gameView();

        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-gp-act="power" data-part="power">
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
        const aria = v.act === 'revert' ? 'توقف شتاب و بازگرداندن همه‌چیز'
            : v.act === 'stop' ? 'توقف' : 'شتاب‌دهی';
        btn.setAttribute('aria-label', aria);
        btn.title = v.act ? aria : 'اول یک بازی انتخاب کنید';
        const glyph = v.tone === 'busy' ? 'mv-spin-ring'
            : v.tone === 'on' ? 'ph-fill ph-rocket-launch' : 'ph-bold ph-rocket-launch';
        const gl = q('glyph');
        if (gl.className !== glyph) gl.className = glyph;

        const el = q('live');
        if (el && window.MVEngineLive) MVEngineLive.mount(el);
    }

    /** The pipeline as one horizontal line, exactly the steps the server reports. */
    function renderFlow() {
        const wrap = $g('gp-flow');
        const host = $g('gp-steps');
        if (!wrap || !host) return;
        const a = state.accel || {};
        const st = a.stepState || {};
        const steps = a.steps || ACCEL_STEPS_FALLBACK;
        const show = !!a.running || Object.keys(st).length > 0;
        wrap.style.display = show ? 'flex' : 'none';
        if (!show) return;

        host.innerHTML = steps.map((x, i) => {
            const cur = st[x.id] || { status: 'pending' };
            let cls = 'pending', mark = String(i + 1).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
            if (cur.status === 'done') { cls = 'done'; mark = '✓'; }
            else if (cur.status === 'running') { cls = 'active'; mark = '●'; }
            else if (cur.status === 'failed') { cls = 'failed'; mark = '✕'; }
            else if (cur.status === 'skipped') { cls = 'done'; mark = '–'; }
            return `<span class="mv-step is-${cls}"><i>${mark}</i>${esc(x.fa)}</span>`;
        }).join('');
    }

    /** The four things the window is about, each opening the section that holds all of it. */
    function renderCards() {
        const host = $g('gp-cards');
        if (!host) return;
        const v = gameView();
        const g = state.selected;
        const c = state.ctx || {};
        const a = state.accel || {};
        const active = a.active;
        const sum = a.summary;
        const nat = state.nat || null;
        const rep = state.assess && state.assess.report;

        const fact = (icon, colour, title, sub) => `
          <div class="mv-eng-pick" aria-disabled="true">
            <i class="${icon}" style="color:${colour}"></i>
            <span class="mv-eng-pick-text"><b>${title}</b><small>${sub}</small></span>
          </div>`;

        host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-gp-go="library">
            <span class="mv-eng-glyph"><i class="ph-fill ph-game-controller"></i></span>
            <h3>بازی</h3>
            <span class="mv-eng-card2-end">${state.installed.length ? state.installed.length.toLocaleString('fa-IR') + ' نصب‌شده' : '—'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-gp-act="rescan" title="اسکن دوبارهٔ لانچرها" aria-label="اسکن دوبارهٔ لانچرها">
            <i class="ph-bold ph-arrows-clockwise"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${g ? fact(g.isRunning ? 'ph-fill ph-play-circle' : 'ph-fill ph-target',
            g.isRunning ? 'var(--mv-green)' : 'var(--mv-blue)', esc(g.fa),
            g.isRunning ? 'همین حالا در حال اجراست' : 'انتخاب‌شده — دکمهٔ بالا روی همین کار می‌کند')
            : '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز بازی‌ای انتخاب نشده.</div>'}
          ${state.running.length ? fact('ph-fill ph-broadcast', 'var(--mv-green)',
            state.running.length.toLocaleString('fa-IR') + ' بازی در حال اجرا', 'از میان نصب‌شده‌ها') : ''}
        </div>
        <div class="mv-eng-card2-foot">کتابخانه از لانچرها خوانده می‌شود — استیم، اپیک، راک‌استار، یوبی‌سافت و بقیه. اگر بازی‌ای پیدا نشد، در همان بخش دستی اضافه‌اش کنید.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <button type="button" class="mv-eng-card2-head" data-gp-go="machine">
          <span class="mv-eng-glyph"><i class="ph-fill ph-broadcast"></i></span>
          <h3>خط شما</h3>
          <span class="mv-eng-card2-end">${esc(c.isp || '—')}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          ${c.bucketFa ? fact('ph-fill ph-clock', 'var(--mv-label-3)', esc(c.bucketFa), 'ساعتی که این سنجش‌ها در آن گرفته شده') : ''}
          ${nat && nat.fa ? fact('ph-fill ph-shield',
            nat.verdict === 'bad' ? 'var(--mv-red)' : nat.verdict === 'warn' ? 'var(--mv-orange)' : nat.verdict === 'ok' ? 'var(--mv-green)' : 'var(--mv-label-3)',
            esc(nat.fa), esc(nat.detail || 'نوع NAT این خط')) : ''}
          ${!c.bucketFa && !(nat && nat.fa) ? '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز چیزی از این خط اندازه‌گیری نشده.</div>' : ''}
        </div>
        <div class="mv-eng-card2-foot">هر اندازه‌گیری روی همین خط و همین ساعت معنی دارد؛ نتیجهٔ ساعت شلوغ با ساعت خلوت یکی نیست.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-pink, #FF2D55)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-gp-go="measure">
            <span class="mv-eng-glyph"><i class="ph-fill ph-pulse"></i></span>
            <h3>آخرین سنجش</h3>
            <span class="mv-eng-card2-end">${rep ? (VERDICT_FA[rep.verdict] || 'انجام شد') : sum ? 'انجام شد' : 'نشده'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-gp-act="assess"
                  title="سنجش سریع مسیر" aria-label="سنجش سریع مسیر"
                  ${!g || state.assess.active || a.running ? 'disabled' : ''}>
            <i class="${state.assess.active ? 'mv-spin-ring' : 'ph-bold ph-gauge'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${sum ? fact('ph-fill ph-check-circle', 'var(--mv-green)', esc(sum.headline),
            sum.direct ? `مستقیم: min ${fa(sum.direct.min)}ms · p95 ${fa(sum.direct.p95)}ms · اتلاف ${fa(sum.direct.loss)}٪` : 'نتیجهٔ آخرین شتاب‌دهی')
            : '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز سنجشی انجام نشده — دکمهٔ سنجش بالا مسیر را می‌سنجد بدون اینکه چیزی را عوض کند.</div>'}
        </div>
        <div class="mv-eng-card2-foot">سنجش چیزی را روشن نمی‌کند؛ فقط اندازه می‌گیرد. اگر جوابش «مستقیم بمان» باشد، همین را می‌گوید — و این یک نتیجهٔ خوب است.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-green)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-rocket-launch"></i></span>
          <h3>آنچه روشن است</h3>
          <span class="mv-eng-card2-end">${v.on ? 'فعال' : 'خاموش'}</span>
        </div>
        <div class="mv-eng-card2-body">
          ${v.on && (active.parts || []).length
            ? `<div class="gp-hero-parts" style="padding:2px 9px 4px">${active.parts.map(p => `<span class="gp-chip g">${esc(p)}</span>`).join('')}</div>`
            : '<div class="mv-eng-card2-foot" style="padding-top:6px">هیچ تغییری روی این کامپیوتر اعمال نشده.</div>'}
          ${v.on && active.since ? fact('ph-fill ph-clock', 'var(--mv-green)', 'از ' + esc(new Date(active.since).toLocaleTimeString('fa-IR')), 'با بسته شدن بازی خودکار برمی‌گردد') : ''}
        </div>
        <div class="mv-eng-card2-foot">یک راه خروج، و همه‌چیز را برمی‌گرداند: دکمهٔ سربرگ. چیزی نیمه‌کاره روی ویندوز نمی‌ماند.</div>
      </div>`;
    }

    /** The bottom bar: which game this window is about, and whether the boost is on. */
    function renderBottomBar() {
        const host = $g('gp-foot');
        if (!host) return;
        const v = gameView();
        const g = state.selected;
        const word = v.tone === 'on' ? 'شتاب روشن' : v.tone === 'busy' ? 'در حال شتاب‌دهی'
            : g ? 'آمادهٔ شتاب‌دهی' : 'بازی‌ای انتخاب نشده';
        host.innerHTML = `
      ${gameDot(v.tone)}
      <span>${word}</span>
      <span class="mv-eng-foot-end"><span>${g ? esc(g.fa) : '—'}</span></span>`;
    }

    /** Everything the hero owns. */
    function renderHero() {
        if (!$g('game-wrapper')) return;
        renderIdent();
        renderBottomBar();
        if (gameSec === 'boost') { renderStage(); renderFlow(); renderCards(); }
        wireHero();
    }

    function goSec(id) {
        const wrap = $g('game-wrapper');
        if (!wrap) return;
        gameSec = GAME_SECTIONS.some((x) => x.id === id) ? id : 'boost';
        wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === gameSec));
        wrap.querySelectorAll('.mv-side-item[data-gp-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-gp-sec') === gameSec));
        const found = GAME_SECTIONS.find((x) => x.id === gameSec);
        const title = $g('gp-pane-title');
        if (title) title.textContent = found ? found.label : '';
        const back = $g('gp-back');
        if (back) back.disabled = gameSec === 'boost';
        // The library's two buttons belong to the library, so they ride its title band.
        const acts = $g('gp-lib-actions');
        if (acts) acts.hidden = gameSec !== 'library';
        const pane = wrap.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', gameSec === 'boost');
        const sc = $g('game-scroll');
        if (sc) sc.scrollTop = 0;
        renderHero();
    }

    function wireHero() {
        const wrap = $g('game-wrapper');
        if (!wrap) return;
        wrap.querySelectorAll('[data-gp-go]').forEach((b) => {
            b.onclick = () => goSec(b.getAttribute('data-gp-go'));
        });
        wrap.querySelectorAll('[data-gp-act]').forEach((b) => {
            b.onclick = () => {
                const k = b.getAttribute('data-gp-act');
                if (k === 'power') {
                    const act = gameView().act;
                    if (act === 'go') startAccel();
                    else if (act === 'stop') stopAccel();
                    else if (act === 'revert') revertAccel();
                } else if (k === 'rescan') loadInstalled(true);
                else if (k === 'assess') { goSec('measure'); startAssess(true); }
            };
        });
    }

    // ── data ────────────────────────────────────────────────────────────────────
    async function api(path, opts) {
        const r = await fetch(path, opts);
        return r.json();
    }

    async function loadCatalog() {
        const r = await api('/api/game/catalog');
        if (r.ok) state.catalog = r;
    }

    async function loadInstalled(force) {
        renderGames(true);
        const r = await api('/api/game/installed' + (force ? '?force=1' : ''));
        if (r.ok) state.installed = r.items || [];
        await loadRunning();
        renderGames();
    }

    async function loadRunning() {
        try {
            const r = await api('/api/game/running');
            state.running = r.ok ? (r.games || []) : [];
        } catch { state.running = []; }
    }

    async function loadProfiles() {
        try {
            const q = state.selected ? '?game=' + encodeURIComponent(state.selected.id) : '';
            const r = await api('/api/game/profiles' + q);
            if (r.ok) { state.profiles = r.items || []; state.ctx = { isp: r.isp, bucketFa: r.bucketFa }; }
        } catch {}
        renderCtx();
        renderProfiles();
    }

    // ── rendering ─────────────────────────────────────────────────────────

    /**
     * The line the measurements are being taken on — operator, hour, whether a game is up.
     * It used to be a row under the title; it is the «خط شما» card now, so refreshing the
     * hero IS refreshing it.
     */
    function renderCtx() { renderHero(); }

    function visibleGames() {
        const q = state.query.trim().toLowerCase();
        let list;
        if (state.browseAll && state.catalog) {
            list = state.catalog.games.map(g => ({ ...g, known: true, installedHere: false }));
            const inst = new Set(state.installed.map(i => i.id));
            list.forEach(g => { g.installedHere = inst.has(g.id); });
        } else {
            list = state.installed.slice();
        }
        if (q) list = list.filter(g => (g.fa + ' ' + (g.en || '') + ' ' + (g.procs || []).join(' ')).toLowerCase().includes(q));
        const runIds = new Set(state.running.map(r => r.id));
        list.forEach(g => { g.isRunning = runIds.has(g.id); });
        return list.sort((a, b) => (b.isRunning ? 1 : 0) - (a.isRunning ? 1 : 0) || (b.installedHere ? 1 : 0) - (a.installedHere ? 1 : 0));
    }

    function renderGames(loading) {
        const box = $g('gp-games');
        if (!box) return;
        $g('gp-lib-title').textContent = state.browseAll ? 'همه‌ی بازی‌ها' : 'بازی‌های نصب‌شده';
        const all = $g('gp-toggle-all');
        if (all) {
            const t = state.browseAll ? 'فقط نصب‌شده‌ها' : 'همه بازی‌ها';
            all.title = t;
            all.setAttribute('aria-label', t);
            all.setAttribute('aria-pressed', String(!!state.browseAll));
        }
        if (loading) { box.innerHTML = '<div class="gp-empty">در حال اسکن لانچرها…</div>'; return; }

        const addRow = `<button class="gp-btn" id="gp-add-game" style="width:100%;margin-top:9px;font-size:12.5px">
             <i class="ph-bold ph-plus-circle"></i>بازی من اینجا نیست — خودم اضافه کنم
           </button>`;

        const list = visibleGames();
        if (!list.length) {
            box.innerHTML = (state.browseAll
                ? '<div class="gp-empty">چیزی پیدا نشد.</div>'
                : `<div class="gp-empty">هیچ بازی شناخته‌شده‌ای پیدا نشد.<br>
                   <button class="gp-btn" style="margin-top:10px" onclick="window.gpBrowseAll()">همه‌ی بازی‌ها را نشان بده</button></div>`)
                + addRow;
            bindAddGame();
            return;
        }
        box.innerHTML = list.map(g => {
            const sel = state.selected && state.selected.id === g.id;
            const chips = [];
            if (g.store && !state.browseAll) chips.push(`<span class="gp-chip n">${esc(STORE_FA[g.store] || g.store)}</span>`);
            if (state.browseAll && g.installedHere) chips.push('<span class="gp-chip g">نصب است</span>');
            if (g.known === false) chips.push('<span class="gp-chip y">ناشناخته</span>');
            if (g.custom) chips.push('<span class="gp-chip n">اضافهٔ خودتان</span>');
            if (g.kernelAnticheat) chips.push('<span class="gp-chip r" title="ضدتقلب کرنلی">ضدتقلب</span>');
            return `<button class="gp-game${sel ? ' sel' : ''}" data-id="${esc(g.id)}">
              ${g.isRunning ? '<span class="gp-live" title="در حال اجرا"></span>' : ''}
              <span class="nm">${esc(g.fa)}</span>
              <span class="mt">${chips.join('')}</span>
            </button>`;
        }).join('');
        box.innerHTML += addRow;
        box.querySelectorAll('.gp-game').forEach(b => b.onclick = () => selectGame(b.dataset.id));
        bindAddGame();
    }

    function bindAddGame() {
        const b = $g('gp-add-game');
        if (b) b.onclick = addGameFlow;
    }

    /**
     * Add a game, without ever asking anybody to type a file name.
     *
     * A typed `.exe` is a silent failure — «valorent.exe» would be accepted, recognise nothing for
     * ever, and read as a broken feature rather than a typo. So both paths hand back a real file
     * name: what is running right now (a user usually notices their game is missing WHILE playing
     * it), or the app's own file dialog.
     */
    async function addGameFlow() {
        const how = await uiChoose('بازی را چطور پیدا کنیم؟', [
            { id: 'running', fa: 'از برنامه‌های در حال اجرا', sub: 'اگر بازی همین حالا باز است — ساده‌ترین راه' },
            { id: 'browse', fa: 'انتخاب فایل بازی', sub: 'فایل ‎.exe‎ بازی را از روی دیسک انتخاب کنید' },
        ]);
        if (!how) return;

        let exe = null, guessName = '', exePath = '';

        if (how === 'browse') {
            const r = await api('/api/game/custom/browse', { method: 'POST' });
            if (!r || !r.ok || !r.app) return;                 // cancelled in the dialog
            exe = r.app.exe; guessName = r.app.name || ''; exePath = r.app.path || '';
        } else {
            const r = await api('/api/game/custom/candidates');
            if (!r || !r.ok) { await uiAlert('فهرست برنامه‌ها خوانده نشد.'); return; }
            if (!r.items.length) {
                await uiAlert('برنامهٔ تازه‌ای در حال اجرا نیست. بازی را باز کنید و دوباره امتحان کنید، یا فایلش را انتخاب کنید.');
                return;
            }
            const pick = await uiChoose('کدام‌یک بازی شماست؟',
                r.items.slice(0, 60).map(x => ({ id: x.name, fa: x.name, sub: '' })));
            if (!pick) return;
            exe = pick;
            guessName = String(pick).replace(/\.exe$/i, '');
        }

        const name = await uiPrompt('اسم بازی چیست؟', guessName);
        if (!name) return;

        const res = await api('/api/game/custom', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fa: name, procs: [exe], path: exePath, cat: 'other' }),
        });
        if (!res || !res.ok) { await uiAlert((res && res.error) || 'اضافه نشد'); return; }

        await loadCatalog();
        renderGames();
        selectGame(res.game.id);
        // `say` is a helper this panel does not have — it belongs to the settings pane. The
        // selection itself is the confirmation the user needs, and the new entry now carries
        // the «اضافهٔ خودتان» chip, so an extra dialog here would be one click of noise.
        await uiAlert(`«${res.game.fa}» اضافه شد. از این به بعد هر وقت ${res.game.procs[0]} اجرا شود شناخته می‌شود.`);
    }

    /** Remove one of the user's own games. Only ever offered for entries they added. */
    async function removeCustomGame(id, fa) {
        if (!await uiConfirm(`«${fa}» از فهرست شما پاک شود؟`)) return;
        const r = await api('/api/game/custom/remove', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id }),
        });
        if (!r || !r.ok) { await uiAlert((r && r.error) || 'پاک نشد'); return; }
        if (state.selected && state.selected.id === id) state.selected = null;
        await loadCatalog();
        renderGames();
        renderSelected();
    }
    window.gpRemoveCustom = removeCustomGame;

    function findGame(id) {
        return state.installed.find(g => g.id === id)
            || (state.catalog && state.catalog.games.find(g => g.id === id))
            || null;
    }

    function selectGame(id) {
        state.selected = findGame(id);
        state.assess.report = null;
        renderGames();
        renderBottomBar();
        renderSelected();
        renderRun();
        $g('gp-verdict-slot').innerHTML = '';
        $g('gp-results-slot').innerHTML = '';
        loadProfiles();
        loadRegions();   // the advice is per-game, so it has to follow the selection
        loadBoost();     // …and so is the boost verdict
        // A ranking measured for another game says nothing about this one — the anchor is
        // shared but the verdict is written about the selected game.
        if (state.tourney.report && state.tourney.report.gameId !== id) state.tourney.report = null;
        loadTourney();
        loadAccel();     // the one button is per-game too
    }
    window.gpBrowseAll = () => { state.browseAll = true; renderGames(); };

    function renderSelected() {
        const slot = $g('gp-selected');
        if (!slot) return;
        const g = state.selected;
        if (!g) { slot.innerHTML = ''; return; }
        const cf = state.catalog ? state.catalog.classFa : {};
        const needsServer = ['fivem', 'a2s', 'raknet', 'minecraft'].includes(g.probe);

        const warn = g.kernelAnticheat ? `
          <div style="margin-top:9px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb, var(--mv-red) 10%, transparent);border:0">
            <div style="font-size:11.5px;font-weight:700;color:var(--mv-red-ink);display:flex;gap:6px;align-items:center">
              <i class="ph-bold ph-shield-warning"></i>ضدتقلب کرنلی: ${esc(g.anticheat)}
            </div>
            <div class="gp-sub" style="margin-top:4px">
              این بازی درایور کرنلی دارد. موتور فقط اندازه‌گیری می‌کند و هرگز بسته‌ای را دستکاری نمی‌کند —
              مرز ما آداپتر TUN استاندارد است و از آن جلوتر نمی‌رویم.
            </div>
          </div>` : '';

        const probeFa = {
            fivem: 'سنجش واقعی سرتاسری (getinfo)', a2s: 'سنجش واقعی سرتاسری (A2S)',
            raknet: 'سنجش واقعی (RakNet)', minecraft: 'سنجش واقعی (Minecraft)',
            anchors: 'سنجش با لنگرهای منطقه‌ای (تخمینی)',
        }[g.probe] || 'لنگرهای منطقه‌ای';

        slot.innerHTML = `
        <div class="gp-card">
          <div class="gp-h" style="justify-content:space-between">
            <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-target" style="color:var(--mv-blue-ink)"></i>${esc(g.fa)}</span>
            ${g.isRunning ? '<span class="gp-chip g"><i class="ph-bold ph-play-circle"></i>در حال اجرا</span>' : ''}
          </div>
          <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:7px">
            <span class="gp-chip b">${esc(cf[g.klass] || g.klass)}</span>
            <span class="gp-chip n">${esc(probeFa)}</span>
            ${(g.regions || []).map(r => `<span class="gp-chip n">${esc((state.catalog && state.catalog.regions[r]) || r)}</span>`).join('')}
          </div>
          ${g.note ? `<div class="gp-sub">${esc(g.note)}</div>` : ''}
          ${(g.tips || []).length ? `<ul style="margin:6px 0 0;padding-inline-start:16px">${g.tips.map(t => `<li class="gp-sub">${esc(t)}</li>`).join('')}</ul>` : ''}
          <!-- THE ONE PIECE OF ADVICE THAT IS LARGER THAN EVERYTHING THIS PANEL CAN CHANGE.
               Borderless-windowed runs through DWM's compositor at all times, which adds a fixed
               8-14ms to every frame. That is bigger than any Windows setting, any NIC property and
               most route choices — and it lives INSIDE the game, so the honest thing is to say it
               rather than pretend a panel can fix it. It is shown for every game because it is
               true for every game. -->
          <div class="gp-sub" style="margin-top:8px;padding:8px 10px;border-radius:9px;background:color-mix(in srgb, var(--mv-orange) 10%, transparent)">
            <b>و یک چیز داخل خود بازی که از همهٔ تنظیمات اینجا بزرگ‌تر است:</b>
            حالت «تمام‌صفحهٔ بدون حاشیه» (Borderless) همیشه از کامپوزیتور ویندوز رد می‌شود و
            <b>۸ تا ۱۴ میلی‌ثانیه</b> تأخیر ثابت به هر فریم اضافه می‌کند. در تنظیمات تصویرِ بازی،
            «تمام‌صفحه» (Exclusive Fullscreen) را انتخاب کنید. این کاری است که فقط از داخل خود بازی
            برمی‌آید — ما نمی‌توانیم عوضش کنیم، ولی نگفتنش هم درست نیست.
          </div>
          ${needsServer ? `
            <div style="margin-top:10px">
              <div class="gp-sub" style="margin-bottom:5px">آدرس سرور (اختیاری ولی توصیه می‌شود — سنجش را از تخمینی به واقعی تبدیل می‌کند):</div>
              <input class="gp-input" id="gp-server" placeholder="مثلاً 51.83.12.44:30120" value="${esc(g.lastServer || '')}">
            </div>` : ''}
          ${warn}
        </div>`;
    }

    function renderRun() {
        const body = $g('gp-run-body');
        if (!body) return;
        const a = state.assess;
        if (!state.selected) { body.innerHTML = '<div class="gp-empty">اول یک بازی انتخاب کن.</div>'; return; }

        if (a.active) {
            const pct = a.total ? Math.round((a.step / a.total) * 100) : 8;
            body.innerHTML = `
              <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
                <span style="font-size:12px;font-weight:700;color:var(--mv-label)">${esc(PHASE_FA[a.phase] || 'در حال اجرا')}</span>
                <span style="font-size:11px;color:var(--mv-label-2);font-family:var(--mv-font-mono)">${a.total ? a.step + '/' + a.total : ''}</span>
              </div>
              <div class="gp-prog"><i style="width:${pct}%"></i></div>
              <canvas id="gp-chart" style="margin-top:10px"></canvas>
              <div class="gp-legend" id="gp-legend"></div>
              <button class="gp-btn danger" id="gp-stop" style="width:100%;margin-top:10px"><i class="ph-bold ph-stop-circle"></i>توقف</button>`;
            $g('gp-stop').onclick = stopAssess;
            drawChart();
            return;
        }

        body.innerHTML = `
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button class="gp-btn primary" id="gp-start" style="flex:1;min-width:150px"><i class="ph-bold ph-play"></i>شروع سنجش کامل</button>
            <button class="gp-btn" id="gp-start-quick"><i class="ph-bold ph-lightning"></i>سریع</button>
          </div>
          <div class="gp-sub" style="margin-top:7px">
            سنجش کامل حدود یک دقیقه طول می‌کشد: ممیزی خط محلی، سپس اندازه‌گیری درهم‌بافته‌ی مسیرها.
            درهم‌بافته یعنی همه‌ی مقصدها هم‌زمان سنجیده می‌شوند تا نوسان ساعت روی نتیجه اثر نگذارد.
          </div>`;
        $g('gp-start').onclick = () => startAssess(false);
        $g('gp-start-quick').onclick = () => startAssess(true);
    }

    // ── live chart ──────────────────────────────────────────────────────────────
    const CHART_COLORS = ['var(--mv-blue-ink)', 'var(--mv-green-ink)', 'var(--mv-yellow-ink)', 'var(--mv-purple-ink)', 'var(--mv-red-ink)', 'var(--mv-teal-ink)'];
    // A canvas cannot read CSS variables: resolve the token when the chart is drawn, so the
    // lines follow the dark/light appearance.
    function cssColor(v) {
        const m = /^var\((--[\w-]+)\)$/.exec(v);
        return m ? getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || v : v;
    }

    function drawChart() {
        const cv = $g('gp-chart');
        if (!cv) return;
        const dpr = window.devicePixelRatio || 1;
        const w = cv.clientWidth || 320, h = 96;
        cv.width = w * dpr; cv.height = h * dpr;
        const ctx = cv.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        const keys = Object.keys(state.chart.series).filter(k => state.chart.series[k].length);
        if (!keys.length) {
            ctx.fillStyle = cssColor('var(--mv-label-4)');
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('در انتظار اولین نمونه…', w / 2, h / 2);
            return;
        }
        let max = 0, min = Infinity;
        for (const k of keys) for (const v of state.chart.series[k]) { if (v > max) max = v; if (v < min) min = v; }
        max = Math.max(max, min + 20);
        const pad = 6;

        // graticule
        ctx.strokeStyle = cssColor('var(--mv-sep)');
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
            const y = pad + ((h - pad * 2) * i) / 4;
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        }

        keys.forEach((k, ki) => {
            const s = state.chart.series[k];
            const n = s.length;
            ctx.strokeStyle = cssColor(CHART_COLORS[ki % CHART_COLORS.length]);
            ctx.lineWidth = 1.4;
            ctx.beginPath();
            s.forEach((v, i) => {
                const x = n === 1 ? w : (i / (n - 1)) * w;
                const y = h - pad - ((v - min) / (max - min || 1)) * (h - pad * 2);
                i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
            });
            ctx.stroke();
        });

        ctx.fillStyle = cssColor('var(--mv-label-3)');
        ctx.font = '9px ui-monospace,monospace';
        ctx.textAlign = 'left';
        ctx.fillText(Math.round(max) + 'ms', 4, 10);
        ctx.fillText(Math.round(min) + 'ms', 4, h - 3);

        // The legend has to distinguish the lines, which a blind prefix truncation did not:
        // anchor labels are «<region> — <operator>» and the region alone runs past 30
        // characters, so three different anchors in Frankfurt all rendered as the same
        // clipped words and the chart became four coloured lines with one name.
        //
        // The operator is the part that differs, so that is what is shown; the full label
        // goes in `title`. When the same operator appears in two regions the region's first
        // word comes back as a prefix, because then IT is the distinguishing half.
        const lg = $g('gp-legend');
        if (lg) {
            const labelOf = (k) => ((state.assess.targets.find(t => t.key === k) || {}).label || k);
            const tailOf = (full) => { const d = full.lastIndexOf('—'); return d > 0 ? full.slice(d + 1).trim() : full; };
            const tails = keys.map(k => tailOf(labelOf(k)));
            const seen = tails.reduce((m, s) => (m[s] = (m[s] || 0) + 1, m), {});
            lg.innerHTML = keys.map((k, i) => {
                const full = labelOf(k);
                let short = tails[i];
                if (seen[short] > 1) short = full.split(/[—(]/)[0].trim().split(/\s+/)[0] + ' · ' + short;
                return `<span title="${esc(full)}"><i style="background:${CHART_COLORS[i % CHART_COLORS.length]}"></i>${esc(short.slice(0, 28))}</span>`;
            }).join('');
        }
    }

    // ── assessment ──────────────────────────────────────────────────────────────
    async function startAssess(quick) {
        if (!state.selected) return;
        const srv = $g('gp-server') ? $g('gp-server').value.trim() : '';
        if (srv) state.selected.lastServer = srv;
        state.assess = { active: true, phase: 'start', step: 0, total: 0, report: null, targets: [], live: {} };
        state.chart = { series: {}, t0: Date.now() };
        $g('gp-verdict-slot').innerHTML = '';
        $g('gp-results-slot').innerHTML = '';
        renderRun();
        const r = await api('/api/game/assess', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gameId: state.selected.id, serverAddr: srv || null, quick: !!quick }),
        });
        if (!r.ok) { state.assess.active = false; renderRun(); uiAlert(r.error || 'شروع سنجش ناموفق بود'); }
    }

    async function stopAssess() {
        await api('/api/game/assess/stop', { method: 'POST' });
        state.assess.active = false;
        renderRun();
    }

    function renderVerdict(v) {
        const slot = $g('gp-verdict-slot');
        if (!slot || !v) return;
        const t = TONE[v.tone] || TONE.neutral;
        slot.innerHTML = `
          <div class="gp-verdict" style="background:${t.bg};border-color:${t.bd}">
            <div class="vt" style="color:${t.c}"><i class="ph-bold ${t.icon}"></i><span>${esc(v.title)}</span></div>
            <ul>${(v.reasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
            ${v.detour != null ? `<div style="margin-top:9px;font-size:11px;color:var(--mv-label-2);font-family:var(--mv-font-mono);direction:ltr;text-align:left">detour = ${Math.round(v.detour)} ms</div>` : ''}
          </div>`;
    }

    function renderResults(report) {
        const slot = $g('gp-results-slot');
        if (!slot) return;
        const rs = report.results || {};
        const keys = Object.keys(rs);
        if (!keys.length) { slot.innerHTML = ''; return; }
        const best = keys.filter(k => rs[k].ok).sort((a, b) => rs[b].score - rs[a].score)[0];
        const tmeta = Object.fromEntries((report.targets || []).map(t => [t.key, t]));

        const rows = keys.map(k => {
            const r = rs[k];
            const meta = tmeta[k] || {};
            const kindChip = meta.kind === 'real'
                ? '<span class="gp-chip g" title="اندازه‌گیری واقعی تا خود مقصد">واقعی</span>'
                : '<span class="gp-chip n" title="لنگر منطقه‌ای — تخمینی">لنگر</span>';
            if (!r.ok) {
                return `<tr><td>${esc(r.label || k)} ${kindChip}</td><td class="n" colspan="6" style="color:var(--mv-red-ink)">پاسخ نداد</td></tr>`;
            }
            const col = r.score >= 70 ? 'var(--mv-green-ink)' : r.score >= 45 ? 'var(--mv-orange-ink)' : 'var(--mv-red-ink)';
            return `<tr class="${k === best ? 'best' : ''}">
              <td><div style="display:flex;gap:5px;align-items:center;flex-wrap:wrap"><span style="font-weight:600">${esc(r.label || k)}</span>${kindChip}${r.correlation === 'fifo' ? '<span class="gp-chip y" title="این پروتکل شناسه‌ی تراکنش ندارد؛ تطبیق به ترتیب ورود است">FIFO</span>' : ''}</div></td>
              <td class="n">${fa(r.min)}</td><td class="n">${fa(r.p50)}</td>
              <td class="n" style="${r.spread > 60 ? 'color:var(--mv-orange-ink)' : ''}">${fa(r.p95)}</td>
              <td class="n">${fa(r.jitter)}</td>
              <td class="n" style="${r.loss > 1 ? 'color:var(--mv-red-ink)' : ''}">${fa(r.loss)}٪</td>
              <td class="n">${fa(r.spikes)}</td>
              <td class="n"><div style="display:flex;align-items:center;gap:6px"><span style="min-width:20px">${r.score}</span><div class="gp-scorebar"><i style="width:${r.score}%;background:${col}"></i></div></div></td>
            </tr>`;
        }).join('');

        const eng = (report.engines || []).map(e => {
            if (!e.available) return `<tr><td>${esc(e.fa)}</td><td class="n" colspan="7" style="color:var(--mv-label-3)">${esc(e.reason || 'در دسترس نیست')}</td></tr>`;
            const r = e.result;
            return `<tr><td>${esc(e.fa)} <span class="gp-chip b">از داخل تونل</span></td>
              <td class="n">${fa(r.min)}</td><td class="n">${fa(r.p50)}</td><td class="n">${fa(r.p95)}</td>
              <td class="n">${fa(r.jitter)}</td><td class="n">${fa(r.loss)}٪</td><td class="n">${fa(r.spikes)}</td>
              <td class="n">${fa(r.score)}</td></tr>`;
        }).join('');

        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h"><i class="ph-bold ph-chart-line" style="color:var(--mv-blue-ink)"></i>نتیجه‌ی اندازه‌گیری</div>
            <div class="gp-tw">
              <table class="gp-t">
                <thead><tr><th>مسیر</th><th class="n">min</th><th class="n">p50</th><th class="n">p95</th><th class="n">jitter</th><th class="n">اتلاف</th><th class="n">پرش</th><th class="n">امتیاز</th></tr></thead>
                <tbody>${rows}${eng}</tbody>
              </table>
            </div>
            <div class="gp-sub" style="margin-top:8px">
              امتیاز بر پایه‌ی p95، jitter، اتلاف و تعداد پرش است — نه میانگین پینگ.
              یک مسیر با min بالاتر ولی دُم کوتاه‌تر عمداً برنده می‌شود، چون در بازی بهتر حس می‌شود.
            </div>
          </div>`;
    }

    function renderAudit(audit) {
        const slot = $g('gp-audit-slot');
        if (!slot || !audit) return;
        const t = TONE[audit.overall] || TONE.neutral;
        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h" style="justify-content:space-between">
              <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-house-line" style="color:var(--mv-indigo-ink)"></i>ممیزی خط محلی</span>
              <span class="gp-chip ${audit.overall === 'ok' ? 'g' : audit.overall === 'warn' ? 'y' : 'r'}">${esc(VERDICT_FA[audit.overall] || audit.overall)}</span>
            </div>
            <div class="gp-sub" style="color:${t.c};margin-bottom:6px">${esc(audit.summary)}</div>
            ${(audit.checks || []).map(c => {
                const cc = c.verdict === 'ok' ? 'var(--mv-green-ink)' : c.verdict === 'warn' ? 'var(--mv-orange-ink)' : c.verdict === 'bad' ? 'var(--mv-red-ink)' : 'var(--mv-label-3)';
                return `<div class="gp-check">
                  <span class="dot" style="background:${cc}"></span>
                  <div class="body">
                    <div class="t">${esc(c.fa)}</div>
                    <div class="d">${esc(c.detail)}</div>
                    ${(c.findings || []).length ? `<ul>${c.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
                  </div>
                </div>`;
            }).join('')}
            <button class="gp-btn" id="gp-bloat" style="width:100%;margin-top:10px"><i class="ph-bold ph-waves"></i>تست تأخیر زیر بار</button>
            <div class="gp-sub" style="margin-top:6px;text-align:center">
              این تست عمداً خط را اشباع می‌کند و تا حدود ۸۰ مگابایت دانلود مصرف می‌کند. روی خط همراه با احتیاط.
            </div>
          </div>`;
        $g('gp-bloat').onclick = runBufferbloat;
    }

    async function runBufferbloat() {
        // Asked, not assumed. Iranian connections are very often metered mobile data, and
        // ~80MB spent on a diagnostic is the user's call to make, not the app's.
        if (!await uiConfirm('این تست خط را برای حدود ۸ ثانیه اشباع می‌کند و تا ۸۰ مگابایت دانلود مصرف می‌کند. ادامه؟')) return;
        const b = $g('gp-bloat');
        if (b) { b.disabled = true; b.innerHTML = '<i class="ph-bold ph-circle-notch"></i>در حال تست…'; }
        try {
            const r = await api('/api/game/bufferbloat', { method: 'POST' });
            if (r.ok) renderBloat(r.result);
        } catch (e) {
            renderBloat({ verdict: 'unknown', fa: 'باف‌ربلوت', detail: 'تست ناموفق بود', findings: [] });
        }
        if (b) { b.disabled = false; b.innerHTML = '<i class="ph-bold ph-waves"></i>تست تأخیر زیر بار'; }
    }

    function renderBloat(r) {
        const slot = $g('gp-bloat-slot');
        if (!slot || !r) return;
        const t = TONE[r.verdict] || TONE.neutral;
        slot.innerHTML = `
          <div class="gp-verdict" style="background:${t.bg};border-color:${t.bd}">
            <div class="vt" style="color:${t.c};font-size:13.5px"><i class="ph-bold ${t.icon}"></i><span>${esc(r.fa)} — ${esc(r.detail)}</span></div>
            ${(r.findings || []).length ? `<ul>${r.findings.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}
          </div>`;
    }

    // NAT gets its own card rather than living only inside the audit list, because for
    // every peer-to-peer game it IS the headline — a player who cannot join their friend
    // does not have a latency problem, and burying that under five other checks would be
    // the wrong emphasis.
    function renderNat(c) {
        const slot = $g('gp-nat-slot');
        if (!slot) return;
        if (!c) {
            slot.innerHTML = `<div class="gp-card"><div class="gp-h"><i class="ph-bold ph-arrows-left-right" style="color:var(--mv-teal-ink)"></i>نوع NAT</div>
              <div class="gp-sub">در حال تشخیص…</div></div>`;
            return;
        }
        const t = TONE[c.verdict] || TONE.neutral;
        const chip = c.verdict === 'ok' ? 'g' : c.verdict === 'warn' ? 'y' : c.verdict === 'bad' ? 'r' : 'n';
        slot.innerHTML = `
          <div class="gp-card" style="background:${t.bg};border-color:${t.bd}">
            <div class="gp-h" style="justify-content:space-between;margin-bottom:6px">
              <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-arrows-left-right" style="color:${t.c}"></i>${esc(c.fa)}</span>
              <span style="display:flex;gap:6px;align-items:center">
                <span class="gp-chip ${chip}">${esc(VERDICT_FA[c.verdict] || c.verdict)}</span>
                <button class="gp-btn" id="gp-nat-again" style="padding:4px 8px;font-size:10.5px"><i class="ph-bold ph-arrows-clockwise"></i></button>
              </span>
            </div>
            <div class="gp-sub" style="font-family:var(--mv-font-mono);direction:ltr;text-align:left;margin-bottom:6px">${esc(c.detail)}</div>
            ${(c.findings || []).length ? `<ul style="margin:0;padding-inline-start:16px">${c.findings.map(f => `<li class="gp-sub">${esc(f)}</li>`).join('')}</ul>` : ''}
          </div>`;
        const b = $g('gp-nat-again');
        if (b) b.onclick = () => loadNat(true);
    }

    async function loadNat(force) {
        if (state.nat && !force) { renderNat(state.nat); return; }
        renderNat(null);
        try {
            const r = await api('/api/game/nat', { method: 'POST' });
            if (r.ok) { state.nat = r.check; renderNat(r.check); }
        } catch {
            renderNat({ verdict: 'unknown', fa: 'نوع NAT — نامشخص', detail: 'تشخیص ناموفق بود', findings: [] });
        }
    }

    // The accelerator.
    //
    // This is the button the whole panel exists to earn the right to show. It routes ONE
    // game through ONE engine and leaves the rest of the machine alone — and it is gated
    // on what was measured, because the research found that on an Iranian line a relay
    // usually makes a game worse. A boost button that quietly costs 30ms is exactly the
    // product this project is trying not to be, so the verdict is shown before the switch,
    // and turning it on against the evidence takes a second, deliberate confirmation.
    const BOOST_TONE = {
        recommended: { ...TONE.ok, fa: 'اندازه‌گیری می‌گوید کمک می‌کند' },
        neutral: { ...TONE.neutral, fa: 'تفاوت معناداری دیده نشد' },
        discouraged: { ...TONE.warn, fa: 'اندازه‌گیری می‌گوید بدترش می‌کند' },
        unmeasured: { ...TONE.neutral, fa: 'هنوز اندازه‌گیری نشده' },
    };

    // Proof, from sing-box's own per-connection log.
    //
    // Without this the switch is an assertion the player has no way to check — and the
    // process rule it depends on CAN fail silently (Windows refuses the process lookup for
    // some sockets). So the panel shows the counts and, when nothing has gone through, says
    // which possibilities remain instead of a green tick.
    const PROOF_TONE = { confirmed: TONE.ok, waiting: TONE.neutral, 'not-matched': TONE.warn, unknown: TONE.neutral, off: TONE.neutral };

    function renderProofBlock() {
        const p = state.boostProof;
        if (!p || p.verdict === 'off') {
            return `<div class="gp-sub" style="opacity:.75">در حال خواندن شاهد از لاگ…</div>`;
        }
        const tn = PROOF_TONE[p.verdict] || TONE.neutral;
        const counts = p.verdict === 'unknown' ? '' : `
            <div style="display:flex;gap:6px;flex-wrap:wrap;margin:7px 0">
              <span class="gp-chip ${p.engine > 0 ? 'g' : 'n'}">${fa(p.engine)} اتصال از موتور</span>
              <span class="gp-chip n">${fa(p.direct)} اتصال مستقیم</span>
              ${p.accessDenied > 0 ? `<span class="gp-chip r">${fa(p.accessDenied)} بار Access denied</span>` : ''}
            </div>`;
        return `
          <div style="border:0;background:${tn.bg};border-radius:9px;padding:10px 11px">
            <div style="display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:${tn.c}">
              <i class="ph-bold ${tn.icon}"></i>${esc(p.fa)}
            </div>
            ${counts}
            ${(p.reasons || []).length ? `<ul style="margin:0;padding-inline-start:16px">${p.reasons.map(r => `<li class="gp-sub">${esc(r)}</li>`).join('')}</ul>` : ''}
          </div>`;
    }

    async function loadProof() {
        if (!state.boost || !state.boost.on) { state.boostProof = null; return; }
        try {
            const r = await api('/api/game/boost/proof');
            if (r.ok) { state.boostProof = r.proof; renderBoost(); }
        } catch {}
    }

    function renderBoost() {
        const slot = $g('gp-boost-slot');
        if (!slot) return;
        const g = state.selected;
        if (!g) { slot.innerHTML = ''; return; }

        const st = state.boost || {};
        const on = !!st.on;
        const ev = state.boostEval;
        const engines = state.boostEngines || [];
        const chosen = engines.find(e => e.id === state.boostEngineId) || engines[0];
        const tone = ev ? (BOOST_TONE[ev.verdict] || TONE.neutral) : TONE.neutral;

        if (on) {
            const mins = Math.max(1, Math.round((Date.now() - (st.startedAt || Date.now())) / 60000));
            slot.innerHTML = `
              <div class="gp-card" style="background:${TONE.ok.bg};border-color:${TONE.ok.bd}">
                <div class="gp-h" style="justify-content:space-between">
                  <span style="display:flex;align-items:center;gap:8px;color:${TONE.ok.c}">
                    <i class="ph-bold ph-rocket-launch" style="font-size:19px"></i>شتاب روشن است
                  </span>
                  <span class="gp-chip g">${esc(String(mins))} دقیقه</span>
                </div>
                <div class="gp-sub" style="margin-bottom:8px">
                  «${esc(st.gameFa || g.fa)}» از ${esc(st.engineFa || '')} می‌رود.
                  بقیه‌ی سیستم — مرورگر، دانلود، لانچر — مستقیم است و دست نخورده.
                </div>
                <div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:9px">
                  ${(st.procs || []).map(p => `<span class="gp-chip n" style="font-family:var(--mv-font-mono);direction:ltr">${esc(p)}</span>`).join('')}
                  ${st.udp === false ? '<span class="gp-chip r">این موتور UDP ندارد</span>' : ''}
                </div>
                <div class="gp-sub" style="margin-bottom:9px">
                  اگر موتور بخوابد فقط بازی قطع می‌شود، نه اینترنت — مسیر پیش‌فرض مستقیم است.
                </div>
                ${renderProofBlock()}
                <button class="gp-btn danger" id="gp-boost-off" style="width:100%;margin-top:9px"${state.boostBusy ? ' disabled' : ''}>
                  <i class="ph-bold ph-power"></i>${state.boostBusy ? 'در حال خاموش کردن…' : 'خاموش کردن شتاب'}
                </button>
              </div>`;
            renderBottomBar();
            const b = $g('gp-boost-off');
            if (b) b.onclick = () => setBoost(false);
            return;
        }

        // Grouped, because the list is now the whole field — six Aether variants, every
        // saved node, the free pool and the tunnel — and a flat select of forty entries is
        // a worse interface than the old one that only had three.
        const GROUP_FA = { aether: 'موتورهای وارپ', saved: 'نودهای خودت', free: 'کانفیگ‌های رایگان', 'github-tunnel': 'تونل کامل' };
        const groupOf = (e) => (e.kind === 'v2ray' ? (e.source === 'free' ? 'free' : 'saved') : e.kind);
        const groups = ['aether', 'saved', 'free', 'github-tunnel'];
        const engineOptions = groups.map(gk => {
            const items = engines.filter(e => groupOf(e) === gk);
            if (!items.length) return '';
            return `<optgroup label="${esc(GROUP_FA[gk] || gk)}">` + items.map(e => `
              <option value="${esc(e.id)}"${e.id === state.boostEngineId ? ' selected' : ''}>
                ${esc(e.fa)}${e.live ? ' ● روشن' : ''}
              </option>`).join('') + '</optgroup>';
        }).join('');

        // Nothing is disabled for being switched off any more: the button starts whatever
        // is chosen. The only thing that can stop it is a request already in flight.
        const canStart = !!chosen && !state.boostBusy;
        const label = ev && ev.verdict === 'discouraged' ? 'با وجود هشدار، روشن کن' : 'روشن کردن شتاب';

        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h"><i class="ph-bold ph-rocket-launch" style="color:var(--mv-green-ink)"></i>شتاب بازی</div>
            <div class="gp-sub" style="margin-bottom:9px">
              فقط ترافیک «${esc(g.fa)}» از موتور انتخابی عبور می‌کند؛ بقیه‌ی سیستم مستقیم می‌ماند.
            </div>

            ${ev ? `<div class="gp-verdict" style="background:${tone.bg};border-color:${tone.bd};margin:0 0 10px">
                <div class="vt" style="color:${tone.c};font-size:13px"><i class="ph-bold ${tone.icon}"></i><span>${esc(ev.fa)}</span></div>
                <ul>${(ev.reasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
              </div>` : ''}

            <div style="display:flex;gap:8px;align-items:center;margin-bottom:9px;flex-wrap:wrap">
              <span class="gp-sub" style="flex:0 0 auto">موتور:</span>
              <select class="gp-input" id="gp-boost-engine" style="flex:1;min-width:150px;direction:rtl;text-align:right">${engineOptions}</select>
            </div>
            ${chosen && chosen.why ? `<div class="gp-sub" style="margin-bottom:6px">${esc(chosen.why)}</div>` : ''}
            ${chosen && chosen.warning ? `<div class="gp-sub" style="color:var(--mv-red-ink);margin-bottom:6px">${esc(chosen.warning)}</div>` : ''}
            ${chosen && !chosen.live ? `<div class="gp-sub" style="color:var(--mv-accent);margin-bottom:6px">این موتور الان روشن نیست — با همین دکمه خودش روشن می‌شود و با خاموش کردن شتاب هم خودش خاموش می‌شود.</div>` : ''}

            <button class="gp-btn ${ev && ev.verdict === 'discouraged' ? '' : 'primary'}" id="gp-boost-on" style="width:100%"${canStart ? '' : ' disabled'}>
              <i class="ph-bold ph-${state.boostBusy ? 'circle-notch' : 'power'}"></i>${state.boostBusy ? 'در حال روشن کردن…' : esc(label)}
            </button>
            <div class="gp-sub" style="margin-top:7px">
              روشن شدن، آداپتور مشترک را از موتورهای وارپ یا تونل V2Ray می‌گیرد. همه‌ی ترافیک از یک لایه‌ی
              نرم‌افزاری رد می‌شود که هزینه‌ی این قابلیت است.
            </div>
          </div>`;

        renderBottomBar();
        const sel = $g('gp-boost-engine');
        if (sel) sel.onchange = () => { state.boostEngineId = sel.value; loadBoost(); };
        const btn = $g('gp-boost-on');
        if (btn) btn.onclick = () => setBoost(true);
    }

    async function setBoost(on, force) {
        state.boostBusy = true;
        renderBoost();
        try {
            if (!on) {
                const r = await api('/api/game/boost/stop', { method: 'POST' });
                if (r.ok) state.boost = r.status;
            } else {
                const r = await api('/api/game/boost/start', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ gameId: state.selected.id, engineId: state.boostEngineId, force: !!force }),
                });
                if (r.needsForce) {
                    // The measured-worse case. Asked, never assumed — and the reasons are
                    // repeated in the prompt so the choice is made with them in view.
                    const why = (r.evaluation && r.evaluation.reasons || []).join('\n');
                    if (await uiConfirm('اندازه‌گیری می‌گوید این موتور بازی را بدتر می‌کند:\n\n' + why + '\n\nباز هم روشن شود؟')) {
                        state.boostBusy = false;
                        return setBoost(true, true);
                    }
                } else if (!r.ok) {
                    uiAlert(r.error || 'روشن نشد');
                } else {
                    state.boost = r.status;
                }
            }
        } catch (e) {
            uiAlert('انجام نشد: ' + (e && e.message ? e.message : e));
        }
        state.boostBusy = false;
        await loadBoost();
    }

    async function loadBoost() {
        if (!state.selected) { state.boostEval = null; renderBoost(); return; }
        try {
            // The free pool is only fetched when it is actually in play — it is megabytes
            // behind a mirror, and the user who never touches it should never pay for it.
            const needFree = String(state.boostEngineId).startsWith('v2ray:free') || state.tourneyOpts.v2rayFree;
            const r = await api(`/api/game/boost?game=${encodeURIComponent(state.selected.id)}&engine=${encodeURIComponent(state.boostEngineId)}${needFree ? '&free=1' : ''}`);
            if (r.ok) {
                state.boost = r.status || { on: false };
                state.boostEngines = r.engines || [];
                state.boostEval = r.evaluation;
                // Land on something that exists. Preference order: keep the current choice
                // if it is still in the list (the tournament winner usually put it there),
                // otherwise whatever is already running, otherwise the first entry.
                if (!state.boostEngines.some(e => e.id === state.boostEngineId)) {
                    const live = state.boostEngines.find(e => e.live) || state.boostEngines[0];
                    if (live) state.boostEngineId = live.id;
                }
            }
        } catch {}
        renderBoost();
    }

    // ── the engine tournament ───────────────────────────────────────────────────
    //
    // The card that makes the rest of this panel usable. Before it, comparing engines meant
    // going to another tab, connecting Aether by hand, coming back, running an assessment,
    // going back, switching protocol, and remembering four numbers. Now one button starts
    // every engine in turn, measures it against the same anchor, stops it, and ranks them.
    //
    // TWO THINGS IT MUST SAY OUT LOUD, BECAUSE THEY ARE TRUE
    //   1. It disrupts. The user's own engines are cycled, so their connection wobbles for
    //      the length of the run. That is stated before the button, not after.
    //   2. «مستقیم بمان» is a green result. A tournament that can only ever crown an engine
    //      would be advertising, not measurement.
    const KIND_FA = { direct: 'مستقیم', aether: 'وارپ', v2ray: 'V2Ray', 'github-tunnel': 'تونل GitHub' };
    const PHASE_T_FA = { starting: 'روشن کردن…', waiting: 'منتظر بالا آمدن…', measuring: 'در حال سنجش…' };

    /** One line per candidate, updated in place — never appended twice for the same id. */
    function tourneyRow(id, patch) {
        const rows = state.tourney.rows;
        // Undefined keys are dropped, not merged: the later phase events carry only `phase`,
        // and spreading their missing `kind`/`fa` over a row that already has them would
        // blank the label halfway through the run.
        const clean = {};
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) clean[k] = v;
        const i = rows.findIndex(r => r.id === id);
        if (i === -1) rows.push({ id, ...clean });
        else rows[i] = { ...rows[i], ...clean };
    }

    function scoreCell(score) {
        const s = Number(score) || 0;
        const col = s >= 70 ? 'var(--mv-green-ink)' : s >= 45 ? 'var(--mv-orange-ink)' : 'var(--mv-red-ink)';
        return `<div style="display:flex;align-items:center;gap:6px">
            <div class="gp-scorebar" style="flex:1"><i style="width:${Math.max(3, Math.min(100, s))}%;background:${col}"></i></div>
            <span class="n" style="color:${col};font-weight:700">${fa(s)}</span></div>`;
    }

    function tourneyTable(rows, { winnerId = null } = {}) {
        return `
          <div class="gp-tw" style="margin-top:9px">
            <table class="gp-t">
              <thead><tr>
                <th>مسیر</th><th style="width:110px">امتیاز</th><th>p95</th><th>min</th><th>اتلاف</th><th>وضعیت</th>
              </tr></thead>
              <tbody>
                ${rows.map(r => {
                    const done = r.result || (r.ok !== undefined ? r : null);
                    const failed = done && !done.ok;
                    return `<tr${winnerId && r.id === winnerId ? ' class="best"' : ''}>
                      <td>
                        <div style="font-weight:700;font-size:11.5px">${esc(r.fa || r.id)}</div>
                        <div class="gp-sub" style="font-size:10px">${esc(KIND_FA[r.kind] || r.kind || '')}${r.exclusive ? ' · انحصاری' : ''}</div>
                      </td>
                      <td>${done && done.ok ? scoreCell(done.score) : '<span class="gp-sub">—</span>'}</td>
                      <td class="n">${done && done.ok ? fa(done.p95) : '—'}</td>
                      <td class="n">${done && done.ok ? fa(done.min) : '—'}</td>
                      <td class="n">${done && done.ok ? fa(done.loss) + '٪' : '—'}</td>
                      <td>
                        ${!done
                            ? `<span class="gp-chip b">${esc(PHASE_T_FA[r.phase] || 'در صف')}</span>`
                            : failed
                                ? `<span class="gp-chip ${done.udp === false ? 'y' : 'r'}">${esc(done.reason || 'ناموفق')}</span>`
                                : '<span class="gp-chip g">سنجیده شد</span>'}
                      </td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table>
          </div>`;
    }

    function renderTourney() {
        const slot = $g('gp-tourney-slot');
        if (!slot) return;
        const g = state.selected;
        if (!g) { slot.innerHTML = ''; return; }

        const t = state.tourney;
        const o = state.tourneyOpts;
        const meta = state.tourneyMeta;

        if (t.running) {
            const pct = t.total ? Math.round((t.done / t.total) * 100) : 0;
            slot.innerHTML = `
              <div class="gp-card">
                <div class="gp-h" style="justify-content:space-between">
                  <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-trophy" style="color:var(--mv-orange-ink)"></i>مسابقه‌ی موتورها</span>
                  <button class="gp-btn danger" id="gp-t-stop" style="padding:5px 10px;font-size:11px"><i class="ph-bold ph-stop"></i>توقف</button>
                </div>
                <div class="gp-sub" style="margin-bottom:7px">
                  ${esc(t.current || 'در حال آماده‌سازی…')} — ${fa(t.done)} از ${fa(t.total)}
                </div>
                <div class="gp-prog"><i style="width:${pct}%"></i></div>
                <div class="gp-sub" style="margin-top:7px;color:var(--mv-orange-ink)">
                  در طول مسابقه اتصالت بالا و پایین می‌شود؛ این طبیعی است. در پایان همه‌چیز به حالت اول برمی‌گردد.
                </div>
                ${t.rows.length ? tourneyTable(t.rows) : ''}
              </div>`;
            const stop = $g('gp-t-stop');
            if (stop) stop.onclick = stopTourney;
            return;
        }

        const rep = t.report;
        const tone = rep ? (TONE[rep.verdict.tone] || TONE.neutral) : TONE.neutral;
        const chk = (id, checked, label, hint) => `
          <label style="display:flex;align-items:flex-start;gap:7px;cursor:pointer;padding:4px 0">
            <input type="checkbox" id="${id}"${checked ? ' checked' : ''} style="margin-top:3px">
            <span><span style="font-size:12px;font-weight:700;color:var(--mv-label)">${esc(label)}</span>
            ${hint ? `<span class="gp-sub" style="display:block">${esc(hint)}</span>` : ''}</span>
          </label>`;

        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h"><i class="ph-bold ph-trophy" style="color:var(--mv-orange-ink)"></i>مسابقه‌ی موتورها</div>
            <div class="gp-sub" style="margin-bottom:9px">
              همه‌ی موتورهای این برنامه را برای «${esc(g.fa)}» با هم مقایسه می‌کند: خودش هرکدام را روشن
              می‌کند، اندازه می‌گیرد، خاموش می‌کند و رتبه می‌دهد. <b>لازم نیست جایی بروی و چیزی را دستی وصل کنی.</b>
              مسیر مستقیم هم به‌عنوان شاهد سنجیده می‌شود، وگرنه «برنده» فقط بهترینِ یک میدان بد است.
            </div>

            ${meta.adapterBusy ? `<div class="gp-sub" style="color:var(--mv-orange-ink);margin-bottom:8px">
              یک تونل (ماسک، وایرگارد، وارپ در وارپ یا V2Ray) روشن است. مسابقه نباید مسیر سیستم را عوض کند، پس اول آن را خاموش کن.
            </div>` : ''}

            <div style="display:flex;flex-direction:column;gap:2px;margin-bottom:8px">
              ${chk('gp-t-aether', o.aether, 'موتورهای وارپ', 'ماسک، وایرگارد و وارپ در وارپ، هرکدام روی دو حالت جستجو')}
              <div style="display:flex;gap:10px;flex-wrap:wrap;padding:2px 22px 6px">
                ${['masque', 'wg', 'gool'].map((p, i) => `
                  <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:11.5px">
                    <input type="checkbox" class="gp-t-proto" data-p="${p}"${o.protocols.includes(p) ? ' checked' : ''}>
                    ${esc(['ماسک', 'وایرگارد', 'وارپ در وارپ'][i])}
                  </label>`).join('')}
                <span class="gp-sub" style="width:100%">حالت جستجو:</span>
                ${['turbo', 'balanced'].map((s, i) => `
                  <label style="display:inline-flex;align-items:center;gap:5px;cursor:pointer;font-size:11.5px">
                    <input type="checkbox" class="gp-t-scan" data-s="${s}"${o.scans.includes(s) ? ' checked' : ''}>
                    ${esc(['توربو', 'متعادل'][i])}
                  </label>`).join('')}
              </div>
              ${chk('gp-t-saved', o.v2raySaved, `نودهای V2Ray خودت (${fa(meta.nodeCount)} تا)`,
                    'به ترتیب پینگ ستون خودت؛ نودهایی که UDP ندارند در ۳ ثانیه حذف می‌شوند')}
              ${chk('gp-t-free', o.v2rayFree, 'کانفیگ‌های رایگان عمومی',
                    'از مخزن «سریع» — بیشترشان Worker اند و UDP ندارند، ولی بعضی نودهای واقعی خوب‌اند')}
              ${chk('gp-t-gt', o.githubTunnel, 'تونل GitHub',
                    'فقط در حالت تونل کامل UDP دارد، پس در نوبت خودش کل مسیر سیستم را موقتاً می‌گیرد. آخر از همه اجرا می‌شود.')}
            </div>

            <div style="display:flex;gap:8px;align-items:center;margin-bottom:9px;flex-wrap:wrap">
              <span class="gp-sub">حداکثر نود:</span>
              <input class="gp-input" id="gp-t-max" type="number" min="1" max="30" value="${fa(o.maxNodes)}" style="width:70px;padding:5px 8px">
              <span class="gp-sub">هر نود حدود ۲۵ ثانیه وقت می‌برد.</span>
            </div>

            <button class="gp-btn primary" id="gp-t-start" style="width:100%"${meta.adapterBusy || t.busy ? ' disabled' : ''}>
              <i class="ph-bold ph-${t.busy ? 'circle-notch' : 'flag-checkered'}"></i>${t.busy ? 'در حال شروع…' : 'شروع مسابقه'}
            </button>

            ${rep ? `
              <div class="gp-verdict" style="background:${tone.bg};border-color:${tone.bd};margin-top:11px">
                <div class="vt" style="color:${tone.c}"><i class="ph-bold ${tone.icon}"></i><span>${esc(rep.verdict.title)}</span></div>
                <ul>${(rep.verdict.reasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
              </div>
              <div class="gp-sub" style="margin-top:7px">هدف مشترک همه: ${esc(rep.target)}${rep.aborted ? ' — این مسابقه نیمه‌کاره متوقف شد.' : ''}${rep.lineLoad ? ` · بار خط هنگام شروع: ${esc(rep.lineLoad.detail)}` : ''}</div>
              ${tourneyTable(rep.ranked || [], { winnerId: rep.winner && rep.beatsDirect ? rep.winner.id : null })}
              ${rep.verdict.code === 'winner' ? `
                <button class="gp-btn primary" id="gp-t-apply" style="width:100%;margin-top:9px">
                  <i class="ph-bold ph-rocket-launch"></i>شتاب را روی «${esc(rep.winner.fa)}» روشن کن
                </button>` : ''}
            ` : ''}
          </div>`;

        const bind = (id, fn) => { const el = $g(id); if (el) fn(el); };
        bind('gp-t-aether', el => el.onchange = () => { state.tourneyOpts.aether = el.checked; });
        bind('gp-t-saved', el => el.onchange = () => { state.tourneyOpts.v2raySaved = el.checked; });
        bind('gp-t-free', el => el.onchange = () => { state.tourneyOpts.v2rayFree = el.checked; });
        bind('gp-t-gt', el => el.onchange = () => { state.tourneyOpts.githubTunnel = el.checked; });
        bind('gp-t-max', el => el.onchange = () => { state.tourneyOpts.maxNodes = Math.max(1, Math.min(30, Number(el.value) || 8)); });
        slot.querySelectorAll('.gp-t-proto').forEach(el => {
            el.onchange = () => {
                const set = new Set(state.tourneyOpts.protocols);
                el.checked ? set.add(el.dataset.p) : set.delete(el.dataset.p);
                state.tourneyOpts.protocols = [...set];
            };
        });
        slot.querySelectorAll('.gp-t-scan').forEach(el => {
            el.onchange = () => {
                const set = new Set(state.tourneyOpts.scans);
                el.checked ? set.add(el.dataset.s) : set.delete(el.dataset.s);
                state.tourneyOpts.scans = [...set];
            };
        });
        bind('gp-t-start', el => el.onclick = startTourney);
        bind('gp-t-apply', el => el.onclick = () => applyWinner(rep.winner));
    }

    async function loadTourney() {
        try {
            const r = await api('/api/game/tournament');
            if (!r.ok) return;
            state.tourneyMeta = {
                nodeCount: r.nodeCount || 0,
                protocols: r.protocols || [],
                scans: r.scans || [],
                adapterBusy: !!r.adapterBusy,
            };
            state.tourney.running = !!r.running;
            if (r.last) state.tourney.report = r.last;
        } catch {}
        renderTourney();
    }

    async function startTourney() {
        const o = state.tourneyOpts;
        if (o.githubTunnel && !await uiConfirm(
            'تونل GitHub فقط در حالت تونل کامل UDP دارد.\n\n' +
            'یعنی در نوبت خودش، برای حدود یک دقیقه، کل ترافیک سیستم از آن رد می‌شود و بعد برمی‌گردد.\n\n' +
            'ادامه بدهم؟')) return;

        state.tourney = { running: true, rows: [], done: 0, total: 0, report: null, busy: true, current: null };
        renderTourney();
        try {
            const r = await api('/api/game/tournament', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    gameId: state.selected.id,
                    maxNodes: o.maxNodes,
                    maxFree: o.maxFree,
                    include: {
                        aether: o.aether,
                        aetherProtocols: o.protocols,
                        aetherScans: o.scans,
                        v2raySaved: o.v2raySaved,
                        v2rayFree: o.v2rayFree,
                        githubTunnel: o.githubTunnel,
                    },
                }),
            });
            state.tourney.busy = false;
            if (!r.ok) {
                state.tourney.running = false;
                uiAlert(r.error || 'مسابقه شروع نشد');
            } else {
                state.tourney.total = r.candidates || 0;
                // Draw the whole field immediately, greyed out. Watching known names light
                // up one by one reads as progress; rows appearing from nowhere reads as a
                // process that might never end.
                tourneyRow('direct', { fa: 'مستقیم (بدون موتور)', kind: 'direct' });
                (r.plan || []).forEach(c => tourneyRow(c.id, { fa: c.fa, kind: c.kind, exclusive: c.exclusive }));
            }
        } catch (e) {
            state.tourney = { ...state.tourney, running: false, busy: false };
            uiAlert('شروع نشد: ' + (e && e.message ? e.message : e));
        }
        renderTourney();
    }

    async function stopTourney() {
        try { await api('/api/game/tournament/stop', { method: 'POST' }); } catch {}
        state.tourney.current = 'در حال توقف…';
        renderTourney();
    }

    /** Hand the winner to the boost card, which is the only thing that can act on it. */
    function applyWinner(winner) {
        if (!winner) return;
        state.boostEngineId = winner.id;
        loadBoost();
        const slot = $g('gp-boost-slot');
        if (slot && slot.scrollIntoView) slot.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Region comparison.
    //
    // For the 46 catalogue games with an in-game region picker, this is the most valuable
    // screen in the panel: a free, instant improvement that needs no tunnel and no server
    // on either side. The advice is phrased as an instruction WITH the menu path, because
    // "eu-central scores 72" is a number, not help.
    function renderRegions() {
        const slot = $g('gp-regions-slot');
        if (!slot) return;
        const r = state.regions, adv = state.regionAdvice, g = state.selected;

        if (state.regionsRunning) {
            const pct = state.regionProgress.total
                ? Math.round(state.regionProgress.step / state.regionProgress.total * 100) : 6;
            slot.innerHTML = `<div class="gp-card">
                <div class="gp-h"><i class="ph-bold ph-globe-hemisphere-east" style="color:var(--mv-teal-ink)"></i>مقایسه‌ی مناطق</div>
                <div class="gp-sub" style="margin-bottom:7px">در حال سنجش همه‌ی مناطق به‌صورت درهم‌بافته…</div>
                <div class="gp-prog"><i style="width:${pct}%"></i></div>
              </div>`;
            return;
        }

        if (!r) {
            const pitch = g && g.regionHint
                ? 'این بازی اجازه می‌دهد منطقه‌ی سرور را خودت انتخاب کنی. بگذار اندازه بگیرم کدام منطقه از خط تو بهتر است — رایگان، فوری، بدون هیچ تونلی.'
                : 'همه‌ی مناطق را از خط تو می‌سنجد و رتبه‌بندی می‌کند. حدود یک دقیقه طول می‌کشد.';
            slot.innerHTML = `<div class="gp-card">
                <div class="gp-h"><i class="ph-bold ph-globe-hemisphere-east" style="color:var(--mv-teal-ink)"></i>مقایسه‌ی مناطق</div>
                <div class="gp-sub" style="margin-bottom:9px">${esc(pitch)}</div>
                <button class="gp-btn primary" id="gp-reg-run" style="width:100%"><i class="ph-bold ph-globe-hemisphere-east"></i>سنجش همه‌ی مناطق</button>
              </div>`;
            const b0 = $g('gp-reg-run');
            if (b0) b0.onclick = runRegions;
            return;
        }

        const rows = r.ranked.map((x, i) => {
            const col = x.score >= 70 ? 'var(--mv-green-ink)' : x.score >= 45 ? 'var(--mv-orange-ink)' : 'var(--mv-red-ink)';
            const mine = g && (g.regions || []).includes(x.region);
            return `<tr class="${i === 0 ? 'best' : ''}">
              <td><span style="font-weight:600">${esc(x.fa)}</span>${mine ? ' <span class="gp-chip b">سرور این بازی</span>' : ''}</td>
              <td class="n">${fa(x.min)}</td><td class="n">${fa(x.p95)}</td>
              <td class="n">${fa(x.jitter)}</td><td class="n">${fa(x.loss)}٪</td>
              <td class="n"><div style="display:flex;align-items:center;gap:6px"><span style="min-width:20px">${x.score}</span><div class="gp-scorebar"><i style="width:${x.score}%;background:${col}"></i></div></div></td>
            </tr>`;
        }).join('');

        const t = adv && adv.hasPicker ? TONE.ok : TONE.neutral;
        const advBlock = adv ? `<div class="gp-verdict" style="background:${t.bg};border-color:${t.bd};margin:0 0 10px">
                <div class="vt" style="color:${t.c};font-size:13.5px"><i class="ph-bold ${adv.hasPicker ? 'ph-target' : 'ph-info'}"></i><span>${adv.hasPicker ? 'این منطقه را در بازی انتخاب کن: ' + esc(adv.best.fa) : 'بهترین منطقه از خط تو: ' + esc(adv.best.fa)}</span></div>
                <ul>${adv.reasons.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
              </div>` : '';

        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h" style="justify-content:space-between">
              <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-globe-hemisphere-east" style="color:var(--mv-teal-ink)"></i>مقایسه‌ی مناطق</span>
              <button class="gp-btn" id="gp-reg-run" style="padding:4px 8px;font-size:10.5px"><i class="ph-bold ph-arrows-clockwise"></i>دوباره</button>
            </div>
            ${advBlock}
            <div class="gp-tw"><table class="gp-t" style="min-width:400px">
              <thead><tr><th>منطقه</th><th class="n">min</th><th class="n">p95</th><th class="n">jitter</th><th class="n">اتلاف</th><th class="n">امتیاز</th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>
            ${r.unreachable && r.unreachable.length ? `<div class="gp-sub" style="margin-top:7px">${r.unreachable.length} منطقه پاسخ نداد و از رتبه‌بندی کنار گذاشته شد.</div>` : ''}
          </div>`;
        const b = $g('gp-reg-run');
        if (b) b.onclick = runRegions;
    }

    async function runRegions() {
        state.regionsRunning = true;
        state.regionProgress = { step: 0, total: 0 };
        renderRegions();
        const r = await api('/api/game/regions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
        if (!r.ok) { state.regionsRunning = false; renderRegions(); uiAlert(r.error || 'شروع نشد'); }
    }

    async function loadRegions() {
        try {
            const q = state.selected ? '?game=' + encodeURIComponent(state.selected.id) : '';
            const r = await api('/api/game/regions' + q);
            if (r.ok) {
                state.regions = r.result;
                state.regionAdvice = r.advice;
                state.regionsRunning = !!r.running;
                renderRegions();
            }
        } catch {}
    }

    // Local fixes.
    //
    // Deliberately NOT a one-click "optimise" button. Each row states what it changes, why,
    // and whether a reboot is needed, and each is reversed individually. A user who cannot
    // see what an app changed on their machine has no way to undo it when something else
    // breaks a month later.
    // ── the one button ──────────────────────────────────────────────────────────
    //
    // Everything the panel can do, behind one action, with a line per step that ticks as it
    // completes. The cards below still exist for anyone who wants to drive a single lever by
    // hand, but nobody should have to know they exist to get their game accelerated.
    //
    // A step reports one of four states and the UI shows all four honestly: `done` is a green
    // tick, `skipped` is a grey dash WITH ITS REASON (it usually means "this was already
    // right", which is information), and `failed` is red without stopping the rest. Hiding
    // skipped steps would make the list look like a marketing checklist instead of a report.
    const ACCEL_ICON = {
        pending: { i: 'ph-circle', c: 'var(--mv-label-3)' },
        running: { i: 'ph-circle-notch', c: 'var(--mv-accent)' },
        done: { i: 'ph-check-circle', c: 'var(--mv-green-ink)' },
        skipped: { i: 'ph-minus-circle', c: 'var(--mv-label-2)' },
        failed: { i: 'ph-x-circle', c: 'var(--mv-red-ink)' },
    };

    /** Styles for the resolver table. Injected once, next to the panel's own. */
    (function injectDnsStyle() {
        if (document.getElementById('gp-dns-style')) return;
        const el = document.createElement('style');
        el.id = 'gp-dns-style';
        el.textContent = `
      .gp-dnslist { display:flex; flex-direction:column; gap:4px; max-height:230px; overflow-y:auto; }
      .gp-dnsrow { display:flex; align-items:center; gap:8px; width:100%; text-align:start;
        padding:6px 9px; border-radius:9px; font-family:inherit; font-size:11.5px; cursor:pointer;
        background:var(--ide-bg-inset, rgba(255,255,255,.04));
        border:1px solid var(--mv-sep, rgba(255,255,255,.10));
        color:var(--mv-label, #EDEDED); }
      .gp-dnsrow:hover:not([disabled]) { border-color:var(--mv-accent); }
      .gp-dnsrow[disabled] { opacity:.45; cursor:default; }
      .gp-dnsrow .nm { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .gp-dnsrow .ms { opacity:.6; font-variant-numeric:tabular-nums; }`;
        document.head.appendChild(el);
    })();

    function renderAccel() {
        const slot = $g('gp-accel-slot');
        if (!slot) return;
        const g = state.selected;
        if (!g) { slot.innerHTML = ''; return; }

        const a = state.accel || {};
        const running = !!a.running;
        const steps = a.steps || ACCEL_STEPS_FALLBACK;
        const st = a.stepState || {};
        const sum = a.summary;
        const active = a.active;

        const stepRow = (s) => {
            const cur = st[s.id] || { status: 'pending' };
            const ic = ACCEL_ICON[cur.status] || ACCEL_ICON.pending;
            const spin = cur.status === 'running' ? 'animation:gp-spin 1s linear infinite;' : '';
            return `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0">
              <i class="ph-bold ${ic.i}" style="color:${ic.c};font-size:16px;margin-top:1px;${spin}"></i>
              <span style="min-width:0">
                <span style="font-size:12px;font-weight:${cur.status === 'pending' ? '400' : '700'};color:${cur.status === 'pending' ? 'var(--mv-label-3)' : 'var(--mv-label)'}">${esc(s.fa)}</span>
                ${cur.detail ? `<span class="gp-sub" style="display:block;line-height:1.75">${esc(cur.detail)}</span>` : ''}
                ${s.id === 'dns' ? dnsTable() : ''}
              </span>
            </div>`;
        };

        /**
         * What every resolver could actually do for this game, and a way to overrule the winner.
         *
         * The ranking is honest but it cannot be complete: on this line eight providers open every
         * domain the game needs, and which of them a particular person should use depends on
         * things no measurement here can see — their operator, the hour, what their other
         * applications need. So the table is shown and the choice is theirs.
         */
        function dnsTable() {
            const scan = state.accel && state.accel.dnsScan;
            if (!scan || !scan.rows || !scan.rows.length) return '';
            if (!state.accel.dnsOpen) {
                return `<button class="gp-btn" id="gp-dns-toggle" style="margin-top:6px;font-size:11.5px;padding:5px 9px">
                          <i class="ph-bold ph-list-magnifying-glass"></i>جدول رزولورها (${fa(scan.rows.length)})
                        </button>`;
            }
            const rows = scan.rows.map(r => {
                const good = r.resolved === r.total && r.reachable === true;
                const tone = good ? 'g' : r.resolved > 0 ? 'y' : 'r';
                // «جواب نداد» and «آدرسش کار نکرد» are different failures and the user has to be
                // able to tell them apart: one resolver was the FASTEST here and returned an
                // address nothing was listening on.
                const verdict = r.resolved === 0 ? 'هیچ دامنه‌ای را باز نکرد'
                    : r.reachable === false ? 'آدرسی که داد جواب نداد'
                        : `${fa(r.resolved)} از ${fa(r.total)}`;
                return `<button class="gp-dnsrow" data-dns="${esc(r.id)}" ${r.resolved ? '' : 'disabled'}>
                          <span class="gp-chip ${tone}">${esc(verdict)}</span>
                          <span class="nm">${esc(r.fa)}</span>
                          <span class="ms">${fa(Math.round(r.ms))}ms</span>
                        </button>`;
            }).join('');
            return `<div style="margin-top:7px">
                      <div class="gp-sub" style="margin-bottom:5px">با دامنه‌های ${(scan.domains || []).map(esc).join('، ')} سنجیده شد. هرکدام را بزنید تا همان فعال شود.</div>
                      <div class="gp-dnslist">${rows}</div>
                    </div>`;
        }

        const anyState = Object.keys(st).length > 0;

        slot.innerHTML = `
          <div class="gp-card" style="background:linear-gradient(180deg,color-mix(in srgb, var(--mv-green) 10%, transparent),color-mix(in srgb, var(--mv-blue) 6%, transparent));border-color:color-mix(in srgb, var(--mv-green) 30%, transparent)">
            <div class="gp-h"><i class="ph-bold ph-list-checks" style="color:var(--mv-green-ink);font-size:18px"></i>جزئیات شتاب‌دهی</div>

            ${running || (active && active.on) ? ''
                : `
                   <label for="gp-accel-full" style="display:flex;align-items:flex-start;gap:9px;cursor:pointer;
                          border:var(--mv-hl) solid var(--mv-sep);border-radius:11px;padding:10px 11px">
                     <input type="checkbox" id="gp-accel-full" style="margin-top:2px;flex:none"${state.accelFull ? ' checked' : ''}>
                     <span>
                       <span style="font-size:12.5px;font-weight:700">بقیهٔ برنامه‌ها کاملاً متوقف شوند</span>
                       <span class="gp-sub" style="display:block;margin-top:3px">
                         مرورگر، پیام‌رسان‌ها و هرچه باز است <b>متوقف</b> می‌شوند تا رم و پردازنده آزاد شود —
                         هیچ‌کدام تا وقتی شتاب روشن است جواب نمی‌دهند. موتورهای اتصال و ابزارهای ویندوز دست نمی‌خورند،
                         و وقتی بازی بسته شود همه‌چیز خودکار برمی‌گردد.
                       </span>
                     </span>
                   </label>`}

            ${anyState ? `<div style="margin-top:11px;border-top:1px solid var(--mv-sep);padding-top:8px">
              ${steps.map(stepRow).join('')}
            </div>` : ''}

            ${sum ? `<div style="border:0;background:color-mix(in srgb, var(--mv-green) 8%, transparent);border-radius:10px;padding:11px;margin-top:10px">
              <div style="font-size:12.5px;font-weight:700;color:var(--mv-green-ink);display:flex;align-items:center;gap:7px">
                <i class="ph-bold ph-check-circle"></i>${esc(sum.headline)}
              </div>
              ${sum.direct ? `<div class="gp-sub" style="margin-top:6px">مسیر مستقیم هنگام سنجش: min ${fa(sum.direct.min)}ms · p95 ${fa(sum.direct.p95)}ms · اتلاف ${fa(sum.direct.loss)}٪</div>` : ''}
              ${sum.directBlocked ? '<div class="gp-sub" style="margin-top:6px;color:var(--mv-orange-ink)">مسیر مستقیم بسته بود — برای بازی‌های تحریم‌شده یا فیلترشده عادی است.</div>' : ''}
              ${(sum.notes || []).length ? `<ul style="margin:7px 0 0;padding-inline-start:16px">${sum.notes.map(n => `<li class="gp-sub" style="line-height:1.8">${esc(n)}</li>`).join('')}</ul>` : ''}
              ${(sum.undo || []).length ? `<div class="gp-sub" style="margin-top:7px">آنچه تغییر کرد: ${esc((sum.undo || []).join(' · '))}</div>` : ''}
            </div>` : ''}

          </div>`;

        renderHero();
        const dnsToggle = $g('gp-dns-toggle');
        if (dnsToggle) dnsToggle.onclick = () => { state.accel.dnsOpen = true; renderAccel(); };
        slot.querySelectorAll('[data-dns]').forEach(b => {
            b.onclick = async () => {
                const id = b.getAttribute('data-dns');
                b.disabled = true;
                const r = await api('/api/game/dns/apply', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id }),
                });
                b.disabled = false;
                if (!r || !r.ok) { await uiAlert((r && r.error) || 'DNS عوض نشد'); return; }
                await uiAlert(`DNS روی «${r.fa}» رفت. با «توقف شتاب» به حالت قبل برمی‌گردد.`);
                loadAccel();
            };
        });

        const full = $g('gp-accel-full');
        if (full) full.onchange = () => { state.accelFull = !!full.checked; };
    }

    async function stopAccel() {
        try { await api('/api/game/accelerate/stop', { method: 'POST' }); } catch { /* it may already be gone */ }
    }

    /**
     * One way out, and it undoes everything — not a "revert" hidden next to a "run again".
     * The machine is re-read afterwards rather than assumed: a partial revert (one piece
     * refusing for want of admin) must leave the page saying «still on», not «all clear».
     */
    async function revertAccel() {
        if (!await uiConfirm({ title: 'برگرداندن', message: 'همه‌ی تغییرات این شتاب‌دهی برگردانده می‌شود: محدودیت‌های ترافیک، تنظیمات ویندوز، DNS و خودِ شتاب. ادامه؟' })) return;
        try {
            const r = await api('/api/game/accelerate/revert', { method: 'POST' });
            await uiAlert(r.reverted && r.reverted.length ? r.reverted.join('\n') : 'چیزی برای برگرداندن نبود.');
        } catch { await uiAlert('برگرداندن ناموفق بود'); }
        state.accel = { ...(state.accel || {}), summary: null, stepState: {}, active: null };
        renderAccel();
        await loadAccel();
        loadShaper(true); loadTweaks(); loadBoost();
    }

    const ACCEL_STEPS_FALLBACK = [
        { id: 'detect', fa: 'شناسایی بازی و وضعیت خط' },
        { id: 'line', fa: 'معطوف‌سازی اینترنت فقط به بازی' },
        { id: 'pc', fa: 'معطوف‌سازی کامپیوتر به بازی' },
        { id: 'dns', fa: 'اصلاح DNS بازی' },
        { id: 'direct', fa: 'سنجش مسیر مستقیم' },
        { id: 'path', fa: 'انتخاب سریع‌ترین مسیر' },
        { id: 'region', fa: 'بهترین منطقه‌ی سرور بازی' },
    ];

    async function loadAccel() {
        try {
            const r = await api('/api/game/accelerate');
            if (r.ok) {
                state.accel = {
                    ...(state.accel || {}),
                    running: r.running,
                    steps: r.steps || ACCEL_STEPS_FALLBACK,
                    summary: r.last || (state.accel && state.accel.summary) || null,
                    active: r.active || null,
                    stepState: (state.accel && state.accel.stepState) || {},
                };
                renderAccel();
            }
        } catch { /* the panel works without it */ }
    }

    async function startAccel() {
        if (!state.selected) return;
        state.accel = {
            ...(state.accel || {}),
            running: true, summary: null, stepState: {},
            steps: (state.accel && state.accel.steps) || ACCEL_STEPS_FALLBACK,
        };
        renderAccel();
        try {
            const r = await api('/api/game/accelerate', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                // Off unless the user ticked it. The server defaults it off too — this is not
                // the only guard, it is the one the user can see.
                body: JSON.stringify({ gameId: state.selected.id, full: !!state.accelFull }),
            });
            if (!r.ok) {
                state.accel.running = false; renderAccel();
                await uiAlert(r.error || 'شتاب‌دهی شروع نشد');
            }
        } catch (e) {
            state.accel.running = false; renderAccel();
            await uiAlert('شروع نشد: ' + (e && e.message ? e.message : e));
        }
    }

    // ── more than one internet connection ───────────────────────────────────────
    //
    // The card is deliberately readable with ONE uplink too, because that is what most
    // users will open it with: it then explains what a second connection would buy them
    // instead of showing an empty comparison and looking broken.
    const UP_ICON = { wifi: 'ph-wifi-high', ethernet: 'ph-network', cellular: 'ph-cell-signal-full', tether: 'ph-usb' };

    function renderUplinks() {
        const slot = $g('gp-uplinks-slot');
        if (!slot) return;
        const u = state.uplinks;
        if (!u) { slot.innerHTML = ''; return; }
        const ups = u.uplinks || [];
        const rep = u.last;
        const running = !!u.running;
        const single = ups.length < 2;

        const rowFor = (x) => {
            const r = rep && (rep.ranked || []).find(z => z.uplinkId === x.id);
            const won = rep && rep.best && rep.best.uplinkId === x.id && rep.trustworthy;
            return `<div style="border:0;background:${won ? 'color-mix(in srgb, var(--mv-green) 8%, transparent)' : 'var(--mv-fill)'};border-radius:9px;padding:9px 11px;margin-bottom:7px">
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                <span style="display:flex;align-items:center;gap:7px;min-width:0">
                  <i class="ph-bold ${UP_ICON[x.kind] || 'ph-network'}" style="color:${won ? 'var(--mv-green-ink)' : 'var(--mv-label-2)'}"></i>
                  <span style="min-width:0">
                    <span style="font-size:12px;font-weight:700;color:var(--mv-label)">${esc(x.alias)}</span>
                    <span class="gp-sub" style="display:block">${esc(x.fa)} · <span style="font-family:var(--mv-font-mono);direction:ltr">${esc(x.ip)}</span></span>
                  </span>
                </span>
                <span style="display:flex;gap:5px;align-items:center;flex-shrink:0">
                  ${x.active ? '<span class="gp-chip g">در حال استفاده</span>' : ''}
                  ${!x.active && !single ? `<button class="gp-btn" data-up-prefer="${esc(x.id)}" style="padding:4px 9px;font-size:10.5px">این را استفاده کن</button>` : ''}
                </span>
              </div>
              ${r ? (r.ok
                ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:7px">
                     <span class="gp-chip ${won ? 'g' : 'n'}">امتیاز ${fa(r.score)}</span>
                     <span class="gp-chip n">min ${fa(r.min)}ms</span>
                     <span class="gp-chip n">p95 ${fa(r.p95)}ms</span>
                     <span class="gp-chip ${r.loss > 0 ? 'y' : 'n'}">اتلاف ${fa(r.loss)}٪</span>
                   </div>`
                : `<div class="gp-sub" style="margin-top:6px;color:var(--mv-red-ink)">${esc(r.reason || 'پاسخی نیامد')}</div>`) : ''}
            </div>`;
        };

        const v = rep && rep.verdict;
        const vTone = v ? (v.code === 'inconclusive' ? TONE.warn : v.code === 'none' ? TONE.bad : TONE.ok) : null;

        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h" style="justify-content:space-between">
              <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-shuffle" style="color:var(--mv-blue-ink)"></i>چند اینترنت</span>
              ${u.canRestore ? '<button class="gp-btn" id="gp-up-restore" style="padding:4px 8px;font-size:10.5px">بازگرداندن اولویت‌ها</button>' : ''}
            </div>
            <div class="gp-sub" style="margin-bottom:9px">
              ${single
                ? 'با یک اینترنت دوم (هات‌اسپات گوشی با کابل USB کافی است) می‌شود سنجید کدام برای بازی بهتر است و روی همان رفت. چون ترافیک بازی از موتور بیرون می‌رود، سرور بازی IP موتور را می‌بیند نه IP تو — پس عوض کردن اینترنت، نشست بازی را نمی‌شکند.'
                : 'هر اینترنت با همان ترنِ واقعی بازی سنجیده می‌شود، بدون اینکه اتصال فعلی‌ات عوض شود. برای اینترنت غیرفعال یک مسیر موقت فقط به همان یک آدرس ساخته و بعدش پاک می‌شود.'}
            </div>

            ${ups.length ? ups.map(rowFor).join('') : '<div class="gp-sub">هیچ اتصال اینترنتی سالمی پیدا نشد.</div>'}

            ${v ? `<div style="border:0;background:${vTone.bg};border-radius:9px;padding:10px 11px;margin-top:8px">
              <div style="display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;color:${vTone.c}">
                <i class="ph-bold ${vTone.icon}"></i>${esc(v.title)}
              </div>
              <ul style="margin:6px 0 0;padding-inline-start:16px">${(v.reasons || []).map(x => `<li class="gp-sub">${esc(x)}</li>`).join('')}</ul>
            </div>` : ''}

            <button class="gp-btn primary" id="gp-up-compare" style="width:100%;margin-top:9px" ${running ? 'disabled' : ''}>
              <i class="ph-bold ${running ? 'ph-circle-notch' : 'ph-gauge'}"></i>${running ? 'در حال سنجش…' : (single ? 'همین اینترنت را بسنج' : 'اینترنت‌ها را مقایسه کن')}
            </button>

            ${single ? '' : `
            <div style="border-top:1px solid var(--mv-sep);margin-top:11px;padding-top:10px">
              <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer">
                <input type="checkbox" id="gp-up-failover" ${u.watch && u.watch.on ? 'checked' : ''} style="margin-top:3px">
                <span>
                  <span style="font-size:12px;font-weight:700;color:var(--mv-label)">اگر اینترنت فعلی خراب شد، خودکار جابه‌جا شو</span>
                  <span class="gp-sub" style="display:block">
                    تنها چیزی در این پنل که خودش عمل می‌کند — پس فقط <b>وقتی شتاب روشن است</b> کار می‌کند،
                    و فقط بعد از ${fa(3)} سنجشِ بدِ پشت‌سرهم. قبل از جابه‌جایی، اینترنت دیگر را هم می‌سنجد تا
                    روی چیزی بدتر نرود.
                    ${u.boostOn ? '' : '<b style="color:var(--mv-orange-ink)">الان شتاب خاموش است، پس این نگهبان بی‌کار می‌ماند.</b>'}
                  </span>
                </span>
              </label>
              ${u.watch && u.watch.on && u.watch.strikes ? `<div class="gp-sub" style="margin-top:6px;color:var(--mv-orange-ink)">${fa(u.watch.strikes)} سنجش بد پشت‌سرهم ثبت شده.</div>` : ''}
            </div>`}
          </div>`;

        const c = $g('gp-up-compare');
        if (c) c.onclick = () => uplinkAction('compare', {}, c);
        const rs = $g('gp-up-restore');
        if (rs) rs.onclick = () => uplinkAction('restore', {}, rs);
        slot.querySelectorAll('[data-up-prefer]').forEach(b => b.onclick = () =>
            uplinkAction('prefer', { id: b.dataset.upPrefer }, b));
        const fo = $g('gp-up-failover');
        if (fo) fo.onchange = async () => {
            try {
                const r = await api('/api/game/uplinks/failover', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ on: fo.checked }),
                });
                if (!r.ok) uiAlert(r.error || 'انجام نشد');
            } catch { uiAlert('انجام نشد'); }
            loadUplinks();
        };
    }

    async function loadUplinks() {
        try {
            const r = await api('/api/game/uplinks');
            if (r.ok) { state.uplinks = r; renderUplinks(); }
        } catch { /* the panel works without it */ }
    }

    async function uplinkAction(what, body, btn) {
        // Changing which internet the machine uses is a real change to the user's system,
        // and unlike a measurement it does not undo itself.
        if (what === 'prefer' && !await uiConfirm('اینترنت پیش‌فرض ویندوز روی این اتصال می‌رود. اگر موتور روشن باشد ممکن است چند ثانیه قطع و دوباره وصل شود. ادامه؟')) return;
        const original = btn ? btn.innerHTML : null;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph-bold ph-circle-notch"></i>…'; }
        try {
            const r = await api('/api/game/uplinks/' + what, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
            });
            if (!r.ok) uiAlert(r.error || 'انجام نشد');
            else if (r.note) uiAlert(r.note);
        } catch { uiAlert('انجام نشد'); }
        if (btn) { btn.disabled = false; if (original) btn.innerHTML = original; }
        await loadUplinks();
    }

    // ── traffic shaping ─────────────────────────────────────────────────────────
    //
    // The card exists because of one measurement: with the line busy, p95 to Frankfurt read
    // 457ms and looked like a broken route; idle, the same anchor read 124ms. So this is not
    // a tidiness feature — it is the largest single latency effect this panel can act on.
    //
    // It says plainly what it cannot do. Windows has no way to throttle INBOUND traffic from
    // user space, so a download is blocked or it is left alone; promising a download limiter
    // would be a lie with a green switch on it.
    /**
     * «پایش حین بازی» — the only thing here that is present when the lag actually happens.
     *
     * Every other card acts before a match and then the player goes and plays. This samples while
     * they do, and afterwards names what each spike coincided with — upload, download, a Wi-Fi rate
     * collapse, a pinned CPU, or nothing on this machine at all, which is itself the answer.
     */
    function renderWatch() {
        const slot = $g('gp-watch-slot');
        if (!slot) return;
        const w = state.watch || {};
        const st = w.status || {};
        const rep = w.report || null;
        const on = !!st.running;

        const spikeRows = rep && rep.ok && rep.spikes.length
            ? rep.spikes.slice(0, 8).map(sp => {
                const t = new Date(sp.at).toLocaleTimeString('fa-IR');
                const cause = (sp.blame || []).map(b => b.fa).join(' · ');
                const tone = (sp.blame || []).some(b => b.actionable) ? 'y' : 'n';
                return `<div class="gp-sub" style="padding:5px 0;border-top:1px solid var(--mv-sep)">
                          <span class="gp-chip ${tone}">${esc(t)}</span>
                          p95 ${fa(sp.p95)}ms${sp.loss > 0 ? ` · اتلاف ${fa(sp.loss)}٪` : ''}
                          <span style="display:block;margin-top:2px">${esc(cause)}</span>
                        </div>`;
            }).join('')
            : '';

        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h"><i class="ph-bold ph-pulse" style="color:var(--mv-red)"></i>پایش حین بازی${on ? '<span class="gp-chip g">روشن</span>' : ''}</div>
            <p class="gp-sub">
              بقیهٔ کارت‌ها <b>قبل</b> از بازی کار می‌کنند. این یکی همان موقعی که لگ می‌خورید آنجاست:
              هر پنج ثانیه یک نمونه می‌گیرد و بعد می‌گوید هر پرش هم‌زمان با چه چیزی بود — آپلود
              خودتان، افت نرخ وای‌فای، پر شدن پردازنده، یا هیچ‌کدام.
            </p>
            ${on ? `<div class="gp-sub" style="margin-top:6px">${fa(st.samples || 0)} نمونه گرفته شده${st.gameFa ? ` — ${esc(st.gameFa)}` : ''}</div>` : ''}
            ${rep && rep.ok ? `
              <div style="margin-top:9px;padding:10px;border-radius:10px;background:color-mix(in srgb, var(--mv-blue) 8%, transparent)">
                <div style="font-size:12.5px;font-weight:700">${esc(rep.headline)}</div>
                <div class="gp-sub" style="margin-top:4px">پایهٔ خط ${fa(rep.baseP50)}ms · بدترین لحظه ${fa(rep.worstP95)}ms · ${fa(rep.samples)} نمونه</div>
                ${spikeRows}
              </div>` : (rep && rep.reason ? `<div class="gp-sub" style="margin-top:8px">${esc(rep.reason)}</div>` : '')}
            <button class="gp-btn ${on ? 'danger' : ''}" id="gp-watch-toggle" style="width:100%;margin-top:9px">
              <i class="ph-bold ${on ? 'ph-stop-circle' : 'ph-play-circle'}"></i>${on ? 'توقف پایش و دیدن گزارش' : 'شروع پایش'}
            </button>
            <div class="gp-sub" style="margin-top:6px">
              هزینه‌اش ناچیز است: هر نمونه حدود یک کیلوبایت. بازی را شروع کنید، این را روشن بگذارید،
              و بعد از بازی گزارش را ببینید. هیچ تنظیمی را عوض نمی‌کند — فقط نگاه می‌کند.
            </div>
          </div>`;

        const b = $g('gp-watch-toggle');
        if (b) b.onclick = async () => {
            b.disabled = true;
            const body = on
                ? { stop: true }
                : { gameId: state.selected ? state.selected.id : null };
            const r = await api('/api/game/watch', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            b.disabled = false;
            if (!r || !r.ok) { await uiAlert((r && r.error) || 'انجام نشد'); return; }
            if (on && r.report) state.watch = { status: { running: false, samples: 0 }, report: r.report };
            else state.watch = { status: r.status || { running: true, samples: 0 }, report: null };
            renderWatch();
        };
    }

    async function loadWatch() {
        const r = await api('/api/game/watch');
        state.watch = (r && r.ok) ? { status: r.status, report: r.report } : { status: { running: false }, report: null };
        renderWatch();
    }

    /**
     * «صف مودم» — upload bufferbloat, and the only cure for it that lives on this side.
     *
     * Measured on a real line: with the uplink saturated, p95 went from 126ms to 2681ms and 29% of
     * packets were lost. That is not a slow game, it is a disconnected one, and nothing else in
     * this panel touches it — engines, regions and resolvers all sit downstream of the queue that
     * is filling.
     */
    function renderQueue() {
        const slot = $g('gp-queue-slot');
        if (!slot) return;
        const q = state.queue || {};
        const cap = q.cap || { on: false };
        const last = q.last || null;
        const busy = !!q.busy;

        const verdictChip = last
            ? (last.verdict === 'bad' ? '<span class="gp-chip r">صف مودم پر می‌شود</span>'
                : last.verdict === 'warn' ? '<span class="gp-chip y">کمی پر می‌شود</span>'
                    : last.verdict === 'ok' ? '<span class="gp-chip g">مشکلی ندارد</span>'
                        : '<span class="gp-chip n">نامشخص</span>')
            : '';

        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h"><i class="ph-bold ph-queue" style="color:var(--mv-orange)"></i>صف مودم (باف‌ربلوت آپلود)${verdictChip}</div>
            <p class="gp-sub">
              وقتی آپلود شما پر می‌شود، صف داخل مودم پر می‌شود و <b>همه‌ی</b> بسته‌ها پشت آن معطل
              می‌مانند — از جمله بسته‌های بازی. روی یک خط واقعی اندازه گرفتیم: p95 از ۱۲۶ به
              ۲۶۸۱ میلی‌ثانیه رفت و ۲۹٪ بسته‌ها گم شدند. هیچ موتور و منطقه و DNSای این را درست
              نمی‌کند، چون مشکل بعد از آن‌ها اتفاق می‌افتد.
            </p>
            ${last ? `<div class="gp-sub" style="margin-top:6px"><b>آخرین سنجش:</b> ${esc(last.detail || '')}</div>` : ''}
            ${cap.on
                ? `<div class="gp-chip g" style="margin-top:8px;display:inline-block">سقف آپلود روشن است — ${fa(cap.kbps)} کیلوبیت بر ثانیه</div>
                   <button class="gp-btn danger" id="gp-queue-off" style="width:100%;margin-top:8px">برداشتن سقف</button>`
                : (last && last.suggestKbps > 0
                    ? `<button class="gp-btn primary" id="gp-queue-on" style="width:100%;margin-top:8px">
                         <i class="ph-bold ph-gauge"></i>بستن سقف آپلود روی ${fa(last.suggestKbps)} کیلوبیت بر ثانیه
                       </button>` : '')}
            <button class="gp-btn" id="gp-queue-test" style="width:100%;margin-top:8px"${busy ? ' disabled' : ''}>
              <i class="ph-bold ${busy ? 'ph-circle-notch' : 'ph-activity'}"${busy ? ' style="animation:gp-spin 1s linear infinite"' : ''}></i>${busy ? 'در حال سنجش…' : (last ? 'سنجش دوباره' : 'سنجش صف مودم')}
            </button>
            <div class="gp-sub" style="margin-top:6px">
              این سنجش حدود ۱۰ تا ۲۴ مگابایت <b>آپلود</b> مصرف می‌کند و پانزده ثانیه طول می‌کشد.
              روی خط همراه، این هزینه‌ی واقعی است — برای همین خودکار اجرا نمی‌شود. نتیجه‌اش ذخیره
              می‌شود و از آن به بعد «شتاب‌دهی» سقف را رایگان اعمال می‌کند.
            </div>
          </div>`;

        const t = $g('gp-queue-test');
        if (t) t.onclick = async () => {
            if (!await uiConfirm('این سنجش حدود ۱۰ تا ۲۴ مگابایت آپلود مصرف می‌کند. ادامه؟')) return;
            state.queue = { ...(state.queue || {}), busy: true };
            renderQueue();
            const r = await api('/api/game/upbloat', { method: 'POST' });
            state.queue = { busy: false, cap: (r && r.cap) || { on: false }, last: r && r.result ? { ...r.result, suggestKbps: r.result.data && r.result.data.suggestKbps } : null };
            renderQueue();
            if (r && r.result) await uiAlert(r.result.detail || 'سنجش تمام شد');
        };
        const on = $g('gp-queue-on');
        if (on) on.onclick = async () => {
            const r = await api('/api/game/egress', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ kbps: last.suggestKbps }),
            });
            if (!r || !r.ok) { await uiAlert((r && r.error) || 'اعمال نشد'); return; }
            state.queue = { ...(state.queue || {}), cap: r.cap };
            renderQueue();
            if (r.note) await uiAlert(r.note);
        };
        const off = $g('gp-queue-off');
        if (off) off.onclick = async () => {
            const r = await api('/api/game/egress', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ off: true }),
            });
            if (!r || !r.ok) { await uiAlert((r && r.error) || 'برداشته نشد'); return; }
            state.queue = { ...(state.queue || {}), cap: r.cap };
            renderQueue();
        };
    }

    async function loadQueue() {
        const r = await api('/api/game/egress');
        // Render either way. Returning early on a failed read left the card missing entirely, with
        // nothing on screen to say why — and this card's whole job is to tell the user about a
        // problem they have no other way to see.
        if (!r || !r.ok) { state.queue = { busy: false, cap: { on: false }, last: null }; renderQueue(); return; }
        state.queue = {
            busy: false, cap: r.cap || { on: false },
            last: r.last ? { detail: null, verdict: r.last.verdict, suggestKbps: r.last.suggestKbps } : null,
        };
        renderQueue();
    }

    function renderShaper() {
        const slot = $g('gp-shaper-slot');
        if (!slot) return;
        const s = state.shaper;
        if (!s) { slot.innerHTML = ''; return; }
        const rules = s.rules || [];
        const cands = (s.candidates || []).filter(c => !c.protected).slice(0, 8);
        const load = s.load;
        const busy = load && load.verdict !== 'ok';

        slot.innerHTML = `
          <div class="gp-card"${busy ? ' style="border-color:color-mix(in srgb, var(--mv-orange) 35%, transparent);background:color-mix(in srgb, var(--mv-orange) 6%, transparent)"' : ''}>
            <div class="gp-h" style="justify-content:space-between">
              <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-flow-arrow" style="color:var(--mv-orange-ink)"></i>شکل‌دهی ترافیک</span>
              <span style="display:flex;gap:6px">
                <button class="gp-btn" id="gp-sh-refresh" style="padding:4px 8px;font-size:10.5px"><i class="ph-bold ph-arrows-clockwise"></i>تازه‌سازی</button>
                ${rules.length ? '<button class="gp-btn" id="gp-sh-restore-all" style="padding:4px 8px;font-size:10.5px">بازگرداندن همه</button>' : ''}
              </span>
            </div>
            <div class="gp-sub" style="margin-bottom:9px">
              بزرگ‌ترین دشمن پینگ تو معمولاً خودِ کامپیوترت است: با پخش ویدیو، p95 ما به فرانکفورت
              ۴۵۷ شد و شبیه مسیر خراب دیده می‌شد؛ با خط آزاد همان مقصد ۱۲۴ بود.
              <b>ویندوز بدون درایور کرنلی نمی‌تواند دانلود را محدود کند</b> — پس «محدود کردن» فقط روی
              آپلود اثر دارد، و برای یک دانلود سنگین تنها راه واقعی «قطع» است.
            </div>

            ${load ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:9px">
              <span class="gp-chip ${busy ? 'y' : 'g'}">بار خط: ${esc(load.detail)}</span>
            </div>` : ''}

            ${rules.length ? `<div style="margin-bottom:10px">
              ${rules.map(r => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;border:0;background:color-mix(in srgb, var(--mv-orange) 7%, transparent);border-radius:9px;padding:8px 10px;margin-bottom:6px">
                <span style="font-size:11.5px;color:var(--mv-label)">
                  <b style="font-family:var(--mv-font-mono);direction:ltr">${esc(r.exe)}</b>
                  — ${r.mode === 'block' ? 'قطع شده' : `محدود به ${fa(r.kbps)} کیلوبیت بر ثانیه (آپلود)`}
                </span>
                <button class="gp-btn" data-sh-restore="${esc(r.exe)}" style="padding:4px 9px;font-size:10.5px"><i class="ph-bold ph-arrow-counter-clockwise"></i>برگردان</button>
              </div>`).join('')}
            </div>` : ''}

            <div class="gp-sub" style="margin-bottom:6px">برنامه‌هایی که همین حالا اتصال بیرونی باز دارند:</div>
            ${cands.length ? cands.map(c => `
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;border:0;border-radius:9px;padding:8px 10px;margin-bottom:6px;background:var(--mv-fill)">
                <span style="min-width:0">
                  <span style="font-size:11.5px;font-weight:700;color:var(--mv-label);font-family:var(--mv-font-mono);direction:ltr">${esc(c.name)}</span>
                  <span class="gp-sub" style="display:block">${esc(c.fa || 'اتصال بیرونی فعال')} · ${fa(c.conns)} اتصال</span>
                </span>
                <span style="display:flex;gap:5px;flex-shrink:0">
                  <button class="gp-btn" data-sh-limit="${esc(c.name)}" data-sh-path="${esc(c.path || '')}" style="padding:4px 9px;font-size:10.5px">محدود کن</button>
                  <button class="gp-btn danger" data-sh-block="${esc(c.name)}" data-sh-path="${esc(c.path || '')}" style="padding:4px 9px;font-size:10.5px">قطع کن</button>
                </span>
              </div>`).join('') : '<div class="gp-sub" style="opacity:.7">هیچ برنامه‌ی دیگری اتصال بیرونی فعالی ندارد — خط برای بازی آزاد است.</div>'}
          </div>`;

        const rf = $g('gp-sh-refresh');
        if (rf) rf.onclick = () => loadShaper(true);
        const ra = $g('gp-sh-restore-all');
        if (ra) ra.onclick = () => shaperAction('restore-all', {}, ra);
        slot.querySelectorAll('[data-sh-limit]').forEach(b => b.onclick = () =>
            shaperAction('apply', { exe: b.dataset.shLimit, path: b.dataset.shPath || null, mode: 'limit', kbps: 512 }, b));
        slot.querySelectorAll('[data-sh-block]').forEach(b => b.onclick = () =>
            shaperAction('apply', { exe: b.dataset.shBlock, path: b.dataset.shPath || null, mode: 'block' }, b));
        slot.querySelectorAll('[data-sh-restore]').forEach(b => b.onclick = () =>
            shaperAction('restore', { exe: b.dataset.shRestore }, b));
    }

    async function loadShaper(force) {
        if (state.shaperBusy && !force) return;
        state.shaperBusy = true;
        try {
            const r = await api('/api/game/shaper');
            if (r.ok) { state.shaper = r; renderShaper(); }
        } catch { /* the panel works without it */ }
        state.shaperBusy = false;
    }

    async function shaperAction(what, body, btn) {
        // Blocking a process kills its network. That is the point, and it is also exactly
        // the kind of thing a user should not discover by accident.
        if (what === 'apply' && body.mode === 'block'
            && !await uiConfirm(`ترافیک «${body.exe}» تا وقتی خودت برنگردانی قطع می‌شود. ادامه؟`)) return;
        const original = btn ? btn.innerHTML : null;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph-bold ph-circle-notch"></i>…'; }
        try {
            const r = await api('/api/game/shaper/' + what, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body || {}),
            });
            if (!r.ok) uiAlert(r.error || 'انجام نشد');
            else if (r.note) uiAlert(r.note);
        } catch { uiAlert('انجام نشد'); }
        if (btn) { btn.disabled = false; if (original) btn.innerHTML = original; }
        await loadShaper(true);
    }

    function renderTweaks() {
        const slot = $g('gp-tweaks-slot');
        if (!slot) return;
        const list = state.tweaks || [];
        if (!list.length) { slot.innerHTML = ''; return; }
        const anyBackup = list.some(t => t.hasBackup);

        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h" style="justify-content:space-between">
              <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-wrench" style="color:var(--mv-orange-ink)"></i>اصلاحات محلی</span>
              ${anyBackup ? '<button class="gp-btn" id="gp-tw-restore-all" style="padding:4px 8px;font-size:10.5px">بازگرداندن همه</button>' : ''}
            </div>
            <div class="gp-sub" style="margin-bottom:9px">
              هر تغییر قبل از اعمال، مقدار فعلی سیستم شما را ذخیره می‌کند و هر لحظه قابل بازگشت است.
              هیچ‌کدام خودکار اعمال نمی‌شوند.
            </div>
            ${list.map(t => {
                const state_ = !t.available ? 'n' : t.applied ? 'g' : 'y';
                const stateFa = !t.available ? 'در دسترس نیست' : t.applied ? 'اعمال شده' : 'اعمال نشده';
                return `<div style="border:0;border-radius:9px;padding:10px 11px;margin-bottom:8px;background:var(--mv-fill)">
                  <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:5px">
                    <span style="font-size:12px;font-weight:700;color:var(--mv-label);line-height:1.6">${esc(t.fa)}</span>
                    <span class="gp-chip ${state_}">${esc(stateFa)}</span>
                  </div>
                  <div class="gp-sub" style="margin-bottom:6px">${esc(t.why)}</div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                    <span class="gp-chip n" style="font-family:var(--mv-font-mono);direction:ltr">${esc(t.target)}</span>
                    <span class="gp-chip n">اکنون: ${esc(t.current)}</span>
                    ${t.needsReboot ? '<span class="gp-chip y">نیازمند ری‌استارت</span>' : ''}
                  </div>
                  <div style="display:flex;gap:6px;margin-top:8px">
                    ${t.available && !t.applied ? `<button class="gp-btn" data-tw-apply="${esc(t.id)}" style="padding:5px 10px;font-size:11px"><i class="ph-bold ph-check"></i>اعمال کن</button>` : ''}
                    ${t.hasBackup ? `<button class="gp-btn" data-tw-restore="${esc(t.id)}" style="padding:5px 10px;font-size:11px"><i class="ph-bold ph-arrow-counter-clockwise"></i>بازگرداندن به ${esc(t.backupValue)}</button>` : ''}
                  </div>
                </div>`;
            }).join('')}
          </div>`;

        slot.querySelectorAll('[data-tw-apply]').forEach(b => b.onclick = () => tweakAction('apply', b.dataset.twApply, b));
        slot.querySelectorAll('[data-tw-restore]').forEach(b => b.onclick = () => tweakAction('restore', b.dataset.twRestore, b));
        const ra = $g('gp-tw-restore-all');
        if (ra) ra.onclick = () => tweakAction('restore-all', null, ra);
    }

    async function tweakAction(what, id, btn) {
        const original = btn ? btn.innerHTML : null;
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="ph-bold ph-circle-notch"></i>…'; }
        try {
            const r = await api('/api/game/tweaks/' + what, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(id ? { id } : {}),
            });
            if (!r.ok) uiAlert(r.error || 'انجام نشد');
            else if (r.result && r.result.needsReboot && what === 'apply') {
                uiAlert('اعمال شد، ولی تا ری‌استارت ویندوز اثر نمی‌کند.');
            }
        } catch (e) { uiAlert('انجام نشد'); }
        if (btn) { btn.disabled = false; if (original) btn.innerHTML = original; }
        await loadTweaks();
    }

    async function loadTweaks() {
        try {
            const r = await api('/api/game/tweaks');
            if (r.ok) { state.tweaks = r.tweaks || []; renderTweaks(); }
        } catch {}
    }

    function renderProfiles() {
        const slot = $g('gp-profiles-slot');
        if (!slot) return;
        if (!state.profiles.length) { slot.innerHTML = ''; return; }
        const rows = state.profiles.slice(0, 8).map(p => {
            const age = p.ageMs < 3600e3 ? Math.round(p.ageMs / 60e3) + ' دقیقه'
                : p.ageMs < 86400e3 ? Math.round(p.ageMs / 3600e3) + ' ساعت'
                : Math.round(p.ageMs / 86400e3) + ' روز';
            const best = Object.entries(p.paths || {}).sort((a, b) => b[1].score - a[1].score)[0];
            return `<tr>
              <td>${esc((state.catalog && (state.catalog.games.find(g => g.id === p.gameId) || {}).fa) || p.gameId)}</td>
              <td>${esc(p.bucketFa || p.bucket)}</td>
              <td>${esc(p.region)}</td>
              <td class="n">${best ? best[1].min + '/' + best[1].p95 : '—'}</td>
              <td class="n">${best ? best[1].score : '—'}</td>
              <td class="n" style="color:var(--mv-label-3)">${esc(age)}</td>
            </tr>`;
        }).join('');
        slot.innerHTML = `
          <div class="gp-card">
            <div class="gp-h" style="justify-content:space-between">
              <span style="display:flex;align-items:center;gap:8px"><i class="ph-bold ph-clock-counter-clockwise" style="color:var(--mv-orange-ink)"></i>پروفایل‌های ذخیره‌شده</span>
              <button class="gp-btn" id="gp-clear-prof" style="padding:4px 8px;font-size:10.5px">پاک کردن</button>
            </div>
            <div class="gp-tw"><table class="gp-t" style="min-width:360px">
              <thead><tr><th>بازی</th><th>بازه</th><th>منطقه</th><th class="n">min/p95</th><th class="n">امتیاز</th><th class="n">سن</th></tr></thead>
              <tbody>${rows}</tbody>
            </table></div>
            <div class="gp-sub" style="margin-top:7px">
              پروفایل‌ها بعد از یک هفته منقضی می‌شوند — مسیر اینترنت ایران هفتگی عوض می‌شود و
              یک توصیه‌ی کهنه بدتر از نبودِ توصیه است.
            </div>
          </div>`;
        $g('gp-clear-prof').onclick = async () => { await api('/api/game/profiles/clear', { method: 'POST' }); loadProfiles(); };
    }

    // ── websocket ───────────────────────────────────────────────────────────────
    window.handleGameEvent = function (ev) {
        // The DNS scan reports one resolver at a time; the finished table comes with `done`.
        if (ev && ev.kind === 'accel' && ev.type === 'dns-row') {
            state.accel = state.accel || {};
            state.accel.dnsLive = (state.accel.dnsLive || 0) + 1;
            return;
        }
        if (!ev) return;
        if (ev.kind === 'assess') {
            const a = state.assess;
            switch (ev.type) {
                case 'phase': a.phase = ev.phase; a.active = true; renderRun(); break;
                case 'targets': a.targets = ev.targets || []; break;
                case 'progress':
                    a.step = ev.step; a.total = ev.total;
                    if (ev.points && ev.points.length) {
                        state.chart.series[ev.key] = (state.chart.series[ev.key] || []).concat(ev.points);
                    }
                    renderRun();
                    break;
                case 'saved': loadProfiles(); break;
                case 'audit': state.audit = ev.audit; renderAudit(ev.audit); break;
                case 'results': drawChart(); break;
                case 'engines': a.engines = ev.engines; break;
                case 'done':
                    a.active = false; a.report = ev.report;
                    renderRun(); renderVerdict(ev.report.verdict); renderResults(ev.report);
                    if (ev.report.audit) renderAudit(ev.report.audit);
                    loadProfiles();
                    break;
                case 'error':
                    a.active = false; renderRun();
                    renderVerdict({ tone: 'bad', title: 'سنجش ناموفق بود', reasons: [ev.error] });
                    break;
            }
            return;
        }
        if (ev.kind === 'audit') {
            state.audit = ev.audit;
            renderAudit(ev.audit);
            // The assessment's audit re-measures NAT too; keep the dedicated card in step.
            const n = (ev.audit.checks || []).find(c => c.id === 'nat');
            if (n) { state.nat = n; renderNat(n); }
            return;
        }
        if (ev.kind === 'nat' && ev.check) { state.nat = ev.check; renderNat(ev.check); return; }
        if (ev.kind === 'tweaks' && ev.list) { state.tweaks = ev.list; renderTweaks(); return; }
        if (ev.kind === 'accel') {
            const a = state.accel = state.accel || { stepState: {} };
            a.stepState = a.stepState || {};
            if (ev.type === 'start') {
                a.running = true; a.steps = ev.steps || a.steps; a.stepState = {}; a.summary = null;
            } else if (ev.type === 'step') {
                a.stepState[ev.id] = { status: ev.status, detail: ev.detail };
            } else if (ev.type === 'done') {
                a.running = false; a.summary = ev.summary;
                // The resolver table travels with `done`, so it is still there after the run
                // finishes — a measurement the user cannot look at afterwards may as well not
                // have been taken.
                if (ev.done && ev.done.dnsScan) a.dnsScan = ev.done.dnsScan;
                loadAccel();   // the button becomes a state — read it from the machine
                // The pipeline changed real things — every card that reads system state is
                // now stale.
                loadShaper(true); loadTweaks(); loadBoost(); loadProfiles();
            } else if (ev.type === 'error') {
                a.running = false;
                uiAlert(ev.error || 'شتاب‌دهی ناموفق بود');
            } else if (ev.type === 'reverted') {
                a.running = false; a.summary = null; a.stepState = {};
            }
            renderAccel();
            return;
        }
        // The watcher ticks every five seconds; updating the count from the event avoids a poll.
        if (ev.kind === 'watch') {
            if (ev.type === 'sample' && state.watch && state.watch.status) {
                state.watch.status.samples = (state.watch.status.samples || 0) + 1;
                renderWatch();
            }
            return;
        }
        if (ev.kind === 'shaper') { loadShaper(true); return; }
        if (ev.kind === 'uplinks') {
            // Every event type here ends with the same need: re-read the list, which also
            // carries `running` and the finished report.
            if (ev.type === 'error') uiAlert(ev.error || 'مقایسه‌ی اینترنت‌ها ناموفق بود');
            loadUplinks();
            return;
        }
        if (ev.kind === 'boost') {
            if (ev.status) state.boost = ev.status;
            if (ev.type === 'error') uiAlert(ev.error);
            loadBoost();
            return;
        }
        if (ev.kind === 'tournament') {
            const t = state.tourney;
            switch (ev.type) {
                case 'start':
                    t.running = true; t.total = ev.total || 0; t.done = 0; t.report = null;
                    t.rows = [{ id: 'direct', fa: 'مستقیم (بدون موتور)', kind: 'direct' }]
                        .concat((ev.candidates || []).map(c => ({ id: c.id, fa: c.fa, kind: c.kind, exclusive: c.exclusive })));
                    renderTourney();
                    break;
                case 'candidate':
                    t.running = true;
                    t.current = `${ev.fa}${PHASE_T_FA[ev.phase] ? ' — ' + PHASE_T_FA[ev.phase] : ''}`;
                    // `engineKind` — the server deliberately does not call it `kind`, which
                    // is the envelope this switch routes on.
                    tourneyRow(ev.id, { fa: ev.fa, kind: ev.engineKind, exclusive: ev.exclusive, phase: ev.phase });
                    renderTourney();
                    break;
                case 'result':
                    t.done = ev.done || t.done; t.total = ev.total || t.total;
                    tourneyRow(ev.result.id, { ...ev.result, result: ev.result, phase: null });
                    renderTourney();
                    break;
                case 'done':
                    t.running = false; t.current = null; t.report = ev.report;
                    renderTourney();
                    // The winner may now be a running engine, or every engine may have been
                    // put back — either way the boost card's picture is stale.
                    loadBoost();
                    break;
                case 'saved':
                    // The race is now in the profile store, which is the only thing the
                    // boost verdict reads. Without this the button keeps saying
                    // "not measured yet" about the measurement that just finished.
                    loadProfiles();
                    loadBoost();
                    break;
                case 'error':
                    t.running = false; t.current = null;
                    renderTourney();
                    uiAlert(ev.error);
                    break;
            }
            return;
        }
        if (ev.kind === 'regions') {
            if (ev.type === 'progress') { state.regionProgress = { step: ev.step, total: ev.total }; renderRegions(); }
            else if (ev.type === 'done' || ev.type === 'saved') { state.regionsRunning = false; loadRegions(); }
            else if (ev.type === 'error') { state.regionsRunning = false; renderRegions(); uiAlert(ev.error); }
            return;
        }
        if (ev.kind === 'bufferbloat' && ev.result) { renderBloat(ev.result); return; }
        if (ev.kind === 'installed' && ev.phase === 'scanning') {
            const box = $g('gp-games');
            if (box && box.querySelector('.gp-empty')) {
                box.querySelector('.gp-empty').textContent = `در حال بررسی ${ev.done}/${ev.total} — ${ev.name || ''}`;
            }
        }
    };

    // ── init ────────────────────────────────────────────────────────────────────
    let inited = false;
    window.initGameModule = async function () {
        const host = $g('ls-game');
        if (!host || inited) return;
        inited = true;
        const style = document.createElement('style');
        style.textContent = CSS;
        document.head.appendChild(style);
        host.innerHTML = HTML;

        host.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent;';
        if (host.parentElement) {
            host.parentElement.style.position = 'relative';
            host.parentElement.style.padding = '0';
            host.parentElement.style.overflow = 'hidden';
        }

        $g('game-wrapper').querySelectorAll('.mv-side-item[data-gp-sec]').forEach((b) => {
            b.onclick = () => goSec(b.getAttribute('data-gp-sec'));
        });
        $g('gp-back').onclick = () => goSec('boost');
        $g('gp-rescan').onclick = () => loadInstalled(true);
        $g('gp-toggle-all').onclick = () => { state.browseAll = !state.browseAll; renderGames(); };
        $g('gp-search').oninput = (e) => { state.query = e.target.value; renderGames(); };
        goSec('boost');

        // The desktop lamp: this window changes the machine, so whether it has is worth
        // seeing from outside it.
        window.MVProbe = window.MVProbe || {};
        window.MVProbe.game = () => !!(state.accel && state.accel.active && state.accel.active.on);

        await loadCatalog();
        await loadInstalled(false);
        await loadProfiles();
        renderRun();
        loadNat(false);   // ~6s, and nothing else waits on it
        loadTweaks();     // read-only; nothing is applied until the user clicks
        loadShaper();     // lists who is on the line and what we already shaped; changes nothing
        loadQueue();      // the modem-queue card: reads the saved measurement and whether a cap is on
        loadWatch();      // …and whether a session is being watched right now
        loadUplinks();    // lists the machine's internet connections; measures nothing yet
        loadRegions();    // shows the previous comparison if there is one; measures nothing
        loadBoost();      // reads whether acceleration is on; starts nothing
        loadTourney();    // shows the last ranking if there is one; measures nothing

        // The running set is the only thing that changes on its own while the panel is
        // open, and it is a 40ms call, so a slow poll is cheaper than any alternative.
        setInterval(async () => {
            if (!$g('ls-game') || $g('ls-game').style.display === 'none') return;
            const before = state.running.map(r => r.id).join(',');
            await loadRunning();
            if (state.running.map(r => r.id).join(',') !== before) { renderGames(); renderCtx(); }
        }, 6000);

        window.addEventListener('resize', () => { if (state.assess.active) drawChart(); });
    };
})();
