// Fast DoH relay worker (MLMVPN "DNS اختصاصی" — mode 2: سرعت/پینگ).
//
// The other worker (dns_worker.js) exists to STEER region: it rewrites every query
// with an EDNS Client Subnet option so game/CDN lookups resolve to a chosen country.
// That costs a full re-encode and pins the upstream to dns.google, the one big public
// resolver that honours a client-supplied ECS (RFC 7871).
//
// This worker does the opposite trade: no ECS, no rewriting — just the fastest possible
// answer. The query is passed through byte-for-byte to the closest healthy upstream and
// the answer is stored in Cloudflare's edge cache, so a repeated lookup is served from
// the colo the user is already connected to (sub-millisecond) instead of crossing the
// network again. That is where the ping win actually comes from: DNS latency disappears
// from connection setup, and every anti-filter benefit of DoH is kept.
//
// Endpoints:
//   GET|POST /dns-query   -> raw application/dns-message (RFC 8484; Xray's DoH client)
//   GET      /resolve?domain=<host> -> JSON {"Answer":[{"type":1,"data":"1.2.3.4"}]}
//                            (same contract as dns_worker.js, for the app's ping test)
//   GET      /health      -> JSON provider health, for the panel's diagnostics
// Anything else returns 404 with no body: the deployment should not look like a service.
//
// Bindings (all optional, plain text): DNS_MODE, CACHE_TTL_MIN, CACHE_TTL_MAX, TIMEOUT_MS.

// The version of THIS script. «ام‌ال‌ام استور» reads it off the deployed copy through the Cloudflare
// API to tell a worker deployed several releases ago from a current one — the worker lives on the
// user's own account and outlives app updates. Bump it on any change to what this file does, and
// add the previous build's SHA-256 to store/catalog.js if it shipped without this line.
const WORKER_VERSION = 1;

const DOH_PROVIDERS = [
  // Plain resolvers — no filtering, lowest latency.
  { name: "Cloudflare", url: "https://cloudflare-dns.com/dns-query",      weight: 20, group: "standard" },
  { name: "Google",     url: "https://dns.google/dns-query",              weight: 15, group: "standard" },
  { name: "Quad9",      url: "https://dns.quad9.net/dns-query",           weight: 15, group: "standard" },
  { name: "OpenDNS",    url: "https://doh.opendns.com/dns-query",         weight: 10, group: "standard" },
  // Ad/tracker blocking resolvers — same protocol, they just answer NXDOMAIN for ad hosts.
  { name: "AdGuard",    url: "https://dns.adguard.com/dns-query",         weight: 10, group: "adblock" },
  { name: "ControlD",   url: "https://freedns.controld.com/p2",           weight: 10, group: "adblock" },
  { name: "Mullvad",    url: "https://adblock.dns.mullvad.net/dns-query", weight: 10, group: "adblock" },
  { name: "NextDNS",    url: "https://dns.nextdns.io/dns-query",          weight: 10, group: "adblock" },
];

// "standard" is the default on purpose. Mixing filtered and unfiltered resolvers means
// the same domain resolves differently from one query to the next, which shows up as
// randomly broken sites — not as a feature.
const DEFAULTS = { DNS_MODE: "standard", CACHE_TTL_MIN: 30, CACHE_TTL_MAX: 300, TIMEOUT_MS: 4000 };

// Per-isolate health. Enough to steer away from a resolver that just failed without
// dragging in KV (a KV read would cost more latency than it saves).
const FAILURE_COOLDOWN_MS = 60_000;
const FAILURE_THRESHOLD = 2;
const health = new Map(); // name -> { failures, until }

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname.toLowerCase().replace(/\/+$/, "");

      if (path === "/dns-query") return await handleDohQuery(request, url, env, ctx);
      if (path === "/resolve")   return await handleResolve(url, env, ctx);
      if (path === "/health")    return serveHealth(env);
      return new Response(null, { status: 404 });
    } catch (e) {
      return new Response(`error: ${e && e.message ? e.message : e}`, { status: 500 });
    }
  },
};

function cfg(env, key) {
  const raw = env && env[key];
  if (raw === undefined || raw === null || raw === "") return DEFAULTS[key];
  const num = Number(raw);
  return Number.isFinite(num) && typeof DEFAULTS[key] === "number" ? num : raw;
}

// ---- /dns-query : byte-for-byte DoH passthrough + edge cache -----------------

async function handleDohQuery(request, url, env, ctx) {
  const isGet = request.method === "GET";
  const isPost = request.method === "POST";
  if (!isGet && !isPost) {
    return new Response("method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  }
  if (isGet && !url.searchParams.has("dns")) {
    return new Response("missing dns param", { status: 400 });
  }

  // Only GET is cacheable: the whole query is in the URL, so it is its own key.
  const cache = caches.default;
  const cacheKey = isGet ? new Request(canonicalCacheUrl(url), { method: "GET" }) : null;
  if (cacheKey) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      const headers = new Headers(hit.headers);
      headers.set("X-Cache", "HIT");
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  // Read the body ONCE. A Request body is a one-shot stream; re-reading it inside the
  // fallback loop is what silently turned every POST retry into an empty query.
  const body = isPost ? await request.arrayBuffer() : null;
  if (isPost && (!body || body.byteLength === 0)) {
    return new Response("empty dns body", { status: 400 });
  }

  const dnsParam = isGet ? url.searchParams.get("dns") : null;
  let lastError = null;

  for (const provider of orderedProviders(env)) {
    let upstream;
    try {
      upstream = await queryProvider(provider, request.method, dnsParam, body, cfg(env, "TIMEOUT_MS"));
    } catch (e) {
      lastError = e;
      markFailure(provider);
      continue;
    }

    if (!upstream.ok) {
      lastError = new Error(`${provider.name} -> HTTP ${upstream.status}`);
      // 5xx/429 means the resolver is unwell; 4xx means our query is malformed and
      // trying another resolver would just produce the same error more slowly.
      if (upstream.status >= 500 || upstream.status === 429) { markFailure(provider); continue; }
    } else {
      markSuccess(provider);
    }

    const ttl = resolveTtl(upstream, env);
    const headers = new Headers({
      "Content-Type": upstream.headers.get("Content-Type") || "application/dns-message",
      "Cache-Control": `public, max-age=${ttl}`,
      "X-DoH-Provider": provider.name,
      "X-Cache": "MISS",
    });
    const response = new Response(upstream.body, { status: upstream.status, headers });

    if (cacheKey && upstream.ok && ttl > 0) {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    }
    return response;
  }

  return new Response(`all resolvers failed${lastError ? `: ${lastError.message}` : ""}`, {
    status: 502,
    headers: { "Cache-Control": "no-store" },
  });
}

// Strip everything except ?dns= so cosmetic query-string differences (a stray &region=,
// a cache-buster) don't fragment the cache into single-use entries.
function canonicalCacheUrl(url) {
  const key = new URL(url.origin + "/dns-query");
  key.searchParams.set("dns", url.searchParams.get("dns"));
  return key.toString();
}

async function queryProvider(provider, method, dnsParam, body, timeoutMs) {
  // new URL() preserves a provider's own path (ControlD answers on /p2, not /dns-query);
  // string concatenation would have produced ".../p2?dns=" only by luck.
  const target = new URL(provider.url);
  if (method === "GET") target.searchParams.set("dns", dnsParam);

  // A fresh, minimal header set. Forwarding the client's headers leaked Cookie/Referer
  // to eight third-party resolvers and made some of them reject the request outright.
  const headers = new Headers({ Accept: "application/dns-message", "User-Agent": "Mozilla/5.0" });
  if (method === "POST") headers.set("Content-Type", "application/dns-message");

  // Without this, one hung resolver holds the whole lookup — and DNS is on the critical
  // path of every connection, so a stall here is felt as lag everywhere.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(target.toString(), {
      method,
      headers,
      body: method === "POST" ? body : null,
      redirect: "follow",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Honour the TTL the resolver actually returned instead of pinning every answer to a
// flat 5 minutes: a 30-second record cached for 5 minutes is a stale IP, and a 1-hour
// record cached for 5 minutes is 11 pointless round trips.
function resolveTtl(upstream, env) {
  const min = cfg(env, "CACHE_TTL_MIN");
  const max = cfg(env, "CACHE_TTL_MAX");
  const cc = upstream.headers.get("Cache-Control") || "";
  if (/no-store|no-cache/i.test(cc)) return 0;
  const m = cc.match(/max-age\s*=\s*(\d+)/i);
  if (!m) return min;
  const age = parseInt(m[1], 10);
  if (!Number.isFinite(age) || age <= 0) return 0;
  return Math.min(Math.max(age, min), max);
}

// ---- /resolve : JSON contract shared with dns_worker.js ---------------------

async function handleResolve(url, env, ctx) {
  const domain = (url.searchParams.get("domain") || "").trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) {
    return json({ Answer: [], error: "invalid domain" }, 400);
  }

  const query = buildQuery(domain);
  const dnsParam = bytesToBase64Url(query);
  let lastError = null;

  for (const provider of orderedProviders(env)) {
    try {
      const upstream = await queryProvider(provider, "GET", dnsParam, null, cfg(env, "TIMEOUT_MS"));
      if (!upstream.ok) { lastError = new Error(`HTTP ${upstream.status}`); markFailure(provider); continue; }
      markSuccess(provider);
      const ips = parseAnswers(new Uint8Array(await upstream.arrayBuffer()));
      return json({ Answer: ips.map((ip) => ({ type: 1, data: ip })), provider: provider.name }, 200);
    } catch (e) {
      lastError = e;
      markFailure(provider);
    }
  }
  return json({ Answer: [], error: String(lastError && lastError.message || "no resolver") }, 200);
}

// ---- provider selection + health -------------------------------------------

function activeProviders(env) {
  const mode = String(cfg(env, "DNS_MODE")).toLowerCase();
  if (mode === "all") return DOH_PROVIDERS;
  const pool = DOH_PROVIDERS.filter((p) => p.group === mode);
  return pool.length ? pool : DOH_PROVIDERS.filter((p) => p.group === "standard");
}

// Weighted pick first, then the rest of the healthy pool as fallbacks, then the ones in
// cooldown as a last resort — a degraded answer beats SERVFAIL.
function orderedProviders(env) {
  const pool = activeProviders(env);
  const now = Date.now();
  const healthy = pool.filter((p) => !isCoolingDown(p, now));
  const cooling = pool.filter((p) => isCoolingDown(p, now));
  if (!healthy.length) return shuffle(cooling);
  const first = weightedPick(healthy);
  return [first, ...shuffle(healthy.filter((p) => p !== first)), ...cooling];
}

function weightedPick(providers) {
  const total = providers.reduce((sum, p) => sum + p.weight, 0);
  let r = Math.random() * total;
  for (const p of providers) {
    if (r < p.weight) return p;
    r -= p.weight;
  }
  return providers[providers.length - 1];
}

function shuffle(list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function isCoolingDown(provider, now = Date.now()) {
  const s = health.get(provider.name);
  return !!s && s.until > now;
}

function markFailure(provider) {
  const s = health.get(provider.name) || { failures: 0, until: 0 };
  s.failures += 1;
  if (s.failures >= FAILURE_THRESHOLD) { s.until = Date.now() + FAILURE_COOLDOWN_MS; s.failures = 0; }
  health.set(provider.name, s);
}

function markSuccess(provider) {
  health.delete(provider.name);
}

function serveHealth(env) {
  const now = Date.now();
  return json({
    mode: String(cfg(env, "DNS_MODE")).toLowerCase(),
    cacheTtl: { min: cfg(env, "CACHE_TTL_MIN"), max: cfg(env, "CACHE_TTL_MAX") },
    timeoutMs: cfg(env, "TIMEOUT_MS"),
    providers: activeProviders(env).map((p) => {
      const s = health.get(p.name);
      const down = s && s.until > now;
      return { name: p.name, group: p.group, weight: p.weight, status: down ? "cooldown" : "ok",
               cooldownMs: down ? s.until - now : 0 };
    }),
  }, 200);
}

// ---- DNS wire-format helpers (same shape as dns_worker.js, minus ECS) -------

// A-record query, no EDNS/OPT record: this worker deliberately sends the query exactly
// as a plain client would, which is also what makes it cacheable across users.
function buildQuery(domain) {
  const bytes = [];
  const id = (Math.random() * 0xffff) & 0xffff;
  bytes.push((id >> 8) & 0xff, id & 0xff);
  bytes.push(0x01, 0x00); // recursion desired
  bytes.push(0x00, 0x01); // QDCOUNT = 1
  bytes.push(0x00, 0x00); // ANCOUNT
  bytes.push(0x00, 0x00); // NSCOUNT
  bytes.push(0x00, 0x00); // ARCOUNT
  for (const label of domain.split(".")) {
    if (!label) continue;
    const enc = new TextEncoder().encode(label);
    bytes.push(enc.length);
    for (const b of enc) bytes.push(b);
  }
  bytes.push(0x00);       // end of name
  bytes.push(0x00, 0x01); // QTYPE A
  bytes.push(0x00, 0x01); // QCLASS IN
  return new Uint8Array(bytes);
}

function parseAnswers(data) {
  const ips = [];
  try {
    if (data.length < 12) return ips;
    const qdcount = (data[4] << 8) | data[5];
    const ancount = (data[6] << 8) | data[7];
    if (ancount === 0) return ips;

    let pos = 12;
    for (let q = 0; q < qdcount; q++) {
      while (pos < data.length) { const len = data[pos++]; if (len === 0) break; pos += len; }
      pos += 4; // type + class
    }
    for (let a = 0; a < ancount; a++) {
      if (pos >= data.length) break;
      if ((data[pos] & 0xc0) === 0xc0) pos += 2;
      else { while (pos < data.length) { const len = data[pos++]; if (len === 0) break; pos += len; } }
      if (pos + 10 > data.length) break;
      const type = (data[pos] << 8) | data[pos + 1];
      pos += 8; // type(2) + class(2) + ttl(4)
      const rdlength = (data[pos] << 8) | data[pos + 1];
      pos += 2;
      if (type === 1 && rdlength === 4) {
        ips.push(`${data[pos]}.${data[pos + 1]}.${data[pos + 2]}.${data[pos + 3]}`);
      }
      pos += rdlength;
    }
  } catch (_) { /* return whatever parsed so far */ }
  return ips;
}

function bytesToBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json;charset=utf-8", "Cache-Control": "no-store" },
  });
}
