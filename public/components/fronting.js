// --- «دامین فرانتینگ»: YouTube, Instagram, WhatsApp, Facebook, Reddit with no server at all ---
//
// The Android app's Domain Fronting screen, on Windows: the setup first and the connection
// under it, because the order is not cosmetic — the config cannot carry anything until the
// certificate it terminates TLS with is one this machine trusts. A connect button above an
// unfinished setup is a button whose only outcome is a certificate error in the browser.
//
// Renders into #ls-fronting. The certificate and the config are the server's
// (mitm-manager.js, /api/mitm/*); connecting drives the one Xray engine through the same
// /api/v2ray/start as V2Ray and «کانفیگ ایران», and "is it live" is read back from the server.
(function () {
    'use strict';

    const NAME = 'دامین‌فرانتینگ v23 — بدون سرور';
    const st = { mitm: null, running: false, uri: null, tunnel: false, proxyMode: 'system', busy: null };

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
    const ready = () => !!(st.mitm && st.mitm.exists && st.mitm.trusted && st.mitm.config);
    const live = () => ready() && st.running && st.uri === st.mitm.config;

    async function call(url, body) {
        const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
        const res = await fetch(url, opts);
        let data = {};
        try { data = await res.json(); } catch (e) { /* an empty reply is still an answer */ }
        if (!res.ok && !data.error) data.error = `پاسخ ${res.status} از برنامه`;
        if (data.error) data.error = String(data.error).replace(/\s*\(__dirname:[^)]*\)\s*$/, '');
        return data;
    }

    async function refresh() {
        try {
            const [m, t, q] = await Promise.all([call('/api/mitm/status'), call('/api/v2ray/traffic'), call('/api/quick/status')]);
            if (!m.error) st.mitm = m;
            if (!t.error) { st.running = !!t.running; st.uri = t.uri || null; }
            if (!q.error) { st.tunnel = !!q.tunnelWanted; st.proxyMode = q.proxyMode || 'system'; }
        } catch (e) { /* the server is not answering: the page shows the first step */ }
        render();
    }

    async function act(kind, url, okText) {
        if (st.busy) return;
        st.busy = kind;
        render();
        try {
            const d = await call(url, {});
            if (d.error) throw new Error(d.error);
            if (!d.error && d.exists !== undefined) st.mitm = d;
            if (d.declined) { if (typeof toast === 'function') toast('نصب در پنجره‌ی ویندوز تأیید نشد — هر وقت خواستید دوباره بزنید.'); }
            else if (okText && typeof toast === 'function') toast(okText);
        } catch (e) {
            if (typeof toast === 'function') toast('❌ ' + e.message);
        } finally {
            st.busy = null;
            await refresh();
        }
    }

    async function connect() {
        if (st.busy || !ready()) return;
        st.busy = 'connect';
        render();
        try {
            const useSystemProxy = !st.tunnel && st.proxyMode !== 'port';
            const d = await call('/api/v2ray/start', { uri: st.mitm.config, useSystemProxy });
            if (d.error) throw new Error(d.error);
            if (typeof window.markV2rayConnected === 'function') window.markV2rayConnected(NAME, { systemProxy: useSystemProxy });
            if (typeof toast === 'function') toast('✅ دامین‌فرانتینگ وصل شد');
        } catch (e) {
            if (typeof toast === 'function') toast('❌ ' + e.message);
        } finally {
            st.busy = null;
            await refresh();
        }
    }

    async function disconnect() {
        if (st.busy) return;
        st.busy = 'disconnect';
        render();
        try {
            const d = await call('/api/v2ray/stop', {});
            if (d.error) throw new Error(d.error);
            if (typeof window.disconnectV2rayUI === 'function') window.disconnectV2rayUI();
            if (typeof toast === 'function') toast('اتصال قطع شد');
        } catch (e) {
            if (typeof toast === 'function') toast('❌ ' + e.message);
        } finally {
            st.busy = null;
            await refresh();
        }
    }

    // ── The page ───────────────────────────────────────────────────────────
    //
    // The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), as every other engine wears it.
    // The order that matters here is not cosmetic: this config cannot carry a byte until the
    // certificate it terminates TLS with is one this machine trusts, so the hero's button stays
    // disabled and says which step is next until the setup is done.

    const FR_SECTIONS = [
        { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
        { id: 'setup', label: 'راه‌اندازی', icon: 'ph-fill ph-seal-check', tint: 'var(--mv-yellow)' },
        { id: 'cert', label: 'گواهی', icon: 'ph-fill ph-certificate', tint: 'var(--mv-indigo)' },
    ];

    let sec = 'connect';

    function shell() {
        return `
<div id="fronting-wrapper" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های دامین فرانتینگ">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="fr-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${FR_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-fr-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="fr-store" title="کانفیگ دامین فرانتینگ در ام‌ال‌ام استور">
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
        <button type="button" id="fr-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="fr-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="fr-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="fr-stage" style="--tint:var(--mv-yellow)"></div>
        <div class="mv-eng-grid" id="fr-cards"></div>
      </div>
      <div class="mv-eng-sec" data-sec="setup"><div class="mv-form" id="fr-sec-setup"></div></div>
      <div class="mv-eng-sec" data-sec="cert"><div class="mv-form" id="fr-sec-cert"></div></div>
    </div>

    <div class="mv-eng-foot" id="fr-foot"></div>
  </section>
</div>`;
    }

    function step(n, state, title, desc, action) {
        const chip = state === 'done' ? '<span class="mv-step is-done"><i>✓</i></span>'
            : state === 'active' ? `<span class="mv-step is-active"><i>${fa(n)}</i></span>`
                : `<span class="mv-step"><i>${fa(n)}</i></span>`;
        return `<div class="mv-form-row"><span class="mv-row-mark">${chip}</span>
            <span class="mv-form-label">${title}<small>${desc}</small></span>${action || ''}</div>`;
    }

    function button(kind, label, primary, disabled) {
        const spinning = st.busy === kind;
        return `<button type="button" class="mv-btn mv-btn--sm${primary ? ' mv-btn--primary' : ''}" data-fr="${kind}"${disabled || st.busy ? ' disabled' : ''}>${spinning ? '<i class="mv-spin-ring"></i>' : ''}${label}</button>`;
    }

    /** How the machine's traffic gets in — the same sentence the old page carried. */
    function pathNote() {
        return st.tunnel
            ? 'تونل کامل V2Ray روشن است، پس این کانفیگ از همان تونل رد می‌شود.'
            : st.proxyMode === 'port'
                ? '«فقط پورت محلی» در تنظیمات › شبکه روشن است: پروکسی ویندوز دست نمی‌خورد و باید برنامه‌ها را خودتان روی پورت محلی تنظیم کنید.'
                : 'با یک ضربه وصل می‌شود و پروکسی سیستم روشن می‌شود.';
    }

    function view() {
        const m = st.mitm || {};
        if (st.busy === 'connect') return { tone: 'busy', head: 'در حال اتصال', line: 'چند لحظه…' };
        if (st.busy === 'disconnect') return { tone: 'busy', head: 'در حال قطع', line: 'چند لحظه…' };
        if (st.busy) return { tone: 'busy', head: 'در حال کار روی گواهی', line: 'پنجرهٔ خود ویندوز ممکن است سؤال بپرسد.' };
        if (live()) {
            return {
                tone: 'on', head: 'وصل است',
                line: `یوتیوب، اینستاگرام، واتس‌اپ، فیسبوک و ردیت از این کانفیگ رد می‌شوند — بدون هیچ سروری در مسیر. ${esc(pathNote())}`,
            };
        }
        if (!m.exists) {
            return {
                tone: 'off', head: 'اول گواهی این کامپیوتر ساخته شود',
                line: 'این روش، دست‌دهی TLS را روی همین کامپیوتر باز می‌کند و دوباره زیر نام دیگری می‌بندد، پس به یک گواهی نیاز دارد که خودِ ویندوز شما به آن اعتماد کند. در کارت «راه‌اندازی» بسازیدش — چیزی از اینترنت دانلود نمی‌شود.',
            };
        }
        if (!m.trusted) {
            return {
                tone: 'off', head: 'گواهی ساخته شد — حالا در ویندوز نصبش کنید',
                line: 'تنها مرحله‌ای که ویندوز اجازه نمی‌دهد برنامه خودش انجام دهد: پنجرهٔ خود ویندوز می‌پرسد «<span dir="ltr">Do you want to install this certificate?</span>» و شما «<span dir="ltr">Yes</span>» را می‌زنید.',
            };
        }
        return {
            tone: 'off', head: 'یوتیوب و اینستاگرام، بدون هیچ سروری',
            line: `دو ورودی محلی، دست‌دهی TLS را با گواهی همین کامپیوتر خاتمه می‌دهند، مقصد واقعی را می‌خوانند و اتصال را زیر نامی که فیلتر نیست باز می‌کنند. ${esc(pathNote())}`,
        };
    }

    function renderIdent() {
        const host = document.getElementById('fr-ident');
        if (!host) return;
        const v = view();
        const word = v.tone === 'on' ? 'وصل است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('fronting');
        const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
            : '<span class="mv-side-tile" style="--tint:var(--mv-yellow)"><svg aria-hidden="true"><use href="#g-swap"/></svg></span>';
        host.innerHTML = `${icon}
      <b>دامین فرانتینگ</b>
      <small><i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : ''}"></i>${word}</small>`;
    }

    /** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
    function renderStage() {
        const host = document.getElementById('fr-stage');
        if (!host) return;
        const v = view();

        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-fr="row" data-part="power">
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

        const on = live();
        const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : '';
        const btn = q('power');
        const want = 'mv-eng-power' + ring;
        if (btn.className !== want) btn.className = want;
        // Disabled until the setup is done: a press that can only end in a certificate error in
        // the browser is worse than a button that says «not yet».
        btn.disabled = !ready() || !!st.busy;
        const aria = on ? 'قطع' : 'اتصال';
        btn.setAttribute('aria-label', aria);
        btn.title = ready() ? aria : 'اول راه‌اندازی را کامل کنید';
        const glyph = v.tone === 'busy' ? 'mv-spin-ring' : (on ? 'ph-fill ph-power' : 'ph-bold ph-power');
        const gl = q('glyph');
        if (gl.className !== glyph) gl.className = glyph;

        const el = q('live');
        if (el && window.MVEngineLive) MVEngineLive.mount(el);
    }

    function renderCards() {
        const host = document.getElementById('fr-cards');
        if (!host) return;
        const m = st.mitm || { exists: false, trusted: false, cert: null };
        const cert = m.cert;
        const made = cert && cert.createdAt ? new Date(cert.createdAt).toLocaleDateString('fa-IR') : '—';
        const s1 = m.exists ? 'done' : 'active';
        const s2 = !m.exists ? 'todo' : m.trusted ? 'done' : 'active';
        const s3 = ready() ? 'done' : 'todo';

        host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-yellow)">
        <button type="button" class="mv-eng-card2-head" data-fr-go="setup">
          <span class="mv-eng-glyph"><i class="ph-fill ph-seal-check"></i></span>
          <h3>راه‌اندازی</h3>
          <span class="mv-eng-card2-end">${ready() ? 'آماده' : !m.exists ? 'مرحلهٔ ۱' : 'مرحلهٔ ۲'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          ${step(1, s1, 'ساخت گواهی این کامپیوتر', 'برنامه خودش می‌سازد — چیزی دانلود نمی‌شود.', m.exists ? '' : button('setup', 'بساز', true))}
          ${step(2, s2, 'نصب گواهی در ویندوز', 'ویندوز خودش می‌پرسد؛ «Yes» را بزنید.', m.exists && !m.trusted ? button('trust', 'نصب', true) : '')}
          ${step(3, s3, 'آماده', ready() ? 'دکمهٔ بالا حالا وصل می‌کند.' : 'بعد از دو مرحلهٔ بالا.')}
        </div>
        <div class="mv-eng-card2-foot">این گواهی مخصوص همین کامپیوتر است و هیچ‌جا فرستاده نمی‌شود. گواهی کسی دیگر را هرگز نصب نکنید.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <button type="button" class="mv-eng-card2-head" data-fr-go="cert">
          <span class="mv-eng-glyph"><i class="ph-fill ph-certificate"></i></span>
          <h3>گواهی</h3>
          <span class="mv-eng-card2-end">${m.trusted ? 'نصب شده' : m.exists ? 'نصب نشده' : 'ساخته نشده'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          ${cert ? `
          <div class="mv-eng-pick" aria-disabled="true">
            <i class="${m.trusted ? 'ph-fill ph-check-circle' : 'ph-fill ph-warning-circle'}" style="color:${m.trusted ? 'var(--mv-green)' : 'var(--mv-orange)'}"></i>
            <span class="mv-eng-pick-text"><b dir="ltr">${esc(cert.cn)}</b><small>${m.trusted ? 'ویندوز به آن اعتماد می‌کند' : 'هنوز در ویندوز نصب نشده'} · ساخته‌شده ${esc(made)}</small></span>
          </div>` : `
          <div class="mv-eng-card2-foot" style="padding-top:6px">هنوز گواهی‌ای ساخته نشده.</div>`}
        </div>
        <div class="mv-eng-card2-foot">در کروم و اج کار می‌کند. فایرفاکس گواهی‌های ویندوز را پیش‌فرض قبول نمی‌کند — در <span dir="ltr">about:config</span> گزینهٔ <span dir="ltr">security.enterprise_roots.enabled</span> را true کنید.</div>
      </div>`;
    }

    function renderFoot() {
        const host = document.getElementById('fr-foot');
        if (!host) return;
        const v = view();
        const word = v.tone === 'on' ? 'وصل — دامین‌فرانتینگ v23'
            : v.tone === 'busy' ? 'در حال کار'
                : ready() ? 'آمادهٔ اتصال'
                    : (st.mitm && st.mitm.exists) ? 'گواهی نصب نشده' : 'گواهی ساخته نشده';
        const end = st.tunnel ? 'تونل کامل سیستم' : st.proxyMode === 'port' ? 'فقط پورت محلی' : 'پروکسی سیستم';
        host.innerHTML = `
      <i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : ''}"></i>
      <span>${word}</span>
      <span class="mv-eng-foot-end">${end}</span>`;
    }

    function setupSection() {
        const m = st.mitm || { exists: false, trusted: false };
        const s1 = m.exists ? 'done' : 'active';
        const s2 = !m.exists ? 'todo' : m.trusted ? 'done' : 'active';
        const s3 = ready() ? 'done' : 'todo';
        return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">راه‌اندازی</div>
        <div class="mv-form-group">
          ${step(1, s1, 'ساخت گواهی اختصاصی این کامپیوتر', 'برنامه خودش می‌سازد — چیزی از اینترنت دانلود نمی‌شود.', m.exists ? '' : button('setup', 'ساخت گواهی', true))}
          ${step(2, s2, 'نصب گواهی در ویندوز', 'تنها مرحله‌ای که ویندوز اجازه نمی‌دهد برنامه خودش انجام دهد: پنجرهٔ خود ویندوز می‌پرسد «<span dir="ltr">Do you want to install this certificate?</span>» — «<span dir="ltr">Yes</span>» را بزنید.', m.exists && !m.trusted ? button('trust', 'نصب گواهی', true) : '')}
          ${step(3, s3, 'آماده', ready() ? 'همه چیز آماده است؛ دکمهٔ وسط صفحهٔ اتصال وصل می‌کند.' : 'بعد از این، دکمهٔ اتصال فعال می‌شود.')}
          <div class="mv-form-row mv-callout is-warn"><i class="ph-fill ph-warning"></i><span>این گواهی مخصوص همین کامپیوتر است و هیچ‌جا ارسال نمی‌شود. <b>گواهی کسی دیگر را هرگز نصب نکنید</b> و گواهی خودتان را هم به کسی ندهید.</span></div>
        </div>
        <div class="mv-form-footer">هیچ سروری در مسیر نیست. دو ورودی محلی TLS را با گواهی‌ای که روی همین کامپیوتر ساخته می‌شود خاتمه می‌دهند، مقصد واقعی را می‌خوانند و اتصال را زیر یک نام دیگر که فیلتر نیست دوباره باز می‌کنند. برای همین یک کانفیگ برای همه کافی است: نه رازی مخصوص هر کاربر دارد نه پهنای باندی که کسی بپردازد. کانفیگ از پروژهٔ MITM-DomainFronting (patterniha@) است و از «ام‌ال‌ام استور» بروز می‌شود.</div>
      </div>`;
    }

    function certSection() {
        const m = st.mitm || {};
        const cert = m.cert;
        const on = live();
        if (!cert) {
            return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">گواهی</div>
        <div class="mv-form-group">
          <div class="mv-form-row"><span class="mv-form-label" style="color:var(--mv-label-2)">هنوز گواهی‌ای ساخته نشده — در «راه‌اندازی» مرحلهٔ ۱ را بزنید.</span></div>
        </div>
      </div>`;
        }
        const made = cert.createdAt ? new Date(cert.createdAt).toLocaleDateString('fa-IR') : '—';
        return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">جزئیات و مدیریت گواهی</div>
        <div class="mv-form-group">
          <div class="mv-form-row"><span class="mv-form-label">نام گواهی</span><span class="mv-form-value" dir="ltr">${esc(cert.cn)}</span></div>
          <div class="mv-form-row is-top"><span class="mv-form-label">اثر انگشت (SHA-256)<small dir="ltr" class="mv-form-mono" style="word-break:break-all">${esc(cert.sha256)}</small></span></div>
          <div class="mv-form-row"><span class="mv-form-label">ساخته‌شده</span><span class="mv-form-value">${esc(made)}</span></div>
          <div class="mv-form-row"><span class="mv-form-label">اعتماد ویندوز</span><span class="mv-form-value">${m.trusted ? 'نصب شده' : 'نصب نشده'}</span></div>
          <div class="mv-form-row"><span class="mv-form-label">اگر گواهی را حذف کنید، اول از ویندوز برداشته می‌شود (ویندوز یک‌بار دیگر می‌پرسد) و بعد فایلش پاک می‌شود. برای استفادهٔ دوباره باید از مرحلهٔ ۱ شروع کنید.</span>
            ${m.trusted ? button('untrust', 'حذف از ویندوز', false, on) : ''}${button('remove', 'حذف گواهی', false, on).replace('class="mv-btn mv-btn--sm"', 'class="mv-btn mv-btn--sm mv-btn--danger"')}</div>
        </div>
      </div>`;
    }

    function goSec(id) {
        const wrap = document.getElementById('fronting-wrapper');
        if (!wrap) return;
        sec = FR_SECTIONS.some((x) => x.id === id) ? id : 'connect';
        wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === sec));
        wrap.querySelectorAll('.mv-side-item[data-fr-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-fr-sec') === sec));
        const found = FR_SECTIONS.find((x) => x.id === sec);
        const title = document.getElementById('fr-title');
        if (title) title.textContent = found ? found.label : '';
        const back = document.getElementById('fr-back');
        if (back) back.disabled = sec === 'connect';
        const pane = wrap.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', sec === 'connect');
        const sc = document.getElementById('fr-scroll');
        if (sc) sc.scrollTop = 0;
        render();
    }

    function wire(root) {
        root.querySelectorAll('[data-fr-go]').forEach((b) => { b.onclick = () => goSec(b.getAttribute('data-fr-go')); });
        root.querySelectorAll('[data-fr]').forEach((b) => {
            b.onclick = () => {
                const k = b.dataset.fr;
                if (k === 'setup') act('setup', '/api/mitm/setup', '✅ گواهی ساخته شد');
                else if (k === 'trust') act('trust', '/api/mitm/trust', '✅ گواهی در ویندوز نصب شد');
                else if (k === 'untrust') act('untrust', '/api/mitm/untrust', 'گواهی از ویندوز برداشته شد');
                else if (k === 'remove') act('remove', '/api/mitm/remove', 'گواهی حذف شد');
                else if (k === 'row' && ready()) { if (live()) disconnect(); else connect(); }
            };
        });
    }

    function render() {
        const root = document.getElementById('ls-fronting');
        if (!root) return;
        if (!document.getElementById('fronting-wrapper')) {
            root.innerHTML = shell();
            const wrap = document.getElementById('fronting-wrapper');
            wrap.querySelectorAll('.mv-side-item[data-fr-sec]').forEach((b) => {
                b.onclick = () => goSec(b.getAttribute('data-fr-sec'));
            });
            const back = document.getElementById('fr-back');
            if (back) back.onclick = () => goSec('connect');
            const store = document.getElementById('fr-store');
            if (store) store.onclick = () => {
                if (typeof window.storeOpenItem === 'function') window.storeOpenItem('data|mitm-config');
                else if (window.MV && MV.wm) MV.wm.open('store');
            };
            goSec('connect');
            return;      // goSec calls render() again, with the shell in place
        }

        renderIdent();
        renderFoot();
        if (sec === 'connect') { renderStage(); renderCards(); }
        else {
            const host = document.getElementById('fr-sec-' + sec);
            if (host) host.innerHTML = sec === 'setup' ? setupSection() : certSection();
        }
        wire(document.getElementById('fronting-wrapper'));
    }

    window.addEventListener('mv-v2ray-state', () => { refresh(); });
    window.refreshFronting = refresh;
    window.MVProbe = window.MVProbe || {};
    window.MVProbe.fronting = () => live();

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
    else refresh();
})();
