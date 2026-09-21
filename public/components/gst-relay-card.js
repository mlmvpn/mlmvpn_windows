// --- GST relay card ---
// One row in the relay list. Kept in its own file because it carries the feature's
// signature control: a Cloudflare switch that belongs to THIS relay alone. Neither
// reference project has that, and neither does our own Android app.
//
// Each relay shows two independent lamps — Google (Apps Script) and Cloudflare (Worker)
// — because they are two independent failure points. A relay whose Worker died still
// carries traffic over the direct path, and the card has to say so rather than showing
// one ambiguous red dot.

/** Escape user-controlled text before it goes anywhere near innerHTML. */
function gstEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

// Health states a leg can be in. `unknown` is the honest default before a test runs —
// showing green for an untested relay would be the panel lying about what it knows.
const GST_LAMP = {
    ok: { color: 'var(--mv-green)', label: 'سالم' },
    slow: { color: 'var(--mv-yellow)', label: 'کند' },
    quota: { color: 'var(--mv-orange)', label: 'سهمیه تمام' },
    // Half-finished, not faulty — blue reads as "todo", red would read as "broken".
    incomplete: { color: 'var(--mv-blue)', label: 'ناتمام' },
    error: { color: 'var(--mv-red)', label: 'خطا' },
    off: { color: 'var(--mv-gray)', label: 'خاموش' },
    unknown: { color: 'var(--mv-gray)', label: 'تست نشده' },
};

function gstLamp(state, text) {
    const s = GST_LAMP[state] || GST_LAMP.unknown;
    return `<span style="display:inline-flex; align-items:center; gap:5px; white-space:nowrap;">
        <span style="width:8px; height:8px; border-radius:50%; background:${s.color}; flex:none;
                     box-shadow:0 0 6px color-mix(in srgb, ${s.color} 40%, transparent);"></span>
        <span style="color:var(--mv-label-2); font-size:11px;">${gstEsc(text || s.label)}</span>
    </span>`;
}

/**
 * Render one relay card.
 * @param relay  stored relay object
 * @param health optional { google:{state,latency,detail}, cf:{state,latency,detail} }
 */
function renderGstRelayCard(relay, health) {
    const h = health || {};
    const g = h.google || { state: 'unknown' };
    // A relay with the Cloudflare switch off is not broken — it is configured that way.
    const cf = relay.cfEnabled
        ? (h.cf || { state: 'unknown' })
        : { state: 'off', detail: relay.workerUrl ? 'خاموش' : 'ساخته نشده' };

    // Latency is shown ONLY for a leg that actually worked. A failed probe still has a
    // duration, and printing "گوگل ۹۸۲۵ms" next to a red dot reads as "slow but alive"
    // when the truth is "dead" — the lamp and the text would be telling different
    // stories. For anything not healthy, the state word is the useful information.
    const legText = (name, leg) => {
        const healthy = leg.state === 'ok' || leg.state === 'slow';
        if (healthy && leg.latency) {
            return `${name} ${leg.latency.toLocaleString('fa-IR')}ms`;
        }
        return `${name}: ${leg.detail || GST_LAMP[leg.state]?.label || '—'}`;
    };

    const gText = legText('گوگل', g);
    const cfText = legText('کلادفلر', cf);

    // The switch is disabled without a Worker: turning it on would point the relay at
    // an endpoint that does not exist. The title explains why rather than leaving the
    // user clicking a dead control.
    const canToggleCf = !!relay.workerUrl;

    return `
<div class="gst-card" data-relay-id="${gstEsc(relay.id)}">
  <div class="gst-card-head">
    <span class="gst-drag" title="برای تغییر اولویت بکشید">⠿</span>
    <span class="gst-card-name" title="${gstEsc(relay.name)}">${gstEsc(relay.name)}</span>
    <button class="gst-icon-btn" title="حذف این ریلی"
            onclick="gstDeleteRelay('${gstEsc(relay.id)}')">✕</button>
  </div>

  <div class="gst-card-lamps">
    ${gstLamp(g.state, gText)}
    ${gstLamp(cf.state, cfText)}
  </div>

  ${g.detail ? `<div class="gst-card-detail">${gstEsc(g.detail)}</div>` : ''}

  <div class="gst-card-foot">
    <label class="gst-cf-switch ${canToggleCf ? '' : 'gst-disabled'}"
           title="${canToggleCf ? 'روشن/خاموش کردن کلادفلر برای همین ریلی — پس از تغییر باید اسکریپت گوگل را هم به‌روزرسانی کنید'
                                : 'اول باید برای این ریلی Worker ساخته شود'}">
      <input type="checkbox" ${relay.cfEnabled ? 'checked' : ''} ${canToggleCf ? '' : 'disabled'}
             onchange="gstToggleRelayCloudflare('${gstEsc(relay.id)}', this.checked)">
      <span>کلادفلر</span>
    </label>
    <button class="gst-btn-mini" onclick="gstTestRelay('${gstEsc(relay.id)}')">تست</button>
  </div>
</div>`;
}
