// --- GitHub Tunnel API routes ---
// Mounted from server.js with one line:
//     require('./github-tunnel/routes')(app, { broadcastLog });
// Everything the GitHub Tunnel panel needs lives under /api/github-tunnel/*.
//
// Provisioning (setup/renew) runs in the background and reports progress through an
// in-memory `provisioning` tracker the panel polls — same pattern as vodi's device-flow
// `pending` object — rather than holding the HTTP request open for minutes.

const github = require('./gt-github');
const deployer = require('./gt-deployer');
const store = require('./gt-config');
const broker = require('./gt-broker');
const accounts = require('./gt-accounts');
const allocator = require('./gt-allocator');
const quota = require('./gt-quota');
const brokerDeploy = require('./gt-broker-deploy');
const engine = require('./gt-engine');
const guard = require('./gt-guard');
const tun = require('../tun-manager');

let provisioning = null; // { state, steps: [{key,label,done}], log: [string], error, startedAt }

const STEP_ORDER = [
    ['SETTING_UP', 'GitHub connected'],
    ['STARTING', 'Cloud workflow configured'],
    ['INSTALLING', 'Starting Windows cloud'],
    ['CONNECTING_NETWORK', 'Connecting secure network'],
    ['READY', 'Generating configuration'],
];

function setProvisioningState(s) {
    if (!provisioning) return;
    provisioning.state = s;
    provisioning.updatedAt = Date.now();
}

// ── one owner of the data plane at a time ────────────────────────────────────────────
// connect / disconnect / mode-switch / reset all tear the same three machine-wide things
// down and build them back up: a daemon that owns a kernel adapter, a firewall profile,
// and the Windows proxy switch. Run two of them at once — a double click, a mode switch
// landing on top of a connect, the watchdog rebuilding while the user presses disconnect —
// and they interleave: two daemons race for the same UDP port and control pipe, one
// disengage lands after the other's engage (leaving the machine firewalled with no rules,
// i.e. no internet), and the engine's module-level state ends up describing neither.
// None of that is theoretical; it is what "the tunnel connects and drops in a loop" was.
//
// The UI's busy flag is not enough on its own: it is one renderer's opinion, and the HTTP
// API is reachable regardless of what it thinks. So the serialisation lives here.
let dataPlaneQueue = Promise.resolve();
let dataPlaneBusy = false;

function exclusive(fn) {
    const next = dataPlaneQueue.then(
        () => { dataPlaneBusy = true; return fn(); },
        () => { dataPlaneBusy = true; return fn(); },
    );
    // The queue must never inherit a rejection, or every later transition is skipped.
    dataPlaneQueue = next.then(() => { dataPlaneBusy = false; }, () => { dataPlaneBusy = false; });
    return next;
}

function handle(fn) {
    return async (req, res) => {
        try {
            const result = await fn(req, res);
            if (!res.headersSent) res.json(result ?? { ok: true });
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (!res.headersSent) res.status(500).json({ ok: false, error: message });
        }
    };
}

function publicSession(session) {
    if (!session) return null;
    // Corrected clock, not Date.now(): the deadline lives on GitHub's timeline.
    const remainingMs = session.expiresAt ? Math.max(0, session.expiresAt - github.serverNow()) : 0;
    return {
        id: session.id,
        status: session.status,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        remainingMs,
        tailscaleIp: session.tailscaleIp || '',
        hasConfig: !!session.rdp,
        lastError: session.lastError || '',
        // Which account is carrying this session. A login is not a credential, and without
        // it the user cannot tell which of ten accounts their tunnel is actually spending.
        accountId: session.accountId || '',
        accountLogin: session.accountLogin || '',
    };
}

module.exports = function registerGithubTunnelRoutes(app, { broadcastLog, broadcast, readSystemProxy, expose } = {}) {
    const emitLog = (msg) => { try { if (broadcastLog) broadcastLog(`[GitHub Tunnel] ${msg}`); } catch (e) {} };

    // Windows' proxy switch is global, so it is read and written through the very same
    // helpers server.js uses for Xray/Aether — otherwise the two panels would disagree
    // about whether the proxy is on.
    const readProxyState = () => {
        try { return readSystemProxy ? readSystemProxy() : { enabled: false, server: '' }; }
        catch (e) { return { enabled: false, server: '' }; }
    };
    // HTTP_PORT, not SOCKS_PORT: WinINET's ProxyServer is an HTTP proxy and cannot speak
    // SOCKS5 (see gt-engine.js).
    //
    // Ownership is tracked because the switch is global and shared with Xray/GST. Two
    // things depend on knowing whether it is ours:
    //   * turning it OFF blindly silently breaks whatever else had it on;
    //   * leaving it ON when this process dies points every WinINET app on the machine at
    //     127.0.0.1:20813, where nothing is listening any more. That is not "the VPN
    //     stopped working", that is the user's entire internet gone, permanently, with a
    //     cause they cannot possibly guess. It is the single most common way a proxy-mode
    //     VPN bricks a machine, and it needed a synchronous undo on every exit path.
    // Hosts tailscaled itself must reach WITHOUT going through the proxy.
    //
    // In proxy mode the system proxy points at tailscaled's own listener, and tailscaled
    // reads that setting for its outbound HTTPS (its own log: "PAC or proxyConfig
    // changed; updating routes"). With no bypass its control-plane and DERP traffic is
    // proxied through itself — a loop that cannot complete. The tunnel still comes up
    // (the proxy is set only afterwards), then drops the next time the control plane is
    // needed, which is why it looked intermittent rather than broken.
    const TS_PROXY_BYPASS = [
        '*.tailscale.com',
        'tailscale.com',
        '*.tailscale.io',
        'tailscale.io',
        '*.ts.net',
    ];
    let systemProxyOwned = false;
    const setSystemProxy = (enable) => {
        require('../xray-manager').enableSystemProxy(!!enable, engine.HTTP_PORT, { bypass: TS_PROXY_BYPASS });
        systemProxyOwned = !!enable;
    };
    const clearSystemProxy = () => {
        try {
            const st = readProxyState();
            if (!st.enabled) { systemProxyOwned = false; return; }
            if (!systemProxyOwned) {
                emitLog('پراکسی سیستم (متعلق به موتور دیگر) خاموش شد — با تونل GitHub قابل جمع نیست.');
            }
            setSystemProxy(false);
        } catch (e) { systemProxyOwned = false; }
    };

    // Runs on process exit / SIGINT / SIGTERM, synchronously, via the engine's own hooks.
    engine.registerEmergencyUndo(() => {
        if (!systemProxyOwned) return;
        try { require('../xray-manager').enableSystemProxy(false, engine.HTTP_PORT); } catch (e) {}
        systemProxyOwned = false;
    });
    // Installed now rather than on first connect: the undo above has to be armed before
    // anything can possibly set the proxy, not after.
    engine.installExitHooks();
    // On by default: the whole point of the guard is the case where the user is not
    // watching. Off is an explicit choice, kept in memory only so it never silently
    // persists across restarts into a session the user thinks is protected.
    let killSwitchEnabled = true;
    // Why the data plane came down, when it came down on its own. Without it the panel
    // just shows everything switched off and the user is left guessing whether they did
    // it, the app did it, or it broke.
    let teardownReason = '';
    // The outcome of the most recent device-flow sign-in, so the panel can tell the user
    // whether the pool actually grew. Holds a login and a flag — never a credential.
    let lastSignIn = null;

    const broadcastState = () => {
        try {
            if (!broadcast) return;
            broadcast('tun', { running: tun.isRunning() });
            broadcast('system_proxy', readProxyState());
        } catch (e) {}
    };

    // ── GitHub accounts ──────────────────────────────────────────────────────────
    // A completed device-flow sign-in is handed straight to the pool. This is what makes
    // adding the tenth account the same operation as the first: there is no "the account"
    // anywhere in the flow, only a pool that gained a member.
    github.setSignInHandler(async (result) => {
        try {
            const { account, created } = accounts.upsert({
                login: result.login, name: result.name, avatarUrl: result.avatarUrl,
                scopes: result.scopes, token: result.token,
            });
            // WHICH account got authorised is decided by the BROWSER, not by us: the device
            // flow authorises whoever is signed in on github.com. So "add an account" while
            // already signed in as account #1 silently re-authorises account #1 — the pool
            // is unchanged, and without saying so the user is left believing they now have
            // two accounts and wondering why nothing failed over.
            lastSignIn = { login: account.login, created, at: Date.now(), poolSize: accounts.count() };
            emitLog(created
                ? `حساب گیت‌هاب @${account.login} اضافه شد.`
                : `این همان حساب @${account.login} بود که از قبل متصل بود — فقط دسترسی‌اش تازه شد.`);
            if (!github.hasBillingScope(account.scopes)) {
                emitLog(`@${account.login}: دسترسی خواندن سهمیه داده نشد — مصرف به‌صورت تخمینی نشان داده می‌شود.`);
            }
            // Best effort and never blocking: a first quota reading makes the new row
            // useful immediately instead of showing "unknown" until the next poll.
            quota.refresh(account.id, { force: true }).catch(() => {});
        } catch (e) {
            emitLog(`افزودن حساب گیت‌هاب ناموفق بود: ${e.message}`);
        }
    });

    /** The pool, joined with live session ownership. Never includes a token. */
    function accountsView() {
        const sessions = store.getSessions();
        const liveByAccount = new Map();
        for (const s of sessions) {
            if (['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status) && s.accountId) {
                if (!liveByAccount.has(s.accountId)) liveByAccount.set(s.accountId, s.id);
            }
        }
        const leased = allocator.leasedIds();
        return accounts.list().map(a => accounts.publicAccount(a, {
            activeSessionId: liveByAccount.get(a.id) || null,
            inUse: liveByAccount.has(a.id) || leased.includes(a.id),
        }));
    }

    app.get('/api/github-tunnel/accounts', handle(async () => {
        const list = accountsView();
        const active = deployer.activeSession();
        return {
            ok: true,
            accounts: list,
            lastSignIn,
            // Which account the tunnel is on RIGHT NOW — the question the panel exists to
            // answer and the one a per-account list alone cannot.
            currentAccountId: (active && active.accountId) || null,
            poolProblem: list.length ? (list.some(a => a.health !== 'AUTH_REQUIRED' && !a.disabled) ? null : allocator.explainEmptyPool()) : null,
        };
    }));

    // Kept for compatibility with the panel's older status call; the pool is the truth.
    app.get('/api/github-tunnel/github/status', handle(async () => {
        const list = accountsView();
        return {
            ok: true,
            ...github.status(),
            connected: list.length > 0,
            accounts: list,
            account: list[0] || null,
        };
    }));

    app.post('/api/github-tunnel/github/start', handle(async () => {
        const r = await github.startLogin();
        emitLog(`Enter code ${r.userCode} in the browser tab that just opened.`);
        return { ok: true, ...r };
    }));

    app.post('/api/github-tunnel/github/cancel', handle(async () => ({ ok: true, ...github.cancelPending() })));

    /** Remove ONE account from the pool. Ends only that account's own session. */
    app.post('/api/github-tunnel/accounts/remove', handle(async (req) => {
        const id = String((req.body && req.body.id) || '');
        const account = accounts.get(id);
        if (!account) throw new Error('این حساب پیدا نشد.');

        // Only sessions belonging to THIS account. Removing account #2 must not touch a
        // tunnel running on account #1 — that is the whole point of session affinity.
        for (const s of store.getSessions()) {
            if (s.accountId === id && ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status)) {
                await deployer.endSession(s, emitLog);
                // If the live data plane was pointed at that session, it is now pointed at
                // a machine that is being destroyed. Take it down rather than leave the
                // user connected to a corpse behind an engaged kill-switch.
                const engineOn = engine.getStatus().connected || guard.isEngaged();
                if (engineOn && deployer.activeSession() == null) {
                    await exclusive(() => teardownAll('SESSION_ENDED'));
                }
            }
        }
        accounts.remove(id);
        allocator.release(id);
        emitLog(`حساب گیت‌هاب @${account.login} حذف شد.`);
        return { ok: true, accounts: accountsView() };
    }));

    /** Temporarily take an account out of the rotation without forgetting it. */
    app.post('/api/github-tunnel/accounts/toggle', handle(async (req) => {
        const id = String((req.body && req.body.id) || '');
        const disabled = !!(req.body && req.body.disabled);
        if (!accounts.get(id)) throw new Error('این حساب پیدا نشد.');
        accounts.update(id, { disabled });
        return { ok: true, accounts: accountsView() };
    }));

    /** Clear a cooldown the user believes is stale (they fixed billing, the limit lifted). */
    app.post('/api/github-tunnel/accounts/retry', handle(async (req) => {
        const id = String((req.body && req.body.id) || '');
        const a = accounts.get(id);
        if (!a) throw new Error('این حساب پیدا نشد.');
        if (a.health === accounts.HEALTH.AUTH_REQUIRED) {
            throw new Error('این حساب نیاز به اتصال دوباره دارد؛ تلاش مجدد کمکی نمی‌کند.');
        }
        accounts.update(id, { cooldownUntil: 0, consecutiveFailures: 0, health: accounts.HEALTH.UNKNOWN, healthReason: '' });
        await quota.refresh(id, { force: true }).catch(() => {});
        return { ok: true, accounts: accountsView() };
    }));

    app.post('/api/github-tunnel/accounts/refresh', handle(async () => {
        // Sequential on purpose: firing ten billing calls at once is exactly the shape
        // GitHub's secondary rate limiter punishes, and it would cool down the whole pool.
        for (const a of accounts.list()) {
            try { await quota.refresh(a.id, { force: true }); } catch (e) {}
        }
        return { ok: true, accounts: accountsView() };
    }));

    app.post('/api/github-tunnel/github/disconnect', handle(async () => {
        // "Disconnect GitHub" now means the whole pool, so every account's own live session
        // is ended with its own credential.
        for (const s of store.getSessions()) {
            if (['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status)) {
                await deployer.endSession(s, emitLog);
            }
        }
        for (const a of accounts.list()) accounts.remove(a.id);
        emitLog('همه‌ی حساب‌های گیت‌هاب قطع شدند.');
        return { ok: true };
    }));

    // ── setup / renew ────────────────────────────────────────────────────────────
    app.post('/api/github-tunnel/setup', handle(async () => {
        if (provisioning && provisioning.state !== 'READY' && provisioning.state !== 'FAILED') {
            return { ok: true, alreadyRunning: true };
        }
        provisioning = { state: 'SETTING_UP', log: [], error: '', startedAt: Date.now() };
        (async () => {
            try {
                await deployer.createSession({
                    onLog: (msg) => { provisioning.log.push(msg); emitLog(msg); },
                    onState: (s) => setProvisioningState(s),
                });
            } catch (e) {
                provisioning.state = 'FAILED';
                provisioning.error = e.message;
                provisioning.errorCode = e.code || '';
                emitLog(`راه‌اندازی ناموفق بود: ${e.message}`);
            }
        })();
        return { ok: true };
    }));

    app.post('/api/github-tunnel/activate-again', handle(async (req) => {
        const force = !!(req.body && req.body.force);
        if (!force) {
            const existing = deployer.activeSession();
            if (existing) return { ok: true, existing: true, session: publicSession(existing) };
        }
        provisioning = { state: 'RENEWING', log: [], error: '', startedAt: Date.now() };
        (async () => {
            try {
                await deployer.renewSession({
                    force,
                    onLog: (msg) => { provisioning.log.push(msg); emitLog(msg); },
                    onState: (s) => setProvisioningState(s),
                });
            } catch (e) {
                provisioning.state = 'FAILED';
                provisioning.error = e.message;
                provisioning.errorCode = e.code || '';
                emitLog(`تمدید ناموفق بود: ${e.message}`);
            }
        })();
        return { ok: true };
    }));

    app.get('/api/github-tunnel/status', handle(async () => {
        let active = deployer.activeSession() || (store.getSessions()[0] || null);
        // Confirm against the real run (rate-limited internally) before trusting the clock,
        // so a session that died early is reported dead instead of counted down.
        if (active) active = await deployer.reconcile(active);
        const ticked = active ? deployer.tick(active) : null;
        return {
            ok: true,
            provisioning: provisioning ? {
                state: provisioning.state,
                log: provisioning.log.slice(-30),
                error: provisioning.error || '',
                errorCode: provisioning.errorCode || '',
                steps: STEP_ORDER.map(([key, label]) => ({ key, label })),
            } : null,
            session: publicSession(ticked),
        };
    }));

    app.get('/api/github-tunnel/sessions', handle(async () => ({
        ok: true, sessions: store.getSessions().map(publicSession),
    })));

    // ── secure network relay (broker) deploy ────────────────────────────────────
    // Deploys cloudflare-worker/gt-broker/worker.js onto the SAME Cloudflare account
    // already connected in the Cloud module, reusing that account store — one button
    // here instead of a separate wrangler/Tailscale-account onboarding flow.
    app.get('/api/github-tunnel/broker/status', handle(async () => ({ ok: true, ...brokerDeploy.status() })));

    app.post('/api/github-tunnel/broker/url', handle(async (req) => {
        const r = brokerDeploy.setCustomUrl(req.body && req.body.url);
        emitLog(r.customUrl ? `آدرس سرویس شبکه‌ی امن روی «${r.customUrl}» تنظیم شد.` : 'آدرس اختصاصی حذف شد.');
        return { ok: true, ...r };
    }));

    app.post('/api/github-tunnel/broker/deploy', handle(async (req) => {
        const { email, token, accountName, tsClientId, tsClientSecret, tsTailnet } = req.body || {};
        const r = await brokerDeploy.deployBroker({ email, token, accountName, tsClientId, tsClientSecret, tsTailnet, onLog: emitLog });
        emitLog('سرویس شبکه‌ی امن با موفقیت راه‌اندازی شد.');
        return { ok: true, ...r };
    }));

    // ── data plane: connect / disconnect ────────────────────────────────────────
    // Mirrors the Aether engine's contract exactly: connecting only brings the engine up
    // and exposes a local SOCKS port. Whether traffic actually goes through it is then
    // decided by the two independent switches below (system proxy / full tunnel), which is
    // the same split the Aether panel uses.

    app.get('/api/github-tunnel/engine/status', handle(async () => {
        const eng = engine.getStatus();
        return {
            ok: true,
            engine: { ...eng, error: eng.error || teardownReason || '' },
            tun: { running: tun.isRunning() },
            systemProxy: readProxyState(),
            busy: dataPlaneBusy,
            killSwitch: {
                enabled: killSwitchEnabled,
                engaged: guard.isEngaged(),
                // The guard is a firewall allow-list built around the tunnel ADAPTER, and
                // proxy mode has no adapter — so in proxy mode it cannot be engaged at all.
                // The switch used to render "on" there anyway, which told the user they
                // were protected while nothing whatsoever was blocking a leak. Say so.
                applicable: eng.mode !== 'proxy',
            },
        };
    }));

    app.post('/api/github-tunnel/killswitch', handle(async (req) => {
        killSwitchEnabled = !!(req.body && req.body.enabled);
        await exclusive(async () => {
            if (!killSwitchEnabled) await guard.disengage(emitLog);
            else if (engine.getStatus().connected && engine.getStatus().mode === 'tun') {
                try { await engageGuard(); }
                catch (e) { emitLog('محافظ نشت فعال نشد (احتمالاً برنامه دسترسی مدیر ندارد).'); }
            }
        });
        broadcastState();
        return { ok: true, enabled: killSwitchEnabled, engaged: guard.isEngaged() };
    }));

    app.get('/api/github-tunnel/engine/speedtest', handle(async () => ({ ok: true, ...(await engine.speedtest()) })));

    app.get('/api/github-tunnel/engine/diagnose', handle(async () => ({ ok: true, ...(await engine.diagnose()) })));

    // Bring the engine up in a given mode. Every call gets a FRESH key: the keys are
    // single-use, so a mode switch (which restarts the daemon) needs its own.
    async function bringUp(mode) {
        const session = deployer.activeSession();
        if (!session || !session.tailscaleIp) throw new Error('نشست ابری فعالی برای اتصال وجود ندارد.');

        // Only one thing may own the default route. server.js enforces that between Xray,
        // Aether and sing-box through tun-manager — but this mode drives its OWN kernel
        // adapter and never passes through tun-manager, so that interlock did not cover it.
        // Two owners means both keep winning and losing the route, which shows up as the
        // tunnel connecting and dropping in a loop.
        if (mode === 'tun' && tun.isRunning()) {
            throw new Error('یک تونل دیگر (ماسک، وایرگارد، وارپ در وارپ یا V2Ray) روشن است. اول آن را خاموش کنید، بعد تونل GitHub را روشن کنید.');
        }
        if (tun.isRunning()) tun.stopTun(emitLog);
        clearSystemProxy();

        // THE RECONNECT WINDOW, AND WHY THE GUARD NOW STAYS UP THROUGH IT
        //
        // This used to disengage the guard unconditionally before tearing the engine down.
        // That opens a hole for the entire length of a reconnect — the daemon restart, the
        // key mint, `up`, and the verification, which together run tens of seconds — during
        // which the machine is wide open on its real address. And a reconnect is not a rare
        // event: it is what the watchdog does the moment a tunnel wobbles, i.e. exactly
        // when the user is least likely to be looking. Someone with a browser mid-session
        // hands over their real IP and never learns it happened.
        //
        // Nothing actually required that hole. The allow-list is written in terms of an
        // interface ALIAS ('mlmvpn-gt') and two program paths, none of which stop being
        // true while the adapter is recreated, and both the daemon and this app are on it —
        // so a reconnect has every path it needs with the guard still engaged.
        //
        // It comes down only when it genuinely cannot stay: proxy mode has no adapter for
        // the allow rule to point at, so leaving it up would block everything.
        const keepGuard = guard.isEngaged() && mode === 'tun' && killSwitchEnabled;
        if (keepGuard) emitLog('محافظ نشت در طول اتصال مجدد فعال می‌ماند — ترافیک شما در این فاصله بیرون نمی‌رود.');
        else await guard.disengage(emitLog);

        await engine.disconnect(emitLog);

        // Prefer the key taken during setup: the broker may well be unreachable right now
        // (see gt-deployer.js). Only reach for it as a fallback.
        const mintFresh = async () => {
            try {
                const k = await broker.mintAuthKey(`client-${session.id}-${Date.now().toString(36)}`);
                return k.key;
            } catch (e) {
                // The ACL failure names the exact edit that fixes it. Replacing it with
                // "the relay is unreachable" sends the user to debug the wrong thing.
                if (e && e.code === 'ACL_TAG_NOT_PERMITTED') throw e;
                throw new Error('کلید اتصال معتبر نیست و سرویس شبکه‌ی امن هم در دسترس نیست. یک‌بار «تمدید» بزنید تا نشست تازه با کلید جدید ساخته شود.');
            }
        };

        let authKey = session.clientKey || '';
        let r;
        try {
            try {
                if (!authKey) authKey = await mintFresh();
                r = await engine.connect({ exitNodeIp: session.tailscaleIp, authKey, mode, onLog: emitLog });
            } catch (e) {
                // A stored key that the control plane rejects is spent or revoked, and will
                // keep failing forever if left in place. Drop it and try once with a fresh one
                // rather than stranding the session on a dead credential.
                if (session.clientKey && /invalid key|not valid|unauthorized/i.test(e.message || '')) {
                    store.updateSession(session.id, { clientKey: '' });
                    emitLog('کلید ذخیره‌شده معتبر نبود؛ کلید تازه گرفته می‌شود…');
                    authKey = await mintFresh();
                    r = await engine.connect({ exitNodeIp: session.tailscaleIp, authKey, mode, onLog: emitLog });
                } else {
                    throw e;
                }
            }
        } catch (e) {
            // connect() can fail AFTER the daemon is up — a rejected key, an exit node that
            // was never approved, no egress. That leaves a live tailscaled holding an
            // adapter and a DNS policy, attached to nothing, which nobody else will clean
            // up: the watchdog was never started, and the user sees a failed connect and no
            // reason to press disconnect. Tear it down here.
            //
            // The guard is deliberately NOT touched: if it was engaged before this attempt
            // it stays engaged, because a failed reconnect is exactly when fail-closed
            // matters. teardownAll() is what the user's disconnect button reaches.
            try { await engine.disconnect(emitLog); } catch (_) {}
            broadcastState();
            throw e;
        }
        if (mode === 'proxy') setSystemProxy(true);
        teardownReason = '';

        // Only after the tunnel is verified carrying traffic. Engaging earlier would block
        // the very connection being established.
        // Never fatal to the connect. Engaging needs administrator rights (it rewrites the
        // firewall profiles); without them this throws, and letting that propagate reported
        // a WORKING tunnel as a failed connection. Report the guard's own failure instead.
        if (killSwitchEnabled && mode === 'tun' && !guard.isEngaged()) {
            try {
                await engageGuard();
            } catch (e) {
                emitLog('محافظ نشت فعال نشد (احتمالاً برنامه دسترسی مدیر ندارد). تونل برقرار است، ولی اگر قطع شود ترافیک با آی‌پی واقعی خارج می‌شود.');
            }
        }
        broadcastState();
        return r;
    }

    function engageGuard() {
        return guard.engage({
            adapterName: engine.TUN_ADAPTER,
            // Both the copy that would start now and the one a running daemon came from — see the
            // same rule in server.js's WARP guard.
            allowPrograms: [...require('../core-paths').candidates('tailscale', 'tailscaled.exe', engine.DAEMON_EXE), process.execPath],
            onLog: emitLog,
        });
    }

    /** Everything this feature can have switched on, switched back off, in the only order
     *  that never leaves the machine pointed at something dead. */
    async function teardownAll(reason) {
        if (tun.isRunning()) tun.stopTun(emitLog);
        clearSystemProxy();
        await guard.disengage(emitLog);
        await engine.disconnect(emitLog);
        teardownReason = reason || '';
        broadcastState();
    }

    engine.setWatchdogLogger((m) => { emitLog(m); broadcastState(); });

    // How the watchdog recovers a connection whose DAEMON has died, as opposed to one that
    // merely lost its exit node. It cannot do that itself: rebuilding needs the session and
    // an auth key, which the engine deliberately does not hold. Without this the watchdog
    // spent its three attempts issuing `up` at a control socket that no longer existed and
    // then gave up — on a fault a restart fixes in ten seconds.
    engine.setRebuildHandler((mode) => exclusive(() => bringUp(mode)));

    // A degraded tunnel must fail closed, not keep passing traffic on the real address.
    engine.setDegradedHandler(async (verdict) => {
        emitLog(`تونل ناسالم شد (${verdict.code}) — ترافیک تا بازیابی مسدود می‌ماند.`);
        if (killSwitchEnabled && !guard.isEngaged() && engine.getStatus().mode === 'tun') {
            try { await engageGuard(); } catch (e) {}
        }
        broadcastState();
    });

    app.post('/api/github-tunnel/connect', handle(async (req) => {
        const mode = (req.body && req.body.mode) === 'proxy' ? 'proxy' : 'tun';
        return { ok: true, ...(await exclusive(() => bringUp(mode))) };
    }));

    /**
     * Hand the data plane to server.js, so another feature can bring this tunnel up.
     *
     * The «بازی» tab races every engine the app has and must be able to start this one
     * without the user going to the GitHub Tunnel panel. What it gets is exactly what the
     * button above calls — the same mutex, the same key minting, the same leak guard and
     * watchdog. Anything less than the real path would be a second, subtly different way
     * to connect, and the two would drift apart.
     */
    if (typeof expose === 'function') {
        expose({
            bringUp: (mode) => exclusive(() => bringUp(mode === 'proxy' ? 'proxy' : 'tun')),
            teardown: () => exclusive(() => teardownAll('')),
            status: () => engine.getStatus(),
        });
    }

    app.post('/api/github-tunnel/disconnect', handle(async () => {
        // Tear the traffic paths down BEFORE the engine, never after: killing the engine
        // first would leave the system pointed at a dead proxy (or a TUN with no upstream)
        // and take the machine's internet down with it.
        await exclusive(() => teardownAll(''));
        return { ok: true };
    }));

    /**
     * End the CLOUD session, not just the local tunnel.
     *
     * This is the difference between "I stopped using it" and "it stopped costing me". A
     * plain disconnect only takes the data plane down; the GitHub runner keeps executing
     * until its own timeout and keeps consuming the account's Actions allowance the whole
     * time — on a Windows runner at 2x, an idle session left up after a one-hour need burns
     * roughly nine hours of a 2,000-minute monthly allowance for nothing.
     *
     * Deliberately NOT wired into the disconnect button. Disconnect is also the reconnect
     * path (mode switches, watchdog rebuilds, a dropped link the user retries), and a
     * session that cancels itself every time the tunnel blinks would make reconnecting
     * impossible — a new session means a new runner, several minutes of provisioning, and
     * another slice of allowance. Ending is therefore an explicit, separate act.
     */
    app.post('/api/github-tunnel/session/end', handle(async () => {
        const session = deployer.activeSession();
        if (!session) {
            await exclusive(() => teardownAll(''));
            return { ok: true, ended: false };
        }
        const accountId = session.accountId;

        // Data plane first: once the runner is cancelled the exit node is gone, and a TUN
        // still pointed at it behind an engaged kill-switch is a machine with no internet.
        await exclusive(() => teardownAll('SESSION_ENDED'));
        await deployer.endSession(session, emitLog);
        emitLog('نشست ابری پایان یافت — مصرف دقیقه‌های گیت‌هاب از همین لحظه متوقف شد.');

        // Re-read the allowance now rather than at the next poll. The run's real duration is
        // only final once it has stopped, so this is the first moment the number the user is
        // about to look at can be the true one. Never fatal: a billing read that fails says
        // nothing about whether the session ended.
        if (accountId) {
            try { await quota.refresh(accountId, { force: true }); } catch (e) {}
        }
        broadcastState();
        return { ok: true, ended: true, accounts: accountsView() };
    }));

    // ── the two switches ─────────────────────────────────────────────────────────
    // They are two faces of one setting, not two independent toggles: the engine can only
    // be in one mode at a time, and turning either on means restarting it in that mode.

    // Full tunnel: kernel WireGuard adapter, all traffic, UDP included (games, QUIC).
    app.post('/api/github-tunnel/tun', handle(async (req) => {
        const enable = !!(req.body && req.body.enabled);
        if (!enable) {
            await exclusive(() => teardownAll(''));
            return { ok: true, running: false };
        }
        return { ok: true, running: true, ...(await exclusive(() => bringUp('tun'))) };
    }));

    // System proxy: userspace engine, TCP only, no adapter — the compatibility fallback.
    app.post('/api/github-tunnel/proxy', handle(async (req) => {
        const enable = !!(req.body && req.body.enabled);
        if (!enable) {
            await exclusive(() => teardownAll(''));
            return { ok: true, enabled: false };
        }
        return { ok: true, enabled: true, ...(await exclusive(() => bringUp('proxy')))  };
    }));

    // Full reset: everything this feature stored, back to first-run state.
    app.post('/api/github-tunnel/reset', handle(async () => {
        // Order matters. Tear the live pieces down FIRST — a guard left engaged or DNS
        // policy left installed after the config that describes them is gone would be
        // unrecoverable from inside the app.
        await exclusive(() => teardownAll(''));

        // Best-effort: stop every cloud session still running, EACH on the account that
        // owns it, so a reset doesn't leave orphaned runners spending allowances the user
        // is about to lose the ability to cancel (the tokens are wiped a few lines below).
        for (const s of store.getSessions()) {
            if (['READY', 'ACTIVE', 'EXPIRING_SOON', 'STARTING', 'SETTING_UP'].includes(s.status)) {
                try { await deployer.endSession(s, emitLog); } catch (e) {}
            }
        }

        const r = store.resetAll();
        for (const a of accounts.list()) accounts.remove(a.id);
        provisioning = null;
        emitLog('همه‌ی تنظیمات GitHub Tunnel پاک شد.');
        broadcastState();
        return { ok: true, ...r };
    }));

    // ── startup self-heal ────────────────────────────────────────────────────────
    // A previous run may have been killed without cleaning up — crash, Task Manager, an
    // antivirus, power loss. Two things it can leave behind are not "the tunnel didn't
    // work", they are "this PC has no internet and nothing on screen says why":
    //   1. the guard's block-by-default firewall profile, whose only allow rules point at
    //      an adapter that no longer exists;
    //   2. tailscaled's NRPT DNS policy, pointing every lookup at a dead resolver.
    // Both are undone here, before the user touches anything, and in that order — being
    // able to resolve names is no use while every packet is still dropped.
    //
    // This runs unconditionally: no session, no GitHub account and never having opened the
    // panel are all irrelevant to a machine that is currently firewalled shut.
    (async () => {
        try {
            const r = await guard.restoreIfStale(emitLog);
            if (r.error) emitLog(`محافظ نشت باقی‌مانده برداشته نشد: ${r.error}`);
        } catch (e) {}
        try { await engine.sweepStaleState(); } catch (e) {}
    })();

    // ── the session outliving the tunnel, and vice versa ─────────────────────────
    // The cloud session has a hard end: the countdown running out, GitHub cancelling the
    // run, the runner being evicted. When that happens the local engine does not notice
    // anything — it still has a node, still has a "selected" exit node, and the guard is
    // still blocking everything else. The result is a machine with no internet, an app
    // showing a tunnel that is fine, and (because the panel only draws the engine controls
    // while a session is ACTIVE) no disconnect button left on screen to get out of it.
    //
    // So session liveness is checked on the server, on its own timer, rather than being
    // left to whatever the open panel happens to poll.
    const SESSION_WATCH_MS = 30 * 1000;
    const sessionWatch = setInterval(() => {
        // Checked BEFORE taking the lock. Inside it, this tick would mark the data plane
        // busy thirty times an hour for nothing, and the panel disables its switches while
        // that flag is set — a toggle that goes dead for no visible reason is its own bug.
        const engNow = engine.getStatus();
        if (!engNow.connected && !engNow.running && !guard.isEngaged()) return;

        exclusive(async () => {
            const eng = engine.getStatus();
            if (!eng.connected && !eng.running && !guard.isEngaged()) return;

            // activeSession(), not "the newest session": while a renewal is provisioning,
            // the newest record is a half-built one in SETTING_UP, and reading that as
            // "no live session" would tear down the tunnel the user is still using.
            let s = deployer.activeSession();
            if (s) {
                // Arithmetic is not enough — a run can also end EARLY. reconcile() is what
                // catches a cancelled or evicted runner, and it rate-limits itself.
                try { s = await deployer.reconcile(s); } catch (e) { return; }
                s = deployer.tick(s);
                if (s && ['READY', 'ACTIVE', 'EXPIRING_SOON'].includes(s.status)) return;
            }
            emitLog('نشست ابری پایان یافت — اتصال بسته شد. از این پس ترافیک شما مستقیم و با آی‌پی واقعی خارج می‌شود؛ برای ادامه «تمدید» بزنید.');
            await teardownAll('SESSION_ENDED');
        }).catch(() => {});
    }, SESSION_WATCH_MS);
    if (typeof sessionWatch.unref === 'function') sessionWatch.unref();

    if (broadcastLog) emitLog('GitHub Tunnel routes registered');
};
