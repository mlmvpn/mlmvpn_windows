// --- Settings, row for row as Android's «تنظیمات نرم‌افزار» ---
//
// Android's Settings (ui/settings/SettingsScreen.kt) is one list: the Cloudflare account card,
// «منابع حساب», then the groups شبکه · صفحه نمایش · مصرف · سیستم · درباره — every row either a
// switch or a page of its own. Here the sidebar carries the same groups in the same order, each
// pane shows its group's rows in Android's order and words, and a row that opens a page on
// Android opens a page inside the pane, with a back row, as iOS and macOS Settings do. Settings
// only Windows has sit after Android's, under «ویندوز», so nothing Android has is out of place
// and nothing Windows had is lost.
//
// Every value lives with its one owner — the server (network-settings, system-settings,
// display-settings, app-routing, update-manager, crash-reporter, cf-resources) or the UI runtime
// (MV.appearance, MV.prefs, MV.displayPrefs, MV.wallpaper) — and this file only shows and changes
// them. No Save buttons: every change applies as it is made, as on Android.
(function () {
    'use strict';

    // ── Small tools ────────────────────────────────────────────────────────────────────────
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
    const shellOn = () => document.documentElement.classList.contains('mv-shell');
    const say = (m) => { if (typeof toast === 'function') toast(m); };
    const store = {
        get(k, d) {
            try { const v = window.PersistentStorage ? PersistentStorage.getItem(k) : localStorage.getItem(k); return v == null ? d : v; }
            catch (e) { return d; }
        },
        set(k, v) {
            try { if (window.MV && MV.store) MV.store(k, v); else PersistentStorage.setItem(k, v); } catch (e) { /* this session only */ }
        },
    };

    // A route the running server does not have answers 404: the window is showing this build's
    // pages over a server started before it. That is the one thing to say, not "could not read".
    const RESTART = 'این بخش در برنامه‌ای که الان روشن است وجود ندارد — برنامه از پیش از این به‌روزرسانی باز مانده. یک بار «خروج کامل» بزنید و دوباره بازش کنید.';
    async function api(url, body) {
        let res;
        try {
            res = await fetch(url, body !== undefined
                ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
                : undefined);
        } catch (e) { return { error: 'برنامه جواب نداد: ' + e.message }; }
        let data = {};
        try { data = await res.json(); } catch (e) { /* empty reply */ }
        if (res.status === 404 && !data.error) return { error: RESTART, restart: true };
        if (!res.ok && !data.error) data.error = `پاسخ ${res.status} از برنامه`;
        return data;
    }

    const faNum = (s) => fa(String(s).replace('.', '٫'));
    const bytes = (n) => {
        n = Number(n) || 0;
        if (n < 1024 * 1024) return fa(Math.round(n / 1024)) + ' KB';
        const mb = n / 1024 / 1024;
        if (mb < 1024) return faNum(mb.toFixed(1)) + ' MB';
        return faNum((mb / 1024).toFixed(2)) + ' GB';
    };
    const when = (ms) => {
        if (!ms) return '—';
        try {
            return new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
        } catch (e) { return new Date(ms).toLocaleString(); }
    };
    function copy(text) {
        const done = () => say('📋 کپی شد');
        try { navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); } catch (e) { fallbackCopy(text, done); }
    }
    function fallbackCopy(text, done) {
        const t = document.createElement('textarea');
        t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
        document.body.appendChild(t); t.select();
        try { document.execCommand('copy'); done(); } catch (e) { say('❌ کپی نشد'); }
        t.remove();
    }
    function openExternal(url) { window.open(url, '_blank'); }
    function openWindow(id, legacy) {
        if (window.MV && MV.wm && shellOn()) MV.wm.open(id);
        else if (legacy) legacy();
    }
    const openCloud = () => openWindow('cloud', () => { if (typeof window.toggleLeftSidebar === 'function') window.toggleLeftSidebar('cloud'); });

    // ── Row builders (the page kit's grouped form, in Android's row shapes) ────────────────
    const tile = (icon, tint) => `<span class="mv-side-tile as-ic" style="--tint:${tint}"><i class="${icon}"></i></span>`;
    const label = (title, sub, style) => `<span class="mv-form-label"${style ? ` style="${style}"` : ''}>${title}${sub ? `<small>${sub}</small>` : ''}</span>`;
    const val = (v, ltr) => (v == null || v === '' ? '' : `<span class="as-value"${ltr ? ' dir="ltr"' : ''}>${v}</span>`);

    /** A row that opens a page (SettingsRow with its chevron). */
    function linkRow(o) {
        return `<button type="button" class="mv-form-row is-action ${o.noChevron ? '' : 'is-link'}" data-as="${o.act}"${o.arg != null ? ` data-arg="${esc(o.arg)}"` : ''}${o.busy ? ' aria-busy="true"' : ''}>
          ${o.icon ? tile(o.icon, o.tint) : ''}${label(o.title, o.sub, o.danger ? 'color:var(--mv-red-ink)' : '')}${val(o.value, o.ltr)}</button>`;
    }
    /** A row with a switch (SettingsToggle). */
    function switchRow(o) {
        return `<div class="mv-form-row">${o.icon ? tile(o.icon, o.tint) : ''}${label(o.title, o.sub)}
          <span class="mv-switch mv-switch--mini" role="switch" tabindex="0" aria-checked="${!!o.on}" data-as-switch="${o.act}"${o.disabled ? ' aria-disabled="true"' : ''} aria-label="${esc(String(o.title).replace(/<[^>]+>/g, ''))}"></span></div>`;
    }
    /** A row that only shows a value. */
    function valueRow(o) {
        return `<div class="mv-form-row">${o.icon ? tile(o.icon, o.tint) : ''}${label(o.title, o.sub)}${val(o.value, o.ltr)}</div>`;
    }
    /** One choice of a picker page (IosPickerScreen): the tick on the trailing edge. */
    function pickRow(act, key, title, sub, selected, disabled) {
        return `<button type="button" class="mv-form-row is-action" data-as="${act}" data-arg="${esc(key)}" role="radio" aria-checked="${!!selected}"${disabled ? ' disabled' : ''}>
          ${label(title, sub, disabled ? 'color:var(--mv-label-3)' : '')}${selected ? '<i class="ph-bold ph-check as-tick"></i>' : ''}</button>`;
    }
    function section(header, rows, footer, cls) {
        return `<div class="mv-form-section${cls ? ' ' + cls : ''}">${header ? `<div class="mv-form-header">${header}</div>` : ''}
          <div class="mv-form-group">${rows}</div>${footer ? `<p class="mv-form-footer">${footer}</p>` : ''}</div>`;
    }
    const note = (text, tone) => (text ? `<div class="mv-form-row mv-callout${tone ? ' is-' + tone : ''}"><i class="ph-fill ${tone === 'danger' ? 'ph-warning-octagon' : tone === 'warn' ? 'ph-warning' : 'ph-info'}"></i><span>${text}</span></div>` : '');
    const spinnerBlock = (title, sub) => `<div class="mv-empty"><i class="ph-bold ph-spinner-gap mv-spin mv-empty-ic"></i><b>${title}</b>${sub ? `<p>${sub}</p>` : ''}</div>`;
    const emptyBlock = (icon, title, sub) => `<div class="mv-empty"><i class="${icon} mv-empty-ic"></i><b>${title}</b>${sub ? `<p>${sub}</p>` : ''}</div>`;
    const slider = (act, value, min, max) =>
        `<div class="mv-form-row as-slider"><span class="as-a is-small">A</span>
          <input type="range" min="${min}" max="${max}" step="5" value="${value}" data-as-input="${act}" data-as-change="${act}" aria-label="${fa(value)}٪">
          <span class="as-a">A</span><span class="as-value" data-as-slider-val="${act}">${fa(value)}٪</span></div>`;
    const footerText = (t) => String(t).split('\n\n').map((p) => esc(p).replace(/\n/g, '<br>')).join('<br><br>');
    /** A percentage slider with its own label above it — for settings that are not text size. */
    const pctRow = (act, title, sub, value, min, max) =>
        `<div class="mv-form-row as-pct">${label(title, sub)}
          <div class="as-pct-line"><input type="range" min="${min}" max="${max}" step="5" value="${value}"
             data-as-input="${act}" data-as-change="${act}" aria-label="${esc(title)}">
            <span class="as-value" data-as-slider-val="${act}">${fa(value)}٪</span></div></div>`;

    // ── Panes and their pages ─────────────────────────────────────────────────────────────
    // A pane is its root (Android's group) plus pages it pushes. The stack is per pane and goes
    // back to the root whenever the pane is shown again, as System Settings does.
    const PANES = {};
    const stacks = {};
    function define(id, def) {
        PANES[id] = Object.assign({ pages: {}, actions: {}, switches: {}, changes: {}, inputs: {} }, def);
        stacks[id] = [];
    }
    const paneEl = (id) => $('panel-set-' + id);
    const isShown = (id) => { const el = paneEl(id); return !!el && el.style.display !== 'none'; };
    // Latin runs (an account's e-mail, "V2Ray", "MTU") keep Latin digits in the title bar.
    function setTitle(t) {
        const el = $('mv-set-title');
        if (el) el.innerHTML = esc(t).replace(/[A-Za-z0-9@._+\-]*[A-Za-z@][A-Za-z0-9@._+\-]*/g, (m) => `<span class="mv-tech-digits" dir="ltr">${m}</span>`);
    }
    function topOf(id) { const s = stacks[id]; return s[s.length - 1] || null; }

    function render(id) {
        const el = paneEl(id), P = PANES[id];
        if (!el || !P) return;
        rescuePicker();
        const top = topOf(id);
        const pg = top && P.pages[top.page];
        let html;
        try { html = pg ? backRow(id) + pg.html(top.arg) : P.root(); }
        catch (e) { console.error('[settings]', id, e); html = section(null, note('این بخش نمایش داده نشد: ' + esc(e.message), 'danger')); }
        // Keep the scroll position when the same page repaints (a switch, a finished request).
        const scroller = el.closest('.mv-pane-scroll');
        const keep = scroller ? scroller.scrollTop : 0;
        el.innerHTML = html;
        if (scroller) scroller.scrollTop = keep;
        if (isShown(id)) setTitle(pg ? pg.title(top.arg) : P.title);
        const after = pg ? pg.after : P.after;
        if (after) { try { after(el, top && top.arg); } catch (e) { console.error('[settings]', id, e); } }
    }
    function toTop(id) { const el = paneEl(id); const sc = el && el.closest('.mv-pane-scroll'); if (sc) sc.scrollTop = 0; }
    function push(id, page, arg) {
        stacks[id].push({ page, arg });
        const pg = PANES[id].pages[page];
        if (pg && pg.open) pg.open(arg);
        render(id);
        toTop(id);
    }
    function pop(id) {
        const top = stacks[id].pop();
        const pg = top && PANES[id].pages[top.page];
        if (pg && pg.close) pg.close(top.arg);
        render(id);
        toTop(id);
    }
    function backRow(id) {
        const s = stacks[id];
        const prev = s.length > 1 ? s[s.length - 2] : null;
        const parent = prev ? PANES[id].pages[prev.page].title(prev.arg) : PANES[id].title;
        return `<div class="as-back is-wide"><button type="button" class="as-back-btn" data-as="back"><i class="ph-bold ph-caret-right"></i><span>${esc(parent)}</span></button></div>`;
    }
    const repaint = (id) => { if (paneEl(id)) render(id); };

    function wire(id) {
        const el = paneEl(id);
        if (!el || el.__asWired) return;
        el.__asWired = true;
        const P = () => PANES[id];
        el.addEventListener('click', (e) => {
            const t = e.target.closest('[data-as]');
            if (!t || !el.contains(t) || t.disabled) return;
            if (t.dataset.as === 'back') { pop(id); return; }
            const fn = P().actions[t.dataset.as];
            if (fn) fn(t.dataset.arg, t, e);
        });
        el.addEventListener('mv-change', (e) => {
            const k = e.target.dataset && e.target.dataset.asSwitch;
            const fn = k && P().switches[k];
            if (fn) fn(e.detail.checked, e.target);
        });
        el.addEventListener('change', (e) => {
            const k = e.target.dataset && e.target.dataset.asChange;
            const fn = k && P().changes[k];
            if (fn) fn(e.target.value, e.target);
        });
        el.addEventListener('input', (e) => {
            const k = e.target.dataset && e.target.dataset.asInput;
            if (!k) return;
            if (e.target.type === 'range') {
                const v = el.querySelector(`[data-as-slider-val="${k}"]`);
                if (v) v.textContent = fa(e.target.value) + '٪';
            }
            const fn = P().inputs[k];
            if (fn) fn(e.target.value, e.target);
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.matches('input[data-as-change]:not([type="range"])')) e.target.blur();
        });
        // Shown again (the sidebar, the ‹ › history, another window's link): back to the root,
        // freshly read.
        new MutationObserver(() => {
            const shown = el.style.display !== 'none';
            if (shown && !el.__asShown) {
                el.__asShown = true;
                while (stacks[id].length) pop(id);
                render(id);
                if (P().show) P().show();
            } else if (!shown && el.__asShown) {
                el.__asShown = false;
                if (P().hide) P().hide();
            }
        }).observe(el, { attributes: true, attributeFilter: ['style'] });
    }

    // The desktop's wallpaper picker is mounted once by shell/apps.js and moved to wherever the
    // «تصویر زمینه» page is; before a pane repaints it goes back to its holder, so innerHTML never
    // destroys it.
    function rescuePicker() {
        const picker = document.querySelector('.mv-wp-picker');
        const holder = $('mv-set-wallpaper-slot');
        if (picker && holder && picker.parentNode !== holder) holder.appendChild(picker);
    }

    // =====================================================================================
    // 1 · The Cloudflare account card (sidebar) and «منابع حساب»
    // =====================================================================================
    function cfAccounts() {
        try {
            const a = JSON.parse(store.get('cf_accounts', '[]'));
            return Array.isArray(a) ? a.filter((x) => x && x.token) : [];
        } catch (e) { return []; }
    }
    const accName = (a) => (a && (a.name || a.email)) || 'حساب';
    const credOf = (a) => ({ token: a.token, email: a.email || '' });

    function renderAccountCard() {
        const btn = $('btn-set-account');
        if (!btn) return;
        const accs = cfAccounts();
        const p = accs[0];
        const title = p ? accName(p) : 'حساب کلادفلر وصل نیست';
        const sub = !p ? 'برای ساخت سرور شخصی وارد شوید' : (p.email && p.email !== title ? p.email : 'کلادفلر، ورکرها و بیشتر');
        const initial = p ? String(accName(p)).trim().charAt(0).toUpperCase() : '';
        btn.innerHTML = `<span class="as-avatar">${initial ? esc(initial) : '<i class="ph-fill ph-cloud"></i>'}</span>
          <span class="as-acc-text"><b dir="auto"${p ? ' class="mv-tech-digits"' : ''}>${esc(title)}</b><small dir="auto"${p && p.email === sub ? ' class="mv-tech-digits"' : ''}>${esc(sub)}</small>
          ${accs.length ? `<small class="as-acc-count">${fa(accs.length)} حساب</small>` : ''}</span>`;
        btn.dataset.kw = 'cloudflare account حساب کلادفلر کلودفلر ابری ' + accs.map((a) => accName(a) + ' ' + (a.email || '')).join(' ');
    }

    const cf = { over: {}, lists: {}, select: null, confirm: null, busy: false };
    const KINDS = {
        workers: { title: 'وورکرها', of: 'وورکرهای', icon: 'ph-fill ph-cpu', tint: 'var(--mv-orange)' },
        d1: { title: 'پایگاه‌داده‌های D1', of: 'D1 های', icon: 'ph-fill ph-database', tint: 'var(--mv-blue)' },
        kv: { title: 'فضاهای KV', of: 'KV های', icon: 'ph-fill ph-key', tint: 'var(--mv-purple, #AF52DE)' },
    };

    async function cfLoadOverview() {
        const accs = cfAccounts();
        cf.over = {};
        repaint('cf');
        for (const a of accs) {           // one account after another: Cloudflare limits per account
            cf.over[a.id] = { loading: true };
            repaint('cf');
            const d = await api('/api/cf/overview', { account: credOf(a) });
            cf.over[a.id] = d.error ? { error: d.error } : d;
            repaint('cf');
        }
    }
    function cfCount(a, kind) {
        const o = cf.over[a.id];
        if (!o || o.loading) return '<i class="ph-bold ph-spinner-gap mv-spin as-mini-spin"></i>';
        if (o.error || o[kind] < 0) return '—';
        return fa(o[kind]);
    }

    function cfListKey(kind, i) { return kind + ':' + i; }
    async function cfLoadList(kind, i) {
        const a = cfAccounts()[i];
        const key = cfListKey(kind, i);
        if (!a) return;
        cf.lists[key] = { loading: true };
        repaint('cf');
        const d = await api('/api/cf/list', { account: credOf(a), kind });
        cf.lists[key] = d.error ? { error: d.error } : { data: d, keys: {} };
        repaint('cf');
        // KV: the key count per namespace, after the list is on screen (as on Android).
        if (kind === 'kv' && !d.error) {
            for (const ns of d.items || []) {
                const cur = cf.lists[key];
                if (!cur || !cur.data) return;
                cur.keys[ns.id] = { loading: true };
                repaint('cf');
                const k = await api('/api/cf/kv-keys', { account: credOf(a), id: ns.id });
                if (cf.lists[key] === cur) cur.keys[ns.id] = k.error ? { error: true } : k;
                repaint('cf');
            }
        }
    }

    function cfItemSub(kind, it, list) {
        if (kind === 'workers') {
            const s = list.data.statsAvailable
                ? `${fa(it.requests || 0)} درخواست · ${fa(it.errors || 0)} خطا · ${fa((it.cpu || 0).toFixed(1))} میلی‌ثانیه`
                : 'آمار ۲۴ ساعت گذشته در دسترس نیست — توکن این حساب اجازهٔ خواندن آمار را ندارد';
            return s + (it.modifiedOn ? ' · ' + when(Date.parse(it.modifiedOn)) : '');
        }
        if (kind === 'd1') {
            return `${fa(it.tables || 0)} جدول · ${bytes(it.sizeBytes || 0)}${it.createdAt ? ' · ' + when(Date.parse(it.createdAt)) : ''}`;
        }
        const k = list.keys[it.id];
        if (!k || k.loading) return 'در حال شمردن کلیدها…';
        if (k.error) return 'تعداد کلیدها خوانده نشد';
        return `${fa(k.count)}${k.more ? '+' : ''} کلید`;
    }

    define('cf', {
        title: 'منابع کلادفلر',
        show() { renderAccountCard(); cfLoadOverview(); },
        root() {
            const accs = cfAccounts();
            if (!accs.length) {
                return `<div class="mv-form-hero is-wide">${tile('ph-fill ph-cloud', '#F38020')}
                  <div><h2>حساب کلادفلر وصل نیست</h2><p>اول از صفحهٔ «ابری» یک حساب رایگان کلادفلر وصل کنید.</p></div>
                  <button type="button" class="mv-btn" data-as="cloud">باز کردن صفحهٔ ابری</button></div>`;
            }
            const p = accs[0];
            // Names are the user's own (often the e-mail): Latin digits, direction by content.
            const nameHtml = (a) => `<span dir="auto" class="mv-tech-digits">${esc(accName(a))}</span>`;
            const emailSub = (a) => (a.email && a.email !== accName(a) ? `<span dir="ltr">${esc(a.email)}</span>` : '');
            const perKind = (kind) => section(KINDS[kind].title,
                accs.map((a, i) => linkRow({ act: 'list', arg: cfListKey(kind, i), icon: KINDS[kind].icon, tint: KINDS[kind].tint, title: nameHtml(a), value: cfCount(a, kind) })).join(''));
            const failed = accs.map((a) => cf.over[a.id]).filter((o) => o && o.error);
            return `<div class="mv-form-hero is-wide"><span class="as-avatar is-big">${esc(String(accName(p)).trim().charAt(0).toUpperCase())}</span>
                <div><h2>${nameHtml(p)}</h2><p>${emailSub(p) || 'کلادفلر، ورکرها و بیشتر'}</p></div></div>
              ${section('حساب‌های متصل',
                accs.map((a) => `<div class="mv-form-row"><span class="as-avatar is-row">${esc(String(accName(a)).trim().charAt(0).toUpperCase())}</span>${label(nameHtml(a), emailSub(a))}</div>`).join('')
                + linkRow({ act: 'cloud', icon: 'ph-fill ph-cloud', tint: '#F38020', title: 'مدیریت در صفحهٔ ابری' }),
                failed.length ? `کلادفلر درخواست را رد کرد. ممکن است توکن اجازهٔ خواندن این منبع را نداشته باشد. (${esc(failed[0].error)})` : '')}
              ${perKind('workers')}${perKind('d1')}${perKind('kv')}
              <p class="mv-form-footer is-wide">هر چیزی که این برنامه روی حساب کلادفلر شما ساخته است. آمار مربوط به ۲۴ ساعت گذشته است.</p>`;
        },
        actions: {
            cloud: () => openCloud(),
            list: (arg) => push('cf', 'list', arg),
            'cf-select': () => { cf.select = cf.select ? null : new Set(); cf.confirm = null; repaint('cf'); },
            'cf-all': (arg) => {
                const [kind, i] = arg.split(':');
                const l = cf.lists[cfListKey(kind, i)];
                const ids = ((l && l.data && l.data.items) || []).map((x) => x.id);
                if (!cf.select) cf.select = new Set();
                if (cf.select.size === ids.length) cf.select.clear(); else ids.forEach((x) => cf.select.add(x));
                repaint('cf');
            },
            'cf-toggle': (id) => { if (!cf.select) return; if (cf.select.has(id)) cf.select.delete(id); else cf.select.add(id); repaint('cf'); },
            'cf-copy': (id) => copy(id),
            'cf-del-one': (id, t) => { cf.confirm = { ids: [id], one: true, name: t.dataset.name || id }; repaint('cf'); },
            'cf-del-selected': () => { if (cf.select && cf.select.size) { cf.confirm = { ids: [...cf.select] }; repaint('cf'); } },
            'cf-del-all': (arg) => {
                const [kind, i] = arg.split(':');
                const l = cf.lists[cfListKey(kind, i)];
                const ids = ((l && l.data && l.data.items) || []).map((x) => x.id);
                if (ids.length) { cf.confirm = { ids, all: true }; repaint('cf'); }
            },
            'cf-no': () => { cf.confirm = null; repaint('cf'); },
            'cf-yes': async (arg) => {
                const [kind, i] = arg.split(':');
                const a = cfAccounts()[Number(i)];
                const c = cf.confirm;
                if (!a || !c || cf.busy) return;
                cf.busy = true; repaint('cf');
                const d = await api('/api/cf/delete', { account: credOf(a), kind, ids: c.ids });
                cf.busy = false; cf.confirm = null; cf.select = null;
                if (d.error) say('❌ ' + d.error);
                else if (d.failed && d.failed.length) say(`⚠️ ${fa(d.removed)} مورد حذف شد، ${fa(d.failed.length)} مورد ناموفق — ${d.failed[0].error}`);
                else say('✅ حذف انجام شد');
                await cfLoadList(kind, Number(i));
                cfLoadOverview();
            },
            'cf-reload': (arg) => { const [kind, i] = arg.split(':'); cfLoadList(kind, Number(i)); },
        },
        pages: {
            list: {
                title: (arg) => { const [kind, i] = arg.split(':'); return `${KINDS[kind].of} ${accName(cfAccounts()[Number(i)] || {})}`; },
                open: (arg) => { cf.select = null; cf.confirm = null; const [kind, i] = arg.split(':'); cfLoadList(kind, Number(i)); },
                close: () => { cf.select = null; cf.confirm = null; },
                html(arg) {
                    const [kind, i] = arg.split(':');
                    const acc = cfAccounts()[Number(i)];
                    // An account removed while its list was open: back, rather than an empty list
                    // that claims the account still exists.
                    if (!acc) { setTimeout(() => pop('cf'), 0); return ''; }
                    const l = cf.lists[arg] || { loading: true };
                    const K = KINDS[kind];
                    const head = `<div class="mv-form-hero is-wide">${tile(K.icon, K.tint)}<div><h2>${esc(K.of)} <span dir="auto" class="mv-tech-digits">${esc(accName(acc))}</span></h2>
                      ${kind === 'workers' && l.data && l.data.subdomain ? `<p>زیردامنه: <span dir="ltr" class="as-mono">${esc(l.data.subdomain)}.workers.dev</span></p>` : ''}</div></div>`;
                    if (l.loading) return head + section(null, spinnerBlock('در حال خواندن از کلادفلر…'), null, 'is-wide');
                    if (l.error) {
                        return head + section(null, emptyBlock('ph-bold ph-cloud-slash', kind === 'd1' ? 'لیست D1 خوانده نشد' : kind === 'kv' ? 'لیست KV خوانده نشد' : 'خطا در دریافت لیست وورکرها',
                            'کلادفلر درخواست را رد کرد. ممکن است توکن اجازهٔ خواندن این منبع را نداشته باشد.<br><span dir="auto">' + esc(l.error) + '</span>')
                            + linkRow({ act: 'cf-reload', arg, icon: 'ph-bold ph-arrow-clockwise', tint: 'var(--mv-blue)', title: 'تلاش دوباره', noChevron: true }), null, 'is-wide');
                    }
                    const items = l.data.items || [];
                    if (!items.length) {
                        const empty = kind === 'workers' ? ['هیچ وورکری یافت نشد', 'هنوز هیچ وورکری روی این حساب نصب نشده است. از صفحهٔ «ابری» یک پنل نصب کنید.']
                            : kind === 'd1' ? ['پایگاه‌داده‌ای نیست', 'پنل‌های MLM و ناهان موقع نصب یکی می‌سازند.']
                                : ['فضای KV نیست', 'پنل‌های BPB و EDG و رفع‌کنندهٔ DNS اختصاصی، هرکدام موقع نصب یکی می‌گیرند.'];
                        return head + section(null, emptyBlock(K.icon, empty[0], empty[1]), null, 'is-wide');
                    }
                    const sel = cf.select;
                    const c = cf.confirm;
                    const n = c ? c.ids.length : 0;
                    const confirmHtml = !c ? '' : note(`<b>${c.one ? (kind === 'workers' ? 'تایید حذف' : kind === 'd1' ? 'پایگاه‌داده حذف شود؟' : 'فضای KV حذف شود؟') : `حذف ${fa(n)} مورد`}</b><br>${
                        kind === 'workers' ? (c.one ? `وورکر «<span dir="ltr">${esc(c.name)}</span>» از حساب کلادفلر شما پاک می‌شود و کانفیگ‌هایی که از آن ساخته شده‌اند از کار می‌افتند.` : `${fa(n)} وورکر از حساب کلادفلر شما پاک می‌شود و کانفیگ‌هایی که از آن‌ها ساخته شده از کار می‌افتند.`)
                            : kind === 'd1' ? (c.one ? 'پایگاه‌داده و هرچه در آن است برای همیشه پاک می‌شود. هر وورکری که به آن وصل باشد موقع اجرا خطا می‌دهد.' : `${fa(n)} پایگاه‌داده و هرچه در آن‌هاست برای همیشه پاک می‌شود. وورکرهای وصل به آن‌ها موقع اجرا خطا می‌دهند.`)
                                : (c.one ? 'این فضا و همهٔ کلیدهایش برای همیشه پاک می‌شود. هر وورکری که به آن وصل باشد موقع اجرا خطا می‌دهد.' : `${fa(n)} فضای KV و همهٔ کلیدهایشان برای همیشه پاک می‌شود. وورکرهای وصل به آن‌ها موقع اجرا خطا می‌دهند.`)
                    }`, 'danger') + `<div class="mv-form-row as-btn-row"><button type="button" class="mv-btn mv-btn--danger" data-as="cf-yes" data-arg="${esc(arg)}"${cf.busy ? ' disabled' : ''}>${cf.busy ? '<i class="ph-bold ph-spinner-gap mv-spin"></i> در حال حذف…' : 'حذف'}</button>
                        <button type="button" class="mv-btn" data-as="cf-no"${cf.busy ? ' disabled' : ''}>انصراف</button></div>`;
                    const tools = `<div class="mv-form-row as-btn-row">
                        <button type="button" class="mv-btn mv-btn--sm" data-as="cf-select">${sel ? 'پایان انتخاب' : 'انتخاب'}</button>
                        ${sel ? `<button type="button" class="mv-btn mv-btn--sm" data-as="cf-all" data-arg="${esc(arg)}">${sel.size === items.length ? 'لغو انتخاب همه' : 'انتخاب همه'}</button>
                          <button type="button" class="mv-btn mv-btn--sm mv-btn--danger" data-as="cf-del-selected"${sel.size ? '' : ' disabled'}>حذف ${fa(sel.size)} مورد انتخاب‌شده</button>` : ''}
                        <span class="as-grow"></span>
                        <button type="button" class="mv-btn mv-btn--sm mv-btn--danger" data-as="cf-del-all" data-arg="${esc(arg)}">حذف همه</button></div>`;
                    const rows = items.map((it) => `<div class="mv-form-row as-item">
                        ${sel ? `<button type="button" class="as-check${sel.has(it.id) ? ' is-on' : ''}" data-as="cf-toggle" data-arg="${esc(it.id)}" aria-pressed="${sel.has(it.id)}"><i class="ph-bold ph-check"></i></button>` : tile(K.icon, K.tint)}
                        ${label(`<span dir="ltr" class="as-mono">${esc(it.name || it.id)}</span>`, cfItemSub(kind, it, l))}
                        <button type="button" class="mv-btn mv-btn--icon" data-as="cf-copy" data-arg="${esc(kind === 'workers' ? it.name : it.id)}" title="کپی"><i class="ph-bold ph-copy"></i></button>
                        ${sel ? '' : `<button type="button" class="mv-btn mv-btn--icon as-danger" data-as="cf-del-one" data-arg="${esc(it.id)}" data-name="${esc(it.name || it.id)}" title="حذف"><i class="ph-bold ph-trash"></i></button>`}
                      </div>`).join('');
                    const footer = kind === 'workers' ? 'هر وورکر یک سرور روی حساب کلادفلر شماست. حذف یک وورکر کانفیگ‌هایی را که از آن ساخته شده‌اند از کار می‌اندازد.'
                        : kind === 'd1' ? 'کلادفلر تعداد پایگاه‌داده‌های یک حساب رایگان را محدود می‌کند؛ هر پایگاه‌داده‌ای که دیگر وورکری به آن وصل نیست را می‌توانید اینجا پاک کنید.'
                            : 'کلادفلر تعداد فضاهای یک حساب رایگان را محدود می‌کند؛ هر فضایی که دیگر وورکری به آن وصل نیست را می‌توانید اینجا پاک کنید.';
                    return head + section(null, confirmHtml + tools + rows, footer, 'is-wide');
                },
            },
        },
    });

    // =====================================================================================
    // 2 · شبکه — local port, backend DNS, «رفع فیلتر کانفیگ‌ها», proxy mode, local network
    // =====================================================================================
    const net = { s: null, error: '', tls: null, note: '', portErr: '', dnsErr: '' };
    async function netLoad() {
        const [d, t] = await Promise.all([api('/api/network'), api('/api/tlsfp/status')]);
        if (d.error) net.error = d.error; else { net.s = d; net.error = ''; }
        if (!t.error && t.config) net.tls = !!(t.config.enabled && t.config.mode !== 'off');
        repaint('network');
    }
    async function netSave(patch, pageErrKey) {
        const d = await api('/api/network', patch);
        if (d.error) {
            if (pageErrKey) net[pageErrKey] = d.error; else say('❌ ' + d.error);
        } else {
            net.s = d;
            if (pageErrKey) net[pageErrKey] = '';
            net.note = d.pending ? 'ذخیره شد — روی اتصال فعلی نه؛ در اتصال بعدی اعمال می‌شود.' : 'ذخیره شد.';
        }
        repaint('network');
    }
    const dnsLabel = (v) => (!v || v === 'system' ? 'ویندوز' : v);
    const netNotRead = () => section(null, net.error ? note(esc(net.error), net.error === RESTART ? 'warn' : 'danger') : spinnerBlock('در حال خواندن…'), null, 'is-wide');

    define('network', {
        title: 'شبکه',
        show: netLoad,
        root() {
            const s = net.s;
            if (!s) return netNotRead();
            const proxyOn = s.proxyMode === 'port';
            return section(null,
                linkRow({ act: 'page', arg: 'port', icon: 'ph-fill ph-plug', tint: 'var(--mv-blue)', title: 'پورت محلی (Local Port)', value: `${s.socksPort} · ${s.httpPort}`, ltr: true })
                + linkRow({ act: 'page', arg: 'dns', icon: 'ph-fill ph-hard-drives', tint: 'var(--mv-indigo)', title: 'سرور DNS بک‌اند', value: esc(dnsLabel(s.backendDns)), ltr: s.backendDns !== 'system' })
                + switchRow({ act: 'tls', icon: 'ph-fill ph-lock-key', tint: 'var(--mv-purple, #AF52DE)', title: 'رفع فیلتر کانفیگ‌ها (کلادفلر)', sub: 'وقتی کلادفلر در دسترس است ولی کانفیگ‌ها وصل نمی‌شوند، شکل دست‌دهی TLS را عوض کن', on: net.tls !== false, disabled: net.tls === null })
                + linkRow({ act: 'page', arg: 'proxy', icon: 'ph-bold ph-arrows-left-right', tint: 'var(--mv-purple, #AF52DE)', title: 'حالت پروکسی', sub: 'یک پروکسی محلی منتشر کن که دستگاه‌های دیگر بتوانند از آن استفاده کنند', value: proxyOn ? 'روشن است' : 'خاموش' })
                + linkRow({ act: 'page', arg: 'lan', icon: 'ph-fill ph-wifi-high', tint: 'var(--mv-teal)', title: 'اتصال شبکه محلی', sub: 'دستگاه‌های دیگر می‌توانند به پروکسی متصل شوند', value: s.allowLan ? 'روشن است' : 'خاموش' })
                + linkRow({ act: 'vpn', icon: 'ph-fill ph-key', tint: 'var(--mv-green)', title: 'تنظیمات پیشرفته VPN (تونل / برنامه‌ها)' }),
                esc(net.note), 'is-wide');
        },
        actions: {
            page: (arg) => push('network', arg),
            vpn: () => { if (typeof window.switchSettingsTab === 'function') window.switchSettingsTab('tunnel'); },
            'dns-pick': (v) => netSave({ backendDns: v }, 'dnsErr'),
        },
        switches: {
            tls: async (on, el) => {
                const d = await api('/api/tlsfp/config', { enabled: on, mode: on ? 'auto' : 'off' });
                if (d.error) { el.setAttribute('aria-checked', String(!on)); say('❌ خطا در ذخیره: ' + d.error); return; }
                net.tls = !!(d.config && d.config.enabled && d.config.mode !== 'off');
                // «V2Ray پیشرفته» shows the same setting; keep its switch in step.
                const box = $('setting-tlsfp-enabled');
                if (box) box.checked = net.tls;
                const stateEl = $('tlsfp-state');
                if (stateEl) stateEl.textContent = net.tls ? 'وضعیت: فعال — fingerprint=unsafe + fragment (tlshello / 1-1)' : 'وضعیت: غیرفعال — کانفیگ‌های کلودفلر ممکن است روی نت محدود وصل نشوند';
                say(d.applied ? (on ? '✅ رفع فیلتر روشن شد و روی اتصال اعمال گردید' : '⚠️ رفع فیلتر خاموش شد و اتصال بازسازی شد') : (on ? '✅ رفع فیلتر روشن شد' : '⚠️ رفع فیلتر خاموش شد'));
            },
            proxy: (on) => netSave({ proxyMode: on ? 'port' : 'system' }),
            lan: (on) => netSave({ allowLan: on }),
        },
        changes: {
            socks: (v) => netSave({ socksPort: Number(v) }, 'portErr'),
            http: (v) => netSave({ httpPort: Number(v) }, 'portErr'),
            dns: (v) => { if (String(v).trim()) netSave({ backendDns: String(v).trim() }, 'dnsErr'); },
        },
        pages: {
            port: {
                title: () => 'پورت محلی (Local Port)',
                open: () => { net.portErr = ''; },
                html() {
                    const s = net.s;
                    if (!s) return netNotRead();
                    const field = (act, v, ph) => `<input type="number" class="mv-field as-num" value="${esc(v)}" placeholder="${ph}" dir="ltr" data-as-change="${act}" min="1025" max="65535">`;
                    return section(null,
                        `<div class="mv-form-row">${label('پورت SOCKS5', 'تونل کامل و برنامه‌هایی که SOCKS می‌خواهند')}${field('socks', s.socksPort, '20808')}</div>`
                        + `<div class="mv-form-row">${label('پورت HTTP', 'پروکسی ویندوز روی همین پورت تنظیم می‌شود')}${field('http', s.httpPort, '20809')}</div>`
                        + (net.portErr ? note(esc(net.portErr), 'danger') : '')
                        + (s.active && (s.active.socks !== s.socksPort || s.active.http !== s.httpPort) ? note(`اتصال فعلی هنوز روی ${s.active.socks} / ${s.active.http} است؛ پورت‌های جدید در اتصال بعدی اعمال می‌شوند.`, 'warn') : ''),
                        footerText(`پورت‌هایی که این برنامه روی همین کامپیوتر باز می‌کند تا برنامه‌های دیگر بتوانند ترافیکشان را از اتصال رد کنند.

با مقدارهای فعلی:
• ${s.socksPort} — پروکسی SOCKS5؛ تونل کامل و برنامه‌هایی که SOCKS می‌خواهند.
• ${s.httpPort} — پروکسی HTTP؛ پروکسی ویندوز روی همین پورت تنظیم می‌شود.

کِی لازمتان می‌شود: وقتی می‌خواهید فقط یک برنامه از اتصال رد شود نه کل ویندوز (حالت پروکسی را روشن کنید و آن برنامه را به این پورت بدهید)، یا وقتی دستگاه دیگری روی همان شبکه از اتصال این کامپیوتر استفاده کند (اتصال شبکه محلی را روشن کنید). در هر دو حالت آدرس این کامپیوتر و همین پورت را در طرف مقابل وارد می‌کنید.

همهٔ کانفیگ‌های V2Ray — و اتصال سریع، کانفیگ ایران، دامین فرانتینگ و ضد فیلتر SNI — از همین پورت‌ها استفاده می‌کنند، پس پروکسی‌ای که یک‌بار تنظیم کنید با هر کانفیگی که عوض کنید کار می‌کند.

فقط وقتی عوضشان کنید که برنامهٔ دیگری روی این کامپیوتر این پورت‌ها را گرفته باشد. اگر مقداری پذیرفته نشد، پیام خطا دلیلش را می‌گوید. تغییر در اتصال بعدی اعمال می‌شود.`));
                },
            },
            dns: {
                title: () => 'سرور DNS بک‌اند',
                open: () => { net.dnsErr = ''; },
                html() {
                    const s = net.s;
                    if (!s) return netNotRead();
                    const cur = s.backendDns;
                    const picks = [['system', 'ویندوز'], ['1.1.1.1', '1.1.1.1'], ['8.8.8.8', '8.8.8.8'], ['9.9.9.9', '9.9.9.9'], ['https://1.1.1.1/dns-query', 'Cloudflare DoH']];
                    return section(null,
                        `<div class="mv-form-row"><input type="text" class="mv-field as-text" dir="ltr" value="${esc(cur === 'system' ? '' : cur)}" placeholder="1.1.1.1  ·  https://…/dns-query" data-as-change="dns" aria-label="سرور DNS بک‌اند"></div>`
                        + `<div class="mv-form-row as-chips">${picks.map(([v, t]) => `<button type="button" class="as-chip${cur === v ? ' is-on' : ''}" data-as="dns-pick" data-arg="${esc(v)}"${v === 'system' ? '' : ' dir="ltr"'}>${esc(t)}</button>`).join('')}</div>`
                        + (net.dnsErr ? note(esc(net.dnsErr), 'danger') : ''),
                        footerText(`همان سرویسی که نام‌ها را به آدرس تبدیل می‌کند — اینجا برای نام سرورِ خودِ کانفیگ.

چه فرقی می‌کند: DNS اپراتور شما هر نامی را که می‌پرسید می‌بیند، و در بسیاری از شبکه‌ها عمداً آدرس اشتباه برمی‌گرداند — یعنی کانفیگی که از یک ورکر ساخته شده بی‌دلیلِ ظاهری وصل نمی‌شود، چون نام سرورش از اول به جای اشتباهی رفته. وقتی DNS خودتان را می‌گذارید، این ابزار از دستشان گرفته می‌شود.

«ویندوز» یعنی همان DNS خود ویندوز، مثل قبل. 1.1.1.1 (کلادفلر) تقریباً همه‌جا جواب می‌دهد. 8.8.8.8 مال گوگل است. 9.9.9.9 (Quad9) علاوه بر آن نام‌های بدافزاری شناخته‌شده را هم رد می‌کند. یک نشانی DoH (مثل https://1.1.1.1/dns-query) پرسش را رمز می‌کند، پس اپراتور نه آن را می‌بیند و نه می‌تواند جوابش را عوض کند.

وقتی یک آدرس IP بدهید، تونل کامل V2Ray هم اول همان را برای نام سایت‌ها امتحان می‌کند — اگر نود به آن برسد؛ وگرنه سراغ 8.8.8.8 و 1.1.1.1 و 9.9.9.9 می‌رود.

روی کانفیگ‌های JSON کامل (که DNS خودشان را دارند) و وقتی «DNS اختصاصی» روشن است اثری ندارد. اگر بعد از تغییر این مقدار کانفیگ‌ها وصل نشدند، یعنی آن DNS در دسترس نیست — برش گردانید به «ویندوز».`));
                },
            },
            proxy: {
                title: () => 'حالت پروکسی',
                html() {
                    const s = net.s;
                    if (!s) return netNotRead();
                    return section(null,
                        switchRow({ act: 'proxy', icon: 'ph-bold ph-arrows-left-right', tint: 'var(--mv-purple, #AF52DE)', title: 'حالت پروکسی', sub: 'یک پروکسی محلی منتشر کن که دستگاه‌های دیگر بتوانند از آن استفاده کنند', on: s.proxyMode === 'port' }),
                        footerText(`خاموش (پیش‌فرض): اتصال‌های یک‌ضربه‌ای — کانفیگ ایران، دامین فرانتینگ و ضد فیلتر SNI — پروکسی ویندوز را روشن می‌کنند، پس مرورگرها و بیشتر برنامه‌ها بدون هیچ کاری از اتصال رد می‌شوند.

روشن: پروکسی ویندوز دست نمی‌خورد و موتور فقط پورت محلی را منتشر می‌کند (${s.socksPort} و ${s.httpPort}). ترافیک فقط از برنامه‌هایی رد می‌شود که خودتان دستی به آن پورت وصلشان کرده‌اید — یا از دستگاه‌های دیگر، اگر «اتصال شبکه محلی» روشن باشد — و بقیهٔ ویندوز با اینترنت معمولی و بدون پوشش کار می‌کند.

تله‌اش: با روشن بودن این گزینه، برنامه ممکن است «متصل» به نظر برسد در حالی که مرورگر شما اصلاً از آن رد نمی‌شود. اگر روشنش کردید و فیلترشکنی قطع شد، دلیلش همین است — پروکسی بالاست ولی چیزی به آن وصل نیست.

تونل کامل به این انتخاب کاری ندارد: وقتی روشن است، کل ترافیک ویندوز از آن رد می‌شود. فهرست برنامه‌ها در «تنظیمات پیشرفته VPN» اغلب ابزار بهتری است: تونل کامل سر جایش می‌ماند و فقط برنامه‌هایی که انتخاب می‌کنید بیرون آن می‌مانند.`));
                },
            },
            lan: {
                title: () => 'شبکه محلی',
                html() {
                    const s = net.s;
                    if (!s) return netNotRead();
                    const addrs = s.allowLan && s.lan && s.lan.length
                        ? s.lan.map((a) => `<button type="button" class="mv-form-row is-action" data-as="copy-addr" data-arg="${esc(a.address + ':' + s.httpPort)}">${tile('ph-fill ph-desktop-tower', 'var(--mv-teal)')}${label(`<span dir="ltr" class="as-mono">${esc(a.address)}</span>`, `${esc(a.name)} — HTTP ${s.httpPort} · SOCKS ${s.socksPort}`)}<i class="ph-bold ph-copy as-tick"></i></button>`).join('')
                        : '';
                    return section(null,
                        switchRow({ act: 'lan', icon: 'ph-fill ph-wifi-high', tint: 'var(--mv-teal)', title: 'اتصال شبکه محلی', sub: 'دستگاه‌های دیگر می‌توانند به پروکسی متصل شوند', on: s.allowLan })
                        + addrs
                        + (s.allowLan && !addrs ? note('این کامپیوتر روی هیچ شبکه‌ای نیست که دستگاه دیگری از آن به آن برسد — به همان وای‌فای یا کابلِ دستگاه مقابل وصل شوید.', 'warn') : '')
                        + (s.allowLan ? note('پروکسی بدون رمز روی شبکه‌ی محلی باز است — فقط روی شبکه‌ای که به آن اعتماد دارید روشنش کنید. اگر ویندوز پرسید، «<span dir="ltr">Allow access</span>» را بزنید.', 'warn') : ''),
                        footerText(`روشن: پروکسی روی همهٔ رابط‌های شبکهٔ این کامپیوتر گوش می‌دهد، پس دستگاه دیگری روی همان وای‌فای یا کابل می‌تواند از اتصال این کامپیوتر استفاده کند. در آن دستگاه، آدرس محلی این کامپیوتر و پورت HTTP ${s.httpPort} (یا SOCKS ${s.socksPort}) را وارد کنید. روی هر آدرس بزنید تا کپی شود.

به چه دردی می‌خورد: گوشی، تلویزیون یا کنسولی که خودش فیلترشکن ندارد، یا کامپیوتری که ترجیح می‌دهید چیزی رویش نصب نکنید.

هزینه‌اش را صریح می‌گوییم: این پروکسی رمز ندارد. هرکسی که در آن شبکه به این کامپیوتر دسترسی داشته باشد می‌تواند از آن استفاده کند — و ترافیک او از اتصال شما بیرون می‌رود و به حساب شما نوشته می‌شود. روی شبکهٔ خانه یعنی دستگاه‌های خودتان؛ روی وای‌فای کافه، هتل، فرودگاه یا محل کار یعنی همهٔ آدم‌های آن شبکه.

خاموش (پیش‌فرض): پروکسی فقط از خودِ همین کامپیوتر در دسترس است. تغییر در اتصال بعدی V2Ray اعمال می‌شود.`));
                },
            },
        },
    });
    PANES.network.actions['copy-addr'] = (v) => copy(v);

    // =====================================================================================
    // 3 · تنظیمات پیشرفته VPN — Always-On, MTU per method, quick-connect count, routing
    // =====================================================================================
    const METHODS = [
        ['masque', 'ماسک'], ['wireguard', 'وایرگارد'], ['gool', 'وارپ در وارپ'],
        ['quick', 'اتصال سریع'], ['sni', 'ضد فیلتر SNI'], ['v2ray', 'V2Ray'], ['gst', 'تونل گوگل‌اسکریپت'],
    ];
    const LOCAL = ['quick', 'sni', 'v2ray', 'gst'];
    const methodName = (m) => (m === 'global' ? 'همهٔ روش‌ها' : (METHODS.find((x) => x[0] === m) || [m, m])[1]);
    const MODES = [
        ['all', 'همه برنامه‌ها', 'هر برنامه‌ای که به اینترنت وصل می‌شود از تونل رد می‌شود.'],
        ['allow', 'انتخابی', 'فقط برنامه‌هایی که انتخاب می‌کنید از تونل رد می‌شوند؛ بقیه مستقیم می‌روند.'],
        ['bypass', 'عدم تونل', 'همه از تونل رد می‌شوند به‌جز برنامه‌هایی که انتخاب می‌کنید — مثلاً برنامه‌های بانکی که روی VPN کار نمی‌کنند.'],
    ];
    const vpn = { sys: null, sysErr: '', probe: null, probing: false, mtuErr: '' };
    const route = { mode: 'all', chosen: new Map(), apps: [], loadingApps: false, query: '', tunnel: false, saving: false, dirty: false, note: '', loaded: false };
    let routeTimer = null;

    async function vpnLoad() {
        const [s] = await Promise.all([api('/api/system'), net.s ? null : netLoad(), routeLoad()]);
        if (s && !s.error) { vpn.sys = s; vpn.sysErr = ''; } else if (s) vpn.sysErr = s.error;
        repaint('tunnel');
    }
    async function routeLoad() {
        const d = await api('/api/app-routing');
        if (!d.error) {
            route.mode = d.mode || 'all';
            route.chosen = new Map((d.apps || []).map((a) => [a.exe, a]));
            route.tunnel = !!d.tunnel;
        }
        route.loaded = true;
    }
    async function routeLoadApps(fresh) {
        if (route.loadingApps) return;
        route.loadingApps = true;
        repaint('tunnel');
        const d = await api('/api/app-routing/apps' + (fresh ? '?fresh=1' : ''));
        route.loadingApps = false;
        if (!d.error) {
            route.apps = d.apps || [];
            for (const a of route.apps) { const c = route.chosen.get(a.exe); if (c && !c.icon) c.icon = a.icon; }
        } else say('❌ فهرست برنامه‌ها خوانده نشد: ' + d.error);
        repaint('tunnel');
    }
    // Several clicks in a row become one save — with a tunnel up, each save rebuilds it.
    function routeScheduleSave() {
        clearTimeout(routeTimer);
        routeTimer = setTimeout(routeSave, 900);
        route.note = 'در حال ذخیره…';
    }
    async function routeSave() {
        if (route.saving) { route.dirty = true; return; }
        route.saving = true;
        route.note = route.tunnel ? 'در حال اعمال روی تونل…' : 'در حال ذخیره…';
        repaint('tunnel');
        const apps = [...route.chosen.values()].map((a) => ({ exe: a.exe, name: a.name, path: a.path || '' }));
        const d = await api('/api/app-routing', { mode: route.mode, apps });
        route.saving = false;
        if (d.error) { route.note = '❌ ذخیره نشد: ' + d.error; say(route.note); }
        else {
            route.tunnel = !!d.tunnel;
            route.note = d.applied ? 'ذخیره شد و روی تونل روشن اعمال شد.' : 'ذخیره شد — در اتصال بعدیِ تونل اعمال می‌شود.';
        }
        repaint('tunnel');
        if (route.dirty) { route.dirty = false; routeSave(); }
    }
    function routeToggle(app) {
        if (route.chosen.has(app.exe)) route.chosen.delete(app.exe);
        else route.chosen.set(app.exe, { exe: app.exe, name: app.name, path: app.path, icon: app.icon });
        routeScheduleSave();
        repaint('tunnel');
    }
    const appIcon = (a, size) => (a.icon
        ? `<img src="${esc(a.icon)}" alt="" width="${size}" height="${size}" draggable="false">`
        : `<span class="tr-noicon" style="width:${size}px;height:${size}px"><i class="ph-fill ph-app-window"></i></span>`);
    const quickCount = () => { const n = parseInt(store.get('quick-server-count', ''), 10); return n >= 1 && n <= 200 ? n : 6; };
    const mtuOwn = (m) => (net.s && net.s.mtu ? net.s.mtu[m] || 0 : 0);
    const mtuDefault = () => (net.s && net.s.defaultMtu) || 1420;

    // ── «سرعت و پایداری تونل» ────────────────────────────────────────────────────────────
    // Two levers and one measurement, for the report this page exists to answer: «تونل کامل
    // مدام قطع و وصل می‌شود و کند است». The measurement is the part that settles it — the same
    // download through the tunnel and straight into the engine behind it — because a tunnel
    // that matches its own engine is not slow, the engine is, and no setting here will change
    // that. What DOES change it is the stack, which is why the lever sits next to the number.
    const STACKS = [
        ['gvisor', 'سازگار (gvisor)', 'پشتهٔ نرم‌افزاری؛ روی هر ویندوزی کار می‌کند. پیش‌فرض همیشگی برنامه.'],
        ['system', 'سریع (system)', 'بسته‌ها را به خود ویندوز می‌سپارد. روی خط‌های سریع محسوس‌تر است؛ اگر بالا نیامد خودش برنمی‌گردد.'],
        ['auto', 'خودکار', 'اول «سریع»، و اگر بالا نیامد همان لحظه با «سازگار» دوباره می‌سازد.'],
    ];
    const tunh = { busy: false, res: null, err: '', lines: [], file: '', tunnel: null, running: false, loaded: false };
    const stackName = () => (STACKS.find((x) => x[0] === (net.s && net.s.tunStack)) || STACKS[0])[1].replace(/ \(.*\)/, '');
    async function tunhLoad() {
        if (!net.s) await netLoad();
        const d = await api('/api/tun/report');
        if (d.error) tunh.err = d.error;
        else { tunh.err = ''; tunh.lines = d.lines || []; tunh.file = d.file || ''; tunh.tunnel = d.tunnel; tunh.running = !!d.running; }
        tunh.loaded = true;
        repaint('tunnel');
    }

    define('tunnel', {
        title: 'تنظیمات پیشرفته VPN',
        show: vpnLoad,
        root() {
            const sys = vpn.sys;
            const mode = MODES.find((m) => m[0] === route.mode) || MODES[0];
            const always = section(null,
                switchRow({ act: 'always', icon: 'ph-fill ph-key', tint: 'var(--mv-green)', title: 'VPN همیشه روشن (Always-On)', sub: 'با ورود به ویندوز، برنامه خودش باز می‌شود و آخرین اتصالی که روشن مانده بود را دوباره برقرار می‌کند', on: sys ? sys.alwaysOn : false, disabled: !sys })
                + (vpn.sysErr ? note(esc(vpn.sysErr), vpn.sysErr === RESTART ? 'warn' : 'danger') : '')
                + (sys && sys.alwaysOn && !sys.taskPresent ? note('کلید روشن است ولی کار زمان‌بندی‌شدهٔ ویندوز پیدا نشد (شاید از «Task Scheduler» پاک شده). یک بار خاموش و روشنش کنید.', 'warn') : ''),
                'ویندوز تنظیم «VPN همیشه روشن» ندارد؛ این کلید دو نیمهٔ آن را می‌سازد: یک کار زمان‌بندی‌شدهٔ ویندوز («MLM VPN (Always-On)») که برنامه را هنگام ورود با دسترسی مدیر باز می‌کند، و برگرداندن آخرین اتصال — V2Ray و کانفیگ‌هایش (با پراکسی سیستم یا تونل کامل)، ضد فیلتر SNI، یا ماسک، وایرگارد و وارپ در وارپ. اتصالی که خودتان قطع کنید برنمی‌گردد.');
            const conn = section('تنظیمات اتصال',
                linkRow({ act: 'page', arg: 'mtu', icon: 'ph-bold ph-sliders-horizontal', tint: 'var(--mv-blue)', title: 'MTU', value: 'برای هر روش' })
                + linkRow({ act: 'page', arg: 'tunhealth', icon: 'ph-fill ph-gauge', tint: 'var(--mv-green)', title: 'سرعت و پایداری تونل', value: stackName() })
                + linkRow({ act: 'page', arg: 'quick', icon: 'ph-fill ph-squares-four', tint: 'var(--mv-orange)', title: 'تعداد سرور اتصال سریع', value: fa(quickCount()) }));
            const routing = section('حالت‌های مسیریابی (تونل)',
                linkRow({ act: 'page', arg: 'mode', icon: route.mode === 'allow' ? 'ph-fill ph-check-circle' : route.mode === 'bypass' ? 'ph-fill ph-prohibit' : 'ph-fill ph-globe-hemisphere-east', tint: route.mode === 'allow' ? 'var(--mv-green)' : route.mode === 'bypass' ? 'var(--mv-red)' : 'var(--mv-indigo)', title: 'حالت مسیریابی', value: mode[1] })
                // The app list means nothing in «همه برنامه‌ها», so it is not offered there.
                + (route.mode !== 'all' ? linkRow({ act: 'page', arg: 'apps', icon: 'ph-fill ph-gauge', tint: 'var(--mv-purple, #AF52DE)', title: 'برنامه‌های انتخاب‌شده', value: `${fa(route.chosen.size)} برنامه` }) : '')
                // «انتخابی» with nothing selected. The panel used to show the mode and the count as
                // two neutral rows and never put them together — and taken literally that pair
                // means the tunnel carries NOTHING, which is how every engine on this machine came
                // to look broken. The rule now treats the empty list as «not set yet» and tunnels
                // everything; this says so, next to the two rows that caused the confusion.
                + (route.mode === 'allow' && !route.chosen.size
                    ? note('حالت «انتخابی» است ولی هیچ برنامه‌ای انتخاب نشده. تا وقتی لیست خالی باشد <b>کل سیستم</b> از تونل رد می‌شود — چون تونلی که هیچ‌چیز را حمل نکند به کار کسی نمی‌آید. یک برنامه اضافه کنید تا فقط همان از تونل رد شود.', 'warn')
                    : ''),
                esc(route.note || (route.tunnel ? 'تونل روشن است: هر تغییر همین حالا با چند ثانیه وصل‌شدن دوباره‌ی تونل اعمال می‌شود.' : 'روی تونل کامل اعمال می‌شود: «تونل» در V2Ray، ماسک، وایرگارد، وارپ در وارپ و تونل گوگل‌اسکریپت. با پروکسی سیستم هر برنامه خودش تصمیم می‌گیرد از پروکسی استفاده کند یا نه.')));
            return always + conn + routing;
        },
        actions: {
            page: (arg) => push('tunnel', arg),
            'mtu-method': (m) => push('tunnel', 'mtu-method', m),
            'stack-pick': async (v) => { await netSave({ tunStack: v }); repaint('tunnel'); },
            'tun-speed': async () => {
                if (tunh.busy) return;
                tunh.busy = true; tunh.res = null; tunh.err = ''; repaint('tunnel');
                const d = await api('/api/tun/diagnose', {});
                tunh.busy = false;
                if (d.error) tunh.err = d.error; else tunh.res = d;
                await tunhLoad();
            },
            'tun-refresh': () => tunhLoad(),
            'tun-copy': () => copy([tunh.file, '', ...tunh.lines].join(String.fromCharCode(10))),
            'mtu-measure': async (m) => {
                if (vpn.probing) return;
                vpn.probing = true; vpn.probe = null; repaint('tunnel');
                const d = await api('/api/network/mtu-probe', { method: m });
                vpn.probing = false; vpn.probe = Object.assign({ method: m }, d); repaint('tunnel');
            },
            'mtu-apply': async (m) => {
                const r = vpn.probe;
                if (!r || !r.inner) return;
                await netSave({ mtu: { [m]: r.inner } });
                vpn.mtuErr = '';
                repaint('tunnel');
                say(`✅ MTU ${methodName(m)}: ${fa(r.inner)}`);
            },
            'mode-pick': (m) => { if (route.mode === m) return; route.mode = m; routeScheduleSave(); if (m !== 'all' && !route.apps.length) routeLoadApps(false); repaint('tunnel'); },
            'app': (exe) => { const a = route.apps.find((x) => x.exe === exe) || route.chosen.get(exe); if (a) routeToggle(a); },
            'app-drop': (exe) => { route.chosen.delete(exe); routeScheduleSave(); repaint('tunnel'); },
            'apps-refresh': () => routeLoadApps(true),
            'apps-browse': async () => {
                const d = await api('/api/app-routing/browse', {});
                if (d.error) { say('❌ ' + d.error); return; }
                if (!d.app) return;
                if (!route.apps.some((a) => a.exe === d.app.exe)) route.apps.unshift(d.app);
                if (!route.chosen.has(d.app.exe)) routeToggle(d.app); else repaint('tunnel');
            },
        },
        switches: {
            tunlog: async (on) => { await netSave({ tunLogVerbose: on }); repaint('tunnel'); },
            always: async (on, el) => {
                el.setAttribute('aria-disabled', 'true');
                const d = await api('/api/system', { alwaysOn: on });
                if (d.error) { vpn.sysErr = d.error; say('❌ ' + d.error); } else { vpn.sys = d; vpn.sysErr = ''; say(on ? '✅ «VPN همیشه روشن» روشن شد' : '«VPN همیشه روشن» خاموش شد'); }
                repaint('tunnel');
            },
        },
        changes: {
            mtu: async (v, el) => {
                const m = el.dataset.method;
                const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
                await netSave({ mtu: { [m]: n > 0 ? n : 0 } });
                repaint('tunnel');
            },
            quick: (v, el) => {
                const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
                if (!(n >= 1)) { store.set('quick-server-count', ''); el.value = ''; }
                else { const k = Math.min(200, Math.max(1, n)); store.set('quick-server-count', String(k)); el.value = String(k); }
            },
        },
        inputs: {
            'apps-q': (v, el) => {
                route.query = v;
                const pos = el.selectionStart;
                repaint('tunnel');
                const again = paneEl('tunnel').querySelector('[data-as-input="apps-q"]');
                if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) { /* type=search */ } }
            },
        },
        pages: {
            mtu: {
                title: () => 'MTU',
                html() {
                    if (!net.s) return netNotRead();
                    const def = mtuDefault();
                    return section('یک مقدار برای هر روش',
                        METHODS.map(([m, n]) => linkRow({ act: 'mtu-method', arg: m, icon: 'ph-bold ph-sliders-horizontal', tint: 'var(--mv-blue)', title: n, value: mtuOwn(m) ? fa(mtuOwn(m)) : `${fa(net.s.mtu.global || def)} (پیش‌فرض)` })).join(''),
                        footerText(`اندازهٔ بسته‌هایی که آداپتور تونل کامل این کامپیوتر می‌پذیرد، جدا برای هر روش: ماسک، وایرگارد، وارپ در وارپ، اتصال سریع، ضد فیلتر SNI، V2Ray و تونل گوگل‌اسکریپت. خالی یعنی پیش‌فرض — ${def}، همان مقداری که تونل ویندوز همیشه داشته. برای اینکه خط خودتان اندازه‌گیری شود، در هر روش «پیدا کردن بهترین مقدار» را بزنید. اگر اتصال سالم گزارش می‌شود ولی صفحه‌های سنگین بالا نمی‌آیند، کمش کنید؛ ۱۲۸۰ تقریباً از هر مسیری رد می‌شود. محدودهٔ مجاز ۵۷۶ تا ۱۵۰۰.

روی ویندوز، تونل کامل اتصال‌های TCP را روی همین کامپیوتر باز می‌کند و از پورت موتور دوباره می‌سازد؛ پس این عدد بیشتر روی بسته‌های UDP اثر دارد — بازی، تماس صوتی و QUIC. تغییر در اتصال بعدی تونل اعمال می‌شود.`))
                        + section('همهٔ روش‌ها یکجا',
                            linkRow({ act: 'mtu-method', arg: 'global', icon: 'ph-bold ph-sliders-horizontal', tint: 'var(--mv-gray)', title: 'همهٔ روش‌ها', value: net.s.mtu.global ? fa(net.s.mtu.global) : 'خودکار' }),
                            'روی هر روشی که مقدار خودش را ندارد اعمال می‌شود. مقدار مخصوص هر روش همیشه ارجح است. خالی بگذارید تا هر روش پیش‌فرض خودش را بردارد.');
                },
            },
            'mtu-method': {
                title: (m) => methodName(m),
                open: () => { vpn.probe = null; },
                html(m) {
                    if (!net.s) return netNotRead();
                    const own = m === 'global' ? net.s.mtu.global : mtuOwn(m);
                    const ph = m === 'global' ? 'خودکار' : String(net.s.mtu.global || mtuDefault());
                    const field = `<div class="mv-form-row">${tile('ph-bold ph-sliders-horizontal', 'var(--mv-blue)')}${label('MTU')}
                        <input type="number" class="mv-field as-num" min="576" max="1500" dir="ltr" value="${own || ''}" placeholder="${esc(ph)}" data-as-change="mtu" data-method="${esc(m)}"></div>`;
                    let measure = '';
                    if (m !== 'global') {
                        const r = vpn.probe && vpn.probe.method === m ? vpn.probe : null;
                        const found = r && r.inner && !vpn.probing ? r.inner : null;
                        const text = vpn.probing ? (LOCAL.includes(m) ? '' : 'بسته‌های آزمایشی با بیت «تکه‌تکه نکن» به یک نقطهٔ ورود وارپ فرستاده می‌شود و محدوده هر بار نصف می‌شود. حدود بیست ثانیه طول می‌کشد.')
                            : !r ? (LOCAL.includes(m)
                                ? 'این روش را لازم نیست اندازه بگیرید — بزنید تا دلیلش را ببینید.'
                                : 'بسته‌هایی با اندازهٔ دقیق به یک نقطهٔ ورود وارپ می‌فرستد تا بزرگترین بسته‌ای که این خط عبور می‌دهد پیدا شود، بعد سرباری که این روش دور هر بسته می‌پیچد را کم می‌کند. لازم نیست موتور وصل باشد، ولی تونل کامل باید خاموش باشد — بسته‌های آزمایشی از داخل آن رد نمی‌شوند.')
                                : r.error ? '❌ ' + esc(r.error)
                                    : r.localTermination ? 'این روش اتصال‌ها را روی خود همین کامپیوتر تمام می‌کند و از طریق پورت محلی موتور دوباره باز می‌کند، پس هیچ بسته‌ای با این MTU به شبکه نمی‌رود. ۱۵۰۰ بهترین مقدار است و چیزی برای اندازه‌گیری وجود ندارد.'
                                        : !r.inner ? 'هیچ بسته‌ای در هیچ اندازه‌ای برنگشت. این شبکه این بسته‌ها را دور می‌ریزد، پس از اینجا قابل اندازه‌گیری نیست. روی شبکهٔ دیگری امتحان کنید یا مقدار را دستی بگذارید.'
                                            : `این خط تا ${fa(r.outer)} بایت را عبور می‌دهد. پس از کسر سربار این روش، ${fa(r.inner)} برای خود تونل می‌ماند — یک بایت بیشتر، بسته‌ها به‌جای تکه‌شدن دور ریخته می‌شوند. با ${fa(r.probes)} بار آزمایش پیدا شد.`;
                        measure = section('اندازه‌گیری',
                            `<button type="button" class="mv-form-row is-action" data-as="mtu-measure" data-arg="${esc(m)}"${vpn.probing ? ' aria-busy="true"' : ''}>
                               ${tile(vpn.probing ? 'ph-bold ph-spinner-gap mv-spin' : 'ph-fill ph-gauge', 'var(--mv-blue)')}${label(vpn.probing ? 'در حال اندازه‌گیری…' : 'پیدا کردن بهترین مقدار برای این خط')}</button>`
                            + (found ? `<button type="button" class="mv-form-row is-action" data-as="mtu-apply" data-arg="${esc(m)}">${tile('ph-bold ph-check', 'var(--mv-green)')}${label(`اعمال ${fa(found)}`)}</button>` : ''),
                            text);
                    }
                    const foot = m === 'global'
                        ? 'روی هر روشی که مقدار خودش را ندارد اعمال می‌شود. مقدار مخصوص هر روش همیشه ارجح است. خالی بگذارید تا هر روش پیش‌فرض خودش را بردارد.'
                        : `اندازهٔ بسته‌هایی که این روش می‌فرستد. خالی بگذارید تا پیش‌فرض (${fa(net.s.mtu.global || mtuDefault())}) را بردارد. اگر اتصال سالم گزارش می‌شود ولی صفحه‌های سنگین بالا نمی‌آیند کمش کنید؛ برای دادهٔ بیشتر در هر بسته بالاتر ببرید، تا جایی که مسیر دیگر عبورشان ندهد — از آن نقطه به بعد هر بستهٔ بزرگ دور ریخته می‌شود و فقط درخواست‌های کوچک کار می‌کنند. محدودهٔ مجاز ۵۷۶ تا ۱۵۰۰.`;
                    return section(null, field, foot) + measure;
                },
            },
            tunhealth: {
                title: () => 'سرعت و پایداری تونل',
                open: () => { if (!tunh.loaded) tunhLoad(); },
                html() {
                    if (!net.s) return netNotRead();
                    const r = tunh.res;
                    const verdictTone = r && (r.verdict === 'tunnel-loss' || r.verdict === 'tunnel-dead') ? 'warn'
                        : r && r.verdict === 'both-dead' ? 'danger' : '';
                    const measure = section('سنجش سرعت',
                        linkRow({ act: 'tun-speed', noChevron: true, busy: tunh.busy, icon: 'ph-fill ph-speedometer', tint: 'var(--mv-green)',
                            title: tunh.busy ? 'در حال سنجش…' : 'سرعت تونل را با موتور پشتش مقایسه کن',
                            sub: 'دو دانلود پشت سر هم: یکی از داخل تونل، یکی مستقیم از خود موتور' })
                        + (tunh.err ? note(esc(tunh.err), tunh.err === RESTART ? 'warn' : 'danger') : '')
                        // The verdict is written by the server in Persian with Latin numerals
                        // (the same sentence goes into the log file, where digits have to stay
                        // greppable). Only the presentation is localised, and every decimal
                        // point in it, not just the first — faNum stops at one.
                        + (r ? note(esc(fa(String(r.note).replace(/(\d)\.(\d)/g, '$1٫$2'))), verdictTone) : ''),
                        'هر دو دانلود از یک آدرس و با یک روش شمرده می‌شوند، پس عددشان با هم قابل مقایسه است — و اگر اینترنت این کامپیوتر خودش از یک وی‌پی‌ان دیگر رد می‌شود، هر دو از زیر آن رد می‌شوند و مقایسه همچنان درست می‌ماند. تونلی که خیلی کمتر از موتور خودش بدهد یعنی افت در لایهٔ تونل است؛ نزدیک بودنشان یعنی سرعت را خود موتور تعیین می‌کند.');
                    const stack = section('پشتهٔ تونل',
                        STACKS.map(([k, t, d]) => pickRow('stack-pick', k, t, d, (net.s.tunStack || 'gvisor') === k)).join(''),
                        'تونل کامل بسته‌های ویندوز را می‌گیرد و باید TCP آن‌ها را جایی سر هم کند. «سازگار» این کار را خودش در نرم‌افزار انجام می‌دهد — همان چیزی که تا امروز همیشه استفاده شده — و «سریع» آن را به خود ویندوز می‌سپارد. تغییر در اتصال بعدی تونل اعمال می‌شود؛ بعد از تغییر یک بار «سنجش سرعت» را بزنید تا تفاوت را روی خط خودتان ببینید.');
                    const logs = section('لاگ',
                        switchRow({ act: 'tunlog', icon: 'ph-fill ph-list-magnifying-glass', tint: 'var(--mv-orange)', title: 'لاگ دقیق تونل', sub: 'نام تک‌تک اتصال‌ها و پرس‌وجوهای DNS در لاگ', on: !!net.s.tunLogVerbose }),
                        'برای وقتی که تونل وصل است ولی چیزی رد نمی‌شود: هر اتصال با مسیری که گرفته در لاگ می‌آید. سنگین است — روی یک ماشین شلوغ دقیقه‌ای هزاران خط، و همان خط‌ها خودشان از سرعت تونل کم می‌کنند — پس بعد از پیدا کردن مشکل خاموشش کنید.');
                    const evLines = tunh.lines.slice(-14);
                    const events = section('آخرین رویدادهای تونل',
                        (evLines.length
                            // One element per line, each with its own direction: the lines are
                            // key=value (Latin) with a Persian sentence after «::», and one shared
                            // `dir` on the block would scramble whichever half it is not.
                            ? `<div class="mv-form-row" style="display:block"><div style="max-height:230px;overflow:auto;font:11px/1.7 ui-monospace,Consolas,monospace;color:var(--mv-label-2)">${evLines.map((l) => `<div dir="auto" style="white-space:pre-wrap;word-break:break-word">${esc(l)}</div>`).join('')}</div></div>`
                            : `<div class="mv-form-row">${label('هنوز چیزی ثبت نشده — بعد از روشن کردن تونل کامل پر می‌شود.')}</div>`)
                        + linkRow({ act: 'tun-refresh', noChevron: true, icon: 'ph-bold ph-arrow-clockwise', tint: 'var(--mv-gray)', title: 'خواندن دوباره' })
                        + (evLines.length ? linkRow({ act: 'tun-copy', noChevron: true, icon: 'ph-bold ph-copy', tint: 'var(--mv-blue)', title: 'کپی برای فرستادن' }) : ''),
                        footerText(`هر بار که تونل روشن، خاموش یا دوباره ساخته می‌شود یک خط با علتش این‌جا ثبت می‌شود، و هر دقیقه یک خط سرعت — که از بایت‌های واقعیِ همان تونل خوانده می‌شود و هیچ حجمی مصرف نمی‌کند. «stall» یعنی تونل بالا بوده و چند ثانیه هیچ بایتی رد نشده؛ همان چیزی که از بیرون «قطع شد» دیده می‌شود.

این فهرست بعد از بستن برنامه هم می‌ماند: ${tunh.file || '~/.mlmvpn/tunnel-events.log'}`));
                    return measure + stack + logs + events;
                },
            },
            quick: {
                title: () => 'تعداد سرور اتصال سریع',
                html() {
                    const raw = store.get('quick-server-count', '');
                    return section(null,
                        `<div class="mv-form-row">${tile('ph-fill ph-squares-four', 'var(--mv-orange)')}${label('تعداد سرور اتصال سریع')}
                          <input type="number" class="mv-field as-num" min="1" max="200" dir="ltr" value="${esc(raw)}" placeholder="6" data-as-change="quick"></div>`,
                        'دکمهٔ «اتصال» در «اتصال سریع» سرورها را می‌سنجد تا این تعداد سرور سالم پیدا شود، بعد سریع‌ترینشان را انتخاب و متصل می‌کند. عدد کمتر یعنی اتصال زودتر؛ عدد بیشتر یعنی انتخاب از میان سرورهای بیشتر. خالی یعنی ۶، مثل قبل. از ۱ تا ۲۰۰.');
                },
            },
            mode: {
                title: () => 'حالت مسیریابی',
                html() {
                    return section(null, MODES.map(([k, t, d]) => pickRow('mode-pick', k, t, d, route.mode === k)).join(''),
                        'نام سایت‌ها (DNS) برای همه از تونل پیدا می‌شود؛ فقط خود اتصال برنامه‌ها مسیرش را از این انتخاب می‌گیرد.');
                },
            },
            apps: {
                title: () => 'برنامه‌های انتخاب‌شده',
                open: () => { if (!route.apps.length) routeLoadApps(false); },
                html() {
                    const q = route.query.trim().toLowerCase();
                    const visible = route.apps.filter((a) => !q || String(a.name).toLowerCase().includes(q) || a.exe.includes(q));
                    const chosen = [...route.chosen.values()];
                    const verb = route.mode === 'allow' ? 'از تونل رد می‌شوند' : 'از تونل رد نمی‌شوند';
                    const chips = chosen.length
                        ? `<div class="tr-chips">${chosen.map((a) => `<span class="tr-chip">${appIcon(a, 20)}<span dir="auto">${esc(a.name)}</span><button type="button" data-as="app-drop" data-arg="${esc(a.exe)}" aria-label="برداشتن ${esc(a.name)}"><i class="ph-bold ph-x"></i></button></span>`).join('')}</div>`
                        : `<div class="mv-form-row"><span class="mv-form-label" style="color:var(--mv-label-2)">${route.mode === 'allow' ? 'هنوز برنامه‌ای انتخاب نشده — در این حالت یعنی هیچ برنامه‌ای از تونل رد نمی‌شود.' : 'هنوز برنامه‌ای انتخاب نشده — همه از تونل رد می‌شوند.'}</span></div>`;
                    const grid = route.loadingApps && !route.apps.length
                        ? spinnerBlock('در حال خواندن برنامه‌ها…', 'از منوی استارت و برنامه‌های در حال اجرا.')
                        : visible.length ? `<div class="tr-grid">${visible.map((a) => {
                            const on = route.chosen.has(a.exe);
                            return `<button type="button" class="tr-app${on ? ' is-on' : ''}" data-as="app" data-arg="${esc(a.exe)}" aria-pressed="${on}" title="${esc(a.path || a.exe)}">
                                <span class="tr-ic">${appIcon(a, 32)}${a.running ? '<i class="tr-live" title="در حال اجرا"></i>' : ''}</span>
                                <span class="tr-txt"><b dir="auto">${esc(a.name)}</b><small dir="ltr">${esc(a.exe)}</small></span>
                                <span class="tr-check"><i class="ph-bold ph-check"></i></span></button>`;
                        }).join('')}</div>`
                            : emptyBlock('ph-bold ph-app-window', q ? 'چیزی پیدا نشد' : 'برنامه‌ای پیدا نشد', 'برنامه‌ای در فهرست نیست؟ یک‌بار اجرایش کنید و «خواندن دوباره» را بزنید، یا با «افزودن برنامه‌ی دیگر…» فایل exe آن را انتخاب کنید.');
                    return section(`${fa(chosen.length)} برنامه ${verb}`, chips, null, 'is-wide')
                        + `<div class="mv-form-section is-wide"><div class="tr-head">
                            <label class="tr-search"><i class="ph ph-magnifying-glass"></i><input type="search" placeholder="جستجوی برنامه..." value="${esc(route.query)}" data-as-input="apps-q" aria-label="جستجوی برنامه"></label>
                            <button type="button" class="mv-btn mv-btn--sm" data-as="apps-refresh" title="خواندن دوباره‌ی فهرست"><i class="ph-bold ph-arrow-clockwise"></i></button>
                            <button type="button" class="mv-btn mv-btn--sm" data-as="apps-browse">افزودن برنامه‌ی دیگر…</button></div>
                          <div class="mv-form-group">${grid}</div>
                          <p class="mv-form-footer">${esc(route.note) || 'برنامه‌ها از منوی استارت و برنامه‌های در حال اجرا (<i class="tr-live" style="position:static;display:inline-block"></i>) خوانده می‌شوند. برنامه‌های فروشگاه مایکروسافت وقتی در حال اجرا باشند در فهرست می‌آیند. موتورهای خود برنامه (Xray، وارپ، sing-box) در این فهرست نیستند، چون فرستادن ترافیک موتور به خودش تونل را از کار می‌اندازد.'}</p></div>`;
                },
            },
        },
    });

    // =====================================================================================
    // 4 · صفحه نمایش — Android's display page, the realtime-traffic switch, the language
    // =====================================================================================
    const disp = { text: null, textErr: '', gpu: null };
    async function dispLoad() {
        const d = await api('/api/display');
        if (!d.error) disp.text = d;
        // Whether this machine is drawing on the GPU, and whether the APP decided that rather
        // than the user. See startup-health.js: two launches that never reached a desktop turn
        // acceleration off by themselves, and this row is the only way back.
        try { const g = await api('/api/display/gpu'); if (!g.error) disp.gpu = g; } catch (e) {}
        repaint('appearance');
    }
    // A saved checkbox the rest of the app reads (settings.js › SETTINGS_SAVED), driven from a
    // switch that says it the Android way round («نمایش…» rather than «غیرفعال…»).
    function mirror(id) { const el = $(id); return el ? !el.checked : true; }
    function setMirror(id, on) {
        const el = $(id);
        if (!el) return;
        el.checked = !on;
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    const themeName = (k) => ({ auto: 'خودکار', light: 'روشن', dark: 'تاریک' }[k] || 'تاریک');
    const langName = (k) => ({ auto: 'زبان سیستم', fa: 'فارسی', en: 'English' }[k] || 'فارسی');
    let dispTimer = null;

    define('appearance', {
        title: 'صفحه نمایش',
        show: dispLoad,
        root() {
            const shell = shellOn() && window.MV && MV.displayPrefs;
            const dp = shell ? MV.displayPrefs.get() : null;
            const pref = (window.MV && MV.appearance && MV.appearance.preferred) || 'dark';
            const t = disp.text || { textAuto: true, textScale: 100 };
            let html = section(null,
                (shell && MV.wallpaper ? linkRow({ act: 'page', arg: 'wallpaper', icon: 'ph-fill ph-palette', tint: 'var(--mv-pink, #FF2D55)', title: 'تصویر زمینه', value: esc(MV.wallpaper.name()) }) : '')
                + linkRow({ act: 'page', arg: 'theme', icon: 'ph-fill ph-circle-half', tint: 'var(--mv-indigo)', title: 'ظاهر برنامه', value: themeName(pref) }));
            if (shell) {
                const sample = (MV.apps.home() || []).map((id) => MV.apps.get(id)).filter(Boolean).slice(0, 4);
                html += section('اندازه آیکون',
                    `<div class="mv-form-row as-sample">${sample.map((a) => `<span class="as-sample-app">${MV.apps.iconHTML(a, Math.round(56 * dp.iconScale / 100))}<span class="as-sample-label" style="font-size:${(12 * dp.labelScale / 100).toFixed(1)}px">${esc(MV.apps.label(a))}</span></span>`).join('')}</div>`
                    + slider('icon', dp.iconScale, 60, 140),
                    'فقط خود آیکون‌های میزکار را بزرگ و کوچک می‌کند؛ نوشته‌ها و فاصله‌ها ثابت می‌مانند.');
            }
            if (disp.gpu) {
                html += section('شتاب‌دهندهٔ گرافیکی',
                    switchRow({ act: 'gpu', icon: 'ph-fill ph-graphics-card', tint: 'var(--mv-purple, #AF52DE)',
                        title: 'کشیدن صفحه با کارت گرافیک',
                        sub: 'روشن، برنامه را روان‌تر می‌کند. اگر پنجرهٔ برنامه سیاه بماند یا تصویری نیاید، خاموشش کنید — کمی کندتر کشیده می‌شود ولی روی هر سیستمی کار می‌کند.',
                        on: !disp.gpu.gpuOff }),
                    'تغییر این گزینه از <b>اجرای بعدی</b> برنامه اعمال می‌شود؛ ویندوز اجازه نمی‌دهد وسط کار عوض شود. همین کلید در منوی <b>راست‌کلیک روی آیکون برنامه کنار ساعت ویندوز</b> هم هست — برای وقتی که پنجره سیاه مانده و همین صفحه دیده نمی‌شود.');
            }
            html += section('اندازه متن',
                switchRow({ act: 'text-auto', icon: 'ph-bold ph-text-aa', tint: 'var(--mv-blue)', title: 'اندازه متن پیش‌فرض سیستم', sub: 'از مقیاس نمایشگری که در تنظیمات خود ویندوز تعیین کرده‌اید پیروی می‌کند.', on: t.textAuto, disabled: !disp.text })
                // Hidden rather than dimmed while the system decides: a control that cannot do
                // anything is worse than none (Android's rule).
                + (!t.textAuto ? slider('text', t.textScale, 60, 140) : '')
                + (disp.textErr ? note(esc(disp.textErr), 'danger') : ''),
                t.textAuto ? '' : 'اندازه همه متن‌های برنامه، از جمله خود تنظیمات، را تغییر می‌دهد.');
            if (shell) {
                html += section('اندازه عنوان آیکون‌ها', slider('label', dp.labelScale, 60, 140),
                    'عنوان زیر آیکون‌های میزکار و داک را، علاوه بر اندازه سراسری، تنظیم می‌کند.');
                html += section('تصویر زمینه',
                    switchRow({ act: 'dock-labels', icon: 'ph-fill ph-tag', tint: 'var(--mv-purple, #AF52DE)', title: 'نمایش عنوان آیکون‌های داک', sub: 'نام هر برنامه را زیر آیکونش در داک نشان می‌دهد (بزرگ‌نمایی داک در این حالت خاموش است).', on: dp.dockLabels })
                    + switchRow({ act: 'wall-tint', icon: 'ph-fill ph-stack', tint: 'var(--mv-teal)', title: 'تصویر زمینه در همه صفحات', sub: 'رنگِ تصویر زمینه، کم‌رنگ، روی پنجره‌ها هم می‌نشیند. خاموش کنید تا همهٔ پنجره‌ها پس‌زمینهٔ ساده داشته باشند و فقط میزکار تصویر را نشان دهد.', on: dp.wallpaperTint })
                    + (MV.hero ? linkRow({ act: 'page', arg: 'hero', icon: 'ph-fill ph-image-square', tint: 'var(--mv-orange)', title: 'زمینهٔ سربرگ اتصال', value: esc(MV.hero.name()) }) : ''));
            }
            html += section(null,
                switchRow({ act: 'realtime', icon: 'ph-fill ph-chart-line-up', tint: 'var(--mv-orange)', title: 'نمایش ترافیک لحظه‌ای در هدر', sub: 'سرعت آپلود و دانلود در بالای صفحه', on: mirror('setting-disable-live-speed') })
                + linkRow({ act: 'page', arg: 'language', icon: 'ph-bold ph-translate', tint: 'var(--mv-blue)', title: 'زبان اپلیکیشن (Language)', value: langName(store.get('mv-language', 'auto')) }));
            html += section('ویندوز',
                `<div class="mv-form-row">${label('کاهش شفافیت', 'سطح‌های شیشه‌ای مات می‌شوند. روی کارت گرافیک‌های ضعیف، برنامه روان‌تر اجرا می‌شود.')}
                   <span class="mv-switch mv-switch--mini" role="switch" tabindex="0" aria-checked="${!!(window.MV && MV.prefs.reduceTransparency)}" data-mv-pref="reduceTransparency" aria-label="کاهش شفافیت"></span></div>
                 <div class="mv-form-row">${label('کاهش حرکت', 'جابه‌جایی پنجره‌ها و منوها به محو شدن ساده تبدیل می‌شود. وقتی خاموش است، از تنظیم ویندوز پیروی می‌کند.')}
                   <span class="mv-switch mv-switch--mini" role="switch" tabindex="0" aria-checked="${!!(window.MV && MV.prefs.reduceMotion)}" data-mv-pref="reduceMotion" aria-label="کاهش حرکت"></span></div>
                 <div class="mv-form-row">${label('چیدمان قدیمی', 'به‌جای میزکار، داک و پنجره‌ها، همان چیدمان ستونی قبلی. برای وقتی که چیدمان جدید در کارتان مشکلی ایجاد کرده؛ با تغییر آن برنامه دوباره بارگذاری می‌شود.')}
                   <span class="mv-switch mv-switch--mini" role="switch" tabindex="0" aria-checked="${!!(window.MV && MV.prefs.legacyLayout)}" data-mv-pref="legacyLayout" aria-label="چیدمان قدیمی"></span></div>`);
            return html;
        },
        actions: {
            page: (arg) => push('appearance', arg),
            'theme-pick': (k) => { if (window.MV && MV.appearance) MV.appearance.set(k); repaint('appearance'); },
            'hero-mode': (k) => { if (window.MV && MV.hero) MV.hero.setMode(k); repaint('appearance'); },
            'hero-pick': () => heroPickFile(),
            'lang-pick': (k) => { store.set('mv-language', k); repaint('appearance'); },
        },
        switches: {
            'text-auto': async (on) => {
                const d = await api('/api/display', { textAuto: on });
                if (d.error) disp.textErr = d.error; else { disp.text = d; disp.textErr = ''; }
                repaint('appearance');
            },
            gpu: async (on) => {
                const d = await api('/api/display/gpu', { off: !on });
                if (!d.error) { disp.gpu = { gpuOff: d.gpuOff, fails: 0 }; say('از اجرای بعدی برنامه اعمال می‌شود.'); }
                repaint('appearance');
            },
            'dock-labels': (on) => MV.displayPrefs.set('dockLabels', on),
            'wall-tint': (on) => MV.displayPrefs.set('wallpaperTint', on),
            realtime: (on) => setMirror('setting-disable-live-speed', on),
        },
        inputs: {
            // Icon and caption sizes follow the thumb live; the text size waits for the release —
            // it reflows the whole window on every step.
            icon: (v) => { MV.displayPrefs.set('iconScale', v); resizeSample(); },
            label: (v) => { MV.displayPrefs.set('labelScale', v); resizeSample(); },
            // The hero's two follow the thumb: the whole point of these is seeing the picture change.
            'hero-dim': (v) => { if (MV.hero) { MV.hero.setNumber('dim', v); heroPrevSync(); } },
            'hero-blur': (v) => { if (MV.hero) { MV.hero.setNumber('blur', v); heroPrevSync(); } },
        },
        changes: {
            text: (v) => {
                clearTimeout(dispTimer);
                dispTimer = setTimeout(async () => {
                    const d = await api('/api/display', { textScale: Number(v) });
                    if (d.error) { disp.textErr = d.error; repaint('appearance'); } else disp.text = d;
                }, 60);
            },
        },
        pages: {
            wallpaper: {
                title: () => 'تصویر زمینه',
                html: () => section(null, '<div class="mv-form-row is-stack" data-as-wp></div>', 'پس‌زمینه را نرم می‌کند تا آیکون‌ها و نوشته‌ها خوانا بمانند — «محوی» همین کار را می‌کند. «عکس دلخواه…» یک عکس از همین کامپیوتر برمی‌دارد.', 'is-wide'),
                after(el) {
                    const host = el.querySelector('[data-as-wp]');
                    let picker = document.querySelector('.mv-wp-picker');
                    if (!picker && window.MV && MV.wallpaper) { MV.wallpaper.mountPicker($('mv-set-wallpaper-slot') || host); picker = document.querySelector('.mv-wp-picker'); }
                    if (host && picker) host.appendChild(picker);
                },
                close: () => rescuePicker(),
            },
            // The wide card behind the power button on every engine page. Two sliders and not one,
            // because «شیشه‌ای» and «خوانا» are different problems: the frost calms a busy picture,
            // the darkness is what keeps white text readable over a bright one.
            hero: {
                title: () => 'زمینهٔ سربرگ اتصال',
                html() {
                    const h = (window.MV && MV.hero) ? MV.hero.get() : null;
                    if (!h) return section(null, note('این تنظیم با چیدمان قدیمی در دسترس نیست.', 'warn'));
                    return section(null, heroPreview(h), 'همان چیزی که پشت دکمهٔ اتصال در صفحهٔ سایفون، تور، لنترن و گف دیده می‌شود.', 'is-wide')
                        + section('زمینه',
                            pickRow('hero-mode', 'gradient', 'گرادیان رنگ موتور', 'حالت پیش‌فرض — رنگ خود موتور، بدون تصویر', h.mode === 'gradient')
                            + pickRow('hero-mode', 'wall', 'تصویر زمینهٔ میزکار', 'همان تصویری که برای پشت میزکار انتخاب کرده‌اید', h.mode === 'wall')
                            + pickRow('hero-mode', 'photo', 'عکس دلخواه', h.hasPhoto ? 'عکسی که خودتان گذاشته‌اید' : 'هنوز عکسی نگذاشته‌اید', h.mode === 'photo', !h.hasPhoto)
                            + linkRow({ act: 'hero-pick', icon: 'ph-fill ph-image', tint: 'var(--mv-teal)', title: h.hasPhoto ? 'عکس دیگری بگذارید…' : 'انتخاب عکس…', sub: 'یک فایل تصویری از همین کامپیوتر', noChevron: true }))
                        + section('تنظیم تصویر',
                            pctRow('hero-dim', 'تیرگی', 'یک لایهٔ تیره روی تصویر می‌گذارد تا نوشته‌ها و دکمهٔ اتصال خوانا بمانند.', h.dim, 0, 90)
                            + pctRow('hero-blur', 'شیشه‌ای (تاری)', 'تصویر را پشت شیشهٔ مات می‌برد؛ عکس‌های شلوغ این‌طور آرام می‌شوند.', h.blur, 0, 100),
                            footerText(`اندازهٔ پیشنهادی برای عکس دلخواه: ۲۴۰۰ × ۶۰۰ پیکسل — افقی و کشیده، نسبت حدود ۴ به ۱.

سربرگ یک مستطیل پهن و کم‌ارتفاع است، پس عکس عمودی یا مربع از بالا و پایین بریده می‌شود. عکس پهن‌تر از ۲۴۰۰ پیکسل خودش کوچک می‌شود؛ عکس باریک‌تر از حدود ۱۲۰۰ پیکسل روی مانیتور بزرگ کش می‌آید و دانه‌دانه دیده می‌شود.

عکس در همین کامپیوتر ذخیره می‌شود و هیچ‌جا فرستاده نمی‌شود.`));
                },
            },
            theme: {
                title: () => 'ظاهر برنامه',
                html() {
                    const pref = (window.MV && MV.appearance && MV.appearance.preferred) || 'dark';
                    return section(null, ['auto', 'light', 'dark'].map((k) => pickRow('theme-pick', k, themeName(k), null, pref === k)).join(''),
                        'حالت خودکار از تنظیم روشن/تاریک خود ویندوز پیروی می‌کند.');
                },
            },
            language: {
                title: () => 'زبان اپلیکیشن (Language)',
                html() {
                    const cur = store.get('mv-language', 'auto');
                    return section(null,
                        pickRow('lang-pick', 'auto', 'زبان سیستم', null, cur === 'auto')
                        + pickRow('lang-pick', 'fa', 'فارسی', null, cur === 'fa')
                        + pickRow('lang-pick', 'en', 'English', 'ترجمهٔ انگلیسی رابط ویندوز هنوز کامل نشده است', false, true),
                        'فعلاً رابط برنامه روی ویندوز فقط فارسی است، پس «زبان سیستم» هم فارسی نشان می‌دهد. انگلیسی، مثل نسخهٔ اندروید، وقتی کل رابط ترجمه شد همین‌جا روشن می‌شود.');
                },
            },
        },
    });
    /** The preview strip on the «زمینهٔ سربرگ اتصال» page — the hero, in miniature. */
    function heroPreview(h) {
        const img = MV.hero.image();
        const style = `--as-hero-dim:${(h.dim / 100).toFixed(2)};--as-hero-blur:${(h.blur / 100 * 18).toFixed(1)}px`
            // SINGLE quotes inside: this whole string goes into a style="…" attribute, and a data
            // URL wrapped in double quotes closed the attribute on its first character — the
            // preview came out as a plain grey card with no picture in it.
            + (img ? `;--as-hero-img:url('${img}')` : '');
        return `<div class="mv-form-row is-stack"><div class="as-hero-prev${img ? ' is-photo' : ''}" data-as-hero style="${style}">
            <span class="as-hero-power"><i class="ph-bold ph-power"></i></span>
            <span class="as-hero-txt"><b>به دنیایی بدون محدودیت وصل شوید.</b><small>پیش‌نمایش سربرگ</small></span>
          </div></div>`;
    }
    /** Dragging a slider must not redraw the page — only the picture it is about. */
    function heroPrevSync() {
        const h = MV.hero.get();
        document.querySelectorAll('[data-as-hero]').forEach((p) => {
            p.style.setProperty('--as-hero-dim', (h.dim / 100).toFixed(2));
            p.style.setProperty('--as-hero-blur', (h.blur / 100 * 18).toFixed(1) + 'px');
        });
    }
    function heroPickFile() {
        if (!window.MV || !MV.hero) return;
        const f = document.createElement('input');
        f.type = 'file';
        f.accept = 'image/*';
        f.addEventListener('change', async () => {
            if (f.files && f.files[0]) { await MV.hero.setPhoto(f.files[0]); repaint('appearance'); }
        });
        f.click();
    }
    function resizeSample() {
        const el = paneEl('appearance');
        if (!el || !window.MV || !MV.displayPrefs) return;
        const dp = MV.displayPrefs.get();
        el.querySelectorAll('.as-sample-app .mv-ic').forEach((ic) => ic.style.setProperty('--sz', Math.round(56 * dp.iconScale / 100) + 'px'));
        el.querySelectorAll('.as-sample-label').forEach((l) => { l.style.fontSize = (12 * dp.labelScale / 100).toFixed(1) + 'px'; });
    }
    // The appearance can change from elsewhere (the menu bar, Windows itself on «خودکار»).
    function onMvChange() { if (isShown('appearance') && !topOf('appearance')) repaint('appearance'); }

    // =====================================================================================
    // 5 · مصرف — usage tracking and «مصرف کل»
    // =====================================================================================
    const usage = { data: null, error: '', timer: null };
    async function usageLoad() {
        const d = await api('/api/v2ray/traffic');
        if (d.error) usage.error = d.error; else { usage.data = d; usage.error = ''; }
        repaint('usage');
    }
    function tehranDay(offset) {
        const d = new Date(Date.now() - offset * 86400000);
        return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    }
    function periodSum(days) {
        const daily = (usage.data && usage.data.daily) || {};
        let up = 0, down = 0;
        for (let i = 0; i < days; i++) { const r = daily[tehranDay(i)]; if (r) { up += r.up || 0; down += r.down || 0; } }
        return { up, down };
    }

    define('usage', {
        title: 'مصرف',
        root() {
            return section(null,
                switchRow({ act: 'track', icon: 'ph-fill ph-pulse', tint: 'var(--mv-yellow)', title: 'ثبت و مانیتورینگ مصرف کل', sub: 'ثبت روزانه دیتای مصرفی', on: mirror('setting-disable-monitoring') })
                + linkRow({ act: 'page', arg: 'total', icon: 'ph-fill ph-chart-bar', tint: 'var(--mv-green)', title: 'مصرف کل' }))
                + section('ویندوز',
                    switchRow({ act: 'header-total', title: 'حجم مصرف امروز در نوار بالا', sub: 'و ابزارک «ترافیک امروز» روی میزکار', on: mirror('setting-disable-total-traffic') })
                    + linkRow({ act: 'monitor', title: 'مانیتور مصرف', sub: 'نمودار زندهٔ سرعت و حجم هر اتصال' }),
                    'با خاموش کردن ثبت مصرف، برنامه دیگر هر ثانیه آمار را از موتور نمی‌پرسد و روی دیسک نمی‌نویسد — روی سیستم‌های ضعیف سبک‌تر است؛ آمار قبلی سر جایش می‌ماند.');
        },
        actions: {
            page: (arg) => push('usage', arg),
            monitor: () => openWindow('monitor', () => { if (typeof window.toggleBottomPanel === 'function') window.toggleBottomPanel('monitor'); }),
        },
        switches: {
            track: (on) => setMirror('setting-disable-monitoring', on),
            'header-total': (on) => setMirror('setting-disable-total-traffic', on),
        },
        pages: {
            total: {
                title: () => 'آمار مصرف اینترنت',
                open() { usageLoad(); clearInterval(usage.timer); usage.timer = setInterval(() => { if (topOf('usage') && isShown('usage')) usageLoad(); else clearInterval(usage.timer); }, 3000); },
                close() { clearInterval(usage.timer); },
                html() {
                    if (!usage.data) return section(null, usage.error ? note(esc(usage.error), usage.error === RESTART ? 'warn' : 'danger') : spinnerBlock('در حال خواندن…'), null, 'is-wide');
                    const period = (title, p) => section(title,
                        valueRow({ icon: 'ph-bold ph-arrow-down', tint: 'var(--mv-green)', title: 'دانلود', value: bytes(p.down) })
                        + valueRow({ icon: 'ph-bold ph-arrow-up', tint: 'var(--mv-blue)', title: 'آپلود', value: bytes(p.up) })
                        + valueRow({ icon: 'ph-bold ph-arrows-down-up', tint: 'var(--mv-gray)', title: 'کل', value: bytes(p.up + p.down) }));
                    const days = [];
                    for (let i = 6; i >= 0; i--) { const r = usage.data.daily[tehranDay(i)] || { up: 0, down: 0 }; days.push({ day: tehranDay(i), total: (r.up || 0) + (r.down || 0) }); }
                    const max = Math.max(1, ...days.map((d) => d.total));
                    const short = (n) => (n >= 1073741824 ? faNum((n / 1073741824).toFixed(1)) + 'G' : n >= 1048576 ? fa(Math.round(n / 1048576)) + 'M' : '');
                    const dayName = (iso) => { try { return new Intl.DateTimeFormat('fa-IR', { weekday: 'short', timeZone: 'Asia/Tehran' }).format(new Date(iso + 'T12:00:00+03:30')); } catch (e) { return ''; } };
                    const chart = `<div class="mv-form-row as-chart">${days.map((d) => `<div class="as-bar-col"><small>${short(d.total)}</small>
                        <span class="as-bar" style="height:${(6 + (d.total / max) * 88).toFixed(0)}px"></span><small class="as-bar-day">${dayName(d.day)}</small></div>`).join('')}</div>`;
                    return period('مصرف امروز', periodSum(1)) + period('۷ روز گذشته', periodSum(7)) + period('۳۰ روز گذشته', periodSum(30))
                        + section('۷ روز گذشته', chart, 'روز به وقت تهران. هر موتوری که از آن رد شوید حساب می‌شود — فقط یک بار، از بیرونی‌ترین موتور.');
                },
            },
        },
    });

    // =====================================================================================
    // 6 · سیستم — lock behaviour, reset the home layout
    // =====================================================================================
    const sysP = { s: null, error: '' };
    const LOCK = [[0, 'همیشه متصل بماند (بدون قطعی)'], [1, 'قطع اتصال ۱ دقیقه بعد از قفل شدن'], [5, 'قطع اتصال ۵ دقیقه بعد از قفل شدن'], [30, 'قطع اتصال ۳۰ دقیقه بعد از قفل شدن'], [60, 'قطع اتصال ۱ ساعت بعد از قفل شدن']];
    async function sysLoad() {
        const d = await api('/api/system');
        if (d.error) sysP.error = d.error; else { sysP.s = d; sysP.error = ''; }
        repaint('system');
    }
    define('system', {
        title: 'سیستم',
        show: sysLoad,
        root() {
            return section(null,
                // No value on this row, as on Android: the title is long and the value is on its page.
                linkRow({ act: 'page', arg: 'lock', icon: 'ph-fill ph-timer', tint: 'var(--mv-gray)', title: 'رفتار هنگام قفل شدن ویندوز' })
                + (shellOn() ? linkRow({ act: 'reset-home', icon: 'ph-fill ph-squares-four', tint: 'var(--mv-red)', title: 'بازنشانی چیدمان صفحه اصلی', danger: true, noChevron: true }) : '')
                + (sysP.error ? note(esc(sysP.error), sysP.error === RESTART ? 'warn' : 'danger') : ''))
                + section('ویندوز',
                    switchRow({ act: 'core-log', title: 'لاگ هسته در کنسول', sub: 'لاگ‌های هستهٔ V2Ray در کنسول نوشته می‌شوند.', on: mirror('setting-disable-core-log') }));
        },
        actions: {
            page: (arg) => push('system', arg),
            'reset-home': () => {
                if (window.MV && MV.apps) {
                    store.set('mv-home', JSON.stringify(MV.apps.home()));
                    store.set('mv-folders', JSON.stringify(MV.apps.defaultFolders()));
                    store.set('mv-dock', JSON.stringify({ pins: MV.apps.dock() }));
                }
                say('✅ چیدمان صفحه اصلی به حالت اولیه برگشت — برنامه دوباره بارگذاری می‌شود…');
                if (window.PersistentStorage && PersistentStorage.flush) PersistentStorage.flush();
                setTimeout(() => location.reload(), 900);
            },
            'lock-pick': async (m) => {
                const d = await api('/api/system', { lockMinutes: Number(m) });
                if (d.error) say('❌ ' + d.error); else sysP.s = d;
                repaint('system');
            },
        },
        switches: { 'core-log': (on) => setMirror('setting-disable-core-log', on) },
        pages: {
            lock: {
                title: () => 'رفتار هنگام قفل شدن ویندوز',
                html() {
                    const cur = sysP.s ? sysP.s.lockMinutes : null;
                    return section(null, LOCK.map(([m, t]) => pickRow('lock-pick', m, t, null, cur === m, !sysP.s)).join('')
                        + (sysP.error ? note(esc(sysP.error), 'warn') : ''),
                        'به‌طور پیش‌فرض اتصال با قفل شدن ویندوز روشن می‌ماند. اگر زمانی را انتخاب کنید، وقتی ویندوز این مدت قفل بماند (Win+L، یا قفل خودکار بعد از بیکاری) همهٔ اتصال‌ها قطع می‌شوند؛ باز کردن قفل پیش از آن، قطع را لغو می‌کند. همتای «رفتار هنگام خاموش شدن صفحه» در اندروید، که برای صرفه‌جویی در باتری است.');
                },
            },
        },
    });

    // =====================================================================================
    // 7 · درباره — version, software update, crash reports, about us
    // =====================================================================================
    const about = { up: null, upErr: '', crash: null, crashErr: '', timer: null };
    const version = () => (about.up && about.up.currentVersion) || ((typeof CHANGELOG !== 'undefined' && CHANGELOG[0] && CHANGELOG[0].version) || '');
    async function aboutLoad() {
        const [u, c] = await Promise.all([api('/api/update'), api('/api/crash')]);
        if (u.error) about.upErr = u.error; else { about.up = u; about.upErr = ''; }
        if (c.error) about.crashErr = c.error; else { about.crash = c; about.crashErr = ''; }
        repaint('about');
    }
    function updateStatusLine(u) {
        if (!u) return about.upErr ? esc(about.upErr) : '';
        if (u.download && u.download.running) return `در حال دانلود در پس‌زمینه… ${u.download.total ? fa(Math.floor(u.download.bytes / u.download.total * 100)) + '٪' : ''}`;
        if (u.downloaded && u.latest && u.downloaded.version === u.latest.version) return 'دانلود شده و آمادهٔ نصب است.';
        if (u.checking) return 'در حال بررسی…';
        if (u.error) return `بررسی نشد: ${esc(u.error)}. معمولاً یعنی گیت‌هاب روی این شبکه در دسترس نیست — یک تونل وصل کنید و دوباره امتحان کنید.`;
        if (u.latest && u.latest.newer) return `نسخهٔ ${esc(u.latest.version)} موجود است — ${u.latest.asset ? bytes(u.latest.asset.size) : 'فایلی برای این نصب ندارد'}`;
        if (u.latest) return `نرم‌افزار شما به‌روز است. آخرین بررسی: ${when(u.lastCheckAt)}`;
        if (u.lastCheckAt) return `آخرین بررسی: ${when(u.lastCheckAt)}`;
        return 'هنوز هیچ بررسی‌ای روی این کامپیوتر کامل نشده.';
    }
    function pollUpdate(on) {
        clearInterval(about.timer);
        if (!on) return;
        about.timer = setInterval(async () => {
            if (!isShown('about') || !topOf('about')) { clearInterval(about.timer); return; }
            const u = await api('/api/update');
            if (!u.error) { about.up = u; repaint('about'); }
            if (!u.error && !u.checking && !(u.download && u.download.running)) clearInterval(about.timer);
        }, 1000);
    }

    define('about', {
        title: 'درباره',
        show: aboutLoad,
        root() {
            const reports = (about.crash && about.crash.reports) || [];
            const u = about.up;
            return section(null,
                valueRow({ icon: 'ph-fill ph-info', tint: 'var(--mv-gray)', title: 'نسخه', value: esc(version()), ltr: true })
                + linkRow({ act: 'page', arg: 'update', icon: 'ph-fill ph-arrow-circle-down', tint: 'var(--mv-blue)', title: 'به‌روزرسانی نرم‌افزار', sub: 'بررسی نسخهٔ جدید و نصب آن', value: u && u.latest && u.latest.newer ? esc(u.latest.version) : '' })
                + linkRow({ act: 'page', arg: 'crash', icon: 'ph-fill ph-warning', tint: reports.length ? 'var(--mv-orange)' : 'var(--mv-gray)', title: 'گزارش خطا',
                    sub: about.crashErr ? esc(about.crashErr) : reports.length ? `${fa(reports.length)} گزارش ذخیره‌شده — برای دیدن و فرستادن بزنید` : 'چیزی ثبت نشده. برنامه روی این کامپیوتر از کار نیفتاده است.' })
                + linkRow({ act: 'page', arg: 'aboutus', icon: 'ph-fill ph-users-three', tint: 'var(--mv-blue)', title: 'درباره ما', sub: 'سازنده، راه‌های ارتباط و لیست تغییرات' }));
        },
        actions: {
            page: (arg) => push('about', arg),
            'up-open': () => push('about', 'check'),
            'up-check': async () => {
                if (about.up) about.up.checking = true;
                repaint('about');
                const u = await api('/api/update/check', {});
                if (u.error) about.upErr = u.error; else { about.up = u; about.upErr = ''; }
                repaint('about');
            },
            'up-download': async () => {
                const u = await api('/api/update/download', {});
                if (u.error) { say('❌ ' + u.error); return; }
                about.up = u; repaint('about'); pollUpdate(true);
            },
            'up-install': async () => {
                const d = await api('/api/update/install', {});
                if (d.error) { say('❌ ' + d.error); return; }
                say(d.opened === 'folder' ? '✅ فایل نسخهٔ جدید در پوشه‌اش نشان داده شد — نسخهٔ قابل‌حمل را خودتان جایگزین کنید.' : '✅ نصب‌کننده باز شد — برنامه بسته می‌شود تا نصب انجام شود.');
            },
            'crash-reveal': async () => { const d = await api('/api/crash/reveal', {}); if (d.error) say('❌ ' + d.error); },
            'crash-copy': async (name) => {
                try {
                    const r = await fetch('/api/crash/read?name=' + encodeURIComponent(name));
                    if (!r.ok) throw new Error('پاسخ ' + r.status);
                    copy(await r.text());
                } catch (e) { say('❌ خوانده نشد: ' + e.message); }
            },
            'crash-clear': async () => { const d = await api('/api/crash/clear', {}); if (!d.error) { say(`✅ ${fa(d.removed)} گزارش پاک شد`); aboutLoad(); } },
            changelog: () => openWindow('changelog', () => { if (typeof window.openChangelogTab === 'function') window.openChangelogTab(); }),
            link: (url) => openExternal(url),
        },
        switches: {
            'auto-dl': async (on) => {
                const u = await api('/api/update', { autoDownload: on });
                if (u.error) say('❌ ' + u.error); else about.up = u;
                repaint('about');
            },
        },
        pages: {
            update: {
                title: () => 'به‌روزرسانی نرم‌افزار',
                open: () => pollUpdate(true),
                close: () => pollUpdate(false),
                html() {
                    const u = about.up;
                    if (!u) return section(null, about.upErr ? note(esc(about.upErr), about.upErr === RESTART ? 'warn' : 'danger') : spinnerBlock('در حال خواندن…'), null, 'is-wide');
                    return section(null,
                        linkRow({ act: 'up-open', icon: 'ph-fill ph-arrow-circle-down', tint: u.latest && u.latest.newer ? 'var(--mv-green)' : 'var(--mv-blue)', title: 'دانلود و نصب', value: u.latest && u.latest.newer ? esc(u.latest.version) : '' }),
                        updateStatusLine(u) + '<br>دانلود روی اتصالی که ویندوز «محدود» (metered) علامت زده ممکن است هزینهٔ اضافه داشته باشد؛ اگر می‌توانید روی اتصال بدون محدودیت دانلود کنید.')
                        + section(null,
                            switchRow({ act: 'auto-dl', icon: 'ph-fill ph-wifi-high', tint: 'var(--mv-teal)', title: 'دانلود خودکار روی اتصال بدون محدودیت', sub: 'وقتی نسخهٔ جدیدی منتشر شود، در پس‌زمینه دانلود می‌شود.', on: u.autoDownload }),
                            'فقط دانلود خودکار است، آن هم فقط روی اتصالی که ویندوز «بدون محدودیت» می‌داند — اتصالی که «محدود» علامت زده‌اید دست‌نخورده می‌ماند. نصب همیشه منتظر شماست. نسخه‌ها از گیت‌هاب خود MLMVPN (' + esc(u.repo) + ') گرفته می‌شوند.')
                        + section('آخرین به‌روزرسانی',
                            valueRow({ icon: 'ph-bold ph-clock-counter-clockwise', tint: 'var(--mv-gray)', title: 'نسخه', value: esc(u.currentVersion), ltr: true })
                            + valueRow({ icon: 'ph-fill ph-cloud-arrow-down', tint: 'var(--mv-indigo)', title: 'نصب‌شده', sub: u.installedOn ? `آخرین به‌روزرسانی در ${when(u.installedOn)} نصب شده است.` : 'تاریخ نصب در دسترس نیست.' }),
                            'این تاریخ از خودِ فایل برنامه در ویندوز خوانده می‌شود نه از چیزی که برنامه ثبت کرده، پس بعد از پاک کردن داده‌ها هم درست می‌ماند.');
                },
            },
            check: {
                title: () => 'به‌روزرسانی نرم‌افزار',
                open() { if (!(about.up && about.up.latest) && !(about.up && about.up.checking)) PANES.about.actions['up-check'](); pollUpdate(true); },
                close: () => pollUpdate(false),
                html() {
                    const u = about.up;
                    if (!u || u.checking) return section(null, spinnerBlock('در حال بررسی نسخه‌های به‌روز…'), null, 'is-wide');
                    if (u.error || about.upErr) {
                        return section(null, emptyBlock('ph-bold ph-warning-circle', 'بررسی کامل نشد', `بررسی نشد: ${esc(u.error || about.upErr)}. معمولاً یعنی گیت‌هاب روی این شبکه در دسترس نیست — یک تونل وصل کنید و دوباره امتحان کنید.`)
                            + linkRow({ act: 'up-check', icon: 'ph-bold ph-arrow-clockwise', tint: 'var(--mv-blue)', title: 'بررسی دوباره', noChevron: true }), null, 'is-wide');
                    }
                    const l = u.latest;
                    if (!l || !l.newer) {
                        return section(null, emptyBlock('ph-fill ph-check-circle', 'نرم‌افزار شما به‌روز است.',
                            `نسخهٔ فعلی: <span dir="ltr">${esc(u.currentVersion)}</span><br>آخرین بررسی: ${when(u.lastCheckAt)}${l ? `<br>آخرین نسخهٔ منتشرشده برای ویندوز: <span dir="ltr">${esc(l.version)}</span>` : ''}`)
                            + linkRow({ act: 'up-check', icon: 'ph-bold ph-arrow-clockwise', tint: 'var(--mv-blue)', title: 'بررسی دوباره', noChevron: true }), null, 'is-wide');
                    }
                    const dl = u.download;
                    const ready = u.downloaded && u.downloaded.version === l.version;
                    const pct = dl && dl.total ? Math.floor(dl.bytes / dl.total * 100) : 0;
                    return `<div class="mv-form-hero is-wide">${tile('ph-fill ph-arrow-circle-down', 'var(--mv-green)')}<div><h2>نسخهٔ جدیدی موجود است.</h2><p dir="auto">${esc(l.name)}</p></div></div>`
                        + section(null,
                            valueRow({ title: 'نسخه', value: esc(l.version), ltr: true })
                            + valueRow({ title: 'حجم', value: l.asset ? bytes(l.asset.size) : 'فایلی برای این نصب ندارد' })
                            + (dl && dl.running ? `<div class="mv-form-row is-stack">${label(`در حال دانلود… ٪${fa(pct)}`)}<progress max="100" value="${pct}"></progress></div>` : '')
                            + (dl && dl.error ? note('دانلود نشد: ' + esc(dl.error), 'danger') : '')
                            + (l.asset ? `<div class="mv-form-row as-btn-row"><button type="button" class="mv-btn mv-btn--primary" data-as="${ready ? 'up-install' : 'up-download'}"${dl && dl.running ? ' disabled' : ''}>${dl && dl.running ? 'در حال دانلود…' : ready ? 'همین حالا نصب کن' : 'دانلود'}</button></div>` : ''))
                        + (l.body ? section('تازه‌های این نسخه', `<div class="mv-form-row as-notes" dir="auto">${esc(l.body).replace(/\n/g, '<br>')}</div>`, null, 'is-wide') : '');
                },
            },
            crash: {
                title: () => 'گزارش خطا',
                open: () => aboutLoad(),
                html() {
                    const reports = (about.crash && about.crash.reports) || [];
                    if (!reports.length) {
                        return section(null, emptyBlock('ph-fill ph-check-circle', 'چیزی ثبت نشده.', 'برنامه روی این کامپیوتر از کار نیفتاده است. اگر روزی بیفتد، گزارشش همین‌جا می‌آید تا بتوانید برای ما بفرستید.'), null, 'is-wide');
                    }
                    return section(`${fa(reports.length)} گزارش`,
                        reports.map((r) => `<div class="mv-form-row as-item">${tile(r.kind === 'renderer' ? 'ph-fill ph-browser' : 'ph-fill ph-bug', 'var(--mv-orange)')}
                            ${label(r.kind === 'renderer' ? 'صفحهٔ برنامه از کار افتاد' : 'خطای کنترل‌نشده در برنامه', `${when(r.at)} · <span dir="ltr">${esc(r.title)}</span>`)}
                            <button type="button" class="mv-btn mv-btn--icon" data-as="crash-copy" data-arg="${esc(r.name)}" title="کپی گزارش"><i class="ph-bold ph-copy"></i></button></div>`).join('')
                        + `<div class="mv-form-row as-btn-row"><button type="button" class="mv-btn" data-as="crash-reveal"><i class="ph-bold ph-folder-open"></i> نمایش در پوشه</button>
                            <span class="as-grow"></span><button type="button" class="mv-btn mv-btn--danger" data-as="crash-clear">پاک کردن همه</button></div>`,
                        'هر گزارش یک فایل متنی است: نسخه، ویندوز، زمان، و اینکه چه چیزی از کار افتاد. هیچ‌چیز خودکار فرستاده نمی‌شود — «کپی» یا «نمایش در پوشه» را بزنید و در تلگرام یا گیت‌هاب برای ما بفرستید.', 'is-wide');
                },
            },
            aboutus: {
                title: () => 'درباره ما',
                html() {
                    const top = typeof CHANGELOG !== 'undefined' && CHANGELOG[0];
                    return `<div class="mv-form-hero is-wide"><img class="as-app-icon" src="icon.png" alt=""><div><h2 class="as-mono">MLMVPN</h2><p>نسخه <span dir="ltr">${esc(version())}</span></p></div></div>`
                        + section('تازه‌ها', linkRow({ act: 'changelog', icon: 'ph-fill ph-seal-check', tint: 'var(--mv-orange)', title: 'لیست تغییرات', value: top ? esc(top.version) : '', ltr: true }),
                            'هر چیزی که در نسخه‌های اخیر عوض شده، با دلیلش. اگر چیزی سر جای قبلی‌اش نبود، احتمالاً همان‌جا نوشته شده کجا رفته.')
                        + section('دربارهٔ برنامه', `<div class="mv-form-row as-notes">نام MLMVPN برگرفته از معماری پیشرفته‌ی Multi-Layer Multiplexer است. ما مرزهای ارتباطات سنتی را درنوردیده‌ایم تا به جای تکیه بر یک اتصال ساده، یک پلتفرم فوق‌هوشمند و چندلایه خلق کنیم. این اپلیکیشن با ترکیب همزمان چندین موتور قدرتمند ضدسانسور، ترافیک شما را از امن‌ترین و پرسرعت‌ترین مسیرها هدایت می‌کند. رسالت ما، ارائه یک شبکه پایدار و فوق‌سریع است که محدودیت‌های اینترنتی را در هم می‌شکند و تجربه‌ای آزاد و بی‌نظیر از دنیای وب را برای شما به ارمغان می‌آورد.<br><br>این برنامه کاملاً ۱۰۰٪ رایگان و با عشق برای مردم ایران ساخته شده است. توسعه‌دهنده: تیم MLMVPN</div>`)
                        + section('ارتباط با ما',
                            linkRow({ act: 'link', arg: 'https://t.me/mlmvpn', icon: 'ph-fill ph-telegram-logo', tint: 'var(--mv-teal)', title: 'تلگرام', sub: '<span dir="ltr">t.me/mlmvpn</span>' })
                            + linkRow({ act: 'link', arg: 'https://github.com/mlmvpn', icon: 'ph-fill ph-github-logo', tint: 'var(--mv-gray)', title: 'گیت‌هاب', sub: '<span dir="ltr">github.com/mlmvpn</span>' })
                            + linkRow({ act: 'link', arg: 'https://www.youtube.com/@marketmlm', icon: 'ph-fill ph-youtube-logo', tint: 'var(--mv-red)', title: 'یوتیوب', sub: '<span dir="ltr">youtube.com/@marketmlm</span>' }),
                            'هر سه لینک در مرورگر پیش‌فرض ویندوز باز می‌شوند. پیشنهادات خود را از طریق نظرات یوتیوب برای ما بفرستید.')
                        + section('حمایت', `<div class="mv-form-row as-donate"><img src="qrcodewallet.png" alt="">
                              <span class="mv-form-label">این ابزار برای همیشه رایگان است، اما توسعه آن نیازمند صرف وقت و انرژی فراوان است. اگر این نرم‌افزار گره‌ای از کارتان باز کرده، حمایت مالی شما بزرگ‌ترین پشتوانه ماست.
                              <small dir="ltr" class="as-mono as-addr">USDT (BEP20): 0x82caa55d51a060c28802271f55bb2b077bbac118</small></span></div>`, null);
                },
            },
        },
    });

    // ── The sidebar, in Android's order ───────────────────────────────────────────────────
    // The panes' contents are this file's; the sidebar is index.html's. The old «برنامه» pane's
    // switches now live where Android has them (and its inputs stay, hidden, for the code that
    // reads them), so its sidebar item goes.
    function tidySidebar() {
        const appBtn = $('btn-set-app');
        if (appBtn) appBtn.hidden = true;
        renderAccountCard();
    }

    // A new version found in the background: say so once per version, and where to install it
    // (Android's notice sends the user to Settings › Software update, never a second downloader).
    async function updateNotice() {
        const u = await api('/api/update');
        if (u.error || !u.latest || !u.latest.newer) return;
        if (store.get('mv-update-noticed', '') === u.latest.version) return;
        store.set('mv-update-noticed', u.latest.version);
        say(`نسخهٔ ${u.latest.version} منتشر شده است — تنظیمات › درباره › به‌روزرسانی نرم‌افزار`);
    }

    function init() {
        Object.keys(PANES).forEach(wire);
        tidySidebar();
        Object.keys(PANES).forEach((id) => {
            if (!paneEl(id)) return;
            render(id);
            if (isShown(id)) { paneEl(id).__asShown = true; if (PANES[id].show) PANES[id].show(); }
        });
        if (window.MV && MV.onChange) MV.onChange(onMvChange);
        // The account card follows the Cloud panel's accounts.
        window.addEventListener('storage', renderAccountCard);
        setInterval(() => { if (document.visibilityState === 'visible') renderAccountCard(); }, 15000);
        if (!window.__MV_PREVIEW__) setTimeout(updateNotice, 90 * 1000);
    }

    window.AndroidSettings = {
        open(pane, page, arg) {
            if (typeof window.switchSettingsTab === 'function') window.switchSettingsTab(pane);
            if (page && PANES[pane]) setTimeout(() => push(pane, page, arg), 0);
        },
        openCloud,
        refreshAccount: renderAccountCard,
    };
    // The old entry point (the Workers window) stays for anything that still calls it.
    window.openCfResources = function () { window.AndroidSettings.open('cf'); };

    const style = document.createElement('style');
    style.textContent = `
      .settings-panel-content .as-ic { width: 26px; height: 26px; font-size: 15px; flex: none; }
      .settings-panel-content .as-value { flex: none; max-width: 46%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mv-label-2); font-size: 12.5px; }
      .settings-panel-content .as-value[dir="ltr"] { font-family: var(--mv-font-tech); }
      .settings-panel-content .as-tick { flex: none; color: var(--mv-accent); font-size: 16px; }
      .settings-panel-content .mv-form-row[disabled] { cursor: default; opacity: .55; }
      .settings-panel-content .mv-form-row.is-action.is-link { cursor: pointer; }
      .settings-panel-content .as-back { display: flex; }
      .settings-panel-content .as-back-btn { display: inline-flex; align-items: center; gap: 4px; height: 28px; padding-inline: 4px 10px; border: 0; border-radius: 8px; background: none; color: var(--mv-accent); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
      .settings-panel-content .as-back-btn:hover { background: var(--mv-fill); }
      .settings-panel-content .as-mono { font-family: var(--mv-font-tech); }
      .settings-panel-content .as-num { width: 96px; height: 26px; text-align: center; font-family: var(--mv-font-tech); }
      .settings-panel-content .as-text { width: 100%; height: 30px; font-family: var(--mv-font-tech); }
      .settings-panel-content .as-chips { flex-wrap: wrap; gap: 6px; }
      .settings-panel-content .as-chip { height: 26px; padding-inline: 10px; border: 0; border-radius: 999px; background: var(--mv-fill); color: var(--mv-label); font: inherit; font-size: 12px; cursor: pointer; }
      .settings-panel-content .as-chip:hover { background: var(--mv-fill-2); }
      .settings-panel-content .as-chip.is-on { background: var(--mv-accent); color: #FFFFFF; }
      .settings-panel-content .as-slider { gap: 10px; }
      .settings-panel-content .as-pct { flex-direction: column; align-items: stretch; gap: 9px; }
      .settings-panel-content .as-pct-line { display: flex; align-items: center; gap: 10px; }
      .settings-panel-content .as-pct-line input[type="range"] { flex: 1; min-width: 0; accent-color: var(--mv-accent); }
      .settings-panel-content .as-pct-line .as-value { min-width: 46px; text-align: end; font-variant-numeric: tabular-nums; }
      /* The hero, in miniature: the same picture, dim and frost the engine pages will show. */
      .settings-panel-content .as-hero-prev { position: relative; overflow: hidden; display: flex; align-items: center; gap: 14px;
        width: 100%; min-height: 112px; padding: 16px 18px; border-radius: 16px; color: var(--mv-label);
        background: radial-gradient(120% 130% at 80% -18%, color-mix(in srgb, var(--mv-red) 24%, transparent), transparent 58%),
          linear-gradient(165deg, color-mix(in srgb, var(--mv-label) 9%, var(--mv-group)), color-mix(in srgb, var(--mv-label) 2%, var(--mv-group)));
        box-shadow: inset 0 0 0 1px var(--mv-group-edge); }
      .settings-panel-content .as-hero-prev.is-photo { color: #FFFFFF; text-shadow: 0 1px 2px rgba(0,0,0,.34);
        background: var(--as-hero-img) center / cover no-repeat, #1E1E24; }
      .settings-panel-content .as-hero-prev.is-photo::after { content: ""; position: absolute; inset: 0; pointer-events: none;
        background: rgba(0,0,0,var(--as-hero-dim, .38));
        -webkit-backdrop-filter: blur(var(--as-hero-blur, 0px)) saturate(1.15);
        backdrop-filter: blur(var(--as-hero-blur, 0px)) saturate(1.15); }
      .settings-panel-content .as-hero-prev > * { position: relative; z-index: 1; }
      .settings-panel-content .as-hero-power { flex: none; width: 54px; height: 54px; border-radius: 50%; display: grid; place-items: center;
        font-size: 22px; background: color-mix(in srgb, currentColor 12%, transparent);
        box-shadow: inset 0 0 0 2px color-mix(in srgb, currentColor 34%, transparent); }
      .settings-panel-content .as-hero-txt { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .settings-panel-content .as-hero-txt b { font-size: 14.5px; font-weight: 750; }
      .settings-panel-content .as-hero-txt small { font-size: 11px; opacity: .78; }
      .settings-panel-content .as-slider input[type="range"] { flex: 1; min-width: 0; accent-color: var(--mv-accent); }
      .settings-panel-content .as-a { flex: none; font-size: 16px; font-weight: 600; color: var(--mv-label-2); font-family: var(--mv-font-latin, inherit); }
      .settings-panel-content .as-a.is-small { font-size: 11px; }
      .settings-panel-content .as-slider .as-value { min-width: 42px; text-align: end; font-variant-numeric: tabular-nums; }
      .settings-panel-content .as-sample { justify-content: space-evenly; align-items: flex-end; min-height: 108px; padding-block: 14px; }
      .settings-panel-content .as-sample-app { display: flex; flex-direction: column; align-items: center; gap: 6px; }
      .settings-panel-content .as-sample-label { max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mv-label); }
      .settings-panel-content .as-btn-row { flex-wrap: wrap; gap: 8px; }
      .settings-panel-content .as-grow { flex: 1; }
      .settings-panel-content .as-item .mv-form-label small { word-break: break-word; }
      .settings-panel-content .as-danger { color: var(--mv-red-ink); }
      .settings-panel-content .as-check { flex: none; width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; box-shadow: inset 0 0 0 1.5px var(--mv-label-3); color: transparent; font-size: 12px; cursor: pointer; }
      .settings-panel-content .as-check.is-on { background: var(--mv-accent); box-shadow: none; color: #FFFFFF; }
      .settings-panel-content .as-mini-spin { width: 14px; height: 14px; font-size: 14px; }
      .settings-panel-content .as-avatar, .mv-side-account .as-avatar { flex: none; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: linear-gradient(180deg, #F7A045, #F38020); color: #FFFFFF; font-size: 16px; font-weight: 700; font-family: var(--mv-font-tech); }
      .settings-panel-content .as-avatar.is-big { width: 64px; height: 64px; font-size: 28px; box-shadow: 0 1px 3px rgba(0,0,0,.22); }
      .settings-panel-content .as-avatar.is-row { width: 28px; height: 28px; font-size: 13px; }
      .settings-panel-content .as-chart { align-items: flex-end; gap: 8px; height: 150px; padding-block: 12px; }
      .settings-panel-content .as-bar-col { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; }
      .settings-panel-content .as-bar-col small { font-size: 9.5px; color: var(--mv-label-2); white-space: nowrap; }
      .settings-panel-content .as-bar { width: 100%; max-width: 36px; border-radius: 8px 8px 3px 3px; background: linear-gradient(180deg, var(--mv-blue), color-mix(in srgb, var(--mv-blue) 35%, transparent)); }
      .settings-panel-content .as-notes { display: block; font-size: 12.5px; line-height: 1.95; color: var(--mv-label); text-align: justify; white-space: normal; }
      .settings-panel-content .as-app-icon { width: 72px; height: 72px; border-radius: 22.5%; }
      .settings-panel-content .as-donate img { flex: none; width: 88px; height: 88px; padding: 4px; border-radius: 10px; background: #FFFFFF; }
      .settings-panel-content .as-addr { display: block; margin-top: 8px; padding: 6px 8px; border-radius: 6px; background: var(--mv-fill); user-select: all; word-break: break-all; text-align: left; }
      .settings-panel-content progress { width: 100%; height: 6px; }
      /* The desktop's wallpaper picker, on the «تصویر زمینه» page: the page is its title and its box. */
      .settings-panel-content [data-as-wp] .mv-wp-picker > .mv-group-title { display: none; }
      .settings-panel-content [data-as-wp] .mv-wp-picker > .mv-group { background: none; box-shadow: none; border-radius: 0; overflow: visible; }
      .settings-panel-content [data-as-wp] .mv-wp-picker .mv-row { padding-inline: 0; }
      .mv-side-account { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 6px; margin-bottom: 4px; border: 0; border-radius: 10px; background: transparent; color: var(--mv-label); font: inherit; text-align: start; cursor: pointer; }
      .mv-side-account:hover { background: var(--mv-fill); }
      .mv-side-account .as-acc-text { min-width: 0; display: flex; flex-direction: column; }
      .mv-side-account .as-acc-text b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 700; text-align: start; }
      .mv-side-account .as-acc-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--mv-label-2); text-align: start; }
      .mv-side-account .as-acc-count { color: var(--mv-label-3); }
      /* The app list (tunnel routing), as tunnel-settings.js drew it. */
      #panel-set-tunnel .tr-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 12px; }
      #panel-set-tunnel .tr-chip { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding-inline: 8px 4px; border-radius: 999px; background: var(--mv-fill); font-size: 12px; color: var(--mv-label); }
      #panel-set-tunnel .tr-chip button { width: 22px; height: 22px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--mv-label-2); cursor: pointer; }
      #panel-set-tunnel .tr-chip button:hover { background: var(--mv-fill-2); color: var(--mv-label); }
      #panel-set-tunnel .tr-head { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; margin-bottom: 7px; }
      #panel-set-tunnel .tr-search { flex: 1; display: flex; align-items: center; gap: 6px; height: 28px; min-width: 180px; padding-inline: 9px; border-radius: 8px; background: var(--mv-fill); color: var(--mv-label-2); }
      #panel-set-tunnel .tr-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--mv-label); font: inherit; font-size: 12px; }
      #panel-set-tunnel .tr-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; padding: 10px; }
      #panel-set-tunnel .tr-app { position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; padding: 9px 10px; border: 0; border-radius: 11px; background: var(--mv-fill); color: inherit; font: inherit; text-align: start; cursor: pointer; box-shadow: inset 0 0 0 1px transparent; transition: background var(--mv-d-1) var(--mv-ease-out), box-shadow var(--mv-d-1) var(--mv-ease-out); }
      #panel-set-tunnel .tr-app:hover { background: var(--mv-fill-2); }
      #panel-set-tunnel .tr-app:focus-visible { outline: 2px solid var(--mv-accent); outline-offset: 1px; }
      #panel-set-tunnel .tr-app.is-on { background: color-mix(in srgb, var(--mv-accent) 13%, transparent); box-shadow: inset 0 0 0 1.5px var(--mv-accent); }
      #panel-set-tunnel .tr-ic { position: relative; flex: none; width: 32px; height: 32px; }
      #panel-set-tunnel .tr-ic img { display: block; width: 32px; height: 32px; object-fit: contain; }
      #panel-set-tunnel .tr-noicon { display: grid; place-items: center; border-radius: 8px; background: var(--mv-fill-2); color: var(--mv-label-3); font-size: 18px; }
      #panel-set-tunnel .tr-live { position: absolute; inset-inline-start: -2px; top: -2px; width: 8px; height: 8px; border-radius: 50%; background: var(--mv-green); box-shadow: 0 0 0 2px var(--mv-pane); }
      #panel-set-tunnel .tr-txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
      #panel-set-tunnel .tr-txt b { text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; font-weight: 600; color: var(--mv-label); }
      #panel-set-tunnel .tr-txt small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mv-font-tech); font-size: 10.5px; color: var(--mv-label-3); text-align: end; }
      #panel-set-tunnel .tr-check { flex: none; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--mv-label-3); color: transparent; font-size: 11px; }
      #panel-set-tunnel .tr-app.is-on .tr-check { background: var(--mv-accent); box-shadow: none; color: #FFFFFF; }
    `;
    document.head.appendChild(style);

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
