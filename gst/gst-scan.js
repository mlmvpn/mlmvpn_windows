// --- GST network path scanning ---
// Drives the engine's own scanners (gst.exe scan-ips / test-sni) and turns their table
// output into structured results for the network tab.
//
// Why the engine rather than our own prober: these tests must exercise the exact TLS
// stack the tunnel uses. A Node-side TLS handshake can succeed on an IP the engine's
// rustls configuration fails on (different cipher list, different SNI handling), and a
// green row for a path that does not actually carry traffic is worse than no row.
//
// This matters more than it looks: the first real scan on this machine found that the
// default IP shipped by BOTH reference projects (216.239.38.120) answered in 1970ms
// while another candidate answered in 432ms. A user on defaults runs 4x slower than
// they need to, forever, and has no way to know.

const store = require('./gst-config');
const core = require('./gst-core');
const log = require('./gst-log');

/** Rate an IP/SNI by latency so the UI can show bars without inventing thresholds twice. */
function grade(ms) {
    if (ms == null) return 0;
    if (ms < 300) return 5;
    if (ms < 700) return 4;
    if (ms < 1200) return 3;
    if (ms < 2500) return 2;
    return 1;
}

// Persian hints for well-known entries, mirroring ITEM_DESCRIPTIONS in the Android app
// so a user with both installed sees the same guidance.
const HINTS = {
    'www.google.com': 'پایدارترین گزینه',
    'youtubei.googleapis.com': 'بهترین برای اپ یوتیوب',
    'googlevideo.com': 'عالی برای لود سریع ویدیو',
    'www.youtube.com': 'وب‌سایت یوتیوب',
    'mtalk.google.com': 'پایداری بالا',
    'play.google.com': 'فروشگاه پلی',
    'drive.google.com': 'گوگل درایو',
};

/**
 * Parse the engine's fixed-width table output.
 * Rows look like:   <value>   <latency>ms   <status>
 * and unreachable ones carry a dash where the latency would be.
 */
function parseTable(stdout) {
    const rows = [];
    for (const line of String(stdout).split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('-') || /^(IP|SNI)\s/.test(t)) continue;
        if (/^(Scanning|Probing|Working|Found)/i.test(t)) continue;

        // value, then either "123ms" or "-", then the rest is the status word(s)
        const m = t.match(/^(\S+)\s+(\d+)ms\s+(.+)$/) || t.match(/^(\S+)\s+(-)\s+(.+)$/);
        if (!m) continue;

        const latency = m[2] === '-' ? null : Number(m[2]);
        const status = m[3].trim().toLowerCase();
        rows.push({
            value: m[1],
            latency,
            ok: status === 'ok',
            status,
            grade: status === 'ok' ? grade(latency) : 0,
        });
    }
    // Working entries first, fastest first; dead ones keep their order at the end.
    return rows.sort((a, b) => {
        if (a.ok !== b.ok) return a.ok ? -1 : 1;
        if (!a.ok) return 0;
        return (a.latency ?? 1e9) - (b.latency ?? 1e9);
    });
}

/** Human status text — the engine's own words are English and terse. */
function statusFa(row) {
    if (row.ok) return 'سالم';
    if (/timeout/.test(row.status)) return 'بی‌پاسخ';
    if (/not google/.test(row.status)) return 'سرور گوگل نیست';
    if (/tls/.test(row.status)) return 'خطای TLS';
    return row.status;
}

/**
 * Scan Google frontend IPs.
 * Slow by nature — it is a real TLS handshake per candidate — so callers should treat
 * this as a user-initiated action, not something to run on panel open.
 */
async function scanIps({ timeout = 180000 } = {}) {
    log.info('scan', 'شروع اسکن آی‌پی‌های گوگل…');
    const res = await core.runCommand(['scan-ips'], { timeout });
    const rows = parseTable(res.stdout).map(r => ({
        ip: r.value,
        latency: r.latency,
        ok: r.ok,
        grade: r.grade,
        status: statusFa(r),
        hint: HINTS[r.value] || '',
    }));

    const working = rows.filter(r => r.ok);

    // Persist the measurements, not just the selection. The panel builds its list from
    // these, so without saving them a restart leaves the user staring at an empty tab.
    store.setNetwork({ ipResults: rows, scannedAt: Date.now() });

    log.ok('scan', `اسکن آی‌پی تمام شد: ${working.length} سالم از ${rows.length}` +
        (working[0] ? ` — بهترین ${working[0].ip} با ${working[0].latency}ms` : ''));
    return { rows, working: working.length, total: rows.length };
}

/**
 * Probe SNI names against the currently selected IP.
 * The result depends on which IP is in play, so this is re-run after the IP changes.
 */
async function scanSnis({ timeout = 180000 } = {}) {
    const net = store.getNetwork();
    log.info('scan', `شروع تست SNI روی آی‌پی ${net.ips[0]}…`);

    const res = await core.runCommand(['test-sni'], { timeout });
    const rows = parseTable(res.stdout).map(r => ({
        sni: r.value,
        latency: r.latency,
        ok: r.ok,
        grade: r.grade,
        status: r.ok ? 'عبور' : (/timeout/.test(r.status) ? 'مسدود' : statusFa(r)),
        hint: HINTS[r.value] || '',
    }));

    const working = rows.filter(r => r.ok);
    store.setNetwork({ sniResults: rows, scannedAt: Date.now() });

    log.ok('scan', `تست SNI تمام شد: ${working.length} عبور از ${rows.length}`);
    return { rows, working: working.length, total: rows.length };
}

/**
 * Pick the best entries automatically.
 *
 * Several are kept, not one: the engine rotates through the list, so a pool absorbs a
 * single path going bad without the tunnel stalling. Picking only the single fastest
 * would make the tunnel maximally fast and maximally fragile.
 */
function autoSelect(rows, key, count = 5) {
    const best = rows.filter(r => r.ok).slice(0, count).map(r => r[key]);
    if (!best.length) return null;
    return best;
}

/**
 * Scan, choose the best, and apply — the "auto" button behind the network tab.
 * Returns what changed so the panel can say so rather than silently rearranging the
 * user's selections.
 */
async function optimize({ scan = true } = {}) {
    const before = store.getNetwork();
    const result = { changed: false };

    const ipScan = scan ? await scanIps() : null;
    if (ipScan) {
        const ips = autoSelect(ipScan.rows, 'ip');
        if (ips) {
            store.setNetwork({ ips });
            result.ips = ips;
            result.changed = result.changed || ips[0] !== before.ips[0];
        }
        result.ipScan = ipScan;
    }

    // SNI is probed against the chosen IP, so it has to come after the IP is applied.
    const sniScan = await scanSnis();
    const snis = autoSelect(sniScan.rows, 'sni');
    if (snis) {
        store.setNetwork({ snis });
        result.snis = snis;
        result.changed = result.changed || snis[0] !== before.snis[0];
    }
    result.sniScan = sniScan;

    if (result.changed) {
        log.ok('scan', `مسیر شبکه به‌روزرسانی شد — آی‌پی ${result.ips ? result.ips[0] : '(بدون تغییر)'}` +
            `، SNI ${result.snis ? result.snis[0] : '(بدون تغییر)'}`);
    } else {
        log.info('scan', 'مسیر فعلی همچنان بهترین گزینه است');
    }
    return result;
}

// ── background optimisation ───────────────────────────────────────────────────

let autoTimer = null;

/**
 * Re-measure quietly and switch if a better path appeared.
 *
 * Only the SNI probe runs here. A full IP scan is ~28 TLS handshakes and would show up
 * as a periodic stall on a slow connection — not something to inflict on someone in the
 * middle of a video call for a marginal gain.
 */
function startAutoOptimize(intervalMs = 10 * 60 * 1000) {
    stopAutoOptimize();
    autoTimer = setInterval(async () => {
        if (!store.getRuntime().autoOptimize) return;
        if (!core.isRunning()) return;           // nothing to optimise for
        try {
            const sniScan = await scanSnis({ timeout: 90000 });
            const snis = autoSelect(sniScan.rows, 'sni');
            const current = store.getNetwork().snis;
            if (snis && snis[0] && snis[0] !== current[0]) {
                store.setNetwork({ snis });
                log.info('scan', `بهینه‌سازی خودکار: SNI به ${snis[0]} تغییر کرد`);
                await core.restart();
            }
        } catch (e) {
            log.warn('scan', `بهینه‌سازی خودکار ناموفق بود: ${e.message}`);
        }
    }, intervalMs);
    if (autoTimer.unref) autoTimer.unref();
}

function stopAutoOptimize() {
    if (autoTimer) clearInterval(autoTimer);
    autoTimer = null;
}

module.exports = { scanIps, scanSnis, optimize, autoSelect, startAutoOptimize, stopAutoOptimize, parseTable };
