/*
 * Adapter settings and the Wi-Fi band — the two places this could tell somebody the wrong thing.
 *
 * WHY THESE AND NOT THE POWERSHELL
 * Reading a driver property is plumbing. What matters is the ADVICE that comes out, because a
 * player will act on it: buy a dual-band dongle, hunt through a driver dialog, run a machine with
 * a setting changed. Two ways to get that wrong, and both were real risks here:
 *
 *   1. Offering a switch the adapter does not have. Measured on the machine this was written on,
 *      a Realtek RTL8188FTV exposes `*SelectiveSuspend` and NOT `*InterruptModeration`,
 *      `*FlowControl` or `*EEE`. A hard-coded list of "gaming NIC tweaks" would have shown four
 *      controls, three of them dead.
 *   2. Telling a 2.4 GHz-only adapter to move to 5 GHz. That dongle declares `IEEE 802.11b/g/n`:
 *      no 'a', so no 5 GHz, so there is nothing to switch to. The first version of the band test
 *      used `\bax\b`, which cannot match "802.11ax" — the `1` and the `a` are both word characters
 *      — and would have classified an ax adapter as 2.4-only.
 *
 * Pure: the registry of tweaks is inspected as data, and the band classifier is given strings.
 */
'use strict';

const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const tweaks = require(path.join(ROOT, 'game', 'tweaks'));
const localaudit = require(path.join(ROOT, 'game', 'localaudit'));

const results = [];
const t = (name, cond, detail) => results.push({ name, ok: !!cond, detail });

// ── the tweak registry ───────────────────────────────────────────────────────────
{
    const ids = Object.keys(tweaks.TWEAKS);
    for (const id of ['usbsuspend', 'intmod', 'flowctl', 'eee']) {
        t(`«${id}» is offered`, ids.includes(id), ids.join(','));
    }

    for (const id of ['usbsuspend', 'intmod', 'flowctl', 'eee']) {
        const tw = tweaks.TWEAKS[id];
        // This is the flag that stops a dead control being shown as "off, click to fix".
        t(`«${id}» reports an adapter that lacks it as unsupported, not as off`,
            tw.nullMeans === 'unavailable', tw.nullMeans);
        // The `*` keywords are Microsoft's and mean the same on every vendor's card. A
        // vendor-specific name would work on one adapter and silently do nothing on the next.
        t(`«${id}» targets a standardised NDIS keyword`,
            /^\*/.test(String(tw.target).trim()), tw.target);
        t(`«${id}» explains itself in Persian`, !!tw.fa && !!tw.why);
    }

    // These are latency settings. None of them makes a frame render faster, and the wording must
    // not drift into promising it — that is the line this project draws against every other
    // "booster" on the internet.
    //
    // The pattern is deliberately NOT the bare word «فریم». Two of these descriptions use it
    // correctly in its OTHER sense — a network frame — because that is what the mechanism is
    // called: «فریم Pause» is the name of the 802.3x mechanism, and EEE powers the PHY down
    // «بین فریم‌ها». A test that flagged those would be demanding the text be less accurate.
    const PROMISES_FPS = /\bFPS\b|نرخ فریم|فریم بر ثانیه|فریم‌بر ثانیه/i;
    for (const id of ['usbsuspend', 'intmod', 'flowctl', 'eee']) {
        t(`«${id}» does not promise FPS`, !PROMISES_FPS.test(tweaks.TWEAKS[id].why), tweaks.TWEAKS[id].why);
    }
}

// ── the picture side ─────────────────────────────────────────────────────────────
{
    t('background game recording is offered', !!tweaks.TWEAKS.gamedvr);
    t('…and it is honest about WHY it helps — by removing work, not by tuning',
        /کار را کم می‌کند|جادویی/.test(tweaks.TWEAKS.gamedvr.why), tweaks.TWEAKS.gamedvr.why);

    // HAGS is the one setting here that can cost somebody their display if it is offered wrongly.
    // Measured on this machine: two 2013 GPUs, `HwSchModeSupport` not reported, and the tweak
    // correctly reads as unavailable. What is pinned is the RULE, not that outcome.
    const hags = tweaks.TWEAKS.hags;
    t('HAGS is offered', !!hags);
    t('…and reports unavailable rather than guessing, because a wrong "yes" can black-screen a machine',
        hags.nullMeans === 'unavailable', hags.nullMeans);
    t('…and says it needs a reboot, because it does', hags.needsReboot === true);
    t('…and its stated target is the documented value', /HwSchMode\s*=\s*2/.test(hags.target), hags.target);
}

// ── the band classifier ──────────────────────────────────────────────────────────
{
    const c = localaudit.classifyBand;

    // The machine this was written on, verbatim from its driver.
    const here = c(5, 'IEEE 802.11b/g/n');
    t('a b/g/n adapter on channel 5 is 2.4 GHz', here.ghz === 2.4);
    t('…and is NOT offered a 5 GHz it does not have — "n" exists on both bands',
        here.canDo5 === false, JSON.stringify(here));

    t('an a/b/g/n/ac adapter on channel 36 is 5 GHz and capable',
        c(36, 'IEEE 802.11a/b/g/n/ac').ghz === 5 && c(36, 'IEEE 802.11a/b/g/n/ac').canDo5 === true);

    // The bug the first version had: \b cannot match inside "802.11ax".
    t('802.11ax is recognised as 5 GHz-capable', c(149, '802.11ax').canDo5 === true);
    t('802.11ac is recognised as 5 GHz-capable', c(44, '802.11ac').canDo5 === true);
    t('a plain 802.11a adapter is recognised', c(6, '802.11a/b/g/n').canDo5 === true);

    t('802.11g alone is not 5 GHz-capable', c(3, '802.11g').canDo5 === false);
    t('802.11n alone is not either — the whole point of the distinction',
        c(1, '802.11n').canDo5 === false);

    // Channel decides the band, without ambiguity.
    t('channel 14 is still 2.4 GHz', c(14, '802.11n').ghz === 2.4);
    t('channel 36 is 5 GHz', c(36, '802.11n').ghz === 5);

    t('a missing channel is no answer rather than a guess', c(0, 'x') === null && c(null, 'x') === null);
}

let failed = 0;
for (const x of results) {
    if (!x.ok) failed++;
    console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok ? '' : '   → ' + (x.detail || '')}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
