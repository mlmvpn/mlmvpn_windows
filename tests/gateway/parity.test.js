// «هرچی امکانات اونجا هست اینجا هم توی ویندوز باید باشه» — the gateway, Android ↔ Windows.
//
// The Android app's gateway tab (android/…/ui/VpnGateTab.kt + VpnGateServersScreen.kt + the
// engines/vpngate package) grew a whole feature set this window never had: the archive, the
// curation over it, a real handshake test, search, a country filter, seven sort orders, bulk
// select, «حذف خراب‌ها» with an undo, a per-server page and a guide. On 2026-09-21 all of it was
// built here.
//
// This suite is the list itself, kept executable. Each row names one capability, where it lives
// on Android, and what must exist on Windows for it to be real — so a change that
// quietly drops one fails here instead of being discovered by the user.
//
// The Android side is checked only when the sources are present; a checkout without `android/`
// still verifies the Windows half.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return null; } };

const manager = read('gateway-manager.js') || '';
const probe = read('gateway-probe.js') || '';
const panel = read('public/components/gateway.js') || '';
const server = read('server.js') || '';

const A = 'android/app/src/main/java/com/mlmvpn/scanner';
const androidTab = read(`${A}/ui/VpnGateTab.kt`);
const androidList = read(`${A}/ui/VpnGateServersScreen.kt`);
const androidPool = read(`${A}/engines/vpngate/VpnGatePool.kt`);
const androidProbe = read(`${A}/engines/vpngate/SoftEtherProbe.kt`);
const haveAndroid = !!(androidTab && androidList && androidPool && androidProbe);

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

/**
 * One capability. `android` is the proof it exists there; `windows` the proof it exists here.
 * Both are lists of [source, pattern] — every one of them must match.
 */
function parity(name, android, windows) {
    const missWin = windows.filter(([src, re]) => !re.test(src)).length;
    if (haveAndroid) {
        const missAnd = android.filter(([src, re]) => !src || !re.test(src)).length;
        if (missAnd) {
            // The Android side moved. That is not a Windows failure, but it does mean this row no
            // longer proves what it claims, so say so rather than passing quietly.
            t(name + ' — (مرجع اندروید عوض شده؛ این ردیف را به‌روز کنید)', false, 'android pattern missed');
            return;
        }
    }
    t(name, missWin === 0, missWin ? `${missWin} pattern(s) missing on Windows` : '');
}

t('the Android gateway sources are present to compare against', haveAndroid,
    haveAndroid ? '' : 'android/ not in this checkout — Windows-only assertions still ran');

// ── 1. the archive, and the two lists over it ────────────────────────────────────────────────
parity('«آرشیو» — every relay ever seen is kept, not replaced',
    [[androidPool, /object VpnGatePool/], [androidPool, /suspend fun merge\(/]],
    [[manager, /function lists\(\)/], [manager, /function mergeLists\(/], [manager, /archive/]]);

parity('«فهرست من» — live + kept − hidden, and the connect button chooses from it',
    [[androidTab, /val servers = remember\(live, kept, hidden\)/]],
    [[manager, /const mine = archive\.filter/], [manager, /function liveHosts\(\)/],
    [panel, /data-gw-scope="mine"/], [panel, /data-gw-scope="archive"/]]);

parity('promoting a relay out of the archive («افزودن به فهرست من»)',
    [[androidPool, /fun keep\(/]],
    [[manager, /function keep\(hosts\)/], [server, /case 'keep':/], [panel, /'keep'/]]);

parity('deleting from «فهرست من» is a deny-list, so a refresh cannot undo it',
    [[androidPool, /fun hide\(/], [androidPool, /suspend fun banAndPurge\(/]],
    [[manager, /function hide\(hosts\)/], [manager, /cur\.hidden/], [server, /case 'hide':/]]);

parity('deleting from «آرشیو» removes the row itself',
    [[androidPool, /suspend fun purge\(/]],
    [[manager, /function purge\(hosts\)/], [server, /case 'purge':/]]);

parity('«بازگرداندن حذف‌شده‌ها» — the undo a bulk delete must have',
    [[androidPool, /fun clearHidden\(/], [androidTab, /clearHidden/]],
    [[manager, /function restoreHidden\(\)/], [server, /case 'restore':/], [panel, /بازگرداندن/]]);

// ── 2. the two tests ─────────────────────────────────────────────────────────────────────────
parity('«پینگ» over a whole list, with progress',
    [[androidTab, /fun startPing\(/]],
    [[manager, /startSweep\(/], [manager, /'ping'/], [panel, /data-gw-act="ping"/]]);

parity('«تست واقعی» — a real SoftEther handshake, not a TCP connect',
    [[androidProbe, /object SoftEtherProbe/], [androidProbe, /vpnsvc\/connect\.cgi/]],
    [[probe, /vpnsvc\/connect\.cgi/], [probe, /WATERMARK/], [probe, /function readPack/],
    [panel, /data-gw-act="probe"/]]);

parity('…and it says WHICH step failed, not merely that it did',
    [[androidProbe, /enum class Failure \{ UNREACHABLE, TLS_BLOCKED, NOT_SOFTETHER, REFUSED, TIMEOUT \}/]],
    [[probe, /REASONS/], [panel, /PROBE_FAIL/], [panel, /TLS بسته است/]]);

parity('…and an untrusted certificate is accepted, because volunteer relays are self-signed',
    [[androidProbe, /trustAllFactory/]],
    [[probe, /rejectUnauthorized: false/]]);

parity('…and an SNI is sent, because a nameless hello dies on Iranian operators',
    [[androidProbe, /SNIHostName/]],
    [[probe, /function sniFor/], [probe, /servername: sniFor\(host\)/]]);

parity('the sweep reports progress and can be stopped',
    [[read(`${A}/engines/vpngate/VpnGateSweep.kt`), /fun cancel\(\)/]],
    [[manager, /function cancelSweep\(\)/], [manager, /function sweepState\(\)/],
    [server, /\/api\/gateway\/test\/cancel/], [panel, /data-gw-act="stop"/], [panel, /gw-sweep/]]);

// ── 3. finding a relay in a list of hundreds ─────────────────────────────────────────────────
parity('search over country name, code and hostname',
    [[androidList, /state\.query/]],
    [[panel, /id="gw-q"/], [panel, /countryName\(r\.cc\)\.toLowerCase\(\)\.indexOf\(q\)/]]);

parity('a country filter, multi-select',
    [[read(`${A}/ui/VpnGateCountryScreen.kt`), /fun VpnGateCountryScreen/]],
    [[panel, /renderCountries/], [panel, /st\.countries/], [panel, /data-cc=/]]);

parity('seven sort orders, each with its own explanation',
    [[androidList, /enum class GatewaySort/]],
    [[panel, /const SORTS = \[/], [panel, /tested_first|تست‌شده‌ها اول/], [panel, /رسمی‌ها اول/],
    [panel, /سریع‌ترین/], [panel, /امتیاز/], [panel, /پهنای باند/], [panel, /کاربران/], [panel, /کشور/]]);

// ── 4. acting on many at once ────────────────────────────────────────────────────────────────
parity('«انتخاب» — bulk select, with «سالم‌ها» to check the proven ones',
    [[androidList, /state\.selecting/], [androidList, /onCheckHealthy/]],
    [[panel, /st\.selecting/], [panel, /data-gw-act="check-healthy"/], [manager, /function healthyHosts\(/]]);

parity('«حذف سرورهای قطع» removes only what a test condemned, never the untested',
    [[androidList, /val dead = remember/]],
    [[manager, /function deadHosts\(/], [panel, /function deadOf\(/], [panel, /data-gw-act="remove-dead"/]]);

parity('…and a bulk delete asks first, with the count and what it means',
    [[androidList, /confirmRemove/]],
    [[panel, /function confirmRemove\(/], [panel, /uiModal\.confirm/]]);

// ── 5. the per-server page ───────────────────────────────────────────────────────────────────
parity('a page per relay: both measurements, the relay\'s own facts, and the actions',
    [[read(`${A}/ui/VpnGateInfoScreens.kt`), /fun GatewayServerDetailScreen/]],
    [[panel, /function renderDetail\(\)/], [panel, /سیاست نگهداری لاگ/], [panel, /گردانندهٔ سرور/],
    [panel, /مدت روشن بودن/], [manager, /logType:/], [manager, /operator:/], [manager, /uptimeMs:/]]);

parity('«راهنمای سرورها» — what the two lists are, what the two tests mean',
    [[read(`${A}/ui/VpnGateInfoScreens.kt`), /fun GatewayHelpScreen/]],
    [[panel, /function renderGuide\(\)/], [panel, /دو فهرست/], [panel, /دو تست/]]);

// ── 6. the list's own state ──────────────────────────────────────────────────────────────────
parity('«به‌روزرسانی فهرست» says how old the list is, and warns when it is stale',
    [[androidTab, /private fun listAge/], [androidTab, /private fun isListStale/]],
    [[panel, /function ago\(/], [panel, /const STALE_MS/], [manager, /fetchedAt = Date\.now\(\)/]]);

parity('…and how many relays the refresh newly discovered',
    [[androidTab, /newlyDiscoveredFlow/]],
    [[panel, /سرور تازه پیدا شد/], [manager, /added: Math\.max\(0, added\)/]]);

// ── 7. the session ───────────────────────────────────────────────────────────────────────────
parity('«شتاب‌دهی UDP» — a switch, refused mid-session',
    [[androidTab, /udpAcceleration/]],
    [[manager, /function setUdp\(on\)/], [manager, /function applyUdpOff\(/],
    [server, /\/api\/gateway\/udp/], [panel, /id="gw-udp"/]]);

parity('a session clock',
    [[androidTab, /formatDuration/]],
    [[panel, /function duration\(/], [panel, /مدت اتصال/]]);

parity('a relay is chosen for the user rather than leaving the button blank',
    [[androidTab, /LaunchedEffect\(servers\)/]],
    [[manager, /function suggest\(\)/], [server, /suggested: gateway\.suggest\(\)/]]);

parity('switching relay while connected MOVES the tunnel',
    [[androidTab, /if \(wasConnected\) \{/]],
    [[panel, /was\.connected && was\.host !== host/]]);

// ── the UDP switch, reported on 2026-09-21 ─────────────────────────────────────────

// «چک باکس افتاده زیر سوئیچ» — a raw <input type="checkbox"> wrapped in a <span class="mv-switch">
// draws BOTH: the span's own pill from page-kit, and an unstyled native checkbox beside the knob.
// The app's switch is one control: `input.mv-switch-input`, a real checkbox with appearance:none.
{
    // What RENDERS, so the note explaining the old mistake does not count as the old mistake.
    const markup = panel.replace(/<!--[\s\S]*?-->/g, '');
    t('the UDP switch is the app own control, not a checkbox wrapped in one',
        /<input type="checkbox" id="gw-udp" class="mv-switch-input"/.test(markup)
        && !/<span class="mv-switch">/.test(markup));
}
t('…and page-kit really styles that class, so the markup is not merely different',
    /input\.mv-switch-input \{[^}]*appearance:\s*none/.test(read('public/ui/page-kit.css') || ''));

// «خود سیستم udp باید دقیق و درست کار کنه» — a switch is an intention; whether the UDP
// channel came up is a fact, and on a filtered line they differ. SoftEther opens that channel
// seconds AFTER the SSL one, and only if both ends can reach each other over UDP.
parity('the panel reports whether the UDP channel is REALLY up, not what the switch says',
    [[androidTab, /isUdpAccelerationActive\(\)/], [androidTab, /udpActive/]],
    [[manager, /function readUnderlay\(st\)/], [manager, /udpActive: state\.udpActive/],
    [panel, /function udpWords\(s\)/], [panel, /s\.udpActive === true/]]);
t('…and an unanswered poll leaves the last known state alone instead of reporting «off»',
    /if \(act !== null\) state\.udpActive = act;/.test(manager));
t('…and the rows are matched by pattern, because vpncmd is localised',
    /\/udp\/i\.test\(k\) && \/activ\/i\.test\(k\)/.test(manager));
t('…and a new session starts from «not yet known», not from the last session answer',
    (manager.match(/state\.udpActive = null;/g) || []).length >= 2);
// AND THE SWITCH MUST ACTUALLY DO SOMETHING. `AccountImport` does not replace an account of the
// same name — it adds one and renames it. Importing over a live setting therefore left
// «MLMVPN_GATEWAY» untouched beside a new «MLMVPN_GATEWAY (2)» carrying the edit, the connect
// dialled the original with acceleration still on, and the stray accumulated in the user's own
// SoftEther client, one per connect. Measured: two imports gave «(2)» and «(3)» and the
// re-export still read `false`.
t('the account is deleted before it is re-imported, or the edit lands on a renamed copy',
    /const del = vc\('AccountDelete', ACCOUNT\);[\s\S]{0,200}vc\('AccountImport', file\)/.test(manager));
t('…and a failed import puts the original account back, rather than leaving none',
    /fs\.writeFileSync\(file, text, .utf8.\);[\s\S]{0,60}vc\(.AccountImport., file\);/.test(manager));
t('…and the result is PROVED by re-reading it, not trusted from an exit code',
    /throw new Error\('setting did not take'\)/.test(manager)
    && /vc\('AccountExport', ACCOUNT, `\/SAVEPATH:\$\{back\}`\)/.test(manager));
t('…and strays from an interrupted run are swept before a new session is built',
    /function sweepStrayAccounts\(\)/.test(manager) && /const strays = sweepStrayAccounts\(\);/.test(manager));
t('…and the sweep only ever removes accounts that are ours by name',
    /line\.match\(\/\\\|\\s\*\(MLMVPN_GATEWAY \\\(\\d\+\\\)\)\\s\*\$\/\)/.test(manager));

t('the session card names the path the traffic is really on',
    /مسیر واقعی داده/.test(panel) && /underlay/.test(manager));

// ── the Windows half only: it must look like the rest of THIS app ────────────────────────────
//
// «کاربر نباید حس کنه دوتا اپ جدا هست». Android's screens are iOS-shaped; this window wears the
// page kit every other engine here wears, and its dialog is the app's own, never the browser's.
t('the panel is built from the page kit, like every other engine window',
    /class="mv-split"/.test(panel) && /mv-eng-stage/.test(panel) && /mv-side-item/.test(panel));
t('…its flags are SVG, because Windows renders emoji flags as boxed letters',
    /assets\/flags\//.test(panel) && !/getNodeFlagEmoji/.test(panel));
t('…its country names come from Intl, not from a hand-written table of two dozen',
    /Intl\.DisplayNames\(\['fa'\]/.test(panel));
// ── the two the user reported on 2026-09-21 ─────────────────────────────────────────────────

// «دکمهٔ برگشت کار نمیکند» — and it was invisible to every scripted test, because
// `element.click()` bypasses hit-testing.
//
// In a split window `.mv-win.is-split .mv-win-bar` is a transparent `position:absolute` strip
// across the whole top at `z-index:5`, lying over the pane's own bar so the empty parts of that
// band still drag the window. page-kit pokes the interactive islands back through it with
// `.mv-pane-nav { z-index:6 }`. A wrapper with `position:relative` AND a z-index — even 0 — is a
// stacking context, and that is a ceiling: the nav's 6 becomes 6 inside a box whose own level is
// 0, which loses to 5. `document.elementFromPoint` over the button returned `mv-win-bar`.
{
    const css = (panel.match(/#gw-wrap \{[^}]*\}/) || [''])[0];
    t('the panel wrapper creates no stacking context, or the back button is unclickable',
        /position:\s*relative/.test(css) && !/z-index/.test(css), css);
    t('…and page-kit still lifts the nav over the window drag strip',
        /\.mv-pane-nav \{[^}]*z-index:\s*6/.test(read('public/ui/page-kit.css') || ''));
}

// «حذف سرورهای بسته و اونایی که در دسترس نیست رو نزاشتی» — it existed, and was
// buried behind an unlabelled icon that turned on a selection mode. A destructive action nobody
// can find is the same as one that was never built.
{
    const tb = (panel.match(/<div class="gw-tb">[\s\S]*?<\/div>/) || [''])[0];
    t('«حذف خراب‌ها» is in the toolbar itself, not behind a mode',
        /data-gw-act="remove-dead"/.test(tb) && /حذف خراب‌ها/.test(tb), tb ? '' : 'toolbar not found');
    t('…and it says how many it is about to remove', /حذف خراب‌ها · \$\{fa\(dead\.length\)\}/.test(panel));
    t('…and it is absent when nothing has failed, rather than offering a no-op',
        /\$\{dead\.length \? `<button type="button" data-gw-act="remove-dead"/.test(panel));
    t('«انتخاب» is a labelled control too, not a bare glyph in the title band',
        /data-gw-act="select"/.test(tb) && !/gw-select-btn/.test(panel));
}

t('…and every string the user reads is Persian',
    /جست‌وجوی کشور یا نام سرور/.test(panel) && /تست واقعی/.test(panel) && /فهرست من/.test(panel));

let failed = 0;
for (const r of results) {
    if (!r.pass) failed++;
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : '   -> ' + r.detail}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
assert.ok(true);
process.exit(failed ? 1 : 0);
