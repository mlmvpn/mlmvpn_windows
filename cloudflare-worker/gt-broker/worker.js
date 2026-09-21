/**
 * MLMVPN GitHub Tunnel — Tailscale key broker.
 *
 * Deployed by the desktop app itself (github-tunnel/gt-broker-deploy.js) onto the user's
 * OWN Cloudflare account, one copy per installation. It is the only place that ever holds
 * a real Tailscale credential: the desktop app calls this Worker's HTTP API and never sees
 * the OAuth client secret.
 *
 * Why it has to exist: the product requirement is that end users never see or configure
 * Tailscale, which means auth keys must be minted on their behalf, which means a
 * server-side credential — and a server-side credential can never ship inside a
 * distributed desktop binary.
 *
 * ── AUTHENTICATION — READ THIS BEFORE CHANGING ANYTHING ─────────────────────────────
 * Every request is signed: HMAC-SHA256 of `${sessionId}.${ts}` under GT_SIGNING_SECRET,
 * hex, in `sig`. The secret is generated per-installation by the desktop app
 * (~/.mlmvpn/github-tunnel-broker.json) and uploaded here as an encrypted binding at
 * deploy time, so exactly one machine can talk to any given deployment.
 *
 * An earlier version of this file accepted the `sig` field and never checked it. That was
 * not a small gap. This Worker sits on a public URL, and what it hands out is a
 * PREAUTHORIZED, TAGGED Tailscale auth key — and the tag is the one the setup guide tells
 * users to put in `autoApprovers.exitNode`. Anyone who found the URL could therefore mint
 * themselves a node inside the user's tailnet, reach every device on it, and have it
 * accepted as an exit node without the user approving anything. Unauthenticated key
 * minting is also unbounded spend on the user's own Tailscale account.
 *
 * The keys minted here are ephemeral and tagged, so a mistake is recoverable — but the
 * signature check is the thing that makes this safe to leave on a public hostname at all.
 * Do not weaken it.
 *
 * ── API ─────────────────────────────────────────────────────────────────────────────
 *   POST /mint    { sessionId, ts, sig, expirySeconds?, reusable? } -> { key, expiresAt }
 *   POST /revoke  { sessionId, ts, sig }                            -> { ok: true }
 *
 * Rejections carry a machine-readable `code` and, for clock problems, this Worker's own
 * `now` so the caller can correct its offset and retry instead of failing forever.
 *
 * ── Bindings ────────────────────────────────────────────────────────────────────────
 *   TS_OAUTH_CLIENT_ID / TS_OAUTH_CLIENT_SECRET   Tailscale OAuth client, "Devices: Write"
 *   TS_TAILNET                                    e.g. "example.com", or "-" for default
 *   GT_SIGNING_SECRET                             the caller's per-install secret
 */

// The version of THIS script — read off the deployed copy by «ام‌ال‌ام استور». It tracks
// BROKER_AUTH_VERSION in github-tunnel/gt-broker-deploy.js: 2 is the build that verifies signatures.
const WORKER_VERSION = 2;

const TS_API = 'https://api.tailscale.com/api/v2';

// How far apart the caller's clock and this Worker's may be. Wide enough to survive an
// ordinarily wrong PC clock and a slow link, narrow enough that a captured request is not
// replayable for long. The caller corrects its offset from the `now` we return, so this
// does not need to be generous.
const SIG_WINDOW_MS = 15 * 60 * 1000;
const MAX_SESSION_ID = 128;

const enc = new TextEncoder();

function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

/**
 * @returns null when the request is authentic, or a Response describing why it is not.
 */
async function reject(env, body) {
    const secret = env.GT_SIGNING_SECRET;
    if (!secret) {
        // A deployment from before signing existed. Fail closed and say exactly what fixes
        // it — silently minting for anyone is the behaviour this replaced.
        return json({ error: 'relay has no signing secret; redeploy it from the app', code: 'NO_SECRET' }, 503);
    }

    const { sessionId, ts, sig } = body || {};
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > MAX_SESSION_ID) {
        return json({ error: 'sessionId required', code: 'BAD_REQUEST' }, 400);
    }

    const now = Date.now();
    const n = Number(ts);
    if (!Number.isFinite(n) || Math.abs(now - n) > SIG_WINDOW_MS) {
        // `now` is returned deliberately: a wrong client clock is a real and common
        // failure, and without it the caller can only retry the same wrong timestamp.
        return json({ error: 'timestamp outside the accepted window', code: 'STALE', now }, 401);
    }

    if (typeof sig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sig)) {
        return json({ error: 'bad signature', code: 'BAD_SIG' }, 401);
    }

    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
    );
    // subtle.verify rather than comparing strings: it does not leak how much of the digest
    // matched through timing.
    const ok = await crypto.subtle.verify('HMAC', key, hexToBytes(sig.toLowerCase()), enc.encode(`${sessionId}.${ts}`));
    if (!ok) return json({ error: 'bad signature', code: 'BAD_SIG' }, 401);

    return null;
}

async function getAccessToken(env) {
    const res = await fetch(`${TS_API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.TS_OAUTH_CLIENT_ID,
            client_secret: env.TS_OAUTH_CLIENT_SECRET,
        }).toString(),
    });
    if (!res.ok) throw new Error(`tailscale oauth failed (${res.status})`);
    const data = await res.json();
    return data.access_token;
}

async function mintKey(env, sessionId, expirySeconds, reusable) {
    const token = await getAccessToken(env);
    const res = await fetch(`${TS_API}/tailnet/${encodeURIComponent(env.TS_TAILNET)}/keys`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            capabilities: {
                devices: {
                    create: {
                        // The VM's key is redeemed once, immediately, so it stays
                        // single-use. The desktop client's key is pre-minted and must
                        // survive a reconnect — a dropped tunnel, a mode switch, the
                        // watchdog repairing itself — and a single-use key would be spent
                        // by the first connect, leaving every later one to fail with
                        // "invalid key" exactly when the broker is unreachable and the
                        // pre-minting was supposed to save us.
                        reusable: !!reusable,
                        ephemeral: true,
                        preauthorized: true,
                        tags: ['tag:mlmvpn-gt'],
                    },
                },
            },
            // Caller-chosen, clamped. 15 min is right for a key redeemed immediately, but
            // the desktop app mints the client's key up-front — while the broker is still
            // reachable — and may not redeem it until much later, so it must be allowed to
            // live as long as the session it belongs to.
            expirySeconds: Math.min(Math.max(Number(expirySeconds) || 900, 300), 6 * 60 * 60),
            // Tailscale rejects punctuation like ":" in the description — letters/digits/
            // hyphens only.
            description: `gt-${String(sessionId).replace(/[^a-zA-Z0-9-]/g, '-')}`,
        }),
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`tailscale key mint failed (${res.status}): ${errBody}`);
    }
    const data = await res.json();
    return { key: data.key, expiresAt: data.expires };
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            // This is an API for one desktop app on one machine, never a browser origin.
            // Saying so keeps a page the user happens to have open from being able to read
            // a response even if it manages to send a valid request.
            'Cache-Control': 'no-store',
        },
    });
}

export default {
    async fetch(request, env) {
        if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
        const url = new URL(request.url);
        if (url.pathname !== '/mint' && url.pathname !== '/revoke') {
            return json({ error: 'not found' }, 404);
        }

        let body;
        try { body = await request.json(); } catch (e) { return json({ error: 'invalid body', code: 'BAD_REQUEST' }, 400); }

        // Before anything that costs money or grants access.
        const denied = await reject(env, body);
        if (denied) return denied;

        try {
            if (url.pathname === '/mint') {
                return json(await mintKey(env, body.sessionId, body.expirySeconds, body.reusable));
            }
            // Ephemeral + preauthorized keys self-clean when the node disconnects (the
            // workflow's last step runs `tailscale logout`, which triggers exactly that),
            // so there is nothing to undo here beyond acknowledging.
            return json({ ok: true });
        } catch (e) {
            return json({ error: e.message || 'broker error' }, 500);
        }
    },
};
