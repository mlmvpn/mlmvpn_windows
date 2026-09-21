/*
 * dns.flush — SCOPE: the DNS client cache. Nothing is configured, nothing is written.
 *
 * The only genuinely auto-tier repair in the set: it cannot expose traffic, cannot outlive
 * itself, and there is nothing to roll back because there is no pre-state a user could want
 * returned. `capture` returns an empty object and `rollback` is a no-op, and both are present
 * rather than omitted so the lifecycle has no special case for "the repair without a
 * pre-state" — a special case is where the next repair's rollback quietly gets skipped.
 */

'use strict';

const ps = require('../ps');
const { IDS } = require('../rules/ids');
const F = require('../facts');

module.exports = [{
    id: 'dns.flush',
    label: 'پاک کردن حافظهٔ موقت DNS',
    hint: 'پاسخ‌های ذخیره‌شدهٔ قدیمی را دور می‌ریزد تا ویندوز دوباره از سرور بپرسد.',
    forHypotheses: ['dns.resolver-unreachable', 'dns.answer-anomaly'],

    privilege: 'admin',
    blastRadius: 'adapter',
    disruptive: false,
    reversible: true,
    requiresReboot: false,
    exposure: 'none',
    subsystem: 'dns',

    // Emptying a cache changes what resolves. That is the point, not a regression.
    expectedChanges: ['dns.resolve.ok.v4', 'dns.resolve.os.ok.v4', 'dns.answer.*'],

    target: () => ({ kind: 'machine' }),

    preconditions(facts) {
        // Pointless while the service that owns the cache is stopped, and running it there
        // would report a success that changed nothing.
        if (F.valueOf(facts, IDS.SVC_DNSCACHE_RUNNING) === false) {
            return { ok: false, reason: 'سرویس DNS Client اجرا نیست، پس پاک‌کردن حافظهٔ موقت اثری ندارد' };
        }
        return { ok: true };
    },

    async capture() { return {}; },

    async apply(ctx) {
        const run = (ctx.deps && ctx.deps.ps) || ps;
        const r = await run.run("Clear-DnsClientCache -ErrorAction Stop; 'done'", { timeout: 8000 });
        return { ok: r.ok && /done/.test(r.stdout || ''), reason: r.reason, log: (r.stdout || '').trim() };
    },

    async rollback() {
        // A cache cannot be un-flushed, and pretending otherwise would make `reversible` a lie
        // somewhere it matters. It is reversible in the sense the tier model cares about:
        // nothing the user configured was changed, so there is nothing to put back.
        return { ok: true, reason: 'nothing to restore: no configuration was changed' };
    },

    verifyWith: ['w3.resolution'],
}];
