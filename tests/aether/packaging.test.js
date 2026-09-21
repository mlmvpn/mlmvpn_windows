// Does the thing we SHIP contain the files it needs to run?
//
// This suite exists because the answer was no, and nothing anywhere would have said so.
// `build.files` in package.json is an explicit allow-list of root modules; a new file is only
// shipped if someone remembers to add it. Three had been missed:
//
//   tls-fingerprint.js   required at the TOP LEVEL of both server.js and xray-manager.js,
//                        so a clean build produced an app that could not start at all —
//                        MODULE_NOT_FOUND before the window is ever created.
//   aether-speedtest.js  required at the top level of aether-manager.js: the entire Aether
//                        feature would fail to load.
//   leak-audit.js        required by the /api/leak-audit route, so the leak checker 500s.
//
// The reason this was invisible in testing is that dist/win-unpacked is kept up to date by
// dev-sync.js, which copies whatever it is given regardless of build.files. Running from the
// dev tree and running from a fresh `npm run build` are therefore NOT the same app, and only
// the second one is what users get.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const path = require('path');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const patterns = pkg.build.files.filter(f => !f.startsWith('!'));
const listedRoot = new Set(patterns.filter(f => f.endsWith('.js') && !f.includes('/')));
const globDirs = patterns.filter(f => f.includes('/**')).map(f => f.split('/')[0]);

// Every `require('./x')` reachable from a packaged root module must itself be packaged.
function depsOf(file) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch (e) { return []; }
    const out = [];
    const re = /require\((['"])\.\/([A-Za-z0-9._/-]+)\1\)/g;
    let m;
    while ((m = re.exec(src))) out.push({ dep: m[2], top: isTopLevel(src, m.index) });
    return out;
}

// A require inside a function body fails only when that path runs; a top-level one takes the
// whole module — and with it the app — down at startup. Worth distinguishing in the report.
function isTopLevel(src, index) {
    const before = src.slice(0, index);
    let depth = 0;
    for (const ch of before) { if (ch === '{') depth++; else if (ch === '}') depth--; }
    return depth === 0;
}

const missing = [];
const missingTop = [];
for (const file of listedRoot) {
    for (const { dep, top } of depsOf(file)) {
        if (dep.includes('/')) {
            if (globDirs.includes(dep.split('/')[0])) continue;
            continue;   // nested paths are covered by their own directory globs
        }
        const base = dep.endsWith('.js') ? dep : dep + '.js';
        if (listedRoot.has(base)) continue;
        if (!fs.existsSync(path.join(ROOT, base))) continue;  // not ours to ship
        missing.push(`${base} (required by ${file})`);
        if (top) missingTop.push(`${base} (top-level in ${file})`);
    }
}

t('every module required by a packaged file is itself packaged',
    missing.length === 0, missing.join('; '));
t('no packaged module has a TOP-LEVEL require on something that will not ship',
    missingTop.length === 0, missingTop.join('; '));

// The modules this audit touched, named explicitly so a future reshuffle of build.files
// cannot drop one quietly.
for (const f of ['aether-manager.js', 'aether-guard.js', 'aether-dns-bridge.js', 'aether-speedtest.js',
                 'tun-manager.js', 'tun-routes.js', 'dns-manager.js', 'leak-audit.js',
                 'tls-fingerprint.js', 'main.js', 'server.js']) {
    t(`${f} is in build.files`, listedRoot.has(f));
}

// The binaries the tunnel cannot run without. core/** is unpacked from the asar because a
// native binary cannot be executed from inside an archive.
const unpack = pkg.build.asarUnpack || [];
t('core/** is unpacked from the asar, or the binaries cannot be executed',
    unpack.some(p => p.startsWith('core/')), JSON.stringify(unpack));
for (const bin of ['aether.exe', 'sing-box.exe', 'wintun.dll']) {
    t(`core/${bin} exists in the source tree`, fs.existsSync(path.join(ROOT, 'core', bin)));
}

// Both the TUN adapter and the firewall changes require elevation. Without this the app
// starts, shows a green UI, and every privileged operation fails with an opaque error —
// which is exactly how "Access is denied" got as far as a tunnel reported as running.
t('the app requests Administrator, which the TUN adapter and the firewall guard both need',
    pkg.build.win.requestedExecutionLevel === 'requireAdministrator',
    String(pkg.build.win.requestedExecutionLevel));

// Every file the page itself loads has to ship too. The desktop, dock, windows and page kit
// (public/shell, public/ui) were loaded by index.html for a whole redesign while the build list
// never named them — the portable folder had them only because it is synced by hand, and a fresh
// installer would have opened on a page with half of its scripts missing.
{
    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const refs = [...html.matchAll(/\b(?:src|href)="([^"#:?]+)(?:\?[^"]*)?"/g)]
        .map((m) => m[1])
        .filter((r) => /\.(js|css|png|svg|ico|woff2?|ttf|json)$/i.test(r));
    const covered = (rel) => {
        const file = 'public/' + rel.replace(/^\.?\//, '');
        return patterns.some((p) => {
            if (p === file) return true;
            if (p.endsWith('/**/*')) return file.startsWith(p.slice(0, -4));
            return false;
        });
    };
    const notShipped = [...new Set(refs.filter((r) => !covered(r)))];
    t('every file index.html loads is in the build\'s file list', notShipped.length === 0, notShipped.join(', '));
}

t('a test script is wired up so this suite runs', typeof pkg.scripts.test === 'string'
    && pkg.scripts.test.includes('tests/aether/run.js'));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
