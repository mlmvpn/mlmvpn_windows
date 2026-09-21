// «تونل گوگل اسکریپت» — each suite in its own process: they point HOME at a scratch directory
// before the store loads, and that has to happen before any require, which a shared process
// cannot guarantee.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const here = __dirname;
const suites = fs.readdirSync(here).filter((f) => f.endsWith('.test.js')).sort();

let failed = 0;
for (const s of suites) {
    console.log('\n══ ' + s + ' ' + '═'.repeat(Math.max(0, 56 - s.length)));
    try {
        // Point the tunnel diary at a scratch directory. These suites drive the real managers
        // with a fake core, and without this every fake connect lands in the user's own
        // ~/.mlmvpn/tunnel-events.log. See the note on MLMVPN_HOME in tun-diag.js.
        execFileSync(process.execPath, [path.join(here, s)], {
            stdio: 'inherit',
            env: Object.assign({}, process.env, {
                MLMVPN_HOME: fs.mkdtempSync(path.join(require('os').tmpdir(), 'mlm-diag-')),
            }),
        });
    } catch (e) {
        failed++;
    }
}

console.log('\n' + '═'.repeat(64));
if (failed) {
    console.log(`${failed} of ${suites.length} suites FAILED`);
    process.exit(1);
}
console.log(`all ${suites.length} suites passed`);
