// --- «ام‌ال‌ام استور» — reading GitHub releases WITHOUT the API ---
//
// api.github.com allows 60 requests an hour per IP. From an Iranian mobile NAT that allowance is
// shared with everyone behind the same address, and it was measured at 4 remaining on the day this
// was written. Anything that depends on it is a store that works at 3 a.m. and nowhere else.
//
// Two plain pages carry everything the store needs, and neither is metered:
//
//   /releases.atom                      every recent release INCLUDING pre-releases, newest first.
//                                       (/releases/latest skips pre-releases: it reported Xray
//                                       26.3.27 while 26.9.9 was out.)
//   /releases/expanded_assets/<tag>     the asset list, and next to each asset the SHA-256 digest
//                                       GitHub itself computed at upload — the anchor for projects
//                                       that publish no checksum file of their own (sing-box ships
//                                       167 files and not one of them is a checksum).
//
// The digest is read from the copy button's own label, `Copy to clipboard digest for <name>`, so a
// digest is never attributed to the neighbouring asset.

'use strict';

const netio = require('./net');

function decodeEntities(s) {
    return String(s)
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

/** Parse releases.atom → [{ tag, title, updated }], newest first. */
function parseAtom(xml) {
    const out = [];
    const entries = String(xml).split(/<entry>/).slice(1);
    for (const e of entries) {
        const link = (e.match(/\/releases\/tag\/([^"<]+)"/) || [])[1];
        if (!link) continue;
        out.push({
            tag: decodeURIComponent(decodeEntities(link)),
            title: decodeEntities((e.match(/<title>([^<]*)<\/title>/) || [])[1] || ''),
            updated: (e.match(/<updated>([^<]+)<\/updated>/) || [])[1] || '',
        });
    }
    return out;
}

/** Parse an expanded_assets fragment → { [assetName]: { sha256, url } }. */
function parseAssets(html, repo, tag) {
    const out = {};
    const text = String(html);
    const re = /aria-label="Copy to clipboard digest for ([^"]+)"[^>]*?value="sha256:([0-9a-f]{64})"/g;
    let m;
    while ((m = re.exec(text))) {
        const name = decodeEntities(m[1]);
        out[name] = {
            sha256: m[2],
            url: 'https://github.com/' + repo + '/releases/download/' + encodeURIComponent(tag) + '/' + encodeURIComponent(name),
        };
    }
    // Assets listed without a digest (uploads from before GitHub started computing them) are still
    // named, with sha256 null — a caller must then find its anchor elsewhere, never skip checking.
    const linkRe = new RegExp('href="/' + repo.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + '/releases/download/[^"/]+/([^"]+)"', 'g');
    while ((m = linkRe.exec(text))) {
        const name = decodeURIComponent(decodeEntities(m[1]));
        if (!out[name]) {
            out[name] = { sha256: null, url: 'https://github.com/' + repo + '/releases/download/' + encodeURIComponent(tag) + '/' + encodeURIComponent(name) };
        }
    }
    return out;
}

async function releases(repo, opts = {}) {
    const r = await netio.fetchText('https://github.com/' + repo + '/releases.atom', Object.assign({ timeoutMs: 40000 }, opts));
    return parseAtom(r.text);
}

async function assets(repo, tag, opts = {}) {
    const r = await netio.fetchText('https://github.com/' + repo + '/releases/expanded_assets/' + encodeURIComponent(tag),
        Object.assign({ timeoutMs: 60000 }, opts));
    return parseAssets(r.text, repo, tag);
}

module.exports = { parseAtom, parseAssets, releases, assets };
