/**
 * GST Relay Worker — one Worker, two jobs.
 *
 * This is the Cloudflare half of the Google Script Tunnel. It speaks the same
 * {k, m, u, h, b, ct, r} wire protocol as the Apps Script relay, which is what lets a
 * single deployment serve both roles the desktop app needs:
 *
 *   1. ANTI-SANCTION (setup only)
 *      app  ->  this Worker  ->  script.google.com
 *      Google Apps Script is sanctioned from Iran. During the wizard the app relays its
 *      own requests through the user's Worker so they can reach the script editor at
 *      all — no shared relay, no third-party server, just their own Cloudflare account.
 *
 *   2. ACCELERATION (normal use, optional per relay)
 *      Apps Script  ->  this Worker  ->  target site
 *      Apps Script forwards the fetch here instead of doing it itself. Per-call latency
 *      drops from ~250-500 ms (inside Apps Script) to ~10-50 ms at the CF edge, and the
 *      Apps Script runtime quota stretches because GAS now spends its time on one
 *      forward rather than on body fetch + base64 + header work.
 *
 * Wire protocol
 *   Single:  POST { k, m, u, h, b, ct, r }        -> { s, h, b }      (or { e })
 *   Batch:   POST { k, q: [ {m,u,h,b,ct,r}, ...]} -> { q: [ ... ] }
 *     k   shared secret (AUTH_KEY binding)   m  method, default GET
 *     u   absolute http(s) URL               h  request headers object
 *     b   base64 request body                ct content-type for b
 *     r   follow redirects, default true
 *     s   upstream status  h upstream headers  b base64 body  e error string
 *
 * The batch shape is what makes this worth deploying: Apps Script sends ONE request
 * carrying N URLs and this Worker fans them out with Promise.all, so an N-URL batch
 * costs 1 UrlFetchApp call instead of N. On a free Google account that is the
 * difference between 20k and ~20k*N daily requests.
 *
 * Anything that is not a valid authenticated POST gets a bland placeholder page, so a
 * scanner sweeping *.workers.dev cannot fingerprint this as a proxy.
 */

// The version of THIS script. «ام‌ال‌ام استور» reads it off the deployed copy through the Cloudflare
// API, since the Worker lives on the user's own account and outlives app updates. Bump it on any
// change to what this file does.
const WORKER_VERSION = 1;

// Matches the placeholder Apps Script itself returns for a bad key, so the two hops are
// indistinguishable from outside.
const DECOY_HTML =
  '<!DOCTYPE html><html><head><title>Web App</title></head>' +
  '<body><p>The script completed but did not return anything.</p></body></html>';

// Hop-by-hop headers plus anything that would leak the caller's real address. Forwarding
// x-forwarded-for would hand the destination the user's IP and defeat the whole point.
const SKIP_HEADERS = {
  host: 1, connection: 1, 'content-length': 1, 'transfer-encoding': 1,
  'proxy-connection': 1, 'proxy-authorization': 1, priority: 1, te: 1, upgrade: 1,
  'x-forwarded-for': 1, 'x-forwarded-host': 1, 'x-forwarded-proto': 1,
  'x-forwarded-port': 1, 'x-real-ip': 1, forwarded: 1, via: 1,
  'cf-connecting-ip': 1, 'cf-ipcountry': 1, 'cf-ray': 1, 'cf-visitor': 1,
};

// Largest response we will base64 and return. Workers have a 128 MB memory ceiling and
// base64 inflates by 4/3, so an unbounded read is an OOM waiting to happen on the first
// large download. 24 MB of body becomes ~32 MB of base64 and leaves room to spare.
const MAX_BODY_BYTES = 24 * 1024 * 1024;

// Guard against a batch large enough to blow the 30 s wall or the memory ceiling.
const MAX_BATCH = 64;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8' },
  });
}

function decoy() {
  return new Response(DECOY_HTML, {
    status: 200,
    headers: { 'content-type': 'text/html;charset=UTF-8' },
  });
}

function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;   // chunked so String.fromCharCode cannot blow the call stack
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Constant-time string compare. A plain !== leaks the shared secret one character at a
 * time to anyone who can measure response timing across many requests.
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function buildInit(item) {
  const headers = {};
  if (item.h && typeof item.h === 'object') {
    for (const k in item.h) {
      if (Object.prototype.hasOwnProperty.call(item.h, k) && !SKIP_HEADERS[k.toLowerCase()]) {
        headers[k] = item.h[k];
      }
    }
  }
  const init = {
    method: (item.m || 'GET').toUpperCase(),
    headers,
    redirect: item.r === false ? 'manual' : 'follow',
  };
  if (item.b) {
    init.body = b64ToBytes(item.b);
    if (item.ct) headers['content-type'] = item.ct;
  }
  return init;
}

async function relayOne(item, selfHost) {
  if (!item || typeof item !== 'object') return { e: 'bad item' };
  if (!item.u || typeof item.u !== 'string' || !/^https?:\/\//i.test(item.u)) {
    return { e: 'bad url' };
  }

  let target;
  try { target = new URL(item.u); } catch (_) { return { e: 'bad url' }; }

  // Refuse to fetch ourselves: a relay pointed at its own hostname recurses until the
  // Worker's subrequest limit kills it, burning the user's daily quota in one request.
  if (selfHost && target.hostname === selfHost) return { e: 'self-fetch blocked' };

  try {
    const resp = await fetch(target.toString(), buildInit(item));

    const headers = {};
    resp.headers.forEach((v, k) => { headers[k] = v; });

    const buf = new Uint8Array(await resp.arrayBuffer());
    if (buf.length > MAX_BODY_BYTES) {
      return { e: 'response too large (' + buf.length + ' bytes)', s: resp.status, h: headers };
    }
    return { s: resp.status, h: headers, b: bytesToB64(buf) };
  } catch (err) {
    return { e: 'fetch failed: ' + String((err && err.message) || err) };
  }
}

export default {
  async fetch(request, env) {
    // Only authenticated POSTs are real traffic. Everything else — GET probes, scanners,
    // a browser opening the URL — sees a placeholder page.
    if (request.method !== 'POST') return decoy();

    let req;
    try { req = await request.json(); } catch (_) { return decoy(); }

    if (!env.AUTH_KEY || !safeEqual(String(req.k || ''), String(env.AUTH_KEY))) {
      return decoy();
    }

    // Loop guard for the Apps Script -> Worker -> Apps Script case.
    if (request.headers.get('x-gst-hop') === '1') return json({ e: 'loop detected' }, 508);

    let selfHost = '';
    try { selfHost = new URL(request.url).hostname; } catch (_) { /* keep the empty default */ }

    if (Array.isArray(req.q)) {
      if (req.q.length > MAX_BATCH) return json({ e: 'batch too large' }, 400);
      const results = await Promise.all(req.q.map(it => relayOne(it, selfHost)));
      return json({ q: results });
    }

    return json(await relayOne(req, selfHost));
  },
};
