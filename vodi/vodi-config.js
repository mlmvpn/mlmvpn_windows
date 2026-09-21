// --- VodiWalker gateway store ---
// Owns `~/.mlmvpn/vodi-gateways.json`: the user's list of panel servers deployed to their
// own Railway account by the «کانفیگ آیپی ثابت» feature.
//
// WHY THE HOME DIR (not next to the app): a gateway is real, slow, money-costing work the
// user did — a Railway project that takes minutes to spin up and holds their configs and
// users. The install dir is wiped on uninstall/update, so a store under data/ would throw
// that away. Cloudflare accounts and V2RAY nodes already live in ~/.mlmvpn for exactly
// this reason (see gst-config.js), so gateways go there too.
//
// Shape of one gateway:
//   { id, name, region, adminUsername, adminPassword, secretKey,
//     railwayProjectId, railwayServiceId, railwayEnvId, railwayVolumeId,
//     domain, source, createdAt }

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STORE_FILE = path.join(HOME_DIR, 'vodi-gateways.json');
// The store this feature used before it moved to the VodiWalker panel. Its rows describe
// Railway projects that are still deployed and still costing the user money, so they are
// carried over rather than abandoned: otherwise the only way left to delete them would be
// Railway's own dashboard. The servers themselves are untouched — see loginGateway() in
// the deployer, which accepts either panel's session cookie.
const LEGACY_STORE_FILE = path.join(HOME_DIR, 'x4g-gateways.json');

function readFile(file) {
    try {
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(stored.gateways) ? stored.gateways : [];
    } catch (e) {
        if (e.code !== 'ENOENT') {
            console.warn(`[vodi] فایل gateways خوانده نشد (${e.message}) — از خالی شروع شد`);
        }
        return [];
    }
}

// One-time carry-over of the old store. Renaming the file rather than copying it means
// this runs once and cannot later resurrect a gateway the user deleted here.
function migrateLegacy() {
    if (fs.existsSync(STORE_FILE) || !fs.existsSync(LEGACY_STORE_FILE)) return [];
    const rows = readFile(LEGACY_STORE_FILE);
    try {
        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.writeFileSync(STORE_FILE, JSON.stringify({ gateways: rows }, null, 2), 'utf8');
        fs.renameSync(LEGACY_STORE_FILE, `${LEGACY_STORE_FILE}.migrated`);
        if (rows.length) console.log(`[vodi] ${rows.length} سرور از فهرست قبلی منتقل شد`);
    } catch (e) {
        console.warn(`[vodi] انتقال فهرست قبلی ناموفق بود (${e.message})`);
    }
    return rows;
}

function load() {
    if (!fs.existsSync(STORE_FILE)) migrateLegacy();
    return { gateways: readFile(STORE_FILE) };
}

function save(cfg) {
    fs.mkdirSync(HOME_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the file and lose gateways.
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    return cfg;
}

// A 40-char URL-safe secret. Used for the panel's SECRET_KEY (fixes the password hash +
// the deterministic default-link UUID across Railway restarts) — the user never types it.
// Setting it explicitly matters: left unset, the panel generates one and writes it to the
// volume, so a lost volume would silently invalidate every session and link.
function generateSecret(len = 40) {
    return crypto.randomBytes(len).toString('base64url').slice(0, len);
}

// The panel's own default admin name. Kept in the store (not hard-coded at the call site)
// because the user can change it inside the panel afterwards, and the app then has to log
// in with whatever it became.
const DEFAULT_ADMIN_USERNAME = 'admin';

// Admin password shown to the user (they may keep or change it). No look-alike chars,
// since a person reads and may retype it.
function generatePassword(len = 14) {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(len);
    let out = '';
    for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
}

function getGateways() {
    return load().gateways.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function getGateway(id) {
    return load().gateways.find(g => g.id === id) || null;
}

function addGateway(fields = {}) {
    const cfg = load();
    const gw = {
        id: crypto.randomUUID(),
        name: fields.name || `سرور ${cfg.gateways.length + 1}`,
        region: fields.region || '',
        adminUsername: fields.adminUsername || DEFAULT_ADMIN_USERNAME,
        adminPassword: fields.adminPassword || generatePassword(),
        secretKey: fields.secretKey || generateSecret(),
        railwayProjectId: fields.railwayProjectId || '',
        railwayServiceId: fields.railwayServiceId || '',
        railwayEnvId: fields.railwayEnvId || '',
        railwayVolumeId: fields.railwayVolumeId || '',
        railwayAccountId: fields.railwayAccountId || '',
        domain: fields.domain || '',
        source: fields.source || '',
        createdAt: Date.now(),
    };
    cfg.gateways.push(gw);
    save(cfg);
    return gw;
}

function updateGateway(id, patch = {}) {
    const cfg = load();
    const idx = cfg.gateways.findIndex(g => g.id === id);
    if (idx === -1) return null;
    // id and createdAt are identity, not settings.
    const { id: _i, createdAt: _c, ...safe } = patch;
    cfg.gateways[idx] = { ...cfg.gateways[idx], ...safe };
    save(cfg);
    return cfg.gateways[idx];
}

function removeGateway(id) {
    const cfg = load();
    const before = cfg.gateways.length;
    cfg.gateways = cfg.gateways.filter(g => g.id !== id);
    if (cfg.gateways.length === before) return false;
    save(cfg);
    return true;
}

module.exports = {
    load, save,
    generateSecret, generatePassword,
    getGateways, getGateway, addGateway, updateGateway, removeGateway,
    STORE_FILE, DEFAULT_ADMIN_USERNAME,
};
