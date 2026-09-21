/*
 * Choosing a resolver for a game — the rule that replaced a hard-coded name.
 *
 * WHAT WENT WRONG BEFORE, because the fix only makes sense against it
 * The old ranking opened with `if (id === 'electro') return 0`. It was not arbitrary: the
 * reasoning was that a resolver which cannot open a sanctioned launcher has optimised the wrong
 * thing however fast it is, and that is correct. But the only data the ranking had was a
 * `www.google.com` ping — liveness, not capability — so it could not act on that reasoning and
 * substituted a vendor name for it. Electro therefore won every run it survived, and users
 * complained that nothing else was ever chosen.
 *
 * WHAT IS PINNED HERE
 * Coverage first, then whether the answer actually connects, then speed — with no name anywhere.
 * Each assertion below corresponds to something MEASURED on a real Iranian line on 2026-09-14:
 *
 *   eight providers resolved every domain a Steam game needs and their answers connected
 *   one (shecan-pro) was the FASTEST of all at 217ms and its answer connected to nothing
 *   six resolved nothing at all, two of which are marketed as gaming DNS
 *   one (begzar) mixes the ROOT NAMESERVER addresses into its A records
 *
 * That last two are why `classify` exists: an answer is not automatically a good answer, and a
 * ranking that counts them as successes is the same lie the old one told, in a new place.
 *
 * Pure — no sockets, no DNS, no PowerShell. The network parts are exercised by the panel itself.
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const pick = require(path.join(ROOT, 'game', 'dnspick'));

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

// ── an answer is not automatically a good answer ─────────────────────────────────
{
    t('a normal answer is accepted', pick.classify(['184.26.128.227']).ok === true);
    t('no answer at all is `empty`, not a success', pick.classify([]).why === 'empty');
    t('the filter sinkhole is a refusal, whatever the RCODE said',
        pick.classify(['10.10.34.36']).why === 'sinkhole');
    t('0.0.0.0 is the same refusal in another costume', pick.classify(['0.0.0.0']).why === 'sinkhole');
    // Measured: `begzar` really does return 198.41.0.4 and friends as the address of
    // steamcommunity.com. A client that picks one gets a root nameserver instead of Steam.
    t('a root-nameserver address mixed into the answer is `bogus`',
        pick.classify(['184.26.128.227', '198.41.0.4']).why === 'bogus');
    t('…and being mostly right does not save it — one bogus address poisons the answer',
        pick.classify(['1.2.3.4', '5.6.7.8', '192.33.4.12']).ok !== true);
}

// ── which domains a game is tested against ───────────────────────────────────────
{
    const steam = pick.domainsFor({ store: 'steam' });
    t('a Steam game is tested against Steam\'s own endpoints',
        steam.some(d => /steampowered|steamcommunity/.test(d)), steam.join(','));
    const riot = pick.domainsFor({ store: 'riot' });
    t('a Riot game is tested against Riot\'s', riot.some(d => /riotgames/.test(d)), riot.join(','));
    t('every game also gets the shared set, whatever its platform',
        pick.BASE_DOMAINS.every(d => riot.includes(d)));
    // A game the user added has no store. The base set is what it gets, which is honest: we do
    // not know what its launcher talks to.
    const custom = pick.domainsFor({ id: 'custom:x' });
    t('a game with no known platform still gets something measurable', custom.length > 0);
    t('the list stays short enough to run inside a pipeline', pick.domainsFor({ store: 'steam' }).length <= 5);
}

// ── the ranking itself ───────────────────────────────────────────────────────────
const row = (id, resolved, ms, reachable, total = 4) =>
    ({ id, fa: id, resolved, total, ms, reachable, servers: [id + '.1'], failures: [] });

{
    // The measured shape: a fast resolver that opens nothing against a slower one that opens all.
    const rows = [row('radar', 0, 200, null), row('electro', 4, 1674, true)].sort(pick.compare);
    t('coverage beats speed — a fast resolver that opens nothing is useless',
        rows[0].id === 'electro', rows.map(r => r.id).join(' > '));

    // shecan-pro, exactly as measured: everything resolved, 217ms, nothing at the other end.
    const rows2 = [row('shecan-pro', 4, 217, false), row('google', 4, 541, true)].sort(pick.compare);
    t('an answer that does not connect loses to one that does, even at twice the latency',
        rows2[0].id === 'google', rows2.map(r => r.id).join(' > '));

    // And only once those two are equal does speed decide.
    const rows3 = [row('cloudflare', 4, 734, true), row('google', 4, 541, true)].sort(pick.compare);
    t('between two that are equally capable, the faster one wins',
        rows3[0].id === 'google', rows3.map(r => r.id).join(' > '));

    t('partial coverage beats none', [row('a', 0, 10, null), row('b', 1, 9000, false)].sort(pick.compare)[0].id === 'b');
}

// ── the winner, and why it must be stable ────────────────────────────────────────
{
    const rows = [row('google', 4, 541, true), row('electro', 4, 1674, true), row('radar', 0, 5576, null)];

    t('with nothing in use, the ranking decides', pick.best(rows).id === 'google');

    // Eight providers tie at full coverage on a real line, so a strict sort renames the winner on
    // latency noise and two runs a minute apart give two answers. Changing the machine's resolver
    // for that is churn, not optimisation.
    t('a resolver already in use keeps its place when it is just as capable',
        pick.best(rows, { current: ['electro.1'] }).id === 'electro');
    t('…and the reason offered to the user is about coverage, not about its brand',
        /دامنه/.test(pick.best(rows, { current: ['electro.1'] }).why || ''));

    // But an incumbent does not get to be bad.
    const weak = [row('google', 4, 541, true), row('weak', 1, 100, true)];
    t('an incumbent that opens less is replaced', pick.best(weak, { current: ['weak.1'] }).id === 'google');
    const dead = [row('google', 4, 541, true), row('dead', 4, 100, false)];
    t('…and so is one whose answers do not connect',
        pick.best(dead, { current: ['dead.1'] }).id === 'google');

    t('when nothing resolved anything, there is no winner rather than a guess',
        pick.best([row('a', 0, 10, null), row('b', 0, 20, null)]) === null);
    t('an empty scan returns null', pick.best([]) === null);
}

// ── the thing this whole change is about ─────────────────────────────────────────
{
    // The old rule: electro first, unconditionally. If that ever comes back, this fails.
    const rows = [row('electro', 2, 100, true), row('google', 4, 900, true)].sort(pick.compare);
    t('NO VENDOR NAME IS PRIVILEGED — a better resolver wins over the one that used to be hard-coded',
        rows[0].id === 'google', rows.map(r => `${r.id}:${r.resolved}/${r.total}`).join(' > '));
}

let failed = 0;
for (const x of results) {
    if (!x.ok) failed++;
    console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + (x.detail || '')}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
