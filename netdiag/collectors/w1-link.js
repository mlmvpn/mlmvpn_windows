/*
 * W1 — the first hop.
 *
 * The gateway is the one endpoint whose reachability says something about THIS machine rather
 * than about the internet. Everything in the scope matrix that blames the local stack hangs
 * off it: without gateway evidence, a foreign outage and a dead network card look the same.
 *
 * Two probes, because either alone is wrong:
 *
 *   ICMP is what everyone reaches for and it is routinely dropped by consumer routers, so a
 *   silent ping is not a dead gateway.
 *
 *   TCP to a router's own service ports is the corroborating measurement. Many gateways
 *   answer on 80 or 443 with their admin page; a refused connection is still a completed
 *   round trip and proves the host is there — ECONNREFUSED is reachability, not failure, and
 *   treating it as failure would condemn a perfectly healthy link.
 */

'use strict';

const F = require('../facts');
const ps = require('../ps');
const P = require('../probe');
const E = require('../endpoints');
const { IDS } = require('../rules/ids');

/** Ports a home gateway plausibly answers on. Refusal counts as reachable; silence does not. */
const GW_PORTS = [80, 443, 53];

function gatewayOf(session, family) {
    const topo = session.topology;
    if (!topo) return null;
    const routes = (topo.defaultRoutes && topo.defaultRoutes[family]) || [];
    const egress = topo.egress && topo.egress[family] && topo.egress[family].guid;
    const onEgress = routes.find(r => r.interfaceGuid === egress && r.nextHop && !/^(0\.0\.0\.0|::)$/.test(r.nextHop));
    if (onEgress) return onEgress.nextHop;
    const any = routes.find(r => r.nextHop && !/^(0\.0\.0\.0|::)$/.test(r.nextHop));
    return any ? any.nextHop : null;
}

module.exports = [
    {
        id: 'w1.gateway',
        wave: 'w1',
        label: 'بررسی ارتباط با مودم/روتر',
        network: true,
        timeout: 9000,
        produces: [IDS.REACH_GATEWAY_V4, IDS.NEIGH_GATEWAY_STATE, IDS.LINK_FLAPPING],

        // Nothing to reach if there is no next hop. Recorded as a skip with the reason so the
        // report can distinguish "the gateway did not answer" from "there is no gateway".
        when(facts) {
            if (!F.isObserved(facts, IDS.ROUTE_TABLE_READABLE)) {
                return { skip: 'مسیرها خوانده نشد، پس نشانی مودم/روتر معلوم نیست' };
            }
            return true;
        },
        whenText: 'route table readable',

        async run(ctx) {
            const gw = gatewayOf(ctx.session, 'v4');
            if (!gw) {
                ctx.put(F.unknown(IDS.REACH_GATEWAY_V4, 'no IPv4 next hop on any default route'));
                ctx.put(F.unknown(IDS.NEIGH_GATEWAY_STATE, 'no gateway address to look up'));
                ctx.put(F.observed(IDS.LINK_FLAPPING, false, { quality: F.QUALITY.INFERRED, note: 'not probed' }));
                return;
            }
            ctx.session.app.gatewayV4 = gw;

            // Repeated, because a single miss on a busy Wi-Fi link is not a dead gateway, and
            // disagreement between attempts is itself the `link.unstable` diagnosis.
            const res = await P.repeated(async () => {
                for (const port of GW_PORTS) {
                    const r = await P.tcpProbe(gw, port, 1200, 4);
                    // A refusal is a completed round trip: something is there and answering.
                    if (r.ok || r.reason === 'ECONNREFUSED' || r.reason === 'ECONNRESET') {
                        return { ok: true, ms: r.ms, reason: r.reason || null };
                    }
                }
                return { ok: false, ms: 0, reason: 'no response on any probed port' };
            }, 3, 400, ctx);

            ctx.put(F.observed(IDS.REACH_GATEWAY_V4, res.ok ? 'ok' : 'fail', {
                quality: F.QUALITY.MEASURED, family: 'v4', scope: 'endpoint',
                ms: res.ms, note: `${gw} — ${res.attempts} attempt(s)`,
            }));
            ctx.put(F.observed(IDS.LINK_FLAPPING, !!res.flapping, {
                quality: F.QUALITY.MEASURED,
                note: res.flapping ? 'نتیجهٔ تلاش‌های پیاپی با هم فرق داشت' : null,
            }));

            // The neighbour table separates a dead layer-2 link from a routing problem, and it
            // is a different kind of evidence from a socket: Windows' own view of whether the
            // gateway's hardware address is known and fresh.
            const nb = await ps.run(
                `@(Get-NetNeighbor -IPAddress '${gw.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object State) | ConvertTo-Json -Depth 3 -Compress`,
                { timeout: ctx.budgetFor(4000) },
            );
            const nj = nb.ok ? ps.parseJson(nb.stdout) : { ok: false, reason: nb.reason };
            const state = nj.ok && nj.value.length ? ps.neighborState(nj.value[0].State) : null;
            if (state) ctx.put(F.observed(IDS.NEIGH_GATEWAY_STATE, state, { quality: F.QUALITY.REPORTED }));
            else ctx.put(F.unknown(IDS.NEIGH_GATEWAY_STATE, `Get-NetNeighbor gave no usable state${nj.reason ? `: ${nj.reason}` : ''}`));
        },
    },

    {
        id: 'w1.gateway-v6',
        wave: 'w1',
        label: 'بررسی ارتباط IPv6 با مودم/روتر',
        network: true,
        timeout: 6000,
        produces: [IDS.REACH_GATEWAY_V6],

        // Family-aware by construction. A machine with no IPv6 default route is not a machine
        // with broken IPv6, and conflating the two is how an IPv4-only probe set reports "no
        // internet" on a dual-stack machine whose browser works fine.
        when(facts) {
            if (!F.isObserved(facts, IDS.ROUTE_DEFAULT_COUNT_V6)) return { skip: 'وضعیت مسیر IPv6 خوانده نشد' };
            if (F.valueOf(facts, IDS.ROUTE_DEFAULT_COUNT_V6) === 0) return { skip: 'این دستگاه اصلاً مسیر پیش‌فرض IPv6 ندارد' };
            return true;
        },
        whenText: 'an IPv6 default route exists',

        async run(ctx) {
            const gw = gatewayOf(ctx.session, 'v6');
            if (!gw) return ctx.put(F.unknown(IDS.REACH_GATEWAY_V6, 'no IPv6 next hop on any default route'));
            let ok = false;
            for (const port of GW_PORTS) {
                const r = await P.tcpProbe(gw, port, 1200, 6);
                if (r.ok || r.reason === 'ECONNREFUSED' || r.reason === 'ECONNRESET') { ok = true; break; }
            }
            ctx.put(F.observed(IDS.REACH_GATEWAY_V6, ok ? 'ok' : 'fail', {
                quality: F.QUALITY.MEASURED, family: 'v6', scope: 'endpoint', note: gw,
            }));
        },
    },
];
