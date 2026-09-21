// --- «ام‌ال‌ام استور» — comparing the version strings the store actually meets ---
//
// One comparison for every kind of thing listed, because they do not share a format and a naive
// split gets several of them wrong in ways that matter:
//
//   26.9.9, 1.14.0, 0.4.9.12, 1.102.4     dotted numbers, three OR four parts
//   1.14.0-alpha.47                        a PRE-RELEASE — older than 1.14.0, newer than 1.13.9
//   2026-09-04 16:24:13                    edgetunnel versions itself by build date
//   2                                      our own workers carry a plain integer
//   v2.0.41                                the tag spelling, "v" and all
//
// The pre-release rule is the one with teeth: sing-box on disk was 1.14.0-alpha.47 while the stable
// 1.14.0 had shipped. A split on dots reads "1.14.0" for both and calls them equal, so the store
// would have kept an alpha forever.
//
// Anything that does not parse (a build hash, a label) compares as UNKNOWN (`null`) rather than as
// zero — "we cannot tell" must never turn into "it is older".

'use strict';

/** { nums: number[], pre: (string|number)[] | null } or null when it is not a version at all. */
function parse(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return { nums: [v], pre: null };
    const s = String(v).trim().replace(/^v(?=\d)/i, '').replace(/\+.*$/, '');
    // Numbers joined by . - : or a space (dates), then optionally a lettered pre-release tail.
    const m = s.match(/^(\d+(?:[.\-: ]\d+)*)(?:[-.]?([A-Za-z][0-9A-Za-z.\-]*))?$/);
    if (!m) return null;
    const nums = m[1].split(/[.\-: ]/).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) return null;
    const pre = m[2]
        ? m[2].split(/[.\-]/).filter(Boolean).map((p) => (/^\d+$/.test(p) ? Number(p) : p.toLowerCase()))
        : null;
    return { nums, pre };
}

const PRE_RANK = { dev: 0, nightly: 0, alpha: 1, a: 1, beta: 2, b: 2, pre: 3, rc: 4 };

function comparePre(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
        const x = a[i], y = b[i];
        if (x === undefined) return -1;      // alpha < alpha.1
        if (y === undefined) return 1;
        if (x === y) continue;
        if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
        if (typeof x === 'number') return -1;   // numeric identifiers sort below words
        if (typeof y === 'number') return 1;
        const rx = PRE_RANK[x], ry = PRE_RANK[y];
        if (rx !== undefined && ry !== undefined && rx !== ry) return rx < ry ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}

/** -1 / 0 / 1, or null when either side is not a version this can reason about. */
function compare(a, b) {
    const x = parse(a), y = parse(b);
    if (!x || !y) return null;
    const n = Math.max(x.nums.length, y.nums.length);
    for (let i = 0; i < n; i++) {
        const p = x.nums[i] || 0, q = y.nums[i] || 0;
        if (p !== q) return p < q ? -1 : 1;
    }
    // Same numbers: a release outranks any pre-release of itself.
    if (!x.pre && !y.pre) return 0;
    if (!x.pre) return 1;
    if (!y.pre) return -1;
    return comparePre(x.pre, y.pre);
}

const isPre = (v) => { const p = parse(v); return !!(p && p.pre); };

/** True only when `candidate` is PROVABLY newer than `current`. Unknown is not newer. */
const newer = (candidate, current) => compare(candidate, current) === 1;

module.exports = { parse, compare, isPre, newer };
