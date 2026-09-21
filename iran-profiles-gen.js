'use strict';

/**
 * Build the «کانفیگ ایران» profile list from the upstream serverless sources.
 *
 * This used to live inside `scripts/gen-iran-profiles.js` and run only at build time. It is a
 * module now because the STORE runs it too: when @patterniha publishes a change to
 * `Serverless-frag{A,B}.jsonc`, the store downloads those two files and regenerates the list here,
 * in the app, so the user gets the new configs without waiting for a whole release.
 *
 * Both callers must produce the same list from the same sources — that is the reason for one
 * module rather than two implementations.
 *
 * ── What the two transforms are, and why ─────────────────────────────────────────────────────
 *
 * The serverless configs reach the internet with NO server: they defeat DPI by fragmenting the
 * TLS ClientHello and resolving names over DoH. Two things decide whether one works on a given
 * line, and both are offered as a choice:
 *
 *   1. THE FRAGMENT PROFILE — upstream ships two (fragA, fragB) and they are the whole point of
 *      the technique. They are copied byte for byte; their value is in NOT being edited.
 *   2. THE RESOLVER, AND HOW IT IS REACHED — this is the one that actually failed. Measured on an
 *      Iranian mobile line, 2026-09-12, against the untouched upstream v50:
 *
 *        cloudflare-dns.com via tcp-fragment-tls  ❌ context deadline exceeded (12s, every name)
 *        cloudflare-dns.com via tcp-direct        ❌ EOF (reset in under a second)
 *        8.8.8.8 (by IP)    via tcp-fragment-tls  ❌ context deadline exceeded
 *        8.8.8.8 (by IP)    via tcp-direct        ✅ answers in 3.2s — names resolve, sites dial
 *
 *      With no resolver the config cannot look up a single name, so EVERY site fails and it reads
 *      as "the config does not connect" when the fragmentation may be fine.
 *
 * Every transform throws when the upstream shape moves (exactly one no-filter-dns server, exactly
 * one route for it, at least two catch-all fragment routes). That is deliberate: a silently
 * half-applied edit would ship a config that looks right and resolves nothing.
 */

// ── jsonc → JSON ─────────────────────────────────────────────────────────────────────────────
//
// Upstream publishes `.jsonc`: JSON with // and /* */ comments. Strings are respected, so a URL's
// `//` inside a quoted value is not mistaken for a comment — that mistake would corrupt every
// `https://` in the file and the result would still parse, which is the worst kind of broken.
function stripJsonComments(text) {
    const s = String(text);
    let out = '';
    let inStr = false;
    let quote = '';
    let esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        const next = s[i + 1];
        if (inStr) {
            out += c;
            if (esc) { esc = false; continue; }
            if (c === '\\') { esc = true; continue; }
            if (c === quote) { inStr = false; }
            continue;
        }
        if (c === '"' || c === "'") { inStr = true; quote = c; out += c; continue; }
        if (c === '/' && next === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
        if (c === '/' && next === '*') {
            i += 2;
            while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++;
            i++;                       // the loop's own i++ steps over the '/'
            continue;
        }
        out += c;
    }
    // Trailing commas are legal in jsonc and fatal in JSON.
    return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Parse an upstream `.jsonc` and give back the exact JSON text the profiles will carry. */
function normalizeSource(text) {
    const obj = JSON.parse(stripJsonComments(text));
    if (!obj || !obj.outbounds || !obj.inbounds || !obj.routing || !obj.dns) {
        throw new Error('این فایل یک کانفیگ کامل Xray نیست (inbounds/outbounds/routing/dns).');
    }
    return JSON.stringify(obj, null, 2);
}

/**
 * The same config with a resolver this line can reach, reached the way that worked.
 *
 * Three edits, no more: the DoH address, the hosts entry that only existed to give the old
 * address a reachable name, and the one routing rule that decides how the resolver's OWN traffic
 * leaves. Everything about the fragmentation is untouched.
 */
function withReachableResolver(src, doh) {
    const cfg = JSON.parse(src);
    delete cfg.dns.hosts;
    let found = 0;
    cfg.dns.servers.forEach((s) => {
        if (s && s.tag === 'no-filter-dns') { s.address = doh; found++; }
    });
    if (found !== 1) throw new Error(`expected exactly one no-filter-dns server, found ${found}`);
    let routed = 0;
    cfg.routing.rules.forEach((r) => {
        if (Array.isArray(r.inboundTag) && r.inboundTag.length === 1 && r.inboundTag[0] === 'no-filter-dns') {
            r.outboundTag = 'tcp-direct';
            routed++;
        }
    });
    if (routed !== 1) throw new Error(`expected exactly one no-filter-dns route, found ${routed}`);
    // The domain lists mention the old resolver by name; with it gone they would be stale.
    const strip = (arr) => (Array.isArray(arr) ? arr.filter((d) => d !== 'full:challenges.cloudflare.com') : arr);
    cfg.dns.servers.forEach((s) => { if (s && s.domains) s.domains = strip(s.domains); });
    cfg.remarks = cfg.remarks + '-directDNS';
    return JSON.stringify(cfg, null, 2);
}

/**
 * The same config with its fragmentation taken out of the ordinary-TLS path.
 *
 * Not a mutilation of the technique — a different, smaller claim. Fragmentation is what defeats
 * SNI filtering, and when the profile does not suit the line it does not merely fail to help:
 * measured 2026-09-12 on an Iranian mobile line, v50's fragment profile could not open
 * www.cloudflare.com at all (22s, no answer), while the very same config without it answered in
 * 3.9s. What survives is the OTHER half of the technique — an honest DoH resolver, the geo
 * routing, the filter-sinkhole block — which is exactly what opens the large class of sites Iran
 * blocks by POISONING DNS rather than by inspecting SNI.
 *
 * It cannot open an SNI-filtered site (YouTube was reset in 278ms with and without it), and the
 * row says so. A profile that quietly does less than its neighbours would be a trap.
 */
function withoutFragmentation(src, doh) {
    const cfg = JSON.parse(withReachableResolver(src, doh));
    let moved = 0;
    cfg.routing.rules.forEach((r) => {
        const everywhere = Array.isArray(r.ip) && r.ip.includes('0.0.0.0/0');
        if (everywhere && (r.outboundTag === 'tcp-fragment-tls' || r.outboundTag === 'tcp-fragment')) {
            r.outboundTag = 'tcp-direct';
            moved++;
        }
    });
    if (moved < 2) throw new Error(`expected the catch-all fragment routes, found ${moved}`);
    cfg.remarks = cfg.remarks.replace('-directDNS', '') + '-cleanDNS';
    return JSON.stringify(cfg, null, 2);
}

// The two axes that decide whether a serverless config works, and they are INDEPENDENT:
//
//   · the RESOLVER — can this line reach that DoH endpoint at all? Measured 2026-09-12 on one
//     Iranian mobile line: Google 8.8.8.8 ✅ 493ms, AdGuard ✅ 1036ms, Cloudflare 1.1.1.1
//     ❌ reset after 11s, Quad9 ❌ HTTP 505, and cloudflare-dns.com by NAME ❌. Another line will
//     answer differently — which is the whole reason this is a list and not a config.
//   · the FRAGMENT SHAPE — upstream ships four across two releases.
//
// Every combination is offered because «کدام کانفیگ مناسب من است؟» measures them and picks.
const RESOLVERS = [
    { key: 'google', doh: 'https://8.8.8.8/dns-query', label: 'Google' },
    { key: 'cloudflare', doh: 'https://1.1.1.1/dns-query', label: 'Cloudflare' },
    { key: 'adguard', doh: 'https://94.140.14.14/dns-query', label: 'AdGuard' },
];

/**
 * @param sources { v50A, v50B, v48low, v48high } — each the exact JSON text of one upstream file.
 * @returns the profile list, in the order the window shows it.
 */
function build(sources) {
    const need = ['v50A', 'v50B', 'v48low', 'v48high'];
    for (const k of need) if (!sources || !sources[k]) throw new Error('منبع ' + k + ' نیست');

    const SHAPES = [
        { key: 'v50a', src: sources.v50A, label: 'v50 fragA', upstream: 'Serverless-v50-fragA' },
        { key: 'v50b', src: sources.v50B, label: 'v50 fragB', upstream: 'Serverless-v50-fragB' },
        { key: 'v48low', src: sources.v48low, label: 'v48 دیلی کم', upstream: 'serverless_v48_low_delay.json' },
        { key: 'v48high', src: sources.v48high, label: 'v48 دیلی بالا', upstream: 'serverless_v48_high_delay.json' },
    ];

    const out = [];
    let n = 0;
    const add = (o) => { out.push(Object.assign({ id: `iran-${++n}` }, o)); };

    // 1. As published. The reference: if one of these works, nothing here is needed.
    SHAPES.forEach((sh) => add({
        name: `${sh.label} — اصل پروژه`, group: 'stock', shape: sh.key, upstream: sh.upstream,
        note: 'همان‌طور که سازنده منتشر کرده.', config: sh.src,
    }));

    // 2. Every shape against every resolver this app knows of. The resolver is tested once for the
    //    whole group, so a line that cannot reach one loses four rows in about a second.
    RESOLVERS.forEach((r) => SHAPES.forEach((sh) => add({
        name: `${sh.label} — DNS ${r.label}`, group: 'resolver', shape: sh.key,
        dns: r.doh, resolver: r.key,
        note: `همان کانفیگ، فقط نام‌ها را از ${r.label} می‌پرسد.`,
        config: withReachableResolver(sh.src, r.doh),
    })));

    // 3. No fragmentation at all — the other half of the technique, on its own.
    RESOLVERS.forEach((r) => add({
        name: `فقط DNS تمیز — ${r.label}`, group: 'clean', shape: 'v50a',
        dns: r.doh, resolver: r.key, clean: true,
        note: 'سایت‌های بسته‌شده با دستکاری DNS را باز می‌کند، نه سایت‌های فیلترشده.',
        config: withoutFragmentation(sources.v50A, r.doh),
    }));

    // Every one of them must be a config Xray will take, or the row is a trap — and every one must
    // still be SERVERLESS, which is the property that makes an unsigned upstream file safe to run.
    out.forEach((p) => {
        const c = JSON.parse(p.config);
        if (!c.outbounds || !c.inbounds || !c.routing) throw new Error(p.id + ': not a full config');
        assertServerless(c, p.name);
    });
    const seen = new Set();
    out.forEach((p) => {
        if (seen.has(p.config)) throw new Error(p.id + ': identical to an earlier profile');
        seen.add(p.config);
    });
    return out;
}

/**
 * Prove a config is what it claims to be: SERVERLESS.
 *
 * This matters because the store can now install these files straight from the upstream repository,
 * without a signature of ours in between. The one thing a hostile edit would want is an outbound
 * pointing at a machine it controls — so the invariant is checked instead of trusted: every
 * outbound must be one of the server-less protocols, and none may carry a server list. A config
 * that cannot send traffic to anybody's server cannot be turned into someone's proxy, whatever
 * else changed in the file.
 */
// Both spellings: Xray renamed `freedom`/`blackhole` to `direct`/`block`, and the upstream files
// use the new names. A list that knows only the old ones would reject every real config — which is
// how a safety check turns into a broken feature.
const SERVERLESS_PROTOCOLS = new Set(['freedom', 'direct', 'blackhole', 'block', 'dns', 'loopback']);

function assertServerless(configText, label) {
    const cfg = typeof configText === 'string' ? JSON.parse(configText) : configText;
    const where = label ? ` (${label})` : '';
    const outs = Array.isArray(cfg.outbounds) ? cfg.outbounds : [];
    if (!outs.length) throw new Error('کانفیگ هیچ خروجی ندارد' + where);
    for (const o of outs) {
        const proto = String((o && o.protocol) || '').toLowerCase();
        if (!SERVERLESS_PROTOCOLS.has(proto)) {
            throw new Error(`خروجی «${proto || '؟'}» در این کانفیگ سرور دارد${where} — کانفیگ سرورلس نباید هیچ سروری داشته باشد.`);
        }
        const st = (o && o.settings) || {};
        if (st.vnext || st.servers || st.address || st.peers) {
            throw new Error(`خروجی «${proto}» آدرس سرور دارد${where} — کانفیگ سرورلس نباید هیچ سروری داشته باشد.`);
        }
    }
    return true;
}

module.exports = {
    build, normalizeSource, stripJsonComments, withReachableResolver, withoutFragmentation,
    assertServerless, SERVERLESS_PROTOCOLS, RESOLVERS,
};
