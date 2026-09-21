// --- SNI builder (ساخت کانفیگ SNI) -----------------------------------------
// Windows port of the Android "+ ساخت SNI" flow (AddNodeModal.kt / spoofToSni).
//
// What it does, and all it does: take configs the user already has — fetched from the
// Cloudflare panels, combined with clean IPs, or added by hand — and rewrite each one to
// point at the local SNI-spoof proxy instead of its own server:
//
//     vless://uuid@some.host:443?...   ->   vless://uuid@127.0.0.1:40443?...&allowInsecure=1
//
// 40443 is where the SNI engine listens (LISTEN_PORT in sni-manager / RstaSpoofManager),
// so a config aimed there gets its TLS hello rewritten with a fake SNI on the way out.
// `allowInsecure=1` is required because the certificate then no longer matches the name
// being presented.
//
// Originals are never touched. Converted copies are new nodes, and because their URI
// contains `:40443` they land in the «کانفیگ های sni» group automatically
// (see getV2rayPanelName in v2ray.js) — no separate bookkeeping to keep in sync.

(function () {
    'use strict';

    var SNI_HOST = '127.0.0.1';
    var SNI_PORT = '40443';
    var SNI_GROUP_NAME = 'کانفیگ های SNI';

    // ── base64 helpers (vmess payloads) ──────────────────────────────────────
    // Android's Base64.DEFAULT is forgiving about padding and URL-safe alphabets;
    // browser atob is not, and a vmess link from a panel is frequently one or the other.
    // Decoding through UTF-8 as well, since remarks are usually Persian or emoji and
    // atob alone yields latin1 mojibake.

    function b64Decode(s) {
        var t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
        while (t.length % 4) t += '=';
        var bin = atob(t);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        try { return new TextDecoder('utf-8').decode(bytes); } catch (e) { return bin; }
    }

    function b64Encode(str) {
        var bytes = new TextEncoder().encode(str);
        var bin = '';
        for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    /**
     * Convert one URI to its SNI-spoof form, or return null if it is not convertible.
     *
     * A faithful port of spoofToSni() in AddNodeModal.kt — same handling of the fragment,
     * the query, and the last '@' — so a config converted on the phone and the same config
     * converted here produce identical output.
     */
    function spoofToSni(uri) {
        var trimmed = String(uri || '').trim();
        var lower = trimmed.toLowerCase();
        try {
            if (lower.indexOf('vmess://') === 0) {
                var obj = JSON.parse(b64Decode(trimmed.substring(8)));
                obj.add = SNI_HOST;
                obj.port = SNI_PORT;
                obj['skip-cert-verify'] = true;
                return 'vmess://' + b64Encode(JSON.stringify(obj));
            }

            if (lower.indexOf('vless://') === 0 || lower.indexOf('trojan://') === 0) {
                var hashIdx = trimmed.indexOf('#');
                var name = hashIdx >= 0 ? trimmed.substring(hashIdx) : '';
                var noHash = hashIdx >= 0 ? trimmed.substring(0, hashIdx) : trimmed;

                var qIdx = noHash.indexOf('?');
                var base = qIdx >= 0 ? noHash.substring(0, qIdx) : noHash;
                var query = qIdx >= 0 ? noHash.substring(qIdx + 1) : '';

                // lastIndexOf: a trojan password may itself contain '@'.
                var atIdx = base.lastIndexOf('@');
                if (atIdx < 0) return null;
                var newBase = base.substring(0, atIdx + 1) + SNI_HOST + ':' + SNI_PORT;

                if (/allowInsecure=[^&]*/.test(query)) {
                    query = query.replace(/allowInsecure=[^&]*/g, 'allowInsecure=1');
                } else if (!query) {
                    query = 'allowInsecure=1';
                } else {
                    query = query + '&allowInsecure=1';
                }

                return newBase + '?' + query + name;
            }

            // ss:// and the raw-JSON custom configs have no address to rewrite this way.
            return null;
        } catch (e) {
            return null;
        }
    }

    /**
     * Does this config ride the SNI front? By destination, not by group: a group is a label the
     * user can move a config out of; the address is what decides whether the front must be up.
     * (Android: SniSession.isSniUri.)
     */
    function isSniUri(uri) {
        var t = String(uri || '').trim();
        var lower = t.toLowerCase();
        try {
            if (lower.indexOf('vmess://') === 0) {
                var o = JSON.parse(b64Decode(t.substring(8)));
                return String(o.add) === SNI_HOST && String(o.port) === SNI_PORT;
            }
            if (lower.indexOf('vless://') === 0 || lower.indexOf('trojan://') === 0) {
                var noHash = t.split('#')[0];
                var base = noHash.split('?')[0];
                return base.substring(base.lastIndexOf('@') + 1) === SNI_HOST + ':' + SNI_PORT;
            }
        } catch (e) { /* unreadable: not one of ours */ }
        return false;
    }

    // WHICH CONFIGS CAN BE CONVERTED AT ALL. Converting repoints a config at the front, and the
    // front dials a Cloudflare EDGE address under a forged name; the edge then routes the inner
    // connection by the host the config still carries — so the config's own server has to be
    // something that edge can reach: a Cloudflare Worker. The cloud panels are exactly that. A
    // manual or free config almost always points at a server of its own, and converting it made
    // a config that could not connect on any entry point, which reads as "SNI is broken". So
    // the ineligible ones are not offered (Android: SniSession.CLOUD_PANELS) — except a manually
    // added config whose host is itself a Worker, which is as eligible as any panel's.
    var CLOUD_PANELS = { 'BPB': 1, 'Zeus': 1, 'Edge': 1, 'کلاستر کلودفلر': 1 };
    function workerHosted(uri) {
        var t = String(uri || '').trim();
        var hosts = [];
        try {
            if (t.toLowerCase().indexOf('vmess://') === 0) {
                var o = JSON.parse(b64Decode(t.substring(8)));
                hosts = [o.host, o.sni, o.add];
            } else {
                var q = (t.split('#')[0].split('?')[1] || '');
                q.split('&').forEach(function (kv) {
                    var p = kv.split('=');
                    if (p[0] === 'sni' || p[0] === 'host') { try { hosts.push(decodeURIComponent(p[1] || '')); } catch (e) { hosts.push(p[1]); } }
                });
                var base = t.split('#')[0].split('?')[0];
                hosts.push(base.substring(base.lastIndexOf('@') + 1).split(':')[0]);
            }
        } catch (e) { return false; }
        return hosts.some(function (h) { return /\.(workers\.dev|pages\.dev)$/i.test(String(h || '').trim()); });
    }

    // ── source selection ─────────────────────────────────────────────────────

    function nodeName(node) {
        var raw = node.name || node.alias || (node.uri ? String(node.uri).split('#')[1] : '') || '';
        try { raw = decodeURIComponent(raw); } catch (e) {}
        return raw || 'بدون نام';
    }

    // Keep the converted copy easy to scan in the connection list. The original
    // Cloudflare-panel title can be thousands of characters long, so never reuse it
    // verbatim as the visible SNI node name.
    function sniNodeName(node) {
        var source = nodeName(node).replace(/\s+/g, ' ').trim();
        var limit = 56;
        if (source.length > limit) source = source.slice(0, limit - 1) + '…';
        return 'SNI • ' + source;
    }

    /**
     * Everything the user could actually convert, bucketed by the same panel grouping the
     * list itself uses — so the choices here read exactly like the tabs they already know.
     *
     * Two exclusions, both matching the Android build: the protected built-in configs
     * (raw JSON, nothing to rewrite) and the SNI group itself (converting a converted
     * config would just point 127.0.0.1 at 127.0.0.1).
     */
    function collectBuckets() {
        var list = window.v2rayList || [];
        var map = {};

        list.forEach(function (node, idx) {
            if (!node || node.disableShare) return;
            var group = (typeof window.getV2rayPanelName === 'function')
                ? window.getV2rayPanelName(node) : 'افزودن دستی';
            if (group === SNI_GROUP_NAME || isSniUri(node.uri)) return;
            if (!CLOUD_PANELS[group] && !workerHosted(node.uri)) return;

            var converted = spoofToSni(node.uri);
            if (!converted) return;      // not a convertible protocol

            if (!map[group]) map[group] = [];
            map[group].push({ index: idx, node: node, converted: converted });
        });

        return Object.keys(map).map(function (g) {
            return { label: g, items: map[g] };
        });
    }

    // ── modal ────────────────────────────────────────────────────────────────

    var selected = 'ALL';
    var buckets = [];

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function totalCount() {
        return buckets.reduce(function (n, b) { return n + b.items.length; }, 0);
    }

    function render() {
        var body = document.getElementById('sni-builder-body');
        if (!body) return;

        if (!buckets.length) {
            body.innerHTML =
                '<div class="text-center py-8">' +
                  '<div class="text-mv-label text-sm mb-2">کانفیگ قابل تبدیلی پیدا نشد.</div>' +
                  '<div class="text-mv-label-3 text-xs leading-7">اول از پنل‌های ابری کانفیگ بگیرید یا دستی اضافه کنید.<br>' +
                  'کانفیگ‌های پیش‌فرض و کانفیگ‌های SNI موجود قابل تبدیل نیستند.</div>' +
                '</div>';
            var b = document.getElementById('sni-builder-go');
            if (b) b.disabled = true;
            return;
        }

        var rows = [{ key: 'ALL', label: 'همه‌ی کانفیگ‌ها', count: totalCount() }]
            .concat(buckets.map(function (bk) {
                return { key: bk.label, label: bk.label, count: bk.items.length };
            }));

        body.innerHTML = rows.map(function (r) {
            var on = selected === r.key;
            return '<button type="button" onclick="window.__sniPick(' + JSON.stringify(r.key).replace(/"/g, '&quot;') + ')" ' +
                'class="w-full flex items-center justify-between gap-3 p-3 mb-2 rounded-xl border transition-all ' +
                (on ? 'bg-m3-primary/15 border-m3-primary' : 'bg-mv-surface-2 border-m3-outline hover:bg-mv-surface-3') + '">' +
                '<span class="flex items-center gap-2">' +
                  '<span class="w-4 h-4 rounded-full border-2 flex items-center justify-center ' +
                    (on ? 'border-m3-primary' : 'border-mv-sep-3') + '">' +
                    (on ? '<span class="w-2 h-2 rounded-full bg-m3-primary"></span>' : '') +
                  '</span>' +
                  '<span class="text-sm ' + (on ? 'text-mv-label font-medium' : 'text-mv-label') + '">' + esc(r.label) + '</span>' +
                '</span>' +
                '<span class="text-xs font-mono ' + (on ? 'text-m3-primary' : 'text-mv-label-3') + '">' + r.count + ' کانفیگ</span>' +
              '</button>';
        }).join('');

        var go = document.getElementById('sni-builder-go');
        if (go) go.disabled = false;
    }

    window.__sniPick = function (key) { selected = key; render(); };

    window.openSniBuilderModal = function () {
        // On the desktop, building lives in the SNI window itself (as on Android): the configs
        // are made where they are used, beside the button that connects them.
        if (document.documentElement.classList.contains('mv-shell') && window.MV && window.MV.wm && typeof window.sniToggleBuilder === 'function') {
            window.MV.wm.open('sni');
            if (!document.querySelector('[data-sni-build]')) window.sniToggleBuilder();
            return;
        }
        buckets = collectBuckets();
        selected = 'ALL';

        var old = document.getElementById('sniBuilderModal');
        if (old && old.parentNode) old.parentNode.removeChild(old);

        var m = document.createElement('div');
        m.id = 'sniBuilderModal';
        m.className = 'fixed inset-0 z-[10000] flex items-center justify-center p-4';
        m.style.cssText = 'background:var(--mv-scrim);backdrop-filter:blur(4px);';
        m.innerHTML =
            '<div class="w-full max-w-lg bg-m3-surface border border-m3-outline rounded-3xl overflow-hidden shadow-2xl" style="max-height:calc(100vh - 60px);display:flex;flex-direction:column;">' +
              '<div class="p-5 border-b border-m3-outline">' +
                '<h3 class="text-lg font-bold text-mv-label">ساخت کانفیگ SNI</h3>' +
                '<p class="text-xs text-mv-label-2 mt-2 leading-7">' +
                  'کانفیگ‌های انتخابی به موتور SNI وصل می‌شوند: آدرس روی <span dir="ltr" class="font-mono text-mv-label">127.0.0.1</span> ' +
                  'و پورت روی <span dir="ltr" class="font-mono text-mv-label">40443</span> تنظیم می‌شود.' +
                  '<br>کانفیگ‌های اصلی دست‌نخورده می‌مانند؛ نسخه‌ی تبدیل‌شده در گروه «' + esc(SNI_GROUP_NAME) + '» ساخته می‌شود.' +
                '</p>' +
              '</div>' +
              '<div id="sni-builder-body" class="p-5 overflow-y-auto custom-scrollbar" style="flex:1;"></div>' +
              '<div class="p-4 border-t border-m3-outline flex items-center gap-3">' +
                '<button type="button" onclick="window.closeSniBuilderModal()" ' +
                  'class="flex-1 py-2.5 rounded-xl bg-mv-surface-2 border border-m3-outline text-mv-label text-sm hover:bg-mv-surface-3 transition-all">انصراف</button>' +
                '<button type="button" id="sni-builder-go" onclick="window.buildSniConfigs()" ' +
                  'class="flex-1 py-2.5 rounded-xl bg-m3-primary text-white text-sm font-bold hover:brightness-110 transition-all disabled:opacity-40 disabled:cursor-not-allowed">ساخت</button>' +
              '</div>' +
            '</div>';

        m.addEventListener('click', function (e) { if (e.target === m) window.closeSniBuilderModal(); });
        document.body.appendChild(m);
        render();
    };

    window.closeSniBuilderModal = function () {
        var m = document.getElementById('sniBuilderModal');
        if (m && m.parentNode) m.parentNode.removeChild(m);
    };

    // ── conversion ───────────────────────────────────────────────────────────

    /** Add the SNI copies of these items to the list; returns { added, skipped }. */
    function buildFrom(chosen) {
        // Pressing the button twice must not double the list, so match on the produced URI.
        var existing = {};
        (window.v2rayList || []).forEach(function (n) { if (n && n.uri) existing[n.uri] = true; });

        var added = 0, skipped = 0;
        chosen.forEach(function (item) {
            if (existing[item.converted]) { skipped++; return; }
            existing[item.converted] = true;
            window.v2rayList.push({
                id: 'sni_' + Date.now() + '_' + Math.random().toString(36).slice(2),
                uri: item.converted,
                // An explicit marker is essential: it makes the SNI group stable
                // even if the URI/name format changes in a future cloud panel.
                groupTitle: SNI_GROUP_NAME,
                name: sniNodeName(item.node),
            });
            added++;
        });
        if (added && typeof window.saveV2rayList === 'function') window.saveV2rayList();
        return { added: added, skipped: skipped };
    }

    window.buildSniConfigs = function () {
        var chosen = selected === 'ALL'
            ? buckets.reduce(function (acc, b) { return acc.concat(b.items); }, [])
            : (buckets.filter(function (b) { return b.label === selected; })[0] || { items: [] }).items;

        if (!chosen.length) {
            if (typeof toast === 'function') toast('❌ کانفیگی برای تبدیل انتخاب نشد');
            return;
        }
        var r = buildFrom(chosen), added = r.added, skipped = r.skipped;

        // A dedicated SNI tab only exists while panel grouping is enabled. Turn it
        // on here so the new copies never appear mixed into the default list.
        if (added) {
            window.isV2rayGrouped = true;
            window.activeV2rayPanelTab = SNI_GROUP_NAME;
            window.activeV2raySubTab = null;
            var groupingToggle = document.getElementById('v2ray-panel-switch');
            if (groupingToggle) groupingToggle.checked = true;
        }

        if (typeof window.saveV2rayList === 'function') window.saveV2rayList();
        if (typeof window.renderV2rayList === 'function') window.renderV2rayList();

        window.closeSniBuilderModal();

        if (typeof toast === 'function') {
            toast(added
                ? '✅ ' + added + ' کانفیگ SNI ساخته شد' + (skipped ? ' (' + skipped + ' مورد از قبل بود)' : '')
                : 'ℹ️ همه‌ی این کانفیگ‌ها از قبل ساخته شده بودند');
        }
    };

    // Exposed for the SNI panel and for tests.
    window.spoofToSni = spoofToSni;
    window.isSniUri = isSniUri;
    window.sniBuilder = { buckets: collectBuckets, build: buildFrom, workerHosted: workerHosted };
    window.SNI_GROUP_NAME = SNI_GROUP_NAME;
})();
