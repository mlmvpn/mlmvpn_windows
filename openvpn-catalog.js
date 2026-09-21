// --- «اوپن‌وی‌پی‌ان» — the server catalogue, and the curation over it ---
//
// This is «گیت‌وی MLM»'s list feature, for the OpenVPN engine. Every capability the gateway's
// list has — the archive, «فهرست من» over it, promoting, hiding, purging, the undo, two sweeps,
// dead/healthy sets, a suggestion — exists here, so the two windows are the same window with a
// different engine under it.
//
// ## One archive, two curations
//
// The user asked for «همون سرورها» and for the two panels to stay independent: *«کاربر نیاز
// نیست اصلا بفهمه که آرشیو ها یکی هستند، ولی توی بک اند یکی هستند. موتورها هم کاملا جدا»*.
//
// So the ROWS come from the gateway's archive (one file on disk, one refresh, one place where
// 355 relays accumulate) and everything else is this engine's own:
//
//   shared   the relay rows themselves — gateway-manager.servers()
//   ours     kept / hidden / purged, every measurement, the selected relay, the chosen front
//
// The measurements MUST be separate, and that is not a detail: measured here, SoftEther's
// handshake succeeded on all four official relays (1.3–3.0 s) at the same minute OpenVPN's
// stalled on all four. A relay that works over one protocol says nothing about the other, so
// sharing a «سالم/خراب» verdict between them would be sharing a wrong answer.
//
// ## Deleting is per-engine, and nothing here writes the shared file
//
// The gateway's «حذف از آرشیو» rewrites the CSV. This one does not: `purge()` adds to our own
// `purged` deny-list instead. Two reasons — a destructive write to a file the other window is
// reading is the kind of coupling that turns one bad click into two broken panels, and a row
// this engine cannot use is often one the gateway still connects to perfectly.
//
// ## The profile is built, not downloaded
//
// The archive has no .ovpn column (gateway-manager's `slim()` drops it — 2.5 MB for 192 rows).
// It does not need one: VPN Gate gives every relay the same client certificate, so a profile is
// `remote <ip> <port>` plus the three fixed blocks in openvpn-creds.js. Verified against all 98
// mirror profiles, byte for byte.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const gw = require('./gateway-manager');
const creds = require('./openvpn-creds');

const DATA_DIR = path.join(os.homedir(), '.mlmvpn', 'openvpn');

function curationPath() { return path.join(DATA_DIR, 'curation.json'); }

function ensureDataDir() {
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* exists */ }
}

// ── the curation file ────────────────────────────────────────────────────────────

const EMPTY = {
    kept: [],       // promoted out of the archive, so a refresh cannot drop them
    hidden: [],     // removed from «فهرست من» — a deny-list, because a refresh re-advertises
    purged: [],     // removed from «آرشیو» too; ours alone, the shared CSV is never rewritten
    pings: {},      // host -> ms, 0 = answered nothing (tcpPing's own convention)
    probes: {},     // host -> { ok, ms, reason, at } from a REAL OpenVPN handshake
    selected: null,
    front: 'auto',  // which SOCKS front carries the tunnel: 'auto' | 'none' | a port number
    fetchedAt: 0,
};

let cur = null;

function read() {
    if (cur) return cur;
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(curationPath(), 'utf8')) || {}; } catch (e) { disk = {}; }
    cur = Object.assign({}, EMPTY, disk);
    // A half-written file must degrade to «no curation», never to a crash on first paint.
    for (const k of ['kept', 'hidden', 'purged']) if (!Array.isArray(cur[k])) cur[k] = [];
    for (const k of ['pings', 'probes']) if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    return cur;
}

// Debounced: a sweep writes a result every few hundred ms across hundreds of relays, and each
// one would otherwise be a synchronous disk write on the main thread.
let timer = null;
function save(now) {
    read();
    const write = () => {
        timer = null;
        try { ensureDataDir(); fs.writeFileSync(curationPath(), JSON.stringify(cur), 'utf8'); }
        catch (e) { /* still correct in memory for this session */ }
    };
    if (now) { if (timer) clearTimeout(timer); return write(); }
    if (timer) return;
    timer = setTimeout(write, 1200);
    if (timer.unref) timer.unref();
}

/** `host` as the CSV writes it (no suffix) ↔ as the panel shows it (with one). */
const bare = (h) => String(h || '').replace(/\.opengw\.net$/i, '');
const full = (h) => (bare(h) ? bare(h) + '.opengw.net' : '');

// ── the rows, and the two lists over them ────────────────────────────────────────

/**
 * Which relays the gateway's last refresh advertised, or `null` for «cannot tell».
 *
 * Delegated rather than recomputed: the archive and its `last-seen.json` sidecar are the
 * gateway's, and two readers deriving «live» differently from the same file is how the two
 * windows would start disagreeing about a list they share. `null` is not «none» — see the
 * gateway's own note.
 */
function liveHosts() {
    try { return gw._internal.liveHosts(); } catch (e) { return null; }
}

function archiveRows() {
    try { return gw.servers().rows || []; } catch (e) { return []; }
}

/** When the shared archive was last refreshed, whoever pressed the button. */
function gatewayFetchedAt() {
    try { return gw._internal.readCuration().fetchedAt || 0; } catch (e) { return 0; }
}

/**
 * Both lists, the curation over them, and every measurement so far — one call, because the
 * panel needs all of it to draw a single row.
 */
function lists() {
    const c = read();
    const purged = new Set(c.purged.map(full));
    const hidden = new Set(c.hidden.map(full));
    const kept = new Set(c.kept.map(full));
    const live = liveHosts();

    let source = 'seed', at = 0;
    try { const s = gw.servers(); source = s.source; at = s.at; } catch (e) { /* defaults */ }

    // Each row carries the port THIS engine would dial and whether that is known or a guess.
    // The panel needs the second one: a relay we have never seen a profile for has not failed,
    // it has not been asked, and drawing those the same way is what made 317 healthy volunteer
    // relays look dead.
    const annotate = (r) => {
        const k = portFor(r.host);
        return Object.assign({}, r, { ovpnPort: k.port, ovpnProto: k.proto, ovpnKnown: k.known });
    };
    const archive = archiveRows().filter((r) => !purged.has(r.host)).map(annotate);
    const mine = archive.filter((r) =>
        !hidden.has(r.host) && (live === null || live.has(r.host) || kept.has(r.host)));

    return {
        mine, archive,
        kept: [...kept], hidden: [...hidden],
        pings: c.pings, probes: c.probes,
        selected: c.selected, front: c.front || 'auto',
        // The ROWS are the gateway's, so how old they are is the gateway's answer, not ours.
        // Reporting our own (never-stamped) 0 here left «کهنه بودن فهرست» permanently blank.
        source, at, fetchedAt: gatewayFetchedAt() || c.fetchedAt,
        portsKnown: portsKnown(),
    };
}

/** Promote archive rows into «فهرست من» so a refresh cannot drop them again. */
function keep(hosts) {
    const c = read();
    const set = new Set(c.kept.map(full));
    const un = new Set(c.hidden.map(full));
    let n = 0;
    for (const h of hosts || []) {
        const k = full(h);
        if (!k) continue;
        // Keeping something previously deleted must undo the deletion too, or the row is in both
        // sets and «فهرست من» still will not show it.
        if (un.delete(k)) n++;
        if (!set.has(k)) { set.add(k); n++; }
    }
    c.kept = [...set];
    c.hidden = [...un];
    save();
    return n;
}

/** Undo `keep` — the relay stays in the archive and leaves «فهرست من» when VPN Gate drops it. */
function drop(hosts) {
    const c = read();
    const set = new Set(c.kept.map(full));
    let n = 0;
    for (const h of hosts || []) if (set.delete(full(h))) n++;
    c.kept = [...set];
    save();
    return n;
}

/** Remove from «فهرست من» — a deny-list, so a refresh cannot quietly bring it back. */
function hide(hosts) {
    const c = read();
    const un = new Set(c.hidden.map(full));
    const set = new Set(c.kept.map(full));
    let n = 0;
    for (const h of hosts || []) {
        const k = full(h);
        if (!k) continue;
        set.delete(k);
        if (!un.has(k)) { un.add(k); n++; }
    }
    c.hidden = [...un];
    c.kept = [...set];
    if (c.selected && un.has(full(c.selected))) c.selected = null;
    save();
    return n;
}

/**
 * Remove from «آرشیو».
 *
 * Ours only. The gateway rewrites the shared CSV for this; we add to `purged` instead, so a
 * relay this engine cannot use stays available to the one that can.
 */
function purge(hosts) {
    const c = read();
    const set = new Set(c.purged.map(full));
    let n = 0;
    for (const h of hosts || []) {
        const k = full(h);
        if (!k) continue;
        if (!set.has(k)) { set.add(k); n++; }
        delete c.pings[k];
        delete c.probes[k];
    }
    c.purged = [...set];
    if (c.selected && set.has(full(c.selected))) c.selected = null;
    save(true);
    return n;
}

/**
 * Bring back everything deleted — from either list. The one undo a bulk delete must have.
 *
 * Both sets, deliberately: the user pressed one button called «حذف», and being told «restored»
 * while the rows are still missing from the other list would be a lie of omission.
 */
function restoreHidden() {
    const c = read();
    const n = c.hidden.length + c.purged.length;
    c.hidden = [];
    c.purged = [];
    save(true);
    return n;
}

/** Drop measurements for relays that no longer exist, so the file cannot grow forever. */
function forget(hosts) {
    const c = read();
    for (const h of hosts || []) {
        const k = full(h);
        delete c.pings[k];
        delete c.probes[k];
    }
    save();
}

function select(host) {
    const c = read();
    c.selected = host ? full(host) : null;
    save(true);
    return c.selected;
}

/** Which front carries the tunnel. See openvpn-manager for why there has to be one. */
function setFront(v) {
    const c = read();
    c.front = (v === 'none' || v === 'auto') ? v : (parseInt(v, 10) || 'auto');
    save(true);
    return c.front;
}

function stampFetched() {
    const c = read();
    c.fetchedAt = Date.now();
    save(true);
    return c.fetchedAt;
}

// ── the verdict sets ─────────────────────────────────────────────────────────────

/**
 * The relays a test has CONDEMNED — never the merely untested.
 *
 * «حذف خراب‌ها» on a fresh list must not wipe it. A relay with no result is not a bad relay, it
 * is an unmeasured one, and the two are only the same to a button that has not thought about it.
 */
function deadHosts(hosts) {
    const c = read();
    return (hosts || []).map(full).filter((h) => {
        // Never asked is not the same as answered badly. Without this, «حذف خراب‌ها» would offer
        // to delete every relay whose OpenVPN port we have not harvested yet.
        if (!portFor(h).known) return false;
        const pr = c.probes[h];
        if (pr) return pr.ok === false;
        const pg = c.pings[h];
        return pg !== undefined && !(pg > 0);
    });
}

/** The relays a test has PASSED — the real test's word first, the ping's only if it is all we have. */
function healthyHosts(hosts) {
    const c = read();
    const all = (hosts || []).map(full);
    const proven = all.filter((h) => c.probes[h] && c.probes[h].ok === true);
    if (proven.length) return proven;
    return all.filter((h) => (c.pings[h] || 0) > 0);
}

/**
 * The relay to dial when the user has not chosen one.
 *
 * Opening onto a dead button is the worst first impression a panel can make, and «the first row»
 * is not an answer on a list sorted by advertised megabits — the one number measured from Japan
 * rather than from here. So: what the real handshake proved, then what answered a ping, then VPN
 * Gate's own score, preferring an official relay among equals.
 */
function suggest() {
    const l = lists();
    const rank = (r) => {
        const pr = l.probes[r.host];
        if (pr && pr.ok) return [0, pr.ms];
        const pg = l.pings[r.host];
        if (pg > 0) return [1, pg];
        if (pr && pr.ok === false) return [4, 0];
        if (pg !== undefined) return [3, 0];
        return [2, -(r.score || 0)];
    };
    const best = l.mine.slice().sort((a, b) => {
        const ra = rank(a), rb = rank(b);
        return (ra[0] - rb[0]) || (ra[1] - rb[1]) || (b.official - a.official);
    })[0];
    return best ? best.host : null;
}

// ── the profile ──────────────────────────────────────────────────────────────────

// Official relays serve OpenVPN on TCP/443 — proven: three of them completed
// «Initialization Sequence Completed» there through a front, in 5.5–8.1 s.
//
// VOLUNTEER RELAYS DO NOT. Each one serves OpenVPN on whatever port its owner configured —
// measured across the mirror: 995, 1215, 1232, 1243, 1264 … almost never 443. So 443 is the
// right default for an official relay and a wrong guess for everyone else, and a wrong guess
// reads as «the relay is dead» when it means «we knocked on the wrong door».
const DEFAULT_PORT = 443;
const DEFAULT_PROTO = 'tcp';

// ── the real OpenVPN port, per relay ─────────────────────────────────────────────
//
// VPN Gate's CSV has no port column; the port lives inside `OpenVPN_ConfigData_Base64`, which
// gateway-manager's `slim()` throws away before writing the archive (2.5 MB for 192 rows, and
// the gateway speaks SoftEther so it has no use for it).
//
// We do not need the profile — we need two values out of it. So the raw text is read once per
// refresh, on its way past, and what survives is `{ host: { port, proto } }`: a few bytes a row
// instead of fourteen kilobytes, and the thing that makes 300 volunteer relays dialable at all.

function portsPath() { return path.join(DATA_DIR, 'ovpn-ports.json'); }

let ports = null;

function readPorts() {
    if (ports) return ports;
    try { ports = JSON.parse(fs.readFileSync(portsPath(), 'utf8')) || {}; } catch (e) { ports = {}; }
    if (typeof ports !== 'object' || !ports) ports = {};
    return ports;
}

/**
 * Pull `remote <host> <port>` and `proto <p>` out of every profile in a raw VPN Gate CSV.
 *
 * Called from gateway-manager's refresh with the text BEFORE slim() drops the column, and
 * guarded there — a failure here must never cost the gateway its list.
 */
function harvestPorts(rawCsv) {
    const lines = String(rawCsv || '').split(/\r?\n/);
    const hi = lines.findIndex((l) => l.startsWith('#'));
    if (hi < 0) return 0;
    const cols = lines[hi].replace(/^#/, '').split(',');
    const iHost = cols.indexOf('HostName');
    const iCfg = cols.indexOf('OpenVPN_ConfigData_Base64');
    if (iHost < 0 || iCfg < 0) return 0;

    const out = readPorts();
    let n = 0;
    for (const l of lines) {
        if (!l || l.startsWith('#') || l.startsWith('*')) continue;
        const f = l.split(',');
        if (f.length <= iCfg) continue;
        const host = full((f[iHost] || '').trim());
        const b64 = (f[iCfg] || '').trim();
        if (!host || !b64) continue;
        let text = '';
        try { text = Buffer.from(b64, 'base64').toString('utf8'); } catch (e) { continue; }
        // The first `remote` line wins: VPN Gate's profiles carry exactly one.
        const m = text.match(/^\s*remote\s+\S+\s+(\d{1,5})\s*$/m);
        const p = text.match(/^\s*proto\s+(tcp|udp)\S*\s*$/mi);
        if (!m) continue;
        const port = parseInt(m[1], 10);
        if (!(port > 0 && port < 65536)) continue;
        const proto = p ? p[1].toLowerCase() : 'tcp';
        const prev = out[host];
        if (!prev || prev.port !== port || prev.proto !== proto) n++;
        out[host] = { port, proto };
    }
    if (n) {
        try { ensureDataDir(); fs.writeFileSync(portsPath(), JSON.stringify(out), 'utf8'); }
        catch (e) { /* still correct in memory for this session */ }
    }
    return n;
}

/**
 * What we know about a relay's OpenVPN listener, and whether we know it at all.
 *
 * `known:false` is NOT a failure and must not be drawn as one — it is «we have never seen this
 * relay's profile», which is a different thing from «this relay did not answer». Dialling 443
 * anyway and reporting the timeout was exactly that mistake: 317 of 323 volunteer relays came
 * back «موتور بیرون آمد» when they had simply never been asked on the right port.
 */
function portFor(host) {
    const k = full(host);
    const p = readPorts()[k];
    if (p && p.port) return { port: p.port, proto: p.proto || 'tcp', known: true };
    return { port: DEFAULT_PORT, proto: DEFAULT_PROTO, known: false };
}

/** How many relays we have a real port for — what the panel needs to explain itself. */
function portsKnown() { return Object.keys(readPorts()).length; }

/**
 * Record ports we learned somewhere other than the CSV.
 *
 * The auto-ovpn mirror already decodes each profile and keeps the port, so those rows are free:
 * no fetch, no base64, just a copy into the same sidecar the archive refresh fills.
 */
function notePorts(rows) {
    const out = readPorts();
    let n = 0;
    for (const r of rows || []) {
        const k = full(r.host);
        const port = parseInt(r.port, 10);
        if (!k || !(port > 0 && port < 65536)) continue;
        const proto = String(r.proto || 'tcp').toLowerCase() === 'udp' ? 'udp' : 'tcp';
        const prev = out[k];
        if (!prev || prev.port !== port || prev.proto !== proto) n++;
        out[k] = { port, proto };
    }
    if (n) {
        try { ensureDataDir(); fs.writeFileSync(portsPath(), JSON.stringify(out), 'utf8'); }
        catch (e) { /* in memory is enough for this session */ }
    }
    return n;
}

/**
 * A working .ovpn for one archive row.
 *
 * `remote` is the IP, not the name: on a filtered line the DDNS name often resolves to the
 * operator's sinkhole, and the certificate is verified against the chain rather than the name
 * here (`verify-x509-name` is deliberately absent, as VPN Gate's own profiles have it absent).
 */
function buildProfile(row, opts) {
    const o = opts || {};
    const known = portFor(row.host);
    const port = o.port || known.port;
    const proto = o.proto || known.proto;
    const remote = row.ip || bare(row.host) + '.opengw.net';
    return [
        'client',
        'dev tun',
        'proto ' + proto,
        'remote ' + remote + ' ' + port,
        'resolv-retry infinite',
        'nobind',
        'persist-key',
        'persist-tun',
        // SoftEther's OpenVPN emulation offers CBC exclusively. openvpn.exe 2.6 needs BOTH lines:
        // `cipher` alone is the deprecated form and `data-ciphers` alone leaves the fallback
        // unset, and either way it negotiates AEAD-only and refuses the data channel. This is the
        // same wall Android's openvpn3 hits — there it is fatal, here it is one config line.
        'cipher AES-128-CBC',
        'data-ciphers AES-128-CBC',
        'data-ciphers-fallback AES-128-CBC',
        'auth SHA1',
        'auth-user-pass',
        'verb 3',
        creds.CA,
        creds.CERT,
        creds.KEY,
        '',
    ].join('\n');
}

module.exports = {
    lists, keep, drop, hide, purge, restoreHidden, forget, select, setFront, stampFetched,
    deadHosts, healthyHosts, suggest, buildProfile, archiveRows, liveHosts,
    harvestPorts, notePorts, portFor, portsKnown,
    DATA_DIR, DEFAULT_PORT, DEFAULT_PROTO,
    _internal: { read, save, curationPath, full, bare, EMPTY, portsPath, readPorts },
};
