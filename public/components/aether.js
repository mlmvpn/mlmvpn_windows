// --- WARP engines: ماسک (MASQUE), وایرگارد (WireGuard), وارپ در وارپ ---
// Three engines on one core, each a product of its own as on Android (HomeDestinations.kt):
// its own icon, its own page. On the desktop each page is a window of its own (shell/apps.js);
// in the old layout the three are tabs of the #ls-aether panel. Only one engine runs at a time,
// so every page shows that state, and a page whose engine is not the running one offers to
// stop the running one first. Talks to /api/aether/* on the local server; live progress arrives
// over the websocket as `aether_status`, and every engine log line lands in the shared core-log
// panel via `core_log`.

// Each protocol has a genuinely different startup sequence, so each gets its own step list.
const AETHER_STEPS = {
    // «وارپ» has its own engine (warp-manager.js) and these are ITS four stages, not aether's.
    // It does look for a server — the old note here said it did not, from when «وارپ» was a
    // pinned endpoint, and a fixed endpoint was measured to be exactly why it never connected.
    warp: [
        { key: 'identity', fa: 'هویت' },
        { key: 'scan', fa: 'یافتن سرور' },
        { key: 'validate', fa: 'آزمایش عبور داده' },
        { key: 'connected', fa: 'اتصال' },
    ],
    masque: [
        { key: 'identity', fa: 'هویت' },
        { key: 'quickcheck', fa: 'بررسی سرور قبلی' },
        { key: 'scan', fa: 'اسکن گیت‌وی' },
        { key: 'selected', fa: 'انتخاب سرور' },
        { key: 'tunnel', fa: 'برقراری تونل' },
        { key: 'validate', fa: 'اعتبارسنجی عبور داده' },
        { key: 'connected', fa: 'اتصال' },
    ],
    wg: [
        { key: 'identity', fa: 'هویت' },
        { key: 'quickcheck', fa: 'بررسی سرور قبلی' },
        { key: 'scan', fa: 'اسکن اندپوینت' },
        { key: 'selected', fa: 'انتخاب سرور' },
        { key: 'handshake', fa: 'دست‌دادن' },
        { key: 'connected', fa: 'اتصال' },
    ],
    gool: [
        { key: 'identity', fa: 'هویت دوگانه' },
        { key: 'scan', fa: 'اسکن اندپوینت' },
        { key: 'selected', fa: 'انتخاب سرور' },
        { key: 'handshake', fa: 'تونل بیرونی + داخلی' },
        { key: 'connected', fa: 'اتصال' },
    ],
};

// 'provision' is an alias of 'identity' for progress purposes.
const AETHER_STAGE_ALIAS = { provision: 'identity', reconnecting: 'tunnel', failed: null, crashed: null };
// «وارپ»'s own engine reports its own stage names (warp-manager.js). Mapping them onto its four
// steps is what makes the strip move; without it every stage was unknown and nothing lit up.
const WARP_STAGE_ALIAS = {
    starting: 'identity', identity: 'identity',
    scan: 'scan', connecting: 'validate', validate: 'validate',
    reconnecting: 'scan', connected: 'connected', failed: null, idle: null,
};

// Names, glyphs and tints — the same as the Android app's home icons.
const AE_ENGINES = {
    masque: {
        name: 'ماسک',
        tint: 'var(--mv-blue)',
        glyph: '<path fill="currentColor" d="M13.4 2.2 4.6 13.6h6.6l-1.5 8.2 9.7-12h-6.8z"/>',
        blurb: 'ترافیک را داخل <b>HTTPS معمولی</b> پنهان می‌کند؛ بهترین گزینه برای شبکه‌های با DPI شدید.',
    },
    wg: {
        name: 'وایرگارد',
        tint: 'var(--mv-green)',
        glyph: '<path fill="currentColor" d="M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/>',
        blurb: 'سبک و سریع؛ مناسب شبکه‌هایی که بازرسی کمتر تهاجمی دارند.',
    },
    warp: {
        name: 'وارپ',
        tint: 'var(--mv-teal)',
        glyph: '<path fill="currentColor" d="M7 18.5A4.5 4.5 0 0 1 6.3 9.55A6 6 0 0 1 17.7 8.3A5.2 5.2 0 0 1 17.4 18.5Z"/>',
        blurb: 'همان کاری که برنامهٔ رسمی کلادفلر می‌کند: WireGuard <b>خالی</b> — بدون هیچ مبهم‌سازی — فقط به اندپوینت‌های رسمی خودِ کلادفلر. اول همان اندپوینتی که کلادفلر به این دستگاه داده، و اگر جواب نداد اولین اندپوینت رسمیِ سالم. ساده‌ترین و سریع‌ترین راه بالا آمدن.',
    },
    gool: {
        name: 'وارپ در وارپ',
        tint: 'var(--mv-orange)',
        glyph: '<path fill="currentColor" d="M12 3.5 3.5 8 12 12.5 20.5 8z"/><path d="m3.5 12 8.5 4.5 8.5-4.5M3.5 16l8.5 4.5 8.5-4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        blurb: 'یک تونل WireGuard <b>داخل</b> تونل WireGuard دیگر — یک لایه رمزنگاری اضافه؛ کندتر، ولی در برابر تحلیل ترافیک مقاوم‌تر.',
    },
};
const AE_PROTOCOLS = ['warp', 'masque', 'wg', 'gool'];

/**
 * «وارپ» IS ITS OWN ENGINE (warp-manager.js), not a protocol of the aether one.
 *
 * It was always meant to be: it never existed in aether, it was added here, and the point of it
 * is to keep working when aether does not — which on 2026-09-20 was not hypothetical, with
 * aether's MASQUE refused by all 349 gateways it tried.
 *
 * So the page talks to `/api/warp/*`, which shares nothing with `/api/aether/*`: its own
 * Cloudflare registration, its own SOCKS port (20870), its own logs, lifecycle and watchdog, and
 * its own definition of «connected» — a real HTTPS request through the finished tunnel.
 */
window.warpState = { running: false, connected: false, stage: 'idle', stageFa: 'خاموش' };

function aeIsOwnEngine(protocol) { return protocol === 'warp'; }

/** The state the page should read for `protocol`. */
function aeStateOf(protocol) { return aeIsOwnEngine(protocol) ? window.warpState : aetherState; }

// The three are three apps on the desk (shell/apps.js) — the sidebar's icon is asked of that
// registry, so the window wears the same drawing as the home screen and the dock.
const AE_APP_OF = { warp: 'warp', masque: 'masque', wg: 'wireguard', gool: 'warp_on_warp' };

let aetherActiveTab = 'masque';   // the engine last looked at: the old layout's tab, or the last window shown
let aetherState = { running: false, connected: false, stage: 'idle', stageFa: 'خاموش' };
let aetherInstalled = true;

function aePage(p) { return document.getElementById('ae-page-' + p); }
function aeName(p) { return (AE_ENGINES[p] && AE_ENGINES[p].name) || 'موتور'; }

// ============================================================
// Markup — the engine page (ui/page-kit.css › .mv-split + .mv-eng-*)
// ============================================================
// The same page سایفون/تور/لنترن/گف wear (components/fronts.js): a glass sidebar of sections, a
// hero built around ONE round button with the live traffic beside it, and every choice as a card
// whose header opens the section that explains it in full.
//
// The controls themselves keep their ids («aether-<protocol>-<key>»), because collectAetherOptions
// reads the page by id when the user presses connect. The cards are a second view of the same
// controls, never a second copy of the state: a card writes into the real <select> and lets it
// fire `change`, so one answer is saved and one answer is sent.

// One line each, for the hero of an engine that is not doing anything yet.
const AE_HEADLINE = {
    masque: 'ترافیک، به شکل یک HTTPS معمولی.',
    wg: 'سبک و سریع، روی وارپ کلادفلر.',
    gool: 'یک تونل، داخل یک تونل دیگر.',
};

// Short names for the cards. The <select>s keep the long sentences — a card has room for a name
// and one line, and the section is one click away.
const AE_SCAN_MODES = [
    { v: 'turbo', t: 'توربو', h: 'با اولین سرور سالم وصل شو — سریع‌ترین، کیفیت شانسی' },
    { v: 'balanced', t: 'متعادل', h: 'تا ۶ سرور پیدا کن و بهترین را بردار (پیشنهادی)' },
    { v: 'thorough', t: 'کامل', h: 'کندتر، بهترین پینگ' },
    { v: 'stealth', t: 'مخفی', h: 'آرام و بی‌سروصدا' },
    { v: 'ironclad', t: 'مطمئن', h: 'برای هر سرور یک تونل واقعی می‌سازد و تست می‌کند' },
];
const AE_NOIZE_MODES = [
    { v: 'balanced', t: 'متعادل', h: 'پیش‌فرض — بسته‌های جعلی، به اندازه' },
    { v: 'off', t: 'خاموش', h: 'بدون بستهٔ اضافه؛ سریع‌ترین' },
    { v: 'light', t: 'سبک', h: 'کمترین سربار' },
    { v: 'aggressive', t: 'تهاجمی', h: 'برای شبکه‌های سخت‌گیر (GFW)' },
];
const AE_TRANSPORTS = [
    { v: 'h3', t: 'HTTP/3 (QUIC)', h: 'سریع‌ترین — روی UDP' },
    { v: 'h2', t: 'HTTP/2 (TCP)', h: 'وقتی اینترنت‌تان UDP را بسته است' },
];

function aeTuneTitle(p) {
    if (p === 'warp') return 'مبهم‌سازی و پایداری';
    return p === 'masque' ? 'ترنسپورت و مبهم‌سازی' : p === 'wg' ? 'مبهم‌سازی و پایداری' : 'تونل بیرونی';
}

/** What the page recorded when it started the engine — see switchAetherTab's start path. */
// NOT window.aeStartedAs for the value: a top-level `function` declaration in a classic script
// IS a window property, so writing the protocol to that name overwrote this function and every
// status message after the first start died with «aeStartedAs is not a function».
function aeStartedAs() {
    if (window.aeStartedProto) return window.aeStartedProto;
    try { return PersistentStorage.getItem('aether_started_as'); } catch (e) { return null; }
}

/**
 * Is the engine that is running this page's engine?
 *
 * NOT `aeIsMine(p)`. «وارپ» and «وایرگارد» are both `wg` to the engine, so the
 * reported protocol cannot separate them; only which page started it can.
 */
/** Which PAGE owns the running session — for messages that name it. */
function aeRunningPage() {
    if (!aetherState || !aetherState.protocol) return null;
    return AE_PROTOCOLS.find(aeIsMine) || aetherState.protocol;
}

function aeIsMine(p) {
    // Bare `aetherState`, not window.aetherState: it is declared with `let` at the top of this
    // file, which puts it in the shared global LEXICAL scope and never on `window`. Reading it
    // through window returns undefined, and this function would then tell every page that
    // nothing is running.
    if (!aetherState || !aetherState.protocol) return false;
    const running = aetherState.protocol;
    const started = aeStartedAs();
    if (p === 'warp') return running === 'wg' && started === 'warp';
    if (p === 'wg') return running === 'wg' && started !== 'warp';
    return running === p;
}

/** The sidebar's sections — only what this engine really has. */
function aeSections(p) {
    return [
        { id: 'connect', label: 'اتصال', icon: 'ph-fill ph-power', tint: 'var(--mv-green)' },
        { id: 'route', label: 'مسیر ترافیک', icon: 'ph-fill ph-arrows-split', tint: 'var(--mv-orange)' },
        { id: 'scan', label: 'جست‌وجوی سرور', icon: 'ph-fill ph-radar', tint: 'var(--mv-blue)' },
        { id: 'tune', label: aeTuneTitle(p), icon: 'ph-fill ph-sliders', tint: 'var(--mv-indigo)' },
        { id: 'adv', label: 'پیشرفته', icon: 'ph-fill ph-gear-six', tint: 'var(--mv-gray)' },
        { id: 'identity', label: 'هویت', icon: 'ph-fill ph-identification-card', tint: 'var(--mv-pink, #FF2D55)' },
    ];
}

// Where the machine's traffic goes. LIVE STATE, not a saved setting — and the one thing on this
// page that decides whether a connected engine protects anything at all.
function aeRouteSection(p) {
    return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">مسیر ترافیک</div>
        <div class="mv-form-group">
          <label class="mv-form-row">
            <span class="mv-form-label">پراکسی سیستم<small class="ae-sysproxy-label">…</small></span>
            <input type="checkbox" class="mv-switch-input ae-sysproxy-toggle" onchange="toggleSystemProxy(this.checked)" />
          </label>
          <label class="mv-form-row ae-tun-box">
            <span class="mv-form-label">تونل کامل <span class="ae-tgl-badge">بدون نشتی</span><small class="ae-tun-label">…</small></span>
            <input type="checkbox" class="mv-switch-input ae-tun-toggle" onchange="toggleTun(this.checked)" />
          </label>
        </div>
        <p class="mv-form-footer">بدون یکی از این دو، موتور وصل می‌شود ولی هیچ ترافیکی از آن رد نمی‌شود — هر بسته با آی‌پی واقعی شما بیرون می‌رود. «تونل کامل» همه چیز را می‌برد (UDP و QUIC و DNS هم)، «پراکسی سیستم» فقط برنامه‌هایی را که از تنظیم ویندوز پیروی می‌کنند. هر دو با هم ممکن نیست؛ روشن کردن یکی دیگری را خاموش می‌کند.</p>
      </div>`;
}

// How a server is found. Every engine has the same search.
function aeScanSection(p) {
    return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">جست‌وجوی سرور</div>
        <div class="mv-form-group">
          <div class="mv-form-row">
            <div class="mv-form-label">حالت اسکن</div>
            <select id="aether-${p}-scan" class="mv-popup">
              <option value="turbo">توربو — با اولین سرور سالم وصل شو (سریع‌ترین اتصال، کیفیت شانسی)</option>
              <option value="balanced" selected>متعادل — تا ۶ سرور پیدا کن و بهترین را بردار؛ ۱۲ ثانیه بی‌سرورِ تازه، وصل شو (پیشنهادی)</option>
              <option value="thorough">کامل — کندتر، بهترین پینگ</option>
              <option value="stealth">مخفی — آرام و بی‌سروصدا</option>
              <option value="ironclad">مطمئن — تست واقعی تونل و HTTP برای هر سرور (کندترین، مطمئن‌ترین)</option>
            </select>
          </div>
          <div class="mv-form-row">
            <div class="mv-form-label">نسخه IP</div>
            <select id="aether-${p}-ip" class="mv-popup">
              <option value="v4" selected>IPv4</option>
              <option value="v6">IPv6</option>
              <option value="both">هر دو</option>
            </select>
          </div>
          <label class="mv-form-row">
            <span class="mv-form-label">اتصال سریع به سرور قبلی<small>اگر سرور قبلی سالم بود، اسکن را رد کن.</small></span>
            <input type="checkbox" id="aether-${p}-quick" class="mv-switch-input" checked />
          </label>
        </div>
        <p class="mv-form-footer">«متعادل» بعد از اولین سرور متوقف نمی‌شود؛ ۶ تا پیدا می‌کند و کم‌پینگ‌ترین را برمی‌دارد. «مطمئن» برای هر کاندید یک تونل واقعی می‌سازد و HTTP را تست می‌کند. «توربو» با اولین سروری که جواب بدهد وصل می‌شود؛ ممکن است سرعت کم باشد. در هر حالت، بعد از اتصال سرعت واقعی تونل سنجیده می‌شود و اگر گیت‌وی کند باشد خودکار عوض می‌شود.</p>
      </div>`;
}

function aeAdvSection(p) {
    return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">پیشرفته</div>
        <div class="mv-form-group">
          <label class="mv-form-row">
            <span class="mv-form-label">تحویل به Xray (زنجیره)<small><b>حالت پیشنهادی.</b> خروجی Xray از داخل این تونل رد می‌شود و پراکسی سیستم دست Xray می‌ماند. بعد از روشن یا خاموش کردن، Xray را یک‌بار قطع و وصل کنید تا اعمال شود.</small></span>
            <input type="checkbox" id="aether-${p}-chain" class="mv-switch-input" checked />
          </label>
          <label class="mv-form-row">
            <span class="mv-form-label">ثبت‌نام از طریق پراکسی فعلی<small><b>معمولاً لازم نیست — خاموش بگذارید.</b> ساخت حساب به api.cloudflareclient.com نیاز دارد که روی بیشتر شبکه‌ها مستقیم در دسترس است. فقط اگر ثبت‌نام مستقیم شکست خورد و Xray وصل است، روشنش کنید؛ فقط ثبت‌نام از پراکسی رد می‌شود و ترافیک تونل همچنان مستقیم است.</small></span>
            <input type="checkbox" id="aether-${p}-bootstrap" class="mv-switch-input" />
          </label>
          <label class="mv-form-row">
            <span class="mv-form-label">حالت دیباگ<small>فقط برای عیب‌یابی. لاگ کامل با زمان‌بندی مراحل در فایل ذخیره می‌شود و جزئیات بیشتر در لاگ هسته می‌آید.</small></span>
            <input type="checkbox" id="aether-${p}-debug" class="mv-switch-input" />
          </label>
          <label class="mv-form-row">
            <span class="mv-form-label">لاگ کامل (verbose)<small>جزئیات بیشتر در لاگ هسته، بدون ذخیره در فایل.</small></span>
            <input type="checkbox" id="aether-${p}-verbose" class="mv-switch-input" />
          </label>
        </div>
        <p class="mv-form-footer">لاگ خط‌به‌خط موتور در پنجرهٔ «گزارش هسته» دیده می‌شود.</p>
      </div>`;
}

function aeIdentitySection(p) {
    return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">هویت</div>
        <div class="mv-form-group">
          <div class="mv-form-row">
            <div class="mv-form-label">هویت‌های کلادفلر<small>اگر اتصال با خطای ثبت‌نام یا هویت گیر کرده، هویت‌ها پاک و یک حساب تازه ساخته می‌شود.</small></div>
            <button type="button" class="mv-btn mv-btn--sm" onclick="resetAetherIdentity()">پاک کردن و ساخت دوباره</button>
          </div>
        </div>
        <p class="mv-form-footer">هر موتور برای وصل شدن یک حساب رایگان وارپ می‌سازد و نگه می‌دارد؛ «وارپ در وارپ» دو تا. پاک کردن فقط وقتی لازم است که اتصال روی مرحلهٔ «هویت» بماند.</p>
      </div>`;
}

// What only this engine has.
function aeOwnSection(p) {
    if (p === 'masque') return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">ترنسپورت و مبهم‌سازی</div>
        <div class="mv-form-group">
          <div class="mv-form-row">
            <div class="mv-form-label">ترنسپورت<small>اگر اینترنت‌تان UDP را محدود می‌کند، HTTP/2 را انتخاب کنید.</small></div>
            <select id="aether-masque-transport" class="mv-popup">
              <option value="h3">HTTP/3 (QUIC) — سریع‌ترین</option>
              <option value="h2">HTTP/2 (TCP) — وقتی UDP بسته است</option>
            </select>
          </div>
          <label class="mv-form-row">
            <span class="mv-form-label">فرگمنت ClientHello<small>فقط روی HTTP/2. دست‌دادن TLS را تکه‌تکه می‌فرستد تا DPI نتواند SNI را بخواند.</small></span>
            <input type="checkbox" id="aether-masque-fragment" class="mv-switch-input" />
          </label>
          <div class="mv-form-row is-sub">
            <div class="mv-form-label">اندازه‌ی تکه‌ها</div>
            <input type="text" id="aether-masque-fragsize" class="mv-field mv-field--compact" placeholder="16-32" dir="ltr" aria-label="اندازه‌ی تکه‌ها" />
          </div>
          <div class="mv-form-row is-sub">
            <div class="mv-form-label">تأخیر بین تکه‌ها</div>
            <input type="text" id="aether-masque-fragdelay" class="mv-field mv-field--compact" placeholder="2-10" dir="ltr" aria-label="تأخیر بین تکه‌ها" />
          </div>
          <div class="mv-form-row">
            <div class="mv-form-label">ECH (رمزنگاری SNI)<small>اندپوینت MASQUE کلادفلر معمولاً ECH را نمی‌پذیرد؛ خاموش بگذارید.</small></div>
            <select id="aether-masque-ech" class="mv-popup">
              <option value="">خاموش (پیش‌فرض)</option>
              <option value="auto">خودکار</option>
            </select>
          </div>
          <div class="mv-form-row">
            <div class="mv-form-label">مبهم‌سازی (Noize)</div>
            <select id="aether-masque-noize" class="mv-popup">
              <option value="firewall">firewall (پیش‌فرض)</option>
              <option value="off">خاموش</option>
              <option value="balanced">متعادل</option>
              <option value="aggressive">تهاجمی (GFW)</option>
            </select>
          </div>
        </div>
      </div>`;
    if (p === 'wg') return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">مبهم‌سازی و پایداری</div>
        <div class="mv-form-group">
          <div class="mv-form-row">
            <div class="mv-form-label">پروفایل مبهم‌سازی<small>بسته‌های جعلی اضافه می‌کند تا الگوی WireGuard شناسایی نشود.</small></div>
            <select id="aether-wg-noize" class="mv-popup">
              <option value="balanced">متعادل (پیش‌فرض)</option>
              <option value="off">خاموش</option>
              <option value="light">سبک</option>
              <option value="aggressive">تهاجمی (GFW)</option>
            </select>
          </div>
          <label class="mv-form-row">
            <span class="mv-form-label">تلاش خودکار با پروفایل‌های دیگر<small>اگر پروفایل اول جواب نداد، بقیه را امتحان کن.</small></span>
            <input type="checkbox" id="aether-wg-retry" class="mv-switch-input" checked />
          </label>
          <div class="mv-form-row">
            <div class="mv-form-label">Keepalive<small>عدد کمتر = پایداری بیشتر پشت NAT، مصرف کمی بیشتر.</small></div>
            <div class="mv-form-control">
              <input type="number" id="aether-wg-keepalive" class="mv-field mv-field--compact" value="5" min="1" max="120" dir="ltr" aria-label="Keepalive به ثانیه" />
              <span>ثانیه</span>
            </div>
          </div>
        </div>
      </div>`;
    return `
      <div class="mv-form-section is-wide">
        <div class="mv-form-header">تونل بیرونی</div>
        <div class="mv-form-group">
          <div class="mv-form-row mv-callout is-warn">
            <i class="ph-fill ph-warning"></i>
            <span>این موتور <b>دو هویت</b> کلادفلر می‌سازد و سرعت را کاهش می‌دهد. اگر ماسک کار می‌کند، آن را ترجیح دهید.</span>
          </div>
          <div class="mv-form-row">
            <div class="mv-form-label">پروفایل مبهم‌سازی<small>تونل داخلی همیشه بدون مبهم‌سازی است (داخل تونل بیرونی محافظت می‌شود).</small></div>
            <select id="aether-gool-noize" class="mv-popup">
              <option value="balanced">متعادل (پیش‌فرض)</option>
              <option value="off">خاموش</option>
              <option value="light">سبک</option>
              <option value="aggressive">تهاجمی (GFW)</option>
            </select>
          </div>
          <div class="mv-form-row">
            <div class="mv-form-label">Keepalive</div>
            <div class="mv-form-control">
              <input type="number" id="aether-gool-keepalive" class="mv-field mv-field--compact" value="5" min="1" max="120" dir="ltr" aria-label="Keepalive تونل بیرونی به ثانیه" />
              <span>ثانیه</span>
            </div>
          </div>
        </div>
      </div>`;
}

function aePageHtml(p) {
    const e = AE_ENGINES[p];
    const secs = aeSections(p);
    return `
<div class="ae-page mv-split" id="ae-page-${p}" data-protocol="${p}" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های ${e.name}">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" data-part="ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${secs.map(x => `
        <button type="button" class="mv-side-item" data-ae-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item mv-side-go" data-ae-store="1" title="هستهٔ وارپ در ام‌ال‌ام استور">
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
        <button type="button" data-ae-back="1" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" data-part="title">اتصال</h1>
      <div class="mv-eng-bar-action" data-part="bar-action"></div>
    </header>

    <div class="mv-pane-scroll custom-scrollbar">

      <div class="mv-eng-sec is-on" data-sec="connect">
        <div class="mv-eng-stage" data-part="stage" style="--tint:${e.tint}"></div>
        <!-- The run itself: one line, right under the button that starts it and above the cards. -->
        <div class="mv-eng-flow">
          <div class="mv-steps ae-steps"></div>
          <div class="ae-details"></div>
        </div>
        <div class="mv-eng-grid" data-part="cards"></div>
      </div>

      <div class="mv-eng-sec" data-sec="route"><div class="mv-form">${aeRouteSection(p)}</div></div>
      <div class="mv-eng-sec" data-sec="scan"><div class="mv-form">${aeScanSection(p)}</div></div>
      <div class="mv-eng-sec" data-sec="tune"><div class="mv-form">${aeOwnSection(p)}</div></div>
      <div class="mv-eng-sec" data-sec="adv"><div class="mv-form">${aeAdvSection(p)}</div></div>
      <div class="mv-eng-sec" data-sec="identity"><div class="mv-form">${aeIdentitySection(p)}</div></div>

    </div>

    <div class="mv-eng-foot" data-part="foot"></div>
  </section>
</div>`;
}

// The old layout's panel: the three pages as tabs. On the desktop shell/apps.js lifts each
// page into its own window and this wrapper is never shown.
function aetherPanelHtml() {
    return `
<div id="aether-wrapper" dir="rtl">
  <div class="mv-toolbar">
    <div id="aether-tabs" class="mv-tb-seg" role="group" aria-label="موتور">
      ${AE_PROTOCOLS.map(p => `<button type="button" class="aether-tab" data-tab="${p}" onclick="switchAetherTab('${p}')">${AE_ENGINES[p].name}</button>`).join('')}
    </div>
  </div>
  <div class="ae-pages">${AE_PROTOCOLS.map(aePageHtml).join('')}</div>
</div>

<style>
  #aether-wrapper { position: absolute; inset: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--mv-pane); color: var(--mv-label); }
  .ae-pages { position: relative; flex: 1; min-height: 0; }
  /* Each page IS the split window — sidebar and pane — exactly as سایفون. */
  .ae-page { position: absolute; inset: 0; display: flex; overflow: hidden; background: var(--mv-pane); color: var(--mv-label); }
  .ae-progress { gap: 8px; }
  .ae-progress:has(.ae-details:empty) { padding-bottom: 12px; }
  /* Persian label, Latin value («پینگ: 84ms»): an RTL line keeps them in reading order. */
  .ae-details { font-family: var(--mv-font-tech); font-size: 11.5px; line-height: 1.9; color: var(--mv-label-2); direction: rtl; text-align: right; }
  .ae-details:empty { display: none; }
  .ae-tgl-badge {
    display: inline-block; margin-inline-start: 4px; padding: 0 6px; border-radius: 999px; vertical-align: 1px;
    font-size: 10.5px; font-weight: 700; color: var(--mv-green-ink); background: color-mix(in srgb, var(--mv-green) 14%, transparent);
  }
  /* A running whole-system tunnel is a state change for the machine, so its row says so. */
  .ae-tun-box.on { background: color-mix(in srgb, var(--mv-green) 7%, transparent); }
  .ae-tun-box.disabled { opacity: .5; }
  .ae-tun-box.disabled input { cursor: not-allowed; }
</style>`;
}

// ============================================================
// Which engine the user is on
// ============================================================
// The old layout: one page at a time, chosen by the tabs.
function switchAetherTab(tab) {
    if (!AE_ENGINES[tab]) tab = 'masque';
    aetherActiveTab = tab;
    document.querySelectorAll('.aether-tab').forEach(b => {
        b.classList.toggle('active', b.dataset.tab === tab);
    });
    // Only the pages still inside the old panel; on the desktop each page lives in its window.
    document.querySelectorAll('#aether-wrapper .ae-page').forEach(p => {
        p.style.display = p.dataset.protocol === tab ? 'flex' : 'none';
    });
    try { PersistentStorage.setItem('aether_tab', tab); } catch (e) {}
    renderAetherStatus();
}

// The desktop: the engine whose window came forward last is the one «the last engine» means
// (e.g. what the old «Aether» shortcuts open).
function aetherViewed(p) {
    if (!AE_ENGINES[p]) return;
    aetherActiveTab = p;
    try { PersistentStorage.setItem('aether_tab', p); } catch (e) {}
}

// ============================================================
// System proxy — live toggle, independent of every engine
// ============================================================
// Flipping this only rewrites the Windows proxy registry keys. It never starts, stops, or
// reconfigures Xray or the engine, so the tunnel keeps running while the user switches the
// whole machine on and off the proxy. Every engine page carries a copy of the switch.
function aeSysproxyLabels(text, color) {
    document.querySelectorAll('.ae-sysproxy-label').forEach(l => {
        l.textContent = text;
        if (color) l.style.color = color;
    });
}

async function refreshSystemProxy() {
    const cbs = document.querySelectorAll('.ae-sysproxy-toggle');
    if (!cbs.length) return;
    try {
        const r = await fetch('/api/proxy/system');
        const d = await r.json();
        cbs.forEach(cb => { cb.checked = !!d.enabled; });
        // A proxy pointed at a dead Xray routes nothing, so it does not count as protection —
        // but the SWITCH still has to show what Windows is actually set to, which is what
        // `proxyOn` is for (the hero card's row reads it, and toggling reads it back).
        aetherRouted.proxyOn = !!d.enabled;
        aetherSetRouted({ proxy: !!d.enabled && d.xrayRunning !== false });

        if (d.enabled && d.xrayRunning === false) {
            // Proxy is on but its target is gone — this is the state that looks like
            // "the internet is broken", so name it explicitly.
            aeSysproxyLabels('⚠️ روشن است ولی Xray اجرا نیست — اینترنت قطع می‌شود', 'var(--mv-red-ink)');
        } else if (d.enabled) {
            aeSysproxyLabels(`کل ویندوز از Xray رد می‌شود (${d.server || '127.0.0.1:' + d.port})`, 'var(--mv-green-ink)');
        } else {
            aeSysproxyLabels(d.xrayRunning === false
                ? 'خاموش — برای روشن کردن، اول Xray را وصل کنید'
                : 'خاموش — ویندوز مستقیم وصل می‌شود', 'var(--mv-label-3)');
        }
    } catch (e) {
        aeSysproxyLabels('وضعیت نامشخص');
    }
}

async function toggleSystemProxy(on) {
    aeSysproxyLabels('در حال اعمال…');
    try {
        const r = await fetch('/api/proxy/system', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!on }),
        });
        const d = await r.json();
        if (d.error) {
            // The switch must snap back: leaving it "on" while nothing changed would tell the
            // user the whole machine is proxied when it isn't.
            document.querySelectorAll('.ae-sysproxy-toggle').forEach(cb => { cb.checked = false; });
            if (typeof toast === 'function') toast('❌ ' + d.error);
            if (d.code === 'XRAY_NOT_RUNNING') {
                aeSysproxyLabels('اول Xray را وصل کنید', 'var(--mv-orange-ink)');
                return;
            }
        } else if (typeof toast === 'function') {
            toast(on ? '✅ پراکسی سیستم روشن شد' : 'پراکسی سیستم خاموش شد');
        }
    } catch (e) {
        if (typeof toast === 'function') toast('❌ ' + e.message);
    }
    refreshSystemProxy();
    // Enabling the proxy tears TUN down server-side; reflect that here too.
    refreshTunStatus();
}

// ============================================================
// TUN mode — whole-system tunnel, no leaks
// ============================================================
// Unlike the system proxy, this captures traffic at the adapter level: UDP, QUIC, DNS and
// every non-browser program included. The two are mutually exclusive; the server enforces
// that, and this just keeps the switches honest about it.
function aeTun(fn) {
    document.querySelectorAll('.ae-tun-box').forEach(box => {
        fn(box.querySelector('.ae-tun-toggle'), box.querySelector('.ae-tun-label'), box);
    });
}

async function refreshTunStatus() {
    if (!document.querySelector('.ae-tun-box')) return;
    try {
        const d = await (await fetch('/api/tun/status')).json();
        // Read from the machine, not from our own last write: the server drops the tunnel when
        // the engine stops, and until this landed anywhere, a freshly opened window could show
        // «متصل» over traffic that was not being routed at all.
        aetherRouted.tunOn = !!d.running;
        aetherRouted.tunWanted = !!d.wanted;
        aetherSetRouted({ tun: !!d.running });
        aeTun((cb, lbl, box) => {
            cb.checked = !!d.running;
            box.classList.toggle('on', !!d.running);
            if (!d.ready) {
                // The binaries are not installed. Say which, rather than failing on click.
                cb.disabled = true;
                box.classList.add('disabled');
                lbl.textContent = 'فایل‌های موتور تونل موجود نیست';
                lbl.style.color = 'var(--mv-orange-ink)';
                box.title = d.reason || '';
                return;
            }
            cb.disabled = false;
            box.classList.remove('disabled');
            box.title = '';
            if (d.running) {
                lbl.textContent = 'تمام ترافیک سیستم — بدون نشت QUIC و DNS';
                lbl.style.color = 'var(--mv-green-ink)';
            } else {
                lbl.textContent = 'خاموش — فقط پراکسی سیستم فعال است';
                lbl.style.color = 'var(--mv-label-3)';
            }
        });
    } catch (e) {
        aeTun((cb, lbl) => { lbl.textContent = 'وضعیت نامشخص'; });
    }
}

// Push a server-reported tunnel state straight onto the switch.
//
// Called from the websocket dispatcher, so the pages reflect what the machine is actually
// doing rather than what the user last clicked. `wanted` is the piece that makes the middle
// state honest: a tunnel the user asked for that is currently down and being rebuilt is a
// different thing from one they switched off, and showing both as plain "off" is what let a
// dropped tunnel look deliberate.
function applyTunState(d) {
    if (!d) return;
    const running = !!d.running;
    const wanted  = !!d.wanted;
    aetherRouted.tunOn = running;
    aetherRouted.tunWanted = wanted;
    aetherSetRouted({ tun: running });
    aeTun((cb, lbl, box) => {
        cb.checked = running || wanted;
        box.classList.toggle('on', running);
        if (running) {
            lbl.textContent = 'تمام ترافیک سیستم — بدون نشت QUIC و DNS';
            lbl.style.color = 'var(--mv-green-ink)';
        } else if (wanted) {
            const why = d.health && d.health.verdict ? ({
                'process-dead': 'موتور تونل اجرا نیست',
                'adapter-gone': 'آداپتور تونل حذف شده',
                'adapter-down': 'آداپتور تونل بالا نیست',
                'route-stolen': 'مسیر پیش‌فرض از تونل نمی‌رود',
            })[d.health.verdict] || '' : '';
            lbl.textContent = `⚠️ تونل برقرار نیست${why ? ` (${why})` : ''} — در حال بازیابی`;
            lbl.style.color = 'var(--mv-orange-ink)';
        } else {
            lbl.textContent = 'خاموش — فقط پراکسی سیستم فعال است';
            lbl.style.color = 'var(--mv-label-3)';
        }
    });
}

// The kill switch is a machine-wide state the user must never discover by accident. While it
// holds, their internet is deliberately closed; saying so is the difference between "the app
// is protecting me" and "my PC broke".
function applyGuardState(d) {
    if (!d || !d.killSwitch) return;
    aeTun((cb, lbl) => {
        lbl.textContent = `🔒 ترافیک تا بازگشت تونل بسته است${d.reason ? ` — ${d.reason}` : ''}`;
        lbl.style.color = 'var(--mv-orange-ink)';
    });
}

async function toggleTun(on) {
    // Refuse here, with the name of the engine THIS page owns.
    //
    // The server's refusal has to list every engine that could carry the tunnel, and on the
    // «وارپ» page that reads as nonsense — «اول ماسک را وصل کنید» on a page whose engine is a
    // different one entirely. The page knows which engine it is, so it says so.
    if (on) {
        const p = aetherActiveTab;
        const st = p ? aeStateOf(p) : null;
        if (p && st && !st.connected) {
            aeTun(cb => { cb.checked = false; cb.disabled = false; });
            if (typeof toast === 'function') toast(`❌ اول خودِ «${aeName(p)}» را وصل کنید، بعد تونل را روشن کنید.`);
            return;
        }
    }
    aeTun((cb, lbl) => {
        lbl.textContent = on ? 'در حال بالا آوردن تونل…' : 'در حال خاموش کردن…';
        lbl.style.color = 'var(--mv-label-3)';
        cb.disabled = true;
    });
    try {
        const r = await fetch('/api/tun', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !!on }),
        });
        const d = await r.json();
        if (d.error) {
            // Snap back: a switch left "on" after a failed start would claim the machine is
            // tunnelled when it is not — the most dangerous thing this page could show.
            aeTun(cb => { cb.checked = false; });
            if (typeof toast === 'function') toast('❌ ' + d.error);
        } else if (typeof toast === 'function') {
            toast(on ? '✅ تونل کامل برقرار شد' : 'تونل خاموش شد');
        }
    } catch (e) {
        aeTun(cb => { cb.checked = false; });
        if (typeof toast === 'function') toast('❌ ' + e.message);
    }
    aeTun(cb => { cb.disabled = false; });
    // Both states may have moved, since turning one on turns the other off.
    refreshTunStatus();
    refreshSystemProxy();
}

// ============================================================
// Collect settings for one engine
// ============================================================
function collectAetherOptions(protocol) {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value : ''; };
    const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : false; };
    const own = (k) => 'aether-' + protocol + '-' + k;

    const opts = {
        protocol,
        // 'balanced', not 'turbo'. Turbo stops at the first gateway that completes a
        // handshake (prober.rs: target_successes 1, early_exit_first) — a liveness test, not
        // a quality one. Measured spread between a lucky and an unlucky draw on the same
        // line, same minute: 18x. Balanced collects six candidates and takes the best.
        scan: val(own('scan')) || 'balanced',
        ip: val(own('ip')) || 'v4',
        quickReconnect: chk(own('quick')),
        chainToXray: chk(own('chain')),
        verbose: chk(own('verbose')),
        debug: chk(own('debug')),
        // Xray's HTTP inbound; only used to reach the Cloudflare registration API.
        bootstrapProxy: chk(own('bootstrap')) ? 'http://127.0.0.1:20809' : null,
    };

    if (protocol === 'masque') {
        opts.transport = val('aether-masque-transport') || 'h3';
        opts.noize = val('aether-masque-noize') || 'firewall';
        const ech = val('aether-masque-ech');
        if (ech) opts.ech = ech;
        if (chk('aether-masque-fragment')) {
            opts.fragment = true;
            if (val('aether-masque-fragsize')) opts.fragmentSize = val('aether-masque-fragsize');
            if (val('aether-masque-fragdelay')) opts.fragmentDelay = val('aether-masque-fragdelay');
        }
    } else if (protocol === 'wg') {
        opts.noize = val('aether-wg-noize') || 'balanced';
        opts.keepalive = parseInt(val('aether-wg-keepalive')) || 5;
        opts.noProfileRetry = !chk('aether-wg-retry');
    } else if (protocol === 'gool') {
        opts.noize = val('aether-gool-noize') || 'balanced';
        opts.keepalive = parseInt(val('aether-gool-keepalive')) || 5;
    }

    return opts;
}

function saveAetherSettings() {
    try {
        PersistentStorage.setItem('aether_settings', JSON.stringify({
            masque: collectAetherOptions('masque'),
            wg: collectAetherOptions('wg'),
            gool: collectAetherOptions('gool'),
            tab: aetherActiveTab,
        }));
    } catch (e) {}
}

function restoreAetherSettings() {
    let saved = null;
    try {
        const raw = PersistentStorage.getItem('aether_settings');
        if (raw) saved = JSON.parse(raw);
    } catch (e) {}
    if (!saved) return;

    const set = (id, v) => { const el = document.getElementById(id); if (el && v !== undefined && v !== null) el.value = v; };
    const setChk = (id, v) => { const el = document.getElementById(id); if (el && typeof v === 'boolean') el.checked = v; };

    // Each engine gets back its own copy. A save from before the engines were split holds the
    // same shared values under every protocol, so each page starts where the one panel was.
    AE_PROTOCOLS.forEach(p => {
        const s = saved[p] || saved[saved.tab] || saved.masque || {};
        set('aether-' + p + '-scan', s.scan);
        set('aether-' + p + '-ip', s.ip);
        setChk('aether-' + p + '-quick', s.quickReconnect);
        setChk('aether-' + p + '-chain', s.chainToXray !== false);
        setChk('aether-' + p + '-verbose', s.verbose);
        setChk('aether-' + p + '-bootstrap', !!s.bootstrapProxy);
    });

    if (saved.masque) {
        set('aether-masque-transport', saved.masque.transport);
        set('aether-masque-noize', saved.masque.noize);
        set('aether-masque-ech', saved.masque.ech || '');
        setChk('aether-masque-fragment', !!saved.masque.fragment);
        set('aether-masque-fragsize', saved.masque.fragmentSize || '');
        set('aether-masque-fragdelay', saved.masque.fragmentDelay || '');
    }
    if (saved.wg) {
        set('aether-wg-noize', saved.wg.noize);
        set('aether-wg-keepalive', saved.wg.keepalive);
        setChk('aether-wg-retry', !saved.wg.noProfileRetry);
    }
    if (saved.gool) {
        set('aether-gool-noize', saved.gool.noize);
        set('aether-gool-keepalive', saved.gool.keepalive);
    }
    if (saved.tab) switchAetherTab(saved.tab);
}

// ============================================================
// Start / stop
// ============================================================
async function toggleAether(protocol) {
    // A press while it is trying means CANCEL — that is the press a user reaches for most, and the
    // engine reports `running` from the first moment, so the stop path already covers it.
    if (aeStateOf(protocol).running) {
        const was = aeIsOwnEngine(protocol) ? protocol : aetherState.protocol;
        aeBusy = true;
        renderAetherStatus();
        try {
            await fetch(aeIsOwnEngine(was) ? '/api/warp/stop' : '/api/aether/stop', { method: 'POST' });
            if (typeof toast === 'function') toast(`${aeName(was)} متوقف شد`);
        } catch (e) {
            if (typeof toast === 'function') toast('❌ ' + e.message);
        }
        aeBusy = false;
        await refreshAetherStatus();
        return;
    }

    aetherViewed(protocol);
    // Which APP was started, not which protocol the engine reports: «وارپ» and «وایرگارد» are
    // both wg to the engine, so without this the wrong lamp lights.
    window.aeStartedProto = protocol;
    try { PersistentStorage.setItem('aether_started_as', protocol); } catch (e) { /* memory only */ }
    const opts = collectAetherOptions(protocol);
    saveAetherSettings();

    aeBusy = true;
    renderAetherStatus();

    try {
        const r = aeIsOwnEngine(protocol)
            // The user's own choices go to the new engine too — the scan mode and the
            // obfuscation profile are real levers there (warp-manager.js › transportEnv), and
            // sending `{}` meant every card on this page was decoration.
            ? await fetch('/api/warp/start', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scan: opts.scan, ip: opts.ip, noize: opts.noize, keepalive: opts.keepalive }),
            })
            : await fetch('/api/aether/start', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts),
            });
        const data = await r.json();
        if (data.error) {
            if (typeof toast === 'function') toast('❌ ' + data.error);
            aeBusy = false;
            renderAetherStatus();
            return;
        }
        if (typeof toast === 'function') toast(`${aeName(protocol)} راه‌اندازی شد — در حال یافتن سرور…`);
    } catch (e) {
        if (typeof toast === 'function') toast('❌ ' + e.message);
    }
    aeBusy = false;
    renderAetherStatus();
}

async function resetAetherIdentity() {
    // Whichever engine this page owns — «وارپ»'s own running state, not aether's.
    if (aeStateOf(aetherActiveTab).running) {
        if (typeof toast === 'function') {
            toast(aeIsOwnEngine(aetherActiveTab) ? 'اول «وارپ» را متوقف کنید'
                : `اول ${aeName(aeRunningPage())} را متوقف کنید`);
        }
        return;
    }
    try {
        // «وارپ» keeps its OWN Cloudflare account in its own directory; clearing aether's would
        // do nothing for it and would throw away a working registration belonging to the other
        // three engines.
        const route = aeIsOwnEngine(aetherActiveTab) ? '/api/warp/reset-identity' : '/api/aether/reset-identity';
        const r = await fetch(route, { method: 'POST' });
        const data = await r.json();
        if (data.error) { if (typeof toast === 'function') toast('❌ ' + data.error); return; }
        if (typeof toast === 'function') {
            toast(data.removed.length ? '✅ هویت‌ها پاک شد' : 'هویتی برای پاک کردن نبود');
        }
    } catch (e) { if (typeof toast === 'function') toast('❌ ' + e.message); }
}

// ============================================================
// Status rendering — every page, relative to its own engine
// ============================================================
function renderAetherSteps() {
    AE_PROTOCOLS.forEach(p => {
        const page = aePage(p);
        const box = page && page.querySelector('.ae-steps');
        if (!box) return;
        // Each page reads ITS OWN engine. This used to read `aetherState` for all four, so on
        // the «وارپ» page — whose engine is a different one entirely — not one step ever lit up.
        const own = aeIsOwnEngine(p);
        const st = aeStateOf(p);
        let current = st.stage;
        const alias = own ? WARP_STAGE_ALIAS : AETHER_STAGE_ALIAS;
        if (alias.hasOwnProperty(current)) current = alias[current];
        const failed = st.stage === 'failed' || st.stage === 'crashed';
        const steps = AETHER_STEPS[p];
        // Progress belongs to the engine that is actually running; the others show their stages idle.
        const mine = (own ? true : aeIsMine(p)) && (st.running || st.connected || failed);
        const idx = mine && current ? steps.findIndex(s => s.key === current) : -1;

        // Page kit › .mv-steps (K7).
        box.innerHTML = steps.map((s, i) => {
            let cls = 'pending', mark = (i + 1).toLocaleString('fa-IR');
            if (mine && !failed && idx >= 0) {
                if (i < idx) { cls = 'done'; mark = '✓'; }
                else if (i === idx) { cls = 'active'; mark = st.connected && s.key === 'connected' ? '✓' : '●'; }
            }
            if (mine && st.connected && s.key === 'connected') { cls = 'done'; mark = '✓'; }
            return `<span class="mv-step is-${cls}"><i>${mark}</i>${s.fa}</span>`;
        }).join('');
    });
}

// Is any of the machine's traffic actually being handed to the engine?
//
// Two independent mechanisms can do it and neither is automatic: the whole-system tunnel
// (TUN), or the Windows system proxy pointed at Xray's inbound. With both off, a connected
// engine protects nothing at all.
// `tun`/`proxy` are «is traffic really going through it» (a proxy pointed at a dead Xray is not);
// `tunOn`/`proxyOn` are what the switches themselves are set to. The hero's card needs both.
let aetherRouted = { tun: false, proxy: false, tunOn: false, proxyOn: false, tunWanted: false };
function aetherTrafficIsRouted() { return aetherRouted.tun || aetherRouted.proxy; }

function aetherSetRouted(part) {
    Object.assign(aetherRouted, part);
    try { renderAetherStatus(); } catch (e) {}
}

const aeEsc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Which section of each page is showing, and whether a request of ours is in flight.
const aeSec = { masque: 'connect', wg: 'connect', gool: 'connect' };
let aeBusy = false;

/** Show one section of one engine's page, and keep the sidebar, the title and the bar in step. */
function aeGoSec(p, sec) {
    const page = aePage(p);
    if (!page) return;
    const known = aeSections(p).some((x) => x.id === sec);
    aeSec[p] = known ? sec : 'connect';
    page.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === aeSec[p]));
    page.querySelectorAll('.mv-side-item[data-ae-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-ae-sec') === aeSec[p]));
    const title = page.querySelector('[data-part="title"]');
    const found = aeSections(p).find((x) => x.id === aeSec[p]);
    if (title) title.textContent = found ? found.label : '';
    const back = page.querySelector('[data-ae-back]');
    if (back) back.disabled = aeSec[p] === 'connect';
    // The home section carries no toolbar at all (page-kit.css › .mv-pane.is-home); the window's
    // own drag strip narrows to the sidebar at the same time, so the hero starts at the very top.
    const pane = page.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', aeSec[p] === 'connect');
    const scroll = page.querySelector('.mv-pane-scroll');
    if (scroll) scroll.scrollTop = 0;
    renderAetherStatus();
}

/**
 * One place decides the page's tone: the hero's words, the ring, the dot in the sidebar and the
 * footer. Written once, because three copies is how a page says «متصل» in one corner and «خاموش»
 * in another.
 */
function aeView(p) {
    const e = AE_ENGINES[p];
    // «وارپ» reads its OWN engine (warp-manager.js); the other three read aether's. `mine` is
    // meaningless for a page with a private engine — it cannot be busy with somebody else's.
    const own = aeIsOwnEngine(p);
    const st = aeStateOf(p);
    const mine = own ? true : aeIsMine(p);
    const failed = st.stage === 'failed' || st.stage === 'crashed';
    const other = !own && st.running && !mine ? aeName(aeRunningPage()) : null;

    if (!aetherInstalled) {
        return { tone: 'bad', head: 'فایل موتور نیست', line: 'فایل <code>core/aether.exe</code> پیدا نشد. نسخه را دوباره نصب کنید.' };
    }
    if (mine && st.connected && !aetherTrafficIsRouted()) {
        // THE MOST DANGEROUS THING THIS PAGE CAN SAY IS «متصل» HERE.
        //
        // A connected engine only means the local SOCKS/HTTP proxy exists. Until the system proxy
        // or the whole-system tunnel is on, every packet still leaves with the real address —
        // measured on this machine, with the old green badge showing, dnsleaktest.com correctly
        // reported the user's Iranian IP.
        // …but «you have not chosen yet» is NOT a fault, and painting it red said one had
        // happened. While the question is still on screen the engine is simply mid-connect: it
        // keeps the spinner and the steps, which is what the connection actually looks like from
        // the user's side. Red is kept for the case that IS dangerous — the sheet is gone, the
        // choice was never made, and packets really are leaving with the real address.
        const asking = !!(window.MVRouteSheet && MVRouteSheet.isOpen('aether'));
        if (asking) {
            return {
                tone: 'busy',
                head: 'وصل شد — مسیر ترافیک را انتخاب کنید',
                line: 'موتور بالا آمد. «تونل کامل» همهٔ ویندوز را رد می‌کند و «پراکسی سیستم» فقط برنامه‌هایی که از پراکسی پیروی می‌کنند.',
            };
        }
        return {
            tone: 'bad',
            head: 'وصل است — ولی ترافیکی از آن رد نمی‌شود',
            line: 'تا «تونل کامل» یا «پراکسی سیستم» روشن نشود، هر بسته با آی‌پی واقعی شما بیرون می‌رود. در کارت <b>«مسیر ترافیک»</b> یکی از این دو را روشن کنید.',
        };
    }
    if (mine && st.connected) {
        const bits = [aetherRouted.tun
            ? 'همهٔ ترافیک ویندوز از این تونل رد می‌شود — بدون نشت QUIC و DNS.'
            : 'برنامه‌هایی که از پراکسی ویندوز پیروی می‌کنند از این تونل رد می‌شوند.'];
        if (st.server) bits.push(`سرور <code>${aeEsc(st.server)}</code>`);
        if (st.rtt) bits.push(`پینگ <code>${aeEsc(st.rtt)}</code>`);
        return { tone: 'on', head: 'وصل است', line: bits.join(' · ') };
    }
    if (mine && failed) {
        return { tone: 'bad', head: 'وصل نشد', line: aeEsc(st.stageFa || 'اتصال ناموفق بود — دوباره امتحان کنید.') };
    }
    if (mine && (st.running || aeBusy)) {
        const bits = [aeEsc(st.stageFa || 'در حال راه‌اندازی')];
        if (st.server) bits.push(`سرور <code>${aeEsc(st.server)}</code>`);
        return { tone: 'busy', head: 'در حال اتصال', line: bits.join(' · ') };
    }
    if (other) {
        return {
            tone: 'off',
            head: `${other} روشن است`,
            line: 'هر بار فقط یکی از سه موتور وارپ می‌تواند روشن باشد. دکمه، همان موتور را قطع می‌کند تا این یکی بتواند وصل شود.',
        };
    }
    return { tone: 'off', head: AE_HEADLINE[p] || e.name, line: `${e.blurb} سرور سالم را خودش پیدا می‌کند و تونل رمزنگاری‌شده روی وارپ کلادفلر می‌سازد.` };
}

/** The sidebar's own card: which engine this window is, and what it is doing. */
function aeRenderIdent(p) {
    const page = aePage(p);
    const host = page && page.querySelector('[data-part="ident"]');
    if (!host) return;
    const v = aeView(p);
    const st = aeStateOf(p);
    // A connected engine whose traffic is not routed yet is not BROKEN — it is waiting for the
    // user to pick «تونل کامل» or «پراکسی سیستم». Calling that «مشکل دارد» under the icon was
    // the app telling them something had gone wrong when nothing had.
    const word = v.tone === 'on' ? 'وصل است'
        : v.tone === 'busy' ? 'در حال کار'
            : v.tone === 'bad' ? (st.connected ? 'وصل — مسیر روشن نیست' : 'مشکل دارد')
                : 'خاموش';
    const app = window.MV && MV.apps && MV.apps.get && MV.apps.get(AE_APP_OF[p]);
    const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
        : `<span class="mv-side-tile" style="--tint:${AE_ENGINES[p].tint}"><svg viewBox="0 0 24 24" aria-hidden="true">${AE_ENGINES[p].glyph}</svg></span>`;
    host.innerHTML = `${icon}
      <b>${aeName(p)}</b>
      <small><i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : ''}"></i>${word}</small>`;
}

/** The connect/disconnect button — the same one in the hero and in the title band. */
function aeActionButton(p, big) {
    // The page's OWN engine decides this. Reading `aetherState` here is what left «اتصال» on the
    // button of a «وارپ» that was already connected — a button offering to do what it had done.
    const own = aeIsOwnEngine(p);
    const st = aeStateOf(p);
    const mine = own ? true : aeIsMine(p);
    const other = !own && aetherState.running && !mine ? aeName(aeRunningPage()) : null;
    const label = st.connected && mine ? 'قطع اتصال' : st.running ? (other ? `قطع ${other}` : 'لغو') : 'اتصال';
    const off = (own ? false : !aetherInstalled) || (aeBusy && !st.running && !st.connected);
    return `<button type="button" class="mv-btn${big ? ' mv-btn--lg' : ' mv-btn--sm'}${st.running ? '' : ' mv-btn--primary'}"
        data-ae-act="toggle"${off ? ' disabled' : ''}>${label}</button>`;
}

function aeWire(p, host) {
    if (!host) return;
    host.querySelectorAll('[data-ae-act="toggle"]').forEach((b) => { b.onclick = () => toggleAether(p); });
}

/**
 * The hero: the headline, and the one button, with the live traffic beside it.
 *
 * BUILT ONCE AND THEN UPDATED. Re-writing the stage on every status push re-created the button,
 * and a CSS animation restarts from zero every time its element is replaced — which is exactly the
 * stutter the ring had while connecting (see components/fronts.js, where the same bug was fixed).
 */
function aeRenderStage(p) {
    const page = aePage(p);
    const host = page && page.querySelector('[data-part="stage"]');
    if (!host) return;
    const v = aeView(p);
    const mine = aeIsOwnEngine(p) ? true : aeIsMine(p);
    const busy = v.tone === 'busy';

    if (host.dataset.built !== '1') {
        host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-ae-act="toggle" data-part="power">
          <i data-part="glyph"></i>
        </button>
      </div>
      <div class="mv-eng-stage-side">
        <div class="mv-eng-live" data-part="live"></div>
      </div>`;
        host.dataset.built = '1';
        aeWire(p, host);
    }

    const q = (n) => host.querySelector(`[data-part="${n}"]`);
    // What is NOT in the headline is that a second press cancels, so that goes on the line under it.
    const hint = busy && mine ? ' <b>برای لغو دوباره همین دکمه را بزنید.</b>' : '';
    q('head').innerHTML = v.head;
    q('line').innerHTML = v.line + hint;

    const ring = v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : '';
    const btn = q('power');
    const want = 'mv-eng-power' + ring;
    if (btn.className !== want) btn.className = want;
    // ENABLED WHILE IT IS TRYING — that press is «cancel», the press a user reaches for most.
    //
    // All of this reads the page's OWN engine. It used to read `aetherState`, so hovering the
    // power button of a CONNECTED «وارپ» offered «اتصال» — a button promising to do the thing it
    // had already done — and the glyph stayed in its disconnected state with it.
    const stp = aeStateOf(p);
    btn.disabled = (aeIsOwnEngine(p) ? false : !aetherInstalled)
        || (aeBusy && !stp.running && !stp.connected);
    const aria = stp.connected && mine ? 'قطع اتصال' : stp.running ? 'لغو' : 'اتصال';
    btn.setAttribute('aria-label', aria);
    btn.title = aria;
    // The ring alone while it works: a glyph class beside it would draw a second circle over it.
    const glyph = busy ? 'mv-spin-ring' : (stp.connected && mine ? 'ph-fill ph-power' : 'ph-bold ph-power');
    const gl = q('glyph');
    if (gl.className !== glyph) gl.className = glyph;

    const live = q('live');
    if (live && window.MVEngineLive) MVEngineLive.mount(live);
}

/**
 * The cards: every choice this engine really has, with its current answer visible.
 *
 * The card writes into the real <select> in the section and lets it fire `change` — the section
 * holds the paragraphs, the card holds the decision, and there is only ever one saved answer.
 */
function aeRenderCards(p) {
    const page = aePage(p);
    const host = page && page.querySelector('[data-part="cards"]');
    if (!host) return;
    const running = aetherState.running || aetherState.connected;
    const val = (k) => { const el = document.getElementById('aether-' + p + '-' + k); return el ? el.value : ''; };
    const pick = (attrs, on, live, title, hint) => `
        <button type="button" class="mv-eng-pick${on ? ' is-on' : ''}${live ? ' is-live' : ''}" ${attrs} aria-pressed="${on}">
          <i class="${on ? 'ph-fill ph-check-circle' : 'ph ph-circle'}"></i>
          <span class="mv-eng-pick-text"><b>${aeEsc(title)}</b><small>${aeEsc(hint)}</small></span>
        </button>`;
    const cards = [];

    // ── where the traffic goes ── the only card that is live state, not a saved setting
    const tunOn = !!aetherRouted.tun, proxyOn = !!aetherRouted.proxyOn;
    const now = tunOn ? 'تونل کامل' : proxyOn ? 'پراکسی سیستم' : 'هیچ‌کدام';
    cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-orange)">
        <button type="button" class="mv-eng-card2-head" data-ae-go="route">
          <span class="mv-eng-glyph"><i class="ph-fill ph-arrows-split"></i></span>
          <h3>مسیر ترافیک</h3>
          <span class="mv-eng-card2-end">${now}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body">
          ${pick('data-ae-route="tun"', tunOn, !!aetherRouted.tunWanted && !tunOn, 'تونل کامل سیستم',
        aetherRouted.tunWanted && !tunOn ? 'در حال بازیابی…' : 'همهٔ برنامه‌ها، با UDP و QUIC و DNS')}
          ${pick('data-ae-route="proxy"', proxyOn, false, 'پراکسی سیستم', 'فقط برنامه‌هایی که از تنظیم ویندوز پیروی می‌کنند')}
        </div>
        ${!tunOn && !proxyOn && aetherState.connected
            ? '<div class="mv-eng-card2-foot">موتور وصل است ولی هیچ ترافیکی وارد آن نمی‌شود — یکی را روشن کنید.</div>'
            : '<div class="mv-eng-card2-foot">هر دو با هم ممکن نیست؛ روشن کردن یکی دیگری را خاموش می‌کند.</div>'}
      </div>`);

    // ── how a server is found ──
    const scan = val('scan') || 'balanced';
    const scanNow = (AE_SCAN_MODES.find((m) => m.v === scan) || AE_SCAN_MODES[1]).t;
    cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-blue)">
        <button type="button" class="mv-eng-card2-head" data-ae-go="scan">
          <span class="mv-eng-glyph"><i class="ph-fill ph-radar"></i></span>
          <h3>حالت اسکن</h3>
          <span class="mv-eng-card2-end">${scanNow}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body" role="radiogroup">
          ${AE_SCAN_MODES.map((m) => pick(`data-ae-set="scan" data-ae-val="${m.v}"`, scan === m.v, false, m.t, m.h)).join('')}
        </div>
        ${running ? '<div class="mv-eng-card2-foot">انتخاب تازه از اتصال بعدی اعمال می‌شود.</div>' : ''}
      </div>`);

    // ── what only this engine has ──
    if (p === 'masque') {
        const tr = val('transport') || 'h3';
        cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <button type="button" class="mv-eng-card2-head" data-ae-go="tune">
          <span class="mv-eng-glyph"><i class="ph-fill ph-sliders"></i></span>
          <h3>ترنسپورت</h3>
          <span class="mv-eng-card2-end">${(AE_TRANSPORTS.find((t) => t.v === tr) || AE_TRANSPORTS[0]).t}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body" role="radiogroup">
          ${AE_TRANSPORTS.map((t) => pick(`data-ae-set="transport" data-ae-val="${t.v}"`, tr === t.v, false, t.t, t.h)).join('')}
        </div>
        <div class="mv-eng-card2-foot">فرگمنت، ECH و پروفایل مبهم‌سازی در بخش «${aeTuneTitle(p)}».</div>
      </div>`);
    } else {
        const nz = val('noize') || 'balanced';
        cards.push(`
      <div class="mv-eng-card2" style="--tint:var(--mv-indigo)">
        <button type="button" class="mv-eng-card2-head" data-ae-go="tune">
          <span class="mv-eng-glyph"><i class="ph-fill ph-sliders"></i></span>
          <h3>پروفایل مبهم‌سازی</h3>
          <span class="mv-eng-card2-end">${(AE_NOIZE_MODES.find((m) => m.v === nz) || AE_NOIZE_MODES[0]).t}<i class="ph-bold ph-caret-left"></i></span>
        </button>
        <div class="mv-eng-card2-body" role="radiogroup">
          ${AE_NOIZE_MODES.map((m) => pick(`data-ae-set="noize" data-ae-val="${m.v}"`, nz === m.v, false, m.t, m.h)).join('')}
        </div>
        ${running ? '<div class="mv-eng-card2-foot">انتخاب تازه از اتصال بعدی اعمال می‌شود.</div>' : ''}
      </div>`);
    }

    host.innerHTML = cards.join('');
    host.querySelectorAll('[data-ae-go]').forEach((b) => { b.onclick = () => aeGoSec(p, b.getAttribute('data-ae-go')); });
    host.querySelectorAll('[data-ae-route]').forEach((b) => { b.onclick = () => aeRouteToggle(b.getAttribute('data-ae-route')); });
    host.querySelectorAll('[data-ae-set]').forEach((b) => {
        b.onclick = () => {
            const sel = document.getElementById('aether-' + p + '-' + b.getAttribute('data-ae-set'));
            if (!sel) return;
            sel.value = b.getAttribute('data-ae-val');
            sel.dispatchEvent(new Event('change', { bubbles: true }));   // saveAetherSettings listens
            aeRenderCards(p);
        };
    });
}

/** The card's two switches act on the machine, not on a saved setting. */
function aeRouteToggle(kind) {
    if (kind === 'tun') toggleTun(!aetherRouted.tun);
    else toggleSystemProxy(!aetherRouted.proxyOn);
}

/** The strip along the bottom: in one line, what is true right now. */
function aeRenderFoot(p) {
    const page = aePage(p);
    const host = page && page.querySelector('[data-part="foot"]');
    if (!host) return;
    const v = aeView(p);
    // The page's OWN engine — «وارپ» has one of its own, so reading aether's state here is what
    // put «مشکل دارد» under a وارپ that was connected and working.
    const own = aeIsOwnEngine(p);
    const st = aeStateOf(p);
    const mine = own ? true : aeIsMine(p);
    const word = v.tone === 'on' ? (aetherRouted.tun ? 'وصل — تونل کامل سیستم' : 'وصل — پراکسی سیستم')
        : v.tone === 'busy' ? 'در حال اتصال'
            : v.tone === 'bad' ? (st.connected && mine ? 'وصل — ولی ترافیکی رد نمی‌شود' : 'مشکل دارد')
                : !own && aetherState.running && !mine ? `${aeName(aeRunningPage())} روشن است` : 'آمادهٔ اتصال';
    const end = mine && st.connected && st.server ? `<code>${aeEsc(st.server)}</code>`
        : mine && st.connected && st.socksPort ? `<code>127.0.0.1:${aeEsc(String(st.socksPort))}</code>` : '';
    host.innerHTML = `
      <i class="mv-eng-dot${v.tone === 'on' ? ' is-on' : v.tone === 'busy' ? ' is-busy' : v.tone === 'bad' ? ' is-bad' : ''}"></i>
      <span>${word}</span>
      <span class="mv-eng-foot-end">${end}</span>`;
}

// ============================================================
// Status rendering — every page, relative to its own engine
// ============================================================
function renderAetherStatus() {
    AE_PROTOCOLS.forEach((p) => {
        const page = aePage(p);
        if (!page) return;
        aeRenderIdent(p);
        aeRenderFoot(p);
        // One button is on screen at a time: the hero's, or the title band's — never both.
        const bar = page.querySelector('[data-part="bar-action"]');
        if (bar) {
            const html = aeSec[p] === 'connect' ? '' : aeActionButton(p, false);
            if (bar.innerHTML !== html) { bar.innerHTML = html; aeWire(p, bar); }
        }
        if (aeSec[p] === 'connect') { aeRenderStage(p); aeRenderCards(p); }

        const details = page.querySelector('.ae-details');
        if (details) {
            const rows = [];
            // The server and the ping are in the hero, a hand-span above; what is left for here is
            // what the hero does not say.
            if (aeIsMine(p)) {
                if (aetherState.profile) rows.push(`پروفایل: ${aeEsc(aetherState.profile)}`);
                if (aetherState.connected && aetherState.socks) rows.push(`SOCKS5: ${aeEsc(aetherState.socks)}`);
            }
            details.innerHTML = rows.join('  ·  ');
        }
    });

    renderAetherSteps();
}

async function refreshAetherStatus() {
    try {
        const r = await fetch('/api/aether/status');
        const data = await r.json();
        aetherState = data.status || aetherState;
        aetherInstalled = data.installed !== false;
    } catch (e) {}
    // «وارپ» is a different engine on a different route; one refresh has to ask both or its page
    // shows aether's state.
    try {
        const r = await fetch('/api/warp/status');
        const d = await r.json();
        if (d && d.status) window.warpState = d.status;
    } catch (e) {}
    renderAetherStatus();
}

/** Live updates from the «وارپ» engine (server.js broadcasts `warp_status` / `warp_log`). */
function handleWarpStatusEvent(st) {
    const wasConnected = !!(window.warpState && window.warpState.connected);
    window.warpState = st || window.warpState;
    renderAetherStatus();
    // The same question aether raises the moment it connects: a connected engine routes nothing
    // by itself. «وارپ» never asked it, so the user connected and then sat in front of a page
    // telling them traffic was not flowing, with no way offered to fix it.
    if (st && st.connected && !wasConnected) aeOfferRouting(st, 'warp');
    if (st && !st.running && !st.connected) aeRouteSheetClose();
}

// Live updates pushed by the server.
function handleAetherStatusEvent(state) {
    const wasConnected = !!(aetherState && aetherState.connected);
    aetherState = state;
    renderAetherStatus();
    // NOT DURING A MEASUREMENT. The game booster's race brings each Aether variant up and down in
    // turn — six of them — and every one of those used to raise «تونل کامل یا پراکسی سیستم؟».
    // The race measures through the engine's SOCKS port and deliberately touches neither the route
    // nor the system proxy, so there is no choice to make and the dialog is pure interruption.
    // The server tags those statuses; see aetherMeasurementStatus in server.js.
    if (state && state.connected && !wasConnected && !state.measuring) aeOfferRouting(state, aeRunningPage());
    if (state && !state.running) aeRouteSheetClose();
}

// ============================================================
// «موتور وصل شد — تونل کامل یا پروکسی کل سیستم؟»
// ============================================================
// A connected engine routes nothing by itself (see renderAetherStatus). So the moment it
// connects, the user is asked which of the two ways in they want (the shared sheet in
// route-sheet.js), and the sheet stays until that one is really up — a spinner while it comes
// up, the error and both choices again if it fails — unless the user closes it. Once per engine
// session: a reconnect inside the same session does not ask again, and nothing is asked when
// the tunnel or the proxy is already on.
let aeRouteAskedFor = null;

async function aeOfferRouting(state, page) {
    // `page` names the engine that just connected. «وارپ» has its own, so without it this asked
    // `aeRunningPage()` — which only ever knows about aether's — and the sheet never opened for
    // it at all: the user was left on a red page with no way to choose and nothing asking them.
    const who = page || aeRunningPage();
    const session = (who || '') + ':' + (state.startedAt || state.server || 'x');
    if (aeRouteAskedFor === session) return;
    aeRouteAskedFor = session;
    try {
        const [tun, proxy] = await Promise.all([
            fetch('/api/tun/status').then(r => r.json()).catch(() => ({})),
            fetch('/api/proxy/system').then(r => r.json()).catch(() => ({})),
        ]);
        if (tun.running || tun.wanted || (proxy.enabled && proxy.xrayRunning !== false)) return;
    } catch (e) { /* ask anyway */ }
    if (!who || !aeStateOf(who).connected || !window.MVRouteSheet) return;
    MVRouteSheet.open({
        owner: 'aether',
        title: `موتور ${aeName(who)} وصل شد`,
        text: 'تا یکی از این دو روشن نشود، هیچ ترافیکی از موتور رد نمی‌شود. کدام را می‌خواهید؟',
        choose: aeRouteChoose,
        // Closed without choosing: the page has to stop saying «انتخاب کنید» and start warning.
        onClosed: () => { try { renderAetherStatus(); } catch (e) { /* page gone */ } },
    });
}

function aeRouteSheetClose() {
    if (window.MVRouteSheet) MVRouteSheet.close('aether');
}

async function aeRouteChoose(kind) {
    let error = '';
    try {
        if (kind === 'tun') {
            const d = await (await fetch('/api/tun', {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
            })).json();
            if (d.error) error = d.error;
        } else {
            // The front-end Xray the proxy points at is started by the server right after the
            // engine connects; give it a moment instead of failing on a race.
            const deadline = Date.now() + 15000;
            for (;;) {
                const d = await (await fetch('/api/proxy/system', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
                })).json();
                if (!d.error) break;
                if (d.code !== 'XRAY_NOT_RUNNING' || Date.now() > deadline) { error = d.error; break; }
                await new Promise(r => setTimeout(r, 1000));
            }
        }
    } catch (e) { error = e.message; }

    // Only a state read back from the machine counts as up.
    const [tun, proxy] = await Promise.all([
        fetch('/api/tun/status').then(r => r.json()).catch(() => ({})),
        fetch('/api/proxy/system').then(r => r.json()).catch(() => ({})),
    ]);
    refreshTunStatus();
    refreshSystemProxy();
    const up = kind === 'tun' ? !!tun.running : !!(proxy.enabled && proxy.xrayRunning !== false);
    if (up) return { ok: true };
    if (!aetherState.connected) { aeRouteSheetClose(); return { ok: false, error: 'موتور قطع شد' }; }
    return { ok: false, error };
}

// ============================================================
// Init
// ============================================================
function initAetherModule() {
    const container = document.getElementById('ls-aether');
    if (!container) return;
    container.innerHTML = aetherPanelHtml();
    if (container.parentElement) container.parentElement.style.position = 'relative';
    container.style.cssText = 'position:absolute; inset:0; display:none; flex-direction:column; background:transparent; z-index:10;';

    // Each page's sidebar: its sections, and the last item that leaves for the store.
    AE_PROTOCOLS.forEach((p) => {
        const page = aePage(p);
        if (!page) return;
        page.querySelectorAll('.mv-side-item[data-ae-sec]').forEach((b) => {
            b.onclick = () => aeGoSec(p, b.getAttribute('data-ae-sec'));
        });
        const back = page.querySelector('[data-ae-back]');
        if (back) back.onclick = () => aeGoSec(p, 'connect');
        const store = page.querySelector('[data-ae-store]');
        // The core behind all three is one item in the store («هستهٔ ماسک، وایرگارد و وارپ در وارپ»).
        if (store) store.onclick = () => {
            if (typeof window.storeOpenItem === 'function') window.storeOpenItem('core|warp');
            else if (window.MV && MV.wm) MV.wm.open('store');
        };
        aeGoSec(p, 'connect');
    });

    let startTab = 'masque';
    try { startTab = PersistentStorage.getItem('aether_tab') || 'masque'; } catch (e) {}
    switchAetherTab(startTab);
    restoreAetherSettings();
    refreshAetherStatus();
    refreshSystemProxy();
    refreshTunStatus();

    // Both are changed from outside these pages too — the server drops TUN when the engine
    // disconnects, and turning either one on turns the other off. Poll rather than trusting
    // our own last write, while any engine page is on screen.
    if (window.__aetherProxyPoll) clearInterval(window.__aetherProxyPoll);
    window.__aetherProxyPoll = setInterval(() => {
        const shown = AE_PROTOCOLS.some(p => { const el = aePage(p); return el && el.offsetParent !== null; });
        if (shown) { refreshSystemProxy(); refreshTunStatus(); }
    }, 4000);

    // Persist settings whenever the user changes anything. The listener sits on each page, since
    // on the desktop the pages move into their own windows. The proxy and tunnel switches are
    // live state, not saved settings, so they are not written into the settings blob.
    AE_PROTOCOLS.forEach(p => {
        const page = aePage(p);
        if (!page) return;
        page.addEventListener('change', (e) => {
            const t = e.target;
            if (t && t.classList && (t.classList.contains('ae-sysproxy-toggle') || t.classList.contains('ae-tun-toggle'))) return;
            saveAetherSettings();
        });
    });
}
