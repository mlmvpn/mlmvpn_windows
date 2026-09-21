// --- GST quota tracking ---
// Answers the two questions the user actually asks when a relay stops working:
//   "how much have I got left?"  and  "when does it come back?"
//
// RESET TIMES ARE COMPUTED, NOT HARD-CODED. The two providers reset on different
// clocks, and one of them moves twice a year:
//
//   Cloudflare — midnight UTC          -> 03:30 Iran time, all year.
//   Google     — midnight US/Pacific   -> ~11:30 Iran time in winter (PST, UTC-8),
//                                         ~10:30 in summer (PDT, UTC-7).
//
// Baking "03:30" in for both would be right half the time and quietly wrong the other
// half, telling a user to wait 4 hours when the real wait is 12. So we ask the runtime's
// own timezone database instead, which tracks DST for us.

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require('./gst-log');

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

// Follows the relay store into the user's home directory: these counters are keyed by
// relay id, so keeping them somewhere the relays are not is worse than useless. See the
// note in gst-config.js about why the install directory is the wrong place for anything
// the user would mind losing.
const DATA_DIR = path.join(os.homedir(), '.mlmvpn');
const QUOTA_FILE = path.join(DATA_DIR, 'gst-quota.json');

// Apps Script's UrlFetchApp ceiling on a free consumer account. The engine reports the
// same figure ("capacity=20000/day" per account in its startup log), so the panel and
// the engine agree on the arithmetic.
const GOOGLE_DAILY_LIMIT = 20000;
// Workers free plan. Generous enough that it is rarely the binding constraint, but it
// does exist and users do hit it.
const CLOUDFLARE_DAILY_LIMIT = 100000;
// Warn while there is still room to react, rather than at the wall.
const WARN_RATIO = 0.8;

/**
 * Offset of `timeZone` from UTC, in minutes, at instant `when`.
 * Derived by formatting the same instant in that zone and diffing — which means DST is
 * handled by the ICU data in the runtime rather than by us guessing.
 */
function tzOffsetMinutes(timeZone, when) {
    const dtf = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const p = {};
    for (const { type, value } of dtf.formatToParts(when)) p[type] = value;
    // `hour` can come back as "24" for midnight in some ICU versions.
    const hour = p.hour === '24' ? '00' : p.hour;
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
    return Math.round((asUtc - when.getTime()) / 60000);
}

/** Next instant at which local midnight occurs in `timeZone`. */
function nextMidnightIn(timeZone, from = new Date()) {
    const offset = tzOffsetMinutes(timeZone, from);
    // Shift into the zone's local frame, round up to the next day boundary, shift back.
    const local = new Date(from.getTime() + offset * 60000);
    const nextLocalMidnight = Date.UTC(
        local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0);
    let guess = new Date(nextLocalMidnight - offset * 60000);
    // Re-resolve once: if a DST transition falls between now and then, the offset we
    // used is the old one and the boundary lands an hour off.
    const offsetThen = tzOffsetMinutes(timeZone, guess);
    if (offsetThen !== offset) guess = new Date(nextLocalMidnight - offsetThen * 60000);
    return guess;
}

/** Format an instant as Tehran wall-clock time, e.g. "۱۱:۳۰". */
function toTehranClock(date) {
    return new Intl.DateTimeFormat('fa-IR', {
        timeZone: 'Asia/Tehran', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date);
}

function humanRemaining(ms) {
    if (ms <= 0) return 'همین حالا';
    const mins = Math.round(ms / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const fa = n => n.toLocaleString('fa-IR');
    if (h && m) return `${fa(h)} ساعت و ${fa(m)} دقیقه`;
    if (h) return `${fa(h)} ساعت`;
    return `${fa(m)} دقیقه`;
}

/** When each provider's daily budget rolls over, expressed in Tehran time. */
function getResetInfo(now = new Date()) {
    const googleAt = nextMidnightIn('America/Los_Angeles', now);
    const cloudflareAt = nextMidnightIn('UTC', now);
    return {
        google: {
            at: googleAt.toISOString(),
            clock: toTehranClock(googleAt),
            remaining: humanRemaining(googleAt - now),
            note: 'سهمیه‌ی گوگل بر اساس نیمه‌شب وقت آمریکا (اقیانوس آرام) ریست می‌شود.',
        },
        cloudflare: {
            at: cloudflareAt.toISOString(),
            clock: toTehranClock(cloudflareAt),
            remaining: humanRemaining(cloudflareAt - now),
            note: 'سهمیه‌ی کلادفلر بر اساس نیمه‌شب UTC ریست می‌شود.',
        },
    };
}

// ── usage counters ────────────────────────────────────────────────────────────

function load() {
    try { return JSON.parse(fs.readFileSync(QUOTA_FILE, 'utf8')); }
    catch (e) { return { relays: {} }; }
}

function save(data) {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(QUOTA_FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        log.warn('quota', `ذخیره‌ی شمارنده‌ی سهمیه ناموفق بود: ${e.message}`);
    }
}

/** Zero a bucket whose window has rolled over since it was last touched. */
function rollIfStale(bucket, resetAtIso) {
    const resetAt = Date.parse(resetAtIso);
    // `windowEnds` is the reset instant this bucket was counting toward. Once that has
    // moved forward, the provider has already given the budget back.
    if (!bucket.windowEnds || Date.parse(bucket.windowEnds) !== resetAt) {
        return { used: 0, failed: 0, windowEnds: resetAtIso };
    }
    return bucket;
}

function recordUsage(relayId, { leg = 'google', count = 1, failed = 0 } = {}) {
    const data = load();
    const reset = getResetInfo();
    const rec = data.relays[relayId] || {};
    const target = leg === 'cloudflare' ? reset.cloudflare.at : reset.google.at;

    const bucket = rollIfStale(rec[leg] || {}, target);
    bucket.used += count;
    bucket.failed += failed;
    rec[leg] = bucket;
    data.relays[relayId] = rec;
    save(data);
    return bucket;
}

/** Per-relay quota view for the panel: used, remaining, percent, warning flag. */
function getRelayQuota(relayId) {
    const data = load();
    const reset = getResetInfo();
    const rec = data.relays[relayId] || {};

    const build = (leg, limit, resetAt) => {
        const b = rollIfStale(rec[leg] || {}, resetAt);
        const used = b.used || 0;
        const ratio = limit ? used / limit : 0;
        return {
            used,
            limit,
            remaining: Math.max(0, limit - used),
            percent: Math.min(100, Math.round(ratio * 100)),
            warning: ratio >= WARN_RATIO,
            exhausted: used >= limit,
        };
    };

    return {
        google: build('google', GOOGLE_DAILY_LIMIT, reset.google.at),
        cloudflare: build('cloudflare', CLOUDFLARE_DAILY_LIMIT, reset.cloudflare.at),
        reset,
    };
}

/**
 * Fleet-wide capacity. This is the number that makes the case for adding another
 * account, so the panel states it in real requests rather than leaving the user to
 * guess what relay #4 buys them.
 */
function getFleetSummary(relays) {
    const usable = relays.filter(r => r.deploymentId);
    let used = 0;
    for (const r of usable) used += getRelayQuota(r.id).google.used;

    const capacity = usable.length * GOOGLE_DAILY_LIMIT;
    return {
        accounts: usable.length,
        capacity,
        used,
        remaining: Math.max(0, capacity - used),
        percent: capacity ? Math.round((used / capacity) * 100) : 0,
        perAccount: GOOGLE_DAILY_LIMIT,
        nextAccountAdds: GOOGLE_DAILY_LIMIT,
        reset: getResetInfo(),
    };
}

module.exports = {
    GOOGLE_DAILY_LIMIT,
    CLOUDFLARE_DAILY_LIMIT,
    getResetInfo,
    recordUsage,
    getRelayQuota,
    getFleetSummary,
    // exported for tests
    nextMidnightIn,
    tzOffsetMinutes,
};
