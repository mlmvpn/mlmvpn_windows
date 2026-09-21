/*
 * Games the user adds themselves.
 *
 * WHAT THIS GUARDS
 * The catalogue ships 196 games and will never ship the one a particular person plays. A custom
 * entry is one thing — a name attached to an executable — and it has to survive a round trip that
 * touches three separate lookups: `byProcess` (how a running game is recognised at all), `byId`
 * (how a selection survives a trip to the server and back) and `publicCatalog` (what the panel
 * lists). Miss any one and the feature half-works in a way that is hard to see: a game that can be
 * added and never selected, or selected and never recognised.
 *
 * THE ONE THAT IS EASY TO GET WRONG
 * A custom entry must NOT claim things nobody measured. The catalogue records `klass`, `probe`,
 * ports and anti-cheat because somebody probed them; for a game added this morning, nobody has.
 * `probe: 'anchors'` and `klass: 'unknown'` are pinned here because the tempting alternative —
 * guessing 'client-server' because most games are — would put a sentence in front of the user
 * that reads like a finding and is not one.
 *
 * Writes one temp file and deletes it. No processes, no PowerShell, no network.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const cg = require(ROOT + '/game/customgames');
const catalog = require(ROOT + '/game/catalog');

const TMP = path.join(os.tmpdir(), `mlmvpn-customgames-${process.pid}.json`);
cg.useFileForTests(TMP);

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ── the shape of an entry ────────────────────────────────────────────────────────
{
    const g = cg.build({ fa: 'بازی من', procs: ['MyGame.exe'] });
    t('an entry carries the name and the executable', g.fa === 'بازی من' && g.procs[0] === 'MyGame.exe');
    t('its id is prefixed, so it can never collide with a catalogue id', g.id.startsWith('custom:'));
    t('probe is `anchors` — nothing in an unmeasured game answers a query we know', g.probe === 'anchors');
    t('klass is `unknown`, not a plausible guess', g.klass === 'unknown', g.klass);
    t('no anti-cheat is claimed for a game nobody measured', g.anticheat === null);
    t('it says in its own note that the user added it', /خودتان اضافه/.test(g.note || ''));
}

// ── what it refuses, and why each refusal matters ────────────────────────────────
{
    t('a name is required', /اسم/.test(threw(() => cg.build({ fa: '', procs: ['a.exe'] })) || ''));
    t('an executable is required', /اجرایی/.test(threw(() => cg.build({ fa: 'x', procs: [] })) || ''));
    t('Windows itself is refused — pointing the booster at svchost helps nobody',
        /سیستمی|موتور/.test(threw(() => cg.build({ fa: 'x', procs: ['svchost.exe'] })) || ''));
    t('this app is refused', /سیستمی|موتور/.test(threw(() => cg.build({ fa: 'x', procs: ['MLM VPN.exe'] })) || ''));
    // The engines are the interesting case: naming one as "the game" would make the booster raise
    // it and skip it in line-freeing — harmless in itself, but the real game would never be
    // recognised and the user would read that as the feature not working.
    t('an engine of ours is refused (geph5-client)',
        /سیستمی|موتور/.test(threw(() => cg.build({ fa: 'x', procs: ['geph5-client.exe'] })) || ''));
    t('…and tor, which is only an engine because engine-processes.js says so',
        /سیستمی|موتور/.test(threw(() => cg.build({ fa: 'x', procs: ['tor.exe'] })) || ''));
}

// ── the executable is normalised the way Windows reports it ──────────────────────
{
    t('a bare name gains .exe', cg.normExe('MyGame') === 'MyGame.exe');
    t('a full path is reduced to the file name', cg.normExe('C:\\Games\\X\\Fun.exe') === 'Fun.exe');
    t('a name Windows could not have is rejected', cg.normExe('bad|name.exe') === null);
    const g = cg.build({ fa: 'x', procs: ['A.exe', 'a.EXE', 'B.exe'] });
    t('the same executable twice is stored once, case-insensitively', g.procs.length === 2, g.procs.join());
}

// ── the round trip through the catalogue ─────────────────────────────────────────
{
    const before = catalog.byProcess('RoundTrip.exe');
    const added = cg.add({ fa: 'رفت و برگشت', procs: ['RoundTrip.exe'] });
    t('unknown before it is added', before === null);
    t('byProcess finds it, case-insensitively', (catalog.byProcess('roundtrip.exe') || {}).id === added.id);
    t('byId finds it — without this, a selection cannot survive a round trip to the server',
        (catalog.byId(added.id) || {}).fa === 'رفت و برگشت');
    const pc = catalog.publicCatalog();
    t('the panel lists it alongside the catalogue', pc.games.some(x => x.id === added.id));
    t('…flagged as the user\'s own, so it can be shown and removed as theirs',
        (pc.games.find(x => x.id === added.id) || {}).custom === true);

    t('adding the same executable twice is refused rather than silently duplicated',
        /از قبل/.test(threw(() => cg.add({ fa: 'دوباره', procs: ['RoundTrip.exe'] })) || ''));

    t('removing it works', cg.remove(added.id) === true);
    t('…and the catalogue forgets it immediately, not at the next restart',
        catalog.byProcess('RoundTrip.exe') === null);
    t('removing something that is not there says so', cg.remove('custom:nothing') === false);
}

// ── a custom entry outranks a built-in one ───────────────────────────────────────
{
    // GTA5.exe is in the catalogue. If a user says it is something else on THEIR machine, that is
    // a statement about their machine and it wins.
    const builtin = catalog.byProcess('GTA5.exe');
    const mine = cg.add({ fa: 'مال خودم', procs: ['GTA5.exe'] });
    t('a built-in mapping exists to be overridden', builtin && builtin.id === 'gta-online');
    t('the user\'s own entry wins over the catalogue\'s', (catalog.byProcess('GTA5.exe') || {}).id === mine.id);
    cg.remove(mine.id);
    t('…and the catalogue\'s comes back when the override is removed',
        (catalog.byProcess('GTA5.exe') || {}).id === 'gta-online');
}

try { fs.unlinkSync(TMP); } catch { /* already gone */ }

let failed = 0;
for (const x of results) {
    if (!x.ok) failed++;
    console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + (x.detail || '')}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
