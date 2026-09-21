// --- Game catalogue ---
//
// Four jobs, and only four. This file is NOT a database of trivia:
//
//   1. RECOGNISE a running game from its Windows process name.
//   2. CLASSIFY its network architecture, because that decides what a tunnel can even do
//      for it (a P2P fighting game and an SDR-relayed shooter have nothing in common).
//   3. RECORD its anti-cheat, because that is a hard boundary — see ANTICHEAT_KERNEL.
//   4. POINT at something measurable: either a query protocol the game's own servers
//      answer, or a set of regional anchors that stand in for them.
//
// WHY THE PORT LISTS ARE NOT AUTHORITATIVE
// Published port ranges go stale, differ by region, and several games (Roblox, Overwatch)
// use ranges so wide they carry no information. They are a PRIOR here, used only to guess
// which of a process's sockets is the game flow. The engine learns the real destination at
// runtime — see detect.js. Never route on these numbers alone.
//
// WHY `probe` MATTERS MORE THAN ANYTHING ELSE HERE
// A latency number is only honest if something actually answered. `probe` says what will
// answer:
//
//   'a2s'       Source engine servers answer A2S_INFO on the game port. Real end-to-end.
//   'fivem'     FiveM/RedM answer `getinfo` on UDP 30120. Real end-to-end.
//   'minecraft' Java servers answer the handshake+status ping on TCP.
//   'raknet'    Bedrock/RakNet answer an unconnected ping on UDP.
//   'anchors'   Nothing in the game answers. We measure regional anchors instead and say
//               so. This is the honest fallback for every P2P and every closed platform —
//               including GTA Online and Red Dead Online.
//
// A game whose probe is 'anchors' can still be assessed: the route-detour test compares
// the direct path to the region against the direct path to the game, and the local-line
// audit does not need the game at all.

'use strict';

// Anti-cheats that load a kernel driver. The rule this drives, stated once:
//
//   With these, MLMVPN may carry traffic through a standard TUN adapter — the same thing
//   every commercial VPN does — and NOTHING else. No packet injection, no rewriting, no
//   WinDivert, no callout driver. Loss recovery that alters the packets on the wire is
//   confined to the tunnel between us and a relay, never to the game's own socket.
const ANTICHEAT_KERNEL = ['Vanguard', 'Ricochet', 'EA AC', 'Hyperion', 'mhyprot', 'nProtect', 'Denuvo AC'];

/**
 * Regional anchors.
 *
 * These are hosts that (a) really answer, and (b) sit in a datacentre region rather than
 * on anycast, so a measurement to them says something about a geographic path. Every one
 * of these was probed from an Iranian line on 2026-08-19 and answered on TCP/443.
 *
 * `udp` entries answer a STUN binding request, which is the only widely-deployed UDP echo
 * on the public internet. They are anycast, so they measure "the nearest instance", not a
 * region — which is exactly why they are kept separate from `tcp` and labelled as such.
 */
const REGIONS = {
    'eu-central': {
        fa: 'اروپای مرکزی (فرانکفورت / نورنبرگ)',
        tcp: [
            { host: 'ec2.eu-central-1.amazonaws.com', port: 443, group: 'aws' },
            { host: 'speedtest.frankfurt.linode.com', port: 443, group: 'linode' },
            { host: 'fra-de-ping.vultr.com', port: 443, group: 'vultr' },
        ],
    },
    'eu-west': {
        fa: 'اروپای غربی (آمستردام / لندن / پاریس)',
        tcp: [
            { host: 'ams-nl-ping.vultr.com', port: 443, group: 'vultr' },
            { host: 'speedtest.london.linode.com', port: 443, group: 'linode' },
            { host: 'par-fr-ping.vultr.com', port: 443, group: 'vultr-par' },
        ],
    },
    'eu-north': {
        fa: 'اروپای شمالی (استکهلم / هلسینکی)',
        tcp: [
            { host: 'ec2.eu-north-1.amazonaws.com', port: 443, group: 'aws' },
            { host: 'sto-se-ping.vultr.com', port: 443, group: 'vultr' },
        ],
    },
    'eu-south': {
        fa: 'اروپای جنوبی (میلان / زوریخ)',
        tcp: [
            { host: 'ec2.eu-south-1.amazonaws.com', port: 443, group: 'aws-mil' },
            { host: 'ec2.eu-central-2.amazonaws.com', port: 443, group: 'aws-zrh' },
        ],
    },
    'eu-east': {
        fa: 'اروپای شرقی (ورشو)',
        tcp: [{ host: 'waw-pl-ping.vultr.com', port: 443, group: 'vultr' }],
    },
    'me': {
        fa: 'خاورمیانه (امارات / تل‌آویو)',
        tcp: [
            { host: 'ec2.me-central-1.amazonaws.com', port: 443, group: 'aws-uae' },
            { host: 'tlv-il-ping.vultr.com', port: 443, group: 'vultr-tlv' },
        ],
    },
    'ru': {
        fa: 'روسیه (مسکو / سن‌پترزبورگ)',
        tcp: [
            { host: 'yandex.ru', port: 443, group: 'yandex' },
            { host: 'selectel.ru', port: 443, group: 'selectel' },
        ],
    },
    'asia-south': {
        fa: 'جنوب آسیا (بمبئی)',
        tcp: [
            { host: 'ec2.ap-south-1.amazonaws.com', port: 443, group: 'aws' },
            { host: 'bom-in-ping.vultr.com', port: 443, group: 'vultr' },
        ],
    },
    'asia-east': {
        fa: 'شرق آسیا (سنگاپور / توکیو)',
        tcp: [
            { host: 'ec2.ap-southeast-1.amazonaws.com', port: 443, group: 'aws-sg' },
            { host: 'ec2.ap-northeast-1.amazonaws.com', port: 443, group: 'aws-tok' },
        ],
    },
    'us-east': {
        fa: 'شرق آمریکا',
        tcp: [
            { host: 'ec2.us-east-1.amazonaws.com', port: 443, group: 'aws' },
            { host: 'speedtest.newark.linode.com', port: 443, group: 'linode' },
        ],
    },
};

/**
 * UDP anchors. Anycast STUN — measures the nearest instance of a large network, not a
 * region. Used to answer one question only, and it is a question worth answering:
 * "does this line carry sustained UDP on a high port at a game's cadence, and how does
 * its tail look?" That is the local-line half of the diagnosis.
 */
const UDP_ANCHORS = [
    { host: 'stun.l.google.com', port: 19302, fa: 'Google', group: 'google' },
    { host: 'stun.cloudflare.com', port: 3478, fa: 'Cloudflare', group: 'cloudflare' },
    { host: 'global.stun.twilio.com', port: 3478, fa: 'Twilio', group: 'twilio' },
];

const CLASS_FA = {
    dedicated: 'سرور اختصاصی',
    p2p: 'همتا به همتا',
    relay: 'شبکه‌ی رله‌ی خود بازی',
    tcp: 'مبتنی بر TCP',
};

/**
 * The catalogue.
 *
 * `procs` are matched case-insensitively; entries ending in `*` are prefix matches, which
 * is how FiveM's per-build process name (FiveM_b3095_GTAProcess.exe) is caught.
 */
const GAMES = [
    // ── Rockstar ────────────────────────────────────────────────────────────────
    // First, because these are the two the user can test with directly.
    {
        id: 'gta-online', fa: 'GTA Online', en: 'Grand Theft Auto Online',
        cat: 'rockstar', klass: 'p2p', probe: 'anchors', regions: ['eu-central', 'eu-west'],
        procs: ['GTA5.exe', 'GTA5_Enhanced.exe', 'PlayGTAV.exe'],
        udp: [[6672, 6672], [61455, 61458]], tcp: [[443, 443]],
        anticheat: 'BattlEye',
        note: 'جلسه‌ی همتا‌به‌همتا: بازیکنان مستقیماً به هم وصل می‌شوند و Rockstar فقط جلسه را جور می‌کند. پس «پینگ به سرور» وجود ندارد — کیفیت جلسه را NAT و jitter تعیین می‌کند.',
        tips: [
            'NAT باز مهم‌ترین عامل است: با NAT بسته، بازیکنان کمتری دیده می‌شوند و جلسه مدام از هم می‌پاشد.',
            'چون میزبان یکی از بازیکنان است، هیچ رله‌ای نمی‌تواند «پینگ سرور» را کم کند — ولی IP عمومی رله NAT را باز می‌کند.',
        ],
    },
    {
        id: 'rdo', fa: 'Red Dead Online', en: 'Red Dead Redemption 2 Online',
        cat: 'rockstar', klass: 'p2p', probe: 'anchors', regions: ['eu-central', 'eu-west'],
        procs: ['RDR2.exe', 'PlayRDR2.exe'],
        udp: [[6672, 6672], [61455, 61458]], tcp: [[443, 443]],
        anticheat: 'BattlEye',
        note: 'همان معماری GTA Online — جلسه‌ی همتا‌به‌همتا روی زیرساخت Rockstar. هرچه درباره‌ی GTA Online گفته شد اینجا هم صادق است.',
        tips: ['حالت داستانی آفلاین است؛ فقط Red Dead Online از شبکه استفاده می‌کند.'],
    },
    {
        id: 'fivem', fa: 'FiveM — نقش‌آفرینی GTA', en: 'FiveM',
        cat: 'rockstar', klass: 'dedicated', probe: 'fivem', regions: ['eu-central', 'eu-west'],
        procs: ['FiveM.exe', 'FiveM_*', 'FiveM_GTAProcess.exe'],
        udp: [[30120, 30120]], tcp: [[30120, 30120]],
        anticheat: null,
        note: 'سرور اختصاصی و — مهم‌تر — به کوئری getinfo روی UDP جواب می‌دهد. یعنی می‌توانیم پینگ و اتلاف واقعیِ سرتاسری تا خودِ سرور بازی را اندازه بگیریم، نه تخمین.',
        tips: ['اگر آدرس سرور را وارد کنی، سنجش کاملاً واقعی می‌شود.'],
    },
    {
        id: 'redm', fa: 'RedM', en: 'RedM',
        cat: 'rockstar', klass: 'dedicated', probe: 'fivem', regions: ['eu-central'],
        procs: ['RedM.exe', 'RedM_*'], udp: [[30120, 30120]], anticheat: null,
        note: 'همان هسته‌ی FiveM روی Red Dead 2 — همان کوئری getinfo.',
    },
    {
        id: 'samp', fa: 'SA-MP / open.mp', en: 'San Andreas Multiplayer',
        cat: 'rockstar', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'],
        procs: ['samp.exe', 'gta_sa.exe', 'omp-launcher.exe'], udp: [[7777, 7777]], anticheat: null,
        note: 'هنوز جامعه‌ی فعال ایرانی دارد. سرورها اغلب اروپایی‌اند.',
    },
    {
        id: 'mtasa', fa: 'MTA: San Andreas', en: 'Multi Theft Auto',
        cat: 'rockstar', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'],
        procs: ['Multi Theft Auto.exe'], udp: [[22003, 22003]], anticheat: null,
        note: 'gta_sa.exe را با SA-MP مشترک است، پس تشخیص با نام لانچر خودش انجام می‌شود.',
    },

    // ── تیراندازی رقابتی ────────────────────────────────────────────────────────
    {
        id: 'cs2', fa: 'Counter-Strike 2', en: 'Counter-Strike 2',
        cat: 'fps', klass: 'relay', probe: 'a2s', regions: ['eu-central', 'eu-west'],
        procs: ['cs2.exe'], udp: [[27015, 27068]], anticheat: 'VAC',
        note: 'روی Steam Datagram Relay است: خود Valve مسیر را انتخاب می‌کند. یک تونل می‌تواند این انتخاب را خراب کند، پس نتیجه باید جداگانه سنجیده شود.',
        tips: ['سرورهای انجمنی به A2S_INFO جواب می‌دهند و سنجش واقعی می‌دهند؛ ماچ‌میکینگ رسمی نه.'],
    },
    {
        id: 'valorant', fa: 'VALORANT', en: 'VALORANT',
        cat: 'fps', klass: 'relay', probe: 'anchors', regions: ['eu-central', 'me'],
        procs: ['VALORANT-Win64-Shipping.exe', 'VALORANT.exe'], udp: [[7000, 8000]],
        anticheat: 'Vanguard',
        note: 'Riot Direct شبکه‌ی خصوصی خودش را دارد؛ نقطه‌ی ورود از خود تونل مهم‌تر است.',
        tips: ['ضدتقلب کرنلی: فقط آداپتر TUN استاندارد. هیچ دستکاری بسته‌ای مجاز نیست.'],
    },
    {
        id: 'cod', fa: 'Call of Duty (Warzone / MW / BO)', en: 'Call of Duty',
        cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'eu-west'],
        procs: ['cod.exe', 'ModernWarfare.exe', 'BlackOpsColdWar.exe', 'Warzone.exe', 'bo6.exe', 'BlackOps6.exe'],
        udp: [[3074, 3074], [27014, 27050]], anticheat: 'Ricochet',
        note: 'ماچ‌میکینگ Demonware. NAT بسته لابی و پارتی را خراب می‌کند حتی وقتی پینگ خوب است.',
    },
    {
        id: 'r6', fa: 'Rainbow Six Siege', en: 'Rainbow Six Siege',
        cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'eu-west'],
        procs: ['RainbowSix.exe', 'RainbowSix_BE.exe'], udp: [[6015, 6015], [10000, 10099]],
        anticheat: 'BattlEye',
        note: 'انتخاب دیتاسنتر دستی دارد — یکی از بهترین هدف‌ها برای توصیه‌ی منطقه.',
    },
    {
        id: 'overwatch2', fa: 'Overwatch 2', en: 'Overwatch 2',
        cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'],
        procs: ['Overwatch.exe'], udp: [[5060, 5062], [6250, 6250], [12000, 64000]], anticheat: 'Blizzard',
        note: 'بازه‌ی پورت آن‌قدر پهن است که بی‌معنی می‌شود — تشخیص فقط با نام پراسس.',
    },
    { id: 'bf2042', fa: 'Battlefield 2042', en: 'Battlefield 2042', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['BF2042.exe'], udp: [[3659, 3659], [25200, 25300]], anticheat: 'EA AC' },
    { id: 'thefinals', fa: 'The Finals', en: 'The Finals', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Discovery.exe', 'Discovery_Win64_Shipping.exe'], anticheat: 'EAC' },
    { id: 'deltaforce', fa: 'Delta Force', en: 'Delta Force', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['DeltaForceClient.exe', 'DeltaForceClient-Win64-Shipping.exe'], anticheat: 'ACE' },
    { id: 'rivals', fa: 'Marvel Rivals', en: 'Marvel Rivals', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Marvel-Win64-Shipping.exe', 'MarvelRivals_Launcher.exe'], anticheat: null },
    { id: 'tarkov', fa: 'Escape from Tarkov', en: 'Escape from Tarkov', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['EscapeFromTarkov.exe'], anticheat: 'BattlEye', note: 'نشست‌های طولانی: پایداری چند ساعته اینجا از پینگ لحظه‌ای مهم‌تر است.' },
    { id: 'destiny2', fa: 'Destiny 2', en: 'Destiny 2', cat: 'fps', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['destiny2.exe'], udp: [[3074, 3074], [27015, 27200]], anticheat: 'BattlEye', note: 'ترکیبی همتا‌به‌همتا و بسیار حساس به NAT — خطاهای معروف حیوانات اغلب همین‌اند.' },
    { id: 'squad', fa: 'Squad', en: 'Squad', cat: 'fps', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['SquadGame.exe'], udp: [[7787, 7787], [27165, 27165]], anticheat: 'EAC' },
    { id: 'hll', fa: 'Hell Let Loose', en: 'Hell Let Loose', cat: 'fps', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['HLL-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'sandstorm', fa: 'Insurgency: Sandstorm', en: 'Insurgency: Sandstorm', cat: 'fps', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['InsurgencyClient-Win64-Shipping.exe'], udp: [[27102, 27102]], anticheat: 'EAC' },
    { id: 'tf2', fa: 'Team Fortress 2', en: 'Team Fortress 2', cat: 'fps', klass: 'relay', probe: 'a2s', regions: ['eu-central'], procs: ['tf_win64.exe', 'hl2.exe'], udp: [[27015, 27015]], anticheat: 'VAC' },
    { id: 'l4d2', fa: 'Left 4 Dead 2', en: 'Left 4 Dead 2', cat: 'fps', klass: 'p2p', probe: 'a2s', regions: ['eu-central'], procs: ['left4dead2.exe'], udp: [[27015, 27015]], anticheat: 'VAC', note: 'میزبان یکی از بازیکنان است.' },
    { id: 'crossfire', fa: 'CrossFire', en: 'CrossFire', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['me', 'eu-central'], procs: ['crossfire.exe'], anticheat: 'XIGNCODE' },
    { id: 'pointblank', fa: 'Point Blank', en: 'Point Blank', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['me', 'eu-central'], procs: ['PointBlank.exe'], anticheat: null },
    { id: 'halo', fa: 'Halo Infinite', en: 'Halo Infinite', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['HaloInfinite.exe'], anticheat: 'EAC' },

    // ── بتل رویال ───────────────────────────────────────────────────────────────
    { id: 'pubg', fa: 'PUBG: BATTLEGROUNDS', en: 'PUBG', cat: 'br', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-south'], procs: ['TslGame.exe'], udp: [[7000, 7999], [27000, 27031]], anticheat: 'BattlEye' },
    { id: 'apex', fa: 'Apex Legends', en: 'Apex Legends', cat: 'br', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['r5apex.exe', 'r5apex_dx12.exe'], udp: [[37000, 40000]], anticheat: 'EAC', note: 'انتخاب دیتاسنتر داخل بازی دارد — هدف عالی برای توصیه‌ی منطقه.' },
    { id: 'fortnite', fa: 'Fortnite', en: 'Fortnite', cat: 'br', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['FortniteClient-Win64-Shipping.exe'], udp: [[9000, 9100]], anticheat: 'EAC' },
    { id: 'naraka', fa: 'Naraka: Bladepoint', en: 'Naraka: Bladepoint', cat: 'br', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['NarakaBladepoint.exe'], anticheat: null },

    // ── MOBA و استراتژی ─────────────────────────────────────────────────────────
    { id: 'dota2', fa: 'Dota 2', en: 'Dota 2', cat: 'moba', klass: 'relay', probe: 'a2s', regions: ['eu-central', 'eu-east'], procs: ['dota2.exe'], udp: [[27015, 27068]], anticheat: 'VAC', note: 'روی SDR. گزارش‌های جامعه از تداخل VPN با Game Coordinator وجود دارد — با احتیاط.' },
    { id: 'lol', fa: 'League of Legends', en: 'League of Legends', cat: 'moba', klass: 'relay', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['League of Legends.exe'], udp: [[5000, 5500]], anticheat: null, note: 'Riot Direct؛ نقطه‌ی ورود از تونل مهم‌تر است.' },
    { id: 'smite2', fa: 'Smite 2', en: 'Smite 2', cat: 'moba', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Smite.exe'], anticheat: 'EAC' },
    { id: 'hots', fa: 'Heroes of the Storm', en: 'Heroes of the Storm', cat: 'moba', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['HeroesOfTheStorm_x64.exe'], udp: [[1119, 1119]], anticheat: null },
    { id: 'aoe4', fa: 'Age of Empires IV', en: 'Age of Empires IV', cat: 'moba', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['RelicCardinal.exe'], anticheat: 'EAC', note: 'lockstep: کندترین بازیکن سرعت همه را تعیین می‌کند، پس jitter اینجا کشنده است.' },
    { id: 'sc2', fa: 'StarCraft II', en: 'StarCraft II', cat: 'moba', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['SC2_x64.exe'], udp: [[1119, 1119], [6113, 6113]], anticheat: null, note: 'همان منطق lockstep.' },

    // ── ورزشی و مسابقه‌ای ───────────────────────────────────────────────────────
    { id: 'eafc', fa: 'EA SPORTS FC 25 / 24', en: 'EA Sports FC', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central', 'eu-west'], procs: ['FC25.exe', 'FC24.exe', 'FIFA23.exe'], udp: [[3659, 3659], [25200, 25300]], anticheat: 'EA AC', note: 'در ایران بسیار محبوب. یک‌به‌یک همتا‌به‌همتا: NAT باز و jitter کم مستقیماً به برد تبدیل می‌شوند.' },
    { id: 'efootball', fa: 'eFootball', en: 'eFootball', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['eFootball.exe'], anticheat: null },
    { id: 'rocketleague', fa: 'Rocket League', en: 'Rocket League', cat: 'sport', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['RocketLeague.exe'], udp: [[7000, 9000]], anticheat: null },
    { id: 'forza5', fa: 'Forza Horizon 5', en: 'Forza Horizon 5', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['ForzaHorizon5.exe'], udp: [[3074, 3074]], anticheat: null, note: 'NAT سخت‌گیرانه یعنی ندیدن بازیکنان دیگر در دنیای آزاد.' },
    { id: 'f1', fa: 'F1 24 / 25', en: 'F1', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['F1_24.exe', 'F1_25.exe'], anticheat: null },
    { id: 'acc', fa: 'Assetto Corsa Competizione', en: 'ACC', cat: 'sport', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['AC2-Win64-Shipping.exe'], udp: [[9600, 9601]], anticheat: null },
    { id: 'iracing', fa: 'iRacing', en: 'iRacing', cat: 'sport', klass: 'dedicated', probe: 'anchors', regions: ['eu-west', 'us-east'], procs: ['iRacingSim64DX11.exe'], anticheat: null },
    { id: 'nba2k', fa: 'NBA 2K25', en: 'NBA 2K25', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['NBA2K25.exe'], anticheat: null },

    // ── MMO و نقش‌آفرینی ────────────────────────────────────────────────────────
    { id: 'wow', fa: 'World of Warcraft', en: 'World of Warcraft', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['Wow.exe'], tcp: [[3724, 3724], [1119, 1119]], anticheat: 'Warden', note: 'روی TCP: اتلاف بسته اینجا خیلی گران‌تر از jitter است.' },
    { id: 'ffxiv', fa: 'Final Fantasy XIV', en: 'FFXIV', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central', 'eu-west'], procs: ['ffxiv_dx11.exe'], tcp: [[54992, 55007]], anticheat: null },
    { id: 'lostark', fa: 'Lost Ark', en: 'Lost Ark', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['LOSTARK.exe'], anticheat: 'EAC' },
    { id: 'bdo', fa: 'Black Desert Online', en: 'Black Desert', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['BlackDesert64.exe'], tcp: [[8888, 8888]], anticheat: null },
    { id: 'newworld', fa: 'New World', en: 'New World', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['NewWorld.exe'], anticheat: 'EAC' },
    { id: 'gw2', fa: 'Guild Wars 2', en: 'Guild Wars 2', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['Gw2-64.exe'], tcp: [[6112, 6112]], anticheat: null },
    { id: 'poe', fa: 'Path of Exile / PoE 2', en: 'Path of Exile', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['PathOfExile_x64.exe', 'PathOfExileSteam.exe', 'PathOfExile.exe'], tcp: [[12995, 20481]], anticheat: null, note: 'انتخاب gateway دستی دارد — هدف عالی برای توصیه‌ی منطقه.' },
    { id: 'diablo4', fa: 'Diablo IV', en: 'Diablo IV', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['Diablo IV.exe'], tcp: [[1119, 1119]], anticheat: null },
    { id: 'albion', fa: 'Albion Online', en: 'Albion Online', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-west'], procs: ['Albion-Online.exe'], udp: [[5055, 5058]], anticheat: null },
    { id: 'tl', fa: 'Throne and Liberty', en: 'Throne and Liberty', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['TL.exe'], anticheat: null },
    { id: 'genshin', fa: 'Genshin Impact', en: 'Genshin Impact', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['GenshinImpact.exe', 'YuanShen.exe'], udp: [[22101, 22102]], anticheat: 'mhyprot', note: 'خودش KCP روی UDP دارد — افزودن یک لایه‌ی ARQ دوم اشتباه است.' },
    { id: 'hsr', fa: 'Honkai: Star Rail', en: 'Honkai: Star Rail', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['StarRail.exe'], anticheat: 'mhyprot' },
    { id: 'wuwa', fa: 'Wuthering Waves', en: 'Wuthering Waves', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['Client-Win64-Shipping.exe'], anticheat: null, note: 'نام پراسس عمومی Unreal است — با مسیر نصب تفکیک می‌شود.' },
    { id: 'warframe', fa: 'Warframe', en: 'Warframe', cat: 'mmo', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Warframe.x64.exe'], udp: [[4950, 4955]], anticheat: null, note: 'میزبان یکی از بازیکنان است ⇒ NAT حیاتی.' },
    { id: 'osrs', fa: 'Old School RuneScape', en: 'OSRS', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-west'], procs: ['osclient.exe', 'rs2client.exe', 'RuneLite.exe'], tcp: [[43594, 43594]], anticheat: null },
    { id: 'starcitizen', fa: 'Star Citizen', en: 'Star Citizen', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['StarCitizen.exe'], udp: [[8000, 8020]], anticheat: 'EAC' },

    // ── بقا و Co-op ─────────────────────────────────────────────────────────────
    { id: 'rust', fa: 'Rust', en: 'Rust', cat: 'survival', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['RustClient.exe'], udp: [[28015, 28015]], anticheat: 'EAC' },
    { id: 'ark', fa: 'ARK: Survival Ascended', en: 'ARK', cat: 'survival', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['ArkAscended.exe', 'ShooterGame.exe'], udp: [[7777, 7778], [27015, 27015]], anticheat: 'BattlEye' },
    { id: 'dayz', fa: 'DayZ', en: 'DayZ', cat: 'survival', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['DayZ_x64.exe'], udp: [[2302, 2305]], anticheat: 'BattlEye' },
    { id: 'mc-java', fa: 'Minecraft (جاوا)', en: 'Minecraft Java', cat: 'survival', klass: 'tcp', probe: 'minecraft', regions: ['eu-central'], procs: ['javaw.exe', 'java.exe'], tcp: [[25565, 25565]], anticheat: null, note: 'پراسس عمومی جاواست ⇒ تشخیص با پورت مقصد، نه با نام.' },
    { id: 'mc-bedrock', fa: 'Minecraft (بدراک)', en: 'Minecraft Bedrock', cat: 'survival', klass: 'dedicated', probe: 'raknet', regions: ['eu-central'], procs: ['Minecraft.Windows.exe'], udp: [[19132, 19133]], anticheat: null },
    { id: 'valheim', fa: 'Valheim', en: 'Valheim', cat: 'survival', klass: 'p2p', probe: 'a2s', regions: ['eu-central'], procs: ['valheim.exe'], udp: [[2456, 2458]], anticheat: null },
    { id: 'palworld', fa: 'Palworld', en: 'Palworld', cat: 'survival', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Palworld-Win64-Shipping.exe'], udp: [[8211, 8211]], anticheat: null },
    { id: 'terraria', fa: 'Terraria', en: 'Terraria', cat: 'survival', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['Terraria.exe'], tcp: [[7777, 7777]], anticheat: null },
    { id: 'helldivers2', fa: 'Helldivers 2', en: 'Helldivers 2', cat: 'survival', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['helldivers2.exe'], anticheat: 'nProtect' },
    { id: 'sot', fa: 'Sea of Thieves', en: 'Sea of Thieves', cat: 'survival', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'eu-west'], procs: ['SoTGame.exe'], udp: [[30000, 45000]], anticheat: 'EAC' },
    { id: 'dbd', fa: 'Dead by Daylight', en: 'Dead by Daylight', cat: 'survival', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['DeadByDaylight-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'vrising', fa: 'V Rising', en: 'V Rising', cat: 'survival', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['VRising.exe'], anticheat: 'EAC' },
    { id: 'enshrouded', fa: 'Enshrouded', en: 'Enshrouded', cat: 'survival', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['enshrouded.exe'], anticheat: null },
    { id: 'oncehuman', fa: 'Once Human', en: 'Once Human', cat: 'survival', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Once Human.exe', 'OnceHuman.exe'], anticheat: null },

    // ── مبارزه‌ای ───────────────────────────────────────────────────────────────
    { id: 'sf6', fa: 'Street Fighter 6', en: 'Street Fighter 6', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['StreetFighter6.exe'], anticheat: null, note: 'rollback netcode: هر میلی‌ثانیه jitter مستقیماً به فریم برگشتی تبدیل می‌شود.' },
    { id: 'tekken8', fa: 'Tekken 8', en: 'Tekken 8', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Polaris-Win64-Shipping.exe'], anticheat: 'Denuvo AC' },
    { id: 'mk1', fa: 'Mortal Kombat 1', en: 'Mortal Kombat 1', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['MK12.exe'], anticheat: null },
    { id: 'ggst', fa: 'Guilty Gear Strive', en: 'Guilty Gear Strive', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['GGST-Win64-Shipping.exe'], anticheat: null },
    { id: 'brawlhalla', fa: 'Brawlhalla', en: 'Brawlhalla', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Brawlhalla.exe'], anticheat: null },
    { id: 'multiversus', fa: 'MultiVersus', en: 'MultiVersus', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['MultiVersus.exe'], anticheat: null },

    // ── نظامی و شبیه‌سازی ───────────────────────────────────────────────────────
    { id: 'warthunder', fa: 'War Thunder', en: 'War Thunder', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'ru'], procs: ['aces.exe'], udp: [[20010, 20015]], anticheat: null },
    { id: 'wot', fa: 'World of Tanks', en: 'World of Tanks', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'ru'], procs: ['WorldOfTanks.exe'], udp: [[20020, 20024], [32800, 32900]], anticheat: null },
    { id: 'wows', fa: 'World of Warships', en: 'World of Warships', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'ru'], procs: ['WorldOfWarships.exe'], anticheat: null },
    { id: 'enlisted', fa: 'Enlisted', en: 'Enlisted', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['enlisted.exe'], anticheat: null },

    // ── سایر ────────────────────────────────────────────────────────────────────
    { id: 'roblox', fa: 'Roblox', en: 'Roblox', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'us-east'], procs: ['RobloxPlayerBeta.exe'], udp: [[49152, 65535]], anticheat: 'Hyperion', note: 'بازه‌ی پورت کاملاً پویاست ⇒ فقط تشخیص با پراسس.' },
    { id: 'warface', fa: 'Warface', en: 'Warface', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'ru'], procs: ['Game.exe'], anticheat: null, note: 'نام پراسس بیش از حد عمومی است — باید با مسیر نصب تأیید شود.' },

    { id: 'apbreloaded', fa: 'APB Reloaded', en: 'APB Reloaded', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['APB.exe'], anticheat: 'BattlEye' },
    { id: 'phasmophobia', fa: 'Phasmophobia', en: 'Phasmophobia', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Phasmophobia.exe'], udp: [[5055, 5058]], anticheat: null, note: 'Photon، همتا‌به‌همتا — NAT مهم‌تر از پینگ است.' },
    { id: 'amongus', fa: 'Among Us', en: 'Among Us', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Among Us.exe'], anticheat: null },
    { id: 'lethalcompany', fa: 'Lethal Company', en: 'Lethal Company', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Lethal Company.exe'], anticheat: null },
    { id: 'repo', fa: 'R.E.P.O.', en: 'R.E.P.O.', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['REPO.exe'], anticheat: null },
    { id: 'schedule1', fa: 'Schedule I', en: 'Schedule I', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Schedule I.exe'], anticheat: null },
    { id: 'gtfo', fa: 'GTFO', en: 'GTFO', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['GTFO.exe'], anticheat: null },
    { id: 'deeprock', fa: 'Deep Rock Galactic', en: 'Deep Rock Galactic', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['FSD-Win64-Shipping.exe'], anticheat: null },
    { id: 'payday3', fa: 'PAYDAY 3', en: 'PAYDAY 3', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['PAYDAY3-Win64-Shipping.exe'], anticheat: null },
    { id: 'b4b', fa: 'Back 4 Blood', en: 'Back 4 Blood', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Back4Blood-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'l4d1', fa: 'Left 4 Dead', en: 'Left 4 Dead', cat: 'other', klass: 'p2p', probe: 'a2s', regions: ['eu-central'], procs: ['left4dead.exe'], udp: [[27015, 27015]], anticheat: 'VAC' },
    { id: 'garrysmod', fa: "Garry's Mod", en: "Garry's Mod", cat: 'other', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['gmod.exe'], udp: [[27015, 27015]], anticheat: 'VAC' },
    { id: 'unturned', fa: 'Unturned', en: 'Unturned', cat: 'other', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['Unturned.exe'], udp: [[27015, 27017]], anticheat: 'BattlEye' },
    { id: 'projectzomboid', fa: 'Project Zomboid', en: 'Project Zomboid', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['ProjectZomboid64.exe'], udp: [[16261, 16262]], anticheat: null },
    { id: 'scum', fa: 'SCUM', en: 'SCUM', cat: 'other', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['SCUM.exe'], anticheat: 'BattlEye' },
    { id: 'theisle', fa: 'The Isle', en: 'The Isle', cat: 'other', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['TheIsle-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'sonsoftheforest', fa: 'Sons of the Forest', en: 'Sons of the Forest', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['SonsOfTheForest.exe'], anticheat: null },
    { id: 'grounded', fa: 'Grounded', en: 'Grounded', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Maine-Win64-Shipping.exe'], anticheat: null },
    { id: 'raft', fa: 'Raft', en: 'Raft', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Raft.exe'], anticheat: null },
    { id: 'satisfactory', fa: 'Satisfactory', en: 'Satisfactory', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['FactoryGame-Win64-Shipping.exe'], udp: [[7777, 7777]], anticheat: null },
    { id: 'astroneer', fa: 'Astroneer', en: 'Astroneer', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Astro-Win64-Shipping.exe'], anticheat: null },
    { id: 'corekeeper', fa: 'Core Keeper', en: 'Core Keeper', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['CoreKeeper.exe'], anticheat: null },
    { id: 'stardew', fa: 'Stardew Valley', en: 'Stardew Valley', cat: 'other', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Stardew Valley.exe'], anticheat: null },
    { id: 'factorio', fa: 'Factorio', en: 'Factorio', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['factorio.exe'], udp: [[34197, 34197]], anticheat: null },
    { id: '7days', fa: '7 Days to Die', en: '7 Days to Die', cat: 'other', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['7DaysToDie.exe'], udp: [[26900, 26903]], anticheat: 'EAC' },
    { id: 'conanexiles', fa: 'Conan Exiles', en: 'Conan Exiles', cat: 'other', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['ConanSandbox.exe'], udp: [[7777, 7778], [27015, 27015]], anticheat: 'BattlEye' },
    { id: 'icarus', fa: 'ICARUS', en: 'ICARUS', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Icarus-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'dune', fa: 'Dune: Awakening', en: 'Dune: Awakening', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['DuneSandbox-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'nightingale', fa: 'Nightingale', en: 'Nightingale', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Nightingale-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'thefirstdescendant', fa: 'The First Descendant', en: 'The First Descendant', cat: 'other', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['M1-Win64-Shipping.exe'], anticheat: 'EAC' },

    // ── تیراندازی رقابتی (ادامه) ────────────────────────────────────────────────
    { id: 'battlebit', fa: 'BattleBit Remastered', en: 'BattleBit Remastered', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['BattleBit.exe'], anticheat: null },
    { id: 'splitgate2', fa: 'Splitgate 2', en: 'Splitgate 2', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Splitgate2-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'paladins', fa: 'Paladins', en: 'Paladins', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Paladins.exe'], anticheat: 'EAC' },
    { id: 'planetside2', fa: 'PlanetSide 2', en: 'PlanetSide 2', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['PlanetSide2_x64.exe'], anticheat: null },
    { id: 'cs16', fa: 'Counter-Strike 1.6', en: 'Counter-Strike 1.6', cat: 'fps', klass: 'dedicated', probe: 'a2s', regions: ['eu-central', 'me'], procs: ['hl.exe'], udp: [[27015, 27015]], anticheat: 'VAC', note: 'هنوز در نت‌کافه‌های ایران و سرورهای محلی زنده است.' },
    { id: 'csgo', fa: 'CS:GO (نسخه‌ی قدیمی)', en: 'CS:GO Legacy', cat: 'fps', klass: 'relay', probe: 'a2s', regions: ['eu-central'], procs: ['csgo.exe'], udp: [[27015, 27068]], anticheat: 'VAC' },
    { id: 'csource', fa: 'Counter-Strike: Source', en: 'CS:Source', cat: 'fps', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['cstrike.exe'], udp: [[27015, 27015]], anticheat: 'VAC' },
    { id: 'arma3', fa: 'Arma 3', en: 'Arma 3', cat: 'fps', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['arma3_x64.exe'], udp: [[2302, 2306]], anticheat: 'BattlEye' },
    { id: 'armareforger', fa: 'Arma Reforger', en: 'Arma Reforger', cat: 'fps', klass: 'dedicated', probe: 'a2s', regions: ['eu-central'], procs: ['ArmaReforgerSteam.exe'], udp: [[2001, 2001], [17777, 17777]], anticheat: 'BattlEye' },
    { id: 'readyornot', fa: 'Ready or Not', en: 'Ready or Not', cat: 'fps', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['ReadyOrNot-Win64-Shipping.exe'], anticheat: null },
    { id: 'grayzone', fa: 'Gray Zone Warfare', en: 'Gray Zone Warfare', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['GZW-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'arenabreakout', fa: 'Arena Breakout: Infinite', en: 'Arena Breakout Infinite', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['ArenaBreakoutInfinite.exe'], anticheat: 'ACE' },
    { id: 'xdefiant', fa: 'XDefiant', en: 'XDefiant', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['XDefiant.exe'], anticheat: 'BattlEye' },
    { id: 'spectredivide', fa: 'Spectre Divide', en: 'Spectre Divide', cat: 'fps', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Spectre-Win64-Shipping.exe'], anticheat: null },

    // ── بتل رویال (ادامه) ───────────────────────────────────────────────────────
    { id: 'superpeople', fa: 'Super People / سایر بتل رویال‌ها', en: 'Other BR', cat: 'br', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['SuperPeople.exe'], anticheat: null },
    { id: 'darwin', fa: 'Darwin Project', en: 'Darwin Project', cat: 'br', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['DarwinProject.exe'], anticheat: null },
    { id: 'fallguys', fa: 'Fall Guys', en: 'Fall Guys', cat: 'br', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['FallGuys_client_game.exe'], anticheat: 'EAC' },

    // ── MOBA و استراتژی (ادامه) ─────────────────────────────────────────────────
    { id: 'aoe2de', fa: 'Age of Empires II: DE', en: 'AoE II DE', cat: 'moba', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['AoE2DE_s.exe'], anticheat: null, note: 'lockstep — jitter مستقیماً به کندی کل بازی تبدیل می‌شود.' },
    { id: 'aoe3de', fa: 'Age of Empires III: DE', en: 'AoE III DE', cat: 'moba', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['AoE3DE_s.exe'], anticheat: null },
    { id: 'coh3', fa: 'Company of Heroes 3', en: 'Company of Heroes 3', cat: 'moba', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['RelicCoH3.exe'], anticheat: 'EAC' },
    { id: 'totalwar', fa: 'Total War: WARHAMMER III', en: 'Total War WH3', cat: 'moba', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Warhammer3.exe'], anticheat: null },
    { id: 'civ6', fa: 'Civilization VI', en: 'Civilization VI', cat: 'moba', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['CivilizationVI.exe', 'CivilizationVI_DX12.exe'], anticheat: null },
    { id: 'civ7', fa: 'Civilization VII', en: 'Civilization VII', cat: 'moba', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Civ7.exe'], anticheat: null },
    { id: 'deadlock', fa: 'Deadlock', en: 'Deadlock', cat: 'moba', klass: 'relay', probe: 'anchors', regions: ['eu-central'], procs: ['deadlock.exe', 'project8.exe'], anticheat: 'VAC', note: 'روی Steam Datagram Relay مثل بقیه‌ی بازی‌های Valve.' },
    { id: 'predecessor', fa: 'Predecessor', en: 'Predecessor', cat: 'moba', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Predecessor-Win64-Shipping.exe'], anticheat: 'EAC' },
    { id: 'tft', fa: 'Teamfight Tactics', en: 'Teamfight Tactics', cat: 'moba', klass: 'relay', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['League of Legends.exe'], anticheat: null, note: 'از همان کلاینت League of Legends اجرا می‌شود، پس از روی نام پراسس قابل تفکیک از LoL نیست — تشخیص خودکار «LoL» را نشان می‌دهد.' },
    { id: 'legendsofruneterra', fa: 'Legends of Runeterra', en: 'Legends of Runeterra', cat: 'moba', klass: 'relay', probe: 'anchors', regions: ['eu-central'], procs: ['LoR.exe'], anticheat: null },
    { id: 'hearthstone', fa: 'Hearthstone', en: 'Hearthstone', cat: 'moba', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['Hearthstone.exe'], anticheat: null },
    { id: 'marvelsnap', fa: 'Marvel SNAP', en: 'Marvel SNAP', cat: 'moba', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['SNAP.exe'], anticheat: null },

    // ── ورزشی و مسابقه‌ای (ادامه) ───────────────────────────────────────────────
    { id: 'fc26', fa: 'EA SPORTS FC 26', en: 'EA Sports FC 26', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['FC26.exe'], udp: [[3659, 3659], [25200, 25300]], anticheat: 'EA AC', note: 'همان معماری یک‌به‌یک همتا‌به‌همتای نسخه‌های قبل.' },
    { id: 'pes2021', fa: 'PES 2021 / eFootball قدیمی', en: 'PES 2021', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['PES2021.exe'], anticheat: null, note: 'هنوز در ایران بازی می‌شود.' },
    { id: 'eawrc', fa: 'EA SPORTS WRC', en: 'EA Sports WRC', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['WRC.exe'], anticheat: 'EA AC' },
    { id: 'dirtrally2', fa: 'DiRT Rally 2.0', en: 'DiRT Rally 2.0', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['dirtrally2.exe'], anticheat: null },
    { id: 'simracing', fa: 'rFactor 2 / Automobilista / سایر مسابقه‌ای', en: 'Racing (other)', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['rFactor2.exe', 'AutomobilistaTwo.exe'], anticheat: null },
    { id: 'nfsheat', fa: 'Need for Speed (Heat / Unbound)', en: 'Need for Speed', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['NeedForSpeedHeat.exe', 'NeedForSpeedUnbound.exe'], anticheat: 'EA AC' },
    { id: 'thecrew', fa: 'The Crew Motorfest', en: 'The Crew Motorfest', cat: 'sport', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['TheCrewMotorfest.exe'], anticheat: null },
    { id: 'wreckfest', fa: 'Wreckfest', en: 'Wreckfest', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['Wreckfest_x64.exe'], anticheat: null },
    { id: 'trackmania', fa: 'Trackmania', en: 'Trackmania', cat: 'sport', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Trackmania.exe'], anticheat: null },
    { id: 'beamng', fa: 'BeamNG.drive', en: 'BeamNG.drive', cat: 'sport', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['BeamNG.drive.x64.exe'], anticheat: null },
    { id: 'ets2', fa: 'Euro Truck Simulator 2', en: 'ETS2', cat: 'sport', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['eurotrucks2.exe'], anticheat: null, note: 'TruckersMP سرور اختصاصی دارد.' },
    { id: 'ats', fa: 'American Truck Simulator', en: 'ATS', cat: 'sport', klass: 'dedicated', probe: 'anchors', regions: ['us-east', 'eu-central'], procs: ['amtrucks.exe'], anticheat: null },
    { id: 'fifaonline', fa: 'FIFA Online 4', en: 'FIFA Online 4', cat: 'sport', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['FIFAOnline4.exe'], anticheat: null },

    // ── MMO و نقش‌آفرینی (ادامه) ────────────────────────────────────────────────
    { id: 'eso', fa: 'The Elder Scrolls Online', en: 'ESO', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['eso64.exe'], tcp: [[24100, 24300]], anticheat: null },
    { id: 'rs3', fa: 'RuneScape 3', en: 'RuneScape 3', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-west'], procs: ['RuneScape.exe'], anticheat: null },
    { id: 'wowclassic', fa: 'World of Warcraft Classic', en: 'WoW Classic', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['WowClassic.exe'], tcp: [[3724, 3724], [1119, 1119]], anticheat: 'Warden' },
    { id: 'aion', fa: 'Aion', en: 'Aion', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['aion.bin'], anticheat: null },
    { id: 'metin2', fa: 'Metin2', en: 'Metin2', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['metin2client.exe'], anticheat: null, note: 'در خاورمیانه و ترکیه هنوز جامعه‌ی بزرگی دارد.' },
    { id: 'silkroad', fa: 'Silkroad Online', en: 'Silkroad Online', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['sro_client.exe'], anticheat: null, note: 'سرورهای خصوصی‌اش در ایران محبوب‌اند.' },
    { id: 'knightonline', fa: 'Knight Online', en: 'Knight Online', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['KnightOnLine.exe'], anticheat: null },
    { id: 'mu', fa: 'MU Online', en: 'MU Online', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['main.exe'], anticheat: null },
    { id: 'perfectworld', fa: 'Perfect World', en: 'Perfect World', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['elementclient.exe'], anticheat: null },
    { id: 'ragnarok', fa: 'Ragnarok Online', en: 'Ragnarok Online', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['Ragexe.exe'], anticheat: null },
    { id: 'tibia', fa: 'Tibia', en: 'Tibia', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['client.exe', 'Tibia.exe'], anticheat: null },
    { id: 'eve', fa: 'EVE Online', en: 'EVE Online', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-west'], procs: ['exefile.exe'], tcp: [[26000, 26000]], anticheat: null },
    { id: 'dofus', fa: 'Dofus / Wakfu', en: 'Dofus', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-west'], procs: ['Dofus.exe', 'Wakfu.exe'], anticheat: null },
    { id: 'poe2', fa: 'Path of Exile 2', en: 'Path of Exile 2', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['PathOfExile2.exe', 'PathOfExileSteam2.exe'], anticheat: null },
    { id: 'lastepoch', fa: 'Last Epoch', en: 'Last Epoch', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['Last Epoch.exe'], anticheat: 'EAC' },
    { id: 'd2r', fa: 'Diablo II: Resurrected', en: 'Diablo II Resurrected', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['D2R.exe'], tcp: [[1119, 1119]], anticheat: null },
    { id: 'd3', fa: 'Diablo III', en: 'Diablo III', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['Diablo III64.exe'], tcp: [[1119, 1119]], anticheat: null },
    { id: 'zenlessz', fa: 'Zenless Zone Zero', en: 'Zenless Zone Zero', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['ZenlessZoneZero.exe'], anticheat: 'mhyprot' },
    { id: 'tof', fa: 'Tower of Fantasy', en: 'Tower of Fantasy', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['Client-Win64-Shipping.exe'], anticheat: null, note: 'نام پراسس عمومی Unreal است و با Wuthering Waves یکی است؛ تفکیک فقط از روی مسیر نصب ممکن است.' },
    { id: 'blueprotocol', fa: 'Blue Protocol', en: 'Blue Protocol', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['BlueProtocol-Win64-Shipping.exe'], anticheat: null },
    { id: 'mir4', fa: 'MIR4', en: 'MIR4', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'asia-east'], procs: ['mir4.exe'], anticheat: null },
    { id: 'bless', fa: 'Bless Unleashed', en: 'Bless Unleashed', cat: 'mmo', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['Bless-Win64-Shipping.exe'], anticheat: null },
    { id: 'archeage', fa: 'ArcheAge', en: 'ArcheAge', cat: 'mmo', klass: 'tcp', probe: 'anchors', regions: ['eu-central'], procs: ['archeage.exe'], anticheat: null },

    // ── مبارزه‌ای (ادامه) ───────────────────────────────────────────────────────
    { id: 'dbfz', fa: 'Dragon Ball FighterZ', en: 'Dragon Ball FighterZ', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['RED-Win64-Shipping.exe'], anticheat: null },
    { id: 'dbsparking', fa: 'Dragon Ball: Sparking! ZERO', en: 'Sparking ZERO', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['SparkingZERO-Win64-Shipping.exe'], anticheat: 'Denuvo AC' },
    { id: 'kof15', fa: 'The King of Fighters XV', en: 'KOF XV', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central', 'me'], procs: ['KOFXV.exe'], anticheat: null },
    { id: 'granblue', fa: 'Granblue Fantasy Versus: Rising', en: 'GBVSR', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['GBVSR-Win64-Shipping.exe'], anticheat: null },
    { id: 'smashlike', fa: 'Rivals of Aether II', en: 'Rivals of Aether II', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['RivalsofAether2.exe'], anticheat: null },
    { id: 'ufc', fa: 'UFC 5 / بازی‌های مبارزه‌ای EA', en: 'EA UFC', cat: 'fight', klass: 'p2p', probe: 'anchors', regions: ['eu-central'], procs: ['UFC5.exe'], anticheat: 'EA AC' },

    // ── نظامی و شبیه‌سازی (ادامه) ───────────────────────────────────────────────
    { id: 'dcs', fa: 'DCS World', en: 'DCS World', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['DCS.exe'], udp: [[10308, 10308]], anticheat: null },
    { id: 'il2', fa: 'IL-2 Sturmovik', en: 'IL-2 Sturmovik', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'ru'], procs: ['Il-2.exe'], anticheat: null },
    { id: 'msfs', fa: 'Microsoft Flight Simulator', en: 'MSFS', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['FlightSimulator.exe', 'FlightSimulator2024.exe'], anticheat: null },
    { id: 'crossout', fa: 'Crossout', en: 'Crossout', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'ru'], procs: ['crossout.exe'], anticheat: null },
    { id: 'wotblitzpc', fa: 'World of Tanks Blitz', en: 'WoT Blitz', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central', 'ru'], procs: ['wotblitz.exe'], anticheat: null },
    { id: 'wowslegends', fa: 'World of Warships: Legends', en: 'WoWS Legends', cat: 'mil', klass: 'dedicated', probe: 'anchors', regions: ['eu-central'], procs: ['WorldOfWarshipsLegends.exe'], anticheat: null },

    // ── موبایل روی شبیه‌ساز ─────────────────────────────────────────────────────
    // The process is the EMULATOR, which carries the whole Android device's traffic.
    // Per-process routing therefore cannot separate the game from anything else running
    // inside it — the UI must say so rather than implying precision it does not have.
    { id: 'gameloop', fa: 'Gameloop (PUBG Mobile / CoD Mobile)', en: 'Gameloop', cat: 'emu', klass: 'dedicated', probe: 'anchors', regions: ['me', 'asia-south'], procs: ['AndroidEmulator.exe', 'aow_exe.exe'], anticheat: 'ACE', note: 'پراسس شبیه‌ساز کل ترافیک اندروید را حمل می‌کند — تفکیک بازی از بقیه ممکن نیست.' },
    { id: 'bluestacks', fa: 'BlueStacks (Free Fire / MLBB / Clash)', en: 'BlueStacks', cat: 'emu', klass: 'dedicated', probe: 'anchors', regions: ['me', 'asia-south'], procs: ['HD-Player.exe'], anticheat: null, note: 'همان محدودیت تفکیک.' },
    { id: 'ldplayer', fa: 'LDPlayer (Standoff 2 / Brawl Stars)', en: 'LDPlayer', cat: 'emu', klass: 'dedicated', probe: 'anchors', regions: ['me', 'ru'], procs: ['dnplayer.exe', 'LdVBoxHeadless.exe'], anticheat: null, note: 'همان محدودیت تفکیک.' },
    { id: 'memu', fa: 'MEmu / MuMu', en: 'MEmu / MuMu', cat: 'emu', klass: 'dedicated', probe: 'anchors', regions: ['me', 'asia-east'], procs: ['MEmu.exe', 'NemuPlayer.exe'], anticheat: null, note: 'همان محدودیت تفکیک.' },
];

/**
 * Games that let the player choose a server, region or datacentre themselves.
 *
 * This is the highest-value, zero-cost advice the whole feature can give. For these
 * titles, measuring the regions and saying "pick this one" changes the connection more
 * than any tunnel could — instantly, for free, with no infrastructure on either side, and
 * it cannot be filtered or throttled because nothing new is being connected to.
 *
 * Kept as a side table rather than a field on every row: it is a property of the game's
 * UI, it changes when a game patches its menus, and a separate table is far easier to
 * keep honest than twenty scattered booleans.
 *
 * The hint says WHERE the setting lives, because "choose a better region" is useless
 * advice if the player cannot find the control.
 */
const REGION_PICK = {
    'apex':        'در بازی: تنظیمات ← Datacenter، لیست را باز کن و همان منطقه را دستی انتخاب کن',
    'r6':          'در Ubisoft Connect: تنظیمات بازی ← Data Center Region',
    'poe':         'در صفحه‌ی ورود: دکمه‌ی Gateway پایین صفحه',
    'poe2':        'در صفحه‌ی ورود: دکمه‌ی Gateway پایین صفحه',
    'rocketleague':'در بازی: تنظیمات ← Gameplay ← Region',
    'overwatch2':  'در Battle.net: کنار دکمه‌ی Play، منوی منطقه',
    'dota2':       'در بازی: تنظیمات ← To Battle ← Matchmaking Regions (چند منطقه هم‌زمان قابل انتخاب است)',
    'cs2':         'در بازی: تنظیمات ← Game ← Max Acceptable Matchmaking Ping، و در ماچ‌میکینگ منطقه‌ها',
    'deadlock':    'در بازی: تنظیمات ماچ‌میکینگ ← منطقه',
    'pubg':        'در منوی اصلی: انتخاب سرور بالای صفحه',
    'warframe':    'در بازی: تنظیمات ← Gameplay ← Region',
    'warthunder':  'در بازی: تنظیمات ← Game Play ← Server',
    'wot':         'در لانچر Wargaming: انتخاب سرور بالای صفحه',
    'wows':        'در لانچر Wargaming: انتخاب سرور',
    'ffxiv':       'هنگام ساخت شخصیت یا با Data Center Travel',
    'albion':      'در صفحه‌ی ورود: انتخاب سرور (Europe / Americas / Asia)',
    'genshin':     'در صفحه‌ی ورود: انتخاب سرور — توجه: شخصیت‌ها بین سرورها منتقل نمی‌شوند',
    'hsr':         'در صفحه‌ی ورود: انتخاب سرور — شخصیت‌ها منتقل نمی‌شوند',
    'zenlessz':    'در صفحه‌ی ورود: انتخاب سرور — شخصیت‌ها منتقل نمی‌شوند',
    'bdo':         'در لانچر: انتخاب منطقه',
    'lostark':     'در بازی: انتخاب سرور هنگام ساخت شخصیت',
    'naraka':      'در منوی اصلی: انتخاب سرور',
    'deltaforce':  'در منوی اصلی: انتخاب سرور',
    'tarkov':      'در بازی: تنظیمات ← Game ← Server، و «Auto select» را خاموش کن',
    'apbreloaded': 'در صفحه‌ی ورود: انتخاب World',
    'eso':         'در صفحه‌ی ورود: انتخاب مگاسرور (EU / NA)',
    'tof':         'در صفحه‌ی ورود: انتخاب سرور',
    'mir4':        'در صفحه‌ی ورود: انتخاب سرور',
    'metin2':      'در لانچر: انتخاب سرور',
    'silkroad':    'در لانچر: انتخاب سرور',
    'knightonline':'در لانچر: انتخاب سرور',
    'ragnarok':    'در لانچر: انتخاب سرور',
    'tibia':       'در بازی: انتخاب World',
    'eve':         'در لانچر: Tranquility / Serenity',
    'fifaonline':  'در لانچر: انتخاب سرور',
    'crossfire':   'در لانچر: انتخاب سرور',
    'pointblank':  'در لانچر: انتخاب سرور',
    'warface':     'در بازی: انتخاب منطقه در منوی اصلی',
    'crossout':    'در بازی: تنظیمات ← منطقه',
    'archeage':    'در لانچر: انتخاب سرور',
    'perfectworld':'در لانچر: انتخاب سرور',
    'mu':          'در لانچر: انتخاب سرور',
    'aion':        'در لانچر: انتخاب سرور',
    'dofus':       'در صفحه‌ی ورود: انتخاب سرور',
    'thefirstdescendant': 'در بازی: تنظیمات ← Server Region',
    'blueprotocol':'در صفحه‌ی ورود: انتخاب سرور',
};

function regionHint(gameId) {
    return REGION_PICK[gameId] || null;
}

const CATEGORIES = [
    { id: 'rockstar', fa: 'راکستار و نقش‌آفرینی' },
    { id: 'fps', fa: 'تیراندازی رقابتی' },
    { id: 'br', fa: 'بتل رویال' },
    { id: 'moba', fa: 'MOBA و استراتژی' },
    { id: 'sport', fa: 'ورزشی و مسابقه‌ای' },
    { id: 'mmo', fa: 'MMO و نقش‌آفرینی' },
    { id: 'survival', fa: 'بقا و Co-op' },
    { id: 'fight', fa: 'مبارزه‌ای' },
    { id: 'mil', fa: 'نظامی و شبیه‌سازی' },
    { id: 'other', fa: 'سایر' },
    { id: 'emu', fa: 'موبایل روی شبیه‌ساز' },
];

/** Case-insensitive, with `prefix*` support. Built once. */
const PROC_INDEX = (() => {
    const exact = new Map();
    const prefixes = [];
    for (const g of GAMES) {
        for (const p of g.procs || []) {
            if (p.endsWith('*')) prefixes.push({ pre: p.slice(0, -1).toLowerCase(), game: g });
            else exact.set(p.toLowerCase(), g);
        }
    }
    return { exact, prefixes };
})();

/**
 * The user's own additions, cached against the store's revision counter.
 *
 * Rebuilt only when something was added or removed. `byProcess` is called from a six-second poll,
 * so a file read per call would be a file read every six seconds for ever.
 */
let customCache = { rev: -1, map: new Map(), games: [] };
function custom() {
    let store;
    try { store = require('./customgames'); } catch { return customCache; }
    const r = store.rev();
    if (customCache.rev !== r) {
        customCache = { rev: r, map: store.byProcessMap(), games: store.list() };
    }
    return customCache;
}

function byProcess(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    // The user's own entries first. Saying "this executable is my game" is a statement about
    // their machine, and it outranks ours — including when it corrects a mapping of ours that is
    // wrong for them.
    const mine = custom().map.get(n);
    if (mine) return mine;
    const hit = PROC_INDEX.exact.get(n);
    if (hit) return hit;
    for (const { pre, game } of PROC_INDEX.prefixes) if (n.startsWith(pre)) return game;
    return null;
}

function byId(id) {
    if (String(id || '').startsWith('custom:')) {
        return custom().games.find(g => g.id === id) || null;
    }
    return GAMES.find(g => g.id === id) || null;
}

function usesKernelAnticheat(game) {
    return !!(game && game.anticheat && ANTICHEAT_KERNEL.includes(game.anticheat));
}

/** Anchors for a game, flattened, deduped by netGroup so one operator counts once. */
function anchorsFor(game) {
    const out = [];
    const seen = new Set();
    for (const r of (game && game.regions) || ['eu-central']) {
        const reg = REGIONS[r];
        if (!reg) continue;
        for (const t of reg.tcp) {
            if (seen.has(t.group)) continue;
            seen.add(t.group);
            out.push({ ...t, region: r, regionFa: reg.fa });
        }
    }
    return out;
}

/** The shape the renderer needs — no functions, no cycles, safe to JSON. */
function publicCatalog() {
    return {
        categories: CATEGORIES,
        classFa: CLASS_FA,
        kernelAnticheat: ANTICHEAT_KERNEL,
        regions: Object.fromEntries(Object.entries(REGIONS).map(([k, v]) => [k, v.fa])),
        // The user's own games are listed alongside the catalogue's, carrying `custom: true` so
        // the panel can show them as theirs and offer to remove them.
        games: [...custom().games, ...GAMES].map(g => ({
            id: g.id, fa: g.fa, en: g.en, cat: g.cat, klass: g.klass, probe: g.probe,
            procs: g.procs, regions: g.regions, anticheat: g.anticheat,
            kernelAnticheat: usesKernelAnticheat(g),
            note: g.note || null, tips: g.tips || [],
            custom: !!g.custom,
            udp: g.udp || null, tcp: g.tcp || null,
            regionHint: REGION_PICK[g.id] || null,
        })),
    };
}

module.exports = {
    GAMES, REGIONS, UDP_ANCHORS, CATEGORIES, CLASS_FA, ANTICHEAT_KERNEL, REGION_PICK,
    byProcess, byId, anchorsFor, usesKernelAnticheat, publicCatalog, regionHint,
};
