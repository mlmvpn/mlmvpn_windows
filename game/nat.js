// --- NAT behaviour discovery ---
//
// WHY THIS MATTERS MORE THAN PING FOR THE GAMES THE USER ACTUALLY PLAYS
// GTA Online, Red Dead Online, EA FC, Destiny 2, Forza, Warframe and every fighting game
// are peer-to-peer: the "server" is another player. For those, the thing that decides
// whether a session works is not latency at all — it is whether two NATs can be persuaded
// to let packets through. A strict NAT shows up as "can't join friends", "session
// disbanded", "you were removed from the lobby", and no amount of route optimisation
// touches it. It is also the ONE problem a relay with a public IP fixes outright.
//
// So this is measured first-class, and it needs no server of ours.
//
// WHAT IS ACTUALLY MEASURED, AND WHAT IS NOT
// From one local UDP socket we ask several independent STUN servers what public
// address:port they see. The comparison between those answers is the diagnosis:
//
//   same mapped port from every server  → endpoint-independent mapping ("cone").
//                                         Hole punching works. This is the good case.
//   different port per server           → address-dependent mapping (symmetric NAT).
//                                         Hole punching mostly fails; P2P games suffer.
//   mapped address == local address     → no NAT at all, a real public IP.
//   mapped address in 100.64.0.0/10     → carrier-grade NAT. The user cannot fix this from
//                                         inside their house, and that is worth saying.
//
// FILTERING behaviour (whether an unsolicited packet from a new address is allowed back in)
// needs a server that can reply from a DIFFERENT address — RFC 5780's CHANGE-REQUEST. The
// big public STUN servers do not reliably implement it, so rather than pretend, this module
// reports mapping behaviour and says plainly that filtering was not determined. A confident
// wrong answer about NAT type is worse than an honest partial one, because the user will
// go and change router settings on the strength of it.

'use strict';

const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');
const probe = require('./probe');

// Three operators, three networks. Using three addresses at one provider would be one
// observation wearing three hats — the same netGroup discipline netdiag uses.
const SERVERS = [
    { host: 'stun.l.google.com', port: 19302, fa: 'Google', group: 'google' },
    { host: 'stun.cloudflare.com', port: 3478, fa: 'Cloudflare', group: 'cloudflare' },
    { host: 'global.stun.twilio.com', port: 3478, fa: 'Twilio', group: 'twilio' },
];

const MAGIC = 0x2112A442;

function bindingRequest(txid) {
    const b = Buffer.alloc(20);
    b.writeUInt16BE(0x0001, 0);
    b.writeUInt16BE(0, 2);
    b.writeUInt32BE(MAGIC, 4);
    txid.copy(b, 8);
    return b;
}

/**
 * Pull the reflexive address out of a STUN binding success.
 *
 * XOR-MAPPED-ADDRESS (0x0020) is what every modern server sends; MAPPED-ADDRESS (0x0001)
 * is the legacy form and is accepted as a fallback because a few old servers still use it.
 * The XOR exists precisely so that middleboxes rewriting bare IPs in payloads cannot
 * mangle it — which is also why the un-XORed value must never be preferred.
 */
function parseMapped(msg, txid) {
    if (msg.length < 20) return null;
    if (msg.readUInt16BE(0) !== 0x0101) return null;              // not a success response
    if (msg.readUInt32BE(4) !== MAGIC) return null;
    if (txid && !msg.slice(8, 20).equals(txid)) return null;

    const len = msg.readUInt16BE(2);
    let off = 20;
    const end = Math.min(msg.length, 20 + len);
    let legacy = null;

    while (off + 4 <= end) {
        const type = msg.readUInt16BE(off);
        const alen = msg.readUInt16BE(off + 2);
        const val = msg.slice(off + 4, off + 4 + alen);
        off += 4 + alen + ((4 - (alen % 4)) % 4);               // attributes are 4-byte padded

        if (type === 0x0020 && val.length >= 8 && val.readUInt8(1) === 0x01) {
            const port = val.readUInt16BE(2) ^ (MAGIC >>> 16);
            const ipInt = val.readUInt32BE(4) ^ MAGIC;
            return { ip: intToIp(ipInt), port, xor: true };
        }
        if (type === 0x0001 && val.length >= 8 && val.readUInt8(1) === 0x01 && !legacy) {
            legacy = { ip: intToIp(val.readUInt32BE(4)), port: val.readUInt16BE(2), xor: false };
        }
    }
    return legacy;
}

const intToIp = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

/**
 * Ask every server from ONE socket.
 *
 * The shared socket is the whole experiment: reusing a single local port is what makes the
 * mapped ports comparable. Opening a fresh socket per server would produce different
 * mappings on every NAT and turn every router in the world into "symmetric".
 */
function probeAll(servers, { timeoutMs = 3000, localPort = 0 } = {}) {
    return new Promise(resolve => {
        const sock = dgram.createSocket('udp4');
        const pending = new Map();
        const answers = [];
        let done = false;

        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            let local = null;
            try { local = sock.address(); } catch {}
            try { sock.close(); } catch {}
            resolve({ answers, localPort: local ? local.port : null });
        };

        sock.on('error', finish);
        sock.on('message', (msg, rinfo) => {
            for (const [hex, rec] of pending) {
                const m = parseMapped(msg, Buffer.from(hex, 'hex'));
                if (!m) continue;
                pending.delete(hex);
                answers.push({ ...rec.server, ...m, from: rinfo.address, rtt: Date.now() - rec.at });
                break;
            }
            if (!pending.size) finish();
        });

        sock.bind(localPort, () => {
            for (const s of servers) {
                const txid = crypto.randomBytes(12);
                pending.set(txid.toString('hex'), { server: s, at: Date.now() });
                sock.send(bindingRequest(txid), s.port, s.ip, () => {});
            }
        });

        const timer = setTimeout(finish, timeoutMs);
    });
}

/** Every private/CGNAT range that means "this address is not routable from the internet". */
function addrKind(ip) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return 'private';
    if (p[0] === 192 && p[1] === 168) return 'private';
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return 'private';
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'cgnat';
    if (p[0] === 127) return 'loopback';
    if (p[0] === 169 && p[1] === 254) return 'linklocal';
    return 'public';
}

/** Local IPv4 addresses of this machine, for the "am I behind any NAT at all" check. */
function localAddresses() {
    const out = [];
    const ifs = os.networkInterfaces();
    for (const name of Object.keys(ifs)) {
        for (const a of ifs[name] || []) {
            if (a.family === 'IPv4' && !a.internal) out.push(a.address);
        }
    }
    return out;
}

const GAME_IMPACT = {
    open: [
        'میزبانی جلسه، دعوت دوستان و صدای مستقیم بدون مشکل کار می‌کند.',
        'در بازی‌های همتا‌به‌همتا مثل GTA Online و EA FC، این بهترین حالت ممکن است.',
    ],
    moderate: [
        'اتصال به بیشتر جلسه‌ها کار می‌کند، ولی گاهی میزبان شدن یا پیوستن به دوستِ با NAT سخت‌گیرانه شکست می‌خورد.',
        'فعال کردن UPnP روی مودم معمولاً این را به «باز» تبدیل می‌کند.',
    ],
    strict: [
        'این جدی‌ترین مشکل ممکن برای بازی‌های همتا‌به‌همتاست: سوراخ‌کاری NAT شکست می‌خورد.',
        'علامت‌هایش: «نمی‌توانم به دوستم وصل شوم»، خروج ناگهانی از جلسه، دیده نشدن بازیکنان دیگر.',
        'یک رله با IP عمومی این را کاملاً حل می‌کند — و این تنها موردی است که رله قطعاً و بدون قید کمک می‌کند.',
    ],
    cgnat: [
        'شما پشت CGNAT اپراتور هستید؛ IP عمومی اختصاصی ندارید.',
        'هیچ تنظیمی روی مودم خانه این را حل نمی‌کند — نه UPnP، نه port forwarding.',
        'راه‌حل‌ها: درخواست IP استاتیک از اپراتور، یا یک رله با IP عمومی.',
    ],
};

/**
 * Classify the NAT.
 *
 * The three-way verdict deliberately mirrors the wording consoles and games use
 * (Open / Moderate / Strict), because that is what the user will see inside the game and
 * what every guide they find will talk about.
 */
function classify({ answers, localPort, locals }) {
    if (!answers.length) {
        return {
            type: 'unknown', fa: 'نامشخص',
            detail: 'هیچ‌کدام از سرورهای STUN پاسخ ندادند',
            reasons: ['UDP روی پورت بالا از این خط عبور نکرد. یا فایروال جلوی آن را گرفته، یا اپراتور آن را می‌بندد — در هر دو حالت هیچ بازی همتا‌به‌همتایی کار نخواهد کرد.'],
            impact: [], data: { answers },
        };
    }

    const groups = new Set(answers.map(a => a.group));
    const ports = [...new Set(answers.map(a => a.port))];
    const ips = [...new Set(answers.map(a => a.ip))];
    const kind = addrKind(ips[0]);
    const isLocal = locals.includes(ips[0]);
    const portPreserved = localPort != null && ports.length === 1 && ports[0] === localPort;

    const reasons = [];
    let type, fa;

    if (kind === 'cgnat') {
        type = 'cgnat'; fa = 'پشت CGNAT اپراتور';
        reasons.push(`آدرس عمومی شما ${ips[0]} است که در محدوده‌ی ۱۰۰.۶۴.۰.۰/۱۰ قرار دارد — یعنی این IP هم متعلق به اپراتور است، نه به شما.`);
    } else if (isLocal && ips.length === 1) {
        type = 'open'; fa = 'بدون NAT (IP عمومی مستقیم)';
        reasons.push('آدرسی که سرورها می‌بینند دقیقاً همان آدرس کارت شبکه‌ی شماست — هیچ NATی در مسیر نیست.');
    } else if (groups.size < 2) {
        type = 'unknown'; fa = 'نامشخص';
        reasons.push('فقط یک اپراتور STUN پاسخ داد، و تشخیص نوع NAT دست‌کم به دو شاهد مستقل نیاز دارد.');
    } else if (ports.length === 1) {
        type = 'open'; fa = 'باز (نگاشت مستقل از مقصد)';
        reasons.push(`هر ${groups.size} سرور مستقل، شما را روی همان پورت ${ports[0]} دیدند. یعنی NAT شما برای همه‌ی مقصدها یک نگاشت می‌سازد و سوراخ‌کاری NAT کار می‌کند.`);
        if (portPreserved) reasons.push(`پورت محلی هم حفظ شده (${localPort}) — بهترین حالت ممکن.`);
    } else {
        type = 'strict'; fa = 'سخت‌گیرانه (NAT متقارن)';
        reasons.push(`هر سرور شما را روی پورت متفاوتی دید (${ports.join('، ')}). این یعنی NAT متقارن: برای هر مقصد یک نگاشت تازه ساخته می‌شود.`);
        reasons.push('هیچ همتایی نمی‌تواند از قبل حدس بزند به کدام پورت بفرستد، پس اتصال مستقیم برقرار نمی‌شود.');
    }

    if (ips.length > 1) {
        reasons.push(`توجه: بیش از یک آدرس عمومی دیده شد (${ips.join('، ')}) — نشانه‌ی چند مسیر خروجی یا NAT توزیع‌شده‌ی اپراتور.`);
        if (type === 'open') { type = 'moderate'; fa = 'متوسط'; }
    }

    return {
        type, fa,
        detail: `${ips[0]}${ports.length === 1 ? ':' + ports[0] : ' (پورت متغیر)'}`,
        reasons,
        impact: GAME_IMPACT[type] || [],
        filtering: 'نامشخص — تشخیص رفتار فیلترینگ به سروری نیاز دارد که از آدرس دیگری جواب بدهد، و سرورهای عمومی این را قابل اتکا پیاده نکرده‌اند.',
        data: {
            publicIp: ips[0], ports, portPreserved, localPort,
            observers: answers.map(a => ({ fa: a.fa, ip: a.ip, port: a.port, rtt: a.rtt })),
        },
    };
}

/**
 * Run the discovery.
 *
 * Twice, from two different local ports, because a single sample cannot distinguish a
 * symmetric NAT from a router that simply reassigned the mapping between two of our
 * requests. Agreement between the two runs is what makes the verdict trustworthy.
 */
async function detectNat({ signal = null } = {}) {
    const servers = [];
    for (const s of SERVERS) {
        try { servers.push({ ...s, ip: await probe.resolve4(s.host) }); } catch {}
    }
    if (!servers.length) {
        return { type: 'unknown', fa: 'نامشخص', detail: 'نام سرورهای STUN حل نشد', reasons: [], impact: [], data: null };
    }

    const locals = localAddresses();
    const first = await probeAll(servers);
    if (signal && signal.aborted) return classify({ ...first, locals });
    const second = await probeAll(servers);

    const a = classify({ ...first, locals });
    const b = classify({ ...second, locals });

    // Two passes, one verdict. Disagreement is itself information: a NAT whose mapping
    // changes between two runs seconds apart is not stable, and games will feel that.
    if (a.type === b.type) {
        a.confirmed = true;
        a.data = { ...a.data, secondPass: b.data };
        return a;
    }
    return {
        type: 'moderate', fa: 'متوسط / ناپایدار', confirmed: false,
        detail: `${a.fa} در برابر ${b.fa}`,
        reasons: [
            'دو اجرای پشت‌سرهم دو نتیجه‌ی متفاوت دادند.',
            `اجرای اول: ${a.fa}. اجرای دوم: ${b.fa}.`,
            'یعنی نگاشت NAT شما بین دو درخواستِ چند ثانیه فاصله عوض می‌شود — این خودش برای بازی‌های همتا‌به‌همتا مشکل‌ساز است.',
        ],
        impact: GAME_IMPACT.moderate,
        data: { firstPass: a.data, secondPass: b.data },
    };
}

module.exports = { detectNat, parseMapped, addrKind, SERVERS };
