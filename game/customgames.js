'use strict';

/**
 * --- Games the user adds themselves ---
 *
 * The catalogue ships 196 games and will never ship the one a particular person plays. Iranian
 * players in particular run a long tail the West's lists do not carry — private servers, regional
 * MMOs, emulator titles, and whatever came out last month — and until now the panel's answer to
 * all of them was silence: no recognition, no selection, and therefore none of the levers.
 *
 * WHAT A CUSTOM ENTRY IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * It is exactly one thing: **a name attached to an executable**. That is the whole contract the
 * rest of the feature needs — `detect.js` recognises a running game by process name, `focus.js`
 * raises it, `boost.js` routes it by `process_name`, and the shaper leaves it alone. All of that
 * works the moment the executable is known.
 *
 * It is NOT a claim about the game's network architecture. The catalogue records `klass`, `probe`,
 * port ranges and anti-cheat because somebody measured them; for a game the user just added,
 * nobody has. So those fields take the honest values rather than plausible ones:
 *
 *   probe: 'anchors'  — "nothing in this game answers a query we know; we measure regional
 *                        anchors instead and say so". That is already the catalogue's own answer
 *                        for every P2P and closed-platform title, including GTA Online.
 *   klass: 'unknown'  — not 'p2p', not 'client-server'. Guessing here would put a sentence in
 *                        front of the user that reads like a finding and is not one.
 *   anticheat: null   — we do not know, and inventing one would be worse than useless. The one
 *                        rule anti-cheat drives (never manipulate packets) is unconditional in
 *                        this project anyway, so an unknown value costs nothing in safety.
 *
 * THE EXECUTABLE IS CHOSEN, NEVER TYPED
 *
 * The routes that feed this offer a running-process list and the app's own file picker. A typed
 * `.exe` is a silent failure: the panel would accept "valorent.exe", recognise nothing for ever,
 * and the user would conclude the feature is broken rather than that they made a typo.
 *
 * CUSTOM ENTRIES WIN OVER BUILT-IN ONES
 *
 * If somebody says "this executable is my game", that is a statement about their own machine and
 * it beats our guess — including when it corrects a built-in mapping that is wrong for them.
 * `catalog.byProcess` therefore consults this store first.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.mlmvpn', 'game-custom.json');

/** Ids are prefixed so a custom game can never collide with a catalogue id, now or later. */
const PREFIX = 'custom:';

/**
 * Executables that are never a game, whatever the user picked.
 *
 * Not a curated blocklist of applications — a guard against the two mistakes that would hurt:
 * pointing the booster at Windows itself, or at one of our own engines (which the booster then
 * raises to High priority and excludes from its own line-freeing — harmless, but it would mean
 * the real game is never recognised, and the user would think the feature simply does not work).
 */
const REFUSED = new Set([
    'system', 'idle', 'registry', 'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
    'services.exe', 'lsass.exe', 'svchost.exe', 'dwm.exe', 'explorer.exe', 'taskmgr.exe',
    'conhost.exe', 'runtimebroker.exe', 'searchhost.exe', 'sihost.exe', 'ctfmon.exe',
    'cmd.exe', 'powershell.exe', 'pwsh.exe', 'mlm vpn.exe', 'mlmvpn.exe', 'electron.exe',
    'node.exe',
]);

function isRefused(exe) {
    const n = String(exe || '').trim().toLowerCase();
    if (!n) return true;
    if (REFUSED.has(n)) return true;
    // Our own engines, from the one list that knows them all.
    try { return require('../engine-processes').isEngine(n); } catch { return false; }
}

// ── the store ────────────────────────────────────────────────────────────────────────────────

/** Tests point this at a temp file; nothing in the app calls it. See profiles.js, same shape. */
let activeFile = FILE;
function useFileForTests(p) { activeFile = p || FILE; bump(); }

function read() {
    try {
        const raw = JSON.parse(fs.readFileSync(activeFile, 'utf8'));
        return Array.isArray(raw.games) ? raw : { v: 1, games: [] };
    } catch { return { v: 1, games: [] }; }
}

function write(store) {
    fs.mkdirSync(path.dirname(activeFile), { recursive: true });
    fs.writeFileSync(activeFile, JSON.stringify(store, null, 2), 'utf8');
    bump();
}

/**
 * A revision counter, so `catalog.js` can cache its merged index and still notice a change.
 *
 * The catalogue builds its process index once at require time — that is right for 196 entries
 * that never move. Custom entries move whenever the user adds one, and rebuilding the index on
 * every `byProcess` call would put a file read in the middle of a six-second poll.
 */
let revision = 0;
function bump() { revision++; }
function rev() { return revision; }

/** Normalise one executable to the form Windows reports (`Name.exe`, matched case-insensitively). */
function normExe(exe) {
    const base = String(exe || '').trim().split(/[\\/]/).pop();
    if (!base) return null;
    const withExt = /\.exe$/i.test(base) ? base : `${base}.exe`;
    // The same character rule the routing panel uses — anything Windows cannot name is not a file.
    return /^[^<>:"|?*\x00-\x1f]+\.exe$/.test(withExt) ? withExt : null;
}

/**
 * Turn what the panel collected into a record the rest of the feature can use, or throw with a
 * sentence the user can act on. Every rejection here is a thing that would otherwise fail
 * silently later.
 */
function build({ fa, en = '', procs = [], cat = 'other', path: exePath = '', regions = null } = {}) {
    const name = String(fa || '').trim().slice(0, 60);
    if (!name) throw new Error('اسم بازی را بنویسید.');

    const seen = new Set();
    const list = [];
    for (const p of procs) {
        const e = normExe(p);
        if (!e || seen.has(e.toLowerCase())) continue;
        if (isRefused(e)) throw new Error(`«${e}» یک برنامهٔ سیستمی یا موتور خود برنامه است و نمی‌تواند بازی باشد.`);
        seen.add(e.toLowerCase());
        list.push(e);
    }
    if (!list.length) throw new Error('فایل اجرایی بازی انتخاب نشده است.');

    return {
        id: PREFIX + list[0].toLowerCase().replace(/\.exe$/, '').replace(/[^a-z0-9_-]/g, '-'),
        fa: name,
        en: String(en || name).trim().slice(0, 60),
        cat: String(cat || 'other'),
        // See the header: honest unknowns, not plausible guesses.
        klass: 'unknown',
        probe: 'anchors',
        regions: Array.isArray(regions) && regions.length ? regions.slice(0, 4) : ['eu-central', 'eu-west'],
        procs: list,
        anticheat: null,
        custom: true,
        path: String(exePath || '').slice(0, 520),
        at: Date.now(),
        note: 'این بازی را خودتان اضافه کرده‌اید. معماری شبکه‌اش سنجیده نشده، پس به‌جای پرسیدن از سرور خودِ بازی، لنگرهای منطقه‌ای سنجیده می‌شوند — همان کاری که برای بازی‌های همتا‌به‌همتا مثل GTA Online هم انجام می‌شود.',
    };
}

function list() { return read().games; }

function add(input) {
    const game = build(input);
    const store = read();
    if (store.games.some(g => g.id === game.id)) {
        throw new Error(`«${game.procs[0]}» از قبل اضافه شده است.`);
    }
    store.games.push(game);
    write(store);
    return game;
}

function remove(id) {
    const store = read();
    const before = store.games.length;
    store.games = store.games.filter(g => g.id !== id);
    if (store.games.length === before) return false;
    write(store);
    return true;
}

/** Lower-cased executable → game, for the catalogue's lookup. Custom entries take precedence. */
function byProcessMap() {
    const m = new Map();
    for (const g of read().games) {
        for (const p of g.procs || []) m.set(String(p).toLowerCase(), g);
    }
    return m;
}

module.exports = {
    list, add, remove, build, byProcessMap, rev, bump,
    normExe, isRefused, REFUSED, PREFIX, FILE, useFileForTests,
};
