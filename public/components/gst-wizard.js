// --- GST setup wizard ---
// Full-panel, step-by-step. One decision per screen, everything that can be automatic is.
//
// Steps (fast mode; simple mode drops step 4):
//   1 mode        pick "fast" (own Cloudflare) or "simple" (Google only)
//   2 certificate generate + install, automatic
//   3 key         show the generated shared key, automatic
//   4 worker      deploy the user's Cloudflare Worker + real probe
//   5 reach       open the road to google.com, silent 4-step chain
//   6 script      copy the ready script, paste the Deployment ID, real relay test
//   7 done        summary
//
// The user never sees the word "sanction" as a decision: step 5 just works, and whatever
// it changed is put back at step 7.
//
// Adding relay #2+ skips 2, 5 and 7 — those are machine-wide and already done.

const GST_WIZ = {
    open: false,
    // Navigation is by step ID, never by index. The step list is built from the chosen
    // mode, so it CHANGES length mid-flow: picking "continue without Cloudflare" on the
    // worker screen drops a step, and an index held across that change silently points
    // at a different screen — which showed up as the wizard skipping the Deployment ID
    // entry entirely.
    stepId: 'mode',
    mode: 'fast',        // 'fast' | 'simple'
    relayId: null,
    relayName: '',
    firstRun: true,      // false when the user already has relays
    busy: false,
    error: '',
    data: {},            // per-step results: cert, worker, reach, script, probe
};

function gstWizSteps() {
    // Screens for the current run, in order. Built rather than hard-coded so the
    // progress bar counts what the user will actually see, not a fixed 7.
    const steps = [
        { id: 'mode', title: 'حالت راه‌اندازی' },
    ];
    if (GST_WIZ.firstRun) steps.push({ id: 'cert', title: 'گواهی امنیتی' });
    steps.push({ id: 'key', title: 'رمز ریلی' });
    if (GST_WIZ.mode === 'fast') steps.push({ id: 'worker', title: 'Worker کلادفلر' });
    if (GST_WIZ.firstRun) steps.push({ id: 'reach', title: 'دسترسی به گوگل' });
    steps.push({ id: 'script', title: 'اسکریپت گوگل' });
    steps.push({ id: 'done', title: 'آماده است' });
    return steps;
}

function gstWizCurrent() {
    const steps = gstWizSteps();
    // If the current id vanished because the mode changed (only 'worker' can), fall back
    // to the first step rather than to whatever index happens to line up.
    return steps.find(s => s.id === GST_WIZ.stepId) || steps[0];
}

// ── shell ─────────────────────────────────────────────────────────────────────

function gstWizRender() {
    const host = document.getElementById('gst-wizard');
    if (!host) return;

    if (!GST_WIZ.open) {
        host.style.display = 'none';
        host.innerHTML = '';
        return;
    }

    const steps = gstWizSteps();
    const cur = gstWizCurrent();
    const idx = steps.findIndex(s => s.id === cur.id);

    host.style.display = 'flex';
    host.innerHTML = `
      <div class="gstw-head">
        <button class="gstw-back" onclick="gstWizBack()" title="${idx === 0 ? 'بستن' : 'مرحله‌ی قبل'}">
          ${idx === 0 ? '✕' : '→'}
        </button>
        <div class="gstw-headtext">
          <div class="gstw-title">${gstEsc(cur.title)}</div>
          <div class="gstw-count">مرحله ${(idx + 1).toLocaleString('fa-IR')} از ${steps.length.toLocaleString('fa-IR')}</div>
        </div>
      </div>

      <div class="gstw-bar">
        ${steps.map((s, i) => `<i class="${i <= idx ? 'on' : ''}"></i>`).join('')}
      </div>

      <div class="gstw-body">
        ${GST_WIZ.error ? `<div class="gstw-error">${gstEsc(GST_WIZ.error)}</div>` : ''}
        ${gstWizStepHtml(cur.id)}
      </div>
    `;
}

function gstWizStepHtml(id) {
    switch (id) {
        case 'mode': return gstWizModeHtml();
        case 'cert': return gstWizCertHtml();
        case 'key': return gstWizKeyHtml();
        case 'worker': return gstWizWorkerHtml();
        case 'reach': return gstWizReachHtml();
        case 'script': return gstWizScriptHtml();
        case 'done': return gstWizDoneHtml();
        default: return '';
    }
}

// ── step 1: mode ──────────────────────────────────────────────────────────────

function gstWizModeHtml() {
    const card = (mode, badge, title, body) => `
      <button class="gstw-choice ${GST_WIZ.mode === mode ? 'on' : ''}" onclick="gstWizPickMode('${mode}')">
        <div class="gstw-choice-head">
          <b>${title}</b>
          ${badge ? `<span class="gstw-badge">${badge}</span>` : ''}
        </div>
        <p>${body}</p>
      </button>`;

    return `
      <p class="gstw-lead">
        تونل گوگل اسکریپت ترافیک شما را از داخل زیرساخت گوگل عبور می‌دهد، پس از دید فیلترینگ
        شبیه یک ارتباط عادی با گوگل دیده می‌شود.
      </p>
      ${card('fast', 'پیشنهادی', 'سریع — با کلادفلرِ خودت',
             'یک Worker روی حساب کلادفلر خودتان ساخته می‌شود. سرعت بیشتر، سهمیه‌ی گوگل دیرتر تمام می‌شود، ' +
             'و برای رسیدن به صفحه‌ی گوگل هم از همان استفاده می‌کنیم.')}
      ${card('simple', '', 'ساده — فقط گوگل',
             'بدون کلادفلر و بدون هیچ حساب اضافه‌ای. کاملاً کار می‌کند؛ فقط کمی کندتر از حالت سریع.')}
      <div class="gstw-actions">
        <button class="gst-btn-primary" onclick="gstWizNext()">شروع</button>
      </div>`;
}

function gstWizPickMode(mode) {
    GST_WIZ.mode = mode;
    // Only reachable from the first screen, which exists in both modes — but assert it
    // rather than assume, so a future caller cannot strand the wizard on a step that
    // the new mode does not contain.
    if (!gstWizSteps().some(s => s.id === GST_WIZ.stepId)) GST_WIZ.stepId = 'mode';
    gstWizRender();
}

// ── step 2: certificate ───────────────────────────────────────────────────────

function gstWizCertHtml() {
    const c = GST_WIZ.data.cert;
    const ok = c && c.state === 'ok';
    return `
      <p class="gstw-lead">
        برای اینکه سایت‌های https از داخل تونل باز شوند، یک گواهی امنیتی محلی روی ویندوز نصب می‌شود.
        این گواهی فقط روی همین کامپیوتر و برای همین برنامه است.
      </p>
      <div class="gstw-status ${ok ? 'ok' : c ? 'bad' : ''}">
        ${GST_WIZ.busy ? 'در حال نصب…' : c ? gstEsc(c.message) : 'آماده‌ی نصب'}
      </div>
      <div class="gstw-actions">
        ${ok
            ? '<button class="gst-btn-primary" onclick="gstWizNext()">بعدی</button>'
            : `<button class="gst-btn-primary" onclick="gstWizInstallCert()" ${GST_WIZ.busy ? 'disabled' : ''}>
                 ${GST_WIZ.busy ? '…' : 'نصب گواهی'}</button>`}
      </div>`;
}

async function gstWizInstallCert() {
    GST_WIZ.busy = true; GST_WIZ.error = ''; gstWizRender();
    try {
        const r = await gstApi('cert/install', {});
        GST_WIZ.data.cert = r.cert;
        if (r.cert.state !== 'ok') GST_WIZ.error = r.cert.message;
    } catch (e) { GST_WIZ.error = e.message; }
    GST_WIZ.busy = false; gstWizRender();
}

// ── step 3: shared key ────────────────────────────────────────────────────────

function gstWizKeyHtml() {
    const key = gstState.authKey || '';
    return `
      <p class="gstw-lead">
        این رمز بین برنامه و اسکریپت‌های گوگل شما مشترک است و خودکار ساخته شده.
        لازم نیست حفظش کنید — برنامه خودش آن را داخل اسکریپت می‌گذارد.
      </p>
      <div class="gstw-key" dir="ltr">${gstEsc(key)}</div>
      <div class="gstw-actions">
        <button class="gst-btn-ghost" onclick="gstWizCopy('${gstEsc(key)}', 'رمز کپی شد')">کپی</button>
        <button class="gst-btn-primary" onclick="gstWizNext()">بعدی</button>
      </div>
      <p class="gstw-note">
        همه‌ی ریلی‌های شما از همین یک رمز استفاده می‌کنند، پس برای ریلی‌های بعدی دیگر این مرحله را نمی‌بینید.
      </p>`;
}

// ── step 4: Cloudflare Worker ─────────────────────────────────────────────────

function gstWizWorkerHtml() {
    const w = GST_WIZ.data.worker;
    const accounts = GST_WIZ.data.accounts || [];

    if (w) {
        return `
          <div class="gstw-status ok">Worker ساخته و تست شد.</div>
          <div class="gstw-key" dir="ltr">${gstEsc(w.workerUrl)}</div>
          <p class="gstw-note">
            این Worker دو کار می‌کند: هم سرعت تونل را بالا می‌برد، هم همین حالا برای رسیدن به
            صفحه‌ی گوگل از آن استفاده می‌کنیم.
          </p>
          <div class="gstw-actions">
            <button class="gst-btn-primary" onclick="gstWizNext()">بعدی</button>
          </div>`;
    }

    if (!accounts.length) {
        return `
          <div class="gstw-status bad">هیچ حساب کلادفلری ثبت نشده است.</div>
          <p class="gstw-lead">
            از پنل «استقرار خودکار ابری» یک حساب اضافه کنید (ایمیل و Global API Key)، بعد به اینجا برگردید.
            یا اگر ترجیح می‌دهید، بدون کلادفلر ادامه دهید.
          </p>
          <div class="gstw-actions">
            <button class="gst-btn-ghost" onclick="gstWizLoadAccounts()">بررسی دوباره</button>
            <button class="gst-btn-ghost" onclick="gstWizSwitchToSimple()">ادامه بدون کلادفلر</button>
          </div>`;
    }

    return `
      <p class="gstw-lead">
        یک Worker روی حساب کلادفلرِ خودتان ساخته می‌شود. کد آن روی حساب شما اجرا می‌شود و
        رمزش هم فقط برای همین ریلی است.
      </p>
      <label class="gstw-label">نام این ریلی</label>
      <input id="gstw-name" class="gstw-input" value="${gstEsc(GST_WIZ.relayName)}"
             placeholder="مثلاً: حساب شخصی" oninput="GST_WIZ.relayName=this.value">
      <label class="gstw-label">حساب کلادفلر</label>
      <select id="gstw-account" class="gstw-input">
        ${accounts.map(a => `<option value="${gstEsc(a.id)}">${gstEsc(a.name)}</option>`).join('')}
      </select>
      <div id="gstw-worker-log" class="gstw-log"></div>
      <div class="gstw-actions">
        <button class="gst-btn-primary" onclick="gstWizDeployWorker()" ${GST_WIZ.busy ? 'disabled' : ''}>
          ${GST_WIZ.busy ? 'در حال ساخت…' : 'ساخت Worker'}
        </button>
      </div>`;
}

async function gstWizLoadAccounts() {
    try {
        const r = await gstApi('cf/accounts');
        GST_WIZ.data.accounts = r.accounts || [];
    } catch (e) { GST_WIZ.error = e.message; }
    gstWizRender();
}

function gstWizSwitchToSimple() {
    // Dropping Cloudflare removes the screen the user is standing on, so pick the
    // destination explicitly. Without this the id lookup finds nothing and falls back
    // to the first step, restarting a wizard the user was halfway through.
    const before = gstWizSteps();
    const idx = before.findIndex(s => s.id === 'worker');

    GST_WIZ.mode = 'simple';
    GST_WIZ.error = '';
    GST_WIZ.data.worker = null;

    const after = gstWizSteps();
    // The step that used to follow the worker screen is the one to continue with.
    const wanted = idx >= 0 && before[idx + 1] ? before[idx + 1].id : 'script';
    GST_WIZ.stepId = after.some(s => s.id === wanted) ? wanted : after[after.length - 1].id;

    gstWizRender();
}

/** Create the relay row if this run has not made one yet. */
async function gstWizEnsureRelay() {
    if (GST_WIZ.relayId) return GST_WIZ.relayId;
    const name = (GST_WIZ.relayName || '').trim() || `ریلی ${(gstState.relays.length + 1)}`;
    const r = await gstApi('relays', { name });
    GST_WIZ.relayId = r.relay.id;
    GST_WIZ.relayName = r.relay.name;
    await gstRefresh();
    return GST_WIZ.relayId;
}

async function gstWizDeployWorker() {
    const sel = document.getElementById('gstw-account');
    const accountId = sel && sel.value;
    if (!accountId) { GST_WIZ.error = 'یک حساب کلادفلر انتخاب کنید.'; return gstWizRender(); }

    GST_WIZ.busy = true; GST_WIZ.error = ''; gstWizRender();
    try {
        const relayId = await gstWizEnsureRelay();
        const r = await gstApi(`cf/deploy/${relayId}`, { accountId });

        // The route probes the fresh Worker before answering. A Worker that uploaded
        // but does not respond is not a success, and saying so now beats discovering it
        // three steps later as a mysteriously dead relay.
        if (r.probe && r.probe.state !== 'ok' && r.probe.state !== 'slow') {
            GST_WIZ.error = `Worker ساخته شد ولی تست آن رد شد: ${r.probe.message}`;
        } else {
            GST_WIZ.data.worker = r.worker;
        }
    } catch (e) { GST_WIZ.error = e.message; }
    GST_WIZ.busy = false; gstWizRender();
}

// ── step 5: reaching Google ───────────────────────────────────────────────────

function gstWizReachHtml() {
    const r = GST_WIZ.data.reach;
    const label = { direct: 'مستقیم', worker: 'از طریق کلادفلرِ خودتان', sanction: 'از مسیر جایگزین' };

    if (!r && !GST_WIZ.busy) {
        // Nothing to decide here — start immediately when the step opens.
        setTimeout(gstWizOpenReach, 60);
    }

    return `
      <p class="gstw-lead">
        صفحه‌ی ساخت اسکریپت گوگل از ایران در دسترس نیست. برنامه خودش راه را باز می‌کند —
        کاری لازم نیست انجام دهید.
      </p>
      <div class="gstw-status ${r ? (r.reachable ? 'ok' : 'bad') : ''}">
        ${GST_WIZ.busy ? 'در حال باز کردن راه دسترسی به گوگل…'
                       : r ? gstEsc(r.message) : 'آماده'}
      </div>
      ${r && r.steps ? `<div class="gstw-log">${r.steps.map(s =>
          `<div class="${s.status === 'ok' ? 'ok' : s.status === 'skip' ? '' : 'bad'}">${gstEsc(s.message)}</div>`
        ).join('')}</div>` : ''}
      ${r && r.reachable ? `<p class="gstw-note">روش: ${gstEsc(label[r.via] || r.via)} — بعد از ساخت اسکریپت دیگر به آن نیازی نیست.</p>` : ''}
      <div class="gstw-actions">
        ${r && r.reachable
            ? '<button class="gst-btn-primary" onclick="gstWizNext()">بعدی</button>'
            : `<button class="gst-btn-primary" onclick="gstWizOpenReach()" ${GST_WIZ.busy ? 'disabled' : ''}>
                 ${GST_WIZ.busy ? '…' : 'تلاش مجدد'}</button>`}
      </div>`;
}

async function gstWizOpenReach() {
    if (GST_WIZ.busy) return;
    GST_WIZ.busy = true; GST_WIZ.error = ''; gstWizRender();
    try {
        GST_WIZ.data.reach = await gstApi('reach/open', {});
    } catch (e) { GST_WIZ.error = e.message; }
    GST_WIZ.busy = false; gstWizRender();
}

// ── step 6: the Apps Script ───────────────────────────────────────────────────

function gstWizScriptHtml() {
    const s = GST_WIZ.data.script;
    const probe = GST_WIZ.data.probe;

    if (!s && !GST_WIZ.busy) setTimeout(gstWizLoadScript, 60);

    const guide = [
        'روی «باز کردن script.google.com» بزنید و یک پروژه‌ی جدید بسازید.',
        'همه‌ی کد داخل ویرایشگر را پاک کنید.',
        'دکمه‌ی «کپی اسکریپت» را بزنید و در ویرایشگر جای‌گذاری کنید (Ctrl+V).',
        'بالا سمت راست: Deploy ← New deployment ← نوع: Web app.',
        'حتماً: Execute as = Me  و  Who has access = Anyone.',
        'دکمه‌ی Deploy را بزنید، اگر پرسید Authorize کنید (Advanced ← Allow).',
        'شناسه‌ی Deployment ID را کپی کنید و در کادر پایین بگذارید.',
    ];

    return `
      <p class="gstw-lead">
        این تنها مرحله‌ای است که دستی انجام می‌شود. اسکریپت آماده است — رمز و آدرس Worker
        از قبل داخلش گذاشته شده.
      </p>
      ${s ? `<div class="gstw-status">${gstEsc(s.summary)}</div>` : ''}

      <div class="gstw-actions">
        <button class="gst-btn-ghost" onclick="window.open('https://script.google.com/home/projects/create','_blank')">
          باز کردن script.google.com
        </button>
        <button class="gst-btn-primary" onclick="gstWizCopyScript()" ${s ? '' : 'disabled'}>
          کپی اسکریپت${s ? ` (${Math.round(s.bytes / 1024).toLocaleString('fa-IR')} کیلوبایت)` : ''}
        </button>
      </div>

      <ol class="gstw-guide">${guide.map(g => `<li>${gstEsc(g)}</li>`).join('')}</ol>

      <label class="gstw-label">Deployment ID</label>
      <input id="gstw-depid" class="gstw-input" dir="ltr" placeholder="AKfy..."
             value="${gstEsc(GST_WIZ.data.deploymentId || '')}"
             oninput="GST_WIZ.data.deploymentId=this.value">

      ${probe ? `<div class="gstw-status ${probe.state === 'ok' || probe.state === 'slow' ? 'ok' : 'bad'}">
                   ${gstEsc(probe.message)}</div>` : ''}

      <div class="gstw-actions">
        ${probe && (probe.state === 'ok' || probe.state === 'slow')
            ? '<button class="gst-btn-primary" onclick="gstWizNext()">بعدی</button>'
            : `<button class="gst-btn-primary" onclick="gstWizSaveDeployment()" ${GST_WIZ.busy ? 'disabled' : ''}>
                 ${GST_WIZ.busy ? 'در حال تست…' : 'ثبت و تست ریلی'}</button>`}
      </div>`;
}

async function gstWizLoadScript() {
    if (GST_WIZ.busy) return;
    GST_WIZ.busy = true; gstWizRender();
    try {
        const relayId = await gstWizEnsureRelay();
        // Ask for the mode the user picked, not for whatever the relay happens to have:
        // in simple mode a relay might still carry an old Worker URL.
        const cf = GST_WIZ.mode === 'fast' && GST_WIZ.data.worker ? '1' : '0';
        GST_WIZ.data.script = await gstApi(`script/${relayId}?cf=${cf}`);
    } catch (e) { GST_WIZ.error = e.message; }
    GST_WIZ.busy = false; gstWizRender();
}

async function gstWizCopyScript() {
    const s = GST_WIZ.data.script;
    if (!s) return;
    await gstWizCopy(s.script, 'اسکریپت کپی شد — در ویرایشگر گوگل جای‌گذاری کنید');
}

async function gstWizSaveDeployment() {
    const input = document.getElementById('gstw-depid');
    const deploymentId = input ? input.value : GST_WIZ.data.deploymentId;
    if (!deploymentId) { GST_WIZ.error = 'شناسه‌ی Deployment را وارد کنید.'; return gstWizRender(); }

    GST_WIZ.busy = true; GST_WIZ.error = ''; gstWizRender();
    try {
        const relayId = await gstWizEnsureRelay();
        const r = await gstApi(`relays/${relayId}/deployment`, { deploymentId });
        GST_WIZ.data.probe = r.probe;

        // The Cloudflare switch is only true once the script that forwards is actually
        // deployed — which is exactly now, and not a moment earlier.
        if (GST_WIZ.mode === 'fast' && GST_WIZ.data.worker &&
            (r.probe.state === 'ok' || r.probe.state === 'slow')) {
            await gstApi(`relays/${relayId}/cloudflare`, { enabled: true });
        }
        await gstRefresh();
    } catch (e) { GST_WIZ.error = e.message; }
    GST_WIZ.busy = false; gstWizRender();
}

// ── step 7: done ──────────────────────────────────────────────────────────────

function gstWizDoneHtml() {
    const probe = GST_WIZ.data.probe || {};
    const worker = GST_WIZ.data.worker;
    return `
      <div class="gstw-status ok">ریلی «${gstEsc(GST_WIZ.relayName)}» آماده است.</div>
      <ul class="gstw-summary">
        <li>گواهی امنیتی: نصب شده</li>
        <li>اسکریپت گوگل: فعال${probe.latency ? ` · ${probe.latency.toLocaleString('fa-IR')}ms` : ''}</li>
        <li>کلادفلر: ${worker ? 'روشن' : 'خاموش (حالت ساده)'}</li>
      </ul>
      <p class="gstw-note">
        هر وقت خواستید می‌توانید ریلی‌های بیشتری اضافه کنید — هر حساب گوگل تازه، سهمیه‌ی روزانه را
        بیشتر می‌کند و بار بین همه پخش می‌شود.
      </p>
      <div class="gstw-actions">
        <button class="gst-btn-ghost" onclick="gstWizFinish(false)">بستن</button>
        <button class="gst-btn-primary" onclick="gstWizFinish(true)">اتصال</button>
      </div>`;
}

// ── navigation ────────────────────────────────────────────────────────────────

async function gstWizNext() {
    GST_WIZ.error = '';
    const steps = gstWizSteps();
    const idx = steps.findIndex(s => s.id === gstWizCurrent().id);
    if (idx < steps.length - 1) GST_WIZ.stepId = steps[idx + 1].id;
    gstWizRender();

    // Load what the next screen needs, so it opens with data rather than a spinner.
    const next = gstWizCurrent().id;
    if (next === 'worker' && !GST_WIZ.data.accounts) await gstWizLoadAccounts();
    if (next === 'cert' && !GST_WIZ.data.cert) {
        try { GST_WIZ.data.cert = (await gstApi('cert')).cert; gstWizRender(); } catch (e) { /* shown on the step */ }
    }
}

function gstWizBack() {
    GST_WIZ.error = '';
    const steps = gstWizSteps();
    const idx = steps.findIndex(s => s.id === gstWizCurrent().id);
    if (idx <= 0) return gstWizClose();
    GST_WIZ.stepId = steps[idx - 1].id;
    gstWizRender();
}

async function gstWizFinish(connect) {
    // Put the sanction-buster back exactly as we found it. Silent: the user was never
    // asked to turn it on, so they are not asked to turn it off.
    try { await gstApi('reach/restore', {}); } catch (e) { /* not worth blocking on */ }
    gstWizClose();
    await gstRefresh();
    if (connect) await gstTogglePower();
}

function gstWizClose() {
    GST_WIZ.open = false;
    gstWizRender();
}

async function gstWizCopy(text, msg) {
    try {
        await navigator.clipboard.writeText(text);
        gstToast(msg || 'کپی شد');
    } catch (e) {
        // Clipboard access can be refused; a textarea fallback keeps the wizard usable.
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); gstToast(msg || 'کپی شد'); }
        catch (e2) { gstToast('کپی نشد — متن را دستی انتخاب کنید'); }
        ta.remove();
    }
}

/** Entry point from the relay list. */
function gstStartWizard() {
    GST_WIZ.open = true;
    GST_WIZ.stepId = 'mode';
    GST_WIZ.relayId = null;
    GST_WIZ.relayName = '';
    GST_WIZ.busy = false;
    GST_WIZ.error = '';
    GST_WIZ.data = {};
    // Machine-wide steps (certificate, Google access) only make sense the first time.
    GST_WIZ.firstRun = !gstState.relays.some(r => r.deploymentId);
    gstWizRender();
}

/** Resume a half-built relay from the health tab's "ادامه‌ی ساخت" button. */
function gstResumeWizard(relayId) {
    const relay = gstState.relays.find(r => r.id === relayId);
    if (!relay) return;
    GST_WIZ.open = true;
    GST_WIZ.relayId = relayId;
    GST_WIZ.relayName = relay.name;
    GST_WIZ.mode = relay.workerUrl ? 'fast' : 'simple';
    GST_WIZ.firstRun = false;
    GST_WIZ.busy = false;
    GST_WIZ.error = '';
    GST_WIZ.data = relay.workerUrl
        ? { worker: { workerUrl: relay.workerUrl } }
        : {};
    // Straight to the only step that is still missing.
    GST_WIZ.stepId = 'script';
    gstWizRender();
}
