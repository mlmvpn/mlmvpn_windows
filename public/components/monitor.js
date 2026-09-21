// --- «مانیتور مصرف» ---
// Renders into #monitor-module-container (the markup lives in monitor.html) and reads
// /api/v2ray/traffic — the record traffic-manager.js keeps on disk, per Iran-calendar day.
//
// The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one the engines wear,
// with one deliberate difference: there is NO power button, because this window has nothing
// to connect. What the hero carries instead is the figure the window is about — today — with
// the live chart beside it, since that is the same number still being written.

let monitorPollingInterval = null;

/** Which section is on screen. */
let monSec = 'overview';

const monFa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

function monFmt(bytes) {
    if (typeof window.formatBytes === 'function') return window.formatBytes(bytes);
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/** The Iran-calendar day key the record is written under, `offset` days back. */
function monIranDay(offset) {
    const d = new Date(Date.now() + offset * 86400000);
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** «۲۵ شهریور» for a YYYY-MM-DD key, and the day number on its own for the chart. */
function monDayLabel(key, opts) {
    try {
        const d = new Date(key + 'T12:00:00Z');
        return new Intl.DateTimeFormat('fa-IR', opts || { day: 'numeric', month: 'long' }).format(d);
    } catch (e) { return key; }
}

function monIsMonitoringOff() {
    const el = document.getElementById('setting-disable-monitoring');
    return !!(el && el.checked);
}

function monGoSec(id) {
    const wrap = document.getElementById('view-monitor');
    if (!wrap) return;
    monSec = id === 'days' ? 'days' : 'overview';
    wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === monSec));
    wrap.querySelectorAll('.mv-side-item[data-mon-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-mon-sec') === monSec));
    const title = document.getElementById('mon-pane-title');
    if (title) title.textContent = monSec === 'days' ? 'روزها' : 'نمای کلی';
    const back = document.getElementById('mon-back');
    if (back) back.disabled = monSec === 'overview';
    // The hero owns the top of the overview, so the window's drag strip narrows to the
    // sidebar there (page-kit.css) and nothing underneath is swallowed by it.
    const pane = wrap.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', monSec === 'overview');
    const sc = document.getElementById('mon-scroll');
    if (sc) sc.scrollTop = 0;
    fetchAndUpdateMonitor();
}

function initMonitorModule() {
    const container = document.getElementById('monitor-module-container');
    if (!container) return;

    fetch('components/monitor.html?v=' + Date.now()).then((res) => res.text()).then((html) => {
        container.innerHTML = html;

        const wrap = document.getElementById('view-monitor');
        if (wrap) {
            wrap.querySelectorAll('.mv-side-item[data-mon-sec]').forEach((b) => {
                b.onclick = () => monGoSec(b.getAttribute('data-mon-sec'));
            });
            const back = document.getElementById('mon-back');
            if (back) back.onclick = () => monGoSec('overview');
            // Recording is switched on and off in Settings › مصرف, not here: a window that
            // reports a number should not also be the place that stops the number existing.
            const go = document.getElementById('mon-settings');
            if (go) go.onclick = () => {
                if (window.MV && MV.wm) MV.wm.open('settings', { pane: 'usage' });
            };
        }

        // Poll only while the window is actually on screen. The figures move by the second
        // while something is connected, and not at all when nothing is.
        if (monitorPollingInterval) clearInterval(monitorPollingInterval);
        monitorPollingInterval = setInterval(() => {
            const el = document.getElementById('view-monitor');
            if (!el || el.style.display === 'none') return;
            if (el.closest('.mv-win.is-hidden')) return;
            fetchAndUpdateMonitor();
        }, 2000);

        fetchAndUpdateMonitor();
    });
}

async function fetchAndUpdateMonitor() {
    try {
        const res = await fetch('/api/v2ray/traffic');
        const data = await res.json();
        updateMonitorUI(data);
    } catch (e) {
        console.error('Monitor fetch error:', e);
    }
}

function updateMonitorUI(t) {
    if (!t || !t.daily) return;
    const daily = t.daily;

    const sum = (days) => {
        let up = 0, down = 0;
        for (let i = 0; i < days; i++) {
            const r = daily[monIranDay(-i)];
            if (r) { up += r.up || 0; down += r.down || 0; }
        }
        return { up, down };
    };

    const today = daily[monIranDay(0)] || { up: 0, down: 0 };
    const yesterday = daily[monIranDay(-1)] || { up: 0, down: 0 };
    const week = sum(7);
    const month = sum(30);
    const off = monIsMonitoringOff();

    // ── the hero ──────────────────────────────────────────────────────────
    const bigEl = document.getElementById('mon-today');
    if (bigEl) bigEl.textContent = monFmt(today.up + today.down);
    const lineEl = document.getElementById('mon-today-line');
    if (lineEl) {
        lineEl.innerHTML = off
            ? 'ثبت مصرف در تنظیمات خاموش است — این عددها آخرین چیزی است که ثبت شده و دیگر بزرگ نمی‌شود.'
            : `<span class="mon-sub" dir="ltr"><span class="mon-down">↓ ${monFmt(today.down)}</span><span class="mon-up">↑ ${monFmt(today.up)}</span></span>`
              + '<br>مصرف امروز، از نیمه‌شب به وقت ایران. نمودار کنار، همین حالا را نشان می‌دهد.';
    }
    const live = document.getElementById('mon-live');
    if (live && window.MVEngineLive) MVEngineLive.mount(live);

    // ── the four periods ──────────────────────────────────────────────────
    const host = document.getElementById('mon-cards');
    if (host) {
        const card = (tint, icon, title, end, stats) => `
      <div class="mv-eng-card2" style="--tint:${tint}">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="${icon}"></i></span>
          <h3>${title}</h3>
          <span class="mv-eng-card2-end">${end}</span>
        </div>
        <div class="mv-eng-card2-body">
          <div class="mon-fig" dir="ltr">${monFmt(stats.up + stats.down)}</div>
          <div class="mon-pair" dir="ltr">
            <span class="mon-down">↓ ${monFmt(stats.down)}</span>
            <span class="mon-up">↑ ${monFmt(stats.up)}</span>
          </div>
        </div>
      </div>`;

        const days = Object.keys(daily).length;
        host.innerHTML =
            card('var(--mv-indigo)', 'ph-fill ph-clock-counter-clockwise', 'دیروز', monDayLabel(monIranDay(-1)), yesterday)
            + card('var(--mv-blue)', 'ph-fill ph-calendar-blank', '۷ روز گذشته', 'هفته', week)
            + card('var(--mv-pink, #FF2D55)', 'ph-fill ph-calendar', '۳۰ روز گذشته', 'ماه', month)
            + card('var(--mv-green)', 'ph-fill ph-database', 'از ابتدا',
                days ? `${monFa(days)} روز` : '—', { up: t.totalUp || 0, down: t.totalDown || 0 });
    }

    // ── the thirty-day chart ──────────────────────────────────────────────
    const bars = document.getElementById('mon-bars');
    if (bars) {
        const keys = [];
        for (let i = 29; i >= 0; i--) keys.push(monIranDay(-i));
        const totals = keys.map((k) => { const r = daily[k]; return r ? (r.up || 0) + (r.down || 0) : 0; });
        const peak = Math.max(1, ...totals);
        const todayKey = monIranDay(0);

        bars.innerHTML = keys.map((k, i) => {
            const v = totals[i];
            // A day with nothing recorded is a flat line, not a 5% stub: a bar that is there
            // says "a little", and that is a different fact from "none".
            const pct = v ? Math.max(3, Math.round((v / peak) * 100)) : 0;
            return `
        <div class="mon-bar${k === todayKey ? ' is-today' : ''}">
          <div class="mon-tip">${monDayLabel(k)} · ${monFmt(v)}</div>
          <div class="mon-bar-col"><i style="height:${pct}%"></i></div>
          <span class="mon-bar-day">${monDayLabel(k, { day: 'numeric' })}</span>
        </div>`;
        }).join('');

        const peakEl = document.getElementById('mon-peak');
        if (peakEl) peakEl.textContent = monFmt(Math.max(...totals));
    }

    // ── every day on record ───────────────────────────────────────────────
    if (monSec === 'days') {
        const sec = document.getElementById('mon-sec-days');
        if (sec) {
            const keys = Object.keys(daily).sort().reverse();
            const peak = Math.max(1, ...keys.map((k) => (daily[k].up || 0) + (daily[k].down || 0)));
            sec.innerHTML = `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">هر روزی که ثبت شده</div>
        <div class="mv-form-group">
          ${keys.length ? keys.map((k) => {
                const r = daily[k];
                const tot = (r.up || 0) + (r.down || 0);
                return `
          <div class="mv-form-row">
            <span class="mv-form-label" style="flex:1; min-width:0">
              <span class="mon-day-row">
                <span class="mon-day-date">${monDayLabel(k)}</span>
                <span class="mon-day-meter"><i style="width:${Math.max(2, Math.round((tot / peak) * 100))}%"></i></span>
                <span class="mon-day-pair"><span class="mon-down">↓ ${monFmt(r.down || 0)}</span> <span class="mon-up">↑ ${monFmt(r.up || 0)}</span></span>
                <span class="mon-day-fig">${monFmt(tot)}</span>
              </span>
            </span>
          </div>`;
            }).join('')
                    : '<div class="mv-form-row"><span class="mv-form-label">هنوز چیزی ثبت نشده. با اولین اتصال، مصرف هر روز اینجا می‌آید.</span></div>'}
        </div>
      </div>
      <div class="mv-form-section">
        <div class="mv-form-header">این پرونده</div>
        <div class="mv-form-group">
          <div class="mv-form-row"><span class="mv-form-label">روزهای ثبت‌شده</span><span class="mv-form-value">${monFa(keys.length)}</span></div>
          <div class="mv-form-row"><span class="mv-form-label">کل دریافت</span><span class="mv-form-value" dir="ltr">${monFmt(t.totalDown || 0)}</span></div>
          <div class="mv-form-row"><span class="mv-form-label">کل ارسال</span><span class="mv-form-value" dir="ltr">${monFmt(t.totalUp || 0)}</span></div>
          <div class="mv-form-row"><span class="mv-form-label">این اجرا</span><span class="mv-form-value" dir="ltr">${monFmt((t.sessionUp || 0) + (t.sessionDown || 0))}</span></div>
          <div class="mv-form-row is-top"><span class="mv-form-label">این آمار روی همین کامپیوتر و در پروندهٔ <span dir="ltr">~/.mlmvpn_traffic_db.json</span> نگه داشته می‌شود و هیچ‌جا فرستاده نمی‌شود.</span></div>
        </div>
      </div>`;
        }
    }

    // ── the strip along the bottom ────────────────────────────────────────
    const foot = document.getElementById('mon-foot');
    if (foot) {
        const now = new Date();
        const hh = String(now.getHours()).padStart(2, '0');
        const mm = String(now.getMinutes()).padStart(2, '0');
        const ss = String(now.getSeconds()).padStart(2, '0');
        const session = (t.sessionUp || 0) + (t.sessionDown || 0);
        foot.innerHTML = `
      <i class="mv-eng-dot${off ? '' : ' is-on'}"></i>
      <span>${off ? 'ثبت مصرف خاموش است' : `آخرین بروزرسانی ${hh}:${mm}:${ss}`}</span>
      <span class="mv-eng-foot-end"><span>این اجرا</span><code dir="ltr">${monFmt(session)}</code></span>`;
    }

    // ── the sidebar identity ──────────────────────────────────────────────
    const ident = document.getElementById('mon-ident');
    if (ident) {
        const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('monitor');
        const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
            : '<span class="mv-side-tile" style="--tint:var(--mv-yellow)"><svg aria-hidden="true"><use href="#g-bars"/></svg></span>';
        ident.innerHTML = `${icon}
      <b>مانیتور مصرف</b>
      <small><i class="mv-eng-dot${off ? '' : ' is-on'}"></i>${off ? 'خاموش' : 'در حال ثبت'}</small>`;
    }
}

window.updateMonitor = function (t) { /* Stub for legacy scanner calls */ };
