// --- GitHub Tunnel: Tailscale key broker client ---
// The app must never hold a Tailscale credential of any kind — not an auth key, not an
// API token. Instead it calls a small Cloudflare Worker (source + deploy notes in
// cloudflare-worker/gt-broker/) that holds the Tailscale OAuth client and mints a
// tagged, short-lived auth key per session on request.
//
// The broker is authenticated per-request with an HMAC over {sessionId, ts} using a secret
// generated locally per-install (gt-secret.js) and handed to the Worker as an encrypted
// binding when it is deployed — so a stolen broker URL on its own cannot mint keys. That
// matters more than it sounds: the keys are pre-authorized and carry a tag the user's ACL
// auto-approves as an exit node, so anyone who could mint one could put their own machine
// inside the user's tailnet.

const { gtFetch } = require('./gt-net');
const { sign } = require('./gt-secret');

function resolveBrokerUrl() {
    if (process.env.MLMVPN_GT_BROKER_URL) return process.env.MLMVPN_GT_BROKER_URL;
    try { return require('./gt-broker-deploy').getBrokerUrl(); } catch (e) { return ''; }
}

// How far this machine's clock is from the Worker's, in ms. The signature covers a
// timestamp and the Worker refuses anything outside a window, so a PC whose clock is off —
// common enough on the machines this app runs on that gt-github.js already corrects for it
// against GitHub's Date header — could otherwise never mint a key, and the error would say
// "signature" when the real answer is "your clock is wrong". The Worker reports its own
// time when it rejects one, so this is learned rather than guessed.
let brokerClockOffsetMs = 0;
function brokerNow() { return Date.now() + brokerClockOffsetMs; }

async function callOnce(pathname, body) {
    const brokerUrl = resolveBrokerUrl();
    if (!brokerUrl) {
        throw Object.assign(new Error('سرویس شبکه‌ی امن هنوز راه‌اندازی نشده است.'), { code: 'BROKER_NOT_DEPLOYED' });
    }
    // gtFetch, not fetch: workers.dev is routinely blocked, and this call is the one
    // thing a session cannot be built without. See gt-net.js.
    const res = await gtFetch(`${brokerUrl}${pathname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
        const err = new Error(brokerMessage(res.status, data));
        err.status = res.status;
        err.brokerCode = (data && data.code) || '';
        err.brokerNow = Number(data && data.now) || 0;
        // Tagged so the account pool can tell "this GitHub account is the problem" from
        // "the relay every account shares is down". Without the distinction, one broker
        // outage walks the whole pool, marks every healthy account as failed, and leaves
        // the user with ten accounts in cooldown over a fault none of them had.
        err.code = 'BROKER_UNAVAILABLE';
        // ...except this one, which is neither the relay nor the account: Tailscale itself
        // refuses the tag because the user's ACL file does not define it yet. Retrying,
        // rotating accounts, or redeploying cannot fix it — one editing step can. It must
        // therefore escape the pool's failure handling entirely.
        if (/invalid or not permitted|requested tags/i.test(String(data && data.error || ''))) {
            err.code = 'ACL_TAG_NOT_PERMITTED';
            err.message = 'تگ دسترسی در حساب Tailscale شما هنوز تعریف نشده است — فایل تنظیمات دسترسی (ACL) باید یک‌بار ویرایش شود.';
        }
        throw err;
    }
    return data;
}

/** Broker failures the user can actually act on, named as such. A relay deployed by an
 *  older build has no signing secret at all, and "500" tells nobody what to do about it. */
function brokerMessage(status, data) {
    const code = (data && data.code) || '';
    if (code === 'NO_SECRET') {
        return 'سرویس شبکه‌ی امن بدون کلید امنیتی راه‌اندازی شده است (نسخه‌ی قدیمی). یک‌بار «تنظیمات سرویس شبکه‌ی امن» را باز کنید و «به‌روزرسانی و ادامه» بزنید.';
    }
    if (code === 'BAD_SIG') {
        return 'سرویس شبکه‌ی امن با این نصب هماهنگ نیست (کلید امنیتی متفاوت است). یک‌بار «تنظیمات سرویس شبکه‌ی امن» را باز کنید و «به‌روزرسانی و ادامه» بزنید.';
    }
    return (data && data.error) || `اتصال به سرویس شبکه‌ی امن ناموفق بود (${status}).`;
}

async function call(pathname, payload) {
    const send = () => {
        const ts = brokerNow();
        return callOnce(pathname, { ...payload, ts, sig: sign(payload.sessionId, ts) });
    };
    try {
        return await send();
    } catch (e) {
        // One retry, for the one failure a retry can fix. The offset is known now, so a
        // second STALE means something other than the clock is wrong.
        if (e.brokerCode === 'STALE' && e.brokerNow) {
            brokerClockOffsetMs = e.brokerNow - Date.now();
            return send();
        }
        throw e;
    }
}

/** Mints an ephemeral, pre-tagged Tailscale auth key for exactly one session. */
async function mintAuthKey(sessionId, expirySeconds, reusable) {
    return call('/mint', { sessionId, expirySeconds, reusable });
}

/** Best-effort: tells the broker the session is over so it can expire/revoke the node early. */
async function revokeSession(sessionId) {
    try { await call('/revoke', { sessionId }); } catch (e) {}
}

module.exports = { mintAuthKey, revokeSession, resolveBrokerUrl };
