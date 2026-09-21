const fs = require('fs');
const path = require('path');
const axios = require('axios'); // Ensure axios is available or use native fetch/http
const { generateSafeSubdomain, generateSafeWorkerName, applySniCamouflage, containsBlacklistedKeyword } = require('./anti-dpi');
// Anything addressed to the user's own worker host goes through this: workers.dev is
// filtered in Iran, so a direct fetch black-holes even though the Cloudflare API calls
// right next to it succeed. Direct first, edge proxy second.
const { gtFetch } = require('./github-tunnel/gt-net');

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar') ? __dirname.replace(/\.asar/gi, '.asar.unpacked') : __dirname;
}

const ACCOUNTS_FILE = path.join(getUnpackedDir(), 'data', 'cloud-accounts.json');
const SETTINGS_FILE = path.join(getUnpackedDir(), 'data', 'cloud-settings.json');

// Ensure data directory exists
if (!fs.existsSync(path.join(getUnpackedDir(), 'data'))) {
    fs.mkdirSync(path.join(getUnpackedDir(), 'data'), { recursive: true });
}

function loadJson(file, defaultVal) {
    try {
        if (fs.existsSync(file)) {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        }
    } catch (e) {
        console.error(`Error loading ${file}:`, e.message);
    }
    return defaultVal;
}

function saveJson(file, data) {
    try {
        fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
        console.error(`Error saving ${file}:`, e.message);
    }
}

class CloudManager {
    constructor() {
        this.accounts = loadJson(ACCOUNTS_FILE, []);
        this.settings = loadJson(SETTINGS_FILE, {
            bypassIran: true,
            blockAds: false,
            warpEnable: false,
            dns: 'cloudflare',
            fragEnable: false,
            fragMin: 100,
            fragMax: 200,
            fragInt: 2
        });
    }

    getAccounts() {
        return this.accounts;
    }

    async addAccount(rawToken, rawEmail) {
        // Strip out any non-alphanumeric or standard characters (in case of zero-width spaces, newlines, etc.)
        const token = typeof rawToken === 'string' ? rawToken.replace(/[^a-zA-Z0-9_-]/g, '').trim() : '';
        const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
        if (!token) return { success: false, message: 'Token is empty after cleanup.' };

        const isCfat = token.startsWith('cfat_');
        let headers = {};
        if (isCfat || !email) {
            headers['Authorization'] = `Bearer ${token}`;
        } else {
            headers['X-Auth-Email'] = email;
            headers['X-Auth-Key'] = token;
        }

        try {
            if (headers['Authorization']) {
                const resp = await axios.get('https://api.cloudflare.com/client/v4/user/tokens/verify', {
                    headers, timeout: 10000
                });
                if (!resp.data || !resp.data.success) {
                    return { success: false, message: 'Invalid API Token.' };
                }
            } else {
                const resp = await axios.get('https://api.cloudflare.com/client/v4/user', {
                    headers, timeout: 10000
                });
                if (!resp.data || !resp.data.success) {
                    return { success: false, message: 'Invalid Global API Key.' };
                }
            }

            // Get Account info
            const accResp = await axios.get('https://api.cloudflare.com/client/v4/accounts', {
                headers, timeout: 10000
            });
            
            let accountName = "Unknown Account";
            let accountId = "";
            if (accResp.data && accResp.data.success && accResp.data.result.length > 0) {
                accountName = accResp.data.result[0].name;
                accountId = accResp.data.result[0].id;
            }

            // Check if already exists
            const existing = this.accounts.find(a => a.token === token);
            if (!existing) {
                this.accounts.push({
                    id: Date.now().toString(),
                    token,
                    email,
                    name: accountName,
                    accountId,
                    status: 'active',
                    addedAt: new Date().toISOString()
                });
                saveJson(ACCOUNTS_FILE, this.accounts);
            }
            return { success: true, message: 'Account verified and added.', name: accountName, id: (this.accounts.find(a => a.token === token) || {}).id };

        } catch (e) {
            return { success: false, message: e.response?.data?.errors?.[0]?.message || e.message };
        }
    }

    deleteAccount(id) {
        const initialLen = this.accounts.length;
        this.accounts = this.accounts.filter(a => a.id !== id);
        if (this.accounts.length !== initialLen) {
            saveJson(ACCOUNTS_FILE, this.accounts);
            return { success: true };
        }
        return { success: false, message: 'Account not found.' };
    }

    getSettings() {
        return this.settings;
    }

    async getUsage(id) {
        const acc = this.accounts.find(a => a.id === id);
        if (!acc) return { success: false, message: 'Account not found' };

        try {
            const today = new Date();
            today.setUTCHours(0,0,0,0);
            const start = today.toISOString();
            today.setUTCHours(23,59,59,999);
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
                variables: { accountTag: acc.accountId, datetimeStart: start, datetimeEnd: end }
            };

            let headers = { 'Content-Type': 'application/json' };
            if (acc.token.startsWith('cfat_') || !acc.email) {
                headers['Authorization'] = `Bearer ${acc.token}`;
            } else {
                headers['X-Auth-Email'] = acc.email;
                headers['X-Auth-Key'] = acc.token;
            }

            const res = await axios.post('https://api.cloudflare.com/client/v4/graphql', query, { headers, timeout: 10000 });
            
            let requests = 0;
            if (res.data && res.data.data && res.data.data.viewer && res.data.data.viewer.accounts && res.data.data.viewer.accounts.length > 0) {
                const adaptive = res.data.data.viewer.accounts[0].workersInvocationsAdaptive;
                if (adaptive && adaptive.length > 0 && adaptive[0].sum) {
                    requests = adaptive[0].sum.requests || 0;
                }
            }
            return { success: true, requests };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    saveSettings(newSettings) {
        this.settings = { ...this.settings, ...newSettings };
        saveJson(SETTINGS_FILE, this.settings);
    }

    async syncSettingsToWorkers() {
        const results = [];
        for (const acc of this.accounts) {
            if (acc.status !== 'deployed' || !acc.accountId) continue;
            try {
                let headers = { 'Content-Type': 'application/json' };
                if (acc.token.startsWith('cfat_') || !acc.email) {
                    headers['Authorization'] = `Bearer ${acc.token}`;
                } else {
                    headers['X-Auth-Email'] = acc.email;
                    headers['X-Auth-Key'] = acc.token;
                }

                // 1. Get KV Namespaces
                const kvsRes = await axios.get(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/storage/kv/namespaces`, { headers, timeout: 10000 });
                if (!kvsRes.data || !kvsRes.data.result) continue;
                const kv = kvsRes.data.result.find(k => k.title.includes('mlmvpn'));
                if (!kv) continue;

                // 2. Fetch current proxySettings
                let currentSettings = {};
                try {
                    const valRes = await axios.get(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/storage/kv/namespaces/${kv.id}/values/proxySettings`, { headers, timeout: 10000 });
                    if (valRes.data && typeof valRes.data === 'object') {
                        currentSettings = valRes.data;
                    }
                } catch(e) {
                    // Ignore if missing, might be first run
                }

                // 3. Merge new settings
                const newS = this.settings;
                if (newS.ipv6 !== undefined) currentSettings.enableIPv6 = newS.ipv6;
                if (newS.proxyIpMode !== undefined) currentSettings.proxyIPMode = newS.proxyIpMode;
                
                if (newS.prefixes && newS.prefixes.length > 0) {
                    currentSettings.prefixes = newS.prefixes;
                } else {
                    currentSettings.prefixes = [];
                }
                
                if (newS.protocolVLESS !== undefined) currentSettings.VLConfigs = newS.protocolVLESS;
                if (newS.protocolTrojan !== undefined) currentSettings.TRConfigs = newS.protocolTrojan;
                if (newS.allowLANConnection !== undefined) currentSettings.allowLANConnection = newS.allowLANConnection;
                if (newS.ports && Array.isArray(newS.ports)) currentSettings.ports = newS.ports;
                if (newS.bypassIran !== undefined) currentSettings.bypassIran = newS.bypassIran;
                if (newS.blockAds !== undefined) currentSettings.blockAds = newS.blockAds;
                
                // 4. Save back
                await axios.put(`https://api.cloudflare.com/client/v4/accounts/${acc.accountId}/storage/kv/namespaces/${kv.id}/values/proxySettings`, currentSettings, { headers, timeout: 10000 });
                results.push({ account: acc.name, success: true });
            } catch (err) {
                console.error(`Failed to sync settings for ${acc.name}:`, err.message);
                results.push({ account: acc.name, success: false, message: err.message });
            }
        }
        return results;
    }

    async deployWorker(accountId, token, email, onLog = () => {}) {
        const crypto = require('crypto');
        const path = require('path');
        
        try {
            // Helper to make API calls using native fetch
            const callApi = async (method, endpoint, body = null, isJson = true) => {
                const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${endpoint}`;
                
                let headers = {};
                if (token.startsWith('cfat_') || !email) {
                    headers['Authorization'] = `Bearer ${token}`;
                } else {
                    headers['X-Auth-Email'] = email;
                    headers['X-Auth-Key'] = token;
                }
                
                if (isJson && body) headers['Content-Type'] = 'application/json';
                
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000);
                
                const config = { method, headers, signal: controller.signal };
                if (body) config.body = isJson ? JSON.stringify(body) : body;
                
                try {
                    const res = await fetch(url, config);
                    clearTimeout(timeoutId);
                    const data = await res.json();
                    if (!res.ok || !data.success) {
                        throw new Error(data.errors?.[0]?.message || 'Cloudflare API Error');
                    }
                    return data;
                } catch (e) {
                    clearTimeout(timeoutId);
                    throw e;
                }
            };

            // 0. Ensure workers.dev subdomain exists AND is clean (no blacklisted keywords)
            try {
                const subRes = await callApi('GET', '/workers/subdomain');
                const currentSub = subRes.result?.subdomain;
                if (currentSub && containsBlacklistedKeyword(currentSub)) {
                    onLog(`[🛡️ Anti-DPI] ساب‌دامین آلوده تشخیص داده شد: ${currentSub} — در حال تعویض...`);
                    const safeSub = generateSafeSubdomain();
                    try {
                        await callApi('PUT', '/workers/subdomain', { subdomain: safeSub });
                        onLog(`[🛡️ Anti-DPI] ✅ ساب‌دامین جدید: ${safeSub}.workers.dev`);
                    } catch (renameErr) {
                        onLog(`[⚠️] خطا در تعویض ساب‌دامین: ${renameErr.message}`);
                    }
                }
            } catch (e) {
                onLog('[☁️] در حال بررسی و ساخت ساب‌دامین workers.dev...');
                try {
                    const randomSub = generateSafeSubdomain();
                    await callApi('PUT', '/workers/subdomain', { subdomain: randomSub });
                } catch (subErr) {
                    // Ignore if already exists or fails
                }
            }

            // 1. Generate Secrets
            onLog('[☁️] در حال تولید UUID و متغیرهای امنیتی...');
            const uuid = crypto.randomUUID();
            const trPass = crypto.randomBytes(8).toString('hex'); // 16 chars
            const subPath = crypto.randomBytes(8).toString('hex').slice(0, 15); // 15 chars

            // 2. Handle KV Namespace
            onLog('[☁️] در حال بررسی و ساخت دیتابیس MLMVPN_KV...');
            const kvTitle = 'mlmvpn';
            const findKvNamespace = async () => {
                const perPage = 1000;
                let page = 1;

                while (true) {
                    const kvList = await callApi(
                        'GET',
                        `/storage/kv/namespaces?page=${page}&per_page=${perPage}&order=title&direction=asc`
                    );
                    const namespaces = Array.isArray(kvList.result) ? kvList.result : [];
                    const existingKv = namespaces.find(namespace =>
                        String(namespace.title || '').trim().toLowerCase() === kvTitle
                    );
                    if (existingKv) return existingKv;

                    const totalCount = Number(kvList.result_info?.total_count);
                    if (!namespaces.length || !Number.isFinite(totalCount) || page * perPage >= totalCount) {
                        return null;
                    }
                    page += 1;
                }
            };

            let existingKv = await findKvNamespace();
            if (!existingKv) {
                try {
                    const newKv = await callApi('POST', '/storage/kv/namespaces', { title: kvTitle });
                    existingKv = newKv.result;
                } catch (createError) {
                    // Another deployment may have created this title after our lookup.
                    existingKv = await findKvNamespace();
                    if (!existingKv) throw createError;
                }
            }

            const kvId = existingKv?.id;
            if (!kvId) throw new Error(`Failed to create or find KV namespace ${kvTitle}`);
            onLog('[☁️] بایندینگ دیتابیس (kv) با موفقیت انجام شد.');

            // 3. Upload Worker Code
            const workerCode = fs.readFileSync(path.join(__dirname, 'public', 'worker.js'), 'utf8');
            const workerName = generateSafeWorkerName();

            const metadata = {
                main_module: "worker.js",
                compatibility_date: "2025-04-01",
                compatibility_flags: ["nodejs_compat"],
                bindings: [
                    { type: "kv_namespace", name: "kv", namespace_id: kvId },
                    { type: "secret_text", name: "UUID", text: uuid },
                    { type: "secret_text", name: "TR_PASS", text: trPass },
                    { type: "secret_text", name: "SUB_PATH", text: subPath }
                ]
            };

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
            form.append('worker.js', new Blob([workerCode], { type: 'application/javascript+module' }), 'worker.js');

            const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;
            const upController = new AbortController();
            const upTimeoutId = setTimeout(() => upController.abort(), 20000); // 20s for upload
            
            let reqHeaders = {};
            if (token.startsWith('cfat_') || !email) {
                reqHeaders['Authorization'] = `Bearer ${token}`;
            } else {
                reqHeaders['X-Auth-Email'] = email;
                reqHeaders['X-Auth-Key'] = token;
            }

            let uploadRes;
            try {
                uploadRes = await fetch(uploadUrl, {
                    method: 'PUT',
                    headers: reqHeaders,
                    body: form,
                    signal: upController.signal
                });
                clearTimeout(upTimeoutId);
            } catch (e) {
                clearTimeout(upTimeoutId);
                throw new Error('Upload timeout or network error: ' + e.message);
            }
            
            const uploadData = await uploadRes.json();
            if (!uploadRes.ok || !uploadData.success) {
                throw new Error(uploadData.errors?.[0]?.message || 'Failed to upload worker script');
            }
            onLog('[☁️] سورس‌کد Worker با موفقیت در کلودفلر آپلود شد.');

            // 4. Inject Proxy IP
            onLog('[☁️] در حال تزریق Proxy IP به دیتابیس جهت دور زدن فیلترینگ...');
            await callApi('PUT', `/storage/kv/namespaces/${kvId}/values/proxySettings`, {
                proxyIPs: ["bpb.yousef.isegaro.com"]
            }, true);

            // 5. Enable on workers.dev
            try {
                await callApi('POST', `/workers/scripts/${workerName}/subdomain`, { enabled: true });
            } catch (e) {
                if (e.message && e.message.includes('workers.dev')) {
                    onLog('[☁️] اکانت شما ساب‌دامین workers.dev ندارد. در حال ساخت خودکار...');
                    const randomSub = generateSafeSubdomain();
                    await callApi('PUT', '/workers/subdomain', { subdomain: randomSub });
                    await callApi('POST', `/workers/scripts/${workerName}/subdomain`, { enabled: true });
                } else {
                    throw e;
                }
            }

            // 6. Get Subdomain (with final Anti-DPI check)
            const subdomainRes = await callApi('GET', '/workers/subdomain');
            let subdomain = subdomainRes.result?.subdomain;
            // آخرین بررسی: اگر هنوز آلوده بود، هشدار بده
            if (subdomain && containsBlacklistedKeyword(subdomain)) {
                onLog(`[🛡️ Anti-DPI] ⚠️ ساب‌دامین هنوز آلوده است: ${subdomain}. تلاش مجدد برای تعویض...`);
                try {
                    const safeSub = generateSafeSubdomain();
                    await callApi('PUT', '/workers/subdomain', { subdomain: safeSub });
                    subdomain = safeSub;
                    onLog(`[🛡️ Anti-DPI] ✅ ساب‌دامین با موفقیت تعویض شد: ${safeSub}`);
                } catch (e2) {
                    onLog(`[⚠️] تعویض ساب‌دامین ناموفق بود. لطفاً دستی از داشبورد Cloudflare تغییر دهید.`);
                }
            }
            const workersDev = subdomain ? `${subdomain}.workers.dev` : 'workers.dev';
            const finalUrl = `https://${workerName}.${workersDev}`;

            // 7. Auto-Setup BPB Panel
            onLog('[☁️] در حال راه‌اندازی و کانفیگ مخفیانه هسته BPB...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            try {
                let retries = 10;
                let pwdRes;
                // Generate a password that satisfies the frontend validation (uppercase + number + 8 chars)
                const tempPassword = 'A1' + crypto.randomBytes(8).toString('hex');
                let headers = { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Content-Type': 'text/plain',
                    'Accept': '*/*'
                };

                // Retry loop for DNS propagation
                while (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    try {
                        // A. Set the password
                        pwdRes = await gtFetch(`${finalUrl}/panel/reset-password`, {
                            method: 'POST',
                            headers: headers,
                            body: tempPassword,
                            timeoutMs: 20000
                        });
                        if (pwdRes.ok) {
                            onLog(`[☁️] مرحله ۱: رمز عبور اولیه با موفقیت ثبت شد.`);
                            break; 
                        } else {
                            if (pwdRes.status === 401) {
                                onLog(`[☁️] رمز عبور قبلاً تنظیم شده است.`);
                                break;
                            }
                            onLog(`[⚠️] خطای تنظیم رمز (وضعیت ${pwdRes.status}). تلاش مجدد...`);
                        }
                    } catch (e) {
                        onLog(`[⚠️] عدم ارتباط شبکه: ${e.message}`);
                        if (retries === 1) throw e;
                    }
                    retries--;
                }
                
                // Wait for KV propagation
                await new Promise(resolve => setTimeout(resolve, 3000));

                // B. Login and Reset Settings are intentionally skipped!
                // The worker's /sub/raw/ endpoint automatically initializes default proxySettings if they are missing in KV.
                // Calling /panel/reset-settings from the backend without proper context corrupts the KV (globalThis.settings is undefined).
                onLog('[☁️] کانفیگ هسته BPB با موفقیت فعال و آماده شد!');
                
                // Wait for KV propagation before moving to config extraction
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (e) {
                onLog(`[⚠️] خطای جزئی در اتوماسیون پنل: ${e.message}`);
                console.error("Auto-setup error:", e);
            }

            // 8. Save to accounts
            const accountIndex = this.accounts.findIndex(a => a.accountId === accountId);
            if (accountIndex !== -1) {
                this.accounts[accountIndex] = {
                    ...this.accounts[accountIndex],
                    status: 'deployed',
                    workerUrl: finalUrl,
                    uuid: uuid,
                    tr_pass: trPass,
                    sub_path: subPath
                };
                saveJson(ACCOUNTS_FILE, this.accounts);
            }

            onLog('[✅] استقرار و همگام‌سازی با موفقیت به پایان رسید!');
            return { 
                success: true, 
                message: 'Worker deployed successfully!', 
                url: finalUrl,
                uuid: uuid,
                tr_pass: trPass,
                sub_path: subPath
            };

        } catch (e) {
            onLog(`[❌] خطا در استقرار: ${e.message}`);
            return { success: false, message: e.message };
        }
    }
    async fetchCloudConfigs() {
        const deployedAccounts = this.accounts.filter(a => a.status === 'deployed' && a.workerUrl && a.sub_path);
        let allLogs = [];
        if (deployedAccounts.length === 0) return { configs: [], logs: ['[⚠️] هیچ اکانت فعالی برای استخراج کانفیگ یافت نشد.'] };

        const fetchPromises = deployedAccounts.map(async (acc) => {
            try {
                const url = `${acc.workerUrl}/sub/raw/${acc.sub_path}?app=xray`;
                allLogs.push(`[🔍] در حال درخواست کانفیگ از: ${acc.workerUrl}`);
                const res = await gtFetch(url, { timeoutMs: 25000 });
                if (!res.ok) {
                    allLogs.push(`[❌] خطای سرور (${res.status}) در هنگام دریافت کانفیگ از ${acc.workerUrl}`);
                    return [];
                }
                const base64Data = await res.text();
                
                if (base64Data.trim().startsWith('<')) {
                    allLogs.push(`[❌] دیتای دریافتی از سرور نامعتبر است (HTML دریافت شد). احتمالاً پنل هنوز به درستی کانفیگ نشده است.`);
                    const titleMatch = base64Data.match(/<title>(.*?)<\/title>/i);
                    if (titleMatch) {
                        allLogs.push(`[⚠️] عنوان صفحه: ${titleMatch[1]}`);
                    }
                    
                    // Try to extract the error message from the BPB Panel error page
                    // The error is usually injected somewhere in the body. We can look for "Error" or "Exception"
                    const textContent = base64Data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                    const errorMatch = textContent.match(/An error occurred.*?(?=\s{2,}|$)/i) || textContent.match(/Error:.*?(?=\s{2,}|$)/i) || textContent.match(/Please set.*?(?=\s{2,}|$)/i) || textContent.match(/Invalid.*?(?=\s{2,}|$)/i);
                    
                    if (errorMatch) {
                        allLogs.push(`[⚠️] پیام ارور داخل صفحه: ${errorMatch[0]}`);
                    } else {
                        // Just dump a snippet of the text
                        allLogs.push(`[⚠️] بخشی از متن صفحه: ${textContent.substring(0, 100)}...`);
                    }
                    
                    return [];
                }

                try {
                    const decoded = Buffer.from(base64Data, 'base64').toString('utf8');
                    const configs = decoded.split('\n').filter(l => l.trim().startsWith('vless://') || l.trim().startsWith('trojan://')).map(c => applySniCamouflage(c));
                    if (configs.length > 0) {
                        allLogs.push(`[✅] تعداد ${configs.length} کانفیگ با موفقیت استخراج شد.`);
                    } else {
                        allLogs.push(`[⚠️] دیتای سرور با موفقیت دیکد شد اما هیچ کانفیگ VLESS/Trojan معتبری در آن یافت نشد.`);
                    }
                    return { accountName: acc.name, configs: configs };
                } catch (decodeErr) {
                    allLogs.push(`[❌] خطای دیکد کردن دیتای Base64: ${decodeErr.message}`);
                    return { accountName: acc.name, configs: [] };
                }
            } catch (e) {
                console.error(`Failed to fetch from ${acc.name}:`, e.message);
                allLogs.push(`[❌] خطای شبکه در ارتباط با ${acc.workerUrl}: ${e.message}`);
                return { accountName: acc.name, configs: [] };
            }
        });

        const results = await Promise.all(fetchPromises);
        // results is an array of { accountName, configs }
        
        let flatConfigs = [];
        let groupedConfigs = [];
        results.forEach(r => {
            if (r.configs && r.configs.length > 0) {
                flatConfigs.push(...r.configs);
                groupedConfigs.push(r);
            }
        });

        return {
            configs: flatConfigs,
            groupedConfigs: groupedConfigs,
            logs: allLogs
        };
    }

    // Deploy a Dedicated DNS worker to the user's Cloudflare, reusing the credentials from
    // the cloud module (passed from the frontend account store). Self-contained: derives the
    // accountId from the token. Returns the workers.dev URL.
    //
    // options.mode picks which worker source is uploaded — they are separate scripts and
    // deploying one must not overwrite the other, so each gets its own generated name:
    //   'ecs' (default) -> public/dns_worker.js, region steering via ECS, KV cache
    //   'doh'           -> public/doh_worker.js, multi-resolver + edge cache, no KV
    // options.dohGroup sets the 'doh' worker's DNS_MODE binding (standard|adblock|all).
    // options.workerName REUSES an existing script name instead of generating a new one.
    // Without it, every re-deploy of the same mode minted a fresh random name and left the
    // previous script orphaned in the user's account — so a few retries during the route's
    // propagation window turned into a pile of abandoned workers.
    /**
     * Remove a worker from the user's own account.
     *
     * The counterpart to deploying one. Cloudflare answers 404 for a script that is already gone,
     * and that is reported as success rather than as an error: the user asked for it to not be
     * there, and it is not there.
     */
    async deleteWorker(rawToken, rawEmail, workerName) {
        const token = typeof rawToken === 'string' ? rawToken.replace(/[^a-zA-Z0-9_-]/g, '').trim() : '';
        const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
        const name = typeof workerName === 'string' && /^[a-z0-9-]{1,60}$/i.test(workerName) ? workerName : '';
        if (!token) return { success: false, message: 'توکن کلادفلر خالی است.' };
        if (!name) return { success: false, message: 'نام Worker مشخص نیست.' };

        const headers = {};
        if (token.startsWith('cfat_') || !email) headers['Authorization'] = `Bearer ${token}`;
        else { headers['X-Auth-Email'] = email; headers['X-Auth-Key'] = token; }

        try {
            const accounts = await (await fetch('https://api.cloudflare.com/client/v4/accounts', { headers })).json();
            const accountId = accounts && accounts.result && accounts.result[0] && accounts.result[0].id;
            if (!accountId) return { success: false, message: 'حساب کلادفلر خوانده نشد.' };

            const r = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${name}`,
                { method: 'DELETE', headers });
            if (r.ok || r.status === 404) return { success: true, message: r.status === 404 ? 'از قبل حذف شده بود.' : 'حذف شد.' };
            const body = await r.json().catch(() => null);
            const why = body && body.errors && body.errors[0] && body.errors[0].message;
            return { success: false, message: why || `کلادفلر پاسخ ${r.status} داد.` };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }

    async deployDnsWorker(rawToken, rawEmail, region = 'AE', onLog = () => {}, options = {}) {
        const mode = options.mode === 'doh' ? 'doh' : 'ecs';
        const dohGroup = ['standard', 'adblock', 'all'].includes(options.dohGroup) ? options.dohGroup : 'standard';
        const reuseName = typeof options.workerName === 'string' && /^[a-z0-9-]{1,60}$/i.test(options.workerName)
            ? options.workerName : null;
        const token = typeof rawToken === 'string' ? rawToken.replace(/[^a-zA-Z0-9_-]/g, '').trim() : '';
        const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';
        if (!token) return { success: false, message: 'توکن کلادفلر خالی است.' };

        const authHeaders = () => {
            const h = {};
            if (token.startsWith('cfat_') || !email) h['Authorization'] = `Bearer ${token}`;
            else { h['X-Auth-Email'] = email; h['X-Auth-Key'] = token; }
            return h;
        };

        // Derive the account id from the token.
        let accountId;
        try {
            const accRes = await axios.get('https://api.cloudflare.com/client/v4/accounts', { headers: authHeaders(), timeout: 10000 });
            if (accRes.data && accRes.data.success && accRes.data.result.length > 0) accountId = accRes.data.result[0].id;
            if (!accountId) throw new Error('no account');
        } catch (e) {
            return { success: false, message: 'دریافت شناسه حساب کلادفلر ناموفق بود: ' + (e.response?.data?.errors?.[0]?.message || e.message) };
        }
        const callApi = async (method, endpoint, body = null) => {
            const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}${endpoint}`;
            const headers = authHeaders();
            if (body) headers['Content-Type'] = 'application/json';
            const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
            const data = await res.json();
            if (!res.ok || !data.success) throw new Error(data.errors?.[0]?.message || 'Cloudflare API Error');
            return data;
        };

        try {
            // Ensure a clean workers.dev subdomain exists.
            let subdomain;
            try {
                const subRes = await callApi('GET', '/workers/subdomain');
                subdomain = subRes.result?.subdomain;
                if (!subdomain || containsBlacklistedKeyword(subdomain)) {
                    const safeSub = generateSafeSubdomain();
                    await callApi('PUT', '/workers/subdomain', { subdomain: safeSub });
                    subdomain = safeSub;
                }
            } catch (e) {
                const safeSub = generateSafeSubdomain();
                try { await callApi('PUT', '/workers/subdomain', { subdomain: safeSub }); subdomain = safeSub; } catch (_) {}
            }
            onLog('[☁️] ساب‌دامین workers.dev آماده شد.');

            // KV is only used by the ECS worker's per-region answer cache. The DoH worker
            // caches in the edge cache instead — a KV read there would cost more latency
            // than it saves, which is the whole point of that mode.
            let kvId = null;
            if (mode === 'ecs') {
                try {
                    const kvList = await callApi('GET', '/storage/kv/namespaces');
                    const existing = kvList.result.find(k => (k.title || '').includes('mlmvpn'));
                    kvId = existing ? existing.id : (await callApi('POST', '/storage/kv/namespaces', { title: 'mlmvpn' })).result.id;
                } catch (e) { /* KV is optional */ }
            }

            // Upload the worker as an ES module.
            // Use __dirname (not getUnpackedDir()) so Electron's fs patches can read the
            // source from inside app.asar (it's NOT in asarUnpack, unlike gst/*).
            const sourceFile = mode === 'doh' ? 'doh_worker.js' : 'dns_worker.js';
            const workerCode = fs.readFileSync(path.join(__dirname, 'public', sourceFile), 'utf8');
            // Same name = same script updated in place = same URL. Re-deploying is then a
            // safe, repeatable operation rather than an accumulating one.
            const workerName = reuseName || generateSafeWorkerName();
            if (reuseName) onLog(`[♻️] به‌روزرسانی Worker موجود: ${workerName}`);

            const bindings = mode === 'doh'
                ? [{ type: 'secret_text', name: 'DNS_MODE', text: dohGroup }]
                : [{ type: 'secret_text', name: 'DEFAULT_REGION', text: String(region).toUpperCase() }];
            if (kvId) bindings.push({ type: 'kv_namespace', name: 'KV', namespace_id: kvId });
            const metadata = { main_module: sourceFile, compatibility_date: '2024-03-03', bindings };

            const form = new FormData();
            form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
            form.append(sourceFile, new Blob([workerCode], { type: 'application/javascript+module' }), sourceFile);

            const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${workerName}`;
            const uploadRes = await fetch(uploadUrl, { method: 'PUT', headers: authHeaders(), body: form });
            const uploadData = await uploadRes.json();
            if (!uploadRes.ok || !uploadData.success) throw new Error(uploadData.errors?.[0]?.message || 'آپلود Worker ناموفق بود');
            onLog(`[☁️] سورس ${mode === 'doh' ? 'DoH (سرعت)' : 'DNS (مکان‌یابی)'} Worker آپلود شد.`);

            // Enable workers.dev route.
            try {
                await callApi('POST', `/workers/scripts/${workerName}/subdomain`, { enabled: true });
            } catch (e) {
                const safeSub = generateSafeSubdomain();
                await callApi('PUT', '/workers/subdomain', { subdomain: safeSub });
                await callApi('POST', `/workers/scripts/${workerName}/subdomain`, { enabled: true });
                subdomain = safeSub;
            }

            const url = `https://${workerName}.${subdomain}.workers.dev`;

            // Do NOT report success on the strength of the API calls alone. A workers.dev
            // route can come back 404 ("error code: 1042") after an upload that returned
            // 200 — sometimes propagation, sometimes a route that never took. Saving that
            // URL produces a feature that is configured, enabled, and dead, and the failure
            // only surfaces much later somewhere unrelated. Ask the URL itself.
            // A new workers.dev route is NOT live the moment the API returns 200 — it 404s
            // ("error code: 1042") for anywhere from a few seconds to a couple of minutes.
            // Measured on this account: both scripts answered 200 once the route caught up.
            //
            // Waiting is fine; declaring failure is not. The first version gave up after 18s
            // and reported an error, so the user re-deployed, minted another name, and ended
            // up with a pile of workers and no working one. Slow propagation now returns
            // success with `pending`, and the URL is kept either way.
            const probeUrl = mode === 'doh' ? `${url}/health` : `${url}/resolve?domain=www.google.com`;
            const deadline = Date.now() + 150_000;
            let live = false;
            let lastStatus = 0;
            let attempt = 0;
            while (!live && Date.now() < deadline) {
                attempt++;
                try {
                    const probe = await gtFetch(probeUrl, { method: 'GET', timeoutMs: 15000 });
                    lastStatus = probe.status;
                    live = probe.ok;
                } catch (e) { lastStatus = 0; }
                if (!live) {
                    const waitMs = Math.min(2000 + attempt * 1000, 10000);
                    onLog(`[⏳] مسیر workers.dev هنوز فعال نشده (تلاش ${attempt})… ${Math.round((deadline - Date.now()) / 1000)} ثانیه فرصت`);
                    await new Promise(r => setTimeout(r, waitMs));
                }
            }

            if (live) onLog(`[✅] DNS Worker آماده شد و پاسخ داد: ${url}`);
            else onLog(`[⚠️] Worker آپلود شد ولی مسیرش هنوز بالا نیامده (کد ${lastStatus || 'بدون پاسخ'}) — خودش آماده می‌شود.`);

            return {
                success: true,
                url,
                workerName,
                mode,
                pending: !live,
                message: live
                    ? undefined
                    : 'Worker مستقر شد. مسیر آن هنوز روی کلادفلر بالا نیامده و طی چند دقیقه آماده می‌شود — نیازی به استقرار دوباره نیست.',
            };
        } catch (e) {
            return { success: false, message: e.message };
        }
    }
}

module.exports = new CloudManager();
