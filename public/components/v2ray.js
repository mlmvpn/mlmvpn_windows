// --- V2Ray panel (components/v2ray.js) ---
//
// Rebuilt 2026-09-12. What it used to be and why that mattered:
//
//   * TWO GENERATIONS OF THE SAME PANEL were stacked in one file. `renderV2rayList`,
//     `sortV2ray`, `confirmDeleteAllV2rayNodes` and `toggleModal` were each defined twice;
//     the later copy won and the earlier one was dead weight that still looked live when
//     read. Every duplicate is gone.
//   * `initV2rayModule` bound the connect button with addEventListener ON TOP of the
//     template's own `onclick`, so every click ran the connect twice — two POSTs to
//     /api/v2ray/start, the second one killing the engine the first had just started. The
//     same double binding was on «بروزرسانی» in the edit sheet.
//   * It also bound the three test buttons by `document.querySelectorAll('.overflow-x-auto
//     button')` — a DOCUMENT-wide selector, so buttons in completely unrelated panels could
//     start a delay test.
//   * A failed sweep was indistinguishable from dead configs: -1 (never reached) was stored
//     as 0 and drawn as "Timeout", the route's 500 was swallowed as if it were a progress
//     line, and `finalizeTest` then span for 30 s before announcing «✅ تست تمام شد» over a
//     list where every row said Timeout. That is the whole of «کانفیگ ها دیلی نمیدن».
//   * `importV2rayNodes` replaced the config's real name with a random "X3F9-mlmvpn", threw
//     away the panel/country label in the link, and dropped ss:// links the parser handles.
//   * The per-node download test wrote into an element (`v2ray-speed-*`) the list has not
//     had for a while, and «پینگ سرور» actually measured download speed, because the route
//     had no ping branch at all. The download test is gone (asked for), ping is a tcping.
//
// The look is the macOS 26 page kit (ui/page-kit.css), the same pieces Settings is built
// from: K1 toolbar, K2 status head, K3 list rows, K5 bottom bar, K8 sheets. Every dialog in
// this panel is a sheet now — the edit/share/subscription/delete ones were still the old
// Material markup, which is what made the panel look like two different programs.

// ──────────────────────────────────────────────────────────────────────────────
// State
// ──────────────────────────────────────────────────────────────────────────────
window.v2rayList = window.v2rayList || [];

window.isV2rayGrouped = false;
window.activeV2rayPanelTab = null;
window.activeV2raySubTab = null;

window.isV2rayTesting = false;
window.v2rayTestState = { count: 0, total: 0 };
window.v2rayTestAbortController = null;

window.isPlatformTestEnabled = false;
window.activePlatformTarget = 'https://www.binance.com/';

/** «فقط همین کانفیگ» — remembered per user, default on. See V2RAY_SOLO below. */
const SOLO_KEY = 'v2ray-solo-outbound';
const SORT_KEY = 'v2ray-sort';

const store = {
    get(key, fallback) {
        try {
            const v = (typeof PersistentStorage !== 'undefined' ? PersistentStorage : localStorage).getItem(key);
            return v === null || v === undefined ? fallback : v;
        } catch (e) { return fallback; }
    },
    set(key, val) {
        try { (typeof PersistentStorage !== 'undefined' ? PersistentStorage : localStorage).setItem(key, val); } catch (e) { }
    },
};

window.v2rayPlatformTargets = [
    { name: 'Binance', icon: '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M16.624 13.9202l2.7175 2.7154-7.353 7.353-7.353-7.352 2.7175-2.7164 4.6355 4.6595 4.6356-4.6595zm4.6366-4.6366L24 12l-2.7394 2.7154-2.738-2.7154 2.738-2.7366zM7.376 10.0798L4.6585 7.3644 12 0l7.3415 7.3644-2.7175 2.7164-4.624-4.6595-4.624 4.6595zm-4.6366 4.6366L0 12l2.7394-2.7154 2.738 2.7154-2.738 2.7366zm6.347-1.7155L12 10.078l2.9136 2.9228-2.9136 2.9228-2.9136-2.9228z"/></svg>', url: 'https://www.binance.com/' },
    { name: 'TradingView', icon: '<i class="ph-bold ph-chart-line-up"></i>', url: 'https://www.tradingview.com/favicon.ico' },
    { name: 'Telegram', icon: '<i class="ph-bold ph-telegram-logo"></i>', url: 'https://api.telegram.org' },
    { name: 'YouTube', icon: '<i class="ph-bold ph-youtube-logo"></i>', url: 'https://www.youtube.com/favicon.ico' },
    { name: 'ChatGPT', icon: '<i class="ph-bold ph-robot"></i>', url: 'https://chatgpt.com/favicon.ico' },
    { name: 'Claude AI', icon: '<i class="ph-bold ph-sparkle"></i>', url: 'https://api.anthropic.com' },
    { name: 'Gemini', icon: '<i class="ph-bold ph-diamond"></i>', url: 'https://gemini.google.com/' },
    { name: 'GitHub', icon: '<i class="ph-bold ph-github-logo"></i>', url: 'https://api.github.com' },
    { name: 'Discord', icon: '<i class="ph-bold ph-discord-logo"></i>', url: 'https://discord.com/' },
    { name: 'X / Twitter', icon: '<i class="ph-bold ph-x-logo"></i>', url: 'https://x.com/' },
    { name: 'Instagram', icon: '<i class="ph-bold ph-instagram-logo"></i>', url: 'https://www.instagram.com/' },
    { name: 'Spotify', icon: '<i class="ph-bold ph-spotify-logo"></i>', url: 'https://api.spotify.com' },
    { name: 'Steam', icon: '<i class="ph-bold ph-game-controller"></i>', url: 'https://api.steampowered.com' },
    { name: 'CoinMarketCap', icon: '<i class="ph-bold ph-chart-bar"></i>', url: 'https://api.coinmarketcap.com' },
];

const V2RAY_SOLO = {
    get() { return store.get(SOLO_KEY, '1') !== '0'; },
    set(on) { store.set(SOLO_KEY, on ? '1' : '0'); },
};

// ──────────────────────────────────────────────────────────────────────────────
// Reading a config: its name, its host, its protocol
// ──────────────────────────────────────────────────────────────────────────────

/**
 * The name to show for a node.
 *
 * A saved `name` wins, then the link's own #fragment, then the host. The fragment mattered:
 * configs that arrive from the Cloudflare panels carry their label there and no `name` field,
 * so eight rows in a row all read "Node" — the user could not tell a Trojan node from a VLESS
 * one, let alone which worker they came from.
 */
window.v2rayNodeName = function (node) {
    if (!node) return 'Node';
    if (node.name && String(node.name).trim()) return String(node.name).trim();
    const uri = String(node.uri || '');
    const hash = uri.split('#')[1];
    if (hash) {
        let label = hash;
        try { label = decodeURIComponent(hash); } catch (e) { /* keep the raw form */ }
        label = label.trim();
        if (label) return label;
    }
    return window.v2rayNodeHost(node) || 'Node';
};

/** host:port as written in the link, for the second line of a row. */
window.v2rayNodeHost = function (node) {
    const uri = String((node && node.uri) || '');
    let host = uri.split('@')[1] || '';
    host = host.split('?')[0].split('#')[0];
    return host;
};

window.v2rayNodeProto = function (node) {
    const uri = String((node && node.uri) || '').trim();
    if (uri.startsWith('{')) return 'JSON';
    const m = uri.match(/^([a-z0-9+.-]+):\/\//i);
    if (!m) return '—';
    const p = m[1].toLowerCase();
    return { vless: 'VLESS', trojan: 'Trojan', vmess: 'VMess', ss: 'SS' }[p] || p.toUpperCase();
};

// ──────────────────────────────────────────────────────────────────────────────
// Grouping («تفکیک پنل‌ها»)
// ──────────────────────────────────────────────────────────────────────────────
window.getV2rayPanelName = function (node) {
    // The importers that know their own group say so explicitly, because no heuristic below
    // could place a name like "US 🇺🇸 | @Raydikalx" or a very long SNI-built copy.
    if (node && node.groupTitle === 'کانفیگ های SNI') return 'کانفیگ های SNI';
    if (node && node.groupTitle === 'کانفیگ های رایگان') return 'کانفیگ های رایگان';

    let raw = window.v2rayNodeName(node) || '';
    let n = raw.toLowerCase();

    if (n.includes('sni') || (node.uri && node.uri.includes(':40443'))) return 'کانفیگ های SNI';
    if (n.includes('bpb')) return 'BPB';
    if (n.includes('zeus')) return 'Zeus';
    if (n.includes('edge')) return 'Edge';
    if (n.includes('cloud') || n.includes('کلاستر')) return 'کلاستر کلودفلر';

    return 'افزودن دستی';
};

window.getV2raySubGroupName = function (node) {
    const raw = window.v2rayNodeName(node) || '';
    const n = raw.toLowerCase();
    if (n.includes('ترکیب')) return '🔀 ترکیب‌شده';
    const bracket = raw.match(/\[([^\]]+)\]/);
    if (bracket && bracket[1]) {
        const sub = bracket[1].trim();
        if (sub && sub !== 'ترکیب‌شده') return sub;
    }
    return 'پیش‌فرض';
};

/** The nodes the list is showing right now (the active panel tab and sub-tab). */
window.getV2rayFilteredNodes = function () {
    if (!window.isV2rayGrouped || !window.v2rayList) return window.v2rayList || [];
    let nodes = window.v2rayList.filter(n => window.getV2rayPanelName(n) === window.activeV2rayPanelTab);
    if (window.activeV2raySubTab) {
        nodes = nodes.filter(n => window.getV2raySubGroupName(n) === window.activeV2raySubTab);
    }
    return nodes;
};

window.toggleV2rayGrouping = function (e) {
    const checked = e ? e.target.checked : window.isV2rayGrouped;
    if (checked) {
        if (!window.v2rayList || !window.v2rayList.length) {
            toast('کانفیگی برای تفکیک وجود ندارد');
            if (e) e.target.checked = false;
            return;
        }
        const panels = new Set(window.v2rayList.map(window.getV2rayPanelName));
        if (panels.size <= 1) {
            toast('فقط یک پنل وجود دارد، تفکیک امکان‌پذیر نیست');
            if (e) e.target.checked = false;
            return;
        }
    }
    window.isV2rayGrouped = checked;
    window.activeV2rayPanelTab = null;
    window.activeV2raySubTab = null;
    window.renderV2rayList();
};

// ──────────────────────────────────────────────────────────────────────────────
// A tooltip that escapes the list's own scroll box
// ──────────────────────────────────────────────────────────────────────────────
window.showFixedTooltip = function (e, text) {
    let tt = document.getElementById('global-fixed-tooltip');
    if (!tt) {
        tt = document.createElement('div');
        tt.id = 'global-fixed-tooltip';
        tt.className = 'v2-tooltip';
        tt.dir = 'rtl';
        document.body.appendChild(tt);
    }
    tt.innerText = text;
    tt.style.opacity = '0';
    tt.style.display = 'block';

    const rect = e.target.getBoundingClientRect();
    let top = rect.top - tt.offsetHeight - 10;
    if (top < 0) top = rect.bottom + 10;
    tt.style.top = top + 'px';

    let left = rect.left + (rect.width / 2) - 128;
    if (left < 10) left = 10;
    if (left + 256 > window.innerWidth) left = window.innerWidth - 266;
    tt.style.left = left + 'px';

    setTimeout(() => { tt.style.opacity = '1'; }, 10);
};

window.hideFixedTooltip = function () {
    const tt = document.getElementById('global-fixed-tooltip');
    if (!tt) return;
    tt.style.opacity = '0';
    setTimeout(() => { if (tt.style.opacity === '0') tt.style.display = 'none'; }, 200);
};

// ──────────────────────────────────────────────────────────────────────────────
// Measuring: delay (real ping through the core) and ping (tcping)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * How one measured figure is drawn.
 *
 * Three states, and they are NOT interchangeable — the old panel collapsed them into one:
 *   > 0        the number, in ms
 *   -1         «ناموفق», with the server's own reason on hover
 *   undefined  «—», never measured
 * A sweep whose core could not start used to land in the same cell as a genuine timeout, so a
 * broken tester looked exactly like a list of dead configs. Now the reason is kept per node
 * (`delayNote` / `pingNote`) and shown.
 */
function figureHtml(val, note) {
    if (val > 0) return `<span class="v2-ok">${val}</span>`;
    // -1 WITH a reason is a measurement that failed. -1 without one is not a measurement at
    // all: every other importer in the app (cloud, combo, railway, SNI builder, free configs)
    // seeds new nodes with `delay: -1`, and drawing those as failures would paint a freshly
    // imported list red before anything had been tested.
    if (val === -1 && note) {
        return `<span class="v2-bad" title="${String(note).replace(/"/g, '&quot;')}">ناموفق</span>`;
    }
    return '<span class="v2-none">—</span>';
}

/** The row's two cells, refreshed in place while a sweep streams. */
function paintNodeFigures(idx, node) {
    const ping = document.getElementById(`v2ray-ping-${idx}`);
    const delay = document.getElementById(`v2ray-delay-${idx}`);
    if (ping) ping.innerHTML = figureHtml(node.ping, node.pingNote);
    if (delay) delay.innerHTML = figureHtml(node.delay, node.delayNote);
}

const SPINNER = '<i class="ph-bold ph-circle-notch mv-spin v2-spin"></i>';

/**
 * Apply one streamed result. Kept as a window function because the scanner sidebar's
 * WebSocket hook calls it too, and because it is the single place a measurement becomes
 * visible — if a number is on screen, it came through here.
 *
 * `id` is the node's index in window.v2rayList, which is what the sweep sent. It used to try
 * `v2rayList.find(n => n.id === item.id)` FIRST — comparing an index against ids like
 * "conf_17891723897650.78" — and only fell through to the index by luck.
 */
window.handleV2rayProgress = function (data) {
    if (!data || !window.v2rayTestState || !window.v2rayTestState.total) return;
    const type = data.testType === 'ping' ? 'ping' : 'delay';
    const idx = Number(data.id);
    const node = window.v2rayList[idx];

    window.v2rayTestState.count = Math.min(window.v2rayTestState.total, window.v2rayTestState.count + 1);
    if (data.reason === 'core') {
        window.v2rayTestState.coreFailures = (window.v2rayTestState.coreFailures || 0) + 1;
    }

    if (node) {
        node[type] = data.val > 0 ? data.val : -1;
        node[type + 'Note'] = data.val > 0 ? undefined : (data.reason || 'ناموفق');
        paintNodeFigures(idx, node);
    }
    paintTestProgress();
};

function paintTestProgress(label) {
    const cont = document.getElementById('v2ray-footer-progress-container');
    const bar = document.getElementById('v2ray-footer-progress-bar');
    const text = document.getElementById('v2ray-footer-progress-text');
    const st = window.v2rayTestState;
    if (bar && st.total) bar.style.width = ((st.count / st.total) * 100) + '%';
    if (text) text.innerText = label || `در حال تست … ${st.count} / ${st.total}`;
    if (cont) cont.style.display = 'flex';
}

function hideTestProgress(delay = 1800) {
    setTimeout(() => {
        const cont = document.getElementById('v2ray-footer-progress-container');
        if (cont) cont.style.display = 'none';
    }, delay);
}

/** The abort control, created once, next to the progress bar. */
function ensureAbortButton() {
    const cont = document.getElementById('v2ray-footer-progress-container');
    if (!cont || document.getElementById('btn-abort-v2ray-test')) return;
    const btn = document.createElement('button');
    btn.id = 'btn-abort-v2ray-test';
    btn.type = 'button';
    btn.className = 'v2-abort';
    btn.title = 'لغو تست';
    btn.setAttribute('aria-label', 'لغو تست');
    btn.innerHTML = '<i class="ph-bold ph-x"></i>';
    btn.onclick = window.abortV2rayTest;
    cont.insertBefore(btn, cont.firstChild);
}

/**
 * Test the whole list, the current group, or one node.
 *
 * @param type  'delay' — real ping through the core (v2rayN's Realping)
 *              'ping'  — tcping to the node's own address (v2rayN's Tcping, needs no core)
 */
window.testNodesUI = async function (event, type, targetNodeIdx = null) {
    if (window.isV2rayTesting) {
        toast('یک تست در حال انجام است. لطفاً صبر کنید.');
        return;
    }
    if (!window.v2rayList || !window.v2rayList.length) {
        toast('لیست خالی است');
        return;
    }
    if (type !== 'ping') type = 'delay';

    // WHAT IS BEING TESTED. One node, the visible group, or everything.
    let targets;
    if (targetNodeIdx !== null && window.v2rayList[targetNodeIdx]) {
        targets = [targetNodeIdx];
        toast('⏳ در حال تست کانفیگ انتخابی…');
    } else if (window.isV2rayGrouped && window.activeV2rayPanelTab) {
        targets = window.getV2rayFilteredNodes().map(n => window.v2rayList.indexOf(n));
        toast(`⏳ در حال تست ${targets.length} کانفیگ این تب…`);
    } else {
        targets = window.v2rayList.map((n, i) => i);
        toast(`⏳ در حال تست ${targets.length} کانفیگ…`);
    }
    if (!targets.length) return;

    window.isV2rayTesting = true;
    window.v2rayTestState = { count: 0, total: targets.length, coreFailures: 0 };
    window.v2rayTestAbortController = new AbortController();

    // The buttons that must not be pressed again, and what they looked like.
    const globals = ['btn-global-test-delay', 'btn-global-test-ping'].map(id => document.getElementById(id)).filter(Boolean);
    const restore = globals.map(b => ({ el: b, html: b.innerHTML }));
    const clicked = event && event.currentTarget;
    if (clicked && !globals.includes(clicked)) restore.push({ el: clicked, html: clicked.innerHTML });
    restore.forEach(s => { s.el.disabled = true; s.el.classList.add('is-busy'); });
    if (clicked) clicked.innerHTML = SPINNER;

    // Clear ONLY what is being tested, and to "not measured" rather than to a fake failure.
    targets.forEach(i => {
        const node = window.v2rayList[i];
        if (!node) return;
        node[type] = undefined;
        node[type + 'Note'] = undefined;
        const cell = document.getElementById(`v2ray-${type}-${i}`);
        if (cell) cell.innerHTML = SPINNER;
    });

    ensureAbortButton();
    paintTestProgress(`در حال تست … 0 / ${targets.length}`);
    const bar = document.getElementById('v2ray-footer-progress-bar');
    if (bar) bar.style.width = '0%';

    let fatal = null;
    try {
        const settings = {};
        if (type === 'delay') {
            // Settings › V2Ray پیشرفته › «آدرس‌های تست» › «تست تأخیر». It was never wired to
            // anything: the node test always probed its own built-in address, so changing the
            // setting did nothing at all. A chosen platform still wins over it.
            const chosen = (document.getElementById('setting-ping-url') || {}).value;
            if (window.isPlatformTestEnabled) settings.pingUrl = window.activePlatformTarget;
            else if (chosen) settings.pingUrl = chosen;
        }
        // Settings › V2Ray پیشرفته › «تست هم‌زمان در تست گروهی»; «خودکار» = 30, as always.
        const conc = parseInt((document.getElementById('setting-concurrent-tests') || {}).value, 10);
        settings.concurrency = conc > 0 ? conc : 30;

        const res = await fetch('/api/v2ray/test-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nodes: targets.map(i => ({ id: i, uri: window.v2rayList[i].uri })),
                testType: type,
                settings,
            }),
            signal: window.v2rayTestAbortController.signal,
        });

        // A NON-OK ANSWER IS AN ERROR, NOT A PROGRESS LINE.
        //
        // This is the whole of the old silence: a 500 body was fed to the same JSON.parse as
        // the results, matched no node, and the panel then waited 30 s for a count that could
        // never arrive before announcing success over a list of "Timeout"s.
        if (!res.ok) {
            let msg = `خطای سرور (${res.status})`;
            try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) { }
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
                let parsed;
                try { parsed = JSON.parse(line); } catch (e) { continue; }
                if (parsed.fatal) { fatal = parsed.error || 'تست انجام نشد'; continue; }
                if (parsed.done) continue;
                window.handleV2rayProgress(Object.assign({ testType: type }, parsed));
            }
        }
    } catch (err) {
        if (err.name !== 'AbortError') fatal = err.message;
    }

    // ── finish: immediately, on the real counts ─────────────────────────────────
    saveV2rayList();
    window.renderV2rayList();

    restore.forEach(s => {
        s.el.disabled = false;
        s.el.classList.remove('is-busy');
        s.el.innerHTML = s.html;
    });
    window.isV2rayTesting = false;

    const st = window.v2rayTestState;
    const ok = targets.filter(i => window.v2rayList[i] && window.v2rayList[i][type] > 0).length;

    if (fatal) {
        paintTestProgress('تست انجام نشد');
        toast('❌ ' + fatal);
        v2rayShowNotice('danger', 'تست انجام نشد', fatal);
    } else if (window.v2rayTestAbortController && window.v2rayTestAbortController.signal.aborted) {
        paintTestProgress(`لغو شد — ${st.count} از ${st.total}`);
    } else {
        paintTestProgress(`تمام شد — ${ok} از ${st.total} سالم`);
        toast(`✅ تست تمام شد — ${ok} از ${st.total} کانفیگ سالم`);
        if (st.coreFailures > 0) {
            // A core that would not start says nothing about the node, and the user is told
            // which of the two happened instead of being left to guess from "Timeout".
            v2rayShowNotice('warn', `${st.coreFailures} کانفیگ آزمایش نشد`,
                'هسته‌ی Xray برای این تعداد بالا نیامد (معمولاً پورت اشغال یا کانفیگی که هسته قبول نمی‌کند). دوباره تست بزنید یا برنامه را ری‌استارت کنید.');
        } else {
            v2rayHideNotice();
        }
        if (typeof window.triggerNotification === 'function') {
            const label = type === 'delay' ? 'دیلی' : 'پینگ';
            window.triggerNotification(type === 'delay' ? 'delayFinished' : 'pingFinished',
                `تست ${label} تمام شد`, `${ok} از ${st.total} کانفیگ پاسخ داد.`);
        }
        // Only delay determines order; a ping sweep must not change the chosen direction.
        if (ok > 0 && type === 'delay') v2raySortBy(store.get(SORT_KEY, 'delay'), { quiet: true });
    }
    hideTestProgress();
};

window.abortV2rayTest = function (e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    window.openModal('cancelTestModal');
};

window.confirmAbortV2rayTest = function () {
    if (window.v2rayTestAbortController) window.v2rayTestAbortController.abort();
    window.closeModal('cancelTestModal');
    toast('تست لغو شد.');
};

window.togglePlatformTest = function (checked) {
    window.isPlatformTestEnabled = !!checked;
    const container = document.getElementById('v2ray-platform-container');
    if (!container) return;
    container.classList.toggle('hidden', !checked);
    if (checked) window.renderPlatformList();
};

window.renderPlatformList = function () {
    const list = document.getElementById('v2ray-platform-list');
    if (!list) return;
    list.innerHTML = window.v2rayPlatformTargets.map(p => `
        <button type="button" class="v2-plat${window.activePlatformTarget === p.url ? ' is-on' : ''}"
            onclick="window.activePlatformTarget='${p.url}'; window.renderPlatformList();">
            ${p.icon}<span>${p.name}</span>
        </button>`).join('');
};

window.testPlatformDelay = function (event) {
    if (!window.activePlatformTarget) { toast('لطفاً یک پلتفرم انتخاب کنید'); return; }
    window.testNodesUI(event, 'delay');
};

// ──────────────────────────────────────────────────────────────────────────────
// A notice inside the panel (K6 callout) — for things a toast is too short-lived for
// ──────────────────────────────────────────────────────────────────────────────
function v2rayShowNotice(tone, title, body) {
    const row = document.getElementById('v2ray-notice');
    if (!row) return;
    row.className = 'mv-form-row mv-callout is-' + (tone === 'danger' ? 'danger' : 'warn');
    row.innerHTML = `<i class="ph-bold ph-${tone === 'danger' ? 'warning-octagon' : 'warning'}"></i>
        <span><b>${title}</b><br>${body}</span>`;
    row.hidden = false;
}
function v2rayHideNotice() {
    const row = document.getElementById('v2ray-notice');
    if (row) row.hidden = true;
}

// ──────────────────────────────────────────────────────────────────────────────
// Styles — only what the kit has no class for
// ──────────────────────────────────────────────────────────────────────────────
// TRAP: this stylesheet lives inside a template literal, so a backtick anywhere in it — a
// comment included — ends the string and breaks the whole panel. Do not use one.
const v2rayStyles = document.createElement('style');
v2rayStyles.innerHTML = `
#v2ray-wrapper {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--mv-pane);
    color: var(--mv-label);
    container-type: inline-size;
    container-name: v2ray;
}
#nodes-container { padding: 4px 22px 26px; }

/* Live speed, in the status head's trailing slot. */
.v2-speeds { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; font-family: var(--mv-font-tech); }
.v2-speeds > span { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; }
.v2-speeds > span > b { font-weight: 600; color: var(--mv-label); }
.v2-speeds > small { font-size: 10.5px; color: var(--mv-label-3); }
.v2-speeds.hidden { display: none; }

/* The two whole-list tests, and the platform strip under them. */
.v2-tests { display: flex; gap: 8px; width: 100%; }
.v2-tests > .mv-btn { flex: 1; min-width: 0; }
.mv-btn.is-busy { opacity: .55; cursor: progress; }
.v2-platforms { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; }
.v2-platforms > #v2ray-platform-list { flex: 1; min-width: 0; display: flex; gap: 6px; overflow-x: auto; padding-bottom: 2px; }
.v2-plat {
    flex: none;
    height: 28px;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 0 10px;
    border: 0;
    border-radius: 999px;
    background: var(--mv-fill);
    color: var(--mv-label-2);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
}
.v2-plat:hover { background: var(--mv-fill-2); }
.v2-plat.is-on { background: var(--mv-accent); color: #FFFFFF; }
.v2-plat svg, .v2-plat i { font-size: 13px; }
.mv-form-row.is-stack.hidden { display: none; }

/* Panel / sub-group tabs: pills, scrolled sideways when there are many. */
.v2-tabs { display: flex; gap: 6px; overflow-x: auto; margin: 0 2px 8px; padding-bottom: 2px; }
.v2-tabs.hidden { display: none; }
.v2-tabs > button {
    flex: none;
    height: 26px;
    padding: 0 11px;
    border: 0;
    border-radius: 999px;
    background: var(--mv-fill);
    color: var(--mv-label-2);
    font: inherit;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;
}
.v2-tabs > button:hover { background: var(--mv-fill-2); }
.v2-tabs > button.is-on { background: var(--mv-accent); color: #FFFFFF; }
.v2-tabs > button > span.count { margin-inline-start: 5px; font-family: var(--mv-font-tech); opacity: .75; }

/* The sort pop-up, hung under its toolbar capsule (the kit's menu). */
#sortMenuContainer { position: relative; }
#sortDropdownMenu {
    position: absolute;
    top: 34px;
    inset-inline-start: 0;
    min-width: 210px;
    display: flex;
    flex-direction: column;
    gap: 1px;
}
#sortDropdownMenu.hidden { display: none; }

/* A node row's figures and its hover actions (rows are K3 .mv-li list rows). */
.v2-node-nums { flex: none; display: flex; align-items: center; gap: 10px; }
.v2-node-nums > div {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
    min-width: 48px;
    font-family: var(--mv-font-tech);
    font-variant-numeric: tabular-nums;
}
.v2-node-nums small { font-size: 9.5px; color: var(--mv-label-3); text-transform: uppercase; }
.v2-node-acts { flex: none; display: flex; align-items: center; gap: 2px; opacity: 0; transition: opacity var(--mv-d-1) var(--mv-ease-out); }
.mv-li:hover .v2-node-acts,
.mv-li:focus-within .v2-node-acts { opacity: 1; }
.v2-node-acts button {
    width: 26px;
    height: 26px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: none;
    color: var(--mv-label-2);
    cursor: pointer;
}
.v2-node-acts button:hover { background: var(--mv-fill-2); color: var(--mv-label); }
.v2-menu-wrap { position: relative; }
.v2-protos { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 6px; width: 100%; }
.v2-protos > .mv-btn { width: 100%; font-family: var(--mv-font-tech); }
.v2-ok { font-size: 13px; font-weight: 700; color: var(--mv-green-ink); }
.v2-ok::after { content: "ms"; margin-inline-start: 1px; font-size: 9px; font-weight: 400; opacity: .7; }
.v2-bad { font-size: 10.5px; font-weight: 600; color: var(--mv-red-ink); cursor: help; }
.v2-none { color: var(--mv-label-3); }
.v2-spin { font-size: 12px; color: var(--mv-label-3); }
/* The name truncates; the protocol pill does not. Inside the truncating element it was the
   first thing an ellipsis ate, so every long-named config lost the one label that says what
   it is. */
.mv-li-text > b { display: flex; align-items: center; gap: 6px; }
.v2-nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v2-type { flex: none; padding: 1px 7px; border-radius: 999px; background: var(--mv-fill); color: var(--mv-label-2); font-family: var(--mv-font-tech); font-size: 10.5px; font-weight: 500; }
.v2-node-menu {
    position: absolute;
    top: 30px;
    inset-inline-end: 0;
    min-width: 168px;
    display: flex;
    flex-direction: column;
    gap: 1px;
}
.v2-node-menu.hidden { display: none; }

/* The test progress strip, which the window manager moves into the title bar. */
.v2-abort {
    flex: none;
    width: 16px;
    height: 16px;
    display: grid;
    place-items: center;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: var(--mv-fill-2);
    color: var(--mv-label-2);
    font-size: 9px;
    cursor: pointer;
}
.v2-abort:hover { background: var(--mv-fill-3); color: var(--mv-label); }

.v2-tooltip {
    position: fixed;
    z-index: 999999;
    width: 256px;
    padding: 10px 12px;
    border-radius: var(--mv-r-md, 10px);
    background: var(--mv-window, var(--mv-surface));
    box-shadow: var(--mv-hair), var(--mv-e4);
    color: var(--mv-label-2);
    font-size: 11.5px;
    line-height: 1.8;
    text-align: center;
    pointer-events: none;
    transition: opacity var(--mv-d-2) var(--mv-ease-out);
}

/* The QR card in the share sheet: a white ground is part of a scannable code. */
.v2-qr {
    width: 188px;
    height: 188px;
    margin: 0 auto;
    display: grid;
    place-items: center;
    padding: 10px;
    border-radius: var(--mv-r-lg, 14px);
    /* tokenize:off — a QR code needs real white behind it in both appearances */
    background: #FFFFFF;
    /* tokenize:on */
}

/* A radio that reads as one: the kit has no radio, so this is the one control drawn here. */
.material-radio {
    appearance: none;
    width: 18px;
    height: 18px;
    margin: 0;
    border: 1.5px solid var(--mv-sep-3);
    border-radius: 50%;
    position: relative;
    cursor: pointer;
    transition: border-color var(--mv-d-1) var(--mv-ease-out);
}
.material-radio:checked { border-color: var(--mv-accent); }
.material-radio:checked::after {
    content: "";
    position: absolute;
    inset: 3px;
    border-radius: 50%;
    background: var(--mv-accent);
}
.material-radio:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--mv-accent-ring); }

#v2ray-wrapper [hidden] { display: none !important; }
#v2ray-wrapper .v2-tool { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px; padding: 8px 4px; border: 0; border-radius: 12px; background: transparent; color: var(--mv-label); font: inherit; font-size: 10.5px; cursor: pointer; }
#v2ray-wrapper .v2-tool i { font-size: 20px; }
#v2ray-wrapper .v2-tool:hover { background: var(--mv-fill-2); }
#v2ray-wrapper .v2-tool.is-on { color: var(--mv-green-ink); }
#v2ray-wrapper .v2-tool:disabled { opacity: .45; cursor: progress; }
#v2ray-wrapper .v2-settings-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; padding: 14px; border-top: 1px solid var(--mv-sep); }
#v2ray-wrapper .v2-settings-actions .mv-btn { font-size: 10.5px; white-space: normal; }
#v2ray-wrapper .v2-node-acts .v2-node-menu button { width: auto; height: auto; display: flex; justify-content: flex-start; border-radius: 6px; padding: 8px 12px; }
/* V2Ray workspace: shared macOS materials, with the server library at its centre. */
#v2ray-wrapper, #v2ray-wrapper * { box-sizing: border-box; }
#v2ray-wrapper .v2-toolbar { padding: 12px 20px; justify-content: space-between; border-bottom: 1px solid var(--mv-sep); background: var(--mv-mat-thin); }
#v2ray-wrapper .v2-toolbar .mv-tb-btn:has(span) { width: auto; padding-inline: 12px; gap: 7px; color: var(--mv-blue-ink); font-size: 12px; }
#v2ray-wrapper #nodes-container { padding: 20px; }
#v2ray-wrapper .v2-workspace { display: flex; columns: auto; max-width: none; gap: 16px; }
#v2ray-wrapper .v2-workspace > * { margin-bottom: 0; min-width: 0; }
#v2ray-wrapper .v2-connection > .mv-form-group { display: block; border-radius: 18px; background: var(--mv-surface-2); box-shadow: inset 0 0 0 1px var(--mv-sep); }
#v2ray-wrapper .mv-status-head { padding: 22px 20px; gap: 14px; }
#v2ray-wrapper .mv-status-head::after { display: none; }
#v2ray-wrapper .mv-sh-text { flex: 1; }
#v2ray-wrapper #v2ray-tile { width: 48px; height: 48px; border-radius: 16px; flex-shrink: 0; }
#v2ray-wrapper #status-title { font-size: 18px; font-weight: 700; margin-bottom: 4px; }
#v2ray-wrapper #status-subtitle { font-size: 11.5px; line-height: 1.9; }
#v2ray-wrapper .v2-disclosure { display: block; border-radius: 12px; background: var(--mv-group); }
#v2ray-wrapper .v2-routing { border-radius: 0 0 18px 18px; border-top: 1px solid var(--mv-sep); background: transparent; }
#v2ray-wrapper .v2-disclosure > summary { display: flex; align-items: center; gap: 9px; padding: 13px 16px; list-style: none; cursor: pointer; font-size: 12px; font-weight: 600; }
#v2ray-wrapper .v2-disclosure > summary::-webkit-details-marker { display: none; }
#v2ray-wrapper .v2-disclosure > summary > i:first-child { font-size: 17px; color: var(--mv-blue-ink); }
#v2ray-wrapper .v2-disclosure > summary small { margin-inline-start: auto; font-size: 10.5px; font-weight: 400; color: var(--mv-label-2); }
#v2ray-wrapper .v2-disclosure > summary > i:last-child { color: var(--mv-label-3); transition: transform var(--mv-d-2); }
#v2ray-wrapper .v2-disclosure[open] > summary > i:last-child { transform: rotate(180deg); }
#v2ray-wrapper .v2-diagnostics .mv-form-group { background: transparent; box-shadow: none; }
#v2ray-wrapper .v2-diagnostics .mv-form-footer { padding: 0 12px 12px; }
#v2ray-wrapper .v2-library { gap: 10px; }
#v2ray-wrapper .v2-library-heading { display: flex; align-items: center; justify-content: space-between; margin: 5px 3px 0; font-size: 14px; }
#v2ray-wrapper .v2-library-heading small { font-size: 10.5px; font-weight: 400; color: var(--mv-label-2); }
#v2ray-wrapper .v2-library > .mv-form-group:has(#v2ray-panel-switch) { background: transparent; box-shadow: none; }
#v2ray-wrapper .v2-library .mv-form-row:has(#v2ray-panel-switch) { padding: 0 3px; min-height: 28px; }
#v2ray-wrapper .v2-library .mv-form-row .mv-form-label { font-size: 11.5px; color: var(--mv-label-2); }
#v2ray-wrapper .v2-library > .mv-form-group:has(.mv-list) { overflow: visible; background: transparent; box-shadow: none; }
#v2ray-wrapper #v2ray-nodes-list { display: flex; flex-direction: column; gap: 8px; }
#v2ray-wrapper .node-card { display: grid; grid-template-columns: 24px minmax(0, 1fr) 28px; gap: 8px 12px; padding: 14px; border-radius: 12px; background: var(--mv-surface-2); border: 1px solid var(--mv-sep); }
#v2ray-wrapper .node-card::before { display: none; }
#v2ray-wrapper .node-card:hover { background: var(--mv-surface-3); }
#v2ray-wrapper .node-card.is-sel, #v2ray-wrapper .node-card:has(input:checked) { border-color: var(--mv-accent); background: var(--mv-accent-soft); }
#v2ray-wrapper .node-card.is-on { border-inline-start: 3px solid var(--mv-green); }
#v2ray-wrapper .node-card .mv-li-text { min-width: 0; }
#v2ray-wrapper .node-card .mv-li-text > b { font-size: 12px; }
#v2ray-wrapper .node-card .mv-li-text > small { font-size: 10.5px; opacity: .85; }
#v2ray-wrapper .v2-node-nums { grid-column: 2; grid-row: 2; justify-content: flex-start; gap: 16px; }
#v2ray-wrapper .v2-node-nums > div { flex-direction: row-reverse; gap: 5px; min-width: 0; }
#v2ray-wrapper .v2-node-acts { grid-column: 3; grid-row: 1 / 3; opacity: 1; }
#v2ray-wrapper .v2-node-acts > button { display: grid; }
#v2ray-wrapper .node-card:hover .v2-node-acts > button, #v2ray-wrapper .node-card:focus-within .v2-node-acts > button { display: grid; }
#v2ray-wrapper .v2-node-menu { z-index: var(--mv-z-menu); }
#v2ray-wrapper .v2-connect-bar { padding: 16px 20px; gap: 10px; background: var(--mv-mat-regular); border-top: 1px solid var(--mv-sep); backdrop-filter: var(--mv-blur-thin); }
#v2ray-wrapper .v2-connect-bar { background: radial-gradient(ellipse at 15% 100%, color-mix(in srgb, var(--mv-red) 18%, transparent), transparent 70%), var(--mv-mat-regular); }
#v2ray-wrapper:has(.node-card.is-on) .v2-connect-bar { background: radial-gradient(ellipse at 15% 100%, color-mix(in srgb, var(--mv-green) 25%, transparent), transparent 75%), var(--mv-mat-regular); }
#v2ray-wrapper:has(#btn-main-connect:disabled) .v2-connect-bar { background: radial-gradient(ellipse at 15% 100%, color-mix(in srgb, var(--mv-orange) 25%, transparent), transparent 75%), var(--mv-mat-regular); }
#v2ray-wrapper .v2-connect-icon { font-size: 20px; color: var(--mv-blue-ink); }
#v2ray-wrapper #btn-main-connect { min-width: 112px; border-radius: 999px; }
#v2ray-wrapper .mv-empty { padding: 38px 20px; border: 1px dashed var(--mv-sep-2); border-radius: 16px; }
#v2ray-wrapper :is(button, summary):focus-visible { outline: 2px solid var(--mv-accent); outline-offset: 3px; }
@container v2ray (min-width: 760px) {
  #v2ray-wrapper .v2-toolbar { gap: 6px; justify-content: flex-start; padding: 10px 24px; }
  #v2ray-wrapper .v2-tool { flex: 0 0 auto; flex-direction: row; gap: 8px; padding: 9px 14px; font-size: 12px; border-radius: 8px; }
  #v2ray-wrapper .v2-tool i { font-size: 18px; }
  #v2ray-wrapper .v2-tool:nth-child(3) { background: var(--mv-accent-soft); color: var(--mv-blue-ink); margin-inline: 10px; }
  #v2ray-wrapper #nodes-container { padding: 24px; }
  #v2ray-wrapper .v2-workspace { display: grid; grid-template-columns: 300px minmax(0, 1fr); grid-template-rows: auto auto 1fr; gap: 16px 24px; align-items: start; min-height: 100%; }
  #v2ray-wrapper .v2-connection { grid-column: 1; grid-row: 1; }
  #v2ray-wrapper .v2-diagnostics { grid-column: 1; grid-row: 2; }
  #v2ray-wrapper .v2-library { grid-column: 2; grid-row: 1 / 4; }
  #v2ray-wrapper .v2-library-heading { margin: 0 0 10px; font-size: 19px; }
  #v2ray-wrapper .v2-library-heading small { font-size: 12px; }
  #v2ray-wrapper .v2-library > .mv-form-group:has(#v2ray-panel-switch) { border-bottom: 1px solid var(--mv-sep); padding-bottom: 12px; margin-bottom: 4px; }
  #v2ray-wrapper .node-card { min-height: 70px; grid-template-columns: 24px minmax(0, 1fr) 120px 28px; gap: 14px; padding: 12px 16px; border-radius: 10px; }
  #v2ray-wrapper .node-card .mv-li-text > b { font-size: 13px; justify-content: flex-end; }
  #v2ray-wrapper .node-card .mv-li-text > small { font-size: 11px; margin-top: 6px; text-align: right; }
  #v2ray-wrapper .v2-node-nums { grid-column: 3; grid-row: 1; justify-content: space-around; gap: 10px; direction: ltr; }
  #v2ray-wrapper .v2-node-nums > div { flex-direction: column; gap: 3px; }
  #v2ray-wrapper .v2-node-acts { grid-column: 4; grid-row: 1; }
  #v2ray-wrapper .v2-connect-bar { padding: 14px 24px; }
  #v2ray-wrapper #btn-main-connect { min-width: 150px; border-radius: 10px; }
  #v2ray-wrapper .v2-connect-icon { margin-inline-end: 4px; }
}
@container v2ray (min-width: 1200px) {
  #v2ray-wrapper .v2-workspace { grid-template-columns: 330px minmax(0, 1fr); gap: 20px 32px; }
  #v2ray-wrapper .node-card { grid-template-columns: 24px minmax(0, 1fr) 160px 28px; }
}
@container v2ray (max-width: 420px) {
  #v2ray-wrapper #nodes-container { padding: 12px; }
  #v2ray-wrapper .v2-toolbar { padding: 10px; }
  #v2ray-wrapper .v2-library-heading small { display: none; }
  #v2ray-wrapper .mv-status-head { padding: 16px 12px; }
}
@media (prefers-reduced-motion: reduce) {
  #v2ray-wrapper *, #v2ray-wrapper *::after { transition: none !important; }
}

/* ── Unified V2Ray shell ─────────────────────────────────────────────────
   Windows supplies the split-window anatomy and grouped controls. Android supplies the
   five list actions, compact server rows and the always-reachable connection bar. */
#v2ray-wrapper.mv-split {
  flex-direction: row;
  align-items: stretch;
  background: var(--mv-pane);
}
#v2ray-wrapper .v2-side { width: 276px; }
#v2ray-wrapper .v2-side-status {
  flex: none;
  display: grid;
  grid-template-columns: 46px minmax(0, 1fr);
  align-items: center;
  gap: 11px;
  padding: 10px 12px 14px;
  border-bottom: var(--mv-hl) solid var(--mv-side-edge);
}
#v2ray-wrapper .v2-side-status > .mv-side-tile {
  width: 46px;
  height: 46px;
  border-radius: 12px;
  font-size: 22px;
}
#v2ray-wrapper .v2-side-status h2 { margin: 0; font-size: 14px; font-weight: 700; }
#v2ray-wrapper .v2-side-status p { margin: 2px 0 0; font-size: 11px; line-height: 1.7; color: var(--mv-label-2); }
#v2ray-wrapper .v2-side-status .v2-speeds {
  grid-column: 1 / -1;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  padding-top: 8px;
  border-top: var(--mv-hl) solid var(--mv-side-edge);
}
#v2ray-wrapper .v2-side-status .v2-speeds small { margin-inline-start: auto; }
#v2ray-wrapper .v2-side > .mv-callout { margin: 8px; border-radius: 9px; }
#v2ray-wrapper .v2-side-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 10px 14px;
}
#v2ray-wrapper .v2-side-scroll .mv-form-section + .mv-form-section { margin-top: 16px; }
#v2ray-wrapper .v2-side-scroll .mv-form-header { margin-inline: 4px; font-size: 11.5px; }
#v2ray-wrapper .v2-side-scroll .mv-form-group { border-radius: 10px; }
#v2ray-wrapper .v2-side-scroll .mv-form-row { min-height: 46px; padding: 8px 11px; gap: 8px; }
#v2ray-wrapper .v2-side-scroll .mv-form-label { font-size: 12px; }
#v2ray-wrapper .v2-side-scroll .mv-form-label small { font-size: 10.5px; line-height: 1.6; }
#v2ray-wrapper .v2-side-actions { margin-top: 16px; }
#v2ray-wrapper .v2-side-actions .mv-side-item { height: 34px; }

#v2ray-wrapper .v2-pane { min-width: 0; }
#v2ray-wrapper .v2-pane > .mv-pane-bar {
  height: 56px;
  padding-inline: 18px;
  border-bottom: var(--mv-hl) solid transparent;
}
#v2ray-wrapper .v2-pane .mv-pane-title { font-size: 16px; }
#v2ray-wrapper .v2-count {
  flex: none;
  padding: 2px 7px;
  border-radius: 999px;
  background: var(--mv-fill);
  color: var(--mv-label-2);
  font-family: var(--mv-font-tech);
  font-size: 10.5px;
}
#v2ray-wrapper .v2-toolbar {
  flex: none;
  display: inline-flex;
  height: 32px;
  margin-inline-start: auto;
  padding: 2px;
  gap: 1px;
  justify-content: flex-start;
}
#v2ray-wrapper .v2-toolbar .v2-tool {
  flex: none;
  width: auto;
  height: 28px;
  flex-direction: row;
  gap: 5px;
  padding: 0 9px;
  border-radius: 999px;
  background: transparent;
  color: var(--mv-label);
  font-size: 11px;
}
#v2ray-wrapper .v2-toolbar .v2-tool i { font-size: 15px; }
#v2ray-wrapper .v2-toolbar .v2-tool:nth-child(3) { margin: 0; background: transparent; color: var(--mv-label); }
#v2ray-wrapper .v2-toolbar .v2-tool:hover { background: var(--mv-fill); }
#v2ray-wrapper .v2-toolbar .v2-tool.is-on { color: var(--mv-green-ink); background: var(--mv-fill); }
#v2ray-wrapper .v2-pane > .mv-pane-scroll { padding: 10px 18px 24px; }
#v2ray-wrapper .v2-library { width: 100%; max-width: 920px; margin-inline: auto; gap: 8px; }
#v2ray-wrapper .v2-list-options {
  display: flex;
  justify-content: flex-end;
  min-height: 34px;
  border-bottom: var(--mv-hl) solid var(--mv-sep);
}
#v2ray-wrapper .v2-list-options .mv-form-row {
  width: auto;
  min-height: 32px;
  padding: 2px 4px 8px;
  gap: 8px;
  color: var(--mv-label-2);
}
#v2ray-wrapper .v2-list-options .mv-form-label { font-size: 11.5px; color: var(--mv-label-2); }
#v2ray-wrapper .v2-list-group {
  overflow: visible;
  border-radius: 12px;
  background: var(--mv-group);
  box-shadow: inset 0 0 0 var(--mv-hl) var(--mv-group-edge);
}
#v2ray-wrapper #v2ray-nodes-list { gap: 0; }
#v2ray-wrapper .node-card {
  position: relative;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) 126px 30px;
  align-items: center;
  gap: 11px;
  min-height: 62px;
  padding: 9px 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  cursor: pointer;
}
#v2ray-wrapper .node-card:first-child { border-radius: 12px 12px 0 0; }
#v2ray-wrapper .node-card:last-child { border-radius: 0 0 12px 12px; }
#v2ray-wrapper .node-card:only-child { border-radius: 12px; }
#v2ray-wrapper .node-card + .node-card::before {
  display: block;
  inset-inline: 57px 12px;
  background: var(--mv-group-sep);
}
#v2ray-wrapper .node-card:hover { background: var(--mv-fill); }
#v2ray-wrapper .node-card.is-sel,
#v2ray-wrapper .node-card:has(input:checked) { background: var(--mv-accent-soft); }
#v2ray-wrapper .node-card.is-on { background: color-mix(in srgb, var(--mv-green) 11%, transparent); }
#v2ray-wrapper .v2ray-node-check {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
#v2ray-wrapper .v2-node-glyph {
  grid-column: 1;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 9px;
  background: color-mix(in srgb, var(--node-tint, var(--mv-indigo)) 18%, transparent);
  color: var(--node-tint, var(--mv-indigo-ink));
  font-size: 16px;
}
#v2ray-wrapper .node-card.is-on .v2-node-glyph { --node-tint: var(--mv-green); color: var(--mv-green-ink); }
#v2ray-wrapper .node-card .mv-li-text { grid-column: 2; min-width: 0; }
#v2ray-wrapper .node-card .mv-li-text > b { justify-content: flex-start; font-size: 12.5px; }
#v2ray-wrapper .node-card .mv-li-text > small { margin-top: 3px; font-size: 10.5px; text-align: left; }
#v2ray-wrapper .v2-type { padding: 1px 6px; font-size: 9.5px; }
#v2ray-wrapper .v2-node-nums {
  grid-column: 3;
  grid-row: 1;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  direction: ltr;
}
#v2ray-wrapper .v2-node-nums > div { min-width: 0; flex-direction: column; gap: 1px; }
#v2ray-wrapper .v2-node-nums small { font-size: 8.5px; }
#v2ray-wrapper .v2-node-acts { grid-column: 4; grid-row: 1; opacity: 1; }
#v2ray-wrapper .v2-node-acts > .v2-menu-wrap > button { color: var(--mv-label-3); }
#v2ray-wrapper .v2-node-menu { z-index: var(--mv-z-menu); }

#v2ray-wrapper .v2-connect-bar {
  min-height: 64px;
  padding: 10px 18px;
  background: radial-gradient(ellipse at 85% 130%, color-mix(in srgb, var(--mv-indigo) 16%, transparent), transparent 65%), var(--mv-pane);
  cursor: pointer;
}
#v2ray-wrapper:has(.node-card.is-on) .v2-connect-bar {
  background: radial-gradient(ellipse at 85% 130%, color-mix(in srgb, var(--mv-green) 24%, transparent), transparent 68%), var(--mv-pane);
}
#v2ray-wrapper:has(#btn-main-connect:disabled) .v2-connect-bar {
  background: radial-gradient(ellipse at 85% 130%, color-mix(in srgb, var(--mv-orange) 24%, transparent), transparent 68%), var(--mv-pane);
}
#v2ray-wrapper .v2-connect-state { display: flex; align-items: center; gap: 7px; font-size: 11.5px; font-weight: 600; color: var(--mv-label-2); }
#v2ray-wrapper .v2-connect-icon { margin: 0; color: var(--mv-indigo-ink); }
#v2ray-wrapper .v2-connect-bar .mv-bb-lead { font-size: 13px; color: var(--mv-label); }
#v2ray-wrapper #btn-main-connect { min-width: 116px; border-radius: 8px; }

@container v2ray (max-width: 880px) {
  #v2ray-wrapper .v2-side { width: 252px; }
  #v2ray-wrapper .v2-toolbar .v2-tool { width: 30px; padding: 0; }
  #v2ray-wrapper .v2-toolbar .v2-tool span { display: none; }
  #v2ray-wrapper .node-card { grid-template-columns: 34px minmax(0, 1fr) 106px 30px; }
  #v2ray-wrapper .v2-connect-state { display: none; }
}
`;
document.head.appendChild(v2rayStyles);

// ──────────────────────────────────────────────────────────────────────────────
// Markup
// ──────────────────────────────────────────────────────────────────────────────
const v2rayHtmlTemplate = `
<div id="v2ray-wrapper" class="mv-split" dir="rtl">
  <!-- Windows identity: the same inset glass sidebar used by Settings. -->
  <aside class="mv-side v2-side" aria-label="وضعیت و تنظیمات V2Ray">
    <div class="mv-side-top"></div>
    <div class="v2-side-status">
      <span class="mv-side-tile" id="v2ray-tile" style="--tint:var(--mv-indigo)">
        <i class="ph-bold ph-power"></i>
      </span>
      <div class="mv-sh-text">
        <h2 id="status-title">آماده‌ی اتصال</h2>
        <p id="status-subtitle">یک کانفیگ را انتخاب کنید</p>
      </div>
      <div id="v2ray-traffic-stats" class="v2-speeds hidden" dir="ltr">
        <span><i class="ph-bold ph-arrow-up"></i><b id="stat-upload-speed">0 B/s</b></span>
        <span><i class="ph-bold ph-arrow-down"></i><b id="stat-download-speed">0 B/s</b></span>
        <small>Total: <span id="stat-total-traffic">0 B</span></small>
      </div>
    </div>
    <div class="mv-form-row mv-callout is-warn" id="v2ray-notice" hidden></div>

    <div class="v2-side-scroll custom-scrollbar">
      <section class="mv-form-section">
        <div class="mv-form-header">اتصال</div>
        <div class="mv-form-group">
          <label class="mv-form-row">
            <span class="mv-form-label">پروکسی سیستم<small>برای مرورگرها و برنامه‌های ویندوز</small></span>
            <input type="checkbox" id="systemProxyToggle" class="mv-switch-input" onchange="window.handleSystemProxyToggle(this.checked)">
          </label>
          <label class="mv-form-row">
            <span class="mv-form-label">تونل کامل<small>عبور تمام ترافیک سیستم</small></span>
            <input type="checkbox" id="v2rayTunToggle" class="mv-switch-input" onchange="window.handleV2rayTunToggle(this.checked)">
          </label>
          <label class="mv-form-row">
            <span class="mv-form-label">فقط همین کانفیگ<small>بدون توزیع بار با پنل‌های ابری</small></span>
            <input type="checkbox" id="v2raySoloToggle" class="mv-switch-input" onchange="window.setV2raySolo(this.checked)">
          </label>
        </div>
      </section>

      <section class="mv-form-section">
        <div class="mv-form-header">آزمایش برای سرویس‌ها</div>
        <div class="mv-form-group">
          <label class="mv-form-row">
            <span class="mv-form-label">تست پلتفرم‌محور<small>اندازه‌گیری تا سرویس انتخابی</small></span>
            <input type="checkbox" id="v2ray-platform-switch" class="mv-switch-input" onchange="window.togglePlatformTest(this.checked)">
          </label>
          <div class="mv-form-row is-stack hidden" id="v2ray-platform-container">
            <div class="v2-platforms">
              <button type="button" class="mv-btn mv-btn--primary" onclick="window.testPlatformDelay(event)"><i class="ph-bold ph-lightning"></i>تست</button>
              <div id="v2ray-platform-list" class="custom-scrollbar"></div>
            </div>
          </div>
        </div>
      </section>

      <nav class="v2-side-actions" aria-label="ابزارهای بیشتر">
        <div class="mv-form-header">ابزارها</div>
        <button type="button" class="mv-side-item" onclick="window.openFreeConfigsModal()"><span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="ph-fill ph-download-simple"></i></span><span>کانفیگ رایگان</span></button>
        <button type="button" class="mv-side-item" onclick="window.openCombinationCenter()"><span class="mv-side-tile" style="--tint:var(--mv-indigo)"><i class="ph-fill ph-squares-four"></i></span><span>مرکز ترکیب</span></button>
        <button type="button" class="mv-side-item" onclick="window.copyHealthyV2rayConfigs()"><span class="mv-side-tile" style="--tint:var(--mv-green)"><i class="ph-fill ph-copy"></i></span><span>کپی کانفیگ‌های سالم</span></button>
        <button type="button" class="mv-side-item" onclick="window.openModal('deleteAllModal')"><span class="mv-side-tile" style="--tint:var(--mv-red)"><i class="ph-fill ph-trash"></i></span><span>پاک‌سازی کانفیگ‌ها</span></button>
      </nav>
    </div>
  </aside>

  <!-- Android identity: the same five list actions, adapted to a Windows toolbar. -->
  <section class="mv-pane v2-pane">
    <header class="mv-pane-bar">
      <h1 class="mv-pane-title">کانفیگ‌ها</h1>
      <span class="v2-count" id="v2ray-node-count">۰ کانفیگ</span>
      <div class="mv-tb-group v2-toolbar" role="toolbar" aria-label="ابزارهای کانفیگ">
        <button type="button" id="btn-global-test-ping" class="mv-tb-btn v2-tool" onclick="window.testNodesUI(event, 'ping')" title="تست پینگ"><i class="ph-bold ph-pulse"></i><span>پینگ</span></button>
        <button type="button" id="btn-global-test-delay" class="mv-tb-btn v2-tool" onclick="window.testNodesUI(event, 'delay')" title="تست دیلی"><i class="ph-bold ph-clock"></i><span>دیلی</span></button>
        <button type="button" class="mv-tb-btn v2-tool" onclick="window.openModal('importModal')" title="افزودن کانفیگ"><i class="ph-bold ph-plus"></i><span>افزودن</span></button>
        <button type="button" id="v2-sort-button" class="mv-tb-btn v2-tool" onclick="window.sortV2rayList()" title="مرتب‌سازی بر اساس دیلی"><i class="ph-bold ph-sort-ascending"></i><span>مرتب‌سازی</span></button>
        <button type="button" class="mv-tb-btn v2-tool" onclick="document.querySelector('.v2-side-scroll').scrollTo({top:0,behavior:'smooth'})" title="تنظیمات اتصال"><i class="ph-bold ph-sliders-horizontal"></i><span>تنظیمات</span></button>
      </div>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="nodes-container">
      <section class="mv-form-section v2-library">
        <div class="v2-list-options">
          <label class="mv-form-row">
            <span class="mv-form-label">گروه‌بندی بر اساس پنل</span>
            <input type="checkbox" id="v2ray-panel-switch" class="mv-switch-input" onchange="window.toggleV2rayGrouping(event)">
          </label>
        </div>
        <div id="v2ray-panel-tabs" class="v2-tabs hidden"></div>
        <div id="v2ray-sub-tabs" class="v2-tabs is-sub hidden"></div>
        <div class="mv-form-group v2-list-group">
          <div id="v2ray-nodes-list" class="mv-list"></div>
        </div>
      </section>
    </div>

    <div class="mv-bottom-bar v2-connect-bar" onclick="if (!event.target.closest('button')) window.toggleV2rayConnection()">
      <span class="v2-connect-state"><i class="ph-bold ph-link v2-connect-icon" aria-hidden="true"></i><span>آماده برای اتصال</span></span>
      <div class="mv-bb-lead" id="v2ray-bb-lead"><span>یک کانفیگ را انتخاب کنید</span></div>
      <div class="mv-bb-end">
        <button type="button" id="btn-main-connect" class="mv-btn mv-btn--lg mv-btn--primary" onclick="window.toggleV2rayConnection()">
          <i class="ph-bold ph-power" id="connect-spinner"></i><span id="btn-connect-label">اتصال</span>
        </button>
      </div>
    </div>
  </section>
</div>

<!-- ═══ Sheets (K8) ══════════════════════════════════════════════════════════ -->
<div id="modal-backdrop" class="fixed inset-0 bg-mv-scrim backdrop-blur-sm z-40 hidden opacity-0 transition-opacity duration-300"></div>

<!-- 1 · Add a config -->
<div id="importModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4">
  <div class="mv-sheet scale-95 opacity-0" id="importModalContent" role="dialog" aria-modal="true" aria-labelledby="importModalTitle">
    <div class="mv-sheet-bar">
      <h3 id="importModalTitle">افزودن کانفیگ</h3>
      <button type="button" class="mv-sheet-close" onclick="window.closeModal('importModal')" title="بستن" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
    </div>
    <div class="mv-sheet-body custom-scrollbar">
      <div class="mv-form">
        <div class="mv-form-section">
          <div class="mv-form-header">چسباندن لینک</div>
          <div class="mv-form-group">
            <div class="mv-form-row is-stack">
              <textarea id="import-links-textarea" class="mv-field" rows="3" dir="ltr" spellcheck="false"
                placeholder="vless://…&#10;trojan://…&#10;vmess://…&#10;ss://…" aria-label="لینک‌های کانفیگ"
                style="width:100%;height:auto;min-height:74px;padding:8px 10px;resize:vertical;text-align:left"></textarea>
            </div>
          </div>
          <p class="mv-form-footer">هر لینک در یک خط. نام خودِ لینک (بعد از #) نگه داشته می‌شود و لینک‌های تکراری دوباره اضافه نمی‌شوند.</p>
        </div>
        <div class="mv-form-section">
          <div class="mv-form-header">راه‌های دیگر</div>
          <div class="mv-form-group">
            <button type="button" class="mv-form-row is-action" onclick="window.importFromClipboard()">
              <span class="mv-row-mark"><i class="ph-fill ph-clipboard"></i></span>
              <span class="mv-form-label">از کلیپ‌بورد<small>هرچه در حافظه کپی شده خوانده و افزوده می‌شود</small></span>
              <i class="ph-bold ph-caret-left mv-row-end"></i>
            </button>
            <button type="button" class="mv-form-row is-action" onclick="window.closeModal('importModal'); window.openSubModal()">
              <span class="mv-row-mark"><i class="ph-fill ph-link"></i></span>
              <span class="mv-form-label">لینک اشتراک<small>یک آدرس Subscription که فهرست کانفیگ‌ها را می‌دهد</small></span>
              <i class="ph-bold ph-caret-left mv-row-end"></i>
            </button>
            <button type="button" class="mv-form-row is-action" onclick="window.closeModal('importModal'); window.addCustomConfig()">
              <span class="mv-row-mark"><i class="ph-fill ph-note-pencil"></i></span>
              <span class="mv-form-label">کانفیگ دستی<small>JSON کامل یا فیلد به فیلد</small></span>
              <i class="ph-bold ph-caret-left mv-row-end"></i>
            </button>
            <button type="button" class="mv-form-row is-action" onclick="window.closeModal('importModal'); window.openSniBuilderModal()">
              <span class="mv-row-mark"><i class="ph-fill ph-star"></i></span>
              <span class="mv-form-label">ساخت کانفیگ SNI<small>از روی کانفیگ‌هایی که سرورشان ورکر کلادفلر است</small></span>
              <i class="ph-bold ph-caret-left mv-row-end"></i>
            </button>
          </div>
        </div>
        <div class="mv-form-section">
          <div class="mv-form-header">ساختن از صفر، با پروتکل</div>
          <div class="mv-form-group">
            <div class="mv-form-row is-stack">
              <div class="v2-protos">
                <button type="button" class="mv-btn" onclick="window.closeModal('importModal'); window.addProtocolConfig('vless')">VLESS</button>
                <button type="button" class="mv-btn" onclick="window.closeModal('importModal'); window.addProtocolConfig('trojan')">Trojan</button>
                <button type="button" class="mv-btn" onclick="window.closeModal('importModal'); window.addProtocolConfig('vmess')">VMess</button>
                <button type="button" class="mv-btn" onclick="window.closeModal('importModal'); window.addProtocolConfig('shadowsocks')">Shadowsocks</button>
              </div>
            </div>
          </div>
          <p class="mv-form-footer">هسته‌ی Xray همین چهار پروتکل را حرف می‌زند. Hysteria2 و WireGuard از این پنل ساخته نمی‌شوند — برای وایرگارد از اپ «وایرگارد» استفاده کنید.</p>
        </div>
      </div>
    </div>
    <div class="mv-sheet-foot">
      <button type="button" class="mv-btn" onclick="window.closeModal('importModal')">انصراف</button>
      <button type="button" id="btn-save-import" class="mv-btn mv-btn--primary" onclick="window.importV2rayNodes()">افزودن لینک‌ها</button>
    </div>
  </div>
</div>

<!-- 2 · Edit a config -->
<div id="editModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4">
  <div class="mv-sheet scale-95 opacity-0" id="editModalContent" role="dialog" aria-modal="true" aria-labelledby="editModalTitle">
    <div class="mv-sheet-bar">
      <h3 id="editModalTitle">ویرایش کانفیگ</h3>
      <button type="button" class="mv-sheet-close" onclick="window.closeModal('editModal')" title="بستن" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
    </div>
    <div class="mv-sheet-body custom-scrollbar">
      <div class="mv-form">

        <!-- A value that is a long string gets the row to itself (label above, field below):
             inline, the field ate the width and every label wrapped onto three lines. -->
        <div class="mv-form-section">
          <div class="mv-form-header">پایه</div>
          <div class="mv-form-group">
            <label class="mv-form-row is-stack"><span class="mv-form-label">نام</span>
              <input type="text" id="edit-remark" class="mv-field" dir="ltr" style="width:100%"></label>
            <label class="mv-form-row is-stack"><span class="mv-form-label">آدرس سرور</span>
              <input type="text" id="edit-address" class="mv-field" dir="ltr" style="width:100%"></label>
            <label class="mv-form-row"><span class="mv-form-label">پورت</span>
              <input type="number" id="edit-port" class="mv-field mv-field--compact" dir="ltr" style="width:84px"></label>
            <label class="mv-form-row is-stack"><span class="mv-form-label">UUID / رمز</span>
              <input type="text" id="edit-password" class="mv-field mv-form-mono" dir="ltr" style="width:100%"></label>
          </div>
        </div>

        <div class="mv-form-section">
          <div class="mv-form-header">انتقال</div>
          <div class="mv-form-group">
            <label class="mv-form-row"><span class="mv-form-label">نوع (network)</span>
              <select id="edit-network" class="mv-field" dir="ltr" style="width:150px">
                <option value="tcp">tcp</option>
                <option value="raw">raw</option>
                <option value="ws">ws</option>
                <option value="grpc">grpc</option>
                <option value="httpupgrade">httpupgrade</option>
                <option value="xhttp">xhttp</option>
              </select></label>
            <label class="mv-form-row is-stack"><span class="mv-form-label">Host</span>
              <input type="text" id="edit-host" class="mv-field" dir="ltr" style="width:100%"></label>
            <label class="mv-form-row is-stack"><span class="mv-form-label">Path / ServiceName</span>
              <input type="text" id="edit-path" class="mv-field" dir="ltr" style="width:100%"></label>
            <label class="mv-form-row is-stack"><span class="mv-form-label">Flow<small>فقط برای VLESS با XTLS</small></span>
              <input type="text" id="edit-flow" class="mv-field" dir="ltr" placeholder="xtls-rprx-vision" style="width:100%"></label>
          </div>
          <p class="mv-form-footer">«نوع»‌های دیگر (h2، quic) در هسته‌ی این نسخه وجود ندارند و کانفیگ را از کار می‌اندازند، پس اینجا نیستند.</p>
        </div>

        <div class="mv-form-section">
          <div class="mv-form-header">امنیت</div>
          <div class="mv-form-group">
            <label class="mv-form-row"><span class="mv-form-label">Security</span>
              <select id="edit-tls" class="mv-field" dir="ltr" style="width:150px">
                <option value="none">none</option>
                <option value="tls">tls</option>
                <option value="reality">reality</option>
              </select></label>
            <label class="mv-form-row is-stack"><span class="mv-form-label">SNI</span>
              <input type="text" id="edit-sni" class="mv-field" dir="ltr" style="width:100%"></label>
            <label class="mv-form-row"><span class="mv-form-label">Fingerprint</span>
              <select id="edit-fingerprint" class="mv-field" dir="ltr" style="width:150px">
                <option value="chrome">chrome</option>
                <option value="firefox">firefox</option>
                <option value="safari">safari</option>
                <option value="ios">ios</option>
                <option value="android">android</option>
                <option value="edge">edge</option>
                <option value="random">random</option>
              </select></label>
            <label class="mv-form-row"><span class="mv-form-label">ALPN</span>
              <input type="text" id="edit-alpn" class="mv-field" dir="ltr" placeholder="http/1.1" style="width:150px"></label>
          </div>
          <p class="mv-form-footer">روی ترنسپورت ws، h2 از ALPN حذف می‌شود — وب‌سوکت فقط HTTP/1.1 حرف می‌زند و با h2 هیچ اتصالی برقرار نمی‌شود.</p>
        </div>

      </div>
    </div>
    <div class="mv-sheet-foot">
      <button type="button" class="mv-btn" onclick="window.closeModal('editModal')">لغو</button>
      <button type="button" id="btn-save-edit" class="mv-btn mv-btn--primary" onclick="window.saveEditModal()">بروزرسانی</button>
    </div>
  </div>
</div>

<!-- 3 · Share -->
<div id="shareModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4">
  <div class="mv-sheet scale-95 opacity-0" id="shareModalContent" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle" style="width:min(400px, calc(100vw - 40px))">
    <div class="mv-sheet-bar">
      <h3 id="shareModalTitle">اشتراک‌گذاری کانفیگ</h3>
      <button type="button" class="mv-sheet-close" onclick="window.closeModal('shareModal')" title="بستن" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
    </div>
    <div class="mv-sheet-body custom-scrollbar">
      <div class="mv-form">
        <div class="mv-form-section">
          <div class="mv-form-group" style="padding:16px 0">
            <div class="v2-qr" id="qrcode-container"></div>
          </div>
          <p class="mv-form-footer" style="text-align:center">با دوربین برنامه‌ی موبایل اسکن کنید</p>
        </div>
        <div class="mv-form-section">
          <div class="mv-form-header">لینک</div>
          <div class="mv-form-group">
            <div class="mv-form-row is-stack">
              <textarea id="shareLinkInput" class="mv-field mv-form-mono" rows="3" dir="ltr" readonly
                style="width:100%;height:auto;min-height:70px;padding:8px 10px;resize:vertical;text-align:left"></textarea>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="mv-sheet-foot">
      <button type="button" class="mv-btn" onclick="window.closeModal('shareModal')">بستن</button>
      <button type="button" class="mv-btn mv-btn--primary" onclick="window.copyShareLink()"><i class="ph-bold ph-copy"></i>کپی لینک</button>
    </div>
  </div>
</div>

<!-- 4 · Subscription -->
<div id="subModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4">
  <div class="mv-sheet scale-95 opacity-0" id="subModalContent" role="dialog" aria-modal="true" aria-labelledby="subModalTitle" style="width:min(470px, calc(100vw - 40px))">
    <div class="mv-sheet-bar">
      <h3 id="subModalTitle">لینک اشتراک</h3>
      <button type="button" class="mv-sheet-close" onclick="window.closeModal('subModal')" title="بستن" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
    </div>
    <div class="mv-sheet-body custom-scrollbar">
      <div class="mv-form">
        <div class="mv-form-section">
          <div class="mv-form-group">
            <label class="mv-form-row is-stack">
              <span class="mv-form-label">آدرس Subscription</span>
              <input type="text" id="subLinkInput" class="mv-field" dir="ltr" placeholder="https://example.com/sub/…" style="width:100%">
            </label>
          </div>
          <p class="mv-form-footer">محتوای لینک base64 یا فهرست خط‌به‌خط کانفیگ‌ها باشد. کانفیگ‌های تکراری دوباره اضافه نمی‌شوند.</p>
        </div>
      </div>
    </div>
    <div class="mv-sheet-foot">
      <button type="button" class="mv-btn" onclick="window.closeModal('subModal')">انصراف</button>
      <button type="button" id="btn-fetch-sub" class="mv-btn mv-btn--primary" onclick="window.fetchSubLink()">دریافت کانفیگ‌ها</button>
    </div>
  </div>
</div>

<!-- 5 · Delete one -->
<div id="deleteModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4">
  <div class="mv-sheet scale-95 opacity-0" id="deleteModalContent" role="dialog" aria-modal="true" aria-labelledby="deleteModalTitle" style="width:min(380px, calc(100vw - 40px))">
    <div class="mv-sheet-bar"><h3 id="deleteModalTitle">حذف کانفیگ</h3></div>
    <div class="mv-sheet-body custom-scrollbar">
      <div class="mv-form">
        <div class="mv-form-section">
          <div class="mv-form-group">
            <div class="mv-form-row mv-callout is-danger">
              <i class="ph-bold ph-trash"></i>
              <span id="delete-modal-body">این کانفیگ حذف می‌شود. قابل بازگشت نیست.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="mv-sheet-foot">
      <button type="button" class="mv-btn" onclick="window.closeModal('deleteModal')">انصراف</button>
      <button type="button" id="btn-confirm-delete" class="mv-btn mv-btn--danger" onclick="window.confirmDeleteV2rayNode()">حذف</button>
    </div>
  </div>
</div>

<!-- 6 · Delete many -->
<div id="deleteAllModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4">
  <div class="mv-sheet scale-95 opacity-0" id="deleteAllModalContent" role="dialog" aria-modal="true" aria-labelledby="deleteAllModalTitle" style="width:min(420px, calc(100vw - 40px))">
    <div class="mv-sheet-bar">
      <h3 id="deleteAllModalTitle">حذف کانفیگ‌ها</h3>
      <button type="button" class="mv-sheet-close" onclick="window.closeModal('deleteAllModal')" title="بستن" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
    </div>
    <div class="mv-sheet-body custom-scrollbar">
      <div class="mv-form">
        <div class="mv-form-section">
          <div class="mv-form-group">
            <button type="button" class="mv-form-row is-action" onclick="window.confirmDeleteAllV2rayNodes('disconnected')">
              <span class="mv-row-mark" style="color:var(--mv-orange-ink)"><i class="ph-fill ph-plugs"></i></span>
              <span class="mv-form-label">حذف کانفیگ‌های ناموفق<small>آن‌هایی که در آخرین تست تأخیر پاسخ ندادند</small></span>
              <i class="ph-bold ph-caret-left mv-row-end"></i>
            </button>
            <button type="button" class="mv-form-row is-action" onclick="window.confirmDeleteAllV2rayNodes('all')">
              <span class="mv-row-mark" style="color:var(--mv-red-ink)"><i class="ph-fill ph-trash"></i></span>
              <span class="mv-form-label">حذف همه<small id="delete-all-scope">تمام کانفیگ‌های فهرست</small></span>
              <i class="ph-bold ph-caret-left mv-row-end"></i>
            </button>
          </div>
          <p class="mv-form-footer">کانفیگی که تست نشده «ناموفق» شمرده نمی‌شود.</p>
        </div>
      </div>
    </div>
    <div class="mv-sheet-foot">
      <button type="button" class="mv-btn" onclick="window.closeModal('deleteAllModal')">انصراف</button>
    </div>
  </div>
</div>

<!-- 7 · Cancel a running test -->
<div id="cancelTestModal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4">
  <div class="mv-sheet scale-95 opacity-0" id="cancelTestModalContent" role="dialog" aria-modal="true" aria-labelledby="cancelTestTitle" style="width:min(380px, calc(100vw - 40px))">
    <div class="mv-sheet-bar"><h3 id="cancelTestTitle">لغو تست</h3></div>
    <div class="mv-sheet-body custom-scrollbar">
      <div class="mv-form">
        <div class="mv-form-section">
          <div class="mv-form-group">
            <div class="mv-form-row mv-callout is-warn">
              <i class="ph-bold ph-warning"></i>
              <span>تست در حال اجرا لغو شود؟ کانفیگ‌هایی که نوبتشان نشده بدون عدد می‌مانند.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="mv-sheet-foot">
      <button type="button" class="mv-btn" onclick="window.closeModal('cancelTestModal')">ادامه بده</button>
      <button type="button" class="mv-btn mv-btn--danger" onclick="window.confirmAbortV2rayTest()">لغو تست</button>
    </div>
  </div>
</div>

<!-- 8 · Switch node while connected -->
<div id="v2ray-switch-modal" class="fixed inset-0 z-50 hidden flex items-center justify-center p-4">
  <div class="mv-sheet scale-95 opacity-0" id="v2ray-switch-modalContent" role="dialog" aria-modal="true" aria-labelledby="switchTitle" style="width:min(400px, calc(100vw - 40px))">
    <div class="mv-sheet-bar"><h3 id="switchTitle">تغییر کانفیگ</h3></div>
    <div class="mv-sheet-body custom-scrollbar">
      <div class="mv-form">
        <div class="mv-form-section">
          <div class="mv-form-group">
            <div class="mv-form-row mv-callout is-warn">
              <i class="ph-bold ph-swap"></i>
              <span>اتصال فعلی قطع و به <b id="switch-node-name" dir="ltr"></b> وصل می‌شود.</span>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="mv-sheet-foot">
      <button type="button" class="mv-btn" onclick="window.closeSwitchNodeModal(false)">بمان</button>
      <button type="button" class="mv-btn mv-btn--primary" onclick="window.closeSwitchNodeModal(true)">سوئیچ کن</button>
    </div>
  </div>
</div>
`;

// ──────────────────────────────────────────────────────────────────────────────
// Saved list
// ──────────────────────────────────────────────────────────────────────────────
window.v2rayList = JSON.parse(PersistentStorage.getItem('v2rayNodes') || '[]');

// One-time cleanup of the saved list.
//
//   * The two built-in «سرور پیشفرض mlmvpn» configs moved to their own app («کانفیگ ایران»)
//     in 1.2.2; the old copies and the `disableShare` flag that made anything carrying it
//     undeletable are dropped. The flag outlived the configs — configs saved over one of
//     them inherited it, and «حذف همه» then skipped them forever.
//   * Measured figures are re-based. The old tester wrote 0 for "failed" and -1 for "not
//     tested", and the list drew 0 as "Timeout" — so a list that had never been tested, or
//     one whose test core never started, showed a wall of red Timeouts. Anything that is not
//     a positive number is simply "not measured" now, which is the truth, and a test is
//     seconds away. `speed` goes entirely: the per-node download test is gone.
(function migrateSavedList() {
    const SEEDED = ['سرور پیشفرض mlmvpn 1', 'سرور پیشفرض mlmvpn 2'];
    let changed = false;
    window.v2rayList = window.v2rayList.filter(n => {
        if (n && n.disableShare === true) {
            changed = true;
            if (SEEDED.includes(n.name)) return false;
            delete n.disableShare;
        }
        return true;
    });
    window.v2rayList.forEach(n => {
        if (!n) return;
        ['delay', 'ping'].forEach(k => {
            if (!(n[k] > 0)) { if (k in n) changed = true; delete n[k]; }
        });
        if ('speed' in n) { delete n.speed; changed = true; }
        if ('speedNote' in n) { delete n.speedNote; changed = true; }
    });
    if (changed) PersistentStorage.setItem('v2rayNodes', JSON.stringify(window.v2rayList));
})();

window.saveV2rayList = function () {
    PersistentStorage.setItem('v2rayNodes', JSON.stringify(window.v2rayList));
};

// ──────────────────────────────────────────────────────────────────────────────
// Sheets: one implementation
// ──────────────────────────────────────────────────────────────────────────────
window.openModal = function (id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    // A window is a stacking context: a sheet left inside the panel is trapped under the dock
    // and the menu bar. shell/boot.js portals this panel's sheets at start-up, but it does it
    // ONCE — so a sheet added later, or a panel built after boot, would be trapped. Cheap to
    // guarantee here instead of depending on the order two files load in.
    if (modal.parentNode !== document.body) document.body.appendChild(modal);
    const content = document.getElementById(id + 'Content');
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop && backdrop.parentNode !== document.body) document.body.appendChild(backdrop);
    if (id === 'deleteAllModal') {
        // Say what "all" means right now: the visible group, or the whole list.
        const scope = document.getElementById('delete-all-scope');
        if (scope) {
            scope.textContent = (window.isV2rayGrouped && window.activeV2rayPanelTab)
                ? `کانفیگ‌های تب «${window.activeV2rayPanelTab}»`
                : 'تمام کانفیگ‌های فهرست';
        }
    }
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    if (backdrop) { backdrop.classList.remove('hidden'); }
    void modal.offsetWidth;
    if (backdrop) backdrop.classList.remove('opacity-0');
    if (content) content.classList.remove('opacity-0', 'scale-95');
};

window.closeModal = function (id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    const content = document.getElementById(id + 'Content');
    const backdrop = document.getElementById('modal-backdrop');
    if (content) content.classList.add('opacity-0', 'scale-95');
    if (backdrop) backdrop.classList.add('opacity-0');
    setTimeout(() => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        // The backdrop is shared, so it only goes when nothing is left open.
        const anyOpen = ['importModal', 'editModal', 'shareModal', 'subModal', 'deleteModal',
            'deleteAllModal', 'cancelTestModal', 'v2ray-switch-modal']
            .some(x => { const m = document.getElementById(x); return m && !m.classList.contains('hidden'); });
        if (backdrop && !anyOpen) backdrop.classList.add('hidden');
    }, 220);
};

window.toggleModal = function (id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    if (modal.classList.contains('hidden')) window.openModal(id);
    else window.closeModal(id);
};

window.closeModals = function () {
    ['importModal', 'editModal', 'shareModal', 'subModal', 'deleteModal', 'deleteAllModal',
        'cancelTestModal', 'v2ray-switch-modal'].forEach(window.closeModal);
};

window.openV2rayImportModal = function () { window.openModal('importModal'); };

// ──────────────────────────────────────────────────────────────────────────────
// Importing
// ──────────────────────────────────────────────────────────────────────────────
const IMPORTABLE = /^(vless|trojan|vmess|ss):\/\//i;

/**
 * Add links to the list.
 *
 * The name comes from the LINK, not from a dice roll. The old version overwrote every
 * incoming label with a random "X3F9-mlmvpn" — which threw away the panel, country and
 * channel the config came from (the only way to tell 40 configs apart), broke «تفکیک پنل‌ها»
 * because the grouping reads that name, and made the share link a different link from the one
 * that was imported. Duplicates are skipped, and ss:// is accepted (the parser has handled it
 * for a while; the import filter just never let it through).
 *
 * @returns the number added.
 */
window.addV2rayUris = function (text, opts = {}) {
    const lines = String(text || '')
        .split(/[\r\n\s]+/)
        .map(l => l.trim())
        .filter(l => IMPORTABLE.test(l));
    if (!lines.length) return 0;

    const seen = new Set(window.v2rayList.map(n => n.uri));
    let added = 0;
    lines.forEach(uri => {
        if (seen.has(uri)) return;
        seen.add(uri);
        const node = { id: 'conf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), uri };
        if (opts.groupTitle) node.groupTitle = opts.groupTitle;
        window.v2rayList.unshift(node);
        added++;
    });
    if (added) {
        saveV2rayList();
        window.renderV2rayList();
    }
    return added;
};

window.importV2rayNodes = function () {
    const input = document.getElementById('import-links-textarea');
    if (!input) return;
    const added = window.addV2rayUris(input.value);
    if (!added) {
        const had = IMPORTABLE.test(String(input.value || '').trim().split(/\s+/)[0] || '');
        toast(had ? 'این کانفیگ‌ها از قبل در فهرست هستند' : '❌ هیچ لینک معتبری پیدا نشد');
        return;
    }
    input.value = '';
    window.closeModal('importModal');
    toast(`✅ ${added} کانفیگ اضافه شد`);
};

window.importFromClipboard = async function () {
    try {
        const text = await navigator.clipboard.readText();
        const added = window.addV2rayUris(text);
        if (!added) { toast('❌ در کلیپ‌بورد لینک تازه‌ای نبود'); return; }
        window.closeModal('importModal');
        toast(`✅ ${added} کانفیگ از کلیپ‌بورد اضافه شد`);
    } catch (e) {
        toast('❌ خواندن کلیپ‌بورد ممکن نشد');
    }
};

window.openSubModal = function () { window.openModal('subModal'); };

window.fetchSubLink = async function () {
    const input = document.getElementById('subLinkInput');
    const btn = document.getElementById('btn-fetch-sub');
    const url = input ? input.value.trim() : '';
    if (!/^https?:\/\//i.test(url)) { toast('❌ یک آدرس http/https وارد کنید'); return; }
    if (btn) { btn.disabled = true; btn.innerHTML = SPINNER + 'در حال دریافت…'; }
    try {
        const res = await fetch('/api/v2ray/fetch-sub', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url }),
        });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || `خطای ${res.status}`);
        let text = data.content || data.raw || '';
        // Subscriptions are usually base64 of a newline-separated list.
        if (!IMPORTABLE.test(text.trim())) {
            try { text = atob(text.replace(/\s/g, '')); } catch (e) { /* it was not base64 */ }
        }
        const added = window.addV2rayUris(text);
        if (!added) { toast('کانفیگ تازه‌ای در این لینک نبود'); }
        else {
            toast(`✅ ${added} کانفیگ از لینک اشتراک اضافه شد`);
            window.closeModal('subModal');
        }
    } catch (e) {
        toast('❌ ' + e.message);
    }
    if (btn) { btn.disabled = false; btn.innerHTML = 'دریافت کانفیگ‌ها'; }
};

/** A blank config opened straight in the edit sheet, so nothing is saved until it is valid. */
window.addProtocolConfig = function (protocol) {
    const proto = protocol === 'shadowsocks' ? 'ss' : protocol;
    const uri = proto === 'ss'
        ? 'ss://YWVzLTI1Ni1nY206cGFzc3dvcmQ=@127.0.0.1:443#کانفیگ%20جدید'
        : `${proto}://00000000-0000-0000-0000-000000000000@127.0.0.1:443?type=ws&security=tls#${encodeURIComponent('کانفیگ جدید')}`;
    window.v2rayList.unshift({ id: 'conf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), uri, name: 'کانفیگ جدید' });
    saveV2rayList();
    window.renderV2rayList();
    window.openV2rayEditModal(0);
};

window.addCustomConfig = function () {
    window.openModal('importModal');
    const ta = document.getElementById('import-links-textarea');
    if (ta) { ta.focus(); }
    toast('لینک کانفیگ را اینجا بچسبانید، یا با دکمه‌های پروتکل از صفر بسازید');
};

// ──────────────────────────────────────────────────────────────────────────────
// The list
// ──────────────────────────────────────────────────────────────────────────────
window.renderV2rayList = function () {
    const tbody = document.getElementById('v2ray-nodes-list');
    if (!tbody) return;
    const tabsContainer = document.getElementById('v2ray-panel-tabs');
    const subTabsContainer = document.getElementById('v2ray-sub-tabs');
    const countEl = document.getElementById('v2ray-node-count');
    const showCount = count => { if (countEl) countEl.textContent = `${count} کانفیگ`; };

    tbody.className = 'mv-list';
    tbody.innerHTML = '';

    if (!window.v2rayList.length) {
        showCount(0);
        tbody.innerHTML = '<div class="mv-empty"><i class="ph-bold ph-plugs mv-empty-ic"></i><b>هنوز کانفیگی اضافه نشده</b><p>برای شروع، «افزودن کانفیگ» را بزنید یا از دکمه دریافت، کانفیگ رایگان بگیرید.</p></div>';
        if (tabsContainer) tabsContainer.classList.add('hidden');
        if (subTabsContainer) subTabsContainer.classList.add('hidden');
        updateBottomBarLead();
        return;
    }

    let nodesToRender = window.v2rayList;

    if (window.isV2rayGrouped && tabsContainer) {
        const panels = new Map();
        window.v2rayList.forEach(node => {
            const panel = window.getV2rayPanelName(node);
            if (!panels.has(panel)) panels.set(panel, []);
            panels.get(panel).push(node);
        });
        if (!window.activeV2rayPanelTab || !panels.has(window.activeV2rayPanelTab)) {
            window.activeV2rayPanelTab = Array.from(panels.keys()).sort()[0];
        }
        tabsContainer.innerHTML = Array.from(panels.entries()).map(([panel, configs]) => {
            const label = (panel !== 'افزودن دستی' && panel !== 'کلاستر کلودفلر' && !panel.startsWith('کانفیگ'))
                ? 'پنل ' + panel : panel;
            return `<button type="button" class="${window.activeV2rayPanelTab === panel ? 'is-on' : ''}"
                onclick="window.activeV2rayPanelTab=${JSON.stringify(panel)}; window.activeV2raySubTab=null; window.renderV2rayList();">
                ${label}<span class="count">${configs.length}</span></button>`;
        }).join('');
        tabsContainer.classList.remove('hidden');
        nodesToRender = panels.get(window.activeV2rayPanelTab) || [];

        // Sub-groups, only when there is more than one to choose between.
        if (subTabsContainer) {
            const subs = new Map();
            nodesToRender.forEach(node => {
                const sub = window.getV2raySubGroupName(node);
                if (!subs.has(sub)) subs.set(sub, []);
                subs.get(sub).push(node);
            });
            const names = Array.from(subs.keys()).sort((a, b) => {
                if (a.includes('ترکیب')) return -1;
                if (b.includes('ترکیب')) return 1;
                return a.localeCompare(b);
            });
            if (names.length > 1) {
                if (!window.activeV2raySubTab || !subs.has(window.activeV2raySubTab)) window.activeV2raySubTab = names[0];
                subTabsContainer.innerHTML = names.map(name => {
                    const icon = name.includes('ترکیب') ? '🔀' : (name.includes('.') ? '🌐' : '📁');
                    return `<button type="button" class="${window.activeV2raySubTab === name ? 'is-on' : ''}"
                        onclick="window.activeV2raySubTab=${JSON.stringify(name)}; window.renderV2rayList();">
                        ${icon} ${name}<span class="count">${subs.get(name).length}</span></button>`;
                }).join('');
                subTabsContainer.classList.remove('hidden');
                nodesToRender = subs.get(window.activeV2raySubTab) || [];
            } else {
                window.activeV2raySubTab = null;
                subTabsContainer.classList.add('hidden');
            }
        }
    } else {
        if (tabsContainer) tabsContainer.classList.add('hidden');
        if (subTabsContainer) subTabsContainer.classList.add('hidden');
    }

    if (!nodesToRender.length) {
        showCount(0);
        tbody.innerHTML = '<div class="mv-empty"><b>این گروه خالی است</b></div>';
        updateBottomBarLead();
        return;
    }

    showCount(nodesToRender.length);
    nodesToRender.forEach(node => {
        tbody.appendChild(createNodeRow(node, window.v2rayList.indexOf(node)));
    });
    updateBottomBarLead();
};

/** One config as a K3 list row. */
function createNodeRow(node, idx) {
    const name = window.v2rayNodeName(node);
    const host = window.v2rayNodeHost(node);
    const proto = window.v2rayNodeProto(node);
    const isLive = window.v2rayIsConnected && window.currentConnectedV2rayIndex === idx;

    const row = document.createElement('label');
    row.className = 'node-card mv-li' + (isLive ? ' is-on' : '');
    row.style.setProperty('--node-tint', {
        VLESS: 'var(--mv-indigo)', Trojan: 'var(--mv-orange)', VMess: 'var(--mv-blue)', SS: 'var(--mv-green)'
    }[proto] || 'var(--mv-gray)');
    row.innerHTML = `
        <input type="radio" name="nodeSelection" class="material-radio v2ray-node-check mv-li-lead" aria-label="انتخاب ${escapeHtml(name)}" value="${idx}">
        <span class="v2-node-glyph"><i class="ph-fill ${isLive ? 'ph-check-circle' : 'ph-hard-drives'}"></i></span>
        <span class="mv-li-text">
            <b dir="ltr"><span class="v2-nm">${escapeHtml(name)}</span><span class="v2-type">${proto}</span></b>
            <small dir="ltr">${escapeHtml(host)}</small>
        </span>
        <span class="v2-node-nums">
            <div><span id="v2ray-ping-${idx}">${figureHtml(node.ping, node.pingNote)}</span><small>ping</small></div>
            <div><span id="v2ray-delay-${idx}">${figureHtml(node.delay, node.delayNote)}</span><small>delay</small></div>
        </span>
        <span class="v2-node-acts">
            <span class="v2-menu-wrap">
                <button type="button" title="بیشتر" aria-label="بیشتر" onclick="window.toggleNodeMenu(event, ${idx})"><i class="ph-bold ph-dots-three-vertical"></i></button>
                <span id="node-menu-${idx}" class="v2-node-menu mv-menu hidden" role="menu" onclick="event.stopPropagation()">
                    <button type="button" class="mv-mi" onclick="window.closeNodeMenu(${idx}); window.testNodesUI(event, 'delay', ${idx}); event.preventDefault();"><i class="ph-bold ph-clock"></i><span class="mv-mi-label">تست تأخیر</span></button>
                    <button type="button" class="mv-mi" onclick="window.closeNodeMenu(${idx}); window.testNodesUI(event, 'ping', ${idx}); event.preventDefault();"><i class="ph-bold ph-pulse"></i><span class="mv-mi-label">تست پینگ</span></button>
                    <div class="mv-msep"></div>
                    <button type="button" class="mv-mi" onclick="window.closeNodeMenu(${idx}); window.copyV2rayNode(${idx}); event.preventDefault();"><i class="ph-bold ph-copy"></i><span class="mv-mi-label">کپی لینک</span></button>
            <button type="button" class="mv-mi" title="ویرایش" aria-label="ویرایش" onclick="window.closeNodeMenu(${idx}); window.openV2rayEditModal(${idx}); event.preventDefault();"><i class="ph-bold ph-pencil-simple"></i><span>ویرایش</span></button>
            <button type="button" class="mv-mi" title="اشتراک‌گذاری" aria-label="اشتراک‌گذاری" onclick="window.closeNodeMenu(${idx}); window.openV2rayShareModal(${idx}); event.preventDefault();"><i class="ph-bold ph-share-network"></i><span>اشتراک‌گذاری</span></button>
            <button type="button" class="mv-mi" title="حذف" aria-label="حذف" onclick="window.closeNodeMenu(${idx}); window.openDeleteV2rayModal(${idx}); event.preventDefault();" style="color:var(--mv-red-ink)"><i class="ph-bold ph-trash"></i><span>حذف</span></button>
                </span>
            </span>
        </span>
    `;

    const radio = row.querySelector('.material-radio');
    radio.addEventListener('change', () => {
        document.querySelectorAll('.node-card').forEach(r => r.classList.remove('is-sel'));
        row.classList.add('is-sel');
        updateBottomBarLead();
        if (window.v2rayIsConnected && window.currentConnectedV2rayIndex !== undefined
            && window.currentConnectedV2rayIndex !== idx) {
            window.showSwitchNodeModal(idx, name);
        }
    });
    return row;
}

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The bottom bar says what will happen when the button is pressed. */
function updateBottomBarLead() {
    const lead = document.getElementById('v2ray-bb-lead');
    if (!lead) return;
    if (window.v2rayIsConnected) return;   // markV2rayConnected owns the text while connected
    const sel = document.querySelector('.v2ray-node-check:checked');
    const node = sel && window.v2rayList[parseInt(sel.value, 10)];
    lead.innerHTML = `<span>${node ? escapeHtml(window.v2rayNodeName(node)) : 'یک کانفیگ را انتخاب کنید'}</span>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Sorting — delay only, toggled ascending / descending like the Android toolbar
// ──────────────────────────────────────────────────────────────────────────────
window.toggleSortMenu = function (e) {
    if (e) e.stopPropagation();
    const menu = document.getElementById('sortDropdownMenu');
    if (!menu) return;
    if (menu.classList.contains('hidden')) {
        markActiveSort();
        menu.classList.remove('hidden');
    } else {
        window.closeSortMenu();
    }
};

window.closeSortMenu = function () {
    const menu = document.getElementById('sortDropdownMenu');
    if (menu) menu.classList.add('hidden');
};

function markActiveSort() {
    const button = document.getElementById('v2-sort-button');
    if (!button) return;
    const direction = store.get(SORT_KEY, 'none');
    button.classList.toggle('is-on', direction === 'delay' || direction === 'delay-desc');
    button.title = direction === 'delay-desc' ? 'دیلی: زیاد به کم — کلیک برای کم به زیاد' : 'دیلی: کم به زیاد — کلیک برای زیاد به کم';
    button.setAttribute('aria-label', button.title);
    button.querySelector('i').className = 'ph-bold ph-sort-' + (direction === 'delay-desc' ? 'descending' : 'ascending');
}

function v2raySortBy(type, opts = {}) {
    if (window.isV2rayTesting) { toast('پس از پایان تست، فهرست را مرتب کنید'); return; }
    const direction = type === 'delay-desc' ? 'delay-desc' : 'delay';
    const selected = document.querySelector('.v2ray-node-check:checked');
    const selectedNode = selected ? window.v2rayList[Number(selected.value)] : null;
    const liveNode = window.v2rayList[window.currentConnectedV2rayIndex];
    window.v2rayList.sort((a, b) => {
        const rank = n => n.delay > 0 ? 0 : (n.delay === -1 ? 2 : 1);
        const difference = rank(a) - rank(b);
        if (difference) return difference;
        return rank(a) === 0 ? (a.delay - b.delay) * (direction === 'delay-desc' ? -1 : 1) : 0;
    });
    if (liveNode) window.currentConnectedV2rayIndex = window.v2rayList.indexOf(liveNode);
    store.set(SORT_KEY, direction);
    saveV2rayList();
    window.renderV2rayList();
    if (selectedNode) {
        const index = window.v2rayList.indexOf(selectedNode);
        const radio = document.querySelector('.v2ray-node-check[value="' + index + '"]');
        if (radio) { radio.checked = true; if (radio.closest) radio.closest('.node-card').classList.add('is-sel'); }
    }
    updateBottomBarLead();
    markActiveSort();
    if (!opts.quiet) toast(direction === 'delay-desc' ? 'دیلی: زیاد به کم' : 'دیلی: کم به زیاد');
}

window.sortV2rayList = function () {
    if (!window.v2rayList.length) { toast('لیست خالی است'); return; }
    v2raySortBy(store.get(SORT_KEY, 'none') === 'delay' ? 'delay-desc' : 'delay');
};
// Legacy callers still sort by delay; other metrics no longer control ordering.
window.sortV2ray = function () { v2raySortBy('delay', { quiet: true }); };

// ──────────────────────────────────────────────────────────────────────────────
// «کپی کانفیگ‌های سالم»
// ──────────────────────────────────────────────────────────────────────────────
/**
 * Copy every config that answered the last delay test, best first, one link per line.
 *
 * "Healthy" means measured and positive — never-tested configs are not included, because the
 * point of the button is to hand someone a list that is known to work.
 */
window.copyHealthyV2rayConfigs = async function () {
    const scope = (window.isV2rayGrouped && window.activeV2rayPanelTab)
        ? window.getV2rayFilteredNodes() : window.v2rayList;
    const healthy = scope.filter(n => n && n.delay > 0).sort((a, b) => a.delay - b.delay);

    if (!healthy.length) {
        const tested = scope.some(n => n && (n.delay > 0 || (n.delay === -1 && n.delayNote)));
        toast(tested ? 'هیچ کانفیگ سالمی در این فهرست نیست' : 'اول «تأخیر واقعی» را بزنید تا سالم‌ها مشخص شوند');
        return;
    }

    // The name goes with the link. A link whose #fragment was lost arrives at the other end
    // as an unnamed row, which is exactly the state this panel was just rescued from.
    const text = healthy.map(n => {
        const uri = String(n.uri || '');
        if (uri.includes('#')) return uri;
        return uri + '#' + encodeURIComponent(window.v2rayNodeName(n));
    }).join('\n');

    if (await v2rayCopyText(text)) {
        toast(`✅ ${healthy.length} کانفیگ سالم کپی شد (از ${healthy[0].delay}ms تا ${healthy[healthy.length - 1].delay}ms)`);
    } else {
        toast('❌ کپی نشد');
    }
};

window.copyV2rayNode = async function (idx) {
    const node = window.v2rayList[idx];
    if (!node) return;
    toast(await v2rayCopyText(node.uri) ? '✅ لینک کپی شد' : '❌ کپی نشد');
};

/**
 * navigator.clipboard, with the old textarea trick behind it.
 *
 * Named v2rayCopyText, NOT copyText: app.js already declares a global `copyText` (the scanner
 * and netdiag call it) and a second top-level declaration of that name in a classic script
 * simply replaces it. This one answers true/false instead of showing its own toast, which is
 * why it cannot just be the shared one.
 *
 * The async API refuses whenever the document is not focused — which happens for real, not
 * just in a headless test: a click that also moves focus, a window that just lost it to a
 * notification. Failing the copy there would be a silent "nothing happened".
 */
async function v2rayCopyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (e) { /* fall through to the one that works without focus */ }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch (e) {
        return false;
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// Deleting
// ──────────────────────────────────────────────────────────────────────────────
window.currentDeleteIdx = -1;

window.openDeleteV2rayModal = function (idx) {
    window.currentDeleteIdx = idx;
    const node = window.v2rayList[idx];
    const body = document.getElementById('delete-modal-body');
    if (body) body.innerHTML = `<b dir="ltr">${escapeHtml(window.v2rayNodeName(node))}</b> حذف می‌شود. قابل بازگشت نیست.`;
    window.openModal('deleteModal');
};

window.confirmDeleteV2rayNode = function () {
    const idx = window.currentDeleteIdx;
    if (idx < 0 || !window.v2rayList[idx]) { window.closeModal('deleteModal'); return; }
    // The live connection is a thing, not a row: removing its row must not leave the panel
    // pointing at whatever slid into that index.
    if (window.v2rayIsConnected && window.currentConnectedV2rayIndex === idx) {
        window.currentConnectedV2rayIndex = undefined;
    } else if (window.currentConnectedV2rayIndex > idx) {
        window.currentConnectedV2rayIndex--;
    }
    window.v2rayList.splice(idx, 1);
    window.currentDeleteIdx = -1;
    saveV2rayList();
    window.renderV2rayList();
    window.closeModal('deleteModal');
    toast('✅ کانفیگ حذف شد');
};

window.confirmDeleteAllV2rayNodes = function (type) {
    const scope = (window.isV2rayGrouped && window.activeV2rayPanelTab)
        ? new Set(window.getV2rayFilteredNodes()) : new Set(window.v2rayList);
    const before = window.v2rayList.length;
    window.v2rayList = window.v2rayList.filter(n => {
        if (!scope.has(n)) return true;
        if (type === 'all') return false;
        // "disconnected" = measured AND failed, which is what a reason proves. A node that
        // was never tested (or was only seeded with -1 by another importer) is not evidence.
        return !(n.delay === -1 && n.delayNote);
    });
    const gone = before - window.v2rayList.length;
    window.currentConnectedV2rayIndex = undefined;
    saveV2rayList();
    window.renderV2rayList();
    window.closeModal('deleteAllModal');
    toast(gone ? `✅ ${gone} کانفیگ حذف شد` : 'چیزی برای حذف نبود');
};

// ──────────────────────────────────────────────────────────────────────────────
// Editing
// ──────────────────────────────────────────────────────────────────────────────
window.currentEditIdx = -1;

window.openV2rayEditModal = function (idx) {
    window.editV2rayNode(idx);
    window.openModal('editModal');
};

window.editV2rayNode = function (idx) {
    const node = window.v2rayList[idx];
    if (!node) return;
    window.currentEditIdx = idx;
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.value = val == null ? '' : val; };

    set('edit-remark', window.v2rayNodeName(node));
    let url = null;
    try { url = new URL(node.uri); } catch (e) { /* JSON or malformed: the fields stay blank */ }
    if (!url) {
        toast('این کانفیگ لینک استاندارد نیست و فیلد به فیلد ویرایش نمی‌شود');
        ['edit-address', 'edit-port', 'edit-password', 'edit-host', 'edit-path', 'edit-sni', 'edit-alpn', 'edit-flow'].forEach(id => set(id, ''));
        return;
    }
    const q = url.searchParams;
    set('edit-address', url.hostname);
    set('edit-port', url.port);
    let user = url.username;
    try { user = decodeURIComponent(user); } catch (e) { /* keep as is */ }
    set('edit-password', user);
    set('edit-network', q.get('type') || 'tcp');
    set('edit-host', q.get('host') || '');
    set('edit-path', q.get('path') ? decodeURIComponent(q.get('path')) : (q.get('serviceName') || ''));
    set('edit-flow', q.get('flow') || '');
    set('edit-tls', q.get('security') || 'none');
    set('edit-sni', q.get('sni') || '');
    set('edit-fingerprint', q.get('fp') || 'chrome');
    set('edit-alpn', q.get('alpn') || '');
};

window.saveEditModal = function () {
    const idx = window.currentEditIdx;
    const node = window.v2rayList[idx];
    if (!node) { window.closeModal('editModal'); return; }
    const val = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };

    const address = val('edit-address');
    const port = val('edit-port');
    const secret = val('edit-password');
    if (!address || !port || !secret) { toast('❌ آدرس، پورت و UUID/رمز لازم است'); return; }

    let scheme = 'vless';
    const m = String(node.uri || '').match(/^([a-z0-9+.-]+):\/\//i);
    if (m) scheme = m[1].toLowerCase();

    const name = val('edit-remark') || address;
    const q = new URLSearchParams();
    const type = val('edit-network') || 'tcp';
    const security = val('edit-tls') || 'none';
    if (scheme === 'vless') q.set('encryption', 'none');
    q.set('type', type);
    q.set('security', security);
    if (val('edit-host')) q.set('host', val('edit-host'));
    if (val('edit-path')) q.set(type === 'grpc' ? 'serviceName' : 'path', val('edit-path'));
    if (val('edit-flow')) q.set('flow', val('edit-flow'));
    if (security !== 'none') {
        if (val('edit-sni')) q.set('sni', val('edit-sni'));
        if (val('edit-fingerprint')) q.set('fp', val('edit-fingerprint'));
        // h2 on a WebSocket is a dead config, not a slower one — the core speaks HTTP/1.1
        // there and Cloudflare will happily negotiate h2 and kill the dial.
        let alpn = val('edit-alpn');
        if (type === 'ws') alpn = alpn.split(',').map(s => s.trim()).filter(a => a && a !== 'h2').join(',');
        if (alpn) q.set('alpn', alpn);
    }

    node.uri = `${scheme}://${encodeURIComponent(secret)}@${address}:${port}?${q.toString()}#${encodeURIComponent(name)}`;
    node.name = name;
    // Edited, so whatever was measured describes a different server now.
    delete node.delay; delete node.delayNote;
    delete node.ping; delete node.pingNote;

    saveV2rayList();
    window.renderV2rayList();
    window.closeModal('editModal');
    toast('✅ کانفیگ بروزرسانی شد');
};

// ──────────────────────────────────────────────────────────────────────────────
// Sharing
// ──────────────────────────────────────────────────────────────────────────────
window.openV2rayShareModal = function (idx) { window.shareV2rayNode(idx); };

window.shareV2rayNode = function (idx) {
    const node = window.v2rayList[idx];
    if (!node) return;
    let uri = String(node.uri || '');
    if (!uri.includes('#')) uri += '#' + encodeURIComponent(window.v2rayNodeName(node));
    const input = document.getElementById('shareLinkInput');
    if (input) input.value = uri;

    const box = document.getElementById('qrcode-container');
    if (box) {
        box.innerHTML = '';
        try {
            if (typeof QRCode !== 'undefined') {
                new QRCode(box, { text: uri, width: 168, height: 168, colorDark: '#000000', colorLight: '#FFFFFF' });
            } else {
                box.innerHTML = '<span style="color:#555;font-size:11px">بارکد در دسترس نیست</span>';
            }
        } catch (e) {
            box.innerHTML = '<span style="color:#555;font-size:11px">بارکد ساخته نشد</span>';
        }
    }
    window.openModal('shareModal');
};

window.copyShareLink = async function () {
    const input = document.getElementById('shareLinkInput');
    if (!input) return;
    toast(await v2rayCopyText(input.value) ? '✅ لینک کپی شد' : '❌ کپی نشد');
};

// ──────────────────────────────────────────────────────────────────────────────
// Connecting
// ──────────────────────────────────────────────────────────────────────────────
window.v2rayIsConnected = false;
window.currentConnectedV2rayIndex = undefined;
let pendingSwitchIdx = -1;

window.setV2raySolo = function (on) {
    V2RAY_SOLO.set(on);
    toast(on ? 'از این پس فقط کانفیگ انتخابی استفاده می‌شود' : 'کانفیگ‌های «زیرساخت ابری» هم کنار آن توزیع بار می‌شوند');
};

window.showSwitchNodeModal = function (idx, nodeName) {
    pendingSwitchIdx = idx;
    const el = document.getElementById('switch-node-name');
    if (el) el.textContent = nodeName || 'Node';
    window.openModal('v2ray-switch-modal');
};

window.closeSwitchNodeModal = async function (confirm) {
    window.closeModal('v2ray-switch-modal');
    if (!confirm) {
        // Put the tick back on the node that is actually carrying traffic.
        const live = window.currentConnectedV2rayIndex;
        document.querySelectorAll('.v2ray-node-check').forEach(r => {
            r.checked = parseInt(r.value, 10) === live;
        });
        document.querySelectorAll('.node-card').forEach(r => r.classList.remove('is-sel'));
        updateBottomBarLead();
        pendingSwitchIdx = -1;
        return;
    }
    // Connecting restarts the engine; no separate disconnect is needed and doing one first
    // only widens the window in which the machine has no VPN.
    await window.connectV2ray(pendingSwitchIdx >= 0 ? pendingSwitchIdx : undefined);
    pendingSwitchIdx = -1;
};

window.toggleV2rayConnection = async function () {
    if (window.v2rayIsConnected) await window.disconnectV2ray();
    else await window.connectV2ray();
};

/** The status head's tile is the panel's lamp: grey while nothing runs, green once it does. */
function v2raySetTile(on) {
    const tile = document.getElementById('v2ray-tile');
    if (tile) tile.style.setProperty('--tint', on ? 'var(--mv-green)' : 'var(--mv-gray)');
}
window.v2raySetTile = v2raySetTile;

window.setV2rayBusy = function (on, label) {
    const spinner = document.getElementById('connect-spinner');
    const btn = document.getElementById('btn-main-connect');
    const title = document.getElementById('status-title');
    const state = document.querySelector('.v2-connect-state span');

    if (spinner) spinner.className = on ? 'ph-bold ph-circle-notch mv-spin' : 'ph-bold ph-power';
    if (btn) {
        btn.disabled = !!on;
        btn.style.cursor = on ? 'progress' : '';
    }
    const lbl = document.getElementById('btn-connect-label');
    // Written BOTH ways. Setting it only while busy left the button reading «در حال اتصال…»
    // over a live connection whenever a busy phase ended without changing the session —
    // turning the full tunnel on, for instance: «گاهی اوقات قطع هست میزنه در حال اتصال».
    if (lbl) {
        if (on) lbl.textContent = label && /قطع|خاموش/.test(label) ? 'در حال قطع…' : 'در حال اتصال…';
        else lbl.textContent = window.v2rayIsConnected ? 'قطع اتصال' : 'اتصال';
    }
    if (on && label && title) {
        if (window._v2rayTitleBeforeBusy === undefined) window._v2rayTitleBeforeBusy = title.innerText;
        title.innerText = label;
    }
    if (state) state.textContent = on ? (label || 'در حال اتصال…') : (window.v2rayIsConnected ? 'اتصال برقرار است' : 'آماده برای اتصال');
    if (!on && title && window._v2rayTitleBeforeBusy !== undefined) {
        // Only restore a title we replaced AND that nobody has moved on from: the connect
        // path writes «متصل است» itself and that must win.
        if (title.innerText.trim().endsWith('…')) title.innerText = window._v2rayTitleBeforeBusy;
        window._v2rayTitleBeforeBusy = undefined;
    }
};

window.connectV2ray = async function (forceIdx) {
    let idx = forceIdx;
    if (idx === undefined) {
        const selected = document.querySelector('.v2ray-node-check:checked');
        if (!selected) { toast('❌ لطفاً یک کانفیگ را برای اتصال انتخاب کنید'); return; }
        idx = parseInt(selected.value, 10);
    }
    const node = window.v2rayList[idx];
    if (!node) { toast('❌ کانفیگ پیدا نشد'); return; }

    const useSysProxy = !!(document.getElementById('systemProxyToggle') || {}).checked;
    const name = window.v2rayNodeName(node);

    v2rayHideNotice();
    window.setV2rayBusy(true, 'در حال اتصال…');
    const subtitle = document.getElementById('status-subtitle');
    if (subtitle) subtitle.innerText = name + ' — لطفاً چند لحظه صبر کنید';

    try {
        const res = await fetch('/api/v2ray/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uri: node.uri, useSystemProxy: useSysProxy, solo: V2RAY_SOLO.get() }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) throw new Error(data.error || `خطای ${res.status}`);

        toast('✅ متصل شد');
        if (typeof window.triggerNotification === 'function') {
            window.triggerNotification('v2rayStarted', 'موتور v2ray', `موتور v2ray با کانفیگ ${name} روشن شد.`);
        }
        window.markV2rayConnected(node.delay > 0 ? `${name} — ${node.delay}ms` : name, { index: idx });
    } catch (e) {
        // The server's message is the core's own words now (see xray-manager.startXray), so it
        // is worth keeping on screen rather than flashing past in a toast.
        window.setV2rayBusy(false);
        toast('❌ ' + e.message);
        v2rayShowNotice('danger', 'اتصال برقرار نشد', escapeHtml(e.message)
            + '<br>با «تأخیر واقعی» بررسی کنید که این کانفیگ زنده است.');
        window.disconnectV2rayUI();
    }
};

/**
 * The panel's connected state, for every path that starts Xray: a node from this list, or a
 * profile from «کانفیگ ایران» / «ضد فیلتر SNI» / «دامین فرانتینگ», which drive the same engine.
 */
window.markV2rayConnected = function (subtitle, opts = {}) {
    window.v2rayIsConnected = true;
    window.currentConnectedV2rayIndex = opts.index;
    if (typeof window.startTrafficPolling === 'function') window.startTrafficPolling();
    if (typeof startLiveSpeedPolling === 'function') startLiveSpeedPolling();
    window.setV2rayBusy(false);

    const title = document.getElementById('status-title');
    const sub = document.getElementById('status-subtitle');
    if (title) title.innerText = 'متصل است';
    if (sub) sub.innerText = subtitle || '';
    v2raySetTile(true);

    const btn = document.getElementById('btn-main-connect');
    if (btn) { btn.classList.remove('mv-btn--primary'); btn.classList.add('mv-btn--danger'); }
    const lbl = document.getElementById('btn-connect-label');
    if (lbl) lbl.textContent = 'قطع اتصال';

    if (opts.systemProxy) {
        const sp = document.getElementById('systemProxyToggle');
        if (sp) sp.checked = true;
    }
    if (opts.index === undefined) {
        // Not one of this list's rows: no row may stay highlighted as the live one.
        document.querySelectorAll('.v2ray-node-check:checked').forEach(r => { r.checked = false; });
    }
    // Exactly one row may wear the live look, and only if the connection came from a row.
    document.querySelectorAll('.node-card').forEach(r => {
        const radio = r.querySelector('.material-radio');
        const isLive = opts.index !== undefined && radio && parseInt(radio.value, 10) === opts.index;
        r.classList.toggle('is-on', !!isLive);
        const glyph = r.querySelector('.v2-node-glyph i');
        if (glyph) glyph.className = `ph-fill ${isLive ? 'ph-check-circle' : 'ph-hard-drives'}`;
    });

    const state = document.querySelector('.v2-connect-state span');
    if (state) state.textContent = 'اتصال برقرار است';

    const lead = document.getElementById('v2ray-bb-lead');
    if (lead) lead.innerHTML = `<span>${escapeHtml(subtitle || 'متصل است')}</span>`;

    // End on the server's own view: a connect restarts the engine and can rebuild or drop the
    // tunnel around the new node, and `opts.systemProxy` is only what the caller ASKED for.
    if (typeof window.syncV2raySwitches === 'function') window.syncV2raySwitches();
    window.dispatchEvent(new CustomEvent('mv-v2ray-state', { detail: { connected: true } }));
};

window.disconnectV2ray = async function () {
    window.setV2rayBusy(true, 'در حال قطع اتصال…');
    try {
        await fetch('/api/v2ray/stop', { method: 'POST' });
        toast('✅ اتصال قطع شد');
    } catch (e) {
        toast('❌ ' + e.message);
    }
    window.disconnectV2rayUI();
};

window.disconnectV2rayUI = function () {
    window.v2rayIsConnected = false;
    window.currentConnectedV2rayIndex = undefined;
    window.setV2rayBusy(false);
    if (typeof window.stopTrafficPolling === 'function') window.stopTrafficPolling();
    if (typeof stopLiveSpeedPolling === 'function') stopLiveSpeedPolling();
    if (typeof window.syncV2raySwitches === 'function') window.syncV2raySwitches();

    const title = document.getElementById('status-title');
    const sub = document.getElementById('status-subtitle');
    if (title) title.innerText = 'آماده‌ی اتصال';
    if (sub) sub.innerText = 'یک کانفیگ را انتخاب کنید و «اتصال» را بزنید';
    v2raySetTile(false);

    const btn = document.getElementById('btn-main-connect');
    if (btn) { btn.classList.remove('mv-btn--danger'); btn.classList.add('mv-btn--primary'); }
    const lbl = document.getElementById('btn-connect-label');
    if (lbl) lbl.textContent = 'اتصال';
    document.querySelectorAll('.node-card').forEach(r => {
        r.classList.remove('is-on');
        const glyph = r.querySelector('.v2-node-glyph i');
        if (glyph) glyph.className = 'ph-fill ph-hard-drives';
    });
    const state = document.querySelector('.v2-connect-state span');
    if (state) state.textContent = 'آماده برای اتصال';
    updateBottomBarLead();
    window.dispatchEvent(new CustomEvent('mv-v2ray-state', { detail: { connected: false } }));
};

// ──────────────────────────────────────────────────────────────────────────────
// The two machine-wide switches
// ──────────────────────────────────────────────────────────────────────────────
window.handleSystemProxyToggle = async function (enable) {
    const sp = document.getElementById('systemProxyToggle');
    // NOT CONNECTED IS AN ANSWER, NOT A NO-OP: pointing Windows at a dead port is what the
    // server refuses to do (409 XRAY_NOT_RUNNING), so say that and put the switch back.
    if (!window.v2rayIsConnected) {
        if (sp) sp.checked = false;
        if (enable) toast('اول به یک کانفیگ وصل شوید، بعد پروکسی سیستم را روشن کنید.');
        return;
    }
    if (sp) sp.disabled = true;
    try {
        const res = await fetch('/api/v2ray/sysproxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enable }),
        });
        const d = await res.json().catch(() => ({}));
        if (res.ok && !d.error) {
            toast(enable ? '✅ پروکسی سیستم روشن شد' : '✅ پروکسی سیستم خاموش شد');
            if (enable) {
                const t = document.getElementById('v2rayTunToggle');
                if (t) t.checked = false;
            }
        } else {
            toast('❌ ' + (d.error || 'خطا در تغییر وضعیت پروکسی سیستم'));
        }
    } catch (e) {
        toast('❌ خطا: ' + e.message);
    }
    if (sp) sp.disabled = false;
    window.syncV2raySwitches();
};

/**
 * Full-tunnel switch.
 *
 * The switch is snapped back before anything is verified and only turned on by the server's
 * answer: a green «بدون نشتی» over a tunnel that did not come up is the most dangerous thing
 * this panel could display.
 */
window.handleV2rayTunToggle = async function (on) {
    window.setV2rayBusy(true, on ? 'در حال برقراری تونل…' : 'در حال خاموش کردن تونل…');
    const cb = document.getElementById('v2rayTunToggle');
    if (cb) { cb.checked = false; cb.disabled = true; cb.title = on ? 'در حال برقراری و راستی‌آزمایی تونل…' : 'در حال خاموش کردن…'; }
    if (on) toast('در حال برقراری تونل و بررسی عبور واقعی دیتا…');
    try {
        const res = await fetch('/api/v2ray/tun', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!on }),
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d.error) {
            if (cb) cb.checked = false;
            toast('❌ ' + (d.error || 'تونل کامل روشن نشد'));
        } else {
            // `running` comes from the server AFTER the payload check passed, so this is the
            // first moment the switch is entitled to be green.
            if (cb) cb.checked = !!d.running;
            toast(d.running ? '✅ تونل برقرار و راستی‌آزمایی شد — تمام ترافیک سیستم از این کانفیگ رد می‌شود' : 'تونل کامل خاموش شد');
            if (d.running) {
                const sp = document.getElementById('systemProxyToggle');
                if (sp) sp.checked = false;
            }
        }
    } catch (e) {
        if (cb) cb.checked = false;
        toast('❌ ' + e.message);
    }
    window.setV2rayBusy(false);
    if (cb) { cb.disabled = false; cb.title = ''; }
    window.syncV2raySwitches();
};

/**
 * Both switches, read back from the server.
 *
 * They describe machine-wide state that half a dozen other paths can change — the tunnel
 * guard tearing a dead tunnel down, another panel taking the adapter, the engine restarting,
 * a session restored at logon. Every path that changes the session ends here.
 */
window.syncV2raySwitches = async function () {
    if (typeof window.refreshV2rayTunToggle === 'function') await window.refreshV2rayTunToggle();
    const sp = document.getElementById('systemProxyToggle');
    if (!sp) return;
    try {
        const d = await (await fetch('/api/proxy/system')).json();
        sp.checked = !!(d && d.enabled);
    } catch (e) { /* the panel is still usable without this */ }
};

window.refreshV2rayTunToggle = async function () {
    const cb = document.getElementById('v2rayTunToggle');
    if (!cb) return;
    try {
        const d = await (await fetch('/api/v2ray/tun/status')).json();
        cb.checked = !!d.running;
        cb.title = d.ready ? '' : (d.reason || '');
    } catch (e) { /* the panel is still usable without this */ }
};

// ──────────────────────────────────────────────────────────────────────────────
// Live traffic
// ──────────────────────────────────────────────────────────────────────────────
window.v2rayTrafficInterval = null;
window.lastTrafficStats = null;
window.lastTrafficTime = null;

window.startTrafficPolling = function () {
    if (window.v2rayTrafficInterval) clearInterval(window.v2rayTrafficInterval);
    const stats = document.getElementById('v2ray-traffic-stats');
    if (stats) stats.classList.remove('hidden');

    window.lastTrafficStats = null;
    window.lastTrafficTime = Date.now();

    window.v2rayTrafficInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/v2ray/traffic');
            const data = await res.json();

            // THE ENGINE DIED AND NOTHING TOLD THE PANEL.
            //
            // This response always carried `running` and this poll — the only thing here that
            // talks to the server every second — used to ignore it, so every server-side end
            // of a session left «متصل است» on screen: the tunnel guard, an IP scan taking the
            // engine, xray.exe crashing, another panel connecting something else.
            // TWO consecutive misses, and none while a connect is in flight: switching node
            // restarts the engine, so the process legitimately disappears for about a second.
            if (data && data.running === false) {
                const btn = document.getElementById('btn-main-connect');
                if (btn && btn.disabled) { window._v2rayDeadTicks = 0; return; }
                if ((window._v2rayDeadTicks = (window._v2rayDeadTicks || 0) + 1) < 2) return;
                window._v2rayDeadTicks = 0;
                toast('⚠️ موتور v2ray متوقف شد');
                window.disconnectV2rayUI();
                return;
            }
            window._v2rayDeadTicks = 0;

            const now = Date.now();
            const up = document.getElementById('stat-upload-speed');
            const down = document.getElementById('stat-download-speed');
            const total = document.getElementById('stat-total-traffic');
            if (window.lastTrafficStats) {
                const dt = (now - window.lastTrafficTime) / 1000;
                if (dt > 0) {
                    if (up) up.innerText = formatBytes(Math.max(0, (data.sessionUp - window.lastTrafficStats.sessionUp) / dt)) + '/s';
                    if (down) down.innerText = formatBytes(Math.max(0, (data.sessionDown - window.lastTrafficStats.sessionDown) / dt)) + '/s';
                }
            } else {
                if (up) up.innerText = '0 B/s';
                if (down) down.innerText = '0 B/s';
            }
            if (total) total.innerText = formatBytes(data.sessionUp + data.sessionDown);

            window.lastTrafficStats = data;
            window.lastTrafficTime = now;
        } catch (e) { /* one missed tick is not worth a message */ }
    }, 1000);
};

window.stopTrafficPolling = function () {
    if (window.v2rayTrafficInterval) clearInterval(window.v2rayTrafficInterval);
    // Cleared, not just stopped: a stale handle makes a later start unable to tell whether a
    // poll is already running.
    window.v2rayTrafficInterval = null;
    window.lastTrafficStats = null;
    const stats = document.getElementById('v2ray-traffic-stats');
    if (stats) stats.classList.add('hidden');
    const up = document.getElementById('stat-upload-speed');
    const down = document.getElementById('stat-download-speed');
    const total = document.getElementById('stat-total-traffic');
    if (up) up.innerText = '0 B/s';
    if (down) down.innerText = '0 B/s';
    if (total) total.innerText = '0 B';
};

function formatBytes(bytes, decimals = 2) {
    if (!+bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals < 0 ? 0 : decimals)) + ' ' + sizes[i];
}

// ──────────────────────────────────────────────────────────────────────────────
// Row menus
// ──────────────────────────────────────────────────────────────────────────────
window.toggleNodeMenu = function (e, idx) {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    const menu = document.getElementById('node-menu-' + idx);
    const wasOpen = menu && !menu.classList.contains('hidden');
    closeAllNodeMenus();
    if (menu && !wasOpen) {
        menu.classList.remove('hidden');
        const card = menu.closest('.node-card');
        if (card) card.style.zIndex = '50';
    }
};

window.closeNodeMenu = function (idx) {
    const menu = document.getElementById('node-menu-' + idx);
    if (!menu) return;
    menu.classList.add('hidden');
    const card = menu.closest('.node-card');
    if (card) card.style.zIndex = '';
};

function closeAllNodeMenus() {
    document.querySelectorAll('[id^="node-menu-"]').forEach(menu => {
        menu.classList.add('hidden');
        const card = menu.closest('.node-card');
        if (card) card.style.zIndex = '';
    });
}

document.addEventListener('click', function (e) {
    if (!e.target.closest('.v2-menu-wrap')) closeAllNodeMenus();
    const sortBox = document.getElementById('sortMenuContainer');
    if (sortBox && !sortBox.contains(e.target)) window.closeSortMenu();
});

// ──────────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────────
function initV2rayModule() {
    const container = document.getElementById('ls-v2ray');
    if (!container) return;
    container.innerHTML = v2rayHtmlTemplate;

    // Both machine-wide switches outlive this panel, so read the real state instead of
    // drawing two unchecked boxes.
    window.syncV2raySwitches();

    const solo = document.getElementById('v2raySoloToggle');
    if (solo) solo.checked = V2RAY_SOLO.get();

    markActiveSort();
    window.renderV2rayList();

    // NOTHING IS BOUND TWICE HERE.
    //
    // This used to addEventListener the connect button and the edit sheet's save button on top
    // of their own inline onclick — so one click ran the connect twice (two POSTs to
    // /api/v2ray/start, the second killing the engine the first started) and one click saved an
    // edit twice. It also bound the test buttons through `document.querySelectorAll(
    // '.overflow-x-auto button')`, a document-wide selector that could attach a delay test to
    // buttons in other panels entirely. Every handler in this panel is now declared once, in
    // the markup above.
}

window.initV2rayModule = initV2rayModule;
