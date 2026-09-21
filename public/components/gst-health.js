// --- GST health tab ---
// Renders the system checks (certificate, Google reachability) and the per-relay,
// per-leg verdict with its repair buttons.
//
// The design rule this file implements: every red row carries a Persian explanation and
// at least one button. A user must never be left looking at a fault with nothing to click.

const GST_HEALTH_STATE = {
    ok: { color: 'var(--mv-green)', text: 'سالم' },
    slow: { color: 'var(--mv-yellow)', text: 'کند' },
    degraded: { color: 'var(--mv-yellow)', text: 'نیمه‌سالم' },
    quota: { color: 'var(--mv-orange)', text: 'سهمیه تمام' },
    incomplete: { color: 'var(--mv-blue)', text: 'ناتمام' },
    error: { color: 'var(--mv-red)', text: 'خطا' },
    off: { color: 'var(--mv-gray)', text: 'خاموش' },
    unknown: { color: 'var(--mv-gray)', text: 'تست نشده' },
};

function gstHealthDot(state) {
    const s = GST_HEALTH_STATE[state] || GST_HEALTH_STATE.unknown;
    return `<span style="width:9px;height:9px;border-radius:50%;flex:none;
                 background:${s.color};box-shadow:0 0 6px color-mix(in srgb, ${s.color} 40%, transparent);"></span>`;
}

/** A system-level row: certificate, Google access, and so on. */
function gstSystemRow(label, state, detail, actions) {
    const buttons = (actions || []).map(a =>
        `<button class="gst-btn-mini" onclick='gstRunAction(${JSON.stringify(a).replace(/'/g, '&#39;')})'>${gstEsc(a.label)}</button>`
    ).join('');

    return `<div class="gst-hrow">
        <div class="gst-hrow-main">
            ${gstHealthDot(state)}
            <span class="gst-hrow-label">${gstEsc(label)}</span>
            <span class="gst-hrow-state">${gstEsc((GST_HEALTH_STATE[state] || {}).text || '')}</span>
        </div>
        ${detail ? `<div class="gst-hrow-detail">${gstEsc(detail)}</div>` : ''}
        ${buttons ? `<div class="gst-hrow-actions">${buttons}</div>` : ''}
    </div>`;
}

/** One relay block: two legs, each with its own lamp and its own repair advice. */
function gstHealthRelayBlock(r) {
    const leg = (title, probe, advice, enabled) => {
        if (!enabled) {
            return `<div class="gst-leg">
                ${gstHealthDot('off')}
                <span class="gst-leg-name">${gstEsc(title)}</span>
                <span class="gst-leg-msg">خاموش</span>
            </div>`;
        }
        const p = probe || { state: 'unknown', message: 'تست نشده' };
        const ms = p.latency ? ` · ${p.latency.toLocaleString('fa-IR')}ms` : '';
        const fix = advice ? `
            <div class="gst-fix">
                <div class="gst-fix-title">${gstEsc(advice.title)}</div>
                <div class="gst-fix-detail">${gstEsc(advice.detail)}</div>
                <div class="gst-hrow-actions">${(advice.actions || []).map(a =>
                    `<button class="gst-btn-mini" onclick='gstRunAction(${JSON.stringify(a).replace(/'/g, '&#39;')})'>${gstEsc(a.label)}</button>`
                ).join('')}</div>
            </div>` : '';

        return `<div class="gst-leg-wrap">
            <div class="gst-leg">
                ${gstHealthDot(p.state)}
                <span class="gst-leg-name">${gstEsc(title)}</span>
                <span class="gst-leg-msg">${gstEsc(String(p.message || '').split('\n')[0])}${ms}</span>
            </div>
            ${fix}
        </div>`;
    };

    // Quota is shown only once it means something; "0%" on a fresh relay is noise.
    const q = r.quota && r.quota.google;
    const quotaBar = (q && q.used > 0) ? `
        <div class="gst-quota">
            <div class="gst-quota-bar"><i style="width:${q.percent}%;
                 background:${q.warning ? 'var(--mv-orange)' : 'var(--mv-accent)'}"></i></div>
            <span>${q.used.toLocaleString('fa-IR')} از ${q.limit.toLocaleString('fa-IR')} (${q.percent}٪)</span>
        </div>` : '';

    // Only offered when the relay claims to use Cloudflare: it answers "is the
    // combination REALLY active?", which is only a question once you expect it to be.
    const comboRow = r.cfEnabled ? `
        <div class="gst-combo">
            <button class="gst-btn-mini" onclick="gstTestCombination('${gstEsc(r.id)}')">
                تست ترکیب کلادفلر
            </button>
            ${gstComboResults[r.id] ? `
                <div class="gst-hrow-detail" style="white-space:pre-line;">
                    ${gstEsc(gstComboResults[r.id].message)}
                </div>` : `
                <span class="gst-hrow-state">آیا ترافیک واقعاً از Worker عبور می‌کند؟</span>`}
        </div>` : '';

    return `<div class="gst-hblock">
        <div class="gst-hblock-head">
            ${gstHealthDot(r.verdict.state)}
            <b>${gstEsc(r.name)}</b>
            <span class="gst-hrow-state">${gstEsc(r.verdict.text)}</span>
        </div>
        ${comboRow}
        ${leg('گوگل (Apps Script)', r.google, r.advice && r.advice.google, true)}
        ${leg('کلادفلر (Worker)', r.cf, r.advice && r.advice.cloudflare, r.cfEnabled)}
        ${quotaBar}
    </div>`;
}

function gstRenderHealth() {
    const pane = document.getElementById('gst-tab-health');
    if (!pane) return;

    const h = gstHealthData;
    const cert = h.cert || {};
    const reach = h.reach || {};
    const report = h.report;

    const certAdvice = cert.state && cert.state !== 'ok' ? [
        { id: 'reinstall-cert', label: cert.state === 'missing' ? 'نصب گواهی' : 'نصب مجدد' },
    ] : [{ id: 'install-cert-browsers', label: 'نصب در مرورگرها' }];

    const when = report
        ? `آخرین بررسی: ${new Date(report.at).toLocaleTimeString('fa-IR')}`
        : 'هنوز بررسی نشده';

    const summary = report ? `
        <div class="gst-hsummary">
            ${report.counts.ok ? `<span style="color:var(--mv-green-ink)">${report.counts.ok.toLocaleString('fa-IR')} سالم</span>` : ''}
            ${report.counts.degraded ? `<span style="color:var(--mv-orange-ink)">${report.counts.degraded.toLocaleString('fa-IR')} نیمه‌سالم</span>` : ''}
            ${report.counts.quota ? `<span style="color:var(--mv-orange-ink)">${report.counts.quota.toLocaleString('fa-IR')} سهمیه تمام</span>` : ''}
            ${report.counts.incomplete ? `<span style="color:var(--mv-blue-ink)">${report.counts.incomplete.toLocaleString('fa-IR')} ناتمام</span>` : ''}
            ${report.counts.error ? `<span style="color:var(--mv-red-ink)">${report.counts.error.toLocaleString('fa-IR')} خراب</span>` : ''}
        </div>` : '';

    pane.innerHTML = `
        <div class="gst-hhead">
            <button class="gst-btn-primary" onclick="gstRunHealthCheck()"
                    id="gst-health-btn" ${gstHealthRunning ? 'disabled' : ''}>
                ${gstHealthRunning ? `در حال بررسی… ${gstHealthProgress}` : 'بررسی کامل'}
            </button>
            <span class="gst-note">${gstEsc(when)}</span>
        </div>
        ${summary}

        <div class="gst-hsystem">
            ${gstSystemRow('گواهی امنیتی', cert.state === 'ok' ? 'ok' : 'error',
                           cert.message || '', certAdvice)}
            ${gstSystemRow('دسترسی به گوگل', reach.reachable ? 'ok' : 'error',
                           reach.reachable
                               ? `باز است${reach.latency ? ` · ${reach.latency.toLocaleString('fa-IR')}ms` : ''}`
                               : `بسته است${reach.error ? ` — ${reach.error}` : ''}`,
                           reach.reachable ? [] : [{ id: 'retry-reach', label: 'تلاش مجدد' }])}
        </div>

        ${report && report.relays.length
            ? `<div class="gst-hrelays">${report.relays.map(gstHealthRelayBlock).join('')}</div>`
            : '<div class="gst-placeholder">برای دیدن وضعیت ریلی‌ها، «بررسی کامل» را بزنید.</div>'}

        ${report ? `<div class="gst-note" style="margin-top:6px;">
            ${gstEsc(report.reset.google.note)}<br>
            سهمیه‌ی گوگل ساعت ${gstEsc(report.reset.google.clock)} و سهمیه‌ی کلادفلر ساعت
            ${gstEsc(report.reset.cloudflare.clock)} به وقت ایران ریست می‌شود.
        </div>` : ''}
    `;
}

// ── state + actions ───────────────────────────────────────────────────────────

let gstHealthData = { cert: {}, reach: {}, report: null };
let gstHealthRunning = false;
let gstHealthProgress = '';
// relayId -> combination result, kept so the verdict survives a re-render.
let gstComboResults = {};

/**
 * Prove (or disprove) that traffic really goes through the user's Worker.
 * The panel switch only records intent; the truth lives in the deployed Apps Script,
 * which we cannot read — so the backend compares egress addresses instead.
 */
async function gstTestCombination(relayId) {
    gstToast('در حال بررسی مسیر واقعی ترافیک…');
    try {
        const { result } = await gstApi(`health/combination/${relayId}`, {});
        gstComboResults[relayId] = result;
        gstToast(result.combined === true ? '✅ ترکیب فعال است'
               : result.ok ? '⚠ ترکیب فعال نیست' : '❌ ' + result.message);
    } catch (e) {
        gstComboResults[relayId] = { message: 'خطا: ' + e.message };
        gstToast('❌ ' + e.message);
    }
    gstRenderHealth();
}

async function gstLoadHealth() {
    try {
        const [cert, reach, health] = await Promise.all([
            gstApi('cert'), gstApi('reach'), gstApi('health'),
        ]);
        gstHealthData = { cert: cert.cert, reach: reach.google, report: health.report };
        gstRenderHealth();
    } catch (e) {
        const pane = document.getElementById('gst-tab-health');
        if (pane) pane.innerHTML = `<div class="gst-placeholder">خطا: ${gstEsc(e.message)}</div>`;
    }
}

async function gstRunHealthCheck() {
    if (gstHealthRunning) return;
    gstHealthRunning = true;
    gstHealthProgress = '';
    gstRenderHealth();
    try {
        const [cert, reach, health] = await Promise.all([
            gstApi('cert'), gstApi('reach'), gstApi('health/check', {}),
        ]);
        gstHealthData = { cert: cert.cert, reach: reach.google, report: health.report };
        // Lamps in the relay list come from the same report, so a health sweep updates
        // both tabs at once rather than leaving tab 1 showing stale "تست نشده".
        if (health.report) {
            gstHealth = {};
            for (const r of health.report.relays) {
                // Carry the relay-level verdict into the Google lamp for the states the
                // raw probe cannot express on its own — an unbuilt relay is "incomplete",
                // not an error, and the card must not paint it red.
                const google = { ...r.google };
                if (r.verdict.state === 'incomplete') google.state = 'incomplete';
                gstHealth[r.id] = { google, cf: r.cf };
            }
            gstRenderRelays();
        }
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
    gstHealthRunning = false;
    gstRenderHealth();
}

/** Dispatch a repair action produced by gst-repair.js. */
async function gstRunAction(action) {
    if (!action || !action.id) return;
    try {
        switch (action.id) {
            case 'reinstall-cert': {
                gstToast('در حال نصب گواهی…');
                const r = await gstApi('cert/install', {});
                gstToast(r.cert.state === 'ok' ? '✅ گواهی نصب شد' : '❌ ' + r.cert.message);
                break;
            }
            case 'install-cert-browsers': {
                const r = await gstApi('cert/browsers', {});
                gstToast(r.result.message);
                break;
            }
            case 'retry-reach':
                await gstApi('reach');
                gstToast('دوباره بررسی شد');
                break;
            case 'disable-cf':
                await gstApi(`relays/${action.relayId}/cloudflare`, { enabled: false });
                gstToast('کلادفلر این ریلی خاموش شد');
                await gstRefresh();
                break;
            case 'open-deployment':
                if (action.url) window.open(action.url, '_blank');
                break;
            case 'copy-auth-key':
                await navigator.clipboard.writeText(gstState.authKey || '');
                gstToast('رمز کپی شد');
                break;
            case 'rebuild-script':
                // Reopens the wizard on the script step for this relay only.
                if (typeof gstResumeWizard === 'function') gstResumeWizard(action.relayId);
                break;
            case 'copy-script': {
                const s = await gstApi(`script/${action.relayId}`);
                await gstWizCopy(s.script, 'اسکریپت اصلاح‌شده کپی شد');
                break;
            }
            case 'redeploy-worker': {
                const relay = gstState.relays.find(r => r.id === action.relayId);
                if (!relay || !relay.cfAccountId) {
                    gstToast('حساب کلادفلر این ریلی مشخص نیست — از ویزارد دوباره بسازید.');
                    break;
                }
                gstToast('در حال ساخت مجدد Worker…');
                const r = await gstApi(`cf/deploy/${action.relayId}`, { accountId: relay.cfAccountId });
                gstToast(r.probe && (r.probe.state === 'ok' || r.probe.state === 'slow')
                    ? '✅ Worker دوباره ساخته و تست شد'
                    : `⚠ ساخته شد ولی تست رد شد: ${r.probe.message}`);
                await gstRefresh();
                break;
            }
            case 'add-relay':
                if (typeof gstStartWizard === 'function') gstStartWizard();
                break;
            case 'wait-quota':
                gstToast('باشد — وقتی سهمیه برگشت، خودکار دوباره استفاده می‌شود.');
                break;
            default:
                gstToast('اقدام ناشناخته.');
        }
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
    await gstLoadHealth();
}
