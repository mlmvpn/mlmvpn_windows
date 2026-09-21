# Troubleshooting

[فارسی](TROUBLESHOOTING.fa.md)

Start by finding the right section by **symptom**. Each one says what to do and, where we know it,
what actually causes it.

---

## The window opens black, or white, and nothing appears

Not the loading screen — a completely black or completely white window.

**Do this first:**

1. Right-click the MLMVPN icon next to the Windows clock.
2. Turn off **«کشیدن صفحه با کارت گرافیک»** (draw with the graphics card).
3. Choose **«همین حالا دوباره اجرا کن»** (restart now).

The screen is drawn by the CPU after that — slightly slower, but it works on any machine. The tray
menu is used for this deliberately: Settings lives *inside* the window that is not drawing, so a
black window can never reach it. Windows draws the tray menu itself.

**If that does not fix it,** an antivirus is the next most likely cause — it can block the
application's own local HTTP server, which the window loads from. Disable it temporarily and try
again.

**Please send us the log either way.** Right-click the tray icon → **«باز کردن گزارش راه‌اندازی»**.
That opens the folder with `startup.log` selected. It looks like this:

```
+     3ms  launch  {"app":"1.2.3","arch":"ia32","windows":"10.0.19045","electron":"42.3.3",…}
+    64ms  app:ready
+    66ms  server:up  {"port":45999,"ms":62}
+   167ms  page:loading  http://127.0.0.1:45999/
+   192ms  page:start
+  4319ms  page:dom-ready
+  4500ms  desktop:ready
```

That file is the whole diagnosis:

| What you see | What it means |
|---|---|
| The last line is **`desktop:ready`** | The page came up perfectly and the problem is in *displaying* it — a graphics/compositing issue. The tray switch is the fix. |
| It stops at **`page:loading`** or **`page:start`** | The page never loaded. Something is blocking the local HTTP server — an antivirus, or a firewall rule. |
| It stops at **`server:up`** | The window was created but never began loading. |
| There is no **`server:up`** | The internal server did not start. You should have seen a message box saying so. |

This log is the reason the feature exists. A black window produces no crash, no error and no log of
its own, and every earlier theory about it was a guess — one of which shipped and turned out to be
wrong. Please attach it.

---

## "The app hangs my whole PC when it opens"

Fixed in 1.2.3. A startup check ran a PowerShell helper synchronously, once per network adapter,
before the window was created — so the more capable the machine (Hyper-V, WSL, Docker, VMware,
several network cards), the longer it froze. Measured on one laptop with a single adapter:
**2167 ms → 37 ms**.

If you still see it on 1.2.3, send `startup.log` — the gap between `app:ready` and `server:up`
shows exactly how long the server took.

---

## The lamp is off, but the PC has no internet — quitting the app fixes it

Something the app set up was not torn down. The three usual suspects: the TUN adapter still owning
the default route, Windows' resolvers still pointing at a loopback DNS bridge that died with the
process, or a block-by-default firewall rule left behind.

**To fix it now:** quit properly — tray → **«خروج کامل»**. That path runs every teardown.

**Why it happens:** in-process cleanup cannot run when the process does not get to run any code —
Task Manager "End task", an antivirus kill, a power cut. The application handles this by recording
what the system looked like *before* it changed anything, and repairing on the next start. So
simply launching it again should also fix it.

**«پاک‌سازی عمیق DNS»** (deep DNS cleanup) clears resolver state left behind by anything, including
other programs.

---

## It connects, but no data goes through

Work down this list:

1. **Is it proxy mode or full tunnel?** In proxy-only mode, nothing goes through until an
   application is configured to use that port. The status bar says so explicitly.
2. **Did the tunnel actually come up?** If the engine connected but the tunnel did not, the card
   turns orange and says so. A green card with no traffic used to be possible; it is not any more.
3. **Check the tunnel diary** — `%USERPROFILE%\.mlmvpn\tunnel-events.log`. It records every
   connect, every drop and every speed probe, with the stack and MTU next to each number.
4. **UDP.** If the node has no UDP, QUIC is refused immediately so the browser falls back to TCP.
   If you see a game or a video call failing while web pages work, that is the shape of it.

---

## The delay test says "Timeout" for a whole batch

Fixed. One busy port used to kill the shared test core, which reported every remaining config in
that batch as a timeout. Each config now gets its own port, the v2rayN way.

If you still see a whole batch fail, check whether the core came up at all — "the core did not
start" and "this server is dead" are different messages now, and the panel distinguishes them.

---

## A config that should work does not connect

- **Does it have `h2` in its ALPN?** `h2` silently kills every WebSocket outbound. This is the most
  common reason a config that works elsewhere never connects here.
- **Is your Xray core new enough?** TLS fragmenting and browser fingerprints need **26.7.28 or
  newer**. An older core ignores them without saying anything — the connection works, but the
  anti-filter profile does not exist.
- **Is the address clean?** Run **«اسکنر آی‌پی»** and pin the result to the config's SNI.

---

## The scanner finds nothing

Fixed in 1.2.3. A single config that could not be built used to kill the whole batch of 20 nodes,
so a scan could return nothing at all while working perfectly.

---

## An engine reports its exit country as Iran

That is usually correct, not a leak. A WARP exit is chosen by Cloudflare, not by you, and it can be
inside the country. Different geolocation sources also disagree with each other. The application
resolves the exit per transport rather than trusting one source.

---

## "Package did not open:" with an empty message

The Store's MSI extraction. `msiexec` needs `TARGETDIR="value"` quoted, and prints nothing at all
when it fails — hence an error with no text. Fixed; if you see it, send the version.

---

## Tor is very slow

Tor is slower than a direct proxy by design, but if it is *unusably* slow it used to be for a
specific reason: the client pinned itself to a single entry guard, which could be an unlisted relay
with very little capacity. That, a 60-second circuit timeout and a TTL-60 DNS storm together made
it far worse than Tor should be. Fixed.

Note that **pinning exit nodes is 2.5× slower**, measured — so the application does not offer it as
a speed option, because it is not one.

---

## Psiphon is slow

Its per-connection ceiling is around **0.7 Mbit up / 3.1 Mbit down**, measured. That is the network,
not a bug — it is a free service carrying a lot of people.

If it is far worse than that, the client may be stuck on a slow server it has remembered. Clearing
its datastore makes it choose again.

---

## Still stuck — what to send

Settings → **درباره** → **«گزارش خطا»** lists the saved reports and opens the folder.

Please include:

| | |
|---|---|
| `%USERPROFILE%\.mlmvpn\startup.log` | Every launch, with timings — the single most useful file |
| `%USERPROFILE%\.mlmvpn\crashlogs\` | Crash and failed-start reports |
| `%USERPROFILE%\.mlmvpn\tunnel-events.log` | For anything about connecting or speed |
| Version, Windows version, 32- or 64-bit | The first line of `startup.log` has all three |

Open an issue at
[github.com/mlmvpn/mlmvpn_windows/issues](https://github.com/mlmvpn/mlmvpn_windows/issues).

**Before you attach a log, have a look at it.** These files record your own machine — adapter
names, the addresses you connected to, the panels you used. None of it is sent anywhere by the
application; sending it is your choice, so make it a deliberate one.
