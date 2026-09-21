// --- GST backup / restore panel ---
// A small overlay for exporting relays as a gst:// link and importing one back.
//
// The security story is the UI's job as much as the crypto's: the link and its
// passphrase are shown as two separate blocks with two separate copy buttons, and the
// warning to send them by different routes sits between them — not in a footnote.

const GST_BK = {
    open: false,
    tab: 'export',      // 'export' | 'import'
    busy: false,
    error: '',
    result: null,       // export result
    preview: null,      // import preview
    link: '',
    passphrase: '',
    mode: 'merge',
};

function gstBackupOpen(tab) {
    GST_BK.open = true;
    GST_BK.tab = tab || 'export';
    GST_BK.busy = false;
    GST_BK.error = '';
    GST_BK.result = null;
    GST_BK.preview = null;
    GST_BK.link = '';
    GST_BK.passphrase = '';
    GST_BK.mode = 'merge';
    gstBackupRender();
}

function gstBackupClose() {
    GST_BK.open = false;
    gstBackupRender();
}

function gstBackupRender() {
    const host = document.getElementById('gst-backup');
    if (!host) return;

    if (!GST_BK.open) {
        host.style.display = 'none';
        host.innerHTML = '';
        return;
    }

    host.style.display = 'flex';
    host.innerHTML = `
      <div class="gstw-head">
        <button class="gstw-back" onclick="gstBackupClose()" title="بستن">✕</button>
        <div class="gstw-headtext">
          <div class="gstw-title">پشتیبان‌گیری و انتقال</div>
          <div class="gstw-count">ریلی‌های خود را ذخیره کنید یا به دستگاه دیگری ببرید</div>
        </div>
      </div>

      <div class="gst-tabs" style="padding:0 16px 8px;">
        <button class="gst-tab ${GST_BK.tab === 'export' ? 'gst-tab-on' : ''}"
                onclick="gstBackupSwitch('export')">ساخت پشتیبان</button>
        <button class="gst-tab ${GST_BK.tab === 'import' ? 'gst-tab-on' : ''}"
                onclick="gstBackupSwitch('import')">بازیابی</button>
      </div>

      <div class="gstw-body">
        ${GST_BK.error ? `<div class="gstw-error">${gstEsc(GST_BK.error)}</div>` : ''}
        ${GST_BK.tab === 'export' ? gstBackupExportHtml() : gstBackupImportHtml()}
      </div>`;
}

function gstBackupSwitch(tab) {
    GST_BK.tab = tab;
    GST_BK.error = '';
    gstBackupRender();
}

// ── export ────────────────────────────────────────────────────────────────────

function gstBackupExportHtml() {
    const r = GST_BK.result;

    if (!r) {
        const usable = gstState.relays.filter(x => x.deploymentId).length;
        return `
          <p class="gstw-lead">
            همه‌ی ریلی‌های کامل شما در یک لینک رمزنگاری‌شده بسته‌بندی می‌شود.
            می‌توانید آن را نگه دارید یا به دستگاه دیگری ببرید.
          </p>
          <div class="gstw-status">${usable.toLocaleString('fa-IR')} ریلی آماده‌ی پشتیبان‌گیری است.</div>
          <p class="gstw-note">
            اطلاعات حساب کلادفلر (کلید API) هرگز داخل لینک قرار نمی‌گیرد — فقط چیزی که برای
            عبور ترافیک لازم است.
          </p>
          <div class="gstw-actions">
            <button class="gst-btn-primary" onclick="gstBackupExport()" ${GST_BK.busy || !usable ? 'disabled' : ''}>
              ${GST_BK.busy ? 'در حال ساخت…' : 'ساخت لینک پشتیبان'}
            </button>
          </div>`;
    }

    return `
      <div class="gstw-status ok">
        لینک برای ${r.relayCount.toLocaleString('fa-IR')} ریلی ساخته شد.
      </div>

      <label class="gstw-label">۱) لینک</label>
      <div class="gstw-key" style="max-height:110px; overflow-y:auto;">${gstEsc(r.link)}</div>
      <div class="gstw-actions">
        <button class="gst-btn-ghost" onclick="gstWizCopy(${JSON.stringify(r.link)}, 'لینک کپی شد')">کپی لینک</button>
      </div>

      <div class="gstw-error" style="color:var(--mv-orange-ink); background:color-mix(in srgb, var(--mv-orange) 10%, transparent); border-color:color-mix(in srgb, var(--mv-orange) 35%, transparent);">
        ⚠ لینک و رمز را از <b>دو راه جداگانه</b> بفرستید. هر کسی که هر دو را با هم داشته باشد،
        می‌تواند از سهمیه‌ی حساب گوگل شما استفاده کند.
      </div>

      <label class="gstw-label">۲) رمز</label>
      <div class="gstw-key" dir="ltr">${gstEsc(r.passphrase)}</div>
      <div class="gstw-actions">
        <button class="gst-btn-ghost" onclick="gstWizCopy(${JSON.stringify(r.passphrase)}, 'رمز کپی شد')">کپی رمز</button>
        <button class="gst-btn-primary" onclick="gstBackupSaveFile()">ذخیره در فایل</button>
      </div>
      <p class="gstw-note">
        بدون این رمز، لینک قابل باز شدن نیست — حتی برای خودتان. جایی امن نگهش دارید.
      </p>`;
}

async function gstBackupExport() {
    GST_BK.busy = true; GST_BK.error = ''; gstBackupRender();
    try {
        GST_BK.result = await gstApi('backup/export', {});
    } catch (e) { GST_BK.error = e.message; }
    GST_BK.busy = false; gstBackupRender();
}

/** Save link + passphrase as a text file. The browser download path avoids needing a
 *  native dialog, and a plain .txt is readable on any machine the user restores from. */
function gstBackupSaveFile() {
    const r = GST_BK.result;
    if (!r) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const text =
        `پشتیبان تونل گوگل اسکریپت — ${stamp}\r\n` +
        `تعداد ریلی: ${r.relayCount}\r\n\r\n` +
        `لینک:\r\n${r.link}\r\n\r\n` +
        `رمز:\r\n${r.passphrase}\r\n\r\n` +
        `هشدار: هر کسی که این فایل را داشته باشد می‌تواند از ریلی‌های شما استفاده کند.\r\n`;

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `gst-backup-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    gstToast('فایل پشتیبان ذخیره شد');
}

// ── import ────────────────────────────────────────────────────────────────────

function gstBackupImportHtml() {
    const p = GST_BK.preview;

    if (p) {
        const existing = gstState.relays.filter(r => r.deploymentId).length;
        return `
          <div class="gstw-status ok">
            این لینک ${p.relayCount.toLocaleString('fa-IR')} ریلی دارد.
          </div>
          <ul class="gstw-summary">
            ${p.relays.map(r => `<li>${gstEsc(r.name)} — ${r.cloudflare ? 'با کلادفلر' : 'بدون کلادفلر'}</li>`).join('')}
          </ul>

          ${existing ? `
            <label class="gstw-label">با ریلی‌های فعلی چه کنیم؟</label>
            <label class="gst-mode ${GST_BK.mode === 'merge' ? 'on' : ''}">
              <input type="radio" name="gst-bk-mode" ${GST_BK.mode === 'merge' ? 'checked' : ''}
                     onchange="GST_BK.mode='merge'; gstBackupRender()">
              <span><b>افزودن</b><i>ریلی‌های فعلی می‌مانند و موارد جدید اضافه می‌شوند.</i></span>
            </label>
            <label class="gst-mode ${GST_BK.mode === 'replace' ? 'on' : ''}">
              <input type="radio" name="gst-bk-mode" ${GST_BK.mode === 'replace' ? 'checked' : ''}
                     onchange="GST_BK.mode='replace'; gstBackupRender()">
              <span><b>جایگزینی کامل</b><i>${existing.toLocaleString('fa-IR')} ریلی فعلی حذف می‌شود.</i></span>
            </label>` : ''}

          <div class="gstw-actions">
            <button class="gst-btn-ghost" onclick="GST_BK.preview=null; gstBackupRender()">بازگشت</button>
            <button class="gst-btn-primary" onclick="gstBackupImport()" ${GST_BK.busy ? 'disabled' : ''}>
              ${GST_BK.busy ? 'در حال بازیابی…' : 'بازیابی'}
            </button>
          </div>`;
    }

    return `
      <p class="gstw-lead">
        لینک پشتیبان و رمزش را وارد کنید. قبل از اعمال، محتوای آن را نشانتان می‌دهیم.
      </p>
      <label class="gstw-label">لینک</label>
      <textarea id="gst-bk-link" class="gstw-input" dir="ltr" rows="3"
                placeholder="gst://..." oninput="GST_BK.link=this.value">${gstEsc(GST_BK.link)}</textarea>
      <label class="gstw-label">رمز</label>
      <input id="gst-bk-pass" class="gstw-input" dir="ltr" placeholder="مثلاً: baran-kuh-mah-1234"
             value="${gstEsc(GST_BK.passphrase)}" oninput="GST_BK.passphrase=this.value">
      <div class="gstw-actions">
        <button class="gst-btn-primary" onclick="gstBackupPreview()" ${GST_BK.busy ? 'disabled' : ''}>
          ${GST_BK.busy ? 'در حال بررسی…' : 'بررسی لینک'}
        </button>
      </div>`;
}

async function gstBackupPreview() {
    const link = (document.getElementById('gst-bk-link') || {}).value || GST_BK.link;
    const passphrase = (document.getElementById('gst-bk-pass') || {}).value || GST_BK.passphrase;
    GST_BK.link = link; GST_BK.passphrase = passphrase;

    if (!link || !passphrase) {
        GST_BK.error = 'هم لینک و هم رمز لازم است.';
        return gstBackupRender();
    }

    GST_BK.busy = true; GST_BK.error = ''; gstBackupRender();
    try {
        const r = await gstApi('backup/preview', { link, passphrase });
        GST_BK.preview = r.preview;
    } catch (e) { GST_BK.error = e.message; }
    GST_BK.busy = false; gstBackupRender();
}

async function gstBackupImport() {
    GST_BK.busy = true; GST_BK.error = ''; gstBackupRender();
    try {
        const r = await gstApi('backup/import', {
            link: GST_BK.link, passphrase: GST_BK.passphrase, mode: GST_BK.mode,
        });
        gstToast(`✅ ${r.added.toLocaleString('fa-IR')} ریلی بازیابی شد` +
            (r.skipped ? ` (${r.skipped.toLocaleString('fa-IR')} تکراری رد شد)` : ''));
        if (r.note) setTimeout(() => gstToast(r.note), 2500);
        gstBackupClose();
        await gstRefresh();
        return;
    } catch (e) { GST_BK.error = e.message; }
    GST_BK.busy = false; gstBackupRender();
}
