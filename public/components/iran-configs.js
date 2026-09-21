// --- «کانفیگ ایران»: the built-in serverless configs, an app of their own (as on Android) ---
//
// They used to be two undeletable rows inside V2Ray's list («کانفیگ های پیشفرض»), which is
// where configs ARRIVE — a panel deployed, a subscription imported. These ship with the app,
// need no server and no account, and are what someone reaches for on the day nothing else
// works, so they get their own icon on the desktop, the way the Android app has it.
//
// Renders into #ls-iran. The profiles are components/iran-profiles.js, generated from the
// Android app's own sources. Connecting drives the one Xray engine through the same
// /api/v2ray/start the V2Ray panel uses, and which profile is live is read back from the
// server (/api/v2ray/traffic › uri) rather than remembered here — so a node started from
// V2Ray or Quick Connect is never mistaken for one of these.
(function () {
    'use strict';

    // Only what the page kit has no class for: the measurement's own marks.
    // (No backtick may appear in here — it lives in a template literal.)
    const style = document.createElement('style');
    style.textContent = `
.iran-best { background: color-mix(in srgb, var(--mv-green) 12%, transparent); }
.iran-best .mv-row-mark { color: var(--mv-green-ink); }
.iran-is-best .mv-row-mark { color: var(--mv-green-ink); }
.iran-is-ok .mv-row-mark { color: var(--mv-yellow-ink); }
.iran-is-bad { opacity: .55; }
.iran-is-bad .mv-row-mark { color: var(--mv-label-3); }
.iran-progress { width: 100%; height: 4px; border-radius: 2px; background: var(--mv-fill-2); overflow: hidden; }
.iran-progress > span { display: block; height: 100%; background: var(--mv-accent); border-radius: 2px; transition: width .3s var(--mv-ease-out); }
.iran-progress-text { display: block; margin-top: 7px; font-size: 11.5px; line-height: 1.8; color: var(--mv-label-2); }
`;
    document.head.appendChild(style);

// The store can install a newer copy of the upstream sources and rebuild this list from them
// (store/iran-configs.js). When it has, the server hands that list over and it is the one to show:
// the list compiled into the app is the fallback, not the authority.
let installed = null;
let installedFrom = 'shipped';
const profiles = () => (installed && installed.length ? installed : (window.IRAN_PROFILES || []));

    // DECLARED BEFORE `st`, not after. `loadVerdicts` is hoisted and `st` calls it during its
    // own initialiser — so with this const below, the call lands in its temporal dead zone,
    // throws a ReferenceError, and the try/catch inside loadVerdicts quietly returns {}. The
    // measurement then looked like it had never been run, with nothing on screen or in the
    // console to say why.
    const VERDICT_KEY = 'iran-verdicts';
    function loadVerdicts() {
        try { return JSON.parse(localStorage.getItem(VERDICT_KEY) || '{}') || {}; } catch (e) { return {}; }
    }

    const st = {
        running: false, uri: null, tunnel: false, proxyMode: 'system', httpPort: 20809,
        starting: null, stopping: false,
        // «کدام کانفیگ مناسب خط من است؟» — see runTest(). `verdicts` is id -> the server's
        // answer for that profile; it survives a reopen because re-measuring 19 profiles to
        // read a result the user already has would be absurd.
        testing: false, tested: 0, testTotal: 0, verdicts: loadVerdicts(), resolvers: {},
    };
    function saveVerdicts() {
        try { localStorage.setItem(VERDICT_KEY, JSON.stringify(st.verdicts)); } catch (e) { /* a lost result is not worth an error */ }
    }

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const fa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);
    const liveProfile = () => (st.running ? profiles().find((p) => p.config === st.uri) || null : null);

    async function call(url, body) {
        const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
        const res = await fetch(url, opts);
        let data = {};
        try { data = await res.json(); } catch (e) { /* an empty reply is still an answer */ }
        if (!res.ok && !data.error) data.error = `پاسخ ${res.status} از برنامه`;
        // /api/v2ray/start appends the install path to its errors; it means nothing here.
        if (data.error) data.error = String(data.error).replace(/\s*\(__dirname:[^)]*\)\s*$/, '');
        return data;
    }

    async function refresh() {
        try {
            const d = await call('/api/iran/profiles');
            if (d && Array.isArray(d.profiles) && d.profiles.length) { installed = d.profiles; installedFrom = 'store'; }
            else { installed = null; installedFrom = 'shipped'; }
        } catch (e) { /* the app's own list stays */ }
        try {
            const [traffic, quick] = await Promise.all([call('/api/v2ray/traffic'), call('/api/quick/status')]);
            if (!traffic.error) { st.running = !!traffic.running; st.uri = traffic.uri || null; }
            if (!quick.error) { st.tunnel = !!quick.tunnelWanted; st.proxyMode = quick.proxyMode || 'system'; st.httpPort = quick.httpPort || st.httpPort; }
        } catch (e) { /* the server is not answering: the rows simply read "tap to connect" */ }
        render();
    }

    async function connect(p) {
        if (st.starting || st.stopping) return;
        st.starting = p.id;
        render();
        try {
            // One tap has to end with traffic moving, as it does on Android: through the V2Ray
            // full tunnel when that is already on (it carries whatever Xray runs), otherwise
            // through the system proxy — unless Settings › «شبکه» says «فقط پورت محلی».
            const useSystemProxy = !st.tunnel && st.proxyMode !== 'port';
            const d = await call('/api/v2ray/start', { uri: p.config, useSystemProxy });
            if (d.error) throw new Error(d.error);
            if (typeof window.markV2rayConnected === 'function') window.markV2rayConnected(p.name, { systemProxy: useSystemProxy });
            if (typeof toast === 'function') toast(`✅ ${p.name} وصل شد`);
            if (typeof window.triggerNotification === 'function') window.triggerNotification('v2rayStarted', 'کانفیگ ایران', `${p.name} روشن شد.`);
        } catch (e) {
            if (typeof toast === 'function') toast('❌ ' + e.message);
        } finally {
            st.starting = null;
            await refresh();
        }
    }

    async function disconnect() {
        if (st.starting || st.stopping) return;
        st.stopping = true;
        render();
        try {
            const d = await call('/api/v2ray/stop', {});
            if (d.error) throw new Error(d.error);
            if (typeof window.disconnectV2rayUI === 'function') window.disconnectV2rayUI();
            if (typeof toast === 'function') toast('اتصال قطع شد');
        } catch (e) {
            if (typeof toast === 'function') toast('❌ ' + e.message);
        } finally {
            st.stopping = false;
            await refresh();
        }
    }

    /**
     * What the measurement says about one profile.
     *
     * Three outcomes, and they are genuinely different things — collapsing them into
     * "works / does not work" would hide the one distinction that matters here: a config can
     * be perfectly alive and still not defeat SNI filtering, which is useful for the large
     * class of sites Iran blocks by poisoning DNS and useless for YouTube.
     */
    const VERDICTS = {
        2: { cls: 'is-best', icon: 'ph-fill ph-medal', text: 'سایت‌های فیلترشده را باز می‌کند' },
        1: { cls: 'is-ok', icon: 'ph-fill ph-check-circle', text: 'وصل می‌شود، ولی سایت فیلترشده را باز نمی‌کند' },
        0: { cls: 'is-bad', icon: 'ph-fill ph-x-circle', text: 'روی این خط کار نمی‌کند' },
    };

    function row(p, live) {
        const on = live && live.id === p.id;
        const busy = st.starting === p.id || (on && st.stopping);
        const v = st.verdicts[p.id];
        const vs = v ? VERDICTS[v.score] : null;

        const mark = busy ? '<i class="ph-bold ph-spinner-gap mv-spin"></i>'
            : on ? '<i class="ph-fill ph-check-circle"></i>'
            : st.testing && !v ? '<i class="ph-bold ph-circle-dashed"></i>'
            : vs ? `<i class="${vs.icon}"></i>`
            : '<i class="ph ph-hard-drives"></i>';

        // While connected, the row says what it is doing; otherwise the measurement, when there
        // is one, outranks the static note — the user pressed a button to get exactly that.
        const status = busy ? (st.stopping ? 'در حال قطع…' : 'در حال اتصال…')
            : on ? 'در حال حمل ترافیک — برای قطع بزنید'
            : v ? esc(vs.text + (v.score > 0 && v.ms ? ` — ${v.ms}ms` : '') + (v.score === 0 && v.why ? ` (${v.why})` : ''))
            // A profile that exists BECAUSE another one fails has to say so on its own row;
            // «برای اتصال بزنید» nineteen times over tells the user nothing about which to try.
            : (p.note || 'برای اتصال بزنید');

        const cls = ['mv-form-row', 'is-action', vs ? 'iran-' + vs.cls : ''].filter(Boolean).join(' ');
        return `<button type="button" class="${cls}" data-iran="${esc(p.id)}"${busy ? ' aria-busy="true"' : ''}>
            <span class="mv-row-mark${on && !busy ? ' is-on' : ''}">${mark}</span>
            <span class="mv-form-label">${esc(p.name)}<small${on && !busy ? ' class="is-on"' : ''}>${status}</small></span>
            <i class="ph-bold ph-power mv-row-end${on ? ' is-on' : ''}"></i>
        </button>`;
    }

    /** The profile this line should use: opens the most, then fastest. */
    function best() {
        const scored = profiles()
            .map((p) => ({ p, v: st.verdicts[p.id] }))
            .filter((x) => x.v && x.v.score > 0);
        scored.sort((a, b) => (b.v.score - a.v.score) || ((a.v.ms || 9e9) - (b.v.ms || 9e9)));
        return scored.length ? scored[0] : null;
    }

    /**
     * Measure every profile and say which one this line should use.
     *
     * Ten thousand users are on ten thousand different lines, and which serverless config works
     * is a property of the LINE, not of the config: measured here, v50 fragA could not open an
     * ordinary site while fragB opened YouTube, and Cloudflare's resolver was reset while
     * Google's and AdGuard's answered. Nobody can be asked to find that by trying nineteen rows
     * one at a time, so the app finds it. What each profile is asked, and why the resolver is
     * measured once for a whole group rather than once per profile, is in iran-tester.js.
     */
    async function runTest() {
        if (st.testing) return;
        const list = profiles();
        if (!list.length) return;
        st.testing = true;
        st.tested = 0;
        st.testTotal = list.length;
        st.verdicts = {};
        st.resolvers = {};
        saveVerdicts();
        render();

        let fatal = null;
        st.abort = new AbortController();
        try {
            const res = await fetch('/api/iran/test', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ profiles: list.map((p) => ({ id: p.id, dns: p.dns, config: p.config })) }),
                signal: st.abort.signal,
            });
            if (!res.ok) throw new Error(`پاسخ ${res.status} از برنامه`);
            const reader = res.body.getReader();
            const dec = new TextDecoder('utf-8');
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n');
                buf = lines.pop();
                for (const line of lines) {
                    if (!line.trim()) continue;
                    let d;
                    try { d = JSON.parse(line); } catch (e) { continue; }
                    if (d.fatal) { fatal = d.error; continue; }
                    if (d.done) continue;
                    if (d.kind === 'resolver') { st.resolvers[d.dns] = d; render(); continue; }
                    st.verdicts[d.id] = d;
                    st.tested++;
                    render();
                }
            }
        } catch (e) {
            // Stopping is a choice, not a failure: the results measured so far are kept.
            if (e.name !== 'AbortError') fatal = e.message;
        }

        st.testing = false;
        st.abort = null;
        saveVerdicts();
        render();
        if (fatal) { if (typeof toast === 'function') toast('❌ ' + fatal); return; }
        const b = best();
        if (typeof toast === 'function') {
            toast(b ? `✅ بهترین کانفیگ برای خط شما: ${b.p.name}` : '❌ هیچ‌کدام از کانفیگ‌ها روی این خط کار نکرد');
        }
    }

    // ── The page ───────────────────────────────────────────────────────────
    //
    // The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), as سایفون and ماسک wear it — with
    // one difference that is the point of this window: there is no single engine here, there are
    // nineteen configs, and which one works is a property of the LINE. So the hero's button
    // connects THE RECOMMENDED ONE, the first card says which that is, and the second card is the
    // measurement that decides it.
    //
    // Tapping any row still connects that row, here and in the full list: «اگر یکی وصل نشد، بعدی
    // را بزنید» is how this window is used on the day nothing else works, and two taps instead of
    // one would be a worse page, however tidy the state machine.

    // «سنجش خط» HAS NO TAB OF ITS OWN, and that is the point of it having moved.
    //
    // It was a third section, which made the measurement a place the user had to go and come back
    // from — while the thing it decides, the list of configs, sat in a different section entirely.
    // These configs have no server, so which one works is a property of THE USER'S LINE and not of
    // the config; the list cannot be read sensibly without the measurement. So the measurement now
    // sits at the top of the list, where the question is asked.
    const IRAN_SECTIONS = [
        { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
        { id: 'all', label: 'همهٔ کانفیگ‌ها', icon: 'ph-fill ph-list-checks', tint: 'var(--mv-blue)' },
    ];

    let sec = 'connect';

    function shell() {
        return `
<div id="iran-wrapper" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های کانفیگ ایران">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="iran-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${IRAN_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-iran-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="iran-store" title="کانفیگ‌های ایران در ام‌ال‌ام استور">
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
        <button type="button" id="iran-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="iran-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="iran-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="iran-stage" style="--tint:var(--mv-green)"></div>
        <div class="mv-eng-grid" id="iran-cards"></div>
      </div>
      <div class="mv-eng-sec" data-sec="all"><div class="mv-form" id="iran-sec-all"></div></div>
    </div>

    <div class="mv-eng-foot" id="iran-foot"></div>
  </section>
</div>`;
    }

    /** The profile the big button will connect: the measured winner, else the first upstream one. */
    function recommended() {
        const b = best();
        if (b) return b.p;
        const all = profiles();
        return all.find((p) => /v50/.test(p.upstream || '')) || all[0] || null;
    }

    /** How the machine's traffic gets in — the same sentence the old page carried. */
    function pathNote() {
        return st.tunnel
            ? 'تونل کامل V2Ray روشن است، پس کانفیگ از همان تونل رد می‌شود — تمام ترافیک سیستم.'
            : st.proxyMode === 'port'
                ? `«فقط پورت محلی» (تنظیمات › شبکه): پروکسی ویندوز دست نمی‌خورد؛ برنامه‌ها را خودتان به 127.0.0.1:${st.httpPort} وصل کنید.`
                : 'با یک ضربه وصل می‌شود و پروکسی سیستم روشن می‌شود. اگر تونل کامل V2Ray را روشن کنید، کل ترافیک سیستم از همین کانفیگ می‌گذرد.';
    }

    function view() {
        const live = liveProfile();
        if (st.testing) {
            return {
                tone: 'busy', head: 'در حال سنجش خط',
                line: `${st.tested} از ${st.testTotal} کانفیگ سنجیده شد. هرکدام با هستهٔ خودش امتحان می‌شود: اول DNS، بعد یک سایت عادی، بعد یک سایت فیلترشده.`,
            };
        }
        if (st.starting || st.stopping) {
            return { tone: 'busy', head: st.stopping ? 'در حال قطع' : 'در حال اتصال', line: 'چند لحظه…' };
        }
        if (live) return { tone: 'on', head: 'متصل است', line: `<b>${esc(live.name)}</b> دارد ترافیک را حمل می‌کند. ${esc(pathNote())}` };
        const r = recommended();
        const b = best();
        if (!r) return { tone: 'off', head: 'کانفیگی نیست', line: 'فهرست کانفیگ‌ها خوانده نشد — پنجره را ببندید و باز کنید.' };
        return {
            tone: 'off',
            head: 'کانفیگ‌های بدون سرور',
            line: b
                ? `دکمه «<b>${esc(r.name)}</b>» را وصل می‌کند — همان که در سنجش خطِ شما بهترین نتیجه را داد.`
                : `دکمه «<b>${esc(r.name)}</b>» را وصل می‌کند. اینکه کدام کانفیگ روی خط شما کار می‌کند به خودِ خط بستگی دارد، پس اگر جواب نداد «سنجش خط» را بزنید تا برنامه همه را امتحان کند.`,
        };
    }

    function renderIdent() {
        const host = document.getElementById('iran-ident');
        if (!host) return;
        const v = view();
        const word = v.tone === 'on' ? 'متصل است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('iran');
        const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
            : '<span class="mv-side-tile is-image"><svg aria-hidden="true"><use href="#g-iran-art"/></svg></span>';
        host.innerHTML = `${icon}
      <b>کانفیگ ایران</b>
      <small><i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : ''}"></i>${word}</small>`;
    }

    /** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
    function renderStage() {
        const host = document.getElementById('iran-stage');
        if (!host) return;
        const v = view();
        const live = liveProfile();

        if (host.dataset.built !== '1') {
            host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-iran-act="toggle" data-part="power">
          <i data-part="glyph"></i>
        </button>
      </div>
      <div class="mv-eng-stage-side">
        <div class="mv-eng-live" data-part="live"></div>
      </div>`;
            host.dataset.built = '1';
            host.querySelectorAll('[data-iran-act]').forEach((b) => {
                b.onclick = () => {
                    const l = liveProfile();
                    if (l) { disconnect(); return; }
                    const r = recommended();
                    if (r) connect(r);
                };
            });
        }

        const q = (n) => host.querySelector(`[data-part="${n}"]`);
        q('head').innerHTML = v.head;
        q('line').innerHTML = v.line;

        const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : '';
        const btn = q('power');
        const want = 'mv-eng-power' + ring;
        if (btn.className !== want) btn.className = want;
        btn.disabled = !!st.starting || st.stopping || (!live && !recommended());
        const aria = live ? 'قطع' : 'اتصال';
        btn.setAttribute('aria-label', aria);
        btn.title = aria;
        // THE RING ALONE, with no glyph class beside it. A Phosphor icon draws itself with its own
        // `::before` content, and so does the drawn ring — put both on one element and you get two
        // circles on top of each other, one of them not turning. That is what the user saw.
        const glyph = v.tone === 'busy' ? 'mv-spin-ring' : (live ? 'ph-fill ph-power' : 'ph-bold ph-power');
        const gl = q('glyph');
        if (gl.className !== glyph) gl.className = glyph;

        const el = q('live');
        if (el && window.MVEngineLive) MVEngineLive.mount(el);
    }

    /** One row inside a card: the same tap as the full list — it connects. */
    function pick(p, live) {
        const on = live && live.id === p.id;
        const busy = st.starting === p.id || (on && st.stopping);
        const v = st.verdicts[p.id];
        const vs = v ? VERDICTS[v.score] : null;
        const hint = busy ? (st.stopping ? 'در حال قطع…' : 'در حال اتصال…')
            : on ? 'در حال حمل ترافیک — برای قطع بزنید'
                : v ? vs.text + (v.score > 0 && v.ms ? ` — ${v.ms}ms` : '')
                    : (p.note || 'برای اتصال بزنید');
        return `
        <button type="button" class="mv-eng-pick${on ? ' is-on is-live' : ''}" data-iran="${esc(p.id)}">
          <i class="${busy ? 'mv-spin-ring' : on ? 'ph-fill ph-check-circle' : vs ? vs.icon : 'ph-bold ph-power'}"></i>
          <span class="mv-eng-pick-text"><b>${esc(p.name)}</b><small>${esc(hint)}</small></span>
        </button>`;
    }

    function renderCards() {
        const host = document.getElementById('iran-cards');
        if (!host) return;
        const live = liveProfile();
        const all = profiles();
        const b = best();
        const r = recommended();

        // The card shows the recommended one first, then whatever else measured well — and if
        // nothing has been measured, the upstream originals, which are what to try first.
        const scored = all.map((p) => ({ p, v: st.verdicts[p.id] })).filter((x) => x.v && x.v.score > 0)
            .sort((a, c) => (c.v.score - a.v.score) || ((a.v.ms || 9e9) - (c.v.ms || 9e9))).map((x) => x.p);
        const fallback = all.filter((p) => /v50/.test(p.upstream || ''));
        const list = (scored.length ? scored : fallback).slice(0, 4);
        if (r && !list.some((p) => p.id === r.id)) list.unshift(r);
        if (live && !list.some((p) => p.id === live.id)) list.unshift(live);

        const rr = Object.values(st.resolvers);
        const resolverRows = rr.length ? rr.map((x) => {
            const name = /8\.8\.8\.8/.test(x.dns) ? 'Google' : /1\.1\.1\.1/.test(x.dns) ? 'Cloudflare' : /94\.140/.test(x.dns) ? 'AdGuard' : x.dns;
            return `
        <div class="mv-eng-pick" aria-disabled="true">
          <i class="${x.ok ? 'ph-fill ph-check-circle' : 'ph-fill ph-x-circle'}" style="color:${x.ok ? 'var(--mv-green)' : 'var(--mv-label-3)'}"></i>
          <span class="mv-eng-pick-text"><b>${esc(name)}</b><small>${x.ok ? 'از این خط جواب می‌دهد' : 'از این خط جواب نداد'}</small></span>
        </div>`;
        }).join('') : '';

        // Same reckoning as testSection: a stored verdict whose config no longer exists is not a
        // measurement of anything, and «۱۹ سنجیده» over a list where no row shows a result is a
        // number with nothing behind it.
        const tested = all.filter((p) => st.verdicts[p.id]).length;
        host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-green)">
        <button type="button" class="mv-eng-card2-head" data-iran-go="all">
          <span class="mv-eng-glyph"><i class="ph-fill ph-list-checks"></i></span>
          <h3>کانفیگ</h3>
          <span class="mv-eng-card2-end">${esc(live ? live.name : (r ? r.name : '—'))}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">${list.slice(0, 4).map((p) => pick(p, live)).join('')}</div>
        <div class="mv-eng-card2-foot">${all.length > 4
            ? `${fa(all.length - 4)} کانفیگ دیگر در بخش «همهٔ کانفیگ‌ها» — هر ردیف با یک ضربه وصل می‌شود.`
            : 'هر ردیف با یک ضربه وصل می‌شود.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-iran-go="all">
            <span class="mv-eng-glyph"><i class="ph-fill ph-magic-wand"></i></span>
            <h3>سنجش خط</h3>
            <span class="mv-eng-card2-end">${st.testing ? `${fa(st.tested)} از ${fa(st.testTotal)}` : tested ? `${fa(tested)} سنجیده` : 'انجام نشده'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-iran-act="${st.testing ? 'abort' : 'test'}"
                  title="${st.testing ? 'توقف سنجش' : 'سنجش همهٔ کانفیگ‌ها و انتخاب بهترین'}"
                  aria-label="${st.testing ? 'توقف سنجش' : 'سنجش خط'}"${!all.length ? ' disabled' : ''}>
            <i class="${st.testing ? 'ph-bold ph-stop' : 'ph-bold ph-gauge'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">${st.testing ? `
          <div class="mv-form-row is-stack" style="padding:6px 9px">
            <div class="iran-progress"><span style="width:${st.testTotal ? Math.round((st.tested / st.testTotal) * 100) : 0}%"></span></div>
            <small class="iran-progress-text">هر کانفیگ با هستهٔ خودش امتحان می‌شود، پس چند دقیقه طول می‌کشد.</small>
          </div>` : resolverRows || `
          <div class="mv-eng-card2-foot" style="padding-top:6px">هنوز سنجیده نشده. دکمهٔ سنجش (بالا) هر کانفیگ را واقعاً امتحان می‌کند: DNS، یک سایت عادی، و یک سایت فیلترشده.</div>`}</div>
        ${!st.testing && b ? `<div class="mv-eng-card2-foot">بهترین: <b>${esc(b.p.name)}</b> — ${b.v.score === 2 ? 'سایت فیلترشده را باز کرد' : 'وصل می‌شود ولی سایت فیلترشده را باز نمی‌کند'}.</div>`
            : !st.testing && tested ? '<div class="mv-eng-card2-foot">هیچ‌کدام روی این خط کار نکرد — «نودهای V2Ray» یا «زیرساخت ابری» را امتحان کنید.</div>' : ''}
      </div>`;
    }

    function renderFoot() {
        const host = document.getElementById('iran-foot');
        if (!host) return;
        const v = view();
        const live = liveProfile();
        const word = live ? `متصل — ${esc(live.name)}`
            : v.tone === 'busy' ? (st.testing ? 'در حال سنجش' : 'در حال کار')
                : 'خاموش';
        const end = st.tunnel ? 'تونل کامل سیستم' : st.proxyMode === 'port' ? 'فقط پورت محلی' : 'پروکسی سیستم';
        host.innerHTML = `
      <i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : ''}"></i>
      <span>${word}</span>
      <span class="mv-eng-foot-end">${end}</span>`;
    }

    /** The full list, in the four groups a user moves through when the previous one did nothing. */
    function allSection() {
        const all = profiles();
        const live = liveProfile();
        const stock = all.filter((p) => /v50/.test(p.upstream || ''));
        const directDns = all.filter((p) => p.dns && !p.clean);
        const clean = all.filter((p) => p.clean);
        const older = all.filter((p) => /v48/.test(p.upstream || ''));
        const group = (header, items, footer) => items.length ? `
      <div class="mv-form-section">
        <div class="mv-form-header">${header}</div>
        <div class="mv-form-group">${items.map((p) => row(p, live)).join('')}</div>
        <div class="mv-form-footer">${footer}</div>
      </div>` : '';

        // FIRST, above every group. See IRAN_SECTIONS.
        return testSection()
            + group('سرورلس v50 — اصل پروژه', stock,
            'فایل‌های نسخهٔ ۵۰ پروژهٔ Serverless-for-Iran، دست‌نخورده. دو نسخه فقط در شکل تکه‌تکه شدن دست‌دهی TLS فرق دارند.')
            + group('همان‌ها، با DNS دیگر', directDns,
                'این کانفیگ‌ها نام سایت‌ها را از یک سرور DoH می‌پرسند. اگر آن سرور روی خط شما باز نشود، <b>هیچ نامی پیدا نمی‌شود و هیچ سایتی باز نمی‌شود</b> — حتی اگر بقیهٔ کانفیگ سالم باشد.')
            + group('فقط DNS تمیز', clean,
                'بخش بزرگی از سایت‌ها در ایران با <b>دستکاری پاسخ DNS</b> بسته می‌شوند، نه با فیلتر کردن خود آدرس. برای آن‌ها همین که جواب درست را از یک DNS رمزنگاری‌شده بگیرید کافی است. این کانفیگ‌ها سایت‌های فیلترشده مثل یوتیوب را باز <b>نمی‌کنند</b>.')
            + group('نسخهٔ ۴۸ (قدیمی‌تر)', older,
                'نگه داشته شده چون خطی که نسخهٔ ۵۰ رویش کار نمی‌کند ممکن است ۴۸ را بگیرد.')
            + (installedFrom === 'store' ? `
      <div class="mv-form-section is-wide">
        <div class="mv-form-group">
          <div class="mv-form-row mv-callout"><i class="ph-fill ph-arrow-circle-down"></i><span>این کانفیگ‌ها از «ام‌ال‌ام استور» بروزرسانی شده‌اند: فایل‌های مرجع پروژه دوباره گرفته و کانفیگ‌ها از نو ساخته شده‌اند. اگر بعد از بروزرسانی چیزی عوض شد، یک‌بار «سنجش خط» را بزنید — تازه‌تر بودن یعنی تازه‌تر، نه اینکه روی خط شما بهتر کار می‌کند.</span></div>
        </div>
      </div>` : '')
            + `
      <div class="mv-form-section is-wide">
        <div class="mv-form-footer">این کانفیگ‌ها <b>هیچ سروری</b> در مسیر ندارند: مستقیم به خود سایت وصل می‌شوند و فقط دست‌دهی TLS را تکه‌تکه می‌کنند تا شناسایی نشود. پس نه چیزی دیپلوی می‌شود، نه هزینه‌ای دارد — ولی دو محدودیت دارند که خود سازنده هم نوشته: سایت‌هایی که <b>آی‌پی‌شان</b> از ایران بسته است با این روش باز نمی‌شوند، و سرویس‌هایی که ایران را تحریم کرده‌اند هم شما را با آی‌پی ایران می‌بینند.</div>
      </div>`;
    }

    /** The measurement: what it asks, what it found, and the one line that eliminates whole groups. */
    function testSection() {
        const b = best();
        // COUNTED AGAINST THE CONFIGS THAT EXIST, not against whatever is in storage.
        //
        // Verdicts are kept between sessions on purpose — re-measuring nineteen profiles to read
        // a result the user already has would be absurd — but the configs themselves are updated
        // from the store, and an update can retire an id. When that happens every stored verdict
        // belongs to nothing: no row shows a result, `best()` finds none, and this panel used to
        // announce «هیچ‌کدام از این کانفیگ‌ها روی خط فعلی شما کار نکرد» — a verdict on the user's
        // line drawn from measurements that were never applied to a single config on screen.
        // Seen here against a real stored result. Nothing matched means nothing was measured.
        const anyTested = profiles().some((p) => st.verdicts[p.id]);
        const rr = Object.values(st.resolvers);
        const resolverLine = rr.length ? ' سرورهای DNS سنجیده‌شده: ' + rr.map((r) => {
            const name = /8\.8\.8\.8/.test(r.dns) ? 'Google' : /1\.1\.1\.1/.test(r.dns) ? 'Cloudflare' : /94\.140/.test(r.dns) ? 'AdGuard' : r.dns;
            return `${name} ${r.ok ? '✅' : '❌'}`;
        }).join(' · ') : '';

        const bestRow = b ? `
          <button type="button" class="mv-form-row is-action iran-best" data-iran="${esc(b.p.id)}">
            <span class="mv-row-mark"><i class="ph-fill ph-medal"></i></span>
            <span class="mv-form-label">بهترین برای خط شما: ${esc(b.p.name)}<small class="is-on">${b.v.score === 2
                ? `سایت فیلترشده را باز کرد${b.v.filteredMs ? ` (${b.v.filteredMs}ms)` : ''} — برای اتصال بزنید`
                : 'وصل می‌شود ولی سایت فیلترشده را باز نمی‌کند — برای اتصال بزنید'}</small></span>
            <i class="ph-bold ph-power mv-row-end"></i>
          </button>` : (anyTested && !st.testing ? `
          <div class="mv-form-row mv-callout is-warn">
            <i class="ph-bold ph-warning"></i>
            <span>هیچ‌کدام از این کانفیگ‌ها روی خط فعلی شما کار نکرد. این روش سرور ندارد و روی بعضی خط‌ها اصلاً جواب نمی‌دهد — از «نودهای V2Ray» یا «زیرساخت ابری» استفاده کنید.</span>
          </div>` : '');

        return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">کدام کانفیگ مناسب خط شماست؟</div>
        <div class="mv-form-group">
          ${st.testing ? `
          <div class="mv-form-row is-stack">
            <div class="iran-progress"><span style="width:${st.testTotal ? Math.round((st.tested / st.testTotal) * 100) : 0}%"></span></div>
            <small class="iran-progress-text">در حال سنجش ${st.tested} از ${st.testTotal} کانفیگ… هر کدام با هستهٔ خودش آزمایش می‌شود، پس چند دقیقه طول می‌کشد.</small>
          </div>
          <button type="button" class="mv-form-row is-action" data-iran-abort>
            <span class="mv-row-mark"><i class="ph-fill ph-x-circle"></i></span>
            <span class="mv-form-label">توقف سنجش<small>نتیجهٔ کانفیگ‌هایی که تا اینجا سنجیده شده‌اند می‌ماند</small></span>
          </button>` : `
          <button type="button" class="mv-form-row is-action" data-iran-test>
            <span class="mv-row-mark"><i class="ph-fill ph-magic-wand"></i></span>
            <span class="mv-form-label">پیدا کردن بهترین کانفیگ برای این خط<small>${anyTested ? 'دوباره بسنجید — نتیجهٔ قبلی پاک می‌شود' : 'هر کانفیگ را واقعاً امتحان می‌کند: DNS، یک سایت عادی، و یک سایت فیلترشده'}</small></span>
            <i class="ph-bold ph-caret-left mv-row-end"></i>
          </button>`}
          ${bestRow}
        </div>
        <div class="mv-form-footer">این کانفیگ‌ها سرور ندارند، پس اینکه کدامشان کار می‌کند به <b>خط و اپراتور شما</b> بستگی دارد نه به خود کانفیگ — روی یک خط ممکن است fragA کار کند و روی خط دیگر fragB. به جای امتحان کردن یکی‌یکی، برنامه همه را می‌سنجد و می‌گوید کدام.${resolverLine}</div>
      </div>`;
    }

    function goSec(id) {
        const wrap = document.getElementById('iran-wrapper');
        if (!wrap) return;
        sec = IRAN_SECTIONS.some((x) => x.id === id) ? id : 'connect';
        wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === sec));
        wrap.querySelectorAll('.mv-side-item[data-iran-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-iran-sec') === sec));
        const found = IRAN_SECTIONS.find((x) => x.id === sec);
        const title = document.getElementById('iran-title');
        if (title) title.textContent = found ? found.label : '';
        const back = document.getElementById('iran-back');
        if (back) back.disabled = sec === 'connect';
        const pane = wrap.querySelector('.mv-pane');
        if (pane) pane.classList.toggle('is-home', sec === 'connect');
        const sc = document.getElementById('iran-scroll');
        if (sc) sc.scrollTop = 0;
        render();
    }

    function wire(root) {
        root.querySelectorAll('[data-iran-go]').forEach((b) => { b.onclick = () => goSec(b.getAttribute('data-iran-go')); });
        root.querySelectorAll('[data-iran]').forEach((b) => {
            b.onclick = () => {
                const p = profiles().find((x) => x.id === b.dataset.iran);
                if (!p) return;
                const l = liveProfile();
                if (l && l.id === p.id) disconnect(); else connect(p);
            };
        });
        root.querySelectorAll('[data-iran-act]').forEach((b) => {
            const act = b.getAttribute('data-iran-act');
            if (act === 'test') b.onclick = runTest;
            else if (act === 'abort') b.onclick = () => { if (st.abort) { try { st.abort.abort(); } catch (e) { } } };
        });
        const testBtn = root.querySelector('[data-iran-test]');
        if (testBtn) testBtn.onclick = runTest;
        const abortBtn = root.querySelector('[data-iran-abort]');
        if (abortBtn) abortBtn.onclick = () => {
            // Aborting the REQUEST is the stop signal: the route watches its own response for a
            // close and stops between profiles, which also kills the Xray it has running.
            if (st.abort) { try { st.abort.abort(); } catch (e) { } }
        };
    }

    function render() {
        const root = document.getElementById('ls-iran');
        if (!root) return;
        if (!document.getElementById('iran-wrapper')) {
            root.innerHTML = shell();
            const wrap = document.getElementById('iran-wrapper');
            wrap.querySelectorAll('.mv-side-item[data-iran-sec]').forEach((b) => {
                b.onclick = () => goSec(b.getAttribute('data-iran-sec'));
            });
            const back = document.getElementById('iran-back');
            if (back) back.onclick = () => goSec('connect');
            // The configs themselves are a store item now (store/iran-configs.js): the store is
            // where the upstream files are compared, fetched, rebuilt and rolled back.
            const store = document.getElementById('iran-store');
            if (store) store.onclick = () => {
                if (typeof window.storeOpenItem === 'function') window.storeOpenItem('data|iran-configs');
                else if (window.MV && MV.wm) MV.wm.open('store');
            };
            goSec('connect');
            return;      // goSec calls render() again, with the shell in place
        }

        renderIdent();
        renderFoot();
        if (sec === 'connect') { renderStage(); renderCards(); }
        else {
            const host = document.getElementById('iran-sec-' + sec);
            if (host) host.innerHTML = allSection();
        }
        wire(document.getElementById('iran-wrapper'));
    }

    // Anything that changes what Xray runs (a V2Ray node, Quick Connect, a disconnect) says so
    // with this event; the rows then re-read the server instead of trusting their last look.
    window.addEventListener('mv-v2ray-state', () => { refresh(); });
    window.refreshIranConfigs = refresh;
    // The desktop icon's engine lamp.
    window.MVProbe = window.MVProbe || {};
    window.MVProbe.iran = () => !!liveProfile();

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
    else refresh();
})();
