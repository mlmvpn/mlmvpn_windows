// --- The live traffic chart that sits beside a connect button ---
//
// One implementation for every engine page (سایفون/تور/لنترن/گف and ماسک/وایرگارد/وارپ در وارپ),
// because a second copy is how two pages end up disagreeing about the same bytes.
//
// The figures come from the app's own feed (traffic-feed.js → the `traffic_update` socket message,
// re-broadcast as the `mv-traffic` DOM event by components/scanner-sidebar.js). That feed is the
// WHOLE app's throughput — with two engines up it has no split to give — so the card is headed
// «ترافیک زنده» and never claims the number belongs to one engine.
//
// Download is drawn upward from the midline and upload downward, on ONE shared scale: the question
// a chart this size answers is «is anything moving, and which way».
(function () {
    'use strict';

    const N = 56;                       // about a minute of history, one sample a second
    const W = 220, H = 74, MID = 37, PAD = 4;
    const FLOOR = 16 * 1024;            // a floor under the scale, so 40 bytes of keep-alive is
    //                                     not drawn as a full-height peak on an idle window
    const UNITS = ['B', 'KB', 'MB', 'GB'];

    const hist = { down: [], up: [], at: 0 };
    const hosts = [];
    let seq = 0;

    const fa = (n) => String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[+d]);

    function speedParts(v) {
        let n = Math.max(0, v || 0), u = 0;
        while (n >= 1024 && u < UNITS.length - 1) { n /= 1024; u++; }
        // ٫ is the decimal mark in Persian; a Latin dot beside Persian digits reads as a full stop.
        return { n: fa(u === 0 || n >= 100 ? Math.round(n) : n.toFixed(1)).replace('.', '٫'), u: UNITS[u] + '/s' };
    }

    function build(host) {
        const id = 'mvlive' + (++seq);
        host.dataset.liveId = id;
        host.innerHTML = `
        <div class="mv-eng-live-top"><span>ترافیک زنده</span><i class="mv-eng-live-dot" data-part="dot"></i></div>
        <svg class="mv-eng-live-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="${id}-d" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--mv-green)" stop-opacity=".42"/>
              <stop offset="1" stop-color="var(--mv-green)" stop-opacity="0"/>
            </linearGradient>
            <linearGradient id="${id}-u" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0" stop-color="var(--mv-blue)" stop-opacity=".42"/>
              <stop offset="1" stop-color="var(--mv-blue)" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <line class="mv-eng-live-mid" x1="0" y1="${MID}" x2="${W}" y2="${MID}"></line>
          <path data-part="fd" fill="url(#${id}-d)" stroke="none"></path>
          <path data-part="fu" fill="url(#${id}-u)" stroke="none"></path>
          <path class="mv-eng-live-ln is-down" data-part="ld" fill="none"></path>
          <path class="mv-eng-live-ln is-up" data-part="lu" fill="none"></path>
        </svg>
        <div class="mv-eng-live-figs">
          <span class="is-down"><i class="ph-bold ph-arrow-down"></i><b data-part="vd">۰</b><small data-part="ud">B/s</small></span>
          <span class="is-up"><i class="ph-bold ph-arrow-up"></i><b data-part="vu">۰</b><small data-part="uu">B/s</small></span>
        </div>`;
    }

    function draw(host) {
        if (!host) return;
        if (!host.dataset.liveId) build(host);
        const q = (n) => host.querySelector(`[data-part="${n}"]`);

        // Nothing at all is drawn as nothing: two flat lines lying on the midline made an idle
        // window look like it was carrying a perfectly steady stream. The dashed rule says it.
        const silent = !hist.down.some((v) => v > 0) && !hist.up.some((v) => v > 0);
        const max = Math.max(FLOOR, ...hist.down, ...hist.up);
        const curve = (arr, dir) => {
            const m = arr.length;
            if (m < 2 || silent) return { line: '', fill: '' };
            const pts = arr.map((v, i) => [i / (m - 1) * W, MID - dir * Math.min(1, v / max) * (MID - PAD)]);
            const line = pts.map((p, i, a) => {
                if (!i) return `M${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
                const prev = a[i - 1], cx = (prev[0] + p[0]) / 2;
                return `C${cx.toFixed(1)} ${prev[1].toFixed(1)} ${cx.toFixed(1)} ${p[1].toFixed(1)} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`;
            }).join(' ');
            return { line, fill: `${line} L${W} ${MID} L0 ${MID} Z` };
        };

        const d = curve(hist.down, 1), u = curve(hist.up, -1);
        q('ld').setAttribute('d', d.line);
        q('lu').setAttribute('d', u.line);
        q('fd').setAttribute('d', d.fill);
        q('fu').setAttribute('d', u.fill);

        const lastD = hist.down.length ? hist.down[hist.down.length - 1] : 0;
        const lastU = hist.up.length ? hist.up[hist.up.length - 1] : 0;
        const pd = speedParts(lastD), pu = speedParts(lastU);
        q('vd').textContent = pd.n; q('ud').textContent = pd.u;
        q('vu').textContent = pu.n; q('uu').textContent = pu.u;

        // The dot is lit only while bytes are actually arriving — a feed that stopped a minute ago
        // must not look live just because the last figure is still on screen.
        const flowing = Date.now() - hist.at < 6000 && (lastD > 0 || lastU > 0);
        q('dot').classList.toggle('is-live', flowing);
        host.classList.toggle('is-idle', !flowing);
    }

    function drawAll() {
        for (let i = hosts.length - 1; i >= 0; i--) {
            const h = hosts[i];
            // A window whose panel was rebuilt leaves its old node behind; drop it rather than
            // drawing into a document fragment nobody will ever see.
            if (!h.isConnected) { hosts.splice(i, 1); continue; }
            if (h.offsetParent) draw(h);
        }
    }

    document.addEventListener('mv-traffic', (e) => {
        const sp = (e.detail && e.detail.speed) || {};
        hist.down.push(Math.max(0, +sp.down || 0));
        hist.up.push(Math.max(0, +sp.up || 0));
        while (hist.down.length > N) hist.down.shift();
        while (hist.up.length > N) hist.up.shift();
        hist.at = Date.now();
        drawAll();
    });

    window.MVEngineLive = {
        /** Draw into this element, and keep it drawn as new samples arrive. */
        mount(host) {
            if (!host) return;
            if (hosts.indexOf(host) < 0) hosts.push(host);
            draw(host);
        },
        draw,
    };
})();
