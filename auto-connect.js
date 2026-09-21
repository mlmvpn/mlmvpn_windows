// --- Automatic proxy bring-up ---
//
// "روی کل ویندوز" promises that turning one switch on opens every site. Half of that
// promise needs a tunnel, and a tunnel needs a config and a reachable Cloudflare IP — but
// asking the user to go to the V2Ray tab, pick a node and connect it first turns one
// switch into a procedure, and the switch gets blamed when the procedure is skipped.
//
// Everything required is already on disk from work the user has done previously: the
// worker they deployed, the IPs they scanned, the accounts they added. This module finds
// them and brings the proxy up on its own.
//
// It deliberately does NOT deploy anything or scan anything. Both are slow and visible,
// and a switch that silently spends two minutes provisioning is worse than one that says
// what is missing.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const STORAGE_FILE = path.join(os.homedir(), '.mlmvpn', 'user_data.json');

function readStore() {
    try {
        return JSON.parse(fs.readFileSync(STORAGE_FILE, 'utf8'));
    } catch (e) {
        try {
            return JSON.parse(fs.readFileSync(STORAGE_FILE + '.bak', 'utf8'));
        } catch (e2) {
            return {};
        }
    }
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try { const p = JSON.parse(value); return Array.isArray(p) ? p : []; } catch (e) { return []; }
    }
    return [];
}

function isConfigUri(s) {
    return typeof s === 'string' && /^(vless|trojan|vmess):\/\//i.test(s.trim());
}

/**
 * Every config this machine already knows about, best-first.
 *
 * Order is by how much the user controls the endpoint, not by speed: a worker on their own
 * Cloudflare account cannot be taken away or shared into congestion, so it is tried before
 * anything that came from a subscription.
 */
function findConfigs() {
    const store = readStore();
    const out = [];
    const push = (uri, source) => {
        if (isConfigUri(uri)) out.push({ uri: uri.trim(), source });
    };

    // 1. The user's own deployed Cloudflare panel workers.
    for (const entry of asArray(store.cf_base_configs)) {
        for (const c of asArray(entry && entry.configs)) push(c, `worker: ${entry.name || 'cloudflare'}`);
    }
    // 2. Configs last fetched from those workers.
    for (const c of asArray(store['latest-cloud-configs'])) push(c, 'cloud');
    // 3. «کانفیگ آیپی ثابت» servers. The old key is still read because the panel only
    // rewrites it on the next save — see VODI_NODES_LEGACY_KEY in public/components/vodi.js.
    for (const entry of asArray(store.vodi_nodes || store.x4g_nodes)) {
        for (const c of asArray(entry && entry.configs)) push(c, `ip ثابت: ${entry.name || 'server'}`);
    }
    // 4. Whatever the user added by hand.
    for (const n of asArray(store.v2rayNodes)) push(n && n.uri, 'manual');

    // De-duplicate while keeping the first (highest priority) occurrence.
    const seen = new Set();
    return out.filter((c) => (seen.has(c.uri) ? false : seen.add(c.uri)));
}

/**
 * The best clean Cloudflare IP this machine has measured.
 *
 * A config pointed at a workers.dev name resolves to an edge address that may be one of
 * the ones this ISP throttles or blocks; the scanner exists precisely to find one that is
 * not. Reusing that result is free — re-scanning here would take minutes.
 */
function findCleanIp() {
    const store = readStore();

    const archived = asArray(store.ipscanner_archived_ips)
        .filter((n) => n && n.ip && n.healthy !== false && typeof n.delay === 'number' && n.delay > 0)
        .sort((a, b) => a.delay - b.delay);
    if (archived.length) return { ip: archived[0].ip, port: archived[0].port || 443, delay: archived[0].delay, source: 'archived' };

    const history = asArray(store.ipscanner_history)
        .filter((h) => h && h.bestIp)
        .sort((a, b) => (a.bestDelay || 1e9) - (b.bestDelay || 1e9));
    if (history.length) return { ip: history[0].bestIp, port: 443, delay: history[0].bestDelay, source: 'history' };

    return null;
}

/** Every clean-IP candidate this machine knows about, unranked. */
function candidateIps(limit = 24) {
    const store = readStore();
    const seen = new Set();
    const out = [];
    const push = (ip, port) => {
        if (!ip || seen.has(ip) || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return;
        seen.add(ip);
        out.push({ ip, port: port || 443 });
    };
    for (const n of asArray(store.ipscanner_archived_ips)) if (n && n.healthy !== false) push(n.ip, n.port);
    for (const h of asArray(store.ipscanner_history)) push(h && h.bestIp, 443);
    return out.slice(0, limit);
}

function tcpPing(host, port, timeout = 2500) {
    return new Promise((resolve) => {
        const started = Date.now();
        const sock = net.connect({ host, port, timeout });
        const done = (ms) => { try { sock.destroy(); } catch (e) {} resolve(ms); };
        sock.on('connect', () => done(Date.now() - started));
        sock.on('timeout', () => done(-1));
        sock.on('error', () => done(-1));
    });
}

/**
 * Measure the candidates NOW and take the fastest.
 *
 * The stored `delay` is whatever the scanner recorded whenever it last ran, and Cloudflare
 * edge latency moves with routing, time of day and which POP the ISP is peering with.
 * Measured on this machine: the archive's top-ranked IP answered in 1760ms while another
 * entry in the same archive answered in 141ms — a twelvefold difference, and the tunnel was
 * being built on the slow one. Ranking costs about two seconds in parallel; getting it
 * wrong costs every request for the whole session.
 */
async function pickFastestIp(limit = 24, concurrency = 10) {
    const candidates = candidateIps(limit);
    if (!candidates.length) return null;

    const results = [];
    const queue = [...candidates];
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length) {
            const c = queue.shift();
            const ms = await tcpPing(c.ip, c.port);
            if (ms > 0) results.push({ ...c, delay: ms });
        }
    }));

    if (!results.length) return findCleanIp(); // nothing answered; a stale guess beats none
    results.sort((a, b) => a.delay - b.delay);
    return { ...results[0], source: 'measured', tested: candidates.length, alive: results.length };
}

function portIsLive(port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port, timeout: timeoutMs });
        const done = (ok) => { try { sock.destroy(); } catch (e) {} resolve(ok); };
        sock.on('connect', () => done(true));
        sock.on('timeout', () => done(false));
        sock.on('error', () => done(false));
    });
}

async function waitForPort(port, totalMs = 12000) {
    const deadline = Date.now() + totalMs;
    while (Date.now() < deadline) {
        if (await portIsLive(port)) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
}

/**
 * Bring a proxy up without involving the user, if one is not already running.
 *
 * Returns a reason rather than throwing when there is nothing to connect with: the DNS
 * half of the feature works regardless and must not be rolled back over this.
 */
async function ensureProxy(onLog = () => {}, socksPort = require('./xray-manager').getPorts().socks) {
    const xray = require('./xray-manager');

    if (xray.isRunning() && await portIsLive(socksPort)) {
        return { ok: true, alreadyRunning: true };
    }

    const configs = findConfigs();
    if (!configs.length) {
        return {
            ok: false,
            reason: 'no-config',
            message: 'هیچ کانفیگی روی این سیستم ذخیره نیست. از تب «زیرساخت ابری» یک حساب کلادفلر اضافه کن تا Worker پروکسی ساخته شود.',
        };
    }

    const chosen = configs[0];
    onLog(`[AUTO] کانفیگ انتخاب شد (${chosen.source})`);

    onLog('[AUTO] سنجش زنده‌ی آی‌پی‌های تمیز…');
    const clean = await pickFastestIp();
    if (clean && clean.source === 'measured') {
        onLog(`[AUTO] آی‌پی تمیز: ${clean.ip}:${clean.port} — ${clean.delay}ms (سریع‌ترین از ${clean.alive} آی‌پی زنده از ${clean.tested} تست‌شده)`);
    } else if (clean) {
        onLog(`[AUTO] هیچ آی‌پی‌ای جواب نداد؛ از آخرین نتیجه‌ی آرشیو استفاده می‌شود: ${clean.ip}`);
    } else {
        onLog('[AUTO] آی‌پی تمیزی ذخیره نشده — از آدرس خود کانفیگ استفاده می‌شود.');
    }

    try {
        // useSystemProxy is false on purpose: TUN is about to take the default route, and
        // setting a system proxy as well sends browser traffic through two hops.
        await xray.startXray(
            chosen.uri,
            clean ? clean.ip : null,
            clean ? clean.port : null,
            null,
            false,
            onLog
        );
    } catch (e) {
        return { ok: false, reason: 'start-failed', message: `اتصال خودکار ناموفق بود: ${e.message}` };
    }

    if (!(await waitForPort(socksPort))) {
        return { ok: false, reason: 'no-socks', message: 'هسته اجرا شد ولی پورت پروکسی بالا نیامد.' };
    }

    onLog('[AUTO] ✅ پروکسی آماده است.');
    return { ok: true, config: chosen, cleanIp: clean };
}

module.exports = {
    ensureProxy, findConfigs, findCleanIp, pickFastestIp, candidateIps, tcpPing,
    waitForPort, portIsLive, STORAGE_FILE,
};
