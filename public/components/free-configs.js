/**
 * «دریافت کانفیگ رایگان» — the modal, its progress, and the hand-off into the nodes list.
 *
 * Kept out of v2ray.js on purpose: that file is already the largest in the app, and this
 * feature is self-contained — it talks to /api/free-configs/*, listens for one websocket
 * event type, and ends by pushing nodes into window.v2rayList like any other importer.
 *
 * The design follows what the numbers actually are, rather than what would look impressive:
 * the pool is ten thousand entries, most of them dead from an Iranian line, so the modal is
 * honest about the funnel (found -> open port -> really answered) and lets the user stop the
 * moment they have enough. Nothing here claims a node works until a real request came back
 * through it.
 */

function freeEsc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window._freeConfigs = {
    catalog: null,
    pool: 'verified',
    results: [],
    running: false,
    stage: null,
};

window.openFreeConfigsModal = async function() {
    const modal = document.getElementById('freeConfigsModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // Results from a previous run stay on screen until a new run starts — closing the modal
    // by accident should not throw away nodes the user spent two minutes finding.
    freeRenderResults();

    if (!window._freeConfigs.catalog) await freeLoadCatalog();
};

window.closeFreeConfigsModal = function() {
    const modal = document.getElementById('freeConfigsModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
};

async function freeLoadCatalog() {
    const box = document.getElementById('free-pools');
    if (box) box.innerHTML = '<div class="mv-form-row fc-note"><i class="ph-bold ph-circle-notch fc-spin" aria-hidden="true"></i>در حال دریافت فهرست منابع…</div>';
    try {
        const d = await (await fetch('/api/free-configs/catalog')).json();
        if (!d.ok) throw new Error(d.error || 'فهرست دریافت نشد');
        window._freeConfigs.catalog = d;
        freeRenderPools();
    } catch (e) {
        if (box) box.innerHTML = `<div class="mv-form-row fc-note is-bad"><span class="mv-form-label">فهرست منابع دریافت نشد<small>${freeEsc(e.message)}</small></span>
            <button type="button" onclick="freeLoadCatalog()" class="mv-btn mv-btn--sm">تلاش دوباره</button></div>`;
    }
}
window.freeLoadCatalog = freeLoadCatalog;

function freeRenderPools() {
    const c = window._freeConfigs.catalog;
    const box = document.getElementById('free-pools');
    if (!c || !box) return;

    const fresh = c.updatedAt ? new Date(c.updatedAt) : null;
    const mins = fresh ? Math.max(0, Math.round((Date.now() - fresh.getTime()) / 60000)) : null;

    const meta = document.getElementById('free-meta');
    if (meta) {
        meta.innerHTML = [
            mins !== null ? `به‌روزرسانی: ${mins} دقیقه پیش` : '',
            c.intervalMinutes ? `هر ${c.intervalMinutes} دقیقه تازه می‌شود` : '',
            c.sources ? `${c.sources.healthy} از ${c.sources.total} منبع سالم` : '',
        ].filter(Boolean).join(' • ');
    }

    box.innerHTML = c.pools.map(p => {
        const active = window._freeConfigs.pool === p.id;
        return `
        <button type="button" onclick="freeSelectPool('${freeEsc(p.id)}')" class="mv-form-row fc-pool${active ? ' is-on' : ''}" aria-pressed="${active}">
            <span class="fc-check" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg></span>
            <span class="mv-form-label">${freeEsc(p.title)}<small>${freeEsc(p.why)}</small></span>
            <span class="mv-form-value">${Number(p.count || 0).toLocaleString('fa-IR')}</span>
        </button>`;
    }).join('');

    freeUpdatePoolStats();
}

window.freeSelectPool = function(id) {
    window._freeConfigs.pool = id;
    freeRenderPools();
};

/**
 * How many of the chosen pool this app can actually run.
 *
 * Shown separately from the headline count because they are different numbers and the gap
 * is large: protocols the core cannot speak (hysteria2, tuic, ssr) and duplicate endpoints
 * are dropped before anything is tested. Quoting only the headline would be a promise the
 * feature cannot keep.
 */
async function freeUpdatePoolStats() {
    const el = document.getElementById('free-usable');
    if (!el) return;
    el.textContent = 'در حال بررسی…';
    try {
        const d = await (await fetch('/api/free-configs/pool/' + window._freeConfigs.pool)).json();
        if (!d.ok) throw new Error(d.error);
        const protos = Object.entries(d.protocols || {}).sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}: ${v.toLocaleString('fa-IR')}`).join(' • ');
        el.innerHTML = `<b class="fc-strong">${d.usable.toLocaleString('fa-IR')}</b> کانفیگ قابل اجرا` +
            (d.unusable ? ` — ${d.unusable.toLocaleString('fa-IR')} مورد ناسازگار کنار گذاشته شد` : '') +
            (protos ? `<span class="fc-protos">${freeEsc(protos)}</span>` : '');
    } catch (e) {
        el.textContent = 'تعداد قابل اجرا مشخص نشد';
    }
}

window.freeStart = async function() {
    const count = Math.max(1, Math.min(parseInt(document.getElementById('free-count').value, 10) || 20, 500));
    window._freeConfigs.results = [];
    window._freeConfigs.running = true;
    freeRenderResults();
    freeSetRunningUI(true);
    freeSetProgress('در حال آماده‌سازی…', 0);

    try {
        const r = await fetch('/api/free-configs/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pool: window._freeConfigs.pool, count }),
        });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'شروع نشد');
    } catch (e) {
        window._freeConfigs.running = false;
        freeSetRunningUI(false);
        if (typeof toast === 'function') toast('❌ ' + e.message);
    }
};

window.freeStop = async function() {
    try { await fetch('/api/free-configs/stop', { method: 'POST' }); } catch (e) {}
    freeSetProgress('در حال توقف… آنچه پیدا شده نگه داشته می‌شود.', null);
};

function freeSetRunningUI(on) {
    const start = document.getElementById('free-btn-start');
    const stop = document.getElementById('free-btn-stop');
    if (start) start.classList.toggle('hidden', on);
    if (stop) stop.classList.toggle('hidden', !on);
    const cnt = document.getElementById('free-count');
    if (cnt) cnt.disabled = on;
    const pools = document.getElementById('free-pools');
    if (pools) pools.style.pointerEvents = on ? 'none' : '';
    if (pools) pools.style.opacity = on ? '0.6' : '';
}

function freeSetProgress(text, pct) {
    const label = document.getElementById('free-progress-text');
    const bar = document.getElementById('free-progress-bar');
    const wrap = document.getElementById('free-progress');
    if (wrap) wrap.classList.remove('hidden');
    if (label) label.textContent = text;
    if (bar) {
        if (pct === null) bar.style.width = '100%';
        else bar.style.width = Math.max(2, Math.min(100, pct)) + '%';
    }
}

/** One websocket event type carries the whole run; the modal is a pure view of it. */
window.handleFreeConfigsEvent = function(ev) {
    const S = window._freeConfigs;
    if (!ev || !ev.type) return;

    if (ev.type === 'stage') {
        S.stage = ev.stage;
        freeSetProgress(ev.stage === 'tcp'
            ? `مرحله ۱ از ۲ — بررسی سریع ${ev.total.toLocaleString('fa-IR')} کانفیگ (کدام‌ها اصلاً پاسخ می‌دهند)`
            : `مرحله ۲ از ۲ — آزمایش واقعی روی ${ev.total.toLocaleString('fa-IR')} کانفیگِ زنده`, 2);
        return;
    }

    if (ev.type === 'progress') {
        if (ev.stage === 'tcp') {
            const pct = ev.total ? (ev.tested / ev.total) * 100 : 0;
            freeSetProgress(`مرحله ۱ — ${ev.tested.toLocaleString('fa-IR')} بررسی شد، ${ev.open.toLocaleString('fa-IR')} پورت باز`, pct);
        } else {
            const pct = ev.target ? (ev.found / ev.target) * 100 : 0;
            freeSetProgress(`مرحله ۲ — ${ev.tested.toLocaleString('fa-IR')} آزمایش شد، ${ev.found.toLocaleString('fa-IR')} از ${ev.target.toLocaleString('fa-IR')} سالم`, pct);
        }
        return;
    }

    if (ev.type === 'found') {
        S.results.push(ev.node);
        freeRenderResults();
        return;
    }

    if (ev.type === 'done') {
        S.running = false;
        S.results = ev.results || S.results;
        freeSetRunningUI(false);
        freeRenderResults();
        freeSetProgress(ev.stopped
            ? `متوقف شد — ${ev.found.toLocaleString('fa-IR')} کانفیگ سالم نگه داشته شد`
            : `تمام شد — ${ev.found.toLocaleString('fa-IR')} کانفیگ سالم پیدا شد`, 100);
        if (typeof toast === 'function' && ev.found) toast(`✅ ${ev.found} کانفیگ سالم آماده‌ی انتقال است`);
        return;
    }

    if (ev.type === 'error') {
        S.running = false;
        freeSetRunningUI(false);
        freeSetProgress('خطا: ' + ev.message, 100);
    }
};

function freeRenderResults() {
    const list = document.getElementById('free-results');
    const foot = document.getElementById('free-results-foot');
    if (!list) return;
    const rows = window._freeConfigs.results;

    if (!rows.length) {
        list.innerHTML = '<div class="mv-empty"><i class="ph-bold ph-magnifying-glass mv-empty-ic"></i><b>هنوز کانفیگ سالمی پیدا نشده</b>' +
            '<p>مجموعه و تعداد را انتخاب کنید و «شروع جست‌وجو» را بزنید؛ هر کانفیگی که واقعاً جواب بدهد همین‌جا می‌آید.</p></div>';
        if (foot) foot.classList.add('hidden');
        return;
    }

    list.innerHTML = rows.map((n, i) => {
        // Delay colouring matches the nodes tab so the numbers read the same way here.
        const c = n.delay < 300 ? 'text-mv-green-ink' : n.delay < 800 ? 'text-mv-yellow-ink' : 'text-mv-orange-ink';
        const name = freeEsc(n.label || `${n.host}:${n.port}`);
        return `
        <div class="mv-form-row fc-node">
            <span class="fc-idx">${(i + 1).toLocaleString('fa-IR')}</span>
            <span class="mv-form-label"><span class="fc-name">${name}</span><small><bdi dir="ltr" class="fc-addr">${freeEsc(n.protocol)} • ${freeEsc(n.host)}:${freeEsc(n.port)}</bdi></small></span>
            <span class="fc-delay ${c}">${Number(n.delay) || 0}ms</span>
        </div>`;
    }).join('');

    if (foot) {
        foot.classList.remove('hidden');
        const btn = document.getElementById('free-btn-transfer');
        if (btn) btn.textContent = `انتقال ${rows.length} کانفیگ به V2Ray`;
    }
}

/**
 * Hand the proven nodes to the nodes list, tagged so they land in their own group.
 *
 * `groupTitle` is what getV2rayPanelName keys on, so the group is explicit rather than
 * guessed from the node's name — these configs arrive with names like "US 🇺🇸 | @Raydikalx"
 * that no heuristic could place correctly.
 */
window.freeTransfer = function() {
    const rows = window._freeConfigs.results;
    if (!rows.length) return;

    window.v2rayList = window.v2rayList || [];
    const existing = new Set(window.v2rayList.map(n => n.uri));
    let added = 0;

    rows.forEach((n) => {
        if (existing.has(n.uri)) return;
        existing.add(n.uri);
        window.v2rayList.push({
            id: Date.now() + '-' + Math.random().toString(36).slice(2),
            uri: n.uri,
            name: (n.label || `${n.host}:${n.port}`) + ' [رایگان]',
            groupTitle: 'کانفیگ های رایگان',
            // The delay is already measured and proven, so it carries over rather than
            // leaving the list blank until the V2Ray tab's own test is run again. (Only a
            // positive number counts as a measurement -- see figureHtml in v2ray.js.)
            delay: n.delay > 0 ? n.delay : undefined,
        });
        added++;
    });

    if (typeof window.saveV2rayList === 'function') window.saveV2rayList();
    if (typeof window.renderV2rayList === 'function') window.renderV2rayList();
    if (typeof toast === 'function') {
        toast(added ? `✅ ${added} کانفیگ به گروه «کانفیگ های رایگان» اضافه شد` : 'همه‌ی این کانفیگ‌ها از قبل در لیست بودند');
    }
    window.closeFreeConfigsModal();
    // On the desktop the nodes list is its own window; bring it forward so the new group is seen.
    if (document.documentElement.classList.contains('mv-shell') && window.MV && MV.wm) MV.wm.open('v2ray');
};

// ── the modal itself ────────────────────────────────────────────────────────────────
(function mountFreeConfigsModal() {
    if (document.getElementById('freeConfigsModal')) return;
    const div = document.createElement('div');
    // Built with the page kit (ui/page-kit.css). On the desktop this is the «کانفیگ رایگان»
    // window (shell/apps.js › sheetWindow): its dim, its ✕ and its card frame step aside and
    // the card fills the window. In the old layout it is still a sheet over the page.
    div.innerHTML = `
<div id="freeConfigsModal" class="hidden fixed inset-0 z-[120] items-center justify-center bg-mv-scrim p-4" dir="rtl">
  <div class="fc-card">
    <header class="fc-head">
      <h3>دریافت کانفیگ رایگان</h3>
      <button type="button" onclick="closeFreeConfigsModal()" class="fc-x" aria-label="بستن">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>
      </button>
    </header>

    <div class="fc-body custom-scrollbar">
      <div class="mv-form">
        <div class="mv-form-section">
          <div class="mv-form-header">از کدام مجموعه؟</div>
          <div id="free-pools" class="mv-form-group"></div>
          <div class="mv-form-footer fc-foot-note">
            <span id="free-usable"></span>
            <span id="free-meta"></span>
          </div>
        </div>

        <div class="mv-form-section">
          <div class="mv-form-header">جست‌وجو</div>
          <div class="mv-form-group">
            <div class="mv-form-row">
              <div class="mv-form-label">چند کانفیگ سالم می‌خواهید؟<small>بین ۱ تا ۵۰۰. هر وقت به اندازه‌ی کافی پیدا شد، می‌توانید متوقفش کنید و آن‌چه پیدا شده می‌ماند.</small></div>
              <div class="mv-form-control">
                <input id="free-count" type="number" min="1" max="500" value="20" class="mv-field mv-field--compact" dir="ltr" aria-label="تعداد کانفیگ سالم">
                <button id="free-btn-start" type="button" onclick="freeStart()" class="mv-btn mv-btn--primary">شروع جست‌وجو</button>
                <button id="free-btn-stop" type="button" onclick="freeStop()" class="hidden mv-btn">توقف و نگه‌داشتن نتایج</button>
              </div>
            </div>
            <div id="free-progress" class="hidden mv-form-row is-stack">
              <div id="free-progress-text" class="fc-prog-text"></div>
              <div class="mv-prog"><i id="free-progress-bar" style="width:0%"></i></div>
            </div>
          </div>
          <p class="mv-form-footer">اول یک بررسی سریع، بعد آزمایش واقعی با اینترنت خودتان — فقط کانفیگی در فهرست می‌آید که پاسخ داده باشد.</p>
        </div>

        <div class="mv-form-section">
          <div class="mv-form-header">کانفیگ‌های سالم</div>
          <div id="free-results" class="mv-form-group"></div>
        </div>
      </div>
    </div>

    <footer id="free-results-foot" class="hidden fc-foot">
      <span>این کانفیگ‌ها به گروه «کانفیگ های رایگان» در V2Ray اضافه می‌شوند.</span>
      <button id="free-btn-transfer" type="button" onclick="freeTransfer()" class="mv-btn mv-btn--primary">انتقال به V2Ray</button>
    </footer>
  </div>
</div>`;
    document.body.appendChild(div.firstElementChild);

    const st = document.createElement('style');
    st.id = 'free-configs-styles';
    st.textContent = `
#freeConfigsModal .hidden { display: none !important; }
.fc-card { width: 100%; max-width: 720px; max-height: min(88vh, 820px); display: flex; flex-direction: column; overflow: hidden;
  border-radius: 16px; background: var(--mv-pane); box-shadow: var(--mv-e5); color: var(--mv-label); }
.fc-head { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 48px;
  padding-inline: 20px 12px; box-shadow: inset 0 calc(-1 * var(--mv-hl)) 0 var(--mv-sep); }
.fc-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
.fc-x { width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%;
  background: var(--mv-fill); color: var(--mv-label-2); cursor: default; }
.fc-x:hover { background: var(--mv-fill-2); color: var(--mv-label); }
.fc-x svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
.fc-body { flex: 1; min-height: 0; overflow-y: auto; padding: 18px 24px 26px; container-type: inline-size; }
.fc-pool { width: 100%; border: 0; background: transparent; color: inherit; font: inherit; text-align: start; cursor: default; }
.fc-pool:hover { background: var(--mv-fill); }
.fc-pool:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--mv-accent-ring); }
.fc-check { flex: none; width: 16px; height: 16px; display: grid; place-items: center; color: var(--mv-accent); }
.fc-check svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; visibility: hidden; }
.fc-pool.is-on .fc-check svg { visibility: visible; }
.fc-pool .mv-form-value { font-size: 12px; }
.fc-note { gap: 10px; font-size: 12.5px; color: var(--mv-label-2); }
.fc-note.is-bad .mv-form-label { color: var(--mv-red-ink); }
.fc-spin { font-size: 16px; animation: mv-spin 1s linear infinite; }
.fc-foot-note { display: flex; flex-direction: column; gap: 2px; }
.fc-foot-note > span:empty { display: none; }
.fc-strong { font-weight: 700; color: var(--mv-label); }
.fc-protos { display: block; font-family: var(--mv-font-tech); font-size: 11px; color: var(--mv-label-3); }
.fc-prog-text { font-size: 12.5px; color: var(--mv-label-2); }
.fc-node { gap: 12px; }
.fc-node .mv-form-label { min-width: 0; }
.fc-node .mv-form-label small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-idx { flex: none; width: 22px; text-align: center; font-size: 11.5px; color: var(--mv-label-3); font-variant-numeric: tabular-nums; }
.fc-name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fc-addr { font-family: var(--mv-font-mono); font-size: 11px; }
.fc-delay { flex: none; font-family: var(--mv-font-tech); font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums; direction: ltr; }
#free-results .mv-empty { padding: 26px 20px; }
.fc-foot { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 20px;
  box-shadow: inset 0 var(--mv-hl) 0 var(--mv-sep); background: var(--mv-pane); font-size: 12px; color: var(--mv-label-2); }`;
    document.head.appendChild(st);
})();
