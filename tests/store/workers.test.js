// Updating a worker rewrites code on the user's own Cloudflare account, where their panels and
// their users live. These are the checks that stand between "update the code" and "break a panel".
const fs = require('fs');
const path = require('path');
const workers = require('../../store/workers');
const catalog = require('../../store/catalog');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── BPB's compiled settings prefix ───────────────────────────────────────────
// v5 refuses to start without it, so an update that loses it destroys the panel. There are two
// layouts in the wild: the one this app deploys, and the one the panel writes when it redeploys
// itself (comments, generated filler, and the source glued straight on with no newline).
const SRC = 'export default { async fetch(){ return new Response("panel") } };';
const settings = { accID: 'acc', accEmail: 'a@b.c', vlUUID: 'u', trPass: 'p', securePath: 'sp', proxyIPs: ['x{y}z'] };
const appStyle = 'Object.assign(globalThis, ' + JSON.stringify({ EMBEDED_SETTINGS: settings }) + ');\n' + SRC;
const selfStyle = '// panel\n// Build: 2026-09-14\n// @ts-nocheck\nconst _a=1,_b=2;Object.assign(globalThis, '
    + JSON.stringify({ SOURCE_CONTENT: 'x}{', EMBEDED_SETTINGS: settings }) + ');' + SRC;

for (const [name, text] of [['deployed by the app', appStyle], ['redeployed by the panel itself', selfStyle]]) {
    const prefix = workers.bpbPrefix(text);
    t('BPB prefix found — ' + name, !!prefix);
    t('BPB prefix keeps the settings intact — ' + name,
        !!prefix && JSON.parse(prefix.slice(prefix.indexOf('{'), prefix.lastIndexOf('}') + 1)).EMBEDED_SETTINGS.securePath === 'sp');
    t('BPB source is what is left after the prefix — ' + name, workers.stripBpbPrefix(text) === SRC);
}

t('BPB prefix: braces inside strings do not confuse it',
    JSON.parse(workers.bpbPrefix(appStyle).slice(workers.bpbPrefix(appStyle).indexOf('{'),
        workers.bpbPrefix(appStyle).lastIndexOf('}') + 1)).EMBEDED_SETTINGS.proxyIPs[0] === 'x{y}z');
t('BPB prefix: a script without one gives null', workers.bpbPrefix('const a = 1;') === null);
t('BPB prefix: an assignment that is not the panel settings gives null',
    workers.bpbPrefix('Object.assign(globalThis, {"other":1});x') === null);
t('BPB prefix: an unterminated object gives null',
    workers.bpbPrefix('Object.assign(globalThis, {"EMBEDED_SETTINGS":{') === null);

// codeFor must refuse rather than deploy a panel with no settings.
(async () => {
    let refused = false;
    try { await workers.codeFor(catalog.BY_ID.bpb, 'const nothing = 1;'); } catch (e) { refused = /تنظیمات/.test(e.message); }
    t('BPB update refuses a panel whose settings cannot be read', refused);

    // and the whole assembly: prefix carried, body replaced.
    const built = await workers.codeFor(catalog.BY_ID.bpb, appStyle);
    const bundled = fs.readFileSync(catalog.appFile(catalog.BY_ID.bpb.bundled.file), 'utf8');
    t('BPB update carries the deployed prefix', built.startsWith(workers.bpbPrefix(appStyle)));
    t('BPB update body is exactly the version being installed', workers.stripBpbPrefix(built) === bundled);

    // ── what the store will and will not offer ───────────────────────────────
    const zeus = catalog.BY_ID.zeus;
    t('an older Zeus is an update', workers.compareToTarget(zeus, '1.11.8') === -1);
    t('the pinned Zeus is current', workers.compareToTarget(zeus, '2.2.0') === 0);
    t('a newer-than-pinned Zeus is not downgraded', workers.compareToTarget(zeus, '2.3.0') === 1);
    t('an unreadable version compares as unknown', workers.compareToTarget(zeus, 'who knows') === null);

    const dns = catalog.BY_ID.dns;
    t('integer-versioned workers compare too', workers.compareToTarget(dns, 1) === -1 && workers.compareToTarget(dns, 2) === 0);

    const edge = catalog.BY_ID.edge;
    t('edge compares by build date', workers.compareToTarget(edge, '2026-08-11 14:45:22') === -1);

    // ── the refusals that protect someone else's worker ──────────────────────
    const fake = { id: 'x', token: 'nope', email: '' };
    let msg = '';
    try { await workers.update(fake, 'whatever'); } catch (e) { msg = e.message; }
    t('an update with a dead credential fails before touching anything', !!msg, msg);

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    process.exit(failed ? 1 : 0);
})();
