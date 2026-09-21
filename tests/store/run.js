// «ام‌ال‌ام استور» — each suite in its own process: they set MLMVPN_STORE_ROOT and swap module
// state, which is not something to share.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const here = __dirname;
const suites = fs.readdirSync(here).filter((f) => f.endsWith('.test.js')).sort();

let failed = 0;
for (const s of suites) {
    console.log('\n══ ' + s + ' ' + '═'.repeat(Math.max(0, 56 - s.length)));
    try {
        execFileSync(process.execPath, [path.join(here, s)], { stdio: 'inherit' });
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
