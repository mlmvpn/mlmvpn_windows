// --- Dedicated DNS panel (DNS اختصاصی) ---
// Deploys the user's own Cloudflare DoH worker using the credentials already saved in the
// cloud module, then wires it into Xray as a GLOBAL resolver: applies automatically to ALL
// sites (anti-filter via encrypted DoH). Two modes, one active at a time:
//   'ecs' — dns_worker.js: steers game/CDN lookups to a chosen region via EDNS Client Subnet
//   'doh' — doh_worker.js: no steering, 8 resolvers + edge cache, for lookup speed/ping
// Each mode keeps its own deployed worker URL, so switching back and forth costs nothing.
// Renders into #ls-dedidns. Talks to /api/dedidns/* on the local server.

const dediDnsHtmlTemplate = `
<!-- Built with the page kit (ui/page-kit.css). Every id the logic below uses is unchanged. -->
<div id="dedidns-wrapper" dir="rtl">
  <div class="mv-scroll custom-scrollbar">
    <div class="mv-form">

      <div class="mv-form-section is-wide">
        <div class="mv-form-group">
          <div class="mv-status-head">
            <span class="mv-side-tile" style="--tint:var(--mv-teal)"><i class="ph-fill ph-globe-hemisphere-west"></i></span>
            <div class="mv-sh-text">
              <h2>DNS اختصاصی</h2>
              <p>آدرس سایت‌ها را از <b>Worker شخصی خودت روی کلادفلر</b> و رمزنگاری‌شده (DoH) می‌پرسد؛ روی اکانت خودت مستقر می‌شود و ISP نمی‌تواند جواب را جعل کند.</p>
            </div>
          </div>
        </div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">چه کار می‌کند</div>
        <div class="mv-form-group">
          <div class="mv-form-row is-stack">
            <p class="kp-text" style="margin:0"><b>وقتی به VPN وصلی، سایت‌های ایرانی را از تونل بیرون نگه می‌دارد — حتی آن‌هایی که دامنه‌شان <span dir="ltr">.ir</span> نیست.</b> سایت‌های <span dir="ltr">.ir</span> (بانک‌ها، سایت‌های دولتی) همیشه مستقیم می‌روند؛ ولی دیجی‌کالا و آپارات دامنه‌ی <span dir="ltr">.com</span> دارند و سرورشان در ایران است. بدون این گزینه Xray این را نمی‌فهمد و ترافیکشان را بی‌دلیل دور دنیا می‌چرخاند (کند می‌شوند و گاهی باز نمی‌شوند). با روشن بودنش، آی‌پی ایرانی‌شان دیده می‌شود و مستقیم می‌روند.</p>
          </div>
          <div class="mv-form-row mv-callout is-warn">
            <i class="ph-fill ph-info"></i>
            <span>لوکیشن و آی‌پی تو را <b>عوض نمی‌کند</b> (آن را سرور VPN تعیین می‌کند) و <b>سایت‌های تحریمی را باز نمی‌کند</b> (کار «تحریم‌شکن» است). برای تست، سایت بانکی را امتحان نکن — آن‌ها <span dir="ltr">.ir</span> هستند؛ با <b>digikala.com</b> یا <b>aparat.com</b> تست کن.</span>
          </div>
        </div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">۱) استقرار Worker روی کلادفلر تو</div>
        <div class="mv-form-group">
          <div class="mv-form-row">
            <div class="mv-form-label">حساب کلادفلر<small>از حساب‌های ثبت‌شده در «زیرساخت ابری».</small></div>
            <select id="dedidns-account" class="mv-popup"></select>
          </div>
          <div class="mv-form-row">
            <div class="mv-form-label">کار Worker</div>
            <div class="mv-tb-seg dd-seg" role="group" aria-label="کار Worker">
              <button type="button" id="dedidns-tab-ecs" onclick="setDediDnsMode('ecs')">🌍 مکان‌یابی سرور</button>
              <button type="button" id="dedidns-tab-doh" onclick="setDediDnsMode('doh')">⚡ سرعت و پینگ</button>
            </div>
          </div>
          <div id="dedidns-pane-ecs" class="dd-pane">
            <div class="mv-form-row is-stack">
              <p class="kp-text" style="margin:0">آدرس سرور بازی یا CDN را طوری می‌پرسد که انگار از <b>کشور انتخابی</b> پرسیده‌ای، تا نزدیک‌ترین سرور آن منطقه داده شود. مناسب وقتی سرور بازی دور افتاده است.</p>
            </div>
            <div class="mv-form-row">
              <div class="mv-form-label">کشور</div>
              <div class="mv-form-control">
                <select id="dedidns-region" class="mv-popup"></select>
                <button type="button" onclick="deployDediDns('ecs')" id="dedidns-deploy-btn" class="mv-btn mv-btn--primary">استقرار</button>
              </div>
            </div>
          </div>
          <div id="dedidns-pane-doh" class="dd-pane" style="display:none;">
            <div class="mv-form-row is-stack">
              <p class="kp-text" style="margin:0">کشور را عوض نمی‌کند؛ <b>سرعت خود پرسیدن آدرس</b> را بالا می‌برد: بین ۸ سرور DNS جهانی سالم‌ترین را می‌گیرد و جواب را روی نزدیک‌ترین دیتاسنتر کلادفلر کش می‌کند. اگر یکی از سرورها بخوابد، خودکار رد می‌شود.</p>
            </div>
            <div class="mv-form-row">
              <div class="mv-form-label">گروه سرورها</div>
              <div class="mv-form-control">
                <select id="dedidns-dohgroup" class="mv-popup"></select>
                <button type="button" onclick="deployDediDns('doh')" id="dedidns-deploy-doh-btn" class="mv-btn mv-btn--primary">استقرار</button>
              </div>
            </div>
            <div class="mv-form-row is-stack">
              <button type="button" onclick="measureDediDns()" id="dedidns-measure-btn" class="mv-btn">تست سرعت پاسخ‌دهی</button>
              <div id="dedidns-measure-result" class="kp-result"></div>
            </div>
          </div>
          <div class="mv-form-row is-stack dd-deploy-row"><div id="dedidns-deploy-result" class="kp-result"></div></div>
        </div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">۲) داخل تونل</div>
        <div class="mv-form-group">
          <div class="mv-form-row">
            <div class="mv-form-label">وقتی VPN وصل است<small id="dedidns-state-label" class="dd-state">در حال بارگذاری…</small></div>
            <button type="button" id="dedidns-toggle-btn" onclick="toggleDediDns()" class="mv-btn mv-btn--primary" style="min-width:104px">…</button>
          </div>
        </div>
      </div>

      <div class="mv-form-section">
        <div class="mv-form-header">۳) روی کل ویندوز (بدون نیاز به VPN)</div>
        <div class="mv-form-group">
          <div class="mv-form-row">
            <div class="mv-form-label">DNS ویندوز<small id="dedidns-system-label" class="dd-state">در حال بارگذاری…</small></div>
            <button type="button" id="dedidns-system-btn" onclick="toggleDediDnsSystem()" class="mv-btn mv-btn--primary" style="min-width:104px">…</button>
          </div>
          <div class="mv-form-row is-stack">
            <p class="kp-text" style="margin:0">یک سرویس DNS روی <span dir="ltr">127.0.0.1</span> بالا می‌آورد و DNS ویندوز را روی آن می‌گذارد؛ هر پرسش رمزنگاری‌شده به Worker خودت می‌رود — یعنی <b>مرورگر، بازی و همه‌ی برنامه‌ها</b>، نه فقط تونل. سایت‌هایی که با <b>جعل DNS</b> بسته شده‌اند باز می‌شوند و چون ترافیک مستقیم می‌رود، سرعت کامل است.</p>
          </div>
          <div class="mv-form-row mv-callout is-warn">
            <i class="ph-fill ph-info"></i>
            <span>سایت‌هایی که روی <b>آی‌پی یا SNI</b> بسته شده‌اند با هیچ DNSی باز نمی‌شوند؛ تست پایین دقیقاً همین را مشخص می‌کند. تغییر DNS ویندوز <b>دسترسی مدیر</b> می‌خواهد.</span>
          </div>
          <label class="mv-form-row">
            <span class="mv-form-label">باز کردن سایت‌های فیلترشده از راه تونل<small>فقط سایت‌هایی که روی آی‌پی یا SNI بسته‌اند از تونل رد می‌شوند؛ سایت ایرانی و خارجی سالم مستقیم می‌روند. لازم نیست از V2Ray کاری کنی — خودش از کانفیگ‌های Worker تو و بهترین آی‌پی تمیز اسکن‌شده وصل می‌شود.</small></span>
            <input type="checkbox" id="dedidns-smart-tunnel" class="mv-switch-input" onchange="setDediDnsSmartTunnel(this.checked)" />
          </label>
          <div id="dedidns-fallback-row" class="dd-pane" style="display:none;">
            <div class="mv-form-row is-sub">
              <div class="mv-form-label">سایتی که در هیچ فهرستی نیست</div>
              <select id="dedidns-fallback" class="mv-popup" onchange="setDediDnsFallback(this.value)">
                <option value="direct">مستقیم — سریع‌ترین (اگر فیلتر باشد باز نمی‌شود)</option>
                <option value="tunnel">از تونل — همه‌چیز باز می‌شود (سایت خارجی کمی کندتر)</option>
              </select>
            </div>
          </div>
          <div class="mv-form-row is-stack">
            <div class="kp-line">
              <input id="dedidns-test-domain" class="mv-field" value="www.youtube.com" dir="ltr" spellcheck="false" aria-label="دامنه برای تست" />
              <button type="button" onclick="testDediDnsSystem()" id="dedidns-test-btn" class="mv-btn">تست</button>
            </div>
            <div id="dedidns-test-result" class="kp-result"></div>
            <div id="dedidns-route-stats" class="kp-result dd-stats"></div>
          </div>
        </div>
      </div>

    </div>
  </div>
</div>
<style>
  #dedidns-wrapper { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--mv-pane); color: var(--mv-label); }
  #dedidns-wrapper > .mv-scroll { padding: 14px 20px 24px; }
  #dedidns-wrapper .kp-line { display: flex; gap: 8px; align-items: center; width: 100%; }
  #dedidns-wrapper .kp-line > .mv-field { flex: 1; min-width: 0; height: 28px; }
  #dedidns-wrapper .kp-result:empty { display: none; }
  #dedidns-wrapper .kp-result { font-size: 12px; line-height: 1.8; }
  #dedidns-wrapper .kp-text { font-size: 12.5px; line-height: 1.9; color: var(--mv-label-2); }
  #dedidns-wrapper .kp-text b { color: var(--mv-label); }
  #dedidns-wrapper .mv-bb-lead > div { font-size: 12px; line-height: 1.6; }
  /* A pane shown and hidden as a block (the logic sets display): its rows keep the group's hairlines. */
  #dedidns-wrapper .dd-pane > .mv-form-row { position: relative; }
  #dedidns-wrapper .dd-pane > .mv-form-row::before,
  #dedidns-wrapper .dd-pane + .mv-form-row::before {
    content: ""; position: absolute; top: 0; inset-inline: 14px 14px; height: var(--mv-hl); background: var(--mv-group-sep);
  }
  #dedidns-wrapper .dd-deploy-row:has(#dedidns-deploy-result:empty) { display: none; }
  #dedidns-wrapper .dd-state { word-break: break-all; }
  #dedidns-wrapper .dd-stats { font-size: 11px; color: var(--mv-label-3); }
  /* The mode picker's colours are painted inline by renderDediDnsModeUi(). */
  #dedidns-wrapper .dd-seg > button { border: 1px solid transparent; }
</style>
`;

let dediDnsConfig = { enabled: false, mode: 'ecs', workerUrl: '', dohWorkerUrl: '', region: 'AE', dohGroup: 'standard' };
let dediDnsRegions = [];
let dediDnsGroups = [];

// URL of the worker backing the given mode (defaults to the active one). The toggle and
// the status line must follow the mode, or the panel reports "ready" while the mode the
// user just switched to has never been deployed.
function dediDnsUrlFor(mode) {
    const m = mode || dediDnsConfig.mode || 'ecs';
    return (m === 'doh' ? dediDnsConfig.dohWorkerUrl : dediDnsConfig.workerUrl) || '';
}

async function dediDnsApi(path, body) {
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
                     : { method: 'GET' };
    const r = await fetch('/api/dedidns/' + path, opt);
    return r.json();
}

function dediDnsLoadAccounts() {
    // Reuse the cloud module's account store (browser PersistentStorage 'cf_accounts').
    try {
        if (typeof loadCloudAccounts === 'function') return loadCloudAccounts() || [];
        const raw = (typeof PersistentStorage !== 'undefined') ? PersistentStorage.getItem('cf_accounts') : null;
        return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
}

function renderDediDnsAccounts() {
    const sel = document.getElementById('dedidns-account');
    if (!sel) return;
    const accounts = dediDnsLoadAccounts();
    if (!accounts.length) {
        sel.innerHTML = '<option value="">ابتدا در «زیرساخت ابری» یک حساب اضافه کنید</option>';
        sel.disabled = true;
    } else {
        sel.disabled = false;
        sel.innerHTML = accounts.map(a => `<option value="${a.id}">${a.name || a.email}</option>`).join('');
    }
}

function renderDediDnsRegions() {
    const sel = document.getElementById('dedidns-region');
    if (!sel) return;
    sel.innerHTML = dediDnsRegions.map(r => `<option value="${r.code}">${r.nameFa} (${r.code})</option>`).join('');
    sel.value = dediDnsConfig.region || 'AE';
    sel.onchange = async () => { await dediDnsApi('config', { region: sel.value }); dediDnsConfig.region = sel.value; setDediDnsToggleUi(); };
}

function renderDediDnsGroups() {
    const sel = document.getElementById('dedidns-dohgroup');
    if (!sel) return;
    sel.innerHTML = dediDnsGroups.map(g => `<option value="${g.code}">${g.nameFa}</option>`).join('');
    sel.value = dediDnsConfig.dohGroup || 'standard';
    // The group is baked into the worker's DNS_MODE binding at deploy time, so changing it
    // here only takes effect on the next deploy — say so instead of letting it look applied.
    sel.onchange = async () => {
        await dediDnsApi('config', { dohGroup: sel.value });
        dediDnsConfig.dohGroup = sel.value;
        if (typeof toast === 'function') toast('برای اعمال، دوباره «استقرار» بزن');
    };
}

// Switch which worker answers lookups. Saved immediately so the running tunnel is rebuilt
// with the new resolver, the same way the on/off switch is.
async function setDediDnsMode(mode) {
    dediDnsConfig.mode = mode;
    renderDediDnsModeUi();
    setDediDnsToggleUi();
    try {
        const res = await dediDnsApi('config', { mode });
        if (res.config) dediDnsConfig = res.config;
        if (res.applied && typeof toast === 'function') toast('✅ روی اتصال فعلی اعمال شد');
    } catch (e) { /* the pane already switched; a failed save shows on next load */ }
    setDediDnsToggleUi();
    // Each mode has its own worker, so "is one deployed?" changes with the mode — and the
    // server may have just re-pointed a running bridge at the other worker.
    loadDediDnsSystem();
}

// Health of each deployed worker, filled in asynchronously by checkDediDnsWorkers().
let dediDnsWorkerHealth = null;

function renderDediDnsModeUi() {
    const mode = dediDnsConfig.mode === 'doh' ? 'doh' : 'ecs';
    const labels = { ecs: '🌍 مکان‌یابی سرور', doh: '⚡ سرعت و پینگ' };
    for (const m of ['ecs', 'doh']) {
        const tab = document.getElementById('dedidns-tab-' + m);
        const pane = document.getElementById('dedidns-pane-' + m);
        const on = m === mode;
        if (tab) {
            tab.style.background = on ? 'var(--mv-accent-soft)' : 'transparent';
            tab.style.color = on ? 'var(--mv-blue-ink)' : 'var(--mv-label-2)';
            tab.style.borderColor = on ? 'var(--mv-accent-ring)' : 'var(--mv-sep-2)';
            // A deployed-but-dead worker is invisible otherwise: the URL is saved, the
            // panel looks configured, and the first sign of trouble is an error on a
            // different button entirely.
            const h = dediDnsWorkerHealth && dediDnsWorkerHealth[m];
            const badge = !h || !h.deployed ? '' : (h.alive ? ' ✅' : ' ⚠️');
            tab.textContent = labels[m] + badge;
            tab.title = !h || !h.deployed ? 'هنوز مستقر نشده'
                      : h.alive ? h.url + ' — سالم'
                      : h.url + ' — پاسخ نمی‌دهد، دوباره مستقر کن';
        }
        if (pane) pane.style.display = on ? 'block' : 'none';
    }
}

async function checkDediDnsWorkers() {
    try {
        const r = await (await fetch('/api/dedidns/workers')).json();
        if (!r.error) { dediDnsWorkerHealth = r; renderDediDnsModeUi(); }
    } catch (e) { /* badges are an extra, never a blocker */ }
}

function setDediDnsToggleUi() {
    const btn = document.getElementById('dedidns-toggle-btn');
    const lbl = document.getElementById('dedidns-state-label');
    if (!btn || !lbl) return;
    const mode = dediDnsConfig.mode === 'doh' ? 'doh' : 'ecs';
    const url = dediDnsUrlFor(mode);
    const modeName = mode === 'doh' ? 'سرعت و پینگ' : 'مکان‌یابی سرور';
    const configured = !!url;
    btn.disabled = !configured;
    btn.style.opacity = configured ? '1' : '.5';
    if (dediDnsConfig.enabled && configured) {
        btn.textContent = 'خاموش کردن';
        btn.style.background = 'var(--mv-red-fill)';
        lbl.textContent = `روشن (${modeName}) — ${url}`;
        lbl.style.color = 'var(--mv-green-ink)';
    } else {
        btn.textContent = 'روشن کردن';
        btn.style.background = 'var(--mv-accent)';
        lbl.textContent = configured ? `آماده (${modeName}) — ${url}` : `حالت «${modeName}» هنوز مستقر نشده`;
        lbl.style.color = 'var(--mv-label-2)';
    }
}

async function loadDediDns() {
    renderDediDnsAccounts();
    try {
        const data = await dediDnsApi('status');
        dediDnsConfig = data.config || dediDnsConfig;
        dediDnsRegions = data.regions || [];
        dediDnsGroups = data.dohGroups || [];
        renderDediDnsRegions();
        renderDediDnsGroups();
        renderDediDnsModeUi();
        setDediDnsToggleUi();
        loadDediDnsSystem();
        checkDediDnsWorkers();
        loadDediDnsRouteStats();
    } catch (e) {
        const lbl = document.getElementById('dedidns-state-label');
        if (lbl) { lbl.textContent = 'خطا در ارتباط با سرور محلی'; lbl.style.color = 'var(--mv-red-ink)'; }
    }
}

async function deployDediDns(mode) {
    const workerMode = mode === 'doh' ? 'doh' : 'ecs';
    const sel = document.getElementById('dedidns-account');
    const regionSel = document.getElementById('dedidns-region');
    const groupSel = document.getElementById('dedidns-dohgroup');
    const btn = document.getElementById(workerMode === 'doh' ? 'dedidns-deploy-doh-btn' : 'dedidns-deploy-btn');
    const out = document.getElementById('dedidns-deploy-result');
    const accId = sel && sel.value;
    if (!accId) { out.innerHTML = '<span style="color:var(--mv-orange-ink);">اول یک حساب کلادفلر انتخاب کن.</span>'; return; }
    const acc = dediDnsLoadAccounts().find(a => a.id === accId);
    if (!acc) { out.innerHTML = '<span style="color:var(--mv-red-ink);">حساب یافت نشد.</span>'; return; }

    btn.disabled = true; btn.textContent = '…';
    out.innerHTML = '<span style="color:var(--mv-label-3);">در حال استقرار Worker روی کلادفلر…</span>';
    try {
        const r = await dediDnsApi('deploy', {
            token: acc.token,
            email: acc.email,
            mode: workerMode,
            region: regionSel ? regionSel.value : 'AE',
            dohGroup: groupSel ? groupSel.value : 'standard',
        });
        if (r.error) { out.innerHTML = `<span style="color:var(--mv-red-ink);">خطا: ${r.error}</span>`; }
        else {
            dediDnsConfig = r.config || dediDnsConfig;
            const name = workerMode === 'doh' ? 'سرعت و پینگ' : 'مکان‌یابی سرور';
            // `pending` means the upload succeeded but Cloudflare's route is still coming
            // up. That is not a failure and must not read like one, or the user re-deploys
            // and ends up with a second worker for no reason.
            out.innerHTML = r.pending
                ? `<div style="color:var(--mv-orange-ink);">⏳ حالت «${name}» مستقر شد؛ مسیرش روی کلادفلر هنوز بالا نیامده و طی چند دقیقه آماده می‌شود.
                     <b>دوباره استقرار نزن.</b><div style="direction:ltr; font-size:11px; color:var(--mv-label-2); margin-top:3px;">${r.url}</div></div>`
                : `<div style="color:var(--mv-green-ink);">✅ حالت «${name}» مستقر و روشن شد:<div style="direction:ltr; font-size:11px; color:var(--mv-label-2); margin-top:3px;">${r.url}</div></div>`;
            renderDediDnsModeUi();
            setDediDnsToggleUi();
            // The system-wide card decides "deployed or not" from the server, and it was
            // rendered before this deploy existed. Without this refresh its button stays
            // greyed out until the panel is reopened, which reads as a broken button.
            loadDediDnsSystem();
            checkDediDnsWorkers();
            if (typeof toast === 'function') toast('✅ DNS اختصاصی مستقر و روشن شد');
        }
    } catch (e) { out.innerHTML = `<span style="color:var(--mv-red-ink);">خطا: ${e.message}</span>`; }
    btn.disabled = false; btn.textContent = 'استقرار';
}

// Cold vs warm resolve time. The warm number is the edge-cache hit — the gap between the
// two is exactly the DNS wait this mode takes out of every new connection.
async function measureDediDns() {
    const btn = document.getElementById('dedidns-measure-btn');
    const out = document.getElementById('dedidns-measure-result');
    if (!dediDnsUrlFor('doh')) { out.innerHTML = '<span style="color:var(--mv-orange-ink);">اول این حالت را مستقر کن.</span>'; return; }
    btn.disabled = true; btn.textContent = 'در حال تست…';
    out.innerHTML = '';
    try {
        const r = await dediDnsApi('measure', { mode: 'doh' });
        if (r.error) out.innerHTML = `<span style="color:var(--mv-red-ink);">خطا: ${r.error}</span>`;
        else {
            const rows = (r.results || []).map(x =>
                `<div style="display:flex; justify-content:space-between; gap:8px;">
                   <span dir="ltr" style="color:${x.ok ? 'var(--mv-label-2)' : 'var(--mv-red-ink)'};">${x.domain}</span>
                   <span dir="ltr">${x.ok ? `${x.coldMs}ms → <b style="color:var(--mv-green-ink);">${x.warmMs}ms</b>` : 'ناموفق'}</span>
                 </div>`).join('');
            out.innerHTML = rows + `<div style="margin-top:6px; border-top:1px dashed var(--mv-sep-2); padding-top:6px;">
                میانگین: اولین پرسش <span dir="ltr">${r.avgColdMs}ms</span> — از روی کش <b style="color:var(--mv-green-ink);" dir="ltr">${r.avgWarmMs}ms</b></div>`;
        }
    } catch (e) { out.innerHTML = `<span style="color:var(--mv-red-ink);">خطا: ${e.message}</span>`; }
    btn.disabled = false; btn.textContent = 'تست سرعت پاسخ‌دهی';
}

async function toggleDediDns() {
    const btn = document.getElementById('dedidns-toggle-btn');
    if (!dediDnsUrlFor()) { if (typeof toast === 'function') toast('اول Worker این حالت را مستقر کن'); return; }
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    try {
        const res = await dediDnsApi('config', { enabled: !dediDnsConfig.enabled });
        if (res.error) { if (typeof toast === 'function') toast('❌ ' + res.error); }
        else {
            dediDnsConfig = res.config || dediDnsConfig;
            // `applied` is the server telling us whether it actually rebuilt a live
            // tunnel. Saying "applied" when nothing was running is how this switch
            // earned its reputation for lying.
            const on = dediDnsConfig.enabled;
            const msg = res.applied
                ? (on ? '✅ روشن شد و روی اتصال فعلی اعمال شد' : '⭕ خاموش شد و از اتصال فعلی برداشته شد')
                : (on ? '✅ روشن شد — از اولین اتصال اعمال می‌شود' : '⭕ خاموش شد');
            if (typeof toast === 'function') toast(msg);
        }
    } catch (e) { if (typeof toast === 'function') toast('❌ ' + e.message); }
    if (btn) btn.disabled = false;
    setDediDnsToggleUi();
}

// --- system-wide bridge -----------------------------------------------------

let dediDnsSystem = { running: false, configured: false };

let dediDnsPollTimer = null;

async function loadDediDnsSystem() {
    try {
        dediDnsSystem = await (await fetch('/api/dedidns/system/status')).json();
    } catch (e) {
        dediDnsSystem = { running: false, configured: false, lastError: e.message };
    }
    setDediDnsSystemUi();

    // While the bridge is up, the tunnel half can come and go on its own — it starts when
    // a config connects and stops when one disconnects. A status line that only refreshes
    // on panel open would keep claiming "waiting for a config" long after one arrived.
    const wantPoll = !!dediDnsSystem.running && document.getElementById('dedidns-system-btn');
    if (wantPoll && !dediDnsPollTimer) {
        dediDnsPollTimer = setInterval(() => {
            if (!document.getElementById('dedidns-system-btn')) {
                clearInterval(dediDnsPollTimer); dediDnsPollTimer = null; return;
            }
            fetch('/api/dedidns/system/status')
                .then((r) => r.json())
                .then((s) => { if (!s.error) { dediDnsSystem = s; setDediDnsSystemUi(); } })
                .catch(() => {});
        }, 5000);
    } else if (!wantPoll && dediDnsPollTimer) {
        clearInterval(dediDnsPollTimer);
        dediDnsPollTimer = null;
    }
}

async function setDediDnsSmartTunnel(on) {
    const row = document.getElementById('dedidns-fallback-row');
    if (row) row.style.display = on ? 'block' : 'none';
    await dediDnsApi('config', { smartTunnel: on });
    if (typeof toast === 'function') {
        toast(on ? 'برای اعمال، بخش ۳ را خاموش و دوباره روشن کن' : 'تونل هوشمند خاموش شد');
    }
}

async function setDediDnsFallback(value) {
    await dediDnsApi('config', { smartFallback: value });
    if (typeof toast === 'function') toast('برای اعمال، بخش ۳ را خاموش و دوباره روشن کن');
}

function setDediDnsSystemUi() {
    const btn = document.getElementById('dedidns-system-btn');
    const lbl = document.getElementById('dedidns-system-label');
    if (!btn || !lbl) return;
    const s = dediDnsSystem || {};

    const chk = document.getElementById('dedidns-smart-tunnel');
    const row = document.getElementById('dedidns-fallback-row');
    const fb = document.getElementById('dedidns-fallback');
    if (chk) chk.checked = s.smartTunnel !== false;
    if (row) row.style.display = (s.smartTunnel !== false) ? 'block' : 'none';
    if (fb) fb.value = s.smartFallback || 'direct';
    // Never hard-disable on a stale "not configured": the click re-checks with the server
    // first, so a status that went out of date can no longer strand the button.
    btn.disabled = false;
    btn.style.opacity = s.configured ? '1' : '.6';
    if (s.running) {
        btn.textContent = 'خاموش کردن';
        btn.style.background = 'var(--mv-red-fill)';
        // Two different capabilities, two different states. Saying only "فعال" when the
        // tunnel half never started is how a user ends up expecting YouTube to open.
        const dnsPart = `DNS فعال روی ${s.address}${s.queries ? ` (${s.queries} پرسش، ${s.cacheHits} از کش)` : ''}`;
        const tunnelPart = s.smartTunnel === false
            ? 'تونل خاموش'
            : s.tunnelRunning
                ? 'تونل هوشمند فعال — سایت فیلتر باز می‌شود'
                : s.proxyRunning ? 'تونل بالا نیامد' : 'تونل روشن نشد — پیام زیر را ببین';
        lbl.textContent = `${dnsPart} · ${tunnelPart}`;
        lbl.style.color = (s.smartTunnel !== false && !s.tunnelRunning) ? 'var(--mv-orange-ink)' : 'var(--mv-green-ink)';
    } else if (s.tunnelRunning) {
        // The bridge can be impossible (another DNS client owning port 53) while the tunnel
        // half works perfectly. Calling that "off" would be wrong — blocked sites do open.
        btn.textContent = 'خاموش کردن';
        btn.style.background = 'var(--mv-red-fill)';
        lbl.textContent = 'تونل هوشمند فعال — DNS داخل تونل حل می‌شود (سرویس محلی روشن نشد)';
        lbl.style.color = 'var(--mv-orange-ink)';
    } else {
        btn.textContent = 'روشن کردن';
        btn.style.background = 'var(--mv-green-fill)';
        lbl.textContent = s.configured ? 'خاموش — DNS ویندوز دست‌نخورده است' : 'اول Worker را مستقر کن';
        lbl.style.color = 'var(--mv-label-2)';
    }
}

async function toggleDediDnsSystem() {
    const btn = document.getElementById('dedidns-system-btn');
    const out = document.getElementById('dedidns-test-result');

    // Re-read before acting: the card may have been rendered before a deploy happened.
    await loadDediDnsSystem();
    if (!dediDnsSystem.configured && !dediDnsSystem.running) {
        if (out) out.innerHTML = '<span style="color:var(--mv-orange-ink);">اول از بخش ۱ یک Worker مستقر کن.</span>';
        if (typeof toast === 'function') toast('اول Worker را مستقر کن');
        return;
    }

    const turningOn = !dediDnsSystem.running;
    btn.disabled = true; btn.textContent = '…';
    // Enabling can also connect a proxy and raise a TUN adapter, which takes seconds. Say
    // what is happening, or the wait reads as a hang and the user clicks again.
    if (out) out.innerHTML = turningOn
        ? '<span style="color:var(--mv-label-3);">در حال اتصال خودکار، بالا آوردن سرویس DNS و تنظیم ویندوز (تأیید دسترسی مدیر لازم است)…<br>ممکن است تا ۳۰ ثانیه طول بکشد.</span>'
        : '<span style="color:var(--mv-label-3);">در حال برگرداندن DNS ویندوز…</span>';
    try {
        const r = await (await fetch('/api/dedidns/system/' + (turningOn ? 'enable' : 'disable'), { method: 'POST' })).json();
        if (r.error) {
            // The enable path returns a multi-line diagnosis (which worker, which URL,
            // whether the other one is alive); collapsing it to one line throws away the
            // part that says what to do next.
            if (out) out.innerHTML = `<div style="color:var(--mv-red-ink); white-space:pre-line; line-height:1.8; word-break:break-all;">${r.error}</div>`;
            if (typeof toast === 'function') toast('❌ ' + String(r.error).split('\n')[0]);
        } else {
            // enable may report that it fell back to the other mode's worker; that changes
            // what the feature is doing, so it gets said out loud rather than buried.
            // Report the tunnel half explicitly. It is the part that opens filtered sites,
            // and it can legitimately fail while the DNS half succeeds.
            const notes = [];
            if (r.message) notes.push(`⚠️ ${r.message}`);
            if (r.tunnel && !r.tunnel.started && r.tunnel.reason !== 'disabled') {
                notes.push(`⚠️ ${r.tunnel.message || 'تونل هوشمند روشن نشد.'}`);
            }
            if (r.tunnel && r.tunnel.started) {
                notes.push(r.tunnel.fallback === 'tunnel'
                    ? '✅ تونل هوشمند فعال — هر سایتی باز می‌شود'
                    : '✅ تونل هوشمند فعال — سایت‌های فیلتر/تحریم از کانفیگ رد می‌شوند');
            }
            if (out) out.innerHTML = notes.length
                ? `<div style="color:var(--mv-orange-ink); line-height:1.8; white-space:pre-line;">${notes.join('\n')}</div>`
                : '';
            if (typeof toast === 'function') toast(turningOn ? '✅ روی کل ویندوز فعال شد' : '⭕ خاموش شد و DNS ویندوز برگشت');
            if (turningOn) { await loadDediDns(); }
        }
    } catch (e) {
        if (out) out.innerHTML = `<span style="color:var(--mv-red-ink);">${e.message}</span>`;
    }
    await loadDediDnsSystem();
}

// The only honest proof: resolve a name through the bridge and show the IP. A hijacked
// answer (10.10.34.x) means the lookup never reached the worker; a real IP that still
// will not open means the site is blocked by IP/SNI, which no DNS can fix.
const DEDIDNS_VERDICTS = {
    iran:           { icon: '🇮🇷', color: 'var(--mv-green-ink)', label: 'ایرانی', route: 'مستقیم می‌رود — تونل لازم ندارد' },
    'dns-poisoned': { icon: '🧭', color: 'var(--mv-green-ink)', label: 'جعل DNS', route: 'با DNS تمیز باز می‌شود — مستقیم و با سرعت کامل' },
    clean:          { icon: '✅', color: 'var(--mv-green-ink)', label: 'باز است', route: 'مستقیم می‌رود — تونل لازم ندارد' },
    filtered:       { icon: '🚫', color: 'var(--mv-orange-ink)', label: 'فیلتر', route: 'از تونل رد می‌شود' },
    sanctioned:     { icon: '⛔', color: 'var(--mv-orange-ink)', label: 'تحریم', route: 'از تونل رد می‌شود' },
    unknown:        { icon: '❔', color: 'var(--mv-label-2)', label: 'نامشخص', route: 'طبق تنظیم پیش‌فرض' },
};

// Classify the domain and remember the answer, so routing never has to measure it again.
async function testDediDnsSystem(force) {
    const btn = document.getElementById('dedidns-test-btn');
    const out = document.getElementById('dedidns-test-result');
    const domain = (document.getElementById('dedidns-test-domain').value || '').trim();
    if (!domain) return;
    btn.disabled = true; btn.textContent = '…';
    out.innerHTML = '<span style="color:var(--mv-label-3);">در حال تشخیص وضعیت سایت…</span>';
    try {
        const r = await (await fetch('/api/dedidns/classify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, force: !!force }),
        })).json();
        if (r.error) { out.innerHTML = `<span style="color:var(--mv-red-ink);">خطا: ${r.error}</span>`; }
        else {
            const v = r.results[0] || { verdict: 'unknown' };
            const info = DEDIDNS_VERDICTS[v.verdict] || DEDIDNS_VERDICTS.unknown;
            out.innerHTML = `
              <div style="color:${info.color}; font-weight:700;">${info.icon} ${v.domain || domain} — ${info.label}</div>
              <div style="color:var(--mv-label-2); margin-top:3px;">${info.route}</div>
              ${v.reason ? `<div style="color:var(--mv-label-2); margin-top:3px;">${v.reason}</div>` : ''}
              <div style="color:var(--mv-label-3); margin-top:5px; font-size:10px;">
                ${v.cached ? 'از حافظه — دوباره تست نشد' : 'تازه سنجیده و ذخیره شد'}
                ${v.verdict !== 'unknown' ? ` · <a href="#" onclick="testDediDnsSystem(true);return false;" style="color:var(--mv-blue-ink);">سنجش دوباره</a>` : ''}
              </div>`;
            loadDediDnsRouteStats();
        }
    } catch (e) {
        out.innerHTML = `<span style="color:var(--mv-red-ink);">خطا: ${e.message}</span>`;
    }
    btn.disabled = false; btn.textContent = 'تست';
}

async function loadDediDnsRouteStats() {
    const el = document.getElementById('dedidns-route-stats');
    if (!el) return;
    try {
        const r = await (await fetch('/api/dedidns/routes')).json();
        if (r.error) return;
        const c = r.stats.counts || {};
        const parts = [];
        for (const [k, info] of Object.entries(DEDIDNS_VERDICTS)) {
            if (c[k]) parts.push(`${info.icon} ${c[k]} ${info.label}`);
        }
        el.innerHTML = r.stats.fresh
            ? `حافظه‌ی مسیرها: ${parts.join(' · ')} — این‌ها دیگر سنجیده نمی‌شوند.
               <a href="#" onclick="forgetDediDnsRoutes();return false;" style="color:var(--mv-blue-ink);">پاک کردن</a>`
            : 'حافظه‌ی مسیرها خالی است — هر سایتی که تست کنی این‌جا ذخیره می‌شود.';
    } catch (e) { /* stats are informational */ }
}

async function forgetDediDnsRoutes() {
    await fetch('/api/dedidns/routes/forget', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ all: true }),
    });
    if (typeof toast === 'function') toast('حافظه‌ی مسیرها پاک شد');
    loadDediDnsRouteStats();
}

function initDediDnsModule() {
    const container = document.getElementById('ls-dedidns');
    if (!container) return;
    container.innerHTML = dediDnsHtmlTemplate;
    if (container.parentElement) container.parentElement.style.position = 'relative';
    container.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent; z-index:10;';
    loadDediDns();
}
