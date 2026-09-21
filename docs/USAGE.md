# Using MLMVPN for Windows

[فارسی](USAGE.fa.md)

The application opens as a desktop: a wallpaper, a dock at the bottom, and one window per feature.
Everything below is a window you can open from the dock, from the Launchpad grid, or with
**Ctrl + K**.

The interface is in Persian. Each heading below gives the Persian name so you can find it.

---

## Start here

If you have never used it before and just want to be online:

1. Open **«اتصال سریع» — Quick Connect**.
2. Press the button. It picks from a public pool, measures what it finds, and connects to the one
   that actually works from your line.
3. If nothing comes back, try **«سایفون» — Psiphon** or **«گیت‌وی MLM» — Gateway**. Neither needs
   anything of your own.

Everything else in this document is for when you want to do better than that.

---

## The engines

### One-button engines — nothing of your own required

| Window | What it is | When it is the right choice |
|---|---|---|
| **«سایفون»** Psiphon | A free circumvention network | First thing to try when nothing else connects. Per-connection ceiling is around 0.7 / 3.1 Mbit — fine for browsing, not for large downloads. |
| **«تور»** Tor | Onion routing | When you want the destination not to see your address. Slower by design. |
| **«لنترن»** Lantern | Domain-fronted proxy | A different fronting path from Psiphon — sometimes one works where the other does not. |
| **«گف»** Geph | Fronted broker | The only one of the four free engines that carries **UDP**, which matters for games. |
| **«گیت‌وی MLM»** Gateway | Free VPN Gate / SoftEther relays | A real VPN rather than a proxy. Throughput depends entirely on the volunteer relay. |
| **«ماسک»** Mask | MASQUE over Cloudflare WARP | Fast and quiet. Has a TCP fallback for lines that drop UDP. |
| **«وایرگارد»** WireGuard | AmneziaWG, obfuscated | |
| **«وارپ»** WARP | Cloudflare WARP | |
| **«وارپ در وارپ»** WARP-in-WARP | Chained WARP | When a plain WARP exit is blocked. |

> An engine can report an exit country of **IR** and still be correct — a WARP exit is chosen by
> Cloudflare, not by you. That is not a leak.

### Engines that use your own infrastructure

| Window | What it is |
|---|---|
| **«نودهای V2Ray»** V2Ray nodes | Your own VLESS / VMess / Trojan / Shadowsocks configs. Paste links, import subscriptions, measure them, connect. |
| **«زیرساخت ابری»** Cloud | Your Cloudflare account: deploy or adopt Workers, manage KV and D1, read usage, generate configs. Supports the BPB and Zeus panel families. |
| **«railway»** | Deploy the VodiWalker panel to your own Railway account from the public repository. |
| **«تونل گوگل‌اسکریپت»** Google Script tunnel | An HTTP relay through your own Google Apps Script deployment. Proxy mode only — an HTTP relay is the wrong shape for a full tunnel. |
| **«گیت‌هاب تانل»** GitHub tunnel | Disposable cloud sessions in your own GitHub account. |
| **«اوپن‌وی‌پی‌ان»** OpenVPN | OpenVPN profiles, with the same features as the Gateway window. |

---

## Finding a clean IP

**«اسکنر آی‌پی» — IP scanner** is what makes a config work when the same config times out for
everybody else.

1. Choose a provider (Cloudflare, Fastly, Akamai …) and the ports to try.
2. Start the scan. Results appear as they are proven — an address is only kept if it passes a real
   **health test**, not just a TCP handshake.
3. Pin a result to a specific **SNI** if your config needs one.
4. Send a result straight into a config, or keep it in **«آرشیو آی‌پی»** — the IP archive.

While a scan owns the network, connecting a VPN or running a delay test goes through a guard that
keeps the two from fighting over the same ports. You do not have to do anything; it just means a
connect during a scan may take a moment longer.

---

## Getting past a block — the anti-filter tools

| Window | What it does |
|---|---|
| **«موتور ضد فیلتر SNI»** | Five different methods, not one switch. The panel measures which of them your operator actually allows and connects with that one. |
| **«دامین فرانتینگ»** | Sends the request to one host and asks for another. |
| **«کانفیگ ایران»** | Serverless configs generated for Iranian networks specifically. The panel's «کدام کانفیگ مناسب من است؟» measures rather than guesses. |
| **«تحریم‌شکن»** | Routes only sanction-blocked sites (OpenAI, Google AI and so on) through a chosen engine, leaving everything else direct. Choose the applications and sites; the rest of your traffic is untouched. |

---

## Games

**«شتاب‌دهی بازی» — Game acceleration** is a single pipeline behind one button, not a pile of
toggles. What it actually does, in the order it matters:

1. **Upload bufferbloat.** The biggest measured lever by a wide margin: on a real line, latency
   under upload went from 126 ms to **2681 ms** with 29% loss. Capping egress fixes it.
2. **DNS resolver choice**, ranked by real coverage and handshake time on your line — not by a
   name someone hard-coded.
3. **Entry-point selection**, where the measured spread between entry points was about 70 ms.
4. **Machine tweaks** — nine of them, each discovered rather than assumed. Windows' background
   Game DVR recording is usually on and costs CPU, GPU and disk continuously.
5. **In-match watch** — detects latency spikes while you play and names what caused them. It
   changes nothing on its own.

Only **«گف» — Geph** carries UDP among the free engines. Psiphon, Lantern and Tor refuse SOCKS
UDP ASSOCIATE, and Tor always will — it is architectural, not a missing feature.

---

## Tools

| Window | What it is for |
|---|---|
| **«دیاگ اینترنت»** | What is wrong with this connection — five transports tested, with the repair journal |
| **«پاک‌سازی عمیق DNS»** | Clears resolver state that a previous run or another program left behind |
| **«تست سرعت»** | Throughput, in and out of the tunnel |
| **«بررسی سیستم»** | Whether everything the app needs is present and working |
| **«آیپی لوکیشن»** | Where your address is seen to be |
| **«مرکز ترکیب کانفیگ‌ها»** | Combines configs from different panels into one |
| **«مانیتور مصرف»** | Live throughput and usage over time |
| **«کنسول»** | Core log and scanner terminal |
| **«دستیار»** | Offers to combine new configs it notices, with the measurements behind the offer |

---

## Settings worth knowing

**«تنظیمات» — Settings** mirrors the Android app row for row. The ones people look for:

| Where | What |
|---|---|
| **شبکه** | DNS, ports, proxy mode, LAN sharing — the single place these live |
| **تنظیمات پیشرفته VPN** | MTU, tunnel stack (gvisor / system / automatic), routing |
| **تونل و برنامه‌ها** | Per-application routing: which executables go through the tunnel |
| **صفحه نمایش** | Appearance, text size, wallpaper, and **the graphics-acceleration switch** |
| **سیستم** | What to do when Windows locks; always-on VPN |
| **درباره** | Version, update check, **«گزارش خطا»** — the saved reports to send |

### Tunnel stack

The full tunnel has to reassemble Windows' TCP somewhere. **«سازگار (gvisor)»** does it in
software and works everywhere — it is the default and stays the default. **«سریع (system)»** hands
packets to Windows and is faster. **«خودکار»** tries fast first and falls back the moment it does
not come up.

### LAN sharing

**«شبکه محلی»** lets other devices on your network use this machine's tunnel. Not every engine can
do it; the panel says which can.

---

## The tray icon

Right-click the MLMVPN icon next to the Windows clock:

| | |
|---|---|
| **نمایش برنامه** | Bring the window back |
| **کشیدن صفحه با کارت گرافیک** | Graphics acceleration on/off — **this is the fix if the window opens black or white** |
| **باز کردن گزارش راه‌اندازی** | Opens `startup.log` — attach this to any "it will not open" report |
| **خروج کامل** | Full exit, with every teardown |

The last three are deliberately here and not only in Settings: Settings is *inside* the window, and
the tray menu is drawn by Windows, so it still works when the window does not.

---

## Where your files are

| | |
|---|---|
| `%USERPROFILE%\.mlmvpn\` | Settings, saved state, logs |
| `%USERPROFILE%\.mlmvpn\startup.log` | The launch diary — every start, with timings |
| `%USERPROFILE%\.mlmvpn\crashlogs\` | Saved reports, listed in Settings › درباره › گزارش خطا |
| `%USERPROFILE%\.mlmvpn\tunnel-events.log` | The tunnel's own diary: every connect, drop and speed probe |

Nothing is sent anywhere. Settings shows you the files and opens the folder; sending them is your
choice.
