/*
 * proxy.wininet.disable — SCOPE: HKCU Internet Settings, ProxyEnable → 0. Nothing else.
 *
 * The generic id `proxy.disable` is deliberately retired. A repair whose name does not name
 * its subsystem is exactly how the wrong proxy subsystem gets modified, and there are four of
 * them here: WinINET (the browser's), WinHTTP (services'), the machine policy hive, and PAC.
 *
 * It does NOT call `xray-manager.js:509 enableSystemProxy(false)`, and that helper is left
 * completely unchanged because other features and an existing route depend on it. Its scope
 * does not match this contract:
 *
 *   * it flips the same ProxyEnable flag, but leaves `ProxyServer` behind — fine for it,
 *     wrong for a repair that must roll back byte-exactly;
 *   * it never touches `AutoConfigURL`, so a machine broken by a dead PAC is NOT repaired by
 *     it while the UI would report the proxy disabled;
 *   * it writes its WinINET-refresh script to a FIXED path under %TEMP% and runs it elevated,
 *     which is a file-planting shape this feature does not inherit.
 *
 * `ProxyServer` is preserved on purpose. Disabling is the reversible act; deleting the string
 * is not. Preserving it makes rollback exact and keeps the repair honest — «پراکسی موقتاً
 * غیرفعال شد» rather than a silent destruction of the user's configuration.
 */

'use strict';

const F = require('../facts');
const ps = require('../ps');
const O = require('../ownership');
const { IDS } = require('../rules/ids');

const KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * Broadcast the WinINET settings change.
 *
 * No temp file at all — the P/Invoke is defined inline and the script arrives over stdin, so
 * there is no path for anything to be planted at. Options 39 and 37 are
 * INTERNET_OPTION_SETTINGS_CHANGED and INTERNET_OPTION_REFRESH.
 */
const REFRESH = `
$sig = '[DllImport("wininet.dll")] public static extern bool InternetSetOption(int h,int o,int b,int l);'
$t = Add-Type -MemberDefinition $sig -Name wininet -Namespace netdiag -PassThru
[void]$t::InternetSetOption(0,39,0,0)
[void]$t::InternetSetOption(0,37,0,0)
`;

module.exports = [{
    id: 'proxy.wininet.disable',
    label: 'خاموش کردن پراکسی سیستم (فقط برای مرورگر)',
    hint: 'کلید ProxyEnable ویندوز را صفر می‌کند. نشانی پراکسی پاک نمی‌شود تا بتوان دقیقاً برگرداند.',
    forHypotheses: ['proxy.dead-listener'],

    privilege: 'user',                 // HKCU: the interactive user's own hive
    blastRadius: 'machine',
    disruptive: false,
    reversible: true,
    requiresReboot: false,
    // Never auto. While the proxy is off, traffic that was going through a tunnel goes direct.
    exposure: 'traffic-visible',
    subsystem: 'proxy',
    ownershipFactId: IDS.PROXY_ENDPOINT_OWNERSHIP,

    // Regression must not fire on the thing the repair exists to change.
    expectedChanges: ['proxy.wininet.enabled', 'proxy.http.via.ok'],

    target: () => ({ kind: 'machine' }),

    preconditions(facts) {
        if (F.valueOf(facts, IDS.PROXY_WININET_ENABLED) !== true) {
            return { ok: false, reason: 'پراکسی سیستم از قبل خاموش است' };
        }
        if (F.valueOf(facts, IDS.PROXY_ENDPOINT_TCP_OK) === true) {
            // Something answers there now. Whatever the session concluded, it is stale.
            return { ok: false, reason: 'اکنون برنامه‌ای روی آن پورت پاسخ می‌دهد؛ تشخیص قدیمی شده است' };
        }
        if (F.valueOf(facts, IDS.PROXY_ENDPOINT_OWNERSHIP) !== O.OWNERSHIP.FOREIGN) {
            return { ok: false, reason: 'ثابت نشده که این پراکسی متعلق به برنامهٔ دیگری است' };
        }
        return { ok: true };
    },

    /**
     * Capture EVERYTHING the subsystem holds, including the values this repair will not
     * touch, so rollback can prove it restored exactly what changed and nothing else.
     */
    async capture(facts, deps) {
        const run = (deps && deps.ps) || ps;
        const r = await run.run(
            `$p = Get-ItemProperty -Path '${KEY}' -ErrorAction SilentlyContinue
@{ enable = [int]$p.ProxyEnable; server = [string]$p.ProxyServer; pac = $p.AutoConfigURL; bypass = $p.ProxyOverride } | ConvertTo-Json -Compress`,
            { timeout: 6000 });
        const j = run.parseJson(r.stdout);
        const v = (j.ok && j.value[0]) || {};
        return {
            proxyEnable: v.enable === 1 ? 1 : 0,
            proxyServer: typeof v.server === 'string' ? v.server : '',
            autoConfigUrl: v.pac === undefined || v.pac === null ? null : String(v.pac),
            proxyOverride: v.bypass === undefined || v.bypass === null ? null : String(v.bypass),
        };
    },

    async apply(ctx) {
        const run = (ctx.deps && ctx.deps.ps) || ps;
        const r = await run.run(
            `Set-ItemProperty -Path '${KEY}' -Name ProxyEnable -Value 0 -Type DWord -ErrorAction Stop
${REFRESH}
'done'`,
            { timeout: 10000 });
        if (!r.ok) return { ok: false, reason: r.reason };
        return { ok: /done/.test(r.stdout || ''), log: (r.stdout || '').trim(), reason: r.ok ? null : r.reason };
    },

    /**
     * Restore only what was changed — ProxyEnable — and only if it still holds the value this
     * repair wrote. A different value means someone else has been here since, and overwriting
     * their change would be a second unwanted write on top of the first.
     */
    async rollback(pre, deps) {
        const run = (deps && deps.ps) || ps;
        const cur = await run.run(`[int](Get-ItemProperty -Path '${KEY}' -ErrorAction SilentlyContinue).ProxyEnable`, { timeout: 6000 });
        const now = parseInt((cur.stdout || '').trim(), 10);
        if (Number.isFinite(now) && now !== 0) {
            return { ok: false, reason: 'rollback-impossible: مقدار فعلی همانی نیست که ما نوشتیم' };
        }
        const r = await run.run(
            `Set-ItemProperty -Path '${KEY}' -Name ProxyEnable -Value ${pre.proxyEnable} -Type DWord -ErrorAction Stop
${REFRESH}
'done'`, { timeout: 10000 });
        return { ok: r.ok && /done/.test(r.stdout || ''), reason: r.reason };
    },

    verifyWith: ['w0.inventory', 'w5.proxy-endpoint', 'w5.http-dual'],
}];
