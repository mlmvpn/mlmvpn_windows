const trafficMgr = require('./traffic-manager');
// Where this engine's byte counts go: traffic-feed adds them to the day's usage and pushes
// live speed to the UI — unless an outer engine (the full-system tunnel, the GitHub tunnel)
// is carrying the same bytes and counting them already.
const trafficFeed = require('./traffic-feed');
const { spawn, execSync, execFile } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { generateMixedCaseSNI } = require('./anti-dpi');
const dedicatedDns = require('./dedicated-dns-manager');
const tlsFingerprint = require('./tls-fingerprint');

let xrayProcess = null;
let currentConfigUri = null;

// Everything startXray() was last called with. Kept so a setting that changes the
// GENERATED config (dedicated DNS, for one) can be re-applied to a live connection
// without asking the user to disconnect and reconnect by hand.
//
// `useSystemProxy` is the load-bearing field: stopXray() unconditionally turns the
// Windows system proxy off, so a restart that forgot this flag would leave the user
// connected but with no proxy set — internet apparently dead, no visible cause.
let lastStartArgs = null;

// «پورت محلی» / «اتصال شبکه محلی» (network-settings.js). A running engine keeps listening
// where it started, so everything asks getPorts(): the ports of the live process while there is
// one, the configured ones otherwise. A changed setting takes over at the next start.
const netSettings = require('./network-settings');
const corePaths = require('./core-paths');
let activePorts = null;
function configuredPorts() {
    const s = netSettings.get();
    return { socks: s.socksPort, http: s.httpPort, listen: netSettings.listenHost() };
}
function getPorts() {
    return activePorts && isRunning() ? activePorts : configuredPorts();
}

let trafficInterval = null;
// The callback the running connection gave startTrafficPolling(), so switching monitoring
// back on can resume polling without a reconnect.
let lastTrafficOnLog = null;

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar') ? __dirname.replace(/\.asar/gi, '.asar.unpacked') : __dirname;
}

function startTrafficPolling(onLog) {
    lastTrafficOnLog = onLog;
    if (trafficInterval) clearInterval(trafficInterval);
    trafficInterval = null;
    // Monitoring off: no `xray api statsquery` process every second, no disk write.
    if (!trafficMgr.isEnabled()) return;
    const exeDir = getUnpackedDir();
    const xrayExe = corePaths.file('xray', 'xray.exe', path.join(exeDir, 'core', 'xray.exe'));
    
    trafficMgr.startSession();
    let lastUp = 0;
    let lastDown = 0;
    
    trafficInterval = setInterval(() => {
        try {
            execFile(xrayExe, ['api', 'statsquery', '-server=127.0.0.1:20085'], { timeout: 3000 }, (err, stdout) => {
                if (err) return;
                try {
                    const data = JSON.parse(stdout);
                    if (data && data.stat) {
                        const { up, down } = sumTrafficStats(data.stat);
                        
                        const upDiff = up - lastUp;
                        const downDiff = down - lastDown;

                        // The first reading is only a baseline. After that, one push a second:
                        // traffic-feed counts it and broadcasts live speed. (It used to go out
                        // through onLog as a JSON line, which only the V2Ray route turned into a
                        // speed update — the WARP engines' route printed it into the console.)
                        if (lastUp !== 0 || lastDown !== 0) {
                            trafficFeed.push('xray', upDiff > 0 ? upDiff : 0, downDiff > 0 ? downDiff : 0);
                        }

                        lastUp = up;
                        lastDown = down;
                    }
                } catch(e) {}
            });
        } catch(e) {}
    }, 1000);
}

/**
 * One figure from Xray's counters, each byte once. Counters are named
 * "inbound|outbound>>>tag>>>traffic>>>uplink|downlink". The 'api' listener is left out — its
 * own once-a-second stats query used to show as ~1 KB/s on an idle connection. Where the
 * config tags its listeners (the WARP-through-Xray chain) the inbound side is the count;
 * elsewhere they are untagged, which Xray does not count, so the outbound side is.
 */
function sumTrafficStats(stats) {
    const t = { inbound: { up: 0, down: 0, seen: false }, outbound: { up: 0, down: 0, seen: false } };
    for (const s of stats || []) {
        const [kind, tag, , dir] = String((s && s.name) || '').split('>>>');
        const side = t[kind];
        if (!side || tag === 'api') continue;
        side.seen = true;
        const v = parseInt(s.value, 10) || 0;
        if (dir === 'uplink') side.up += v;
        else if (dir === 'downlink') side.down += v;
    }
    const pick = t.inbound.seen ? t.inbound : t.outbound;
    return { up: pick.up, down: pick.down };
}

function stopTrafficPolling() {
    if (trafficInterval) clearInterval(trafficInterval);
    trafficInterval = null;
    lastTrafficOnLog = null;
    trafficMgr.resetSession();
}

/** «غیرفعال شدن مانیتورینگ مصرف»: takes effect on the live connection, both ways. */
function setTrafficMonitoring(on) {
    trafficMgr.setEnabled(on);
    if (!on) {
        if (trafficInterval) clearInterval(trafficInterval);
        trafficInterval = null;
        return;
    }
    if (!trafficInterval && lastTrafficOnLog && isRunning()) startTrafficPolling(lastTrafficOnLog);
}
function getTrafficMonitoring() { return trafficMgr.isEnabled(); }
/** Is this engine's byte counting running (a V2Ray node, or a WARP engine chained through Xray)? */
function isTrafficPolling() { return !!trafficInterval; }


/**
 * هر گزینه‌ای که هسته‌ی جدید حذف کرده را از یک کانفیگ خامِ JSON پاک می‌کند (بازگشتی).
 *
 * لازم است چون کاربر می‌تواند کانفیگ JSON کامل یا outbound خام paste کند و اکثر
 * کانفیگ‌های موجود در دنیا هنوز allowInsecure دارند. در هسته‌ی 26.7.28 وجود این فیلد
 * باعث می‌شود بارگذاری کل فایل شکست بخورد، پس یک فیلدِ منسوخ در یک نود، همه‌ی نودها
 * را از کار می‌اندازد. پاک کردنش کانفیگ را سخت‌گیرانه‌تر (امن‌تر) می‌کند، نه شکسته‌تر.
 */
function stripRemovedTlsOptions(node) {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) {
        node.forEach(stripRemovedTlsOptions);
        return node;
    }
    if ('allowInsecure' in node) delete node.allowInsecure;
    Object.values(node).forEach(stripRemovedTlsOptions);
    return node;
}

/**
 * Full-tunnel mode changes what "direct" is allowed to mean.
 *
 * With the system proxy, Xray's split rules are exactly right: Iranian sites and DNS go out
 * on the real connection at full speed, and only what needs the proxy uses it. Windows is
 * still doing its own DNS, so nothing about the machine is claimed to be protected.
 *
 * Under the whole-system tunnel those same rules are a deanonymisation. sing-box hands
 * EVERYTHING to Xray, so `{ port: 53 -> direct }` sends every hijacked lookup back out the
 * physical interface — where the ISP resets it (seen as
 * "raw-read tcp 192.168.1.153:...->1.1.1.1:53 ... forcibly closed") or answers it with a
 * poisoned record. The poisoned answer is an Iranian address, `{ geoip:ir -> direct }` then
 * sends the connection out in the clear, and the user checks their IP and sees Iran — while
 * a switch labelled "no leaks" is on.
 *
 * So in this mode the bypasses that leave the machine are dropped. `geoip:private` stays:
 * the LAN is not a leak, and routing it into the tunnel would break printers and NAS.
 */
let fullTunnelMode = false;
function setFullTunnelMode(on) { fullTunnelMode = !!on; }
function getFullTunnelMode() { return fullTunnelMode; }

/**
 * vmess:// and ss:// — the other 40% of the free-config pool.
 *
 * Xray runs both protocols natively; this app simply had no parser for their URI formats,
 * so every vmess and shadowsocks node was unusable — it could not be delay-tested and could
 * not be connected to. In the aggregated free pool that is 2114 shadowsocks and 1810 vmess
 * entries out of ~9950, so leaving them out throws away four configs in ten.
 *
 * Deliberately NOT covered: hysteria2, tuic and ssr. Xray does not speak them at all, so a
 * parser would only produce outbounds the core refuses — they are filtered out by name
 * instead, with a reason the user can see.
 */
// Transports the CORE still has. Checked against xray 26.7.28, which removed the plain
// HTTP/2 transport outright:
//     The feature HTTP transport (without header padding, etc.) has been removed and
//     migrated to XHTTP stream-one H2 & H3.
// That error is fatal to the WHOLE config, not to the one outbound — so a single h2 node
// slipping through means no delay test runs at all and every node reports as dead.
// The AEAD ciphers xray 26.7.28 accepts. Anything else (aes-*-cfb, rc4-md5, the non-IETF
// chacha20 variants) is rejected by the core at load time, not at connect time.
const SS_CIPHERS = [
    'aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm',
    'chacha20-poly1305', 'chacha20-ietf-poly1305',
    'xchacha20-poly1305', 'xchacha20-ietf-poly1305',
    '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305',
    'none', 'plain',
];

// `raw` is Xray's current name for the plain-TCP transport; `tcp` is the older spelling and
// both are accepted by the bundled core (verified with `xray run -test` on 26.7.28). Modern
// panels emit `raw`, so leaving it out silently rejected working nodes — 197 of them in a
// single 3856-entry feed, each one showing up to the user as a mysterious dead server.
const XRAY_TRANSPORTS = ['tcp', 'raw', 'ws', 'grpc', 'httpupgrade', 'xhttp'];

function buildStreamSettings({ net, tls, host, path, sni, fp, alpn, serviceName, address, insecure }) {
    const network = net || 'tcp';
    // Same normalisation as the vless path: vmess JSON carries "tls", "", "none", "auto"
    // and occasionally junk, and only the real ones may reach the core.
    const security = (tls === 'tls' || tls === 'reality') ? tls : 'none';
    const stream = { network, security };

    if (network === 'ws') {
        stream.wsSettings = { path: path || '/', headers: { Host: host || sni || address } };
    } else if (network === 'httpupgrade') {
        stream.httpupgradeSettings = { path: path || '/', host: host || sni || address };
    } else if (network === 'grpc') {
        stream.grpcSettings = { serviceName: serviceName || path || '', multiMode: false };
    } else if (network === 'xhttp') {
        stream.xhttpSettings = { path: path || '/', host: host || sni || address };
    }
    // tcp is the default and needs no settings block; header-obfuscated tcp is rejected by
    // the caller rather than half-supported here.

    if (security === 'tls') {
        stream.tlsSettings = {
            serverName: sni || host || address,
            fingerprint: fp || 'chrome',
            alpn: network === 'ws' ? ['http/1.1'] : (alpn ? String(alpn).split(',') : ['h2', 'http/1.1']),
        };
        // `allowInsecure` was removed from the core (see the note in parseVlessUri), so a
        // config asking for it is simply verified normally rather than refused.
        void insecure;
    }
    return stream;
}

/**
 * A VLESS/VMess user id as the core reads it (common/uuid.ParseString), or null when the core
 * would refuse it: 32 hex digits with or without dashes — returned dashed, the same 16 bytes —
 * or a string of 1–30 characters, which Xray maps to a UUID itself.
 *
 * The dashed form used to be required, which rejected every config from panels that write the
 * id without dashes (the «نهان» worker this app deploys does). A working config read «UUID
 * درست نیست» and never connected.
 */
function normalizeXrayId(id) {
    const s = String(id || '');
    const hex = s.replace(/-/g, '');
    if (/^[0-9a-f]{32}$/i.test(hex) && (s.length === 32 || s.length === 36)) {
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
    }
    if (s.length >= 32) return null;   // looks like a UUID and is not one
    return s.length >= 1 && s.length <= 30 ? s : null;
}

/** vmess://<base64 of a JSON object> — the de-facto standard "v2rayN" format. */
function parseVmessUri(uri, cleanIp, cleanPort) {
    let cfg;
    try {
        const raw = Buffer.from(uri.slice('vmess://'.length).trim(), 'base64').toString('utf8');
        cfg = JSON.parse(raw);
    } catch (e) {
        throw new Error('کانفیگ vmess خوانده نشد (base64/JSON نامعتبر)');
    }

    const address = cleanIp || String(cfg.add || '').trim();
    const port = parseInt(cleanPort || cfg.port, 10);
    const id = normalizeXrayId(String(cfg.id || '').trim());
    if (!address || !port || isNaN(port)) throw new Error('کانفیگ vmess آدرس یا پورت ندارد');
    if (!id) {
        throw new Error('کانفیگ vmess شناسه‌ی معتبر ندارد');
    }

    const net = String(cfg.net || 'tcp').toLowerCase();
    if (!XRAY_TRANSPORTS.includes(net)) {
        throw new Error(`ترنسپورت vmess پشتیبانی نمی‌شود: ${net}`);
    }
    // Header-obfuscated TCP carries its own framing; representing it wrongly produces an
    // outbound that connects and then never speaks, which is worse than skipping it.
    if (net === 'tcp' && cfg.type && cfg.type !== 'none') {
        throw new Error(`vmess با هدر ${cfg.type} پشتیبانی نمی‌شود`);
    }

    return {
        protocol: 'vmess',
        settings: {
            vnext: [{
                address,
                port,
                users: [{ id, alterId: parseInt(cfg.aid, 10) || 0, security: cfg.scy || 'auto' }],
            }],
        },
        streamSettings: buildStreamSettings({
            net,
            tls: String(cfg.tls || '').toLowerCase(),
            host: cfg.host,
            path: cfg.path,
            sni: cfg.sni,
            fp: cfg.fp,
            alpn: cfg.alpn,
            serviceName: cfg.path,
            address,
            insecure: cfg['skip-cert-verify'],
        }),
        mux: { enabled: false, concurrency: 8 },
    };
}

/**
 * ss://... in both shapes:
 *   SIP002  ss://base64(method:password)@host:port#name   (or plain userinfo)
 *   legacy  ss://base64(method:password@host:port)#name
 */
function parseShadowsocksUri(uri, cleanIp, cleanPort) {
    const hash = uri.indexOf('#');
    let body = (hash === -1 ? uri : uri.slice(0, hash)).slice('ss://'.length).trim();

    // A plugin (obfs, v2ray-plugin) changes the wire format; Xray cannot load it from this
    // URI, so the node is skipped rather than silently connected without its plugin.
    const qIndex = body.indexOf('?');
    if (qIndex !== -1) {
        const query = body.slice(qIndex + 1);
        body = body.slice(0, qIndex);
        if (/(^|&)plugin=/.test(query)) throw new Error('کانفیگ ss با plugin پشتیبانی نمی‌شود');
    }

    const b64 = (s) => {
        try { return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); }
        catch (e) { return ''; }
    };

    let method = '', password = '', address = '', port = 0;
    const at = body.lastIndexOf('@');
    if (at !== -1) {
        const userinfo = body.slice(0, at);
        const hostport = body.slice(at + 1);
        const decoded = userinfo.includes(':') ? userinfo : b64(userinfo);
        const sep = decoded.indexOf(':');
        if (sep === -1) throw new Error('کانفیگ ss روش/رمز ندارد');
        method = decoded.slice(0, sep);
        password = decoded.slice(sep + 1);
        const colon = hostport.lastIndexOf(':');
        address = hostport.slice(0, colon).replace(/^\[|\]$/g, '');
        port = parseInt(hostport.slice(colon + 1), 10);
    } else {
        const decoded = b64(body);
        const m = decoded.match(/^(.+?):(.*)@(.+):(\d+)$/);
        if (!m) throw new Error('کانفیگ ss خوانده نشد');
        method = m[1]; password = m[2]; address = m[3]; port = parseInt(m[4], 10);
    }

    if (cleanIp) address = cleanIp;
    if (cleanPort) port = parseInt(cleanPort, 10);
    if (!address || !port || isNaN(port)) throw new Error('کانفیگ ss آدرس یا پورت ندارد');
    if (!method || !password) throw new Error('کانفیگ ss روش/رمز ندارد');

    // Xray implements AEAD ciphers only. The old stream ciphers are not merely insecure
    // here, they are FATAL: the core answers "unknown cipher method: aes-128-cfb" and
    // refuses the whole config file, so a single legacy node takes the entire delay test
    // down with it. In the free pool that is ~350 of 2114 shadowsocks entries.
    method = method.toLowerCase();
    if (!SS_CIPHERS.includes(method)) {
        throw new Error(`رمزنگاری ss پشتیبانی نمی‌شود: ${method}`);
    }

    return {
        protocol: 'shadowsocks',
        settings: { servers: [{ address, port, method, password, uot: false }] },
        streamSettings: { network: 'tcp', security: 'none' },
        mux: { enabled: false, concurrency: 8 },
    };
}

/**
 * Is this an address Xray will accept an unencrypted outbound to?
 *
 * Only loopback and the RFC1918/link-local ranges, plus `localhost`. A hostname that is not
 * one of those is NOT exempt — verified against the core, which refuses `example.com` exactly
 * as it refuses `1.2.3.4`.
 */
function isPrivateAddress(address) {
    const a = String(address || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    if (!a) return false;
    if (a === 'localhost' || a.endsWith('.localhost')) return true;
    // v6 loopback and the ULA range — gated on a colon, or a host named `fdn-server` would
    // read as a private address and be let through to a core that refuses it.
    if (a === '::1' || (a.includes(':') && /^f[cd]/.test(a))) return true;
    const m = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;                                                        // a name: not exempt
    const [o1, o2] = [+m[1], +m[2]];
    return o1 === 10 || o1 === 127
        || (o1 === 172 && o2 >= 16 && o2 <= 31)
        || (o1 === 192 && o2 === 168)
        || (o1 === 169 && o2 === 254);
}

function parseVlessUri(uri, cleanIp, cleanPort) {
    // The name is historical — this is the one entry point every caller already uses (the
    // connect path, the batch tester, the delay tester), so dispatching here is what makes
    // vmess and shadowsocks work everywhere at once instead of only in the new feature.
    const trimmed = String(uri || '').trim();
    if (trimmed.startsWith('vmess://')) return parseVmessUri(trimmed, cleanIp, cleanPort);
    if (trimmed.startsWith('ss://')) return parseShadowsocksUri(trimmed, cleanIp, cleanPort);

    // Reject protocols the core cannot speak, BY NAME, before the vless branch sees them.
    //
    // Without this, `hysteria2://user@host:443` walks straight into the vless path: the URL
    // parses, the userinfo can even look like a UUID, and out comes a vless outbound
    // pointing at a Hysteria server. Measured on the free pool, that produced 97 outbounds
    // that were "valid" and could never connect — each one costing a delay-test slot and
    // showing up as a mysterious dead node.
    const scheme = (trimmed.match(/^([a-z0-9+.-]+):\/\//i) || [])[1];
    const XRAY_SPEAKS = ['vless', 'trojan', 'vmess', 'ss'];
    if (scheme && !XRAY_SPEAKS.includes(scheme.toLowerCase())) {
        throw new Error(`پروتکل ${scheme} با هسته‌ی Xray کار نمی‌کند`);
    }

    // vless://uuid@host:port?query#name or trojan://password@host:port?query#name
    const url = new URL(uri);
    let uuid = url.username;
    let address = url.hostname;
    let port = parseInt(url.port);

    const protocol = uri.startsWith('trojan://') ? 'trojan' : 'vless';
    // URL keeps the user part percent-encoded; a Trojan password with a symbol in it
    // (encodeURIComponent'd by panels, and by this app's own BPB fallback) must reach the core
    // decoded, or the server sees a different password.
    if (protocol === 'trojan') { try { uuid = decodeURIComponent(uuid); } catch (e) { /* keep as is */ } }

    // Reject a URI we cannot represent, instead of returning a half-built outbound.
    //
    // `new URL()` accepts an authority with no `user@` part and leaves `username` as an
    // empty string, so a local-proxy entry like `socks://127.0.0.1:20810` used to sail
    // through here and produce a vless outbound with `id: ""`. Callers wrap this in
    // try/catch and fall back to blackhole — but nothing ever threw, so the broken
    // outbound reached Xray, which then refused to load the WHOLE config
    // ("common/uuid: invalid UUID"). One malformed entry took every other node down with
    // it: no inbound port opened, so every delay test returned 000 / -1ms.
    if (!uuid) {
        throw new Error(`کانفیگ نامعتبر: شناسه‌ی کاربر (UUID/password) ندارد — ${uri.slice(0, 40)}`);
    }
    if (protocol === 'vless') {
        uuid = normalizeXrayId(uuid);
        if (!uuid) throw new Error(`کانفیگ نامعتبر: UUID درست نیست — ${uri.slice(0, 40)}`);
    }
    if (!address || !port || isNaN(port)) {
        throw new Error(`کانفیگ نامعتبر: آدرس یا پورت ندارد — ${uri.slice(0, 40)}`);
    }

    // Replace with clean IP/Port if provided
    if (cleanIp) address = cleanIp;
    if (cleanPort) port = parseInt(cleanPort);
    let security = (url.searchParams.get('security') || 'none').toLowerCase();
    // Harvested configs carry all sorts in this field ("false", "0", "auto"). The core
    // rejects the whole file on an unknown value (Unknown security "false"), so anything
    // that is not a real security type is normalised to none rather than passed through.
    if (!['none', 'tls', 'reality', 'xtls'].includes(security)) security = 'none';
    
    // Auto-correct security based on the final port (Cloudflare HTTPS ports require TLS)
    const tlsPorts = [443, 8443, 2053, 2083, 2087, 2096];
    const httpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
    if (tlsPorts.includes(port) && security === 'none') {
        security = 'tls';
    } else if (httpPorts.includes(port) && security === 'tls') {
        security = 'none';
    }
    
    // PLAINTEXT VLESS TO A PUBLIC ADDRESS — THE FOURTH FATAL-CONFIG TRAP.
    //
    // Xray 26.x refuses to build this outbound at all, and refusing ONE outbound makes it
    // refuse the whole file:
    //
    //     failed to build outbound config with tag out-2 >
    //     vless without TLS or other encryption is prohibited
    //     unless the server address is a private IP or domain
    //
    // Which is fatal in a way that is very hard to see. The delay tester stands up one core
    // holding twenty nodes, so a single poisoned entry takes its nineteen neighbours with it:
    // the core exits, no inbound binds, and every node in the page reads as dead. Measured on
    // the live «اتصال سریع» feed — 150 of 983 vless entries are like this, which is a **92%**
    // chance that any random page of twenty contains at least one. That is the whole of
    // «هیچ سرور سالمی پیدا نمی‌کند»: 161 hosts had an open port and exactly one of them was
    // ever measured.
    //
    // Rejected BY NAME here, like hysteria2 and the unknown transports above, so it costs one
    // node instead of a page. The condition is what the core actually enforces, tested against
    // it rather than read off the message: a public IP is refused, a DOMAIN is refused too
    // (the message's wording misleads), and only private or loopback addresses are allowed.
    if (protocol === 'vless' && security === 'none' && !isPrivateAddress(address)) {
        throw new Error(`vless بدون TLS روی آدرس عمومی را هسته‌ی Xray قبول نمی‌کند — ${uri.slice(0, 40)}`);
    }

    const sni = url.searchParams.get('sni') || url.hostname;
    const type = url.searchParams.get('type') || 'tcp';
    // Same fatal-config trap as vmess above: an unknown or removed transport makes Xray
    // refuse the entire file, so it is rejected here as one bad node instead.
    if (!XRAY_TRANSPORTS.includes(type)) {
        throw new Error(`ترنسپورت ${type} در این نسخه‌ی هسته وجود ندارد`);
    }
    const host = url.searchParams.get('host') || '';
    const path = url.searchParams.get('path') || '/';

    const outbound = {
        protocol: protocol,
        settings: protocol === 'vless' ? {
            vnext: [{
                address: address,
                port: port,
                users: [{ id: uuid, encryption: "none" }]
            }]
        } : {
            servers: [{
                address: address,
                port: port,
                password: uuid
            }]
        },
        streamSettings: {
            network: type,
            security: security,
            [type + 'Settings']: {}
        }
    };

    const insecure = url.searchParams.get('allowInsecure') === '1' || url.searchParams.get('insecure') === '1';

    const fp = url.searchParams.get('fp') || 'chrome';
    const alpn = url.searchParams.get('alpn');

    if (security === 'tls') {
        outbound.streamSettings.tlsSettings = {
            serverName: generateMixedCaseSNI(sni),
            fingerprint: fp
        };

        // "allowInsecure" را دیگر نمی‌نویسیم.
        //
        // هسته‌ی 26.7.28 این گزینه را حذف کرده و حالا خطای *مرگبار* می‌دهد، نه اخطار:
        //   The feature "allowInsecure" has been removed and migrated to
        //   "pinnedPeerCertSha256"(pcs) and "verifyPeerCertByName"(vcn).
        // چون Xray کل فایل را یکجا اعتبارسنجی می‌کند، یک outbound با این فیلد باعث
        // می‌شود کل کانفیگ بالا نیاید — نه پورتی باز شود، نه دیلی گرفته شود. لینک‌های
        // پنل Edge دقیقاً با allowInsecure=1 ساخته می‌شوند، برای همین بعد از ارتقای
        // هسته هیچ‌کدام نه دیلی می‌دادند و نه وصل می‌شدند.
        //
        // حذف کردنش هم درست‌تر است: SNI روی دامنه‌ی واقعی ست می‌شود و گواهی کلودفلر
        // برای همان دامنه معتبر است، پس راستی‌آزمایی عادی جواب می‌دهد و allowInsecure
        // از اول لازم نبود. اگر کانفیگ گواهی را pin کرده باشد، همان را رد می‌کنیم به
        // هسته: این جانشین رسمی و امنِ همان قابلیت است.
        const pcs = url.searchParams.get('pinnedPeerCertSha256') || url.searchParams.get('pcs');
        const vcn = url.searchParams.get('verifyPeerCertByName') || url.searchParams.get('vcn');
        if (pcs) outbound.streamSettings.tlsSettings.pinnedPeerCertSha256 = pcs;
        if (vcn) outbound.streamSettings.tlsSettings.verifyPeerCertByName = vcn;
        // `insecure` بدون pin هیچ معادلی در هسته‌ی جدید ندارد؛ عمداً نادیده گرفته می‌شود
        // تا کانفیگ بالا بیاید، به جای اینکه کل تانل را با خودش پایین بکشد.
        void insecure;

        // ALPN و WebSocket: h2 اینجا سم است.
        //
        // ترنسپورت WebSocket ایکس‌ری فقط HTTP/1.1 حرف می‌زند، ولی کلودفلر اگر h2 را در
        // ALPN ببیند همان را انتخاب می‌کند و dial با «protocol "h2" was given but is not
        // supported / malformed HTTP response» می‌میرد. پیش‌فرضِ قبلی روی هر کانفیگ ws
        // که alpn نداشت h2 می‌گذاشت — یعنی کانفیگ‌های پنل زئوس اصلاً وصل نمی‌شدند، در
        // حالی که همان لینک در کلاینت‌های دیگر کار می‌کرد.
        //
        // پس h2 فقط برای ترنسپورت‌هایی می‌ماند که واقعاً می‌توانند از آن استفاده کنند، و
        // اگر خود کاربر هم h2 را روی ws داده باشد حذفش می‌کنیم؛ وگرنه نتیجه یک کانفیگ
        // مرده است، نه یک اتصال کندتر.
        let alpnList = alpn ? alpn.split(',').map(a => a.trim()).filter(Boolean) : null;
        if (type === 'ws') {
            alpnList = (alpnList || []).filter(a => a !== 'h2');
            if (!alpnList.length) alpnList = ["http/1.1"];
        } else if (!alpnList) {
            alpnList = ["h2", "http/1.1"];
        }
        outbound.streamSettings.tlsSettings.alpn = alpnList;
    } else if (security === 'reality') {
        const pbk = url.searchParams.get('pbk') || '';
        const sid = url.searchParams.get('sid') || '';
        // REALITY without a public key cannot be built, and the core says so by refusing
        // the ENTIRE config file ("Failed to build REALITY config. > empty password"). One
        // such node in a list therefore takes every other node's delay test down with it,
        // which is why this is rejected here as a single bad node instead.
        if (!pbk) throw new Error('کانفیگ REALITY کلید عمومی (pbk) ندارد');
        // shortId is hex, up to 16 characters. Junk in that field is fatal in exactly the
        // same way ("invalid shortId: aa@freenettir¹"), so it is validated rather than
        // passed through — configs harvested from public channels really do carry channel
        // names in there.
        if (sid && !/^[0-9a-f]{0,16}$/i.test(sid)) {
            throw new Error('کانفیگ REALITY شناسه‌ی کوتاه (sid) نامعتبر دارد');
        }
        outbound.streamSettings.realitySettings = {
            serverName: sni,
            fingerprint: fp,
            publicKey: pbk,
            shortId: sid,
            spiderX: url.searchParams.get('spx') || '/'
        };
    }

    if (type === 'ws') {
        outbound.streamSettings.wsSettings = { path: path, headers: { Host: generateMixedCaseSNI(host || sni) } };
    } else if (type === 'grpc') {
        const serviceName = url.searchParams.get('serviceName') || '';
        outbound.streamSettings.grpcSettings = { serviceName: serviceName, multiMode: false };
    } else if (type === 'httpupgrade') {
        outbound.streamSettings.httpupgradeSettings = { path, host: host || sni };
    } else if (type === 'xhttp') {
        // The link's own host, path, mode and extra, not an empty block.
        //
        // This used to be `xhttpSettings: {}`: every XHTTP link lost its host and its mode. With
        // a clean Cloudflare IP as the address, no Host means Cloudflare cannot tell which Worker
        // the request is for, and a Worker cannot take the stream-up mode the core picks when
        // none is given — so every config from the «MLM» panel (XHTTP, packet-up) failed while
        // the same link worked in other clients.
        outbound.streamSettings.xhttpSettings = { path, host: host || sni };
        const mode = url.searchParams.get('mode');
        if (mode) outbound.streamSettings.xhttpSettings.mode = mode;
        const extra = url.searchParams.get('extra');
        if (extra) {
            try {
                const parsed = JSON.parse(extra);
                if (parsed && typeof parsed === 'object') outbound.streamSettings.xhttpSettings.extra = parsed;
            } catch (e) { /* malformed extra: the link still works with the core's defaults */ }
        }
    }

    // fragment+fingerprint: جایگزین sni-spoofing برای کانفیگ‌های کلودفلر.
    //
    // اینجا اعمال می‌شود چون تنها نقطه‌ی مشترکِ ساختِ outbound است — کانفیگ پایه،
    // کانفیگ‌های «زیرساخت ابری» و تستِ دسته‌ای همگی از همین تابع رد می‌شوند، پس
    // کاربر هیچ‌جا لازم نیست چیزی را دستی تنظیم کند.
    tlsFingerprint.applyToOutbound(outbound, { address, sni, host });

    // Add mux configuration (disabled by default but present)
    outbound.mux = {
        enabled: false,
        concurrency: 8
    };

    return outbound;
}

/**
 * Xray's own log level: `warning` normally, `info` when the user has asked for tunnel detail.
 * One lever for both cores — asking for detail and getting half of it would be worse than none.
 */
function xrayLogLevel() {
    try { return require('./network-settings').tunLogLevel() === 'info' ? 'info' : 'warning'; }
    catch (e) { return 'warning'; }
}

async function generateXrayConfig(baseConfigUri, cleanIp, cleanPort, realIp, onLog = () => {}, opts = {}) {
    let outbounds = [];

    // `opts.solo` — the config that was asked for, and nothing else.
    //
    // Otherwise every «زیرساخت ابری» config is merged in beside it behind a leastPing
    // balancer. That is the point of the cloud panel, and a trap for the V2Ray list: a
    // balancer with no observation yet (the observatory probes once a minute) can send the
    // first minute of traffic out through any of them, so the row the user ticked was not
    // necessarily the node they got — «وصل شد ولی کار نمی‌کند» on a config that tests fine.
    // Solo also skips a network round trip on a path where the engine may be the only way out.
    const cloudManager = require('./cloud-manager');
    let cloudConfigs = [];
    if (opts.solo) {
        onLog('[CONFIG] فقط همین کانفیگ — بدون توزیع بار روی زیرساخت ابری');
    } else try {
        onLog('[CLOUD] Checking for active cloud infrastructure...');
        const cloudRes = await cloudManager.fetchCloudConfigs();
        cloudConfigs = cloudRes.configs || [];
        if (cloudConfigs.length > 0) {
            onLog(`[CLOUD] Successfully fetched ${cloudConfigs.length} cloud configurations. Building Load-Balancer...`);
        }
    } catch (e) {
        onLog('[CLOUD] Error fetching cloud configs: ' + e.message);
    }

    try {
        // Every URI scheme the parser understands, not a hand-listed two.
        //
        // This branch used to name vless:// and trojan:// explicitly, so a vmess or ss node
        // fell through every case and produced no proxy outbound at all — the connect ended
        // in "هیچ کانفیگ معتبری یافت نشد" even though parseVlessUri handles both perfectly
        // well. Keeping one list in one place (the parser) is what stops the next protocol
        // from being half-added again.
        if (/^(vless|trojan|vmess|ss):\/\//i.test(baseConfigUri)) {
            const baseOutbound = parseVlessUri(baseConfigUri, cleanIp, cleanPort);
            baseOutbound.tag = "proxy-base";
            outbounds.push(baseOutbound);
        } else if (baseConfigUri.startsWith('{')) {
            const parsed = stripRemovedTlsOptions(JSON.parse(baseConfigUri));
            
            // Check if it's a FULL Custom Config
            if (parsed.inbounds && Array.isArray(parsed.inbounds) && parsed.outbounds && Array.isArray(parsed.outbounds)) {
                // The CLIENT listeners (socks / http / mixed) are replaced by the app's own ports.
                // Everything else the config listens on is its own plumbing and stays: the MITM
                // domain-fronting profile redirects into two TLS-terminating `tunnel` inbounds,
                // and dropping them would leave its routing pointing at nothing. They are pinned
                // to loopback — upstream leaves them on every interface, which on a PC would
                // offer the LAN a TLS relay. The client's own sniffing is kept too: these
                // configs route by domain through fakedns, and sniffing without "fakedns"
                // breaks exactly that under the full tunnel.
                const CLIENT_PROTOCOLS = new Set(['socks', 'http', 'mixed']);
                const clientIn = parsed.inbounds.find(i => i && CLIENT_PROTOCOLS.has(String(i.protocol)));
                const ownIn = parsed.inbounds
                    .filter(i => i && !CLIENT_PROTOCOLS.has(String(i.protocol)) && i.tag !== 'api')
                    .map(i => Object.assign({}, i, { listen: i.listen || '127.0.0.1' }));
                const sniffing = (clientIn && clientIn.sniffing) || { enabled: true, destOverride: ["http", "tls"] };
                const P = configuredPorts();
                parsed.inbounds = [
                    { port: P.socks, listen: P.listen, protocol: "socks", settings: { udp: true }, sniffing },
                    { port: P.http, listen: P.listen, protocol: "http", sniffing },
                    { listen: "127.0.0.1", port: 20085, protocol: "dokodemo-door", settings: { address: "127.0.0.1" }, tag: "api" },
                    ...ownIn,
                ];
                parsed.stats = {};
                parsed.api = { tag: "api", services: ["StatsService"] };
                if (!parsed.policy) parsed.policy = {};
                parsed.policy.system = { statsInboundUplink: true, statsInboundDownlink: true, statsOutboundUplink: true, statsOutboundDownlink: true };
                if (!parsed.routing) parsed.routing = { rules: [] };
                if (!parsed.routing.rules) parsed.routing.rules = [];
                parsed.routing.rules.unshift({ type: "field", inboundTag: ["api"], outboundTag: "api" });

                // کانفیگ کاستوم هم باید از fragment+fingerprint بهره ببرد، وگرنه همان
                // کاربری که کانفیگ JSON کامل وارد کرده تنها کسی است که روی نت محدود
                // وصل نمی‌شود.
                let fpCount = 0;
                parsed.outbounds.forEach(o => {
                    // A direct outbound that speaks TLS is not a proxy to a Cloudflare node — it is
                    // the MITM profile re-packing a connection under a chosen name, and those
                    // files work only unedited. The profile is for proxy outbounds.
                    if (o && (o.protocol === 'direct' || o.protocol === 'freedom')) return;
                    try {
                        const vn = o.settings && o.settings.vnext && o.settings.vnext[0];
                        const srv = o.settings && o.settings.servers && o.settings.servers[0];
                        const ss = o.streamSettings || {};
                        if (tlsFingerprint.applyToOutbound(o, {
                            address: (vn && vn.address) || (srv && srv.address),
                            sni: ss.tlsSettings && ss.tlsSettings.serverName,
                            host: ss.wsSettings && ss.wsSettings.headers && ss.wsSettings.headers.Host,
                        })) fpCount++;
                    } catch (e) {}
                });
                if (fpCount) onLog(`[FP] fragment+fingerprint روی ${fpCount} خروجی کانفیگ کاستوم اعمال شد`);

                onLog('[CONFIG] Loaded Full Custom JSON Configuration (Ports isolated, API injected)');
                return parsed;
            }
            
            // Otherwise, treat as a single Outbound JSON
            const outb = parsed;
            if(cleanIp && outb.settings && outb.settings.vnext && outb.settings.vnext[0]) {
                outb.settings.vnext[0].address = cleanIp;
            }
            if(cleanPort && outb.settings && outb.settings.vnext && outb.settings.vnext[0]) {
                outb.settings.vnext[0].port = parseInt(cleanPort);
            }
            // همان پروفایل fragment+fingerprint برای outboundِ خامِ JSON. آدرس/SNI را
            // از خود آبجکت درمی‌آوریم تا تشخیصِ «مقصد کلودفلری» مثل مسیر URI کار کند.
            try {
                const vn = outb.settings && outb.settings.vnext && outb.settings.vnext[0];
                const srv = outb.settings && outb.settings.servers && outb.settings.servers[0];
                const ss = outb.streamSettings || {};
                tlsFingerprint.applyToOutbound(outb, {
                    address: (vn && vn.address) || (srv && srv.address),
                    sni: ss.tlsSettings && ss.tlsSettings.serverName,
                    host: ss.wsSettings && ss.wsSettings.headers && ss.wsSettings.headers.Host,
                });
            } catch (e) {}

            outb.tag = "proxy-base";
            outbounds.push(outb);
        }
    } catch (e) {
        // Only throw if NO cloud configs and NO base config
        if (cloudConfigs.length === 0) {
            throw new Error('فرمت کانفیگ نامعتبر است. از لینک VLESS یا JSON استفاده کنید.');
        }
    }

    cloudConfigs.forEach((uri, idx) => {
        try {
            const outb = parseVlessUri(uri, cleanIp, cleanPort);
            outb.tag = `proxy-cloud-${idx}`;
            outbounds.push(outb);
        } catch(e) {}
    });

    if (outbounds.length === 0) {
        throw new Error('هیچ کانفیگ معتبری یافت نشد.');
    }

    const fpApplied = outbounds.filter(o => o.streamSettings && o.streamSettings.finalmask).length;
    if (fpApplied > 0) {
        onLog(`[FP] fragment+fingerprint فعال روی ${fpApplied} از ${outbounds.length} خروجی (کلودفلر) — جایگزین SNI-Spoofing`);
    } else if (tlsFingerprint.getConfig().enabled) {
        onLog('[FP] fragment+fingerprint اعمال نشد (مقصد کلودفلری تشخیص داده نشد یا TLS نیست)');
    }

    const config = {
        // WHY THIS IS NOT ALWAYS `info`.
        //
        // Xray at `info` writes a line per connection and per lookup, and every one of those
        // lines is read, split and broadcast by the server — which lives in Electron's MAIN
        // thread. Behind the full-system tunnel this engine sees EVERY connection the machine
        // makes, and sing-box is logging each of them as well, so two firehoses meet in the one
        // thread that also has to keep both pipes drained. A core whose log pipe is not drained
        // blocks on its own write.
        //
        // `warning` keeps the failures, which is what a working connection needs; Settings ›
        // تنظیمات پیشرفته VPN › «لاگ دقیق تونل» brings `info` back for a run that has to be
        // explained.
        log: { loglevel: xrayLogLevel() },
        stats: {},
        api: { tag: "api", services: ["StatsService"] },
        policy: {
            system: {
                statsInboundUplink: true,
                statsInboundDownlink: true,
                statsOutboundUplink: true,
                statsOutboundDownlink: true
            }
        },
        inbounds: [
            { port: configuredPorts().socks, listen: configuredPorts().listen, protocol: "socks", settings: { udp: true }, sniffing: { enabled: true, destOverride: ["http", "tls"] } },
            { port: configuredPorts().http, listen: configuredPorts().listen, protocol: "http", sniffing: { enabled: true, destOverride: ["http", "tls"] } },
            { listen: "127.0.0.1", port: 20085, protocol: "dokodemo-door", settings: { address: "127.0.0.1" }, tag: "api" }
        ],
        outbounds: [
            ...outbounds,
            { protocol: "freedom", tag: "direct" },
            { protocol: "blackhole", tag: "block" }
        ],
        routing: {
            domainStrategy: "AsIs",
            rules: [
                { type: "field", inboundTag: ["api"], outboundTag: "api" },
                // Under the tunnel this rule is the leak itself — see setFullTunnelMode. Omitted
                // there so DNS falls through to the proxy outbound like everything else.
                ...(fullTunnelMode ? [] : [{ type: "field", port: 53, network: "tcp,udp", outboundTag: "direct" }]),
                { type: "field", port: "137,138,139,445", outboundTag: "block" }
            ]
        }
    };

    // Load balancing (leastPing) across every proxy outbound.
    //
    // The catch-all rule that feeds the balancer is NOT added here. Xray routing is first
    // match wins, and `{network:"tcp,udp"} -> balancer` matches everything — so adding it at
    // this point silently killed every bypass rule appended afterwards: geoip:ir,
    // domain:ir, the clean IP, the server IP, and the dedicated-DNS worker's own hostname.
    // The visible effect was all Iranian traffic being dragged through the tunnel, and DNS
    // resolution having to reach a worker whose address could only be resolved through the
    // tunnel it was needed for. It is appended at the very end of this function instead.
    const useBalancer = outbounds.length > 1;
    if (useBalancer) {
        config.observatory = {
            subjectSelector: ["proxy-"],
            probeUrl: "http://clients3.google.com/generate_204",
            probeInterval: "1m"
        };
        config.routing.balancers = [
            {
                tag: "lb",
                selector: ["proxy-"],
                strategy: { type: "leastping" }
            }
        ];
    }
    // With a single outbound there is no catch-all at all: Xray sends anything that matches
    // no rule to the FIRST outbound, which is the proxy.

    // Aether chaining: when the Aether engine is connected and the user asked Xray to route
    // through it, every proxy outbound dials via Aether's local SOCKS5 instead of going out
    // directly. The server connection therefore leaves the machine inside Aether's tunnel.
    // `direct`/`block` are deliberately left alone so bypassed traffic (geoip:ir, DNS, the
    // clean IP) still goes out natively — routing it through the tunnel would be slower and
    // would defeat the bypass rules above.
    try {
        const chain = require('./aether-manager').getChainOutbound();
        if (chain) {
            config.outbounds.push(chain.outbound);
            config.outbounds.forEach(o => {
                if (o.tag !== chain.tag && o.tag !== 'direct' && o.tag !== 'block') {
                    o.proxySettings = { tag: chain.tag };
                }
            });
            onLog(`[CONFIG] زنجیره فعال: خروجی Xray از داخل تونل وارپ (${chain.address}:${chain.port})`);
        }
    } catch (e) {
        onLog(`[CONFIG] ⚠️ زنجیره‌ی وارپ اعمال نشد: ${e.message}`);
    }

    // Routing Mode
    // geoip:private always stays direct — the LAN is not a leak, and tunnelling it would
    // cut the machine off from its own printers, NAS and router page.
    const bypassIps = ["geoip:private"];
    if (!fullTunnelMode) {
        bypassIps.push("geoip:ir");
    }
    config.routing.rules.push({ type: "field", ip: bypassIps, outboundTag: "direct" });

    if (!fullTunnelMode) {
        config.routing.rules.push({ type: "field", domain: ["domain:ir"], outboundTag: "direct" });
    }
    
    if (cleanIp && cleanIp !== '127.0.0.1') {
        config.routing.rules.push({ type: "field", ip: [cleanIp], outboundTag: "direct" });
    }
    if (realIp) {
        config.routing.rules.push({ type: "field", ip: [realIp], outboundTag: "direct" });
    }

    // Dedicated DNS (Cloudflare DoH worker): anti-filter + region steering, mirrors Android.
    // When enabled, Xray resolves every proxied name through the user's worker over DoH.
    try {
        const dnsBlock = dedicatedDns.buildXrayDns();
        if (dnsBlock) {
            const cfg = dedicatedDns.getConfig();
            config.dns = dnsBlock;
            config.routing.domainStrategy = "IPIfNonMatch";
            // The worker's own host must resolve/connect directly (bootstrap, avoid loop).
            // Read the URL of the ACTIVE mode: the two modes are separate workers on
            // different hostnames, and exempting the wrong one leaves the live resolver
            // being resolved through itself.
            try {
                const host = new URL(dedicatedDns.workerUrlFor(cfg.mode, cfg)).hostname;
                config.routing.rules.push({ type: "field", domain: [`full:${host}`], outboundTag: "direct" });
            } catch (e) {}

            // Xray's own resolver traffic carries the `dns-out` inbound tag. Send it out
            // natively: pushing lookups through the tunnel adds a full round trip to the
            // proxy server before any connection can even start, on every new domain.
            config.routing.rules.push({ type: "field", inboundTag: ["dns-out"], outboundTag: "direct" });
            if (typeof onLog === 'function') {
                onLog(cfg.mode === 'doh'
                    ? `[DNS] Dedicated DoH resolver active (mode: fast relay, group: ${cfg.dohGroup})`
                    : `[DNS] Dedicated DoH resolver active (region: ${cfg.region})`);
            }
        }
    } catch (e) {
        if (typeof onLog === 'function') onLog(`[DNS] dedicated DNS skipped: ${e.message}`);
    }

    // «سرور DNS بک‌اند» (network-settings.js): the config's OWN server name, resolved by the
    // resolver the user chose instead of by Windows — for when the ISP's resolver poisons a
    // worker's hostname and the config cannot connect for no visible reason (Android's
    // backendDns). Only the servers' own names, only when there is no dedicated DNS block
    // already, and Windows' resolver stays behind it as the fallback, so this can make a
    // lookup better and never worse. The resolver's own traffic goes out direct.
    try {
        const backendDns = netSettings.get().backendDns;
        if (backendDns && backendDns !== 'system' && !config.dns) {
            const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || String(h).includes(':');
            const named = outbounds.filter(o => {
                const srv = (o.settings && ((o.settings.vnext && o.settings.vnext[0]) || (o.settings.servers && o.settings.servers[0]))) || null;
                return srv && srv.address && !isIp(srv.address);
            });
            if (named.length) {
                const hosts = [...new Set(named.map(o => ((o.settings.vnext || o.settings.servers)[0]).address))];
                config.dns = {
                    tag: 'backend-dns',
                    servers: [{ address: backendDns, domains: hosts.map(h => 'full:' + h) }, 'localhost'],
                    queryStrategy: 'UseIPv4',
                };
                named.forEach(o => {
                    o.streamSettings = o.streamSettings || {};
                    o.streamSettings.sockopt = Object.assign({}, o.streamSettings.sockopt, { domainStrategy: 'UseIPv4' });
                });
                config.routing.rules.unshift({ type: 'field', inboundTag: ['backend-dns'], outboundTag: 'direct' });
                if (typeof onLog === 'function') onLog(`[DNS] نام سرور کانفیگ (${hosts.join('، ')}) از ${backendDns} پرسیده می‌شود.`);
            }
        }
    } catch (e) {
        if (typeof onLog === 'function') onLog(`[DNS] سرور DNS بک‌اند اعمال نشد: ${e.message}`);
    }

    // LAST rule, always. Everything that reached this point matched no bypass, so it is the
    // traffic that genuinely belongs in the tunnel — spread across the proxy outbounds by
    // lowest observed ping. Appending it here (rather than next to the balancer definition)
    // is what keeps every rule above it alive.
    if (useBalancer) {
        config.routing.rules.push({ type: "field", network: "tcp,udp", balancerTag: "lb" });
        if (typeof onLog === 'function') {
            onLog(`[ROUTE] ${config.routing.rules.length - 1} bypass rule(s) evaluated before the balancer catch-all`);
        }
    }

    return config;
}

/**
 * @param bypass  extra hosts for WinINET's ProxyOverride, on top of the loopback entries.
 *
 * The bypass list is not cosmetic. ProxyServer here is a machine-global setting and
 * WinHTTP clients read it too — including tailscaled, which routes its control-plane
 * traffic through whatever the system proxy says (its own log: "PAC or proxyConfig
 * changed; updating routes"). In the GitHub tunnel's proxy mode the system proxy points
 * at tailscaled's OWN listener, so with no bypass the daemon proxies its control plane
 * through itself: the tunnel comes up, then dies the next time it must reach the control
 * plane — which is exactly the "sometimes it works, sometimes it does not" symptom.
 * Callers that ARE the proxy pass their own hostnames here to break that loop.
 *
 * Loopback is always bypassed: a local proxy reaching another local service through
 * itself is never what anyone wants.
 */
// The registry writes are serialised through this, so "off" can never land after an "on"
// that was asked for later. Without a queue, making them asynchronous would trade a freeze
// for a race on the one setting that decides whether the browser has a proxy at all.
let proxyQueue = Promise.resolve();
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
function regAdd(args) {
    return new Promise((resolve) => {
        execFile('reg', ['add', REG_KEY, ...args], { windowsHide: true, timeout: 8000 }, () => resolve());
    });
}

function enableSystemProxy(enable, port = getPorts().http, { bypass = [] } = {}) {
    // NOT execSync. Three `reg add` calls are three process spawns, and this function is on
    // both the connect and the disconnect path — inside Electron's MAIN process, so every
    // one of them froze the window. Queued instead of awaited: callers treat this as
    // fire-and-forget and the ordering guarantee is what they actually need.
    proxyQueue = proxyQueue.then(async () => {
        try {
            if (enable) {
                const override = ['<local>', 'localhost', '127.*', ...bypass].join(';');
                await regAdd(['/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
                await regAdd(['/v', 'ProxyServer', '/t', 'REG_SZ', '/d', `127.0.0.1:${port}`, '/f']);
                await regAdd(['/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', override, '/f']);
            } else {
                await regAdd(['/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
            }

            // Tell WinINET to re-read what we just wrote; without this a browser keeps using
            // the previous setting until it is restarted.
            const os = require('os');
            const psScript = `
$signature = @'
[DllImport("wininet.dll")]
public static extern bool InternetSetOption(int hInternet, int dwOption, int lpBuffer, int dwBufferLength);
'@
$type = Add-Type -MemberDefinition $signature -Name wininet -Namespace proxy -PassThru
$type::InternetSetOption(0, 39, 0, 0)
$type::InternetSetOption(0, 37, 0, 0)
`;
            // A fixed filename in a world-writable folder, rewritten by every call: two
            // overlapping proxy changes used to race on it, and the loser executed a
            // half-written script. Per-call name, removed when it has run.
            const scriptPath = path.join(os.tmpdir(), `mv_refresh_proxy_${process.pid}_${Date.now()}.ps1`);
            await new Promise((resolve) => {
                fs.writeFile(scriptPath, psScript, () => resolve());
            });
            await new Promise((resolve) => {
                execFile('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', scriptPath],
                    { windowsHide: true, timeout: 15000 }, () => {
                        fs.unlink(scriptPath, () => {});
                        resolve();
                    });
            });
        } catch (e) {
            console.error('System Proxy Error:', e.message);
        }
    });
    return proxyQueue;
}

/**
 * Switch the Windows proxy off, blocking until it is off.
 *
 * The ONLY correct caller is a teardown that cannot await a promise — `before-quit` and
 * stopXray()'s synchronous path. Leaving the proxy pointing at a port that dies with this
 * process is not a broken VPN, it is a PC with no internet and no visible cause, so here the
 * block is the point. Everything a click reaches uses enableSystemProxy() instead.
 */
function disableSystemProxySync() {
    try {
        execSync(`reg add "${REG_KEY}" /v ProxyEnable /t REG_DWORD /d 0 /f`, { stdio: 'ignore', timeout: 8000 });
    } catch (e) { /* the refresh below still helps, and there is nothing else to try */ }
    try {
        execSync('rundll32.exe wininet.dll,InternetSetOption 0 39 0 0', { stdio: 'ignore', timeout: 8000 });
    } catch (e) { /* best effort: the registry value is what actually matters */ }
}

/**
 * Kill whatever xray.exe is running, without blocking and WITHOUT touching the tunnel.
 *
 * The difference from stopXray() matters more than it looks. stopXray() tears the TUN
 * adapter down first, and startXray() used to call it — so switching node while the full
 * tunnel was on destroyed the tunnel as a side effect of connecting. By the time
 * /api/v2ray/start reached its `v2rayTunRefreshUplink()` the adapter was already gone, that
 * refresh returned immediately (`!tun.isRunning()`), and the machine was left with
 * `v2rayTunWanted === true`, a green switch, Xray in its full-tunnel shape and no tunnel at
 * all. Restarting the ENGINE alone leaves the adapter in place for its owner to rebuild
 * around the new node, which is what that refresh is for.
 *
 * The tunnel survives the gap: its guard needs two consecutive misses five seconds apart,
 * and the bind is back well inside that.
 */
async function killXrayProcess() {
    // BY PID WHEN WE HAVE ONE, not `/IM xray.exe`.
    //
    // Three different things in this app run xray.exe: the live connection, the node delay
    // test (/api/v2ray/test-nodes, its own config on random ports) and the scanner's batch
    // engine. A blanket image kill takes all three, so connecting while a delay test was
    // running killed the test and every node came back "-1ms" for no visible reason.
    //
    // The image kill still runs when there is no handle — that is the orphan case, a process
    // left holding the SOCKS port by a previous run of the app, and clearing it is exactly
    // what makes the next start able to bind.
    const proc = xrayProcess;
    const args = proc && proc.pid
        ? ['/F', '/PID', String(proc.pid), '/T']
        : ['/F', '/IM', 'xray.exe', '/T'];
    await new Promise((resolve) => {
        execFile('taskkill', args, { windowsHide: true, timeout: 8000 }, () => resolve());
    });
    stopTrafficPolling();
    xrayProcess = null;
    activePorts = null;
}

/**
 * Does the engine we just spawned actually exist?
 *
 * startXray used to spawn xray.exe and return `true` on the spot, so /api/v2ray/start
 * answered 200 and the panel said «✅ متصل شد» over a process that had already exited. Every
 * fatal reason looked identical from the UI — a port still held by the previous engine, a
 * config the core refuses (one `allowInsecure` is enough: Xray validates the whole file up
 * front), a node whose transport this core no longer has. The user's complaint for all of
 * them was «وصل نمیشه» with a green panel, which is the one thing this app must never show.
 *
 * So the start waits for the SOCKS inbound to accept a connection, exactly as the tunnel
 * path already does before it dares point the default route at that port.
 */
function waitForXrayUp(port, budgetMs = 6000) {
    const deadline = Date.now() + budgetMs;
    return new Promise((resolve) => {
        const attempt = () => {
            const sock = new net.Socket();
            sock.setTimeout(500);
            const again = () => {
                sock.destroy();
                if (Date.now() >= deadline) return resolve(false);
                setTimeout(attempt, 120);
            };
            sock.once('connect', () => { sock.destroy(); resolve(true); });
            sock.once('error', again);
            sock.once('timeout', again);
            sock.connect(port, '127.0.0.1');
        };
        attempt();
    });
}

async function startXray(uri, cleanIp, cleanPort, realIp, useSystemProxy, onLog, opts = {}) {
    currentConfigUri = uri;
    // `opts` is remembered too, so restartXray() rebuilds the SAME shape. Without it a
    // settings change would quietly turn a solo connection back into a load-balanced one.
    lastStartArgs = { uri, cleanIp, cleanPort, realIp, useSystemProxy, opts };
    const exeDir = getUnpackedDir();
    const configPath = path.join(exeDir, 'core', 'config.json');
    const exePath = corePaths.file('xray', 'xray.exe', path.join(exeDir, 'core', 'xray.exe'));

    if (!fs.existsSync(exePath)) {
        throw new Error('فایل xray.exe در پوشه core پیدا نشد!');
    }

    const ports = configuredPorts();
    // BUILD THE CONFIG WHILE THE OLD ENGINE IS STILL UP.
    //
    // generateXrayConfig reaches the network (cloud-manager fetches the user's own
    // infrastructure), and under a live full tunnel every packet on this machine goes through
    // xray.exe. Killing it first therefore made that fetch wait out its own timeout, every
    // single connect, with the whole machine offline for the duration. Built first, the engine
    // is down only for the handover.
    const config = await generateXrayConfig(uri, cleanIp, cleanPort, realIp, onLog, opts);

    // Awaited, not synchronous: this runs on a click, inside Electron's main process. The old
    // `stopXray()` here blocked the whole window for up to 13 s (two taskkills with 5 s
    // timeouts and a 3 s sleep loop inside the tunnel teardown) on EVERY connect and every
    // node switch — «فریز میشه».
    await killXrayProcess();
    // Windows keeps the listener in TIME_WAIT for a moment after the process is gone; the
    // fresh one then fails to bind and the connect ends with a live-looking panel over a dead
    // port. Cheap insurance, and it is awaited rather than slept synchronously.
    await new Promise((r) => setTimeout(r, 120));

    if (config.outbounds.length > 3) {
        onLog(`[CONFIG] Load Balancer initialized with ${config.outbounds.length - 2} endpoints (Strategy: LeastPing)`);
    } else {
        onLog(`[CONFIG] Outbound Protocol: ${config.outbounds[0].protocol}`);
        if (config.outbounds[0].settings && config.outbounds[0].settings.vnext && config.outbounds[0].settings.vnext.length > 0) {
            onLog(`[CONFIG] Target IP: ${config.outbounds[0].settings.vnext[0].address}:${config.outbounds[0].settings.vnext[0].port}`);
        }
    }
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Hold the handle in a local as well as the module slot. The 'close' event of the
    // process stopXray() just killed arrives asynchronously — after the new process has
    // already been stored — so a handler that blindly nulls the slot wipes out its own
    // replacement. That left `isRunning()` false on a live tunnel after every reconnect,
    // which is why re-applying settings reported "nothing to restart".
    const proc = spawn(exePath, ['-config', configPath]);
    xrayProcess = proc;
    activePorts = ports;
    // The core's own explanation, kept so a failed start can quote it instead of guessing.
    let coreSaid = '';
    let coreExited = false;
    const remember = (d) => { coreSaid = (coreSaid + d.toString()).slice(-4000); };
    if (proc.stdout) proc.stdout.on('data', remember);
    if (proc.stderr) proc.stderr.on('data', remember);
    proc.on('close', () => { coreExited = true; });
    startTrafficPolling(onLog);

    // Set BOTH ways, and only now that the new listener exists.
    //
    // It used to be turned off at the top of this function (inside stopXray) and back on
    // here, which left a window where a browser bypassed the proxy entirely, and — worse —
    // meant a connect asking for no proxy relied on that teardown to clear one. Deciding it
    // once, here, is also what lets the full-tunnel path stop this restart from resurrecting
    // the proxy it deliberately turned off (see setSystemProxyIntent).
    // Awaited: the write is queued now, so a caller that reads the setting back to tell the
    // UI about it would otherwise broadcast the value from before this change.
    await enableSystemProxy(!!useSystemProxy, ports.http);

    proc.stdout.on('data', (data) => {
        data.toString().split('\n').forEach(line => {
            if(line.trim()) onLog(line.trim());
        });
    });
    proc.stderr.on('data', (data) => {
        data.toString().split('\n').forEach(line => {
            if(line.trim()) onLog(line.trim());
        });
    });

    proc.on('error', (err) => {
        onLog(`[FATAL] Xray process error: ${err.message}`);
    });

    proc.on('close', (code) => {
        onLog(`Xray process exited with code ${code}`);
        if (xrayProcess === proc) xrayProcess = null;   // only if it is still the current one
    });

    // If the system-wide switch is already on, bring its tunnel half up now.
    //
    // The two halves have different prerequisites: the DNS bridge needs nothing, the smart
    // tunnel needs a live proxy. A user who turns on "روی کل ویندوز" before connecting gets
    // the DNS half and a note that the tunnel is waiting — and then has to remember to
    // toggle the whole thing off and on again once connected. Nobody remembers that; they
    // conclude the feature does not work. Connecting is the missing prerequisite arriving,
    // so the tunnel starts itself here.
    setTimeout(async () => {
        try {
            const dedicatedDns = require('./dedicated-dns-manager');
            const status = dedicatedDns.systemWideStatus();
            if (!status.running || !status.smartTunnel || status.tunnelRunning) return;

            onLog('[TUN] اتصال برقرار شد — تونل هوشمند برای سایت‌های فیلترشده روشن می‌شود…');
            const res = await dedicatedDns.startSmartTunnel(onLog);
            if (!res.started) onLog(`[TUN] ⚠️ تونل هوشمند روشن نشد: ${res.message || res.reason}`);
        } catch (e) {
            onLog(`[TUN] ⚠️ راه‌اندازی خودکار تونل هوشمند ناموفق بود: ${e.message}`);
        }
    }, 2500); // let Xray finish binding its SOCKS inbound before the tunnel probes it

    // PROVE IT IS THERE BEFORE CALLING IT A CONNECTION.
    const up = await waitForXrayUp(ports.socks);
    if (!up || coreExited) {
        const why = (coreSaid.match(/Failed to start:.*/) || coreSaid.match(/^.*\[Error\].*$/m) || [''])[0].trim();
        onLog(`[FATAL] هسته بالا نیامد: ${why || 'بدون پیام'}`);
        await killXrayProcess();
        await enableSystemProxy(false);
        const e = new Error(why
            ? `هسته‌ی Xray بالا نیامد — ${why.replace(/^Failed to start:\s*/, '')}`
            : `هسته‌ی Xray روی پورت ${ports.socks} بالا نیامد. کانفیگ را با «تأخیر واقعی» آزمایش کنید.`);
        e.code = 'XRAY_START_FAILED';
        throw e;
    }

    return true;
}

function stopXray() {
    // TUN first. It holds the machine's default route and forwards everything into Xray's
    // SOCKS port; killing Xray while that adapter is up points the whole system at a dead
    // proxy, and the user loses all internet with nothing on screen explaining why.
    try {
        const tun = require('./tun-manager');
        if (tun.isRunning()) tun.stopTun(() => {});
    } catch (e) { /* must never prevent Xray from being stopped */ }

    try {
        execSync(`taskkill /F /IM xray.exe /T`, { stdio: 'ignore' });
    } catch(e) {}

    stopTrafficPolling();
  if (xrayProcess) {
        xrayProcess = null;
    }
    activePorts = null;
    // Synchronous here too, or this function keeps its name and loses its contract: the whole
    // reason it still exists is `before-quit`, which does not wait for promises.
    disableSystemProxySync();
}

/**
 * stopXray without blocking Electron's main process (the server lives there): the tunnel and
 * the process are ended with awaited child processes, so the window keeps painting while they
 * go. Same order and the same end state as stopXray; that one stays for the synchronous paths
 * (a restart that must free the port before spawning, and quitting the app).
 */
async function stopXrayAsync() {
    try {
        const tun = require('./tun-manager');
        // ONLY A TUNNEL THIS ENGINE IS CARRYING.
        //
        // There is one MLMVPN adapter and several engines want it. `tun.isRunning()` alone
        // said nothing about WHOSE tunnel it is, so disconnecting a V2Ray node while a WARP
        // engine held the adapter tore down the WARP tunnel as well — a feature the user was
        // not touching, taken offline by a click in another panel.
        if (tun.isRunning() && tun.currentEngine() === 'xray.exe') {
            await tun.stopTunAsync(() => {});
            // AND CHECK THAT IT REALLY WENT.
            //
            // stopTunAsync ends in `taskkill /F` whenever sing-box does not unwind in three
            // seconds, and a forced kill runs none of its shutdown code — auto_route,
            // strict_route and its WFP filters are left as they are. When that happens the
            // MLMVPN adapter keeps the default route with nothing behind it, which is the
            // literal «وصل هست ولی هیچ دیتایی رد نمی‌شود» state, on a machine the user has
            // just told to disconnect. verifyTornDown is what removes those leftovers.
            await tun.verifyTornDown(() => {});
        }
    } catch (e) { /* must never prevent Xray from being stopped */ }

    await killXrayProcess();
    await enableSystemProxy(false);
}



/**
 * The scanner's throwaway engine, deliberately kept OUT of the user's session.
 *
 * This used to open with `stopXray()` and write over core/config.json — so starting an IP
 * scan killed whatever V2Ray node the user was connected to, tore their full tunnel down
 * with it, and left the panel still reading «متصل است» over a machine with no VPN. The
 * scan's own `stopXray()` at the end then cleared the Windows proxy for good measure.
 *
 * It now runs exactly like /api/v2ray/test-nodes already does: its own config file, its own
 * ports, its own process handle — nothing shared with the live connection but the binary.
 */
let batchProcess = null;
// Clear of the node delay tester's range (xray-tester.js scans upward from 21300). A scan and
// a node delay test can run at the same time, and two engines fighting over one port makes
// both of them report "-1ms" for reasons neither can explain.
const BATCH_BASE_PORT = 31000;

/** Kill the scanner's engine and nothing else. Safe to call when there is none. */
async function stopBatchXray() {
    const proc = batchProcess;
    batchProcess = null;
    if (!proc || proc.killed) return;
    await new Promise((resolve) => {
        execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => resolve());
    });
}

async function startBatchXray(baseConfigUri, ips) {
    await stopBatchXray();
    const exeDir = getUnpackedDir();
    // NOT core/config.json — that file belongs to the live connection.
    const userDir = path.join(require('os').homedir(), '.mlmvpn');
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    const configPath = path.join(userDir, 'config_scan.json');
    const exePath = corePaths.file('xray', 'xray.exe', path.join(exeDir, 'core', 'xray.exe'));

    if (!fs.existsSync(exePath)) {
        throw new Error('xray.exe not found');
    }

    let outbounds = [];
    let inbounds = [];
    let rules = [];
    
    ips.forEach((ipObj, i) => {
        let outb;
        try {
            outb = parseVlessUri(baseConfigUri, ipObj.ip, ipObj.port || 443);
        } catch(e) {
            // Fallback generic if parsing fails
            outb = { protocol: "vless", settings: { vnext: [{ address: ipObj.ip, port: ipObj.port || 443, users: [{ id: "00000000-0000-0000-0000-000000000000", encryption: "none" }] }] } };
        }
        outb.tag = `outbound-${i}`;
        // Remove observability to avoid conflict
        delete outb.mux;
        outbounds.push(outb);
        
        inbounds.push({
            port: BATCH_BASE_PORT + i,
            listen: "127.0.0.1",
            protocol: "socks",
            settings: { udp: true },
            tag: `inbound-${i}`,
            sniffing: { enabled: true, destOverride: ["http", "tls"] }
        });
        
        rules.push({
            type: "field",
            inboundTag: [`inbound-${i}`],
            outboundTag: `outbound-${i}`
        });
    });
    
    outbounds.push({ protocol: "freedom", tag: "direct" });
    outbounds.push({ protocol: "blackhole", tag: "block" });
    
    const config = {
        log: { loglevel: "warning" },
        inbounds: inbounds,
        outbounds: outbounds,
        routing: {
            domainStrategy: "AsIs",
            rules: rules
        }
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // batchProcess, NOT xrayProcess: writing the scan's engine into the live slot is what made
    // isRunning() and getCurrentUri() describe a throwaway process while the user's own
    // connection had just been killed underneath them.
    batchProcess = spawn(exePath, ['-config', configPath], { windowsHide: true });
    batchProcess.on('error', () => {});

    // Give it 1 second to bind all ports
    await new Promise(r => setTimeout(r, 1000));

    return { basePort: BATCH_BASE_PORT };
}

function isRunning() {
    return xrayProcess !== null;
}

/**
 * Record that the system proxy was turned on or off OUTSIDE of a start, so the next restart
 * reproduces the state the user is actually in.
 *
 * `lastStartArgs.useSystemProxy` is what restartXray() replays, and until now only a connect
 * ever wrote it. Two things went wrong because of that:
 *
 *   · The user connected with the proxy on, then turned the FULL TUNNEL on. That path
 *     switches the proxy off first (the two cannot coexist — the browser hands traffic to
 *     Xray and the adapter captures Xray's replies) and then rebuilds the config, and the
 *     rebuild put the proxy straight back. Both were then "on", and the switch in the panel
 *     said otherwise.
 *   · The user connected without the proxy and turned it on from its own switch. Any later
 *     restart — a settings change, the tunnel toggle — silently turned it off again.
 *
 * One writer for the intent fixes both directions.
 */
function setSystemProxyIntent(on) {
    if (lastStartArgs) lastStartArgs.useSystemProxy = !!on;
}

/**
 * Rebuild the config from current settings and restart the tunnel in place.
 *
 * Exists so toggles that only affect the GENERATED config actually take effect when the
 * user flips them. Before this, turning dedicated DNS off left the old config running:
 * the setting said "off" while the live tunnel still resolved through the worker, so it
 * looked like the switch did nothing.
 *
 * Returns false when there is nothing to restart, so callers can stay quiet rather than
 * reporting a re-apply that never happened.
 */
async function restartXray(onLog = () => {}) {
    if (!xrayProcess || !lastStartArgs) return false;
    const a = lastStartArgs;
    onLog('[CONFIG] اعمال تنظیمات جدید — اتصال در حال بازسازی…');
    await startXray(a.uri, a.cleanIp, a.cleanPort, a.realIp, a.useSystemProxy, onLog, a.opts || {});
    onLog('[CONFIG] تنظیمات جدید اعمال شد.');
    return true;
}

function getCurrentUri() {
    return currentConfigUri;
}

// Aether on its own is a full tunnel — it just speaks SOCKS instead of talking to Windows.
// This runs Xray purely as the local front-end for it: standard socks/http inbounds on the
// ports the system proxy already points at, with everything forwarded into Aether. That way a
// user who only wants Aether never has to pick a node.
function buildAetherOnlyConfig(aetherPort) {
    return {
        log: { loglevel: 'warning' },
        inbounds: [
            {
                tag: 'socks-in', port: configuredPorts().socks, listen: configuredPorts().listen, protocol: 'socks',
                settings: { auth: 'noauth', udp: true },
                sniffing: { enabled: true, destOverride: ['http', 'tls'] },
            },
            {
                tag: 'http-in', port: configuredPorts().http, listen: configuredPorts().listen, protocol: 'http',
                settings: {},
                sniffing: { enabled: true, destOverride: ['http', 'tls'] },
            },
            {
                tag: 'api', port: 20085, listen: '127.0.0.1', protocol: 'dokodemo-door',
                settings: { address: '127.0.0.1' },
            },
        ],
        outbounds: [
            {
                tag: 'aether', protocol: 'socks',
                settings: { servers: [{ address: '127.0.0.1', port: aetherPort }] },
            },
            { tag: 'direct', protocol: 'freedom', settings: {} },
            { tag: 'block', protocol: 'blackhole', settings: {} },
        ],
        stats: {},
        api: { tag: 'api', services: ['StatsService'] },
        policy: { levels: { '0': { statsUserUplink: true, statsUserDownlink: true } },
                  system: { statsInboundUplink: true, statsInboundDownlink: true } },
        routing: {
            // "AsIs" is the default, but state it: it is the whole DNS-leak defence here.
            // Xray must hand the hostname to Aether verbatim and never resolve it locally,
            // otherwise every lookup goes out over the ISP resolver in cleartext.
            domainStrategy: 'AsIs',
            rules: [
                { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
                // LAN and loopback must not be sent through the tunnel — that includes
                // Aether's own listener, which would otherwise loop back into itself.
                { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
                { type: 'field', outboundTag: 'aether', network: 'tcp,udp' },
            ],
        },
    };
}

async function startXrayAetherOnly(aetherPort, useSystemProxy, onLog) {
    // killXrayProcess, not stopXray: this runs on the WARP connect path, and stopXray blocks
    // the main process for up to 13 s while it tears a tunnel down — a tunnel this engine is
    // the local front for, which aetherRearmTunIfWanted would then have to rebuild.
    await killXrayProcess();
    await new Promise((r) => setTimeout(r, 120));
    const exeDir = getUnpackedDir();
    const configPath = path.join(exeDir, 'core', 'config.json');
    const exePath = corePaths.file('xray', 'xray.exe', path.join(exeDir, 'core', 'xray.exe'));

    if (!fs.existsSync(exePath)) throw new Error('فایل xray.exe در پوشه core پیدا نشد!');

    const config = buildAetherOnlyConfig(aetherPort);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const P = configuredPorts();
    onLog(`[CONFIG] حالت فقط-وارپ: ورودی socks ${P.socks} / http ${P.http} → خروجی 127.0.0.1:${aetherPort}`);

    currentConfigUri = null;
    // Same replacement guard as startXray(): the previous process's 'close' lands after
    // this assignment and must not clear the handle belonging to its successor.
    const proc = spawn(exePath, ['-config', configPath], { windowsHide: true });
    xrayProcess = proc;
    activePorts = P;
    startTrafficPolling(onLog);
    // Both ways, for the same reason as startXray: the teardown that used to clear it is gone.
    await enableSystemProxy(!!useSystemProxy, P.http);

    const pipe = (stream) => stream.on('data', (d) => {
        d.toString().split('\n').forEach(l => { if (l.trim()) onLog(l.trim()); });
    });
    pipe(proc.stdout);
    pipe(proc.stderr);

    proc.on('error', (err) => onLog(`[FATAL] Xray process error: ${err.message}`));
    proc.on('close', (code) => {
        onLog(`Xray (حالت وارپ) خاتمه یافت با کد ${code}`);
        if (xrayProcess === proc) xrayProcess = null;
    });

    return { socks: `127.0.0.1:${P.socks}`, http: `127.0.0.1:${P.http}` };
}

/**
 * Where the RUNNING config actually dials out to — the addresses that must stay outside a
 * whole-system tunnel built on top of this engine.
 *
 * Same trap as Aether's (see tun-manager's ENGINE_UPLINK_CIDRS): with auto_route on, Xray's
 * own connection to the node is ordinary outbound traffic, so the adapter captures it and
 * hands it back to the SOCKS port Xray itself is serving. Nothing errors — the tunnel is up,
 * the route is ours — and no site opens.
 *
 * Read from the generated config rather than from the URI, because the URI is only ever one
 * node: a load-balanced config carries an outbound per clean IP, an Aether-chained one dials
 * loopback, and all of them have to be excluded. Domains are returned separately since an
 * address rule cannot match a name that has not been resolved yet.
 */
function getUplinkTargets() {
    const ips = new Set();
    const domains = new Set();
    try {
        const configPath = path.join(getUnpackedDir(), 'core', 'config.json');
        if (!fs.existsSync(configPath)) return { ips: [], domains: [] };
        const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const add = (addr) => {
            const a = String(addr || '').trim().replace(/^\[|\]$/g, '');
            if (!a) return;
            // Loopback is already handled by the private-address rule and would only make
            // the exclusion list noisy.
            if (a === '127.0.0.1' || a === '::1' || a === 'localhost') return;
            if (/^[\d.]+$/.test(a) || a.includes(':')) ips.add(a);
            else domains.add(a);
        };
        (cfg.outbounds || []).forEach((o) => {
            (o.settings?.vnext || []).forEach(v => add(v.address));
            (o.settings?.servers || []).forEach(v => add(v.address));
            // A dialer chain points at another outbound, not at a server; nothing to add.
        });
    } catch (e) { /* an unreadable config means no extra exclusions, not a crash */ }
    return { ips: [...ips], domains: [...domains] };
}

module.exports = { sumTrafficStats, isTrafficPolling, setTrafficMonitoring, getTrafficMonitoring, parseVmessUri, parseShadowsocksUri, setFullTunnelMode, getFullTunnelMode, get SOCKS_PORT() { return getPorts().socks; }, get HTTP_PORT() { return getPorts().http; }, getPorts, getUplinkTargets, startXray, stopXray, stopXrayAsync, normalizeXrayId, restartXray, generateXrayConfig, parseVlessUri, startBatchXray, stopBatchXray, isRunning, getCurrentUri, enableSystemProxy, disableSystemProxySync, setSystemProxyIntent, startXrayAetherOnly };


