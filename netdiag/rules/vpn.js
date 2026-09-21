/*
 * VPN and ownership hypotheses.
 *
 * The most valuable discrimination in the whole product lives here: «the VPN is deliberately
 * blocking traffic» versus «the VPN's protection was left behind by a run that died». They
 * are identical in the firewall, DNS and route facts. They differ only in liveness — which is
 * why ownership carries a liveness proof and why process identity is a triple rather than a
 * pid.
 *
 * There is also a third outcome that neither v1 nor v2 had: when the guard's record and the
 * machine disagree, NEITHER conclusion is safe. Saying so is the honest result, and it comes
 * with an offer to run the guard's own restore rather than a generic repair.
 */

'use strict';

const { IDS, SYMPTOM } = require('./ids');
const { OWNERSHIP } = require('../ownership');

const eq = v => x => x === v;
const isTrue = x => x === true;
const isFalse = x => x === false;

module.exports = [
    {
        id: 'vpn.stale-protection',
        title: 'محافظت VPN از یک اجرای ناتمام باقی مانده است',
        category: 'vpn',
        layer: 1,

        // Deliberately NOT gated by-design on OURS_LIVE: a live guard is a different
        // hypothesis entirely (it is not a fault at all), and this one only fires on orphaned.
        //
        // The ownership state is a NECESSARY gate rather than mere supporting evidence, and
        // that is the whole safety of this rule. As supporting evidence it could be outvoted:
        // with ownership merely UNKNOWN, "the engine is not running" alone was enough to reach
        // `likely`, make this a root cause, and offer to unwind a kill switch we had failed to
        // recognise as ours. As a necessary gate, unknown yields `indeterminate` and the user
        // is told what could not be established instead.
        necessary: [
            { factId: IDS.FW_OUTBOUND_BLOCK, predicate: isTrue, because: 'outbound traffic is not blocked' },
            {
                factId: IDS.APP_GUARD_STATE, predicate: eq(OWNERSHIP.OURS_ORPHANED),
                because: 'the kill switch is not attributable to an abandoned run of this app',
            },
        ],
        decisive: [
            { factId: IDS.FW_OUTBOUND_BLOCK, predicate: isTrue },
            { factId: IDS.APP_GUARD_STATE, predicate: eq(OWNERSHIP.OURS_ORPHANED) },
        ],
        decisiveBecause: 'the kill switch is engaged and the engine that engaged it is gone',

        supporting: [{ factId: IDS.APP_ENGINE_RUNNING, predicate: isFalse, weight: 1 }],

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['dns.resolver-unreachable', 'http.all-fail', 'link.no-transport'],
        // The owning module's own tested recovery path. Never a blanket firewall Allow: that
        // would disable the fail-closed leak protection and expose the user's real IP.
        repairs: ['guard.restore-stale'],

        explain: () => ({
            what: 'محافظِ نشتِ VPN هنوز روشن است، ولی موتوری که آن را روشن کرده بود دیگر اجرا نیست.',
            why: 'این محافظ عمداً جلوی خروج ترافیک بدون تونل را می‌گیرد؛ حالا که تونل نیست، همه‌چیز بسته مانده. برداشتنش باید با همان مسیر بازیابیِ خودش انجام شود، نه با باز کردن کامل فایروال.',
        }),
    },

    {
        id: 'vpn.protection-active',
        title: 'محافظت VPN عمداً روشن است',
        category: 'vpn',
        layer: 1,

        // Exists so the by-design case is SAID rather than silently absent. A user staring at
        // a dead connection deserves to be told the app is doing it on purpose.
        byDesignWhen: { factId: IDS.APP_GUARD_STATE, predicate: eq(OWNERSHIP.OURS_LIVE) },
        necessary: [{ factId: IDS.FW_OUTBOUND_BLOCK, predicate: isTrue }],
        explains: [],
        causes: [],
        repairs: [],

        explain: () => ({
            what: 'محافظِ نشتِ این برنامه روشن است و عمداً جلوی ترافیک بیرون از تونل را می‌گیرد.',
            why: 'این خرابی نیست. اگر می‌خواهید بدون تونل به اینترنت وصل شوید، باید تونل را از خود برنامه خاموش کنید.',
        }),
    },

    {
        id: 'vpn.tunnel-no-data',
        title: 'تونل وصل است ولی دیتا از آن رد نمی‌شود',
        category: 'vpn',
        layer: 2,

        necessary: [
            { factId: IDS.APP_TUN_VERDICT, predicate: eq('healthy'), because: 'the tunnel is not reporting healthy' },
        ],
        decisive: [
            { factId: IDS.APP_TUN_VERDICT, predicate: eq('healthy') },
            // Only ever set false after three attempts against two destinations: the data-path
            // probe hard-codes 1.1.1.1:80 and a filtering event there would otherwise fake a
            // dead tunnel. tun-manager's own startTun already retries for this reason.
            { factId: IDS.APP_TUN_CARRIES_DATA, predicate: isFalse },
        ],
        decisiveBecause: 'Windows and the engine both report the tunnel healthy, yet no bytes make the round trip',

        // The textbook conflict: what is reported disagrees with what is measured.
        // `capping: false` because this contradiction is not a reason to doubt the verdict —
        // it IS the verdict. Reported-healthy-but-measured-dead is the entire finding, and
        // holding it down to "possible" for containing a contradiction would mean the engine
        // could never state its own flagship diagnosis with confidence.
        conflictWhen: [{
            a: { factId: IDS.APP_TUN_VERDICT, predicate: eq('healthy') },
            b: { factId: IDS.APP_TUN_CARRIES_DATA, predicate: isFalse },
            note: 'ویندوز تونل را سالم گزارش می‌کند ولی هیچ بسته‌ای رد و بدل نمی‌شود',
            capping: false,
        }],

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['http.all-fail', 'dns.resolver-unreachable'],
        repairs: [],

        explain: () => ({
            what: 'تونل به‌ظاهر سالم است — کارت شبکه بالاست و مسیر از آن می‌گذرد — ولی وقتی واقعاً بسته می‌فرستیم، چیزی برنمی‌گردد.',
            why: 'همهٔ ترافیک وارد تونلی می‌شود که به جایی نمی‌رسد، پس هیچ صفحه‌ای باز نمی‌شود در حالی که همه‌چیز «متصل» نشان داده می‌شود.',
        }),
    },

    {
        id: 'route.stale-tun',
        title: 'یک مسیر پیش‌فرض از تونلِ خاموش باقی مانده',
        category: 'route',
        layer: 2,

        necessary: [
            { factId: IDS.ROUTE_TABLE_READABLE, predicate: isTrue, because: 'the routing table could not be read' },
            { factId: IDS.ROUTE_EGRESS_IS_TUN, predicate: isTrue, because: 'traffic is not leaving via a tunnel adapter' },
        ],
        decisive: [
            { factId: IDS.ROUTE_EGRESS_IS_TUN, predicate: isTrue },
            { factId: IDS.APP_ENGINE_RUNNING, predicate: isFalse },
            // checkLive()'s route-stolen is the else-branch of three other checks, so it is
            // inferred rather than measured and never decides this alone.
            { factId: IDS.APP_TUN_CARRIES_DATA, predicate: isFalse },
        ],
        decisiveBecause: 'traffic is routed into a tunnel adapter whose engine is not running and which carries no data',

        explains: [SYMPTOM.NOTHING_OPENS],
        causes: ['dns.resolver-unreachable', 'http.all-fail', 'link.no-transport'],
        repairs: ['route.remove-stale-tun'],

        explain: () => ({
            what: 'مسیر پیش‌فرض ویندوز هنوز به کارت شبکهٔ تونل اشاره می‌کند، ولی موتور آن تونل اجرا نیست.',
            why: 'هر بسته‌ای که می‌فرستید وارد تونلی می‌شود که وجود ندارد و همان‌جا گم می‌شود.',
        }),
    },
];
