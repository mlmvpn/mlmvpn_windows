// --- پنل GitHub Tunnel ---
// در #ls-github-tunnel رندر می‌شود و با /api/github-tunnel/* روی سرور محلی صحبت می‌کند.
//
// کاربر فقط این مراحل را می‌بیند: اتصال گیت‌هاب -> ادامه -> یک لیست پیشرفت -> کارت شمارش
// معکوس با دکمه‌های اتصال/تمدید. گیت‌هاب، GitHub Actions، workflow و Tailscale هرگز در
// متن‌های این فایل نام برده نمی‌شوند.

const gtState = {
    githubStatus: null,   // /api/github-tunnel/github/status
    status: null,          // /api/github-tunnel/status  ({ provisioning, session })
    broker: null,           // /api/github-tunnel/broker/status
    pollTimer: null,
    githubPollTimer: null,
    connecting: false,     // فوراً بعد از کلیک «اتصال به گیت‌هاب» تا اولین پاسخ سرور
    brokerDeploying: false,
    brokerError: '',
    forceBrokerSetup: false, // با «پیکربندی مجدد سرویس شبکه‌ی امن» فعال می‌شود، حتی اگر broker از قبل دیپلوی شده باشد
    engine: null,            // /api/github-tunnel/engine/status → { engine, tun, systemProxy }
    busy: '',                // 'connect' | 'proxy' | 'tun' — برای غیرفعال کردن دکمه‌ها حین عملیات
    accounts: null,          // /api/github-tunnel/accounts → { accounts, currentAccountId }
    view: 'main',            // 'main' | 'accounts'
    addingAccount: false,    // جریان افزودن حساب، حتی وقتی حساب دیگری از قبل هست
};

async function gtFetch(path, opts = {}) {
    const res = await fetch(path, {
        headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
        ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `خطا (${res.status})`);
    return data;
}

// حساب‌های کلادفلر در «زیرساخت ابری» سمت مرورگر (PersistentStorage['cf_accounts']) نگه
// داشته می‌شوند نه در سرور — همان کلیدی که public/components/cloud.js می‌خواند/می‌نویسد.
function gtLoadCfAccounts() {
    try {
        const raw = PersistentStorage.getItem('cf_accounts');
        const list = raw ? JSON.parse(raw) : [];
        return Array.isArray(list) ? list.filter(a => a && a.token) : [];
    } catch (e) { return []; }
}

function gtToast(msg) {
    if (typeof toast === 'function') toast(msg); else console.log('[github-tunnel]', msg);
}

function gtEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function gtFmtCountdown(ms) {
    if (ms <= 0) return '۰۰:۰۰:۰۰';
    const total = Math.floor(ms / 1000);
    const h = String(Math.floor(total / 3600)).padStart(2, '0');
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return `${h}:${m}:${s}`;
}

// ── data ─────────────────────────────────────────────────────────────────────────
// همه‌ی توابع رفرش، خطای شبکه را خودشان می‌بلعند تا هیچ Promise ردشده‌ای بدون catch نماند
// (fetch به سمت سروری که هنوز بالا نیامده باشد وگرنه Unhandled Promise Rejection می‌سازد).

async function gtRefreshGithub() {
    try {
        gtState.githubStatus = await gtFetch('/api/github-tunnel/github/status');
    } catch (e) { /* سرور هنوز آماده نیست؛ در تیک بعدی دوباره تلاش می‌شود */ }
    gtRender();
}

async function gtRefreshStatus() {
    try {
        gtState.status = await gtFetch('/api/github-tunnel/status');
    } catch (e) { /* همان بالا */ }
    gtRender();
    gtMaybeOfferRoute();

    // Provisioning has stopped moving, so stop hammering it — but do NOT stop polling.
    // Killing the timer here also killed the ENGINE refresh that rides the same tick, so
    // after any failed setup the connection status froze at whatever it last was: a tunnel
    // that dropped, or a kill-switch that engaged, showed nothing at all. Slow down instead.
    const p = gtState.status && gtState.status.provisioning;
    if (p && p.state === 'FAILED' && gtState.pollFast) gtStartStatusPoll(false);
}

async function gtRefreshEngine() {
    try {
        gtState.engine = await gtFetch('/api/github-tunnel/engine/status');
    } catch (e) { /* همان بالا */ }
    gtRender();
    if (!gtState.routeChoosing) gtMaybeOfferRoute();
}

async function gtConnectEngine() {
    gtState.busy = 'connect';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/connect', { method: 'POST' });
        gtToast('اتصال برقرار شد.');
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

async function gtDisconnectEngine() {
    gtState.busy = 'connect';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/disconnect', { method: 'POST' });
        gtToast('اتصال قطع شد.');
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

async function gtToggleProxy(enabled) {
    gtState.busy = 'proxy';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/proxy', { method: 'POST', body: JSON.stringify({ enabled }) });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

async function gtToggleTun(enabled) {
    gtState.busy = 'tun';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/tun', { method: 'POST', body: JSON.stringify({ enabled }) });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

// «نشست آماده شد — تونل کامل یا پروکسی کل سیستم؟» — the same sheet the WARP engines open
// (route-sheet.js). A ready session carries nothing until one of the two switches below is on,
// so once per session, while neither is, the user is asked. It stays until the chosen one reads
// back as connected, or until the user closes it; the switches on the panel are unchanged.
let gtRouteAskedFor = null;

function gtSessionLive() {
    const s = gtState.status && gtState.status.session;
    return !!(s && ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status));
}

function gtMaybeOfferRoute() {
    if (!window.MVRouteSheet) return;
    const eng = gtState.engine && gtState.engine.engine;
    if (!gtSessionLive()) { MVRouteSheet.close('gt'); return; }
    const s = gtState.status.session;
    const key = `${s.accountLogin || ''}|${s.tailscaleIp || ''}`;
    if (eng && eng.connected) {
        // A switch on the panel already brought it up. The session counts as answered, so
        // turning both off later on purpose does not bring the question back.
        gtRouteAskedFor = key;
        if (!gtState.routeChoosing) MVRouteSheet.close('gt');
        return;
    }
    if (!eng || gtState.busy || gtState.engine.busy) return;   // not known yet, or mid-change
    if (gtRouteAskedFor === key) return;
    gtRouteAskedFor = key;
    MVRouteSheet.open({
        owner: 'gt',
        title: 'نشست تونل گیت‌هاب آماده شد',
        text: 'تا یکی از این دو روشن نشود، هیچ ترافیکی از تونل رد نمی‌شود. کدام را می‌خواهید؟',
        notes: {
            tun: 'کل ترافیک ویندوز و همه‌ی برنامه‌ها، با UDP. کلید قطع اضطراری فقط در این حالت کار می‌کند. پیشنهادی.',
        },
        choose: gtRouteChoose,
    });
}

async function gtRouteChoose(kind) {
    gtState.busy = kind;
    gtState.routeChoosing = true;
    gtRender();
    let error = '';
    try {
        await gtFetch(kind === 'tun' ? '/api/github-tunnel/tun' : '/api/github-tunnel/proxy',
            { method: 'POST', body: JSON.stringify({ enabled: true }) });
    } catch (e) { error = e.message; }
    gtState.busy = '';
    // Only the engine's own reading counts as up.
    await gtRefreshEngine();
    gtState.routeChoosing = false;
    const eng = gtState.engine && gtState.engine.engine;
    if (eng && eng.connected && eng.mode === kind) return { ok: true };
    return { ok: false, error: error || (eng && eng.error) || '' };
}

async function gtRunSpeedtest() {
    gtState.busy = 'speed';
    gtState.speed = null;
    gtRender();
    try {
        gtState.speed = await gtFetch('/api/github-tunnel/engine/speedtest');
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    gtRender();
}


function gtExitBrokerSetup() {
    gtState.brokerError = '';
    gtState.dismissedBrokerGate = true;
    gtGoSec('connect');
}

function gtCopyAcl() {
    const text = GT_ACL_TEXT;
    try { navigator.clipboard.writeText(text); gtToast('کپی شد — در فایل ACL جای‌گذاری کنید.'); }
    catch (e) { window.prompt('کپی کنید:', text); }
}

async function gtSaveBrokerUrl() {
    const url = (document.getElementById('gt-broker-url') || {}).value || '';
    try {
        await gtFetch('/api/github-tunnel/broker/url', { method: 'POST', body: JSON.stringify({ url }) });
        gtToast(url ? 'آدرس اختصاصی ثبت شد.' : 'آدرس اختصاصی حذف شد.');
        await gtRefreshBroker();
    } catch (e) { gtToast(e.message); }
}

async function gtResetAll() {
    const ok = await uiConfirm({
        title: 'ریست کامل GitHub Tunnel؟',
        message: 'اتصال گیت‌هاب، تنظیمات سرویس شبکه‌ی امن، کلیدها و همه‌ی نشست‌ها پاک می‌شوند و همه‌چیز از اول شروع می‌شود.\n\nریپازیتوری گیت‌هاب و سرویسی که روی کلادفلر دیپلوی شده حذف نمی‌شوند.',
        confirmLabel: 'ریست کامل',
        danger: true,
    });
    if (!ok) return;
    gtState.busy = 'reset';
    gtRender(true);
    try {
        await gtFetch('/api/github-tunnel/reset', { method: 'POST' });
        gtToast('همه‌چیز پاک شد.');
    } catch (e) { gtToast(e.message); }
    // Everything the panel was showing is gone; rebuild from a clean slate.
    gtState.busy = '';
    gtState.status = null;
    gtState.engine = null;
    gtState.broker = null;
    gtState.speed = null;
    gtState.forceBrokerSetup = false;
    await gtRefreshGithub();
    await gtRefreshStatus();
    gtRender(true);
}

async function gtToggleKillSwitch(enabled) {
    gtState.busy = 'ks';
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/killswitch', { method: 'POST', body: JSON.stringify({ enabled }) });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    await gtRefreshEngine();
}

async function gtRefreshBroker() {
    try {
        gtState.broker = await gtFetch('/api/github-tunnel/broker/status');
    } catch (e) { /* همان بالا */ }
    gtRender();
}

// ── حساب‌های گیت‌هاب ────────────────────────────────────────────────────────────────

async function gtRefreshAccounts() {
    try {
        gtState.accounts = await gtFetch('/api/github-tunnel/accounts');
        gtNoticeSignIn();
    } catch (e) { /* همان بالا */ }
    gtRender();
}

/**
 * Tell the user what the last sign-in actually did.
 *
 * The device flow authorises whichever account is signed in ON GITHUB.COM, not whichever
 * one the user meant. So "add an account" from a browser already signed in as account #1
 * re-authorises account #1 and the pool does not grow. Silently succeeding there is the
 * worst outcome: the user believes they have a second capacity source and only finds out
 * they do not when the first one runs dry and nothing fails over.
 */
function gtNoticeSignIn() {
    const s = gtState.accounts && gtState.accounts.lastSignIn;
    if (!s || !s.at) return;
    if (gtState.lastSignInSeen === s.at) return;
    const first = gtState.lastSignInSeen === undefined;
    gtState.lastSignInSeen = s.at;
    if (first) return;   // a stale result from before this panel opened
    gtToast(s.created
        ? `حساب @${s.login} اضافه شد.`
        : `این همان حساب @${s.login} بود که از قبل متصل بود. برای افزودن یک حساب دیگر، اول در مرورگر از این حساب خارج شوید یا از پنجره‌ی ناشناس استفاده کنید.`);
}

function gtAccountList() {
    return (gtState.accounts && gtState.accounts.accounts) || [];
}

function gtHasAccounts() { return gtAccountList().length > 0; }

function gtOpenAccounts() { gtGoSec('accounts'); }
function gtCloseAccounts() { gtGoSec('connect'); }

/** Add another account. Same device flow as the first one — the pool has no notion of a
 *  "primary" account, so there is nothing special about the second. */
function gtAddAccount() {
    gtState.addingAccount = true;
    gtConnectGithub();
}

/** Back out of adding an account without losing the ones already in the pool. */
async function gtCancelAddAccount() {
    gtState.addingAccount = false;
    gtState.connecting = false;
    if (gtState.githubPollTimer) { clearInterval(gtState.githubPollTimer); gtState.githubPollTimer = null; }
    try { await gtFetch('/api/github-tunnel/github/cancel', { method: 'POST' }); } catch (e) {}
    await gtRefreshGithub();
    await gtRefreshAccounts();
    gtRender(true);
}

async function gtRemoveAccount(id, login) {
    const ok = await uiConfirm({
        title: `حذف حساب @${login}؟`,
        message: 'اگر نشست فعالی روی همین حساب باشد پایان می‌یابد. نشست‌های حساب‌های دیگر دست‌نخورده می‌مانند.\n\nریپازیتوری گیت‌هاب شما حذف نمی‌شود.',
        confirmLabel: 'حذف حساب',
        danger: true,
    });
    if (!ok) return;
    try {
        await gtFetch('/api/github-tunnel/accounts/remove', { method: 'POST', body: JSON.stringify({ id }) });
        gtToast('حساب حذف شد.');
    } catch (e) { gtToast(e.message); }
    await gtRefreshAccounts();
    await gtRefreshStatus();
    gtRender(true);
}

async function gtRetryAccount(id) {
    try {
        await gtFetch('/api/github-tunnel/accounts/retry', { method: 'POST', body: JSON.stringify({ id }) });
        gtToast('حساب دوباره در نوبت قرار گرفت.');
    } catch (e) { gtToast(e.message); }
    await gtRefreshAccounts();
    gtRender(true);
}

async function gtToggleAccount(id, disabled) {
    try {
        await gtFetch('/api/github-tunnel/accounts/toggle', { method: 'POST', body: JSON.stringify({ id, disabled }) });
    } catch (e) { gtToast(e.message); }
    await gtRefreshAccounts();
    gtRender(true);
}

async function gtRefreshQuota() {
    gtState.busy = 'quota';
    gtRender(true);
    try {
        gtState.accounts = await gtFetch('/api/github-tunnel/accounts/refresh', { method: 'POST' });
    } catch (e) { gtToast(e.message); }
    gtState.busy = '';
    gtRender(true);
}

// ── actions ──────────────────────────────────────────────────────────────────────

async function gtConnectGithub() {
    gtState.connecting = true;
    gtRender();
    try {
        await gtFetch('/api/github-tunnel/github/start', { method: 'POST' });
        await gtRefreshGithub();
        // PAINT IT. Without this the code sat in `gtState.githubStatus` unseen: the only other
        // render in this flow is the poll's, and the poll renders only when the sign-in has
        // ALREADY finished. So the browser tab opened asking for a code the app never showed.
        gtRender(true);
        gtStartGithubPoll();
    } catch (e) {
        gtState.connecting = false;
        gtToast(e.message);
        gtRender();
    }
}

function gtStartGithubPoll() {
    if (gtState.githubPollTimer) clearInterval(gtState.githubPollTimer);
    gtState.githubPollTimer = setInterval(async () => {
        await gtRefreshGithub();
        const p = gtState.githubStatus && gtState.githubStatus.pending;
        gtState.connecting = !!(p && p.state === 'waiting');
        // Still waiting: redraw anyway. The card carries a live state — «در انتظار تأیید…»,
        // and an expiry that turns into an error — and none of it moved without this.
        if (gtState.connecting) gtRender(true);
        if (!gtState.connecting) {
            clearInterval(gtState.githubPollTimer);
            // The sign-in landed in the pool server-side; pull the new row so the panel
            // shows it immediately instead of on the next slow tick.
            gtState.addingAccount = false;
            await gtRefreshAccounts();
            gtRender(true);
        }
    }, 2500);
}

/** Clipboard with a prompt fallback — the API can be refused depending on window focus,
 *  and losing a one-time code to a silent failure is worse than an ugly dialog. */
function gtCopyText(text, okMsg) {
    try {
        navigator.clipboard.writeText(text);
        gtToast(okMsg || 'کپی شد.');
    } catch (e) {
        window.prompt('کپی کنید:', text);
    }
}

function gtOpenVerificationUrl(url) {
    // نه nodeIntegration و نه یک پل contextBridge در این پنجره در دسترس است، پس require()
    // اینجا کار نمی‌کند. window.open کافی است — همان مسیری که main.js با
    // setWindowOpenHandler به مرورگر سیستم هدایتش می‌کند.
    window.open(url, '_blank');
}

async function gtDisconnectGithub() {
    const ok = await uiConfirm({
        title: 'اتصال گیت‌هاب قطع شود؟',
        message: 'نشست ابری فعال (در صورت وجود) پایان می‌یابد. ریپازیتوری شما حذف نمی‌شود.',
        confirmLabel: 'قطع اتصال',
        danger: true,
    });
    if (!ok) return;
    try {
        await gtFetch('/api/github-tunnel/github/disconnect', { method: 'POST' });
        gtToast('اتصال گیت‌هاب قطع شد.');
        gtState.status = null;
        await gtRefreshGithub();
        await gtRefreshStatus();
    } catch (e) { gtToast(e.message); }
}

async function gtForceBrokerSetup() {
    gtState.brokerError = '';
    gtState.dismissedBrokerGate = false;
    // Load the stored values FIRST, then paint once: rendering an empty form and filling
    // it a moment later is the same clobbering problem in miniature.
    await gtRefreshBroker();
    gtGoSec('broker');
}

async function gtBeginSetup() {
    gtState.forceBrokerSetup = false;
    gtState.dismissedBrokerGate = false; // a fresh attempt earns a fresh look at the gate
    gtState.status = { provisioning: { state: 'SETTING_UP', log: [] }, session: null };
    // force: the broker form is still on screen at this point, and gtRender's unforced path
    // refuses to redraw while it is — that guard exists to stop background polls wiping a
    // half-typed client secret. Without the flag the panel stayed frozen on «در حال
    // راه‌اندازی…» for the entire provisioning run: the setup really was progressing, and
    // even finished, but nothing on screen ever moved off the deploy step.
    gtRender(true);
    try {
        await gtFetch('/api/github-tunnel/setup', { method: 'POST' });
        gtStartStatusPoll(true);
        await gtRefreshStatus();
    } catch (e) { gtToast(e.message); }
}

async function gtActivateAgain(force) {
    try {
        const r = await gtFetch('/api/github-tunnel/activate-again', { method: 'POST', body: JSON.stringify({ force: !!force }) });

        // The server refuses to spin up a second cloud session while one is still healthy
        // (that guard is the whole point of §14). Without asking here the click looked
        // dead, so make the choice explicit and re-issue with force when they confirm.
        if (r.existing) {
            const ok = await uiConfirm({
                title: 'نشست ابری فعلی هنوز فعال است',
                message: 'اگر نشست جدید بسازید، نشست فعلی پایان می‌یابد و کانفیگ جدید جایگزین آن می‌شود.',
                confirmLabel: 'ساخت نشست جدید',
                cancelLabel: 'استفاده از نشست فعلی',
                danger: true,
            });
            if (!ok) return;
            return gtActivateAgain(true);
        }

        gtState.status = { provisioning: { state: 'RENEWING', log: [] }, session: null };
        gtRender(true);   // same reason as gtBeginSetup: the form guard would swallow this
        gtStartStatusPoll(true);
    } catch (e) { gtToast(e.message); }
}

async function gtDeployBroker() {
    const accountLocalId = document.getElementById('gt-broker-account') ? document.getElementById('gt-broker-account').value : '';
    const tsClientId = (document.getElementById('gt-ts-id') || {}).value || '';
    const tsClientSecret = (document.getElementById('gt-ts-secret') || {}).value || '';
    const tsTailnet = (document.getElementById('gt-ts-tailnet') || {}).value || '';

    const accounts = gtLoadCfAccounts();
    const acc = accounts.find(a => a.id === accountLocalId);
    if (!acc) { gtState.brokerError = 'یک حساب کلادفلر انتخاب کنید.'; gtRender(true); return; }
    if (!tsClientId || !tsClientSecret || !tsTailnet) { gtState.brokerError = 'همه‌ی فیلدها را پر کنید.'; gtRender(true); return; }

    gtState.brokerDeploying = true;
    gtState.brokerError = '';
    gtRender(true);
    try {
        await gtFetch('/api/github-tunnel/broker/deploy', {
            method: 'POST',
            body: JSON.stringify({
                email: acc.email, token: acc.token, accountName: acc.name,
                tsClientId, tsClientSecret, tsTailnet,
            }),
        });
        gtState.brokerDeploying = false;
        await gtRefreshBroker();
        await gtRefreshStatus();

        // Only chain into a full session setup when there ISN'T one already. Redeploying
        // the relay while a session is live used to restart the whole provisioning flow —
        // which, to someone who just wanted to update the relay, looks like the app
        // spontaneously throwing away a working tunnel.
        const live = gtState.status && gtState.status.session
            && ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(gtState.status.session.status);
        if (live) {
            gtState.forceBrokerSetup = false;
            gtToast('سرویس شبکه‌ی امن به‌روزرسانی شد. نشست فعلی دست‌نخورده ماند.');
            gtRender(true);
            return;
        }
        gtToast('سرویس شبکه‌ی امن راه‌اندازی شد. در حال ادامه‌ی راه‌اندازی…');
        await gtBeginSetup();
    } catch (e) {
        gtState.brokerDeploying = false;
        gtState.brokerError = e.message;
        gtRender(true);
    }
}

async function gtConnect() {
    try {
        await gtFetch('/api/github-tunnel/connect', { method: 'POST' });
        gtToast('در حال اتصال…');
    } catch (e) { gtToast(e.message); }
}

function gtStartStatusPoll(fast) {
    if (gtState.pollTimer) clearInterval(gtState.pollTimer);
    gtState.pollFast = !!fast;
    let tick = 0;
    gtState.pollTimer = setInterval(() => {
        gtRefreshStatus();
        // Accounts move far more slowly than the tunnel does (quota is cached for ten
        // minutes server-side), so they ride a slower beat — but they must still refresh
        // on their own, or a failover the user did not trigger never shows up in the list.
        if (++tick % 6 === 0 || gtState.view === 'accounts') gtRefreshAccounts();
        // The engine/proxy/tunnel switches are re-rendered on every one of these ticks, so
        // they must be refreshed on the same tick. Polling only the session status meant a
        // freshly-enabled tunnel visibly snapped back off a few seconds later, reading as
        // "the tunnel doesn't work" when it was in fact running.
        if (!gtState.busy) gtRefreshEngine();
    }, fast ? 2000 : 5000);
}

// ── render ───────────────────────────────────────────────────────────────────────

// ── the page ─────────────────────────────────────────────────────────────────────
//
// The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one سایفون، ماسک and
// «تونل گوگل‌اسکریپت» wear. This window has more moving parts than any other engine — a
// pool of GitHub accounts, a cloud session with a clock on it, a relay on Cloudflare, and
// the local tunnel — so each of them is a card, and each card's header opens the section
// where the whole of it lives.

const GT_SECTIONS = [
    { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
    { id: 'accounts', label: 'حساب‌ها', icon: 'ph-fill ph-github-logo', tint: 'var(--mv-label-2)' },
    { id: 'network', label: 'مسیر و محافظ', icon: 'ph-fill ph-shield-check', tint: 'var(--mv-blue)' },
    { id: 'broker', label: 'سرویس شبکهٔ امن', icon: 'ph-fill ph-cloud-check', tint: 'var(--mv-indigo)' },
];

// The provisioning run, in the order the server reports it. Used twice: as the line above
// the cards while it runs, and as the sentence under the hero's title.
const GT_PROV_ORDER = ['SETTING_UP', 'STARTING', 'INSTALLING', 'CONNECTING_NETWORK', 'READY'];
const GT_PROV_LABELS = {
    SETTING_UP: 'اتصال گیت‌هاب',
    STARTING: 'زیرساخت ابری',
    INSTALLING: 'سرور ابری ویندوز',
    CONNECTING_NETWORK: 'شبکهٔ امن',
    READY: 'ساخت کانفیگ',
};

/** Which section is on screen. `gtState.view` follows it — the poll reads that. */
let gtSec = 'connect';

const gtHtmlTemplate = `
<div id="gt-wrapper" class="mv-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های گیت‌هاب تانل">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="gt-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${GT_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-gt-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" id="gt-store" title="موتور شبکهٔ امن در ام‌ال‌ام استور">
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
        <button type="button" id="gt-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="gt-pane-title">اتصال</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="gt-scroll">
      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" id="gt-stage" style="--tint:var(--mv-blue)"></div>
        <div class="mv-eng-flow" id="gt-flow" style="display:none"><div class="mv-steps" id="gt-steps"></div></div>
        <div class="mv-eng-grid" id="gt-cards"></div>
      </div>
      <div class="mv-eng-sec" data-sec="accounts"><div class="gt-sec" id="gt-sec-accounts"></div></div>
      <div class="mv-eng-sec" data-sec="network"><div class="gt-sec" id="gt-sec-network"></div></div>
      <div class="mv-eng-sec" data-sec="broker"><div class="gt-sec" id="gt-sec-broker"></div></div>
    </div>

    <div class="mv-eng-foot" id="gt-foot"></div>
  </section>
</div>

<style>
  #gt-wrapper { position:relative; z-index:0; flex:1 1 auto; min-height:0; color:var(--mv-label); }
  .gt-sec { display:flex; flex-direction:column; gap:12px; padding-top:6px; }
  /* Everything this panel renders — the account rows, the relay form, the progress log —
     sits in one of these. Giving it the kit's own card chrome modernises every screen at
     once without rewriting the markup inside them. */
  .gt-card { background:var(--mv-group); box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-group-edge);
             border-radius:14px; padding:16px; display:flex; flex-direction:column; gap:12px; }
  /* A card that answers the whole page — the device code, a failure — takes the whole row. */
  .mv-eng-grid > .gt-span { grid-column:1 / -1; }
  .gt-count { text-align:center; font-size:32px; font-weight:700; letter-spacing:2px;
              font-family:var(--mv-font-tech, ui-monospace, monospace); padding-top:4px; }
  .gt-count.is-soon { color:var(--mv-orange-ink); }
  .gt-count-sub { text-align:center; font-size:11px; color:var(--mv-label-3); margin-top:-2px; }
  .gt-kv { display:flex; align-items:center; justify-content:space-between; gap:8px;
           padding:5px 9px; font-size:11.5px; color:var(--mv-label-2); }
  .gt-kv b { font-weight:600; color:var(--mv-label); font-family:var(--mv-font-tech, ui-monospace, monospace); }
  /* The pool is a list of independent pots — side by side when the window has the room. */
  .gt-accounts-list { display:grid; gap:10px; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); }
</style>`;

/** Every block this panel renders, in the kit's card chrome. */
function gtCard(inner) {
    return `<div class="gt-card">${inner}</div>`;
}

/* A DRAWN ring, never a rotating glyph: a font glyph sits on a baseline with its own
   bearings, so it wobbles instead of spinning. Same rule as every other engine page. */
function gtSpinner() {
    return '<i class="mv-spin-ring"></i>';
}

/** Is there anything running or engaged that the user might need to switch off? */
function gtHasLiveEngine() {
    const st = gtState.engine;
    if (!st) return false;
    const eng = st.engine || {};
    const ks = st.killSwitch || {};
    return !!(eng.connected || eng.running || ks.engaged);
}

/**
 * What the hero says, and what its one button does. Everything else on the page — the
 * sidebar identity, the step line, the footer — reads from here, so they cannot disagree.
 */
function gtView() {
    const gh = gtState.githubStatus;
    const list = gtAccountList();
    const hasAccounts = list.length > 0 || !!(gh && gh.connected);
    const st = gtState.status;
    const prov = st && st.provisioning;
    const session = st && st.session;
    const eng = (gtState.engine && gtState.engine.engine) || {};
    const pending = gh && gh.pending;
    const base = { hasAccounts, session, live: gtSessionLive(), connected: !!eng.connected };

    if (gtState.busy === 'reset') {
        return Object.assign(base, { tone: 'busy', act: '',
            head: 'در حال ریست کامل',
            line: 'تونل، محافظ نشت و موتور اتصال در حال خاموش شدن هستند و تنظیمات پاک می‌شود. چند ثانیه طول می‌کشد.' });
    }
    if (gtState.connecting || (pending && pending.state === 'waiting')) {
        return Object.assign(base, { tone: 'busy', act: '',
            head: hasAccounts ? 'افزودن حساب گیت‌هاب' : 'اتصال به گیت‌هاب',
            line: 'کد پایین را در صفحهٔ گیت‌هاب وارد کنید. تا وقتی این پنجره باز است کد معتبر می‌ماند.' });
    }
    if (!hasAccounts) {
        return Object.assign(base, { tone: 'off', act: '',
            head: 'اول یک حساب گیت‌هاب وصل کنید',
            line: 'این تونل سرور اجاره‌ای ندارد: یک سرور ابری ویندوز روی سهمیهٔ حساب گیت‌هاب خودتان بالا می‌آید و ترافیک از آن رد می‌شود. کارت پایین، اتصال حساب را قدم‌به‌قدم انجام می‌دهد.' });
    }

    const inProgress = prov && !['READY', 'FAILED'].includes(prov.state);
    const justFinished = prov && prov.state === 'READY' && (!session || session.status === 'SETTING_UP');
    if (inProgress || justFinished) {
        const label = GT_PROV_LABELS[prov && prov.state] || 'آماده‌سازی';
        return Object.assign(base, { tone: 'busy', act: '',
            head: 'در حال ساخت نشست ابری',
            line: `${gtEsc(label)}… — ساخت یک سرور ابری چند دقیقه طول می‌کشد؛ می‌توانید پنجره را ببندید، کار ادامه پیدا می‌کند.` });
    }
    if (prov && prov.state === 'FAILED') {
        return Object.assign(base, { tone: 'off', act: 'setup',
            head: 'ساخت نشست ناموفق بود',
            line: 'کارت پایین می‌گوید کجا گیر کرد و چه کاری آن را باز می‌کند. دکمهٔ بالا دوباره تلاش می‌کند.' });
    }
    if (base.connected) {
        const mode = eng.mode === 'tun' ? 'تونل کامل — همهٔ برنامه‌ها، با UDP' : 'پروکسی سیستم — فقط برنامه‌های پروکسی‌پذیر، بدون UDP';
        const left = session && session.remainingMs ? ` · ${gtFmtCountdown(session.remainingMs)} تا پایان نشست` : '';
        return Object.assign(base, { tone: 'on', act: 'disconnect',
            head: 'وصل است',
            line: `${mode}${left}` });
    }
    if (base.live) {
        return Object.assign(base, { tone: 'off', act: 'connect',
            head: 'نشست آماده است — هنوز چیزی از تونل رد نمی‌شود',
            line: 'سرور ابری شما بالاست و ساعتش دارد می‌گذرد، ولی تا وقتی یکی از دو مسیر روشن نشود هیچ ترافیکی از آن عبور نمی‌کند. دکمهٔ بالا مسیر آخری که انتخاب کرده بودید را روشن می‌کند.' });
    }
    if (gtHasLiveEngine()) {
        return Object.assign(base, { tone: 'off', act: 'disconnect',
            head: 'نشست تمام شد، ولی چیزی هنوز روشن مانده',
            line: 'محافظ نشت یا موتور اتصال هنوز برچیده نشده‌اند. تا وقتی محافظ درگیر است، اینترنت این کامپیوتر مسدود می‌ماند — دکمهٔ بالا همه را می‌بندد.' });
    }
    return Object.assign(base, { tone: 'off', act: 'setup',
        head: 'آمادهٔ ساخت نشست ابری',
        line: 'دکمهٔ بالا یک سرور ابری ویندوز روی سهمیهٔ یکی از حساب‌های شما می‌سازد و بعد از چند دقیقه کانفیگ آماده می‌شود.' });
}

function gtDot(tone) {
    return `<i class="mv-eng-dot${tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : ''}"></i>`;
}

function gtRenderIdent() {
    const host = document.getElementById('gt-ident');
    if (!host) return;
    const v = gtView();
    const word = v.tone === 'on' ? 'وصل است' : v.tone === 'busy' ? 'در حال کار' : 'خاموش';
    const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('github');
    const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
        : '<span class="mv-side-tile" style="--tint:var(--mv-label-2)"><svg aria-hidden="true"><use href="#g-github"/></svg></span>';
    host.innerHTML = `${icon}
      <b>گیت‌هاب تانل</b>
      <small>${gtDot(v.tone)}${word}</small>`;
}

/** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
function gtRenderStage() {
    const host = document.getElementById('gt-stage');
    if (!host) return;
    const v = gtView();

    if (host.dataset.built !== '1') {
        host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-gt-act="power" data-part="power">
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

    const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : '';
    const btn = q('power');
    const want = 'mv-eng-power' + ring;
    if (btn.className !== want) btn.className = want;
    btn.disabled = !v.act || !!gtState.busy;
    const aria = v.act === 'disconnect' ? 'قطع' : v.act === 'setup' ? 'ساخت نشست ابری' : 'اتصال';
    btn.setAttribute('aria-label', aria);
    btn.title = v.act ? aria : 'هنوز کاری برای این دکمه نیست';
    const glyph = v.tone === 'busy' ? 'mv-spin-ring' : (v.tone === 'on' ? 'ph-fill ph-power' : 'ph-bold ph-power');
    const gl = q('glyph');
    if (gl.className !== glyph) gl.className = glyph;

    const el = q('live');
    if (el && window.MVEngineLive) MVEngineLive.mount(el);
}

/** The provisioning run as one horizontal line, on screen only while it is running. */
function gtRenderFlow() {
    const wrap = document.getElementById('gt-flow');
    const host = document.getElementById('gt-steps');
    if (!wrap || !host) return;

    const prov = gtState.status && gtState.status.provisioning;
    const show = !!prov && !['FAILED'].includes(prov.state) && !gtSessionLive();
    wrap.style.display = show ? 'flex' : 'none';
    if (!show) return;

    const idx = Math.max(0, GT_PROV_ORDER.indexOf(prov.state));
    host.innerHTML = GT_PROV_ORDER.map((key, i) => {
        let cls = 'pending', mark = String(i + 1).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
        if (i < idx) { cls = 'done'; mark = '✓'; }
        else if (i === idx) { cls = 'active'; mark = '●'; }
        return `<span class="mv-step is-${cls}"><i>${mark}</i>${GT_PROV_LABELS[key]}</span>`;
    }).join('');
}

function gtKv(label, value) {
    return `<div class="gt-kv"><span>${label}</span><b dir="ltr">${gtEsc(value)}</b></div>`;
}

/**
 * The cards: the four things this window owns. Each header opens the section that holds all
 * of it; what is on the card is what the user needs to see without going there.
 */
function gtRenderCards() {
    const host = document.getElementById('gt-cards');
    if (!host) return;

    const gh = gtState.githubStatus;
    const v = gtView();
    const list = gtAccountList();
    const st = gtState.status;
    const prov = st && st.provisioning;
    const session = st && st.session;
    const pending = gh && gh.pending;
    const parts = [];

    // The device-code flow answers the whole page while it is on.
    if (!v.hasAccounts || gtState.addingAccount || gtState.connecting
        || (pending && ['waiting', 'error'].includes(pending.state))) {
        parts.push(`<div class="gt-span">${gtRenderConnectStep(gh)}</div>`);
    }

    // A run that is going, or one that stopped — each with the thing that unblocks it.
    if (prov && prov.state === 'FAILED' && prov.errorCode === 'ACL_TAG_NOT_PERMITTED') {
        parts.push(`<div class="gt-span">${gtRenderAclFix(prov)}</div>`);
    } else if (prov && prov.state === 'FAILED' && prov.errorCode === 'BROKER_NOT_DEPLOYED') {
        parts.push(`<div class="gt-span">${gtCard(`
          <div style="font-size:13.5px; font-weight:700;">سرویس شبکهٔ امن هنوز راه‌اندازی نشده</div>
          <div style="font-size:12px; color:var(--mv-label-2); line-height:1.9;">این یک‌بار انجام می‌شود و روی حساب کلادفلر خودتان نصب می‌شود. تا قبل از آن، نشست ابری نمی‌تواند به شبکهٔ شما وصل شود.</div>
          <button type="button" class="mv-btn mv-btn--sm mv-btn--primary" data-gt-go="broker">راه‌اندازی سرویس شبکهٔ امن</button>`)}</div>`);
    } else if (prov && prov.state === 'FAILED') {
        parts.push(`<div class="gt-span">${gtRenderFailed(gh, prov)}</div>`);
    } else if (prov && !['READY', 'FAILED'].includes(prov.state)) {
        parts.push(`<div class="gt-span">${gtRenderProgress(gh, prov)}</div>`);
    }

    if (v.hasAccounts) {
        const expiring = session && session.status === 'EXPIRING_SOON';
        const ready = list.filter((a) => !a.disabled && a.health !== 'AUTH_REQUIRED' && a.cooldownRemainingMs <= 0).length;
        const needsAuth = list.filter((a) => a.health === 'AUTH_REQUIRED').length;
        const exhausted = list.filter((a) => a.health === 'EXHAUSTED').length;

        const eng = (gtState.engine && gtState.engine.engine) || {};
        const ks = (gtState.engine && gtState.engine.killSwitch) || {};
        const connected = !!eng.connected;
        const tunOn = connected && eng.mode === 'tun';
        const proxyOn = connected && eng.mode === 'proxy';
        const busy = gtState.busy || (gtState.engine && gtState.engine.busy ? 'server' : '');
        const ksApplicable = ks.applicable !== false;

        const b = gtState.broker || {};
        const brokerWord = b.needsRedeploy ? 'نیاز به بروزرسانی' : b.deployed ? 'راه‌اندازی شده' : 'راه‌اندازی نشده';

        // ── نشست ابری ──
        parts.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-green)">
        <div class="mv-eng-card2-top">
          <div class="mv-eng-card2-head" style="cursor:default">
            <span class="mv-eng-glyph"><i class="ph-fill ph-cloud"></i></span>
            <h3>نشست ابری</h3>
            <span class="mv-eng-card2-end">${v.live ? (expiring ? 'به‌زودی پایان' : 'فعال') : 'ندارید'}</span>
          </div>
          ${v.live ? `<button type="button" class="mv-eng-card2-act" data-gt-act="renew"
                  title="تمدید — یک نشست تازه به‌جای این" aria-label="تمدید نشست" ${gtState.busy ? 'disabled' : ''}>
            <i class="ph-bold ph-arrows-clockwise"></i>
          </button>` : ''}
        </div>
        <div class="mv-eng-card2-body">
          ${v.live ? `
          <div class="gt-count${expiring ? ' is-soon' : ''}" id="gt-countdown" dir="ltr">${gtFmtCountdown(session.remainingMs || 0)}</div>
          <div class="gt-count-sub">زمان باقی‌ماندهٔ نشست ابری</div>
          ${gtKv('آدرس نشست', session.tailscaleIp || '—')}
          ${session.accountLogin ? gtKv('روی حساب', '@' + session.accountLogin) : ''}`
            : '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز نشستی ساخته نشده — دکمهٔ بالا یکی می‌سازد.</div>'}
        </div>
        ${v.live ? `<div style="padding:0 8px 8px">${gtRenderEndSessionButton()}</div>` : ''}
        ${v.live ? '' : '<div class="mv-eng-card2-foot">ساخت نشست چند دقیقه طول می‌کشد و از سهمیهٔ ماهانهٔ حساب گیت‌هاب برداشت می‌شود.</div>'}
      </div>`);

        // ── حساب‌ها ──
        parts.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-label-2)">
        <div class="mv-eng-card2-top">
          <button type="button" class="mv-eng-card2-head" data-gt-go="accounts">
            <span class="mv-eng-glyph"><i class="ph-fill ph-github-logo"></i></span>
            <h3>حساب‌های گیت‌هاب</h3>
            <span class="mv-eng-card2-end">${list.length ? list.length.toLocaleString('fa-IR') : '—'}<i class="ph-bold ph-caret-left"></i></span>
          </button>
          <button type="button" class="mv-eng-card2-act" data-gt-act="add-account"
                  title="افزودن حساب گیت‌هاب" aria-label="افزودن حساب گیت‌هاب">
            <i class="ph-bold ph-plus"></i>
          </button>
        </div>
        <div class="mv-eng-card2-body">
          ${list.length ? list.slice(0, 3).map((a) => {
            const stt = GT_ACCOUNT_STATE[a.health] || GT_ACCOUNT_STATE.UNKNOWN;
            return `
          <div class="mv-eng-pick" aria-disabled="true">
            <i class="ph-fill ph-circle" style="color:${stt.color}"></i>
            <span class="mv-eng-pick-text"><b dir="ltr">@${gtEsc(a.login)}</b><small>${gtEsc(stt.label)}</small></span>
          </div>`;
        }).join('') : '<div class="mv-eng-card2-foot" style="padding-top:6px">هنوز حسابی اضافه نشده.</div>'}
        </div>
        <div class="mv-eng-card2-foot">${list.length
            ? `${ready.toLocaleString('fa-IR')} آماده${exhausted ? ` · ${exhausted.toLocaleString('fa-IR')} سهمیه تمام` : ''}${needsAuth ? ` · ${needsAuth.toLocaleString('fa-IR')} نیاز به اتصال` : ''} — وقتی سهمیهٔ یکی تمام شود، خودش سراغ بعدی می‌رود.`
            : 'هر حساب گیت‌هاب یک منبع جداگانه برای اجرای نشست ابری است.'}</div>
      </div>`);

        // ── مسیر ترافیک ──
        parts.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <button type="button" class="mv-eng-card2-head" data-gt-go="network">
          <span class="mv-eng-glyph"><i class="ph-fill ph-shield-check"></i></span>
          <h3>مسیر ترافیک</h3>
          <span class="mv-eng-card2-end">${tunOn ? 'تونل کامل' : proxyOn ? 'پروکسی سیستم' : 'خاموش'}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body" role="radiogroup" aria-label="مسیر ترافیک">
          <button type="button" class="mv-eng-pick${tunOn ? ' is-on is-live' : ''}" data-gt-mode="tun"
                  role="radio" aria-checked="${tunOn}" ${busy || !v.live ? 'disabled' : ''}
                  title="${v.live ? '' : 'اول یک نشست ابری بسازید'}">
            <i class="${busy === 'tun' ? 'mv-spin-ring' : tunOn ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>
            <span class="mv-eng-pick-text"><b>تونل کامل (پیشنهادی)</b><small>تمام ترافیک، با UDP — بازی و تماس تصویری کار می‌کند. کمترین پینگ.</small></span>
          </button>
          <button type="button" class="mv-eng-pick${proxyOn ? ' is-on is-live' : ''}" data-gt-mode="proxy"
                  role="radio" aria-checked="${proxyOn}" ${busy || !v.live ? 'disabled' : ''}
                  title="${v.live ? '' : 'اول یک نشست ابری بسازید'}">
            <i class="${busy === 'proxy' ? 'mv-spin-ring' : proxyOn ? 'ph-fill ph-check-circle' : 'ph-bold ph-circle'}"></i>
            <span class="mv-eng-pick-text"><b>پروکسی سیستم</b><small>فقط مرورگر و برنامه‌های پروکسی‌پذیر. بدون UDP، ولی روی اینترنت‌های سخت‌گیر بهتر جواب می‌دهد.</small></span>
          </button>
        </div>
        <div class="mv-eng-card2-foot">${!ksApplicable
            ? 'محافظ نشت در حالت پروکسی کار نمی‌کند — به آداپتور تونل کامل نیاز دارد.'
            : ks.engaged ? 'محافظ نشت درگیر است: اگر تونل قطع شود، هیچ ترافیکی با آی‌پی واقعی خارج نمی‌شود.'
                : ks.enabled ? 'محافظ نشت روشن است و با اتصال بعدی درگیر می‌شود.'
                    : 'محافظ نشت خاموش است — در بخش «مسیر و محافظ» روشنش کنید.'}</div>
      </div>`);

        // ── سرویس شبکهٔ امن ──
        parts.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <button type="button" class="mv-eng-card2-head" data-gt-go="broker">
          <span class="mv-eng-glyph"><i class="ph-fill ph-cloud-check"></i></span>
          <h3>سرویس شبکهٔ امن</h3>
          <span class="mv-eng-card2-end">${brokerWord}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          ${b.effectiveUrl ? gtKv('آدرس', String(b.effectiveUrl).replace(/^https?:\/\//, '')) : ''}
          ${b.tsTailnet ? gtKv('Tailnet', b.tsTailnet) : ''}
          ${!b.effectiveUrl && !b.tsTailnet ? '<div class="mv-eng-card2-foot" style="padding-top:6px">یک‌بار راه‌اندازی می‌شود و روی حساب کلادفلر خودتان می‌نشیند.</div>' : ''}
        </div>
        <div class="mv-eng-card2-foot">${b.needsRedeploy
            ? 'این سرویس با نسخهٔ قدیمی راه‌اندازی شده و از نظر امنیتی باز است — یک‌بار «به‌روزرسانی و ادامه» را بزنید؛ نشست فعلی دست‌نخورده می‌ماند.'
            : 'همان چیزی که نشست ابری را به شبکهٔ خصوصی شما وصل می‌کند. روی حساب کلادفلر خودتان است، نه سرور ما.'}</div>
      </div>`);
    }

    host.innerHTML = parts.join('');
}

function gtRenderFoot() {
    const host = document.getElementById('gt-foot');
    if (!host) return;
    const v = gtView();
    const eng = (gtState.engine && gtState.engine.engine) || {};
    const word = v.tone === 'on' ? 'وصل' : v.tone === 'busy' ? 'در حال کار'
        : v.live ? 'نشست آماده — مسیری روشن نیست'
            : v.hasAccounts ? 'نشستی ندارید' : 'حسابی وصل نیست';
    const end = v.connected ? (eng.mode === 'tun' ? 'تونل کامل سیستم' : 'پروکسی سیستم')
        : v.live ? 'بدون مسیر' : '—';
    const clock = v.live && v.session && v.session.remainingMs
        ? `<code dir="ltr">${gtFmtCountdown(v.session.remainingMs)}</code>` : '';
    host.innerHTML = `
      ${gtDot(v.tone)}
      <span>${word}</span>
      <span class="mv-eng-foot-end">${clock}<span>${end}</span></span>`;
}

/** Show one section. `gtState.view` follows it — the status poll reads that name. */
function gtGoSec(id) {
    const wrap = document.getElementById('gt-wrapper');
    if (!wrap) return;
    gtSec = GT_SECTIONS.some((x) => x.id === id) ? id : 'connect';
    gtState.view = gtSec === 'accounts' ? 'accounts' : 'main';
    // The relay form only renders its stored values when this is set; leaving the section
    // clears it so a background poll cannot put the form back over the page.
    gtState.forceBrokerSetup = gtSec === 'broker';
    if (gtSec === 'broker') gtState.brokerError = '';

    wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === gtSec));
    wrap.querySelectorAll('.mv-side-item[data-gt-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-gt-sec') === gtSec));
    const found = GT_SECTIONS.find((x) => x.id === gtSec);
    const title = document.getElementById('gt-pane-title');
    if (title) title.textContent = found ? found.label : '';
    const back = document.getElementById('gt-back');
    if (back) back.disabled = gtSec === 'connect';
    const pane = wrap.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', gtSec === 'connect');
    const sc = document.getElementById('gt-scroll');
    if (sc) sc.scrollTop = 0;

    if (gtSec === 'accounts') gtRefreshAccounts();
    if (gtSec === 'broker') gtRefreshBroker();
    gtRender(true);
}

function gtWire(root) {
    root.querySelectorAll('[data-gt-go]').forEach((b) => {
        b.onclick = () => gtGoSec(b.getAttribute('data-gt-go'));
    });
    root.querySelectorAll('[data-gt-mode]').forEach((b) => {
        b.onclick = () => {
            const k = b.getAttribute('data-gt-mode');
            const eng = (gtState.engine && gtState.engine.engine) || {};
            const on = !!eng.connected && eng.mode === k;
            if (k === 'tun') gtToggleTun(!on); else gtToggleProxy(!on);
        };
    });
    root.querySelectorAll('[data-gt-act]').forEach((b) => {
        b.onclick = () => {
            const k = b.getAttribute('data-gt-act');
            if (k === 'power') {
                const act = gtView().act;
                if (act === 'disconnect') gtDisconnectEngine();
                else if (act === 'connect') gtConnectEngine();
                else if (act === 'setup') gtBeginSetup();
            } else if (k === 'add-account') gtAddAccount();
            else if (k === 'renew') {
                const s = gtState.status && gtState.status.session;
                gtActivateAgain(!!s && s.status === 'EXPIRING_SOON');
            }
        };
    });
}

function gtRender(force) {
    const root = document.getElementById('ls-github-tunnel');
    if (!root) return;

    if (!document.getElementById('gt-wrapper')) {
        root.innerHTML = gtHtmlTemplate;
        const wrap = document.getElementById('gt-wrapper');
        wrap.querySelectorAll('.mv-side-item[data-gt-sec]').forEach((b) => {
            b.onclick = () => gtGoSec(b.getAttribute('data-gt-sec'));
        });
        const back = document.getElementById('gt-back');
        if (back) back.onclick = () => gtGoSec('connect');
        // The engine that carries this tunnel is a store item (store/catalog.js › core|tailscale).
        const store = document.getElementById('gt-store');
        if (store) store.onclick = () => {
            if (typeof window.storeOpenItem === 'function') window.storeOpenItem('core|tailscale');
            else if (window.MV && MV.wm) MV.wm.open('store');
        };
        gtGoSec('connect');
        return;      // gtGoSec calls back in, with the shell in place
    }

    gtRenderIdent();
    gtRenderFoot();

    if (gtSec === 'connect') {
        gtRenderStage();
        gtRenderFlow();
        gtRenderCards();
    } else if (gtSec === 'accounts') {
        const host = document.getElementById('gt-sec-accounts');
        if (host) host.innerHTML = gtRenderAccounts();
    } else if (gtSec === 'network') {
        const host = document.getElementById('gt-sec-network');
        if (host) host.innerHTML = gtCard(gtRenderEngineControls() + gtRenderSpeedResults());
    } else if (gtSec === 'broker') {
        // The relay form has inputs the user types into by hand, and every render replaces
        // them. A background poll landing mid-entry would wipe a half-typed client secret,
        // so while that form is on screen only a render that ASKED for it may redraw.
        const host = document.getElementById('gt-sec-broker');
        if (host && (force || !document.getElementById('gt-ts-id'))) host.innerHTML = gtRenderBrokerSetup(gtState.githubStatus);
    }

    gtWire(document.getElementById('gt-wrapper'));
}

function gtRenderConnectStep(gh) {
    const pending = gh && gh.pending;
    if (gtState.connecting || (pending && pending.state === 'waiting')) {
        if (pending && pending.state === 'waiting') {
            const adding = gtHasAccounts();
            return gtCard(`
                <div style="text-align:center; display:flex; flex-direction:column; gap: 10px;">
                    <div style="font-size: 15px; font-weight: 600; color: var(--ide-text-main);">${adding ? 'افزودن حساب گیت‌هاب' : 'اتصال به گیت‌هاب'}</div>

                    ${adding ? `<div style="background: color-mix(in srgb, var(--mv-orange) 12%, transparent); border:1px solid var(--syn-yellow); border-radius:8px; padding:9px 11px; font-size:11.5px; color: var(--syn-yellow); line-height:1.9; text-align:right;">
                        گیت‌هاب همان حسابی را تأیید می‌کند که <b>در مرورگر وارد شده است</b>.
                        اگر الان با حساب قبلی در مرورگر لاگین هستید، همان حساب دوباره ثبت می‌شود و حساب جدیدی اضافه نمی‌شود.<br>
                        برای حساب دوم: صفحه‌ی زیر را در پنجره‌ی <b>ناشناس/Incognito</b> باز کنید و با حساب دوم وارد شوید.
                    </div>` : ''}

                    <div style="color: var(--ide-text-muted); font-size: 13px;">این کد را در صفحه‌ی گیت‌هاب وارد کنید:</div>
                    <div style="font-size: 26px; font-weight: 700; letter-spacing: 4px; color: var(--syn-blue); background: var(--ide-bg); border: 1px solid var(--ide-border); border-radius: 8px; padding: 10px; user-select:all; direction:ltr; font-family: var(--mv-font-tech);">${gtEsc(pending.userCode)}</div>
                    <button onclick="gtCopyText('${gtEsc(pending.userCode)}','کد کپی شد.')" style="background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-muted); padding:6px; border-radius:7px; cursor:pointer; font-size:11.5px;">کپی کد</button>

                    <div style="display:flex; gap:6px;">
                        <button onclick="gtOpenVerificationUrl('${gtEsc(pending.verificationUri)}')"
                            style="flex:1; background: transparent; border: 1px solid var(--ide-border); color: var(--ide-text-main); padding: 8px; border-radius: 8px; cursor: pointer; font-size: 12.5px;">باز کردن مرورگر</button>
                        <button onclick="gtCopyText('${gtEsc(pending.verificationUri)}','آدرس کپی شد — در پنجره‌ی ناشناس باز کنید.')"
                            style="flex:1; background: transparent; border: 1px solid var(--ide-border); color: var(--ide-text-muted); padding: 8px; border-radius: 8px; cursor: pointer; font-size: 12.5px;">کپی آدرس</button>
                    </div>
                    <div style="font-size:10.5px; color: var(--ide-text-dim); direction:ltr; user-select:all;">${gtEsc(pending.verificationUri)}</div>

                    <div style="color: var(--ide-text-dim); font-size: 11px; display:flex; align-items:center; justify-content:center; gap:6px;">${gtSpinner()} در انتظار تأیید…</div>

                    <details style="text-align:right; background: var(--ide-bg); border:1px solid var(--ide-border); border-radius:8px; padding:8px 10px;">
                        <summary style="font-size:11.5px; color: var(--syn-blue); cursor:pointer; list-style:none;">صفحه‌ی گیت‌هاب خطا داد یا ۴۰۴ شد؟</summary>
                        <div style="font-size:11px; color: var(--ide-text-muted); line-height:1.9; margin-top:6px;">
                            این خطا مربوط به صفحه‌ی «تأیید دستگاه» خودِ گیت‌هاب است و ربطی به MLMVPN ندارد. معمولاً یکی از این‌ها حلش می‌کند:
                            <div style="margin-top:5px;">۱. ایمیل خود را باز کنید؛ گیت‌هاب یک کد تأیید فرستاده است.</div>
                            <div>۲. آدرس <span style="direction:ltr; display:inline-block; font-family:var(--mv-font-mono); user-select:all;">github.com/sessions/verified-device</span> را دستی باز کنید و آن کد را وارد کنید.</div>
                            <div>۳. اگر باز هم نشد، همین صفحه را در یک مرورگر دیگر یا پنجره‌ی ناشناس باز کنید.</div>
                            <div>۴. اگر با «ورود با گوگل» خطای <span style="direction:ltr; display:inline-block;">Looks like something went wrong</span> گرفتید، آن روش را رها کنید: در گیت‌هاب کاملاً خارج شوید و با <b>نام‌کاربری و رمز عبور</b> وارد شوید. ورود با گوگل در این مسیر پایدار نیست.</div>
                            <div style="margin-top:5px;">کد بالا تا وقتی این پنجره باز است معتبر می‌ماند؛ لازم نیست از اول شروع کنید.</div>
                        </div>
                    </details>

                    ${adding ? `<div style="font-size:11px; color: var(--ide-text-dim); line-height:1.7;">برای اینکه مقدار دقیق سهمیه نشان داده شود، هنگام تأیید همه‌ی دسترسی‌های خواسته‌شده را قبول کنید.</div>
                    <button onclick="gtCancelAddAccount()" style="background: transparent; border:none; color: var(--ide-text-dim); cursor:pointer; font-size:11.5px;">انصراف</button>` : ''}
                </div>`);
        }
        // کلیک شد اما هنوز پاسخ سرور نرسیده — حتماً یک لودینگ نشان بده.
        return gtCard(`
            <div style="text-align:center; display:flex; flex-direction:column; gap: 12px; padding: 16px 0;">
                <div style="font-size: 15px; font-weight: 600; color: var(--ide-text-main);">در حال ساخت کد ورود…</div>
                <div style="display:flex; align-items:center; justify-content:center; gap:8px; color: var(--ide-text-muted); font-size: 12.5px;">${gtSpinner()} لطفاً چند لحظه صبر کنید</div>
                ${gtHasAccounts() ? `<button onclick="gtCancelAddAccount()" style="background: transparent; border:none; color: var(--ide-text-dim); cursor:pointer; font-size:11.5px;">انصراف</button>` : ''}
            </div>`);
    }
    if (pending && pending.state === 'error') {
        return gtCard(`
            <div style="text-align:center; display:flex; flex-direction:column; gap: 10px;">
                <div style="color: var(--syn-red); font-size: 13px;">${gtEsc(pending.error)}</div>
                <button onclick="gtConnectGithub()" style="background: var(--syn-blue); border: none; color: #fff; padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">تلاش دوباره</button>
            </div>`);
    }
    return gtCard(`
        <div style="text-align:center; display:flex; flex-direction:column; gap: 12px; padding: 8px 0;">
            <div style="color: var(--mv-label-2); font-size: 13px; line-height: 1.9;">تونل ابری اختصاصی خودتان را در چند مرحله‌ی ساده بسازید. سربرگ بالا می‌گوید هر لحظه کجای کار هستید.</div>
            <button onclick="gtConnectGithub()" style="background: var(--syn-blue); border: none; color: #fff; padding: 12px; border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 14px; margin-top: 4px;">اتصال به گیت‌هاب</button>
            <div style="color: var(--ide-text-dim); font-size: 11.5px; line-height: 1.6;">حساب گیت‌هاب خود را با روشی امن متصل کنید. بقیه‌ی مراحل را MLMVPN خودش انجام می‌دهد.</div>
            <button onclick="gtResetAll()" style="background: transparent; border: none; color: var(--ide-text-dim); cursor: pointer; font-size: 11px; padding: 2px;">پاک کردن همه‌ی تنظیمات قبلی</button>
        </div>`);
}

// ── حساب‌های گیت‌هاب ────────────────────────────────────────────────────────────────
// Each account is a separate, exhaustible pot of GitHub Actions capacity. The panel's job
// is to make three things obvious at a glance: which one the tunnel is on right now, which
// ones could take over, and which ones need the user to do something.

const GT_ACCOUNT_STATE = {
    OK: { label: 'آماده', color: 'var(--syn-green)', dot: '&#9679;' },
    UNKNOWN: { label: 'آماده', color: 'var(--syn-green)', dot: '&#9679;' },
    EXHAUSTED: { label: 'سهمیه تمام شده', color: 'var(--syn-yellow)', dot: '&#9679;' },
    RATE_LIMITED: { label: 'محدودیت موقت گیت‌هاب', color: 'var(--syn-yellow)', dot: '&#9679;' },
    DISPATCH_FAILED: { label: 'اجرای ناموفق', color: 'var(--syn-yellow)', dot: '&#9679;' },
    REPO_ERROR: { label: 'مشکل در زیرساخت این حساب', color: 'var(--syn-yellow)', dot: '&#9679;' },
    AUTH_REQUIRED: { label: 'نیاز به اتصال دوباره', color: 'var(--syn-red)', dot: '&#9675;' },
};

/**
 * The one line that says how much capacity this account has.
 *
 * Measured and estimated numbers are NEVER formatted the same way. An estimate is a floor
 * on spend with no allowance to compare against, and showing it in the same shape as a real
 * remaining balance would invite the user to plan around a number that does not mean what
 * it looks like.
 */
function gtQuotaLine(a) {
    const q = a.quota || {};
    if (q.source === 'measured' && q.includedMinutes != null) {
        const remaining = q.remainingMinutes != null ? q.remainingMinutes : Math.max(0, q.includedMinutes - q.usedMinutes);
        const pct = q.includedMinutes ? Math.min(100, Math.round((q.usedMinutes / q.includedMinutes) * 100)) : 0;
        const color = remaining <= 0 ? 'var(--syn-red)' : (pct >= 80 ? 'var(--syn-yellow)' : 'var(--syn-green)');
        return `
            <div style="display:flex; justify-content:space-between; font-size:11px; color: var(--ide-text-muted); margin-top:4px;">
                <span>${gtEsc(remaining)} از ${gtEsc(q.includedMinutes)} دقیقه باقی مانده</span>
                <span style="color:${color};">${pct}٪ مصرف</span>
            </div>
            <div style="height:4px; background: var(--ide-bg); border-radius:2px; overflow:hidden; margin-top:3px;">
                <div style="width:${pct}%; height:100%; background:${color};"></div>
            </div>
            ${q.paidMinutesUsed > 0 ? `<div style="font-size:10px; color: var(--ide-text-dim); margin-top:3px;">این حساب از اعتبار پولی هم استفاده می‌کند، پس با تمام شدن سهم رایگان متوقف نمی‌شود.</div>` : ''}`;
    }
    if (q.source === 'estimated') {
        return `
            <div style="font-size:11px; color: var(--ide-text-muted); margin-top:4px;">
                حدود ${gtEsc(q.usedMinutes || 0)} دقیقه مصرف شده — <span style="color: var(--syn-yellow);">تخمینی</span>
            </div>
            <div style="font-size:10px; color: var(--ide-text-dim); line-height:1.6; margin-top:2px;">
                فقط اجراهای همین برنامه شمرده می‌شود، پس مصرف واقعی می‌تواند بیشتر باشد. برای عدد دقیق، این حساب را دوباره متصل کنید.
            </div>`;
    }
    // "نامشخص" on its own is the least useful thing this panel can say: the user cannot tell
    // whether something is broken, whether the account is usable, or what to do. There are
    // only two real causes and each has a different answer, so name the one that applies.
    if (!a.repository) {
        return `<div style="font-size:11px; color: var(--ide-text-dim); margin-top:4px; line-height:1.7;">
            هنوز با این حساب نشستی ساخته نشده، پس چیزی برای شمردن نیست. بعد از اولین نشست، مصرف اینجا نشان داده می‌شود.
        </div>`;
    }
    if (a.canReadBilling === false) {
        return `<div style="font-size:11px; color: var(--ide-text-dim); margin-top:4px; line-height:1.7;">
            مقدار سهمیه خوانده نشد چون هنگام اتصال، اجازه‌ی خواندن اطلاعات حساب داده نشده است.
            برای دیدن عدد دقیق، این حساب را حذف و دوباره متصل کنید و همه‌ی دسترسی‌های خواسته‌شده را تأیید کنید.
        </div>`;
    }
    return `<div style="font-size:11px; color: var(--ide-text-dim); margin-top:4px; line-height:1.7;">
        مقدار سهمیه فعلاً خوانده نشد${(a.quota && a.quota.note) ? ` — ${gtEsc(a.quota.note)}` : '. «بررسی دوباره‌ی سهمیه‌ها» را بزنید.'}
        این حساب همچنان قابل استفاده است.
    </div>`;
}

function gtRenderAccountRow(a, currentAccountId) {
    const st = GT_ACCOUNT_STATE[a.health] || GT_ACCOUNT_STATE.UNKNOWN;
    const isCurrent = a.id === currentAccountId;
    const cooling = a.cooldownRemainingMs > 0;
    const coolMins = Math.ceil(a.cooldownRemainingMs / 60000);

    const badge = a.disabled
        ? `<span style="font-size:10.5px; color: var(--ide-text-dim); border:1px solid var(--ide-border); border-radius:5px; padding:1px 6px;">غیرفعال</span>`
        : isCurrent
            ? `<span style="font-size:10.5px; color: var(--syn-blue); border:1px solid var(--syn-blue); border-radius:5px; padding:1px 6px;">در حال استفاده</span>`
            : (a.activeSessionId
                ? `<span style="font-size:10.5px; color: var(--syn-green); border:1px solid var(--syn-green); border-radius:5px; padding:1px 6px;">نشست فعال</span>`
                : '');

    return `
        <div style="border:1px solid ${isCurrent ? 'var(--syn-blue)' : 'var(--ide-border)'}; border-radius:10px; padding:10px 12px; display:flex; flex-direction:column; gap:2px; ${a.disabled ? 'opacity:.55;' : ''}">
            <div style="display:flex; align-items:center; gap:8px;">
                ${a.avatarUrl ? `<img src="${gtEsc(a.avatarUrl)}" style="width:26px;height:26px;border-radius:50%;" />` : ''}
                <div style="flex:1; min-width:0;">
                    <div style="font-size:12.5px; color: var(--ide-text-main); direction:ltr; text-align:right;">@${gtEsc(a.login)}</div>
                    <div style="font-size:10.5px; color:${st.color};">${st.dot} ${gtEsc(st.label)}${cooling ? ` — ${coolMins} دقیقه دیگر` : ''}</div>
                </div>
                ${badge}
            </div>
            ${gtQuotaLine(a)}
            ${a.healthReason && a.health !== 'OK' ? `<div style="font-size:10px; color: var(--ide-text-dim); line-height:1.6; margin-top:3px; direction:ltr; text-align:left;">${gtEsc(String(a.healthReason).slice(0, 160))}</div>` : ''}
            <div style="display:flex; gap:6px; margin-top:8px; flex-wrap:wrap;">
                ${a.health === 'AUTH_REQUIRED'
                    ? `<button onclick="gtAddAccount()" style="flex:1; background: var(--syn-blue); border:none; color:#fff; padding:6px; border-radius:7px; cursor:pointer; font-size:11px;">اتصال دوباره</button>`
                    : (cooling || a.consecutiveFailures
                        ? `<button onclick="gtRetryAccount('${gtEsc(a.id)}')" style="flex:1; background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-main); padding:6px; border-radius:7px; cursor:pointer; font-size:11px;">تلاش دوباره</button>`
                        : '')}
                <button onclick="gtToggleAccount('${gtEsc(a.id)}', ${!a.disabled})" style="background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-muted); padding:6px 10px; border-radius:7px; cursor:pointer; font-size:11px;">${a.disabled ? 'فعال کردن' : 'غیرفعال'}</button>
                <button onclick="gtRemoveAccount('${gtEsc(a.id)}','${gtEsc(a.login)}')" style="background: transparent; border:1px solid var(--ide-border); color: var(--syn-red); padding:6px 10px; border-radius:7px; cursor:pointer; font-size:11px;">حذف</button>
            </div>
        </div>`;
}

/**
 * The device code, wherever the user asked for it.
 *
 * It used to exist only inside gtRenderConnectStep — but «افزودن حساب گیت‌هاب» is a button on
 * the ACCOUNTS page, and that page had no branch for a sign-in in flight. So the browser tab
 * opened asking for a code and the panel behind it still showed the account list: the one
 * thing the user needed was rendered on a page they were not on.
 */
function gtPendingNotice() {
    const p = gtState.githubStatus && gtState.githubStatus.pending;
    if (!p) return gtState.connecting ? gtCard(`
        <div style="text-align:center; display:flex; flex-direction:column; gap:10px; padding:10px 0;">
            <div style="font-size:14px; font-weight:700; color: var(--ide-text-main);">در حال ساخت کد ورود…</div>
            <div style="display:flex; align-items:center; justify-content:center; gap:8px; color: var(--ide-text-muted); font-size:12.5px;">${gtSpinner()} لطفاً چند لحظه صبر کنید</div>
            <button onclick="gtCancelAddAccount()" style="background: transparent; border:none; color: var(--ide-text-dim); cursor:pointer; font-size:11.5px;">انصراف</button>
        </div>`) : '';

    if (p.state === 'error') return gtCard(`
        <div style="text-align:center; display:flex; flex-direction:column; gap:10px;">
            <div style="color: var(--syn-red); font-size:13px;">${gtEsc(p.error)}</div>
            <button onclick="gtConnectGithub()" style="background: var(--syn-blue); border:none; color:#fff; padding:10px; border-radius:8px; cursor:pointer; font-weight:600;">تلاش دوباره</button>
        </div>`);

    if (p.state !== 'waiting') return '';
    return gtCard(`
        <div style="text-align:center; display:flex; flex-direction:column; gap:10px;">
            <div style="font-size:15px; font-weight:700; color: var(--ide-text-main);">این کد را در گیت‌هاب وارد کنید</div>
            <div style="background: color-mix(in srgb, var(--mv-orange) 12%, transparent); border:1px solid var(--syn-yellow); border-radius:8px; padding:9px 11px; font-size:11.5px; color: var(--syn-yellow); line-height:1.9; text-align:right;">
                گیت‌هاب همان حسابی را تأیید می‌کند که <b>در مرورگر وارد شده است</b>.
                اگر الان با حساب قبلی لاگین هستید، همان حساب دوباره ثبت می‌شود و حساب تازه‌ای اضافه نمی‌شود.<br>
                برای حساب دوم: آدرس زیر را در پنجره‌ی <b>ناشناس/Incognito</b> باز کنید و با حساب دوم وارد شوید.
            </div>
            <div style="font-size:26px; font-weight:700; letter-spacing:4px; color: var(--syn-blue); background: var(--ide-bg); border:1px solid var(--ide-border); border-radius:8px; padding:10px; user-select:all; direction:ltr; font-family: var(--mv-font-tech);">${gtEsc(p.userCode)}</div>
            <div style="display:flex; gap:6px;">
                <button onclick="gtCopyText('${gtEsc(p.userCode)}','کد کپی شد.')" style="flex:1; background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-main); padding:8px; border-radius:8px; cursor:pointer; font-size:12.5px;">کپی کد</button>
                <button onclick="gtOpenVerificationUrl('${gtEsc(p.verificationUri)}')" style="flex:1; background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-main); padding:8px; border-radius:8px; cursor:pointer; font-size:12.5px;">باز کردن مرورگر</button>
                <button onclick="gtCopyText('${gtEsc(p.verificationUri)}','آدرس کپی شد — در پنجره‌ی ناشناس باز کنید.')" style="flex:1; background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-muted); padding:8px; border-radius:8px; cursor:pointer; font-size:12.5px;">کپی آدرس</button>
            </div>
            <div style="font-size:10.5px; color: var(--ide-text-dim); direction:ltr; user-select:all;">${gtEsc(p.verificationUri)}</div>
            <div style="color: var(--ide-text-dim); font-size:11px; display:flex; align-items:center; justify-content:center; gap:6px;">${gtSpinner()} در انتظار تأیید…</div>
            <div style="font-size:11px; color: var(--ide-text-dim); line-height:1.7;">برای اینکه مقدار دقیق سهمیه نشان داده شود، هنگام تأیید همه‌ی دسترسی‌های خواسته‌شده را قبول کنید.</div>
            <button onclick="gtCancelAddAccount()" style="background: transparent; border:none; color: var(--ide-text-dim); cursor:pointer; font-size:11.5px;">انصراف</button>
        </div>`);
}

function gtRenderAccounts() {
    const list = gtAccountList();
    const currentId = gtState.accounts && gtState.accounts.currentAccountId;
    const problem = gtState.accounts && gtState.accounts.poolProblem;
    const anyEstimated = list.some(a => a.quota && a.quota.source === 'estimated');

    return gtPendingNotice() + gtCard(`
        <div style="display:flex; align-items:center; justify-content:space-between;">
            <div style="font-size:14px; font-weight:700; color: var(--ide-text-main);">حساب‌های گیت‌هاب</div>
            <span style="font-size:11px; color: var(--ide-text-dim);">${list.length} حساب</span>
        </div>
        <div style="font-size:11.5px; color: var(--ide-text-muted); line-height:1.8;">
            هر حساب گیت‌هاب یک منبع جداگانه برای اجرای نشست ابری است. وقتی سهمیه‌ی یکی تمام شود،
            MLMVPN خودش سراغ حساب بعدی می‌رود — لازم نیست کاری کنید.
        </div>

        ${problem ? `<div style="background: color-mix(in srgb, var(--mv-red) 10%, transparent); border:1px solid var(--syn-red); border-radius:8px; padding:8px 10px; font-size:11.5px; color: var(--syn-red); line-height:1.7;">${gtEsc(problem.message)}</div>` : ''}

        <div class="gt-accounts-list">
            ${list.map(a => gtRenderAccountRow(a, currentId)).join('') || `<div style="font-size:12px; color: var(--ide-text-dim); text-align:center; padding:12px 0;">هنوز حسابی اضافه نشده است.</div>`}
        </div>

        <button onclick="gtAddAccount()" style="background: var(--syn-blue); border:none; color:#fff; padding:10px; border-radius:9px; cursor:pointer; font-weight:700; font-size:13px;">افزودن حساب گیت‌هاب</button>
        <button onclick="gtRefreshQuota()" ${gtState.busy === 'quota' ? 'disabled' : ''} style="background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-main); padding:8px; border-radius:8px; cursor:pointer; font-size:12px;">${gtState.busy === 'quota' ? 'در حال بررسی…' : 'بررسی دوباره‌ی سهمیه‌ها'}</button>

        <!-- The two irreversible ones. They used to sit in the footer of the whole-screen
             views that the cards replaced; the pool is where they belong, and they are
             kept visually quiet because neither can be undone. -->
        <div style="border-top: var(--mv-hl) solid var(--mv-sep); padding-top:10px; display:flex; flex-direction:column; gap:8px;">
            <button onclick="gtDisconnectGithub()" style="background: transparent; border:none; color: var(--syn-red); cursor:pointer; font-size:11.5px; padding:2px;">قطع اتصال همه‌ی حساب‌ها</button>
            <button onclick="gtResetAll()" style="background: transparent; border:none; color: var(--syn-red); cursor:pointer; font-size:11.5px; padding:2px;">ریست کامل و شروع از اول</button>
            <div style="font-size:10.5px; color: var(--ide-text-dim); line-height:1.7;">
                «ریست کامل» اتصال گیت‌هاب، تنظیمات سرویس شبکه‌ی امن، کلیدها و همه‌ی نشست‌ها را پاک می‌کند.
                ریپازیتوری گیت‌هاب و سرویسی که روی کلادفلر دیپلوی شده حذف نمی‌شوند.
            </div>
        </div>

        ${anyEstimated ? `<div style="font-size:10.5px; color: var(--ide-text-dim); line-height:1.7; border-top:1px solid var(--ide-border); padding-top:8px;">
            بعضی حساب‌ها هنگام اتصال، اجازه‌ی خواندن سهمیه را ندادند و مصرفشان تخمینی نشان داده می‌شود.
            برای عدد دقیق، همان حساب را دوباره متصل کنید و همه‌ی دسترسی‌های خواسته‌شده را تأیید کنید.
        </div>` : ''}
    `);
}

function gtRenderProgress(gh, provisioning) {
    const state = provisioning ? provisioning.state : 'SETTING_UP';
    const order = ['SETTING_UP', 'STARTING', 'INSTALLING', 'CONNECTING_NETWORK', 'READY'];
    const labels = {
        SETTING_UP: 'اتصال گیت‌هاب برقرار شد',
        STARTING: 'زیرساخت ابری آماده شد',
        INSTALLING: 'در حال راه‌اندازی سرور ابری ویندوز',
        CONNECTING_NETWORK: 'در حال برقراری شبکه‌ی امن',
        READY: 'در حال ساخت کانفیگ',
    };
    const idx = Math.max(0, order.indexOf(state));

    // The stages themselves are the line above the cards (gtRenderFlow) — drawing them a
    // second time here was the same five rows twice on one screen. What this card is FOR is
    // the raw log: the only place that says what the runner is actually doing right now.
    const logLines = (provisioning && provisioning.log || []).slice(-6).map(l =>
        `<div style="color: var(--ide-text-dim); font-size: 11px; direction:ltr; text-align:left;">${gtEsc(l)}</div>`).join('');

    return gtCard(`
        <div style="font-size: 13.5px; font-weight: 700;">${gtEsc(labels[order[idx]] || 'در حال آماده‌سازی')}</div>
        <div style="font-size: 12px; color: var(--mv-label-2); line-height:1.9;">
            یک ماشین ویندوز روی سهمیهٔ حساب گیت‌هاب شما بالا می‌آید. این چند دقیقه طول می‌کشد و اگر پنجره را ببندید هم ادامه پیدا می‌کند.
        </div>
        ${logLines ? `<div style="display:flex; flex-direction:column; gap: 2px; border-top: var(--mv-hl) solid var(--mv-sep); padding-top: 8px; max-height: 110px; overflow-y:auto;">${logLines}</div>` : ''}`);
}

function gtRenderBrokerSetup(gh) {
    const accounts = gtLoadCfAccounts();

    if (accounts.length === 0) {
        return gtCard(`
            <div style="display:flex; flex-direction:column; gap: 10px;">
                <div style="font-size: 14px; font-weight: 700; color: var(--ide-text-main);">راه‌اندازی سرویس شبکه‌ی امن</div>
                <div style="background: color-mix(in srgb, var(--mv-blue) 10%, transparent); border: 1px solid var(--syn-blue); border-radius: 8px; padding: 10px; font-size: 12.5px; color: var(--ide-text-main); line-height:1.7;">
                    برای راه‌اندازی GitHub Tunnel، ابتدا باید یک حساب کلادفلر در بخش «زیرساخت ابری» متصل کنید.
                    نگران نباشید — مراحلی که تا الان طی کرده‌اید (اتصال گیت‌هاب) از دست نمی‌رود.
                </div>
                <button onclick="toggleLeftSidebar('cloud')" style="background: var(--syn-blue); border: none; color: #fff; padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600; font-size: 13px;">رفتن به زیرساخت ابری</button>
                <button onclick="gtRender(true)" style="background: transparent; border: 1px solid var(--ide-border); color: var(--ide-text-main); padding: 9px; border-radius: 8px; cursor: pointer; font-size: 12.5px;">بررسی دوباره</button>
                <button onclick="gtExitBrokerSetup()" style="background: transparent; border: none; color: var(--ide-text-dim); cursor: pointer; font-size: 11.5px; padding: 4px;">بازگشت</button>
            </div>`);
    }

    // Pre-filled from what was used last time, but plain editable inputs — the operator
    // may well need to rotate the client, and a locked field would force them out to the
    // console to do something the form is already the right place for.
    const b = gtState.broker || {};
    const options = accounts.map(a => `<option value="${gtEsc(a.id)}">${gtEsc(a.name)}</option>`).join('');
    const accountPicker = accounts.length > 1
        ? `<select id="gt-broker-account" style="background: var(--ide-bg); border: 1px solid var(--ide-border); color: var(--ide-text-main); border-radius: 8px; padding: 9px; font-size: 12.5px;">${options}</select>`
        : `<input type="hidden" id="gt-broker-account" value="${gtEsc(accounts[0].id)}" />
           <div style="font-size:12px; color: var(--ide-text-muted);">حساب: ${gtEsc(accounts[0].name)}</div>`;

    return gtCard(`
        <div style="font-size: 14px; font-weight: 700; color: var(--ide-text-main);">راه‌اندازی سرویس شبکه‌ی امن</div>
        <div style="font-size: 12px; color: var(--ide-text-muted); line-height:1.7;">این فقط یک‌بار انجام می‌شود و روی همان حساب کلادفلر شما نصب می‌شود. مقادیر زیر فقط به کلادفلر فرستاده می‌شوند و در MLMVPN ذخیره نمی‌گردند.</div>

        <style>#ls-github-tunnel summary::-webkit-details-marker { display: none; }</style>
        <details style="background: var(--ide-bg); border: 1px solid var(--ide-border); border-radius: 8px; padding: 10px 12px;">
            <summary style="font-size: 12.5px; font-weight: 700; color: var(--syn-blue); cursor: pointer; list-style: none; display:flex; align-items:center; justify-content:space-between;">
                <span>${b.tsClientId ? 'راهنما (در صورت نیاز به تغییر)' : 'راهنمای گرفتن این سه مقدار'}</span>
                <span style="font-size: 11px; color: var(--ide-text-dim); font-weight: 400;">نمایش/بستن</span>
            </summary>
            <ol style="margin: 10px 0 0; padding-right: 18px; display:flex; flex-direction:column; gap: 6px; font-size: 11.5px; color: var(--ide-text-muted); line-height: 1.7;">
                ${gtAclStepLi()}
                <li>وارد <a href="#" onclick="window.open('https://login.tailscale.com/admin/settings/oauth', '_blank'); return false;" style="color: var(--syn-blue); text-decoration: underline;">login.tailscale.com/admin/settings/oauth</a> شوید (اگر حساب Tailscale ندارید، همان‌جا رایگان بسازید).</li>
                <li>روی «Generate OAuth client» بزنید. در بخش Scopes فقط <span style="direction:ltr; display:inline-block; font-family:var(--mv-font-mono);">Devices: Write</span> را تیک بزنید، و در کادر tags که ظاهر می‌شود <span style="direction:ltr; display:inline-block; font-family:var(--mv-font-mono);">tag:mlmvpn-gt</span> را انتخاب کنید (اگر مرحله‌ی ۱ را انجام داده باشید، در همان لیست هست).</li>
                <li>مقدار «Client ID» و «Client Secret» که نمایش داده می‌شود را در دو فیلد اول پایین کپی کنید (Secret فقط یک‌بار نشان داده می‌شود).</li>
                <li>
                    برای «Tailnet»: بالای همان صفحه، منوی کشویی کوچکی کنار نام حسابتان هست (مثلاً <span style="direction:ltr; display:inline-block; font-family:var(--mv-font-mono);">you@gmail.com</span>) — دقیقاً همان متن را کپی کنید.
                    <div style="margin-top:4px; padding: 6px 8px; background: var(--ide-panel); border-radius: 6px; font-size: 11px; color: var(--ide-text-dim); direction:ltr; text-align:left;">
                        نمونه‌ها:<br>
                        اگر با گوگل وارد شدید → <span style="font-family:var(--mv-font-mono);">yourname@gmail.com</span><br>
                        اگر یک دامنه‌ی سازمانی وصل کردید → <span style="font-family:var(--mv-font-mono);">example.com</span><br>
                        اگر هیچ‌کدام معلوم نبود → <span style="font-family:var(--mv-font-mono);">-</span> (یک خط تیره؛ یعنی tailnet پیش‌فرض)
                    </div>
                </li>
            </ol>
        </details>

        ${accountPicker}
        <input id="gt-ts-id" type="text" value="${gtEsc(b.tsClientId || '')}" placeholder="Tailscale OAuth Client ID" style="background: var(--ide-bg); border: 1px solid var(--ide-border); color: var(--ide-text-main); border-radius: 8px; padding: 9px; font-size: 12.5px; direction:ltr;" />
        <input id="gt-ts-secret" type="password" value="${gtEsc(b.tsClientSecret || '')}" placeholder="Tailscale OAuth Client Secret" style="background: var(--ide-bg); border: 1px solid var(--ide-border); color: var(--ide-text-main); border-radius: 8px; padding: 9px; font-size: 12.5px; direction:ltr;" />
        <input id="gt-ts-tailnet" type="text" value="${gtEsc(b.tsTailnet || '')}" placeholder="Tailnet (مثلاً example.com)" style="background: var(--ide-bg); border: 1px solid var(--ide-border); color: var(--ide-text-main); border-radius: 8px; padding: 9px; font-size: 12.5px; direction:ltr;" />
        <div style="font-size: 11px; color: var(--ide-text-dim);">این سه مقدار را فقط همین یک بار وارد می‌کنید؛ بعد از راه‌اندازی، دیگر هرگز این فرم را نمی‌بینید.</div>

        <div style="border-top:1px solid var(--ide-border); padding-top:10px; display:flex; flex-direction:column; gap:8px;">
            <div style="font-size:12px; font-weight:700; color: var(--ide-text-main);">دامنه‌ی اختصاصی (اختیاری)</div>
            <div style="font-size:11px; color: var(--ide-text-dim); line-height:1.7;">
                آدرس پیش‌فرض روی <span style="direction:ltr; display:inline-block; font-family:var(--mv-font-mono);">workers.dev</span> است که یک دامنه‌ی مشترک و شناخته‌شده است و ممکن است یک‌جا فیلتر شود.
                اگر دامنه‌ای در همین حساب کلادفلر دارید، در داشبورد یک Route به این سرویس بدهید و آدرسش را اینجا بگذارید.
            </div>
            <input id="gt-broker-url" type="text" value="${gtEsc((gtState.broker && gtState.broker.customUrl) || '')}" placeholder="https://broker.yourdomain.com" style="background: var(--ide-bg); border: 1px solid var(--ide-border); color: var(--ide-text-main); border-radius: 8px; padding: 9px; font-size: 12.5px; direction:ltr;" />
            <button onclick="gtSaveBrokerUrl()" style="background: transparent; border: 1px solid var(--ide-border); color: var(--ide-text-main); padding: 8px; border-radius: 8px; cursor: pointer; font-size: 12px;">ذخیره‌ی آدرس</button>
            ${gtState.broker && gtState.broker.effectiveUrl ? `<div style="font-size:10.5px; color: var(--ide-text-dim); direction:ltr; text-align:left;">در حال استفاده: ${gtEsc(gtState.broker.effectiveUrl)}</div>` : ''}
        </div>
        ${gtState.brokerError ? `<div style="color: var(--syn-red); font-size: 11.5px;">${gtEsc(gtState.brokerError)}</div>` : ''}
        <button onclick="gtDeployBroker()" ${gtState.brokerDeploying ? 'disabled' : ''} style="background: var(--syn-blue); border: none; color: #fff; padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 13px; display:flex; align-items:center; justify-content:center; gap:8px;">
            ${gtState.brokerDeploying ? gtSpinner() + ' در حال راه‌اندازی…' : 'به‌روزرسانی و ادامه'}
        </button>
        <button onclick="gtExitBrokerSetup()" style="background: transparent; border: none; color: var(--ide-text-dim); cursor: pointer; font-size: 11.5px; padding: 4px;">بازگشت</button>
    `);
}

// The ACL edit is the one setup step MLMVPN cannot do on the user's behalf: Tailscale will
// not mint a key for a tag its own policy file has never heard of. It must therefore be
// sayable in two different places — inside the relay guide, and again on its own when the
// failure happens later — so it lives in one place and is rendered into both.
const GT_ACL_TEXT = `"tagOwners": {
  "tag:mlmvpn-gt": ["autogroup:admin"],
},
"autoApprovers": {
  "exitNode": ["tag:mlmvpn-gt"],
},`;

function gtAclBlock() {
    return `
        به <a href="#" onclick="gtOpenVerificationUrl('https://login.tailscale.com/admin/acls/file'); return false;" style="color: var(--syn-blue); text-decoration: underline;">صفحه‌ی Access Controls</a>
        بروید و این دو بلوک را داخل فایل (بین همان آکولادهای بیرونی، کنار بقیه‌ی بخش‌ها) اضافه کنید، بعد <b>Save</b> بزنید:
        <div style="margin-top:6px; background: var(--ide-panel); border-radius:6px; padding:8px; font-size:10.5px; direction:ltr; text-align:left; font-family:var(--mv-font-mono); white-space:pre; overflow-x:auto; color: var(--ide-text-main);">${gtEsc(GT_ACL_TEXT)}</div>
        <button onclick="gtCopyAcl()" style="margin-top:6px; background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-muted); padding:5px 10px; border-radius:6px; cursor:pointer; font-size:11px;">کپی این متن</button>`;
}

function gtAclStepLi() {
    return `<li style="border-bottom:1px solid var(--ide-border); padding-bottom:8px; margin-bottom:4px;">
        <b style="color: var(--syn-yellow);">اول این را انجام دهید</b> — تگ باید قبل از ساخت OAuth client وجود داشته باشد، وگرنه در مرحله‌ی بعد نمی‌توانید انتخابش کنید.<br>
        ${gtAclBlock()}
    </li>`;
}

/** Shown when Tailscale itself rejected the tag. Nothing else in the app can fix this, so
 *  the panel stops and says exactly which edit is missing rather than reporting a 400. */
function gtRenderAclFix(provisioning) {
    return gtCard(`
        <div style="font-size: 14px; font-weight: 700; color: var(--ide-text-main);">یک مرحله باقی مانده است</div>
        <div style="background: color-mix(in srgb, var(--mv-orange) 12%, transparent); border: 1px solid var(--syn-yellow); border-radius: 8px; padding: 10px 12px; font-size: 12.5px; color: var(--ide-text-main); line-height:1.8;">
            حساب Tailscale شما هنوز تگ دسترسی <span style="direction:ltr; display:inline-block; font-family:var(--mv-font-mono);">tag:mlmvpn-gt</span> را نمی‌شناسد،
            برای همین اجازه‌ی ساخت کلید را نداد. این تنها کاری است که MLMVPN نمی‌تواند به‌جای شما انجام دهد — یک‌بار انجامش دهید و دیگر لازم نیست تکرارش کنید.
        </div>
        <div style="font-size: 12px; color: var(--ide-text-muted); line-height:1.8;">${gtAclBlock()}</div>
        <div style="font-size: 11.5px; color: var(--ide-text-dim); line-height:1.7;">
            اگر هنگام ساخت OAuth client هم تگی انتخاب نکرده بودید، بعد از Save کردن ACL یک‌بار به بخش
            «تنظیمات سرویس شبکه‌ی امن» بروید و client را با انتخاب همین تگ دوباره بسازید.
        </div>
        <button onclick="gtBeginSetup()" style="background: var(--syn-blue); border: none; color: #fff; padding: 11px; border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 13px;">انجام دادم — تلاش دوباره</button>
        <button onclick="gtForceBrokerSetup()" style="background: transparent; border: 1px solid var(--ide-border); color: var(--ide-text-main); padding: 9px; border-radius: 8px; cursor: pointer; font-size: 12px;">تنظیمات سرویس شبکه‌ی امن</button>
        ${provisioning && provisioning.error ? `<div style="color: var(--ide-text-dim); font-size: 10.5px; direction:ltr; text-align:left; background: var(--ide-bg); border-radius:6px; padding:6px 8px;">${gtEsc(provisioning.error)}</div>` : ''}`);
}

function gtRenderFailed(gh, provisioning) {
    return gtCard(`
        <div style="text-align:center; display:flex; flex-direction:column; gap: 10px;">
            <div style="color: var(--syn-red); font-size: 13px; font-weight: 600;">نتوانستیم تونل ابری شما را راه‌اندازی کنیم.</div>
            ${provisioning && provisioning.error ? `<div style="color: var(--ide-text-dim); font-size: 11px; direction:ltr; text-align:left; background: var(--ide-bg); border-radius:6px; padding:6px 8px;">${gtEsc(provisioning.error)}</div>` : ''}
            <button onclick="gtBeginSetup()" style="background: var(--syn-blue); border: none; color: #fff; padding: 10px; border-radius: 8px; cursor: pointer; font-weight: 600;">تلاش دوباره</button>
            <button onclick="gtForceBrokerSetup()" style="background: transparent; border: 1px solid var(--ide-border); color: var(--ide-text-main); padding: 9px; border-radius: 8px; cursor: pointer; font-size: 12px;">به‌روزرسانی سرویس شبکه‌ی امن</button>
            <button onclick="gtResetAll()" style="background: transparent; border: none; color: var(--syn-red); padding: 6px; cursor: pointer; font-size: 11.5px;">ریست کامل و شروع از اول</button>
        </div>`);
}

/**
 * `busyThis` turns the knob itself into a spinner rather than adding one elsewhere.
 *
 * Bringing the tunnel up takes tens of seconds — the daemon restarts, a key is minted, the
 * adapter comes up, traffic is verified. Until now the switch only went dim, which looks
 * exactly like "disabled, you cannot use this", so the click read as having done nothing.
 * The knob is the part the eye follows when a switch is pressed, so the knob is what moves.
 */
function gtSwitch(label, hint, on, disabled, onclick, busyThis) {
    return `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px; padding: 9px 0;">
            <div style="min-width:0;">
                <div style="font-size: 12.5px; color: ${disabled ? 'var(--ide-text-dim)' : 'var(--ide-text-main)'};">${gtEsc(label)}</div>
                <div style="font-size: 10.5px; color: var(--ide-text-dim); line-height:1.5;">${gtEsc(hint)}</div>
            </div>
            <button ${disabled ? 'disabled' : ''} onclick="${onclick}"
                style="flex:none; width:44px; height:24px; border-radius:12px; border:1px solid ${on ? 'var(--syn-blue)' : 'var(--ide-border)'};
                       background:${on ? 'var(--syn-blue)' : 'var(--ide-bg)'}; position:relative; cursor:${disabled ? 'not-allowed' : 'pointer'};
                       opacity:${disabled ? '.45' : '1'}; transition: background .18s, border-color .18s;">
                <span style="position:absolute; top:2px; ${on ? 'right:2px' : 'left:2px'}; width:18px; height:18px; border-radius:50%;
                             ${busyThis
                                ? 'border:2px solid rgba(255,255,255,.3); border-top-color:#fff; background:transparent; box-sizing:border-box; animation: gt-spin .7s linear infinite;'
                                : 'background:' + (on ? '#fff' : 'var(--ide-text-dim)') + ';'}
                             transition: left .18s, right .18s;"></span>
                ${busyThis ? '<style>@keyframes gt-spin { to { transform: rotate(360deg); } }</style>' : ''}
            </button>
        </div>`;
}

/** The engine + the two independent traffic switches — same model as the Aether panel:
 *  connecting only brings the engine up; what actually uses it is chosen separately. */
function gtRenderEngineControls() {
    const st = gtState.engine;
    if (!st) return `<div style="font-size:11.5px; color: var(--ide-text-dim); text-align:center; padding:8px 0;">در حال بررسی وضعیت اتصال…</div>`;

    const eng = st.engine || {};
    const connected = !!eng.connected;
    const tunOn = connected && eng.mode === 'tun';
    const proxyOn = connected && eng.mode === 'proxy';
    const ks = st.killSwitch || {};
    const ksOn = !!ks.enabled;
    const ksEngaged = !!ks.engaged;
    // Proxy mode has no tunnel adapter, so the firewall allow-list the guard is built from
    // cannot exist and the guard is never engaged there. The switch used to render "on"
    // anyway — telling someone they were protected while nothing at all was blocking a
    // leak, on the one mode that already leaks every packet no proxy-aware app sends.
    const ksApplicable = ks.applicable !== false;
    // Server-side: a transition is in flight no matter which window started it.
    const busy = gtState.busy || (st.busy ? 'server' : '');

    const statusLine = connected
        ? `<div style="display:flex; align-items:center; justify-content:space-between; font-size:11.5px; padding-bottom:2px;">
               <span style="color: var(--syn-green);">&#9679; ${tunOn ? 'تونل کامل فعال' : 'پراکسی فعال'}</span>
               <span style="color: ${tunOn ? 'var(--syn-green)' : 'var(--syn-yellow)'};">${tunOn ? 'UDP فعال — مناسب بازی' : 'فقط TCP — بازی پشتیبانی نمی‌شود'}</span>
           </div>`
        : '';

    // The engine reports WHY it is down, and until now nothing showed it: the switch simply
    // flipped itself off. To the user that is "it disconnected in the middle of my work" with
    // no cause and nothing to act on, which is the single worst state this panel can be in.
    const GT_ERRORS = {
        EXIT_NODE_NOT_APPROVED: 'نشست ابری به‌عنوان خروجی تأیید نشده — بخش autoApprovers را در تنظیمات دسترسی (ACL) اضافه کنید.',
        NOT_RUNNING: 'موتور اتصال از شبکه خارج شد. اینترنت شما قطع شده یا نشست ابری پایان یافته است.',
        NO_STATUS: 'وضعیت موتور اتصال خوانده نشد.',
        NO_EGRESS: 'تونل برقرار است ولی داده‌ای از آن عبور نمی‌کند.',
        REPAIR_GAVE_UP: 'بازیابی خودکار چند بار تلاش کرد و موفق نشد. اگر محافظ نشت روشن است، اینترنت شما تا قطع اتصال مسدود می‌ماند — «قطع اتصال» را بزنید و دوباره وصل شوید؛ اگر باز هم تکرار شد، «تمدید» بزنید.',
        SESSION_ENDED: 'نشست ابری پایان یافت و اتصال به‌طور خودکار بسته شد. از این لحظه ترافیک شما مستقیم و با آی‌پی واقعی خارج می‌شود — برای ادامه «تمدید» بزنید.',
    };
    const errLine = (!connected && eng.error)
        ? `<div style="background: color-mix(in srgb, var(--mv-red) 10%, transparent); border:1px solid var(--syn-red); border-radius:8px; padding:8px 10px; font-size:11.5px; color: var(--syn-red); line-height:1.7;">
               ${gtEsc(GT_ERRORS[eng.error] || eng.error)}
           </div>`
        : '';

    // Shown whenever there is something to tear down — NOT only when connected. After the
    // watchdog gives up, `connected` is false while the kill-switch is still blocking the
    // machine's traffic; hiding the button there strands the user with no internet and no
    // control that obviously restores it.
    const needsTeardown = connected || ksEngaged || !!eng.running;
    const disconnectBtn = needsTeardown
        ? `<button onclick="gtDisconnectEngine()" ${busy ? 'disabled' : ''} style="width:100%; background: transparent; border: 1px solid var(--syn-red); color: var(--syn-red); padding: 10px; border-radius: 10px; cursor: pointer; font-weight: 700; font-size: 12.5px;">${busy ? 'لطفاً صبر کنید…' : 'قطع اتصال'}</button>`
        : '';

    return `
        <div style="display:flex; flex-direction:column; gap:4px;">
            ${statusLine}
            ${errLine}
            ${gtSwitch('حالت تونل کامل (پیشنهادی)', 'تمام ترافیک، با UDP — بازی و تماس تصویری کار می‌کند. کمترین پینگ.',
                tunOn, !!busy, `gtToggleTun(${!tunOn})`, busy === 'tun')}
            ${gtSwitch('پراکسی سیستم', 'فقط مرورگر و برنامه‌های پراکسی‌پذیر. بدون UDP، ولی روی اینترنت‌های سخت‌گیر بهتر جواب می‌دهد.',
                proxyOn, !!busy, `gtToggleProxy(${!proxyOn})`, busy === 'proxy')}
            ${gtSwitch('محافظ نشت (Kill-Switch)',
                !ksApplicable
                    ? 'در حالت پراکسی کار نمی‌کند — محافظ به آداپتور تونل کامل نیاز دارد. در این حالت ترافیک برنامه‌هایی که از پراکسی استفاده نمی‌کنند بدون تونل خارج می‌شود.'
                    : (ksEngaged
                        ? 'فعال — اگر تونل قطع شود، هیچ ترافیکی با آی‌پی واقعی خارج نمی‌شود.'
                        : 'اگر تونل قطع شود، اینترنت تا وصل شدن دوباره مسدود می‌ماند.'),
                ksOn && ksApplicable, !!busy, `gtToggleKillSwitch(${!ksOn})`, busy === 'ks')}
            <button onclick="gtRunSpeedtest()" ${busy ? 'disabled' : ''} style="width:100%; background: transparent; border: 1px solid var(--ide-border); color: var(--ide-text-main); padding: 9px; border-radius: 10px; cursor: pointer; font-size: 12px; margin-top:2px;">${busy === 'speed' ? 'در حال اندازه‌گیری…' : (connected ? 'تست سرعت و کیفیت مسیر' : 'تست سرعت خط (بدون تونل)')}</button>
            ${disconnectBtn}
            ${gtRenderEndSessionButton()}
        </div>`;
}

/**
 * The control that actually stops the meter.
 *
 * Disconnecting only takes the tunnel down on this machine; the cloud session keeps running
 * to its own limit and keeps spending the GitHub account's monthly minutes the entire time.
 * Someone who needed an hour and walked away pays for the remaining hours either way unless
 * they press this. It is kept visually quieter than "قطع اتصال" and asks for confirmation,
 * because it is the irreversible one: ending frees the allowance but the next use has to
 * provision a fresh machine from scratch.
 */
function gtRenderEndSessionButton() {
    const session = gtState.status && gtState.status.session;
    if (!session || !['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(session.status)) return '';
    const busy = gtState.busy || '';
    return `
        <button onclick="gtEndSession()" ${busy ? 'disabled' : ''}
            style="width:100%; background: transparent; border: 1px dashed var(--ide-border); color: var(--ide-text-muted); padding: 9px; border-radius: 10px; cursor: pointer; font-size: 11.5px; margin-top:2px;">
            ${busy === 'end' ? 'در حال پایان دادن…' : 'پایان نشست و ذخیره‌ی سهمیه'}
        </button>
        <div style="font-size:10px; color: var(--ide-text-dim); line-height:1.6;">
            «قطع اتصال» فقط تونل را روی این کامپیوتر می‌بندد و نشست ابری تا پایان وقتش سهمیه مصرف می‌کند.
            اگر تا مدتی به تونل نیاز ندارید، این دکمه را بزنید تا مصرف همین حالا متوقف شود.
        </div>`;
}

async function gtEndSession() {
    const ok = await uiConfirm({
        title: 'نشست ابری پایان یابد؟',
        message: 'مصرف سهمیه‌ی گیت‌هاب از همین لحظه متوقف می‌شود. برای استفاده‌ی بعدی یک نشست تازه ساخته می‌شود که چند دقیقه راه‌اندازی می‌خواهد.',
        confirmLabel: 'پایان نشست',
        cancelLabel: 'ادامه‌ی نشست',
    });
    if (!ok) return;
    gtState.busy = 'end';
    gtRender(true);
    try {
        await gtFetch('/api/github-tunnel/session/end', { method: 'POST' });
        gtToast('نشست پایان یافت — مصرف دقیقه‌ها متوقف شد.');
    } catch (e) {
        gtToast(e.message || 'پایان نشست ناموفق بود.');
    } finally {
        gtState.busy = '';
        await gtRefreshStatus();
        await gtRefreshEngine();
        gtRender(true);
    }
}

function gtRenderSpeedResults() {
    const s = gtState.speed;
    if (!s || !s.results) return '';
    const color = { PASS: 'var(--syn-green)', WARN: 'var(--syn-yellow)', FAIL: 'var(--syn-red)' };
    const icon = { PASS: '&#10003;', WARN: '!', FAIL: '&#10007;' };
    const rows = s.results.map(r => `
        <div style="padding:5px 0; border-bottom:1px solid var(--ide-border);">
            <div style="display:flex; justify-content:space-between; gap:8px; font-size:11.5px;">
                <span style="color: var(--ide-text-muted);">${gtEsc(r.name)}</span>
                <span style="color:${color[r.verdict]}; white-space:nowrap;">${icon[r.verdict]} ${gtEsc(r.detail)}</span>
            </div>
            ${r.hint ? `<div style="font-size:10.5px; color: var(--ide-text-dim); line-height:1.6; margin-top:2px;">${gtEsc(r.hint)}</div>` : ''}
        </div>`).join('');
    return `
        <div style="background: var(--ide-bg); border:1px solid var(--ide-border); border-radius:8px; padding:8px 10px; margin-top:4px;">
            ${rows}
            <button onclick="gtCopySpeedResults()" style="width:100%; margin-top:8px; background: transparent; border:1px solid var(--ide-border); color: var(--ide-text-muted); padding:7px; border-radius:7px; cursor:pointer; font-size:11.5px;">کپی نتیجه</button>
        </div>`;
}

/** Plain-text dump of the last run, so the result can be pasted into a report. */
function gtCopySpeedResults() {
    const s = gtState.speed;
    if (!s || !s.results) return;
    const lines = [
        `GitHub Tunnel — path/speed report`,
        `overall: ${s.summary}   path: ${s.pathKind}${s.pingMs != null ? `   ping: ${s.pingMs}ms` : ''}`,
        '',
        ...s.results.map(r => `[${r.verdict}] ${r.name}: ${r.detail}${r.hint ? `\n        ↳ ${r.hint}` : ''}`),
    ];
    const text = lines.join('\n');
    try {
        navigator.clipboard.writeText(text);
        gtToast('نتیجه کپی شد.');
    } catch (e) {
        // Clipboard API can be refused depending on focus; a selectable prompt still
        // lets the text be copied by hand rather than losing it.
        window.prompt('کپی کنید:', text);
    }
}

// ── init ─────────────────────────────────────────────────────────────────────────

function initGithubTunnelModule() {
    const container = document.getElementById('ls-github-tunnel');
    if (!container) return;
    if (container.parentElement) {
        container.parentElement.style.position = 'relative';
        container.parentElement.style.padding = '0';
        container.parentElement.style.overflow = 'hidden';
    }
    // The pane does the scrolling now, not this box — and no z-index of its own: a
    // positioned panel with one covers the window's title bar and takes the traffic
    // lights with it.
    container.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent;';

    gtRender();
    gtRefreshAccounts().then(() => gtRefreshGithub()).then(() => {
        const gh = gtState.githubStatus;
        if (gh && gh.pending && gh.pending.state === 'waiting') { gtState.connecting = true; gtStartGithubPoll(); }
        if (gtHasAccounts()) { gtRefreshStatus(); gtRefreshBroker(); gtRefreshEngine(); gtStartStatusPoll(false); }
    });

    // تیک محلی هر ۱ ثانیه بین دو رفرش سرور، تا شمارش معکوس ثابت به نظر نرسد.
    setInterval(() => {
        const el = document.getElementById('ls-github-tunnel');
        if (!el || el.style.display === 'none') return;
        const cd = document.getElementById('gt-countdown');
        const session = gtState.status && gtState.status.session;
        if (!cd || !session || !session.remainingMs) return;
        session.remainingMs = Math.max(0, session.remainingMs - 1000);
        cd.textContent = gtFmtCountdown(session.remainingMs);
    }, 1000);
}
