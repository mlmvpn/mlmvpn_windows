// --- «ضد فیلتر SNI»: the front and the config that rides it, as ONE connection (as on Android) ---
//
// This window used to be half a feature. It started the local TLS front and stopped there — and
// the front carries no traffic by itself; it is a door a config has to walk through. The other
// half lived in V2Ray: build SNI configs from its «+» menu, find them in the list, connect one
// there. Nothing on either screen mentioned the other, so the ordinary outcome was turning this
// on, reading "running", and concluding the app was broken.
//
// Now the whole thing is here, as on Android (EmergencyLevel3Screen / SniSession): one button
// applies the chosen entry point, brings the front up — and waits until it is really listening —
// then connects the chosen SNI config through it with Xray, and the status line names which of
// those is happening. Stopping takes them down in the reverse order: the config first, because
// pulling the front out from under a running config reads as a failure, not a disconnect.
//
// Two lists, two different questions:
//   entry points (sniList) — which Cloudflare edge address, under which forged name, the FRONT
//                            dials: one TLS handshake each, cheap, all at once;
//   SNI configs            — which config is fastest THROUGH the front: a real proxied request
//                            each, expensive, three at a time (more against one edge inflates
//                            every reading). They are V2Ray nodes pointing at 127.0.0.1:40443,
//                            picked out by that destination (sni-builder.js › isSniUri).
// The CONNECT button measures both, in the only order in which either answer means anything —
// but only for the half the user has not chosen themselves. The two manual buttons measure one
// list each and change no selection, so looking is never the same as deciding.

let sniList = [];
// The entry point the front is running right now, or null. Also read by the desktop icon's lamp.
let activeSniConfig = null;

const SNI_LOCAL = '127.0.0.1:40443';
const sniUi = {
    routeKey: null,
    configId: null,
    stage: 'idle',          // idle | picking | front | tunnel | running | stopping | failed
    error: '',
    liveUri: null,          // the SNI config Xray is running, when it is one of ours
    frontUp: false,
    scanning: false,
    measuring: false,
    measured: [0, 0],
    delays: {},             // config id -> ms (> 0), 0 = did not answer; absent = never measured
    building: false,
};

const sniRouteKey = (r) => `${r.CONNECT_IP}:${r.CONNECT_PORT || 443}|${r.FAKE_SNI}`;
const sniEsc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sniFa = (n) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

function sniConfigs() {
    return (window.v2rayList || []).filter((n) => n && typeof window.isSniUri === 'function' && window.isSniUri(n.uri));
}
function sniSelectedConfig() {
    const all = sniConfigs();
    return all.find((c) => c.id === sniUi.configId) || all[0] || null;
}
function sniSelectedRoute() {
    return sniList.find((r) => sniRouteKey(r) === sniUi.routeKey) || sniList[0] || null;
}
function sniRouteConfig(r) {
    return {
        LISTEN_HOST: r.LISTEN_HOST || '0.0.0.0',
        LISTEN_PORT: r.LISTEN_PORT || 40443,
        CONNECT_IP: r.CONNECT_IP,
        CONNECT_PORT: r.CONNECT_PORT || 443,
        FAKE_SNI: r.FAKE_SNI,
    };
}

async function sniCall(url, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch (e) { /* an empty reply is still an answer */ }
    if (!res.ok && !data.error) data.error = `پاسخ ${res.status} از برنامه`;
    if (data.error) data.error = String(data.error).replace(/\s*\(__dirname:[^)]*\)\s*$/, '');
    return data;
}

const SNI_SECTIONS = [
    { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
    { id: 'configs', label: 'کانفیگ‌های SNI', icon: 'ph-fill ph-plugs-connected', tint: 'var(--mv-blue)' },
    { id: 'build', label: 'ساخت کانفیگ SNI', icon: 'ph-fill ph-magic-wand', tint: 'var(--mv-indigo)' },
    { id: 'routes', label: 'مسیرهای ورودی', icon: 'ph-fill ph-signpost', tint: 'var(--mv-pink, #FF2D55)' },
];

// The run, as four stages. They are the real ones the connect path goes through (sniUi.stage), not
// a decorative progress bar: «picking» only happens when the user has chosen neither half.
const SNI_STEPS = [
    { key: 'picking', fa: 'انتخاب مسیر و کانفیگ' },
    { key: 'front', fa: 'موتور SNI' },
    { key: 'tunnel', fa: 'اتصال کانفیگ' },
    { key: 'running', fa: 'روشن' },
];

const sniHtmlTemplate = `
<!-- The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one سایفون and ماسک wear:
     a sidebar of sections, a hero built around ONE button with the live traffic beside it, and each
     of this window's two decisions — which entry point, which config — as a card of its own. -->
<div id="sni-wrapper" class="sni-page mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های موتور ضد فیلتر SNI">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="sni-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${SNI_SECTIONS.map(x => `
        <button type="button" class="mv-side-item" data-sni-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="sni-store" title="هستهٔ Xray در ام‌ال‌ام استور — کانفیگ‌های SNI روی آن اجرا می‌شوند">
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
        <button type="button" id="sni-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="sni-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="sni-results-container">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="sni-stage" style="--tint:var(--mv-purple)"></div>
        <div class="mv-eng-flow" id="sni-flow" style="display:none"><div class="mv-steps" id="sni-steps"></div></div>
        <div class="mv-eng-grid" id="sni-cards"></div>
        <div class="mv-form mv-eng-adv" id="sni-adv"></div>
      </div>
      <div class="mv-eng-sec" data-sec="configs"><div class="mv-form" id="sni-sec-configs"></div></div>
      <div class="mv-eng-sec" data-sec="build"><div class="mv-form" id="sni-sec-build"></div></div>
      <div class="mv-eng-sec" data-sec="routes"><div class="mv-form" id="sni-sec-routes"></div></div>
    </div>

    <div class="mv-eng-foot" id="sni-foot"></div>
  </section>
</div>

<!-- SNI Import Modal — a sheet on the page kit; its open/close classes are the logic's. -->
<div id="sni-import-modal" class="fixed inset-0 z-50 flex items-center justify-center bg-mv-scrim opacity-0 pointer-events-none transition-opacity duration-300" dir="rtl">
  <div id="sni-import-modal-content" class="sni-sheet scale-95">
    <div class="sni-sheet-head">
      <h3>وارد کردن دستی مسیر ورودی</h3>
      <button type="button" onclick="closeSniImportModal()" class="sni-sheet-x" aria-label="بستن">
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>
      </button>
    </div>
    <div class="sni-sheet-body">
      <p class="mv-form-footer" style="margin:0 0 8px">یک مسیر یا فهرستی از مسیرها به شکل JSON؛ تکراری‌ها کنار گذاشته می‌شوند.</p>
      <textarea id="sni-modal-input" class="mv-field sni-json" dir="ltr" placeholder="[\n  {\n    &quot;LISTEN_HOST&quot;: &quot;0.0.0.0&quot;,\n    &quot;LISTEN_PORT&quot;: 40443,\n    &quot;CONNECT_IP&quot;: &quot;1.2.3.4&quot;,\n    &quot;CONNECT_PORT&quot;: 443,\n    &quot;FAKE_SNI&quot;: &quot;example.com&quot;\n  }\n]"></textarea>
    </div>
    <div class="sni-sheet-foot">
      <button type="button" onclick="closeSniImportModal()" class="mv-btn">انصراف</button>
      <button type="button" onclick="loadSniNodesFromModal()" class="mv-btn mv-btn--primary">وارد کردن</button>
    </div>
  </div>
</div>

<style>
  .sni-page { position: relative; width: 100%; height: 100%; display: flex; overflow: hidden; background: var(--mv-pane); color: var(--mv-label); }
  .sni-list-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; margin-bottom: 7px; }
  .sni-list-head .mv-form-header { margin-bottom: 0; }
  .sni-list-tools { display: flex; flex-wrap: wrap; gap: 6px; }
  .sni-table tbody tr { cursor: pointer; }
  .sni-table .sni-dom { font-weight: 600; }
  .sni-table td.sni-tick { width: 22px; text-align: center; }
  .sni-table td.sni-method { width: 30px; text-align: center; color: var(--mv-label-3); font-family: var(--mv-font-tech); }
  .sni-table .sni-name { max-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 100%; }
  .sni-build-row { display: flex; align-items: center; gap: 10px; }
  .sni-sheet { width: min(92vw, 520px); display: flex; flex-direction: column; overflow: hidden; border-radius: 16px; background: var(--mv-pane); box-shadow: var(--mv-e5); color: var(--mv-label); transition: transform var(--mv-d-2) var(--mv-ease-spring); }
  .sni-sheet.scale-95 { transform: scale(.96); }
  .sni-sheet.scale-100 { transform: none; }
  .sni-sheet-head { display: flex; align-items: center; justify-content: space-between; height: 48px; padding-inline: 18px 12px; box-shadow: inset 0 calc(-1 * var(--mv-hl)) 0 var(--mv-sep); }
  .sni-sheet-head h3 { margin: 0; font-size: 14px; font-weight: 700; }
  .sni-sheet-x { width: 26px; height: 26px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: var(--mv-fill); color: var(--mv-label-2); cursor: default; }
  .sni-sheet-x svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; }
  .sni-sheet-body { padding: 14px 18px; }
  .sni-json { width: 100%; height: 190px; padding: 10px 12px; resize: vertical; font-family: var(--mv-font-mono); font-size: 12px; line-height: 1.6; text-align: left; }
  .sni-sheet-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; box-shadow: inset 0 var(--mv-hl) 0 var(--mv-sep); }
</style>
`;

// ── entry points: storage ────────────────────────────────────────────────────

function saveSniNodes() {
    PersistentStorage.setItem('sni_nodes', JSON.stringify(sniList));
}

function loadSniNodes() {
    try {
        const saved = PersistentStorage.getItem('sni_nodes');
        if (saved) sniList = JSON.parse(saved);
    } catch (e) {
        console.error('Failed to load SNI nodes', e);
    }

    // THE ENTRY POINTS EVERY INSTALL CARRIES — all of them, in the list, from the first open.
    //
    // Ten of these used to sit behind a «مسیرهای پیش‌فرض» button that had to be pressed before
    // the panel could do anything, while the other nine were seeded silently. Two ways of
    // shipping the same kind of thing, and a button whose only outcome was «۱۰ مسیر اضافه شد».
    // Nothing here needs a decision from the user, so nothing here asks for one.
    //
    // SEVERAL METHODS, BECAUSE ONE DOES NOT REACH EVERY PROVIDER.
    //
    // An entry point is an edge address plus the name put on the handshake, and which PAIRS get
    // through is a property of the network the user is on — not of the app. The same install
    // connected on one Iranian mobile network and not on another, and the reason turned out to
    // be plain: the addresses the second one answers on were not in this list at all.
    //
    // `method` groups the pairs that belong together, and the names are deliberately neutral.
    // Naming providers here would be wrong twice over: it would be guessing at the user's
    // network, and it would go stale the week an operator changes what it blocks. The app does
    // not need the name — «تست مسیرها» measures all of them and the connect button takes the
    // fastest that answered, which is the same question asked properly.
    const SEED = [
        // ۱ — the set this app has always carried.
        ...['199.181.197.1', '103.160.204.34', '185.193.30.94', '45.8.211.57', '159.112.235.52',
            '170.114.45.239', '188.42.88.24', '88.216.67.230', '45.130.125.75']
            .map((ip) => ({ CONNECT_IP: ip, FAKE_SNI: 'chatgpt.com', method: 1 })),
        // ۲ — public CDN names, against the edges that serve them.
        { CONNECT_IP: '151.101.130.219', FAKE_SNI: 'speedtest.net', method: 2 },
        { CONNECT_IP: '85.9.112.219', FAKE_SNI: 'www.hcaptcha.com', method: 2 },
        { CONNECT_IP: '162.159.152.4', FAKE_SNI: 'cdn.medium.com', method: 2 },
        { CONNECT_IP: '104.18.183.237', FAKE_SNI: 'chartjs.org', method: 2 },
        { CONNECT_IP: '104.18.0.22', FAKE_SNI: 'unpkg.com', method: 2 },
        { CONNECT_IP: '104.18.11.207', FAKE_SNI: 'bootstrapcdn.com', method: 2 },
        { CONNECT_IP: '104.17.156.85', FAKE_SNI: 'cloudflare.net', method: 2 },
        { CONNECT_IP: '104.16.147.32', FAKE_SNI: 'static.codepen.io', method: 2 },
        { CONNECT_IP: '104.18.35.46', FAKE_SNI: 'replit.com', method: 2 },
        // ۳ — the pair the upstream SNI-Spoofing project ships as its own default, and the
        // neighbour of it this app already carried.
        { CONNECT_IP: '188.114.98.0', FAKE_SNI: 'auth.vercel.com', method: 3 },
        { CONNECT_IP: '188.114.98.0', FAKE_SNI: 'security.vercel.com', method: 3 },
        // ۴–۶ — from the UAC SNI Spoofer desktop project, which keeps one tuned edge/name pair
        // per provider instead of one list for everyone (uac_desktop/models.py ›
        // carrier_preset, fragment_proxy.py › _routes). Its per-provider labels are dropped;
        // what is worth having is the PAIRS, because they are addresses this app never tried.
        { CONNECT_IP: '104.18.8.83', FAKE_SNI: 'www.speedtest.net', method: 4 },
        { CONNECT_IP: '104.18.9.83', FAKE_SNI: 'www.speedtest.net', method: 4 },
        { CONNECT_IP: '104.18.1.1', FAKE_SNI: 'www.speedtest.net', method: 5 },
        { CONNECT_IP: '172.66.0.1', FAKE_SNI: 'www.speedtest.net', method: 5 },
        { CONNECT_IP: '104.19.229.21', FAKE_SNI: 'chatgpt.com', method: 6 },
        { CONNECT_IP: '104.19.230.21', FAKE_SNI: 'chatgpt.com', method: 6 },
        { CONNECT_IP: '104.18.32.47', FAKE_SNI: 'chatgpt.com', method: 6 },
        { CONNECT_IP: '172.64.155.209', FAKE_SNI: 'chatgpt.com', method: 6 },
    ];
    let added = false;
    SEED.forEach((d) => {
        const found = sniList.find((s) => s.CONNECT_IP === d.CONNECT_IP && s.FAKE_SNI === d.FAKE_SNI);
        if (found) {
            // An install from before the methods existed has the older rows with no label.
            if (!found.method) { found.method = d.method; added = true; }
            return;
        }
        sniList.push({
            id: `seed-${d.FAKE_SNI}-${d.CONNECT_IP}`,
            LISTEN_HOST: '0.0.0.0', LISTEN_PORT: 40443, CONNECT_PORT: 443,
            CONNECT_IP: d.CONNECT_IP, FAKE_SNI: d.FAKE_SNI, method: d.method,
        });
        added = true;
    });
    if (added) saveSniNodes();

    try { sniUi.routeKey = PersistentStorage.getItem('sni_route_key') || null; } catch (e) { /* none */ }
    try { sniUi.configId = PersistentStorage.getItem('sni_selected_config_id') || null; } catch (e) { /* none */ }
}

// ── the server's truth ───────────────────────────────────────────────────────

async function refreshSni() {
    try {
        const [s, t] = await Promise.all([sniCall('/api/sni/status'), sniCall('/api/v2ray/traffic')]);
        if (!s.error) {
            sniUi.frontUp = !!s.running;
            const c = s.config;
            activeSniConfig = s.running && c ? (sniList.find(r => r.CONNECT_IP === c.CONNECT_IP && r.FAKE_SNI === c.FAKE_SNI) || c) : null;
        }
        if (!t.error) {
            const live = t.running ? sniConfigs().find(n => n.uri === t.uri) : null;
            sniUi.liveUri = live ? live.uri : null;
        }
        // Only the flows below move a busy stage; everything else is read off the server.
        if (!['picking', 'front', 'tunnel', 'stopping'].includes(sniUi.stage)) {
            sniUi.stage = sniUi.frontUp && sniUi.liveUri ? 'running' : (sniUi.stage === 'failed' ? 'failed' : 'idle');
        }
    } catch (e) { /* the server is not answering: the window shows the idle state */ }
    renderSniList();
}

// ── one button ───────────────────────────────────────────────────────────────

async function sniConnect() {
    if (!sniConfigs().length) { toast('هنوز کانفیگ SNI ندارید. از کانفیگ‌هایی که دارید بسازید — دکمه‌اش در همین پنجره است.'); return; }
    if (!sniList.length) { toast('❌ هیچ مسیر ورودی‌ای نیست — با «وارد کردن دستی» یکی اضافه کنید.'); return; }
    sniUi.error = '';

    // CHOOSING IS PART OF CONNECTING, when the user has not chosen.
    //
    // There used to be a separate «اندازه‌گیری و انتخاب سریع‌ترین» button that had to be pressed
    // before the connect button could work for a first-time user — and pressing connect first
    // simply used sniList[0], an arbitrary entry point that is dead on most lines. Neither half
    // of this pair means anything until measured, and measuring them is not a decision the user
    // has to make: it is what has to happen before the connection can. Their own choice, once
    // made, is never overridden — `routeKey`/`configId` are only null until someone picks.
    try {
        if (!sniUi.routeKey) {
            sniUi.stage = 'picking';
            renderSniList();
            await testSniRoutes({ auto: true });
        }
        if (!sniUi.configId && sniConfigs().length > 1) {
            sniUi.stage = 'picking';
            renderSniList();
            await testSniConfigs({ auto: true });
        }
    } catch (e) {
        // A failed measurement is not a failed connect: fall through with whatever is selected.
        sniUi.error = '';
    }

    const cfg = sniSelectedConfig();
    const route = sniSelectedRoute();
    if (!cfg || !route) { sniUi.stage = 'idle'; renderSniList(); return; }
    sniUi.stage = 'front';
    renderSniList();
    try {
        // 1 — the front, on the chosen entry point; answered only once it is really listening.
        const d1 = await sniCall('/api/sni/start', { config: sniRouteConfig(route), wait: true });
        if (d1.error) throw new Error(d1.error);
        activeSniConfig = route;

        // 2 — the config through it: the full tunnel when that is on, otherwise the system proxy.
        sniUi.stage = 'tunnel';
        renderSniList();
        const q = await sniCall('/api/quick/status');
        const useSystemProxy = !(q && q.tunnelWanted) && !(q && q.proxyMode === 'port');
                    // `solo`: this panel connects the ONE thing the user picked, so nothing else may be
            // merged in beside it. Without it every «زیرساخت ابری» config joins a leastPing
            // balancer, and a balancer with no observation yet can send the first minute of
            // traffic out through any of them — which here would mean the traffic never touching the
            // front this whole window exists to put it through.
            const d2 = await sniCall('/api/v2ray/start', { uri: cfg.uri, useSystemProxy, solo: true });
        if (d2.error) throw new Error(d2.error);
        if (typeof window.markV2rayConnected === 'function') window.markV2rayConnected(cfg.name || 'SNI', { systemProxy: useSystemProxy });
        sniUi.stage = 'running';
        toast('✅ ضد فیلتر SNI روشن شد');
        if (typeof window.triggerNotification === 'function') {
            window.triggerNotification('sniStarted', 'موتور SNI', `از ${route.FAKE_SNI} روی ${SNI_LOCAL} — ${cfg.name || 'کانفیگ SNI'}`);
        }
    } catch (e) {
        sniUi.error = e.message;
        sniUi.stage = 'failed';
        // Nothing half-up is left behind: a front with no config is a door with nobody using it.
        try { await sniCall('/api/sni/stop', {}); } catch (e2) { /* already down */ }
        activeSniConfig = null;
        toast('❌ ' + e.message);
    } finally {
        await refreshSni();
    }
}

async function sniDisconnect() {
    sniUi.stage = 'stopping';
    renderSniList();
    try {
        if (sniUi.liveUri) {
            await sniCall('/api/v2ray/stop', {});
            if (typeof window.disconnectV2rayUI === 'function') window.disconnectV2rayUI();
        }
        await sniCall('/api/sni/stop', {});
        activeSniConfig = null;
        toast('⏹ ضد فیلتر SNI خاموش شد');
    } catch (e) {
        toast('❌ خطا در خاموش کردن: ' + e.message);
    } finally {
        sniUi.stage = 'idle';
        await refreshSni();
    }
}

async function toggleSniEngine() {
    if (['picking', 'front', 'tunnel', 'stopping'].includes(sniUi.stage)) return;
    if (sniUi.stage === 'running' || sniUi.frontUp) await sniDisconnect();
    else await sniConnect();
}

// ── choosing ─────────────────────────────────────────────────────────────────

/** A picked entry point applies at once; if the front is up it moves onto the new one. */
async function sniSelectRoute(key) {
    sniUi.routeKey = key;
    try { PersistentStorage.setItem('sni_route_key', key); } catch (e) { /* not fatal */ }
    renderSniList();
    const route = sniSelectedRoute();
    if (sniUi.frontUp && route && !['picking', 'front', 'tunnel', 'stopping'].includes(sniUi.stage)) {
        const d = await sniCall('/api/sni/start', { config: sniRouteConfig(route), wait: true });
        if (d.error) toast('❌ ' + d.error); else toast(`مسیر ورودی عوض شد — ${route.FAKE_SNI}`);
        await refreshSni();
    }
}

async function sniSelectConfig(id) {
    sniUi.configId = id;
    try { PersistentStorage.setItem('sni_selected_config_id', id); } catch (e) { /* not fatal */ }
    renderSniList();
    // Already connected through the front: switch the config that rides it, now.
    if (sniUi.stage === 'running') {
        const cfg = sniSelectedConfig();
        if (cfg && cfg.uri !== sniUi.liveUri) {
            sniUi.stage = 'tunnel';
            renderSniList();
            const q = await sniCall('/api/quick/status');
            const useSystemProxy = !(q && q.tunnelWanted) && !(q && q.proxyMode === 'port');
            const d = await sniCall('/api/v2ray/start', { uri: cfg.uri, useSystemProxy, solo: true });
            if (d.error) toast('❌ ' + d.error);
            else if (typeof window.markV2rayConnected === 'function') window.markV2rayConnected(cfg.name || 'SNI', { systemProxy: useSystemProxy });
            sniUi.stage = 'idle';
            await refreshSni();
        }
    }
}

// ── measuring ────────────────────────────────────────────────────────────────

/**
 * TLS handshake to every entry point at once.
 *
 * `auto` decides what happens to the ANSWER, not how it is measured: the connect path asks for
 * the fastest to be adopted (it is choosing on the user's behalf because they have not chosen),
 * the manual button does not (they are looking, and silently moving their selection under them
 * is how a list stops being trustworthy).
 */
async function testSniRoutes({ auto = false, announce = false } = {}) {
    if (sniUi.scanning || !sniList.length) return;
    sniUi.scanning = true;
    sniList.forEach(s => { s.ping = '...'; s.speed = '...'; });
    renderSniList();
    await Promise.all(sniList.map(async (s) => {
        try {
            const d = await sniCall('/api/sni/test', { ip: s.CONNECT_IP, port: s.CONNECT_PORT || 443, sni: s.FAKE_SNI });
            s.ping = d.tcp > 0 ? d.tcp + ' ms' : 'Err';
            s.speed = d.tls > 0 ? d.tls + ' ms' : 'Err';
        } catch (e) { s.ping = 'Err'; s.speed = 'Err'; }
        renderSniList();
    }));
    const val = (s) => (s.speed && !String(s.speed).includes('Err') && s.speed !== '...' ? parseInt(s.speed, 10) : Infinity);
    // Unreachable ones sink rather than vanish: one that failed on this network is still worth a tap.
    sniList.sort((a, b) => val(a) - val(b));
    saveSniNodes();
    sniUi.scanning = false;
    // Adopt the fastest, but only if it answered — on a fully blocked network, never swap a
    // working choice for a dead one.
    const best = sniList[0];
    const alive = best && val(best) < Infinity;
    if (auto && alive && sniRouteKey(best) !== sniUi.routeKey) await sniSelectRoute(sniRouteKey(best));
    else renderSniList();
    if (!auto || announce) {
        const n = sniList.filter((s) => val(s) < Infinity).length;
        toast(n ? `✅ ${sniFa(n)} از ${sniFa(sniList.length)} مسیر جواب داد${auto && alive ? ' — سریع‌ترین انتخاب شد' : ' — سریع‌ترین‌ها بالای فهرست‌اند'}`
                : '⚠️ هیچ مسیری جواب نداد — شاید اپراتور همه را بسته باشد.');
    }
    return alive;
}

/**
 * Every SNI config through the entry point that is currently chosen — a real proxied request
 * each, three at a time (more against one edge inflates every reading).
 *
 * The ROUTES are not re-measured here. They were, and it made this button do two things at once
 * with no way to ask for either: a user looking at config delays had their entry-point selection
 * moved under them as a side effect. The connect path measures both, in order, because it has to
 * choose; this button answers the one question it is labelled with.
 */
async function testSniConfigs({ auto = false } = {}) {
    const cfgs = sniConfigs();
    if (sniUi.measuring || sniUi.scanning || !cfgs.length) return;
    sniUi.measuring = true;
    sniUi.measured = [0, cfgs.length];
    renderSniList();

    // The front has to be up on the chosen entry point, or every config measures a closed port.
    // Started for this measurement only when it was not already up, and taken down again after.
    const route = sniSelectedRoute();
    let startedHere = false;
    try {
        const runningHere = sniUi.frontUp && activeSniConfig && sniRouteKey(activeSniConfig) === sniRouteKey(route || {});
        if (!runningHere) {
            const d = await sniCall('/api/sni/start', { config: sniRouteConfig(route), wait: true });
            if (d.error) throw new Error(d.error);
            startedHere = !sniUi.frontUp;
        }
        sniUi.delays = {};
        renderSniList();
        const res = await fetch('/api/v2ray/test-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodes: cfgs.map((c, i) => ({ id: i, uri: c.uri })), testType: 'delay', settings: { concurrency: 3 } }),
        });
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
                let p;
                try { p = JSON.parse(line); } catch (e) { continue; }
                if (p.done || !cfgs[p.id]) continue;
                sniUi.delays[cfgs[p.id].id] = p.val > 0 ? p.val : 0;
                sniUi.measured = [Object.keys(sniUi.delays).length, cfgs.length];
                renderSniList();
            }
        }
        const answered = cfgs.filter(c => sniUi.delays[c.id] > 0).sort((a, b) => sniUi.delays[a.id] - sniUi.delays[b.id]);
        if (auto && answered.length) await sniSelectConfig(answered[0].id);
        toast(answered.length
            ? `✅ ${sniFa(answered.length)} از ${sniFa(cfgs.length)} کانفیگ جواب داد${auto ? ' — سریع‌ترین انتخاب شد' : ''}`
            : '⚠️ هیچ کانفیگی از این مسیر جواب نداد — مسیر دیگری را امتحان کنید.');
    } catch (e) {
        toast('❌ ' + e.message);
    } finally {
        if (startedHere) { try { await sniCall('/api/sni/stop', {}); } catch (e) { /* already down */ } }
        sniUi.measuring = false;
        await refreshSni();
    }
}

// ── configs: build and delete ────────────────────────────────────────────────

function sniBuild(label) {
    if (!window.sniBuilder) return;
    const buckets = window.sniBuilder.buckets();
    const items = label === '*' ? buckets.flatMap(b => b.items) : ((buckets.find(b => b.label === label) || { items: [] }).items);
    if (!items.length) { toast('❌ کانفیگی برای تبدیل نیست'); return; }
    const r = window.sniBuilder.build(items);
    if (typeof window.renderV2rayList === 'function') window.renderV2rayList();
    sniUi.building = false;
    toast(r.added ? `✅ ساخت ${sniFa(r.added)} کانفیگ SNI انجام شد${r.skipped ? ` (${sniFa(r.skipped)} مورد از قبل بود)` : ''}` : 'ℹ️ همه‌ی این کانفیگ‌ها از قبل ساخته شده بودند');
    // Straight to the list they were added to — otherwise the page looks as if nothing happened.
    if (r.added) sniGoSec('configs'); else renderSniList();
}

async function sniDeleteConfigs(ids) {
    if (!ids.size) return;
    const live = sniConfigs().find(c => ids.has(c.id) && c.uri === sniUi.liveUri);
    // The connected one goes down FIRST, or the window would go on saying "connected" over a
    // config that no longer exists.
    if (live) await sniDisconnect();
    const before = window.v2rayList.length;
    window.v2rayList = window.v2rayList.filter(n => !(ids.has(n.id) && window.isSniUri(n.uri)));
    const gone = before - window.v2rayList.length;
    ids.forEach(id => { delete sniUi.delays[id]; });
    if (ids.has(sniUi.configId)) { sniUi.configId = null; try { PersistentStorage.removeItem('sni_selected_config_id'); } catch (e) { /* ok */ } }
    if (typeof window.saveV2rayList === 'function') window.saveV2rayList();
    if (typeof window.renderV2rayList === 'function') window.renderV2rayList();
    if (gone) toast(`${sniFa(gone)} کانفیگ SNI حذف شد`);
    renderSniList();
}

// ── drawing ──────────────────────────────────────────────────────────────────

let sniSec = 'connect';

/** Show one section, and keep the sidebar, the title and the buttons in step. */
function sniGoSec(sec) {
    const root = document.getElementById('sni-wrapper');
    if (!root) return;
    sniSec = SNI_SECTIONS.some((x) => x.id === sec) ? sec : 'connect';
    root.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === sniSec));
    root.querySelectorAll('.mv-side-item[data-sni-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-sni-sec') === sniSec));
    const found = SNI_SECTIONS.find((x) => x.id === sniSec);
    const title = document.getElementById('sni-title');
    if (title) title.textContent = found ? found.label : '';
    const back = document.getElementById('sni-back');
    if (back) back.disabled = sniSec === 'connect';
    // The home section carries no toolbar at all (page-kit.css › .mv-pane.is-home).
    const pane = root.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', sniSec === 'connect');
    const scroll = document.getElementById('sni-results-container');
    if (scroll) scroll.scrollTop = 0;
    renderSniList();
}

/**
 * One place decides the page's tone: the hero, the sidebar's dot and the footer.
 *
 * The state that matters most here is the one in the middle — the FRONT is up and no config is
 * riding it. The port is open, the window looks busy, and not one byte is being carried; this is
 * the exact misunderstanding the window was rebuilt to end, so it gets its own words.
 */
function sniView() {
    const st = sniUi.stage;
    const cfg = sniSelectedConfig();
    if (st === 'running') {
        const bits = [`کانفیگ <b>${sniEsc((cfg && cfg.name) || '—')}</b> از درگاه <code dir="ltr">${SNI_LOCAL}</code> رد می‌شود.`];
        if (activeSniConfig) {
            bits.push(`نام جعلی <code dir="ltr">${sniEsc(activeSniConfig.FAKE_SNI)}</code>`);
            bits.push(`لبه <code dir="ltr">${sniEsc(activeSniConfig.CONNECT_IP)}:${sniEsc(activeSniConfig.CONNECT_PORT || 443)}</code>`);
        }
        return { tone: 'on', head: 'روشن است', line: bits.join(' · ') };
    }
    if (st === 'picking') {
        return {
            tone: 'busy',
            head: sniUi.scanning ? 'در حال یافتن بهترین مسیر' : 'در حال یافتن بهترین کانفیگ',
            line: 'چون خودتان انتخاب نکرده بودید، اول اندازه گرفته می‌شود و سریع‌ترینی که جواب داده برداشته می‌شود.',
        };
    }
    if (st === 'front') return { tone: 'busy', head: 'در حال راه‌اندازی موتور SNI', line: 'درگاه محلی باز می‌شود و منتظر می‌مانیم تا واقعاً گوش بدهد.' };
    if (st === 'tunnel') return { tone: 'busy', head: 'در حال اتصال کانفیگ', line: 'کانفیگ انتخاب‌شده از داخل همین موتور وصل می‌شود.' };
    if (st === 'stopping') return { tone: 'busy', head: 'در حال خاموش کردن', line: 'اول کانفیگ، بعد موتور — برعکسِ روشن کردن.' };
    if (st === 'failed') {
        return {
            tone: 'bad',
            head: 'بالا نیامد',
            line: (sniUi.error ? sniEsc(sniUi.error) + ' ' : '') + '«تست مسیرها» و «تست کانفیگ‌ها» را بزنید و یکی از آن‌هایی که جواب داده را انتخاب کنید.',
        };
    }
    if (sniUi.frontUp) {
        return {
            tone: 'bad',
            head: 'موتور روشن است، ولی کانفیگی از آن رد نمی‌شود',
            line: `درگاه <code dir="ltr">${SNI_LOCAL}</code> باز است و هیچ ترافیکی داخلش نمی‌رود. یک کانفیگ SNI انتخاب کنید — یا دکمه را بزنید تا خودش انتخاب و وصل کند.`,
        };
    }
    return {
        tone: 'off',
        head: 'نام دامنه را از دید فیلترینگ پنهان می‌کند.',
        line: 'دست‌دهی TLS طوری فرستاده می‌شود که نام دامنه در یک بستهٔ کامل دیده نشود — همان چیزی که فیلترینگ روی SNI را کور می‌کند. یک دکمه هر سه را با هم انجام می‌دهد: مسیر ورودی، موتور SNI، و کانفیگی که از آن رد می‌شود.',
    };
}

const sniBusy = () => ['picking', 'front', 'tunnel', 'stopping'].includes(sniUi.stage);

/** The sidebar's own card: which window this is, and what it is doing. */
function sniRenderIdent() {
    const host = document.getElementById('sni-ident');
    if (!host) return;
    const v = sniView();
    const word = v.tone === 'on' ? 'روشن است' : v.tone === 'busy' ? 'در حال کار' : v.tone === 'bad' ? 'مشکل دارد' : 'خاموش';
    const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('sni');
    const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
        : '<span class="mv-side-tile" style="--tint:var(--mv-purple)"><svg aria-hidden="true"><use href="#g-sni"/></svg></span>';
    host.innerHTML = `${icon}
      <b>ضد فیلتر SNI</b>
      <small><i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : ''}"></i>${word}</small>`;
}

/** The hero. BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
function sniRenderStage() {
    const host = document.getElementById('sni-stage');
    if (!host) return;
    const v = sniView();

    if (host.dataset.built !== '1') {
        host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-sni-act="toggle" data-part="power">
          <i data-part="glyph"></i>
        </button>
      </div>
      <div class="mv-eng-stage-side">
        <div class="mv-eng-live" data-part="live"></div>
      </div>`;
        host.dataset.built = '1';
        host.querySelectorAll('[data-sni-act]').forEach((b) => { b.onclick = () => toggleSniEngine(); });
    }

    const q = (n) => host.querySelector(`[data-part="${n}"]`);
    q('head').innerHTML = v.head;
    q('line').innerHTML = v.line;

    const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : '';
    const btn = q('power');
    const want = 'mv-eng-power' + ring;
    if (btn.className !== want) btn.className = want;
    btn.disabled = sniBusy();
    const aria = sniUi.stage === 'running' || sniUi.frontUp ? 'خاموش کردن' : 'روشن کردن';
    btn.setAttribute('aria-label', aria);
    btn.title = aria;
    // The ring alone while it works: a glyph class beside it would draw a second circle over it.
    const glyph = sniBusy() ? 'mv-spin-ring' : (sniUi.stage === 'running' ? 'ph-fill ph-power' : 'ph-bold ph-power');
    const gl = q('glyph');
    if (gl.className !== glyph) gl.className = glyph;

    const live = q('live');
    if (live && window.MVEngineLive) MVEngineLive.mount(live);
}

/** The run, in one line above the cards — only while it is running through it. */
function sniRenderFlow() {
    const wrap = document.getElementById('sni-flow');
    const host = document.getElementById('sni-steps');
    if (!wrap || !host) return;
    const show = sniBusy();
    wrap.style.display = show ? 'flex' : 'none';
    if (!show) return;
    const idx = SNI_STEPS.findIndex((x) => x.key === (sniUi.stage === 'stopping' ? 'running' : sniUi.stage));
    host.innerHTML = SNI_STEPS.map((x, i) => {
        let cls = 'pending', mark = sniFa(i + 1);
        if (idx >= 0 && i < idx) { cls = 'done'; mark = '✓'; }
        else if (i === idx) { cls = 'active'; mark = '●'; }
        return `<span class="mv-step is-${cls}"><i>${mark}</i>${x.fa}</span>`;
    }).join('');
}

/**
 * The cards: the two decisions this window really has — which entry point the front dials, and
 * which config rides it. Picking here picks for the next connect; the card's header opens the
 * section with the full list and the measurements.
 */
function sniRenderCards() {
    const host = document.getElementById('sni-cards');
    if (!host) return;
    const cfgs = sniConfigs();
    const cfg = sniSelectedConfig();
    const route = sniSelectedRoute();
    const delayLabel = (id) => {
        const v = sniUi.delays[id];
        return v === undefined ? 'اندازه‌گیری نشده' : v > 0 ? `${sniFa(v)} میلی‌ثانیه` : 'جواب نداد';
    };
    const pick = (attrs, on, live, title, hint) => `
        <button type="button" class="mv-eng-pick${on ? ' is-on' : ''}${live ? ' is-live' : ''}" ${attrs} role="radio" aria-checked="${on}">
          <i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i>
          <span class="mv-eng-pick-text"><b dir="ltr">${sniEsc(title)}</b><small>${hint}</small></span>
        </button>`;

    // ── the config that rides the front ──
    const cfgShown = cfgs.slice(0, 4);
    if (cfg && !cfgShown.some((c) => c.id === cfg.id)) cfgShown.splice(3, 1, cfg);
    host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-sni-go="configs">
            <span class="mv-eng-glyph"><i class="ph-fill ph-plugs-connected"></i></span>
            <h3>کانفیگ</h3>
            <span class="mv-eng-card2-end" dir="ltr">${sniEsc((cfg && cfg.name) || '—')}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-sni-act="auto-configs"
                  title="سنجش همهٔ کانفیگ‌ها و انتخاب سریع‌ترین" aria-label="سنجش و انتخاب سریع‌ترین کانفیگ"
                  ${!cfgs.length || sniUi.measuring || sniUi.scanning ? 'disabled' : ''}>
            <i class="${sniUi.measuring ? 'mv-spin-ring' : 'ph-bold ph-gauge'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body" role="radiogroup">
          ${cfgs.length ? cfgShown.map((c) => pick(`data-sni-cfg="${sniEsc(c.id)}"`, !!cfg && c.id === cfg.id,
        c.uri === sniUi.liveUri, c.name || c.uri, c.uri === sniUi.liveUri ? 'همین کانفیگ دارد ترافیک را حمل می‌کند' : sniEsc(delayLabel(c.id)))).join('')
            : '<div class="mv-eng-card2-foot">هنوز کانفیگ SNI ندارید — در بخش «کانفیگ‌های SNI» از کانفیگ‌هایی که دارید بسازید.</div>'}
        </div>
        <div class="mv-eng-card2-foot">${sniUi.measuring
        ? `در حال سنجش… ${sniFa(sniUi.measured[0])} از ${sniFa(sniUi.measured[1])}`
        : `دکمهٔ سنجش (بالا) همه را می‌سنجد و سریع‌ترین را برمی‌دارد${cfgs.length > cfgShown.length ? ` · ${sniFa(cfgs.length - cfgShown.length)} کانفیگ دیگر در بخش «کانفیگ‌های SNI»` : ''}`}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-pink, #FF2D55)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-sni-go="routes">
            <span class="mv-eng-glyph"><i class="ph-fill ph-signpost"></i></span>
            <h3>مسیر ورودی</h3>
            <span class="mv-eng-card2-end" dir="ltr">${sniEsc(route ? route.FAKE_SNI : '—')}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-sni-act="auto-routes"
                  title="سنجش همهٔ مسیرها و انتخاب سریع‌ترین" aria-label="سنجش و انتخاب سریع‌ترین مسیر"
                  ${!sniList.length || sniUi.scanning || sniUi.measuring ? 'disabled' : ''}>
            <i class="${sniUi.scanning ? 'mv-spin-ring' : 'ph-bold ph-pulse'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body" role="radiogroup">
          ${sniList.slice(0, 4).map((r) => {
            const k = sniRouteKey(r);
            const up = sniUi.frontUp && activeSniConfig && sniRouteKey(activeSniConfig) === k;
            const hint = `${r.method ? 'روش ' + sniFa(r.method) + ' · ' : ''}<span dir="ltr">${sniEsc(r.CONNECT_IP)}</span>${r.speed ? ' · ' + sniEsc(r.speed) : ''}`;
            return pick(`data-sni-route="${sniEsc(k)}"`, !!route && k === sniRouteKey(route), up, r.FAKE_SNI, up ? 'موتور همین حالا روی این مسیر است' : hint);
        }).join('')}
        </div>
        <div class="mv-eng-card2-foot">${sniUi.scanning
        ? 'در حال سنجش مسیرها…'
        : `دکمهٔ سنجش (بالا) همه را می‌سنجد و سریع‌ترین را برمی‌دارد${sniList.length > 4 ? ` · ${sniFa(sniList.length - 4)} مسیر دیگر در بخش «مسیرهای ورودی»` : ''}`}</div>
      </div>`;
}

/** What the window is, in numbers: the port the configs dial, and the live pair behind it. */
function sniRenderAdvanced() {
    const host = document.getElementById('sni-adv');
    if (!host) return;
    const running = sniUi.stage === 'running';
    const kv = (label, hint, value) => `
        <div class="mv-form-row">
          <span class="mv-form-label">${label}<small>${hint}</small></span>
          <span class="mv-form-control"><span class="mv-eng-kv"><code dir="ltr">${sniEsc(value)}</code>
            <button type="button" class="mv-eng-copy" data-sni-copy="${sniEsc(value)}" title="کپی"><i class="ph-bold ph-copy"></i></button></span></span>
        </div>`;
    const rows = [kv('درگاه محلی موتور', 'کانفیگ‌های SNI به همین آدرس وصل می‌شوند. روی شبکهٔ محلی هم باز است، پس گوشیِ روی همین وای‌فای هم می‌تواند از آن استفاده کند.', SNI_LOCAL)];
    if (running && activeSniConfig) {
        rows.push(kv('نام جعلی دامنه', 'نامی که روی دست‌دهی می‌نشیند — چیزی که فیلترینگ می‌بیند', activeSniConfig.FAKE_SNI));
        rows.push(kv('آدرس لبه', 'آدرسی که موتور واقعاً به آن وصل می‌شود', `${activeSniConfig.CONNECT_IP}:${activeSniConfig.CONNECT_PORT || 443}`));
    }
    host.innerHTML = `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">تنظیمات پیشرفته</div>
        <div class="mv-form-group">${rows.join('')}</div>
        <p class="mv-form-footer">موتور SNI خودش ترافیک سیستم را جابه‌جا نمی‌کند: این درگاه را باز می‌کند و کانفیگ‌های SNI از همان رد می‌شوند.</p>
      </div>`;
}

/** The strip along the bottom: in one line, what is true right now. */
function sniRenderFoot() {
    const host = document.getElementById('sni-foot');
    if (!host) return;
    const v = sniView();
    const cfg = sniSelectedConfig();
    const word = v.tone === 'on' ? 'روشن — کانفیگ از موتور رد می‌شود'
        : v.tone === 'busy' ? 'در حال کار'
            : v.tone === 'bad' ? (sniUi.frontUp ? 'موتور روشن، بدون کانفیگ' : 'بالا نیامد')
                : 'خاموش';
    const end = v.tone === 'on' && activeSniConfig ? `<code dir="ltr">${sniEsc(activeSniConfig.FAKE_SNI)}</code>`
        : cfg ? `<span dir="ltr">${sniEsc(cfg.name || '')}</span>` : '';
    host.innerHTML = `
      <i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : ''}"></i>
      <span>${word}</span>
      <span class="mv-eng-foot-end">${end}</span>`;
}

// ── the two sections: the full lists, and the measurements ───────────────────

function sniConfigsSectionHtml() {
    const cfgs = sniConfigs();
    const cfg = sniSelectedConfig();
    const delayLabel = (id) => {
        const v = sniUi.delays[id];
        return v === undefined ? '—' : v > 0 ? `${sniFa(v)} ms` : 'قطع';
    };
    const dead = cfgs.filter((c) => sniUi.delays[c.id] === 0);
    return `
  <div class="mv-form-section is-wide">
    <div class="sni-list-head">
      <div class="mv-form-header">کانفیگ‌های SNI</div>
      <div class="sni-list-tools">
        <button type="button" class="mv-btn mv-btn--sm" data-sni-go="build">ساخت کانفیگ SNI</button>
      </div>
    </div>
    <div class="mv-form-group">
      ${cfgs.length ? `
      <button type="button" class="mv-form-row is-action" data-sni-act="test-configs"${sniUi.measuring || sniUi.scanning ? ' aria-busy="true"' : ''}>
        <span class="mv-row-mark">${sniUi.measuring ? '<i class="ph-bold ph-spinner-gap mv-spin"></i>' : '<i class="ph-bold ph-gauge"></i>'}</span>
        <span class="mv-form-label">تست کانفیگ‌ها<small>${sniUi.measuring ? `در حال اندازه‌گیری… ${sniFa(sniUi.measured[0])} از ${sniFa(sniUi.measured[1])}` : 'یک درخواست واقعی از درون هر کانفیگ، روی مسیر انتخاب‌شده'}</small></span>
      </button>
      <div class="mv-table-wrap">
        <table class="mv-table sni-table">
          <thead><tr><th></th><th>کانفیگ SNI</th><th class="is-num">تأخیر</th></tr></thead>
          <tbody>${cfgs.map((c) => {
        const sel = cfg && c.id === cfg.id;
        const live = c.uri === sniUi.liveUri;
        return `<tr class="${sel ? 'is-selected' : ''}" data-sni-cfg="${sniEsc(c.id)}" title="انتخاب همین کانفیگ">
                <td class="sni-tick">${live ? '<i class="ph-fill ph-check-circle"></i>' : sel ? '<i class="ph-bold ph-check"></i>' : ''}</td>
                <td class="sni-name" dir="ltr">${sniEsc(c.name || c.uri)}</td>
                <td class="is-num" dir="ltr">${delayLabel(c.id)}</td></tr>`;
    }).join('')}</tbody>
        </table>
      </div>
      ${dead.length ? `<button type="button" class="mv-form-row is-action" data-sni-act="dead"><span class="mv-row-mark"><i class="ph-bold ph-broom"></i></span><span class="mv-form-label">حذف ${sniFa(dead.length)} کانفیگی که جواب نداد</span></button>` : ''}
      <button type="button" class="mv-form-row is-action" data-sni-act="all"><span class="mv-row-mark"><i class="ph-bold ph-trash"></i></span><span class="mv-form-label" style="color:var(--mv-red-ink)">حذف همه‌ی کانفیگ‌های SNI</span></button>`
        : `<div class="mv-empty"><i class="ph-bold ph-plugs mv-empty-ic"></i><b>هنوز کانفیگ SNI ندارید</b><p>از کانفیگ‌هایی که دارید بسازید — بخش «ساخت کانفیگ SNI» در نوار کناری.</p></div>`}
    </div>
    <p class="mv-form-footer">لازم نیست چیزی را از قبل انتخاب کنید: دکمه‌ی اتصال اگر ببیند مسیر یا کانفیگی انتخاب نکرده‌اید، اول خودش می‌سنجد و سریع‌ترینی را که جواب داده برمی‌دارد، بعد وصل می‌کند. اگر خودتان یکی را انتخاب کرده باشید، دست به انتخابتان نمی‌زند. «تست کانفیگ‌ها» فقط اندازه می‌گیرد و چیزی را عوض نمی‌کند.</p>
  </div>`;
}

/**
 * «ساخت کانفیگ SNI» — its own section, because it is a job of its own.
 *
 * It takes configs that already live on a Cloudflare worker and points a copy of each at the local
 * front; the originals are left alone.
 */
function sniBuildSectionHtml() {
    const buckets = window.sniBuilder ? window.sniBuilder.buckets() : [];
    const total = buckets.reduce((n, b) => n + b.items.length, 0);
    return `
  <div class="mv-form-section is-wide">
    <div class="mv-form-header">ساخت کانفیگ SNI</div>
    <div class="mv-form-group">
      ${buckets.length ? `
      <div class="mv-form-row mv-callout"><i class="ph-fill ph-magic-wand"></i><span>کانفیگ‌های ورکر کلادفلر شما (پنل‌های ابری، یا هر کانفیگی که روی workers.dev است) به موتور SNI وصل می‌شوند: آدرسشان <span dir="ltr">${SNI_LOCAL}</span> می‌شود. کانفیگ‌های اصلی دست‌نخورده می‌مانند.</span></div>
      ${buckets.map((b) => `<div class="mv-form-row"><span class="mv-form-label">${sniEsc(b.label)}<small>${sniFa(b.items.length)} کانفیگ</small></span><button type="button" class="mv-btn mv-btn--sm" data-sni-build="${sniEsc(b.label)}">ساخت</button></div>`).join('')}
      <div class="mv-form-row"><span class="mv-form-label"><b>همه</b><small>${sniFa(total)} کانفیگ</small></span><button type="button" class="mv-btn mv-btn--sm mv-btn--primary" data-sni-build="*">ساخت از همه</button></div>`
        : `<div class="mv-form-row mv-callout is-warn"><i class="ph-fill ph-warning"></i><span>کانفیگ قابل تبدیلی پیدا نشد. فقط کانفیگ‌هایی که سرورشان ورکر کلادفلر است از این مسیر کار می‌کنند — اول از «زیرساخت ابری» کانفیگ بسازید یا بگیرید.</span></div>`}
    </div>
    <p class="mv-form-footer">هر کانفیگ ساخته‌شده یک کپی است که به‌جای ورکر، به درگاه محلی موتور وصل می‌شود؛ بعد از ساخت، در بخش «کانفیگ‌های SNI» پیدایشان می‌کنید و همان‌جا می‌شود سنجیدشان.</p>
  </div>`;
}

function sniRoutesSectionHtml() {
    const route = sniSelectedRoute();
    return `
  <div class="mv-form-section is-wide">
    <div class="sni-list-head">
      <div class="mv-form-header">مسیرهای ورودی</div>
      <div class="sni-list-tools">
        <button type="button" onclick="openSniImportModal()" class="mv-btn mv-btn--sm">وارد کردن دستی</button>
      </div>
    </div>
    <div class="mv-form-group">
      ${sniList.length ? `
      <button type="button" class="mv-form-row is-action" data-sni-act="test-routes"${sniUi.scanning ? ' aria-busy="true"' : ''}>
        <span class="mv-row-mark">${sniUi.scanning ? '<i class="ph-bold ph-spinner-gap mv-spin"></i>' : '<i class="ph-bold ph-pulse"></i>'}</span>
        <span class="mv-form-label">تست مسیرها<small>${sniUi.scanning ? 'در حال سنجش…' : 'یک دست‌دهی TLS به هر مسیر؛ فهرست بر اساس نتیجه مرتب می‌شود'}</small></span>
      </button>
      <div class="mv-table-wrap">
        <table class="mv-table sni-table">
          <thead><tr><th></th><th>روش</th><th>SNI (دامنه)</th><th>IP:Port</th><th class="is-num">TLS</th></tr></thead>
          <tbody>${sniList.map((r) => {
        const k = sniRouteKey(r);
        const sel = route && k === sniRouteKey(route);
        const up = sniUi.frontUp && activeSniConfig && sniRouteKey(activeSniConfig) === k;
        return `<tr class="${sel ? 'is-selected' : ''}" data-sni-route="${sniEsc(k)}" title="همین مسیر">
                <td class="sni-tick">${up ? '<i class="ph-fill ph-check-circle"></i>' : sel ? '<i class="ph-bold ph-check"></i>' : ''}</td>
                <td class="sni-method">${r.method ? sniFa(r.method) : '—'}</td>
                <td class="is-ltr sni-dom">${sniEsc(r.FAKE_SNI)}</td>
                <td class="is-ltr is-mono">${sniEsc(r.CONNECT_IP)}:${sniEsc(r.CONNECT_PORT || 443)}</td>
                <td class="is-num" dir="ltr">${sniEsc(r.speed || '-')}</td></tr>`;
    }).join('')}</tbody>
        </table>
      </div>`
        : `<div class="mv-empty"><i class="ph-bold ph-shield-slash mv-empty-ic"></i><b>مسیر ورودی‌ای نیست</b><p>مسیرهای آماده با برنامه می‌آیند؛ اگر همه را پاک کرده‌اید، با «وارد کردن دستی» مسیر خودتان را بیاورید.</p></div>`}
    </div>
    <p class="mv-form-footer">هر مسیر یعنی یک آدرس لبه به‌همراه نامی که روی دست‌دهی می‌نشیند، و ستون «روش» می‌گوید هر مسیر از کدام دسته است. هیچ روشی روی همه‌ی اینترنت‌ها جواب نمی‌دهد — یکی روی یک شبکه باز می‌شود و روی شبکه‌ی دیگر نه — پس همه‌ی روش‌ها با برنامه می‌آیند و لازم نیست بدانید کدام برای شماست: «تست مسیرها» همه را امتحان می‌کند و در دسترس‌ها را بالا می‌آورد، و دکمهٔ اتصال هم اگر خودتان انتخاب نکرده باشید همین کار را می‌کند. انتخاب شما بی‌درنگ اعمال می‌شود و اگر موتور روشن باشد، روی مسیر تازه دوباره بالا می‌آید.</p>
  </div>`;
}

/** Everything clickable that is rebuilt on a repaint. */
function sniWire(root) {
    if (!root) return;
    root.querySelectorAll('[data-sni-go]').forEach((b) => { b.onclick = () => sniGoSec(b.dataset.sniGo); });
    root.querySelectorAll('[data-sni-cfg]').forEach((n) => { n.onclick = () => sniSelectConfig(n.dataset.sniCfg); });
    root.querySelectorAll('[data-sni-route]').forEach((n) => { n.onclick = () => sniSelectRoute(n.dataset.sniRoute); });
    root.querySelectorAll('[data-sni-build]').forEach((b) => { b.onclick = () => sniBuild(b.dataset.sniBuild); });
    root.querySelectorAll('[data-sni-copy]').forEach((b) => {
        b.onclick = () => {
            try { navigator.clipboard.writeText(b.dataset.sniCopy); if (typeof toast === 'function') toast('✅ کپی شد'); }
            catch (e) { /* no clipboard permission: the value is on screen anyway */ }
        };
    });
    root.querySelectorAll('[data-sni-act]').forEach((b) => {
        b.onclick = () => {
            const a = b.dataset.sniAct;
            if (a === 'toggle') toggleSniEngine();
            // The card's ⏱: measure, then take the fastest that answered. A choice the user made
            // by hand is still theirs — this is them asking for it to be re-decided.
            else if (a === 'auto-configs') testSniConfigs({ auto: true });
            else if (a === 'auto-routes') testSniRoutes({ auto: true, announce: true });
            else if (a === 'test-configs') testSniConfigs();
            else if (a === 'test-routes') testSniRoutes();
            else if (a === 'dead') sniDeleteConfigs(new Set(sniConfigs().filter((c) => sniUi.delays[c.id] === 0).map((c) => c.id)));
            else if (a === 'all') sniDeleteConfigs(new Set(sniConfigs().map((c) => c.id)));
        };
    });
}

function renderSniList() {
    const root = document.getElementById('sni-wrapper');
    if (!root) return;
    sniRenderIdent();
    sniRenderFoot();

    // Only what is on screen is drawn: the builder walks the whole config list to group it, and
    // doing that on every status tick behind a hidden section is work nobody sees.
    if (sniSec === 'connect') { sniRenderStage(); sniRenderFlow(); sniRenderCards(); sniRenderAdvanced(); }
    else if (sniSec === 'configs') { const h = document.getElementById('sni-sec-configs'); if (h) h.innerHTML = sniConfigsSectionHtml(); }
    else if (sniSec === 'build') { const h = document.getElementById('sni-sec-build'); if (h) h.innerHTML = sniBuildSectionHtml(); }
    else if (sniSec === 'routes') { const h = document.getElementById('sni-sec-routes'); if (h) h.innerHTML = sniRoutesSectionHtml(); }

    sniWire(root);
}

function initSniModule() {
    const container = document.getElementById('ls-sni');
    if (!container) return;
    loadSniNodes();
    container.innerHTML = sniHtmlTemplate;
    if (container.parentElement) {
        container.parentElement.style.position = 'relative';
        container.parentElement.style.padding = '0';
        container.parentElement.style.overflow = 'hidden';
    }
    container.style.cssText = 'position: absolute; inset: 0; display: flex; background: transparent; z-index: 10;';

    const root = document.getElementById('sni-wrapper');
    if (root) {
        root.querySelectorAll('.mv-side-item[data-sni-sec]').forEach((b) => {
            b.onclick = () => sniGoSec(b.getAttribute('data-sni-sec'));
        });
        const back = document.getElementById('sni-back');
        if (back) back.onclick = () => sniGoSec('connect');
        // The front is our own binary and not a store item; what the store DOES carry for this
        // window is Xray — the core every SNI config actually runs on.
        const store = document.getElementById('sni-store');
        if (store) store.onclick = () => {
            if (typeof window.storeOpenItem === 'function') window.storeOpenItem('core|xray');
            else if (window.MV && MV.wm) MV.wm.open('store');
        };
    }
    sniGoSec('connect');
    refreshSni();
}

// Anything that changes what Xray runs (a V2Ray node, «کانفیگ ایران», a disconnect) says so with
// this event; the window then re-reads the server instead of trusting its last look.
window.addEventListener('mv-v2ray-state', () => { if (document.getElementById('sni-results-container')) refreshSni(); });

window.sniToggleBuilder = function () { sniUi.building = !sniUi.building; renderSniList(); };
window.MVProbe = window.MVProbe || {};
// Two different questions, and the shell asks both. `sni` is THIS app's lamp: its front is its
// engine, and it is up or it is not. `owns.sni` is "the config Xray is running is one of mine",
// which is what stops the V2Ray icon lighting for a connection this panel made — and what stops
// this panel claiming one it did not: a front left listening with an ordinary V2Ray node
// connected is not SNI's traffic. See shell/apps.js.
window.MVProbe.owns = window.MVProbe.owns || {};
window.MVProbe.owns.sni = () => !!sniUi.liveUri;
window.MVProbe.sni = () => sniUi.stage === 'running' || !!sniUi.frontUp;

// Kept on window: the HTML onclick handlers, systemcheck.js and the shell call these by name.
window.initSniModule = initSniModule;
window.renderSniList = renderSniList;
window.refreshSni = refreshSni;
window.testSniRoutes = testSniRoutes;
window.testSniConfigs = testSniConfigs;
window.toggleSniEngine = toggleSniEngine;
window.startSni = sniConnect;
window.stopSni = sniDisconnect;

window.openSniImportModal = function() {
    const modal = document.getElementById('sni-import-modal');
    const content = document.getElementById('sni-import-modal-content');
    if (modal && content) {
        modal.classList.remove('opacity-0', 'pointer-events-none');
        modal.classList.add('opacity-100');
        content.classList.remove('scale-95');
        content.classList.add('scale-100');
        setTimeout(() => { const input = document.getElementById('sni-modal-input'); if (input) input.focus(); }, 100);
    }
};

window.closeSniImportModal = function() {
    const modal = document.getElementById('sni-import-modal');
    const content = document.getElementById('sni-import-modal-content');
    if (modal && content) {
        modal.classList.remove('opacity-100');
        modal.classList.add('opacity-0', 'pointer-events-none');
        content.classList.remove('scale-100');
        content.classList.add('scale-95');
    }
};

window.loadSniNodesFromModal = function() {
    const raw = document.getElementById('sni-modal-input') ? document.getElementById('sni-modal-input').value.trim() : '';
    if (!raw) return;
    try {
        const parsed = JSON.parse(raw);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        let added = 0;
        list.forEach((p, idx) => {
            if (p && p.FAKE_SNI && p.CONNECT_IP && !sniList.some(s => s.FAKE_SNI === p.FAKE_SNI && s.CONNECT_IP === p.CONNECT_IP)) {
                sniList.push({ id: Date.now() + idx, ...p, ping: '-', speed: '-' });
                added++;
            }
        });
        if (added > 0) {
            saveSniNodes();
            renderSniList();
            toast('✅ ' + added + ' مسیر وارد شد');
            window.closeSniImportModal();
            document.getElementById('sni-modal-input').value = '';
        } else {
            toast('⚠️ مسیر جدیدی یافت نشد (تکراری)');
        }
    } catch (e) {
        toast('❌ خطا در خواندن JSON');
    }
};
