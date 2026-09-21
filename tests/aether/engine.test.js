// Configuration validation and the log -> stage state machine.
//
// The state machine is the only thing that knows whether the tunnel is alive: the engine
// reports through stdout, and everything downstream — the front-end proxy, the DNS bridge,
// the whole-system tunnel, the kill switch — is driven off the stage this parser produces.
// A line it fails to classify is a tunnel that has died with a green badge over it.
const ROOT = require('path').resolve(__dirname, '..', '..');
const aether = require(ROOT + '/aether-manager');
const { classify, buildEnv, extractDetail } = aether._internal;

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

// ── validation ───────────────────────────────────────────────────────────────────
// Every value here reaches the engine as an environment variable and is acted on without
// further checking, so a bad one surfaces only after a full scan — or not at all.
const ok = (opts) => aether.validateOptions(opts).ok;
const errs = (opts) => aether.validateOptions(opts).errors.join(' | ');

t('a sane configuration validates', ok({ protocol: 'masque', scan: 'balanced', ip: 'v4' }));
t('an unknown protocol is rejected', !ok({ protocol: 'wireguard-nt' }), errs({ protocol: 'wireguard-nt' }));
t('an unknown scan mode is rejected', !ok({ scan: 'ludicrous' }));
t('an unknown IP mode is rejected', !ok({ ip: 'v5' }));
t('a bad log level is rejected', !ok({ logLevel: 'shout' }));
t('a bad performance profile is rejected', !ok({ perfProfile: 'turbo' }));

t('a SOCKS port outside 1-65535 is rejected', !ok({ socksPort: 70000 }) && !ok({ socksPort: 0 }));
t('a non-numeric SOCKS port is rejected', !ok({ socksPort: 'abc' }));
t("the SOCKS port cannot collide with Xray's inbound", !ok({ socksPort: 20809 }), errs({ socksPort: 20809 }));

t('a forced peer must be host:port', !ok({ peer: '162.159.198.1' }), errs({ peer: '162.159.198.1' }));
t('a forced peer with a bad port is rejected', !ok({ peer: '162.159.198.1:99999' }));
t('a valid IPv4 peer is accepted', ok({ peer: '162.159.198.1:443' }));
t('a valid bracketed IPv6 peer is accepted', ok({ peer: '[2606:4700:d0::a29f:c001]:443' }));

t('a non-numeric keepalive is rejected', !ok({ keepalive: 'yes' }));
t('keepalive 0 is allowed but WARNED about (NAT kills the tunnel silently)',
    ok({ keepalive: 0 }) && aether.validateOptions({ keepalive: 0 }).warnings.length > 0);
t('a keepalive longer than a NAT mapping is warned about',
    aether.validateOptions({ keepalive: 300 }).warnings.some(w => w.includes('NAT')));

t('a malformed in-tunnel DNS address is rejected', !ok({ dns: '1.1.1.1,999.1.1.1' }), errs({ dns: '1.1.1.1,999.1.1.1' }));
t('a valid in-tunnel DNS list is accepted', ok({ dns: '1.1.1.1,1.0.0.1' }));
t('an IPv6 in-tunnel resolver is accepted', ok({ dns: '2606:4700:4700::1111' }));
t('a bootstrap proxy that is not a URL is rejected', !ok({ bootstrapProxy: 'not a url' }));
t('a bootstrap proxy with an unsupported scheme is rejected', !ok({ bootstrapProxy: 'ftp://x:1' }));
t('a socks5 bootstrap proxy is accepted', ok({ bootstrapProxy: 'socks5://127.0.0.1:20809' }));
t('a nonsense fragment size is rejected', !ok({ fragmentSize: 'big' }));
t('a range fragment size is accepted', ok({ fragmentSize: '16-32' }));
t('fragment without HTTP/2 is warned about, not rejected',
    ok({ fragment: true, transport: 'h3' }) &&
    aether.validateOptions({ fragment: true, transport: 'h3' }).warnings.length > 0);

// ── the environment actually handed to the engine ────────────────────────────────
const env = buildEnv({ protocol: 'masque', scan: 'balanced', ip: 'v4', socksPort: 20810 });
t('the engine is told which SOCKS port to serve', env.AETHER_SOCKS === '127.0.0.1:20810');
t('the engine never blocks on the interactive quick-reconnect prompt', env.AETHER_QUICK_RECONNECT === '1');
t('a stale proxy from the parent environment cannot leak into the engine',
    env.HTTPS_PROXY === undefined && env.http_proxy === undefined);
const envProxy = buildEnv({ bootstrapProxy: 'http://127.0.0.1:20809' });
t('an explicit bootstrap proxy IS passed through', envProxy.HTTPS_PROXY === 'http://127.0.0.1:20809');

// ── stage classification ─────────────────────────────────────────────────────────
const stageOf = (line) => { const r = classify(line); return r ? r.stage : null; };

t('a listening SOCKS server means connected',
    stageOf('[+] socks5 server listening on 127.0.0.1:20810') === 'connected');
t('the engine second listening line also classifies as connected',
    stageOf('socks5 listening on 127.0.0.1:20810') === 'connected');
t('a failed handshake is a failure, not a connection',
    stageOf('[-] handshake failed: timed out') === 'failed');

// These are the lines that used to leave a green badge over a dead tunnel. The engine
// reports its inner-tunnel and pre-validation deaths WITHOUT the word "reconnect", so a
// pattern that required it missed them entirely.
t('"MASQUE tunnel closed; reconnecting" is a disconnect',
    stageOf('[-] MASQUE tunnel closed; reconnecting') === 'reconnecting');
t('"tunnel exited before validation" is a disconnect even without the word reconnect',
    stageOf('[-] tunnel exited before validation') === 'reconnecting');
t('"gool tunnel ended" is a disconnect',
    stageOf('[-] gool tunnel ended: broken pipe; reconnecting') === 'reconnecting');
t('"WireGuard tunnel closed" is a disconnect',
    stageOf('[-] WireGuard tunnel closed; reconnecting') === 'reconnecting');
t('a lost gateway search is a rescan, not a silent success',
    stageOf('[-] no usable MASQUE gateway found: all candidates failed; rescanning shortly') === 'scan');

// "trying next profile" means retrying, NOT giving up. Classifying it as fatal tears the
// session down while the engine is still working.
t('"found no data-plane endpoint ... trying next profile" is a retry, not a failure',
    stageOf("[-] profile 'gfw' found no data-plane endpoint; trying next profile") === 'scan');
t('a genuinely exhausted search IS a failure',
    stageOf('[-] prober: no clean endpoint found') === 'failed');

// ── engine 1.9.0 wording ─────────────────────────────────────────────────────────
t('1.9.0: loading a saved identity is the identity stage',
    stageOf('[+] loaded an existing identity from C:\\x\\aether-masque.toml') === 'identity');
t('1.9.0: no identity yet is provisioning',
    stageOf('[+] no identity at C:\\x\\aether.toml; provisioning a new one') === 'provision');
t('1.9.0: a refused identity being replaced is provisioning, not a failure',
    stageOf('[*] registering a fresh masque account to replace the refused identity') === 'provision'
    && stageOf('[-] the saved masque identity was refused: 401') === 'provision');
t('1.9.0: an empty scan round is a rescan, not a failure (the engine rescans by itself)',
    stageOf('[-] scan deadline reached with no gateway') === 'scan'
    && stageOf('[-] scan deadline reached with no endpoint') === 'scan');
t('1.9.0: a WireGuard tunnel gone silent is a disconnect',
    stageOf('[wg] no valid data from peer 162.159.192.1:2408 in 45s; tunnel considered dead') === 'reconnecting');
t('1.9.0: a socket that keeps failing is a disconnect',
    stageOf('recv error: connection reset; giving up after 8 consecutive transient failures') === 'reconnecting');
const note = (line) => !!aether._internal.classifyNote(line);
t('1.9.0: the camouflaged registration route is explained, not dropped',
    note('[!] registration failed over the direct route: timed out')
    && note('[*] registration retrying over a camouflaged route: random cloudflare edge address, no dns lookup, split client hello, alternate tls fingerprints')
    && note('[+] registration went through the camouflaged route (162.159.192.44)'));
t('the start banner no longer names a stale engine version',
    !/موتور وارپ v1\.6\.0/.test(require('fs').readFileSync(ROOT + '/aether-manager.js', 'utf8')));

// ── a user connect is never a measurement ────────────────────────────────────────
// The game panel's engine comparison runs the engine with a status handler that does nothing
// but report. A comparison that ended without its own stop left that mode on, and from then on
// every connect the user made reached "connected" with no Xray front end and no DNS bridge.
{
    const srv = require('fs').readFileSync(ROOT + '/server.js', 'utf8');
    const start = srv.slice(srv.indexOf("app.post('/api/aether/start'"), srv.indexOf("app.post('/api/aether/stop'"));
    const stop = srv.slice(srv.indexOf("app.post('/api/aether/stop'"), srv.indexOf("app.get('/api/aether/logs'"));
    t('/api/aether/start clears a leftover measurement mode before starting',
        /aetherMeasurementMode = false;[\s\S]*aether\.startAether\(/.test(start));
    t('/api/aether/stop clears it too', /aetherMeasurementMode = false;/.test(stop));
}

// ── every stage rule is reachable ────────────────────────────────────────────────
// Ordered most-specific-first and matched first-wins, so a broad pattern placed above a
// narrow one silently kills it. The catch-alls at the bottom are the usual suspects.
const rules = aether._internal.STAGE_RULES;
const shadowed = [];
rules.forEach((rule, i) => {
    const probe = rule.re.source
        .replace(/\\\S/g, 'x').replace(/[()?:|*+^$\[\]]/g, '')
        .replace(/\.\+|\.\*/g, 'x').replace(/\\/g, '');
    for (let j = 0; j < i; j++) {
        if (rules[j].re.test(probe) && !rule.re.test(probe)) shadowed.push(`${i} by ${j}`);
    }
});
t('no stage rule is shadowed by an earlier, broader one', shadowed.length === 0, shadowed.join(', '));

// ── detail extraction ────────────────────────────────────────────────────────────
const d = extractDetail('[+] selected MASQUE gateway 162.159.198.1:443 (rtt 84ms)');
t('the selected gateway is extracted for the UI', d && d.server === '162.159.198.1:443', JSON.stringify(d));
const d2 = extractDetail('[+] socks5 server listening on 127.0.0.1:20810');
t('the SOCKS address is extracted', d2 && d2.socks === '127.0.0.1:20810', JSON.stringify(d2));

// ── the UDP → TCP ladder ─────────────────────────────────────────────────────────
//
// MASQUE speaks HTTP/3 over QUIC (UDP) and HTTP/2 over TCP, and they fail independently.
// Measured the same hour on two Iranian mobile lines with the identical scan:
//   line A  QUIC found a gateway in 3.1s   · TCP found nothing in 120s
//   line B  QUIC found nothing in 60s      · TCP found one in 1.0s (TCP/443 was wide open)
// So neither is the right default and neither substitutes for the other.
const mgr = require('fs').readFileSync(ROOT + '/aether-manager.js', 'utf8');

// THE TRIGGER IS THE LOG LINE, NOT AN EXIT. The engine does not stop when a scan comes up
// empty — it logs "no usable MASQUE gateway found ... rescanning shortly" and sweeps again
// every 60s forever. A ladder hung off proc.on('close') therefore never runs, which is how
// the first version of this shipped doing nothing at all.
t('an empty scan is acted on from the log line',
    /no usable \(masque gateway\|wireguard endpoint\) found\|prober: no clean endpoint found/.test(mgr)
    && /handleEmptyScan\(\);/.test(mgr));
t('…and not from the process exit, which never comes',
    !/proc\.on\('close'[\s\S]*?__transportLadder/.test(mgr));
t('…only once per run, so a rescanning engine cannot restart it repeatedly',
    /emptyScanHandled \|\| !owns\(\)/.test(mgr));

t('an empty MASQUE scan retries over the other transport',
    /__transportLadder: true, transport: 'h2'/.test(mgr));
t('…the rung is chosen by what has been TRIED, not by a pin the panel always sets',
    /o\.transport !== 'h2'/.test(mgr) && !/&& !o\.transport/.test(mgr));
t('…and never twice, so the ladder cannot become a loop',
    /!o\.__transportLadder/.test(mgr));
t('the second rung does not reset the rescan budget',
    /!o\.__dudRetry && !o\.__transportLadder/.test(mgr));
// The two WireGuard engines carry data over UDP and nothing else, so no setting can help them.
t('a UDP-only engine says which door is still open instead of "no endpoint"',
    /این موتور داده را فقط روی UDP می‌برد/.test(mgr));
t('…and WireGuard really is UDP-only, which is what makes that advice true',
    !/TcpStream/.test(require('fs').readFileSync(ROOT + '/aether-src/aether/src/wireguard.rs', 'utf8')));
// h2 must reach the engine as the variable it actually reads.
t('the h2 transport is passed as AETHER_MASQUE_HTTP2',
    buildEnv({ protocol: 'masque', transport: 'h2' }).AETHER_MASQUE_HTTP2 === '1');
t('…and is absent by default, so QUIC stays the first rung',
    buildEnv({ protocol: 'masque' }).AETHER_MASQUE_HTTP2 === undefined);

// ── «وارپ» IS NOT AN AETHER PROTOCOL ANY MORE ────────────────────────────────────────────────
//
// It never was one upstream: it was added to this app, and the user's instruction on 2026-09-21
// was to make that literal — «موتور همین یکی رو جدا کن … خوبه وقتی سیستم ماسک aether خرابه این
// سالمه». So «وارپ» now has its own engine (warp-manager.js): its own Cloudflare registration,
// its own SOCKS port, its own routes, its own state, and its own idea of «connected».
//
// What these cases defend is the SEPARATION. The failure they exist for is a quiet re-merge —
// someone routing «وارپ» back through /api/aether or reading aether's state on its page, at
// which point an aether fault takes WARP down again and the whole point is lost.
const panel = require('fs').readFileSync(ROOT + '/public/components/aether.js', 'utf8');

t('«وارپ» is recognised as its own engine', /function aeIsOwnEngine\(protocol\)/.test(panel));
t('…with its own state, not the aether engine\'s', /window\.warpState/.test(panel));
t('…and the page reads whichever engine owns it', /function aeStateOf\(protocol\)/.test(panel));
t('connecting «وارپ» calls /api/warp/start, never /api/aether/start',
    /aeIsOwnEngine\(protocol\)[\s\S]{0,600}\/api\/warp\/start/.test(panel));
t('…and stopping it calls /api/warp/stop',
    /aeIsOwnEngine\(was\) \? '\/api\/warp\/stop'/.test(panel));
t('its status is fetched from its own route', /\/api\/warp\/status/.test(panel));
t('…and its live updates have their own event', /function handleWarpStatusEvent/.test(panel));
// The old translation is gone: there is no «warp» protocol for the aether engine to be told about.
t('the aether engine is never asked for a «warp» protocol',
    !/function aeEngineOpts/.test(panel) && !/AE_WARP_PEERS/.test(panel));
// The desktop lamp has to follow the same split, or a connected «وارپ» lights nothing.
const apps = require('fs').readFileSync(ROOT + '/public/shell/apps.js', 'utf8');
t('the home-screen lamp for «وارپ» reads its own engine',
    /proto === 'warp'\) return !!\(window\.warpState/.test(apps));
// And the server must not have merged the routes either.
const srv = require('fs').readFileSync(ROOT + '/server.js', 'utf8');
t('the server serves /api/warp separately', /app\.post\('\/api\/warp\/start'/.test(srv));
t('…from its own manager, which never imports aether-manager',
    /require\('\.\/warp-manager'\)/.test(srv)
    && !/require\('\.\/aether-manager'\)/.test(require('fs').readFileSync(ROOT + '/warp-manager.js', 'utf8')));

// ── the «وارپ» PAGE has to read «وارپ»'s engine, everywhere ──────────────────────────────────
//
// Reported 2026-09-21, five symptoms that were all one omission — the engine was split off but
// the page still read `aetherState` in the places that draw it:
//   · the step strip never lit up;
//   · the power button said «اتصال» while it was connected;
//   · the sidebar said «مشکل دارد» for a tunnel that was simply not routed yet;
//   · the identity card wiped aether's account, not this engine's;
//   · the scan mode and obfuscation cards went nowhere.
t('the step strip reads the page own engine', /const st = aeStateOf\(p\);[\s\S]{0,40}let current = st\.stage;/.test(panel));
t('…and the engine own stage names are mapped onto its steps', /const WARP_STAGE_ALIAS = \{/.test(panel));
t('…including the one that means «looking for a server»', /scan: 'scan', connecting: 'validate'/.test(panel));
t('…and its steps describe what it really does, scan included',
    /warp: \[[\s\S]{0,200}key: 'scan', fa: 'یافتن سرور'/.test(panel));
t('the power button offers «قطع اتصال» once connected, not «اتصال»',
    /stp\.connected && mine \? 'قطع اتصال'/.test(panel));
t('…and the bar button too', /st\.connected && mine \? 'قطع اتصال'/.test(panel));
t('a connected-but-unrouted engine is not called broken',
    /st\.connected \? 'وصل — مسیر روشن نیست' : 'مشکل دارد'/.test(panel));
t('clearing the identity clears THIS engine account',
    /aeIsOwnEngine\(aetherActiveTab\) \? '\/api\/warp\/reset-identity'/.test(panel));
t('…and the engine can do that without touching aether files',
    /async function resetIdentity\(\)/.test(require('fs').readFileSync(ROOT + '/warp-manager.js', 'utf8')));
t('the scan mode and obfuscation choices are actually sent',
    /scan: opts\.scan, ip: opts\.ip, noize: opts\.noize/.test(panel));
{
    const wm = require('fs').readFileSync(ROOT + '/warp-manager.js', 'utf8');
    t('…and the engine acts on them', /VALID_SCANS\.includes\(opts\.scan\)/.test(wm) && /opts\.noize && VALID_NOIZE\.includes/.test(wm));
    // «خالی» is about the route, not the wire — bare WireGuard measured 0 bytes in 170 s here.
    t('…but never turns the obfuscation off by itself', !/AETHER_NOIZE: 'off'/.test(wm));
    // A connect that holds the HTTP request open for two minutes is a page with nothing to show.
    t('connecting returns at once and reports the rest through status events',
        /pursue\(child, socksPort, mine\)\.catch/.test(wm) && /return \{ ok: true, pending: true/.test(wm));
}

// ── «چرا وقتی خطا نیست میزنه مشکل دارد؟» ─────────────────────────────────────────────────────
//
// Because a connected engine whose route had not been CHOSEN yet was drawn in the fault colour —
// red ring, red dot, «مشکل دارد» — for a state where nothing had gone wrong and the app had
// simply not asked the question yet. And for «وارپ» it never asked at all: `aeOfferRouting`
// looked the engine up with `aeRunningPage()`, which only knows aether's, so the sheet stayed
// shut and the user was left on a red page with no way forward.
t('the routing sheet is told WHICH engine connected', /async function aeOfferRouting\(state, page\)/.test(panel));
t('…and «وارپ» raises it the moment it connects',
    /if \(st && st\.connected && !wasConnected\) aeOfferRouting\(st, 'warp'\);/.test(panel));
t('…against that engine own state, not the aether one', /aeStateOf\(who\)\.connected/.test(panel));
t('…and closes it when the engine goes away', /if \(st && !st\.running && !st\.connected\) aeRouteSheetClose\(\);/.test(panel));
t('while the question is on screen the page stays BUSY, not broken',
    /const asking = !!\(window\.MVRouteSheet && MVRouteSheet\.isOpen\('aether'\)\);/.test(panel)
    && /if \(asking\) \{[\s\S]{0,200}tone: 'busy'/.test(panel));
// …but the dangerous case keeps its warning: the sheet is gone, nothing was chosen, and packets
// really are leaving with the real address.
t('…and turns to a real warning once it is dismissed unanswered',
    /tone: 'bad',[\s\S]{0,30}head: 'وصل است — ولی ترافیکی از آن رد نمی‌شود'/.test(panel));
t('the page is redrawn the moment the sheet closes, not at the next status event',
    /onClosed: \(\) => \{ try \{ renderAetherStatus\(\)/.test(panel)
    && /gone\.opts\.onClosed/.test(require('fs').readFileSync(ROOT + '/public/components/route-sheet.js', 'utf8')));

// ── the tunnel switch has to name the engine THIS page owns ──────────────────────────────────
//
// Reported 2026-09-21: on the «وارپ» page, with its engine off, the tunnel switch answered «اول
// یکی از موتورهای ماسک، وایرگارد یا وارپ در وارپ را وصل کنید» — three engines that have nothing
// to do with that page. The server's refusal has to list every engine that could carry the
// tunnel, so the page refuses first, by name.
t('the page refuses before calling the server when its own engine is off',
    /if \(on\) \{[\s\S]{0,400}aeStateOf\(p\)[\s\S]{0,300}!st\.connected/.test(panel));
t('…naming the engine the page owns', /اول خودِ «\$\{aeName\(p\)\}» را وصل کنید/.test(panel));
t('…and it reads the page actually on screen', /const p = aetherActiveTab;/.test(panel));
// The server still has to gate too — the switch is not the only caller.
t('the server takes whichever engine is connected, not aether alone',
    /function aetherLikeActive\(\)/.test(srv) && /warp\.getStatus\(\)\.connected/.test(srv));
t('…and asks THAT engine for the addresses to keep outside the tunnel',
    /uplinkIps: active\.mgr\.getUplinkIps\(\)/.test(srv));
t('«وارپ» can supply that list, or the tunnel would swallow its own transport',
    /getUplinkIps/.test(require('fs').readFileSync(ROOT + '/warp-manager.js', 'utf8')));

// ── «connected» has to mean traffic passes ───────────────────────────────────────────────────
//
// THE BUG THESE EXIST FOR (2026-09-20): the engine picked 162.159.192.147:859, logged
// «wireguard tunnel validated (end-to-end data confirmed)» and served SOCKS — and 60 real HTTPS
// requests through that port in a row got nothing. Its own check is two packets inside the
// tunnel; an edge can pass those and shape everything else away, and from where the scan stands
// the endpoint is healthy, so nothing ever moves. That is «وصل شد ولی هیچ صفحه‌ای باز نمی‌شود».
//
// Slowness stays opt-in — the long note above runSpeedGate explains why a speed number is too
// noisy to destroy a working tunnel over. Zero bytes is not a speed number.
t('a tunnel that carries NOTHING is thrown back even without speedGate',
    /if \(!dead && \(o\.speedGate !== true/.test(mgr));
t('…but slowness still needs speedGate, exactly as before',
    /o\.speedGate !== true \|\| r\.kbps >= speedtest\.DUD_THRESHOLD_KBPS/.test(mgr));
t('…and one failed probe is not enough: it is retried before the tunnel is dropped',
    /let dead = !r\.ok;/.test(mgr) && /const again = await speedtest\.measure\(socksPort\)/.test(mgr));
t('…a passing retry clears the verdict', /if \(again\.ok\) \{[\s\S]{0,120}dead = false/.test(mgr));
t('a dead tunnel gets its own, larger retry budget than a slow one',
    /MAX_DEAD_RETRIES = 4/.test(mgr) && /const budget = dead \? MAX_DEAD_RETRIES : MAX_DUD_RETRIES/.test(mgr));
t('…and the «no better option» shortcut does not apply to it',
    /if \(!dead && currentState\.server && rejectedGateways\.includes/.test(mgr));
t('the cached endpoint is dropped too, or the next start settles straight back on it',
    /const dropped = clearLastConnection\(\);/.test(mgr));
t('the user is told which engines can still get through when the budget runs out',
    /«وایرگارد» یا «ماسک» را امتحان کنید/.test(mgr));

let failed = 0;
for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
