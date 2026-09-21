/*
 * The report — a pure function of the session, and the last place the wording contract can be
 * broken.
 *
 * A report is the artefact that outlives the session: it gets pasted into a support chat, read
 * by someone who was not there, and acted on. So it has two jobs, and the second is the harder
 * one:
 *
 *   say what was found — and say it at exactly the strength the evidence supports
 *   say what was NOT found — because a report that only lists conclusions is indistinguishable
 *   from a guess, while one that names the fourteen things it measured and the four it could not
 *   can be argued with
 *
 * The two sentences that must be impossible are the same two as in the panel: «حل شد» for
 * anything the verification engine did not call `fixed`, and «مشکلی پیدا نشد» when the truth is
 * that the evidence did not reach.
 */
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const F = require(ROOT + '/netdiag/facts');
const S = require(ROOT + '/netdiag/session');
const D = require(ROOT + '/netdiag/diagnose');
const V = require(ROOT + '/netdiag/verify');
const R = require(ROOT + '/netdiag/report');
const rules = require(ROOT + '/netdiag/rules');
const { IDS } = require(ROOT + '/netdiag/rules/ids');
const { OWNERSHIP } = require(ROOT + '/netdiag/ownership');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

function sessionWith(spec, extra) {
    const s = S.createSession({ mode: 'full' });
    s.finishedAtMono = S.monoNow();
    for (const [id, v] of Object.entries(spec)) {
        if (v && v.__unknown) S.putFact(s, F.unknown(id, v.reason));
        else S.putFact(s, F.observed(id, v, { quality: (v && v.__q) || F.QUALITY.MEASURED }));
    }
    Object.assign(s, extra || {});
    return s;
}
const unk = reason => ({ __unknown: true, reason });

const HEALTHY = {
    [IDS.REACH_GATEWAY_V4]: 'ok', [IDS.REACH_DOMESTIC_V4]: 'ok', [IDS.REACH_FOREIGN_V4]: 'ok',
    [IDS.SVC_BFE_RUNNING]: true, [IDS.SVC_DNSCACHE_RUNNING]: true, [IDS.FW_OUTBOUND_BLOCK]: false,
    [IDS.TIME_SKEW_SECONDS]: 1, [IDS.LINK_FLAPPING]: false, [IDS.CAPTIVE_DETECTED]: false,
    [IDS.WINSOCK_THIRDPARTY_COUNT]: 0, [IDS.DNS_HOSTS_ENTRIES]: 0,
    [IDS.DNS_RESOLVE_OK_V4]: true, [IDS.DNS_RESOLVER_UDP53_OK]: true, [IDS.DNS_RESOLVER_TCP53_OK]: true,
    [IDS.DNS_CONFIG_LOOPBACK]: false, [IDS.DNS_ANSWER_FORGED]: false,
    [IDS.DNS_ANSWER_NAMES_TESTED]: 5, [IDS.DNS_ANSWER_NAMES_FAILED]: 0,
    [IDS.PROXY_WININET_ENABLED]: false, [IDS.PROXY_HTTP_BYPASS_OK]: true, [IDS.PROXY_HTTP_VIA_OK]: true,
    [IDS.PROXY_WINHTTP_MODE]: 'direct', [IDS.PROXY_PAC_URL]: null, [IDS.PROXY_PAC_FETCHABLE]: true,
    [IDS.PROXY_ENDPOINT_OWNERSHIP]: OWNERSHIP.FOREIGN, [IDS.PROXY_ENDPOINT_TCP_OK]: true,
    [IDS.DNS_CONFIG_OWNERSHIP]: OWNERSHIP.FOREIGN, [IDS.APP_GUARD_STATE]: OWNERSHIP.FOREIGN,
    [IDS.APP_TUN_CARRIES_DATA]: false, [IDS.APP_ENGINE_RUNNING]: false,
    [IDS.APP_TUN_VERDICT]: 'process-dead', [IDS.ROUTE_TABLE_READABLE]: true,
    [IDS.ROUTE_EGRESS_IS_TUN]: false, [IDS.TLS_TCP_OK]: true, [IDS.TLS_HANDSHAKE_OK]: true,
    [IDS.TLS_FAIL_HOSTS]: 0, [IDS.TLS_FAIL_CATEGORIES]: 0, [IDS.TLS_CERT_DATE_INVALID]: false,
};

const build = (s) => R.buildReport(s, D.diagnose(s.facts, rules));

// ── the eight sections, in order ─────────────────────────────────────────────────────────

const HEADINGS = [
    '۱) چه اتفاقی افتاده؟',
    '۲) چرا صفحه‌ها باز نمی‌شوند؟',
    '۳) چه چیزی را واقعاً اندازه گرفتیم؟',
    '۴) چه چیزی هنوز نامشخص است؟',
    '۵) چه کاری می‌خواهیم انجام دهیم؟',
    '۶) چه ریسکی دارد؟',
    '۷) بعد از تعمیر چه چیزی را دوباره بررسی کردیم؟',
    '۸) آیا مشکل واقعی کاربر حل شد؟',
];

let text = build(sessionWith(HEALTHY));
t('all eight headings are present', HEADINGS.every(h => text.includes(h)),
    HEADINGS.filter(h => !text.includes(h)).join(' | '));
t('...and in order',
    HEADINGS.map(h => text.indexOf(h)).every((v, i, a) => i === 0 || v > a[i - 1]));
t('the report says it never leaves the machine', /به هیچ سروری فرستاده نمی‌شود/.test(text));
t('the session id is included so a pasted report can be matched to a run',
    text.includes(sessionWith(HEALTHY).sessionId.slice(0, 4)) || /شناسهٔ بررسی/.test(text));

// ── the wording contract ────────────────────────────────────────────────────────────────

const DEAD_PROXY = Object.assign({}, HEALTHY, {
    [IDS.PROXY_WININET_ENABLED]: true,
    [IDS.PROXY_WININET_SERVER]: 'http=127.0.0.1:10809;https=127.0.0.1:10809',
    [IDS.PROXY_ENDPOINT_TCP_OK]: false,
    [IDS.PROXY_HTTP_VIA_OK]: false,
});
text = build(sessionWith(DEAD_PROXY));
t('a confirmed root cause is stated as «علت پیدا شد»', /\[علت پیدا شد\]/.test(text), text.slice(0, 400));

const UNDETERMINED = {
    [IDS.ROUTE_TABLE_READABLE]: false,
    [IDS.REACH_GATEWAY_V4]: unk('جدول مسیرها خوانده نشد'),
    [IDS.REACH_DOMESTIC_V4]: unk('هیچ مقصد داخلی تعریف نشده'),
    [IDS.REACH_FOREIGN_V4]: unk('مسیری برای آزمون نبود'),
    [IDS.PROXY_HTTP_BYPASS_OK]: false,
};
text = build(sessionWith(UNDETERMINED));
t('an undetermined result says «علت قطعی پیدا نشد»', /علت قطعی پیدا نشد/.test(text));
t('...and explains that this is not the same as nothing being wrong',
    /نه اینکه مشکلی وجود ندارد/.test(text), text.slice(text.indexOf('۱)'), text.indexOf('۱)') + 300));
t('...and never says «مشکلی پیدا نشد»', !/مشکلی پیدا نشد/.test(text));

text = build(sessionWith(HEALTHY));
t('a genuinely clean machine says «مشکلی پیدا نشد» — a different sentence',
    /مشکلی پیدا نشد/.test(text) && !/علت قطعی پیدا نشد/.test(text));

// ── section 3 separates measured from reported ──────────────────────────────────────────

const s3 = sessionWith({});
S.putFact(s3, F.observed(IDS.REACH_GATEWAY_V4, 'ok', { quality: F.QUALITY.MEASURED }));
S.putFact(s3, F.observed(IDS.SVC_BFE_RUNNING, true, { quality: F.QUALITY.REPORTED }));
S.putFact(s3, F.observed(IDS.ROUTE_EGRESS_IS_TUN, false, { quality: F.QUALITY.INFERRED }));
text = R.buildReport(s3, D.diagnose(s3.facts, rules));
t('measured facts are listed', text.includes(IDS.REACH_GATEWAY_V4));
t('what Windows merely REPORTS is listed separately and labelled as such',
    /آنچه ویندوز گزارش می‌کند/.test(text) && text.indexOf(IDS.SVC_BFE_RUNNING) > text.indexOf('آنچه ویندوز گزارش می‌کند'),
    text.slice(text.indexOf('۳)'), text.indexOf('۴)')));
t('the three qualities are counted, so a reader can see how much was really measured',
    /اندازه‌گیری‌شده: .* · گزارش ویندوز: .* · استنتاج‌شده:/.test(text));

// ── section 4 names what was not measured ───────────────────────────────────────────────

const s4 = sessionWith({
    [IDS.REACH_GATEWAY_V4]: 'ok',
    [IDS.FW_OUTBOUND_BLOCK]: unk('Get-NetFirewallProfile denied by policy'),
}, {
    collectors: [
        { id: 'w5.mtu', label: 'بررسی اندازهٔ بستهٔ شبکه', state: 'skipped', ms: 0, error: null, skippedReason: 'ترافیک از تونل عبور می‌کند' },
        { id: 'w0.inventory', label: 'inventory', state: 'ok', ms: 120, error: null, skippedReason: null },
    ],
});
text = R.buildReport(s4, D.diagnose(s4.facts, rules));
t('an unknown fact is named together with WHY it could not be read',
    text.includes(IDS.FW_OUTBOUND_BLOCK) && /denied by policy/.test(text));
t('a deliberately skipped test is named together with its reason',
    /عمداً انجام نشد/.test(text) && /ترافیک از تونل عبور می‌کند/.test(text));
t('the appendix lists every collector and its state',
    /پیوست: آزمون‌هایی که اجرا شد/.test(text) && /w0\.inventory/.test(text));

// ── sections 5 and 6 come from the offers ───────────────────────────────────────────────

const s56 = sessionWith(DEAD_PROXY, {
    offers: [{
        repairId: 'proxy.wininet.disable', label: 'خاموش کردن پراکسی سیستم',
        hint: 'کلید ProxyEnable را صفر می‌کند.', tier: 'confirm',
        tierReason: 'تا وقتی این تغییر برقرار است، ترافیک شما ممکن است بدون تونل خارج شود',
    }],
});
text = R.buildReport(s56, D.diagnose(s56.facts, rules));
t('an offered repair appears with its tier in Persian', /\[نیازمند تأیید\] خاموش کردن پراکسی سیستم/.test(text));
t('its risk is spelled out in section 6', /ترافیک شما ممکن است بدون تونل خارج شود/.test(text));

const s5none = sessionWith(UNDETERMINED, { offers: [] });
text = R.buildReport(s5none, D.diagnose(s5none.facts, rules));
t('with no cause established, the report explains WHY no repair is offered',
    /هیچ تعمیری پیشنهاد نشد/.test(text) && /تغییردادن چیزی که مطمئن نیستیم/.test(text));

// ── sections 7 and 8 come from the verification engine, never from the apply result ─────

function withVerification(outcome, over) {
    return sessionWith(DEAD_PROXY, {
        offers: [],
        actions: [{ repairId: 'proxy.wininet.disable', ok: true, outcome: 'applied' }],
        verifications: [Object.assign({
            repairId: 'proxy.wininet.disable',
            outcome,
            levels: {
                direct: { level: 'direct', pass: true },
                functional: { level: 'functional', pass: outcome === 'fixed', reason: 'only 1 of 4 targets pass' },
                regression: { level: 'regression', pass: outcome !== 'regressed', regressions: outcome === 'regressed' ? [{ id: 'reach.foreign.status.v4' }] : [], expectedEffects: [{ id: 'proxy.wininet.enabled' }], lostVisibility: [] },
            },
        }, over || {})],
    });
}

text = R.buildReport(withVerification('fixed'), null);
t('a verified fix is the ONLY case that says the problem was resolved',
    /برطرف شد/.test(text), text.slice(text.indexOf('۸)')));

text = R.buildReport(withVerification('unverifiable'), null);
t('an unverifiable outcome says «نتوانستیم تأیید کنیم» and never «برطرف شد»',
    /نتوانستیم تأیید کنیم/.test(text) && !/برطرف شد/.test(text), text.slice(text.indexOf('۸)')));

text = R.buildReport(withVerification('partially-fixed'), null);
t('partially-fixed tells the user another cause exists',
    /علت دیگری/.test(text) && !/برطرف شد/.test(text));
t('...and says the engine re-diagnosed', /بررسی دوباره انجام شد/.test(text));

text = R.buildReport(withVerification('regressed', { rollbackAdvised: true, rolledBack: true }), null);
t('a regression is reported, with the rollback advice', /پیشنهاد می‌کنیم این تغییر را برگردانید/.test(text));
t('...and the regressed fact is named', /reach\.foreign\.status\.v4/.test(text));
t('an EXPECTED change is labelled as the repair\'s own effect, not as breakage',
    /اثر خودِ تعمیر بودند، نه خرابی/.test(text));

text = R.buildReport(withVerification('fixed', {
    levels: {
        direct: { level: 'direct', pass: true },
        functional: { level: 'functional', pass: true },
        regression: { level: 'regression', pass: true, regressions: [], expectedEffects: [], lostVisibility: [{ id: 'winsock.thirdparty.count', from: 0, to: 'unknown' }] },
    },
}), null);
t('lost visibility is distinguished from breakage in words the user can act on',
    /قابل خواندن نبودند — این با خرابی یکی نیست/.test(text));

// ── purity and structure ────────────────────────────────────────────────────────────────

const src = require('fs').readFileSync(ROOT + '/netdiag/report.js', 'utf8');
t('report.js performs no I/O — it is a pure function of the session',
    !/require\(['"](child_process|fs|net|dns|http|https|tls)['"]\)/.test(src));
// ONE session, rendered twice. An earlier version built two separate sessions and stripped
// their ids, which left `startedAtWall` differing by a millisecond — so the test passed or
// failed depending on how fast the machine was. The property being claimed is that the same
// session reproduces the same document, and that is what is now measured.
const stable = sessionWith(DEAD_PROXY);
t('the same session produces the same text twice (a saved file reproduces the document)',
    build(stable) === build(stable));
t('the only sentence that claims a fix comes from verify.WORDING',
    Object.entries(V.WORDING).filter(([, s]) => /برطرف شد/.test(s)).map(([k]) => k).join() === 'fixed');
t('an unfinished session is reported as unfinished rather than as a clean bill of health',
    (() => {
        const s = sessionWith(HEALTHY);
        s.finishedAtMono = null;
        return /بررسی هنوز کامل نشده/.test(R.buildReport(s, null));
    })());
t('a cancelled run says so, so a partial result is not read as a complete one',
    /نیمه‌کاره متوقف شد/.test(R.buildReport(sessionWith(HEALTHY, { cancelled: true }), null)));
t('a machine that changed mid-run is flagged at the top of the report',
    /وضعیت شبکه در حین بررسی تغییر کرد/.test(
        R.buildReport(sessionWith(HEALTHY, { generation: { current: 1, unstable: true, samples: [] } }), null)));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
