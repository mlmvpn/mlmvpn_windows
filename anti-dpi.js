/**
 * anti-dpi.js — ماژول ضد فیلترینگ هوشمند (Anti-DPI)
 * 
 * مکانیزم‌ها:
 * 1. Mixed-Case SNI: رندومایز کردن حروف دامین برای بایپس شناسایی SNI
 * 2. Safe Naming: تولید نام‌های خنثی برای ورکرها و سابدامین‌ها
 * 3. URI Camouflage: اعمال خودکار تغییرات روی کانفیگ‌های VLESS/Trojan
 */

const crypto = require('crypto');

// ─── لیست کلمات ممنوعه (Blacklist) ───
const BLACKLISTED_KEYWORDS = [
    'bpb', 'panel', 'vpn', 'proxy', 'tunnel', 'v2ray', 'xray',
    'trojan', 'clash', 'surge', 'shadowsocks', 'ss', 'ssr',
    'vless', 'vmess', 'wireguard', 'warp', 'filter', 'bypass',
    'freedom', 'gfw', 'censorship'
];

// ─── پول نام‌های خنثی و عمومی ───
const SAFE_PREFIXES = [
    'app-core', 'edge-relay', 'main-thunder', 'cloud-sync',
    'data-stream', 'net-bridge', 'api-hub', 'web-flow',
    'fast-route', 'smart-gate', 'node-link', 'micro-svc',
    'auto-scale', 'load-bal', 'cdn-edge', 'cache-opt',
    'log-svc', 'auth-api', 'user-svc', 'task-run',
    'event-bus', 'msg-queue', 'file-io', 'db-proxy'
];

const SAFE_SUBDOMAIN_PREFIXES = [
    'dev-team', 'eng-ops', 'platform', 'infra-core',
    'sre-tools', 'ci-runner', 'build-svc', 'deploy-agent',
    'monitor-hub', 'test-env', 'staging-api', 'prod-relay'
];

/**
 * تابعی برای رندومایز کردن حروف دامین جهت بایپس کردن فیلترینگ SNI
 * سیستم فایروال ایران به حروف بزرگ و کوچک حساس است اما سرورهای Cloudflare حساس نیستند.
 * 
 * @param {string} domain - آدرس اصلی (مثلاً api.example.workers.dev)
 * @returns {string} - آدرس با حروف بزرگ و کوچک تصادفی
 * 
 * @example
 * generateMixedCaseSNI('app-core.example.workers.dev')
 * // => 'aPp-CoRe.ExAmPlE.wOrKeRs.DeV'
 */
function generateMixedCaseSNI(domain) {
    if (!domain || typeof domain !== 'string') return domain;
    return domain; // Temporarily disabled to avoid Cloudflare SNI strict matching issues
}

/**
 * تولید نام امن و خنثی برای Worker
 * بدون هیچ کلمه حساسی که رباتهای فیلترچی رو تحریک کنه
 * 
 * @returns {string} مثلاً 'app-core-a3f2b1'
 */
function generateSafeWorkerName() {
    const prefix = SAFE_PREFIXES[Math.floor(Math.random() * SAFE_PREFIXES.length)];
    const suffix = crypto.randomBytes(3).toString('hex'); // 6 chars
    return `${prefix}-${suffix}`;
}

/**
 * تولید ساب‌دامین امن و خنثی
 * 
 * @returns {string} مثلاً 'platform-8b4c2e'
 */
function generateSafeSubdomain() {
    const prefix = SAFE_SUBDOMAIN_PREFIXES[Math.floor(Math.random() * SAFE_SUBDOMAIN_PREFIXES.length)];
    const suffix = crypto.randomBytes(3).toString('hex');
    return `${prefix}-${suffix}`;
}

/**
 * اعمال Mixed-Case SNI روی یک URI کامل VLESS/Trojan
 * پارامترهای sni= و host= رو پیدا کرده و حروفشون رو رندومایز میکنه
 * 
 * @param {string} uri - لینک کامل (مثلاً vless://uuid@ip:port?sni=xxx&host=xxx#name)
 * @returns {string} - لینک با SNI و Host رندومایز شده
 */
function applySniCamouflage(uri) {
    if (!uri || typeof uri !== 'string') return uri;
    if (!uri.startsWith('vless://') && !uri.startsWith('trojan://')) return uri;

    try {
        // جدا کردن fragment (#name) از بقیه URI
        const hashIdx = uri.indexOf('#');
        const fragment = hashIdx !== -1 ? uri.substring(hashIdx) : '';
        const uriWithoutHash = hashIdx !== -1 ? uri.substring(0, hashIdx) : uri;

        // جدا کردن query string
        const queryIdx = uriWithoutHash.indexOf('?');
        if (queryIdx === -1) return uri; // بدون query string

        const baseUri = uriWithoutHash.substring(0, queryIdx);
        const queryString = uriWithoutHash.substring(queryIdx + 1);

        // پارس query params
        const params = new URLSearchParams(queryString);

        // Mixed-case روی sni
        const sni = params.get('sni');
        if (sni) {
            params.set('sni', generateMixedCaseSNI(sni));
        }

        // Mixed-case روی host
        const host = params.get('host');
        if (host) {
            params.set('host', generateMixedCaseSNI(host));
        }

        return `${baseUri}?${params.toString()}${fragment}`;
    } catch (e) {
        // در صورت خطا، URI اصلی رو برمیگردونیم
        return uri;
    }
}

/**
 * بررسی اینکه آیا یک نام شامل کلمات حساس هست یا نه
 * 
 * @param {string} name - نام مورد بررسی
 * @returns {boolean} true اگر شامل کلمه حساس باشد
 */
function containsBlacklistedKeyword(name) {
    if (!name) return false;
    const lowerName = name.toLowerCase();
    return BLACKLISTED_KEYWORDS.some(kw => lowerName.includes(kw));
}

/**
 * تولید نام امن برای KV Namespace
 * 
 * @returns {string} مثلاً 'app-store-data'
 */
function generateSafeKVName() {
    const names = ['app-store', 'config-db', 'cache-store', 'kv-data', 'state-db', 'settings-store'];
    const name = names[Math.floor(Math.random() * names.length)];
    const suffix = crypto.randomBytes(2).toString('hex');
    return `${name}-${suffix}`;
}

module.exports = {
    generateMixedCaseSNI,
    generateSafeWorkerName,
    generateSafeSubdomain,
    applySniCamouflage,
    containsBlacklistedKeyword,
    generateSafeKVName,
    BLACKLISTED_KEYWORDS,
    SAFE_PREFIXES,
    SAFE_SUBDOMAIN_PREFIXES
};
