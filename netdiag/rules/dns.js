/*
 * DNS hypotheses.
 *
 * The discipline here is about what may be CONCLUDED, not about collecting more.
 *
 *   * `dns.answer.forged` is positive-only evidence. A POISON_IPS match proves forgery; the
 *     absence of one proves nothing at all, because route-cache.js:51's list is a snapshot and
 *     Iranian poison targets change. It is never a refuting gate.
 *   * "unreachable" and "reachable but answering wrongly" need different repairs, so they are
 *     separated by UDP/53 and TCP/53 evidence rather than by a single timeout.
 *   * a global DNS claim needs breadth. One failing name is an application-level finding.
 *   * DNS the app itself owns is by-design; DNS the app owns but no longer maintains is the
 *     highest-value fault in the family, and it is repaired through dns-manager's own restore.
 */

'use strict';

const { IDS, SYMPTOM } = require('./ids');
const { OWNERSHIP } = require('../ownership');

const eq = v => x => x === v;
const isTrue = x => x === true;
const isFalse = x => x === false;

module.exports = [
    {
        id: 'dns.resolver-unreachable',
        title: 'سرور DNS پاسخ نمی‌دهد',
        category: 'dns',
        layer: 3,

        byDesignWhen: { factId: IDS.DNS_CONFIG_OWNERSHIP, predicate: eq(OWNERSHIP.OURS_LIVE) },

        necessary: [
            // Without knowing the local link works, an unreachable resolver says nothing about
            // DNS — it is just another symptom of a dead line.
            {
                factId: IDS.REACH_GATEWAY_V4, predicate: eq('ok'),
                because: 'the gateway is not reachable, so DNS cannot be blamed for the outage',
            },
        ],
        decisive: [
            { factId: IDS.DNS_RESOLVER_UDP53_OK, predicate: isFalse },
            { factId: IDS.DNS_RESOLVER_TCP53_OK, predicate: isFalse },
            { factId: IDS.REACH_GATEWAY_V4, predicate: eq('ok') },
        ],
        decisiveBecause: 'neither UDP/53 nor TCP/53 reaches the configured resolver while the local link is fine',

        supporting: [
            { factId: IDS.DNS_RESOLVE_OK_V4, predicate: isFalse, weight: 1 },
        ],
        refuting: [
            { factId: IDS.DNS_RESOLVE_OK_V4, predicate: isTrue, decisive: true, because: 'names are resolving' },
        ],

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['http.all-fail'],
        repairs: ['dns.flush', 'dns.restore'],

        explain: () => ({
            what: 'کامپیوتر شما نمی‌تواند به سروری که آدرس سایت‌ها را ترجمه می‌کند وصل شود.',
            why: 'بدون این ترجمه، مرورگر حتی نمی‌داند به کجا وصل شود، پس هیچ آدرسی باز نمی‌شود.',
        }),
    },

    {
        id: 'dns.stranded-loopback',
        title: 'DNS ویندوز روی همین کامپیوتر تنظیم مانده و کسی آنجا پاسخ نمی‌دهد',
        category: 'dns',
        layer: 3,

        // The classic leftover from a crashed engine: Windows points at 127.0.0.1:53 and
        // nothing is listening. dns-manager already detects the shape; ownership decides
        // whether it is deliberate.
        byDesignWhen: { factId: IDS.DNS_CONFIG_OWNERSHIP, predicate: eq(OWNERSHIP.OURS_LIVE) },

        necessary: [
            { factId: IDS.DNS_CONFIG_LOOPBACK, predicate: isTrue, because: 'DNS is not pointed at loopback' },
        ],
        decisive: [
            { factId: IDS.DNS_CONFIG_STRANDED_LOOPBACK, predicate: isTrue },
            {
                factId: IDS.DNS_CONFIG_OWNERSHIP,
                predicate: v => v === OWNERSHIP.OURS_ORPHANED || v === OWNERSHIP.FOREIGN,
            },
        ],
        decisiveBecause: 'DNS points at a loopback resolver that is not running and that no live engine owns',

        supporting: [{ factId: IDS.APP_ENGINE_RUNNING, predicate: isFalse, weight: 1 }],

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['dns.resolver-unreachable', 'http.all-fail'],
        repairs: ['dns.restore'],

        explain: () => ({
            what: 'ویندوز برای ترجمهٔ آدرس‌ها به خودِ این کامپیوتر مراجعه می‌کند، ولی برنامه‌ای که قرار بود آنجا جواب بدهد اجرا نیست.',
            why: 'این معمولاً از یک اجرای ناتمام VPN باقی می‌ماند؛ تا وقتی برنگردد، هیچ آدرسی ترجمه نمی‌شود.',
        }),
    },

    {
        id: 'dns.answer-anomaly',
        title: 'پاسخ‌های DNS دستکاری‌شده به نظر می‌رسند',
        category: 'dns',
        layer: 3,

        necessary: [
            { factId: IDS.DNS_RESOLVE_OK_V4, predicate: isTrue, because: 'nothing is resolving, so answers cannot be judged' },
            // Breadth. One name behaving oddly is an application-level finding, not a machine
            // one, and CDN/anycast variation is normal and must never be an anomaly by itself.
            {
                factId: IDS.DNS_ANSWER_NAMES_TESTED, predicate: n => n >= 5,
                because: 'too few names were tested to make a claim about DNS as a whole',
            },
        ],
        decisive: [
            { factId: IDS.DNS_ANSWER_FORGED, predicate: isTrue },
        ],
        decisiveBecause: 'answers matched the known local poison set, or returned a bogon for a public name',

        supporting: [
            { factId: IDS.DNS_ANSWER_NAMES_FAILED, predicate: n => n >= 2, weight: 1 },
        ],

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['http.all-fail'],
        repairs: ['dns.flush', 'dns.restore'],

        explain: () => ({
            what: 'سرور DNS پاسخ می‌دهد، ولی آدرس‌هایی که برمی‌گرداند درست نیستند.',
            why: 'مرورگر به نشانی اشتباه وصل می‌شود و صفحه باز نمی‌شود، در حالی که به نظر می‌رسد DNS «کار می‌کند».',
        }),
    },

    {
        id: 'dns.hosts-entry',
        title: 'فایل hosts چند آدرس را به جای دیگری می‌فرستد',
        category: 'dns',
        layer: 3,

        // Hosts entries are usually the user's own doing, so their mere existence is not a
        // finding. On the development machine, 90 deliberate license-blocking entries
        // (0.0.0.0 bandicam.com and friends) made this a "likely" finding offering a
        // confirm-danger repair on a machine with nothing wrong — the tool proposing to undo
        // something the user had chosen on purpose.
        //
        // So resolution must ACTUALLY be failing before hosts entries are worth raising. When
        // everything resolves, the entries are configuration, not evidence, and the rule is
        // eliminated rather than reported.
        necessary: [
            { factId: IDS.DNS_HOSTS_ENTRIES, predicate: n => n > 0, because: 'the hosts file has no active entries' },
        ],
        supporting: [{ factId: IDS.DNS_HOSTS_ENTRIES, predicate: n => n > 0, weight: 1 }],

        explains: [],                     // affects specific names, not the whole machine
        causes: [],
        // Reported, never repaired from here.
        //
        // Offering hosts.comment on the strength of "entries exist" means offering to undo the
        // user's own configuration: this machine's 90 entries are deliberate license blocks,
        // and the engine proposed commenting them out while nothing whatsoever was wrong. A
        // repair needs proof that a specific entry is redirecting a name the user is actually
        // failing to reach, which needs the resolution wave — so the repair belongs to the
        // narrower hypothesis that wave will bring, not to this one.
        repairs: [],

        explain: facts => ({
            what: 'در فایل hosts ویندوز چند خط وجود دارد که بعضی آدرس‌ها را به جای دیگری هدایت می‌کند.',
            why: 'این فقط روی همان آدرس‌ها اثر دارد، نه روی کل اینترنت. ممکن است خودتان عمداً اضافه کرده باشید.',
            measured: facts[IDS.DNS_HOSTS_ENTRIES] && facts[IDS.DNS_HOSTS_ENTRIES].value,
        }),
    },
];
