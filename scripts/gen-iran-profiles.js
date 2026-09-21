// Generates public/components/iran-profiles.js from the upstream sources, verbatim:
//   node scripts/gen-iran-profiles.js
//
// The serverless configs reach the internet with NO server: they defeat DPI by fragmenting
// the TLS ClientHello and resolving names over DoH. Two things therefore decide whether one
// works on a given line, and both are worth offering as a choice:
//
//   1. THE FRAGMENT PROFILE — upstream ships two (fragA, fragB) and they are the whole point
//      of the technique. They are copied byte for byte; their value is in NOT being edited.
//   2. THE RESOLVER, AND HOW IT IS REACHED — this is the one that actually failed. Measured
//      on an Iranian mobile line, 2026-09-12, against the untouched upstream v50:
//
//        cloudflare-dns.com via tcp-fragment-tls  ❌ context deadline exceeded (12s, every name)
//        cloudflare-dns.com via tcp-direct        ❌ EOF (reset in under a second)
//        8.8.8.8 (by IP)    via tcp-fragment-tls  ❌ context deadline exceeded
//        8.8.8.8 (by IP)    via tcp-direct        ✅ answers in 3.2s — names resolve, sites dial
//
//      With no resolver the config cannot look up a single name, so EVERY site fails and it
//      reads as "the config does not connect" when the fragmentation may be fine. Hence a
//      variant of each fragment profile whose resolver is one this kind of line can reach.
//
// The v48 pair is kept because a line where v50 fails may still take v48 — the same reason
// upstream keeps two fragment profiles.
const fs = require('fs');
const path = require('path');
const gen = require('../iran-profiles-gen');

const R = path.resolve(__dirname, '..');
const S = path.join(R, 'data', 'serverless');

// All four sources live in data/serverless/ so the APP can regenerate the list at runtime too:
// the store downloads a new upstream Serverless-frag{A,B} and calls the same builder
// (iran-profiles-gen.js). The v48 pair is vendored there for the same reason.
const read = (p) => { const t = fs.readFileSync(p, 'utf8'); JSON.parse(t); return t; };
const sources = {
    v50A: read(path.join(S, 'serverless-v50-fragA.json')),
    v50B: read(path.join(S, 'serverless-v50-fragB.json')),
    v48low: read(path.join(S, 'serverless-v48-low.json')),
    v48high: read(path.join(S, 'serverless-v48-high.json')),
};

const out = gen.build(sources);

const js = `/* The built-in «کانفیگ ایران» configs — generated from the upstream sources, not retyped.
 *
 * These reach the internet with NO server: they fragment the TLS ClientHello to defeat DPI and
 * resolve names over DoH. So two things decide whether one works on a given line — the fragment
 * profile, and whether the resolver can be reached at all — and this list offers both as a
 * choice rather than one take-it-or-leave-it config:
 *
 *   #1–#2  data/serverless/serverless-v50-frag{A,B}.json — upstream Serverless-for-Iran v50
 *          (@patterniha), byte for byte; their whole value is in NOT being edited.
 *   #3–#4  the same two with the resolver swapped for one an Iranian line can actually reach,
 *          routed unfragmented. Measured 2026-09-12: upstream's cloudflare-dns.com timed out on
 *          EVERY name (12s each), so nothing resolved and every site failed — which reads as
 *          "the config does not connect" even when the fragmentation is fine.
 *   #5     the same base with NO fragmentation: an honest DoH resolver, the geo routing and
 *          the sinkhole block, and nothing else. It opens what Iran blocks by poisoning DNS —
 *          and cannot open what is filtered by SNI. Measured on a line where v50's fragment
 *          profile could not even reach www.cloudflare.com (22s) while this answered in 3.9s.
 *   #6–#7  the v48 pair, kept because a line where v50 fails may still take v48.
 *
 * Each \`config\` is the exact JSON string handed to Xray. The server replaces the inbounds with
 * the app's own ports (xray-manager › full custom config), so the upstream 10808 never matters
 * here the way it does on Android.
 * Regenerate rather than edit: node scripts/gen-iran-profiles.js
 */
window.IRAN_PROFILES = ${JSON.stringify(out, null, 1)};
`;
fs.writeFileSync(path.join(R, 'public', 'components', 'iran-profiles.js'), js);

// ...and the same list for Android, as one asset it can read at startup.
//
// Generated rather than hand-kept in Kotlin: the two transforms above are JSON surgery with
// invariants that throw when the upstream shape moves (exactly one no-filter-dns server, exactly
// one route for it, at least two catch-all fragment routes). Re-implementing them as Kotlin
// string replacement over pretty-printed JSON would be the same work with none of the checks,
// and the two platforms would drift the first time upstream reformatted a file.
const androidAssets = path.join(R, 'android', 'app', 'src', 'main', 'assets');
if (fs.existsSync(androidAssets)) {
    const forAndroid = out.map((p) => ({
        id: p.id, name: p.name, method: p.group || '', dns: p.dns || '', note: p.note || '',
        config: p.config,
    }));
    fs.writeFileSync(path.join(androidAssets, 'iran_profiles.json'), JSON.stringify(forAndroid));
    console.log('wrote android/app/src/main/assets/iran_profiles.json');
}

console.log('wrote', out.length, 'profiles,', js.length, 'bytes');
for (const p of out) console.log(' ', p.id, '·', p.name, '·', p.dns || p.upstream || '');
