# Security Policy

*[فارسی پایین‌تر](#سیاست-امنیتی)*

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

This is circumvention software. People use it from places where a working bypass is the difference
between reading the news and not, and a published flaw is read by the people who maintain the
block before it is read by the people who need the fix.

Report privately:

| | |
|---|---|
| Telegram | [@mlmvpn](https://t.me/mlmvpn) |
| GitHub | [Private vulnerability report](https://github.com/mlmvpn/mlmvpn_windows/security/advisories/new) |

Please include what you did, what happened, the version, and — if it is a leak — how you observed
it. We will confirm receipt, tell you what we find, and credit you in the release notes unless you
prefer otherwise.

---

## What counts as a vulnerability here

This application's job is to carry traffic and to change operating-system network settings. The
failures that matter most are the ones specific to that:

| | |
|---|---|
| **A leak** | Traffic, or a DNS query, going outside the tunnel when the user believes it is inside |
| **A fail-open** | Any state where the kill switch or the DNS guard stops protecting without saying so |
| **A stranded machine** | The app leaving Windows with no working internet and no way to undo it |
| **An identity leak** | Anything that ties a user to their traffic, including in a log |
| **A supply-chain problem** | The update channel accepting something it should not have |

Ordinary vulnerability classes apply as well, but these are the ones this program is uniquely able
to get wrong.

---

## How the application is built to fail

Knowing these makes a report more useful.

**It records before it changes.** Every machine-wide change — routes, DNS resolvers, the firewall,
the system proxy — is written to disk *before* it is made. This is not for tidiness: an in-process
cleanup cannot run when the process is killed by Task Manager, an antivirus, or a power cut. On the
next start the application reads what is true now and converges, rather than replaying a log.

**The restore journal is privilege-checked.** `restoreIfStale` refuses to honour a journal it
cannot prove is administratively owned, because that file drives privileged action from an
elevated process. An unprivileged write to it must not become an instruction.

**TUN owns DNS when it is up.** The Node DNS bridge and the tunnel cannot both own resolution;
running both kills all traffic the moment the bridge engages. The bridge stands down.

**A tunnel rule with an empty condition matches everything.** A sing-box rule whose `ip_cidr` list
is empty is a passthrough, not a no-op. That mistake once turned the whole V2Ray tunnel into a
direct connection. If you are reviewing routing rules, this is where to look.

**"Connected" means proven.** An engine reports connected only after it has answered, not when its
process started — because a green lamp over a dead tunnel is itself a safety problem.

---

## What is not in this repository, and why

| | |
|---|---|
| **The engine binaries (`core/`)** | Not ours to redistribute, and you should get each from its own project and check it yourself. See [docs/BUILD.md](docs/BUILD.md). |
| **The update channel's signing key** | Ed25519, and the private half lives outside the source tree entirely. A release is signed, and the application verifies the signature before installing. |
| **Any user data or credential** | The repository is scanned before publication. If you find something that looks like a live credential in the history, report it privately — that is exactly the kind of thing this section is for. |

---

## What the application sends

Nothing, by default. No telemetry, no analytics, no crash upload.

Logs and crash reports are written to `%USERPROFILE%\.mlmvpn\` and stay there. Settings shows you
how many there are and opens the folder. **Sending one is a decision the user makes**, and the
application says so rather than doing it quietly. Those files record the machine's own network
state, including addresses that were connected to, which is why they are not uploaded for you.

---

## Supported versions

Security fixes go to the latest release. There is no long-term support branch.

---
---

# سیاست امنیتی

## گزارش یک آسیب‌پذیری

**برای مشکل امنیتی، Issue عمومی باز نکنید.**

این نرم‌افزارِ عبور از سانسور است. آدم‌ها از جاهایی استفاده‌اش می‌کنند که یک دور زدنِ سالم، تفاوت بین
خواندن خبر و نخواندنش است — و یک ایرادِ منتشرشده را کسانی که مسدودسازی را نگه می‌دارند، **زودتر** از
کسانی که به رفعش نیاز دارند می‌خوانند.

خصوصی گزارش دهید:

| | |
|---|---|
| تلگرام | [@mlmvpn](https://t.me/mlmvpn) |
| گیت‌هاب | [گزارش خصوصی آسیب‌پذیری](https://github.com/mlmvpn/mlmvpn_windows/security/advisories/new) |

لطفاً بنویسید چه کردید، چه شد، کدام نسخه، و — اگر نشتی است — چطور مشاهده‌اش کردید. دریافتش را تأیید
می‌کنیم، نتیجه را می‌گوییم، و در یادداشت انتشار از شما نام می‌بریم مگر اینکه نخواهید.

---

## اینجا چه چیزی آسیب‌پذیری حساب می‌شود

کار این برنامه حمل ترافیک و تغییر تنظیمات شبکهٔ سیستم‌عامل است. مهم‌ترین خرابی‌ها همان‌هایی‌اند که
مخصوص همین کارند:

| | |
|---|---|
| **نشتی** | ترافیک یا یک پرس‌وجوی DNS که بیرون تونل می‌رود درحالی‌که کاربر فکر می‌کند داخل است |
| **باز-ماندن در خرابی** | هر وضعیتی که کلید قطع یا نگهبان DNS بدون گفتن، از محافظت دست بکشد |
| **ماشین جامانده** | برنامه ویندوز را بدون اینترنت سالم و بدون راه برگشت رها کند |
| **نشت هویت** | هر چیزی که کاربر را به ترافیکش وصل کند، از جمله در یک لاگ |
| **مشکل زنجیرهٔ تأمین** | کانال به‌روزرسانی چیزی را بپذیرد که نباید |

دسته‌های معمول آسیب‌پذیری هم صدق می‌کنند، ولی این‌ها آن‌هایی‌اند که **فقط** این برنامه می‌تواند
اشتباهشان کند.

---

## برنامه چطور ساخته شده که در خرابی ببندد

دانستن این‌ها گزارش شما را مفیدتر می‌کند.

**قبل از تغییر، ثبت می‌کند.** هر تغییر سراسری ماشین — مسیرها، resolver های DNS، فایروال، پروکسی
سیستم — **قبل** از انجام شدن روی دیسک نوشته می‌شود. این برای نظم نیست: پاک‌سازی درون‌پروسه‌ای وقتی
پروسه توسط تسک‌منیجر، آنتی‌ویروس یا قطع برق کشته می‌شود نمی‌تواند اجرا شود. در شروع بعدی، برنامه
می‌خواند الان چه چیزی درست است و **هم‌گرا** می‌شود، نه اینکه لاگ را بازپخش کند.

**دفترچهٔ بازیابی، بررسی دسترسی می‌شود.** `restoreIfStale` از پذیرفتن دفترچه‌ای که نتواند ثابت کند
مالکیتش اداری است سر باز می‌زند، چون آن فایل، عملِ دارای دسترسی را از یک پروسهٔ بالابرده هدایت
می‌کند. یک نوشتنِ بدون‌دسترسی روی آن نباید به دستور تبدیل شود.

**وقتی TUN بالاست، TUN مالک DNS است.** پل DNS نودی و تونل نمی‌توانند هم‌زمان مالک حل نام باشند؛
اجرای هر دو، همان لحظه‌ای که پل درگیر شود همهٔ ترافیک را می‌کشد. پل کنار می‌کشد.

**قاعدهٔ تونل با شرط خالی، با همه‌چیز مطابقت می‌کند.** قاعده‌ای در sing-box که فهرست `ip_cidr` آن خالی
باشد یک passthrough است، نه بی‌اثر. همین اشتباه یک بار کل تونل V2Ray را به اتصال مستقیم تبدیل کرد.
اگر قواعد مسیریابی را بازبینی می‌کنید، اینجا را نگاه کنید.

**«متصل شد» یعنی اثبات‌شده.** موتور فقط بعد از اینکه جواب داده باشد «متصل» گزارش می‌دهد، نه وقتی
پروسه‌اش شروع شده — چون یک چراغ سبز روی تونل مرده، خودش یک مشکل ایمنی است.

---

## چه چیزی در این مخزن نیست، و چرا

| | |
|---|---|
| **باینری موتورها (`core/`)** | مال ما نیست که بازنشر کنیم، و بهتر است هرکدام را از پروژهٔ خودش بگیرید و خودتان بررسی کنید. [docs/BUILD.fa.md](docs/BUILD.fa.md) |
| **کلید امضای کانال به‌روزرسانی** | Ed25519، و نیمهٔ خصوصی‌اش کاملاً بیرون از درخت سورس زندگی می‌کند. هر انتشار امضا می‌شود و برنامه قبل از نصب، امضا را بررسی می‌کند. |
| **هر داده یا اعتبارنامهٔ کاربر** | مخزن قبل از انتشار اسکن می‌شود. اگر چیزی که شبیه یک اعتبارنامهٔ زنده است در تاریخچه دیدید، **خصوصی** گزارش دهید — این بخش دقیقاً برای همین است. |

---

## برنامه چه چیزی می‌فرستد

به‌صورت پیش‌فرض، **هیچ‌چیز**. نه تله‌متری، نه آنالیتیکس، نه آپلود کرش.

لاگ‌ها و گزارش‌های کرش در `%USERPROFILE%\.mlmvpn\` نوشته می‌شوند و همان‌جا می‌مانند. تنظیمات می‌گوید
چندتا هست و پوشه را باز می‌کند. **فرستادن یکی از آن‌ها تصمیمی است که کاربر می‌گیرد**، و برنامه همین
را می‌گوید به‌جای اینکه بی‌صدا انجامش دهد. آن فایل‌ها وضعیت شبکهٔ خود ماشین را ثبت می‌کنند، از جمله
آدرس‌هایی که به آن‌ها وصل شده — و دقیقاً به همین دلیل برایتان آپلود نمی‌شوند.

---

## نسخه‌های پشتیبانی‌شده

اصلاحات امنیتی به تازه‌ترین انتشار می‌روند. شاخهٔ پشتیبانی بلندمدت وجود ندارد.
