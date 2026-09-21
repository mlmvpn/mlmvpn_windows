// --- Split-tunnel route tables ---
//
// Three destinations, three treatments. Getting a site into the wrong bucket is either a
// site that will not open, or speed thrown away for nothing:
//
//   DIRECT  Iranian services. Blocked by nobody; their servers are next door. Sending them
//           through a tunnel is pure added latency, and many refuse foreign IPs outright.
//   DNS     Sites reachable at full speed once the answer is honest — Iran's block is a
//           forged DNS reply, nothing more. These also go DIRECT; the honest answer comes
//           from the dedicated DoH worker. No tunnel needed, so no tunnel is used.
//   TUNNEL  Sites blocked at the IP or TLS-SNI layer, and sites that refuse Iranian IPs.
//           No DNS trick reaches these; only a foreign exit does.
//
// The lists are inline rather than geosite/geoip rule-sets on purpose: sing-box 1.12
// dropped the legacy .dat format, and remote rule-sets need a working internet connection
// to fetch — which is exactly what the user does not have when this feature is off.

// ── DIRECT ───────────────────────────────────────────────────────────────────
// Iranian services on non-.ir domains. The `.ir` TLD itself is matched by suffix, so only
// the exceptions need listing here.
const IRAN_DOMAINS = [
    'digikala.com', 'aparat.com', 'varzesh3.com', 'filimo.com', 'namava.ir',
    'snapp.ir', 'snapp.market', 'snappfood.ir', 'tapsi.ir', 'divar.ir',
    'sheypoor.com', 'torob.com', 'basalam.com', 'zarinpal.com', 'shaparak.ir',
    'blogfa.com', 'blog.ir', 'mihanblog.com', 'telewebion.com', 'cafebazaar.ir',
    'myket.ir', 'sibapp.com', 'bmi.ir', 'bankmellat.ir', 'bank-maskan.ir',
    'irancell.ir', 'mci.ir', 'rightel.ir', 'tci.ir', 'shatel.ir',
    'arvancloud.ir', 'arvancloud.com', 'abrarvan.com', 'parspack.com', 'iranserver.com',
    'yektanet.com', 'sabavision.com', 'clickyab.com', 'mediaad.org',
    'eitaa.com', 'bale.ai', 'rubika.ir', 'igap.net',
];

// ── TUNNEL ───────────────────────────────────────────────────────────────────
// Blocked in Iran at the IP/SNI layer. Clean DNS does not reach these; only a foreign exit
// does. This is the list that decides whether "open every site" is true.
const FILTERED_DOMAINS = [
    // video / social
    'youtube.com', 'youtu.be', 'ytimg.com', 'googlevideo.com', 'youtube-nocookie.com',
    'facebook.com', 'fbcdn.net', 'fb.com', 'messenger.com',
    'instagram.com', 'cdninstagram.com',
    'twitter.com', 'x.com', 'twimg.com', 't.co',
    'tiktok.com', 'tiktokcdn.com', 'byteoversea.com',
    'snapchat.com', 'sc-cdn.net',
    'reddit.com', 'redd.it', 'redditstatic.com', 'redditmedia.com',
    'pinterest.com', 'pinimg.com',
    'tumblr.com', 'medium.com', 'quora.com',
    'twitch.tv', 'ttvnw.net', 'jtvnw.net',
    'vimeo.com', 'dailymotion.com',
    // messaging
    'telegram.org', 't.me', 'telegram.me', 'telesco.pe', 'cdn-telegram.org',
    'whatsapp.com', 'whatsapp.net',
    'signal.org', 'signalusercontent.org',
    'discord.com', 'discordapp.com', 'discordapp.net', 'discord.gg', 'discordcdn.com',
    'skype.com', 'viber.com', 'line.me',
    // media
    'spotify.com', 'scdn.co', 'spotifycdn.com',
    'soundcloud.com', 'sndcdn.com',
    'netflix.com', 'nflxvideo.net', 'nflximg.net',
    'hulu.com', 'disneyplus.com', 'primevideo.com',
    'imdb.com',
    // news
    'bbc.com', 'bbc.co.uk', 'bbci.co.uk',
    'cnn.com', 'nytimes.com', 'theguardian.com', 'reuters.com', 'dw.com',
    'voanews.com', 'radiofarda.com', 'iranintl.com', 'manototv.com',
    // reference / tools commonly blocked
    'wikipedia.org', 'wikimedia.org', 'archive.org',
    'blogspot.com', 'blogger.com', 'wordpress.com', 'wordpress.org',
    'duckduckgo.com', 'startpage.com',
    'torproject.org', 'speedtest.net',
];

// Services that refuse Iranian IPs (sanctions). Different cause, same cure: a foreign exit.
const SANCTIONED_DOMAINS = [
    'openai.com', 'chatgpt.com', 'oaistatic.com', 'oaiusercontent.com',
    'anthropic.com', 'claude.ai',
    'gemini.google.com', 'bard.google.com', 'aistudio.google.com', 'generativelanguage.googleapis.com',
    'perplexity.ai', 'copilot.microsoft.com',
    'github.com', 'githubusercontent.com', 'githubassets.com', 'github.io',
    'gitlab.com', 'bitbucket.org',
    'docker.com', 'docker.io',
    'npmjs.org', 'npmjs.com', 'yarnpkg.com',
    'pypi.org', 'pythonhosted.org',
    'nuget.org', 'gradle.org',
    'jetbrains.com', 'visualstudio.com', 'vscode-cdn.net',
    'developer.android.com', 'flutter.dev', 'dart.dev',
    'oracle.com', 'java.com',
    'unity.com', 'unity3d.com', 'unrealengine.com',
    'steampowered.com', 'steamcommunity.com', 'steamstatic.com',
    'epicgames.com', 'ubisoft.com', 'ea.com', 'battle.net', 'blizzard.com',
    'playstation.com', 'xbox.com', 'nintendo.com',
    'cloudflare.com', 'digitalocean.com', 'linode.com', 'vultr.com', 'heroku.com',
    'amazonaws.com', 'azure.com', 'cloud.google.com',
    'stripe.com', 'paypal.com', 'coinbase.com', 'binance.com',
    'slack.com', 'notion.so', 'figma.com', 'canva.com',
    'zoom.us', 'coursera.org', 'udemy.com', 'edx.org',
    'stackoverflow.com', 'stackexchange.com',
];

// Ad and tracker hosts. Rejecting them is the cheapest speed win available: the page stops
// waiting on requests whose best possible outcome is a wasted round trip.
const AD_DOMAINS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'google-analytics.com', 'adservice.google.com',
    'adnxs.com', 'adsrvr.org', 'criteo.com',
    'scorecardresearch.com', 'quantserve.com', 'outbrain.com', 'taboola.com',
    'moatads.com', 'mixpanel.com', 'hotjar.com',
];

// Windows' own connectivity probe. NlaSvc decides whether the network icon says
// "connected" from these; anything a tunnel does to them reads as a captive portal, and the
// adapter is flagged offline while traffic is in fact flowing.
const PROBE_DOMAINS = ['msftconnecttest.com', 'msftncsi.com'];

/**
 * Merge the built-in tables with the user's own overrides.
 *
 * A user entry always wins and lands in exactly one bucket: putting a domain in `direct`
 * must be able to pull it out of the built-in tunnel list, or the override is decorative.
 */
function resolveRoutes(overrides = {}) {
    const userDirect = normalize(overrides.direct);
    const userTunnel = normalize(overrides.tunnel);
    const userBlock = normalize(overrides.block);

    // Verdicts learned by probing real connections. They are merged in as equals to the
    // built-in tables: the tables are a head start, not the limit of what this can know.
    // A site measured as blocked yesterday is routed through the tunnel today without the
    // measurement being repeated.
    let learned = { iran: [], 'dns-poisoned': [], filtered: [], sanctioned: [], clean: [] };
    if (overrides.useCache !== false) {
        try { learned = require('./route-cache').byVerdict(); } catch (e) { /* cache is optional */ }
    }

    // 'dns-poisoned' and 'clean' both go direct: the first is fixed by an honest answer
    // from the DoH worker, the second was never broken. Neither needs a tunnel, and using
    // one would cost speed for nothing.
    const learnedDirect = [...learned.iran, ...learned['dns-poisoned'], ...learned.clean];
    const learnedTunnel = [...learned.filtered, ...learned.sanctioned];

    const tunnel = dedupe([...FILTERED_DOMAINS, ...SANCTIONED_DOMAINS, ...learnedTunnel, ...userTunnel])
        .filter((d) => !userDirect.includes(d));
    const direct = dedupe([...IRAN_DOMAINS, ...learnedDirect, ...userDirect])
        // A user override wins outright; a learned verdict loses to the built-in tunnel
        // list, which was written from known-good knowledge rather than one measurement.
        .filter((d) => !userTunnel.includes(d) && !tunnel.includes(d));
    const block = dedupe([...AD_DOMAINS, ...userBlock])
        .filter((d) => !userDirect.includes(d) && !userTunnel.includes(d));

    return { direct, tunnel, block, probes: PROBE_DOMAINS, learned: learnedDirect.length + learnedTunnel.length };
}

function normalize(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((d) => String(d).trim().toLowerCase()
            .replace(/^https?:\/\//, '')
            .split('/')[0]
            .replace(/^\*?\./, ''))
        .filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
}

function dedupe(list) {
    return [...new Set(list)];
}

module.exports = {
    IRAN_DOMAINS, FILTERED_DOMAINS, SANCTIONED_DOMAINS, AD_DOMAINS, PROBE_DOMAINS,
    resolveRoutes, normalize,
};
