// «فهرست من» و «آرشیو» — the gateway's two lists and the curation over them.
//
// THE MODEL, and why it is not one list. VPN Gate publishes about a hundred relays at a time and
// rotates them hard: of the 97 in a year-old snapshot, 4 were still listed. `mergeLists` keeps
// the union of every refresh, so the file on disk grows into a real catalogue — but a catalogue
// is not a shortlist, and a connect button that picks out of it is picking out of a graveyard.
//
//   «فهرست من»  the relays the LAST refresh advertised, plus whatever the user promoted, minus
//               whatever they deleted. The connect button chooses from this.
//   «آرشیو»     every row on disk. Browsable, testable, and where to go when nothing in the main
//               list answers — a relay VPN Gate dropped is often still running.
//
// Two verbs that look the same and are not: deleting from «فهرست من» writes a DENY-LIST entry,
// because the next refresh re-advertises the same relay and a plain removal would silently come
// back; deleting from «آرشیو» removes the row.
//
// ISOLATED. `USERPROFILE` is redirected before the module is required, so none of this can touch
// the user's own ~/.mlmvpn/gateway. Nothing here reaches the network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mlm-gw-'));
process.env.USERPROFILE = HOME;
process.env.HOME = HOME;

const g = require('../../gateway-manager');
const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

const cleanup = () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) { /* temp */ } };

t('the test cannot touch the real data directory', g.DATA_DIR.startsWith(HOME), g.DATA_DIR);

// The shipped seed list is the fixture: 97 relays, 13 of them official, and it is what a fresh
// install actually reads.
const seeded = g.lists();
t('the shipped seed list parses', seeded.archive.length > 50, `${seeded.archive.length} rows`);
t('…and every relay carries the columns the server page shows', (() => {
    const r = seeded.archive[0];
    return r && typeof r.score === 'number' && typeof r.uptimeMs === 'number'
        && typeof r.logType === 'string' && typeof r.operator === 'string' && 'message' in r;
})(), JSON.stringify(seeded.archive[0] || {}).slice(0, 160));

// BEFORE THE FIRST REFRESH the two lists are the same, and that is deliberate: there is no
// `fetchedAt` to compare `last-seen.json` against, and an install upgrading into this code would
// otherwise open onto an empty «فهرست من» with a full archive behind it.
t('with no refresh yet, «فهرست من» is the whole archive',
    seeded.mine.length === seeded.archive.length && seeded.fetchedAt === 0);

const hosts = seeded.archive.slice(0, 5).map(r => r.host);
const [h1, h2, h3] = hosts;

// ── keep / drop ──────────────────────────────────────────────────────────────────────────────
{
    g.keep([h1, h2]);
    const l = g.lists();
    t('keep promotes into «فهرست من»', l.kept.length === 2 && l.kept.indexOf(h1) >= 0);
    g.drop([h2]);
    t('…and drop undoes exactly one of them', g.lists().kept.length === 1);
}

// ── hide is a deny-list, not a delete ────────────────────────────────────────────────────────
{
    g.hide([h3]);
    const l = g.lists();
    t('hide removes the relay from «فهرست من»', !l.mine.some(r => r.host === h3));
    t('…and leaves it in «آرشیو», so it can be found again', l.archive.some(r => r.host === h3));
    t('…and records it, so the next refresh cannot bring it back', l.hidden.indexOf(h3) >= 0);
}
{
    // A relay in both sets would be invisible with no way to explain why: keeping something
    // previously deleted has to undo the deletion too.
    g.keep([h3]);
    const l = g.lists();
    t('keeping a deleted relay un-deletes it', l.hidden.indexOf(h3) < 0 && l.kept.indexOf(h3) >= 0);
    t('…and it is back in «فهرست من»', l.mine.some(r => r.host === h3));
}
{
    g.hide([h1]);
    t('and deleting a kept relay drops the keep, or it would be in both sets',
        g.lists().kept.indexOf(h1) < 0 && g.lists().hidden.indexOf(h1) >= 0);
}

// ── restore: the undo a bulk delete must have ────────────────────────────────────────────────
{
    const before = g.lists().hidden.length;
    const n = g.restoreHidden();
    const l = g.lists();
    t('restore brings every deleted relay back at once', n === before && l.hidden.length === 0);
    t('…and they are in «فهرست من» again', l.mine.some(r => r.host === h1));
}

// ── selection ────────────────────────────────────────────────────────────────────────────────
{
    g.select(h2);
    t('the chosen relay is remembered', g.lists().selected === h2);
    g.hide([h2]);
    // A connect button holding a selection it cannot find is worse than one holding none.
    t('…and deleting it clears the selection rather than leaving a dangling one', g.lists().selected === null);
    g.restoreHidden();
    g.select(h2);
}

// ── the two tests' verdicts ──────────────────────────────────────────────────────────────────
{
    const cur = g._internal.readCuration();
    cur.probes = {}; cur.pings = {};
    cur.probes[h1] = { ok: true, ms: 1800, at: Date.now() };
    cur.probes[h2] = { ok: false, reason: 'tls', at: Date.now() };
    cur.pings[h3] = 0;
    const h4 = hosts[3], h5 = hosts[4];
    cur.pings[h4] = 120;
    g._internal.saveCuration(true);

    const dead = g.deadHosts(hosts);
    t('«خراب» means a test condemned it', dead.indexOf(h2) >= 0 && dead.indexOf(h3) >= 0);
    // «حذف خراب‌ها» on a fresh list must not wipe it. An untested relay is unmeasured, not bad,
    // and the two are only the same to a button that has not thought about it.
    t('…and never merely «untested»', dead.indexOf(h5) < 0 && dead.indexOf(h1) < 0, JSON.stringify(dead));

    const healthy = g.healthyHosts(hosts);
    t('«سالم» prefers what the real test proved', healthy.length === 1 && healthy[0] === h1, JSON.stringify(healthy));

    // …and falls back to the ping only when nothing has been probed at all, because a ping that
    // answered is the only evidence there is.
    cur.probes = {};
    g._internal.saveCuration(true);
    t('…and falls back to the ping when nothing has been probed', g.healthyHosts(hosts).indexOf(h4) >= 0);
}

// ── what to connect to when the user has not chosen ──────────────────────────────────────────
{
    const cur = g._internal.readCuration();
    cur.probes = {}; cur.pings = {};
    const l0 = g.lists();
    const a = l0.mine[10].host, b = l0.mine[11].host, c = l0.mine[12].host;
    cur.probes[a] = { ok: true, ms: 4000, at: Date.now() };
    cur.probes[b] = { ok: true, ms: 1200, at: Date.now() };
    cur.pings[c] = 30;
    g._internal.saveCuration(true);
    // Never «the first row»: that list is sorted by advertised megabits, and VPN Gate measured
    // those from Japan.
    t('the suggestion is the fastest relay the real test proved', g.suggest() === b, g.suggest());
    cur.probes = {};
    g._internal.saveCuration(true);
    t('…and a measured ping when nothing is proven', g.suggest() === c, g.suggest());
    cur.pings = {};
    g._internal.saveCuration(true);
    t('…and never nothing while the list is not empty', !!g.suggest());
}

// ── purge really removes the row ─────────────────────────────────────────────────────────────
{
    // purge edits the CSV, which only exists once something has been written to livePath. Seed it
    // the way a refresh would.
    const live = g._internal.livePath();
    fs.mkdirSync(path.dirname(live), { recursive: true });
    fs.writeFileSync(live, fs.readFileSync(g._internal.seedPath(), 'utf8'), 'utf8');

    const before = g.lists().archive.length;
    const victim = g.lists().archive[2].host;
    const n = g.purge([victim]);
    const after = g.lists();
    t('purge removes the row from the archive itself', n === 1 && after.archive.length === before - 1);
    t('…and the relay is really gone', !after.archive.some(r => r.host === victim));
    t('…and its measurements go with it, so the file cannot grow for ever',
        after.pings[victim] === undefined && after.probes[victim] === undefined);
}

// ── «فهرست من» after a refresh ───────────────────────────────────────────────────────────────
{
    // Simulate what `refreshServers` writes: a `fetchedAt`, and a `last-seen.json` in which only
    // some of the archive was seen just now.
    const all = g.lists().archive;
    const now = Date.now();
    const seen = {};
    all.forEach((r, i) => { seen[r.host.replace(/\.opengw\.net$/, '')] = i < 20 ? now : now - 10 * 86400000; });
    fs.writeFileSync(path.join(g.DATA_DIR, 'last-seen.json'), JSON.stringify(seen), 'utf8');
    const cur = g._internal.readCuration();
    cur.fetchedAt = now;
    cur.kept = [all[50].host];
    cur.hidden = [all[3].host];
    g._internal.saveCuration(true);

    const l = g.lists();
    t('after a refresh, «فهرست من» is the relays that refresh advertised',
        l.mine.length === 20 + 1 - 1, `${l.mine.length} (expected 20 live + 1 kept − 1 deleted)`);
    t('…plus the ones the user kept', l.mine.some(r => r.host === all[50].host));
    t('…minus the ones they deleted', !l.mine.some(r => r.host === all[3].host));
    t('…while «آرشیو» still holds everything', l.archive.length === all.length);
}

// ── the UDP switch ───────────────────────────────────────────────────────────────────────────
{
    t('UDP acceleration is on by default, as SoftEther itself has it', g.lists().udp === true);
    g.setUdp(false);
    t('…and the switch persists', g.lists().udp === false && g.getStatus().udp === false);
    g.setUdp(true);
}

// ── the sweep's shape ────────────────────────────────────────────────────────────────────────
{
    t('no sweep is running to begin with', g.sweepState() === null && g.sweepRunning() === false);
    t('cancelling nothing is not an error', g.cancelSweep() === false);
}

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
cleanup();
assert.ok(true);
process.exit(failed ? 1 : 0);
