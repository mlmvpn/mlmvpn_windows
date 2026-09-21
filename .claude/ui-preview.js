#!/usr/bin/env node
/*
 * UI-only preview server for design work.
 *
 * Serves public/ the way server.js does — index.html with the storage state injected —
 * but runs NONE of the app's startup. server.js cannot be used for a quick look: its
 * startServer() releases a stale Aether firewall, repairs "stranded" loopback DNS and
 * re-enables the dedicated DNS bridge. With the real app running at the same time, that
 * recovery would treat the live session as leftovers and tear it down.
 *
 * Here every /api/* call answers 503 and nothing is ever written: panels render their
 * offline state and the machine is left alone.
 *
 *   node .claude/ui-preview.js            real saved state from ~/.mlmvpn/user_data.json (read-only)
 *   MV_PREVIEW_STATE=empty node ...        first-run look, no saved state
 *   MV_PREVIEW_SET='{"mv-shell":"off"}'    override saved keys (here: the legacy layout)
 *   MV_PREVIEW_API=1 node ...              a few Settings GETs answered from the saved settings
 *                                          files (read-only; see READ_ONLY_API) — every other
 *                                          call, and every POST, still answers 503
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..', 'public');
// --port=N and --api are the same as PORT and MV_PREVIEW_API, for launchers that cannot set env.
const argPort = (process.argv.find((a) => a.startsWith('--port=')) || '').slice(7);
const PORT = Number(argPort) || Number(process.env.PORT) || 35299;
if (process.argv.includes('--api')) process.env.MV_PREVIEW_API = '1';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.ttf': 'font/ttf', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function savedState() {
  const extra = process.env.MV_PREVIEW_SET ? JSON.parse(process.env.MV_PREVIEW_SET) : {};
  return Object.assign(baseState(), extra);
}
function baseState() {
  if (process.env.MV_PREVIEW_STATE === 'empty') return {};
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), '.mlmvpn', 'user_data.json'), 'utf8');
    return JSON.parse(raw) || {};
  } catch (e) {
    return {};
  }
}

// MV_PREVIEW_API=1: the Settings panes' GETs, answered by READING the files the real server
// reads. Nothing here writes, spawns, or touches the network; the modules required have no
// start-up side effects (network-settings, display-settings and app-routing only read JSON).
const ROOT_DIR = path.join(__dirname, '..');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
const READ_ONLY_API = {
  '/api/network': () => {
    const ns = require(path.join(ROOT_DIR, 'network-settings.js'));
    return Object.assign({}, ns.get(), { active: null, running: false, tunnel: false, lan: ns.lanAddresses(), defaultMtu: ns.DEFAULT_MTU });
  },
  '/api/display': () => require(path.join(ROOT_DIR, 'display-settings.js')).get(),
  // Whether this machine draws on the GPU. One small JSON read, nothing spawned.
  '/api/display/gpu': () => {
    const h = require(path.join(ROOT_DIR, 'startup-health.js')).read();
    return { ok: true, gpuOff: h.gpuOff, auto: h.gpuOffAuto, fails: h.fails };
  },
  // The tunnel diary, for «سرعت و پایداری تونل». Reads one file and nothing else.
  '/api/tun/report': () => {
    const file = path.join(os.homedir(), '.mlmvpn', 'tunnel-events.log');
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-80); } catch (e) { /* none yet */ }
    return { ok: true, file, tunnel: null, running: false, lines };
  },
  '/api/app-routing': () => Object.assign(require(path.join(ROOT_DIR, 'app-routing.js')).get(), { tunnel: false }),
  '/api/system': () => {
    const s = readJson(path.join(os.homedir(), '.mlmvpn', 'system-settings.json'), {});
    return { alwaysOn: s.alwaysOn === true, lockMinutes: Number(s.lockMinutes) || 0, taskPresent: s.alwaysOn === true, launcher: '' };
  },
  '/api/update': () => {
    const u = readJson(path.join(os.homedir(), '.mlmvpn', 'update.json'), {});
    return { currentVersion: readJson(path.join(ROOT_DIR, 'package.json'), {}).version, kind: 'Setup', arch: 'x64', checking: false,
      latest: null, error: '', download: null, downloaded: null, autoDownload: u.autoDownload !== false, lastCheckAt: u.lastCheckAt || null,
      installedOn: null, repo: 'mlmvpn/mlmvpn_windows' };
  },
  '/api/crash': () => {
    const dir = path.join(os.homedir(), '.mlmvpn', 'crashlogs');
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => /^crash-.*\.txt$/.test(n)); } catch (e) { /* none */ }
    return { reports: names.map((n) => ({ name: n, at: fs.statSync(path.join(dir, n)).mtimeMs, kind: /renderer/.test(n) ? 'renderer' : 'main', title: '' })), dir };
  },
  '/api/v2ray/traffic': () => Object.assign({ daily: {}, totalUp: 0, totalDown: 0 }, readJson(path.join(os.homedir(), '.mlmvpn_traffic_db.json'), {}), { running: false }),
  // «اوپن‌وی‌پی‌ان»: the catalogue over the shared relay archive. Every call here is a disk read
  // — the archive CSV, its last-seen sidecar and this engine's own curation file. It spawns no
  // core, dials nothing and writes nothing, so the same guarantee as every other entry holds.
  // It exists because this panel is almost entirely a list, and a list cannot be judged empty.
  '/api/openvpn/list': () => {
    const ov = require(path.join(ROOT_DIR, 'openvpn-manager.js'));
    const l = ov.lists();
    return Object.assign({ ok: true }, l, {
      suggested: ov.suggest(),
      status: ov.getStatus(),
      fronts: ov.liveSocksPorts().map((p) => ({ port: p, name: ov.viaName(p) })),
    });
  },
  // «ام‌ال‌ام استور»: reads the disk (each core's own version flag) and the last worker survey from
  // its cache. No network, nothing written — the same guarantee as every other entry here.
  '/api/store/catalog': () => require(path.join(ROOT_DIR, 'store-manager.js')).catalogRows(),
  '/api/store/jobs': () => ({ ok: true, jobs: require(path.join(ROOT_DIR, 'store-manager.js')).jobs.all() }),
  // «گف»: the country and exit lists, read from the caches the engine itself wrote. Both
  // functions fall back to disk when no client is running, so this spawns nothing, dials
  // nothing and writes nothing — the same guarantee as every other entry here. It exists so
  // the exit picker can be LOOKED AT with real data: its whole behaviour (which countries a
  // Free account may use, which are locked, which cities a country has) is invisible against
  // an empty payload.
  '/api/geph/status': async () => {
    const geph = require(path.join(ROOT_DIR, 'geph-manager.js'));
    return {
      installed: geph.isInstalled(),
      status: Object.assign({}, geph.getStatus(), { connected: false, running: false }),
      socksPort: geph.SOCKS_PORT,
      httpPort: geph.HTTP_PORT,
      regions: await geph.regions(),
      exits: await geph.exits(),
      fastest: geph.lastFastest(),
      sweep: { running: false },
      tun: false,
    };
  },

  // «اتصال سریع»'s catalogue, read from the cache on disk. Read-only and network-free: it
  // just parses the file the app already wrote, which is enough for the sweep controls and the
  // country picker to be LOOKED AT with real counts instead of against an empty payload.
  '/api/quick/catalog': async () => {
    const quick = require(path.join(ROOT_DIR, 'quick-connect.js'));
    return { ok: true, ...(await quick.catalog({})) };
  },
  '/api/quick/status': async () => ({
    ok: true, engine: false, systemProxy: false, tunnel: false, tunnelReady: true, tunnelReason: null,
  }),

  // تور, for the same reason — and with one addition. Its panel grew a set of cards that only
  // exist WHILE CONNECTED (the live circuit, the path measurement, the byte counters), and those
  // cannot be looked at against a disconnected engine. `MV_PREVIEW_TOR=connected` fills them with
  // an obviously-fake session so the layout can be checked; without it the real, honest state is
  // reported. Nothing here starts tor or touches the network either way.
  '/api/tor/status': async () => {
    const tor = require(path.join(ROOT_DIR, 'tor-manager.js'));
    const fake = process.env.MV_PREVIEW_TOR === 'connected';
    return {
      installed: tor.isInstalled(),
      status: Object.assign({}, tor.getStatus(), fake ? {
        running: true, connected: true, mode: 'direct', stage: 'connected', percent: 100,
        since: Date.now() - 480000, egressRegion: 'NL',
        circuits: { built: 12, building: 1 },
        traffic: { read: 18_400_000, written: 1_240_000 },
        path: { at: Date.now(), ms: 22300, target: 2.5, draws: 2, keptBest: true,
          current: { draw: 2, mbit: 5.03, ok: true, good: true, exit: { nick: 'NTH61R6', country: 'NL' } },
          best: { draw: 2, mbit: 5.03 } },
      } : { connected: false, running: false }),
      socksPort: tor.SOCKS_PORT, httpPort: tor.HTTP_PORT, dnsPort: tor.DNS_PORT,
      modes: tor.MODES,
      regions: tor.regions(),
      tun: false,
    };
  },
  '/api/tor/live': async () => {
    if (process.env.MV_PREVIEW_TOR !== 'connected') return { ok: true, live: null };
    return { ok: true, live: {
      established: true, circuits: 13, built: 12, building: 1,
      read: 18_400_000, written: 1_240_000,
      path: [
        { fp: 'A'.repeat(40), nick: 'zgato', country: 'US', ip: '50.118.225.16' },
        { fp: 'B'.repeat(40), nick: 'TorZoner', country: 'CZ', ip: '185.129.62.62' },
        { fp: 'C'.repeat(40), nick: 'NTH61R6', country: 'NL', ip: '185.220.101.7' },
      ],
      exit: { fp: 'C'.repeat(40), nick: 'NTH61R6', country: 'NL', ip: '185.220.101.7' },
    } };
  },
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);

  if (url.startsWith('/api/') && process.env.MV_PREVIEW_API && req.method === 'GET' && READ_ONLY_API[url]) {
    // A handler may be async (the store reads versions off the binaries themselves).
    Promise.resolve().then(() => READ_ONLY_API[url]()).then(
      (v) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(v)); },
      (e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'UI preview: ' + e.message })); });
    return;
  }

  if (url.startsWith('/api/')) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'UI preview: the app backend is not running' }));
    return;
  }

  if (url === '/' || url === '/index.html') {
    let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const inject = `<head><script>window.__INITIAL_STORAGE_STATE__ = ${JSON.stringify(savedState())}; window.__MV_PREVIEW__ = true;</script>`;
    html = html.replace('<head>', inject);
    res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  const file = path.normalize(path.join(ROOT, url));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
});

// The page opens ws://…/ws for live logs; refuse it so nothing waits on a socket.
server.on('upgrade', (req, socket) => socket.destroy());

server.listen(PORT, '127.0.0.1', () => {
  console.log(`UI preview on http://127.0.0.1:${PORT}/ (no backend, read-only)`);
});
