// --- Comprehensive guide (tab) ---
// Was a modal whose close button called an undefined hideModal(), and whose newer
// sections were appended as a visibly separate block. Now a real editor tab, like the
// DNS cleanup screen: scrollable, with a topic rail, and every topic rendered from ONE
// data structure so nothing looks bolted on.
//
// ADDING A TOPIC: append to GUIDE_TOPICS. Nothing else needs editing — the rail, the
// scroll-spy and the body all read from it.

const GUIDE_TOPICS = [
    {
        id: 'scanner',
        icon: 'ph-radar',
        title: 'اسکنر و تب‌ها',
        lead: 'موتور اسکن سه مرحله‌ای است و هر تب یک اسکن مستقل با تنظیمات خودش دارد.',
        items: [
            { t: 'مرحله ۱ — پینگ و پورت', d: 'بررسی می‌شود که آی‌پی زنده است و پورت‌های HTTPS/HTTP باز هستند.' },
            { t: 'مرحله ۲ — مالکیت و ASN', d: 'تأیید می‌شود آی‌پی واقعاً متعلق به ارائه‌دهنده‌ی انتخاب‌شده است.' },
            { t: 'مرحله ۳ — تست عبور از فیلترینگ', d: 'با کانفیگ پایه‌ای که وارد کرده‌اید، عبور واقعی از فیلترینگ سنجیده می‌شود. بدون این کانفیگ، اسکن فقط سالم بودن آی‌پی را می‌گوید نه قابل استفاده بودنش را.' },
            { t: 'تنظیمات سایدبار', d: 'انتخاب ارائه‌دهندگان (کلادفلر، آکامای و...)، حداکثر پینگ مجاز، و تعداد آی‌پی خروجی.' },
            { t: 'چند تب هم‌زمان', d: 'هر تب حالت و نتایج خودش را نگه می‌دارد؛ می‌توانید یک اسکن را رها کنید و سراغ دیگری بروید.' },
        ],
    },
    {
        id: 'cloud',
        icon: 'ph-cloud',
        title: 'استقرار خودکار ابری',
        lead: 'حساب کلادفلر خودتان را یک بار ثبت می‌کنید و بقیه‌ی بخش‌ها از همان استفاده می‌کنند.',
        items: [
            { t: 'افزودن حساب', d: 'ایمیل و Global API Key یا یک API Token. اعتبارش همان‌جا بررسی می‌شود.' },
            { t: 'استقرار Worker', d: 'کد روی حساب خودتان مستقر می‌شود؛ هیچ سروری در میان نیست.' },
            { t: 'نام‌گذاری ضد شناسایی', d: 'نام Worker و ساب‌دامین طوری ساخته می‌شوند که کلمات پرچم‌دار نداشته باشند، چون یک نام حساس می‌تواند کل دامنه را مسدود کند.' },
            { t: 'مدیریت ورکرها', d: 'از منوی همبرگری بالا، فهرست و حذف ورکرهای ساخته‌شده.' },
        ],
    },
    {
        id: 'gst',
        icon: 'ph-google-logo',
        title: 'تونل گوگل اسکریپت (GST)',
        badge: 'جدید',
        lead: 'ترافیک از داخل زیرساخت خود گوگل عبور می‌کند، پس از دید فیلترینگ شبیه یک ارتباط عادی با گوگل دیده می‌شود.',
        items: [
            { t: 'ویزارد مرحله‌ای', d: 'هر صفحه فقط یک کار: گواهی امنیتی، رمز، Worker کلادفلر، اسکریپت گوگل، و تست واقعی.' },
            { t: 'چند ریلی — بدون محدودیت', d: 'هر حساب گوگل حدود ۲۰ هزار درخواست در روز دارد. هر ریلی جدید یعنی سهمیه‌ی بیشتر، و بار خودکار بین همه پخش می‌شود.' },
            { t: 'ترکیب اختیاری با کلادفلر', d: 'برای هر ریلی جداگانه روشن یا خاموش می‌شود. بدون کلادفلر هم کاملاً کار می‌کند — کلادفلر فقط سریع‌ترش می‌کند.' },
            { t: 'نکته‌ی مهم درباره‌ی سوییچ کلادفلر', d: 'مسیر واقعی را یک خط داخل اسکریپت گوگل تعیین می‌کند که روی سرور گوگل است. پس تا اسکریپت را دوباره Deploy نکنید، تغییر سوییچ اعمال نمی‌شود — برنامه همان دو خطی که باید عوض شود را نشانتان می‌دهد.' },
            { t: 'تب سلامت', d: 'برای هر ریلی دو چراغ مستقل (گوگل و کلادفلر). اگر فقط Worker خراب باشد، ریلی روی مسیر مستقیم به کار ادامه می‌دهد و تونل قطع نمی‌شود.' },
            { t: 'تست ترکیب', d: 'با مقایسه‌ی آی‌پی خروجی از دو مسیر ثابت می‌کند ترافیک واقعاً از Worker رد می‌شود — نه اینکه به تنظیمات اعتماد کند.' },
            { t: 'تب مسیر شبکه', d: 'اسکن واقعی آی‌پی‌های تمیز گوگل و تست SNI. چند مورد را تیک بزنید تا تونل بینشان بچرخد و با از کار افتادن یکی قطع نشود.' },
            { t: 'پشتیبان‌گیری', d: 'همه‌ی ریلی‌ها در یک لینک رمزنگاری‌شده بسته‌بندی می‌شوند. لینک و رمزش را از دو راه جداگانه بفرستید.' },
        ],
    },
    {
        id: 'modes',
        icon: 'ph-plugs-connected',
        title: 'سه حالت اتصال',
        badge: 'جدید',
        lead: 'در پنل تونل گوگل اسکریپت و موتورهای ماسک، وایرگارد و وارپ در وارپ یکی از این سه را انتخاب می‌کنید.',
        items: [
            { t: 'فقط تونل محلی', d: 'چیزی در ویندوز تغییر نمی‌کند. خودتان مرورگر یا برنامه را روی پروکسی محلی تنظیم می‌کنید. سبک‌ترین حالت.' },
            { t: 'پروکسی سیستم', d: 'مرورگر و برنامه‌های سازگار از تونل رد می‌شوند. بازی‌ها و برنامه‌هایی که پروکسی را نمی‌شناسند، نه.' },
            { t: 'تونل سراسری', d: 'همه‌ی ترافیک، بدون نشت. تنها حالتی که DNS و QUIC هم پوشش داده می‌شوند.' },
            { t: 'چرا دو حالت آخر با هم جمع نمی‌شوند', d: 'تونل سراسری مسیر پیش‌فرض شبکه را می‌گیرد. اگر پروکسی هم روشن باشد، ترافیک در حلقه می‌افتد. پس انتخاب هرکدام، دیگری را خاموش می‌کند.' },
            { t: 'بسته شدن ناگهانی برنامه', d: 'اگر برنامه از Task Manager بسته شود، در اجرای بعدی تنظیمات ویندوز خودکار ترمیم می‌شود تا بدون اینترنت نمانید.' },
        ],
    },
    {
        id: 'aether',
        icon: 'ph-lightning',
        title: 'ماسک، وایرگارد، وارپ در وارپ — سه موتور',
        lead: 'سه موتور جدا روی WARP کلادفلر، هرکدام با آیکون و پنجره‌ی خودش؛ بسته به شبکه‌ی شما یکی بهتر جواب می‌دهد.',
        items: [
            { t: 'وایرگارد', d: 'سبک و سریع، با کم‌ترین مصرف. ولی الگوی ترافیکش شناخته‌شده است و روی شبکه‌های سخت‌گیر ممکن است بسته شود.' },
            { t: 'ماسک', d: 'ترافیک داخل HTTP/3 پنهان می‌شود، پس شبیه بازدید عادی از یک سایت دیده می‌شود. برای شبکه‌های سخت‌گیر بهترین گزینه.' },
            { t: 'وارپ در وارپ', d: 'دو لایه پشت سر هم. کندتر است ولی وقتی لایه‌ی اول شناسایی شده باشد کار می‌کند.' },
            { t: 'پروفایل مبهم‌سازی', d: 'اگر «سبک» جواب نداد «تهاجمی» را امتحان کنید — مخصوصاً وقتی تونل سراسری وصل می‌شود ولی دیتا رد نمی‌شود.' },
        ],
    },
    {
        id: 'dnsclean',
        icon: 'ph-broom',
        title: 'پاک‌سازی عمیق DNS',
        badge: 'جدید',
        lead: 'از منوی همبرگری بالا. اگر DNS را روی «خودکار» گذاشته‌اید ولی باز همان قبلی می‌ماند، اینجا جوابش است.',
        items: [
            { t: 'چرا «خودکار» کافی نیست', d: 'خودکار یعنی «هرچه روتر گفت». اگر روتر شما شکن پخش کند، خودکار یعنی همان شکن. تنها راه، تنظیم صریح یک DNS دیگر است.' },
            { t: 'بررسی DNS فعلی', d: 'نشان می‌دهد DNS دقیقاً از کجا می‌آید: روتر (DHCP)، تنظیم دستی کارت شبکه، کارت‌های غیرفعال، DNS رمزنگاری‌شده‌ی ویندوز ۱۱، یا قوانین NRPT. هرکدام دکمه‌ی پاک کردن جداگانه دارد.' },
            { t: 'فهرست DNSها', d: 'ایرانی و جهانی، با تست زنده. تست با پرس‌وجوی واقعی انجام می‌شود نه ping، چون خیلی از این سرورها ping را جواب نمی‌دهند ولی DNS را می‌دهند.' },
            { t: 'هشدار درباره‌ی DNSهای تحریم‌شکن', d: 'این‌ها فقط دامنه‌های فهرست خودشان را می‌شناسند و بقیه را ناموجود اعلام می‌کنند. مثلاً با شکن، آدرس‌های workers.dev باز نمی‌شوند.' },
            { t: 'پشتیبان و بازگردانی', d: 'تنظیم قبلی قبل از اولین تغییر ذخیره می‌شود و هر وقت خواستید برمی‌گردد.' },
        ],
    },
    {
        id: 'dedidns',
        icon: 'ph-globe-hemisphere-west',
        title: 'DNS اختصاصی',
        badge: 'جدید',
        lead: 'یک DNS رمزنگاری‌شده روی Worker شخصی خودتان که خودکار روی همه‌ی سایت‌ها اعمال می‌شود.',
        items: [
            { t: 'عبور از فیلترینگ DNS', d: 'پرس‌وجوها رمزنگاری شده‌اند، پس قابل دستکاری نیستند.' },
            { t: 'هدایت منطقه‌ای', d: 'با انتخاب منطقه، نزدیک‌ترین سرور بازی یا CDN انتخاب می‌شود و پینگ پایین می‌آید.' },
            { t: 'روی حساب خودتان', d: 'ترافیک از کلادفلر خودتان می‌گذرد، نه یک سرور اشتراکی.' },
        ],
    },
    {
        id: 'sanction',
        icon: 'ph-lock-open',
        title: 'تحریم‌شکن',
        badge: 'جدید',
        lead: 'سایت‌های تحریمی را باز می‌کند — آن‌هایی که خودشان آی‌پی ایران را بلاک کرده‌اند، نه آن‌هایی که فیلتر شده‌اند.',
        items: [
            { t: 'تشخیص خودکار', d: 'تحریم (پاسخ ۴۰۳ می‌آید) از فیلتر (اتصال قطع می‌شود) تشخیص داده می‌شود.' },
            { t: 'فقط دامنه‌های مجاز', d: 'کل ترافیک از رله رد نمی‌شود، پس سرعت بقیه‌ی اینترنت دست‌نخورده می‌ماند.' },
            { t: 'در ویزارد گوگل اسکریپت', d: 'اگر برای رسیدن به صفحه‌ی گوگل لازم باشد، خودکار و بی‌صدا روشن و در پایان به حالت اول برگردانده می‌شود.' },
        ],
    },
    {
        id: 'sni',
        icon: 'ph-shield',
        title: 'موتور ضد فیلتر (SNI)',
        lead: 'با بازنویسی نام دامنه در دست‌دادن TLS، ترافیک را از دید بازرسی عمیق پنهان می‌کند.',
        items: [
            { t: 'تست SNI', d: 'مشخص می‌کند کدام نام‌ها روی شبکه‌ی شما عبور می‌کنند. بعضی نام‌ها روی همان آی‌پی مسدودند و بعضی نه.' },
            { t: 'چند SNI', d: 'انتخاب چند مورد باعث می‌شود با مسدود شدن یکی، اتصال قطع نشود.' },
        ],
    },
];

let guideActive = GUIDE_TOPICS[0].id;

function guideEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function guideTopicHtml(topic) {
    return `
    <section class="gd-topic" id="gd-sec-${guideEsc(topic.id)}">
      <div class="gd-topic-head">
        <i class="ph-bold ${guideEsc(topic.icon)}"></i>
        <h3>${guideEsc(topic.title)}</h3>
        ${topic.badge ? `<span class="gd-badge">${guideEsc(topic.badge)}</span>` : ''}
      </div>
      <p class="gd-lead">${guideEsc(topic.lead)}</p>
      <div class="gd-items">
        ${topic.items.map(it => `
          <div class="gd-item">
            <div class="gd-item-t">${guideEsc(it.t)}</div>
            <div class="gd-item-d">${guideEsc(it.d)}</div>
          </div>`).join('')}
      </div>
    </section>`;
}

window.renderGuideTab = function () {
    let root = document.getElementById('guide-root');
    if (!root) {
        root = document.createElement('div');
        root.id = 'guide-root';
        // min-h-0 + overflow-hidden so the inner column can actually scroll.
        root.className = 'w-full h-full flex flex-col min-h-0 overflow-hidden';
        root.dir = 'rtl';
        const wrap = document.getElementById('editor-content-wrap');
        if (wrap) wrap.appendChild(root);
    }
    root.style.display = 'flex';
    if (typeof updateBreadcrumb === 'function') updateBreadcrumb('راهنمای جامع');

    root.innerHTML = `
    <div class="gd-shell">
      <!-- Topic rail. Hidden on narrow widths, where the document simply scrolls. -->
      <nav class="gd-rail">
        ${GUIDE_TOPICS.map(t => `
          <button class="gd-rail-btn ${t.id === guideActive ? 'on' : ''}"
                  onclick="guideGoTo('${guideEsc(t.id)}')">
            <i class="ph-bold ${guideEsc(t.icon)}"></i>
            <span>${guideEsc(t.title)}</span>
            ${t.badge ? `<em>${guideEsc(t.badge)}</em>` : ''}
          </button>`).join('')}
      </nav>

      <div class="gd-body" id="gd-body">
        <div class="gd-hero">
          <div>
            <div class="gd-hero-title">راهنمای جامع نرم‌افزار</div>
            <div class="gd-hero-sub">
              هر بخش دقیقاً مطابق آنچه در برنامه پیاده‌سازی شده توضیح داده شده است.
            </div>
          </div>
          <i class="ph-bold ph-book-open"></i>
        </div>

        ${GUIDE_TOPICS.map(guideTopicHtml).join('')}

        <div class="gd-footer">
          تمامی حقوق و کدهای این نرم‌افزار متعلق به تیم MLMVPN می‌باشد. (نسخه 1.2.0)
        </div>
      </div>
    </div>

    <style>
      .gd-shell { flex:1; min-height:0; display:flex; gap:0; overflow:hidden;
                  color:var(--ide-text-main,#EDEDED); font-size:12px; }

      .gd-rail { width:230px; flex:none; padding:16px 12px; display:flex; flex-direction:column;
                 gap:3px; overflow-y:auto; border-left:1px solid var(--ide-border,#222);
                 background:var(--ide-sidebar,#111); }
      .gd-rail-btn { display:flex; align-items:center; gap:9px; padding:9px 11px; border-radius:10px;
                     background:transparent; border:none; cursor:pointer; font-family:inherit;
                     font-size:12px; color:var(--ide-text-muted,#8B8B8B); text-align:right; }
      .gd-rail-btn:hover { background:var(--mv-fill); color:var(--ide-text-main,#EDEDED); }
      .gd-rail-btn.on { background:color-mix(in srgb, var(--mv-blue) 12%, transparent); color:var(--mv-blue-ink); font-weight:700; }
      .gd-rail-btn i { font-size:15px; flex:none; }
      .gd-rail-btn span { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis;
                          white-space:nowrap; }
      .gd-rail-btn em { font-style:normal; font-size:9px; font-weight:700; padding:1px 6px;
                        border-radius:9999px; background:color-mix(in srgb, var(--mv-green) 18%, transparent); color:var(--mv-green-ink); }

      /* The scroll container. flex:1 + min-height:0 is what lets it shrink and scroll. */
      .gd-body { flex:1; min-width:0; min-height:0; overflow-y:auto;
                 padding:20px 26px 40px; display:flex; flex-direction:column; gap:18px; }

      .gd-hero { flex-shrink:0; display:flex; align-items:center; justify-content:space-between; gap:16px;
                 padding:18px 20px; border-radius:16px;
                 background:linear-gradient(135deg, color-mix(in srgb, var(--mv-blue) 14%, transparent), color-mix(in srgb, var(--mv-blue) 4%, transparent));
                 border:1px solid color-mix(in srgb, var(--mv-blue) 26%, transparent); }
      .gd-hero-title { font-size:17px; font-weight:800; }
      .gd-hero-sub { font-size:12px; color:var(--ide-text-muted,#8B8B8B); margin-top:4px;
                     line-height:1.9; }
      .gd-hero i { font-size:30px; color:var(--mv-blue-ink); flex:none; }

      /* Same reason as the changelog's version card: .gd-body is a flex column, so a
         topic taller than the remaining space would be shrunk rather than scrolled to. */
      .gd-topic { flex-shrink:0; scroll-margin-top:12px; display:flex; flex-direction:column; gap:10px; }
      .gd-topic-head { display:flex; align-items:center; gap:9px; }
      .gd-topic-head i { font-size:18px; color:var(--mv-blue-ink); }
      .gd-topic-head h3 { font-size:14.5px; font-weight:800; margin:0; }
      .gd-badge { font-size:9.5px; font-weight:700; padding:2px 9px; border-radius:9999px;
                  background:color-mix(in srgb, var(--mv-green) 18%, transparent); color:var(--mv-green-ink); }
      .gd-lead { font-size:12px; line-height:2; color:var(--ide-text-muted,#8B8B8B); }

      .gd-items { display:grid; gap:10px; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); }
      .gd-item { padding:11px 13px; border-radius:12px;
                 background:var(--ide-panel,#141414); border:1px solid var(--ide-border,#222); }
      .gd-item-t { font-size:12px; font-weight:700; margin-bottom:4px; }
      .gd-item-d { font-size:11.5px; line-height:2; color:var(--ide-text-muted,#8B8B8B); }

      .gd-footer { margin-top:8px; padding-top:14px; text-align:center; font-size:11px;
                   color:var(--ide-text-muted,#8B8B8B);
                   border-top:1px solid var(--ide-border,#222); }

      @media (max-width: 900px) { .gd-rail { display:none; } }
    </style>`;

    guideBindSpy();
};

/** Jump to a topic and mark it active. */
window.guideGoTo = function (id) {
    guideActive = id;
    const sec = document.getElementById('gd-sec-' + id);
    if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.querySelectorAll('#guide-root .gd-rail-btn').forEach(b => {
        b.classList.toggle('on', b.getAttribute('onclick').includes(`'${id}'`));
    });
};

/**
 * Highlight the rail entry for whatever is on screen.
 * Plain scroll maths rather than IntersectionObserver: observer callbacks have proven
 * unreliable in this app's embedder, and a rail that silently stops tracking is worse
 * than a few cheap comparisons per scroll event.
 */
function guideBindSpy() {
    const body = document.getElementById('gd-body');
    if (!body) return;
    let queued = false;

    body.addEventListener('scroll', () => {
        if (queued) return;
        queued = true;
        setTimeout(() => {
            queued = false;
            const top = body.getBoundingClientRect().top;
            let current = GUIDE_TOPICS[0].id;
            for (const t of GUIDE_TOPICS) {
                const sec = document.getElementById('gd-sec-' + t.id);
                if (sec && sec.getBoundingClientRect().top - top <= 80) current = t.id;
            }
            if (current === guideActive) return;
            guideActive = current;
            document.querySelectorAll('#guide-root .gd-rail-btn').forEach(b => {
                b.classList.toggle('on', b.getAttribute('onclick').includes(`'${current}'`));
            });
        }, 120);
    });
}

/** Entry point — opens as a tab, the same as the DNS cleanup screen. */
window.openGuideTab = function () {
    const existing = tabs.find(t => t.type === 'guide');
    if (existing) { switchTab(existing.id); return; }

    const id = 'tab_' + Date.now();
    tabs.push({
        id, isp: 'راهنما', state: 'done', type: 'guide',
        total: 0, tested: 0, alive: 0, dead: 0, results: [], settings: {},
    });
    switchTab(id);

    const btnScan = document.getElementById('btn-tab-scan');
    if (btnScan) btnScan.click();
};

// The old modal is gone; anything still calling showModal('guide-modal') should land on
// the tab rather than doing nothing.
function initGuideModule() {
    const container = document.getElementById('guide-module-container');
    if (container) container.innerHTML = '';
}
