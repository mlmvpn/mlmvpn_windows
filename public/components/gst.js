// --- Google Script Tunnel panel (تونل گوگل اسکریپت) ---
// Renders into #ls-gst. Talks to /api/gst/* on the local server.
//
// The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one سایفون، ماسک and
// «موتور ضد فیلتر SNI» wear: a sidebar of sections, a hero built around ONE button with the
// live traffic beside it, and each decision this window really has as a card of its own.
//
//   اتصال     — the hero, the connection mode, and what the other three sections add up to
//   ریلی‌ها    — the relay list, unlimited, each with its own Cloudflare switch
//   مسیر شبکه — clean-IP and SNI selection (gst-network.js)
//   سلامت     — per-leg diagnosis and repair (gst-health.js)
//
// The three tabs became three sections: same panes, same ids, same renderers — what changed
// is that the window now looks like every other engine in this app instead of like a phone
// screen that was widened.
//
// Connection modes mirror the Aether panel exactly: the engine's local ports are always
// the base layer, and system-proxy / TUN stack on top as independent switches.

const GST_SECTIONS = [
    { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
    { id: 'relays', label: 'ریلی‌ها', icon: 'ph-fill ph-stack', tint: 'var(--mv-blue)' },
    { id: 'network', label: 'مسیر شبکه', icon: 'ph-fill ph-signpost', tint: 'var(--mv-pink, #FF2D55)' },
    { id: 'health', label: 'سلامت', icon: 'ph-fill ph-heartbeat', tint: 'var(--mv-red)' },
];

/** The setup, as a line: what is behind the user and what is next. Hidden once it is all behind. */
const GST_STEPS = [
    { key: 'relay', fa: 'ساخت ریلی' },
    { key: 'test', fa: 'تست ریلی' },
    { key: 'connect', fa: 'اتصال' },
];

/** Which section is on screen. */
let gstSec = 'connect';

const gstFa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);

const gstHtmlTemplate = `
<div id="gst-wrapper" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های تونل گوگل‌اسکریپت">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="gst-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${GST_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-gst-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="gst-store" title="موتور تونل گوگل‌اسکریپت در ام‌ال‌ام استور">
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
        <button type="button" id="gst-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="gst-pane-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="gst-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="gst-stage" style="--tint:var(--mv-blue)"></div>
        <div class="mv-eng-flow" id="gst-flow" style="display:none"><div class="mv-steps" id="gst-steps"></div></div>
        <div class="mv-eng-grid" id="gst-cards"></div>
      </div>

      <div class="mv-eng-sec" data-sec="relays">
        <div class="gst-pane">
          <div class="gst-actions">
            <button class="gst-btn-primary" onclick="gstStartWizard()">+ افزودن ریلی</button>
            <button class="gst-btn-ghost" onclick="gstTestAll()">تست همه</button>
            <button class="gst-btn-ghost" onclick="gstBackupOpen('export')" title="ذخیره یا انتقال ریلی‌ها">پشتیبان</button>
          </div>
          <div id="gst-relay-list"></div>
          <div id="gst-quota-note" class="gst-note"></div>
        </div>
      </div>

      <!-- Rendered by gst-network.js and gst-health.js — same ids the tabs had. -->
      <div class="mv-eng-sec" data-sec="network"><div class="gst-pane" id="gst-tab-network"></div></div>
      <div class="mv-eng-sec" data-sec="health"><div class="gst-pane" id="gst-tab-health"></div></div>
    </div>

    <div class="mv-eng-foot" id="gst-foot"></div>
  </section>

  <!-- Wizard overlay — covers the whole page so nothing competes for attention -->
  <div id="gst-wizard" style="display:none;"></div>
  <!-- Backup overlay, same treatment -->
  <div id="gst-backup" style="display:none;"></div>
</div>

<style>
  /* The page itself is the kit's (.mv-split + .mv-eng-*). What is left here is this
     feature's own furniture: relay cards, the health rows, the network lists and the two
     overlays — everything the wizard and the two sub-modules render into. */
  #gst-wrapper { position:relative; z-index:0; flex:1 1 auto; min-height:0;
                 font-size:12px; color:var(--mv-label); }
  .gst-pane { display:flex; flex-direction:column; gap:10px; padding-top:6px; }

  /* ── relay cards ──────────────────────────────────────────────────────────
     A grid with no breakpoint list: auto-fill decides the column count from the width the
     pane actually has, which is the whole point of the wide window. */
  #gst-relay-list { display:grid; gap:12px; grid-template-columns:repeat(auto-fill, minmax(268px, 1fr)); }
  .gst-card { border-radius:14px; padding:12px 13px; display:flex; flex-direction:column; gap:8px;
              background:var(--mv-group); box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
  .gst-card-head { display:flex; align-items:center; gap:8px; }
  .gst-drag { color:var(--mv-label-3); cursor:grab; flex:none; font-size:13px; }
  .gst-card-name { font-weight:700; font-size:13px; flex:1; min-width:0;
                   overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gst-icon-btn { background:none; border:none; color:var(--mv-label-3); cursor:pointer; font-size:12px;
                  padding:2px 4px; flex:none; }
  .gst-icon-btn:hover { color:var(--mv-red-ink); }
  /* Lamps wrap instead of overflowing when the window is dragged narrow. */
  .gst-card-lamps { display:flex; flex-wrap:wrap; gap:6px 14px; }
  .gst-card-detail { font-size:10.5px; color:var(--mv-orange-ink); line-height:1.7; }
  .gst-card-foot { display:flex; align-items:center; justify-content:space-between; gap:8px;
                   padding-top:7px; border-top:var(--mv-hl) solid var(--mv-sep); }
  .gst-cf-switch { display:inline-flex; align-items:center; gap:6px; cursor:pointer; font-size:11.5px; }
  .gst-cf-switch.gst-disabled { opacity:.45; cursor:not-allowed; }
  .gst-btn-mini { padding:5px 14px; border-radius:9999px; border:var(--mv-hl) solid var(--mv-sep-2);
                  background:transparent; color:var(--mv-label); cursor:pointer; font-size:11px; }
  .gst-btn-mini:hover { background:var(--mv-fill-2); }

  .gst-actions { display:flex; gap:8px; flex-wrap:wrap; }
  .gst-btn-primary { padding:9px 26px; border:none; border-radius:9999px; cursor:pointer;
                     background:var(--mv-accent); color:#fff; font-weight:700; font-size:12px; }
  .gst-btn-primary[disabled] { opacity:.6; cursor:default; }
  .gst-btn-ghost { padding:9px 20px; border-radius:9999px; cursor:pointer; font-size:12px;
                   background:transparent; color:var(--mv-label); border:var(--mv-hl) solid var(--mv-sep-2); }
  .gst-btn-ghost:hover { background:var(--mv-fill); }
  .gst-note { font-size:11px; color:var(--mv-label-2); line-height:1.9; }
  .gst-placeholder, .gst-empty { font-size:12px; color:var(--mv-label-2); line-height:2;
                                 text-align:center; padding:24px 10px; }

  /* ── سلامت ────────────────────────────────────────────────────────────── */
  .gst-hhead { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .gst-hsummary { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:11.5px; font-weight:700; }
  .gst-hsystem { display:grid; gap:12px; grid-template-columns:repeat(auto-fill, minmax(268px, 1fr)); }
  .gst-hrelays { display:grid; gap:12px; grid-template-columns:repeat(auto-fill, minmax(320px, 1fr)); }
  .gst-hrow { border-radius:12px; padding:11px 13px; display:flex; flex-direction:column; gap:5px;
              background:var(--mv-group); box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
  .gst-hrow-main { display:flex; align-items:center; gap:8px; }
  .gst-hrow-label { font-weight:700; font-size:12px; flex:1; min-width:0;
                    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gst-hrow-state { font-size:10.5px; color:var(--mv-label-2); flex:none; }
  .gst-hrow-detail { font-size:10.5px; color:var(--mv-label-2); line-height:1.8; }
  .gst-hrow-actions { display:flex; flex-wrap:wrap; gap:6px; }

  .gst-hblock { border-radius:14px; padding:12px 13px; display:flex; flex-direction:column; gap:8px;
                align-content:start;
                background:var(--mv-group); box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
  .gst-hblock-head { display:flex; align-items:center; gap:8px; font-size:12.5px; }
  .gst-leg-wrap { display:flex; flex-direction:column; gap:6px; }
  .gst-leg { display:flex; align-items:center; gap:8px; padding-inline-end:6px; }
  .gst-leg-name { font-size:11.5px; font-weight:600; flex:none; }
  .gst-leg-msg { font-size:10.5px; color:var(--mv-label-2); flex:1; min-width:0;
                 overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  /* The repair box is the point of the health section, so it is visually distinct from the
     status line above it rather than blending into the card. */
  .gst-fix { border-radius:11px; padding:9px 11px; display:flex; flex-direction:column; gap:6px;
             background:color-mix(in srgb, var(--mv-red) 9%, transparent); border:var(--mv-hl) solid color-mix(in srgb, var(--mv-red) 25%, transparent); }
  .gst-fix-title { font-size:11.5px; font-weight:700; color:var(--mv-red-ink); }
  .gst-fix-detail { font-size:10.5px; color:var(--mv-label-2); line-height:1.9; white-space:pre-line; }

  .gst-combo { display:flex; flex-direction:column; gap:6px; padding:9px 11px; border-radius:11px;
               background:color-mix(in srgb, var(--mv-blue) 7%, transparent); border:var(--mv-hl) solid color-mix(in srgb, var(--mv-blue) 20%, transparent); }
  .gst-combo .gst-btn-mini { align-self:flex-start; }

  .gst-quota { display:flex; align-items:center; gap:8px; font-size:10.5px; color:var(--mv-label-2); }
  .gst-quota-bar { flex:1; height:5px; border-radius:3px; overflow:hidden; background:var(--mv-fill-2); }
  .gst-quota-bar i { display:block; height:100%; border-radius:3px; }

  /* ── مسیر شبکه ─────────────────────────────────────────────────────────
     IPs and SNIs are compared against each other, so they sit side by side when the
     window has room for it. */
  #gst-tab-network { display:grid; gap:12px; align-content:start;
                     grid-template-columns:repeat(auto-fit, minmax(340px, 1fr)); }
  #gst-tab-network > .gst-hhead,
  #gst-tab-network > .gst-note,
  #gst-tab-network > .gst-netauto { grid-column:1 / -1; }
  .gst-netsec { border-radius:14px; padding:12px 13px; display:flex; flex-direction:column; gap:8px;
                align-content:start;
                background:var(--mv-group); box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
  .gst-netsec-head { display:flex; align-items:center; justify-content:space-between;
                     gap:8px; flex-wrap:wrap; font-size:12.5px; }
  .gst-netlist { display:flex; flex-direction:column; gap:2px; max-height:360px; overflow-y:auto; }
  .gst-netrow { display:flex; align-items:center; gap:8px; padding:6px 4px; cursor:pointer;
                border-radius:8px; font-size:11.5px; }
  .gst-netrow:hover { background:var(--mv-fill); }
  /* A path that failed its test stays listed but visibly demoted — hiding it would make
     a user who manually added it think the entry vanished. */
  .gst-netrow.dead { opacity:.5; }
  .gst-netval { font-family:var(--mv-font-tech, "Fira Code", Consolas, monospace); font-size:11px; flex:1; min-width:0;
                overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gst-netlat { font-size:10.5px; color:var(--mv-label-2); flex:none; min-width:56px; text-align:left; }
  .gst-bars { display:inline-flex; gap:2px; flex:none; width:38px; }
  .gst-bars i { width:5px; height:9px; border-radius:1px; background:var(--mv-fill-3); }
  .gst-bars i.on { background:var(--mv-green); }
  .gst-nethint { font-size:10px; color:var(--mv-label-3); flex:none; max-width:110px;
                 overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .gst-netadd { display:flex; gap:6px; }
  .gst-netadd .gstw-input { flex:1; padding:6px 9px; font-size:11px; }
  .gst-netauto { display:flex; align-items:flex-start; gap:9px; padding:11px 13px; cursor:pointer;
                 border-radius:14px; background:var(--mv-group);
                 box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
  .gst-netauto b { font-size:12px; display:block; }
  .gst-netauto i { font-size:10.5px; color:var(--mv-label-2); font-style:normal; line-height:1.8; }

  /* ── Wizard ────────────────────────────────────────────────────────────────
     Sits over the whole page: during setup there is exactly one thing to do, and a
     visible relay list behind it would only invite the user to wander off mid-flow.
     #gst-wrapper is the stacking context (z-index:0 above), so these stay UNDER the
     window's own title bar — covering it would take the traffic lights with it. */
  #gst-wizard, #gst-backup { position:absolute; inset:0; z-index:20; display:flex;
                             flex-direction:column; align-items:center;
                             background:var(--mv-pane, var(--ide-sidebar, #111)); }
  /* Backup sits above the wizard: it can be opened from the relay list while the wizard
     is closed, but if both ever render, the one the user just asked for must win. */
  #gst-backup { z-index:21; }
  #gst-backup textarea.gstw-input { resize:vertical; min-height:64px;
                                    font-family:var(--mv-font-tech, "Fira Code", Consolas, monospace); font-size:11px; }
  /* A wizard stretched across a 900px window would put the buttons a screen-width away
     from the text they belong to. */
  #gst-wizard > *, #gst-backup > * { width:100%; max-width:620px; }
  /* The window's drag strip owns the top 50px; the back button must not hide under it. */
  .gstw-head { display:flex; align-items:center; gap:10px; padding:52px 16px 10px; flex:none; }
  .gstw-back { background:none; border:none; color:var(--mv-label-2); cursor:pointer; font-size:16px;
               padding:2px 6px; flex:none; }
  .gstw-back:hover { color:var(--mv-label); }
  .gstw-headtext { min-width:0; }
  .gstw-title { font-weight:800; font-size:16px; }
  .gstw-count { font-size:11px; color:var(--mv-label-2); margin-top:2px; }
  .gstw-bar { display:flex; gap:4px; padding:0 16px 12px; flex:none; }
  .gstw-bar i { flex:1; height:3px; border-radius:2px; background:var(--mv-fill-3); }
  .gstw-bar i.on { background:var(--mv-accent); }
  .gstw-body { flex:1; overflow-y:auto; overflow-x:hidden; padding:0 16px 18px;
               display:flex; flex-direction:column; gap:12px; }

  .gstw-lead { font-size:12px; line-height:2; color:var(--mv-label-2); }
  .gstw-note { font-size:11px; line-height:1.9; color:var(--mv-label-2); }
  .gstw-label { font-size:11.5px; font-weight:700; color:var(--mv-label-2); margin-top:2px; }
  .gstw-input { width:100%; padding:9px 11px; border-radius:10px; font-size:12px;
                background:var(--mv-surface); border:var(--mv-hl) solid var(--mv-sep-2); color:var(--mv-label); }
  .gstw-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top:2px; }
  .gstw-actions .gst-btn-primary { flex:1; min-width:120px; }

  .gstw-choice { text-align:right; width:100%; cursor:pointer; padding:13px 14px;
                 border-radius:14px; background:var(--mv-group);
                 border:var(--mv-hl) solid var(--mv-sep); color:var(--mv-label); }
  .gstw-choice.on { border-color:var(--mv-blue); background:color-mix(in srgb, var(--mv-blue) 10%, transparent); }
  .gstw-choice-head { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
  .gstw-choice b { font-size:13px; }
  .gstw-choice p { font-size:11.5px; line-height:1.9; color:var(--mv-label-2); }
  .gstw-badge { font-size:10px; font-weight:700; padding:2px 8px; border-radius:9999px;
                background:color-mix(in srgb, var(--mv-blue) 20%, transparent); color:var(--mv-blue-ink); }

  .gstw-status { font-size:12px; line-height:1.9; padding:10px 12px; border-radius:11px;
                 background:var(--mv-group); border:var(--mv-hl) solid var(--mv-sep);
                 white-space:pre-line; }
  .gstw-status.ok { background:color-mix(in srgb, var(--mv-green) 10%, transparent); border-color:color-mix(in srgb, var(--mv-green) 30%, transparent); }
  .gstw-status.bad { background:color-mix(in srgb, var(--mv-red) 10%, transparent); border-color:color-mix(in srgb, var(--mv-red) 30%, transparent); }
  .gstw-error { font-size:12px; line-height:1.9; padding:10px 12px; border-radius:11px;
                background:color-mix(in srgb, var(--mv-red) 12%, transparent); border:var(--mv-hl) solid color-mix(in srgb, var(--mv-red) 35%, transparent);
                color:var(--mv-red-ink); white-space:pre-line; }

  /* Keys and URLs are LTR technical strings; forcing them RTL makes them unreadable
     and, worse, makes a correct value look wrong. */
  .gstw-key { font-family:var(--mv-font-tech, "Fira Code", Consolas, monospace); font-size:12px; direction:ltr;
              text-align:left; padding:10px 12px; border-radius:10px; word-break:break-all;
              background:var(--mv-surface); border:var(--mv-hl) solid var(--mv-sep-2); }
  .gstw-log { font-size:11px; line-height:1.9; color:var(--mv-label-2); display:flex;
              flex-direction:column; gap:3px; }
  .gstw-log .ok { color:var(--mv-green-ink); }
  .gstw-log .bad { color:var(--mv-red-ink); }
  .gstw-guide { font-size:11.5px; line-height:2.1; color:var(--mv-label-2); padding-inline-start:18px;
                display:flex; flex-direction:column; gap:2px; }
  .gstw-guide li { list-style:decimal; }
  .gstw-summary { font-size:12px; line-height:2.1; color:var(--mv-label-2); padding-inline-start:18px; }
  .gstw-summary li { list-style:disc; }

  /* The backup overlay's own two tabs (gst-backup.js) — the page's sections replaced the
     panel's tab strip, but this sheet still has two of its own. */
  .gst-tabs { display:flex; gap:8px; padding:0 16px 10px; flex:none; }
  .gst-tab { flex:0 0 auto; padding:8px 22px; border:none; cursor:pointer; font-size:12.5px; font-weight:700;
             color:var(--mv-label-2); background:transparent; border-bottom:2px solid transparent; }
  .gst-tab-on { color:var(--mv-label); border-bottom-color:var(--mv-blue); }
</style>`;

// Last known server state. Kept so a failed poll leaves the panel showing the previous
// truth rather than blanking out.
let gstState = { running: false, relays: [], network: {}, systemProxy: false };
let gstHealth = {};          // relayId -> { google:{...}, cf:{...} }, filled in phase 4
let gstBusy = false;
// Last failed status fetch. The panel used to write this into a status line under the
// title; the hero says it now, because a page that shows «آمادهٔ اتصال» while the service
// is not answering is the panel lying about what it knows.
let gstError = '';
let gstModeBusy = '';        // id of the mode currently being applied, '' when idle
let gstPollTimer = null;

async function gstApi(path, body) {
    const opts = body === undefined
        ? {}
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(`/api/gst/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    // The server always answers {ok:false, error} on failure; surface that text rather
    // than a bare HTTP status, because it is already written in Persian for the user.
    if (!res.ok || data.ok === false) throw new Error(data.error || `خطای سرور (${res.status})`);
    return data;
}

function gstToast(msg) {
    if (typeof toast === 'function') toast(msg);
}

// ── rendering ─────────────────────────────────────────────────────────────────

// The two connection modes, in increasing order of how much of the machine they take.
//
// There was a third — «تونل سراسری», a sing-box adapter feeding the whole machine into the
// engine. It was removed because it never worked, and because the sentence under it was not
// true even in principle: this engine relays HTTP and MITMs TLS, and hands every other protocol
// straight out untouched. A full tunnel gives an engine EVERY protocol the machine speaks, so
// «بدون هیچ نشتی» was promising something the engine cannot do. See gst-runtime.js for the
// three rounds of measurement behind that call.
//
// The proxy mode carries the same limitation honestly: a program either speaks to the proxy or
// it does not, and nobody is told otherwise.
const GST_MODES = [
    {
        id: 'local',
        title: 'فقط تونل محلی',
        desc: 'چیزی در ویندوز تغییر نمی‌کند؛ خودتان مرورگر یا برنامه را تنظیم می‌کنید.',
    },
    {
        id: 'sysproxy',
        title: 'پروکسی سیستم',
        desc: 'مرورگر و برنامه‌های سازگار. این موتور وب را حمل می‌کند؛ بازی‌ها و برنامه‌هایی که پروکسی نمی‌شناسند از آن رد نمی‌شوند.',
    },
];

/** Which of the two is active right now. */
function gstCurrentMode() {
    return gstState.systemProxy ? 'sysproxy' : 'local';
}

/**
 * What the hero says. One place decides the words, the lamp and whether the button can be
 * pressed, so the sidebar identity, the stage and the footer can never disagree about what
 * the engine is doing.
 */
function gstView() {
    const total = gstState.relays.length;
    const usable = gstState.relays.filter((r) => r.deploymentId).length;
    const base = { usable, total };

    if (gstError && !gstBusy) {
        return Object.assign(base, {
            tone: 'off',
            head: 'سرویس برنامه جواب نمی‌دهد',
            line: `${gstEsc(gstError)} — تا وقتی این برطرف نشود، آنچه زیر می‌بینید آخرین چیزی است که معلوم بود، نه وضعیت همین لحظه.`,
        });
    }
    if (gstBusy) {
        return Object.assign(base, {
            tone: 'busy',
            head: gstState.running ? 'در حال قطع' : 'در حال اتصال',
            line: gstState.running ? 'چند لحظه…' : 'موتور بالا می‌آید و اولین ریلی امتحان می‌شود…',
        });
    }
    if (!total) {
        return Object.assign(base, {
            tone: 'off',
            head: 'اول یک ریلی بسازید',
            line: 'این تونل سرور اجاره‌ای ندارد: یک اسکریپت کوچک در حساب گوگل خودتان مستقر می‌شود و ترافیک از زیرساخت گوگل رد می‌شود. بخش «ریلی‌ها» قدم‌به‌قدم همین کار را انجام می‌دهد.',
        });
    }
    if (!usable) {
        return Object.assign(base, {
            tone: 'off',
            head: 'ریلی ثبت شده، اما مستقر نشده',
            line: `${gstFa(total)} ریلی ثبت شده ولی هیچ‌کدام آدرس استقرار ندارند. جادوگر «افزودن ریلی» را تا آخر ببرید تا اسکریپت روی گوگل منتشر شود.`,
        });
    }
    if (gstState.running) {
        const m = GST_MODES.find((x) => x.id === gstCurrentMode()) || GST_MODES[0];
        return Object.assign(base, {
            tone: 'on',
            head: 'وصل است',
            line: `${gstFa(usable)} ریلی فعال از ${gstFa(total)} · ${m.title} — ${m.desc}`,
        });
    }
    return Object.assign(base, {
        tone: 'off',
        head: 'آمادهٔ اتصال',
        line: `${gstFa(usable)} ریلی آماده است. با یک ضربه موتور بالا می‌آید؛ بعد از آن «حالت اتصال» تعیین می‌کند چه چیزی از تونل رد شود.`,
    });
}

/* The three sub-modules declare their state with `let`/`const` in their own files. Reading
   them through a guard keeps this file working even when one of them failed to load. */
function gstHealthSnap() { try { return gstHealthData || {}; } catch (e) { return {}; } }
function gstHealthBusy() { try { return !!gstHealthRunning; } catch (e) { return false; } }
function gstLampWord(state) { try { return (GST_LAMP[state] || GST_LAMP.unknown).label; } catch (e) { return ''; } }
function gstLampColor(state) { try { return (GST_LAMP[state] || GST_LAMP.unknown).color; } catch (e) { return 'var(--mv-gray)'; } }

function gstDot(tone) {
    return `<i class="mv-eng-dot${tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : ''}"></i>`;
}

/** The app's own icon, the one on the desktop — not a second drawing of the same thing. */
function gstRenderIdent() {
    const host = document.getElementById('gst-ident');
    if (!host) return;
    const v = gstView();
    const word = v.tone === 'on' ? 'وصل است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
    const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('gst');
    const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
        : '<span class="mv-side-tile" style="--tint:var(--mv-blue)"><svg aria-hidden="true"><use href="#g-google"/></svg></span>';
    host.innerHTML = `${icon}
      <b>تونل گوگل‌اسکریپت</b>
      <small>${gstDot(v.tone)}${word}</small>`;
}

/** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
function gstRenderStage() {
    const host = document.getElementById('gst-stage');
    if (!host) return;
    const v = gstView();

    if (host.dataset.built !== '1') {
        host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-gst-act="power" data-part="power">
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

    const on = gstState.running;
    const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : '';
    const btn = q('power');
    const want = 'mv-eng-power' + ring;
    if (btn.className !== want) btn.className = want;
    // Disabled without a deployed relay: a press that can only end in «هیچ ریلی‌ای نیست» is
    // worse than a button that says «not yet».
    btn.disabled = gstBusy || !v.usable;
    const aria = on ? 'قطع' : 'اتصال';
    btn.setAttribute('aria-label', aria);
    btn.title = v.usable ? aria : 'اول یک ریلی بسازید';
    const glyph = v.tone === 'busy' ? 'mv-spin-ring' : (on ? 'ph-fill ph-power' : 'ph-bold ph-power');
    const gl = q('glyph');
    if (gl.className !== glyph) gl.className = glyph;

    const el = q('live');
    if (el && window.MVEngineLive) MVEngineLive.mount(el);
}

/**
 * The setup as one horizontal line. It is on screen only while there is still a step to do —
 * once the tunnel is up it would be three ticks saying nothing.
 */
function gstRenderFlow() {
    const wrap = document.getElementById('gst-flow');
    const host = document.getElementById('gst-steps');
    if (!wrap || !host) return;

    const show = !gstState.running;
    wrap.style.display = show ? 'flex' : 'none';
    if (!show) return;

    const usable = gstState.relays.filter((r) => r.deploymentId).length;
    const tested = Object.keys(gstHealth).some((k) => {
        const g = gstHealth[k] && gstHealth[k].google;
        return !!g && (g.state === 'ok' || g.state === 'slow');
    });
    const done = { relay: usable > 0, test: tested, connect: false };
    const idx = GST_STEPS.findIndex((x) => !done[x.key]);

    host.innerHTML = GST_STEPS.map((x, i) => {
        let cls = 'pending', mark = gstFa(i + 1);
        if (done[x.key]) { cls = 'done'; mark = '✓'; }
        else if (i === idx) { cls = 'active'; mark = '●'; }
        return `<span class="mv-step is-${cls}"><i>${mark}</i>${x.fa}</span>`;
    }).join('');
}

/**
 * The cards: the four things this window decides. The mode is set right here because it is
 * one click and it changes what the machine does; the other three open their section, where
 * the lists and the measurements live.
 */
function gstRenderCards() {
    const host = document.getElementById('gst-cards');
    if (!host) return;

    const v = gstView();
    const mode = gstCurrentMode();
    // "local" is always available: it is the ABSENCE of a machine-wide change, so there is
    // nothing to refuse even when the engine is down.
    const locked = !gstState.running || !!gstModeBusy;
    const modeTitle = (GST_MODES.find((x) => x.id === mode) || GST_MODES[0]).title;

    const relays = gstState.relays.slice(0, 3);
    const quota = v.usable ? (v.usable * 20000).toLocaleString('fa-IR') : '';

    const net = gstState.network || {};
    const ips = Array.isArray(net.ips) ? net.ips : [];
    const snis = Array.isArray(net.snis) ? net.snis : [];

    const h = gstHealthSnap();
    const cert = h.cert || {};
    const reach = h.reach || {};
    const report = h.report;
    const counts = (report && report.counts) || null;
    const healthEnd = !report ? 'بررسی نشده'
        : counts && counts.error ? `${gstFa(counts.error)} خراب`
            : counts && counts.ok ? `${gstFa(counts.ok)} سالم` : 'بررسی شد';

    /** One read-only line inside a card — a fact, not a control. */
    const fact = (icon, colour, title, sub) => `
          <div class="mv-eng-pick" aria-disabled="true">
            <i class="${icon}" style="color:${colour}"></i>
            <span class="mv-eng-pick-text"><b>${title}</b><small>${sub}</small></span>
          </div>`;

    host.innerHTML = `
      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <div class="mv-eng-card2-head" style="cursor:default">
          <span class="mv-eng-glyph"><i class="ph-fill ph-arrows-split"></i></span>
          <h3>حالت اتصال</h3>
          <span class="mv-eng-card2-end">${modeTitle}</span>
        </div>
        <div class="mv-eng-card2-body" role="radiogroup" aria-label="حالت اتصال">
          ${GST_MODES.map((m) => {
        const on = mode === m.id;
        const off = locked && m.id !== 'local';
        const busy = gstModeBusy === m.id;
        return `
          <button type="button" class="mv-eng-pick${on ? ' is-on' : ''}${on && gstState.running ? ' is-live' : ''}"
                  data-gst-mode="${m.id}" role="radio" aria-checked="${on}"
                  ${off || busy ? 'disabled' : ''} title="${off ? 'اول تونل را وصل کنید' : ''}">
            <i class="${busy ? 'mv-spin-ring' : on ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>
            <span class="mv-eng-pick-text"><b>${m.title}</b><small>${busy ? 'در حال اعمال…' : m.desc}</small></span>
          </button>`;
    }).join('')}
        </div>
        <div class="mv-eng-card2-foot">${gstState.running
            // WHAT THIS ENGINE CARRIES, said plainly. It relays HTTP and MITMs TLS through Apps
            // Script and passes everything else out untouched, so a program that does not speak
            // to the proxy is not tunnelled — and now the panel says so instead of leaving the
            // user to assume otherwise.
            ? 'این موتور وب را حمل می‌کند: هر برنامه‌ای که پروکسی را بشناسد از تونل رد می‌شود. بازی‌ها و برنامه‌هایی که پروکسی نمی‌شناسند مستقیم می‌روند.'
            : 'تا وقتی تونل وصل نشده، فقط حالت محلی معنی دارد.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-gst-go="relays">
            <span class="mv-eng-glyph"><i class="ph-fill ph-stack"></i></span>
            <h3>ریلی‌ها</h3>
            <span class="mv-eng-card2-end">${v.total ? `${gstFa(v.usable)} از ${gstFa(v.total)}` : '—'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-gst-act="add"
                  title="افزودن ریلی تازه" aria-label="افزودن ریلی تازه">
            <i class="ph-bold ph-plus"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${relays.length ? relays.map((r) => {
        const g = (gstHealth[r.id] || {}).google || { state: r.deploymentId ? 'unknown' : 'incomplete' };
        const cf = r.cfEnabled ? 'کلادفلر روشن' : 'بدون کلادفلر';
        return fact('ph-fill ph-circle', gstLampColor(g.state), gstEsc(r.name),
            `${gstEsc(gstLampWord(g.state))} · ${cf}`);
    }).join('') : '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز ریلی‌ای ندارید — دکمهٔ + بالا از حساب گوگل خودتان یکی می‌سازد.</div>'}
        </div>
        <div class="mv-eng-card2-foot">${quota
            ? `ظرفیت روزانهٔ تقریبی <b>${quota}</b> درخواست. هر حساب گوگل تازه، ظرفیت را بیشتر می‌کند.${v.total > relays.length ? ` · ${gstFa(v.total - relays.length)} ریلی دیگر در بخش «ریلی‌ها»` : ''}`
            : 'ریلی یعنی یک اسکریپت کوچک در حساب گوگل خودتان؛ سروری اجاره نمی‌شود.'}</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-pink, #FF2D55)">
        <button type="button" class="mv-eng-card2-head" data-gst-go="network">
          <span class="mv-eng-glyph"><i class="ph-fill ph-signpost"></i></span>
          <h3>مسیر شبکه</h3>
          <span class="mv-eng-card2-end">${gstState.autoOptimize ? 'خودکار' : 'دستی'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          ${fact('ph-fill ph-globe-hemisphere-west', 'var(--mv-label-3)',
        `<span dir="ltr">${gstEsc(ips[0] || '—')}</span>`,
        ips.length ? `${gstFa(ips.length)} آی‌پی تمیز انتخاب شده` : 'آی‌پی تمیزی انتخاب نشده')}
          ${fact('ph-fill ph-tag', 'var(--mv-label-3)',
        `<span dir="ltr">${gstEsc(snis[0] || '—')}</span>`,
        snis.length ? `${gstFa(snis.length)} دامنهٔ پوششی انتخاب شده` : 'دامنهٔ پوششی انتخاب نشده')}
        </div>
        <div class="mv-eng-card2-foot">چند مورد را تیک بزنید: تونل بینشان می‌چرخد، پس اگر یکی از کار افتاد اتصال قطع نمی‌شود.</div>
      </div>

      <div class="mv-eng-card2" style="--tint:var(--mv-red)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-gst-go="health">
            <span class="mv-eng-glyph"><i class="ph-fill ph-heartbeat"></i></span>
            <h3>سلامت</h3>
            <span class="mv-eng-card2-end">${healthEnd}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-gst-act="check"
                  title="بررسی کامل همهٔ پایه‌ها" aria-label="بررسی کامل همهٔ پایه‌ها"
                  ${gstHealthBusy() ? 'disabled' : ''}>
            <i class="${gstHealthBusy() ? 'mv-spin-ring' : 'ph-bold ph-pulse'}"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${fact(cert.state === 'ok' ? 'ph-fill ph-seal-check' : 'ph-fill ph-warning-circle',
        cert.state === 'ok' ? 'var(--mv-green)' : 'var(--mv-label-3)',
        'گواهی امنیتی', gstEsc(cert.state === 'ok' ? 'نصب است' : (cert.message || 'هنوز بررسی نشده')))}
          ${fact(reach.reachable ? 'ph-fill ph-check-circle' : 'ph-fill ph-question',
        reach.reachable ? 'var(--mv-green)' : 'var(--mv-label-3)',
        'دسترسی به گوگل', reach.reachable
            ? `باز است${reach.latency ? ` · ${reach.latency.toLocaleString('fa-IR')}ms` : ''}`
            : gstEsc(reach.error || 'هنوز بررسی نشده'))}
        </div>
        <div class="mv-eng-card2-foot">هر ریلی دو پایهٔ مستقل دارد: گوگل و کلادفلر. بررسی کامل هر دو را جدا می‌سنجد و راه درستش را پیشنهاد می‌دهد.</div>
      </div>`;
}

function gstRenderFoot() {
    const host = document.getElementById('gst-foot');
    if (!host) return;
    const v = gstView();
    const m = GST_MODES.find((x) => x.id === gstCurrentMode()) || GST_MODES[0];
    const word = v.tone === 'on' ? `وصل — ${gstFa(v.usable)} ریلی فعال`
        : v.tone === 'busy' ? 'در حال کار'
            : gstError ? 'سرویس جواب نمی‌دهد'
                : v.usable ? 'آمادهٔ اتصال'
                    : v.total ? 'ریلی مستقر نشده' : 'ریلی ندارید';
    const port = gstState.running && gstState.socksPort
        ? `<code dir="ltr">SOCKS ${gstState.socksPort}</code>` : '';
    host.innerHTML = `
      ${gstDot(v.tone)}
      <span>${word}</span>
      <span class="mv-eng-foot-end">${port}<span>${m.title}</span></span>`;
}

function gstRenderRelays() {
    const list = document.getElementById('gst-relay-list');
    if (!list) return;

    if (!gstState.relays.length) {
        list.innerHTML = `<div class="gst-empty">
            هیچ ریلی‌ای ندارید.<br>
            با ساخت اولین ریلی، تونل از زیرساخت گوگل عبور می‌کند<br>
            و می‌توانید بعداً هر تعداد ریلی دیگر اضافه کنید.
        </div>`;
    } else if (typeof renderGstRelayCard === 'function') {
        list.innerHTML = gstState.relays
            .map(r => renderGstRelayCard(r, gstHealth[r.id]))
            .join('');
    }

    // Quota is the reason to add more accounts, so state it in real numbers rather than
    // making the user guess what a second relay buys them.
    const note = document.getElementById('gst-quota-note');
    if (note) {
        const n = gstState.relays.filter(r => r.deploymentId).length;
        note.innerHTML = n
            ? `ظرفیت روزانه‌ی تقریبی: <b>${(n * 20000).toLocaleString('fa-IR')}</b> درخواست ` +
              `(${n.toLocaleString('fa-IR')} حساب گوگل). هر حساب جدید، ظرفیت را بیشتر می‌کند.`
            : '';
    }
}

/** Everything the hero owns. The name the actions already call. */
function gstRenderStatus() {
    const wrap = document.getElementById('gst-wrapper');
    if (!wrap) return;
    gstRenderIdent();
    gstRenderFoot();
    if (gstSec === 'connect') { gstRenderStage(); gstRenderFlow(); gstRenderCards(); }
    gstWire(wrap);
}

function gstRender() {
    gstRenderStatus();
    gstRenderRelays();
}

function gstWire(root) {
    root.querySelectorAll('[data-gst-go]').forEach((b) => {
        b.onclick = () => gstGoSec(b.getAttribute('data-gst-go'));
    });
    root.querySelectorAll('[data-gst-mode]').forEach((b) => {
        b.onclick = () => gstPickMode(b.getAttribute('data-gst-mode'));
    });
    root.querySelectorAll('[data-gst-act]').forEach((b) => {
        b.onclick = () => {
            const k = b.getAttribute('data-gst-act');
            if (k === 'power') gstTogglePower();
            else if (k === 'add') gstStartWizard();
            else if (k === 'check') {
                gstGoSec('health');
                if (typeof gstRunHealthCheck === 'function') gstRunHealthCheck();
            }
        };
    });
}

// ── server sync ───────────────────────────────────────────────────────────────

async function gstRefresh() {
    try {
        const data = await gstApi('status');
        gstState = {
            running: !!data.running,
            relays: data.relays || [],
            network: data.network || {},
            systemProxy: !!data.systemProxy,
            autoOptimize: !!data.autoOptimize,
            httpPort: data.httpPort,
            socksPort: data.socksPort,
            authKey: data.authKey,
        };
        gstError = '';
        gstRender();
    } catch (e) {
        // Still render. Blanking the panel on a failed poll would throw away the last thing
        // known to be true, and the button with it.
        gstBusy = false;
        gstError = e.message;
        gstRender();
    }
}

// ── actions ───────────────────────────────────────────────────────────────────

async function gstTogglePower() {
    if (gstBusy) return;
    gstBusy = true;
    gstRenderStatus();
    try {
        await gstApi(gstState.running ? 'stop' : 'start', {});
        gstToast(gstState.running ? 'تونل قطع شد' : '✅ تونل وصل شد');
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
    gstBusy = false;
    await gstRefresh();
}

/**
 * Flip the per-relay Cloudflare switch.
 *
 * The switch records intent only. What actually routes traffic is the WORKER_URL
 * constant inside the Apps Script deployed on Google, and this app cannot edit it — so
 * the change is NOT live until the user re-deploys the script. Showing the two lines to
 * change, right here, is the difference between a switch that works and a switch that
 * lies.
 */
async function gstToggleRelayCloudflare(id, enabled) {
    try {
        const res = await gstApi(`relays/${id}/cloudflare`, { enabled });
        await gstRefresh();
        if (res.patch) gstShowCloudflarePatch(id, enabled, res.patch, res.message);
        else gstToast(enabled ? 'کلادفلر این ریلی روشن شد' : 'کلادفلر این ریلی خاموش شد');
    } catch (e) {
        gstToast('❌ ' + e.message);
        await gstRefresh();
    }
}

/** The "you still have to update the script" panel, shown as a wizard-style overlay. */
function gstShowCloudflarePatch(relayId, enabled, patch, message) {
    const host = document.getElementById('gst-backup');   // reuse the overlay slot
    if (!host) return gstToast(message);

    const lines = patch.lines.join('\n');
    host.style.display = 'flex';
    host.innerHTML = `
      <div class="gstw-head">
        <button class="gstw-back" onclick="gstBackupClose()" title="بستن">✕</button>
        <div class="gstw-headtext">
          <div class="gstw-title">${enabled ? 'روشن کردن' : 'خاموش کردن'} کلادفلر — یک قدم باقی است</div>
          <div class="gstw-count">تغییر هنوز اعمال نشده</div>
        </div>
      </div>
      <div class="gstw-body">
        <div class="gstw-error" style="color:var(--mv-orange-ink); background:color-mix(in srgb, var(--mv-orange) 10%, transparent); border-color:color-mix(in srgb, var(--mv-orange) 35%, transparent);">
          ${gstEsc(message)}
        </div>
        <p class="gstw-lead">
          مسیر واقعی ترافیک را یک خط داخل اسکریپت گوگل تعیین می‌کند که روی سرور گوگل است و
          برنامه نمی‌تواند آن را عوض کند. این دو خط را جای‌گزین کنید:
        </p>
        <div class="gstw-key" dir="ltr">${gstEsc(lines)}</div>
        <div class="gstw-actions">
          <button class="gst-btn-ghost" onclick="gstWizCopy(${JSON.stringify(lines)}, 'دو خط کپی شد')">کپی</button>
          <button class="gst-btn-ghost" onclick="window.open('https://script.google.com/home','_blank')">
            باز کردن اسکریپت گوگل
          </button>
        </div>
        <p class="gstw-note">${gstEsc(patch.instructions)}</p>
        <div class="gstw-actions">
          <button class="gst-btn-primary" onclick="gstBackupClose(); gstSwitchTab('health');">
            بعد از Deploy، «تست ترکیب» را بزنید
          </button>
        </div>
      </div>`;
}

async function gstDeleteRelay(id) {
    const relay = gstState.relays.find(r => r.id === id);
    if (!relay) return;
    const ok = await uiConfirm({
        title: `ریلی «${relay.name}» حذف شود؟`,
        message: 'اسکریپت گوگل و Worker شما روی حساب خودتان دست‌نخورده باقی می‌مانند — ' +
                 'فقط از فهرست این برنامه برداشته می‌شود.',
        confirmLabel: 'حذف کن',
        cancelLabel: 'انصراف',
        danger: true,
    });
    if (!ok) return;
    try {
        const res = await fetch(`/api/gst/relays/${id}`, { method: 'DELETE' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) throw new Error(data.error || `خطای سرور (${res.status})`);
        gstToast('ریلی حذف شد');
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
    await gstRefresh();
}

// gstStartWizard / gstResumeWizard live in gst-wizard.js.
/** Per-card test: probes just this relay's two legs. */
async function gstTestRelay(id) {
    gstToast('در حال تست…');
    try {
        const { report } = await gstApi(`health/check/${id}`, {});
        gstHealth[id] = { google: report.google, cf: report.cf };
        gstRenderRelays();
        gstToast(`${report.name}: ${report.verdict.text}`);
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
}

/** Sweep every relay, then jump to the health tab where the detail lives. */
async function gstTestAll() {
    if (!gstState.relays.length) return gstToast('اول یک ریلی بسازید.');
    gstSwitchTab('health');
    if (typeof gstRunHealthCheck === 'function') await gstRunHealthCheck();
}
/**
 * Switch connection mode. One call per change, and the backend enforces the exclusion —
 * the UI only has to ask for the mode the user picked, never to sequence "turn that one
 * off, then this one on".
 */
async function gstPickMode(mode) {
    if (gstModeBusy) return;
    const previous = gstCurrentMode();
    if (mode === previous) return;

    gstModeBusy = mode;
    gstRenderStatus();

    try {
        if (mode === 'local') {
            await gstApi('mode/sysproxy', { enabled: false });
            gstToast('به حالت محلی برگشت — ویندوز دست‌نخورده است');
        } else {
            await gstApi('mode/sysproxy', { enabled: true });
            gstToast('✅ پروکسی سیستم روشن شد');
        }
    } catch (e) {
        gstToast('❌ ' + e.message);
    }

    gstModeBusy = '';
    await gstRefresh();
}

/**
 * Show one section. The three tabs became three of these, so the ids the sub-modules render
 * into are untouched — only which of them is on screen changed.
 */
function gstGoSec(id) {
    const wrap = document.getElementById('gst-wrapper');
    if (!wrap) return;
    gstSec = GST_SECTIONS.some((x) => x.id === id) ? id : 'connect';
    wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === gstSec));
    wrap.querySelectorAll('.mv-side-item[data-gst-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-gst-sec') === gstSec));
    const found = GST_SECTIONS.find((x) => x.id === gstSec);
    const title = document.getElementById('gst-pane-title');
    if (title) title.textContent = found ? found.label : '';
    const back = document.getElementById('gst-back');
    if (back) back.disabled = gstSec === 'connect';
    // The hero owns the top of the home section, so the window's drag strip narrows to the
    // sidebar there (page-kit.css) and the button underneath stays clickable.
    const pane = wrap.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', gstSec === 'connect');
    const sc = document.getElementById('gst-scroll');
    if (sc) sc.scrollTop = 0;

    // Load the cached report on open. This is the cheap GET, not a probe sweep —
    // opening a section must never fire real network tests the user did not ask for.
    if (gstSec === 'health' && typeof gstLoadHealth === 'function') gstLoadHealth();
    if (gstSec === 'network' && typeof gstLoadNetwork === 'function') gstLoadNetwork();

    gstRender();
}

/** The name the older call sites use — «tab» and «section» are the same move now. */
function gstSwitchTab(name) { gstGoSec(name); }

// ── init ──────────────────────────────────────────────────────────────────────

function initGstModule() {
    const container = document.getElementById('ls-gst');
    if (!container) return;
    container.innerHTML = gstHtmlTemplate;
    if (container.parentElement) {
        container.parentElement.style.position = 'relative';
        container.parentElement.style.padding = '0';
        container.parentElement.style.overflow = 'hidden';
    }
    // No z-index of its own: a positioned panel with one would cover the window's title bar
    // and take the traffic lights with it (shell.css neutralises it, but the rule is here).
    container.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent;';

    const wrap = document.getElementById('gst-wrapper');
    if (wrap) {
        wrap.querySelectorAll('.mv-side-item[data-gst-sec]').forEach((b) => {
            b.onclick = () => gstGoSec(b.getAttribute('data-gst-sec'));
        });
    }
    const back = document.getElementById('gst-back');
    if (back) back.onclick = () => gstGoSec('connect');
    // The engine itself is a store item (store/catalog.js › core|gst): the store is where
    // its version is compared, fetched and rolled back.
    const store = document.getElementById('gst-store');
    if (store) store.onclick = () => {
        if (typeof window.storeOpenItem === 'function') window.storeOpenItem('core|gst');
        else if (window.MV && MV.wm) MV.wm.open('store');
    };

    gstGoSec('connect');
    gstRefresh();

    // Poll only while the panel is actually visible. A hidden panel polling every few
    // seconds is pure waste on the low-spec machines this app targets.
    if (gstPollTimer) clearInterval(gstPollTimer);
    gstPollTimer = setInterval(() => {
        const el = document.getElementById('ls-gst');
        if (el && el.style.display !== 'none') gstRefresh();
    }, 5000);
}
