// --- VodiWalker panel («کانفیگ آیپی ثابت») ---
// Renders into #ls-vodi. Talks to /api/vodi/* on the local server.
//
// Two things this feature does, both fully automated from inside the app:
//   1) Deploy the VodiWalker panel to the user's OWN Railway account (wizard).
//   2) Manage that server's users/configs (create/list/edit/delete/toggle), with every
//      change applied to the live server immediately (proxied through the backend).
//
// NOTE: Railway's *.up.railway.app is on Railway's own network, not Cloudflare, so the
// clean-IP "combine" flow does not apply here — a config uses the Railway domain directly.

const vodiState = {
    gateways: [],
    regions: [],
    accounts: [],
    activeGatewayId: null,
    // Whether `gateways` is an ANSWER or just its initial value. A failed or not-yet-made
    // call leaves the list empty, which is indistinguishable from «this user has no
    // servers» — and anything that draws a conclusion from an empty list (a saved config
    // whose server is "gone") would state that conclusion before there was any evidence
    // for it. Same rule as usersFor below.
    gatewaysLoaded: false,
    users: [],
    // Which server `users` belongs to, and whether a reload is in flight. Both exist so the
    // list can tell "nothing fetched yet" apart from "fetched, and there are none" — the
    // difference between «در حال بارگذاری…» and «هنوز کاربری ساخته نشده».
    usersFor: null,
    usersBusy: false,
    usersError: '',
    telemetry: null,     // the server's own CPU/RAM/uptime, when it answers
    view: 'list',        // 'list' | 'manage'
    wizard: null,        // deploy wizard state
    // The one long-running wizard step in flight, if any: 'github' | 'github-repo' |
    // 'oauth'. See vodiFlowStart — these take minutes in a browser and starting a second
    // one retires the first, so the panel refuses instead of quietly doubling the work.
    flow: '',
    logWs: null,
};

// ── helpers ──────────────────────────────────────────────────────────────────────

async function vodiFetch(path, opts = {}) {
    const res = await fetch(path, {
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
        throw new Error(data.error || `خطا (${res.status})`);
    }
    return data;
}

function vodiToast(msg) {
    if (typeof toast === 'function') toast(msg); else console.log('[vodi]', msg);
}

function vodiEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The connect URI of one link row, whichever field the panel put it in.
 *
 * `vless_full` is the panel's real answer; `vless` is the same string but deliberately
 * blanked when the row stands for SEVERAL configs (several clean IPs, or config_count > 1),
 * so reading `vless` alone would come back empty for exactly the rows a user is most likely
 * to build. `vless_link` is what a server from the previous generation of this feature
 * returns, and those servers are still deployed.
 */
function vodiLinkUri(row) {
    if (!row) return '';
    return row.vless_full || row.vless || row.vless_link || '';
}

function vodiFmtBytes(b) {
    b = Number(b) || 0;
    if (b < 1024) return b + ' B';
    if (b < 1024 ** 2) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(2) + ' MB';
    return (b / 1024 ** 3).toFixed(2) + ' GB';
}

// ALPN choices mirror the panel's own presets. An empty value means "let the server pick
// the per-protocol default" (DEFAULT_ALPN_BY_PROTOCOL) — what the panel calls
// «پیش‌فرض پروتکل». A pre-existing custom value is kept as an extra option so opening the
// edit form never silently rewrites a config the panel set to something unusual.
const VODI_ALPN_PRESETS = ['http/1.1', 'h2,http/1.1', 'h2'];

function vodiAlpnOptions(current) {
    const cur = (current || '').trim();
    const opts = [{ v: '', label: 'پیش‌فرض پروتکل' }]
        .concat(VODI_ALPN_PRESETS.map(v => ({ v, label: v })));
    if (cur && !VODI_ALPN_PRESETS.includes(cur)) opts.push({ v: cur, label: cur + ' (سفارشی)' });
    return opts.map(o =>
        `<option value="${vodiEsc(o.v)}" ${o.v === cur ? 'selected' : ''}>${vodiEsc(o.label)}</option>`
    ).join('');
}

// ── received nodes ───────────────────────────────────────────────────────────────
// These nodes live in their OWN store and render inside THIS panel. They are deliberately
// NOT pushed into the cloud panel's cf_base_configs: that panel is a separate feature
// (Cloudflare workers) and mixing the two would put unrelated nodes in each other's lists.
const VODI_NODES_KEY = 'vodi_nodes';
// The key these nodes were stored under before the feature was renamed. Read once, when
// nothing has been saved under the new key yet: these are configs the user fetched and
// kept, and the first save under the new key makes the carry-over permanent.
const VODI_NODES_LEGACY_KEY = 'x4g_nodes';

function vodiGetNodes() {
    try {
        const raw = PersistentStorage.getItem(VODI_NODES_KEY)
            || PersistentStorage.getItem(VODI_NODES_LEGACY_KEY);
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
}

function vodiSaveNodes(list) {
    try { PersistentStorage.setItem(VODI_NODES_KEY, JSON.stringify(list.slice(0, 50))); } catch (e) {}
}

/** Store received vless links as a node card in this panel. `name` = مدیر / username. */
function vodiAddNodes(links, name, gatewayId) {
    links = (links || []).filter(Boolean);
    if (!links.length) { vodiToast('کانفیگی برای افزودن نبود'); return; }
    const list = vodiGetNodes();
    list.unshift({
        id: 'vodin_' + Date.now(),
        name: name || 'نود',
        configs: links,
        gatewayId: gatewayId || vodiState.activeGatewayId || '',
        date: new Date().toLocaleString('fa-IR'),
    });
    vodiSaveNodes(list);
    vodiRenderNodes();
    if (vodiSec === 'connect') vodiRenderCards();
    vodiToast(`نود «${name}» اضافه شد`);
}

function vodiNodeCopy(id) {
    const n = vodiGetNodes().find(x => x.id === id);
    if (!n) return;
    try { navigator.clipboard.writeText(n.configs.join('\n')); vodiToast('کپی شد'); }
    catch (e) { vodiToast('کپی نشد'); }
}

async function vodiNodeDelete(id) {
    const n = vodiGetNodes().find(x => x.id === id);
    if (!n) return;
    const ok = await uiConfirm({
        title: 'حذف نود', message: `نود «${n.name}» حذف شود؟`,
        confirmLabel: 'حذف', cancelLabel: 'انصراف', danger: true,
    });
    if (!ok) return;
    vodiSaveNodes(vodiGetNodes().filter(x => x.id !== id));
    vodiRenderNodes();
    if (vodiSec === 'connect') vodiRenderCards();
    vodiToast('نود حذف شد');
}

/** Send this node's configs to the V2RAY panel — same mechanism the other panels use. */
function vodiNodeToV2ray(id) {
    const n = vodiGetNodes().find(x => x.id === id);
    if (!n) return;
    window.v2rayList = window.v2rayList || [];
    let added = 0;
    for (const uri of n.configs) {
        if (typeof uri !== 'string' || !uri) continue;
        // Tag the remark with the node label so it is identifiable in the V2Ray list.
        let out = uri;
        const tag = ` [${n.name}]`;
        if (uri.includes('#')) {
            const base = uri.split('#')[0];
            let frag = '';
            try { frag = decodeURIComponent(uri.split('#')[1] || ''); } catch (e) { frag = uri.split('#')[1] || ''; }
            if (!frag.includes(tag)) frag += tag;
            out = base + '#' + encodeURIComponent(frag);
        } else {
            out = uri + '#' + encodeURIComponent(n.name);
        }
        window.v2rayList.unshift({ id: 'conf_' + Date.now() + Math.random(), uri: out });
        added++;
    }
    if (!added) { vodiToast('کانفیگی برای انتقال نبود'); return; }
    if (typeof window.saveV2rayList === 'function') window.saveV2rayList();
    if (typeof window.renderV2rayList === 'function') window.renderV2rayList();
    vodiToast(`${added} کانفیگ به V2Ray افزوده شد`);
    if (typeof window.toggleLeftSidebar === 'function') window.toggleLeftSidebar('v2ray');
}

// ── the page ─────────────────────────────────────────────────────────────────────
//
// The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one the other
// windows wear. What was three screens stacked in one column — the server list, the user
// manager, the deploy wizard — is now a sidebar of sections with the wizard as an overlay,
// and one round button at the top.
//
// That button is new and it is the point: until now this panel built a server and handed
// you a config to paste into the V2Ray window yourself. It dials the server it built,
// through the app's own engine — the same /api/v2ray/start every other config in this app
// goes through.

const VODI_SECTIONS = [
    { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
    { id: 'servers', label: 'سرورها', icon: 'ph-fill ph-hard-drives', tint: 'var(--mv-pink, #FF2D55)' },
    { id: 'users', label: 'کاربران', icon: 'ph-fill ph-users-three', tint: 'var(--mv-blue)' },
    { id: 'nodes', label: 'کانفیگ‌های دریافتی', icon: 'ph-fill ph-qr-code', tint: 'var(--mv-indigo)' },
];

const VODI_STEPS = [
    { key: 'server', fa: 'ساخت سرور' },
    { key: 'config', fa: 'گرفتن کانفیگ' },
    { key: 'connect', fa: 'اتصال' },
];

/** Which section is on screen. */
let vodiSec = 'connect';

/** What the app's one engine is carrying right now — read back from the server, not assumed. */
const vodiLive = { running: false, uri: null, tunnel: false, proxyMode: 'system', busy: '' };

// ── how this machine's traffic reaches the server ────────────────────────────────
// «پروکسی» routes only what asks for the Windows proxy; «تونل» puts a TUN adapter in front
// of the whole machine. The choice is the user's and it is remembered, because it is a
// property of how they use this computer, not of any one server.
const VODI_MODE_KEY = 'vodi_mode';

function vodiGetMode() {
    try {
        const v = PersistentStorage.getItem(VODI_MODE_KEY);
        return v === 'tunnel' ? 'tunnel' : 'proxy';
    } catch (e) { return 'proxy'; }
}

function vodiSetMode(mode) {
    const next = mode === 'tunnel' ? 'tunnel' : 'proxy';
    try { PersistentStorage.setItem(VODI_MODE_KEY, next); } catch (e) {}
    return next;
}

// ── which server and which config the button dials ───────────────────────────────
//
// This used to be neither: the button always took gateways[0] and that server's first
// config, and the two cards on the connect screen were `aria-disabled` decoration. So a
// user with three servers in three regions could MEASURE that the third was twice as fast
// and then have no way to dial it — the numbers were true and useless.
//
// The pick is remembered because it is a decision about the user's own servers, not about
// one session, and it is remembered BY ID: a saved id that no longer exists falls back to
// the first, so deleting a server or a config cannot leave the button pointing at nothing.
const VODI_PICK_KEY = 'vodi_pick';

function vodiGetPick() {
    try {
        const raw = PersistentStorage.getItem(VODI_PICK_KEY);
        const p = raw ? JSON.parse(raw) : null;
        return (p && typeof p === 'object') ? p : {};
    } catch (e) { return {}; }
}

function vodiSetPick(patch) {
    const next = Object.assign(vodiGetPick(), patch || {});
    try { PersistentStorage.setItem(VODI_PICK_KEY, JSON.stringify(next)); } catch (e) {}
    return next;
}

/**
 * Switch mode from the picker.
 *
 * Changing it while connected has to be applied to the LIVE session, not just remembered —
 * a picker that silently disagreed with what the machine is doing is worse than no picker.
 */
async function vodiPickMode(mode) {
    const next = vodiSetMode(mode);
    vodiRender();
    if (!vodiConnectedHere() || vodiLive.busy) return;
    vodiLive.busy = 'mode';
    vodiRenderStage(); vodiRenderFoot();
    try {
        if (next === 'tunnel') {
            const d = await vodiCallV2ray('/api/v2ray/tun', { enabled: true });
            if (d.error) throw new Error(d.error);
            vodiToast(d.running ? '✅ تونل کامل برقرار شد' : 'تونل روشن نشد');
        } else {
            const d = await vodiCallV2ray('/api/v2ray/tun', { enabled: false });
            if (d.error) throw new Error(d.error);
            vodiToast('تونل خاموش شد — پروکسی سیستم برگشت');
        }
    } catch (e) {
        vodiToast('❌ ' + e.message);
    } finally {
        vodiLive.busy = '';
        await vodiRefreshLive();
        vodiRender();
    }
}

const vodiFa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

const vodiHtmlTemplate = `
<div id="vodi-wrapper" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های railway">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="vodi-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${VODI_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-vodi-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="vodi-store" title="نسخهٔ سرور شما در ام‌ال‌ام استور">
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
        <button type="button" id="vodi-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="vodi-pane-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="vodi-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="vodi-stage" style="--tint:var(--mv-pink, #FF2D55)"></div>
        <div id="vodi-mode"></div>
        <div id="vodi-speed"></div>
        <div class="mv-eng-flow" id="vodi-flow" style="display:none"><div class="mv-steps" id="vodi-steps"></div></div>
        <div class="mv-eng-grid" id="vodi-cards"></div>
      </div>
      <div class="mv-eng-sec" data-sec="servers"><div class="vodi-sec" id="vodi-sec-servers"></div></div>
      <div class="mv-eng-sec" data-sec="users"><div class="vodi-sec" id="vodi-sec-users"></div></div>
      <div class="mv-eng-sec" data-sec="nodes">
        <div class="vodi-sec">
          <div class="vodi-note">هر بار «کانفیگ مدیر» یا «دریافت کانفیگ» یک کاربر را بزنید، کانفیگش اینجا ذخیره می‌شود. دکمهٔ اتصال هم از همین‌ها استفاده می‌کند.</div>
          <div id="vodi-node-test"></div>
          <div id="vodi-node-list" class="vodi-user-list"></div>
        </div>
      </div>
    </div>

    <div class="mv-eng-foot" id="vodi-foot"></div>
  </section>

  <!-- The deploy wizard covers the page: six steps, one thing to do at a time. -->
  <div id="vodi-wizard" style="display:none;"></div>
</div>
${vodiStyles()}`;

function vodiDot(tone) {
    return `<i class="mv-eng-dot${tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : ''}"></i>`;
}

/** The server the page is about: the one being managed, else the first one built. */
function vodiActiveGw() {
    const gws = vodiState.gateways || [];
    const picked = vodiGetPick().gw;
    return gws.find((g) => g.id === vodiState.activeGatewayId)
        || gws.find((g) => g.id === picked)
        || gws[0] || null;
}

/**
 * The stored configs that belong to that server, in the order the button reads them.
 *
 * The PICKED config is first, so `vodiActiveUri()` — and with it the stage, the lamp and
 * `vodiConnectedHere()` — all follow the choice from this one place rather than each
 * re-deciding. With nothing picked the order is the old one: «مدیر» first.
 */
function vodiGwNodes() {
    const gw = vodiActiveGw();
    if (!gw) return [];
    const all = vodiGetNodes().filter((n) => !n.gatewayId || n.gatewayId === gw.id);
    const admin = all.filter((n) => n.name === 'مدیر');
    const ordered = admin.concat(all.filter((n) => n.name !== 'مدیر'));
    const pick = vodiGetPick().node;
    const at = pick ? ordered.findIndex((n) => n.id === pick) : -1;
    if (at > 0) ordered.unshift(ordered.splice(at, 1)[0]);
    return ordered;
}

/** The one the button dials. */
function vodiActiveUri() {
    const n = vodiGwNodes()[0];
    return (n && n.configs && n.configs[0]) || '';
}

/** The saved config the button dials, as a row — for the picker's "selected" mark. */
function vodiActiveNode() {
    return vodiGwNodes()[0] || null;
}

/**
 * Change what the button dials.
 *
 * While a connection is LIVE, changing the selection silently would put the panel in the
 * one state it must never show: a picker pointing at config B while the engine carries
 * config A. So the switch is either carried out for real (reconnect through the new one)
 * or not made at all — see [[v2ray-connect-lifecycle]], «no switch may show what was
 * clicked». Not connected → it is just a remembered choice and nothing is dialled.
 */
async function vodiPickTarget(patch) {
    if (vodiLive.busy) return false;
    const wasOn = vodiConnectedHere();
    if (wasOn) {
        const ok = await uiConfirm({
            title: 'تغییر مسیر اتصال',
            message: 'الان وصلید. برای اینکه ترافیک از این یکی رد شود باید اتصال از نو برقرار شود — چند لحظه قطع می‌شوید. انجام شود؟',
            confirmLabel: 'وصل کن', cancelLabel: 'انصراف',
        });
        if (!ok) return false;
    }
    vodiSetPick(patch);
    if (patch.gw) {
        vodiState.activeGatewayId = patch.gw;
        // The open user list belongs to the server that was selected a moment ago. Dropping
        // it (rather than leaving it on screen under a new server's name) is the same rule
        // the manage screen follows: «not fetched yet» must not look like «fetched, none».
        vodiState.users = []; vodiState.usersFor = null; vodiState.usersError = '';
        vodiState.telemetry = null;
    }
    vodiRender();
    if (wasOn) await vodiConnect();
    return true;
}

function vodiConnectedHere() {
    const u = vodiActiveUri();
    return !!u && !!vodiLive.running && vodiLive.uri === u;
}

async function vodiCallV2ray(url, body) {
    const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined;
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch (e) { /* an empty reply is still an answer */ }
    if (!res.ok && !data.error) data.error = `پاسخ ${res.status} از برنامه`;
    return data;
}

/** What the engine is carrying, and how this machine's traffic reaches it. */
async function vodiRefreshLive() {
    try {
        const [t, q] = await Promise.all([
            vodiCallV2ray('/api/v2ray/traffic'),
            vodiCallV2ray('/api/quick/status'),
        ]);
        if (!t.error) { vodiLive.running = !!t.running; vodiLive.uri = t.uri || null; }
        if (!q.error) { vodiLive.tunnel = !!q.tunnelWanted; vodiLive.proxyMode = q.proxyMode || 'system'; }
    } catch (e) { /* the server is not answering: the page keeps what it last knew */ }
}

/**
 * Dial this server's own config through the app's engine.
 *
 * If no config has been fetched yet, the button fetches the admin one first — the step the
 * user used to have to do by hand before anything could be connected.
 */
async function vodiConnect() {
    const gw = vodiActiveGw();
    if (!gw || vodiLive.busy) return;
    vodiLive.busy = 'connect';
    vodiRenderStage(); vodiRenderFoot();
    try {
        let uri = vodiActiveUri();
        if (!uri) {
            const r = await vodiFetch('/api/vodi/gateways/' + gw.id + '/admin-config');
            uri = r.config && vodiLinkUri(r.config);
            if (!uri) throw new Error('سرور کانفیگ مدیر را برنگرداند.');
            vodiAddNodes([uri], 'مدیر', gw.id);
        }
        // In tunnel mode the system proxy must NOT be taken: the browser would send its
        // traffic to Xray, whose own replies the adapter captures and feeds back in. The
        // tunnel route drops the proxy itself, but asking for both at once means a window
        // where they overlap.
        const wantTunnel = vodiGetMode() === 'tunnel';
        const useSystemProxy = !wantTunnel && !vodiLive.tunnel && vodiLive.proxyMode !== 'port';
        // `solo` IS NOT OPTIONAL HERE, and leaving it out is why this connection could be
        // far slower than the same config in another client.
        //
        // Without it, generateXrayConfig merges every «زیرساخت ابری» config in beside this
        // one behind a leastPing balancer. The balancer has no observation data in its first
        // minute, so the traffic can leave through ANY of those nodes — the user measures
        // "railway is slow" while the bytes are going out through some unrelated, possibly
        // stale, cloud node. The same omission was what let «ضد فیلتر SNI» skip its front.
        //
        // A server the user deployed themselves and then pressed connect on is the least
        // ambiguous case there is: it is the one they asked for, so it is the only one used.
        const d = await vodiCallV2ray('/api/v2ray/start', { uri, useSystemProxy, solo: true });
        if (d.error) throw new Error(d.error);

        // The tunnel goes up only AFTER the engine is proven live — /api/v2ray/tun refuses
        // outright when the SOCKS port is empty, precisely so the default route can never
        // point at nothing.
        if (wantTunnel) {
            const t = await vodiCallV2ray('/api/v2ray/tun', { enabled: true });
            if (t.error) throw new Error('کانفیگ وصل شد ولی تونل کامل روشن نشد: ' + t.error);
        }
        if (typeof window.markV2rayConnected === 'function') {
            window.markV2rayConnected('railway — ' + (gw.name || 'Railway'), { systemProxy: useSystemProxy });
        }
        vodiToast(wantTunnel ? '✅ تونل کامل برقرار شد' : '✅ به سرور خودت وصل شدی');
    } catch (e) {
        vodiToast('❌ ' + e.message);
    } finally {
        vodiLive.busy = '';
        await vodiRefreshLive();
        vodiRender();
    }
}

async function vodiDisconnect() {
    if (vodiLive.busy) return;
    vodiLive.busy = 'disconnect';
    vodiRenderStage(); vodiRenderFoot();
    try {
        // Tear the tunnel down FIRST. Stopping the engine underneath a live TUN leaves the
        // machine's default route pointing at a dead adapter — the «lamp off but no
        // internet» state — so the adapter goes before the thing it forwards to.
        if (vodiLive.tunnel) {
            const t = await vodiCallV2ray('/api/v2ray/tun', { enabled: false });
            if (t.error) throw new Error('تونل خاموش نشد: ' + t.error);
        }
        const d = await vodiCallV2ray('/api/v2ray/stop', {});
        if (d.error) throw new Error(d.error);
        if (typeof window.disconnectV2rayUI === 'function') window.disconnectV2rayUI();
        vodiToast('اتصال قطع شد');
    } catch (e) {
        vodiToast('❌ ' + e.message);
    } finally {
        vodiLive.busy = '';
        await vodiRefreshLive();
        vodiRender();
    }
}

/** What the hero says and what its button does — the one place that decides. */
function vodiView() {
    const gw = vodiActiveGw();
    const uri = vodiActiveUri();
    const on = vodiConnectedHere();
    const base = { gw, uri, on };

    if (vodiLive.busy === 'connect') return Object.assign(base, { tone: 'busy', act: '', head: 'در حال اتصال', line: 'اگر هنوز کانفیگی نگرفته بودیم، اول کانفیگ مدیر از خود سرور گرفته می‌شود…' });
    if (vodiLive.busy === 'disconnect') return Object.assign(base, { tone: 'busy', act: '', head: 'در حال قطع', line: 'چند لحظه…' });
    if (!gw) {
        return Object.assign(base, { tone: 'off', act: '',
            head: 'اول یک سرور بسازید',
            line: 'این پنجره یک سرور VLESS روی حساب <b>Railway</b> خودتان دیپلوی می‌کند — آی‌پی ثابت و اختصاصیِ خودتان، نه سرور مشترک. جادوگر شش‌مرحله‌ای در بخش «سرورها» همین کار را می‌کند.' });
    }
    if (on) {
        return Object.assign(base, { tone: 'on', act: 'disconnect',
            head: 'وصل است',
            line: `ترافیک از سرور خودتان روی <span dir="ltr">${vodiEsc(gw.domain || '')}</span> رد می‌شود. ${vodiPathNote()}` });
    }
    if (!uri) {
        return Object.assign(base, { tone: 'off', act: 'connect',
            head: 'سرور ساخته شده — هنوز کانفیگی از آن نگرفته‌ایم',
            line: 'دکمهٔ بالا کانفیگ مدیر را از خودِ سرور می‌گیرد و همان لحظه وصل می‌شود. کاربران دیگر را در بخش «کاربران» بسازید.' });
    }
    return Object.assign(base, { tone: 'off', act: 'connect',
        head: 'آمادهٔ اتصال',
        line: `${vodiEsc(gw.name || 'سرور شما')} روی <span dir="ltr">${vodiEsc(gw.domain || '')}</span>. ${vodiPathNote()}` });
}

/** How this machine's traffic gets in — the same sentence the other config pages carry. */
function vodiPathNote() {
    if (vodiLive.tunnel) return 'تونل کامل روشن است: تمام ترافیک این کامپیوتر از همین سرور رد می‌شود.';
    if (vodiLive.proxyMode === 'port') return '«فقط پورت محلی» در تنظیمات › شبکه روشن است: پروکسی ویندوز دست نمی‌خورد.';
    return vodiGetMode() === 'tunnel'
        ? 'حالت «تونل کامل» انتخاب شده — با اتصال، کل ترافیک سیستم از این سرور رد می‌شود.'
        : 'با یک ضربه وصل می‌شود و پروکسی سیستم روشن می‌شود.';
}

/**
 * The proxy/tunnel picker.
 *
 * Two genuinely different things, so they are a choice and not a hidden default: a proxy
 * only carries what asks Windows for one (browsers, mostly), while the tunnel puts an
 * adapter in front of the whole machine so games, launchers and anything that ignores the
 * proxy go through too — at the cost of needing the adapter and Administrator.
 */
function vodiModePickerHTML() {
    const mode = vodiGetMode();
    const cell = (id, icon, label, hint) => `
      <button type="button" class="vodi-mode${mode === id ? ' is-on' : ''}" data-vodi-mode="${id}"
              aria-pressed="${mode === id}">
        <i class="${icon}"></i>
        <span><b>${label}</b><small>${hint}</small></span>
      </button>`;
    return `
      <div class="vodi-mode-row" role="group" aria-label="حالت عبور ترافیک">
        ${cell('proxy', 'ph-fill ph-browser', 'پروکسی سیستم', 'فقط برنامه‌هایی که از پروکسی ویندوز استفاده می‌کنند')}
        ${cell('tunnel', 'ph-fill ph-shield-check', 'تونل کامل', 'تمام ترافیک کامپیوتر — بازی و هر برنامهٔ دیگر')}
      </div>`;
}

function vodiRenderIdent() {
    const host = document.getElementById('vodi-ident');
    if (!host) return;
    const v = vodiView();
    const word = v.tone === 'on' ? 'وصل است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
    const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('vodi');
    const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
        : '<span class="mv-ic is-cover" style="--sz:54px;--art-bg:#FFFFFF">' + ((window.MV && MV.icons && MV.icons.svg) ? MV.icons.svg('g-railway-art') : '') + '</span>';
    host.innerHTML = `${icon}
      <b>railway</b>
      <small>${vodiDot(v.tone)}${word}</small>`;
}

/** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
function vodiRenderStage() {
    const host = document.getElementById('vodi-stage');
    if (!host) return;
    const v = vodiView();

    if (host.dataset.built !== '1') {
        host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-vodi-act="power" data-part="power">
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
    btn.disabled = !v.act || !!vodiLive.busy;
    const aria = v.act === 'disconnect' ? 'قطع' : 'اتصال';
    btn.setAttribute('aria-label', aria);
    btn.title = v.act ? aria : 'اول یک سرور بسازید';
    const glyph = v.tone === 'busy' ? 'mv-spin-ring' : (v.tone === 'on' ? 'ph-fill ph-power' : 'ph-bold ph-power');
    const gl = q('glyph');
    if (gl.className !== glyph) gl.className = glyph;

    const el = q('live');
    if (el && window.MVEngineLive) MVEngineLive.mount(el);
}

/** The three things that have to happen once, as one line. Gone once it is all behind. */
function vodiRenderFlow() {
    const wrap = document.getElementById('vodi-flow');
    const host = document.getElementById('vodi-steps');
    if (!wrap || !host) return;

    const on = vodiConnectedHere();
    wrap.style.display = on ? 'none' : 'flex';
    if (on) return;

    const done = { server: !!vodiActiveGw(), config: !!vodiActiveUri(), connect: false };
    const idx = VODI_STEPS.findIndex((x) => !done[x.key]);
    host.innerHTML = VODI_STEPS.map((x, i) => {
        let cls = 'pending', mark = vodiFa(i + 1);
        if (done[x.key]) { cls = 'done'; mark = '✓'; }
        else if (i === idx) { cls = 'active'; mark = '●'; }
        return `<span class="mv-step is-${cls}"><i>${mark}</i>${x.fa}</span>`;
    }).join('');
}

/** The cards: the server, the config the button dials, its users, and what has been saved. */
function vodiRenderCards() {
    const host = document.getElementById('vodi-cards');
    if (!host) return;
    const v = vodiView();
    const gw = v.gw;
    const gws = vodiState.gateways || [];
    const nodes = vodiGwNodes();
    const users = vodiState.users || [];

    if (!gw) {
        host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-pink, #FF2D55)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-vodi-go="servers">
            <span class="mv-eng-glyph"><i class="ph-fill ph-hard-drives"></i></span>
            <h3>سرورها</h3>
            <span class="mv-eng-card2-end">ندارید<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-vodi-act="wizard" title="ساخت سرور تازه" aria-label="ساخت سرور تازه">
            <i class="ph-bold ph-plus"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          <div class="mv-eng-card2-foot" style="padding-top:6px">جادوگر شش‌مرحله‌ای یک پنل VodiWalker را روی حساب Railway خودتان دیپلوی می‌کند. به یک حساب Railway وریفای‌شده نیاز دارید.</div>
        </div>
      </div>`;
        return;
    }

    host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-pink, #FF2D55)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-vodi-go="servers">
            <span class="mv-eng-glyph"><i class="ph-fill ph-hard-drives"></i></span>
            <h3>سرور</h3>
            <span class="mv-eng-card2-end">${gws.length > 1 ? vodiFa(gws.length) + ' سرور' : vodiEsc(vodiRegionLabel(gw.region))}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-vodi-act="wizard" title="ساخت سرور تازه" aria-label="ساخت سرور تازه">
            <i class="ph-bold ph-plus"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${gws.map((g) => {
            const sel = g.id === gw.id;
            return `
          <button type="button" class="mv-eng-pick${sel ? ' is-on' : ''}" data-vodi-pick-gw="${vodiEsc(g.id)}"
                  aria-pressed="${sel}" ${gws.length < 2 ? 'aria-disabled="true"' : ''}>
            <i class="${sel ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>
            <span class="mv-eng-pick-text"><b>${vodiEsc(g.name)}${gws.length > 1 ? ' · ' + vodiEsc(vodiRegionLabel(g.region)) : ''}</b><small dir="ltr">${vodiEsc(g.domain || '—')}</small></span>
          </button>`;
          }).join('')}
          <div class="vodi-card-actions" style="padding:2px 9px 0">
            <button class="vodi-btn-xs" data-vodi-act="ping">تست اتصال</button>
            <button class="vodi-btn-xs" data-vodi-act="auth">تست رمز</button>
          </div>
          <div class="vodi-test-result" id="vodi-test-${vodiEsc(gw.id)}" style="padding:0 9px"></div>
        </div>
        <div class="mv-eng-card2-foot">${gws.length > 1
            ? 'آی‌پی هر سرور فقط مال شماست. روی هر کدام بزنید، دکمهٔ اتصال از همان رد می‌شود — این‌طور می‌توانید لوکیشن‌ها را با هم مقایسه کنید.'
            : 'آی‌پی این سرور فقط مال شماست. اگر از ایران در دسترس نبود، سرور دیگری در لوکیشن دیگر بسازید — آی‌پی تازه می‌گیرد.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-vodi-go="nodes">
            <span class="mv-eng-glyph"><i class="ph-fill ph-qr-code"></i></span>
            <h3>کانفیگ فعال</h3>
            <span class="mv-eng-card2-end">${nodes.length ? vodiFa(nodes.length) : '—'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-vodi-act="admin-config"
                  title="گرفتن کانفیگ مدیر از سرور" aria-label="گرفتن کانفیگ مدیر از سرور">
            <i class="ph-bold ph-arrows-clockwise"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${nodes.length ? nodes.slice(0, 4).map((n, i) => `
          <button type="button" class="mv-eng-pick${i === 0 ? ' is-on' : ''}${i === 0 && v.on ? ' is-live' : ''}"
                  data-vodi-pick-node="${vodiEsc(n.id)}" aria-pressed="${i === 0}">
            <i class="${i === 0 ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>
            <span class="mv-eng-pick-text"><b>${vodiEsc(n.name)}</b><small>${vodiPickMeta(n)}</small></span>
          </button>`).join('')
            : '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز کانفیگی گرفته نشده — دکمهٔ بالا کانفیگ مدیر را از سرور می‌گیرد.</div>'}
        </div>
        <div class="mv-eng-card2-foot">${nodes.length > 1
            ? 'دکمهٔ اتصال همان کانفیگی را می‌زند که اینجا انتخاب شده. اعدادش از «تست تأخیر» و «تست سرعت» در بخش «کانفیگ‌های دریافتی» می‌آید — تا تست نزده‌اید خط تیره است.'
            : 'دکمهٔ اتصال همین کانفیگ را می‌زند. در بخش «کانفیگ‌های دریافتی» می‌توانید تأخیر و سرعتش را بسنجید یا به پنجرهٔ V2Ray بفرستیدش.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-green)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-vodi-go="users">
            <span class="mv-eng-glyph"><i class="ph-fill ph-users-three"></i></span>
            <h3>کاربران</h3>
            <span class="mv-eng-card2-end">${users.length ? vodiFa(users.length) : '—'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-vodi-act="add-user" title="ساخت کاربر تازه" aria-label="ساخت کاربر تازه">
            <i class="ph-bold ph-plus"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${users.length ? users.slice(0, 3).map((u) => `
          <div class="mv-eng-pick" aria-disabled="true">
            <i class="ph-fill ph-circle" style="color:${u.expired ? 'var(--mv-red)' : u.active ? 'var(--mv-green)' : 'var(--mv-gray)'}"></i>
            <span class="mv-eng-pick-text"><b>${vodiEsc(u.label)}</b><small>${vodiFmtBytes(u.used_bytes || 0)} از ${u.limit_bytes > 0 ? vodiFmtBytes(u.limit_bytes) : '∞'}</small></span>
          </div>`).join('')
            : '<div class="mv-eng-card2-foot" style="padding-top:6px">فهرست کاربران وقتی خوانده می‌شود که بخش «کاربران» را باز کنید.</div>'}
        </div>
        <div class="mv-eng-card2-foot">هر کاربر کانفیگ خودش، سهمیهٔ خودش و محدودیت آی‌پی خودش را دارد — همه روی همین سرور.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-key"></i></span>
          <h3>ورود ادمین</h3>
          <span class="mv-eng-card2-end">داشبورد پنل</span>
        </div>
        <div class="mv-eng-card2-body">
          <div class="vodi-pass-row" style="padding:2px 9px">
            <span class="vodi-pass-label">نام کاربری:</span>
            <code class="vodi-pass">${vodiEsc(gw.adminUsername || 'admin')}</code>
          </div>
          <div class="vodi-pass-row" style="padding:2px 9px">
            <span class="vodi-pass-label">رمز:</span>
            <code class="vodi-pass" id="vodi-pass-${vodiEsc(gw.id)}">${vodiEsc(gw.adminPassword || '—')}</code>
            <button class="vodi-btn-xs" data-vodi-act="copy-pass">کپی</button>
          </div>
        </div>
        <div class="mv-eng-card2-foot">با همین نام کاربری و رمز می‌توانید داشبورد پنل را روی دامنهٔ بالا باز کنید. این مشخصات فقط روی همین کامپیوتر ذخیره شده‌اند.</div>
      </div>`;
}

function vodiRenderFoot() {
    const host = document.getElementById('vodi-foot');
    if (!host) return;
    const v = vodiView();
    const word = v.tone === 'on' ? 'وصل — سرور خودتان'
        : v.tone === 'busy' ? 'در حال کار'
            : v.gw ? (v.uri ? 'آمادهٔ اتصال' : 'کانفیگی گرفته نشده') : 'سروری ندارید';
    const end = vodiLive.tunnel ? 'تونل کامل سیستم' : vodiLive.proxyMode === 'port' ? 'فقط پورت محلی' : 'پروکسی سیستم';
    host.innerHTML = `
      ${vodiDot(v.tone)}
      <span>${word}</span>
      <span class="mv-eng-foot-end">${v.gw ? `<code dir="ltr">${vodiEsc(v.gw.domain || '')}</code>` : ''}<span>${end}</span></span>`;
}

function vodiGoSec(id) {
    const wrap = document.getElementById('vodi-wrapper');
    if (!wrap) return;
    vodiSec = VODI_SECTIONS.some((x) => x.id === id) ? id : 'connect';
    vodiState.view = vodiSec === 'users' ? 'manage' : 'list';

    wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === vodiSec));
    wrap.querySelectorAll('.mv-side-item[data-vodi-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-vodi-sec') === vodiSec));
    const found = VODI_SECTIONS.find((x) => x.id === vodiSec);
    const title = document.getElementById('vodi-pane-title');
    if (title) title.textContent = found ? found.label : '';
    const back = document.getElementById('vodi-back');
    if (back) back.disabled = vodiSec === 'connect';
    const pane = wrap.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', vodiSec === 'connect');
    const sc = document.getElementById('vodi-scroll');
    if (sc) sc.scrollTop = 0;

    vodiRender();
    // The user list is a live call to the user's own server, so it is made when the
    // section is opened.
    if (vodiSec === 'users' && vodiActiveGw()) {
        vodiState.activeGatewayId = vodiActiveGw().id;
        vodiLoadUsers();
        vodiLoadTelemetry();
    }
}

function vodiWire(root) {
    root.querySelectorAll('[data-vodi-go]').forEach((b) => {
        b.onclick = () => vodiGoSec(b.getAttribute('data-vodi-go'));
    });
    // The two pickers on the connect screen. Disabled while a connect/disconnect is in
    // flight: the answer to "which one does the button dial" must not move under a request
    // that is already carrying the old one.
    root.querySelectorAll('[data-vodi-pick-gw]').forEach((b) => {
        b.disabled = !!vodiLive.busy;
        b.onclick = () => {
            const id = b.getAttribute('data-vodi-pick-gw');
            const cur = vodiActiveGw();
            if (cur && cur.id === id) return;
            vodiPickTarget({ gw: id, node: '' });
        };
    });
    root.querySelectorAll('[data-vodi-pick-node]').forEach((b) => {
        b.disabled = !!vodiLive.busy;
        b.onclick = () => {
            const id = b.getAttribute('data-vodi-pick-node');
            const cur = vodiActiveNode();
            if (cur && cur.id === id) return;
            vodiPickTarget({ node: id });
        };
    });
    root.querySelectorAll('[data-vodi-act]').forEach((b) => {
        b.onclick = () => {
            const k = b.getAttribute('data-vodi-act');
            const gw = vodiActiveGw();
            if (k === 'power') {
                const act = vodiView().act;
                if (act === 'disconnect') vodiDisconnect();
                else if (act === 'connect') vodiConnect();
            } else if (k === 'wizard') vodiStartWizard();
            else if (k === 'admin-config' && gw) vodiGetAdminConfig(gw.id);
            else if (k === 'add-user' && gw) { vodiGoSec('users'); setTimeout(() => vodiOpenUserForm(), 80); }
            else if (k === 'copy-pass' && gw) vodiCopyPass(gw.id);
            else if ((k === 'ping' || k === 'auth') && gw) vodiTest(gw.id, k);
        };
    });
}

function vodiRender() {
    const host = document.getElementById('ls-vodi');
    if (!host) return;

    if (!document.getElementById('vodi-wrapper')) {
        host.innerHTML = vodiHtmlTemplate;
        const wrap = document.getElementById('vodi-wrapper');
        wrap.querySelectorAll('.mv-side-item[data-vodi-sec]').forEach((b) => {
            b.onclick = () => vodiGoSec(b.getAttribute('data-vodi-sec'));
        });
        const back = document.getElementById('vodi-back');
        if (back) back.onclick = () => vodiGoSec('connect');
        const store = document.getElementById('vodi-store');
        // The store has one row PER SERVER (store-manager.js › vodiRows), because what gets
        // updated is the image running on that particular Railway service — not one shared
        // package. So this opens the page of the server the window is about.
        if (store) store.onclick = () => {
            const gw = vodiActiveGw();
            if (gw && typeof window.storeOpenItem === 'function') window.storeOpenItem('vodi|' + gw.id);
            else if (window.MV && MV.wm) MV.wm.open('store');
        };
        vodiGoSec('connect');
        return;      // vodiGoSec calls back in, with the shell in place
    }

    vodiRenderIdent();
    vodiRenderFoot();
    if (vodiSec === 'connect') { vodiRenderStage(); vodiRenderMode(); vodiRenderSpeed(); vodiRenderFlow(); vodiRenderCards(); }
    else if (vodiSec === 'servers') vodiRenderList();
    else if (vodiSec === 'users') vodiRenderManage();
    // Only when that section is on screen. This runs on the 5-second background tick too,
    // and rebuilding the measurement bar's innerHTML under a running test throws away the
    // «لغو» button the user may be reaching for — the same class of bug as the user list
    // blanking every tick. The direct callers (a config arriving, one being deleted, the
    // test itself) still redraw it regardless of which section is open.
    if (vodiSec === 'nodes') vodiRenderNodes();
    vodiWire(document.getElementById('vodi-wrapper'));
}

function vodiRenderMode() {
    const host = document.getElementById('vodi-mode');
    if (!host) return;
    // Nothing to choose between until there is a server to dial.
    if (!vodiActiveGw()) { host.innerHTML = ''; return; }
    host.innerHTML = vodiModePickerHTML();
    host.querySelectorAll('[data-vodi-mode]').forEach((b) => {
        b.onclick = () => vodiPickMode(b.getAttribute('data-vodi-mode'));
        b.disabled = !!vodiLive.busy;
    });
}

// ── tunnel speed ─────────────────────────────────────────────────────────────────
//
// «تونلش کند است» is not something to guess at. The app already measures the ONE thing
// that separates the two possible causes: the same download through the TUN adapter and
// again straight into the engine behind it (tun-diag.js › diagnose, POST /api/tun/diagnose).
//   · both about equal  → the server is what is slow; no tunnel setting will change it.
//   · tunnel far below  → the loss is in the adapter layer, and THAT has a lever.
//
// The lever is the network stack. `gvisor` reimplements TCP in userspace and is the app's
// long-standing default because it works on every machine; `system` hands packets to
// Windows' own stack and is measurably faster. It is offered HERE, where the slowness is
// felt, instead of being switched on for everybody — see Settings › شبکه for the same
// control.

const vodiSpeed = { busy: false, res: null, err: '', switching: false };

function vodiRenderSpeed() {
    const host = document.getElementById('vodi-speed');
    if (!host) return;
    // The measurement compares the tunnel against its engine, so it means nothing without a
    // tunnel. In proxy mode there is no adapter in the path at all.
    if (!vodiLive.tunnel || !vodiConnectedHere()) { host.innerHTML = ''; return; }

    const r = vodiSpeed.res;
    const lossy = r && r.verdict === 'tunnel-loss';
    const canSwitch = lossy && r.stack === 'gvisor';
    host.innerHTML = `
      <div class="vodi-speed${r ? (lossy ? ' is-warn' : ' is-ok') : ''}">
        <div class="vodi-speed-head">
          <b>سرعت تونل</b>
          <button class="vodi-btn-sm" id="vodi-speed-run" ${vodiSpeed.busy ? 'disabled' : ''}>
            ${vodiSpeed.busy ? 'در حال سنجش…' : (r ? 'سنجش دوباره' : 'سنجش سرعت')}
          </button>
        </div>
        ${vodiSpeed.busy ? `<div class="vodi-speed-note">دو دانلود پشت سر هم انجام می‌شود — یکی از داخل تونل، یکی مستقیم از خود سرور. روی خط کند نزدیک یک دقیقه طول می‌کشد.</div>` : ''}
        ${vodiSpeed.err ? `<div class="vodi-speed-note err">❌ ${vodiEsc(vodiSpeed.err)}</div>` : ''}
        ${r ? `
          <div class="vodi-speed-nums">
            <span>از داخل تونل: <b>${vodiFa(r.tunMbit)}</b> Mbit/s</span>
            <span>مستقیم از سرور: <b>${vodiFa(r.engineMbit)}</b> Mbit/s</span>
            <span>استک: <b>${vodiEsc(r.stack || '—')}</b></span>
            ${r.mtu ? `<span>MTU: <b>${vodiFa(r.mtu)}</b></span>` : ''}
          </div>
          <div class="vodi-speed-note">${vodiEsc(r.note || '')}</div>` : ''}
        ${canSwitch ? `
          <div class="vodi-speed-fix">
            <div>سرعت در لایهٔ تونل از بین می‌رود، نه در سرور. این تونل روی استک <b>gvisor</b> است که TCP را در نرم‌افزار پیاده می‌کند. استک <b>system</b> بسته‌ها را به خود ویندوز می‌سپارد و معمولاً محسوس‌تر است.</div>
            <button class="vodi-btn-primary" id="vodi-speed-fast" ${vodiSpeed.switching ? 'disabled' : ''}>
              ${vodiSpeed.switching ? 'در حال اعمال…' : 'استک سریع را روشن کن'}
            </button>
          </div>` : ''}
      </div>`;

    const run = document.getElementById('vodi-speed-run');
    if (run) run.onclick = vodiRunSpeedTest;
    const fast = document.getElementById('vodi-speed-fast');
    if (fast) fast.onclick = vodiUseFastStack;
}

async function vodiRunSpeedTest() {
    if (vodiSpeed.busy) return;
    vodiSpeed.busy = true; vodiSpeed.err = '';
    vodiRenderSpeed();
    try {
        const d = await vodiCallV2ray('/api/tun/diagnose', {});
        if (d.error) throw new Error(d.error);
        vodiSpeed.res = d;
    } catch (e) {
        vodiSpeed.err = e.message;
        vodiSpeed.res = null;
    } finally {
        vodiSpeed.busy = false;
        vodiRenderSpeed();
    }
}

/**
 * Move this machine to the faster network stack.
 *
 * `auto` rather than `system`: it asks for the fast stack and falls back to gvisor the
 * moment it refuses to come up, so a machine where `system` cannot work is not left with a
 * tunnel that will not start. The change lands on the NEXT tunnel, so the tunnel is cycled
 * here rather than telling the user to do it.
 */
async function vodiUseFastStack() {
    if (vodiSpeed.switching) return;
    vodiSpeed.switching = true;
    vodiRenderSpeed();
    try {
        const saved = await vodiCallV2ray('/api/network', { tunStack: 'auto' });
        if (saved.error) throw new Error(saved.error);
        vodiToast('استک سریع ذخیره شد — تونل دوباره برقرار می‌شود…');
        const off = await vodiCallV2ray('/api/v2ray/tun', { enabled: false });
        if (off.error) throw new Error(off.error);
        const on = await vodiCallV2ray('/api/v2ray/tun', { enabled: true });
        if (on.error) throw new Error('تونل با استک تازه بالا نیامد: ' + on.error);
        vodiSpeed.res = null;
        vodiToast('✅ تونل با استک سریع برقرار شد — دوباره سرعت را بسنجید');
    } catch (e) {
        vodiToast('❌ ' + e.message);
    } finally {
        vodiSpeed.switching = false;
        await vodiRefreshLive();
        vodiRender();
    }
}

function vodiRenderList() {
    const body = document.getElementById('vodi-sec-servers');
    if (!body) return;
    const gws = vodiState.gateways;
    body.innerHTML = `
      <div class="vodi-actions">
        <button class="vodi-btn-primary" onclick="vodiStartWizard()">+ ساخت سرور جدید</button>
      </div>
      ${gws.length === 0 ? `
        <div class="vodi-empty">
          هنوز سروری نساخته‌ای.<br>
          با دکمه‌ی بالا، قدم‌به‌قدم یک پنل VodiWalker روی حساب Railway خودت دیپلوی کن.
        </div>` :
        `<div class="vodi-card-grid">${gws.map(g => `
          <div class="vodi-card">
            <div class="vodi-card-top">
              <div style="min-width:0;">
                <div class="vodi-card-name">${vodiEsc(g.name)}</div>
                <div class="vodi-card-dom" title="${vodiEsc(g.domain)}">${vodiEsc(g.domain || '—')}</div>
              </div>
              <span class="vodi-badge">${vodiEsc(vodiRegionLabel(g.region))}</span>
            </div>
            <div class="vodi-pass-row">
              <span class="vodi-pass-label">ورود ادمین:</span>
              <code class="vodi-pass">${vodiEsc(g.adminUsername || 'admin')}</code>
              <code class="vodi-pass" id="vodi-pass-${g.id}">${vodiEsc(g.adminPassword || '—')}</code>
              <button class="vodi-btn-xs" onclick="vodiCopyPass('${g.id}')">کپی</button>
            </div>
            <div class="vodi-card-actions">
              <button class="vodi-btn-sm vodi-btn-blue" onclick="vodiOpenManage('${g.id}')">مدیریت کاربران</button>
              <button class="vodi-btn-sm" onclick="vodiGetAdminConfig('${g.id}')">کانفیگ مدیر</button>
              <button class="vodi-btn-sm" onclick="vodiTest('${g.id}','ping')">تست اتصال</button>
              <button class="vodi-btn-sm" onclick="vodiTest('${g.id}','auth')">تست رمز</button>
              <button class="vodi-btn-sm vodi-btn-danger" onclick="vodiDeleteGateway('${g.id}','${vodiEsc(g.name)}')">حذف سرور</button>
            </div>
            <div class="vodi-test-result" id="vodi-test-${g.id}"></div>
          </div>`).join('')}</div>`
      }
    `;
}

function vodiCopyPass(id) {
    const g = vodiState.gateways.find(x => x.id === id);
    if (!g || !g.adminPassword) return;
    try { navigator.clipboard.writeText(g.adminPassword); vodiToast('رمز کپی شد'); }
    catch (e) { vodiToast('کپی نشد'); }
}

/** Run one of the two per-server diagnostics and show the answer on the card. */
async function vodiTest(id, what) {
    const box = document.getElementById('vodi-test-' + id);
    if (box) { box.className = 'vodi-test-result'; box.textContent = what === 'ping' ? 'در حال تست اتصال…' : 'در حال تست رمز…'; }
    try {
        const r = await vodiFetch(`/api/vodi/gateways/${id}/test?what=${what}`);
        const t = r.result || {};
        let cls = 'vodi-test-result', text = '';
        if (what === 'ping') {
            if (t.reachable) { cls += ' ok'; text = `✅ سرور در دسترس است — پاسخ در ${t.ms} میلی‌ثانیه`; }
            else {
                cls += ' err';
                text = `❌ اتصال برقرار نشد: ${t.pingError || 'نامشخص'}`;
                if (t.verdict === 'limited-trial') {
                    text += `\n⚠️ علت: حساب Railway روی پلن Limited Trial (رایگان) است.`
                          + ' سرویس اجرا شده ولی شبکه‌اش محدود است، پس دامنه از بیرون جواب نمی‌دهد.'
                          + '\nراه‌حل: حساب را وریفای کنید — اتصال GitHub یا افزودن روش پرداخت در Railway.';
                } else if (t.verdict === 'server-ok-network-blocked') {
                    text += `\n⚠️ ولی Railway می‌گوید سرویس سالم است (${t.deployStatus}).`
                          + ' یعنی خودِ سرور مشکلی ندارد و آی‌پی این سرور از اینجا در دسترس نیست.'
                          + ' این سرور را حذف کن و یکی جدید (ترجیحاً در لوکیشن دیگر) بساز تا آی‌پی دیگری بگیری.';
                } else if (t.verdict === 'server-not-running') {
                    text += `\n⚠️ وضعیت سرویس در Railway: ${t.deployStatus} — سرور واقعاً بالا نیامده.`;
                }
            }
        } else {
            if (t.authOk) { cls += ' ok'; text = `✅ رمز درست است — ورود به پنل موفق بود${t.gotSession ? '' : ' (ولی کوکی سشن نیامد)'}`; }
            else { cls += ' err'; text = `❌ ${t.authError || 'ورود ناموفق'}`; }
        }
        if (box) { box.className = cls; box.textContent = text; }
    } catch (e) {
        if (box) { box.className = 'vodi-test-result err'; box.textContent = '❌ ' + e.message; }
    }
}

function vodiRegionLabel(v) {
    const r = vodiState.regions.find(r => r.value === v);
    return r ? r.label : (v || 'لوکیشن پیش‌فرض');
}

// ── deploy wizard ────────────────────────────────────────────────────────────────

function vodiStartWizard() {
    vodiState.wizard = { step: 1, accountId: '', name: '', region: (vodiState.regions[0] || {}).value || '', username: 'admin', password: '' };
    vodiRenderWizard();
    // Load GitHub state in the background so step 2 already knows what is connected.
    vodiGithubStatus().then(() => { if (vodiState.wizard && vodiState.wizard.step === 2) vodiRenderWizard(); });
}

function vodiCloseWizard() {
    vodiState.wizard = null;
    // Leaving the wizard abandons any sign-in it started. The guard has to be released or
    // reopening the wizard would refuse every step, and the backend's device-code poll is
    // told to stop rather than being left running against a flow nobody is watching.
    if (vodiState.flow === 'github' || vodiState.flow === 'github-repo') {
        vodiFetch('/api/vodi/github/cancel', { method: 'POST' }).catch(() => {});
    }
    vodiState.flow = '';
    vodiStopLogTap();
    vodiRenderWizard();          // hides the overlay
    vodiGoSec('servers');
    vodiRefresh();
}

function vodiRenderWizard() {
    const body = document.getElementById('vodi-wizard');
    const w = vodiState.wizard;
    if (!body) return;
    if (!w) { body.style.display = 'none'; body.innerHTML = ''; return; }
    body.style.display = 'flex';
    let inner = '';
    if (w.step === 1) {
        inner = `
          <div class="vodi-step-title">۱ / ۶ — پیش‌نیاز و راهنما</div>
          <div class="vodi-guide">
            این ابزار پنل VLESS «VodiWalker» را به‌صورت خودکار روی حساب <b>Railway</b> خودت دیپلوی می‌کند
            و بعد می‌توانی کاربران و کانفیگ‌ها را از همین‌جا بسازی و مدیریت کنی.
            <br><br>
            <b>پیش‌نیاز:</b> یک حساب Railway با پلن فعال و یک <b>API Token</b>.
            <div class="vodi-note">
              گرفتن توکن: در سایت Railway → Account Settings → Tokens → یک توکن جدید بساز و کپی کن.
            </div>
          </div>
          <div class="vodi-wiz-actions">
            <button class="vodi-btn-ghost" onclick="vodiCloseWizard()">انصراف</button>
            <button class="vodi-btn-primary" onclick="vodiWizardNext(2)">بعدی</button>
          </div>`;
    } else if (w.step === 2) {
        // Railway verification hinges on a GitHub account that OWNS a repo. Ask plainly
        // instead of letting the user discover it as an unexplained dead server.
        const gh = vodiState.github || {};
        const pend = gh.pending;
        // A sign-in already running must look running, or the only feedback the user has is
        // a button that still invites another click.
        const ghBusy = vodiFlowBusy('github') || vodiFlowBusy('github-repo');
        inner = `
          <div class="vodi-step-title">۲ / ۶ — حساب گیت‌هاب</div>
          <div class="vodi-guide">
            برای اینکه Railway محدودیت شبکه را بردارد، باید حساب Railway <b>وریفای</b> شود —
            و وریفای فقط با حساب گیت‌هابی قبول می‌شود که <b>حداقل یک ریپازیتوری</b> داشته باشد.
            <div class="vodi-note">حساب گیت‌هاب تازه و خالی پذیرفته نمی‌شود.</div>
          </div>

          ${(gh.accounts || []).length ? `
            <div class="vodi-oauth-box">
              <div class="vodi-oauth-title">حساب‌های گیت‌هاب متصل</div>
              ${(gh.accounts || []).map(a => `
                <div class="vodi-acc-row">
                  <div class="vodi-acc-name">✅ ${vodiEsc(a.login || a.name)}${a.repoCount ? ` — ${a.repoCount} ریپو` : ''}</div>
                  <button class="vodi-btn-xs" onclick="vodiGithubEnsureRepo('${a.id}')" ${ghBusy ? 'disabled' : ''}>بررسی/ساخت ریپو</button>
                  <button class="vodi-btn-xs vodi-btn-danger" onclick="vodiGithubDisconnect('${a.id}')">حذف</button>
                </div>`).join('')}
            </div>` : ''}

          ${pend && pend.state === 'waiting' ? `
            <div class="vodi-oauth-box">
              <div class="vodi-oauth-title">این کد را در مرورگر وارد کنید</div>
              <div class="vodi-code">${vodiEsc(pend.userCode)}</div>
              <div class="vodi-hint">صفحهٔ <code style="direction:ltr">${vodiEsc(pend.verificationUri)}</code> باز شد.
              کد بالا را وارد کن و دسترسی را تأیید کن. همین‌جا منتظر می‌مانیم…</div>
            </div>` : ''}
          ${pend && pend.state === 'error' ? `<div class="vodi-warn">${vodiEsc(pend.error)}</div>` : ''}

          <div id="vodi-gh-msg" class="vodi-inline-msg"></div>

          <div class="vodi-wiz-actions">
            <button class="vodi-btn-ghost" onclick="vodiWizardNext(1)">قبلی</button>
            <button class="vodi-btn-ghost" onclick="vodiGithubLogin()" ${ghBusy ? 'disabled' : ''}>${ghBusy ? 'در حال اتصال…' : 'اتصال گیت‌هاب و ساخت ریپو'}</button>
            <button class="vodi-btn-primary" onclick="vodiWizardNext(3)">حساب گیت‌هاب دارم، ادامه</button>
          </div>`;
    } else if (w.step === 3) {
        const opts = vodiState.accounts.map(a =>
            `<option value="${a.id}" ${a.id === w.accountId ? 'selected' : ''}>${vodiEsc(a.name)}</option>`).join('');
        const oa = vodiState.oauth || {};
        const oaBusy = vodiFlowBusy('oauth');
        inner = `
          <div class="vodi-step-title">۳ / ۶ — حساب Railway</div>

          <div class="vodi-oauth-box">
            ${oa.connected ? `
              <div class="vodi-oauth-title">حساب‌های متصل Railway</div>
              ${(oa.accounts || []).map(a => `
                <div class="vodi-acc-row">
                  <div class="vodi-acc-name">✅ ${vodiEsc(a.name)}${a.needsReauth ? ' <span class="vodi-tag">نیاز به ورود مجدد</span>' : ''}</div>
                  <button class="vodi-btn-xs vodi-btn-danger" onclick="vodiOauthDisconnect('${a.id}')">خروج</button>
                </div>`).join('')}
              ${(oa.accounts || []).some(a => a.needsReauth) ? `
                <div class="vodi-warn">یکی از ورودها دسترسی ساخت پروژه ندارد (scope قدیمی) — دوباره وارد شوید.</div>` : ''}
              <button class="vodi-btn-primary" style="width:100%;margin-top:4px" onclick="vodiOauthLogin()" ${oaBusy ? 'disabled' : ''}>
                ${oaBusy ? 'در انتظار تکمیل ورود در مرورگر…' : '+ افزودن حساب Railway دیگر'}
              </button>
              <div class="vodi-hint">می‌توانید چند حساب Railway وصل کنید و هر سرور را روی حساب دلخواه بسازید.</div>
            ` : `
              <div class="vodi-oauth-title">ساده‌ترین راه</div>
              <div class="vodi-hint">با یک کلیک وارد حساب Railway خود شوید؛ دیگر نیازی به ساخت و کپی توکن دستی نیست.</div>
              ${oa.hasClientId ? '' : `
                <div class="vodi-field" style="margin-top:8px;">
                  <label>Client ID اپلیکیشن OAuth</label>
                  <input id="vodi-oauth-client" placeholder="از Railway → Workspace Settings → Developer">
                  <div class="vodi-hint">یک‌بار لازم است: در Railway یک OAuth App از نوع <b>Native</b> بسازید و
                  این آدرس را به‌عنوان Redirect URI ثبت کنید:<br>
                  <code style="direction:ltr;display:inline-block;margin-top:4px">${vodiEsc(oa.redirectUri || 'http://localhost:53682/callback')}</code></div>
                </div>`}
              <button class="vodi-btn-primary" style="margin-top:8px;width:100%" onclick="vodiOauthLogin()" ${oaBusy ? 'disabled' : ''}>${oaBusy ? 'در انتظار تکمیل ورود در مرورگر…' : 'ورود با Railway'}</button>
            `}
          </div>

          <div class="vodi-or">یا</div>

          <div class="vodi-field">
            <label>انتخاب حساب</label>
            <select id="vodi-acc-select">${opts || '<option value="">— حسابی ذخیره نشده —</option>'}</select>
          </div>
          <details class="vodi-add-acc">
            <summary>افزودن حساب با توکن دستی</summary>
            <div class="vodi-field"><label>نام دلخواه</label><input id="vodi-new-acc-name" placeholder="مثلاً حساب اصلی"></div>
            <div class="vodi-field"><label>Railway API Token</label><input id="vodi-new-acc-token" placeholder="توکن را اینجا بچسبان"></div>
            <button class="vodi-btn-sm vodi-btn-blue" onclick="vodiAddAccount()">ذخیره حساب</button>
          </details>
          <div id="vodi-verify-msg" class="vodi-inline-msg"></div>
          <div class="vodi-wiz-actions">
            <button class="vodi-btn-ghost" onclick="vodiWizardNext(2)">قبلی</button>
            <button class="vodi-btn-ghost" onclick="vodiVerifyAccount()">بررسی اعتبار</button>
            <button class="vodi-btn-primary" onclick="vodiWizardNext(4)">بعدی</button>
          </div>`;
    } else if (w.step === 4) {
        const regs = vodiState.regions.map(r =>
            `<option value="${r.value}" ${r.value === w.region ? 'selected' : ''}>${vodiEsc(r.label)}</option>`).join('');
        inner = `
          <div class="vodi-step-title">۴ / ۶ — مشخصات سرور</div>
          <div class="vodi-field"><label>نام سرور (فقط برای خودت)</label>
            <input id="vodi-gw-name" value="${vodiEsc(w.name)}" placeholder="مثلاً سرور آلمان"></div>
          <div class="vodi-field"><label>کشور / لوکیشن سرور</label>
            <select id="vodi-gw-region">${regs}</select>
            <div class="vodi-hint">لوکیشن روی سرعت و آی‌پی خروجی اثر می‌گذارد.</div>
          </div>
          <div class="vodi-field"><label>نام کاربری ادمین</label>
            <input id="vodi-gw-user" value="${vodiEsc(w.username || 'admin')}" placeholder="admin">
            <div class="vodi-hint">پنل با نام کاربری و رمز وارد می‌شود. اگر مطمئن نیستی، همین «admin» را نگه دار.</div>
          </div>
          <div class="vodi-field"><label>رمز ادمین پنل</label>
            <input id="vodi-gw-pass" value="${vodiEsc(w.password || vodiRandomPass())}">
            <div class="vodi-hint">این رمز برای ورود به داشبورد پنل است. یک رمز امن برایت ساخته شد؛ می‌توانی همین را نگه داری یا عوض کنی.</div>
          </div>
          <div class="vodi-wiz-actions">
            <button class="vodi-btn-ghost" onclick="vodiWizardNext(3)">قبلی</button>
            <button class="vodi-btn-primary" onclick="vodiWizardNext(5)">شروع دیپلوی</button>
          </div>`;
    } else if (w.step === 5) {
        inner = `
          <div class="vodi-step-title">۵ / ۶ — در حال دیپلوی…</div>
          <div class="vodi-hint">این مرحله معمولاً ۱ تا ۳ دقیقه طول می‌کشد.
            می‌توانید همین حالا ببندید — سرور ساخته شده و در لیست سرورها ظاهر می‌شود؛
            وضعیتش را بعداً با «تست اتصال» ببینید.</div>
          <div id="vodi-deploy-log" class="vodi-log"></div>
          <div class="vodi-wiz-actions">
            <button class="vodi-btn-ghost" onclick="vodiCancelDeploy()">بستن</button>
            <button class="vodi-btn-primary" id="vodi-deploy-next" style="display:none;"
                    onclick="vodiWizardNext(6)">ادامه</button>
          </div>`;
    } else if (w.step === 6) {
        const g = w.deployedGateway || {};
        inner = `
          <div class="vodi-step-title">۶ / ۶ — انجام شد ✅</div>
          <div class="vodi-guide">
            سرور روی دامنه‌ی زیر بالا آمد:
            <div class="vodi-dom-box">${vodiEsc(g.domain || '')}</div>
            ${w.alive === false ? '<div class="vodi-warn">سرور هنوز کامل بالا نیامده؛ چند دقیقه بعد از «مدیریت کاربران» دوباره امتحان کن.</div>' : ''}
          </div>
          <div class="vodi-wiz-actions">
            <button class="vodi-btn-ghost" onclick="vodiCloseWizard()">لیست سرورها</button>
            <button class="vodi-btn-ghost" onclick="vodiGetAdminConfig('${g.id}')">دریافت کانفیگ مدیر</button>
            <button class="vodi-btn-primary" onclick="vodiOpenManage('${g.id}')">مدیریت کاربران</button>
          </div>`;
    }
    body.innerHTML = `<div class="vodi-wizard">${inner}</div>`;
    if (w.step === 5) vodiDoDeploy();
}

function vodiRandomPass() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    let s = ''; for (let i = 0; i < 14; i++) s += A[Math.floor(Math.random() * A.length)];
    vodiState.wizard.password = s;
    return s;
}

function vodiWizardNext(step) {
    const w = vodiState.wizard;
    if (!w) return;
    // capture current-step inputs
    if (w.step === 3) {
        const sel = document.getElementById('vodi-acc-select');
        if (sel) w.accountId = sel.value;
    }
    if (w.step === 4) {
        w.name = (document.getElementById('vodi-gw-name') || {}).value || w.name;
        w.region = (document.getElementById('vodi-gw-region') || {}).value || w.region;
        // Trimmed, because the panel trims it too: a username stored here with a stray
        // space would never match the one the server was actually created with.
        w.username = ((document.getElementById('vodi-gw-user') || {}).value || w.username || 'admin').trim();
        w.password = (document.getElementById('vodi-gw-pass') || {}).value || w.password;
    }
    if (step === 5 && !w.accountId) { vodiToast('اول یک حساب Railway انتخاب کن'); return; }
    w.step = step;
    vodiRenderWizard();
}

async function vodiAddAccount() {
    const name = (document.getElementById('vodi-new-acc-name') || {}).value || 'Railway';
    const token = (document.getElementById('vodi-new-acc-token') || {}).value || '';
    if (!token.trim()) { vodiToast('توکن را وارد کن'); return; }
    // Persist through the same PersistentStorage store the backend reads (railway_accounts).
    let list = [];
    try { list = JSON.parse(PersistentStorage.getItem('railway_accounts') || '[]'); } catch (e) {}
    const id = 'rw_' + Date.now();
    list.push({ id, name, token: token.trim() });
    const json = JSON.stringify(list);
    // setItem updates the in-memory cache instantly but debounces the write to the server
    // FILE by 200ms. The backend deployer reads that file directly, so we ALSO push it
    // synchronously here and await it — otherwise a deploy (or the accounts reload) fired
    // right after can read a file that hasn't been written yet. That race is exactly why a
    // freshly added token appeared to "not save" until the 2nd/3rd try.
    PersistentStorage.setItem('railway_accounts', json);
    try {
        await fetch('/api/storage-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: { railway_accounts: json } }),
        });
    } catch (e) { /* cache + debounced write still cover it */ }
    await vodiLoadAccounts();
    vodiState.wizard.accountId = id;
    vodiRenderWizard();
    vodiToast('حساب Railway ذخیره شد ✅');
}

// ── GitHub (device flow) ─────────────────────────────────────────────────────────

async function vodiGithubStatus() {
    try { vodiState.github = await vodiFetch('/api/vodi/github/status'); }
    catch (e) { vodiState.github = { connected: false, accounts: [] }; }
    return vodiState.github;
}

/** Device-flow login, then make sure the account owns a repo (creating one if needed). */
/**
 * Re-entrancy guard for the wizard's long steps.
 *
 * Signing in to GitHub or Railway takes minutes of the user staring at a browser, and the
 * button stayed live the whole time. Clicking it again did NOT resume the first attempt: it
 * asked for a second device code / opened a second consent window, retiring the first one —
 * so the step genuinely had to be done twice. Now a flow already in flight simply says so.
 */
function vodiFlowBusy(name) {
    return vodiState.flow === name;
}

function vodiFlowStart(name) {
    if (vodiState.flow) {
        vodiToast(vodiState.flow === name
            ? 'همین مرحله در جریان است — در مرورگر کاملش کنید'
            : 'یک مرحلهٔ دیگر در جریان است، صبر کنید');
        return false;
    }
    vodiState.flow = name;
    vodiRenderWizard();
    return true;
}

function vodiFlowEnd(name) {
    if (vodiState.flow === name) vodiState.flow = '';
    vodiRenderWizard();
}

async function vodiGithubLogin() {
    if (!vodiFlowStart('github')) return;
    const msg = document.getElementById('vodi-gh-msg');
    try {
        await vodiFetch('/api/vodi/github/start', { method: 'POST' });
        await vodiGithubStatus();
        vodiRenderWizard();                    // shows the code the user must type
        vodiToast('کد را در مرورگر وارد کنید');

        for (let i = 0; i < 100; i++) {       // device codes live ~15 minutes
            await new Promise(r => setTimeout(r, 3000));
            const st = await vodiGithubStatus();
            const p = st.pending;
            if (p && p.state === 'done') {
                vodiToast(`گیت‌هاب «${p.login}» متصل شد`);
                // The repo check belongs to this same flow, so the guard is handed over
                // rather than released and re-taken — otherwise a click landing in between
                // would start a second device flow on top of a finished one.
                vodiState.flow = 'github-repo';
                vodiRenderWizard();
                try { await vodiGithubEnsureRepo(p.accountId, true); } finally { vodiFlowEnd('github-repo'); }
                return;
            }
            if (p && p.state === 'error') { return; }
        }
    } catch (e) {
        if (msg) { msg.textContent = '❌ ' + e.message; msg.className = 'vodi-inline-msg err'; }
        else vodiToast('خطا: ' + e.message);
    } finally {
        vodiFlowEnd('github');
    }
}

/**
 * The whole point: guarantee this GitHub account owns at least one repository.
 * `inFlow` means the caller already holds the guard and will release it.
 */
async function vodiGithubEnsureRepo(accountId, inFlow) {
    if (!inFlow && !vodiFlowStart('github-repo')) return;
    const msg = document.getElementById('vodi-gh-msg');
    if (msg) { msg.textContent = 'در حال بررسی ریپازیتوری…'; msg.className = 'vodi-inline-msg'; }
    try {
        const r = await vodiFetch('/api/vodi/github/ensure-repo', {
            method: 'POST', body: JSON.stringify({ accountId: accountId || '' }),
        });
        await vodiGithubStatus();
        vodiRenderWizard();
        const m2 = document.getElementById('vodi-gh-msg');
        if (m2) {
            m2.className = 'vodi-inline-msg ok';
            m2.textContent = r.hadRepo
                ? `✅ این حساب از قبل ریپازیتوری دارد (${r.repo}) — شرط وریفای Railway برقرار است.`
                : `✅ ریپازیتوری «${r.repo}» ساخته شد — حالا می‌توانید حساب Railway را وریفای کنید.`;
        }
    } catch (e) {
        const m2 = document.getElementById('vodi-gh-msg');
        if (m2) { m2.className = 'vodi-inline-msg err'; m2.textContent = '❌ ' + e.message; }
    } finally {
        if (!inFlow) vodiFlowEnd('github-repo');
    }
}

async function vodiGithubDisconnect(accountId) {
    const ok = await uiConfirm({
        title: 'حذف حساب گیت‌هاب',
        message: 'این حساب گیت‌هاب از برنامه حذف شود؟ (ریپازیتوری‌ها دست‌نخورده می‌مانند)',
        confirmLabel: 'حذف', cancelLabel: 'انصراف', danger: true,
    });
    if (!ok) return;
    try {
        await vodiFetch('/api/vodi/github/disconnect', {
            method: 'POST', body: JSON.stringify({ accountId: accountId || '' }),
        });
        await vodiGithubStatus();
        vodiRenderWizard();
    } catch (e) { vodiToast('خطا: ' + e.message); }
}

/** Kick off "Login with Railway" and poll until the browser round-trip completes. */
async function vodiOauthLogin() {
    if (!vodiFlowStart('oauth')) return;
    const cidEl = document.getElementById('vodi-oauth-client');
    const clientId = cidEl ? (cidEl.value || '').trim() : '';
    const msg = document.getElementById('vodi-verify-msg');
    // Baseline: adding a SECOND account must not be considered "done" just because a first
    // one is already connected.
    const before = ((vodiState.oauth || {}).accounts || []).length;
    try {
        await vodiFetch('/api/vodi/oauth/start', {
            method: 'POST', body: JSON.stringify({ clientId }),
        });
        vodiToast('مرورگر باز شد — ورود را همان‌جا کامل کنید');
        if (msg) { msg.textContent = 'در انتظار تکمیل ورود در مرورگر…'; msg.className = 'vodi-inline-msg'; }

        // The callback is handled by a loopback server in the backend, so the panel just
        // watches for the status to flip rather than holding a request open.
        for (let i = 0; i < 100; i++) {          // ~5 minutes
            await new Promise(r => setTimeout(r, 3000));
            let st;
            try { st = await vodiFetch('/api/vodi/oauth/status'); } catch (e) { continue; }
            if (st.connected && (st.accounts || []).length > before) {
                await vodiLoadAccounts();
                // Select the account that was just added, not whichever was there first.
                const added = (st.accounts || []).slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))[0];
                vodiState.wizard.accountId = added ? 'oauth:' + added.id : '';
                vodiRenderWizard();
                vodiToast('اتصال به Railway برقرار شد ✅');
                return;
            }
        }
        if (msg) { msg.textContent = 'ورود تکمیل نشد — دوباره تلاش کنید.'; msg.className = 'vodi-inline-msg err'; }
    } catch (e) {
        if (msg) { msg.textContent = '❌ ' + e.message; msg.className = 'vodi-inline-msg err'; }
        else vodiToast('خطا: ' + e.message);
    } finally {
        vodiFlowEnd('oauth');
    }
}

async function vodiOauthDisconnect(accountId) {
    const ok = await uiConfirm({
        title: 'خروج از حساب Railway',
        message: 'اتصال این حساب Railway قطع شود؟ سرورهای ساخته‌شده حذف نمی‌شوند، ولی برای مدیریتشان باید دوباره وارد شوید.',
        confirmLabel: 'خروج', cancelLabel: 'انصراف', danger: true,
    });
    if (!ok) return;
    try {
        await vodiFetch('/api/vodi/oauth/disconnect', {
            method: 'POST', body: JSON.stringify({ accountId: accountId || '' }),
        });
        await vodiLoadAccounts();
        if (vodiState.wizard && String(vodiState.wizard.accountId).startsWith('oauth')) {
            vodiState.wizard.accountId = '';
        }
        vodiRenderWizard();
        vodiToast('از حساب Railway خارج شدید');
    } catch (e) { vodiToast('خطا: ' + e.message); }
}

async function vodiVerifyAccount() {
    const sel = document.getElementById('vodi-acc-select');
    const accountId = sel ? sel.value : vodiState.wizard.accountId;
    const msg = document.getElementById('vodi-verify-msg');
    if (!accountId) { if (msg) msg.textContent = 'حسابی انتخاب نشده.'; return; }
    vodiState.wizard.accountId = accountId;
    if (msg) { msg.textContent = 'در حال بررسی…'; msg.className = 'vodi-inline-msg'; }
    try {
        const r = await vodiFetch('/api/vodi/railway/verify', {
            method: 'POST', body: JSON.stringify({ accountId }),
        });
        if (msg) { msg.textContent = `✅ معتبر: ${r.account.name || r.account.email || 'حساب Railway'}`; msg.className = 'vodi-inline-msg ok'; }
    } catch (e) {
        if (msg) { msg.textContent = '❌ ' + e.message; msg.className = 'vodi-inline-msg err'; }
    }
}

/**
 * Close the wizard while a deploy is still running. The gateway is persisted server-side
 * before the health wait even starts, so abandoning the wait loses nothing — it just stops
 * this window from holding the user hostage for five minutes with no way out.
 */
function vodiCancelDeploy() {
    if (vodiState.deployAbort) { try { vodiState.deployAbort.abort(); } catch (e) {} }
    vodiState.deployAbort = null;
    vodiState.deployRun = (vodiState.deployRun || 0) + 1;   // invalidate the in-flight response
    vodiStopLogTap();
    vodiCloseWizard();
    vodiToast('پنجره بسته شد — دیپلوی در پس‌زمینه ادامه دارد');
}

async function vodiDoDeploy() {
    const w = vodiState.wizard;
    const logEl = document.getElementById('vodi-deploy-log');
    const appendLog = (line) => {
        const el = document.getElementById('vodi-deploy-log');
        if (!el) return;
        const d = document.createElement('div');
        d.textContent = line;
        el.appendChild(d);
        el.scrollTop = el.scrollHeight;
    };
    vodiStartLogTap(appendLog);
    appendLog('شروع دیپلوی…');

    // A response that lands after the user walked away must not yank the panel back.
    const run = (vodiState.deployRun = (vodiState.deployRun || 0) + 1);
    const ctrl = new AbortController();
    vodiState.deployAbort = ctrl;

    try {
        const r = await vodiFetch('/api/vodi/deploy', {
            method: 'POST',
            signal: ctrl.signal,
            body: JSON.stringify({
                accountId: w.accountId, name: w.name, region: w.region,
                adminUsername: w.username, adminPassword: w.password,
            }),
        });
        if (run !== vodiState.deployRun || !vodiState.wizard) return;   // cancelled meanwhile
        w.deployedGateway = r.gateway;
        w.alive = r.alive;
        // Pull the gateway list straight away, so the new server is already in state no
        // matter how the user leaves the wizard (close button, sidebar switch, anything).
        try {
            const gws = await vodiFetch('/api/vodi/gateways');
            vodiState.gateways = gws.gateways || vodiState.gateways;
        } catch (e) { /* the close handler refreshes too */ }
        appendLog('پایان دیپلوی.');
        const next = document.getElementById('vodi-deploy-next');
        if (next) next.style.display = '';
        setTimeout(() => {
            if (run === vodiState.deployRun && vodiState.wizard && vodiState.wizard.step === 5) vodiWizardNext(6);
        }, 1200);
    } catch (e) {
        if (e && e.name === 'AbortError') return;                    // user closed the window
        if (run !== vodiState.deployRun) return;
        appendLog('❌ خطا: ' + e.message);
    } finally {
        if (run === vodiState.deployRun) { vodiStopLogTap(); vodiState.deployAbort = null; }
    }
}

// Tap the app's /ws stream for [VodiWalker] core_log lines during deploy.
function vodiStartLogTap(onLine) {
    try {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(`${proto}://${location.host}/ws`);
        ws.onmessage = (e) => {
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'core_log' && typeof msg.data === 'string' && msg.data.includes('[VodiWalker]')) {
                    onLine(msg.data.replace(/.*\[VodiWalker\]\s?/, '').trim());
                }
            } catch (err) {}
        };
        vodiState.logWs = ws;
    } catch (e) {}
}

function vodiStopLogTap() {
    if (vodiState.logWs) { try { vodiState.logWs.close(); } catch (e) {} vodiState.logWs = null; }
}

// ── gateway lifecycle ────────────────────────────────────────────────────────────

async function vodiDeleteGateway(id, name) {
    const ok = await uiConfirm({
        title: 'حذف سرور',
        message: `سرور «${name}» و سرویسش روی Railway حذف شود؟ این عمل برگشت‌ناپذیر است.`,
        confirmLabel: 'حذف سرور', cancelLabel: 'انصراف', danger: true,
    });
    if (!ok) return;
    try {
        await vodiFetch('/api/vodi/gateways/' + id, { method: 'DELETE' });
        vodiToast('سرور حذف شد');
        if (vodiState.activeGatewayId === id) {
            vodiState.activeGatewayId = null;
            vodiState.users = [];
            // The users section belonged to the server that just went away.
            if (vodiSec === 'users') vodiGoSec('servers');
        }
        await vodiRefresh();
    } catch (e) { vodiToast('حذف ناموفق: ' + e.message); }
}

async function vodiGetAdminConfig(id) {
    try {
        vodiToast('در حال دریافت کانفیگ مدیر…');
        const r = await vodiFetch('/api/vodi/gateways/' + id + '/admin-config');
        // The node list has its own section now, and the «کانفیگ فعال» card on the home
        // page shows the newest one — so nothing needs to move the user anywhere.
        vodiState.activeGatewayId = id;
        vodiAddNodes([vodiLinkUri(r.config)], 'مدیر', id);
    } catch (e) { vodiToast('خطا: ' + e.message); }
}

// ── user management view ─────────────────────────────────────────────────────────

async function vodiOpenManage(id) {
    vodiState.activeGatewayId = id;
    vodiState.wizard = null;
    vodiRenderWizard();
    vodiGoSec('users');
}

/**
 * The user-manager view.
 *
 * REBUILDING THIS IS DESTRUCTIVE, so it happens as rarely as possible. The whole view is
 * one innerHTML assignment, and the background tick calls vodiRender() every few seconds —
 * so rebuilding unconditionally threw the already-loaded list back to its «در حال
 * بارگذاری…» placeholder every tick, which is what made the list flicker forever.
 *
 * Now the chrome is built only when it is missing or the server changed; after that the
 * list repaints itself from state, which is cheap and never blanks.
 */
function vodiRenderManage() {
    const body = document.getElementById('vodi-sec-users');
    const gw = vodiActiveGw();
    if (!body) return;
    if (!gw) { body.innerHTML = '<div class="vodi-empty">اول یک سرور بسازید.</div>'; body.dataset.gw = ''; return; }
    // The form is the one thing here the user types into, so a re-render must not wipe it.
    if (document.getElementById('vodi-user-form') && document.getElementById('vodi-user-form').children.length) return;

    if (body.dataset.gw === gw.id && document.getElementById('vodi-user-list')) {
        vodiRenderUsers();
        return;
    }
    body.dataset.gw = gw.id;
    body.innerHTML = `
      <div class="vodi-manage-head">
        <div class="vodi-manage-name">${vodiEsc(gw.name)} <span class="vodi-manage-dom">${vodiEsc(gw.domain)}</span></div>
        <div class="vodi-manage-telemetry" id="vodi-telemetry"></div>
      </div>
      <div class="vodi-actions">
        <button class="vodi-btn-primary" onclick="vodiOpenUserForm()">+ ساخت کاربر جدید</button>
        <button class="vodi-btn-ghost" onclick="vodiGetAdminConfig('${gw.id}')">کانفیگ مدیر</button>
        <button class="vodi-btn-ghost" onclick="vodiRefreshUsers()">↻ بروزرسانی</button>
      </div>
      <div id="vodi-user-form"></div>
      <div id="vodi-user-list" class="vodi-user-list"></div>
    `;
    vodiRenderUsers();
}

function vodiBackToList() {
    vodiGoSec('servers');
}

/** The ↻ button: an explicit reload, so it may say so. */
async function vodiRefreshUsers() {
    vodiState.usersBusy = true;
    vodiRenderUsers();
    await vodiLoadUsers();
    vodiToast('لیست کاربران بروزرسانی شد');
}

/**
 * Fetch the user list.
 *
 * `usersFor` records WHICH server the cached list belongs to. Without it the list of one
 * server would be shown under another for the moment before the fetch lands, and an empty
 * cache would read as «هنوز کاربری ساخته نشده» before anything had been asked.
 */
async function vodiLoadUsers() {
    const id = vodiState.activeGatewayId;
    if (!id) return;
    try {
        const r = await vodiFetch('/api/vodi/gateways/' + id + '/users');
        // The panel may have been left, or another server picked, while this was in flight.
        if (vodiState.activeGatewayId !== id) return;
        vodiState.users = r.users || [];
        vodiState.usersFor = id;
        vodiState.usersError = '';
    } catch (e) {
        if (vodiState.activeGatewayId !== id) return;
        vodiState.usersError = e.message;
        vodiState.usersFor = id;
    } finally {
        vodiState.usersBusy = false;
    }
    vodiRenderUsers();
    if (vodiSec === 'connect') vodiRenderCards();
}

function vodiRenderUsers() {
    const listEl = document.getElementById('vodi-user-list');
    if (!listEl) return;
    const id = vodiState.activeGatewayId;
    // Nothing has come back for THIS server yet — that is "loading", not "no users".
    if (vodiState.usersBusy || vodiState.usersFor !== id) {
        listEl.innerHTML = `<div class="vodi-empty">${vodiState.usersBusy ? 'در حال بروزرسانی…' : 'در حال بارگذاری…'}</div>`;
        return;
    }
    if (vodiState.usersError) {
        listEl.innerHTML = `<div class="vodi-empty err">خطا در دریافت کاربران: ${vodiEsc(vodiState.usersError)}</div>`;
        return;
    }
    const users = vodiState.users;
    if (!users.length) { listEl.innerHTML = '<div class="vodi-empty">هنوز کاربری ساخته نشده.</div>'; return; }
    listEl.innerHTML = users.map(u => {
        const limit = u.limit_bytes > 0 ? vodiFmtBytes(u.limit_bytes) : '∞';
        const used = vodiFmtBytes(u.used_bytes || 0);
        const status = u.expired ? '🔴 منقضی' : (u.active ? '🟢 فعال' : '⚪ غیرفعال');
        return `
        <div class="vodi-user">
          <div class="vodi-user-top">
            <div class="vodi-user-name">${vodiEsc(u.label)}${u.is_default ? ' <span class="vodi-tag">مدیر</span>' : ''}</div>
            <div class="vodi-user-status">${status}</div>
          </div>
          <div class="vodi-user-meta">
            مصرف: ${used} / ${limit} · پروتکل: ${vodiEsc(u.protocol)} · آی‌پی متصل: ${u.connected_ips || 0}${u.ip_limit ? '/' + u.ip_limit : ''}
          </div>
          <div class="vodi-user-actions">
            <button class="vodi-btn-xs vodi-btn-blue" onclick="vodiUserConfig('${u.uuid}')">دریافت کانفیگ</button>
            ${vodiSubUrl(u) ? `<button class="vodi-btn-xs" onclick="vodiUserSub('${u.uuid}')">کپی لینک ساب</button>` : ''}
            <button class="vodi-btn-xs" onclick="vodiUserToggle('${u.uuid}', ${u.active ? 'false' : 'true'})">${u.active ? 'غیرفعال' : 'فعال'}</button>
            <button class="vodi-btn-xs" onclick="vodiOpenUserForm('${u.uuid}')">ویرایش</button>
            <button class="vodi-btn-xs" onclick="vodiUserReset('${u.uuid}')">ریست مصرف</button>
            <button class="vodi-btn-xs" onclick="vodiUserRegenerate('${u.uuid}','${vodiEsc(u.label)}')">لینک جدید</button>
            ${u.is_default ? '' : `<button class="vodi-btn-xs vodi-btn-danger" onclick="vodiUserDelete('${u.uuid}','${vodiEsc(u.label)}')">حذف</button>`}
          </div>
        </div>`;
    }).join('');
}

/** The subscription URL of a row, under either panel generation's field name. */
function vodiSubUrl(row) {
    if (!row) return '';
    return row.sub_url || row.sub || '';
}

async function vodiUserSub(uid) {
    const u = vodiState.users.find(x => x.uuid === uid);
    const url = vodiSubUrl(u);
    if (!url) { vodiToast('این کاربر لینک ساب ندارد'); return; }
    try { await navigator.clipboard.writeText(url); vodiToast('لینک ساب کپی شد'); }
    catch (e) { vodiToast('کپی نشد'); }
}

/**
 * Mint a fresh uuid for one config.
 *
 * This is what to do when a link has been shared around: the limits, the label and the
 * protocol stay, but the OLD link stops working the moment the server answers — so it is
 * confirmed first, and the saved node cards are not silently left pointing at a dead uuid.
 */
async function vodiUserRegenerate(uid, label) {
    const ok = await uiConfirm({
        title: 'ساخت لینک جدید',
        message: `برای «${label}» یک لینک تازه ساخته شود؟ لینک قبلی همان لحظه از کار می‌افتد و هر کسی که آن را دارد قطع می‌شود.`,
        confirmLabel: 'بساز', cancelLabel: 'انصراف', danger: true,
    });
    if (!ok) return;
    try {
        const r = await vodiFetch(`/api/vodi/gateways/${vodiState.activeGatewayId}/users/${uid}/regenerate`,
            { method: 'POST', body: JSON.stringify({}) });
        vodiToast('لینک جدید ساخته شد');
        const fresh = vodiLinkUri(r.user);
        if (fresh) vodiAddNodes([fresh], label || 'کاربر', vodiState.activeGatewayId);
        await vodiLoadUsers();
    } catch (e) { vodiToast('خطا: ' + e.message); }
}

/**
 * The server's own CPU/RAM/uptime.
 *
 * Failure is silent on purpose: this is a nicety beside the user list, and a panel build
 * that does not expose /api/telemetry must not make the page look broken.
 */
async function vodiLoadTelemetry() {
    const id = vodiState.activeGatewayId;
    if (!id) return;
    try {
        const r = await vodiFetch('/api/vodi/gateways/' + id + '/telemetry');
        if (vodiState.activeGatewayId !== id) return;
        vodiState.telemetry = r.telemetry || null;
    } catch (e) { vodiState.telemetry = null; }
    vodiRenderTelemetry();
}

function vodiRenderTelemetry() {
    const el = document.getElementById('vodi-telemetry');
    if (!el) return;
    const t = vodiState.telemetry;
    if (!t || !t.ok) { el.innerHTML = ''; return; }
    const pct = (n) => (typeof n === 'number' ? vodiFa(Math.round(n)) + '٪' : '—');
    const ram = t.ram && typeof t.ram.percent === 'number' ? pct(t.ram.percent) : '—';
    el.innerHTML = [
        `پردازنده: <b>${pct(t.cpu)}</b>`,
        `حافظه: <b>${ram}</b>`,
        `اتصال‌های زنده: <b>${vodiFa(t.connections || 0)}</b>`,
        t.uptime ? `روشن بوده: <b>${vodiEsc(String(t.uptime))}</b>` : '',
    ].filter(Boolean).join('<span aria-hidden="true">·</span>');
}

/** Node cards for the active gateway, rendered inside this panel. */
// ── measuring the saved configs ──────────────────────────────────────────────────
//
// WHY THIS IS HERE AT ALL: a user with several Railway accounts in several regions ends up
// with several configs and no way to tell them apart. «کدام واقعاً وصل می‌شود» and «کدام
// تندتر است» are two DIFFERENT questions and they need two different measurements:
//
//   تأخیر (delay) — a real request THROUGH the core. A number means the config genuinely
//        carries traffic, not merely that its port answers. This is the "does it work" test.
//   سرعت (speed)  — real throughput through the core, KB/s. Only worth running on configs
//        that already answered, which is why it is a separate button and not a second column
//        filled in automatically.
//
// Both run through /api/v2ray/test-nodes — the same tester the V2Ray list uses, which stands
// up its own cores on its own ports and never touches the live connection.

const vodiNodeTest = {
    busy: false,
    type: '',            // 'delay' | 'speed'
    done: 0, total: 0,
    err: '',
    abort: null,
    allServers: false,   // compare across every server, not just the open one
};

/** The configs the test operates on: this server's, or everyone's when comparing regions. */
function vodiTestNodes() {
    const gw = vodiActiveGw();
    const gwId = gw && gw.id;
    const all = vodiGetNodes();
    if (vodiNodeTest.allServers || !gwId) return all;
    return all.filter(n => !n.gatewayId || n.gatewayId === gwId);
}

/** The server a saved config came from, for the label when several are on screen at once. */
function vodiNodeServer(n) {
    if (!n || !n.gatewayId) return null;
    return (vodiState.gateways || []).find(g => g.id === n.gatewayId) || null;
}

function vodiRenderNodeTest() {
    const host = document.getElementById('vodi-node-test');
    if (!host) return;
    const nodes = vodiTestNodes();
    if (!nodes.length) { host.innerHTML = ''; return; }
    // Offer the cross-server comparison when the SAVED CONFIGS span more than one server —
    // not when `gateways` does. The two are different: the list of servers is a live call
    // that may not have answered yet (or at all, offline), while the configs are on disk.
    // Keying it off `gateways.length` hid the checkbox in exactly the case it is for.
    const multi = new Set(vodiGetNodes().map((n) => n.gatewayId || '')).size > 1
        || (vodiState.gateways || []).length > 1;
    // While a sweep is running only the counter moves, so only the counter is rewritten.
    // Re-rendering the bar would replace the «لغو» button mid-test.
    const stamp = [vodiNodeTest.busy ? 1 : 0, multi ? 1 : 0].join('|');
    if (host.dataset.stamp === stamp) {
        const st = host.querySelector('.vodi-test-status');
        if (st) st.textContent = vodiTestStatus(nodes.length);
        return;
    }
    host.dataset.stamp = stamp;
    host.innerHTML = `
      <div class="vodi-test-bar">
        <div class="vodi-test-btns">
          <button class="vodi-btn-sm vodi-btn-blue" id="vodi-test-delay" ${vodiNodeTest.busy ? 'disabled' : ''}>تست تأخیر</button>
          <button class="vodi-btn-sm" id="vodi-test-speed" ${vodiNodeTest.busy ? 'disabled' : ''}>تست سرعت</button>
          ${vodiNodeTest.busy ? `<button class="vodi-btn-sm vodi-btn-danger" id="vodi-test-cancel">لغو</button>` : ''}
        </div>
        ${multi ? `
          <label class="vodi-test-scope">
            <input type="checkbox" id="vodi-test-all" ${vodiNodeTest.allServers ? 'checked' : ''} ${vodiNodeTest.busy ? 'disabled' : ''}>
            <span>مقایسهٔ همهٔ سرورها</span>
          </label>` : ''}
        <div class="vodi-test-status">${vodiEsc(vodiTestStatus(nodes.length))}</div>
      </div>
      <div class="vodi-test-hint">تأخیر یک درخواست واقعی از داخل هستهٔ خود برنامه است — عدد گرفتن یعنی کانفیگ واقعاً ترافیک را می‌برد، نه فقط اینکه پورتش جواب می‌دهد. سرعت را بعد از آن بزنید، روی همان‌هایی که جواب داده‌اند. از هر ردیف همان کانفیگی سنجیده می‌شود که دکمهٔ اتصال می‌زند.</div>`;
    const d = document.getElementById('vodi-test-delay');
    if (d) d.onclick = () => vodiRunNodeTest('delay');
    const s = document.getElementById('vodi-test-speed');
    if (s) s.onclick = () => vodiRunNodeTest('speed');
    const c = document.getElementById('vodi-test-cancel');
    if (c) c.onclick = () => { try { vodiNodeTest.abort && vodiNodeTest.abort.abort(); } catch (e) {} };
    const a = document.getElementById('vodi-test-all');
    if (a) a.onchange = () => { vodiNodeTest.allServers = a.checked; vodiRenderNodes(); vodiRenderNodeTest(); };
}

function vodiTestStatus(count) {
    if (vodiNodeTest.err) return '❌ ' + vodiNodeTest.err;
    if (vodiNodeTest.busy) {
        const what = vodiNodeTest.type === 'speed' ? 'سنجش سرعت' : 'سنجش تأخیر';
        return `${what}: ${vodiFa(vodiNodeTest.done)} از ${vodiFa(vodiNodeTest.total)}`;
    }
    return `${vodiFa(count)} کانفیگ ذخیره شده`;
}

/**
 * Measure every saved config.
 *
 * Results are written onto the stored node so they survive leaving the panel — re-measuring
 * a list the user already measured, just to show them a number they had, is the kind of wait
 * that makes a panel feel broken.
 */
async function vodiRunNodeTest(type) {
    if (vodiNodeTest.busy) return;
    const nodes = vodiTestNodes();
    // One measurement per saved entry, using the config it would actually dial — the same one
    // vodiActiveUri() hands the connect button.
    const targets = nodes
        .map(n => ({ id: n.id, uri: (n.configs || [])[0] }))
        .filter(t => typeof t.uri === 'string' && t.uri && !t.uri.startsWith('{'));
    if (!targets.length) { vodiToast('کانفیگ قابل سنجشی نبود'); return; }

    vodiNodeTest.busy = true; vodiNodeTest.type = type; vodiNodeTest.err = '';
    vodiNodeTest.done = 0; vodiNodeTest.total = targets.length;
    vodiNodeTest.abort = new AbortController();
    // Clear only the column being measured, so a delay run does not wipe speeds the user
    // just took (and the other way round).
    const key = type === 'speed' ? 'speed' : 'delay';
    const list = vodiGetNodes();
    list.forEach(n => { if (targets.some(t => t.id === n.id)) delete n[key]; });
    vodiSaveNodes(list);
    vodiRenderNodeTest(); vodiRenderNodes();

    try {
        const res = await fetch('/api/v2ray/test-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodes: targets, testType: type, settings: {} }),
            signal: vodiNodeTest.abort.signal,
        });
        // A non-OK answer is an error, not a progress line — feeding a 500 body to the same
        // JSON.parse as the results is what made the V2Ray list wait for a count that never
        // came and then call a list of failures a success.
        if (!res.ok) {
            let msg = `خطای سرور (${res.status})`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
            throw new Error(msg);
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let p;
                try { p = JSON.parse(line); } catch (e) { continue; }
                if (p.fatal) { vodiNodeTest.err = p.error || 'تست انجام نشد'; continue; }
                if (p.done) continue;
                vodiApplyTestResult(key, p);
                vodiNodeTest.done++;
                // Each number lands on its row as it arrives, not all of them at the end.
                // The list is at most 50 rows and the bar is rebuild-guarded above, so the
                // «لغو» button survives the redraw.
                vodiRenderNodes();
            }
        }
    } catch (e) {
        if (e.name !== 'AbortError') vodiNodeTest.err = e.message;
    } finally {
        vodiNodeTest.busy = false;
        vodiNodeTest.abort = null;
        vodiRenderNodeTest();
        vodiRenderNodes();
    }

    if (vodiNodeTest.err) { vodiToast('❌ ' + vodiNodeTest.err); return; }
    const ok = vodiTestNodes().filter(n => (n[key] || 0) > 0).length;
    vodiToast(`✅ ${vodiFa(ok)} از ${vodiFa(targets.length)} کانفیگ جواب داد`);
}

/** One streamed result onto the stored node. `reason` is kept: «چرا» is half the answer. */
function vodiApplyTestResult(key, r) {
    const list = vodiGetNodes();
    const n = list.find(x => x.id === r.id);
    if (!n) return;
    n[key] = Number(r.val);
    n[key + 'Note'] = r.val > 0 ? '' : (r.reason || '');
    n[key + 'At'] = Date.now();
    vodiSaveNodes(list);
}

/** The delay/speed cell. A measured failure and a never-measured row must not look alike. */
function vodiFigure(val, note, unit) {
    if (val > 0) {
        const shown = unit === 'kbps' ? vodiFa(val) + ' KB/s' : vodiFa(val) + 'ms';
        return `<span class="vodi-fig ok">${shown}</span>`;
    }
    // -1 WITH a reason is a measurement that failed. -1 without one is not a measurement at
    // all — every importer seeds new configs that way, and drawing those as failures paints a
    // freshly saved list red before anything has been tested.
    if (val === -1 && note) {
        return `<span class="vodi-fig bad" title="${vodiEsc(note)}">ناموفق</span>`;
    }
    return '<span class="vodi-fig none">—</span>';
}

/**
 * The one-line summary under a config's name in the connect picker.
 *
 * The point of putting the measurement HERE is that this is where the choice is made. A
 * number on the «کانفیگ‌های دریافتی» page and a blind picker on the connect page would be
 * two screens for one decision. Never measured → the count and the date, as before.
 */
function vodiPickMeta(n) {
    const bits = [vodiFa((n.configs || []).length) + ' کانفیگ'];
    if (n.delay > 0) bits.push(vodiFa(n.delay) + 'ms');
    else if (n.delay === -1 && n.delayNote) bits.push('بی‌جواب');
    if (n.speed > 0) bits.push(vodiFa(n.speed) + ' KB/s');
    if (bits.length === 1) bits.push(vodiEsc(n.date));
    return bits.join(' · ');
}

function vodiRenderNodes() {
    const el = document.getElementById('vodi-node-list');
    if (!el) return;
    const nodes = vodiTestNodes();
    if (!nodes.length) {
        el.innerHTML = '<div class="vodi-empty">هنوز نودی دریافت نشده. از «کانفیگ مدیر» یا «دریافت کانفیگ» یک کاربر استفاده کن.</div>';
        vodiRenderNodeTest();
        return;
    }
    // «بهترین» is only meaningful against other MEASURED configs, and only when there is
    // something to compare — one config is not a winner.
    const measured = (k) => nodes.filter(n => (n[k] || 0) > 0);
    const bestDelay = measured('delay').length > 1
        ? measured('delay').reduce((a, b) => (b.delay < a.delay ? b : a)).id : null;
    const bestSpeed = measured('speed').length > 1
        ? measured('speed').reduce((a, b) => (b.speed > a.speed ? b : a)).id : null;
    const showServer = vodiNodeTest.allServers && (vodiState.gateways || []).length > 1;

    const active = vodiActiveNode();
    const gwIds = (vodiState.gateways || []).map((g) => g.id);

    el.innerHTML = nodes.map(n => {
        const srv = showServer ? vodiNodeServer(n) : null;
        const sel = !!active && active.id === n.id;
        // A config tagged with a server that is no longer in the list. Its uri is still
        // valid to copy or hand to the V2Ray window, but THIS panel dials per server, so it
        // cannot be the one the button takes.
        //
        // Only said once the list has actually ANSWERED: while the call is in flight — or
        // offline, where it never answers — the list is empty, and reading "deleted" off
        // that would label every saved config on this page as orphaned at every startup.
        const gone = vodiState.gatewaysLoaded && !!n.gatewayId && !gwIds.includes(n.gatewayId);
        const badge = n.id === bestSpeed ? '<span class="vodi-tag is-best">تندترین</span>'
            : n.id === bestDelay ? '<span class="vodi-tag is-best">کم‌تأخیرترین</span>' : '';
        return `
      <div class="vodi-node${sel ? ' is-sel' : ''}">
        <div class="vodi-node-top">
          <div class="vodi-node-count">${n.configs.length}</div>
          <div class="vodi-node-info">
            <div class="vodi-node-name" title="${vodiEsc(n.name)}">${vodiEsc(n.name)}${badge}${sel ? '<span class="vodi-tag">مسیر اتصال</span>' : ''}</div>
            <div class="vodi-node-date">${srv ? vodiEsc(srv.name) + ' · ' : ''}تاریخ دریافت: ${vodiEsc(n.date)}</div>
          </div>
        </div>
        <div class="vodi-node-figs">
          <span>تأخیر: ${vodiFigure(n.delay, n.delayNote, 'ms')}</span>
          <span>سرعت: ${vodiFigure(n.speed, n.speedNote, 'kbps')}</span>
        </div>
        <div class="vodi-node-actions">
          ${sel
            ? '<button class="vodi-btn-xs" disabled title="دکمهٔ اتصال همین را می‌زند">انتخاب‌شده</button>'
            : gone
              ? `<button class="vodi-btn-xs" disabled title="سروری که این کانفیگ از آن گرفته شده دیگر در فهرست نیست">سرورش حذف شده</button>`
              : `<button class="vodi-btn-xs vodi-btn-green" onclick="vodiNodeUse('${n.id}')">اتصال با این</button>`}
          <button class="vodi-btn-xs vodi-btn-blue" onclick="vodiNodeToV2ray('${n.id}')">به V2Ray</button>
          <button class="vodi-btn-xs" onclick="vodiNodeCopy('${n.id}')">کپی</button>
          <button class="vodi-btn-xs vodi-btn-danger" onclick="vodiNodeDelete('${n.id}')">حذف</button>
        </div>
      </div>`;
    }).join('');
    vodiRenderNodeTest();
}

/**
 * «اتصال با این» — take the row the user just measured as the one the button dials.
 *
 * This is the whole reason the measurement is worth taking. It lives here, next to the
 * numbers, because that is where the comparison is read: sending the user back to the
 * connect screen to find the row again would be a second decision about the same thing.
 * A config from a server that is no longer in the list cannot be dialled, so those rows
 * say so instead of offering a button that quietly does nothing.
 */
async function vodiNodeUse(id) {
    const n = vodiGetNodes().find((x) => x.id === id);
    if (!n) return;
    const patch = { node: id };
    if (n.gatewayId) {
        const gw = (vodiState.gateways || []).find((g) => g.id === n.gatewayId);
        if (!gw) {
            vodiToast(vodiState.gatewaysLoaded
                ? 'سرور این کانفیگ دیگر در فهرست نیست'
                : 'فهرست سرورها هنوز خوانده نشده — چند لحظه بعد دوباره بزنید');
            return;
        }
        patch.gw = n.gatewayId;
    }
    // Only follow the user to the connect screen if the switch actually happened — a
    // declined confirm must leave them where they were, looking at the same numbers.
    if (await vodiPickTarget(patch)) vodiGoSec('connect');
}

// The create/edit form (shared). uid empty = create.
function vodiOpenUserForm(uid = '') {
    const wrap = document.getElementById('vodi-user-form');
    if (!wrap) return;
    const u = uid ? vodiState.users.find(x => x.uuid === uid) : null;
    // Only the protocols this deployment can actually SERVE are offered.
    //
    // The panel knows seven, but they are not equal: `vmess-ws`, `trojan-ws` and
    // `xhttp-stream-one` only mint a link (its own API reports them as `link-only` — they
    // need an external Xray core), and `vless-tcp` needs a raw TCP port, which on Railway
    // means a TCP proxy this wizard does not provision. Those three would hand the user a
    // config that parses, imports, and then never connects.
    //
    // The three below ride the same HTTPS port the panel already listens on, which is
    // exactly what a Railway service exposes.
    const protos = ['vless-ws', 'xhttp-packet-up', 'xhttp-stream-up'];
    const fps = ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge', 'random', 'randomized'];
    const cur = u || {};
    // derive limit value/unit from bytes for edit
    let limVal = '', limUnit = 'GB';
    if (cur.limit_bytes > 0) { limVal = (cur.limit_bytes / 1024 ** 3).toFixed(2).replace(/\.00$/, ''); limUnit = 'GB'; }
    let spVal = '';
    if (cur.speed_limit_bytes > 0) spVal = Math.round(cur.speed_limit_bytes * 8 / 1024 / 1024);
    wrap.innerHTML = `
      <div class="vodi-form">
        <div class="vodi-form-title">${uid ? 'ویرایش کاربر' : 'ساخت کاربر جدید'}</div>
        <div class="vodi-field"><label>برچسب (نام کاربر)</label>
          <input id="vodif-label" value="${vodiEsc(cur.label || '')}" placeholder="مثلاً کاربر ۱"></div>
        <div class="vodi-grid2">
          <div class="vodi-field"><label>پروتکل</label>
            <select id="vodif-protocol" ${uid ? 'disabled' : ''}>
              ${protos.map(p => `<option value="${p}" ${cur.protocol === p ? 'selected' : ''}>${p}</option>`).join('')}
            </select>${uid ? '<div class="vodi-hint">پروتکل بعد از ساخت قابل تغییر نیست.</div>' : ''}</div>
          <div class="vodi-field"><label>Fingerprint</label>
            <select id="vodif-fp">${fps.map(f => `<option value="${f}" ${cur.fingerprint === f ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
        </div>
        <div class="vodi-grid2">
          <div class="vodi-field"><label>پورت</label>
            <input id="vodif-port" type="number" value="${cur.port || 443}"><div class="vodi-hint">پیش‌فرض 443.</div></div>
          <div class="vodi-field"><label>ALPN</label>
            <select id="vodif-alpn">${vodiAlpnOptions(cur.alpn)}</select>
            <div class="vodi-hint">«پیش‌فرض پروتکل» = همان مقداری که سرور برای این پروتکل انتخاب می‌کند.</div></div>
        </div>
        <div class="vodi-grid2">
          <div class="vodi-field"><label>محدودیت حجم</label>
            <div class="vodi-inline">
              <input id="vodif-limit" type="number" value="${limVal}" placeholder="0 = نامحدود">
              <select id="vodif-limit-unit"><option ${limUnit==='GB'?'selected':''}>GB</option><option ${limUnit==='MB'?'selected':''}>MB</option><option ${limUnit==='KB'?'selected':''}>KB</option></select>
            </div></div>
          <div class="vodi-field"><label>محدودیت سرعت (Mbps)</label>
            <input id="vodif-speed" type="number" value="${spVal}" placeholder="0 = نامحدود"></div>
        </div>
        <div class="vodi-grid2">
          <div class="vodi-field"><label>محدودیت آی‌پی هم‌زمان</label>
            <input id="vodif-iplimit" type="number" value="${cur.ip_limit || 0}" placeholder="0 = نامحدود"></div>
          <div class="vodi-field"><label>انقضا (روز)</label>
            <input id="vodif-days" type="number" value="" placeholder="${uid ? 'خالی = بدون تغییر' : '0 = بدون انقضا'}"></div>
        </div>
        <div class="vodi-form-actions">
          <button class="vodi-btn-ghost" onclick="vodiCloseUserForm()">انصراف</button>
          <button class="vodi-btn-primary" onclick="vodiSubmitUser('${uid}')">${uid ? 'ذخیره تغییرات' : 'ساخت کاربر'}</button>
        </div>
      </div>`;
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function vodiCloseUserForm() {
    const wrap = document.getElementById('vodi-user-form');
    if (wrap) wrap.innerHTML = '';
}

function vodiFormBody() {
    const val = id => (document.getElementById(id) || {}).value;
    const body = {
        label: val('vodif-label') || 'کاربر جدید',
        fingerprint: val('vodif-fp'),
        alpn: val('vodif-alpn') || '',
        port: Number(val('vodif-port')) || 443,
        ip_limit: Number(val('vodif-iplimit')) || 0,
        limit_value: Number(val('vodif-limit')) || 0,
        limit_unit: val('vodif-limit-unit') || 'GB',
        speed_limit_value: Number(val('vodif-speed')) || 0,
        speed_limit_unit: 'MBIT',
    };
    const days = val('vodif-days');
    if (days !== '' && days != null) body.expires_days = Number(days) || 0;
    return body;
}

async function vodiSubmitUser(uid) {
    const id = vodiState.activeGatewayId;
    if (!id) return;
    const body = vodiFormBody();
    try {
        if (uid) {
            await vodiFetch(`/api/vodi/gateways/${id}/users/${uid}`, { method: 'PATCH', body: JSON.stringify(body) });
            vodiToast('تغییرات ذخیره شد');
        } else {
            body.protocol = (document.getElementById('vodif-protocol') || {}).value || 'vless-ws';
            const r = await vodiFetch(`/api/vodi/gateways/${id}/users`, { method: 'POST', body: JSON.stringify(body) });
            vodiToast('کاربر ساخته شد');
            if (r.user && vodiLinkUri(r.user)) {
                const add = await uiConfirm({
                    title: 'کاربر ساخته شد',
                    message: 'کانفیگ این کاربر به «کانفیگ‌های دریافتی» اضافه شود؟',
                    confirmLabel: 'افزودن', cancelLabel: 'نه، بعداً',
                });
                if (add) {
                    const gw = vodiState.gateways.find(g => g.id === id);
                    vodiAddNodes([vodiLinkUri(r.user)], gw ? gw.domain : '');
                }
            }
        }
        vodiCloseUserForm();
        await vodiLoadUsers();
    } catch (e) { vodiToast('خطا: ' + e.message); }
}

async function vodiUserToggle(uid, active) {
    try {
        await vodiFetch(`/api/vodi/gateways/${vodiState.activeGatewayId}/users/${uid}`,
            { method: 'PATCH', body: JSON.stringify({ active: active === true || active === 'true' }) });
        await vodiLoadUsers();
    } catch (e) { vodiToast('خطا: ' + e.message); }
}

async function vodiUserReset(uid) {
    try {
        await vodiFetch(`/api/vodi/gateways/${vodiState.activeGatewayId}/users/${uid}`,
            { method: 'PATCH', body: JSON.stringify({ reset_usage: true }) });
        vodiToast('مصرف ریست شد');
        await vodiLoadUsers();
    } catch (e) { vodiToast('خطا: ' + e.message); }
}

async function vodiUserDelete(uid, label) {
    const ok = await uiConfirm({
        title: 'حذف کاربر',
        message: `کاربر «${label}» حذف شود؟`,
        confirmLabel: 'حذف', cancelLabel: 'انصراف', danger: true,
    });
    if (!ok) return;
    try {
        await vodiFetch(`/api/vodi/gateways/${vodiState.activeGatewayId}/users/${uid}`, { method: 'DELETE' });
        vodiToast('کاربر حذف شد');
        await vodiLoadUsers();
    } catch (e) { vodiToast('خطا: ' + e.message); }
}

function vodiUserConfig(uid) {
    const u = vodiState.users.find(x => x.uuid === uid);
    if (!u) return;
    const uri = vodiLinkUri(u);
    // A row built as several configs at once has no single URI to hand over; say so rather
    // than adding an empty node card the user would then try to connect to.
    if (!uri) { vodiToast('این ردیف چند کانفیگ دارد — از لینک ساب استفاده کن'); return; }
    // Straight to a node card labelled with the username — no intermediate modal.
    vodiAddNodes([uri], u.label || 'کاربر', vodiState.activeGatewayId);
}

// ── data loads ───────────────────────────────────────────────────────────────────

async function vodiLoadAccounts() {
    // Manual tokens come from the client cache, not the backend: PersistentStorage's cache
    // is updated synchronously on setItem, while the backend reads the file which lags by
    // the debounce. The token never leaves for the UI — we only surface {id, name}.
    let manual = [];
    try {
        const raw = (typeof PersistentStorage !== 'undefined') ? PersistentStorage.getItem('railway_accounts') : null;
        const list = raw ? JSON.parse(raw) : [];
        manual = (Array.isArray(list) ? list : []).map(a => ({ id: String(a.id), name: a.name || 'Railway' }));
    } catch (e) { manual = []; }

    // The OAuth login shows up as a first-class account so the rest of the wizard is
    // identical whether the user signed in or pasted a token.
    try {
        const st = await vodiFetch('/api/vodi/oauth/status');
        vodiState.oauth = st;
        // One entry per connected Railway account, newest first.
        for (const a of (st.accounts || []).slice().reverse()) {
            manual.unshift({ id: 'oauth:' + a.id, name: `${a.name} (ورود با Railway)` });
        }
    } catch (e) { vodiState.oauth = { connected: false, hasClientId: false, accounts: [] }; }

    vodiState.accounts = manual;
}

async function vodiRefresh() {
    try {
        const [gws, regs] = await Promise.all([
            vodiFetch('/api/vodi/gateways').catch(() => ({ gateways: null })),
            vodiState.regions.length ? Promise.resolve({ regions: vodiState.regions }) : vodiFetch('/api/vodi/regions').catch(() => ({ regions: [] })),
        ]);
        // `null` is "the call did not answer", `[]` is "answered: none". Only the second is
        // evidence about the user's servers.
        if (gws.gateways) vodiState.gatewaysLoaded = true;
        vodiState.gateways = gws.gateways || [];
        vodiState.regions = regs.regions || vodiState.regions;
    } catch (e) {}
    await vodiLoadAccounts();
    if (!vodiState.wizard) vodiRender();
}

function initVodiModule() {
    const container = document.getElementById('ls-vodi');
    if (!container) return;
    if (container.parentElement) {
        container.parentElement.style.position = 'relative';
        container.parentElement.style.padding = '0';
        container.parentElement.style.overflow = 'hidden';
    }
    container.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent;';

    vodiRender();
    vodiRefreshLive().then(() => vodiRefresh());

    // The engine this page dials is the app's one Xray, which other windows also drive.
    window.addEventListener('mv-v2ray-state', () => { vodiRefreshLive().then(() => vodiRender()); });
    window.MVProbe = window.MVProbe || {};
    window.MVProbe.vodi = () => vodiConnectedHere();

    // Keep the server list honest without the user having to poke the UI. Only while the
    // panel is actually on screen and no wizard/form is mid-edit — a background re-render
    // would otherwise wipe a half-filled form.
    if (vodiState.pollTimer) clearInterval(vodiState.pollTimer);
    vodiState.pollTimer = setInterval(async () => {
        const el = document.getElementById('ls-vodi');
        if (!el || el.style.display === 'none') return;
        if (vodiState.wizard) return;
        const form = document.getElementById('vodi-user-form');
        if (form && form.children.length) return;
        await vodiRefreshLive();
        try {
            const gws = await vodiFetch('/api/vodi/gateways');
            const next = gws.gateways || [];
            if (JSON.stringify(next) !== JSON.stringify(vodiState.gateways)) vodiState.gateways = next;
        } catch (e) { /* transient */ }
        vodiRender();
        // The user list is a call to the user's OWN server, so it is refreshed only while
        // that page is the one on screen — and quietly: vodiLoadUsers() leaves the rendered
        // list alone until the new one has arrived, so nothing blinks.
        if (vodiSec === 'users' && vodiActiveGw()) {
            vodiLoadUsers();
            vodiLoadTelemetry();
        }
    }, 5000);
}

// ── styles ───────────────────────────────────────────────────────────────────────

function vodiStyles() {
    return `<style>
      #vodi-wrapper { position:relative; z-index:0; flex:1 1 auto; min-height:0;
                     font-size:12px; color:var(--mv-label); }
      #vodi-wrapper * { box-sizing:border-box; }
      .vodi-sec { display:flex; flex-direction:column; gap:10px; padding-top:6px; }
      /* Servers, users and saved configs are all lists of independent things — they use the
         width the window has rather than a single column down the middle. */
      .vodi-card-grid, .vodi-user-list { display:grid; gap:10px;
                                       grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); }
      /* The wizard covers the page: six steps, one thing at a time. It stays UNDER the
         window's own title bar (#vodi-wrapper is the stacking context), so the traffic
         lights keep working, and its head clears the 50px drag strip. */
      #vodi-wizard { position:absolute; inset:0; z-index:20; display:flex; flex-direction:column;
                    align-items:center; overflow-y:auto; padding:52px 16px 20px;
                    background:var(--mv-pane); }
      #vodi-wizard > * { width:100%; max-width:620px; }
      .vodi-actions { display:flex; gap:8px; flex-wrap:wrap; }
      /* The proxy/tunnel picker: two cards, not a switch — they are different things, and a
         switch would imply one is simply "more" of the other. */
      .vodi-mode-row { display:grid; gap:10px; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); margin:2px 0 4px; }
      .vodi-mode { display:flex; align-items:flex-start; gap:10px; text-align:right; cursor:pointer;
                   border:1px solid var(--mv-sep); border-radius:12px; padding:11px 12px;
                   background:var(--mv-fill); color:var(--mv-label); font:inherit; }
      .vodi-mode:disabled { opacity:.55; cursor:default; }
      .vodi-mode i { font-size:19px; color:var(--mv-label-2); flex:none; margin-top:1px; }
      .vodi-mode span { display:flex; flex-direction:column; gap:3px; min-width:0; }
      .vodi-mode b { font-size:12.5px; font-weight:800; }
      .vodi-mode small { font-size:10.5px; color:var(--mv-label-2); line-height:1.7; }
      .vodi-mode.is-on { border-color:color-mix(in srgb, var(--mv-accent) 55%, transparent);
                         background:color-mix(in srgb, var(--mv-accent) 10%, var(--mv-fill)); }
      .vodi-mode.is-on i { color:var(--mv-accent); }
      .vodi-manage-telemetry { display:flex; gap:12px; flex-wrap:wrap; font-size:10.5px; color:var(--mv-label-2); margin-top:4px; }
      .vodi-manage-telemetry b { font-weight:800; color:var(--mv-label); }
      /* The speed report. Only ever on screen while a tunnel is up, because it compares the
         tunnel against the engine behind it and there is no tunnel to compare in proxy mode. */
      .vodi-speed { border:1px solid var(--mv-sep); border-radius:12px; padding:11px 12px;
                    background:var(--mv-fill); display:flex; flex-direction:column; gap:8px; margin:2px 0 4px; }
      .vodi-speed.is-warn { border-color:color-mix(in srgb, var(--mv-orange, #FF9500) 45%, transparent); }
      .vodi-speed.is-ok   { border-color:color-mix(in srgb, var(--mv-green) 40%, transparent); }
      .vodi-speed-head { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .vodi-speed-head b { font-size:12.5px; font-weight:800; }
      .vodi-speed-nums { display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:var(--mv-label-2); }
      .vodi-speed-nums b { color:var(--mv-label); font-weight:800; font-family:var(--mv-font-mono); }
      .vodi-speed-note { font-size:11px; line-height:1.9; color:var(--mv-label-2); }
      .vodi-speed-note.err { color:var(--mv-red-ink); }
      .vodi-speed-fix { display:flex; flex-direction:column; gap:8px; padding-top:8px;
                        border-top:1px solid var(--mv-sep); font-size:11px; line-height:1.9; color:var(--mv-label-2); }
      .vodi-speed-fix button { align-self:flex-start; }
      /* The saved-config measurement bar and the two figures it fills in. */
      .vodi-test-bar { display:flex; align-items:center; gap:12px; flex-wrap:wrap;
                       border:1px solid var(--mv-sep); border-radius:11px; padding:9px 11px; background:var(--mv-fill); }
      .vodi-test-btns { display:flex; gap:7px; flex-wrap:wrap; }
      .vodi-test-scope { display:flex; align-items:center; gap:6px; font-size:11px; color:var(--mv-label-2); cursor:pointer; }
      .vodi-test-status { margin-inline-start:auto; font-size:11px; color:var(--mv-label-2); }
      .vodi-test-hint { font-size:10.5px; line-height:1.85; color:var(--mv-label-2); padding:7px 2px 0; }
      .vodi-node-figs { display:flex; gap:14px; flex-wrap:wrap; font-size:11px; color:var(--mv-label-2); }
      .vodi-fig { font-family:var(--mv-font-mono); font-weight:800; }
      .vodi-fig.ok { color:var(--mv-green-ink); }
      .vodi-fig.bad { color:var(--mv-red-ink); }
      .vodi-fig.none { color:var(--mv-label-2); opacity:.7; }
      .vodi-tag.is-best { background:color-mix(in srgb, var(--mv-green) 18%, transparent);
                          color:var(--mv-green-ink); margin-inline-start:6px; }
      .vodi-btn-primary { background:var(--mv-accent); color:#fff; border:none; border-radius:9px; padding:8px 14px; font-weight:800; font-size:12px; cursor:pointer; }
      .vodi-btn-ghost { background:var(--mv-fill-2); color:var(--mv-label); border:1px solid var(--mv-sep); border-radius:9px; padding:8px 14px; font-weight:700; font-size:12px; cursor:pointer; }
      .vodi-btn-sm { background:var(--mv-fill-2); color:var(--mv-label); border:1px solid var(--mv-sep); border-radius:8px; padding:6px 10px; font-weight:700; font-size:11px; cursor:pointer; }
      .vodi-btn-xs { background:var(--mv-fill); color:var(--mv-label); border:1px solid var(--mv-sep); border-radius:7px; padding:5px 9px; font-weight:700; font-size:10.5px; cursor:pointer; }
      .vodi-btn-blue { background:color-mix(in srgb, var(--mv-blue) 15%, transparent); border-color:color-mix(in srgb, var(--mv-blue) 40%, transparent); color:var(--mv-blue-ink); }
      .vodi-btn-green { background:color-mix(in srgb, var(--mv-green) 16%, transparent); border-color:color-mix(in srgb, var(--mv-green) 40%, transparent); color:var(--mv-green-ink); }
      .vodi-btn-sm:disabled, .vodi-btn-xs:disabled { opacity:.55; cursor:default; }
      .vodi-btn-danger { background:color-mix(in srgb, var(--mv-red) 12%, transparent); border-color:color-mix(in srgb, var(--mv-red) 35%, transparent); color:var(--mv-red-ink); }
      .vodi-empty { text-align:center; color:var(--mv-label-2); padding:22px 8px; line-height:1.9; font-size:12px; }
      .vodi-empty.err { color:var(--mv-red-ink); }
      .vodi-card { border:1px solid var(--mv-sep); border-radius:12px; padding:11px 12px; background:var(--mv-fill); display:flex; flex-direction:column; gap:9px; }
      .vodi-card-top { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; }
      .vodi-card-name { font-weight:800; font-size:13px; }
      .vodi-card-dom { font-size:10.5px; color:var(--mv-label-2); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:ltr; text-align:right; }
      .vodi-badge { flex:none; font-size:10px; padding:3px 8px; border-radius:20px; background:var(--mv-fill-2); color:var(--mv-label-2); }
      .vodi-card-actions { display:flex; gap:6px; flex-wrap:wrap; }
      .vodi-pass-row { display:flex; align-items:center; gap:7px; flex-wrap:wrap; }
      .vodi-pass-label { font-size:10.5px; color:var(--mv-label-2); flex:none; }
      .vodi-pass { direction:ltr; background:var(--mv-field); border:1px solid var(--mv-sep);
                  padding:3px 8px; border-radius:6px; font-size:11px; font-family:var(--mv-font-mono);
                  color:var(--mv-label); user-select:all; word-break:break-all; }
      .vodi-test-result { font-size:11px; line-height:1.9; color:var(--mv-label-2); min-height:0; white-space:pre-line; }
      .vodi-test-result.ok  { color:var(--mv-green-ink); }
      .vodi-test-result.err { color:var(--mv-red-ink); }
      .vodi-wizard, .vodi-form { border:1px solid var(--mv-sep); border-radius:12px; padding:14px; background:var(--mv-fill); display:flex; flex-direction:column; gap:11px; }
      .vodi-step-title, .vodi-form-title { font-weight:800; font-size:13px; }
      .vodi-guide { font-size:12px; line-height:1.9; color:var(--mv-label); }
      .vodi-note, .vodi-hint { font-size:10.5px; color:var(--mv-label-2); line-height:1.7; margin-top:5px; background:var(--mv-fill); padding:7px 9px; border-radius:8px; }
      .vodi-hint { background:none; padding:2px 0; }
      .vodi-warn { color:var(--mv-orange-ink); margin-top:8px; font-size:11px; }
      .vodi-field { display:flex; flex-direction:column; gap:5px; }
      .vodi-field > label { font-size:11px; color:var(--mv-label-2); font-weight:700; }
      .vodi-field input, .vodi-field select { background:var(--mv-field); border:1px solid var(--mv-sep-2); color:var(--mv-label); border-radius:8px; padding:8px 10px; font-size:12px; width:100%; }
      .vodi-grid2 { display:grid; grid-template-columns:1fr 1fr; gap:9px; }
      .vodi-inline { display:flex; gap:6px; } .vodi-inline input { flex:1; } .vodi-inline select { width:auto; }
      .vodi-oauth-box { border:1px solid color-mix(in srgb, var(--mv-blue) 35%, transparent); background:color-mix(in srgb, var(--mv-blue) 7%, transparent);
                       border-radius:11px; padding:12px; display:flex; flex-direction:column; gap:6px; }
      .vodi-oauth-title { font-weight:800; font-size:12.5px; color:var(--mv-blue-ink); }
      .vodi-oauth-ok { font-size:12px; color:var(--mv-green-ink); font-weight:700; line-height:1.8; }
      .vodi-acc-row { display:flex; align-items:center; justify-content:space-between; gap:8px;
                     background:var(--mv-field); border-radius:8px; padding:6px 9px; }
      .vodi-acc-name { font-size:11.5px; font-weight:700; color:var(--mv-label); min-width:0;
                      overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .vodi-oauth-box code { background:var(--mv-field); padding:2px 6px; border-radius:5px; font-size:10.5px; }
      .vodi-or { text-align:center; font-size:10.5px; color:var(--mv-label-2); position:relative; }
      .vodi-code { direction:ltr; text-align:center; font-family:var(--mv-font-mono); font-weight:800;
                  font-size:22px; letter-spacing:3px; color:var(--mv-label); background:var(--mv-field);
                  border:1px solid var(--mv-sep-2); border-radius:10px; padding:10px;
                  user-select:all; margin:4px 0; }
      .vodi-add-acc { border:1px dashed var(--mv-sep-2); border-radius:9px; padding:9px 11px; }
      .vodi-add-acc summary { cursor:pointer; font-size:11px; color:var(--mv-blue-ink); font-weight:700; }
      .vodi-add-acc .vodi-field { margin-top:8px; }
      .vodi-wiz-actions, .vodi-form-actions { display:flex; gap:8px; justify-content:flex-end; flex-wrap:wrap; margin-top:4px; }
      .vodi-inline-msg { font-size:11px; min-height:14px; color:var(--mv-label-2); }
      .vodi-inline-msg.ok { color:var(--mv-green-ink); } .vodi-inline-msg.err { color:var(--mv-red-ink); }
      .vodi-log { background:var(--mv-surface); border:1px solid var(--mv-sep); border-radius:9px; padding:9px; height:200px; overflow-y:auto; font-size:11px; line-height:1.7; direction:ltr; text-align:left; font-family:var(--mv-font-mono); color:var(--mv-blue-ink); }
      .vodi-dom-box { direction:ltr; text-align:center; margin-top:8px; background:color-mix(in srgb, var(--mv-blue) 12%, transparent); border:1px solid color-mix(in srgb, var(--mv-blue) 35%, transparent); border-radius:8px; padding:8px; font-weight:700; word-break:break-all; }
      .vodi-manage-head { display:flex; align-items:center; gap:10px; }
      .vodi-manage-name { font-weight:800; font-size:13px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .vodi-manage-dom { color:var(--mv-label-2); font-size:10.5px; font-weight:600; direction:ltr; }
      .vodi-user { border:1px solid var(--mv-sep); border-radius:11px; padding:10px 11px; background:var(--mv-fill); display:flex; flex-direction:column; gap:7px; }
      .vodi-user-top { display:flex; justify-content:space-between; align-items:center; gap:8px; }
      .vodi-user-name { font-weight:800; font-size:12.5px; }
      .vodi-user-status { font-size:11px; flex:none; }
      .vodi-user-meta { font-size:10.5px; color:var(--mv-label-2); line-height:1.6; }
      .vodi-user-actions { display:flex; gap:6px; flex-wrap:wrap; }
      .vodi-tag { font-size:9px; background:color-mix(in srgb, var(--mv-blue) 20%, transparent); color:var(--mv-blue-ink); padding:2px 6px; border-radius:10px; margin-right:4px; }
      .vodi-section-title { font-size:11.5px; font-weight:800; color:var(--mv-label-2); margin-top:6px;
                           padding-bottom:4px; border-bottom:1px solid var(--mv-sep); }
      .vodi-node { border:1px solid var(--mv-sep); border-radius:11px; padding:10px 11px;
                  background:var(--mv-fill); display:flex; flex-direction:column; gap:8px; }
      /* The row the connect button dials. Marked because the list is where a comparison is
         read, so «which one am I on» has to be answerable without leaving the page. */
      .vodi-node.is-sel { border-color:color-mix(in srgb, var(--mv-green) 45%, transparent);
                  background:color-mix(in srgb, var(--mv-green) 6%, var(--mv-fill)); }
      .vodi-node-top { display:flex; align-items:center; gap:10px; min-width:0; }
      .vodi-node-count { flex:none; width:36px; height:36px; border-radius:10px; background:var(--mv-field);
                        display:flex; align-items:center; justify-content:center;
                        font-weight:800; font-size:14px; font-family:var(--mv-font-mono); color:var(--mv-label); }
      .vodi-node-info { min-width:0; }
      .vodi-node-name { font-weight:800; font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .vodi-node-date { font-size:10px; color:var(--mv-label-2); margin-top:2px; }
      .vodi-node-actions { display:flex; gap:6px; flex-wrap:wrap; }
    </style>`;
}
