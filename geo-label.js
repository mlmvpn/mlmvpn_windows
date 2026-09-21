/**
 * Country identity for a proxy node — flag, ISO code, and a localised name.
 *
 * Two things this deliberately does NOT do:
 *
 *  1. It does not geolocate the server's IP. Measured on a 2827-server feed, an IP database
 *     agreed with the provider's own country label only 34% of the time. The disagreements
 *     are not noise: 104.21.x / 104.27.x are Cloudflare anycast (the database says US, the
 *     node exits in Frankfurt), and OVH / Scaleway / Oracle ranges are registered in one
 *     country and served from another. For CDN and hosting addresses the database reports
 *     where the range was REGISTERED, not where it answers.
 *
 *  2. It does not treat its answer as fact. This is the pre-connect guess, drawn from what
 *     the node calls itself. The only authority on where traffic actually leaves is a live
 *     request made through the tunnel — see `traceEgress` in quick-connect.js.
 *
 * The name is produced by Intl, so "DE" becomes «آلمان» without a translation table.
 */

const REGIONAL_A = 0x1F1E6;              // regional indicator A
const REGIONAL_Z = 0x1F1FF;              // regional indicator Z

// Codes that appear in node names but are not what Intl expects.
const ALIASES = { UK: 'GB', EN: 'GB', SU: 'RU' };

/**
 * Words that identify a country when neither a flag nor a code token is present.
 *
 * Two-letter entries are matched as whole tokens only, never as substrings — otherwise
 * "IR" inside "IRELAND" or "DE" inside "DEDICATED" would decide the country. City names are
 * included where a provider is more likely to name the city than the country.
 */
const KEYWORDS = [
    ['US', ['us', 'usa', 'united states', 'america', 'american', 'dallas', 'miami', 'seattle', 'ashburn', 'chicago', 'phoenix', 'atlanta', 'losangeles', 'newyork']],
    ['DE', ['de', 'deu', 'ger', 'germany', 'german', 'deutschland', 'frankfurt', 'berlin', 'munich', 'nuremberg', 'falkenstein']],
    ['NL', ['nl', 'nld', 'netherlands', 'holland', 'dutch', 'amsterdam']],
    ['GB', ['uk', 'gb', 'gbr', 'united kingdom', 'england', 'britain', 'london', 'manchester']],
    ['FR', ['fr', 'fra', 'france', 'french', 'paris', 'marseille', 'gravelines']],
    ['JP', ['jp', 'jpn', 'japan', 'japanese', 'tokyo', 'osaka']],
    ['SG', ['sg', 'sgp', 'singapore']],
    ['HK', ['hk', 'hkg', 'hongkong', 'hong kong']],
    ['TW', ['tw', 'twn', 'taiwan', 'taipei']],
    ['KR', ['kr', 'kor', 'korea', 'seoul']],
    ['CA', ['ca', 'can', 'canada', 'toronto', 'montreal', 'beauharnois']],
    ['AU', ['au', 'aus', 'australia', 'sydney', 'melbourne']],
    ['TR', ['tr', 'tur', 'turkey', 'turkiye', 'istanbul']],
    ['RU', ['ru', 'rus', 'russia', 'moscow']],
    ['PL', ['pl', 'pol', 'poland', 'warsaw']],
    ['IT', ['it', 'ita', 'italy', 'milan', 'rome']],
    ['ES', ['es', 'esp', 'spain', 'madrid', 'barcelona']],
    ['SE', ['se', 'swe', 'sweden', 'stockholm']],
    ['FI', ['fi', 'fin', 'finland', 'helsinki']],
    ['NO', ['no', 'nor', 'norway', 'oslo']],
    ['DK', ['dk', 'dnk', 'denmark', 'copenhagen']],
    ['IE', ['ie', 'irl', 'ireland', 'dublin']],
    ['CH', ['ch', 'che', 'switzerland', 'zurich', 'geneva']],
    ['AT', ['at', 'aut', 'austria', 'vienna']],
    ['BE', ['be', 'bel', 'belgium', 'brussels']],
    ['CZ', ['cz', 'cze', 'czech', 'czechia', 'prague']],
    ['RO', ['ro', 'rou', 'romania', 'bucharest']],
    ['BG', ['bg', 'bgr', 'bulgaria', 'sofia']],
    ['HU', ['hu', 'hun', 'hungary', 'budapest']],
    ['LT', ['lt', 'ltu', 'lithuania', 'vilnius']],
    ['LV', ['lv', 'lva', 'latvia', 'riga']],
    ['EE', ['ee', 'est', 'estonia', 'tallinn']],
    ['UA', ['ua', 'ukr', 'ukraine', 'kyiv', 'kiev']],
    ['RS', ['rs', 'srb', 'serbia', 'belgrade']],
    ['MD', ['md', 'mda', 'moldova']],
    ['BY', ['by', 'blr', 'belarus']],
    ['KZ', ['kz', 'kaz', 'kazakhstan', 'almaty']],
    ['AM', ['am', 'arm', 'armenia', 'yerevan']],
    ['GE', ['ge', 'geo', 'georgia', 'tbilisi']],
    ['AZ', ['az', 'aze', 'azerbaijan', 'baku']],
    ['AE', ['ae', 'are', 'uae', 'emirates', 'dubai', 'abudhabi']],
    ['SA', ['sa', 'sau', 'saudi', 'saudiarabia', 'riyadh']],
    ['QA', ['qa', 'qat', 'qatar', 'doha']],
    ['KW', ['kw', 'kwt', 'kuwait']],
    ['OM', ['om', 'omn', 'oman', 'muscat']],
    ['IL', ['il', 'isr', 'israel', 'telaviv']],
    ['IN', ['in', 'ind', 'india', 'mumbai', 'delhi', 'bangalore']],
    ['ID', ['id', 'idn', 'indonesia', 'jakarta']],
    ['MY', ['my', 'mys', 'malaysia', 'kualalumpur']],
    ['TH', ['th', 'tha', 'thailand', 'bangkok']],
    ['VN', ['vn', 'vnm', 'vietnam', 'hanoi', 'saigon']],
    ['PH', ['ph', 'phl', 'philippines', 'manila']],
    ['CN', ['cn', 'chn', 'china', 'shanghai', 'beijing', 'shenzhen']],
    ['BR', ['br', 'bra', 'brazil', 'saopaulo']],
    ['AR', ['ar', 'arg', 'argentina', 'buenosaires']],
    ['CL', ['cl', 'chl', 'chile', 'santiago']],
    ['CO', ['co', 'col', 'colombia', 'bogota']],
    ['PE', ['pe', 'per', 'peru', 'lima']],
    ['MX', ['mx', 'mex', 'mexico']],
    ['PA', ['pa', 'pan', 'panama']],
    ['ZA', ['za', 'zaf', 'southafrica', 'johannesburg']],
    ['NG', ['ng', 'nga', 'nigeria', 'lagos']],
    ['EG', ['eg', 'egy', 'egypt', 'cairo']],
    ['NZ', ['nz', 'nzl', 'newzealand', 'auckland']],
    ['PT', ['pt', 'prt', 'portugal', 'lisbon']],
    ['GR', ['gr', 'grc', 'greece', 'athens']],
    ['HR', ['hr', 'hrv', 'croatia', 'zagreb']],
    ['SK', ['sk', 'svk', 'slovakia', 'bratislava']],
    ['SI', ['si', 'svn', 'slovenia', 'ljubljana']],
    ['AL', ['al', 'alb', 'albania', 'tirana']],
    ['CY', ['cy', 'cyp', 'cyprus', 'nicosia']],
    ['IS', ['is', 'isl', 'iceland', 'reykjavik']],
    ['LU', ['lu', 'lux', 'luxembourg']],
    ['MT', ['mt', 'mlt', 'malta']],
    ['IR', ['ir', 'irn', 'iran', 'tehran']],
];

// A two-letter code is only decisive as its own token; a longer word may also match a run
// of letters inside a larger name ("frankfurt" inside "de-frankfurt-01").
const SHORT_TOKENS = new Map();
const LONG_TOKENS = [];
for (const [code, words] of KEYWORDS) {
    for (const w of words) {
        if (w.length <= 3) {
            if (!SHORT_TOKENS.has(w)) SHORT_TOKENS.set(w, code);
        } else {
            LONG_TOKENS.push([w.replace(/\s+/g, ''), code]);
        }
    }
}
// Longest first, so a shorter word that happens to be a prefix cannot win.
LONG_TOKENS.sort((a, b) => b[0].length - a[0].length);

const displayNamesCache = new Map();
function displayNames(locale) {
    if (displayNamesCache.has(locale)) return displayNamesCache.get(locale);
    let dn = null;
    try { dn = new Intl.DisplayNames([locale], { type: 'region' }); } catch (e) { dn = null; }
    displayNamesCache.set(locale, dn);
    return dn;
}

/** "DE" -> the German flag. The flag is BUILT from the code, never copied out of the node's
 *  name, so a name carrying the wrong flag next to the right code cannot produce a
 *  mismatched pair on screen. */
function flagForCode(code) {
    if (!code || code.length !== 2) return '\u{1F3F3}️';
    return String.fromCodePoint(
        REGIONAL_A + (code.charCodeAt(0) - 65),
        REGIONAL_A + (code.charCodeAt(1) - 65),
    );
}

function normalizeCode(raw) {
    if (!raw) return null;
    const code = String(raw).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return null;
    return ALIASES[code] || code;
}

/** Full identity for an ISO code, or null when the code is not a real region. */
function countryFromCode(raw, locale = 'fa') {
    const code = normalizeCode(raw);
    if (!code) return null;
    const dn = displayNames(locale);
    let name = code;
    if (dn) {
        let got = null;
        try { got = dn.of(code); } catch (e) { return null; }
        // Intl echoes the input back for codes it does not know — treat that as a miss
        // rather than showing the user a bare two-letter label as if it were a country.
        if (!got || got === code) return null;
        // Intl returns administrative full names for a few regions — Hong Kong comes back as
        // «هنگ‌کنگ، منطقهٔ ویژهٔ اداری چین», which is four times the width of every other row in
        // a flag list. The qualifier always follows a comma, so dropping it leaves the name
        // people actually use without a per-country translation table.
        name = got.split(/[,،]/)[0].trim() || got;
    }
    const flag = flagForCode(code);
    return { code, name, flag, label: `${flag} ${name}` };
}

/** The first regional-indicator pair anywhere in the text, as an ISO code. */
function flagCodeIn(text) {
    const points = Array.from(text, (c) => c.codePointAt(0));
    for (let i = 0; i < points.length - 1; i++) {
        if (points[i] >= REGIONAL_A && points[i] <= REGIONAL_Z &&
            points[i + 1] >= REGIONAL_A && points[i + 1] <= REGIONAL_Z) {
            return String.fromCharCode(
                points[i] - REGIONAL_A + 65,
                points[i + 1] - REGIONAL_A + 65,
            );
        }
    }
    return null;
}

/**
 * The "DE1" / "NL12" convention: a pipe-separated field that is a country code followed by
 * an index. Common enough in public feeds to be worth a rule of its own, and it survives
 * clients that strip emoji.
 */
function codeTokenIn(text) {
    for (const part of text.split('|')) {
        const m = part.trim().match(/^([A-Za-z]{2})\d+/);
        if (m) {
            const code = normalizeCode(m[1]);
            if (code) return code;
        }
    }
    return null;
}

function keywordCodeIn(text) {
    const flat = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!flat) return null;
    const squashed = flat.replace(/\s+/g, '');
    for (const [word, code] of LONG_TOKENS) {
        if (squashed.includes(word)) return code;
    }
    for (const token of flat.split(' ')) {
        const hit = SHORT_TOKENS.get(token);
        if (hit) return hit;
    }
    return null;
}

/**
 * Country for a node, from whatever text describes it. Order is confidence order: an
 * explicit flag beats a code token, which beats a guess from words.
 *
 * Returns `{ code, name, flag, label, source }` or null when nothing identifies it — null
 * is a real answer here, and the UI groups those under «نامشخص» rather than inventing a
 * country for them.
 */
function countryFromText(parts, locale = 'fa') {
    const text = (Array.isArray(parts) ? parts : [parts]).filter(Boolean).join(' ');
    if (!text) return null;

    const byFlag = countryFromCode(flagCodeIn(text), locale);
    if (byFlag) return Object.assign(byFlag, { source: 'flag' });

    const byToken = countryFromCode(codeTokenIn(text), locale);
    if (byToken) return Object.assign(byToken, { source: 'code' });

    const byWord = countryFromCode(keywordCodeIn(text), locale);
    if (byWord) return Object.assign(byWord, { source: 'name' });

    return null;
}

module.exports = { countryFromText, countryFromCode, flagForCode, normalizeCode };
