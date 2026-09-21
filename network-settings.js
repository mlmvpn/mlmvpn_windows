// --- Settings › «شبکه»: the one owner of the local proxy's shape (Android's NetworkSettings) ---
//
// On Android, NetworkSettings is the only place the local port, the backend DNS, the proxy mode,
// LAN sharing and the MTU live; engines ask it and keep no copies. This is the same for Windows,
// saved in ~/.mlmvpn/network-settings.json. What each setting does here:
//
//   socksPort / httpPort — Xray's two local listeners (20808 / 20809 until 1.2.2, fixed). A new
//        value takes effect when Xray next starts: a running engine keeps listening where it
//        started, and xray-manager.getPorts() answers with those while it runs.
//   allowLan — the two listeners on every interface instead of loopback, so a phone or another
//        PC on the same network can use this machine's connection.
//   proxyMode — 'system': a one-tap connection (Iran configs, domain fronting, SNI) turns the
//        Windows proxy on. 'port': it only publishes the local ports, and Windows' own proxy
//        setting is left alone.
//   backendDns — how Xray resolves the config's OWN server name. 'system' asks Windows, as
//        before. An address or a DoH URL asks that resolver instead — for the day the ISP's
//        resolver poisons a worker's hostname and the config "cannot connect" for no visible
//        reason.
//   mtu — the full-system tunnel adapter's MTU: one app-wide value and one per method, 0 each
//        for automatic. Most specific first, as on Android (Settings › تنظیمات پیشرفته VPN › MTU):
//        the method's own value, then «همهٔ روش‌ها», then the default. The methods are the ones
//        Windows has — Android's Psiphon, Tor and MLM Gateway have no Windows engine — plus the
//        Google Script tunnel, which only Windows has.
//   tunStack — which network stack the full-system tunnel runs on. 'gvisor' reimplements TCP in
//        userspace and works everywhere; 'system' hands packets to Windows' own stack and is
//        measurably faster on a fast line. 'auto' tries the fast one and falls back the moment it
//        refuses to come up. A lever, not a silent change: the tunnel's own speed report
//        (~/.mlmvpn/tunnel-events.log) names the stack next to the number it produced, so the
//        choice can be made from a measurement instead of a guess.
//   allowBrowserDoh — let a browser keep using its own DNS-over-HTTPS instead of this tunnel's
//     resolver. Off by default; see BROWSER_DOH_HOSTS in tun-manager.js for what it costs.
//   tunLogVerbose — sing-box (and Xray behind it) at `info` instead of `warn`. `info` names every
//        connection and every lookup, which is what diagnoses «تونل وصل است ولی چیزی رد نمی‌شود» —
//        and, on a busy machine, it is thousands of lines a minute crossing a pipe into Electron's
//        main thread, where they cost the tunnel real throughput. Off by default, on when
//        something needs explaining.

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

const FILE = path.join(os.homedir(), '.mlmvpn', 'network-settings.json');

const DEFAULTS = Object.freeze({
    socksPort: 20808,
    httpPort: 20809,
    allowLan: false,
    proxyMode: 'system',
    backendDns: 'system',
    mtu: Object.freeze({ global: 0, masque: 0, wireguard: 0, gool: 0, quick: 0, sni: 0, v2ray: 0, gst: 0 }),
    tunStack: 'gvisor',
    tunLogVerbose: false,
});

// 'gvisor' stays the default, deliberately. It is what every tunnel this app has ever built used,
// so nobody's connection changes on update; 'system' is offered to the user whose line is fast
// enough for the userspace stack to be the bottleneck, and 'auto' is 'system' with the existing
// fall-back-to-gvisor retry armed.
const TUN_STACKS = ['gvisor', 'system', 'auto'];

// The adapter's value when nothing is set. It is what every tunnel has used so far, kept as the
// default so nobody's connection changes on update.
const DEFAULT_MTU = 1420;
const MIN_MTU = 576;
const MAX_MTU = 1500;
// Android's order (NetworkSettings.Method), Windows' methods only.
const MTU_METHODS = ['masque', 'wireguard', 'gool', 'quick', 'sni', 'v2ray', 'gst'];
const MTU_ENGINES = MTU_METHODS;

/**
 * What each method wraps round a packet on the wire, measured by the Android build on a 1500 line
 * (MtuProbe.OVERHEAD). The methods not listed end every connection on this machine and re-open it
 * through a local proxy — Android's LOCAL_TERMINATION — so their adapter MTU never reaches the
 * network, 1500 is simply best, and there is nothing to measure.
 */
const MTU_OVERHEAD = Object.freeze({ masque: 196, wireguard: 60, gool: 280 });
const LOCAL_TERMINATION = Object.freeze(['quick', 'sni', 'v2ray', 'gst']);

/** The aether engine's protocol names, as the MTU keys the settings use. */
function methodOfAether(protocol) {
    if (protocol === 'wg') return 'wireguard';
    if (protocol === 'gool') return 'gool';
    return 'masque';
}

// Ports other parts of the app already own. A local port on any of them is a bind race whose
// loser fails long after the UI said "connecting".
const RESERVED_PORTS = new Map([
    [20085, 'آمار Xray'], [20810, 'موتورهای وارپ'], [20811, 'موتورهای وارپ'],
    [20812, 'تونل گیت‌هاب'], [20813, 'تونل گیت‌هاب'], [40443, 'موتور SNI'],
    [11666, 'دامین فرانتینگ'], [11777, 'دامین فرانتینگ'],
]);

let cache = null;

function clampMtu(v) {
    const n = Math.round(Number(v) || 0);
    if (n <= 0) return 0;
    return Math.min(MAX_MTU, Math.max(MIN_MTU, n));
}

function validDns(v) {
    const s = String(v || '').trim();
    if (!s || s === 'system') return 'system';
    if (net.isIP(s)) return s;
    if (/^(https|tls|quic):\/\/[^\s/]+(\/[^\s]*)?$/i.test(s)) return s;
    return null;
}

/** Everything saved, with every field present and valid. */
function get() {
    if (cache) return cache;
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { raw = {}; }
    const port = (v, d) => (Number.isInteger(Number(v)) && Number(v) > 1024 && Number(v) < 65536 ? Number(v) : d);
    const out = {
        socksPort: port(raw.socksPort, DEFAULTS.socksPort),
        httpPort: port(raw.httpPort, DEFAULTS.httpPort),
        allowLan: raw.allowLan === true,
        proxyMode: raw.proxyMode === 'port' ? 'port' : 'system',
        backendDns: validDns(raw.backendDns) || 'system',
        mtu: Object.assign({}, DEFAULTS.mtu),
    };
    for (const k of ['global', ...MTU_METHODS]) out.mtu[k] = clampMtu(raw.mtu && raw.mtu[k]);
    out.tunStack = TUN_STACKS.includes(raw.tunStack) ? raw.tunStack : DEFAULTS.tunStack;
    out.tunLogVerbose = raw.tunLogVerbose === true;
    // ON unless the user says otherwise. See BROWSER_DOH_HOSTS in tun-manager: a browser that
    // resolves through its own DoH bypasses this tunnel's DNS entirely — no TTL rewrite, no
    // sinkhole rejection, no cache — and on a slow tunnel that alone makes the browser
    // unusable (measured 4.4–7.2 s per name, against a page that opens in 3.5 s through the
    // system resolver). The opt-out exists for anyone who deliberately wants their browser's
    // own resolver, and for finding out whether this rule is ever the thing that broke a site.
    out.allowBrowserDoh = raw.allowBrowserDoh === true;
    // 1.2.2's first build had one «وارپ» value for all three WARP methods; it becomes each one's
    // own value until the user sets that method separately.
    const oldWarp = clampMtu(raw.mtu && raw.mtu.warp);
    if (oldWarp) for (const k of ['masque', 'wireguard', 'gool']) if (!(raw.mtu && raw.mtu[k] !== undefined)) out.mtu[k] = oldWarp;
    // A pair that collides (hand-edited file) falls back to the defaults rather than failing.
    if (out.socksPort === out.httpPort) { out.socksPort = DEFAULTS.socksPort; out.httpPort = DEFAULTS.httpPort; }
    cache = out;
    return out;
}

/**
 * Merge a change in and save it. Throws a user-facing Persian message when it cannot be used,
 * and saves nothing in that case.
 */
function set(patch) {
    const cur = get();
    const next = JSON.parse(JSON.stringify(cur));
    const p = patch || {};

    for (const k of ['socksPort', 'httpPort']) {
        if (p[k] === undefined) continue;
        const n = Number(p[k]);
        if (!Number.isInteger(n) || n <= 1024 || n >= 65536) throw new Error(`پورت ${p[k]} معتبر نیست — عددی بین ۱۰۲۵ و ۶۵۵۳۵ بدهید.`);
        if (RESERVED_PORTS.has(n)) throw new Error(`پورت ${n} مال ${RESERVED_PORTS.get(n)} است؛ پورت دیگری انتخاب کنید.`);
        next[k] = n;
    }
    if (next.socksPort === next.httpPort) throw new Error('پورت SOCKS و HTTP نمی‌توانند یکی باشند.');
    if (p.allowLan !== undefined) next.allowLan = p.allowLan === true;
    if (p.proxyMode !== undefined) {
        if (!['system', 'port'].includes(p.proxyMode)) throw new Error('حالت پروکسی شناخته نشد.');
        next.proxyMode = p.proxyMode;
    }
    if (p.backendDns !== undefined) {
        const d = validDns(p.backendDns);
        if (!d) throw new Error('سرور DNS باید یک آدرس IP یا نشانی DoH/DoT باشد (مثل https://1.1.1.1/dns-query).');
        next.backendDns = d;
    }
    if (p.mtu && typeof p.mtu === 'object') {
        for (const k of ['global', ...MTU_METHODS]) if (p.mtu[k] !== undefined) next.mtu[k] = clampMtu(p.mtu[k]);
    }
    if (p.tunStack !== undefined) {
        if (!TUN_STACKS.includes(p.tunStack)) throw new Error('پشته‌ی تونل شناخته نشد (gvisor | system | auto).');
        next.tunStack = p.tunStack;
    }
    if (p.tunLogVerbose !== undefined) next.tunLogVerbose = p.tunLogVerbose === true;
    if (p.allowBrowserDoh !== undefined) next.allowBrowserDoh = p.allowBrowserDoh === true;
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    cache = next;
    return next;
}

/**
 * Which stack the full-system tunnel should ask for, and whether a refusal may fall back.
 * `auto` and `system` both ask for the fast one; only `auto` says "and take gvisor if it dies".
 */
function tunStack() {
    const v = get().tunStack;
    return { name: v === 'gvisor' ? 'gvisor' : 'system', fallback: v !== 'system' };
}

/** The log level every tunnel engine runs at. See tunLogVerbose. */
function tunLogLevel() { return get().tunLogVerbose ? 'info' : 'warn'; }

/** Should the tunnel refuse a browser's own DNS-over-HTTPS? Default yes. */
function blockAppDoh() { return get().allowBrowserDoh !== true; }

/** The address Xray's listeners bind to. */
function listenHost() { return get().allowLan ? '0.0.0.0' : '127.0.0.1'; }

/**
 * Which MTU key a tunnel uses. `method` is the caller's when it knows better than the process
 * does (Xray carries V2Ray, «اتصال سریع» and «ضد فیلتر SNI» alike; aether carries all three
 * WARP methods).
 */
function engineOf(processName, method) {
    if (method && MTU_METHODS.includes(method)) return method;
    const p = String(processName || '').toLowerCase();
    if (p === 'xray.exe') return 'v2ray';
    if (p === 'aether.exe') return 'masque';
    if (p === 'gst.exe') return 'gst';
    return null;
}

/** The tunnel MTU for this method: its own value, then the app-wide one, then the default. */
function mtuFor(processName, method) {
    const m = get().mtu;
    const e = engineOf(processName, method);
    return (e && m[e]) || m.global || DEFAULT_MTU;
}

/**
 * Android's «پیدا کردن بهترین مقدار برای این خط» for one method: the line's own largest packet,
 * less what the method wraps round each one. The WARP methods are measured against a WARP
 * endpoint (their packets' actual path); the rest need no measurement (LOCAL_TERMINATION).
 */
async function measureMethod(method) {
    if (!MTU_METHODS.includes(method)) throw new Error('روش شناخته نشد.');
    if (LOCAL_TERMINATION.includes(method)) return { ok: true, method, localTermination: true, inner: MAX_MTU, probes: 0 };
    const host = '162.159.192.1';
    const r = await probeLineMtu({ host });
    if (!r.ok) return Object.assign({ method, localTermination: false, inner: null }, r);
    const inner = Math.min(MAX_MTU, Math.max(MIN_MTU, r.mtu - (MTU_OVERHEAD[method] || 0)));
    return { ok: true, method, localTermination: false, outer: r.mtu, inner, probes: r.probes, host };
}

/** This machine's addresses another device on the same network can reach it on. */
function lanAddresses() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const [name, list] of Object.entries(ifs)) {
        // The tunnels' own adapters are not the LAN.
        if (/mlmvpn|sing-?box|tailscale|wintun|wireguard|vethernet|loopback/i.test(name)) continue;
        for (const a of list || []) {
            if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push({ name, address: a.address });
        }
    }
    return out;
}

/**
 * The largest packet this line carries whole: pings with "don't fragment" set, binary-searched
 * over the payload size (+28 bytes of IPv4 and ICMP header = the MTU). Android's MTU probe does
 * the same with its own packets. Judged by the exit code and the "TTL=" of a reply, never by the
 * rest of ping's text — Windows translates that, and a German or Persian install says it
 * differently. A failed size is asked twice before it counts, so one lost packet on a lossy
 * line does not read as "too big". Run it with no tunnel up: through the adapter it would
 * measure the tunnel's own buffer, not the line.
 */
async function probeLineMtu({ host = '1.1.1.1' } = {}) {
    const { execFile } = require('child_process');
    const once = (size) => new Promise((resolve) => {
        execFile('ping', ['-n', '1', '-w', '1500', '-f', '-l', String(size), host], { windowsHide: true, timeout: 6000 }, (err, out) => {
            resolve(!err && /TTL=/i.test(String(out || '')));
        });
    });
    let probes = 0;
    const carries = async (size) => { probes++; return (await once(size)) || (await once(size)); };
    if (!(await carries(64))) return { ok: false, reason: 'no-reply', host, probes };
    let lo = 548 - 28;          // the smallest datagram IPv4 guarantees, as payload
    let hi = MAX_MTU - 28;      // a full Ethernet frame, as payload
    if (await carries(hi)) return { ok: true, mtu: MAX_MTU, host, probes };
    if (!(await carries(lo))) return { ok: false, reason: 'tiny', host, probes };
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if (await carries(mid)) lo = mid; else hi = mid;
    }
    return { ok: true, mtu: lo + 28, host, probes };
}

function _resetForTests() { cache = null; }

module.exports = {
    blockAppDoh,
    get, set, listenHost, mtuFor, engineOf, lanAddresses, probeLineMtu, measureMethod, methodOfAether,
    tunStack, tunLogLevel, TUN_STACKS,
    DEFAULTS, DEFAULT_MTU, MIN_MTU, MAX_MTU, MTU_ENGINES, MTU_METHODS, MTU_OVERHEAD, LOCAL_TERMINATION,
    RESERVED_PORTS, FILE, _resetForTests,
};
