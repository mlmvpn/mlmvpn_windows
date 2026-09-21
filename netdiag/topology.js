/*
 * NetDiag — interface topology.
 *
 * This module exists to destroy the assumption that there is "one adapter". The machine this
 * was developed on has five: a Realtek USB Wi-Fi that is Up, an Intel Ethernet, a
 * TAP-Windows V9, a Kerio virtual adapter, and a VPN client adapter — and that is an ordinary
 * machine, not a lab. Iranian users routinely add Hyper-V, WSL, Docker, VMware and a second
 * VPN on top of that.
 *
 * Three facts from that real inventory shape everything below:
 *
 *   1. `Get-NetAdapter -Virtual` LIES for the case that matters most. TAP-Windows V9 —
 *      the adapter every OpenVPN-family client installs — reports `Virtual: false`. Trusting
 *      that flag classifies a VPN tunnel as a physical NIC, which is how a repair ends up
 *      pointed at somebody's tunnel. The flag is corroboration here, never the decision.
 *
 *   2. The alias tells you nothing. That TAP adapter is called "Ethernet 3", and the Kerio
 *      virtual adapter is "Ethernet 4". Aliases are renameable and index numbers are reused,
 *      so every identity in this engine is the InterfaceGuid.
 *
 *   3. Driver description strings are NOT localised — they come from the .inf, not from the
 *      Windows UI language. That makes them the one dependable classification signal, which
 *      is why the patterns below match descriptions rather than anything on screen.
 *
 * Everything here is a pure function of already-collected data, so the whole model is
 * testable against captured JSON with no Windows present.
 */

'use strict';

const IF_CLASS = Object.freeze({
    PHYSICAL_ETHERNET: 'physical-ethernet',
    PHYSICAL_WIFI: 'physical-wifi',
    VPN_TUN: 'vpn-tun',
    VPN_TAP: 'vpn-tap',
    VIRTUAL_HOST: 'virtual-host',
    LOOPBACK: 'loopback',
    OTHER: 'other',
});

/**
 * Description patterns, most specific first — the first match wins.
 *
 * Ordering is behaviour: "Hyper-V Virtual Ethernet Adapter" contains "Ethernet", and
 * "Microsoft Wi-Fi Direct Virtual Adapter" contains "Wi-Fi", so the virtual and tunnel
 * patterns must be tested before the physical ones or a host-only adapter gets classified as
 * a NIC the engine is willing to repair.
 */
const VENDOR_PATTERNS = Object.freeze([
    { rx: /wintun/i, vendor: 'wintun', cls: IF_CLASS.VPN_TUN },
    { rx: /tap-windows|tap-win32|openvpn/i, vendor: 'tap-windows', cls: IF_CLASS.VPN_TAP },
    { rx: /wireguard/i, vendor: 'wireguard', cls: IF_CLASS.VPN_TUN },
    { rx: /\bvpn\b|virtual private network/i, vendor: 'vpn-generic', cls: IF_CLASS.VPN_TUN },
    { rx: /hyper-v|vethernet/i, vendor: 'hyper-v', cls: IF_CLASS.VIRTUAL_HOST },
    { rx: /vmware/i, vendor: 'vmware', cls: IF_CLASS.VIRTUAL_HOST },
    { rx: /virtualbox|host-only network/i, vendor: 'virtualbox', cls: IF_CLASS.VIRTUAL_HOST },
    { rx: /\bwsl\b|windows subsystem for linux/i, vendor: 'wsl', cls: IF_CLASS.VIRTUAL_HOST },
    { rx: /docker/i, vendor: 'docker', cls: IF_CLASS.VIRTUAL_HOST },
    { rx: /kerio|sangfor|forticlient|pulse secure|cisco anyconnect|checkpoint/i, vendor: 'vendor-vpn', cls: IF_CLASS.VPN_TUN },
    { rx: /wi-fi direct|virtual adapter|miniport/i, vendor: 'ms-virtual', cls: IF_CLASS.VIRTUAL_HOST },
    { rx: /loopback/i, vendor: 'loopback', cls: IF_CLASS.LOOPBACK },
    { rx: /wireless|wi-?fi|802\.11|wlan/i, vendor: null, cls: IF_CLASS.PHYSICAL_WIFI },
    { rx: /ethernet|gigabit|realtek pcie|intel\(r\) (ethernet|82\d)/i, vendor: null, cls: IF_CLASS.PHYSICAL_ETHERNET },
]);

/**
 * Classify one adapter.
 *
 * `confidence` is honest rather than decorative: `matched` means a driver string identified
 * it, `weak` means only the Virtual flag or the loopback index did, `none` means we could not
 * tell — and an adapter we could not classify is never treated as physical, because "we do
 * not know what this is" must not authorise a repair on it.
 */
function classifyInterface(a) {
    const desc = String((a && a.description) || '');
    const name = String((a && a.name) || '');
    const hay = `${desc} ${name}`;

    if (a && (a.index === 1 || /software loopback/i.test(hay))) {
        return { cls: IF_CLASS.LOOPBACK, vendor: 'loopback', confidence: 'matched' };
    }
    for (const p of VENDOR_PATTERNS) {
        if (p.rx.test(hay)) return { cls: p.cls, vendor: p.vendor, confidence: 'matched' };
    }
    // No driver string matched. The Virtual flag is all that is left, and it is the weaker
    // signal — it is false on TAP-Windows — so a `true` is believed and a `false` is not.
    if (a && a.virtual === true) {
        return { cls: IF_CLASS.VIRTUAL_HOST, vendor: null, confidence: 'weak' };
    }
    return { cls: IF_CLASS.OTHER, vendor: null, confidence: 'none' };
}

/**
 * May a repair ever target this interface?
 *
 * Host virtual adapters and loopback: never. A misdirected DNS or MTU repair on a Docker NAT
 * adapter is the classic way a diagnostic tool "succeeds" while changing nothing the user can
 * see. VPN adapters: never directly either — they are repaired only through their owning
 * engine's own recovery path, so that the app's deliberate state is never torn down by a
 * generic reset. Unclassified adapters: never, per the Prime Directive.
 */
function isRepairTarget(iface) {
    if (!iface) return false;
    if (iface.cls === IF_CLASS.VIRTUAL_HOST || iface.cls === IF_CLASS.LOOPBACK) return false;
    if (iface.cls === IF_CLASS.VPN_TUN || iface.cls === IF_CLASS.VPN_TAP) return false;
    if (iface.cls === IF_CLASS.OTHER) return false;
    return true;
}

/**
 * Pick the interface Windows itself would send traffic out of, per family.
 *
 * Windows breaks ties on the sum of the route metric and the interface metric, so that sum is
 * what decides here too — guessing differently from Windows means diagnosing an interface the
 * traffic never uses.
 *
 * A genuine tie is NOT resolved silently. Two live default routes at equal cost is a real
 * condition (a docked laptop, a split tunnel, a second VPN) and the caller must be able to
 * see it, so the winner is chosen deterministically for reproducibility and `ambiguous` is
 * set. Multiple default routes are never treated as a fault by themselves.
 */
function selectEgress(interfaces, defaultRoutes, family) {
    const byGuid = new Map(interfaces.map(i => [String(i.guid).toLowerCase(), i]));
    const candidates = [];

    for (const r of defaultRoutes || []) {
        if (r.family !== family) continue;
        const guid = String(r.interfaceGuid || '').toLowerCase();
        const iface = byGuid.get(guid);
        if (!iface) continue;                       // a route on an adapter we cannot see
        if (iface.status !== 'Up') continue;        // a default route on a down adapter carries nothing
        const routeMetric = Number.isFinite(r.metric) ? r.metric : null;
        const ifMetric = Number.isFinite(iface.metric) ? iface.metric : null;
        if (routeMetric === null || ifMetric === null) {
            // A metric we could not read cannot be compared. Recording it as a candidate with
            // a null cost keeps it visible without letting it win by accident.
            candidates.push({ guid, cost: null, route: r, iface });
            continue;
        }
        candidates.push({ guid, cost: routeMetric + ifMetric, route: r, iface });
    }

    if (!candidates.length) {
        return { guid: null, reason: 'no default route on any Up interface', ambiguous: false, candidates: [] };
    }
    const scored = candidates.filter(c => c.cost !== null);
    if (!scored.length) {
        return {
            guid: null,
            reason: 'default routes exist but no metric was readable, so the egress cannot be determined',
            ambiguous: false,
            candidates,
        };
    }
    scored.sort((a, b) => (a.cost - b.cost) || a.guid.localeCompare(b.guid));
    const best = scored[0];
    const tied = scored.filter(c => c.cost === best.cost);
    return {
        guid: best.guid,
        reason: `lowest RouteMetric+InterfaceMetric (${best.cost}) among ${scored.length} default route(s)`,
        ambiguous: tied.length > 1,
        tiedWith: tied.length > 1 ? tied.map(c => c.guid) : [],
        unreadableMetrics: candidates.length - scored.length,
        candidates,
    };
}

/**
 * Assemble the topology from already-parsed inputs.
 *
 * Pure. `adapters`, `addresses`, `defaultRoutes` and `ifMetrics` come from the collectors;
 * keeping the assembly free of I/O is what lets the multi-adapter cases be tested from a
 * captured JSON file.
 */
function buildTopology(input) {
    const src = input || {};
    const interfaces = (src.adapters || []).map(a => {
        const guid = String(a.guid || '').toLowerCase();
        const c = classifyInterface(a);
        const iface = {
            guid,
            index: a.index,
            name: a.name || null,
            description: a.description || null,
            cls: c.cls,
            vendor: c.vendor,
            classConfidence: c.confidence,
            virtualFlag: a.virtual === true,
            status: a.status || null,
            metric: Number.isFinite((src.ifMetrics || {})[guid]) ? src.ifMetrics[guid] : null,
            ownedBy: null,                      // filled in by ownership.js
            addrs: (src.addresses || []).filter(x => String(x.interfaceGuid || '').toLowerCase() === guid),
        };
        iface.repairTarget = isRepairTarget(iface);
        return iface;
    });

    const defaults = { v4: [], v6: [] };
    for (const r of src.defaultRoutes || []) {
        if (r.family === 'v4' || r.family === 'v6') defaults[r.family].push(r);
    }

    const egress = {
        v4: selectEgress(interfaces, src.defaultRoutes || [], 'v4'),
        v6: selectEgress(interfaces, src.defaultRoutes || [], 'v6'),
    };

    return {
        interfaces,
        defaultRoutes: defaults,
        egress,
        // Reported, never a fault on its own: several default routes is the normal state of a
        // split tunnel, a docked laptop, or a machine running Hyper-V.
        multipleDefaults: { v4: defaults.v4.length > 1, v6: defaults.v6.length > 1 },
        readable: interfaces.length > 0,
    };
}

/** The chosen egress interface object for a family, or null. */
function egressInterface(topology, family) {
    const guid = topology && topology.egress && topology.egress[family] && topology.egress[family].guid;
    if (!guid) return null;
    return topology.interfaces.find(i => i.guid === guid) || null;
}

module.exports = {
    IF_CLASS, VENDOR_PATTERNS,
    classifyInterface, isRepairTarget, selectEgress, buildTopology, egressInterface,
};
