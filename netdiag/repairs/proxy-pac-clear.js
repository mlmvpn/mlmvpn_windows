/*
 * proxy.pac.clear — SCOPE: delete AutoConfigURL from HKCU Internet Settings. Nothing else.
 *
 * Separate from `proxy.wininet.disable` because WinINET honours a PAC URL INDEPENDENTLY of
 * ProxyEnable. A machine whose browsing is broken by a dead PAC is not repaired by clearing
 * the enable flag — and a UI that reported "proxy disabled" there would be telling the user
 * something true and useless.
 *
 * It refuses on a policy-managed value. Reverting something Group Policy sets is undone at the
 * next refresh, so the repair would appear to succeed, the machine would revert minutes later,
 * and the user would conclude the tool lies. Reporting the policy is the useful answer.
 */

'use strict';

const ps = require('../ps');
const F = require('../facts');
const { IDS } = require('../rules/ids');

const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const POLICY_KEYS = [
    'HKCU:\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    'HKLM:\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
];

module.exports = [{
    id: 'proxy.pac.clear',
    label: 'پاک کردن آدرس اسکریپت پراکسی (PAC)',
    hint: 'آدرس فایل تنظیمات خودکار پراکسی را حذف می‌کند. فقط همین یک مقدار تغییر می‌کند.',
    forHypotheses: ['proxy.pac-dead'],

    privilege: 'user',
    blastRadius: 'machine',
    disruptive: false,
    reversible: true,
    requiresReboot: false,
    // Same reasoning as disabling the proxy: while it is gone, traffic takes a different path.
    exposure: 'traffic-visible',
    subsystem: 'proxy',
    expectedChanges: ['proxy.pac.url', 'proxy.pac.fetchable', 'proxy.http.via.ok'],

    target: () => ({ kind: 'machine' }),

    preconditions(facts) {
        const url = F.valueOf(facts, IDS.PROXY_PAC_URL);
        if (!url) return { ok: false, reason: 'هیچ آدرس PAC تنظیم نشده است' };
        if (F.valueOf(facts, IDS.PROXY_PAC_FETCHABLE) === true) {
            return { ok: false, reason: 'آدرس PAC در دسترس است و مشکلی ندارد' };
        }
        return { ok: true };
    },

    async capture(facts, deps) {
        const run = (deps && deps.ps) || ps;
        const r = await run.run(
            `[string](Get-ItemProperty -Path '${KEY}' -ErrorAction SilentlyContinue).AutoConfigURL`,
            { timeout: 6000 });
        return { autoConfigUrl: (r.stdout || '').trim() };
    },

    async apply(ctx) {
        const run = (ctx.deps && ctx.deps.ps) || ps;
        const policy = await run.run(
            POLICY_KEYS.map(k => `$v = (Get-ItemProperty -Path '${k}' -ErrorAction SilentlyContinue).AutoConfigURL; if ($v) { 'POLICY' }`).join('\n'),
            { timeout: 6000 });
        if (/POLICY/.test(policy.stdout || '')) {
            return {
                ok: false,
                reason: 'این آدرس را Group Policy تعیین کرده است. پاک‌کردنش در به‌روزرسانی بعدیِ سیاست‌ها برمی‌گردد، پس این ابزار آن را تغییر نمی‌دهد.',
            };
        }
        const r = await run.run(
            `Remove-ItemProperty -Path '${KEY}' -Name AutoConfigURL -ErrorAction Stop; 'done'`,
            { timeout: 8000 });
        return { ok: r.ok && /done/.test(r.stdout || ''), reason: r.reason };
    },

    async rollback(pre, deps) {
        if (!pre.autoConfigUrl) return { ok: true, reason: 'there was no PAC URL to restore' };
        const run = (deps && deps.ps) || ps;
        const r = await run.run(
            `Set-ItemProperty -Path '${KEY}' -Name AutoConfigURL -Value '${String(pre.autoConfigUrl).replace(/'/g, "''")}' -ErrorAction Stop; 'done'`,
            { timeout: 8000 });
        return { ok: r.ok && /done/.test(r.stdout || ''), reason: r.reason };
    },

    verifyWith: ['w0.inventory', 'w5.proxy-endpoint'],
}];
