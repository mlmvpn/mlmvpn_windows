/*
 * W2 — transport reachability, by scope, IP literals only.
 *
 * No hostname appears anywhere in this wave. The entire point is to measure whether packets
 * leave and come back WITHOUT DNS in the path, so that a resolution failure in W3 can be
 * attributed rather than blamed for everything downstream.
 *
 * The scope split is the reason this wave exists in this shape. Three foreign anchors going
 * dark at once is an ordinary Tuesday on an Iranian line, and aggregating them into "no
 * connectivity" is what makes a diagnostic tool tell a user with a perfectly healthy machine
 * that their network card, their routing table, or the Base Filtering Engine is broken — and
 * then offer to repair all three.
 *
 * So: gateway proves the link, domestic anchors prove the local stack and the ISP, foreign
 * anchors prove only international reachability. Only the first two may support a claim about
 * this machine.
 */

'use strict';

const F = require('../facts');
const P = require('../probe');
const E = require('../endpoints');
const { IDS } = require('../rules/ids');

const SCOPE_FACTS = {
    domestic: { v4: IDS.REACH_DOMESTIC_V4, v6: IDS.REACH_DOMESTIC_V6 },
    foreign: { v4: IDS.REACH_FOREIGN_V4, v6: IDS.REACH_FOREIGN_V6 },
};

/**
 * Probe one scope+family and write the aggregate.
 *
 * Writes an OBSERVED fact only for a definite 'ok' or 'fail'. Everything else — too few
 * independent groups, a correlated failure, endpoints that could not be attempted — is an
 * UNKNOWN fact carrying the reason. A gate then abstains instead of resolving, which is the
 * difference between «علت قطعی پیدا نشد» and a fabricated one.
 */
async function probeScope(ctx, scope, family) {
    const factId = SCOPE_FACTS[scope][family];
    const eps = E.staticEndpoints().filter(e => e.scope === scope && e.family === family);

    if (!eps.length) {
        // The domestic table ships empty until the release checklist fills it in, and the
        // engine has to behave correctly in the meantime rather than pretend.
        ctx.put(F.unknown(factId, scope === 'domestic'
            ? 'هنوز هیچ مقصد داخلی برای این آزمون تعریف نشده است'
            : `no ${scope}/${family} endpoints are defined`, { family, scope: 'endpoint' }));
        return;
    }

    const results = await P.pool(eps, ctx.capNetwork, async (ep) => {
        if (ctx.cancelled) return { endpoint: ep, ok: null, reason: 'cancelled' };
        if (ctx.budgetFor(1) === 0) return { endpoint: ep, ok: null, reason: 'deadline' };
        const r = await P.tcpProbe(ep.ip, ep.port, 2500, family === 'v6' ? 6 : 4);
        // EAFNOSUPPORT / ENETUNREACH means the stack has no v6 at all — that is "not
        // attempted", not "the endpoint is down", and counting it as failure would invent an
        // IPv6 outage on a v4-only machine.
        const unreachableStack = r.reason === 'EAFNOSUPPORT' || r.reason === 'ENETUNREACH';
        return { endpoint: ep, ok: unreachableStack ? null : r.ok, reason: r.reason || null, ms: r.ms };
    });

    const agg = E.aggregateScope(scope, results, { minGroups: E.MIN_GROUPS[scope] });
    const detail = results
        .map(r => `${r.endpoint.id}=${r.ok === null ? 'n/a' : (r.ok ? 'ok' : (r.reason || 'fail'))}`)
        .join(' ');

    if (agg.status === 'ok' || agg.status === 'fail') {
        ctx.put(F.observed(factId, agg.status, {
            quality: F.QUALITY.MEASURED, family, scope: 'endpoint',
            note: agg.correlated ? `شکست فقط در یک شبکه (${agg.correlated})` : agg.why,
            raw: detail,
        }));
    } else {
        ctx.put(F.unknown(factId, agg.why || 'scope could not be established', {
            family, scope: 'endpoint', raw: detail,
        }));
    }

    if (scope === 'foreign' && family === 'v4') {
        ctx.put(F.observed(IDS.REACH_FOREIGN_CORRELATED, !!agg.correlated, {
            quality: F.QUALITY.INFERRED,
            note: agg.correlated ? `همهٔ شکست‌ها در شبکهٔ ${agg.correlated} بود` : null,
        }));
        // A shipped anchor set contradicted by better evidence is a maintenance signal, not a
        // user-facing fault: domestic silent while foreign answers means the table is stale.
        const dom = ctx.session.facts[IDS.REACH_DOMESTIC_V4];
        const domesticSilent = dom && dom.status !== 'observed' && E.DOMESTIC_ANCHORS.length > 0;
        ctx.put(F.observed(IDS.ANCHOR_SET_STALE, !!(domesticSilent && agg.status === 'ok'), {
            quality: F.QUALITY.INFERRED,
        }));
    }
}

module.exports = [
    {
        id: 'w2.foreign',
        wave: 'w2',
        label: 'بررسی دسترسی به مقصدهای بین‌المللی',
        network: true,
        timeout: 12000,
        produces: [IDS.REACH_FOREIGN_V4, IDS.REACH_FOREIGN_CORRELATED, IDS.ANCHOR_SET_STALE],
        async run(ctx) { await probeScope(ctx, 'foreign', 'v4'); },
    },
    {
        id: 'w2.domestic',
        wave: 'w2',
        label: 'بررسی دسترسی به مقصدهای داخلی',
        network: true,
        timeout: 10000,
        produces: [IDS.REACH_DOMESTIC_V4],
        async run(ctx) { await probeScope(ctx, 'domestic', 'v4'); },
    },
    {
        id: 'w2.foreign-v6',
        wave: 'w2',
        label: 'بررسی دسترسی IPv6',
        network: true,
        timeout: 8000,
        produces: [IDS.REACH_FOREIGN_V6],
        when(facts) {
            if (!F.isObserved(facts, IDS.ROUTE_DEFAULT_COUNT_V6)) return { skip: 'وضعیت مسیر IPv6 خوانده نشد' };
            if (F.valueOf(facts, IDS.ROUTE_DEFAULT_COUNT_V6) === 0) return { skip: 'این دستگاه مسیر پیش‌فرض IPv6 ندارد' };
            return true;
        },
        whenText: 'an IPv6 default route exists',
        async run(ctx) { await probeScope(ctx, 'foreign', 'v6'); },
    },
];
