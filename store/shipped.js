// --- What THIS build carries in core/ — the one table both the store and the resolver read ---
//
// A store install is only worth running when it is NEWER than what the app itself ships. That has
// to be decidable without executing anything on the connect path (core-paths.js runs there, inside
// Electron's main thread), so the shipped versions are written down here rather than probed.
//
// Written down is exactly how numbers go stale, so tests/store/shipped.test.js hashes every file
// named here and runs every core that HAS a version flag, and fails when this table disagrees with
// the disk. Three cores have no version flag at all (psiphon, geph, lantern); for those the digest
// is the only honest identity there is.
//
// Paths in `files` are relative to that core's own directory — the same layout a store install
// reproduces, so the resolver can swap one directory for the other.
//
// WHEN YOU REPLACE A FILE IN core/, CHANGE ITS ROW HERE IN THE SAME EDIT (the test will insist).
//
// Measured 2026-09-14.

'use strict';

const SHIPPED = {
    xray: {
        version: '26.7.28', dir: '',
        files: {
            'xray.exe': '1d9674327972a21afd4c906a7a72bb0856935aa9e0227c87f34f03d11a88bddf',
            'geoip.dat': '744c97b74c52bae2ac8664fef6ac481d7765cb8432a0df54f0368a88b9b4a354',
            'geosite.dat': 'adf92de0cfc70e458b399f04c5f912bf42d115ed7e37281b30e2f1c68605e4e9',
        },
    },
    singbox: {
        version: '1.14.0-alpha.47', dir: '',
        files: {
            'sing-box.exe': '4611cde867c8909d84854d7383c44081671e15c8b0f53967e0a0676264f67d7c',
            'wintun.dll': 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce',
        },
    },
    tor: {
        // The Expert Bundle's own number (Tor Browser's release line). tor.exe inside is 0.4.9.12
        // and lyrebird 0.8.1 — those are what the probes read.
        version: '15.0.22', dir: 'tor',
        files: {
            'tor.exe': '60c45b01938c799862e511a9a5bab12f959a819c6264a24502edc342165f570c',
            'pluggable_transports/lyrebird.exe': '6e218e85f9a7ae2481f5402ded822471a9a9d0c7e66b05db3842b93fa5c1f02e',
            'pluggable_transports/conjure-client.exe': '6d3bca367226caf0cd065ced8b031b482b5cd5c3889bce886f2e903197b9b43b',
            'pluggable_transports/pt_config.json': 'f265d04841079b4d439570c76662841022a1c2c70540b945d3801ad491a8be87',
            'data/geoip': '25a69c1dc1d946bfdb0b1ba628db36e9668c51639963c2ee2afda7dc857f66a5',
            'data/geoip6': '0a3b61ba326550d66a4c805563be25e28f1d59e5cdfc06b091bfdd9ea2c8f998',
        },
        probes: { 'tor.exe': '0.4.9.12', 'pluggable_transports/lyrebird.exe': '0.8.1' },
    },
    openvpn: {
        // Read from the binary itself: `openvpn.exe --version` says 2.6.22, built 2026-08-05 —
        // the same release the store pin points at, so an install from the store is a like-for-like
        // replacement rather than an upgrade.
        //
        // `wintun.dll` is listed here and is NOT in OpenVPN's own MSI: the engine needs it for
        // `--windows-driver wintun` and the copy this app already ships is used, which is why the
        // catalog carries it as a companion rather than as an extracted file.
        version: '2.6.22', dir: 'openvpn',
        files: {
            'openvpn.exe': '50abb4c0c450235e7414e7ffab1fadac9b2743e0b1be4ecaf6e5fd35ad6d3a21',
            'libcrypto-3-x64.dll': 'dd3f27b0aab3f78982bc6e871a77a58aa8bcbcc009873dd822b1ec4a05024a0f',
            'libssl-3-x64.dll': 'e05f72829416eec9574ede16983860ac397b301b3d2b05c7322c1da778c5aa96',
            'libpkcs11-helper-1.dll': '9374025d427704bc8706219da03c55539713e1b7764b0e9dc0c99ce78290e49f',
            'vcruntime140.dll': 'c51c64dfb7c445ecf0001f69c27e13299ddcfba0780efa72b866a7487b7491c7',
            'wintun.dll': 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce',
        },
    },
    psiphon: {
        version: '2.0.39', dir: '',
        files: { 'psiphon.exe': '59266601af49204cf10cb68cc0eb193bc5f8dbd5c7090f47fdaf466f2a3233bb' },
    },
    geph: {
        // The workspace version of the commit it was built from (master @ 2026-09-12, docs/GEPH-BUILD.md),
        // confirmed by the binary being byte-identical to that build. An earlier note said 0.2.36; that
        // number came from a release TAG, not from the source that produced this file.
        version: '0.3.10', dir: 'geph',
        files: { 'geph5-client.exe': '46de889683193a5491dab33209d1669b4d9713b31b47b997dffe4c26421f9779' },
    },
    lantern: {
        version: '7.6.239', dir: '',
        files: { 'lantern.exe': '2b55ec6eb9e0748e07b2a5ca8b8c4ca3b75f03d30abc2b09780630c966d1cc33' },
    },
    warp: {
        // 2026-09-20: the developer's OWN release build, byte for byte — `aether.exe` out of
        // CluvexStudio's `aether-windows-x86_64.zip` for v2.0.0, digest as GitHub computed it at
        // upload. Before this the file was our build of 1.9.0 with scan patches
        // (backup/aether-1.9.0-mlmvpn-patched.exe); it is now installed and updated straight from
        // the developer — store/direct.js, and the catalogue entry says why.
        version: '2.0.0', dir: '',
        files: { 'aether.exe': '056e49e304db97b721f5631d28b7e1429a8b598faf66e761f1ba8194d176b8cf' },
    },
    gst: {
        version: '1.9.36', dir: '',
        files: { 'gst.exe': 'ac7cec11b2b66d548be9502fe132454ef3be8909094acf27378736194631b147' },
    },
    tailscale: {
        version: '1.102.2', dir: 'tailscale',
        files: {
            'tailscaled.exe': 'dc1aa013ae85f2e31a2b680977e732e18cf9af31f03d18cf09480f0d48ee5699',
            'tailscale.exe': '9bce6da3e01fa74dfc2aeaed1577c2c3c8901bbdae8222027fa3876e3e09cef5',
            'wintun.dll': 'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce',
        },
    },
};

module.exports = { SHIPPED };
