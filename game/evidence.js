// --- Did the game's traffic ACTUALLY go through the engine? ---
//
// WHY THIS FILE EXISTS
// Everything else in this feature can be checked by the user: a latency number, a region
// ranking, a NAT type. Acceleration cannot. The panel says "your game is going through
// Aether now" and the player has no way whatsoever to confirm it — the traffic is invisible,
// the game shows nothing, and Windows offers no per-process routing view.
//
// That is precisely the situation where software lies to people, usually by accident. The
// `process_name` rule this mode depends on can fail silently: Windows refuses the process
// lookup for some sockets (sing-box logs "failed to search process: Access is denied"), the
// game may spawn a differently-named child, or a launcher may proxy the connection. In every
// one of those cases the traffic quietly falls through to `final: direct` and the user is
// unaccelerated while the switch sits there green.
//
// So the claim gets evidence. sing-box writes one line per connection naming the outbound it
// chose; boost mode raises the log level to 'info' specifically so those lines exist. This
// module reads them back and answers the only question that matters: how many connections
// went to the engine, how many went direct, and to where.
//
// WHAT IT DOES NOT CLAIM
// The log line does not carry the process name, so this cannot say "GTA5.exe went through".
// It says "N connections chose the engine outbound". Combined with knowing that only the
// game's rule points there, that is strong evidence — but it is evidence, not proof, and the
// wording in the UI has to stay at that strength.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TUN_LOG = path.join(os.homedir(), '.mlmvpn', 'tun.log');

// sing-box colours its output, so the level and the connection id arrive wrapped in ANSI
// escapes. Stripping them first keeps the patterns below readable and stops a colour change
// in a future version from silently breaking the parse.
const ANSI = /\[[0-9;]*m/g;

// [iso] +0330 2026-08-19 09:56:37 ERROR [123 5.3s] connection: open connection to 1.2.3.4:443 using outbound/socks[aether]: ...
const CONN = /connection(?:s)?[^:]*:\s*(?:open connection|outbound connection)?\s*(?:to\s+)?([^\s]+?)\s+using\s+outbound\/([a-z0-9_-]+)\[([^\]]+)\]/i;
const ACCESS_DENIED = /failed to search process/i;

/**
 * Read the tail of the log.
 *
 * Bounded: the file is truncated per run, but a long session at info level still grows, and
 * an evidence panel must never read a hundred megabytes to draw a number.
 */
function tail(file, maxBytes) {
    let fd;
    try { fd = fs.openSync(file, 'r'); } catch { return ''; }
    try {
        const size = fs.fstatSync(fd).size;
        const start = Math.max(0, size - maxBytes);
        const buf = Buffer.alloc(Math.min(size, maxBytes));
        fs.readSync(fd, buf, 0, buf.length, start);
        const text = buf.toString('utf8');
        // A partial first line after seeking mid-file parses as garbage; drop it.
        return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
    } catch { return ''; }
    finally { try { fs.closeSync(fd); } catch {} }
}

/** ISO timestamp our own writer prefixes to every line, so lines can be time-filtered. */
function lineTime(line) {
    const m = line.match(/^\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]/);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : null;
}

/**
 * Count what the router actually did.
 *
 * `sinceMs` restricts the count to the current boost session — otherwise a log left over
 * from an earlier Aether full-tunnel run would be counted as proof of acceleration, which
 * is exactly the kind of false confirmation this module exists to prevent.
 */
function read({ engineTag = null, sinceMs = null, maxBytes = 2 * 1024 * 1024, file = TUN_LOG } = {}) {
    // `file` is injectable so the parser can be tested against fixtures. Without it the only
    // way to exercise it was to point at the machine's real log, which made every count
    // depend on whatever the last tunnel run happened to leave behind — and that is how a
    // parser test ends up passing for the wrong reason.
    const raw = tail(file, maxBytes);
    if (!raw) {
        return {
            available: false,
            reason: 'هنوز چیزی در لاگ tun نوشته نشده است.',
            engine: 0, direct: 0, other: 0, accessDenied: 0, targets: [], lines: 0,
        };
    }

    let engine = 0, direct = 0, other = 0, accessDenied = 0, lines = 0, considered = 0;
    const targets = new Map();
    let firstAt = null, lastAt = null;

    for (const rawLine of raw.split(/\r?\n/)) {
        if (!rawLine.trim()) continue;
        lines++;
        const at = lineTime(rawLine);
        if (sinceMs && at && at < sinceMs) continue;
        const line = rawLine.replace(ANSI, '');

        if (ACCESS_DENIED.test(line)) { accessDenied++; continue; }

        const m = line.match(CONN);
        if (!m) continue;
        considered++;
        if (at) { if (firstAt === null) firstAt = at; lastAt = at; }

        const dest = m[1].replace(/[:,]$/, '');
        const tag = m[3];

        if (engineTag && tag === engineTag) {
            engine++;
            const k = dest;
            targets.set(k, (targets.get(k) || 0) + 1);
        } else if (tag === 'direct') {
            direct++;
        } else {
            other++;
        }
    }

    return {
        available: true,
        engine, direct, other, accessDenied,
        lines, considered,
        firstAt, lastAt,
        // The destinations the engine actually carried — the most concrete thing this
        // module can show, and the one a player can sanity-check against their game.
        targets: [...targets.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 12)
            .map(([dest, count]) => ({ dest, count })),
    };
}

/**
 * Turn the counts into something the panel can state honestly.
 *
 * Four outcomes, and 'none' is the important one: a boost that is on while nothing has gone
 * through the engine is either a game that is not running yet or a routing rule that did not
 * match, and the user is told which possibilities remain rather than shown a green tick.
 */
function summarise({ engineTag, sinceMs, gameRunning = false, engineFa = 'موتور', file = TUN_LOG } = {}) {
    const r = read({ engineTag, sinceMs, file });
    if (!r.available) {
        return { ...r, verdict: 'unknown', fa: 'شاهدی در دسترس نیست', reasons: [r.reason] };
    }

    const reasons = [];
    let verdict, fa;

    if (r.engine > 0) {
        verdict = 'confirmed';
        fa = 'تأیید شد — ترافیک از موتور رد می‌شود';
        reasons.push(`${r.engine} اتصال از «${engineFa}» رفت و ${r.direct} اتصال مستقیم — یعنی قاعده‌ی پراسس واقعاً تطبیق خورده است.`);
        if (r.targets.length) {
            reasons.push('مقصدهایی که از موتور رفتند: ' + r.targets.slice(0, 5).map(t => `${t.dest} (${t.count})`).join('، '));
        }
    } else if (!gameRunning) {
        verdict = 'waiting';
        fa = 'منتظر اجرای بازی';
        reasons.push('شتاب روشن است ولی بازی هنوز اجرا نشده، پس هنوز چیزی برای عبور دادن وجود ندارد.');
        reasons.push(`تا اینجا ${r.direct} اتصال از بقیه‌ی سیستم مستقیم رفته — یعنی مسیر پیش‌فرض درست کار می‌کند.`);
    } else {
        verdict = 'not-matched';
        fa = 'بازی اجراست ولی چیزی از موتور رد نشده';
        reasons.push('این یعنی قاعده‌ی مسیریابی بر اساس نام پراسس تطبیق نخورده است.');
        if (r.accessDenied > 0) {
            reasons.push(`${r.accessDenied} بار ویندوز اجازه‌ی شناسایی پراسس را نداده (Access is denied) — علت محتمل همین است.`);
        }
        reasons.push('راه‌حل: بازی را در حالی که شتاب روشن است دوباره اجرا کن، یا اگر آدرس سرور را می‌دانی واردش کن تا تطبیق بر اساس آدرس انجام شود.');
    }

    if (r.other > 0) reasons.push(`${r.other} اتصال به خروجی دیگری رفت.`);
    return { ...r, verdict, fa, reasons };
}

module.exports = { read, summarise, TUN_LOG, CONN, ANSI, lineTime };
