/*
 * W4 — the TLS handshake.
 *
 * This wave produces evidence, not a verdict, and the distinction matters more here than
 * anywhere else in the engine. A failed handshake is the single most over-interpreted signal
 * in this problem space: it is what makes tools announce "DPI detected" when the real cause
 * was a wrong clock, a captured certificate from an antivirus, or a destination that happened
 * to be down.
 *
 * So this collector measures three things and names none of them a cause:
 *
 *   did TCP even connect        a handshake that never had a connection is not interference
 *   did the handshake complete  and if not, was it a reset, an alert, or a timeout
 *   what certificate came back  its issuer and its validity dates, captured whether or not it
 *                               validates, because an "expired" certificate is usually a
 *                               wrong clock and an unexpected issuer is usually local
 *                               interception
 *
 * The clock is collected here too, deliberately: `time.skew` must be available BEFORE any
 * interference hypothesis can be evaluated, because a machine three days out of date fails
 * every handshake while ICMP and TCP stay perfect — a flawless imitation of the symptom.
 */

'use strict';

const F = require('../facts');
const P = require('../probe');
const ps = require('../ps');
const { tlsDiag } = require('../http');
const { IDS } = require('../rules/ids');

/** Persian digits, so a count in a note reads the same as one in the report. */
function fa(n) { return Number(n).toLocaleString('fa-IR'); }

/**
 * Targets, in two CATEGORIES.
 *
 * The categories are the correction independent validation forced. The first version probed
 * only 1.1.1.1 and 8.8.8.8 — different operators, so the netGroup rule considered them
 * independent — and on the development line both handshakes were reset. The engine headlined
 * «احتمال اختلال در مسیر شبکه» as the root cause of "nothing opens" while example.com,
 * microsoft.com, github.com and aparat.com all completed TLS in the same minute and every
 * page in the browser loaded.
 *
 * The lesson is that operator independence is not category independence. Public resolver
 * endpoints are disproportionately disrupted, so two of them agreeing is evidence about that
 * class of destination — not about the user's path to the web. A claim about browsing has to
 * be reproduced on the kind of destination browsing actually uses.
 *
 * `resolver` targets stay because they need no DNS and therefore still work when resolution
 * is broken; `web` targets are the ones that make a browsing claim legitimate, and they are
 * skipped rather than guessed at when resolution is unavailable.
 */
const TLS_TARGETS = [
    { host: '1.1.1.1', sni: 'cloudflare-dns.com', group: 'cloudflare', category: 'resolver', needsDns: false },
    { host: '8.8.8.8', sni: 'dns.google', group: 'google', category: 'resolver', needsDns: false },
    { host: 'example.com', sni: 'example.com', group: 'icann', category: 'web', needsDns: true },
    { host: 'www.microsoft.com', sni: 'www.microsoft.com', group: 'microsoft', category: 'web', needsDns: true },
];

module.exports = [
    {
        id: 'w4.clock',
        wave: 'w4',
        label: 'بررسی ساعت سیستم',
        network: false,
        timeout: 8000,
        produces: [IDS.TIME_SKEW_SECONDS],

        async run(ctx) {
            // w32tm reports the offset against the configured time source. Its output is
            // localised prose, so the number is extracted by shape — a signed decimal followed
            // by 's' — rather than by any English word.
            const r = await ps.run('w32tm /stripchart /computer:time.windows.com /samples:1 /dataonly 2>&1 | Out-String',
                { timeout: ctx.budgetFor(6000) });
            const m = r.ok && /([+-]?\d+[.,]\d+)\s*s/.exec(r.stdout || '');
            if (m) {
                ctx.put(F.observed(IDS.TIME_SKEW_SECONDS, Math.round(parseFloat(m[1].replace(',', '.'))), {
                    quality: F.QUALITY.MEASURED, source: 'w32tm', raw: (r.stdout || '').slice(0, 300),
                }));
                return;
            }
            // No time source reachable — which is the norm when the internet is down, i.e.
            // exactly when this engine runs. Unknown, never 0: reporting "the clock is fine"
            // because we could not check it would let the interference hypothesis through on
            // a machine whose clock is the actual cause.
            ctx.put(F.unknown(IDS.TIME_SKEW_SECONDS,
                'ساعت با هیچ منبع زمانی مقایسه نشد (معمولاً چون اینترنت قطع است)'));
        },
    },

    {
        id: 'w4.tls',
        wave: 'w4',
        label: 'بررسی ارتباط امن (TLS)',
        network: true,
        timeout: 14000,
        produces: [IDS.TLS_TCP_OK, IDS.TLS_HANDSHAKE_OK, IDS.TLS_FAIL_HOSTS,
            IDS.TLS_FAIL_CATEGORIES, IDS.TLS_CERT_DATE_INVALID],

        // Pointless without a route, and the skip is recorded so the report can say the
        // handshake was never attempted rather than implying it failed.
        when(facts) {
            if (!F.isObserved(facts, IDS.ROUTE_TABLE_READABLE)) return { skip: 'جدول مسیرها خوانده نشد' };
            if (F.valueOf(facts, IDS.ROUTE_DEFAULT_COUNT_V4) === 0) return { skip: 'هیچ مسیر پیش‌فرضی وجود ندارد' };
            return true;
        },
        whenText: 'a default route exists',

        async run(ctx) {
            // A `web` target needs a name resolved first. If resolution is not working, those
            // targets are not attempted at all — probing them would measure DNS a second time
            // and file the result under TLS.
            const resolutionOk = F.valueOf(ctx.session.facts, IDS.DNS_RESOLVE_OS_OK_V4) === true
                || F.valueOf(ctx.session.facts, IDS.DNS_RESOLVE_OK_V4) === true;
            const usable = TLS_TARGETS.filter(t => !t.needsDns || resolutionOk);

            const results = await P.pool(usable, 2, async (t) => {
                if (ctx.cancelled) return null;
                let ip = t.host;
                if (t.needsDns) {
                    try {
                        const a = await P.withDeadline(
                            require('dns').promises.lookup(t.host, { family: 4 }), 2000,
                            () => { throw new Error('timeout'); },
                        );
                        ip = a.address;
                    } catch (e) { return null; }
                }
                const r = await tlsDiag(ip, t.sni, { timeoutMs: 4000, family: 'v4' });
                return Object.assign({ target: t, ip }, r);
            });
            const got = results.filter(Boolean);
            if (!got.length) {
                for (const id of [IDS.TLS_TCP_OK, IDS.TLS_HANDSHAKE_OK, IDS.TLS_FAIL_HOSTS,
                    IDS.TLS_FAIL_CATEGORIES, IDS.TLS_CERT_DATE_INVALID]) {
                    ctx.put(F.unknown(id, 'no TLS target could be attempted'));
                }
                return;
            }

            const tcpOk = got.some(r => r.tcpOk);
            // Counted only among hosts we actually REACHED. A host TCP never connected to says
            // nothing about the handshake, and counting it would manufacture the "reproduces on
            // two hosts" evidence that the interference label depends on.
            const reached = got.filter(r => r.tcpOk);
            const failedAfterConnect = reached.filter(r => !r.handshakeOk);

            ctx.put(F.observed(IDS.TLS_TCP_OK, tcpOk, {
                quality: F.QUALITY.MEASURED, family: 'v4',
                raw: got.map(r => `${r.target.host}:tcp=${r.tcpOk}`).join(' '),
            }));
            ctx.put(F.observed(IDS.TLS_HANDSHAKE_OK, reached.length > 0 && failedAfterConnect.length < reached.length, {
                quality: F.QUALITY.MEASURED, family: 'v4',
                raw: got.map(r => `${r.target.host}[${r.target.category}]:tls=${r.handshakeOk}${r.reason ? '(' + r.reason + ')' : ''}`).join(' '),
            }));
            ctx.put(F.observed(IDS.TLS_FAIL_HOSTS, failedAfterConnect.length, {
                quality: F.QUALITY.MEASURED,
                note: 'شمارش فقط روی مقصدهایی که TCP به آن‌ها وصل شد',
            }));

            // The gate that stops a class-specific disruption from becoming a claim about the
            // user's browsing. Counted only among categories we actually reached, so a category
            // that was never attempted cannot silently look like a category that succeeded.
            const reachedCategories = new Set(reached.map(r => r.target.category));
            const failedCategories = new Set(failedAfterConnect.map(r => r.target.category));
            ctx.put(F.observed(IDS.TLS_FAIL_CATEGORIES, failedCategories.size, {
                quality: F.QUALITY.MEASURED,
                note: reachedCategories.size < 2
                    ? 'فقط یک دستهٔ مقصد آزمایش شد، پس نمی‌توان دربارهٔ کل مسیر قضاوت کرد'
                    : (failedCategories.size
                        ? `از ${fa(reachedCategories.size)} دستهٔ مقصد، این دسته‌ها ناموفق بودند: ${[...failedCategories].join('، ')}`
                        : `همهٔ ${fa(reachedCategories.size)} دستهٔ مقصد موفق بودند`),
                raw: got.map(r => `${r.target.category}:${r.target.host}=${r.handshakeOk ? 'ok' : 'fail'}`).join(' '),
            }));

            // Certificate dates read against the LOCAL clock. If they look wrong, that is
            // corroboration for the clock hypothesis, which is ordered ahead of any
            // interference conclusion precisely so this cannot be mistaken for filtering.
            const peers = got.map(r => r.peer).filter(Boolean);
            if (!peers.length) {
                ctx.put(F.unknown(IDS.TLS_CERT_DATE_INVALID, 'no certificate was returned by any target'));
            } else {
                const now = Date.now();
                const bad = peers.some(p => {
                    const nb = Date.parse(p.notBefore), na = Date.parse(p.notAfter);
                    return (Number.isFinite(nb) && now < nb) || (Number.isFinite(na) && now > na);
                });
                ctx.put(F.observed(IDS.TLS_CERT_DATE_INVALID, bad, {
                    quality: F.QUALITY.MEASURED,
                    note: bad ? 'تاریخ گواهی با ساعت این دستگاه جور نیست' : null,
                    raw: peers.map(p => `${p.subject}|${p.issuer}|${p.notBefore}..${p.notAfter}`).join(' ; '),
                }));
            }
        },
    },
];
