// --- «دیاگ اینترنت» — the diagnostic panel ---
//
// Opens as a full tab from the hamburger menu, or from the auto-offer button when a network
// operation elsewhere in the app fails.
//
// The engine's whole value is that it refuses to overclaim, and this panel is where that value
// is either kept or thrown away. So the wording is a CONTRACT, not prose:
//
//   confirmed      «علت پیدا شد»
//   likely         «به احتمال زیاد»
//   possible       «یکی از احتمال‌ها»
//   indeterminate  «نتوانستیم مطمئن شویم» — never «مشکلی پیدا نشد»
//   by-design      «خودِ برنامه عمداً این کار را کرده»
//
// Two sentences are deliberately impossible to render here: «حل شد» for anything that is not a
// verified fix, and «مشکلی پیدا نشد» when the truth is that the evidence did not reach. Those
// are two different things, and telling a user with no internet that nothing is wrong is the
// most damaging thing this feature could do.
//
// Facts arrive over the authenticated REST route. The WebSocket carries progress only — a
// stage id and a percentage — because /ws accepts any Origin and is readable by any local
// process.

let ndState = {
    sessionId: null,
    running: false,
    phase: null,
    percent: 0,
    narrative: null,
    offers: [],
    facts: null,
    collectors: [],
    generation: null,
    busyRepair: '',
    lastError: '',
    reportText: '',
};

/** The one place a verdict becomes Persian. Nothing else in this file names a confidence. */
const ND_VERDICT = {
    confirmed: { label: 'علت پیدا شد', cls: 'nd-v-confirmed', lead: '' },
    likely: { label: 'به احتمال زیاد', cls: 'nd-v-likely', lead: 'به احتمال زیاد: ' },
    possible: { label: 'یکی از احتمال‌ها', cls: 'nd-v-possible', lead: 'یکی از احتمال‌ها: ' },
    indeterminate: { label: 'نامشخص', cls: 'nd-v-unknown', lead: '' },
    eliminated: { label: 'رد شد', cls: 'nd-v-unknown', lead: '' },
};

const ND_CAP_TEXT = {
    'unknown-mass': 'بخش زیادی از شواهد قابل اندازه‌گیری نبود',
    'generation-span': 'وضعیت شبکه در حین بررسی تغییر کرد',
    conflict: 'شواهد متناقض بود',
    'ownership-unknown': 'مشخص نشد این تنظیم را خودِ برنامه انجام داده یا نه',
};

function ndEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function ndFa(n) {
    return Number(n).toLocaleString('fa-IR');
}

/**
 * Every call carries the per-process token injected at server.js:47.
 *
 * The token is defence in depth, not the anti-rebinding control — the Host allowlist on the
 * server is that. It is sent because a request without it is refused, and because a caller that
 * has to read it from the page is one step further from a blind cross-origin POST.
 */
async function ndApi(path, body) {
    const opts = {
        headers: { 'X-Netdiag-Token': window.__NETDIAG_TOKEN__ || '' },
    };
    if (body !== undefined) {
        opts.method = 'POST';
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(`/api/netdiag/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `خطای سرور (${res.status})`);
    return data;
}

// ── the run ───────────────────────────────────────────────────────────────────

async function ndStart(mode) {
    if (ndState.running) return;
    ndState = Object.assign({}, ndState, {
        running: true, phase: 'w0', percent: 1, narrative: null, offers: [],
        facts: null, collectors: [], lastError: '', reportText: '',
    });
    ndRender();
    try {
        const r = await ndApi('start', { mode: mode || 'full' });
        ndState.sessionId = r.sessionId;
        ndRender();
        ndPoll();
    } catch (e) {
        ndState.running = false;
        ndState.lastError = e.message;
        ndRender();
    }
}

/**
 * Polls for completion.
 *
 * The run continues on the server after `start` returns, because a 35-second request would hit
 * every client timeout between here and the renderer. Progress arrives over /ws; this poll is
 * what fetches the actual result, and it is also the fallback if the socket is not connected.
 */
async function ndPoll() {
    if (!ndState.sessionId) return;
    try {
        const r = await ndApi(`session/${ndState.sessionId}`);
        ndState.narrative = r.narrative;
        ndState.offers = r.offers || [];
        ndState.facts = (r.session && r.session.facts) || null;
        ndState.collectors = (r.session && r.session.collectors) || [];
        ndState.generation = r.session && r.session.generation;
        if (r.done) {
            ndState.running = false;
            ndState.percent = 100;
            ndState.phase = 'done';
        }
        ndRender();
        if (!r.done) setTimeout(ndPoll, 700);
    } catch (e) {
        ndState.running = false;
        ndState.lastError = e.message;
        ndRender();
    }
}

async function ndCancel() {
    if (!ndState.sessionId) return;
    try { await ndApi('cancel', { sessionId: ndState.sessionId }); } catch (e) { /* it may have just finished */ }
}

/** WS progress. Carries a stage and a percentage — never a fact, an address or an adapter name. */
window.handleNetDiagEvent = function (data) {
    if (!data || data.sessionId !== ndState.sessionId) return;
    ndState.phase = data.phase;
    ndState.percent = typeof data.percent === 'number' ? data.percent : ndState.percent;
    ndUpdateProgress();
};

const ND_PHASE_LABEL = {
    w0: 'خواندن تنظیمات ویندوز',
    w1: 'بررسی ارتباط با مودم',
    w2: 'بررسی دسترسی به مقصدها',
    w3: 'ترجمهٔ نام سایت‌ها',
    w4: 'بررسی ارتباط امن',
    w5: 'بررسی باز شدن صفحه‌ها',
    discriminate: 'بررسی موارد باقی‌مانده',
    diagnose: 'نتیجه‌گیری',
    done: 'پایان',
};

// The assistant runs its own diagnosis and shows its own progress line, and both must read the
// same phase names — a top-level const is not reachable from another script without depending on
// load order, so it is published here rather than copied there.
window.ND_PHASE_LABEL = ND_PHASE_LABEL;

// ── repairs ───────────────────────────────────────────────────────────────────

/**
 * Apply one repair.
 *
 * The request carries `{ sessionId, repairId, confirmToken }` and nothing else — no adapter
 * name, no value, no free string. Every argument a privileged operation uses comes from the
 * server's own session and from fresh reads at gate time, so there is nothing here for a
 * caller to inject into.
 */
async function ndRepair(offer) {
    if (ndState.busyRepair) return;

    if (offer.tier !== 'auto') {
        const danger = offer.tier === 'confirm-danger';
        const lines = [
            offer.hint || '',
            offer.tierReason ? `\n\n⚠️ ${offer.tierReason}` : '',
            offer.reversible ? '' : '\n\nاین کار قابل برگشت نیست.',
            offer.requiresReboot ? '\n\nبرای کامل شدن باید ویندوز را دوباره راه‌اندازی کنید.' : '',
        ].join('');
        const ok = await uiConfirm({
            title: offer.label,
            message: lines.trim(),
            confirmText: danger ? 'می‌دانم، انجام بده' : 'انجام بده',
            danger,
        });
        if (!ok) return;
    }

    ndState.busyRepair = offer.repairId;
    ndRender();
    try {
        const r = await ndApi('repair', {
            sessionId: ndState.sessionId,
            repairId: offer.repairId,
            confirmToken: offer.confirmToken,
        });
        // The wording comes from the VERIFICATION engine, never from the fact that the command
        // returned. `verification.wording` is the one sentence allowed to say the problem is
        // gone, and it is only ever `fixed` that produces it.
        if (r.ok && r.verification && r.verification.wording) {
            toast(`${r.verification.outcome === 'fixed' ? '✅' : 'ℹ️'} ${r.verification.wording}`);
            if (r.verification.rolledBack) toast('↩️ تغییر برگردانده شد');
        } else {
            toast(r.ok ? '✅ انجام شد — دوباره بررسی می‌کنیم' : `⚠️ ${r.reason || 'انجام نشد'}`);
        }
        if (r.ok) {
            // Every other offer was computed against the machine as it was before this change,
            // so the server revoked their tokens. A fresh run is the only honest next step.
            await ndStart('full');
        } else {
            ndState.lastError = r.reason || '';
            ndRender();
        }
    } catch (e) {
        ndState.lastError = e.message;
        ndRender();
    } finally {
        ndState.busyRepair = '';
        ndRender();
    }
}

async function ndRepairAll() {
    const auto = ndState.offers.filter(o => o.tier === 'auto');
    if (!auto.length) return;
    for (const o of auto) {
        if (ndState.lastError) break;
        await ndRepair(o);
    }
}

// ── rendering ─────────────────────────────────────────────────────────────────

function ndUpdateProgress() {
    const bar = document.getElementById('nd-progress-bar');
    const lbl = document.getElementById('nd-progress-label');
    if (bar) bar.style.width = `${ndState.percent}%`;
    if (lbl) lbl.textContent = `${ND_PHASE_LABEL[ndState.phase] || '…'} — ${ndFa(ndState.percent)}٪`;
}

function ndHeadline() {
    const n = ndState.narrative;
    if (!n) return '';
    const h = n.headline || {};

    if (h.kind === 'single-root') {
        const e = n.rootCauses.find(x => x.id === h.id) || {};
        const v = ND_VERDICT[e.verdict] || ND_VERDICT.possible;
        return `<div class="nd-headline ${v.cls}">
            <div class="nd-headline-kicker">${ndEsc(v.label)}</div>
            <div class="nd-headline-title">${ndEsc(e.title || '')}</div>
        </div>`;
    }
    if (h.kind === 'multiple-roots') {
        // Never pick one arbitrarily to look decisive.
        return `<div class="nd-headline nd-v-likely">
            <div class="nd-headline-kicker">چند علت مستقل</div>
            <div class="nd-headline-title">${ndFa(h.ids.length)} علت پیدا شد که هرکدام به‌تنهایی می‌توانند باعث این وضعیت شوند</div>
        </div>`;
    }
    if (h.kind === 'undetermined' || h.kind === 'no-cause-for-symptom') {
        // The most important sentence in the panel. NOT «مشکلی پیدا نشد».
        return `<div class="nd-headline nd-v-unknown">
            <div class="nd-headline-kicker">نتیجه</div>
            <div class="nd-headline-title">علت قطعی پیدا نشد</div>
            <div class="nd-headline-sub">چیزهایی که نتوانستیم اندازه بگیریم پایین‌تر آمده است.</div>
        </div>`;
    }
    return `<div class="nd-headline nd-v-ok">
        <div class="nd-headline-kicker">نتیجه</div>
        <div class="nd-headline-title">در بررسی‌ها مشکلی پیدا نشد</div>
        <div class="nd-headline-sub">همهٔ آزمون‌هایی که انجام شد سالم بود.</div>
    </div>`;
}

function ndFinding(e, opts) {
    const o = opts || {};
    const v = ND_VERDICT[e.verdict] || ND_VERDICT.possible;
    const caps = (e.caps || []).map(c => ND_CAP_TEXT[c]).filter(Boolean);
    const conflicts = (e.conflicts || []).filter(c => c.note).map(c => c.note);

    return `<div class="nd-finding ${o.quiet ? 'nd-quiet' : ''}">
        <div class="nd-finding-head">
            <span class="nd-badge ${v.cls}">${ndEsc(v.label)}</span>
            <span class="nd-finding-title">${ndEsc(e.title || e.id)}</span>
        </div>
        ${e.consequenceOf ? `<div class="nd-finding-note">این نتیجهٔ همان مورد بالاست، نه یک مشکل جدا.</div>` : ''}
        ${caps.length ? `<div class="nd-finding-note">${caps.map(ndEsc).join(' · ')}</div>` : ''}
        ${conflicts.length ? `<div class="nd-finding-note">${conflicts.map(ndEsc).join(' · ')}</div>` : ''}
    </div>`;
}

function ndSection(title, items, opts) {
    if (!items || !items.length) return '';
    const o = opts || {};
    return `<div class="nd-section">
        <div class="nd-section-title">${ndEsc(title)}</div>
        ${items.map(e => ndFinding(e, o)).join('')}
    </div>`;
}

function ndRepairsBlock() {
    if (!ndState.offers.length) return '';
    const auto = ndState.offers.filter(o => o.tier === 'auto');
    const rest = ndState.offers.filter(o => o.tier !== 'auto');

    const row = o => {
        const busy = ndState.busyRepair === o.repairId;
        const danger = o.tier === 'confirm-danger';
        return `<div class="nd-repair">
            <div class="nd-repair-text">
                <div class="nd-repair-label">${ndEsc(o.label)}</div>
                <div class="nd-repair-hint">${ndEsc(o.hint || '')}</div>
                ${o.tierReason ? `<div class="nd-repair-risk">⚠️ ${ndEsc(o.tierReason)}</div>` : ''}
            </div>
            <button class="${danger ? 'nd-btn-danger' : 'nd-btn-primary'}"
                ${busy ? 'disabled' : ''}
                onclick="ndRepairById('${ndEsc(o.repairId)}')">${busy ? '…' : 'انجام بده'}</button>
        </div>`;
    };

    return `<div class="nd-section">
        <div class="nd-section-title">چه کاری می‌توانیم انجام دهیم</div>
        ${auto.length ? `<button class="nd-btn-primary nd-btn-wide" ${ndState.busyRepair ? 'disabled' : ''}
            onclick="ndRepairAll()">همه را درست کن (${ndFa(auto.length)} مورد بی‌خطر)</button>` : ''}
        ${auto.map(row).join('')}
        ${rest.map(row).join('')}
    </div>`;
}

function ndUnknownsBlock() {
    const n = ndState.narrative;
    if (!n) return '';
    const missing = n.missingEvidence || [];
    const skipped = (ndState.collectors || []).filter(c => c.state === 'skipped' && c.skippedReason);
    if (!missing.length && !skipped.length) return '';

    // This block is why «نامشخص» is honest rather than evasive: it names what was not measured.
    return `<div class="nd-section nd-quiet">
        <div class="nd-section-title">چه چیزی نامشخص ماند</div>
        ${skipped.length ? `<ul class="nd-list">${skipped
            .map(c => `<li>${ndEsc(c.label || c.id)} — ${ndEsc(c.skippedReason)}</li>`).join('')}</ul>` : ''}
        ${missing.length ? `<div class="nd-finding-note">شواهدی که به‌دست نیامد: ${ndFa(missing.length)} مورد</div>
            <ul class="nd-list nd-mono">${missing.slice(0, 12).map(m => `<li>${ndEsc(m)}</li>`).join('')}</ul>` : ''}
    </div>`;
}

function ndMeasuredBlock() {
    if (!ndState.facts) return '';
    const measured = Object.values(ndState.facts)
        .filter(f => f.status === 'observed' && f.quality === 'measured');
    if (!measured.length) return '';
    return `<div class="nd-section nd-quiet">
        <div class="nd-section-title">چه چیزی را واقعاً اندازه گرفتیم (${ndFa(measured.length)} مورد)</div>
        <ul class="nd-list nd-mono">${measured.slice(0, 20)
        .map(f => `<li>${ndEsc(f.id)} = ${ndEsc(JSON.stringify(f.value))}${f.note ? ` — ${ndEsc(f.note)}` : ''}</li>`)
        .join('')}</ul>
    </div>`;
}

/**
 * Styles, injected once, following the same self-contained pattern `dnsclean.js` uses.
 *
 * The verdict colours are the only place confidence is expressed visually, and they are
 * deliberately conservative: `possible` and `indeterminate` share a muted grey so that a guess
 * never looks like a finding, and only `confirmed` gets a colour strong enough to lead with.
 */
const ND_STYLE = `
  .nd-wrap { display:flex; flex-direction:column; gap:12px; padding:14px 16px; }
  .nd-card { border-radius:14px; padding:14px 16px; background:color-mix(in srgb, var(--mv-blue) 7%, transparent);
             border:1px solid color-mix(in srgb, var(--mv-blue) 22%, transparent); }
  .nd-top { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .nd-title { font-size:15px; font-weight:700; }
  .nd-sub { font-size:11.5px; color:var(--mv-label-2); margin-top:3px; line-height:1.9; }
  .nd-actions { display:flex; gap:8px; flex-wrap:wrap; }

  .nd-btn-primary, .nd-btn-ghost, .nd-btn-danger {
    border-radius:9px; padding:7px 14px; font-size:12px; cursor:pointer; border:1px solid transparent;
    font-family:inherit; }
  .nd-btn-primary { background:var(--mv-accent); color:#fff; }
  .nd-btn-ghost { background:transparent; color:var(--mv-label-2); border-color:var(--mv-sep-2); }
  .nd-btn-danger { background:color-mix(in srgb, var(--mv-red) 14%, transparent); color:var(--mv-red-ink); border-color:color-mix(in srgb, var(--mv-red) 38%, transparent); }
  .nd-btn-primary:disabled, .nd-btn-ghost:disabled, .nd-btn-danger:disabled { opacity:.5; cursor:default; }
  .nd-btn-wide { width:100%; margin-bottom:10px; }

  .nd-progress { margin-top:12px; }
  .nd-progress-track { height:5px; border-radius:99px; background:var(--mv-fill-2); overflow:hidden; }
  .nd-progress-bar { height:100%; background:var(--mv-accent); border-radius:99px; transition:width .25s ease; }
  .nd-progress-label { font-size:11px; color:var(--mv-label-2); margin-top:6px; }

  .nd-error { margin-top:10px; padding:9px 11px; border-radius:9px; font-size:11.5px; line-height:1.9;
              background:color-mix(in srgb, var(--mv-red) 10%, transparent); border:1px solid color-mix(in srgb, var(--mv-red) 28%, transparent); color:var(--mv-red-ink); }
  .nd-warn { margin-top:10px; padding:9px 11px; border-radius:9px; font-size:11.5px; line-height:1.9;
             background:color-mix(in srgb, var(--mv-yellow) 9%, transparent); border:1px solid color-mix(in srgb, var(--mv-yellow) 26%, transparent); color:var(--mv-yellow-ink); }

  .nd-split { height:100%; min-height:0; flex:1; min-width:0; }
  .nd-split .nd-wrap { max-width:none; padding:0; }
  .nd-split .nd-card { padding:0; background:none; border:0; }
  .nd-split .nd-actions { display:flex; gap:7px; flex:none; }
  .nd-split .nd-report-pre { margin:0; width:100%; max-height:52vh; overflow:auto; white-space:pre-wrap;
    word-break:break-word; font-family:var(--mv-font-mono); font-size:11.5px; line-height:1.9; color:var(--mv-label-2); }
  .nd-headline { margin-top:14px; padding:12px 14px; border-radius:12px;
                 border:1px solid var(--mv-sep-2); background:var(--mv-fill); }
  .nd-headline-kicker { font-size:10.5px; letter-spacing:.02em; color:var(--mv-label-2); margin-bottom:5px; }
  .nd-headline-title { font-size:14.5px; font-weight:700; line-height:1.8; }
  .nd-headline-sub { font-size:11.5px; color:var(--mv-label-2); margin-top:6px; line-height:1.9; }
  .nd-headline.nd-v-confirmed { border-color:color-mix(in srgb, var(--mv-red) 34%, transparent); background:color-mix(in srgb, var(--mv-red) 7%, transparent); }
  .nd-headline.nd-v-likely    { border-color:color-mix(in srgb, var(--mv-yellow) 30%, transparent); background:color-mix(in srgb, var(--mv-yellow) 6%, transparent); }
  .nd-headline.nd-v-ok        { border-color:color-mix(in srgb, var(--mv-green) 30%, transparent); background:color-mix(in srgb, var(--mv-green) 7%, transparent); }

  .nd-section { border-radius:12px; padding:12px 14px; background:var(--mv-fill);
                border:1px solid var(--mv-sep); }
  .nd-section.nd-quiet { background:transparent; border-color:var(--mv-sep); }
  .nd-section-title { font-size:12px; font-weight:700; color:var(--mv-label-2); margin-bottom:9px; }

  .nd-finding { padding:8px 0; border-top:1px solid var(--mv-sep); }
  .nd-finding:first-of-type { border-top:none; }
  .nd-finding.nd-quiet { opacity:.82; }
  .nd-finding-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .nd-finding-title { font-size:12.5px; line-height:1.8; }
  .nd-finding-note { font-size:11px; color:var(--mv-label-2); margin-top:4px; line-height:1.9; }

  .nd-badge { font-size:10px; padding:2px 7px; border-radius:6px; white-space:nowrap;
              border:1px solid var(--mv-sep-2); color:var(--mv-label-2); }
  .nd-badge.nd-v-confirmed { background:color-mix(in srgb, var(--mv-red) 14%, transparent); border-color:color-mix(in srgb, var(--mv-red) 38%, transparent); color:var(--mv-red-ink); }
  .nd-badge.nd-v-likely    { background:color-mix(in srgb, var(--mv-yellow) 12%, transparent); border-color:color-mix(in srgb, var(--mv-yellow) 34%, transparent); color:var(--mv-yellow-ink); }
  .nd-badge.nd-v-possible  { background:var(--mv-fill); }
  .nd-badge.nd-v-unknown   { background:var(--mv-fill); color:var(--mv-label-2); }

  .nd-repair { display:flex; align-items:flex-start; justify-content:space-between; gap:12px;
               padding:9px 0; border-top:1px solid var(--mv-sep); }
  .nd-repair:first-of-type { border-top:none; }
  .nd-repair-label { font-size:12.5px; }
  .nd-repair-hint { font-size:11px; color:var(--mv-label-2); margin-top:3px; line-height:1.9; }
  .nd-repair-risk { font-size:11px; color:var(--mv-yellow-ink); margin-top:4px; line-height:1.9; }

  .nd-list { margin:6px 18px 0 0; font-size:11px; line-height:2; color:var(--mv-label-2); }
  .nd-list li { list-style:disc; }
  .nd-mono { font-family:var(--mv-font-mono); font-size:10.5px; word-break:break-all; }

  /* The offer arrives as a notification banner from «دیاگ اینترنت»: it joins the banner
     stack under the menu bar (ui/mv.js), with the app's own icon and two small buttons. */
  .nd-offer { position:fixed; top:48px; left:14px; z-index:var(--mv-z-toast, 9999);
              width:340px; max-width:calc(100vw - 28px);
              display:flex; gap:10px; align-items:flex-start; padding:11px 13px; border-radius:14px;
              background:var(--mv-mat-regular); -webkit-backdrop-filter:var(--mv-blur-regular); backdrop-filter:var(--mv-blur-regular);
              box-shadow:var(--mv-e2); pointer-events:auto; animation:mv-banner-in var(--mv-d-3) var(--mv-ease-spring); }
  .mv-banners > .nd-offer { position:static; }
  .nd-offer-ic { width:30px; height:30px; flex:none; border-radius:22.5%; display:grid; place-items:center; color:#fff;
                 background:linear-gradient(180deg, color-mix(in srgb, var(--mv-red) 82%, #fff), color-mix(in srgb, var(--mv-red) 86%, #000)); }
  .nd-offer-ic svg { width:18px; height:18px; fill:currentColor; }
  .nd-offer-ic i { font-size:16px; }
  .nd-offer-main { flex:1; min-width:0; display:flex; flex-direction:column; gap:9px; }
  .nd-offer-text { display:flex; flex-direction:column; gap:2px; font-size:12px; line-height:1.8; }
  .nd-offer-text b { font-size:12.5px; }
  .nd-offer-text span { color:var(--mv-label-2); font-size:11.5px; }
  .nd-offer-actions { display:flex; gap:6px; }
  .nd-offer-actions button { padding:4px 12px; border-radius:var(--mv-r-sm); }
`;

function ndEnsureStyle() {
    if (document.getElementById('nd-style')) return;
    const tag = document.createElement('style');
    tag.id = 'nd-style';
    tag.textContent = ND_STYLE;
    document.head.appendChild(tag);
}

/**
 * «دیاگ اینترنت» on the page kit.
 *
 * The engine under this panel produces a great deal — root causes, the consequences of the same
 * cause, what is by design, what could not be measured, the repairs it can offer and what each
 * one changed. The old card put all of it in one scroll behind two buttons, so most of it was
 * never read. It is sections now, and the verdict is the home.
 */
const ND_SHELL = `
  <aside class="mv-side" id="nd-sidebar" aria-label="بخش‌های دیاگ">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident">
      <span class="mv-side-tile" style="--tint:var(--mv-red)"><i class="ph-fill ph-stethoscope"></i></span>
      <b>دیاگ اینترنت</b>
      <small><i class="mv-eng-dot" id="nd-dot"></i><span id="nd-dot-word">هنوز بررسی نشده</span></small>
    </div>
    <nav class="mv-side-list custom-scrollbar">
      <div class="mv-side-group">
        <div class="mv-side-head">بخش‌ها</div>
        <button type="button" class="mv-side-item" data-nd-sec="check">
          <span class="mv-side-tile" style="--tint:var(--mv-red)"><i class="ph-fill ph-pulse"></i></span><span>بررسی و نتیجه</span>
        </button>
        <button type="button" class="mv-side-item" data-nd-sec="evidence">
          <span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="ph-fill ph-list-magnifying-glass"></i></span><span>شواهد و اندازه‌ها</span>
        </button>
        <button type="button" class="mv-side-item" data-nd-sec="report">
          <span class="mv-side-tile" style="--tint:var(--mv-gray)"><i class="ph-fill ph-file-text"></i></span><span>گزارش</span>
        </button>
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="nd-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="nd-title">بررسی و نتیجه</h1>
    </header>
    <div class="mv-pane-scroll custom-scrollbar">
      <div class="mv-eng-sec is-on" data-nd-sec="check"><div id="net-diag-content"></div></div>
      <div class="mv-eng-sec" data-nd-sec="evidence"><div id="nd-evidence"></div></div>
      <div class="mv-eng-sec" data-nd-sec="report"><div id="nd-report"></div></div>
    </div>
  </section>`;

const ND_SEC_TITLE = { check: 'بررسی و نتیجه', evidence: 'شواهد و اندازه‌ها', report: 'گزارش' };
let ndSec = 'check';

window.ndGo = function (sec) {
    const root = document.getElementById('net-diag-root');
    if (!root) return;
    ndSec = ND_SEC_TITLE[sec] ? sec : 'check';
    root.querySelectorAll('.mv-eng-sec').forEach(function (x) { x.classList.toggle('is-on', x.getAttribute('data-nd-sec') === ndSec); });
    root.querySelectorAll('.mv-side-item[data-nd-sec]').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-nd-sec') === ndSec); });
    const pane = root.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', ndSec === 'check');
    const t = document.getElementById('nd-title');
    if (t) t.textContent = ND_SEC_TITLE[ndSec] || '';
    const back = document.getElementById('nd-back');
    if (back) back.disabled = ndSec === 'check';
    const sc = root.querySelector('.mv-pane-scroll');
    if (sc) sc.scrollTop = 0;
    ndRender();
};

/** The sidebar's own line: what the last run concluded, in a word beside a dot. */
function ndIdent() {
    const dot = document.getElementById('nd-dot');
    const word = document.getElementById('nd-dot-word');
    if (!dot || !word) return;
    const n = ndState.narrative;
    if (ndState.running) { dot.className = 'mv-eng-dot is-busy'; word.textContent = 'در حال بررسی'; return; }
    if (!n) { dot.className = 'mv-eng-dot'; word.textContent = 'هنوز بررسی نشده'; return; }
    const bad = (n.rootCauses && n.rootCauses.length) || 0;
    dot.className = 'mv-eng-dot ' + (bad ? 'is-bad' : 'is-on');
    word.textContent = bad ? 'علت پیدا شد' : 'چیزی پیدا نشد';
}

function ndRender() {
    ndEnsureStyle();
    const el = document.getElementById('net-diag-content');
    if (!el) return;
    const n = ndState.narrative;
    const unstable = ndState.generation && ndState.generation.unstable;

    ndIdent();
    ndRenderSide();
    el.innerHTML = `
    <div class="nd-wrap">
      <div class="mv-form-group nd-card">
        <div class="mv-status-head">
          <span class="mv-side-tile" style="--tint:var(--mv-red)"><i class="ph-fill ph-stethoscope"></i></span>
          <div class="mv-sh-text">
            <h2>وقتی ویندوز می‌گوید متصل است</h2>
            <p>…ولی هیچ صفحه‌ای باز نمی‌شود. می‌گردم، و هرچه از این‌جا قابل درست کردن باشد درست می‌کنم.</p>
          </div>
          <div class="mv-sh-end nd-actions">
            ${ndState.running
        ? `<button type="button" class="mv-btn" onclick="ndCancel()">توقف</button>`
        : `<button type="button" class="mv-btn" onclick="ndStart('quick')">بررسی سریع</button>
                   <button type="button" class="mv-btn mv-btn--primary" onclick="ndStart('full')">شروع بررسی</button>`}
          </div>
        </div>

        ${ndState.running || ndState.percent ? `
        <div class="nd-progress">
          <div class="nd-progress-track"><div class="nd-progress-bar" id="nd-progress-bar" style="width:${ndState.percent}%"></div></div>
          <div class="nd-progress-label" id="nd-progress-label">${ndEsc(ND_PHASE_LABEL[ndState.phase] || '…')} — ${ndFa(ndState.percent)}٪</div>
        </div>` : ''}

        ${ndState.lastError ? `<div class="nd-error">${ndEsc(ndState.lastError)}</div>` : ''}

        ${unstable ? `<div class="nd-warn">وضعیت شبکه در حین بررسی تغییر کرد، بنابراین نتیجه با اطمینان کمتری گفته می‌شود. بهتر است دوباره بررسی کنید.</div>` : ''}

        ${n ? ndHeadline() : ''}
      </div>

      ${n ? `
        ${ndSection('علت‌های اصلی', n.rootCauses)}
        ${ndSection('پیامدهای همان علت', n.consequences, { quiet: true })}
        ${ndRepairsBlock()}
        <div class="mv-form-footer">آن‌چه عمدی است، آن‌چه اندازه گرفته شد و آن‌چه نشد، همه در «شواهد و اندازه‌ها» آمده؛ متن کامل در «گزارش».</div>
      ` : ''}
    </div>`;
}

/** The evidence and the report sections — the same narrative, given room to be read. */
function ndRenderSide() {
    const n = ndState.narrative;
    const ev = document.getElementById('nd-evidence');
    if (ev) {
        ev.innerHTML = !n
            ? '<div class="mv-empty">هنوز بررسی‌ای انجام نشده. از بخش «بررسی و نتیجه» شروع کنید.</div>'
            : `<div class="nd-wrap">
                ${ndSection('این تنظیم عمدی است، مشکل نیست', n.byDesign, { quiet: true })}
                ${ndSection('یافته‌های جدا (علت باز نشدن صفحه‌ها نیستند)', n.independent, { quiet: true })}
                ${ndSection('نتیجه‌گیری نشد', n.unresolved, { quiet: true })}
                ${ndUnknownsBlock()}
                ${ndMeasuredBlock()}
              </div>`;
    }
    const rep = document.getElementById('nd-report');
    if (rep) {
        rep.innerHTML = !n
            ? '<div class="mv-empty">گزارشی نیست — اول یک بررسی انجام دهید.</div>'
            : `<div class="mv-form"><div class="mv-form-section is-wide">
                 <div class="mv-form-header">گزارش کامل</div>
                 <div class="mv-toolbar">
                   <div class="mv-tb-group" role="group" aria-label="گزارش">
                     <button type="button" class="mv-tb-btn" onclick="ndCopyReport()" title="کپی گزارش" aria-label="کپی گزارش"><i class="ph-bold ph-copy"></i></button>
                     <button type="button" class="mv-tb-btn" onclick="ndSaveReport()" title="ذخیرهٔ گزارش" aria-label="ذخیرهٔ گزارش"><i class="ph-bold ph-floppy-disk"></i></button>
                   </div>
                 </div>
                 <div class="mv-form-group"><div class="mv-form-row is-stack">
                   <pre class="nd-report-pre" dir="rtl">${ndEsc(ndBuildReport())}</pre>
                 </div></div>
                 <div class="mv-form-footer">این گزارش فقط روی همین کامپیوتر ساخته می‌شود و به هیچ سروری فرستاده نمی‌شود.</div>
               </div></div>`;
    }
}

// ── report ────────────────────────────────────────────────────────────────────

/**
 * Built from the session, locally, and never uploaded anywhere.
 *
 * The eight headings are the ones the architecture specifies, in order, because a report that
 * answers them in order is one a non-technical user can act on and a supporter can read.
 */
function ndBuildReport() {
    const n = ndState.narrative;
    if (!n) return '';
    const L = [];
    const h = n.headline || {};
    L.push('=== گزارش دیاگ اینترنت ===', '');

    L.push('۱) چه اتفاقی افتاده؟');
    if (h.kind === 'single-root') {
        const e = n.rootCauses.find(x => x.id === h.id) || {};
        L.push(`   ${(ND_VERDICT[e.verdict] || {}).label || ''}: ${e.title || ''}`);
    } else if (h.kind === 'multiple-roots') {
        L.push('   چند علت مستقل پیدا شد:');
        for (const e of n.rootCauses) L.push(`   - ${(ND_VERDICT[e.verdict] || {}).label}: ${e.title}`);
    } else if (h.kind === 'undetermined') {
        L.push('   علت قطعی پیدا نشد.');
    } else {
        L.push('   در بررسی‌ها مشکلی پیدا نشد.');
    }
    L.push('');

    L.push('۲) چرا صفحه‌ها باز نمی‌شوند؟');
    if (n.consequences.length) for (const e of n.consequences) L.push(`   - ${e.title} (نتیجهٔ ${e.consequenceOf})`);
    else L.push('   —');
    L.push('');

    L.push('۳) چه چیزی را واقعاً اندازه گرفتیم؟');
    const measured = ndState.facts
        ? Object.values(ndState.facts).filter(f => f.status === 'observed' && f.quality === 'measured')
        : [];
    for (const f of measured.slice(0, 40)) L.push(`   ${f.id} = ${JSON.stringify(f.value)}`);
    L.push('');

    L.push('۴) چه چیزی نامشخص است؟');
    for (const m of (n.missingEvidence || []).slice(0, 40)) L.push(`   ${m}`);
    for (const c of (ndState.collectors || []).filter(c => c.state === 'skipped' && c.skippedReason)) {
        L.push(`   ${c.id}: ${c.skippedReason}`);
    }
    L.push('');

    L.push('۵) چه کاری می‌خواهیم انجام دهیم؟');
    if (ndState.offers.length) for (const o of ndState.offers) L.push(`   [${o.tier}] ${o.label} — ${o.hint || ''}`);
    else L.push('   هیچ تعمیری پیشنهاد نشد.');
    L.push('');

    L.push('۶) چه ریسکی دارد؟');
    for (const o of ndState.offers) if (o.tierReason) L.push(`   ${o.label}: ${o.tierReason}`);
    L.push('');

    L.push('۷) بعد از تعمیر چه چیزی را بررسی کردیم؟');
    L.push('   —');
    L.push('');
    L.push('۸) آیا مشکل واقعی حل شد؟');
    L.push('   —');
    L.push('');

    if (n.unresolved && n.unresolved.length) {
        L.push('— موارد بی‌نتیجه —');
        for (const e of n.unresolved) L.push(`   ${e.title} (${e.reason || 'شواهد کافی نبود'})`);
        L.push('');
    }
    L.push(`— شناسهٔ بررسی: ${ndState.sessionId || '—'} —`);
    return L.join('\n');
}

/**
 * Fetch the report from the server rather than rebuilding it here.
 *
 * There is one generator (netdiag/report.js) because the wording contract has to live in one
 * place. When the panel built its own text, the same eight sections existed twice and could
 * drift — and the half that drifts is the half a user pastes into a support chat.
 *
 * `ndBuildReport()` below stays as the offline fallback for the case where the session is no
 * longer on the server (the process restarted, or it aged out of the in-memory set), so the
 * buttons never go dead on a result the user is still looking at.
 */
async function ndFetchReport() {
    if (!ndState.sessionId) return '';
    try {
        const r = await ndApi(`report/${ndState.sessionId}`);
        return r.text || '';
    } catch (e) {
        return ndBuildReport();
    }
}

window.ndCopyReport = async function () {
    const text = await ndFetchReport();
    if (!text) { toast('گزارش آماده نیست'); return; }
    if (typeof copyText === 'function') copyText(text);
};

window.ndSaveReport = async function () {
    const text = await ndFetchReport();
    if (!text) { toast('گزارش آماده نیست'); return; }
    if (typeof dlFile === 'function') dlFile(`netdiag-${ndState.sessionId || 'report'}.txt`, text);
};

window.ndRepairById = function (id) {
    const offer = ndState.offers.find(o => o.repairId === id);
    if (offer) ndRepair(offer);
};
window.ndRepairAll = ndRepairAll;
window.ndStart = ndStart;
window.ndCancel = ndCancel;

// ── the auto-offer ────────────────────────────────────────────────────────────
//
// The second entry point the requirements ask for: when a network operation elsewhere in the
// app fails, offer to diagnose it rather than leaving the user with a red toast and nowhere to
// go. Two rules keep it from becoming noise:
//
//   it is an OFFER, never an action. Opening a diagnostic tab is one thing; starting probes
//   without being asked is another, and a user who is mid-task should not have their network
//   poked because something timed out once.
//
//   it appears at most once per few minutes. A failing operation usually fails repeatedly, and
//   an offer that shows up on every retry is an offer nobody reads.

let ndLastOfferAt = 0;
const ND_OFFER_COOLDOWN_MS = 3 * 60 * 1000;

/**
 * Offer a diagnosis after a failed network operation.
 *
 * `context` is a short Persian phrase naming what failed — it goes into the toast so the user
 * can see the offer is about the thing they just tried, not a random prompt.
 */
window.ndOfferDiagnosis = function (context) {
    // THE ASSISTANT IS THE ONE FRONT DOOR NOW.
    // Two different offers for the same failure — a banner here and a card there — is worse
    // than either. The assistant can drive this whole module, repairs included, so it takes
    // the offer; this banner stays as the fallback for when it is not loaded or turned off.
    if (window.MVAssistant && typeof window.MVAssistant.trouble === 'function') {
        try { window.MVAssistant.trouble({ kind: 'no-internet', detail: context || '' }); return; } catch (e) { /* fall through to the banner */ }
    }
    // Already looking at the panel, or already running: nothing to offer.
    if (ndState.running) return;
    if (tabs && tabs.some(t => t.type === 'net-diag')) return;

    const now = Date.now();
    if (now - ndLastOfferAt < ND_OFFER_COOLDOWN_MS) return;
    ndLastOfferAt = now;

    const id = 'nd-offer-' + now;
    const wrap = document.createElement('div');
    wrap.id = id;
    wrap.className = 'nd-offer';
    wrap.dir = 'rtl';
    const icon = window.MV && MV.icons ? MV.icons.svg('g-pulse') : '<i class="ph-bold ph-pulse"></i>';
    wrap.innerHTML = `
      <div class="nd-offer-ic">${icon}</div>
      <div class="nd-offer-main">
        <div class="nd-offer-text">
          <b>اتصال شبکه مشکل دارد</b>
          <span>${ndEsc(context || 'یک عملیات شبکه انجام نشد')} — می‌خواهید علتش را پیدا کنیم؟</span>
        </div>
        <div class="nd-offer-actions">
          <button class="nd-btn-primary" id="${id}-go">بررسی کن</button>
          <button class="nd-btn-ghost" id="${id}-no">بعداً</button>
        </div>
      </div>`;
    ndEnsureStyle();
    // Into the banner stack when the design system is loaded, so it never covers a banner.
    (window.MV && MV.bannerStack ? MV.bannerStack() : document.body).appendChild(wrap);

    const close = () => { const n = document.getElementById(id); if (n) n.remove(); };
    document.getElementById(`${id}-go`).onclick = () => {
        close();
        // Entering this way DOES auto-run: the user has already told us something failed, so
        // making them press a second button to start would be asking a question they answered.
        window.openNetDiagTab({ autorun: true });
    };
    document.getElementById(`${id}-no`).onclick = close;
    setTimeout(close, 20000);
};

/**
 * The catch-all: watch every `/api/*` call the app makes.
 *
 * Hooking each feature's own failure path by hand covers the ones somebody remembered, and the
 * app has a lot of features — scanner, Aether, Xray, GST, «آیپی ثابت», GitHub Tunnel, dedicated DNS,
 * sanction-buster, cloud panels, workers manager, speed test. Wiring twelve catch blocks means
 * the thirteenth feature ships without one.
 *
 * So this observes the layer they all share. It counts CONSECUTIVE failures of the shape that
 * means "the network did not work" — a rejected fetch, a 5xx, or a JSON body reporting an error
 * whose text is network-shaped — and offers a diagnosis once a few in a row have failed. One
 * failure is noise; four in a row across a minute is a symptom.
 *
 * Deliberately conservative about what counts:
 *   * only `/api/` calls, so nothing else on the page can trigger it;
 *   * never the netdiag routes themselves, or a failing diagnosis would offer to diagnose itself;
 *   * never a 4xx, because those are this app telling the user they did something wrong
 *     («ابتدا یک تب باز کنید») and have nothing to do with the network.
 */
const ND_FAIL_WINDOW_MS = 60 * 1000;
const ND_FAIL_THRESHOLD = 3;
let ndFailures = [];

/** Does this look like the network failing, as opposed to the app refusing a bad request? */
function ndLooksNetworky(text) {
    return /timeout|timed out|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|network|اینترنت|شبکه|اتصال|مهلت|پاسخ نداد|در دسترس نیست|مسدود/i
        .test(String(text || ''));
}

function ndNoteFailure(what) {
    const now = Date.now();
    ndFailures = ndFailures.filter(t => now - t < ND_FAIL_WINDOW_MS);
    ndFailures.push(now);
    if (ndFailures.length >= ND_FAIL_THRESHOLD) {
        ndFailures = [];
        window.ndOfferDiagnosis(what);
    }
}

function ndWatchFetch() {
    if (window.__ndFetchWatched) return;
    window.__ndFetchWatched = true;
    const original = window.fetch;

    window.fetch = async function (input, init) {
        const url = String((input && input.url) || input || '');
        const ours = url.includes('/api/netdiag/');
        try {
            const res = await original.apply(this, arguments);
            if (!ours && url.includes('/api/') && res.status >= 500) {
                ndNoteFailure('چند درخواست شبکه پشت سر هم ناموفق شد');
                return res;
            }
            // A 200 whose body reports a network-shaped error is the most common shape here:
            // the route succeeded, the operation it performed did not.
            if (!ours && url.includes('/api/') && res.ok) {
                const clone = res.clone();
                clone.json().then(d => {
                    if (d && d.ok === false && ndLooksNetworky(d.error)) {
                        ndNoteFailure('چند عملیات شبکه پشت سر هم ناموفق شد');
                    }
                }).catch(() => { /* not JSON, or already consumed — nothing to learn */ });
            }
            return res;
        } catch (e) {
            // A rejected fetch to our own loopback server means the server itself is gone, which
            // is an app problem rather than a network one — so only non-netdiag /api rejections
            // with a networky message count.
            if (!ours && url.includes('/api/') && ndLooksNetworky(e && e.message)) {
                ndNoteFailure('ارتباط با سرور برنامه قطع شد');
            }
            throw e;
        }
    };
}

// Installed as soon as the script loads, so a failure during startup is seen too.
ndWatchFetch();

// ── tab plumbing, following the dnsclean component ────────────────────────────

window.openNetDiagTab = function (opts) {
    const existing = tabs.find(t => t.type === 'net-diag');
    if (existing) {
        switchTab(existing.id);
        if (opts && opts.autorun && !ndState.running) ndStart('full');
        return;
    }
    const id = 'tab_' + Date.now();
    tabs.push({
        id, isp: 'دیاگ اینترنت', state: 'done', type: 'net-diag',
        total: 0, tested: 0, alive: 0, dead: 0, results: [], settings: {},
    });
    switchTab(id);
    // Auto-run only when the user arrived because something already failed. Opening the panel
    // from the menu should not start probing the network unasked.
    if (opts && opts.autorun) ndStart('full');
};

/** Called by renderActiveTab when a net-diag tab becomes active. */
window.renderNetDiagTab = function () {
    let root = document.getElementById('net-diag-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'net-diag-root';
        // NO `flex-col` HERE. This root carries .mv-split, which is a flex ROW — the sidebar
        // beside the pane. Leaving Tailwind's flex-col on it stacked them instead: the sidebar
        // sat across the top at its own height and the page ran underneath it.
        root.className = '';
        root.dir = 'rtl';
        root.classList.add('nd-split', 'mv-split');
        root.innerHTML = ND_SHELL;
        // The sidebar is navigation; the sections below are what the engine already produces and
        // the old single scroll had nowhere to put.
        root.querySelectorAll('.mv-side-item[data-nd-sec]').forEach(function (b) {
            b.addEventListener('click', function () { ndGo(b.getAttribute('data-nd-sec')); });
        });
        const back = document.getElementById('nd-back');
        if (back) back.addEventListener('click', function () { ndGo('check'); });
        ndGo('check');
        const wrap = document.getElementById('editor-content-wrap');
        if (wrap) wrap.appendChild(root);
    }
    root.style.display = 'flex';
    if (typeof updateBreadcrumb === 'function') updateBreadcrumb('دیاگ اینترنت');
    ndRender();
};
