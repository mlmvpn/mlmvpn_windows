// --- Domain fronting with no server: the MITM-DomainFronting profile, as on Android ---
//
// @patterniha's MITM-DomainFronting config reaches YouTube, Instagram, WhatsApp, Facebook,
// Reddit and other Google / Meta / Fastly-hosted sites directly — no relay anywhere in the
// path. Two local `tunnel` inbounds terminate TLS with a certificate this machine mints, read
// the real destination, and re-open the connection under a different, unblocked name. The
// config ships untouched (core/mitm/, byte for byte the Android asset); the one per-machine
// part is that certificate.
//
// MINTED HERE, NEVER SHIPPED. Its private key can read every TLS session of any machine that
// trusts it. One key inside the installer would let every user read every other user's bank
// and mail — upstream warns about exactly that. So each install makes its own, it stays in
// ~/.mlmvpn/mitm, and nothing ever sends it anywhere.
//
// MADE BY XRAY (`xray tls cert -ca`), so the files are in the format the same core reads back.
// Android assembles the DER by hand to get there; here the core does it.
//
// TRUST IS THE USER'S TO GIVE. The certificate goes into the CURRENT USER's Root store through
// certutil, and Windows itself asks "Do you want to install this certificate?". Nothing is
// ever installed machine-wide or silently, even though this process is elevated and could.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const DIR = path.join(os.homedir(), '.mlmvpn', 'mitm');
const BASE = path.join(DIR, 'mlmvpn_mitm');
const CERT = BASE + '.crt';
const KEY = BASE + '.key';
const META = path.join(DIR, 'meta.json');
const VALID_HOURS = 20 * 365 * 24;
const CERT_PLACEHOLDER = '__MLM_CERT_PATH__';
const KEY_PLACEHOLDER = '__MLM_KEY_PATH__';

function unpackedDir() {
    return __dirname.toLowerCase().includes('.asar') ? __dirname.replace(/\.asar/gi, '.asar.unpacked') : __dirname;
}
const xrayExe = () => require('./core-paths').file('xray', 'xray.exe', path.join(unpackedDir(), 'core', 'xray.exe'));
/**
 * The config to run: the store's copy when one is installed, else the one that shipped.
 *
 * The store can install a newer copy of @patterniha's file (store/mitm-config.js) — already with
 * this machine's certificate placeholders in it, already accepted by xray. Asking the store each
 * time rather than remembering means a rollback there takes effect here at the next connect.
 */
const assetPath = () => {
    try {
        const f = require('./store-manager').mitmConfigFile();
        if (f && fs.existsSync(f)) return f;
    } catch (e) { /* the store is not loaded: the app's own copy it is */ }
    return path.join(unpackedDir(), 'core', 'mitm', 'mitm_domainfronting_v23.json');
};

function run(exe, args, timeout = 60000) {
    return new Promise((resolve) => {
        execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') + String(stderr || '') });
        });
    });
}

function ps(command, timeout = 20000) {
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], timeout);
}

function exists() {
    try { return fs.statSync(CERT).size > 0 && fs.statSync(KEY).size > 0; } catch (e) { return false; }
}

function readMeta() {
    try { return JSON.parse(fs.readFileSync(META, 'utf8')); } catch (e) { return {}; }
}

/** What the user needs to recognise the entry in Windows' certificate list, or null. */
function certInfo() {
    if (!exists()) return null;
    try {
        const c = new crypto.X509Certificate(fs.readFileSync(CERT));
        const meta = readMeta();
        const cn = meta.cn || ((c.subject.match(/CN=([^\n]+)/) || [])[1] || '');
        return {
            cn,
            createdAt: meta.createdAt || null,
            validTo: c.validTo,
            sha256: c.fingerprint256,
            thumbprint: c.fingerprint.replace(/:/g, '').toUpperCase(),
        };
    } catch (e) {
        return null;
    }
}

/** Mint the pair if it is missing. Never overwrites one that exists. */
async function ensure() {
    if (exists()) return certInfo();
    fs.mkdirSync(DIR, { recursive: true });
    // A short random suffix, so two machines never produce identical entries and a second
    // certificate can be told apart from the first in Windows' list.
    const cn = 'MLM VPN Local CA ' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const r = await run(xrayExe(), ['tls', 'cert', '-ca', `-name=${cn}`, '-org=MLM VPN', `-expire=${VALID_HOURS}h`, `-file=${BASE}`]);
    if (!exists()) throw new Error('ساخت گواهی ناموفق بود' + (r.out ? ': ' + r.out.trim().split('\n').pop() : '.'));
    fs.writeFileSync(META, JSON.stringify({ cn, createdAt: Date.now() }));
    return certInfo();
}

/** Does Windows trust this certificate right now? Asked live, never remembered. */
async function isTrusted(info = certInfo()) {
    if (!info) return false;
    // The current user's Root store as PowerShell sees it includes the machine's, so one
    // lookup covers a certificate installed either way. (certutil's exit codes for -store
    // are not usable here: a missing thumbprint returns 0.)
    const r = await ps(`Test-Path 'Cert:\\CurrentUser\\Root\\${info.thumbprint}'`);
    return /True/i.test(r.out);
}

/**
 * Put the certificate in the current user's Root store. Windows shows its own confirmation
 * dialog and this waits for the answer; declining it is a normal outcome, not an error.
 */
async function trust() {
    const info = await ensure();
    if (await isTrusted(info)) return { trusted: true };
    await run('certutil.exe', ['-user', '-addstore', 'Root', CERT], 10 * 60 * 1000);
    const trusted = await isTrusted(info);
    return { trusted, declined: !trusted };
}

/** Take it back out of Windows (the user's store asks again; the machine's, if it is there, does not). */
async function untrust() {
    const info = certInfo();
    if (!info) return { trusted: false };
    const inMachine = /True/i.test((await ps(`Test-Path 'Cert:\\LocalMachine\\Root\\${info.thumbprint}'`)).out);
    await run('certutil.exe', ['-user', '-delstore', 'Root', info.thumbprint], 10 * 60 * 1000);
    if (inMachine) await run('certutil.exe', ['-delstore', 'Root', info.thumbprint], 60000);
    return { trusted: await isTrusted(info) };
}

/** Remove it from Windows first, then delete the files, so a trusted orphan can never be left behind. */
async function remove() {
    if (await isTrusted()) {
        const r = await untrust();
        if (r.trusted) return { removed: false, trusted: true };
    }
    for (const f of [CERT, KEY, META]) { try { fs.unlinkSync(f); } catch (e) { /* already gone */ } }
    return { removed: true, trusted: false };
}

/**
 * The runnable config: the shipped file with the two certificate placeholders set to this
 * machine's files. Set on the parsed object rather than by text replacement — a Windows path
 * is full of backslashes, which a raw substitution would turn into invalid JSON escapes.
 */
function buildConfig() {
    if (!exists()) return null;
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(assetPath(), 'utf8')); } catch (e) { return null; }
    for (const ib of cfg.inbounds || []) {
        const certs = ib && ib.streamSettings && ib.streamSettings.tlsSettings && ib.streamSettings.tlsSettings.certificates;
        for (const c of certs || []) {
            if (c.certificateFile === CERT_PLACEHOLDER) c.certificateFile = CERT;
            if (c.keyFile === KEY_PLACEHOLDER) c.keyFile = KEY;
        }
    }
    const out = JSON.stringify(cfg);
    return out.includes(CERT_PLACEHOLDER) || out.includes(KEY_PLACEHOLDER) ? null : out;
}

async function status() {
    const info = certInfo();
    const trusted = info ? await isTrusted(info) : false;
    return {
        exists: !!info,
        cert: info,
        trusted,
        // Only once it can actually carry anything: an untrusted certificate makes every
        // fronted site fail with a certificate error in the browser.
        config: info && trusted ? buildConfig() : null,
    };
}

module.exports = { status, ensure, trust, untrust, remove, buildConfig, isTrusted, certInfo, DIR, CERT, KEY };
