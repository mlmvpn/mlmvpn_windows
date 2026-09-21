/*
 * The report.
 *
 * A pure function of the session — no I/O, not even a clock read — so the text a user pastes
 * into a support chat can be regenerated from a saved session file months later and come out
 * identical. That is the same property replay gives the reasoning, applied to the words.
 *
 * The eight headings are fixed and in this order, because in this order they answer what a
 * person actually needs to know:
 *
 *   1 what happened            5 what we want to do about it
 *   2 why pages do not open    6 what it risks
 *   3 what we actually MEASURED 7 what we re-checked afterwards
 *   4 what is still UNKNOWN    8 whether the user's problem is really gone
 *
 * Sections 3 and 4 are the ones that make the rest trustworthy. A tool that says "DNS is
 * broken" and stops is indistinguishable from a guess; one that says "we measured these
 * fourteen things, and these four we could not measure" can be argued with — and that is what
 * makes it useful to a supporter reading it cold.
 *
 * The wording contract is enforced here, not left to the caller. Every verdict maps to exactly
 * one Persian phrase, and two sentences are structurally impossible to emit: «حل شد» for
 * anything that is not a verified fix, and «مشکلی پیدا نشد» when the truth is that the evidence
 * did not reach.
 */

'use strict';

const F = require('./facts');
const V = require('./verify');

/** The only place a verdict becomes Persian. Nothing below writes a confidence by hand. */
const VERDICT_TEXT = Object.freeze({
    confirmed: 'علت پیدا شد',
    likely: 'به احتمال زیاد',
    possible: 'یکی از احتمال‌ها',
    indeterminate: 'نامشخص',
    eliminated: 'رد شد',
});

const CAP_TEXT = Object.freeze({
    'unknown-mass': 'بخش زیادی از شواهد قابل اندازه‌گیری نبود',
    'generation-span': 'وضعیت شبکه در حین بررسی تغییر کرد',
    conflict: 'شواهد متناقض بود',
    'ownership-unknown': 'مشخص نشد این تنظیم را خودِ برنامه انجام داده یا نه',
});

const TIER_TEXT = Object.freeze({
    auto: 'بی‌خطر',
    confirm: 'نیازمند تأیید',
    'confirm-danger': 'پرخطر',
});

function fa(n) {
    return Number(n).toLocaleString('fa-IR');
}

function line(L, s) { L.push(s === undefined ? '' : s); }

function rule(L, title) {
    line(L, '');
    line(L, `── ${title} ${'─'.repeat(Math.max(0, 58 - title.length))}`);
}

/** A finding, one line, with its verdict named rather than implied. */
function findingLine(e) {
    const v = VERDICT_TEXT[e.verdict] || e.verdict;
    const caps = (e.caps || []).map(c => CAP_TEXT[c]).filter(Boolean);
    let s = `  • [${v}] ${e.title || e.id}`;
    if (e.consequenceOf) s += `  (نتیجهٔ: ${e.consequenceOf})`;
    if (caps.length) s += `\n      ${caps.join(' · ')}`;
    for (const c of e.conflicts || []) if (c.note) s += `\n      ${c.note}`;
    return s;
}

/**
 * Build the report.
 *
 * `session` and `diagnosis` in, text out. `offers` and `verifications` are read from the
 * session so a saved file reproduces the same document.
 */
function buildReport(session, diagnosis) {
    const L = [];
    const n = diagnosis || session.diagnosis || null;
    const facts = session.facts || {};

    line(L, '════════════════════════════════════════════════════════════');
    line(L, '  گزارش دیاگ اینترنت');
    line(L, '════════════════════════════════════════════════════════════');
    line(L, `  شناسهٔ بررسی : ${session.sessionId}`);
    line(L, `  زمان        : ${session.startedAtWall || '—'}`);
    line(L, `  حالت        : ${session.mode === 'quick' ? 'سریع' : 'کامل'}`);
    if (session.host && session.host.build) line(L, `  ویندوز      : ${session.host.build} (${session.host.locale || '—'})`);
    if (session.generation && session.generation.unstable) {
        line(L, '  توجه        : وضعیت شبکه در حین بررسی تغییر کرد، پس نتیجه با اطمینان کمتری گفته می‌شود.');
    }
    if (session.cancelled) line(L, '  توجه        : بررسی نیمه‌کاره متوقف شد؛ نتیجه از همان چیزی است که تا آن لحظه جمع شد.');

    // ── 1 ──
    rule(L, '۱) چه اتفاقی افتاده؟');
    if (!n) {
        line(L, '  بررسی هنوز کامل نشده است.');
    } else {
        const h = n.headline || {};
        if (h.kind === 'single-root') {
            const e = n.rootCauses.find(x => x.id === h.id);
            line(L, e ? findingLine(e) : '  —');
        } else if (h.kind === 'multiple-roots') {
            line(L, `  ${fa(n.rootCauses.length)} علت مستقل پیدا شد که هرکدام به‌تنهایی می‌توانند باعث این وضعیت شوند:`);
            for (const e of n.rootCauses) line(L, findingLine(e));
        } else if (h.kind === 'undetermined') {
            // The distinction the whole report exists to keep: not knowing is not the same as
            // nothing being wrong.
            line(L, '  علت قطعی پیدا نشد.');
            line(L, '  این یعنی شواهد کافی به دست نیامد — نه اینکه مشکلی وجود ندارد.');
        } else if (h.kind === 'no-cause-for-symptom') {
            line(L, '  چند مورد پیدا شد، ولی هیچ‌کدام توضیح نمی‌دهد چرا صفحه‌ها باز نمی‌شوند.');
        } else {
            line(L, '  در بررسی‌هایی که انجام شد مشکلی پیدا نشد.');
        }
    }

    // ── 2 ──
    rule(L, '۲) چرا صفحه‌ها باز نمی‌شوند؟');
    if (n && n.consequences && n.consequences.length) {
        line(L, '  این موارد نتیجهٔ همان علت بالا هستند، نه مشکل‌های جدا:');
        for (const e of n.consequences) line(L, findingLine(e));
    } else {
        line(L, '  —');
    }
    if (n && n.byDesign && n.byDesign.length) {
        line(L, '');
        line(L, '  این تنظیم‌ها را خودِ برنامه عمداً انجام داده و مشکل نیستند:');
        for (const e of n.byDesign) line(L, `  • ${e.title || e.id}`);
    }

    // ── 3 ──
    rule(L, '۳) چه چیزی را واقعاً اندازه گرفتیم؟');
    const measured = Object.values(facts).filter(f => f.status === 'observed' && f.quality === 'measured');
    const reported = Object.values(facts).filter(f => f.status === 'observed' && f.quality === 'reported');
    const inferred = Object.values(facts).filter(f => f.status === 'observed' && f.quality === 'inferred');
    line(L, `  اندازه‌گیری‌شده: ${fa(measured.length)} · گزارش ویندوز: ${fa(reported.length)} · استنتاج‌شده: ${fa(inferred.length)}`);
    line(L, '');
    // Measured first, and separately, because the difference between what we measured and what
    // Windows merely reported is the core signal of this whole symptom.
    for (const f of measured) {
        line(L, `  ${f.id} = ${JSON.stringify(f.value)}${f.note ? `   — ${f.note}` : ''}`);
    }
    if (reported.length) {
        line(L, '');
        line(L, '  ── آنچه ویندوز گزارش می‌کند (اندازه‌گیری ما نیست) ──');
        for (const f of reported) line(L, `  ${f.id} = ${JSON.stringify(f.value)}`);
    }

    // ── 4 ──
    rule(L, '۴) چه چیزی هنوز نامشخص است؟');
    const unknown = Object.values(facts).filter(f => f.status === 'unknown' || f.status === 'error');
    const skipped = (session.collectors || []).filter(c => c.state === 'skipped' && c.skippedReason);
    if (!unknown.length && !skipped.length) {
        line(L, '  همهٔ آزمون‌های برنامه‌ریزی‌شده انجام شد.');
    } else {
        for (const f of unknown) line(L, `  ${f.id} — ${f.errorReason || f.note || 'قابل اندازه‌گیری نبود'}`);
        if (skipped.length) {
            line(L, '');
            line(L, '  آزمون‌هایی که عمداً انجام نشد، و دلیلش:');
            for (const c of skipped) line(L, `  • ${c.label || c.id} — ${c.skippedReason}`);
        }
    }
    if (n && n.unresolved && n.unresolved.length) {
        line(L, '');
        line(L, '  فرضیه‌هایی که به نتیجه نرسیدند:');
        for (const e of n.unresolved) {
            line(L, `  • ${e.title || e.id} — ${e.reason || 'شواهد کافی نبود'}`);
            if (e.missing && e.missing.length) line(L, `      شواهد لازم: ${e.missing.join(', ')}`);
        }
    }

    // ── 5 ──
    rule(L, '۵) چه کاری می‌خواهیم انجام دهیم؟');
    const offers = session.offers || [];
    if (!offers.length) {
        line(L, '  هیچ تعمیری پیشنهاد نشد.');
        if (n && n.headline && n.headline.kind === 'undetermined') {
            line(L, '  دلیلش این است که علت قطعی پیدا نشد — تغییردادن چیزی که مطمئن نیستیم مقصر است، ریسک دارد.');
        }
    } else {
        for (const o of offers) {
            line(L, `  • [${TIER_TEXT[o.tier] || o.tier}] ${o.label}`);
            if (o.hint) line(L, `      ${o.hint}`);
        }
    }

    // ── 6 ──
    rule(L, '۶) چه ریسکی دارد؟');
    const risky = offers.filter(o => o.tierReason);
    if (!risky.length) {
        line(L, offers.length ? '  موارد پیشنهادی برگشت‌پذیر و بی‌خطر هستند.' : '  —');
    } else {
        for (const o of risky) line(L, `  • ${o.label}: ${o.tierReason}`);
    }

    // ── 7 ──
    rule(L, '۷) بعد از تعمیر چه چیزی را دوباره بررسی کردیم؟');
    const vs = session.verifications || [];
    const actions = session.actions || [];
    if (!actions.length) {
        line(L, '  هیچ تعمیری انجام نشد.');
    } else {
        for (const a of actions) {
            line(L, `  • ${a.repairId}: ${a.ok ? 'اعمال شد' : `انجام نشد — ${a.reason || 'دلیل نامعلوم'}`}`);
        }
        for (const v of vs) {
            line(L, '');
            line(L, `  بررسی پس از «${v.repairId}»:`);
            const lv = v.levels || {};
            if (lv.direct) line(L, `    - همان چیزی که تعمیر شد: ${lv.direct.pass === null ? 'قابل بررسی نبود' : (lv.direct.pass ? 'دیگر برقرار نیست' : 'هنوز برقرار است')}`);
            if (lv.functional) {
                line(L, `    - آزمون واقعیِ باز شدن صفحه‌ها: ${lv.functional.pass === null ? 'قابل بررسی نبود'
                    : (lv.functional.pass ? 'موفق' : `ناموفق — ${lv.functional.reason || ''}`)}`);
            }
            if (lv.regression) {
                const r = lv.regression;
                line(L, `    - چیز دیگری خراب شد؟ ${r.pass ? 'نه' : `بله: ${(r.regressions || []).map(x => x.id).join(', ')}`}`);
                if (r.expectedEffects && r.expectedEffects.length) {
                    line(L, `      (این تغییرها اثر خودِ تعمیر بودند، نه خرابی: ${r.expectedEffects.map(x => x.id).join(', ')})`);
                }
                if (r.lostVisibility && r.lostVisibility.length) {
                    line(L, `      (این موارد این بار قابل خواندن نبودند — این با خرابی یکی نیست: ${r.lostVisibility.map(x => x.id).join(', ')})`);
                }
            }
        }
    }

    // ── 8 ──
    rule(L, '۸) آیا مشکل واقعی کاربر حل شد؟');
    if (!vs.length) {
        line(L, actions.length ? '  تأیید نهایی انجام نشد.' : '  —');
    } else {
        const last = vs[vs.length - 1];
        // WORDING.fixed is the ONLY sentence that claims the problem is gone, and it is only
        // reachable when the verification engine returned `fixed`.
        line(L, `  ${V.WORDING[last.outcome] || 'نتیجهٔ تأیید نامشخص است.'}`);
        if (last.outcome === V.OUTCOME.PARTIALLY_FIXED) {
            line(L, '  بررسی دوباره انجام شد تا علت دیگر پیدا شود.');
        }
        if (last.rollbackAdvised) line(L, '  پیشنهاد می‌کنیم این تغییر را برگردانید.');
    }

    // ── appendix ──
    rule(L, 'پیوست: آزمون‌هایی که اجرا شد');
    for (const c of session.collectors || []) {
        line(L, `  ${String(c.state).padEnd(8)} ${c.id}${c.ms ? `  (${fa(c.ms)}ms)` : ''}${c.error ? `  — ${c.error}` : ''}`);
    }

    line(L, '');
    line(L, '  این گزارش فقط روی همین کامپیوتر ساخته شد و به هیچ سروری فرستاده نمی‌شود.');
    line(L, '════════════════════════════════════════════════════════════');
    return L.join('\n');
}

module.exports = { buildReport, VERDICT_TEXT, CAP_TEXT, TIER_TEXT };
