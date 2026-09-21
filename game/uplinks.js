// --- More than one internet connection ---
//
// WHY THIS IS WORTH BUILDING, AND WHY IT IS OURS TO BUILD CHEAPLY
// ExitLag's "Multi-Internet" runs up to four uplinks and fails over between them. It needs
// their own relay infrastructure to do it, and the reason is the interesting part: if the
// machine's uplink changes, its public address changes, and a game server that sees a new
// source address sees a different client. The session breaks. Their relay hides that,
// because the server only ever talks to the relay.
//
// WE GET THE SAME PROPERTY FOR FREE. Game traffic in boost mode leaves through the engine —
// WARP, a V2Ray node, the user's own relay — so the game server sees the ENGINE's address,
// never the user's. Swapping the underlying uplink is invisible to the game. That is not a
// clever trick we invented; it is a consequence of the architecture already in place, and it
// is what makes this feature a few hundred lines instead of a datacentre.
//
// THE TWO HONEST HALVES
//
//   1. COMPARING uplinks, which is safe and is the part nobody else gives an Iranian gamer.
//      A datagram bound to an adapter's own address leaves through that adapter (Windows has
//      used the strong host model since Vista), so both connections can be measured with the
//      real game-shaped train while the machine keeps using whichever it prefers. The only
//      complication is routing: the non-default uplink has no route to the target, so a
//      TEMPORARY /32 HOST ROUTE is added for the single anchor address and removed in a
//      finally. One destination. It cannot take the machine offline.
//
//   2. SWITCHING, which is a real change and is treated like one. It is done by interface
//      metric — Windows' own mechanism — with the original metrics written to disk BEFORE
//      the change, exactly as tweaks.js and shaper.js do. Nothing switches without a click.
//
// WHAT THIS DOES NOT DO
// It does not bond, and it does not duplicate packets across both uplinks. Duplication needs
// a de-duplicating exit point, which means the user's own relay — Mode 2. Sending the same
// datagram out two uplinks toward a game server would arrive as two different clients and
// break the session, which is precisely the failure this file's first paragraph describes.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const probe = require('./probe');
const catalog = require('./catalog');

const BACKUP_FILE = path.join(os.homedir(), '.mlmvpn', 'game-uplinks-backup.json');

// Adapters that are never a real internet uplink: they are this app's own tunnels, or
// somebody else's. Offering the user "switch your internet to the TAP adapter" would be
// offering them a loop.
const VIRTUAL = /tap-windows|tunnel|wintun|wireguard|tailscale|kerio|vpn client|virtual|loopback|bluetooth|hyper-v|vmware|virtualbox|mlmvpn/i;

function ps(script, timeoutMs = 25000) {
    return new Promise(resolve => {
        execFile('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
            (err, stdout, stderr) => {
                const out = (stdout || '').trim();
                if (!out) return resolve({ ok: !err, items: [], error: err ? (stderr || err.message) : null });
                try {
                    const parsed = JSON.parse(out);
                    resolve({ ok: true, items: Array.isArray(parsed) ? parsed : [parsed] });
                } catch {
                    resolve({ ok: !err, items: [], raw: out, error: err ? (stderr || err.message) : null });
                }
            });
    });
}

function loadBackup() {
    try { return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8')); } catch { return { v: 1, metrics: null }; }
}
function saveBackup(b) {
    fs.mkdirSync(path.dirname(BACKUP_FILE), { recursive: true });
    fs.writeFileSync(BACKUP_FILE, JSON.stringify(b, null, 2), 'utf8');
}

// ── what internet connections does this machine have? ────────────────────────────
//
// An uplink qualifies only if it has an IPv4 address AND a default gateway. An adapter with
// a 169.254.x address is a link that failed DHCP, and listing it as an option to switch to
// would hand the user a button that takes them offline.
const LIST_PS = `
$ErrorActionPreference='SilentlyContinue'
$out = @()
foreach ($cfg in Get-NetIPConfiguration) {
  $gw = $cfg.IPv4DefaultGateway.NextHop
  $ip = $cfg.IPv4Address.IPv4Address
  if (-not $gw -or -not $ip) { continue }
  if ($ip -like '169.254.*') { continue }
  $ad = $cfg.NetAdapter
  $ifc = Get-NetIPInterface -InterfaceIndex $cfg.InterfaceIndex -AddressFamily IPv4
  $out += [PSCustomObject]@{
    alias  = $cfg.InterfaceAlias
    index  = $cfg.InterfaceIndex
    desc   = $cfg.InterfaceDescription
    ip     = @($ip)[0]
    gw     = @($gw)[0]
    status = $ad.Status
    speed  = $ad.LinkSpeed
    metric = @($ifc.InterfaceMetric)[0]
    auto   = @($ifc.AutomaticMetric)[0]
  }
}
$out | ConvertTo-Json -Compress
`;

/** Classify by description, because the alias is whatever the user renamed it to. */
function kindOf(desc, alias) {
    const s = `${desc || ''} ${alias || ''}`;
    if (/wireless|wi-?fi|802\.11|wlan/i.test(s)) return { kind: 'wifi', fa: 'وای‌فای' };
    if (/cellular|mobile broadband|lte|5g|modem|huawei|zte/i.test(s)) return { kind: 'cellular', fa: 'مودم همراه' };
    if (/remote ndis|rndis|usb.*ethernet|tether/i.test(s)) return { kind: 'tether', fa: 'اتصال اینترنت گوشی (USB)' };
    return { kind: 'ethernet', fa: 'کابل' };
}

async function list() {
    const r = await ps(LIST_PS);
    const rows = (r.items || []).filter(x => x && x.ip && x.gw && !VIRTUAL.test(`${x.desc} ${x.alias}`));
    // The active uplink is the one Windows would use: lowest interface metric wins.
    const metrics = rows.map(x => Number(x.metric) || 9999);
    const best = metrics.length ? Math.min(...metrics) : null;
    let activeSeen = false;
    return rows.map(x => {
        const k = kindOf(x.desc, x.alias);
        const metric = Number(x.metric) || 9999;
        const active = !activeSeen && metric === best;
        if (active) activeSeen = true;
        return {
            id: String(x.index),
            alias: x.alias, desc: x.desc, ip: x.ip, gw: x.gw,
            index: Number(x.index), metric,
            automaticMetric: String(x.auto || '').toLowerCase() !== 'disabled',
            status: x.status, speed: x.speed || null,
            kind: k.kind, fa: k.fa,
            active,
        };
    });
}

// ── measuring one uplink without switching to it ─────────────────────────────────
//
// The route is added for a SINGLE /32 destination and removed in a finally. Even if this
// process is killed mid-measurement, the worst residue is one host route to a STUN server —
// which is why the anchor, and not the game server, is the target here.
function addHostRoute(ip, gw, index) {
    return ps(`$ErrorActionPreference='Stop'
route delete ${ip} 2>$null | Out-Null
route add ${ip} mask 255.255.255.255 ${gw} metric 1 if ${index} | Out-Null
[PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress`, 15000);
}

function delHostRoute(ip) {
    return ps(`$ErrorActionPreference='SilentlyContinue'
route delete ${ip} | Out-Null
[PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress`, 15000);
}

/**
 * Measure one uplink with the real game-shaped train.
 *
 * `uplink` is a row from list(). For the ACTIVE uplink no route is touched at all — the
 * machine already sends there — so the common case makes no system change whatsoever.
 */
async function measure(uplink, { seconds = 6, pps = 20, signal = null, anchor = null } = {}) {
    const a = anchor || catalog.UDP_ANCHORS[0];
    const ip = await probe.resolve4(a.host);
    let routed = false;

    const train = (bindAddress) => probe.udpTrain({
        host: a.host, ip, port: a.port, proto: 'stun',
        pps, seconds, warmupMs: 1000, signal, bindAddress,
    });

    try {
        // MEASURED 2026-08-20, with a tethered phone as the default route and Wi-Fi idle:
        // binding to the idle adapter's address alone reached the anchor — 46 samples, 41ms
        // min, zero loss — with NO route added and NO elevation. Windows picks the outgoing
        // interface from the bound source address, so the host route is not the normal path
        // at all. Adding it unconditionally would have made an admin prompt the price of a
        // measurement that does not need one.
        //
        // So: try the cheap way, and only fall back to a temporary route if nothing answers.
        let r = await train(uplink.ip);

        if (!r.ok && !uplink.active && !(signal && signal.aborted)) {
            const added = await addHostRoute(ip, uplink.gw, uplink.index);
            if (!added.ok) {
                return {
                    ok: false, uplinkId: uplink.id,
                    reason: 'این اینترنت از راه معمول پاسخ نداد، و راه دوم (یک مسیر موقت) دسترسی مدیر می‌خواهد. برنامه را «Run as administrator» باز کن.',
                };
            }
            routed = true;
            r = await train(uplink.ip);
        }

        return {
            ok: !!r.ok, uplinkId: uplink.id, fa: uplink.alias,
            min: r.min, p50: r.p50, p95: r.p95, p99: r.p99,
            jitter: r.jitter, spread: r.spread, loss: r.loss, spikes: r.spikes,
            n: r.n, score: r.score || 0, ppsAchieved: r.ppsAchieved,
            target: `${a.fa} (${a.host}:${a.port})`,
            reason: r.ok ? null : (r.error || 'پاسخی نیامد'),
        };
    } finally {
        if (routed) { try { await delHostRoute(ip); } catch { /* best effort */ } }
    }
}

/**
 * Compare every uplink.
 *
 * WHY THIS IS SEQUENTIAL, WHICH IS A CHOICE AND NOT A LIMIT.
 * Since binding alone reaches an idle uplink (no route, no elevation — measured), two
 * uplinks COULD be measured at the same moment, and that would be the methodologically
 * better answer: `probe.interleaved()` exists precisely because comparing two numbers taken
 * minutes apart on an Iranian international link compares the minutes, not the paths. What
 * stops it here is local, not remote: Windows' timer resolution already caps one train at
 * roughly 30 packets per second, and two trains on one machine contend for that same clock —
 * so a parallel run would measure the scheduler as much as the uplinks. Worth revisiting
 * with a single timer driving both sockets.
 *
 * Until then the honesty comes from a CONTROL PASS: the first uplink is measured again at
 * the end, and the drift between its two passes is reported. If one uplink moved more
 * between its own two measurements than the two uplinks differ from each other, the
 * comparison has not earned its conclusion — and the caller is told exactly that rather than
 * being handed a ranking that is really a story about the weather.
 */
async function compare({ seconds = 6, signal = null, onEvent = () => {} } = {}) {
    const ups = await list();
    const emit = (e) => { try { onEvent(e); } catch {} };
    if (!ups.length) throw new Error('هیچ اتصال اینترنتی سالمی پیدا نشد.');

    const results = [];
    emit({ type: 'start', total: ups.length + (ups.length > 1 ? 1 : 0) });

    for (const u of ups) {
        if (signal && signal.aborted) break;
        emit({ type: 'measuring', id: u.id, fa: u.alias });
        const r = await measure(u, { seconds, signal });
        results.push({ ...r, alias: u.alias, kind: u.kind, kindFa: u.fa, ip: u.ip, active: u.active });
        emit({ type: 'result', result: results[results.length - 1] });
    }

    // The control pass.
    let drift = null;
    if (ups.length > 1 && !(signal && signal.aborted)) {
        emit({ type: 'measuring', id: ups[0].id, fa: ups[0].alias, control: true });
        const again = await measure(ups[0], { seconds, signal });
        const first = results[0];
        if (again.ok && first.ok) {
            drift = {
                uplink: ups[0].alias,
                firstScore: first.score, secondScore: again.score,
                deltaScore: Math.abs((again.score || 0) - (first.score || 0)),
                firstP95: first.p95, secondP95: again.p95,
            };
        }
        emit({ type: 'control', drift });
    }

    const ranked = results.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    const usable = ranked.filter(r => r.ok);
    const best = usable[0] || null;
    const second = usable[1] || null;
    const gap = best && second ? (best.score || 0) - (second.score || 0) : null;

    // Does the comparison actually say anything? If the same uplink measured twice moved
    // more than the two uplinks differ, the honest answer is "this run cannot tell".
    const trustworthy = !drift || gap === null || drift.deltaScore < Math.max(4, gap);

    let verdict;
    if (!usable.length) {
        verdict = { code: 'none', tone: 'bad', title: 'هیچ اتصالی پاسخ نداد', reasons: ['هیچ‌کدام از اینترنت‌ها به لنگر UDP جواب ندادند.'] };
    } else if (usable.length === 1) {
        verdict = {
            code: 'single', tone: 'ok', title: 'فقط یک اینترنت سالم داری',
            reasons: [
                `${usable[0].alias}: min ${usable[0].min}ms · p95 ${usable[0].p95}ms · اتلاف ${usable[0].loss}٪ (امتیاز ${usable[0].score}).`,
                'برای اینکه این قابلیت معنا پیدا کند، یک اینترنت دوم لازم است — مثلاً هات‌اسپات گوشی با USB.',
            ],
        };
    } else if (!trustworthy) {
        verdict = {
            code: 'inconclusive', tone: 'warn', title: 'این مقایسه قابل اتکا نیست',
            reasons: [
                `«${drift.uplink}» بین دو سنجشِ خودش ${drift.deltaScore} امتیاز جابه‌جا شد، در حالی که اختلاف دو اینترنت ${gap} امتیاز بود.`,
                'یعنی خط در همان لحظه بی‌ثبات بوده، نه اینکه یکی بهتر از دیگری باشد. در زمان آرام‌تر دوباره بگیر.',
            ],
        };
    } else if (best.active) {
        verdict = {
            code: 'stay', tone: 'ok', title: 'همین اینترنتی که داری بهتر است',
            reasons: [
                `${best.alias}: min ${best.min}ms · p95 ${best.p95}ms (امتیاز ${best.score}) در برابر ${second.alias} با امتیاز ${second.score}.`,
                'کاری لازم نیست.',
            ],
        };
    } else {
        verdict = {
            code: 'switch', tone: 'ok', title: `«${best.alias}» برای بازی بهتر است`,
            reasons: [
                `${best.alias}: min ${best.min}ms · p95 ${best.p95}ms · اتلاف ${best.loss}٪ (امتیاز ${best.score}).`,
                `اینترنت فعلی (${second.alias}): min ${second.min}ms · p95 ${second.p95}ms (امتیاز ${second.score}).`,
                'چون ترافیک بازی از موتور بیرون می‌رود، سرور بازی IP موتور را می‌بیند نه IP تو — پس عوض کردن اینترنت زیرین نشست بازی را نمی‌شکند.',
            ],
        };
    }

    const report = { at: Date.now(), ranked, best, drift, trustworthy, verdict };
    emit({ type: 'done', report });
    return report;
}

// ── switching, which is a real change ────────────────────────────────────────────
//
// Done with interface metrics rather than by deleting and re-adding default routes: metrics
// are Windows' own way of expressing "prefer this one", they survive a DHCP renew, and they
// are one value per interface — which makes the restore exact.
async function prefer(uplinkId) {
    const ups = await list();
    const target = ups.find(u => u.id === String(uplinkId));
    if (!target) throw new Error('این اتصال دیگر وجود ندارد.');
    if (target.active) return { ok: true, already: true, alias: target.alias };

    const back = loadBackup();
    if (!back.metrics) {
        // The state of EVERY uplink, before anything changes. Recording only the two we
        // touch would leave the machine's preference order subtly different after a restore.
        back.metrics = ups.map(u => ({ index: u.index, alias: u.alias, metric: u.metric, automatic: u.automaticMetric }));
        try { saveBackup(back); }
        catch (e) { throw new Error('نتوانستم وضعیت فعلی را ذخیره کنم، پس تغییری هم نمی‌دهم: ' + e.message); }
    }

    const others = ups.filter(u => u.index !== target.index);
    const script = `$ErrorActionPreference='Stop'
Set-NetIPInterface -InterfaceIndex ${target.index} -AddressFamily IPv4 -InterfaceMetric 5
${others.map(o => `Set-NetIPInterface -InterfaceIndex ${o.index} -AddressFamily IPv4 -InterfaceMetric ${Math.max(20, o.metric)}`).join('\n')}
[PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress`;

    const r = await ps(script, 30000);
    if (!r.ok) {
        const raw = String(r.error || '');
        throw new Error(/denied|elevat/i.test(raw)
            ? 'عوض کردن اینترنت پیش‌فرض دسترسی مدیر می‌خواهد. برنامه را «Run as administrator» باز کن.'
            : 'عوض نشد: ' + (raw.split('\n')[0] || 'علت نامشخص'));
    }
    return { ok: true, alias: target.alias, note: 'اگر موتور روشن بود ممکن است چند ثانیه قطع و دوباره وصل شود؛ سرور بازی این تغییر را نمی‌بیند.' };
}

/** Put every interface metric back exactly as it was found. */
async function restore() {
    const back = loadBackup();
    if (!back.metrics || !back.metrics.length) throw new Error('چیزی برای برگرداندن ثبت نشده است.');

    const script = `$ErrorActionPreference='SilentlyContinue'
${back.metrics.map(m => m.automatic
        ? `Set-NetIPInterface -InterfaceIndex ${m.index} -AddressFamily IPv4 -AutomaticMetric Enabled`
        : `Set-NetIPInterface -InterfaceIndex ${m.index} -AddressFamily IPv4 -InterfaceMetric ${m.metric}`).join('\n')}
[PSCustomObject]@{ ok = $true } | ConvertTo-Json -Compress`;

    const r = await ps(script, 30000);
    if (!r.ok && r.error) throw new Error('برگرداندن ناموفق بود: ' + String(r.error).split('\n')[0]);
    back.metrics = null;
    saveBackup(back);
    return { ok: true };
}

function hasBackup() {
    const b = loadBackup();
    return !!(b.metrics && b.metrics.length);
}

// ── automatic failover ───────────────────────────────────────────────────────────
//
// This is the one thing in the whole «بازی» feature that ACTS ON ITS OWN, so it is fenced
// in on every side:
//
//   * It is opt-in. The switch is off until the user turns it on, and turning it on is a
//     click, exactly like every other change in this panel.
//   * It only runs WHILE ACCELERATION IS ON. Failing a user's machine over to another
//     internet connection when they are not even playing would be indefensible.
//   * It needs somewhere to go. With one uplink it is inert by construction — there is no
//     "better" connection to move to, and it will not thrash trying to find one.
//   * IT REQUIRES AGREEMENT ACROSS CHECKS. One bad sample on an Iranian mobile line is
//     Tuesday, not a failure. Three consecutive bad checks are a failure.
//   * It will not flap. After a switch it stays quiet for a cooldown, because the failure
//     mode of an eager failover is a machine that spends the match bouncing between two
//     connections and is worse than either one alone.
//
// It also does the cheap check, not the good one: a 2-second train at 10pps, which is
// enough to tell "this path is dead or collapsing" from "this path is fine". Deciding
// WHICH connection is better is the job of compare(), which the user runs deliberately.

const FAILOVER = {
    intervalMs: 20000,     // how often the active uplink is sampled
    seconds: 2,            // length of each cheap probe
    pps: 10,
    strikesNeeded: 3,      // consecutive bad checks before acting
    cooldownMs: 5 * 60 * 1000,
    // What counts as "bad". A dead path answers nothing; a collapsing one still answers but
    // its p95 has left the region where a game is playable.
    badP95: 400,
    badLoss: 12,
};

let watcher = null;

function watchStatus() {
    return watcher
        ? { on: true, strikes: watcher.strikes, lastSwitchAt: watcher.lastSwitchAt || null, checking: !!watcher.checking }
        : { on: false, strikes: 0, lastSwitchAt: null, checking: false };
}

/**
 * @param shouldRun  () => boolean   — the caller's gate; in practice "is boost on".
 * @param onEvent    (ev) => void    — surfaced to the panel, because a switch the user was
 *                                     not told about is indistinguishable from a bug.
 */
function startWatch({ shouldRun = () => false, onEvent = () => {}, log = () => {} } = {}) {
    if (watcher) return watchStatus();
    const emit = (e) => { try { onEvent(e); } catch {} };

    watcher = { strikes: 0, lastSwitchAt: 0, checking: false, timer: null };

    watcher.timer = setInterval(async () => {
        if (!watcher || watcher.checking) return;
        if (!shouldRun()) { watcher.strikes = 0; return; }

        watcher.checking = true;
        try {
            const ups = await list();
            const active = ups.find(u => u.active);
            // Nowhere to fail over to: stay quiet rather than measure something nobody can
            // act on. This is the ordinary case on a machine with one connection.
            if (!active || ups.length < 2) { watcher.strikes = 0; return; }

            const r = await measure(active, { seconds: FAILOVER.seconds, pps: FAILOVER.pps });
            const bad = !r.ok || (r.p95 || 0) >= FAILOVER.badP95 || (r.loss || 0) >= FAILOVER.badLoss;

            if (!bad) {
                if (watcher.strikes) emit({ type: 'recovered', alias: active.alias, p95: r.p95 });
                watcher.strikes = 0;
                return;
            }

            watcher.strikes++;
            emit({
                type: 'strike', strikes: watcher.strikes, needed: FAILOVER.strikesNeeded,
                alias: active.alias, p95: r.p95 || null, loss: r.loss || null, ok: r.ok,
            });
            if (watcher.strikes < FAILOVER.strikesNeeded) return;

            if (Date.now() - watcher.lastSwitchAt < FAILOVER.cooldownMs) {
                emit({ type: 'cooldown', alias: active.alias });
                return;
            }

            // Pick the alternative by measuring it, not by assuming it is better. Switching
            // onto a connection that is worse than the one being abandoned is the single
            // most damaging thing this loop could do.
            const others = ups.filter(u => !u.active);
            let best = null;
            for (const o of others) {
                const m = await measure(o, { seconds: FAILOVER.seconds, pps: FAILOVER.pps });
                if (m.ok && (!best || (m.score || 0) > (best.score || 0))) best = { ...m, uplink: o };
            }
            if (!best) { emit({ type: 'nowhere', alias: active.alias }); return; }

            log(`اینترنت «${active.alias}» خراب شد — جابه‌جایی به «${best.uplink.alias}»`);
            emit({ type: 'switching', from: active.alias, to: best.uplink.alias, score: best.score });
            try {
                await prefer(best.uplink.id);
                watcher.lastSwitchAt = Date.now();
                watcher.strikes = 0;
                emit({ type: 'switched', to: best.uplink.alias });
            } catch (err) {
                emit({ type: 'failed', error: err.message });
                log(`جابه‌جایی ناموفق: ${err.message}`);
            }
        } catch (err) {
            emit({ type: 'error', error: err && err.message ? err.message : String(err) });
        } finally {
            if (watcher) watcher.checking = false;
        }
    }, FAILOVER.intervalMs);

    if (watcher.timer.unref) watcher.timer.unref();
    emit({ type: 'watch-on' });
    return watchStatus();
}

function stopWatch() {
    if (!watcher) return watchStatus();
    clearInterval(watcher.timer);
    watcher = null;
    return watchStatus();
}

module.exports = {
    list, measure, compare, prefer, restore, hasBackup, kindOf,
    startWatch, stopWatch, watchStatus, FAILOVER,
    BACKUP_FILE, VIRTUAL,
};
