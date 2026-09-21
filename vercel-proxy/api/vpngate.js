/**
 * The VPN Gate server list, relayed.
 *
 * www.vpngate.net is unreachable from Iranian ISPs by every direct route: the domain is
 * DNS-poisoned to the 10.10.34.x block page, and connecting to the real address does not help
 * either — the operator's DPI reads the plaintext HTTP Host header and answers with the block
 * page ("type=Invalid Keyword"), while port 443 to those hosts is refused outright. So the list
 * has to be fetched by something outside that network. This is that something.
 *
 * Three things here matter more than they look:
 *
 * 1. THE UPSTREAM IS HARDCODED. The previous proxy took `?url=` and fetched whatever it was
 *    given, which is an open relay: anyone who saw the URL in a packet capture could push their
 *    own traffic through the account. On a Hobby plan that is also how the bandwidth quota
 *    disappears without a single one of your users being responsible for it.
 *
 * 2. IT CACHES AT THE EDGE. The list changes every few minutes at most, and every device asking
 *    for it wants the identical bytes. `s-maxage` means Vercel's CDN answers from cache without
 *    invoking this function or touching VPN Gate at all, so ten thousand devices cost one
 *    upstream fetch per window instead of ten thousand.
 *
 * 3. IT COMPRESSES. The CSV is ~1.3 MB of mostly base64 and gzips to roughly a third of that,
 *    which is the difference between ~77,000 and ~230,000 downloads inside the same 100 GB.
 */

export const config = { runtime: 'edge' };

const UPSTREAM = 'http://www.vpngate.net/api/iphone/';

/** How long the CDN may serve a cached copy before revalidating. */
const EDGE_TTL_SECONDS = 900;

/** How long it may keep serving a stale copy while it fetches a fresh one in the background. */
const STALE_TTL_SECONDS = 86400;

export default async function handler() {
  try {
    const upstream = await fetch(UPSTREAM, {
      headers: {
        // VPN Gate serves the plain CSV to ordinary clients; some datacentre ranges get a
        // challenge page without a normal UA.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/plain,*/*',
      },
      // Vercel's own fetch cache, separate from the CDN response cache below.
      cf: { cacheTtl: EDGE_TTL_SECONDS, cacheEverything: true },
    });

    if (!upstream.ok) {
      return new Response(`upstream ${upstream.status}`, {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    const body = await upstream.text();

    // A truncated or challenge-page response parses to zero servers on the client and looks
    // exactly like "VPN Gate has no servers today". Refuse it here instead.
    if (!body.includes('#HostName') || body.length < 10_000) {
      return new Response('upstream returned no server list', {
        status: 502,
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Cache-Control':
          `public, s-maxage=${EDGE_TTL_SECONDS}, stale-while-revalidate=${STALE_TTL_SECONDS}`,
        // The app reads this to know whether it got a fresh copy or a cached one.
        'X-Relay': 'vpngate',
      },
    });
  } catch (e) {
    return new Response(`relay error: ${e && e.message ? e.message : e}`, {
      status: 502,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
