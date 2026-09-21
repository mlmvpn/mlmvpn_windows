/*
 * W5 — the MTU ladder.
 *
 * The ladder is ICMP-based, and ICMP is widely dropped. That single fact governs the whole
 * design here: on a path that silently discards echo requests, EVERY rung fails, and a naive
 * reading turns "we learned nothing" into "MTU black hole" — complete with an offer to change
 * the machine's MTU. So an all-failed ladder is UNKNOWN, never a finding.
 *
 * The evidence bar before an MTU conclusion is even a candidate:
 *
 *   1. a small payload succeeds        proves ICMP is not being dropped outright
 *   2. a large payload fails           the asymmetry that MTU means
 *   3. TCP to the same target works    proves the path exists, so the failure is about size
 *   4. it reproduces on a second target so one unhappy destination cannot decide it
 *   5. no tunnel is up                 a live TUN owns its own MTU; measuring the physical
 *                                      path while traffic goes through a tunnel measures the
 *                                      wrong thing, and repairing it would fight the engine
 *
 * Parsing is by EXIT CODE and packet counts, never by matching "Packet needs to be
 * fragmented" — that sentence is localised, and a German or Persian Windows would make every
 * rung look like a failure.
 */

'use strict';

const { execFile } = require('child_process');
const F = require('../facts');
const P = require('../probe');
const { IDS } = require('../rules/ids');

/** Payload sizes, descending. 1472 = 1500 − 28 bytes of IP+ICMP header. */
const LADDER = [1472, 1400, 1300, 1200, 1000, 576];
const SMALL = 64;

const TARGETS = [
    { ip: '1.1.1.1', group: 'cloudflare' },
    { ip: '8.8.8.8', group: 'google' },
];

/**
 * One ping with Don't-Fragment set.
 *
 * Resolves to `{ ok, code }`. `ok` comes from the process exit code alone: ping exits 0 only
 * when a reply actually came back, in every locale. Output text is captured for the report
 * but never parsed for a verdict.
 */
function pingDf(ip, size, timeoutMs) {
    return new Promise(resolve => {
        execFile('ping', ['-n', '1', '-f', '-l', String(size), '-w', '1200', ip],
            { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 256 * 1024 },
            (err, stdout) => resolve({ ok: !err, code: err ? (err.code === undefined ? -1 : err.code) : 0, out: (stdout || '').slice(0, 200) }));
    });
}

module.exports = [{
    id: 'w5.mtu',
    wave: 'w5',
    label: 'بررسی اندازهٔ بستهٔ شبکه (MTU)',
    network: true,
    timeout: 20000,
    produces: [IDS.MTU_LADDER_SMALL_OK, IDS.MTU_LADDER_LARGEST_OK, IDS.MTU_TCP_CORROBORATED, IDS.MTU_TARGETS_REPRODUCED],

    when(facts) {
        if (!F.isObserved(facts, IDS.ROUTE_TABLE_READABLE)) return { skip: 'جدول مسیرها خوانده نشد' };
        if (F.valueOf(facts, IDS.ROUTE_DEFAULT_COUNT_V4) === 0) {
            return { skip: 'مسیر پیش‌فرضی وجود ندارد، پس آزمون اندازهٔ بسته بی‌معنی است' };
        }
        // A live tunnel owns its own MTU. Measuring the physical path underneath it answers a
        // question nobody asked, and any repair derived from it would fight the engine.
        if (F.valueOf(facts, IDS.ROUTE_EGRESS_IS_TUN) === true) {
            return { skip: 'ترافیک از تونل عبور می‌کند و اندازهٔ بستهٔ تونل را خودِ موتور تعیین می‌کند' };
        }
        return true;
    },
    whenText: 'a default route exists and the egress is not a tunnel',

    async run(ctx) {
        const perTarget = [];
        for (const t of TARGETS) {
            if (ctx.cancelled || ctx.budgetFor(1) === 0) break;

            // Rung 1: does ICMP work here at all? Everything below is meaningless without it.
            const small = await pingDf(t.ip, SMALL, 3000);
            if (!small.ok) {
                perTarget.push({ target: t, icmp: false });
                continue;
            }
            let largestOk = null;
            for (const size of LADDER) {
                if (ctx.cancelled) break;
                const r = await pingDf(t.ip, size, 3000);
                if (r.ok) { largestOk = size; break; }
            }
            const tcp = await P.tcpProbe(t.ip, 443, 2500, 4);
            perTarget.push({ target: t, icmp: true, largestOk, tcpOk: tcp.ok });
        }

        if (!perTarget.length) {
            for (const id of [IDS.MTU_LADDER_SMALL_OK, IDS.MTU_LADDER_LARGEST_OK, IDS.MTU_TCP_CORROBORATED, IDS.MTU_TARGETS_REPRODUCED]) {
                ctx.put(F.unknown(id, 'the ladder could not be attempted'));
            }
            return;
        }

        const icmpWorks = perTarget.filter(x => x.icmp);
        ctx.put(F.observed(IDS.MTU_LADDER_SMALL_OK, icmpWorks.length > 0, {
            quality: F.QUALITY.MEASURED,
            note: icmpWorks.length ? null : 'ICMP روی این مسیر پاسخ نمی‌دهد، پس این آزمون چیزی ثابت نمی‌کند',
            raw: perTarget.map(x => `${x.target.ip}:icmp=${x.icmp}`).join(' '),
        }));

        if (!icmpWorks.length) {
            // The whole point. Silence from a path that drops ICMP is not an MTU problem, and
            // saying so plainly is what stops a repair being offered for it.
            for (const id of [IDS.MTU_LADDER_LARGEST_OK, IDS.MTU_TCP_CORROBORATED, IDS.MTU_TARGETS_REPRODUCED]) {
                ctx.put(F.unknown(id, 'ICMP is filtered on this path, so packet-size behaviour is unobservable'));
            }
            return;
        }

        const largest = icmpWorks.map(x => x.largestOk).filter(v => v !== null);
        ctx.put(F.observed(IDS.MTU_LADDER_LARGEST_OK, largest.length ? Math.max(...largest) : 0, {
            quality: F.QUALITY.MEASURED,
            note: largest.length ? `بزرگ‌ترین بستهٔ عبورکرده: ${Math.max(...largest)} بایت` : 'هیچ اندازه‌ای رد نشد',
            raw: icmpWorks.map(x => `${x.target.ip}:largest=${x.largestOk}`).join(' '),
        }));

        // Condition 3: the path exists, so a size failure is about size and not about reach.
        ctx.put(F.observed(IDS.MTU_TCP_CORROBORATED, icmpWorks.some(x => x.tcpOk), {
            quality: F.QUALITY.MEASURED,
            raw: icmpWorks.map(x => `${x.target.ip}:tcp=${x.tcpOk}`).join(' '),
        }));

        // Condition 4: reproduced on independent targets, so one unhappy destination cannot
        // decide a machine-wide setting.
        const reduced = icmpWorks.filter(x => x.largestOk !== null && x.largestOk < LADDER[0]);
        ctx.put(F.observed(IDS.MTU_TARGETS_REPRODUCED, new Set(reduced.map(x => x.target.group)).size, {
            quality: F.QUALITY.MEASURED,
            note: 'تعداد شبکه‌های مستقلی که همین محدودیت اندازه را نشان دادند',
        }));
    },
}];
