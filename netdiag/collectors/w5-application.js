/*
 * W5 — the application layer, where the discrimination actually happens.
 *
 * Two ideas carry this wave, and both were failures in earlier designs:
 *
 *   Every HTTP check runs TWICE — through the configured proxy and bypassing it — and the
 *   DIFFERENCE is the diagnosis. The first design ran every probe with `proxy: false`, so a
 *   dead system proxy left behind by a crashed engine (the single most common reason nothing
 *   opens on this product) produced a completely green run: Node ignored the proxy that the
 *   browser obeys.
 *
 *   Captive detection asserts CONTENT, never a status code. A portal answers every request
 *   with 200 and a login page, so "we got a response" is exactly the wrong test. `generate_204`
 *   must be a 204 with an empty body and `connecttest.txt` must be its exact text; anything
 *   else — HTML, a redirect, a content-type mismatch — is interception.
 *
 * And the rule that keeps the bypass probe honest (§15.4): when a proxy IS configured, a
 * successful bypass may only ever be described as «مسیر مستقیم سالم است». Calling it
 * «اینترنت سالم است» would declare a machine healthy while the user's actual browser path is
 * dead — the exact inverse of the bug above, and just as damaging.
 */

'use strict';

const F = require('../facts');
const P = require('../probe');
const { httpDiag } = require('../http');
const O = require('../ownership');
const { IDS } = require('../rules/ids');

/**
 * Connectivity endpoints, with the content each MUST return.
 *
 * Two operators, so one portal-free network answering oddly cannot decide the verdict alone.
 * These are the same endpoints Windows and Firefox use for their own connectivity checks,
 * which is what makes their expected content well defined.
 */
const CAPTIVE_TARGETS = [
    {
        id: 'msft', url: 'http://www.msftconnecttest.com/connecttest.txt', group: 'microsoft',
        expect: r => r.status === 200 && r.bodyPrefix.trim() === 'Microsoft Connect Test',
    },
    {
        id: 'firefox', url: 'http://detectportal.firefox.com/success.txt', group: 'mozilla',
        expect: r => r.status === 200 && r.bodyPrefix.trim() === 'success',
    },
];

function proxyEndpointOf(session) {
    const f = session.facts[IDS.PROXY_WININET_SERVER];
    const enabled = session.facts[IDS.PROXY_WININET_ENABLED];
    if (!enabled || enabled.status !== 'observed' || enabled.value !== true) return null;
    if (!f || f.status !== 'observed') return null;
    const parsed = O.parseProxyServer(f.value);
    if (!parsed.ok || !parsed.endpoints.length) return null;
    // Prefer the http endpoint: it is the one a plain-HTTP connectivity check would traverse.
    const http = parsed.endpoints.find(e => e.scheme === 'http') || parsed.endpoints[0];
    return { host: http.host === 'localhost' ? '127.0.0.1' : http.host, port: http.port };
}

module.exports = [
    {
        id: 'w5.proxy-endpoint',
        wave: 'w5',
        label: 'بررسی خودِ پراکسی سیستم',
        network: true,
        timeout: 8000,
        produces: [IDS.PROXY_ENDPOINT_TCP_OK, IDS.PROXY_ENDPOINT_OWNERSHIP, IDS.PROXY_PAC_FETCHABLE],

        when(facts) {
            if (!F.isObserved(facts, IDS.PROXY_WININET_ENABLED)) return { skip: 'تنظیمات پراکسی خوانده نشد' };
            return true;
        },
        whenText: 'proxy configuration was read',

        async run(ctx) {
            const ep = proxyEndpointOf(ctx.session);
            if (!ep) {
                // No proxy configured is an OBSERVATION, not a gap: it is what eliminates the
                // dead-proxy hypothesis instead of leaving it indeterminate on every machine.
                ctx.put(F.observed(IDS.PROXY_ENDPOINT_TCP_OK, true, {
                    quality: F.QUALITY.INFERRED, note: 'هیچ پراکسی‌ای تنظیم نشده است',
                }));
                ctx.put(F.observed(IDS.PROXY_ENDPOINT_OWNERSHIP, O.OWNERSHIP.FOREIGN, {
                    quality: F.QUALITY.INFERRED, note: 'no proxy configured, so there is nothing to own',
                }));
            } else {
                const live = await P.tcpProbe(ep.host, ep.port, 2000, 4);
                ctx.put(F.observed(IDS.PROXY_ENDPOINT_TCP_OK, live.ok, {
                    quality: F.QUALITY.MEASURED, note: `${ep.host}:${ep.port}`,
                }));

                // Ownership by LISTENER IDENTITY, not by string equality. The repository's own
                // systemProxyIsOurs() compares the configured string to one engine's port, so a
                // per-protocol value or a proxy set by a different engine reads as "not ours" —
                // and acting on that would disable a live tunnel's proxy and send an Iranian
                // user's traffic out in the clear while reporting success.
                //
                // The listening PID and its image path are what settle it. Reading them needs
                // the real process table, which the ownership collector owns; until an engine
                // adapter is wired in (phase 6), an unproven owner must be UNKNOWN — never
                // FOREIGN, because FOREIGN is what authorises a repair.
                const listener = ctx.deps.listenerFor ? await ctx.deps.listenerFor(ep.host, ep.port) : undefined;
                const decision = O.classifyProxyOwnership({
                    endpoints: [{ host: ep.host, port: ep.port, loopback: O.isLoopbackHost(ep.host) }],
                    listener,
                    claims: ctx.deps.proxyClaims ? ctx.deps.proxyClaims(ep.host, ep.port) : [],
                    installDir: ctx.deps.installDir,
                });
                ctx.put(F.observed(IDS.PROXY_ENDPOINT_OWNERSHIP, decision.state, {
                    quality: F.QUALITY.INFERRED, note: decision.reason,
                }));
            }

            // A PAC URL is honoured independently of ProxyEnable, which is why a machine broken
            // by a dead PAC is NOT repaired by clearing the enable flag — and why its
            // fetchability is measured separately.
            const pac = ctx.session.facts[IDS.PROXY_PAC_URL];
            const pacUrl = pac && pac.status === 'observed' ? pac.value : null;
            if (!pacUrl) {
                ctx.put(F.observed(IDS.PROXY_PAC_FETCHABLE, true, {
                    quality: F.QUALITY.INFERRED, note: 'هیچ آدرس PAC تنظیم نشده است',
                }));
            } else if (!/^https?:\/\//i.test(pacUrl)) {
                ctx.put(F.unknown(IDS.PROXY_PAC_FETCHABLE, `PAC URL is not http(s), so it was not fetched: ${pacUrl}`));
            } else {
                const r = await httpDiag(pacUrl, { timeoutMs: 4000 });
                ctx.put(F.observed(IDS.PROXY_PAC_FETCHABLE, r.transport === 'ok' && r.status === 200, {
                    quality: F.QUALITY.MEASURED, note: `${r.transport}${r.status ? ' ' + r.status : ''}`,
                }));
            }
        },
    },

    {
        id: 'w5.http-dual',
        wave: 'w5',
        label: 'بررسی باز شدن صفحه‌ها (با پراکسی و بدون پراکسی)',
        network: true,
        timeout: 16000,
        produces: [IDS.PROXY_HTTP_BYPASS_OK, IDS.PROXY_HTTP_VIA_OK, IDS.CAPTIVE_DETECTED, IDS.CAPTIVE_LOCATION],

        when(facts) {
            if (!F.isObserved(facts, IDS.PROXY_WININET_ENABLED)) return { skip: 'تنظیمات پراکسی خوانده نشد' };
            return true;
        },
        whenText: 'proxy configuration was read',

        async run(ctx) {
            const ep = proxyEndpointOf(ctx.session);

            // ── the bypass path ──
            const direct = await P.pool(CAPTIVE_TARGETS, 2, async (t) => {
                if (ctx.cancelled) return null;
                const r = await httpDiag(t.url, { timeoutMs: 5000, family: 'v4' });
                return { t, r, exact: r.transport === 'ok' && t.expect(r) };
            });
            const gotDirect = direct.filter(Boolean);
            const anyDirectReached = gotDirect.some(x => x.r.transport === 'ok');
            const allDirectExact = gotDirect.length > 0 && gotDirect.every(x => x.exact);

            ctx.put(F.observed(IDS.PROXY_HTTP_BYPASS_OK, allDirectExact, {
                quality: F.QUALITY.MEASURED,
                note: ep
                    // §15.4, in the fact itself so the report cannot overstate it.
                    ? 'مسیر مستقیم (بدون پراکسی) — این به معنی سالم بودن مسیر مرورگر نیست'
                    : 'مسیر مستقیم',
                raw: gotDirect.map(x => `${x.t.id}:${x.r.transport}/${x.r.status}/${x.exact ? 'exact' : 'unexpected'}`).join(' '),
            }));

            // ── the proxy path ──
            if (!ep) {
                // With no proxy configured, the browser's path IS the direct path.
                ctx.put(F.observed(IDS.PROXY_HTTP_VIA_OK, allDirectExact, {
                    quality: F.QUALITY.INFERRED, note: 'پراکسی‌ای تنظیم نشده، پس مسیر مرورگر همان مسیر مستقیم است',
                }));
            } else {
                const viaResults = await P.pool(CAPTIVE_TARGETS, 2, async (t) => {
                    if (ctx.cancelled) return null;
                    const r = await httpDiag(t.url, { timeoutMs: 5000, proxy: ep });
                    return { t, r, exact: r.transport === 'ok' && t.expect(r) };
                });
                const via = viaResults.filter(Boolean);
                ctx.put(F.observed(IDS.PROXY_HTTP_VIA_OK, via.length > 0 && via.every(x => x.exact), {
                    quality: F.QUALITY.MEASURED,
                    note: `از طریق ${ep.host}:${ep.port}`,
                    raw: via.map(x => `${x.t.id}:${x.r.transport}/${x.r.status}`).join(' '),
                }));
            }

            // ── captive / interception, by content ──
            //
            // A target that was reached but answered with something other than its exact
            // expected content is interception. A target that could not be reached at all is
            // not evidence of a portal — it is evidence of no connectivity, which other waves
            // are responsible for.
            const reached = gotDirect.filter(x => x.r.transport === 'ok');
            if (!reached.length) {
                ctx.put(F.unknown(IDS.CAPTIVE_DETECTED,
                    'هیچ‌کدام از نقطه‌های بررسی اتصال پاسخ ندادند، پس نمی‌توان دربارهٔ صفحهٔ ورود قضاوت کرد'));
                ctx.put(F.unknown(IDS.CAPTIVE_LOCATION, 'no endpoint answered'));
                return;
            }
            const intercepted = reached.filter(x => !x.exact);
            // Both reached, one exact and one not: that one target is suspect, not the network.
            const decisive = intercepted.length === reached.length;
            ctx.put(F.observed(IDS.CAPTIVE_DETECTED, decisive, {
                quality: F.QUALITY.MEASURED,
                note: decisive
                    ? 'همهٔ نقطه‌های بررسی، محتوایی غیر از آنچه باید برگرداندند'
                    : (intercepted.length ? 'فقط یکی از مقصدها ناهماهنگ بود — خودِ آن مقصد مشکوک است، نه شبکه' : null),
                raw: reached.map(x => `${x.t.id}:${x.r.status}:${JSON.stringify(x.r.bodyPrefix.slice(0, 40))}`).join(' '),
            }));
            const loc = intercepted.map(x => x.r.headers.location || x.r.redirectHost).filter(Boolean)[0] || null;
            if (loc) ctx.put(F.observed(IDS.CAPTIVE_LOCATION, loc, { quality: F.QUALITY.MEASURED }));
            else ctx.put(F.observed(IDS.CAPTIVE_LOCATION, null, { quality: F.QUALITY.MEASURED, note: 'no redirect target was offered' }));
        },
    },
];
