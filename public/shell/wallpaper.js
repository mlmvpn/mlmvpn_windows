/* =====================================================================
   Wallpaper — «کوهستان» (drawn), the ten Android presets, or a photo.
   ---------------------------------------------------------------------
   • «کوهستان»: sky, four ridges by midpoint displacement from fixed
     seeds, their reflection in a lake. Day in light, dusk in dark.
   • The ten presets are the Android app's own (Wallpapers.kt): the same
     ids, names, base colours and radial blobs, so both apps can wear the
     same backdrop.
   • «عکس دلخواه»: scaled to at most 2560px, kept as a JPEG in IndexedDB —
     never in the settings file, which is injected into every page load.
   • Blur (0–100%) is baked in when drawing; nothing redraws on a timer.
   Choice: PersistentStorage 'mv-wallpaper' = { id, blur }.

   It also owns the picture behind a connect button (the engine pages' hero):
   PersistentStorage 'mv-hero' = { mode, dim, blur }, its own photo in the
   same IndexedDB store. One module for «pictures shown behind things».
   ===================================================================== */
(function () {
  'use strict';

  var MV = window.MV;
  var canvas = null;
  var photo = null;          // ImageBitmap of the custom photo, once loaded
  var photoUrl = null;       // object URL, for its thumbnail
  var cfg = read();
  var pickers = [];

  function read() {
    try {
      var raw = window.PersistentStorage && PersistentStorage.getItem('mv-wallpaper');
      var v = raw ? JSON.parse(raw) : null;
      if (v && typeof v.id === 'string') return { id: v.id, blur: Math.max(0, Math.min(100, +v.blur || 0)) };
    } catch (e) { /* default */ }
    return { id: 'mountain', blur: 0 };
  }
  function save() { MV.store('mv-wallpaper', JSON.stringify(cfg)); }

  // ── Presets (artwork: fixed colours by design) ───────────────────────────
  var PRESETS = [
    { id: 'mountain', fa: 'کوهستان' },
    { id: 'dusk', fa: 'شامگاه', base: '#241A16', blobs: [[.20, .16, .85, '#5C4033'], [.86, .34, .62, '#4A2F26'], [.50, .94, .75, '#1A1210']] },
    { id: 'amber', fa: 'کهربا', base: '#2A1E12', blobs: [[.78, .14, .80, '#7A5320'], [.14, .52, .66, '#4B331A'], [.55, .98, .70, '#1C1409']] },
    { id: 'indigo', fa: 'نیلی', base: '#161A2E', blobs: [[.24, .20, .82, '#33407A'], [.84, .60, .68, '#283155'], [.50, .96, .72, '#0E1120']] },
    { id: 'charcoal', fa: 'زغالی', base: '#1A1A1C', blobs: [[.30, .18, .86, '#3A3A3F'], [.82, .70, .60, '#2A2A2E'], [.50, 1.00, .70, '#101012']] },
    { id: 'mist', fa: 'مه صبح', base: '#1E2626', blobs: [[.22, .24, .84, '#44585A'], [.80, .22, .58, '#35494B'], [.55, .95, .72, '#141A1A']] },
    { id: 'violet', fa: 'ارغوانی', base: '#221831', blobs: [[.76, .18, .80, '#56317A'], [.18, .58, .66, '#3A2352'], [.50, .98, .70, '#150F1F']] },
    { id: 'ocean', fa: 'اقیانوس', base: '#10222B', blobs: [[.26, .22, .84, '#1F4E63'], [.84, .56, .64, '#17394A'], [.50, .97, .72, '#0A161C']] },
    { id: 'slate', fa: 'خاکستری', base: '#1C2024', blobs: [[.20, .28, .82, '#3B444E'], [.86, .24, .58, '#2C333B'], [.50, .98, .70, '#111417']] },
    { id: 'sunset', fa: 'غروب', base: '#2B1720', blobs: [[.72, .20, .82, '#7B3446'], [.16, .44, .64, '#4C2130'], [.50, .98, .72, '#1A0E14']] },
    { id: 'forest', fa: 'جنگل', base: '#15231A', blobs: [[.24, .20, .84, '#2C4E36'], [.82, .62, .62, '#203A28'], [.50, .98, .70, '#0C150F']] },
  ];
  function preset(id) { for (var i = 0; i < PRESETS.length; i++) if (PRESETS[i].id === id) return PRESETS[i]; return null; }

  // ── «کوهستان» ─────────────────────────────────────────────────────────────
  function rng(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  var HOR = 0.70;
  function ridge(seed, n, base, amp, rough, peaks) {
    var r = rng(seed), p = new Array(n + 1).fill(0);
    p[0] = (r() - .5) * amp; p[n] = (r() - .5) * amp;
    for (var step = n, a = amp; step > 1; step /= 2, a *= rough) {
      var h = step / 2;
      for (var i = h; i < n; i += step) p[i] = (p[i - h] + p[i + h]) / 2 + (r() - .5) * a;
    }
    return p.map(function (v, i) {
      var x = i / n, y = base + v;
      (peaks || []).forEach(function (pk) { y -= pk[2] * Math.exp(-Math.pow((x - pk[0]) / pk[1], 2)); });
      return Math.max(0.14, Math.min(HOR - 0.004, y));
    });
  }
  var RIDGES = [
    ridge(7, 64, .45, .20, .56, [[.28, .07, .11], [.72, .09, .09]]),
    ridge(21, 64, .54, .15, .55, [[.52, .10, .07]]),
    ridge(5, 64, .62, .10, .52, [[.12, .12, .05], [.88, .10, .05]]),
    ridge(3, 64, .68, .045, .5, []),
  ];
  var PAL = {
    dark: { sky: [[0, '#1b2150'], [.35, '#3d3470'], [.66, '#b0607a'], [.88, '#f08c6a'], [1, '#f7b27a']], glow: 'rgba(255,170,120,.42)', cloud: 'rgba(255,150,170,.22)',
      r: [['#6e5d92', '#3c3666'], ['#4c4170', '#2a2748'], ['#302b4d', '#1d1c33'], ['#1b1b2d', '#131324']], snow: 'rgba(255,215,230,.55)',
      water: ['rgba(40,36,84,.30)', 'rgba(10,10,26,.88)'], shimmer: '#ffc2a0', shore: 'rgba(10,10,22,.6)' },
    light: { sky: [[0, '#5b8ed0'], [.45, '#9cc0e6'], [.78, '#f1d2c6'], [1, '#f8e4d6']], glow: 'rgba(255,238,214,.55)', cloud: 'rgba(255,255,255,.5)',
      r: [['#a3b3d8', '#7688b6'], ['#7282b0', '#515f8c'], ['#4f5c84', '#364264'], ['#303b54', '#232c40']], snow: 'rgba(255,255,255,.85)',
      water: ['rgba(120,150,205,.30)', 'rgba(36,56,98,.84)'], shimmer: '#ffffff', shore: 'rgba(20,30,50,.5)' },
  };

  function drawRidge(g, pts, W, H, hor, top, bot) {
    var n = pts.length - 1, minY = Infinity;
    pts.forEach(function (v) { minY = Math.min(minY, v * H); });
    var gr = g.createLinearGradient(0, minY, 0, hor);
    gr.addColorStop(0, top); gr.addColorStop(1, bot);
    g.beginPath(); g.moveTo(0, hor);
    for (var i = 0; i <= n; i++) g.lineTo(i / n * W, pts[i] * H);
    g.lineTo(W, hor); g.closePath(); g.fillStyle = gr; g.fill();
    return minY;
  }

  function scene(g, W, H, P, hor) {
    var s = g.createLinearGradient(0, 0, 0, hor);
    P.sky.forEach(function (c) { s.addColorStop(c[0], c[1]); });
    g.fillStyle = s; g.fillRect(0, 0, W, hor + 2);
    var gl = g.createRadialGradient(W * .38, hor * .92, 0, W * .38, hor * .92, W * .5);
    gl.addColorStop(0, P.glow); gl.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gl; g.fillRect(0, 0, W, hor);
    var r = rng(11);
    g.save(); g.filter = 'blur(' + Math.max(1, Math.round(W / 90)) + 'px)'; g.fillStyle = P.cloud;
    for (var i = 0; i < 9; i++) { g.beginPath(); g.ellipse(r() * W, H * (.07 + r() * .26), W * (.07 + r() * .14), H * (.012 + r() * .02), 0, 0, Math.PI * 2); g.fill(); }
    g.restore();
    RIDGES.forEach(function (pts, k) {
      var minY = drawRidge(g, pts, W, H, hor, P.r[k][0], P.r[k][1]);
      if (k === 0) {
        g.save(); g.beginPath(); g.rect(0, 0, W, minY + H * .045); g.clip();
        g.beginPath();
        for (var j = 0; j < pts.length; j++) { var x = j / (pts.length - 1) * W; if (j) g.lineTo(x, pts[j] * H); else g.moveTo(x, pts[j] * H); }
        g.strokeStyle = P.snow; g.lineWidth = Math.max(1, W / 650); g.lineJoin = 'round'; g.stroke(); g.restore();
      }
    });
  }

  function drawMountain(g, W, H, dark) {
    var P = PAL[dark ? 'dark' : 'light'], hor = H * HOR;
    scene(g, W, H, P, hor);
    g.save(); g.beginPath(); g.rect(0, hor, W, H - hor); g.clip();
    g.translate(0, 2 * hor); g.scale(1, -1); g.globalAlpha = .55; g.filter = 'blur(' + Math.max(1, Math.round(W / 480)) + 'px)';
    scene(g, W, H, P, hor);
    g.restore();
    var wg = g.createLinearGradient(0, hor, 0, H);
    wg.addColorStop(0, P.water[0]); wg.addColorStop(1, P.water[1]);
    g.fillStyle = wg; g.fillRect(0, hor, W, H - hor);
    var r2 = rng(99); g.fillStyle = P.shimmer;
    for (var i = 0; i < 90; i++) {
      var y = hor + 4 + Math.pow(r2(), 1.6) * (H - hor - 8);
      var w = W * (.015 + r2() * .09) * (1 - (y - hor) / (H - hor) * .5);
      g.globalAlpha = .06 + r2() * .2;
      g.fillRect(r2() * W, y, w, Math.max(1, H / 900));
    }
    g.globalAlpha = 1; g.fillStyle = P.shore; g.fillRect(0, hor - 1, W, 2);
  }

  function drawPreset(g, W, H, p) {
    var R = Math.max(W, H);
    g.fillStyle = p.base; g.fillRect(0, 0, W, H);
    p.blobs.forEach(function (b) {
      var gr = g.createRadialGradient(b[0] * W, b[1] * H, 0, b[0] * W, b[1] * H, b[2] * R);
      gr.addColorStop(0, b[3]); gr.addColorStop(1, b[3] + '00');
      g.fillStyle = gr; g.fillRect(0, 0, W, H);
    });
  }

  function drawPhoto(g, W, H, img) {
    var s = Math.max(W / img.width, H / img.height);
    var w = img.width * s, h = img.height * s;
    g.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  }

  function paint(g, W, H, id) {
    var dark = MV.appearance.effective !== 'light';
    if (id === 'custom' && photo) drawPhoto(g, W, H, photo);
    else if (preset(id) && preset(id).base) drawPreset(g, W, H, preset(id));
    else drawMountain(g, W, H, dark);
  }

  function draw() {
    if (!canvas) return;
    var W = Math.max(1, canvas.clientWidth), H = Math.max(1, canvas.clientHeight);
    canvas.width = W; canvas.height = H;
    var g = canvas.getContext('2d');
    if (!g) return;
    paint(g, W, H, cfg.id);
    if (cfg.blur > 0) {
      // Blur the finished picture, drawn a touch larger so the soft edge stays off-screen.
      var tmp = document.createElement('canvas');
      tmp.width = W; tmp.height = H;
      tmp.getContext('2d').drawImage(canvas, 0, 0);
      var px = Math.round(cfg.blur / 100 * 28), k = 1 + px / Math.min(W, H) * 3;
      g.clearRect(0, 0, W, H);
      g.save();
      g.filter = 'blur(' + px + 'px)';
      g.drawImage(tmp, (W - W * k) / 2, (H - H * k) / 2, W * k, H * k);
      g.restore();
    }
    measureTint();
    heroFollowWallpaper();
  }

  // Settings › صفحه نمایش › «تصویر زمینه در همه صفحات»: the picture's average colour, for the
  // faint cast windows take on (shell.css). Sampled from an 8×8 copy — the mean, not a pick.
  function measureTint() {
    try {
      var s = document.createElement('canvas');
      s.width = 8; s.height = 8;
      var sg = s.getContext('2d');
      sg.drawImage(canvas, 0, 0, 8, 8);
      var d = sg.getImageData(0, 0, 8, 8).data, r = 0, gr = 0, b = 0, n = d.length / 4;
      for (var i = 0; i < d.length; i += 4) { r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
      var hex = '#' + [r, gr, b].map(function (v) { return ('0' + Math.round(v / n).toString(16)).slice(-2); }).join('');
      if (MV.displayPrefs) MV.displayPrefs.setTint(hex);
    } catch (e) { /* a tainted or empty canvas: windows keep the last tint */ }
  }

  // ── The photo, in IndexedDB ──────────────────────────────────────────────
  function db() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open('mlmvpn-shell', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('files'); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idb(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction('files', mode), st = tx.objectStore('files'), req = fn(st);
        tx.oncomplete = function () { resolve(req && req.result); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function loadPhoto() {
    return idb('readonly', function (st) { return st.get('wallpaper-photo'); }).then(function (blob) {
      if (!blob) return null;
      if (photoUrl) URL.revokeObjectURL(photoUrl);
      photoUrl = URL.createObjectURL(blob);
      return createImageBitmap(blob).then(function (bmp) { photo = bmp; return bmp; });
    }).catch(function () { return null; });
  }

  function setPhoto(file) {
    if (!file || !/^image\//.test(file.type)) { window.toast('❌ این فایل تصویر نیست.'); return Promise.resolve(); }
    return createImageBitmap(file).then(function (bmp) {
      var s = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
      var c = document.createElement('canvas');
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (resolve) { c.toBlob(resolve, 'image/jpeg', .86); });
    }).then(function (blob) {
      return idb('readwrite', function (st) { return st.put(blob, 'wallpaper-photo'); });
    }).then(loadPhoto).then(function () {
      cfg.id = 'custom';
      save(); draw(); syncPickers();
      window.toast('✅ عکس به‌عنوان تصویر زمینه گذاشته شد');
    }).catch(function (e) {
      console.error('[wallpaper] photo failed:', e);
      window.toast('❌ این عکس خوانده نشد. یک فایل JPG یا PNG دیگر امتحان کنید.');
    });
  }

  function set(id) {
    if (id === 'custom' && !photo) return;
    cfg.id = id;
    save(); draw(); syncPickers();
  }
  function setBlur(v) {
    cfg.blur = Math.max(0, Math.min(100, Math.round(v)));
    save(); draw(); syncPickers();
  }

  // ── The picture behind a connect button ─────────────────────────
  //
  // An engine page is one wide card with one big power button on it, tinted in that engine's
  // colour. This lets that card carry a picture instead — the desktop's own wallpaper, or one
  // chosen for it — with the darkness and the frost the reader picks. Both sliders are the
  // reader's because only they can see the picture they chose: white text over a bright photograph
  // is unreadable, and there is no setting that is right for every picture.
  //
  // The picture goes to IndexedDB beside the wallpaper's own. NEVER to the settings file: that
  // file is injected into every page load.
  var hero = readHero();
  var heroPhotoUrl = null;      // the reader's own picture, as an object URL
  var heroWallUrl = null;       // the wallpaper, redrawn wide and short (cleared when it changes)

  function clampNum(v, lo, hi, dflt) {
    v = Math.round(Number(v));
    return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt;
  }
  function readHero() {
    try {
      var raw = window.PersistentStorage && PersistentStorage.getItem('mv-hero');
      var v = raw ? JSON.parse(raw) : null;
      if (v && typeof v.mode === 'string') {
        return { mode: v.mode, dim: clampNum(v.dim, 0, 90, 38), blur: clampNum(v.blur, 0, 100, 0) };
      }
    } catch (e) { /* default */ }
    return { mode: 'gradient', dim: 38, blur: 0 };
  }
  function saveHero() { MV.store('mv-hero', JSON.stringify(hero)); }

  /** The wallpaper, painted again at the hero's own shape — wide and short, not the screen's. */
  function heroWall() {
    try {
      var c = document.createElement('canvas');
      c.width = 1280; c.height = 360;
      var g = c.getContext('2d');
      if (!g) return null;
      paint(g, c.width, c.height, cfg.id);
      return c.toDataURL('image/jpeg', .84);
    } catch (e) { return null; }   // before the shell has booted, or a tainted canvas
  }

  function heroImage() {
    if (hero.mode === 'photo') return heroPhotoUrl;
    if (hero.mode === 'wall') { if (!heroWallUrl) heroWallUrl = heroWall(); return heroWallUrl; }
    return null;
  }

  /** Publish the choice as CSS variables; page-kit.css does the rest. */
  function applyHero() {
    var root = document.documentElement, url = heroImage();
    root.classList.toggle('mv-hero-on', !!url);
    root.style.setProperty('--mv-hero-image', url ? 'url("' + url + '")' : 'none');
    root.style.setProperty('--mv-hero-dim', (hero.dim / 100).toFixed(2));
    root.style.setProperty('--mv-hero-blur', (hero.blur / 100 * 18).toFixed(1) + 'px');
  }

  function loadHeroPhoto() {
    return idb('readonly', function (st) { return st.get('hero-photo'); }).then(function (blob) {
      if (!blob) return null;
      if (heroPhotoUrl) URL.revokeObjectURL(heroPhotoUrl);
      heroPhotoUrl = URL.createObjectURL(blob);
      return heroPhotoUrl;
    }).catch(function () { return null; });
  }

  function setHeroPhoto(file) {
    if (!file || !/^image\//.test(file.type)) { window.toast('❌ این فایل تصویر نیست.'); return Promise.resolve(false); }
    return createImageBitmap(file).then(function (bmp) {
      // 2400px wide is wider than the card is on any window this app opens; the height follows the
      // picture rather than being cropped here, because the framing is the reader's to choose.
      var s = Math.min(1, 2400 / bmp.width);
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(bmp.width * s));
      c.height = Math.max(1, Math.round(bmp.height * s));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      return new Promise(function (resolve) { c.toBlob(resolve, 'image/jpeg', .86); });
    }).then(function (blob) {
      return idb('readwrite', function (st) { return st.put(blob, 'hero-photo'); });
    }).then(loadHeroPhoto).then(function () {
      hero.mode = 'photo';
      saveHero(); applyHero();
      window.toast('✅ عکس روی سربرگ اتصال نشست');
      return true;
    }).catch(function (e) {
      console.error('[hero] photo failed:', e);
      window.toast('❌ این عکس خوانده نشد. یک فایل JPG یا PNG دیگر امتحان کنید.');
      return false;
    });
  }

  MV.hero = {
    get: function () { return { mode: hero.mode, dim: hero.dim, blur: hero.blur, hasPhoto: !!heroPhotoUrl }; },
    image: heroImage,
    apply: applyHero,
    setMode: function (m) {
      if (m === 'photo' && !heroPhotoUrl) return false;
      hero.mode = (m === 'wall' || m === 'photo') ? m : 'gradient';
      saveHero(); applyHero();
      return true;
    },
    /** dim and blur are percentages; the darkness stops at 90% because 100% is just a black card. */
    setNumber: function (k, v) {
      if (k !== 'dim' && k !== 'blur') return;
      hero[k] = clampNum(v, 0, k === 'dim' ? 90 : 100, hero[k]);
      saveHero(); applyHero();
    },
    setPhoto: setHeroPhoto,
    name: function () {
      return hero.mode === 'photo' ? 'عکس دلخواه'
        : hero.mode === 'wall' ? 'تصویر زمینهٔ میزکار'
          : 'گرادیان رنگ موتور';
    },
  };

  // The wallpaper's own picture is the hero's in «تصویر زمینهٔ میزکار» mode, so a change there
  // has to reach it. Drawing is cheap and only happens when the wallpaper actually changes.
  function heroFollowWallpaper() {
    heroWallUrl = null;
    if (hero.mode === 'wall') applyHero();
  }

  // ── Picker (Settings › ظاهر) ─────────────────────────────────────────────
  function thumb(id) {
    var c = document.createElement('canvas');
    c.width = 176; c.height = 112;
    var g = c.getContext('2d');
    if (g) paint(g, 176, 112, id);
    return c.toDataURL('image/jpeg', .8);
  }

  function mountPicker(host) {
    var wrap = document.createElement('div');
    wrap.className = 'mv-wp-picker';
    wrap.innerHTML =
      '<div class="mv-group-title">تصویر زمینه</div>' +
      '<div class="mv-group"><div class="mv-wp-grid"></div>' +
      '<div class="mv-row"><div class="mv-row-text">محوی<small>تصویر زمینه را نرم می‌کند؛ روی عکس‌های شلوغ، آیکون‌ها خواناتر می‌شوند.</small></div>' +
      '<input type="range" min="0" max="100" step="5" class="mv-wp-blur" aria-label="محوی تصویر زمینه"><span class="mv-row-end mv-wp-blur-val"></span></div></div>' +
      '<input type="file" accept="image/*" hidden class="mv-wp-file">';
    var grid = wrap.querySelector('.mv-wp-grid');
    PRESETS.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'mv-wp'; b.dataset.wp = p.id; b.title = p.fa;
      b.innerHTML = '<span class="mv-wp-img"></span><span class="mv-wp-name"></span>';
      b.querySelector('.mv-wp-name').textContent = p.fa;
      grid.appendChild(b);
    });
    var custom = document.createElement('button');
    custom.type = 'button'; custom.className = 'mv-wp is-custom'; custom.dataset.wp = 'custom';
    custom.innerHTML = '<span class="mv-wp-img"><i class="ph-bold ph-image"></i></span><span class="mv-wp-name">عکس دلخواه…</span>';
    grid.appendChild(custom);

    var file = wrap.querySelector('.mv-wp-file');
    grid.addEventListener('click', function (e) {
      var b = e.target.closest('.mv-wp');
      if (!b) return;
      if (b.dataset.wp === 'custom') {
        // With a photo already stored, a click selects it; choosing another is one more click away.
        if (photo && cfg.id !== 'custom') set('custom'); else file.click();
        return;
      }
      set(b.dataset.wp);
    });
    file.addEventListener('change', function () { if (file.files && file.files[0]) setPhoto(file.files[0]); file.value = ''; });
    var range = wrap.querySelector('.mv-wp-blur');
    range.addEventListener('input', function () { wrap.querySelector('.mv-wp-blur-val').textContent = range.value + '٪'; });
    range.addEventListener('change', function () { setBlur(+range.value); });

    host.appendChild(wrap);
    pickers.push(wrap);
    syncPickers(true);
    return wrap;
  }

  function syncPickers(withThumbs) {
    pickers.forEach(function (wrap) {
      wrap.querySelectorAll('.mv-wp').forEach(function (b) {
        var id = b.dataset.wp;
        b.setAttribute('aria-pressed', String(id === cfg.id));
        var img = b.querySelector('.mv-wp-img');
        if (id === 'custom') {
          if (photoUrl) { img.style.backgroundImage = 'url("' + photoUrl + '")'; img.innerHTML = ''; }
          b.querySelector('.mv-wp-name').textContent = photo ? 'عکس دلخواه' : 'عکس دلخواه…';
        } else if (withThumbs || id === 'mountain') {
          img.style.backgroundImage = 'url("' + thumb(id) + '")';
        }
      });
      var range = wrap.querySelector('.mv-wp-blur');
      range.value = String(cfg.blur);
      wrap.querySelector('.mv-wp-blur-val').textContent = cfg.blur + '٪';
    });
  }

  function init(el) {
    canvas = el;
    loadHeroPhoto().then(applyHero);
    draw();
    if (cfg.id === 'custom') loadPhoto().then(function () { draw(); syncPickers(); });
    else loadPhoto().then(function () { syncPickers(); });
    var t = null;
    window.addEventListener('resize', function () { clearTimeout(t); t = setTimeout(draw, 250); });
    var lastAp = MV.appearance.effective;
    MV.onChange(function () {
      if (MV.appearance.effective === lastAp) return;
      lastAp = MV.appearance.effective;
      draw(); syncPickers(true);
    });
  }

  // The hero is published before anything asks for it, so a window opened straight after boot is
  // already wearing the right background. Drawing it needs the appearance, which may not be read
  // yet at this point — hence the second pass once the document is up.
  applyHero();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { heroWallUrl = null; loadHeroPhoto().then(applyHero); });
  } else {
    loadHeroPhoto().then(applyHero);
  }

  MV.wallpaper = {
    init: init, set: set, setBlur: setBlur, setPhoto: setPhoto, mountPicker: mountPicker, redraw: draw,
    current: function () { return Object.assign({}, cfg); },
    // The chosen picture's name, for Settings › صفحه نمایش › «تصویر زمینه».
    name: function () {
      if (cfg.id === 'custom') return 'عکس شخصی';
      var p = preset(cfg.id);
      return (p && p.fa) || 'پیش‌فرض';
    },
  };
})();
