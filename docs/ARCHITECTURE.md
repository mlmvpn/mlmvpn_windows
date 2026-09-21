# Architecture

[فارسی](ARCHITECTURE.fa.md)

How MLMVPN for Windows is put together, and — more usefully — the handful of rules that hold it
together. Most of those rules exist because breaking them once produced a bug that was hard to
find, and each one says which.

---

## The three layers

```
┌───────────────────────────────────────────────────────────────────────┐
│  RENDERER — public/                                                   │
│                                                                       │
│  index.html loads ~100 scripts. shell/ draws a macOS-style desktop:   │
│  a wallpaper, a dock, draggable windows. components/ has one module   │
│  per panel. No framework: vanilla JS, Tailwind for utility classes.   │
│                                                                       │
│  Talks to the main process over HTTP — fetch('/api/...') — and not    │
│  over IPC, except for one message: app:desktop-ready.                 │
└──────────────────────────────┬────────────────────────────────────────┘
                               │  http://127.0.0.1:<port>
┌──────────────────────────────┴────────────────────────────────────────┐
│  MAIN PROCESS — Electron                                              │
│                                                                       │
│  main.js     the window, the tray, startup health, the watchdog,      │
│              and the teardown that must run on every exit path        │
│  server.js   an Express app: every /api/* route the page calls.       │
│              It runs INSIDE the main process — see rule 1.            │
└──────────────────────────────┬────────────────────────────────────────┘
                               │
┌──────────────────────────────┴────────────────────────────────────────┐
│  ENGINE MANAGERS — *-manager.js, one per engine                       │
│                                                                       │
│  Each owns a binary's lifecycle: build its config, spawn it, watch    │
│  it, prove it is alive, tear it down. They share network-settings.js  │
│  and they do not talk to each other.                                  │
└──────────────────────────────┬────────────────────────────────────────┘
                               │  spawn, control ports, SOCKS/HTTP
┌──────────────────────────────┴────────────────────────────────────────┐
│  core/ — third-party binaries (not in this repository)                │
└───────────────────────────────────────────────────────────────────────┘
```

---

## Rule 1 — `server.js` is in the main thread, so nothing synchronous goes on a hot path

Electron's main process is single-threaded, and `server.js` lives in it. A synchronous call there
blocks the window **and** the HTTP server the page is loading its scripts from. The page stalls
half-built behind a black boot screen, and the user reports "the app hangs my PC".

That is not hypothetical. `startServer()` once called a PowerShell helper synchronously before the
window was created, and the helper did one CIM round trip **per network adapter**:

| | |
|---|---|
| before | **2167 ms** of hard main-thread lock |
| after | **37 ms** |

The more capable the machine — Hyper-V, WSL, Docker, VMware, several NICs — the worse it got, which
is why the report said "my system is very powerful but the app freezes it."

**So:** no `execSync`, no `execFileSync`, no synchronous sleep on any path a click or a start can
reach. Sync versions are kept only for `before-quit` and the bail-out paths, where nothing is
waiting on them, and they are named `…Sync` so the difference is visible at the call site.

---

## Rule 2 — network settings have exactly one owner

`network-settings.js` owns DNS servers, listening ports, proxy mode and LAN sharing. Engines read
from it. **Engines do not keep their own copies.**

Two engines with two ideas of what the DNS server is, is how a machine ends up with no internet and
no explanation — and it is not fixed by reinstalling, because the damage is to Windows, not to the
app.

Related: the **DNS bridge and the TUN cannot both own DNS**. Running the Node DNS bridge while the
tunnel is up kills all traffic the moment the bridge engages. When TUN is up, TUN owns DNS.

---

## Rule 3 — a machine change is recorded on disk *before* it is made

The kill switch, the DNS guard and the firewall rules all write down what the system looked like
**before** they touch it (`aether-guard.js`, `netdiag/journal`).

The reason is the failure mode that in-process cleanup cannot cover: Task Manager "End task", an
antivirus kill, a power cut. In each of those the process does not get to run any code at all. What
is left behind is a machine that is block-by-default with an allow-rule pointing at an adapter that
no longer exists, or resolving through a loopback address with nothing behind it.

So every start begins by **converging** — reading what is true now and repairing it — rather than
replaying a log. And `restoreIfStale` refuses to honour a journal it cannot prove is
administratively owned, because that file drives privileged action from an elevated process.

This is also why `server.js` must never be run casually to look at the UI: its recovery will treat
a live session as leftovers. Use `.claude/ui-preview.js` instead.

---

## Rule 4 — every teardown path tears down everything

TUN owns the machine's default route while it is up. If the app exits without removing it, the user
is left with no internet **and no application to turn it back off** — the adapter outlives the
process.

`app.on('before-quit')` is the one place guaranteed to run for the tray's «خروج کامل», the window
close and a normal quit, and it undoes: the TUN adapter, the Windows resolvers pointed at the
loopback bridge, the block-by-default firewall, and the system proxy.

The symptom when one of these is missed is always the same report: *"the lamp is off but my PC has
no internet, and quitting the app fixes it."*

---

## Rule 5 — the renderer needs `contextIsolation: false`, stated outright

`nodeIntegration: true` is **not** enough. Electron has defaulted `contextIsolation` to `true`
since v12, and with it on the page's own world has no `require` — so every
`require('electron').ipcRenderer` in `public/` throws, and every call site's `try/catch` swallows it
as "we must be in a browser".

That single default silently disabled three things at once: the in-page window buttons
(close/minimise/maximise), the menu bar's window actions, and the `app:desktop-ready` signal. The
third made **every launch on every machine** look like a failure, and drove an automatic
"disable the GPU" fallback that shipped and fired on healthy computers.

`main.js` states it explicitly with that history in a comment. Do not remove it, and if you upgrade
Electron, check that `startup.log` still records `desktop:ready`.

---

## Rule 6 — a failure the user cannot see is a failure that survives for months

Three mechanisms exist because of this:

**The startup diary.** `startup-health.js` appends to `~/.mlmvpn/startup.log` on every launch:
architecture, Windows build, Electron version, the GPU's own feature report, when the server came
up, how far the page got. A black window leaves no crash and no log of its own — this is the log.

**Native error dialogs.** `showStuckDialog` and `showStartupError` use
`dialog.showMessageBoxSync`, not a `BrowserWindow`. If the reason the app is invisible is that this
machine cannot put an Electron window on screen, then an Electron window explaining that is
invisible too. Windows draws a message box itself.

**The tray as the last surface.** The graphics-acceleration switch and "open the startup log" are
both on the tray menu, because Settings lives *inside* the window that is not drawing. The tray is
drawn by Windows and is the only thing a user with a black window can still reach.

---

## Rule 7 — measure on this machine, against the real thing

Claims about speed and latency are measured, not asserted.

- **Delay** is a warm pooled two-shot minimum, the same method v2rayN uses, so the numbers are
  comparable to the ones users already know. (`SocksProxyAgent` does not pool — the pooling is ours.)
- **A scan result** is kept only if it survives a real health test, not a TCP handshake.
- **A connection reports "connected"** only after the engine has proved it is alive — not when the
  process started.

The history of this project is mostly a list of plausible theories that turned out to be wrong when
somebody finally measured. Two examples worth keeping in mind: pinning Tor exit nodes is
measurably **2.5× slower**, not faster; and the biggest latency lever for gaming was not the route
at all, it was **upload bufferbloat** (126 ms → 2681 ms under load on a real line).

---

## The renderer in more detail

```
public/
  index.html            ~100 script tags; the server injects saved state above them
  shell/                the desktop: apps.js (the panel registry), dock, windows,
                        menubar, spotlight, widgets, boot
  components/           one module per panel — scanner, v2ray, cloud, store,
                        settings, quick, gateway, psiphon, tor, lantern, geph,
                        sni, sanction, iran, fronting, gst, github, vodi, game,
                        assistant, changelog, guide, systemcheck …
  ui/                   appearance-boot.js (theme before first paint), mv.js, tokens
  assets/               icons, fonts
```

Two things that catch people:

- **Panel `<style>` blocks are global.** Each panel injects unscoped CSS. A selector written for
  one panel will reach every other one — this is how «دستیار» once moved «استور»'s badge into the
  corner of the sidebar. Prefix your selectors.
- **Scripts share one global scope.** `public/*.js` are plain scripts, not modules. A bare `const`
  at top level collides across files.

---

## The engine managers

Each `*-manager.js` is responsible for one engine and exposes roughly the same shape: build a
config, start, stop, report status, report health. They are deliberately independent — no manager
imports another — and they meet in three places only:

| | |
|---|---|
| `network-settings.js` | DNS, ports, proxy mode, LAN — read by all, owned by one |
| `traffic-feed.js` | live throughput and usage; every engine feeds it |
| `engine-processes.js` | finding and ending engine processes that outlived their manager |

`front-guard.js` watches the four SOCKS "front" engines (Psiphon, Tor, Lantern, Geph) and restarts
one that dies under a connection that is still supposed to be up.

---

## Startup, end to end

```
main.js top level
  └─ startup-health.beginLaunch()      before app.whenReady(): Electron refuses
                                        disableHardwareAcceleration() afterwards
app.whenReady()
  ├─ startServer()                      recovery first, then listen on 127.0.0.1
  ├─ createWindow(port)                 loads http://127.0.0.1:<port>  (an address,
  │                                     never the name "localhost" — this app rewires DNS)
  │    └─ 30 s watchdog armed
  └─ Tray + buildTrayMenu()

renderer
  └─ systemcheck.js startBoot()
       └─ when the desktop is usable → ipcRenderer.send('app:desktop-ready')
            └─ main.js clears the watchdog and marks the launch healthy
```

If `desktop-ready` never arrives, the watchdog **asks the page whether it is alive** before saying
anything — `executeJavaScript` with a five-second race. A page that answers is not a failure we can
see, and the dialog stays silent. Only a page that does not answer produces the dialog, and the
same moment writes the probe's answer and the GPU's feature status into the diary.

---

## Testing

`tests/` has one suite per subsystem and `npm test` runs them all. The ones worth knowing:

| Suite | Catches |
|---|---|
| `tests/aether/packaging.test.js` | a new module missing from `build.files` — a runtime-only crash |
| `tests/aether/` | settings parity with Android, always-on, the lock watcher |
| `tests/v2ray/` | link parsing, delay measurement, the connect lifecycle |
| `tests/netdiag/` | the five transports and the repair journal |
| `tests/game/` | the latency pipeline |
| `tests/fronts/` | the four SOCKS front engines, against the real network |

Suites that reach the network can fail on a censored line without your build being wrong. Read the
failure before assuming.
