/*
 * Services, clock, link stability, scope, captive, and LSP.
 *
 * Grouped because each family here is one or two hypotheses, and splitting them across six
 * near-empty files would hide rather than reveal the relationships — the clock rule exists
 * specifically to pre-empt the TLS rule, and the scope rule exists specifically to pre-empt
 * the whole link/route/firewall family.
 */

'use strict';

const { IDS, SYMPTOM } = require('./ids');

const eq = v => x => x === v;
const isTrue = x => x === true;
const isFalse = x => x === false;

module.exports = [
    // ── services ────────────────────────────────────────────────────────────────────────
    {
        id: 'svc.bfe-stopped',
        title: 'سرویس Base Filtering Engine اجرا نیست',
        category: 'service',
        layer: 0,

        // BFE down means the Windows Filtering Platform fails closed: ALL traffic dies while
        // every adapter still shows Connected. A textbook cause of this exact symptom, and one
        // that is invisible to anything that only looks at adapters and routes.
        necessary: [
            { factId: IDS.SVC_BFE_RUNNING, predicate: v => v === false || v === true, because: 'service state unreadable' },
        ],
        decisive: [{ factId: IDS.SVC_BFE_RUNNING, predicate: isFalse }],
        decisiveBecause: 'BFE is stopped, so the filtering platform denies everything',

        explains: [SYMPTOM.NOTHING_OPENS],
        // Everything downstream is a consequence of this, which is what stops the report from
        // listing five separate faults for one stopped service.
        causes: ['dns.resolver-unreachable', 'http.all-fail', 'link.no-transport', 'proxy.dead-listener'],
        repairs: ['svc.start-bfe'],

        explain: () => ({
            what: 'سرویس پایه‌ای فیلترینگ ویندوز (BFE) متوقف شده است.',
            why: 'وقتی این سرویس نباشد، ویندوز از سر احتیاط جلوی همهٔ ترافیک را می‌گیرد — کارت شبکه «متصل» می‌ماند ولی هیچ‌چیز رد نمی‌شود.',
        }),
    },
    {
        id: 'svc.dnscache-stopped',
        title: 'سرویس DNS Client اجرا نیست',
        category: 'service',
        layer: 0,
        necessary: [{ factId: IDS.SVC_DNSCACHE_RUNNING, predicate: v => typeof v === 'boolean' }],
        decisive: [{ factId: IDS.SVC_DNSCACHE_RUNNING, predicate: isFalse }],
        decisiveBecause: 'Dnscache is stopped, so every lookup fails with the adapter perfectly configured',
        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['dns.resolver-unreachable', 'http.all-fail'],
        repairs: ['svc.start-dnscache'],
        explain: () => ({
            what: 'سرویس DNS Client ویندوز متوقف شده است.',
            why: 'با اینکه تنظیمات شبکه کاملاً درست است، هیچ آدرسی ترجمه نمی‌شود.',
        }),
    },

    // ── clock ───────────────────────────────────────────────────────────────────────────
    {
        id: 'time.skew',
        title: 'ساعت سیستم اشتباه است',
        category: 'time',
        layer: 4,

        // Ordered ahead of any interference conclusion on purpose. A clock days out of date
        // breaks every TLS handshake while ICMP and TCP stay perfect — a flawless imitation of
        // "connected, nothing opens", and the reason a naive engine reports DPI here.
        necessary: [
            { factId: IDS.TIME_SKEW_SECONDS, predicate: v => typeof v === 'number', because: 'clock skew unknown' },
        ],
        decisive: [
            { factId: IDS.TIME_SKEW_SECONDS, predicate: s => Math.abs(s) > 300 },
            { factId: IDS.TLS_TCP_OK, predicate: isTrue },
            { factId: IDS.TLS_HANDSHAKE_OK, predicate: isFalse },
        ],
        decisiveBecause: 'TCP reaches the host but TLS fails, and the clock is more than five minutes out',

        supporting: [{ factId: IDS.TLS_CERT_DATE_INVALID, predicate: isTrue, weight: 1 }],

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['tls.interference-suspected', 'http.all-fail'],
        repairs: ['time.resync'],

        explain: facts => ({
            what: 'ساعت یا تاریخ ویندوز با زمان واقعی اختلاف زیادی دارد.',
            why: 'سایت‌های امن (HTTPS) گواهی‌شان را بر اساس تاریخ بررسی می‌کنند؛ با ساعت اشتباه، هیچ اتصال امنی برقرار نمی‌شود — هرچند اینترنت کاملاً سالم است.',
            measured: facts[IDS.TIME_SKEW_SECONDS] && facts[IDS.TIME_SKEW_SECONDS].value,
        }),
    },

    {
        id: 'tls.interference-suspected',
        title: 'احتمال اختلال در مسیر شبکه',
        category: 'tls',
        layer: 4,

        // The strongest defensible label. "DPI detected" is not provable from user space
        // without packet capture, and claiming it destroys the user's trust in everything else
        // the report says. Note the necessary gate on the clock: skew must be ruled OUT first.
        necessary: [
            { factId: IDS.TLS_TCP_OK, predicate: isTrue, because: 'TCP does not even reach the host' },
            {
                factId: IDS.TIME_SKEW_SECONDS, predicate: s => Math.abs(s) <= 300,
                because: 'the clock is wrong, which explains the handshake failures on its own',
            },
            {
                factId: IDS.TLS_FAIL_HOSTS, predicate: n => n >= 2,
                because: 'only one host failed, which is a destination problem rather than a path problem',
            },
            {
                // Independent validation wrote this gate. Without it, two public DNS resolvers
                // being reset — which is routine on this line — headlined «اختلال در مسیر شبکه»
                // as the reason nothing opens, on a machine where example.com, microsoft.com,
                // github.com and aparat.com all completed TLS and every page loaded.
                //
                // Two operators are not two kinds of destination. A claim about the user's
                // browsing has to survive contact with the destinations browsing uses.
                factId: IDS.TLS_FAIL_CATEGORIES, predicate: n => n >= 2,
                because: 'the handshake failures were confined to one kind of destination, which says nothing about the path the browser takes',
            },
        ],
        supporting: [{ factId: IDS.TLS_HANDSHAKE_OK, predicate: isFalse, weight: 1 }],

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['http.all-fail'],
        repairs: [],

        explain: () => ({
            what: 'اتصال TCP به مقصد برقرار می‌شود، ولی درست در لحظهٔ شروع ارتباط امن قطع می‌شود — روی چند مقصد مختلف.',
            why: 'این الگو معمولاً یعنی چیزی در مسیر دارد ارتباط را قطع می‌کند. نمی‌توانیم از روی این کامپیوتر ثابت کنیم دقیقاً چیست، پس آن را «احتمالی» می‌گوییم.',
        }),
    },

    // ── scope: the healthy machine on a filtered line ───────────────────────────────────
    {
        id: 'scope.international-only',
        title: 'دسترسی بین‌المللی محدود است',
        category: 'scope',
        layer: 2,

        // Without this, a filtering event that blackholes the foreign anchors produces the
        // top-left cell of the diagnosis matrix — link/gateway/firewall/BFE — and offers
        // privileged repairs on a machine with nothing wrong with it.
        necessary: [
            { factId: IDS.REACH_GATEWAY_V4, predicate: eq('ok'), because: 'the local link itself is not healthy' },
            { factId: IDS.REACH_DOMESTIC_V4, predicate: eq('ok'), because: 'domestic reachability is not established' },
        ],
        decisive: [
            { factId: IDS.REACH_GATEWAY_V4, predicate: eq('ok') },
            { factId: IDS.REACH_DOMESTIC_V4, predicate: eq('ok') },
            { factId: IDS.REACH_FOREIGN_V4, predicate: eq('fail') },
        ],
        decisiveBecause: 'the gateway and domestic anchors answer while every independent foreign group does not',

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['http.all-fail', 'link.no-transport', 'tls.interference-suspected'],
        repairs: [],                    // there is nothing to repair on this machine

        explain: () => ({
            what: 'ارتباط با شبکهٔ محلی و مقصدهای داخل ایران برقرار است، ولی هیچ‌کدام از مقصدهای بین‌المللی پاسخ نمی‌دهند.',
            why: 'یعنی مشکل از تنظیمات ویندوز شما نیست و چیزی برای تعمیر روی این کامپیوتر پیدا نکردیم. علتش بیرون از این دستگاه است و از اینجا قابل اثبات نیست.',
        }),
    },

    // ── link stability ──────────────────────────────────────────────────────────────────
    {
        id: 'link.unstable',
        title: 'ارتباط ناپایدار است',
        category: 'link',
        layer: 1,

        // Retry disagreement is a diagnosis, not noise to be smoothed away. Reporting a hard
        // failure for a link that answers every other attempt sends the user chasing a cause
        // that is not there.
        necessary: [{ factId: IDS.LINK_FLAPPING, predicate: isTrue, because: 'probes agreed with each other' }],
        decisive: [{ factId: IDS.LINK_FLAPPING, predicate: isTrue }],
        decisiveBecause: 'repeated probes to the same target disagreed with each other',
        explains: [SYMPTOM.NOTHING_OPENS],
        causes: [],
        repairs: [],
        explain: () => ({
            what: 'یک آزمون یکسان در تلاش‌های پیاپی نتیجهٔ متفاوت داد.',
            why: 'ارتباط قطع و وصل می‌شود. این با «قطعِ کامل» فرق دارد و راه‌حلش هم فرق می‌کند — معمولاً کیفیت خط یا وای‌فای است، نه تنظیمات ویندوز.',
        }),
    },

    // ── captive portal ──────────────────────────────────────────────────────────────────
    {
        id: 'captive.portal',
        title: 'شبکه شما را به صفحهٔ ورود هدایت می‌کند',
        category: 'captive',
        layer: 5,
        necessary: [{ factId: IDS.CAPTIVE_DETECTED, predicate: isTrue, because: 'no interception observed' }],
        decisive: [{ factId: IDS.CAPTIVE_DETECTED, predicate: isTrue }],
        decisiveBecause: 'a connectivity endpoint answered with content that was not the expected content',
        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['http.all-fail'],
        repairs: [],
        explain: facts => ({
            what: 'این شبکه قبل از دادن اینترنت، شما را به یک صفحهٔ ورود می‌فرستد.',
            why: 'تا وقتی آن صفحه را باز و تأیید نکنید، هیچ سایت دیگری باز نمی‌شود.',
            measured: facts[IDS.CAPTIVE_LOCATION] && facts[IDS.CAPTIVE_LOCATION].value,
        }),
    },

    // ── third-party LSP ─────────────────────────────────────────────────────────────────
    {
        id: 'winsock.thirdparty-lsp',
        title: 'یک افزونهٔ شبکهٔ غیرویندوزی در مسیر ترافیک هست',
        category: 'winsock',
        layer: 0,

        // Present is provable; being THE blocker is not, from user space. So this is an
        // independent finding by construction — it explains nothing — and it never becomes a
        // headline or triggers winsock.reset on its own.
        necessary: [{ factId: IDS.WINSOCK_THIRDPARTY_COUNT, predicate: n => n > 0, because: 'catalog is Microsoft-only' }],
        supporting: [{ factId: IDS.WINSOCK_THIRDPARTY_COUNT, predicate: n => n > 0, weight: 1 }],
        explains: [],
        causes: [],
        repairs: [],
        explain: facts => ({
            what: 'در کاتالوگ شبکهٔ ویندوز یک یا چند افزونهٔ غیرویندوزی ثبت شده (معمولاً از آنتی‌ویروس یا نرم‌افزار امنیتی).',
            why: 'این افزونه‌ها می‌توانند ترافیک را ببلعند، ولی از داخل ویندوز نمی‌شود ثابت کرد که مقصر همین است. فقط اطلاع می‌دهیم.',
            measured: facts[IDS.WINSOCK_THIRDPARTY_COUNT] && facts[IDS.WINSOCK_THIRDPARTY_COUNT].value,
        }),
    },

    // ── the generic downstream effects ──────────────────────────────────────────────────
    // These exist purely as collapse targets in the causes graph, so that "nothing opens" and
    // "no transport" stop being reported as separate discoveries alongside their cause.
    {
        id: 'http.all-fail',
        title: 'هیچ صفحه‌ای باز نمی‌شود',
        category: 'symptom',
        layer: 9,
        symptomOnly: true,
        necessary: [{ factId: IDS.PROXY_HTTP_BYPASS_OK, predicate: isFalse, because: 'the direct path works' }],
        supporting: [{ factId: IDS.PROXY_HTTP_BYPASS_OK, predicate: isFalse, weight: 1 }],
        explains: [SYMPTOM.NOTHING_OPENS],
        causes: [],
        repairs: [],
        explain: () => ({
            what: 'هیچ درخواست وبی به نتیجه نرسید.',
            why: 'این خودِ نشانه است؛ علتش در بخش بالا آمده.',
        }),
    },
    {
        id: 'link.no-transport',
        title: 'هیچ اتصالی به بیرون برقرار نمی‌شود',
        category: 'link',
        layer: 9,
        symptomOnly: true,
        necessary: [{ factId: IDS.REACH_FOREIGN_V4, predicate: eq('fail'), because: 'outbound connections work' }],
        supporting: [{ factId: IDS.REACH_FOREIGN_V4, predicate: eq('fail'), weight: 1 }],
        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['http.all-fail'],
        repairs: [],
        explain: () => ({
            what: 'هیچ اتصال مستقیمی به مقصدهای بیرونی برقرار نشد.',
            why: 'این نشانه است، نه علت.',
        }),
    },
];
