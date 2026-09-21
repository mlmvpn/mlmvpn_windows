// --- GST network path tab ---
// Choosing which Google IPs and which SNI names the tunnel rotates through.
//
// Checkboxes, not radio buttons: the engine rotates through the selection, so several
// entries mean the tunnel survives one path going bad. The panel says so, because the
// instinct is to tick exactly one "best" option and that produces a fast, brittle setup.

let gstNet = {
    network: { ips: [], snis: [] },
    ipRows: null,       // null = never scanned in this session
    sniRows: null,
    busy: '',           // 'ips' | 'snis' | 'optimize' | ''
};

function gstNetBars(grade) {
    let out = '';
    for (let i = 1; i <= 5; i++) {
        out += `<i class="${i <= grade ? 'on' : ''}"></i>`;
    }
    return `<span class="gst-bars">${out}</span>`;
}

/**
 * One row. `selected` comes from the saved config, `row` from the last scan — the two
 * are deliberately separate so an entry the user picked stays visible and ticked even
 * when a scan did not return it.
 */
function gstNetRow(value, checked, row, kind) {
    const ok = row && row.ok;
    const latency = row && row.latency != null
        ? `${row.latency.toLocaleString('fa-IR')}ms`
        : (row ? row.status : 'تست نشده');

    return `
      <label class="gst-netrow ${row && !ok ? 'dead' : ''}">
        <input type="checkbox" ${checked ? 'checked' : ''}
               onchange="gstNetToggle('${kind}', ${JSON.stringify(value).replace(/"/g, '&quot;')}, this.checked)">
        <span class="gst-netval" dir="ltr">${gstEsc(value)}</span>
        <span class="gst-netlat">${gstEsc(latency)}</span>
        ${row && ok ? gstNetBars(row.grade) : '<span class="gst-bars"></span>'}
        <span class="gst-nethint">${gstEsc(row && row.hint ? row.hint : '')}</span>
      </label>`;
}

function gstNetSection(title, kind, selected, rows, scanLabel) {
    // Anything the user has ticked but the scan did not return still belongs in the
    // list — dropping it would silently discard a manual entry.
    const known = new Set((rows || []).map(r => r[kind === 'ips' ? 'ip' : 'sni']));
    const extras = selected.filter(v => !known.has(v));
    const busy = gstNet.busy === kind;

    return `
      <div class="gst-netsec">
        <div class="gst-netsec-head">
          <b>${gstEsc(title)}</b>
          <div class="gst-hrow-actions">
            <button class="gst-btn-mini" onclick="gstNetScan('${kind}')" ${busy ? 'disabled' : ''}>
              ${busy ? 'در حال تست…' : scanLabel}
            </button>
            <button class="gst-btn-mini" onclick="gstNetAuto('${kind}')"
                    ${rows && rows.some(r => r.ok) ? '' : 'disabled'}>انتخاب خودکار</button>
          </div>
        </div>
        <div class="gst-netlist">
          ${extras.map(v => gstNetRow(v, true, null, kind)).join('')}
          ${(rows || []).map(r => {
              const v = r[kind === 'ips' ? 'ip' : 'sni'];
              return gstNetRow(v, selected.includes(v), r, kind);
          }).join('')}
          ${!rows && !extras.length
              ? `<div class="gst-placeholder">
                   هنوز تستی انجام نشده.<br>
                   دکمه‌ی «${gstEsc(scanLabel)}» را بزنید تا گزینه‌های سالم پیدا شوند.
                 </div>`
              : ''}
        </div>
        <div class="gst-netadd">
          <input class="gstw-input" id="gst-add-${kind}" dir="ltr"
                 placeholder="${kind === 'ips' ? 'افزودن آی‌پی دستی' : 'افزودن SNI دستی'}">
          <button class="gst-btn-mini" onclick="gstNetAdd('${kind}')">افزودن</button>
        </div>
      </div>`;
}

function gstRenderNetwork() {
    const pane = document.getElementById('gst-tab-network');
    if (!pane) return;

    const n = gstNet.network;
    const optimizing = gstNet.busy === 'optimize';

    pane.innerHTML = `
      <div class="gst-hhead">
        <button class="gst-btn-primary" onclick="gstNetOptimize()" ${optimizing ? 'disabled' : ''}>
          ${optimizing ? 'در حال بهینه‌سازی…' : 'بهینه‌سازی خودکار'}
        </button>
        <span class="gst-note">تست‌ها واقعی‌اند و چند دقیقه طول می‌کشند.</span>
      </div>

      <div class="gst-note">
        تیک‌زده‌ها یعنی «از این‌ها استفاده کن». چند مورد را تیک بزنید:
        تونل بینشان می‌چرخد، پس اگر یکی از کار افتاد اتصال قطع نمی‌شود.
      </div>

      ${gstNetSection('آی‌پی‌های تمیز گوگل', 'ips', n.ips || [], gstNet.ipRows, 'اسکن آی‌پی')}
      ${gstNetSection('SNI (دامنه‌ی پوششی)', 'snis', n.snis || [], gstNet.sniRows, 'تست SNI')}

      <label class="gst-netauto">
        <input type="checkbox" id="gst-autoopt" ${gstState.autoOptimize ? 'checked' : ''}
               onchange="gstNetSetAuto(this.checked)">
        <span>
          <b>بهینه‌سازی خودکار</b>
          <i>هر ۱۰ دقیقه بی‌صدا بررسی می‌شود و اگر مسیر بهتری پیدا شد، جابه‌جا می‌شود.</i>
        </span>
      </label>`;
}

// ── actions ───────────────────────────────────────────────────────────────────

async function gstLoadNetwork() {
    try {
        const r = await gstApi('network');
        gstNet.network = r.network;

        // Rehydrate the last measurements. Without this the tab is rebuilt from the
        // ticked values alone on every launch, so a user who had narrowed their
        // selection down came back to a list with almost nothing in it — and after a
        // reinstall, to a list that looked empty.
        if (Array.isArray(r.network.ipResults) && r.network.ipResults.length) {
            gstNet.ipRows = r.network.ipResults;
        }
        if (Array.isArray(r.network.sniResults) && r.network.sniResults.length) {
            gstNet.sniRows = r.network.sniResults;
        }
        gstRenderNetwork();
    } catch (e) {
        const pane = document.getElementById('gst-tab-network');
        if (pane) pane.innerHTML = `<div class="gst-placeholder">خطا: ${gstEsc(e.message)}</div>`;
    }
}

async function gstNetScan(kind) {
    if (gstNet.busy) return;
    gstNet.busy = kind;
    gstRenderNetwork();
    try {
        const r = await gstApi(kind === 'ips' ? 'scan/ips' : 'scan/snis', {});
        if (kind === 'ips') gstNet.ipRows = r.rows; else gstNet.sniRows = r.rows;
        gstToast(`${r.working.toLocaleString('fa-IR')} مورد سالم از ${r.total.toLocaleString('fa-IR')}`);
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
    gstNet.busy = '';
    gstRenderNetwork();
}

/** Tick the best few from the last scan — client-side, no re-scan. */
async function gstNetAuto(kind) {
    const rows = kind === 'ips' ? gstNet.ipRows : gstNet.sniRows;
    if (!rows) return;
    const key = kind === 'ips' ? 'ip' : 'sni';
    const best = rows.filter(r => r.ok).slice(0, 5).map(r => r[key]);
    if (!best.length) return gstToast('هیچ مورد سالمی پیدا نشد.');
    await gstNetSave({ [kind]: best });
    gstToast(`${best.length.toLocaleString('fa-IR')} مورد برتر انتخاب شد`);
}

async function gstNetToggle(kind, value, checked) {
    const current = (gstNet.network[kind] || []).slice();
    const next = checked
        ? (current.includes(value) ? current : [...current, value])
        : current.filter(v => v !== value);

    if (!next.length) {
        // The engine would silently fall back to its own defaults, which looks like the
        // panel ignoring the user. Refuse instead.
        gstToast('حداقل یک مورد باید انتخاب شده باشد.');
        return gstRenderNetwork();
    }
    await gstNetSave({ [kind]: next });
}

/**
 * Validate a manually typed entry.
 *
 * These values go straight into the engine's config — an IP becomes `google_ip`, an SNI
 * becomes `front_domain`. Anything malformed does not fail loudly; it produces a tunnel
 * that cannot connect, with nothing on screen explaining why. (A test session left
 * "23234" as the only selected SNI, which would have done exactly that.)
 */
function gstNetValidate(kind, value) {
    if (kind === 'ips') {
        const m = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (!m) return 'آی‌پی باید به شکل ۴ عدد با نقطه باشد، مثل 142.250.190.238';
        if (m.slice(1).some(o => +o > 255)) return 'هر بخش آی‌پی باید بین ۰ تا ۲۵۵ باشد.';
        return null;
    }
    // An SNI is a hostname: at least one dot, letters/digits/hyphens per label.
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(value)) {
        return 'دامنه باید معتبر باشد، مثل www.google.com';
    }
    return null;
}

async function gstNetAdd(kind) {
    const input = document.getElementById(`gst-add-${kind}`);
    const value = input && input.value.trim();
    if (!value) return;

    const problem = gstNetValidate(kind, value);
    if (problem) {
        return uiAlert({
            title: kind === 'ips' ? 'آی‌پی معتبر نیست' : 'دامنه معتبر نیست',
            message: problem,
            tone: 'warn',
        });
    }

    const current = gstNet.network[kind] || [];
    if (current.includes(value)) { input.value = ''; return gstToast('از قبل در فهرست هست.'); }
    await gstNetSave({ [kind]: [...current, value] });
    input.value = '';
    gstToast('اضافه شد — با دکمه‌ی تست بسنجیدش.');
}

async function gstNetSave(patch) {
    try {
        const r = await gstApi('network', patch);
        gstNet.network = r.network;
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
    gstRenderNetwork();
}

async function gstNetOptimize() {
    if (gstNet.busy) return;
    gstNet.busy = 'optimize';
    gstRenderNetwork();
    try {
        const r = await gstApi('scan/optimize', {});
        gstNet.network = r.network;
        if (r.ipScan) gstNet.ipRows = r.ipScan.rows;
        if (r.sniScan) gstNet.sniRows = r.sniScan.rows;
        gstToast(r.changed
            ? `مسیر بهتر انتخاب شد: ${r.ips ? r.ips[0] : ''} · ${r.snis ? r.snis[0] : ''}`
            : 'مسیر فعلی همچنان بهترین گزینه است');
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
    gstNet.busy = '';
    gstRenderNetwork();
}

async function gstNetSetAuto(enabled) {
    try {
        await gstApi('runtime', { autoOptimize: enabled });
        gstState.autoOptimize = enabled;
        gstToast(enabled ? 'بهینه‌سازی خودکار روشن شد' : 'بهینه‌سازی خودکار خاموش شد');
    } catch (e) {
        gstToast('❌ ' + e.message);
    }
}
