/*
 * Catalogue integrity.
 *
 * The catalogue is 196 hand-written rows, and every one of them feeds something that has
 * to be right: a process name decides which game the panel says is running, an id ends up
 * inside a stored profile key, a region points at the anchors a measurement will use. A
 * typo in any of those does not throw — it quietly mislabels a game or measures the wrong
 * continent, and nobody notices for months.
 *
 * These are the checks that were run by hand while the catalogue grew, made permanent so
 * the next hundred rows cannot reintroduce what the first hundred already fixed.
 *
 * Pure: no sockets, no PowerShell, no filesystem.
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const catalog = require(ROOT + '/game/catalog');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

const pub = catalog.publicCatalog();
const G = pub.games;

// ── the shape every row has to have ─────────────────────────────────────────────
{
    const ids = G.map(g => g.id);
    const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
    t('every game id is unique (ids are stored inside profile keys)',
        dupes.length === 0, dupes.join(', '));

    t('no id contains a separator that would corrupt a profile key',
        !ids.some(id => id.includes('|')), ids.filter(id => id.includes('|')).join(', '));

    const noProc = G.filter(g => !g.procs || !g.procs.length).map(g => g.id);
    t('every game names at least one executable, or it can never be detected',
        noProc.length === 0, noProc.join(', '));

    const noFa = G.filter(g => !g.fa || !g.fa.trim()).map(g => g.id);
    t('every game has a display name', noFa.length === 0, noFa.join(', '));

    const badCat = G.filter(g => !pub.categories.some(c => c.id === g.cat)).map(g => g.id);
    t('every game sits in a declared category', badCat.length === 0, badCat.join(', '));

    const badClass = G.filter(g => !pub.classFa[g.klass]).map(g => g.id);
    t('every game has a known network class', badClass.length === 0, badClass.join(', '));

    const badRegion = G.filter(g => (g.regions || []).some(r => !pub.regions[r])).map(g => g.id);
    t('every region a game names actually exists, or its anchors would be empty',
        badRegion.length === 0, badRegion.join(', '));

    const noRegion = G.filter(g => !g.regions || !g.regions.length).map(g => g.id);
    t('every game names at least one region', noRegion.length === 0, noRegion.join(', '));

    const PROBES = ['a2s', 'fivem', 'minecraft', 'raknet', 'anchors'];
    const badProbe = G.filter(g => !PROBES.includes(g.probe)).map(g => g.id + ':' + g.probe);
    t('every probe kind is one the engine implements', badProbe.length === 0, badProbe.join(', '));
}

// ── executable collisions ───────────────────────────────────────────────────────
//
// byProcess() is first-match-wins, so two games claiming the same executable means one of
// them can never be detected. A few collisions are unavoidable — TFT genuinely runs the
// League client — but those must be DOCUMENTED in the row, so that a future collision
// stands out as an accident rather than blending into the accepted ones.
{
    const byExe = new Map();
    for (const g of G) for (const p of g.procs) {
        const k = p.toLowerCase();
        byExe.set(k, (byExe.get(k) || []).concat([g]));
    }
    const clashes = [...byExe.entries()].filter(([, v]) => v.length > 1);
    const undocumented = clashes.filter(([, v]) => v.slice(1).some(g => !g.note));

    t('every executable shared by two games is explained in a note on the shadowed row',
        undocumented.length === 0,
        undocumented.map(([p, v]) => p + ' -> ' + v.map(g => g.id).join('+')).join('; '));

    t('shared executables stay rare (currently the two that genuinely cannot be separated)',
        clashes.length <= 3, clashes.map(([p]) => p).join(', '));

    // Prefix entries like "FiveM_*" must not swallow unrelated names.
    const prefixes = G.flatMap(g => (g.procs || []).filter(p => p.endsWith('*')).map(p => ({ p, g })));
    const overreach = prefixes.filter(({ p }) => p.replace('*', '').length < 4);
    t('no wildcard executable is short enough to match unrelated processes',
        overreach.length === 0, overreach.map(x => x.p).join(', '));
}

// ── resolution behaves ──────────────────────────────────────────────────────────
{
    t('byProcess is case-insensitive', catalog.byProcess('gta5.EXE') === catalog.byProcess('GTA5.exe'));
    t('byProcess resolves the Rockstar pair the user tests with',
        (catalog.byProcess('GTA5.exe') || {}).id === 'gta-online'
        && (catalog.byProcess('RDR2.exe') || {}).id === 'rdo');
    t('byProcess handles FiveM\'s per-build executable name via the wildcard',
        (catalog.byProcess('FiveM_b3095_GTAProcess.exe') || {}).id === 'fivem');
    t('byProcess returns null for something unknown rather than guessing',
        catalog.byProcess('notarealgame.exe') === null);
    t('byProcess tolerates junk input', catalog.byProcess('') === null && catalog.byProcess(null) === null);
    t('byId round-trips for every game', G.every(g => (catalog.byId(g.id) || {}).id === g.id));
}

// ── anchors ─────────────────────────────────────────────────────────────────────
{
    const noAnchor = G.filter(g => catalog.anchorsFor(g).length === 0).map(g => g.id);
    t('every game resolves to at least one measurable anchor',
        noAnchor.length === 0, noAnchor.join(', '));

    // Anchors are deduped by netGroup so one operator cannot be counted twice — the same
    // independence rule netdiag uses for its endpoint scopes.
    const dupGroups = G.map(g => {
        const groups = catalog.anchorsFor(g).map(a => a.group);
        return { id: g.id, dup: groups.length !== new Set(groups).size };
    }).filter(x => x.dup).map(x => x.id);
    t('anchors are deduped by operator, so one network is one observation',
        dupGroups.length === 0, dupGroups.join(', '));

    for (const [id, reg] of Object.entries(catalog.REGIONS)) {
        t(`region "${id}" has at least one anchor host`, reg.tcp && reg.tcp.length > 0);
    }
    t('every UDP anchor names a distinct operator',
        new Set(catalog.UDP_ANCHORS.map(a => a.group)).size === catalog.UDP_ANCHORS.length);
}

// ── region-picker hints ─────────────────────────────────────────────────────────
{
    const ids = new Set(G.map(g => g.id));
    const orphans = Object.keys(catalog.REGION_PICK).filter(k => !ids.has(k));
    t('every region-selection hint points at a game that exists',
        orphans.length === 0, orphans.join(', '));

    const empty = Object.entries(catalog.REGION_PICK).filter(([, v]) => !v || v.length < 10).map(([k]) => k);
    t('every hint actually says where the setting lives',
        empty.length === 0, empty.join(', '));

    t('the hint is surfaced on the public game shape the renderer consumes',
        G.filter(g => g.regionHint).length === Object.keys(catalog.REGION_PICK).length);
}

// ── the anti-cheat boundary ─────────────────────────────────────────────────────
//
// This is a safety rule, not a cosmetic label: rows flagged kernelAnticheat are the ones
// where nothing may ever touch the packets, only carry them.
{
    const flagged = G.filter(g => g.kernelAnticheat);
    t('kernel anti-cheat games are flagged (Valorant, CoD and friends)',
        flagged.length >= 5 && flagged.some(g => g.id === 'valorant') && flagged.some(g => g.id === 'cod'),
        flagged.map(g => g.id).join(', '));
    t('the flag agrees with the declared anti-cheat name',
        G.every(g => g.kernelAnticheat === (!!g.anticheat && pub.kernelAnticheat.includes(g.anticheat))));
}

// ── the public shape is serialisable ────────────────────────────────────────────
{
    let ok = true, why = '';
    try { JSON.parse(JSON.stringify(pub)); } catch (e) { ok = false; why = e.message; }
    t('publicCatalog() survives a JSON round trip (it is sent over HTTP)', ok, why);
    t('publicCatalog() leaks no functions',
        !JSON.stringify(pub).includes('function'));
    t('the catalogue is actually large — the user asked for complete coverage',
        G.length >= 190, `${G.length} games`);
}

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
