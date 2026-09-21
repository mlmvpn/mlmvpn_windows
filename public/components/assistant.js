// --- «دستیار MLM VPN» ---
//
// The one thing this app asks a newcomer to understand is also the one thing it never explained:
// a config fetched from a panel is RAW — it still points at the worker's own address, which is
// exactly the address that gets filtered. To be useful it has to be combined with an IP that the
// user's own line can still reach, and finding those IPs means a scan, and the scan has four
// stages, and the combination centre is a third window. Five screens for one intention.
//
// The assistant is that intention, in one card that never moves: «configs arrived — shall I
// combine them?». It asks two questions (how many, and what matters), then does every step
// itself and hands back exactly the number that was asked for.
//
// WHY A DOCKED CARD AND NOT A WINDOW: because the user asked for the whole thing to happen
// without the page changing under them. It is portalled to <body> and sits above the dock, so it
// survives every window opening, closing and zooming behind it — including the V2Ray window it
// opens itself at the end.
//
// THE THREE PRIORITIES ARE THREE DIFFERENT MEASUREMENTS, not three labels on one:
//   سرعت اسکن     — tcping only (no core at all), one port, huge concurrency. Fastest to an
//                   answer; it proves the port answers, not that traffic passes.
//   سرعت کانفیگ‌ها — real throughput through the core, in KB/s, against Cloudflare's own sink
//                   (xray-tester.js › realSpeed). Ranked fastest first.
//   پایداری        — the real delay measured THREE times; only nodes that answered all three
//                   survive, ranked by how little they wandered (jitter), then by mean.
// Pick differently and you get a different list. That was the requirement.

(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const SEEN_KEY = 'mv-assistant-seen';
    const OFF_KEY = 'mv-assistant-off';

    function store(key, val) {
        try {
            if (val === undefined) {
                return (window.PersistentStorage ? PersistentStorage.getItem(key) : localStorage.getItem(key));
            }
            if (window.PersistentStorage) PersistentStorage.setItem(key, val); else localStorage.setItem(key, val);
        } catch (e) { /* storage refused: the assistant still works for this session */ }
        return val;
    }

    // ── The modes ──────────────────────────────────────────────────────────
    const MODES = {
        scan: {
            id: 'scan', label: 'سرعت اسکن', icon: 'ph-fill ph-lightning', tint: 'var(--mv-orange)',
            blurb: 'زودتر از همه به نتیجه می‌رسد. فقط بررسی می‌کند پورت جواب می‌دهد یا نه.',
            ports: [443], concurrency: 220, timeout: 2500, batch: 900,
            testType: 'ping', passes: 1, better: 'low',
            unit: 'ms', verifyWord: 'بررسی سریع پورت',
        },
        speed: {
            id: 'speed', label: 'سرعت کانفیگ‌ها', icon: 'ph-fill ph-gauge', tint: 'var(--mv-blue)',
            blurb: 'سرعت واقعی هر کانفیگ را اندازه می‌گیرد و پرسرعت‌ترین‌ها را می‌دهد.',
            ports: [443, 8443], concurrency: 120, timeout: 4000, batch: 700,
            testType: 'speed', passes: 1, better: 'high',
            unit: 'KB/s', verifyWord: 'اندازه‌گیری سرعت واقعی',
        },
        stable: {
            id: 'stable', label: 'پایداری کانفیگ‌ها', icon: 'ph-fill ph-heartbeat', tint: 'var(--mv-green)',
            blurb: 'هر کانفیگ را سه بار می‌سنجد و فقط آن‌هایی را می‌دهد که هر سه بار جواب دادند.',
            ports: [443], concurrency: 90, timeout: 6000, batch: 600,
            testType: 'delay', passes: 3, better: 'low',
            unit: 'ms', verifyWord: 'سه بار سنجش پیاپی',
        },
    };

    // ── State ──────────────────────────────────────────────────────────────
    const st = {
        open: false,
        step: 'idle',        // idle | home | offer | decay | count | mode | ask-engines | racing
                             //  | race-done | run | done | trouble | diagnosing | diag-done
        offer: null,         // { id, name, label, email, configs: [] }
        decay: null,         // { group, rec, raws } — a set whose addresses are dying
        race: null,          // { rows, done, aborted } — «which engine for my line?»
        trouble: null,       // { kind, detail, code, source } — something failed somewhere
        diag: null,          // { sessionId, percent, phase, headline, offers, applied }
        want: 0,
        mode: null,
        running: false,
        cancelled: false,
        stages: [],          // [{ key, label, state, note, pct }]
        result: [],          // final combined uris
        groupId: null,
        msgs: [],
        typing: false,
    };

    // ── Styles ─────────────────────────────────────────────────────────────
    const CSS = `
<style id="as-css">
  /* Above the dock (45) and every window, below menus (1000), spotlight and toasts — the
     assistant must stay visible while it opens a window behind itself. */
  .as-root { position: fixed; inset-inline-start: 18px; bottom: 18px; z-index: 950;
             display: flex; flex-direction: column; align-items: flex-start; gap: 10px;
             font-family: var(--mv-font); direction: rtl; }
  .as-root[hidden] { display: none !important; }

  /* ── the orb: a small neural constellation that breathes ── */
  .as-orb {
    position: relative; width: 54px; height: 54px; border: 0; padding: 0; cursor: pointer;
    border-radius: 50%; display: grid; place-items: center;
    background: radial-gradient(circle at 34% 28%, color-mix(in srgb, var(--mv-accent) 78%, var(--mv-window)), color-mix(in srgb, var(--mv-accent) 30%, var(--mv-window)));
    box-shadow: var(--mv-e3), inset 0 0 0 var(--mv-hl) var(--mv-group-edge);
    transition: transform var(--mv-d-2) var(--mv-ease-spring), box-shadow var(--mv-d-2) var(--mv-ease-out);
  }
  .as-orb:hover { transform: translateY(-2px) scale(1.04); }
  .as-orb:active { transform: scale(.96); }
  .as-orb:focus-visible { outline: none; box-shadow: 0 0 0 5px var(--mv-accent-ring), var(--mv-e3); }
  .as-orb svg { width: 32px; height: 32px; overflow: visible; }
  /* tokenize:off — the constellation is drawn ON the accent fill, so it is white by definition */
  .as-orb .as-edge { stroke: rgba(255,255,255,.55); stroke-width: 1.1; fill: none; }
  .as-orb .as-node { fill: #FFFFFF; }
  /* tokenize:on */
  .as-orb .as-node.is-a { animation: as-pulse 2.4s ease-in-out infinite; }
  .as-orb .as-node.is-b { animation: as-pulse 2.4s ease-in-out .5s infinite; }
  .as-orb .as-node.is-c { animation: as-pulse 2.4s ease-in-out 1s infinite; }
  .as-orb .as-node.is-d { animation: as-pulse 2.4s ease-in-out 1.6s infinite; }
  @keyframes as-pulse { 0%,100% { opacity:.45; r:1.6 } 50% { opacity:1; r:2.7 } }
  /* Reduced motion slows a status signal, it does not kill it. */
  html[data-motion="reduced"] .as-orb .as-node { animation-duration: 6s; }

  .as-orb .as-ring {
    content: ''; position: absolute; inset: -5px; border-radius: 50%;
    border: 2px solid color-mix(in srgb, var(--mv-accent) 55%, transparent);
    opacity: 0; transition: opacity var(--mv-d-2) var(--mv-ease-out);
  }
  .as-root.is-busy .as-orb .as-ring { opacity: 1; animation: as-spin 1.3s linear infinite; border-top-color: transparent; }
  html[data-motion="reduced"] .as-root.is-busy .as-orb .as-ring { animation: none; }
  @keyframes as-spin { to { transform: rotate(360deg); } }

  .as-badge {
    position: absolute; top: -2px; inset-inline-end: -2px; min-width: 18px; height: 18px;
    padding: 0 5px; border-radius: 9px; display: grid; place-items: center;
    font-size: 10.5px; font-weight: 700; font-family: var(--mv-font-tech);
    /* tokenize:off — white on the red fill is the badge pair */
    color: #FFFFFF; background: var(--mv-red-fill);
    /* tokenize:on */
    box-shadow: 0 0 0 2px var(--mv-window);
  }
  .as-badge[hidden] { display: none !important; }

  /* ── the card ── */
  .as-card {
    width: 360px; max-width: calc(100vw - 36px); max-height: min(560px, calc(100vh - 150px));
    display: flex; flex-direction: column; overflow: hidden;
    border-radius: 18px; background: var(--mv-window);
    box-shadow: var(--mv-e4), inset 0 0 0 var(--mv-hl) var(--mv-group-edge);
    animation: as-in var(--mv-d-3) var(--mv-ease-spring);
  }
  @keyframes as-in { from { opacity: 0; transform: translateY(10px) scale(.97); } }
  html[data-motion="reduced"] .as-card { animation: none; }
  .as-card[hidden] { display: none !important; }

  .as-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 14px 10px; }
  .as-avatar {
    width: 30px; height: 30px; flex: none; border-radius: 50%; display: grid; place-items: center;
    background: radial-gradient(circle at 34% 28%, color-mix(in srgb, var(--mv-accent) 70%, transparent), color-mix(in srgb, var(--mv-accent) 26%, var(--mv-group)));
  }
  .as-avatar svg { width: 18px; height: 18px; overflow: visible; }
  .as-id { flex: 1; min-width: 0; }
  .as-id b { display: block; font-size: 13px; font-weight: 700; }
  .as-id small { display: block; font-size: 11px; color: var(--mv-label-2); }
  .as-head .mv-tb-btn { flex: none; }

  .as-body { flex: 1; min-height: 0; overflow: auto; padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 9px; }

  .as-msg { max-width: 92%; padding: 9px 12px; border-radius: 14px; font-size: 12.5px; line-height: 1.85; }
  .as-msg.is-bot { align-self: flex-start; background: var(--mv-group); border-start-start-radius: 5px; }
  /* tokenize:off — white on the accent fill is the fixed pair for a chosen/own thing */
  .as-msg.is-me { align-self: flex-end; background: var(--mv-accent); color: #FFFFFF; border-end-end-radius: 5px; font-weight: 600; }
  /* tokenize:on */
  .as-msg b { font-weight: 700; }
  .as-msg .as-num { font-family: var(--mv-font-tech); font-variant-numeric: tabular-nums; }

  .as-dots { align-self: flex-start; display: flex; gap: 4px; padding: 11px 13px; border-radius: 14px; background: var(--mv-group); }
  .as-dots i { width: 5px; height: 5px; border-radius: 50%; background: var(--mv-label-3); animation: as-bounce 1.2s ease-in-out infinite; }
  .as-dots i:nth-child(2) { animation-delay: .18s; }
  .as-dots i:nth-child(3) { animation-delay: .36s; }
  @keyframes as-bounce { 0%,100% { opacity:.35; transform: translateY(0) } 50% { opacity:1; transform: translateY(-3px) } }
  html[data-motion="reduced"] .as-dots i { animation: none; opacity: .7; }

  .as-act { display: flex; flex-wrap: wrap; gap: 7px; align-self: stretch; }
  .as-act .mv-btn { flex: 1 1 auto; }
  .as-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .as-chip {
    border: 0; cursor: pointer; min-width: 46px; height: 28px; padding: 0 11px; border-radius: 999px;
    font-size: 12px; font-weight: 600; font-family: var(--mv-font-tech);
    color: var(--mv-label-2); background: var(--mv-fill);
    box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-sep);
  }
  .as-chip:hover { color: var(--mv-label); }
  .as-count { display: flex; gap: 7px; align-items: center; align-self: stretch; }
  .as-count input {
    flex: 1; min-width: 0; margin: 0; height: 32px; border-radius: 9px; padding: 0 11px;
    font-size: 13px; font-family: var(--mv-font-tech); font-variant-numeric: tabular-nums;
    direction: ltr; text-align: center; color: var(--mv-label);
    background: var(--mv-field); border: var(--mv-hl) solid var(--mv-sep);
  }
  .as-count input:focus { outline: none; border-color: var(--mv-accent); }

  /* ── the three priorities ── */
  .as-modes { display: flex; flex-direction: column; gap: 7px; align-self: stretch; }
  .as-mode {
    display: flex; align-items: flex-start; gap: 10px; width: 100%; text-align: start;
    border: 0; cursor: pointer; padding: 10px 11px; border-radius: 12px;
    background: var(--mv-group); box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-group-edge);
    transition: background var(--mv-d-1) var(--mv-ease-out);
  }
  .as-mode:hover { background: var(--mv-fill); }
  .as-mode i { font-size: 17px; color: var(--tint, var(--mv-accent)); line-height: 1.3; }
  .as-mode b { display: block; font-size: 12.5px; font-weight: 700; color: var(--mv-label); }
  .as-mode small { display: block; margin-top: 2px; font-size: 11px; line-height: 1.7; color: var(--mv-label-2); }

  /* ── choosing which configs to combine ── */
  .as-picks { display: flex; flex-direction: column; gap: 6px; align-self: stretch;
              max-height: 216px; overflow-y: auto; }
  .as-pick {
    display: flex; align-items: flex-start; gap: 9px; width: 100%; text-align: start;
    border: 0; cursor: pointer; padding: 9px 10px; border-radius: 11px;
    background: var(--mv-group); box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-group-edge);
    transition: background var(--mv-d-1) var(--mv-ease-out);
  }
  .as-pick:hover { background: var(--mv-fill); }
  .as-pick.is-on { box-shadow: inset 0 0 0 2px var(--mv-accent); }
  .as-pick > i { flex: none; font-size: 15px; line-height: 1.4; color: var(--mv-label-3); }
  .as-pick.is-on > i { color: var(--mv-accent); }
  .as-pick b { display: block; font-size: 12.5px; font-weight: 700; color: var(--mv-label); }
  .as-pick small { display: block; margin-top: 2px; font-size: 11px; line-height: 1.6; color: var(--mv-label-2); }
  .as-hint { align-self: stretch; font-size: 11px; color: var(--mv-label-3); }

  /* ── the run ── */
  .as-stages { display: flex; flex-direction: column; gap: 8px; align-self: stretch;
               padding: 11px; border-radius: 12px; background: var(--mv-group);
               box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
  .as-stage { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--mv-label-2); }
  .as-stage > i { flex: none; width: 15px; text-align: center; font-size: 12px; color: var(--mv-label-3); }
  .as-stage.is-active { color: var(--mv-label); font-weight: 650; }
  .as-stage.is-active > i { color: var(--mv-accent); }
  .as-stage.is-done > i { color: var(--mv-green); }
  .as-stage-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .as-stage-note { font-size: 11px; color: var(--mv-label-3); font-family: var(--mv-font-tech); }
  .as-bar { height: 4px; border-radius: 2px; overflow: hidden; background: var(--mv-fill); }
  .as-bar > div { height: 100%; width: 0; border-radius: 2px; background: var(--mv-accent); transition: width .35s var(--mv-ease-out); }
  /* An indeterminate stage still has to look alive: a band that travels, never a frozen bar. */
  .as-bar.is-idle > div { width: 38%; animation: as-slide 1.5s var(--mv-ease-in-out, ease-in-out) infinite; }
  @keyframes as-slide { 0% { margin-inline-start: -38%; } 100% { margin-inline-start: 100%; } }
  html[data-motion="reduced"] .as-bar.is-idle > div { animation: none; width: 100%; opacity: .45; }

  /* A DRAWN RING, NEVER A GLYPH WITH A RING ON TOP.
     The icon font draws its glyph in ::before too, so an element carrying both ph-circle-notch
     AND this class gets two circles — one turning, one not. content is forced here so that a
     stray glyph class can never draw a second ring again. */
  /* The engine field: one row each, state on the left, so the eye can scan the column. */
  .as-eng { display: flex; flex-direction: column; gap: 2px; align-self: stretch;
            padding: 8px; border-radius: 12px; background: var(--mv-group);
            box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
  .as-eng-row { display: flex; align-items: center; gap: 8px; padding: 4px 4px; font-size: 12px; }
  .as-eng-row + .as-eng-row { border-top: var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.2)); }
  .as-eng-row > i:first-child { flex: none; width: 15px; text-align: center; font-size: 12px; color: var(--mv-label-3); }
  .as-eng-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--mv-label-2); }
  .as-eng-row.is-live .as-eng-name { color: var(--mv-label); font-weight: 650; }
  .as-eng-row.is-live > i:first-child { color: var(--mv-accent); }
  .as-eng-row.is-win > i:first-child { color: var(--mv-green); }
  .as-eng-row.is-win .as-eng-name { color: var(--mv-label); font-weight: 700; }
  .as-eng-row.is-bad > i:first-child { color: var(--mv-red); }
  .as-eng-val { flex: none; font-size: 11.5px; font-family: var(--mv-font-tech); font-variant-numeric: tabular-nums; color: var(--mv-label-2); }
  .as-eng-row.is-win .as-eng-val { color: var(--mv-green-ink); font-weight: 650; }
  .as-eng-row.is-bad .as-eng-val { color: var(--mv-red-ink); }

  /* A finding, with its confidence said in a word and never only in a colour. */
  .as-find { align-self: stretch; padding: 10px 11px; border-radius: 12px;
             background: var(--mv-group); box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-group-edge); }
  .as-find-kicker { font-size: 10.5px; font-weight: 700; letter-spacing: .04em; color: var(--mv-label-3); }
  .as-find.is-sure .as-find-kicker { color: var(--mv-red-ink); }
  .as-find.is-likely .as-find-kicker { color: var(--mv-orange-ink); }
  .as-find.is-ok .as-find-kicker { color: var(--mv-green-ink); }
  .as-find b { display: block; margin-top: 3px; font-size: 12.5px; font-weight: 700; line-height: 1.7; }
  .as-find small { display: block; margin-top: 3px; font-size: 11.5px; line-height: 1.8; color: var(--mv-label-2); }
  .as-fix { display: flex; flex-direction: column; gap: 6px; align-self: stretch; }
  .as-fix .mv-btn { justify-content: flex-start; text-align: start; }
  .as-raw { align-self: stretch; margin: 0; padding: 8px 10px; border-radius: 9px; max-height: 110px; overflow: auto;
            font-family: var(--mv-font-mono); font-size: 11px; line-height: 1.7; direction: ltr; text-align: left;
            color: var(--mv-label-2); background: var(--mv-fill); white-space: pre-wrap; word-break: break-word; }

  .as-spin { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
  .as-spin::before {
    content: '' !important; display: block; box-sizing: border-box; width: .82em; height: .82em;
    border: .14em solid currentColor; border-top-color: transparent; border-radius: 50%;
    animation: as-spin .8s linear infinite;
  }
  html[data-motion="reduced"] .as-spin::before { animation: none; }

  @media (max-width: 460px) { .as-card { width: calc(100vw - 36px); } }
</style>`;

    const NEURAL = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path class="as-edge" d="M6 7 L12 12 L18 7 M6 17 L12 12 L18 17 M6 7 L6 17 M18 7 L18 17"></path>
        <circle class="as-node is-a" cx="6" cy="7" r="2"></circle>
        <circle class="as-node is-b" cx="18" cy="7" r="2"></circle>
        <circle class="as-node is-c" cx="6" cy="17" r="2"></circle>
        <circle class="as-node is-d" cx="18" cy="17" r="2"></circle>
        <circle class="as-node" cx="12" cy="12" r="2.6"></circle>
      </svg>`;

    // ── Mount ──────────────────────────────────────────────────────────────
    function mount() {
        if ($('mv-assistant')) return;
        const host = document.createElement('div');
        host.id = 'mv-assistant';
        host.className = 'as-root';
        host.hidden = true;
        host.innerHTML = `
      <div class="as-card" id="as-card" hidden role="dialog" aria-label="دستیار MLM VPN">
        <div class="as-head">
          <span class="as-avatar">${NEURAL}</span>
          <div class="as-id"><b>دستیار MLM VPN</b><small id="as-sub">آمادهٔ کمک</small></div>
          <button type="button" class="mv-tb-btn" id="as-home" title="منوی اصلی" aria-label="منوی اصلی" hidden><i class="ph-bold ph-house"></i></button>
          <button type="button" class="mv-tb-btn" id="as-close" title="بستن" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
        </div>
        <div class="as-body custom-scrollbar" id="as-body"></div>
      </div>
      <button type="button" class="as-orb" id="as-orb" title="دستیار MLM VPN" aria-label="دستیار MLM VPN">
        <span class="as-ring" aria-hidden="true"></span>
        ${NEURAL}
        <span class="as-badge" id="as-badge" hidden>۱</span>
      </button>`;
        document.body.appendChild(host);
        document.head.insertAdjacentHTML('beforeend', CSS);

        $('as-orb').addEventListener('click', () => (st.open ? close() : openSmart()));
        $('as-close').addEventListener('click', close);
        $('as-home').addEventListener('click', goHome);
    }

    function open() {
        st.open = true;
        $('as-card').hidden = false;
        $('as-badge').hidden = true;
        paint();
    }

    /**
     * What pressing the orb does.
     *
     * THE ORB IS ALWAYS THERE. The first version showed the whole assistant only when it had
     * something to say, so the moment you answered its one question it vanished — and with it
     * every other thing it can do. An assistant you can only reach by already having a pending
     * job is not an assistant.
     */
    function openSmart() {
        show();
        open();
        // A conversation that is still going, or a result worth coming back to, is shown as it
        // is. A FINISHED one is not: reopening after «نه» used to show the dead transcript with
        // no buttons under it, which reads as broken.
        const LIVE = ['offer', 'decay', 'pick', 'count', 'mode', 'ask-engines', 'racing', 'race-done', 'run', 'done',
            'trouble', 'diagnosing', 'diag-done'];
        if (LIVE.indexOf(st.step) >= 0) return;
        if (findOffer(false)) { offerIfAny(true); return; }
        st.step = 'home';
        st.msgs = [{ who: 'bot', html: 'چه کاری برایتان بکنم؟' }];
        paint();
    }

    function close() {
        // Closing the card never cancels a run — the orb keeps spinning and the badge comes back
        // when it finishes. Hiding a window is not the same as saying «stop».
        st.open = false;
        $('as-card').hidden = true;
    }

    function show() { const h = $('mv-assistant'); if (h) h.hidden = false; }

    function busy(on) {
        const h = $('mv-assistant');
        if (h) h.classList.toggle('is-busy', !!on);
    }

    function sub(text) { const e = $('as-sub'); if (e) e.textContent = text; }

    // ── The conversation ───────────────────────────────────────────────────
    function say(html, who) { st.msgs.push({ who: who || 'bot', html }); paint(); }

    /** A line that arrives after a beat, with the dots showing — so the assistant reads as alive. */
    async function saysSlowly(html, ms) {
        st.typing = true; paint();
        await sleep(ms || 620);
        st.typing = false;
        say(html, 'bot');
    }

    /** A job that owns the card until it ends. Each already has its own «توقف».  */
    function liveJob() {
        return st.running || st.step === 'racing' || st.step === 'diagnosing';
    }

    /**
     * Back to «چه کاری برایتان بکنم؟».
     *
     * The transient state of whatever was on screen is dropped, because coming back to a
     * half-read trouble card or a stale verdict is worse than starting clean. `st.offer` is
     * kept: it is read from storage, not from the conversation, and the picker re-reads it.
     */
    function goHome() {
        if (liveJob()) return;          // the button is hidden then, but never trust the DOM
        st.trouble = null;
        st.diag = null;
        st.race = null;
        st.pick = null;
        st.step = 'home';
        st.msgs = [{ who: 'bot', html: 'چه کاری برایتان بکنم؟' }];
        sub('آمادهٔ کمک');
        paint();
    }

    function paint() {
        const body = $('as-body');
        if (!body || !st.open) return;
        const home = $('as-home');
        if (home) home.hidden = st.step === 'home' || liveJob();
        let h = st.msgs.map(m => `<div class="as-msg is-${m.who === 'me' ? 'me' : 'bot'}">${m.html}</div>`).join('');
        if (st.typing) h += `<div class="as-dots"><i></i><i></i><i></i></div>`;
        h += controls();
        body.innerHTML = h;
        wire(body);
        body.scrollTop = body.scrollHeight;
    }

    function controls() {
        if (st.typing) return '';
        if (st.step === 'offer') {
            return `<div class="as-act">
                <button type="button" class="mv-btn mv-btn--primary" data-as="yes">بله، ترکیب کن</button>
                <button type="button" class="mv-btn" data-as="no">نه، ممنون</button>
              </div>`;
        }
        if (st.step === 'trouble') {
            const t = st.trouble || {};
            const fixes = TROUBLE[t.kind] ? TROUBLE[t.kind].fixes(t) : [];
            return (t.raw ? `<pre class="as-raw">${esc(t.raw)}</pre>` : '')
                + `<div class="as-fix">${fixes.map(f =>
                    `<button type="button" class="mv-btn${f.primary ? ' mv-btn--primary' : ''}" data-as="fix" data-f="${esc(f.id)}">${esc(f.label)}</button>`
                  ).join('')}</div>`;
        }
        if (st.step === 'diagnosing') {
            const d = st.diag || {};
            return `<div class="as-stages">
                <div class="as-stage is-active"><i class="as-spin"></i><span class="as-stage-text">${esc(d.phase || 'در حال بررسی…')}</span>
                  <span class="as-stage-note">${num(fa(Math.round(d.percent || 0)) + '٪')}</span></div>
                <div class="as-bar"><div style="width:${Math.round(d.percent || 0)}%"></div></div>
              </div>
              <div class="as-act"><button type="button" class="mv-btn" data-as="diag-stop">توقف</button></div>`;
        }
        if (st.step === 'diag-done') {
            const d = st.diag || {};
            const h = d.headline || {};
            const cls = h.tone === 'sure' ? ' is-sure' : h.tone === 'likely' ? ' is-likely' : h.tone === 'ok' ? ' is-ok' : '';
            const offers = (d.offers || []).filter(o => !((d.applied || {})[o.repairId]));
            return `<div class="as-find${cls}">
                <div class="as-find-kicker">${esc(h.kicker || 'نتیجه')}</div>
                <b>${esc(h.title || '')}</b>
                ${h.sub ? `<small>${esc(h.sub)}</small>` : ''}
              </div>`
              + (offers.length ? `<div class="as-fix">${offers.map(o =>
                    `<button type="button" class="mv-btn mv-btn--primary" data-as="repair" data-r="${esc(o.repairId)}">${esc(o.label || o.repairId)}</button>`
                 ).join('')}</div>` : '')
              + `<div class="as-act">
                   <button type="button" class="mv-btn" data-as="diag-open">دیدن کامل گزارش</button>
                   <button type="button" class="mv-btn" data-as="diag-again">دوباره بررسی کن</button>
                 </div>`;
        }
        if (st.step === 'home') {
            // No «ترکیب کانفیگ‌ها با آی‌پی تمیز» entry beside «اسکن و ترکیب کانفیگ‌ها»: the picker
            // lists every group including the one that just arrived, so the second button led to
            // a narrower version of the same thing. The proactive offer a panel triggers is
            // untouched — that one interrupts with a specific group and is worth its own card.
            return `<div class="as-modes">
                <button type="button" class="as-mode" data-as="ask-engines" style="--tint:var(--mv-teal)">
                  <i class="ph-fill ph-medal"></i>
                  <span><b>کدام موتور برای خط من؟</b><small>هر موتور را روی خط خودتان امتحان می‌کنم و می‌گویم کدام جواب داد.</small></span>
                </button>
                <button type="button" class="as-mode" data-as="ask-diag" style="--tint:var(--mv-red)">
                  <i class="ph-fill ph-stethoscope"></i>
                  <span><b>اینترنتم مشکل دارد</b><small>می‌گردم، و هرچه از این‌جا قابل درست کردن باشد خودم درست می‌کنم.</small></span>
                </button>
                <button type="button" class="as-mode" data-as="ask-pick" style="--tint:var(--mv-indigo, var(--mv-blue))">
                  <i class="ph-fill ph-scan"></i>
                  <span><b>اسکن و ترکیب کانفیگ‌ها</b><small>از کانفیگ‌های «زیرساخت ابری» انتخاب کنید؛ آی‌پی تمیز پیدا می‌کنم و به همان تعدادی که بخواهید تحویل می‌دهم.</small></span>
                </button>
              </div>`;
        }
        if (st.step === 'ask-engines') {
            return `<div class="as-act">
                <button type="button" class="mv-btn mv-btn--primary" data-as="race-go">شروع کن</button>
                <button type="button" class="mv-btn" data-as="race-no">حالا نه</button>
              </div>`;
        }
        if (st.step === 'racing' || st.step === 'race-done') {
            const rows = (st.race && st.race.rows) || [];
            const best = st.step === 'race-done' ? rows.filter(r => r.ok).sort((a, b) => a.ms - b.ms)[0] : null;
            const body = `<div class="as-eng">${rows.map(r => {
                const cls = r.state === 'live' ? ' is-live' : (best && r.id === best.id) ? ' is-win' : r.ok === false ? ' is-bad' : '';
                const icon = r.state === 'live' ? '<i class="as-spin"></i>'
                    : r.ok === true ? '<i class="ph-bold ph-check"></i>'
                    : r.ok === false ? '<i class="ph-bold ph-x"></i>'
                    : '<i class="ph-bold ph-circle"></i>';
                const val = r.ok === true ? num(fa(r.ms) + ' ms')
                    : r.ok === false ? esc(r.short || 'جواب نداد')
                    : r.state === 'live' ? (r.connectMs ? num(fa(Math.round(r.connectMs / 1000)) + ' s') : 'در حال اتصال…') : '';
                return `<div class="as-eng-row${cls}">${icon}<span class="as-eng-name">${esc(r.fa)}</span><span class="as-eng-val">${val}</span></div>`;
            }).join('')}</div>`;
            if (st.step === 'racing') {
                return body + `<div class="as-act"><button type="button" class="mv-btn" data-as="race-stop">توقف</button></div>`;
            }
            return body + (best
                ? `<div class="as-act">
                     <button type="button" class="mv-btn mv-btn--primary" data-as="race-open" data-e="${esc(best.id)}">وصل شدن به ${esc(best.fa)}</button>
                     <button type="button" class="mv-btn" data-as="race-again">دوباره بسنج</button>
                   </div>`
                : `<div class="as-act"><button type="button" class="mv-btn" data-as="race-again">دوباره بسنج</button></div>`);
        }
        if (st.step === 'decay') {
            return st.decay && st.decay.raws
                ? `<div class="as-act">
                <button type="button" class="mv-btn mv-btn--primary" data-as="refresh">بله، تازه‌شان کن</button>
                <button type="button" class="mv-btn" data-as="decay-no">فعلاً نه</button>
              </div>`
                : `<div class="as-act">
                <button type="button" class="mv-btn mv-btn--primary" data-as="open-cloud">باز کردن زیرساخت ابری</button>
                <button type="button" class="mv-btn" data-as="decay-no">باشد</button>
              </div>`;
        }
        if (st.step === 'pick') {
            const p = st.pick || { list: [], on: {} };
            const chosen = p.list.filter(x => p.on[x.id]);
            const total = chosen.reduce((a, x) => a + x.configs.length, 0);
            return `<div class="as-picks custom-scrollbar">${p.list.map(x => `
                <button type="button" class="as-pick${p.on[x.id] ? ' is-on' : ''}" data-as="pick" data-i="${esc(x.id)}">
                  <i class="${p.on[x.id] ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>
                  <span><b>${esc(x.label)}</b><small>${num(fa(x.configs.length))} کانفیگ خام${x.email ? ' · ' + num(esc(x.email)) : ''}${x.done ? ' · قبلاً ترکیب شده' : ''}</small></span>
                </button>`).join('')}</div>`
              + (chosen.length
                ? `<div class="as-act"><button type="button" class="mv-btn mv-btn--primary" data-as="pick-go">ادامه — ${num(fa(total))} کانفیگ خام</button></div>`
                : '<div class="as-hint">دست‌کم یکی را انتخاب کنید.</div>');
        }
        if (st.step === 'no-configs') {
            return `<div class="as-act">
                <button type="button" class="mv-btn mv-btn--primary" data-as="go-cloud">باز کردن زیرساخت ابری</button>
              </div>`;
        }
        if (st.step === 'count') {
            const max = st.offer ? st.offer.configs.length * 400 : 1000;
            return `<div class="as-chips">
                ${[20, 50, 100, 200].map(n => `<button type="button" class="as-chip" data-as="count" data-n="${n}">${fa(n)}</button>`).join('')}
              </div>
              <div class="as-count">
                <input type="number" id="as-want" min="1" max="${max}" placeholder="مثلاً ۵۰" dir="ltr" />
                <button type="button" class="mv-btn mv-btn--primary" data-as="count-go">ادامه</button>
              </div>`;
        }
        if (st.step === 'mode') {
            return `<div class="as-modes">
                ${Object.values(MODES).map(m => `
                <button type="button" class="as-mode" data-as="mode" data-m="${m.id}" style="--tint:${m.tint}">
                  <i class="${m.icon}"></i>
                  <span><b>${esc(m.label)}</b><small>${esc(m.blurb)}</small></span>
                </button>`).join('')}
              </div>`;
        }
        if (st.step === 'run') {
            return `<div class="as-stages">${st.stages.map(stage => `
                <div class="as-stage is-${stage.state}">
                  <i class="${stage.state === 'done' ? 'ph-bold ph-check' : stage.state === 'active' ? 'as-spin' : 'ph-bold ph-circle'}"></i>
                  <span class="as-stage-text">${esc(stage.label)}</span>
                  ${stage.note ? `<span class="as-stage-note">${stage.note}</span>` : ''}
                </div>
                ${stage.state === 'active' ? `<div class="as-bar${stage.pct == null ? ' is-idle' : ''}"><div style="width:${stage.pct == null ? '' : stage.pct + '%'}"></div></div>` : ''}
              `).join('')}</div>
              <div class="as-act"><button type="button" class="mv-btn" data-as="stop">توقف</button></div>`;
        }
        if (st.step === 'done') {
            return `<div class="as-act">
                <button type="button" class="mv-btn mv-btn--primary" data-as="copy"><i class="ph-bold ph-copy"></i> کپی کانفیگ‌های تمیز</button>
              </div>
              <div class="as-act">
                <button type="button" class="mv-btn" data-as="v2ray"><i class="ph-bold ph-paper-plane-tilt"></i> انتقال به پنل V2Ray</button>
                <button type="button" class="mv-btn" data-as="again">یک بار دیگر</button>
              </div>`;
        }
        return '';
    }

    function wire(root) {
        root.querySelectorAll('[data-as]').forEach(b => {
            b.addEventListener('click', () => act(b.getAttribute('data-as'), b));
        });
        const want = $('as-want');
        if (want) {
            want.addEventListener('keydown', (e) => { if (e.key === 'Enter') act('count-go'); });
            setTimeout(() => { try { want.focus(); } catch (e) {} }, 30);
        }
    }

    // ── What the buttons do ────────────────────────────────────────────────
    async function act(what, btn) {
        if (what === 'no') {
            markSeen(st.offer && st.offer.id);
            say('نه، ممنون', 'me');
            st.step = 'idle';
            await saysSlowly('باشد. هر وقت خواستید، همین‌جا هستم.');
            setTimeout(close, 1400);
            return;
        }
        if (what === 'fix' && btn) {
            const t = st.trouble || {};
            const f = (TROUBLE[t.kind] ? TROUBLE[t.kind].fixes(t) : []).find(x => x.id === btn.getAttribute('data-f'));
            if (!f) return;
            say(f.label, 'me');
            await f.run();
            return;
        }
        if (what === 'diag-stop') {
            try { await ndReq('cancel', { sessionId: st.diag && st.diag.sessionId }); } catch (e) { /* it may have just finished */ }
            return;
        }
        if (what === 'diag-again') { st.msgs = []; st.step = 'idle'; runDiagnosis(); return; }
        if (what === 'diag-open') {
            if (window.MV && MV.wm) MV.wm.open('netdiag');
            return;
        }
        if (what === 'repair' && btn) {
            const id = btn.getAttribute('data-r');
            const o = (st.diag.offers || []).find(x => x.repairId === id);
            if (!o) return;
            say(o.label || id, 'me');
            await applyRepair(o);
            return;
        }
        if (what === 'ask-diag') { say('اینترنتم مشکل دارد', 'me'); await runDiagnosis(); return; }
        if (what === 'ask-pick') {
            say('اسکن و ترکیب کانفیگ‌ها', 'me');
            const list = pickList();
            if (!list.length) {
                st.step = 'no-configs';
                await saysSlowly('هنوز هیچ کانفیگی در «زیرساخت ابری» ندارید. اول از یکی از پنل‌ها کانفیگ بگیرید — بعد از همین‌جا ترکیبشان می‌کنم.');
                return;
            }
            st.pick = { list: list, on: {} };
            st.step = 'pick';
            await saysSlowly('کدام کانفیگ‌ها را برایتان ترکیب کنم؟ هر تعداد که بخواهید — با هم ترکیب می‌شوند و هر آی‌پی تمیز، به تعداد کانفیگ‌های انتخاب‌شده خروجی می‌دهد.');
            return;
        }
        if (what === 'pick' && btn) {
            if (!st.pick) return;
            const id = btn.getAttribute('data-i');
            st.pick.on[id] = !st.pick.on[id];
            paint();
            return;
        }
        if (what === 'pick-go') {
            const p = st.pick;
            if (!p) return;
            const chosen = p.list.filter(x => p.on[x.id]);
            if (!chosen.length) return;

            // One offer built out of several groups. `srcOf` runs parallel to `configs` so
            // that every finished node can be written back under the group it actually came
            // from — otherwise combining three groups at once would mark only one of them.
            const configs = [];
            const srcOf = [];
            chosen.forEach(x => x.configs.forEach(c => { configs.push(c); srcOf.push(x.name); }));
            st.offer = {
                id: 'pick:' + chosen.map(x => x.id).join('+'),
                name: chosen.length === 1 ? chosen[0].name : chosen.map(x => x.name).join(' + '),
                label: chosen.length === 1 ? chosen[0].label : fa(chosen.length) + ' گروه از زیرساخت ابری',
                email: chosen.length === 1 ? chosen[0].email : null,
                configs: configs,
                srcOf: srcOf,
                memberIds: chosen.map(x => x.id),
            };
            say(chosen.map(x => x.label).join(' + '), 'me');
            st.step = 'count';
            await saysSlowly(`چند کانفیگ ترکیب‌شده می‌خواهید؟ با <b class="as-num">${fa(configs.length)}</b> کانفیگ خامی که انتخاب کردید، هر آی‌پی تمیز <b class="as-num">${fa(configs.length)}</b> کانفیگ می‌سازد.`);
            return;
        }
        if (what === 'go-cloud') {
            say('باز کردن زیرساخت ابری', 'me');
            await saysSlowly('باز می‌کنم — «دریافت کانفیگ» را که زدید، از همین‌جا ادامه می‌دهیم.');
            await sleep(320);
            if (window.MV && MV.wm) MV.wm.open('cloud');
            st.step = 'idle';
            return;
        }
        if (what === 'ask-engines') {
            say('کدام موتور برای خط من؟', 'me');
            st.step = 'ask-engines';
            await saysSlowly('هر موتور را یکی‌یکی بالا می‌آورم، یک درخواست واقعی از داخلش می‌فرستم و دوباره خاموشش می‌کنم — بعد می‌گویم کدام‌ها روی <b>خط امشب شما</b> جواب دادند و کدام نه.');
            await saysSlowly('<b>به مسیر سیستم دست نمی‌زنم:</b> هیچ موتوری تونل کامل نمی‌گیرد و DNS ویندوز عوض نمی‌شود. فقط چند دقیقه طول می‌کشد — تور به‌تنهایی می‌تواند دو دقیقه بگیرد.');
            return;
        }
        if (what === 'race-no') {
            say('حالا نه', 'me');
            st.step = 'idle';
            await saysSlowly('باشد. هر وقت خواستید از همین‌جا بسنجیم.');
            setTimeout(close, 1400);
            return;
        }
        if (what === 'race-go') {
            say('شروع کن', 'me');
            st.step = 'racing';
            await saysSlowly('شروع کردم. می‌توانید کارت را ببندید — وقتی تمام شد خبرتان می‌کنم.');
            raceEngines().catch(err => fail(err && err.message));
            return;
        }
        if (what === 'race-stop') {
            if (st.race) st.race.aborted = true;
            sub('در حال توقف…');
            try { await fetch('/api/engines/probe/stop', { method: 'POST' }); } catch (e) {}
            return;
        }
        if (what === 'race-again') { st.msgs = []; st.race = null; st.step = 'home'; paint(); return; }
        if (what === 'race-open' && btn) {
            const id = btn.getAttribute('data-e');
            say('وصل شدن', 'me');
            await saysSlowly('پنجره‌اش را باز می‌کنم — دکمهٔ گرد را بزنید و وصل می‌شوید.');
            await sleep(320);
            if (window.MV && MV.wm) MV.wm.open(ENGINE_APP[id] || id);
            return;
        }
        if (what === 'decay-no') {
            markSeen('decay:' + (st.decay && st.decay.group && st.decay.group.id));
            say('فعلاً نه', 'me');
            st.step = 'idle';
            await saysSlowly('باشد. هر وقت خواستید، از همین‌جا تازه‌شان می‌کنم.');
            setTimeout(close, 1500);
            return;
        }
        if (what === 'open-cloud') {
            markSeen('decay:' + (st.decay && st.decay.group && st.decay.group.id));
            say('باز کردن زیرساخت ابری', 'me');
            await saysSlowly('باز می‌کنم — «دریافت کانفیگ» را که زدید، خودم پیشنهاد ترکیب می‌دهم.');
            await sleep(320);
            if (window.MV && MV.wm) MV.wm.open('cloud');
            st.step = 'idle';
            return;
        }
        if (what === 'refresh') {
            const d = st.decay;
            if (!d || !d.raws) return;
            say('بله، تازه‌شان کن', 'me');
            markSeen('decay:' + d.group.id);
            // Nothing is asked twice: the count and the priority are what the set was made with.
            const md = d.group.metadata || {};
            st.offer = { id: md.baseId || d.group.id, name: (d.group.nodes[0] && d.group.nodes[0].sni) || d.group.title, label: md.label || d.group.title || 'همان پنل', email: null, configs: d.raws };
            st.want = d.group.nodes.length;
            st.mode = MODES[md.mode] || MODES.stable;
            st.step = 'run';
            await saysSlowly(`همان <b class="as-num">${fa(st.want)}</b> تا را با معیار <b>${esc(st.mode.label)}</b> دوباره می‌سازم — چیزی نپرسیدم چون همان‌هایی است که بار اول انتخاب کردید.`);
            run().catch(err => fail(err && err.message));
            return;
        }
        if (what === 'yes') {
            say('بله، ترکیب کن', 'me');
            st.step = 'count';
            await saysSlowly(`چند کانفیگ ترکیب‌شده می‌خواهید؟ با <b class="as-num">${fa(st.offer.configs.length)}</b> کانفیگ خامی که دارید، هر آی‌پی تمیز <b class="as-num">${fa(st.offer.configs.length)}</b> کانفیگ می‌سازد.`);
            return;
        }
        if (what === 'count' && btn) { setWant(+btn.getAttribute('data-n')); return; }
        if (what === 'count-go') { const el = $('as-want'); setWant(el ? +el.value : 0); return; }
        if (what === 'mode' && btn) {
            const m = MODES[btn.getAttribute('data-m')];
            if (!m) return;
            st.mode = m;
            say(esc(m.label), 'me');
            st.step = 'run';
            await saysSlowly(`باشد — <b>${esc(m.label)}</b>. شروع می‌کنم؛ لازم نیست جایی بروید، همین‌جا گزارش می‌دهم.`);
            run().catch(err => fail(err && err.message));
            return;
        }
        if (what === 'stop') { st.cancelled = true; sub('در حال توقف…'); return; }
        if (what === 'copy') {
            if (typeof window.copyText === 'function') window.copyText(st.result.join('\n'));
            else navigator.clipboard.writeText(st.result.join('\n'));
            say(`<i class="ph-bold ph-check"></i> ${fa(st.result.length)} کانفیگ کپی شد.`, 'bot');
            return;
        }
        if (what === 'v2ray') { await toV2ray(); return; }
        if (what === 'again') {
            st.msgs = []; st.result = []; st.want = 0; st.mode = null;
            const o = findOffer(true);
            if (o) { st.offer = o; st.step = 'offer'; offerLine(); }
            else { st.step = 'idle'; await saysSlowly('کانفیگ خام تازه‌ای نمانده. اول از یکی از پنل‌ها کانفیگ بگیرید.'); }
            return;
        }
    }

    async function setWant(n) {
        const max = st.offer.configs.length * 400;
        if (!(n > 0)) { await saysSlowly('یک عدد بزرگ‌تر از صفر وارد کنید.'); return; }
        if (n > max) { await saysSlowly(`بیشتر از <b class="as-num">${fa(max)}</b> از این تعداد کانفیگ خام در نمی‌آید. عدد کمتری وارد کنید.`); return; }
        st.want = n;
        say(`${fa(n)} کانفیگ`, 'me');
        st.step = 'mode';
        const ips = Math.ceil(n / st.offer.configs.length);
        await saysSlowly(`برای <b class="as-num">${fa(n)}</b> کانفیگ، <b class="as-num">${fa(ips)}</b> آی‌پی تمیز لازم است. چه چیزی برایتان مهم‌تر است؟`);
    }

    // ── The offer ──────────────────────────────────────────────────────────
    function seen() {
        try { return JSON.parse(store(SEEN_KEY) || '[]'); } catch (e) { return []; }
    }
    function markSeen(id) {
        if (!id) return;
        const list = seen();
        if (!list.includes(id)) { list.push(id); store(SEEN_KEY, JSON.stringify(list.slice(-60))); }
    }

    function bases() {
        try { return JSON.parse(store('cf_base_configs') || '[]'); } catch (e) { return []; }
    }
    function comboGroups() {
        try { return JSON.parse(store('ipscanner_combo_groups') || '[]'); } catch (e) { return []; }
    }

    /**
     * A group worth offering: raw configs that arrived from a panel and have not been combined.
     * "Combined" is read from the combination centre's own store, so a group the user combined
     * by hand is never offered again either.
     */
    /**
     * Everything in «زیرساخت ابری», for the user to choose from.
     *
     * Deliberately NOT findOffer's filter: that one answers «is there something new worth
     * interrupting for», so it hides what was already combined or already declined. Here the
     * user came asking, so nothing is hidden — a group that was combined before is listed and
     * simply says so, because rebuilding one against fresh addresses is a normal thing to want.
     */
    function pickList() {
        const combinedNames = new Set();
        comboGroups().forEach(g => (g.nodes || []).forEach(n => n.sni && combinedNames.add(n.sni)));
        return bases().map(b => {
            const configs = Array.isArray(b.configs) ? b.configs.filter(c => typeof c === 'string' && c.trim()) : [];
            if (!configs.length) return null;
            const who = resolveSource(b);
            return {
                id: b.id,
                name: b.name || 'پنل ابری',
                label: who.label,
                email: who.email,
                configs: configs,
                done: combinedNames.has(b.name),
            };
        }).filter(Boolean);
    }

    function findOffer(ignoreSeen) {
        const combinedNames = new Set();
        comboGroups().forEach(g => (g.nodes || []).forEach(n => n.sni && combinedNames.add(n.sni)));
        const skip = ignoreSeen ? [] : seen();
        const list = bases().filter(b => b && Array.isArray(b.configs) && b.configs.length
            && !skip.includes(b.id) && !combinedNames.has(b.name));
        if (!list.length) return null;
        // saveBaseConfigGroup unshifts, so index 0 is the group that just arrived — which is
        // the one the user is looking at. Taking the tail offered the oldest one instead.
        const b = list[0];
        const who = resolveSource(b);
        return {
            id: b.id,
            // `name` stays the group's own identifier — saveToCombo writes it as each node's sni
            // and findOffer dedups against it, so it must not become a shared label.
            name: b.name || 'پنل ابری',
            label: who.label,
            email: who.email,
            configs: b.configs.filter(c => typeof c === 'string' && c.trim()),
        };
    }

    /**
     * Which panel, and whose account.
     *
     * saveBaseConfigGroup names a group after the WORKER URL, which is what the user sees when
     * something says «data-stream-cb362c.<account>.workers.dev» — an address, not an answer.
     * The panel is in the metadata (the same three keys sendCloudConfigsToV2ray reads for its
     * tag), and the account is found by matching the worker against cf_accounts.
     */
    function resolveSource(b) {
        const md = b.metadata || {};
        let accs = [];
        try { accs = JSON.parse(store('cf_accounts') || '[]'); } catch (e) { accs = []; }
        const host = String(b.name || '').replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
        const owns = (u) => !!(host && u && String(u).toLowerCase().indexOf(host) >= 0);

        let panel = null, acc = null;
        if (md.zeusUsername || md.zeusUrl || md.zeusAccId) {
            panel = 'Zeus';
            acc = accs.find(a => a.id === md.zeusAccId) || accs.find(a => owns(a.zeusUrl));
        } else if (md.edgeUuid || md.edgeUrl || md.edgeAccId) {
            panel = 'Edge';
            acc = accs.find(a => a.id === md.edgeAccId) || accs.find(a => owns(a.edgeUrl));
        } else if (md.isBpb) {
            panel = 'BPB';
            acc = accs.find(a => owns(a.url));
        } else {
            // No metadata at all (an older group, or a panel added since): ask the accounts.
            acc = accs.find(a => owns(a.url)); if (acc) panel = 'BPB';
            if (!panel) { acc = accs.find(a => owns(a.edgeUrl)); if (acc) panel = 'Edge'; }
            if (!panel) { acc = accs.find(a => owns(a.zeusUrl)); if (acc) panel = 'Zeus'; }
        }

        let label = panel ? 'پنل ' + panel : null;
        if (label && md.zeusUsername) label += ' (کاربر ' + md.zeusUsername + ')';
        // Last resort: the group's own name — which is the worker address unless the user
        // renamed it, and a name they chose is better than any guess.
        if (!label) label = b.name || 'پنل ابری';
        return { label, email: (acc && (acc.email || acc.name)) || null };
    }

    function offerLine() {
        st.msgs.push({
            who: 'bot',
            html: `<b class="as-num">${fa(st.offer.configs.length)}</b> کانفیگ تازه از <b>${esc(st.offer.label)}</b> دریافت کرده‌اید`
                + (st.offer.email ? `، از حساب <bdi dir="ltr" class="as-num">${esc(st.offer.email)}</bdi>` : '')
                + ` — که هنوز با آی‌پی تمیز ترکیب نشده‌اند.<br>می‌خواهید برایتان ترکیبشان کنم؟`,
        });
        paint();
    }

    /** Called by the panels when they store new configs, and by the slow watcher below. */
    function offerIfAny(force) {
        if (store(OFF_KEY) === '1') return;
        // NEVER INTERRUPT A CONVERSATION THAT IS UNDER WAY. The slow sweep used to reset the
        // thread to the opening question while the user was picking a number, because it only
        // checked for `step === 'run'` — every fifteen seconds, the questions started again.
        if (st.running || st.step === 'count' || st.step === 'mode' || st.step === 'run'
            || st.step === 'ask-engines' || st.step === 'racing' || st.step === 'race-done'
            || st.step === 'trouble' || st.step === 'diagnosing' || st.step === 'diag-done') return;
        const o = findOffer(false);
        if (!o) return;
        if (st.step === 'offer' && st.offer && st.offer.id === o.id) return;
        st.offer = o;
        st.step = 'offer';
        st.msgs = [];
        offerLine();
        show();
        if (force !== false) {
            open();
        } else {
            $('as-badge').hidden = false;
        }
    }

    // ── The run ────────────────────────────────────────────────────────────
    function setStages(list) { st.stages = list; paint(); }

    /** One isolated left-to-right run, so a number never merges with the number beside it. */
    const num = (t) => `<bdi dir="ltr">${esc(t)}</bdi>`;
    function stage(key, state, note, pct) {
        const s = st.stages.find(x => x.key === key);
        if (!s) return;
        if (state) s.state = state;
        s.note = note == null ? s.note : note;
        s.pct = pct === undefined ? s.pct : pct;
        paint();
    }

    function fail(msg) {
        busy(false);
        st.running = false;
        st.step = 'idle';
        say(`کار نیمه‌کاره ماند: ${esc(msg || 'خطای نامشخص')}. دوباره امتحان می‌کنید؟`, 'bot');
    }

    /**
     * TWO WORKERS, NOT FOUR STAGES IN A ROW.
     *
     * The first version scanned a whole batch, waited for it to finish, and only then started
     * testing — so the real test sat idle through the entire scan, and the scan sat idle through
     * the entire test. Now one worker keeps looking for clean addresses while the other takes
     * whatever has been found so far and puts it through the 100% real test. Both stop the
     * moment the target is reached.
     *
     * (It also stopped asking the server to scan three million addresses. The first version sent
     *  BOTH `cdns` and a list, and /api/scan then sampled the whole Cloudflare range and ignored
     *  the list. The list is the scan now, and it is a few thousand at a time.)
     */
    const BATCH_IPS = 4000;      // addresses per sweep — a few thousand is plenty
    const VERIFY_CHUNK = 40;     // how many go into the real test at once
    const MAX_DRY = 4;           // sweeps with nothing alive before the hunt gives up

    /**
     * Is the line itself working?
     *
     * /api/check-isp, which falls back to a bare TCP connect to 8.8.8.8:53 — so it answers
     * even when DNS is the thing that is broken, and it is the same probe the scanner page
     * uses before it starts.
     */
    async function lineAlive() {
        try {
            const r = await fetch('/api/check-isp');
            const d = await r.json().catch(() => ({}));
            return !!(r.ok && d && d.success);
        } catch (e) {
            return false;
        }
    }

    async function run() {
        st.running = true;
        st.cancelled = false;
        st.result = [];
        busy(true);
        sub('در حال کار…');

        const mode = st.mode;
        const raws = st.offer.configs;
        const needIps = Math.ceil(st.want / raws.length);

        setStages([
            { key: 'hunt', label: 'جست‌وجوی آی‌پی تمیز', state: 'wait' },
            { key: 'verify', label: mode.verifyWord, state: 'wait' },
            { key: 'combine', label: 'ترکیب و تحویل', state: 'wait' },
        ]);

        const queue = [];            // clean addresses waiting for the real test
        const good = [];             // the ones that passed it
        const tried = new Set();
        let hunting = true;
        let sweeps = 0;
        let dry = 0;

        const enough = () => good.length >= needIps || st.cancelled;

        // ── worker 1: keep finding clean addresses ──────────────────────────
        async function hunter() {
            while (!enough()) {
                // Do not run away from the tester: a couple of chunks in hand is plenty.
                if (queue.length > VERIFY_CHUNK * 3) { await sleep(400); continue; }
                sweeps++;
                stage('hunt', 'active', 'ساختن فهرست…', null);
                let ipsText = '';
                try { ipsText = await getIps(BATCH_IPS); } catch (e) { throw e; }
                if (enough()) break;
                if (!ipsText) throw new Error('فهرست آی‌پی کلودفلر گرفته نشد');

                const before = queue.length + good.length;
                await sweep(ipsText, mode, (fresh) => {
                    fresh.forEach(r => {
                        const key = r.ip + ':' + r.port;
                        if (tried.has(key)) return;
                        tried.add(key);
                        queue.push(r);
                    });
                }, () => enough());
                if (enough()) break;

                if (queue.length + good.length === before) {
                    dry++;
                    // A whole sweep with nothing alive is not bad luck. Measured on a working
                    // line, about a quarter of Cloudflare addresses accept a connection on 443
                    // at every concurrency we use — so zero out of four thousand means the
                    // line, not the batch. Saying «می‌گردم تا پیدا شود» to that is a promise
                    // the run cannot keep, and it was repeated forever.
                    if (dry === 1) {
                        await saysSlowly('این دسته آی‌پی سالمی نداشت؛ دستهٔ بعدی را می‌گیرم.');
                    } else if (dry === 2) {
                        await saysSlowly('دستهٔ دوم هم هیچ‌کدام جواب ندادند. این عادی نیست — بگذارید خودِ خط را امتحان کنم.');
                        if (!(await lineAlive())) { st.lineDown = true; st.cancelled = true; break; }
                        await saysSlowly('خط جواب می‌دهد، پس ایراد از این دسته‌ها بود. یک بار دیگر می‌گردم.');
                    } else if (dry >= MAX_DRY) {
                        st.dryOut = true; st.cancelled = true; break;
                    } else {
                        await saysSlowly(`دستهٔ ${fa(dry)} هم خالی بود. یک بار دیگر می‌گردم و اگر باز هم چیزی نبود، می‌گویم چه دیدم.`);
                    }
                } else {
                    dry = 0;
                }
            }
            hunting = false;
            stage('hunt', 'done', `${num(fa(tried.size))} آدرس بررسی شد`);
            try { await fetch('/api/stop', { method: 'POST' }); } catch (e) {}
            const t = tabs && tabs.find(x => x && x._assistant);
            if (t && t.state === 'running') t.state = 'done';
        }

        // ── worker 2: put what was found through the real test ──────────────
        async function tester() {
            while (!enough()) {
                if (!queue.length) {
                    if (!hunting) break;
                    await sleep(300);
                    continue;
                }
                const chunk = queue.splice(0, VERIFY_CHUNK);
                stage('verify', 'active', `${num(fa(good.length) + ' / ' + fa(needIps))} تأیید شد`,
                    Math.min(100, Math.round(good.length / needIps * 100)));
                const survivors = await verify(chunk, raws[0], mode);
                survivors.forEach(x => good.push(x));
                good.sort((a, b) => (mode.better === 'high' ? b.score - a.score : a.score - b.score));
                stage('verify', 'active', `${num(fa(Math.min(good.length, needIps)) + ' / ' + fa(needIps))} تأیید شد`,
                    Math.min(100, Math.round(good.length / needIps * 100)));
            }
            stage('verify', 'done', num(fa(Math.min(good.length, needIps)) + ' / ' + fa(needIps)));
        }

        await Promise.all([hunter(), tester()]);

        // A run that stopped because the line is dead, or because sweep after sweep came back
        // empty, is not the same as the user pressing «توقف» — and answering all three with
        // «باشد، نگه داشتم» is how the assistant ended up looking like it had simply given up.
        if (st.lineDown) {
            busy(false); st.running = false; st.lineDown = false;
            await saysSlowly(`<b>خط شما جواب نمی‌دهد.</b> ${num(fa(tried.size))} آدرس را امتحان کردم و هیچ‌کدام وصل نشد، و خودِ خط هم به آزمون مستقیم جواب نداد. تا این درست نشود، اسکن فقط وقت تلف می‌کند.`);
            trouble({ kind: 'no-internet', detail: 'در جست‌وجوی آی‌پی تمیز، هیچ آدرسی وصل نشد' });
            return;
        }
        if (st.dryOut) {
            busy(false); st.running = false; st.step = 'idle'; st.dryOut = false;
            await saysSlowly(`${num(fa(MAX_DRY))} دسته پشت سر هم گشتم — روی هم ${num(fa(tried.size))} آدرس — و هیچ‌کدام وصل نشد، در حالی که خودِ خط جواب می‌دهد.`);
            await saysSlowly('یعنی رسیدن به کلودفلر از این خط همین حالا بسته است. کمی بعد دوباره امتحان کنید، یا اول به یکی از موتورها وصل شوید و بعد از همین‌جا شروع کنید.');
            return;
        }
        if (st.cancelled) {
            busy(false); st.running = false; st.step = 'idle';
            await saysSlowly('باشد، نگه داشتم. هر وقت خواستید از همین‌جا دوباره شروع می‌کنیم.');
            return;
        }

        // ── combine and deliver exactly what was asked for ──────────────────
        stage('combine', 'active', '', null);
        const out = [];
        const outSrc = [];                       // which base group each config came from
        const srcs = st.offer.srcOf || null;     // set only when several groups were picked
        const picked = good.slice(0, needIps);
        for (const g of picked) {
            for (let j = 0; j < raws.length; j++) {
                if (out.length >= st.want) break;
                out.push(combineOne(raws[j], g.ip, g.port));
                outSrc.push(srcs ? srcs[j] : st.offer.name);
            }
            if (out.length >= st.want) break;
        }
        st.result = out;
        st.resultSrc = outSrc;
        st.groupId = saveToCombo(out, picked, mode);
        stage('combine', 'done', `${num(fa(out.length))} کانفیگ`);

        busy(false);
        st.running = false;
        st.step = 'done';
        sub('تمام شد');

        const best = picked[0];
        await saysSlowly(`تمام شد — <b class="as-num">${fa(out.length)}</b> کانفیگ تمیز آماده است.` +
            (best ? ` بهترینشان <span class="as-num" dir="ltr">${esc(best.ip)}</span> با <span class="as-num" dir="ltr">${fa(best.score)} ${esc(mode.unit)}</span> است.` : ''));
        await saysSlowly('یک نسخه هم در «مرکز ترکیب» ذخیره شد، پس اگر پنجره را ببندید چیزی از دست نمی‌رود.');
        if (typeof window.triggerNotification === 'function') {
            window.triggerNotification('assistantDone', 'دستیار MLM VPN', `${out.length} کانفیگ تمیز آماده شد و در مرکز ترکیب ذخیره شد.`);
        }
        if (!st.open) { $('as-badge').hidden = false; $('as-badge').textContent = '۱'; }
    }

    // ── Steps, each over an endpoint the app already has ───────────────────

    async function getIps(maxIps) {
        const r = await fetch('/api/get-ips', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cdns: ['cloudflare'], maxIps }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'خطای سرور');
        return d.ipsText || '';
    }

    /**
     * One sweep of the scanner, harvested WHILE it runs.
     *
     * NOT through startScan(): that reads the scanner page's own form and would overwrite what
     * the user has set up there. And `cdns` is deliberately empty — the address list built in
     * the step before IS the scan. Sending both made the server sample the whole Cloudflare
     * range instead, which is how a four-thousand-address sweep turned into three million.
     *
     * `onFresh` is called every time new live addresses appear, so the tester can start on them
     * long before the sweep finishes.
     */
    async function sweep(ipsText, mode, onFresh, shouldStop) {
        const tab = assistantTab();
        const count = ipsText.split('\n').filter(Boolean).length;
        tab.results = []; tab.tested = 0; tab.alive = 0; tab.dead = 0;
        tab.total = 0; tab.stage3Total = 0; tab.stage3Tested = 0;
        tab.status = '';
        tab.historyKey = 'scan_' + Date.now();
        tab.settings = Object.assign({}, tab.settings, {
            cdns: [], ports: mode.ports, concurrency: mode.concurrency,
            timeout: mode.timeout, maxIps: count, customInput: ipsText, finalTestCount: 0,
        });
        if (typeof tabs !== 'undefined') {
            tabs.forEach(t => { if (t !== tab && (t.state === 'running' || t.state === 'paused')) t.state = 'done'; });
        }
        tab.state = 'running';
        if (typeof window.renderTabs === 'function') window.renderTabs();

        const res = await fetch('/api/scan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pauseOnNetworkDown: true, resume: false,
                cdns: [], concurrency: mode.concurrency, timeout: mode.timeout,
                maxIps: count, ports: mode.ports, customInput: ipsText,
                // The assistant runs its own, richer verification next, so the scan's own
                // stage 3 is switched off rather than done twice.
                finalTestCount: 0, baseConfig: '',
            }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) { tab.state = 'idle'; throw new Error(d.error || 'اسکن شروع نشد'); }
        tab.total = d.total || 0;

        let cursor = 0;
        const harvest = () => {
            const rows = tab.results || [];
            if (cursor >= rows.length) return;
            const fresh = rows.slice(cursor).filter(r => r && r.alive && r.ip);
            cursor = rows.length;
            if (fresh.length) onFresh(fresh);
        };

        while (tab.state === 'running') {
            if (shouldStop && shouldStop()) break;
            await sleep(350);
            harvest();
            const pct = tab.total ? Math.min(100, Math.round(tab.tested / tab.total * 100)) : null;
            stage('hunt', 'active', `${num(fa(tab.tested || 0) + ' / ' + fa(tab.total || 0))} · ${num(fa(tab.alive || 0))} سالم`, pct);
        }
        harvest();
        if (tab.state === 'running') {
            try { await fetch('/api/stop', { method: 'POST' }); } catch (e) {}
            tab.state = 'done';
        }
    }

    /**
     * A scan tab of the assistant's own, built by hand.
     *
     * NOT createTab(): shell/boot.js shims that to open the scanner window, and the whole point
     * of the assistant is that nothing moves under the user while it works. The tab is pushed
     * straight onto the list — it shows up in the scanner's sidebar for anyone who wants to
     * watch, and it never becomes the active one, so no page changes.
     */
    function assistantTab() {
        if (typeof tabs === 'undefined') throw new Error('سیستم اسکن در دسترس نیست');
        let t = tabs.find(x => x && x._assistant);
        if (!t) {
            t = {
                id: 'assistant_' + Date.now(),
                isp: 'دستیار MLM VPN',
                settings: typeof defaultSettings === 'function' ? defaultSettings() : {},
                results: [], state: 'idle',
                total: 0, tested: 0, alive: 0, dead: 0,
                sortCol: 'realDelay', sortAsc: true,
                _assistant: true,
            };
            tabs.push(t);
            if (typeof window.renderTabs === 'function') window.renderTabs();
        }
        return t;
    }

    /**
     * Verify the clean IPs the way the chosen priority means.
     *
     * One raw config is rewritten onto each IP and measured through the real core — this is the
     * step that separates "the port answered" from "traffic actually passes", and it is where
     * the three priorities stop being labels:
     *   ping  → no core at all, one shot
     *   speed → KB/s through the core (xray-tester › realSpeed)
     *   delay → milliseconds, repeated `passes` times, all of which must succeed
     */
    async function verify(alive, rawConfig, mode) {
        let pool = alive.slice();
        const samples = new Map();     // key → [vals]

        for (let pass = 0; pass < mode.passes && pool.length && !st.cancelled; pass++) {
            const nodes = pool.map((r, i) => ({ id: String(i), uri: combineOne(rawConfig, r.ip, r.port) }));
            const got = new Map();
            let done = 0;
            await streamTest(nodes, mode.testType, (r) => {
                done++;
                stage('verify', 'active',
                    mode.passes > 1 ? `دور ${num(fa(pass + 1) + ' / ' + fa(mode.passes))} · ${num(fa(done) + ' / ' + fa(nodes.length))}` : num(fa(done) + ' / ' + fa(nodes.length)),
                    Math.round(done / nodes.length * 100));
                if (r && r.id != null) got.set(String(r.id), r.val);
            });
            const next = [];
            pool.forEach((r, i) => {
                const v = got.get(String(i));
                if (!(v > 0)) return;                       // a failure in ANY pass drops it
                const key = r.ip + ':' + r.port;
                samples.set(key, (samples.get(key) || []).concat(v));
                next.push(r);
            });
            pool = next;
        }

        return pool.map(r => {
            const vals = samples.get(r.ip + ':' + r.port) || [];
            if (!vals.length) return null;
            const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
            // Stability ranks by how little the number wandered; a rock-steady 300 ms beats a
            // 90-to-900 ms node whose average flatters it.
            const jitter = vals.length > 1 ? (Math.max.apply(null, vals) - Math.min.apply(null, vals)) : 0;
            return { ip: r.ip, port: r.port, score: Math.round(mode.passes > 1 ? mean + jitter * 2 : mean) };
        }).filter(Boolean);
    }

    /** POST to the node tester and read its newline-delimited stream as it arrives. */
    async function streamTest(nodes, testType, onResult) {
        const res = await fetch('/api/v2ray/test-nodes', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodes, testType, settings: { concurrency: 30 } }),
        });
        if (!res.body || !res.body.getReader) {
            const txt = await res.text();
            txt.split('\n').filter(Boolean).forEach(l => { try { onResult(JSON.parse(l)); } catch (e) {} });
            return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                let obj = null;
                try { obj = JSON.parse(line); } catch (e) { continue; }
                if (obj.done || obj.fatal) continue;
                onResult(obj);
            }
            if (st.cancelled) { try { reader.cancel(); } catch (e) {} break; }
        }
    }

    /** The same rewrite the combination centre does: swap the host for a clean IP, tag it. */
    function combineOne(raw, ip, port) {
        let out = String(raw).replace(/@([a-zA-Z0-9.\-]+):(\d+)/, '@' + ip + ':$2');
        if (out.includes('#')) out = out + encodeURIComponent(' [' + ip + ']');
        else out = out + '#' + ip;
        return out;
    }

    function saveToCombo(configs, picked, mode) {
        const groups = comboGroups();
        const id = 'combo_' + Date.now();
        const byIp = new Map(picked.map(p => [p.ip, p]));
        groups.unshift({
            id,
            title: `دستیار MLM VPN — ${st.offer.label}`,
            date: new Date().toLocaleString('fa-IR'),
            nodes: configs.map((c, i) => {
                const ip = (c.match(/@([\d.]+):/) || [])[1] || '';
                const p = byIp.get(ip);
                // The node's `sni` is the BASE GROUP it came from, not a display label —
                // findOffer and pickList both dedup against it, so when several groups are
                // combined in one run each one has to be named or only the first is marked.
                const sni = (st.resultSrc && st.resultSrc[i]) || st.offer.name;
                return { config: c, ip, sni, healthy: true, delay: p ? p.score : null };
            }),
            // What it took to make this, so it can be made again when the addresses die:
            // the raw configs themselves (a handful of URIs) and which base group they came from.
            metadata: {
                assistant: true, mode: mode.id, unit: mode.unit,
                baseId: st.offer.id, label: st.offer.label, raws: st.offer.configs.slice(0, 40),
            },
        });
        store('ipscanner_combo_groups', JSON.stringify(groups));
        (st.offer.memberIds || [st.offer.id]).forEach(markSeen);
        try {
            const sec = $('combo-archive-section');
            if (sec) sec.style.display = 'flex';
            if (typeof window.renderComboGroups === 'function') window.renderComboGroups();
        } catch (e) { /* the centre is not built yet; it reads the store when it opens */ }
        return id;
    }

    // ── The front door for everything that fails ───────────────────────────
    //
    // The rule this follows is the user's own: say WHAT WAS OBSERVED first, derive the advice
    // from the actual code rather than from a guess, and offer exactly one button per finding.
    // What is new is that most of those buttons now DO the thing instead of pointing at the
    // panel where the user could do it — the assistant can already race the engines, widen a
    // scan and rebuild a set of configs, and it can drive «دیاگ اینترنت» end to end, including
    // applying the repair it offers and saying afterwards whether that actually helped.
    //
    // Anything it does not recognise is said so, in those words, with the raw text shown. An
    // invented cause is worse than «I do not know this one».

    const TROUBLE = {
        'no-internet': {
            title: (t) => `<b>خط شما جواب نداد.</b> ${esc(t.detail || '')}`,
            line: 'این می‌تواند از خود خط باشد، از DNS، از پروکسی که جا مانده، یا از یک تونل نیمه‌بالا. می‌توانم بگردم و اگر چیزی پیدا شد خودم درستش کنم.',
            fixes: () => [
                { id: 'diag', label: 'بگرد و درستش کن', primary: true, run: () => runDiagnosis() },
            ],
        },
        'engine-failed': {
            title: (t) => `<b>${esc(t.detail || 'موتور')}</b> وصل نشد.`,
            line: 'یک موتور که امشب جواب نمی‌دهد لزوماً خراب نیست — روی خط شما بسته است. به‌جای امتحان یکی‌یکی، می‌توانم همه را بسنجم و بگویم کدام باز است.',
            fixes: () => [
                { id: 'race', label: 'همه را بسنج و بگو کدام باز است', primary: true, run: async () => { st.step = 'ask-engines'; await act('race-go'); } },
                { id: 'diag', label: 'اول خودِ خط را بررسی کن', run: () => runDiagnosis() },
            ],
        },
        'scan-empty': {
            title: () => '<b>اسکن تمام شد و آی‌پی سالمی پیدا نکرد.</b>',
            line: 'معمولاً یعنی دامنهٔ جست‌وجو کوچک بوده یا پورت‌ها محدود. می‌توانم با دامنهٔ بزرگ‌تر و پورت‌های بیشتر دوباره بگردم.',
            fixes: () => [
                { id: 'wider', label: 'با دامنهٔ بزرگ‌تر دوباره بگرد', primary: true, run: () => widerScan() },
                { id: 'diag', label: 'شاید خطِ من مشکل دارد — بررسی کن', run: () => runDiagnosis() },
            ],
        },
        'deploy-failed': {
            title: (t) => `<b>استقرار ورکر انجام نشد.</b>${t.code ? ` کد خطا: <span dir="ltr" class="as-num">${esc(t.code)}</span>` : ''}`,
            line: null,     // built from the code below
            fixes: () => [
                { id: 'cloud', label: 'باز کردن زیرساخت ابری', primary: true, run: async () => { if (window.MV && MV.wm) MV.wm.open('cloud'); } },
                { id: 'diag', label: 'بررسی خط', run: () => runDiagnosis() },
            ],
        },
        unknown: {
            title: (t) => `<b>این خطا را نمی‌شناسم.</b> ${esc(t.detail || '')}`,
            line: 'متنش را عیناً پایین گذاشته‌ام. می‌توانم خط را بررسی کنم — بیشترِ خطاهای ناشناخته از همان‌جا می‌آیند.',
            fixes: () => [
                { id: 'diag', label: 'بررسی خط', primary: true, run: () => runDiagnosis() },
            ],
        },
    };

    /** Cloudflare says exactly why a deploy failed; the advice comes from that, not from a guess. */
    function deployAdvice(code, text) {
        const t = String(text || '');
        if (code === 10021 || /subdomain/i.test(t)) return 'حساب شما هنوز زیردامنهٔ workers.dev ندارد — یک بار در پنل کلودفلر بسازیدش و دوباره بزنید.';
        if (code === 10026 || /exceeded|quota|limit/i.test(t)) return 'سهمیهٔ حساب پر شده. تا ریست بعدی (۰۳:۳۰ بامداد) صبر کنید یا حساب دیگری وصل کنید.';
        if (code === 10000 || /authentication|unauthor/i.test(t)) return 'کلید API پذیرفته نشد — Global API Key را دوباره از کلودفلر بگیرید و حساب را از نو اضافه کنید.';
        if (/already exists|duplicate/i.test(t)) return 'ورکری با همین نام هست. «استقرار مجدد» بزنید تا همان به‌روز شود.';
        if (/name|invalid/i.test(t)) return 'نام ورکر پذیرفته نشد — فقط حروف کوچک، عدد و خط تیره.';
        return 'این کد را این نسخه نمی‌شناسد. متنش پایین آمده؛ اگر ماند، همان را بفرستید.';
    }

    /**
     * Anything, anywhere, that failed. Panels call this instead of leaving a toast behind.
     * `kind` decides the advice; `raw` is shown verbatim because a message the app does not
     * recognise is still the most useful thing on the screen.
     */
    const lastTrouble = {};              // kind → when it was last raised
    const TROUBLE_COOLDOWN = 45000;

    async function trouble(t) {
        if (!t || store(OFF_KEY) === '1') return;
        if (st.running || st.step === 'racing' || st.step === 'diagnosing' || st.step === 'run') return;
        // THE SAME FAULT ARRIVING AGAIN MUST NOT REBUILD THE CARD.
        // A dead line makes every request fail, so «no-internet» arrives over and over, and each
        // one used to wipe whatever the user was reading. The cooldown is PER KIND, deliberately:
        // a DIFFERENT fault is new information and must be allowed through immediately, or a
        // network blip would blindfold the user for the next minute.
        const now = Date.now();
        if (lastTrouble[t.kind] && now - lastTrouble[t.kind] < TROUBLE_COOLDOWN) return;
        lastTrouble[t.kind] = now;
        const kind = TROUBLE[t.kind] ? t.kind : 'unknown';
        st.trouble = Object.assign({}, t, { kind });
        st.step = 'trouble';
        st.msgs = [];
        const spec = TROUBLE[kind];
        st.msgs.push({ who: 'bot', html: spec.title(st.trouble) });
        const line = kind === 'deploy-failed' ? deployAdvice(t.code, t.raw || t.detail) : spec.line;
        if (line) st.msgs.push({ who: 'bot', html: esc(line) });
        show(); open(); paint();
    }

    // ── Driving «دیاگ اینترنت» end to end ──────────────────────────────────
    //
    // The module underneath is a real evidence engine — collectors, hypotheses, repairs with a
    // gate and a verification pass. What it never had was someone to press its buttons: it
    // diagnosed, and then the user had to work out which repair to apply and whether it helped.

    const REPAIR_FA = {
        'dns.flush': 'پاک کردن حافظهٔ DNS ویندوز',
        'svc.start': 'روشن کردن سرویس متوقف‌شدهٔ ویندوز',
        'proxy.wininet.disable': 'خاموش کردن پروکسی جامانده',
        'proxy.pac.clear': 'برداشتن اسکریپت پروکسی (PAC) خراب',
        'guard.restore.stale': 'باز کردن قفل‌ایمنی جامانده',
    };

    const ND_VERDICT_TONE = {
        confirmed: { tone: 'sure', kicker: 'علت پیدا شد' },
        likely: { tone: 'likely', kicker: 'به احتمال زیاد' },
        possible: { tone: 'likely', kicker: 'یکی از احتمال‌ها' },
        indeterminate: { tone: 'likely', kicker: 'نامشخص ماند' },
    };

    /**
     * The verdict, read from the shape /session/:id actually returns.
     *
     * It used to read `diagnosis.entries` / `diagnosis.findings` — neither of which the route
     * has ever sent. Both were always undefined, so every run fell through to the last branch
     * and the assistant cheerfully reported «چیز خرابی پیدا نشد» no matter what the engine had
     * concluded. The real shape is `narrative.{ headline, rootCauses, independent, unresolved }`
     * with entries slimmed to { id, title, verdict, … } — and note there is no `detail`, which
     * is why the sub-line is built here rather than copied.
     *
     * The four headline kinds are the engine's own (netdiag/diagnose.js decideHeadline), and
     * «علت قطعی پیدا نشد» is deliberately NOT «مشکلی پیدا نشد» — they are different answers.
     */
    function headlineOf(payload) {
        const n = (payload && payload.narrative) || null;
        if (!n) {
            return { tone: 'likely', kicker: 'نتیجه', title: 'گزارش کامل برنگشت',
                sub: 'بررسی تمام شد ولی نتیجه‌اش خوانده نشد. «دیدن کامل گزارش» را بزنید.' };
        }
        const h = n.headline || {};
        const all = [].concat(n.rootCauses || [], n.independent || [], n.unresolved || []);
        const byId = (id) => all.find(x => x && x.id === id) || null;

        if (h.kind === 'single-root') {
            const e = byId(h.id) || (n.rootCauses || [])[0] || {};
            const v = ND_VERDICT_TONE[e.verdict] || ND_VERDICT_TONE.possible;
            return { tone: v.tone, kicker: v.kicker, title: e.title || 'یک علت پیدا شد', sub: '' };
        }
        if (h.kind === 'multiple-roots') {
            const names = (h.ids || []).map(byId).filter(Boolean).map(e => e.title).filter(Boolean);
            return {
                tone: 'sure', kicker: 'چند علت مستقل',
                title: fa((h.ids || []).length) + ' علت پیدا شد که هرکدام به‌تنهایی می‌توانند این وضعیت را بسازند',
                sub: names.join(' · '),
            };
        }
        if (h.kind === 'undetermined' || h.kind === 'no-cause-for-symptom') {
            const missing = (n.missingEvidence || []).length;
            return {
                tone: 'likely', kicker: 'نتیجه', title: 'علت قطعی پیدا نشد',
                sub: missing
                    ? 'چیزهایی بود که نتوانستم اندازه بگیرم؛ در گزارش کامل نامشان آمده.'
                    : 'چیزی که پیدا شد این وضعیت را توضیح نمی‌دهد. گزارش کامل شواهدش را دارد.',
            };
        }
        return {
            tone: 'ok', kicker: 'نتیجه', title: 'در بررسی‌ها مشکلی پیدا نشد',
            sub: 'هرچه آزمودم سالم بود — یعنی مشکل جایی است که از این کامپیوتر دیده نمی‌شود، معمولاً خودِ خط یا فیلترینگ. «کدام موتور برای خط من؟» قدم بعدیِ درست است.',
        };
    }

    /**
     * Every /api/netdiag/* call needs the per-process token.
     *
     * netdiag/routes.js guard() checks Host, Origin, Content-Type AND this header, and
     * answers 401 «missing or invalid token» without it — which is exactly what the
     * assistant was showing the user, because it sent a bare fetch. The panel has had
     * ndApi() since day one; this is the same thing, kept local so load order cannot
     * matter.
     */
    async function ndReq(path, body) {
        const opts = { headers: { 'X-Netdiag-Token': window.__NETDIAG_TOKEN__ || '' } };
        if (body !== undefined) {
            opts.method = 'POST';
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch('/api/netdiag/' + path, opts);
        const d = await r.json().catch(() => ({}));
        // Only a non-200 is a failure of the CALL. `ok:false` with a 200 is /repair reporting
        // the repair's own outcome, and its `reason` is the sentence the user needs.
        if (!r.ok || (d.ok === false && d.error)) {
            throw new Error(d.error || ('خطای سرور (' + r.status + ')'));
        }
        return d;
    }

    async function runDiagnosis() {
        st.step = 'diagnosing';
        st.diag = { percent: 0, phase: 'شروع بررسی…', offers: [], applied: {} };
        busy(true); sub('در حال عیب‌یابی…'); paint();

        let sid = null;
        try {
            const d = await ndReq('start', { mode: 'full' });
            if (!d.sessionId) throw new Error('بررسی شروع نشد');
            sid = d.sessionId;
            st.diag.sessionId = sid;
        } catch (e) {
            busy(false); st.step = 'idle';
            await saysSlowly(`عیب‌یابی شروع نشد: ${esc(e.message)}`);
            return;
        }

        // Progress and completion come from two different places, and that is not an
        // oversight: /session/:id returns the session and the narrative but NO percent and
        // NO phase — those exist only as broadcasts (netdiag/routes.js emit()). Polling for
        // them left the bar on «شروع بررسی…» at ۰٪ for the whole run, which is the one thing
        // this assistant is not allowed to do. So the socket drives the bar and the poll
        // decides when it is over.
        //
        // The panel's handler is chained, not replaced: it filters on its own sessionId and
        // ignores ours, so both can be open at once without either bar moving for the other.
        const prevEvent = window.handleNetDiagEvent;
        window.handleNetDiagEvent = function (data) {
            try { if (typeof prevEvent === 'function') prevEvent(data); } catch (e) { /* the panel's business */ }
            if (!data || data.sessionId !== sid) return;
            if (typeof data.percent === 'number') st.diag.percent = data.percent;
            const L = window.ND_PHASE_LABEL || {};
            if (data.phase && L[data.phase]) st.diag.phase = L[data.phase];
            paint();
        };

        let payload = null;
        try {
            for (let i = 0; i < 200; i++) {
                await sleep(1200);
                let j = null;
                try { j = await ndReq('session/' + encodeURIComponent(sid)); } catch (e) { continue; }
                if (j.done) { payload = j; break; }
            }
        } finally {
            window.handleNetDiagEvent = prevEvent;
        }

        busy(false);
        if (!payload) {
            st.step = 'idle';
            await saysSlowly('بررسی در زمان مقرر تمام نشد. از پنجرهٔ «دیاگ اینترنت» می‌توانید دوباره امتحان کنید.');
            return;
        }

        st.diag.headline = headlineOf(payload);
        st.diag.offers = (payload.offers || []).map(o => Object.assign({}, o, {
            label: REPAIR_FA[o.repairId] || o.label || o.repairId,
        }));
        st.step = 'diag-done';
        sub('تمام شد');

        const h = st.diag.headline;
        await saysSlowly(h.tone === 'ok'
            ? 'گشتم و چیز خرابی روی این کامپیوتر پیدا نکردم.'
            : `پیدا شد: <b>${esc(h.title)}</b>`);
        if (st.diag.offers.length) {
            await saysSlowly(st.diag.offers.length === 1
                ? 'یک کار هست که می‌توانم همین‌جا انجام بدهم — بعدش دوباره اندازه می‌گیرم تا ببینم واقعاً درست شد یا نه.'
                : `${num(fa(st.diag.offers.length))} کار هست که می‌توانم انجام بدهم. هرکدام را بزنید، بعدش نتیجه‌اش را می‌گویم.`);
        } else if (h.tone !== 'ok') {
            await saysSlowly('برای این یکی کاری نیست که از این‌جا بشود کرد — گزارش کامل را ببینید، آن‌جا شواهدش هست.');
        }
    }

    /** Apply one repair, then say whether it actually helped — not whether it ran. */
    async function applyRepair(o) {
        busy(true); sub('در حال انجام…');
        await saysSlowly('انجام می‌دهم…');
        let j = null;
        try {
            j = await ndReq('repair', {
                sessionId: st.diag.sessionId, repairId: o.repairId, confirmToken: o.confirmToken,
            });
        } catch (e) {
            busy(false); sub('تمام شد');
            await saysSlowly(`انجام نشد: ${esc(e.message)}`);
            return;
        }
        busy(false); sub('تمام شد');
        st.diag.applied[o.repairId] = true;

        // The route answers { ok, outcome, reason, verification:{ outcome, wording, rolledBack,
        // rediagnose } }. `outcome` is a STRING. Reading it as an object — `j.outcome.ok` —
        // yielded undefined on every successful repair, so a repair that worked was announced
        // as «انجام نشد … دلیلش معلوم نشد». Likewise `verification.improved` has never existed.
        //
        // The wording itself comes from the server (netdiag/verify.js WORDING) rather than
        // being written again here: one sentence for one outcome, in one place.
        const v = j.verification || {};
        if (!j.ok) {
            await saysSlowly(`«${esc(o.label)}» انجام نشد — ${esc(j.reason || 'دلیلش معلوم نشد')}.`);
            // The gate refuses while anything is connected, on purpose: changing DNS or the
            // system proxy underneath a live engine is how a half-applied state gets made.
            if (j.outcome === 'gate-refused') {
                await saysSlowly('اول از همهٔ موتورها قطع شوید، بعد «دوباره بررسی کن» را بزنید — آن‌وقت می‌توانم انجامش بدهم.');
            } else {
                await saysSlowly('این تأیید مصرف شد. «دوباره بررسی کن» را بزنید تا با وضعیت تازه دوباره پیشنهاد بدهم.');
            }
            paint(); return;
        }
        if (v.rolledBack) { await saysSlowly('انجام شد ولی چیز دیگری را خراب کرد، پس برش گرداندم. دست‌نخورده ماند.'); paint(); return; }
        if (v.outcome === 'fixed') { await saysSlowly(`<b>درست شد.</b> بعد از «${esc(o.label)}» دوباره اندازه گرفتم و این بار جواب داد.`); paint(); return; }
        if (v.wording) { await saysSlowly(`«${esc(o.label)}» انجام شد. ${esc(v.wording)}`); }
        else { await saysSlowly(`«${esc(o.label)}» انجام شد.`); }
        if (v.rediagnose) await saysSlowly('وضعیت عوض شد — اگر بخواهید، یک بار دیگر از اول بررسی می‌کنم.');
        paint();
    }

    /** «اسکن چیزی پیدا نکرد» — the same scan, with the net cast properly wide. */
    async function widerScan() {
        const tab = typeof getActiveTab === 'function' ? getActiveTab() : null;
        if (!tab) { await saysSlowly('اسکنی باز نیست.'); return; }
        ['chk-cf', 'chk-ak', 'chk-fl', 'chk-aws', 'chk-gc'].forEach(id => { const e = $(id); if (e) e.checked = true; });
        const none = $('chk-none'); if (none) none.checked = false;
        [443, 80, 8443, 2053].forEach(v => {
            const e = document.querySelector('.port-chk[value="' + v + '"]');
            if (e) e.checked = true;
        });
        const max = $('param-max'); if (max) max.value = Math.max(4000, (+max.value || 400) * 4);
        const ta = $('ip-textarea'); if (ta) ta.value = '';
        if (typeof window.saveTabSettings === 'function') window.saveTabSettings();
        st.step = 'idle';
        await saysSlowly('پنج منبع و چهار پورت را روشن کردم و سقف را بالا بردم. شروع می‌کنم — نتیجه در پنجرهٔ اسکنر می‌آید.');
        if (window.MV && MV.wm) MV.wm.open('scanner');
        if (typeof window.startScan === 'function') window.startScan();
    }

    // ── «کدام موتور برای خط من؟» ────────────────────────────────────────────
    //
    // The server does the dangerous half (/api/engines/probe): it brings each engine up in its
    // proxy-only form, asks it to fetch something real, and puts it back — never touching the
    // system tunnel or the machine's DNS. This half streams what it says and turns the numbers
    // into a sentence.

    /** Which window to open when the winner is named. */
    const ENGINE_APP = {
        masque: 'masque', wg: 'wireguard', gool: 'warp_on_warp',
        psiphon: 'psiphon', tor: 'tor', lantern: 'lantern', geph: 'geph', openvpn: 'openvpn',
    };
    // OpenVPN last: its probe dials a relay and waits for a full handshake, so it is the slowest
    // row even when it wins, and a race that opens with its wait reads as a hang.
    const ENGINE_ORDER = ['masque', 'wg', 'gool', 'psiphon', 'lantern', 'geph', 'tor', 'openvpn'];
    const ENGINE_FA = {
        masque: 'ماسک', wg: 'وایرگارد', gool: 'وارپ در وارپ',
        psiphon: 'سایفون', tor: 'تور', lantern: 'لنترن', geph: 'گف', openvpn: 'اوپن‌وی‌پی‌ان',
    };

    /** The server's message, in the fewest words that are still true. */
    function shortReason(err) {
        const t = String(err || '');
        if (/نصب نیست/.test(t)) return 'نصب نیست';
        if (/وصل نشد|زمان مقرر/.test(t)) return 'وصل نشد';
        if (/عبور نکرد/.test(t)) return 'چیزی رد نشد';
        if (/حساب/.test(t)) return 'حساب ندارد';
        return t.length > 22 ? t.slice(0, 22) + '…' : (t || 'جواب نداد');
    }

    async function raceEngines() {
        busy(true);
        sub('در حال سنجش موتورها…');
        st.race = { rows: ENGINE_ORDER.map(id => ({ id, fa: ENGINE_FA[id], state: 'wait' })), done: false, aborted: false };
        paint();

        const row = (id) => st.race.rows.find(r => r.id === id);
        let res;
        try {
            res = await fetch('/api/engines/probe', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ engines: ENGINE_ORDER }),
            });
        } catch (e) { busy(false); throw new Error('سرور جواب نداد'); }

        if (!res.ok) {
            busy(false);
            st.step = 'idle';
            const d = await res.json().catch(() => ({}));
            await saysSlowly(d.code === 'TUN_UP'
                ? 'اول تونل کامل را خاموش کنید — سنجش نباید مسیر سیستم شما را عوض کند.'
                : esc(d.error || 'سنجش شروع نشد.'));
            return;
        }

        const feed = (obj) => {
            if (obj.type === 'begin') { const r = row(obj.id); if (r) { r.state = 'live'; } }
            else if (obj.type === 'connected') { const r = row(obj.id); if (r) r.connectMs = obj.connectMs; }
            else if (obj.type === 'result') {
                const r = row(obj.id);
                if (r) {
                    r.state = 'done'; r.ok = obj.ok === true; r.ms = obj.ms;
                    r.connectMs = obj.connectMs; r.short = obj.ok ? null : shortReason(obj.error);
                }
            }
            paint();
        };

        if (res.body && res.body.getReader) {
            const reader = res.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += dec.decode(value, { stream: true });
                const lines = buf.split('\n'); buf = lines.pop();
                for (const line of lines) { if (line.trim()) { try { feed(JSON.parse(line)); } catch (e) {} } }
            }
        } else {
            const txt = await res.text();
            txt.split('\n').filter(Boolean).forEach(l => { try { feed(JSON.parse(l)); } catch (e) {} });
        }

        busy(false);
        st.race.done = true;
        st.step = 'race-done';
        sub('تمام شد');

        const good = st.race.rows.filter(r => r.ok).sort((a, b) => a.ms - b.ms);
        const bad = st.race.rows.filter(r => r.ok === false);
        if (!good.length) {
            await saysSlowly(`هیچ‌کدام از ${num(fa(st.race.rows.length))} موتور امشب روی خط شما جواب نداد. این معمولاً یعنی خودِ خط مشکل دارد، نه موتورها — «دیاگ اینترنت» را امتحان کنید.`);
            return;
        }
        const best = good[0];
        const others = good.slice(1, 3).map(r => `<b>${esc(r.fa)}</b>`).join(' و ');
        await saysSlowly(`روی خط شما <b>${esc(best.fa)}</b> بهترین بود — در ${num(fa(Math.round((best.connectMs || 0) / 1000)) + ' ثانیه')} وصل شد و پاسخش ${num(fa(best.ms) + ' ms')} بود.`
            + (others ? ` بعد از آن ${others}.` : '')
            + (bad.length ? ` ${num(fa(bad.length))} موتور جواب نداد.` : ''));
        if (typeof window.triggerNotification === 'function') {
            window.triggerNotification('assistantDone', 'دستیار MLM VPN', `سنجش موتورها تمام شد — ${best.fa} بهترین بود.`);
        }
        if (!st.open) { $('as-badge').hidden = false; $('as-badge').textContent = '۱'; }
    }

    // ── Do the configs still work? ─────────────────────────────────────────
    //
    // A combined config is a raw config wearing a clean IP, and a clean IP is only clean until
    // it is noticed. Nothing in the app told anyone that: the set made last week just quietly
    // got slower and slower, and the user was left to work out why on their own.
    //
    // So one group at a time, rarely, and only while nothing else is happening, a small sample
    // is measured. It has to be the REAL delay through the core — a filtered Cloudflare edge
    // still answers tcping, so a port check here would report perfect health forever.

    const HEALTH_KEY = 'mv-assistant-health';
    const MIN_AGE_H = 36;        // a set younger than this has not had time to rot
    const RECHECK_H = 20;        // and one already looked at today is left alone
    const SAMPLE = 8;            // nodes per sample — one core page, a few seconds
    const SICK_AT = 0.7;         // below this share still answering, it is worth saying

    function healthAll() {
        try { return JSON.parse(store(HEALTH_KEY) || '{}'); } catch (e) { return {}; }
    }
    function healthSet(id, rec) {
        const all = healthAll();
        all[id] = rec;
        // Keep it from growing forever: the newest sixty checks are plenty.
        const keys = Object.keys(all).sort((a, b) => (all[b].at || 0) - (all[a].at || 0)).slice(0, 60);
        const trimmed = {};
        keys.forEach(k => { trimmed[k] = all[k]; });
        store(HEALTH_KEY, JSON.stringify(trimmed));
    }

    /** Combo groups are keyed `combo_<Date.now()>`; `date` is a Persian string and unparseable. */
    function groupAgeH(g) {
        const m = String(g.id || '').match(/(\d{10,})/);
        if (!m) return null;
        return (Date.now() - Number(m[1])) / 36e5;
    }

    /** The raw configs this group was built from — metadata first, then the base group by name. */
    function rawsFor(g) {
        const md = g.metadata || {};
        if (Array.isArray(md.raws) && md.raws.length) return md.raws.slice();
        const sni = (g.nodes || []).map(x => x && x.sni).find(Boolean);
        if (sni) {
            const b = bases().find(x => x && x.name === sni && Array.isArray(x.configs) && x.configs.length);
            if (b) return b.configs.filter(c => typeof c === 'string' && c.trim());
        }
        return null;
    }

    function pickGroupToCheck() {
        const health = healthAll();
        const now = Date.now();
        return comboGroups().filter(g => {
            if (!g || !Array.isArray(g.nodes) || g.nodes.length < 4) return false;
            if (seen().includes('decay:' + g.id)) return false;      // already declined
            const age = groupAgeH(g);
            if (age == null || age < MIN_AGE_H) return false;
            const rec = health[g.id];
            if (rec && (now - (rec.at || 0)) / 36e5 < RECHECK_H) return false;
            return true;
        })[0] || null;   // the newest that qualifies — the one most likely still in use
    }

    async function checkGroup(g) {
        const nodes = [];
        const step = Math.max(1, Math.floor(g.nodes.length / SAMPLE));
        for (let i = 0; i < g.nodes.length && nodes.length < SAMPLE; i += step) {
            const cfg = g.nodes[i] && g.nodes[i].config;
            if (cfg) nodes.push({ id: String(nodes.length), uri: cfg });
        }
        if (!nodes.length) return null;
        let alive = 0;
        await streamTest(nodes, 'delay', (r) => { if (r && r.val > 0) alive++; });
        return { at: Date.now(), sampled: nodes.length, alive };
    }

    /** Quiet enough to spend a few seconds of core time? */
    function idleEnough() {
        if (st.running || st.step === 'count' || st.step === 'mode' || st.step === 'run' || st.step === 'decay'
            || st.step === 'ask-engines' || st.step === 'racing' || st.step === 'diagnosing') return false;
        try {
            if (typeof tabs !== 'undefined' && tabs.some(t => t && t.state === 'running')) return false;
        } catch (e) { /* no tab system: nothing to collide with */ }
        return true;
    }

    async function watchHealth() {
        if (store(OFF_KEY) === '1' || !idleEnough()) return;
        const g = pickGroupToCheck();
        if (!g) return;
        let rec = null;
        try { rec = await checkGroup(g); } catch (e) { return; }
        if (!rec) return;
        healthSet(g.id, rec);
        if (rec.alive / rec.sampled > SICK_AT) return;    // still healthy: say nothing

        // Only interrupt if the conversation is not in the middle of something.
        if (!idleEnough()) return;
        st.decay = { group: g, rec, raws: rawsFor(g) };
        st.step = 'decay';
        st.msgs = [];
        const days = Math.max(1, Math.round(groupAgeH(g) / 24));
        const dead = rec.sampled - rec.alive;
        st.msgs.push({
            who: 'bot',
            html: `از <b class="as-num">${fa(g.nodes.length)}</b> کانفیگی که <b class="as-num">${fa(days)}</b> روز پیش `
                + `در «${esc(g.title || 'مرکز ترکیب')}» ساخته شد، نمونه گرفتم: `
                + `<b class="as-num">${fa(dead)}</b> از <b class="as-num">${fa(rec.sampled)}</b> تا دیگر جواب نمی‌دهند.<br>`
                + (st.decay.raws
                    ? 'آی‌پی‌های تمیز با گذشت زمان فیلتر می‌شوند. همین تعداد را با آی‌پی‌های تازه دوباره بسازم؟'
                    : 'برای ساختن دوباره به کانفیگ خام اصلی نیاز دارم و دیگر موجود نیست — از «زیرساخت ابری» یک بار «دریافت کانفیگ» بزنید، بقیه‌اش با من.'),
        });
        show();
        $('as-badge').hidden = false;
        paint();
    }

    // ── Handing the result to V2Ray, visibly ───────────────────────────────
    async function toV2ray() {
        if (!st.result.length) return;
        window.v2rayList = window.v2rayList || [];
        st.result.forEach(uri => {
            window.v2rayList.unshift({ id: 'conf_' + Date.now() + Math.random(), uri });
        });
        if (typeof window.saveV2rayList === 'function') window.saveV2rayList();
        if (typeof window.renderV2rayList === 'function') window.renderV2rayList();

        say(`<i class="ph-bold ph-check"></i> ${fa(st.result.length)} کانفیگ به V2Ray رفت.`, 'bot');
        // A window that appears out of nowhere reads as a glitch. It is announced first, then
        // opened with the window manager's own spring animation, so the movement is the answer
        // to a sentence the user just read.
        await saysSlowly('پنل V2Ray را برایتان باز می‌کنم…');
        await sleep(360);
        if (window.MV && MV.wm && typeof MV.wm.open === 'function') MV.wm.open('v2ray');
        else if (typeof window.toggleLeftSidebar === 'function') window.toggleLeftSidebar('v2ray');
    }

    // ── Boot ───────────────────────────────────────────────────────────────
    function init() {
        mount();
        // Always visible, from the first frame. The badge — not the existence of the orb —
        // is what says «there is something new here».
        if (store(OFF_KEY) !== '1') show();
        // The panels call notify() the moment they store configs; this slow sweep is the net
        // under that — a panel added later, or an import the assistant did not hear about.
        setInterval(() => { try { offerIfAny(false); } catch (e) {} }, 15000);
        setTimeout(() => { try { offerIfAny(false); } catch (e) {} }, 4000);
        // The health watch costs a core and a few seconds, so it is rare and never in a hurry:
        // once ninety seconds after the app settles, then every half hour, one group at a time.
        setTimeout(() => { watchHealth().catch(() => {}); }, 90000);
        setInterval(() => { watchHealth().catch(() => {}); }, 30 * 60000);
    }

    window.initAssistantModule = init;
    window.MVAssistant = {
        /** A panel just stored raw configs: offer right away, with the card open. */
        notify: function () { try { setTimeout(() => offerIfAny(true), 500); } catch (e) {} },
        open: openSmart,
        /** «کدام موتور برای خط من؟», from the menu bar or Ctrl K. */
        raceEngines: function () { openSmart(); act('ask-engines'); },
        close: close,
        isBusy: function () { return !!st.running; },
        /**
         * Something failed: tell the assistant instead of leaving a toast behind.
         * kind: 'no-internet' | 'engine-failed' | 'scan-empty' | 'deploy-failed' | anything else
         */
        trouble: trouble,
        /** Run «دیاگ اینترنت» from the assistant, repairs included. */
        diagnose: function () { show(); open(); return runDiagnosis(); },
        /** Check one aging set now instead of waiting for the slow watch. */
        checkHealth: function () { return watchHealth(); },
    };
})();
