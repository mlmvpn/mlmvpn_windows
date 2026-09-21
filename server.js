
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent');
// server.js — سرور اصلی MLM VPN
const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const path = require('path');
const warpMainRanges = ['162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24'];
const warpAltRanges = ['188.114.96.0/24', '188.114.97.0/24', '188.114.98.0/24'];
const warpIpv6Ranges = ['2606:4700:d0::/48', '2606:4700:d1::/48'];
const { AKAMAI_RANGES, fetchCloudflareRanges, fetchFastlyRanges, fetchAwsRanges, fetchGoogleRanges, fetchAzureRanges, fetchGcoreRanges, sampleFromRanges, parseUserInput } = require('./ip-provider');
const { runScanPool, checkIsp } = require('./scanner');
const { startXray, stopXray, startBatchXray, stopBatchXray, restartXray } = require('./xray-manager');
const { startSniEngine, stopSniEngine } = require('./sni-manager');
const sanction = require('./sanction-manager');
const dedicatedDns = require('./dedicated-dns-manager');
const tlsFingerprint = require('./tls-fingerprint');
const aether = require('./aether-manager');
// «وارپ» is deliberately NOT aether — see the /api/warp routes and warp-manager.js.
const warp = require('./warp-manager');
const aetherDnsBridge = require('./aether-dns-bridge');
const aetherGuard = require('./aether-guard');
const tun = require('./tun-manager');
const cloudManager = require('./cloud-manager');
const trafficMgr = require('./traffic-manager');
const trafficFeed = require('./traffic-feed');
const psiphon = require('./psiphon-manager');
const torEngine = require('./tor-manager');
const gephEngine = require('./geph-manager');
const gateway = require('./gateway-manager');
const openvpn = require('./openvpn-manager');
const lantern = require('./lantern-manager');
const store = require('./store-manager');
const { generateSafeSubdomain, generateSafeWorkerName, applySniCamouflage, containsBlacklistedKeyword } = require('./anti-dpi');
// Direct-first fetch with the edge-proxy fallback. Written for the GitHub Tunnel, but the
// problem is identical anywhere this app must reach a workers.dev host from Iran.
const { gtFetch } = require('./github-tunnel/gt-net');
const net = require('net');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
    if (request.url === '/ws') {
        wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    } else {
        socket.destroy();
    }
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve index.html dynamically to inject initial storage state (prevents async race conditions)
app.get(['/', '/index.html'], (req, res) => {
    try {
        let html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        const stateStr = JSON.stringify(storageManager.getAll());
        // The netdiag token rides along in the same rewrite. It is defence in depth only —
        // this route is unauthenticated, so any local process can read the token from here —
        // and the Host allowlist in netdiag/routes.js is what actually stops DNS rebinding.
        const netdiagToken = JSON.stringify(require('./netdiag/routes').TOKEN);
        html = html.replace('<head>', `<head><script>window.__INITIAL_STORAGE_STATE__ = ${stateStr}; window.__NETDIAG_TOKEN__ = ${netdiagToken};</script>`);
        res.send(html);
    } catch (e) {
        res.status(500).send('Error loading app');
    }
});

app.use(express.static(path.join(__dirname, 'public')));

// State
let currentScanId = 0;
let currentScanConcurrencyObj = { value: 50 };
let scanState = { id: 0, running: false, stopRequested: false, results: [], total: 0, tested: 0, alive: 0, dead: 0 };

// ✅ Result Batching - بجای ارسال هر نتیجه به صورت جداگانه، آنها را جمع می‌کنیم
let resultBatch = [];
let batchFlushTimer = null;
const BATCH_INTERVAL_MS = 400; // هر 400 میلی‌ثانیه یکبار flush می‌شود

function flushResultBatch() {
    if (resultBatch.length === 0) return;
    const batch = resultBatch;
    resultBatch = [];
    const progress = { total: scanState.total, tested: scanState.tested, alive: scanState.alive, dead: scanState.dead };
    const msg = JSON.stringify({ type: 'batch_result', data: { results: batch, progress } });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function scheduleBatchFlush() {
    if (batchFlushTimer) return;
    batchFlushTimer = setTimeout(() => {
        batchFlushTimer = null;
        flushResultBatch();
    }, BATCH_INTERVAL_MS);
}
let cloudflareRanges = [];
let fastlyRanges = [];
let awsRanges = [];
let googleRanges = [];
let azureRanges = [];
let gcoreRanges = [];

// دریافت رنج‌های Cloudflare هنگام شروع
(async () => {
    try {
        cloudflareRanges = await fetchCloudflareRanges();
        fastlyRanges = await fetchFastlyRanges();
        awsRanges = await fetchAwsRanges();
        googleRanges = await fetchGoogleRanges();
        azureRanges = await fetchAzureRanges();
        gcoreRanges = await fetchGcoreRanges();
        console.log(`✅ لیست آی‌پی تمامی ۷ سرویس‌دهنده دریافت شد`);
    } catch (e) {
        console.log('⚠️ خطا در دریافت برخی رنج‌ها، از مقادیر پشتیبان استفاده می‌شود');
    }
})();

// ارسال به همه کلاینت‌های WebSocket
function broadcast(type, data) {
    const msg = JSON.stringify({ type, data });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

// ── Live speed and usage, from every engine (traffic-feed.js) ─────────────────────────
// Until 1.2.2 only Xray and SNI were ever counted, so the GitHub tunnel, the full-system
// tunnel to a WARP engine and the Google Script tunnel showed zero speed and zero usage.
// Sources are ranked from the outermost engine in and only the outermost active one is
// counted — a V2Ray node inside the full-system tunnel, or anything inside the GitHub
// tunnel's adapter, is never counted twice.
trafficFeed.setEmitter((payload) => broadcast('traffic_update', payload));
// Who carries whose bytes (traffic-feed.js › ONE COUNT PER BYTE). The GitHub tunnel's exit
// carries every other engine only in its TUNNEL mode; as a proxy it carries just the apps
// pointed at it, and a WARP engine beside it is counted too. Xray carries the full-system
// tunnel's bytes only when Xray is the engine behind it — under ماسک / وایرگارد / وارپ در وارپ
// the Xray standing by for the system proxy is idle, and letting it outrank the tunnel is what
// left those three reading zero speed and zero usage.
const gtCarriesAll = () => {
    try { const s = require('./github-tunnel/gt-engine').getStatus(); return !!(s.connected && s.mode === 'tun'); } catch (e) { return false; }
};
trafficFeed.registerCounter('github-tunnel', {
    active: () => { try { return require('./github-tunnel/gt-engine').getStatus().connected; } catch (e) { return false; } },
    read: () => require('./github-tunnel/gt-engine').readTrafficCounters(),
    covers: () => gtCarriesAll(),
});
trafficFeed.registerCounter('tun', { active: () => !!tun.isRunning(), read: () => tun.readTrafficCounters(), covers: () => false });
trafficFeed.registerPush('xray', {
    active: () => require('./xray-manager').isTrafficPolling(),
    immediate: true,
    covers: (other) => (other === 'tun' ? tun.currentEngine() === 'xray.exe' : other === 'gst' || other === 'sni'),
});
trafficFeed.registerCounter('gst', {
    active: () => { try { return require('./gst/gst-core').isRunning(); } catch (e) { return false; } },
    read: () => require('./gst/gst-core').readTrafficCounters(),
    covers: (other) => (other === 'tun' ? tun.currentEngine() === 'gst.exe' : other === 'sni'),
});
trafficFeed.registerPush('sni', { active: () => { try { return require('./sni-manager').isSniRunning(); } catch (e) { return false; } }, covers: () => false });
// Psiphon counts its own bytes — the core emits BytesTransferred, which is why EmitBytesTransferred
// is set in its config. It covers the full-system tunnel only when IT is the engine behind it, the
// same rule Xray and the Google Script tunnel follow: under any other engine the numbers would be
// someone else's.
trafficFeed.registerCounter('psiphon', {
    active: () => { try { return psiphon.getStatus().connected; } catch (e) { return false; } },
    read: () => psiphon.readTrafficCounters(),
    covers: (other) => (other === 'tun' ? tun.currentEngine() === 'psiphon.exe' : false),
});
// The gateway reports its own byte counters (the client's session statistics), and it covers
// nothing else: it routes through its own adapter rather than through the app's tunnel, so there
// is no inner engine whose bytes it could be double-counting.
// OpenVPN counts its own bytes on the management interface. It covers the tunnel adapter only
// when IT built one — the same rule Xray, GST and Psiphon follow.
trafficFeed.registerCounter('openvpn', {
    active: () => { try { return openvpn.getStatus().connected; } catch (e) { return false; } },
    read: () => openvpn.readTrafficCounters(),
    covers: () => false,
});
trafficFeed.registerCounter('gateway', {
    active: () => { try { return gateway.getStatus().connected; } catch (e) { return false; } },
    read: () => gateway.readTrafficCounters(),
    covers: () => false,
});
// Tor has NO counter of its own and is not given a fake one. No ControlPort is opened (nothing
// needs it, and an open control port is an attack surface), so the honest source for a Tor session
// is the tunnel's own adapter counters — which is what 'tun' already reports. In proxy mode there
// is nothing to count, and reporting zero is the truth rather than a bug.
trafficFeed.start();

// ============================================================
// ✅ Persistent Storage Manager — ذخیره‌سازی فایلی مستقل از پورت
// ============================================================
const os = require('os');
const STORAGE_DIR = path.join(os.homedir(), '.mlmvpn');
const STORAGE_FILE = path.join(STORAGE_DIR, 'user_data.json');

class StorageManager {
    constructor() {
        this._data = {};
        this._saveTimer = null;
        this._load();
    }

    _load() {
        try {
            if (!fs.existsSync(STORAGE_DIR)) {
                fs.mkdirSync(STORAGE_DIR, { recursive: true });
            }
            if (fs.existsSync(STORAGE_FILE)) {
                const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
                this._data = JSON.parse(raw);
                console.log(`✅ [Storage] ${Object.keys(this._data).length} key(s) loaded from ${STORAGE_FILE}`);
            } else {
                console.log(`📦 [Storage] No existing data file found. Starting fresh.`);
            }
        } catch (e) {
            console.error('⚠️ [Storage] Failed to load user_data.json:', e.message);
            // Try to read backup
            try {
                const backupFile = STORAGE_FILE + '.bak';
                if (fs.existsSync(backupFile)) {
                    const raw = fs.readFileSync(backupFile, 'utf8');
                    this._data = JSON.parse(raw);
                    console.log('✅ [Storage] Restored from backup file.');
                }
            } catch (e2) {
                this._data = {};
            }
        }
    }

    _scheduleSave() {
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            this._saveTimer = null;
            this._saveNow();
        }, 300);
    }

    _saveNow() {
        try {
            if (!fs.existsSync(STORAGE_DIR)) {
                fs.mkdirSync(STORAGE_DIR, { recursive: true });
            }
            const json = JSON.stringify(this._data, null, 2);
            // Write to temp file then rename for atomic write (prevents corruption)
            const tempFile = STORAGE_FILE + '.tmp';
            fs.writeFileSync(tempFile, json, 'utf8');
            // Keep a backup of the previous file
            if (fs.existsSync(STORAGE_FILE)) {
                try { fs.copyFileSync(STORAGE_FILE, STORAGE_FILE + '.bak'); } catch (e) {}
            }
            fs.renameSync(tempFile, STORAGE_FILE);
        } catch (e) {
            console.error('⚠️ [Storage] Failed to save:', e.message);
        }
    }

    getItem(key) {
        return this._data.hasOwnProperty(key) ? this._data[key] : null;
    }

    setItem(key, value) {
        this._data[key] = value;
        this._scheduleSave();
    }

    removeItem(key) {
        delete this._data[key];
        this._scheduleSave();
    }

    getAll() {
        return { ...this._data };
    }

    // Force immediate save (called on app shutdown)
    flush() {
        if (this._saveTimer) {
            clearTimeout(this._saveTimer);
            this._saveTimer = null;
        }
        this._saveNow();
    }
}

const storageManager = new StorageManager();

// Ensure data is saved on process exit
process.on('exit', () => { storageManager.flush(); });
process.on('SIGINT', () => { storageManager.flush(); process.exit(); });
process.on('SIGTERM', () => { storageManager.flush(); process.exit(); });

// API: خواندن تمام داده‌ها (bulk load)
app.get('/api/storage', (req, res) => {
    res.json(storageManager.getAll());
});

// API: خواندن یک مقدار
app.get('/api/storage/:key', (req, res) => {
    const val = storageManager.getItem(req.params.key);
    if (val === null) return res.status(404).json({ error: 'not found' });
    res.json({ value: val });
});

// API: نوشتن یک مقدار
app.post('/api/storage/:key', (req, res) => {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value required' });
    storageManager.setItem(req.params.key, value);
    storageManager.flush(); // persist immediately so it survives an abrupt app close
    res.json({ success: true });
});

// API: حذف یک مقدار
app.delete('/api/storage/:key', (req, res) => {
    storageManager.removeItem(req.params.key);
    storageManager.flush(); // persist deletion immediately
    res.json({ success: true });
});

// API: نوشتن چندین مقدار (bulk save)
app.post('/api/storage-bulk', (req, res) => {
    const { items } = req.body;
    if (!items || typeof items !== 'object') return res.status(400).json({ error: 'items object required' });
    for (const [key, value] of Object.entries(items)) {
        storageManager.setItem(key, value);
    }
    storageManager.flush(); // persist immediately (survives sendBeacon-on-close + abrupt exit)
    res.json({ success: true });
});

// API: رنج‌های موجود
app.get('/api/ranges', (req, res) => {
    res.json({ cloudflare: cloudflareRanges, akamai: AKAMAI_RANGES });
});

// API: Serve config.txt from root directory or unpacked dir
app.get('/config.txt', (req, res) => {
    let configPath = path.join(__dirname, 'config.txt');
    if (!fs.existsSync(configPath) && __dirname.includes('app.asar')) {
        configPath = path.join(__dirname.replace('app.asar', 'app.asar.unpacked'), 'config.txt');
    }
    
    if (fs.existsSync(configPath)) {
        res.sendFile(configPath);
    } else {
        res.status(404).send('Config file not found');
    }
});



// API: دریافت مصرف Worker از کلودفلر
app.post('/api/cloudflare/verify', async (req, res) => {
    try {
        const { email, token, panelType = 'BPB' } = req.body;
        if (!token) {
            return res.status(400).json({ success: false, errors: [{ message: 'Token is required' }] });
        }

        const _token = token.trim();
        const _email = (email || '').trim();
        const isCfat = _token.startsWith('cfat_') || _token.length === 40 || _email === '';
        const headers = { 'Content-Type': 'application/json' };
        if (isCfat) {
            headers['Authorization'] = `Bearer ${_token}`;
        } else {
            headers['X-Auth-Email'] = _email;
            headers['X-Auth-Key'] = _token;
        }

        const axios = require('axios');
        const response = await axios.get('https://api.cloudflare.com/client/v4/accounts', {
            headers,
            validateStatus: () => true
        });

        res.json(response.data);
    } catch (error) {
        console.error('Verify error:', error);
        res.status(500).json({ success: false, errors: [{ message: error.message }] });
    }
});

app.post('/api/cloudflare/usage', async (req, res) => {
    const { email, token, panelType = 'BPB' } = req.body;
    if (!token) return res.json({ success: false, message: 'No token' });

    try {
        const headers = { 'Content-Type': 'application/json' };
        if (token.startsWith('cfat_') || !email) {
            headers['Authorization'] = `Bearer ${token}`;
        } else {
            headers['X-Auth-Email'] = email;
            headers['X-Auth-Key'] = token;
        }

        const accResp = await axios.get('https://api.cloudflare.com/client/v4/accounts', {
            headers, timeout: 10000
        });

        let accountId = "";
        if (accResp.data && accResp.data.success && accResp.data.result.length > 0) {
            accountId = accResp.data.result[0].id;
        } else {
            return res.json({ success: false, message: 'Could not fetch account ID' });
        }

        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);
        const start = today.toISOString();
        today.setUTCHours(23, 59, 59, 999);
        const end = today.toISOString();

        const query = {
            query: `query GetWorkersAnalytics($accountTag: String!, $datetimeStart: String!, $datetimeEnd: String!) {
                viewer {
                    accounts(filter: {accountTag: $accountTag}) {
                        workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}) {
                            sum { requests }
                        }
                    }
                }
            }`,
            variables: { accountTag: accountId, datetimeStart: start, datetimeEnd: end }
        };

        const usageRes = await axios.post('https://api.cloudflare.com/client/v4/graphql', query, { headers, timeout: 10000 });
        let requests = 0;
        if (usageRes.data && usageRes.data.data && usageRes.data.data.viewer && usageRes.data.data.viewer.accounts && usageRes.data.data.viewer.accounts.length > 0) {
            const adaptive = usageRes.data.data.viewer.accounts[0].workersInvocationsAdaptive;
            if (adaptive && adaptive.length > 0 && adaptive[0].sum) {
                requests = adaptive[0].sum.requests || 0;
            }
        }
        res.json({ success: true, requests });
    } catch (e) {
        res.json({ success: false, message: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

// API: دریافت آی‌پی‌ها برای فیلد دستی
app.post('/api/get-ips', (req, res) => {
    const { cdns = [], maxIps = 200 } = req.body;

    let ranges = [];
    if (cdns.includes('cloudflare')) ranges.push(...cloudflareRanges.map((cidr) => ({ cidr, provider: 'cloudflare' })));
    if (cdns.includes('akamai')) ranges.push(...AKAMAI_RANGES.map((cidr) => ({ cidr, provider: 'akamai' })));
    if (cdns.includes('fastly')) ranges.push(...fastlyRanges.map((cidr) => ({ cidr, provider: 'fastly' })));
    if (cdns.includes('cloudfront')) ranges.push(...awsRanges.map((cidr) => ({ cidr, provider: 'cloudfront' })));
    if (cdns.includes('google')) ranges.push(...googleRanges.map((cidr) => ({ cidr, provider: 'google' })));
    if (cdns.includes('azure')) ranges.push(...azureRanges.map((cidr) => ({ cidr, provider: 'azure' })));
    if (cdns.includes('gcore')) ranges.push(...gcoreRanges.map((cidr) => ({ cidr, provider: 'gcore' })));

    if (cdns.includes('warp_main')) ranges.push(...warpMainRanges.map((cidr) => ({ cidr, provider: 'warp_main' })));
    if (cdns.includes('warp_alt')) ranges.push(...warpAltRanges.map((cidr) => ({ cidr, provider: 'warp_alt' })));
    if (cdns.includes('warp_ipv6')) ranges.push(...warpIpv6Ranges.map((cidr) => ({ cidr, provider: 'warp_ipv6' })));


    if (cdns.includes('warp_main')) ranges.push(...warpMainRanges.map((cidr) => ({ cidr, provider: 'warp_main' })));
    if (cdns.includes('warp_alt')) ranges.push(...warpAltRanges.map((cidr) => ({ cidr, provider: 'warp_alt' })));
    if (cdns.includes('warp_ipv6')) ranges.push(...warpIpv6Ranges.map((cidr) => ({ cidr, provider: 'warp_ipv6' })));


    const sampled = sampleFromRanges(ranges, maxIps);

    const grouped = {};
    for (const s of sampled) {
        if (!grouped[s.provider]) grouped[s.provider] = [];
        grouped[s.provider].push(s.ip);
    }

    let textList = [];
    for (const [prov, ips] of Object.entries(grouped)) {
        textList.push(`# ${prov}`);
        textList.push(...ips);
        textList.push('');
    }

    res.json({ ipsText: textList.join('\n').trim(), count: sampled.length });
});

// API: چک کردن ISP
app.get('/api/check-isp', async (req, res) => {
    const info = await checkIsp();
    res.json(info);
});

// API: آپدیت همزمانی
app.post('/api/scan/concurrency', (req, res) => {
    const { concurrency } = req.body;
    if (!concurrency || concurrency < 1) return res.status(400).json({ error: 'مقدار همزمانی نامعتبر است' });
    currentScanConcurrencyObj.value = parseInt(concurrency);
    res.json({ success: true, concurrency: currentScanConcurrencyObj.value });
});

// API: شروع اسکن
app.post('/api/scan', async (req, res) => {
    if (scanState.running) {
        console.log("Force stopping previous scan to start a new one.");
        scanState.stopRequested = true;
        scanState.running = false;
    }

    const { resume = false, resumeTestedCount = 0, cdns = ['cloudflare', 'akamai'], concurrency = 50, timeout = 5000, maxIps = 200, ports = [443], customInput = '', baseConfig = '', finalTestCount = 50, pauseOnNetworkDown = true } = req.body;
    scanState.baseConfig = baseConfig;

    let combos = [];
    let totalCombos = 0;
    let ipsCount = 0;

    if (resume && scanState && scanState.combos && scanState.combos.length > 0) {
        totalCombos = scanState.combos.length;
        ipsCount = scanState.ipsCount || 0;
        if (resumeTestedCount > 0 && resumeTestedCount < totalCombos) {
            combos = scanState.combos.slice(resumeTestedCount);
        } else {
            combos = scanState.combos;
        }
    } else {
        let ranges = [];
        if (cdns.includes('cloudflare')) ranges.push(...cloudflareRanges.map((cidr) => ({ cidr, provider: 'cloudflare' })));
        if (cdns.includes('akamai')) ranges.push(...AKAMAI_RANGES.map((cidr) => ({ cidr, provider: 'akamai' })));
        if (cdns.includes('fastly')) ranges.push(...fastlyRanges.map((cidr) => ({ cidr, provider: 'fastly' })));
        if (cdns.includes('cloudfront')) ranges.push(...awsRanges.map((cidr) => ({ cidr, provider: 'cloudfront' })));
        if (cdns.includes('google')) ranges.push(...googleRanges.map((cidr) => ({ cidr, provider: 'google' })));
        if (cdns.includes('azure')) ranges.push(...azureRanges.map((cidr) => ({ cidr, provider: 'azure' })));
        if (cdns.includes('gcore')) ranges.push(...gcoreRanges.map((cidr) => ({ cidr, provider: 'gcore' })));

        if (cdns.includes('warp_main')) ranges.push(...warpMainRanges.map((cidr) => ({ cidr, provider: 'warp_main' })));
        if (cdns.includes('warp_alt')) ranges.push(...warpAltRanges.map((cidr) => ({ cidr, provider: 'warp_alt' })));
        if (cdns.includes('warp_ipv6')) ranges.push(...warpIpv6Ranges.map((cidr) => ({ cidr, provider: 'warp_ipv6' })));



        let customIps = [];
        if (customInput.trim()) {
            const parsed = parseUserInput(customInput);
            ranges.push(...parsed.ranges);
            customIps = parsed.singleIps;
        }

        let safeMax = Math.min(maxIps, 50000000);
        const sampled = sampleFromRanges(ranges, Math.max(0, safeMax - customIps.length));
        const targetsByIp = new Map();
        for (const target of [...customIps, ...sampled]) {
            if (!target || !target.ip) continue;
            if (!targetsByIp.has(target.ip)) targetsByIp.set(target.ip, target);
        }
        const targets = Array.from(targetsByIp.values()).slice(0, maxIps);

        if (!targets.length) return res.status(400).json({ error: 'هیچ IP ای پیدا نشد' });
        ipsCount = targets.length;

        for (const target of targets) {
            for (const p of ports) {
                combos.push({ ip: target.ip, port: p, provider: target.provider || 'generic' });
            }
        }
        totalCombos = combos.length;

        // If resuming but scanState was empty (e.g. app restarted), we must slice the newly generated combos
        if (resume && resumeTestedCount > 0 && resumeTestedCount < totalCombos) {
            combos = combos.slice(resumeTestedCount);
        }
    }

    const myScanId = ++currentScanId;
    scanState = {
        id: myScanId,
        running: true,
        stopRequested: false,
        results: resume ? scanState.results : [],
        total: totalCombos,
        tested: resume ? resumeTestedCount : 0,
        alive: resume ? (req.body.resumeAliveCount || 0) : 0,
        dead: resume ? (req.body.resumeDeadCount || 0) : 0,
        combos: resume ? scanState.combos : combos,
        ipsCount: ipsCount,
        baseConfig: baseConfig
    };
    res.json({ message: resume ? 'اسکن ادامه یافت' : 'اسکن شروع شد', total: totalCombos, ips: ipsCount, ports: ports.length });

    broadcast('started', { total: totalCombos });


    currentScanConcurrencyObj.value = parseInt(concurrency) || 50;
    runScanPool(combos, currentScanConcurrencyObj, timeout, (result, i) => {
        if (scanState.id !== myScanId) return;
        // «توقف هنگام قطعی اینترنت» switched off (Settings › اسکن): the probe that met a dead
        // adapter counts as one dead IP and the scan carries on instead of pausing.
        if (result.fatal && pauseOnNetworkDown === false) {
            const c = combos[i] || {};
            const no = () => ({ connected: false, latency: 0 });
            result = {
                ip: c.ip, port: c.port, provider: c.provider || 'generic', alive: false,
                tcp: no(),
                http: { connected: false, latency: 0, speed: 0, status: 0, probe: '', error: 'NETWORK_DOWN' },
                youtube: no(), xnxx: no(), telegram: no(), instagram: no()
            };
        }
        if (result.fatal) {
            scanState.stopRequested = true;
            // flush any pending before error
            if (batchFlushTimer) { clearTimeout(batchFlushTimer); batchFlushTimer = null; }
            flushResultBatch();
            broadcast('error', { message: 'NETWORK_DOWN' });
            return;
        }
        scanState.results.push(result);
        scanState.tested++;
        if (result.alive) scanState.alive++; else scanState.dead++;
        // ✅ بجای ارسال فوری، در بافر قرار می‌دهیم
        resultBatch.push(result);
        scheduleBatchFlush();
    }, () => (scanState.id !== myScanId || scanState.stopRequested)).then(async () => {
        if (scanState.id !== myScanId) return;

        // Flush pending stage 1 results
        if (batchFlushTimer) { clearTimeout(batchFlushTimer); batchFlushTimer = null; }
        flushResultBatch();

        console.log('stopReq:', scanState.stopRequested, 'alive:', scanState.alive, 'baseConfig:', !!scanState.baseConfig, 'type:', typeof scanState.baseConfig);
        if (scanState.stopRequested || scanState.alive === 0 || !scanState.baseConfig) {
            scanState.running = false;
            broadcast('finished', { total: scanState.total, alive: scanState.alive, dead: scanState.dead });
            console.log(`✅ اسکن تمام شد: ${scanState.alive} IP سالم از ${scanState.total}`);
            return;
        }

        // STAGE 2: Sort and Slice
        broadcast('stage2_start', { message: 'در حال انتخاب ۵۰ آی‌پی برتر...' });
        broadcast('system_log', { message: `Stage 2: Sorting ${scanState.results.length} results. Alive: ${scanState.alive}` });

        const aliveResults = scanState.results.filter(r => r.alive && r.tcp && typeof r.tcp.latency === 'number').sort((a, b) => a.tcp.latency - b.tcp.latency);
        broadcast('system_log', { message: `Stage 2: Found ${aliveResults.length} IPs with valid tcp latency.` });

        const limitCount = parseInt(finalTestCount) || 50;
        const topN = aliveResults.slice(0, limitCount);

        if (topN.length === 0) {
            broadcast('system_log', { message: `Stage 2: topN is empty! Aborting Stage 3.` });
            console.log('[DEBUG] topN is empty! scanState.results has', scanState.results.length, 'total items, and', scanState.alive, 'alive.');
            scanState.running = false;
            broadcast('finished', { total: scanState.total, alive: scanState.alive, dead: scanState.dead });
            return;
        }

        // STAGE 3: Real Delay
        broadcast('system_log', { message: `Stage 3: Starting with baseConfig: ${scanState.baseConfig.substring(0, 20)}...` });
        broadcast('stage3_start', { message: `تست قطعی روی ${topN.length} آی‌پی برتر...`, total: topN.length });

        try {
            const axios = require('axios');
            const { SocksProxyAgent } = require('socks-proxy-agent');

            let successfulIpsCount = 0;
            const BATCH_SIZE = 10;

            for (let i = 0; i < topN.length; i += BATCH_SIZE) {
                if (scanState.stopRequested) break;
                if (successfulIpsCount >= 10) {
                    broadcast('system_log', { message: '✅ 10 آی‌پی موفق یافت شد. توقف اسکن.' });
                    console.log('✅ 10 آی‌پی موفق یافت شد. توقف اسکن.');
                    break;
                }

                const chunk = topN.slice(i, i + BATCH_SIZE);
                broadcast('system_log', { message: `Stage 3: Testing chunk ${Math.floor(i / BATCH_SIZE) + 1} with ${chunk.length} IPs...` });
                broadcast('stage3_start', { message: `بررسی دسته‌ی ${Math.floor(i / BATCH_SIZE) + 1} (شامل ${chunk.length} آی‌پی)...` });

                let batchBase = 31000;
                try {
                    // The base port comes from the engine now, so the two never disagree —
                    // the scanner used to hard-code 20000 in both places.
                    batchBase = (await startBatchXray(scanState.baseConfig, chunk)).basePort;
                    broadcast('system_log', { message: `Stage 3: startBatchXray completed. Waiting for axios...` });
                } catch (xErr) {
                    broadcast('system_log', { message: `Stage 3: startBatchXray THREW ERROR: ${xErr.message}` });
                    throw xErr;
                }

                const promises = chunk.map(async (ipObj, idx) => {
                    const port = batchBase + idx;
                    // Pooled agent + two shots + minimum — the same real-ping method the
                    // node delay test uses. A fresh agent per request measured the whole
                    // TCP/SOCKS/VLESS/TLS setup and reported it as "delay", which made
                    // every clean IP look several times slower than it is.
                    const agent = new SocksTlsAgent(port);

                    let responseTime = -1;
                    const startTestTime = Date.now();

                    for (let attempt = 0; attempt < 2 && responseTime <= 0; attempt++) {
                        if (scanState.stopRequested) break;
                        if (Date.now() - startTestTime > 10000) break;

                        const shots = [];
                        for (let k = 0; k < 2; k++) {
                            if (scanState.stopRequested) break;
                            if (Date.now() - startTestTime > 10000) break;
                            try {
                                const startReq = Date.now();
                                const res = await axios.get('https://clients3.google.com/generate_204', {
                                    httpAgent: agent,
                                    httpsAgent: agent,
                                    timeout: 3000,
                                    validateStatus: () => true
                                });
                                if (res.status === 204) shots.push(Date.now() - startReq);
                            } catch (e) { console.error('AXIOS ERROR:', e.message); }
                            if (k === 0) await new Promise(r => setTimeout(r, 100));
                        }
                        if (shots.length) responseTime = Math.min(...shots);

                        if (responseTime <= 0 && attempt === 0) await new Promise(r => setTimeout(r, 500));
                    }

                    try { agent.destroy(); } catch (e) { }

                    ipObj.realDelay = responseTime;
                    broadcast('stage3_progress', { ip: ipObj.ip, realDelay: responseTime });
                    return responseTime > 0;
                });

                const results = await Promise.all(promises);
                const successInBatch = results.filter(r => r).length;
                successfulIpsCount += successInBatch;
                broadcast('system_log', { message: `Stage 3: Chunk completed. Successes in chunk: ${successInBatch}. Total: ${successfulIpsCount}` });

                // stopBatchXray, not stopXray: the scan's engine is its own process now.
                // stopXray() here used to force-kill every xray.exe, which killed the node the
                // user was connected to, tore their full tunnel down with it, and cleared the
                // Windows proxy — while the V2Ray panel went on saying «متصل است».
                await stopBatchXray();

                // UX Delay to prevent instant 100% flash if all IPs fail instantly
                await new Promise(r => setTimeout(r, 1000));
            }

        } catch (e) {
            broadcast('system_log', { message: `Stage 3 ERROR: ${e.message}` });
            console.error("Stage 3 error:", e);
        } finally {
            await require('./xray-manager').stopBatchXray();
            scanState.running = false;
            broadcast('finished', { total: scanState.total, alive: scanState.alive, dead: scanState.dead });
            console.log(`✅ اسکن و تست قطعی تمام شد`);
        }
    }).catch(err => {
        console.error("Scan pool error:", err);
    });
});

/**
 * Find a Zeus panel this account already has, so «استقرار» becomes an in-place update.
 *
 * Nothing local is trusted here: the user may have deleted the account from the app, or
 * be on another machine. The only durable record of a Zeus deployment is on Cloudflare
 * itself, so the signature is read off the worker: a Zeus script always carries a D1
 * binding named `DB`, and its source contains the panel's own path marker `PANEL_ZEUS`.
 * The binding alone is not enough — any other worker could bind a D1 as `DB` — hence the
 * content check, which only runs for the handful of scripts that pass the cheap filter.
 *
 * Worker names are randomised at deploy time, so name matching is impossible by design.
 */
async function findExistingZeusDeployment(headers, accountId) {
    let scripts = [];
    try {
        const listRes = await axios.get(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`,
            { headers, timeout: 20000 }
        );
        scripts = Array.isArray(listRes.data?.result) ? listRes.data.result : [];
    } catch (e) {
        console.error('[ZEUS] Could not list workers:', e.response?.data || e.message);
        return null;
    }

    for (const script of scripts) {
        const name = script?.id;
        if (!name) continue;
        let dbBinding = null;
        try {
            const settingsRes = await axios.get(
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/settings`,
                { headers, timeout: 20000 }
            );
            const bindings = settingsRes.data?.result?.bindings || [];
            dbBinding = bindings.find(b => b?.type === 'd1' && b?.name === 'DB');
        } catch (e) { continue; }
        if (!dbBinding) continue;

        // Confirm it is really Zeus before we overwrite it.
        try {
            const contentRes = await axios.get(
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}/content`,
                { headers, timeout: 30000, transformResponse: [(d) => d] }
            );
            const body = typeof contentRes.data === 'string' ? contentRes.data : '';
            if (!body.includes('PANEL_ZEUS')) continue;
        } catch (e) {
            console.error(`[ZEUS] Could not read content of ${name}:`, e.message);
            continue;
        }

        const dbUuid = dbBinding.id || dbBinding.database_id || '';
        console.log(`[ZEUS] Existing deployment found: worker=${name} d1=${dbUuid || 'unknown'}`);
        return { scriptName: name, dbUuid };
    }
    return null;
}

/** The database outlives the worker: reuse it so a re-deploy never orphans the users. */
async function findExistingZeusDatabase(headers, accountId) {
    try {
        const listRes = await axios.get(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`,
            { headers, params: { per_page: 100 }, timeout: 20000 }
        );
        const dbs = Array.isArray(listRes.data?.result) ? listRes.data.result : [];
        const found = dbs.find(d => String(d?.name || '').startsWith('zeus-db'));
        if (found) console.log('[ZEUS] Existing D1 database found:', found.name);
        return found?.uuid || '';
    } catch (e) {
        console.error('[ZEUS] Could not list D1 databases:', e.response?.data || e.message);
        return '';
    }
}

// API: Cloudflare Deploy Worker
app.post('/api/cloudflare/deploy', async (req, res) => {
    const { email, token, panelType = 'BPB' } = req.body;
    try {
        const _token = token.replace(/[^a-zA-Z0-9_-]/g, '').trim();
        const _email = email.trim();

        // BPB v5.1.1 authenticates the panel by Cloudflare email: the login handler
        // compares the submitted username against EMBEDED_SETTINGS.accEmail and 401s on
        // any mismatch. Deploying with an empty email produces a panel that NOBODY can
        // log into — including this app, which then cannot sync settings. Refuse up front
        // with a fixable message instead of handing back a dead panel.
        if (panelType === 'BPB' && !_email) {
            return res.status(400).json({
                error: 'برای پنل BPB باید ایمیل حساب کلودفلر را هم وارد کنید — ورود به پنل با همان ایمیل انجام می‌شود و بدون آن پنل غیرقابل استفاده می‌شود.'
            });
        }

        const isCfat = _token.startsWith('cfat_') || _email === '';
        const headers = { 'Content-Type': 'application/json' };
        if (isCfat) {
            headers['Authorization'] = `Bearer ${_token}`;
        } else {
            headers['X-Auth-Email'] = _email;
            headers['X-Auth-Key'] = _token;
        }

        // 1. Get Accounts
        const accRes = await axios.get('https://api.cloudflare.com/client/v4/accounts', { headers });
        if (!accRes.data.success || accRes.data.result.length === 0) {
            return res.status(400).json({ error: 'اکانتی در کلودفلر یافت نشد.' });
        }
        const accountId = accRes.data.result[0].id;

        // 2. Subdomain check/create/sanitize
        let subdomain = '';
        const subCheckRes = await axios.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers });
        if (subCheckRes.data.success && subCheckRes.data.result) {
            subdomain = subCheckRes.data.result.subdomain;
        }
        // ⚠️ Anti-DPI: اگر ساب‌دامین موجود شامل کلمات حساس باشد، عوضش میکنیم
        if (subdomain && containsBlacklistedKeyword(subdomain)) {
            console.log(`[Anti-DPI] ⚠️ ساب‌دامین آلوده تشخیص داده شد: ${subdomain} — در حال تعویض...`);
            const newSub = generateSafeSubdomain();
            try {
                await axios.put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { subdomain: newSub }, { headers });
                subdomain = newSub;
                console.log(`[Anti-DPI] ✅ ساب‌دامین جدید: ${subdomain}`);
            } catch (renameErr) {
                console.error(`[Anti-DPI] ❌ خطا در تعویض ساب‌دامین:`, renameErr.response?.data || renameErr.message);
            }
        }
        if (!subdomain) {
            const randomSub = generateSafeSubdomain();
            await axios.put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { subdomain: randomSub }, { headers });
            subdomain = randomSub;
        }

        // 3. Generate Secrets
        const crypto = require('crypto');
        const workerUuid = crypto.randomUUID();
        const trPass = crypto.randomUUID().replace(/-/g, '');
        const subPath = crypto.randomUUID().substring(0, 8);

        const scriptName = generateSafeWorkerName();

        if (panelType === 'ZEUS') {
            console.log('[ZEUS] Deploying Zeus Panel...');

            // Deploy is an UPSERT, not a create.
            //
            // Creating a second worker (and a second D1) on every press left the account
            // littered with dead panels and — worse — stranded the users, since they live
            // in the old database. So look on Cloudflare first: if a Zeus panel is there,
            // overwrite that script and keep its database. The lookup deliberately ignores
            // anything stored locally, so deleting the account inside the app and adding
            // it again still lands on the same panel.
            const existingZeus = await findExistingZeusDeployment(headers, accountId);
            const zeusScriptName = existingZeus?.scriptName || scriptName;
            const isZeusUpdate = !!existingZeus;

            let dbUuid = existingZeus?.dbUuid || '';
            // The worker may be gone while its database survived (or the binding did not
            // report an id) — reuse that before making a new one, or the users vanish.
            if (!dbUuid) dbUuid = await findExistingZeusDatabase(headers, accountId);

            if (!dbUuid) {
                const dbName = `zeus-db-${crypto.randomUUID().substring(0, 8)}`;
                try {
                    const dbRes = await axios.post(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database`, { name: dbName }, { headers });
                    if (dbRes.data.success) dbUuid = dbRes.data.result.uuid;
                } catch (e) {
                    console.error('[ZEUS] D1 Creation Error:', e.response?.data || e.message);
                    if (e.response?.data?.errors?.[0]?.message?.toLowerCase().includes('terms of service')) {
                        throw new Error('خطا: ابتدا باید در داشبورد کلودفلر وارد بخش D1 شوید و قوانین (Terms of Service) را تایید کنید.');
                    }
                    dbUuid = await findExistingZeusDatabase(headers, accountId);
                }
            }
            if (!dbUuid) throw new Error('Failed to create D1 database for Zeus.');
            console.log(`[ZEUS] ${isZeusUpdate ? 'Updating' : 'Creating'} panel — worker=${zeusScriptName}, d1=${dbUuid}`);

            // 2. Upload Zeus Worker
            const workerScript = fs.readFileSync(path.join(__dirname, 'public', 'zeus.js'), 'utf8');
            // Zeus 1.11+ reads three OPTIONAL variables beyond the D1 binding. Without
            // them the panel still runs, but "update panel" and the request-usage figures
            // are dead: `getUsage` returns zeros unless CF_API_TOKEN and CF_ACCOUNT_ID are
            // present, and self-update falls back to guessing the script name from the
            // hostname. We already hold all three, so pass them and the features work.
            const metadata = {
                main_module: "zeus.js",
                compatibility_date: "2025-04-01",
                bindings: [
                    { type: "d1", name: "DB", id: dbUuid },
                    { type: "secret_text", name: "CF_API_TOKEN", text: _token },
                    { type: "secret_text", name: "CF_ACCOUNT_ID", text: accountId },
                    { type: "secret_text", name: "WORKER_NAME", text: zeusScriptName }
                ]
            };

            const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
            let body = `--${boundary}\r\n`;
            body += `Content-Disposition: form-data; name="metadata"\r\n`;
            body += `Content-Type: application/json\r\n\r\n`;
            body += `${JSON.stringify(metadata)}\r\n`;
            body += `--${boundary}\r\n`;
            body += `Content-Disposition: form-data; name="zeus.js"; filename="zeus.js"\r\n`;
            body += `Content-Type: application/javascript+module\r\n\r\n`;
            body += workerScript + `\r\n`;
            body += `--${boundary}--\r\n`;

            const scriptHeaders = { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` };
            await axios.put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${zeusScriptName}`, body, { headers: scriptHeaders });
            console.log(`[ZEUS] Worker ${isZeusUpdate ? 'Updated' : 'Uploaded'}`);

            // 3. Enable Subdomain
            await axios.post(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${zeusScriptName}/subdomain`, { enabled: true }, { headers });
            console.log('[ZEUS] Subdomain Enabled');

            // 4. Set Initial Admin Password via API
            const workerUrl = `https://${zeusScriptName}.${subdomain}.workers.dev`;

            // Background initialization
            setTimeout(async () => {
                try {
                    // Through gtFetch: this is the worker's own workers.dev host, which is
                    // filtered in Iran. Deploying succeeded (that is api.cloudflare.com),
                    // so the panel existed but never got its initial password — leaving a
                    // panel the user could not log into and no error anywhere.
                    const r = await gtFetch(`${workerUrl}/api/setup-password`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ password: 'Admin123!' }),
                        timeoutMs: 20000
                    });
                    console.log(`[ZEUS] Initial password set (status ${r.status}${r.viaFallback ? ', via fallback' : ''})`);
                } catch (e) {
                    console.error("[ZEUS] Auto-Setup Password Error:", e.message);
                }
            }, 5000); // wait 5 seconds for worker to be live

            return res.json({ success: true, url: workerUrl, workerName: zeusScriptName, panelType: 'ZEUS', reused: isZeusUpdate });

        } else {
            // 4. KV Namespace (BPB Logic)
            // Cloudflare paginates this endpoint (20 items by default). Look for an
            // existing namespace before creating it, then retry the lookup if a
            // concurrent/previous deployment has already created the same title.
            const namespaceTitle = 'mlmvpn';
            const findKvNamespace = async () => {
                const perPage = 1000;
                let page = 1;

                while (true) {
                    const listRes = await axios.get(
                        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
                        { headers, params: { page, per_page: perPage, order: 'title', direction: 'asc' } }
                    );
                    const namespaces = Array.isArray(listRes.data?.result) ? listRes.data.result : [];
                    const found = namespaces.find(namespace =>
                        String(namespace.title || '').trim().toLowerCase() === namespaceTitle
                    );
                    if (found) return found;

                    const resultInfo = listRes.data?.result_info;
                    const totalCount = Number(resultInfo?.total_count);
                    if (!namespaces.length || !Number.isFinite(totalCount) || page * perPage >= totalCount) {
                        return null;
                    }
                    page += 1;
                }
            };

            let namespace = await findKvNamespace();
            if (!namespace) {
                try {
                    const kvRes = await axios.post(
                        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
                        { title: namespaceTitle },
                        { headers }
                    );
                    namespace = kvRes.data?.success ? kvRes.data.result : null;
                } catch (createError) {
                    // A duplicate-title response is expected if another attempt
                    // created the namespace between our lookup and POST.
                    namespace = await findKvNamespace();
                    if (!namespace) throw createError;
                }
            }

            const namespaceId = namespace?.id;
            if (!namespaceId) throw new Error(`Failed to create or find KV namespace ${namespaceTitle}`);

            // 5. Build and upload the BPB v5 Worker. v5 reads its install values
            // from EMBEDED_SETTINGS and deliberately rejects the legacy UUID and
            // TR_PASS secret bindings.
            const workerHost = `${scriptName}.${subdomain}.workers.dev`;
            const embeddedSettings = {
                accID: accountId,
                accEmail: _email,
                apiToken: _token,
                vlUUID: workerUuid,
                trPass,
                securePath: subPath,
                proxyIpMode: 'proxyip',
                proxyIPs: ['bpb.yousef.isegaro.com'],
                prefixes: [],
                mainDomain: workerHost,
                fallback: '',
                dohUrl: 'https://cloudflare-dns.com/dns-query'
            };
            const workerTemplate = fs.readFileSync(path.join(__dirname, 'public', 'worker.js'), 'utf8');
            const workerScript = `Object.assign(globalThis, ${JSON.stringify({ EMBEDED_SETTINGS: embeddedSettings })});\n${workerTemplate}`;
            // Mirror what the panel uses when it redeploys ITSELF (src/api/workers.ts):
            // today's date + nodejs_compat + keep_bindings. The panel rewrites its own
            // script whenever main settings change, so if our initial deploy pinned an
            // older compatibility date the worker would silently change runtime behaviour
            // the first time the user saved a setting.
            const metadata = {
                main_module: "worker.js",
                keep_bindings: ["kv_namespace"],
                compatibility_date: new Date().toISOString().split('T')[0],
                compatibility_flags: ["nodejs_compat"],
                bindings: [
                    { type: "kv_namespace", name: "kv", namespace_id: namespaceId }
                ]
            };

            const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
            let body = `--${boundary}\r\n`;
            body += `Content-Disposition: form-data; name="metadata"\r\n`;
            body += `Content-Type: application/json\r\n\r\n`;
            body += `${JSON.stringify(metadata)}\r\n`;
            body += `--${boundary}\r\n`;
            body += `Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n`;
            body += `Content-Type: application/javascript+module\r\n\r\n`;
            body += workerScript + `\r\n`;
            body += `--${boundary}--\r\n`;

            const scriptHeaders = { ...headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` };
            await axios.put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`, body, { headers: scriptHeaders });

            // 6. Enable Subdomain. The v5 Worker initializes its complete default
            // KV schema itself on its first request.
            await axios.post(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, { enabled: true }, { headers });

            // 7. Set Panel Password
            await axios.put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/pwd`, "Admin123!", { headers: { ...headers, 'Content-Type': 'text/plain' } });

            const workerUrl = `https://${scriptName}.${subdomain}.workers.dev`;
            res.json({ success: true, url: workerUrl, uuid: workerUuid, trPass, subPath, workerName: scriptName });
        }
    } catch (e) {
        console.error(e.response?.data || e.message);
        res.status(500).json({ error: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

// API: بررسی وضعیت ساب‌دامین

/**
 * Fetch a Zeus user's subscription server-side, so it goes through gtFetch.
 *
 * The users modal used to call `${workerUrl}/sub/<user>` straight from the renderer with
 * plain `fetch()`. That is the panel's own workers.dev host — filtered — so on the user's
 * network the request simply threw, «انتقال به پنل ترکیب» reported an error, and
 * `cf_base_configs` stayed empty: the combination centre kept saying no base nodes had
 * ever been received, while the panel itself listed users fine (that path already went
 * through the local server).
 *
 * The subscription is unauthenticated base64 text, not JSON, so it cannot ride on
 * /zeus/proxy — that one parses JSON and now rejects anything else. Hence a raw endpoint.
 */
app.post('/api/cloudflare/zeus/sub', async (req, res) => {
    const { workerUrl, username, format = 'txt' } = req.body;
    if (!workerUrl || !username) return res.status(400).json({ error: 'workerUrl and username required' });
    try {
        const suffix = format === 'json' ? 'sub/json' : 'sub';
        const target = `${workerUrl}/${suffix}/${encodeURIComponent(username)}`;
        const r = await gtFetch(target, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            timeoutMs: 25000
        });
        const text = await r.text();
        if (r.status !== 200) {
            return res.status(r.status).json({
                error: `پنل زئوس برای ساب کاربر «${username}» کد ${r.status} برگرداند${r.viaFallback ? ' (از مسیر جایگزین)' : ''}.`
            });
        }
        res.json({ success: true, content: text, viaFallback: !!r.viaFallback });
    } catch (e) {
        console.error('[ZEUS Sub Error]:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// API: Zeus Panel Proxy (Native UI)
app.post('/api/cloudflare/zeus/proxy', async (req, res) => {
    const { workerUrl, password = 'Admin123!', endpoint, method = 'GET', body = null } = req.body;
    if (!workerUrl || !endpoint) return res.status(400).json({ error: 'workerUrl and endpoint required' });

    try {
        // The session cookie is derived, not granted.
        //
        // Zeus stores `panel_session = sha256hex(password)` and authorises a request by
        // comparing that cookie against the stored password hash — there is no server-side
        // session table and no nonce. So the cookie can be computed here, which removes
        // the login round-trip entirely.
        //
        // That matters for more than speed: workers.dev is filtered in Iran, so these
        // calls have to go through the edge-proxy fallback, and that proxy does not pass
        // `Set-Cookie` back. Asking the panel for a cookie we can never read would make
        // Zeus management impossible without a second VPN; computing it ourselves makes
        // the fallback path work end to end.
        const sessionHash = crypto.createHash('sha256').update(String(password)).digest('hex');
        const cookieHeader = `panel_session=${sessionHash}`;

        const call = async (target, opts = {}) => {
            const r = await gtFetch(target, { timeoutMs: 25000, ...opts });
            const text = await r.text();
            let parsed = null;
            try { parsed = text ? JSON.parse(text) : null; } catch (e) { parsed = { raw: text }; }
            return { status: r.status, data: parsed, viaFallback: !!r.viaFallback };
        };

        const doRequest = () => call(`${workerUrl}${endpoint}`, {
            method,
            headers: {
                Cookie: cookieHeader,
                ...(body && (method === 'POST' || method === 'PUT') ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body && (method === 'POST' || method === 'PUT') ? { body: JSON.stringify(body) } : {})
        });

        let targetRes = await doRequest();

        // 401 means the derived cookie did not match the stored hash. On a freshly
        // deployed panel that is because no password was ever stored (the post-deploy
        // setup call can fail while the domain is filtered), so try to set it once, then
        // retry. A genuinely changed password still ends up reported as an auth failure.
        if (targetRes.status === 401) {
            const setupRes = await call(`${workerUrl}/api/setup-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            if (setupRes.status === 200) {
                targetRes = await doRequest();
            }
            if (targetRes.status === 401) {
                return res.status(401).json({ error: 'احراز هویت زئوس ناموفق بود. شاید پسورد پنل تغییر کرده است.' });
            }
        }

        // Anything that is not JSON is not an answer from the panel's API.
        //
        // Zeus serves a fake-nginx HTML page for every unknown route, and the edge proxy
        // has its own error pages, so a "successful" 200 can easily carry HTML. That used
        // to reach the UI as `{raw: "<html>…"}`: `data.users` was undefined, so the users
        // modal quietly showed "no users", and a failure showed the useless "Request
        // Failed". Turn it into a described error instead — including which path carried
        // the request, because direct and fallback fail for different reasons.
        if (targetRes.data && typeof targetRes.data === 'object' && 'raw' in targetRes.data) {
            const snippet = String(targetRes.data.raw || '').replace(/s+/g, ' ').slice(0, 200);
            const via = targetRes.viaFallback ? 'مسیر جایگزین (پروکسی لبه)' : 'مسیر مستقیم';
            console.error(`[ZEUS Proxy] Non-JSON reply (status ${targetRes.status}, ${via}) from ${endpoint}: ${snippet}`);
            return res.status(502).json({
                error: `پاسخ پنل زئوس معتبر نبود (کد ${targetRes.status}، ${via}). یعنی درخواست به API پنل نرسیده است. پاسخ دریافتی: ${snippet || '(خالی)'}`
            });
        }

        if (targetRes.status >= 400 && !(targetRes.data && targetRes.data.error)) {
            console.error(`[ZEUS Proxy] HTTP ${targetRes.status} from ${endpoint}`);
            return res.status(targetRes.status).json({
                error: `پنل زئوس کد ${targetRes.status} برگرداند${targetRes.viaFallback ? ' (از مسیر جایگزین)' : ''}.`
            });
        }

        res.status(targetRes.status).json(targetRes.data ?? {});
    } catch (e) {
        console.error('[ZEUS Proxy Error]:', e.message);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/cloudflare/check-subdomain', async (req, res) => {
    const { email, token, panelType = 'BPB' } = req.body;
    if (!token) return res.json({ success: false, message: 'No token' });
    try {
        const _token = token.trim();
        const _email = (email || '').trim();
        const isCfat = _token.startsWith('cfat_') || _token.length === 40 || _email === '';
        const headers = { 'Content-Type': 'application/json' };
        if (isCfat) headers['Authorization'] = `Bearer ${_token}`;
        else { headers['X-Auth-Email'] = _email; headers['X-Auth-Key'] = _token; }

        const accRes = await axios.get('https://api.cloudflare.com/client/v4/accounts', { headers, timeout: 10000 });
        if (!accRes.data.success || accRes.data.result.length === 0) return res.json({ success: false, message: 'اکانتی یافت نشد' });
        const accountId = accRes.data.result[0].id;

        const subRes = await axios.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers, timeout: 10000 });
        const currentSub = subRes.data?.result?.subdomain || '';

        res.json({
            success: true,
            currentSubdomain: currentSub,
            isContaminated: currentSub ? containsBlacklistedKeyword(currentSub) : false
        });
    } catch (e) {
        res.status(500).json({ success: false, message: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

// API: تغییر ساب‌دامین
app.post('/api/cloudflare/set-subdomain', async (req, res) => {
    const { email, token, newSubdomain } = req.body;
    if (!token || !newSubdomain) return res.json({ success: false, message: 'اطلاعات ناقص است' });
    try {
        const _token = token.trim();
        const _email = (email || '').trim();
        const isCfat = _token.startsWith('cfat_') || _token.length === 40 || _email === '';
        const headers = { 'Content-Type': 'application/json' };
        if (isCfat) headers['Authorization'] = `Bearer ${_token}`;
        else { headers['X-Auth-Email'] = _email; headers['X-Auth-Key'] = _token; }

        const accRes = await axios.get('https://api.cloudflare.com/client/v4/accounts', { headers, timeout: 10000 });
        if (!accRes.data.success || accRes.data.result.length === 0) return res.json({ success: false, message: 'اکانتی یافت نشد' });
        const accountId = accRes.data.result[0].id;

        let apiError = null;
        try {
            await axios.put(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { subdomain: newSubdomain }, { headers, timeout: 10000 });
            return res.json({ success: true, message: 'ساب‌دامین با موفقیت تغییر کرد (PUT)' });
        } catch (e) { apiError = e; }

        if (apiError && apiError.response?.data?.errors?.[0]?.code === 10007) {
            try {
                await axios.post(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { subdomain: newSubdomain }, { headers, timeout: 10000 });
                return res.json({ success: true, message: 'ساب‌دامین با موفقیت تغییر کرد (POST)' });
            } catch (e) { apiError = e; }
        }

        if (apiError && apiError.response?.data?.errors?.[0]?.code === 10007) {
            try {
                await axios.patch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { subdomain: newSubdomain }, { headers, timeout: 10000 });
                return res.json({ success: true, message: 'ساب‌دامین با موفقیت تغییر کرد (PATCH)' });
            } catch (e) { apiError = e; }
        }

        const errorMsg = apiError.response?.data?.errors?.[0]?.message || apiError.message;
        const errCode = apiError.response?.data?.errors?.[0]?.code;

        // 10007: Account already has an associated subdomain
        if (errorMsg.includes('Account already has an associated subdomain') || errCode === 10007) {
            return res.json({
                success: false,
                requiresManualChange: true,
                message: 'طبق قوانین کلودفلر، تغییر ساب‌دامین از طریق برنامه مسدود است. لطفاً از طریق پنل اقدام کنید.'
            });
        }
        res.status(500).json({ success: false, message: errorMsg });
    } catch (e) {
        res.status(500).json({ success: false, message: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

// API: لیست ورکرهای اکانت
const crypto = require('crypto');
app.post('/api/cloudflare/deploy-edge', async (req, res) => {
    const { email, token, workerName, subdomain, proxyIp } = req.body;
    try {
        const accountIdRes = await axios.get('https://api.cloudflare.com/client/v4/accounts', {
            headers: { 'X-Auth-Email': email, 'X-Auth-Key': token, 'Content-Type': 'application/json' }
        });
        if (!accountIdRes.data.success || accountIdRes.data.result.length === 0) {
            return res.json({ success: false, error: 'Account not found' });
        }
        const accountId = accountIdRes.data.result[0].id;

        const uuid = crypto.randomUUID();
        const password = crypto.randomBytes(8).toString('hex');

        // Create KV Namespace for Edge
        let namespaceId = '';
        const headers = { 'X-Auth-Email': email, 'X-Auth-Key': token, 'Content-Type': 'application/json' };
        try {
            const kvRes = await axios.post(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { title: "edge_db" }, { headers });
            if (kvRes.data.success) namespaceId = kvRes.data.result.id;
        } catch (e) {
            if (e.response?.data?.errors?.[0]?.code === 10014) {
                const listRes = await axios.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`, { headers });
                const found = listRes.data.result.find(k => k.title.includes('edge_db'));
                if (found) namespaceId = found.id;
            } else {
                throw e;
            }
        }
        if (!namespaceId) throw new Error('Failed to create or find KV namespace edge_db');

        let workerJs = fs.readFileSync(path.join(__dirname, 'public', 'edgeworker.js'), 'utf8');

        const metadata = {
            main_module: "worker.js",
            // Must track the compatibility_date in the upstream project's wrangler.toml
            // (edgetunnel). The worker code is written against that runtime; deploying
            // 2026-08 code onto the old 2024-03-03 runtime is asking for behaviour the
            // script does not expect, and a worker that throws answers every request with
            // Cloudflare error 1101 — including a plain GET, which is exactly how a dead
            // worker presents itself.
            compatibility_date: "2025-11-04",
            bindings: [
                { type: "kv_namespace", name: "KV", namespace_id: namespaceId },
                { type: "secret_text", name: "UUID", text: uuid },
                { type: "secret_text", name: "PASSWORD", text: password },
                { type: "secret_text", name: "PROXYIP", text: proxyIp || '' }
            ]
        };

        const boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW';
        let body = `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="metadata"\r\n`;
        body += `Content-Type: application/json\r\n\r\n`;
        body += `${JSON.stringify(metadata)}\r\n`;
        body += `--${boundary}\r\n`;
        body += `Content-Disposition: form-data; name="worker.js"; filename="worker.js"\r\n`;
        body += `Content-Type: application/javascript+module\r\n\r\n`;
        body += workerJs + `\r\n`;
        body += `--${boundary}--\r\n`;

        const scriptHeaders = { 'X-Auth-Email': email, 'X-Auth-Key': token, 'Content-Type': `multipart/form-data; boundary=${boundary}` };
        const putRes = await axios.put(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`,
            body,
            { headers: scriptHeaders }
        );

        if (!putRes.data.success) {
            return res.json({ success: false, error: 'Upload failed', details: putRes.data.errors });
        }

        const subdomainUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}/subdomain`;
        await axios.post(subdomainUrl, { enabled: true }, {
            headers: { 'X-Auth-Email': email, 'X-Auth-Key': token, 'Content-Type': 'application/json' },
            validateStatus: () => true
        });

        res.json({ success: true, url: `https://${workerName}.${subdomain}.workers.dev`, uuid, password });
    } catch (e) {
        console.error(e.response ? e.response.data : e.message);
        res.json({ success: false, error: e.response && e.response.data && e.response.data.errors ? e.response.data.errors[0].message : e.message });
    }
});

app.post('/api/cloudflare/list-workers', async (req, res) => {
    const { email, token, panelType = 'BPB' } = req.body;
    if (!token) return res.json({ success: false, message: 'No token' });
    try {
        const _token = token.trim();
        const _email = (email || '').trim();
        const isCfat = _token.startsWith('cfat_') || _token.length === 40 || _email === '';
        const headers = { 'Content-Type': 'application/json' };
        if (isCfat) headers['Authorization'] = `Bearer ${_token}`;
        else { headers['X-Auth-Email'] = _email; headers['X-Auth-Key'] = _token; }

        const accRes = await axios.get('https://api.cloudflare.com/client/v4/accounts', { headers, timeout: 10000 });
        if (!accRes.data.success || accRes.data.result.length === 0) return res.json({ success: false, message: 'اکانتی یافت نشد' });
        const accountId = accRes.data.result[0].id;

        let subdomain = '';
        try {
            const subRes = await axios.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers, timeout: 5000 });
            subdomain = subRes.data?.result?.name || subRes.data?.result?.subdomain || '';
        } catch (e) {
            console.error('Subdomain fetch error:', e.response?.data || e.message);
        }

        const workersRes = await axios.get(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts`, { headers, timeout: 10000 });
        const workers = workersRes.data?.result || [];

        let workerStats = {};
        try {
            // Last 24 hours exactly
            const now = new Date();
            const end = now.toISOString();
            const start = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

            const graphqlQuery = {
                query: `query GetWorkersAnalytics($accountTag: String!, $datetimeStart: String!, $datetimeEnd: String!) {
                    viewer {
                        accounts(filter: {accountTag: $accountTag}) {
                            workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $datetimeStart, datetime_leq: $datetimeEnd}) {
                                sum { requests, errors }
                                quantiles { cpuTimeP99 }
                                dimensions { scriptName }
                            }
                        }
                    }
                }`,
                variables: { accountTag: accountId, datetimeStart: start, datetimeEnd: end }
            };
            const graphRes = await axios.post('https://api.cloudflare.com/client/v4/graphql', graphqlQuery, { headers, timeout: 5000 });

            if (graphRes.data?.errors) {
                console.error('GraphQL Errors:', JSON.stringify(graphRes.data.errors));
            }

            const data = graphRes.data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive;
            if (data && Array.isArray(data)) {
                data.forEach(item => {
                    if (item.dimensions && item.dimensions.scriptName) {
                        workerStats[item.dimensions.scriptName] = {
                            requests: item.sum?.requests || 0,
                            errors: item.sum?.errors || 0,
                            cpu: item.quantiles?.cpuTimeP99 || 0
                        };
                    }
                });
            }
        } catch (e) {
            console.error('GraphQL fetch error:', e.response?.data || e.message);
        }

        const mappedWorkers = workers.map(w => {
            const stats = workerStats[w.id] || { requests: 0, errors: 0, cpu: 0 };
            return {
                id: w.id,
                name: w.id,
                requests: stats.requests,
                errors: stats.errors,
                cpu: stats.cpu
            };
        });

        res.json({ success: true, workers: mappedWorkers, subdomain });
    } catch (e) {
        res.status(500).json({ success: false, message: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

// API: حذف یک ورکر
app.post('/api/cloudflare/delete-worker', async (req, res) => {
    const { email, token, workerName } = req.body;
    if (!token || !workerName) return res.json({ success: false, message: 'اطلاعات ناقص است' });
    try {
        const _token = token.trim();
        const _email = (email || '').trim();
        const isCfat = _token.startsWith('cfat_') || _token.length === 40 || _email === '';
        const headers = { 'Content-Type': 'application/json' };
        if (isCfat) headers['Authorization'] = `Bearer ${_token}`;
        else { headers['X-Auth-Email'] = _email; headers['X-Auth-Key'] = _token; }

        const accRes = await axios.get('https://api.cloudflare.com/client/v4/accounts', { headers, timeout: 10000 });
        if (!accRes.data.success || accRes.data.result.length === 0) return res.json({ success: false, message: 'اکانتی یافت نشد' });
        const accountId = accRes.data.result[0].id;

        await axios.delete(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`, { headers, timeout: 10000 });
        res.json({ success: true, message: `ورکر ${workerName} حذف شد` });
    } catch (e) {
        res.status(500).json({ success: false, message: e.response?.data?.errors?.[0]?.message || e.message });
    }
});

const https = require('https');
const tls = require('tls');
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function getBpbKvAccess(token, email) {
    const cleanToken = String(token || '').trim();
    const cleanEmail = String(email || '').trim();
    if (!cleanToken) throw new Error('Cloudflare token is required to sync BPB settings.');

    const headers = { 'Content-Type': 'application/json' };
    if (cleanToken.startsWith('cfat_') || !cleanEmail) headers.Authorization = `Bearer ${cleanToken}`;
    else {
        headers['X-Auth-Email'] = cleanEmail;
        headers['X-Auth-Key'] = cleanToken;
    }

    const accountsRes = await axios.get('https://api.cloudflare.com/client/v4/accounts', { headers, timeout: 15000 });
    const accountId = accountsRes.data?.result?.[0]?.id;
    if (!accountsRes.data?.success || !accountId) throw new Error('Cloudflare account was not found.');

    const perPage = 1000;
    for (let page = 1; ; page += 1) {
        const namespacesRes = await axios.get(
            `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces`,
            { headers, params: { page, per_page: perPage, order: 'title', direction: 'asc' }, timeout: 15000 }
        );
        const namespaces = Array.isArray(namespacesRes.data?.result) ? namespacesRes.data.result : [];
        const namespace = namespaces.find(item => String(item.title || '').trim().toLowerCase() === 'mlmvpn');
        if (namespace?.id) return { headers, accountId, namespaceId: namespace.id };

        const totalCount = Number(namespacesRes.data?.result_info?.total_count);
        if (!namespaces.length || !Number.isFinite(totalCount) || page * perPage >= totalCount) break;
    }
    throw new Error('BPB KV namespace mlmvpn was not found.');
}

/**
 * Translate this app's legacy BPB settings payload into the v5.1.1 schema, and split it
 * by where each value now lives.
 *
 * v5.1.1 reorganised the panel's storage:
 *   * KV (`proxySettings`) keeps the per-connection knobs, but several keys were renamed
 *     or merged — `VLConfigs`/`TRConfigs` collapsed into one comma-joined `protocols`
 *     string, `tlsPorts`+`nonTlsPorts` collapsed into a single numeric `ports` array, and
 *     the `"len,int,packets"` fragment string exploded into six typed fields.
 *   * The proxy-IP group (`proxyIpMode`, `proxyIPs`, `prefixes`, `fallback`, `dohUrl`) no
 *     longer lives in KV AT ALL — it is compiled into the worker script itself, so a KV
 *     write for those keys is silently discarded. Changing them means asking the panel to
 *     rebuild and redeploy its own script.
 *
 * `updateDataset()` in the panel rebuilds KV from a fixed field list, so unknown keys are
 * dropped rather than rejected. That makes stale names fail QUIETLY: the user flips a
 * protocol off, the app reports success, and nothing changes. Hence this explicit mapping.
 */
function mapBpbSettings(input = {}) {
    const kv = {};
    const main = {};

    // --- protocols: VLConfigs/TRConfigs (or the older vless/trojan) -> "vless,trojan"
    const vlessOn = input.VLConfigs !== undefined ? !!input.VLConfigs
        : (input.vless !== undefined ? !!input.vless : undefined);
    const trojanOn = input.TRConfigs !== undefined ? !!input.TRConfigs
        : (input.trojan !== undefined ? !!input.trojan : undefined);
    if (vlessOn !== undefined || trojanOn !== undefined) {
        const list = [];
        if (vlessOn !== false) list.push('vless');
        if (trojanOn !== false) list.push('trojan');
        // Every protocol off would produce an empty subscription; keep vless so the user
        // gets configs back instead of a blank list they cannot explain.
        kv.protocols = (list.length ? list : ['vless']).join(',');
    }

    // --- ports: two string arrays -> one numeric array
    const portPool = [];
    if (Array.isArray(input.tlsPorts)) portPool.push(...input.tlsPorts);
    if (Array.isArray(input.nonTlsPorts)) portPool.push(...input.nonTlsPorts);
    if (!portPool.length && Array.isArray(input.ports)) portPool.push(...input.ports);
    if (portPool.length) {
        const ports = [...new Set(portPool.map(p => parseInt(p, 10)).filter(p => Number.isInteger(p) && p > 0 && p < 65536))];
        if (ports.length) kv.ports = ports;
    }

    // --- fragment: "100-200,10-20,tlshello" -> typed fields
    if (input.fragment !== undefined) {
        const raw = String(input.fragment || '').trim();
        if (!raw) {
            kv.fragmentMode = 'low';
        } else {
            const [lenPart = '', delayPart = '', packets = 'tlshello'] = raw.split(',');
            const range = (part, fbMin, fbMax) => {
                const [a, b] = String(part).split('-').map(n => parseInt(n, 10));
                const min = Number.isInteger(a) ? a : fbMin;
                const max = Number.isInteger(b) ? b : min;
                return min <= max ? [min, max] : [max, min];
            };
            const [lenMin, lenMax] = range(lenPart, 100, 200);
            const [delMin, delMax] = range(delayPart, 1, 1);
            const allowedPackets = ['tlshello', '1-1', '1-2', '1-3', '1-5'];
            kv.fragmentMode = 'custom';
            kv.fragmentLengthMin = lenMin;
            kv.fragmentLengthMax = lenMax;
            kv.fragmentDelayMin = delMin;
            kv.fragmentDelayMax = delMax;
            kv.fragmentPackets = allowedPackets.includes(packets.trim()) ? packets.trim() : 'tlshello';
        }
    }

    // --- unchanged KV keys, passed through as-is
    ['allowLANConnection', 'enableIPv6', 'fakeDNS', 'logLevel', 'remoteDNS', 'cleanIPs',
     'customCdnAddrs', 'customCdnHost', 'customCdnSni', 'fingerprint', 'enableTFO',
     'bestPingInterval', 'customDomain'].forEach(k => {
        if (input[k] !== undefined) kv[k] = input[k];
    });

    // --- main settings: compiled into the script, must go through the panel API
    const mode = input.proxyIpMode !== undefined ? input.proxyIpMode : input.proxyIPMode;
    if (mode !== undefined) main.proxyIpMode = mode;
    if (input.proxyIPs !== undefined) {
        main.proxyIPs = Array.isArray(input.proxyIPs)
            ? input.proxyIPs.filter(Boolean)
            : (input.proxyIPs ? [input.proxyIPs] : []);
    }
    if (input.prefixes !== undefined) {
        main.prefixes = Array.isArray(input.prefixes)
            ? input.prefixes.filter(Boolean)
            : (input.prefixes ? [input.prefixes] : []);
    }
    ['fallback', 'dohUrl'].forEach(k => { if (input[k] !== undefined) main[k] = input[k]; });

    return { kv, main };
}

/**
 * Push the main-settings group through the panel's own API.
 *
 * Read-modify-write is mandatory here, not a nicety. `updatePanelSettings` feeds the body
 * straight into `updateMainSettings`, which reads `newSettings.vlUUID`, `.trPass` and
 * `.securePath` and recompiles the worker from them. A partial PUT would rebuild the panel
 * with those values undefined — the panel would redeploy itself to an unreachable path and
 * lose its credentials. So: fetch the complete current settings, overlay only our changes,
 * send the whole object back.
 */
/**
 * Build the panel's auth cookie ourselves instead of logging in for it.
 *
 * The panel authorises by verifying the `jwtToken` cookie against a `secretKey` it keeps
 * in KV — it does not compare the payload to anything, so any correctly-signed,
 * unexpired HS256 token is accepted. KV is reachable over api.cloudflare.com, which is
 * NOT filtered, so the whole handshake can happen off the worker domain.
 *
 * That is what makes panel operations survive the filter: the edge proxy forwards a
 * `Cookie` header but strips `Set-Cookie`, so a real login round-trip can never complete
 * through it. Deriving the cookie removes the only step that needed a direct connection.
 * (Same trick as Zeus, whose session cookie is just sha256 of the password.)
 */
async function bpbAuthCookie(token, email) {
    const { headers, accountId, namespaceId } = await getBpbKvAccess(token, email);
    const kvValueUrl = (key) =>
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`;

    let secret = null;
    try {
        const r = await axios.get(kvValueUrl('secretKey'), {
            headers,
            timeout: 15000,
            // The key is a hex string; stop axios from trying to be clever with it.
            transformResponse: [(d) => d]
        });
        secret = typeof r.data === 'string' ? r.data.trim() : null;
    } catch (e) {
        if (e.response?.status !== 404) throw e;
    }

    // The panel generates this lazily on first login. On a panel nobody has logged into
    // yet the key simply is not there, so seed it — the worker reads whatever KV holds.
    if (!secret) {
        secret = crypto.randomBytes(32).toString('hex');
        await axios.put(kvValueUrl('secretKey'), secret, {
            headers: { ...headers, 'Content-Type': 'text/plain' },
            timeout: 15000
        });
    }

    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = b64url({ alg: 'HS256' });
    const body = b64url({ id: accountId, iat: now, exp: now + 86400 });
    const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
    return `jwtToken=${head}.${body}.${sig}`;
}

/** GET/PUT against the panel, through gtFetch so a filtered worker domain still works. */
async function bpbPanelCall(panelBase, path, cookie, { method = 'GET', body = null } = {}) {
    const r = await gtFetch(`${panelBase}${path}`, {
        method,
        headers: {
            Cookie: cookie,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            ...(body ? { 'Content-Type': 'application/json' } : {})
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        timeoutMs: 30000
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    return { status: r.status, data, viaFallback: !!r.viaFallback };
}

async function updateBpbMainSettings(url, subPath, email, main, token) {
    const panelBase = subPath ? `${url}/${encodeURIComponent(subPath)}` : url;
    const cookie = await bpbAuthCookie(token, email);

    const currentRes = await bpbPanelCall(panelBase, '/panel/settings', cookie);
    const current = currentRes.data?.body?.proxySettings || currentRes.data?.proxySettings;
    if (!current || typeof current !== 'object') {
        throw new Error('پنل تنظیمات فعلی را برنگرداند؛ برای جلوگیری از خراب شدن پنل، چیزی نوشته نشد.');
    }

    const merged = { ...current, ...main };
    // Refuse rather than risk it: without these three the panel rebuilds itself broken.
    for (const required of ['vlUUID', 'trPass', 'securePath']) {
        if (!merged[required]) {
            throw new Error(`تنظیمات پنل ناقص است (${required} ندارد) — برای جلوگیری از خراب شدن پنل متوقف شد.`);
        }
    }

    const putRes = await bpbPanelCall(panelBase, '/panel/update-settings', cookie, { method: 'PUT', body: merged });
    if (putRes.status !== 200 || putRes.data?.success === false) {
        const detail = putRes.data?.body ? JSON.stringify(putRes.data.body) : (putRes.data?.message || putRes.status);
        throw new Error(`پنل تنظیمات را نپذیرفت: ${detail}`);
    }
    return true;
}

/**
 * A KV read that 404s is not an error here — it is a panel nobody has opened yet.
 *
 * The panel writes `proxySettings` lazily: `getDataset()` only persists the defaults the
 * first time someone hits a panel route. Straight after a deploy the namespace exists but
 * the key does not, so Cloudflare answers 404 with "get: 'key not found'" (code 10009) —
 * which used to surface verbatim as «خطا از سرور» and left the settings modal empty.
 *
 * So: on a miss, poke the panel once through gtFetch to make it seed KV, then read again.
 * If even that fails (filtered domain, panel not reachable), return an empty object with
 * success — the modal then renders its own defaults instead of a KV error, and the
 * subsequent PUT creates the key anyway.
 */
function isKvKeyMissing(e) {
    if (e.response?.status === 404) return true;
    const errs = e.response?.data?.errors;
    return Array.isArray(errs) && errs.some(x => x?.code === 10009 || /key not found/i.test(x?.message || ''));
}

app.post('/api/cloudflare/bpb-settings/get', async (req, res) => {
    const { token, email = '', url = '', subPath = '' } = req.body;
    try {
        const { headers, accountId, namespaceId } = await getBpbKvAccess(token, email);
        const valueUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/proxySettings`;

        const readKv = async () => {
            const valueRes = await axios.get(valueUrl, { headers, timeout: 15000 });
            return typeof valueRes.data === 'string' ? JSON.parse(valueRes.data) : valueRes.data;
        };

        let proxySettings = null;
        try {
            proxySettings = await readKv();
        } catch (e) {
            if (!isKvKeyMissing(e)) throw e;

            // Not initialised yet. Ask the panel for its settings — that call makes it
            // write the defaults to KV — then read KV again.
            if (url) {
                try {
                    const panelBase = subPath ? `${url}/${encodeURIComponent(subPath)}` : url;
                    const cookie = await bpbAuthCookie(token, email);
                    const panelRes = await bpbPanelCall(panelBase, '/panel/settings', cookie);
                    const fromPanel = panelRes.data?.body?.proxySettings || panelRes.data?.proxySettings;
                    if (fromPanel && typeof fromPanel === 'object') proxySettings = fromPanel;
                } catch (panelErr) {
                    console.error('[BPB] panel settings bootstrap failed:', panelErr.message);
                }
            }
            if (!proxySettings) {
                try { proxySettings = await readKv(); } catch (retryErr) { /* still missing */ }
            }
            // Give the UI defaults rather than an error it cannot act on.
            if (!proxySettings) return res.json({ success: true, settings: { proxySettings: {} }, uninitialized: true });
        }

        res.json({ success: true, settings: { proxySettings } });
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.errors?.[0]?.message || e.message || 'BPB settings sync failed.' });
    }
});

app.post('/api/cloudflare/bpb-settings/update', async (req, res) => {
    const { token, email = '', settings, url = '', subPath = '' } = req.body;
    if (!settings) return res.status(400).json({ error: 'Invalid parameters' });
    try {
        const { kv, main } = mapBpbSettings(settings);

        // 1) KV-scoped settings: written directly, no redeploy, takes effect immediately.
        if (Object.keys(kv).length) {
            const { headers, accountId, namespaceId } = await getBpbKvAccess(token, email);
            const valueUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/storage/kv/namespaces/${namespaceId}/values/proxySettings`;
            let currentSettings = {};
            try {
                const currentRes = await axios.get(valueUrl, { headers, timeout: 15000 });
                currentSettings = typeof currentRes.data === 'string' ? JSON.parse(currentRes.data) : currentRes.data;
            } catch (readError) {
                if (!isKvKeyMissing(readError)) throw readError;
                // Fresh panel: KV has no proxySettings yet. Writing only our handful of
                // keys would leave the dataset without the ones the panel never re-adds,
                // so let the panel seed its defaults first and merge on top of those.
                if (url) {
                    try {
                        const panelBase = subPath ? `${url}/${encodeURIComponent(subPath)}` : url;
                        const cookie = await bpbAuthCookie(token, email);
                        const panelRes = await bpbPanelCall(panelBase, '/panel/settings', cookie);
                        const seeded = panelRes.data?.body?.proxySettings || panelRes.data?.proxySettings;
                        if (seeded && typeof seeded === 'object') currentSettings = seeded;
                    } catch (bootErr) {
                        console.error('[BPB] settings bootstrap before write failed:', bootErr.message);
                    }
                }
            }
            // Drop the pre-5.1.1 names so a stale value cannot shadow the new ones.
            const nextSettings = { ...currentSettings, ...kv };
            ['VLConfigs', 'TRConfigs', 'vless', 'trojan', 'tlsPorts', 'nonTlsPorts',
             'fragment', 'proxyIPMode'].forEach(k => delete nextSettings[k]);

            await axios.put(valueUrl, nextSettings, {
                headers: { ...headers, 'Content-Type': 'application/json' },
                timeout: 15000
            });
        }

        // 2) Main settings: only the panel can apply these, and only by rebuilding its own
        // script. Report the failure instead of swallowing it — a silent no-op here means
        // the user's proxy IP choice quietly never applied.
        let mainApplied = false;
        let mainError = null;
        if (Object.keys(main).length) {
            if (!url) {
                mainError = 'آدرس پنل در دسترس نبود، تنظیمات Proxy IP اعمال نشد.';
            } else {
                try {
                    await updateBpbMainSettings(url, subPath, email, main, token);
                    mainApplied = true;
                } catch (e) {
                    mainError = e.message;
                }
            }
        }

        res.json({ success: true, message: 'Settings updated', mainApplied, mainError });
    } catch (e) {
        res.status(500).json({ error: e.response?.data?.errors?.[0]?.message || e.message || 'BPB settings sync failed.' });
    }
});

// BPB Panel Login Helper
async function bpbLogin(url, securePath = '', email = '', passwords = ["Admin123!", "admin"]) {
    // Retry up to 5 times (10 seconds) for KV propagation
    const headers = {
        'Content-Type': 'text/plain',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    };
    // BPB v5.1.1+ mounts EVERYTHING under the secure path — `/{securePath}/login`,
    // `/{securePath}/panel`, `/{securePath}/sub`. The bare-root base is only kept as a
    // fallback for panels deployed by an older build of this app.
    const panelBases = securePath
        ? [`${url}/${encodeURIComponent(securePath)}`, url]
        : [url];
    // The current panel authenticates with `{username, password}` where username MUST be
    // the Cloudflare account email (auth/index.ts: `username !== accEmail` -> 401). The
    // bare-password form is the pre-5.1.1 shape and is tried only afterwards.
    const credentialAttempts = [
        ...(email ? passwords.map(password => JSON.stringify({ username: email, password })) : []),
        ...passwords
    ];
    if (!email) {
        console.warn('[bpbLogin] no Cloudflare email supplied — a v5.1.1 panel will reject every attempt, it authenticates by email.');
    }
    // Bail out the moment the host proves unreachable.
    //
    // This loop is 5 retries x 2 bases x 4 credential shapes = 40 attempts. At the old
    // 15s timeout that is TEN MINUTES of hanging when the worker domain is filtered — and
    // workers.dev IS filtered in Iran, so that was the normal case, not the edge case. It
    // presented as the config dialog spinning forever with no error. A blocked host fails
    // the same way for every credential, so once a network-level failure is seen there is
    // nothing left to try here.
    let unreachable = false;
    for (let retry = 0; retry < 3 && !unreachable; retry++) {
        for (const panelBase of panelBases) {
            if (unreachable) break;
            for (const pass of credentialAttempts) {
            try {
                console.log(`[bpbLogin] Attempting to connect to ${panelBase}/login/authenticate (Try ${retry + 1})`);
                const loginRes = await axios.post(`${panelBase}/login/authenticate`, pass, {
                    headers,
                    validateStatus: () => true,
                    httpsAgent,
                    timeout: 6000
                });
                if (loginRes.status === 200) {
                    console.log(`[bpbLogin] Success!`);
                    let cookies = loginRes.headers['set-cookie'];
                    if (cookies && cookies.length > 0) {
                        return { cookie: cookies.map(c => c.split(';')[0]).join('; '), panelBase };
                    }
                } else if (loginRes.status !== 401) {
                    console.error("Login attempt failed with status:", loginRes.status);
                }
            } catch (e) {
                console.error("Login attempt network error:", e.message);
                const code = String(e.code || '');
                const msg = String(e.message || '').toLowerCase();
                if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/.test(code) ||
                    /timeout|network|socket hang up/.test(msg)) {
                    unreachable = true;
                    break;
                }
            }
        }
        }
        if (unreachable) break;
        // Wait 2s before retrying
        await new Promise(r => setTimeout(r, 2000));
    }
    if (unreachable) {
        // Said plainly, because the fix is on the user's side and the previous wording
        // buried it behind a KV-propagation guess.
        throw new Error('دامنه‌ی پنل از این شبکه در دسترس نیست (به احتمال زیاد فیلتر است). دریافت کانفیگ از مسیر جایگزین انجام می‌شود، ولی تغییر Proxy IP نیاز به فیلترشکن دارد.');
    }
    throw new Error('ورود به پنل ناموفق بود. اگر پنل تازه ساخته شده چند ثانیه صبر کنید و دوباره تلاش کنید.');
}

// API: Get Panel Settings
app.post('/api/cloudflare/panel/get', async (req, res) => {
    const { url, subPath = '', email = '', token = '' } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL provided' });
    try {
        // Derived cookie + gtFetch: no login round-trip, and the call survives the worker
        // domain being filtered. Falls back to a real login for panels too old to have a
        // secretKey-based session.
        const panelBase = subPath ? `${url}/${encodeURIComponent(subPath)}` : url;
        let cookie;
        try {
            cookie = await bpbAuthCookie(token, email);
        } catch (deriveError) {
            ({ cookie } = await bpbLogin(url, subPath, email));
        }
        const settingsRes = await bpbPanelCall(panelBase, '/panel/settings', cookie);
        res.json({ success: true, settings: settingsRes.data });
    } catch (e) {
        res.status(500).json({ error: e.message || 'خطا در ارتباط با پنل' });
    }
});

// API: Update Panel Settings
app.post('/api/cloudflare/panel/update', async (req, res) => {
    const { url, settings, subPath = '', email = '', token = '' } = req.body;
    if (!url || !settings) return res.status(400).json({ error: 'Invalid parameters' });
    try {
        const panelBase = subPath ? `${url}/${encodeURIComponent(subPath)}` : url;
        let cookie;
        try {
            cookie = await bpbAuthCookie(token, email);
        } catch (deriveError) {
            ({ cookie } = await bpbLogin(url, subPath, email));
        }
        const updateRes = await bpbPanelCall(panelBase, '/panel/update-settings', cookie, { method: 'PUT', body: settings });
        if (updateRes.status !== 200) {
            throw new Error(`Failed to update settings: ${updateRes.status}`);
        }
        res.json({ success: true, message: 'Settings updated' });
    } catch (e) {
        res.status(500).json({ error: e.message || 'خطا در ذخیره تنظیمات پنل' });
    }
});

// API: Fetch Nodes
app.post('/api/cloudflare/fetch-nodes', async (req, res) => {
    const { url, subPath, uuid, trPass, protocols = {} } = req.body;
    try {
        const requestOptions = {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
            httpsAgent,
            timeout: 15000
        };
        // BPB v5 uses /{securePath}/sub/raw. Retain the old URL as a
        // fallback so existing deployed Workers continue to work.
        //
        // Both go through gtFetch: the subscription lives on the user's own workers.dev
        // host, and workers.dev is filtered in Iran. Everything else in this flow talks to
        // api.cloudflare.com, which is NOT filtered — which is exactly why panel settings
        // sync fine while fetching the configs dies. gtFetch tries direct first and falls
        // back to the same edge proxy the GitHub Tunnel already uses, so the user does not
        // need a second VPN just to download the configs for their VPN.
        //
        // The subscription endpoint needs no authentication (the secure path is the
        // secret), so the proxy hop is enough here — unlike panel login, whose Set-Cookie
        // the proxy does not pass back.
        const subGet = async (target) => {
            const r = await gtFetch(target, {
                headers: requestOptions.headers,
                timeoutMs: 20000
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return { data: await r.text(), viaFallback: !!r.viaFallback };
        };

        let fetchRes;
        try {
            fetchRes = await subGet(`${url}/${encodeURIComponent(subPath)}/sub/raw?app=xray`);
        } catch (v5Error) {
            try {
                fetchRes = await subGet(`${url}/sub/raw/${encodeURIComponent(subPath)}?app=xray`);
            } catch (legacyError) {
                // A deployed v5 panel can have its subscription route disabled or
                // moved. The account already contains the deployment secrets, so
                // return safe base nodes instead of failing the desktop workflow.
                const host = new URL(url).hostname;
                const generatedConfigs = [];
                if (uuid && protocols.vless !== false) {
                    const params = new URLSearchParams({ encryption: 'none', security: 'tls', type: 'ws', host, path: '/vl' });
                    generatedConfigs.push(`vless://${uuid}@${host}:443?${params.toString()}#MLM%20BPB%20VLESS`);
                }
                if (trPass && protocols.trojan !== false) {
                    const params = new URLSearchParams({ security: 'tls', type: 'ws', host, path: '/tr' });
                    generatedConfigs.push(`trojan://${encodeURIComponent(trPass)}@${host}:443?${params.toString()}#MLM%20BPB%20Trojan`);
                }
                if (generatedConfigs.length) {
                    return res.json({ success: true, configs: generatedConfigs, fallback: true });
                }
                throw legacyError;
            }
        }
        const base64Data = fetchRes.data;
        let decoded = "";
        if (typeof base64Data === 'string') {
            if (base64Data.trim().startsWith("vless://") || base64Data.trim().startsWith("trojan://")) {
                decoded = base64Data;
            } else {
                decoded = Buffer.from(base64Data, 'base64').toString('utf8');
            }
        } else {
            decoded = String(base64Data);
        }

        const configs = decoded.split('\n').map(c => c.trim().replace("dY'", "mlmvpn")).filter(c => c.length > 0).map(c => applySniCamouflage(c));
        res.json({ success: true, configs });
    } catch (e) {
        console.error("fetch-nodes error:", e.response ? e.response.status : e.message, e.config ? e.config.url : "");
        res.status(500).json({ error: 'خطا در دریافت نودها: ' + (e.response ? e.response.status : e.message) });
    }
});



// API: توقف
app.post('/api/stop', (req, res) => {
    if (!scanState.running && !scanState.stopRequested) return res.status(400).json({ error: 'اسکنی در حال اجرا نیست' });
    scanState.stopRequested = true;
    scanState.running = false;
    res.json({ message: 'در حال توقف...' });
});

// API: نتایج
app.get('/api/results', (req, res) => {
    res.json({ running: scanState.running, total: scanState.total, tested: scanState.tested, alive: scanState.alive, dead: scanState.dead, results: scanState.results });
});

// API: وضعیت
app.get('/api/status', (req, res) => {
    res.json({ running: scanState.running, total: scanState.total, tested: scanState.tested, alive: scanState.alive, dead: scanState.dead });
});

// API: اسکن پیشرفته
app.post('/api/advanced-scan', async (req, res) => {
    const { ips } = req.body;
    if (!ips || !Array.isArray(ips)) return res.status(400).json({ error: 'Array of IPs required' });

    const { advancedScanIp } = require('./scanner');

    try {
        const results = await Promise.all(ips.map(async target => {
            const res = await advancedScanIp(target.ip, target.port || 443, target.provider || 'generic', 5000);
            res.ip = target.ip;
            res.port = target.port || 443;
            return res;
        }));
        res.write(JSON.stringify({ done: true }) + '\n');
        res.end();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// («/api/proxy/start» stood here: a legacy duplicate of /api/v2ray/start that nothing called
//  and that could not have worked — it passed `false` where startXray expects its log callback,
//  so the first onLog() inside it threw. Removed rather than repaired; there is one connect
//  route.)

// Live system-proxy switch (v2rayN style). Independent of both engines: flipping it never
// starts, stops, or reconfigures Xray or Aether, so the tunnel survives being toggled.
// Xray's two inbounds — never Aether, which is only Xray's transport. HTTP is what Windows'
// proxy setting can speak; SOCKS is what a TUN needs, since sing-box dials its upstream over
// SOCKS5 and WinINET cannot. Read live, not fixed: «پورت محلی» in Settings moves them, and
// while Xray runs these are the ports it actually started on (xray-manager.getPorts).
const XRAY = {
    get http() { return require('./xray-manager').getPorts().http; },
    get socks() { return require('./xray-manager').getPorts().socks; },
};
const WIN_PROXY_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function readSystemProxy() {
    try {
        const { execSync } = require('child_process');
        const out = execSync(`reg query "${WIN_PROXY_KEY}" /v ProxyEnable`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/ProxyEnable\s+REG_DWORD\s+0x(\d+)/i);
        const enabled = !!(m && parseInt(m[1], 16));
        let server = '';
        try {
            const s = execSync(`reg query "${WIN_PROXY_KEY}" /v ProxyServer`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
            const sm = s.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
            if (sm) server = sm[1].trim();
        } catch (e) {}
        return { enabled, server };
    } catch (e) {
        return { enabled: false, server: '' };
    }
}

app.get('/api/proxy/system', async (req, res) => {
    res.json(Object.assign(readSystemProxy(), {
        port: XRAY.http,
        xrayRunning: await portIsLive(XRAY.http),
    }));
});

// Is anything accepting connections on this local port?
function portIsLive(port, timeoutMs = 700) {
    return new Promise((resolve) => {
        const sock = new (require('net').Socket)();
        const done = (ok) => { try { sock.destroy(); } catch (e) {} resolve(ok); };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => done(true));
        sock.once('timeout', () => done(false));
        sock.once('error', () => done(false));
        sock.connect(port, '127.0.0.1');
    });
}

// ── one lock for every transition of the whole-system tunnel ────────────────────────
//
// Four independent callers can start or stop the TUN: the user's switch, the watchdog's
// re-arm, the uplink refresh, and the system-proxy toggle. None of them knew about the
// others, and two overlapping starts do not merely race — they destroy each other, because
// startTun begins by DELETING any adapter named MLMVPN as a leftover. The second start wipes
// the adapter the first one just created, and from then on neither can ever succeed:
//
//     14:05:12  [TUN] ✅ آداپتور «MLMVPN» ساخته شد و مسیر پیش‌فرض روی آن است.
//     14:05:12  [TUN] آداپتور «MLMVPN» از اجرای قبلی باقی مانده بود — حذف می‌شود.  <- the other start
//     14:05:15  [TUN] FATAL configure tun interface: Cannot create a file when that file already exists.
//     14:05:18  [TUN] ❌ تلاش 0 ناموفق بود      <- "attempt 0": a counter two paths were sharing
//
// That loop repeated every ~15 seconds for as long as the tunnel was left on, and it is what
// the switch turning itself off looks like from the outside. Serialising the transitions is
// the fix: they are all short, they all touch the same adapter, and none of them is safe to
// interleave with another.
let tunLock = Promise.resolve();
// How many transitions are queued or running. The watchdog reads this: judging the tunnel
// while someone is in the middle of building it is how it came to kill the very process a
// start was still waiting on. `aetherRearmInFlight` only ever covered the re-arm path.
let tunLockDepth = 0;

function withTunLock(who, fn) {
    tunLockDepth++;
    const run = tunLock.then(fn, fn);   // a failed holder must not poison the queue
    tunLock = run.catch(() => {}).finally(() => { tunLockDepth--; });
    return run;
}

function tunTransitionInProgress() {
    return tunLockDepth > 0;
}

app.post('/api/proxy/system', async (req, res) => {
    const enable = !!(req.body && req.body.enabled);
    try {
        // Pointing Windows at a port nobody is listening on kills all connectivity, and the
        // user has no way to tell that from "the VPN is broken". Refuse instead.
        if (enable && !(await portIsLive(XRAY.http))) {
            return res.status(409).json({
                error: `موتور Xray این برنامه اجرا نیست (پورت ${XRAY.http} خالی است). ` +
                       'اول از تب نودها به یک کانفیگ وصل شوید، بعد پراکسی سیستم را روشن کنید. ' +
                       'در غیر این صورت کل اینترنت ویندوز قطع می‌شود.',
                code: 'XRAY_NOT_RUNNING',
            });
        }

        // The other half of the mutual exclusion (see /api/tun): never let both be on.
        //
        // Turning the tunnel OFF here is not enough, and the difference is a machine that
        // fights the user. `aetherTunWanted` is what the watchdog obeys, so a bare stopTun
        // left the intent standing: five seconds later the re-arm brought the tunnel back,
        // the tunnel path switched the system proxy off again ("پراکسی سیستم خاموش شد"), and
        // the two switches took turns for as long as the app was open — measured at
        // 14:04:53 → 14:05:06 → 14:05:26 → 14:05:41 on 2026-08-17.
        //
        // Choosing the system proxy is therefore recorded as choosing it: the intent is
        // cleared, the watchdog stops, and the kill switch is released, all inside the same
        // lock the tunnel's own transitions use so nothing can start one mid-teardown.
        // The V2Ray tunnel rides the same adapter, and this switch lives in another panel —
        // so without this, turning the proxy on from the Aether side left BOTH on: the
        // browser sent its traffic to Xray while the adapter captured Xray's replies and
        // fed them back in. Same rule, wherever the switch is: choosing the proxy means the
        // tunnel comes down.
        if (enable) await v2rayTunTeardownIfUp('کاربر پراکسی سیستم را انتخاب کرد');

        if (enable && (tun.isRunning() || aetherTunWanted)) {
            await withTunLock('system-proxy', async () => {
                aetherTunWanted = false;
                aetherStopWatchdog();
                await aetherReleaseFailClosed('کاربر پراکسی سیستم را انتخاب کرد');
                tun.stopTun(aetherBroadcastLog, 'user chose system proxy');
                await tun.verifyTornDown(aetherBroadcastLog);
            });
            aetherBroadcastLog('[TUN] تونل خاموش شد (با پراکسی سیستم قابل جمع نیست).');
            broadcast('tun', { running: false, wanted: false });
        }

        const { enableSystemProxy } = require('./xray-manager');
        await enableSystemProxy(enable, XRAY.http);
        const state = readSystemProxy();
        broadcast('system_proxy', state);
        res.json(Object.assign({ ok: true }, state));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── TUN mode ────────────────────────────────────────────────────────────────────────
// TUN and the system proxy are mutually exclusive by nature, not by preference. TUN takes
// the default route, so a browser pointed at the proxy would send its traffic to Xray,
// which sends it to Aether, whose reply packets are captured by TUN and fed back in — a
// loop. Turning either one on therefore turns the other off.

// Leak audit — measures what the network can actually see, rather than trusting the config.
// `tunnelUp` is taken from the live TUN state, not from the caller, so the verdict cannot
// be made to look good by lying about which mode we are in.
app.get('/api/leak-audit', async (req, res) => {
    try {
        const { runLeakAudit } = require('./leak-audit');
        res.json(await runLeakAudit({ tunnelUp: require('./tun-manager').isRunning() }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/tun/status', (req, res) => {
    let ready = true, reason = null;
    try { tun.checkPrerequisites(); } catch (e) { ready = false; reason = e.message; }
    res.json({ running: tun.isRunning(), ready, reason });
});

// ── «گزارش تونل»: what the tunnel has been doing, and why it is as fast as it is ──────────────
//
// Two questions that could not be answered before, and both come up in the same sentence:
// «مدام قطع و وصل می‌شود و سرعتش خیلی پایین است».
//
//   · the flap    — every start, stop, verdict and stall, with its reason and how long the
//                   tunnel lasted, kept in ~/.mlmvpn/tunnel-events.log ACROSS restarts.
//   · the speed   — the same download through the tunnel and straight into the engine behind
//                   it. A tunnel far below its own engine means the loss is in the tunnel
//                   layer; the two together mean the engine is what is slow, and no tunnel
//                   setting will change it.
app.get('/api/tun/report', (req, res) => {
    try {
        const diag = require('./tun-diag');
        const limit = Math.max(10, Math.min(parseInt(req.query.limit || '80', 10) || 80, 500));
        let lines = [];
        try {
            lines = require('fs').readFileSync(diag.EVENTS_FILE, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit);
        } catch (e) { /* nothing recorded yet */ }
        // تور's own output, when تور is the engine behind this tunnel. It is the one engine whose
        // slowness is decided somewhere the tunnel cannot see — which entry guard it is pinned
        // to, whether a circuit built or timed out — and that lives only in its own log.
        let engineTail = '';
        try {
            if (tun.currentEngine() === 'tor.exe') engineTail = require('./tor-manager').torTail().slice(-8000);
        } catch (e) { /* not tor, or not running */ }
        res.json({
            ok: true,
            file: diag.EVENTS_FILE,
            singboxLog: require('path').join(require('os').homedir(), '.mlmvpn', 'tun.log'),
            tunnel: tun.currentTunnel(),
            running: tun.isRunning(),
            lines,
            engineTail,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Runs the A/B measurement now. Two downloads of ~2 MB each, one after the other — on a slow
// line that is the better part of a minute, which is why it answers when it is done rather than
// streaming, and why it refuses to run twice at once.
let tunDiagnoseBusy = false;
app.post('/api/tun/diagnose', async (req, res) => {
    if (!tun.isRunning()) return res.status(409).json({ error: 'تونل کامل روشن نیست — این سنجش تونل را با موتور پشتش مقایسه می‌کند، پس اول تونل را روشن کنید.' });
    if (tunDiagnoseBusy) return res.status(409).json({ error: 'یک سنجش دیگر در جریان است.' });
    tunDiagnoseBusy = true;
    try {
        const t = tun.currentTunnel() || {};
        const r = await require('./tun-diag').diagnose({
            socksPort: t.socksPort, engineLabel: t.label, onLog: tunBroadcastLog,
        });
        res.json({
            ok: true, verdict: r.verdict, note: r.note,
            tunMbit: r.tunMbit, engineMbit: r.engineMbit,
            engine: t.label, stack: (require('./network-settings').tunStack() || {}).name, mtu: t.mtu,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { tunDiagnoseBusy = false; }
});


/**
 * The WireGuard-family engine the system tunnel should carry — aether's, or «وارپ»'s own.
 *
 * «وارپ» became its own engine on 2026-09-21 (warp-manager.js) and this path did not know it.
 * The user's own report is what that looked like: the وارپ page said «وصل است — ولی ترافیکی از
 * آن رد نمی‌شود» and told them to switch on «تونل کامل»; the switch then answered «اول یکی از
 * موتورهای ماسک، وایرگارد یا وارپ در وارپ را وصل کنید». Connected, and refused by the very
 * control it was pointing at.
 *
 * Both engines look the same from here — a SOCKS port and a connected flag — so the tunnel takes
 * whichever is up. They are never both up in practice; if they were, aether keeps the tunnel
 * because it also owns the DNS bridge and the uplink-exclusion list.
 */
function aetherLikeActive() {
    if (aether.getStatus().connected) return { kind: 'aether', mgr: aether, port: aether.SOCKS_PORT };
    if (warp.getStatus().connected) return { kind: 'warp', mgr: warp, port: warp.SOCKS_PORT };
    return null;
}

/**
 * «is there still an engine under the tunnel?» — and the reason every caller must ask it this
 * way rather than `aether.getStatus().connected`.
 *
 * Reported 2026-09-21: the user pressed «قطع» on وارپ, the lamp went out, and the machine lost
 * the internet — not the app, the MACHINE: other programs could not connect either, and it only
 * came back when they quit MLM VPN entirely. The engine really had stopped. What had not stopped
 * was everything standing on it: sing-box still owned the default route and was handing every
 * packet to a SOCKS port with nothing behind it, the front-end Xray was still up, and Windows'
 * resolvers still pointed at a bridge with a dead upstream. Quitting fixed it because
 * `before-quit` in main.js tears all three down.
 *
 * The teardown existed — it was written for aether, and every one of its guards asked whether
 * AETHER was connected. With وارپ carrying the tunnel those guards read false while the tunnel
 * was healthy and false again once it was dead, so none of them could tell «nothing to repair»
 * from «nothing left to repair it for».
 */
function aetherLikeConnected() { return !!aetherLikeActive(); }

app.post('/api/tun', async (req, res) => {
    const enable = !!(req.body && req.body.enabled);
    try {
        if (!enable) {
            // The user's own decision. Clearing `wanted` here is what stops the watchdog and
            // the reconnect path from helpfully bringing back a tunnel they just switched off.
            // Inside the lock, so a re-arm that is already running finishes first and cannot
            // put the tunnel back up a second after this returns.
            const torn = await withTunLock('tun-off', async () => {
                aetherTunWanted = false;
                aetherStopWatchdog();
                await aetherReleaseFailClosed('کاربر تونل را خاموش کرد');
                tun.stopTun(aetherBroadcastLog, 'user switched the tunnel off');
                return tun.verifyTornDown(aetherBroadcastLog);
            });
            // TUN was the thing resolving names; with it gone, Windows is back on the ISP's
            // resolver in cleartext. Put the bridge back so the engine keeps protecting DNS
            // in proxy-only mode — the leak this app exists to close must not reopen just
            // because the user stepped down from full-tunnel to proxy.
            if (aetherLikeConnected()) await startAetherDnsBridge();
            broadcast('tun', { running: false, wanted: false });
            // …against the engine that is actually connected. Written as 'aether' unconditionally
            // this recorded nothing while «وارپ» held the tunnel, so «VPN همیشه روشن» kept
            // replaying `tun: true` after the user had switched the tunnel off.
            try {
                const carried = aetherLikeActive();
                require('./system-settings').updateConnection(carried ? carried.kind : 'aether', { tun: false });
            } catch (e) { /* none kept */ }
            return res.json({ ok: true, running: false, cleanedUp: torn.ok });
        }

        const active = aetherLikeActive();
        if (!active) {
            return res.status(409).json({
                error: 'اول یکی از موتورهای وارپ، ماسک، وایرگارد یا وارپ در وارپ را وصل کنید، بعد تونل را روشن کنید.',
                code: 'AETHER_NOT_CONNECTED',
            });
        }

        // Everything from here to "the adapter is up" is one transition. Two of them running
        // at once is not a slow tunnel, it is a permanently broken one: startTun deletes any
        // adapter named MLMVPN before creating its own, so the second start erases the first
        // one's adapter and both then fail forever on "Cannot create a file when that file
        // already exists". See withTunLock.
        await withTunLock('tun-on', async () => {
        // Drop the system proxy first, so the two never overlap even for a moment.
        if (readSystemProxy().enabled) {
            await require('./xray-manager').enableSystemProxy(false, XRAY.http);
            aetherBroadcastLog('[TUN] پراکسی سیستم خاموش شد (با تونل قابل جمع نیست).');
            broadcast('system_proxy', Object.assign(readSystemProxy(), { port: XRAY.http }));
        }

        // At 'warn' sing-box logs failed dials and nothing else — which is silence in exactly
        // the case that matters, because a connection sent to the ISP's filter sinkhole is
        // ACCEPTED and so is never a dial failure. With Aether's debug switch on, log every
        // routing decision so a report like this one can be read instead of guessed at.
        // THE BRIDGE COMES DOWN FIRST — BEFORE startTun, NOT AFTER.
        //
        // The ordering is the whole fix. startTun begins by proving the data path carries
        // traffic (tunnelCarriesData), and that probe opens its own SOCKS connection. The
        // bridge, meanwhile, opens a FRESH TCP control connection plus a UDP socket for
        // every single DNS query Windows makes — and Windows queries both 127.0.0.1 and ::1
        // in parallel across every adapter. Under that load aether's SOCKS listener has
        // nothing left for the probe, which is exactly what the field log shows:
        //
        //     11:54:59  [WARP] ✅ DNS سیستم به تونل متصل شد (127.0.0.1 + ::1:53)
        //     11:55:05  [TUN] بررسی عبور واقعی دیتا از تونل…
        //     11:55:05  socks client 127.0.0.1:52308 ended: io: early eof     <- probe refused
        //     11:55:12  socks client ... ended: other: dns timeout from 1.0.0.1:53
        //     11:55:14  ... same again on the retry
        //
        // Measured with the bridge NOT running, the same probe passes in 247ms and every
        // resolver answers in ~120ms. The tunnel was never the problem; the bridge was
        // starving it. Tearing the bridge down first gives startTun a quiet port to test.
        // Unconditional, and awaited. The old `if (aetherDnsBridgeStarted)` test was the second
        // half of the race described above stopAetherDnsBridge: a bridge that is still STARTING
        // has not set that flag yet, so the tunnel skipped the teardown entirely and the start
        // went on to point Windows at loopback seconds after the adapter came up. Asking for
        // the stop even when nothing looks started is what cancels it.
        if (aetherDnsBridgeStarted || aetherDnsBridgeStarting) {
            aetherBroadcastLog('[TUN] سرویس DNS محلی خاموش شد؛ از این پس DNS داخل خود تونل حل می‌شود.');
        }
        await stopAetherDnsBridge();

        // The engine's own edge address, excluded by /32. The static range list in tun-manager
        // does not cover every address the engine can pick (the identity file here has held a
        // 104.16.x CDN anycast endpoint), and when the process-name rule is refused by Windows
        // an uncovered uplink is captured by auto_route and fed back into the engine's own
        // SOCKS port — tunnel up, badge green, machine offline.
        aetherTunOptions = {
            logLevel: aether.getDebugMode() ? 'info' : 'warn',
            // The engine's own edge addresses must stay OUTSIDE the tunnel or it feeds itself:
            // the transport's packets get routed into the tunnel it is carrying and the machine
            // goes offline with a green badge over it. Ask whichever engine is carrying this one.
            uplinkIps: active.mgr.getUplinkIps(),
        };
        try {
            await tun.startTun(active.port, aetherBroadcastLog, aetherTunOptions);
        } catch (e) {
            // The tunnel did not come up, so Windows is back on its own resolvers with no
            // protection at all. Put the bridge back before reporting the failure — the
            // user stays in proxy-only mode, and that mode must not silently lose its DNS.
            if (aetherLikeConnected()) await startAetherDnsBridge();
            throw e;
        }

        // Only once startTun has PROVEN the adapter exists and owns the default route. Set
        // before that point, a failed start would leave the watchdog trying to resurrect a
        // tunnel the machine cannot create (no admin rights, driver missing) in a loop.
        aetherTunWanted = true;
        aetherRearmAttempts = 0;
        // Give auto_route time to settle before the watchdog is allowed to judge, exactly as
        // on the re-arm path. Without it the first watchdog tick can tear down a tunnel the
        // user just switched on.
        aetherTunSettledAt = Date.now();
        aetherStartWatchdog();
        });

        broadcast('tun', { running: true, wanted: true });
        try { require('./system-settings').updateConnection(active.kind, { tun: true }); } catch (e) { /* none kept */ }
        res.json({ ok: true, running: true });
    } catch (err) {
        await withTunLock('tun-on-failed', async () => {
            aetherTunWanted = false;
            aetherStopWatchdog();
            tun.stopTun(aetherBroadcastLog, 'start failed');
            await tun.verifyTornDown(aetherBroadcastLog);
        });
        await aetherReleaseFailClosed('راه‌اندازی تونل ناموفق بود');
        broadcast('tun', { running: false, wanted: false });
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/proxy/stop', async (req, res) => {
    try {
        // The non-blocking stop. The synchronous one froze the window for up to 13 s here too:
        // it tears the tunnel down with two 5 s taskkills around a 3 s Atomics.wait, inside
        // Electron's main process, on a click.
        await require('./xray-manager').stopXrayAsync();
        res.json({ message: 'Proxy Stopped' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// API: SNI Engine

app.post('/api/sni/test-bulk', async (req, res) => {
    const { ips, sni } = req.body;
    if (!ips || !sni || !Array.isArray(ips)) return res.status(400).json({ error: 'ips array and sni required' });

    const tls = require('tls');
    const net = require('net');

    const testTLSHandshake = (ip, sniStr, timeoutMs = 2000) => {
        return new Promise((resolve) => {
            const socket = tls.connect({
                host: ip,
                port: 443,
                servername: sniStr,
                rejectUnauthorized: false,
                timeout: timeoutMs
            });
            socket.on('secureConnect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.on('error', () => {
                resolve(false);
            });
            socket.on('timeout', () => {
                socket.destroy();
                resolve(false);
            });
        });
    };

    try {
        const results = {};
        const batchSize = 50;
        for (let i = 0; i < ips.length; i += batchSize) {
            const batch = ips.slice(i, i + batchSize);
            await Promise.all(batch.map(async (ip) => {
                const success = await testTLSHandshake(ip, sni, 3000);
                results[ip] = success;
            }));
        }
        res.write(JSON.stringify({ done: true }) + '\n');
        res.end();
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/sni/test', (req, res) => {
    const { ip, port, sni } = req.body;
    if (!ip || !port || !sni) return res.status(400).json({ error: 'IP, port, and sni required' });

    const tls = require('tls');
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(3000);

    socket.on('connect', () => {
        const tcpTime = Date.now() - start;

        const tlsSocket = tls.connect({
            socket: socket,
            servername: sni,
            rejectUnauthorized: false
        });

        let tlsDone = false;
        tlsSocket.on('secureConnect', () => {
            tlsDone = true;
            const tlsTime = Date.now() - start - tcpTime;
            tlsSocket.destroy();
            if (!res.headersSent) res.json({ tcp: tcpTime, tls: tlsTime, total: tcpTime + tlsTime });
        });

        tlsSocket.on('error', () => {
            tlsSocket.destroy();
            socket.destroy();
            if (!tlsDone && !res.headersSent) res.json({ tcp: tcpTime, tls: -1, total: -1 });
        });
    });

    socket.on('timeout', () => {
        socket.destroy();
        if (!res.headersSent) res.json({ tcp: -1, tls: -1, total: -1 });
    });

    socket.on('error', () => {
        socket.destroy();
        if (!res.headersSent) res.json({ tcp: -1, tls: -1, total: -1 });
    });

    socket.connect(port, ip);
});

// What is really up, for the SNI window: the front's own process, and the route it runs.
app.get('/api/sni/status', (req, res) => {
    const sni = require('./sni-manager');
    const running = sni.isSniRunning();
    res.json({ running, config: running ? sni.getActiveSniConfig() : null });
});

app.post('/api/sni/start', async (req, res) => {
    const { config, wait } = req.body;
    if (!config) return res.status(400).json({ error: 'SNI Config required' });
    try {
        startSniEngine(config, (log) => {
            if (log.includes('__TRAFFIC_UP__:')) {
                const m = log.match(/__TRAFFIC_UP__:(\d+)/);
                if (m) trafficFeed.push('sni', parseInt(m[1]), 0);
                return;
            }
            if (log.includes('__TRAFFIC_DOWN__:')) {
                const m = log.match(/__TRAFFIC_DOWN__:(\d+)/);
                if (m) trafficFeed.push('sni', 0, parseInt(m[1]));
                return;
            }
            wss.clients.forEach(c => {
                if (c.readyState === 1) c.send(JSON.stringify({ type: 'core_log', data: log }));
            });
        });
        // `wait`: the one-button flow dials the front the moment this answers, so "started"
        // has to mean listening, not merely spawned — Python takes a moment to bind, and a
        // config dialled into a port that is not open yet fails at its first packet.
        if (wait) {
            const port = Number(config.LISTEN_PORT) || 40443;
            if (!(await waitForPort(port, 8000))) {
                stopSniEngine();
                return res.status(502).json({ error: `موتور SNI روی پورت ${port} بالا نیامد.` });
            }
        }
        res.json({ message: 'SNI Engine Started' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sni/stop', (req, res) => {
    try {
        stopSniEngine();
        // The user ended an SNI connection: its record (the front's config rides with the V2Ray
        // one) must not bring it back at the next logon.
        try {
            const sys = require('./system-settings');
            const rec = sys.lastConnection();
            if (rec && rec.kind === 'v2ray' && rec.sni) sys.forgetConnection('v2ray');
        } catch (e) { /* none kept */ }
        res.json({ message: 'SNI Engine Stopped' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// «تحریم‌شکن» — which engine can reach what you need, and carrying only that
// ============================================================
//
// The relay this feature was built on is gone, and so are the routes that addressed it — including
// the pair that rewrote the machine's DNS servers. See backup/dead-uae-relay/README.md.
//
// What replaces them: the user names applications and sites, this measures every engine against
// those sites, and the traffic of the named applications is carried by the engine they choose.
// Everything else goes out the ordinary way — a bank or an Iranian site has nothing to gain from
// the detour and a measurable amount to lose.

/**
 * The engines this feature can offer, and how to reach each one.
 *
 * `socks` is what makes an engine usable HERE: split routing needs a port to send the chosen
 * applications to. The gateway has none — it takes an address from the relay's own DHCP and with it
 * the machine's default route — so it is offered as a whole-machine choice and says so, rather than
 * being quietly dropped from a list the user asked for it to be in.
 */
const SANCTION_ENGINES = {
    dedidns: {
        label: 'DNS اختصاصی',
        split: true,
        // Measurable without the user going anywhere: an Xray from their own saved configs, with
        // the Cloudflare worker as its resolver.
        autoStart: true,
        socks: () => (require('./xray-manager').isRunning() ? XRAY.socks : null),
        live: () => { try { return require('./xray-manager').isRunning(); } catch (e) { return false; } },
        start: async (log) => {
            dedicatedDns.setConfig({ enabled: true });
            const r = await require('./auto-connect').ensureProxy(log, XRAY.socks);
            if (!r.ok) throw new Error(r.message || 'کانفیگی برای بالا آوردن پیدا نشد.');
            return { alreadyRunning: !!r.alreadyRunning };
        },
        stop: async () => { try { await require('./xray-manager').stopXray(); } catch (e) { /* already down */ } },
    },
    lantern: {
        label: 'لنترن',
        split: true,
        autoStart: true,
        socks: () => (lantern.getStatus().connected ? lantern.SOCKS_PORT : null),
        live: () => { try { return !!lantern.getStatus().connected; } catch (e) { return false; } },
        start: async (log) => {
            const before = lantern.isRunning();
            await lantern.startLantern({}, log, (stx) => frontBroadcastStatus('lantern', stx));
            return { alreadyRunning: before };
        },
        stop: async () => { try { lantern.stopLantern(); } catch (e) { /* already down */ } },
    },
    gateway: {
        label: 'گیت‌وی MLM',
        split: false,
        // NOT auto-started for a measurement. Connecting it hands the machine's default route to the
        // relay, which would take the network out from under every other engine being measured in
        // the same pass — and out from under whatever the user is doing. It is started only when
        // they ask for it by name.
        autoStart: false,
        socks: () => null,
        live: () => { try { return !!gateway.getStatus().connected; } catch (e) { return false; } },
        start: async (log) => {
            if (gateway.getStatus().connected) return { alreadyRunning: true };
            const list = gateway.servers();
            const rows = (list.rows || []);
            if (!rows.length) throw new Error('فهرست سروری ندارد — یک بار از پنجرهٔ گیت‌وی فهرست را بگیرید.');
            // The official relays answered when the advertised-fast ones did not, so the reachable
            // ones are measured and the quickest of those is taken.
            const sample = rows.filter(r => r.official).concat(rows.filter(r => !r.official)).slice(0, 24);
            const map = await gateway.measure(sample, { concurrency: 12, timeoutMs: 4000 });
            // `measure` answers with a Map of host -> milliseconds, and 0 means it never answered.
            const alive = sample
                .map(r => ({ row: r, ms: map.get(r.host) || 0 }))
                .filter(x => x.ms > 0)
                .sort((a, b) => a.ms - b.ms);
            if (!alive.length) throw new Error('هیچ رله‌ای از این خط جواب نداد.');
            await gateway.connect({ host: alive[0].row.host }, log, () => { });
            return { alreadyRunning: false, host: alive[0].row.host, ms: alive[0].ms };
        },
        stop: async () => { try { await gateway.disconnect(); } catch (e) { /* already down */ } },
    },
};

app.get('/api/sanction/status', (req, res) => {
    try {
        const cfg = sanction.getConfig();
        res.json({
            config: cfg,
            engines: Object.entries(SANCTION_ENGINES).map(([id, e]) => ({
                id, label: e.label, split: e.split, live: e.live(), socks: e.socks(),
            })),
            services: sanction.listServices().map(s => ({ name: s.name, domains: s.domains, tier: s.tier, vpnDetect: s.vpnDetect })),
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Save the chosen applications, sites and engine. Changing them does not turn anything on. */
app.post('/api/sanction/config', (req, res) => {
    const b = req.body || {};
    const patch = {};
    if (Array.isArray(b.apps)) patch.apps = b.apps.map(String).filter(Boolean).slice(0, 200);
    if (Array.isArray(b.sites)) patch.sites = b.sites.map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 200);
    if (typeof b.engine === 'string' || b.engine === null) patch.engine = b.engine || null;
    try { res.json({ ok: true, config: sanction.setConfig(patch) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Measure every live engine against every named site, and stream the results.
 *
 * Streaming rather than one answer at the end, for the same reason the Iran-config tester streams:
 * a site can take eight seconds to refuse you, and a user watching a list fill in knows the thing is
 * working, while a user watching a spinner does not.
 *
 * An engine that is not running is reported as such and NOT started — starting three engines to
 * answer a question is a decision the user has not made yet.
 */
app.post('/api/sanction/check', async (req, res) => {
    const sites = (Array.isArray(req.body && req.body.sites) ? req.body.sites : sanction.getConfig().sites)
        .map(x => String(x).trim().toLowerCase()).filter(Boolean).slice(0, 60);
    if (!sites.length) return res.json({ results: [], done: true });

    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });
    const write = (o) => { try { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); } catch (e) { /* client gone */ } };

    const startedHere = [];
    try {
        // BRING UP WHAT IS NOT UP. Reporting «خاموش است — خودتان روشنش کنید» is not a measurement,
        // it is homework; a window whose job is to choose between engines has to be able to run them.
        for (const [id, e] of Object.entries(SANCTION_ENGINES)) {
            if (aborted || !e.autoStart || e.live()) continue;
            write({ starting: id, label: e.label });
            try {
                const r = await e.start((l) => broadcast('core_log', l));
                if (!r || !r.alreadyRunning) startedHere.push(id);
            } catch (err) {
                write({ engineError: id, label: e.label, error: err.message });
            }
        }

        const engines = Object.entries(SANCTION_ENGINES)
            .map(([id, e]) => ({ id, label: e.label, split: e.split, socks: e.socks(), live: e.live() }));
        write({ engines: engines.map(e => ({ id: e.id, label: e.label, split: e.split, live: e.live })) });

        // ── First half: everything with a port of its own, all at once ──────────────────────
        const seen = {};
        for (const site of sites) {
            if (aborted) break;
            const direct = await sanction.testDirect(site);
            const via = {};
            // In parallel: the engines are separate processes on separate ports and one slow site
            // should not add up across them.
            await Promise.all(engines.map(async (e) => {
                if (!e.socks) { via[e.id] = { ok: false, state: e.split ? 'offline' : 'pending' }; return; }
                via[e.id] = await sanction.testVia(site, e.socks);
            }));
            seen[site] = { direct, via };
            write({ site, direct, via });
        }

        // ── Second half: the gateway, alone ─────────────────────────────────────────────────
        //
        // Started only now, with the others already measured and the ones this sweep started already
        // stopped — because it takes the machine's default route and would have measured them all
        // through itself. And with the route through it, a DIRECT probe is a probe through it.
        const gw = SANCTION_ENGINES.gateway;
        if (!aborted && sites.length) {
            const wasLive = gw.live();
            let startedGw = false;
            try {
                if (!wasLive) {
                    write({ starting: 'gateway', label: gw.label });
                    await gw.start((l) => broadcast('core_log', l));
                    startedGw = true;
                }
                for (const site of sites) {
                    if (aborted) break;
                    const r = await sanction.testDirect(site);
                    const ok = r.state === 'open' || r.state === 'open_listed';
                    const row = seen[site] || { direct: r, via: {} };
                    row.via.gateway = { ok, state: ok ? 'open' : r.state, ms: r.ms };
                    write({ site, direct: row.direct, via: row.via });
                }
            } catch (err) {
                write({ engineError: 'gateway', label: gw.label, error: err.message });
            } finally {
                if (startedGw) { try { await gw.stop(); } catch (e) { /* already down */ } }
            }
        }
        if (!res.writableEnded) { write({ done: true }); res.end(); }
    } catch (e) {
        write({ fatal: true, error: e.message });
        if (!res.writableEnded) res.end();
    } finally {
        // Only what this measurement started. An engine the user had running is left alone — the
        // sweep must not be able to disconnect somebody mid-download.
        for (const id of startedHere) {
            try { await SANCTION_ENGINES[id].stop(); } catch (e) { /* already down */ }
        }
    }
});

/**
 * Start or stop ONE engine, from this window.
 *
 * The panel used to answer «از پنجرهٔ خودش وصل شوید», which is a window telling the user to use a
 * different window to do the thing this one is for.
 */
app.post('/api/sanction/engine', async (req, res) => {
    const { id, on } = req.body || {};
    const e = SANCTION_ENGINES[id];
    if (!e) return res.status(400).json({ error: 'چنین موتوری نیست.' });
    try {
        if (on === false) { await e.stop(); return res.json({ ok: true, live: e.live() }); }
        const r = await e.start((l) => broadcast('core_log', l));
        res.json({ ok: true, live: e.live(), alreadyRunning: !!(r && r.alreadyRunning), host: r && r.host });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Start carrying the chosen applications and sites through the chosen engine.
 *
 * The split is built here rather than read from «مسیر برنامه‌ها» in Settings, because the two are
 * different lists for different reasons and a user who set one should not find the other changed.
 *
 * `force` is the «بدون سنجش» path: turn the engine on without measuring anything first. Measuring
 * is advice, not a gate — a user who already knows which engine works should not have to wait for
 * the app to agree with them.
 */
app.post('/api/sanction/enable', async (req, res) => {
    const b = req.body || {};
    const cfg = sanction.setConfig({
        engine: b.engine || sanction.getConfig().engine,
        ...(Array.isArray(b.apps) ? { apps: b.apps.map(String).filter(Boolean) } : {}),
        ...(Array.isArray(b.sites) ? { sites: b.sites.map(x => String(x).trim().toLowerCase()).filter(Boolean) } : {}),
    });
    const def = SANCTION_ENGINES[cfg.engine];
    if (!def) return res.status(400).json({ error: 'اول یک موتور انتخاب کنید.' });

    try {
        // ── The whole-machine engine. It has no proxy port: it takes an address from the relay's
        //    own DHCP and, with it, the default route. So there is no split to build — it is on or
        //    it is off, and the panel says so before the user picks it.
        if (!def.split) {
            if (!def.live()) await def.start(tunBroadcastLog);
            if (!def.live()) return res.status(409).json({ error: `${def.label} بالا نیامد.`, code: 'ENGINE_OFF' });
            sanction.setConfig({ enabled: true });
            return res.json({ ok: true, engine: cfg.engine, whole: true, message: `${def.label} روشن است — کل ترافیک سیستم از آن رد می‌شود.` });
        }

        // Start it rather than refuse. This is the window that chooses the engine; it owns
        // running one too.
        if (!def.socks()) await def.start(tunBroadcastLog);
        const socks = def.socks();
        if (!socks) {
            return res.status(409).json({ error: `${def.label} بالا نیامد.`, code: 'ENGINE_OFF' });
        }
        if (!cfg.apps.length && !cfg.sites.length) {
            return res.status(400).json({ error: 'هیچ برنامه یا سایتی انتخاب نشده — چیزی برای رد کردن نیست.' });
        }

        // `allow` with `final: direct` IS the split: the listed executables go to the engine and
        // everything else leaves the way it always did.
        const exes = cfg.apps.map(a => String(a).toLowerCase()).filter(a => /\.exe$/.test(a));
        const match = require('./app-routing').exeMatcher(exes);
        const appRouting = {
            mode: 'allow', match, exes, count: exes.length,
            rules: exes.length ? [Object.assign({}, match, { outbound: cfg.engine })] : [],
            final: 'direct',
        };

        await withTunLock('sanction-on', async () => {
            if (readSystemProxy().enabled) {
                await require('./xray-manager').enableSystemProxy(false, XRAY.http);
                tunBroadcastLog('[تحریم‌شکن] پراکسی سیستم خاموش شد (با تونل قابل جمع نیست).');
                broadcast('system_proxy', Object.assign(readSystemProxy(), { port: XRAY.http }));
            }
            await tun.startTun(socks, tunBroadcastLog, Object.assign(frontTunOptions(cfg.engine === 'lantern' ? 'lantern' : 'psiphon'), {
                engineTag: cfg.engine,
                engineLabel: def.label,
                processName: cfg.engine === 'lantern' ? ['lantern.exe'] : ['xray.exe'],
                hijackEngineDns: cfg.engine === 'lantern',
                apiSuffixes: cfg.engine === 'lantern' ? LANTERN_DNS_SUFFIXES : [],
                appRouting,
                engineDomains: cfg.sites,
            }));
        });

        sanction.setConfig({ enabled: true });
        broadcast('tun', { running: true, wanted: true, engine: cfg.engine });
        try { require('./system-settings').rememberConnection({ kind: 'sanction', opts: { engine: cfg.engine }, tun: true }); } catch (e) { /* nothing kept */ }
        res.json({
            ok: true, engine: cfg.engine, whole: false,
            apps: exes.length, sites: cfg.sites.length,
            message: `${exes.length} برنامه و ${cfg.sites.length} سایت از ${def.label} رد می‌شوند؛ بقیهٔ ترافیک مستقیم.`,
        });

        tun.tunVerdict(tunBroadcastLog, {}).catch(() => { /* advisory */ });
    } catch (err) {
        try { await tun.stopTunAsync(tunBroadcastLog, 'sanction-buster start failed'); } catch (e) { /* nothing up */ }
        tunBroadcastLog(`[تحریم‌شکن] ❌ ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sanction/disable', async (req, res) => {
    try {
        const cfg = sanction.getConfig();
        const def = SANCTION_ENGINES[cfg.engine];
        // The whole-machine engine was never started by this feature, so it is not stopped by it
        // either: switching «تحریم‌شکن» off must not disconnect a gateway the user turned on
        // themselves from its own window.
        if (def && def.split && tun.isRunning()) {
            await withTunLock('sanction-off', async () => {
                await tun.stopTunAsync(tunBroadcastLog, 'sanction-buster off');
                await tun.verifyTornDown(tunBroadcastLog);
            });
            broadcast('tun', { running: false, wanted: false });
        }
        sanction.setConfig({ enabled: false });
        try { require('./system-settings').forgetConnection('sanction'); } catch (e) { /* none */ }
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** One site, reached directly — kept because it is the cheapest useful answer. */
app.post('/api/sanction/test', async (req, res) => {
    const { domain } = req.body || {};
    if (!domain) return res.status(400).json({ error: 'نام سایت لازم است' });
    try { res.json(await sanction.testDirect(String(domain).trim().toLowerCase())); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Dedicated DNS (Cloudflare DoH worker: anti-filter + region steering) -----
app.get('/api/dedidns/status', (req, res) => {
    try {
        res.json({
            config: dedicatedDns.getConfig(),
            // Per-mode, so the panel can show one mode as ready and the other as not
            // deployed instead of collapsing both into a single yes/no.
            configured: dedicatedDns.isConfigured(),
            configuredEcs: dedicatedDns.isConfigured('ecs'),
            configuredDoh: dedicatedDns.isConfigured('doh'),
            regions: dedicatedDns.ALL_REGIONS,
            dohGroups: dedicatedDns.DOH_GROUPS
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Deploy a DNS worker to the user's Cloudflare (credentials from the cloud module).
// `mode` selects which worker: 'ecs' (region steering) or 'doh' (speed/ping). Each mode
// stores its own URL, so deploying the second one leaves the first still usable.
app.post('/api/dedidns/deploy', async (req, res) => {
    const { token, email, region = 'AE', mode = 'ecs', dohGroup = 'standard' } = req.body;
    if (!token) return res.status(400).json({ error: 'token کلادفلر لازم است' });
    const workerMode = mode === 'doh' ? 'doh' : 'ecs';
    try {
        // Re-deploying reuses this mode's existing script name, so pressing the button
        // twice updates one worker instead of littering the account with new ones.
        const existingName = dedicatedDns.workerNameFor(workerMode);

        // The deploy narrates itself — subdomain, KV namespace, binding, upload, the anti-DPI
        // rename — and that narration used to be dropped on the floor, so the button sat silent for
        // fifteen seconds with nothing to look at.
        const result = await cloudManager.deployDnsWorker(token, email, region,
            (line) => { try { broadcast('sanction_log', { line: String(line) }); } catch (e) { /* no page */ } },
            { mode: workerMode, dohGroup, workerName: existingName || undefined });
        if (!result.success) return res.status(500).json({ error: result.message });

        const patch = workerMode === 'doh'
            ? { dohWorkerUrl: result.url, dohWorkerName: result.workerName, dohGroup, mode: 'doh', enabled: true }
            : { workerUrl: result.url, workerName: result.workerName, region, mode: 'ecs', enabled: true };
        res.json({
            ok: true, url: result.url, mode: workerMode,
            pending: !!result.pending, message: result.message,
            config: dedicatedDns.setConfig(patch),
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save settings (enable/disable, region, or a manually-entered worker URL).
//
// The setting lives in the GENERATED Xray config, so saving it alone changes nothing on
// a live connection: switching off used to leave the running tunnel still resolving
// through the worker, which read as "the off switch does nothing". Re-apply immediately
// whenever a tunnel is up, and tell the client whether that happened so the UI can say
// so instead of guessing.
app.post('/api/dedidns/config', async (req, res) => {
    const { enabled, region, workerUrl, mode, dohWorkerUrl, dohGroup } = req.body;
    try {
        const patch = {};
        if (typeof enabled === 'boolean') patch.enabled = enabled;
        if (region) patch.region = region;
        if (typeof workerUrl === 'string') patch.workerUrl = workerUrl;
        if (typeof dohWorkerUrl === 'string') patch.dohWorkerUrl = dohWorkerUrl;
        if (mode) patch.mode = mode;
        if (dohGroup) patch.dohGroup = dohGroup;
        if (typeof req.body.smartTunnel === 'boolean') patch.smartTunnel = req.body.smartTunnel;
        if (req.body.smartFallback) patch.smartFallback = req.body.smartFallback === 'tunnel' ? 'tunnel' : 'direct';
        if (req.body.routeOverrides) patch.routeOverrides = req.body.routeOverrides;
        const config = dedicatedDns.setConfig(patch);

        // A running system-wide bridge holds the OLD worker URL. Switching mode without
        // this leaves the whole machine still resolving through the worker the user just
        // switched away from.
        try { await dedicatedDns.refreshSystemWide(); }
        catch (e) { console.error('dedidns bridge refresh failed:', e); }

        let applied = false;
        try {
            applied = await restartXray((log) => {
                wss.clients.forEach(c => {
                    if (c.readyState === 1) c.send(JSON.stringify({ type: 'core_log', data: log }));
                });
            });
        } catch (e) {
            // The setting is saved either way; a failed re-apply must not look like a
            // failed save, or the user flips the switch again and again.
            console.error('dedidns re-apply failed:', e);
        }

        res.json({ ok: true, config, applied });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- fragment+fingerprint (جایگزین SNI-Spoofing برای کانفیگ‌های کلودفلر) ------
// پیش‌فرض روشن است و خودکار روی مقصدهای کلودفلری اعمال می‌شود؛ این دو مسیر فقط برای
// دیدن وضعیت و خاموش کردن دستی در زمان عیب‌یابی هستند.
app.get('/api/tlsfp/status', (req, res) => {
    try {
        res.json({
            config: tlsFingerprint.getConfig(),
            fingerprint: tlsFingerprint.FINGERPRINT,
            cipherSuites: tlsFingerprint.CIPHER_SUITES,
            finalMask: tlsFingerprint.FINAL_MASK,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tlsfp/config', async (req, res) => {
    try {
        const patch = {};
        if (typeof req.body.enabled === 'boolean') patch.enabled = req.body.enabled;
        if (req.body.mode) patch.mode = req.body.mode;
        const config = tlsFingerprint.setConfig(patch);

        // مثل dedidns: تنظیم داخل کانفیگِ تولیدشده است، پس بدون بازسازیِ اتصال زنده
        // کلید خاموش/روشن هیچ اثری ندارد.
        let applied = false;
        try {
            applied = await restartXray((log) => {
                wss.clients.forEach(c => {
                    if (c.readyState === 1) c.send(JSON.stringify({ type: 'core_log', data: log }));
                });
            });
        } catch (e) { console.error('tlsfp re-apply failed:', e); }

        res.json({ ok: true, config, applied });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- System-wide bridge: 127.0.0.1:53 -> the worker over DoH ------------------
// This is the part that makes the dedicated DNS apply to the WHOLE machine (browser,
// games, everything) instead of only to traffic already inside the Xray tunnel.
app.get('/api/dedidns/system/status', (req, res) => {
    try { res.json(dedicatedDns.systemWideStatus()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Live health of both deployed workers. A saved URL is not proof one exists.
/**
 * Is the deployed worker current?
 *
 * Asked of the worker itself rather than remembered here: it lives on the user's own account and
 * outlives app updates, so anything this side wrote down could be describing a script that has since
 * been replaced, deleted or deployed from another machine.
 */
app.get('/api/dedidns/version', async (req, res) => {
    try {
        const c = dedicatedDns.getConfig();
        const out = {};
        for (const mode of ['ecs', 'doh']) {
            const url = dedicatedDns.workerUrlFor(mode, c);
            out[mode] = url ? Object.assign({ url }, await dedicatedDns.workerVersion(url)) : { url: null, ok: false, reason: 'no-url' };
        }
        res.json({ shipped: dedicatedDns.SHIPPED_WORKER_VERSION, workers: out });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** Remove the worker from the user's Cloudflare account, and forget its URL here. */
app.post('/api/dedidns/remove', async (req, res) => {
    const { token, email, mode = 'ecs' } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token کلادفلر لازم است' });
    const m = mode === 'doh' ? 'doh' : 'ecs';
    try {
        const name = dedicatedDns.workerNameFor(m);
        if (!name) return res.status(400).json({ error: 'Worker ای برای حذف ثبت نشده است.' });
        const r = await cloudManager.deleteWorker(token, email, name);
        if (!r.success) return res.status(500).json({ error: r.message });
        // Forget it here too, or the panel goes on offering a URL that answers nothing.
        const patch = m === 'doh'
            ? { dohWorkerUrl: '', dohWorkerName: '' }
            : { workerUrl: '', workerName: '' };
        res.json({ ok: true, message: r.message, config: dedicatedDns.setConfig(patch) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/dedidns/workers', async (req, res) => {
    try { res.json(await dedicatedDns.checkWorkers()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dedidns/system/enable', async (req, res) => {
    // This can auto-connect a proxy, which takes seconds and prints a trace. Forward that
    // to the core-log channel the UI already shows, so the wait is legible instead of
    // looking like a hang.
    const onLog = (line) => {
        if (typeof line !== 'string') return;
        wss.clients.forEach(c => {
            if (c.readyState === 1) c.send(JSON.stringify({ type: 'core_log', data: line }));
        });
    };
    try { res.json(await dedicatedDns.enableSystemWide(onLog)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dedidns/system/disable', async (req, res) => {
    try { res.json(await dedicatedDns.disableSystemWide()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Resolve one name THROUGH the bridge and report whether the answer was poisoned. This is
// the only honest way to answer "is it actually working?" — a green switch is not proof.
app.post('/api/dedidns/system/test', async (req, res) => {
    const { domain } = req.body || {};
    try { res.json(await dedicatedDns.testSystemWide(domain || 'www.youtube.com')); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Learned route cache -----------------------------------------------------
// Each domain is classified once (Iranian / DNS-poisoned / filtered / sanctioned / clean)
// and the verdict is reused, so routing does not re-measure what it already knows.
app.get('/api/dedidns/routes', (req, res) => {
    try {
        const routeCache = require('./route-cache');
        res.json({
            stats: routeCache.stats(),
            learned: routeCache.byVerdict(),
            active: require('./tun-routes').resolveRoutes(dedicatedDns.getConfig().routeOverrides || {}),
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Classify one or more domains now. Answers from cache unless `force` is set: the point of
// the cache is that this measurement does not get repeated.
app.post('/api/dedidns/classify', async (req, res) => {
    const { domain, domains, force } = req.body || {};
    try {
        const routeCache = require('./route-cache');
        const tunRoutes = require('./tun-routes');
        const cfg = dedicatedDns.getConfig();
        const opts = { dohUrl: dedicatedDns.workerUrlFor(cfg.mode, cfg), iranDomains: tunRoutes.IRAN_DOMAINS };
        const list = Array.isArray(domains) ? domains : [domain];
        if (!list.length || !list[0]) return res.status(400).json({ error: 'domain لازم است' });

        const out = [];
        for (const d of list) {
            const cached = force ? { verdict: 'unknown' } : routeCache.get(d);
            if (cached.verdict !== 'unknown') out.push({ ...cached, cached: true });
            else out.push({ ...(await routeCache.classify(d, opts)), cached: false });
        }
        res.json({ results: out });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/dedidns/routes/forget', (req, res) => {
    const { domain, all } = req.body || {};
    try {
        const routeCache = require('./route-cache');
        if (all) { routeCache.clear(); return res.json({ ok: true, cleared: true }); }
        res.json({ ok: routeCache.remove(domain) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Lookup-latency test for a mode: cold vs warm (edge-cached) resolve time.
app.post('/api/dedidns/measure', async (req, res) => {
    const { mode, domains } = req.body || {};
    try { res.json(await dedicatedDns.measureWorker(mode, Array.isArray(domains) && domains.length ? domains : undefined)); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Optional: race regions to find the lowest-ping one for given test endpoints.
app.post('/api/dedidns/race', async (req, res) => {
    const { endpoints, port } = req.body;
    if (!Array.isArray(endpoints) || !endpoints.length) return res.status(400).json({ error: 'endpoints array required' });
    try { res.json({ results: await dedicatedDns.raceRegions(endpoints, port || 443) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// API: Aether engine (MASQUE / WireGuard / WARP-in-WARP)
// ============================================================
// The engine is core/aether.exe, driven by aether-manager.js. Every log line it emits is
// forwarded to the same `core_log` websocket channel Xray uses, so the existing core-log
// panel shows the full step-by-step trace. Stage changes go out as `aether_status`.

// Batch log lines into one frame per tick. A separate JSON.stringify + send per line, per
// client, is enough work during a scan to fill the engine's stdout pipe and stall it, so the
// coalescing here is load-bearing, not just tidiness.
let aetherLogQueue = [];
let aetherLogTimer = null;

function aetherFlushLogs() {
    aetherLogTimer = null;
    if (!aetherLogQueue.length) return;
    const batch = aetherLogQueue;
    aetherLogQueue = [];
    const msg = JSON.stringify({ type: 'core_log', data: batch.join('\n') });
    wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

function aetherBroadcastLog(line) {
    aetherLogQueue.push(line);
    // Hard cap: if the UI can't keep up, drop the oldest rather than growing without bound.
    if (aetherLogQueue.length > 500) aetherLogQueue.splice(0, aetherLogQueue.length - 500);
    if (!aetherLogTimer) aetherLogTimer = setTimeout(aetherFlushLogs, 120);
}

/**
 * One line in the tunnel diary (~/.mlmvpn/tunnel-events.log), which SURVIVES restarts.
 *
 * The orchestrator's decisions — every teardown, every rebuild, every verdict and the reason
 * behind it — used to exist only in the UI's log panel, which is memory. So «مدام قطع و وصل
 * می‌شود» could never be reconstructed afterwards: by the time it was reported, the evidence had
 * been closed with the window. Cheap enough to call from any path: one appendFileSync of one
 * short line, and it swallows its own errors.
 */
function tunEvent(kind, fields, note) {
    try { require('./tun-diag').event(kind, fields, note); } catch (e) { /* no diary, same tunnel */ }
}

/** sing-box's log level for a tunnel: `warn` normally, `info` when the user asks for detail. */
function tunLogLevel() {
    try { return require('./network-settings').tunLogLevel(); } catch (e) { return 'warn'; }
}

// Guards the auto-start below: status events repeat, and each one must not respawn Xray.
let aetherFrontendStarted = false;

// Tracks the DNS bridge lifecycle so a disconnect tears down exactly what a connect set
// up, and a second connect does not double-apply.
let aetherDnsBridgeStarted = false;

// The DNS bridge and the whole-system tunnel are TWO COMPLETE, MUTUALLY EXCLUSIVE ways of
// closing the DNS leak. Running both is not belt-and-braces — it is a broken tunnel.
//
// WHAT WAS MEASURED. With TUN up and traffic flowing normally through it:
//
//     11:27:19-26  dns: exchanged A www.google.com ... / outbound/socks[aether]: ...
//     11:27:31     [WARP] ✅ DNS سیستم به تونل متصل شد (127.0.0.1 + ::1:53)
//     11:27:31+    nothing. no lookups, no connections, until the user gave up.
//
// Traffic stopped at the exact second the bridge repointed Windows at loopback, in two
// separate runs. The Wi-Fi indicator drops to "no internet" because NlaSvc's probe can no
// longer resolve, and to the user the whole machine looks offline.
//
// WHY. When TUN is up, sing-box's `hijack-dns` rule already captures every DNS packet that
// enters the adapter and resolves it inside the tunnel — that is what closes the leak, and
// it is why the full-tunnel config has a `remote` server detoured through the engine.
// Pointing Windows at 127.0.0.1 instead sends every lookup to LOOPBACK, which by definition
// never enters the TUN, so sing-box never sees it. The queries then go through a
// single-threaded Node relay that opens a fresh SOCKS connection per lookup, over a gateway
// measured at 1.76s RTT — while sing-box's own resolver, with its cache, sits unused.
//
// So: the bridge exists for the proxy-only mode, where Windows would genuinely resolve in
// cleartext. Under TUN it is redundant AND harmful. The two are now exclusive, exactly like
// TUN and the system proxy already are.
//
// Restoring Windows' resolvers while TUN is up is safe, and it is not a leak: the ISP
// resolver becomes just another destination address, and every packet aimed at it is
// hijacked by sing-box and answered from inside the tunnel.
// The in-flight START, for the same reason the teardown has one — and for a worse failure.
//
// MEASURED, 2026-08-17, WireGuard protocol, this is the whole outage:
//
//     13:52:08  [TUN] تونل متوقف شد            <- tunnel off, bridge start begins
//     13:52:15  [TUN] بررسی عبور واقعی دیتا…    <- user turns the tunnel back on
//     13:52:20  [TUN] ✅ آداپتور «MLMVPN» ساخته شد و مسیر پیش‌فرض روی آن است
//     13:52:28  [WARP] ✅ DNS سیستم به تونل متصل شد (127.0.0.1 + ::1:53)   <- 8s LATE
//
// The entry guard below is checked once and then the function spends five to fifteen seconds
// in `await`s (starting the listener, a live test lookup, snapshotting every adapter, and an
// elevated Set-DnsClientServerAddress). If the tunnel comes up inside that window, the guard
// has already passed and the bridge repoints Windows at loopback ON TOP of a live TUN — the
// exact combination documented above as a machine with no internet. The tunnel's own
// `stopAetherDnsBridge()` could not prevent it either: `aetherDnsBridgeStarted` is only set on
// the last line, so at 13:52:15 the stop saw `false` and returned immediately, and the start
// it was supposed to cancel finished thirteen seconds later.
//
// Why it looked like a WireGuard-only bug: with a cached endpoint the WireGuard connect takes
// under a second, so the auto-start bridge is still mid-flight when the user reaches for the
// tunnel switch. A MASQUE or WARP-in-WARP connect spends far longer scanning, so the bridge is
// long finished — and properly torn down — before the switch is ever touched.
let aetherDnsBridgeStarting = null;

function startAetherDnsBridge() {
    if (aetherDnsBridgeStarted) return Promise.resolve();
    if (aetherDnsBridgeStarting) return aetherDnsBridgeStarting;
    aetherDnsBridgeStarting = doStartAetherDnsBridge()
        .finally(() => { aetherDnsBridgeStarting = null; });
    return aetherDnsBridgeStarting;
}

// Re-checked after every await, not just at the door. Returns true when the tunnel has taken
// over in the meantime and this start must abandon what it was doing.
function tunTookOverDns() {
    return tun.isRunning() || aetherTunWanted;
}

async function doStartAetherDnsBridge() {
    if (tunTookOverDns()) {
        aetherBroadcastLog('[WARP] تونل کامل روشن است؛ DNS از خود تونل حل می‌شود و سرویس DNS محلی لازم نیست.');
        return;
    }
    // Whichever engine is up — aether's, or «وارپ»'s own on its own port. Pointing the bridge
    // at a port nobody is listening on is a machine with no DNS at all.
    const dnsSrc = aetherLikeActive();
    if (!dnsSrc) return;
    try {
        await aetherDnsBridge.start(dnsSrc.port);
        await aetherDnsBridge.testResolve('www.google.com', dnsSrc.port);

        // Checkpoint one. Nothing machine-wide has been touched yet, so backing out here is
        // free: stop the listener and leave Windows exactly as the tunnel set it up.
        if (tunTookOverDns()) {
            await aetherDnsBridge.stop();
            aetherBroadcastLog('[WARP] تونل کامل وسط راه‌اندازی DNS محلی بالا آمد — DNS به خود تونل واگذار شد.');
            return;
        }

        // Photograph the resolvers as they are RIGHT NOW, before overwriting them, so
        // switching the feature off restores what the user actually had rather than a
        // months-old record.
        const dnsManager = require('./dns-manager');
        await dnsManager.snapshotCurrent(path.join(os.homedir(), '.mlmvpn', 'dns-before-aether.json'));

        // Both address families or the leak stays open: Windows prefers the IPv6 resolver
        // list on a dual-stack connection, and leaving that pointing at the ISP is what made
        // the leak tests still report an Iranian resolver with the tunnel up.
        const listen6 = aetherDnsBridge.LISTEN_ADDR6;
        const targets = listen6
            ? [aetherDnsBridge.LISTEN_ADDR, listen6]
            : [aetherDnsBridge.LISTEN_ADDR];

        // Record that we are about to point Windows at a resolver that only exists while we
        // do — BEFORE the change, never after. Written after, a crash in between is exactly
        // the case with no record and no way back, and the observed result of that is a
        // machine whose every lookup fails until someone resets the adapter by hand.
        aetherGuard.armDns(path.join(os.homedir(), '.mlmvpn', 'dns-before-aether.json'));

        // Checkpoint two, immediately before the only irreversible step. The snapshot above
        // takes seconds of elevated PowerShell — plenty of room for the tunnel to come up.
        if (tunTookOverDns()) {
            aetherGuard.disarmDns();
            await aetherDnsBridge.stop();
            aetherBroadcastLog('[WARP] تونل کامل بالا آمد — DNS ویندوز دست‌نخورده ماند و از خود تونل حل می‌شود.');
            return;
        }

        const applied = await dnsManager.applyServers(targets, 'وارپ (تونل)');
        if (!applied.ok) {
            aetherGuard.disarmDns();
            // Print WHY, not just THAT.
            //
            // The elevated helper records a per-adapter reason ("fail4 Wi-Fi 3: <error>"),
            // but runElevated deletes the script and its log as soon as it finishes — so
            // the old message told the user to "check the log" for a file that no longer
            // exists, and a reported DNS leak had nothing to diagnose it with. The reason
            // is already in hand here; put it where the user can read it.
            if (applied.log) {
                String(applied.log).split(/\r?\n/).map(s => s.trim()).filter(Boolean)
                    .forEach(line => aetherBroadcastLog(`[WARP]    ↳ ${line}`));
            }
            if (applied.missed && applied.missed.length) {
                aetherBroadcastLog(`[WARP]    ↳ آداپتورهایی که تغییر نکردند: ${applied.missed.join('، ')}`);
            }
            await aetherDnsBridge.stop();
            throw new Error(applied.message || 'تنظیم DNS ویندوز انجام نشد.');
        }

        aetherDnsBridgeStarted = true;
        // Checkpoint three: the change is already on the machine, so this one has to undo it
        // rather than skip it. `aetherDnsBridgeStarted` is set first on purpose — the teardown
        // refuses to run without it, and refusing here is what leaves loopback resolvers
        // pointing at a listener the next stop will kill.
        if (tunTookOverDns()) {
            aetherBroadcastLog('[WARP] تونل کامل همزمان بالا آمد — DNS محلی بلافاصله پس گرفته شد.');
            await doStopAetherDnsBridge();
            return;
        }
        aetherBroadcastLog(`[WARP] ✅ DNS سیستم به تونل متصل شد (${targets.join(' + ')}:53)`);
        if (!listen6) {
            aetherBroadcastLog('[WARP] ⚠️ سرویس DNS روی IPv6 بالا نیامد؛ اگر شبکه‌ی شما IPv6 دارد،');
            aetherBroadcastLog('[WARP]    ممکن است بخشی از درخواست‌های DNS از مسیر IPv6 نشت کند.');
        }
    } catch (e) {
        aetherBroadcastLog(`[WARP] ⚠️ سرویس DNS محلی روشن نشد: ${e.message.split('\n')[0]}`);
        aetherBroadcastLog('[WARP] بدون آن، ویندوز و برنامه‌های غیرپراکسی همچنان از DNS قبلی استفاده می‌کنند.');
    }
}

// The in-flight teardown, so a second caller AWAITS the first instead of returning
// immediately on a flag that has already been cleared.
//
// This is not a nicety. aetherTearDownAfterDisconnect() calls this without awaiting, and the
// stop handler then awaits it again to guarantee Windows is restored before replying. With a
// bare boolean guard the second call sees `started === false`, returns at once, and the
// handler answers "restored" while the restore is still running — exactly the bug the await
// was added to fix, reintroduced one line lower down.
let aetherDnsBridgeStopping = null;

function stopAetherDnsBridge() {
    if (aetherDnsBridgeStopping) return aetherDnsBridgeStopping;
    // A start that has not finished yet is the dangerous one: it holds no flag, so the plain
    // `started` test below would return "nothing to stop" and let it go on to repoint Windows
    // at loopback seconds after the tunnel came up. Wait for it, then tear down whatever it
    // managed to leave behind. (The start's own checkpoints usually back out first — this is
    // what makes the caller's `await` mean the machine is really settled.)
    if (aetherDnsBridgeStarting) {
        aetherDnsBridgeStopping = aetherDnsBridgeStarting
            .catch(() => {})
            .then(() => (aetherDnsBridgeStarted ? doStopAetherDnsBridge() : undefined))
            .finally(() => { aetherDnsBridgeStopping = null; });
        return aetherDnsBridgeStopping;
    }
    if (!aetherDnsBridgeStarted) return Promise.resolve();
    aetherDnsBridgeStopping = doStopAetherDnsBridge().finally(() => { aetherDnsBridgeStopping = null; });
    return aetherDnsBridgeStopping;
}

async function doStopAetherDnsBridge() {
    aetherDnsBridgeStarted = false;

    // Windows is restored FIRST: stopping the listener while the adapters still point at
    // 127.0.0.1 would leave the machine with no working resolver at all.
    let restored = null;
    try {
        const dnsManager = require('./dns-manager');
        restored = await dnsManager.restoreSnapshot(path.join(os.homedir(), '.mlmvpn', 'dns-before-aether.json'));
    } catch (e) { /* handled by the guarantee below */ }

    // restoreSnapshot already sweeps any adapter left on 127.x, but if the whole call
    // failed (elevation refused, script error) the machine may still be pointing at a
    // resolver that is about to stop existing. Never leave that state behind quietly.
    if (!restored || restored.stillLoopback) {
        try { await require('./dns-manager').applyServers(['1.1.1.1', '1.0.0.1'], 'کلادفلر'); }
        catch (_) { /* nothing further we can do without elevation */ }
    }

    aetherGuard.disarmDns();
    await aetherDnsBridge.stop();
    aetherBroadcastLog('[WARP] DNS سیستم به حالت قبل برگشت.');
}

// A disconnect is not acted on the instant it is reported.
//
// The engine reconnects on its own, and a re-handshake takes a second or two — during which it
// logs stages that are not 'connected', so `state.connected` goes false and comes back. Acting
// immediately meant every one of those blips tore down TUN and the front-end Xray for good:
// the user had a working full-system tunnel one moment and normal routing the next, with no
// way back except reconnecting by hand. That is the "قطع و وصلی" behaviour.
//
// Waiting costs nothing that is not already lost: while Aether is down no traffic moves either
// way, so the only thing the delay changes is whether a tunnel that recovers gets to keep
// running. If it is still down when the timer fires, the teardown happens exactly as before
// and the machine gets its normal routing back.
// 6000 was measured against the wrong thing. The engine's OWN reconnect budget is, from
// aether-src/aether/src/lib.rs:723-776:
//
//     tunnel closed -> sleep reconnect_delay (2s default)
//                   -> quick_verify last known-good gateway
//                   -> on failure: hunt_masque_peer  (scan 'balanced' = up to 120s)
//                   -> handshake -> data-plane validation (up to 10s)
//                   -> "socks5 server listening"
//
// So a perfectly normal recovery takes anywhere from ~3 seconds to over two minutes. A
// 6-second grace fires in the middle of almost all of them, tears the whole stack down, and
// then the engine reconnects into a machine that is no longer tunnelled — green badge,
// traffic on the physical interface. That single mismatch is the mechanism behind "the
// tunnel loses the internet a few minutes after connecting" and "it says Connected but
// nothing goes through".
//
// The fix is not simply a bigger number: with the kill switch holding traffic closed, waiting
// is now SAFE, so the grace can cover a real rescan instead of racing it.
const AETHER_DISCONNECT_GRACE_MS = 150000;

// How long the kill switch may hold the machine closed before we give up and hand the user
// their internet back with a plain warning. The user chose fail-closed WITH automatic
// recovery, and this is the "automatic recovery" half: no leak, and no permanent dead end.
const AETHER_FAILCLOSED_MAX_MS = 180000;

let aetherDisconnectTimer = null;

// Has this session ever reached 'connected'? A tunnel that has not come up yet cannot have
// dropped, and treating startup as a disconnect is what made the app switch the user's system
// proxy off behind their back.
let aetherWasConnected = false;

// Did the USER ask for whole-system tunnelling? Distinct from "is TUN running right now",
// which is a fact about the machine. Without this distinction there is no way to tell a
// tunnel the user switched off from one that fell over — and so no way to know whether it
// should be brought back. That gap is why TUN never returned after a blip: the DNS bridge
// and the front-end Xray restart on reconnect, and TUN was simply forgotten.
let aetherTunWanted = false;
let aetherTunOptions = {};

// When the kill switch was engaged, so recovery can be given up on before the user concludes
// the app broke their PC.
let aetherFailClosedSince = 0;

function aetherCancelDisconnectGrace() {
    if (aetherDisconnectTimer) {
        clearTimeout(aetherDisconnectTimer);
        aetherDisconnectTimer = null;
    }
    // The session is over; the next one starts from "never connected" again.
    aetherWasConnected = false;
}

/**
 * Hold the machine closed while the engine tries to come back.
 *
 * This is the half of the design that makes a long grace period safe. Previously the only
 * way to avoid leaking during a reconnect was to tear the tunnel down fast, which is itself
 * the leak (traffic resumes on the physical interface). With the guard engaged, waiting costs
 * the user connectivity they had already lost, and costs them no anonymity at all.
 */
async function aetherEngageFailClosed(reason) {
    if (aetherGuard.getStatus().killSwitch) return;
    if (!aetherTunWanted) return;   // proxy-only mode never took the machine's route

    const exeDir = path.join(
        __dirname.toLowerCase().includes('.asar') ? __dirname.replace(/\.asar/gi, '.asar.unpacked') : __dirname,
        'core');
    const corePaths = require('./core-paths');
    const r = await aetherGuard.engageKillSwitch({
        adapterAlias: tun.TUN_IFACE_NAME,
        allowPrograms: [
            // The engine MUST keep reaching the Cloudflare edge or it can never reconnect and
            // the guard becomes a permanent outage rather than a temporary one.
            //
            // EVERY copy it might be running from, not just the one the next start would pick: an
            // engine that was already up when «ام‌ال‌ام استور» activated a new version is still
            // executing the old file, and allowing only the new path would lock the live tunnel out
            // of the internet — fail-closed turned into a permanent outage.
            ...corePaths.candidates('warp', 'aether.exe', path.join(exeDir, 'aether.exe')),
            // sing-box owns the socket for everything the routing rules send `direct`,
            // including the engine's own uplink when the process lookup is refused.
            ...corePaths.candidates('singbox', 'sing-box.exe', path.join(exeDir, 'sing-box.exe')),
            // And us: without the control plane a dropped tunnel is unrecoverable without
            // the user disabling the guard by hand, which they cannot look up how to do.
            process.execPath,
        ],
        onLog: aetherBroadcastLog,
    });

    if (r.ok) {
        aetherFailClosedSince = Date.now();
        aetherBroadcastLog(`[WARP] 🔒 ترافیک تا بازگشت تونل بسته شد (${reason}).`);
        broadcast('aether_guard', { killSwitch: true, reason });
    } else {
        // Say so plainly. A kill switch that silently did not engage is worse than none,
        // because the user believes they are protected.
        aetherBroadcastLog(`[WARP] ⚠️ محافظ نشت روشن نشد (${r.reason}) — تا بازگشت تونل ممکن است ترافیک با آی‌پی واقعی خارج شود.`);
        broadcast('aether_guard', { killSwitch: false, reason: r.reason });
    }
}

async function aetherReleaseFailClosed(why) {
    if (!aetherGuard.getStatus().killSwitch) return;
    await aetherGuard.releaseKillSwitch(aetherBroadcastLog);
    aetherFailClosedSince = 0;
    aetherBroadcastLog(`[WARP] 🔓 ترافیک آزاد شد (${why}).`);
    broadcast('aether_guard', { killSwitch: false, reason: why });
}

// Everything that used to run inline the moment `connected` went false. Unchanged in what it
// does — only in when it runs. Safe to call twice: every step is guarded by its own state.
async function aetherTearDownAfterDisconnect({ userInitiated = false } = {}) {
    // TUN holds the machine's default route. With Aether gone every packet is handed to a
    // SOCKS port with nothing behind it and the machine is offline with no way for the user to
    // find out why — they cannot even load a page to look it up. Dropping the tunnel restores
    // normal routing immediately.
    //
    // Note what this teardown now means: it only runs after the grace period has expired AND
    // the kill switch has already been released, or because the user asked to disconnect. It
    // is the give-up path, no longer the response to every momentary blip.
    if (tun.isRunning()) {
        // Say which of the two it is. A user who pressed «قطع» and reads «the connection never came
        // back» has been told their deliberate action was a failure.
        aetherBroadcastLog(userInitiated
            ? '[TUN] موتور به درخواست شما قطع شد — تونل کامل هم با آن خاموش شد تا اینترنت برگردد.'
            : '[TUN] ⚠️ اتصال وارپ برنگشت — تونل برای بازگشت اینترنت خاموش شد.');
        // stopTunAsync, not stopTun: this is the disconnect CLICK, and the synchronous one is
        // two 5-second execSync taskkills around an Atomics.wait nap — all of it on Electron's
        // main thread, with the window frozen for the duration.
        try { await tun.stopTunAsync(aetherBroadcastLog, userInitiated ? 'user stopped the engine' : 'warp engine never came back'); }
        catch (e) { aetherBroadcastLog('[TUN] ⚠️ خاموش‌کردن تونل: ' + String(e.message || e).split(/\r?\n/)[0]); }
        // Assumed-clean teardown is how a machine ends up with no default route and no
        // explanation. Check, and repair if the check fails — AWAITED, so «disconnected» is a
        // statement about the machine and not about our intention.
        await tun.verifyTornDown(aetherBroadcastLog).catch(() => {});
        broadcast('tun', { running: false, wanted: aetherTunWanted && !userInitiated });
    }
    if (userInitiated) aetherTunWanted = false;

    // The front-end Xray we started has nowhere to send traffic. Leaving it up with the system
    // proxy on is the "internet is dead and nothing says why" state.
    //
    // BOTH flags, because either engine may have raised that front: `aetherFrontendStarted` for
    // aether, `warpFrontendStarted` for «وارپ». Only the first was cleared here, so stopping وارپ
    // left an Xray listening on the system proxy's port with a dead SOCKS behind it — every
    // program that honours the Windows proxy (which is most of them) simply stopped connecting.
    if (aetherFrontendStarted || warpFrontendStarted) {
        aetherFrontendStarted = false;
        warpFrontendStarted = false;
        const xray = require('./xray-manager');
        if (xray.isRunning() && !xray.getCurrentUri()) {
            // ASYNC, because this sits on the disconnect CLICK and server.js runs in Electron's
            // main thread. `stopXray()` is a 5-second execSync taskkill plus three synchronous
            // `reg add` spawns — the window stops painting for all of it, which is the freeze
            // the V2Ray disconnect had. Same order, same end state, nothing blocked.
            await xray.stopXrayAsync();
            aetherBroadcastLog('[WARP] تونل قطع شد؛ پراکسی محلی و پراکسی سیستم هم خاموش شدند.');
            broadcast('system_proxy', Object.assign(readSystemProxy(), { port: XRAY.http }));
        }
    }

    // Restore the machine's resolvers before the bridge stops answering, or Windows is left
    // pointing at a dead 127.0.0.1 and the internet looks broken.
    stopAetherDnsBridge();

    // A running Xray keeps the config it started with, so its outbounds now point at a dead
    // SOCKS port and traffic stops. New configs degrade to direct on their own
    // (getChainOutbound returns null), but the live one can't — say so plainly.
    if (aether.getChainToXray() && require('./xray-manager').isRunning()) {
        aetherBroadcastLog('[WARP] ⚠️ تونل وارپ قطع شد در حالی که Xray از آن استفاده می‌کرد.');
        aetherBroadcastLog('[WARP] تا اتصال مجدد، ترافیک Xray رد نمی‌شود. Xray را قطع و وصل کنید تا مستقیم برود.');
    }
}

// Bring the whole-system tunnel back after it was lost to something other than the user
// switching it off. Serialised through `aetherRearmInFlight` because the status event that
// triggers it repeats, and two concurrent startTun calls would fight over the same adapter.
// A tunnel that cannot be rebuilt must be GIVEN UP ON, not retried forever.
//
// Without a bound the watchdog and this function fed each other: sing-box failed to start, the
// watchdog saw an unhealthy tunnel, engaged the kill switch and called the re-arm, which failed
// again — every five seconds, indefinitely. Observed in the field: the user switched the tunnel
// off, switched the ENGINE off, and the app kept rebuilding both behind them against a dead
// SOCKS port, taking the machine's connectivity with it. The only way out was killing the app.
//
// Three attempts rides out a transient (an adapter still being torn down, a gateway blip).
// Past that the failure is structural and retrying is just damage.
const AETHER_MAX_REARM_ATTEMPTS = 3;
let aetherRearmAttempts = 0;
let aetherRearmInFlight = false;

// When the last start finished. The watchdog must not judge a tunnel that is still settling:
// auto_route needs a moment to install the default route, and a verdict taken inside that
// window says "unhealthy" about a tunnel that is merely young.
let aetherTunSettledAt = 0;
const AETHER_SETTLE_MS = 8000;

async function aetherRearmTunIfWanted() {
    if (!aetherTunWanted || aetherRearmInFlight) return;
    // Only a tunnel that has been healthy for a while clears the failure budget. Resetting on
    // a bare isRunning() made the counter meaningless: every restart set it back to zero, so
    // "3 attempts" never accumulated and the loop below could run forever — which is exactly
    // what the field log shows, "تلاش ۱ از ۳" over and over.
    if (tun.isRunning()) {
        if (aetherTunSettledAt && Date.now() - aetherTunSettledAt > AETHER_SETTLE_MS) aetherRearmAttempts = 0;
        return;
    }
    // Whichever engine the tunnel was built on — not aether by assumption. With «وارپ» carrying
    // it this read false forever, so a tunnel that fell over under وارپ was never rebuilt.
    const carrying = aetherLikeActive();
    if (!carrying) return;
    if (aetherRearmAttempts >= AETHER_MAX_REARM_ATTEMPTS) return;

    aetherRearmInFlight = true;
    try {
      await withTunLock('tun-rearm', async () => {
        // Re-check under the lock. `aetherRearmInFlight` only excludes other re-arms; the
        // user's switch and the system-proxy toggle hold the lock too, and either of them may
        // have already fixed — or deliberately ended — the tunnel while this call was queued.
        if (!aetherTunWanted || tun.isRunning()) return;
        aetherRearmAttempts++;
        aetherBroadcastLog(`[TUN] تونل سیستمی برقرار نبود — تلاش ${aetherRearmAttempts} از ${AETHER_MAX_REARM_ATTEMPTS}…`);
        // Same ordering as the manual path, and for the same reason: the bridge must not be
        // competing for the SOCKS port while startTun probes it.
        // Unconditional for the same reason as the manual path: a start still in flight holds
        // no flag, and this is the path that runs right after a disconnect — precisely when
        // one is in flight, because the disconnect handler asked for the bridge back.
        await stopAetherDnsBridge();
        // A reconnect is exactly when the engine picks a DIFFERENT edge, so the /32 exclusion
        // from the previous start is stale. Rebuild it from the engine's current state.
        aetherTunOptions = Object.assign({}, aetherTunOptions, { uplinkIps: carrying.mgr.getUplinkIps() });
        await tun.startTun(carrying.port, aetherBroadcastLog, aetherTunOptions);
        aetherTunSettledAt = Date.now();
        broadcast('tun', { running: true, wanted: true });
        aetherBroadcastLog('[TUN] ✅ تونل سیستمی دوباره برقرار شد.');
        await aetherReleaseFailClosed('تونل سیستمی برگشت');
      });
    } catch (e) {
        aetherBroadcastLog(`[TUN] ❌ تلاش ${aetherRearmAttempts} ناموفق بود: ${e.message.split('\n')[0]}`);
        if (aetherRearmAttempts >= AETHER_MAX_REARM_ATTEMPTS) {
            // Give up and hand the machine back INTACT. Everything this subsystem owns comes
            // down: the watchdog, any half-built tunnel, and the kill switch.
            await withTunLock('tun-rearm-giveup', async () => {
                aetherTunWanted = false;
                aetherStopWatchdog();
                tun.stopTun(aetherBroadcastLog, 'gave up after 3 rebuild attempts');
                await tun.verifyTornDown(aetherBroadcastLog);
            });
            await aetherReleaseFailClosed('تونل بعد از چند تلاش بالا نیامد');
            aetherBroadcastLog('[TUN] ⛔ تونل سیستمی بالا نیامد و دیگر تلاش نمی‌شود. اینترنت شما آزاد است.');
            aetherBroadcastLog('[TUN] برای تلاش دوباره، کلید تونل را دستی روشن کنید.');
        }
        broadcast('tun', { running: false, wanted: aetherTunWanted });
    } finally {
        aetherRearmInFlight = false;
    }
}

/**
 * The engine changed edge while the tunnel was up — rebuild the tunnel around the new one.
 *
 * The /32 exclusion is written into sing-box's config at start, and sing-box does not reread
 * it. So an engine that migrates to a different Cloudflare edge (DPI throttling, a dead
 * gateway, a reconnect inside the grace window) leaves the tunnel excluding an address nobody
 * uses any more, while the address it DOES use is captured by auto_route and handed back to
 * the engine's own SOCKS port. Nothing reports an error: the process is alive, the adapter is
 * up, the default route is ours, so the watchdog calls it healthy — and every site hangs.
 * Restarting sing-box is the only way to install the new rule; the blip costs about a second
 * and the alternative is a tunnel that carries nothing.
 */
async function aetherRefreshTunUplink() {
    if (!aetherTunWanted || aetherRearmInFlight || !tun.isRunning()) return;
    // Ask the engine that is actually carrying the tunnel. Asking `aether` unconditionally was
    // worse than useless under «وارپ»: aether's data directory still holds endpoints from its
    // last session, so `added` came back non-empty from a STOPPED engine and this function
    // rebuilt the live tunnel around aether's dead SOCKS port.
    const carrying = aetherLikeActive();
    if (!carrying) return;
    const known = new Set(aetherTunOptions.uplinkIps || []);
    const fresh = carrying.mgr.getUplinkIps();
    const added = fresh.filter(ip => !known.has(ip));
    if (!added.length) return;

    aetherRearmInFlight = true;
    try {
      await withTunLock('tun-uplink-refresh', async () => {
        if (!aetherTunWanted || !tun.isRunning()) return;   // re-checked under the lock
        aetherBroadcastLog(`[TUN] موتور به اندپوینت تازه رفت (${added.join('، ')}) — تونل با قانون جدید بازسازی می‌شود.`);
        // Worth separating: an address inside the known ranges was never at risk, while one
        // outside them means the tunnel was carrying nothing until this very rebuild.
        const outside = tun.uncoveredUplinks(added);
        if (outside.length) {
            aetherBroadcastLog(`[TUN] ⚠️ این اندپوینت (${outside.join('، ')}) بیرون از محدوده‌های شناخته‌شده است؛ تا پیش از این بازسازی، ترافیک از تونل رد نمی‌شد.`);
        }
        aetherTunOptions = Object.assign({}, aetherTunOptions, { uplinkIps: fresh });
        tun.stopTun(aetherBroadcastLog, 'engine moved to a new edge');
        await tun.startTun(carrying.port, aetherBroadcastLog, aetherTunOptions);
        aetherTunSettledAt = Date.now();
        broadcast('tun', { running: true, wanted: true });
      });
    } catch (e) {
        aetherBroadcastLog(`[TUN] ❌ بازسازی تونل ناموفق بود: ${e.message.split('\n')[0]}`);
        // `wanted` stays set on purpose: recovery from here belongs to the watchdog's re-arm
        // path, which is the one place with an attempt budget to stop this looping forever.
        broadcast('tun', { running: false, wanted: true });
    } finally {
        aetherRearmInFlight = false;
    }
}

// ── watchdog ────────────────────────────────────────────────────────────────────────
// The only proof of life this stack had was a single log line ("socks5 server listening")
// and a 1500 ms sleep after starting sing-box. Nothing checked anything ever again, so every
// way a tunnel dies without saying so — process killed, adapter removed on resume, another
// VPN stealing the default route — produced a green UI over an untunnelled machine.
//
// This checks the three things that can independently fail, against Windows rather than
// against our own bookkeeping, and it reports what it finds instead of inferring.
const AETHER_WATCHDOG_MS = 5000;
let aetherWatchdogTimer = null;
let aetherLastVerdict = null;

// One tick at a time. The tick is async and now waits 1.5 s before believing a bad verdict, so
// on a slow machine a second tick can start while the first is still deciding — and both would
// then tear the same tunnel down.
let aetherWatchdogBusy = false;

function aetherStartWatchdog() {
    if (aetherWatchdogTimer) return;
    aetherWatchdogTimer = setInterval(async () => {
        if (aetherWatchdogBusy) return;
        aetherWatchdogBusy = true;
        try {
            if (!aetherTunWanted) return;

            // NEVER judge a tunnel that is being built, and never judge one that has just
            // been built.
            //
            // This is the bug behind the constant connect/disconnect in the field log:
            //
            //   03:29:19  sing-box started (0.63s)
            //   03:29:20  ✅ آداپتور «MLMVPN» ساخته شد … ✅ تونل سیستمی دوباره برقرار شد
            //   03:29:20  [TUN] تونل متوقف شد (خاتمه‌ی اجباری)      <- the watchdog
            //   03:29:20  [TUN] تونل سیستمی برقرار نبود — تلاش 1 از 3…
            //
            // The watchdog fired while startTun() was still inside waitForReady(), saw an
            // adapter that did not yet own the default route, called it unhealthy and killed
            // the very process the start was waiting on. Then it rebuilt it, and did the same
            // thing again — for as long as the user left the tunnel on, taking their
            // connectivity down with every cycle.
            // Same reason, wider net: `aetherRearmInFlight` covers only the re-arm, while the
            // user's switch, the system-proxy handover and the uplink refresh build tunnels
            // too. Any transition in flight means there is nothing here worth judging yet.
            if (aetherRearmInFlight || tunTransitionInProgress()) return;
            if (aetherTunSettledAt && Date.now() - aetherTunSettledAt < AETHER_SETTLE_MS) return;

            // The engine can move to another edge WITHOUT emitting a fresh "connected"
            // state — a quick reconnect, a re-handshake, or (in warp-in-warp) either of the
            // two tunnels being rebuilt under it. Event-driven refresh alone therefore
            // misses exactly the migrations that matter, and the result is a tunnel the
            // watchdog keeps calling healthy while it quietly swallows the engine's own
            // uplink. Polling here costs a set comparison per tick and returns immediately
            // when nothing moved.
            await aetherRefreshTunUplink().catch(() => {});

            let live = await tun.checkLive();

            // A PROBE THAT COULD NOT ASK IS NOT A TUNNEL THAT IS BROKEN.
            //
            // checkLive now says `unknown` when Windows would not answer — a PowerShell over its
            // timeout, WMI busy rebuilding the routing table, a spawn refused on a loaded
            // machine. That used to arrive here as `adapter-gone`, and this function's response
            // to that is to throw the kill switch and rebuild the tunnel. So one flaky probe
            // took the user's connection down, every five seconds, for as long as the machine
            // stayed busy — which is the «مدام قطع و وصل می‌شود» report, manufactured here.
            if (live.unknown) {
                tunEvent('watchdog-unknown', { defaultVia: live.defaultVia || '-' });
                return;
            }

            if (live.verdict !== aetherLastVerdict) {
                aetherLastVerdict = live.verdict;
                tunEvent('verdict', { verdict: live.verdict, via: live.via || '-', defaultVia: live.defaultVia || '-' });
                broadcast('tun', { running: live.healthy, wanted: aetherTunWanted, health: live });
            }
            if (live.healthy) return;

            // CONFIRM BEFORE DESTROYING. Everything below this line ends with the machine's
            // traffic stopped and the tunnel rebuilt, so a single bad reading is not enough:
            // the adapter genuinely blinks while Windows reconfigures (a resume, a Wi-Fi
            // roam, sing-box's own route install), and a rebuild costs more than the blink did.
            await new Promise(r => setTimeout(r, 1500));
            if (!aetherTunWanted || aetherRearmInFlight || tunTransitionInProgress()) return;
            const again = await tun.checkLive();
            if (again.unknown || again.healthy) {
                tunEvent('verdict-cleared', { first: live.verdict, then: again.verdict });
                aetherLastVerdict = again.verdict;
                if (again.healthy) broadcast('tun', { running: true, wanted: true, health: again });
                return;
            }
            live = again;

            // Report the distinct failures distinctly — the user asked for exactly this, and
            // the responses genuinely differ.
            const FA = {
                'process-dead': 'موتور تونل (sing-box) دیگر اجرا نیست',
                'adapter-gone': 'آداپتور تونل از سیستم حذف شده است',
                'adapter-down': 'آداپتور تونل هست ولی بالا نیست',
                'route-stolen': `مسیر پیش‌فرض از «${live.defaultVia || 'نامشخص'}» می‌رود، نه از تونل`,
            };
            aetherBroadcastLog(`[TUN] ⚠️ ${FA[live.verdict] || live.verdict} — ترافیک از تونل رد نمی‌شود.`);
            tunEvent('unhealthy', { verdict: live.verdict, defaultVia: live.defaultVia || '-' }, FA[live.verdict] || live.verdict);

            // AN ORPHANED TUNNEL IS NOT A LEAK — IT IS AN OUTAGE. Handle it before the guard.
            //
            // No engine is connected, no disconnect grace is counting down (so nothing is coming
            // back), and the tunnel is confirmed broken. There is nothing left to repair and
            // nothing left to protect: engaging the kill switch here would close a machine whose
            // traffic has nowhere to go anyway, and then release it 180 seconds later. Hand the
            // route back now and stop watching. This is the state the user was left in after
            // stopping «وارپ» with the tunnel on.
            if (!aetherLikeConnected() && !aetherDisconnectTimer) {
                aetherBroadcastLog('[TUN] موتوری زیر تونل نمانده — تونل برداشته شد تا اینترنت برگردد.');
                aetherTunWanted = false;
                aetherStopWatchdog();
                await aetherReleaseFailClosed('موتوری زیر تونل نمانده است');
                await withTunLock('watchdog-orphan', async () => {
                    tun.stopTun(aetherBroadcastLog, 'no engine left under the tunnel');
                    await tun.verifyTornDown(aetherBroadcastLog);
                });
                await stopAetherDnsBridge();
                broadcast('tun', { running: false, wanted: false });
                return;
            }

            // Close first, then repair. Doing it the other way round leaves a window in which
            // the machine is routing normally with the real IP, which is the leak itself.
            await aetherEngageFailClosed(FA[live.verdict] || live.verdict);

            if (aetherLikeConnected()) {
                // A dead sing-box over a live engine is directly repairable. The stop takes
                // the lock as well: stopping a tunnel someone else is mid-way through
                // building is the same collision as two starts.
                if (tun.isRunning()) await withTunLock('watchdog-stop', () => { tun.stopTun(aetherBroadcastLog, `watchdog: ${live.verdict}`); });
                await aetherRearmTunIfWanted();
            }

            // Never hold the machine closed forever. The user chose fail-closed WITH
            // automatic recovery; this is the deadline on the "automatic" part.
            if (aetherFailClosedSince && Date.now() - aetherFailClosedSince > AETHER_FAILCLOSED_MAX_MS) {
                await aetherReleaseFailClosed('بازیابی در مهلت مقرر انجام نشد');
                aetherBroadcastLog('[TUN] ⚠️ تونل بازنگشت؛ برای اینکه بدون اینترنت نمانید محافظ برداشته شد. از این لحظه ترافیک محافظت‌نشده است.');
                aetherTunWanted = false;
                broadcast('tun', { running: false, wanted: false });
            }
        } catch (e) { /* a failing watchdog must never take the server down */ }
        finally { aetherWatchdogBusy = false; }
    }, AETHER_WATCHDOG_MS);
    if (aetherWatchdogTimer.unref) aetherWatchdogTimer.unref();
}

function aetherStopWatchdog() {
    if (aetherWatchdogTimer) { clearInterval(aetherWatchdogTimer); aetherWatchdogTimer = null; }
    aetherLastVerdict = null;
}

// MEASUREMENT MODE — set while the «بازی» tournament is cycling Aether, and the reason it
// exists was found the hard way on the first live run.
//
// Starting Aether the normal way does three machine-wide things the moment it reports
// `connected`: it stands an Xray front-end up, it repoints WINDOWS' SYSTEM DNS at the local
// bridge, and — on the way back down — it treats the disconnect as "the tunnel dropped" and
// ENGAGES THE FAIL-CLOSED FIREWALL. All three are right for a user connecting a tunnel. All
// three are catastrophic for a measurement that starts and stops the engine six times in a
// row: the observed result was the whole machine losing DNS and then losing traffic
// entirely, while the panel cheerfully reported "no UDP" for every candidate.
//
// So a measurement start gets a status handler that reports status and does NOTHING else.
// The tunnel intent is untouched, the guard is never armed, and Windows' resolvers are never
// rewritten — which is what the tournament always claimed to do.
let aetherMeasurementMode = false;

function aetherMeasurementStatus(state) {
    // `measuring: true` IS THE WHOLE POINT OF THIS FUNCTION REACHING THE PANEL.
    //
    // The payload was previously identical to a real connect, so the Aether window could not tell
    // the two apart — and it asks «تونل کامل یا پراکسی سیستم؟» the moment it sees `connected` go
    // true. During a game tournament that is six Aether variants in a row, each raising a dialog
    // for a decision the user is not making: the race measures through SOCKS and deliberately
    // touches neither the route nor the proxy, so there is nothing to choose.
    //
    // A flag rather than silence, because the panel should still show the engine coming up and
    // going down — the user can watch the race happen. It is only the QUESTION that is wrong here.
    const tagged = Object.assign({}, state, { measuring: true });
    wss.clients.forEach(c => {
        if (c.readyState === 1) c.send(JSON.stringify({ type: 'aether_status', data: tagged }));
    });
}

/**
 * The tunnel's reaction to an engine going up or down — for WHICHEVER engine is under it.
 *
 * This was the tail of `aetherBroadcastStatus` and nothing else could reach it, so «وارپ» had
 * none of it: no grace period, no kill switch, no re-arm, and — the part the user felt — no
 * teardown. Stopping وارپ left sing-box owning the default route over a dead SOCKS port, which
 * is a machine with no internet and a lamp that says it is off.
 *
 * The state it keeps (`aetherWasConnected`, `aetherDisconnectTimer`, `aetherTunWanted`) is about
 * THE TUNNEL, not about aether, and the two engines are never up at once — so one copy is not
 * only enough, it is the only correct number.
 */
function engineTunnelLifecycle(connected) {
    if (connected) {
        aetherWasConnected = true;
        // Recovered inside the grace window — cancel the pending teardown and keep everything.
        if (aetherDisconnectTimer) {
            clearTimeout(aetherDisconnectTimer);
            aetherDisconnectTimer = null;
            aetherBroadcastLog('[WARP] اتصال قبل از پایان مهلت برگشت — تونل و پراکسی دست‌نخورده ماندند.');
        }
        // Traffic was held closed while the engine was away; let it go now that there is a
        // tunnel to carry it.
        aetherReleaseFailClosed('تونل برگشت').catch(() => {});
        // And put the whole-system tunnel back if the user asked for one and it is not up.
        // This is the asymmetry that used to leave a "Connected" badge over an untunnelled
        // machine: the DNS bridge and the front-end proxy came back on reconnect, TUN did not.
        aetherRearmTunIfWanted();
        // And if it IS up but the engine has since moved to another edge, rebuild it around
        // the new address — otherwise the tunnel keeps swallowing the engine's own uplink.
        aetherRefreshTunUplink().catch(() => {});
    } else if (!aetherWasConnected) {
        // Still coming up for the first time — there is nothing to tear down yet.
        //
        // This is not a detail. `connected` is false through the whole startup sequence, and a
        // gateway scan can run for 45-120 seconds. Arming the teardown here meant that six
        // seconds into any connect the timer fired and ran the full disconnect path — which
        // stops Xray, and stopXray() switches the Windows system proxy off. The user turned
        // the proxy on, and moments later the app turned it back off by itself.
    } else if (!aetherDisconnectTimer) {
        // The tunnel is gone and it had been up. Close the machine FIRST, then wait — the
        // waiting is only defensible because nothing can escape during it.
        aetherEngageFailClosed('تونل قطع شد').catch(() => {});
        aetherDisconnectTimer = setTimeout(() => {
            aetherDisconnectTimer = null;
            // Re-check rather than trusting the state captured when the timer was armed —
            // and re-check the ENGINE THE TUNNEL IS ON, which may be «وارپ».
            if (aetherLikeConnected()) return;
            // Give up: hand the internet back rather than leaving the user in a dead end they
            // have no way to diagnose. Order matters — release the guard BEFORE tearing the
            // tunnel down, or there is a moment with neither a tunnel nor a block.
            aetherReleaseFailClosed('تونل بعد از مهلت برنگشت')
                .catch(() => {})
                .then(() => {
                    aetherBroadcastLog('[WARP] ⚠️ تونل برنگشت. اینترنت آزاد شد و از این لحظه ترافیک شما با آی‌پی واقعی خارج می‌شود.');
                    return aetherTearDownAfterDisconnect();
                });
        }, Math.min(AETHER_DISCONNECT_GRACE_MS, AETHER_FAILCLOSED_MAX_MS));
    }
}

function aetherBroadcastStatus(state) {
    // A measurement session must never fall into the machine-wide side effects below, even
    // if some other path hands its status here.
    if (aetherMeasurementMode) return aetherMeasurementStatus(state);
    // Aether never touches the Windows proxy settings: it is a transport for Xray, and the
    // system proxy stays Xray's alone so the user can flip it at any time without disturbing
    // the tunnel.
    // Aether alone is a complete tunnel. Stand Xray up in front of it automatically so the
    // user never has to open the nodes tab or hand-build a SOCKS entry — the only thing left
    // for them to decide is whether Windows as a whole goes through it.
    if (state.connected && !aetherFrontendStarted) {
        const xray = require('./xray-manager');
        if (xray.isRunning() && xray.getCurrentUri()) {
            // A real node config is already live and chained; don't tear the user's session down.
            aetherBroadcastLog('[WARP] Xray با یک نود فعال است و از تونل وارپ خارج می‌شود.');
            aetherFrontendStarted = true;
        } else {
            aetherFrontendStarted = true;
            xray.startXrayAetherOnly(aether.SOCKS_PORT, false, aetherBroadcastLog)
                .then((info) => {
                    aetherBroadcastLog(`[WARP] ✅ پراکسی محلی آماده شد: SOCKS ${info.socks} / HTTP ${info.http}`);
                    aetherBroadcastLog('[WARP] حالا می‌توانید پراکسی سیستم را روشن کنید.');
                    broadcast('system_proxy', Object.assign(readSystemProxy(), { port: XRAY.http }));
                })
                .catch((e) => {
                    aetherFrontendStarted = false;
                    aetherBroadcastLog(`[WARP] ❌ راه‌اندازی پراکسی محلی ناموفق بود: ${e.message}`);
                });
        }

        // Close the system-wide DNS leak: Windows and non-proxy-aware apps keep resolving
        // via the ISP in cleartext even when the browser goes through the tunnel. The
        // bridge forwards every lookup through Aether's SOCKS5 port, so the answer comes
        // back from inside the tunnel.
        startAetherDnsBridge();
    }

    // When Aether goes away, the front-end Xray we started has nowhere to send traffic. Leaving
    // it up with the system proxy on is the "internet is dead and nothing says why" state, so
    // tear it down and drop the proxy with it.
    // TUN holds the machine's default route. If Aether dies while it is up, every packet is
    // handed to a SOCKS port with nothing behind it and the machine goes offline with no way
    // for the user to get back — they cannot even reach a website to look up why. Tearing the
    // tunnel down restores normal routing immediately.
    engineTunnelLifecycle(state.connected);

    wss.clients.forEach(c => {
        if (c.readyState === 1) c.send(JSON.stringify({ type: 'aether_status', data: state }));
    });
}

// ============================================================
// «سایفون» and «تور» — the two SOCKS-front engines
// ============================================================
//
// Both publish a local SOCKS5 listener and nothing else, so the shape is the same for both and
// deliberately simpler than the WARP routes: there is no identity to register, no gateway cache and
// no DNS bridge. Full-system coverage is the shared sing-box adapter with the engine's SOCKS port as
// its outbound, and the two differ in exactly two places, both of which matter:
//
//   * Psiphon's SOCKS is TCP-only, so DNS is resolved over TCP THROUGH the tunnel.
//   * Tor's is TCP-only too, but tor runs its own resolver on DNSPort. Queries go there on loopback
//     and tor resolves them inside the circuit. Naming a public resolver instead would send every
//     app's lookups outside the circuit in cleartext — exactly what someone turning Tor on is
//     trying to avoid.

/** One log line to the UI, tagged with the engine, and into the console. */
function frontBroadcastLog(line) {
    console.log(line);
    broadcast('front_log', { line });
}

function frontBroadcastStatus(engine, status) {
    broadcast('front_status', { engine, status });
}

/**
 * The TUN options for a SOCKS-front engine.
 *
 * @param engine   'psiphon' | 'tor'
 *
 * Every field here is load-bearing:
 *
 *  - `processName` is a LIST for Tor, because on a bridge rung it is `lyrebird.exe` and not
 *    `tor.exe` that makes the real outbound connection. Excluding only tor.exe would feed the
 *    transport's own traffic back into the tunnel it is building — a loop that presents as "the
 *    tunnel is up and nothing loads", not as an error.
 *  - `supportsUdp: false` on both. Neither core carries UDP over SOCKS, and a UDP DNS server
 *    reached through the tunnel would make every lookup fail while TCP browsing looked fine.
 *  - `uplinkCidrs: []` because neither engine has a fixed uplink range to exclude. The WARP
 *    default list is Cloudflare's and would exclude a slice of the ordinary web for no reason.
 *  - `apiSuffixes: []` — the WARP registration host means nothing to either of these.
 */
/**
 * The hostnames لنترن must be able to resolve before it can carry anything.
 *
 * Taken from flashlight's own `domains` list (common/httpclient.go) — the hosts it reaches through
 * kindling — plus the DoH resolver its DNSTT config names. Suffixes rather than exact names, because
 * the config service moves between subdomains (`df.iantem.io` is translated to
 * `nonexistent.iantem.io` for the akamai provider at request time).
 *
 * These are resolved off the tunnel and dialled off the tunnel. That costs no privacy that is not
 * already spent: the engine's own process is excluded from the tunnel anyway, so these connections
 * were always going to leave on the real interface — the only question was whether their NAMES
 * could be looked up at all.
 */
/**
 * The hostnames گف must be able to resolve off the tunnel.
 *
 * Unlike every other engine here, these are not its own servers — they are the sites it hides
 * BEHIND. Its broker is reached by domain fronting, so the names it actually looks up are
 * `kubernetes.io`, a CDN77 host, a Netlify host and an AWS Lambda endpoint; `geph.io` itself only
 * matters once the tunnel is up and the broker is reached through it.
 *
 * One of the four fronted paths carries `override_dns: 75.2.60.5:443` and needs no lookup at all —
 * upstream's own belt and braces against exactly this problem.
 */
const GEPH_DNS_SUFFIXES = [
    'kubernetes.io',          // the front for two of the four broker paths
    'netlify.app',            // the host behind it
    'cdn77.com', 'cdn77.org', // the third path
    'amazonaws.com',          // the Lambda bouncer
    'geph.io',                // broker.geph.io, once there is a tunnel to reach it through
];

const LANTERN_DNS_SUFFIXES = [
    'iantem.io',              // api./df./t. — config service and DNSTT
    'getiantem.org',          // api./geo./config./peerscanner.
    'flashlightproxy.com',    // globalconfig.
    'getlantern.org',         // update.
    'lantern.io',             // replica-r2./replica-search.
    // NOT cloudflare-dns.com, and that was a real mistake while it was here.
    //
    // Every name in this list is also sent DIRECT by the matching route rule — which is
    // right for the engine's own control plane, and wrong for a resolver that BROWSERS use.
    // Chrome and Edge do their own DNS over HTTPS, so listing it pushed the browser's
    // lookups out of the tunnel and onto a host this line blocks outright (measured: a plain
    // request to 1.1.1.1 does not connect at all). Every other app resolves through the
    // tunnel and was fine — which is exactly the shape of the report: «only the browser».
    // The engine's own DoH to that host is blocked here anyway, so it loses nothing.
];

/**
 * Does this engine's SOCKS port really carry UDP — asked, not assumed.
 *
 * ALL FOUR FRONTS WERE HARD-CODED TO `supportsUdp: false`, and for three of them that is right:
 * سایفون, لنترن and تور refuse a SOCKS5 UDP ASSOCIATE outright (تور architecturally always will).
 * گف does not — `geph5-client`'s own socks5.rs implements `SocksV5Command::UdpAssociate` with a
 * real UDP tunnel behind it, and the flag meant the tunnel refused a capability the engine had.
 *
 * What that costs when it is wrong: with UDP rejected the tunnel also rejects QUIC, so a browser
 * gives up on HTTP/3 and falls back to HTTP/2 over TCP, and nothing else that needs datagrams —
 * games, voice, WebRTC — works at all.
 *
 * So it is measured, per connect, on the engine that is actually running: one ASSOCIATE and one
 * real DNS datagram through it. Yes → the tunnel carries UDP and lets QUIC through. No → exactly
 * the old behaviour, and the browser falls back to HTTP/2 by itself. A probe that cannot answer
 * in six seconds counts as no, because an unproven capability must not be the one the machine's
 * whole route is built on.
 */
async function frontEngineCarriesUdp(engine, socksPort) {
    // تور is not worth the six seconds: its design forecloses UDP, not its build.
    if (engine === 'tor') return false;
    try {
        const ok = await tun.socksCarriesUdp(socksPort, { timeoutMs: 6000 });
        tunBroadcastLog(ok
            ? `[TUN] موتور UDP را حمل می‌کند — QUIC/HTTP3 باز می‌ماند.`
            : `[TUN] موتور UDP را حمل نمی‌کند — QUIC بسته می‌شود تا مرورگر بدون معطلی روی HTTP/2 برود.`);
        tunEvent('front-udp', { engine, port: socksPort, udp: ok });
        return ok;
    } catch (e) {
        tunEvent('front-udp', { engine, port: socksPort, udp: false, error: e.message });
        return false;
    }
}

function frontTunOptions(engine, udp) {
    const tor = engine === 'tor';
    // The engine's own process, kept out of the tunnel it is building. تور needs TWO names on a
    // bridge rung — it is `lyrebird.exe`, not `tor.exe`, that makes the outbound connection there,
    // and `conjure-client.exe` when Conjure is the chosen transport. Excluding only tor.exe would
    // feed the transport's own traffic back into the tunnel: a loop that presents as «the tunnel is
    // up and nothing loads».
    const exes = tor ? ['tor.exe', 'lyrebird.exe', 'conjure-client.exe']
        : engine === 'lantern' ? ['lantern.exe']
        : engine === 'geph' ? ['geph5-client.exe']
        : ['psiphon.exe'];
    return {
        processName: exes,
        engineTag: engine,
        engineLabel: FRONT_ENGINES[engine] ? FRONT_ENGINES[engine].label : engine,
        // Measured by [frontEngineCarriesUdp], not assumed. Callers that did not measure get the
        // old, safe answer.
        supportsUdp: !!udp,
        // The two move together: rejecting QUIC is what makes a browser fall back to HTTP/2 at
        // once instead of waiting out a UDP timeout on every connection. With real UDP behind
        // the tunnel there is nothing to fall back from.
        rejectQuic: !udp,
        uplinkCidrs: [],
        // NOT empty for لنترن. Its core resolves its own config and fronting hosts with the SYSTEM
        // resolver, and once this adapter owns DNS that resolver is the tunnel — which cannot
        // answer until the engine it is asking about is already working. Measured: 146 failed
        // lookups and not one connection through the engine. سایفون and تور build their own
        // resolver sockets outside the tunnel, so they need nothing here.
        apiSuffixes: engine === 'lantern' ? LANTERN_DNS_SUFFIXES
            : engine === 'geph' ? GEPH_DNS_SUFFIXES
            : [],
        // لنترن has no resolver of its own — it asks Windows, and on a poisoned line that
        // answers with the sinkhole for its own servers. سایفون and تور both carry their
        // own, so they keep the untouched ordering. See tun-manager's hijackEngineDns.
        // گف for the same reason as لنترن: it resolves its fronting hosts with the system resolver,
        // and once this adapter owns DNS that resolver is the tunnel — which cannot answer until the
        // engine it is being asked about is already working.
        hijackEngineDns: engine === 'lantern' || engine === 'geph',
        // Tor answers DNS itself, on loopback, from inside the circuit — no detour, because the
        // resolution happens in the circuit and not on the way to the resolver. Psiphon has no
        // resolver of its own, so its lookups go over TCP through the tunnel (`remote`'s default).
        // DNS OVER HTTPS, ON PORT 443 — not the default plain DNS on 53.
        //
        // Measured, with a healthy tunnel up: a lookup for a filtered name sent down the engine to
        // 1.1.1.1:53 came back as the sinkhole IN 9 MILLISECONDS. Nine milliseconds is not a round
        // trip to the exit — the engine does not proxy port 53 at all, so the query left in the
        // clear and was answered by the line that filters it. Every filtered name then resolved to
        // a sinkhole address while unfiltered ones resolved correctly, which is precisely the
        // «ordinary sites open, blocked ones do not» report.
        //
        // The same three names over DoH on 443 through the same engine, in the same minute:
        // youtube 142.251.157.4, instagram 57.144.62.34, x.com 172.66.0.227 — all correct. 443 is
        // the port these engines exist to carry, and DoH is inside TLS so it cannot be rewritten.
        //
        // تور keeps its own: it resolves inside the circuit, which is better than any of this.
        remoteDnsServer: tor
            ? { type: 'udp', tag: 'remote', server: '127.0.0.1', server_port: torEngine.DNS_PORT }
            // The literal ADDRESS, not `dns.google`: that name resolves to the sinkhole on this
            // line too (measured), so bootstrapping the resolver by name is the same trap one
            // level down. Google's certificate covers the bare address — verified here with no
            // SNI override at all — so there is nothing left to look up.
            : { type: 'https', tag: 'remote', server: '8.8.8.8', detour: engine },
        // `info` names every connection, its process and the outbound it was given, which is the
        // one thing that settles «تونل وصل است ولی چیزی رد نمی‌شود» — a connection dispatched to
        // the wrong outbound is not an error, so at `warn` a tunnel carrying nothing looks
        // exactly like a healthy one.
        //
        // AND IT IS NOT FREE, WHICH IS WHY IT IS NO LONGER ALWAYS ON. Measured on this machine
        // with nothing but a browser open: 4239 lines in 81 seconds, every one of them crossing
        // a pipe into Electron's MAIN thread, split, written to disk and broadcast to the UI.
        // Under real load it is thousands a minute — and sing-box writes its log synchronously
        // from the goroutine handling the connection, so when that thread is busy the engine
        // itself waits. The diagnosis was costing the tunnel the very throughput it was meant to
        // explain. Settings › تنظیمات پیشرفته VPN › «لاگ دقیق تونل» turns it back on for the run
        // that needs it.
        logLevel: tunLogLevel(),
    };
}

// ============================================================
// «گیت‌وی MLM» — the public SoftEther gateway network
// ============================================================
//
// Unlike the two engines below, this one does not publish a SOCKS port: the SoftEther client owns
// its own virtual adapter and routes the machine itself. So there is no `/tun` route here and
// nothing to hand to sing-box — the speed measured for that arrangement (4.29 Mbit/s against
// SSTP's 0.69 on the same relay) is the whole reason the engine is shaped this way.

app.get('/api/gateway/status', (req, res) => {
    try {
        const list = gateway.servers();
        res.json({
            status: gateway.getStatus(),
            list: {
                count: list.rows.length,
                official: list.rows.filter(r => r.official).length,
                source: list.source,     // 'updated' | 'bundled' | 'none'
                at: list.at,
            },
            // Whether a refresh can even be attempted right now, so the panel can say "turn a
            // tunnel on" instead of offering a button that will fail.
            canRefresh: gateway._internal.liveSocksPorts().length > 0,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gateway/servers', (req, res) => {
    try {
        const list = gateway.servers();
        // Sorted the way the panel shows them: the relays a censored line can actually reach
        // first, then by what they advertise. Measured, 8 of 8 of the fastest volunteer relays
        // were unreachable while every official one answered — so "official" is not a badge, it
        // is the single best predictor in the list.
        const rows = list.rows.slice().sort((a, b) =>
            (b.official - a.official) || (b.speedMbps - a.speedMbps));
        res.json({ rows, source: list.source, at: list.at });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/gateway/refresh', async (req, res) => {
    try {
        const out = await gateway.refreshServers(frontBroadcastLog);
        frontBroadcastStatus('gateway', gateway.getStatus());
        res.json(out);
    } catch (err) {
        frontBroadcastLog(`[گیت‌وی] ❌ ${err.message}`);
        res.status(502).json({ error: err.message });
    }
});

/**
 * Which of the offered relays this line can actually open TCP/443 to.
 *
 * The advertised megabits are the relay's own uplink and say nothing about reachability from a
 * censored line, so the panel ranks on this instead. The caller passes the hosts it is showing
 * rather than the whole list, because measuring 97 relays to display 20 is 77 wasted probes.
 */
app.post('/api/gateway/measure', async (req, res) => {
    // res, not req. A POST's request stream ends as soon as the body is read, so req's 'close'
    // fires at 0 ms and would cancel every sweep — see the V2Ray delay test.
    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });
    try {
        const want = Array.isArray(req.body && req.body.hosts) ? req.body.hosts : null;
        const all = gateway.servers().rows;
        const rows = want ? all.filter(r => want.includes(r.host)) : all;
        const map = await gateway.measure(rows);
        if (aborted) return;
        res.json({ pings: Object.fromEntries(map) });
    } catch (err) { if (!aborted) res.status(500).json({ error: err.message }); }
});

app.post('/api/gateway/connect', async (req, res) => {
    const o = req.body || {};
    if (!gateway.isInstalled()) {
        return res.status(409).json({
            error: 'کلاینت سافت‌اتر روی این سیستم نیست.',
            code: 'SOFTETHER_MISSING',
        });
    }
    try {
        // Remembered before the attempt, not after: a connect that fails still tells us which
        // relay the user meant, and the panel must come back showing it rather than resetting to
        // whatever happens to sort first.
        try { gateway.select(o.host); } catch (e) { /* the connect is what matters */ }
        const info = await gateway.connect(o, frontBroadcastLog, st => frontBroadcastStatus('gateway', st));
        try { require('./system-settings').rememberConnection({ kind: 'gateway', opts: o, tun: false }); } catch (e) { /* nothing to replay */ }
        res.json(Object.assign({ ok: true }, info));
    } catch (err) {
        res.status(502).json({ error: err.message });
    }
});

app.post('/api/gateway/disconnect', (req, res) => {
    try {
        const was = gateway.disconnect();
        frontBroadcastStatus('gateway', gateway.getStatus());
        try { require('./system-settings').forgetConnection('gateway'); } catch (e) { /* none kept */ }
        res.json({ ok: true, wasRunning: was });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/gateway/logs', (req, res) => res.json({ logs: gateway.getLogs() }));

/* ──────────────────────────────────────────────────────────────────────
   The gateway's two lists, the two tests, and the curation over them.
   Everything below is what the Android app has had since 2026-07 and this window did not.
   ────────────────────────────────────────────────────────────────── */

/**
 * «فهرست من», «آرشیو», and every measurement taken so far — in one call.
 *
 * One call because a single row needs all of it: which list it is in, whether the user kept it,
 * what its ping was and what the real test said. Three calls would render the list three times.
 */
app.get('/api/gateway/list', (req, res) => {
    try {
        const l = gateway.lists();
        res.json({
            mine: l.mine, archive: l.archive,
            kept: l.kept, hidden: l.hidden,
            pings: l.pings, probes: l.probes,
            selected: l.selected, udp: l.udp,
            // What to select when they have never chosen: the relay the real test proved, then
            // one that answered a ping, then VPN Gate's own score — never «the first row», which
            // on a list sorted by advertised megabits means «whatever Japan measured fastest».
            suggested: gateway.suggest(),
            source: l.source, at: l.at, fetchedAt: l.fetchedAt,
            status: gateway.getStatus(),
            canRefresh: gateway._internal.liveSocksPorts().length > 0,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * keep / drop / hide / purge / restore.
 *
 * `hide` is a deny-list and `purge` is a real deletion, and the difference is which list the user
 * was looking at — the panel says which, because only it knows. Deleting an archive row while
 * looking at «فهرست من» would leave the row on screen (it comes out of the live list) with its
 * test result gone, which looks like the delete silently failed.
 */
app.post('/api/gateway/curate', (req, res) => {
    const b = req.body || {};
    const hosts = Array.isArray(b.hosts) ? b.hosts : [];
    try {
        switch (String(b.action || '')) {
            case 'keep': return res.json({ ok: true, n: gateway.keep(hosts) });
            case 'drop': return res.json({ ok: true, n: gateway.drop(hosts) });
            case 'hide': return res.json({ ok: true, n: gateway.hide(hosts) });
            case 'purge': return res.json({ ok: true, n: gateway.purge(hosts) });
            case 'restore': return res.json({ ok: true, n: gateway.restoreHidden() });
            default: return res.status(400).json({ error: 'کار نامعتبر است.' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Start a sweep — and RETURN, without waiting for it.
 *
 * A real test over three hundred relays is minutes of work. Holding the response open for it
 * would be a request that times out in the browser while the work carries on invisibly, so the
 * progress goes out on the status broadcast the panel is already listening to and this answers
 * as soon as the sweep has started.
 */
app.post('/api/gateway/test', (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'probe' ? 'probe' : 'ping';
    const hosts = Array.isArray(b.hosts) ? b.hosts : [];
    if (gateway.sweepRunning()) return res.status(409).json({ error: 'یک تست در حال اجراست.' });
    if (!hosts.length) return res.status(400).json({ error: 'سروری برای تست نیست.' });

    const onStatus = (st) => frontBroadcastStatus('gateway', st);
    gateway.startSweep(kind, hosts, onStatus)
        .then((r) => {
            if (r && r.ok) {
                frontBroadcastLog(`[گیت‌وی] ${r.stopped ? 'تست متوقف شد' : 'تست تمام شد'} — ${r.done} از ${r.total} سرور.`);
            } else if (r && r.error) {
                frontBroadcastLog(`[گیت‌وی] ❌ ${r.error}`);
            }
        })
        .catch((e) => frontBroadcastLog(`[گیت‌وی] ❌ ${e.message}`));

    res.json({ ok: true, kind, total: hosts.length });
});

app.post('/api/gateway/test/cancel', (req, res) => {
    try { res.json({ ok: true, wasRunning: gateway.cancelSweep() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

/** The chosen relay, remembered across restarts so the connect button is never blank. */
app.post('/api/gateway/select', (req, res) => {
    try { res.json({ ok: true, selected: gateway.select((req.body || {}).host) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

/** «شتاب‌دهی UDP». Refused mid-session, because it only takes effect at connect. */
app.post('/api/gateway/udp', (req, res) => {
    try {
        const r = gateway.setUdp(!!(req.body || {}).on);
        if (!r.ok) return res.status(409).json(r);
        frontBroadcastStatus('gateway', gateway.getStatus());
        res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
});


// ============================================================
// «لنترن» — Lantern's core as a front
// ============================================================
//
// The thinnest of the three, because the core decides for itself: it fetches its proxy list through
// domain fronting, ranks the proxies on measured throughput and re-picks as they fail. So there is
// no ladder to expose and no country to choose — only the one lever that genuinely changes what
// happens (whether unblocked sites go direct) and the data-path proof every engine here needs.

// ── «ام‌ال‌ام استور» ──────────────────────────────────────
//
// Two rules shape every route here.
//
// `catalog` touches NO network: it reads what is on disk, what the last worker survey found, and
// what the signed channel already said. Opening the store must not wait on GitHub — on a blocked
// line that wait is the difference between a window that opens and one that hangs.
//
// Everything that DOES reach the network starts a job and returns immediately; the window polls
// /api/store/jobs. A core download runs for minutes on a filtered line, and this project has
// already been bitten by holding a request open for work like that (`req.on('close')` fires at 0 ms
// on a POST and cancelled a whole sweep).

app.get('/api/store/catalog', async (req, res) => {
    try {
        res.json(await store.catalogRows());
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.get('/api/store/jobs', (req, res) => res.json({ ok: true, jobs: store.jobs.all() }));

// «کانفیگ ایران» asks for its profile list here: the store's copy when one is installed, else null
// and the window uses the list that shipped with the app.
app.get('/api/iran/profiles', (req, res) => {
    const list = store.iranProfiles();
    res.json({ ok: true, profiles: list, source: list ? 'store' : 'shipped' });
});

app.post('/api/store/job/cancel', (req, res) => {
    const key = String((req.body && req.body.key) || '');
    res.json({ ok: store.jobs.cancel(key), key });
});

// The account survey: one read per worker script on every connected Cloudflare account. It runs on
// demand rather than on open, because it is the only part of the store that costs the user's own
// API allowance.
app.post('/api/store/workers/refresh', (req, res) => {
    res.json(Object.assign({ ok: true }, store.refreshWorkers()));
});

app.post('/api/store/core/update', (req, res) => {
    const id = String((req.body && req.body.id) || '');
    try {
        res.json(Object.assign({ ok: true }, store.updateCore(id, { force: !!(req.body && req.body.force) })));
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message, code: e.code || '' });
    }
});

// Data items («کانفیگ ایران»): the same shape as a core update, but what is installed is files
// the app rebuilds from the project's own sources — see store/iran-configs.js.
app.post('/api/store/data/update', (req, res) => {
    try { res.json(Object.assign({ ok: true }, store.updateData(req.body && req.body.id))); }
    catch (e) { res.status(400).json({ ok: false, error: e.message, code: e.code || '' }); }
});

app.post('/api/store/data/rollback', (req, res) => {
    try { res.json(Object.assign({ ok: true }, store.rollbackData(req.body && req.body.id))); }
    catch (e) { res.status(400).json({ ok: false, error: e.message, code: e.code || '' }); }
});

app.post('/api/store/core/rollback', (req, res) => {
    const id = String((req.body && req.body.id) || '');
    try {
        res.json(Object.assign({ ok: true }, store.rollbackCore(id)));
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// `expect` is the item the WINDOW thinks this script is. The backend classifies the script again
// from its own code and refuses if the two disagree — so a stale row can never send an update for
// one kind of panel into another.
app.post('/api/store/worker/update', (req, res) => {
    const { accountId, script, expect } = req.body || {};
    try {
        res.json(Object.assign({ ok: true }, store.updateWorker(String(accountId || ''), String(script || ''), expect || '')));
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.post('/api/store/worker/rollback', (req, res) => {
    const { accountId, script } = req.body || {};
    try {
        res.json(Object.assign({ ok: true }, store.rollbackWorker(String(accountId || ''), String(script || ''))));
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

app.post('/api/store/update-all', (req, res) => res.json(Object.assign({ ok: true }, store.updateAll())));

app.post('/api/store/channel/refresh', (req, res) => res.json(Object.assign({ ok: true }, store.refreshChannel())));

// «بررسی انتشارهای سازنده‌ها» — reads every tracked project's releases page. Returns at once; the
// window polls /api/store/jobs like every other long job.
app.post('/api/store/upstream/refresh', (req, res) => res.json(Object.assign({ ok: true }, store.refreshUpstreamAll())));

app.post('/api/store/upstream', (req, res) => {
    const id = String((req.body && req.body.id) || '');
    try {
        res.json(Object.assign({ ok: true }, store.upstream(id)));
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// The app itself, through the updater it already had.
app.post('/api/store/app/:action', async (req, res) => {
    const action = String(req.params.action || '');
    try {
        if (action === 'check') return res.json({ ok: true, status: await store.appUpdate.check() });
        if (action === 'download') return res.json({ ok: true, status: store.appUpdate.download() });
        if (action === 'install') return res.json({ ok: true, result: store.appUpdate.install() });
        res.status(400).json({ ok: false, error: 'عملیات شناخته نشد.' });
    } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
    }
});

// «کانفیگ آیپی ثابت» on Railway: the servers the user deployed, and a redeploy that rebuilds
// them from source. Listed here so the store is one list, driven by the module that owns them.
app.get('/api/store/vodi', (req, res) => {
    try {
        const gateways = require('./vodi').store.getGateways().map((g) => ({
            id: g.id, name: g.name, region: g.region, domain: g.domain,
            source: g.source || '', createdAt: g.createdAt,
        }));
        const d = require('./vodi').deployer;
        res.json({ ok: true, gateways, source: `repo:${d.VODI_REPO}@${d.VODI_BRANCH}` });
    } catch (e) {
        res.json({ ok: true, gateways: [], source: '', error: e.message });
    }
});

app.post('/api/store/vodi/redeploy', (req, res) => {
    const id = String((req.body && req.body.id) || '');
    const key = 'vodi:' + id;
    res.json(Object.assign({ ok: true }, store.jobs.start(key, { kind: 'vodi', title: id }, async (job) => {
        const deployer = require('./vodi').deployer;
        return deployer.redeployGateway(id, { onLog: (line) => store.jobs.log(job, line) });
    })));
});

app.get('/api/lantern/status', (req, res) => {
    try {
        res.json({
            installed: lantern.isInstalled(),
            status: lantern.getStatus(),
            socksPort: lantern.SOCKS_PORT,
            httpPort: lantern.HTTP_PORT,
            tun: tun.isRunning() && tun.currentEngine() === 'lantern.exe',
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/lantern/start', async (req, res) => {
    const o = req.body || {};
    if (!lantern.isInstalled()) return res.status(500).json({ error: 'فایل core/lantern.exe موجود نیست.' });
    try {
        // The manager proves the data path itself — with a real TLS handshake to a DNS-poisoned host,
        // because this core answers every SOCKS request "success" before it has dialled anything —
        // and when the proof is slow it keeps the engine up and keeps watching. So unlike the Psiphon
        // route there is no second check here: a `warning` in the result already means "up, still
        // looking", and the panel's poll will see it flip.
        const info = await lantern.startLantern(o, frontBroadcastLog, st => frontBroadcastStatus('lantern', st));
        try { require('./system-settings').rememberConnection({ kind: 'lantern', opts: o, tun: false }); } catch (e) { /* nothing to replay */ }
        frontGuardStart('lantern', o);
        res.json(Object.assign({ ok: true }, info));
    } catch (err) {
        frontBroadcastLog(`[لنترن] ❌ ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

/**
 * «یک دستهٔ سرور دیگر» — a blocked Lantern asks for a different draw.
 *
 * MEASURED 2026-09-14: with every assigned server unreachable (130.61.115.243, 132.145.28.165,
 * 158.101.197.155 — no TCP on any port, while oracle.com answered on the same line), clearing the
 * device identity produced a DIFFERENT three (51.170.181.235, 130.61.235.238, 140.238.102.119).
 * The assignment is per-device, so this is a real move rather than a placebo.
 *
 * It is not promised as a fix — that day BOTH sets were dead, because the block was wider than one
 * batch. It is for the common case: a partial block, where the pool has reachable servers and this
 * line simply drew the wrong three.
 *
 * The engine is stopped first: the files being removed are the ones it is holding open.
 */
app.post('/api/lantern/rotate', async (req, res) => {
    try {
        if (tun.isRunning() && tun.currentEngine() === 'lantern.exe') {
            return res.status(409).json({ error: 'اول تونل کامل لنترن را خاموش کنید.' });
        }
        const was = lantern.isRunning();
        if (was) lantern.stopLantern();
        await new Promise(r => setTimeout(r, 1200));

        const r = lantern.rotateIdentity();
        frontBroadcastLog(`[لنترن] شناسه پاک شد — دستهٔ سرور تازه‌ای گرفته می‌شود (قبلی: ${(r.before || []).join('، ') || 'نامشخص'})`);

        if (!was) {
            frontBroadcastStatus('lantern', lantern.getStatus());
            return res.json({ ok: true, restarted: false, before: r.before });
        }

        // It was running, so put it back up with the new identity and report what it drew.
        try {
            await lantern.startLantern({}, frontBroadcastLog, st => frontBroadcastStatus('lantern', st));
        } catch (err) {
            frontBroadcastLog(`[لنترن] ❌ ${err.message}`);
        }
        const after = lantern.assignedProxies();
        frontBroadcastLog(`[لنترن] دستهٔ تازه: ${after.join('، ') || 'چیزی گرفته نشد'}`);
        frontBroadcastStatus('lantern', lantern.getStatus());
        res.json({ ok: true, restarted: true, before: r.before, after, status: lantern.getStatus() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/lantern/stop', async (req, res) => {
    try {
        // The tunnel goes first, always — the same rule as the other two: killing the engine while
        // the adapter still points at its SOCKS port aims the default route at a dead listener.
        if (tun.isRunning() && tun.currentEngine() === 'lantern.exe') {
            await frontTunOwnDns(false);
            await withTunLock('lantern-tun-off', async () => {
                await tun.stopTunAsync(tunBroadcastLog, 'user switched the tunnel off');
                await tun.verifyTornDown(tunBroadcastLog);
            });
            broadcast('tun', { running: false, wanted: false });
        }
        const was = lantern.stopLantern();
        frontBroadcastStatus('lantern', lantern.getStatus());
        try { require('./system-settings').forgetConnection('lantern'); } catch (e) { /* none kept */ }
        frontGuardStop('lantern', 'user stopped the engine');
        res.json({ ok: true, wasRunning: was });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/lantern/logs', (req, res) => res.json({ logs: lantern.getLogs() }));

app.get('/api/psiphon/status', (req, res) => {
    try {
        res.json({
            installed: psiphon.isInstalled(),
            status: psiphon.getStatus(),
            socksPort: psiphon.SOCKS_PORT,
            httpPort: psiphon.HTTP_PORT,
            ladder: psiphon.LADDER.map(r => ({ name: r.name, label: r.label, seconds: Math.round(r.timeout / 1000) })),
            // What the whole ladder can cost, so the panel can say "up to N seconds" instead of
            // leaving the user to guess whether a two-minute connect is progress or a hang.
            ladderSeconds: psiphon.ladderBudgetSeconds(false),
            frontedRegions: psiphon.FRONTED_REGIONS,
            tun: tun.isRunning() && tun.currentEngine() === 'psiphon.exe',
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/psiphon/start', async (req, res) => {
    const o = req.body || {};
    const startedAt = Date.now();
    if (!psiphon.isInstalled()) return res.status(500).json({ error: 'فایل core/psiphon.exe موجود نیست.' });
    try {
        const info = await psiphon.startPsiphon(o, frontBroadcastLog, st => frontBroadcastStatus('psiphon', st));
        // Prove the data path — but DO NOT tear the engine down when the proof is slow.
        //
        // The core's "Tunnels count=1" is a claim about its own handshake, so the SOCKS port still
        // has to be asked. What changed is the consequence of a slow answer: this used to kill the
        // engine and report "the tunnel came up but carried nothing", and on a line where the
        // first request through a fronted CDN path legitimately takes twenty seconds that is
        // killing a working tunnel and telling the user it is broken. The budget is 25 s for the
        // same reason the Android delay test needed 25 s: measured, not guessed. If it still does
        // not answer, the engine stays up and the panel says the first request did not complete —
        // the user can try their browser, which is the only test that settles it.
        // The engine already proved the path on its way up: `measureTunnel` pulled half a
        // megabyte through this very port with four connections at once, and a number greater
        // than zero is that proof — stronger than the single GET this used to make, and already
        // paid for. The GET is kept only for the case where the measurement returned nothing,
        // where the distinction between "slow" and "dead" still has to be drawn.
        const measured = psiphon.getStatus().measuredMbit || 0;
        const carries = measured > 0 ? true : await psiphon.socksCarriesStream(25000);
        psiphon.recordDiagnostic('socks-probe', { carries, measuredMbit: measured, elapsedMs: Date.now() - startedAt });
        if (!psiphon.getStatus().connected || psiphon.getStatus().pid !== info.pid) {
            return res.status(409).json({ error: 'اتصال سایفون در زمان بررسی قطع یا لغو شد؛ وضعیت فعلی را بررسی کنید.' });
        }
        try { require('./system-settings').rememberConnection({ kind: 'psiphon', opts: o, tun: false }); } catch (e) { /* nothing to replay */ }
        frontGuardStart('psiphon', o);
        res.json(Object.assign({ ok: true, measuredMbit: measured }, info, carries ? {} : {
            warning: 'وصل شد، ولی اولین درخواست در ۲۵ ثانیه جواب نداد. موتور روشن ماند — مرورگر را امتحان کنید؛ اگر باز نشد یک بار قطع و وصل کنید.',
        }));
    } catch (err) {
        psiphon.recordDiagnostic('connect-failed', { error: err.message, elapsedMs: Date.now() - startedAt });
        frontBroadcastLog(`[سایفون] ❌ ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/psiphon/stop', async (req, res) => {
    const startedAt = Date.now();
    psiphon.recordDiagnostic('stop-request', { tun: tun.isRunning(), engine: tun.currentEngine() });
    try {
        // The tunnel goes first, always. Killing the engine while the adapter still points at its
        // SOCKS port leaves the default route aimed at a dead listener — the machine is offline
        // with no obvious cause and no way back except finding this panel again.
        // Queue behind a TUN start as well as an already-running adapter. A start spends several
        // seconds in preflight before `tun.isRunning()` becomes true; checking it before the lock
        // let this stop kill Psiphon and then allowed the queued start to create an orphan adapter.
        await withTunLock('psiphon-tun-off', async () => {
            if (tun.currentEngine() === 'psiphon.exe') {
                await frontTunOwnDns(false);
                await tun.stopTunAsync(tunBroadcastLog, 'user switched the tunnel off');
                await tun.verifyTornDown(tunBroadcastLog);
                broadcast('tun', { running: false, wanted: false });
            }
        });
        const was = psiphon.stopPsiphon();
        frontBroadcastStatus('psiphon', psiphon.getStatus());
        psiphon.recordDiagnostic('stop-complete', { elapsedMs: Date.now() - startedAt });
        try { require('./system-settings').forgetConnection('psiphon'); } catch (e) { /* none kept */ }
        frontGuardStop('psiphon', 'user stopped the engine');
        res.json({ ok: true, wasRunning: was });
    } catch (err) {
        psiphon.recordDiagnostic('stop-failed', { error: err.message, elapsedMs: Date.now() - startedAt });
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/psiphon/logs', (req, res) => res.json({ logs: psiphon.getLogs() }));

app.get('/api/psiphon/diagnostics', (req, res) => {
    const { readTail } = require('./psiphon-diagnostics');
    const dir = require('path').join(require('os').homedir(), '.mlmvpn');
    res.attachment('mlmvpn-psiphon-diagnostics.json').json({
        generatedAt: new Date().toISOString(), version: require('./package.json').version,
        psiphon: psiphon.getDiagnostics(),
        guard: (() => { try { return require('./front-guard').status(); } catch (e) { return null; } })(),
        tunnel: {
            running: tun.isRunning(), engine: tun.currentEngine(),
            events: readTail(require('path').join(dir, 'tunnel-events.log')),
            log: readTail(require('path').join(dir, 'tun.log')),
        },
    });
});

app.get('/api/tor/status', (req, res) => {
    try {
        res.json({
            installed: torEngine.isInstalled(),
            status: torEngine.getStatus(),
            socksPort: torEngine.SOCKS_PORT,
            httpPort: torEngine.HTTP_PORT,
            dnsPort: torEngine.DNS_PORT,
            modes: torEngine.MODES,
            regions: torEngine.regions(),
            tun: tun.isRunning() && tun.currentEngine() === 'tor.exe',
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/tor/start', async (req, res) => {
    const o = req.body || {};
    if (!torEngine.isInstalled()) return res.status(500).json({ error: 'فایل‌های تور در core/tor موجود نیست.' });
    try {
        const info = await torEngine.startTor(o, frontBroadcastLog, st => frontBroadcastStatus('tor', st));
        // Same rule as Psiphon's: ask the port, but a slow answer is not a reason to throw away a
        // bootstrap that just took minutes. A first stream through a fresh circuit is slow by
        // design — three hops, and over meek an HTTP round trip per cell.
        const carries = await torEngine.socksCarriesStream(25000);
        try { require('./system-settings').rememberConnection({ kind: 'tor', opts: o, tun: false }); } catch (e) { /* nothing to replay */ }
        frontGuardStart('tor', o);
        res.json(Object.assign({ ok: true }, info, carries ? {} : {
            warning: 'مدار ساخته شد، ولی اولین درخواست در ۲۵ ثانیه جواب نداد. موتور روشن ماند — مرورگر را امتحان کنید.',
        }));
    } catch (err) {
        frontBroadcastLog(`[TOR] ❌ ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tor/stop', async (req, res) => {
    try {
        if (tun.isRunning() && tun.currentEngine() === 'tor.exe') {
            await frontTunOwnDns(false);
            await withTunLock('tor-tun-off', async () => {
                await tun.stopTunAsync(tunBroadcastLog, 'user switched the tunnel off');
                await tun.verifyTornDown(tunBroadcastLog);
            });
            broadcast('tun', { running: false, wanted: false });
        }
        const was = torEngine.stopTor();
        frontBroadcastStatus('tor', torEngine.getStatus());
        try { require('./system-settings').forgetConnection('tor'); } catch (e) { /* none kept */ }
        frontGuardStop('tor', 'user stopped the engine');
        res.json({ ok: true, wasRunning: was });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tor/logs', (req, res) => res.json({ logs: torEngine.getLogs() }));

/**
 * What tor is doing right now — the live path, its byte counters, whether a circuit exists.
 *
 * Polled by the panel while «تور» is connected. Everything here comes from tor's own control port,
 * so it is the engine's account of itself rather than an inference from the adapter.
 */
app.get('/api/tor/live', async (req, res) => {
    try { res.json({ ok: true, live: await torEngine.liveInfo() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

/** A fresh path, without a fresh bootstrap. */
app.post('/api/tor/newnym', async (req, res) => {
    try {
        await torEngine.newIdentity();
        frontBroadcastLog('[TOR] مسیر تازه گرفته شد.');
        res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * Change the exit country on a RUNNING tor.
 *
 * The same request used to mean "stop, rewrite the config, bootstrap again" — minutes on a cold
 * cache. It is now two control commands, because the GeoIP database is loaded whether or not a
 * country was chosen at start. See tor-manager › writeTorrc.
 */
app.post('/api/tor/country', async (req, res) => {
    try {
        const cc = await torEngine.setExitCountry((req.body || {}).region);
        frontBroadcastLog(`[TOR] کشور خروج روی ${cc === 'auto' ? 'خودکار' : cc.toUpperCase()} تنظیم شد — مدار بعدی از همان‌جا بیرون می‌رود.`);
        frontBroadcastStatus('tor', torEngine.getStatus());
        res.json({ ok: true, region: cc });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * «بهبود مسیر» — measure the path the user is on, and draw again while it is poor.
 *
 * UNLIKE گف's sweep this restarts nothing and needs no idle connection: it measures the live
 * circuit and, when that circuit is bad, asks tor for a different one. The first thing it tries is
 * the path already in use, so a connection that is already fine costs one short measurement and
 * changes nothing at all.
 *
 * See tor-manager › improvePath for why it is not a race between exits — that was built, measured,
 * and found to be two and a half times SLOWER than leaving tor alone.
 */
const torPath = { running: false };

app.post('/api/tor/improve', async (req, res) => {
    if (torPath.running) return res.status(409).json({ error: 'یک سنجش در جریان است.' });
    if (!torEngine.getStatus().connected) return res.status(409).json({ error: 'اول تور را وصل کنید.' });
    const b = req.body || {};
    torPath.running = true;
    res.json({ ok: true, started: true });

    torEngine.improvePath({
        rounds: Math.min(6, Math.max(1, +b.rounds || 4)),
        onProgress: (p) => broadcast('tor_path', p),
    }).then((out) => {
        const cur = out.current;
        frontBroadcastLog(cur && cur.good
            ? `[TOR] ✅ مسیر خوب است — ${cur.mbit} مگابیت${cur.exit && cur.exit.country ? ' از ' + cur.exit.country : ''}`
            : `[TOR] این خط الان بیشتر از ${out.best ? out.best.mbit : 0} مگابیت نداد (${out.draws.length} مسیر امتحان شد).`);
        broadcast('tor_path', { phase: 'finished', summary: out });
        frontBroadcastStatus('tor', torEngine.getStatus());
    }).catch((err) => {
        frontBroadcastLog(`[TOR] ❌ سنجش ناتمام ماند: ${err.message}`);
        broadcast('tor_path', { phase: 'failed', error: err.message });
    }).finally(() => { torPath.running = false; });
});

/**
 * The user's own bridges.
 *
 * The one censorship problem the app cannot solve from the inside: the bundled bridges are the
 * same handful every Tor client on earth ships, and in Iran they are the first addresses to be
 * burned. Fresh ones come per-request from bridges.torproject.org or the @GetBridgesBot Telegram
 * bot, and until now there was nowhere to put them.
 */
app.post('/api/tor/bridges', (req, res) => {
    try {
        const text = String((req.body || {}).text || '');
        const saved = text.trim() ? torEngine.saveCustomBridges(text) : torEngine.clearCustomBridges();
        const n = Object.values(saved).reduce((s, v) => s + (v || []).length, 0);
        res.json({ ok: true, saved, count: n, groups: Object.keys(saved).filter(k => (saved[k] || []).length) });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tor/bridges', (req, res) => {
    try { res.json({ ok: true, bridges: torEngine.readCustomBridges() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
// «گف» — the Geph network
// ============================================================
//
// Shaped like the other three fronts, with one thing none of them has: an ACCOUNT. Geph's free tier
// needs one, and it is free and anonymous — no e-mail, no username, nothing. It is obtained by
// solving a proof-of-work puzzle the broker hands out (measured on this line: 22 seconds), and the
// result is a `secret` kept on disk. So there is an /account route beside the usual three, and
// /start refuses with a named reason rather than a timeout when there is no credential yet.

app.get('/api/geph/status', async (req, res) => {
    try {
        res.json({
            installed: gephEngine.isInstalled(),
            status: gephEngine.getStatus(),
            socksPort: gephEngine.SOCKS_PORT,
            httpPort: gephEngine.HTTP_PORT,
            regions: await gephEngine.regions(),
            // Every exit, not just the countries: city, load and category are what make a
            // choice mean something. See geph-manager's exits().
            exits: await gephEngine.exits(),
            fastest: gephEngine.lastFastest(),
            sweep: gephSweep.running ? { running: true, progress: gephSweep.progress } : { running: false },
            tun: tun.isRunning() && tun.currentEngine() === 'geph5-client.exe',
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/** The engine's own numbers for the live connection: ping, bytes, and its speed series. */
app.get('/api/geph/stats', async (req, res) => {
    try { res.json({ ok: true, stats: await gephEngine.liveStats() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * «سریع‌ترین خروج را پیدا کن» — a sweep, not a lookup.
 *
 * It restarts the engine once per candidate, so it cannot run while a connection is in use and it
 * takes minutes. Started here and reported through the same log/broadcast channel the panel
 * already listens to, rather than held open on one request that a reload would lose.
 */
const gephSweep = { running: false, progress: null, result: null };

app.post('/api/geph/fastest', async (req, res) => {
    if (gephSweep.running) return res.status(409).json({ error: 'یک سنجش در جریان است.' });
    if (tun.isRunning() && tun.currentEngine() === 'geph5-client.exe') {
        return res.status(409).json({ error: 'اول تونل کامل را خاموش کنید — سنجش موتور را چند بار بالا و پایین می‌کند.' });
    }
    if (gephEngine.isRunning()) {
        return res.status(409).json({ error: 'اول اتصال فعلی را قطع کنید — سنجش موتور را چند بار بالا و پایین می‌کند.' });
    }
    const body = req.body || {};
    gephSweep.running = true;
    gephSweep.progress = null;
    res.json({ ok: true, started: true });

    gephEngine.findFastest({
        candidates: Array.isArray(body.candidates) && body.candidates.length ? body.candidates : null,
        onLog: (line) => frontBroadcastLog(`[GEPH] ${line}`),
        onProgress: (p) => {
            gephSweep.progress = p;
            broadcast('geph_sweep', p);
        },
    }).then((out) => {
        gephSweep.result = out;
        frontBroadcastLog(out.best
            ? `[GEPH] ✅ سریع‌ترین خروج: ${out.best.label} — ${out.best.mbit} مگابیت`
            : '[GEPH] ❌ هیچ خروجی جواب نداد.');
        broadcast('geph_sweep', { stage: 'finished', best: out.best });
    }).catch((err) => {
        frontBroadcastLog(`[GEPH] ❌ سنجش ناتمام ماند: ${err.message}`);
        broadcast('geph_sweep', { stage: 'failed', error: err.message });
    }).finally(() => { gephSweep.running = false; });
});

app.post('/api/geph/start', async (req, res) => {
    const o = req.body || {};
    if (!gephEngine.isInstalled()) return res.status(500).json({ error: 'فایل گف در core/geph موجود نیست.' });
    try {
        const info = await gephEngine.startGeph(o, frontBroadcastLog, st => frontBroadcastStatus('geph', st));
        try { require('./system-settings').rememberConnection({ kind: 'geph', opts: o, tun: false }); } catch (e) { /* nothing to replay */ }
        frontGuardStart('geph', o);
        res.json(Object.assign({ ok: true }, info));
    } catch (err) {
        frontBroadcastLog(`[GEPH] ❌ ${err.message}`);
        // 409 and a code, not a 500: «you have no account yet» is a thing the user can fix in one
        // click, and the panel needs to be able to tell it apart from a failed connection.
        const noAccount = /حساب/.test(err.message) && !gephEngine.hasAccount();
        res.status(noAccount ? 409 : 500).json({ error: err.message, code: noAccount ? 'NO_ACCOUNT' : undefined });
    }
});

app.post('/api/geph/stop', async (req, res) => {
    try {
        if (tun.isRunning() && tun.currentEngine() === 'geph5-client.exe') {
            await frontTunOwnDns(false);
            await withTunLock('geph-tun-off', async () => {
                await tun.stopTunAsync(tunBroadcastLog, 'user switched the tunnel off');
                await tun.verifyTornDown(tunBroadcastLog);
            });
            broadcast('tun', { running: false, wanted: false });
        }
        const was = gephEngine.stopGeph();
        frontGuardStop('geph', 'user stopped the engine');
        frontBroadcastStatus('geph', gephEngine.getStatus());
        try { require('./system-settings').updateConnection('geph', { tun: false }); } catch (e) { /* none kept */ }
        res.json({ ok: true, was });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/geph/logs', (req, res) => res.json({ logs: gephEngine.getLogs() }));

/**
 * The account: make one, look at it, replace it, forget it.
 *
 * `register` holds the request open while the puzzle is solved (about twenty seconds of CPU) and
 * reports progress on the same log channel the panel is already listening to — the same arrangement
 * as /api/tor/start, which can take minutes. A progress bar with nothing behind it would be worse
 * than the wait.
 */
app.post('/api/geph/account', async (req, res) => {
    const body = req.body || {};
    const action = String(body.action || '');
    if (!gephEngine.isInstalled()) return res.status(500).json({ error: 'فایل گف در core/geph موجود نیست.' });
    try {
        if (action === 'register') {
            if (gephEngine.hasAccount() && !body.force) {
                return res.status(409).json({ error: 'از قبل حساب دارید. برای ساخت حساب نو، اول حساب فعلی را پاک کنید.' });
            }
            await gephEngine.registerAccount({
                onLog: frontBroadcastLog,
                onProgress: (p) => broadcast('geph_register', { progress: p }),
            });
            broadcast('geph_register', { progress: 1, done: true });
            const info = await gephEngine.accountInfo();
            frontBroadcastStatus('geph', gephEngine.getStatus());
            return res.json({ ok: true, account: info });
        }
        if (action === 'secret') {
            gephEngine.saveSecret(body.secret);
            const info = await gephEngine.accountInfo();
            frontBroadcastStatus('geph', gephEngine.getStatus());
            // A secret the broker does not recognise is kept anyway — the user may have pasted it
            // before the network is reachable — but the answer says so plainly.
            return res.json({ ok: true, account: info });
        }
        if (action === 'export') {
            // The user's own credential, handed back to the user's own UI so they can write it down
            // or move it to another device. It never leaves this machine by any other path — and
            // there is no recovery for a lost one, because the account has no other name.
            if (!gephEngine.hasAccount()) return res.status(404).json({ error: 'حسابی ذخیره نشده.' });
            const c = gephEngine._internal.credential();
            if (!c.secret) return res.status(409).json({ error: 'این حساب با نام‌کاربری/رمز ذخیره شده، کدی برای کپی کردن ندارد.' });
            return res.json({ ok: true, secret: c.secret });
        }
        if (action === 'forget') {
            if (gephEngine.isRunning()) gephEngine.stopGeph();
            gephEngine.forgetAccount();
            frontBroadcastStatus('geph', gephEngine.getStatus());
            return res.json({ ok: true });
        }
        const info = await gephEngine.accountInfo();
        res.json(info);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

/**
 * The SOCKS-front engines, as data.
 *
 * Written out because the routes below used to pick between two of them with a ternary per field,
 * and the third one (لنترن) would have meant editing every one of those — the arrangement where a
 * new engine is added to four places and forgotten in the fifth. Which is exactly what happened to
 * the status widget when three engines were added and none of them was listed in it.
 */
const FRONT_ENGINES = {
    psiphon: { label: 'سایفون', exe: 'psiphon.exe', mgr: () => psiphon },
    tor: { label: 'تور', exe: 'tor.exe', mgr: () => torEngine },
    lantern: { label: 'لنترن', exe: 'lantern.exe', mgr: () => lantern },
    geph: { label: 'گف', exe: 'geph5-client.exe', mgr: () => gephEngine },
};

/**
 * Watch a front engine for the whole time it is connected.
 *
 * See front-guard.js for what it records and the one case it acts on. Started from the engine's
 * own connect rather than only from the tunnel switch, because the drops worth counting begin
 * the moment the engine is up — a session that flapped five times before the user reached for
 * the tunnel switch is exactly the session whose history matters.
 */
function frontGuardStart(engine, opts) {
    const spec = FRONT_ENGINES[engine];
    if (!spec) return;
    // The options the user connected with, so a restart reproduces THEIR connection — the same
    // egress country, the same pinned rung — and not a default one they never asked for. Falls
    // back to what Always-On remembered when the guard is started from the tunnel switch, where
    // the original call is not in scope.
    let replay = opts;
    if (!replay) {
        try {
            const last = require('./system-settings').lastConnection();
            if (last && last.kind === engine) replay = last.opts;
        } catch (e) { /* a restart with defaults is still better than none */ }
    }
    try {
        require('./front-guard').start({
            engine,
            label: spec.label,
            exe: spec.exe,
            socksPort: spec.mgr().SOCKS_PORT,
            mgr: spec.mgr(),
            busy: () => tunTransitionInProgress(),
            onLog: frontBroadcastLog,
            onBlackHole: (why) => frontTunBlackHole(engine, why),
            allowPrograms: frontGuardAllowList(engine),
            onRestart: () => frontEngineRestart(engine, replay || {}),
        });
    } catch (e) { /* a guard that cannot start must not stop the engine */ }
}

/**
 * What stays reachable while the machine is held closed during an outage.
 *
 * Getting this list wrong turns a temporary outage into a permanent one: an engine that cannot
 * reach the internet can never rebuild its tunnel, and the block that was supposed to last
 * seconds lasts until the user finds this panel again.
 *
 * EVERY copy of each binary, not just the one the next start would pick — «ام‌ال‌ام استور» can
 * activate a new version while the old file is still executing, and allowing only the new path
 * would lock the live engine out. Same reasoning as the WARP list above.
 *
 * تور needs three: on a bridge rung it is `lyrebird.exe` or `conjure-client.exe` that holds the
 * outbound connection, and blocking those blocks تور just as dead as blocking tor.exe.
 */
function frontGuardAllowList(engine) {
    const corePaths = require('./core-paths');
    const exeDir = path.join(
        __dirname.toLowerCase().includes('.asar') ? __dirname.replace(/\.asar/gi, '.asar.unpacked') : __dirname,
        'core');
    // sing-box owns the socket for everything the rules send `direct`, including the engine's
    // own uplink when the process lookup is refused.
    const list = corePaths.candidates('singbox', 'sing-box.exe', path.join(exeDir, 'sing-box.exe')).slice();
    try {
        if (engine === 'psiphon') {
            list.push(...corePaths.candidates('psiphon', 'psiphon.exe', path.join(exeDir, 'psiphon.exe')));
        } else if (engine === 'tor') {
            const p = torEngine.binPaths ? torEngine.binPaths() : {};
            const torDir = corePaths.dir('tor', path.join(exeDir, 'tor'));
            list.push(p.tor || path.join(torDir, 'tor.exe'),
                p.pt || path.join(torDir, 'pluggable_transports', 'lyrebird.exe'),
                p.conjure || path.join(torDir, 'pluggable_transports', 'conjure-client.exe'));
        } else if (engine === 'lantern') {
            list.push(...corePaths.candidates('lantern', 'lantern.exe', path.join(exeDir, 'lantern.exe')));
        } else if (engine === 'geph') {
            list.push(...corePaths.candidates('geph', 'geph5-client.exe', path.join(exeDir, 'geph', 'geph5-client.exe')));
        }
    } catch (e) { /* a path we cannot resolve is one we cannot allow; the rest still stand */ }
    return list.filter(Boolean);
}

function frontGuardStop(engine, reason) {
    try {
        const guard = require('./front-guard');
        if (guard.status().watching === engine) guard.stop(reason || 'engine stopped');
    } catch (e) { /* nothing to stop */ }
}

/**
 * Start the engine again after it exited on its own.
 *
 * Resolves true only when the engine is connected AND its SOCKS port answers — the same proof
 * the connect endpoints require, because a restart that merely spawned a process would leave the
 * adapter pointing at a port that is still not serving, which is the state this whole path
 * exists to get out of.
 *
 * The manager's own `stop` runs first: a half-dead core can still hold the port, and the next
 * start would then fail to bind and look exactly like an engine that cannot connect.
 */
async function frontEngineRestart(engine, opts) {
    // ENGINE_PROBES is defined further down and carries exactly what a restart needs — the
    // manager and the names of its start and stop functions. Read at call time, so the order of
    // the two declarations in this file does not matter.
    const spec = ENGINE_PROBES[engine];
    if (!spec || !spec.start || !spec.mgr) return false;
    const mgr = spec.mgr();
    try { if (spec.stop && mgr[spec.stop]) mgr[spec.stop](); } catch (e) { /* nothing was running */ }
    await new Promise((r) => setTimeout(r, 800));
    try {
        await mgr[spec.start](opts || {}, frontBroadcastLog, (st) => frontBroadcastStatus(engine, st));
    } catch (e) {
        frontBroadcastLog(`[${spec.fa}] ❌ اجرای دوباره نشد: ${e.message}`);
        return false;
    }
    if (!mgr.getStatus().connected) return false;
    return portIsLive(mgr.SOCKS_PORT, 3000);
}

/**
 * The engine went away while its adapter still held the default route.
 *
 * Every packet on the machine is being handed to a SOCKS port with nothing behind it: the user is
 * offline and cannot open a page to find out why. Putting the adapter back is the only move that
 * restores a usable machine, and it is strictly better than leaving a green switch over a black
 * hole. The engine is NOT restarted here — reconnecting is the user's decision, and a guard that
 * silently re-dialled would hide the very failure this exists to surface.
 */
async function frontTunBlackHole(engine, why) {
    const spec = FRONT_ENGINES[engine];
    if (!spec) return;
    await withTunLock('front-engine-gone', async () => {
        if (tun.currentEngine() !== spec.exe) return;
        await frontTunOwnDns(false);
        await tun.stopTunAsync(tunBroadcastLog, `front engine gone: ${engine}`);
        await tun.verifyTornDown(tunBroadcastLog);
    });
    broadcast('tun', { running: false, wanted: false });
    tunBroadcastLog(`[TUN] ❌ ${why} — تونل کامل برداشته شد تا اینترنت سیستم برگردد. دوباره وصل شوید.`);
    try { require('./system-settings').updateConnection(engine, { tun: false }); } catch (e) { /* none kept */ }
}

/**
 * Full-system coverage for whichever front is connected.
 *
 * One route for all of them, because the difference between them is entirely inside
 * [frontTunOptions] — three copies of this would be three places for the safety rules to drift
 * apart.
 */
/**
 * The resolvers the machine is pointed at while a front tunnel owns the route.
 *
 * Public on purpose — see the note on [frontTunOwnDns]. One of each family: leaving the IPv6 list
 * alone is what let the router's link-local entry keep answering.
 */
const FRONT_TUN_DNS = ['8.8.8.8', '2001:4860:4860::8888'];

/** Point every adapter at FRONT_TUN_DNS. Advisory: a tunnel that carries traffic is still worth
 *  having if this fails, so it is reported and never thrown. */
async function frontTunOwnDns(on) {
    const dnsManager = require('./dns-manager');
    try {
        if (on) {
            await dnsManager.applyServers(FRONT_TUN_DNS, 'تونل کامل سیستم');
            tunBroadcastLog('[TUN] ↳ DNS ویندوز تا پایان تونل روی resolver عمومی تنظیم شد (وگرنه مودم جواب می‌دهد و اسم‌های فیلترشده آلوده برمی‌گردند)');
        } else {
            await dnsManager.restoreBackup();
            tunBroadcastLog('[TUN] ↳ DNS ویندوز به حالت خودش برگشت');
        }
    } catch (e) {
        tunBroadcastLog(`[TUN] ⚠️ تنظیم DNS ویندوز انجام نشد: ${e.message}`);
    }
}

app.post('/api/front/tun', async (req, res) => {
    const body = req.body || {};
    const engine = FRONT_ENGINES[body.engine] ? body.engine : 'psiphon';
    const enable = !!body.enabled;
    const mgr = FRONT_ENGINES[engine].mgr();
    const exe = FRONT_ENGINES[engine].exe;
    const label = FRONT_ENGINES[engine].label;
    const startedAt = Date.now();
    const diag = (event, fields = {}) => {
        if (engine === 'psiphon') psiphon.recordDiagnostic(event, { enabled: enable, elapsedMs: Date.now() - startedAt, ...fields });
    };
    const frontTunLog = line => { diag('tun-log', { line }); tunBroadcastLog(line); };
    diag('tun-request', { engineConnected: mgr.getStatus().connected, currentEngine: tun.currentEngine() });

    try {
        if (!enable) {
            // Queue behind a start. The adapter is not marked running until its preflight finishes,
            // so checking `isRunning()` before the lock races with that preflight.
            const torn = await withTunLock(`${engine}-tun-off`, async () => {
            if (tun.currentEngine() !== `${engine}.exe` && !tun.isRunning()) {
                await frontTunOwnDns(false);
                return { ok: true };
            }
            if (tun.currentEngine() !== `${engine}.exe`) {
                // Another engine owns the adapter. This request must never tear down a tunnel it
                // does not own just because its own switch was turned off.
                return { ok: true };
            }
                await frontTunOwnDns(false);
                await tun.stopTunAsync(frontTunLog, 'user switched the tunnel off');
                return tun.verifyTornDown(frontTunLog);
            });
            broadcast('tun', { running: false, wanted: false });
            try { require('./system-settings').updateConnection(engine, { tun: false }); } catch (e) { /* none kept */ }
            diag('tun-stopped', { cleanedUp: torn.ok });
            return res.json({ ok: true, running: false, cleanedUp: torn.ok });
        }

        // Refuse rather than take the machine offline: with no engine behind the SOCKS port the
        // default route would point at nothing and the user would have no way back.
        if (!mgr.getStatus().connected || !(await portIsLive(mgr.SOCKS_PORT))) {
            diag('tun-refused', { reason: 'FRONT_NOT_CONNECTED', socksPort: mgr.SOCKS_PORT });
            return res.status(409).json({
                error: `موتور ${label} وصل نیست (پورت ${mgr.SOCKS_PORT} خالی است). اول وصل شوید، بعد تونل کامل را روشن کنید.`,
                code: 'FRONT_NOT_CONNECTED',
            });
        }

        await withTunLock(`${engine}-tun-on`, async () => {
            // The system proxy and the tunnel cannot coexist: apps would hand their traffic to the
            // proxy, whose own replies are captured by the adapter and fed back in.
            if (readSystemProxy().enabled) {
                await require('./xray-manager').enableSystemProxy(false, XRAY.http);
                tunBroadcastLog(`[TUN] پراکسی سیستم خاموش شد (با تونل کامل قابل جمع نیست).`);
                broadcast('system_proxy', Object.assign(readSystemProxy(), { port: XRAY.http }));
            }
            // Re-check after waiting for the transition lock: the engine may have been stopped
            // while this request was queued.
            if (!mgr.getStatus().connected || !(await portIsLive(mgr.SOCKS_PORT))) {
                throw new Error(`موتور ${label} در زمان روشن‌کردن تونل قطع شد.`);
            }
            // Ask the live engine what it can carry, on the port that is actually up, before the
            // machine's route is handed to it. See frontEngineCarriesUdp.
            const udp = await frontEngineCarriesUdp(engine, mgr.SOCKS_PORT);
            await tun.startTun(mgr.SOCKS_PORT, frontTunLog, frontTunOptions(engine, udp));
            // DNS changes belong to the same serialized transition. Otherwise a queued stop can
            // restore Windows DNS and this late start can immediately overwrite it again.
            await frontTunOwnDns(true);
        });
        diag('tun-ready', { socksPort: mgr.SOCKS_PORT });
        // Also here, not only on the engine's connect: the engine may have been brought up by a
        // path that does not go through its own endpoint (auto-connect, «اتصال سریع», a replayed
        // session), and the moment the adapter holds the default route is the moment the black
        // hole becomes possible.
        frontGuardStart(engine);

        broadcast('tun', { running: true, wanted: true, engine });
        try { require('./system-settings').updateConnection(engine, { tun: true }); } catch (e) { /* none kept */ }
        res.json({ ok: true, running: true, engine });

        // AFTER the answer, never before it: this is diagnosis, not a gate. It writes route, DNS,
        // the exit address and the throughput into the tunnel's own log, so the next report of
        // "it is on and nothing works" arrives with numbers attached instead of having to be
        // reconstructed from error lines. The V2Ray tunnel has had this since it shipped; these
        // three never did, which is exactly why they were the hard ones to diagnose.
        tun.tunVerdict(frontTunLog, {}).catch(err => diag('tun-verdict-failed', { error: err.message }));
    } catch (err) {
        diag('tun-failed', { error: err.message });
        // A failed start must not leave the adapter half-up: that is the state where the route is
        // changed and nothing is carrying it. The resolver list is put back for the same reason.
        try { await frontTunOwnDns(false); } catch (e) { /* nothing to put back */ }
        try { await tun.stopTunAsync(tunBroadcastLog, 'front tunnel start failed'); } catch (e) { /* nothing to tear down */ }
        tunBroadcastLog(`[TUN] ❌ ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/aether/status', (req, res) => {
    try {
        res.json({
            installed: aether.isInstalled(),
            status: aether.getStatus(),
            socksPort: aether.SOCKS_PORT,
            dataDir: aether.AETHER_DATA_DIR,
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/aether/start', async (req, res) => {
    const opts = req.body || {};
    if (!['masque', 'wg', 'gool'].includes(opts.protocol)) {
        return res.status(400).json({ error: 'پروتکل نامعتبر است (masque | wg | gool)' });
    }
    if (!aether.isInstalled()) {
        return res.status(500).json({ error: 'فایل core/aether.exe موجود نیست.' });
    }
    // A connect the user asked for is never a measurement. The game panel's engine comparison
    // sets this flag and clears it only through its own stop; a comparison that ended any other
    // way (aborted, or the engine exited by itself) left it set, and from then on every connect
    // was handled as a measurement: the engine connected, but the Xray front end and the DNS
    // bridge never came up — "متصل، ولی ترافیک عبور نمی‌کند" on all three methods until the
    // app was restarted.
    aetherMeasurementMode = false;
    aetherFrontendStarted = false;
    aether.setChainToXray(opts.chainToXray !== false);
    try {
        const onDebug = opts.debug ? (debugEntry) => {
            wss.clients.forEach(c => {
                if (c.readyState === 1) c.send(JSON.stringify({ type: 'aether_debug', data: debugEntry }));
            });
        } : null;
        const info = await aether.startAether(opts, aetherBroadcastLog, aetherBroadcastStatus, onDebug);
        // Settings › «VPN همیشه روشن» (see /api/v2ray/start). The debug switch is the user's
        // at the moment, not part of the connection.
        try { require('./system-settings').rememberConnection({ kind: 'aether', opts: Object.assign({}, opts, { debug: false }), tun: false }); } catch (e) { /* nothing to replay */ }
        res.json({ ok: true, socks: info.socks, pid: info.pid });
    } catch (err) {
        aetherBroadcastLog(`[WARP] ❌ ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/aether/stop', async (req, res) => {
    try {
        // The user's stop ends a measurement too (see /api/aether/start).
        aetherMeasurementMode = false;
        const was = aether.stopAether();
        aetherBroadcastLog('[WARP] موتور به درخواست کاربر متوقف شد.');
        // A stop the user asked for gets no grace period: nothing is going to reconnect, and
        // making them wait to get their routing and DNS back would be absurd.
        aetherCancelDisconnectGrace();
        aetherStopWatchdog();
        aetherBroadcastStatus(aether.getStatus());
        await aetherTearDownAfterDisconnect({ userInitiated: true });
        await aetherReleaseFailClosed('کاربر موتور را متوقف کرد');

        // AWAITED, and this is the whole point of the change.
        //
        // This used to be fire-and-forget: the response went out while an elevated PowerShell
        // was still being spawned to put the resolvers back. Measured consequence — stop
        // returned {"ok":true}, the process was killed three seconds later, and Windows was
        // left pointing at 127.0.0.1 / ::1 with nothing listening. Every lookup failed, and
        // the state survived the app exiting. Replying only once the machine is actually
        // restored is the difference between "disconnected" and "broken".
        await stopAetherDnsBridge();

        try { require('./system-settings').forgetConnection('aether'); } catch (e) { /* none kept */ }
        res.json({ ok: true, wasRunning: was, dnsRestored: !aetherGuard.getStatus().dnsOwned });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/aether/logs', (req, res) => {
    try { res.json({ logs: aether.getLogs(), crash: aether.getCrashLog() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

/* ─────────────────────────────────────────────────────────────────────────
   «وارپ» — its OWN engine, on purpose (warp-manager.js).

   It shares nothing with the aether routes above: its own Cloudflare registration, its own
   endpoint sweep (a WireGuard handshake spoken in Node), and `core/xray.exe` for the data
   plane. That separation is the feature — when aether's MASQUE is being refused by every
   gateway, as it was on 2026-09-20, this still connects.
   ───────────────────────────────────────────────────────────────────────── */

function warpBroadcast(type, data) {
    wss.clients.forEach((c) => { if (c.readyState === 1) c.send(JSON.stringify({ type, data })); });
}
const warpLog = (line) => warpBroadcast('warp_log', line);

/**
 * «وارپ» is a complete tunnel on its own, but the same two things have to happen around it as
 * around aether or the user is left with a connected engine and no way to use it — which is
 * exactly what they reported: «وصل است — ولی ترافیکی از آن رد نمی‌شود», and the tunnel switch
 * refusing because it had never heard of this engine.
 *
 *   · Xray in front of it, so «پراکسی سیستم» has an HTTP port to point Windows at.
 *   · the DNS bridge, so lookups stop going to the ISP in cleartext.
 *
 * Both are torn down when it goes away, because an Xray with nothing behind it plus a live
 * system proxy is the «internet is dead and nothing says why» state.
 */
let warpFrontendStarted = false;
function warpStatus(st) {
    warpBroadcast('warp_status', st);
    if (st && st.connected && !warpFrontendStarted) {
        warpFrontendStarted = true;
        const xray = require('./xray-manager');
        if (xray.isRunning() && xray.getCurrentUri()) {
            warpLog('Xray با یک نود فعال است و از تونل وارپ خارج می‌شود.');
        } else {
            xray.startXrayAetherOnly(warp.SOCKS_PORT, false, warpLog)
                .then((info) => {
                    warpLog(`✅ پراکسی محلی آماده شد: SOCKS ${info.socks} / HTTP ${info.http}`);
                    warpLog('حالا می‌توانید «پراکسی سیستم» یا «تونل کامل» را روشن کنید.');
                    broadcast('system_proxy', Object.assign(readSystemProxy(), { port: XRAY.http }));
                })
                .catch((e) => { warpFrontendStarted = false; warpLog('❌ راه‌اندازی پراکسی محلی ناموفق بود: ' + e.message); });
        }
        startAetherDnsBridge();
    }
    // The same lifecycle aether gets — grace period, kill switch, re-arm, and the teardown
    // that hands the machine back. «وارپ» had none of it, and what it had instead was worse
    // than nothing: it dropped the DNS bridge on the FIRST non-connected stage the engine
    // emitted (which happens on every re-handshake) and cleared `warpFrontendStarted` while
    // doing it, so the real teardown could no longer find the front-end Xray to stop. The
    // tunnel was never mentioned at all.
    engineTunnelLifecycle(!!(st && st.connected));
}

app.get('/api/warp/status', (req, res) => {
    try {
        res.json({ installed: warp.isInstalled(), status: warp.getStatus(), socksPort: warp.SOCKS_PORT });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/warp/start', async (req, res) => {
    if (!warp.isInstalled()) return res.status(500).json({ error: 'فایل core/xray.exe موجود نیست.' });
    // A fresh session starts from «never connected», or the first `connected: false` stage of
    // the connect is read as a DROP and arms the teardown six seconds into a scan that legitimately
    // takes two minutes. Same reason the aether start clears its own flags.
    warpFrontendStarted = false;
    aetherCancelDisconnectGrace();
    try {
        const r = await warp.start(req.body || {}, warpLog, warpStatus);
        if (!r.ok) return res.status(502).json({ error: 'اندپوینت سالمی پیدا نشد — این شبکه وایرگارد به کلادفلر را بسته است.' });
        try { require('./system-settings').rememberConnection({ kind: 'warp', opts: {}, tun: false }); } catch (e) { /* nothing to replay */ }
        res.json(r);
    } catch (err) {
        warpLog('❌ ' + err.message);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/warp/stop', async (req, res) => {
    try {
        // BOTH OF THESE BEFORE THE STOP, and the order is the fix, not a detail.
        //
        // `warp.stop()` pushes its own `connected: false` status on the way out. Left to itself
        // that reaches `engineTunnelLifecycle`, which cannot tell a disconnect the user ASKED
        // for from one the engine suffered — so it would arm the 150-second grace and throw the
        // kill switch as the last act of a deliberate disconnect. Clearing `aetherWasConnected`
        // first makes that broadcast take the «nothing to tear down» branch, exactly as the
        // aether stop route does.
        aetherCancelDisconnectGrace();
        aetherStopWatchdog();

        const was = warp.isRunning();
        const r = await warp.stop();
        warpLog('موتور به درخواست کاربر متوقف شد.');

        // EVERYTHING STANDING ON THIS ENGINE COMES DOWN WITH IT.
        //
        // This route used to stop the engine and nothing else, and that is the whole of the
        // 2026-09-21 report: «وارپ را قطع کردم، چراغش هم خاموش شد، حتی برنامه‌های
        // بیرونی هم نمیتونن وصل بشن». The engine stopped; sing-box kept the default route and
        // handed every packet to a SOCKS port that no longer existed, the front-end Xray stayed
        // up under the Windows system proxy, and the resolvers still pointed at a bridge with a
        // dead upstream. Nothing in the app reported a fault, because from the app's side
        // nothing had failed — which is why quitting MLM VPN was the only cure: `before-quit`
        // in main.js is where all three were being torn down.
        //
        // No grace period: nothing is coming back, and making the user wait 150 seconds for
        // their own internet would be absurd.
        await aetherTearDownAfterDisconnect({ userInitiated: true });
        await aetherReleaseFailClosed('کاربر موتور را متوقف کرد');
        // AWAITED. Fire-and-forget here meant the reply went out while an elevated PowerShell
        // was still putting the resolvers back — see the same note on the aether stop.
        await stopAetherDnsBridge();

        try { require('./system-settings').forgetConnection('warp'); } catch (e) { /* none kept */ }
        res.json(Object.assign({ wasRunning: was, dnsRestored: !aetherGuard.getStatus().dnsOwned }, r));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/warp/reset-identity', async (req, res) => {
    try {
        if (warp.isRunning()) return res.status(409).json({ error: 'اول «وارپ» را متوقف کنید.' });
        res.json(await warp.resetIdentity());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/warp/logs', (req, res) => {
    try { res.json({ logs: warp.getLogs() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Wipe stored Cloudflare identities; next start provisions fresh accounts.
/* ─────────────────────────────────────────────────────────────────────────
   «کدام موتور برای خط من؟» — every engine, measured on the user's own line.

   The app has ten ways to get out and a newcomer has no way to choose between them but
   trial and error, which in Iran costs half an hour. This answers it by measurement: bring
   each engine up, ask it to fetch something real, write down how long it took, put it back.

   WHAT IT DELIBERATELY DOES NOT TOUCH.
   Nothing about the machine. Every engine here is started in its PROXY-ONLY form — a local
   SOCKS listener and nothing else. The system tunnel is a separate call (/api/front/tun) and
   is never made; WARP runs under `aetherMeasurementMode`, which is the flag the game
   tournament added for exactly this reason: without it the normal status handler takes over
   the machine's DNS and arms the fail-closed guard, and the user watches their internet die
   once per engine. On the way out the guard and the DNS bridge are released anyway, belt
   and braces, in case a crashed run left them armed.

   WHAT IS NOT IN THE FIELD, AND WHY.
   گیت‌وی is a Windows SSTP dial — it cannot be tested without a real system VPN connection.
   تحریم‌شکن and «DNS اختصاصی» change the machine's resolver by definition. «اتصال سریع» and
   V2Ray are config pickers rather than engines, and racing a user's whole node list is the
   game tab's tournament, which already exists. Saying so is better than pretending.
   ───────────────────────────────────────────────────────────────────────── */
const ENGINE_PROBES = {
    masque:  { fa: 'ماسک',         kind: 'aether', protocol: 'masque', socks: 20810, budget: 55000 },
    wg:      { fa: 'وایرگارد',      kind: 'aether', protocol: 'wg',     socks: 20810, budget: 55000 },
    gool:    { fa: 'وارپ در وارپ',  kind: 'aether', protocol: 'gool',   socks: 20810, budget: 75000 },
    psiphon: { fa: 'سایفون',        kind: 'front',  mgr: () => psiphon,    start: 'startPsiphon', stop: 'stopPsiphon', socks: 20830, budget: 70000 },
    // Tor is the slow one by design: three hops, and over meek an HTTP round trip per cell.
    tor:     { fa: 'تور',           kind: 'front',  mgr: () => torEngine,  start: 'startTor',     stop: 'stopTor',     socks: 20820, budget: 150000 },
    lantern: { fa: 'لنترن',         kind: 'front',  mgr: () => lantern,    start: 'startLantern', stop: 'stopLantern', socks: 20840, budget: 70000 },
    geph:    { fa: 'گف',            kind: 'front',  mgr: () => gephEngine, start: 'startGeph',    stop: 'stopGeph',    socks: 20850, budget: 70000 },
    // The odd one out, and deliberately so: OpenVPN has no SOCKS listener to measure through,
    // because it is a full tunnel. Its probe dials a real relay with `--dev null`, which
    // completes TCP, TLS, auth and the data-channel key exchange and then has nowhere to put
    // packets — a real end-to-end measurement that never touches the machine's route.
    openvpn: { fa: 'اوپن‌وی‌پی‌ان', kind: 'openvpn', budget: 60000 },
};

let engineProbeRunning = false;
let engineProbeAbort = false;

app.post('/api/engines/probe/stop', (req, res) => {
    engineProbeAbort = true;
    res.json({ ok: true, running: engineProbeRunning });
});

app.post('/api/engines/probe', async (req, res) => {
    if (engineProbeRunning) return res.status(409).json({ error: 'یک سنجش موتورها از قبل در حال اجراست.', code: 'BUSY' });
    // Never while the machine's route belongs to something: the probe must not be the reason
    // a live tunnel goes down under the user.
    if (aetherTunWanted || v2rayTunWanted || (tun.isRunning && tun.isRunning())) {
        return res.status(409).json({ error: 'اول تونل کامل را خاموش کنید — سنجش نباید مسیر سیستم را عوض کند.', code: 'TUN_UP' });
    }

    const want = Array.isArray(req.body && req.body.engines) && req.body.engines.length
        ? req.body.engines.filter(id => ENGINE_PROBES[id])
        : Object.keys(ENGINE_PROBES);
    if (!want.length) return res.status(400).json({ error: 'موتوری برای سنجش انتخاب نشده است.' });

    engineProbeRunning = true;
    engineProbeAbort = false;
    // res, not req — see the V2Ray delay test: a POST's request stream is already finished.
    res.on('close', () => { if (!res.writableEnded) engineProbeAbort = true; });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    const write = (o) => { try { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); } catch (e) { /* client gone */ } };

    const { realPing } = require('./xray-tester');
    const PROBE_URL = 'https://www.gstatic.com/generate_204';

    const startOne = async (spec) => {
        if (spec.kind === 'aether') {
            aetherMeasurementMode = true;
            try {
                await aether.startAether(
                    { protocol: spec.protocol, chainToXray: false, scan: 'turbo' },
                    aetherBroadcastLog, aetherMeasurementStatus, null);
            } catch (err) { aetherMeasurementMode = false; throw err; }
            return;
        }
        const mgr = spec.mgr();
        if (!mgr.isInstalled()) throw new Error('هسته‌اش روی این سیستم نصب نیست');
        await mgr[spec.start]({}, frontBroadcastLog, st => frontBroadcastStatus(spec.id, st));
    };

    const stopOne = async (spec) => {
        try {
            if (spec.kind === 'aether') {
                aetherTunWanted = false;
                aetherStopWatchdog();
                aether.stopAether();
                aetherMeasurementMode = false;
                try { await aetherReleaseFailClosed('پایان سنجش موتورها'); } catch (e) { /* not armed */ }
                try { await stopAetherDnsBridge(); } catch (e) { /* not up */ }
                return;
            }
            const mgr = spec.mgr();
            mgr[spec.stop]();
            try { frontBroadcastStatus(spec.id, mgr.getStatus()); } catch (e) { /* no status */ }
        } catch (e) { /* a stop that throws must not strand the next engine */ }
    };

    const ready = (spec) => {
        try {
            if (spec.kind === 'aether') return !!aether.getStatus().connected;
            return !!spec.mgr().getStatus().connected;
        } catch (e) { return false; }
    };

    const results = [];
    try {
        for (const id of want) {
            if (engineProbeAbort) break;
            const spec = Object.assign({ id }, ENGINE_PROBES[id]);
            const row = { id, fa: spec.fa };
            write({ type: 'begin', id, fa: spec.fa });

            const t0 = Date.now();
            try {
                // OpenVPN is measured whole, in one call, because it has no listener to poll.
                if (spec.kind === 'openvpn') {
                    if (!openvpn.isInstalled()) throw new Error('هسته‌اش روی این سیستم نصب نیست');
                    const list = openvpn.listServers().servers || [];
                    if (!list.length) throw new Error('فهرست سرورهایش خالی است — اول از پنل خودش فهرست را بگیرید');
                    // The one it would actually dial: fastest TCP handshake from here, now.
                    const tcp = await openvpn.measure(null, { concurrency: 24, timeout: 4000 });
                    const best = tcp.filter(x => x.ok).sort((a, b) => a.ms - b.ms)[0];
                    if (!best) throw new Error('هیچ سروری از این خط جواب نداد');
                    const r = await openvpn.probe(best.host, spec.budget);
                    if (r.ok) {
                        row.connectMs = r.ms;
                        write({ type: 'connected', id, connectMs: row.connectMs });
                        row.ok = true;
                        row.ms = best.ms;          // the path's own latency, not the handshake
                        row.note = best.host;
                    } else {
                        row.ok = false;
                        row.error = r.err === 'auth' ? 'سرور اجازه نداد'
                            : r.err === 'timeout' ? 'در زمان مقرر وصل نشد' : 'اتصال برقرار نشد';
                    }
                    results.push(row);
                    write(Object.assign({ type: 'result' }, row));
                    if (!engineProbeAbort) await new Promise(r2 => setTimeout(r2, 900));
                    continue;
                }
                await startOne(spec);
                // The port opens long before the data plane exists — the game tournament learned
                // that the hard way — so the engine itself is asked, not just its listener.
                const deadline = Date.now() + spec.budget;
                while (Date.now() < deadline && !engineProbeAbort) {
                    if (ready(spec) && await portIsLive(spec.socks)) break;
                    await new Promise(r => setTimeout(r, 600));
                }
                if (engineProbeAbort) { await stopOne(spec); break; }
                if (!ready(spec)) throw new Error('در زمان مقرر وصل نشد');
                row.connectMs = Date.now() - t0;
                write({ type: 'connected', id, connectMs: row.connectMs });

                // Does anything actually pass? realPing does two shots and keeps the better,
                // which is the same measure the V2Ray panel shows for a node.
                const ping = await realPing(spec.socks, PROBE_URL, { log: () => {} });
                if (ping.val > 0) { row.ok = true; row.ms = ping.val; }
                else { row.ok = false; row.error = 'وصل شد ولی ترافیکی عبور نکرد'; row.reason = ping.reason; }
            } catch (err) {
                row.ok = false;
                row.error = err.message;
            }
            await stopOne(spec);
            results.push(row);
            write(Object.assign({ type: 'result' }, row));
            // A breath between engines: ports need a moment to come back.
            if (!engineProbeAbort) await new Promise(r => setTimeout(r, 900));
        }
    } finally {
        engineProbeRunning = false;
        // Whatever happened, leave nothing of ours running.
        try { if (aether.getStatus().connected) { aether.stopAether(); } } catch (e) { /* down */ }
        aetherMeasurementMode = false;
        try { await aetherReleaseFailClosed('پایان سنجش موتورها'); } catch (e) { /* not armed */ }
        try { await stopAetherDnsBridge(); } catch (e) { /* not up */ }
        write({ type: 'done', aborted: engineProbeAbort, results });
        if (!res.writableEnded) res.end();
    }
});

app.post('/api/aether/reset-identity', (req, res) => {
    try {
        if (aether.isRunning()) return res.status(400).json({ error: 'اول موتور را متوقف کنید.' });
        const removed = aether.resetIdentity();
        aetherBroadcastLog(`[WARP] هویت‌ها پاک شد: ${removed.length ? removed.join(', ') : 'چیزی برای پاک کردن نبود'}`);
        res.json({ ok: true, removed });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Forget the cached gateway only. Unlike reset-identity this keeps the Cloudflare account,
// so the next connect rescans for a better edge without paying for a fresh registration.
app.post('/api/aether/clear-gateway', (req, res) => {
    try {
        const removed = aether.clearLastConnection();
        aetherBroadcastLog(`[WARP] گیت‌وی ذخیره‌شده پاک شد: ${removed.length ? removed.join(', ') : 'چیزی ذخیره نشده بود'}`);
        aetherBroadcastLog('[WARP] اتصال بعدی از نو اسکن می‌کند.');
        res.json({ ok: true, removed });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Measure the live tunnel on demand, so the user can check throughput without a browser test.
app.get('/api/aether/speedtest', async (req, res) => {
    try {
        if (!aether.getStatus().connected) {
            return res.status(409).json({ error: 'تونل وصل نیست.' });
        }
        const r = await require('./aether-speedtest').measure(aether.SOCKS_PORT);
        aetherBroadcastLog(`[WARP] 📊 سنجش سرعت: ${r.kbps} KB/s (~${(r.kbps * 8 / 1024).toFixed(1)} مگابیت)`);
        res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Debug endpoints for the v1.5.0 diagnostics system.
app.get('/api/aether/debug', (req, res) => {
    try {
        res.json({
            summary: aether.getDebugSummary(),
            files: aether.getDebugLogFiles(),
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/aether/debug/log/:filename', (req, res) => {
    try {
        const content = aether.readDebugLogFile(req.params.filename);
        if (!content) return res.status(404).json({ error: 'فایل دیباگ پیدا نشد.' });
        res.type('text/plain').send(content);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/aether/debug/toggle', (req, res) => {
    try {
        const on = req.body.enabled !== false;
        aether.setDebugMode(on);
        aetherBroadcastLog(`[WARP] ${on ? '🔍 حالت دیباگ روشن شد' : 'حالت دیباگ خاموش شد'}`);
        res.json({ ok: true, debugMode: aether.getDebugMode() });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// API: V2Ray Nodes

// «غیرفعال شدن مانیتورینگ مصرف» (Settings › برنامه). The client sends its saved choice at
// start and on every change; the server starts each run with monitoring on.
app.post('/api/traffic/monitoring', (req, res) => {
    try {
        const xrayManager = require('./xray-manager');
        xrayManager.setTrafficMonitoring(!(req.body && req.body.enabled === false));
        res.json({ ok: true, enabled: xrayManager.getTrafficMonitoring() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ── Settings › ظاهر › «اندازه‌ی متن» (display-settings.js) ─────────────────────────────────
app.get('/api/display', (req, res) => { res.json(require('./display-settings').get()); });
app.post('/api/display', (req, res) => {
    try { res.json(require('./display-settings').set(req.body || {})); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * Settings › صفحه نمایش › «شتاب‌دهندهٔ گرافیکی».
 *
 * THE USER'S SWITCH, and only theirs. An earlier version turned it off by itself after two
 * launches that never reached a desktop; the signal it read never arrived at all, so it fired
 * on healthy machines, and even working it could not have detected the thing it was for (a
 * window black because the GPU cannot composite still boots and still reports itself ready).
 * startup-health.beginLaunch now undoes that write wherever it landed.
 *
 * The same setting is on the tray menu, which matters: this page lives inside the window that
 * is not drawing, and the tray is drawn by Windows.
 *
 * Takes effect at the next launch: Electron refuses disableHardwareAcceleration() once the app
 * is ready, so there is no way to apply it live and pretending otherwise would be a lie.
 */
app.get('/api/display/gpu', (req, res) => {
    try {
        const h = require('./startup-health').read();
        res.json({ ok: true, gpuOff: h.gpuOff, auto: h.gpuOffAuto, fails: h.fails });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/api/display/gpu', (req, res) => {
    try {
        const off = require('./startup-health').setGpuOff(!!(req.body || {}).off);
        // The tray menu shows the same switch and was built from this file. Without this it
        // keeps its old tick until the next launch and the two disagree on screen.
        try { if (typeof global.__mvRebuildTray === 'function') global.__mvRebuildTray(); } catch (e) { /* tray not up */ }
        res.json({ ok: true, gpuOff: off, restartNeeded: true });
    } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── Settings › «شبکه» (network-settings.js) ──────────────────────────────────────────────
// Everything here shapes Xray's config or the tunnel's adapter, so a change reaches a running
// connection at its next start; `pending` tells the page when that is the case, rather than it
// quietly saying "saved" over an engine still on the old values.
function networkState() {
    const ns = require('./network-settings');
    const xrayManager = require('./xray-manager');
    return Object.assign({}, ns.get(), {
        active: xrayManager.isRunning() ? xrayManager.getPorts() : null,
        running: xrayManager.isRunning(),
        tunnel: tun.isRunning(),
        lan: ns.lanAddresses(),
        defaultMtu: ns.DEFAULT_MTU,
    });
}
app.get('/api/network', (req, res) => {
    try { res.json(networkState()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/network', (req, res) => {
    try {
        const ns = require('./network-settings');
        const before = JSON.stringify(ns.get());
        ns.set(req.body || {});
        const st = networkState();
        const changed = before !== JSON.stringify(ns.get());
        res.json(Object.assign(st, { pending: changed && (st.running || st.tunnel) }));
    } catch (e) { res.status(400).json({ error: e.message }); }
});
// «پیدا کردن بهترین مقدار برای این خط» for one method (Android's MtuProbe). The methods that end
// connections on this machine answer 1500 with no probe; the WARP ones ping a WARP endpoint with
// "don't fragment" — which a running full tunnel would swallow, so it has to be off for those.
let mtuProbeBusy = false;
app.post('/api/network/mtu-probe', async (req, res) => {
    const ns = require('./network-settings');
    const method = String((req.body && req.body.method) || '');
    if (!ns.MTU_METHODS.includes(method)) return res.status(400).json({ error: 'روش شناخته نشد.' });
    if (!ns.LOCAL_TERMINATION.includes(method) && tun.isRunning()) {
        return res.status(409).json({ error: 'تونل کامل روشن است — بسته‌های آزمایشی از داخل آن رد نمی‌شوند و اندازه‌ی خط سنجیده نمی‌شود. اول تونل را خاموش کنید.' });
    }
    if (mtuProbeBusy) return res.status(409).json({ error: 'یک اندازه‌گیری دیگر در جریان است.' });
    mtuProbeBusy = true;
    try { res.json(await ns.measureMethod(method)); }
    catch (e) { res.status(500).json({ error: e.message }); }
    finally { mtuProbeBusy = false; }
});

// ── Settings › «VPN همیشه روشن» and › سیستم (system-settings.js) ─────────────────────────
app.get('/api/system', async (req, res) => {
    try { res.json(await require('./system-settings').status()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/system', async (req, res) => {
    const sys = require('./system-settings');
    try {
        const b = req.body || {};
        if (b.alwaysOn !== undefined) await sys.setAlwaysOn(!!b.alwaysOn);
        if (b.lockMinutes !== undefined) sys.setLockMinutes(b.lockMinutes);
        res.json(await sys.status());
    } catch (e) { res.status(400).json({ error: e.message }); }
});

/**
 * Every connection this app can hold, ended — for «رفتار هنگام قفل شدن ویندوز». The same order
 * the panels use to disconnect: the tunnel before its engine, so the default route never points
 * at a port that has just closed.
 */
/**
 * One of the app's own endpoints, called from inside: so a system action (the lock watcher,
 * Always-On) runs exactly the path the panel's button runs, guards and all. Resolves with the
 * status and the parsed reply; never rejects.
 */
function selfPost(url, body) {
    return new Promise((resolve) => {
        const payload = JSON.stringify(body || {});
        const r = http.request({
            host: '127.0.0.1', port: server.address().port, path: url, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (resp) => {
            let text = '';
            resp.setEncoding('utf8');
            resp.on('data', (c) => { text += c; });
            resp.on('end', () => { let data = {}; try { data = JSON.parse(text); } catch (e) { /* not JSON */ } resolve({ status: resp.statusCode, data }); });
        });
        r.on('error', (e) => resolve({ status: 0, data: { error: e.message } }));
        r.end(payload);
    });
}

async function disconnectEverything(reason) {
    const said = (m) => { try { aetherBroadcastLog(`[SYS] ${m}`); } catch (e) { /* no page */ } console.log('[SYS]', m); };
    said(`${reason} — همه‌ی اتصال‌ها قطع می‌شوند.`);
    const step = async (name, fn) => { try { await fn(); } catch (e) { said(`قطع ${name} ناموفق بود: ${e.message}`); } };
    const post = (url) => selfPost(url, {});
    // Through the app's own endpoints, so each engine's teardown is exactly the one its panel runs.
    if (v2rayTunWanted || tun.isRunning()) await step('تونل', () => post('/api/v2ray/tun').then(() => {}));
    await step('وارپ', () => post('/api/aether/stop'));
    await step('V2Ray', () => post('/api/v2ray/stop'));
    await step('SNI', () => post('/api/sni/stop'));
    await step('گوگل‌اسکریپت', () => post('/api/gst/stop'));
    await step('تونل گیت‌هاب', () => post('/api/github-tunnel/disconnect'));
    broadcast('system_disconnected', { reason });
}

/**
 * «VPN همیشه روشن», the reconnect half: the connection that was still up when the app last
 * closed comes back, through the same endpoints its panel uses — SNI front, then the config, then
 * the full tunnel if it had one; or a WARP method, then its tunnel once it has connected. Runs
 * only with the switch on and a record left (a connection the user ended leaves none).
 */
async function alwaysOnReplay() {
    const sys = require('./system-settings');
    if (!sys.get().alwaysOn) return;
    const rec = sys.lastConnection();
    if (!rec) return;
    const log = (m) => { try { aetherBroadcastLog(`[ALWAYS-ON] ${m}`); } catch (e) { /* no page */ } console.log('[ALWAYS-ON]', m); };
    const must = (r, what) => { if (!r || r.status < 200 || r.status >= 300) throw new Error(`${what}: ${(r && r.data && r.data.error) || 'پاسخ ' + (r && r.status)}`); };
    log('«VPN همیشه روشن» — آخرین اتصال دوباره برقرار می‌شود…');
    try {
        if (rec.kind === 'v2ray') {
            if (rec.sni) must(await selfPost('/api/sni/start', { config: rec.sni, wait: true }), 'موتور SNI');
            must(await selfPost('/api/v2ray/start', {
                uri: rec.uri, cleanIp: rec.cleanIp, cleanPort: rec.cleanPort, realIp: rec.realIp,
                useSystemProxy: !!rec.useSystemProxy && !rec.tun,
            }), 'V2Ray');
            if (rec.tun) {
                await waitForPort(XRAY.socks, 15000);
                must(await selfPost('/api/v2ray/tun', { enabled: true, source: rec.tunSource }), 'تونل کامل');
            }
        } else if (rec.kind === 'aether') {
            must(await selfPost('/api/aether/start', rec.opts || {}), 'موتور وارپ');
            if (rec.tun) {
                const deadline = Date.now() + 90000;
                while (!aether.getStatus().connected && aether.getStatus().running && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
                if (!aether.getStatus().connected) throw new Error('موتور وارپ وصل نشد، پس تونل کامل روشن نشد');
                must(await selfPost('/api/tun', { enabled: true }), 'تونل کامل');
            }
        } else if (rec.kind === 'gateway') {
            must(await selfPost('/api/gateway/connect', rec.opts || {}), 'گیت‌وی MLM');
        } else if (FRONT_ENGINES[rec.kind]) {
            // The SOCKS-front engines. Their start route already walks its own ladder and proves the
            // data path, so there is nothing to wait for afterwards except the tunnel — and the
            // tunnel is refused outright if the engine is not connected, so the order here is the
            // whole of the safety.
            const label = FRONT_ENGINES[rec.kind].label;
            must(await selfPost(`/api/${rec.kind}/start`, rec.opts || {}), `موتور ${label}`);
            if (rec.tun) must(await selfPost('/api/front/tun', { engine: rec.kind, enabled: true }), 'تونل کامل');
        }
        log('✅ اتصال برگشت.');
    } catch (e) {
        log(`❌ برنگشت — ${e.message}. از پنل خودش دوباره وصل کنید.`);
    }
}

// ── Settings › درباره › «به‌روزرسانی نرم‌افزار» (update-manager.js) ─────────────────────────
app.get('/api/update', (req, res) => { res.json(require('./update-manager').status()); });
app.post('/api/update/check', async (req, res) => {
    try { res.json(await require('./update-manager').check()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/update/download', (req, res) => {
    try { res.json(require('./update-manager').startDownload()); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/update/install', (req, res) => {
    try { res.json(require('./update-manager').install()); } catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/update', (req, res) => {
    try { res.json(require('./update-manager').setAutoDownload(!!(req.body && req.body.autoDownload))); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── Settings › درباره › «گزارش خطا» (crash-reporter.js) ─────────────────────────────────────
app.get('/api/crash', (req, res) => {
    const c = require('./crash-reporter');
    res.json({ reports: c.list().map(({ name, at, kind, title }) => ({ name, at, kind, title })), dir: c.DIR });
});
app.get('/api/crash/read', (req, res) => {
    try { res.type('text/plain; charset=utf-8').send(require('./crash-reporter').read(req.query.name)); }
    catch (e) { res.status(404).json({ error: e.message }); }
});
app.post('/api/crash/reveal', (req, res) => {
    try { require('./crash-reporter').reveal(); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/crash/clear', (req, res) => {
    res.json({ removed: require('./crash-reporter').clear() });
});

// ── Settings › «منابع کلادفلر» (cf-resources.js) ────────────────────────────────────────────
// POST, all of them: the account's token rides in the body, never in a URL.
const cfRoute = (fn) => async (req, res) => {
    const b = req.body || {};
    if (!b.account || !b.account.token) return res.status(400).json({ error: 'حساب کلادفلر همراه درخواست نیست.' });
    try { res.json(await fn(b)); }
    catch (e) {
        const m = e && e.response && e.response.data && e.response.data.errors && e.response.data.errors[0];
        res.status(502).json({ error: (m && m.message) || e.message });
    }
};
app.post('/api/cf/overview', cfRoute((b) => require('./cf-resources').overview(b.account)));
app.post('/api/cf/list', cfRoute((b) => {
    const cf = require('./cf-resources');
    if (b.kind === 'workers') return cf.workers(b.account);
    if (b.kind === 'd1') return cf.d1(b.account);
    if (b.kind === 'kv') return cf.kv(b.account);
    throw new Error('نوع منبع شناخته نشد.');
}));
app.post('/api/cf/kv-keys', cfRoute((b) => require('./cf-resources').kvKeys(b.account, b.id)));
app.post('/api/cf/delete', cfRoute((b) => require('./cf-resources').remove(b.account, b.kind, b.ids)));

// ── «مسیر برنامه‌ها»: which apps use the tunnel (app-routing.js, app-catalog.js) ──────────
// Saving applies to a running tunnel at once, through the rebuild each engine already owns:
// V2Ray's re-measures its node, WARP's refreshes its uplink addresses, and tun-manager's generic
// one covers the rest. With nothing running it applies at the next connect — tun-manager reads
// the choice at every build. Holding the tunnel lock keeps the WARP watchdog from judging the
// few seconds of rebuild as an outage.
async function applyAppRoutingNow() {
    if (!tun.isRunning()) return { applied: false, reason: 'no-tunnel' };
    if (v2rayTunWanted) {
        v2rayTunUplinkKey = '';   // rebuild although the node did not move
        await v2rayTunRefreshUplink();
        return { applied: tun.isRunning() };
    }
    await withTunLock('app-routing', async () => {
        if (!tun.isRunning()) return;
        if (aetherTunWanted) {
            aetherTunOptions = Object.assign({}, aetherTunOptions, { uplinkIps: aether.getUplinkIps() });
            tun.stopTun(aetherBroadcastLog, 'app-routing changed');
            await tun.startTun(aether.SOCKS_PORT, aetherBroadcastLog, aetherTunOptions);
            aetherTunSettledAt = Date.now();
        } else {
            await tun.rebuild(tunBroadcastLog);
        }
    });
    broadcast('tun', { running: tun.isRunning(), wanted: true });
    return { applied: tun.isRunning() };
}
app.get('/api/app-routing', (req, res) => {
    res.json(Object.assign(require('./app-routing').get(), { tunnel: tun.isRunning() }));
});
app.post('/api/app-routing', async (req, res) => {
    try {
        const saved = require('./app-routing').set(req.body || {});
        let applied;
        try { applied = await applyAppRoutingNow(); } catch (e) { applied = { applied: false, error: e.message }; }
        res.json(Object.assign({}, saved, applied, { tunnel: tun.isRunning() }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/app-routing/apps', async (req, res) => {
    try { res.json({ apps: await require('./app-catalog').list({ fresh: req.query.fresh === '1' }) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/app-routing/browse', async (req, res) => {
    try { res.json({ app: await require('./app-catalog').browse() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
});

// ── «دامین فرانتینگ»: the MITM domain-fronting profile (mitm-manager.js) ─────────────────
// The certificate is minted here and trusted only through Windows' own confirmation dialog;
// /trust waits for the user's answer. The runnable config comes back in /status once the
// certificate is trusted, and is started through /api/v2ray/start like any other config.
app.get('/api/mitm/status', async (req, res) => {
    try { res.json(await require('./mitm-manager').status()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/mitm/setup', async (req, res) => {
    try { const mitm = require('./mitm-manager'); await mitm.ensure(); res.json(await mitm.status()); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/mitm/trust', async (req, res) => {
    try { const mitm = require('./mitm-manager'); const r = await mitm.trust(); res.json(Object.assign(await mitm.status(), { declined: !!r.declined })); }
    catch (e) { res.status(500).json({ error: e.message }); }
});
// Taking the certificate away while the profile runs would break every fronted site mid-use.
function mitmProfileRunning() {
    const xrayManager = require('./xray-manager');
    const cfg = require('./mitm-manager').buildConfig();
    return !!cfg && xrayManager.isRunning() && xrayManager.getCurrentUri() === cfg;
}
app.post('/api/mitm/untrust', async (req, res) => {
    try {
        if (mitmProfileRunning()) return res.status(409).json({ error: 'دامین‌فرانتینگ الان وصل است — اول قطعش کنید.' });
        const mitm = require('./mitm-manager'); await mitm.untrust(); res.json(await mitm.status());
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/mitm/remove', async (req, res) => {
    try {
        if (mitmProfileRunning()) return res.status(409).json({ error: 'دامین‌فرانتینگ الان وصل است — اول قطعش کنید.' });
        const mitm = require('./mitm-manager');
        const r = await mitm.remove();
        res.json(Object.assign(await mitm.status(), { removed: r.removed }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v2ray/traffic', (req, res) => {
    try {
        const trafficMgr = require('./traffic-manager');
        const xrayManager = require('./xray-manager');
        const stats = trafficMgr.getTrafficStats();
        res.json({
            ...stats,
            running: xrayManager.isRunning(),
            uri: xrayManager.getCurrentUri()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/v2ray/ping', (req, res) => {
    const { ip, port } = req.body;
    if (!ip || !port) return res.status(400).json({ error: 'IP and port required' });

    if (ip && ip.includes(':')) {
        return res.json({ ping: -1 });
    }

    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(2000);

    socket.on('connect', () => {
        const time = Date.now() - start;
        socket.destroy();
        res.json({ ping: time });
    }).on('timeout', () => {
        socket.destroy();
        res.json({ ping: -1 });
    }).on('error', () => {
        socket.destroy();
        res.json({ ping: -1 });
    });

    socket.connect(port, ip);
});

// The SOCKS agent now lives in socks-agents.js so the scanner's Stage 3, the free-config
// tester and xray-tester.js all measure delay with exactly this code rather than three
// implementations of it.
const { SocksTlsAgent } = require('./socks-agents');

app.post('/api/v2ray/test-nodes', async (req, res) => {
    const { nodes, cleanIp, cleanPort, testType, settings = {} } = req.body;
    if (!nodes || !nodes.length) return res.json({ results: [] });

    const tester = require('./xray-tester');

    // The panel can be closed, the window reloaded, or the test cancelled in the middle of a
    // sweep over hundreds of nodes. Without this the cores stay up holding their ports and
    // every worker keeps probing through them against a client that is gone.
    //
    // IT MUST BE `res`, NEVER `req`. `req` is the REQUEST stream, and express.json() has
    // already read it to the end before this handler runs — so `req.on('close')` fires on the
    // very first tick, with the client still perfectly connected. Measured on this express:
    //     req close @0ms   writableEnded=false
    //     res close @3039ms writableEnded=true
    // Registering it here (rather than after a four-second port wait, where the old code
    // happened to put it and so never saw the event at all) aborted every sweep before a
    // single node was probed: the test config was written, the core came up, every worker
    // returned at its abort check, and the panel got a `done` line with no results — a dash
    // on every row. `writableEnded` is what separates "the client went away" from "we
    // finished normally", since res 'close' fires in both cases.
    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });

    const logFile = path.join(os.homedir(), '.mlmvpn', 'socket_test.log');
    const log = (msg) => {
        try { fs.appendFileSync(logFile, msg + '\n'); } catch (e) { }
        try { broadcast('core_log', msg); } catch (e) { }
    };

    const write = (obj) => {
        try { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); } catch (e) { }
    };

    let summary = { results: [], coreFailures: 0 };
    try {
        summary = await tester.testNodes({
            nodes, cleanIp, cleanPort, testType, settings,
            isAborted: () => aborted,
            log,
            onResult: (r) => write(Object.assign({ testType }, r)),
        });
    } catch (e) {
        // A failure of the TESTER is not a verdict on the nodes, and the panel must be able
        // to tell the two apart — every row showing "Timeout" because no core could run is
        // the exact symptom this route used to produce with a silent 500.
        log(`[Test] ${e.message}`);
        write({ fatal: true, error: e.message });
    }

    if (!res.writableEnded) {
        write({ done: true, tested: summary.results.length, coreFailures: summary.coreFailures });
        res.end();
    }
});


/**
 * «کدام کانفیگ ایران مناسب خط من است؟»
 *
 * The serverless configs have no server, so which one works is a property of the USER'S LINE,
 * not of the config — and with ten thousand users on ten thousand lines, "try them one by one"
 * is not an answer. This measures instead. See iran-tester.js for what each profile is asked
 * and why the resolver is tested once for the whole group rather than once per profile.
 *
 * The panel sends the profiles because they live there (components/iran-profiles.js); the
 * server never guesses which ones the user has.
 */
app.post('/api/iran/test', async (req, res) => {
    const { profiles } = req.body || {};
    if (!Array.isArray(profiles) || !profiles.length) return res.json({ results: [] });

    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });

    const write = (obj) => { try { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); } catch (e) { } };
    const log = (msg) => { try { broadcast('core_log', msg); } catch (e) { } };

    try {
        const summary = await require('./iran-tester').testProfiles({
            profiles,
            isAborted: () => aborted,
            log,
            onResult: (r) => write(r),
        });
        if (!res.writableEnded) { write({ done: true, tested: summary.results.length }); res.end(); }
    } catch (e) {
        write({ fatal: true, error: e.message });
        if (!res.writableEnded) res.end();
    }
});

/**
 * A subscription link, fetched by the SERVER.
 *
 * The panel used to `fetch(url)` straight from the renderer. Two things were wrong with that:
 * the page's origin is http://127.0.0.1:<port>, so any subscription host that does not send
 * CORS headers — most of them — failed with a browser error the user could not act on; and a
 * subscription host that is filtered was simply unreachable, since the renderer has no way
 * through the app's own tunnel. gtFetch has both: a direct attempt first, then the app's Xray.
 */
app.post('/api/v2ray/fetch-sub', async (req, res) => {
    const { url } = req.body || {};
    if (!/^https?:\/\//i.test(String(url || ''))) return res.status(400).json({ error: 'آدرس http/https لازم است' });
    try {
        const r = await gtFetch(String(url), { timeoutMs: 30000 });
        if (!r.ok) return res.status(502).json({ error: `سرور اشتراک پاسخ ${r.status} داد` });
        const content = await r.text();
        if (content.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'پاسخ لینک اشتراک بیش از حد بزرگ است' });
        res.json({ content });
    } catch (e) {
        res.status(502).json({ error: 'دریافت لینک اشتراک ناموفق بود: ' + e.message });
    }
});

// Connecting is not instant — the engine is stopped, a config is generated, a process is
// spawned, and in tunnel mode the adapter is rebuilt around the new node. Two of those
// overlapping race on core/config.json and on the single xray.exe the whole app shares, and
// the loser's process is the one left in the slot. Serialised, so the second click waits for
// the first instead of fighting it. (The panel disables its button, but «اتصال سریع»,
// «کانفیگ ایران», «ضد فیلتر SNI» and «دامین فرانتینگ» all drive this same route.)
let v2rayStartChain = Promise.resolve();
function withV2rayStartLock(fn) {
    const run = v2rayStartChain.then(fn, fn);
    v2rayStartChain = run.catch(() => {});
    return run;
}

app.post('/api/v2ray/start', async (req, res) => {
    const { uri, cleanIp, cleanPort, realIp, useSystemProxy, solo } = req.body;
    if (!uri) return res.status(400).json({ error: 'Config URI is required' });
    try {
      await withV2rayStartLock(async () => {
        // `solo`: use the config that was asked for and nothing else.
        //
        // generateXrayConfig always merged every «زیرساخت ابری» config into a leastPing
        // balancer alongside the chosen one. That is right for the cloud panel, and wrong for
        // a user who ticked one row in the V2Ray list and pressed connect: the balancer has no
        // observation data in its first minute, so the traffic could leave through a different
        // — possibly stale — node while the panel named the one that was clicked. Hence a
        // choice the caller makes, rather than one shape for everybody.
        await startXray(uri, cleanIp, cleanPort, realIp, useSystemProxy, (log) => {
            if (typeof log === 'string' && log.includes('__traffic_update__')) {
                try {
                    const parsed = JSON.parse(log);
                    wss.clients.forEach(c => {
                        if (c.readyState === 1) c.send(JSON.stringify({ type: 'traffic_update', data: parsed }));
                    });
                    return;
                } catch (e) { }
            }
            wss.clients.forEach(c => {
                if (c.readyState === 1) c.send(JSON.stringify({ type: 'core_log', data: log }));
            });
        }, { solo: !!solo });
        // A different node means a different uplink address, and the exclusion rule is
        // written into sing-box's config at start — it does not reread it. Left alone, the
        // tunnel would exclude the previous node's address while capturing the new one and
        // feeding it back into Xray: connected, adapter up, nothing loads.
        //
        // This line was dead until the engine stopped tearing the adapter down on its way up.
        // startXray() began with the synchronous stopXray(), which stops the TUN first — so by
        // the time control arrived here tun.isRunning() was already false, the refresh returned
        // at its first guard, and the machine was left with v2rayTunWanted true, a green
        // switch, Xray still in its full-tunnel shape and no tunnel at all. See
        // xray-manager.killXrayProcess.
        if (v2rayTunWanted) await v2rayTunRefreshUplink();
        // Settings › «VPN همیشه روشن»: the connection to bring back at the next logon. An SNI
        // config dials the local front, so the front's own config is kept with it.
        try {
            const sniMgr = require('./sni-manager');
            const sni = /@127\.0\.0\.1:40443(?:[/?#]|$)/.test(String(uri)) && sniMgr.isSniRunning() ? sniMgr.getActiveSniConfig() : null;
            require('./system-settings').rememberConnection({ kind: 'v2ray', uri, cleanIp, cleanPort, realIp, useSystemProxy: !!useSystemProxy, sni, tun: v2rayTunWanted, tunSource: v2rayTunSource });
        } catch (e) { /* nothing to replay */ }
      });
        res.json({ message: 'Xray Started' });
    } catch (err) {
        // The message reaches the user verbatim, so it carries the core's own words (see
        // xray-manager.startXray) and not `(__dirname: G:\ip scanner)` glued onto the end of
        // them, which is what the panel used to show when a connect failed.
        res.status(500).json({ error: err.message || 'اتصال برقرار نشد', code: err.code || null });
    }
});

app.post('/api/v2ray/stop', async (req, res) => {
    try {
        // Order matters: the tunnel comes down FIRST. Stopping the engine while the adapter
        // still owns the default route hands every packet on the machine to a SOCKS port
        // with nothing behind it — the user is offline and cannot even open a page to find
        // out why. See v2rayTunTeardownIfUp.
        await v2rayTunTeardownIfUp('کاربر قطع کرد');
        // The non-blocking stop: the synchronous one froze the whole window (the server runs in
        // Electron's main process) — «بعد قطع کردن v2ray کل اپ فریز میشه».
        await require('./xray-manager').stopXrayAsync();
        try { require('./system-settings').forgetConnection('v2ray'); } catch (e) { /* none kept */ }
        res.json({ message: 'Xray Stopped' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Legacy endpoint. It used to hardcode port 10809, which nothing listens on — enabling it
// pointed Windows at a dead port and silently killed all connectivity. Delegate to the same
// guarded path the UI uses so there is exactly one implementation and one correct port.
app.post('/api/v2ray/sysproxy', async (req, res) => {
    const enable = !!(req.body && req.body.enable);
    try {
        // The two modes are alternatives, not layers. With the tunnel up, a browser pointed
        // at the proxy sends its traffic to Xray, whose own reply packets are captured by the
        // adapter and fed back in. Choosing the proxy is therefore choosing it — the tunnel
        // comes down rather than both being half-on.
        if (enable && v2rayTunWanted) {
            await v2rayTunTeardownIfUp('کاربر پراکسی سیستم را انتخاب کرد');
        }
        if (enable && !(await portIsLive(XRAY.http))) {
            return res.status(409).json({
                error: `موتور Xray اجرا نیست (پورت ${XRAY.http} خالی است).`,
                code: 'XRAY_NOT_RUNNING',
            });
        }
        const { enableSystemProxy, setSystemProxyIntent } = require('./xray-manager');
        await enableSystemProxy(enable, XRAY.http);
        // So the next rebuild of the config reproduces the state the user is actually in. A
        // proxy turned on from this switch used to be silently turned off again by any later
        // restart (a settings change, the tunnel toggle), because only a connect ever wrote
        // that field.
        setSystemProxyIntent(enable);
        broadcast('system_proxy', readSystemProxy());
        try { require('./system-settings').updateConnection('v2ray', enable ? { useSystemProxy: true, tun: false } : { useSystemProxy: false }); } catch (e) { /* none kept */ }
        res.json({ message: 'Proxy settings updated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ── V2Ray full-tunnel ───────────────────────────────────────────────────────────────
//
// Same adapter, same guards, different engine: sing-box takes the default route and hands
// everything to Xray's SOCKS inbound instead of Aether's. That is what closes the leaks the
// system proxy leaves open — Windows itself, non-proxy-aware apps, and above all DNS, which
// with a proxy still goes to the ISP in cleartext.
//
// There is only ONE tunnel adapter, so this and Aether's tunnel are the same resource. Every
// transition here therefore takes the same lock and clears Aether's intent, or the watchdog
// would rebuild Aether's tunnel on top of this one five seconds later.
let v2rayTunWanted = false;
// Whether the system proxy was on when the tunnel took over. The tunnel switches it off
// because the two cannot coexist, so switching the tunnel off has to give it back —
// otherwise a user who arrived with the proxy on leaves this round trip connected to a node
// that nothing on the machine is pointed at, with no error to explain it.
let v2rayProxyBeforeTun = false;
// The TUN messages belong to the shared core-log channel, whichever engine is carrying
// the tunnel — the user reads one log, not one per engine.
const tunBroadcastLog = aetherBroadcastLog;

/** Poll until `port` accepts connections again, or give up at `timeoutMs`. */
async function waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await portIsLive(port)) return true;
        await new Promise(r => setTimeout(r, 250));
    }
    return false;
}

/**
 * Switch Xray between its split-routing shape and its full-tunnel shape.
 *
 * Every caller goes through here because the failure mode is nasty and easy to hide:
 * `restartXray` STOPS the engine before it starts it again, so any error in between leaves
 * Xray dead. Swallowed (as a bare `.catch(() => {})` does), the user is left pressing a
 * tunnel switch that answers "the engine is not running — connect to a config first" over a
 * node the panel still shows as connected, with nothing anywhere saying what happened.
 *
 * So a failure here is reported, the mode flag is put back, and one attempt is made to bring
 * the engine up in its previous shape rather than leaving the machine with no engine at all.
 */
async function applyXrayTunnelMode(on, log) {
    const xray = require('./xray-manager');
    const previous = xray.getFullTunnelMode();
    if (previous === !!on) return true;

    xray.setFullTunnelMode(!!on);
    try {
        if (await xray.restartXray(log)) {
            // WAIT FOR THE PORT TO COME BACK.
            //
            // restartXray stops Xray and starts it again, so the SOCKS listener is gone for
            // a moment. startTun's very first act is to check that same port and refuse when
            // it is empty — so without this wait, turning the tunnel on failed with "the
            // engine is not running, connect it first" over an engine that was, in fact,
            // restarting because we asked it to. The bind takes well under a second; the
            // budget is generous because a slow machine must not be told a lie about its own
            // engine.
            const ready = await waitForPort(XRAY.socks, 10000);
            if (!ready) {
                log(`[TUN] ❌ موتور Xray بعد از بازسازی روی پورت ${XRAY.socks} بالا نیامد.`);
                xray.setFullTunnelMode(previous);
                return false;
            }
            return true;
        }
        // Nothing to restart — no live engine and no remembered config.
        xray.setFullTunnelMode(previous);
        return false;
    } catch (e) {
        xray.setFullTunnelMode(previous);
        log(`[TUN] ❌ بازسازی کانفیگ Xray ناموفق بود: ${e.message}`);
        try {
            await xray.restartXray(log);
            log('[TUN] موتور Xray با تنظیمات قبلی برگشت.');
        } catch (e2) {
            log('[TUN] ❌ موتور Xray بالا نیامد — یک‌بار دستی به کانفیگ وصل شوید.');
        }
        return false;
    }
}

/** Xray's own node addresses — MUST stay outside the tunnel it is carrying. */
// Which of Android's methods this Xray tunnel is, for its MTU (Settings › تنظیمات پیشرفته VPN ›
// MTU): «ضد فیلتر SNI» when the running config points at the local SNI front, «اتصال سریع» when
// that panel turned the tunnel on, V2Ray otherwise.
let v2rayTunSource = 'v2ray';
function v2rayTunMethod() {
    let uri = '';
    try { uri = require('./xray-manager').getCurrentUri() || ''; } catch (e) { /* no config */ }
    if (/@127\.0\.0\.1:40443(?:[/?#]|$)/.test(uri)) return 'sni';
    return v2rayTunSource === 'quick' ? 'quick' : 'v2ray';
}

function v2rayTunOptions() {
    const { getUplinkTargets } = require('./xray-manager');
    const targets = getUplinkTargets();
    return {
        processName: 'xray.exe',
        engineLabel: 'V2Ray',
        engineTag: 'v2ray',
        // EVERY CONNECTION, WITH THE OUTBOUND IT TOOK — when it is asked for.
        //
        // At 'warn' the engine logs only failures, so a tunnel that is up and carries nothing
        // writes NOTHING and «تونل وصل است ولی هیچ دیتایی رد نمی‌شود» cannot be investigated at
        // all: 35 seconds of a dead tunnel produced four lines, none about the user's traffic.
        // At 'info' each connection names its outbound, which separates "the packets never
        // arrived" from "they arrived and went direct" from "they went to the node and stalled".
        //
        // The file is capped at 4 MB, but the PIPE is not: every line is read, split and
        // broadcast in Electron's main thread, and sing-box blocks on its own log write while
        // that thread is busy. That is throughput taken from the tunnel to describe it, so it is
        // now the user's lever (Settings › تنظیمات پیشرفته VPN › «لاگ دقیق تونل») rather than
        // always on. What replaced it for everyday use is the passive record in
        // ~/.mlmvpn/tunnel-events.log, which costs nothing and answers the same question.
        logLevel: tunLogLevel(),
        mtuMethod: v2rayTunMethod(),
        // Aether's registration host is not this engine's business — see apiSuffixes.
        apiSuffixes: [],
        // this path verifies throughput itself, right after the adapter is up
        skipThroughputProbe: true,
        // NO static Cloudflare/WARP ranges here — those are Aether's uplink, not Xray's.
        //
        // Inheriting that list would send every connection to 162.159.x / 188.114.x
        // straight out the physical interface, and a large slice of the ordinary web sits
        // on exactly those addresses. That is a hole in a mode whose entire promise is
        // "no leaks". Xray's node is excluded precisely instead, by /32 and by name below.
        uplinkCidrs: [],
        // Xray's socks inbound is created with `udp: true`, so DNS and QUIC ride the tunnel.
        supportsUdp: true,
        uplinkIps: targets.ips,
        uplinkDomains: targets.domains,
    };
}

/**
 * v2rayTunOptions(), plus what only a measurement through the live node can say: which
 * resolver it reaches and over what, and whether QUIC survives it. Throws when no lookup
 * gets through at all — a tunnel over such a node would be "on" with nothing passing, which
 * is exactly what the user found on their own worker. See tun.pickTunnelResolver.
 */
async function measureV2rayTunOptions(log) {
    const opts = v2rayTunOptions();
    // Settings › «سرور DNS بک‌اند»: an address the user chose is tried first inside the tunnel
    // too, as Android uses it for every engine — still only if this node actually reaches it.
    let candidates;
    try {
        const chosen = require('./network-settings').get().backendDns;
        if (net.isIPv4(chosen)) candidates = [...new Set([chosen, '8.8.8.8', '1.1.1.1', '9.9.9.9'])];
    } catch (e) { /* the default three */ }
    const resolver = await tun.pickTunnelResolver(XRAY.socks, candidates ? { candidates } : undefined);
    if (!resolver) {
        throw new Error(
            'هیچ پرس‌وجوی DNS از این نود رد نمی‌شود (نه UDP و نه TCP؛ 8.8.8.8، 1.1.1.1 و 9.9.9.9 امتحان شدند)، ' +
            'پس تونل کامل روشن نشد — اگر روشن می‌شد، هیچ برنامه‌ای نمی‌توانست نام سایت‌ها را پیدا کند.\n' +
            'همین کانفیگ را با «پراکسی سیستم» امتحان کنید یا نود دیگری انتخاب کنید.'
        );
    }
    opts.remoteDns = resolver.server;
    opts.supportsUdp = resolver.udp;
    const quicOk = resolver.udp
        ? await tun.socksCarriesUdp(XRAY.socks, { host: [8, 8, 8, 8], targetPort: 443 })
        : false;
    opts.rejectQuic = !quicOk;
    log(`[TUN] توان این نود: DNS از ${resolver.server} روی ${resolver.udp ? 'UDP' : 'TCP'} ✅ — QUIC ${quicOk ? '✅' : '❌ (رد می‌شود تا مرورگر بی‌درنگ به TCP برگردد)'}`);
    return opts;
}

app.get('/api/v2ray/tun/status', (req, res) => {
    let ready = true, reason = null;
    try { tun.checkPrerequisites(); } catch (e) { ready = false; reason = e.message; }
    res.json({ running: tun.isRunning() && v2rayTunWanted, wanted: v2rayTunWanted, ready, reason });
});

app.post('/api/v2ray/tun', async (req, res) => {
    const enable = !!(req.body && req.body.enabled);
    if (enable) v2rayTunSource = req.body.source === 'quick' ? 'quick' : 'v2ray';
    try {
        if (!enable) {
            const torn = await withTunLock('v2ray-tun-off', async () => {
                v2rayTunWanted = false;
                v2rayTunStopGuard();
                // stopTunAsync, not stopTun. The synchronous one is two taskkills with 5 s
                // timeouts around a 3 s Atomics.wait loop, and the server lives in Electron's
                // MAIN process — so turning the tunnel off froze the whole window for up to
                // 13 seconds. Same order, same end state, nothing blocked.
                await tun.stopTunAsync(tunBroadcastLog, 'user switched the tunnel off');
                const r = await tun.verifyTornDown(tunBroadcastLog);
                // Hand the system proxy back if the tunnel is what took it away. Done before
                // the rebuild so the rebuild replays it, rather than fighting it afterwards.
                if (v2rayProxyBeforeTun) {
                    require('./xray-manager').setSystemProxyIntent(true);
                    v2rayProxyBeforeTun = false;
                    tunBroadcastLog('[TUN] پراکسی سیستم که برای تونل خاموش شده بود، برگشت.');
                }
                // Back to the split rules: without the tunnel, sending Iranian traffic and
                // DNS through the proxy is pure slowdown for no privacy gain.
                await applyXrayTunnelMode(false, tunBroadcastLog);
                broadcast('system_proxy', Object.assign(readSystemProxy(), { port: XRAY.http }));
                return r;
            });
            broadcast('tun', { running: false, wanted: false });
            try { require('./system-settings').updateConnection('v2ray', { tun: false }); } catch (e) { /* none kept */ }
            return res.json({ ok: true, running: false, cleanedUp: torn.ok });
        }

        // Refuse rather than take the machine offline: with no engine behind the SOCKS port,
        // the default route would point at nothing and the user would have no way back.
        if (!(await portIsLive(XRAY.socks))) {
            return res.status(409).json({
                error: `موتور Xray اجرا نیست (پورت ${XRAY.socks} خالی است). ` +
                       'اول به یک کانفیگ وصل شوید، بعد تونل کامل را روشن کنید.',
                code: 'XRAY_NOT_RUNNING',
            });
        }

        await withTunLock('v2ray-tun-on', async () => {
            // The system proxy and the tunnel cannot coexist: the browser would send its
            // traffic to Xray, whose own reply packets are captured by the adapter and fed
            // back in. Drop it first so the two never overlap even for a moment.
            // Clear the INTENT as well as the setting. applyXrayTunnelMode() below rebuilds
            // the engine through restartXray(), which replays lastStartArgs — and that record
            // still said useSystemProxy:true for anyone who had connected with the proxy on.
            // So the proxy came straight back two steps after being turned off, and the panel's
            // switch, set from this broadcast, said it had not. Both were then live at once:
            // the browser handed its traffic to Xray while the adapter captured Xray's replies.
            v2rayProxyBeforeTun = readSystemProxy().enabled;
            require('./xray-manager').setSystemProxyIntent(false);
            if (readSystemProxy().enabled) {
                await require('./xray-manager').enableSystemProxy(false, XRAY.http);
                aetherBroadcastLog('[TUN] پراکسی سیستم خاموش شد (با تونل کامل قابل جمع نیست).');
                broadcast('system_proxy', Object.assign(readSystemProxy(), { port: XRAY.http }));
            }

            // Aether owns the same adapter. Clearing the INTENT is what matters — a bare
            // stopTun would leave its watchdog to rebuild it seconds later, and the two
            // would then take turns owning the default route.
            if (aetherTunWanted || tun.isRunning()) {
                aetherTunWanted = false;
                aetherStopWatchdog();
                await aetherReleaseFailClosed('کاربر تونل V2Ray را انتخاب کرد');
                tun.stopTun(tunBroadcastLog, 'handover to the V2Ray tunnel');
                await tun.verifyTornDown(tunBroadcastLog);
            }

            // REBUILD XRAY FIRST — its split rules are wrong for this mode.
            //
            // Xray's config sends DNS and everything geoip:ir straight out the physical
            // interface. That is correct behind the system proxy and a deanonymisation
            // underneath a whole-system tunnel: the hijacked lookups leave in the clear, the
            // ISP answers them with a poisoned Iranian address, and the geoip:ir rule then
            // sends the connection out in the clear too — which is why the user's IP still
            // read as Iranian with the tunnel switch on. Rebuilt before the probes, so what
            // they measure is the config that will actually carry traffic.
            if (!(await applyXrayTunnelMode(true, tunBroadcastLog))) {
                throw new Error('کانفیگ Xray برای حالت تونل بازسازی نشد — یک‌بار به کانفیگ وصل شوید و دوباره امتحان کنید.');
            }
            tunBroadcastLog('[TUN] قوانین عبور مستقیم (DNS و سایت‌های ایرانی) برای حالت تونل غیرفعال شد.');

            // ASK THE NODE WHAT IT CAN CARRY, then build the tunnel around the answer.
            //
            // "Which protocols work" is a property of the node, not of VLESS: a VPS carries
            // everything, while the same config pointed at a Cloudflare Worker carries UDP
            // for port 53 and nothing else — the worker closes every other UDP association.
            // Measured on this machine: DNS/53 succeeded 6 times out of 6, QUIC/443 failed
            // 3 out of 3. Assuming QUIC works is what made YouTube unplayable through the
            // tunnel while the same node played it fine through the system proxy: Chrome
            // prefers QUIC, the packets vanished, and it waited out its own timeout on every
            // connection instead of being told "no" and falling back to TCP.
            // The resolver is the same kind of question: a worker cannot reach 1.1.1.1 at all,
            // which is how a fixed 1.1.1.1 left the tunnel on with every lookup dead.
            const opts = await measureV2rayTunOptions(tunBroadcastLog);

            await tun.startTun(XRAY.socks, tunBroadcastLog, opts);

            // NO FAKE TUNNEL.
            //
            // startTun proves the SOCKS engine answers, which is not the same as the machine
            // being able to reach the internet through the adapter it just installed. Pull a
            // real payload through the finished tunnel and refuse to report success if it
            // does not arrive — a switch left "on" over a tunnel that carries nothing is
            // worse than a failed start, because the user believes they are protected and
            // stops looking for the problem.
            // Retried, and with a DNS-free last resort — see verifyTunCarriesTraffic. The
            // first version of this check failed on `getaddrinfo ENOTFOUND` one second after
            // the adapter appeared and tore down a perfectly good tunnel, which from the
            // user's side looked like "it connects and then immediately drops".
            if (!(await tun.verifyTunCarriesTraffic(tunBroadcastLog, { bytes: 262144 }))) {
                throw new Error(
                    'تونل بالا آمد ولی دیتا از آن رد نشد، بنابراین روشن نشد و همه‌چیز به حالت قبل برگشت.\n' +
                    'همین کانفیگ را با «پراکسی سیستم» امتحان کنید؛ اگر آنجا کار می‌کند، نود برای تونل کامل مناسب نیست.'
                );
            }

            v2rayTunUplinkKey = [...opts.uplinkIps, ...opts.uplinkDomains].sort().join(',');
            v2rayTunWanted = true;
            v2rayTunStartGuard();

            // What the finished tunnel is actually doing, recorded in its own log: the route,
            // whether the node's own name still resolves, and — the one that matters — the
            // address the far end sees. A tunnel that is "up" while the exit IP is the user's
            // own line is the failure this app must never report as success, and until now
            // nothing asked. Awaited but never fatal: the tunnel is already verified, and a
            // diagnosis that can break what it diagnoses is worse than none.
            try { await tun.tunVerdict(tunBroadcastLog, { uplinkDomains: opts.uplinkDomains }); }
            catch (e) { tunBroadcastLog(`[TUN] گزارش وضعیت تونل گرفته نشد: ${e.message}`); }
        });

        broadcast('tun', { running: true, wanted: true });
        try { require('./system-settings').updateConnection('v2ray', { tun: true, tunSource: v2rayTunSource, useSystemProxy: false }); } catch (e) { /* none kept */ }
        res.json({ ok: true, running: true });
    } catch (err) {
        // A failed start must not leave the machine routing into a half-built tunnel.
        await withTunLock('v2ray-tun-failed', async () => {
            v2rayTunWanted = false;
            v2rayTunStopGuard();
            await tun.stopTunAsync(tunBroadcastLog, 'v2ray start failed');
            await tun.verifyTornDown(tunBroadcastLog);
            await applyXrayTunnelMode(false, tunBroadcastLog);
        });
        broadcast('tun', { running: false, wanted: false });
        res.status(500).json({ error: err.message });
    }
});

/**
 * The user switched to another node while the tunnel was up — rebuild it around the new one.
 *
 * Cheap when nothing moved: the address set is compared first and an unchanged set returns
 * without touching the adapter. When it did move, sing-box has to be restarted, because the
 * exclusion lives in its config and it does not reread it. The blip costs about a second;
 * the alternative is a tunnel that swallows the engine's own uplink and carries nothing.
 */
let v2rayTunUplinkKey = '';
async function v2rayTunRefreshUplink() {
    if (!v2rayTunWanted) return;
    const opts = v2rayTunOptions();
    const key = [...opts.uplinkIps, ...opts.uplinkDomains].sort().join(',');
    // Nothing moved AND the adapter is still there: there is genuinely nothing to do. The
    // second half of that test is not redundant — an engine that died under a live tunnel
    // leaves the switch on with no adapter, and returning here would be agreeing with it.
    if (key === v2rayTunUplinkKey && tun.isRunning()) return;

    await withTunLock('v2ray-tun-uplink-refresh', async () => {
        if (!v2rayTunWanted) return;   // re-checked under the lock
        tunBroadcastLog(tun.isRunning()
            ? `[TUN] نود عوض شد (${key || 'بدون آدرس'}) — تونل با استثنای جدید بازسازی می‌شود.`
            : '[TUN] تونل روشن بود ولی آداپتور بالا نبود — دوباره ساخته می‌شود.');
        await tun.stopTunAsync(tunBroadcastLog, 'node changed - rebuilding');
        // A new node answers the resolver question anew — measured here, with the old
        // tunnel down so the probe does not loop through it. A node that carries no lookups
        // gets no tunnel: the switch goes off and says why, instead of staying on over a
        // tunnel where nothing resolves.
        let measured;
        try {
            measured = await measureV2rayTunOptions(tunBroadcastLog);
        } catch (e) {
            tunBroadcastLog(`[TUN] ❌ ${e.message.split('\n')[0]}`);
            v2rayTunWanted = false;
            v2rayTunStopGuard();
            await tun.verifyTornDown(tunBroadcastLog);
            await applyXrayTunnelMode(false, tunBroadcastLog);
            broadcast('tun', { running: false, wanted: false });
            return;
        }
        try {
            await tun.startTun(XRAY.socks, tunBroadcastLog, measured);
        } catch (e) {
            // The rebuild failed. Saying nothing would leave the panel's switch green over a
            // machine with no tunnel — the exact state this whole path exists to prevent — so
            // the intent is dropped, the split rules come back, and the UI is told.
            tunBroadcastLog(`[TUN] ❌ تونل بعد از تعویض نود بالا نیامد: ${e.message.split('\n')[0]}`);
            v2rayTunWanted = false;
            v2rayTunStopGuard();
            await tun.verifyTornDown(tunBroadcastLog);
            await applyXrayTunnelMode(false, tunBroadcastLog);
            broadcast('tun', { running: false, wanted: false });
            return;
        }
        v2rayTunUplinkKey = key;
        v2rayTunStartGuard();
        broadcast('tun', { running: true, wanted: true });
    });
}

/**
 * Watch for the engine dying under a live tunnel.
 *
 * Aether has a full watchdog; this one has a single job, because the failure it covers is
 * total: with the adapter holding the default route and no engine behind the SOCKS port,
 * every packet on the machine goes to a listener that is not there. Nothing recovers from
 * that on its own and the user cannot even open a page to find out why.
 *
 * TWO consecutive misses, not one. The port legitimately disappears for a second whenever
 * Xray is restarted — switching nodes does exactly that — and tearing the tunnel down on a
 * restart we asked for would be its own bug.
 */
let v2rayTunGuardTimer = null;
let v2rayTunGuardMisses = 0;

function v2rayTunStartGuard() {
    if (v2rayTunGuardTimer) return;
    v2rayTunGuardMisses = 0;
    v2rayTunGuardTimer = setInterval(async () => {
        try {
            if (!v2rayTunWanted || tunTransitionInProgress()) { v2rayTunGuardMisses = 0; return; }
            // THE ADAPTER, TOO — not only the port behind it.
            //
            // A live SOCKS port says the engine is fine; it says nothing about whether the
            // tunnel that is supposed to be feeding it still exists. When sing-box dies on its
            // own (or is force-killed and leaves nothing behind), this switch stayed green and
            // `/api/v2ray/tun/status` answered running:false to a panel that only asks on a
            // click — so the user was told, indefinitely, that traffic was going through a
            // tunnel that was not there. Reported once, and the intent is dropped with it.
            if (!tun.isRunning()) {
                tunBroadcastLog('[TUN] ⚠️ آداپتور تونل از بین رفته بود — حالت تونل خاموش شد.');
                tunEvent('v2ray-guard', { reason: 'tun-process-gone' });
                await v2rayTunTeardownIfUp('آداپتور تونل از بین رفت');
                return;
            }
            // A LOOPBACK CONNECT THAT TIMED OUT IS NOT AN ENGINE THAT DIED.
            //
            // This check used to be one 700 ms connect, twice in a row, and its failure tears the
            // whole tunnel down. 700 ms is an eternity for a loopback accept — and also exactly
            // what this app cannot guarantee, because the check runs in Electron's MAIN thread:
            // while that thread is busy (an engine's log pipe, a settings write, a big JSON
            // parse), the connect callback is queued behind the work and the timer fires first.
            // The tunnel then dies of the app's own load, and the user sees «خودش قطع شد».
            //
            // So: a longer window, three consecutive misses instead of two, and every miss on
            // the record with how long the event loop itself was blocked — which is the number
            // that tells these two failures apart afterwards.
            const askedAt = Date.now();
            if (await portIsLive(XRAY.socks, 2500)) { v2rayTunGuardMisses = 0; return; }
            tunEvent('engine-miss', {
                port: XRAY.socks, miss: v2rayTunGuardMisses + 1, waited: `${Date.now() - askedAt}ms`,
            });
            if (++v2rayTunGuardMisses < 3) return;
            await v2rayTunTeardownIfUp('موتور دیگر پاسخ نمی‌دهد');
        } catch (e) { /* a failing guard must never take the server down */ }
    }, 5000);
    if (v2rayTunGuardTimer.unref) v2rayTunGuardTimer.unref();
}

function v2rayTunStopGuard() {
    if (v2rayTunGuardTimer) clearInterval(v2rayTunGuardTimer);
    v2rayTunGuardTimer = null;
    v2rayTunGuardMisses = 0;
}

/**
 * Xray went away while its tunnel held the default route.
 *
 * Every packet on the machine is being handed to a SOCKS port with nothing behind it, so the
 * user is offline and cannot even open a page to find out why. Tearing the adapter down
 * restores normal routing at once. Called from the disconnect path AND whenever the engine
 * dies on its own.
 */
async function v2rayTunTeardownIfUp(reason) {
    if (!v2rayTunWanted) return;
    await withTunLock('v2ray-tun-engine-gone', async () => {
        v2rayTunWanted = false;
        v2rayTunUplinkKey = '';
        v2rayTunStopGuard();
        require('./xray-manager').setFullTunnelMode(false);
        aetherBroadcastLog(`[TUN] موتور V2Ray متوقف شد (${reason}) — تونل کامل برداشته شد تا اینترنت سیستم برنگردد به حالت قطع.`);
        // Awaited, not synchronous: this runs on a click, in Electron's main process.
        await tun.stopTunAsync(tunBroadcastLog, `v2ray teardown: ${reason}`);
        await tun.verifyTornDown(tunBroadcastLog);
    });
    broadcast('tun', { running: false, wanted: false });
}

// ── free public configs ─────────────────────────────────────────────────────────────
//
// The heavy lifting lives in free-configs.js; these routes are the thin edge of it. The
// job streams its progress over the existing websocket instead of holding an HTTP request
// open for minutes: a run over ten thousand entries takes as long as it takes, and the
// user must be able to watch it, stop it, and keep what was found.
const freeConfigs = require('./free-configs');

app.get('/api/free-configs/catalog', async (req, res) => {
    try {
        res.json({ ok: true, ...(await freeConfigs.getCatalog({ force: req.query.force === '1' })) });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// How many of a pool this app can actually RUN, which is not the same as how many exist:
// protocols the core does not speak and duplicate endpoints are dropped first, and the
// user should be told the real number before choosing how many to test.
app.get('/api/free-configs/pool/:id', async (req, res) => {
    try {
        const entries = await freeConfigs.loadPool(req.params.id);
        const stats = freeConfigs.poolStats(req.params.id) || {};
        const protocols = {};
        entries.forEach(e => { protocols[e.protocol] = (protocols[e.protocol] || 0) + 1; });
        res.json({ ok: true, usable: entries.length, unusable: stats.unusable || 0, protocols });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

app.post('/api/free-configs/start', async (req, res) => {
    const poolId = String((req.body && req.body.pool) || 'verified');
    const want = Math.max(1, Math.min(parseInt((req.body && req.body.count) || 20, 10) || 20, 500));
    if (freeConfigs.jobRunning()) return res.status(409).json({ error: 'یک جست‌وجو در حال اجراست.' });

    // Answer immediately; the run reports itself over the socket. Awaiting it here would
    // hit the request timeout long before a large run finished.
    res.json({ ok: true, started: true, pool: poolId, count: want });

    freeConfigs.startJob({
        poolId,
        want,
        onEvent: (ev) => broadcast('free_configs', ev),
    }).catch((e) => broadcast('free_configs', { type: 'error', message: e.message }));
});

app.post('/api/free-configs/stop', (req, res) => {
    res.json({ ok: true, stopped: freeConfigs.stopJob() });
});

// ── «اتصال سریع» ─────────────────────────────────────────────────────────────────────
//
// A ready-made server pool with a country picker and a single connect button.
//
// This block deliberately owns NO part of the connection itself. Starting the engine, the
// system proxy and the full tunnel each already have one guarded implementation, reached
// through /api/v2ray/*, and the panel drives those in order. A second path to the same
// three switches would be a second place that can disagree about whether the machine is
// protected — the one bug class this app cannot afford.
const quick = require('./quick-connect');

app.get('/api/quick/catalog', async (req, res) => {
    try {
        res.json({ ok: true, ...(await quick.catalog({ force: req.query.force === '1' })) });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

// The list for one country. Capped because the biggest country holds ~600 entries and the
// panel only ever shows a page of them; `total` still reports the real size.
app.get('/api/quick/nodes', async (req, res) => {
    try {
        const country = String(req.query.country || 'all');
        const limit = Math.max(1, Math.min(parseInt(req.query.limit || '300', 10) || 300, 1000));
        const all = await quick.nodesFor(country);
        res.json({ ok: true, total: all.length, nodes: all.slice(0, limit) });
    } catch (e) {
        res.status(502).json({ error: e.message });
    }
});

app.post('/api/quick/scan', async (req, res) => {
    const country = String((req.body && req.body.country) || 'all');
    const want = Math.max(1, Math.min(parseInt((req.body && req.body.want) || 12, 10) || 12, 100));
    // «از چند کشور» — 0 means "don't balance", which is the single-country and the plain
    // sweep. Capped at 20 because the feed rarely labels more than that many countries with
    // enough servers to be worth a share of the run.
    const countries = Math.max(0, Math.min(parseInt((req.body && req.body.countries) || 0, 10) || 0, 20));
    if (quick.scanRunning()) return res.status(409).json({ error: 'یک جست‌وجو در حال اجراست.' });

    // Answer immediately and report over the socket: sweeping thousands of endpoints takes
    // far longer than any sane request timeout.
    res.json({ ok: true, started: true, country, want, countries });

    quick.startScan({
        country,
        want,
        countries,
        onEvent: (ev) => broadcast('quick_event', ev),
    }).catch((e) => broadcast('quick_event', { type: 'error', message: e.message }));
});

/**
 * Re-measure the servers the user already has — «تست دوبارهٔ سرورهای من», as on Android.
 *
 * The list is sent by the panel rather than read from a store here: the proven servers live in
 * the renderer's own storage (the same place the chosen country and mode live), so the server
 * has no copy to go stale against.
 */
app.post('/api/quick/retest', async (req, res) => {
    const nodes = Array.isArray(req.body && req.body.nodes) ? req.body.nodes.slice(0, 100) : [];
    if (!nodes.length) return res.status(400).json({ error: 'سروری برای آزمایش دوباره فرستاده نشد.' });
    if (quick.scanRunning()) return res.status(409).json({ error: 'یک جست‌وجو در حال اجراست.' });

    res.json({ ok: true, started: true, count: nodes.length });
    quick.retestNodes(nodes, (ev) => broadcast('quick_event', ev))
        .catch((e) => broadcast('quick_event', { type: 'error', message: e.message }));
});

app.post('/api/quick/scan/stop', (req, res) => {
    res.json({ ok: true, stopped: quick.stopScan() });
});

/** Everything the panel needs to draw its own state without guessing. */
app.get('/api/quick/status', async (req, res) => {
    let tunReady = true, tunReason = null;
    try { tun.checkPrerequisites(); } catch (e) { tunReady = false; tunReason = e.message; }
    const proxy = readSystemProxy();
    res.json({
        ok: true,
        engine: await portIsLive(XRAY.socks),
        socksPort: XRAY.socks,
        httpPort: XRAY.http,
        systemProxy: !!proxy.enabled,
        tunnel: tun.isRunning() && v2rayTunWanted,
        tunnelWanted: v2rayTunWanted,
        tunnelReady: tunReady,
        tunnelReason: tunReason,
        scanning: quick.scanRunning(),
        // Settings › «شبکه» › «حالت پروکسی»: whether a one-tap connection turns the Windows proxy on.
        proxyMode: require('./network-settings').get().proxyMode,
    });
});

/**
 * Where traffic actually leaves, measured rather than assumed.
 *
 * Runs through the engine's own SOCKS port, so it reports the same path the user's traffic
 * takes in either mode — the proxy and the tunnel both terminate there.
 */
app.get('/api/quick/egress', async (req, res) => {
    if (!(await portIsLive(XRAY.socks))) {
        return res.json({ ok: false, error: 'موتور اجرا نیست — اول وصل شوید.', code: 'ENGINE_DOWN' });
    }
    const result = await quick.traceEgress(XRAY.socks);

    // If the caller says which node this reading belongs to, the measured country replaces
    // the one the feed claimed — permanently, so the node is listed under the country it
    // actually comes out in from now on. Only a trustworthy reading counts: over WARP,
    // `loc` is the USER's country by design, and storing that would file every node in Iran.
    if (result && result.ok && result.countryTrusted && result.loc && req.query.node) {
        const recorded = quick.recordVerified(String(req.query.node), result.loc);
        if (recorded.ok) {
            result.recorded = true;
            result.moved = !!recorded.moved;
            result.previousCountry = recorded.previous || null;
        }
    }
    res.json(result);
});

/** How many rows in the list are measured rather than claimed — and a way to start over. */
app.get('/api/quick/verified', (req, res) => {
    res.json({ ok: true, count: quick.verifiedCount() });
});

app.post('/api/quick/verified/forget', (req, res) => {
    quick.forgetVerified();
    res.json({ ok: true });
});

function startServer() {
    // Undo anything a previous run left on this machine BEFORE doing anything else.
    //
    // Every in-process restore path — disengage, before-quit, SIGINT — is useless when the
    // process does not get to run code: Task Manager "End task", a hard crash, an antivirus
    // kill, power loss. In each of those the machine can be left block-by-default with an
    // allow-rule pointing at an adapter that no longer exists, or resolving through a
    // loopback address with nothing behind it. Both are "my PC has no internet" with nothing
    // on screen explaining why, and neither is fixed by reinstalling.
    //
    // Deliberately not awaited: a slow PowerShell must not delay the window appearing, and
    // the work is independent of everything below.
    try {
        require('./aether-guard').restoreIfStale((m) => console.log(m));
    } catch (e) {
        console.error('Aether guard startup recovery failed:', e);
    }

    // The same idea for NetDiag's own repairs, and for the same reason: a repair interrupted
    // between "we are about to change this" and "we changed it" leaves the machine in a state
    // only the journal can explain.
    //
    // It CONVERGES rather than replays — it observes what is true now and decides — and it
    // refuses to honour a journal it cannot prove is administratively owned, because the file
    // drives privileged action from an elevated process.
    try {
        require('./netdiag/journal').restoreIfStale({
            log: (m) => console.log(m),
            // A PROMISE, never a synchronous spawn. server.js runs in Electron's main
            // process and this is called before the window exists, so `execFileSync` here
            // froze the whole application for a PowerShell start-up — see
            // [[main-process-blocking]]. journal.checkOwnership awaits whatever this returns.
            fileOwner: (file) => new Promise((done) => {
                const { execFile } = require('child_process');
                execFile('powershell.exe',
                    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
                        `(Get-Acl -LiteralPath '${file.replace(/'/g, "''")}').Owner`],
                    { encoding: 'utf8', windowsHide: true, timeout: 8000 },
                    (err, out) => done(err ? '' : (out || '').trim()));
            }),
            observe: require('./netdiag/repairs/observe'),
            restore: require('./netdiag/repairs/restore'),
        }).catch((e) => console.error('NetDiag journal recovery failed:', e));
    } catch (e) {
        console.error('NetDiag journal recovery failed:', e);
    }

    return new Promise((resolve, reject) => {
        const os = require('os');
        const path = require('path');
        const fs = require('fs');
        const portFile = path.join(os.homedir(), '.mlmvpn_port');
        
        // PORT lets a second instance be started for testing without fighting the running
        // app for 35281. When it is set the port file is left alone too — the installed app
        // reads that file to find its own server, and a test instance must not repoint it.
        const forcedPort = Number(process.env.PORT) || 0;
        let preferredPort = forcedPort || 35281;
        try {
            if (!forcedPort && fs.existsSync(portFile)) {
                const savedPort = parseInt(fs.readFileSync(portFile, 'utf8'));
                if (savedPort > 1000 && savedPort < 65536) {
                    preferredPort = savedPort;
                }
            }
        } catch (e) {}

        // This promise MUST settle. If it never does, main.js awaits it forever, the window is
        // never created, and the user sees a blank app with no error — the failure mode that
        // makes people uninstall rather than report a bug.
        let settled = false;
        const finish = (port) => { if (!settled) { settled = true; resolve(port); } };
        const fail = (err) => { if (!settled) { settled = true; reject(err); } };

        const tryListen = (portToTry, isRetry) => {
            const onError = (err) => {
                server.removeListener('error', onError);
                if (err.code === 'EADDRINUSE' && !isRetry) {
                    console.log(`Port ${portToTry} in use, falling back to a random port...`);
                    // Retry with a handler attached: an 'error' event with no listener is
                    // rethrown by EventEmitter and takes the whole process down.
                    tryListen(0, true);
                } else {
                    console.error('Server listen error:', err);
                    fail(err);
                }
            };
            server.on('error', onError);

            server.listen(portToTry, '127.0.0.1', () => {
                server.removeListener('error', onError);
                const actualPort = server.address().port;
                console.log('Server running on port ' + actualPort);
                try {
                    if (!forcedPort) fs.writeFileSync(portFile, actualPort.toString(), 'utf8');
                } catch (e) {}

                // Settings › درباره › «گزارش خطا»: watch-only, see crash-reporter.js.
                try { require('./crash-reporter').install(); } catch (e) { /* no record, same app */ }
                // A second instance started for testing (PORT set) leaves the machine-facing
                // jobs to the real app: the lock watcher and the update check are the user's.
                if (!forcedPort) {
                    // Settings › سیستم › «رفتار هنگام قفل شدن ویندوز».
                    try { require('./system-settings').installLockWatcher(disconnectEverything, (m) => aetherBroadcastLog(m)); } catch (e) { /* not Electron */ }
                    // Settings › درباره › «به‌روزرسانی نرم‌افزار»: once, a minute after start, off
                    // the startup path — at most every twelve hours (update-manager.background).
                    setTimeout(() => {
                        require('./update-manager').background((m) => aetherBroadcastLog(m)).catch(() => {});
                    }, 60 * 1000).unref();
                    // «VPN همیشه روشن»: after the start-up repairs below have had their turn.
                    setTimeout(() => { alwaysOnReplay().catch(() => {}); }, 10 * 1000).unref();
                }

                // Self-heal the dedicated-DNS bridge. If the previous run was killed (crash,
                // Task Manager, power loss) the config still says system-wide while nothing
                // is listening on 127.0.0.1:53 — which is a machine with no working DNS.
                // Bring the listener back; if that is impossible, hand Windows its resolvers
                // back rather than leaving it pointed at a dead port.
                (async () => {
                    try {
                        const cfg = dedicatedDns.getConfig();
                        if (!cfg.systemWide) return;
                        await dedicatedDns.enableSystemWide();
                        console.log('Dedicated DNS bridge restored after restart');
                    } catch (e) {
                        console.error('Dedicated DNS bridge could not be restored:', e.message);
                        try { await dedicatedDns.disableSystemWide(); } catch (_) {}
                    }
                })();

                finish(actualPort);
            });
        };

        // Last-resort guard: if listen neither succeeds nor errors (seen with some firewall and
        // filter drivers), give up rather than hanging the launch indefinitely.
        setTimeout(() => fail(new Error('سرور محلی در ۱۵ ثانیه بالا نیامد')), 15000);

        tryListen(preferredPort, false);
    });
}

// `app` is exported for tests/v2ray/routes.test.js, which calls the route handlers
// directly rather than over a socket — nothing else should reach for it.
module.exports = { startServer, app };

if (require.main === module) {
    startServer().then(port => {
        console.log(`=========================================`);
        console.log(`🌐 سرور با موفقیت استارت شد!`);
        console.log(`👉 برای تست، آدرس زیر را در مرورگر کروم باز کنید:`);
        console.log(`   http://127.0.0.1:${port}`);
        console.log(`=========================================`);
    });
}




// ==== STATIC IP TEST API ====
const httpReq = require('http');
const httpsReq = require('https');

app.post('/api/test-fixed-ip', async (req, res) => {
    const { ip, port } = req.body;
    if (!ip || !port) return res.json({ success: false, isValid: false });

    const isHttps = port === '443' || port === '8443' || port === '2053';
    const protocol = isHttps ? httpsReq : httpReq;

    const options = {
        hostname: ip,
        port: port,
        path: '/',
        method: 'GET',
        headers: {
            'Host': 'speed.cloudflare.com',
            'User-Agent': 'Mozilla/5.0'
        },
        timeout: 8000,
        rejectUnauthorized: false
    };

    if (isHttps) {
        options.servername = 'speed.cloudflare.com';
    }

    const doReq = () => {
        return new Promise((resolve) => {
            const req = protocol.request(options, (resp) => {
                const serverHeader = (resp.headers['server'] || '').toLowerCase();
                if (serverHeader.includes('cloudflare') || serverHeader.includes('envoy')) {
                    return resolve(true);
                }
                if (resp.statusCode === 400 || resp.statusCode === 403 || resp.statusCode === 200) {
                    return resolve(true);
                }
                resolve(false);
            });

            req.on('error', (e) => { console.log('[FIXED-IP-TEST] Error:', e.message); resolve(false); });
            req.on('timeout', () => { console.log('[FIXED-IP-TEST] Timeout'); req.destroy(); resolve(false); });
            req.end();
        });
    };

    let isValid = await doReq();
    if (!isValid) isValid = await doReq();
    if (!isValid) isValid = await doReq(); // 2 retries
    console.log('[FIXED-IP-TEST] Final result for', ip, ':', isValid);

    res.json({ success: true, isValid });
});
// ==== END STATIC IP TEST API ====

// ============================================================
// API: System DNS (پاک‌سازی عمیق DNS)
// ============================================================
// Changing the machine's resolvers is a system-wide, elevated operation, so each route
// is explicit about what it touches rather than hiding it behind a generic "apply".
const dnsManager = require('./dns-manager');

app.get('/api/dns/providers', (req, res) => {
    res.json({ ok: true, providers: dnsManager.PROVIDERS });
});

app.get('/api/dns/status', async (req, res) => {
    try { res.json({ ok: true, ...(await dnsManager.getStatus()) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/dns/ping', async (req, res) => {
    try { res.json({ ok: true, results: await dnsManager.pingAll() }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/dns/apply', async (req, res) => {
    try { res.json({ ok: true, ...(await dnsManager.applyProvider((req.body || {}).id)) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/dns/deep-clean', async (req, res) => {
    try {
        const { resetToAuto, thenApply } = req.body || {};
        res.json({ ok: true, ...(await dnsManager.deepClean({ resetToAuto, thenApply })) });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// "Where is my DNS actually coming from?" — enumerates every source on the machine.
app.get('/api/dns/diagnose', async (req, res) => {
    try { res.json({ ok: true, ...(await dnsManager.diagnose()) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/dns/clear-source', async (req, res) => {
    try { res.json({ ok: true, ...(await dnsManager.clearSource((req.body || {}).id)) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/dns/restore', async (req, res) => {
    try { res.json({ ok: true, ...(await dnsManager.restoreBackup()) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// ============================================================
// API: Google Script Tunnel (تونل گوگل اسکریپت)
// ============================================================
// Whole feature lives in gst/ and mounts itself here. It reuses aetherBroadcastLog so
// its step-by-step Persian trace lands in the same core-log panel as Xray and Aether —
// one place to look when a setup wizard stalls.
require('./gst/routes')(app, { broadcastLog: aetherBroadcastLog });

// ============================================================
// API: VodiWalker panel on Railway (کانفیگ آیپی ثابت)
// ============================================================
// Deploys the VodiWalker VLESS panel to the user's own Railway account and manages its
// users/configs. Self-mounting like GST; shares the same core-log broadcaster.
require('./vodi/routes')(app, { broadcastLog: aetherBroadcastLog });

// ============================================================
// API: GitHub Tunnel (Windows Cloud Session over GitHub Actions + Tailscale)
// ============================================================
// Self-mounting like the others, shares the same core-log broadcaster. See github-tunnel/
// for the full module — GitHub and Tailscale are invisible to the user; this only ever
// looks like another cloud Connection Method.
// Its data plane is handed back here so the «بازی» tab can race this tunnel against the
// other engines without the user having to come to this panel and connect it by hand.
let gtDataPlane = null;
require('./github-tunnel/routes')(app, {
    broadcastLog: aetherBroadcastLog,
    broadcast,
    readSystemProxy,
    expose: (api) => { gtDataPlane = api; },
});

// ============================================================
// API: System check (بررسی سیستم هنگام اجرا)
// ============================================================
// One endpoint, one probe per call. Split that way on purpose: the startup modal shows
// each check finishing on its own, and the user can abandon the run at any point without
// a long-running server request left in flight.
require('./systemcheck')(app);

// ============================================================
// API: Internet diagnostics (دیاگ اینترنت)
// ============================================================
// Self-mounting like the block above. Read-only at this stage: the routes start a diagnostic
// session, return its narrative and cancel it, and nothing more. Repairs arrive with the
// journal, the mutation mutex and the generation-bound confirm token, not before.
//
// `port` matters — the Host allowlist inside is the real anti-rebinding control, and it needs
// to know which port to allow.
// ============================================================
// API: «اوپن‌وی‌پی‌ان» — the OpenVPN engine
// ============================================================
// The list is the VPN Gate pool, mirrored as JSON every five minutes by 9xN/auto-ovpn, each
// row carrying its own ready .ovpn. See openvpn-manager.js for why the merge never replaces
// and why the probe uses --dev null.

app.get('/api/openvpn/status', (req, res) => {
    res.json(Object.assign({ ok: true }, openvpn.getStatus(), { source: openvpn.SOURCE_URL }));
});

app.get('/api/openvpn/servers', (req, res) => {
    res.json(Object.assign({ ok: true }, openvpn.listServers()));
});

app.get('/api/openvpn/logs', (req, res) => {
    res.json({ ok: true, lines: openvpn.getLogs() });
});

// The manager tries direct first and then every engine that is already connected — the
// mirror is on GitHub, which is exactly what a user who needs this list often cannot reach.
/**
 * «به‌روزرسانی فهرست» — and it is the SHARED archive that gets refreshed.
 *
 * This is also the only way this engine learns a relay's real OpenVPN port. VPN Gate's CSV
 * carries it inside `OpenVPN_ConfigData_Base64`, which the gateway drops on the way past; the
 * harvest hook in refreshServers() keeps the port out of it. Without a refresh, every volunteer
 * relay is dialled on 443 — which is right for an official relay and wrong for almost everyone
 * else, and reads as «the relay is dead» when it means «wrong door».
 *
 * The auto-ovpn mirror is fetched too, as a second source of ports; it is a bonus, so a failure
 * there is not a failure of the button.
 */
app.post('/api/openvpn/refresh', async (req, res) => {
    const out = { ok: true, added: 0, count: 0, portsKnown: 0 };
    let firstError = null;
    try {
        const g = await gateway.refreshServers((m) => broadcast('core_log', m));
        out.added = g.added || 0;
        out.count = g.count || 0;
        out.via = g.via;
    } catch (e) { firstError = e; }

    try {
        const m = await openvpn.refresh();
        openvpn._internal.catalog.notePorts(openvpn._internal.readList().servers || []);
        out.mirror = m.count || 0;
    } catch (e) { /* the mirror is a bonus source; the archive above is the real list */ }

    out.portsKnown = openvpn._internal.catalog.portsKnown();
    if (firstError && !out.count) {
        return res.status(502).json({ ok: false, error: firstError.message, portsKnown: out.portsKnown });
    }
    res.json(out);
});

let ovpnMeasureAbort = false;
app.post('/api/openvpn/measure/stop', (req, res) => { ovpnMeasureAbort = true; res.json({ ok: true }); });

// NDJSON, not a single JSON answer: a REAL test dials every server and that takes minutes,
// so the panel has to be able to show each verdict as it lands.
app.post('/api/openvpn/measure', async (req, res) => {
    ovpnMeasureAbort = false;
    // res, not req — a POST's request stream is already finished (see the V2Ray delay test).
    res.on('close', () => { if (!res.writableEnded) ovpnMeasureAbort = true; });
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    const write = (o) => { try { if (!res.writableEnded) res.write(JSON.stringify(o) + '\n'); } catch (e) { /* client gone */ } };
    try {
        const hosts = Array.isArray(req.body && req.body.hosts) ? req.body.hosts : null;
        const results = await openvpn.verify(hosts, {
            concurrency: 8,
            via: (req.body && req.body.via) || 'auto',
            stopAfter: +(req.body && req.body.stopAfter) || 0,
            onBegin: (b) => write(Object.assign({ type: 'begin' }, b)),
            onResult: (r) => write(Object.assign({ type: 'result' }, r)),
            shouldStop: () => ovpnMeasureAbort,
        });
        write({ type: 'done', ok: results.filter(r => r.ok).length, stopped: ovpnMeasureAbort });
    } catch (e) {
        write({ type: 'error', error: e.message });
    }
    try { res.end(); } catch (e) { /* already closed */ }
});

// Starting a full tunnel while another one owns the machine's route is how a half-applied
// state gets made — the same guard the engine probe uses.
app.post('/api/openvpn/connect', async (req, res) => {
    try {
        if (aetherTunWanted || v2rayTunWanted || (tun.isRunning && tun.isRunning())) {
            return res.status(409).json({ ok: false, code: 'TUN_UP', error: 'یک تونل کامل دیگر روشن است. اول آن را خاموش کنید.' });
        }
        const host = String((req.body && req.body.host) || '').trim();
        if (!host) return res.status(400).json({ ok: false, error: 'سروری انتخاب نشده است.' });
        const out = await openvpn.connect(host, {
            routeNoPull: !!(req.body && req.body.routeNoPull),
            via: (req.body && req.body.via) || 'auto',
        });
        broadcast('openvpn', { phase: 'connecting', host });
        res.json(Object.assign({ ok: true }, out));
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/openvpn/disconnect', async (req, res) => {
    try {
        const out = await openvpn.disconnect();
        broadcast('openvpn', { phase: 'idle' });
        res.json(Object.assign({ ok: true }, out));
    } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

// ── the catalogue: «فهرست من» / «آرشیو» and everything the user does to them ──────
//
// The same route surface «گیت‌وی MLM» has, because it is the same feature with a different
// engine underneath. The rows come from one shared archive and the verdicts do not — a relay
// SoftEther connects to is not a relay OpenVPN connects to, measured.

app.get('/api/openvpn/list', (req, res) => {
    try {
        const l = openvpn.lists();
        res.json({
            ok: true,
            mine: l.mine, archive: l.archive,
            kept: l.kept, hidden: l.hidden,
            pings: l.pings, probes: l.probes,
            selected: l.selected, front: l.front,
            suggested: openvpn.suggest(),
            source: l.source, at: l.at, fetchedAt: l.fetchedAt,
            status: openvpn.getStatus(),
            fronts: openvpn.liveSocksPorts().map((p) => ({ port: p, name: openvpn.viaName(p) })),
        });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/openvpn/curate', (req, res) => {
    const b = req.body || {};
    const hosts = Array.isArray(b.hosts) ? b.hosts : [];
    try {
        switch (String(b.action || '')) {
            case 'keep': return res.json({ ok: true, n: openvpn.keep(hosts) });
            case 'drop': return res.json({ ok: true, n: openvpn.drop(hosts) });
            case 'hide': return res.json({ ok: true, n: openvpn.hide(hosts) });
            case 'purge': return res.json({ ok: true, n: openvpn.purge(hosts) });
            case 'restore': return res.json({ ok: true, n: openvpn.restoreHidden() });
            default: return res.status(400).json({ ok: false, error: 'کار نامعتبر است.' });
        }
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/**
 * Start a sweep — and RETURN, without waiting for it.
 *
 * A real handshake over three hundred relays is minutes of work; holding the response open for
 * it would time out in the browser while the work carried on invisibly. Progress rides the
 * status broadcast the panel already listens to.
 */
app.post('/api/openvpn/test', (req, res) => {
    const b = req.body || {};
    const kind = b.kind === 'probe' ? 'probe' : 'ping';
    const hosts = Array.isArray(b.hosts) ? b.hosts : [];
    if (openvpn.sweepRunning()) return res.status(409).json({ ok: false, error: 'یک تست در حال اجراست.' });
    if (!hosts.length) return res.status(400).json({ ok: false, error: 'سروری برای تست نیست.' });

    const onStatus = (st) => broadcast('openvpn', st);
    openvpn.startSweep(kind, hosts, onStatus)
        .then((r) => {
            if (r && r.ok) {
                broadcast('core_log', `[اوپن‌وی‌پی‌ان] ${r.stopped ? 'تست متوقف شد' : 'تست تمام شد'} — ${r.done} از ${r.total} سرور.`);
            } else if (r && r.error) {
                broadcast('core_log', `[اوپن‌وی‌پی‌ان] ❌ ${r.error}`);
            }
            broadcast('openvpn', openvpn.getStatus());
        })
        .catch((e) => broadcast('core_log', `[اوپن‌وی‌پی‌ان] ❌ ${e.message}`));

    res.json({ ok: true, kind, total: hosts.length });
});

app.post('/api/openvpn/test/cancel', (req, res) => {
    try { res.json({ ok: true, wasRunning: openvpn.cancelSweep() }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/api/openvpn/select', (req, res) => {
    try { res.json({ ok: true, selected: openvpn.select((req.body || {}).host) }); }
    catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

/**
 * Which front carries the tunnel.
 *
 * Refused mid-session: the front is the carrier the live OpenVPN process is already talking
 * through, so changing it means reconnecting, and a picker that silently disagreed with what
 * the machine is doing is worse than no picker.
 */
app.post('/api/openvpn/front', (req, res) => {
    try {
        if (openvpn.isRunning()) {
            return res.status(409).json({ ok: false, error: 'برای تغییر مسیر، اول اتصال را قطع کنید.' });
        }
        const front = openvpn.setFront((req.body || {}).front);
        broadcast('openvpn', openvpn.getStatus());
        res.json({ ok: true, front });
    } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

require('./netdiag/routes')(app, {
    broadcast,
    /**
     * Whether the repair gate may touch DNS, the system proxy or a Windows service.
     *
     * This was never passed, and netdiag/live.js fails closed without it, so enginesQuiet()
     * answered false on every machine and gate() step 4 refused every repair that has not
     * opted out — four of the five we ship. The panel could diagnose and then never fix
     * anything, and the refusal surfaced as a bare «خطای سرور».
     *
     * Quiet means nothing in the traffic feed reports itself active (the tunnel, Xray, the
     * gateway, Psiphon, GST, SNI, GitHub Tunnel), no front engine is up, and the tunnel is
     * not mid-flight: aetherTunWanted is true between «start» and the adapter actually
     * coming up, which is precisely the window a DNS change must not land in.
     */
    enginesQuiet: () => {
        try {
            if (trafficFeed.activeNames().length) return false;
            if (tun.isRunning() || aetherTunWanted) return false;
            const up = (m) => { try { return !!require(m).isRunning(); } catch (e) { return false; } };
            return !(up('./aether-manager') || up('./tor-manager')
                || up('./lantern-manager') || up('./geph-manager'));
        } catch (e) {
            return false;          // unable to prove it is quiet is not the same as quiet
        }
    },
});

// ============================================================
// «بازی» — the game path engine. Mode 1 only at this stage: it measures, audits the local
// line and gives a verdict, and it is allowed to conclude "stay direct". It owns no data
// path of its own yet, so it cannot conflict with Aether, the V2Ray tunnel or GitHub
// Tunnel over the single MLMVPN adapter — measurement through an engine is done via that
// engine's SOCKS listener, concurrently, without taking the machine with it.
require('./game/routes')(app, {
    broadcast,
    broadcastLog: aetherBroadcastLog,
    // There is exactly ONE MLMVPN adapter, and Aether, the V2Ray full tunnel and the game
    // accelerator all want it. Clearing the INTENT is what matters, not just stopping the
    // process: a bare stopTun leaves Aether's watchdog to rebuild the tunnel seconds later,
    // and the two then take turns owning the default route. Same reasoning, same shape as
    // the V2Ray tunnel's claim above it.
    claimAdapter: async (reason) => {
        if (aetherTunWanted || v2rayTunWanted || tun.isRunning()) {
            aetherTunWanted = false;
            v2rayTunWanted = false;
            aetherStopWatchdog();
            await aetherReleaseFailClosed(reason);
            tun.stopTun(aetherBroadcastLog, 'disconnect-everything');
            await tun.verifyTornDown(aetherBroadcastLog);
        }
    },
    // …and the reverse: anything else that wants the adapter must be able to take it back.
    adapterBusy: () => (aetherTunWanted || v2rayTunWanted),

    // Engine lifecycle for the tournament.
    //
    // The game module never calls aether-manager or xray-manager itself. server.js owns the
    // watchdogs, the tunnel intent and the system-proxy state, and an engine started behind
    // its back would leave all three describing a machine that no longer exists. So the
    // tournament asks, and this file remains the only place an engine is started or stopped.
    engineDrivers: {
        async startAether(protocol, scan) {
            // Never while a tunnel is up: the tournament measures through SOCKS and must not
            // change the machine's routing, and stopping the engine under a live TUN would
            // take the user offline mid-test.
            if (aetherTunWanted || v2rayTunWanted) throw new Error('اول تونل را خاموش کن؛ مسابقه نباید مسیر سیستم را عوض کند.');
            // `scan` is part of the identity of what is being measured, not a detail: turbo
            // takes the first healthy gateway and balanced searches for the best one, and on
            // a bad evening those land on different datacentres. Passing it through is what
            // makes "Aether — MASQUE (متعادل)" mean that and not something else.
            //
            // `aetherMeasurementStatus`, NOT `aetherBroadcastStatus` — see the comment on
            // aetherMeasurementMode. The normal handler takes over the machine's DNS and
            // arms the fail-closed guard on the way down, which during a tournament means
            // the user watches their internet die six times.
            aetherMeasurementMode = true;
            try {
                await aether.startAether(
                    { protocol, chainToXray: false, scan: scan || 'turbo' },
                    aetherBroadcastLog, aetherMeasurementStatus, null);
            } catch (err) {
                aetherMeasurementMode = false;
                throw err;
            }
        },
        async stopAether() {
            aetherTunWanted = false;
            aetherStopWatchdog();
            aether.stopAether();
            aetherMeasurementMode = false;
            // Belt and braces: if anything armed the guard or the DNS bridge before this
            // mode existed — or a previous crashed run left them armed — a measurement stop
            // is exactly the wrong moment to leave the machine closed.
            try { await aetherReleaseFailClosed('پایان سنجش موتور'); } catch {}
            try { await stopAetherDnsBridge(); } catch {}
        },
        // "Is it actually connected?", asked of the engine itself rather than of its port.
        // game/engines.js waits on this before measuring — the port opens long before the
        // data plane exists, and measuring in that window produced six confident "carries
        // no UDP" verdicts about engines that had not finished connecting.
        engineReady(spec) {
            if (!spec) return false;
            if (spec.kind === 'aether') return !!aether.getStatus().connected;
            if (spec.kind === 'gateway') { try { return !!gateway.getStatus().connected; } catch (e) { return false; } }
            if (spec.kind === 'psiphon') { try { return !!psiphon.getStatus().connected; } catch (e) { return false; } }
            if (spec.kind === 'tor') { try { return !!torEngine.getStatus().connected; } catch (e) { return false; } }
            if (spec.kind === 'lantern') { try { return !!lantern.getStatus().connected; } catch (e) { return false; } }
            if (spec.kind === 'v2ray') { try { return require('./xray-manager').isRunning(); } catch { return false; } }
            if (spec.kind === 'github-tunnel') { try { return !!(gtDataPlane && gtDataPlane.status().connected); } catch { return false; } }
            if (spec.kind === 'geph') { try { return !!gephEngine.getStatus().connected; } catch (e) { return false; } }
            return true;
        },
        /**
         * «گف», for the game race.
         *
         * The only one of this app's four SOCKS-front engines that carries UDP — measured
         * 2026-09-14: UDP ASSOCIATE accepted and a real STUN train came back with no loss, while
         * سایفون, لنترن and تور each refuse the associate outright.
         *
         * Nothing machine-wide happens here: گف publishes a SOCKS port and touches neither the
         * route nor the system's DNS, so a race can start and stop it without the precautions
         * Aether needs. Its own account is anonymous and already made, so there is nothing to ask
         * the user for either.
         */
        async startGeph() {
            if (!gephEngine.isInstalled()) throw new Error('فایل گف در core/geph موجود نیست.');
            if (!gephEngine.hasAccount()) throw new Error('گف حساب ندارد — یک بار از پنجرهٔ خودش «ساخت حساب رایگان» را بزنید.');
            await gephEngine.startGeph({ region: 'auto' }, frontBroadcastLog, st => frontBroadcastStatus('geph', st));
        },
        async stopGeph() {
            try { gephEngine.stopGeph(); } catch (e) { /* already down */ }
            frontBroadcastStatus('geph', gephEngine.getStatus());
        },
        async startV2ray(node) {
            if (aetherTunWanted || v2rayTunWanted) throw new Error('اول تونل را خاموش کن.');
            const uri = node.uri || node.config || node.link;
            if (!uri) throw new Error('این نود آدرسی ندارد.');
            // useSystemProxy false: the tournament must not repoint Windows' proxy at a node
            // it is about to stop again.
            await startXray(uri, node.cleanIp || null, node.cleanPort || null, node.realIp || null, false, aetherBroadcastLog);
        },
        async stopV2ray() {
            v2rayTunWanted = false;
            stopXray();
        },
        // The GitHub Tunnel is the one engine that cannot be measured politely.
        //
        // Its proxy mode exposes SOCKS 20812, but tailscaled's SOCKS server does not do UDP
        // ASSOCIATE — so in that mode it carries no UDP at all and is worth nothing to a
        // game. UDP flows only in full-tunnel mode, where it drives its own kernel adapter
        // and owns the default route. Testing it therefore means letting it take the whole
        // connection for the length of one measurement, which is why the game module marks
        // it `exclusive`, runs it last, and only when the user ticked the box.
        //
        // `gtDataPlane` is the same code path the GitHub Tunnel panel's own connect button
        // uses — exposed rather than reimplemented, because that path also mints the key,
        // arms the leak guard and starts the watchdog, and a second copy of it here would
        // drift out of sync with the first one within a release.
        async startGithubTunnel() {
            if (!gtDataPlane) throw new Error('ماژول تونل GitHub آماده نیست.');
            if (aetherTunWanted || v2rayTunWanted) throw new Error('اول تونل دیگر را خاموش کن.');
            // Was it already up before we touched it? This is the same rule engines.release
            // follows, and it matters more here than anywhere else: a failed measurement
            // must never tear down a tunnel the USER connected. (Learned immediately: a
            // leftover tailscaled after a failed attempt looked like our wreckage and was
            // actually the user's own session.)
            let wasUp = false;
            try { const s = gtDataPlane.status(); wasUp = !!(s && (s.connected || s.running)); } catch {}

            try {
                await gtDataPlane.bringUp('tun');
            } catch (err) {
                // Ours to clean up ONLY if we are the reason anything is running: a failed
                // bringUp can still leave the daemon alive, and engines.release() cannot
                // help because the throw happens before ensure() records that a start
                // succeeded. So the start path owns its own wreckage — and nobody else's.
                if (!wasUp) { try { await gtDataPlane.teardown(); } catch { /* nothing better to try */ } }

                // Full-tunnel mode drives a kernel adapter, writes NRPT registry rules and
                // opens a privileged named pipe — all of which need administrator rights.
                // Without them tailscaled fails with a wall of English stderr ("Access is
                // denied", "This security ID may not be assigned as the owner"), and dumping
                // that into a Persian results table tells the user nothing they can act on.
                const raw = err && err.message ? err.message : String(err);
                if (/access is denied|security ID may not be assigned|namedpipe/i.test(raw)) {
                    throw new Error(
                        'تونل GitHub در حالت تونل کامل به دسترسی مدیر نیاز دارد و برنامه الان آن را ندارد. ' +
                        'برنامه را «Run as administrator» اجرا کن و دوباره امتحان کن.');
                }
                throw err;
            }
        },
        async stopGithubTunnel() {
            if (!gtDataPlane) return;
            await gtDataPlane.teardown();
        },
    },

    // The tournament reads the user's saved V2Ray nodes from the same store the panel
    // writes them to, rather than making the renderer post a hundred configs up to us.
    readNodes: () => {
        try {
            const raw = storageManager.getItem('v2rayNodes');
            const list = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return Array.isArray(list) ? list : [];
        } catch { return []; }
    },
});
