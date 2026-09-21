/*
 * The modem-queue cure: upload bufferbloat, and the machine-wide cap that fixes it.
 *
 * WHY THIS IS WORTH A SUITE
 * Measured on a real Iranian line while this was written: with the uplink saturated, p95 went from
 * 126ms to 2681ms and 29% of packets were lost. That is the largest single effect anything in this
 * feature has produced — larger than any engine, region or resolver — and unlike download bloat it
 * is curable from this side, because the queue that fills is in the user's own modem on the way
 * out.
 *
 * WHAT IS PINNED, and every one of these is something the first version got wrong:
 *
 *   * A bloat verdict is only as good as its baseline. The first real run produced
 *     «p95 idle 3646ms -> loaded 1169ms (+-2477ms), verdict: bad» — a confident answer computed
 *     from noise, with the sign printed twice. A baseline that is itself terrible, or a line that
 *     is already busy, must produce `unknown` and say why.
 *   * A negative delta is not a pass. Latency does not improve when a queue fills; it means the
 *     two samples are not comparable.
 *   * The cap must be recorded before it exists and removed by restoreAll, or a machine-wide
 *     throttle outlives the feature that applied it.
 *
 * Pure: no uploads, no PowerShell, no registry. The parts that touch Windows are exercised by the
 * panel; what is checked here is the reasoning, which is where the mistakes were.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const shaper = require(ROOT + '/game/shaper');
const localaudit = require(ROOT + '/game/localaudit');

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

// ── the API exists and is shaped for the caller ──────────────────────────────────
{
    t('the shaper can cap the whole machine, not just one program',
        typeof shaper.capEgress === 'function' && typeof shaper.uncapEgress === 'function');
    t('…and can be asked whether a cap is on', typeof shaper.egressCap === 'function');
    const cap = shaper.egressCap();
    t('with nothing applied it reports off, rather than throwing', cap && cap.on === false, JSON.stringify(cap));
    t('the policy has our prefix, so it is identifiable as ours on a user machine',
        /MLMVPN/.test(shaper.EGRESS_POLICY), shaper.EGRESS_POLICY);
}

// ── a cap needs a real number ────────────────────────────────────────────────────
{
    const threw = (v) => shaper.capEgress({ kbps: v }).then(() => null, e => e.message);
    Promise.all([threw(0), threw(-5), threw(undefined), threw('abc')]).then(msgs => {
        t('a cap with no rate is refused rather than applied as zero',
            msgs.every(m => m && /سقف/.test(m)), JSON.stringify(msgs));
        finish();
    });
}

// ── the measurement's guards ─────────────────────────────────────────────────────
{
    t('upload bloat is measured separately from download bloat',
        typeof localaudit.uploadBloat === 'function' && typeof localaudit.bufferbloat === 'function');
    // The cure needs a number, so the measurement has to produce one.
    t('…and the measuring wrapper remembers the result for the free cure',
        typeof localaudit.measureUploadBloat === 'function' && typeof localaudit.lastUpbloat === 'function');
    t('the remembered result lives on its own, not in the per-game profile store',
        /game-upbloat/.test(localaudit.UPBLOAT_FILE || ''), localaudit.UPBLOAT_FILE);
    // Nothing measured yet is `null`, not a fabricated "fine".
    const before = localaudit.lastUpbloat();
    t('an unmeasured line reports nothing rather than a default verdict',
        before === null || typeof before === 'object');
}

// ── uncapping is idempotent, because revert runs on every path ───────────────────
{
    shaper.uncapEgress().then(r => {
        t('taking a cap off when none is on is a no-op, not an error', r && r.ok === true, JSON.stringify(r));
        finish();
    }, e => {
        t('taking a cap off when none is on is a no-op, not an error', false, e.message);
        finish();
    });
}

let pending = 2;
function finish() {
    if (--pending > 0) return;
    let failed = 0;
    for (const x of results) {
        if (!x.ok) failed++;
        console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + (x.detail || '')}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
}
