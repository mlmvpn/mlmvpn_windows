// --- GST repair advice ---
// Turns a probe result into something the user can act on. The rule for this feature is
// that no detected fault is ever a dead end: every red lamp carries one Persian sentence
// explaining what happened and one button that does something about it.
//
// This module only *describes* the fix (id, label, payload). Executing it belongs to the
// modules that own the resource — gst-cert installs certificates, gst-deployer-cf
// rebuilds Workers, the wizard rebuilds scripts. Keeping the advice separate means the
// health tab can render a repair button for a subsystem that has not been built yet.

const { RESULT } = require('./gst-test');

// Action ids the panel knows how to dispatch. Anything not in here would render a button
// that does nothing, so the list is the contract between this module and the UI.
const ACTION = {
    REINSTALL_CERT: 'reinstall-cert',
    INSTALL_CERT_BROWSERS: 'install-cert-browsers',
    REBUILD_SCRIPT: 'rebuild-script',
    COPY_SCRIPT: 'copy-script',
    COPY_AUTH_KEY: 'copy-auth-key',
    REDEPLOY_WORKER: 'redeploy-worker',
    OPEN_CLOUD_PANEL: 'open-cloud-panel',
    DISABLE_CF: 'disable-cf',
    OPEN_DEPLOYMENT: 'open-deployment',
    RETRY_REACH: 'retry-reach',
    ADD_RELAY: 'add-relay',
    WAIT_QUOTA: 'wait-quota',
};

/**
 * Advice for a failed Google (Apps Script) leg.
 * @param probe  result object from gst-test
 * @param relay  the relay it belongs to
 * @param reset  getResetInfo() output, for quota wording
 */
function adviseGoogle(probe, relay, reset) {
    const url = relay.deploymentId
        ? `https://script.google.com/macros/s/${relay.deploymentId}/exec`
        : '';

    switch (probe.result) {
        case RESULT.NOT_CONFIGURED:
            return {
                title: 'این ریلی هنوز کامل نشده',
                detail: 'ساخت اسکریپت گوگل برای این ریلی باقی مانده است. ' +
                    'ادامه‌ی ویزارد چند دقیقه بیشتر طول نمی‌کشد.',
                actions: [{ id: ACTION.REBUILD_SCRIPT, label: 'ادامه‌ی ساخت', relayId: relay.id }],
            };

        case RESULT.NOT_FOUND:
            return {
                title: 'شناسه‌ی دیپلویمنت پیدا نشد',
                detail: 'گوگل چنین دیپلویمنتی ندارد. یا شناسه اشتباه کپی شده، یا آن دیپلویمنت ' +
                    'حذف شده است. شناسه با AKfy شروع می‌شود و طولانی است.',
                actions: [
                    { id: ACTION.REBUILD_SCRIPT, label: 'اصلاح شناسه', relayId: relay.id },
                    { id: ACTION.OPEN_DEPLOYMENT, label: 'باز کردن در مرورگر', url },
                ],
            };

        case RESULT.AUTH_MISMATCH:
            return {
                title: 'رمز اسکریپت با برنامه یکی نیست',
                detail: 'مقدار AUTH_KEY داخل اسکریپت گوگل با رمز فعلی برنامه فرق دارد. ' +
                    'اسکریپت اصلاح‌شده را کپی کنید، در ویرایشگر گوگل جای‌گذاری کنید و دوباره Deploy بزنید.',
                actions: [
                    { id: ACTION.COPY_SCRIPT, label: 'کپی اسکریپت اصلاح‌شده', relayId: relay.id },
                    { id: ACTION.COPY_AUTH_KEY, label: 'کپی رمز' },
                ],
            };

        case RESULT.NOT_AUTHORIZED:
            return {
                title: 'اسکریپت هنوز تأیید نشده',
                detail: 'یک بار باید خودتان اسکریپت را در مرورگر اجرا و تأیید کنید: ' +
                    'Review Permissions ← Advanced ← Allow.',
                actions: [
                    { id: ACTION.OPEN_DEPLOYMENT, label: 'باز کردن در مرورگر', url },
                ],
            };

        case RESULT.REDIRECT_BLOCKED:
            return {
                title: 'دسترسی اسکریپت روی «Anyone» تنظیم نشده',
                detail: 'هنگام Deploy باید «Execute as: Me» و «Who has access: Anyone» انتخاب شود. ' +
                    'با تنظیم فعلی، گوگل درخواست را به صفحه‌ی ورود می‌فرستد.',
                actions: [
                    { id: ACTION.REBUILD_SCRIPT, label: 'راهنمای گام‌به‌گام', relayId: relay.id },
                    { id: ACTION.OPEN_DEPLOYMENT, label: 'باز کردن در مرورگر', url },
                ],
            };

        case RESULT.QUOTA:
            return {
                title: 'سهمیه‌ی امروزِ این حساب گوگل تمام شد',
                detail: `چیزی خراب نشده — فقط باید صبر کنید. سهمیه ${reset.google.remaining} دیگر، ` +
                    `ساعت ${reset.google.clock} به وقت ایران برمی‌گردد. ` +
                    'برای اینکه دفعه‌ی بعد زودتر تمام نشود، یک حساب گوگل دیگر اضافه کنید؛ ' +
                    'بار بین همه‌ی حساب‌ها پخش می‌شود.',
                actions: [
                    { id: ACTION.ADD_RELAY, label: '+ افزودن حساب' },
                    { id: ACTION.WAIT_QUOTA, label: 'باشد، صبر می‌کنم' },
                ],
            };

        case RESULT.UNREACHABLE:
            return {
                title: 'به اسکریپت گوگل نمی‌رسیم',
                detail: 'ممکن است اینترنت قطع باشد یا دسترسی به گوگل بسته باشد. ' +
                    'برنامه می‌تواند دوباره راه دسترسی را باز کند.',
                actions: [{ id: ACTION.RETRY_REACH, label: 'تلاش مجدد' }],
            };

        default:
            return {
                title: 'پاسخ اسکریپت گوگل قابل تشخیص نبود',
                detail: (probe.message || '') + ' ساده‌ترین راه، ساخت دوباره‌ی اسکریپت است.',
                actions: [{ id: ACTION.REBUILD_SCRIPT, label: 'ساخت مجدد اسکریپت', relayId: relay.id }],
            };
    }
}

/**
 * Advice for a failed Cloudflare leg.
 * The framing differs from Google on purpose: a dead Worker does NOT take the relay
 * down, because the tunnel falls back to the direct path. Saying so up front stops the
 * user from panicking over a lamp that has no effect on their browsing.
 */
function adviseCloudflare(probe, relay, reset) {
    switch (probe.result) {
        case RESULT.QUOTA:
            return {
                title: 'سهمیه‌ی روزانه‌ی Worker تمام شد',
                detail: `تونل شما قطع نمی‌شود — این ریلی روی مسیر مستقیم کار می‌کند، فقط کمی کندتر. ` +
                    `سهمیه ${reset.cloudflare.remaining} دیگر، ساعت ${reset.cloudflare.clock} برمی‌گردد.`,
                actions: [
                    { id: ACTION.DISABLE_CF, label: 'فعلاً خاموش کن', relayId: relay.id },
                ],
            };

        case RESULT.AUTH_MISMATCH:
            return {
                title: 'رمز Worker با اسکریپت گوگل یکی نیست',
                detail: 'آدرس یا رمز Worker داخل اسکریپت گوگل با چیزی که برنامه ساخته فرق دارد. ' +
                    'ساده‌ترین راه، ساخت دوباره‌ی Worker و به‌روزرسانی همان یک خط در اسکریپت است.',
                actions: [
                    { id: ACTION.REDEPLOY_WORKER, label: 'ساخت مجدد Worker', relayId: relay.id },
                ],
            };

        case RESULT.UNREACHABLE:
            return {
                title: 'Worker در دسترس نیست',
                detail: 'احتمالاً از داشبورد کلادفلر حذف شده است. تونل روی مسیر مستقیم ادامه می‌دهد.',
                actions: [
                    { id: ACTION.REDEPLOY_WORKER, label: 'ساخت مجدد Worker', relayId: relay.id },
                    { id: ACTION.DISABLE_CF, label: 'خاموش کردن کلادفلر این ریلی', relayId: relay.id },
                ],
            };

        default:
            return {
                title: 'Worker پاسخ درستی نداد',
                detail: (probe.message || '') +
                    ' نگران نباشید: این ریلی روی مسیر مستقیم کار می‌کند.',
                actions: [
                    { id: ACTION.REDEPLOY_WORKER, label: 'ساخت مجدد Worker', relayId: relay.id },
                    { id: ACTION.DISABLE_CF, label: 'فعلاً خاموش کن', relayId: relay.id },
                ],
            };
    }
}

/** Advice for the certificate check. */
function adviseCertificate(certState) {
    if (certState.trusted) return null;
    if (certState.exists) {
        return {
            title: 'گواهی ساخته شده ولی ویندوز به آن اعتماد ندارد',
            detail: 'بدون گواهیِ مورد اعتماد، سایت‌های https باز نمی‌شوند. نصب مجدد یک کلیک است.',
            actions: [{ id: ACTION.REINSTALL_CERT, label: 'نصب مجدد' }],
        };
    }
    return {
        title: 'گواهی امنیتی نصب نیست',
        detail: 'تونل برای باز کردن سایت‌های https به یک گواهی محلی نیاز دارد.',
        actions: [{ id: ACTION.REINSTALL_CERT, label: 'نصب گواهی' }],
    };
}

/**
 * One-line verdict for a whole relay, from its two legs. This is the sentence the relay
 * list shows, and the four-way split is the heart of the "which leg is broken?" promise.
 */
function summarize(relay, google, cf) {
    // "Not finished yet" is its own state. It is not a fault, and colouring it red the
    // way a broken relay is coloured makes a fresh install look like it is failing.
    if (google && google.result === RESULT.NOT_CONFIGURED) {
        return { state: 'incomplete', text: 'ناتمام — اسکریپت گوگل ساخته نشده' };
    }

    const gOk = google && (google.state === 'ok' || google.state === 'slow');
    const cfUsed = !!relay.cfEnabled;
    const cfOk = !cfUsed || (cf && (cf.state === 'ok' || cf.state === 'slow'));

    if (gOk && cfOk) {
        return { state: 'ok', text: cfUsed ? 'سالم — گوگل و کلادفلر هر دو کار می‌کنند' : 'سالم' };
    }
    if (gOk && !cfOk) {
        // The important reassurance: a dead Worker is a degradation, not an outage.
        return {
            state: 'degraded',
            text: 'کلادفلر خراب است ولی این ریلی روی مسیر مستقیم کار می‌کند',
        };
    }
    if (!gOk && cfOk) {
        return {
            state: 'error',
            text: cfUsed
                ? 'اسکریپت گوگل خراب است — سالم بودن کلادفلر فایده‌ای ندارد'
                : 'اسکریپت گوگل خراب است',
        };
    }
    if (google && google.state === 'quota') {
        return { state: 'quota', text: 'سهمیه‌ی گوگل تمام شده — موقتی است' };
    }
    return { state: 'error', text: 'هر دو پای این ریلی خراب است' };
}

module.exports = { ACTION, adviseGoogle, adviseCloudflare, adviseCertificate, summarize };
