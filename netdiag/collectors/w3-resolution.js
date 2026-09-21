/*
 * W3 — name resolution.
 *
 * The single most important line in this file is `resolver.setServers(...)`.
 *
 * Independent validation caught the alternative in the act: on the development machine
 * Windows was configured with 1.1.1.1/1.0.0.1 and resolving perfectly, while Node's own
 * `dns.getServers()` returned `127.0.0.1` with nothing listening there. Every `resolve4()`
 * came back ECONNREFUSED, and the engine reported a confident «سرور DNS پاسخ نمی‌دهد» —
 * contradicted in the same second by `Resolve-DnsName` and `Test-NetConnection 1.1.1.1:53`.
 * A collector that does not pin its resolvers is measuring Node's configuration and calling
 * it the machine's DNS health.
 *
 * So two paths are measured, separately and never merged:
 *
 *   the CONFIGURED path   a resolver pinned to the servers Windows actually uses. This is
 *                         what "is DNS working" means.
 *   the OS path           `dns.lookup`, i.e. getaddrinfo — what an ordinary application gets,
 *                         including hosts, NRPT and the Windows client cache.
 *
 * When those two disagree, THAT is the finding: it is the difference between "DNS is broken"
 * and "one program's resolver is misconfigured", and merging them destroys it.
 *
 * Answer classification is local-only and positive-only. A POISON_IPS match proves forgery;
 * its absence proves nothing, because route-cache.js:51's list is a snapshot and the targets
 * change. CDN and anycast variation is normal and is never an anomaly.
 */

'use strict';

const dns = require('dns');
const F = require('../facts');
const P = require('../probe');
const { IDS } = require('../rules/ids');
const { POISON_IPS } = require('../../route-cache');

/**
 * Names chosen for breadth, not popularity.
 *
 * Five names across unrelated operators, so a single provider having a bad day cannot look
 * like a machine-wide DNS failure — and so a global claim has the breadth §14.3 requires.
 * Every one is a plain public name with an ordinary public answer.
 */
const TEST_NAMES = ['example.com', 'wikipedia.org', 'microsoft.com', 'github.com', 'cloudflare.com'];

/** Answers no public name can legitimately have. Positive evidence of an anomaly. */
function isBogonAnswer(ip) {
    if (!ip) return false;
    if (POISON_IPS.includes(ip)) return true;
    return /^0\.0\.0\.0$/.test(ip)
        || /^127\./.test(ip)
        || /^10\./.test(ip)
        || /^192\.168\./.test(ip)
        || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
        || /^169\.254\./.test(ip);
}

function configuredServers(session) {
    const list = (session.app && session.app.dnsServers) || [];
    return list.filter(s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s));
}

module.exports = [
    {
        id: 'w3.resolver-reachability',
        wave: 'w3',
        label: 'بررسی در دسترس بودن سرور DNS',
        network: true,
        timeout: 10000,
        produces: [IDS.DNS_RESOLVER_UDP53_OK, IDS.DNS_RESOLVER_TCP53_OK, IDS.DNS_CONFIG_STRANDED_LOOPBACK],

        when(facts) {
            if (!F.isObserved(facts, IDS.DNS_CONFIG_LOOPBACK)) return { skip: 'تنظیمات DNS خوانده نشد' };
            return true;
        },
        whenText: 'DNS configuration was read',

        async run(ctx) {
            const servers = configuredServers(ctx.session);
            if (!servers.length) {
                ctx.put(F.unknown(IDS.DNS_RESOLVER_UDP53_OK, 'no IPv4 resolver is configured on this machine'));
                ctx.put(F.unknown(IDS.DNS_RESOLVER_TCP53_OK, 'no IPv4 resolver is configured on this machine'));
                ctx.put(F.unknown(IDS.DNS_CONFIG_STRANDED_LOOPBACK, 'no resolver to test'));
                return;
            }
            const first = servers[0];

            // UDP and TCP separately: they answer different questions. A resolver that is
            // simply unreachable and one whose UDP/53 is filtered need different repairs, and
            // a single timeout cannot tell them apart.
            const udp = await P.dnsUdpProbe(first, 2500, 4);
            const tcp = await P.tcpProbe(first, 53, 2500, 4);
            ctx.put(F.observed(IDS.DNS_RESOLVER_UDP53_OK, udp.ok, {
                quality: F.QUALITY.MEASURED, family: 'v4',
                note: udp.ok ? null : 'UDP has no handshake, so silence here is weaker evidence than a TCP failure',
            }));
            ctx.put(F.observed(IDS.DNS_RESOLVER_TCP53_OK, tcp.ok, { quality: F.QUALITY.MEASURED, family: 'v4' }));

            // The stranded-loopback case: Windows points at a local resolver that a crashed
            // engine was supposed to be running. `dns-manager.js:873` detects the shape; what
            // makes it a fault is that nothing answers there now.
            const loopback = servers.filter(s => /^127\./.test(s));
            if (!loopback.length) {
                ctx.put(F.observed(IDS.DNS_CONFIG_STRANDED_LOOPBACK, false, { quality: F.QUALITY.INFERRED }));
            } else {
                const live = await P.tcpProbe(loopback[0], 53, 1200, 4);
                const udpLive = await P.dnsUdpProbe(loopback[0], 1200, 4);
                ctx.put(F.observed(IDS.DNS_CONFIG_STRANDED_LOOPBACK, !(live.ok || udpLive.ok), {
                    quality: F.QUALITY.MEASURED,
                    note: `DNS points at ${loopback[0]}; something ${live.ok || udpLive.ok ? 'is' : 'is not'} listening there`,
                }));
            }
        },
    },

    {
        id: 'w3.resolution',
        wave: 'w3',
        label: 'ترجمهٔ نام سایت‌ها',
        network: true,
        timeout: 14000,
        produces: [
            IDS.DNS_RESOLVE_OK_V4, IDS.DNS_RESOLVE_OS_OK_V4, IDS.DNS_RESOLVE_PATHS_DISAGREE,
            IDS.DNS_ANSWER_NAMES_TESTED, IDS.DNS_ANSWER_NAMES_FAILED, IDS.DNS_ANSWER_FORGED,
        ],

        when(facts) {
            if (!F.isObserved(facts, IDS.DNS_CONFIG_LOOPBACK)) return { skip: 'تنظیمات DNS خوانده نشد' };
            return true;
        },
        whenText: 'DNS configuration was read',

        async run(ctx) {
            const servers = configuredServers(ctx.session);

            // A private Resolver, pinned to the machine's servers. Never the global resolver:
            // mutating dns.setServers() process-wide would change behaviour for every other
            // part of this app, and reading it instead of setting it is the bug described at
            // the top of this file.
            let resolver = null;
            if (servers.length) {
                resolver = new dns.promises.Resolver();
                try { resolver.setServers(servers); } catch (e) { resolver = null; }
            }

            const perName = [];
            await P.pool(TEST_NAMES, 3, async (name) => {
                if (ctx.cancelled) return;
                const row = { name, configured: null, os: null, addrs: [] };

                if (resolver) {
                    try {
                        const a = await P.withDeadline(resolver.resolve4(name), 2500, () => { throw new Error('timeout'); });
                        row.configured = true;
                        row.addrs = a || [];
                    } catch (e) {
                        row.configured = false;
                        row.error = e.code || e.message;
                    }
                }
                // getaddrinfo: what an ordinary program actually gets, hosts file and all.
                try {
                    const r = await P.withDeadline(dns.promises.lookup(name, { family: 4 }), 2500, () => { throw new Error('timeout'); });
                    row.os = true;
                    if (r && r.address && !row.addrs.length) row.addrs = [r.address];
                    row.osAddress = r && r.address;
                } catch (e) {
                    row.os = false;
                }
                perName.push(row);
            });

            const tested = perName.length;
            const configuredOk = perName.filter(r => r.configured === true).length;
            const osOk = perName.filter(r => r.os === true).length;

            ctx.put(F.observed(IDS.DNS_ANSWER_NAMES_TESTED, tested, { quality: F.QUALITY.MEASURED }));
            ctx.put(F.observed(IDS.DNS_ANSWER_NAMES_FAILED, tested - configuredOk, { quality: F.QUALITY.MEASURED }));

            if (!resolver) {
                ctx.put(F.unknown(IDS.DNS_RESOLVE_OK_V4, 'no configured resolver could be pinned, so the machine\'s DNS path was not measured'));
            } else {
                ctx.put(F.observed(IDS.DNS_RESOLVE_OK_V4, configuredOk > 0, {
                    quality: F.QUALITY.MEASURED, family: 'v4',
                    note: `${configuredOk}/${tested} names resolved via ${servers.join(', ')}`,
                    raw: perName.map(r => `${r.name}:${r.configured ? (r.addrs[0] || 'ok') : (r.error || 'fail')}`).join(' '),
                }));
            }
            ctx.put(F.observed(IDS.DNS_RESOLVE_OS_OK_V4, osOk > 0, {
                quality: F.QUALITY.MEASURED, family: 'v4',
                note: `${osOk}/${tested} names resolved through the operating system`,
            }));

            // The disagreement is its own fact, never folded into either side.
            //
            // The note is CONDITIONAL. Attaching it unconditionally put
            // «یک مسیر جواب می‌دهد و مسیر دیگر نه» next to a value of `false` in the report — a
            // note that contradicted the fact it annotated, which is worse than no note at all
            // for a reader deciding whether to trust the rest of the document.
            const disagree = resolver ? (configuredOk > 0) !== (osOk > 0) : false;
            ctx.put(F.observed(IDS.DNS_RESOLVE_PATHS_DISAGREE, disagree, {
                quality: F.QUALITY.MEASURED,
                note: disagree
                    ? 'یک مسیر جواب می‌دهد و مسیر دیگر نه — این خودش یک یافته است'
                    : null,
            }));

            // Local invariants only. No DoH oracle, no remote authority: whether an answer is
            // forged is decided by a list compiled into the binary and by address category,
            // and where neither decides, the answer stays unknown rather than becoming a guess.
            const answers = perName.flatMap(r => r.addrs);
            if (!answers.length) {
                ctx.put(F.unknown(IDS.DNS_ANSWER_FORGED, 'no answers were returned, so none could be classified'));
            } else {
                const bogus = answers.filter(isBogonAnswer);
                ctx.put(F.observed(IDS.DNS_ANSWER_FORGED, bogus.length > 0, {
                    quality: F.QUALITY.MEASURED,
                    note: bogus.length
                        ? `پاسخ‌های نامعتبر برای نام‌های عمومی: ${[...new Set(bogus)].join(', ')}`
                        : 'هیچ پاسخی با نشانه‌های محلیِ دستکاری مطابقت نداشت (این به معنی سالم‌بودن قطعی نیست)',
                    raw: [...new Set(answers)].join(','),
                }));
            }
        },
    },
];
