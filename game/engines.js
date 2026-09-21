// --- Every engine the game tab can drive, and the lifecycle for driving it ---
//
// WHY THIS FILE EXISTS
// The first version of the accelerator, the assessment and the tournament each had their
// own idea of "an engine": boost.js knew three, session.js knew one, tournament.js knew
// three protocols. All three required the user to go to ANOTHER panel, turn Aether on by
// hand, come back, and only then press the button — and if they picked the wrong protocol
// there, the measurement silently described a different engine than the one they thought
// they were testing.
//
// The rule the user set is the opposite: everything happens inside the game tab. The player
// never leaves it to switch an engine on. So the game module needs one honest catalogue of
// what can carry a game, and one lifecycle that can bring any of them up and put it back.
//
// WHAT IS IN THE CATALOGUE, AND WHY EACH ONE EARNS ITS PLACE
//
//   Aether — 3 protocols × 2 scan modes = 6 genuinely different paths, not six labels.
//   MASQUE is HTTP/3 to a Cloudflare edge; WireGuard is a different transport to a
//   different port range; warp-in-warp chains through a second hop and trades latency for
//   reachability. `turbo` takes the first healthy gateway, `balanced` searches up to six
//   and keeps the best — on a bad evening those two land on different datacentres, which
//   is exactly the difference a game feels. All of them expose SOCKS 20810.
//
//   V2Ray — the user's saved nodes AND the free-config pools. Most of them are Cloudflare
//   Workers, which carry UDP on port 53 and nothing else, so most will be eliminated by
//   the UDP screen in about three seconds. That is not a reason to leave them out: the
//   ones that are real VPS nodes are among the best paths this app has, and the user
//   should not have to guess which is which.
//
//   GitHub Tunnel — the awkward one, and the honest answer is in `exclusive` below.
//
// THE ONE RULE THIS MODULE DOES NOT BREAK
// It never calls aether-manager, xray-manager or the GitHub Tunnel engine itself. It asks
// `drivers`, which server.js supplies, because server.js owns the watchdogs, the tunnel
// intent and the system-proxy state — an engine started behind its back leaves all three
// describing a machine that no longer exists.

'use strict';

const net = require('net');
const probe = require('./probe');

/** Aether's three data paths. Persian names are the ones the Aether panel already uses. */
const AETHER_PROTOCOLS = [
    { id: 'masque', fa: 'ماسک', why: 'HTTP/3 روی QUIC — معمولاً کم‌تأخیرترین مسیر وارپ' },
    { id: 'wg', fa: 'وایرگارد', why: 'ترابری متفاوت و پورت‌های متفاوت؛ گاهی جایی می‌رسد که ماسک نمی‌رسد' },
    { id: 'gool', fa: 'وارپ در وارپ', why: 'یک پرش بیشتر — تأخیر می‌دهد تا دسترسی بگیرد' },
];

/**
 * Only two scan modes are raced.
 *
 * `thorough`, `stealth` and `ironclad` exist in the engine but each costs minutes of
 * gateway hunting, and a tournament that takes half an hour is a tournament nobody runs.
 * These two are the ones with a materially different outcome per unit of time.
 */
const SCANS = [
    { id: 'turbo', fa: 'توربو', why: 'با اولین گیت‌وی سالم وصل می‌شود — سریع' },
    { id: 'balanced', fa: 'متعادل', why: 'تا ۶ گیت‌وی را می‌گردد و بهترین را برمی‌دارد — کندتر، معمولاً بهتر' },
];

const AETHER_SOCKS = 20810;
// Xray's SOCKS inbound, read live — «پورت محلی» in Settings moves it.
const V2RAY_SOCKS_NOW = () => require('../xray-manager').getPorts().socks;
const GT_SOCKS = 20812;

/**
 * Aether start times are not a constant.
 *
 * `turbo` stops at the first healthy gateway; `balanced` is documented as searching for up
 * to two minutes, and warp-in-warp pays for two handshakes instead of one. A single
 * timeout would either give up on a mode that was about to succeed or leave the user
 * staring at a dead port for minutes.
 */
function aetherStartupMs(protocol, scan) {
    const base = scan === 'balanced' ? 150000 : 60000;
    return protocol === 'gool' ? base + 45000 : base;
}

/** The six Aether variants, in the order they should be raced (cheapest first). */
function aetherSpecs({ protocols = null, scans = null } = {}) {
    const out = [];
    for (const s of SCANS) {
        if (scans && !scans.includes(s.id)) continue;
        for (const p of AETHER_PROTOCOLS) {
            if (protocols && !protocols.includes(p.id)) continue;
            out.push({
                id: `aether:${p.id}:${s.id}`,
                kind: 'aether',
                fa: `${p.fa} (${s.fa})`,
                protocol: p.id,
                scan: s.id,
                socksPort: AETHER_SOCKS,
                exclusive: false,
                startupMs: aetherStartupMs(p.id, s.id),
                why: p.why,
            });
        }
    }
    return out;
}

/**
 * One V2Ray node.
 *
 * `source` is carried through to the UI because "this node came from your list" and "this
 * node came from a public free pool" are different promises, and the user is entitled to
 * know which one just won.
 */
function v2raySpec(node, { source = 'saved', index = 0 } = {}) {
    // Free-pool entries often have no name at all (the source strips the `#fragment`), and
    // a list of «نود ۱ … نود ۱۲» tells the user nothing about what just won. The endpoint
    // is the next most useful identity, and it is what they would recognise in the V2Ray
    // panel afterwards.
    const name = node.name || node.remark || node.label || node.ps
        || (node.host ? `${node.host}:${node.port}` : `نود ${index + 1}`);
    const raw = node.id || node.uri || node.config || node.link || name;
    return {
        id: `v2ray:${source}:${String(raw).slice(0, 48)}`,
        kind: 'v2ray',
        fa: (source === 'free' ? 'رایگان — ' : 'V2Ray — ') + name,
        node,
        source,
        socksPort: V2RAY_SOCKS_NOW(),
        exclusive: false,
        startupMs: 20000,
        why: source === 'free' ? 'از مخزن کانفیگ‌های رایگان' : 'از لیست نودهای خودت',
    };
}

/**
 * GitHub Tunnel — and the reason it is marked `exclusive`.
 *
 * Its proxy mode exposes SOCKS 20812, but tailscaled's SOCKS server does not implement UDP
 * ASSOCIATE, so in that mode it carries no UDP at all and is worth nothing to a game. UDP
 * only flows in `tun` mode, where it drives its own kernel adapter and owns the machine's
 * default route.
 *
 * So it cannot be measured the way every other candidate is measured — through a SOCKS
 * listener while the machine keeps its own routing. Testing it means letting it take the
 * whole connection for the length of one train, then giving the machine back. That is a
 * real interruption, so it is opt-in, it is announced, and it runs last.
 */
function githubTunnelSpec() {
    return {
        id: 'github-tunnel',
        kind: 'github-tunnel',
        fa: 'تونل GitHub',
        socksPort: GT_SOCKS,
        // Measured from the machine itself, not through SOCKS — see above.
        exclusive: true,
        startupMs: 240000,
        why: 'وایرگارد واقعی، ولی خروجی‌اش روی رانر گیت‌هاب است و UDP فقط در حالت تونل کامل دارد',
    };
}

/**
 * «گف» — the only one of the four SOCKS-front engines that can carry a game.
 *
 * Measured 2026-09-14 on its own SOCKS port: UDP ASSOCIATE accepted, and a real STUN train came
 * back — 35 packets, no loss. سایفون, لنترن and تور all REFUSE the associate outright, so none of
 * them can carry a datagram and none is a candidate here. For تور that is architectural rather
 * than a gap: it is a TCP overlay and has no UDP transport to offer.
 *
 * Its numbers on that measurement were min 169ms, p95 872ms, jitter 102.8 — a poor path. It is in
 * the field anyway because the field is a RACE against the user's own direct line, which has
 * measured worse than that on a bad evening, and because promising nothing is the point: the
 * tournament reports what it finds.
 */
const GEPH_SOCKS = 20850;

function gephSpec() {
    return {
        id: 'geph',
        kind: 'geph',
        fa: 'گف',
        socksPort: GEPH_SOCKS,
        // Cold, including the broker race; warm it is a few seconds. Generous, because being cut
        // off at the budget is indistinguishable in the results from an engine that cannot connect.
        startupMs: 90000,
        why: 'تنها موتور SOCKS این برنامه که UDP حمل می‌کند — سنجیده شد، بدون اتلاف',
    };
}

/** Rebuild a spec from an id, so the UI can post back an id instead of a whole object. */
function parseId(id, { nodes = [], freeNodes = [] } = {}) {
    if (!id) return null;
    if (id === 'github-tunnel') return githubTunnelSpec();
    if (id === 'geph') return gephSpec();
    if (id.startsWith('aether:')) {
        const [, protocol, scan = 'turbo'] = id.split(':');
        const found = aetherSpecs().find(s => s.protocol === protocol && s.scan === scan);
        return found || null;
    }
    if (id.startsWith('v2ray:')) {
        const source = id.split(':')[1] === 'free' ? 'free' : 'saved';
        const pool = source === 'free' ? freeNodes : nodes;
        const idx = pool.findIndex((n, i) => v2raySpec(n, { source, index: i }).id === id);
        return idx === -1 ? null : v2raySpec(pool[idx], { source, index: idx });
    }
    return null;
}

// ── liveness ────────────────────────────────────────────────────────────────────

function portAlive(port, timeoutMs = 1200) {
    return new Promise(resolve => {
        const s = new net.Socket();
        let done = false;
        const fin = v => { if (done) return; done = true; try { s.destroy(); } catch {} resolve(v); };
        s.setTimeout(timeoutMs, () => fin(false));
        s.once('error', () => fin(false));
        s.connect(port, '127.0.0.1', () => fin(true));
    });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Wait for an engine's local listener, or give up. Engines are not instant. */
async function waitForPort(port, timeoutMs, signal) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (signal && signal.aborted) return false;
        if (await portAlive(port, 900)) return true;
        await sleep(700);
    }
    return false;
}

// ── the UDP screen ──────────────────────────────────────────────────────────────
//
// MEASURED, 2026-08-19, and it cost a whole tournament to learn:
//
//   tun.socksCarriesUdp() asks the question by sending a DNS query to 1.1.1.1:53. Against
//   Aether that returns FALSE — at 4 seconds and still at 15, to 1.1.1.1, 8.8.8.8 and
//   9.9.9.9 alike. So the first two live tournaments eliminated all six Aether variants
//   with "carries no UDP".
//
//   It is not true. In the same session, on the same port: UDP ASSOCIATE was accepted in
//   5ms, and a real STUN train through that SOCKS listener ran 67 packets at min 130ms with
//   ZERO loss. WARP simply does not carry UDP/53 — it has its own resolver and swallows
//   port 53 — so the one port the screen chose is the one port that proves nothing.
//
// The lesson generalises: SCREEN WITH THE TRAFFIC YOU ARE ABOUT TO MEASURE. This screen
// speaks STUN to the same anchor the tournament then measures, so a pass means the path
// carries the thing a game actually sends.
//
// Two stages, cheap first:
//   1. UDP ASSOCIATE — a Cloudflare Worker refuses this outright, in well under a second,
//      which is what keeps a hundred-node list affordable.
//   2. A two-second STUN burst — catches the path that accepts the handshake and then
//      carries nothing, which is the other common Worker shape.
async function screenUdp({ socksPort, host, ip, port, signal = null } = {}) {
    try {
        const { ctl } = await probe.socksUdpAssociate(socksPort, 3000);
        try { ctl.destroy(); } catch {}
    } catch (err) {
        return { udp: false, reason: 'این مسیر اصلاً UDP قبول نمی‌کند (UDP ASSOCIATE رد شد) — برای بازی بی‌فایده است.' };
    }
    if (signal && signal.aborted) return { udp: false, reason: 'لغو شد' };

    try {
        const r = await probe.udpTrainViaSocks({
            host, ip, port, proto: 'stun',
            socksPort, pps: 10, seconds: 2, warmupMs: 400, signal,
        });
        if (r && r.ok && r.n > 0) return { udp: true, reason: null };
        return { udp: false, reason: 'UDP را قبول می‌کند ولی هیچ بسته‌ای از آن برنگشت — برای بازی بی‌فایده است.' };
    } catch (err) {
        return { udp: false, reason: 'آزمایش UDP این مسیر شکست خورد: ' + (err && err.message ? err.message : err) };
    }
}

// ── lifecycle ───────────────────────────────────────────────────────────────────
//
// `current` is what THIS module started. It matters for two reasons: an engine the user
// started themselves must be put back the way it was found, and an Aether that is already
// running on the wrong protocol has to be restarted rather than measured as if it were the
// variant that was asked for. Measuring `wg` and labelling it `masque` would be worse than
// not measuring at all.

let current = null;   // { specId, kind }

function running() { return current; }

/**
 * Bring `spec` up if it is not already the thing that is up.
 *
 * Returns `{ started }` — true when this call is what started it, which is what `release`
 * needs to know so it never switches off an engine the user had running.
 */
async function ensure(spec, drivers, { log = () => {}, signal = null } = {}) {
    if (!drivers) throw new Error('راه‌انداز موتورها در دسترس نیست.');

    // Same variant, still listening: nothing to do. Only ever true for something this
    // module started, because that is the only case where the variant is known.
    if (current && current.specId === spec.id && await portAlive(spec.socksPort)) {
        return { started: false, reused: true };
    }

    if (spec.kind === 'aether') {
        log(`روشن کردن ${spec.fa}`);
        await drivers.startAether(spec.protocol, spec.scan);
    } else if (spec.kind === 'v2ray') {
        log(`روشن کردن ${spec.fa}`);
        await drivers.startV2ray(spec.node);
    } else if (spec.kind === 'github-tunnel') {
        log(`روشن کردن ${spec.fa} (حالت تونل کامل)`);
        await drivers.startGithubTunnel();
    } else if (spec.kind === 'geph') {
        log(`روشن کردن ${spec.fa}`);
        await drivers.startGeph();
    } else {
        throw new Error(`موتور ناشناخته: ${spec.kind}`);
    }

    current = { specId: spec.id, kind: spec.kind };

    // The GitHub Tunnel owns the route rather than a SOCKS port, and its own connect call
    // does not return until the tunnel is up — so there is nothing left to wait for.
    if (spec.kind !== 'github-tunnel') {
        const up = await waitForPort(spec.socksPort, spec.startupMs, signal);
        if (!up) {
            await release(spec, drivers, { started: true, log });
            throw new Error(`${spec.fa} در زمان مقرر بالا نیامد.`);
        }

        // AN OPEN PORT IS NOT A CONNECTED ENGINE, and believing otherwise invalidated the
        // first real tournament this feature ever ran. aether.exe binds SOCKS 20810 the
        // moment it starts — seconds before it has found a gateway, let alone validated
        // that data passes — so every variant was measured against a listener with nothing
        // behind it, every one reported "carries no UDP", and the whole race finished in
        // 36 seconds instead of minutes. A wrong answer, delivered fast, about six engines
        // that were never actually tested.
        //
        // `engineReady` is the engine's OWN notion of connected (for Aether, the manager's
        // validated data-plane state). Without a driver that can answer, the port check is
        // all there is and the old behaviour stands — but the measurement then says so.
        if (typeof drivers.engineReady === 'function') {
            const deadline = Date.now() + spec.startupMs;
            let ready = false;
            while (Date.now() < deadline) {
                if (signal && signal.aborted) break;
                try { ready = !!(await drivers.engineReady(spec)); } catch { ready = false; }
                if (ready) break;
                await sleep(1000);
            }
            if (!ready) {
                await release(spec, drivers, { started: true, log });
                throw new Error(`${spec.fa} پورتش باز شد ولی تا پایان مهلت واقعاً وصل نشد.`);
            }
            // Connected is not the same as settled: the first packets after a handshake
            // routinely take a different path from the steady state, and measuring them
            // would blame the engine for its own warm-up.
            await sleep(1200);
        }
    }
    return { started: true, reused: false };
}

/** Put the machine back. A failed stop must never propagate — the caller is in a finally. */
async function release(spec, drivers, { started = true, log = () => {} } = {}) {
    if (!started || !drivers) return;
    try {
        if (spec.kind === 'aether') await drivers.stopAether();
        else if (spec.kind === 'v2ray') await drivers.stopV2ray();
        else if (spec.kind === 'github-tunnel') await drivers.stopGithubTunnel();
        else if (spec.kind === 'geph') await drivers.stopGeph();
        log(`${spec.fa} خاموش شد`);
    } catch { /* deliberately swallowed */ }
    if (current && current.specId === spec.id) current = null;
    await sleep(400);
}

module.exports = {
    AETHER_PROTOCOLS, SCANS,
    AETHER_SOCKS, get V2RAY_SOCKS() { return V2RAY_SOCKS_NOW(); }, GT_SOCKS,
    aetherSpecs, v2raySpec, githubTunnelSpec, gephSpec, parseId,
    GEPH_SOCKS,
    portAlive, waitForPort, ensure, release, running, screenUdp,
};
