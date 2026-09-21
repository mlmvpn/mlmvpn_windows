/*
 * guard.restore-stale — SCOPE: call `aether-guard.restoreIfStale()`. Nothing else, ever.
 *
 * This repair exists because of the one that does not. The first design had
 * `firewall.allow-out` → `Set-NetFirewallProfile -All -DefaultOutboundAction Allow`, triggered
 * by a layer that treated `DefaultOutboundAction = Block` as a fault. But this app SETS that
 * Block on purpose: it is the fail-closed leak protection documented at the top of
 * `aether-guard.js`, and the GitHub Tunnel guard sets the same. That "fix" would have switched
 * off leak protection while a tunnel was up, exposed an Iranian user's real IP, and reported
 * success.
 *
 * So there is no blanket firewall repair here and there never will be. A Block this app cannot
 * attribute to itself is REPORTED, never reversed. A Block it CAN attribute to an abandoned
 * run is undone by the guard's own tested recovery path — the code that knows what it recorded
 * and how to put it back — and by nothing else.
 */

'use strict';

const F = require('../facts');
const O = require('../ownership');
const { IDS } = require('../rules/ids');

module.exports = [{
    id: 'guard.restore-stale',
    label: 'برگرداندن محافظت جامانده از اجرای قبلی',
    hint: 'مسیر بازیابیِ خودِ محافظ را صدا می‌زند تا فایروال و DNS به حالت پیش از آن اجرا برگردند.',
    forHypotheses: ['vpn.stale-protection'],

    privilege: 'admin',
    blastRadius: 'machine',
    disruptive: true,
    reversible: true,
    requiresReboot: false,
    exposure: 'traffic-visible',
    subsystem: 'engine',
    ownershipFactId: IDS.APP_GUARD_STATE,
    expectedChanges: ['fw.outbound.block', 'dns.config.*', 'app.guard.state', 'reach.*', 'probe.*'],

    target: () => ({ kind: 'machine' }),

    /**
     * The ownership gate is the whole safety of this repair.
     *
     * `ours-live` means a tunnel is up and the Block is deliberate — undoing it is the leak.
     * `unknown` means we could not prove it is ours, and unwinding protection we do not
     * understand is exactly the class of action the Prime Directive forbids.
     */
    preconditions(facts) {
        if (F.valueOf(facts, IDS.FW_OUTBOUND_BLOCK) !== true) {
            return { ok: false, reason: 'ترافیک خروجی مسدود نیست' };
        }
        const guard = F.valueOf(facts, IDS.APP_GUARD_STATE);
        if (guard === O.OWNERSHIP.OURS_LIVE) {
            return { ok: false, reason: 'محافظت هم‌اکنون فعال و عمدی است — برای خاموش‌کردنش تونل را از خود برنامه ببندید' };
        }
        if (guard !== O.OWNERSHIP.OURS_ORPHANED) {
            return { ok: false, reason: 'ثابت نشده این محافظت از یک اجرای ناتمامِ همین برنامه باقی مانده است' };
        }
        if (F.valueOf(facts, IDS.APP_ENGINE_RUNNING) === true) {
            return { ok: false, reason: 'یکی از موتورها در حال اجراست؛ اول آن را ببندید' };
        }
        return { ok: true };
    },

    // This repair is the exception to the engines-quiet gate: it exists precisely for the
    // state where the engine is gone and its protection is not.
    requiresEnginesQuiet: false,

    async capture(facts) {
        return { firewallEngaged: F.valueOf(facts, IDS.FW_OUTBOUND_BLOCK) === true };
    },

    /**
     * Delegated entirely. `aether-guard` recorded the pre-change state on disk before it
     * touched anything (`aether-guard.js:22-29`), so it — and only it — knows what "before"
     * was. Re-deriving that here would be a second, worse implementation of a path that is
     * already tested, and its mistakes would be permanent firewall state.
     */
    async apply(ctx) {
        const guard = (ctx.deps && ctx.deps.guard) || require('../../aether-guard');
        if (typeof guard.restoreIfStale !== 'function') {
            return { ok: false, reason: 'aether-guard does not expose restoreIfStale' };
        }
        const lines = [];
        try {
            await guard.restoreIfStale(m => lines.push(String(m)));
            return { ok: true, log: lines.join('\n') };
        } catch (e) {
            return { ok: false, reason: e.message, log: lines.join('\n') };
        }
    },

    /**
     * No rollback. Re-engaging a kill switch whose owner is gone would put the machine back
     * into the blackout the user came here to escape, and the guard's restore is already the
     * "put it back" direction. `reversible: true` is about the guard's own journal being the
     * mechanism, not about this repair having an inverse.
     */
    async rollback() {
        return { ok: true, reason: 'the guard\'s own restore is the reversal; re-engaging a dead run\'s kill switch is not offered' };
    },

    verifyWith: ['w0.inventory', 'w1.gateway', 'w2.foreign'],
}];
