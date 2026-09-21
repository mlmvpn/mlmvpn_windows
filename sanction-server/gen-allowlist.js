#!/usr/bin/env node
// Generates the nginx stream allowlist map from sanction-domains.json.
// Output: /etc/nginx/sanction-allowlist.map  (map $ssl_preread_server_name $sanction_allowed)
// Only 'light' + 'test' tiers are allowed. 'blocked_download' patterns are NEVER added,
// so they fall through to the default (0 = blackhole).

const fs = require('fs');
const path = require('path');

const SRC = process.argv[2] || '/opt/sanction/sanction-domains.json';
const OUT = process.argv[3] || '/etc/nginx/sanction-allowlist.map';

const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
const lines = [];
lines.push('# AUTO-GENERATED from sanction-domains.json — do not edit by hand.');
lines.push('map $ssl_preread_server_name $sanction_allowed {');
lines.push('    hostnames;');
lines.push('    default 0;');

let count = 0;
for (const cat of Object.keys(data)) {
    if (cat.startsWith('_') || cat === 'blocked_download') continue;
    for (const svc of data[cat]) {
        for (const d of svc.domains) {
            lines.push(`    ${d} 1;`);
            count++;
        }
    }
}
lines.push('}');
fs.writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`allowlist map written: ${count} domains -> ${OUT}`);
