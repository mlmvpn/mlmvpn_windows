// «گیت‌وی MLM» — each suite in its own process.
//
// `lists.test.js` redirects USERPROFILE before requiring the manager so it cannot touch the
// user's own ~/.mlmvpn/gateway, and that redirection only holds for a process that has not
// already resolved it. Sharing one would hand the second suite the first one's home.
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
