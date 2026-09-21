// --- GST connection modes ---
// TWO modes:
//   1  tunnel only    engine listens on 127.0.0.1 (HTTP + SOCKS5); Windows untouched
//   2  system proxy   + Windows proxy points at the engine's HTTP port
//
// ## There was a third, and it was removed (2026-09-20)
//
// A sing-box TUN adapter fed the whole machine into the engine's SOCKS port. It never worked
// on the line it was built for, and three rounds of fixes each uncovered the next failure
// rather than the last one:
//
//   1. The engine strangled itself. GST passed no address exclusion of its own, so it was given
//      Aether's (Cloudflare WARP ranges) while it dials Google's edge — and when Windows refused
//      the process lookup, gst.exe's own uplink was captured and handed back to gst.exe.
//      Fixed, and measured: `engine=0` became `engine=2048`.
//   2. Then nothing could resolve a name. Every TCP/53 query came back
//      «An existing connection was forcibly closed by the remote host», in a flood, while the
//      same resolvers answer in 138–313 ms with the tunnel down — it is the volume of one
//      machine's lookups on one port that draws the reset.
//   3. So DNS was removed from the path entirely with a fakeip server, which sing-box accepted
//      and which suited this engine exactly (Apps Script resolves at Google, so the address this
//      machine gets is never dialled). It still did not work.
//
// The honest reading is that this engine is the wrong shape for a TUN. It is an HTTP relay: it
// MITMs TLS and forwards plain HTTP through Apps Script, and hands everything else straight out
// untouched — measured from its own dispatch log:
//
//     example.com:443 -> MITM + Apps Script relay (TLS detected)
//     github.com:22   -> raw-tcp (direct) (non-HTTP, non-TLS client payload)
//     1.1.1.1:53      -> raw-tcp (direct) (non-HTTP, non-TLS client payload)
//
// A TUN hands an engine EVERY protocol the machine speaks. This one can carry two of them. So
// the mode promised «همه‌ی برنامه‌ها، بدون هیچ نشتی» and could not have delivered it even
// working: the DNS and the raw TCP were leaving in the clear the whole time.
//
// The proxy mode is honest about the same limitation — a program either speaks to the proxy or
// it does not — which is why it works and why it is what remains.
//
// The teardown paths in `releaseAll` and `healAfterCrash` are KEPT: a machine that had the mode
// switched on still has the adapter and the stored flag, and must be put back.
//
// GST stays exclusive with Xray/Aether: there is one Windows proxy setting, and two engines
// fighting over it leak traffic.

const { execSync } = require('child_process');

const store = require('./gst-config');
const core = require('./gst-core');
const log = require('./gst-log');

const tun = require('../tun-manager');
const { enableSystemProxy } = require('../xray-manager');

/** What Windows currently has configured, read back from the registry. */
function readSystemProxy() {
    // A machine that has never had a proxy set simply has no such value, and `reg query`
    // treats that as an error — so stderr is suppressed: it is an expected state, not a
    // fault worth printing to the console on every status poll.
    const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const read = (value) => {
        try {
            return execSync(`reg query "${KEY}" /v ${value}`,
                { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        } catch (e) {
            return '';
        }
    };

    const server = (read('ProxyServer').match(/ProxyServer\s+REG_SZ\s+(\S+)/) || [])[1] || '';
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(read('ProxyEnable'));
    return { enabled, server };
}

/** Is the Windows proxy pointing at OUR engine, as opposed to Xray's or someone else's? */
function systemProxyIsOurs() {
    const rt = store.getRuntime();
    const state = readSystemProxy();
    return state.enabled && state.server === `127.0.0.1:${rt.httpPort}`;
}

/**
 * Shut down the other engines before GST takes the data plane.
 *
 * Chaining GST behind Xray would double the encryption and add a hop for no benefit —
 * GST already does its own domain fronting. And with one default route between them,
 * two engines running at once is how traffic leaks.
 */
function stopCompetingEngines() {
    const stopped = [];

    // Exact export names, verified against the modules: xray-manager exposes
    // startXray/stopXray/isRunning, aether-manager exposes startAether/stopAether/
    // isRunning. Guessing `stop()` here would have silently left the other engine
    // running while we reported it stopped.
    try {
        const xray = require('../xray-manager');
        if (xray.isRunning()) {
            xray.stopXray();
            stopped.push('Xray');
        }
    } catch (e) {
        log.warn('runtime', `خاموش کردن Xray ناموفق بود: ${e.message}`);
    }

    try {
        const aether = require('../aether-manager');
        if (aether.isRunning()) {
            aether.stopAether();
            stopped.push('وارپ');
        }
    } catch (e) {
        log.warn('runtime', `خاموش کردن وارپ ناموفق بود: ${e.message}`);
    }

    if (stopped.length) {
        log.info('runtime', `${stopped.join(' و ')} خاموش شد تا تونل گوگل اسکریپت با بیشترین سرعت کار کند`);
    }
    return stopped;
}

/** Current state of all three layers. */
async function getState() {
    const rt = store.getRuntime();
    const running = core.isRunning();
    return {
        running,
        httpPort: rt.httpPort,
        socksPort: rt.socksPort,
        systemProxy: running && systemProxyIsOurs(),
    };
}

/**
 * Mode 2. Pointing Windows at a dead port kills all connectivity and looks like the app
 * broke the machine, so the engine must be live first — verified by an actual connection,
 * not by our own "running" flag.
 */
async function setSystemProxy(enabled) {
    const rt = store.getRuntime();

    if (enabled) {
        if (!(await core.probePort(rt.httpPort))) {
            throw new Error(
                `تونل گوگل اسکریپت اجرا نیست (پورت ${rt.httpPort} خالی است). ` +
                'اول تونل را وصل کنید، بعد پروکسی سیستم را روشن کنید — وگرنه کل اینترنت ویندوز قطع می‌شود.');
        }
        // A leftover adapter from the removed full-tunnel mode would black-hole the default
        // route while the proxy points at the engine. Nothing can turn it on any more, but a
        // machine that had it on before the update can still be carrying one.
        if (tun.isRunning()) {
            tun.stopTun(line => log.info('runtime', line));
            store.setRuntime({ tun: false });
            log.info('runtime', 'تونل سراسری باقی‌مانده خاموش شد — این حالت دیگر وجود ندارد');
        }
    }

    enableSystemProxy(!!enabled, rt.httpPort);
    store.setRuntime({ systemProxy: !!enabled });
    log.ok('runtime', enabled
        ? `پروکسی سیستم روی 127.0.0.1:${rt.httpPort} تنظیم شد`
        : 'پروکسی سیستم خاموش شد');

    return getState();
}

/**
 * Undo every machine-wide change. Called when the tunnel stops, so a disconnected tunnel
 * never leaves Windows pointing at a dead proxy or a TUN adapter with no engine behind
 * it — the two states that strand a user with no internet and no obvious cause.
 */
async function releaseAll() {
    const changes = [];
    try {
        if (tun.isRunning()) {
            tun.stopTun(line => log.info('runtime', line));
            changes.push('تونل سراسری');
        }
    } catch (e) { log.warn('runtime', `خاموش کردن تونل سراسری: ${e.message}`); }

    try {
        // Only clear the proxy if it is OURS: the user may have set it themselves, or
        // Xray may own it, and clearing that would be us breaking someone else's setup.
        if (systemProxyIsOurs()) {
            enableSystemProxy(false, store.getRuntime().httpPort);
            changes.push('پروکسی سیستم');
        }
    } catch (e) { log.warn('runtime', `خاموش کردن پروکسی سیستم: ${e.message}`); }

    store.setRuntime({ systemProxy: false, tun: false });
    if (changes.length) log.info('runtime', `${changes.join(' و ')} به حالت اولیه برگشت`);
    return changes;
}

/**
 * Undo machine-wide changes left behind by a PREVIOUS run that never got to clean up.
 *
 * `before-quit` covers graceful exits, but it cannot run at all when the process is
 * killed from Task Manager or the machine loses power. In that case Windows keeps
 * pointing at a proxy port with nothing behind it and the user has no internet, no
 * error, and no obvious connection to this app — the worst possible failure, because
 * the natural reaction is to blame the network rather than to reopen the app that
 * could fix it.
 *
 * Run once at startup, BEFORE the panel can report state. Safe by construction: it only
 * touches the proxy when it points at our own port AND nothing is listening there, so a
 * second instance, Xray's proxy, or a proxy the user set themselves are all left alone.
 */
async function healAfterCrash() {
    const healed = [];

    try {
        const rt = store.getRuntime();
        const state = readSystemProxy();
        const ours = state.enabled && state.server === `127.0.0.1:${rt.httpPort}`;

        if (ours && !(await core.probePort(rt.httpPort))) {
            enableSystemProxy(false, rt.httpPort);
            healed.push(`پروکسی سیستم روی پورت ${rt.httpPort} خالی مانده بود`);
        }
    } catch (e) {
        log.warn('runtime', `بررسی پروکسی باقی‌مانده ناموفق بود: ${e.message}`);
    }

    try {
        // A TUN adapter with no engine behind it black-holes the default route. Our own
        // process cannot have started it (we just booted), so anything running is a
        // leftover from a previous run.
        if (tun.isRunning()) {
            tun.stopTun(line => log.info('runtime', line));
            healed.push('تونل سراسری از اجرای قبلی باز مانده بود');
        }
    } catch (e) {
        log.warn('runtime', `بررسی تونل باقی‌مانده ناموفق بود: ${e.message}`);
    }

    // The stored flags describe a tunnel that is definitely not running now.
    store.setRuntime({ systemProxy: false, tun: false });

    if (healed.length) {
        log.warn('runtime', `پاک‌سازی پس از بسته شدن ناگهانی: ${healed.join(' و ')} — برطرف شد`);
    }
    return healed;
}

module.exports = {
    getState,
    setSystemProxy,
    releaseAll,
    healAfterCrash,
    stopCompetingEngines,
    systemProxyIsOurs,
    readSystemProxy,
};
