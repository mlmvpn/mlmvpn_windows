// --- «ام‌ال‌ام استور» — everything the store knows how to update, and what it trusts for each ---
//
// Presentation (icons, blurbs, the App Store dressing) lives in public/components/store.js. This
// file is FACTS and BEHAVIOUR only: where an item's files are, how to ask it its version, how to
// prove a new copy works before it is used, how to recognise a deployed worker, and — for each item
// — the one version this build vouches for, with the digest that proves a download is that version.
//
// «پین‌شده، نه آخرین» — PINNED, NOT LATEST. The managers in this project read exact flags and log
// lines (lantern's stdout shapes, tor's bootstrap phases, geph's config that rejects unknown keys,
// Xray >= 26.7.28 for the TLS fragment profile). A version is pinned here only after it was checked
// against how this app drives it. Newer-than-pinned is shown as information and never installed.
//
// The signed channel (store/channel.js) can pin a newer version without a new app build; what it
// cannot do is change anything in this file's behaviour — only versions, URLs and digests.
//
// Every `sha256` below was measured on 2026-09-14 and, where the project publishes one, matched
// against the project's own: Xray's .dgst, GitHub's upload digest, a commit-pinned raw file.

'use strict';

const path = require('path');

// ── cores ────────────────────────────────────────────────────────────────────

const CORES = [
    {
        id: 'xray', kind: 'core', group: 'cores',
        title: 'هستهٔ V2Ray (Xray)',
        usedBy: 'V2Ray، کانفیگ رایگان، کانفیگ ایران، زیرساخت ابری، ماسک و وارپ',
        upstream: { type: 'github', repo: 'XTLS/Xray-core' },
        bundledDir: '',
        // Xray looks for geoip.dat/geosite.dat next to its own executable, so they travel with it.
        files: ['xray.exe', 'geoip.dat', 'geosite.dat'],
        probe: { file: 'xray.exe', args: ['-version'], re: /Xray\s+([0-9][0-9.]*)/ },
        validate: 'xray-config',
        floor: '26.7.28',   // the TLS fragment + fingerprint profile needs this release or newer
        pin: {
            version: '26.9.9', released: '2026-09-08',
            notes: 'دو انتشار تازه‌تر از نسخهٔ همراه برنامه (۲۶.۹.۸ و ۲۶.۹.۹). داده‌های مسیریابی geoip و geosite هم همراهش تازه می‌شوند.',
            artifacts: [{
                name: 'Xray-windows-64.zip', format: 'zip', size: 21203133,
                sha256: '244deaba2098c2964e49bba90df3707777e5f5f428a82d2f29604015f24beec2',
                urls: ['https://github.com/XTLS/Xray-core/releases/download/v26.9.9/Xray-windows-64.zip'],
                extract: { 'xray.exe': 'xray.exe', 'geoip.dat': 'geoip.dat', 'geosite.dat': 'geosite.dat' },
            }],
        },
    },
    {
        id: 'singbox', kind: 'core', group: 'cores',
        title: 'هستهٔ تونل (sing-box)',
        usedBy: 'تونل کامل همهٔ موتورها و مسیریابی برنامه‌ها',
        upstream: { type: 'github', repo: 'SagerNet/sing-box' },
        bundledDir: '',
        files: ['sing-box.exe', 'libcronet.dll', 'wintun.dll'],
        // sing-box loads wintun.dll from its own directory to build the adapter, and its release zip
        // does not carry one. The copy the app ships is Wintun 0.14.1 — still the newest — and it is
        // taken only if it is byte-for-byte that file.
        companions: [{ rel: 'wintun.dll', from: 'wintun.dll', sha256: 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce' }],
        probe: { file: 'sing-box.exe', args: ['version'], re: /sing-box\s+version\s+(\S+)/ },
        validate: 'singbox-config',
        pin: {
            version: '1.14.0', released: '2026-08-31',
            notes: 'نسخهٔ نصب‌شده آلفای همین شماره است (1.14.0-alpha.47). این بروزرسانی یعنی رفتن به همان نسخه، این بار پایدار.',
            artifacts: [{
                name: 'sing-box-1.14.0-windows-amd64.zip', format: 'zip', size: 32809391,
                sha256: '3ffb56267da14e287be48bd10cf7e6505260125bad940b75101fbb4d5d58e5d6',
                urls: ['https://github.com/SagerNet/sing-box/releases/download/v1.14.0/sing-box-1.14.0-windows-amd64.zip'],
                extract: { 'sing-box.exe': 'sing-box.exe', 'libcronet.dll': 'libcronet.dll' },
            }],
        },
    },
    {
        id: 'tor', kind: 'core', group: 'cores',
        title: 'هستهٔ تور',
        usedBy: 'تور، با obfs4، وب‌تانل، اسنوفلیک و کانجور',
        // The Expert Bundle is published on the Tor Project's own host, which is blocked from Iran —
        // the channel carries a mirror URL beside the original, and the digest decides either way.
        upstream: { type: 'web', url: 'https://dist.torproject.org/torbrowser/' },
        bundledDir: 'tor',
        files: ['tor.exe', 'pluggable_transports/lyrebird.exe', 'pluggable_transports/conjure-client.exe',
            'pluggable_transports/pt_config.json', 'data/geoip', 'data/geoip6'],
        probe: { file: 'tor.exe', args: ['--version'], re: /Tor\s+version\s+([0-9][0-9.]*)/ },
        probes: [{ file: 'pluggable_transports/lyrebird.exe', args: ['-version'], re: /lyrebird\s+([0-9][0-9.]*)/ }],
        versionIsBundle: true,   // the item's version is the bundle's; tor.exe reports its own number
        validate: 'probe',
        pin: null,
    },
    {
        id: 'openvpn', kind: 'core', group: 'cores',
        title: 'هستهٔ OpenVPN',
        usedBy: 'اوپن‌وی‌پی‌ان',
        // Community Windows builds are published only as an MSI on the project's own host, so
        // the artifact is extracted with an administrative install (msiexec /a) rather than
        // unzipped. `wintun.dll` is NOT in that MSI — the engine needs it for
        // `--windows-driver wintun`, and the copy this app already ships is taken instead,
        // byte-for-byte, the same way sing-box takes it.
        upstream: { type: 'web', url: 'https://build.openvpn.net/downloads/releases/' },
        bundledDir: 'openvpn',
        files: ['openvpn.exe', 'libcrypto-3-x64.dll', 'libssl-3-x64.dll',
            'libpkcs11-helper-1.dll', 'vcruntime140.dll', 'wintun.dll'],
        companions: [{ rel: 'wintun.dll', from: 'wintun.dll', sha256: 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce' }],
        probe: { file: 'openvpn.exe', args: ['--version'], re: /OpenVPN\s+([0-9][0-9.]*)/ },
        validate: 'probe',
        // 2.6.22, downloaded from the official release index and checked here: it dialled a
        // VPN Gate relay to "Initialization Sequence Completed" in 4.3 s over --dev null.
        pin: {
            version: '2.6.22', released: '2026-08-05',
            notes: 'شاخهٔ پایدار ۲.۶. با همین نسخه اتصال واقعی آزمایش و تأیید شد.',
            artifacts: [{
                name: 'OpenVPN-2.6.22-I001-amd64.msi', format: 'msi', size: 5902336,
                sha256: '1e1bb9a712990d1b2b961de7e8df3384964e4fb6f6776a100840f0d9a82ed507',
                urls: ['https://build.openvpn.net/downloads/releases/OpenVPN-2.6.22-I001-amd64.msi'],
                // KEY IS THE PATH INSIDE THE PACKAGE, VALUE IS WHERE IT LANDS — and this entry
                // had the two the wrong way round. `extractArtifact` copies
                // `locate(want)` to `staging/<destRel>`, so the swapped map would have installed
                // the whole engine into `core/openvpn/OpenVPN/bin/`: the probe runs
                // `openvpn.exe --version` at the top of the core's own directory, would have
                // found nothing there, and every store install of this core would have failed
                // validation. The other cores hid it because their archives are flat, so key and
                // value are the same word.
                extract: {
                    'OpenVPN/bin/openvpn.exe': 'openvpn.exe',
                    'OpenVPN/bin/libcrypto-3-x64.dll': 'libcrypto-3-x64.dll',
                    'OpenVPN/bin/libssl-3-x64.dll': 'libssl-3-x64.dll',
                    'OpenVPN/bin/libpkcs11-helper-1.dll': 'libpkcs11-helper-1.dll',
                    'OpenVPN/bin/vcruntime140.dll': 'vcruntime140.dll',
                },
            }],
        },
    },
    {
        id: 'psiphon', kind: 'core', group: 'cores',
        title: 'هستهٔ سایفون',
        usedBy: 'سایفون',
        // No Windows build is published upstream (their releases carry Android/iOS libraries only),
        // so this core is built from the tagged source and served from MLM VPN's own release — the
        // channel's signature is what vouches for it.
        upstream: { type: 'github', repo: 'Psiphon-Labs/psiphon-tunnel-core', builtBy: 'mlm' },
        bundledDir: '',
        files: ['psiphon.exe'],
        probe: { file: 'psiphon.exe', args: ['-version'], re: /Revision:\s*v?([0-9][0-9.]*)/ },
        validate: 'probe-optional',
        // NO capability keys here, and that is a correction: `FrontedMeekDialOverrides` and
        // `InproxyRejectProxyCountryCodes` exist in NEITHER v2.0.41 NOR master of the official source
        // (checked 2026-09-14). The build that has them is a fork's, so listing them would make every
        // honest upstream build report "missing keys" for ever.
        pin: null,
    },
    {
        id: 'geph', kind: 'core', group: 'cores',
        title: 'هستهٔ گف',
        usedBy: 'گف',
        upstream: { type: 'github', repo: 'geph-official/geph5', tagRe: '^geph5-client-v(.+)$', builtBy: 'mlm' },
        bundledDir: 'geph',
        files: ['geph5-client.exe'],
        probe: null,
        validate: 'geph-config',
        pin: null,
    },
    {
        id: 'lantern', kind: 'core', group: 'cores',
        title: 'هستهٔ لنترن',
        usedBy: 'لنترن',
        upstream: { type: 'github', repo: 'getlantern/flashlight', builtBy: 'mlm' },
        bundledDir: '',
        files: ['lantern.exe'],
        probe: null,
        validate: 'none',
        pin: null,
    },
    {
        id: 'warp', kind: 'core', group: 'cores',
        title: 'هستهٔ وارپ (ماسک، وایرگارد، وارپ در وارپ)',
        // «وارپ» is on this list because it IS this binary: wg with Cloudflare's own endpoint
        // pinned, not a separate engine. Leaving it out would make the store look like it had
        // missed an engine, which is worse than the honest answer.
        usedBy: 'وارپ، ماسک، وایرگارد و وارپ در وارپ',
        // The project is CluvexStudio's AND SO IS THE BINARY. Their CI publishes
        // `aether-windows-x86_64.zip` for every release — the same archive this app ships, engine
        // and pluggable transports together — so this core is installed straight from the
        // developer's own release rather than rebuilt and re-signed by us. `upstream.direct` is
        // what says so; store/direct.js explains what that costs and what is still verified.
        //
        // Until 2026-09-20 the shipped file was OUR build of 1.9.0 with scan patches on top. It is
        // now the developer's untouched 2.0.0, which carries its own answer to what those patches
        // were for — the `ironclad` scan mode verifies a candidate with a real HTTP round trip
        // through the tunnel, and the app asks for it by name, no core change needed.
        upstream: {
            type: 'github',
            repo: 'CluvexStudio/Aether',
            direct: {
                asset: 'aether-windows-x86_64.zip',
                format: 'zip',
                // {inside the archive: where it lands} — and that direction is easy to get
                // backwards; openvpn shipped reversed for exactly this reason.
                //
                // The archive holds three things and only one of them is taken. `run-aether.bat`
                // is for someone running the engine by hand. `pt/lyrebird.exe` is tor's pluggable
                // transport, 17 MB, and it is reached only through AETHER_TOR_PT — which this app
                // never sets, because «تور» here is its own engine with its own lyrebird. Leaving
                // it out changes nothing about aether.exe, which is what «unmodified» is about;
                // carrying it would add 17 MB to every install for a path with no way in. If
                // aether's own tor mode is ever exposed, add it back here and in `files`.
                extract: { 'aether.exe': 'aether.exe' },
                notes: 'ساخت رسمی خودِ سازنده، بدون هیچ تغییری — همان فایلی که در گیت‌هاب منتشر کرده است.',
            },
        },
        bundledDir: '',
        files: ['aether.exe'],
        probe: { file: 'aether.exe', args: ['--version'], re: /aether\s+([0-9][0-9.]*)/ },
        validate: 'probe',
        pin: null,
    },
    {
        id: 'gst', kind: 'core', group: 'cores',
        title: 'هستهٔ تونل گوگل اسکریپت',
        usedBy: 'تونل گوگل اسکریپت',
        upstream: { type: 'local', builtBy: 'mlm' },
        bundledDir: '',
        files: ['gst.exe'],
        probe: { file: 'gst.exe', args: ['--version'], re: /mhrv-rs\s+([0-9][0-9.]*)/ },
        validate: 'probe',
        pin: null,
    },
    {
        id: 'tailscale', kind: 'core', group: 'cores',
        title: 'هستهٔ تونل گیت‌هاب',
        usedBy: 'تونل گیت‌هاب',
        upstream: { type: 'web', url: 'https://pkgs.tailscale.com/stable/' },
        bundledDir: 'tailscale',
        files: ['tailscaled.exe', 'tailscale.exe', 'wintun.dll'],
        probe: { file: 'tailscale.exe', args: ['version'], re: /^\s*([0-9][0-9.]*)/ },
        validate: 'probe',
        pin: null,
    },
];

// ── workers ──────────────────────────────────────────────────────────────────
//
// A worker is not a file on this machine: it is code on the user's OWN Cloudflare account. The store
// recognises one only by what its code says — names are randomised at deploy time — and it touches
// only what it positively recognises. An account also holds the user's own workers and, for the
// maintainer, the project's backend; neither is ever matched by anything below.
//
// Updating replaces the CODE and nothing else (Cloudflare's "put content" call): bindings, secrets,
// the KV/D1 data, routes and the compatibility settings all stay exactly as they were.

const has = (text, ...needles) => needles.every((n) => text.indexOf(n) >= 0);

const WORKERS = [
    {
        id: 'bpb', kind: 'worker', group: 'workers', managedBy: 'windows',
        title: 'پنل BPB',
        upstream: { type: 'github', repo: 'bia-pain-bache/BPB-Worker-Panel' },
        detect: (t) => has(t, 'EMBEDED_SETTINGS', 'panelVersion:"'),
        versionOf: (t) => (t.match(/panelVersion:"([0-9][^"]*)"/) || [])[1] || null,
        bundled: { file: 'public/worker.js', version: '5.1.1' },
        // v5 reads its install values from a prefix compiled INTO the script. It is carried from the
        // deployed copy to the new one; without it the panel refuses to start.
        transform: 'bpb-embedded-settings',
        minUpdatable: '5.0.0',   // v4 used secrets v5 rejects — that is a fresh deploy, not an update
        pin: null,
    },
    {
        id: 'zeus', kind: 'worker', group: 'workers', managedBy: 'windows',
        title: 'پنل Zeus',
        upstream: { type: 'github', repo: 'panel-zeus/Z-E-U-S' },
        detect: (t) => has(t, 'PANEL_ZEUS', 'CURRENT_VERSION'),
        versionOf: (t) => (t.match(/CURRENT_VERSION\s*=\s*['"]([0-9][0-9.]*)['"]/) || [])[1] || null,
        bundled: { file: 'public/zeus.js', version: '1.11.8' },
        // 2.2.0 was checked against how this app drives Zeus: the same /api routes, the same
        // panel_session = sha256(password) cookie, the same /sub/<user> endpoint, no node: imports,
        // and its own self-update deploys with the same compatibility settings as 1.11.8.
        pin: {
            version: '2.2.0', released: '2026-09-11',
            notes: 'همهٔ مسیرهایی که برنامه از پنل می‌خواند — کاربران، آی‌پی پروکسی، ساب و ورود — در این نسخه همان‌اند؛ دیتابیس کاربران دست نمی‌خورد.',
            artifacts: [{
                name: 'Source.js', format: 'raw', size: 634366,
                sha256: '0d8080f6f5f9b920ccb9e781983ce8f444d583614cb42dc5cd31037e68564b6a',
                urls: ['https://raw.githubusercontent.com/panel-zeus/Z-E-U-S/871a965817be812a470cd5d94b7fe5492a633b7f/Source.js'],
            }],
        },
    },
    {
        id: 'edge', kind: 'worker', group: 'workers', managedBy: 'windows',
        title: 'پروکسی Edge',
        upstream: { type: 'github', repo: 'cmliu/edgetunnel' },
        detect: (t) => /const Version = '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}'/.test(t) && has(t, 'config_JSON'),
        versionOf: (t) => (t.match(/const Version = '(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})'/) || [])[1] || null,
        bundled: { file: 'public/edgeworker.js', version: '2026-08-11 14:45:22' },
        // Upstream's file starts with a UTF-8 byte-order mark; it is removed before upload so the
        // deployed module is plain.
        stripBom: true,
        pin: {
            version: '2026-09-04 16:24:13', released: '2026-09-04',
            notes: 'همان متغیرها و همان تنظیمات سازگاری نسخهٔ فعلی — فقط کد عوض می‌شود.',
            artifacts: [{
                name: '_worker.js', format: 'raw', size: 321534,
                sha256: 'f4deaac96bb6ab5bcdd1b27b20bfce7c51d0210caf4c4620ee291f57b5b83fc7',
                urls: ['https://raw.githubusercontent.com/cmliu/edgetunnel/448a83ced00a43c1d892d5ecbed86a26ea9eeaff/_worker.js'],
            }],
        },
    },
    {
        id: 'dns', kind: 'worker', group: 'workers', managedBy: 'windows',
        title: 'DNS اختصاصی — مکان‌یابی',
        upstream: { type: 'local' },
        detect: (t) => has(t, 'WORKER_VERSION', 'mlmvpn-dns'),
        versionOf: (t) => Number((t.match(/const WORKER_VERSION\s*=\s*(\d+)/) || [])[1]) || null,
        bundled: { file: 'public/dns_worker.js', version: 2 },
        pin: null,
    },
    {
        id: 'doh', kind: 'worker', group: 'workers', managedBy: 'windows',
        title: 'DNS اختصاصی — سرعت',
        upstream: { type: 'local' },
        detect: (t) => has(t, 'DOH_PROVIDERS', 'handleDohQuery'),
        versionOf: (t) => Number((t.match(/const WORKER_VERSION\s*=\s*(\d+)/) || [])[1]) || null,
        // Deployed before the version line existed; byte-identical to build 1.
        knownHashes: { 'c6d859d1578dc0168b5529668bac3b451f9a673073975830e1039a8eda45d7cc': 1 },
        bundled: { file: 'public/doh_worker.js', version: 1 },
        pin: null,
    },
    {
        id: 'gst-relay', kind: 'worker', group: 'workers', managedBy: 'windows',
        title: 'رلهٔ کلودفلر تونل گوگل اسکریپت',
        upstream: { type: 'local' },
        detect: (t) => has(t, 'GST Relay Worker', 'relayOne'),
        versionOf: (t) => Number((t.match(/const WORKER_VERSION\s*=\s*(\d+)/) || [])[1]) || null,
        knownHashes: { '291ebd1322364c3d050ad91d79134828d38edef8713f1f7a70b4cc02a8bf1ca1': 1 },
        bundled: { file: 'public/gst/relay_worker.js', version: 1 },
        pin: null,
    },
    {
        id: 'gt-broker', kind: 'worker', group: 'workers', managedBy: 'windows',
        title: 'سرویس کلید تونل گیت‌هاب',
        upstream: { type: 'local' },
        detect: (t) => has(t, 'TS_OAUTH_CLIENT_ID', 'GitHub Tunnel'),
        versionOf: (t) => Number((t.match(/const WORKER_VERSION\s*=\s*(\d+)/) || [])[1]) || null,
        // The signature-checking build, deployed before the version line; an older copy that never
        // checked signatures has neither this digest nor the line, and reads as version 0.
        knownHashes: { 'fc412f3eec08e9c796783611338823ef7d573ee038663b02f54aa1f01389af76': 2 },
        legacyVersion: 1,
        bundled: { file: 'cloudflare-worker/gt-broker/worker.js', version: 2 },
        pin: null,
    },

    // Deployed by the ANDROID app. Recognised so the account's picture is complete and nothing of
    // the user's is described as unknown — but updated from the phone, which tracks their builds,
    // migrations and bootstrap secrets itself (Config Studio refuses to go backwards on purpose).
    {
        id: 'mlm-panel', kind: 'worker', group: 'workers', managedBy: 'android',
        title: 'پنل MLM (کانفیگ استدیو)',
        detect: (t) => has(t, 'STUDIO_API_VERSION', 'STUDIO_ROUTE'),
        versionOf: (t) => Number((t.match(/STUDIO_API_VERSION\s*=\s*(\d+)/) || [])[1]) || null,
    },
    {
        id: 'nahan', kind: 'worker', group: 'workers', managedBy: 'android',
        title: 'پنل نهان',
        detect: (t) => has(t, 'Project Nahan', 'CURRENT_VERSION'),
        versionOf: (t) => (t.match(/CURRENT_VERSION = "([0-9][0-9.]*)"/) || [])[1] || null,
    },
    {
        id: 'vpngate-relay', kind: 'worker', group: 'workers', managedBy: 'android',
        title: 'رلهٔ فهرست VPN Gate',
        detect: (t) => has(t, 'The VPN Gate server list, relayed through the user'),
        versionOf: () => null,
    },
    {
        id: 'sub-generator', kind: 'worker', group: 'workers', managedBy: 'android',
        title: 'سازندهٔ لینک ساب',
        detect: (t) => has(t, '/_health', 'sub_${slug}'),
        versionOf: (t) => (t.match(/version:\s*"([0-9][0-9.]*)"/) || [])[1] || null,
    },
];

// ── the rest ─────────────────────────────────────────────────────────────────

const OTHERS = [
    {
        id: 'vodi', kind: 'railway', group: 'workers',
        title: 'railway',
        upstream: { type: 'github', repo: 'Vodiwalker/vodiwalker_panel' },
    },
    {
        id: 'mlmvpn', kind: 'app', group: 'app',
        title: 'MLM VPN',
        upstream: { type: 'github', repo: 'mlmvpn/mlmvpn_windows' },
    },
];

const ITEMS = [...CORES, ...WORKERS, ...OTHERS];
/**
 * Things that are not programs: files the app ships and can take a newer copy of.
 *
 * «کانفیگ ایران» is the first: @patterniha's Serverless-for-Iran publishes no releases and no
 * versions — two `.jsonc` files that change by commit — so this item is compared by DIGEST, and
 * what is installed is what the app rebuilds from them (store/iran-configs.js).
 */
const DATA = [
    {
        id: 'iran-configs', kind: 'data', group: 'data',
        title: 'کانفیگ‌های ایران (سرورلس)',
        usedBy: 'کانفیگ ایران',
        upstream: {
            type: 'github-files', repo: 'patterniha/Serverless-for-Iran', branch: 'main',
            files: ['Serverless-fragA.jsonc', 'Serverless-fragB.jsonc'], builtBy: 'mlm',
        },
    },
    {
        id: 'mitm-config', kind: 'data', group: 'data',
        title: 'کانفیگ دامین فرانتینگ',
        usedBy: 'دامین فرانتینگ',
        upstream: {
            type: 'github-files', repo: 'patterniha/MITM-DomainFronting', branch: 'main',
            files: ['Xray-config/MITM-DomainFronting.json'], builtBy: 'mlm',
        },
    },
];

const BY_ID = Object.fromEntries(ITEMS.concat(DATA).map((x) => [x.id, x]));

/** Absolute path of a file bundled with the app (worker sources live beside server.js). */
function appFile(rel) {
    return path.join(__dirname, '..', rel);
}

module.exports = { ITEMS, BY_ID, CORES, WORKERS, OTHERS, DATA, appFile };
