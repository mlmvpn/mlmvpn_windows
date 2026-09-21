// core-paths.js decides which copy of an engine actually runs. It is on the connect path, and every
// rule here exists because getting it wrong means either running an old core silently or handing an
// elevated app a binary from a folder somebody else can write to.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-store-test-'));
process.env.MLMVPN_STORE_ROOT = ROOT;
delete process.env.MLMVPN_STORE_DISABLE;

const corePaths = require('../../core-paths');
const { SHIPPED } = require('../../store/shipped');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const BUNDLED = path.join(ROOT, 'bundled', 'xray.exe');
fs.mkdirSync(path.dirname(BUNDLED), { recursive: true });
fs.writeFileSync(BUNDLED, 'bundled core');

function install(version, { size = 12, dir = null } = {}) {
    const d = dir || path.join(ROOT, 'cores', 'xray', version);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'xray.exe'), 'x'.repeat(size));
    const active = { xray: { version, dir: d, files: { 'xray.exe': { size, sha256: 'x' } }, installedAt: new Date().toISOString() } };
    fs.writeFileSync(path.join(ROOT, 'active.json'), JSON.stringify(active));
    // mtime-keyed cache inside the resolver: make sure each write looks different
    fs.utimesSync(path.join(ROOT, 'active.json'), new Date(), new Date(Date.now() + results.length * 1000));
    return d;
}

// ── nothing installed: the app's own copy ────────────────────────────────────
t('with no store install, the bundled file is used', corePaths.file('xray', 'xray.exe', BUNDLED) === BUNDLED);
t('and there is no active version', corePaths.activeVersion('xray') === null);

// ── a newer install wins ─────────────────────────────────────────────────────
const dir999 = install('99.9.9');
t('a NEWER store install is used instead', corePaths.file('xray', 'xray.exe', BUNDLED) === path.join(dir999, 'xray.exe'));
t('and it names its version', corePaths.activeVersion('xray') === '99.9.9');

// ── an older one does not ────────────────────────────────────────────────────
// After an app upgrade ships a newer core, a store install from before it must be ignored — not
// silently keep shadowing the newer file.
install('0.0.1');
t('a store install OLDER than the shipped core is ignored', corePaths.file('xray', 'xray.exe', BUNDLED) === BUNDLED,
    'shipped is ' + SHIPPED.xray.version);

// ── a file that changed after it was verified ────────────────────────────────
const dirA = install('99.9.9', { size: 20 });
fs.writeFileSync(path.join(dirA, 'xray.exe'), 'tampered');   // different size from the record
t('a file whose size no longer matches the record is refused', corePaths.file('xray', 'xray.exe', BUNDLED) === BUNDLED);

// ── a record pointing outside the store ──────────────────────────────────────
// active.json is data. A record naming C:\Windows\Temp\evil.exe must not make the app run it.
const outside = path.join(ROOT, 'elsewhere');
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, 'xray.exe'), 'xxxxxxxxxxxx');
fs.writeFileSync(path.join(ROOT, 'active.json'), JSON.stringify({
    xray: { version: '99.9.9', dir: outside, files: { 'xray.exe': { size: 12 } } },
}));
fs.utimesSync(path.join(ROOT, 'active.json'), new Date(), new Date(Date.now() + 99000));
t('a record pointing outside the store folder is refused', corePaths.file('xray', 'xray.exe', BUNDLED) === BUNDLED);

// ── missing file ─────────────────────────────────────────────────────────────
const dirGone = install('99.9.9');
fs.unlinkSync(path.join(dirGone, 'xray.exe'));
t('a record whose file is gone falls back to the bundled copy', corePaths.file('xray', 'xray.exe', BUNDLED) === BUNDLED);

// ── the kill-switch list ─────────────────────────────────────────────────────
// An engine that was already running when a new version was activated is still executing the OLD
// file. A guard that allowed only the new path would lock the live tunnel out of the internet.
const dirNew = install('99.9.9');
const prev = path.join(ROOT, 'cores', 'xray', '99.9.8');
fs.mkdirSync(prev, { recursive: true });
fs.writeFileSync(path.join(prev, 'xray.exe'), 'xxxxxxxxxxxx');
const rec = JSON.parse(fs.readFileSync(path.join(ROOT, 'active.json'), 'utf8'));
rec.xray.previous = { version: '99.9.8', dir: prev, files: { 'xray.exe': { size: 12 } } };
fs.writeFileSync(path.join(ROOT, 'active.json'), JSON.stringify(rec));
fs.utimesSync(path.join(ROOT, 'active.json'), new Date(), new Date(Date.now() + 120000));
const cands = corePaths.candidates('xray', 'xray.exe', BUNDLED);
t('the allow-list carries the active copy first', cands[0] === path.join(dirNew, 'xray.exe'), cands.join(' | '));
t('the allow-list also carries the previous copy', cands.indexOf(path.join(prev, 'xray.exe')) > 0, cands.join(' | '));
t('the allow-list always ends with the bundled copy', cands[cands.length - 1] === BUNDLED, cands.join(' | '));

// ── the escape hatch ─────────────────────────────────────────────────────────
process.env.MLMVPN_STORE_DISABLE = '1';
t('MLMVPN_STORE_DISABLE=1 ignores the store entirely', corePaths.file('xray', 'xray.exe', BUNDLED) === BUNDLED);
delete process.env.MLMVPN_STORE_DISABLE;

fs.rmSync(ROOT, { recursive: true, force: true });

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
