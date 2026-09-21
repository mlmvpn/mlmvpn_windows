// --- «ام‌ال‌ام استور» ---
//
// One window where every part of this app is updated: the engine cores on this machine, the panels
// on the user's own Cloudflare account, the gateways on their Railway account, and the app itself.
//
// IT IS REAL NOW. Every number on this page is measured: the installed version comes from running
// the binary's own version flag, the available version from a digest this app trusts, the worker
// versions from the code actually deployed on Cloudflare, and every button does the thing it says.
// The ratings, install counts and age ratings the first version of this page borrowed from the App
// Store are gone — a made-up 4.7 next to a real "this engine is two releases behind" teaches the
// user to distrust both. What replaced them is the App Store's SHAPE (a discover page, a product
// page per item, an updates page) with facts in it.
//
// WHAT THE STATES MEAN, because the wording is the product here:
//   بروزرسانی دارد   a version this app has tested is newer than what is installed/deployed
//   بروز است         installed matches the tested version
//   بررسی نشده       nothing could be read — never dressed up as "up to date"
//   نصب نشده         the file should be here and is not
//
// Renders into #ls-store. Facts come from /api/store/catalog (no network); everything that touches
// the network is a job the page polls through /api/store/jobs.

(function () {
    'use strict';

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Persian digits, so a number inside a Persian sentence is not half Latin. */
    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);

    const icon = (id) => (window.MV && window.MV.icons && window.MV.icons.svg)
        ? window.MV.icons.svg(id) : '';

    /**
     * A Latin run inside an RTL line, isolated.
     *
     * Without this the bidi algorithm hands the trailing punctuation to the paragraph direction and
     * "Psiphon Inc." renders as ".Psiphon Inc" — measured on this page. Used for every version,
     * repository, file path and script name, which are the only Latin values here.
     */
    const ltr = (t) => '<bdi dir="ltr">' + esc(t) + '</bdi>';

    const PARA = '@@';

    // ── presentation ─────────────────────────────────────────────────────────
    //
    // The only thing this table carries is what a binary cannot: a Persian description, an icon and
    // a tint. Versions, sizes, states and everything else come from the server.

    const LOOK = {
        xray: { icon: 'g-bolt', tint: 'blue', dev: 'XTLS',
            sub: 'موتور کانفیگ‌ها — وی‌لس، وی‌مس، تروجان، شدوساکس',
            desc: 'هسته‌ای که همهٔ کانفیگ‌های این برنامه روی آن اجرا می‌شوند: پنل V2Ray، کانفیگ رایگان، کانفیگ ایران و زیرساخت ابری. پروتکل‌های وی‌لس، وی‌مس، تروجان و شدوساکس را می‌فهمد و ترابری‌های WebSocket و gRPC و XHTTP و REALITY را پشتیبانی می‌کند.' + PARA + 'پروفایل «تکه‌کردن و اثرانگشت TLS» این برنامه هم روی همین هسته سوار است و به نسخهٔ ۲۶.۷.۲۸ به بالا نیاز دارد؛ استور نمی‌گذارد نسخه‌ای پایین‌تر از آن فعال شود.' },
        singbox: { icon: 'g-layers', tint: 'indigo', dev: 'SagerNet',
            sub: 'تونل سطح سیستم و مسیریابی برنامه‌ها',
            desc: 'وقتی «تونل» روشن است، این هسته کار می‌کند: یک آداپتور مجازی می‌سازد و ترافیک کل سیستم را از آن رد می‌کند. مسیریابی به‌ازای برنامه، حالت‌های «فقط این برنامه‌ها» و «همه جز این‌ها»، و ربودن درخواست‌های DNS هم کار همین هسته است.' },
        tor: { icon: 'g-shield', tint: 'purple', dev: 'The Tor Project',
            sub: 'شبکهٔ تور با ترابری‌های obfs4، وب‌تانل و کانجور',
            desc: 'سه لایه رمزنگاری روی همهٔ ترافیک، نه فقط مرورگر. پنج روش اتصال دارد و حالت خودکار از بالا امتحان می‌کند: مستقیم، وب‌تانل، Meek، obfs4 و در آخر Snowflake.' + PARA + 'بستهٔ رسمی تور روی میزبان خودشان است که از ایران بسته است، پس بروزرسانی‌اش از مسیر یکی از موتورهای روشن یا آینهٔ ما انجام می‌شود.' },
        // Two voices, kept apart on purpose: `about` is Psiphon's own account of their core,
        // condensed from the documentation shipped with the tagged source this app builds, and
        // `inApp` is what THIS app does with it and what was measured here. A reader can tell which
        // claims are the developer's and which are ours.
        'iran-configs': { icon: 'g-iran-art', art: true, tint: 'green', dev: 'patterniha',
            sub: 'کانفیگ‌های سرورلس — بدون هیچ سروری در مسیر',
            about: [
                ['این‌ها چه هستند', 'پروژهٔ Serverless-for-Iran: کانفیگ‌هایی که هیچ سروری در مسیر ندارند. مستقیم به خود سایت وصل می‌شوند و فقط دست‌دهی TLS را تکه‌تکه می‌کنند تا فیلترینگِ مبتنی بر نام دامنه نتواند آن را بخواند، و نام‌ها را از یک DNS رمزنگاری‌شده می‌پرسند.'],
                ['محدودیت‌هایی که خود سازنده نوشته', 'سایت‌هایی که آی‌پی‌شان از ایران بسته است با این روش باز نمی‌شوند، و سرویس‌هایی که ایران را تحریم کرده‌اند همچنان شما را با آی‌پی ایران می‌بینند. این روش برای فیلترینگ است، نه برای تحریم.'],
            ],
            inApp: [
                ['۱۹ کانفیگ از ۴ فایل', 'برنامه از دو فایل مرجع این پروژه (fragA و fragB) و دو فایل نسخهٔ قدیمی‌ترش، نوزده کانفیگ می‌سازد: خودِ فایل‌ها دست‌نخورده، همان‌ها با سه DNS دیگر، و سه کانفیگ «فقط DNS تمیز» بدون تکه‌تکه کردن. چون کدام‌یک کار می‌کند به خط شما بستگی دارد نه به کانفیگ.'],
                ['بروزرسانی چطور کار می‌کند', 'این پروژه نسخه و انتشار ندارد؛ دو فایل است که با هر کامیت عوض می‌شود. پس مقایسه با «هش محتوا» انجام می‌شود، و بروزرسانی یعنی: گرفتن دو فایل، ساختن دوبارهٔ هر نوزده کانفیگ، دادن سه‌تایشان به خود xray تا قبول کند، و بعد فعال کردن — با برگشت یک‌کلیکی.'],
                ['چرا امن است هرچند امضای ما را ندارد', 'قبل از فعال شدن ثابت می‌شود که کانفیگ‌ها واقعاً «سرورلس» هستند: هر خروجی باید از نوع بدون‌سرور باشد و هیچ آدرس سروری نداشته باشد. کانفیگی که نتواند ترافیک را به سرور کسی بفرستد، نمی‌شود به پروکسی کسی تبدیلش کرد.'],
            ],
            facts: [
                ['مجوز', 'GPL-3.0'],
                ['کانال تلگرام', 't.me/patt_channel_x'],
            ],
            devBox: {
                name: 'patterniha',
                logo: 'assets/dev/patterniha.jpg',
                line: 'سازندهٔ Serverless-for-Iran. سه پنجرهٔ این برنامه روی کار او ساخته شده‌اند: «کانفیگ ایران» از همین پروژه، «موتور ضد فیلتر SNI» از SNI-Spoofing، و «دامین فرانتینگ» از MITM-DomainFronting. کلاینت‌های خودش هم متن‌بازند: PattN برای ویندوز و لینوکس و مک، و PattNG برای اندروید.',
                links: [
                    ['گیت‌هاب', 'https://github.com/patterniha', 'ph-fill ph-github-logo'],
                    ['مخزن این پروژه', 'https://github.com/patterniha/Serverless-for-Iran', 'ph-fill ph-folder-open'],
                    ['کانال تلگرام', 'https://t.me/patt_channel_x', 'ph-fill ph-telegram-logo'],
                ],
            } },
        'mitm-config': { icon: 'g-swap', tint: 'yellow', dev: 'patterniha',
            sub: 'کانفیگ دامین فرانتینگ — بدون سرور، بدون ورکر',
            about: [
                ['این چیست', 'پروژهٔ MITM-DomainFronting: یک کانفیگ Xray که هیچ سروری در مسیر ندارد. دو ورودی محلی، دست‌دهی TLS را با گواهی‌ای که روی همین کامپیوتر ساخته می‌شود خاتمه می‌دهند، مقصد واقعی را می‌خوانند و اتصال را زیر نام دامنه‌ای که فیلتر نیست دوباره باز می‌کنند — یوتیوب، اینستاگرام، واتس‌اپ، فیسبوک و ردیت.'],
                ['چرا یک کانفیگ برای همه کافی است', 'چون نه رازی مخصوص هر کاربر در آن هست و نه پهنای باندی که کسی بپردازد: ترافیک مستقیم از خط خودتان به همان سرویس‌ها می‌رود، فقط زیر نامی دیگر.'],
            ],
            inApp: [
                ['تنها تفاوت نسخهٔ ما', 'کانفیگ سازنده گواهی را کنار فایل اجرایی و با نام نمونه صدا می‌زند. این برنامه برای هر کامپیوتر گواهی جداگانه می‌سازد و مسیر واقعی آن را هنگام اجرا می‌نویسد، پس در نسخهٔ ذخیره‌شده جای آن دو مسیر، نشانه‌گذاری هست. بروزرسانی همین یک تبدیل را دوباره انجام می‌دهد و می‌شمارد که دقیقاً دو گواهی و دو کلید پیدا کرده باشد.'],
                ['بروزرسانی چطور کار می‌کند', 'این پروژه هم نسخه و انتشار ندارد؛ یک فایل است که با کامیت عوض می‌شود. پس مقایسه با هش محتوا انجام می‌شود، و قبل از فعال شدن: فایل پارس می‌شود، ثابت می‌شود که هیچ خروجی‌اش سرور ندارد، و با گواهی واقعی همین کامپیوتر به خود xray داده می‌شود تا قبول کند.'],
            ],
            facts: [
                ['مجوز', 'GPL-3.0'],
                ['کانال تلگرام', 't.me/patt_channel_x'],
            ],
            devBox: {
                name: 'patterniha',
                logo: 'assets/dev/patterniha.jpg',
                line: 'سازندهٔ MITM-DomainFronting. سه پنجرهٔ این برنامه روی کار او ساخته شده‌اند: «دامین فرانتینگ» از همین پروژه، «کانفیگ ایران» از Serverless-for-Iran، و «موتور ضد فیلتر SNI» از SNI-Spoofing.',
                links: [
                    ['گیت‌هاب', 'https://github.com/patterniha', 'ph-fill ph-github-logo'],
                    ['مخزن این پروژه', 'https://github.com/patterniha/MITM-DomainFronting', 'ph-fill ph-folder-open'],
                    ['کانال تلگرام', 'https://t.me/patt_channel_x', 'ph-fill ph-telegram-logo'],
                ],
            } },
        psiphon: { icon: 'g-psiphon-art', art: true, tint: 'red', dev: 'Psiphon Inc.',
            sub: 'سامانهٔ عبور از سانسور اینترنت، با هستهٔ رسمی خودش',
            about: [
                ['سایفون چیست', 'سامانه‌ای برای عبور از سانسور اینترنت، ساختهٔ شرکت سایفون (Psiphon Inc). برنامه روی دستگاه شما تونلی تا یکی از سرورهای پروکسی سایفون می‌سازد و ترافیک از آن‌جا به اینترنت می‌رود — جایی بیرون از دسترس نهادی که اینترنت شما را سانسور می‌کند. دو حالت مسیریابی دارد: پروکسی محلی (SOCKS و HTTP) که سیستم یا تک‌تک برنامه‌ها روی آن تنظیم می‌شوند، و تونل بسته‌ای که بسته‌های IP را میان یک آداپتور مجازی و سرور جابه‌جا می‌کند.'],
                ['امن و پنهان', 'هستهٔ هر تونل یک اتصال SSH است که محرمانگی و درستیِ ترافیک را میان دستگاه شما و سرور نگه می‌دارد، و کلاینت هویت سرور را با کلیدهای عمومیِ از پیش توزیع‌شده می‌سنجد تا فقط به سرورهای اصلی سایفون وصل شود. روی آن لایه‌های مبهم‌سازی می‌نشینند: ترافیک را کاملاً تصادفی یا شبیه پروتکل‌های پرکاربرد نشان می‌دهند، اندازه و زمان‌بندی بسته‌ها را می‌پوشانند، یا اتصال را به‌جای مستقیم از راه واسطه‌ها برقرار می‌کنند — به گفتهٔ سازنده در برابر مسدودسازی آدرس، مسدودسازی کلیدواژه و بازرسی عمیق بسته‌ها (DPI).'],
                ['سرور را چطور پیدا می‌کند', 'مشخصات هر سرور در قالب «server entry» به کلاینت می‌رسد: بخشی درون خود برنامه جاسازی شده، بخشی پس از هر اتصال موفق کشف می‌شود، و بخشی از مسیرهای جداگانه می‌آید و با کلیدهای عمومیِ درون کلاینت تأیید می‌شود — همه بخش‌بندی‌شده، تا کسی نتواند فهرست کامل سرورها را یک‌جا دربیاورد. هنگام اتصال، چند سرور و چند روش پنهان‌سازی هم‌زمان امتحان می‌شوند و سریع‌ترینِ کارا انتخاب می‌شود؛ همان ترکیب به خاطر سپرده می‌شود و دفعهٔ بعد اول امتحان می‌شود. پارامترهای تازه هم با سازوکاری به نام «tactics» از راه دور به کلاینت می‌رسند.'],
                ['متن‌باز', 'هستهٔ سایفون (psiphon-tunnel-core) شامل کلاینت و سرور است، به زبان Go نوشته شده و با مجوز GPL-3.0 منتشر می‌شود. به گفتهٔ سازنده کد کلاینت‌های اندروید، iOS و ویندوز هم متن‌باز و روی گیت‌هاب در دسترس است.'],
            ],
            inApp: [
                ['سه رتبهٔ اتصال', 'این برنامه سایفون را به‌ترتیب در سه رتبه امتحان می‌کند: اول دامین‌فرانتینگ از راه CDN — روی خطی که آدرس سرورها را کامل بسته، معمولاً تنها چیزی که بالا می‌آید — بعد همهٔ پروتکل‌ها به‌صورت مستقیم، و در آخر رله از راه کاربران داوطلب دیگر، که آدرس‌هایشان خانگی است و در هیچ فهرست مسدودی نیست. رتبه‌ای که واقعاً تونل را ساخت برای اتصال بعدیِ همین دستگاه اول می‌آید. می‌توانید در صفحهٔ سایفون یک رتبه را دستی هم انتخاب کنید.'],
                ['اندازه‌گیری روی خط ایران', 'رتبهٔ دامین‌فرانتینگ در آزمایش‌های این برنامه در ۱۰ تا ۲۱ ثانیه وصل شد، با پروتکل FRONTED-MEEK-OSSH. «tactics» روی دو رتبهٔ اول عمداً خاموش است: پارامترهای دانلودشده رتبهٔ فرانتینگ را به‌سمت رله می‌کشاندند و کل بودجه‌اش بی‌نتیجه تمام می‌شد — با خاموش کردنش همان رتبه در ۱۰ ثانیه وصل شد. رتبهٔ رله آن را روشن نگه می‌دارد، چون بدون آن به بروکر نمی‌رسد.'],
                ['چرا این نسخه', 'سازنده برای ویندوز فایل آمادهٔ اجرا منتشر نمی‌کند (انتشارهایشان کتابخانهٔ اندروید و iOS است)، پس این هسته از روی سورس رسمیِ برچسب‌خورده ساخته می‌شود و با امضای همین برنامه منتشر می‌شود؛ نسخهٔ همراه این بیلد همان برچسبی است که برنامهٔ اندروید ما هم روی آن است. نسخهٔ ۲.۰.۴۱ هم ساخته و آزموده شد: به سرورها می‌رسید ولی دست‌دهی‌اش رد می‌شد، در حالی که نسخهٔ فعلی روی همان خط در ۱۱ ثانیه وصل شد — پس آن بیلد منتشر نشد.'],
            ],
            facts: [
                ['وب‌سایت سازنده', 'psiphon.ca'],
                ['مجوز', 'GPL-3.0'],
                ['زبان', 'Go'],
            ] },
        geph: { icon: 'g-geph-art', art: true, tint: 'blue', dev: 'Geph Official',
            sub: 'بروکر دامین‌فرانت‌شده — تنها موتوری که UDP می‌برد',
            desc: 'بروکرش دامین‌فرانت شده، برای همین روی خط‌هایی که آدرس مستقیمش بسته است هم بالا می‌آید. در سنجش گیم بوستر تنها موتوری بود که ترافیک UDP را هم عبور داد.' + PARA + 'نسخهٔ ویندوزی آماده ندارد و از سورس ساخته می‌شود؛ پیش از فعال شدن، کانفیگ واقعی برنامه به هستهٔ تازه داده می‌شود تا مطمئن شویم می‌پذیردش.' },
        lantern: { icon: 'g-lantern-art', art: true, tint: 'teal', dev: 'Brave New Software',
            sub: 'سرورهایش را خودش پیدا و رتبه‌بندی می‌کند',
            desc: 'فهرست سرورهایش را از راه دامین‌فرانتینگ می‌گیرد، پس حتی روی خطی که آدرس سرورها بسته است هم به فهرست می‌رسد. چیزی برای انتخاب کردن ندارد؛ خروجی بعد از اتصال گزارش می‌شود.' },
        // Aether is CluvexStudio's project — their words, their logo, their links; and separately,
        // what THIS app does with it. The two are never mixed.
        warp: { icon: 'g-key', img: 'assets/dev/cluvexstudio.jpg', tint: 'green', dev: 'Cluvex Studio',
            sub: 'هستهٔ راستِ وارپ — MASQUE روی HTTP/3 و HTTP/2',
            about: [
                ['ایتر چیست', 'به گفتهٔ سازنده، Aether یک کلاینت عبور از سانسور است که برای شبکه‌های به‌شدت محدود طراحی شده: خودش مسیرهای در دسترس را کشف می‌کند، یک تونل رمزنگاری‌شده برقرار می‌کند و یک پروکسی SOCKS5 محلی در اختیار برنامه‌های شما می‌گذارد. برخلاف کلاینت‌های معمول VPN، برای محیط‌هایی ساخته شده که بازرسی عمیق بسته‌ها (DPI)، اثرانگشت‌گیری از پروتکل، محدود کردن UDP و مسدودسازی نقطهٔ پایانی در آن‌ها عادی است.'],
                ['چه چیزهایی دارد', 'کشف خودکار اندپوینت، با اعتبارسنجی مسیر داده — یک گیت‌وی فقط وقتی پذیرفته می‌شود که واقعاً ترافیک را عبور دهد، نه وقتی صرفاً به دست‌دهی جواب بدهد. MASQUE روی HTTP/3 و HTTP/2، با فرگمنتِ اختیاری ClientHello روی HTTP/2. وایرگارد، وایرگاردِ تودرتو (gool) و MASQUE تودرتو برای گرفتن آدرس خروجی دیگر. مبهم‌سازی ترافیک؛ قواعد مسیریابی بر اساس دامنه، آدرس یا پورت؛ پشتیبانی از پروکسی بالادست؛ خروج اختیاری از تور؛ اتصال دوبارهٔ خودکار و بازگشت سریع به آخرین گیت‌وی سالم.'],
                ['متن‌باز', 'به زبان Rust نوشته شده و با مجوز AGPL-3.0 منتشر می‌شود؛ فایل آمادهٔ ویندوز، مک، لینوکس و اندروید (ترماکس) در بخش Releases مخزن هست و هر فایل، هش SHA-256 خودش را همراه دارد.'],
            ],
            inApp: [
                ['یک هسته، سه برنامه', 'این برنامه از همین یک هسته سه محصول می‌سازد که هر کدام پنجرهٔ خودش را دارد: «ماسک» روی MASQUE، «وایرگارد»، و «وارپ در وارپ» (همان gool). هر بار فقط یکی از آن‌ها می‌تواند روشن باشد.'],
                ['چرا نسخهٔ ما، نه فایل آمادهٔ سازنده', 'وصله‌های اسکن این برنامه روی هسته اعمال شده‌اند — خروجی مرحله‌به‌مرحله‌ای که پنجره‌های موتور از آن می‌خوانند و پیشرفت اسکن گیت‌وی را نشان می‌دهند. برای همین هر نسخهٔ تازه هم باید با همان وصله‌ها ساخته، آزموده و امضا شود؛ فایل آمادهٔ مخزن مستقیماً جایگزین نمی‌شود.'],
                ['نسخهٔ تازهٔ سازنده', 'نسخهٔ نصب‌شده روی این بیلد ۱.۹.۰ است و سازنده ۲.۰.۰ را منتشر کرده است. با دکمهٔ «بررسی مخزن» می‌توانید همیشه ببینید آخرین انتشار سازنده چیست؛ استور تا وقتی نسخه‌ای با وصله‌های این برنامه ساخته و آزموده نشده باشد، آن را پیشنهاد نمی‌کند.'],
            ],
            facts: [
                ['مجوز', 'AGPL-3.0'],
                ['زبان', 'Rust'],
            ],
            devBox: {
                name: 'Cluvex Studio',
                logo: 'assets/dev/cluvexstudio.jpg',
                line: 'سازندهٔ Aether — هستهٔ متن‌بازی که ماسک، وایرگارد و وارپ در وارپ روی آن کار می‌کنند. کد، انتشارها و راهنمای فارسی‌شان در گیت‌هاب است و اعلان‌های نسخه‌های تازه در کانال تلگرامشان.',
                links: [
                    ['گیت‌هاب پروژه', 'https://github.com/CluvexStudio/Aether', 'ph-fill ph-github-logo'],
                    ['کانال تلگرام', 'https://t.me/CluvexStudio', 'ph-fill ph-telegram-logo'],
                ],
            } },
        gst: { icon: 'g-google', tint: 'yellow', dev: 'MLM',
            sub: 'رله‌های اسکریپت گوگل را می‌راند',
            desc: 'هستهٔ راست که رله‌های Google Apps Script را می‌راند: چند رله، هرکدام با کلودفلر خودش، و مسیر دادهٔ اختصاصی.' },
        tailscale: { icon: 'g-server', tint: 'gray', dev: 'Tailscale',
            sub: 'موتور تونل گیت‌هاب',
            desc: 'همان موتوری که تونل گیت‌هاب روی آن سوار است. فایل‌هایش در پوشهٔ پروفایل کاربر نگه داشته می‌شوند تا نسخهٔ پرتابل هم آن‌ها را از دست ندهد.' },

        bpb: { icon: 'g-cloud', tint: 'orange', dev: 'bia-pain-bache',
            sub: 'پنل وورکر روی حساب کلودفلر خودتان',
            desc: 'پنل وورکر که روی حساب کلودفلر خودتان مستقر شده و کانفیگ می‌سازد. بروزرسانی فقط کد را عوض می‌کند: تنظیمات جاسازی‌شدهٔ پنل — شناسهٔ حساب، UUID، مسیر امن و آی‌پی پروکسی — بی‌کم‌وکاست منتقل می‌شوند و KV دست نمی‌خورد.' },
        zeus: { icon: 'g-cloud', tint: 'indigo', dev: 'panel-zeus',
            sub: 'پنل وورکر با پایگاه‌دادهٔ D1',
            desc: 'پنل وورکر با پایگاه‌دادهٔ D1 که خودش مهاجرت می‌کند. بروزرسانی فقط کد وورکر را عوض می‌کند؛ دیتابیس کاربران و اتصال‌هایش سر جایشان می‌مانند.' },
        edge: { icon: 'g-swap', tint: 'teal', dev: 'cmliu',
            sub: 'پروکسی Edge روی حساب خودتان',
            desc: 'وورکر edgetunnel روی حساب کلودفلر خودتان. نسخه‌اش تاریخ ساخت است، نه شماره.' },
        dns: { icon: 'g-globe', tint: 'blue', dev: 'MLM',
            sub: 'DNS اختصاصی — مکان‌یابی سرور',
            desc: 'وورکری که هر پرسش DNS را با محدودهٔ کشور دلخواه شما بازنویسی می‌کند تا سرور بازی یا CDN نزدیک‌ترین گزینه به آن منطقه را برگرداند.' },
        doh: { icon: 'g-globe', tint: 'green', dev: 'MLM',
            sub: 'DNS اختصاصی — سرعت و پینگ',
            desc: 'همان DNS رمزنگاری‌شده، بدون بازنویسی: سریع‌ترین پاسخ‌دهندهٔ سالم انتخاب و پاسخ در لبهٔ کلودفلر کش می‌شود.' },
        'gst-relay': { icon: 'g-google', tint: 'yellow', dev: 'MLM',
            sub: 'رلهٔ کلودفلر تونل گوگل اسکریپت',
            desc: 'وورکری که هم مسیر ضدتحریم رسیدن به اسکریپت گوگل است و هم شتاب‌دهندهٔ ترافیک رله.' },
        'gt-broker': { icon: 'g-key', tint: 'gray', dev: 'MLM',
            sub: 'سرویس کلید تونل گیت‌هاب',
            desc: 'تنها جایی که اعتبارنامهٔ شبکهٔ امن نگه داشته می‌شود؛ روی حساب خودتان، با امضای مخصوص همین نصب.' },
        'mlm-panel': { icon: 'g-server', tint: 'indigo', dev: 'MLM (اندروید)', sub: 'کانفیگ استدیو — مستقرشده از اندروید' },
        nahan: { icon: 'g-shield', tint: 'purple', dev: 'MLM (اندروید)', sub: 'پنل نهان — مستقرشده از اندروید' },
        'vpngate-relay': { icon: 'g-swap', tint: 'gray', dev: 'MLM (اندروید)', sub: 'رلهٔ فهرست VPN Gate — مستقرشده از اندروید' },
        'sub-generator': { icon: 'g-layers', tint: 'teal', dev: 'MLM (اندروید)', sub: 'سازندهٔ لینک ساب — مستقرشده از اندروید' },

        mlmvpn: { icon: 'g-settings-art', art: true, tint: 'gray', dev: 'MLM',
            sub: 'خود برنامه',
            desc: 'خود برنامه. بروزرسانی، نصب‌کننده را می‌گیرد و کنار می‌گذارد تا وقتی برنامه بسته شد اعمال شود.' },
        vodi: { icon: 'g-railway-art', art: true, tint: 'teal', dev: 'VodiWalker',
            sub: 'پنل VLESS روی حساب Railway خودتان',
            desc: 'روی حساب Railway خودتان مستقر است. «بروزرسانی» اینجا یعنی ساختِ دوبارهٔ سرویس از روی آخرین سورس سازنده؛ دیسک، دامنه، رمز و کاربران سر جایشان می‌مانند.',
            about: [
                ['این اسکریپت چیست', 'VodiWalker یک پنل مدیریت کانفیگ است که با پایتون (FastAPI) نوشته شده و روی سرور خودتان اجرا می‌شود. کارش ساختن و مدیریت لینک‌های VLESS است: هر کاربر یک لینک می‌گیرد، و پنل برای همان لینک محدودیت حجم، انقضا، سقف سرعت، سقف آی‌پی هم‌زمان و شمارش مصرف نگه می‌دارد. خودش هم ترافیک را سرو می‌کند — یعنی برای پروتکل‌هایی که پشتیبانی می‌کند به هستهٔ جداگانه‌ای مثل Xray روی سرور نیاز ندارد.'],
                ['چه چیزهایی دارد', 'ساخت تکی و گروهی کانفیگ، دسته‌بندی کاربران، لینک ساب برای هر کاربر و لینک ساب مشترک برای یک گروه، ساخت دوبارهٔ لینک (وقتی لینکی دست‌به‌دست شده)، ریست مصرف، ادمین‌های چندگانه با سطح دسترسی، گزارش و خروجی CSV، ربات تلگرام، و یک صفحهٔ داشبورد با مصرف پردازنده و حافظه و اتصال‌های زنده.'],
                ['پروتکل‌ها', 'پنل هفت پروتکل می‌شناسد ولی همه یکسان نیستند: <code dir="ltr">vless-ws</code>، <code dir="ltr">xhttp-packet-up</code> و <code dir="ltr">xhttp-stream-up</code> را واقعاً روی همان پورت HTTPS خودش سرو می‌کند و همین سه تا در این برنامه پیشنهاد می‌شوند. <code dir="ltr">vmess-ws</code>، <code dir="ltr">trojan-ws</code> و <code dir="ltr">xhttp-stream-one</code> فقط لینک می‌سازند و برای اجرای واقعی به هستهٔ خارجی نیاز دارند، و <code dir="ltr">vless-tcp</code> یک پورت TCP خام می‌خواهد که روی Railway یعنی TCP Proxy جدا.'],
                ['متن‌باز', 'کد کامل پنل روی گیت‌هاب سازنده است و همین برنامه هم دقیقاً از همان مخزن نصبش می‌کند — نه از یک ایمیج که ما جایی ساخته باشیم. یعنی چیزی که روی سرور شما اجرا می‌شود همان چیزی است که در مخزن می‌بینید.'],
            ],
            inApp: [
                ['این ردیف چه می‌گوید', 'عنوان ردیف دو تکه دارد: <b>railway</b> نام خود برنامه است، و چیزی که بعد از خط تیره می‌آید — مثلاً «تست» — <b>نامی است که خودتان موقع ساخت سرور رویش گذاشتید</b>. اگر چند سرور ساخته باشید، هر کدام ردیف جداگانهٔ خودش را دارد، چون هر کدام جداگانه بروز می‌شود. زیرش هم دامنهٔ همان سرور نوشته می‌شود تا اشتباه نگیرید.'],
                ['«استقرار دوباره» چه کار می‌کند', 'همان سرویس را روی حساب Railway خودتان <b>دوباره از روی آخرین کد سازنده می‌سازد و بالا می‌آورد</b>. سرور تازه‌ای ساخته نمی‌شود و چیزی پاک نمی‌شود: دیسک، دامنه، نام کاربری و رمز ادمین، و دیتابیس کاربرانتان به <b>سرویس</b> چسبیده‌اند نه به استقرار، پس دست‌نخورده می‌مانند. تنها هزینه‌اش این است که سرور چند دقیقه قطع می‌شود تا دوباره ساخته شود. بعدش سلامت سرور بررسی می‌شود تا اگر ساخت تازه خراب بود، از ما بشنوید نه از کاربرانتان.'],
                ['چرا شمارهٔ نسخه نشان نمی‌دهد', 'بقیهٔ ردیف‌های استور می‌نویسند «بروز است» یا «به فلان نسخه»، چون سازنده‌شان انتشار شماره‌دار می‌دهد. مخزن این پنل <b>انتشار شماره‌دار ندارد</b> — فقط کد روی شاخهٔ اصلی. پس این ردیف هیچ دو عددی ندارد که مقایسه کند، و نمی‌تواند بگوید بروز هستید یا نه. برای همین به‌جای عدد، می‌نویسد <b>«از آخرین کد سازنده ساخته می‌شود»</b> — یعنی هر وقت دکمه را بزنید، تازه‌ترین کد را می‌گیرید. (تا قبل از این نسخه اینجا نوشته می‌شد «بررسی نشده» که غلط‌انداز بود: انگار برنامه هنوز نگاه نکرده، در حالی که اصلاً چیزی برای نگاه کردن نیست.)'],
                ['چطور مستقر می‌شود', 'پنجرهٔ «railway» یک جادوگر شش‌مرحله‌ای دارد: ورود به حساب Railway خودتان، انتخاب لوکیشن، انتخاب نام کاربری و رمز ادمین، و بعد استقرار. برنامه پروژه، سرویس، دیسک پایدار، متغیرهای محیطی و دامنهٔ عمومی را خودش می‌سازد و تا وقتی سرور جواب سالم ندهد نمی‌گوید آماده است.'],
                ['از سورس ساخته می‌شود، نه از ایمیج', 'سرویس مستقیم از مخزن عمومی سازنده ساخته می‌شود و دستور اجرایش صریح تعیین می‌شود. برای همین بار اول کندتر است — ۳ تا ۶ دقیقه به‌جای ۱ تا ۳ دقیقه — چون وابستگی‌های پایتون باید نصب شوند. در عوض هیچ رجیستری وسط راه نیست و هر استقرار دوباره، آخرین کد سازنده را می‌آورد.'],
                ['«بروزرسانی» اینجا یعنی چه', 'این ردیف برای هر سروری که ساخته‌اید یک خط جدا دارد، چون چیزی که بروز می‌شود همان سرویس مشخص روی حساب Railway شماست. زدن دکمه، سرویس را دوباره از روی شاخهٔ اصلی مخزن می‌سازد و بالا می‌آورد. دیسک، دامنه و همهٔ متغیرها (رمز ادمین، کلید مخفی، دیتابیس کاربران روی دیسک) به سرویس چسبیده‌اند نه به استقرار، پس دست‌نخورده می‌مانند. بعدش هم سلامت سرور بررسی می‌شود تا اگر ساخت تازه خراب بود، از ما بشنوید نه از کاربرانتان.'],
            ],
            facts: [
                ['زبان', 'Python (FastAPI + uvicorn)'],
                ['محل اجرا', 'حساب Railway خودتان'],
                ['منبع نصب', 'مخزن عمومی سازنده'],
            ],
            devBox: {
                name: 'VodiWalker',
                logo: 'assets/dev/vodiwalker.jpg',
                line: 'سازندهٔ پنل VodiWalker — پنلی رایگان و متن‌باز برای ساخت و مدیریت کانفیگ. کد و بروزرسانی‌هایش در گیت‌هاب است و اعلان نسخه‌های تازه در کانال تلگرامشان.',
                links: [
                    ['مخزن این پروژه', 'https://github.com/Vodiwalker/vodiwalker_panel', 'ph-fill ph-folder-open'],
                    ['گیت‌هاب سازنده', 'https://github.com/Vodiwalker', 'ph-fill ph-github-logo'],
                    ['کانال تلگرام', 'https://t.me/vodiwalkervpn03', 'ph-fill ph-telegram-logo'],
                ],
            } },
    };

    const look = (id) => LOOK[id] || { icon: 'g-server', tint: 'gray', dev: '', sub: '' };

    const GROUPS = {
        cores: { title: 'هسته‌های موتور', hint: 'فایل‌های اجرایی که موتورها را می‌رانند. نسخهٔ تازه در پوشهٔ جدا نصب می‌شود و از اجرای بعدی همان موتور استفاده می‌شود.' },
        workers: { title: 'ورکرها و پنل‌های ابری', hint: 'روی حساب خودتان مستقرند. بروزرسانی فقط کد را عوض می‌کند؛ تنظیمات، رمزها و دیتابیس دست نمی‌خورند.' },
        data: { title: 'داده‌ها', hint: 'فایل‌هایی که برنامه با آن‌ها کار می‌کند و از پروژهٔ خودشان تازه می‌شوند — برنامه بعد از گرفتن، خودش دوباره می‌سازدشان و با موتور آزمایششان می‌کند.' },
        app: { title: 'برنامه', hint: '' },
    };

    const STATE_TEXT = {
        update: 'بروزرسانی دارد',
        current: 'بروز است',
        unknown: 'بررسی نشده',
        unchecked: 'بررسی نشده',
        missing: 'نصب نشده',
        external: 'از اندروید مدیریت می‌شود',
    };

    // ── state ────────────────────────────────────────────────────────────────

    let data = { rows: [], accounts: [], channel: {}, workersCheckedAt: 0 };
    let jobsMap = {};
    let view = { name: 'discover', arg: null };
    let poll = null;
    let notice = '';

    const rowById = (id) => data.rows.filter(r => r.id === id);
    const byGroup = (g) => data.rows.filter(r => r.group === g);
    const pending = () => data.rows.filter(r => r.state === 'update' || r.state === 'missing');

    function jobOf(row) {
        const key = row.kind === 'core' ? 'core:' + row.id
            : row.kind === 'worker' ? 'worker:' + row.accountId + ':' + row.script
                : row.kind === 'vodi' ? 'vodi:' + row.gatewayId : '';
        return jobsMap[key] || null;
    }

    const busy = (row) => { const j = jobOf(row); return !!(j && j.running); };

    // ── bits ─────────────────────────────────────────────────────────────────

    function appIcon(row, cls) {
        const l = look(row.id);
        // A picture the project itself publishes (the developer's own logo) is shown as it is —
        // a drawn glyph in its place would be our guess at their identity.
        if (l.img) return '<span class="as-ico is-photo' + (cls ? ' ' + cls : '') + '"><img src="' + esc(l.img) + '" alt=""></span>';
        return '<span class="as-ico' + (l.art ? ' is-art' : '') + (cls ? ' ' + cls : '') +
            '" style="--tint:var(--mv-' + (l.tint || 'blue') + ')">' + icon(l.icon) + '</span>';
    }

    const PHASE = {
        resolve: 'خواندن انتشار سازنده',
        protect: 'آماده‌سازی پوشهٔ امن', download: 'در حال دانلود', extract: 'باز کردن بسته',
        build: 'ساختن کانفیگ‌ها',
        validate: 'آزمایش هستهٔ تازه', activate: 'فعال‌سازی', rollback: 'برگرداندن نسخهٔ قبل',
        read: 'خواندن کد فعلی', scan: 'بررسی حساب', start: 'شروع', done: 'انجام شد',
        failed: 'ناموفق', cancelled: 'لغو شد', core: 'هسته', worker: 'ورکر',
    };

    function progressBar(job) {
        if (!job || !job.running) return '';
        const pct = Math.round((job.progress || 0) * 100);
        const label = (PHASE[job.phase] || job.phase) + (job.route ? ' — از ' + esc(job.route) : '') +
            (job.total ? ' · ' + fa(Math.round(job.bytes / 1048576)) + '/' + fa(Math.round(job.total / 1048576)) + ' مگابایت' : '');
        return '<div class="as-job"><div class="as-prog' + (pct ? '' : ' is-idle') + '"><i style="width:' + pct + '%"></i></div>' +
            '<small>' + esc(label) + '</small></div>';
    }

    function jobError(job) {
        if (!job || job.running || !job.error) return '';
        return '<div class="as-err"><i class="ph-fill ph-warning-circle"></i><span>' + esc(job.error.message) + '</span></div>';
    }

    /** The one button that matters for a row, plus the quiet ones. */
    function actions(row, { big = false } = {}) {
        const j = jobOf(row);
        const cls = big ? 'as-get' : 'as-pill';
        const quiet = big ? ' is-quiet' : '';
        const out = [];
        if (j && j.running) {
            out.push('<button type="button" class="' + cls + quiet + '" data-cancel="1" data-row="' + esc(rowKey(row)) + '">لغو</button>');
            return out.join('');
        }
        if (row.kind === 'app') {
            if (row.state === 'update') {
                if (row.downloaded) out.push('<button type="button" class="' + cls + ' is-go" data-app="install">نصب</button>');
                else out.push('<button type="button" class="' + cls + ' is-go" data-app="download">دانلود</button>');
            } else {
                out.push('<button type="button" class="' + cls + quiet + '" data-app="check">بررسی</button>');
            }
            return out.join('');
        }
        if (row.kind === 'vodi') {
            out.push('<button type="button" class="' + cls + ' is-go" data-vodi="' + esc(row.gatewayId) + '">استقرار دوباره</button>');
            return out.join('');
        }
        if (row.state === 'external') {
            return '<span class="as-note-inline">از اندروید</span>';
        }
        if (row.state === 'update' || row.state === 'missing') {
            out.push('<button type="button" class="' + cls + ' is-go" data-update="' + esc(rowKey(row)) + '">بروزرسانی</button>');
        } else if (row.kind === 'core' && row.state === 'unknown' && row.target) {
            out.push('<button type="button" class="' + cls + ' is-go" data-update="' + esc(rowKey(row)) + '">نصب نسخهٔ آزموده‌شده</button>');
        } else if (row.kind === 'core' || row.kind === 'data') {
            out.push('<button type="button" class="' + cls + quiet + '" data-upstream="' + esc(row.id) + '">بررسی مخزن</button>');
        } else {
            out.push('<button type="button" class="' + cls + quiet + '" data-open="' + esc(rowKey(row)) + '">جزئیات</button>');
        }
        return out.join('');
    }

    const rowKey = (row) => row.kind === 'worker' ? 'worker|' + row.accountId + '|' + row.script
        : row.kind === 'vodi' ? 'vodi|' + row.gatewayId : row.kind + '|' + row.id;

    function findByKey(key) {
        return data.rows.find(r => rowKey(r) === key) || null;
    }

    /** A Discover / list row: icon, name, subtitle, button — the App Store's basic unit. */
    function row(r) {
        const l = look(r.id);
        const j = jobOf(r);
        const sub = r.kind === 'worker'
            ? (r.accountName + ' · ' + r.script)
            // One row per deployed server, so the row has to say WHICH one: the name is
            // already in the title, and the domain is what identifies it.
            : r.kind === 'vodi' ? ('سرور خودتان روی Railway' + (r.usedBy ? ' · ' + r.usedBy : ''))
            : (l.sub || r.usedBy || '');
        return `
<div class="as-row" data-open="${esc(rowKey(r))}">
  ${appIcon(r)}
  <div class="as-row-text">
    <div class="as-row-title">${esc(r.title)}${r.source === 'store' ? '<span class="as-tag">از استور</span>' : ''}${upstreamTag(r)}</div>
    <div class="as-row-sub">${esc(sub)}</div>
    ${progressBar(j)}${jobError(j)}
  </div>
  <div class="as-row-end" data-stop="1">
    ${actions(r)}
    <small>${esc(stateLine(r))}</small>
  </div>
</div>`;
    }

    function stateLine(r) {
        if (r.state === 'update' && r.target) return 'به ' + r.target.version;
        if (r.state === 'current' && r.version) return 'نسخهٔ ' + r.version;
        // A deployed server is not "unchecked" — there is nothing to check. The panel's
        // repository publishes no numbered releases, so no comparison exists to make; the
        // honest statement is what the button will do, not a version the row cannot know.
        if (r.kind === 'vodi') return 'از آخرین کد سازنده ساخته می‌شود';
        return STATE_TEXT[r.state] || '';
    }

    /** «the developer has published something newer» — a fact, not a button. */
    const upstreamTag = (r) => (r.upstreamNewer
        ? `<span class="as-tag is-up" title="سازندهٔ این پروژه نسخهٔ ${esc(r.upstreamLatest.version)} را منتشر کرده — هنوز آزموده و امضا نشده">سازنده: ${esc(r.upstreamLatest.version)}</span>`
        : '');

    const rowGrid = (items) => '<div class="as-rows">' + items.map(row).join('') + '</div>';

    // ── views ────────────────────────────────────────────────────────────────

    function viewDiscover() {
        const updates = data.rows.filter(x => x.state === 'update');
        const fromDevs = data.rows.filter(x => x.upstreamNewer);
        const cores = byGroup('cores');
        const workers = byGroup('workers');
        const ch = data.channel || {};
        return `
${notice ? `<div class="as-note">${notice}</div>` : ''}

<div class="as-hero">
  <div class="as-hero-kicker">بروزرسانی</div>
  <div class="as-hero-title">${pending().length ? fa(pending().length) + ' مورد آمادهٔ بروزرسانی است' : 'همه‌چیز بروز است'}</div>
  <div class="as-hero-sub">هسته‌های موتور، ورکرهای حساب خودتان و خود برنامه — همه از یک جا.</div>
  <div class="as-hero-btns">
    <button type="button" class="as-hero-btn" data-go="updates">دیدن بروزرسانی‌ها</button>
    ${pending().length ? '<button type="button" class="as-hero-btn is-solid" data-all="1">بروزرسانی همه</button>' : ''}
  </div>
</div>

${fromDevs.length ? `
<div class="as-sec">
  <div class="as-sec-head"><h2>سازنده‌ها نسخهٔ تازه داده‌اند</h2><button type="button" class="as-pill as-upbtn" data-upcheck="1">بررسی دوباره</button></div>
  <p class="as-sec-note">اینها هنوز نصب نمی‌شوند: استور فقط نسخه‌ای را نصب می‌کند که آزموده و امضا شده باشد. این فهرست برای این است که بدانید چه چیزی بیرون منتشر شده.</p>
  ${rowGrid(fromDevs)}
</div>` : ''}

${updates.length ? `
<div class="as-sec">
  <div class="as-sec-head"><h2>همین حالا بروزرسانی دارند</h2><button type="button" class="as-seeall" data-go="updates">همه</button></div>
  ${rowGrid(updates)}
</div>` : ''}

<div class="as-sec">
  <div class="as-sec-head"><h2>هسته‌های موتور</h2><button type="button" class="as-seeall" data-go="cores">همه</button></div>
  ${rowGrid(cores.slice(0, 6))}
</div>

<div class="as-sec">
  <div class="as-sec-head"><h2>ورکرهای حساب شما</h2><button type="button" class="as-seeall" data-go="workers">همه</button></div>
  ${workers.length ? rowGrid(workers.slice(0, 6)) : emptyWorkers()}
</div>

<div class="as-sec">
  <div class="as-sec-head"><h2>کانال بروزرسانی</h2></div>
  <div class="as-channel">
    <p>${ch.have
        ? 'فهرست نسخه‌های آزموده‌شده دریافت شده است' + (ch.sequence ? ' (شمارهٔ ' + fa(ch.sequence) + ')' : '') + (ch.fetchedAt ? ' — ' + when(ch.fetchedAt) : '') + '.'
        : 'فهرست نسخه‌های آزموده‌شده هنوز گرفته نشده؛ فعلاً همان نسخه‌هایی که با این بیلد آمده‌اند ملاک‌اند.'}
      ${ch.error ? '<br><span class="as-err-inline">' + esc(ch.error) + '</span>' : ''}</p>
    <p class="as-fine">این فایل با امضای دیجیتال بررسی می‌شود؛ بدون امضای درست، هیچ نسخه‌ای از آن پذیرفته نمی‌شود.</p>
    <button type="button" class="as-pill" data-channel="1">بررسی کانال</button>
  </div>
</div>`;
    }

    function emptyWorkers() {
        const accs = data.accounts || [];
        return `<div class="as-empty is-inline">
  <p>${accs.length ? 'هنوز حساب‌ها بررسی نشده‌اند.' : 'هیچ حساب کلودفلری در برنامه ذخیره نشده — از صفحهٔ «ابری» اضافه‌اش کنید.'}</p>
  ${accs.length || true ? '<button type="button" class="as-pill is-go" data-workers="1">بررسی حساب‌ها</button>' : ''}
</div>`;
    }

    function viewGroup(g) {
        const meta = GROUPS[g] || { title: '', hint: '' };
        const items = byGroup(g);
        if (g === 'workers') return viewWorkers(meta);
        return `
<div class="as-sec">
  <div class="as-sec-head"><h2>${esc(meta.title)}</h2></div>
  ${rowGrid(items)}
  ${meta.hint ? `<div class="as-sec-foot">${esc(meta.hint)}</div>` : ''}
</div>`;
    }

    /** Workers, grouped by the account they live on — that is how the user thinks about them. */
    function viewWorkers(meta) {
        const rows = byGroup('workers');
        const accounts = data.accounts || [];
        const mine = rows.filter(r => r.managedBy === 'windows');
        const android = rows.filter(r => r.managedBy !== 'windows');
        return `
<div class="as-sec">
  <div class="as-sec-head">
    <h2>${esc(meta.title)}</h2>
    <button type="button" class="as-pill as-allbtn" data-workers="1">بررسی دوباره</button>
  </div>
  <div class="as-scan-line">${data.workersCheckedAt
        ? 'آخرین بررسی: ' + when(data.workersCheckedAt) + ' · ' + fa(rows.length) + ' مورد روی ' + fa(accounts.length) + ' حساب'
        : 'هنوز بررسی نشده‌اند.'}</div>
  ${accounts.filter(a => a.error).map(a => `<div class="as-err"><i class="ph-fill ph-warning-circle"></i><span>${esc(a.name)}: ${esc(a.error)}</span></div>`).join('')}
  ${mine.length ? rowGrid(mine) : emptyWorkers()}
  ${android.length ? `
  <div class="as-sec-head as-sub-head"><h2>ساختهٔ برنامهٔ اندروید</h2></div>
  <div class="as-sec-foot">این‌ها را نسخهٔ اندروید مستقر کرده و از همان‌جا هم بروزرسانی می‌شوند. اینجا فقط نشان داده می‌شوند تا تصویر حسابتان کامل باشد.</div>
  ${rowGrid(android)}` : ''}
  <div class="as-sec-foot">${esc(meta.hint)}</div>
  <div class="as-sec-foot">ورکرهایی که این برنامه نساخته باشد اصلاً فهرست نمی‌شوند و هرگز دست نمی‌خورند.</div>
</div>`;
    }

    function viewUpdates() {
        const items = data.rows.filter(x => x.state === 'update' || x.state === 'missing' || busy(x));
        if (!items.length) return '<div class="as-empty"><i class="ph ph-check-circle"></i><p>همه‌چیز بروز است.</p></div>';
        return `
<div class="as-sec">
  <div class="as-sec-head"><h2>بروزرسانی‌های در دسترس</h2><button type="button" class="as-pill is-go as-allbtn" data-all="1">بروزرسانی همه</button></div>
  <div class="as-rows is-updates">
    ${items.map(it => {
            const j = jobOf(it);
            return `
    <div class="as-row is-tall" data-open="${esc(rowKey(it))}">
      ${appIcon(it)}
      <div class="as-row-text">
        <div class="as-row-title">${esc(it.title)}</div>
        <div class="as-row-meta">
          <span class="as-code">${ltr(it.version || '—')}</span><span class="as-arrow">←</span>
          <span class="as-code">${ltr(it.target ? it.target.version : '—')}</span>
          ${it.target && it.target.released ? '<span class="as-dot">·</span><span>' + esc(it.target.released) + '</span>' : ''}
          ${it.kind === 'worker' ? '<span class="as-dot">·</span><span>' + esc(it.accountName) + '</span>' : ''}
        </div>
        ${it.target && it.target.notes ? `<div class="as-row-notes">${esc(it.target.notes)}</div>` : ''}
        ${progressBar(j)}${jobError(j)}
      </div>
      <div class="as-row-end" data-stop="1">${actions(it)}</div>
    </div>`;
        }).join('')}
  </div>
</div>`;
    }

    function when(ts) {
        if (!ts) return '';
        const s = Math.round((Date.now() - ts) / 1000);
        if (s < 60) return 'همین حالا';
        if (s < 3600) return fa(Math.round(s / 60)) + ' دقیقه پیش';
        if (s < 86400) return fa(Math.round(s / 3600)) + ' ساعت پیش';
        return fa(Math.round(s / 86400)) + ' روز پیش';
    }

    function viewProduct(key) {
        const it = findByKey(key);
        if (!it) return viewDiscover();
        const l = look(it.id);
        const j = jobOf(it);

        const info = [];
        info.push(['نسخهٔ در حال استفاده', it.version || '—']);
        if (it.reported && it.reported !== it.version) info.push(['نسخه‌ای که خود فایل می‌گوید', it.reported]);
        if (it.target) info.push(['نسخهٔ آزموده‌شده', it.target.version]);
        if (it.kind === 'core') {
            info.push(['از کجا اجرا می‌شود', it.source === 'store' ? 'نصب‌شده از استور' : 'همراه خود برنامه']);
            if (it.shipped) info.push(['نسخهٔ همراه این بیلد', it.shipped]);
            if (it.file) info.push(['مسیر فایل', it.file]);
            if (it.installedAt) info.push(['زمان نصب', new Date(it.installedAt).toLocaleString('fa-IR')]);
        }
        if (it.kind === 'data') {
            info.push(['از کجا خوانده می‌شود', it.source === 'store' ? 'نصب‌شده از استور' : 'همراه خود برنامه']);
            if (it.count) info.push(['تعداد کانفیگ', fa(it.count)]);
            if (it.shipped) info.push(['نسخهٔ همراه این بیلد', it.shipped]);
            if (it.file) info.push(['مسیر', it.file]);
            if (it.installedAt) info.push(['زمان نصب', new Date(it.installedAt).toLocaleString('fa-IR')]);
        }
        if (it.kind === 'worker') {
            info.push(['نام اسکریپت', it.script]);
            info.push(['حساب', it.accountName]);
            if (it.url) info.push(['آدرس', it.url]);
            if (it.modifiedOn) info.push(['آخرین تغییر روی کلودفلر', new Date(it.modifiedOn).toLocaleString('fa-IR')]);
            info.push(['مدیریت از', it.managedBy === 'windows' ? 'همین برنامه' : 'برنامهٔ اندروید']);
        }
        if (it.repo) info.push(['مخزن', it.repo]);
        if (l.dev) info.push(['سازنده', l.dev]);
        (l.facts || []).forEach((f) => info.push(f));
        if (it.usedBy) info.push(['استفاده در', it.usedBy]);

        const notes = it.target && it.target.notes;
        return `
<div class="as-prod">
  <div class="as-prod-top">
    ${appIcon(it, 'is-big')}
    <div class="as-prod-head">
      <h1>${esc(it.title)}</h1>
      <div class="as-prod-sub">${esc(l.sub || it.usedBy || '')}</div>
      <div class="as-prod-cta">
        ${actions(it, { big: true })}
        ${(it.kind === 'core' || it.kind === 'data') && it.canRollback ? '<button type="button" class="as-get is-quiet" data-rollback="' + esc(it.id) + '">برگشت به ' + esc(it.rollbackTo || 'نسخهٔ قبل') + '</button>' : ''}
        ${it.kind === 'worker' && it.managedBy === 'windows' ? '<button type="button" class="as-get is-quiet" data-wrollback="' + esc(rowKey(it)) + '">برگرداندن کد قبلی</button>' : ''}
        <span class="as-cta-note">${esc(STATE_TEXT[it.state] || '')}</span>
      </div>
      ${progressBar(j)}${jobError(j)}
    </div>
  </div>

  <div class="as-stats">
    <div class="as-stat"><div class="as-stat-k">نسخهٔ فعلی</div><div class="as-stat-v as-sm">${ltr(it.version || '—')}</div></div>
    <div class="as-stat"><div class="as-stat-k">${it.direct ? 'نسخهٔ سازنده' : 'نسخهٔ آزموده‌شده'}</div><div class="as-stat-v as-sm">${ltr(it.target ? it.target.version : '—')}</div></div>
    <div class="as-stat"><div class="as-stat-k">وضعیت</div><div class="as-stat-v as-ico-v"><i class="ph-fill ${it.state === 'update' ? 'ph-arrow-circle-down' : it.state === 'current' ? 'ph-check-circle' : 'ph-question'}"></i></div><div class="as-stat-c">${esc(STATE_TEXT[it.state] || '')}</div></div>
    <div class="as-stat"><div class="as-stat-k">منبع</div><div class="as-stat-v as-ico-v"><i class="ph-fill ${it.kind === 'core' ? 'ph-cpu' : it.kind === 'worker' ? 'ph-cloud' : 'ph-app-window'}"></i></div><div class="as-stat-c">${it.kind === 'core' ? (it.builtByUs ? 'ساخت ما' : it.direct ? 'ساخت رسمی سازنده' : 'مخزن سازنده') : it.kind === 'worker' ? 'حساب خودتان' : 'مخزن MLM'}</div></div>
  </div>

  ${it.direct ? `
  <div class="as-callout">
    این هسته مستقیم از انتشار خودِ سازنده نصب می‌شود — همان فایلی که در
    <span class="as-code" dir="ltr">${esc(it.repo)}</span> منتشر کرده، بدون هیچ تغییری از طرف ما.
    هشِ فایل را گیت‌هاب هنگام آپلود حساب کرده و دانلود با همان هش تطبیق داده می‌شود؛ بعد هم اجرا
    می‌شود و باید نسخه‌اش را بگوید، وگرنه فعال نمی‌شود. یعنی به‌محض اینکه سازنده نسخهٔ تازه‌ای بدهد
    همین‌جا قابل نصب است، بی‌آنکه منتظر ما بمانید — و اگر ساخت تازه‌اش مشکل داشت، با یک کلیک به
    نسخهٔ قبلی برمی‌گردید.
  </div>` : ''}

  ${it.missingKeys && it.missingKeys.length ? `<div class="as-callout is-warn">این نسخه ${fa(it.missingKeys.length)} کلید را ندارد که نسخهٔ تازه دارد: <span class="as-code" dir="ltr">${esc(it.missingKeys.join('، '))}</span></div>` : ''}

  ${l.about ? `
  <div class="as-block">
    <div class="as-block-head"><h3>از زبان سازنده</h3><span class="as-when">${ltr(l.dev || '')}</span></div>
    ${l.about.map(([h, p]) => `<h4 class="as-sub-h">${esc(h)}</h4><p class="as-desc">${esc(p)}</p>`).join('')}
  </div>` : ''}

  ${l.devBox ? `
  <div class="as-block">
    <div class="as-block-head"><h3>توسعه‌دهنده</h3></div>
    <div class="as-dev">
      <img class="as-dev-logo" src="${esc(l.devBox.logo)}" alt="">
      <div class="as-dev-text">
        <b>${ltr(l.devBox.name)}</b>
        <p>${esc(l.devBox.line)}</p>
        <div class="as-dev-links">
          ${(l.devBox.links || []).map(([label, url, ic]) => `<button type="button" class="as-dev-link" data-open-url="${esc(url)}"><i class="${esc(ic)}"></i>${esc(label)}</button>`).join('')}
        </div>
      </div>
    </div>
  </div>` : ''}

  ${l.inApp ? `
  <div class="as-block">
    <div class="as-block-head"><h3>در این برنامه</h3><span class="as-when">${ltr('MLM VPN')}</span></div>
    ${l.inApp.map(([h, p]) => `<h4 class="as-sub-h">${esc(h)}</h4><p class="as-desc">${esc(p)}</p>`).join('')}
  </div>` : ''}

  ${!l.about && l.desc ? `<div class="as-block">${esc(l.desc).split(PARA).map(p => `<p class="as-desc">${p}</p>`).join('')}</div>` : ''}

  ${it.upstreamLatest ? `
  <div class="as-block">
    <div class="as-block-head"><h3>تازه‌ترین انتشار سازنده</h3><span class="as-when">${it.upstreamLatest.checkedAt ? 'بررسی: ' + esc(when(it.upstreamLatest.checkedAt)) : ''}</span></div>
    <div class="as-up">
      <div class="as-up-line">
        <span class="as-code">${ltr(it.upstreamLatest.version)}</span>
        ${it.upstreamLatest.pre ? '<span class="as-tag">پیش‌انتشار</span>' : ''}
        ${it.upstreamLatest.at ? `<span class="as-dot">·</span><span>${esc(new Date(it.upstreamLatest.at).toLocaleDateString('fa-IR'))}</span>` : ''}
        <span class="as-dot">·</span><span>نسخهٔ شما <span class="as-code">${ltr(it.version || '—')}</span></span>
      </div>
      <p class="as-desc">${it.upstreamNewer
            ? (it.direct
                ? 'این نسخه منتشر شده اما فایل ویندوزی‌اش هنوز خوانده نشد — ممکن است ساختش در گیت‌هاب تمام نشده باشد یا هشی برایش منتشر نشده باشد. «بررسی مخزن» را دوباره بزنید؛ به‌محض اینکه فایلش آماده باشد همین‌جا نصب می‌شود.'
                : it.builtByUs
                    ? 'این نسخه هنوز با تنظیم‌ها و وصله‌های این برنامه ساخته، آزموده و امضا نشده است. تا آن وقت استور نصبش نمی‌کند — همین که می‌بینیدش یعنی می‌دانیم منتشر شده.'
                    : 'این نسخه هنوز آزموده و در کانال امضاشده ثبت نشده است. استور فقط نسخه‌ای را نصب می‌کند که آزموده شده باشد؛ به‌محض اینکه آزمایش شود، همین‌جا دکمهٔ بروزرسانی می‌گیرد.')
            : it.upstreamLatest.pre
                ? 'تازه‌ترین چیزی که منتشر شده یک پیش‌انتشار است؛ نسخهٔ پایدارتان از آن عقب نیست.'
                : 'همان چیزی است که دارید — چیز تازه‌ای منتشر نشده است.'}</p>
      <div class="as-up-acts">
        ${it.upstreamLatest.url ? `<button type="button" class="as-get is-quiet" data-open-url="${esc(it.upstreamLatest.url)}">دیدن در گیت‌هاب</button>` : ''}
        <button type="button" class="as-get is-quiet" data-upstream="${esc(it.id)}">بررسی مخزن</button>
      </div>
      ${it.upstreamError ? `<p class="as-fine">آخرین بررسی ناموفق بود: ${esc(it.upstreamError)}</p>` : ''}
    </div>
  </div>` : ''}

  ${notes ? `
  <div class="as-block">
    <div class="as-block-head"><h3>تازه چه چیزی دارد</h3><span class="as-when">${esc(it.target.released || '')}</span></div>
    <div class="as-ver-line">نسخهٔ <span class="as-code">${ltr(it.target.version)}</span></div>
    <p class="as-desc">${esc(notes)}</p>
  </div>` : ''}

  ${j && j.log && j.log.length ? `
  <div class="as-block">
    <div class="as-block-head"><h3>گزارش</h3></div>
    <div class="as-log">${j.log.slice(-12).map(x => '<div>' + esc(x.line) + '</div>').join('')}</div>
  </div>` : ''}

  <div class="as-block">
    <div class="as-block-head"><h3>اطلاعات</h3></div>
    <div class="as-info">
      ${info.map(([k, v]) => `<div class="as-info-row"><span class="as-info-k">${esc(k)}</span><span class="as-info-v">${/^[؀-ۿ]/.test(String(v)) ? esc(v) : '<span class="as-code">' + ltr(v) + '</span>'}</span></div>`).join('')}
    </div>
  </div>
</div>`;
    }

    // ── shell ────────────────────────────────────────────────────────────────

    const SIDE = [
        [['discover', 'کشف', 'ph-fill ph-star', 'var(--mv-blue)']],
        [['cores', 'هسته‌های موتور', 'ph-fill ph-cpu', 'var(--mv-indigo)'],
        ['workers', 'ورکرها', 'ph-fill ph-cloud', 'var(--mv-orange)'],
        ['app', 'برنامه', 'ph-fill ph-app-window', 'var(--mv-gray)']],
        [['updates', 'بروزرسانی‌ها', 'ph-fill ph-arrow-circle-down', 'var(--mv-green)']],
    ];

    function sideHTML() {
        return SIDE.map(group => '<div class="mv-side-group">' + group.map(([id, label, ic, tint]) => {
            // A <b>, not a <span>, and `st-count`, not `as-anything` — both on purpose.
            //
            // THE PREFIX IS NOT OURS ALONE. «دستیار» (assistant.js) also prefixes with `as-`,
            // and its CSS is injected into the same document as ours. It had already taken BOTH
            // obvious spellings:
            //
            //   · `.as-badge` is its launcher's corner dot — `position:absolute; top:-2px;
            //     inset-inline-end:-2px`. Our rule set colours and margins and never mentioned
            //     `position`, so the assistant's won by default: the count positioned itself
            //     against `.mv-side` and rendered at the TOP-OUTER CORNER OF THE SIDEBAR, half
            //     outside it. Measured: the count's box at left 792 / top 36 while its own row
            //     was at left 802 / top 260, and the sidebar started at 794. That is «عدد بالای
            //     سایدبار نصفه نمایش داده میشه و جاش اصلا درست نیست», exactly.
            //   · `.as-count` is its quantity field — `align-self: stretch`, which pinned the
            //     count to the top of its row instead of centring it.
            //
            // tests/store/panel.test.js keeps the two panels' `as-*` sets disjoint from now on.
            //
            // The tag matters too: page-kit gives `.mv-side-item > span:last-child` the label's
            // ellipsis. Append a <span> and the count inherits the clipping while the LABEL
            // loses it — so a long label stops shrinking and shoves the count out of the row.
            const badge = id === 'updates' && pending().length
                ? `<b class="st-count">${fa(pending().length)}</b>` : '';
            return `<button type="button" class="mv-side-item${view.name === id ? ' active' : ''}" data-go="${id}">
  <span class="mv-side-tile" style="--tint:${tint}"><i class="${ic}"></i></span><span>${label}</span>${badge}
</button>`;
        }).join('') + '</div>').join('');
    }

    function paneTitle() {
        if (view.name === 'discover') return 'کشف';
        if (view.name === 'updates') return 'بروزرسانی‌ها';
        if (view.name === 'product') { const r = findByKey(view.arg); return r ? r.title : ''; }
        return (GROUPS[view.name] || {}).title || '';
    }

    function paneBody() {
        if (view.name === 'discover') return viewDiscover();
        if (view.name === 'updates') return viewUpdates();
        if (view.name === 'product') return viewProduct(view.arg);
        return viewGroup(view.name);
    }

    function shell() {
        return CSS + `
<div class="mv-split as-split" dir="rtl">
  <aside class="mv-side">
    <div class="mv-side-top"></div>
    <div class="mv-side-search">
      <i class="ph ph-magnifying-glass"></i>
      <input type="search" id="as-search" placeholder="جست‌وجو" spellcheck="false">
    </div>
    <div class="mv-side-list" id="as-side">${sideHTML()}</div>
  </aside>
  <section class="mv-pane">
    <div class="mv-pane-bar">
      <div class="mv-pane-nav">
        <button type="button" id="as-back"${view.name === 'discover' ? ' disabled' : ''}><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <div class="mv-pane-title" id="as-title">${esc(paneTitle())}</div>
    </div>
    <div class="mv-pane-scroll custom-scrollbar" id="as-pane">${paneBody()}</div>
  </section>
</div>`;
    }

    // ── style ────────────────────────────────────────────────────────────────
    const CSS = `<style>
  .as-split { font-size:13px; }
  .as-split .mv-pane-scroll { padding:0 26px 34px; }

  /* position:static is stated, not assumed: a stray absolute rule from another panel is what
     put this thing in the corner of the sidebar once already. flex:none for the same reason —
     a count must never be squeezed narrower than its own digits. */
  .st-count { position:static; flex:none; align-self:center; margin-inline-start:auto;
    min-width:18px; height:18px; padding:0 5px; border-radius:9px;
    background:var(--mv-fill-2); color:var(--mv-label-2);
    font-size:10.5px; font-weight:700; line-height:1;
    display:inline-flex; align-items:center; justify-content:center; }
  .mv-side-item.active .st-count { background:rgba(255,255,255,.24); color:#fff; }
  /* page-kit clips «the last child span». With a count appended, NO span is the last child any
     more, so the label stopped ellipsising and started shoving the count out of the row.
     :last-of-type is the label again — and it cannot match the <b>. Scoped to this panel; the
     kit's own rule is left alone for the twenty other sidebars that do not carry a count. */
  .as-split .mv-side-item > span:last-of-type:not(.mv-side-tile) {
    min-width:0; overflow:hidden; text-overflow:ellipsis; }

  .as-ico { flex:none; width:56px; height:56px; border-radius:13px; display:grid; place-items:center;
    background:color-mix(in srgb, var(--tint) 16%, transparent); color:var(--tint);
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.06); }
  .as-ico svg { width:30px; height:30px; }
  .as-ico.is-art { background:none; box-shadow:none; }
  .as-ico.is-art svg { width:56px; height:56px; border-radius:13px; }
  .as-ico.is-big { width:110px; height:110px; border-radius:24px; }
  .as-ico.is-big svg { width:58px; height:58px; }
  .as-ico.is-big.is-art svg { width:110px; height:110px; border-radius:24px; }

  .as-note { margin:16px 0 0; padding:10px 13px; border-radius:11px; font-size:11.5px; line-height:1.7;
    color:var(--mv-blue); background:color-mix(in srgb, var(--mv-blue) 12%, transparent); }

  .as-hero { margin-top:16px; padding:26px 28px; border-radius:16px; color:#fff;
    background:linear-gradient(135deg, #18BFFB, #2072F3); }
  .as-hero-kicker { font-size:11px; font-weight:700; letter-spacing:.08em; opacity:.85; }
  .as-hero-title { margin-top:6px; font-size:26px; font-weight:750; line-height:1.3; }
  .as-hero-sub { margin-top:6px; font-size:13px; opacity:.9; }
  .as-hero-btns { margin-top:14px; display:flex; gap:10px; }
  .as-hero-btn { border:0; cursor:pointer; font:inherit; font-size:12.5px;
    font-weight:700; padding:7px 20px; border-radius:999px; background:rgba(255,255,255,.22); color:#fff; }
  .as-hero-btn:hover { background:rgba(255,255,255,.32); }
  .as-hero-btn.is-solid { background:#fff; color:#1668d8; }

  .as-sec { margin-top:28px; }
  .as-sec-head { display:flex; align-items:baseline; gap:12px; padding-bottom:10px;
    border-bottom:var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.22)); }
  .as-sec-head h2 { margin:0; font-size:22px; font-weight:750; letter-spacing:-.01em; }
  .as-sub-head { margin-top:26px; }
  .as-sub-head h2 { font-size:17px; }
  .as-seeall { margin-inline-start:auto; border:0; background:none; cursor:pointer; font:inherit;
    font-size:13px; font-weight:600; color:var(--mv-accent, var(--mv-blue)); }
  .as-allbtn { margin-inline-start:auto; align-self:center; }
  .as-sec-foot { margin-top:10px; font-size:11.5px; color:var(--mv-label-2); line-height:1.8; }
  .as-scan-line { margin-top:10px; font-size:11.5px; color:var(--mv-label-2); }

  .as-rows { display:grid; gap:0 34px; grid-template-columns:repeat(auto-fill, minmax(330px, 1fr)); }
  .as-rows.is-updates { grid-template-columns:1fr; }

  .as-row { display:flex; align-items:center; gap:14px; padding:14px 0; cursor:pointer;
    border-bottom:var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.16)); }
  .as-row:hover .as-row-title { color:var(--mv-accent, var(--mv-blue)); }
  .as-row.is-tall { align-items:flex-start; }
  .as-row-text { flex:1 1 auto; min-width:0; }
  .as-row-title { font-size:14px; font-weight:620; line-height:1.35; }
  .as-tag { margin-inline-start:6px; padding:1px 6px; border-radius:6px; font-size:9.5px; font-weight:700;
    background:color-mix(in srgb, var(--mv-green) 18%, transparent); color:var(--mv-green-ink, var(--mv-green)); }
  .as-row-sub { margin-top:3px; font-size:12px; color:var(--mv-label-2);
    overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .as-row-meta { margin-top:4px; font-size:11.5px; color:var(--mv-label-2); display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
  .as-arrow { opacity:.6; }
  .as-dot { opacity:.5; }
  .as-row-notes { margin-top:6px; font-size:12px; line-height:1.7; color:var(--mv-label-2); }
  .as-row-end { flex:none; display:flex; flex-direction:column; align-items:center; gap:3px; }
  .as-row-end small { font-size:9.5px; color:var(--mv-label-2); }
  .as-note-inline { font-size:10.5px; color:var(--mv-label-2); }

  .as-pill { border:0; cursor:pointer; font:inherit; font-size:12.5px; font-weight:700;
    padding:5px 20px; border-radius:999px; background:var(--mv-fill-2);
    color:var(--mv-accent, var(--mv-blue)); }
  .as-pill:hover { filter:brightness(1.1); }
  .as-pill.is-go { background:var(--mv-accent, var(--mv-blue)); color:#fff; }

  .as-job { margin-top:8px; }
  .as-job small { display:block; margin-top:4px; font-size:10.5px; color:var(--mv-label-2); }
  .as-prog { height:5px; border-radius:3px; background:var(--mv-fill-2); overflow:hidden; }
  .as-prog > i { display:block; height:100%; background:var(--mv-accent, var(--mv-blue)); transition:width .3s; }
  .as-prog.is-idle > i { width:30% !important; animation:as-slide 1.4s ease-in-out infinite; }
  @keyframes as-slide { 0% { margin-inline-start:-30%; } 100% { margin-inline-start:100%; } }

  .as-err { margin-top:8px; display:flex; gap:7px; align-items:flex-start; font-size:11.5px; line-height:1.7;
    color:var(--mv-red-ink, var(--mv-red)); }
  .as-err i { flex:none; margin-top:2px; }
  .as-err-inline { color:var(--mv-red-ink, var(--mv-red)); }

  .as-prod-top { display:flex; align-items:flex-start; gap:22px; padding:24px 0 20px; }
  .as-prod-head { flex:1 1 auto; min-width:0; }
  .as-prod-head h1 { margin:0; font-size:28px; font-weight:750; letter-spacing:-.015em; line-height:1.25; }
  .as-prod-sub { margin-top:5px; font-size:15px; color:var(--mv-label-2); }
  .as-prod-cta { margin-top:16px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  .as-get { border:0; cursor:pointer; font:inherit; font-size:14px; font-weight:700; padding:7px 30px;
    border-radius:999px; background:var(--mv-accent, var(--mv-blue)); color:#fff; }
  .as-get.is-quiet { background:var(--mv-fill-2); color:var(--mv-accent, var(--mv-blue)); }
  .as-cta-note { font-size:11.5px; color:var(--mv-label-2); }

  .as-stats { display:flex; padding:14px 0 18px;
    border-top:var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.2));
    border-bottom:var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.2)); }
  .as-stat { flex:1 1 0; min-width:0; text-align:center; padding:0 8px;
    border-inline-start:var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.2)); }
  .as-stat:first-child { border-inline-start:0; }
  .as-stat-k { font-size:9.5px; font-weight:700; letter-spacing:.06em; color:var(--mv-label-2);
    text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .as-stat-v { margin-top:5px; font-size:22px; font-weight:750; line-height:1.15; color:var(--mv-label); }
  .as-stat-v.as-sm { font-size:15px; word-break:break-all; }
  .as-stat-v.as-ico-v { font-size:22px; color:var(--mv-label-2); opacity:.7; }
  .as-stat-c { margin-top:3px; font-size:10.5px; color:var(--mv-label-2);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

  .as-callout { margin-top:16px; padding:11px 14px; border-radius:11px; font-size:12px; line-height:1.75;
    color:var(--mv-label-2); background:var(--mv-group); }
  .as-callout.is-warn { color:var(--mv-orange-ink, var(--mv-orange));
    background:color-mix(in srgb, var(--mv-orange) 12%, transparent); }

  .as-block { margin-top:26px; padding-top:18px;
    border-top:var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.2)); }
  .as-block-head { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; }
  .as-block-head h3 { margin:0; font-size:17px; font-weight:720; }
  .as-when { margin-inline-start:auto; font-size:12px; color:var(--mv-label-2); }
  .as-ver-line { font-size:12.5px; font-weight:600; color:var(--mv-label-2); margin-bottom:6px; }
  .as-desc { margin:0 0 10px; font-size:13px; line-height:1.85; color:var(--mv-label); }
  .as-sub-h { margin:15px 0 4px; font-size:13px; font-weight:750; color:var(--mv-label); }

  .as-tag.is-up { color:var(--mv-orange-ink); background:color-mix(in srgb, var(--mv-orange) 16%, transparent); }
  .as-sec-note { margin:-2px 0 12px; font-size:12px; line-height:1.8; color:var(--mv-label-2); max-width:78ch; }
  .as-pill.as-upbtn { background:var(--mv-fill); color:var(--mv-label); }
  .as-up-line { display:flex; align-items:center; flex-wrap:wrap; gap:7px; font-size:12.5px; color:var(--mv-label-2); margin-bottom:8px; }
  .as-up-acts { display:flex; flex-wrap:wrap; gap:8px; margin-top:4px; }

  .as-dev { display:flex; align-items:flex-start; gap:15px; }
  .as-dev-logo { flex:none; width:66px; height:66px; border-radius:16px; object-fit:cover; background:#000;
    box-shadow:inset 0 0 0 1px rgba(255,255,255,.08), 0 1px 3px rgba(0,0,0,.22); }
  .as-dev-text { min-width:0; }
  .as-dev-text > b { font-size:14.5px; font-weight:750; }
  .as-dev-text > p { margin:5px 0 10px; font-size:12.5px; line-height:1.85; color:var(--mv-label-2); }
  .as-dev-links { display:flex; flex-wrap:wrap; gap:8px; }
  .as-dev-link { display:inline-flex; align-items:center; gap:6px; height:28px; padding-inline:12px; border:0;
    border-radius:999px; background:var(--mv-fill); color:var(--mv-label); font:inherit; font-size:12px; cursor:pointer; }
  .as-dev-link:hover { background:var(--mv-fill-2); }
  .as-dev-link > i { font-size:14px; color:var(--mv-label-2); }

  .as-ico.is-photo { background:#000; overflow:hidden; }
  .as-ico.is-photo > img { width:100%; height:100%; object-fit:cover; }
  .as-block-head + .as-sub-h { margin-top:2px; }

  .as-log { max-height:190px; overflow:auto; font-size:11.5px; line-height:1.9; color:var(--mv-label-2);
    background:var(--mv-group); border-radius:10px; padding:10px 13px; }

  .as-channel { margin-top:12px; font-size:12.5px; line-height:1.9; color:var(--mv-label-2); }
  .as-channel p { margin:0 0 8px; }
  .as-fine { font-size:11px; opacity:.85; }

  .as-info-row { display:flex; gap:16px; padding:9px 0; font-size:12.5px;
    border-bottom:var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.14)); }
  .as-info-row:last-child { border-bottom:0; }
  .as-info-k { flex:none; width:150px; color:var(--mv-label-2); }
  .as-info-v { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; }

  .as-code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.92em;
    font-variant-numeric:lining-nums; }

  .as-empty { padding:80px 0; text-align:center; color:var(--mv-label-2); }
  .as-empty.is-inline { padding:26px 0; }
  .as-empty i { font-size:44px; opacity:.4; }
  .as-empty p { margin:10px 0; font-size:13px; }
</style>`;

    // ── wiring ───────────────────────────────────────────────────────────────

    function go(name, arg) {
        view = { name: name, arg: arg || null };
        render();
        const pane = document.getElementById('as-pane');
        if (pane) pane.scrollTop = 0;
    }

    function say(msg) {
        const t = document.getElementById('as-title');
        if (!t) return;
        const old = t.textContent;
        t.textContent = msg;
        setTimeout(() => { if (t.textContent === msg) t.textContent = old; }, 3200);
    }

    async function post(url, body) {
        const r = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body || {}),
        });
        const j = await r.json().catch(() => ({ ok: false, error: 'پاسخ سرور خوانده نشد' }));
        if (!r.ok || j.ok === false) throw new Error(j.error || ('خطای ' + r.status));
        return j;
    }

    function bind(root) {
        root.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', (e) => {
            e.stopPropagation();
            go(b.getAttribute('data-go'));
        }));
        root.querySelectorAll('[data-stop]').forEach(b => b.addEventListener('click', (e) => e.stopPropagation()));
        root.querySelectorAll('.as-row[data-open]').forEach(b => b.addEventListener('click', () => {
            go('product', b.getAttribute('data-open'));
        }));
        root.querySelectorAll('button[data-open]').forEach(b => b.addEventListener('click', (e) => {
            e.stopPropagation(); go('product', b.getAttribute('data-open'));
        }));

        root.querySelectorAll('[data-update]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const r = findByKey(b.getAttribute('data-update'));
            if (!r) return;
            b.disabled = true;
            try {
                if (r.kind === 'core') await post('/api/store/core/update', { id: r.id });
                else if (r.kind === 'data') await post('/api/store/data/update', { id: r.id });
                else await post('/api/store/worker/update', { accountId: r.accountId, script: r.script, expect: r.id });
                refresh();
            } catch (err) { say(err.message); b.disabled = false; }
        }));

        root.querySelectorAll('[data-rollback]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation();
            b.disabled = true;
            const back = b.getAttribute('data-rollback');
            const kind = (findByKey('data|' + back) ? 'data' : 'core');
            try { await post('/api/store/' + kind + '/rollback', { id: back }); refresh(); }
            catch (err) { say(err.message); b.disabled = false; }
        }));

        root.querySelectorAll('[data-wrollback]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const r = findByKey(b.getAttribute('data-wrollback'));
            if (!r) return;
            b.disabled = true;
            try { await post('/api/store/worker/rollback', { accountId: r.accountId, script: r.script }); say('کد قبلی برگردانده شد'); refresh(); }
            catch (err) { say(err.message); b.disabled = false; }
        }));

        root.querySelectorAll('[data-cancel]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation();
            const r = findByKey(b.getAttribute('data-row'));
            if (!r) return;
            const key = r.kind === 'core' ? 'core:' + r.id : 'worker:' + r.accountId + ':' + r.script;
            try { await post('/api/store/job/cancel', { key }); refresh(); } catch (err) { say(err.message); }
        }));

        root.querySelectorAll('[data-workers]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation(); b.disabled = true;
            try { await post('/api/store/workers/refresh'); say('در حال بررسی حساب‌ها…'); refresh(); }
            catch (err) { say(err.message); b.disabled = false; }
        }));

        root.querySelectorAll('[data-all]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation(); b.disabled = true;
            try { await post('/api/store/update-all'); go('updates'); }
            catch (err) { say(err.message); b.disabled = false; }
        }));

        root.querySelectorAll('[data-channel]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation(); b.disabled = true;
            try { await post('/api/store/channel/refresh'); say('کانال بررسی شد'); setTimeout(refresh, 1500); }
            catch (err) { say(err.message); b.disabled = false; }
        }));

        root.querySelectorAll('[data-upstream]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation(); b.disabled = true;
            const id = b.getAttribute('data-upstream');
            try {
                await post('/api/store/upstream', { id });
                say('در حال پرسیدن از مخزن…');
                setTimeout(async () => {
                    await pollJobs();
                    const j = jobsMap['upstream:' + id];
                    if (j && j.result && j.result.releases && j.result.releases.length) {
                        const newest = j.result.releases[0];
                        const row = rowById(id)[0];
                        notice = 'تازه‌ترین انتشار ' + esc(id) + ' در مخزن: <b>' + esc(newest.version) + '</b>'
                            + (row && row.version ? ' — نسخهٔ در حال استفاده: ' + esc(row.version) : '')
                            + '. تا وقتی این نسخه با همین برنامه آزموده و امضا نشود، استور نصبش نمی‌کند.';
                        render();
                    } else if (j && j.error) { say(j.error.message); }
                }, 2500);
            } catch (err) { say(err.message); b.disabled = false; }
        }));

        root.querySelectorAll('[data-app]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation(); b.disabled = true;
            const action = b.getAttribute('data-app');
            try { await post('/api/store/app/' + action); refresh(); }
            catch (err) { say(err.message); b.disabled = false; }
        }));

        // A link to the project's own page opens in the reader's browser, never inside the app.
        root.querySelectorAll('[data-open-url]').forEach(b => b.addEventListener('click', (e) => {
            e.stopPropagation();
            try { window.open(b.getAttribute('data-open-url'), '_blank'); } catch (err) { /* no shell */ }
        }));

        root.querySelectorAll('[data-upcheck]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation(); b.disabled = true;
            try { await post('/api/store/upstream/refresh'); notice = 'در حال خواندن انتشارهای سازنده‌ها…'; render(); }
            catch (err) { say(err.message); b.disabled = false; }
        }));

        root.querySelectorAll('[data-vodi]').forEach(b => b.addEventListener('click', async (e) => {
            e.stopPropagation(); b.disabled = true;
            try { await post('/api/store/vodi/redeploy', { id: b.getAttribute('data-vodi') }); refresh(); }
            catch (err) { say(err.message); b.disabled = false; }
        }));
    }

    /**
     * What a re-render must NOT throw away.
     *
     * `render()` replaces the whole panel (`root.innerHTML = shell()`), and while an update is
     * running `startPolling` calls `refresh() → render()` every 1.5 seconds. Every one of those
     * hands the user a brand-new `#as-pane` whose scrollTop is 0 — so they scroll down, and a
     * second later they are back at the top. Reported as «در زمان بروزرسانی نمیشه صفحه رو اسکرول
     * کرد»: the scrolling works, it is just undone faster than they can read, which is
     * indistinguishable from a frozen page. The search box went the same way — typing a query
     * during an update lost the caret and the text on the next tick.
     *
     * `go()` still jumps to the top afterwards, because that is a navigation and not a redraw.
     */
    function captureUi(root) {
        const pane = root.querySelector('#as-pane');
        const side = root.querySelector('#as-side');
        const q = root.querySelector('#as-search');
        const focused = document.activeElement;
        return {
            pane: pane ? pane.scrollTop : 0,
            side: side ? side.scrollTop : 0,
            q: q ? q.value : '',
            qFocus: !!(q && focused === q),
            qStart: q ? q.selectionStart : null,
            qEnd: q ? q.selectionEnd : null,
        };
    }

    function restoreUi(root, keep) {
        if (!keep) return;
        const pane = root.querySelector('#as-pane');
        const side = root.querySelector('#as-side');
        if (pane && keep.pane) pane.scrollTop = keep.pane;
        if (side && keep.side) side.scrollTop = keep.side;
        const q = root.querySelector('#as-search');
        if (!q || !keep.q) return;
        q.value = keep.q;
        // Redraws the hit list from the query that was already typed. Only for a query with
        // something in it: on a blank one the handler calls `go('discover')`, which renders,
        // which lands back here — and that is an infinite loop, not a search.
        if (keep.q.trim()) q.dispatchEvent(new Event('input'));
        if (pane && keep.pane) pane.scrollTop = keep.pane;
        if (!keep.qFocus) return;
        q.focus();
        // A search input rejects setSelectionRange in some engines; the text is what matters.
        try { q.setSelectionRange(keep.qStart, keep.qEnd); } catch (e) { /* caret at the end */ }
    }

    function render() {
        const root = document.getElementById('ls-store');
        if (!root) return;
        const keep = captureUi(root);
        root.innerHTML = shell();
        bind(root);

        const back = root.querySelector('#as-back');
        if (back) back.addEventListener('click', () => go('discover'));

        const q = root.querySelector('#as-search');
        if (q) q.addEventListener('input', () => {
            const v = q.value.trim();
            if (!v) return go('discover');
            const hits = data.rows.filter(x => (x.title + ' ' + (look(x.id).sub || '') + ' ' + (x.repo || '') + ' ' + (x.script || '')).indexOf(v) >= 0);
            const pane = document.getElementById('as-pane');
            const title = document.getElementById('as-title');
            if (title) title.textContent = 'جست‌وجو';
            if (!pane) return;
            pane.innerHTML = hits.length
                ? '<div class="as-sec"><div class="as-sec-head"><h2>' + fa(hits.length) + ' نتیجه</h2></div>' + rowGrid(hits) + '</div>'
                : '<div class="as-empty"><i class="ph ph-magnifying-glass"></i><p>چیزی پیدا نشد.</p></div>';
            bind(pane);
        });

        // Last, so the `input` listener above already exists: a query carried across the rebuild
        // has to redraw its own results, or the box says «psi» over a pane showing «کشف».
        restoreUi(root, keep);
    }

    // ── data ─────────────────────────────────────────────────────────────────

    async function pollJobs() {
        try {
            const r = await fetch('/api/store/jobs');
            if (!r.ok) return false;
            const j = await r.json();
            jobsMap = j.jobs || {};
            return true;
        } catch (e) { return false; }
    }

    async function load() {
        try {
            const r = await fetch('/api/store/catalog');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            if (j && Array.isArray(j.rows)) data = j;
            return true;
        } catch (e) { return false; }
    }

    let refreshing = false;
    async function refresh() {
        if (refreshing) return;
        refreshing = true;
        const ok = await load();
        await pollJobs();
        refreshing = false;
        if (ok) render();
        return ok;
    }

    /** Poll while anything is running — and stop as soon as nothing is, so an idle window is idle. */
    function startPolling() {
        if (poll) clearInterval(poll);
        poll = setInterval(async () => {
            const root = document.getElementById('ls-store');
            if (!root || !root.offsetParent) return;          // the window is closed or hidden
            const anyRunning = Object.keys(jobsMap).some(k => jobsMap[k] && jobsMap[k].running);
            if (!anyRunning) { await pollJobs(); return; }
            await refresh();
        }, 1500);
    }

    // Set by `storeOpenItem` just before the store window is brought forward: showing the window
    // runs `storeRender`, which would otherwise reset the view to «کشف» over the page we came for.
    let pendingView = null;

    window.storeRender = function () {
        view = pendingView || { name: 'discover', arg: null };
        pendingView = null;
        notice = '';
        render();                    // draw the frame at once, even before the disk answers
        refresh();
        startPolling();
    };

    /**
     * Open the store on one item — `core|psiphon`, `core|tor`, … — from another window.
     *
     * This is what «بررسی بروزرسانی» on an engine page calls. The check itself belongs here: the
     * store is what knows the signed channel, the installed version and the tested one.
     */
    window.storeOpenItem = function (key) {
        pendingView = { name: 'product', arg: key };
        if (window.MV && MV.wm) MV.wm.open('store');
        // Still set means nothing consumed it — no window manager, or a panel that is already
        // mounted and did not re-run `storeRender`. Navigate in place instead.
        if (pendingView) {
            pendingView = null;
            if (document.getElementById('ls-store')) { go('product', key); refresh(); }
        }
    };
    window.MVStore = { render, go, refresh, openItem: window.storeOpenItem, get data() { return data; } };
})();
