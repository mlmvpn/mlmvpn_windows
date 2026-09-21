/*
 * W0 — the Winsock catalog.
 *
 * A separate collector rather than another section of the batched inventory, because
 * `netsh winsock show catalog` is text (not a cmdlet), it is comparatively slow, and it can be
 * large. Folding it into the one-script-one-JSON inventory would put the whole wave at the
 * mercy of its size — which is exactly how the hosts file once took the entire inventory down.
 *
 * A third-party layered service provider is one of the few things that can black-hole traffic
 * while every adapter, route and resolver looks perfect. Its PRESENCE is provable from here;
 * its guilt is not, which is why the hypothesis that consumes this fact explains nothing and
 * can only ever be an independent finding.
 */

'use strict';

const F = require('../facts');
const ps = require('../ps');
const { IDS } = require('../rules/ids');

module.exports = [{
    id: 'w0.winsock',
    wave: 'w0',
    label: 'بررسی افزونه‌های شبکهٔ ویندوز',
    network: false,
    timeout: 8000,
    produces: [IDS.WINSOCK_THIRDPARTY_COUNT],

    async run(ctx) {
        const r = await ps.run('netsh winsock show catalog', { timeout: ctx.budgetFor(6000) });
        if (!r.ok) {
            return ctx.put(F.unknown(IDS.WINSOCK_THIRDPARTY_COUNT,
                `netsh winsock show catalog failed: ${r.reason}`));
        }
        const parsed = ps.parseWinsockCatalog(r.stdout);
        if (!parsed.ok) {
            // Unreadable is unknown. Reporting zero here would quietly assert "the catalog is
            // clean" about a catalog nobody managed to read.
            return ctx.put(F.unknown(IDS.WINSOCK_THIRDPARTY_COUNT, parsed.reason));
        }
        ctx.put(F.observed(IDS.WINSOCK_THIRDPARTY_COUNT, parsed.thirdParty.length, {
            quality: F.QUALITY.REPORTED,
            source: 'netsh:winsock',
            note: parsed.thirdParty.length
                ? parsed.thirdParty.map(p => p.base).join(', ')
                : null,
            raw: parsed.value.map(p => `${p.path}${p.microsoft ? '' : ' [third-party]'}`).join('\n'),
        }));
    },
}];
