// --- TLS Fingerprint + Fragment (جایگزین SNI-Spoofing) ---
//
// روش fragment+fingerprint برای کانفیگ‌های کلودفلر (Workers / Pages / CDN).
// جایگزین sni-spoofing است و دو مشکل را با هم حل می‌کند:
//   ۱. فیلتر شدن دامنه‌ی workers.dev / pages.dev
//   ۲. محدودیت شدید آپلود روی نت‌های همراه
//
// بر خلاف نسخه‌ی موقتِ ویندوز که یک xray دوم را به عنوان MITM محلی بالا می‌آورد و
// کاربر باید address/port/pinnedPeerCertSha256 را دستی عوض می‌کرد، اینجا همان
// تنظیمات مستقیم داخل خودِ outbound نوشته می‌شود: هسته‌ی Xray از نسخه‌ی 26.7.28 به بعد
// این سه مورد را به صورت بومی پشتیبانی می‌کند، پس نه پروسه‌ی جانبی لازم است، نه
// pinning دستی، و نه هیچ کاری از سمت کاربر. کاربر فقط کانفیگ را از «زیرساخت ابری»
// می‌گیرد و وصل می‌شود.
//
// سه جزء لازم و به‌هم‌وابسته‌اند — با حذف هرکدام روش می‌شکند:
//   * finalmask   : فرگمنت کردن ClientHello و اولین رکورد دیتا (دور زدن تشخیص SNI و
//                   محدودیت آپلود)
//   * fingerprint : "unsafe" تا Xray ترتیب/محتوای ClientHello را دقیقاً همان‌طور که
//                   cipherSuites می‌گوید بسازد و uTLS آن را بازنویسی نکند
//   * cipherSuites: لیست دقیق patterniha؛ ترکیب همین لیست است که پروفایل TLS را از
//                   امضای شناخته‌شده‌ی Xray جدا می‌کند
//
// منبع: پروفایل fragment_fingerprint_v1 (@patterniha) — همان چیزی که PattNG روی
// اندروید در finalMask/cipherSuites می‌نویسد.

const fs = require('fs');
const os = require('os');
const path = require('path');

// کنار بقیه‌ی state برنامه، بیرون از پوشه‌ی نصب تا آپدیت آن را پاک نکند.
const DATA_DIR = path.join(os.homedir(), '.mlmvpn');
const CONFIG_FILE = path.join(DATA_DIR, 'tls-fingerprint.json');

// ── پروفایل fragment_fingerprint_v1 ──
const FINAL_MASK = {
    tcp: [
        { type: 'fragment', settings: { packets: 'tlshello', lengths: ['5', '94', '1'], delays: ['0'], maxSplit: '0' } },
        { type: 'fragment', settings: { packets: '1-1', lengths: ['109', '1'], delays: ['1'], maxSplit: '355' } },
    ],
};

const CIPHER_SUITES = [
    'TLS_AES_256_GCM_SHA384',
    'TLS_CHACHA20_POLY1305_SHA256',
    'TLS_AES_128_GCM_SHA256',
    'TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384',
    'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384',
    'TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256',
    'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256',
    'TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256',
    'TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256',
    'TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA',
    'TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
    'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256',
    'TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256',
].join(':');

const FINGERPRINT = 'unsafe';

const DEFAULTS = {
    // پیش‌فرض روشن: کاربر نباید برای کارکردن کانفیگ ابری کاری بکند.
    enabled: true,
    // 'auto' = فقط روی مقصدهای کلودفلر، 'always' = روی هر outbound با TLS،
    // 'off'  = هرگز (معادل enabled:false، برای عیب‌یابی نگه داشته شده)
    mode: 'auto',
};

let cache = null;

function getConfig() {
    if (cache) return cache;
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
            return cache;
        }
    } catch (e) { /* فایل خراب = برگرد به پیش‌فرض، نه کرش */ }
    cache = { ...DEFAULTS };
    return cache;
}

function setConfig(patch) {
    const next = { ...getConfig(), ...(patch || {}) };
    if (!DEFAULTS.mode || !['auto', 'always', 'off'].includes(next.mode)) next.mode = DEFAULTS.mode;
    cache = next;
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    } catch (e) { /* ماندگار نشد؛ حداقل همین نشست اعمال می‌شود */ }
    return next;
}

// دامنه‌های میزبانِ کلودفلر که کانفیگ‌های این برنامه رویشان ساخته می‌شوند.
const CF_HOST_SUFFIXES = ['.workers.dev', '.pages.dev', '.trycloudflare.com', '.r2.dev'];

// بازه‌های IPv4 کلودفلر (https://www.cloudflare.com/ips-v4). چون کاربر تقریباً همیشه
// آدرس را با «آیپی تمیز» جایگزین می‌کند، تشخیص از روی دامنه به تنهایی کافی نیست.
const CF_V4_RANGES = [
    ['173.245.48.0', 20], ['103.21.244.0', 22], ['103.22.200.0', 22],
    ['103.31.4.0', 22], ['141.101.64.0', 18], ['108.162.192.0', 18],
    ['190.93.240.0', 20], ['188.114.96.0', 20], ['197.234.240.0', 22],
    ['198.41.128.0', 17], ['162.158.0.0', 15], ['104.16.0.0', 13],
    ['104.24.0.0', 14], ['172.64.0.0', 13], ['131.0.72.0', 22],
];

function ipToInt(ip) {
    const p = ip.split('.');
    if (p.length !== 4) return null;
    let n = 0;
    for (const part of p) {
        const v = Number(part);
        if (!Number.isInteger(v) || v < 0 || v > 255) return null;
        n = (n * 256) + v;
    }
    return n;
}

function isCloudflareIp(ip) {
    const n = ipToInt(ip);
    if (n === null) return false;
    return CF_V4_RANGES.some(([base, bits]) => {
        const b = ipToInt(base);
        // با >>> کار نمی‌کنیم چون /13 و /15 در محاسبه‌ی ۳۲ بیتیِ علامت‌دار می‌شکنند.
        const size = Math.pow(2, 32 - bits);
        return n >= b && n < b + size;
    });
}

function isCloudflareHost(host) {
    if (!host) return false;
    const h = String(host).toLowerCase().replace(/\.$/, '');
    return CF_HOST_SUFFIXES.some(s => h.endsWith(s));
}

/**
 * آیا این مقصد یک نودِ کلودفلر است؟
 * address ممکن است آیپی تمیزِ جایگزین‌شده باشد و sni/host دامنه‌ی واقعی.
 */
function isCloudflareTarget({ address, sni, host } = {}) {
    return isCloudflareIp(address) || isCloudflareHost(sni) || isCloudflareHost(host);
}

function shouldApply(target) {
    const cfg = getConfig();
    if (!cfg.enabled || cfg.mode === 'off') return false;
    if (cfg.mode === 'always') return true;
    return isCloudflareTarget(target);
}

/**
 * پروفایل را روی یک outbound ساخته‌شده اعمال می‌کند (تغییر درجا) و true برمی‌گرداند
 * اگر واقعاً اعمال شده باشد.
 *
 * فقط روی security === 'tls' کار می‌کند: reality امضای TLS خودش را می‌سازد و دست‌کاری
 * cipherSuites آن دست‌دادن را خراب می‌کند، و روی security 'none' اصلاً TLS ای وجود ندارد.
 */
function applyToOutbound(outbound, target) {
    if (!outbound || !outbound.streamSettings) return false;
    const ss = outbound.streamSettings;
    if (ss.security !== 'tls' || !ss.tlsSettings) return false;
    if (!shouldApply(target || {})) return false;

    ss.tlsSettings.fingerprint = FINGERPRINT;
    ss.tlsSettings.cipherSuites = CIPHER_SUITES;
    // finalmask هم‌سطح tlsSettings است، نه داخل آن.
    ss.finalmask = JSON.parse(JSON.stringify(FINAL_MASK));
    return true;
}

module.exports = {
    getConfig,
    setConfig,
    applyToOutbound,
    isCloudflareTarget,
    isCloudflareIp,
    isCloudflareHost,
    FINAL_MASK,
    CIPHER_SUITES,
    FINGERPRINT,
};
