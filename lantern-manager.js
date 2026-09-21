'use strict';

/**
 * «لنترن» — Lantern's own core, driven as a local SOCKS5 front.
 *
 * The shape is deliberately the SIMPLEST of the three fronts, because Lantern's core makes its own
 * decisions: there is no ladder to walk and no country to pick. It fetches its proxy list through
 * domain fronting, ranks the proxies itself (a bandit, on measured throughput), and re-picks as they
 * fail. So this file starts one process, watches four lines of its output, and proves the data path —
 * nothing more.
 *
 * What it does NOT do, and why:
 *
 *  - No rung ladder. Psiphon needs one because its three strategies are mutually exclusive and only
 *    one works per line. Lantern's core tries everything at once internally.
 *  - No country list. The free tier gives whatever exit the bandit ranks best; it is reported after
 *    the fact (`[lantern] exit …`) rather than chosen.
 *  - No byte counters. The core has none to report, exactly like tor.exe — in full-tunnel mode
 *    sing-box counts the bytes, and in proxy mode nothing does. Inventing a number here would be
 *    worse than showing none.
 *
 * The binary is `core/lantern.exe`, built from getlantern/flashlight (GPL-3.0) with a `main` of our
 * own; see docs/LANTERN-BUILD.md for the four patches that build needs, all of which are required
 * for it to work from Iran at all.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

/**
 * 20840/20841, continuing the block the other fronts sit in (Tor 20820, Psiphon 20830).
 *
 * Both listeners are published because they are not interchangeable: the SOCKS one is what the app
 * uses (sing-box dials it, and it carries hostnames), while the HTTP one is what Lantern's own app
 * uses and is kept as the fallback for anything that cannot speak SOCKS.
 */
const SOCKS_PORT = 20840;
const HTTP_PORT = 20841;

const LANTERN_DATA_DIR = path.join(os.homedir(), '.mlmvpn', 'lantern');

function binPath() {
    const base = process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'core'))
        ? process.resourcesPath
        : __dirname;
    return require('./core-paths').file('lantern', 'lantern.exe', path.join(base, 'core', 'lantern.exe'));
}

function isInstalled() { return fs.existsSync(binPath()); }

function ensureDataDir() {
    try { fs.mkdirSync(LANTERN_DATA_DIR, { recursive: true }); } catch (e) { /* already there */ }
    return LANTERN_DATA_DIR;
}

/**
 * A device id that survives restarts.
 *
 * Lantern's config service hands out proxies per device, and a client that invents a new id on every
 * launch looks like a new device every time — which is both worse for the user (no history behind
 * the ranking) and rude to a free service. So it is generated once and kept.
 */
function deviceId() {
    const f = path.join(ensureDataDir(), 'device-id');
    try {
        const kept = fs.readFileSync(f, 'utf8').trim();
        if (kept) return kept;
    } catch (e) { /* first run */ }
    const id = 'mlmvpn-' + require('crypto').randomBytes(8).toString('hex');
    try { fs.writeFileSync(f, id, 'utf8'); } catch (e) { /* not fatal, just not sticky */ }
    return id;
}

// ── State ──────────────────────────────────────────────────────────────────

const state = {
    running: false,
    connected: false,
    stage: 'idle',        // idle | starting | listening | testing | up
    detail: '',
    exitCity: '',
    exitCountry: '',
    exitCode: '',
    proxyOk: false,       // the core says a proxy is carrying traffic
    since: null,
    error: null,
    // Addresses whose TCP dial never completed, and whether ANY dial ever did. Together these
    // separate "the network is blocking Lantern" from "the engine has not finished starting".
    deadDials: new Set(),
    anyDialOk: false,
    // Set when a sweep sampled the pool broadly and not one server accepted a connection. The
    // other two fields are filled from the CORE's log lines, so on the sweep path — where no core
    // is ever started — they stay empty and the engine would otherwise report itself unblocked
    // while telling the user its servers are shut.
    poolShut: false,
};

let proc = null;
let cancelled = false;
let logs = [];
const MAX_LOGS = 300;

function record(line, onLog) {
    const text = `[لنترن] ${line}`;
    logs.push(text);
    if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
    if (onLog) { try { onLog(text); } catch (e) { /* the UI is gone */ } }
}

function killProc() {
    if (!proc) return;
    const p = proc;
    proc = null;
    try { p.kill(); } catch (e) { /* already gone */ }
    // SIGTERM does not exist on Windows, and a Go process that ignores the console event would
    // otherwise keep 20840 bound and make the next connect fail on bind.
    try { require('child_process').execFile('taskkill', ['/F', '/PID', String(p.pid)], () => { }); } catch (e) { /* nothing to do */ }
}

/** Persian for the country names the core reports, so the panel is not half English. */
const COUNTRY_FA = {
    Germany: 'آلمان', Netherlands: 'هلند', 'United States': 'آمریکا', France: 'فرانسه',
    'United Kingdom': 'انگلیس', Canada: 'کانادا', Sweden: 'سوئد', Finland: 'فنلاند',
    Singapore: 'سنگاپور', Japan: 'ژاپن', Ireland: 'ایرلند', Poland: 'لهستان',
    Switzerland: 'سوئیس', Austria: 'اتریش', Spain: 'اسپانیا', Italy: 'ایتالیا',
    Belgium: 'بلژیک', Norway: 'نروژ', Denmark: 'دانمارک', India: 'هند',
    Australia: 'استرالیا', Brazil: 'برزیل', Romania: 'رومانی', Turkey: 'ترکیه',
};

function exitLabel() {
    if (!state.exitCountry && !state.exitCity) return '';
    const country = COUNTRY_FA[state.exitCountry] || state.exitCountry || state.exitCode;
    return state.exitCity ? `${state.exitCity} — ${country}` : country;
}

// ── Starting ───────────────────────────────────────────────────────────────

/**
 * How long to wait for each half.
 *
 * The listeners come up in about a second, but a listener is not a connection: on a cold profile the
 * core still has to reach its config service through domain fronting, and that is the slow part —
 * measured at 8 to 30 seconds from an Iranian line, against a warm start of about 2. So the budget
 * is generous and the DATA PATH decides, not the clock.
 */
const LISTEN_TIMEOUT_MS = 25_000;

/**
 * 60 s, because that is one config fetch PLUS its first retry.
 *
 * The core fetches its proxy list through domain fronting and, when that request times out, backs
 * off 20 s, then 40, then 80. Measured on this line: a good cold start has proxies in 20–45 s, and a
 * bad one had nothing for over three minutes. So the budget covers the retry, and the case beyond it
 * is not a failure — see [watchDataPath].
 */
const DATA_TIMEOUT_MS = 60_000;

/**
 * Start the engine.
 *
 * @param opts.proxyAll  true (default) sends everything through Lantern. false lets the core's own
 *                       routing rules send unblocked sites direct, which is faster but tells the
 *                       local network which sites you are visiting.
 * @param opts.proxy     an upstream proxy to chain through, `host:port`. Unused so far; it exists
 *                       because the other two fronts take one and chaining is a planned feature.
 */
function startOnce(opts, onLog, onStatus) {
    const o = opts || {};
    return new Promise((resolve, reject) => {
        if (!isInstalled()) return reject(new Error('فایل core/lantern.exe موجود نیست.'));
        if (proc) return reject(new Error('لنترن همین حالا روشن است.'));

        cancelled = false;
        // The log is NOT cleared here any more. startOnce is now one draw out of several, and
        // wiping it per draw would throw away exactly the lines that explain why there was a
        // second draw — the user would see the last attempt and no reason for it.
        state.running = true;
        state.connected = false;
        state.stage = 'starting';
        state.detail = 'راه‌اندازی هسته';
        state.exitCity = state.exitCountry = state.exitCode = '';
        state.proxyOk = false;
        state.since = null;
        state.error = null;
        state.deadDials = new Set();
        state.anyDialOk = false;
        push(onStatus);

        const args = [
            '-socks', `127.0.0.1:${SOCKS_PORT}`,
            '-http', `127.0.0.1:${HTTP_PORT}`,
            '-configdir', ensureDataDir(),
            '-deviceid', deviceId(),
            // `-proxyall=false`, with the EQUALS SIGN. Go's flag package treats a boolean
            // flag's value as a separate argument only for `=`: `-proxyall false` sets the
            // flag to TRUE and then reads `false` as a positional, which silently does the
            // opposite of what the user chose — and stops flag parsing at that point.
            o.proxyAll === false ? '-proxyall=false' : '-proxyall=true',
        ];

        record(`شروع · پروکسی محلی ${SOCKS_PORT}`, onLog);

        try {
            // PROXYLESS STAYS ON, and this is measured, not assumed.
            //
            // The core races two dialers per destination: the proxied one, and a "proxyless" one
            // that reaches the site directly with TLS tricks. Turning the second one off looked
            // obviously right — it is given a hard 20 s budget and its verdict is cached per
            // domain, which is where "connected but nothing loads for twenty seconds" comes from.
            //
            // So it was turned off and measured, and it is the opposite of right: with
            // PROXYLESS=false, youtube, instagram, x and reddit all TIMED OUT at 30 s while github,
            // google, duckduckgo and wikipedia loaded in 3–6 s. The proxyless path is what opens the
            // filtered sites on this line; the engine's own servers were not carrying them. Racing
            // both is the design, and the race is what works.
            //
            // The twenty seconds is therefore a real cost of a real feature, and the answer to it is
            // not to remove the feature but to stop calling the engine connected while it is still
            // paying it — see carriesWarm.
            proc = spawn(binPath(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            state.running = false;
            state.stage = 'idle';
            state.error = e.message;
            push(onStatus);
            return reject(e);
        }

        let settled = false;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            clearTimeout(listenTimer);
            fn(arg);
        };

        let listening = false;
        const onListening = async () => {
            if (listening) return;
            listening = true;
            state.stage = 'testing';
            state.detail = 'آزمایش مسیر داده';
            push(onStatus);
            record('پورت محلی باز شد — در حال آزمایش مسیر داده', onLog);

            // THE DATA PATH DECIDES. The core opens its listeners before it has a single working
            // proxy, so "listening" on its own would report a connection that carries nothing —
            // which is exactly how this engine failed on the first build here.
            const carries = await carriesWarm(Number(o.dataTimeoutMs) || DATA_TIMEOUT_MS, () => cancelled);
            if (cancelled) return;
            if (!carries) {
                const b = blockedReason();
                record(b ? b.log : 'هنوز ترافیکی رد نشده — همچنان تلاش می‌کند', onLog);
                state.connected = false;
                state.stage = 'listening';
                state.detail = b ? b.detail : 'در انتظار سرور';
                push(onStatus);
                // The engine STAYS UP and keeps being watched. Killing it here would throw away a
                // start that is still waiting on one retry of its config fetch, which on this line
                // is the difference between "three minutes" and "never".
                watchDataPath(onLog, onStatus);
                return finish(resolve, {
                    ok: true,
                    blocked: !!b,
                    warning: b ? b.warning
                        : 'هسته بالا آمد ولی هنوز سروری پیدا نکرده. روشن می‌ماند و خودش ادامه می‌دهد — تا دو دقیقه صبر کنید.',
                });
            }
            state.connected = true;
            state.stage = 'up';
            state.detail = '';
            state.since = Date.now();
            push(onStatus);
            record(`وصل شد${exitLabel() ? ' — خروج از ' + exitLabel() : ''}`, onLog);
            // Keep this identity. On this line a working batch is the scarce thing, not a new one.
            saveProven(onLog);
            finish(resolve, { ok: true, exit: exitLabel(), socksPort: SOCKS_PORT });
        };

        const line = (raw) => {
            const s = String(raw).trim();
            if (!s) return;

            // ONE exception to "only our lines": the core names every proxy dial it makes, and
            // that is the only place the difference between "still starting" and "these servers
            // are unreachable from this line" exists. Matched loosely on purpose — if upstream
            // changes the wording we lose a better error message and nothing else.
            const dead = /failed in [\d.]+s with: dial tcp ([\d.]+):\d+: i\/o timeout/.exec(s);
            if (dead) { state.deadDials.add(dead[1]); return; }
            if (/Dialer .* succeeded|Successfully dialed|Enabling multiplexing for/.test(s)) {
                // Not proof of a working path — but proof that reaching the servers is not what
                // is wrong, which is enough to stop blaming the network for it.
                if (/succeeded|Successfully dialed/.test(s)) state.anyDialOk = true;
                return;
            }

            // Only OUR lines are events. flashlight's own logger writes thousands of DEBUG lines per
            // connect — including one per retry of its blocked DoH resolver — and putting those in
            // front of a user would bury the four that mean something.
            const m = /^\[lantern\]\s*(.*)$/.exec(s);
            if (!m) return;
            const ev = m[1];

            if (/^listening/.test(ev)) return onListening();

            if (/^proxy ok/.test(ev)) {
                state.proxyOk = true;
                record('هسته یک سرور فعال پیدا کرد', onLog);
                push(onStatus);
                return;
            }

            const ex = /^exit\s+(.*)$/.exec(ev);
            if (ex) {
                const [city, country, code] = ex[1].split('|');
                state.exitCity = (city || '').trim();
                state.exitCountry = (country || '').trim();
                state.exitCode = (code || '').trim();
                record(`خروج از ${exitLabel()}`, onLog);
                push(onStatus);
                return;
            }

            if (/^error/.test(ev)) { record(ev, onLog); return; }
            if (/^starting/.test(ev)) return;   // already said, in Persian
            record(ev, onLog);
        };

        let outBuf = '';
        const feed = (chunk) => {
            outBuf += chunk.toString('utf8');
            const parts = outBuf.split(/\r?\n/);
            outBuf = parts.pop();
            parts.forEach(line);
        };
        proc.stdout.on('data', feed);
        proc.stderr.on('data', feed);

        proc.on('error', (e) => {
            state.running = false;
            state.stage = 'idle';
            state.error = e.message;
            push(onStatus);
            finish(reject, e);
        });

        proc.on('exit', (code) => {
            proc = null;
            stopWatching();
            const was = state.connected;
            state.running = false;
            state.connected = false;
            state.stage = 'idle';
            state.since = null;
            if (!cancelled) {
                state.error = `هسته بسته شد (کد ${code})`;
                record(state.error, onLog);
            }
            push(onStatus);
            // An exit AFTER a successful connect is not this promise's business — it already
            // resolved — but an exit before one is the failure.
            if (!was) finish(reject, new Error(state.error || 'هسته بسته شد'));
        });

        const listenTimer = setTimeout(() => {
            if (listening) return;
            record('پورت محلی در زمان مقرر باز نشد', onLog);
            stopLantern();
            finish(reject, new Error('لنترن در زمان مقرر بالا نیامد.'));
        }, LISTEN_TIMEOUT_MS);
    });
}

/**
 * "Lantern's servers are unreachable from here" — as a fact, not a guess.
 *
 * Two dead addresses and not one completed dial is not a slow start: it is the operator dropping
 * packets to the addresses this engine was given. Measured on MCI, 2026-09-13 — six addresses
 * across two device identities, every one `i/o timeout` with `time_connect` at zero, while
 * ordinary hosts on the same provider connected in 0.44 s.
 *
 * Telling the user to wait in that situation is the one piece of advice that cannot work, and this
 * engine cannot route around it: its config arrives by domain fronting, but its DATA goes to those
 * addresses directly. The one thing that helps is a different engine, so that is what it says.
 */
function blockedReason() {
    const n = state.deadDials.size || (state.poolShut ? SWEEP_WIDTH * SWEEP_ROUNDS * 3 : 0);
    if (state.anyDialOk || n < 2) return null;
    const fa = (x) => String(x).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
    return {
        detail: 'سرورهای لنترن از این خط بسته‌اند',
        log: `هر ${fa(n)} سرور لنترن از این خط بی‌جواب‌اند — بسته‌ها اصلاً نمی‌رسند`,
        warning: `اینترنت شما آدرس سرورهای لنترن را بسته است: هر ${fa(n)} آدرسی که هسته گرفت بی‌جواب ماند. `
            + 'این را هیچ تنظیمی درست نمی‌کند — بر خلاف سایفون، مسیر دادهٔ لنترن مستقیم به همان آدرس‌ها می‌رود. '
            + 'می‌توانید «یک دستهٔ سرور دیگر» را امتحان کنید — سرورها به‌ازای هر شناسه فرق می‌کنند، پس دستهٔ بعدی '
            + 'ممکن است باز باشد. اگر آن هم نشد، فعلاً یکی از موتورهای دیگر را روشن کنید؛ این فهرست چرخشی است '
            + 'و معمولاً چند ساعت بعد باز می‌شود.',
        // The panel shows this as a button, and it is only ever offered in this state.
        canRotate: true,
    };
}

/**
 * Ask for a different set of servers.
 *
 * MEASURED, which is the only reason this exists. With Lantern reporting every server blocked, its
 * three assigned addresses were 130.61.115.243, 132.145.28.165 and 158.101.197.155 — none of which
 * accepted TCP on any port, while Oracle's own site answered on the same line. Clearing the device
 * identity and restarting produced a DIFFERENT three: 51.170.181.235, 130.61.235.238,
 * 140.238.102.119. So the assignment is per-device, and a fresh draw is a real move.
 *
 * It is NOT sold as a fix. On the day it was written both sets were dead — the block was wider than
 * any one batch — and the wording says so. What it is good for is the common case: a partial block,
 * where some of the pool is reachable and this line simply drew the wrong three.
 *
 * `user.conf` is the assigned list and `device-id` is what it is keyed to. Both go; everything else
 * in the profile (the fronting cache, the TLS session states) is kept, because throwing those away
 * costs a slow cold start for no benefit.
 */
function rotateIdentity() {
    const dir = ensureDataDir();
    const before = assignedProxies();
    let removed = 0;
    for (const f of ['device-id', 'user.conf']) {
        try { fs.unlinkSync(path.join(dir, f)); removed++; } catch (e) { /* already gone */ }
    }
    return { ok: removed > 0, removed, before };
}

/**
 * The proxy addresses currently assigned, read from the profile.
 *
 * Shown to the user so «سرورها بسته‌اند» is a statement with evidence attached rather than an
 * assertion. The client's own public address is in the same file and is excluded — reporting the
 * user's IP back to them as a "server" would be confusing and a small privacy wart.
 */
function assignedProxies() {
    try {
        const t = fs.readFileSync(path.join(ensureDataDir(), 'user.conf'), 'latin1');
        const found = [...new Set(t.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [])];
        // The first address in the file is the client's own, as the config service saw it.
        const mine = (t.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || [])[0];
        return found.filter(x => x !== mine);
    } catch (e) { return []; }
}

/**
 * The profile that last carried traffic, kept so a success can be replayed.
 *
 * Lantern assigns its servers PER DEVICE IDENTITY. That is normally a detail; on a line where the
 * pool is opened and shut it is the one thing worth saving, because the identity that drew a
 * working batch is reproducible while a fresh draw is a coin toss.
 *
 * MEASURED 2026-09-14: three assigned servers all answered at 10:58 and all refused TCP at 11:05,
 * still refusing after five minutes of quiet, while oracle.com on the same provider answered
 * throughout. Fifteen freshly drawn addresses across five draws were dead in that window. So
 * redrawing is not the lever it looks like — remembering is.
 *
 * Only `device-id` and `user.conf` are kept, the same pair `rotateIdentity` removes: the identity
 * and the list it is keyed to. The fronting cache and TLS session states are deliberately left
 * alone, because they are current-state caches and restoring stale ones buys a slow start.
 */
const PROVEN_DIR = path.join(LANTERN_DATA_DIR, 'proven');
const PROFILE_FILES = ['device-id', 'user.conf'];

function provenInfo() {
    try {
        const meta = JSON.parse(fs.readFileSync(path.join(PROVEN_DIR, 'meta.json'), 'utf8'));
        const have = PROFILE_FILES.every(f => fs.existsSync(path.join(PROVEN_DIR, f)));
        if (!have) return null;
        return { at: meta.at || null, proxies: Array.isArray(meta.proxies) ? meta.proxies : [] };
    } catch (e) { return null; }
}

/** Snapshot the current profile. Called only once the data path is PROVEN, never on "listening". */
function saveProven(onLog) {
    try {
        fs.mkdirSync(PROVEN_DIR, { recursive: true });
        const dir = ensureDataDir();
        for (const f of PROFILE_FILES) fs.copyFileSync(path.join(dir, f), path.join(PROVEN_DIR, f));
        const proxies = assignedProxies();
        fs.writeFileSync(path.join(PROVEN_DIR, 'meta.json'),
            JSON.stringify({ at: Date.now(), proxies }), 'utf8');
        if (onLog) record('این دسته کار کرد — برای دفعهٔ بعد ذخیره شد', onLog);
        return true;
    } catch (e) { return false; }
}

/** Put the remembered profile back. The caller has already checked its servers answer. */
function restoreProven() {
    try {
        const dir = ensureDataDir();
        for (const f of PROFILE_FILES) fs.copyFileSync(path.join(PROVEN_DIR, f), path.join(dir, f));
        return true;
    } catch (e) { return false; }
}

function push(onStatus) {
    if (!onStatus) return;
    try { onStatus(getStatus()); } catch (e) { /* the UI is gone */ }
}

/**
 * Keep looking, after the connect gave up waiting.
 *
 * Without this the engine would sit at "waiting for a server" for ever even once traffic started
 * flowing, because nothing would ever re-ask: the first probe is the only one, and it ran out during
 * the config fetch's backoff. Measured case — a cold start where the first fronted request timed out
 * carried nothing for 214 s and then would have worked.
 *
 * Slowly (every 10 s) and not for ever (4 minutes): past that the backoff has reached 160 s and the
 * honest answer is that this line is not getting through to the config service right now.
 */
let watcher = null;
const WATCH_EVERY_MS = 10_000;
const WATCH_FOR_MS = 240_000;

function watchDataPath(onLog, onStatus) {
    stopWatching();
    const until = Date.now() + WATCH_FOR_MS;
    watcher = setInterval(async () => {
        if (!proc || cancelled || state.connected) return stopWatching();
        if (Date.now() > until) {
            stopWatching();
            const b = blockedReason();
            state.detail = b ? b.detail : 'سروری پیدا نشد';
            state.error = b ? b.warning : 'هسته بالا است ولی سروری پیدا نکرد. یک بار قطع و وصل کنید.';
            record(b ? b.log : state.error, onLog);
            push(onStatus);
            return;
        }
        // A short budget per round: this is a poll, not the initial wait, and a 60 s probe here
        // would overlap the next tick.
        if (!await carriesWarm(20_000, () => cancelled)) return;
        if (!proc || cancelled) return stopWatching();
        stopWatching();
        state.connected = true;
        state.stage = 'up';
        state.detail = '';
        state.error = null;
        state.since = Date.now();
        record(`وصل شد${exitLabel() ? ' — خروج از ' + exitLabel() : ''}`, onLog);
        push(onStatus);
    }, WATCH_EVERY_MS);
}

function stopWatching() { if (watcher) { clearInterval(watcher); watcher = null; } }

function stopLantern() {
    const was = state.running;
    cancelled = true;
    stopWatching();
    killProc();
    state.running = false;
    state.connected = false;
    state.stage = 'idle';
    state.detail = '';
    state.since = null;
    state.proxyOk = false;
    return was;
}

/**
 * Can this line reach any of these servers?
 *
 * A plain TCP connect, in parallel, with a short budget. This is deliberately NOT the core's own
 * judgement: the core dials each server and waits out its timeout, which takes about seventy
 * seconds for a dead batch. The same three addresses answer — or do not — in about six.
 *
 * 443 then 80, because that is where Lantern's servers listen; a server that refuses both is not
 * one this line can use, whatever the reason.
 */
function anyReachable(list, { timeoutMs = 6000 } = {}) {
    const one = (ip, port) => new Promise(res => {
        const sock = new net.Socket();
        let done = false;
        const end = (ok) => { if (!done) { done = true; try { sock.destroy(); } catch (e) { } res(ok); } };
        sock.setTimeout(timeoutMs, () => end(false));
        sock.once('error', () => end(false));
        sock.connect(port, ip, () => end(true));
    });
    return Promise.all((list || []).map(async ip => (await one(ip, 443)) || (await one(ip, 80))))
        .then(rs => rs.some(Boolean));
}

/**
 * Draw several batches AT ONCE and keep the first that this line can reach.
 *
 * MEASURED 2026-09-14, and the numbers are the entire reason this exists. Of the 28 distinct
 * addresses this engine was handed over the course of the day, exactly one accepted a connection —
 * 140.238.100.165, at 128 ms, on three separate occasions hours apart — and the other 27 refused
 * every time. Controls on the same line in the same minute: oracle.com and cloudflare both fine.
 *
 * So the pool is not shut, it is mostly shut. A draw is three servers out of a pool where roughly
 * one in twenty-eight is open, which hits an open one about a tenth of the time. Five sequential
 * draws is therefore a coin toss, and it lost twice today.
 *
 * The cost of a draw is why sequence is the problem: the core must start and fetch a config before
 * it will name its three servers, which is about twenty seconds, so twelve draws is six minutes.
 * But a draw is just a device identity asking the config service what it gets, and identities are
 * independent — so they can be taken side by side. Three cores with three private config
 * directories give three batches for one twenty-second wait.
 *
 * Each core is killed the instant its `user.conf` appears; none of them is ever asked to carry
 * traffic. The winning batch is copied into the real profile and started once, the ordinary way.
 */
const SWEEP_WIDTH = 3;       // cores at a time
const SWEEP_ROUNDS = 3;      // so up to 9 batches, ~27 addresses sampled
const SWEEP_PORT0 = 20860;   // well clear of SOCKS_PORT/HTTP_PORT and of the other engines

function sweepDir(i) { return path.join(LANTERN_DATA_DIR, 'draw', String(i)); }

/** One throwaway core in its own profile, killed as soon as it says which servers it was given. */
function drawOne(i, budgetMs) {
    return new Promise(resolve => {
        const dir = sweepDir(i);
        let child = null;
        try {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            // The fronting cache is the one thing worth copying in: without it every throwaway core
            // rediscovers its fronting domains from scratch, which is most of the twenty seconds.
            // It is a cache of public CDN domains, so sharing it carries nothing user-specific.
            for (const f of ['fronted_cache.json', 'global.yaml']) {
                try { fs.copyFileSync(path.join(LANTERN_DATA_DIR, f), path.join(dir, f)); } catch (e) { /* optional */ }
            }
            // The identity has to be WRITTEN, not just passed. `device-id` is our file, not the
            // core's: the core takes the id on the command line and never records it, so a swept
            // profile copied into place without this would arrive with no identity — and the real
            // start would mint a fresh one and draw a different batch, throwing away the very thing
            // the sweep just found. (Measured: the first sweep found a reachable batch in round 1
            // and lost it to `ENOENT … copyfile … draw\0\device-id`.)
            const id = 'draw-' + require('crypto').randomBytes(5).toString('hex');
            fs.writeFileSync(path.join(dir, 'device-id'), id, 'utf8');
            child = spawn(binPath(), [
                '-socks', `127.0.0.1:${SWEEP_PORT0 + i * 2}`,
                '-http', `127.0.0.1:${SWEEP_PORT0 + i * 2 + 1}`,
                '-configdir', dir,
                '-deviceid', id,
                '-proxyall=false',
            ], { windowsHide: true, stdio: 'ignore' });
        } catch (e) {
            return resolve([]);
        }

        const conf = path.join(dir, 'user.conf');
        const deadline = Date.now() + budgetMs;
        let done = false;
        const stop = (list) => {
            if (done) return;
            done = true;
            clearInterval(poll);
            try { child.kill(); } catch (e) { /* already gone */ }
            try {
                require('child_process').execFile('taskkill', ['/F', '/PID', String(child.pid)], () => { });
            } catch (e) { /* nothing to do */ }
            resolve(list);
        };
        const poll = setInterval(() => {
            if (Date.now() > deadline) return stop([]);
            let t = '';
            try { t = fs.readFileSync(conf, 'latin1'); } catch (e) { return; }
            const found = [...new Set(t.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) || [])];
            if (!found.length) return;
            const mine = found[0];   // the client's own address, as the config service saw it
            stop(found.filter(x => x !== mine));
        }, 700);
    });
}

/**
 * Run the sweep. Returns the index of a batch this line can reach, or null.
 *
 * On success the winning profile is already in place: its `device-id` and `user.conf` are copied over
 * the real ones, so the caller just starts normally.
 */
async function drawSweep(onLog, isCancelled) {
    for (let round = 0; round < SWEEP_ROUNDS; round++) {
        if (isCancelled && isCancelled()) return null;
        record(`جست‌وجوی موازی، دور ${round + 1} از ${SWEEP_ROUNDS} — ${SWEEP_WIDTH} دستهٔ همزمان`, onLog);

        const batches = await Promise.all(
            Array.from({ length: SWEEP_WIDTH }, (_, k) => drawOne(round * SWEEP_WIDTH + k, 60000)));

        // Test every address from every batch in one go, then attribute the hits back to batches.
        const flat = [...new Set(batches.flat())];
        if (!flat.length) { record('این دور هیچ فهرستی نگرفت', onLog); continue; }
        const live = new Set();
        await Promise.all(flat.map(async ip => { if (await anyReachable([ip])) live.add(ip); }));

        record(`${flat.length} آدرس آزموده شد — ${live.size} تای‌شان جواب می‌دهند`, onLog);

        const winner = batches.findIndex(b => b.some(ip => live.has(ip)));
        if (winner >= 0) {
            const i = round * SWEEP_WIDTH + winner;
            const hit = batches[winner].filter(ip => live.has(ip));
            try {
                const dir = ensureDataDir();
                for (const f of PROFILE_FILES) fs.copyFileSync(path.join(sweepDir(i), f), path.join(dir, f));
            } catch (e) {
                record('دستهٔ سالم پیدا شد ولی جایگزینی پروفایل نشد: ' + e.message, onLog);
                continue;
            }
            record(`دستهٔ سالم پیدا شد (${hit.join('، ')}) — همان استفاده می‌شود`, onLog);
            cleanSweep();
            return i;
        }
    }
    cleanSweep();
    return null;
}

/** The throwaway profiles are worth nothing once the sweep is over, and each is a few hundred KB. */
function cleanSweep() {
    try { fs.rmSync(path.join(LANTERN_DATA_DIR, 'draw'), { recursive: true, force: true }); } catch (e) { }
}

/** How many identities to burn before giving up. Each costs seconds, not minutes — see anyReachable. */
const MAX_DRAWS = 5;

/**
 * Start Lantern, drawing a new batch of servers whenever this line cannot reach the one it got.
 *
 * MEASURED 2026-09-14: two consecutive draws were entirely dead, and the third contained a
 * reachable server. The pool is partially blocked on this line, not wholly — so the difference
 * between "Lantern does not work here" and "Lantern works here" is whether anything redraws.
 *
 * A button for that was the first answer and it was the wrong one: asking somebody to press a
 * thing repeatedly until they get lucky is not a feature. The engine does it.
 */
async function startLantern(opts, onLog, onStatus) {
    const o = opts || {};
    let maxDraws = Number(o.maxDraws) || MAX_DRAWS;
    state.poolShut = false;
    logs = [];   // one session, however many draws it takes

    let lastErr = null;
    // How many draws were discarded because NOT ONE of their servers accepted a TCP connection.
    // When that is every draw, waiting is provably useless — see the final-draw branch below.
    let mute = 0;

    for (let draw = 1; draw <= maxDraws; draw++) {
        // The profile usually still holds last time's batch. Testing it costs six seconds and can
        // save a minute of starting into servers already known to be unreachable.
        const held = assignedProxies();
        let heldOk = false;
        if (held.length) {
            heldOk = await anyReachable(held);
            if (!heldOk) record(`دستهٔ فعلی (${held.join('، ')}) از این خط بی‌جواب است`, onLog);
        }
        if (!heldOk) {
            // BEFORE drawing blind, try the batch that is known to have carried. A fresh draw is a
            // coin toss; a batch with a proven history is the best evidence available, and its
            // servers are tested here rather than assumed, so a remembered batch that has since
            // been blocked costs six seconds and nothing else.
            const kept = provenInfo();
            const alreadyOn = kept && held.length && kept.proxies.length &&
                kept.proxies.every(x => held.includes(x));
            if (kept && !alreadyOn && await anyReachable(kept.proxies)) {
                if (restoreProven()) {
                    record('دستهٔ ذخیره‌شده‌ای که قبلاً کار کرده جواب می‌دهد — همان استفاده می‌شود', onLog);
                } else {
                    rotateIdentity();
                }
            } else if (draw === 1) {
                // The sweep samples up to nine batches. If it finds one, it has already put it in
                // place and this start proceeds normally.
                //
                // If it finds NOTHING, stop here. The sequential draws below would sample five
                // batches — fewer than the sweep just did, and from the same pool — so spending two
                // and a half more minutes on them cannot learn anything the sweep has not already
                // established. Measured today: 27 of 28 addresses refused TCP all day and a dry
                // sweep was followed by five dry draws, every time.
                const hit = await drawSweep(onLog, () => cancelled);
                if (hit !== null) {
                    // The sweep has already sampled nine batches from this pool. If the one it
                    // picked — a batch whose servers demonstrably answer — turns out not to carry,
                    // that is no longer a reachability problem, and the four remaining blind draws
                    // are exactly the low-yield sampling the sweep was built to replace. One more
                    // is worth taking, because a different server may carry where this one does
                    // not; four more is five minutes spent to say the same thing.
                    maxDraws = Math.min(maxDraws, 2);
                }
                if (hit === null) {
                    if (cancelled) throw new Error('لغو شد');
                    state.poolShut = true;
                    state.error = `سرورهای لنترن از این خط بسته‌اند: ${SWEEP_WIDTH * SWEEP_ROUNDS} دستهٔ `
                        + 'جداگانه گرفته شد و هیچ سروری حتی یک اتصال هم نپذیرفت. این را هیچ تنظیمی در برنامه '
                        + 'درست نمی‌کند؛ فهرست سرورهای لنترن چرخشی است و معمولاً چند ساعت بعد باز می‌شود. '
                        + 'تا آن موقع یکی از موتورهای دیگر را روشن کنید.';
                    record(state.error, onLog);
                    // No core was ever started on this path — the sweep kills its own — so the
                    // engine must not be left looking like it is up.
                    state.running = false;
                    state.stage = 'idle';
                    state.detail = 'سرورهای لنترن از این خط بسته‌اند';
                    push(onStatus);
                    throw new Error(state.error);
                }
            } else {
                record('دستهٔ تازه‌ای گرفته می‌شود', onLog);
                rotateIdentity();
            }
        }

        // Watch for the batch this draw is given, and discard it early if none of it is reachable.
        // Without this the core spends about seventy seconds proving what a TCP connect shows in
        // six, and five draws would take the better part of ten minutes.
        let abandoned = false;
        const watcher = setInterval(async () => {
            if (!proc || state.connected || abandoned) return;
            const got = assignedProxies();
            if (!got.length) return;
            clearInterval(watcher);
            if (await anyReachable(got)) {
                record(`دستهٔ ${draw}: حداقل یک سرور از این خط جواب می‌دهد — ادامه`, onLog);
                return;
            }
            if (!proc || state.connected) return;
            // The final draw is normally left alone. There is nothing behind it, and killing it
            // would replace "up and still trying" — which is Lantern's own design, and a measured
            // cold start did carry nothing for 214 s and then work — with "off and failed".
            //
            // UNLESS NOTHING HAS ANSWERED AT ALL. If every draw before this one was also refused at
            // the TCP layer, there is nothing to wait for: no config fetch is in flight, no backoff
            // is running, the addresses are simply not there. Staying up for four more minutes with
            // the panel saying "connecting" is then a lie told slowly, so it stops and says what is
            // actually wrong.
            if (draw >= maxDraws) {
                if (mute < maxDraws - 1) {
                    record('آخرین دسته هم بی‌جواب است، ولی روشن می‌ماند و خودش ادامه می‌دهد', onLog);
                    return;
                }
                mute++;
                abandoned = true;
                record(`هیچ‌کدام از ${maxDraws} دسته حتی یک اتصال هم نپذیرفت — انتظار بی‌فایده است`, onLog);
                killProc();
                return;
            }
            mute++;
            abandoned = true;
            record(`دستهٔ ${draw} کامل بی‌جواب است (${got.join('، ')}) — بدون معطلی دستهٔ بعد`, onLog);
            killProc();   // settles startOnce through its own exit handler
        }, 1500);

        const last = draw >= maxDraws;
        try {
            // A non-final draw gets a SHORTER data budget. It has already passed the reachability
            // screen, so this is only asking whether it carries — and a batch that cannot in
            // thirty-five seconds is better replaced than waited on, because there are more draws
            // behind it. The final draw gets the full budget and is left running, which preserves
            // the old behaviour: Lantern stays up and keeps trying on its own.
            const r = await startOnce(Object.assign({}, o, last ? {} : { dataTimeoutMs: 35000 }), onLog, onStatus);
            clearInterval(watcher);

            // REACHABLE IS NOT USABLE, and that distinction cost a draw to learn: batch 3 passed
            // the TCP screen — its servers accepted connections — and then carried nothing for the
            // whole budget. A connect proves the address is not null-routed; it proves nothing
            // about the proxy behind it. So the data path is the judge, and a batch that is up and
            // carrying nothing is a spent draw like any other.
            if (!state.connected && !last) {
                record(`دستهٔ ${draw} به سرورهایش می‌رسد ولی دیتا رد نمی‌کند — دستهٔ بعد`, onLog);
                killProc();
                rotateIdentity();
                await new Promise(r2 => setTimeout(r2, 800));
                continue;
            }
            return r;
        } catch (err) {
            clearInterval(watcher);
            lastErr = err;
            if (cancelled) throw err;               // the user pressed stop; not our business
            if (draw >= maxDraws) break;
            // A batch this line cannot reach is the case this loop exists for. Anything else —
            // a missing binary, a port already taken — is not fixed by drawing again.
            const drew = abandoned || !!blockedReason();
            if (!drew) throw err;
            rotateIdentity();
            record(`دستهٔ ${draw + 1} از ${maxDraws}…`, onLog);
            await new Promise(r => setTimeout(r, 800));
        }
    }

    // The reason the user needs, not the symptom. `lastErr` here is «هسته بسته شد» — true of the
    // final kill and useless as an explanation.
    // Two different failures, and the difference is what the user should do next. Servers that
    // never accepted a connection are a network block nothing in this app can route around; servers
    // that accepted and then carried nothing are Lantern's own pool being overloaded or stale, and
    // trying later genuinely helps.
    state.error = mute >= maxDraws
        ? `سرورهای لنترن از این خط بسته‌اند: در ${maxDraws} دستهٔ پیاپی حتی یک اتصال هم برقرار نشد. `
        + 'این را هیچ تنظیمی در برنامه درست نمی‌کند؛ فهرست سرورها چرخشی است و معمولاً چند ساعت بعد باز می‌شود. '
        + 'تا آن موقع یکی از موتورهای دیگر را روشن کنید.'
        : `در ${maxDraws} دستهٔ پیاپی، هیچ سروری از این خط دیتا رد نکرد. کمی بعد دوباره امتحان کنید.`;
    record(state.error, onLog);
    push(onStatus);
    throw new Error(state.error);
}

function isRunning() { return state.running && !!proc; }

function getStatus() {
    return {
        running: state.running,
        connected: state.connected,
        stage: state.stage,
        detail: state.detail,
        proxyOk: state.proxyOk,
        exitCity: state.exitCity,
        exitCountry: state.exitCountry,
        exitCode: state.exitCode,
        // `egressRegion` under the name the other two fronts use, so the panel's hero needs no
        // special case for this engine.
        egressRegion: exitLabel(),
        blocked: !!blockedReason(),
        deadDials: state.deadDials.size,
        // The addresses, but ONLY while blocked. This reads a file, and `getStatus` is called on
        // a four-second poll — paying for that on every tick of a healthy engine would be a file
        // read per tick for something nobody is looking at. In the blocked state it is the whole
        // point: «سرورهایش بسته‌اند» with the addresses under it is evidence, and without them it
        // is an assertion the user has to take on trust, at the one moment they are most likely
        // to doubt it because everything else on their machine works.
        proxies: blockedReason() ? assignedProxies() : [],
        // When a batch has previously carried, its timestamp. Gated behind `blocked` for the same
        // reason as `proxies` above: it reads a file, and on a healthy engine nobody is looking.
        provenAt: blockedReason() ? ((provenInfo() || {}).at || null) : null,
        since: state.since,
        error: state.error,
        socksPort: SOCKS_PORT,
        httpPort: HTTP_PORT,
    };
}

function getLogs() { return logs.slice(); }

/**
 * The host the probe reaches for.
 *
 * A DNS-POISONED one on purpose. It is the thing a user turns this on for, and it cannot succeed by
 * accident: resolved on this line it is a sinkhole address, so a completed handshake to the real
 * YouTube proves both halves — that the name travelled to the exit, and that the exit carried it.
 */
/**
 * TWO hosts, both DNS-poisoned on this line, and they must be different.
 *
 * Poisoned on purpose: resolved locally each one is a sinkhole address, so a completed handshake
 * cannot have happened by accident — it proves the name travelled to the exit and the exit carried
 * it. Two of them because the core caches a working dialer per domain: a second pass on the SAME
 * host would be answered from that cache and would say nothing about anything else.
 */
const PROBE_HOSTS = ['www.youtube.com', 'www.instagram.com'];
const PROBE_HOST = PROBE_HOSTS[0];

/**
 * How fast the SECOND host has to answer before this is called connected.
 *
 * The failure being excluded is a hard 20 s budget inside the core, so anything comfortably under
 * it separates "carrying" from "about to time out". 9 s leaves room for a slow line without leaving
 * room for that.
 */
const WARM_MS = 9_000;

/**
 * Does the SOCKS port carry a stream?
 *
 * A FULL TLS HANDSHAKE, not a SOCKS reply — because Lantern's SOCKS reply means nothing. Its
 * handler calls `replySuccess` BEFORE it dials the origin (client.go, HandleConnect), so every
 * CONNECT is answered "success" whether or not a proxy exists. Measured: on a cold profile this
 * manager reported "connected" in 13.5 s while `proxyOk` was still false and no site loaded.
 *
 * So the test writes a real ClientHello through the tunnel and waits for the server's side of the
 * handshake. Nothing but a working end-to-end path produces that.
 *
 * Polls rather than asking once, because "not yet" and "never" are different: the core has to fetch
 * its proxy list through domain fronting before any proxy exists, and on a cold profile that is tens
 * of seconds.
 */
/**
 * Is the engine WARM — carrying traffic now, for anything, not just for one lucky host?
 *
 * The first host is allowed to take as long as it likes: on a cold profile the core is still
 * fetching its proxy list. The second one is not, and it is a host the first cannot have warmed —
 * that pair is what separates "connected" from "connected in another fifteen seconds".
 */
async function carriesWarm(budgetMs, isCancelled = () => false) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (isCancelled()) return false;
        const left = deadline - Date.now();
        if (!await socksCarriesStream(Math.min(left, 20_000), PROBE_HOSTS[0])) continue;
        if (isCancelled()) return false;
        if (await socksCarriesStream(Math.min(WARM_MS, Math.max(2_000, deadline - Date.now())), PROBE_HOSTS[1])) return true;
        // The first host works and the second does not: the engine is up but still paying the
        // core's own timeout on anything it has not tried yet. That is exactly the window the
        // user sees as "it says connected and nothing loads", so it is not connected yet.
    }
    return false;
}

function socksCarriesStream(timeoutMs = 45000, host = PROBE_HOST) {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => new Promise(resolve => {
        const tls = require('tls');
        const sock = new net.Socket();
        let stage = 0;
        let done = false;
        let secure = null;
        const end = (ok) => {
            if (done) return;
            done = true;
            try { if (secure) secure.destroy(); } catch (e) { /* gone */ }
            try { sock.destroy(); } catch (e) { /* gone */ }
            resolve(ok);
        };
        sock.setTimeout(12000, () => end(false));
        sock.on('error', () => end(false));
        sock.on('close', () => end(false));
        sock.connect(SOCKS_PORT, '127.0.0.1', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
        sock.on('data', data => {
            if (stage === 0) {
                if (data[0] !== 0x05 || data[1] !== 0x00) return end(false);
                stage = 1;
                const h = Buffer.from(host, 'utf8');
                sock.write(Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([0x01, 0xBB]),
                ]));
                return;
            }
            if (stage === 1) {
                if (data[0] !== 0x05 || data[1] !== 0x00) return end(false);
                stage = 2;
                // Hand the socket to TLS from here on; `data` must stop being read by this listener
                // or it would steal the handshake bytes from it.
                sock.removeAllListeners('data');
                sock.setTimeout(0);
                secure = tls.connect({
                    socket: sock, servername: host,
                    // The certificate is not what is being tested — reachability is — and a chain
                    // failure here would report a dead engine over a live one.
                    rejectUnauthorized: false,
                });
                secure.setTimeout(12000, () => end(false));
                secure.on('secureConnect', () => end(true));
                secure.on('error', () => end(false));
                secure.on('close', () => end(false));
            }
        });
    });

    return (async () => {
        while (Date.now() < deadline) {
            if (cancelled) return false;
            if (await attempt()) return true;
            await new Promise(r => setTimeout(r, 3000));
        }
        return false;
    })();
}

module.exports = {
    startLantern, stopLantern, isRunning, getStatus, getLogs, isInstalled,
    rotateIdentity, assignedProxies, provenInfo,
    socksCarriesStream, carriesWarm,
    SOCKS_PORT, HTTP_PORT, LANTERN_DATA_DIR,
    binPath,
    _internal: { deviceId, exitLabel, COUNTRY_FA },
};
