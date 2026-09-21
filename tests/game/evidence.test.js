/*
 * The routing-evidence parser.
 *
 * This is the one claim in the whole feature a user cannot check for themselves: "your game
 * is going through the engine now". So the parser that produces that claim gets pinned
 * against REAL sing-box output — including the ANSI colour codes it actually emits, which
 * were captured from this machine's own ~/.mlmvpn/tun.log.
 *
 * The failure mode being guarded against is a false confirmation: counting a leftover line
 * from an earlier Aether full-tunnel run, or a colour-code change, as proof that the game's
 * process rule matched. A "not-matched" verdict is a useful answer; a wrong "confirmed" is a
 * lie the user has no way to detect.
 *
 * Pure: writes one temp file, reads it back, deletes it. No sockets, no PowerShell.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const ev = require(ROOT + '/game/evidence');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

// Captured verbatim from this machine, colour codes and all.
const ESC = String.fromCharCode(27);
const REAL_ERROR_LINE =
    '[2026-08-19T06:26:37.032Z] +0330 2026-08-19 09:56:37 ' + ESC + '[31mERROR' + ESC + '[0m [' + ESC +
    '[38;5;122m3990438250' + ESC + '[0m 5.3s] connection: open connection to 172.16.0.2:1688 ' +
    'using outbound/direct[direct]: dial tcp 172.16.0.2:1688: i/o timeout';

const line = (iso, dest, kind, tag, extra) =>
    `[${iso}] +0330 2026-08-19 12:00:00 ` + ESC + '[34mINFO' + ESC + '[0m [' + ESC + '[38;5;99m123456' + ESC +
    `[0m 0ms] connection: open connection to ${dest} using outbound/${kind}[${tag}]${extra || ''}`;

/**
 * Run `fn(file)` against a fixture log.
 *
 * The path is passed in rather than patched onto the module: an earlier version of this
 * suite rewrote `ev.TUN_LOG`, which did nothing — `read()` closes over a module-level const
 * — so every assertion silently ran against this machine's REAL tun.log and "passed" or
 * failed for reasons that had nothing to do with the code under test.
 */
function withLog(lines, fn) {
    const tmp = path.join(os.tmpdir(), 'mlmvpn-evidence-test-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.log');
    fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
    try { return fn(tmp); }
    finally { try { fs.unlinkSync(tmp); } catch {} }
}

// ── the regex, against real output ───────────────────────────────────────────────
{
    const stripped = REAL_ERROR_LINE.replace(ev.ANSI, '');
    const m = stripped.match(ev.CONN);
    t('the real captured sing-box line parses at all', !!m, stripped.slice(0, 90));
    t('…and yields the destination', m && m[1] === '172.16.0.2:1688', m && m[1]);
    t('…and the outbound tag', m && m[3] === 'direct', m && m[3]);
    t('ANSI colour codes are stripped before matching',
        !stripped.includes(ESC), 'escape survived');
}

// ── counting ─────────────────────────────────────────────────────────────────────
{
    const iso = new Date().toISOString();
    const lines = [
        line(iso, '104.16.1.1:443', 'direct', 'direct'),
        line(iso, '185.20.30.40:30120', 'socks', 'aether'),
        line(iso, '185.20.30.40:30120', 'socks', 'aether'),
        line(iso, '8.8.8.8:53', 'direct', 'direct'),
        line(iso, '1.1.1.1:443', 'socks', 'someoneelse'),
    ];
    const r = withLog(lines, (f) => ev.read({ engineTag: 'aether', file: f }));
    t('engine connections are counted', r.engine === 2, `got ${r.engine}`);
    t('direct connections are counted', r.direct === 2, `got ${r.direct}`);
    t('a connection to a DIFFERENT outbound is not counted as the engine',
        r.other === 1 && r.engine === 2, `other=${r.other} engine=${r.engine}`);
    t('destinations carried by the engine are reported with counts',
        r.targets.length === 1 && r.targets[0].dest === '185.20.30.40:30120' && r.targets[0].count === 2,
        JSON.stringify(r.targets));
}

// ── the false-confirmation guard ─────────────────────────────────────────────────
//
// A log left over from an earlier full-tunnel run is full of engine-tagged connections. If
// those were counted, every boost would report "confirmed" the instant it started.
{
    const old = new Date(Date.now() - 3600e3).toISOString();
    const now = new Date().toISOString();
    const lines = [
        line(old, '1.2.3.4:443', 'socks', 'aether'),
        line(old, '1.2.3.5:443', 'socks', 'aether'),
        line(now, '9.9.9.9:443', 'direct', 'direct'),
    ];
    const r = withLog(lines, (f) => ev.read({ engineTag: 'aether', sinceMs: Date.now() - 60e3, file: f }));
    t('lines from before this boost session are excluded',
        r.engine === 0, `counted ${r.engine} stale engine lines`);
    t('…while lines from within the session still count',
        r.direct === 1, `got ${r.direct}`);
}

// ── verdicts ─────────────────────────────────────────────────────────────────────
{
    const iso = new Date().toISOString();

    const confirmed = withLog(
        [line(iso, '185.1.1.1:30120', 'socks', 'aether'), line(iso, '8.8.8.8:53', 'direct', 'direct')],
        (f) => ev.summarise({ engineTag: 'aether', gameRunning: true, engineFa: 'Aether', file: f }));
    t('traffic through the engine confirms the claim',
        confirmed.verdict === 'confirmed', confirmed.verdict);

    const waiting = withLog(
        [line(iso, '8.8.8.8:53', 'direct', 'direct')],
        (f) => ev.summarise({ engineTag: 'aether', gameRunning: false, file: f }));
    t('no engine traffic + game not running = waiting, not failure',
        waiting.verdict === 'waiting', waiting.verdict);

    const notMatched = withLog(
        [line(iso, '8.8.8.8:53', 'direct', 'direct'),
         '[' + iso + '] router: failed to search process: Access is denied.'],
        (f) => ev.summarise({ engineTag: 'aether', gameRunning: true, file: f }));
    t('game running + nothing through the engine = the rule did not match',
        notMatched.verdict === 'not-matched', notMatched.verdict);
    t('…and the Access-is-denied line is surfaced as the likely cause',
        notMatched.accessDenied === 1 && notMatched.reasons.some(r => r.includes('Access is denied')),
        `accessDenied=${notMatched.accessDenied}`);

    const empty = withLog([], (f) => ev.summarise({ engineTag: 'aether', file: f }));
    t('an empty log says "no evidence", never "confirmed"',
        empty.verdict === 'unknown', empty.verdict);
}

// ── robustness ───────────────────────────────────────────────────────────────────
{
    const iso = new Date().toISOString();
    const junk = withLog(
        ['not a log line at all', '', '[' + iso + '] start engine=V2Ray process=xray.exe socks=20808',
         line(iso, '5.5.5.5:443', 'socks', 'aether')],
        (f) => ev.read({ engineTag: 'aether', file: f }));
    t('non-connection lines are ignored rather than miscounted',
        junk.engine === 1 && junk.direct === 0, JSON.stringify({ e: junk.engine, d: junk.direct }));

    const noTag = withLog([line(iso, '5.5.5.5:443', 'socks', 'aether')],
        (f) => ev.read({ engineTag: null, file: f }));
    t('with no engine tag given, nothing is attributed to the engine',
        noTag.engine === 0 && noTag.other === 1, JSON.stringify({ e: noTag.engine, o: noTag.other }));
}

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
