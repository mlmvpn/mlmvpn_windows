#!/usr/bin/env node
/*
 * «ام‌ال‌ام استور» — the maintainer's tool for the signed update channel.
 *
 * The app trusts exactly two things (store/trust.js): a digest written into its own code, and a
 * manifest signed with the key whose public half is in that code. This builds and publishes the
 * second one, so a new engine version can reach users without shipping a new build of the app —
 * and so that GitHub, the mirrors and the network in between cannot change what they get.
 *
 *   node scripts/store-channel.js keygen            make a signing key (once; keep it safe)
 *   node scripts/store-channel.js build             read store/channel.spec.json → dist/store-channel.json
 *   node scripts/store-channel.js verify            open the built file exactly as the app does
 *   node scripts/store-channel.js publish           upload it (and any local artifacts) with `gh`
 *   node scripts/store-channel.js status            what is pinned where, at a glance
 *
 * THE PRIVATE KEY LIVES OUTSIDE THIS REPO — %USERPROFILE%\.mlmvpn-dev\store-signing\<kid>.pem.
 * Losing it means no new channel file can ever be signed for builds already in the wild: the only
 * way back is a new app release carrying a new public key. Back it up.
 *
 * WHERE ARTIFACTS COME FROM, per entry in the spec:
 *   { github: { repo, tag, asset } }  the digest GitHub itself computed at upload, read off the
 *                                     release page (no API, no rate limit)
 *   { url }                           downloaded here and hashed here
 *   { file, upload: true }            a binary built on this machine (the cores upstream does not
 *                                     publish for Windows); hashed here and uploaded to our release
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const trust = require(path.join(ROOT, 'store', 'trust.js'));
const github = require(path.join(ROOT, 'store', 'github.js'));
const netio = require(path.join(ROOT, 'store', 'net.js'));

const KID = process.env.MLM_STORE_KID || 'mlm-store-2026-1';
const KEY_FILE = path.join(os.homedir(), '.mlmvpn-dev', 'store-signing', KID + '.pem');
const SPEC = path.join(ROOT, 'store', 'channel.spec.json');
const OUT_DIR = path.join(ROOT, 'dist', 'store-channel');
const OUT = path.join(OUT_DIR, 'store-channel.json');
const REPO = process.env.MLM_STORE_REPO || 'mlmvpn/mlmvpn_windows';
const TAG = process.env.MLM_STORE_TAG || 'store-channel';

const say = (...a) => console.log(...a);

function sha256(file) {
    const h = crypto.createHash('sha256');
    h.update(fs.readFileSync(file));
    return h.digest('hex');
}

function gh(args, opts = {}) {
    return execFileSync('gh', args, Object.assign({ encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }, opts));
}

// ── keygen ───────────────────────────────────────────────────────────────────

function keygen() {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    if (fs.existsSync(KEY_FILE)) {
        say('key already exists:', KEY_FILE);
    } else {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        fs.writeFileSync(KEY_FILE, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
        say('written', KEY_FILE);
    }
    say('public key for store/trust.js TRUSTED_KEYS:');
    say('   ' + JSON.stringify(KID) + ': ' + JSON.stringify(trust.rawPublicKey(fs.readFileSync(KEY_FILE, 'utf8'))) + ',');
}

// ── build ────────────────────────────────────────────────────────────────────

const cacheDir = path.join(OUT_DIR, 'cache');

async function resolveArtifact(a, itemId) {
    const out = {
        name: a.name, format: a.format || 'raw',
        extract: a.extract || undefined, dest: a.dest || undefined,
    };
    const from = a.from || {};
    if (from.github) {
        const assets = await github.assets(from.github.repo, from.github.tag);
        const hit = assets[from.github.asset];
        if (!hit) throw new Error(itemId + ': asset ' + from.github.asset + ' not in ' + from.github.repo + '@' + from.github.tag);
        if (!hit.sha256) throw new Error(itemId + ': GitHub published no digest for ' + from.github.asset);
        out.sha256 = hit.sha256;
        out.urls = [hit.url].concat(a.mirrors || []);
        out.size = a.size || (await headSize(hit.url));
    } else if (from.url) {
        fs.mkdirSync(cacheDir, { recursive: true });
        const dest = path.join(cacheDir, itemId + '-' + path.basename(a.name));
        // Downloaded through the same chain the app uses, then hashed here. This is where a
        // maintainer's own network becomes the trust anchor — which is why the result is signed.
        const tmp = dest + '.dl';
        await downloadPlain(from.url, tmp);
        out.sha256 = sha256(tmp);
        out.size = fs.statSync(tmp).size;
        fs.renameSync(tmp, dest);
        out.urls = [from.url].concat(a.mirrors || []);
    } else if (from.file) {
        const file = path.isAbsolute(from.file) ? from.file : path.join(ROOT, from.file);
        if (!fs.existsSync(file)) throw new Error(itemId + ': ' + file + ' not found');
        out.sha256 = sha256(file);
        out.size = fs.statSync(file).size;
        out.urls = ['https://github.com/' + REPO + '/releases/download/' + TAG + '/' + a.name];
        out._upload = file;
    } else {
        throw new Error(itemId + ': artifact has no source');
    }
    return out;
}

/**
 * The maintainer's own fetch. MLMVPN_STORE_PROXY points it at a working engine, which is not a
 * convenience: torproject.org is blocked from this line and pkgs.tailscale.com answers an Iranian
 * address with 403, so the files this channel vouches for cannot be reached any other way from here.
 */
function dispatcher() {
    const p = String(process.env.MLMVPN_STORE_PROXY || '').trim();
    if (!/^https?:\/\//i.test(p)) return undefined;
    const { ProxyAgent } = require('undici');
    return new ProxyAgent(p);
}

async function headSize(url) {
    try {
        const { fetch } = require('undici');
        const r = await fetch(url, { method: 'HEAD', redirect: 'follow', dispatcher: dispatcher() });
        return Number(r.headers.get('content-length')) || 0;
    } catch (e) { return 0; }
}

async function downloadPlain(url, dest) {
    const { fetch } = require('undici');
    const r = await fetch(url, { redirect: 'follow', dispatcher: dispatcher() });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(dest, buf);
}

async function build() {
    const spec = JSON.parse(fs.readFileSync(SPEC, 'utf8'));
    const items = {};
    const uploads = [];
    for (const item of spec.items) {
        if (item.skip) { say('· skip', item.id); continue; }
        const artifacts = [];
        for (const a of item.artifacts || []) {
            const r = await resolveArtifact(a, item.id);
            if (r._upload) { uploads.push({ name: r.name, file: r._upload }); delete r._upload; }
            artifacts.push(r);
            say('·', item.id, r.name, r.sha256.slice(0, 12) + '…', (r.size / 1048576).toFixed(1) + ' MB');
        }
        items[item.id] = {
            version: item.version, released: item.released || '', notes: item.notes || '',
            artifacts,
        };
    }

    const prev = readPrevious();
    const manifest = {
        schema: 1,
        channel: spec.channel || 'stable',
        sequence: (prev ? prev.sequence : 0) + 1,
        issuedAt: new Date().toISOString(),
        minApp: spec.minApp || null,
        items,
    };
    const envelope = trust.sealEnvelope(manifest, fs.readFileSync(KEY_FILE, 'utf8'), KID);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT, envelope);
    fs.writeFileSync(path.join(OUT_DIR, 'uploads.json'), JSON.stringify(uploads, null, 2));
    say('\nwrote', OUT, '(sequence ' + manifest.sequence + ', ' + Object.keys(items).length + ' items)');
    if (uploads.length) say('artifacts to upload:', uploads.map((u) => u.name).join(', '));
}

/** The sequence must never go backwards — the app rejects a manifest older than the one it holds. */
function readPrevious() {
    try { return trust.openEnvelope(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first build */ }
    try {
        const remote = gh(['release', 'view', TAG, '-R', REPO, '--json', 'assets', '--jq', '.assets[].name']);
        if (remote.includes('store-channel.json')) {
            const tmp = path.join(os.tmpdir(), 'store-channel-remote.json');
            gh(['release', 'download', TAG, '-R', REPO, '-p', 'store-channel.json', '-O', tmp, '--clobber']);
            return trust.openEnvelope(fs.readFileSync(tmp, 'utf8'));
        }
    } catch (e) { /* no release yet */ }
    return null;
}

function verify() {
    const m = trust.openEnvelope(fs.readFileSync(OUT, 'utf8'));
    say('signature OK · sequence', m.sequence, '· issued', m.issuedAt);
    for (const [id, item] of Object.entries(m.items)) {
        say('  ' + id.padEnd(12), item.version.padEnd(22),
            item.artifacts.map((a) => a.name + ' ' + a.sha256.slice(0, 8)).join(', '));
    }
}

function publish() {
    if (!fs.existsSync(OUT)) throw new Error('build it first');
    verify();
    const uploads = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'uploads.json'), 'utf8'));
    let exists = true;
    try { gh(['release', 'view', TAG, '-R', REPO], { stdio: 'ignore' }); } catch (e) { exists = false; }
    if (!exists) {
        say('creating release', TAG);
        gh(['release', 'create', TAG, '-R', REPO, '--prerelease', '--title', 'Store channel',
            '--notes', 'Signed version manifest for «ام‌ال‌ام استور» plus the Windows engine builds upstream does not publish. Not an app release.']);
    }
    const files = uploads.map((u) => u.file + '#' + u.name).concat([OUT]);
    for (const f of files) {
        say('uploading', path.basename(f.split('#')[0]));
        gh(['release', 'upload', TAG, f, '-R', REPO, '--clobber']);
    }
    say('published to', 'https://github.com/' + REPO + '/releases/tag/' + TAG);
}

function status() {
    const { SHIPPED } = require(path.join(ROOT, 'store', 'shipped.js'));
    const catalog = require(path.join(ROOT, 'store', 'catalog.js'));
    let channel = null;
    try { channel = trust.openEnvelope(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* none built */ }
    say('item          shipped                 app pin                channel');
    for (const item of catalog.ITEMS) {
        const s = SHIPPED[item.id];
        const pin = item.pin && item.pin.version;
        const ch = channel && channel.items[item.id] && channel.items[item.id].version;
        say('  ' + item.id.padEnd(13) + String(s ? s.version : '—').padEnd(23) +
            String(pin || '—').padEnd(23) + String(ch || '—'));
    }
}

const cmd = process.argv[2] || 'status';
const run = { keygen, build, verify, publish, status }[cmd];
if (!run) { console.error('unknown command: ' + cmd); process.exit(2); }
Promise.resolve().then(run).catch((e) => { console.error('ERROR: ' + e.message); process.exit(1); });
