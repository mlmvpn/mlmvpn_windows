// --- «گیت‌وی MLM» panel ---
//
// The public SoftEther gateway network. Built with the page kit so it reads as part of the rest
// of the app, and shaped like every other engine window: a sidebar of sections, a hero with one
// button, the decisions as cards.
//
// Three things make this panel different from «سایفون»/«تور», and all three are facts about the
// network rather than design preferences:
//
//   * THE LIST IS THE FEATURE. VPN Gate publishes about a hundred relays at a time and rotates
//     them almost completely inside a year, so a stale list is a broken feature — and the way to
//     end up with a real catalogue is to KEEP what each refresh brings. Hence two lists:
//     «فهرست من» (what the last refresh saw, plus what the user kept, minus what they deleted)
//     and «آرشیو» (everything ever seen). The connect button chooses from the first.
//   * ADVERTISED SPEED IS NOT REACHABILITY. Measured from a censored line: the eight fastest
//     volunteer relays (500–974 Mbps each) were unreachable on TCP/443 while every official relay
//     answered. So the list is measured, not trusted.
//   * A PING IS NOT A CONNECTION. On a filtered line the port answers and the connect still
//     fails, because what answered was the operator's middlebox. «تست واقعی» carries a real
//     SoftEther handshake to the point where the relay offers a session, and says which step
//     failed when it does not.
//
// 2026-09-21: everything the Android app's gateway tab has had since 2026-07 and this window did
// not — the archive, the curation, the real test, search, country filter, seven sort modes, bulk
// select, «حذف خراب‌ها» with its undo, the per-server page and the guide. Same capabilities and
// the same Persian words as Android; the Windows chrome around them, because the user must not
// feel they have opened a second application.
//
// Renders into #ls-gateway. Talks to /api/gateway/*.

(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);

    /** The relay's own name, short enough to sit on a row. */
    function shortName(host) { return String(host || '').replace(/\.opengw\.net$/i, ''); }

    /**
     * The country's name in Persian, from the system's own data.
     *
     * A hand-written table covers the two dozen countries someone thought of and prints bare codes
     * for the rest — and this list reaches ninety. Intl has all of them and is already in Electron.
     */
    let REGION_NAMES = null;
    function countryName(cc) {
        const code = String(cc || '').toUpperCase();
        if (!code) return '';
        try {
            if (!REGION_NAMES) REGION_NAMES = new Intl.DisplayNames(['fa'], { type: 'region' });
            const n = REGION_NAMES.of(code);
            if (n && n !== code) return n;
        } catch (e) { /* no Intl data: the code itself is the honest answer */ }
        return code;
    }

    /**
     * Flags as SVG, never as emoji.
     *
     * Windows ships no glyphs for regional-indicator pairs, so an emoji flag renders as two boxed
     * letters — on exactly the rows whose job is to show a flag. The code sits behind the image,
     * so a country we have no file for reads as «PT» rather than as a hole.
     */
    function flag(cc, w) {
        const width = w || 19;
        const h = Math.round(width * 0.72);
        if (!cc) return `<span class="mv-flag is-none" style="width:${width}px;height:${h}px"></span>`;
        const code = String(cc).toLowerCase();
        return `<span class="mv-flag" style="width:${width}px;height:${h}px">${esc(String(cc).toUpperCase())}`
            + `<img src="/assets/flags/${esc(code)}.svg" alt="" onerror="this.remove()"></span>`;
    }

    /**
     * How long ago, in the unit a person would use.
     *
     * «۲ روز پیش» is what matters; the exact minute of a fetch two days old is noise.
     */
    function ago(ts) {
        if (!ts) return 'نامشخص';
        const ms = Date.now() - ts;
        if (ms < 0) return 'همین الان';
        const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
        if (m < 2) return 'همین الان';
        if (m < 60) return fa(m) + ' دقیقه پیش';
        if (h < 24) return fa(h) + ' ساعت پیش';
        if (d < 30) return fa(d) + ' روز پیش';
        return fa(Math.floor(d / 30)) + ' ماه پیش';
    }

    /** Past this, VPN Gate has rotated enough of the list that most of it will not answer. */
    const STALE_MS = 3 * 86400000;
    const isStale = (ts) => !!ts && (Date.now() - ts) > STALE_MS;

    function duration(ms) {
        const t = Math.max(0, Math.floor(ms / 1000));
        const p = (n) => String(n).padStart(2, '0');
        return fa(`${p(Math.floor(t / 3600))}:${p(Math.floor((t % 3600) / 60))}:${p(t % 60)}`);
    }

    /** VPN Gate publishes uptime in milliseconds. Days is the only useful unit. */
    function uptimeText(ms) {
        if (!ms) return 'نامشخص';
        const d = Math.floor(ms / 86400000);
        if (d >= 1) return fa(d) + ' روز';
        return fa(Math.max(1, Math.floor(ms / 3600000))) + ' ساعت';
    }

    const LOG_POLICY = {
        '2weeks': 'دو هفته نگه می‌دارد',
        '1month': 'یک ماه نگه می‌دارد',
        '3months': 'سه ماه نگه می‌دارد',
        'no': 'بدون لاگ',
    };
    const logPolicy = (t) => LOG_POLICY[String(t || '').toLowerCase()] || (t ? esc(t) : 'اعلام نشده');

    /** Why a real test failed, in the user's words. The five the probe can return. */
    const PROBE_FAIL = {
        unreachable: 'در دسترس نیست',
        tls: 'TLS بسته است',
        http: 'پاسخ HTTP نامعتبر',
        'not-softether': 'سافت‌اتر نیست',
        refused: 'رد کرد',
        timeout: 'بی‌پاسخ ماند',
    };

    /**
     * The real test's number, in words.
     *
     * Android shows «سریع / متوسط / کند» rather than milliseconds, and it is right to: a handshake
     * time is four seconds either way on this path and the exact figure invites a comparison the
     * measurement cannot support. The number itself is on the server's own page.
     */
    function probeBand(ms) {
        if (ms <= 2500) return { word: 'سریع', tone: 'ok' };
        if (ms <= 6000) return { word: 'متوسط', tone: 'mid' };
        return { word: 'کند', tone: 'slow' };
    }

    // ── sorting ────────────────────────────────────────────────────────────
    //
    // The same seven modes as Android, with the same descriptions — a user who learned this
    // screen on their phone must not have to learn it again here.

    const SORTS = [
        { id: 'verified', label: 'تست‌شده‌ها اول', detail: 'سرورهایی که «تست واقعی» را رد کرده‌اند بالا می‌آیند. تست‌نشده‌ها بالاتر از ردشده‌ها می‌مانند — نبودِ تست یک خبر بد نیست.' },
        { id: 'official', label: 'رسمی‌ها اول', detail: 'سرورهایی که روی زیرساخت خود سرویس اجرا می‌شوند. معمولاً پایدارترند و پورتشان کمتر بسته می‌شود.' },
        { id: 'ping', label: 'سریع‌ترین', detail: 'کم‌ترین تأخیر اندازه‌گیری‌شده از خط اینترنت خودتان. تست‌نشده‌ها و بی‌پاسخ‌ها ته فهرست می‌روند.' },
        { id: 'score', label: 'امتیاز', detail: 'امتیازی که خود VPN Gate بر اساس پایداری و سابقهٔ سرور می‌دهد.' },
        { id: 'speed', label: 'پهنای باند', detail: 'سرعت اعلامی سرور. توجه: این عدد را VPN Gate از ژاپن اندازه گرفته، نه از ایران.' },
        { id: 'sessions', label: 'کاربران', detail: 'تعداد نشست‌های فعال. شلوغ‌تر یعنی محبوب‌تر، ولی گاهی هم یعنی کندتر.' },
        { id: 'country', label: 'کشور', detail: 'الفبایی بر اساس کد کشور، و در هر کشور بر اساس امتیاز.' },
    ];

    function sorter(mode) {
        const pr = (h) => st.probes[h];
        const pg = (h) => st.pings[h];
        switch (mode) {
            // Proven first, fastest of those on top. Untested rank above failed — a failure is
            // information, an absent test is not.
            case 'verified': return (a, b) => rankVerified(a) - rankVerified(b);
            case 'official': return (a, b) => (b.official - a.official) || (b.score - a.score);
            // Untested and unreachable sink, rather than masquerading as instant.
            case 'ping': return (a, b) => rankPing(a) - rankPing(b);
            case 'score': return (a, b) => b.score - a.score;
            case 'speed': return (a, b) => b.speedMbps - a.speedMbps;
            case 'sessions': return (a, b) => b.sessions - a.sessions;
            case 'country': return (a, b) => String(a.cc).localeCompare(String(b.cc)) || (b.score - a.score);
            default: return () => 0;
        }
        function rankVerified(r) {
            const p = pr(r.host);
            if (p && p.ok) return p.ms;
            if (!p) return 1e6;
            return 2e6;
        }
        function rankPing(r) {
            const v = pg(r.host);
            if (v === undefined) return 2147483646;
            return v > 0 ? v : 2147483647;
        }
    }

    // ── state ──────────────────────────────────────────────────────────────

    const st = {
        payload: null,
        mine: [], archive: [],
        kept: [], hidden: [],
        pings: {},           // host -> ms, 0 when it did not answer
        probes: {},          // host -> { ok, ms, reason, at }
        selected: null,
        suggested: null,
        udp: true,

        scope: 'mine',       // 'mine' | 'archive'
        sort: 'verified',
        countries: [],       // empty = every country
        query: '',
        selecting: false,
        checked: [],
        detailHost: null,

        busy: false,
        confirm: null,       // { hosts, scope }
        snack: '',
        snackAt: 0,
        log: [],
    };

    const $ = (id) => document.getElementById(id);
    const has = (arr, v) => arr.indexOf(v) >= 0;
    const without = (arr, v) => arr.filter(x => x !== v);

    // ── style ──────────────────────────────────────────────────────────────

    const CSS = `
<style id="gw-css">
  /* NO z-index HERE, and that is the whole of a bug the user reported as «دکمهٔ برگشت
     کار نمیکند».

     In a split window the title band is .mv-win.is-split .mv-win-bar — transparent,
     position:absolute, spanning the whole top, z-index:5 — and it lies OVER the pane's own
     bar so the empty parts of that band still drag the window. page-kit pokes the two
     interactive islands back through it with .mv-pane-nav { z-index:6 }.

     position:relative WITH a z-index (even 0) makes this wrapper a stacking context, and a
     stacking context is a ceiling: the nav's 6 is then 6 *inside a box whose own level is 0*,
     which loses to the window bar's 5. The button paints normally and every real click lands on
     the drag strip instead — document.elementFromPoint over it returned mv-win-bar.
     A scripted .click() still worked, which is why it passed review.

     position:relative alone creates no stacking context, so the nav competes with the bar
     directly and wins. The snack below is positioned against this element and is unaffected. */
  #gw-wrap { position:relative; flex:1 1 auto; min-height:0; color:var(--mv-label); }
  #gw-wrap code { font-family:var(--mv-font-latin, ui-monospace), monospace; font-size:.92em; }
  #gw-wrap .gw-num { font-family:var(--mv-font-tech, ui-monospace), monospace; font-variant-numeric:tabular-nums; font-size:11.5px; }
  #gw-wrap .gw-log {
    margin:0; width:100%; max-height:420px; overflow:auto;
    font-family:var(--mv-font-latin, ui-monospace), monospace; font-size:11px; line-height:1.7;
    white-space:pre-wrap; word-break:break-word; text-align:left; color:var(--mv-label-2);
  }

  /* search + chips + toolbar, all on one band above the list */
  #gw-wrap .gw-tools { display:flex; flex-direction:column; gap:9px; padding:2px 0 4px; }
  #gw-wrap .gw-search { display:flex; align-items:center; gap:7px; height:32px; padding:0 10px;
    border-radius:9px; background:var(--mv-fill-2); }
  #gw-wrap .gw-search > i { font-size:14px; color:var(--mv-label-3); flex:none; }
  #gw-wrap .gw-search > input { flex:1 1 auto; min-width:0; border:0; background:none; outline:none;
    color:var(--mv-label); font:inherit; font-size:12.5px; }
  #gw-wrap .gw-search > button { flex:none; border:0; background:none; color:var(--mv-label-3);
    cursor:pointer; font-size:13px; padding:2px; }

  #gw-wrap .gw-row-1 { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  #gw-wrap .gw-chips { display:inline-flex; padding:2px; border-radius:9px; background:var(--mv-fill-2); }
  #gw-wrap .gw-chip { border:0; background:none; cursor:pointer; border-radius:7px; padding:4px 11px;
    font:inherit; font-size:12px; font-weight:600; color:var(--mv-label-2); white-space:nowrap; }
  #gw-wrap .gw-chip.is-on { background:var(--mv-accent); color:#fff; }
  #gw-wrap .gw-tb { display:flex; align-items:center; gap:6px; margin-inline-start:auto; flex-wrap:wrap; }
  #gw-wrap .gw-tb button { display:inline-flex; align-items:center; gap:5px; height:28px; padding:0 10px;
    border:0; border-radius:8px; background:var(--mv-fill-2); color:var(--mv-label); cursor:pointer;
    font:inherit; font-size:12px; font-weight:600; white-space:nowrap; }
  #gw-wrap .gw-tb button:disabled { opacity:.45; cursor:default; }
  #gw-wrap .gw-tb button.is-on { background:var(--mv-accent); color:#fff; }
  #gw-wrap .gw-tb button.is-stop { background:color-mix(in srgb, var(--mv-red) 20%, transparent); color:var(--mv-red-ink, var(--mv-red)); }

  /* the sweep's progress, in the band it belongs to */
  #gw-wrap .gw-sweep { display:flex; align-items:center; gap:9px; font-size:11.5px; color:var(--mv-label-2); }
  #gw-wrap .gw-sweep .gw-bar { flex:1 1 auto; height:5px; border-radius:3px; background:var(--mv-fill-2); overflow:hidden; }
  #gw-wrap .gw-sweep .gw-bar > i { display:block; height:100%; background:var(--mv-accent); transition:width .25s ease-out; }

  #gw-wrap .gw-summary { display:flex; align-items:center; gap:8px; font-size:11.5px; color:var(--mv-label-3); flex-wrap:wrap; }
  #gw-wrap .gw-summary button { border:0; background:var(--mv-fill-2); color:var(--mv-label-2); cursor:pointer;
    border-radius:7px; padding:2px 8px; font:inherit; font-size:11px; }

  /* the list itself: a wide window is a wide list */
  #gw-wrap #gw-servers { display:grid; gap:2px; grid-template-columns:repeat(auto-fill, minmax(330px, 1fr)); }
  #gw-wrap #gw-servers > .mv-form-row + .mv-form-row::before { content:none; }
  #gw-wrap .gw-srow { display:flex; align-items:center; gap:9px; width:100%; text-align:start;
    border:0; background:none; color:inherit; font:inherit; cursor:pointer;
    padding:8px 11px; border-radius:9px; }
  #gw-wrap .gw-srow:hover { background:var(--mv-fill); }
  #gw-wrap .gw-srow[disabled] { opacity:.5; cursor:default; }
  #gw-wrap .gw-srow .gw-mark { flex:none; width:18px; font-size:15px; color:var(--mv-label-3); display:grid; place-items:center; }
  #gw-wrap .gw-srow .gw-mark.is-on { color:var(--mv-accent); }
  #gw-wrap .gw-srow .gw-txt { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:1px; }
  #gw-wrap .gw-srow .gw-txt b { font-size:12.5px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #gw-wrap .gw-srow .gw-txt small { font-size:10.5px; color:var(--mv-label-3); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #gw-wrap .gw-srow .gw-txt small.is-on { color:var(--mv-green-ink, var(--mv-green)); }
  #gw-wrap .gw-srow .gw-end { flex:none; display:flex; align-items:center; gap:7px; }
  #gw-wrap .gw-badge { font-size:10px; font-weight:700; padding:2px 7px; border-radius:7px;
    background:var(--mv-fill-2); color:var(--mv-label-2); white-space:nowrap; }
  #gw-wrap .gw-badge.is-ok { background:color-mix(in srgb, var(--mv-green) 18%, transparent); color:var(--mv-green-ink, var(--mv-green)); }
  #gw-wrap .gw-badge.is-mid { background:color-mix(in srgb, var(--mv-yellow) 20%, transparent); color:var(--mv-yellow-ink, var(--mv-orange)); }
  #gw-wrap .gw-badge.is-slow { background:color-mix(in srgb, var(--mv-orange) 18%, transparent); color:var(--mv-orange-ink, var(--mv-orange)); }
  #gw-wrap .gw-badge.is-bad { background:color-mix(in srgb, var(--mv-red) 16%, transparent); color:var(--mv-red-ink, var(--mv-red)); }
  #gw-wrap .gw-open { flex:none; border:0; background:none; color:var(--mv-label-3); cursor:pointer;
    font-size:13px; padding:3px; border-radius:6px; }
  #gw-wrap .gw-open:hover { color:var(--mv-label); background:var(--mv-fill-2); }

  /* the bulk bar, when «انتخاب» is on */
  #gw-wrap .gw-bulk { display:flex; align-items:center; gap:8px; flex-wrap:wrap;
    padding:9px 11px; border-radius:11px; background:var(--mv-fill-2); font-size:12px; }
  #gw-wrap .gw-bulk b { font-weight:700; }
  #gw-wrap .gw-bulk .gw-bulk-acts { display:flex; gap:6px; margin-inline-start:auto; flex-wrap:wrap; }
  #gw-wrap .gw-bulk button { border:0; border-radius:8px; padding:5px 11px; cursor:pointer; font:inherit;
    font-size:12px; font-weight:600; background:var(--mv-fill); color:var(--mv-label); }
  #gw-wrap .gw-bulk button:disabled { opacity:.45; cursor:default; }
  #gw-wrap .gw-bulk button.is-bad { background:color-mix(in srgb, var(--mv-red) 18%, transparent); color:var(--mv-red-ink, var(--mv-red)); }

  /* countries */
  #gw-wrap #gw-countries { display:grid; gap:2px; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); }
  #gw-wrap #gw-countries > .mv-form-row + .mv-form-row::before { content:none; }
  #gw-wrap .gw-crow { display:flex; align-items:center; gap:9px; width:100%; text-align:start;
    border:0; background:none; color:inherit; font:inherit; cursor:pointer; padding:7px 11px; border-radius:9px; }
  #gw-wrap .gw-crow:hover { background:var(--mv-fill); }
  #gw-wrap .gw-crow .gw-mark { flex:none; width:18px; font-size:15px; color:var(--mv-label-3); }
  #gw-wrap .gw-crow .gw-mark.is-on { color:var(--mv-accent); }
  #gw-wrap .gw-crow span.gw-cname { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; }
  #gw-wrap .gw-crow small { flex:none; font-size:11px; color:var(--mv-label-3); }

  #gw-wrap .gw-snack { position:absolute; inset-inline:0; bottom:54px; display:flex; justify-content:center;
    pointer-events:none; z-index:5; }
  #gw-wrap .gw-snack > span { background:var(--mv-fill-2); backdrop-filter:blur(18px);
    border-radius:11px; padding:8px 15px; font-size:12px; box-shadow:0 6px 20px rgba(0,0,0,.28); }
</style>`;

    // ── the page ───────────────────────────────────────────────────────────

    const GW_SECTIONS = [
        { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
        { id: 'servers', label: 'سرورها', icon: 'ph-fill ph-hard-drives', tint: 'var(--mv-indigo)' },
        { id: 'guide', label: 'راهنمای سرورها', icon: 'ph-fill ph-book-open', tint: 'var(--mv-blue)' },
        { id: 'log', label: 'گزارش', icon: 'ph-fill ph-terminal-window', tint: 'var(--mv-label-2)' },
    ];

    /**
     * Pages reachable only from «سرورها», which is where they belong: a country filter and a sort
     * order are decisions ABOUT the list, not siblings of it. The back button returns to the list,
     * exactly as the Android page stack does.
     */
    const SUB = { countries: 'کشورها', sort: 'مرتب‌سازی', detail: 'سرور' };

    let gwSec = 'connect';

    function template() {
        return CSS + `
<div id="gw-wrap" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های گیت‌وی">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="gw-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${GW_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-gw-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="gw-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="gw-pane-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="gw-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="gw-stage" style="--tint:var(--mv-indigo)"></div>
        <div class="mv-eng-grid" id="gw-cards"></div>
      </div>

      <div class="mv-eng-sec" data-sec="servers">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="gw-tools" id="gw-tools"></div>
            <div class="mv-form-group" id="gw-servers" role="radiogroup"></div>
            <div class="mv-form-footer" id="gw-list-note"></div>
          </div>
        </div>
      </div>

      <div class="mv-eng-sec" data-sec="countries">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header" id="gw-country-head">کشور</div>
            <div class="gw-tools" id="gw-country-tools"></div>
            <div class="mv-form-group" id="gw-countries"></div>
            <div class="mv-form-footer">فهرست را به یک یا چند کشور محدود می‌کند. بدون فیلتر، همهٔ سرورهای این فهرست نمایش داده می‌شوند. می‌توانید چند کشور را با هم انتخاب کنید — مثلاً برای اینکه یک قاره را یک‌جا تست بگیرید.</div>
          </div>
        </div>
      </div>

      <div class="mv-eng-sec" data-sec="sort">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="mv-form-header">مرتب‌سازی</div>
            <div class="mv-form-group" id="gw-sorts" role="radiogroup"></div>
            <div class="mv-form-footer">ترتیب فقط روی نمایش اثر دارد؛ هیچ سروری با آن حذف یا اضافه نمی‌شود. پیش‌فرض روی «تست‌شده‌ها اول» است.</div>
          </div>
        </div>
      </div>

      <div class="mv-eng-sec" data-sec="detail">
        <div id="gw-detail"></div>
      </div>

      <div class="mv-eng-sec" data-sec="guide">
        <div id="gw-guide"></div>
      </div>

      <div class="mv-eng-sec" data-sec="log">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">گزارش زنده — خط‌به‌خط، از خود موتور</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack"><pre class="gw-log" id="gw-log" dir="ltr"></pre></div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="mv-eng-foot" id="gw-foot"></div>
    <div class="gw-snack" id="gw-snack" hidden></div>
  </section>
</div>`;
    }

    function gwDot(tone) {
        return `<i class="mv-eng-dot${tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : ''}"></i>`;
    }

    // ── what the hero says ─────────────────────────────────────────────────

    function selectedRow() {
        return st.mine.find(r => r.host === st.selected)
            || st.archive.find(r => r.host === st.selected) || null;
    }

    function gwView() {
        const p = st.payload || {}, s = p.status || {};
        const base = { s, p };

        if (!s.installed) {
            return Object.assign(base, { tone: 'off', act: '',
                head: 'موتور سافت‌اتر روی این سیستم نیست',
                line: 'این بخش موتور رسمی سافت‌اتر را راه می‌اندازد و خودش مدیریتش می‌کند. یک بار نصبش کنید و بعد از آن همه چیز از همین پنجره انجام می‌شود.' });
        }
        if (s.connected) {
            const bits = [];
            if (s.tcpConnections) bits.push(`${fa(s.tcpConnections)} اتصال موازی از ${fa(s.maxTcp)}`);
            if (s.nicIp) bits.push(`آدرس <code>${esc(s.nicIp)}</code>`);
            if (s.since) bits.push(`<span class="gw-num" dir="ltr">${duration(Date.now() - s.since)}</span>`);
            return Object.assign(base, { tone: 'on', act: 'off',
                head: 'وصل است',
                line: (s.host ? `همهٔ ترافیک سیستم از <code>${esc(shortName(s.host))}</code> رد می‌شود. ` : '') + bits.join(' · ') });
        }
        if (s.connecting) {
            return Object.assign(base, { tone: 'busy', act: 'off',
                head: 'در حال اتصال…',
                line: esc(s.detail || '') || 'نشست در حال برقراری… دکمهٔ بالا لغو می‌کند.' });
        }
        if (s.error) {
            return Object.assign(base, { tone: 'off', act: st.selected ? 'on' : '',
                head: 'وصل نشد',
                line: esc(s.error) + ' — بخش «گزارش» خط‌به‌خط می‌گوید کجا ایستاد.' });
        }
        if (!st.selected) {
            return Object.assign(base, { tone: 'off', act: '',
                head: 'سروری انتخاب نشده',
                line: 'شبکهٔ عمومی گیت‌وی سافت‌اتر — هزاران سرور داوطلبانه در دنیا، بدون حساب و بدون هزینه. در «سرورها» یکی را بردارید، یا «تست واقعی» را بزنید تا خودش سرورِ واقعاً سالم را پیدا کند.' });
        }
        return Object.assign(base, { tone: 'off', act: 'on',
            head: 'آمادهٔ اتصال',
            line: 'موتور رسمی خودش ترافیک را روی <b>چند اتصال موازی</b> می‌برد، و همین است که سرعتش را می‌سازد. این موتور آداپتور خودش را دارد، پس تونل کامل سیستم را خودش برقرار می‌کند.' });
    }

    function renderIdent() {
        const host = $('gw-ident');
        if (!host) return;
        const v = gwView();
        const word = v.tone === 'on' ? 'وصل است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('gateway');
        const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
            : '<span class="mv-side-tile" style="--tint:var(--mv-indigo)"><svg aria-hidden="true"><use href="#g-server"/></svg></span>';
        host.innerHTML = `${icon}
      <b>گیت‌وی MLM</b>
      <small>${gwDot(v.tone)}${word}</small>`;
    }

    /** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
    function renderHero() {
        const host = $('gw-stage');
        if (!host) return;
        const v = gwView();

        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-gw-act="power" data-part="power">
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
        btn.disabled = !v.act || st.busy;
        // «قطع» while connected, «اتصال» while not. The word on the control must be what the
        // control does, not what the engine is.
        const aria = v.act === 'off' ? (v.s.connecting ? 'لغو' : 'قطع') : 'اتصال';
        btn.setAttribute('aria-label', aria);
        btn.title = v.act ? aria : (!v.s.installed ? 'موتور سافت‌اتر نصب نیست' : 'اول یک سرور انتخاب کنید');
        const glyph = (v.tone === 'busy' || st.busy) ? 'mv-spin-ring'
            : v.tone === 'on' ? 'ph-fill ph-power' : 'ph-bold ph-power';
        const gl = q('glyph');
        if (gl.className !== glyph) gl.className = glyph;

        const el = q('live');
        if (el && window.MVEngineLive) MVEngineLive.mount(el);
    }

    // ── the connect page's cards ───────────────────────────────────────────

    function renderCards() {
        const host = $('gw-cards');
        if (!host) return;
        const p = st.payload || {}, s = p.status || {};
        const sel = selectedRow();
        const proven = Object.values(st.probes).filter(x => x && x.ok).length;
        const lastLog = st.log.length ? st.log[st.log.length - 1] : '';
        const stale = isStale(p.fetchedAt);

        host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-gw-go="servers">
            <span class="mv-eng-glyph"><i class="ph-fill ph-hard-drives"></i></span>
            <h3>سرور</h3>
            <span class="mv-eng-card2-end">${sel ? esc(countryName(sel.cc) || sel.country) : 'انتخاب نشده'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-gw-act="probe-top"
                  title="تست واقعی روی فهرست من" aria-label="تست واقعی روی فهرست من"
                  ${st.busy || sweep() || !st.mine.length ? 'disabled' : ''}>
            <i class="${sweep() ? 'mv-spin-ring' : 'ph-bold ph-pulse'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${sel ? `
          <div class="mv-eng-pick is-on${s.connected && s.host === sel.host ? ' is-live' : ''}" aria-disabled="true">
            ${flag(sel.cc, 22)}
            <span class="mv-eng-pick-text">
              <b>${esc(countryName(sel.cc) || sel.country)}${sel.official ? ' · رسمی' : ''} <code>${esc(shortName(sel.host))}</code></b>
              <small>${resultWords(sel.host) || `${fa(sel.speedMbps)} مگابیت آگهی‌شده`}</small>
            </span>
          </div>`
            : '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز سروری انتخاب نشده.</div>'}
        </div>
        <div class="mv-eng-card2-foot">${proven
            ? `«تست واقعی» تا الان ${fa(proven)} سرور را سالم تأیید کرده.`
            : 'پینگ فقط می‌گوید بسته چقدر طول می‌کشد به سرور برسد. «تست واقعی» دست‌دادن کامل را انجام می‌دهد، پس روی خطوط ایران بسیار قابل‌اعتمادتر است.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-gw-go="servers">
            <span class="mv-eng-glyph"><i class="ph-fill ph-list-bullets"></i></span>
            <h3>فهرست</h3>
            <span class="mv-eng-card2-end">${fa(st.mine.length)}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-gw-act="refresh"
                  title="به‌روزرسانی فهرست" aria-label="به‌روزرسانی فهرست"
                  ${st.busy || sweep() ? 'disabled' : ''}>
            <i class="${st.busy ? 'mv-spin-ring' : 'ph-bold ph-arrows-clockwise'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          <div class="mv-eng-pick" aria-disabled="true">
            <i class="ph-fill ph-database"${stale ? ' style="color:var(--mv-orange)"' : ''}></i>
            <span class="mv-eng-pick-text">
              <b>${fa(st.mine.length)} سرور در فهرست شما، و ${fa(st.archive.length)} سرور در آرشیو</b>
              <small>${p.fetchedAt ? 'آخرین به‌روزرسانی ' + esc(ago(p.fetchedAt)) : (p.source === 'bundled' ? 'فهرست همراه برنامه' : 'هنوز به‌روزرسانی نشده')}</small>
            </span>
          </div>
        </div>
        <div class="mv-eng-card2-foot">${!p.canRefresh
            ? 'سایت گیت‌وی از ایران همیشه باز نیست. <b>برای به‌روزرسانی، اول یکی از تونل‌های برنامه را روشن کنید</b> — بعد این دکمه فهرست را از داخل همان تونل می‌گیرد.'
            : stale
                ? 'فهرست شما کهنه است. VPN Gate سرورهایش را مدام عوض می‌کند، پس بیشتر این‌ها دیگر جواب نمی‌دهند.'
                : 'هر به‌روزرسانی فهرست را <b>بزرگ‌تر</b> می‌کند، نه اینکه جایش را بگیرد — سرورهای قدیمی در «آرشیو» می‌مانند و هر وقت خواستید به فهرستتان برمی‌گردند.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-green)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-plugs-connected"></i></span>
          <h3>نشست</h3>
          <span class="mv-eng-card2-end">${s.connected ? 'برقرار' : s.connecting ? 'در حال برقراری' : 'ندارید'}</span>
        </div>
        <div class="mv-eng-card2-body">
          ${s.connected ? `
          <div class="mv-eng-card2-foot" style="display:flex;justify-content:space-between;padding:4px 13px"><span>اتصال‌های موازی</span><b dir="ltr">${fa(s.tcpConnections || 0)} / ${fa(s.maxTcp || 0)}</b></div>
          <div class="mv-eng-card2-foot" style="display:flex;justify-content:space-between;padding:4px 13px"><span>آدرس در شبکه</span><b dir="ltr">${esc(s.nicIp || '—')}</b></div>
          <div class="mv-eng-card2-foot" style="display:flex;justify-content:space-between;padding:4px 13px"><span>مدت اتصال</span><b dir="ltr" class="gw-num">${s.since ? duration(Date.now() - s.since) : '—'}</b></div>
          <div class="mv-eng-card2-foot" style="display:flex;justify-content:space-between;padding:4px 13px"><span>مسیر واقعی داده</span><b dir="ltr">${esc(s.underlay || '—')}</b></div>`
            : '<div class="mv-eng-card2-foot" style="padding-top:6px">این موتور آداپتور شبکهٔ خودش را می‌سازد، پس تونل کامل سیستم را خودش برقرار می‌کند — نه پروکسی، نه تنظیمی در ویندوز.</div>'}
        </div>
        <div class="mv-eng-card2-foot">سرعت این شبکه از چند اتصال موازی می‌آید، نه از یک اتصال پرسرعت — عددِ بالا همان است.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-orange)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-sliders-horizontal"></i></span>
          <h3>تنظیمات</h3>
          <span class="mv-eng-card2-end">${!st.udp ? 'شتاب‌دهی UDP خاموش'
                : s.connected && s.udpActive === true ? 'UDP فعال است'
                    : s.connected && s.udpActive === false ? 'UDP هنوز بالا نیامده'
                        : 'شتاب‌دهی UDP روشن'}</span>
        </div>
        <div class="mv-eng-card2-body">
          <label class="mv-form-row" style="cursor:${s.connected || s.connecting ? 'default' : 'pointer'}">
            <span class="mv-form-label">شتاب‌دهی UDP<small>${udpWords(s)}</small></span>
            <!-- input.mv-switch-input is the app's switch: a REAL checkbox with appearance:none,
                 the same control every other panel uses. Wrapping one in a <span class="mv-switch">
                 drew both — the span's own pill from page-kit AND a raw, unstyled native checkbox
                 poking out beside the knob, which is what the user photographed. -->
            <input type="checkbox" id="gw-udp" class="mv-switch-input"
                   ${st.udp ? 'checked' : ''} ${s.connected || s.connecting ? 'disabled' : ''}>
          </label>
          ${st.hidden.length ? `
          <button type="button" class="mv-form-row is-action" data-gw-act="restore">
            <span class="mv-row-mark"><i class="ph-fill ph-arrow-counter-clockwise"></i></span>
            <span class="mv-form-label">بازگرداندن ${fa(st.hidden.length)} سرور حذف‌شده<small>سرورهایی که حذف کرده‌اید دیگر در فهرست ظاهر نمی‌شوند، حتی اگر VPN Gate دوباره منتشرشان کند. این دکمه همهٔ آن‌ها را یک‌جا برمی‌گرداند.</small></span>
          </button>` : ''}
        </div>
        <div class="mv-eng-card2-foot">این موتور آداپتور خودش را دارد، پس محافظ نشت و قانون‌های «تونل و برنامه‌ها» روی آن اعمال نمی‌شوند.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-label-2)">
        <button type="button" class="mv-eng-card2-head" data-gw-go="log">
          <span class="mv-eng-glyph"><i class="ph-fill ph-terminal-window"></i></span>
          <h3>گزارش</h3>
          <span class="mv-eng-card2-end">${st.log.length ? fa(st.log.length) + ' خط' : '—'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          <div class="mv-eng-card2-foot" style="padding-top:6px" dir="ltr">${lastLog ? esc(lastLog) : '<span dir="rtl">هنوز چیزی ثبت نشده.</span>'}</div>
        </div>
        <div class="mv-eng-card2-foot">وقتی اتصال نگیرد، این تنها جایی است که می‌گوید دقیقاً کجا ایستاد.</div>
      </div>`;
    }

    /**
     * What to say under the UDP switch — about the SESSION, not about the switch.
     *
     * These are two different facts and the panel used to report only the first. SoftEther brings
     * the UDP channel up some seconds after the SSL one is already carrying traffic, and only if
     * both ends can reach each other over UDP. On an operator that passes TCP/443 and drops the
     * datagrams the switch stays on and the channel never arrives — so «روشن است» would be a
     * claim the app has no evidence for. `udpActive` comes from the client's own status.
     */
    function udpWords(s) {
        if (!s.connected) {
            return st.udp
                ? 'روی شبکه‌هایی که UDP باز است سرعت را زیاد می‌کند. اگر بعد از روشن کردن، اینترنت قطع شد، خاموشش کنید.'
                : 'خاموش است: نشست فقط روی همان کانال SSL روی TCP می‌رود. روی خطوطی که UDP را می‌بندند همین درست است.';
        }
        if (!st.udp) return 'خاموش است — این نشست روی کانال SSL روی TCP می‌رود. برای تغییر، اول اتصال را قطع کنید.';
        if (s.udpActive === true) return 'کانال UDP بالا آمده و در حال استفاده است.';
        if (s.udpSupported === false) return 'این سرور شتاب‌دهی UDP را پشتیبانی نمی‌کند؛ نشست روی همان کانال SSL می‌رود.';
        if (s.udpActive === false) return 'روشن است، ولی کانال UDP هنوز بالا نیامده. چند ثانیه پس از اتصال باز می‌شود، و اگر شبکه UDP را ببندد همان مسیر SSL کار می‌کند.';
        return 'روشن است. وضعیت کانال UDP را کلاینت هنوز اعلام نکرده. برای تغییر این گزینه، اول اتصال را قطع کنید.';
    }

    /** The one line that says what we know about a relay, test first. */
    function resultWords(host) {
        const p = st.probes[host];
        if (p && p.ok) return `تست واقعی: ${probeBand(p.ms).word} · <span class="gw-num">${fa(p.ms)}ms</span>`;
        if (p) return `تست واقعی: ${PROBE_FAIL[p.reason] || 'رد شد'}`;
        const g = st.pings[host];
        if (g > 0) return `پینگ <span class="gw-num">${fa(g)}ms</span>`;
        if (g !== undefined) return 'بی‌پاسخ';
        return '';
    }

    // ── the servers page ───────────────────────────────────────────────────

    const sweep = () => (st.payload && st.payload.status && st.payload.status.sweep) || null;

    /** The rows the list is showing right now, after scope, country, search and sort. */
    function visible() {
        const pool = st.scope === 'mine' ? st.mine : st.archive;
        const q = st.query.trim().toLowerCase();
        return pool.filter((r) => {
            if (st.countries.length && !has(st.countries, r.cc)) return false;
            if (!q) return true;
            // The four things people actually type on this screen: «آلمان», "Germany", "DE",
            // "vpn847263841". All four have been on the row in front of them.
            return countryName(r.cc).toLowerCase().indexOf(q) >= 0
                || String(r.country).toLowerCase().indexOf(q) >= 0
                || String(r.cc).toLowerCase().indexOf(q) >= 0
                || String(r.host).toLowerCase().indexOf(q) >= 0;
        }).sort(sorter(st.sort));
    }

    /**
     * «خراب» means a test CONDEMNED it, never merely that it is untested — otherwise the first
     * press of «حذف خراب‌ها» would wipe a fresh list. Both tests count: whichever the user ran is
     * the one holding the evidence.
     */
    function deadOf(rows) {
        return rows.filter((r) => {
            const p = st.probes[r.host];
            if (p) return p.ok === false;
            const g = st.pings[r.host];
            return g !== undefined && !(g > 0);
        }).map(r => r.host);
    }

    /** Passed the real test — or, only if nothing has been probed, answered a ping. */
    function healthyOf(rows) {
        const proven = rows.filter(r => st.probes[r.host] && st.probes[r.host].ok).map(r => r.host);
        if (proven.length) return proven;
        return rows.filter(r => (st.pings[r.host] || 0) > 0).map(r => r.host);
    }

    function renderTools() {
        const host = $('gw-tools');
        if (!host) return;
        const p = st.payload || {};
        const sw = sweep();
        const rows = visible();
        const busy = st.busy || !!sw;
        // The relays a test has CONDEMNED — refused, unreachable, TLS blocked, timed out, or a
        // ping that came back with nothing. Counted here so the button can say how many it is
        // about to remove and disappear when there are none.
        const dead = deadOf(rows);

        host.innerHTML = `
      <div class="gw-search">
        <i class="ph ph-magnifying-glass"></i>
        <input type="search" id="gw-q" placeholder="جست‌وجوی کشور یا نام سرور" spellcheck="false" value="${esc(st.query)}">
        ${st.query ? '<button type="button" id="gw-q-clear" aria-label="پاک کردن"><i class="ph-bold ph-x"></i></button>' : ''}
      </div>

      <div class="gw-row-1">
        <div class="gw-chips" role="tablist">
          <button type="button" class="gw-chip${st.scope === 'mine' ? ' is-on' : ''}" data-gw-scope="mine">فهرست من · ${fa(st.mine.length)}</button>
          <button type="button" class="gw-chip${st.scope === 'archive' ? ' is-on' : ''}" data-gw-scope="archive">آرشیو · ${fa(st.archive.length)}</button>
        </div>
        <div class="gw-tb">
          <button type="button" data-gw-act="refresh" ${busy ? 'disabled' : ''} title="${p.canRefresh ? 'گرفتن فهرست تازه' : 'اول یکی از تونل‌های برنامه را روشن کنید'}">
            <i class="${st.busy ? 'mv-spin-ring' : 'ph-bold ph-arrows-clockwise'}"></i>به‌روز</button>
          ${sw ? `<button type="button" data-gw-act="stop" class="is-stop"><i class="ph-bold ph-stop-circle"></i>توقف تست</button>`
            : `<button type="button" data-gw-act="ping" ${busy || !rows.length ? 'disabled' : ''}><i class="ph-bold ph-gauge"></i>پینگ</button>
               <button type="button" data-gw-act="probe" ${busy || !rows.length ? 'disabled' : ''}><i class="ph-bold ph-pulse"></i>تست واقعی</button>`}
          <button type="button" data-gw-go="countries" class="${st.countries.length ? 'is-on' : ''}"><i class="ph-bold ph-globe-hemisphere-west"></i>کشور</button>
          <button type="button" data-gw-go="sort" class="${st.sort !== 'verified' ? 'is-on' : ''}"><i class="ph-bold ph-sort-ascending"></i>مرتب‌سازی</button>
          ${dead.length ? `<button type="button" data-gw-act="remove-dead" class="is-bad" ${busy ? 'disabled' : ''}
                  title="سرورهایی که در تست رد شدند یا جواب ندادند"><i class="ph-bold ph-trash"></i>حذف خراب‌ها · ${fa(dead.length)}</button>` : ''}
          <button type="button" data-gw-act="select" class="${st.selecting ? 'is-on' : ''}"><i class="ph-bold ph-check-square"></i>انتخاب</button>
          <button type="button" data-gw-go="guide"><i class="ph-bold ph-question"></i>راهنما</button>
        </div>
      </div>

      ${sw ? `
      <div class="gw-sweep">
        <span>${sw.kind === 'probe' ? 'تست واقعی' : 'پینگ'} — ${fa(sw.done)} از ${fa(sw.total)}</span>
        <span class="gw-bar"><i style="width:${sw.total ? Math.round(sw.done / sw.total * 100) : 0}%"></i></span>
        <span class="gw-num">${fa(sw.total ? Math.round(sw.done / sw.total * 100) : 0)}٪</span>
      </div>` : ''}

      ${st.selecting ? renderBulk(rows) : ''}

      <div class="gw-summary">
        <span>${fa(rows.length)} از ${fa(st.scope === 'mine' ? st.mine.length : st.archive.length)} سرور · ${esc((SORTS.find(x => x.id === st.sort) || {}).label || '')}</span>
        ${dead.length ? `<span>${fa(dead.length)} سرور در تست رد شده</span>` : ''}
        ${st.countries.length ? `<button type="button" data-gw-act="clear-countries">برداشتن فیلتر کشور (${fa(st.countries.length)})</button>` : ''}
      </div>`;
    }

    function renderBulk(rows) {
        const dead = deadOf(rows);
        const healthy = healthyOf(rows);
        const n = st.checked.length;
        return `
      <div class="gw-bulk">
        <b>${n ? fa(n) + ' سرور انتخاب شده' : 'چیزی انتخاب نشده'}</b>
        <div class="gw-bulk-acts">
          <button type="button" data-gw-act="check-healthy" ${healthy.length ? '' : 'disabled'}>سالم‌ها (${fa(healthy.length)})</button>
          ${st.scope === 'archive'
                ? `<button type="button" data-gw-act="keep" ${n ? '' : 'disabled'}>افزودن به فهرست من</button>`
                : `<button type="button" data-gw-act="drop" ${n ? '' : 'disabled'}>برداشتن از فهرست من</button>`}
          <button type="button" data-gw-act="remove-checked" class="is-bad" ${n ? '' : 'disabled'}>حذف (${fa(n)})</button>
          <button type="button" data-gw-act="remove-dead" class="is-bad" ${dead.length ? '' : 'disabled'}>حذف سرورهای قطع (${fa(dead.length)})</button>
        </div>
      </div>`;
    }

    function renderServers() {
        const host = $('gw-servers');
        if (!host) return;
        const s = (st.payload && st.payload.status) || {};
        const rows = visible();
        const note = $('gw-list-note');

        if (note) {
            note.innerHTML = st.scope === 'mine'
                ? 'همان فهرستی که دکمهٔ اتصال از آن انتخاب می‌کند: سرورهای زندهٔ همین حالا، به‌علاوهٔ هرچه خودتان از آرشیو اضافه کرده‌اید، منهای هرچه حذف کرده‌اید.'
                : 'هر سروری که برنامه تا امروز دیده. با هر «به‌روز» بزرگ‌تر می‌شود. سرورهای اینجا تا وقتی به «فهرست من» اضافه‌شان نکنید در دکمهٔ اتصال ظاهر نمی‌شوند.';
        }

        if (!rows.length) {
            host.innerHTML = `<div class="mv-form-row is-stack"><span class="mv-form-label">${emptyTitle()}<small>${emptyBody()}</small></span></div>`;
            return;
        }

        const locked = st.busy || s.connecting;
        const keptSet = st.kept;
        host.innerHTML = rows.map((r) => {
            const on = st.selected === r.host;
            const live = s.connected && s.host === r.host;
            const checked = has(st.checked, r.host);
            const mark = st.selecting
                ? `<span class="gw-mark${checked ? ' is-on' : ''}"><i class="${checked ? 'ph-fill ph-check-square' : 'ph ph-square'}"></i></span>`
                : (st.scope === 'archive' && has(keptSet, r.host))
                    ? '<span class="gw-mark is-on" title="در فهرست من"><i class="ph-fill ph-bookmark-simple"></i></span>'
                    : `<span class="gw-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span>`;
            return `
        <div class="mv-form-row" style="padding:0">
          <button type="button" class="gw-srow" data-host="${esc(r.host)}"${locked ? ' disabled' : ''}
                  role="radio" aria-checked="${on}">
            ${mark}
            ${flag(r.cc, 20)}
            <span class="gw-txt">
              <b>${esc(countryName(r.cc) || r.country)}${r.official ? ' · رسمی' : ''} <code>${esc(shortName(r.host))}</code></b>
              <small${live ? ' class="is-on"' : ''}>${live ? 'همین حالا وصل است — ' : ''}${fa(r.speedMbps)} مگابیت · ${fa(r.sessions)} نشست</small>
            </span>
            <span class="gw-end">${badgeFor(r.host)}</span>
          </button>
          <button type="button" class="gw-open" data-detail="${esc(r.host)}" title="صفحهٔ این سرور" aria-label="صفحهٔ این سرور"><i class="ph-bold ph-info"></i></button>
        </div>`;
        }).join('');
    }

    function badgeFor(host) {
        const p = st.probes[host];
        if (p && p.ok) {
            const b = probeBand(p.ms);
            return `<span class="gw-badge is-${b.tone}">${b.word}</span>`;
        }
        if (p) return `<span class="gw-badge is-bad">${PROBE_FAIL[p.reason] || 'رد شد'}</span>`;
        const g = st.pings[host];
        if (g > 0) return `<span class="gw-badge gw-num">${fa(g)}ms</span>`;
        if (g !== undefined) return '<span class="gw-badge is-bad">بی‌پاسخ</span>';
        return '<span class="gw-badge">تست نشده</span>';
    }

    function emptyTitle() {
        if (st.query || st.countries.length) return 'چیزی پیدا نشد';
        return st.scope === 'mine' ? 'فهرست خالی است' : 'آرشیو خالی است';
    }
    function emptyBody() {
        if (st.query) return `هیچ سروری با «${esc(st.query)}» جور در نیامد. جست‌وجو را پاک کنید یا کشور دیگری بزنید.`;
        if (st.countries.length) return 'در این کشورها سروری نیست. فیلتر کشور را بردارید، یا در «آرشیو» بگردید که ' + fa(st.archive.length) + ' سرور دارد.';
        return st.scope === 'mine'
            ? 'هنوز سروری ندارید. «به‌روز» را بزنید تا فهرست تازه گرفته شود، یا از «آرشیو» چندتا اضافه کنید.'
            : 'آرشیو با هر بار به‌روزرسانی پر می‌شود. دکمهٔ «به‌روز» بالا را بزنید.';
    }

    // ── countries ──────────────────────────────────────────────────────────

    function renderCountries() {
        const host = $('gw-countries');
        if (!host) return;
        const pool = st.scope === 'mine' ? st.mine : st.archive;
        const counts = new Map();
        for (const r of pool) counts.set(r.cc, (counts.get(r.cc) || 0) + 1);
        const list = [...counts.entries()]
            .map(([cc, n]) => ({ cc, n, name: countryName(cc) }))
            .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'fa'));

        const head = $('gw-country-head');
        if (head) head.textContent = `کشور — ${fa(list.length)} کشور در ${st.scope === 'mine' ? 'فهرست من' : 'آرشیو'}`;

        const tools = $('gw-country-tools');
        if (tools) {
            tools.innerHTML = `
        <div class="gw-row-1">
          <div class="gw-tb" style="margin-inline-start:0">
            <button type="button" data-gw-act="clear-countries" ${st.countries.length ? '' : 'disabled'}>
              <i class="ph-bold ph-x"></i>همهٔ کشورها</button>
          </div>
          <span class="gw-summary" style="margin-inline-start:auto">${st.countries.length ? fa(st.countries.length) + ' کشور انتخاب شده' : 'بدون فیلتر'}</span>
        </div>`;
        }

        host.innerHTML = list.map((c) => {
            const on = has(st.countries, c.cc);
            return `
        <div class="mv-form-row" style="padding:0">
          <button type="button" class="gw-crow" data-cc="${esc(c.cc)}" role="checkbox" aria-checked="${on}">
            <span class="gw-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-square' : 'ph ph-square'}"></i></span>
            ${flag(c.cc, 20)}
            <span class="gw-cname">${esc(c.name)}</span>
            <small>${fa(c.n)}</small>
          </button>
        </div>`;
        }).join('');
    }

    // ── sort ───────────────────────────────────────────────────────────────

    function renderSorts() {
        const host = $('gw-sorts');
        if (!host) return;
        host.innerHTML = SORTS.map((x) => {
            const on = st.sort === x.id;
            return `
      <button type="button" class="mv-form-row is-action" data-sort="${x.id}" role="radio" aria-checked="${on}">
        <span class="mv-row-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span>
        <span class="mv-form-label">${esc(x.label)}<small>${esc(x.detail)}</small></span>
      </button>`;
        }).join('');
    }

    // ── one server's page ──────────────────────────────────────────────────

    function renderDetail() {
        const host = $('gw-detail');
        if (!host) return;
        const r = st.mine.find(x => x.host === st.detailHost)
            || st.archive.find(x => x.host === st.detailHost);
        if (!r) {
            // The row it was opened from has been deleted underneath it.
            host.innerHTML = '';
            if (gwSec === 'detail') gwGoSec('servers');
            return;
        }
        const p = st.probes[r.host];
        const g = st.pings[r.host];
        const kept = has(st.kept, r.host);
        const isSel = st.selected === r.host;

        const kv = (k, v) => `<div class="mv-form-row"><span class="mv-form-label">${k}</span><span class="mv-row-end" dir="auto">${v}</span></div>`;

        host.innerHTML = `
    <div class="mv-form">
      <div class="mv-form-section">
        <div class="mv-form-header">${flag(r.cc, 22)} ${esc(countryName(r.cc) || r.country)} · <code>${esc(shortName(r.host))}</code></div>
        <div class="mv-form-group">
          ${kv('پینگ', g === undefined ? 'تست نشده' : g > 0 ? `<span class="gw-num">${fa(g)}ms</span>` : '<span style="color:var(--mv-orange)">بی‌پاسخ</span>')}
          ${kv('تست واقعی', !p ? 'تست نشده'
                : p.ok ? `<span style="color:var(--mv-green-ink,var(--mv-green))">${probeBand(p.ms).word} · <span class="gw-num">${fa(p.ms)}ms</span></span>`
                    : `<span style="color:var(--mv-red-ink,var(--mv-red))">${PROBE_FAIL[p.reason] || 'رد شد'}</span>`)}
          ${p && p.at ? kv('زمان تست', esc(ago(p.at))) : ''}
        </div>
        <div class="mv-form-footer">پینگ فقط می‌گوید بسته چقدر طول می‌کشد به سرور برسد. «تست واقعی» دست‌دادن کامل را با سرور انجام می‌دهد؛ نتیجهٔ سبزش یعنی این سرور روی خط اینترنت شما واقعاً وصل می‌شود.</div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">خود سرور</div>
        <div class="mv-form-group">
          ${kv('نوع', r.official ? 'رسمی — روی زیرساخت خود سرویس' : 'داوطلبانه — روی خط خانگی یک نفر')}
          ${kv('کشور', esc(countryName(r.cc)) + ' · <code>' + esc(r.cc) + '</code>')}
          ${kv('امتیاز VPN Gate', `<span class="gw-num">${fa(r.score)}</span>`)}
          ${kv('پهنای باند اعلامی', `<span class="gw-num">${fa(r.speedMbps)}</span> مگابیت`)}
          ${kv('مدت روشن بودن', esc(uptimeText(r.uptimeMs)))}
          ${kv('نشست‌های فعال', fa(r.sessions))}
          ${kv('سیاست نگهداری لاگ', logPolicy(r.logType))}
          ${r.operator ? kv('گردانندهٔ سرور', esc(r.operator)) : ''}
          ${kv('نام میزبان', `<code dir="ltr">${esc(r.host)}</code>`)}
          ${kv('نشانی', `<code dir="ltr">${esc(r.ip)}</code>`)}
        </div>
        <div class="mv-form-footer">${r.official
            ? 'این سرور روی زیرساخت خود سرویس اجرا می‌شود؛ معمولاً پایدارتر است و پورتش کمتر بسته می‌شود.'
            : 'این سرور را یک داوطلب روی خط خانگی‌اش به اشتراک گذاشته. ممکن است هر لحظه خاموش شود.'}</div>
      </div>

      ${r.message ? `
      <div class="mv-form-section">
        <div class="mv-form-header">پیام گردانندهٔ سرور</div>
        <div class="mv-form-group"><div class="mv-form-row is-stack"><span class="mv-form-label" dir="auto" style="white-space:pre-wrap">${esc(r.message)}</span></div></div>
      </div>` : ''}

      <div class="mv-form-section">
        <div class="mv-form-header">کارها</div>
        <div class="mv-form-group">
          <button type="button" class="mv-form-row is-action" data-gw-act="detail-select" ${isSel ? 'disabled' : ''}>
            <span class="mv-row-mark${isSel ? ' is-on' : ''}"><i class="${isSel ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span>
            <span class="mv-form-label">${isSel ? 'همین حالا انتخاب شده' : 'انتخاب برای اتصال'}</span>
          </button>
          <button type="button" class="mv-form-row is-action" data-gw-act="detail-keep">
            <span class="mv-row-mark${kept ? ' is-on' : ''}"><i class="ph-fill ph-bookmark-simple"></i></span>
            <span class="mv-form-label">${kept ? 'برداشتن از فهرست من' : 'افزودن به فهرست من'}</span>
          </button>
          <button type="button" class="mv-form-row is-action" data-gw-act="detail-remove">
            <span class="mv-row-mark"><i class="ph-fill ph-trash" style="color:var(--mv-red)"></i></span>
            <span class="mv-form-label" style="color:var(--mv-red-ink,var(--mv-red))">حذف این سرور</span>
          </button>
        </div>
      </div>
    </div>`;
    }

    // ── the guide ──────────────────────────────────────────────────────────

    function renderGuide() {
        const host = $('gw-guide');
        if (!host || host.dataset.built === '1') return;
        host.dataset.built = '1';
        const para = (icon, tint, title, body) => `
      <div class="mv-form-row is-stack">
        <span class="mv-form-label"><span class="mv-side-tile" style="--tint:${tint};width:22px;height:22px;display:inline-grid;vertical-align:-5px;margin-inline-end:7px"><i class="${icon}"></i></span>${title}<small>${body}</small></span>
      </div>`;

        host.innerHTML = `
    <div class="mv-form">
      <div class="mv-form-section">
        <div class="mv-form-header">دو فهرست</div>
        <div class="mv-form-group">
          ${para('ph-fill ph-list-checks', 'var(--mv-blue)', 'فهرست من',
            'همان فهرستی است که دکمهٔ اتصال از آن انتخاب می‌کند. سروری که به آن اضافه کنید حتی بعد از اینکه VPN Gate از فهرست عمومی برش دارد هم می‌ماند.')}
          ${para('ph-fill ph-archive', 'var(--mv-indigo)', 'آرشیو',
            'برنامه هر سروری را که تا امروز دیده در یک آرشیو نگه می‌دارد، پس آرشیو شما معمولاً خیلی بزرگ‌تر از تعداد سرورهای زندهٔ همین لحظه است.')}
        </div>
        <div class="mv-form-footer">این سرورها را داوطلب‌هایی از سراسر دنیا به اشتراک می‌گذارند و مدام کم و زیاد می‌شوند.</div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">دو تست</div>
        <div class="mv-form-group">
          ${para('ph-fill ph-gauge', 'var(--mv-gray)', 'پینگ',
            'فقط اندازه می‌گیرد بستهٔ شما چقدر طول می‌کشد به سرور برسد. سریع است ولی تضمین نمی‌کند اتصال برقرار شود.')}
          ${para('ph-fill ph-pulse', 'var(--mv-green)', 'تست واقعی',
            'واقعاً دست‌دادن (handshake) با سرور را انجام می‌دهد؛ نتیجهٔ سبزش یعنی این سرور روی خط اینترنت شما واقعاً وصل می‌شود. کندتر است ولی روی خطوط ایران بسیار قابل‌اعتمادتر — و این دو می‌توانند با هم مخالف باشند.')}
        </div>
        <div class="mv-form-footer">نتیجهٔ «تست واقعی» به‌صورت سریع / متوسط / کند کنار هر سرور نشان داده می‌شود. عدد دقیقش را در صفحهٔ خود سرور می‌بینید. اگر سروری پینگ خوبی می‌دهد ولی وصل نمی‌شود، این تست علتش را نشان می‌دهد.</div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">کنترل‌ها</div>
        <div class="mv-form-group">
          ${para('ph-fill ph-globe-hemisphere-west', 'var(--mv-blue)', 'کشور',
            'فهرست را به یک یا چند کشور محدود می‌کند. می‌توانید چند کشور را با هم انتخاب کنید — مثلاً برای اینکه یک قاره را یک‌جا تست بگیرید.')}
          ${para('ph-fill ph-sort-ascending', 'var(--mv-orange)', 'مرتب‌سازی',
            'ترتیب فقط روی نمایش اثر دارد؛ هیچ سروری با آن حذف یا اضافه نمی‌شود. پیش‌فرض روی «تست‌شده‌ها اول» است.')}
          ${para('ph-fill ph-check-square', 'var(--mv-indigo)', 'انتخاب',
            'با دکمهٔ «انتخاب» بالای صفحه چند سرور را با هم تیک می‌زنید تا یک‌جا به فهرستتان اضافه یا از آن حذف شوند.')}
          ${para('ph-fill ph-trash', 'var(--mv-red)', 'حذف سرورهای قطع',
            'فقط سرورهایی را پاک می‌کند که تست شده‌اند و پاسخ نداده‌اند. سرورهای تست‌نشده هرگز حذف نمی‌شوند.')}
        </div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">پیشنهاد</div>
        <div class="mv-form-group">
          <div class="mv-form-row is-stack"><span class="mv-form-label">اولین بار «تست واقعی» را بزنید، چند دقیقه صبر کنید، بعد اولین سرور سبز فهرست را انتخاب کنید. اگر هیچ‌کدام سبز نشد، به «آرشیو» بروید، یک کشور نزدیک را انتخاب کنید و همان تست را آنجا بگیرید.</span></div>
        </div>
      </div>
    </div>`;
    }

    // ── the strip along the bottom ─────────────────────────────────────────

    function renderBar() {
        const host = $('gw-foot');
        if (!host) return;
        const v = gwView();
        const s = v.s;
        const sw = sweep();
        const word = sw ? `${sw.kind === 'probe' ? 'تست واقعی' : 'پینگ'} — ${fa(sw.done)} از ${fa(sw.total)}`
            : s.connected ? 'وصل — تونل کامل سیستم'
                : s.connecting ? 'در حال برقراری نشست'
                    : !s.installed ? 'موتور سافت‌اتر نصب نیست'
                        : st.selected ? 'آمادهٔ اتصال' : 'سروری انتخاب نشده';
        const sel = selectedRow();
        host.innerHTML = `
      ${gwDot(sw ? 'busy' : v.tone)}
      <span>${word}</span>
      <span class="mv-eng-foot-end">${sel ? `<code dir="ltr">${esc(shortName(sel.host))}</code>` : ''}<span>${sel ? esc(countryName(sel.cc) || sel.country) : '—'}</span></span>`;
    }

    function renderLog() {
        const pre = $('gw-log');
        if (!pre) return;
        pre.textContent = st.log.length ? st.log.join('\n') : 'هنوز چیزی ثبت نشده.';
        pre.scrollTop = pre.scrollHeight;
    }

    function renderSnack() {
        const host = $('gw-snack');
        if (!host) return;
        const show = st.snack && (Date.now() - st.snackAt) < 2800;
        host.hidden = !show;
        host.innerHTML = show ? `<span>${esc(st.snack)}</span>` : '';
    }

    function say(msg) {
        st.snack = msg;
        st.snackAt = Date.now();
        renderSnack();
        setTimeout(() => { if (Date.now() - st.snackAt >= 2800) { st.snack = ''; renderSnack(); } }, 2900);
    }

    // ── navigation ─────────────────────────────────────────────────────────

    function gwGoSec(id) {
        const wrap = $('gw-wrap');
        if (!wrap) return;
        const known = GW_SECTIONS.some(x => x.id === id) || Object.prototype.hasOwnProperty.call(SUB, id);
        gwSec = known ? id : 'connect';
        wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === gwSec));
        // A sub-page keeps «سرورها» lit in the sidebar: the user is still inside the list, they
        // have merely opened one of its decisions.
        const lit = Object.prototype.hasOwnProperty.call(SUB, gwSec) ? 'servers' : gwSec;
        wrap.querySelectorAll('.mv-side-item[data-gw-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-gw-sec') === lit));
        const found = GW_SECTIONS.find((x) => x.id === gwSec);
        const title = $('gw-pane-title');
        if (title) title.textContent = found ? found.label : (SUB[gwSec] || '');
        const back = $('gw-back');
        if (back) back.disabled = gwSec === 'connect';
        const pane = wrap.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', gwSec === 'connect');
        const sc = $('gw-scroll');
        if (sc) sc.scrollTop = 0;
        paint();
    }

    /** The back button: a sub-page returns to the list it belongs to, the list to the hero. */
    function goBack() {
        gwGoSec(Object.prototype.hasOwnProperty.call(SUB, gwSec) ? 'servers' : 'connect');
    }

    // ── wiring ─────────────────────────────────────────────────────────────

    function gwWire() {
        const wrap = $('gw-wrap');
        if (!wrap) return;

        wrap.querySelectorAll('[data-gw-go]').forEach((b) => {
            b.onclick = () => gwGoSec(b.getAttribute('data-gw-go'));
        });
        wrap.querySelectorAll('[data-gw-act]').forEach((b) => { b.onclick = () => act(b.getAttribute('data-gw-act')); });
        wrap.querySelectorAll('[data-gw-scope]').forEach((b) => {
            b.onclick = () => {
                st.scope = b.getAttribute('data-gw-scope');
                st.selecting = false; st.checked = [];
                paint();
            };
        });
        wrap.querySelectorAll('[data-sort]').forEach((b) => {
            b.onclick = () => { st.sort = b.getAttribute('data-sort'); gwGoSec('servers'); };
        });
        wrap.querySelectorAll('[data-cc]').forEach((b) => {
            b.onclick = () => {
                const cc = b.getAttribute('data-cc');
                st.countries = has(st.countries, cc) ? without(st.countries, cc) : st.countries.concat([cc]);
                paint();
            };
        });
        wrap.querySelectorAll('[data-detail]').forEach((b) => {
            b.onclick = (e) => { e.stopPropagation(); st.detailHost = b.getAttribute('data-detail'); gwGoSec('detail'); };
        });
        wrap.querySelectorAll('.gw-srow[data-host]').forEach((b) => {
            b.onclick = () => {
                const h = b.getAttribute('data-host');
                if (st.selecting) {
                    st.checked = has(st.checked, h) ? without(st.checked, h) : st.checked.concat([h]);
                    paint();
                    return;
                }
                pick(h);
            };
        });

        const q = $('gw-q');
        if (q) {
            q.oninput = () => {
                st.query = q.value;
                // NOT paint(): that rebuilds the tool band, and rebuilding the band replaces the
                // input the user is typing into — the caret and the focus go with it, so the
                // second keystroke lands nowhere. Only the rows and the count change here.
                renderServers();
                const sum = wrap.querySelector('.gw-summary');
                const rows = visible();
                if (sum && sum.firstElementChild) sum.firstElementChild.textContent =
                    `${fa(rows.length)} از ${fa(st.scope === 'mine' ? st.mine.length : st.archive.length)} سرور · ${(SORTS.find(x => x.id === st.sort) || {}).label || ''}`;
                // The rows are new DOM and carry no listeners of their own; without this a row
                // found by searching cannot be clicked, which is the one thing a search is for.
                gwWire();
            };
        }
        const qc = $('gw-q-clear');
        if (qc) qc.onclick = () => { st.query = ''; paint(); };

        const udp = $('gw-udp');
        if (udp) udp.onchange = () => setUdp(udp.checked);

    }

    function act(k) {
        switch (k) {
            case 'power': if (gwView().act) toggle(); break;
            case 'refresh': doRefreshList(); break;
            case 'ping': startTest('ping'); break;
            case 'probe': startTest('probe'); break;
            case 'probe-top': gwGoSec('servers'); startTest('probe'); break;
            case 'stop': stopTest(); break;
            case 'select': st.selecting = !st.selecting; st.checked = []; paint(); break;
            case 'clear-countries': st.countries = []; paint(); break;
            case 'check-healthy': st.checked = healthyOf(visible()); paint(); break;
            case 'keep': curate('keep', st.checked); break;
            case 'drop': curate('drop', st.checked); break;
            case 'remove-checked': confirmRemove(st.checked); break;
            case 'remove-dead': confirmRemove(deadOf(visible())); break;
            case 'restore': curate('restore', []); break;
            case 'detail-select': pick(st.detailHost); gwGoSec('servers'); break;
            case 'detail-keep': curate(has(st.kept, st.detailHost) ? 'drop' : 'keep', [st.detailHost]); break;
            case 'detail-remove': confirmRemove([st.detailHost]); break;
            default: break;
        }
    }

    function paint() {
        if (!$('gw-wrap')) return;
        renderIdent();
        renderBar();
        renderSnack();
        if (gwSec === 'connect') { renderHero(); renderCards(); }
        if (gwSec === 'servers') { renderTools(); renderServers(); }
        if (gwSec === 'countries') renderCountries();
        if (gwSec === 'sort') renderSorts();
        if (gwSec === 'detail') renderDetail();
        if (gwSec === 'guide') renderGuide();
        if (gwSec === 'log') renderLog();
        gwWire();
    }

    // ── talking to the server ──────────────────────────────────────────────

    async function post(url, body) {
        const r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || ('خطای ' + r.status));
        return j;
    }

    async function refresh() {
        let d;
        try {
            const r = await fetch('/api/gateway/list');
            d = await r.json();
            if (!r.ok) return;
        } catch (e) { return; }

        st.payload = d;
        st.mine = d.mine || [];
        st.archive = d.archive || [];
        st.kept = d.kept || [];
        st.hidden = d.hidden || [];
        st.pings = d.pings || {};
        st.probes = d.probes || {};
        st.udp = d.udp !== false;
        st.suggested = d.suggested || null;

        // The server's remembered choice wins; ours is only a fallback for a first-ever open, and
        // «the first row» is never the answer — that list is sorted by megabits measured in Japan.
        if (d.selected) st.selected = d.selected;
        else if (!st.selected && d.suggested) { st.selected = d.suggested; pick(d.suggested, true); }

        paint();
    }

    function log(line) {
        st.log.push(line);
        if (st.log.length > 400) st.log = st.log.slice(-400);
        if (gwSec === 'log') renderLog();
        else if (gwSec === 'connect') renderCards();
    }

    async function pick(host, quiet) {
        if (!host) return;
        const was = (st.payload && st.payload.status) || {};
        st.selected = host;
        // A relay chosen out of the archive has to be kept as well, or the next refresh drops it
        // and the connect button holds a selection it cannot find.
        const inMine = st.mine.some(r => r.host === host);
        try {
            await post('/api/gateway/select', { host });
            if (!inMine) { await post('/api/gateway/curate', { action: 'keep', hosts: [host] }); }
        } catch (e) { /* the choice still stands for this session */ }
        if (!quiet) {
            if (!inMine) say('به فهرست شما اضافه شد');
            // Switching relays while connected should MOVE the tunnel, not leave the user on the
            // old one with a new name on screen.
            if (was.connected && was.host !== host) { await doConnect(host); return; }
        }
        await refresh();
    }

    async function toggle() {
        const s = (st.payload && st.payload.status) || {};
        if (s.connected || s.connecting) {
            st.busy = true; paint();
            try { await post('/api/gateway/disconnect'); log('— قطع شد'); }
            catch (e) { log('✗ ' + e.message); }
            st.busy = false;
            await refresh();
            return;
        }
        await doConnect(st.selected);
    }

    async function doConnect(host) {
        if (!host) return;
        st.busy = true; st.log = []; paint();
        try { await post('/api/gateway/connect', { host }); }
        catch (e) { log('✗ ' + e.message); }
        st.busy = false;
        await refresh();
    }

    async function doRefreshList() {
        st.busy = true; paint();
        try {
            const out = await post('/api/gateway/refresh');
            say(out.added ? fa(out.added) + ' سرور تازه پیدا شد' : 'سرور تازه‌ای پیدا نشد');
        } catch (e) { log('✗ ' + e.message); say(e.message); }
        st.busy = false;
        await refresh();
    }

    async function startTest(kind) {
        const rows = visible();
        if (!rows.length) return;
        try {
            await post('/api/gateway/test', { kind, hosts: rows.map(r => r.host) });
        } catch (e) { say(e.message); }
        await refresh();
    }

    async function stopTest() {
        try { await post('/api/gateway/test/cancel'); } catch (e) { /* it may have just ended */ }
        await refresh();
    }

    async function setUdp(on) {
        try {
            await post('/api/gateway/udp', { on });
            st.udp = !!on;
        } catch (e) { say(e.message); }
        await refresh();
    }

    async function curate(action, hosts) {
        try {
            const out = await post('/api/gateway/curate', { action, hosts });
            if (action === 'keep') say(fa(out.n) + ' سرور به فهرست شما اضافه شد');
            else if (action === 'drop') say('از فهرست شما برداشته شد');
            else if (action === 'restore') say(fa(out.n) + ' سرور به فهرست برگشت');
            else say(fa(out.n) + ' سرور حذف شد');
        } catch (e) { say(e.message); }
        st.selecting = false; st.checked = [];
        await refresh();
    }

    /**
     * Deleting in bulk asks first, and says how many and from where.
     *
     * The scope decides which verb: from «فهرست من» a delete is a deny-list entry that survives
     * the next refresh (and is undoable from the connect page); from «آرشیو» the row itself goes.
     * Saying so is the difference between a deletion the user meant and one they will report as a
     * bug three days later.
     */
    function confirmRemove(hosts) {
        const list = (hosts || []).filter(Boolean);
        if (!list.length) return;
        const mine = st.scope === 'mine';
        const body = mine
            ? 'از فهرست شما پاک می‌شوند و دیگر برنمی‌گردند، حتی اگر VPN Gate دوباره منتشرشان کند. می‌توانید بعداً از «بازگرداندن حذف‌شده‌ها» در صفحهٔ اتصال برگردانیدشان.'
            : 'از آرشیو پاک می‌شوند. اگر VPN Gate دوباره منتشرشان کند، در به‌روزرسانی بعدی به‌عنوان سرور تازه برمی‌گردند.';
        const go = () => curate(mine ? 'hide' : 'purge', list);
        // The app's own dialog (ui-modal.js), not the browser's — a bare Windows box in the
        // middle of this window is the one surface that does not belong to the app.
        if (window.uiModal && uiModal.confirm) {
            uiModal.confirm({
                title: `حذف ${fa(list.length)} سرور؟`,
                message: body,
                confirmLabel: 'حذف',
                cancelLabel: 'انصراف',
                danger: true,
            }).then((yes) => { if (yes) go(); });
        } else if (window.confirm(`حذف ${fa(list.length)} سرور؟\n\n${body}`)) { go(); }
    }

    // ── pushed events ──────────────────────────────────────────────────────

    window.handleGatewayLog = function (d) {
        const line = (d && d.line) || '';
        if (/^\[گیت‌وی\]/.test(line)) log(line.replace(/^\[گیت‌وی\]\s*/, ''));
    };

    /**
     * The status the server pushes, which now carries the sweep's progress.
     *
     * Applied without a round trip so the progress bar moves at the rate the sweep reports rather
     * than at the 4-second poll's — and only the parts that changed are redrawn, because
     * re-rendering the list under a user who is scrolling it is its own bug.
     */
    window.handleGatewayStatus = function (s) {
        if (!s || !st.payload) return;
        const hadSweep = !!(st.payload.status && st.payload.status.sweep);
        st.payload.status = s;
        if (typeof s.udp === 'boolean') st.udp = s.udp;
        if (!$('gw-wrap')) return;
        renderBar();
        if (gwSec === 'connect') { renderHero(); renderCards(); }
        // A sweep that has just ended means new results, which the list must be redrawn from.
        if (gwSec === 'servers') { renderTools(); if (hadSweep && !s.sweep) { refresh(); } else { renderServers(); } gwWire(); }
        else if (hadSweep && !s.sweep) refresh();
    };

    window.MVProbe = window.MVProbe || {};
    window.MVProbe.gateway = () => !!(st.payload && st.payload.status && st.payload.status.connected);
    /** What the desktop's «وضعیت اتصال» widget shows about a live session. */
    window.MVProbe.gatewayInfo = () => {
        const s = (st.payload && st.payload.status) || {};
        return {
            host: s.host ? shortName(s.host) : null,
            tcp: s.tcpConnections || 0,
            maxTcp: s.maxTcp || 0,
        };
    };

    window.gatewayRefresh = refresh;

    window.initGatewayModule = function () {
        const root = $('ls-gateway');
        if (!root) return;
        root.innerHTML = template();
        if (root.parentElement) {
            root.parentElement.style.position = 'relative';
            root.parentElement.style.padding = '0';
            root.parentElement.style.overflow = 'hidden';
        }
        root.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent;';

        $('gw-wrap').querySelectorAll('.mv-side-item[data-gw-sec]').forEach((b) => {
            b.onclick = () => gwGoSec(b.getAttribute('data-gw-sec'));
        });
        $('gw-back').onclick = goBack;
        gwGoSec('connect');
        refresh();
        setInterval(() => {
            const r = $('ls-gateway');
            if (r && r.style.display !== 'none') refresh();
        }, 4000);
    };
})();
