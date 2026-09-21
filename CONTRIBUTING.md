# Contributing to MLMVPN for Windows

*[فارسی پایین‌تر](#مشارکت-در-mlmvpn-برای-ویندوز)*

Thank you for wanting to help. Read [docs/BUILD.md](docs/BUILD.md) to get it running and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) to understand the shape of it. This file is the part
that is not visible from the code: how we decide what to change.

---

## The four house rules

These are not style preferences. Each one is here because breaking it produced a real bug that
reached real users.

### 1. Fix it for the people who are stuck, not for everyone

When a handful of users report a problem, the tempting fix is to change the default for everybody.
Don't. Add a lever those users can pull, and surface it from the error they are actually seeing.

The application once decided *by itself* to disable graphics acceleration after two launches that
"failed". It shipped, and it fired on healthy machines, because the signal it was reading never
arrived at all. A million working installations were changed to solve a problem a few hundred had.

If your change alters behaviour for users who are not affected, say so in the PR and explain why
there is no narrower option.

### 2. Measure it — do not reason about it

Almost every wrong turn in this project's history was a plausible theory nobody tested. Two that
survived for a long time:

- Pinning Tor exit nodes "should" be faster. Measured, it is **2.5× slower**.
- The biggest latency lever for gaming "should" be the route. Measured, it is **upload
  bufferbloat**: 126 ms → 2681 ms with 29% loss on a real line.

If you claim something is faster, fixed, or better, put the numbers in the pull request — before
and after, on a described line. A/B it rather than reverting from memory.

### 3. Never leave a failure silent

A `catch` that shows the user nothing is how a bug survives for six months. This is not
hypothetical either: every renderer `require('electron')` in `public/` is wrapped in a try/catch
that treats a throw as "we must be in a browser". When Electron's `contextIsolation` default
changed, three features died at once and nothing said a word.

If you swallow an error, the comment next to it must say what the user sees instead and why that
is acceptable.

### 4. Nothing synchronous on a startup or click path

`server.js` runs in Electron's main process. One `execFileSync` there froze the window *and* the
HTTP server the page loads from, for 2167 ms, and was reported as "the app hangs my PC". Sync
variants exist only for `before-quit` and bail-out paths, and are named `…Sync` so the difference
is visible where they are called.

---

## Before you open a pull request

```bash
npm test                # all suites
npm run test:aether     # includes the packaging allow-list check
```

- **If you added a top-level module, add it to `build.files` in `package.json`, in the same
  commit.** It is an allow-list: a module that is not listed is not packaged, and the app crashes
  on `require` at runtime while working perfectly from source. `tests/aether/packaging.test.js`
  catches this — do not dismiss it.
- **If you touched anything user-facing, add a changelog entry.** Prepend an object to
  `CHANGELOG` in `public/components/changelog.js`. The newest entry drives the version number
  shown in the UI, so the entry is not optional decoration.
- **Match the surrounding code.** Comment density, naming and idiom vary by file on purpose —
  the engine managers are dense with hard-won detail, the UI components are lighter.
- **Write comments that say *why*.** This codebase's comments record the measurement or the bug
  behind a decision. A comment restating the code is noise; a comment saying "this must stay
  explicit because Electron's default changed and broke three features silently" is the reason
  the next person does not undo it.

---

## Some things that will catch you

| | |
|---|---|
| **Panel `<style>` blocks are global** | Each panel injects unscoped CSS, so a selector written for one reaches all of them. Prefix yours. |
| **`public/*.js` share one global scope** | They are plain scripts, not modules. A bare top-level `const` collides across files. |
| **Network settings have one owner** | `network-settings.js`. Engines read from it and keep no copies — two engines with two ideas of the DNS server is a machine with no internet. |
| **Do not run `node server.js` to look at the UI** | Its startup recovery touches the firewall and DNS, and will tear down a live session. Use `node .claude/ui-preview.js --api`. |
| **`node --check` does not catch a deleted function** | An undefined call only fails at runtime. If you restructure `main.js`, run it. |

---

## Reporting a bug

Open an issue at
[github.com/mlmvpn/mlmvpn_windows/issues](https://github.com/mlmvpn/mlmvpn_windows/issues) and
include:

- version, Windows version, and 32- or 64-bit — the first line of `startup.log` has all three;
- `%USERPROFILE%\.mlmvpn\startup.log`;
- what you expected and what happened instead.

Please look at a log before you attach it: these files record your own machine, including the
addresses you connected to.

---

## Licence of contributions

By contributing you agree that your contribution is licensed under the
[MLMVPN Attribution Licence](LICENSE), the same terms as the rest of the project.

---
---

# مشارکت در MLMVPN برای ویندوز

ممنون که می‌خواهید کمک کنید. برای راه‌اندازی [docs/BUILD.fa.md](docs/BUILD.fa.md) و برای درک شکل
پروژه [docs/ARCHITECTURE.fa.md](docs/ARCHITECTURE.fa.md) را بخوانید. این فایل همان بخشی است که از
روی کد پیدا نیست: اینکه **چطور تصمیم می‌گیریم چه چیزی را عوض کنیم**.

---

## چهار قاعدهٔ خانه

این‌ها سلیقهٔ سبک نیستند. هرکدام به این دلیل اینجاست که شکستنش یک باگ واقعی ساخت که به کاربر واقعی
رسید.

### ۱. برای آن‌هایی که گیر کرده‌اند درست کنید، نه برای همه

وقتی چند کاربر مشکلی گزارش می‌کنند، وسوسه این است که پیش‌فرض را برای همه عوض کنید. این کار را
نکنید. اهرمی بگذارید که همان کاربرها بکشندش، و از دل همان خطایی که می‌بینند نشانش دهید.

این برنامه یک بار **خودش** تصمیم گرفت بعد از دو اجرای «ناموفق» شتاب گرافیکی را خاموش کند. منتشر
شد، و روی ماشین‌های سالم شلیک کرد — چون سیگنالی که می‌خواند اصلاً نمی‌رسید. یک میلیون نصب سالم عوض
شدند تا مشکل چند صد نفر حل شود.

اگر تغییر شما رفتار کاربران غیرمتأثر را هم عوض می‌کند، در PR بگویید و توضیح دهید چرا گزینهٔ باریک‌تری
وجود ندارد.

### ۲. بسنجید — دربارهٔ آن استدلال نکنید

تقریباً هر اشتباه در تاریخ این پروژه، نظریه‌ای منطقی بود که کسی آزمایشش نکرده بود. دو نمونه که مدت
درازی زنده ماندند:

- سنجاق کردن گره خروجی Tor «باید» سریع‌تر باشد. سنجیده: **۲.۵ برابر کندتر** است.
- بزرگ‌ترین اهرم تأخیر برای بازی «باید» مسیر باشد. سنجیده: **bufferbloat آپلود** است —
  ۱۲۶ به ۲۶۸۱ میلی‌ثانیه با ۲۹٪ اتلاف، روی یک خط واقعی.

اگر ادعا می‌کنید چیزی سریع‌تر، درست‌شده یا بهتر است، **عددش را در Pull Request بگذارید** — قبل و
بعد، روی خطی که توصیفش کرده‌اید. A/B کنید، نه اینکه از حافظه برگردانید.

### ۳. هیچ خرابی‌ای را بی‌صدا نگذارید

یک `catch` که چیزی به کاربر نشان نمی‌دهد، همان چیزی است که یک باگ را شش ماه زنده نگه می‌دارد. این
هم فرضی نیست: هر `require('electron')` در `public/` داخل یک try/catch است که خطا را «پس حتماً
داخل مرورگریم» تفسیر می‌کند. وقتی پیش‌فرض `contextIsolation` الکترون عوض شد، **سه امکان هم‌زمان
مردند و هیچ‌کس حرفی نزد**.

اگر خطایی را می‌بلعید، کامنت کنارش باید بگوید کاربر به‌جایش چه می‌بیند و چرا آن قابل قبول است.

### ۴. هیچ چیز همگامی روی مسیر راه‌اندازی یا کلیک

`server.js` داخل پروسهٔ اصلی الکترون اجرا می‌شود. یک `execFileSync` آنجا هم پنجره را یخ زد **و هم**
همان سرور HTTP‌ای را که صفحه از آن بار می‌شود، به مدت ۲۱۶۷ میلی‌ثانیه، و به‌صورت «برنامه سیستمم را
هنگ می‌کند» گزارش شد. نسخه‌های همگام فقط برای `before-quit` و مسیرهای اضطراری وجود دارند و اسمشان
`…Sync` است تا تفاوت **سر محل فراخوانی** دیده شود.

---

## قبل از باز کردن Pull Request

```bash
npm test                # همهٔ مجموعه‌ها
npm run test:aether     # شامل بررسی فهرست مجاز بسته‌بندی
```

- **اگر ماژولی در سطح بالا اضافه کردید، در همان کامیت به `build.files` در `package.json` هم
  اضافه‌اش کنید.** آن یک فهرست مجاز است: ماژولی که در آن نباشد بسته‌بندی نمی‌شود و برنامه هنگام
  `require` در زمان اجرا کرش می‌کند، درحالی‌که از روی سورس بی‌عیب کار می‌کند.
  `tests/aether/packaging.test.js` این را می‌گیرد — نادیده‌اش نگیرید.
- **اگر چیزی که کاربر می‌بیند را دست زدید، ورودی changelog اضافه کنید.** یک شیء به ابتدای
  `CHANGELOG` در `public/components/changelog.js` اضافه کنید. تازه‌ترین ورودی، **شمارهٔ نسخه‌ای که
  در رابط کاربری نشان داده می‌شود** را تعیین می‌کند، پس تزئین اختیاری نیست.
- **هم‌رنگ کد اطرافتان بنویسید.** تراکم کامنت، نام‌گذاری و اصطلاح عمداً بین فایل‌ها فرق دارد.
- **کامنتی بنویسید که **چرا** را بگوید.** کامنت‌های این کدبیس، سنجش یا باگ پشت یک تصمیم را ثبت
  می‌کنند. کامنتی که کد را دوباره می‌گوید نویز است؛ کامنتی که می‌گوید «این باید صریح بماند چون
  پیش‌فرض الکترون عوض شد و سه امکان را بی‌صدا شکست» همان دلیلی است که نفر بعدی برش نمی‌گرداند.

---

## چند چیزی که گیرتان می‌اندازد

| | |
|---|---|
| **بلوک‌های `<style>` پنل‌ها سراسری‌اند** | هر پنل CSS بدون محدوده تزریق می‌کند، پس سلکتوری که برای یکی نوشته شده به همه می‌رسد. پیشوند بدهید. |
| **فایل‌های `public/*.js` یک دامنهٔ سراسری مشترک دارند** | اسکریپت ساده‌اند نه ماژول. یک `const` لخت در سطح بالا تصادم می‌کند. |
| **تنظیمات شبکه یک مالک دارد** | `network-settings.js`. موتورها از آن می‌خوانند و نسخهٔ خودشان را نگه نمی‌دارند — دو موتور با دو تصور از DNS یعنی ماشینی بدون اینترنت. |
| **برای دیدن رابط کاربری `node server.js` را اجرا نکنید** | بازیابی راه‌اندازی‌اش به فایروال و DNS دست می‌زند و نشست زنده را برمی‌دارد. از `node .claude/ui-preview.js --api` استفاده کنید. |
| **`node --check` تابع حذف‌شده را نمی‌گیرد** | فراخوانی تعریف‌نشده فقط در زمان اجرا شکست می‌خورد. اگر `main.js` را بازساختاری کردید، اجرایش کنید. |

---

## گزارش باگ

Issue را در
[github.com/mlmvpn/mlmvpn_windows/issues](https://github.com/mlmvpn/mlmvpn_windows/issues)
باز کنید و این‌ها را بگذارید:

- نسخه، نسخهٔ ویندوز، و ۳۲ یا ۶۴ بیت — خط اول `startup.log` هر سه را دارد؛
- فایل `%USERPROFILE%\.mlmvpn\startup.log`؛
- چه انتظاری داشتید و به‌جایش چه شد.

**قبل از پیوست کردن لاگ نگاهش کنید:** این فایل‌ها ماشین خودتان را ثبت می‌کنند، از جمله آدرس‌هایی که
به آن‌ها وصل شده‌اید.

---

## پروانهٔ مشارکت‌ها

با مشارکت، می‌پذیرید که مشارکت شما زیر [پروانهٔ انتساب MLMVPN](LICENSE) قرار می‌گیرد — همان شرایطی
که بقیهٔ پروژه دارد.
