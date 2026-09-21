/*
 * Watching the line while the game runs — the spike detector and what it blames.
 *
 * WHY THIS IS THE PART WORTH PINNING
 * The sampling is plumbing: a process emits lines, a socket sends ten packets. The JUDGEMENT is
 * where this feature is either useful or worse than nothing, because it makes a claim about cause
 * and a player will act on it. Telling somebody their Wi-Fi collapsed when their upload was
 * saturated sends them to buy a router they did not need.
 *
 * Verified live before this was written — 40 seconds on a real line produced four spikes with
 * latency swinging 410ms → 2681ms and 22% loss, while upload, download, Wi-Fi rate and CPU never
 * moved. The verdict was «هیچ‌کدام از این دستگاه نبود», which is correct and is the single most
 * useful thing this can say: stop hunting for something to switch off.
 *
 * Pure — no sockets, no processes. Samples are supplied.
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const watch = require(path.join(ROOT, 'game', 'watch'));

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

/** A calm sample, with everything at rest. Overrides make it interesting. */
const s = (over = {}) => Object.assign({
    at: Date.now(), ok: true, p50: 60, p95: 70, loss: 0,
    rxKbps: 100, txKbps: 50, wifiRate: 150, wifiSignal: 90, cpu: 10,
}, over);

const calm = () => Array.from({ length: 10 }, () => s());

// ── what counts as a spike ───────────────────────────────────────────────────────
{
    t('a steady session has no spikes', watch.findSpikes(calm()).length === 0);

    t('too few samples is no verdict rather than a guess from three points',
        watch.findSpikes([s(), s({ p95: 900 })]).length === 0);

    // Relative, not absolute: this is the whole reason a 300ms player is not warned constantly.
    const slowButSteady = Array.from({ length: 10 }, () => s({ p50: 300, p95: 330 }));
    t('a slow line that stays slow is not a spike — 300ms steady is a playable game',
        watch.findSpikes(slowButSteady).length === 0);

    const slowThenWorse = slowButSteady.concat([s({ p50: 300, p95: 1200 })]);
    t('…and the same line doubling IS a spike', watch.findSpikes(slowThenWorse).length === 1);

    // A fast line must not report a spike for a few milliseconds of nothing.
    const fastWobble = Array.from({ length: 10 }, () => s({ p50: 12, p95: 14 })).concat([s({ p50: 12, p95: 30 })]);
    t('a 12ms line wobbling to 30ms is not a spike — true, and useless to say',
        watch.findSpikes(fastWobble).length === 0, 'the floor exists for exactly this');

    // Loss is its own way to fail. A Wi-Fi collapse usually shows here first.
    const lossy = calm().concat([s({ loss: 30 })]);
    const found = watch.findSpikes(lossy);
    t('packets vanishing is a spike even when latency did not move',
        found.length === 1 && found[0].why === 'loss', JSON.stringify(found.map(f => f.why)));
}

// ── what it blames, which is the part a player acts on ───────────────────────────
{
    const base = calm();

    const upload = s({ p95: 900, txKbps: 9000 });
    const b1 = watch.blameFor(upload, base.concat([upload]));
    t('a saturated upload is blamed on the upload', b1.some(b => b.kind === 'upload'), JSON.stringify(b1));
    t('…and is marked as something the user can act on', b1.find(b => b.kind === 'upload').actionable === true);

    const download = s({ p95: 900, rxKbps: 40000 });
    t('a saturated download is blamed on the download',
        watch.blameFor(download, base.concat([download])).some(b => b.kind === 'download'));

    const wifi = s({ p95: 900, wifiRate: 6 });
    t('a Wi-Fi rate that collapsed is named, because no routing fixes it',
        watch.blameFor(wifi, base.concat([wifi])).some(b => b.kind === 'wifi'));

    const cpu = s({ p95: 900, cpu: 99 });
    const bc = watch.blameFor(cpu, base.concat([cpu]));
    t('a pinned CPU is named as a PICTURE stall, not a network one',
        bc.some(b => b.kind === 'cpu' && /تصویر/.test(b.fa)), JSON.stringify(bc));

    // The most important case, and the one the live run actually produced.
    const nothing = s({ p95: 2600, loss: 22 });
    const bn = watch.blameFor(nothing, base.concat([nothing]));
    t('when nothing on the machine moved, it says so — that is an answer, not a gap',
        bn.length === 1 && bn[0].kind === 'upstream', JSON.stringify(bn));
    t('…and marks it as NOT actionable, so the player stops hunting',
        bn[0].actionable === false);
}

// ── the report ───────────────────────────────────────────────────────────────────
{
    t('a median ignores one outlier, which a mean would not',
        watch.median([10, 10, 10, 10, 5000]) === 10);
    t('an empty set has no median rather than NaN', watch.median([]) === null);
    t('the report refuses to judge a session that barely started',
        watch.report().ok === false);
}

let failed = 0;
for (const x of results) {
    if (!x.ok) failed++;
    console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + (x.detail || '')}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
