/**
 * «گف» — the Geph network, driven as a separate process.
 *
 * Fourth of the SOCKS-front engines (سایفون، تور، لنترن، گف), and the one with the most unusual
 * shape: its BROKER is domain-fronted. Every other engine here has to reach a control plane whose
 * address the censor can learn and block, which is why لنترن spends tens of seconds on a cold start
 * and why تور needs a bridge at all. Geph's client asks for its exits and routes through a race
 * between four fronted paths at once — an AWS Lambda function, two Netlify hosts behind
 * `kubernetes.io`, and a CDN77 host behind `cdn77.com` — so there is no broker address to block,
 * only well-known sites that are expensive to block.
 *
 * WHAT IS RUN
 *
 * `core/geph/geph5-client.exe`, built from geph-official/geph5 (MPL-2.0) — see docs/GEPH-BUILD.md.
 * The upstream GUI is a separate closed program; the daemon is the supported way to drive it and
 * takes a single YAML config. It publishes SOCKS5 and HTTP proxies and a control RPC.
 *
 * THE CONFIG IS WRITTEN AS JSON, DELIBERATELY
 *
 * The daemon reads it with `serde_yaml`, and JSON is valid YAML — so the config is emitted with
 * `JSON.stringify` instead of a hand-rolled YAML writer. There is nothing to get wrong about
 * quoting, indentation or a key that happens to contain a colon, and the struct it parses into is
 * `#[serde(deny_unknown_fields)]`, so a typo fails loudly at startup rather than being ignored.
 *
 * THE ACCOUNT
 *
 * Geph's free tier needs an account, and the account is a `secret` — no e-mail, no username, no
 * password, nothing that identifies anybody. One is obtained by solving a proof-of-work puzzle the
 * broker hands out: [registerAccount] does that through the daemon's own control RPC
 * (`start_registration` / `poll_registration`) and keeps the result in [ACCOUNT_FILE]. That is the
 * same thing the official client does silently on first run; here it is a button with a progress
 * bar, because a minute of unexplained CPU is worse than a minute of explained CPU.
 *
 * A user who buys Plus pastes that account's secret in instead, and gets the faster exits.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

/**
 * Ports, in the same block as the other three engines and clear of all of them.
 *
 * تور owns 20820-20822, سایفون 20830-20831, لنترن 20840-20841. A collision would not fail loudly:
 * the daemon would exit with a bind error while the panel still said «در حال اتصال».
 */
const SOCKS_PORT = 20850;
const HTTP_PORT = 20851;
/** The daemon's control RPC — newline-delimited JSON-RPC over plain TCP. See [rpc]. */
const CTRL_PORT = 20852;

const GEPH_DATA_DIR = path.join(os.homedir(), '.mlmvpn', 'geph');
const ACCOUNT_FILE = path.join(GEPH_DATA_DIR, 'account.json');
const CACHE_DIR = path.join(GEPH_DATA_DIR, 'cache');
const CONFIG_FILE = path.join(GEPH_DATA_DIR, 'config.json');

function binPath() {
    const root = __dirname.includes('app.asar')
        ? __dirname.replace('app.asar', 'app.asar.unpacked')
        : __dirname;
    return require('./core-paths').file('geph', 'geph5-client.exe', path.join(root, 'core', 'geph', 'geph5-client.exe'));
}

function isInstalled() { return fs.existsSync(binPath()); }

/**
 * The daemon's environment.
 *
 * `RUST_LOG` is the whole point. Upstream's filter is built with
 * `with_default_directive("geph=debug").from_env_lossy()`, so without this the process emits DEBUG
 * for everything — including one `dial stage failed` line per losing path of the route race, which
 * is forty lines of "failed" for one successful connection. At `info` the stream is the handful of
 * lines that mean something.
 */
function childEnv() {
    return Object.assign({}, process.env, { RUST_LOG: 'geph=info,geph5_client=info' });
}

/** The daemon colours its output; in a web panel the escapes render as literal `[2m[34m` noise. */
const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');

/**
 * Is this log line worth a user's attention?
 *
 * `dial stage failed` is excluded BY NAME. It is the normal, expected sound of the route race: every
 * path is dialled at once and all but one lose. Passing it through made a working connection look
 * like a cascade of failures.
 */
function worthSaying(line) {
    if (/dial stage failed|returning unexpired cached|calling broker through Geph/i.test(line)) return false;
    return /ERROR|WARN|tunnel open|opening tunnel|auth|puzzle|registered|bridge|exit route obtained/i.test(line);
}

function ensureDataDir() {
    fs.mkdirSync(GEPH_DATA_DIR, { recursive: true });
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ============================================================
// The broker, and the keys that authenticate it
// ============================================================

/**
 * How the client finds the network, copied verbatim from upstream's `default-config.yaml`.
 *
 * `priority_race` runs all of these AT ONCE and takes whichever answers first, with the number as a
 * priority. Every entry is domain fronting: the TLS connection is made to a host worth keeping
 * (`kubernetes.io`, `cdn77.com`, an AWS Lambda endpoint) and the real destination lives in the
 * encrypted `Host` header. Blocking it means blocking those.
 *
 * These are upstream's own values and they are not secrets — they ship inside every Geph client on
 * every platform. They do move, though: if the network ever stops answering, check this block
 * against upstream's default-config.yaml before looking anywhere else.
 */
const BROKER_SOURCE = {
    priority_race: {
        2500: {
            aws_lambda: {
                function_name: 'geph-lambda-bouncer',
                region: 'us-east-1',
                obfs_key: '855MJGAMB58MCPJBB97NADJ36D64WM2T:C4TN2M1H68VNMRVCCH57GDV2C5VN6V3RB8QMWP235D0P4RT2ACV7GVTRCHX3EC37',
            },
        },
        1500: {
            fronted: {
                front: 'https://kubernetes.io/',
                host: 'svitania-naidallszei-2.netlify.app',
                // Netlify's own edge addresses, so this path does not depend on a lookup that this
                // line answers with a sinkhole.
                override_dns: ['75.2.60.5:443'],
            },
        },
        500: {
            fronted: {
                front: 'https://kubernetes.io/',
                host: 'svitania-naidallszei-2.netlify.app',
            },
        },
        0: {
            fronted: {
                front: 'https://www.cdn77.com/',
                host: '1826209743.rsc.cdn77.org',
            },
        },
    },
};

/** The broker's signing keys. Public constants; the client refuses anything not signed by them. */
const BROKER_KEYS = {
    master: '88c1d2d4197bed815b01a22cadfc6c35aa246dddb553682037a118aebfaa3954',
    mizaru_free: '0558216cbab7a9c46f298f4c26e171add9af87d0694988b8a8fe52ee932aa754',
    mizaru_plus: 'cf6f58868c6d9459b3a63bc2bd86165631b3e916bad7f62b578cd9614e0bcb3b',
    mizaru_bw: '3082010a0282010100d0ae53a794ea37bf2e100cb3a872177ec6c11e8375fdcbf92960ce0293465674eb1426a1841b7622a58979a5ff3f8aa2301a621545e9b90bb39d1a6bfda19d6ca1aae74a3192ddfd2b9558eb652c3c2c22f42bdde272852fb67d93cae5846213512c474bf799844aee019bf718f6fa64223be06364459fc8dec66796b141d450d730c4fffe1cac7df8f05591560afa44bcf274f6c0e2303b39c21ab09d19b459ee594512b8341f3d407c026e2509f42c6d89f82f6a3a36fd5c05ad423cd99ad39089403eb9122ea60ef6648afff65438e8e26ce41fa55b9b18741965c77a627bae947bd38fc345e9adab42d6c458f6e194e4232cfd3f04924d5a5e932fe769610203010001',
};

/** After the tunnel exists, the broker is reached THROUGH it — no fronting needed any more. */
const TUNNELED_BROKER = { direct: 'https://broker.geph.io' };

// ============================================================
// The account
// ============================================================

function readAccount() {
    try { return JSON.parse(fs.readFileSync(ACCOUNT_FILE, 'utf8')); } catch (e) { return {}; }
}

function writeAccount(next) {
    ensureDataDir();
    fs.writeFileSync(ACCOUNT_FILE, JSON.stringify(next, null, 2), 'utf8');
}

/** Is there a usable credential on disk? */
function hasAccount() {
    const a = readAccount();
    return !!(a.secret || (a.username && a.password));
}

/**
 * The credential in the shape the daemon's `Credential` enum expects.
 *
 * Externally tagged, snake_case: `{"secret": "…"}` or
 * `{"legacy_username_password": {"username": "…", "password": "…"}}`. The username/password form is
 * upstream's own name for it — it is what pre-Geph5 accounts have, and new ones only ever get a
 * secret.
 */
function credential() {
    const a = readAccount();
    if (a.secret) return { secret: a.secret };
    if (a.username && a.password) {
        return { legacy_username_password: { username: a.username, password: a.password } };
    }
    return { secret: '' };
}

/** A stable name for this credential's database file. See the `cache` field in [writeConfig]. */
function credentialTag() {
    const c = JSON.stringify(credential());
    return require('crypto').createHash('sha256').update(c).digest('hex').slice(0, 32);
}

/** Forget the stored account. The cache goes too — it is keyed to the credential. */
function forgetAccount() {
    try { fs.unlinkSync(ACCOUNT_FILE); } catch (e) { /* nothing stored */ }
    try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch (e) { /* nothing cached */ }
}

/** Store a secret the user pasted in (a Plus account, or one moved from another device). */
function saveSecret(secret) {
    const s = String(secret || '').trim();
    if (!s) throw new Error('کد حساب خالی است.');
    // No format check. Upstream does not document one, and refusing a credential because it does
    // not match a pattern we invented would be worse than letting the daemon say it is wrong.
    writeAccount({ secret: s, at: Date.now() });
    return true;
}

// ============================================================
// The config
// ============================================================

/**
 * @param opts.region   a two-letter country code, or 'auto'
 * @param opts.dryRun   true for the query engine — talks to the broker, tunnels nothing
 */
function configObject(opts = {}) {
    const dry = !!opts.dryRun;
    const cc = String(opts.region || 'auto').trim().toLowerCase();
    return {
        // The query engine publishes NO proxies. Two clients sharing 20850 would mean the second
        // one exits on a bind error, and the query engine is started while the tunnel may be up.
        // The ports are overridable so a SWEEP can run several clients at once — see
        // probeExit. Nothing else passes them, and the defaults are the engine's own.
        socks5_listen: dry ? null : `127.0.0.1:${opts.socksPort || SOCKS_PORT}`,
        http_proxy_listen: dry || opts.socksPort ? null : `127.0.0.1:${HTTP_PORT}`,
        pac_listen: null,
        // `controlListen` / `cache` are overridden only by the store's pre-install check, which runs a
        // candidate core against this exact config shape on ports and files of its own.
        control_listen: opts.controlListen || `127.0.0.1:${dry ? CTRL_PORT + 1 : CTRL_PORT}`,
        // The ExitConstraint enum, snake_case. Five variants exist upstream — `auto`,
        // `{direct}`, `{hostname}`, `{country}`, `{country_city}` — and the last one is what
        // makes a choice mean something: «آمریکا» is seven exits on two coasts, and the one the
        // network picks for you is not the one you measured.
        exit_constraint: (() => {
            if (!cc || cc === 'auto') return 'auto';
            const city = String(opts.city || '').trim();
            // The tuple form is positional: [countryCode, city].
            return city ? { country_city: [cc, city] } : { country: cc };
        })(),
        // FALSE on purpose. `allow_direct` lets the client connect straight to an exit instead of
        // through a bridge; on a line that blocks the exits that is a pause with nothing at the end
        // of it, and on a line that does not, the bridges work anyway.
        allow_direct: false,
        // A FILE, NOT A DIRECTORY — and that distinction is not cosmetic. `cache` is handed
        // straight to SQLite as the database path (client/database.rs), so a directory here fails
        // with `unable to open database file (code: 526)` and the daemon exits one second after
        // starting. Measured exactly that on the first run.
        //
        // Keyed by the credential, as upstream keys it: the auth token is stored under a fixed key
        // inside the database, so two accounts sharing one file would let the second reuse the
        // first's token. (Upstream hashes with blake3; any stable hash does the same job here.)
        cache: opts.cache || path.join(CACHE_DIR, `db-${credentialTag()}`),
        broker: BROKER_SOURCE,
        tunneled_broker: TUNNELED_BROKER,
        broker_keys: BROKER_KEYS,
        port_forward: [],
        // FALSE, and this one matters. `spoof_dns` answers lookups inside the client with fake
        // addresses it then maps back — useful for a VPN that owns the whole stack, wrong here:
        // sing-box already owns DNS when the full tunnel is up, and in proxy mode the application
        // resolves names through SOCKS5 itself.
        spoof_dns: false,
        passthrough_china: false,
        dry_run: dry,
        credentials: credential(),
        sess_metadata: {},
        task_limit: null,
    };
}

function writeConfig(opts = {}) {
    ensureDataDir();
    const dry = !!opts.dryRun;
    const cfg = configObject(opts);
    const file = opts.configFile || (dry ? CONFIG_FILE.replace(/\.json$/, '-query.json') : CONFIG_FILE);
    // JSON, parsed as YAML by the daemon. See the note at the top of this file.
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
    return file;
}

// ============================================================
// The control RPC
// ============================================================

/**
 * One call, one connection.
 *
 * The wire format is a single JSON-RPC object on a line, answered with a single JSON object on a
 * line (nanorpc over a plain TCP listener — `nanorpc_sillad::rpc_serve`). There is no pooling
 * upstream either; the transport dials per call.
 */
function rpc(method, params = [], { port = CTRL_PORT, timeoutMs = 12000 } = {}) {
    return new Promise((resolve, reject) => {
        const sock = new net.Socket();
        let buf = '';
        let done = false;
        const finish = (err, val) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) { /* gone */ }
            err ? reject(err) : resolve(val);
        };
        sock.setTimeout(timeoutMs, () => finish(new Error(`«${method}» جواب نداد`)));
        sock.on('error', (e) => finish(new Error(`ارتباط با موتور برقرار نشد: ${e.code || e.message}`)));
        sock.connect(port, '127.0.0.1', () => {
            sock.write(JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }) + '\n');
        });
        sock.on('data', (d) => {
            buf += d.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl < 0) return;
            let msg;
            try { msg = JSON.parse(buf.slice(0, nl)); } catch (e) { return finish(new Error('جواب نامفهوم از موتور')); }
            if (msg.error) return finish(new Error(msg.error.message || String(msg.error)));
            finish(null, msg.result);
        });
    });
}

// ============================================================
// State
// ============================================================

const state = {
    running: false,
    connected: false,
    region: 'auto',
    city: '',            // only with a country; see the country_city tuple in configObject
    exit: null,          // 'DE · frankfurt'
    egressRegion: null,  // 'DE' — the code, for flags; see readConnInfo
    exitCity: '',
    protocol: null,      // whichever transport the session ended up using
    since: null,
    error: null,
    level: null,         // 'free' | 'plus', once the account has been asked about
    plusExpires: null,   // unix seconds, for a Plus account
};

let proc = null;
let queryProc = null;
const logs = [];
const MAX_LOGS = 300;

function record(line, onLog) {
    const text = `[GEPH] ${line}`;
    logs.push(text);
    if (logs.length > MAX_LOGS) logs.shift();
    if (onLog) onLog(text);
}

function killProc(p) {
    if (!p) return;
    try { p.kill(); } catch (e) { /* already gone */ }
    try {
        if (p.pid) {
            require('child_process').spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'],
                { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
        }
    } catch (e) { /* best effort */ }
}

/** Persian names for the exit countries, so the panel is not half English. */
const COUNTRY_FA = {
    us: 'آمریکا', de: 'آلمان', nl: 'هلند', se: 'سوئد', fr: 'فرانسه', gb: 'بریتانیا',
    ca: 'کانادا', jp: 'ژاپن', sg: 'سنگاپور', pl: 'لهستان', fi: 'فینلاند', no: 'نروژ',
    ch: 'سوئیس', at: 'اتریش', it: 'ایتالیا', es: 'اسپانیا', ro: 'رومانی', tr: 'ترکیه',
    hk: 'هنگ‌کنگ', tw: 'تایوان', kr: 'کره جنوبی', au: 'استرالیا', in: 'هند', br: 'برزیل',
};

function countryLabel(cc) {
    const k = String(cc || '').toLowerCase();
    return COUNTRY_FA[k] || (k ? k.toUpperCase() : '');
}

// ============================================================
// Registration — the free account
// ============================================================

/**
 * Solve the broker's puzzle and keep the account it hands back.
 *
 * This needs a client that can reach the broker but must not disturb a tunnel that may already be
 * up, so it runs a SECOND daemon in `dry_run` — no listeners, no session, just the broker RPC. That
 * is upstream's own arrangement: its manager keeps a permanent "query engine" of exactly this shape.
 *
 * The puzzle is proof of work and it is not instant. `onProgress` is called with 0..1 so the panel
 * can show it rather than looking frozen — which is the whole reason this is a visible step here
 * instead of something that happens silently on first connect.
 */
async function registerAccount({ onLog, onProgress } = {}) {
    if (!isInstalled()) throw new Error('فایل گف در core/geph موجود نیست.');
    const say = (l) => record(l, onLog);
    const qport = CTRL_PORT + 1;

    say('ساخت حساب رایگان: موتور در حالت پرسش بالا می‌آید…');
    const cfgFile = writeConfig({ dryRun: true });
    killProc(queryProc);
    queryProc = spawn(binPath(), ['--config', cfgFile], { windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    const feed = (c) => {
        for (const line of stripAnsi(c).split(/\r?\n/)) {
            if (line.trim()) { tail.push(line.trim()); if (tail.length > 40) tail.shift(); }
        }
    };
    queryProc.stdout.on('data', feed);
    queryProc.stderr.on('data', feed);

    try {
        // Wait for the control port rather than a fixed sleep.
        const deadline = Date.now() + 20000;
        let up = false;
        while (Date.now() < deadline) {
            if (queryProc.exitCode !== null) {
                throw new Error(`موتور بالا نیامد: ${tail.slice(-3).join(' | ') || 'بدون پیام'}`);
            }
            try { await rpc('conn_info', [], { port: qport, timeoutMs: 2500 }); up = true; break; } catch (e) { /* not yet */ }
            await new Promise(r => setTimeout(r, 500));
        }
        if (!up) throw new Error('موتور در ۲۰ ثانیه آماده نشد.');

        say('معمای اثبات‌کار از سرور گرفته شد؛ در حال حل…');
        const idx = await rpc('start_registration', [], { port: qport, timeoutMs: 30000 });

        // Poll until there is a secret. The puzzle is CPU work with no network in the middle, so a
        // long quiet stretch here is normal and must not be read as a failure.
        const regDeadline = Date.now() + 300000;
        let last = -1;
        while (Date.now() < regDeadline) {
            if (queryProc.exitCode !== null) throw new Error('موتور وسط ثبت‌نام بسته شد.');
            const p = await rpc('poll_registration', [idx], { port: qport, timeoutMs: 10000 });
            const pct = Math.max(0, Math.min(1, Number(p && p.progress) || 0));
            if (onProgress) onProgress(pct);
            const step = Math.floor(pct * 10);
            if (step !== last) { last = step; say(`حل معما: ${Math.round(pct * 100)}٪`); }
            if (p && p.secret) {
                writeAccount({ secret: p.secret, at: Date.now(), free: true });
                say('✅ حساب رایگان ساخته شد و ذخیره شد.');
                return { ok: true, secret: p.secret };
            }
            await new Promise(r => setTimeout(r, 1200));
        }
        throw new Error('ثبت‌نام در ۵ دقیقه تمام نشد.');
    } finally {
        killProc(queryProc);
        queryProc = null;
    }
}

/**
 * What the broker says about the stored account.
 *
 * There is NO `user_info` control method — the control protocol is the eleven calls in
 * `client_control.rs` and nothing else. The account is asked for the way upstream's own manager asks
 * (`manager.rs::account_for_secret`): `broker_rpc('get_user_info_by_cred', [credential])`, with the
 * credential passed per call. That works whether or not a tunnel is up, and needs no auth token.
 *
 * Whichever client is already running answers; if none is, a `dry_run` one is started just for this
 * and killed again.
 */
async function accountInfo() {
    if (!hasAccount()) return { ok: false, error: 'هنوز حسابی ساخته نشده.' };
    const params = ['get_user_info_by_cred', [credential()]];

    const ask = async (port, timeoutMs) => {
        const raw = await rpc('broker_rpc', params, { port, timeoutMs });
        // The broker answers Result<Option<UserInfo>>: null means the credential is not an account.
        if (!raw) throw new Error('این کد حساب شناخته نشد.');
        const info = raw.Ok !== undefined ? raw.Ok : raw;
        if (!info) throw new Error('این کد حساب شناخته نشد.');
        // `UserInfo` carries no `level`: it is {user_id, plus_expires_unix, recurring,
        // bw_consumption}. Plus is an expiry in the future and nothing else — an expiry in the past
        // is an account that WAS Plus, which is free now.
        const exp = Number(info.plus_expires_unix) || 0;
        state.level = exp * 1000 > Date.now() ? 'plus' : 'free';
        state.plusExpires = exp || null;
        return { ok: true, info, level: state.level };
    };

    if (state.running) {
        try { return await ask(CTRL_PORT, 15000); } catch (e) { /* fall back to a query engine */ }
    }

    const qport = CTRL_PORT + 1;
    const cfgFile = writeConfig({ dryRun: true });
    killProc(queryProc);
    queryProc = spawn(binPath(), ['--config', cfgFile], { windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        const deadline = Date.now() + 25000;
        let lastErr = null;
        while (Date.now() < deadline) {
            if (queryProc.exitCode !== null) return { ok: false, error: 'موتور برای پرسیدن حساب بالا نیامد.' };
            try { return await ask(qport, 5000); } catch (e) { lastErr = e; }
            await new Promise(r => setTimeout(r, 800));
        }
        return { ok: false, error: (lastErr && lastErr.message) || 'سرور دربارهٔ این حساب جواب نداد.' };
    } finally {
        killProc(queryProc);
        queryProc = null;
    }
}

// ============================================================
// Start / stop
// ============================================================

/** How long the daemon gets to open its SOCKS port. Binding a socket is not slow; this is generous. */
const LISTEN_TIMEOUT_MS = 25_000;

/**
 * How long to wait for a stream to actually cross.
 *
 * The broker race, the bridge handshake and the first circuit all happen inside this. Measured cold
 * on this line, the whole path is well under a minute; the budget is set above that so a slow first
 * attempt is not reported as a failure the user has to retry by hand.
 */
const DATA_TIMEOUT_MS = 90_000;

async function startGeph(opts = {}, onLog, onStatus) {
    if (!isInstalled()) throw new Error('فایل گف در core/geph موجود نیست.');
    if (state.running && proc) return { ok: true, socks: `127.0.0.1:${SOCKS_PORT}`, already: true };

    const say = (l) => record(l, onLog);
    state.error = null;
    state.connected = false;
    state.region = String(opts.region || 'auto').toLowerCase();
    // A city is only meaningful with a country — `country_city` is a tuple, and a city alone
    // names nothing the broker can match.
    state.city = state.region === 'auto' ? '' : String(opts.city || '').trim();
    state.exit = null;
    state.egressRegion = null;
    state.exitCity = '';
    state.protocol = null;
    push(onStatus);

    // No credential means no connection — and it is worth saying which of the two it is, because
    // «حساب نداری» and «وصل نشد» need completely different things from the user.
    if (!hasAccount()) {
        throw new Error('برای گف یک حساب لازم است. حساب رایگان است و با یک دکمه ساخته می‌شود — «ساخت حساب رایگان».');
    }

    const cfgFile = writeConfig({ region: state.region, city: state.city });
    say(`موتور با خروج ${state.region === 'auto' ? 'خودکار'
        : countryLabel(state.region) + (state.city ? ` · ${state.city}` : '')} راه‌اندازی می‌شود…`);

    proc = spawn(binPath(), ['--config', cfgFile], { windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    state.running = true;
    state.since = Date.now();
    push(onStatus);

    const tail = [];
    const feed = (chunk) => {
        for (const raw of stripAnsi(chunk).split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            tail.push(line);
            if (tail.length > 60) tail.shift();
            if (worthSaying(line)) say(line.slice(0, 220));
        }
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);

    let exited = null;
    proc.on('exit', (code) => {
        exited = code;
        if (state.running) {
            state.running = false;
            state.connected = false;
            state.error = `موتور بسته شد (کد ${code}). ${tail.slice(-2).join(' | ')}`.trim();
            record(state.error, onLog);
            push(onStatus);
        }
    });

    try {
        // 1. the port
        const portDeadline = Date.now() + LISTEN_TIMEOUT_MS;
        let listening = false;
        while (Date.now() < portDeadline) {
            if (exited !== null) throw new Error(state.error || `موتور بسته شد (کد ${exited}).`);
            if (await portIsLive(SOCKS_PORT)) { listening = true; break; }
            await new Promise(r => setTimeout(r, 400));
        }
        if (!listening) throw new Error('پورت موتور باز نشد.');
        say(`پورت‌ها باز شد — SOCKS5 روی 127.0.0.1:${SOCKS_PORT} و HTTP روی 127.0.0.1:${HTTP_PORT}`);

        // 2. the engine's own opinion, which is cheap and names the exit
        watchConnInfo(onLog, onStatus);

        // 3. AND A STREAM THAT ACTUALLY CROSSES.
        //
        // The rule the other three engines earned the hard way: a listening port and a core that
        // says «connected» are both true long before anything crosses, and «متصل» shown at that
        // moment is the single worst thing this panel can do. So connected means measured.
        const carries = await socksCarriesStream(DATA_TIMEOUT_MS);
        if (exited !== null) throw new Error(state.error || 'موتور بسته شد.');
        if (!carries) throw new Error('موتور بالا آمد ولی دیتا رد نشد.');

        state.connected = true;
        // Ask once, right here, instead of waiting for the watcher's next tick. Otherwise the
        // success line has no exit in it and the country appears five seconds later on its own,
        // which reads as a second event rather than part of this one.
        await readConnInfo(onLog, onStatus).catch(() => { /* the label is a nicety */ });
        push(onStatus);
        say(`✅ وصل شد — دیتا رد می‌شود${state.exit ? ` (خروج: ${state.exit})` : ''}`);
        return { ok: true, socks: `127.0.0.1:${SOCKS_PORT}`, http: `127.0.0.1:${HTTP_PORT}`, exit: state.exit };
    } catch (err) {
        stopGeph();
        state.error = err.message;
        push(onStatus);
        throw err;
    }
}

/**
 * Keep asking the daemon what it thinks, in the background.
 *
 * `conn_info` is internally tagged: `{state:"Disconnected"}`, `{state:"Connecting"}` or
 * `{state:"Connected", sessions:[{protocol, exit:{country,city,…}}]}`. It is the exit label and the
 * transport name in the panel — NOT the source of `connected`, which is measured. A session that
 * disappears is worth knowing about, though: that is the engine losing its exit while the panel
 * still says it is up.
 */
async function readConnInfo(onLog, onStatus) {
    const info = await rpc('conn_info', [], { timeoutMs: 6000 });
    const st = info && info.state;
    if (st === 'Connected' && Array.isArray(info.sessions) && info.sessions.length) {
        const s = info.sessions[0];
        const cc = s.exit && s.exit.country;
        const city = (s.exit && s.exit.city) || '';
        const label = [countryLabel(cc), city].filter(Boolean).join(' · ');
        // THE CODE, not only the Persian label. Every panel that wants to draw a flag needs the
        // two-letter country, and this manager was keeping only the sentence — so the status
        // strip fell through to showing the transport name («sosistab3») where the country
        // belongs. `egressRegion` is the name the other three engines already publish it under.
        if (cc) { state.egressRegion = String(cc).toUpperCase(); state.exitCity = city; }
        if (s.protocol) state.protocol = s.protocol;
        if (label && label !== state.exit) {
            state.exit = label;
            push(onStatus);
            return label;
        }
    } else if (st === 'Connecting' && state.connected) {
        // It HAD a session and lost it. Say so — this is the window where a user is looking at a
        // panel that claims to be connected and a browser that is not loading.
        record('اتصال به خروج قطع شد؛ موتور دارد دوباره وصل می‌شود…', onLog);
        state.connected = false;
        push(onStatus);
    }
    return null;
}

let connWatch = null;
function watchConnInfo(onLog, onStatus) {
    clearInterval(connWatch);
    connWatch = setInterval(async () => {
        if (!state.running) { clearInterval(connWatch); connWatch = null; return; }
        try {
            const label = await readConnInfo(onLog, onStatus);
            if (label) record(`خروج: ${label}${state.protocol ? ` (${state.protocol})` : ''}`, onLog);
        } catch (e) { /* the port answers when it answers */ }
    }, 5000);
}

function portIsLive(port, timeoutMs = 1000) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        const finish = (ok) => { if (!done) { done = true; sock.destroy(); resolve(ok); } };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true));
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        sock.connect(port, '127.0.0.1');
    });
}

function stopGeph() {
    const was = state.running;
    clearInterval(connWatch);
    connWatch = null;
    killProc(proc);
    killProc(queryProc);
    proc = null;
    queryProc = null;
    state.running = false;
    state.connected = false;
    state.exit = null;
    state.protocol = null;
    state.since = null;
    return was;
}

function isRunning() { return state.running && !!proc; }

function push(onStatus) { if (onStatus) { try { onStatus(getStatus()); } catch (e) { /* nobody listening */ } } }

function getStatus() {
    return {
        running: state.running,
        connected: state.connected,
        region: state.region,
        city: state.city,
        egressRegion: state.egressRegion,
        exitCity: state.exitCity,
        exit: state.exit,
        protocol: state.protocol,
        since: state.since,
        error: state.error,
        hasAccount: hasAccount(),
        level: state.level,
        plusExpires: state.plusExpires,
        socksPort: SOCKS_PORT,
        httpPort: HTTP_PORT,
    };
}

function getLogs() { return logs.slice(); }

const REGIONS_FILE = path.join(GEPH_DATA_DIR, 'exits.json');

/**
 * The countries the network has exits in — asked of the network, never hard-coded.
 *
 * `net_status` is a first-class control call and returns every exit with its country and city, so
 * the list is whatever the network actually has today. A hard-coded list would offer countries that
 * are not there, and an `exit_constraint` naming a country with no exits is a connection that never
 * completes — that exact failure cost the Android build 42 minutes at 45% with تور's `{gr}`.
 *
 * It needs a client to ask through, so the answer is CACHED to disk. Without that the country list
 * would be empty on every fresh start — the one moment a user is choosing — and would only appear
 * after connecting, which is too late to be useful.
 */
/**
 * Every exit the network has right now — country, city, load and who may use it.
 *
 * `regions()` answers «which countries», which is all a country picker needs. This answers the
 * question behind it: WHICH exit, and is it any good. The broker publishes `load` (0..1) on every
 * descriptor and an `ExitMetadata` beside it carrying `allowed_levels` and a `category` of `core`
 * or `streaming` — three facts that were being thrown away because the old reducer counted
 * countries and dropped the rest.
 *
 * Cached to disk like the country list, and for the same reason: a user choosing an exit is doing
 * it BEFORE there is a client to ask.
 */
const EXITS_FILE = path.join(GEPH_DATA_DIR, 'exit-list.json');

async function exits() {
    if (state.running) {
        try {
            const res = await rpc('net_status', [], { timeoutMs: 15000 });
            const raw = (res && res.exits) || (res && res.Ok && res.Ok.exits) || null;
            if (raw) {
                const list = [];
                for (const key of Object.keys(raw)) {
                    // [pubkey, ExitDescriptor, ExitMetadata]
                    const row = raw[key];
                    const d = Array.isArray(row) ? row[1] : null;
                    const meta = Array.isArray(row) ? row[2] : null;
                    if (!d || !d.country) continue;
                    list.push({
                        host: key,
                        country: String(d.country).toUpperCase(),
                        countryFa: countryLabel(d.country),
                        city: d.city || '',
                        // 0..1 as the broker reports it; shown as a percentage.
                        load: typeof d.load === 'number' ? +d.load.toFixed(3) : null,
                        category: (meta && meta.category) || 'core',
                        levels: (meta && meta.allowed_levels) || [],
                    });
                }
                if (list.length) {
                    // WHICH OF THESE CAN THIS ACCOUNT ACTUALLY USE.
                    //
                    // `allowed_levels` is per exit, and on a Free account most are not open:
                    // measured 2026-09-20, 30 exits across 12 countries and **six** usable —
                    // CA, LT, NL and PL only. The country picker was offering سوئیس, چک, ژاپن,
                    // آمریکا and the rest, and choosing one of those is a connection that runs
                    // its full ninety-second budget and fails with nothing saying why. That is
                    // exactly what SE and CH did in the exit sweep.
                    markFree(list);
                    list.sort((a, b) => (b.free - a.free)
                        || a.country.localeCompare(b.country)
                        || String(a.city).localeCompare(String(b.city)));
                    try { fs.writeFileSync(EXITS_FILE, JSON.stringify({ at: Date.now(), list }), 'utf8'); } catch (e) { /* cache is optional */ }
                    return list;
                }
            }
        } catch (e) { /* fall through to the cache */ }
    }
    // Derived on the way OUT, not only on the way in: a cache written by an older build has the
    // levels but not the verdict, and a stale file must not quietly answer "nothing is free".
    try { return markFree(JSON.parse(fs.readFileSync(EXITS_FILE, 'utf8')).list || []); } catch (e) { return []; }
}

/** Can a Free account use this exit? `allowed_levels` is ["Plus"] or ["Plus","Free"]. */
function markFree(list) {
    for (const e of list) e.free = (e.levels || []).some(l => /free/i.test(String(l)));
    return list;
}

/**
 * What the engine itself says about the live connection, as numbers.
 *
 * `stat_num` answers exactly three keys — `ping`, `total_rx_bytes`, `total_tx_bytes` — and
 * `stat_history` answers only `traffic`, a speed series the daemon keeps itself. Asking for
 * anything else returns `bad: <name>`, so the list is closed and worth writing down.
 */
async function liveStats() {
    if (!state.running) return null;
    const num = async (k) => { try { return await rpc('stat_num', [k], { timeoutMs: 5000 }); } catch (e) { return null; } };
    const [ping, rx, tx] = await Promise.all([num('ping'), num('total_rx_bytes'), num('total_tx_bytes')]);
    let history = null;
    try { const h = await rpc('stat_history', ['traffic'], { timeoutMs: 5000 }); history = Array.isArray(h) ? h : (h && h.Ok) || null; } catch (e) { /* optional */ }
    return { pingMs: typeof ping === 'number' ? Math.round(ping) : null, rxBytes: rx, txBytes: tx, history };
}

/**
 * Try a list of exits, one at a time, and rank them by what they actually deliver.
 *
 * WHY THIS IS NOT A LOOKUP. `auto` is the network's own choice and it is not a measurement of
 * YOUR line. Measured here on one line inside ten minutes, same engine, same account:
 *
 *     PL · Warsaw     2.29 Mbit/s   ttfb 160 ms   connected in 2.1 s
 *     LT · Siauliai   1.00          ttfb 257 ms   connected in 7.7 s   ← what `auto` picked
 *     NL · Amsterdam  0.64          ttfb 475 ms   connected in 3.0 s
 *     SE, CH          did not connect at all
 *
 * Three and a half times between the best and what the network chose, and two countries in the
 * published list that do not answer. Neither fact is visible without dialling them.
 *
 * Deliberately sequential: two engines cannot share the SOCKS port, and two measurements sharing
 * one line would each get half of it and rank nothing. Budget is roughly ten seconds per
 * candidate, so the caller shows progress and can stop.
 */
const FASTEST_FILE = path.join(GEPH_DATA_DIR, 'fastest.json');

/**
 * One exit, measured by a client of its own — ports, cache and config file all its own.
 *
 * THIS IS WHAT MAKES THE SWEEP FAST, and the first version did not have it. That one drove the
 * shared engine: start, measure, stop, next — a full connect per country, in series, minutes for
 * twelve of them. The reason given was that two clients cannot share a SOCKS port, which is true
 * and beside the point: they can each have their OWN, exactly as `xray-tester.js` gives every
 * node its own listener rather than restarting one engine per node.
 *
 * What is measured here is LATENCY, not bandwidth, and that is deliberate. Several clients
 * running at once share one line, so a throughput figure taken in parallel is a figure for a
 * line cut N ways — it would rank nothing. Time-to-first-byte through the exit is barely
 * affected by that, and on this line it tracked bandwidth closely anyway: the exit with the best
 * TTFB (160 ms) was also the fastest (2.29 Mbit/s), and the worst (475 ms) the slowest (0.64).
 * The winners are then re-measured for real throughput, one at a time, by [findFastest].
 */
async function probeExit(opts) {
    const { country, city = '', socksPort, ctrlPort, timeoutMs = 30000 } = opts;
    const dir = path.join(GEPH_DATA_DIR, 'sweep');
    fs.mkdirSync(dir, { recursive: true });
    const tag = `${country}${city ? '-' + city.replace(/[^a-z0-9]/gi, '') : ''}-${socksPort}`;
    const cfgFile = writeConfig({
        region: country, city,
        socksPort, controlListen: `127.0.0.1:${ctrlPort}`,
        cache: path.join(dir, `db-${credentialTag()}-${tag}`),
        configFile: path.join(dir, `config-${tag}.json`),
    });

    const started = Date.now();
    let child = null;
    const kill = () => { try { if (child) child.kill(); } catch (e) { /* gone */ } child = null; };
    try {
        child = spawn(binPath(), ['--config', cfgFile], { windowsHide: true, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
        let exited = null;
        child.on('exit', (code) => { exited = code; });
        // Swallow the output: a probe that filled the log with forty lines per country would
        // bury the results it exists to produce.
        child.stdout.on('data', () => {});
        child.stderr.on('data', () => {});

        const deadline = started + timeoutMs;
        while (Date.now() < deadline) {
            if (exited !== null) throw new Error(`موتور بسته شد (کد ${exited})`);
            if (await portIsLive(socksPort, 700)) break;
            await new Promise(r => setTimeout(r, 350));
        }
        if (!(await portIsLive(socksPort, 700))) throw new Error('پورت باز نشد');
        const connectMs = Date.now() - started;

        // TIME TO FIRST BYTE, and it has to be that exact number.
        //
        // The first version read `parallelThroughSocks(...).ms`, which is how long the whole
        // download took — a bandwidth figure wearing a latency label. Taken with four clients
        // sharing one line it reported 6.7 to 10.5 SECONDS for exits that answer in a fraction
        // of one, and ranked them by nothing but who got the bigger share of the line.
        //
        // `throughSocks` charges the connect, the request and the exit's own think-time to
        // `ttfbMs` and only the body to the rate. TTFB is a round trip, so four at once barely
        // move it — which is what makes phase 1 both parallel and honest.
        const bytes = opts && opts.bytes ? opts.bytes : 64 * 1024;
        const r = await require('./tun-diag').throughSocks(socksPort, bytes,
            Math.max(6000, deadline - Date.now()));
        if (!r || !r.ok) throw new Error('دیتا رد نشد');
        return { ok: true, connectMs, ttfbMs: r.ttfbMs || r.ms, sampleMbit: +((r.kbps * 8 / 1000).toFixed(2)) };
    } finally {
        kill();
        await new Promise(r => setTimeout(r, 200));
    }
}

async function findFastest(opts = {}) {
    if (state.running) throw new Error('اول اتصال فعلی را قطع کنید؛ سنجش موتور را چند بار بالا و پایین می‌کند.');
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

    let list = Array.isArray(opts.candidates) && opts.candidates.length ? opts.candidates : null;
    if (!list) {
        const known = await regions();
        // Only what this account can actually reach. Dialling the rest is ninety seconds each
        // spent proving something the exit list already said.
        list = known.filter(r => r.free === undefined || r.free > 0)
            .map(r => ({ country: r.code.toLowerCase(), city: '' }));
    }
    if (!list.length) throw new Error('فهرست خروج‌ها خالی است؛ یک بار وصل شوید تا شبکه فهرستش را بدهد.');

    // ── phase 1: every candidate at once, in small groups ────────────────────────────────────
    //
    // FOUR AT A TIME, not all of them: each one is a process with its own broker race, and a
    // dozen of those together is a burst that the line — and the broker — answer worse than they
    // would one at a time. Four keeps the whole phase under half a minute for twelve countries.
    const LANES = 4;
    const BASE_SOCKS = 21400, BASE_CTRL = 21500;
    const results = new Array(list.length);
    let done = 0;

    const runOne = async (i, lane) => {
        const c = list[i];
        const label = `${countryLabel(c.country)}${c.city ? ' · ' + c.city : ''}`;
        onProgress({ stage: 'probing', index: done, total: list.length, label, country: c.country, city: c.city || '' });
        let row = { country: c.country, city: c.city || '', label, ok: false };
        try {
            const r = await probeExit({
                country: c.country, city: c.city,
                socksPort: BASE_SOCKS + lane, ctrlPort: BASE_CTRL + lane,
            });
            row = Object.assign(row, r, { ok: true });
            onLog(`${label}: اتصال ${(r.connectMs / 1000).toFixed(1)} ثانیه، پاسخ ${r.ttfbMs}ms`);
        } catch (e) {
            row.error = e.message;
            onLog(`${label}: ${e.message}`);
        }
        results[i] = row;
        done++;
        // Reported the moment it is known, so the panel can fill the list in as it goes rather
        // than showing a bar and a number.
        onProgress({ stage: 'result', index: done, total: list.length, label, row });
        return row;
    };

    for (let i = 0; i < list.length; i += LANES) {
        await Promise.all(list.slice(i, i + LANES).map((_, k) => runOne(i + k, k)));
    }

    // ── phase 1b: the failures, once more, alone ─────────────────────────────────────────────
    //
    // A country that failed while three others were dialling is not the same as one that cannot
    // be reached. Measured: LT connects on its own and carried 1.00 Mbit/s, and failed in a
    // group of four — one exit, four clients, one broker. Retrying only the failures is cheap
    // (usually none, at worst a few seconds each) and it is the difference between «در دسترس
    // نیست» and «شلوغ بود».
    const failed = results.map((r, i) => ({ r, i })).filter(x => x.r && !x.r.ok);
    for (const { r, i } of failed) {
        onProgress({ stage: 'probing', index: done, total: list.length, label: r.label, country: r.country });
        try {
            const again = await probeExit({
                country: r.country, city: r.city,
                socksPort: BASE_SOCKS, ctrlPort: BASE_CTRL, timeoutMs: 25000,
            });
            results[i] = Object.assign({}, r, again, { ok: true, error: undefined, retried: true });
            onLog(`${r.label}: با تلاش دوم جواب داد — پاسخ ${again.ttfbMs}ms`);
        } catch (e) { /* it really is unreachable; the first answer stands */ }
        onProgress({ stage: 'result', index: done, total: list.length, label: r.label, row: results[i] });
    }

    // ── phase 2: the top few, measured properly ──────────────────────────────────────────────
    //
    // One at a time, because throughput taken in parallel is a line cut four ways. Only the
    // three best by latency, because that is where the winner is and every extra one costs the
    // user ten seconds of their own bandwidth.
    const alive = results.filter(r => r && r.ok).sort((a, b) => a.ttfbMs - b.ttfbMs);
    const finalists = alive.slice(0, 2);
    for (let i = 0; i < finalists.length; i++) {
        const row = finalists[i];
        onProgress({ stage: 'measuring', index: i + 1, total: finalists.length, label: row.label, country: row.country });
        try {
            // Half a megabyte on a line nobody else is using right now — enough to be a rate and
            // not so much that two of them cost the user a minute of their own bandwidth.
            const r = await probeExit({
                country: row.country, city: row.city, bytes: 512 * 1024,
                socksPort: BASE_SOCKS, ctrlPort: BASE_CTRL, timeoutMs: 40000,
            });
            row.mbit = r.sampleMbit;
            row.ttfbMs = r.ttfbMs;
            onLog(`${row.label}: ${row.mbit} مگابیت`);
        } catch (e) {
            // Said out loud. A finalist that cannot be re-measured keeps its latency and ranks
            // below one that could, and silence here is how the first run left two countries
            // looking measured when they were not.
            onLog(`${row.label}: اندازه‌گیری سرعت نشد (${e.message})`);
        }
        onProgress({ stage: 'result', index: i + 1, total: finalists.length, label: row.label, row });
    }

    // Throughput decides among the finalists; everything else falls back to latency, which is
    // the only number the non-finalists have.
    const ranked = results.filter(Boolean).slice().sort((a, b) =>
        (b.ok - a.ok) || ((b.mbit || 0) - (a.mbit || 0)) || ((a.ttfbMs || 9e9) - (b.ttfbMs || 9e9)));
    const best = ranked.find(r => r.ok) || null;
    try {
        fs.writeFileSync(FASTEST_FILE, JSON.stringify({ at: Date.now(), best, ranked }, null, 2), 'utf8');
    } catch (e) { /* the answer is still returned */ }
    return { best, ranked };
}

/** The last measurement, so the panel can show it without re-running a two-minute sweep. */
function lastFastest() {
    try { return JSON.parse(fs.readFileSync(FASTEST_FILE, 'utf8')); } catch (e) { return null; }
}

async function regions() {
    if (state.running) {
        try {
            const res = await rpc('net_status', [], { timeoutMs: 15000 });
            const exits = (res && res.exits) || (res && res.Ok && res.Ok.exits) || null;
            if (exits) {
                const seen = new Map();
                for (const key of Object.keys(exits)) {
                    // [pubkey, ExitDescriptor, ExitMetadata]
                    const d = Array.isArray(exits[key]) ? exits[key][1] : null;
                    const cc = d && d.country;
                    if (!cc) continue;
                    const k = String(cc).toLowerCase();
                    seen.set(k, (seen.get(k) || 0) + 1);
                }
                const list = [...seen.entries()]
                    .map(([code, count]) => ({ code: code.toUpperCase(), name: countryLabel(code), exits: count }))
                    .sort((a, b) => b.exits - a.exits);
                await withLevels(list);   // see the note there
                if (list.length) {
                    try { fs.writeFileSync(REGIONS_FILE, JSON.stringify({ at: Date.now(), list }), 'utf8'); } catch (e) { /* cache is optional */ }
                    return list;
                }
            }
        } catch (e) { /* fall through to the cache */ }
    }
    try { return await withLevels(JSON.parse(fs.readFileSync(REGIONS_FILE, 'utf8')).list || []); } catch (e) { return []; }
}

/**
 * Add "how many of these may I use" to a country list.
 *
 * Runs off the exit cache, so it works with no client up — which is the one moment a user is
 * choosing a country. Without it the picker offers twelve countries when six exits in four of
 * them are all a Free account can reach.
 */
async function withLevels(list) {
    try {
        const all = await exits();
        if (!all.length) return list;
        for (const row of list) {
            const mine = all.filter(e => e.country === row.code);
            row.free = mine.filter(e => e.free).length;
            row.plusOnly = mine.length - row.free;
        }
        list.sort((a, b) => ((b.free > 0) - (a.free > 0)) || (b.exits - a.exits));
    } catch (e) { /* the plain count is still worth showing */ }
    return list;
}

// ============================================================
// Does it carry?
// ============================================================

/**
 * A DNS-POISONED host, on purpose.
 *
 * Resolved on this line the name is a sinkhole address, so a completed TLS handshake cannot have
 * happened by accident: it proves the NAME travelled to the exit and the exit carried the bytes
 * back. `example.com` would prove nothing — it loads here with no engine at all.
 */
const PROBE_HOST = 'www.youtube.com';

/**
 * A full TLS handshake through the SOCKS port, not a SOCKS reply.
 *
 * SOCKS replies are worth nothing as evidence — لنترن answers every CONNECT with success before it
 * has dialled anything, and that cost this project a day. Only the server's half of a real
 * handshake proves the path.
 */
function socksCarriesStream(timeoutMs = DATA_TIMEOUT_MS, host = PROBE_HOST) {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => new Promise((resolve) => {
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
        sock.setTimeout(Math.min(25000, Math.max(4000, deadline - Date.now())), () => end(false));
        sock.on('error', () => end(false));
        sock.connect(SOCKS_PORT, '127.0.0.1', () => sock.write(Buffer.from([5, 1, 0])));
        sock.on('data', (d) => {
            if (stage === 0) {
                if (d[0] !== 5) return end(false);
                stage = 1;
                const h = Buffer.from(host, 'utf8');
                return sock.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([1, 0xBB])]));
            }
            if (stage === 1) {
                if (d[1] !== 0) return end(false);
                stage = 2;
                secure = tls.connect({ socket: sock, servername: host }, () => end(true));
                secure.on('error', () => end(false));
                return;
            }
        });
    });

    return (async () => {
        while (Date.now() < deadline) {
            if (await attempt()) return true;
            await new Promise(r => setTimeout(r, 2500));
        }
        return false;
    })();
}

module.exports = {
    startGeph, stopGeph, isRunning, getStatus, getLogs, isInstalled,
    socksCarriesStream,
    registerAccount, accountInfo, hasAccount, saveSecret, forgetAccount,
    regions, exits, liveStats, findFastest, lastFastest,
    SOCKS_PORT, HTTP_PORT, CTRL_PORT, GEPH_DATA_DIR,
    binPath,
    _internal: { writeConfig, configObject, childEnv, credential, rpc, BROKER_SOURCE, BROKER_KEYS, COUNTRY_FA },
};
