# ساخت `core/geph/geph5-client.exe`

هستهٔ «گف» از سورس رسمی [geph-official/geph5](https://github.com/geph-official/geph5) بیلد می‌شود
(مجوز MPL-2.0). چیزی patch نشده — برخلاف لنترن، اینجا به تغییر سورس نیاز نبود.

## چرا از سورس

- در GitHub Releases هیچ فایل باینری‌ای منتشر نمی‌شود؛ فقط تگ.
- نصب‌کنندهٔ رسمی ویندوز (`dl.geph.io/.../geph-windows-setup.exe`, ۱۲ مگابایت، Inno Setup، از
  Gephyra OÜ) برنامهٔ گرافیکی خودشان را نصب می‌کند. ما دیمِن می‌خواهیم نه رابط گرافیکی.
- `geph5-client` دقیقاً همان چیزی است که لازم داریم: یک پروسه، یک فایل کانفیگ، و پورت‌های
  SOCKS5/HTTP + یک RPC کنترلی.

## دستور بیلد

مسیرها از [[rust-build-toolchain]] — Rust روی `I:` است و NASM روی PATH نیست:

```powershell
$env:CARGO_HOME="I:\cargo"; $env:RUSTUP_HOME="I:\rustup"
$env:Path="I:\cargo\bin;C:\Program Files\CMake\bin;C:\Program Files\NASM;$env:Path"
$env:LIBCLANG_PATH="C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\Llvm\x64\bin"
git clone --depth 1 https://github.com/geph-official/geph5.git I:\toolchains\geph5-src
cd I:\toolchains\geph5-src
cargo build --release -p geph5-client
Copy-Item target\release\geph5-client.exe "G:\ip scanner\core\geph\geph5-client.exe" -Force
```

اندازه‌گیری ۱۴۰۵/۰۶/۲۲: ۳۸۸ کرِیت، **۱۰ دقیقه و ۳۱ ثانیه**، خروجی **۱۲.۳ مگابایت**. نسخهٔ
`geph5-client` در آن کامیت ۰.۳.۱۰ بود.

> **نکتهٔ شبکه:** بدون تحریم‌شکن، `index.crates.io` از این خط مسموم است. آن روز باز بود
> (`index.crates.io` در ۱.۸ ثانیه، `static.crates.io` در ۵.۸ ثانیه) ولی همیشه نیست — قبل از بیلد
> امتحان کن، نه وسطش.

## قرارداد با برنامه — `geph-manager.js`

### کانفیگ

دیمِن با `--config <file>` اجرا می‌شود و فایل را با `serde_yaml` می‌خواند. **ما JSON می‌نویسیم**،
چون JSON زیرمجموعهٔ YAML است و این‌طور هیچ‌چیزی دربارهٔ کوتیشن و تورفتگی نمی‌تواند خراب شود.

ساختار `Config` با `#[serde(deny_unknown_fields)]` تعریف شده: **یک کلید اضافه یعنی خطای شروع**، نه
یک فیلد نادیده‌گرفته‌شده. فیلدهای مجاز در `libraries/geph5-misc-rpc/src/client_config.rs`.

دو تلهٔ واقعی که در عمل خوردیم:

| فیلد | تله |
|---|---|
| `cache` | **مسیر یک فایل است، نه پوشه.** مستقیم به SQLite داده می‌شود. با پوشه: `unable to open database file (code: 526)` و پروسه یک ثانیه بعد از شروع می‌میرد. مثل خودِ upstream با اعتبارنامه کلیددهی می‌شود، وگرنه دو حساب یک `auth_token` را به اشتراک می‌گذارند. |
| `broker` | مقدارش از `binaries/geph5-app/default-config.yaml` عیناً کپی شده. چهار مسیر **دامین‌فرانتینگ** که هم‌زمان مسابقه می‌دهند. اگر روزی شبکه جواب نداد، اول این بلوک را با upstream مقایسه کن. |

### RPC کنترلی

`control_listen` یک لیسنر TCP ساده است با **JSON-RPC خط‌به‌خط** (یک آبجکت JSON + `\n`، جواب هم یک
خط). پیاده‌سازی: `libraries/nanorpc-sillad/src/lib.rs`.

متدها فقط همان‌هایی هستند که در `libraries/geph5-misc-rpc/src/client_control.rs` تعریف شده‌اند:
`conn_info`, `stat_num`, `start_time`, `stop`, `recent_logs`, `broker_rpc`, `start_registration`,
`poll_registration`, `stat_history`, `net_status`, `latest_news`, `get_update_manifest`, `ab_test`.
**`user_info` وجود ندارد** — اطلاعات حساب از راه `broker_rpc('get_user_info_by_cred', [cred])`
گرفته می‌شود، همان‌طور که `geph5-app/src/manager.rs` می‌گیرد.

### حساب

حساب یک `secret` است و با حل یک معمای اثبات‌کار ساخته می‌شود:
`start_registration()` → ایندکس، بعد `poll_registration(idx)` → `{progress, secret}`.

برای این کار یک دیمِن دوم با `dry_run: true` بالا می‌آید (بدون پورت، بدون نشست) تا تونلی که شاید
بالا باشد دست نخورد — همان «query engine» که خود upstream دائمی نگه می‌دارد.

### پورت‌ها

| | |
|---|---|
| SOCKS5 | `20850` |
| HTTP | `20851` |
| RPC کنترلی | `20852` (و `20853` برای دیمِن پرسش) |

### لاگ

فیلتر upstream با `with_default_directive("geph=debug").from_env_lossy()` ساخته شده، پس
**`RUST_LOG` جایگزینش می‌شود**. بدون آن، هر اتصال موفق چهل خط `dial stage failed` می‌دهد — آن‌ها
بازنده‌های مسابقهٔ مسیر هستند، نه خطا. ما `RUST_LOG=geph=info,geph5_client=info` می‌دهیم و آن خط را
با اسم فیلتر می‌کنیم.

## اندازه‌گیری‌های ۱۴۰۵/۰۶/۲۲ (روی همین خط)

| | |
|---|---|
| ساخت حساب رایگان | **۲۲ ثانیه** (معما)، `user_id 22806656`، سطح Free |
| اتصال سرد | **۲۵.۶ ثانیه** — خروج Canada · Montreal، ترابری `sosistab3` |
| اتصال گرم | **۳.۸ تا ۲۰.۲ ثانیه** |
| پروکسی HTTP | یوتیوب **۲۰۰**، ۸۷۷ کیلوبایت در ۸.۹ ثانیه |
| تونل کامل سیستم | بالا در ۱۲.۸ ثانیه؛ بدون هیچ تنظیم پروکسی، `cdn-cgi/trace` داد `ip=15.235.115.18 loc=CA` |
| سرورهای شبکه | ۱۲ کشور / ۳۰ خروج (US 7، CA 5، TW 4، JP 4، SE 3، …) |
| دسترسی سایت خودشان | `geph.io` **مستقیم باز شد** (308)، `getgeph.com` و `gephfree.com` هم |
