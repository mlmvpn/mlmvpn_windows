/*
 * The configs Xray refuses to BUILD — and why they have to be caught by name, one node at a time.
 *
 * Xray constructs every outbound in a file up front and refuses the whole file if a single one
 * is unrepresentable. The delay testers put many nodes in one core, so one bad entry does not
 * fail alone: it takes its neighbours with it, the core exits, no inbound ever binds, and every
 * node in the page reads as dead. That failure is invisible from the outside — a page of twenty
 * perfectly good servers and one poisoned one looks exactly like twenty dead servers.
 *
 * It has now happened four times, with four different causes, and this suite is the list. The
 * most recent one emptied «اتصال سریع» completely: measured on the live feed, 150 of 983 vless
 * entries were plaintext to a public address, which is a 92% chance that any random page of
 * twenty contained at least one. 161 hosts had an open port; exactly one of them was ever
 * measured.
 *
 * Every rule here was checked against the core itself (`xray -test -config`), not read off an
 * error message — the plaintext-vless message says «unless the server address is a private IP
 * or domain», and a domain is in fact refused just as a public IP is.
 */

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { parseVlessUri } = require(path.join(ROOT, 'xray-manager'));

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

const UUID = '11111111-1111-1111-1111-111111111111';
const accepts = (uri) => { try { parseVlessUri(uri); return true; } catch (e) { return false; } };
const refusal = (uri) => { try { parseVlessUri(uri); return null; } catch (e) { return e.message; } };

// ── plaintext vless (2026-09-20) ─────────────────────────────────────────────────────────

t('plaintext vless to a public IP is refused, as the core refuses it',
    !accepts(`vless://${UUID}@1.2.3.4:8080?type=tcp&security=none#x`),
    refusal(`vless://${UUID}@1.2.3.4:8080?type=tcp&security=none#x`));

t('…and to a DOMAIN too — the core refuses that as well, whatever its message implies',
    !accepts(`vless://${UUID}@example.com:8080?type=tcp&security=none#x`));

t('…while a private address is allowed, which is the core\'s actual exemption',
    accepts(`vless://${UUID}@192.168.1.5:8080?type=tcp&security=none#x`)
    && accepts(`vless://${UUID}@127.0.0.1:8080?type=tcp&security=none#x`));

t('a hostname that merely starts like a ULA is not mistaken for one',
    !accepts(`vless://${UUID}@fdn-server.example:8080?type=tcp&security=none#x`));

t('reality needs no TLS and stays usable',
    accepts(`vless://${UUID}@1.2.3.4:8080?type=tcp&security=reality&pbk=abc#x`));

t('a TLS port auto-corrects to tls, so ordinary feed entries are untouched',
    accepts(`vless://${UUID}@1.2.3.4:443?type=tcp&security=none#x`));

t('trojan is not caught by the vless rule',
    accepts(`trojan://password@1.2.3.4:8080?type=tcp&security=none#x`));

// ── the three that came before it ────────────────────────────────────────────────────────

t('a protocol the core cannot speak is refused by name, not walked into the vless path',
    !accepts('hysteria2://user@1.2.3.4:443?sni=x#y'),
    refusal('hysteria2://user@1.2.3.4:443?sni=x#y'));

t('a transport this core version does not have is refused',
    !accepts(`vless://${UUID}@1.2.3.4:443?type=kcp2&security=tls#x`));

t('a URI with no user id is refused rather than built with an empty one',
    !accepts('vless://1.2.3.4:443?type=tcp&security=tls#x'));

// Xray accepts a short arbitrary string as a user id and hashes it, so `normalizeXrayId` lets
// those through on purpose. What must NOT get through is something UUID-shaped that is not a
// UUID — the core rejects that outright («common/uuid: invalid UUID») and takes the file with it.
t('a short non-UUID id is allowed, because the core hashes it',
    accepts('vless://mysecretid@1.2.3.4:443?type=tcp&security=tls#x'));

t('…but a UUID-LENGTH string that is not hex is refused, which is the one the core chokes on',
    !accepts('vless://zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz@1.2.3.4:443?type=tcp&security=tls#x'),
    refusal('vless://zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz@1.2.3.4:443?type=tcp&security=tls#x'));

// ── and the shape that makes any of them survivable ──────────────────────────────────────
//
// Catching them by name is the first defence. The second is that no tester may put a whole page
// of nodes at the mercy of one entry — see xray-tester.js, which halves a page whose core did
// not come up, down to one core per node.

const tester = require(path.join(ROOT, 'xray-tester'));
t('the tester still halves a failing page rather than losing it',
    tester.PAGE_SIZE > tester.MIN_PAGE && tester.MIN_PAGE >= 1,
    `PAGE_SIZE=${tester.PAGE_SIZE} MIN_PAGE=${tester.MIN_PAGE}`);

t('«اتصال سریع» measures through that tester, not through a shared core',
    require('fs').readFileSync(path.join(ROOT, 'quick-connect.js'), 'utf8').includes('xrayTester.testNodes'));

// ── report ───────────────────────────────────────────────────────────────────────────────
let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
