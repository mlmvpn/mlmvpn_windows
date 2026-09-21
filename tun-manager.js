// TUN mode: captures ALL system traffic at the network-adapter level and feeds it into
// Aether's SOCKS listener. This is the only configuration without leaks.
//
// Why it exists: the Windows system proxy only carries TCP from proxy-aware apps. QUIC
// (UDP/443, which Chrome prefers for Google and YouTube), WebRTC, and every non-browser
// program bypass it entirely and go out with the real IP. TUN has no such gap — the OS
// hands us the packets before any application choice is involved.
//
// Aether is SOCKS-only (verified: no TUN in its CLI or deps), so a TUN->SOCKS engine is
// required. sing-box does that plus route and DNS management in one binary.

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { resolveRoutes } = require('./tun-routes');

// Same /30 that most sing-box setups use. It must not collide with the user's LAN; RFC1918
// space in 172.19 is far less common in home routers than 192.168.x or 10.x.
const TUN_ADDRESS = '172.19.0.1/30';
// The adapter MUST also claim an IPv6 address. sing-box's auto_route only installs IPv6
// routes for a TUN that has an IPv6 address on it, so an IPv4-only adapter silently let
// every IPv6 packet — including IPv6 DNS to the ISP's resolver — leave over the real
// interface with the real IP. On a dual-stack Iranian ISP that is the whole DNS leak:
// the tunnel was honest about IPv4 and the operating system quietly used IPv6 instead.
// This ULA range is sing-box's own documented default and cannot collide with a LAN.
const TUN_ADDRESS6 = 'fdfe:dcba:9876::1/126';

// 9000 was sing-box's default for a kernel-adjacent tunnel. This one ends in a SOCKS5 relay
// whose real path is a MASQUE/QUIC datagram — roughly 1400 bytes of usable payload. Telling
// the operating system the link carries 9000 means any application that sizes a datagram to
// the interface MTU hands us something the tunnel cannot carry, and QUIC sets DF, so those
// packets are dropped rather than fragmented — silently, with nothing logged anywhere.
// 1420 leaves room for the QUIC short header, the AEAD tag, the DATAGRAM framing and the
// outer UDP/IP headers, so what Windows believes about the link is what the link can do.
const TUN_MTU = 1420;

// How long an answer resolved THROUGH the tunnel is worth keeping, from the client's side.
//
// Five minutes, not the 60 seconds every upstream on this path hands out. See the rule that
// uses it: a lookup inside the tunnel costs 1–3.5 s measured, the address in it is not even the
// one the connection ends up using (the engine is given the name and resolves it at its exit),
// and a 60-second TTL means paying that cost again for every name on every page, all session.
// Short enough that a site which really moves is picked up within one page reload.
const TUN_DNS_MIN_TTL = 300;

// Name the adapter instead of letting sing-box pick one.
//
// Three things need to find this adapter by name and none of them can guess: the readiness
// check (does it actually exist?), the health probe (is the default route still ours?), and
// the firewall kill switch (-InterfaceAlias, which is how "allow traffic leaving through the
// tunnel" is expressed). An auto-generated name makes all three unreliable, and a kill switch
// whose allow-rule points at the wrong adapter is a machine with no internet.
const TUN_IFACE_NAME = 'MLMVPN';

// Keep sing-box's own output on disk.
//
// Until now it went only to the UI's core-log panel, so a session that failed became
// unreconstructable the moment the app closed — and "the tunnel is on but nothing loads"
// is exactly the failure whose cause lives in these lines: which rule matched, which dial
// failed, whether the engine's own uplink got captured and fed back into itself. One file,
// truncated on every start, so it always describes the run being investigated.
const TUN_LOG_FILE = path.join(require('os').homedir(), '.mlmvpn', 'tun.log');
let tunLogStream = null;

function openTunLog(header) {
    closeTunLog();
    tunLogBytes = 0;
    tunLogCapped = false;
    try {
        fs.mkdirSync(path.dirname(TUN_LOG_FILE), { recursive: true });
        tunLogStream = fs.createWriteStream(TUN_LOG_FILE, { flags: 'w' });
        tunLogStream.on('error', () => { tunLogStream = null; });
        if (header) writeTunLog(header);
    } catch (e) { tunLogStream = null; }
}

function closeTunLog() {
    try { if (tunLogStream) tunLogStream.end(); } catch (e) {}
    tunLogStream = null;
}

/**
 * Is the Aether DNS bridge engaged right now?
 *
 * Recorded in the header because the two are mutually exclusive: with TUN up, sing-box
 * hijacks DNS inside the tunnel, while the bridge repoints Windows at 127.0.0.1 — lookups
 * then never enter the adapter and the machine reads as offline. It is supposed to be
 * handed over on every transition; this line is how we find out whether it actually was.
 */
function dnsBridgeState() {
    try {
        return require('./aether-dns-bridge').getStatus().running ? 'ON(!)' : 'off';
    } catch (e) {
        return 'unknown';
    }
}

// A cap, because the engine can be asked to log every connection (see logLevel) and this
// file is truncated per run, not rotated. 4 MB is far more than any diagnosis needs and far
// less than a busy tunnel would write in an hour.
const TUN_LOG_MAX_BYTES = 4 * 1024 * 1024;
let tunLogBytes = 0;
let tunLogCapped = false;

function writeTunLog(line) {
    if (!tunLogStream) return;
    if (tunLogBytes > TUN_LOG_MAX_BYTES) {
        if (!tunLogCapped) {
            tunLogCapped = true;
            try { tunLogStream.write(`[${new Date().toISOString()}] — از این‌جا به بعد لاگ نوشته نمی‌شود (سقف ۴ مگابایت) —\n`); } catch (e) {}
        }
        return;
    }
    const text = `[${new Date().toISOString()}] ${line}\n`;
    tunLogBytes += Buffer.byteLength(text);
    try { tunLogStream.write(text); } catch (e) {}
}

// How long to wait for the adapter to appear before calling the start a failure.
//
// This replaces a flat 1500 ms sleep. That sleep was a race, and it was measured losing:
// warm, sing-box failed at 1.29 s and was caught; cold, it had not finished dying at 1.5 s,
// so the app reported "✅ تونل کامل برقرار شد" for a tunnel that never existed — no adapter,
// no process, default route still on Wi-Fi, real IP on the wire. Waiting for a fact instead
// of a duration removes the race in both directions: a fast machine proceeds sooner than
// 1.5 s, a slow one gets the time it needs.
const TUN_READY_TIMEOUT_MS = 15000;
const TUN_READY_POLL_MS = 250;

// Iran's DNS filtering does not refuse a blocked name — it answers with an address inside
// RFC1918 (10.10.34.34/35/36 serve the "این سایت مسدود است" page). That collides head-on with
// the `ip_is_private -> direct` rule below, whose job is LAN and loopback: a poisoned answer
// looks exactly like a machine on the local network, so the connection is sent out the
// physical interface to the ISP's filter page instead of through the tunnel.
//
// This is not hypothetical on this machine — measured while writing this:
//     www.youtube.com -> 10.10.34.36        twitter.com -> 10.10.34.36
//     www.google.com  -> 216.239.38.120     app.visily.ai -> 52.204.122.16
//
// It also explains why the failure is invisible in the log: the sinkhole ACCEPTS the TCP
// connection (it has a page to serve), so there is no dial error for sing-box to report. The
// tunnel is genuinely up, sing-box is genuinely healthy, and the browser genuinely cannot
// open YouTube.
//
// Rejecting is deliberate. Every stale poisoned answer already sitting in a DNS cache when the
// tunnel comes up would otherwise be dialled straight to the sinkhole; a reject makes the
// application fail fast and look the name up again — and that second lookup is hijacked and
// resolved through the tunnel, which returns the real address.
const FILTER_SINKHOLE_CIDRS = ['10.10.34.0/24'];

// The address ranges the engine's own tunnel dials out to (Cloudflare WARP / MASQUE edges).
// Copied from the upstream engine's prober.rs — MASQUE_CIDRS_V4 / MASQUE_CIDRS_V6, which is
// the exact set it scans and connects to.
//
// WHY AN IP RULE WHEN THERE IS ALREADY A process_name RULE.
//
// Excluding the engine by process name is the correct idea and it usually works — but on
// Windows it is not reliable. sing-box has to ask the OS which process owns a socket, and for
// some sockets it simply cannot:
//
//     router: failed to search process: Access is denied.
//
// When that lookup fails the process rule cannot match, and the packet falls through every
// remaining rule to `final: aether` — so the engine's own QUIC packets to the Cloudflare edge
// are handed to the SOCKS port that the engine itself is serving. Caught live in the log:
//
//     inbound/tun[tun-in]: inbound packet connection to 162.159.198.1:443
//     outbound/socks[aether]: outbound packet connection to 162.159.198.1:443
//
// That is the tunnel eating its own uplink. Nothing crashes and nothing is logged as an error;
// the engine simply stops being able to reach the internet, so every name lookup and every
// connection inside the tunnel hangs — "connected, but no site opens".
//
// An address never needs a permission check, so this rule holds even when the process lookup
// is refused. The process rule stays as well: the two cover each other, and the engine also
// talks to api.cloudflareclient.com and its DNS resolvers, which are not in these ranges.
const ENGINE_UPLINK_CIDRS = [
    '162.159.192.0/24', '162.159.193.0/24', '162.159.195.0/24', '162.159.196.0/24',
    '162.159.197.0/24', '162.159.198.0/24', '162.159.204.0/24',
    '162.159.36.0/24', '162.159.46.0/24',
    '172.65.251.0/24',
    '188.114.96.0/24', '188.114.97.0/24', '188.114.98.0/24', '188.114.99.0/24',
    '2606:4700:102::/48', '2606:4700:d0::/48', '2606:4700:d1::/48',
];

// The hostname the engine registers and re-registers against. It is served from Cloudflare's
// CDN anycast space, so no IP rule can cover it without covering half the web — but the name
// is stable, and a name rule matches before any address is known. Sending it into the tunnel
// is a deadlock: the engine cannot re-register until it is connected, and it cannot connect
// until it has re-registered.
const ENGINE_API_SUFFIXES = ['cloudflareclient.com'];

/**
 * Is this address already inside the STATIC exclusion list?
 *
 * The difference matters for diagnosis, not for the running config. Anything the engine is
 * using at start-up is excluded by an exact /32 either way — but a /32 is a snapshot, and
 * the engine can migrate to another edge at any moment. While it stays inside the static
 * ranges, that migration is harmless; the moment it leaves them, the tunnel is one
 * un-refreshed exclusion away from swallowing its own uplink, and nothing reports an error
 * when that happens. So an uncovered address is worth saying out loud.
 *
 * IPv4 is compared numerically. IPv6 is compared on the textual prefix, which is enough for
 * the /48s in the list and avoids hand-rolling v6 arithmetic for a diagnostic.
 */
/**
 * The engine's process names, as a list.
 *
 * AN ENGINE IS NOT ALWAYS ONE PROCESS. Tor is two — `tor.exe` plus `lyrebird.exe`, and on a bridge
 * rung it is lyrebird, not tor, that makes the real outbound connection. Excluding only the first
 * of them would put the PT's traffic back through the tunnel the PT is trying to build: the loop
 * this exclusion exists to prevent, and it shows up as a tunnel that comes up and carries nothing
 * rather than as an error.
 *
 * A plain string still works, so every existing caller is unchanged.
 */
function processNames(value, fallback) {
    const raw = value === undefined || value === null ? fallback : value;
    const list = (Array.isArray(raw) ? raw : [raw])
        .map(n => String(n || '').trim().toLowerCase())
        .filter(Boolean);
    return list.length ? Array.from(new Set(list)) : [String(fallback).toLowerCase()];
}

function ipInCidr(ip, cidr) {
    const [range, bitsRaw] = String(cidr).split('/');
    const bits = parseInt(bitsRaw, 10);
    if (!range || !Number.isInteger(bits)) return false;

    const isV4 = (x) => /^\d+\.\d+\.\d+\.\d+$/.test(x);
    if (isV4(ip) !== isV4(range)) return false;

    if (isV4(ip)) {
        const toInt = (x) => x.split('.').reduce((n, o) => (n << 8 >>> 0) + (parseInt(o, 10) & 255), 0) >>> 0;
        if (bits < 0 || bits > 32) return false;
        const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
        return ((toInt(ip) & mask) >>> 0) === ((toInt(range) & mask) >>> 0);
    }

    // v6: compare the leading hextets the prefix covers.
    const groups = Math.floor(bits / 16);
    const head = (x) => x.toLowerCase().split(':').slice(0, groups).join(':');
    return groups > 0 && head(ip) === head(range.replace(/::$/, ''));
}

/** Which of these engine addresses are NOT inside the static range list. */
function uncoveredUplinks(ips) {
    if (!Array.isArray(ips)) return [];
    return ips.filter(ip => ip && !ENGINE_UPLINK_CIDRS.some(cidr => ipInCidr(ip, cidr)));
}

// Bare IPs -> single-host CIDRs, ignoring anything unparseable. Kept tiny and total on
// purpose: this feeds a routing rule, and a malformed entry there is a sing-box that refuses
// to start, which the user experiences as "the tunnel switch does nothing".
function toHostCidrs(ips) {
    if (!Array.isArray(ips)) return [];
    return ips
        .map(ip => String(ip || '').trim())
        .filter(ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-fA-F:]+$/.test(ip) && ip.includes(':'))
        .map(ip => (ip.includes(':') ? `${ip}/128` : `${ip}/32`));
}

let tunProcess = null;
let tunRunning = false;

function getUnpackedDir() {
    // Mirrors xray-manager: in a packaged build the binaries live in app.asar.unpacked.
    return __dirname.includes('app.asar')
        ? __dirname.replace('app.asar', 'app.asar.unpacked')
        : __dirname;
}

function binPaths() {
    const dir = path.join(getUnpackedDir(), 'core');
    // The engine files may come from a store install; the generated config always stays beside the
    // app, because that is where this module writes it.
    const bin = require('./core-paths').dir('singbox', dir);
    return {
        exe: path.join(bin, 'sing-box.exe'),
        wintun: path.join(bin, 'wintun.dll'),
        config: path.join(dir, 'tun-config.json'),
    };
}

// Both files are required and neither ships with the repo. Fail with a message that says
// exactly what is missing and where to put it, rather than a spawn ENOENT.
function checkPrerequisites() {
    const { exe, wintun } = binPaths();
    const missing = [];
    if (!fs.existsSync(exe)) missing.push('sing-box.exe');
    if (!fs.existsSync(wintun)) missing.push('wintun.dll');
    if (missing.length) {
        throw new Error(
            `برای حالت تونل این فایل‌ها لازم است و در پوشه core پیدا نشدند: ${missing.join(' و ')}. ` +
            'آن‌ها را در کنار xray.exe قرار دهید.'
        );
    }
}

function isRunning() {
    return tunRunning && tunProcess && !tunProcess.killed;
}

/** The saved per-app choice as tunnel rules; a broken or missing file means "every app". */
function readAppRouting(engineTag, processName) {
    try { return require('./app-routing').tunRules(engineTag, processName); } catch (e) { return NO_APP_ROUTING; }
}

// The engine only makes sense if something is listening on the SOCKS port. Starting TUN
// against a dead port would take the default route away and drop the machine offline with
// no route back — the exact failure the system-proxy path already guards against.
function portIsLive(port, timeoutMs = 1200) {
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

// A listening port only proves Aether is alive, not that its tunnel carries traffic. That
// distinction is the whole difference between "TUN works" and "the machine loses internet
// with no way back", so prove the data path end-to-end before touching the default route.
//
// Speaks SOCKS5 by hand rather than pulling in a dependency: no auth, CONNECT to a literal
// IP (never a hostname -- a DNS failure inside the tunnel must not masquerade as a dead
// data path), then require real bytes back. 1.1.1.1 answers a bare GET with a 301, which is
// all we need: any response at all means packets made the round trip.
// What SOCKS5 reply codes mean, so a refusal says something a person can act on.
const SOCKS_REPLY = {
    1: 'خطای عمومی سرور', 2: 'اجازه ندارد', 3: 'شبکه در دسترس نیست',
    4: 'میزبان در دسترس نیست', 5: 'اتصال رد شد', 6: 'TTL تمام شد',
    7: 'دستور پشتیبانی نمی‌شود', 8: 'نوع آدرس پشتیبانی نمی‌شود',
};

// Where the pre-flight probe knocks. 1.1.1.1:80 answers a bare HTTP/1.1 request with a 301
// from anywhere in the world, which is all this needs. Measured through a Cloudflare-Worker
// node (2026-09-12): 1.1.1.1:80 and 1.0.0.1:80 answered; example.com:80 and google.com:80 were
// accepted and then closed without data. So the fallbacks are chosen to be things such a node
// can really reach, not simply "another popular address".
const PROBE_TARGETS = [
    { ip: [1, 1, 1, 1], port: 80, host: '1.1.1.1' },
    { ip: [1, 0, 0, 1], port: 80, host: '1.0.0.1' },
    { ip: [9, 9, 9, 9], port: 80, host: '9.9.9.9' },
];

/**
 * Does data actually come back through this SOCKS port?
 *
 * Resolves { ok, why, ms, target } — the reason matters. This is the pre-flight check that
 * decides whether the machine's default route may be handed to the engine, and when it says
 * no, the user is left with a tunnel switch that will not turn on. A bare boolean made that
 * failure unreadable even from the logs: it covers a dead engine, a node that refuses this
 * one destination, and a tunnel that is merely slow — and those need different answers.
 */
function tunnelCarriesData(port, timeoutMs = 8000, target = PROBE_TARGETS[0]) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done = false;
        let stage = 'greeting';
        const started = Date.now();
        const label = `${target.host}:${target.port}`;
        const finish = (ok, why) => {
            if (done) return;
            done = true;
            sock.destroy();
            resolve({ ok, why: why || '', ms: Date.now() - started, target: label });
        };

        sock.setTimeout(timeoutMs);
        sock.once('timeout', () => finish(false, `مهلت ${timeoutMs}ms در مرحله‌ی ${stage}`));
        sock.once('error', (e) => finish(false, `${stage}: ${e.message}`));
        sock.once('close', () => finish(false, `اتصال در مرحله‌ی ${stage} بسته شد`));

        sock.on('data', (buf) => {
            if (stage === 'greeting') {
                // 0x05 0x00 = SOCKS5, no authentication required.
                if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(false, 'پاسخ SOCKS5 نامعتبر');
                stage = 'connect';
                const [a, b, c, d] = target.ip;
                sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, a, b, c, d, target.port >> 8, target.port & 0xFF]));
            } else if (stage === 'connect') {
                // buf[1] is the reply code; 0x00 is success.
                if (buf[0] !== 0x05 || buf[1] !== 0x00) {
                    return finish(false, `نود ${label} را قبول نکرد (${SOCKS_REPLY[buf[1]] || 'کد ' + buf[1]})`);
                }
                stage = 'http';
                sock.write(`GET / HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`);
            } else {
                // Bytes came back through the tunnel. That is the proof we wanted.
                finish(buf.length > 0, buf.length ? `${buf.length} بایت برگشت` : 'پاسخ خالی');
            }
        });

        sock.connect(port, '127.0.0.1', () => {
            sock.write(Buffer.from([0x05, 0x01, 0x00])); // greet: SOCKS5, one method, "none"
        });
    });
}

/**
 * Can the engine behind this SOCKS port actually carry UDP?
 *
 * ASKING, instead of assuming, because the answer decides whether the tunnel is usable at
 * all — and it is a property of the NODE, not of the protocol. A VLESS node on a plain VPS
 * carries UDP; the same VLESS pointed at a Cloudflare Worker does not, because the worker
 * implements UDP for port 53 only and closes everything else (zeus.js: `if (cmd === 2) { if
 * (port === 53) … else serverSock.close(); }`).
 *
 * Getting this wrong is the difference between a tunnel that works and one that looks
 * connected while nothing loads:
 *   * with UDP assumed present, sing-box sends every DNS query over UDP through a path that
 *     silently drops it, and hands the browser's QUIC (UDP/443) to the same hole. Chrome
 *     prefers QUIC for YouTube and waits out its own timeout on every attempt — the user
 *     sees "the proxy plays video fine but the tunnel cannot even open YouTube";
 *   * with UDP known absent, DNS goes over TCP (still inside the tunnel, so the leak stays
 *     closed) and QUIC is REJECTED, which the browser sees immediately and answers by
 *     falling back to HTTP/2 over TCP — the exact path that works in proxy mode.
 *
 * A real DNS query is the probe: it needs UDP ASSOCIATE, a datagram out and a datagram back,
 * which is precisely the capability in question.
 */
function socksCarriesUdp(port, { timeoutMs = 6000, host = [1, 1, 1, 1], targetPort = 53 } = {}) {
    return new Promise((resolve) => {
        // Kept under its own name so nothing below can shadow it. See the note on `relay`.
        const target = Array.isArray(host) ? host : String(host).split('.').map(Number);
        if (target.length !== 4 || target.some((n) => !(n >= 0 && n <= 255))) return resolve(false);
        const dgram = require('dgram');
        const sock = new net.Socket();
        const udp = dgram.createSocket('udp4');
        let done = false;
        let stage = 'greeting';
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) {}
            try { udp.close(); } catch (e) {}
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        if (timer.unref) timer.unref();

        sock.setTimeout(timeoutMs);
        sock.once('timeout', () => finish(false));
        sock.once('error', () => finish(false));
        // The control connection closing is how a worker says "not supported".
        sock.once('close', () => finish(false));

        sock.on('data', (buf) => {
            if (stage === 'greeting') {
                if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(false);
                stage = 'associate';
                // CMD 0x03 = UDP ASSOCIATE, from 0.0.0.0:0 (we do not know our own port yet).
                sock.write(Buffer.from([0x05, 0x03, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                return;
            }
            if (stage !== 'associate') return;
            if (buf[0] !== 0x05 || buf[1] !== 0x00 || buf[3] !== 0x01) return finish(false);
            stage = 'sent';

            const relayPort = buf.readUInt16BE(8);
            const relayHost = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
            // A relay address of 0.0.0.0 means "same host as the control connection".
            //
            // NAMED `relay`, and that is the whole bug this once had. It used to be called
            // `host`, which SHADOWED the target address this function takes as `host` — so the
            // datagram's destination was lost, and `...host` then spread a dotted STRING into
            // the header, writing the ASCII codes of "127.0.0.1" where four address bytes
            // belong. Every engine came back "does not carry UDP", including گف, which carries
            // it perfectly: the same associate, with the header written correctly, answers a
            // 75-byte DNS reply from both 1.1.1.1 and 8.8.8.8 through a Warsaw exit.
            const relay = relayHost === '0.0.0.0' ? '127.0.0.1' : relayHost;

            // A/IN query for example.com, with the SOCKS UDP request header in front.
            // Header: RSV RSV FRAG ATYP(1=IPv4) DST.ADDR[4] DST.PORT[2] — the TARGET, not the relay.
            const query = Buffer.from(
                'abcd0100000100000000000003777777076578616d706c6503636f6d0000010001', 'hex');
            const header = Buffer.from([0, 0, 0, 1, ...target, targetPort >> 8, targetPort & 0xff]);
            // A reply short enough to be anything is not an answer: a DNS response carries the
            // question back, so it cannot be smaller than the query.
            udp.on('message', (msg) => finish(msg.length >= query.length));
            udp.on('error', () => finish(false));
            udp.send(Buffer.concat([header, query]), relayPort, relay, (err) => {
                if (err) finish(false);
            });
        });

        sock.connect(port, '127.0.0.1', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    });
}

/**
 * Can the engine behind `port` answer a DNS query over TCP to `host` (dotted IPv4)?
 *
 * The TCP half of the question socksCarriesUdp asks. A SOCKS "connect succeeded" proves
 * nothing here — Xray answers it before it has dialled anything — so the probe sends a real
 * length-prefixed query and waits for the answer that carries its own id.
 */
function socksResolvesTcp(port, { host = '8.8.8.8', timeoutMs = 6000 } = {}) {
    return new Promise((resolve) => {
        const ip = String(host).split('.').map(Number);
        if (ip.length !== 4 || ip.some((n) => !(n >= 0 && n <= 255))) return resolve(false);
        const id = crypto.randomBytes(2);
        // A/IN query for example.com, with a fresh id.
        const query = Buffer.concat([id, Buffer.from('0100000100000000000003777777076578616d706c6503636f6d0000010001', 'hex')]);
        const sock = new net.Socket();
        let done = false;
        let stage = 'greeting';
        let answer = Buffer.alloc(0);
        const finish = (ok) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (e) {}
            resolve(ok);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        if (timer.unref) timer.unref();
        sock.once('error', () => finish(false));
        sock.once('close', () => finish(false));
        sock.on('data', (buf) => {
            if (stage === 'greeting') {
                if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(false);
                stage = 'connect';
                sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, ...ip, 0x00, 53]));
                return;
            }
            if (stage === 'connect') {
                if (buf[0] !== 0x05 || buf[1] !== 0x00) return finish(false);
                stage = 'query';
                const len = Buffer.alloc(2);
                len.writeUInt16BE(query.length);
                sock.write(Buffer.concat([len, query]));
                return;
            }
            answer = Buffer.concat([answer, buf]);
            // 2-byte length, then the DNS header: id, then flags with QR (0x80) set on a reply.
            if (answer.length >= 5) finish(answer[2] === id[0] && answer[3] === id[1] && (answer[4] & 0x80) !== 0);
        });
        sock.connect(port, '127.0.0.1', () => sock.write(Buffer.from([0x05, 0x01, 0x00])));
    });
}

// WHICH RESOLVER THE TUNNEL ASKS — measured, not assumed.
//
// Every lookup in the full tunnel goes to one resolver THROUGH the engine, so it has to be one
// the engine's server can actually reach. A Cloudflare Worker node cannot: Workers are not
// allowed to open a socket to a Cloudflare address, and 1.1.1.1 is one. The worker's proxyIP
// fallback rescues port 443 but never port 53. So on the user's own worker (trojan over
// WebSocket, workers.dev) the old fixed 1.1.1.1 failed over UDP, then over TCP, and the
// tunnel came up with every name lookup dead — "the tunnel is on and nothing passes".
// Google's resolver is not on Cloudflare, so it comes first; the others stay as candidates
// for a node that happens to reach only them. Android's Xray config reaches the same answer
// the other way round (https://8.8.8.8/dns-query for worker configs).
const TUNNEL_RESOLVERS = ['8.8.8.8', '1.1.1.1', '9.9.9.9'];

/**
 * Ask every candidate, over UDP and over TCP at once, through the engine on `port`. Returns
 * { server, udp } — UDP when any resolver answers over it (faster, and it also says the node
 * carries UDP at all), TCP otherwise — or null when no lookup gets through by either.
 */
async function pickTunnelResolver(port, { candidates = TUNNEL_RESOLVERS, timeoutMs = 6000 } = {}) {
    const [udp, tcp] = await Promise.all([
        Promise.all(candidates.map((h) => socksCarriesUdp(port, { host: h.split('.').map(Number), targetPort: 53, timeoutMs }))),
        Promise.all(candidates.map((h) => socksResolvesTcp(port, { host: h, timeoutMs }))),
    ]);
    const u = udp.indexOf(true);
    if (u >= 0) return { server: candidates[u], udp: true, answered: { udp, tcp } };
    const t = tcp.indexOf(true);
    if (t >= 0) return { server: candidates[t], udp: false, answered: { udp, tcp } };
    return null;
}

/**
 * Pull a real payload THROUGH the adapter, once, and say how fast it came.
 *
 * tunnelCarriesData() above proves the SOCKS engine answers — a handshake and a few bytes.
 * That is deliberately cheap, because it gates the machine's default route. But it cannot
 * tell a working tunnel from one that carries the first packets of a connection and then
 * stalls, which is the failure the user actually reports: DNS resolves, connections are
 * dispatched, no page loads. Nothing in sing-box's log distinguishes the two either — it
 * logs the dispatch, not the bytes.
 *
 * This request is not excluded from the tunnel (only the engine's own process is), so it
 * takes exactly the path the user's browser takes. The result is written to the log file,
 * so the next "the tunnel is on and nothing works" has a number attached to it instead of
 * an inference.
 *
 * Deliberately advisory: it runs AFTER the tunnel is up and never tears anything down. A
 * slow line is not a broken tunnel, and this must not become a second gate that keeps the
 * user offline on a bad minute.
 */
/**
 * Does the tunnel carry traffic AT ALL — asked without needing DNS.
 *
 * Cloudflare's resolver serves HTTPS on the literal 1.1.1.1 with a certificate that names
 * the address, so this is a full TLS round trip through the tunnel with no name lookup
 * anywhere in it. That matters in the first seconds after the adapter appears: Windows'
 * resolver is still settling, so a probe that starts with getaddrinfo can fail on a tunnel
 * that is working perfectly — which is exactly how the verification below ended up tearing
 * down a healthy tunnel ("getaddrinfo ENOTFOUND speed.cloudflare.com", one second after the
 * adapter came up).
 */
function probeTunReachableByIp(timeoutMs = 8000) {
    return new Promise((resolve) => {
        const https = require('https');
        // A Cloudflare anycast address, NOT a resolver address: 1.1.1.1 and 8.8.8.8 are
        // reset on this kind of line (measured: ECONNRESET on both, on 443), so a probe
        // built on them reports a broken tunnel on a working one. Any HTTP status counts —
        // 403 for a bare-IP request is a complete TLS handshake plus a real answer, which
        // is precisely the thing being tested. The point is "did a packet make it there and
        // back", not "was the response useful".
        const req = https.get(
            {
                host: '104.16.132.229',
                servername: 'www.cloudflare.com',
                headers: { Host: 'www.cloudflare.com' },
                path: '/cdn-cgi/trace',
                timeout: timeoutMs,
            },
            (res) => {
                res.resume();
                res.on('end', () => resolve(true));
            }
        );
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.on('error', () => resolve(false));
    });
}

/**
 * Do name lookups work through the tunnel?
 *
 * Asked of sing-box itself — every query to port 53 is hijacked into its resolver, whatever
 * address it is sent to — so neither Windows' cache nor an answer from before the tunnel can
 * stand in for it. Retried, because the first second of an adapter's life is where lookups
 * are least reliable.
 */
async function tunResolves({ attempts = 3, timeoutMs = 4000 } = {}) {
    const { Resolver } = require('dns').promises;
    for (let i = 0; i < attempts; i++) {
        try {
            const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
            resolver.setServers(['8.8.4.4']);
            const a = await resolver.resolve4('www.google.com');
            if (Array.isArray(a) && a.length) return true;
        } catch (e) { /* ENOTFOUND / ETIMEOUT — asked again below */ }
        if (i < attempts - 1) await new Promise(wait => setTimeout(wait, 1500));
    }
    return false;
}

/**
 * Verify a freshly built tunnel, tolerantly.
 *
 * "No fake tunnel" must not become "no tunnel": the payload download is the real proof, but
 * it depends on name resolution, and a name lookup in the first seconds of a tunnel's life
 * is the least reliable thing about it. So the throughput probe is retried, and a failure
 * that is only a DNS failure falls back to the IP-only reachability check above. The tunnel
 * is rejected when NOTHING gets through — not when the first lookup was early.
 *
 * …and not when only addresses get through. That fallback used to accept a tunnel whose
 * lookups were all dead, because a bare address still answered — the log of the user's
 * "the V2Ray tunnel is on and nothing passes" shows exactly that: two ENOTFOUNDs, then
 * "the DNS-free test passed, the tunnel stays on". Every app starts with a name, so the
 * fallback now also asks for one, with retries, before it keeps the tunnel.
 */
async function verifyTunCarriesTraffic(onLog, { bytes = 262144, attempts = 2, timeoutMs = 15000 } = {}) {
    // Bounded on purpose: this runs inside the transition lock and the user is watching a
    // switch that has not moved yet. Two attempts plus the DNS-free fallback is ~40s worst
    // case, and a line that cannot deliver 256KB in 15 seconds twice over is not a line the
    // whole machine should be routed through anyway.
    for (let i = 1; i <= attempts; i++) {
        const got = await probeTunThroughput(onLog, { bytes, timeoutMs });
        if ((got && got.received) >= bytes * 0.9) return true;
        if (i < attempts) {
            onLog(`[TUN] تلاش ${i} برای سنجش عبور دیتا جواب نداد؛ چند لحظه دیگر دوباره…`);
            await new Promise(r => setTimeout(r, 2500));
        }
    }
    // Last word: can anything at all reach the internet through this adapter?
    const reachable = await probeTunReachableByIp();
    if (reachable) {
        if (!(await tunResolves())) {
            const line = '❌ آدرس‌ها از داخل تونل جواب می‌دهند ولی هیچ نامی (DNS) پیدا نمی‌شود — با این وضع هیچ برنامه‌ای کار نمی‌کند، پس تونل روشن نمی‌ماند.';
            onLog(`[TUN] ${line}`);
            writeTunLog(line);
            return false;
        }
        const line = '⚠️ حجم آزمایشی کامل نرسید، ولی ارتباط و DNS از داخل تونل برقرارند — تونل روشن می‌ماند.';
        onLog(`[TUN] ${line}`);
        writeTunLog(line);
        return true;
    }
    return false;
}

function probeTunThroughput(onLog, { bytes = 262144, timeoutMs = 20000 } = {}) {
    return new Promise((resolve) => {
        const https = require('https');
        const started = Date.now();
        let received = 0;
        // Resolves { received, kbps } — the RATE is what sizes the A/B diagnosis that follows,
        // so a caller that only wanted the byte count still gets it while the number that
        // matters stops being thrown away. See the perSide calculation in startTun.
        const done = (line) => {
            onLog(`[TUN] ${line}`);
            writeTunLog(line);
            const secs = (Date.now() - started) / 1000;
            resolve({ received, kbps: secs > 0 ? Math.round(received / 1024 / secs) : 0 });
        };

        const req = https.get(
            `https://speed.cloudflare.com/__down?bytes=${bytes}`,
            { timeout: timeoutMs },
            (res) => {
                res.on('data', (c) => { received += c.length; });
                res.on('end', () => {
                    const secs = (Date.now() - started) / 1000;
                    const kb = Math.round(received / 1024);
                    const rate = secs > 0 ? Math.round(received / 1024 / secs) : 0;
                    if (received >= bytes * 0.9) {
                        done(`✅ عبور واقعی دیتا از تونل: ${kb}KB در ${secs.toFixed(1)} ثانیه (${rate}KB/s)`);
                    } else {
                        done(`⚠️ دیتا از تونل ناقص رسید: فقط ${kb}KB از ${Math.round(bytes / 1024)}KB — تونل بالا هست ولی داده را کامل نمی‌رساند.`);
                    }
                });
            }
        );
        req.on('timeout', () => {
            req.destroy();
            const kb = Math.round(received / 1024);
            done(`⚠️ تونل بالاست ولی دیتا رد نمی‌شود: بعد از ${Math.round(timeoutMs / 1000)} ثانیه فقط ${kb}KB رسید.`);
        });
        req.on('error', (e) => done(`⚠️ آزمون عبور دیتا از تونل شکست خورد: ${e.message}`));
    });
}

/**
 * The DNS-over-HTTPS endpoints a BROWSER talks to on its own, which this tunnel must refuse.
 *
 * WHY REFUSING IS THE FIX AND NOT THE PROBLEM. Chrome ships «Secure DNS» on by default for many
 * users, and it does not use the operating system's resolver at all: it opens its own HTTPS
 * connection to dns.google (or Cloudflare, Quad9, NextDNS…) and resolves there. Inside a tunnel
 * that costs seconds per name, and every piece of work this file does to make DNS fast and
 * honest is bypassed — no 300-second TTL rewrite, no sinkhole rejection, no shared cache.
 *
 * Measured on a live سایفون tunnel, 2026-09-20, from the user's own line:
 *
 *     DoH dns.google          HTTP 200   4355 ms
 *     DoH cloudflare-dns.com  HTTP 200   7207 ms
 *
 * A YouTube page pulls from six or seven hostnames. At four to seven seconds each, through a
 * browser that will not wait that long, the result is «اینترنت قطع است» on a tunnel that is
 * working perfectly — the same page opened in 3.5 s from a process using the system resolver,
 * in the same minute.
 *
 * A REJECT, not a drop: a browser that sees its DoH server refused marks it as failing and
 * falls back to the system resolver within one attempt, which is this tunnel's own DNS. A
 * silent drop makes it wait for a timeout first, every time.
 *
 * Matched by DOMAIN, which is what keeps it safe: the tunnel's own upstream resolver is dialled
 * by literal address with a `detour`, so it never passes through these rules and cannot refuse
 * itself.
 */
const BROWSER_DOH_HOSTS = [
    'dns.google',
    'cloudflare-dns.com',          // covers chrome./mozilla./security./family. subdomains
    'one.one.one.one',
    'dns.quad9.net', 'quad9.net',
    'doh.opendns.com',
    'dns.nextdns.io', 'nextdns.io',
    'dns.adguard.com', 'adguard-dns.com',
    'doh.cleanbrowsing.org',
    'dns.sb', 'doh.sb',
    'doh.pub', 'dot.pub',
    'dns.alidns.com',
];

// «مسیر برنامه‌ها» (app-routing.js), as the builders below take it: extra rules and a
// replacement for `final`. startTun fills it in from the saved choice; a caller that passes
// nothing (the tests, the game tunnel) gets no per-app routing at all.
const NO_APP_ROUTING = { rules: [], final: null, mode: 'all', count: 0 };

/**
 * @param socksPort  the engine's SOCKS5 listener
 * @param options.processName  executable to keep OUTSIDE the tunnel. MUST be the engine
 *   that owns `socksPort`, or its own outbound packets get captured by auto_route and
 *   handed back to itself — an infinite loop. Defaults to aether.exe for existing callers;
 *   the Google Script Tunnel passes gst.exe.
 * @param options.engineLabel  name used in the Persian log lines.
 */
function buildTunConfig(socksPort, options = {}) {
    const exeNames = processNames(options.processName, 'aether.exe');
    const logLevel = options.logLevel || 'warn';
    // Whose uplink to keep outside the tunnel. The default list is Aether's (Cloudflare
    // /WARP); an engine that reaches its server over anything else MUST pass its own, or
    // its uplink gets captured and fed back into itself — the exact loop described above.
    // Exact addresses the engine is using RIGHT NOW, on top of the static ranges. The static
    // list cannot cover everything: the engine also reaches Cloudflare CDN anycast space
    // (104.16.0.0/12, 172.64.0.0/13), and blanket-excluding those would push a large slice of
    // the ordinary web out of the tunnel. A /32 for the live edge is exact, so it excludes the
    // uplink and nothing else. See aether-manager.getUplinkIps().
    const uplinkCidrs = [
        ...(options.uplinkCidrs || ENGINE_UPLINK_CIDRS),
        ...toHostCidrs(options.uplinkIps),
    ];
    // Hostnames the engine dials, for engines whose server is a name rather than an address.
    const uplinkDomains = (options.uplinkDomains || []).filter(d => typeof d === 'string' && d.trim());

    // Sites that go to the ENGINE rather than direct, named rather than addressed.
    //
    // The mirror image of `uplinkDomains`, which names what must stay OUT of the tunnel. This one
    // names what must go INTO it even when `final` is `direct` — which is the whole shape of
    // «تحریم‌شکن»: a browser that stays direct for everything except the handful of services that
    // refuse an Iranian address.
    const engineDomains = (options.engineDomains || []).filter(d => typeof d === 'string' && d.trim());
    // The outbound's tag is what every sing-box log line is stamped with
    // ("outbound/socks[…]"). Hard-coding "aether" made a V2Ray tunnel report itself as
    // Aether in the very log used to diagnose it, so it follows the engine instead.
    const engineTag = options.engineTag || 'aether';
    // Aether's registration host. It is meaningless for any other engine, and every entry
    // in this list is a hostname that leaves the tunnel — so an engine that does not need
    // it passes an empty list rather than carrying someone else's bypass.
    const apiSuffixes = options.apiSuffixes || ENGINE_API_SUFFIXES;

    // Does this engine need its OWN lookups answered for it?
    //
    // Every engine's process is excluded from the tunnel above `hijack-dns`, which keeps its
    // traffic out of a tunnel that does not exist yet — and also leaves its DNS going straight to
    // whatever resolver the line provides. Where that resolver is poisoned, an engine that trusts
    // the system resolver gets a sinkhole address for its own servers and can never connect.
    // Measured on MCI: 353 dials to 10.10.34.36 from one engine in fifty seconds, and a machine
    // with no working route at all because `final` pointed at it.
    //
    // Opt-in, because it is only true of an engine with no resolver of its own: سایفون carries its
    // own (on non-standard ports, deliberately outside the tunnel) and تور resolves inside its
    // circuit. Turning this on for them would move a working lookup onto a different path for no
    // reason.
    const hijackEngineDns = !!options.hijackEngineDns;

    // Can the engine behind `socksPort` carry UDP over SOCKS5?
    //
    // Aether can. The Google Script Tunnel CANNOT: mhrv-rs in apps_script mode answers
    // UDP ASSOCIATE with 0x07 "command not supported" (proxy_server.rs — "only full mode
    // supports UDP tunneling"). That matters enormously here, because the DNS server
    // below is reached through `detour`, so a UDP DNS server over a UDP-less engine
    // means EVERY name lookup fails. Observed symptom: the Wi-Fi indicator drops to "no
    // internet" the moment the tunnel comes up and never recovers, with the engine log
    // filling with "SOCKS5 UDP ASSOCIATE requested for 0.0.0.0:0".
    const supportsUdp = options.supportsUdp !== false;
    // Separate from supportsUdp on purpose. A Cloudflare-Worker node carries UDP for DNS
    // (port 53) and NOTHING else — the worker closes every other UDP association. So the
    // useful combination is "UDP yes, QUIC no": lookups stay fast and inside the tunnel,
    // while the browser's UDP/443 is refused instead of dropped, and Chrome falls back to
    // HTTP/2 over TCP at once rather than waiting out its own timeout on every connection.
    // Dropping it silently is what made YouTube unplayable through the tunnel while the
    // very same node played it fine through the system proxy.
    const rejectQuic = options.rejectQuic !== undefined ? !!options.rejectQuic : !supportsUdp;
    // Refuse the browser's own DNS-over-HTTPS so it falls back to ours. See BROWSER_DOH_HOSTS.
    // The caller may force it either way; otherwise the user's setting decides, and that
    // defaults to blocking.
    const blockAppDoh = options.blockAppDoh !== undefined
        ? !!options.blockAppDoh
        : (() => { try { return require('./network-settings').blockAppDoh(); } catch (e) { return true; } })();
    const app = options.appRouting || NO_APP_ROUTING;

    return {
        log: { level: logLevel, timestamp: true },

        // Every DNS query is resolved through the tunnel. This is what closes the DNS leak
        // that the system proxy cannot: with a proxy, Windows and non-browser apps still
        // resolve names via the ISP resolver in cleartext.
        // NOTE: sing-box 1.14 removed the legacy DNS server format ({address: "1.1.1.1"}).
        // Servers are now typed objects. Verified against sing-box 1.14.0-alpha.47.
        dns: {
            servers: [
                // TCP when the engine cannot carry UDP. DNS over TCP is a plain TCP
                // CONNECT, which every SOCKS5 engine here handles, so lookups still go
                // THROUGH the tunnel — the leak stays closed, which a `direct` DNS
                // server would not achieve.
                // Which resolver is measured by the caller where it matters — see
                // pickTunnelResolver: a Cloudflare Worker node cannot reach 1.1.1.1 at all.
                //
                // AN ENGINE THAT RESOLVES NAMES ITSELF REPLACES THIS ENTRY ENTIRELY.
                //
                // Tor does: it runs its own DNSPort and answers from inside the circuit, so its
                // queries go there on loopback with no detour at all. Sending them to a public
                // resolver through the tunnel would work — and would also hand every app's
                // lookups to Cloudflare in cleartext, naming exactly which sites somebody who
                // just turned Tor on is visiting. That is the one thing Tor is for.
                options.remoteDnsServer || {
                    type: supportsUdp ? 'udp' : 'tcp',
                    tag: 'remote',
                    server: options.remoteDns || '1.1.1.1',
                    detour: engineTag,
                },
                // THE ENGINE'S OWN RESOLVER, and it is TCP on purpose.
                //
                // `local` above is 8.8.8.8 over UDP, and on a line that hijacks UDP/53 that is a
                // poisoned answer — which is what the first version of this fix walked into: the
                // engine's lookups were moved off the ISP's resolver onto another one that is
                // hijacked exactly the same way, and it went on dialling 10.10.34.36 (576 log lines
                // in one run). The hijack seen here takes UDP/53 and NOTHING ELSE; measured against
                // the same four resolvers over TCP/53: 8.8.8.8 in 4 ms, 9.9.9.9 in 3 ms,
                // 208.67.222.222 in 3 ms, 1.1.1.1 in 254 ms — all correct answers.
                //
                // No `detour`: it must not depend on the engine it exists to bootstrap.
                ...(hijackEngineDns ? [{ type: 'tcp', tag: 'engine-dns', server: '8.8.8.8' }] : []),

                // No `detour` here. sing-box 1.14 rejects a detour to a bare `direct`
                // outbound ("makes no sense") -- and it is right: omitting it already means
                // direct. This server exists only to resolve aether.exe's own gateway, which
                // must stay outside the tunnel.
                { type: 'udp', tag: 'local', server: '8.8.8.8' },
            ],
            rules: [
                // The connectivity probe's own name lookup has to stay off the tunnel
                // too. Resolving dns.msftncsi.com through the relay is slow enough on
                // its own to make Windows declare the network dead, and NlaSvc checks
                // that the answer is exactly 131.107.255.255 — anything the tunnel path
                // does to it reads as a captive portal.
                {
                    domain_suffix: ['msftconnecttest.com', 'msftncsi.com'],
                    server: 'local',
                },

                // THIS ENGINE'S OWN LOOKUPS, answered off the tunnel — see hijackEngineDns.
                //
                // `engine-dns` and never `remote`: the point is to answer the engine without
                // asking the tunnel it is trying to build. See that server's definition for why it
                // is TCP — the obvious choice, `local`, is hijacked on exactly the lines where this
                // matters. Paired with the route rule below, which is what lets the query reach
                // this table at all.
                ...(hijackEngineDns ? [{ process_name: exeNames, server: 'engine-dns' }] : []),

                // The engine's own control plane, resolved off the tunnel. See
                // ENGINE_API_SUFFIXES: resolving it through a tunnel it has to re-register
                // to build is a deadlock, and the process rule that would otherwise cover
                // this cannot be relied on (Windows refuses the lookup).
                // `engine-dns` when the engine asked for one, `local` otherwise.
                //
                // THIS is the rule that actually carries the engine's lookups. The process
                // rule above is the obvious way to catch them and it does not fire: Windows
                // refuses the process lookup for these sockets (the comment below has always
                // said so). Measured — with the process rule in place and this line still
                // pointing at `local`, the engine went on getting 10.10.34.36 for its own
                // hosts, 120 times in one run, because `local` is 8.8.8.8 over UDP and UDP/53
                // is exactly what this line hijacks.
                ...(apiSuffixes.length
                    ? [{ domain_suffix: apiSuffixes, server: hijackEngineDns ? 'engine-dns' : 'local' }]
                    : []),

                // …and resolve the engine's own server off the tunnel, for the same reason:
                // asking the tunnel to resolve the address it needs in order to exist is a
                // deadlock, not a lookup.
                ...(uplinkDomains.length ? [{ domain_suffix: uplinkDomains, server: 'local' }] : []),

                // Aether resolves its own gateway outside the tunnel, or it would be asking
                // itself a question it cannot answer until it is already connected.
                //
                // `rewrite_ttl` IS THE DIFFERENCE BETWEEN A SLOW TUNNEL AND A BROKEN-FEELING ONE.
                //
                // Every answer on this line comes back with a 60-second TTL (tor's DNSPort
                // clamps to it; so does most of what a worker node forwards), and a lookup
                // through the tunnel is not cheap. Measured through تور on 2026-09-17:
                //
                //     dns: exchanged A www.google.com   3.50s
                //     dns: exchanged A claude.com       2.15s
                //     dns: exchanged A mtalk.google.com 1.17s
                //
                // With a 60s TTL, Windows and the browser throw those away and ask again a
                // minute later — on every page, for every name, for as long as the tunnel is up.
                // The page stops for seconds at a time and the user calls it «قطع و وصل».
                //
                // Handing the CLIENT a longer TTL costs almost nothing here, and that is a
                // property of this configuration rather than a guess: the `sniff` rule means the
                // outbound is given the NAME, so the engine resolves it again at its own exit and
                // the address in this answer is not what the connection ends up using. What it
                // buys is one lookup instead of one per minute per name.
                { inbound: 'tun-in', server: 'remote', rewrite_ttl: TUN_DNS_MIN_TTL },
            ],
            // Fail-closed: anything not matched above goes through the tunnel, not out
            // in cleartext. The old value 'local' sent unmatched queries direct to
            // 8.8.8.8, which is exactly the DNS leak this config exists to prevent.
            // Bootstrap stays safe because default_domain_resolver and the msft-probe
            // rule explicitly use 'local'.
            final: 'remote',
            // ipv4_only, not prefer_ipv4. Aether's data path is IPv4 (AETHER_IP defaults to
            // v4), so an AAAA record is an invitation for the application to open a
            // connection this tunnel cannot carry. Never handing one out means nothing ever
            // tries, and the v6 reject rule below stays a backstop rather than a hot path.
            strategy: 'ipv4_only',
            // WITHOUT THIS, EVERY LOOKUP PAYS THE FULL TUNNEL ROUND TRIP.
            //
            // The smart config has always had a cache; this one did not, and the difference
            // is brutal on a filtered line. Measured on this machine, with the only reachable
            // Cloudflare edge answering at rtt=1.76s:
            //
            //     dns: exchanged A www.google.com        2.80s
            //     dns: exchanged A play.google.com       4.70s
            //     dns: exchanged A login.tailscale.com   0.99s
            //
            // A page makes tens of lookups and repeats most of them. Several seconds each,
            // uncached, is a browser that appears frozen even though traffic is flowing
            // perfectly — which is exactly what "the tunnel connects but nothing works"
            // looks like from the user's side.
            // Deliberately no `independent_cache`: sing-box 1.14 deprecates it (removed in
            // 1.16) and warns on every start. The separation it used to provide is now the
            // default, so asking for it buys nothing and only pins us to a dying option.
            cache_capacity: 4096,
        },

        inbounds: [{
            type: 'tun',
            tag: 'tun-in',
            interface_name: TUN_IFACE_NAME,
            address: [TUN_ADDRESS, TUN_ADDRESS6],
            mtu: options.mtu || TUN_MTU,
            auto_route: true,
            // Blocks traffic that tries to escape the tunnel via another interface. This is
            // the difference between "mostly tunnelled" and "no leaks".
            strict_route: true,
            // gvisor reimplements TCP in userspace: it needs no extra kernel privileges and
            // behaves the same on every machine, which is why it is the default here. It is also
            // the slower of the two — everything the tunnel carries is copied through a userspace
            // stack — so Settings › تنظیمات پیشرفته VPN offers «system», which hands the packets
            // to Windows' own stack instead. The choice arrives as an option rather than being
            // decided here, and the tunnel's speed report names which one produced its number.
            stack: options.stack || 'gvisor',
            // No `sniff` here: 1.13 removed the legacy inbound fields. Sniffing is the
            // `action: "sniff"` route rule instead.
        }],

        outbounds: [
            {
                type: 'socks', tag: engineTag, version: '5',
                server: '127.0.0.1', server_port: socksPort,
            },
            // 1.13 removed the "dns" and "block" outbound types; both are rule actions now.
            { type: 'direct', tag: 'direct' },
        ],

        route: {
            auto_detect_interface: true,
            // Required from 1.14: which resolver dial-outs use for their own hostnames.
            // "local" keeps that off the tunnel, so it works before Aether is reachable.
            default_domain_resolver: { server: 'local' },
            // ORDER IS SAFETY-CRITICAL HERE. Do not reshuffle these.
            rules: [
                { action: 'sniff' },

                // Must come BEFORE hijack-dns. Two separate loops are being prevented:
                //
                //  1. Aether's QUIC packets to the Cloudflare edge are ordinary outbound
                //     traffic, so auto_route would capture them and hand them back to
                //     Aether — which is the other end of that same SOCKS port.
                //  2. Aether's own DNS lookups (e.g. resolving the registration API on a
                //     first connect) would be hijacked and sent through a tunnel that is
                //     not up yet, so the connect could never complete.
                //
                // Excluding the process entirely, before any DNS handling, avoids both.
                // The name is a parameter because whichever engine owns `socksPort` is the
                // one that must be excluded — excluding the wrong binary silently
                // reintroduces the loop it is here to prevent.
                // The engine's DNS is captured BEFORE its process is excluded, and only for an
                // engine that asked. Without this the rule below sends its queries out to the
                // line's own resolver; with it they are answered by the `local` server above, which
                // is direct — so the deadlock the exclusion exists to prevent still cannot happen.
                // Placed here and nowhere else: everything after this line is unchanged.
                ...(hijackEngineDns ? [{ process_name: exeNames, protocol: 'dns', action: 'hijack-dns' }] : []),

                { process_name: exeNames, outbound: 'direct' },

                // The same exclusion by destination address, because the rule above cannot be
                // relied on alone: Windows refuses the process lookup for some sockets and the
                // engine's own uplink then loops back into the engine. See ENGINE_UPLINK_CIDRS.
                //
                // OMITTED WHEN EMPTY, AND THAT IS NOT A TIDINESS RULE.
                //
                // A sing-box route rule whose condition arrays are all empty has NO conditions,
                // and a rule with no conditions matches EVERYTHING. Measured against this
                // build's sing-box: `{ ip_cidr: [], outbound: 'direct' }` as the first rule sent
                // every request to `direct`. Sitting third here, it turned the whole tunnel into
                // a passthrough — the machine kept working for ordinary sites (so the 256 KB
                // payload check passed and the switch went green), filtered sites were reset by
                // the ISP the moment they left in the clear, and «بدون نشتی» was on over a
                // connection with the user's real address on every packet.
                // `uplinkCidrs` is empty for every node whose address is a NAME rather than a
                // clean IP, which is most Cloudflare configs. See dropConditionlessRules().
                ...(uplinkCidrs.length ? [{ ip_cidr: uplinkCidrs, outbound: 'direct' }] : []),

                // «مسیر برنامه‌ها», bypass: the chosen apps leave on the real connection — all of
                // their packets, their own DNS included, before anything below can claim them.
                // That is what Android's disallowed apps do too: nothing of theirs enters the VPN.
                ...(app.mode === 'bypass' ? app.rules : []),

                // Windows' own connectivity check must NOT go through the tunnel.
                //
                // NlaSvc fetches http://www.msftconnecttest.com/connecttest.txt and
                // resolves dns.msftncsi.com, and decides from those whether the network
                // icon says "connected" or "no internet". Relaying that probe through an
                // Apps Script hop makes it slow or fail, so Windows flags the adapter as
                // offline — the Wi-Fi antenna drops and never comes back, even though
                // real traffic is flowing. (Seen in the field log as repeated
                // "relay GET http://…/connecttest.txt" right as the antenna died.)
                //
                // These probes are plaintext HTTP to Microsoft and carry nothing about
                // the user, so sending them direct costs no privacy.
                {
                    domain_suffix: ['msftconnecttest.com', 'msftncsi.com'],
                    outbound: 'direct',
                },

                // The engine's registration/API host, by name — the only handle there is on
                // it, since it lives in CDN anycast space shared with the ordinary web.
                ...(apiSuffixes.length ? [{ domain_suffix: apiSuffixes, outbound: 'direct' }] : []),

                // The engine's OWN server, when the config names it instead of an IP.
                //
                // An address rule cannot help here: the name has not been resolved yet when
                // the routing decision is made, and the address it resolves to is Cloudflare
                // anycast shared with half the web. Without this, an engine dialling
                // "something.workers.dev" has its own uplink captured and handed back to
                // itself — the same loop the IP list prevents for clean-IP configs.
                ...(uplinkDomains.length ? [{ domain_suffix: uplinkDomains, outbound: 'direct' }] : []),

                // Everything else's DNS is captured so it cannot leave in cleartext.
                { protocol: 'dns', action: 'hijack-dns' },

                // «مسیر برنامه‌ها», only the chosen apps: they go to the engine — after the DNS
                // capture, so their lookups still resolve through the tunnel — and `final`
                // below becomes 'direct' for everything else. A dead engine then costs those
                // apps, not the machine. Their QUIC is refused first when the engine has no UDP
                // path; nobody else's is, since nobody else goes near the engine.
                ...(app.mode === 'allow' && rejectQuic && app.rules.length ? [Object.assign({}, app.match, { protocol: 'quic', action: 'reject' })] : []),
                ...(app.mode === 'allow' ? app.rules : []),

                // THE CHOSEN SITES, to the engine, from any application.
                //
                // After the app rules and before the QUIC reject, so a browser that is not itself on
                // the list still reaches these through the engine — and so their QUIC is refused the
                // same way everything else's is when the engine cannot carry UDP.
                ...(engineDomains.length ? [{ domain_suffix: engineDomains, outbound: engineTag }] : []),

                // Reject QUIC outright when the engine has no UDP path.
                //
                // Chrome and YouTube prefer QUIC (UDP/443). Handing those packets to an
                // engine that cannot carry them means the browser waits for its own QUIC
                // timeout on every connection before falling back to TCP — which is
                // exactly the "videos take a while to start" symptom. A REJECT is seen
                // immediately and the browser switches to HTTP/2 over TCP at once, so
                // rejecting is faster than silently dropping.
                ...(rejectQuic && app.mode !== 'allow' ? [{ protocol: 'quic', action: 'reject', method: 'default' }] : []),

                // The browser's own resolver, refused so it falls back to this tunnel's.
                // See BROWSER_DOH_HOSTS. Below the process exclusion on purpose — the engine is
                // already `direct` by then and can never be caught by this.
                ...(blockAppDoh ? [
                    { domain_suffix: BROWSER_DOH_HOSTS, action: 'reject', method: 'default' },
                    // DNS-over-TLS, the same idea on its own port.
                    { port: [853], action: 'reject', method: 'default' },
                ] : []),

                // MUST stay above `ip_is_private`. See FILTER_SINKHOLE_CIDRS: a censored name
                // resolves to a private address, so the LAN rule below would send it direct.
                { ip_cidr: FILTER_SINKHOLE_CIDRS, action: 'reject' },

                // The app's own local servers and anything on the LAN.
                { ip_is_private: true, outbound: 'direct' },

                // AN ENGINE WITH NO UDP MUST NEVER BE HANDED UDP.
                //
                // The QUIC rule above only catches what sniffing RECOGNISES as QUIC. Everything
                // else on UDP — a QUIC version this build cannot parse, WebRTC, NTP, game
                // traffic — fell through to `final` and was handed to a node that cannot carry
                // a single UDP datagram (a Cloudflare Worker implements UDP for port 53 and
                // closes every other association). The packets then vanished with no error
                // anywhere: not a refusal the application could act on, a black hole.
                //
                // That is what kept YouTube shut while ordinary sites loaded. Measured from the
                // user's own run, 2026-09-12: 28 UDP/443 datagrams from chrome.exe to Google
                // addresses and NOT ONE TCP connection to them — Chrome kept retrying QUIC into
                // the hole and never fell back, while every TCP site went through the tunnel
                // perfectly (135 connections, exit verified in Germany).
                //
                // Rejecting says "no" immediately, so the browser drops to HTTP/2 over TCP at
                // once — which is exactly what a UDP-less node can carry. Placed AFTER the DNS
                // hijack (lookups still work, over TCP through the tunnel) and AFTER the LAN
                // rule (mDNS, SMB, printers and DHCP keep their UDP on the local network).
                ...(!supportsUdp ? [{ network: 'udp', action: 'reject', method: 'default' }] : []),

                // Backstop for IPv6. The adapter now captures v6 (see TUN_ADDRESS6), so
                // these packets reach us instead of escaping — but the SOCKS engine behind
                // this cannot carry them. Reject rather than forward: the application sees
                // the failure immediately and retries over IPv4, which does work. Sending
                // them to 'direct' would restore the exact leak the v6 address closes.
                { ip_version: 6, action: 'reject' },
            ],
            final: app.final || engineTag,
        },
    };
}

/**
 * Split-tunnel config: the tunnel is used only where it is the only thing that works.
 *
 * buildTunConfig() above sends everything through the proxy. That opens every site, but it
 * also drags Iranian traffic and ordinary foreign traffic across the world for no reason.
 * This variant splits by destination:
 *
 *   Iranian names/IPs        -> direct, at full local speed
 *   DNS-poisoned sites       -> direct; the honest answer from the DoH worker is the whole
 *                               fix, so no tunnel is involved and no speed is lost
 *   IP/SNI-blocked sites     -> tunnel, because nothing else reaches them
 *   sanctioned services      -> tunnel, because they refuse Iranian IPs
 *   ad/tracker hosts         -> rejected outright
 *
 * `fallback` decides the unknown case, and it is a real trade the user has to own:
 *   'direct'  fastest; a blocked site that is not on the list will not open
 *   'tunnel'  everything opens; ordinary foreign sites pay the tunnel's latency
 *
 * `dohUrl` is the user's own DoH worker. Every lookup goes there, off the tunnel, so
 * poisoned answers are gone before routing decisions are made — and the routing decisions
 * themselves stay fast because they never wait on the proxy.
 */
/**
 * Game-only routing: everything goes DIRECT except the game's own processes.
 *
 * This is the inverse of buildTunConfig(), and the inversion is the whole safety argument.
 *
 *   full tunnel   final: engine   — if the engine dies, the machine has no internet
 *   game mode     final: direct   — if the engine dies, the GAME stops working and
 *                                   nothing else even notices
 *
 * A player whose accelerator falls over mid-match should lose the match, not the internet.
 * So `final` is direct, DNS is never hijacked, and the only traffic that reaches the engine
 * is what an explicit process rule sends there. There is no leak to prevent here because
 * nothing is being hidden — this is an optimisation, not a privacy tunnel, and pretending
 * otherwise would be the dishonest kind of reuse.
 *
 * WHY THE ADAPTER IS STILL NEEDED AT ALL
 * Windows offers no way to say "send this program's UDP somewhere else" without owning the
 * packets first. auto_route pulls everything into the TUN, sing-box decides per connection,
 * and the ~all of it that is not the game is handed straight back to the physical
 * interface. That costs a userspace hop on ordinary traffic, which is the price of the
 * feature and is stated in the UI rather than hidden.
 *
 * THE RULE THAT CAN QUIETLY FAIL
 * `process_name` needs Windows to tell sing-box which process owns a socket, and it refuses
 * for some system-owned ones (logged as "failed to search process: Access is denied").
 * Games run as the user, so this normally works — but when it does not, the traffic simply
 * falls through to `final: direct` and the player is unaccelerated rather than disconnected.
 * `gameIps` exists for that case: any server address already learned is matched by address
 * as well, which needs no process lookup at all.
 */
function buildGameTunConfig(socksPort, options = {}) {
    const processName = options.processName || 'aether.exe';
    const engineTag = options.engineTag || 'engine';
    const gameProcesses = (options.gameProcesses || []).filter(Boolean);
    const gameIps = (options.gameIps || []).filter(Boolean);
    const gamePorts = options.gamePorts || [];
    const supportsUdp = options.supportsUdp !== false;
    const uplinkCidrs = [
        ...(options.uplinkCidrs || ENGINE_UPLINK_CIDRS),
        ...toHostCidrs(options.uplinkIps),
    ];
    const uplinkDomains = (options.uplinkDomains || []).filter(d => typeof d === 'string' && d.trim());

    // Matched by address, so a process lookup Windows refuses cannot silently disable the
    // whole feature. Only /32s the caller actually learned — never a guess.
    const gameIpCidrs = toHostCidrs(gameIps);

    return {
        log: { level: options.logLevel || 'warn', timestamp: true },

        // DNS is deliberately NOT hijacked. In a full tunnel every lookup must be captured
        // or it leaks; here nothing is being hidden, and taking over the machine's resolver
        // to accelerate one game would be a large blast radius for no benefit.
        dns: {
            servers: [{ type: 'udp', tag: 'local', server: '8.8.8.8' }],
            final: 'local',
            strategy: 'ipv4_only',
            cache_capacity: 2048,
        },

        inbounds: [{
            type: 'tun',
            tag: 'tun-in',
            interface_name: TUN_IFACE_NAME,
            address: [TUN_ADDRESS, TUN_ADDRESS6],
            mtu: options.mtu || TUN_MTU,
            auto_route: true,
            // false on purpose. strict_route exists to stop traffic escaping the tunnel —
            // but here almost everything is SUPPOSED to escape it. Leaving it on fights the
            // direct outbound for no gain.
            strict_route: false,
            stack: options.stack || 'gvisor',
        }],

        outbounds: [
            { type: 'socks', tag: engineTag, version: '5', server: '127.0.0.1', server_port: socksPort },
            { type: 'direct', tag: 'direct' },
        ],

        route: {
            auto_detect_interface: true,
            default_domain_resolver: { server: 'local' },
            // ORDER IS THE BEHAVIOUR — sing-box takes the first match.
            rules: [
                { action: 'sniff' },

                // The engine must never be fed its own uplink, by name or by address.
                { process_name: [processName], outbound: 'direct' },
                ...(uplinkCidrs.length ? [{ ip_cidr: uplinkCidrs, outbound: 'direct' }] : []),
                ...(uplinkDomains.length ? [{ domain_suffix: uplinkDomains, outbound: 'direct' }] : []),

                // Windows' own connectivity probe stays on the physical path, or the
                // network icon drops to "no internet" while everything actually works.
                { domain_suffix: ['msftconnecttest.com', 'msftncsi.com'], outbound: 'direct' },

                // DNS and the LAN, before anything can claim them.
                { protocol: 'dns', outbound: 'direct' },
                { ip_is_private: true, outbound: 'direct' },

                // ── the game, and nothing else ──────────────────────────────────
                ...(gameProcesses.length && supportsUdp
                    ? [{ process_name: gameProcesses, network: ['udp'], outbound: engineTag }] : []),
                ...(gameProcesses.length
                    ? [{ process_name: gameProcesses, outbound: engineTag }] : []),
                // Address fallback for the case where the process lookup is refused.
                ...(gameIpCidrs.length ? [{ ip_cidr: gameIpCidrs, outbound: engineTag }] : []),
                ...(gamePorts.length && supportsUdp
                    ? [{ network: ['udp'], port_range: gamePorts, outbound: engineTag }] : []),
            ],
            // Everything else — the browser, Windows Update, the launcher — never touches
            // the engine. This is what makes the mode safe to leave on.
            final: 'direct',
        },
    };
}

function buildSmartTunConfig(socksPort, options = {}) {
    const processName = options.processName || 'xray.exe';
    const supportsUdp = options.supportsUdp !== false;
    // Same split as the full config: a node can carry DNS over UDP and still refuse QUIC.
    const rejectQuic = options.rejectQuic !== undefined ? !!options.rejectQuic : !supportsUdp;
    const app = options.appRouting || NO_APP_ROUTING;
    const logLevel = options.logLevel || 'warn';
    const fallback = options.fallback === 'tunnel' ? 'proxy' : 'direct';
    const routes = resolveRoutes(options.overrides || {});

    // DNS through the user's worker, dialled DIRECTLY. Resolving through the tunnel would
    // put a proxy round trip in front of every new domain, and resolving through the ISP
    // would hand back the forged answers this whole feature exists to escape.
    const dohServer = options.dohUrl
        ? [{
            type: 'https',
            tag: 'doh',
            server: new URL(options.dohUrl).hostname,
            path: new URL(options.dohUrl).pathname || '/dns-query',
            domain_resolver: 'bootstrap',
        }]
        : [];
    const primaryTag = dohServer.length ? 'doh' : 'bootstrap';

    return {
        log: { level: logLevel, timestamp: true },

        dns: {
            servers: [
                ...dohServer,
                // Plain resolver, used to look up the worker's own hostname and to answer
                // Windows' connectivity probe. Never for anything filtered.
                { type: 'udp', tag: 'bootstrap', server: '1.1.1.1' },
            ],
            rules: [
                // The probe must resolve exactly as Windows expects, off any tunnel, or the
                // network icon goes to "no internet" while traffic is flowing fine.
                { domain_suffix: routes.probes, server: 'bootstrap' },
                // Iranian names resolve locally: the DoH worker would answer with the CDN
                // edge nearest to Cloudflare, not the one nearest to the user.
                { domain_suffix: ['.ir', ...routes.direct], server: 'bootstrap' },
            ],
            final: primaryTag,
            // Same reasoning as the full-tunnel config: the proxy leg is IPv4-only, so an
            // AAAA answer can only produce a connection that has to fail and retry.
            strategy: 'ipv4_only',
            // Answers are reused across the many short-lived connections a page makes.
            cache_capacity: 4096,
        },

        inbounds: [{
            type: 'tun',
            tag: 'tun-in',
            interface_name: TUN_IFACE_NAME,
            address: [TUN_ADDRESS, TUN_ADDRESS6],
            mtu: options.mtu || TUN_MTU,
            auto_route: true,
            strict_route: true,
            // "system" hands packets to the OS stack instead of reimplementing TCP in
            // userspace, which is materially faster for bulk transfer. It needs privileges
            // this app already has (requireAdministrator), and startTun falls back to
            // gvisor automatically if sing-box refuses it — so the fast path is the default
            // and the safe path is still reachable.
            stack: options.stack || 'system',
        }],

        outbounds: [
            { type: 'socks', tag: 'proxy', version: '5', server: '127.0.0.1', server_port: socksPort },
            { type: 'direct', tag: 'direct' },
        ],

        route: {
            auto_detect_interface: true,
            default_domain_resolver: { server: 'bootstrap' },
            // ORDER IS THE BEHAVIOUR. sing-box takes the first matching rule, so a rule
            // placed below a broader one is dead weight. Do not reshuffle.
            rules: [
                { action: 'sniff' },

                // The proxy engine's own traffic must never re-enter the tunnel it feeds.
                { process_name: [processName], outbound: 'direct' },

                // Same exclusion by address, for when Windows refuses the process lookup.
                // Harmless when the engine here is not Aether: nothing else dials these.
                { ip_cidr: ENGINE_UPLINK_CIDRS, outbound: 'direct' },

                // «مسیر برنامه‌ها», bypass — as in the full tunnel: nothing of theirs enters.
                ...(app.mode === 'bypass' ? app.rules : []),

                // Windows connectivity probe, before anything else can touch it.
                { domain_suffix: routes.probes, outbound: 'direct' },

                // Capture DNS so nothing escapes in cleartext to the ISP resolver.
                { protocol: 'dns', action: 'hijack-dns' },

                // «مسیر برنامه‌ها», only the chosen apps: they take the tunnel whatever the smart
                // lists would have said; everything else ends on 'direct' (see `final`).
                ...(app.mode === 'allow' && rejectQuic && app.rules.length ? [Object.assign({}, app.match, { protocol: 'quic', action: 'reject' })] : []),
                ...(app.mode === 'allow' ? app.rules : []),

                // Same trap as the full-tunnel config, and worse here: this mode sends Iranian
                // destinations direct on purpose, so a poisoned answer blends in perfectly.
                { ip_cidr: FILTER_SINKHOLE_CIDRS, action: 'reject' },

                // LAN, loopback, and this app's own local servers.
                { ip_is_private: true, outbound: 'direct' },

                // Ads and trackers: refused, not tunnelled. Cheapest speed win there is.
                ...(routes.block.length ? [{ domain_suffix: routes.block, action: 'reject' }] : []),

                // Iran: direct. The .ir TLD plus the services that live on other TLDs.
                { domain_suffix: ['.ir', ...routes.direct], outbound: 'direct' },

                // Blocked and sanctioned: the tunnel is the only thing that reaches these.
                ...(routes.tunnel.length ? [{ domain_suffix: routes.tunnel, outbound: 'proxy' }] : []),

                // QUIC to a UDP-less engine stalls the browser for a full timeout on every
                // connection. Rejecting is seen at once and it falls back to TCP.
                ...(rejectQuic ? [{ protocol: 'quic', action: 'reject' }] : []),

                // Last, so the direct rules above still cover Iranian and LAN traffic on
                // v6. Everything left would otherwise fall through to `final` — and when
                // `final` is 'direct' that is a leak, while when it is 'proxy' it is a
                // connection the IPv4-only engine cannot carry. Rejecting is correct either
                // way: the application retries over IPv4 immediately.
                { ip_version: 6, action: 'reject' },
            ],
            final: app.final || fallback,
        },
    };
}

// ── liveness ──────────────────────────────────────────────────────────────────
// "Is the tunnel up?" has three separable answers, and conflating them is what produced a
// green UI over a dead tunnel. Each is checked against the operating system, never against
// our own bookkeeping:
//
//   process   sing-box is alive          — necessary, nowhere near sufficient
//   adapter   the Wintun device exists and is Up
//   route     the machine's default route actually points at that adapter
//
// The third is the one that matters. A tunnel can have a live process and a live adapter
// while Windows sends every packet out Wi-Fi — that is a leak wearing a green badge.

function psJson(script, timeoutMs = 12000) {
    return new Promise((resolve) => {
        require('child_process').execFile('powershell', [
            '-NoProfile', '-NonInteractive', '-Command', script,
        ], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
            if (err) return resolve(null);
            try { resolve(JSON.parse(String(stdout).trim() || 'null')); } catch (e) { resolve(null); }
        });
    });
}

/**
 * What Windows currently believes about our adapter and the default route.
 * Returns { adapter: bool, adapterUp: bool, defaultViaTun: bool, defaultVia: string }.
 */
/**
 * What the tunnel is really doing, right now, written into its own log.
 *
 * `verifyTunCarriesTraffic` proves ONE download arrives. It does not say whether the route is
 * still ours a minute later, whether names still resolve, or — the question that matters most
 * — whether the traffic is leaving through the NODE or straight out of the user's own line.
 * Both bugs found on 2026-09-12 (a rule with no conditions, and the tunnel that came up and
 * carried nothing) would have been named in one line by this report; instead each took an
 * afternoon of reading artefacts after the fact.
 *
 * Never throws and never changes anything: a diagnosis that can break the thing it diagnoses
 * is worse than no diagnosis.
 */
async function tunVerdict(onLog, { uplinkDomains = [] } = {}) {
    // Which arrangement is being judged. In «only these applications» mode everything else is
    // SUPPOSED to leave on the real interface, so the exit line below must not call that a leak —
    // and this probe is not one of the listed applications.
    let allowMode = null;
    try {
        const r = require('./app-routing').tunRules('engine', '');
        if (r.mode === 'allow') allowMode = r.count;
    } catch (e) { /* judge it as a full tunnel */ }
    const https = require('https');
    const dns = require('dns');
    const say = (line) => { writeTunLog(line); if (onLog) onLog(`[TUN] ${line}`); };

    // 1. Is the machine's default route still ours?
    try {
        const live = await checkLive();
        say(`verdict route: ${live.verdict} (default via «${live.defaultVia || '?'}»)`);
    } catch (e) { say(`verdict route: بررسی نشد (${e.message})`); }

    // 2. The engine's OWN server name. If this cannot resolve, the engine cannot open another
    //    connection and the tunnel stalls silently — no error anywhere, which is exactly what
    //    "the tunnel is on and nothing happens" looks like from the outside.
    // dns.lookup, not dns.resolve4: lookup goes through the OPERATING SYSTEM resolver, which
    // is the path xray.exe itself takes. resolve4 talks to the configured servers directly and
    // would answer a question nobody is asking.
    for (const name of uplinkDomains.slice(0, 2)) {
        await new Promise((resolve) => {
            const started = Date.now();
            dns.lookup(name, { family: 4, all: true }, (err, addrs) => {
                say(err ? `verdict uplink-dns ${name}: ❌ ${err.code || err.message} (${Date.now() - started}ms)`
                        : `verdict uplink-dns ${name}: ✅ ${addrs.slice(0, 2).map(a => a.address).join(',')} (${Date.now() - started}ms)`);
                resolve();
            });
        });
    }

    // 3. A NAME THAT IS POISONED ON THIS LINE, resolved the way an application resolves it.
    //
    // This is the check that separates "the tunnel carries nothing" from "the tunnel carries
    // everything except what you turned it on for". If a filtered name comes back as a sinkhole
    // address, lookups are being answered OUTSIDE the tunnel and every filtered site will fail
    // while ordinary ones load — which reads, from the outside, as "only my browser is broken".
    //
    // dns.lookup and not dns.resolve4, for the same reason as above: lookup is the operating
    // system's path, which is the one applications take.
    await new Promise((resolve) => {
        const started = Date.now();
        dns.lookup('www.youtube.com', { family: 4, all: true }, (err, addrs) => {
            if (err) {
                say(`verdict dns-filtered: ❌ ${err.code || err.message} (${Date.now() - started}ms)`);
                return resolve();
            }
            const got = addrs.map(a => a.address);
            const sunk = got.filter(a => FILTER_SINKHOLE_CIDRS.some(c => a.startsWith(c.replace(/\.\d+\/\d+$/, '.'))));
            say(sunk.length
                ? `verdict dns-filtered: ⚠️ ${got.join(',')} — آدرس چاهک است، یعنی اسم‌ها بیرون تونل جواب داده می‌شوند و سایت‌های فیلترشده باز نمی‌شوند (${Date.now() - started}ms)`
                : `verdict dns-filtered: ✅ ${got.slice(0, 2).join(',')} (${Date.now() - started}ms)`);
            resolve();
        });
    });

    // 4. A name that only resolves correctly through the tunnel, fetched by name.
    // 5. …and the address the far end sees, which is the only proof that the traffic really
    //    left through the node rather than through the user's own connection.
    // cloudflare.com/cdn-cgi/trace, NOT speed.cloudflare.com/meta: measured from this line,
    // /meta answers 403 to an Iranian address (sanctions) while /cdn-cgi/trace answers 200 —
    // and a probe that fails for everyone tells nobody anything.
    await new Promise((resolve) => {
        const started = Date.now();
        const req = https.get('https://www.cloudflare.com/cdn-cgi/trace',
            { timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
                res.on('end', () => {
                    const ip = (body.match(/^ip=(.+)$/m) || [])[1] || '?';
                    const loc = (body.match(/^loc=(.+)$/m) || [])[1] || '?';
                    say(allowMode !== null
                        ? `verdict exit: ${ip} (${loc}) در ${Date.now() - started}ms — «مسیر برنامه‌ها» روی ${allowMode} برنامه است، پس این آزمون عمداً مستقیم می‌رود و همین آیپی خودتان درست است`
                        : `verdict exit: ${ip} (${loc}) در ${Date.now() - started}ms — اگر این همان آیپی اینترنت خودتان باشد، ترافیک از تونل رد نمی‌شود`);
                    resolve();
                });
            });
        req.on('timeout', () => { req.destroy(); say(`verdict exit: ❌ مهلت تمام شد (${Date.now() - started}ms)`); resolve(); });
        req.on('error', (e) => { say(`verdict exit: ❌ ${e.message} (${Date.now() - started}ms)`); resolve(); });
    });
}

async function inspectAdapter() {
    const r = await psJson(`
$a = Get-NetAdapter -Name '${TUN_IFACE_NAME}' -ErrorAction SilentlyContinue
$best = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object { $_.RouteMetric + $_.InterfaceMetric } | Select-Object -First 1
[pscustomobject]@{
  adapter   = [bool]$a
  adapterUp = if ($a) { $a.Status -eq 'Up' } else { $false }
  defaultVia = if ($best) { [string]$best.InterfaceAlias } else { '' }
} | ConvertTo-Json -Compress`);
    // «COULD NOT ASK» IS NOT «IT IS GONE», AND CONFLATING THEM COST THE USER THEIR CONNECTION.
    //
    // psJson resolves null for every failure: a PowerShell that exceeded its timeout, a WMI
    // service busy because the network stack is being reconfigured (which is precisely what
    // happens while a tunnel comes up), a spawn refused under load. This used to return
    // adapter:false for all of those, the watchdog read it as `adapter-gone`, and one flaky
    // probe tore down a perfectly healthy tunnel, engaged the kill switch and rebuilt it —
    // every five seconds, for as long as the machine stayed busy. That is the «مدام قطع و وصل
    // می‌شود» report, produced entirely by the health check rather than by the tunnel.
    //
    // So the failure to answer is now its own state, and every caller decides what to do with
    // it. Nobody may treat it as a verdict.
    if (!r) return { unknown: true, adapter: false, adapterUp: false, defaultViaTun: false, defaultVia: '' };
    return {
        adapter: !!r.adapter,
        adapterUp: !!r.adapterUp,
        defaultVia: r.defaultVia || '',
        defaultViaTun: (r.defaultVia || '') === TUN_IFACE_NAME,
    };
}

// ── the same three questions, without spawning anything ───────────────────────────────────────
//
// inspectAdapter() above starts a PowerShell and two CIM queries. That is fine once, on a
// transition; it is not fine every five seconds for the whole life of a tunnel, which is what
// the watchdog was doing — a process launch plus WMI round trip, on the machine whose speed is
// being complained about, in the Electron MAIN thread where a slow callback stalls the engine's
// log pipe as well.
//
// Both facts are available to Node directly:
//
//   · the adapter — os.networkInterfaces() lists every interface that holds an address, and
//     ours holds a known one (TUN_ADDRESS). Present with that address = created and up.
//   · the default route — connect() on a UDP socket picks a source address by consulting the
//     routing table and SENDS NOTHING. The address it picks IS the answer to "which interface
//     would this machine use to reach the internet right now".
//
// Measured on this machine: ~0.3 ms for both, against 300–1500 ms for the PowerShell path.
const TUN_LOCAL_IP = TUN_ADDRESS.split('/')[0];

/** Every local IPv4 address, by interface name — used to name whoever owns the default route. */
function localAddressMap() {
    const out = new Map();
    let ifaces = {};
    try { ifaces = require('os').networkInterfaces(); } catch (e) { return out; }
    for (const name of Object.keys(ifaces)) {
        for (const addr of ifaces[name] || []) {
            if (addr && addr.family === 'IPv4' && addr.address) out.set(addr.address, name);
        }
    }
    return out;
}

/**
 * Which local address the machine would use to reach `host` — i.e. which interface currently
 * owns the route to the internet. Resolves null when the OS refuses to answer.
 */
function sourceAddressFor(host = '8.8.8.8') {
    return new Promise((resolve) => {
        let sock;
        let settled = false;
        const done = (v) => { if (settled) return; settled = true; try { sock.close(); } catch (e) {} resolve(v); };
        try { sock = require('dgram').createSocket('udp4'); } catch (e) { return resolve(null); }
        sock.on('error', () => done(null));
        const timer = setTimeout(() => done(null), 1500);
        if (timer.unref) timer.unref();
        try {
            sock.connect(53, host, () => {
                clearTimeout(timer);
                try { done(sock.address().address || null); } catch (e) { done(null); }
            });
        } catch (e) { done(null); }
    });
}

/** The fast verdict, or { ok:false } when it could not be taken. Never spawns. */
async function fastLive() {
    const addrs = localAddressMap();
    // By address, not by name. 172.19.0.1 belongs to this tunnel and to nothing else on the
    // machine, while the NAME Windows reports for an interface is not always the one sing-box
    // asked for — and a name that does not match would send every tick down the slow path.
    const adapter = addrs.has(TUN_LOCAL_IP);
    const src = await sourceAddressFor();
    if (!src) return { ok: false };
    return {
        ok: true,
        adapter, adapterUp: adapter,
        defaultViaTun: src === TUN_LOCAL_IP,
        defaultVia: addrs.get(src) || src,
        source: src,
    };
}

// Public resolvers never get excluded from the tunnel, whatever the routing table says about
// them. A /32 pin for one of these is usually the modem's or another app's doing, and sending
// port 53 out in the clear is the exact leak this whole file exists to close.
const NEVER_EXCLUDE = new Set([
    '1.1.1.1', '1.0.0.1', '8.8.8.8', '8.8.4.4', '9.9.9.9', '149.112.112.112',
    '208.67.222.222', '208.67.220.220', '94.140.14.14', '94.140.15.15',
]);

/**
 * Host routes another tunnel pinned to the physical line — the addresses IT rides on.
 *
 * THE TUNNEL MUST NOT SWALLOW THE UPLINK OF THE TUNNEL IT IS RIDING ON. This is the same rule
 * the engine's own /32 exclusion follows, one level down. When the machine's internet already
 * goes through another VPN — «گیت‌وی MLM», or any third-party client — that VPN keeps working
 * only because it pinned its own server to the real gateway with a /32 route. Our auto_route
 * covers everything less specific than that, so the pin survives the routing table… and then
 * the packets are captured anyway the moment `strict_route` starts filtering, or the moment
 * that VPN re-dials and its new address is not pinned yet. Either way the line underneath dies,
 * every connection with it, and the app rebuilds a tunnel over a link that is no longer there —
 * which is what a user sees as «مدام قطع و وصل می‌شود».
 *
 * Excluding them explicitly, by address, is what keeps the floor under the tunnel.
 */
async function pinnedHostRoutes() {
    const r = await psJson(`
Get-NetRoute -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.DestinationPrefix -like '*/32' -and $_.NextHop -ne '0.0.0.0' -and $_.InterfaceAlias -ne '${TUN_IFACE_NAME}' } |
  ForEach-Object { $_.DestinationPrefix -replace '/32','' } | ConvertTo-Json -Compress`, 8000);
    const list = r === null ? [] : (Array.isArray(r) ? r : [r]);
    return list
        .map(x => String(x || '').trim())
        .filter(ip => /^\d{1,3}(\.\d{1,3}){3}$/.test(ip))
        .filter(ip => !NEVER_EXCLUDE.has(ip))
        // Private, loopback and link-local pins are already `direct` by the LAN rule, and
        // 0.0.0.0 is not an address. Only public ones are worth a rule of their own.
        .filter(ip => !/^(10\.|127\.|169\.254\.|192\.168\.|0\.)/.test(ip) && !/^172\.(1[6-9]|2\d|3[01])\./.test(ip));
}

/**
 * Who owns the machine's route to the internet right now, as a name.
 *
 * Used before a tunnel is built, to say out loud that another VPN is already carrying this
 * machine — stacking a tunnel on top of a free relay is the difference between «کند است» and
 * «کند است چون زیرش یک تونل دیگر هم هست», and nothing in the app used to mention it.
 */
async function currentDefaultInterface() {
    const src = await sourceAddressFor();
    if (!src) return null;
    return { address: src, name: localAddressMap().get(src) || src };
}

/**
 * Remove an adapter left behind by a run that did not shut down cleanly.
 *
 * Naming the adapter made it findable, and introduced a failure I had not anticipated: if one
 * already exists, sing-box cannot create its own and dies instantly with
 *
 *     FATAL start service: start inbound/tun[tun-in]:
 *           configure tun interface: Cannot create a file when that file already exists.
 *
 * and the readiness check then FOUND THE STALE ADAPTER, saw the default route still pointed at
 * it, and reported success. The machine was left routing everything into a Wintun device whose
 * owner was dead — every packet black-holed, no error on screen, and the only escape was
 * closing the whole app. That is strictly worse than the race it replaced, so the adapter is
 * cleared before every start.
 */
async function removeStaleAdapter(onLog) {
    const s = await inspectAdapter();
    // `unknown` means the question could not be asked, and the cleanup below is harmless when
    // there is nothing to clean — while skipping it on a probe failure risks the worst state this
    // function exists to prevent (a live adapter nobody owns, holding the default route).
    if (!s.adapter && !s.unknown) return false;
    if (onLog && s.adapter) onLog(`[TUN] آداپتور «${TUN_IFACE_NAME}» از اجرای قبلی باقی مانده بود — حذف می‌شود.`);
    await new Promise((resolve) => {
        require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='SilentlyContinue'
Get-NetRoute -InterfaceAlias '${TUN_IFACE_NAME}' | Remove-NetRoute -Confirm:$false
Get-NetAdapter -Name '${TUN_IFACE_NAME}' | Disable-NetAdapter -Confirm:$false
`], { timeout: 20000, windowsHide: true }, () => resolve());
    });
    return true;
}

/**
 * Poll until OUR sing-box has the adapter up and owning the default route.
 *
 * The process check is inside the loop and comes first on purpose: a stale adapter satisfies
 * every network-level condition here, so without proof that our own process is alive this
 * function happily certifies someone else's leftovers as a working tunnel.
 */
async function waitForReady(timeoutMs = TUN_READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let last = 'مهلت تمام شد';
    while (Date.now() < deadline) {
        if (!isRunning()) return { ok: false, reason: 'موتور تونل بلافاصله بسته شد' };
        // The fast probe, not PowerShell. This loop runs every 250 ms: the old version started a
        // PowerShell and two CIM queries on each turn, so a slow start meant up to sixty process
        // launches and sixty WMI round trips — issued at the exact moment Windows is rebuilding
        // its routing table, which is when WMI is slowest and most likely to time out. The
        // answers are identical; only the cost is different.
        const s = await fastLive();
        if (s.ok && s.adapterUp && s.defaultViaTun) return { ok: true, state: s };
        last = !s.ok ? 'وضعیت آداپتور از ویندوز خوانده نشد'
            : !s.adapter ? 'آداپتور تونل ساخته نشد'
            : !s.adapterUp ? 'آداپتور ساخته شد ولی بالا نیامد'
            : `مسیر پیش‌فرض هنوز از «${s.defaultVia || 'نامشخص'}» می‌رود، نه از تونل`;
        await new Promise(r => setTimeout(r, TUN_READY_POLL_MS));
    }
    if (!isRunning()) return { ok: false, reason: 'موتور تونل بسته شد' };
    // One authoritative look before giving up: the whole start fails on this answer, and the fast
    // probe reads only addresses — an adapter that is up with no address, or a route installed
    // without one, would be invisible to it.
    const confirmed = await inspectAdapter();
    if (!confirmed.unknown && confirmed.adapterUp && confirmed.defaultViaTun) return { ok: true, state: confirmed };
    return { ok: false, reason: last };
}

/**
 * Full liveness verdict, safe to call at any time.
 *
 * `degraded` is deliberately distinct from `down`: a tunnel whose process is alive but whose
 * route has been stolen (another VPN came up, the adapter was reset on resume) needs a
 * different response from one whose process is gone, and the caller cannot pick the right
 * one if both arrive as a bare false.
 */
async function checkLive() {
    const proc = isRunning();
    // Our own process handle needs nobody's permission and cannot be wrong.
    if (!proc) {
        return { healthy: false, process: false, adapter: false, adapterUp: false,
            defaultViaTun: false, defaultVia: '', verdict: 'process-dead' };
    }

    // The cheap answer first. When it says everything is fine, it IS fine: both facts it
    // checks are the same facts Windows would report, read from the same tables.
    const fast = await fastLive();
    if (fast.ok && fast.adapterUp && fast.defaultViaTun) {
        return { healthy: true, process: true, adapter: true, adapterUp: true,
            defaultViaTun: true, defaultVia: TUN_IFACE_NAME, verdict: 'healthy', via: 'fast' };
    }

    // Anything else is a claim that the tunnel is broken, and that claim ends with the machine's
    // kill switch being thrown — so it is confirmed against Windows itself before it is believed.
    const s = await inspectAdapter();
    if (s.unknown) {
        return { healthy: null, unknown: true, process: true,
            adapter: fast.ok ? fast.adapter : false, adapterUp: fast.ok ? fast.adapterUp : false,
            defaultViaTun: fast.ok ? fast.defaultViaTun : false,
            defaultVia: fast.ok ? fast.defaultVia : '', verdict: 'unknown' };
    }
    const healthy = s.adapterUp && s.defaultViaTun;
    return {
        healthy,
        process: proc,
        adapter: s.adapter,
        adapterUp: s.adapterUp,
        defaultViaTun: s.defaultViaTun,
        defaultVia: s.defaultVia,
        via: 'confirmed',
        verdict: healthy ? 'healthy'
            : !s.adapter ? 'adapter-gone'
            : !s.adapterUp ? 'adapter-down'
            : 'route-stolen',
    };
}

/**
 * Bring the TUN adapter up. Requires Administrator, which this app already has
 * (build.win.requestedExecutionLevel = requireAdministrator).
 */
// ── Byte counters, for live speed and daily usage (traffic-feed.js) ──────────────────
//
// Everything the tunnel carries passes through sing-box, so it is the one place that can
// count for an engine with no counter of its own — the WARP engines behind the tunnel.
// (Xray and the Google Script core count their own bytes; traffic-feed prefers them.) Its
// clash API serves the figures. It listens on a loopback port picked free at each start and
// wants a secret made at each start, so no other program on the machine can read or steer
// it; only /connections is ever asked for.
//
// WHAT IS COUNTED. sing-box's grand totals count every byte twice: once as the app's own
// connection going into the engine, and again as the engine's encrypted uplink, which also
// comes back through the adapter and leaves on 'direct' (see the process_name rule). So the
// figure is the engine's uplink — its connections, picked out the same two ways the routing
// picks them out: by process, and by the uplink addresses. That is what the line actually
// carried, and in game mode it is the game's traffic only, not everything else on the machine.
// The uplink is one long-lived flow, so following it connection by connection loses nothing.
// If no uplink connection is ever seen (an engine that pins its socket to the physical
// adapter never enters the tunnel), nothing is counted twice either, and the grand totals
// are used as they are.
let countersApi = null;   // { port, secret, isUplink, seen, up, down, sawUplink } for the running process

/** A test for "is this connection the engine's own uplink", built from the same inputs as its routing rule. */
function uplinkMatcher(processName, options = {}) {
    const exeNames = processNames(processName, '');
    const block = new net.BlockList();
    for (const cidr of [...(options.uplinkCidrs || ENGINE_UPLINK_CIDRS), ...toHostCidrs(options.uplinkIps)]) {
        const [addr, bits] = String(cidr).split('/');
        const type = net.isIPv6(addr) ? 'ipv6' : net.isIPv4(addr) ? 'ipv4' : null;
        if (!type) continue;
        try { block.addSubnet(addr, Number(bits), type); } catch (e) { /* a malformed entry is skipped, not fatal */ }
    }
    return (conn) => {
        if (!conn || !Array.isArray(conn.chains) || !conn.chains.includes('direct')) return false;
        const md = conn.metadata || {};
        // "C:\…\aether.exe", sometimes followed by " (user)".
        const proc = String(md.processPath || '').replace(/\s*\([^)]*\)\s*$/, '').split(/[\\/]/).pop().toLowerCase();
        if (proc && exeNames.includes(proc)) return true;
        const ip = String(md.destinationIP || '');
        const type = net.isIPv6(ip) ? 'ipv6' : net.isIPv4(ip) ? 'ipv4' : null;
        return !!type && block.check(ip, type);
    };
}

/**
 * Fold one /connections snapshot into the running totals and return { up, down } — the
 * uplink's bytes once it has been seen, the grand totals before that. Exported for testing.
 */
/**
 * The tunnel's byte totals, from sing-box's own connection table.
 *
 * TWO SERIES, AND SAYING WHICH ONE. `api.up/down` accumulate only the ENGINE'S OWN uplink — the
 * connections sing-box sent `direct` because they belong to the engine process. Those are the
 * bytes that actually crossed the wire, and counting them avoids double-counting the same
 * payload once as the application's tunnelled traffic and again as the engine carrying it.
 *
 * `sawUplink` USED TO BE STICKY, AND THAT MADE THE COUNTER LIE. Once any engine connection had
 * been seen, this function committed to the uplink series for ever — and for a domain-fronted
 * engine that series is nearly always empty, because meek's uplink is a stream of short HTTP
 * round trips that are rarely open at the instant of a sample. Measured live on 2026-09-19 with
 * سایفون carrying six connections, 11.6 MB up and 2.5 MB down through the adapter:
 *
 *     front-speed  engineDown=0.11  tunDown=0.00
 *     speed window=60s  down=0.00 up=0.00 peak=0.00
 *     stall idle=20s :: تونل بالاست ولی ۲۰ ثانیه است هیچ بایتی رد نشده
 *
 * A working tunnel, reported as carrying nothing, with a stall warning on top — and every
 * consumer of this number believed it: the live speed display, the diary, the stall detector and
 * the leak check, which compares these bytes against the engine's own.
 *
 * So the choice is made per snapshot, and the series that produced the answer is named. A caller
 * that computes deltas MUST drop the one where `series` changed: the two counters are unrelated
 * magnitudes, and subtracting across a switch invents traffic that never happened.
 */
function tallyCounters(api, snapshot) {
    const next = new Map();
    let sawUplink = false;
    for (const conn of (snapshot && snapshot.connections) || []) {
        if (!api.isUplink(conn)) continue;
        const up = Number(conn.upload) || 0;
        const down = Number(conn.download) || 0;
        const prev = api.seen.get(conn.id) || { up: 0, down: 0 };
        api.up += Math.max(0, up - prev.up);
        api.down += Math.max(0, down - prev.down);
        next.set(conn.id, { up, down });
        sawUplink = true;
    }
    api.seen = next;
    // Kept for the leak check, which wants to know whether the engine's uplink is visible at all
    // on this platform — an engine whose process sing-box cannot name never appears here.
    api.sawUplink = api.sawUplink || sawUplink;
    if (sawUplink) return { up: api.up, down: api.down, series: 'uplink' };
    return {
        up: Number(snapshot && snapshot.uploadTotal) || 0,
        down: Number(snapshot && snapshot.downloadTotal) || 0,
        series: 'total',
    };
}

function freeLoopbackPort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/**
 * THE LAST THING BETWEEN A BUILDER'S BUG AND A TOTAL LEAK.
 *
 * A sing-box routing/DNS rule is a set of conditions. A rule whose condition lists are all
 * EMPTY has no conditions at all — and a rule with no conditions matches EVERYTHING. There is
 * no warning: `sing-box check` accepts it, the engine starts, and the rule quietly becomes a
 * catch-all at whatever position it sits in.
 *
 * That shipped. `{ ip_cidr: uplinkCidrs, outbound: 'direct' }` was emitted unconditionally,
 * and `uplinkCidrs` is empty for every config whose address is a NAME instead of a clean IP —
 * most Cloudflare configs. Third in the list, it sent the entire tunnel to `direct`:
 *   · ordinary sites kept working, so the 256 KB payload check passed and the switch went green
 *   · filtered sites were reset by the ISP the moment they left in the clear
 *     (sing-box log: raw-read tcp 192.168.8.6:…->142.251.155.4:443 … forcibly closed)
 *   · and «تونل کامل — بدون نشتی» was on over a connection carrying the user's real address.
 *
 * Each site that builds such a rule guards it now, but a guard that must be remembered every
 * time is not a guarantee. This runs over the finished config and removes any rule that has
 * no condition left, so the failure can only ever be "one exclusion missing" — never "the
 * tunnel is a passthrough". `action`/`outbound`/`server`/`invert`/`network`-only rules are not
 * conditions on their own; anything else present means the rule really is conditioned.
 */
// What a rule DOES, as opposed to what it matches. None of these count as a condition.
const RULE_VERBS = new Set(['action', 'outbound', 'server', 'invert', 'strategy',
    'disable_cache', 'rewrite_ttl', 'client_subnet', 'override_address', 'override_port']);

// Actions that are meant to apply to everything and decide nothing about where traffic goes.
// `sniff` is written exactly that way at the top of every config here, on purpose, and
// removing it would break domain matching for every rule under it.
const HARMLESS_UNCONDITIONAL = new Set(['sniff', 'resolve']);

function dropConditionlessRules(cfg, onDrop) {
    if (!cfg) return cfg;
    const clean = (rules) => (Array.isArray(rules) ? rules.filter((rule) => {
        if (!rule || typeof rule !== 'object') return false;
        // `rules` inside a logical rule: keep, its children carry the conditions.
        if (Array.isArray(rule.rules) && rule.rules.length) return true;
        const conditioned = Object.keys(rule).some((k) => {
            if (RULE_VERBS.has(k)) return false;
            const v = rule[k];
            return Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '';
        });
        if (conditioned) return true;
        // Unconditional AND harmless: it routes nothing, so it is doing what it says.
        if (!rule.outbound && !rule.server && HARMLESS_UNCONDITIONAL.has(rule.action)) return true;
        if (typeof onDrop === 'function') {
            onDrop(`[TUN] ⚠️ قانون بدون شرط حذف شد (با همه‌چیز مطابقت می‌کرد): ${JSON.stringify(rule)}`);
        }
        return false;
    }) : rules);

    if (cfg.route && cfg.route.rules) cfg.route.rules = clean(cfg.route.rules);
    if (cfg.dns && cfg.dns.rules) cfg.dns.rules = clean(cfg.dns.rules);
    return cfg;
}

function withCounters(cfg) {
    if (!countersApi || !cfg) return cfg;
    cfg.experimental = Object.assign({}, cfg.experimental, {
        clash_api: { external_controller: `127.0.0.1:${countersApi.port}`, secret: countersApi.secret },
    });
    return cfg;
}

/** { up, down } bytes since the tunnel started, or null when it cannot say. See tallyCounters. */
function readTrafficCounters() {
    const api = countersApi;
    if (!api || !isRunning()) return Promise.resolve(null);
    return new Promise((resolve) => {
        const req = http.get({
            host: '127.0.0.1', port: api.port, path: '/connections', timeout: 900,
            headers: { Authorization: `Bearer ${api.secret}` },
        }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => {
                if (res.statusCode !== 200) return resolve(null);
                try { resolve(tallyCounters(api, JSON.parse(body))); } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
    });
}

// The arguments of the last start, so a setting that lives in the config (per-app routing) can
// be applied to a running tunnel by building it again — see rebuild().
let lastStartArgs = null;

/**
 * Build the running tunnel again from its last start, to pick up a changed setting. The engines
 * that carry their own rebuild (WARP refreshes its uplink, V2Ray re-measures its node) use that
 * instead; this is for the rest. False when nothing is running to rebuild.
 */
/** The engine process behind the running tunnel ('xray.exe', 'aether.exe', 'gst.exe', …), or null. */
function currentEngine() {
    if (!isRunning() || !lastStartArgs) return null;
    return processNames(lastStartArgs.options && lastStartArgs.options.processName, 'aether.exe')[0];
}

/**
 * What the running tunnel is made of: the engine's SOCKS port, its label, the stack and MTU it
 * was built with. The speed report needs the port to measure the engine WITHOUT the tunnel, and
 * the rest so the number it produces says which arrangement produced it.
 */
function currentTunnel() {
    if (!isRunning() || !lastStartArgs) return null;
    const o = lastStartArgs.options || {};
    return {
        socksPort: lastStartArgs.socksPort,
        engine: currentEngine(),
        label: o.engineLabel || 'موتور',
        mode: o.mode || 'full',
        mtu: o.mtu || null,
        logLevel: o.logLevel || 'warn',
    };
}

async function rebuild(onLog) {
    const last = lastStartArgs;
    if (!last || !isRunning()) return false;
    stopTun(onLog || last.onLog);
    await startTun(last.socksPort, onLog || last.onLog, last.options);
    return true;
}

async function startTun(socksPort, onLog, options = {}) {
    lastStartArgs = { socksPort, onLog, options };
    // Which engine owns this SOCKS port. Used for the exclusion rule (loop prevention)
    // and so the log lines name the engine the user actually turned on.
    const exeNames = processNames(options.processName, 'aether.exe');
    // The FIRST name is "the engine" for everything that needs a single one: the MTU table, the
    // per-app routing rules, and the game and split builders. The full list only matters to the
    // exclusion rule, which is the one place where missing a second process reopens the loop.
    const processName = exeNames[0];
    const engineLabel = options.engineLabel || 'وارپ';
    const supportsUdp = options.supportsUdp !== false;

    if (isRunning()) {
        onLog('[TUN] از قبل روشن است.');
        return;
    }
    checkPrerequisites();

    if (!(await portIsLive(socksPort))) {
        throw new Error(
            `موتور ${engineLabel} اجرا نیست (پورت ${socksPort} خالی است). ` +
            'اول موتور را وصل کنید، بعد تونل را روشن کنید — وگرنه کل اینترنت سیستم قطع می‌شود.'
        );
    }

    // Three attempts, not one.
    //
    // A single refused connection is not proof of a dead data path. The engine's SOCKS
    // listener can momentarily have nothing left to give — a burst of DNS, a QUIC
    // connection migrating, the gateway on this line answering at 1.7s RTT — and the
    // failure mode looks identical to a genuinely broken tunnel ("io: early eof"). Refusing
    // to start on the first miss is what left the user unable to turn the tunnel on at all
    // while, measured moments later on a quiet port, the very same probe passed in 247ms.
    //
    // Still fails closed: three misses in a row IS a dead data path, and starting TUN over
    // one would take the machine offline with no way back.
    // 15 s per attempt, not 8. Through MASQUE on a lossy Iranian line one plain request takes
    // 0.25 s usually but 5–8 s when a SYN is lost twice (measured, 2026-09-11) — a healthy
    // tunnel that an 8 s limit failed three times in a row.
    // THE LOG OPENS HERE, NOT AFTER THE PROBE.
    //
    // It used to open next to the spawn, several checks further down — so the single most
    // common failure, this pre-flight probe, left NOTHING behind: no tun.log, no tun-config,
    // no sing-box. The user saw "data does not pass" and the only way to investigate was to
    // reproduce it while watching. Every attempt is recorded from its first line now.
    openTunLog(`preflight engine=${engineLabel} process=${options.processName || 'aether.exe'} ` +
        `socks=${socksPort} mode=${options.mode || 'full'} udp=${supportsUdp} ` +
        `uplinkIps=${(options.uplinkIps || []).join(',') || '-'} ` +
        `uplinkDomains=${(options.uplinkDomains || []).join(',') || '-'} ` +
        `dnsBridge=${dnsBridgeState()}`);

    // WHO IS ALREADY CARRYING THIS MACHINE?
    //
    // A tunnel built on top of another VPN inherits that VPN's speed and every one of its
    // drop-outs, and the user has no way to see it: both are "connected", the app only knows
    // about its own, and the result reads as «هر روشی را امتحان می‌کنم کند و قطع‌وصل است» —
    // because the slow thing is underneath all of them. «گیت‌وی MLM» does exactly this (the
    // SoftEther client owns its own adapter and takes the default route), and so does any
    // third-party VPN the user left running. One line, before anything else happens.
    let stackedUnder = null;
    try {
        const owner = await currentDefaultInterface();
        if (owner && owner.name && owner.name !== TUN_IFACE_NAME) {
            const virtualish = /vpn|tap|tun|wireguard|wintun|softether|openvpn|proton|nord|express|zero ?tier|tailscale/i.test(owner.name);
            if (virtualish) stackedUnder = owner;
            const line = `اینترنت این ماشین همین حالا از «${owner.name}» (${owner.address}) می‌رود` +
                (virtualish
                    ? ' — یعنی یک وی‌پی‌ان/تونل دیگر از قبل روشن است و این تونل روی آن سوار می‌شود. سرعت و قطع‌وصلی هرچه آن یکی داشته باشد را به ارث می‌برد.'
                    : '.');
            writeTunLog(`uplink-owner ${owner.name} ${owner.address}${virtualish ? ' (stacked!)' : ''}`);
            if (virtualish) onLog(`[TUN] ⚠️ ${line}`);
            try { require('./tun-diag').event('stacked-check', { owner: owner.name, ip: owner.address, stacked: virtualish }); } catch (e) { /* diary only */ }
        }
    } catch (e) { /* advisory only */ }

    // …and when there IS something underneath, keep the floor under it. See pinnedHostRoutes:
    // the VPN below stays alive only through its own pinned /32, and a tunnel that captures that
    // address takes the whole line down with it — including its own way out.
    if (stackedUnder) {
        try {
            const pinned = await pinnedHostRoutes();
            if (pinned.length) {
                onLog(`[TUN]   ↳ آدرس سرور «${stackedUnder.name}» هم از تونل مستثنا شد تا خودش قطع نشود: ${pinned.join('، ')}`);
                writeTunLog(`stacked-pins ${pinned.join(',')}`);
                // Into `uplinkCidrs`, not `uplinkIps`: the second means "addresses of the engine
                // this tunnel is carrying", and the log lines and the «outside the known ranges»
                // warning both read it that way. These belong to somebody else entirely.
                options = Object.assign({}, options, {
                    uplinkCidrs: [...(options.uplinkCidrs || ENGINE_UPLINK_CIDRS), ...toHostCidrs(pinned)],
                });
            }
        } catch (e) { /* the warning above still stands */ }
    }

    onLog('[TUN] بررسی عبور واقعی دیتا از تونل…');
    let carries = null;
    const tried = [];
    // Three attempts, and not always at the same address.
    //
    // A node can be perfectly healthy and still refuse ONE destination: measured through a
    // Cloudflare-Worker node, 1.1.1.1:80 answered while example.com:80 was accepted and then
    // closed with no data. Hammering a single address three times therefore cannot tell "this
    // tunnel is dead" from "this node will not talk to that address", and the user is told the
    // first when the truth is the second.
    for (let attempt = 1; attempt <= 3 && !(carries && carries.ok); attempt++) {
        const target = PROBE_TARGETS[(attempt - 1) % PROBE_TARGETS.length];
        carries = await tunnelCarriesData(socksPort, 15000, target);
        tried.push(`${carries.target} ${carries.ok ? '✅' : '❌'} ${carries.why} (${carries.ms}ms)`);
        writeTunLog(`preflight try ${attempt}: ${tried[tried.length - 1]}`);
        if (!carries.ok && attempt < 3) {
            onLog(`[TUN] تلاش ${attempt} به ${carries.target} جواب نداد (${carries.why})؛ دوباره امتحان می‌شود…`);
            await new Promise(r => setTimeout(r, 1200));
        }
    }
    if (!carries.ok) {
        closeTunLog();
        throw new Error(
            `تونل ${engineLabel} وصل است ولی بعد از ۳ تلاش دیتا از آن رد نمی‌شود، بنابراین حالت تونل روشن نشد.\n` +
            'اگر روشن می‌شد، کل اینترنت سیستم قطع می‌شد و راهی برای برگرداندنش نداشتید.\n' +
            `آنچه امتحان شد:\n  • ${tried.join('\n  • ')}\n` +
            `موتور ${engineLabel} را یک بار قطع و دوباره وصل کنید تا نشست تازه‌ای باز شود؛ اگر باز هم شد، پروکسی کل سیستم را امتحان کنید.`
        );
    }
    onLog(`[TUN] ✅ عبور دیتا تأیید شد (${carries.target} در ${carries.ms}ms).`);

    const { exe, config } = binPaths();
    // `smart` splits traffic by destination instead of tunnelling everything. Same adapter
    // and the same guards above — only the routing table differs.
    const smart = options.mode === 'smart';
    // `game` routes only the named processes through the engine and hands everything else
    // straight back to the physical interface — the inverse of the full tunnel, and the
    // reason it fails safe: a dead engine costs the game, not the machine.
    const game = options.mode === 'game';
    const stack = options.stack || 'system';
    // «مسیر برنامه‌ها»: read from its one owner at every build, never carried by a caller, so a
    // rebuild after the user changes it picks the new choice up. Not in game mode — that
    // tunnel already routes by process, and the game list is its whole point.
    // Settings › تنظیمات پیشرفته VPN › MTU: this method's own value, then «همهٔ روش‌ها», then
    // TUN_MTU — read from its one owner at every build, like the per-app choice below. Which
    // method: the caller says so when one engine carries several (Xray: V2Ray, «اتصال سریع»,
    // «ضد فیلتر SNI»); for aether it is the protocol the engine was started with.
    let tunMtu = TUN_MTU;
    try {
        const ns = require('./network-settings');
        let method = options.mtuMethod;
        if (!method && processName === 'aether.exe') {
            try { method = ns.methodOfAether(require('./aether-manager').getStatus().protocol); } catch (e) { /* masque */ }
        }
        tunMtu = ns.mtuFor(processName, method);
        if (tunMtu !== TUN_MTU) onLog(`[TUN] MTU آداپتور: ${tunMtu} (تنظیمات › MTU)`);
    } catch (e) { /* default */ }
    // A caller with its own split wins over the global setting. «تحریم‌شکن» has its own list of
    // applications and must not disturb, or be disturbed by, «مسیر برنامه‌ها» in Settings.
    const appRouting = options.appRouting ? options.appRouting
        : game ? NO_APP_ROUTING : readAppRouting(
        smart ? 'proxy' : (options.engineTag || 'aether'), processName);
    // «فقط ۰ برنامه از تونل رد می‌شود» was a true sentence that nobody reads as «your tunnel is
    // carrying nothing», so the empty case gets its own line and says what was done about it.
    if (appRouting.mode === 'allow-empty') {
        onLog('[TUN] ⚠️ «مسیر برنامه‌ها» روی «فقط این برنامه‌ها» است ولی لیست خالی است — پس کل سیستم از تونل رد می‌شود. اگر می‌خواهید فقط چند برنامه رد شوند، از تنظیمات › مسیر برنامه‌ها اضافه‌شان کنید.');
    } else if (appRouting.mode !== 'all') {
        onLog(appRouting.mode === 'bypass'
            ? `[TUN] مسیر برنامه‌ها: ${appRouting.count} برنامه از تونل رد نمی‌شود.`
            : `[TUN] مسیر برنامه‌ها: فقط ${appRouting.count} برنامه از تونل رد می‌شود؛ بقیه مستقیم.`);
    }
    const buildConfig = (useStack) => (game
        ? buildGameTunConfig(socksPort, {
            processName, supportsUdp,
            engineTag: options.engineTag,
            gameProcesses: options.gameProcesses,
            gameIps: options.gameIps,
            gamePorts: options.gamePorts,
            mtu: tunMtu,
            uplinkCidrs: options.uplinkCidrs,
            uplinkIps: options.uplinkIps,
            uplinkDomains: options.uplinkDomains,
            stack: useStack,
            logLevel: options.logLevel,
        })
        : smart
        ? buildSmartTunConfig(socksPort, {
            processName, supportsUdp, rejectQuic: options.rejectQuic,
            fallback: options.fallback,
            dohUrl: options.dohUrl,
            overrides: options.overrides,
            stack: useStack,
            logLevel: options.logLevel,
            appRouting,
            mtu: tunMtu,
        })
        : buildTunConfig(socksPort, {
            processName: exeNames, supportsUdp, rejectQuic: options.rejectQuic,
            uplinkCidrs: options.uplinkCidrs,
            uplinkIps: options.uplinkIps,
            uplinkDomains: options.uplinkDomains,
            engineTag: options.engineTag,
            apiSuffixes: options.apiSuffixes,
            engineDomains: options.engineDomains,
            remoteDns: options.remoteDns,
            // BOTH OF THESE WERE BEING DROPPED HERE, and the builder reads them.
            //
            // This list is written out field by field, so an option the caller passes and the
            // builder honours still never arrives unless its name appears HERE. `remoteDnsServer`
            // is the one that mattered: تور sets it to its own DNSPort on loopback so lookups are
            // resolved inside the circuit, and the comment at that line says exactly why — a public
            // resolver would send every app's lookups out in cleartext, naming the sites of
            // somebody who just turned Tor on. It never reached the config, so it never happened.
            remoteDnsServer: options.remoteDnsServer,
            hijackEngineDns: options.hijackEngineDns,
            logLevel: options.logLevel,
            appRouting,
            mtu: tunMtu,
            stack: useStack,
        }));

    // `sing-box check` does not validate the stack value — it accepts a nonsense one — so
    // there is no cheap pre-flight for this. The fallback is a runtime retry at the end of
    // this function instead: if the process dies immediately with the fast stack, it is
    // rebuilt with gvisor rather than reported as a failure.
    //
    // The split and game tunnels have always chosen their own (fast by default, since a tunnel
    // that carries a fraction of the traffic can afford to be refused). The FULL tunnel used to
    // be gvisor with no way to say otherwise, which is the one place the stack's cost is paid on
    // every byte the machine sends. It now reads Settings › تنظیمات پیشرفته VPN › «پشته‌ی تونل»,
    // whose default is still gvisor — nobody's connection changes on update — with `fallback`
    // saying whether a refusal may silently drop back to it.
    let stackPick = (smart || game)
        ? { name: stack, fallback: stack !== 'gvisor' }
        : { name: 'gvisor', fallback: false };
    if (!smart && !game) {
        try { stackPick = require('./network-settings').tunStack(); } catch (e) { /* default */ }
    }
    const chosenStack = stackPick.name;
    // Counters are a convenience; the tunnel is not. A port that cannot be picked means no
    // counters this run, never a tunnel that does not start.
    try {
        countersApi = {
            port: await freeLoopbackPort(),
            secret: crypto.randomBytes(16).toString('hex'),
            isUplink: uplinkMatcher(processName, options),
            seen: new Map(), up: 0, down: 0, sawUplink: false,
        };
    } catch (e) { countersApi = null; }
    fs.writeFileSync(config, JSON.stringify(dropConditionlessRules(withCounters(buildConfig(chosenStack)), onLog), null, 2));

    onLog('════════════════════════════════════════');
    onLog(game ? '[TUN] راه‌اندازی شتاب بازی (فقط پراسس بازی)'
        : smart ? '[TUN] راه‌اندازی حالت تونل هوشمند'
        : '[TUN] راه‌اندازی حالت تونل');
    onLog(`[TUN] آداپتور: ${TUN_ADDRESS}  (MTU ${tunMtu}، پشته ${chosenStack})`);
    if (game) {
        const procs = (options.gameProcesses || []);
        onLog(`[TUN] فقط این پراسس‌ها → موتور: ${procs.join('، ') || '(هیچ)'}`);
        if ((options.gameIps || []).length) onLog(`[TUN] و این آدرس‌ها: ${options.gameIps.join('، ')}`);
        onLog('[TUN] بقیه‌ی سیستم → مستقیم. اگر موتور بخوابد، فقط بازی قطع می‌شود نه اینترنت.');
        onLog('[TUN] DNS دست نخورده می‌ماند — این حالت تونل حریم‌خصوصی نیست، شتاب‌دهنده است.');
    } else if (smart) {
        const r = resolveRoutes(options.overrides || {});
        onLog(`[TUN] سایت‌های ایرانی (.ir و ${r.direct.length} دامنه) → مستقیم`);
        onLog(`[TUN] ${r.tunnel.length} دامنه‌ی فیلتر/تحریم → تونل`);
        onLog(`[TUN] ${r.block.length} دامنه‌ی تبلیغات/ردیاب → رد`);
        onLog(`[TUN] بقیه‌ی سایت‌ها → ${options.fallback === 'tunnel' ? 'تونل (همه‌چیز باز می‌شود)' : 'مستقیم (سریع‌ترین)'}`);
        if (options.dohUrl) onLog('[TUN] DNS از Worker اختصاصی، خارج از تونل — جعل DNS بی‌اثر می‌شود');
    } else {
        onLog(`[TUN] تمام ترافیک سیستم → SOCKS 127.0.0.1:${socksPort}`);
    }
    // These lines describe a tunnel that carries the whole machine. Game mode carries one
    // process and never touches DNS, so printing them there would be a false claim in the
    // user's own log — the kind that later gets quoted back as "but it said no DNS leak".
    if (!game) {
        if (supportsUdp) {
            onLog('[TUN]   ↳ شامل UDP و QUIC — نشتی که پراکسی سیستم داشت بسته می‌شود');
            onLog('[TUN]   ↳ DNS از داخل تونل حل می‌شود — نشت DNS بسته می‌شود');
        } else {
            onLog('[TUN]   ↳ این موتور UDP حمل نمی‌کند — DNS از راه TCP و از داخل تونل حل می‌شود');
            onLog('[TUN]   ↳ QUIC رد می‌شود تا مرورگر بی‌درنگ به TCP برگردد (بدون معطلی)');
        }
    } else if (!supportsUdp) {
        onLog('[TUN]   ⚠️ این موتور UDP حمل نمی‌کند — برای بازی تقریباً بی‌فایده است.');
    }
    onLog(`[TUN]   ↳ فرآیند ${processName} از تونل مستثنا شد (جلوگیری از حلقه)`);
    const hostCidrs = toHostCidrs(options.uplinkIps);
    if (hostCidrs.length) {
        onLog(`[TUN]   ↳ آدرس فعلی خود موتور هم مستثنا شد: ${hostCidrs.join('، ')}`);
    }
    // An address outside the static ranges is excluded by its /32 and nothing more, so it
    // stops being excluded the moment the engine moves. Say so: it is the difference
    // between "the tunnel is fine" and "the tunnel is one migration from carrying nothing".
    const uncovered = uncoveredUplinks(options.uplinkIps || []);
    if (uncovered.length) {
        const warn = `[TUN] ⚠️ اندپوینت موتور (${uncovered.join('، ')}) بیرون از محدوده‌های شناخته‌شده است — ` +
            'فقط با استثنای دقیق همین آدرس پوشش دارد. اگر موتور جابه‌جا شود تونل باید بازسازی شود.';
        onLog(warn);
        writeTunLog(warn);
    }
    onLog('════════════════════════════════════════');

    const pipe = (buf) => {
        buf.toString().split('\n').forEach((line) => {
            const t = line.trim();
            if (!t) return;
            writeTunLog(t);
            onLog(`[TUN] ${t}`);
        });
    };

    // One place that attaches every handler, because the stack fallback below spawns a
    // SECOND process — and a retry without the exit handler leaves a crashed tunnel
    // reporting itself as running, with the machine's default route still pointed at it.
    const spawnEngine = () => {
        const proc = spawn(exe, ['run', '-c', config], { cwd: path.dirname(exe), windowsHide: true });
        proc.stdout.on('data', pipe);
        proc.stderr.on('data', pipe);
        proc.on('exit', (code) => {
            if (tunProcess !== proc) return; // superseded by the retry; not our state to clear
            const wasRunning = tunRunning;
            tunRunning = false;
            tunProcess = null;
            if (wasRunning && code !== 0 && code !== null) {
                // A crash here leaves the machine without a default route until Windows
                // tears the adapter down. Say so plainly instead of going quiet.
                onLog(`[TUN] ⚠️ موتور تونل با کد ${code} بسته شد. اگر اینترنت قطع است، تونل را دوباره روشن/خاموش کنید.`);
                // An engine that dies on its own is the purest form of "it keeps dropping", and
                // it is the one case nothing recorded: stopTun was never called, so the session
                // stayed open and the next start simply overwrote it.
                endDiagSession(`sing-box exited (code ${code})`);
            } else if (wasRunning) {
                onLog('[TUN] تونل خاموش شد؛ مسیرهای شبکه به حالت عادی برگشت.');
            }
        });
        proc.on('error', (err) => {
            if (tunProcess !== proc) return;
            tunRunning = false;
            onLog(`[TUN] ❌ اجرای موتور تونل ممکن نشد: ${err.message}`);
        });
        tunProcess = proc;
        tunRunning = true;
        return proc;
    };

    // Clear leftovers BEFORE spawning, or sing-box dies on the name collision.
    await removeStaleAdapter(onLog);

    // Header first: which engine, which mode and which exclusions produced this run —
    // without them the sing-box lines below cannot be interpreted after the fact.
    // Appended, not reopened: the pre-flight header and its probe results are already in this
    // file and re-opening would truncate the very lines that explain a failed run.
    writeTunLog(`start engine=${engineLabel} process=${processName} socks=${socksPort} ` +
        `mode=${smart ? 'smart' : 'full'} stack=${chosenStack} udp=${supportsUdp} ` +
        `uplinkIps=${(options.uplinkIps || []).join(',') || '-'} ` +
        // Domains matter as much as addresses here: a node named workers.dev is excluded
        // by name, and a header that only showed IPs read as "nothing excluded".
        `uplinkDomains=${(options.uplinkDomains || []).join(',') || '-'} ` +
        `dnsBridge=${dnsBridgeState()}`);
    // The diary that survives this run. tun.log is truncated on every start, so the session
    // BEFORE the one being investigated is always gone from it — and a tunnel that flaps is,
    // by definition, a series of short sessions. This file keeps them all.
    try {
        require('./tun-diag').startSession({
            engine: engineLabel, process: processName, socks: socksPort,
            mode: smart ? 'smart' : game ? 'game' : 'full',
            stack: chosenStack, mtu: tunMtu, udp: supportsUdp, log: options.logLevel || 'warn',
        });
    } catch (e) { /* no diary, same tunnel */ }
    spawnEngine();

    // Wait for the adapter to EXIST, not for a stopwatch. See TUN_READY_TIMEOUT_MS: the flat
    // 1500 ms sleep this replaces reported success for a tunnel that had already failed,
    // because on a cold start sing-box takes longer than 1.5 s to die.
    let ready = await waitForReady();
    if (!ready.ok) {
        // The fast network stack is the most likely thing to be refused by a given build or
        // driver, and it is the only setting here worth trading away automatically: gvisor
        // is slower but works everywhere. One retry, then the failure is real.
        if (stackPick.fallback && chosenStack !== 'gvisor') {
            onLog(`[TUN] با پشته‌ی سریع بالا نیامد (${ready.reason}) — یک بار دیگر با gvisor…`);
            stopTun(null);
            // The retry drops the counters: whatever stopped the first try, it must not be them.
            countersApi = null;
            fs.writeFileSync(config, JSON.stringify(dropConditionlessRules(buildConfig('gvisor'), onLog), null, 2));
            spawnEngine();
            ready = await waitForReady();
        }
        if (!ready.ok) {
            // Never leave a half-started engine behind: it may already hold the adapter and
            // the default route, which is the machine-offline state with no UI to fix it.
            stopTun(null);
            throw new Error(
                `تونل بالا نیامد: ${ready.reason}\n` +
                'لاگ بالا علت دقیق را نشان می‌دهد (معمولاً نبودن دسترسی مدیر یا درگیری با یک VPN دیگر).'
            );
        }
        onLog('[TUN] با gvisor برقرار شد.');
    }
    onLog(`[TUN] ✅ آداپتور «${TUN_IFACE_NAME}» ساخته شد و مسیر پیش‌فرض روی آن است.`);
    // From here the tunnel is real, so start watching what it actually carries. Both of these
    // are passive: the sampler reads byte counters sing-box already keeps, and neither costs the
    // user's line a single packet.
    try {
        const diag = require('./tun-diag');
        diag.readySession({ stack: chosenStack, mtu: tunMtu });
        diag.startSampler({
            read: () => readTrafficCounters(),
            alive: () => isRunning(),
            onLine: onLog,
        });
    } catch (e) { /* no diary, same tunnel */ }
    // Every name the machine looked up before this moment was answered by the ISP, and for a
    // censored name that answer is the filter sinkhole (see FILTER_SINKHOLE_CIDRS). Those
    // entries stay valid for their TTL, so without a flush the first minutes inside the tunnel
    // still fail on exactly the sites the tunnel exists to reach — the reject rule turns a
    // silent wrong answer into a fast failure, but only a flush makes the right answer
    // reachable. Best-effort: a tunnel that is up must not be reported as failed because a
    // cache flush was refused.
    // Awaited, not execSync: this runs on a click, inside Electron's main process, and a
    // ten-second timeout on a synchronous spawn is a ten-second frozen window.
    const flushed = await new Promise((resolve) => {
        require('child_process').execFile('ipconfig', ['/flushdns'],
            { windowsHide: true, timeout: 10000 }, (err) => resolve(!err));
    });
    onLog(flushed
        ? '[TUN] کش DNS ویندوز پاک شد (پاسخ‌های مسموم قبلی دور ریخته شدند).'
        : '[TUN] ⚠️ کش DNS پاک نشد؛ اگر سایتی باز نشد، یک بار مرورگر را ببندید و باز کنید.');

    onLog(smart
        ? '[TUN] ✅ تونل هوشمند برقرار است — فقط سایت‌های فیلتر/تحریم از تونل رد می‌شوند.'
        : `[TUN] ✅ تونل برقرار است — تمام ترافیک سیستم از ${engineLabel} عبور می‌کند.`);

    // Measure the real thing, once, without holding the caller up. The tunnel is already
    // live at this point and this probe never tears it down — it exists so that "it is on
    // but nothing loads" arrives with a number next to it in tun.log.
    // Callers that VERIFY the tunnel (and tear it down when the payload does not arrive)
    // run their own probe and act on the result; running a second one here would just spend
    // another 256KB of a line that may already be slow.
    // …and it also MEASURES the line, which is what sizes everything below. See measuredKBps.
    let measuredKBps = 0;
    if (!options.skipThroughputProbe) {
        probeTunThroughput(onLog).then((r) => { measuredKBps = (r && r.kbps) || 0; }).catch(() => {});
    }

    // …and once, a little later, the comparison that actually answers «چرا کند است»: the same
    // download through the tunnel and straight into the engine behind it. Delayed so it does not
    // fight the verification probes above for the line, and detached so a slow measurement never
    // holds up the switch the user is waiting on. See tun-diag.diagnose.
    if (!options.skipSpeedDiagnosis) {
        setTimeout(() => {
            if (!isRunning()) return;
            try {
                // SIZED FROM WHAT THE LINE ACTUALLY DID, not from a constant.
                //
                // This used to be a flat 1 MB a side — 2 MB total, on every single start, without
                // being asked. Measured on a سایفون tunnel here (2026-09-19): the engine gave
                // 0.46 Mbit/s, so those two downloads plus the 256 KB probe above took **fifty
                // seconds of a completely saturated line**, beginning the instant the user turned
                // the tunnel on. The byte counters show it exactly: 3.65 MB moved between 08:40:01
                // and 08:40:51, and then 0.006 Mbit/s once the measuring stopped. The user's first
                // minute inside the tunnel was spent entirely on the app measuring itself, which
                // is not slowness being diagnosed — it is slowness being CAUSED.
                //
                // So: about four seconds a side at the rate the probe above just measured, floored
                // at 128 KB (below that the number is noise) and capped at the old 1 MB. On a fast
                // link nothing changes; on a slow one the diagnosis stops being the problem.
                const perSide = measuredKBps > 0
                    ? Math.max(131072, Math.min(1000000, Math.round(measuredKBps * 1024 * 4)))
                    : 262144;
                require('./tun-diag').diagnose({ socksPort, engineLabel, onLog, bytes: perSide }).catch(() => {});
            } catch (e) { /* diagnosis is never fatal */ }
        }, 20000).unref();
    }
}

/**
 * Close the diary entry for this tunnel, with why it ended and how long it lasted.
 *
 * `reason` is what separates a flap from ordinary use. Every caller that ends a tunnel passes
 * one; a stop with no reason is recorded as such, which is itself worth knowing.
 */
function endDiagSession(reason) {
    try {
        const diag = require('./tun-diag');
        diag.stopSampler();
        diag.stopSession(reason || 'unspecified');
    } catch (e) { /* no diary, same tunnel */ }
}

// Stopping the tunnel is the one operation that MUST NOT fail quietly: whatever happens
// here, the machine has to end up with a working default route again.
//
// The previous version went straight to `taskkill /F` while its own comment claimed
// "sing-box restores the routing table on a clean shutdown". Both cannot be true — `/F`
// terminates the process immediately, so none of sing-box's shutdown code runs. In practice
// Wintun tears the adapter down when the last handle closes and Windows drops the routes
// bound to it, which is why this mostly appeared to work; "mostly" is not a property worth
// relying on for the thing that decides whether the user has internet.
//
// So: ask nicely first, force second, and verify third.
function stopTun(onLog, reason) {
    closeTunLog();
    endDiagSession(reason);
    countersApi = null;
    if (!tunProcess) { tunRunning = false; return; }
    const proc = tunProcess;
    tunRunning = false;
    tunProcess = null;

    // A plain taskkill (no /F) posts WM_CLOSE / CTRL_CLOSE, which sing-box handles and uses
    // to unwind auto_route, its DNS changes and its WFP filters.
    let exited = false;
    try {
        execSync(`taskkill /pid ${proc.pid} /T`, { stdio: 'ignore', timeout: 5000 });
    } catch { /* no console to signal, or already gone — the force path below covers it */ }

    // Give it a beat to unwind, then make sure it is really gone. Synchronous on purpose:
    // this function is called from `before-quit`, which does not wait for promises.
    // Atomics.wait blocks the thread without spawning anything — a shell-out just to sleep
    // would cost more than the wait itself.
    const deadline = Date.now() + 3000;
    const nap = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* fall through */ } };
    while (Date.now() < deadline) {
        try { process.kill(proc.pid, 0); } catch { exited = true; break; }
        nap(150);
    }

    if (!exited) {
        try { execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore', timeout: 5000 }); }
        catch { try { proc.kill('SIGKILL'); } catch {} }
    }

    if (onLog) onLog(exited ? '[TUN] تونل به‌صورت تمیز متوقف شد.' : '[TUN] تونل متوقف شد (خاتمه‌ی اجباری).');
}

/**
 * stopTun without blocking: the same ask-then-force-then-verify, with every wait awaited.
 *
 * The server runs inside Electron's main process, so the synchronous version above — two
 * taskkills with 5 s timeouts and a 3 s sleep loop — froze the whole window for up to 13 s
 * every time the user disconnected: «بعد قطع کردن v2ray کل اپ فریز میشه». stopTun stays for
 * `before-quit`, which cannot wait for a promise; everything a click reaches uses this.
 */
async function stopTunAsync(onLog, reason) {
    closeTunLog();
    endDiagSession(reason);
    countersApi = null;
    if (!tunProcess) { tunRunning = false; return; }
    const proc = tunProcess;
    tunRunning = false;
    tunProcess = null;

    const run = (args) => new Promise((resolve) => {
        require('child_process').execFile('taskkill', args, { windowsHide: true, timeout: 5000 }, () => resolve());
    });
    const alive = () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } };

    await run(['/pid', String(proc.pid), '/T']);
    const deadline = Date.now() + 3000;
    let exited = !alive();
    while (!exited && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        exited = !alive();
    }
    if (!exited) {
        await run(['/pid', String(proc.pid), '/T', '/F']);
        if (alive()) { try { proc.kill('SIGKILL'); } catch {} }
    }
    if (onLog) onLog(exited ? '[TUN] تونل به‌صورت تمیز متوقف شد.' : '[TUN] تونل متوقف شد (خاتمه‌ی اجباری).');
}

/**
 * After a stop, is the machine routable again?
 *
 * Called by the orchestrator rather than assumed. If a hard kill left the adapter or its
 * routes behind, the user is offline with no error anywhere — and that is recoverable here,
 * while it is not recoverable once they have closed the app in frustration.
 */
async function verifyTornDown(onLog) {
    // The fast probe first: this runs on the disconnect path, where a PowerShell launch is the
    // slowest thing between the user's click and their internet coming back.
    const fast = await fastLive();
    if (fast.ok && !fast.adapter && !fast.defaultViaTun) return { ok: true };

    const s = await inspectAdapter();
    // `unknown` falls THROUGH to the cleanup on purpose. The old code read a failed probe as
    // "nothing left behind" and returned success — which is the one answer that must never be
    // guessed here, because being wrong means the machine is left routing into a dead adapter
    // with no way back. Running the cleanup when there was nothing to clean costs one command.
    if (!s.unknown && !s.adapter && !s.defaultViaTun) return { ok: true };

    if (onLog) onLog('[TUN] ⚠️ آثار تونل بعد از توقف باقی مانده بود؛ در حال پاک‌سازی…');
    await new Promise((resolve) => {
        require('child_process').execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', `
$ErrorActionPreference='SilentlyContinue'
Get-NetRoute -InterfaceAlias '${TUN_IFACE_NAME}' | Remove-NetRoute -Confirm:$false
Get-NetAdapter -Name '${TUN_IFACE_NAME}' | Disable-NetAdapter -Confirm:$false
`], { timeout: 20000, windowsHide: true }, () => resolve());
    });

    // Ask the machine where its packets would go NOW. That is the whole question here — "is this
    // computer routable again" — and the UDP-source probe answers it directly, without a process
    // launch and without a table to interpret.
    const after = await fastLive();
    const state = after.ok ? after : await inspectAdapter();
    const ok = !state.defaultViaTun;
    if (onLog) {
        onLog(ok ? '[TUN] مسیر پیش‌فرض به حالت عادی برگشت.'
                 : '[TUN] ❌ مسیر پیش‌فرض هنوز روی تونل است — شبکه را یک بار قطع و وصل کنید.');
    }
    return { ok, state };
}

module.exports = {
    currentEngine,
    currentTunnel,      // what the live tunnel is made of — the speed report measures against it
    verifyTunCarriesTraffic, probeTunReachableByIp,
    socksCarriesUdp,
    socksResolvesTcp,   // with the one above: which resolver the node can actually reach
    pickTunnelResolver,
    probeTunThroughput,
    uncoveredUplinks,
    startTun,
    stopTun, stopTunAsync,
    rebuild,            // a running tunnel, built again to pick up a changed setting
    isRunning,
    readTrafficCounters,   // the tunnel's byte counts, for traffic-feed.js
    tallyCounters,         // exported for testing: this is what stops the count doubling
    uplinkMatcher,         // exported for testing
    checkLive,          // multi-layer verdict: process / adapter / route, checked against Windows
    inspectAdapter,
    fastLive,           // the same verdict without spawning anything — what the watchdog polls
    pinnedHostRoutes,   // what another VPN pinned to the real line — exported for testing
    currentDefaultInterface,  // who owns the route to the internet right now, by name
    verifyTornDown,     // the machine must be routable again after a stop, not assumed to be
    waitForReady,
    checkPrerequisites,
    binPaths,
    TUN_IFACE_NAME,
    buildGameTunConfig, // exported for testing: the inverted routing is the safety story
    buildTunConfig, // exported for testing: the rule order here is safety-critical
    buildSmartTunConfig, // exported for testing: same, and the split itself is the feature
    dropConditionlessRules, // exported for testing: a rule with no conditions is a total leak
    tunVerdict,         // what the live tunnel is really doing, written into its own log
    tunnelCarriesData, // exported for testing: this guard is what keeps the machine online
    PROBE_TARGETS,      // exported for testing: which addresses the pre-flight probe knocks on
    processNames,       // exported for testing: an engine can be two processes (tor + its transport)
};
