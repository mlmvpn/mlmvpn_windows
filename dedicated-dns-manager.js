// --- Dedicated DNS Manager (Windows port of Android DedicatedDnsResolver) ---
// Drives the user's own Cloudflare DoH worker. Every mode is encrypted DoH, so the
// anti-filter benefit (Iran's DNS poisoning cannot touch the answer) is always there;
// the modes differ in what the worker does with the query:
//
//   mode 'ecs'  -> public/dns_worker.js  ("مکان‌یابی سرور")
//                  Rewrites the query with an EDNS Client Subnet for the chosen region so
//                  game/CDN lookups return the server closest to that region. Pinned to
//                  dns.google, the one public resolver that honours a client-supplied ECS.
//   mode 'doh'  -> public/doh_worker.js  ("سرعت و پینگ")
//                  No rewriting: passes the query through to the fastest healthy resolver
//                  of eight and caches the answer at the Cloudflare edge, so repeat lookups
//                  are served from the user's own colo and DNS latency leaves the critical
//                  path of every connection.
//
// The two are alternatives, not layers: ECS steering needs a resolver that honours ECS and
// a query rebuilt per region, which is exactly what the caching passthrough must not do.
// Each keeps its own worker URL so deploying one never wipes the other.
//
// Endpoints (both workers implement the same contract):
//   GET /resolve?domain=[&region=] -> JSON {Answer:[{type:1,data:ip}]}  (racing/ping)
//   GET|POST /dns-query[?region=]  -> binary DoH                        (Xray resolver)
// The region table mirrors REGIONS in dns_worker.js / DedicatedDnsResolver.kt.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const axios = require('axios');
const bridge = require('./dedicated-dns-bridge');
const dnsManager = require('./dns-manager');

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

// User data lives OUTSIDE the installation directory.
//
// This used to be <install>/data/, which electron-builder wipes and recreates on every
// build or update — so each new version arrived with the worker URLs erased and the user
// was told to deploy again, every single time. os.homedir()/.mlmvpn is where the rest of
// this app already keeps state (dns-manager, aether, gst), and it survives updates.
const DATA_DIR = path.join(os.homedir(), '.mlmvpn');
const CONFIG_FILE = path.join(DATA_DIR, 'dedicated-dns-config.json');
const LEGACY_CONFIG_FILE = path.join(getUnpackedDir(), 'data', 'dedicated-dns-config.json');
// The resolvers in place immediately before the bridge took over, so switching it off is
// an exact undo rather than a guess.
const BRIDGE_SNAPSHOT_FILE = path.join(DATA_DIR, 'dns-before-bridge.json');

// UAE first = default fallback (mirrors ALL_REGIONS in the Kotlin resolver).
const ALL_REGIONS = [
    { code: 'AE', nameFa: 'امارات', nameEn: 'UAE' },
    { code: 'TR', nameFa: 'ترکیه', nameEn: 'Turkey' },
    { code: 'DE', nameFa: 'آلمان', nameEn: 'Germany' },
    { code: 'SG', nameFa: 'سنگاپور', nameEn: 'Singapore' },
    { code: 'IN', nameFa: 'هند', nameEn: 'India' },
    { code: 'US', nameFa: 'آمریکا', nameEn: 'US' },
];
const DEFAULT_REGION = 'AE';

// Which worker answers lookups. 'ecs' is the default so an existing install keeps the
// exact behaviour it had before this second mode existed.
const MODES = ['ecs', 'doh'];
const DEFAULT_MODE = 'ecs';

// Resolver group for the 'doh' worker (its DNS_MODE binding).
const DOH_GROUPS = [
    { code: 'standard', nameFa: 'استاندارد (سریع‌ترین)', nameEn: 'Standard' },
    { code: 'adblock', nameFa: 'مسدودکننده تبلیغات', nameEn: 'Ad-blocking' },
    { code: 'all', nameFa: 'همه (ترکیبی)', nameEn: 'All' },
];
const DEFAULT_DOH_GROUP = 'standard';

const DEFAULT_CONFIG = {
    enabled: false,
    mode: DEFAULT_MODE,
    workerUrl: '',      // mode 'ecs'  — name kept for configs written before mode existed
    dohWorkerUrl: '',   // mode 'doh'
    // Cloudflare script names, so a re-deploy UPDATES the existing worker instead of
    // creating another one under a new random name.
    workerName: '',
    dohWorkerName: '',
    region: DEFAULT_REGION,
    dohGroup: DEFAULT_DOH_GROUP,
    // System-wide bridge: 127.0.0.1:53 -> the worker over DoH, with Windows pointed at it.
    // Independent of `enabled`, which only governs the in-tunnel (Xray) resolver.
    systemWide: false,
    // Also route IP/SNI-blocked and sanctioned sites through the Xray tunnel via TUN, so
    // "system-wide" covers the sites that clean DNS alone cannot open.
    smartTunnel: true,
    // Set when this feature started the proxy itself, so switching off can stop it again
    // instead of leaving a connection the user never asked for.
    autoStartedProxy: false,
    // What happens to a site in neither list: 'direct' is fastest, 'tunnel' opens
    // everything. Stated as a choice because it genuinely is one.
    smartFallback: 'direct',
    // User overrides: { direct: [], tunnel: [], block: [] }
    routeOverrides: { direct: [], tunnel: [], block: [] },
};

function getConfig() {
    try {
        const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { ...DEFAULT_CONFIG, ...c };
    } catch (e) { /* fall through to the legacy location */ }

    // One-time migration out of the install directory, so an existing deployment is not
    // lost on the upgrade that introduces this change.
    try {
        const legacy = JSON.parse(fs.readFileSync(LEGACY_CONFIG_FILE, 'utf8'));
        const merged = { ...DEFAULT_CONFIG, ...legacy };
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2));
        } catch (e) { /* migration is best effort; the values are still returned */ }
        return merged;
    } catch (e) {
        return { ...DEFAULT_CONFIG };
    }
}

function setConfig(patch) {
    const cur = getConfig();
    const next = { ...cur, ...patch };
    for (const key of ['workerUrl', 'dohWorkerUrl']) {
        if (typeof next[key] === 'string') next[key] = next[key].trim().replace(/\/+$/, '');
    }
    if (next.region) next.region = String(next.region).toUpperCase();
    if (!ALL_REGIONS.some(r => r.code === next.region)) next.region = DEFAULT_REGION;
    next.mode = MODES.includes(String(next.mode)) ? String(next.mode) : DEFAULT_MODE;
    next.dohGroup = DOH_GROUPS.some(g => g.code === next.dohGroup) ? next.dohGroup : DEFAULT_DOH_GROUP;
    try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
    return next;
}

// The URL of whichever worker the given mode uses. Defaults to the active mode.
function workerUrlFor(mode, config) {
    const c = config || getConfig();
    const m = MODES.includes(String(mode)) ? String(mode) : c.mode;
    return (m === 'doh' ? c.dohWorkerUrl : c.workerUrl) || '';
}

// The Cloudflare script name for a mode. Configs written before the name was stored still
// carry the URL, and a workers.dev URL is `https://<script>.<subdomain>.workers.dev` — so
// the name can be recovered from it. Without this, the first re-deploy after upgrading
// would abandon the existing worker and create yet another one.
function workerNameFor(mode, config) {
    const c = config || getConfig();
    const m = MODES.includes(String(mode)) ? String(mode) : c.mode;
    const stored = m === 'doh' ? c.dohWorkerName : c.workerName;
    if (stored) return stored;
    const url = workerUrlFor(m, c);
    if (!url) return '';
    try {
        const label = new URL(url).hostname.split('.')[0];
        return /^[a-z0-9-]{1,60}$/i.test(label) ? label : '';
    } catch (e) {
        return '';
    }
}

function isConfigured(mode) {
    const url = workerUrlFor(mode);
    return !!(url && /^https?:\/\//i.test(url));
}

// The Xray `dns` block. Xray resolves names through the worker's binary DoH endpoint,
// so both anti-filter and region steering apply to every proxied lookup. 1.1.1.1 is a
// bootstrap/fallback used to resolve the worker's own hostname and on worker failure.
function buildXrayDns() {
    const c = getConfig();
    if (!c.enabled) return null;
    const url = workerUrlFor(c.mode, c);
    if (!url || !/^https?:\/\//i.test(url)) return null;
    // The 'doh' worker has no region concept — it answers the query as sent and serves
    // repeats from the edge cache. Appending a region there would only fragment that cache.
    const region = ALL_REGIONS.some(r => r.code === c.region) ? c.region : DEFAULT_REGION;
    const doh = c.mode === 'doh' ? `${url}/dns-query` : `${url}/dns-query?region=${region}`;

    // Split resolution by destination instead of sending everything to one resolver.
    //
    // Iranian names are routed direct anyway (domain:ir -> direct in the Xray rules), so
    // resolving them through Cloudflare is a round trip to Europe for an answer that lives
    // next door — and it returns the CDN edge closest to the worker rather than to the
    // user. The system resolver answers those faster and more correctly, and DNS poisoning
    // is not a concern for names nobody blocks.
    //
    // Everything else goes to the user's worker over DoH, which is the part that has to be
    // tamper-proof. 1.1.1.1 stays last as a plain fallback so a worker outage degrades to
    // slow-but-working rather than to no DNS at all.
    return {
        servers: [
            {
                address: 'localhost',
                domains: ['domain:ir', 'regexp:.*\\.ir$'],
                skipFallback: true
            },
            { address: doh, skipFallback: false },
            '1.1.1.1'
        ],
        queryStrategy: 'UseIPv4',
        disableCache: false,
        // Xray caches answers itself; without a tag its own lookups cannot be routed, and
        // they would fall into the balancer catch-all and go through the tunnel.
        tag: 'dns-out'
    };
}

// --- region racing (mirrors resolveViaWorker + testAllRegions) ---------------

async function resolveViaWorker(workerUrl, hostname, region) {
    const base = String(workerUrl).replace(/\/+$/, '');
    const url = `${base}/resolve?domain=${encodeURIComponent(hostname)}&region=${region}`;
    try {
        const resp = await axios.get(url, { timeout: 3000, responseType: 'json' });
        const answers = (resp.data && resp.data.Answer) || [];
        return answers.filter(a => a.type === 1 && a.data).map(a => a.data);
    } catch (e) {
        return [];
    }
}

function tcpPing(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const start = Date.now();
        const sock = net.connect({ host, port, timeout: timeoutMs });
        let done = false;
        const finish = (ms) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(ms); };
        sock.on('connect', () => finish(Date.now() - start));
        sock.on('timeout', () => finish(-1));
        sock.on('error', () => finish(-1));
    });
}

// Race every region against the worker for the given test endpoints; return per-region
// best ping, sorted (lowest first). Only regions with a pingable IP are included.
async function raceRegions(testEndpoints, port = 443, regions = ALL_REGIONS, samplesPerIp = 3) {
    const c = getConfig();
    // Racing compares what each REGION resolves to, which only the ECS worker can vary.
    if (!isConfigured('ecs')) throw new Error('worker URL is not configured');
    const results = await Promise.all(regions.map(async (region) => {
        const ipSet = new Set();
        for (const ep of testEndpoints) {
            const ips = await resolveViaWorker(c.workerUrl, ep, region.code);
            ips.forEach(ip => ipSet.add(ip));
        }
        if (!ipSet.size) return null;
        let best = Infinity;
        for (const ip of ipSet) {
            for (let i = 0; i < samplesPerIp; i++) {
                const ms = await tcpPing(ip, port, 2500);
                if (ms >= 0 && ms < best) best = ms;
            }
        }
        if (best === Infinity) return null;
        return { region, pingMs: best, ips: [...ipSet] };
    }));
    return results.filter(Boolean).sort((a, b) => a.pingMs - b.pingMs);
}

// --- lookup latency test (mode 'doh') ---------------------------------------

// Times /resolve twice per domain against the given mode's worker. The second pass is
// the one that matters: it should come back from the edge cache, and the gap between the
// two numbers is the DNS latency this mode removes from every new connection.
async function measureWorker(mode, domains = ['www.google.com', 'discord.com', 'store.steampowered.com']) {
    const c = getConfig();
    const url = workerUrlFor(mode, c);
    if (!url || !/^https?:\/\//i.test(url)) throw new Error('worker URL is not configured');
    const region = c.region || DEFAULT_REGION;

    const timeOnce = async (domain) => {
        const start = Date.now();
        const ips = await resolveViaWorker(url, domain, region);
        return { ms: Date.now() - start, ok: ips.length > 0, ips };
    };

    const results = [];
    for (const domain of domains) {
        const cold = await timeOnce(domain);
        const warm = await timeOnce(domain);
        results.push({ domain, coldMs: cold.ms, warmMs: warm.ms, ok: cold.ok || warm.ok, ips: cold.ips });
    }
    const okResults = results.filter(r => r.ok);
    const avg = (key) => okResults.length
        ? Math.round(okResults.reduce((s, r) => s + r[key], 0) / okResults.length)
        : -1;
    return { mode: mode || c.mode, url, results, avgColdMs: avg('coldMs'), avgWarmMs: avg('warmMs') };
}

// --- system-wide bridge (127.0.0.1:53 -> worker over DoH) -------------------

// The DoH endpoint the bridge forwards to. The ECS worker wants its region on the query
// string; the fast worker must not have one (it would fragment its edge cache).
function bridgeDohUrl(config) {
    const c = config || getConfig();
    const url = workerUrlFor(c.mode, c);
    if (!url) return '';
    return c.mode === 'doh' ? `${url}/dns-query` : `${url}/dns-query?region=${c.region || DEFAULT_REGION}`;
}

// Is a deployed worker actually alive? A saved URL is not evidence: Cloudflare answers
// 404 "error code: 1042" for a workers.dev name whose route never took, which is
// indistinguishable from a name that was never deployed.
async function probeWorker(baseUrl) {
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return false;
    try {
        const resp = await axios.get(`${baseUrl}/resolve?domain=www.google.com`, { timeout: 6000, validateStatus: () => true });
        return resp.status === 200;
    } catch (e) {
        return false;
    }
}

// Xray's SOCKS inbound; the tunnel dials into it. Read live — «پورت محلی» in Settings moves it.
const XRAY_SOCKS_PORT_NOW = () => require('./xray-manager').getPorts().socks;

/**
 * Bring up split-tunnel TUN on top of the DNS bridge.
 *
 * Requires a live Xray: TUN with no working proxy behind it takes the machine's default
 * route hostage and the user loses all internet with no obvious cause. startTun() already
 * refuses in that case, and the reason is passed back up rather than thrown, because the
 * DNS half of the feature is useful on its own and must not be rolled back over this.
 */
async function startSmartTunnel(onLog = () => {}) {
    const c = getConfig();
    try {
        const tun = require('./tun-manager');
        const xray = require('./xray-manager');

        if (!xray.isRunning()) {
            // Bring one up from what is already stored, rather than sending the user to
            // another tab to do it by hand. One switch is supposed to be the whole job.
            onLog('[AUTO] هیچ اتصالی فعال نیست — اتصال خودکار از کانفیگ‌های ذخیره‌شده…');
            const auto = await require('./auto-connect').ensureProxy(onLog, XRAY_SOCKS_PORT_NOW());
            if (!auto.ok) {
                return { started: false, reason: auto.reason, message: auto.message };
            }
            // Remember that this switch started the proxy, so switching off can put the
            // machine back exactly as it was. A connection the user never asked for should
            // not outlive the feature that opened it.
            if (!auto.alreadyRunning) setConfig({ autoStartedProxy: true });
        }
        if (tun.isRunning()) return { started: true, alreadyRunning: true };

        await tun.startTun(XRAY_SOCKS_PORT_NOW(), onLog, {
            mode: 'smart',
            processName: 'xray.exe',
            engineLabel: 'Xray',
            supportsUdp: true,
            fallback: c.smartFallback === 'tunnel' ? 'tunnel' : 'direct',
            // Lookups go to the same worker the bridge uses, so both halves agree on what
            // an honest answer is.
            dohUrl: bridgeDohUrl(c),
            overrides: c.routeOverrides,
        });
        return { started: true, fallback: c.smartFallback || 'direct' };
    } catch (e) {
        return { started: false, reason: 'error', message: e.message };
    }
}

// Turn the whole thing on: start the local resolver, then point Windows at it. The order
// matters — pointing Windows at a port nothing is listening on takes the machine's DNS
// down entirely, so the listener has to be up and answering first.
async function enableSystemWide(onLog = () => {}) {
    const c = getConfig();
    const doh = bridgeDohUrl(c);
    if (!doh) throw new Error('اول Worker این حالت را مستقر کن.');

    // The local resolver can be impossible on this machine — a DNS client like Shecan can
    // capture port 53 at driver level, where no amount of retrying helps. That is not a
    // reason to abandon the whole feature: the smart tunnel resolves DNS inside sing-box
    // and never touches port 53, so it still delivers clean answers and opens blocked
    // sites. Fall through to it instead of failing the switch.
    try {
        await bridge.start(doh);
    } catch (e) {
        if (c.smartTunnel === false) throw e;
        onLog(`[DNS] سرویس محلی ممکن نشد: ${e.message.split('\n')[0]}`);
        onLog('[DNS] ادامه با تونل هوشمند — DNS داخل تونل حل می‌شود و به پورت ۵۳ کاری ندارد.');
        const tunnelOnly = await startSmartTunnel(onLog);
        if (!tunnelOnly.started) {
            throw new Error(`${e.message}\n\nتونل هوشمند هم روشن نشد: ${tunnelOnly.message || tunnelOnly.reason}`);
        }
        setConfig({ systemWide: true });
        return {
            ok: true,
            bridgeSkipped: true,
            tunnel: tunnelOnly,
            message: 'سرویس DNS محلی به‌خاطر تداخل با یک برنامه‌ی DNS دیگر روشن نشد، ولی تونل هوشمند فعال است و ' +
                     'DNS را داخل تونل حل می‌کند — سایت‌های فیلترشده باز می‌شوند.',
        };
    }

    // Prove it answers before handing Windows over to it. Pointing the machine at a
    // resolver that cannot resolve is worse than not turning the feature on at all.
    //
    // Retried, because the most common reason for a failure here is a route that is still
    // coming up — the same propagation window the deploy step waits through. Failing on the
    // first 404 told the user to re-deploy a worker that was about to start working.
    let lastProbeError = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
        try {
            await bridge.testResolve('www.google.com');
            lastProbeError = null;
            break;
        } catch (e) {
            lastProbeError = e;
            if (attempt < 5) await new Promise(r => setTimeout(r, attempt * 3000));
        }
    }

    const MODE_NAMES = { ecs: 'مکان‌یابی سرور', doh: 'سرعت و پینگ' };
    let switchedFrom = null;

    if (lastProbeError) {
        // Before failing, try the OTHER mode's worker. Both modes are DNS resolvers; if one
        // route is still coming up and the other is live, refusing to start is a dead end
        // the user cannot act on. Switch, and say so — never silently.
        const otherMode = c.mode === 'doh' ? 'ecs' : 'doh';
        const otherUrl = workerUrlFor(otherMode, c);
        if (otherUrl && await probeWorker(otherUrl)) {
            await bridge.stop();
            const next = setConfig({ mode: otherMode });
            await bridge.start(bridgeDohUrl(next));
            try {
                await bridge.testResolve('www.google.com');
                switchedFrom = c.mode;
                lastProbeError = null;
            } catch (e2) {
                lastProbeError = e2;
                setConfig({ mode: c.mode });
            }
        }
    }

    if (lastProbeError) {
        await bridge.stop();
        // Name the worker and the URL. "worker HTTP 404" on its own sent an entire
        // debugging session down the wrong path.
        throw new Error(
            `Worker حالت «${MODE_NAMES[c.mode]}» هنوز جواب نمی‌دهد (${lastProbeError.message}).\n${doh}\n` +
            'اگر همین الان مستقرش کرده‌ای، مسیرش روی کلادفلر هنوز بالا نیامده — چند دقیقه صبر کن و ' +
            'دوباره «روشن کردن» را بزن. نیازی به استقرار دوباره نیست.'
        );
    }

    // Photograph the resolvers as they are RIGHT NOW, before overwriting them, so switching
    // the feature off restores what the user actually had rather than a months-old record.
    await dnsManager.snapshotCurrent(BRIDGE_SNAPSHOT_FILE);

    // bridge.LISTEN_ADDR is whatever actually bound — 127.0.0.1 if it was free, another
    // loopback address if another DNS tool had taken it. Windows must be told the same one.
    const applied = await dnsManager.applyServers([bridge.LISTEN_ADDR], 'DNS اختصاصی (محلی)');
    if (!applied.ok) {
        await bridge.stop();
        throw new Error(applied.message || 'تنظیم DNS ویندوز انجام نشد.');
    }

    setConfig({ systemWide: true });

    // Clean DNS opens what DNS poisoning closed. It cannot touch a site blocked by IP or
    // SNI — for those the traffic itself has to leave the country, which is what the smart
    // TUN adds. It is attempted here rather than sold as part of the DNS switch, and a
    // failure to start it never takes the DNS bridge down with it.
    const tunnel = c.smartTunnel === false ? { started: false, reason: 'disabled' } : await startSmartTunnel(onLog);

    return {
        ok: true,
        address: bridge.LISTEN_ADDR,
        port: bridge.LISTEN_PORT,
        current: applied.current,
        switchedFrom,
        tunnel,
        message: switchedFrom
            ? `Worker حالت «${MODE_NAMES[switchedFrom]}» هنوز آماده نبود، پس با حالت «${MODE_NAMES[getConfig().mode]}» روشن شد.`
            : undefined,
    };
}

// Windows is restored FIRST: stopping the listener while the adapters still point at
// 127.0.0.1 would leave the machine with no working resolver at all.
async function disableSystemWide() {
    // TUN comes down FIRST. It holds the machine's default route, and leaving it up while
    // the resolver behind it disappears is the same "no internet, no obvious cause" state
    // the DNS half is careful to avoid.
    try {
        const tun = require('./tun-manager');
        if (tun.isRunning()) tun.stopTun(() => {});
    } catch (e) { /* never block the DNS restore below */ }

    // Only stop the proxy if THIS switch started it. A connection the user made themselves
    // in the V2Ray tab is theirs, and killing it here would look like an unrelated crash.
    try {
        if (getConfig().autoStartedProxy) {
            require('./xray-manager').stopXray();
            setConfig({ autoStartedProxy: false });
        }
    } catch (e) { /* the DNS restore below matters more */ }

    let restored = null;
    try {
        restored = await dnsManager.restoreSnapshot(BRIDGE_SNAPSHOT_FILE);
    } catch (e) { /* handled by the guarantee below */ }

    // restoreSnapshot already sweeps any adapter left on 127.0.0.1, but if the whole call
    // failed (elevation refused, script error) the machine may still be pointing at a
    // resolver that is about to stop existing. Never leave that state behind quietly.
    if (!restored || restored.stillLoopback) {
        try { restored = await dnsManager.applyServers(['1.1.1.1', '1.0.0.1'], 'کلادفلر'); }
        catch (_) { /* nothing further we can do without elevation */ }
    }

    await bridge.stop();
    setConfig({ systemWide: false });

    const ok = !!(restored && restored.ok !== false && !restored.stillLoopback);
    return {
        ok,
        current: restored && restored.current,
        message: ok ? undefined
            : 'DNS ویندوز کاملاً برنگشت — دسترسی مدیر داده نشد. تا وقتی روی ۱۲۷.۰.۰.۱ بماند اینترنت کار نمی‌کند.',
    };
}

function systemWideStatus() {
    const c = getConfig();
    let tunnelRunning = false;
    let proxyRunning = false;
    try { tunnelRunning = require('./tun-manager').isRunning(); } catch (e) {}
    try { proxyRunning = require('./xray-manager').isRunning(); } catch (e) {}
    return {
        ...bridge.getStatus(),
        configured: !!bridgeDohUrl(c),
        wanted: !!c.systemWide,
        dohUrl: bridgeDohUrl(c),
        mode: c.mode,
        smartTunnel: c.smartTunnel !== false,
        smartFallback: c.smartFallback || 'direct',
        tunnelRunning,
        proxyRunning,
    };
}

// Live health of BOTH deployed workers, so the panel can show that one of them is dead
// instead of letting the user find out through an error on an unrelated button.
async function checkWorkers() {
    const c = getConfig();
    const [ecs, doh] = await Promise.all([
        probeWorker(workerUrlFor('ecs', c)),
        probeWorker(workerUrlFor('doh', c)),
    ]);
    return {
        mode: c.mode,
        ecs: { url: workerUrlFor('ecs', c), deployed: !!workerUrlFor('ecs', c), alive: ecs },
        doh: { url: workerUrlFor('doh', c), deployed: !!workerUrlFor('doh', c), alive: doh },
    };
}

// Restart the bridge against the current mode's worker. Called after the mode or worker
// URL changes, so a system-wide session does not keep forwarding to the old worker.
async function refreshSystemWide() {
    const c = getConfig();
    if (!c.systemWide || !bridge.getStatus().running) return { ok: true, restarted: false };
    const doh = bridgeDohUrl(c);
    if (!doh) return { ok: true, restarted: false };
    if (bridge.getStatus().dohUrl === doh) return { ok: true, restarted: false };
    await bridge.stop();
    await bridge.start(doh);
    return { ok: true, restarted: true, dohUrl: doh };
}

/**
 * The worker version THIS build ships, and how to ask a deployed one what it is.
 *
 * Keep in step with WORKER_VERSION in public/dns_worker.js — they are two halves of one number, and
 * the whole mechanism is worthless if they drift.
 */
const SHIPPED_WORKER_VERSION = 2;

/**
 * What is deployed at `url`, and whether it is behind this build.
 *
 * A worker from before this endpoint existed answers the /version path with its ordinary resolver
 * JSON (or a 404), and that is not a failure — it is version 1, which is exactly what needs saying.
 * Reported as `unknown` rather than guessed at only when the URL cannot be reached at all, because
 * "your worker is old" and "your worker is unreachable" call for different actions.
 */
async function workerVersion(url, timeoutMs = 8000) {
    const base = String(url || '').replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(base)) return { ok: false, reason: 'no-url' };
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(base + '/version', { signal: ctl.signal, headers: { accept: 'application/json' } });
        if (!r.ok) return { ok: true, version: 1, stale: SHIPPED_WORKER_VERSION > 1, shipped: SHIPPED_WORKER_VERSION };
        const j = await r.json().catch(() => null);
        const v = j && Number(j.version);
        if (!Number.isFinite(v)) return { ok: true, version: 1, stale: SHIPPED_WORKER_VERSION > 1, shipped: SHIPPED_WORKER_VERSION };
        return { ok: true, version: v, stale: v < SHIPPED_WORKER_VERSION, shipped: SHIPPED_WORKER_VERSION };
    } catch (e) {
        return { ok: false, reason: e.name === 'AbortError' ? 'timeout' : (e.message || 'error') };
    } finally { clearTimeout(t); }
}

module.exports = {
    SHIPPED_WORKER_VERSION, workerVersion,
    ALL_REGIONS, DEFAULT_REGION, MODES, DEFAULT_MODE, DOH_GROUPS, DEFAULT_DOH_GROUP,
    getConfig, setConfig, isConfigured, workerUrlFor, workerNameFor,
    buildXrayDns, resolveViaWorker, raceRegions, measureWorker,
    bridgeDohUrl, enableSystemWide, disableSystemWide, systemWideStatus, refreshSystemWide,
    probeWorker, checkWorkers, startSmartTunnel,
    testSystemWide: (domain) => bridge.testResolve(domain),
};
