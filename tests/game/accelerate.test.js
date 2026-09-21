/*
 * game/accelerate.js — the one button, and the two places where it could lie.
 *
 * WHY THESE TWO FUNCTIONS AND NOT THE PIPELINE ITSELF
 * The pipeline starts engines, writes firewall rules and changes system DNS; running it here
 * would test the machine, not the code, and would leave a test suite that changes the
 * developer's connection. What CAN be pinned — and is where every past failure of this
 * feature actually lived — is the reasoning:
 *
 *   buildSummary()  decides what the user is told happened. Its first version counted only
 *                   successes, so a run whose biggest step FAILED for want of admin rights
 *                   announced «هیچ کاری لازم نبود». That single sentence is why the user
 *                   concluded the whole feature was decorative, and it was not even true.
 *
 * The DNS ranking used to live here too. It was removed on 2026-09-14 — see the note below
 * where its assertions were — and now lives in `dnspick.test.js`, which pins a rule that is
 * measured rather than declared.
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const accel = require(path.join(ROOT, 'game', 'accelerate'));

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

const game = { id: 'test', fa: 'بازی تستی' };

// ── the summary must never flatter ───────────────────────────────────────────────
{
    const failed = accel.buildSummary({
        game, done: {}, directResult: { ok: true, min: 40, p95: 60, loss: 0, score: 83 }, undo: [],
        outcomes: {
            detect: { status: 'done', detail: 'ok' },
            line: { status: 'failed', detail: 'محدود کردن ممکن نشد — برنامه را با دسترسی مدیر اجرا کن.' },
            pc: { status: 'skipped', detail: 'همه‌ی تنظیمات از قبل درست بودند.' },
        },
    });
    t('a failed step leads the headline instead of being counted as nothing',
        /انجام نشد|شکست/.test(failed.headline), failed.headline);
    t('…and when the cause is elevation, the headline says what to do',
        /Run as administrator|دسترسی مدیر/.test(failed.headline), failed.headline);
    t('…and the failure is repeated in the notes, not only in the headline',
        (failed.notes || []).some(n => /معطوف‌سازی اینترنت/.test(n)), JSON.stringify(failed.notes));
    t('a run with a failure NEVER claims everything was already fine',
        !/همه‌چیز از قبل/.test(failed.headline), failed.headline);
}

// ── "nothing was needed" is allowed only when that is true ───────────────────────
{
    const clean = accel.buildSummary({
        game, done: {}, directResult: { ok: true, min: 40, p95: 60, loss: 0, score: 83 }, undo: [],
        outcomes: {
            line: { status: 'skipped', detail: 'خط از قبل آزاد بود' },
            pc: { status: 'skipped', detail: 'از قبل درست بود' },
            path: { status: 'skipped', detail: 'هیچ تونلی بهتر نشد' },
        },
    });
    t('with only skips and a healthy line, the honest headline is "already fine"',
        /از قبل/.test(clean.headline), clean.headline);
    t('…and it does not invent notes about a line that is fine',
        !(clean.notes || []).some(n => /خطت همین الان بد است/.test(n)), JSON.stringify(clean.notes));
}

// ── a bad line with no tunnel that helped is a FINDING, not silence ──────────────
{
    const stuck = accel.buildSummary({
        game, done: {}, directResult: { ok: true, min: 310, p95: 584, loss: 0, score: 9 }, undo: [],
        outcomes: { path: { status: 'skipped', detail: 'هیچ تونلی بهتر نشد' } },
    });
    t('when nothing helped AND the line scores badly, the user is told why',
        (stuck.notes || []).some(n => /مسیر بین‌الملل/.test(n)), JSON.stringify(stuck.notes));
}

// ── the engine case ──────────────────────────────────────────────────────────────
{
    const won = accel.buildSummary({
        game,
        done: { engine: { fa: 'Aether — وارپ در وارپ' }, dns: { fa: 'الکترو' }, shaped: ['steam.exe'] },
        directResult: { ok: false }, undo: ['شتاب روشن شد'],
        outcomes: { path: { status: 'done', detail: 'ok' } },
    });
    t('when a tunnel was taken, the headline names it', /وارپ در وارپ/.test(won.headline), won.headline);
    t('a blocked direct path is reported as such', won.directBlocked === true, String(won.directBlocked));
    t('the undo list survives into the summary, so the UI can offer to revert',
        (won.undo || []).length === 1, JSON.stringify(won.undo));
}

// ── the DNS ranking moved out of this file ──────────────────
//
// `pickBestDns` and its fixture lived here, and the first assertion read «the game-focused
// anti-sanction resolver wins even when it is the slowest». That was a faithful test of a
// MISTAKEN RULE: the resolver was chosen by NAME, because the only data available was a
// `www.google.com` ping that says nothing about whether a resolver can open a sanctioned
// launcher. Users got «الکترو» every single time and were right to complain.
//
// Its replacement measures coverage against the game's own platform domains and is pinned in
// `dnspick.test.js`.

// ── the steps the UI renders must match the ones the pipeline emits ──────────────
{
    const ids = accel.STEPS.map(s => s.id);
    t('every step has an id and Persian wording',
        accel.STEPS.every(s => s.id && s.fa), JSON.stringify(accel.STEPS.map(s => s.id)));
    t('the line-freeing step comes before the tunnel step — cheapest and surest first',
        ids.indexOf('line') < ids.indexOf('path'), ids.join(' -> '));
    t('DNS is fixed before the direct path is judged, or the judgement is about a broken resolver',
        ids.indexOf('dns') < ids.indexOf('direct'), ids.join(' -> '));
    t('the control is measured before a tunnel is chosen', ids.indexOf('direct') < ids.indexOf('path'));
}

let failed = 0;
for (const x of results) {
    if (!x.ok) failed++;
    console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
