# Building `core/lantern.exe`

The «لنترن» engine in MLM VPN is Lantern's own core, `getlantern/flashlight`, with a `main` of our
own. Lantern itself ships nothing that can be driven: the desktop app is Flutter and links the Go
core over FFI, so there is no `psiphon.exe`-shaped binary and no `vpncmd`-shaped CLI. What there
**is** is exactly the entry point needed:

```go
func (f *Flashlight) Run(httpProxyAddr, socksProxyAddr string,
    afterStart func(cl *client.Client),
    onError func(err error),
)
```

so `cmd/lanternproxy` is the missing `main` around it. `flashlight` is **GPL-3.0**, which is why this
is a separate executable talked to over a socket — the same arrangement as `tor.exe`.

## The toolchain

Go lives on `I:\`, not on PATH (same as the Rust toolchain — see the `rust-build-toolchain` note).

```bash
export GOROOT=/i/toolchains/go
export GOTOOLCHAIN=local
export GOCACHE=/i/toolchains/gocache
export GOMODCACHE=/i/toolchains/gomodcache
export GOFLAGS=-mod=mod
export PATH="/i/toolchains/go/bin:$PATH"
```

**`GOPROXY` must be a mirror.** `proxy.golang.org` answers `403 Forbidden` from Iran for a handful of
module zips — sanctions, not a network fault: the `.info` and `.mod` come back fine and only the
`.zip` is refused, which makes the failure look like a broken module. `goproxy.io` is refused too.
`goproxy.cn` answers:

```bash
export GOPROXY='https://goproxy.cn,direct'
export GOSUMDB=off
```

Then:

```bash
cd /i/toolchains/lantern-src
go build -ldflags="-s -w" -o "I:/toolchains/lantern.exe" ./cmd/lanternproxy
cp /i/toolchains/lantern.exe "G:/ip scanner/core/lantern.exe"
```

`-ldflags="-s -w"` takes it from 56 MB to 40 MB.

## The four patches, and why each is load-bearing

Re-apply every one of these after pulling upstream. Without the first two the engine builds and runs
and **carries nothing from Iran**, with no error that says why.

### 1. `cmd/lanternproxy/main.go` — set `common.LibraryVersion`

Without it the config service answers:

```
400  bad client factors: getting platform and version
```

and the client never receives a proxy list, so every site the routing rules mark as blocked fails
with `no fallback was specified`. The request itself is fine — it reaches `df.iantem.io` through
domain fronting, which is the part that could have been blocked and is not.

`flashlight.New` does call `common.InitVersion(appVersion)`, so `CompileTimeApplicationVersion` is
set. `LibraryVersion` is **not**: `InitVersion` looks for flashlight among `debug.ReadBuildInfo()`'s
**dependencies**, and in this build flashlight is the *main module*, so the loop never matches and
`X-Lantern-Version` goes out empty. So `main` sets it directly, to the version this tree is:

```go
const (
	appVersion     = "8.1.9"    // lantern-client's pubspec version
	libraryVersion = "7.6.239"  // the flashlight release its go.mod pins
)
common.LibraryVersion = libraryVersion
```

Both are real values from the client this core belongs to. The `X-Lantern-App` header is Lantern's
own default either way (`NullAuthConfig.GetAppName()`), so this is not a disguise — it declares which
build of the protocol is being spoken. Check both numbers against `lantern-client`'s `pubspec.yaml`
and `go.mod` when upgrading.

### 2. `client/client.go` — the SOCKS listener must carry the NAME

Two changes in `ListenAndServeSOCKS5`: a `passthroughResolver` that does not resolve, and a
`HandleConnect` that prefers `req.DestAddr.FQDN` over `.IP`.

`go-socks5`'s `handleRequest` resolves every FQDN with its default (system) resolver before
`HandleConnect` runs, and writes the answer into `dest.IP`. On this line that answer is
`10.10.34.36`, Iran's sinkhole — and flashlight then sees a *private* IP and correctly force-directs
it, straight into the sinkhole. Measured: `google.com` worked (not poisoned) while YouTube, Instagram
and X all failed; after the patch all three returned `200`.

Nobody upstream would hit this — Lantern's own app uses the HTTP proxy, where the CONNECT line
carries the name. The SOCKS listener is the one MLM VPN needs, because sing-box hands it domains.

### 3. `embeddedconfig/embedded.go` — drop `GlobalReplicaOptions`

It was the only thing importing `getlantern/replica`, which drags in
`anacrolix/torrent` → `anacrolix/squirrel` → `go-llsqlite/crawshaw`, a **cgo** SQLite binding. With
no C toolchain it fails to compile outright (`undefined: SQLITE_RANGE`). Replica is Lantern's
peer-to-peer file sharing: this build does not use it and must not run it. Removing the var also
makes the `globalConfig` import unused — remove that too.

### 4. `cmd/lanternproxy/main.go` — `sayTracker`

Not required to build, required for the panel. `stats.Tracker` already receives the two facts worth
showing and tells nobody: `SetActiveProxyLocation` lands the exit's city/country whenever a different
proxy starts carrying, and `Stats.HasSucceedingProxy` says whether any proxy works at all.
`sayTracker` prints them, deduplicated, as `[lantern]` lines.

## The contract `lantern-manager.js` reads

Four line shapes on stdout, and nothing else is parsed — flashlight's own logger writes thousands of
`DEBUG` lines per connect, including one per retry of its (blocked) DoH resolver:

```
[lantern] starting · socks=127.0.0.1:20840 http=127.0.0.1:20841 dir=…
[lantern] exit Frankfurt|Germany|DE
[lantern] proxy ok
[lantern] listening
```

Flags: `-socks`, `-http`, `-configdir`, `-deviceid`, `-proxyall`.

## What the manager must never trust

**`listening` is not connected, and neither is a successful SOCKS reply.** `HandleConnect` calls
`replySuccess` *before* it dials the origin, so every CONNECT is answered "success" whether or not a
proxy exists — a handshake-only probe reported "connected" in 13.5 s with no working proxy. The proof
is a full TLS handshake to a DNS-poisoned host; see `socksCarriesStream`.

**A slow start is not a failure.** The proxy-list fetch backs off 20 s → 40 → 80 on timeout, and one
measured cold start carried nothing for 214 s and then worked. The manager keeps the engine up and
re-probes every 10 s for four minutes (`watchDataPath`).

## Measurements from an Iranian line, 2026-09-13

| | |
|---|---|
| cold start → proven data path | 15 s |
| warm start | a few seconds |
| 10 MB download, warm | **18.2 Mbit/s** (2.28 MB/s) |
| 10 MB download, cold (still ranking proxies) | 3.0 Mbit/s |
| exits seen | Frankfurt, Amsterdam |
| worst cold start observed | 214 s of nothing, then working |

One more thing the core does on its own, worth knowing: it defaults its detour country to **IR**
until geolookup answers (`flashlight.go`, in `Run`), and its embedded config force-directs `.ir`
domains. So Iranian sites stay off the tunnel without anything being configured here.
