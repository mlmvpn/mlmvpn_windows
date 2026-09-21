// --- GST relay store ---
// Owns `data/gst-relays.json`: the user's list of relays plus the shared tunnel settings.
// There is no cap on the relay count — Apps Script quota is per Google account, so ten
// accounts is ten times the daily budget, and the whole point of the feature is that the
// user can keep adding.
//
// Shape:
//   {
//     authKey:  "<32 chars>",          // shared by every relay — see note below
//     relays:   [ { id, name, deploymentId, cfEnabled, cfAccountId, workerUrl,
//                   workerName, cfAuthKey, priority, createdAt } ],
//     network:  { ips: [...], snis: [...] },   // user's ticked choices (tab 3)
//     runtime:  { httpPort, socksPort, systemProxy, tun, autoOptimize }
//   }
//
// WHY ONE SHARED authKey: the Rust core takes `script_ids` as a list but `auth_key` as a
// single scalar (config.rs) — every deployment is probed with the same secret. Rather than
// fork the core's wire handling, we generate one strong key and bake it into every script
// the user deploys. All the scripts belong to the same person anyway, so a per-script key
// would buy no isolation. Bonus: adding relay #2 no longer needs a password step.
//
// The Cloudflare Worker's own secret (`cfAuthKey`) IS per-relay — it is a separate hop
// (Apps Script -> Worker) and the core never sees it, so nothing forces it to be shared.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const log = require('./gst-log');

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

// WHERE RELAYS LIVE, AND WHY NOT NEXT TO THE APP.
//
// Relays are not settings — they are work the user did by hand: opening
// script.google.com, pasting a script, deploying it, copying the id back. Losing that
// costs them real minutes per relay, and a ten-relay setup is an evening.
//
// The install directory is wiped on uninstall and replaced on update, so a store under
// data/ silently loses everything on the next reinstall — while the Cloudflare accounts
// and V2RAY nodes survive, because those go through PersistentStorage into the user's
// home directory. That inconsistency is exactly what it looks like: a bug.
//
// So relays live beside that same durable data. ~/.mlmvpn is the directory server.js
// already uses for user_data.json.
const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const STORE_FILE = path.join(HOME_DIR, 'gst-relays.json');

// Previous location, kept only so an existing install can be migrated once.
const LEGACY_DIR = path.join(path.dirname(getUnpackedDir()), 'data');
const LEGACY_STORE = path.join(LEGACY_DIR, 'gst-relays.json');

// Quota counters follow the relays: they are keyed by relay id and are meaningless
// without them.
const DATA_DIR = HOME_DIR;

/**
 * Move a store left behind by an older build into the durable location.
 * Runs at most once — the legacy file is renamed, not copied, so a later reinstall
 * cannot resurrect stale relays over newer ones.
 */
function migrateLegacyStore() {
    try {
        if (fs.existsSync(STORE_FILE) || !fs.existsSync(LEGACY_STORE)) return false;

        const legacy = JSON.parse(fs.readFileSync(LEGACY_STORE, 'utf8'));
        if (!legacy || !Array.isArray(legacy.relays)) return false;

        fs.mkdirSync(HOME_DIR, { recursive: true });
        fs.writeFileSync(STORE_FILE, JSON.stringify(legacy, null, 2), 'utf8');
        try { fs.renameSync(LEGACY_STORE, LEGACY_STORE + '.migrated'); } catch (e) { /* best effort */ }

        log.info('config', `تنظیمات از محل قدیمی منتقل شد (${legacy.relays.length} ریلی) — ` +
            'از این پس با حذف یا به‌روزرسانی برنامه پاک نمی‌شود.');
        return true;
    } catch (e) {
        log.warn('config', `انتقال تنظیمات قدیمی ناموفق بود: ${e.message}`);
        return false;
    }
}

migrateLegacyStore();

// Defaults mirror the Android app's GstConfigManager lists so a user who has both
// installed sees the same options with the same Persian hints.
const DEFAULT_SNIS = [
    'www.google.com',
    'youtubei.googleapis.com',
    'googlevideo.com',
    'mtalk.google.com',
    'www.youtube.com',
    'play.google.com',
    'drive.google.com',
];

// Seeded from the Rust core's static fallback list. The network tab replaces these with
// real scan results on first run; these only exist so a fresh install is never empty.
const DEFAULT_IPS = [
    '216.239.38.120',
    '142.250.190.238',
    '172.217.22.174',
];

const DEFAULTS = {
    authKey: '',
    relays: [],
    network: {
        // What the user ticked.
        ips: DEFAULT_IPS.slice(),
        snis: DEFAULT_SNIS.slice(),
        // Last measurement for each candidate: [{ ip|sni, latency, ok, grade, status }].
        // Persisted because the panel's list is BUILT from these — keeping them only in
        // memory meant every restart (and every reinstall) dropped the user back to a
        // list containing nothing but their ticks, which reads as "the list is empty".
        ipResults: [],
        sniResults: [],
        scannedAt: 0,
    },
    runtime: {
        httpPort: 8085,
        socksPort: 8086,
        systemProxy: false,
        tun: false,
        autoOptimize: true,
    },
};

/**
 * A 32-char key from the crypto RNG, restricted to an alphabet with no look-alike
 * characters. The user reads this off the screen and pastes it into the Apps Script
 * editor, so `0/O` and `1/l/I` confusion would produce a 401 that looks like a bug.
 */
function generateAuthKey() {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.randomBytes(32);
    let out = '';
    for (let i = 0; i < 32; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
}

function load() {
    let stored = {};
    try {
        stored = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    } catch (e) {
        // Missing file on first run is expected; a corrupt one is not, and silently
        // resetting would throw away the user's relays. Say so in the core log.
        if (e.code !== 'ENOENT') {
            log.warn('config', `فایل تنظیمات خوانده نشد (${e.message}) — از مقادیر پیش‌فرض استفاده شد`);
        }
    }

    const cfg = {
        ...DEFAULTS,
        ...stored,
        network: { ...DEFAULTS.network, ...(stored.network || {}) },
        runtime: { ...DEFAULTS.runtime, ...(stored.runtime || {}) },
        relays: Array.isArray(stored.relays) ? stored.relays : [],
    };

    // Generate the shared key on first use rather than at install time, so a user who
    // never opens the panel never has a secret sitting on disk.
    if (!cfg.authKey) {
        cfg.authKey = generateAuthKey();
        save(cfg);
        log.info('config', `رمز مشترک ریلی‌ها ساخته شد: ${log.redact(cfg.authKey)}`);
    }
    return cfg;
}

function save(cfg) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename so a crash mid-write cannot leave a truncated file that would
    // lose every relay the user has built up.
    const tmp = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    return cfg;
}

function update(patch) {
    return save({ ...load(), ...patch });
}

// ── Relays ────────────────────────────────────────────────────────────────────

function getRelays() {
    return load().relays
        .slice()
        .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

/** Relays the core can actually dial: a deployment id is the minimum. */
function getUsableRelays() {
    return getRelays().filter(r => r.deploymentId && String(r.deploymentId).trim());
}

function getRelay(id) {
    return getRelays().find(r => r.id === id) || null;
}

function addRelay(fields = {}) {
    const cfg = load();
    const relay = {
        id: crypto.randomUUID(),
        name: fields.name || `ریلی ${cfg.relays.length + 1}`,
        deploymentId: (fields.deploymentId || '').trim(),
        // Cloudflare leg — optional and independent per relay.
        cfEnabled: !!fields.cfEnabled,
        cfAccountId: fields.cfAccountId || '',
        workerUrl: fields.workerUrl || '',
        workerName: fields.workerName || '',
        cfAuthKey: fields.cfAuthKey || generateAuthKey(),
        priority: cfg.relays.length,
        createdAt: Date.now(),
    };
    cfg.relays.push(relay);
    save(cfg);
    log.ok('config', `ریلی «${relay.name}» اضافه شد` +
        (relay.cfEnabled ? ' (با کلادفلر)' : ' (بدون کلادفلر)'));
    return relay;
}

function updateRelay(id, patch = {}) {
    const cfg = load();
    const idx = cfg.relays.findIndex(r => r.id === id);
    if (idx === -1) return null;

    // id and createdAt are identity, not settings — a caller passing them by accident
    // (e.g. echoing a whole relay object back) must not be able to rewrite them.
    const { id: _ignored, createdAt: _ignored2, ...safe } = patch;
    cfg.relays[idx] = { ...cfg.relays[idx], ...safe };
    save(cfg);
    return cfg.relays[idx];
}

function removeRelay(id) {
    const cfg = load();
    const relay = cfg.relays.find(r => r.id === id);
    if (!relay) return false;

    cfg.relays = cfg.relays.filter(r => r.id !== id);
    cfg.relays.forEach((r, i) => { r.priority = i; });   // keep priorities dense
    save(cfg);
    log.info('config', `ریلی «${relay.name}» حذف شد`);
    return true;
}

/** Reorder by an explicit id list; ids not mentioned keep their relative order at the end. */
function reorderRelays(orderedIds) {
    const cfg = load();
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    cfg.relays.sort((a, b) =>
        (rank.has(a.id) ? rank.get(a.id) : Infinity) -
        (rank.has(b.id) ? rank.get(b.id) : Infinity));
    cfg.relays.forEach((r, i) => { r.priority = i; });
    save(cfg);
    return getRelays();
}

/**
 * Per-relay Cloudflare switch — the feature the reference projects don't have.
 * Turning it on requires a deployed Worker; without one the script has nowhere to
 * forward and every request through this relay would fail.
 */
function setCloudflare(id, enabled) {
    const relay = getRelay(id);
    if (!relay) return null;
    if (enabled && !relay.workerUrl) {
        throw new Error('برای این ریلی هنوز Worker ساخته نشده است.');
    }
    const updated = updateRelay(id, { cfEnabled: !!enabled });
    log.info('config', `کلادفلر ریلی «${relay.name}» ${enabled ? 'روشن' : 'خاموش'} شد`);
    return updated;
}

// ── Network path (tab 3) ──────────────────────────────────────────────────────

function getNetwork() {
    const cfg = load();

    // Clean on READ as well as on write: a store written by an earlier build (or by a
    // user experimenting in the manual-add box) can already contain junk, and this is
    // the value the engine's config is generated from.
    const before = (cfg.network.ips || []).length + (cfg.network.snis || []).length;
    const net = sanitizeNetwork({ ...cfg.network });
    const after = net.ips.length + net.snis.length;

    // Fall back to the defaults rather than handing the engine an empty list, and
    // persist the repair so it happens once instead of on every read.
    if (!net.ips.length) net.ips = DEFAULT_IPS.slice();
    if (!net.snis.length) net.snis = DEFAULT_SNIS.slice();
    if (after !== before) {
        cfg.network = net;
        save(cfg);
    }
    return net;
}

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Drop entries that cannot work.
 *
 * These values are written straight into the engine's config: ips[0] becomes google_ip,
 * snis[0] becomes front_domain. A malformed one does not raise an error — it produces a
 * tunnel that silently never connects. The panel validates too, but this is the layer
 * that actually feeds the engine, so it does not take the panel's word for it.
 */
function sanitizeNetwork(net) {
    const cleanIps = (net.ips || []).filter(v => IPV4_RE.test(String(v).trim()));
    const cleanSnis = (net.snis || []).filter(v => HOSTNAME_RE.test(String(v).trim()));

    const droppedIps = (net.ips || []).length - cleanIps.length;
    const droppedSnis = (net.snis || []).length - cleanSnis.length;
    if (droppedIps || droppedSnis) {
        log.warn('config', `${droppedIps + droppedSnis} مورد نامعتبر از مسیر شبکه حذف شد ` +
            '(آی‌پی یا دامنه‌ی بی‌اعتبار، تونل را از کار می‌انداخت)');
    }

    net.ips = cleanIps;
    net.snis = cleanSnis;
    return net;
}

function setNetwork(patch = {}) {
    const cfg = load();
    cfg.network = sanitizeNetwork({ ...cfg.network, ...patch });

    // An empty SELECTION would make the core fall back to its own defaults silently,
    // which looks like "my choices were ignored". Refuse instead.
    // The *Results arrays are measurements, not choices — an empty one is a legitimate
    // "nothing answered", so they are deliberately not defaulted here.
    if (!cfg.network.ips || !cfg.network.ips.length) cfg.network.ips = DEFAULT_IPS.slice();
    if (!cfg.network.snis || !cfg.network.snis.length) cfg.network.snis = DEFAULT_SNIS.slice();

    save(cfg);
    return cfg.network;
}

// ── Runtime (ports / proxy / tun) ─────────────────────────────────────────────

function getRuntime() {
    return load().runtime;
}

function setRuntime(patch = {}) {
    const cfg = load();
    cfg.runtime = { ...cfg.runtime, ...patch };
    save(cfg);
    return cfg.runtime;
}

module.exports = {
    STORE_FILE,
    DEFAULT_SNIS,
    DEFAULT_IPS,
    generateAuthKey,
    load,
    save,
    update,
    getRelays,
    getUsableRelays,
    getRelay,
    addRelay,
    updateRelay,
    removeRelay,
    reorderRelays,
    setCloudflare,
    getNetwork,
    setNetwork,
    getRuntime,
    setRuntime,
};
