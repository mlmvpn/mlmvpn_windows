// --- Deep DNS cleanup panel ---
// Opens as a full tab from the hamburger menu. Two jobs:
//   1. pick a resolver from a tested list
//   2. deep-clean resolvers that survive the normal Windows reset
//
// The second is the reason this exists: setting the adapter to "automatic" does not
// remove a resolver the ROUTER advertises over DHCP, so a user can clear the setting in
// both the Wi-Fi dialog and Control Panel and still be on the same DNS. The panel says
// so plainly rather than leaving them to wonder why it keeps coming back.

let dnsState = {
    providers: [],
    current: null,
    adapters: [],
    hasBackup: false,
    pings: {},         // id -> { ok, latency }
    busy: '',          // 'ping' | 'apply' | 'clean' | 'restore' | 'diagnose' | 'clear'
    busyId: '',
    lastClean: null,
    sources: null,     // null = not inspected yet
    loading: false,
    loadedProviders: false,   // the list arrived (fast)
    loadedStatus: false,      // the adapter walk finished (slow)
    error: '',
    hosts: null,
};

function dnsEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

async function dnsApi(path, body) {
    const opts = body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(`/api/dns/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `خطای سرور (${res.status})`);
    return data;
}

// ── rendering ─────────────────────────────────────────────────────────────────

function dnsBars(latency) {
    // Five bars, tuned to what these resolvers actually return on an Iranian line:
    // ~300ms is a good result here, not a bad one.
    const g = latency == null ? 0
        : latency < 250 ? 5 : latency < 400 ? 4 : latency < 700 ? 3 : latency < 1200 ? 2 : 1;
    let out = '';
    for (let i = 1; i <= 5; i++) out += `<i class="${i <= g ? 'on' : ''}"></i>`;
    return `<span class="dns-bars">${out}</span>`;
}

function dnsProviderRow(p) {
    const ping = dnsState.pings[p.id];
    const isCurrent = dnsState.current && dnsState.current.provider && dnsState.current.provider.id === p.id;
    const applying = dnsState.busy === 'apply' && dnsState.busyId === p.id;

    const status = !ping ? '<span class="dc-untested">تست نشده</span>'
        : ping.ok ? `<span class="dc-ok mv-tech-digits" dir="ltr">${ping.latency.toLocaleString('fa-IR')}ms</span>`
        : '<span class="dc-bad">پاسخ نداد</span>';

    return `
    <div class="mv-row dc-row${isCurrent ? ' is-current' : ''}">
      <span class="mv-row-mark"><i class="ph-fill ${isCurrent ? 'ph-check-circle' : 'ph-globe-simple'}"></i></span>
      <div class="mv-row-text">
        <b>${dnsEsc(p.name)} <span class="dc-en">${dnsEsc(p.en)}</span>${isCurrent ? ' <span class="mv-pill is-ok">فعال</span>' : ''}</b>
        <small dir="ltr" class="mv-tech-digits">${p.servers.map(dnsEsc).join('  ·  ')}</small>
        <small class="dc-note">${dnsEsc(p.note)}</small>
      </div>
      <div class="dc-meta">${ping && ping.ok ? dnsBars(ping.latency) : ''}${status}</div>
      <button type="button" class="mv-btn mv-btn--sm${isCurrent ? '' : ' mv-btn--primary'}" onclick="dnsApply('${dnsEsc(p.id)}')"
              ${dnsState.busy || isCurrent ? 'disabled' : ''}>
        ${applying ? '<i class="mv-spin"></i>' : isCurrent ? 'فعال' : 'استفاده'}
      </button>
    </div>`;
}

const DNS_KIND_ICON = {
    dhcp: 'ph-wifi-high', static: 'ph-network', 'stale-nic': 'ph-plugs',
    doh: 'ph-lock-key', nrpt: 'ph-list-checks',
};

/**
 * "Where is my DNS coming from?" — the section that answers the question the Windows dialogs
 * cannot. Each source keeps its own remove button, because the useful action is usually "get
 * rid of THIS one", not "wipe everything".
 */
function dnsDiagnoseHtml() {
    const busy = dnsState.busy === 'diagnose';

    if (!dnsState.sources) {
        return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-group">
          <div class="mv-callout">
            <i class="ph-fill ph-magnifying-glass"></i>
            <div><b>ببینید DNS از کجا می‌آید</b>
            <p>از روتر، از تنظیمات کارت شبکه، از یک کارت غیرفعال، یا از DNS رمزنگاری‌شدهٔ ویندوز — و هرکدام را جداگانه پاک کنید.</p></div>
          </div>
          <div class="mv-form-row is-actions">
            <button type="button" class="mv-btn mv-btn--primary" onclick="dnsDiagnose()" ${dnsState.busy ? 'disabled' : ''}>
              ${busy ? '<i class="mv-spin"></i> در حال بررسی…' : 'بررسی کن'}
            </button>
          </div>
        </div>
      </div>`;
    }

    const rows = dnsState.sources.map(s => {
        const clearing = dnsState.busy === 'clear' && dnsState.busyId === s.id;
        return `
      <div class="mv-row dc-src${s.active ? '' : ' is-off'}">
        <span class="mv-row-mark"><i class="ph-bold ${DNS_KIND_ICON[s.kind] || 'ph-question'}"></i></span>
        <div class="mv-row-text">
          <b>${dnsEsc(s.title)}${s.adapter ? ` <span class="dc-nic">${dnsEsc(s.adapter)}</span>` : ''}${s.active ? '' : ' <span class="mv-pill">غیرفعال</span>'}</b>
          <small dir="ltr" class="mv-tech-digits">${s.servers.map(dnsEsc).join('  ·  ')}</small>
          ${s.provider ? `<small>شناسایی شد: <b>${dnsEsc(s.provider.name)}</b></small>` : ''}
          <small class="dc-note">${dnsEsc(s.why)}</small>
        </div>
        <button type="button" class="mv-btn mv-btn--sm" onclick="dnsClearSource('${dnsEsc(s.id)}')" ${dnsState.busy ? 'disabled' : ''}>
          ${clearing ? '<i class="mv-spin"></i>' : 'پاک کردن همین'}
        </button>
      </div>`;
    }).join('');

    const hosts = dnsState.hosts;
    return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">منابع DNS این سیستم
          <button type="button" class="mv-btn mv-btn--sm" onclick="dnsDiagnose()" ${dnsState.busy ? 'disabled' : ''}>
            ${busy ? '<i class="mv-spin"></i>' : 'بررسی دوباره'}</button>
        </div>
        <div class="mv-form-group">${dnsState.sources.length ? rows
          : '<div class="mv-empty"><i class="ph-bold ph-check-circle mv-empty-ic"></i><b>هیچ منبع DNS مشخصی پیدا نشد</b></div>'}</div>
        ${hosts && hosts.count ? `
        <div class="mv-form-footer">فایل hosts: <b>${hosts.count.toLocaleString('fa-IR')}</b> ردیف فعال دارد. این فایل بر همهٔ DNSها اولویت دارد، پس اگر سایتی با هیچ DNSای درست نشد، این‌جا را ببینید. <span dir="ltr" class="mv-tech-digits">${dnsEsc(hosts.path)}</span></div>` : ''}
      </div>`;
}

/** Which section the pane is showing. */
let dcSec = 'status';

const DC_TITLE = { status: 'وضعیت و پاک‌سازی', pick: 'انتخاب DNS' };

window.dcGo = function (sec) {
    dcSec = DC_TITLE[sec] ? sec : 'status';
    const root = document.getElementById('dns-clean-root');
    if (!root) return;
    root.querySelectorAll('.mv-side-item[data-dc-sec]').forEach(b => {
        b.classList.toggle('active', b.getAttribute('data-dc-sec') === dcSec);
    });
    root.querySelectorAll('.mv-eng-sec[data-dc-sec]').forEach(n => {
        n.classList.toggle('is-on', n.getAttribute('data-dc-sec') === dcSec);
    });
    const t = document.getElementById('dc-title');
    if (t) t.textContent = DC_TITLE[dcSec];
    const back = document.getElementById('dc-back');
    if (back) back.disabled = dcSec === 'status';
    const pane = root.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', dcSec === 'status');
    const sc = root.querySelector('.mv-pane-scroll');
    if (sc) sc.scrollTop = 0;
};

/** The sidebar identity line: what this machine resolves through right now. */
function dcIdent() {
    const cur = dnsState.current;
    const dot = document.getElementById('dc-dot');
    const word = document.getElementById('dc-dot-word');
    if (!word) return;
    if (!dnsState.loadedStatus) { word.textContent = 'در حال خواندن…'; if (dot) dot.className = 'mv-eng-dot'; return; }
    const named = cur && cur.provider ? cur.provider.name : null;
    const list = cur && cur.dns && cur.dns.length ? cur.dns.join(' · ') : null;
    word.textContent = named || list || 'خودکار (از روتر)';
    if (dot) dot.className = 'mv-eng-dot' + (list ? ' is-on' : '');
}

/** Three skeleton rows: the list is coming, and an empty panel reads as a broken one. */
function dcSkeleton(n) {
    let out = '';
    for (let i = 0; i < n; i++) {
        out += '<div class="mv-row dc-skel"><span class="mv-row-mark"><i class="mv-skel" style="width:15px"></i></span>'
             + '<div class="mv-row-text"><b><i class="mv-skel" style="width:38%"></i></b>'
             + '<small><i class="mv-skel" style="width:60%"></i></small></div></div>';
    }
    return out;
}

function dnsRenderTab() {
    const cur = dnsState.current;
    const globals = dnsState.providers.filter(p => p.group === 'global');
    const iranian = dnsState.providers.filter(p => p.group === 'iran');
    const pinging = dnsState.busy === 'ping';
    const cleaning = dnsState.busy === 'clean';
    const waitingList = !dnsState.loadedProviders;

    dcIdent();

    const head = document.getElementById('dc-status');
    if (head) {
        head.innerHTML = !dnsState.loadedStatus
            ? `<span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="mv-spin"></i></span>
               <div class="mv-sh-text"><h2>در حال خواندن کارت‌های شبکه…</h2>
               <p>ویندوز باید همهٔ کارت‌ها را بشمارد؛ چند ثانیه طول می‌کشد.</p></div>`
            : `<span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="ph-fill ph-globe-hemisphere-west"></i></span>
               <div class="mv-sh-text">
                 <h2 dir="ltr" class="mv-tech-digits">${cur && cur.dns && cur.dns.length ? dnsEsc(cur.dns.join('  ·  ')) : 'خودکار (از روتر)'}</h2>
                 <p>${cur ? 'کارت: ' + dnsEsc(cur.name) : ''}${cur && cur.provider ? ' — شناسایی شد: <b>' + dnsEsc(cur.provider.name) + '</b>' : ''}</p>
               </div>
               <div class="mv-sh-end">
                 ${dnsState.hasBackup ? `<button type="button" class="mv-btn mv-btn--sm" onclick="dnsRestore()" ${dnsState.busy ? 'disabled' : ''}>بازگردانی</button>` : ''}
               </div>`;
    }

    const clean = document.getElementById('dc-clean');
    if (clean) {
        clean.innerHTML = `
      <div class="mv-callout">
        <i class="ph-fill ph-broom"></i>
        <div><b>پاک‌سازی عمیق</b>
        <p>اگر DNS را روی «خودکار» گذاشته‌اید ولی باز هم همان قبلی می‌ماند، علتش این است که <b>روتر شما آن را از طریق DHCP پخش می‌کند</b> — «خودکار» یعنی «هرچه روتر گفت».</p></div>
      </div>
      <div class="mv-form-row is-stack">
        <span class="mv-form-label">این‌ها هم پاک می‌شوند</span>
        <ul class="dc-list">
          <li>DNS ثابت روی <b>همهٔ</b> کارت‌ها، حتی کارت‌های غیرفعال و مجازی</li>
          <li>مقدار باقی‌ماندهٔ DHCP در رجیستری</li>
          <li>DNS رمزنگاری‌شده (DoH) در ویندوز ۱۱</li>
          <li>قوانین NRPT که فقط بعضی سایت‌ها را عوض می‌کنند</li>
          <li>کش DNS و کاتالوگ Winsock</li>
        </ul>
      </div>
      <div class="mv-form-row is-actions">
        <button type="button" class="mv-btn mv-btn--primary" onclick="dnsDeepClean(false)" ${dnsState.busy ? 'disabled' : ''}>
          ${cleaning ? '<i class="mv-spin"></i> در حال پاک‌سازی…' : 'پاک‌سازی + تنظیم کلادفلر'}</button>
        <button type="button" class="mv-btn" onclick="dnsDeepClean(true)" ${dnsState.busy ? 'disabled' : ''}>پاک‌سازی و بازگشت به خودکار</button>
      </div>
      ${dnsState.lastClean ? `<div class="mv-form-row is-stack"><div class="dc-result">${dnsEsc(dnsState.lastClean)}</div></div>` : ''}
    `;
    }

    const ping = document.getElementById('dc-ping');
    if (ping) {
        ping.innerHTML = `<button type="button" class="mv-btn mv-btn--sm" onclick="dnsPingAll()" ${dnsState.busy || waitingList ? 'disabled' : ''}>
            ${pinging ? '<i class="mv-spin"></i> در حال تست…' : 'تست همه'}</button>`;
    }

    const g = document.getElementById('dc-globals');
    if (g) g.innerHTML = waitingList ? dcSkeleton(4) : globals.map(dnsProviderRow).join('');
    const ir = document.getElementById('dc-iranian');
    if (ir) ir.innerHTML = waitingList ? dcSkeleton(3) : iranian.map(dnsProviderRow).join('');

    const src = document.getElementById('dc-sources');
    if (src) src.innerHTML = dnsDiagnoseHtml();

    const err = document.getElementById('dc-error');
    if (err) {
        err.hidden = !dnsState.error;
        if (dnsState.error) err.innerHTML = '<div class="mv-callout is-bad"><i class="ph-fill ph-warning"></i><div><b>وضعیت خوانده نشد</b><p>' + dnsEsc(dnsState.error) + '</p></div></div>';
    }
}
// ── actions ───────────────────────────────────────────────────────────────────

/**
 * Two calls, and they are not equally fast.
 *
 * /providers is a constant list and returns at once; /status walks every adapter through
 * PowerShell and is the slow one. Awaiting both before the first paint meant the panel opened
 * empty and stayed empty for as long as the slow one took. Now each one paints when it lands,
 * and until then the list shows skeleton rows and the header says what it is waiting for.
 */
async function dnsLoad() {
    dnsState.loading = true;
    dnsState.error = '';
    dnsRenderTab();

    const gotProviders = dnsApi('providers').then(p => {
        dnsState.providers = p.providers || [];
        dnsState.loadedProviders = true;
        dnsRenderTab();
    }).catch(e => {
        dnsState.loadedProviders = true;
        dnsState.error = e.message;
        dnsRenderTab();
    });

    const gotStatus = dnsApi('status').then(st => {
        dnsState.current = st.current;
        dnsState.adapters = st.adapters;
        dnsState.hasBackup = st.hasBackup;
        dnsState.loadedStatus = true;
        dnsRenderTab();
    }).catch(e => {
        dnsState.loadedStatus = true;
        dnsState.error = dnsState.error || e.message;
        dnsRenderTab();
    });

    await Promise.allSettled([gotProviders, gotStatus]);
    dnsState.loading = false;
    dnsRenderTab();
}

async function dnsDiagnose() {
    if (dnsState.busy) return;
    dnsState.busy = 'diagnose';
    dnsRenderTab();
    try {
        const r = await dnsApi('diagnose');
        dnsState.sources = r.sources;
        dnsState.hosts = r.hosts;
        dnsState.current = r.effective;
        if (typeof toast === 'function') {
            toast(`${r.sources.length.toLocaleString('fa-IR')} منبع DNS پیدا شد`);
        }
    } catch (e) {
        await uiAlert({ title: 'بررسی ناموفق', message: e.message, tone: 'danger' });
    }
    dnsState.busy = '';
    dnsRenderTab();
}

async function dnsClearSource(id) {
    if (dnsState.busy) return;
    const src = (dnsState.sources || []).find(s => s.id === id);
    if (!src) return;

    const ok = await uiConfirm({
        title: `«${src.title}» پاک شود؟`,
        message: `${src.adapter ? `کارت: ${src.adapter}\n` : ''}` +
                 `${src.servers.join('  ·  ')}\n\n${src.why}\n\n` +
                 'تنظیم فعلی قبل از تغییر پشتیبان‌گیری می‌شود.',
        confirmLabel: 'پاک کن',
        danger: true,
    });
    if (!ok) return;

    dnsState.busy = 'clear';
    dnsState.busyId = id;
    dnsRenderTab();
    try {
        const r = await dnsApi('clear-source', { id });
        dnsState.sources = r.sources;
        dnsState.current = r.effective;
        if (typeof toast === 'function') toast(r.ok ? '✅ ' + r.message : '⚠ ' + r.message);
    } catch (e) {
        await uiAlert({ title: 'خطا', message: e.message, tone: 'danger' });
    }
    dnsState.busy = ''; dnsState.busyId = '';
    await dnsLoad();
}

async function dnsPingAll() {
    if (dnsState.busy) return;
    dnsState.busy = 'ping';
    dnsRenderTab();
    try {
        const { results } = await dnsApi('ping', {});
        dnsState.pings = {};
        for (const r of results) dnsState.pings[r.id] = r;
        const ok = results.filter(r => r.ok).length;
        if (typeof toast === 'function') toast(`${ok.toLocaleString('fa-IR')} از ${results.length.toLocaleString('fa-IR')} DNS پاسخ داد`);
    } catch (e) {
        if (typeof toast === 'function') toast('❌ ' + e.message);
    }
    dnsState.busy = '';
    dnsRenderTab();
}

async function dnsApply(id) {
    if (dnsState.busy) return;
    const p = dnsState.providers.find(x => x.id === id);
    if (!p) return;

    // Changing the machine's resolver affects every program, not just this app.
    const ok = await uiConfirm({
        title: `DNS سیستم روی «${p.name}» تنظیم شود؟`,
        message: `${p.servers.join('  ·  ')}\n\n${p.note}\n\n` +
                 'این تنظیم روی کل ویندوز اعمال می‌شود و به دسترسی مدیر نیاز دارد.',
        confirmLabel: 'تنظیم کن',
    });
    if (!ok) return;

    dnsState.busy = 'apply';
    dnsState.busyId = id;
    dnsRenderTab();
    try {
        const r = await dnsApi('apply', { id });
        dnsState.current = r.current;
        if (typeof toast === 'function') toast(r.ok ? '✅ ' + r.message : '⚠ ' + r.message);
        if (!r.ok) await uiAlert({ title: 'اعمال نشد', message: r.message, tone: 'warn' });
    } catch (e) {
        await uiAlert({ title: 'خطا', message: e.message, tone: 'danger' });
    }
    dnsState.busy = ''; dnsState.busyId = '';
    await dnsLoad();
}

async function dnsDeepClean(resetToAuto) {
    if (dnsState.busy) return;

    const ok = await uiConfirm({
        title: 'پاک‌سازی عمیق DNS انجام شود؟',
        message: resetToAuto
            ? 'همه‌ی تنظیمات DNS پاک می‌شود و ویندوز دوباره از روتر DNS می‌گیرد.\n' +
              'اگر روتر شما شکن پخش می‌کند، همان برمی‌گردد.'
            : 'همه‌ی تنظیمات DNS پاک می‌شود و سپس کلادفلر (1.1.1.1) تنظیم می‌شود.\n' +
              'تنظیم فعلی شما قبل از تغییر پشتیبان‌گیری می‌شود.',
        confirmLabel: 'انجام بده',
        danger: true,
    });
    if (!ok) return;

    dnsState.busy = 'clean';
    dnsState.lastClean = null;
    dnsRenderTab();
    try {
        const r = await dnsApi('deep-clean', { resetToAuto, thenApply: 'cloudflare' });
        dnsState.current = r.current;
        dnsState.lastClean = [r.message, ...(r.steps || [])].join('\n');
        if (typeof toast === 'function') toast(r.ok ? '✅ ' + r.message : '⚠ ' + r.message);
    } catch (e) {
        await uiAlert({ title: 'پاک‌سازی ناموفق', message: e.message, tone: 'danger' });
    }
    dnsState.busy = '';
    await dnsLoad();
}

async function dnsRestore() {
    if (dnsState.busy) return;
    const ok = await uiConfirm({
        title: 'تنظیمات DNS اولیه برگردانده شود؟',
        message: 'همان چیزی که قبل از اولین تغییرِ این برنامه روی سیستم بود بازگردانده می‌شود.',
        confirmLabel: 'بازگردان',
    });
    if (!ok) return;

    dnsState.busy = 'restore';
    dnsRenderTab();
    try {
        const r = await dnsApi('restore', {});
        if (typeof toast === 'function') toast(r.ok ? '✅ بازگردانی شد' : '⚠ بازگردانی کامل نشد');
    } catch (e) {
        await uiAlert({ title: 'خطا', message: e.message, tone: 'danger' });
    }
    dnsState.busy = '';
    await dnsLoad();
}

/**
 * Entry point from the hamburger menu.
 *
 * Opens a real editor TAB, the same way the workers manager and fixed-IP screens do —
 * not the bottom log panel. This is a screen the user works in, not a stream they watch,
 * and it belongs beside the scan tabs where they can leave it open and come back.
 */
window.openDnsCleanTab = function () {
    const existing = tabs.find(t => t.type === 'dns-clean');
    if (existing) { switchTab(existing.id); return; }

    const id = 'tab_' + Date.now();
    tabs.push({
        id, isp: 'پاک‌سازی DNS', state: 'done', type: 'dns-clean',
        total: 0, tested: 0, alive: 0, dead: 0, results: [], settings: {},
    });
    switchTab(id);

    const btnScan = document.getElementById('btn-tab-scan');
    if (btnScan) btnScan.click();
};

/** Called by renderActiveTab when a dns-clean tab becomes active. */
window.renderDnsCleanTab = function () {
    let root = document.getElementById('dns-clean-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'dns-clean-root';
        const wrap = document.getElementById('editor-content-wrap');
        if (wrap) wrap.appendChild(root);
    }
    // NO flex-col here. This root carries .mv-split, which is a flex ROW — the two together
    // stack the sidebar on top of the page, which is the bug the netdiag page once shipped.
    root.className = 'dc-split mv-split';
    root.dir = 'rtl';
    root.style.display = 'flex';

    if (typeof updateBreadcrumb === 'function') updateBreadcrumb('پاک‌سازی عمیق DNS');

    if (!root.dataset.built) {
        root.innerHTML = DC_SHELL + DC_STYLE;
        root.dataset.built = '1';
        root.querySelectorAll('.mv-side-item[data-dc-sec]').forEach(b => {
            b.addEventListener('click', () => window.dcGo(b.getAttribute('data-dc-sec')));
        });
        const back = document.getElementById('dc-back');
        if (back) back.addEventListener('click', () => window.dcGo('status'));
    }
    window.dcGo(dcSec);
    // Draw whatever is already known, THEN fetch. The panel used to build an empty box and
    // wait for both calls before its first paint, so it opened blank and stayed blank for as
    // long as /status took to walk the adapters.
    dnsRenderTab();
    if (!dnsState.loadedProviders && !dnsState.loading) dnsLoad();
};

const DC_SHELL = `
  <aside class="mv-side" id="dns-clean-sidebar" aria-label="بخش‌های پاک‌سازی DNS">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident">
      <span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="ph-fill ph-broom"></i></span>
      <b>پاک‌سازی DNS</b>
      <small><i class="mv-eng-dot" id="dc-dot"></i><span id="dc-dot-word">در حال خواندن…</span></small>
    </div>
    <nav class="mv-side-list custom-scrollbar">
      <div class="mv-side-group">
        <div class="mv-side-head">بخش‌ها</div>
        <button type="button" class="mv-side-item active" data-dc-sec="status">
          <span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="ph-fill ph-broom"></i></span><span>وضعیت و پاک‌سازی</span>
        </button>
        <button type="button" class="mv-side-item" data-dc-sec="pick">
          <span class="mv-side-tile" style="--tint:var(--mv-green)"><i class="ph-fill ph-globe-hemisphere-west"></i></span><span>انتخاب DNS</span>
        </button>

      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="dc-back" aria-label="بازگشت" title="بازگشت" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="dc-title">وضعیت و پاک‌سازی</h1>
    </header>
    <div class="mv-pane-scroll custom-scrollbar">

      <div class="mv-eng-sec is-on" data-dc-sec="status">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-group"><div class="mv-status-head" id="dc-status"></div></div>
          </div>
          <div id="dc-error" hidden></div>
          <div class="mv-form-section is-wide">
            <div class="mv-form-group" id="dc-clean"></div>
            <div class="mv-form-footer">«بازگشت به خودکار» یعنی دوباره از روتر DNS بگیرد — اگر روتر شما شکن پخش می‌کند، همان برمی‌گردد. برای همین گزینهٔ اول پیشنهاد می‌شود.</div>
          </div>
          <div id="dc-sources"></div>
        </div>
      </div>

      <div class="mv-eng-sec" data-dc-sec="pick">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header dc-head-row">DNS جهانی<span id="dc-ping"></span></div>
            <div class="mv-form-group" id="dc-globals"></div>
          </div>
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">DNS ایرانی (تحریم‌شکن)</div>
            <div class="mv-form-group" id="dc-iranian"></div>
            <div class="mv-form-footer">این‌ها سایت‌های تحریمی را باز می‌کنند ولی ممکن است بقیهٔ دامنه‌ها را نشناسند.</div>
          </div>
        </div>
      </div>


    </div>
  </section>`;

const DC_STYLE = `
<style id="dc-kit-css">
  .dc-split { height:100%; min-height:0; flex:1; min-width:0; }
  .dc-split .mv-form { max-width:none; }
  .dc-split .dc-en { font-family:var(--mv-font-tech); font-size:10.5px; color:var(--mv-label-3); font-weight:600; }
  .dc-split .dc-note { color:var(--mv-label-3); }
  .dc-split .dc-nic { font-family:var(--mv-font-tech); font-size:10.5px; color:var(--mv-label-3); }
  .dc-split .dc-meta { display:flex; align-items:center; gap:7px; flex:none; font-size:11px; }
  /* Scoped to this one header: the kit's .mv-form-header is a plain label everywhere else. */
  .dc-split .dc-head-row { display:flex; align-items:center; gap:8px; }
  .dc-split .dc-head-row > #dc-ping { margin-inline-start:auto; }
  .dc-split .dc-ok { color:var(--mv-green-ink); font-weight:700; }
  .dc-split .dc-bad { color:var(--mv-red-ink); }
  .dc-split .dc-untested { color:var(--mv-label-3); }
  .dc-split .dc-row.is-current { background:var(--mv-fill); }
  .dc-split .dc-src.is-off { opacity:.62; }
  /* Five bars, tuned to what these resolvers really return on an Iranian line: ~300ms is a
     good result here, not a bad one. */
  .dc-split .dns-bars { display:inline-flex; align-items:flex-end; gap:2px; height:12px; }
  .dc-split .dns-bars > i { width:3px; border-radius:1px; background:var(--mv-sep-2); height:4px; }
  .dc-split .dns-bars > i:nth-child(2) { height:6px; }
  .dc-split .dns-bars > i:nth-child(3) { height:8px; }
  .dc-split .dns-bars > i:nth-child(4) { height:10px; }
  .dc-split .dns-bars > i:nth-child(5) { height:12px; }
  .dc-split .dns-bars > i.on { background:var(--mv-green); }
  .dc-split .dc-list { margin:0; padding-inline-start:16px; display:flex; flex-direction:column; gap:4px;
    font-size:11.5px; line-height:1.9; color:var(--mv-label-2); }
  .dc-split .dc-result { font-family:var(--mv-font-tech); font-size:11px; line-height:1.9;
    white-space:pre-wrap; color:var(--mv-label-2); }
  /* The skeleton stands in for a row while the list is on its way. */
  .dc-split .dc-skel { pointer-events:none; }
  .dc-split .dc-skel .mv-skel { display:block; }
</style>`;
