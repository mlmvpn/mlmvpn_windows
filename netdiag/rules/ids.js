/*
 * The fact-id contract.
 *
 * This file is the interface between the two halves of the engine. The rules below reason
 * about these ids and nothing else; the collectors in netdiag/collectors/ exist to produce
 * exactly these ids. Writing them down in one place is what lets the whole reasoning layer be
 * built and tested before a single probe exists — and what stops a collector from quietly
 * producing `dns.resolver.udp.ok` while a rule waits forever on `dns.resolver.udp53.ok`, a
 * typo that would not throw, would not fail a test, and would silently make a gate UNKNOWN
 * for the life of the product.
 *
 * A rule may only reference ids from here; a test enforces it.
 *
 * Family convention: where an observation is IPv4/IPv6 specific, the family is part of the
 * id (`...v4` / `...v6`) as well as the fact's `family` field, because two families of the
 * same observation are two facts, not one.
 *
 * Interface convention: ids marked (per-interface) are scoped with facts.ifScoped() and are
 * only ever gated on for the egress interface.
 */

'use strict';

const IDS = Object.freeze({
    // ── reachability, aggregated per scope (see the endpoint model) ─────────────────────
    // Values are 'ok' | 'fail' | 'unknown-scope'. A scope that could not be evaluated to its
    // minimum independent-group count must be recorded as an UNKNOWN fact, not as 'fail'.
    REACH_GATEWAY_V4: 'reach.gateway.status.v4',
    REACH_GATEWAY_V6: 'reach.gateway.status.v6',
    REACH_DOMESTIC_V4: 'reach.domestic.status.v4',
    REACH_DOMESTIC_V6: 'reach.domestic.status.v6',
    REACH_FOREIGN_V4: 'reach.foreign.status.v4',
    REACH_FOREIGN_V6: 'reach.foreign.status.v6',
    /** True when every failing endpoint in a scope shared one netGroup — an upstream path, not the machine. */
    REACH_FOREIGN_CORRELATED: 'reach.foreign.correlated',
    /** True when the shipped domestic anchors are contradicted by better evidence. */
    ANCHOR_SET_STALE: 'anchor.set.stale',

    // ── proxy ───────────────────────────────────────────────────────────────────────────
    PROXY_WININET_ENABLED: 'proxy.wininet.enabled',
    PROXY_WININET_SERVER: 'proxy.wininet.server',
    PROXY_WINHTTP_MODE: 'proxy.winhttp.mode',          // 'direct' | 'proxy' | 'autoconfig'
    PROXY_PAC_URL: 'proxy.pac.url',
    PROXY_PAC_FETCHABLE: 'proxy.pac.fetchable',
    PROXY_ENDPOINT_TCP_OK: 'proxy.endpoint.tcp.ok',
    PROXY_ENDPOINT_OWNERSHIP: 'proxy.endpoint.ownership',   // one of ownership.OWNERSHIP
    PROXY_HTTP_VIA_OK: 'proxy.http.via.ok',            // proxy-honoring HTTP succeeded
    PROXY_HTTP_BYPASS_OK: 'proxy.http.bypass.ok',      // proxy-bypassing HTTP succeeded

    // ── DNS ─────────────────────────────────────────────────────────────────────────────
    DNS_CONFIG_LOOPBACK: 'dns.config.loopback',            // (per-interface)
    DNS_CONFIG_STRANDED_LOOPBACK: 'dns.config.stranded-loopback',
    DNS_CONFIG_OWNERSHIP: 'dns.config.ownership',
    DNS_RESOLVER_UDP53_OK: 'dns.resolver.udp53.ok',
    DNS_RESOLVER_TCP53_OK: 'dns.resolver.tcp53.ok',
    /**
     * Resolution through the CONFIGURED resolvers.
     *
     * The collector must point Node's resolver at the servers Windows is actually configured
     * with (`dns.setServers()`) before measuring this. Independent validation caught the trap
     * on the development machine: Windows was configured with 1.1.1.1/1.0.0.1 and resolving
     * perfectly, while Node's own `dns.getServers()` returned `127.0.0.1` and every
     * `resolve4()` came back ECONNREFUSED. Fed to the engine unqualified, that produced a
     * confident «سرور DNS پاسخ نمی‌دهد» on a machine whose DNS was fine — contradicted by
     * `Resolve-DnsName` and `Test-NetConnection 1.1.1.1 -Port 53` in the same second.
     */
    DNS_RESOLVE_OK_V4: 'dns.resolve.ok.v4',
    DNS_RESOLVE_OK_V6: 'dns.resolve.ok.v6',
    /**
     * Resolution the way an ordinary application gets it — the OS path (`dns.lookup`, which
     * is getaddrinfo), including hosts, NRPT and the Windows client cache.
     *
     * Collected separately and never merged with the above: when the two disagree, THAT is
     * the finding, and it is the difference between "DNS is broken" and "this one program's
     * resolver is misconfigured".
     */
    DNS_RESOLVE_OS_OK_V4: 'dns.resolve.os.ok.v4',
    DNS_RESOLVE_PATHS_DISAGREE: 'dns.resolve.paths-disagree',
    /** A POISON_IPS match or a bogon answer for a public name. Positive-only evidence. */
    DNS_ANSWER_FORGED: 'dns.answer.forged',
    /** Names tested, and how many failed — a global claim needs breadth, not one name. */
    DNS_ANSWER_NAMES_TESTED: 'dns.answer.names-tested',
    DNS_ANSWER_NAMES_FAILED: 'dns.answer.names-failed',
    /**
     * How many active (non-comment) entries the hosts file has. A COUNT, not a judgement.
     *
     * It was called 'suspicious-entries' once, and the name leaked into the reasoning: this
     * machine's 90 deliberate license-blocking entries (0.0.0.0 bandicam.com and friends)
     * became a "likely finding" offering a confirm-danger repair on a perfectly healthy
     * machine. Hosts entries are usually the user's own doing; the count is an observation,
     * and only a rule may decide whether it bears on the symptom.
     */
    DNS_HOSTS_ENTRIES: 'dns.hosts.entries',

    // ── the app's own state (ownership) ─────────────────────────────────────────────────
    APP_TUN_VERDICT: 'app.tun.verdict',                // healthy|process-dead|adapter-gone|adapter-down|route-stolen
    APP_TUN_CARRIES_DATA: 'app.tun.carries-data',      // decisive only after 3 attempts on 2 destinations
    APP_ENGINE_RUNNING: 'app.engine.running',
    APP_GUARD_STATE: 'app.guard.state',                // one of ownership.OWNERSHIP
    APP_PROXY_OWNERSHIP: 'app.proxy.ownership',

    // ── routing ─────────────────────────────────────────────────────────────────────────
    ROUTE_DEFAULT_COUNT_V4: 'route.default.count.v4',
    ROUTE_DEFAULT_COUNT_V6: 'route.default.count.v6',
    ROUTE_EGRESS_IS_TUN: 'route.egress.is-tun',
    ROUTE_TABLE_READABLE: 'route.table.readable',

    // ── services ────────────────────────────────────────────────────────────────────────
    SVC_BFE_RUNNING: 'svc.bfe.running',
    SVC_BFE_STARTTYPE: 'svc.bfe.starttype',
    SVC_DNSCACHE_RUNNING: 'svc.dnscache.running',
    SVC_DHCP_RUNNING: 'svc.dhcp.running',
    SVC_NLASVC_RUNNING: 'svc.nlasvc.running',

    // ── firewall ────────────────────────────────────────────────────────────────────────
    FW_OUTBOUND_BLOCK: 'fw.outbound.block',
    WFP_THIRDPARTY_COUNT: 'wfp.thirdparty.count',

    // ── clock ───────────────────────────────────────────────────────────────────────────
    TIME_SKEW_SECONDS: 'time.skew-seconds',

    // ── TLS / HTTP / captive ────────────────────────────────────────────────────────────
    TLS_HANDSHAKE_OK: 'probe.tls.handshake.ok',
    TLS_TCP_OK: 'probe.tls.tcp.ok',
    TLS_CERT_DATE_INVALID: 'probe.tls.cert-date-invalid',
    TLS_FAIL_HOSTS: 'probe.tls.fail-hosts',            // how many distinct hosts reproduced it
    /**
     * How many distinct DESTINATION CATEGORIES reproduced a handshake failure.
     *
     * Independent validation forced this into existence. Both original TLS targets were public
     * DNS resolvers (1.1.1.1, 8.8.8.8) — different operators, so netGroup called them
     * independent — and both had their handshakes reset on the development line. The engine
     * duly headlined «احتمال اختلال در مسیر شبکه» while example.com, microsoft.com, github.com
     * and aparat.com all completed TLS perfectly and every page in the browser opened.
     *
     * Operator independence is not category independence. Resolver endpoints are
     * disproportionately disrupted, so two of them agreeing says something about that class of
     * destination, not about the path. A claim about the user's browsing needs a failure that
     * crosses categories — ordinary web destinations included.
     */
    TLS_FAIL_CATEGORIES: 'probe.tls.fail-categories',
    CAPTIVE_DETECTED: 'ncsi.captive.detected',
    CAPTIVE_LOCATION: 'ncsi.captive.location',
    NCSI_VERDICT: 'ncsi.windows.verdict',

    // ── link stability ──────────────────────────────────────────────────────────────────
    LINK_FLAPPING: 'probe.flapping',
    NEIGH_GATEWAY_STATE: 'neigh.gateway.state',        // Reachable|Stale|Unreachable|…

    // ── winsock / LSP ───────────────────────────────────────────────────────────────────
    WINSOCK_THIRDPARTY_COUNT: 'winsock.thirdparty.count',

    // ── MTU ─────────────────────────────────────────────────────────────────────────────
    MTU_LADDER_LARGEST_OK: 'mtu.ladder.largest-ok',
    MTU_LADDER_SMALL_OK: 'mtu.ladder.small-ok',
    MTU_TCP_CORROBORATED: 'mtu.tcp-corroborated',
    MTU_TARGETS_REPRODUCED: 'mtu.targets-reproduced',

    // ── IPv6 ────────────────────────────────────────────────────────────────────────────
    IPV6_GLOBAL_ADDRESS: 'ipv6.global-address.present',
    IPV6_DEFAULT_ROUTE: 'ipv6.default-route.present',
});

/** The symptom the user actually reported. Hypotheses declare whether they explain it. */
const SYMPTOM = Object.freeze({
    NOTHING_OPENS: 'symptom.nothing-opens',
});

const ALL_IDS = Object.freeze(Object.values(IDS));

module.exports = { IDS, SYMPTOM, ALL_IDS };
