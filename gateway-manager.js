'use strict';

/**
 * «گیت‌وی MLM» — the public SoftEther gateway network, carried by SoftEther's own client.
 *
 * ## Why this drives SoftEther's client instead of speaking a protocol we wrote
 *
 * Because the protocol's *parallelism* is the entire performance story, and it was measured rather
 * than assumed. Same relay, same minute, on an Iranian line:
 *
 * ```
 *   Windows' own SSTP client (one TCP stream, kernel data path)   0.69 Mbit/s
 *   SoftEther's client with MAXTCP:8 (eight parallel streams)     4.29 Mbit/s
 * ```
 *
 * Six times faster, and the session log shows why: the connection count climbed 1 → 8 under load.
 * On a path with ~1 s of round trip, a single TCP stream is limited by its window, not by the
 * link — so no amount of care in a client of our own would close that gap without reimplementing
 * the same multiplexing. SSTP was tried first precisely because it ships nothing (see the note in
 * `docs/` and the memory), and it is genuinely the lightest thing that works; it is simply four to
 * six times too slow to offer as a headline feature.
 *
 * The client is Apache-2.0, so bundling its installer is allowed. This module uses whichever
 * installation is present and never touches the user's own connection settings: everything it
 * creates is named [ACCOUNT] and is deleted again on stop.
 *
 * ## What it does NOT do
 *
 * The SoftEther client owns its own virtual adapter, so this engine does not go through the app's
 * sing-box TUN and does not inherit its kill switch or per-app rules. That is the trade for the
 * speed above, and it is stated in the panel rather than hidden: the alternative is an engine
 * nobody will use because a 700 kbit/s tunnel is not a tunnel.
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

// ============================================================
// Where things are
// ============================================================

/** The connection setting we create. Ours alone — the user's own accounts are never touched. */
const ACCOUNT = 'MLMVPN_GATEWAY';

/** The virtual adapter we ask for when none exists. SoftEther prefixes it with "VPN - ". */
const NIC = 'MLM';

/** The hub, user and password the public gateway network uses. Not secrets; they are published. */
const HUB = 'VPNGATE';
const USER = 'vpn';
const PASS = 'vpn';

/**
 * How many TCP streams one session may open.
 *
 * Eight because that is what the measurement above used, and because the client itself ramps up to
 * the ceiling only as the load needs it (observed: 1 connection idle, 8 during a transfer). A
 * higher number costs the relay more sockets for very little; the relays are shared by everybody.
 */
const MAX_TCP = 8;

const DATA_DIR = path.join(os.homedir(), '.mlmvpn', 'gateway');

/** The shipped seed list, and the updated copy that supersedes it once one has been fetched. */
function seedPath() { return path.join(__dirname, 'core', 'vpngate_servers.csv'); }
function livePath() { return path.join(DATA_DIR, 'servers.csv'); }

/**
 * The client's CLI, wherever it is installed.
 *
 * The 64-bit binary first: on a 64-bit Windows the 32-bit twin talks to the same service but is
 * pointless, and preferring it would be a silent performance choice nobody made.
 */
function cliPath() {
    const roots = [
        process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'SoftEther VPN Client'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'SoftEther VPN Client'),
        path.join(__dirname, 'core', 'softether'),
    ].filter(Boolean);
    for (const r of roots) {
        for (const exe of ['vpncmd_x64.exe', 'vpncmd.exe']) {
            const p = path.join(r, exe);
            if (fs.existsSync(p)) return p;
        }
    }
    return null;
}

/** The bundled installer, for a machine that does not have the client yet. */
function installerPath() {
    for (const exe of ['vpnsetup_x64.exe', 'vpnsetup.exe']) {
        const p = path.join(__dirname, 'core', 'softether', exe);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function isInstalled() { return !!cliPath(); }

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    return DATA_DIR;
}

// ============================================================
// Talking to the client
// ============================================================

/**
 * Run one `vpncmd` command and return its lines.
 *
 * Every argument is passed separately and never joined into a string: the CLI takes the command
 * name as its own argument, so a joined string arrives as one enormous command name and it answers
 * `"AccountCreate": Command not found` — which reads like a version problem and is not one.
 *
 * The first four lines are the banner and are dropped.
 */
function vc(...args) {
    const exe = cliPath();
    if (!exe) return { ok: false, lines: [], error: 'کلاینت سافت‌اتر نصب نیست.' };
    const r = spawnSync(exe, ['localhost', '/CLIENT', '/CMD', ...args], {
        encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    const out = String((r.stdout || '') + (r.stderr || ''));
    const lines = out.split(/\r?\n/).slice(4).map(l => l.replace(/\s+$/, ''));
    return {
        ok: /completed successfully/i.test(out),
        lines,
        error: /completed successfully/i.test(out) ? null : (lines.find(l => l.trim()) || 'دستور ناموفق'),
    };
}

/**
 * A LONG-LIVED vpncmd, for the polling that happens while a session is up.
 *
 * One `vpncmd` invocation costs **555 ms** — measured, six calls in a row, and it is not the
 * process start: the CLI opens a fresh connection to the local client service and re-handshakes
 * every time. Reading the session once a second that way would burn more than half a core for as
 * long as the user stays connected.
 *
 * The CLI also has an interactive mode, and driving THAT costs **10 to 27 ms** per command — the
 * same six reads, fifty times cheaper. So the poller keeps one process open and writes commands to
 * its stdin, and `vc()` above stays for the one-shot lifecycle commands where a spawn is fine.
 *
 * The prompt is the frame marker: vpncmd prints `VPN Client>` when it has finished answering, so a
 * reply is everything up to the next prompt. A command whose reply never arrives is resolved by
 * the caller's own timeout rather than left to block the poller for ever.
 */
const PROMPT = 'VPN Client>';
let session = null;   // { proc, waits: [], buf }

function sessionOpen() {
    if (session && session.proc && !session.proc.killed) return true;
    const exe = cliPath();
    if (!exe) return false;
    let proc;
    try {
        proc = spawn(exe, ['localhost', '/CLIENT'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) { return false; }
    const st = { proc, waits: [], buf: '' };
    proc.stdout.on('data', (d) => {
        st.buf += d.toString('utf8');
        let i;
        while ((i = st.buf.indexOf(PROMPT)) >= 0) {
            const chunk = st.buf.slice(0, i);
            st.buf = st.buf.slice(i + PROMPT.length);
            const w = st.waits.shift();
            if (w) w(chunk);
        }
    });
    proc.stderr.on('data', () => { });
    // A dead process must not leave callers waiting on replies that can never come.
    const drop = () => {
        if (session === st) session = null;
        st.waits.splice(0).forEach(w => w(''));
    };
    proc.on('exit', drop);
    proc.on('error', drop);
    session = st;
    return true;
}

function sessionClose() {
    if (!session) return;
    const st = session;
    session = null;
    try { st.proc.stdin.write('exit\r\n'); } catch (e) { /* already gone */ }
    try { st.proc.kill(); } catch (e) { /* already gone */ }
    st.waits.splice(0).forEach(w => w(''));
}


/** One command down the open session. Resolves to its reply's lines, or [] if it did not answer. */
function vcLive(cmd, timeoutMs = 4000) {
    return new Promise((resolve) => {
        if (!sessionOpen()) return resolve([]);
        const st = session;
        let done = false;
        const finish = (text) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(String(text || '').split(/\r?\n/));
        };
        const timer = setTimeout(() => {
            // Take our slot back, or every later reply would be handed to the wrong caller.
            const i = st.waits.indexOf(finish);
            if (i >= 0) st.waits.splice(i, 1);
            finish('');
        }, timeoutMs);
        st.waits.push(finish);
        try { st.proc.stdin.write(cmd + '\r\n'); } catch (e) { finish(''); }
    });
}

/** The `Item|Value` table vpncmd prints, as an object. */
function table(lines) {
    const out = {};
    for (const l of lines) {
        const i = l.indexOf('|');
        if (i <= 0) continue;
        const k = l.slice(0, i).trim();
        const v = l.slice(i + 1).trim();
        if (k && k !== 'Item' && !/^-+$/.test(k)) out[k] = v;
    }
    return out;
}

// ============================================================
// The server list
// ============================================================

/**
 * Parse a VPN Gate CSV into the rows the panel shows.
 *
 * The list is the whole feature — the relays rotate almost completely over a year — so the parser
 * is deliberately forgiving: a row with a missing column is skipped rather than allowed to throw,
 * because one malformed line in a 100 KB download must not empty the list.
 */
function parseCsv(text) {
    const lines = String(text || '').split(/\r?\n/);
    const head = lines.find(l => l.startsWith('#'));
    if (!head) return [];
    const cols = head.replace(/^#/, '').split(',').map(s => s.trim());
    const ix = (n) => cols.indexOf(n);
    const iHost = ix('HostName'), iIp = ix('IP'), iPing = ix('Ping'), iSpeed = ix('Speed');
    const iCc = ix('CountryShort'), iName = ix('CountryLong'), iSess = ix('NumVpnSessions');
    // The rest of what VPN Gate publishes about a relay. Nothing read them before, so the server
    // page could only ever say «this many megabits, this many sessions» — while the CSV on disk
    // had the score, the uptime, the logging policy and the operator's own note sitting unused
    // one column over. They cost nothing: the file is already parsed.
    const iScore = ix('Score'), iUp = ix('Uptime'), iUsers = ix('TotalUsers');
    const iTraffic = ix('TotalTraffic'), iLog = ix('LogType');
    const iOp = ix('Operator'), iMsg = ix('Message');
    if (iHost < 0 || iIp < 0) return [];

    const out = [];
    for (const l of lines) {
        if (!l || l.startsWith('#') || l.startsWith('*')) continue;
        const f = l.split(',');
        if (f.length <= Math.max(iHost, iIp, iSpeed)) continue;
        const host = (f[iHost] || '').trim();
        if (!host) continue;
        out.push({
            // The DDNS name, which is what the client dials. An IP would work for the transport but
            // the name is what survives the relay changing address, and the relays do.
            host: `${host}.opengw.net`,
            ip: (f[iIp] || '').trim(),
            cc: (f[iCc] || '').trim().toUpperCase(),
            country: (f[iName] || '').trim(),
            ping: parseInt(f[iPing], 10) || 0,
            speedMbps: Math.round((parseInt(f[iSpeed], 10) || 0) / 1e6),
            sessions: parseInt(f[iSess], 10) || 0,
            // The official relays are the ones that answer from a censored line at all — measured,
            // 8 of 8 volunteer relays were unreachable on both TCP/443 and TCP/1195 while all the
            // official ones answered. So the list is sortable by it rather than pretending the
            // advertised megabits are the whole story.
            official: /^public-vpn-/.test(host),
            // VPN Gate's own long-run verdict on the relay, and the facts a person weighs when
            // two relays look alike: how long it has been up, how many have used it, and whether
            // its operator keeps logs. `message` is the operator's own note and is sometimes the
            // only warning that a relay is about to go away.
            score: parseInt(f[iScore], 10) || 0,
            uptimeMs: parseInt(f[iUp], 10) || 0,
            totalUsers: parseInt(f[iUsers], 10) || 0,
            totalTraffic: parseInt(f[iTraffic], 10) || 0,
            logType: (f[iLog] || '').trim(),
            operator: (f[iOp] || '').trim(),
            message: (f[iMsg] || '').trim(),
        });
    }
    return out;
}

/** The raw CSV of the list in force — the updated copy when there is one, else the seed. */
function readList() {
    for (const p of [livePath(), seedPath()]) {
        try { if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8'); } catch (e) { /* next */ }
    }
    return '';
}

/** The list in use: the updated copy when there is one, else the shipped seed. */
function servers() {
    for (const p of [livePath(), seedPath()]) {
        try {
            if (fs.existsSync(p)) {
                const rows = parseCsv(fs.readFileSync(p, 'utf8'));
                if (rows.length) {
                    return {
                        rows,
                        source: p === livePath() ? 'updated' : 'bundled',
                        at: fs.statSync(p).mtimeMs,
                    };
                }
            }
        } catch (e) { /* try the next one */ }
    }
    return { rows: [], source: 'none', at: 0 };
}

const LIST_URL = 'https://www.vpngate.net/api/iphone/';

/**
 * Fetch a fresh list and replace the offline copy.
 *
 * THREE ROUTES, IN THIS ORDER, because the site itself is reachable from a censored line only
 * sometimes — measured here within one hour: a direct fetch succeeded, and twenty minutes later the
 * same fetch could not connect at all.
 *
 *  1. Direct.
 *  2. Through whichever of the app's own engines is connected right now. This is the route that
 *     makes the feature self-healing: the user turns on any tunnel, the list updates, and the
 *     gateway then works on its own.
 *  3. Nothing — and then the caller is told to turn a tunnel on, rather than left with an empty
 *     list and no explanation.
 *
 * The written file replaces the previous one only after it parses to a non-empty list, so a
 * truncated download cannot destroy a working list.
 */
async function refreshServers(onLog) {
    const log = (m) => { try { if (onLog) onLog(`[گیت‌وی] ${m}`); } catch (e) { /* no page */ } };
    const attempts = [{ name: 'مستقیم', port: null }];
    for (const p of liveSocksPorts()) attempts.push({ name: `از تونل روی پورت ${p}`, port: p });

    for (const a of attempts) {
        try {
            log(`دریافت فهرست ${a.name}…`);
            const raw = await fetchList(a.port);
            // «اوپن‌وی‌پی‌ان» shares this archive and needs one thing from the column `slim()` is
            // about to throw away: each relay's real OpenVPN port. Volunteer relays serve it on
            // whatever port their owner chose, so without this they are all dialled on 443 and
            // all report a timeout. Guarded — harvesting is that panel's business, and a failure
            // in it must never cost this one its list.
            try { require('./openvpn-catalog').harvestPorts(raw); } catch (e) { /* not fatal here */ }
            const text = slim(raw);
            const fetched = parseCsv(text);
            if (!fetched.length) { log('پاسخ قابل خواندن نبود.'); continue; }
            const before = servers();
            const merged = mergeLists(before.rows.length ? readList() : '', text);
            if (!merged) { log('ادغام فهرست ممکن نشد.'); continue; }
            ensureDataDir();
            fs.writeFileSync(livePath(), merged, 'utf8');
            // WHEN this happened, so `liveHosts()` can tell the rows this fetch advertised from
            // the ones only the archive still remembers. Without it «فهرست من» and «آرشیو» are
            // the same list and the archive is not a feature, it is a synonym.
            readCuration().fetchedAt = Date.now();
            saveCuration(true);
            const after = parseCsv(merged);
            const added = after.length - before.rows.length;
            log(`فهرست بروز شد — ${fetched.length} سرور تازه گرفته شد، فهرست الان ${after.length} سرور دارد` +
                `${added > 0 ? ` (${added} تازه)` : ''} و ${after.filter(r => r.official).length} رسمی.`);
            return { ok: true, count: after.length, fetched: fetched.length, added: Math.max(0, added), via: a.name };
        } catch (e) {
            log(`${a.name}: ${e.message}`);
        }
    }
    throw new Error('فهرست بروز نشد. یکی از تونل‌های برنامه را روشن کنید و دوباره امتحان کنید.');
}

/**
 * The local SOCKS ports of engines that are connected right now.
 *
 * Read from the managers rather than probed, so a port that happens to be open but belongs to a
 * disconnected engine is not mistaken for a working route.
 */
function liveSocksPorts() {
    const ports = [];
    const tryOne = (mod, get) => {
        try {
            const m = require(mod);
            const p = get(m);
            if (p) ports.push(p);
        } catch (e) { /* not loaded */ }
    };
    tryOne('./psiphon-manager', m => (m.getStatus().connected ? m.SOCKS_PORT : null));
    tryOne('./tor-manager', m => (m.getStatus().connected ? m.SOCKS_PORT : null));
    tryOne('./aether-manager', m => (m.getStatus().connected ? m.SOCKS_PORT : null));
    tryOne('./xray-manager', m => (m.isRunning && m.isRunning() ? 20809 : null));
    return ports;
}

function fetchList(socksPort) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const opts = { timeout: 60000, headers: { 'User-Agent': 'Mozilla/5.0' } };
        if (socksPort) {
            const { SocksTlsAgent } = require('./socks-agents');
            opts.agent = new SocksTlsAgent(socksPort);
        }
        const req = https.get(LIST_URL, opts, (res) => {
            if (res.statusCode !== 200) { res.resume(); return reject(new Error(`پاسخ ${res.statusCode}`)); }
            let body = '';
            res.setEncoding('utf8');
            res.on('data', c => { body += c; });
            res.on('end', () => resolve(body));
        });
        req.on('timeout', () => { req.destroy(new Error('تایم‌اوت')); });
        req.on('error', reject);
    });
}

/**
 * Fold a freshly fetched list into the one already on disk.
 *
 * A REFRESH MUST GROW THE LIST, NOT REPLACE IT — and that is measured, not a preference. One call
 * to the API returns about a hundred servers, and calls minutes apart return *different* hundreds:
 * merging a handful of fetches produced **192 unique servers where any single fetch gave 97**, and
 * 32 official relays where one fetch gave 17. So a refresh that overwrites would have shrunk a
 * good list by half every time the user pressed the button.
 *
 * What each side contributes:
 *  * a host in both -> the FETCHED row wins, because its speed, ping and session count are current
 *    and those three are the only fields that go stale;
 *  * a host only in the fetch -> added;
 *  * a host only on disk -> KEPT, unless it has not been seen for [FORGET_DAYS]. A relay missing
 *    from one sample is usually still there; a relay missing for three weeks is gone.
 *
 * `lastSeen` lives in a sidecar rather than in the CSV so the file keeps exactly the shape the
 * upstream API uses and the parser needs no special case.
 */
const NEWLINE = '\n';
const FORGET_DAYS = 21;
const MAX_ROWS = 1500;

function seenPath() { return path.join(DATA_DIR, 'last-seen.json'); }

function readSeen() {
    try { return JSON.parse(fs.readFileSync(seenPath(), 'utf8')) || {}; } catch (e) { return {}; }
}

function mergeLists(diskText, fetchedText) {
    const rowsOf = (text) => {
        const lines = String(text || '').split(/\r?\n/);
        const hi = lines.findIndex(l => l.startsWith('#'));
        if (hi < 0) return { header: null, map: new Map() };
        const cols = lines[hi].replace(/^#/, '').split(',');
        const iHost = cols.indexOf('HostName');
        const map = new Map();
        if (iHost >= 0) {
            for (const l of lines) {
                if (!l || l.startsWith('#') || l.startsWith('*')) continue;
                const f = l.split(',');
                if (f.length < cols.length) continue;
                const h = (f[iHost] || '').trim();
                if (h) map.set(h, l);
            }
        }
        return { header: lines[hi], cols, map };
    };

    const fresh = rowsOf(fetchedText);
    if (!fresh.header || !fresh.map.size) return null;
    const old = rowsOf(diskText);

    const now = Date.now();
    const seen = readSeen();
    const cutoff = now - FORGET_DAYS * 86400000;
    const out = new Map();

    // The kept half first, so a fresh row can overwrite it.
    if (old.header && old.cols && old.cols.length === fresh.cols.length) {
        for (const [h, line] of old.map) {
            if ((seen[h] || now) >= cutoff) out.set(h, line);
        }
    }
    for (const [h, line] of fresh.map) { out.set(h, line); seen[h] = now; }

    // Newest information first, and a ceiling so the file cannot grow without bound.
    const iSpeed = fresh.cols.indexOf('Speed');
    const lines = Array.from(out.values()).sort((a, b) => {
        const sa = parseInt(a.split(',')[iSpeed], 10) || 0;
        const sb = parseInt(b.split(',')[iSpeed], 10) || 0;
        return sb - sa;
    }).slice(0, MAX_ROWS);

    try {
        ensureDataDir();
        // Only the hosts that survived, so the sidecar cannot outgrow the list it describes.
        const kept = {};
        for (const l of lines) {
            const h = (l.split(',')[fresh.cols.indexOf('HostName')] || '').trim();
            if (h) kept[h] = seen[h] || now;
        }
        fs.writeFileSync(seenPath(), JSON.stringify(kept), 'utf8');
    } catch (e) { /* the list is still correct without the sidecar */ }

    return ['*vpn_servers', fresh.header, ...lines, '*'].join(NEWLINE) + NEWLINE;
}

/**
 * The same CSV without the column we never read.
 *
 * Every row of the API's answer carries a complete base64 OpenVPN profile — about 13 KB each — and
 * this engine speaks SoftEther, not OpenVPN. Keeping them makes the file **a hundred times
 * bigger** for nothing: measured on the merged list, 2,586,667 bytes with the column and 24,601
 * without it, for the identical 192 servers. A 2.5 MB file that ships inside the app and is
 * rewritten on every refresh, holding data nothing reads, is just a slower refresh.
 *
 * Written as a whole file rather than edited in place: the parser reads the header to find its
 * columns, so the header and the rows must always agree.
 */
function slim(text) {
    const lines = String(text || '').split(/\r?\n/);
    const hi = lines.findIndex(l => l.startsWith('#'));
    if (hi < 0) return text;
    const cols = lines[hi].replace(/^#/, '').split(',');
    const drop = cols.indexOf('OpenVPN_ConfigData_Base64');
    if (drop < 0) return text;
    const keep = (arr) => arr.filter((_, i) => i !== drop).join(',');
    const out = [];
    for (const l of lines) {
        if (!l) continue;
        if (l.startsWith('*')) { out.push(l); continue; }
        if (l.startsWith('#')) { out.push('#' + keep(lines[hi].replace(/^#/, '').split(','))); continue; }
        const f = l.split(',');
        if (f.length < cols.length) continue;
        out.push(keep(f));
    }
    return out.join('\n') + '\n';
}

/**
 * Which relays answer on TCP/443 from THIS line, and how fast.
 *
 * The advertised megabits in the list are the relay's own uplink and say nothing about whether a
 * censored line can reach it: measured, the eight fastest volunteer relays (500–974 Mbps each) were
 * all unreachable while every official relay answered. So the panel sorts on this, not on that.
 */
async function measure(rows, { concurrency = 12, timeoutMs = 5000 } = {}) {
    const out = new Map();
    let i = 0;
    const worker = async () => {
        while (i < rows.length) {
            const row = rows[i++];
            out.set(row.host, await tcpPing(row.ip || row.host, 443, timeoutMs));
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
    return out;
}

function tcpPing(host, port, timeoutMs) {
    return new Promise(resolve => {
        const t0 = Date.now();
        const s = new net.Socket();
        const done = (v) => { try { s.destroy(); } catch (e) { /* gone */ } resolve(v); };
        s.setTimeout(timeoutMs, () => done(0));
        s.on('error', () => done(0));
        s.connect(port, host, () => done(Date.now() - t0));
    });
}

// ============================================================
// State
// ============================================================

const state = {
    connecting: false,
    connected: false,
    host: null,
    stage: 'idle',      // idle | installing | connecting | connected | failed
    detail: '',
    error: null,
    since: null,
    tcpConnections: 0,
    sent: 0,
    received: 0,
    nicIp: null,
    // What the session is ACTUALLY doing, read back from the client rather than inferred from
    // the switch. `null` means «the client has not said», which is not the same as «no».
    udpSupported: null,
    udpActive: null,
    underlay: '',
};

let logs = [];
let poller = null;
const MAX_LOGS = 200;

function record(line, onLog) {
    const stamped = `[گیت‌وی] ${line}`;
    logs.push(stamped);
    if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
    if (typeof onLog === 'function') { try { onLog(stamped); } catch (e) { /* no page */ } }
}

// ============================================================
// Connecting
// ============================================================

/** A virtual adapter to bind the session to, creating one only if the machine has none. */
function ensureNic(onLog) {
    const list = vc('NicList');
    const names = list.lines
        .filter(l => /^Virtual Network Adapter Name/.test(l))
        .map(l => l.split('|')[1].trim());
    if (names.length) return names[0];
    record('آداپتور مجازی ساخته می‌شود…', onLog);
    const made = vc('NicCreate', NIC);
    if (!made.ok) throw new Error(`آداپتور مجازی ساخته نشد: ${made.error}`);
    return NIC;
}

/** Whichever IPv4 the client's adapter has been given, or null while it has none. */
function nicAddress() {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
        "(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | " +
        "Where-Object { $_.InterfaceAlias -like 'VPN*' -and $_.IPAddress -notlike '169.254*' } | " +
        "Select-Object -First 1).IPAddress"], { encoding: 'utf8', windowsHide: true, timeout: 12000 });
    const ip = String(r.stdout || '').trim();
    return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
}

/**
 * Turn SoftEther's UDP acceleration off for our account.
 *
 * SoftEther opens a UDP channel a few seconds into a session and moves the bulk of the traffic
 * onto it. That is faster where UDP is open and a dead end where it is not: some Iranian
 * operators pass the SSL channel and drop the UDP one, and the session then stalls with a green
 * badge over it. So it is the user's switch — «شتاب‌دهی UDP» — and on by default, as SoftEther
 * itself has it.
 *
 * It has to be done THIS way. `vpncmd` in client mode has no command for it: `AccountDetailSet`
 * offers exactly MAXTCP, INTERVAL, TTL, HALF, BRIDGE, MONITOR, NOTRACK and NOQOS — checked
 * against this installation's own `/?`, not assumed. The setting does exist, as
 * `bool NoUdpAcceleration` inside an exported account file, and `AccountImport` writes the file
 * back over the live account. Verified end to end: export → flip → import → re-export reads
 * `true`.
 *
 * Best-effort on purpose. A failure here means the session runs with acceleration ON, which is
 * SoftEther's default and works — refusing to connect over it would be the worse outcome.
 */
function applyUdpOff(onLog) {
    const file = path.join(ensureDataDir(), 'account.vpn');
    const back = file + '.check';
    try {
        const ex = vc('AccountExport', ACCOUNT, `/SAVEPATH:${file}`);
        if (!ex.ok) throw new Error(ex.error || 'export failed');
        const text = fs.readFileSync(file, 'utf8');
        if (!/bool NoUdpAcceleration/.test(text)) throw new Error('field missing');
        fs.writeFileSync(file, text.replace(/bool NoUdpAcceleration\s+\w+/, 'bool NoUdpAcceleration true'), 'utf8');

        // DELETE FIRST. `AccountImport` does not replace an account of the same name — it adds
        // one and RENAMES it, so importing over a live setting leaves «MLMVPN_GATEWAY» untouched
        // beside a brand-new «MLMVPN_GATEWAY (2)» carrying the edit. The connect that follows
        // then dials the original, with acceleration still on, and the switch does nothing at
        // all. Worse, the stray accumulates in the user's own SoftEther client, one per connect.
        // Measured: two imports produced «(2)» and «(3)» and the re-export still read `false`.
        const del = vc('AccountDelete', ACCOUNT);
        if (!del.ok) throw new Error(del.error || 'delete failed');
        const im = vc('AccountImport', file);
        if (!im.ok) {
            // The account is gone and the import failed: the caller is about to connect a setting
            // that no longer exists. Put it back from the file we still hold, unedited.
            fs.writeFileSync(file, text, 'utf8');
            vc('AccountImport', file);
            throw new Error(im.error || 'import failed');
        }

        // PROVE IT, rather than trust the exit code. `completed successfully` says the command
        // ran, not that the field took — and a switch that silently does nothing is the thing
        // being fixed here, so it must not be possible to claim success without checking.
        vc('AccountExport', ACCOUNT, `/SAVEPATH:${back}`);
        const after = fs.readFileSync(back, 'utf8');
        if (!/bool NoUdpAcceleration\s+true/.test(after)) throw new Error('setting did not take');
        record('شتاب‌دهی UDP برای این نشست خاموش شد.', onLog);
    } catch (e) {
        record(`شتاب‌دهی UDP خاموش نشد (${e.message}) — نشست با تنظیم پیش‌فرض سافت‌اتر (روشن) بالا می‌آید.`, onLog);
    } finally {
        for (const f of [file, back]) { try { fs.unlinkSync(f); } catch (e) { /* nothing to remove */ } }
    }
}

/**
 * Strays from an earlier run, removed before we build ours.
 *
 * `AccountImport` renames rather than replaces (see applyUdpOff), so a build that crashed between
 * the delete and the import — or any older build of this app — can have left «MLMVPN_GATEWAY (2)»
 * behind in the user's client. They are ours by name, they are never connected, and leaving them
 * means the list the user sees in SoftEther's own manager slowly fills with our leftovers.
 */
function sweepStrayAccounts() {
    const list = vc('AccountList');
    if (!list.ok) return 0;
    const names = new Set();
    for (const line of list.lines) {
        const m = line.match(/\|\s*(MLMVPN_GATEWAY \(\d+\))\s*$/);
        if (m) names.add(m[1]);
    }
    for (const n of names) vc('AccountDelete', n);
    return names.size;
}

/**
 * Connect to one relay.
 *
 * @param opts.host    the relay's DDNS name, e.g. public-vpn-117.opengw.net
 * @param opts.port    443 unless the list says otherwise
 * @param opts.maxTcp  parallel streams; see [MAX_TCP]
 */
async function connect(opts, onLog, onStatus) {
    if (state.connecting || state.connected) return { ok: true, host: state.host };
    if (!isInstalled()) throw new Error('کلاینت سافت‌اتر روی این سیستم نیست.');

    const o = opts || {};
    const host = String(o.host || '').trim();
    if (!host) throw new Error('سروری انتخاب نشده.');
    const port = Number(o.port) || 443;
    const maxTcp = Math.max(1, Math.min(32, Number(o.maxTcp) || MAX_TCP));

    logs = [];
    state.connecting = true;
    state.connected = false;
    state.host = host;
    state.stage = 'connecting';
    state.detail = '';
    state.error = null;
    state.since = null;
    state.nicIp = null;
    // A fresh session knows nothing yet, and a finished one knows nothing any more. Carrying
    // the last answer over would show the UDP channel as up seconds before this session has
    // handshaked, or long after it ended.
    state.udpSupported = null;
    state.udpActive = null;
    state.underlay = '';
    push(onStatus);

    try {
        const nic = ensureNic(onLog);
        // Anything left from a previous run goes first: an account that exists with different
        // settings would be reused silently, and the relay the panel shows would not be the relay
        // carrying the traffic.
        vc('AccountDisconnect', ACCOUNT);
        vc('AccountDelete', ACCOUNT);
        // …and anything an interrupted UDP-off left behind, before we add a fresh one.
        const strays = sweepStrayAccounts();
        if (strays) record(`${strays} اتصال باقی‌مانده از اجرای قبلی پاک شد.`, onLog);

        record(`ساختن اتصال به ${host}…`, onLog);
        const made = vc('AccountCreate', ACCOUNT, `/SERVER:${host}:${port}`, `/HUB:${HUB}`, `/USERNAME:${USER}`, `/NICNAME:${nic}`);
        if (!made.ok) throw new Error(made.error);
        const pw = vc('AccountPasswordSet', ACCOUNT, `/PASSWORD:${PASS}`, '/TYPE:standard');
        if (!pw.ok) throw new Error(pw.error);
        // The line that makes this fast. Full duplex, and no traffic shaping of our own.
        vc('AccountDetailSet', ACCOUNT, `/MAXTCP:${maxTcp}`, '/INTERVAL:1', '/TTL:0',
            '/HALF:no', '/BRIDGE:no', '/MONITOR:no', '/NOTRACK:no', '/NOQOS:no');
        if (readCuration().udp === false) applyUdpOff(onLog);
        // The relays hold a genuine Let's Encrypt certificate for *.opengw.net, so verification
        // would normally pass — but the list also carries volunteer relays whose own certificates
        // are self-signed, and refusing those would silently remove most of the list.
        vc('AccountServerCertDisable', ACCOUNT);

        record('اتصال…', onLog);
        const started = vc('AccountConnect', ACCOUNT);
        if (!started.ok) throw new Error(started.error);

        // WAIT FOR AN ADDRESS, NOT FOR "CONNECTED".
        //
        // The session reports itself established as soon as the hub accepts it, but the adapter has
        // no address until SecureNAT's DHCP answers — and until then nothing routes. Measured, the
        // gap is a second or two on a good relay and forever on a relay that accepts sessions and
        // serves no DHCP.
        const deadline = Date.now() + 45000;
        let ip = null;
        while (Date.now() < deadline) {
            await sleep(1500);
            const st = table(vc('AccountStatusGet', ACCOUNT).lines);
            state.detail = st['Session Status'] || '';
            state.tcpConnections = parseInt(st['Number of TCP Connections'], 10) || 0;
            push(onStatus);
            ip = nicAddress();
            if (ip) break;
            if (/error|retry/i.test(state.detail)) record(`وضعیت: ${state.detail}`, onLog);
        }
        if (!ip) throw new Error('سرور نشست را گرفت ولی آدرسی نداد — سرور دیگری را امتحان کنید.');

        state.nicIp = ip;
        state.connected = true;
        state.connecting = false;
        state.stage = 'connected';
        state.since = Date.now();
        record(`وصل شد — ${host} · آدرس ${ip}`, onLog);
        startPolling(onStatus);
        push(onStatus);
        return { ok: true, host, ip };
    } catch (e) {
        // Never leave a half-made account behind: the next attempt would reuse it.
        vc('AccountDisconnect', ACCOUNT);
        vc('AccountDelete', ACCOUNT);
        state.connecting = false;
        state.connected = false;
        state.stage = 'failed';
        state.error = e.message;
        record(`✗ ${e.message}`, onLog);
        push(onStatus);
        throw e;
    }
}

function disconnect() {
    const was = state.connected || state.connecting;
    stopPolling();
    vc('AccountDisconnect', ACCOUNT);
    vc('AccountDelete', ACCOUNT);
    state.connected = false;
    state.connecting = false;
    state.stage = 'idle';
    state.detail = '';
    state.host = null;
    state.since = null;
    state.nicIp = null;
    // A fresh session knows nothing yet, and a finished one knows nothing any more. Carrying
    // the last answer over would show the UDP channel as up seconds before this session has
    // handshaked, or long after it ended.
    state.udpSupported = null;
    state.udpActive = null;
    state.underlay = '';
    state.tcpConnections = 0;
    return was;
}

/**
 * Is the UDP channel REALLY up, and what is this session actually riding on?
 *
 * The switch is an intention; this is the fact, and on a filtered line they differ. SoftEther
 * brings the UDP channel up some seconds AFTER the SSL one is already carrying traffic, and only
 * if both ends can reach each other over UDP — so on an operator that passes TCP/443 and drops
 * the datagrams, the switch stays on and the channel never comes. A panel that reports the
 * switch is telling the user what they asked for, not what they got.
 *
 * `AccountStatusGet` answers all three. Read by PATTERN, not by exact label: vpncmd is localised
 * (this installation is English, another may not be) and an unmatched label must degrade to
 * «نامشخص», never to a confident «off».
 *
 *   «UDP Acceleration is Supported»   → both ends agreed it is possible
 *   «UDP Acceleration is Active»      → traffic is on it right now
 *   «Physical Underlay Protocol»      → what the session is really riding
 */
function readUnderlay(st) {
    const yes = (v) => /^\s*(yes|true|1|بله)\s*$/i.test(String(v == null ? '' : v));
    let sup = null, act = null, under = '';
    for (const k of Object.keys(st)) {
        if (/udp/i.test(k) && /support/i.test(k)) sup = yes(st[k]);
        else if (/udp/i.test(k) && /activ/i.test(k)) act = yes(st[k]);
        else if (/underlay|physical/i.test(k)) under = String(st[k] || '').trim();
    }
    // Only overwrite what was actually answered. A poll whose reply arrived short must not turn a
    // live UDP channel into «off» for one second and back again — that flicker reads as an
    // unstable connection when nothing moved at all.
    if (sup !== null) state.udpSupported = sup;
    if (act !== null) state.udpActive = act;
    if (under) state.underlay = under;
}

function startPolling(onStatus) {
    stopPolling();
    // ONCE A SECOND, because the traffic feed ticks once a second: a counter that only moves every
    // three seconds makes the live speed a sawtooth — two ticks of zero and one of triple — since
    // the feed divides whatever it sees by its own interval. Affordable only because this goes
    // down the open session; see vcLive.
    poller = setInterval(async () => {
        const st = table(await vcLive('AccountStatusGet ' + ACCOUNT));
        if (!Object.keys(st).length) return;   // a reply that did not arrive is not a disconnect
        const status = st['Session Status'] || '';
        state.detail = status;
        state.tcpConnections = parseInt(st['Number of TCP Connections'], 10) || 0;
        state.sent = num(st['Outgoing Data Size']);
        state.received = num(st['Incoming Data Size']);
        readUnderlay(st);
        // The client reconnects by itself; "connected" follows what it reports rather than what we
        // last saw, so a session that dropped does not keep showing green.
        const live = /established|completed/i.test(status);
        if (state.connected && !live) record(`وضعیت: ${status || 'قطع شد'}`);
        state.connected = live;
        push(onStatus);
    }, 1000);
}

function stopPolling() {
    if (poller) { clearInterval(poller); poller = null; }
    sessionClose();
}

function num(s) { return parseInt(String(s || '').replace(/[^0-9]/g, ''), 10) || 0; }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function push(onStatus) { if (typeof onStatus === 'function') { try { onStatus(getStatus()); } catch (e) { /* gone */ } } }

function isRunning() { return state.connected || state.connecting; }

function getStatus() {
    return {
        installed: isInstalled(),
        installer: !!installerPath(),
        connecting: state.connecting,
        connected: state.connected,
        host: state.host,
        stage: state.stage,
        detail: state.detail,
        error: state.error,
        since: state.since,
        tcpConnections: state.tcpConnections,
        maxTcp: MAX_TCP,
        nicIp: state.nicIp,
        sent: state.sent,
        received: state.received,
        // Rides the status broadcast the panel already listens to, so a sweep needs no channel
        // of its own and cannot disagree with the connection state it is running beside.
        sweep: sweepState(),
        // The switch the user set…
        udp: readCuration().udp !== false,
        // …and what the session is really doing with it. These are not the same thing, and the
        // panel must not report the first as though it were the second.
        udpSupported: state.udpSupported,
        udpActive: state.udpActive,
        underlay: state.underlay,
    };
}

function getLogs() { return logs.slice(); }

/**
 * The session's own byte counters, for traffic-feed.js.
 *
 * `{ up, down }` — THE FEED'S SHAPE, not this module's. It reads `c.up`/`c.down` and drops any
 * sample where they are not finite, silently, so a counter that hands back its own field names is
 * simply never counted: the panel shows bytes moving and the header, the live speed and the usage
 * monitor all stay at zero, with nothing anywhere saying why.
 */
function readTrafficCounters() { return { up: state.sent, down: state.received }; }

// ============================================================
// «فهرست من» و «آرشیو» — the two lists, and what the user has done to them
// ============================================================
//
// THE PROBLEM THIS SOLVES. VPN Gate publishes about a hundred relays at a time and rotates them
// hard — of the 97 in a year-old snapshot, 4 were still listed. `mergeLists` already keeps the
// union of every refresh, so the file on disk grows into a real catalogue (355 rows on this
// machine against 97 from one fetch). But a catalogue is not a shortlist: most of what is in it
// stopped existing months ago, and a connect button that picks out of it is picking out of a
// graveyard.
//
// So there are two lists over the same file, exactly as on Android:
//
//   «فهرست من»  the relays the LAST refresh saw, plus whatever the user promoted, minus whatever
//               they deleted. This is what the connect button chooses from.
//   «آرشیو»     every row on disk. Browsable, testable, and the place to go when nothing in the
//               main list answers — a relay VPN Gate dropped often still works.
//
// Deleting from «فهرست من» is a DENY-LIST, not a delete: the next refresh re-advertises the same
// relay and a plain removal would silently come back. Deleting from the archive removes the row.
// Both are reversible — `restoreHidden()` — because a permanent, invisible deletion of three
// hundred rows on one click is not a feature.

function curationPath() { return path.join(DATA_DIR, 'curation.json'); }

const EMPTY_CURATION = {
    kept: [], hidden: [],
    pings: {},      // host -> ms, 0 = answered nothing (tcpPing's own convention)
    probes: {},     // host -> { ok, ms, reason, at }
    selected: null,
    udp: true,      // SoftEther's UDP acceleration; its own default is on
    fetchedAt: 0,   // when the list was last successfully refreshed BY THIS VERSION
};

let curation = null;

function readCuration() {
    if (curation) return curation;
    let disk = {};
    try { disk = JSON.parse(fs.readFileSync(curationPath(), 'utf8')) || {}; } catch (e) { disk = {}; }
    curation = Object.assign({}, EMPTY_CURATION, disk);
    // Arrays and maps, whatever the file held. A half-written file must degrade to «no curation»,
    // never to a crash on the panel's first paint.
    curation.kept = Array.isArray(curation.kept) ? curation.kept : [];
    curation.hidden = Array.isArray(curation.hidden) ? curation.hidden : [];
    curation.pings = (curation.pings && typeof curation.pings === 'object') ? curation.pings : {};
    curation.probes = (curation.probes && typeof curation.probes === 'object') ? curation.probes : {};
    return curation;
}

// Debounced, because a sweep writes a result every few hundred milliseconds across hundreds of
// relays and each one would otherwise be a synchronous disk write on the main thread.
let curationTimer = null;
function saveCuration(now) {
    readCuration();
    const write = () => {
        curationTimer = null;
        try {
            ensureDataDir();
            fs.writeFileSync(curationPath(), JSON.stringify(curation), 'utf8');
        } catch (e) { /* the lists are still correct in memory for this session */ }
    };
    if (now) { if (curationTimer) clearTimeout(curationTimer); return write(); }
    if (curationTimer) return;
    curationTimer = setTimeout(write, 1200);
    if (curationTimer.unref) curationTimer.unref();
}

/** `host` as the CSV writes it (no suffix) ↔ as the panel shows it (with one). */
const bare = (h) => String(h || '').replace(/\.opengw\.net$/i, '');
const full = (h) => (bare(h) ? bare(h) + '.opengw.net' : '');

/**
 * The hostnames the most recent refresh actually advertised, or `null` when we cannot tell.
 *
 * `null` is not an error and must not be treated as «none»: before this version's first refresh
 * there is no `fetchedAt` to compare `last-seen.json` against, and an install upgrading into this
 * code would otherwise open onto an empty «فهرست من» with a full archive behind it. Until the
 * first refresh the whole file IS the main list, which is exactly how the panel behaved before.
 */
function liveHosts() {
    const at = readCuration().fetchedAt;
    if (!at) return null;
    const seen = readSeen();
    const out = new Set();
    // A minute of slack: `mergeLists` stamps every fresh row with its own `Date.now()`, and that
    // call and the `fetchedAt` written after it are not the same instant.
    for (const h of Object.keys(seen)) if ((seen[h] || 0) >= at - 60000) out.add(full(h));
    return out.size ? out : null;
}

/**
 * Both lists, the curation over them, and every measurement taken so far.
 *
 * One call, because the panel needs all of it to draw a single row: which list a relay is in,
 * whether it is kept, what its ping was and what the real test said.
 */
function lists() {
    const all = servers();
    const cur = readCuration();
    const hidden = new Set(cur.hidden.map(full));
    const kept = new Set(cur.kept.map(full));
    const live = liveHosts();

    const archive = all.rows;
    const mine = archive.filter((r) =>
        !hidden.has(r.host) && (live === null || live.has(r.host) || kept.has(r.host)));

    return {
        mine, archive,
        kept: [...kept], hidden: [...hidden],
        pings: cur.pings, probes: cur.probes,
        selected: cur.selected, udp: cur.udp !== false,
        source: all.source, at: all.at, fetchedAt: cur.fetchedAt,
    };
}

/** Promote archive rows into «فهرست من» so a refresh cannot drop them again. */
function keep(hosts) {
    const cur = readCuration();
    const set = new Set(cur.kept.map(full));
    const un = new Set(cur.hidden.map(full));
    let n = 0;
    for (const h of hosts || []) {
        const k = full(h);
        if (!k) continue;
        // Keeping something previously deleted has to undo the deletion too, or the row is in
        // both sets and «فهرست من» still will not show it.
        if (un.delete(k)) n++;
        if (!set.has(k)) { set.add(k); n++; }
    }
    cur.kept = [...set];
    cur.hidden = [...un];
    saveCuration();
    return n;
}

/** Undo `keep` — the relay stays in the archive and leaves «فهرست من» when VPN Gate drops it. */
function drop(hosts) {
    const cur = readCuration();
    const set = new Set(cur.kept.map(full));
    let n = 0;
    for (const h of hosts || []) if (set.delete(full(h))) n++;
    cur.kept = [...set];
    saveCuration();
    return n;
}

/**
 * Remove from «فهرست من».
 *
 * A deny-list, not a deletion: the row stays in the archive (so it can be found again) and is
 * suppressed no matter how many times VPN Gate re-advertises it.
 */
function hide(hosts) {
    const cur = readCuration();
    const un = new Set(cur.hidden.map(full));
    const set = new Set(cur.kept.map(full));
    let n = 0;
    for (const h of hosts || []) {
        const k = full(h);
        if (!k) continue;
        set.delete(k);
        if (!un.has(k)) { un.add(k); n++; }
    }
    cur.hidden = [...un];
    cur.kept = [...set];
    if (cur.selected && un.has(full(cur.selected))) cur.selected = null;
    saveCuration();
    return n;
}

/** Remove from the archive — the row itself goes, and comes back only if VPN Gate re-lists it. */
function purge(hosts) {
    const doomed = new Set((hosts || []).map(bare).filter(Boolean));
    if (!doomed.size) return 0;

    const text = readList();
    const lines = String(text || '').split(/\r?\n/);
    const hi = lines.findIndex((l) => l.startsWith('#'));
    if (hi < 0) return 0;
    const cols = lines[hi].replace(/^#/, '').split(',');
    const iHost = cols.indexOf('HostName');
    if (iHost < 0) return 0;

    let n = 0;
    const out = [];
    for (const l of lines) {
        if (!l) continue;
        if (l.startsWith('#') || l.startsWith('*')) { out.push(l); continue; }
        const h = (l.split(',')[iHost] || '').trim();
        if (doomed.has(h)) { n++; continue; }
        out.push(l);
    }
    if (!n) return 0;

    try {
        ensureDataDir();
        fs.writeFileSync(livePath(), out.join(NEWLINE) + NEWLINE, 'utf8');
        // The sidecar describes the list; a host that is gone from one must go from the other or
        // it is kept alive forever by a timestamp nothing can reach.
        const seen = readSeen();
        for (const h of doomed) delete seen[h];
        fs.writeFileSync(seenPath(), JSON.stringify(seen), 'utf8');
    } catch (e) { return 0; }

    forget(hosts);
    return n;
}

/** Bring back everything removed from «فهرست من». The one undo for a bulk delete. */
function restoreHidden() {
    const cur = readCuration();
    const n = cur.hidden.length;
    cur.hidden = [];
    saveCuration(true);
    return n;
}

/** Drop the measurements for relays that no longer exist, so the file cannot grow forever. */
function forget(hosts) {
    const cur = readCuration();
    for (const h of hosts || []) {
        const k = full(h);
        delete cur.pings[k];
        delete cur.probes[k];
    }
    saveCuration();
}

function select(host) {
    const cur = readCuration();
    cur.selected = host ? full(host) : null;
    saveCuration(true);
    return cur.selected;
}

/** SoftEther's UDP acceleration. Refused mid-session, because it only applies at connect. */
function setUdp(on) {
    if (isRunning()) return { ok: false, error: 'برای تغییر این گزینه، اول اتصال را قطع کنید.' };
    const cur = readCuration();
    cur.udp = !!on;
    saveCuration(true);
    return { ok: true, udp: cur.udp };
}

// ============================================================
// The sweeps — «پینگ» and «تست واقعی» over a whole list
// ============================================================
//
// One at a time, on purpose: both saturate the line, and two running together would each make
// the other's numbers wrong. The progress is part of `getStatus()` so it rides the status
// broadcast the panel is already listening to rather than needing a second channel.

const sweep = { kind: null, done: 0, total: 0, startedAt: 0, stop: false };

function sweepState() {
    if (!sweep.kind) return null;
    return { kind: sweep.kind, done: sweep.done, total: sweep.total, startedAt: sweep.startedAt };
}

function sweepRunning() { return !!sweep.kind; }

function cancelSweep() {
    if (!sweep.kind) return false;
    sweep.stop = true;
    return true;
}

/**
 * @param kind   'ping'  — TCP/443 reachability and how long it takes
 *               'probe' — the real SoftEther handshake (gateway-probe.js)
 * @param hosts  the hostnames to test, in the order the panel is showing them
 */
async function startSweep(kind, hosts, onStatus) {
    if (sweep.kind) return { ok: false, error: 'یک تست در حال اجراست.' };
    const rows = lists().archive;
    const want = new Set((hosts || []).map(full));
    // The panel's own order, filtered to rows we actually have. A host the panel knows about and
    // the list does not is a stale page, not a target.
    const targets = (hosts || []).map(full)
        .map((h) => rows.find((r) => r.host === h))
        .filter(Boolean);
    if (!targets.length) return { ok: false, error: 'سروری برای تست نیست.' };

    sweep.kind = kind === 'probe' ? 'probe' : 'ping';
    sweep.done = 0;
    sweep.total = targets.length;
    sweep.startedAt = Date.now();
    sweep.stop = false;

    const cur = readCuration();
    // Throttled: a 350-relay probe lands a result every few hundred ms and a broadcast per result
    // is a websocket frame per result, for a progress bar that moves in whole percent.
    let lastPush = 0;
    const tick = () => {
        sweep.done++;
        const now = Date.now();
        if (now - lastPush > 400 || sweep.done === sweep.total) { lastPush = now; push(onStatus); }
    };

    push(onStatus);
    try {
        if (sweep.kind === 'ping') {
            let i = 0;
            const worker = async () => {
                while (i < targets.length && !sweep.stop) {
                    const row = targets[i++];
                    // The IP where we have one: on a filtered line the DDNS name often resolves
                    // to the operator's sinkhole, and a sinkhole answers instantly — which reads
                    // as a 3 ms relay.
                    cur.pings[row.host] = await tcpPing(row.ip || row.host, 443, 5000);
                    tick();
                    saveCuration();
                }
            };
            await Promise.all(Array.from({ length: Math.min(12, targets.length) }, worker));
        } else {
            const probe = require('./gateway-probe');
            await probe.probeAll(
                // By NAME, not by IP. The handshake is TLS and the relays hold a certificate for
                // the name; more importantly the SNI is what gets a nameless hello past an
                // operator that drops them.
                targets.map((r) => ({ host: r.host, port: 443 })),
                {
                    onResult: (t, r) => {
                        cur.probes[t.host] = r.ok
                            ? { ok: true, ms: r.ms, at: Date.now() }
                            : { ok: false, reason: r.reason, at: Date.now() };
                        tick();
                        saveCuration();
                    },
                    shouldStop: () => sweep.stop,
                });
        }
    } finally {
        const finished = { kind: sweep.kind, done: sweep.done, total: sweep.total, stopped: sweep.stop };
        sweep.kind = null;
        sweep.stop = false;
        saveCuration(true);
        push(onStatus);
        return Object.assign({ ok: true }, finished);
    }
}

/**
 * The relays a test has CONDEMNED — never the merely untested.
 *
 * «حذف خراب‌ها» on a fresh list must not wipe it. A relay with no result is not a bad relay, it
 * is an unmeasured one, and the two are only the same to a button that has not thought about it.
 */
function deadHosts(hosts) {
    const cur = readCuration();
    return (hosts || []).map(full).filter((h) => {
        const pr = cur.probes[h];
        if (pr) return pr.ok === false;
        const pg = cur.pings[h];
        return pg !== undefined && !(pg > 0);
    });
}

/** The relays a test has PASSED — the real test's word first, the ping's only if it is all we have. */
function healthyHosts(hosts) {
    const cur = readCuration();
    const all = (hosts || []).map(full);
    const proven = all.filter((h) => cur.probes[h] && cur.probes[h].ok === true);
    if (proven.length) return proven;
    return all.filter((h) => (cur.pings[h] || 0) > 0);
}

/**
 * The relay to connect to when the user has not chosen one.
 *
 * Opening onto a dead button is the worst first impression this panel can make, and «pick the
 * first row» is how it used to answer — on a list sorted by advertised megabits, which is the one
 * number measured from Japan rather than from here. So: prefer what the real test proved, then
 * what answered a ping, then VPN Gate's own score, and among equals prefer an official relay.
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

module.exports = {
    isInstalled, installerPath, cliPath,
    servers, refreshServers, measure,
    connect, disconnect, isRunning, getStatus, getLogs, readTrafficCounters,
    // «فهرست من» / «آرشیو» and everything the user does to them
    lists, keep, drop, hide, purge, restoreHidden, forget, select, setUdp, suggest,
    startSweep, cancelSweep, sweepRunning, sweepState, deadHosts, healthyHosts,
    ACCOUNT, MAX_TCP, DATA_DIR,
    // exported for testing: the list is the feature, and a parser that drops rows silently would
    // be indistinguishable from a network problem
    _internal: {
        parseCsv, slim, mergeLists, readList, table, vcLive, sessionClose, seedPath, livePath,
        liveSocksPorts, readCuration, saveCuration, curationPath, liveHosts, full, bare,
        applyUdpOff, sweepStrayAccounts, readUnderlay,
    },
};
