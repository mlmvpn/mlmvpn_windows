const { app, BrowserWindow, Tray, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
// FIRST, before any manager can be required and start a child: a spawn whose binary is missing
// fails asynchronously, and an 'error' event with no listener ends this process. That closed the
// app mid-connect on 2026-09-22. See spawn-guard.js for the whole story.
try {
  require('./spawn-guard').install((line) => {
    console.error(line);
    try { require('./startup-health').note('spawn:failed', line); } catch (e) { /* no diary */ }
  });
} catch (e) { /* the app still runs; a bad spawn can still end it */ }

// The diary opens HERE, before anything heavy is required. server.js pulls in every engine
// manager at load time, and a launch that dies or hangs inside that require would otherwise
// write nothing at all — leaving "it freezes before the loading screen" with no evidence, which
// is the one thing this file exists to prevent.
let startupHealth = { gpuOff: false };
try {
  const h = require('./startup-health');
  startupHealth = h.beginLaunch();
  h.note('launch', Object.assign(h.machine(), { gpuOff: startupHealth.gpuOff, fails: startupHealth.fails }));
  if (startupHealth.undidAuto) h.note('gpu:auto-off-undone', 'an earlier build had switched it off by itself');
} catch (e) { /* run normally */ }

const { startServer } = require('./server');
try { require('./startup-health').note('modules:loaded'); } catch (e) { /* no diary */ }

let tray = null;
let mainWindow = null;

/**
 * One line in ~/.mlmvpn/startup.log.
 *
 * A window that opens black or white is the one failure that leaves nothing behind — no
 * error, no crash, no log — so every theory about it has been a theory. This writes down
 * what actually happened, in order, and the next report can be read instead of guessed at.
 */
function health(event, data) {
  try { require('./startup-health').note(event, data); } catch (e) { /* never fatal */ }
}

// Does the user want to draw on the CPU? MUST be read before app.whenReady(): Electron
// refuses disableHardwareAcceleration() after that.
//
// THEIR choice only. An earlier version turned this on by itself after two launches that did
// not report a desktop — and that was wrong twice over. It fired on a perfectly healthy app
// the first time a user ran it (the report was never arriving at all, see contextIsolation
// above), and even with the report working it could never have detected the thing it was for:
// a window that is black because the GPU cannot composite still boots, still runs, and still
// reports itself ready. The signal and the symptom are unrelated.
if (startupHealth.gpuOff) {
  try { app.disableHardwareAcceleration(); health('gpu:disabled', 'by the user'); } catch (e) { /* too late, or unsupported */ }
}

// ✅ بهینه‌سازی مصرف رم و CPU در ویندوزهای ضعیف
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
// `js-flags` reaches EVERY V8 in the app — the main process and the page alike — and the two
// have very different appetites. Measured at idle: the main process holds 34 MB of heap, the
// page 63 MB. The page is also where a scan's results live, tens of thousands of rows of them,
// so a 256 MB ceiling is the nearest one to a real workload and hitting it is not a slowdown,
// it is `render-process-gone` and a dead window.
//
// `--optimize-for-size` went with it. It tells V8 to trade speed for memory on every machine,
// including the ones with 32 GB whose owners report the app making the whole PC feel slow —
// and the measurement above says the memory it buys was never scarce. A ceiling is not a
// reservation: raising it costs nothing until something actually allocates.
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=512');

// NOTE: the Windows titleBarOverlay (caption buttons drawn by Windows, top-right)
// was removed for the macOS redesign - the page now draws traffic lights itself
// (public/components/mac-window-controls.js). OVERLAY_THEMES/initialOverlay and the
// titlebar-theme listener went with it; legacy themes still SEND that event and it
// is now simply ignored.

// Window-control IPC for the in-page traffic lights. The page draws the three
// buttons; the real window actions happen here.
ipcMain.on("window:minimize", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
});
ipcMain.on("window:maximize", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
// Routes through the same close() the titlebar X uses, so the hide-to-tray
// behaviour in mainWindow.on("close") stays the single source of truth.
ipcMain.on("window:close", () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});
// «خروج کامل» from the in-app menu bar: exactly what the tray's item does, so the
// before-quit teardowns (TUN, DNS, firewall, proxy) run the same way.
ipcMain.on("app:quit", () => {
  app.isQuitting = true;
  app.quit();
});

// The page reached a usable desktop (public/components/systemcheck.js, once the boot screen
// is gone). This is the ONLY evidence that a launch worked — a renderer painting into a
// surface nobody sees is alive, silent, and indistinguishable from a healthy one.
let readyWatchdog = null;
ipcMain.on("app:desktop-ready", () => {
  if (readyWatchdog) { clearTimeout(readyWatchdog); readyWatchdog = null; }
  health('desktop:ready');
  try { require('./startup-health').markReady(); } catch (e) { /* not fatal */ }
});

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // Below this the desktop has no room for its icons beside a window, and panels that
    // assume a side-by-side layout start overlapping (the page is tested down to 1024×640).
    minWidth: 900,
    minHeight: 580,
    title: "MLM VPN Scanner",
    // Painted before the page exists: the black of the boot screen (systemcheck.js ›
    // startBoot), so the window goes black → mark and bar → desktop, like a Mac starting.
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: true,
      // MUST be explicit. Electron has defaulted `contextIsolation` to TRUE since v12, and
      // with it on, `nodeIntegration: true` does NOT give the page's own world `require` —
      // so every `require('electron').ipcRenderer` in public/ threw and was swallowed by the
      // try/catch around it. Verified on this Electron (42.3.3) with a throwaway app using
      // these exact preferences: without this line the renderer answers
      // «require is not defined»; with it, `require` is a function and the message arrives.
      //
      // That silently disabled the in-page traffic lights (mac-window-controls.js) and the
      // menu bar's window actions (menubar.js) — both fail quietly by design, so nothing
      // ever reported it.
      contextIsolation: false,
      backgroundThrottling: false,  // ✅ جلوگیری از throttle هنگام minimize
      enableBlinkFeatures: '',
    }
  });

  mainWindow.removeMenu();
  mainWindow.maximize();

  // Settings › ظاهر › «اندازه‌ی متن» (display-settings.js): every load starts at 100%, so the
  // saved zoom goes back on each time the page finishes loading.
  // The four moments that tell a black window apart from a stuck one. Recorded even when
  // everything works, so a failing launch can be read next to a healthy one in the same file.
  mainWindow.webContents.on('did-start-loading', () => health('page:start'));
  mainWindow.webContents.on('dom-ready', () => health('page:dom-ready'));
  mainWindow.on('ready-to-show', () => health('window:ready-to-show'));
  mainWindow.webContents.on('did-finish-load', () => {
    health('page:loaded');
    try { require('./display-settings').applyTo(mainWindow && mainWindow.webContents); } catch (e) { /* default size */ }
  });

  // 127.0.0.1, NOT localhost. The server listens on 127.0.0.1 (server.js's listen call),
  // and `localhost` is a NAME — it has to be resolved, it can resolve to ::1 first where
  // nothing is listening, and this application rewires the machine's DNS for a living. The
  // one address the window needs is the one the server bound to, so ask for that.
  const pageUrl = `http://127.0.0.1:${port}/`;
  health('page:loading', pageUrl);
  mainWindow.loadURL(pageUrl);

  // Retry a bounded number of times. The previous version retried forever, so a page that
  // could never load left a permanently blank window with no hint that anything was wrong.
  let loadAttempts = 0;
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (!isMainFrame) return;              // sub-resource failures are not fatal
    if (code === -3) return;                // ERR_ABORTED: a navigation superseded this one
    console.error('Page load failed:', code, desc);
    health('page:failed', { code, desc, attempt: loadAttempts + 1 });

    if (++loadAttempts > 10) {
      showStartupError(`صفحه بارگذاری نشد پس از ${loadAttempts} تلاش.\n${code} ${desc}\nپورت: ${port}`);
      if (mainWindow) { mainWindow.destroy(); mainWindow = null; }
      return;
    }
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.loadURL(pageUrl);
      }
    }, 1000);
  });

  // A renderer crash (OOM on low-spec machines) also shows as a blank window.
  mainWindow.webContents.on('render-process-gone', (e, details) => {
    console.error('Renderer gone:', details);
    health('renderer:gone', details);
    // Settings › درباره › «گزارش خطا» lists it next time.
    if (details.reason !== 'clean-exit') {
      try { require('./crash-reporter').record('renderer', new Error(`render-process-gone: ${details.reason}`), details); } catch (err) { /* no record */ }
    }
    showStartupError(`صفحه‌ی برنامه از کار افتاد (${details.reason}).`);
    if (mainWindow) { mainWindow.destroy(); mainWindow = null; }
  });

  // ── the black-screen watchdog ───────────────────────────────────────────────────────
  //
  // did-fail-load and render-process-gone both already report themselves. This is for the
  // case neither covers and which users actually hit: the page loaded, the renderer is
  // alive, and nothing is on screen. Nobody can report that usefully — there is no error,
  // no crash and no log — so the app has to notice it itself.
  try {
    const healthApi = require('./startup-health');
    readyWatchdog = setTimeout(async () => {
      readyWatchdog = null;
      if (!mainWindow || mainWindow.isDestroyed()) return;

      // ASK THE PAGE BEFORE SAYING ANYTHING. The desktop-ready message not arriving is not
      // evidence on its own — the first version of this took it as evidence and showed the
      // dialog over a working app. executeJavaScript runs in the page's own world, needs no
      // IPC and no Node in the renderer, so it answers whenever the renderer is alive and
      // executing. If it answers, there is nothing wrong that we can see, and we say nothing.
      let answer = null;
      try {
        answer = await Promise.race([
          mainWindow.webContents.executeJavaScript('document.readyState + "|" + document.body.childElementCount + "|" + (document.body && getComputedStyle(document.body).backgroundColor)'),
          new Promise((r) => setTimeout(() => r(null), 5000)),
        ]);
      } catch (e) { answer = null; }

      // What the page said, whether or not we act on it. On a machine that draws nothing the
      // page usually answers perfectly — and that fact, written down next to the GPU's own
      // report, is the difference between knowing and guessing next time.
      healthApi.note('watchdog:probe', answer === null ? 'no answer in 5s' : answer);
      try { healthApi.note('watchdog:gpu', app.getGPUFeatureStatus()); } catch (e) { /* none */ }

      const alive = answer !== null && /complete|interactive/.test(String(answer));
      if (alive) { healthApi.note('watchdog:quiet', 'page is alive; saying nothing'); return; }

      // Put it where the user can already find it: Settings › درباره › «گزارش خطا» counts
      // these files and opens the folder. No new place to look.
      try {
        require('./crash-reporter').record('startup',
          new Error('صفحه تا ' + Math.round(healthApi.READY_DEADLINE_MS / 1000) + ' ثانیه بالا نیامد'),
          { machine: healthApi.machine(), probe: answer, diary: healthApi.diary() });
      } catch (e) { /* no record */ }

      showStuckDialog(!healthApi.read().gpuOff);
    }, healthApi.READY_DEADLINE_MS);
    if (readyWatchdog.unref) readyWatchdog.unref();
  } catch (e) { /* no watchdog, same app */ }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', function (event) {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });
}


/**
 * The page never said it was usable, and it did not answer when asked. Say what we know.
 *
 * NATIVE, not a BrowserWindow. The old version of this drew the message in a second Electron
 * window — which is the one thing that cannot work here: if the reason the app is invisible is
 * that this machine cannot put an Electron window on screen, then the window explaining that
 * is invisible too, and the user sees a program that opened nothing at all. A message box is
 * drawn by Windows itself, so it appears whatever Chromium is doing.
 */
function showStuckDialog(gpuIsOn) {
  let log = '';
  try { log = require('./startup-health').LOG; } catch (e) { /* unknown */ }
  let trail = '';
  try { trail = require('./startup-health').diary(); } catch (e) { /* none */ }

  const lines = [
    'پنجره ساخته شد و برنامه در حال اجراست، ولی صفحه‌اش پاسخ نمی‌دهد.',
    '',
    'دو علت شایع دارد:',
    '  • کارت گرافیک یا درایورش — روی سیستم‌های قدیمی‌تر، نسخه‌های ۳۲ بیتی و اتصال ریموت.',
    '  • آنتی‌ویروس که جلوی سرور داخلی برنامه را گرفته باشد.',
    '',
    gpuIsOn
      ? 'دکمهٔ زیر شتاب‌دهندهٔ گرافیکی را خاموش می‌کند و برنامه را دوباره اجرا می‌کند. صفحه با پردازنده کشیده می‌شود — کمی کندتر، ولی روی هر سیستمی کار می‌کند.'
      : 'شتاب‌دهندهٔ گرافیکی همین حالا هم خاموش است، پس علت چیز دیگری است. آنتی‌ویروس را موقتاً غیرفعال کنید و دوباره امتحان کنید.',
    '',
    'گزارش این اجرا:',
    log,
    '',
    trail,
  ];

  const buttons = gpuIsOn
    ? ['خاموش کردن شتاب‌دهنده و اجرای دوباره', 'باز کردن گزارش', 'بستن']
    : ['باز کردن گزارش', 'بستن'];

  const choice = dialog.showMessageBoxSync({
    type: 'warning',
    title: 'MLM VPN',
    noLink: true,
    message: 'برنامه باز شد ولی صفحه‌اش نیامد',
    detail: lines.join('\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  });

  const picked = buttons[choice];
  if (picked === 'خاموش کردن شتاب‌دهنده و اجرای دوباره') {
    try { require('./startup-health').setGpuOff(true); } catch (e) { /* not saved */ }
    health('gpu:disabled', 'from the stuck dialog');
    app.isQuitting = true;
    app.relaunch();
    app.quit();
  } else if (picked === 'باز کردن گزارش') {
    try { require('electron').shell.showItemInFolder(log); } catch (e) { /* no shell */ }
  }
}

// A blank window with no explanation is the worst possible failure: the user can't tell it
// from a hang, so they force-quit and reinstall. Always show something actionable instead —
// and through Windows' own message box, for the same reason showStuckDialog uses one: a
// machine that cannot draw the app cannot draw an explanation made out of the app either.
function showStartupError(message) {
  let log = '';
  try { log = require('./startup-health').LOG; } catch (e) { /* unknown */ }
  const lines = [
    'سرور داخلی برنامه شروع به کار نکرد. معمولاً یکی از این‌هاست:',
    '  • آنتی‌ویروس یا فایروال جلوی برنامه را گرفته است',
    '  • نسخه‌ی دیگری از برنامه هنوز در حال اجراست (در System Tray بررسی کنید)',
    '',
    'برنامه را ببندید و دوباره باز کنید. اگر تکرار شد، این را بفرستید:',
    String(message),
    '',
    log,
  ];
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: 'MLM VPN',
    noLink: true,
    message: 'برنامه بالا نیامد',
    detail: lines.join('\n'),
    buttons: ['باز کردن گزارش', 'بستن'],
    defaultId: 1,
    cancelId: 1,
  });
  if (choice === 0) {
    try { require('electron').shell.showItemInFolder(log); } catch (e) { /* no shell */ }
  }
}

/**
 * The tray menu, rebuilt from disk each time something in it changes.
 *
 * Two things live here that do not belong anywhere else, for the same reason: Settings and the
 * error dialogs are both INSIDE the thing that is not drawing, and this menu is not — Windows
 * draws it, so it works when nothing else does. It is the only surface a user whose window
 * opens black can still reach.
 */
function buildTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  let gpuOff = false;
  try { gpuOff = require('./startup-health').read().gpuOff; } catch (e) { /* assume on */ }
  tray.setToolTip('MLMVPN Scanner');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'نمایش برنامه', click: () => { if (mainWindow) mainWindow.show(); } },
    { type: 'separator' },
    {
      label: 'کشیدن صفحه با کارت گرافیک',
      type: 'checkbox',
      checked: !gpuOff,
      click: () => {
        // The tick is decoration; the file is the truth. Reading it back here means this does
        // not depend on when Electron flips `item.checked` relative to the handler.
        let cur = false;
        try { cur = require('./startup-health').read().gpuOff; } catch (e) { /* assume on */ }
        setGpuFromTray(!cur);
      },
    },
    // The log has to be reachable from HERE, not only from the dialog. When the cause is the
    // GPU the page is perfectly alive — it answers the watchdog — so no dialog is ever shown
    // and the user just sees black, with no way to know a report of it even exists.
    {
      label: 'باز کردن گزارش راه‌اندازی',
      click: () => {
        try {
          require('electron').shell.showItemInFolder(require('./startup-health').LOG);
        } catch (e) {
          dialog.showErrorBox('MLM VPN', 'گزارش باز نشد: ' + (e && e.message ? e.message : e));
        }
      },
    },
    { type: 'separator' },
    {
      label: 'خروج کامل', click: () => {
        app.isQuitting = true;
        app.quit();
      }
    },
  ]));
}

/** The tray's graphics lever. Saved now, honoured at the next launch. */
function setGpuFromTray(off) {
  try {
    require('./startup-health').setGpuOff(off);
  } catch (e) {
    dialog.showErrorBox('MLM VPN', 'تنظیم ذخیره نشد: ' + (e && e.message ? e.message : e));
    buildTrayMenu();
    return;
  }
  health('gpu:set-from-tray', { off });
  buildTrayMenu();

  // Electron refuses disableHardwareAcceleration() once the app is ready, so this genuinely
  // cannot apply live and saying otherwise would be a lie. Offering the restart here is the
  // difference between a setting and a fix — someone turning this on is looking at a black
  // window right now.
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: 'MLM VPN',
    noLink: true,
    message: off ? 'شتاب‌دهندهٔ گرافیکی خاموش شد.' : 'شتاب‌دهندهٔ گرافیکی روشن شد.',
    detail: off
      ? 'صفحه با پردازنده کشیده می‌شود — کمی کندتر، ولی روی هر سیستمی کار می‌کند.\n\nویندوز اجازه نمی‌دهد این وسط کار عوض شود، پس از اجرای بعدی اعمال می‌شود.'
      : 'ویندوز اجازه نمی‌دهد این وسط کار عوض شود، پس از اجرای بعدی اعمال می‌شود.',
    buttons: ['همین حالا دوباره اجرا کن', 'بعداً'],
    defaultId: 0,
    cancelId: 1,
  });
  if (choice === 0) {
    // Goes out through the same before-quit teardown as «خروج کامل», so the TUN, the DNS and
    // the firewall are put back before the process is replaced.
    app.isQuitting = true;
    app.relaunch();
    app.quit();
  }
}

// Settings › صفحه نمایش writes the same setting through the HTTP API (server.js runs in this
// process). This lets it keep the tray's checkbox honest without importing anything from here.
global.__mvRebuildTray = buildTrayMenu;

const bootStartedAt = Date.now();

app.whenReady().then(async () => {
  health('app:ready');
  let port;
  try {
    port = await startServer();
  } catch (err) {
    console.error('startServer failed:', err);
    health('server:failed', err && err.message ? err.message : String(err));
    showStartupError(err && err.message ? err.message : err);
    return;
  }

  health('server:up', { port, ms: Date.now() - bootStartedAt });

  createWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(port);
    }
  });

  const iconPath = path.join(__dirname, 'public', 'icon.ico');
  tray = new Tray(iconPath);
  buildTrayMenu();
  tray.on('click', () => {
    if (mainWindow) mainWindow.show();
  });
});

// TUN owns the machine's default route while it is up. If the app exits without tearing it
// down, the user is left with no internet and no application to turn it back off — the
// adapter outlives us. This must run on every exit path, including tray "خروج کامل".
app.on('before-quit', () => {
  try {
    require('./tun-manager').stopTun(() => { }, 'app quitting');
  } catch (err) {
    console.error('TUN teardown on quit failed:', err);
  }

  // The two machine-wide changes the Aether path makes: Windows' resolvers pointed at a
  // loopback bridge that dies with this process, and (while the kill switch is engaged) a
  // block-by-default firewall. Either one outliving us is not a broken VPN, it is a PC with
  // no internet and no clue why — and neither is undone by reinstalling the app.
  //
  // Runs FIRST and synchronously: `before-quit` does not await promises, and this is the one
  // teardown whose failure the user cannot work around.
  try {
    require('./aether-guard').bailSync();
  } catch (err) {
    console.error('Aether guard teardown on quit failed:', err);
  }

  // aether.exe is a detached child that survives us. Left running it keeps the SOCKS port
  // and a live WARP session open with no UI attached, and the next launch has to taskkill
  // a stranger before it can start — which is a large part of why "close the app and
  // reopen it" was the only reliable way to recover from a bad connect.
  try {
    require('./aether-manager').stopAether();
  } catch (err) {
    console.error('Aether teardown on quit failed:', err);
  }

  // GitHub Tunnel makes the two most dangerous machine-wide changes in the whole app: a
  // block-by-default firewall profile, and (in proxy mode) the Windows proxy switch
  // pointing at a port that only exists while we do. Either one outliving us is not a
  // broken VPN, it is a PC with no internet and no clue why.
  //
  // The module installs its own process-level hooks, but those are the last line, not the
  // first: Electron can take paths where 'exit' listeners are not what tears the process
  // down, and 'before-quit' is the one place guaranteed to run for the tray's «خروج کامل».
  // Both calls are synchronous and idempotent, so running them here as well costs nothing
  // and covers the case where the hooks do not fire.
  try {
    require('./github-tunnel/gt-guard').disengageSync();
  } catch (err) {
    console.error('GitHub Tunnel kill-switch teardown on quit failed:', err);
  }
  try {
    require('./github-tunnel/gt-engine').bailSync();
  } catch (err) {
    console.error('GitHub Tunnel engine teardown on quit failed:', err);
  }

  // The system proxy is the other machine-wide change we make, and leaving it pointing
  // at a port that dies with us takes the user's internet down with no visible cause.
  // Synchronous on purpose: `before-quit` does not wait for promises, so an async
  // cleanup would be cut off mid-flight.
  try {
    const gstRuntime = require('./gst/gst-runtime');
    if (gstRuntime.systemProxyIsOurs()) {
      // disableSystemProxySync, not enableSystemProxy(false): the latter is queued and
      // asynchronous now (it sits on the connect and disconnect click paths, where three
      // synchronous `reg add` spawns froze the window), and `before-quit` would be cut off
      // mid-flight — leaving Windows pointing at a port that dies with us.
      require('./xray-manager').disableSystemProxySync();
    }
  } catch (err) {
    console.error('System proxy teardown on quit failed:', err);
  }

  // Same failure shape as TUN, one layer down: the dedicated-DNS bridge points every
  // adapter at 127.0.0.1:53, and that listener dies with this process. Exiting without
  // undoing it leaves the machine resolving nothing at all. Synchronous, for the same
  // reason as above.
  // Verdicts are written back on a short debounce, so anything learned in the last half
  // second would be lost — and a lost verdict means the next session pays for that
  // measurement again.
  try {
    require('./route-cache').flush();
  } catch (err) {
    console.error('Route cache flush on quit failed:', err);
  }

  // THIS IS WHERE THE "MY DNS KEEPS TURNING INTO SHECAN" BUG LIVED.
  //
  // Both calls below used to be `restoreBackupSync()` with no argument, which falls back to
  // ~/.mlmvpn/dns-backup.json — a snapshot taken the FIRST time this app ever touched DNS and
  // never overwritten since. On a real install that file was 26 days old and recorded
  // 178.22.122.101 / 185.51.200.1 (Shecan Pro). So every single time the user closed the app,
  // it silently wrote a filtering Iranian resolver onto their adapters, and the next launch
  // came up on Shecan. It looked like the app "automatically switches DNS to Shecan on
  // startup"; it was actually doing it on shutdown, every time.
  //
  // `sweepOnly` is the correct contract for a teardown: get the machine OFF the loopback
  // resolver that is about to stop existing, and change nothing else. Restoring what the user
  // had thirty seconds ago is the job of aether-guard.bailSync() above, which holds a snapshot
  // from THIS session and knows whether it is still fresh.
  try {
    const dedicatedDns = require('./dedicated-dns-manager');
    if (dedicatedDns.systemWideStatus().wanted) {
      require('./dns-manager').restoreBackupSync({ sweepOnly: true });
      dedicatedDns.setConfig({ systemWide: false });
    }
  } catch (err) {
    console.error('Dedicated DNS teardown on quit failed:', err);
  }

  // The Aether DNS bridge has the same failure shape as dedicated DNS: adapters point at
  // 127.0.0.1:53 and the listener dies with this process. The sweep frees any adapter still
  // on a loopback resolver, so it is safe to run unconditionally.
  try {
    require('./dns-manager').restoreBackupSync({ sweepOnly: true });
  } catch (err) {
    console.error('Aether DNS teardown on quit failed:', err);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Keep app running in tray instead of quitting
  }
});

