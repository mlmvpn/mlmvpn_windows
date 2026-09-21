# ساخت MLMVPN برای ویندوز

[English](BUILD.md)

---

## خلاصه

```bash
git clone https://github.com/mlmvpn/mlmvpn_windows.git
cd mlmvpn_windows
npm install
# ...بعد پوشهٔ core/ را پر کنید — پایین‌تر. بدون آن برنامه کار نمی‌کند.
npm run electron
```

`npm install` فقط جاوااسکریپت را می‌آورد. **موتورها را نمی‌آورد**، و بدون آن‌ها برنامه بالا می‌آید ولی
هر پنل موتور می‌گوید باینری‌اش نیست.

---

## چرا `core/` در این مخزن نیست

`core/` حدود **۴۵۰ مگابایت نرم‌افزار کامپایل‌شدهٔ دیگران** است — Xray-core، sing-box، Tor، Psiphon،
OpenVPN، Lantern، Geph، ابزار WireGuard، WinDivert و فایل‌های داده‌شان. سه دلیل که بیرون می‌ماند:

۱. **مال ما نیست که بازنشرش کنیم.** هرکدام پروژه‌ای جداگانه زیر پروانهٔ خودش است و بعضی‌شان شرط
   بازنشر دارند. [پروانهٔ انتساب MLMVPN](../LICENSE) فقط کدی را پوشش می‌دهد که MLMVPN نوشته.
۲. **گیت جای این نیست.** ۴۵۰ مگابایت باینری که با هر انتشار بالادستی عوض می‌شود، هر کلون را غول‌پیکر
   می‌کند.
۳. **باید بدانید چه چیزی را اجرا می‌کنید.** یک کلاینت VPN دقیقاً همان‌جایی است که «یک سری باینری در
   مخزنم ظاهر شد» کافی نیست. هرکدام را از پروژهٔ خودش بگیرید و بررسی کنید.

---

## `core/` باید چه چیزهایی داشته باشد

دقیقاً با همین چیدمان. مسیرها نسبت به ریشهٔ مخزن‌اند و در `core-paths.js` ثابت نوشته شده‌اند، پس
**نام‌ها مهم‌اند**.

### لازم برای اینکه برنامه به درد بخورد

| مسیر | چیست | از کجا | پروانه |
|---|---|---|---|
| `core/xray.exe` | Xray-core — VLESS/VMess/Trojan/SS و همهٔ ترنسپورت‌ها | [XTLS/Xray-core releases](https://github.com/XTLS/Xray-core/releases) ← `Xray-windows-64.zip` | MPL-2.0 |
| `core/geoip.dat`، `core/geosite.dat` | پایگاه‌های مسیریابی که Xray و sing-box هر دو می‌خوانند | [Loyalsoldier/v2ray-rules-dat](https://github.com/Loyalsoldier/v2ray-rules-dat/releases) | CC-BY-SA-4.0 |
| `core/sing-box.exe` | موتور TUN / تونل کامل | [SagerNet/sing-box releases](https://github.com/SagerNet/sing-box/releases) | GPL-3.0 |
| `core/wintun.dll` | درایور آداپتور TUN که sing-box استفاده می‌کند | [wintun.net](https://www.wintun.net/) ← `bin/amd64/wintun.dll` | Prosperity / سایت خودش |

**نسخهٔ Xray مهم است.** گزینه‌های تکه‌تکه‌سازی TLS و اثر انگشت مرورگر که این برنامه در outbound
می‌نویسد، به **Xray نسخهٔ ۲۶.۷.۲۸ یا بالاتر** نیاز دارند. هستهٔ قدیمی‌تر آن‌ها را **بی‌صدا نادیده
می‌گیرد** — اتصال کار می‌کند و پروفایل ضدفیلتر فقط وجود ندارد.

### باینری موتورها — هرکدام یک پنل را می‌رانَد

| مسیر | چیست | از کجا | پروانه |
|---|---|---|---|
| `core/psiphon.exe` | کلاینت کنسولی Psiphon tunnel-core | [Psiphon-Labs/psiphon-tunnel-core](https://github.com/Psiphon-Labs/psiphon-tunnel-core) — `ConsoleClient` را بسازید | GPL-3.0 |
| `core/psiphon_server_entries.txt` | فهرست سرورهای تعبیه‌شدهٔ Psiphon | همراه tunnel-core | GPL-3.0 |
| `core/tor/tor.exe` + `core/tor/data/` + `core/tor/pluggable_transports/` | Tor با obfs4/snowflake | [Tor Expert Bundle](https://www.torproject.org/download/tor/) | BSD-3-Clause |
| `core/lantern.exe` | لنترن — [LANTERN-BUILD.md](LANTERN-BUILD.md) را ببینید | از `getlantern/flashlight` با `main` خودمان | Apache-2.0 |
| `core/geph/geph5-client.exe` | گف — [GEPH-BUILD.md](GEPH-BUILD.md) را ببینید | [geph-official/geph5](https://github.com/geph-official/geph5) | GPL-3.0 |
| `core/openvpn/openvpn.exe` + سه DLL کنارش | OpenVPN 2.6 نسخهٔ community | [openvpn.net/community-downloads](https://openvpn.net/community-downloads/) | GPL-2.0 |
| `core/aether.exe` | موتور MASQUE / WireGuard / وارپ‌در‌وارپ | Aether 2.0.0 بالادستی، بدون تغییر | مخزن خودش |
| `core/tailscale/` | `tailscale.exe`، `tailscaled.exe`، `wintun.dll` — حامل تونل گیت‌هاب | [tailscale/tailscale releases](https://github.com/tailscale/tailscale/releases) | BSD-3-Clause |
| `core/gst.exe` | کلاینت تونل گوگل‌اسکریپت — Rust، در `gst-src/` | همین‌جا ساخته می‌شود؛ [GST-PLAN.md](GST-PLAN.md) | MLMVPN |
| `core/sni-spoofer/` | موتور SNI + `WinDivert64.dll` / `.sys` | [basil00/WinDivert](https://github.com/basil00/WinDivert) | LGPL-3.0 / GPL-3.0 |
| `core/vpngate_servers.csv` | فهرست اولیهٔ پنل گیت‌وی | [vpngate.net](https://www.vpngate.net/) — در زمان اجرا تازه می‌شود | — |

### چیزهایی که خود برنامه می‌نویسد، نه شما

`config.json`، `tun-config.json`، `test_config.json`، `config_test.json` تولیدی‌اند. پوشه‌های
`core/python/` و `core/mitm/` متعلق به موتورهای SNI و دامین‌فرانتینگ‌اند.

---

## ساخت `gst.exe` از `gst-src/`

کلاینت تونل گوگل‌اسکریپت مال خودمان است، با Rust، و تنها باینری `core/` است که **باید** بسازیدش.

```bash
cd gst-src
cargo build --release
cp target/release/gst.exe ../core/gst.exe
```

دو نکته دربارهٔ زنجیرهٔ ابزار که بار اول یک بعدازظهر وقت گرفت:

- **ممکن است Rust روی مسیر پیش‌فرض نباشد.** اگر `cargo` پیدا نشد، دنبال محل نصب غیرمعمول بگردید و
  پوشهٔ `bin` آن را برای همان شل روی `PATH` بگذارید.
- **NASM لازم است و معمولاً روی `PATH` نیست.** یکی از وابستگی‌ها برای اسمبل کردن به آن نیاز دارد.
  نصبش کنید و مسیرش را قبل از `cargo build` صادر کنید، وگرنه ساخت با خطایی که **اسمی از NASM
  نمی‌برد** ته یک crate شکست می‌خورد.

`gst-src/` به‌خاطر حجم (پوشهٔ `target/` راست) در این مخزن نیست.

---

## اجرا و بسته‌بندی

```bash
npm run electron    # اجرا از روی سورس
npm test            # همهٔ مجموعه‌ها
npm run build       # electron-builder --win ← dist/
```

`npm run build` در `dist/` این‌ها را می‌سازد:

| | |
|---|---|
| `mlm-vpn-Setup-<نسخه>-x64.exe` | نصاب ۶۴ بیتی |
| `mlm-vpn-Setup-<نسخه>-ia32.exe` | نصاب ۳۲ بیتی |
| `mlm-vpn-Setup-<نسخه>.exe` | هر دو معماری در یکی |
| `mlm-vpn-Portable-<نسخه>*.exe` | پرتابل، بدون نصب |
| `win-unpacked/`، `win-ia32-unpacked/` | درخت‌های بازشده‌ای که نصاب از رویشان ساخته می‌شود |

### `build.files` یک فهرست مجاز است — این شما را گاز می‌گیرد

`package.json` → `build.files` هر فایلی را که وارد بسته می‌شود نام می‌برد. **ماژول تازه‌ای در ریشه که
در آن فهرست نباشد، اصلاً بسته‌بندی نمی‌شود** — و برنامه هنگام `require` در زمان اجرا کرش می‌کند،
درحالی‌که از روی سورس بی‌عیب کار می‌کند.

`tests/aether/packaging.test.js` همین را چک می‌کند و بیش از یک بار گرفته است. وقتی ماژول سطح‌بالا
اضافه می‌کنید، در **همان کامیت** به `build.files` هم اضافه‌اش کنید.

```bash
npm run test:aether     # شامل بررسی بسته‌بندی
```

---

## تکرار سریع: ویرایش یک بستهٔ ساخته‌شده

ساخت دوباره برای یک خط تغییر حدود بیست‌وپنج دقیقه طول می‌کشد. به‌جایش یک بار `app.asar` را به پوشهٔ
ساده تبدیل کنید و فایل‌ها را داخلش کپی کنید:

```bash
node dev-unpack.js                         # asar ← resources/app/  (اول برنامه را ببندید!)
node dev-sync.js main.js public/app.js     # کپی مستقیم فایل‌های تغییرکرده
node dev-sync.js --build=win-ia32-unpacked main.js   # همین برای بستهٔ ۳۲ بیتی
```

`dev-unpack.js` اول asar را استخراج می‌کند، بعد اسمش را به `app.asar.disabled` عوض می‌کند — چون وقتی
هر دو باشند، الکترون `app.asar` را به پوشهٔ `app/` ترجیح می‌دهد. چیزی حذف نمی‌شود، پس برگرداندن همان
یک نام، بستهٔ اصلی را برمی‌گرداند.

**ویندوز تا وقتی برنامه در حال اجراست اجازه نمی‌دهد**، چون خود `.exe` فایل `app.asar` را باز نگه
داشته. MLMVPN را ببندید، از جمله آیکون کنار ساعت.

**هر `npm run build` یک `app.asar` تازه می‌نویسد**، پس تبدیل باید دوباره انجام شود.

---

## دیدن رابط کاربری بدون اجرای برنامه

`server.js` یک وب‌سرور منفعل نیست. `startServer()` با بازیابی شروع می‌شود: قواعد کهنهٔ فایروال را آزاد
می‌کند، DNS لوپ‌بک جامانده را تعمیر می‌کند و پل DNS اختصاصی را دوباره روشن می‌کند. اگر وقتی برنامهٔ
واقعی بالاست اجرایش کنید، آن بازیابی نشست زنده را «باقی‌مانده» می‌بیند و برش می‌دارد.

```bash
node .claude/ui-preview.js --api
# http://127.0.0.1:35299 — پوشهٔ public/ را سرو می‌کند، هر /api/* جواب 503 می‌دهد،
# و چند GET فقط‌خواندنی تنظیمات از فایل‌های واقعی جواب داده می‌شود.
```

---

## محیط

| | |
|---|---|
| Node.js | ۱۸ یا بالاتر |
| Electron | ۴۲.۳.۳ (عمداً پین شده — پایین‌تر) |
| electron-builder | همان که در `package.json` پین شده |
| ویندوز | ۱۰ نسخهٔ ۱۸۰۹ به بعد یا ۱۱، برای ساخت خروجی ویندوز |

**نسخهٔ الکترون عمداً پین شده است.** الکترون `contextIsolation` را پیش‌فرض `true` می‌گذارد و این
برنامه به `false` نیاز دارد تا صفحه بتواند به پروسهٔ اصلی برسد — این در `main.js` با دلیلش صریح
نوشته شده. یک تغییر بی‌صدا در همین ناحیه، یک انتشار را خراب کرد: دکمه‌های پنجره، منوی بالا و سیگنال
«میزکار آمد» هر سه با هم بی‌صدا از کار افتادند. وقتی الکترون را ارتقا می‌دهید، تست بوت را اجرا کنید و
مطمئن شوید `startup.log` هنوز `desktop:ready` را ثبت می‌کند.

---

## بررسی یک ساخت

```bash
npm test                # همهٔ مجموعه‌ها
npm run test:aether     # بسته‌بندی + هم‌ترازی تنظیمات + always-on
npm run test:v2ray      # تجزیهٔ کانفیگ، سنجش تأخیر، چرخهٔ اتصال
npm run test:netdiag    # ترنسپورت‌ها و دفترچهٔ تعمیر
npm run test:game       # خط لولهٔ تأخیر
```

بعضی مجموعه‌ها به شبکهٔ واقعی می‌روند (دسترس‌پذیری resolver، سلامت موتورهای جلویی). آن‌ها روی یک خط
فیلترشده یا غیرمعمول ممکن است شکست بخورند بدون آنکه ساخت شما ایرادی داشته باشد — **اول بخوانید چه
چیزی شکست خورد**، بعد فرض کنید چیزی را خراب کرده‌اید.
