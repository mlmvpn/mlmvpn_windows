// --- GitHub Tunnel: the per-install signing secret ---
//
// One random 256-bit value, generated on first use and kept in ~/.mlmvpn. It is what
// proves to the broker Worker that a /mint request came from THIS installation and not
// from whoever else found the Worker's URL.
//
// It lives in its own module because both sides of that handshake need it and they cannot
// require each other: gt-broker.js signs requests with it, and gt-broker-deploy.js has to
// hand it to the Worker as an encrypted binding at upload time so the Worker can verify.
// Importing one from the other would close a require cycle.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME_DIR = path.join(os.homedir(), '.mlmvpn');
const SECRET_FILE = path.join(HOME_DIR, 'github-tunnel-broker.json');

let cached = null;

/**
 * The install's signing secret, creating it if this is the first call.
 *
 * Written through a temp file and rename: a half-written secret is worse than no secret,
 * because the Worker was deployed with the whole one and every later request would fail
 * signature verification with no obvious cause.
 */
function getInstallSecret() {
    // The cache is only trusted while the FILE still backs it.
    //
    // "Reset all GitHub Tunnel settings" deletes this file (gt-config.js), but the deletion
    // happens inside the running app — and this module kept handing out the deleted secret
    // for the rest of the process's life. Whether that ends up mattering depends on which
    // side re-reads first: the Worker is uploaded with whatever getInstallSecret() returns,
    // and the signing path uses the same value, so they agree until the app restarts. After a
    // restart the file is regenerated and the deployed Worker is still carrying the old
    // secret, and every /mint fails BAD_SIG with a message telling the user to redeploy —
    // which is the only thing that actually fixes it, but nothing explains why.
    //
    // Dropping the cache when the file is gone makes reset mean what it says: the next call
    // mints a fresh secret, and the deploy that follows carries that same one.
    if (cached && fs.existsSync(SECRET_FILE)) return cached;
    cached = null;
    try {
        const s = JSON.parse(fs.readFileSync(SECRET_FILE, 'utf8'));
        if (s && typeof s.secret === 'string' && s.secret.length >= 32) {
            cached = s.secret;
            return cached;
        }
    } catch (e) {}

    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(HOME_DIR, { recursive: true });
    const tmp = `${SECRET_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ secret }, null, 2), 'utf8');
    fs.renameSync(tmp, SECRET_FILE);
    cached = secret;
    return secret;
}

/** The exact string the Worker recomputes. Keep the two in step. */
function sign(sessionId, ts) {
    return crypto.createHmac('sha256', getInstallSecret()).update(`${sessionId}.${ts}`).digest('hex');
}

module.exports = { getInstallSecret, sign, SECRET_FILE };
