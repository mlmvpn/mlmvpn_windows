# Building MLMVPN for Windows

[فارسی](BUILD.fa.md)

---

## The short version

```bash
git clone https://github.com/mlmvpn/mlmvpn_windows.git
cd mlmvpn_windows
npm install
# ...then populate core/ — see below. The app will not start without it.
npm run electron
```

`npm install` gets you the JavaScript. It does **not** get you the engines, and without them the
application starts but every engine panel reports a missing binary.

---

## Why `core/` is not in this repository

`core/` is about **450 MB of other people's compiled software** — Xray-core, sing-box, Tor,
Psiphon, OpenVPN, Lantern, Geph, WireGuard tooling, WinDivert and their data files. Three reasons
it stays out:

1. **They are not ours to redistribute.** Each is a separate project under its own licence, some
   with conditions on redistribution. The [MLMVPN Attribution Licence](../LICENSE) covers only the
   code MLMVPN wrote.
2. **Git is the wrong place for it.** 450 MB of binaries that change with every upstream release
   would make every clone enormous and every history rewrite painful.
3. **You should know what you are running.** A VPN client is exactly the kind of software where
   "some binaries appeared in my repo" is not good enough. Fetch each one from its own project and
   check it.

---

## What `core/` must contain

Lay it out exactly like this. Paths are relative to the repository root and are hard-coded in
`core-paths.js`, so names matter.

### Required for the application to be useful

| Path | What it is | Where it comes from | Licence |
|---|---|---|---|
| `core/xray.exe` | Xray-core — VLESS/VMess/Trojan/SS, every transport | [XTLS/Xray-core releases](https://github.com/XTLS/Xray-core/releases) → `Xray-windows-64.zip` | MPL-2.0 |
| `core/geoip.dat`, `core/geosite.dat` | Routing databases Xray and sing-box both read | [Loyalsoldier/v2ray-rules-dat](https://github.com/Loyalsoldier/v2ray-rules-dat/releases) | CC-BY-SA-4.0 |
| `core/sing-box.exe` | The TUN / full-tunnel engine | [SagerNet/sing-box releases](https://github.com/SagerNet/sing-box/releases) | GPL-3.0 |
| `core/wintun.dll` | The TUN adapter driver sing-box uses | [wintun.net](https://www.wintun.net/) → `bin/amd64/wintun.dll` | Prosperity / see site |

**Xray version matters.** The TLS fragmenting and browser-fingerprint options this application
writes into outbounds need **Xray 26.7.28 or newer**. An older core ignores them silently — the
connection works and the anti-filter profile simply does not exist.

### Engine binaries — each one powers one panel

| Path | What it is | Where it comes from | Licence |
|---|---|---|---|
| `core/psiphon.exe` | Psiphon tunnel-core console client | [Psiphon-Labs/psiphon-tunnel-core](https://github.com/Psiphon-Labs/psiphon-tunnel-core) — build `ConsoleClient` | GPL-3.0 |
| `core/psiphon_server_entries.txt` | Psiphon's embedded server list | Ships with tunnel-core | GPL-3.0 |
| `core/tor/tor.exe` + `core/tor/data/` + `core/tor/pluggable_transports/` | Tor with obfs4/snowflake | [Tor Expert Bundle](https://www.torproject.org/download/tor/) | BSD-3-Clause |
| `core/lantern.exe` | Lantern — see [LANTERN-BUILD.md](LANTERN-BUILD.md) | Built from `getlantern/flashlight` with our own `main` | Apache-2.0 |
| `core/geph/geph5-client.exe` | Geph — see [GEPH-BUILD.md](GEPH-BUILD.md) | [geph-official/geph5](https://github.com/geph-official/geph5) | GPL-3.0 |
| `core/openvpn/openvpn.exe` + its three DLLs | OpenVPN 2.6 community | [openvpn.net/community-downloads](https://openvpn.net/community-downloads/) | GPL-2.0 |
| `core/aether.exe` | MASQUE / WireGuard / WARP-in-WARP engine | Upstream Aether 2.0.0, unmodified | see its own repo |
| `core/tailscale/` | `tailscale.exe`, `tailscaled.exe`, `wintun.dll` — carries the GitHub tunnel | [tailscale/tailscale releases](https://github.com/tailscale/tailscale/releases) | BSD-3-Clause |
| `core/gst.exe` | Google Script tunnel client — Rust, in `gst-src/` | Built here; see [GST-PLAN.md](GST-PLAN.md) | MLMVPN |
| `core/sni-spoofer/` | SNI engine + `WinDivert64.dll` / `.sys` | [basil00/WinDivert](https://github.com/basil00/WinDivert) | LGPL-3.0 / GPL-3.0 |
| `core/vpngate_servers.csv` | Seed list for the Gateway panel | [vpngate.net](https://www.vpngate.net/) — refreshed at runtime | — |

### Written by the application, not by you

`config.json`, `tun-config.json`, `test_config.json`, `config_test.json` are generated. The
`core/python/` and `core/mitm/` folders belong to the SNI and domain-fronting engines.

---

## Building `gst.exe` from `gst-src/`

The Google Script tunnel client is ours, in Rust, and is the one binary in `core/` you must build.

```bash
cd gst-src
cargo build --release
cp target/release/gst.exe ../core/gst.exe
```

Two things about this machine's toolchain that cost an afternoon the first time:

- **Rust may not be on the default path.** If `cargo` is not found, look for a non-standard
  install root and put its `bin` on `PATH` for the shell you build in.
- **NASM is required and is often not on `PATH`.** A dependency needs it to assemble. Install it
  and export its directory before `cargo build`, or the build fails deep inside a crate with an
  error that does not mention NASM.

`gst-src/` is not in this repository for size reasons (it carries a Rust `target/` directory).
[GST-PLAN.md](GST-PLAN.md) describes what the client does and the protocol it speaks.

---

## Running and packaging

```bash
npm run electron    # run from source
npm test            # every suite
npm run build       # electron-builder --win → dist/
```

`npm run build` produces, in `dist/`:

| | |
|---|---|
| `mlm-vpn-Setup-<version>-x64.exe` | 64-bit installer |
| `mlm-vpn-Setup-<version>-ia32.exe` | 32-bit installer |
| `mlm-vpn-Setup-<version>.exe` | both architectures in one |
| `mlm-vpn-Portable-<version>*.exe` | portable, no installation |
| `win-unpacked/`, `win-ia32-unpacked/` | the unpacked trees the installers are made from |

### `build.files` is an allow-list — this will bite you

`package.json` → `build.files` names every file that goes into the package. **A new root-level
module that is not listed simply is not packaged**, and the app crashes on `require` at runtime
while working perfectly from source.

`tests/aether/packaging.test.js` checks this and has caught it more than once. When you add a
top-level module, add it to `build.files` in the same commit.

```bash
npm run test:aether     # includes the packaging check
```

---

## Fast iteration: editing a packaged build

Rebuilding for a one-line change takes about twenty-five minutes. Instead, convert the packed
`app.asar` into a plain folder once and copy files into it:

```bash
node dev-unpack.js                         # asar → resources/app/  (close the app first!)
node dev-sync.js main.js public/app.js     # copy changed files straight in
node dev-sync.js --build=win-ia32-unpacked main.js   # same for the 32-bit build
```

`dev-unpack.js` extracts the asar, then renames it to `app.asar.disabled` — Electron prefers
`app.asar` over an `app/` folder when both exist. Nothing is deleted, so renaming that one file
back restores the packaged build.

**Windows will refuse while the app is running**, because the `.exe` holds `app.asar` open. Close
MLMVPN, including the tray icon.

**Every `npm run build` writes a fresh `app.asar`**, so the conversion must be redone afterwards.

---

## Looking at the interface without starting the app

`server.js` is not a passive web server. `startServer()` begins with recovery: it releases stale
firewall rules, repairs stranded loopback DNS and re-enables the dedicated DNS bridge. Run it while
the real application is up and that recovery treats the live session as leftovers and tears it down.

```bash
node .claude/ui-preview.js --api
# http://127.0.0.1:35299 — serves public/, answers every /api/* with 503,
# and a handful of read-only Settings GETs from the real settings files.
```

---

## Environment

| | |
|---|---|
| Node.js | 18+ |
| Electron | 42.3.3 (pinned — see below) |
| electron-builder | as pinned in `package.json` |
| Windows | 10 1809+ or 11, to build the Windows targets |

**Electron is pinned deliberately.** Electron defaults `contextIsolation` to `true`, and this
application needs it `false` so the page can reach the main process — that is stated explicitly in
`main.js` with the reason. A silent change in that area cost a release: the window buttons, the
menu bar and the desktop-ready signal all failed quietly at once. When you upgrade Electron, run
the boot test and check that `startup.log` still records `desktop:ready`.

---

## Verifying a build

```bash
npm test                # all suites
npm run test:aether     # packaging + settings parity + always-on
npm run test:v2ray      # config parsing, delay measurement, connect lifecycle
npm run test:netdiag    # transports and the repair journal
npm run test:game       # latency pipeline
```

Some suites reach the real network (resolver reachability, front-engine health). Those can fail on
a censored or unusual line without anything being wrong with your build — read what failed before
assuming you broke it.
