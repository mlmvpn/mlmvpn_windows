// «مسیر برنامه‌ها» — per-app routing in the full-system tunnel (app-routing.js + tun-manager).
//
// Android's split tunnel on Windows: every app, only the chosen ones, or everyone except the
// chosen ones — as sing-box `process_name` rules. Rule ORDER is the behaviour (first match wins),
// so these pin where each rule lands, what `final` becomes, and that the engine's own process can
// never be routed back into itself. The generated configs also go through `sing-box check`.
//
// USERPROFILE points at a throwaway directory, so the real ~/.mlmvpn is never read or written.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'mlmvpn-approute-'));
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;

const routing = require(ROOT + '/app-routing');
const tun = require(ROOT + '/tun-manager');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const idx = (cfg, pred) => cfg.route.rules.findIndex(pred);

// ── the saved choice ──
let s = routing.sanitize({ mode: 'nonsense', apps: [{ exe: 'Chrome.EXE', name: 'Chrome' }] });
t('an unknown mode falls back to "every app"', s.mode === 'all');
t('exe names are compared case-insensitively', s.apps[0].exe === 'chrome.exe');
s = routing.sanitize({ mode: 'bypass', apps: [
    { path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', name: 'Chrome' },
    { exe: 'chrome.exe' },
    { exe: 'xray.exe' }, { exe: 'aether.exe' }, { exe: 'sing-box.exe' },
    { exe: 'not-an-exe.txt' }, { exe: '' },
] });
t('a path is reduced to its exe name, and a duplicate is dropped', s.apps.length === 1 && s.apps[0].exe === 'chrome.exe', JSON.stringify(s.apps));
t('the engines are never routable, whatever is saved', !s.apps.some(a => ['xray.exe', 'aether.exe', 'sing-box.exe'].includes(a.exe)));
routing.set({ mode: 'allow', apps: [{ exe: 'telegram.exe' }] });
t('it round-trips through its file', routing.get().mode === 'allow' && routing.get().apps[0].exe === 'telegram.exe');
fs.writeFileSync(routing.FILE, '{ broken');
t('a broken file means "every app", not a crash', routing.get().mode === 'all' && routing.get().apps.length === 0);

// ── the rules ──
const bypass = { mode: 'bypass', apps: [{ exe: 'telegram.exe' }, { exe: 'steam.exe' }] };
const allow = { mode: 'allow', apps: [{ exe: 'chrome.exe' }, { exe: 'v2rayn.exe' }] };
let r = routing.tunRules('aether', 'aether.exe', bypass);
t('bypass → the chosen apps go direct', r.rules.length === 1 && r.rules[0].outbound === 'direct' && r.exes.join() === 'telegram.exe,steam.exe' && r.rules[0].process_path_regex.length === 2 && r.final === null);
r = routing.tunRules('v2ray', 'xray.exe', allow);
t('allow → the chosen apps go to the engine, and final becomes direct', r.rules[0].outbound === 'v2ray' && r.final === 'direct');
{
    // AN EMPTY ALLOW-LIST IS AN UNFINISHED SETTING, NOT «CARRY NOTHING».
    //
    // This used to assert the literal reading — `final: 'direct'`, no rules, so the tunnel carries
    // nothing — and that reading shipped. Measured on the user's machine 2026-09-13: saved state
    // {"mode":"allow","apps":[]}, so every full tunnel came up, took the default route and sent
    // every connection out on the real interface. Worse than not tunnelling, because DNS was still
    // answered through the engine: filtered names resolved to their REAL addresses and were then
    // dialled direct, where the line refuses them. Ordinary sites loaded, every blocked one did
    // not, and whichever engine was selected took the blame.
    //
    // The state is one click away — the list is empty until something is added — so it now behaves
    // as «not configured yet».
    const empty = routing.tunRules('v2ray', 'xray.exe', { mode: 'allow', apps: [] });
    t('allow with nobody chosen is an UNFINISHED setting, so everything is tunnelled',
        empty.final === null && empty.rules.length === 0);
    t('…and it is still distinguishable from «every app», so the caller can say what it did',
        empty.mode === 'allow-empty');
    t('allow with somebody chosen is unaffected — still only those, everything else direct',
        routing.tunRules('v2ray', 'xray.exe', { mode: 'allow', apps: [{ exe: 'chrome.exe' }] }).final === 'direct');
}
t('the engine process is excluded even if it was saved by hand',
    !routing.tunRules('aether', 'aether.exe', { mode: 'bypass', apps: [{ exe: 'aether.exe' }, { exe: 'a.exe' }] }).rules[0].process_path_regex.some(x => /aether/.test(x)));
{
    // sing-box matches process_name case-sensitively; the saved names are lowercase. The pattern
    // must catch the real file name whatever its case, and only that file name.
    const re = routing.exeMatcher(['telegram.exe']).process_path_regex[0];
    const goRe = new RegExp(re.replace('(?i)', ''), 'i');
    t('a lowercase choice matches the real, capitalised file name', goRe.test(String.raw`C:\Users\u\AppData\Roaming\Telegram Desktop\Telegram.exe`));
    t('…and only that name, not one ending the same way', !goRe.test(String.raw`C:\x\MyTelegram.exe`) && !goRe.test(String.raw`C:\x\telegram.exe.bak`));
}
t('every app → nothing added', routing.tunRules('aether', 'aether.exe', { mode: 'all', apps: [{ exe: 'a.exe' }] }).rules.length === 0);

// ── the full tunnel ──
const full = (appRouting, extra = {}) => tun.buildTunConfig(20808, Object.assign({ processName: 'xray.exe', engineTag: 'v2ray', uplinkCidrs: [], appRouting }, extra));
let c = full(routing.tunRules('v2ray', 'xray.exe', bypass));
const own = idx(c, r => Array.isArray(r.process_name) && r.process_name.includes('xray.exe'));
const byp = idx(c, r => Array.isArray(r.process_path_regex) && r.process_path_regex.some(x => x.includes('telegram')));
const dns = idx(c, r => r.action === 'hijack-dns');
t('full/bypass: the engine\'s own exclusion still comes first', own >= 0 && own < byp, `own=${own} bypass=${byp}`);
t('full/bypass: the chosen apps leave BEFORE DNS is captured (nothing of theirs enters)', byp >= 0 && byp < dns, `bypass=${byp} dns=${dns}`);
t('full/bypass: final is still the engine — every other app stays fail-closed', c.route.final === 'v2ray');

c = full(routing.tunRules('v2ray', 'xray.exe', allow), { supportsUdp: false });
const alw = idx(c, r => r.outbound === 'v2ray' && Array.isArray(r.process_path_regex));
const dns2 = idx(c, r => r.action === 'hijack-dns');
t('full/allow: the chosen apps are routed AFTER DNS capture, so their lookups stay in the tunnel', alw > dns2, `allow=${alw} dns=${dns2}`);
t('full/allow: everything else ends on direct', c.route.final === 'direct');
t('full/allow: QUIC is refused only for the chosen apps, not for the whole machine',
    c.route.rules.some(r => r.protocol === 'quic' && r.action === 'reject' && Array.isArray(r.process_path_regex))
    && !c.route.rules.some(r => r.protocol === 'quic' && r.action === 'reject' && !r.process_path_regex));
t('full/every app: config unchanged (final is the engine, no process rules but its own)',
    full(undefined).route.final === 'v2ray' && full(undefined).route.rules.filter(r => r.process_name).length === 1);

// ── the smart tunnel ──
const smart = (appRouting) => tun.buildSmartTunConfig(20810, { processName: 'aether.exe', dohUrl: 'https://x.example/dns-query', appRouting });
c = smart(routing.tunRules('proxy', 'aether.exe', bypass));
t('smart/bypass: before DNS capture', idx(c, r => r.process_path_regex && r.process_path_regex.some(x => x.includes('steam'))) < idx(c, r => r.action === 'hijack-dns'));
c = smart(routing.tunRules('proxy', 'aether.exe', allow));
t('smart/allow: chosen apps to the engine, then final direct', idx(c, r => r.outbound === 'proxy' && r.process_path_regex) > idx(c, r => r.action === 'hijack-dns') && c.route.final === 'direct');

// ── the builders are handed the choice by startTun (and the V2Ray resolver with it) ──
const src = fs.readFileSync(ROOT + '/tun-manager.js', 'utf8');
const startTunBody = src.slice(src.indexOf('async function startTun('));
t('startTun forwards the saved per-app choice to both builders', (startTunBody.match(/\bappRouting,\r?\n/g) || []).length >= 2);
t('startTun forwards the measured resolver (remoteDns) to the full-tunnel builder', /remoteDns: options\.remoteDns/.test(startTunBody));

// ── sing-box itself accepts every shape ──
const box = path.join(ROOT, 'core', 'sing-box.exe');
if (fs.existsSync(box)) {
    const shapes = {
        'full/bypass': full(routing.tunRules('v2ray', 'xray.exe', bypass)),
        'full/allow': full(routing.tunRules('v2ray', 'xray.exe', allow), { supportsUdp: false }),
        'smart/bypass': smart(routing.tunRules('proxy', 'aether.exe', bypass)),
        'smart/allow': smart(routing.tunRules('proxy', 'aether.exe', allow)),
    };
    for (const [name, cfg] of Object.entries(shapes)) {
        const f = path.join(SANDBOX, name.replace('/', '-') + '.json');
        fs.writeFileSync(f, JSON.stringify(cfg));
        let ok = true, out = '';
        try { execFileSync(box, ['check', '-c', f], { encoding: 'utf8', stdio: 'pipe' }); } catch (e) { ok = false; out = String(e.stderr || e.stdout || e.message).trim().split('\n').pop(); }
        t(`sing-box check accepts ${name}`, ok, out);
    }
}

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) {}
process.exit(failed ? 1 : 0);
