// --- GST: opening the road to Google ---
// script.google.com is sanctioned from Iran, so before the user can create their Apps
// Script deployment the app has to get them there. This module owns that, and it owns
// it SILENTLY: the panel says "opening access to Google…" and the user makes no
// decision about sanctions, relays or DNS.
//
// Four steps, tried in order, each logged in Persian so a stall is diagnosable:
//   1. direct        — many connections already work; try before changing anything
//   2. user's Worker — their own Cloudflare, the fastest and most private option, and
//                      the reason the wizard deploys the Worker before touching Google
//   3. sanction-buster — the existing UAE relay, the fallback for "simple mode" users
//                        who chose not to use Cloudflare at all
//   4. manual        — tell the user plainly and let them use any VPN for one page
//
// Whatever step 3 changes is remembered and undone by restore(), so a user who already
// had the sanction-buster running keeps it, and one who did not gets their machine back
// exactly as it was.

const https = require('https');
const store = require('./gst-config');
const test = require('./gst-test');
const log = require('./gst-log');
const gstDns = require('./gst-dns');

const GOOGLE_HOSTS = ['script.google.com', 'script.googleusercontent.com'];

// What the sanction-buster looked like before we touched it. null = we have not
// changed anything, so restore() has nothing to undo.
let priorSanctionState = null;

/**
 * Relay a probe of script.google.com through a Worker.
 * Reuses the same {k,u,m} protocol the tunnel itself uses — the Worker cannot tell this
 * apart from ordinary traffic, which is exactly why one Worker can serve both jobs.
 */
async function reachViaWorker(relay) {
    if (!relay || !relay.workerUrl || !relay.cfAuthKey) return null;

    const probe = await test.probeEndpoint(relay.workerUrl, relay.cfAuthKey, {
        label: 'worker-reach',
        timeout: 20000,
    });
    if (probe.state !== 'ok' && probe.state !== 'slow') return null;

    // The Worker answers; now ask it to fetch Google specifically. A Worker that is
    // healthy but blocked from google.com would otherwise look like success here.
    const relayed = await relayThroughWorker(relay, 'https://script.google.com/');
    return relayed;
}

function relayThroughWorker(relay, targetUrl) {
    return new Promise(resolve => {
        let u;
        try { u = new URL(relay.workerUrl); } catch (e) { return resolve(null); }

        const body = Buffer.from(JSON.stringify({
            k: relay.cfAuthKey, m: 'GET', u: targetUrl, h: {}, r: true,
        }), 'utf8');

        const req = https.request({
            hostname: u.hostname,
            port: u.port || 443,
            path: u.pathname === '/' ? '/' : u.pathname,
            method: 'POST',
            timeout: 20000,
            headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
            // The Worker's own hostname is the thing most likely to be DNS-blocked here.
            lookup: gstDns.lookup,
        }, res => {
            const chunks = [];
            res.on('data', d => { if (chunks.length < 40) chunks.push(d); });
            res.on('end', () => {
                try {
                    const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    // Any HTTP answer from Google proves the path is open — a 302 to a
                    // login page still means we reached them.
                    if (json && typeof json.s === 'number') return resolve({ status: json.s });
                    resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

/**
 * Turn the sanction-buster on, making sure our two Google hosts are in its domain list.
 * Loaded lazily so this module works even in a build where the feature is absent.
 */
async function enableSanctionBuster() {
    let sanction;
    try {
        sanction = require('../sanction-manager');
    } catch (e) {
        log.warn('reach', 'ماژول تحریم‌شکن در دسترس نیست');
        return false;
    }

    try {
        // API surface of sanction-manager.js: isEnabled / enableSanction /
        // disableSanction / autoAddDomain / isInAllowlist.
        const wasEnabled = !!sanction.isEnabled();

        // Remember the state BEFORE the first change, and only once: a second call must
        // not overwrite the original state with the one we just created.
        if (priorSanctionState === null) priorSanctionState = { enabled: wasEnabled };

        // Make sure the two Google hosts are actually routed. Without this the relay
        // comes up but still will not carry script.google.com, which looks like the
        // sanction-buster "not working" when it is simply not configured for them.
        for (const host of GOOGLE_HOSTS) {
            if (!sanction.isInAllowlist(host)) {
                sanction.autoAddDomain(host, 'Google Apps Script');
                log.info('reach', `${host} به فهرست تحریم‌شکن اضافه شد`);
            }
        }

        if (!wasEnabled) {
            await sanction.enableSanction();
            log.info('reach', 'تحریم‌شکن موقتاً روشن شد');
        }
        return true;
    } catch (e) {
        log.warn('reach', `روشن کردن تحریم‌شکن ناموفق بود: ${e.message}`);
        return false;
    }
}

/**
 * Put the sanction-buster back the way we found it.
 * Called at the end of the wizard. Silent by design: the user was never asked to turn
 * it on, so they should not be asked to turn it off either.
 */
async function restore() {
    if (priorSanctionState === null) return { restored: false, reason: 'چیزی تغییر نکرده بود' };

    const wanted = priorSanctionState;
    priorSanctionState = null;

    if (wanted.enabled) {
        // It was already on before us — leave it exactly as the user had it.
        return { restored: false, reason: 'تحریم‌شکن از قبل روشن بود و دست‌نخورده ماند' };
    }

    try {
        const sanction = require('../sanction-manager');
        await sanction.disableSanction();
        log.info('reach', 'تحریم‌شکن به حالت اولیه برگشت (خاموش)');
        return { restored: true };
    } catch (e) {
        log.warn('reach', `بازگرداندن تحریم‌شکن ناموفق بود: ${e.message}`);
    }
    return { restored: false, reason: 'خاموش کردن ممکن نشد' };
}

/**
 * Try, in order, until script.google.com is reachable.
 *
 * @param onStep optional (step, status, message) => void for live wizard feedback
 * @returns { reachable, via, steps[], message }
 */
async function open({ onStep = () => {} } = {}) {
    const steps = [];
    const note = (step, status, message) => {
        steps.push({ step, status, message });
        (status === 'ok' ? log.ok : status === 'fail' ? log.info : log.warn)('reach', message);
        onStep(step, status, message);
    };

    // 1) Direct.
    const direct = await test.testGoogleReachable();
    if (direct.reachable) {
        note('direct', 'ok', `دسترسی مستقیم به گوگل باز است (${direct.latency}ms)`);
        return { reachable: true, via: 'direct', steps, message: 'دسترسی به گوگل باز است.' };
    }
    note('direct', 'fail', `دسترسی مستقیم به گوگل بسته است${direct.error ? ` (${direct.error})` : ''}`);

    // 2) The user's own Worker — preferred: their Cloudflare, their privacy, lowest latency.
    const withWorker = store.getRelays().filter(r => r.workerUrl && r.cfAuthKey);
    for (const relay of withWorker) {
        const via = await reachViaWorker(relay);
        if (via) {
            note('worker', 'ok', `از طریق Worker ریلی «${relay.name}» به گوگل رسیدیم (کد ${via.status})`);
            return {
                reachable: true,
                via: 'worker',
                relayId: relay.id,
                workerUrl: relay.workerUrl,
                steps,
                message: 'دسترسی به گوگل از طریق کلادفلر خودتان باز شد.',
            };
        }
        note('worker', 'fail', `Worker ریلی «${relay.name}» نتوانست به گوگل برسد`);
    }
    if (!withWorker.length) {
        note('worker', 'skip', 'هنوز Worker کلادفلری ساخته نشده — این مرحله رد شد');
    }

    // 3) The shared UAE relay. Only a fallback: it is someone else's server, and the
    //    plan is to be able to retire it without breaking this feature.
    const sanctionOk = await enableSanctionBuster();
    if (sanctionOk) {
        // Give the DNS/route change a moment before judging it.
        await new Promise(r => setTimeout(r, 1500));
        const after = await test.testGoogleReachable();
        if (after.reachable) {
            note('sanction', 'ok', `با تحریم‌شکن به گوگل رسیدیم (${after.latency}ms)`);
            return {
                reachable: true,
                via: 'sanction',
                steps,
                message: 'دسترسی به گوگل باز شد.',
            };
        }
        note('sanction', 'fail', 'تحریم‌شکن هم نتوانست دسترسی به گوگل را باز کند');
    }

    // 4) Out of options — say so plainly instead of leaving the wizard spinning.
    note('manual', 'fail', 'هیچ‌کدام از راه‌های خودکار جواب نداد');
    return {
        reachable: false,
        via: null,
        steps,
        message: 'فعلاً نمی‌توانیم به گوگل برسیم. اگر VPN دیگری دارید یک لحظه روشن کنید و ' +
                 'دکمه‌ی «تلاش مجدد» را بزنید — بعد از ساخت اسکریپت دیگر به آن نیازی نیست.',
    };
}

module.exports = { open, restore, GOOGLE_HOSTS };
