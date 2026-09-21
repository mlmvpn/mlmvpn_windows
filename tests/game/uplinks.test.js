/*
 * game/uplinks.js — classification, the failover fences, and the honesty of the comparison.
 *
 * What can and cannot be tested here, stated plainly, because this module touches the
 * machine more than any other in the feature:
 *
 *   * The parts that reason — which adapters count as a real internet connection, how a
 *     comparison decides it cannot be trusted, and every fence around automatic failover —
 *     are pure and are tested properly below.
 *   * The parts that ACT — adding a host route, setting an interface metric — need
 *     elevation and a second uplink, and faking them would only test the fake. Those live
 *     in the manual test list instead, where a human with two connections runs them.
 *
 * The watcher tests below start and stop a real interval, but with `shouldRun: () => false`
 * so the loop's body can never execute: no route is added, no metric is touched, nothing is
 * measured. That is the point — the gate is exactly what is being tested.
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const uplinks = require(path.join(ROOT, 'game', 'uplinks'));

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

async function rejects(name, fn, matcher) {
    try { await fn(); t(name, false, 'did not throw'); }
    catch (err) {
        const msg = err && err.message ? err.message : String(err);
        t(name, matcher ? matcher.test(msg) : true, msg.slice(0, 80));
    }
}

(async () => {
    // ── what counts as an internet connection ────────────────────────────────────
    // Offering "switch your internet to the TAP adapter" would be offering a loop, and the
    // adapters this app itself creates are the ones most likely to be up at the moment the
    // user opens the card.
    const virt = [
        'TAP-Windows Adapter V9', 'WireGuard Tunnel', 'Tailscale Tunnel', 'Kerio Virtual Network Adapter',
        'VPN Client Adapter - VPN', 'Hyper-V Virtual Ethernet Adapter', 'VMware Virtual Ethernet Adapter',
        'MLMVPN', 'Wintun Userspace Tunnel',
    ];
    for (const v of virt) {
        t(`«${v.slice(0, 28)}» is not offered as an internet connection`, uplinks.VIRTUAL.test(v), v);
    }
    const real = ['Realtek RTL8188FTV Wireless LAN 802.11n USB 2.0 Network Adapter', 'Intel(R) Ethernet Connection I217-LM'];
    for (const r of real) t(`«${r.slice(0, 28)}» IS a real connection`, !uplinks.VIRTUAL.test(r), r);

    // ── classification drives the icon and the wording, so it has to be right ────
    t('a Realtek 802.11n USB stick is Wi-Fi', uplinks.kindOf('Realtek RTL8188FTV Wireless LAN 802.11n USB 2.0', 'Wi-Fi 3').kind === 'wifi');
    t('an Intel I217-LM is ethernet', uplinks.kindOf('Intel(R) Ethernet Connection I217-LM', 'Ethernet').kind === 'ethernet');
    t('a phone shared over USB is a tether, not ethernet',
        uplinks.kindOf('Remote NDIS based Internet Sharing Device', 'Ethernet 5').kind === 'tether',
        JSON.stringify(uplinks.kindOf('Remote NDIS based Internet Sharing Device', 'Ethernet 5')));
    t('an LTE modem is cellular', uplinks.kindOf('Huawei Mobile Broadband LTE', 'Cellular').kind === 'cellular');
    t('every kind carries Persian wording for the card', ['wifi', 'ethernet', 'cellular', 'tether']
        .every(k => typeof uplinks.kindOf(k === 'wifi' ? 'wireless' : k === 'cellular' ? 'LTE modem' : k === 'tether' ? 'RNDIS tether' : 'Intel Ethernet', '').fa === 'string'));

    // ── the failover fences ──────────────────────────────────────────────────────
    // Every one of these numbers is a promise made in the UI text. If a future edit makes
    // failover eager, the card's claim ("only after three consecutive bad checks") becomes
    // a lie, and the user finds out by having their connection swapped mid-match.
    const F = uplinks.FAILOVER;
    t('a single bad sample can never trigger a switch', F.strikesNeeded >= 3, 'strikesNeeded=' + F.strikesNeeded);
    t('there is a cooldown, so a bad night cannot become a flapping loop', F.cooldownMs >= 60000, F.cooldownMs + 'ms');
    t('the health check is cheap — it decides "dead or collapsing", not "which is better"',
        F.seconds <= 3 && F.pps <= 10, `${F.seconds}s @ ${F.pps}pps`);
    t('checks are spaced out rather than continuous', F.intervalMs >= 10000, F.intervalMs + 'ms');
    t('"bad" is a threshold a playable path would not cross', F.badP95 >= 300 && F.badLoss >= 5,
        `p95>=${F.badP95} loss>=${F.badLoss}%`);

    // ── the watcher's lifecycle ──────────────────────────────────────────────────
    const seen = [];
    t('the watcher is off until asked', uplinks.watchStatus().on === false);
    const started = uplinks.startWatch({ shouldRun: () => false, onEvent: e => seen.push(e.type) });
    t('starting reports itself as on', started.on === true, JSON.stringify(started));
    t('…and announces it, because a silent watcher is indistinguishable from none', seen.includes('watch-on'), seen.join(','));
    t('starting twice does not create a second watcher', uplinks.startWatch({}).on === true);
    t('stopping turns it off', uplinks.stopWatch().on === false);
    t('stopping again is safe', uplinks.stopWatch().on === false);
    t('a stopped watcher reports no strikes', uplinks.watchStatus().strikes === 0);

    // ── switching refuses what it cannot do ──────────────────────────────────────
    await rejects('preferring an interface that does not exist is refused',
        () => uplinks.prefer('999999'), /وجود ندارد/);
    await rejects('restoring with nothing recorded is refused rather than guessing',
        () => uplinks.restore(), /ثبت نشده/);

    let failed = 0;
    for (const x of results) {
        if (!x.ok) failed++;
        console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + x.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
