// Never the user's own diary: these suites drive the real managers with a fake core, and every
// fake connect would otherwise land in ~/.mlmvpn/tunnel-events.log — see MLMVPN_HOME in
// tun-diag.js. run.js sets this too; doing it here as well is what makes running ONE file
// directly, which is how these get debugged, safe as well.
if (!process.env.MLMVPN_HOME) {
    process.env.MLMVPN_HOME = require('node:fs').mkdtempSync(
        require('node:path').join(require('node:os').tmpdir(), 'mlm-diag-'));
}
// The engine panels' one rule that is easy to break by accident, guarded statically.
//
// THE BUG THIS EXISTS FOR (reported 2026-09-15, «تونل کامل رو انتخاب میکنم، بعد از اتصال میره روی
// پروکسی»): `/start` stays open for the whole ladder — up to two minutes for سایفون — and the
// status poll runs through that window. The engine reports «connected» before the tunnel is built,
// so a repaint wrote `coverage = 'proxy'` over the user's choice, and the line that turns the
// tunnel on then read that and did nothing. The user picked «تونل کامل», waited, and got a proxy.
//
// Reproduced in a real window with a stubbed network before the fix (tun requests: none) and after
// (enabled: true). What can be held onto here is the shape of the fix:
//   1. the choice is CAPTURED before the request, not read back afterwards;
//   2. nothing overwrites it while the attempt is still in flight.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'components', 'fronts.js'), 'utf8');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

t('the coverage the user asked for is captured before /start is sent',
    /const wantTunnel = s\.coverage === 'tunnel';/.test(SRC));

t('and that captured value — not the live field — decides whether the tunnel goes up',
    /if \(r\.ok && wantTunnel\)/.test(SRC)
    && /await setTun\(id, true\);/.test(SRC)
    && !/if \(r\.ok && s\.coverage === 'tunnel'\)/.test(SRC));

// The other half of the same window: the engine answers «connected» while the tunnel is still
// being built (5–20 s, measured), and a green button there tells the user their whole system is
// tunnelled when it is not. The page has to stay in its working state until setTun returns.
t('the page says «still working» while the tunnel is coming up',
    /s\.tunPending = true;/.test(SRC) && /s\.tunPending = false;/.test(SRC)
    && SRC.indexOf('s.tunPending = true;') < SRC.indexOf('await setTun(id, true);'));

t('a repaint does not overwrite the choice while the attempt is in flight',
    /if \(status\.connected && !s\.attempting\) s\.coverage = p\.tun \? 'tunnel' : 'proxy';/.test(SRC));

// The other half of the same story: a connect that cannot be cancelled. The press must reach the
// engine from the first moment, not only once the first status poll has come back.
t('pressing again during an attempt stops the engine',
    /if \(status\.running \|\| status\.connected \|\| s\.attempting\)/.test(SRC));

const panel = require('./panel-harness')(() => Promise.resolve({ json: async () => ({}) }));
panel.st.psiphon.payload.status = {};
panel.st.psiphon.attempting = true;
panel.st.psiphon.busy = true;
panel.renderStage('psiphon');
t('the button is not disabled while an attempt is running', !panel.parts.power.disabled);

// And the reason the ring used to stutter: the stage must be built once and updated in place, or
// every status poll restarts the CSS animation.
t('the stage is built once and then updated, so the ring never restarts',
    /host\.dataset\.built !== '1'/.test(SRC) && /host\.dataset\.built = '1';/.test(SRC));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : '   -> ' + x.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
