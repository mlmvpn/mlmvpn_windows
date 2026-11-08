// --- cf-uri.js — one reader and one rewriter for config links, IPv6-aware ---
//
// Loaded twice: as a plain <script> in the page (window.CfUri) and with require() on the
// server. It exists because the address swap was written three times (the combination centre,
// the assistant, the scanner's real test) with the same regex, `@([a-zA-Z0-9.-]+):(\d+)`, and
// that regex cannot see an IPv6 address — neither to replace one nor to write one:
//
//   * Iran's filtering of 2026-09-28 left Cloudflare IPv4 carrying NO tunnel data while IPv6
//     worked (measured on the phone: see docs/ANDROID-1.2.36-TO-WINDOWS.fa.md › ۱). From then on
//     the clean address a config is combined with is often IPv6, and in a link it must be written
//     `[2606:4700:…]:443` — a bare v6 address makes the port unreadable.
//   * The core, on the other hand, wants it WITHOUT brackets in the outbound's `address`.
//   * The original name must be pinned into `sni` and `host` BEFORE the address is replaced when
//     the link leaves them blank, or the core offers the IP as the server name and Cloudflare
//     refuses the handshake (Android's CombineEngine.rewrite does the same).
(function (root, factory) {
    const api = factory();
    if (typeof module === "object" && module.exports) module.exports = api;
    root.CfUri = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const stripBrackets = (s) => String(s == null ? '' : s).trim().replace(/^\[/, '').replace(/\]$/, '');
    const isV6 = (ip) => stripBrackets(ip).includes(':');
    const isV4 = (ip) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(String(ip || '').trim())
        && String(ip).trim().split('.').every((o) => Number(o) <= 255);
    const isIpLiteral = (s) => isV4(s) || isV6(s);
    /** An address as it goes into a link: IPv6 in brackets, everything else as it is. */
    const hostForUri = (ip) => (isV6(ip) ? `[${stripBrackets(ip)}]` : String(ip || '').trim());

    /**
     * An archive / scan entry → a bare address. `[v6]:443` and `v4:443` lose their port; a bare
     * IPv6 keeps every group (splitting it at the first colon was the GitHub Tunnel bug).
     */
    function bareAddress(entry) {
        const s = String(entry == null ? '' : entry).trim();
        const br = s.match(/^\[([^\]]+)\](?::\d+)?$/);
        if (br) return br[1];
        if (s.includes('.') && /^[^:]+:\d+$/.test(s)) return s.slice(0, s.lastIndexOf(':'));
        return s;
    }

    function b64decode(s) {
        const clean = String(s || '').trim().replace(/-/g, '+').replace(/_/g, '/');
        if (typeof Buffer !== 'undefined') return Buffer.from(clean, 'base64').toString('utf8');
        return decodeURIComponent(escape(atob(clean)));
    }
    function b64encode(s) {
        if (typeof Buffer !== 'undefined') return Buffer.from(String(s), 'utf8').toString('base64');
        return btoa(unescape(encodeURIComponent(String(s))));
    }

    // vless://id@host:port?query#name — host may be `[v6]`. Split by hand: the page's URL class
    // and Node's agree on most things, but not on every odd link a panel emits.
    const AUTH_RE = /^([a-z0-9+.-]+):\/\/([^@/?#]*)@(\[[^\]]+\]|[^:/?#@]+):(\d+)/i;

    function parseQuery(q) {
        const out = {};
        String(q || '').split('&').forEach((kv) => {
            if (!kv) return;
            const i = kv.indexOf('=');
            const k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' '));
            let v = i < 0 ? '' : kv.slice(i + 1);
            try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) { /* keep raw */ }
            if (!(k in out)) out[k] = v;
        });
        return out;
    }

    /**
     * What a link asks the edge for. null for anything that is not vless/trojan/vmess/ss.
     * { scheme, address, port, sni, host, tls, net, path, name }
     */
    function parse(uri) {
        const s = String(uri || '').trim();
        if (/^vmess:\/\//i.test(s)) {
            let j;
            try { j = JSON.parse(b64decode(s.slice(8).split('#')[0])); } catch (e) { return null; }
            const address = stripBrackets(j.add);
            const tls = String(j.tls || '').toLowerCase();
            return {
                scheme: 'vmess', address, port: parseInt(j.port, 10) || 0,
                sni: String(j.sni || ''), host: String(j.host || ''),
                tls: tls === 'tls' || tls === 'reality' ? tls : 'none',
                net: String(j.net || 'tcp').toLowerCase(), path: String(j.path || ''), name: String(j.ps || ''),
            };
        }
        const m = s.match(AUTH_RE);
        if (!m) return null;
        const scheme = m[1].toLowerCase();
        if (!['vless', 'trojan', 'ss'].includes(scheme)) return null;
        const rest = s.slice(m[0].length);
        const qi = rest.indexOf('?');
        const hi = rest.indexOf('#');
        const query = qi < 0 ? '' : rest.slice(qi + 1, hi < 0 ? undefined : (hi > qi ? hi : undefined));
        const q = parseQuery(query);
        const port = parseInt(m[4], 10);
        let tls = String(q.security || '').toLowerCase();
        if (!['tls', 'reality'].includes(tls)) {
            // parseVlessUri's own rule: the Cloudflare TLS ports imply TLS.
            tls = [443, 8443, 2053, 2083, 2087, 2096].includes(port) && scheme !== 'ss' ? 'tls' : 'none';
        }
        let name = '';
        if (hi >= 0) { try { name = decodeURIComponent(rest.slice(hi + 1)); } catch (e) { name = rest.slice(hi + 1); } }
        return {
            scheme, address: stripBrackets(m[3]), port,
            sni: String(q.sni || q.peer || ''), host: String(q.host || ''),
            tls, net: String(q.type || 'tcp').toLowerCase(), path: String(q.path || ''), name,
        };
    }

    /** The name the edge is really asked for (SNI, else the host header, else the address). */
    function serverName(p) {
        if (!p) return '';
        return p.sni || p.host || (isIpLiteral(p.address) ? '' : p.address);
    }

    const needsHost = (net) => ['ws', 'httpupgrade', 'xhttp', 'h2', 'http'].includes(String(net || '').toLowerCase());

    /**
     * The same link on another address. The original NAME is pinned into `sni` (TLS links) and
     * `host` (transports that send one) when the link left them blank — the core would otherwise
     * put the IP there. `tag`, when given, is appended to the link's name (the old behaviour of
     * the combination centre: «name [ip]»).
     */
    function rewrite(uri, ip, port, tag) {
        const s = String(uri || '').trim();
        const addr = stripBrackets(ip);
        if (!addr) return s;
        const p = parse(s);
        if (!p) return s;
        const original = p.address;
        const pinName = !isIpLiteral(original) ? original : '';

        if (p.scheme === 'vmess') {
            let j;
            try { j = JSON.parse(b64decode(s.slice(8).split('#')[0])); } catch (e) { return s; }
            if (pinName && p.tls === 'tls' && !j.sni) j.sni = j.host || pinName;
            if (pinName && needsHost(p.net) && !j.host) j.host = pinName;
            j.add = addr;                                  // the core's field: no brackets
            if (port) j.port = String(port);
            if (tag) j.ps = (j.ps ? j.ps + ' ' : '') + `[${addr}]`;
            return 'vmess://' + b64encode(JSON.stringify(j));
        }

        const m = s.match(AUTH_RE);
        let out = `${m[1]}://${m[2]}@${hostForUri(addr)}:${port || m[4]}` + s.slice(m[0].length);
        if (pinName && p.scheme !== 'ss') {
            const add = [];
            if (p.tls === 'tls' && !p.sni) add.push('sni=' + encodeURIComponent(p.host || pinName));
            if (needsHost(p.net) && !p.host) add.push('host=' + encodeURIComponent(pinName));
            if (add.length) {
                const hash = out.indexOf('#');
                const head = hash < 0 ? out : out.slice(0, hash);
                const tail = hash < 0 ? '' : out.slice(hash);
                out = head + (head.includes('?') ? '&' : '?') + add.join('&') + tail;
            }
        }
        if (tag) {
            if (out.includes('#')) out += encodeURIComponent(` [${addr}]`);
            else out += '#' + encodeURIComponent(addr);
        }
        return out;
    }

    /** The address a link points at, as a bare string (no brackets), or ''. */
    function addressOf(uri) { const p = parse(uri); return p ? p.address : ''; }

    return { parse, rewrite, addressOf, serverName, stripBrackets, bareAddress, hostForUri, isV4, isV6, isIpLiteral };
});
