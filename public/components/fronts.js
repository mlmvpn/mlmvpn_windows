// --- «سایفون», «تور» and «لنترن» panels ---
//
// ONE FILE FOR ALL THREE, and that is the point. They differ in three things — what a "method" is
// called, which methods exist, and whether a country can be chosen at all — and everything else is
// the same: pick a method, pick how much of the machine it covers, connect, watch it happen.
// Written three times, the safety rules (never leave the adapter up over a dead engine; never claim
// connected before bytes move) would sit in three places to drift apart.
//
// Built with the page kit (ui/page-kit.css) so these windows read as part of Settings: a hero that
// says what is happening, methods chosen as rows rather than a dropdown, the ladder shown as steps
// while it walks, and ONE button, in the bottom bar.
//
// Renders into #ls-psiphon, #ls-tor and #ls-lantern. Talks to /api/psiphon/*, /api/tor/*,
// /api/lantern/* and /api/front/tun.

(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Persian digits, so a number inside a Persian sentence is not half Latin. */
    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);

    /**
     * What differs between the two engines, in one place.
     *
     * The noun for a rung is not shared, because the two really are different ideas: Psiphon's are
     * strategies for FINDING a server, Tor's are transports for HIDING the connection. One word for
     * both would be vague in the way that makes people pick at random.
     */
    const FRONTS = {
        psiphon: {
            id: 'psiphon', title: 'سایفون', api: '/api/psiphon',
            tint: 'var(--mv-red)', icon: 'ph-fill ph-share-network',
            methodsHeader: 'رتبهٔ اتصال',
            headline: 'به دنیایی بدون محدودیت وصل شوید.',
            blurb: 'شبکهٔ سایفون با هستهٔ رسمی خودش. سه رتبهٔ اتصال دارد و خودکار به‌ترتیب امتحان می‌کند تا آن‌که روی اینترنت شما جواب می‌دهد پیدا شود.',
            methodsFooter: 'روی خطی که هر آدرس سروری را مسدود کرده، تنها چیزی که کار می‌کند <b>دامین‌فرانتینگ</b> است: اتصال روی لبهٔ یک CDN تمام می‌شود، پس آدرس سروری برای بلاک کردن وجود ندارد. همین اول امتحان می‌شود، و رتبه‌ای که روی خط شما جواب داد برای دفعهٔ بعد می‌ماند.',
            regionFooter: 'فهرست، کشورهایی است که خودِ هسته گزارش می‌دهد در دسترس‌اند. اگر کشوری بخواهید که سرور دامین‌فرانتینگ ندارد، محدودیت پروتکل برداشته می‌شود — نه کشوری که انتخاب کرده‌اید.',
        },
        tor: {
            id: 'tor', title: 'تور', api: '/api/tor',
            tint: 'var(--mv-purple)', icon: 'ph-fill ph-shield',
            methodsHeader: 'روش اتصال',
            headline: 'سه لایه رمزنگاری، روی همهٔ ترافیک.',
            blurb: 'شبکهٔ تور با سه لایه رمزنگاری روی همهٔ ترافیک، نه فقط مرورگر. چهار روش دارد و حالت خودکار از بالا امتحان می‌کند.',
            methodsFooter: 'ترتیب خودکار: مستقیم، بعد Meek، بعد obfs4، آخر Snowflake. مستقیم هرجا کار کند سریع‌ترین است؛ Meek از دید شبکه فقط HTTPS به یک CDN است و تقریباً همه‌جا رد می‌شود. روشی که جواب داد برای دفعهٔ بعد می‌ماند.',
            regionFooter: 'عدد کنار هر کشور تعداد رلهٔ خروجی واقعی آن است — صادق‌ترین پیش‌بینی از اینکه انتخابتان محترم شمرده می‌شود یا نه. این یک <b>ترجیح</b> است نه تضمین: اگر مداری در آن کشور ساخته نشود، جای دیگری خارج می‌شوید.',
        },
        lantern: {
            id: 'lantern', title: 'لنترن', api: '/api/lantern',
            tint: 'var(--mv-teal)', icon: 'ph-fill ph-lightbulb-filament',
            methodsHeader: 'مسیریابی',
            headline: 'سرورها را خودش پیدا می‌کند.',
            // NO COUNTRY SECTION. The free tier does not let one be chosen — the core ranks its own
            // servers on measured speed and re-picks as they fail — so a picker here would be a
            // control that does nothing. Where it comes out is reported after the fact, in the hero.
            regions: false,
            blurb: 'شبکهٔ لنترن با هستهٔ رسمی خودش. سرورها را خودش پیدا و رتبه‌بندی می‌کند؛ چیزی برای انتخاب کردن ندارد.',
            methodsFooter: 'هستهٔ لنترن فهرست سرورهایش را از راه <b>دامین‌فرانتینگ</b> می‌گیرد، پس روی خطی که آدرس سرورها مسدود است هم به فهرست می‌رسد. اولین اتصال روی پروفایل نو ۱۵ تا ۴۵ ثانیه طول می‌کشد؛ دفعه‌های بعد چند ثانیه.',
        },
        geph: {
            id: 'geph', title: 'گف', api: '/api/geph',
            tint: 'var(--mv-blue)', icon: 'ph-fill ph-cloud-fog',
            // NO METHOD SECTION. The client picks its own transport per session — it came up on
            // `sosistab3` here — and there is no supported way to ask for another. A picker would be
            // a control that does nothing. Which one it used is reported after the fact, in the log.
            methods: false,
            account: true,
            headline: 'بروکری که آدرسی برای بلاک شدن ندارد.',
            blurb: 'شبکهٔ گف با هستهٔ رسمی خودش. سرورِ هماهنگی‌اش هم پشت سایت‌های بزرگ پنهان است، پس آدرسی برای بلاک کردن ندارد.',
            regionFooter: 'عدد کنار هر کشور تعداد سرور خروج واقعی آن است — فهرست از خودِ شبکه پرسیده می‌شود، نه از یک لیست ثابت. کشوری که سرور ندارد اتصالی است که هیچ‌وقت تمام نمی‌شود، پس آنچه اینجا نیست واقعاً نیست.',
        },
    };

    /**
     * Lantern's one real lever.
     *
     * Not a ladder and not a transport — it changes WHICH traffic goes through the engine at all.
     * Both values are defensible, so it is a choice rather than a default nobody can see.
     */
    const LANTERN_MODES = [
        {
            value: 'all', title: 'همهٔ ترافیک', hint: 'همه چیز از لنترن رد می‌شود — امن‌تر',
        },
        {
            value: 'smart', title: 'هوشمند', hint: 'فقط سایت‌های مسدود؛ بقیه مستقیم — سریع‌تر، ولی شبکهٔ محلی می‌بیند کجا می‌روید',
        },
    ];

    /**
     * How much of the machine the engine covers. ONE CHOICE, made before connecting.
     *
     * This replaces a second button beside the connect button, which is what made the window
     * confusing: two controls with no stated relationship, the second one disabled for a reason
     * nothing on screen gave. Coverage is not a separate feature — it is the same connection,
     * carried differently — so it is a choice, in the shape «اتصال سریع» already uses.
     */
    const COVERAGE = [
        { id: 'proxy', title: 'فقط پروکسی', short: 'یک پورت محلی؛ هر برنامه‌ای که خودتان تنظیم کنید', icon: 'ph-plugs-connected' },
        { id: 'tunnel', title: 'تونل کامل سیستم', short: 'همهٔ برنامه‌ها، بدون تنظیم کردن هیچ‌کدام', icon: 'ph-globe-hemisphere-east' },
    ];

    const st = {
        psiphon: { payload: null, method: '', region: 'auto', coverage: 'proxy', busy: false, sec: 'connect', logOpen: false, log: [] },
        tor: { payload: null, method: 'auto', region: 'auto', coverage: 'proxy', busy: false, sec: 'connect', logOpen: false, log: [] },
        lantern: { payload: null, method: 'all', region: 'auto', coverage: 'proxy', busy: false, sec: 'connect', logOpen: false, log: [] },
        geph: { payload: null, method: '', region: 'auto', city: '', coverage: 'proxy', busy: false, sec: 'connect', logOpen: false, log: [],
                acct: null, regBusy: false, regPct: 0, acctNote: '', guideOpen: false },
    };

    /**
     * A flag as a bundled SVG, never as an emoji.
     *
     * Windows ships no glyphs for regional-indicator pairs, so an emoji flag renders as two boxed
     * letters — on exactly the rows whose job is to show a flag. `public/assets/flags/{cc}.svg` is
     * already in the app (the «اتصال سریع» panel uses it). The code sits behind the image, so a
     * country we have no file for still reads as «PT» rather than as a hole.
     */
    function flag(cc, w = 19) {
        const h = Math.round(w * 0.72);
        if (!cc) return `<span class="mv-flag is-none" style="width:${w}px;height:${h}px"></span>`;
        const code = String(cc).toLowerCase();
        return `<span class="mv-flag" style="width:${w}px;height:${h}px">${esc(String(cc).toUpperCase())}`
            + `<img src="/assets/flags/${esc(code)}.svg" alt="" onerror="this.remove()"></span>`;
    }

    /**
     * The country's name in Persian, from the system's own data.
     *
     * A hand-written table would cover the two dozen countries someone thought of and print bare
     * codes for the rest — and تور alone exposes sixty. Intl has the whole list, in every locale,
     * and is already in Electron.
     */
    let REGION_NAMES = null;
    function countryName(cc) {
        const code = String(cc || '').toUpperCase();
        if (!code || code === 'AUTO') return '';
        try {
            if (!REGION_NAMES) REGION_NAMES = new Intl.DisplayNames(['fa'], { type: 'region' });
            const n = REGION_NAMES.of(code);
            if (n && n !== code) return n;
        } catch (e) { /* no Intl data: the code itself is the honest answer */ }
        return code;
    }

    const $ = (id) => document.getElementById(id);
    const el = (front, part) => $(`${front}-${part}`);

    // ── The page ───────────────────────────────────────────────────────────
    //
    // The shape of Settings and the Store — an inset glass sidebar, a pane with a title band — with
    // the Store's product page as the model for the action: a hero that says what is happening and
    // carries the one button, the live facts in a divided strip under it, and each preference in its
    // own section instead of one long scroll. `ui/page-kit.css › Engine page` owns every rule that
    // is not specific to this file.
    const CSS = `
<style id="fr-css">
  .fr-wrap { height:100%; min-height:0; }
  .fr-wrap .fr-log {
    margin:0; width:100%; max-height:none; min-height:220px; overflow:auto;
    font-family:var(--mv-font-latin, ui-monospace), monospace; font-size:11px; line-height:1.7;
    white-space:pre-wrap; word-break:break-word; text-align:left;
    color:var(--mv-label-2);
  }
  .fr-wrap .fr-note { color:var(--mv-label-3); }
  .fr-wrap code { font-family:var(--mv-font-latin, ui-monospace), monospace; font-size:.92em; }
  @keyframes fr-spin { to { transform:rotate(360deg); } }
  /* A DRAWN RING, not a rotating glyph.
     A font glyph sits on a baseline with its own bearings, so its optical centre is not the centre
     of its box; rotating it wobbles however well the box itself is centred. A border ring has no
     such offset. Sized in em, so one rule serves the 9.5px step marker and the big hero icon. */
  .fr-wrap .fr-spin { display:inline-flex; align-items:center; justify-content:center; line-height:1; }
  .fr-wrap .fr-spin::before {
    content:''; display:block; box-sizing:border-box;
    width:.8em; height:.8em;
    border:.14em solid currentColor; border-top-color:transparent; border-radius:50%;
    animation:fr-spin .8s linear infinite;
  }
  html[data-motion="reduced"] .fr-wrap .fr-spin::before { animation:none; }

  /* The guide is prose, which the form kit has no row for. */
  .fr-wrap .fr-guide { font-size:12.5px; line-height:1.85; opacity:.92; }
  .fr-wrap .fr-guide h4 { margin:14px 0 6px; font-size:12.5px; font-weight:650; opacity:1; }
  .fr-wrap .fr-guide h4:first-child { margin-top:0; }
  .fr-wrap .fr-guide ol, .fr-wrap .fr-guide ul { margin:0; padding-inline-start:1.35em; }
  .fr-wrap .fr-guide li { margin:3px 0; }
  .fr-wrap .fr-guide code { font-size:11.5px; padding:1px 4px; border-radius:4px;
    background:color-mix(in srgb, currentColor 9%, transparent); }
  /* A progress bar for the sign-up puzzle: real work with a real duration, so it says how much
     longer rather than just «wait». */
  .fr-wrap .fr-bar { height:5px; border-radius:3px; overflow:hidden; width:100%;
    background:color-mix(in srgb, currentColor 14%, transparent); }
  .fr-wrap .fr-bar > i { display:block; height:100%; border-radius:3px; background:currentColor;
    transition:width .3s ease; }
</style>`;

    /**
     * The sidebar's sections, per engine.
     *
     * Only what that engine really has: گف has no method list (the client picks its own transport),
     * لنترن has no country (the free tier does not allow one), and only گف has an account. A section
     * for a control that does nothing is the thing this page was rebuilt to remove.
     */
    function sections(f) {
        const out = [{ id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' }];
        if (f.account) out.push({ id: 'account', label: 'حساب', icon: 'ph-fill ph-user-circle', tint: 'var(--mv-indigo)' });
        if (f.methods !== false) out.push({ id: 'methods', label: f.methodsHeader, icon: 'ph-fill ph-list-checks', tint: 'var(--mv-blue)' });
        out.push({ id: 'coverage', label: 'پوشش', icon: 'ph-fill ph-globe-hemisphere-east', tint: 'var(--mv-orange)' });
        if (f.regions !== false) out.push({ id: 'region', label: 'کشور خروج', icon: 'ph-fill ph-flag-banner', tint: 'var(--mv-pink, #FF2D55)' });
        if (f.account) out.push({ id: 'guide', label: 'راهنما', icon: 'ph-fill ph-question', tint: 'var(--mv-gray)' });
        out.push({ id: 'log', label: 'گزارش', icon: 'ph-fill ph-terminal-window', tint: 'var(--mv-gray)' });
        return out;
    }

    const SEC_TITLE = { connect: 'اتصال', account: 'حساب', coverage: 'پوشش', region: 'کشور خروج', guide: 'راهنما', log: 'گزارش' };

    function template(f) {
        const secs = sections(f);
        return CSS + `
<div id="${f.id}-wrap" dir="rtl" class="fr-wrap mv-split">
  <aside class="mv-side" aria-label="بخش‌های ${esc(f.title)}">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="${f.id}-card"></div>
    <nav class="mv-side-list" id="${f.id}-nav">
      <div class="mv-side-group">
        ${secs.map(x => `
        <button type="button" class="mv-side-item" data-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${esc(x.label)}</span>
        </button>`).join('')}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="${f.id}-store"
                title="هستهٔ ${esc(f.title)} در ام‌ال‌ام استور">
          <span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="ph-fill ph-arrow-circle-down"></i></span>
          <span>بررسی بروزرسانی</span>
          <i class="ph-bold ph-arrow-up-left" aria-hidden="true"></i>
        </button>
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="${f.id}-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="${f.id}-title">اتصال</h1>
      <div class="mv-eng-bar-action" id="${f.id}-bar-action"></div>
    </header>

    <div class="mv-pane-scroll custom-scrollbar">

      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="${f.id}-stage" style="--tint:${f.tint}"></div>
        <!-- The run itself: one line, right under the button that starts it and above the cards. -->
        <div class="mv-eng-flow" id="${f.id}-steps-sec" style="display:none">
          <div class="mv-steps" id="${f.id}-steps"></div>
        </div>
        <div class="mv-eng-grid" id="${f.id}-cards"></div>
        <div class="mv-form mv-eng-adv">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">تنظیمات پیشرفته</div>
            <div class="mv-form-group" id="${f.id}-adv"></div>
            <div class="mv-form-footer" id="${f.id}-adv-note"></div>
          </div>
        </div>
      </div>

      ${f.account ? `
      <div class="mv-eng-sec" data-sec="account">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="mv-form-header">حساب</div>
            <div class="mv-form-group" id="${f.id}-account"></div>
            <div class="mv-form-footer" id="${f.id}-account-note"></div>
          </div>
        </div>
      </div>` : ''}

      ${f.methods === false ? '' : `
      <div class="mv-eng-sec" data-sec="methods">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="mv-form-header">${f.methodsHeader}</div>
            <div class="mv-form-group" id="${f.id}-methods" role="radiogroup"></div>
            <div class="mv-form-footer" id="${f.id}-methods-note">${f.methodsFooter}</div>
          </div>
        </div>
      </div>`}

      <div class="mv-eng-sec" data-sec="coverage">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="mv-form-header">پوشش</div>
            <div class="mv-form-group" id="${f.id}-coverage" role="radiogroup"></div>
            <div class="mv-form-footer" id="${f.id}-coverage-note"></div>
          </div>
        </div>
      </div>

      ${f.regions === false ? '' : `
      <div class="mv-eng-sec" data-sec="region">
        <div class="mv-form">
          <div class="mv-form-section">
            <div class="mv-form-header">کشور خروج</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack"><div id="${f.id}-region-sec"></div></div>
            </div>
            <div class="mv-form-footer">${f.regionFooter}</div>
          </div>
        </div>
      </div>`}

      ${f.account ? `
      <div class="mv-eng-sec" data-sec="guide">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">ثبت‌نام و باز کردن سایت گف</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack"><div class="fr-guide" id="${f.id}-guide"></div></div>
            </div>
          </div>
        </div>
      </div>` : ''}

      <div class="mv-eng-sec" data-sec="log">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">گزارش زنده</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack"><pre class="fr-log" id="${f.id}-log" dir="ltr"></pre></div>
            </div>
            <div class="mv-form-footer">خط‌به‌خط، از خودِ موتور — همان چیزی که هسته می‌گوید، بدون تفسیر.</div>
            ${f.id === 'psiphon' ? `<div class="mv-form-footer" id="psiphon-serverlist-note"></div>
            <div class="mv-form-footer">اتصال، خطاها، قطع و وصل و نرخ انتقال هر ۱۰ ثانیه در فایل گزارش نگه داشته می‌شوند؛ با بستن برنامه پاک نمی‌شوند.</div>
            <a class="mv-btn" href="/api/psiphon/diagnostics" download="mlmvpn-psiphon-diagnostics.json">دریافت گزارش عیب‌یابی سایفون و تونل</a>` : ''}
          </div>
        </div>
      </div>

    </div>

    <div class="mv-eng-foot" id="${f.id}-foot"></div>
  </section>
</div>`;
    }

    /**
     * «بررسی بروزرسانی» — this engine's core, on its own page in «ام‌ال‌ام استور».
     *
     * The check does not belong in this window. The store is what knows the signed channel, which
     * version is installed, which one has been tested, and what happens if it is rolled back; doing
     * a second, thinner version of that here would be a second answer to the same question.
     */
    function openInStore(id) {
        if (typeof window.storeOpenItem === 'function') { window.storeOpenItem('core|' + id); return; }
        if (window.MV && MV.wm) MV.wm.open('store');
    }

    /** Show one section, remember it, and keep the sidebar, the title and the buttons in step. */
    function goSec(id, sec) {
        const s = st[id], wrap = $(`${id}-wrap`);
        if (!wrap) return;
        const known = sections(FRONTS[id]).some(x => x.id === sec);
        s.sec = known ? sec : 'connect';
        s.logOpen = s.sec === 'log';
        wrap.querySelectorAll('.mv-eng-sec').forEach(n => n.classList.toggle('is-on', n.getAttribute('data-sec') === s.sec));
        wrap.querySelectorAll('.mv-side-item[data-sec]').forEach(b => b.classList.toggle('active', b.getAttribute('data-sec') === s.sec));
        // On the home section the bar carries nothing: a «برگشت» that goes where you already are,
        // over a title naming the page you are looking at. The 52px band itself stays — the
        // window's own drag bar lies over it, and without the band the stage would start under it.
        const pane = wrap.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', s.sec === 'connect');
        const title = el(id, 'title');
        if (title) title.textContent = s.sec === 'methods' ? FRONTS[id].methodsHeader : (SEC_TITLE[s.sec] || '');
        const back = el(id, 'back');
        if (back) back.disabled = s.sec === 'connect';
        const scroll = wrap.querySelector('.mv-pane-scroll');
        if (scroll) scroll.scrollTop = 0;
        paint(id);
    }

    // ── The hero: what is happening, and the one button ────────────────────
    //
    // One place decides the whole page's tone — the hero's words and colour, the sidebar's dot, and
    // which stat cells mean anything. Written once here rather than three times, because three
    // copies is how a panel ends up saying «وصل است» in one corner and «خاموش» in another.
    function state(id) {
        const f = FRONTS[id], s = st[id];
        const p = s.payload || {}, status = p.status || {};
        const out = { tile: f.tint, glyph: f.icon, head: f.title, line: f.blurb, spin: false, tone: 'off' };

        if (!p.installed) {
            out.tone = 'bad'; out.tile = 'var(--mv-red)'; out.glyph = 'ph-fill ph-warning';
            out.head = 'فایل موتور نیست';
            out.line = id === 'tor'
                ? 'فایل‌های تور در <code>core/tor</code> پیدا نشد. نسخه را دوباره نصب کنید.'
                : id === 'geph'
                    ? 'فایل <code>core/geph/geph5-client.exe</code> پیدا نشد. نسخه را دوباره نصب کنید.'
                    : `فایل <code>core/${id}.exe</code> پیدا نشد. نسخه را دوباره نصب کنید.`;
        } else if (s.stopping || s.tunStopping) {
            out.tone = 'busy'; out.tile = 'var(--mv-orange)'; out.glyph = 'ph-bold ph-circle-notch'; out.spin = true;
            out.head = s.stopping ? 'در حال قطع اتصال…' : 'در حال خاموش کردن تونل…';
            out.line = 'مسیرهای شبکه و تنظیمات DNS در حال بازگردانی هستند؛ چند لحظه صبر کنید.';
        } else if (status.connected && s.tunError) {
            // Connected AND broken: the engine carries traffic, but the coverage the user asked for
            // is not in place, so nothing on the machine is actually using it.
            out.tone = 'busy'; out.tile = 'var(--mv-orange)'; out.glyph = 'ph-fill ph-warning';
            out.head = 'وصل است، ولی تونل روشن نشد';
            out.line = esc(s.tunError) + ' — تا وقتی تونل روشن نشود هیچ برنامه‌ای خودبه‌خود از این موتور رد نمی‌شود.';
        } else if (status.connected && s.tunPending) {
            // THE ENGINE IS UP AND THE MACHINE IS NOT ROUTED YET.
            //
            // Building the adapter takes five to twenty seconds after the engine answers, and in
            // that window the old page already said «وصل است» — so the user believed everything was
            // going through the tunnel while their traffic was still leaving the ordinary way. It is
            // the one moment on this page where a wrong word has a real cost.
            out.tone = 'busy'; out.tile = 'var(--mv-orange)'; out.glyph = 'ph-bold ph-circle-notch'; out.spin = true;
            out.head = 'موتور وصل شد — تونل در حال روشن شدن';
            out.line = 'آداپتور تونل دارد ساخته می‌شود؛ چند ثانیه طول می‌کشد. <b>تا وقتی تمام نشده، ترافیک سیستم هنوز از این موتور رد نمی‌شود.</b>';
        } else if (status.connected) {
            out.tone = 'on'; out.tile = 'var(--mv-green)'; out.glyph = 'ph-fill ph-check-circle';
            out.head = 'وصل است';
            out.line = p.tun
                ? 'همهٔ برنامه‌های ویندوز از این موتور رد می‌شوند.'
                : `پروکسی محلی روشن است — تا برنامه‌ای را رویش تنظیم نکنید، ترافیکی از آن رد نمی‌شود. <code>127.0.0.1:${esc(status.socksPort || '')}</code>`;
        } else if (status.blocked) {
            // A DIFFERENT HEADLINE, because it is a different situation and needs a different action.
            // «در حال اتصال» invites waiting; this one cannot be waited out — the engine is up and the
            // network is dropping packets to the addresses it was given.
            out.tone = 'bad'; out.tile = 'var(--mv-red)'; out.glyph = 'ph-fill ph-prohibit';
            out.head = 'سرورهایش از این خط بسته‌اند';
            out.line = 'هستهٔ لنترن بالا است ولی هیچ‌کدام از سرورهایی که گرفت جواب نمی‌دهند — بسته‌ها اصلاً نمی‌رسند.'
                + ((status.proxies || []).length
                    ? ` سرورهایی که امتحان شد: <code dir="ltr">${(status.proxies || []).map(esc).join('</code> · <code dir="ltr">')}</code>.`
                    : '')
                + ' سرورها برای هر شناسه فرق می‌کنند، پس «یک دستهٔ دیگر» ارزش امتحان دارد — و اگر آن هم بسته بود،'
                + ' مسدودسازی از یک دسته بزرگ‌تر است و باید موتور دیگری را روشن کنید.';
        } else if (status.running) {
            out.tone = 'busy'; out.tile = 'var(--mv-orange)'; out.glyph = 'ph-bold ph-circle-notch'; out.spin = true;
            out.head = 'در حال اتصال';
            out.line = id === 'tor'
                ? `${esc(status.detail || '')}${status.percent ? ` — ${fa(status.percent)}٪` : ''}`
                : id === 'lantern'
                    ? esc(status.detail || 'راه‌اندازی هسته')
                    : `${esc(status.detail || '')}${status.rungCount ? ` — ${fa(status.rungIndex)} از ${fa(status.rungCount)}` : ''}`;
        } else if (status.error) {
            out.tone = 'bad'; out.tile = 'var(--mv-orange)'; out.glyph = 'ph-fill ph-warning';
            out.head = 'وصل نشد';
            out.line = esc(status.error);
        }
        return out;
    }

    /** The connect/disconnect button — the same one whether it sits in the hero or the title band. */
    function actionButtons(id, big) {
        const s = st[id];
        const p = s.payload || {}, status = p.status || {};
        const size = big ? ' mv-btn--lg' : '';
        const label = s.stopping || s.tunStopping ? 'در حال قطع…' : status.connected ? 'قطع' : status.running ? 'لغو' : 'اتصال';
        // The one extra action, offered ONLY where it can do something: لنترن, blocked. Servers are
        // assigned per device identity, so a fresh one is a fresh draw — measured, not assumed.
        const rotate = (id === 'lantern' && status.blocked)
            ? `<button type="button" class="mv-btn${size}" data-act="rotate"${s.busy ? ' disabled' : ''}>یک دستهٔ سرور دیگر</button>`
            : '';
        const off = !p.installed || s.stopping || s.tunStopping || (s.busy && !s.attempting && !status.running && !status.connected);
        return rotate + `<button type="button" class="mv-btn${size}${status.connected ? '' : ' mv-btn--primary'}"
            data-act="toggle"${off ? ' disabled' : ''}>${label}</button>`;
    }

    function wireActions(id, host) {
        if (!host) return;
        host.querySelectorAll('[data-act]').forEach(b => {
            const act = b.getAttribute('data-act');
            b.onclick = () => (act === 'rotate' ? rotateLantern(id)
                : act === 'newnym' ? torNewnym(id)
                    : toggle(id));
        });
    }

    /**
     * The stage: the headline, the one button, and the sentence under it.
     *
     * The button IS the page. Everything the old layout said in a bottom bar — what pressing it
     * will do, how long it may take, why it is disabled — is said here, next to the thing being
     * pressed, because that is where it is read.
     */
    function renderStage(id) {
        const f = FRONTS[id], s = st[id], host = el(id, 'stage');
        if (!host) return;
        const v = state(id);
        const p = s.payload || {}, status = p.status || {};
        const stopping = !!s.stopping || !!s.tunStopping;
        const busy = !!status.running || s.busy || !!s.attempting || !!s.tunPending || stopping;

        const glyph = stopping ? 'ph-bold ph-circle-notch' : status.connected ? 'ph-fill ph-power' : busy ? 'ph-bold ph-circle-notch' : 'ph-bold ph-power';
        const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : '';

        // NOTHING IS WRITTEN UNDER THE BUTTON.
        //
        // The state word and the sentence that used to sit there said again what the headline two
        // hand-spans away already said («وصل است» over «همهٔ برنامه‌های ویندوز از این موتور رد
        // می‌شوند»), and the words cost the card forty pixels of height — enough that the button
        // and the live chart beside it no longer lined up. The state is still in WORDS and not
        // only in the ring's colour, which is the rule that matters: it is the headline.
        //
        // What is NOT in the headline is that a second press cancels, so that goes on the line
        // under it while an attempt is running.
        const cancelHint = busy && !stopping && !status.connected && !s.tunPending
            ? (id === 'psiphon' && p.ladderSeconds
                ? ` <b>تا ${fa(p.ladderSeconds)} ثانیه — برای لغو دوباره همین دکمه را بزنید.</b>`
                : ' <b>برای لغو دوباره همین دکمه را بزنید.</b>')
            : '';

        // THE BUTTON IS BUILT ONCE AND THEN UPDATED.
        //
        // Re-writing the stage's HTML on every repaint re-created the button, and a CSS animation
        // restarts from zero every time its element is replaced — which is exactly the stutter the
        // ring had while connecting: the status poll repainted it, the sweep jumped back to the top,
        // four times a second. Nothing here replaces a node that is animating.
        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-act="toggle" data-part="power">
          <i data-part="glyph"></i>
        </button>
      </div>
      <div class="mv-eng-stage-side">
        <div data-part="extra"></div>
        <div class="mv-eng-live" data-part="live"></div>
      </div>`;
            host.dataset.built = '1';
            wireActions(id, host);
        }

        const part = (n) => host.querySelector(`[data-part="${n}"]`);
        part('head').innerHTML = v.head === f.title ? (f.headline || v.head) : v.head;
        part('line').innerHTML = v.line + cancelHint;

        const btn = part('power');
        const want = 'mv-eng-power' + ring;
        if (btn.className !== want) btn.className = want;
        // ENABLED WHILE IT IS TRYING — that press is «cancel», and it is the one press a user
        // reaches for most. Only a request already in flight with nothing running behind it
        // (the first moment of a connect, or a stop) disables it.
        btn.disabled = !p.installed || stopping || (s.busy && !s.attempting && !status.running && !status.connected);
        btn.setAttribute('aria-busy', stopping || !!s.tunPending);
        btn.setAttribute('aria-label', stopping ? 'در حال قطع…' : status.connected ? 'قطع' : busy ? 'لغو' : 'اتصال');
        btn.title = btn.getAttribute('aria-label');
        const wantGlyph = glyph + (stopping || (busy && !status.connected) ? ' fr-spin' : '');
        const gl = part('glyph');
        if (gl.className !== wantGlyph) gl.className = wantGlyph;

        // The extra action (لنترن, blocked) comes and goes; it is not animated, so replacing it is free.
        const extra = part('extra');
        const rotate = (id === 'lantern' && status.blocked)
            ? `<button type="button" class="mv-btn mv-btn--lg" data-act="rotate"${s.busy ? ' disabled' : ''}>یک دستهٔ سرور دیگر</button>`
            : '';
        if (extra.innerHTML !== rotate) { extra.innerHTML = rotate; wireActions(id, extra); }

        renderLive(id);
    }

    /**
     * The live traffic card beside the button.
     *
     * One implementation for every engine page, in components/engine-live.js — it listens for
     * `mv-traffic` itself and keeps every mounted card drawn, so there is nothing to poll here.
     */
    function renderLive(id) {
        const stage = el(id, 'stage');
        const host = stage && stage.querySelector('[data-part="live"]');
        if (host && window.MVEngineLive) MVEngineLive.mount(host);
    }

    /**
     * The cards: every choice this engine really has, each with its current answer visible.
     *
     * The rows are the real controls — picking here picks for the next connect — and the card's
     * header opens the section that explains the choice in full. Nothing is duplicated: the section
     * holds the paragraphs, the card holds the decision.
     */
    function renderCards(id) {
        const f = FRONTS[id], s = st[id], host = el(id, 'cards');
        if (!host) return;
        const p = s.payload || {}, status = p.status || {};
        const locked = s.busy || status.running;
        const cards = [];

        const pick = (attr, value, on, live, title, hint, disabled) => `
        <button type="button" class="mv-eng-pick${on ? ' is-on' : ''}${live ? ' is-live' : ''}"
                data-${attr}="${esc(value)}" role="radio" aria-checked="${on}"${disabled ? ' disabled' : ''}>
          <i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i>
          <span class="mv-eng-pick-text"><b>${esc(title)}</b><small>${esc(hint)}</small></span>
        </button>`;

        // ── the country ──
        if (f.regions !== false) {
            // Only a live session has an exit; a leftover `egressRegion` from the last one would
            // otherwise sit in the header of a disconnected engine as if it meant something.
            const now = (status.connected && status.egressRegion) || (s.region !== 'auto' ? s.region : '');
            cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-pink, #FF2D55)">
        <button type="button" class="mv-eng-card2-head" data-go="region">
          <span class="mv-eng-glyph"><i class="ph-fill ph-flag-banner"></i></span>
          <h3>کشور خروج</h3>
          <span class="mv-eng-card2-end">${now ? flag(now, 16) : ''}${esc(now ? countryName(now) : 'خودکار')}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body" id="${id}-cc"></div>
        <div class="mv-eng-card2-foot">${status.connected
                // تور IS THE EXCEPTION, and it earned it: its GeoIP database is now loaded on every
                // connect whether or not a country was chosen, so the country can be changed on a
                // running engine instead of costing a disconnect and a whole new bootstrap.
                ? (id === 'tor'
                    ? 'روی اتصال باز هم عوض می‌شود — چند ثانیه بعد، مدار بعدی از همان کشور بیرون می‌رود.'
                    : s.region !== 'auto' && status.egressRegion && s.region !== status.egressRegion
                        ? 'انتخاب تازه از اتصال بعدی اعمال می‌شود — یک بار قطع و دوباره وصل کنید.'
                        : 'کشوری که هم‌اکنون از آن خارج می‌شوید.')
                : 'یک ترجیح است، نه تضمین — اگر سروری در آن کشور نباشد، جای دیگری خارج می‌شوید.'}</div>
      </div>`);
        }

        // ── تور's live circuit, when it is up ──
        //
        // The three relays the connection is actually going through, with their countries. It is
        // the one thing every Tor client shows and this one never did — and it is not decoration:
        // a user who can see «آلمان ← هلند ← سوئد» can see that the tunnel is real, and a user
        // whose path is missing entirely is looking at the reason nothing loads.
        if (id === 'tor' && status.connected) {
            const live = s.tLive;
            const hops = (live && live.path) || [];
            cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-green, #34C759)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-path"></i></span>
          <h3>مسیر فعلی</h3>
          <span class="mv-eng-card2-end">${live ? (live.established ? `${fa(live.built)} مدار` : 'بدون مدار') : '…'}</span>
        </div>
        <div class="mv-eng-card2-body">
          ${hops.length ? `<div class="fr-circuit">
            ${hops.map((h, i) => `
            <div class="fr-hop" title="${esc((h.nick || '') + (h.ip ? ' · ' + h.ip : ''))}">
              ${h.country ? flag(h.country, 17) : '<span class="mv-flag is-none" style="width:19px;height:14px"></span>'}
              <b>${esc(h.country ? countryName(h.country) : '—')}</b>
              <small>${esc(i === 0 ? 'ورودی' : i === hops.length - 1 ? 'خروج' : 'میانی')}</small>
              <!-- A relay nickname is Latin text inside a Persian line, and left to itself the
                   bidi algorithm reorders it and puts the ellipsis on the wrong end: NTH61R6
                   rendered as «…HP1R6». <bdi> isolates it so it truncates like what it is. -->
              <bdi class="fr-hop-nick">${esc(h.nick || '')}</bdi>
            </div>`).join('<i class="ph-bold ph-caret-left fr-hop-arrow"></i>')}
          </div>` : `<div class="mv-eng-cc-empty">${live && !live.established
                ? 'تور هنوز مداری ندارد — خودش دوباره تلاش می‌کند.' : 'در حال خواندن مسیر…'}</div>`}
          <button type="button" class="mv-btn mv-btn--lg is-wide" data-act="newnym"${s.busy ? ' disabled' : ''}>
            <i class="ph-bold ph-arrows-clockwise"></i> مسیر تازه
          </button>
        </div>
        <div class="mv-eng-card2-foot">سرعت تور را قرعهٔ همین سه رله تعیین می‌کند. «مسیر تازه» قرعه را دوباره می‌اندازد.</div>
      </div>`);
        }

        // ── گف's own numbers, when it is the engine and it is up ──
        if (id === 'geph' && status.connected) {
            cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-green, #34C759)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-activity"></i></span>
          <h3>وضعیت زنده</h3>
          <span class="mv-eng-card2-end">${esc(status.protocol || '')}</span>
        </div>
        <div class="mv-eng-card2-body" id="${id}-gstats"></div>
        <div class="mv-eng-card2-foot">اعداد از خود موتور گرفته می‌شوند، نه از اندازه‌گیری ما.</div>
      </div>`);
        }

        // ── coverage ──
        cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-orange)">
        <button type="button" class="mv-eng-card2-head" data-go="coverage">
          <span class="mv-eng-glyph"><i class="ph-fill ph-globe-hemisphere-east"></i></span>
          <h3>حالت اتصال</h3>
          <span class="mv-eng-card2-end"><i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body" role="radiogroup">
          ${COVERAGE.map(c => pick('coverage', c.id, s.coverage === c.id, false, c.title, c.short, s.busy)).join('')}
        </div>
      </div>`);

        // ── the ladder / transports ──
        if (f.methods !== false) {
            const items = id === 'tor'
                ? (p.modes || []).map(m => ({ value: m.key, title: m.label, hint: m.hint }))
                : id === 'lantern'
                    ? LANTERN_MODES.slice()
                    : [{ value: '', title: 'خودکار', hint: 'هر سه رتبه به‌ترتیب، تا یکی جواب دهد' }].concat(
                        (p.ladder || []).map(r => ({ value: r.name, title: r.label, hint: `فقط همین رتبه — ${fa(r.seconds)} ثانیه` })));
            const shown = items.slice(0, 4);
            cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <button type="button" class="mv-eng-card2-head" data-go="methods">
          <span class="mv-eng-glyph"><i class="ph-fill ph-list-checks"></i></span>
          <h3>${esc(f.methodsHeader)}</h3>
          <span class="mv-eng-card2-end">${esc(methodLabel(id))}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body" role="radiogroup">
          ${shown.map(it => {
                const live = status.running && (id === 'tor' ? status.mode === it.value
                    : id === 'lantern' ? false : status.rung === it.value);
                const carrying = status.connected && (id === 'tor' ? status.mode === it.value
                    : id === 'lantern' ? false : status.rung === it.value);
                const hint = carrying ? 'همین روش دارد ترافیک را حمل می‌کند'
                    : live ? 'همین حالا در حال امتحان' : it.hint;
                return pick('method', it.value, s.method === it.value, live || carrying, it.title, hint, locked);
            }).join('')}
        </div>
        ${items.length > shown.length ? `<div class="mv-eng-card2-foot">${fa(items.length - shown.length)} مورد دیگر در بخش «${esc(f.methodsHeader)}».</div>` : ''}
      </div>`);
        }

        // ── the account (گف) ──
        if (f.account) {
            const has = !!status.hasAccount;
            cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <button type="button" class="mv-eng-card2-head" data-go="account">
          <span class="mv-eng-glyph"><i class="ph-fill ph-user-circle"></i></span>
          <h3>حساب</h3>
          <span class="mv-eng-card2-end">${has ? 'ساخته شده' : 'لازم است'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-foot">${has
                ? 'کد حساب ساخته و ذخیره شده است.'
                : 'گف بدون حساب وصل نمی‌شود — رایگان است و هیچ اطلاعاتی نمی‌خواهد.'}</div>
      </div>`);
        }

        host.innerHTML = cards.join('');
        // تور's «مسیر تازه» lives inside a card, so the cards host needs the action wiring too.
        wireActions(id, host);
        host.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => goSec(id, b.getAttribute('data-go')); });
        host.querySelectorAll('[data-coverage]').forEach(b => { b.onclick = () => setCoverage(id, b.getAttribute('data-coverage')); });
        host.querySelectorAll('[data-method]').forEach(b => { b.onclick = () => { s.method = b.getAttribute('data-method'); paint(id); }; });
        renderCountry(id, el(id, 'cc'), false);
    }

    /** Every country this engine offers, with what the engine itself says about each. */
    function regionList(id) {
        const s = st[id], p = s.payload || {}, status = p.status || {};
        if (id === 'tor') {
            return (p.regions || []).map(r => ({ code: r.code, note: `${fa(r.exits)} رله` }));
        }
        // ANY engine that publishes a country list gets to use it, and گف was the one that did
        // not: it answers `regions` exactly as تور does, but only تور was read here — so گف's
        // country picker had nothing in it but «خودکار», for every build it has shipped in.
        //
        // The note is not a count of servers, it is a count of servers THIS ACCOUNT MAY USE.
        // Measured on a Free account: 30 exits across 12 countries, and six of them, in four
        // countries, open. Choosing one of the other eight is a connect that runs its whole
        // budget and fails, so a picker that shows them as ordinary choices is the bug.
        if (Array.isArray(p.regions) && p.regions.length) {
            return p.regions.map(r => ({
                code: r.code,
                // What this account can reach, said as availability and nothing else. The
                // network sorts its servers into tiers; that is its business and not a thing
                // this app puts in front of anybody.
                note: r.free === undefined
                    ? `${fa(r.exits)} سرور`
                    : r.free > 0
                        ? `${fa(r.free)} سرور`
                        : 'در دسترس نیست',
                locked: r.free !== undefined && r.free === 0,
            }));
        }
        const codes = (status.available && status.available.length) ? status.available : (p.frontedRegions || []);
        return codes.map(c => ({ code: c, note: '' }));
    }

    /**
     * The country picker, drawn as this page's own control rather than as a browser menu.
     *
     * A native <select> cannot carry a flag — options take text and nothing else — and it brings the
     * operating system's own menu, which on this page looks like a piece of another program. So it
     * is a row that opens a searchable list, in the same shape as every other row here.
     */
    function renderCountry(id, host, expanded) {
        if (!host) return;
        const s = st[id];
        const p = s.payload || {}, status = p.status || {};
        // Locked only while one of our own requests is in flight. Being connected does not lock it:
        // the list is worth reading, and a new pick is a preference for the next connect — which the
        // footer says out loud rather than leaving the control dead with no reason given.
        const locked = !!s.busy;
        const list = regionList(id);
        const open = expanded || !!s.ccOpen;
        const q = (s.ccQuery || '').trim().toLowerCase();

        const rowFor = (code, note, unavailable) => {
            const on = (code || 'auto') === (s.region || 'auto');
            const name = code ? countryName(code) : 'خودکار';
            const sub = code ? (note ? note + ' · ' + String(code).toUpperCase() : String(code).toUpperCase())
                : 'سریع‌ترین چیزی که جواب دهد';
            // A country this account cannot reach is shown, and shown as unreachable. Hiding it
            // would leave the user wondering where سوئیس went; offering it as an ordinary choice
            // costs them ninety seconds and tells them nothing.
            const dead = !!unavailable;
            return `
        <button type="button" class="mv-eng-cc-row${on ? ' is-on' : ''}${dead ? ' is-locked' : ''}" data-cc="${esc(code || 'auto')}"${locked || dead ? ' disabled' : ''}>
          ${code ? flag(code) : '<span class="mv-flag is-none" style="width:19px;height:14px"></span>'}
          <span class="mv-eng-cc-text"><b>${esc(name)}</b><small>${esc(sub)}</small></span>
          ${code ? sweepNote(id, code) : ''}
          ${on ? '<i class="ph-fill ph-check-circle"></i>' : dead ? '<i class="ph-bold ph-lock-simple"></i>' : ''}
        </button>`;
        };

        const matches = list.filter(r => !q
            || String(r.code).toLowerCase().includes(q)
            || countryName(r.code).toLowerCase().includes(q));

        const current = s.region && s.region !== 'auto' ? s.region : '';
        const liveExit = status.connected && status.egressRegion ? status.egressRegion : '';

        host.innerHTML = `
      ${expanded ? '' : `
      <button type="button" class="mv-eng-cc-cur" data-cc-toggle="1"${locked ? ' disabled' : ''}>
        ${current ? flag(current) : '<span class="mv-flag is-none" style="width:19px;height:14px"></span>'}
        <span class="mv-eng-cc-text"><b>${esc(current ? countryName(current) : 'خودکار — سریع‌ترین')}</b>
          <small>${esc(liveExit && liveExit !== current ? 'هم‌اکنون از ' + countryName(liveExit) : (current ? String(current).toUpperCase() : 'هر کجا که سریع‌تر جواب دهد'))}</small></span>
        <i class="ph-bold ${open ? 'ph-caret-up' : 'ph-caret-down'}"></i>
      </button>`}
      <div class="mv-eng-cc-list"${open ? '' : ' hidden'}>
        ${list.length > 7 ? `
        <label class="mv-eng-cc-search">
          <i class="ph ph-magnifying-glass"></i>
          <input type="search" placeholder="جست‌وجوی کشور…" spellcheck="false" value="${esc(s.ccQuery || '')}" data-cc-search>
        </label>` : ''}
        <div class="mv-eng-cc-rows">
          ${rowFor('', '')}
          ${matches.map(r => rowFor(r.code, r.note, r.locked)).join('')}
          ${!matches.length && q ? '<div class="mv-eng-cc-empty">کشوری با این نام در فهرست این موتور نیست.</div>' : ''}
        </div>
      </div>`;

        const toggle = host.querySelector('[data-cc-toggle]');
        if (toggle) toggle.onclick = () => { s.ccOpen = !s.ccOpen; paint(id); };
        host.querySelectorAll('[data-cc]').forEach(b => {
            b.onclick = () => {
                const v = b.getAttribute('data-cc');
                s.region = v === 'auto' ? 'auto' : v;
                // A city belongs to the country it was chosen in. Carrying «Warsaw» into a pick
                // of «کانادا» is a constraint the broker cannot match, which is a connect that
                // never completes.
                s.city = '';
                s.ccOpen = false;
                s.ccQuery = '';
                paint(id);
                // تور applies it NOW rather than storing it for the next connect. Everything else
                // reads its country at start-up and cannot be told a new one afterwards.
                if (id === 'tor' && ((s.payload || {}).status || {}).connected) applyTorCountry(id, s.region);
            };
        });
        const search = host.querySelector('[data-cc-search]');
        if (search) {
            search.oninput = () => {
                s.ccQuery = search.value;
                renderCountry(id, host, expanded);
                const again = host.querySelector('[data-cc-search]');
                if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
            };
        }
    }

    /** Advanced: the ports, and the places a user goes next. Facts, with a button to copy them. */
    function renderAdvanced(id) {
        const s = st[id], host = el(id, 'adv');
        if (!host) return;
        const p = s.payload || {}, status = p.status || {};
        const PORTS = { tor: 20820, psiphon: 20830, lantern: 20840, geph: 20850 };
        const HTTP = { tor: 20822, psiphon: 20831, lantern: 20841, geph: 20851 };
        const socks = status.socksPort || p.socksPort || PORTS[id];
        const http = status.httpPort || p.httpPort || HTTP[id];

        const kv = (label, hint, value) => `
        <div class="mv-form-row">
          <span class="mv-form-label">${esc(label)}<small>${hint}</small></span>
          <span class="mv-form-control"><span class="mv-eng-kv"><code dir="ltr">${esc(value)}</code>
            <button type="button" class="mv-eng-copy" data-copy="${esc(value)}" title="کپی"><i class="ph-bold ph-copy"></i></button></span></span>
        </div>`;

        const rows = [
            kv('پروکسی SOCKS5', 'برای برنامه‌هایی که SOCKS می‌فهمند — و «حل نام از طریق پروکسی» را روشن کنید', `127.0.0.1:${socks}`),
            kv('پروکسی HTTP', id === 'tor'
                ? 'هر جا فقط یک فیلد «پروکسی» هست. پورت HTTP تور فقط <code>https://</code> را می‌برد'
                : 'هر جا فقط یک فیلد «پروکسی» هست — و تنظیمات خود ویندوز', `127.0.0.1:${http}`),
        ];
        if (id === 'tor' && status.dnsPort) rows.push(kv('DNS داخل مدار', 'نام‌ها داخل خود مدار تور حل می‌شوند', `127.0.0.1:${status.dnsPort}`));
        rows.push(`
        <button type="button" class="mv-form-row is-link" data-go="log">
          <span class="mv-form-label">گزارش زنده<small>خط‌به‌خط، از خودِ موتور</small></span>
          <span class="mv-form-value">${s.log.length ? fa(s.log.length) + ' خط' : '—'}</span>
        </button>`);
        rows.push(`
        <button type="button" class="mv-form-row is-link" data-apps="1">
          <span class="mv-form-label">برنامه‌های عبوری از تونل<small>در تنظیمات › تنظیمات پیشرفته VPN انتخاب می‌شود</small></span>
        </button>`);
        host.innerHTML = rows.join('');

        host.querySelectorAll('[data-copy]').forEach(b => {
            b.onclick = () => {
                const v = b.getAttribute('data-copy');
                try { navigator.clipboard.writeText(v); } catch (e) { /* no clipboard in this context */ }
                const i = b.querySelector('i');
                if (i) { i.className = 'ph-bold ph-check'; setTimeout(() => { i.className = 'ph-bold ph-copy'; }, 1200); }
            };
        });
        host.querySelectorAll('[data-go]').forEach(b => { b.onclick = () => goSec(id, b.getAttribute('data-go')); });
        host.querySelectorAll('[data-apps]').forEach(b => {
            b.onclick = () => {
                if (window.MV && MV.wm) MV.wm.open('settings');
                if (typeof window.switchSettingsTab === 'function') setTimeout(() => switchSettingsTab('tunnel'), 60);
            };
        });
        const note = el(id, 'adv-note');
        if (note) {
            note.innerHTML = 'انتخاب اشتباه بین این دو پورت یعنی «هیچ دیتایی رد نمی‌شود»: پورت SOCKS به برنامه‌ای که HTTP حرف می‌زند جواب نمی‌دهد.';
        }
    }

    /**
     * گف's own numbers, from the engine rather than from us.
     *
     * `stat_num` answers `ping`, `total_rx_bytes` and `total_tx_bytes`, and `stat_history`
     * answers a speed series the daemon keeps itself — four facts that were being collected by
     * the engine and thrown away, because nothing ever asked. The ping is the one that matters:
     * it is the round trip to the exit, which is what makes a page feel quick or dead, and it is
     * the number that tells a slow exit from a slow line.
     */
    async function pollGephStats(id) {
        if (id !== 'geph') return;
        const s = st[id];
        const status = (s.payload || {}).status || {};
        if (!status.connected) { s.gStats = null; return; }
        try {
            const r = await fetch('/api/geph/stats');
            const j = await r.json().catch(() => ({}));
            s.gStats = j && j.stats ? j.stats : null;
        } catch (e) { /* the panel is worth drawing without it */ }
    }

    /**
     * تور's own account of itself, from its control port.
     *
     * Until that port was opened this panel knew one number about Tor — a bootstrap percentage —
     * and nothing at all once it reached 100. Which relays are carrying the connection, which
     * countries they are in, whether a circuit exists, how many bytes have crossed: every one of
     * those was being answered by the engine and thrown away because nothing asked.
     *
     * The exit country is written back into `status.egressRegion` so the bottom strip and the
     * country card show a flag for تور the same way they do for گف — they read one field, and تور
     * was the engine that never filled it.
     */
    async function pollTorLive(id) {
        if (id !== 'tor') return;
        const s = st[id];
        const status = (s.payload || {}).status || {};
        if (!status.connected) { s.tLive = null; return; }
        try {
            const r = await fetch('/api/tor/live');
            const j = await r.json().catch(() => ({}));
            s.tLive = j && j.live ? j.live : null;
        } catch (e) { /* the panel is worth drawing without it */ }
    }

    function renderGephStats(id) {
        if (id !== 'geph') return;
        const s = st[id], host = el(id, 'gstats');
        if (!host) return;
        const status = (s.payload || {}).status || {};
        const g = s.gStats;
        if (!status.connected || !g) { host.innerHTML = ''; return; }
        const mb = (n) => (typeof n === 'number' && n > 0 ? `${fa((n / 1048576).toFixed(1))} مگابایت` : '—');
        // The daemon's own speed series, newest last. Drawn as bars because the shape is the
        // point: a flat line and a sawtooth are different problems.
        const h = Array.isArray(g.history) ? g.history.slice(-28) : [];
        const top = Math.max(1, ...h);
        const kv = (label, value) => `
      <div class="fr-gstat"><small>${esc(label)}</small><b>${esc(value)}</b></div>`;
        host.innerHTML = `
      <div class="fr-gstats">
        ${kv('پینگ تا خروج', g.pingMs ? `${fa(g.pingMs)} ms` : '—')}
        ${kv('دریافت', mb(g.rxBytes))}
        ${kv('ارسال', mb(g.txBytes))}
      </div>
      ${h.length > 1 ? `<div class="fr-spark" title="سرعت لحظه‌ای، به گزارش خود موتور">
        ${h.map(v => `<i style="height:${Math.max(3, Math.round((v / top) * 100))}%"></i>`).join('')}
      </div>` : ''}`;
    }

    /** The strip along the bottom: what is true right now, in one line. */
    function renderFoot(id) {
        const s = st[id], host = el(id, 'foot');
        if (!host) return;
        const v = state(id);
        const p = s.payload || {}, status = p.status || {};
        const word = s.stopping || s.tunStopping ? 'در حال قطع…' : s.tunPending ? 'موتور وصل — تونل در حال بالا آمدن'
            : v.tone === 'on' ? (p.tun ? 'وصل — تونل کامل سیستم' : 'وصل — فقط پروکسی')
                : v.tone === 'busy' ? (status.running ? 'در حال اتصال' : 'نیمه‌کاره')
                    : v.tone === 'bad' ? 'مشکل دارد' : 'آمادهٔ اتصال';
        // The country, with its flag — and the CITY when the engine names one, because «کانادا»
        // and «کانادا · Montreal» are different amounts of truth. The transport name is a last
        // resort and used to be the FIRST thing shown for گف, which publishes its exit country
        // under a different key than the others: the strip read «sosistab3» where a flag belongs.
        const cc = status.egressRegion || '';
        const side = status.connected && cc
            ? `خروج از ${flag(cc, 17)} ${esc(countryName(cc))}${status.exitCity ? ` · ${esc(status.exitCity)}` : ''}`
            : status.connected && status.protocol ? `<code>${esc(status.protocol)}</code>`
                : '';
        host.innerHTML = `
      <i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : ''}"></i>
      <span>${esc(word)}</span>
      <span class="mv-eng-foot-end">${side}</span>`;
    }

    /** The sidebar's own card: which engine this window is, and what it is doing right now. */
    /**
     * The engine's own icon at the top of the sidebar: the SAME drawing the home screen and the
     * dock show, asked of the app registry rather than drawn again here. A second icon for one
     * program is a second answer to "which app am I in" — and a Phosphor glyph on a tinted tile
     * was not even close to the artwork beside it on the desk.
     *
     * The glyph tile stays as the fallback, for a panel mounted outside the registry.
     */
    function identIcon(id, f) {
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get(id);
        if (app && MV.apps.iconHTML) {
            try { return MV.apps.iconHTML(app, 54); } catch (e) { /* fall through to the glyph */ }
        }
        return `<span class="mv-side-tile" style="--tint:${f.tint}"><i class="${f.icon}"></i></span>`;
    }

    function renderCard(id) {
        const f = FRONTS[id], host = el(id, 'card');
        if (!host) return;
        const v = state(id);
        const word = v.tone === 'on' ? 'وصل است' : v.tone === 'busy' ? 'در حال کار' : v.tone === 'bad' ? 'مشکل دارد' : 'خاموش';
        host.innerHTML = `
      ${identIcon(id, f)}
      <b>${esc(f.title)}</b>
      <small><i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : ''}"></i>${esc(word)}</small>`;
    }

    /** The label of whatever is selected right now, for the summary rows and the stats strip. */
    function methodLabel(id) {
        const s = st[id], p = s.payload || {};
        if (id === 'tor') {
            const m = (p.modes || []).find(x => x.key === (s.method || 'auto'));
            return m ? m.label : 'خودکار';
        }
        if (id === 'lantern') {
            const m = LANTERN_MODES.find(x => x.value === s.method);
            return m ? m.title : 'همهٔ ترافیک';
        }
        if (!s.method) return 'خودکار';
        const r = (p.ladder || []).find(x => x.name === s.method);
        return r ? r.label : s.method;
    }

    /** The compact button in the title band — shown only where the hero's is not on screen. */
    function renderBarAction(id) {
        const host = el(id, 'bar-action');
        if (!host) return;
        if (st[id].sec === 'connect') { host.innerHTML = ''; return; }
        host.innerHTML = actionButtons(id, false);
        wireActions(id, host);
    }

    // ── The method rows ────────────────────────────────────────────────────
    function renderMethods(id) {
        const s = st[id], host = el(id, 'methods');
        // گف has no method section at all — see FRONTS.geph. `host` is simply absent then.
        if (!host) return;
        const p = s.payload || {}, status = p.status || {};
        const items = id === 'tor'
            ? (p.modes || []).map(m => ({ value: m.key, title: m.label, hint: m.hint }))
            : id === 'lantern'
                ? LANTERN_MODES.slice()
                : [{ value: '', title: 'خودکار', hint: 'هر سه رتبه به‌ترتیب، تا یکی جواب دهد' }].concat(
                    (p.ladder || []).map(r => ({ value: r.name, title: r.label, hint: `فقط همین رتبه — بودجهٔ ${fa(r.seconds)} ثانیه` })));

        const locked = s.busy || status.running;
        host.innerHTML = items.map(it => {
            const on = s.method === it.value;
            const live = status.running && (id === 'tor' ? status.mode === it.value
                : id === 'lantern' ? false      // the mode is a routing choice, not a rung being tried
                    : status.rung === it.value);
            // "Carrying" and "being tried" are different facts and the row must not blur them: one
            // says the choice worked, the other says it is still being decided.
            const liveWord = live ? (status.connected ? 'همین روش دارد ترافیک را حمل می‌کند — ' : 'همین حالا در حال امتحان — ') : '';
            return `
        <button type="button" class="mv-form-row is-action" data-method="${esc(it.value)}"
                role="radio" aria-checked="${on}"${locked ? ' disabled' : ''}>
          <span class="mv-row-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span>
          <span class="mv-form-label">${esc(it.title)}<small${live ? ' class="is-on"' : ''}>${liveWord}${esc(it.hint)}</small></span>
        </button>`;
        }).join('');
        host.querySelectorAll('[data-method]').forEach(b => {
            b.onclick = () => { s.method = b.getAttribute('data-method'); paint(id); };
        });

        if (id === 'tor') renderBridges(id, host);

        // A disabled row with no stated reason is the thing that made this window confusing in the
        // first place, so the reason goes under it rather than being left to be guessed.
        const note = el(id, 'methods-note');
        if (note) {
            note.innerHTML = FRONTS[id].methodsFooter + (locked
                ? (status.connected
                    ? ' <b>برای عوض کردن روش، اول قطع کنید.</b>'
                    : ' <b>تا پایان این تلاش قابل تغییر نیست.</b>')
                : '');
        }
    }

    /**
     * «پل دلخواه» — the user's own bridge lines.
     *
     * The one censorship problem this app could not solve from the inside. The bridges that ship
     * in the Tor bundle are the same handful every Tor client on earth carries, which makes them
     * the first addresses any serious censor burns — and when they are burned, obfs4 and WebTunnel
     * simply stop working with nothing the user can do but try another method. The Tor Project's
     * own answer is to hand out fresh ones per request, and until now there was nowhere to put
     * them.
     *
     * A pasted line REPLACES the built-in list for its transport rather than joining it: a bridge
     * given to one person is unburned precisely because nobody else has it, and putting it behind
     * five addresses the censor already knows would spend the whole rung on the dead ones first.
     */
    function renderBridges(id, methodsHost) {
        if (id !== 'tor' || !methodsHost) return;
        const s = st[id], p = s.payload || {}, status = p.status || {};
        const info = status.bridges || { custom: 0, groups: [] };
        const open = !!s.brOpen;

        const old = methodsHost.parentNode.querySelector('.fr-bridges');
        if (old) old.remove();

        const box = document.createElement('div');
        box.className = 'fr-bridges';
        box.innerHTML = `
      <button type="button" class="mv-form-row is-action" data-br-toggle="1">
        <span class="mv-row-mark${info.custom ? ' is-on' : ''}"><i class="${info.custom ? 'ph-fill ph-bridge' : 'ph ph-bridge'}"></i></span>
        <span class="mv-form-label">پل دلخواه<small>${info.custom
            ? `${fa(info.custom)} پل ذخیره شده — ${esc(info.groups.join('، '))}`
            : 'پل‌های همراه برنامه برای همه یکی است و زودتر بسته می‌شود؛ پل شخصی خودتان را اینجا بگذارید'}</small></span>
        <i class="ph-bold ${open ? 'ph-caret-up' : 'ph-caret-down'}"></i>
      </button>
      <div class="fr-bridges-body"${open ? '' : ' hidden'}>
        <textarea class="fr-bridges-in" rows="4" spellcheck="false" dir="ltr"
          placeholder="obfs4 1.2.3.4:443 FINGERPRINT cert=… iat-mode=0"
          data-br-text>${esc(s.brText || '')}</textarea>
        <p class="fr-bridges-note">هر پل در یک خط. از <code>bridges.torproject.org</code> یا ربات تلگرام
          <code>@GetBridgesBot</code> بگیرید — obfs4، WebTunnel و Snowflake هر سه قبول است.
          هر خط جای پل‌های پیش‌فرضِ همان روش را می‌گیرد.</p>
        <div class="fr-bridges-act">
          <button type="button" class="mv-btn" data-br-save>ذخیره</button>
          ${info.custom ? '<button type="button" class="mv-link" data-br-clear>پاک کردن و برگشت به پل‌های پیش‌فرض</button>' : ''}
        </div>
      </div>`;
        methodsHost.parentNode.insertBefore(box, methodsHost.nextSibling);

        box.querySelector('[data-br-toggle]').onclick = () => { s.brOpen = !s.brOpen; paint(id); };
        const ta = box.querySelector('[data-br-text]');
        if (ta) ta.oninput = () => { s.brText = ta.value; };
        const save = box.querySelector('[data-br-save]');
        if (save) save.onclick = () => sendBridges(id, ta ? ta.value : '');
        const clear = box.querySelector('[data-br-clear]');
        if (clear) clear.onclick = () => { s.brText = ''; sendBridges(id, ''); };
    }

    async function sendBridges(id, text) {
        try {
            const r = await fetch('/api/tor/bridges', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: String(text || '') }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || 'ذخیره نشد');
            log(id, j.count ? `— ${j.count} پل دلخواه ذخیره شد (${(j.groups || []).join('، ')})`
                : '— پل‌های دلخواه پاک شد؛ پل‌های پیش‌فرض دوباره استفاده می‌شوند');
            // A line that was pasted and then rejected as unreadable must not look accepted.
            if (String(text || '').trim() && !j.count) log(id, '✗ هیچ خطی شکل یک پل معتبر نداشت.');
        } catch (e) { log(id, `✗ ${e.message}`); }
        await refresh(id);
    }

    // ── The account (گف only) ──────────────────────────────────────────────
    //
    // Geph's free tier needs an account and the account is a `secret`: no e-mail, no username, no
    // password, nothing that names anybody. It is minted by solving a proof-of-work puzzle — twenty
    // seconds of CPU, measured on this machine — so the button does it here rather than sending the
    // user off to another program for it.
    function renderAccount(id) {
        const s = st[id], host = el(id, 'account');
        if (!host) return;
        const p = s.payload || {}, status = p.status || {};
        const has = !!status.hasAccount;
        const uid = s.acct && s.acct.info ? s.acct.info.user_id : null;

        const rows = [];
        if (s.regBusy) {
            rows.push(`
        <div class="mv-form-row is-stack">
          <span class="mv-form-label">در حال ساخت حساب<small>معمای اثبات‌کار در حال حل شدن است — چند ده ثانیه، فقط پردازنده</small></span>
          <div class="fr-bar"><i style="width:${Math.round((s.regPct || 0) * 100)}%"></i></div>
        </div>`);
        } else if (has) {
            rows.push(`
        <div class="mv-form-row">
          <span class="mv-form-label">حساب<small>${uid ? `شمارهٔ ${esc(fa(uid))}` : 'ساخته شده و ذخیره است'}</small></span>
          <span class="mv-form-value">آماده</span>
        </div>
        <button type="button" class="mv-form-row is-action" data-acct="info">
          <span class="mv-form-label">بررسی حساب<small>از خودِ شبکه می‌پرسد حساب سالم است یا نه</small></span>
          <i class="ph-bold ph-arrows-clockwise mv-row-end"></i>
        </button>
        <button type="button" class="mv-form-row is-action" data-acct="paste">
          <span class="mv-form-label">جای‌گذاری کد حساب دیگر<small>اگر کد حسابی دارید که جای دیگری ساخته شده</small></span>
          <i class="ph-bold ph-clipboard-text mv-row-end"></i>
        </button>
        <button type="button" class="mv-form-row is-action" data-acct="copy">
          <span class="mv-form-label">کپی کد حساب<small>برای نگه داشتن یا بردن جای دیگر — مثل رمز نگهش دارید</small></span>
          <i class="ph-bold ph-copy mv-row-end"></i>
        </button>
        <button type="button" class="mv-form-row is-action" data-acct="forget">
          <span class="mv-form-label">پاک کردن حساب<small>کد پاک می‌شود و برنمی‌گردد</small></span>
          <i class="ph-bold ph-trash mv-row-end"></i>
        </button>`);
        } else {
            rows.push(`
        <button type="button" class="mv-form-row is-action" data-acct="register">
          <span class="mv-form-label">ساخت حساب رایگان<small>بدون ایمیل، بدون نام، بدون رمز — یک کد ساخته می‌شود و همین‌جا می‌ماند</small></span>
          <i class="ph-bold ph-user-plus mv-row-end"></i>
        </button>
        <button type="button" class="mv-form-row is-action" data-acct="paste">
          <span class="mv-form-label">کد حساب دارم<small>کدی که قبلاً ساخته‌اید را بچسبانید</small></span>
          <i class="ph-bold ph-clipboard-text mv-row-end"></i>
        </button>`);
        }
        host.innerHTML = rows.join('');
        host.querySelectorAll('[data-acct]').forEach(b => {
            b.onclick = () => accountAction(id, b.getAttribute('data-acct'));
        });

        const note = el(id, 'account-note');
        if (note) {
            note.innerHTML = s.acctNote ? esc(s.acctNote) : (has
                ? 'کد حساب تنها چیزی است که شما را به این حساب وصل می‌کند — جایی یادداشتش کنید. گف اسمی از شما ندارد، پس کد گم‌شده قابل بازیابی نیست.'
                : 'گف بدون حساب وصل نمی‌شود، ولی حساب <b>رایگان</b> است و هیچ اطلاعاتی از شما نمی‌خواهد: سرور یک معما می‌دهد، دستگاه شما حلش می‌کند، و یک کد تحویل می‌گیرد. همین. <b>ثبت‌نام در سایت لازم نیست</b> — پایین، بخش راهنما.');
        }
    }

    async function accountAction(id, what) {
        const s = st[id];
        s.acctNote = '';
        if (what === 'register') {
            s.regBusy = true; s.regPct = 0; s.logOpen = true; paint(id);
            try {
                const r = await fetch('/api/geph/account', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'register' }),
                });
                const out = await r.json();
                if (!r.ok) { s.acctNote = out.error || 'حساب ساخته نشد'; log(id, `✗ ${s.acctNote}`); }
                else { s.acct = out.account || null; log(id, '✅ حساب رایگان ساخته شد'); }
            } catch (e) { s.acctNote = e.message; }
            s.regBusy = false; s.regPct = 0;
            await refresh(id);
            return;
        }
        if (what === 'paste') {
            // The app's own dialog, never the browser's. `prompt()` does not exist in Electron at
            // all — it threw «prompt() is not supported» and the click did nothing — and
            // `confirm()`, which does exist, draws the operating system's window: a grey box with
            // OK/Cancel in the middle of a Persian page. ui-modal has had both since it shipped.
            const v = await window.uiModal.prompt('کد حساب گف را اینجا بگذارید', '', {
                placeholder: 'کد را بچسبانید…', ok: 'ذخیره', cancel: 'انصراف',
            });
            if (!v) return;
            s.busy = true; paint(id);
            try {
                const r = await fetch('/api/geph/account', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'secret', secret: v }),
                });
                const out = await r.json();
                if (!r.ok) s.acctNote = out.error || 'کد ذخیره نشد';
                else {
                    s.acct = out.account || null;
                    // Stored either way — the network may simply be unreachable right now — but the
                    // difference is worth saying out loud rather than discovering at connect time.
                    s.acctNote = (out.account && out.account.ok)
                        ? 'کد ذخیره شد و شبکه آن را شناخت.'
                        : 'کد ذخیره شد، ولی شبکه الان آن را تأیید نکرد. اگر اینترنت وصل است، ممکن است کد درست نباشد.';
                }
            } catch (e) { s.acctNote = e.message; }
            s.busy = false;
            await refresh(id);
            return;
        }
        if (what === 'copy') {
            try {
                const r = await fetch('/api/geph/account', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'export' }),
                });
                const out = await r.json();
                if (out.secret) {
                    await navigator.clipboard.writeText(out.secret);
                    s.acctNote = 'کد حساب در کلیپ‌بورد است. مثل رمز با آن رفتار کنید.';
                } else s.acctNote = out.error || 'کدی برای کپی کردن نبود';
            } catch (e) { s.acctNote = e.message; }
            paint(id);
            return;
        }
        if (what === 'forget') {
            const sure = await window.uiModal.confirm({
                title: 'پاک کردن کد حساب؟',
                message: 'کد این حساب پاک می‌شود. اگر جایی یادداشتش نکرده‌اید، همین حساب برای همیشه از دست می‌رود.',
                confirmLabel: 'پاک کن', cancelLabel: 'انصراف', danger: true,
            });
            if (!sure) return;
            s.busy = true; paint(id);
            try {
                await fetch('/api/geph/account', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'forget' }),
                });
                s.acct = null;
            } catch (e) { s.acctNote = e.message; }
            s.busy = false;
            await refresh(id);
            return;
        }
        // info
        s.busy = true; paint(id);
        try {
            const r = await fetch('/api/geph/account', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'info' }),
            });
            const out = await r.json();
            s.acct = out;
            if (!out.ok) s.acctNote = out.error || 'شبکه جواب نداد';
        } catch (e) { s.acctNote = e.message; }
        s.busy = false;
        await refresh(id);
    }

    /**
     * The guide the user asked for: signing up, and reaching geph.io.
     *
     * Written from what was MEASURED on this line today, not from what the site says about itself —
     * including the part that matters most, which is that geph.io answered directly from here. A
     * guide that says «it is blocked, use a tunnel» when it is not blocked teaches the wrong thing.
     */
    function renderGuide(id) {
        const host = el(id, 'guide');
        if (!host) return;
        host.innerHTML = `
<h4>ثبت‌نام: در سایت لازم نیست</h4>
<p>گف حساب می‌خواهد ولی از شما هیچ اطلاعاتی نمی‌خواهد — نه ایمیل، نه نام، نه رمز. حساب یک <b>کد</b> است و این‌طور ساخته می‌شود:</p>
<ol>
  <li>بالا، «<b>ساخت حساب رایگان</b>» را بزنید.</li>
  <li>سرور یک معمای محاسباتی می‌دهد و پردازندهٔ کامپیوتر شما حلش می‌کند — معمولاً حدود <b>نیم دقیقه</b>، بسته به سرعت پردازنده. نواری که می‌بینید همان است.</li>
  <li>کد ساخته می‌شود و همین‌جا ذخیره می‌شود. تمام — دیگر کاری نمانده.</li>
</ol>
<p>این معما به‌جای ایمیل و رمز است: هزینه‌ای می‌گذارد که ساختن هزارها حساب را گران کند، بدون اینکه چیزی از شما بداند. <b>پس این کد را جایی یادداشت کنید</b> — گف اسمی از شما ندارد، بنابراین کد گم‌شده قابل بازیابی نیست. با همان کد هر جای دیگری هم می‌توانید وارد شوید.</p>

<h4>باز کردن سایت گف</h4>
<p>آدرس اصلی <code>https://geph.io</code> است و روی بیشتر خط‌ها <b>مستقیم باز می‌شود</b> — پس اول بدون هیچ ترفندی امتحان کنید.</p>
<p>اگر باز نشد، به‌ترتیب:</p>
<ol>
  <li>یکی از موتورهای همین برنامه را روشن کنید — <b>تور</b>، <b>لنترن</b> یا <b>سایفون</b> — و بعد سایت را باز کنید. برای همین کار هستند.</li>
  <li>یا از آدرس‌های دیگر خودشان: <code>getgeph.com</code> و <code>gephfree.com</code>.</li>
  <li>فایل نصبی ویندوزشان از <code>dl.geph.io</code> می‌آید.</li>
</ol>
<p><b>ولی برای استفاده از گف در همین برنامه به سایتشان کاری ندارید.</b> هستهٔ گف اینجا هست و حساب را همین پنجره می‌سازد.</p>

<h4>چرا گف روی خطی که همه‌چیز را بسته کار می‌کند</h4>
<p>هر موتور دیگری باید اول به یک سرور هماهنگی برسد و آدرس آن سرور چیزی است که می‌شود بلاکش کرد. سرور هماهنگی گف <b>پشت سایت‌های بزرگ پنهان است</b>: اتصال از نظر شبکه به <code>kubernetes.io</code> یا یک CDN معمولی است و مقصد واقعی داخل رمزنگاری. چهار مسیر هم‌زمان امتحان می‌شوند و اولی که جواب داد برنده است — پس آدرسی برای بستن وجود ندارد، مگر اینکه آن سایت‌های بزرگ را ببندند.</p>`;
    }

    // ── The coverage rows ──────────────────────────────────────────────────
    function renderCoverage(id) {
        const s = st[id], host = el(id, 'coverage');
        if (!host) return;
        const p = s.payload || {}, status = p.status || {};
        // What is TRUE right now outranks what was selected: a live session's coverage is a fact,
        // and showing an old selection against it is how a panel starts lying — but ONLY once the
        // attempt is over. While one is in flight the choice is a request that has not been carried
        // out yet, and overwriting it there is what silently turned «تونل کامل» into «پروکسی».
        if (status.connected && !s.attempting) s.coverage = p.tun ? 'tunnel' : 'proxy';
        if (p.tun) s.tunError = null;   // it is up now; the old failure is not news any more

        host.innerHTML = COVERAGE.map(c => {
            const on = s.coverage === c.id;
            return `
        <button type="button" class="mv-form-row is-action" data-coverage="${c.id}"
                role="radio" aria-checked="${on}"${s.busy ? ' disabled' : ''}>
          <span class="mv-row-mark${on ? ' is-on' : ''}"><i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i></span>
          <span class="mv-form-label">${esc(c.title)}<small>${esc(c.short)}</small></span>
          <i class="ph-bold ${c.icon} mv-row-end"></i>
        </button>`;
        }).join('');
        host.querySelectorAll('[data-coverage]').forEach(b => {
            b.onclick = () => setCoverage(id, b.getAttribute('data-coverage'));
        });

        const note = el(id, 'coverage-note');
        if (!note) return;
        // The fallback is per engine, and it matters: with no status yet (a panel painted
        // before its first /status answers) a shared default would print another engine's
        // port as the one to configure a browser with.
        const PORTS = { tor: 20820, psiphon: 20830, lantern: 20840 };
        const HTTP_PORTS = { tor: 20822, psiphon: 20831, lantern: 20841 };
        const port = status.socksPort || PORTS[id];
        // All three engines publish an HTTP proxy as well, and it is the one most programs can
        // actually use: a single «proxy» field means HTTP, and so does Windows' own setting. Naming
        // only the SOCKS port is why «پروکسی روشن است و دیتا رد نمی‌شود» is a report we get — the
        // port answers nothing that is not SOCKS5.
        const httpPort = status.httpPort || HTTP_PORTS[id];
        const base = s.coverage === 'tunnel'
            ? 'همهٔ برنامه‌های ویندوز از تونل رد می‌شوند و نیازی به تنظیم هیچ برنامه‌ای نیست. این موتور UDP حمل نمی‌کند، پس QUIC عمداً <b>رد</b> می‌شود تا مرورگر فوراً به TCP برگردد.'
                + (id === 'tor' ? ' و DNS داخل خودِ مدار تور حل می‌شود، نه از یک resolver عمومی — وگرنه اسم همان سایت‌هایی که پنهانشان می‌کنید بیرون مدار لو می‌رود.' : '')
            : `فقط برنامه‌هایی که خودتان تنظیم می‌کنید؛ مرورگر و ویندوز دست‌نخورده می‌مانند. `
            + `<b>دو پورت دارید و انتخاب اشتباه یعنی «هیچ دیتایی رد نمی‌شود»</b> — پورت SOCKS به برنامه‌ای که HTTP حرف می‌زند جواب نمی‌دهد: `
            + `<b>SOCKS5</b> روی <code>127.0.0.1:${esc(port)}</code>، <b>HTTP</b> روی <code>127.0.0.1:${esc(httpPort)}</code>. `
            + `هر جا فقط یک فیلد «پروکسی» هست (و تنظیمات خود ویندوز) همان HTTP است.`
            // Measured, not assumed: tor's HTTP port is CONNECT-only. https:// works — youtube,
            // x.com and check.torproject.org all answered 200 through it — and plain http:// is
            // refused outright. سایفون و لنترن take both shapes.
            + (id === 'tor' ? ` پورت HTTP تور فقط <code>https://</code> را می‌برد (سنجیده شد: یوتیوب و ایکس از همان پورت باز شدند)؛ برای <code>http://</code> ساده از SOCKS5 استفاده کنید.` : '')
            + ` در SOCKS5 اگر گزینهٔ «حل نام از طریق پروکسی» را روشن نکنید، اسم‌ها بیرون تونل جواب داده می‌شوند و سایت‌های فیلترشده باز نمی‌شوند.`;
        note.innerHTML = base + (status.connected ? ' <b>همین حالا هم می‌توانید عوضش کنید.</b>' : '');
    }

    // ── The ladder, while it walks ─────────────────────────────────────────
    function renderSteps(id) {
        const s = st[id], sec = el(id, 'steps-sec'), host = el(id, 'steps');
        if (!sec || !host) return;
        const p = s.payload || {}, status = p.status || {};
        // While it is TRYING. Once it is connected the answer is in the method card («همین روش دارد
        // ترافیک را حمل می‌کند»), and a finished ladder is just a block of ticks taking up the page.
        const show = !!(status.running && !status.connected) || !!st[id].attempting || !!st[id].tunPending;
        sec.style.display = show ? 'flex' : 'none';
        if (!show) return;

        let rows;
        if (id === 'lantern') {
            // Four plain stages, because that is genuinely all there is: the core does not report
            // progress, it reports arrival. The third one carries the explanation, since it is the
            // one that sits for up to a minute while the proxy list is fetched.
            const order = ['starting', 'listening', 'testing', 'up'];
            const at = order.indexOf(status.connected ? 'up' : (status.stage || 'starting'));
            const marks = [
                { key: 'starting', label: 'راه‌اندازی هسته' },
                { key: 'listening', label: 'باز کردن پورت محلی' },
                { key: 'testing', label: 'گرفتن فهرست سرورها', note: 'روی پروفایل نو تا یک دقیقه طول می‌کشد — در حال گرفتن فهرست است، گیر نکرده' },
                { key: 'up', label: 'آماده' },
            ];
            rows = marks.map((m, i) => {
                const done = at > i;
                const active = at === i && !status.connected;
                return step(done ? 'is-done' : active ? 'is-active' : '',
                    done ? 'ph-check' : active ? 'ph-circle-notch' : 'ph-circle',
                    m.label, active && m.note ? m.note : '', active);
            });
            // A stage that went back to `listening` after `testing` is the watcher still looking,
            // and saying nothing about that is how a panel looks stuck.
            if (!status.connected && status.stage === 'listening' && s.log.length > 2) {
                rows.push(step('is-active', 'ph-circle-notch', 'هنوز سروری پیدا نشده', status.detail || 'خودش ادامه می‌دهد', true));
            }
        } else if (id === 'tor') {
            // Tor's own bootstrap milestones. The 50% one carries the explanation, because that is
            // the step that sits for minutes on a slow line and looks broken while working.
            const pct = status.connected ? 100 : (status.percent || 0);
            // MEASURED, and the reason this step now carries a number. On a machine with nothing
            // cached, tor reports 50% for five straight minutes while twenty-two megabytes of
            // relay descriptors come down. The percentage is not lying, it simply has nothing to
            // say during that phase — so the megabytes say it instead, and a bar that used to look
            // frozen now visibly moves.
            const mb = status.bootBytes ? `${fa((status.bootBytes / 1048576).toFixed(1))} مگابایت گرفته شد` : '';
            const marks = [
                { at: 10, label: 'راه‌اندازی موتور' },
                { at: 45, label: 'گرفتن فهرست شبکه' },
                {
                    at: 50, label: 'دانلود فهرست رله‌ها',
                    note: (mb ? mb + ' — ' : '') + 'اولین اتصال روی هر دستگاه چند دقیقه است، بعدش چند ثانیه',
                },
                { at: 90, label: 'ساختن مدار' },
                { at: 100, label: 'آماده' },
            ];
            rows = marks.map(m => {
                const done = pct > m.at || (pct === 100 && m.at === 100);
                const active = !done && pct >= m.at;
                // tor's own name for the step it is on, when it has one and we are on that step.
                const note = active ? (m.note || status.phase || '') : '';
                return step(done ? 'is-done' : active ? 'is-active' : '',
                    done ? 'ph-check' : active ? 'ph-circle-notch' : 'ph-circle',
                    m.label, note, active);
            });
        } else {
            const idx = status.rungIndex || 0;
            rows = (p.ladder || []).map((r, i) => {
                const n = i + 1;
                const won = status.connected && status.rung === r.name;
                const failed = !status.connected && n < idx;
                const active = !status.connected && n === idx;
                return step(won ? 'is-done' : failed ? 'is-failed' : active ? 'is-active' : '',
                    won ? 'ph-check' : failed ? 'ph-x' : active ? 'ph-circle-notch' : 'ph-circle',
                    r.label, active ? `بودجهٔ ${fa(r.seconds)} ثانیه` : failed ? 'جواب نداد' : '', active);
            });
        }
        // The adapter is the last stage, and the only one the user can be hurt by not seeing: the
        // engine says «connected» while nothing on the machine is routed yet.
        if (st[id].tunPending) {
            rows = rows.map(r => r.replace('is-active', 'is-done').replace('ph-circle-notch fr-spin', 'ph-check'));
            rows.push(step('is-active', 'ph-circle-notch', 'روشن کردن تونل کامل سیستم',
                'آداپتور ساخته می‌شود — ۵ تا ۲۰ ثانیه', true));
        } else if (status.connected && s.coverage === 'tunnel' && p.tun) {
            rows.push(step('is-done', 'ph-check', 'تونل کامل سیستم روشن است', '', false));
        }
        host.innerHTML = rows.join('');
    }

    function step(cls, icon, label, note, spin) {
        return `
      <div class="mv-step ${cls}">
        <i class="ph-bold ${icon}${spin ? ' fr-spin' : ''}"></i>
        <span>${esc(label)}${note ? ` <small class="fr-note">— ${esc(note)}</small>` : ''}</span>
      </div>`;
    }

    // ── The country picker, in its own section ─────────────────────────────
    function renderRegion(id) {
        const host = el(id, 'region-sec');
        renderCountry(id, host, true);
        renderExitExtras(id, host);
        renderSweep(id, host);   // inserted FIRST in the host — see renderSweep
        renderTorPath(id, host); // the same place, for تور's own kind of measurement
    }

    /**
     * The two things a country alone cannot say: WHICH city, and which of them is fastest.
     *
     * Only گف publishes either. Its broker names every exit with a city and a load figure, and
     * `country_city` is a real constraint — «آمریکا» is seven exits on two coasts, and the one
     * the network picks is not the one that was measured. The sweep below is the other half:
     * `auto` is the network's choice, not a measurement of THIS line, and on this one it chose an
     * exit three and a half times slower than the best (LT 1.00 Mbit/s against PL 2.29).
     */
    function renderExitExtras(id, host) {
        if (id !== 'geph' || !host) return;
        const s = st[id], p = s.payload || {};
        const all = Array.isArray(p.exits) ? p.exits : [];
        const cc = (s.region || 'auto').toUpperCase();

        // GROUPED BY CITY, not one row per exit. Canada's three free exits are all in Montreal,
        // and three identical rows offer the user a choice that is not one. The count and the
        // lightest load are what distinguishes a city; the broker picks among its servers.
        const byCity = new Map();
        if (cc !== 'AUTO') {
            for (const e of all) {
                if (e.country !== cc || !e.free) continue;
                const k = e.city || '';
                const prev = byCity.get(k);
                if (!prev) byCity.set(k, { city: k, country: e.country, servers: 1, load: e.load, category: e.category });
                else {
                    prev.servers++;
                    if (typeof e.load === 'number' && (typeof prev.load !== 'number' || e.load < prev.load)) prev.load = e.load;
                    if (e.category === 'streaming') prev.category = 'streaming';
                }
            }
        }
        const cities = [...byCity.values()].sort((a, b) => (a.load ?? 1) - (b.load ?? 1));
        const pct = (l) => (typeof l === 'number' ? `${fa(Math.round(l * 100))}٪ بار` : '');

        const box = document.createElement('div');
        box.className = 'fr-exit-extras';
        box.innerHTML = cities.length > 1 ? `
      <div class="mv-form-header" style="margin-top:14px">شهر</div>
      <div class="mv-eng-cc-rows">
        <button type="button" class="mv-eng-cc-row${!s.city ? ' is-on' : ''}" data-city="">
          <span class="mv-flag is-none" style="width:19px;height:14px"></span>
          <span class="mv-eng-cc-text"><b>هر شهری</b><small>شبکه خودش انتخاب می‌کند</small></span>
          ${!s.city ? '<i class="ph-fill ph-check-circle"></i>' : ''}
        </button>
        ${cities.map(e => `
        <button type="button" class="mv-eng-cc-row${s.city === e.city ? ' is-on' : ''}" data-city="${esc(e.city)}">
          ${flag(e.country)}
          <span class="mv-eng-cc-text"><b>${esc(e.city)}</b><small>${esc([
            e.servers > 1 ? `${fa(e.servers)} سرور` : '', pct(e.load),
            e.category === 'streaming' ? 'مناسب استریم' : '',
        ].filter(Boolean).join(' · '))}</small></span>
          ${s.city === e.city ? '<i class="ph-fill ph-check-circle"></i>' : ''}
        </button>`).join('')}
      </div>` : '';

        const old = host.querySelector('.fr-exit-extras');
        if (old) old.remove();
        if (box.innerHTML.trim()) host.appendChild(box);

        box.querySelectorAll('[data-city]').forEach(b => {
            b.onclick = () => { s.city = b.getAttribute('data-city'); paint(id); };
        });
    }

    /**
     * The sweep, ABOVE the list it is about to rank.
     *
     * It was under twelve country rows, which is where a user finds it after they have already
     * given up and picked one. It belongs first: it is the answer to the question the list is
     * asking. Its results are written back INTO the rows as they arrive — see sweepNote — so the
     * ranking appears where the choice is made rather than as a separate verdict at the end.
     */
    function renderSweep(id, host) {
        if (id !== 'geph' || !host) return;
        const s = st[id], p = s.payload || {};
        const sweep = p.sweep || {};
        const live = s.sweepLive || {};
        const running = !!sweep.running || !!s.sweepRunning;
        const best = p.fastest && p.fastest.best;
        const seen = Object.keys(live).length;

        const box = document.createElement('div');
        box.className = 'fr-sweep-top';
        box.innerHTML = `
      <div class="fr-sweep">
        ${running
                ? `<div class="mv-step is-active"><i class="ph-bold ph-circle-notch fr-spin"></i><span>در حال سنجش${
                    s.sweepTotal ? ` — ${fa(seen)} از ${fa(s.sweepTotal)} کشور` : '…'}${
                    s.sweepStage === 'measuring' ? ' (اندازه‌گیری سرعت بهترین‌ها)' : ''}</span></div>`
                : `<button type="button" class="mv-btn is-wide" data-sweep="1"${s.busy ? ' disabled' : ''}>
             <i class="ph-bold ph-gauge"></i> سنجش کشورها و پیدا کردن سریع‌ترین</button>`}
        ${best && !running ? `<div class="fr-sweep-best">
          <i class="ph-fill ph-trophy"></i>
          <span>سریع‌ترین: <b>${esc(best.label)}</b>${best.mbit ? ` — ${esc(String(best.mbit))} مگابیت` : ''}${
                best.ttfbMs ? `، پاسخ ${fa(best.ttfbMs)}ms` : ''}</span>
          <button type="button" class="mv-link" data-use-best="1">انتخابش کن</button>
        </div>` : ''}
      </div>`;

        const old = host.querySelector('.fr-sweep-top');
        if (old) old.remove();
        host.insertBefore(box, host.firstChild);

        const btn = box.querySelector('[data-sweep]');
        if (btn) btn.onclick = async () => {
            btn.disabled = true;
            s.sweepLive = {}; s.sweepRunning = true; s.sweepStage = 'probing'; s.sweepTotal = 0;
            paint(id);
            try {
                const r = await fetch('/api/geph/fastest', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) { s.sweepRunning = false; log(id, `✗ ${j.error || 'سنجش شروع نشد'}`); paint(id); }
            } catch (e) { s.sweepRunning = false; log(id, `✗ ${e.message}`); paint(id); }
        };
        const use = box.querySelector('[data-use-best]');
        if (use && best) use.onclick = () => { s.region = best.country; s.city = best.city || ''; paint(id); };
    }

    /**
     * تور's «بهبود مسیر» — the panel above the country list, and NOT a race between countries.
     *
     * The obvious shape for it was گف's: measure every exit, pick the fastest, pin it. That was
     * built and then measured against itself, and pinning the three fastest exits made Tor two and
     * a half times SLOWER — tor already weights its own choice by relay bandwidth, so narrowing it
     * concentrates load instead of selecting quality. Worse, two draws through the same exit relay
     * measured 4.57 and 2.33 Mbit/s, so the exit is not even the variable.
     *
     * What the same measurements did show: settled paths on one line, minutes apart, ranged from
     * zero to 9.24 Mbit/s with nothing chosen differently between them. So this measures the path
     * the user is on and, when it is poor, asks tor for another — which is the only lever the
     * evidence supports. It changes nothing when the current path is already fine.
     */
    function renderTorPath(id, host) {
        if (id !== 'tor' || !host) return;
        const s = st[id], p = s.payload || {}, status = p.status || {};
        if (!status.connected) { const o = host.querySelector('.fr-sweep-top'); if (o) o.remove(); return; }

        const running = !!status.measuring || !!s.pathRunning;
        const draws = s.pathDraws || [];
        const done = s.pathDone || (status.path && status.path.current ? status.path : null);
        const cur = done && done.current;

        const box = document.createElement('div');
        box.className = 'fr-sweep-top';
        box.innerHTML = `
      <div class="fr-sweep">
        ${running
                ? `<div class="mv-step is-active"><i class="ph-bold ph-circle-notch fr-spin"></i><span>در حال سنجش مسیر${
                    draws.length ? ` — مسیر ${fa(draws.length)}` : '…'}</span></div>`
                : `<button type="button" class="mv-btn is-wide" data-improve="1"${s.busy ? ' disabled' : ''}>
             <i class="ph-bold ph-gauge"></i> سنجش سرعت مسیر و بهترش کن</button>`}
        ${draws.length ? `<div class="fr-draws">
          ${draws.map(d => `
          <div class="fr-draw${d.good ? ' is-good' : d.ok ? '' : ' is-bad'}">
            <span class="fr-draw-n">${fa(d.draw)}</span>
            ${d.exit && d.exit.country ? flag(d.exit.country, 15) : ''}
            <b>${esc(d.exit ? (d.exit.country ? countryName(d.exit.country) : d.exit.nick || '') : '—')}</b>
            <span class="fr-draw-v">${d.ok ? `${esc(String(d.mbit))} مگابیت` : 'داده رد نشد'}</span>
          </div>`).join('')}
        </div>` : ''}
        ${cur && !running ? `<div class="fr-sweep-best">
          <i class="ph-fill ${cur.good ? 'ph-check-circle' : 'ph-warning'}"></i>
          <span>${cur.good
                ? `مسیر خوب است — <b>${esc(String(cur.mbit))} مگابیت</b>${cur.exit && cur.exit.country ? ` از ${esc(countryName(cur.exit.country))}` : ''}`
                : `این خط الان بیشتر از <b>${esc(String((done.best || cur).mbit))} مگابیت</b> نداد — ${fa(done.draws.length)} مسیر امتحان شد`}</span>
        </div>` : ''}
      </div>`;

        const old = host.querySelector('.fr-sweep-top');
        if (old) old.remove();
        host.insertBefore(box, host.firstChild);

        const btn = box.querySelector('[data-improve]');
        if (btn) btn.onclick = async () => {
            btn.disabled = true;
            s.pathDraws = []; s.pathDone = null; s.pathRunning = true;
            paint(id);
            try {
                const r = await fetch('/api/tor/improve', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                });
                const j = await r.json().catch(() => ({}));
                if (!r.ok) { s.pathRunning = false; log(id, `✗ ${j.error || 'سنجش شروع نشد'}`); paint(id); }
            } catch (e) { s.pathRunning = false; log(id, `✗ ${e.message}`); paint(id); }
        };
    }

    /** A fresh draw, on request. */
    async function torNewnym(id) {
        const s = st[id];
        s.busy = true; paint(id);
        try {
            const r = await fetch('/api/tor/newnym', { method: 'POST' });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || 'مسیر تازه گرفته نشد');
            log(id, '— مسیر تازه');
        } catch (e) { log(id, `✗ ${e.message}`); }
        s.busy = false;
        await refresh(id);
    }

    /** The country, applied to a RUNNING tor. See renderCards for why only تور can do this. */
    async function applyTorCountry(id, region) {
        try {
            const r = await fetch('/api/tor/country', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ region: region || 'auto' }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || 'کشور عوض نشد');
            log(id, `— کشور خروج: ${region === 'auto' ? 'خودکار' : countryName(region)}`);
        } catch (e) { log(id, `✗ ${e.message}`); }
        await refresh(id);
    }

    /** What the sweep learned about one country, drawn next to its row while it is still running. */
    function sweepNote(id, code) {
        const s = st[id];
        const live = s.sweepLive || {};
        const row = live[String(code).toUpperCase()];
        if (!row) return '';
        if (!row.ok) return `<span class="fr-cc-res is-bad">${esc(row.error || 'جواب نداد')}</span>`;
        if (row.mbit) return `<span class="fr-cc-res is-good">${esc(String(row.mbit))} مگابیت</span>`;
        return `<span class="fr-cc-res">${fa(row.ttfbMs)}ms</span>`;
    }

    function renderLog(id) {
        const s = st[id];
        const note = el(id, 'serverlist-note');
        if (note) {
            const list = s.payload && s.payload.status && s.payload.status.serverList;
            note.textContent = 'دریافت خودکار سرورها فعال است. ' + (list && list.lastDownloadAt
                ? 'آخرین دریافت: ' + new Date(list.lastDownloadAt).toLocaleString('fa-IR')
                : 'هنوز دریافت تازه‌ای ثبت نشده؛ فهرست ذخیره‌شده برای اتصال در دسترس است.')
                + (list && list.lastError ? ' — آخرین دریافت با خطا همراه بوده؛ جزئیات در فایل گزارش.' : '');
        }
        const pre = el(id, 'log');
        if (!pre || !s.logOpen) return;
        pre.textContent = s.log.length ? s.log.join('\n') : 'هنوز چیزی ثبت نشده.';
        pre.scrollTop = pre.scrollHeight;
    }

    function paint(id) {
        renderCard(id); renderBarAction(id); renderFoot(id);
        if (st[id].sec === 'connect') { renderStage(id); renderCards(id); renderAdvanced(id); renderSteps(id); }
        renderMethods(id); renderCoverage(id); renderRegion(id); renderLog(id);
        // گف only: the account rows and the guide. Drawn here with everything else —
        // putting them in log() meant they only appeared once a log line arrived, so the
        // section sat empty on a freshly opened window.
        if (FRONTS[id].account) { renderAccount(id); renderGuide(id); }
        renderGephStats(id);
    }

    // ── Talking to the server ──────────────────────────────────────────────
    async function refresh(id) {
        // Cheap and only while connected — see pollGephStats. Fired before the paint below so
        // the numbers land in the same frame as the rest of the status.
        pollGephStats(id).catch(() => {});
        try {
            const r = await fetch(FRONTS[id].api + '/status');
            st[id].payload = await r.json();
        } catch (e) {
            return;   // the server is restarting; keep the last picture rather than blanking it
        }
        // AFTER the status, not before: it reads `connected` from it, and it writes the exit
        // country back into the same object for the strip and the country card to find.
        await pollTorLive(id).catch(() => {});
        const live = st[id].tLive;
        if (live && live.exit && live.exit.country && st[id].payload && st[id].payload.status) {
            st[id].payload.status.egressRegion = live.exit.country;
        }
        paint(id);
    }

    function log(id, line) {
        const s = st[id];
        s.log.push(line);
        // Only ever the tail: tor at `info` produces thousands of lines in one bootstrap, and an
        // array that grows without bound is a leak in a window somebody leaves open all day.
        if (s.log.length > 400) s.log = s.log.slice(-400);
        if (s.logOpen) renderLog(id);
    }

    async function toggle(id) {
        const f = FRONTS[id], s = st[id];
        if (s.stopping || s.tunStopping) return;
        const status = (s.payload && s.payload.status) || {};
        // A stop is never «busy-blocked»: the start request stays open for the whole ladder (up to
        // two minutes for سایفون), and the user must be able to end it at any point in that.
        if (status.running || status.connected || s.attempting) {
            s.attemptId = (s.attemptId || 0) + 1;
            s.attempting = false;
            s.busy = true;
            s.stopping = true; paint(id);
            try {
                const r = await fetch(f.api + '/stop', { method: 'POST' });
                const out = await r.json();
                if (!r.ok) throw new Error(out.error || 'قطع اتصال انجام نشد');
                log(id, '— قطع شد');
            } catch (e) { log(id, `✗ ${e.message}`); }
            s.tunPending = false;
            await refresh(id);
            s.stopping = false;
            s.busy = false;
            paint(id);
            return;
        }
        // Optimistic: the engine has not answered yet, but the user has pressed, and the next press
        // must mean «cancel». Without this the button sat disabled until the first status poll came
        // back — up to four seconds in which the one thing a user wants is to stop it.
        s.attempting = true;
        const attemptId = s.attemptId = (s.attemptId || 0) + 1;
        s.busy = true; paint(id);
        // WHAT THE USER ASKED FOR, CAPTURED NOW.
        //
        // `/start` stays open for the whole ladder — up to two minutes — and the status poll runs
        // through that window. The engine reports «connected» before the tunnel is built, so the
        // repaint that follows used to write `coverage = 'proxy'` over the user's choice, and the
        // line below then read that and never turned the tunnel on. The user picked «تونل کامل»,
        // waited, and got a plain proxy.
        const wantTunnel = s.coverage === 'tunnel';
        try {
            {
                s.log = [];
                s.tunError = null;
                const body = id === 'tor'
                    ? { mode: s.method || 'auto', region: s.region }
                    : id === 'lantern'
                        ? { proxyAll: s.method !== 'smart' }
                        : id === 'geph'
                            // The city only travels with a country — `country_city` is a tuple,
                            // and a city alone names nothing the broker can match.
                            ? { region: s.region, city: s.region === 'auto' ? '' : (s.city || '') }
                            : { rung: s.method || undefined, region: s.region };
                const r = await fetch(f.api + '/start', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                });
                const out = await r.json();
                if (s.attemptId !== attemptId) return;
                if (!r.ok) {
                    log(id, `✗ ${out.error || 'اتصال نشد'}`);
                    // A refused connect is a question the assistant can answer better than this
                    // log line can: it knows how to race every engine and name one that IS open
                    // tonight. «No account yet» is not a failure, so it is excluded.
                    if (out.code !== 'NO_ACCOUNT' && window.MVAssistant && typeof window.MVAssistant.trouble === 'function') {
                        try { window.MVAssistant.trouble({ kind: 'engine-failed', detail: f.title, source: id, raw: out.error || '' }); } catch (e2) { /* the log still has it */ }
                    }
                    // «You have no account yet» is not a failed connection — it is one button away,
                    // and saying so beside that button is the difference between a dead end and a
                    // next step.
                    if (out.code === 'NO_ACCOUNT') s.acctNote = 'اول «ساخت حساب رایگان» را بزنید — چند ده ثانیه طول می‌کشد و رایگان است.';
                } else if (out.warning) log(id, `⚠ ${out.warning}`);
                // The coverage the user chose is applied as PART of connecting, not as a second
                // decision afterwards — which is exactly what the old second button made it.
                if (r.ok && wantTunnel) {
                    s.tunPending = true; paint(id);
                    await setTun(id, true);
                    if (s.attemptId !== attemptId) return;
                    s.tunPending = false;
                }
            }
        } catch (e) {
            if (s.attemptId !== attemptId) return;
            log(id, `✗ ${e.message}`);
        }
        s.attempting = false;
        s.busy = false;
        await refresh(id);
    }

    /**
     * Draw a different set of Lantern servers.
     *
     * Measured on a real blocked line: the three assigned addresses accepted no TCP at all, and
     * clearing the device identity produced three different ones. So this is a real move — but it
     * is not a fix, because that day the second set was dead too. The result is reported either
     * way, with the addresses, so the user can see whether the draw changed anything.
     */
    async function rotateLantern(id) {
        const s = st[id];
        s.busy = true; paint(id);
        try {
            const r = await fetch('/api/lantern/rotate', { method: 'POST' });
            const out = await r.json();
            if (!r.ok) log(id, `✗ ${out.error || 'نشد'}`);
            else if (out.after && out.after.length) {
                log(id, `دستهٔ تازه: ${out.after.join('، ')}`);
            } else {
                log(id, 'شناسه پاک شد — با «اتصال» دستهٔ تازه گرفته می‌شود.');
            }
        } catch (e) { log(id, `✗ ${e.message}`); }
        s.busy = false;
        await refresh(id);
    }

    async function setCoverage(id, want) {
        const s = st[id];
        if (s.busy || s.stopping || s.tunStopping) return;
        const status = (s.payload && s.payload.status) || {};
        s.coverage = want;
        // Nothing connected yet: this is only a choice for the next connect.
        if (!status.connected) { paint(id); return; }
        s.busy = true;
        s.tunPending = want === 'tunnel';
        s.tunStopping = want !== 'tunnel';
        paint(id);
        await setTun(id, want === 'tunnel');
        await refresh(id);
        s.tunPending = false;
        s.tunStopping = false;
        s.busy = false;
        paint(id);
    }

    async function setTun(id, on) {
        st[id].tunError = null;
        try {
            const r = await fetch('/api/front/tun', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ engine: id, enabled: on }),
            });
            const out = await r.json();
            if (!r.ok) {
                const why = out.error || 'تونل روشن نشد';
                log(id, `✗ ${why}`);
                // The choice did not take, so the panel must not go on claiming it did — and it
                // must not go on looking connected-and-fine either. A tunnel that failed leaves
                // the user with a proxy nothing is pointed at, which from outside is exactly
                // "it says وصل است and no page loads".
                st[id].coverage = 'proxy';
                if (on) st[id].tunError = why;
            }
        } catch (e) {
            log(id, `✗ ${e.message}`);
            st[id].coverage = 'proxy';
            if (on) st[id].tunError = e.message;
        }
    }

    // ── Events pushed from the server ──────────────────────────────────────
    window.handleFrontLog = function (d) {
        const line = (d && d.line) || '';
        if (/^\[TOR\]/.test(line)) log('tor', line.replace(/^\[TOR\]\s*/, ''));
        else if (/^\[سایفون\]/.test(line)) log('psiphon', line.replace(/^\[سایفون\]\s*/, ''));
        else if (/^\[لنترن\]/.test(line)) log('lantern', line.replace(/^\[لنترن\]\s*/, ''));
        else if (/^\[GEPH\]/.test(line)) log('geph', line.replace(/^\[GEPH\]\s*/, ''));
    };

    /** The sign-up puzzle's progress, pushed while it is being solved. */
    window.handleGephRegister = function (d) {
        const s = st.geph;
        if (!d) return;
        s.regPct = Math.max(0, Math.min(1, Number(d.progress) || 0));
        if (d.done) { s.regBusy = false; s.regPct = 0; }
        if (s.regBusy || d.done) renderAccount('geph');
    };
    window.handleFrontStatus = function (d) { if (d && d.engine) refresh(d.engine); };

    /**
     * One country's result, as the sweep learns it.
     *
     * Kept in the panel's own state rather than fetched again, because the point is that the row
     * fills in WHILE the sweep runs — a repaint per country, next to the country, instead of a
     * spinner and a verdict at the end.
     */
    window.handleGephSweep = function (d) {
        const s = st.geph;
        if (!s || !d) return;
        if (d.stage === 'probing' || d.stage === 'measuring') {
            s.sweepRunning = true;
            s.sweepStage = d.stage;
            if (d.total && d.stage === 'probing') s.sweepTotal = d.total;
        }
        if (d.stage === 'result' && d.row && d.row.country) {
            s.sweepLive = s.sweepLive || {};
            s.sweepLive[String(d.row.country).toUpperCase()] = d.row;
            if (d.total && s.sweepStage === 'probing') s.sweepTotal = d.total;
        }
        if (d.stage === 'finished' || d.stage === 'failed') {
            s.sweepRunning = false;
            s.sweepStage = null;
            refresh('geph');    // picks up the saved ranking and the winner
            return;
        }
        paint('geph');
    };

    /**
     * تور's path measurement, as it happens.
     *
     * Live rather than polled, for the same reason گف's is: a four-second poll would show a
     * fifty-second run as a dozen frames, and the whole point of the panel is watching each draw
     * land next to the one before it.
     */
    window.handleTorPath = function (d) {
        const s = st.tor;
        if (!s || !d) return;
        if (d.phase === 'measuring' || d.phase === 'redraw') s.pathRunning = true;
        if (d.phase === 'draw' && d.row) {
            s.pathDraws = (s.pathDraws || []).concat([d.row]);
        }
        if (d.phase === 'finished' || d.phase === 'failed') {
            s.pathRunning = false;
            s.pathDone = d.summary || null;
            refresh('tor');
            return;
        }
        paint('tor');
    };

    /** Which engine owns the home-screen lamp. Read by shell/apps.js. */
    window.MVProbe = window.MVProbe || {};
    window.MVProbe.psiphon = () => !!(st.psiphon.payload && st.psiphon.payload.status && st.psiphon.payload.status.connected);
    window.MVProbe.tor = () => !!(st.tor.payload && st.tor.payload.status && st.tor.payload.status.connected);
    window.MVProbe.lantern = () => !!(st.lantern.payload && st.lantern.payload.status && st.lantern.payload.status.connected);
    window.MVProbe.geph = () => !!(st.geph.payload && st.geph.payload.status && st.geph.payload.status.connected);

    /** apps.js calls this when a window is shown, so a hidden panel repaints at once. */
    window.frontRefresh = refresh;

    const IDS = ['psiphon', 'tor', 'lantern', 'geph'];

    window.initFrontModules = function () {
        IDS.forEach(id => {
            const root = $(`ls-${id}`);
            if (!root) return;
            root.innerHTML = template(FRONTS[id]);
            const wrap = $(`${id}-wrap`);
            wrap.querySelectorAll('.mv-side-item[data-sec]').forEach(b => {
                b.onclick = () => goSec(id, b.getAttribute('data-sec'));
            });
            const back = el(id, 'back');
            if (back) back.onclick = () => goSec(id, 'connect');
            const store = el(id, 'store');
            if (store) store.onclick = () => openInStore(id);
            st[id].guideOpen = true;      // the guide is a section now, always drawn when it is shown
            goSec(id, 'connect');
            refresh(id);
        });
        // A slow poll as well as the pushed events, because a stop that came from somewhere else —
        // the always-on replay, an engine that exited by itself — announces nothing. Only for a
        // window that is actually on screen.
        setInterval(() => {
            IDS.forEach(id => {
                const root = $(`ls-${id}`);
                if (root && root.style.display !== 'none') refresh(id);
            });
        }, 4000);
    };
})();
