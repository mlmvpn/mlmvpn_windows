/*
 * Proxy hypotheses.
 *
 * The dead system proxy is the single most common reason "nothing opens" after an engine
 * crashes on this product, and it was structurally invisible to the first design because
 * every probe there ran with `proxy: false` — Node ignores the proxy the browser obeys, so
 * the machine looked perfectly healthy while no page would load.
 *
 * Note what the decisive gate is built from: the configuration, a refused TCP connection to
 * the endpoint, and who owns the listener. It is deliberately NOT built from a proxied HTTP
 * round trip, because that would make our HTTP client's fidelity to WinINET part of the
 * verdict — and we do not emulate a browser, we measure the decomposition.
 */

'use strict';

const { IDS, SYMPTOM } = require('./ids');
const { OWNERSHIP } = require('../ownership');

const eq = v => x => x === v;
const isTrue = x => x === true;
const isFalse = x => x === false;

module.exports = [
    {
        id: 'proxy.dead-listener',
        title: 'پراکسی سیستم به پورتی اشاره می‌کند که کسی پشت آن نیست',
        category: 'proxy',
        layer: 5,

        // Ownership first: a live tunnel's own proxy is not a fault, and disabling it would
        // send an Iranian user's traffic out in the clear while the UI reported success.
        byDesignWhen: { factId: IDS.PROXY_ENDPOINT_OWNERSHIP, predicate: eq(OWNERSHIP.OURS_LIVE) },

        necessary: [
            {
                factId: IDS.PROXY_WININET_ENABLED, predicate: isTrue,
                because: 'no proxy is configured for the interactive user, so a dead proxy cannot be the cause',
            },
        ],
        decisive: [
            { factId: IDS.PROXY_WININET_ENABLED, predicate: isTrue },
            { factId: IDS.PROXY_ENDPOINT_TCP_OK, predicate: isFalse },
            {
                factId: IDS.PROXY_ENDPOINT_OWNERSHIP,
                predicate: v => v === OWNERSHIP.FOREIGN || v === OWNERSHIP.OURS_ORPHANED,
            },
        ],
        decisiveBecause: 'a proxy is configured, its port refuses connections, and no live owner is behind it',

        supporting: [
            { factId: IDS.PROXY_HTTP_BYPASS_OK, predicate: isTrue, weight: 1 },
            { factId: IDS.APP_ENGINE_RUNNING, predicate: isFalse, weight: 0.5 },
        ],
        refuting: [
            // If traffic through the proxy works, the proxy is not dead. Whatever else is
            // wrong, it is not this.
            { factId: IDS.PROXY_HTTP_VIA_OK, predicate: isTrue, decisive: true, because: 'HTTP through the proxy succeeded' },
        ],

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['dns.resolver-unreachable', 'http.all-fail'],
        repairs: ['proxy.wininet.disable'],

        explain: () => ({
            what: 'ویندوز طوری تنظیم شده که همهٔ ترافیک را به یک پراکسی روی همین کامپیوتر بفرستد، ولی هیچ برنامه‌ای روی آن پورت گوش نمی‌دهد.',
            why: 'مرورگر هر درخواست را به آن پراکسی می‌دهد و چون کسی جواب نمی‌دهد، هیچ صفحه‌ای باز نمی‌شود — با اینکه خودِ اینترنت سالم است.',
        }),
    },

    {
        id: 'proxy.pac-dead',
        title: 'آدرس اسکریپت پراکسی (PAC) در دسترس نیست',
        category: 'proxy',
        layer: 5,

        // A PAC URL is honoured independently of ProxyEnable, which is exactly why the
        // repository's enableSystemProxy(false) does not repair this case: it clears the
        // enable flag and never touches AutoConfigURL.
        necessary: [
            { factId: IDS.PROXY_PAC_URL, predicate: v => !!v, because: 'no PAC URL is configured' },
        ],
        decisive: [
            { factId: IDS.PROXY_PAC_URL, predicate: v => !!v },
            { factId: IDS.PROXY_PAC_FETCHABLE, predicate: isFalse },
            { factId: IDS.PROXY_HTTP_BYPASS_OK, predicate: isTrue },
        ],
        decisiveBecause: 'a PAC URL is configured, it cannot be fetched, and the direct path works',

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['http.all-fail'],
        repairs: ['proxy.pac.clear'],

        explain: facts => ({
            what: 'مرورگر برای پیداکردن راه خروج، اول باید یک فایل تنظیمات (PAC) را دانلود کند؛ آن آدرس در دسترس نیست.',
            why: 'تا وقتی آن فایل خوانده نشود، مرورگر هیچ درخواستی را نمی‌فرستد. توجه: خاموش‌کردن سادهٔ پراکسی این را درست نمی‌کند، چون ویندوز PAC را جدا از آن کلید می‌خواند.',
            measured: facts[IDS.PROXY_PAC_URL] && facts[IDS.PROXY_PAC_URL].value,
        }),
    },

    {
        id: 'proxy.wininet-winhttp-mismatch',
        title: 'تنظیم پراکسی مرورگر با تنظیم پراکسی سرویس‌ها یکی نیست',
        category: 'proxy',
        layer: 5,

        // Not a cause of "nothing opens" by itself — it is why one thing works and another
        // does not, which is a genuinely useful independent finding and a bad headline.
        necessary: [
            { factId: IDS.PROXY_WININET_ENABLED, predicate: v => v === true || v === false },
            { factId: IDS.PROXY_WINHTTP_MODE, predicate: v => typeof v === 'string' },
        ],
        supporting: [
            {
                factId: IDS.PROXY_WINHTTP_MODE, weight: 1,
                predicate: (mode, f, all) => mode === 'proxy',
            },
        ],
        conflictWhen: [{
            a: { factId: IDS.PROXY_WININET_ENABLED, predicate: isFalse },
            b: { factId: IDS.PROXY_WINHTTP_MODE, predicate: eq('proxy') },
            note: 'WinINET says direct, WinHTTP says proxy',
        }],

        explains: [],                    // deliberately explains nothing
        causes: [],
        repairs: ['proxy.winhttp.reset'],

        explain: () => ({
            what: 'تنظیم پراکسیِ مرورگر و تنظیم پراکسیِ سرویس‌های ویندوز با هم فرق دارند.',
            why: 'این باعث می‌شود بعضی برنامه‌ها کار کنند و بعضی نه. علت «باز نشدن همهٔ صفحه‌ها» نیست، ولی ارزش دانستن دارد.',
        }),
    },
];
