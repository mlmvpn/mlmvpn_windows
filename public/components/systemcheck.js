// --- Startup and «بررسی سیستم» -------------------------------------------------
// Two jobs, split since the macOS redesign:
//
//   STARTUP — the Mac's boot screen (startBoot): a black screen, the mark and one bar that
//     follows the real module inits reported by safeInit(), then the desktop fades up. A
//     module that failed to load is named in a banner afterwards. Nothing to press.
//
//   «بررسی سیستم» (openSystemCheck) — live connectivity checks against the hosts each
//     feature depends on. Every one is a real round-trip performed by the Node side; the
//     latency shown is the measured one. Opened on demand (tools folder, Ctrl+K, Help menu),
//     skippable at any moment. Until the redesign these ran on every start.
//
// Loaded at the TOP of <body> on purpose. Everything else in this app is a bottom-of-body
// script, so mounting here is what makes the boot screen paint before the rest of the page
// exists rather than flashing in after it.
//
// The no-hang guarantee has three layers, because a startup screen that jams is worse
// than no startup screen at all:
//   1. the server caps every probe (8s);
//   2. the client puts its own AbortController deadline on each request, so a dead
//      socket cannot outlive the row that is waiting on it;
//   3. the boot has a wall-clock escape hatch (waitForLoad), so even a module that hangs
//      during init cannot hold the app shut.

(function () {
    'use strict';

    // The boot screen can never hold the user longer than this, whatever the page is doing.
    var PHASE1_MAX_WAIT = 15000;
    // Client-side ceiling per probe. Slightly above the server's 8s so a server-side
    // timeout reports its own, more specific message before this fires.
    var PROBE_DEADLINE = 10000;

    // ── phase 1: features ────────────────────────────────────────────────────
    // `inits` are the safeInit names that must have run; `verify` is an extra runtime
    // assertion for scripts that expose no init function. A group passes only if both
    // hold — otherwise the row shows as failed and names what is missing.
    var FEATURES = [
        { key: 'core', label: 'هسته و رابط کاربری', icon: 'ph-cube',
          verify: function () { return typeof window.uiConfirm === 'function' || typeof window.uiAlert === 'function'; } },
        { key: 'scanner', label: 'اسکنر آی‌پی', icon: 'ph-crosshair',
          inits: ['initScanModule'],
          verify: function () { return typeof window.startScan === 'function' && !!document.getElementById('results-body'); } },
        { key: 'history', label: 'تاریخچه و آرشیو', icon: 'ph-clock',
          inits: ['initHistoryModule', 'initArchiveModule'] },
        { key: 'quick', label: 'اتصال سریع', icon: 'ph-lightning',
          inits: ['initQuickModule'] },
        { key: 'v2ray', label: 'کانفیگ‌های V2Ray', icon: 'ph-plugs-connected',
          inits: ['initV2rayModule', 'initComboModule'] },
        { key: 'cloud', label: 'پنل ابری کلادفلر', icon: 'ph-cloud',
          inits: ['initCloudModule'] },
        { key: 'sanction', label: 'تحریم‌شکن', icon: 'ph-lock-open',
          inits: ['initSanctionModule'] },
        { key: 'dedidns', label: 'DNS اختصاصی و پاکسازی DNS', icon: 'ph-hard-drives',
          inits: ['initDediDnsModule'],
          verify: function () { return typeof window.openDnsCleanTab === 'function'; } },
        { key: 'gst', label: 'تونل گوگل اسکریپت', icon: 'ph-google-logo',
          inits: ['initGstModule'] },
        { key: 'openvpn', label: 'اوپن‌وی‌پی‌ان', icon: 'ph-shield-check',
          inits: ['initOpenVpnModule'] },
        // `initVodiModule`, NOT `initX4gModule`. The function was renamed with the panel
        // (X4G → VodiWalker) and this watchdog kept the old name, so the mark it waits for
        // was never recorded and every launch reported «railway» as a section that failed to
        // load — while the panel itself had loaded perfectly. A boot check that cries wolf
        // is worse than no boot check: it teaches the user to ignore the one real warning.
        { key: 'vodi', label: 'railway', icon: 'ph-network',
          inits: ['initVodiModule'] },
        { key: 'aether', label: 'ماسک، وایرگارد، وارپ در وارپ', icon: 'ph-shield',
          inits: ['initAetherModule'] },
        { key: 'sni', label: 'SNI و ضد DPI', icon: 'ph-intersect',
          inits: ['initSniModule'] },
        { key: 'monitor', label: 'مانیتور و تست سرعت', icon: 'ph-chart-line-up',
          inits: ['initMonitorModule', 'initLiveSpeedModule', 'initSpeedTestModule', 'initHeaderTrafficModule'] },
        { key: 'settings', label: 'تنظیمات و راهنما', icon: 'ph-sliders',
          inits: ['initSettingsModule', 'initGuideModule', 'initAboutModule'] },
    ];

    // ── phase 2: live checks ─────────────────────────────────────────────────
    // Order matters: internet first, because every row below it is meaningless without
    // it, and DNS second, because a hijacked resolver explains most of what follows.
    var CHECKS = [
        { id: 'internet',   label: 'اتصال اینترنت',            icon: 'ph-wifi-high',   why: 'پایه‌ی همه‌ی بخش‌ها' },
        { id: 'dns',        label: 'DNS سیستم شما',            icon: 'ph-hard-drives', why: 'تعیین‌کننده‌ی باز شدن دامنه‌ها' },
        { id: 'cloudflare', label: 'دسترسی به API کلادفلر',    icon: 'ph-cloud-arrow-up', why: 'برای دیپلوی پنل‌های ابری' },
        { id: 'worker',     label: 'دسترسی به دامنه‌ی ورکر',   icon: 'ph-code',        why: 'برای کارکرد پنل‌های ساخته‌شده' },
        { id: 'railway',    label: 'دسترسی به Railway',        icon: 'ph-train',       why: 'برای برنامهٔ railway' },
        { id: 'google',     label: 'دسترسی به Google Script',  icon: 'ph-google-logo', why: 'برای تونل گوگل اسکریپت' },
        { id: 'sanction',   label: 'وضعیت تحریم‌شکن',          icon: 'ph-lock-open',   why: 'مسیردهی سایت‌های تحریمی' },
        { id: 'dedidns',    label: 'وضعیت DNS اختصاصی',        icon: 'ph-globe-hemisphere-west', why: 'ضد فیلتر و انتخاب ریجن' },
        { id: 'wireguard',  label: 'وضعیت وایرگارد',           icon: 'ph-shield',      why: 'تونل WARP' },
    ];

    var state = {
        phase: 1,
        marks: {},          // safeInit name -> { ok, err }
        featureResults: {}, // feature key -> 'ok' | 'fail'
        checkResults: {},
        aborted: false,
        running: null,      // AbortController of the in-flight probe
        closed: false,
        loadFired: false,
    };

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function fa(n) {
        try { return Number(n).toLocaleString('fa-IR'); } catch (e) { return String(n); }
    }

    // ── styles ───────────────────────────────────────────────────────────────
    // Inlined rather than shipped as a separate .css so the overlay is styled on its
    // very first paint; a stylesheet request here would show one frame of raw markup.
    var CSS = [
        // Above everything: the app's own modals already climb to 1000001, and this one
        // is the gate in front of all of them.
        '#sc-overlay{position:fixed;inset:0;z-index:2000000;display:flex;align-items:center;justify-content:center;',
        'background:var(--mv-scrim);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
        'font-family:"IRANSansX","Vazirmatn",sans-serif;opacity:0;transition:opacity .28s ease;}',
        '#sc-overlay.sc-in{opacity:1;}',
        '#sc-overlay.sc-out{opacity:0;pointer-events:none;}',

        '.sc-card{width:min(760px,calc(100vw - 40px));max-height:calc(100vh - 60px);display:flex;flex-direction:column;',
        'background:var(--ide-panel,#1B1C1F);border:1px solid var(--ide-border,#393B40);border-radius:18px;',
        'box-shadow:0 30px 80px rgba(0,0,0,.6);overflow:hidden;transform:scale(.96) translateY(8px);',
        'transition:transform .3s cubic-bezier(.2,.8,.3,1);}',
        '#sc-overlay.sc-in .sc-card{transform:none;}',

        '.sc-head{display:flex;align-items:center;gap:14px;padding:20px 22px 16px;border-bottom:1px solid var(--ide-border,#393B40);}',
        '.sc-head-icon{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;',
        'background:color-mix(in srgb, var(--mv-blue) 14%, transparent);color:var(--syn-blue,#3574F0);font-size:22px;flex:none;}',
        '.sc-head-txt{flex:1;min-width:0;}',
        '.sc-title{font-size:15px;font-weight:700;color:var(--ide-text-main,#DFE1E5);}',
        '.sc-sub{font-size:12px;color:var(--ide-text-muted,#A0A6AD);margin-top:3px;}',
        '.sc-step{font-size:11px;color:var(--ide-text-dim,#6F737A);background:var(--ide-bg,#2B2D30);',
        'border:1px solid var(--ide-border,#393B40);border-radius:999px;padding:4px 10px;flex:none;}',

        '.sc-body{padding:16px 20px;overflow-y:auto;flex:1;}',

        // phase 1 grid
        '.sc-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}',
        '@media (max-width:640px){.sc-grid{grid-template-columns:1fr;}}',
        '.sc-feat{display:flex;align-items:center;gap:10px;padding:9px 11px;border-radius:10px;',
        'background:var(--ide-bg,#2B2D30);border:1px solid transparent;transition:border-color .2s,background .2s;',
        'opacity:.45;}',
        '.sc-feat.done{opacity:1;border-color:color-mix(in srgb, var(--mv-green) 32%, transparent);}',
        '.sc-feat.failed{opacity:1;border-color:color-mix(in srgb, var(--mv-red) 40%, transparent);background:color-mix(in srgb, var(--mv-red) 7%, transparent);}',
        '.sc-feat-ico{font-size:16px;color:var(--ide-text-muted,#A0A6AD);flex:none;}',
        '.sc-feat.done .sc-feat-ico{color:var(--syn-green,#5FAD65);}',
        '.sc-feat.failed .sc-feat-ico{color:var(--syn-red,#DB5C5C);}',
        '.sc-feat-lbl{flex:1;min-width:0;font-size:12.5px;color:var(--ide-text-main,#DFE1E5);',
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
        '.sc-feat-st{flex:none;width:16px;height:16px;display:flex;align-items:center;justify-content:center;font-size:14px;}',

        // phase 2 rows
        '.sc-row{padding:11px 12px;border-radius:12px;background:var(--ide-bg,#2B2D30);',
        'border:1px solid var(--ide-border,#393B40);margin-bottom:8px;transition:border-color .25s;}',
        '.sc-row.pending{opacity:.5;}',
        '.sc-row.ok{border-color:color-mix(in srgb, var(--mv-green) 35%, transparent);}',
        '.sc-row.warn{border-color:color-mix(in srgb, var(--mv-orange) 42%, transparent);}',
        '.sc-row.fail{border-color:color-mix(in srgb, var(--mv-red) 45%, transparent);}',
        '.sc-row-top{display:flex;align-items:center;gap:10px;}',
        '.sc-row-ico{width:28px;height:28px;border-radius:8px;flex:none;display:flex;align-items:center;justify-content:center;',
        'background:var(--ide-panel,#1B1C1F);color:var(--ide-text-muted,#A0A6AD);font-size:15px;}',
        '.sc-row.ok .sc-row-ico{color:var(--syn-green,#5FAD65);}',
        '.sc-row.warn .sc-row-ico{color:var(--syn-yellow,#D6AE58);}',
        '.sc-row.fail .sc-row-ico{color:var(--syn-red,#DB5C5C);}',
        '.sc-row-lbl{flex:1;min-width:0;}',
        '.sc-row-name{font-size:13px;font-weight:500;color:var(--ide-text-main,#DFE1E5);}',
        '.sc-row-why{font-size:10.5px;color:var(--ide-text-dim,#6F737A);margin-top:2px;}',
        '.sc-ping{flex:none;font-size:12px;font-variant-numeric:tabular-nums;color:var(--ide-text-muted,#A0A6AD);',
        'min-width:64px;text-align:left;direction:ltr;}',
        '.sc-row.ok .sc-ping{color:var(--syn-green,#5FAD65);}',
        '.sc-row.fail .sc-ping{color:var(--syn-red,#DB5C5C);}',
        '.sc-row-st{flex:none;width:18px;text-align:center;font-size:15px;}',

        // per-row fill bar
        '.sc-bar{height:3px;border-radius:2px;background:var(--ide-border,#393B40);margin-top:9px;overflow:hidden;position:relative;}',
        '.sc-bar-fill{height:100%;width:0;border-radius:2px;background:var(--syn-blue,#3574F0);transition:width .45s cubic-bezier(.2,.8,.3,1);}',
        '.sc-row.ok .sc-bar-fill{background:var(--syn-green,#5FAD65);}',
        '.sc-row.warn .sc-bar-fill{background:var(--syn-yellow,#D6AE58);}',
        '.sc-row.fail .sc-bar-fill{background:var(--syn-red,#DB5C5C);}',
        // Indeterminate sweep while a probe is in flight: we genuinely do not know how
        // long a blocked host will take, so a fake percentage would be a lie.
        '.sc-bar.busy .sc-bar-fill{width:35%;animation:sc-sweep 1.15s ease-in-out infinite;}',
        '@keyframes sc-sweep{0%{margin-inline-start:-35%;}100%{margin-inline-start:100%;}}',

        '.sc-detail{font-size:11px;line-height:1.85;color:var(--ide-text-muted,#A0A6AD);margin-top:8px;',
        'padding-top:8px;border-top:1px dashed var(--ide-border,#393B40);}',
        '.sc-hint{display:block;margin-top:3px;color:var(--syn-yellow,#D6AE58);}',
        '.sc-srcs{margin-top:6px;display:flex;flex-wrap:wrap;gap:5px;}',
        '.sc-src{font-size:10px;padding:2px 7px;border-radius:6px;background:var(--ide-panel,#1B1C1F);',
        'border:1px solid var(--ide-border,#393B40);color:var(--ide-text-dim,#6F737A);direction:ltr;}',

        // spinner
        '.sc-spin{display:inline-block;width:13px;height:13px;border:2px solid var(--ide-border,#393B40);',
        'border-top-color:var(--syn-blue,#3574F0);border-radius:50%;animation:sc-rot .7s linear infinite;}',
        '@keyframes sc-rot{to{transform:rotate(360deg);}}',

        '.sc-foot{padding:14px 20px 16px;border-top:1px solid var(--ide-border,#393B40);',
        'display:flex;align-items:center;gap:12px;}',
        '.sc-total{flex:1;min-width:0;}',
        '.sc-total-bar{height:5px;border-radius:3px;background:var(--ide-border,#393B40);overflow:hidden;}',
        '.sc-total-fill{height:100%;width:0;border-radius:3px;background:var(--syn-blue,#3574F0);',
        'transition:width .35s cubic-bezier(.2,.8,.3,1);}',
        '.sc-total-txt{font-size:11px;color:var(--ide-text-dim,#6F737A);margin-top:6px;}',
        '.sc-btn{flex:none;padding:8px 16px;border-radius:9px;font-size:12.5px;font-family:inherit;cursor:pointer;',
        'border:1px solid var(--ide-border,#393B40);background:var(--ide-bg,#2B2D30);color:var(--ide-text-main,#DFE1E5);',
        'transition:background .18s,border-color .18s,opacity .18s;}',
        '.sc-btn:hover:not(:disabled){border-color:var(--ide-border-hover,#4E5157);background:var(--ide-panel,#1B1C1F);}',
        '.sc-btn:disabled{opacity:.4;cursor:not-allowed;}',
        '.sc-btn.primary{background:var(--syn-blue,#3574F0);border-color:var(--syn-blue,#3574F0);color:#fff;}',
        '.sc-btn.primary:hover:not(:disabled){filter:brightness(1.1);background:var(--syn-blue,#3574F0);}',
    ].join('');

    function injectStyles() {
        if (document.getElementById('sc-styles')) return;
        var st = document.createElement('style');
        st.id = 'sc-styles';
        st.textContent = CSS;
        (document.head || document.documentElement).appendChild(st);
    }

    // ── DOM ──────────────────────────────────────────────────────────────────

    var el = {};

    function build() {
        injectStyles();

        var overlay = document.createElement('div');
        overlay.id = 'sc-overlay';
        overlay.innerHTML =
            '<div class="sc-card" role="dialog" aria-modal="true" aria-label="بررسی سیستم">' +
              '<div class="sc-head">' +
                '<div class="sc-head-icon"><i class="ph ph-shield-check" id="sc-head-ico"></i></div>' +
                '<div class="sc-head-txt">' +
                  '<div class="sc-title" id="sc-title">در حال آماده‌سازی برنامه…</div>' +
                  '<div class="sc-sub" id="sc-sub">بخش‌های برنامه یکی‌یکی بارگذاری می‌شوند</div>' +
                '</div>' +
                '<div class="sc-step" id="sc-step">مرحله ۱ از ۲</div>' +
              '</div>' +
              '<div class="sc-body" id="sc-body"></div>' +
              '<div class="sc-foot">' +
                '<div class="sc-total">' +
                  '<div class="sc-total-bar"><div class="sc-total-fill" id="sc-total-fill"></div></div>' +
                  '<div class="sc-total-txt" id="sc-total-txt">…</div>' +
                '</div>' +
                '<button class="sc-btn" id="sc-skip" disabled>رد کردن تست</button>' +
                '<button class="sc-btn primary" id="sc-close" disabled>بستن</button>' +
              '</div>' +
            '</div>';

        document.body.appendChild(overlay);
        el.overlay = overlay;
        el.body = overlay.querySelector('#sc-body');
        el.title = overlay.querySelector('#sc-title');
        el.sub = overlay.querySelector('#sc-sub');
        el.step = overlay.querySelector('#sc-step');
        el.headIco = overlay.querySelector('#sc-head-ico');
        el.totalFill = overlay.querySelector('#sc-total-fill');
        el.totalTxt = overlay.querySelector('#sc-total-txt');
        el.skip = overlay.querySelector('#sc-skip');
        el.close = overlay.querySelector('#sc-close');

        el.skip.onclick = function () { abort(); };
        el.close.onclick = function () { abort(); close(); };

        // Escape is the reflex for "get this out of my way". It obeys the same rule as
        // the buttons: never during phase 1.
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && state.phase === 2 && !state.closed) { abort(); close(); }
        });

        requestAnimationFrame(function () { overlay.classList.add('sc-in'); });
    }

    function renderPhase2() {
        el.step.textContent = 'مرحله ۲ از ۲';
        el.title.textContent = 'بررسی سیستم و اینترنت شما';
        el.sub.textContent = 'هر مورد به‌صورت واقعی تست می‌شود — هر لحظه می‌توانید رد کنید';
        el.headIco.className = 'ph ph-activity';
        el.skip.disabled = false;
        el.close.disabled = false;

        el.body.innerHTML = CHECKS.map(function (c) {
            return '<div class="sc-row pending" id="sc-c-' + c.id + '">' +
                '<div class="sc-row-top">' +
                    '<div class="sc-row-ico"><i class="ph ' + c.icon + '"></i></div>' +
                    '<div class="sc-row-lbl">' +
                        '<div class="sc-row-name">' + esc(c.label) + '</div>' +
                        '<div class="sc-row-why">' + esc(c.why) + '</div>' +
                    '</div>' +
                    '<div class="sc-ping" id="sc-p-' + c.id + '">—</div>' +
                    '<div class="sc-row-st" id="sc-s-' + c.id + '"></div>' +
                '</div>' +
                '<div class="sc-bar" id="sc-b-' + c.id + '"><div class="sc-bar-fill"></div></div>' +
                '<div id="sc-d-' + c.id + '"></div>' +
            '</div>';
        }).join('');
    }

    function setTotal(pct, text) {
        el.totalFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
        el.totalTxt.textContent = text;
    }

    // ── phase 1 ──────────────────────────────────────────────────────────────

    // Called by safeInit() in index.html as each module init runs, so what is recorded
    // here is the real outcome of the real call.
    window.__scMark = function (name, ok, err) {
        state.marks[name] = { ok: !!ok, err: err || null };
        if (bootProgress) bootProgress();
    };

    // ── the boot screen ──────────────────────────────────────────────────────
    // Startup is the Mac's: a black screen, the mark, one thin bar — then the desktop.
    // The bar is not decoration: it follows the module inits as safeInit() reports them
    // (the parser yields between the bottom-of-body scripts, so it really moves), and fills
    // its last stretch when the page has finished loading. The same 15-second escape hatch
    // (waitForLoad) means it can never hold the app shut.
    //
    // What it replaced: a checklist of every module, then nine live network probes that
    // each could take ten seconds and ended on a button the user had to press. The probes
    // are still «بررسی سیستم» — the tools folder, Ctrl+K and the Help menu — and a network
    // call that fails still offers «دیاگ اینترنت» on its own (netdiag.js). A module that
    // failed to load is no longer a red row nobody reads: it is a banner once the desktop
    // is up, naming the part.
    var bootProgress = null;
    var BOOT_CSS =
        '#sc-boot{position:fixed;inset:0;z-index:2000001;display:flex;flex-direction:column;align-items:center;' +
        'justify-content:center;gap:58px;background:#000;opacity:1;transition:opacity .5s ease;cursor:default}' +
        '#sc-boot.sc-gone{opacity:0;pointer-events:none}' +
        '#sc-boot img{width:96px;height:96px;object-fit:contain;-webkit-user-drag:none;user-select:none}' +
        '#sc-boot .sc-boot-bar{width:176px;height:5px;border-radius:3px;background:rgba(255,255,255,.2);overflow:hidden}' +
        '#sc-boot .sc-boot-fill{width:0;height:100%;border-radius:inherit;background:#fff;transition:width .4s ease}' +
        '@media (prefers-reduced-motion: reduce){#sc-boot,#sc-boot .sc-boot-fill{transition-duration:.01s}}';

    function startBoot() {
        var st = document.createElement('style');
        st.id = 'sc-boot-styles';
        st.textContent = BOOT_CSS;
        (document.head || document.documentElement).appendChild(st);

        var boot = document.createElement('div');
        boot.id = 'sc-boot';
        boot.setAttribute('role', 'progressbar');
        boot.setAttribute('aria-label', 'در حال بارگذاری MLMVPN');
        boot.setAttribute('aria-valuemin', '0');
        boot.setAttribute('aria-valuemax', '100');
        boot.innerHTML = '<img src="icon.png" alt="">' +
            '<div class="sc-boot-bar"><div class="sc-boot-fill"></div></div>';
        document.body.appendChild(boot);
        var fill = boot.querySelector('.sc-boot-fill');

        var expected = 0;
        FEATURES.forEach(function (f) { expected += (f.inits || []).length; });
        function set(pct) {
            fill.style.width = pct + '%';
            boot.setAttribute('aria-valuenow', String(Math.round(pct)));
        }
        // Up to 88% from the module inits; the rest is the page's own load event.
        bootProgress = function () {
            var n = Object.keys(state.marks).length;
            set(Math.min(88, 8 + (n / Math.max(1, expected)) * 80));
        };
        set(8);

        waitForLoad(function () {
            bootProgress = null;
            var failed = FEATURES.filter(function (f) {
                var ok = evaluateFeature(f).length === 0;
                state.featureResults[f.key] = ok ? 'ok' : 'fail';
                return !ok;
            });
            set(100);
            // THE DESKTOP IS UP. main.js counts every launch as failed until it hears this,
            // and its watchdog waits 30 s for it before asking the page whether it is alive.
            //
            // This line needs `require` in the page's own world, which means main.js must keep
            // `contextIsolation: false` — Electron has defaulted it to TRUE since v12, and with
            // it on this call throws, the catch below swallows it, and every launch on every
            // machine looks like a failure. That is exactly what shipped once; see main.js.
            try { require('electron').ipcRenderer.send('app:desktop-ready'); } catch (e) { /* a browser, not the app */ }
            // A beat at full so the bar is seen to finish, then the desktop fades up.
            setTimeout(function () {
                boot.classList.add('sc-gone');
                setTimeout(function () {
                    if (boot.parentNode) boot.parentNode.removeChild(boot);
                    if (st.parentNode) st.parentNode.removeChild(st);
                }, 560);
                if (failed.length && typeof window.toast === 'function') {
                    window.toast('⚠️ ' + fa(failed.length) + ' بخش کامل بارگذاری نشد: ' +
                        failed.map(function (f) { return f.label; }).join('، '), 9000);
                }
            }, 420);
        });
    }

    function evaluateFeature(f) {
        var missing = [];
        (f.inits || []).forEach(function (n) {
            var m = state.marks[n];
            if (!m) missing.push(n + ' (اجرا نشد)');
            else if (!m.ok) missing.push(n + (m.err ? ': ' + m.err : ''));
        });
        if (f.verify) {
            var vOk = false;
            try { vOk = !!f.verify(); } catch (e) { vOk = false; }
            if (!vOk) missing.push('اجزای پایه بارگذاری نشدند');
        }
        return missing;
    }

    /**
     * Wait for the page to finish loading, but never past PHASE1_MAX_WAIT.
     *
     * The cap is the point: if a module init hangs, `load` never fires, and without this
     * the user is locked out of their own app by the screen that was meant to reassure
     * them. Timing out here degrades to "some features may not have loaded" — which the
     * per-row ticks then show honestly.
     */
    function waitForLoad(cb) {
        var fired = false;
        function go() {
            if (fired) return;
            fired = true;
            state.loadFired = true;
            // One frame of slack so any init queued as a microtask has landed.
            setTimeout(cb, 40);
        }
        if (document.readyState === 'complete') go();
        else window.addEventListener('load', go);
        setTimeout(go, PHASE1_MAX_WAIT);
    }

    // ── phase 2 ──────────────────────────────────────────────────────────────

    /** Quality → bar width. Tuned for Iranian lines, where 300ms is a good result. */
    function fillFor(res) {
        if (res.state === 'fail') return 100;
        if (res.latency == null) return 100;
        var l = res.latency;
        var pct = l < 200 ? 100 : l < 400 ? 82 : l < 800 ? 62 : l < 1500 ? 42 : 25;
        return pct;
    }

    function paintResult(c, res) {
        var row = document.getElementById('sc-c-' + c.id);
        var bar = document.getElementById('sc-b-' + c.id);
        var ping = document.getElementById('sc-p-' + c.id);
        var st = document.getElementById('sc-s-' + c.id);
        var det = document.getElementById('sc-d-' + c.id);
        if (!row) return;

        row.classList.remove('pending');
        row.classList.add(res.state);
        bar.classList.remove('busy');
        bar.querySelector('.sc-bar-fill').style.width = fillFor(res) + '%';

        ping.textContent = res.latency != null ? fa(res.latency) + ' ms' : '—';

        st.innerHTML = res.state === 'ok'
            ? '<i class="ph-bold ph-check-circle" style="color:var(--syn-green,#5FAD65)"></i>'
            : res.state === 'warn'
                ? '<i class="ph-bold ph-warning" style="color:var(--syn-yellow,#D6AE58)"></i>'
                : '<i class="ph-bold ph-x-circle" style="color:var(--syn-red,#DB5C5C)"></i>';

        var html = '<div class="sc-detail">' + esc(res.detail || '');
        if (res.hint) html += '<span class="sc-hint">↳ ' + esc(res.hint) + '</span>';
        if (res.sources && res.sources.length) {
            html += '<div class="sc-srcs">' + res.sources.slice(0, 6).map(function (s) {
                return '<span class="sc-src">' + esc(s.title) +
                    (s.servers && s.servers.length ? ': ' + esc(s.servers.join(', ')) : '') + '</span>';
            }).join('') + '</div>';
        }
        det.innerHTML = html + '</div>';
    }

    function markBusy(c) {
        var row = document.getElementById('sc-c-' + c.id);
        if (!row) return;
        row.classList.remove('pending');
        // On a short window the list outgrows the card, and a check running out of sight
        // reads as a frozen modal. Keep whatever is in flight visible.
        try { row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) {}
        document.getElementById('sc-b-' + c.id).classList.add('busy');
        document.getElementById('sc-s-' + c.id).innerHTML = '<span class="sc-spin"></span>';
        document.getElementById('sc-p-' + c.id).textContent = '…';
    }

    function markSkipped(c) {
        var row = document.getElementById('sc-c-' + c.id);
        if (!row) return;
        row.classList.remove('pending');
        document.getElementById('sc-b-' + c.id).classList.remove('busy');
        document.getElementById('sc-s-' + c.id).innerHTML =
            '<i class="ph ph-minus" style="color:var(--ide-text-dim,#6F737A)"></i>';
        document.getElementById('sc-p-' + c.id).textContent = 'رد شد';
        row.style.opacity = '.45';
    }

    /**
     * One probe, with a client-side deadline of its own.
     *
     * The AbortController is not redundant with the server's timeout: if the local server
     * itself stalls or the request never completes, only this releases the row.
     */
    /**
     * The worker probe is far more meaningful against a panel the user actually deployed
     * than against a generic Cloudflare host, so hand one over when there is one.
     * Read straight from the persisted accounts; nothing here depends on the cloud
     * module having initialised, so a broken panel cannot take this check down with it.
     */
    function probeTarget(id) {
        if (id !== 'worker') return undefined;
        try {
            // PersistentStorage is the source of truth; localStorage is its mirror and
            // is the one that exists this early in the page's life.
            var store = window.PersistentStorage || window.localStorage;
            var raw = store.getItem('cf_accounts');
            if (!raw) return undefined;
            var accs = JSON.parse(raw);
            if (!Array.isArray(accs)) return undefined;
            for (var i = 0; i < accs.length; i++) {
                var u = accs[i] && accs[i].url;
                if (u && /^https?:\/\//i.test(u)) return u;
            }
        } catch (e) { /* corrupt or unavailable storage must not break the check */ }
        return undefined;
    }

    function runProbe(c) {
        var ctrl = new AbortController();
        state.running = ctrl;
        var timer = setTimeout(function () { ctrl.abort(); }, PROBE_DEADLINE);

        return fetch('/api/systemcheck/probe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: c.id, target: probeTarget(c.id) }),
            signal: ctrl.signal,
        })
            .then(function (r) { return r.json(); })
            .then(function (d) {
                if (!d || d.ok === false) throw new Error((d && d.error) || 'پاسخ نامعتبر');
                return d;
            })
            .catch(function (err) {
                if (state.aborted || err.name === 'AbortError') return null;   // cancelled, not failed
                return { state: 'fail', detail: 'بررسی انجام نشد — ' + (err.message || err) };
            })
            .finally(function () {
                clearTimeout(timer);
                state.running = null;
            });
    }

    function runChecks() {
        var i = 0;
        (function next() {
            if (state.aborted || i >= CHECKS.length) return finishPhase2();
            var c = CHECKS[i];
            markBusy(c);
            setTotal((i / CHECKS.length) * 100, 'در حال بررسی: ' + c.label + ' (' + fa(i + 1) + ' از ' + fa(CHECKS.length) + ')');

            runProbe(c).then(function (res) {
                if (state.aborted) return finishPhase2();
                if (res) {
                    state.checkResults[c.id] = res;
                    paintResult(c, res);
                }
                i++;
                setTimeout(next, 60);
            });
        })();
    }

    function finishPhase2() {
        // Anything never reached — because the user skipped — is shown as skipped rather
        // than left spinning, so the final screen has no ambiguous rows.
        CHECKS.forEach(function (c) {
            if (!state.checkResults[c.id]) markSkipped(c);
        });

        var vals = Object.keys(state.checkResults).map(function (k) { return state.checkResults[k].state; });
        var fails = vals.filter(function (s) { return s === 'fail'; }).length;
        var warns = vals.filter(function (s) { return s === 'warn'; }).length;

        el.close.textContent = 'بستن';
        el.skip.disabled = true;

        if (state.aborted) {
            setTotal(100, 'بررسی متوقف شد.');
            el.title.textContent = 'بررسی متوقف شد';
            el.headIco.className = 'ph ph-pause-circle';
            el.sub.textContent = 'بقیه‌ی موارد بررسی نشدند — هر زمان می‌توانید دوباره اجرا کنید';
            return;
        }

        setTotal(100,
            fails ? fa(fails) + ' مورد ناموفق' + (warns ? ' و ' + fa(warns) + ' هشدار' : '') + ' — جزئیات بالا'
                  : warns ? fa(warns) + ' هشدار — بقیه سالم است'
                          : 'همه‌چیز سالم است ✅');
        el.title.textContent = fails ? 'بررسی تمام شد — چند مورد نیاز به توجه دارد'
                             : warns ? 'بررسی تمام شد — با چند هشدار'
                                     : 'بررسی تمام شد — سیستم آماده است';

        // The auto-offer. This screen is the first place a user learns the network is not
        // working, and until now it could only tell them so — «دیاگ اینترنت» is the thing that
        // can actually find out why. The offer waits for the modal to be dismissed rather than
        // stacking on top of it.
        if (fails && typeof window.ndOfferDiagnosis === 'function') {
            setTimeout(function () {
                window.ndOfferDiagnosis(fa(fails) + ' مورد از بررسی سیستم ناموفق بود');
            }, 1200);
        }
        el.headIco.className = fails ? 'ph ph-warning-circle' : 'ph ph-check-circle';
        el.sub.textContent = 'نتایج بالا واقعی و همین الان اندازه‌گیری شده‌اند';
    }

    // ── control ──────────────────────────────────────────────────────────────

    function abort() {
        if (state.phase !== 2) return;   // phase 1 is not skippable, by design
        state.aborted = true;
        if (state.running) { try { state.running.abort(); } catch (e) {} }
    }

    function close() {
        if (state.closed) return;
        state.closed = true;
        el.overlay.classList.add('sc-out');
        setTimeout(function () {
            if (el.overlay && el.overlay.parentNode) el.overlay.parentNode.removeChild(el.overlay);
        }, 300);
    }

    // Re-runnable from anywhere in the app (the tools folder, Ctrl+K, the Help menu, a
    // failed action's "دوباره بررسی کن"). It is the only way the live checks run now, so it
    // is a single-step sheet over the app: no «step 2 of 2», and it closes with «بستن».
    window.openSystemCheck = function () {
        if (el.overlay && el.overlay.parentNode) return;
        state.checkResults = {};
        state.aborted = false;
        state.closed = false;
        state.phase = 2;
        build();
        el.overlay.classList.add('sc-manual');
        renderPhase2();
        el.step.style.display = 'none';
        runChecks();
    };

    if (document.body) startBoot();
    else document.addEventListener('DOMContentLoaded', startBoot);
})();
