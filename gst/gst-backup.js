// --- GST backup / restore / sharing ---
// Packs the user's relays into a single `gst://` link they can save or hand to someone
// else, and unpacks it on the other side.
//
// WHY THIS IS ENCRYPTED, NOT JUST ENCODED
// The payload contains Apps Script deployment IDs, the shared relay key, Worker URLs and
// their secrets. Anyone holding it can send traffic through the owner's Google account
// and their Cloudflare Worker — spending their quota and, on the Google side, doing so
// from an account tied to their real identity. A base64 blob in a Telegram message is
// readable by anyone who ever sees that message. So: AES-256-GCM with a key derived from
// a passphrase via scrypt, and the passphrase travels separately.
//
// WHAT IS DELIBERATELY LEFT OUT
// Cloudflare account credentials (Global API Key + email) are never included. They are
// not needed to USE a relay — only to deploy a new Worker — and a Global API Key grants
// full control of the account, including DNS for every domain on it. Exporting that
// inside a shareable link would turn "share my tunnel" into "share my Cloudflare
// account". The importer gets the Worker URL and its own secret, which is exactly enough
// to route traffic and nothing more.

const crypto = require('crypto');
const store = require('./gst-config');
const log = require('./gst-log');

const SCHEME = 'gst://';
const VERSION = 1;

// scrypt parameters. N=2^15 costs ~100ms on a normal desktop — slow enough to make
// guessing a short passphrase expensive, fast enough that the user does not notice.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };

// Word list for generated passphrases. Short, unambiguous, easy to read aloud or retype
// from a screenshot — which is how these actually get shared.
const WORDS = [
    'ahan', 'abi', 'aram', 'baran', 'bahar', 'barf', 'chai', 'darya', 'derakht', 'gol',
    'ghale', 'hava', 'jangal', 'kuh', 'khak', 'mah', 'mehr', 'nur', 'paiz', 'parvaz',
    'roshan', 'sabz', 'sahra', 'setare', 'shab', 'shahr', 'talā', 'tabestan', 'zard',
    'zamin', 'abr', 'bad', 'moj', 'sang', 'shen', 'toofan',
];

/** A 4-word passphrase: ~20 bits per word from a 36-word list is weak, so add digits. */
function generatePassphrase() {
    const pick = () => WORDS[crypto.randomInt(WORDS.length)];
    const digits = String(crypto.randomInt(1000, 10000));
    return `${pick()}-${pick()}-${pick()}-${digits}`;
}

function deriveKey(passphrase, salt) {
    return crypto.scryptSync(String(passphrase), salt, SCRYPT.keylen, {
        N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
        // Node's default maxmem (32 MB) is below what N=32768 needs, and the failure is
        // an opaque "memory limit exceeded" rather than anything about scrypt.
        maxmem: 128 * 1024 * 1024,
    });
}

/**
 * Build the shareable payload.
 * Only the fields a relay needs in order to carry traffic — see the note above about
 * what is left out and why.
 */
function buildPayload({ includeNetwork = true } = {}) {
    const cfg = store.load();
    const relays = cfg.relays
        .filter(r => r.deploymentId)
        .map(r => ({
            name: r.name,
            deploymentId: r.deploymentId,
            cfEnabled: !!r.cfEnabled,
            workerUrl: r.workerUrl || '',
            cfAuthKey: r.cfAuthKey || '',
            // cfAccountId is a LOCAL record id on the exporting machine. It means nothing
            // on the importing one, so it is dropped rather than carried across as a
            // dangling reference that later looks like a corrupt relay.
        }));

    if (!relays.length) {
        throw new Error('هیچ ریلی کاملی برای پشتیبان‌گیری وجود ندارد.');
    }

    return {
        v: VERSION,
        at: Date.now(),
        authKey: cfg.authKey,
        relays,
        network: includeNetwork ? cfg.network : undefined,
    };
}

/**
 * Encrypt a payload into a `gst://` link.
 * Layout after the scheme: base64url( salt(16) | iv(12) | tag(16) | ciphertext )
 */
function pack(payload, passphrase) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(passphrase, salt);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([
        cipher.update(JSON.stringify(payload), 'utf8'),
        cipher.final(),
    ]);
    const blob = Buffer.concat([salt, iv, cipher.getAuthTag(), body]);
    return SCHEME + blob.toString('base64url');
}

function unpack(link, passphrase) {
    const raw = String(link || '').trim().replace(/^gst:\/\//i, '');
    if (!raw) throw new Error('لینک خالی است.');

    let blob;
    try {
        blob = Buffer.from(raw, 'base64url');
    } catch (e) {
        throw new Error('لینک معتبر نیست.');
    }
    // 16 salt + 12 iv + 16 tag = 44 bytes of envelope before any ciphertext.
    if (blob.length < 60) throw new Error('لینک ناقص است — احتمالاً کامل کپی نشده.');

    const salt = blob.subarray(0, 16);
    const iv = blob.subarray(16, 28);
    const tag = blob.subarray(28, 44);
    const body = blob.subarray(44);

    let json;
    try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
        decipher.setAuthTag(tag);
        json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch (e) {
        // GCM authentication failing is indistinguishable from a wrong passphrase, and
        // for the user it almost always IS a wrong passphrase.
        throw new Error('رمز اشتباه است یا لینک خراب شده.');
    }

    let payload;
    try {
        payload = JSON.parse(json);
    } catch (e) {
        throw new Error('محتوای لینک قابل خواندن نیست.');
    }

    if (!payload || payload.v > VERSION) {
        throw new Error('این لینک با نسخه‌ی جدیدتری از برنامه ساخته شده — برنامه را به‌روزرسانی کنید.');
    }
    if (!Array.isArray(payload.relays) || !payload.relays.length) {
        throw new Error('این لینک هیچ ریلی‌ای ندارد.');
    }
    return payload;
}

/** Export everything into a link plus the passphrase needed to open it. */
function exportLink({ passphrase, includeNetwork = true } = {}) {
    const pass = passphrase || generatePassphrase();
    const payload = buildPayload({ includeNetwork });
    const link = pack(payload, pass);

    log.ok('backup', `پشتیبان ساخته شد: ${payload.relays.length} ریلی`);
    return {
        link,
        passphrase: pass,
        generated: !passphrase,
        relayCount: payload.relays.length,
        // Repeated in the UI, but stated here so any caller carries the warning.
        warning: 'لینک و رمز را از دو راه جداگانه بفرستید. هر کسی که هر دو را داشته باشد ' +
                 'می‌تواند از سهمیه‌ی حساب گوگل شما استفاده کند.',
    };
}

/**
 * Read a link without applying it, so the panel can show what will happen before the
 * user commits. Importing blind is how someone loses a working setup to a stale backup.
 */
function preview(link, passphrase) {
    const payload = unpack(link, passphrase);
    return {
        version: payload.v,
        createdAt: payload.at,
        relayCount: payload.relays.length,
        relays: payload.relays.map(r => ({
            name: r.name,
            cloudflare: !!r.cfEnabled,
            // Never echo a deployment id or secret back to the screen.
            deployment: `${String(r.deploymentId).slice(0, 6)}…`,
        })),
        hasNetwork: !!payload.network,
    };
}

/**
 * Apply a link.
 *
 * @param mode 'merge'   keep existing relays, add the new ones (default)
 *             'replace' drop existing relays first
 *
 * Merge is the default because the destructive option should never be the one that
 * happens when a user clicks through a dialog quickly.
 */
function importLink(link, passphrase, { mode = 'merge' } = {}) {
    const payload = unpack(link, passphrase);
    const cfg = store.load();

    const before = cfg.relays.length;
    if (mode === 'replace') {
        cfg.relays = [];
        log.warn('backup', `حالت جایگزینی: ${before} ریلی قبلی حذف شد`);
    }

    // The relay key is shared across every relay, and the imported deployments were
    // built with the exporter's key — so it has to come along or none of them
    // authenticate. This DOES rewrite the local key, which would break any relay this
    // machine already had, so a merge into a non-empty set is refused below.
    if (mode === 'merge' && cfg.relays.some(r => r.deploymentId) && payload.authKey !== cfg.authKey) {
        throw new Error(
            'این پشتیبان رمز ریلی متفاوتی دارد و ادغام آن، ریلی‌های فعلی شما را از کار می‌اندازد. ' +
            'اگر می‌خواهید ادامه دهید، گزینه‌ی «جایگزینی کامل» را انتخاب کنید.');
    }
    cfg.authKey = payload.authKey;

    const existing = new Set(cfg.relays.map(r => r.deploymentId));
    let added = 0;
    let skipped = 0;

    for (const r of payload.relays) {
        if (existing.has(r.deploymentId)) { skipped++; continue; }
        cfg.relays.push({
            id: crypto.randomUUID(),
            name: r.name || `ریلی ${cfg.relays.length + 1}`,
            deploymentId: r.deploymentId,
            cfEnabled: !!r.cfEnabled && !!r.workerUrl,
            cfAccountId: '',          // deliberately not carried across
            workerUrl: r.workerUrl || '',
            workerName: '',
            cfAuthKey: r.cfAuthKey || '',
            priority: cfg.relays.length,
            createdAt: Date.now(),
        });
        added++;
    }

    if (payload.network) cfg.network = { ...cfg.network, ...payload.network };
    store.save(cfg);

    log.ok('backup', `بازیابی انجام شد: ${added} ریلی اضافه شد` +
        (skipped ? `، ${skipped} مورد تکراری رد شد` : ''));

    return {
        added,
        skipped,
        total: cfg.relays.length,
        mode,
        // Imported relays cannot deploy a NEW Worker until the user adds the Cloudflare
        // account on this machine — worth saying plainly rather than letting them find
        // out when a repair button fails.
        note: payload.relays.some(r => r.workerUrl)
            ? 'ریلی‌های وارد شده از Worker موجود استفاده می‌کنند. برای ساخت Worker جدید روی این کامپیوتر، ' +
              'باید حساب کلادفلر را در پنل «استقرار خودکار ابری» اضافه کنید.'
            : '',
    };
}

module.exports = { exportLink, importLink, preview, generatePassphrase, pack, unpack, SCHEME };
