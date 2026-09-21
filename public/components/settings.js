// --- Settings Module ---
const settingsHtmlTemplate = `
<!-- SETTINGS MODAL (Google Dark Style)                      -->
    <!-- ======================================================= -->
    <div
      id="settings-modal"
      class="fixed inset-0 z-50 hidden flex items-center justify-center p-4"
      style="
        font-family:
          &quot;Vazirmatn&quot;,
          -apple-system,
          Roboto,
          sans-serif;
      "
    >
      <!-- Backdrop -->
      <div
        class="absolute inset-0 bg-mv-scrim backdrop-blur-sm transition-opacity"
        onclick="hideSettingsModal()"
      ></div>

      <!-- Modal Content -->
      <div
        class="w-full max-w-[600px] bg-gs-panel rounded-[24px] overflow-hidden flex flex-col max-h-[90vh] relative z-10 shadow-2xl border border-gs-border animate-modal text-gs-muted text-right"
        dir="rtl"
      >
        <!-- Header -->
        <div
          class="flex items-center justify-between px-6 py-4 border-b border-gs-border bg-gs-panel shrink-0"
        >
          <div class="flex items-center gap-3">
            <svg
              class="w-5 h-5 text-gs-muted"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              stroke-width="2"
            >
              <path
                d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
              />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <h2 class="text-base font-medium text-gs-muted">
              پیکربندی و ساخت کانفیگ
            </h2>
          </div>
          <button
            class="p-2 text-gs-muted hover:text-gs-muted hover:bg-gs-panel rounded-full transition-colors"
            onclick="hideSettingsModal()"
          >
            <svg
              class="w-5 h-5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <!-- Body -->
        <div
          class="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-gs-panel"
        >
          <!-- Protocols -->
          <div>
            <h3
              class="text-xs font-medium text-gs-muted mb-3 flex items-center gap-2"
            >
              پروتکلهای خروجی
            </h3>
            <div class="flex gap-4">
              <label
                class="flex items-center gap-3 cursor-pointer group bg-gs-panel px-4 py-2.5 rounded-xl border border-gs-border hover:bg-gs-panel transition-colors flex-1"
              >
                <input
                  type="checkbox"
                  id="cloud-proto-vless"
                  class="md-checkbox"
                  checked
                />
                <span class="text-sm text-gs-muted">VLESS</span>
              </label>
              <label
                class="flex items-center gap-3 cursor-pointer group bg-gs-panel px-4 py-2.5 rounded-xl border border-gs-border hover:bg-gs-panel transition-colors flex-1"
              >
                <input
                  type="checkbox"
                  id="cloud-proto-trojan"
                  class="md-checkbox"
                />
                <span class="text-sm text-gs-muted">Trojan</span>
              </label>
            </div>
          </div>

          <!-- Ports -->
          <div>
            <h3 class="text-xs font-medium text-gs-muted mb-3">
              پورتهای ارتباطی
            </h3>
            <div
              class="bg-gs-panel border border-gs-border rounded-xl p-4 space-y-4"
            >
                            <div>
                <span class="text-[11px] text-gs-muted block mb-2 font-mono"
                  >TLS Ports</span
                >
                <div class="flex flex-wrap gap-2 font-mono">
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-tls-port-new" value="443" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">443</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-tls-port-new" value="8443" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">8443</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-tls-port-new" value="2053" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">2053</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-tls-port-new" value="2083" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">2083</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-tls-port-new" value="2087" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">2087</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-tls-port-new" value="2096" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">2096</span>
                  </label>
                </div>
              </div>
              <div>
                <span class="text-[11px] text-gs-muted block mb-2 font-mono"
                  >Non-TLS Ports</span
                >
                <div class="flex flex-wrap gap-2 font-mono">
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-nontls-port-new" value="80" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">80</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-nontls-port-new" value="8080" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">8080</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-nontls-port-new" value="8880" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">8880</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-nontls-port-new" value="2052" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">2052</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-nontls-port-new" value="2082" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">2082</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-nontls-port-new" value="2086" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">2086</span>
                  </label>
                  <label class="flex items-center gap-2 cursor-pointer bg-gs-panel px-3 py-1.5 rounded-lg border border-gs-border hover:bg-gs-panel transition-colors">
                    <input type="checkbox" name="cloud-nontls-port-new" value="2095" class="md-checkbox">
                    <span class="text-xs text-gs-muted font-medium">2095</span>
                  </label>
                </div>
              </div>
            </div>
          </div>

          <!-- Proxy Mode Add -->
          <div class="bg-gs-panel border border-gs-border rounded-xl p-4 space-y-4">
            <div>
              <span class="text-sm text-gs-muted block mb-3">Proxy IP Mode</span>
              <div class="flex gap-4">
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="cloud-proxy-mode" value="proxyip" checked class="accent-google-blue w-4 h-4" onchange="document.getElementById('proxyip-container').classList.remove('hidden'); document.getElementById('nat64-container').classList.add('hidden');">
                  <span class="text-sm text-gs-muted">Proxy IP</span>
                </label>
                <label class="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="cloud-proxy-mode" value="prefix" class="accent-google-blue w-4 h-4" onchange="document.getElementById('proxyip-container').classList.add('hidden'); document.getElementById('nat64-container').classList.remove('hidden');">
                  <span class="text-sm text-gs-muted">NAT64 Prefix</span>
                </label>
              </div>
            </div>

            <div id="proxyip-container">
              <span class="text-[11px] text-gs-muted block mb-2 font-mono">Proxy IPs / Domains</span>
              <select id="cloud-proxyip-new" class="w-full bg-gs-panel border border-gs-border rounded-xl px-4 py-2 text-sm text-gs-muted focus:outline-none focus:border-gs-border focus:bg-gs-panel transition-all">
                <option value="">None (Empty)</option>
                <option value="bpb.yousef.isegaro.com">bpb.yousef.isegaro.com</option>
                <option value="213.108.198.116">🇩🇪 213.108.198.116 (NKtelecom)</option>
                <option value="62.60.245.255">🇳🇱 62.60.245.255 (NetCrafters)</option>
                <option value="88.198.82.155">🇩🇪 88.198.82.155 (Hetzner)</option>
                <option value="51.38.98.202">🇩🇪 51.38.98.202 (OVH)</option>
              </select>
            </div>

            <div id="nat64-container" class="hidden">
              <span class="text-[11px] text-gs-muted block mb-2 font-mono">NAT64 Prefixes</span>
              <select id="cloud-nat64-new" class="w-full bg-gs-panel border border-gs-border rounded-xl px-4 py-2 text-sm text-gs-muted focus:outline-none focus:border-gs-border focus:bg-gs-panel transition-all">
                <option value="">None (Empty)</option>
                <option value="[2a02:898:146:64::]">[2a02:898:146:64::] (Netherland)</option>
                <option value="[2602:fc59:b0:64::]">[2602:fc59:b0:64::] (USA)</option>
                <option value="[2602:fc59:11:64::]">[2602:fc59:11:64::] (USA)</option>
              </select>
            </div>
          </div>

                                    
            <!-- Advanced Cloud Settings Container -->
            <div id="cloud-advanced-settings-container" class="space-y-6 mt-6 border-t border-gs-border pt-6">
              <!-- LAN & IPv6 -->
              <div class="flex flex-wrap gap-4">
                <label class="flex items-center gap-3 cursor-pointer group bg-gs-panel px-4 py-2.5 rounded-xl border border-gs-border hover:bg-gs-panel transition-colors flex-1">
                  <input type="checkbox" id="cloud-allow-lan" class="md-checkbox" />
                  <span class="text-sm text-gs-muted">Allow LAN Connection</span>
                </label>
                <label class="flex items-center gap-3 cursor-pointer group bg-gs-panel px-4 py-2.5 rounded-xl border border-gs-border hover:bg-gs-panel transition-colors flex-1">
                  <input type="checkbox" id="cloud-ipv6-new" class="md-checkbox" />
                  <span class="text-sm text-gs-muted">Enable IPv6</span>
                </label>
              </div>

              <!-- Fragment Toggle -->
              <div>
                <h3 class="text-xs font-medium text-gs-muted mb-3">تنظیمات فرگمنت</h3>
                <div class="bg-gs-panel border border-gs-border rounded-xl p-4 space-y-4">
                  <label class="flex items-center gap-3 cursor-pointer group">
                    <input type="checkbox" id="cloud-frag-toggle" class="md-checkbox" onchange="document.getElementById('frag-settings-container').classList.toggle('hidden', !this.checked)" />
                    <span class="text-sm text-gs-muted">فعال‌سازی Fragment</span>
                  </label>
                  <div id="frag-settings-container" class="hidden grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div>
                      <span class="text-[11px] text-gs-muted block mb-1">طول (Length)</span>
                      <input type="text" id="cloud-frag-len" value="100-200" class="w-full bg-gs-panel border border-gs-border rounded-lg px-3 py-2 text-sm text-gs-muted focus:outline-none focus:border-gs-border transition-all" />
                    </div>
                    <div>
                      <span class="text-[11px] text-gs-muted block mb-1">فاصله زمانی (Interval)</span>
                      <input type="text" id="cloud-frag-int" value="10-20" class="w-full bg-gs-panel border border-gs-border rounded-lg px-3 py-2 text-sm text-gs-muted focus:outline-none focus:border-gs-border transition-all" />
                    </div>
                    <div>
                      <span class="text-[11px] text-gs-muted block mb-1">پیکج (Packets)</span>
                      <select id="cloud-frag-pak" class="w-full bg-gs-panel border border-gs-border rounded-lg px-3 py-2 text-sm text-gs-muted focus:outline-none focus:border-gs-border transition-all">
                        <option value="tlshello">tlshello</option>
                        <option value="1-3">1-3</option>
                        <option value="1">1</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Buttons -->
              <div class="flex items-center gap-3 mt-4">
                <button onclick="fetchCloudNodes(this)" class="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-bold text-[#202124] shadow-md transition-colors hover:bg-mv-fill-2 active:scale-[0.98]" style="background-color: var(--mv-accent);">
                  <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>
                  </svg>
                  ثبت و دریافت نود
                </button>
              </div>
            </div>

            
        </div> <!-- End flex-1 -->
      </div> <!-- End w-full -->
    </div> <!-- End settings-modal -->
`;

function initSettingsModule() {
  const container = document.getElementById('settings-module-container');
  if (container) {
    container.innerHTML = settingsHtmlTemplate;
    console.log('Settings module HTML injected.');
  }

  // Initialize logic after injection
  if (typeof loadSettings === 'function') {
    loadSettings();
  }
}

// Logic extracted from app.js
// ===== Settings Panel =====
// Appearance used to live here as eight themes written onto <html> as inline variables.
// There are two appearances now (dark / light) and they belong to the design system:
// ui/appearance-boot.js decides before the first paint, ui/mv.js owns the switch and
// keeps applyTheme() alive for any old caller.

function toggleSettings() {
  let sTab = tabs.find(t => t.id === 'settings');
  if (!sTab) {
    sTab = { id: 'settings', isp: 'تنظیمات', state: 'done' };
    tabs.push(sTab);
  }
  switchTab('settings');
}

// Pane history for the ‹ › capsule in the pane's toolbar (page kit › .mv-pane-nav).
const settingsNav = { back: [], fwd: [], cur: null };

function syncSettingsNav() {
  const back = document.getElementById('mv-set-back');
  const fwd = document.getElementById('mv-set-fwd');
  if (back) back.disabled = !settingsNav.back.length;
  if (fwd) fwd.disabled = !settingsNav.fwd.length;
}

function settingsGo(dir) {
  const from = dir < 0 ? settingsNav.back : settingsNav.fwd;
  const to = dir < 0 ? settingsNav.fwd : settingsNav.back;
  if (!from.length) return;
  if (settingsNav.cur) to.push(settingsNav.cur);
  switchSettingsTab(from.pop(), true);
}

function switchSettingsTab(tabId, fromHistory) {
  if (!fromHistory && settingsNav.cur && settingsNav.cur !== tabId) {
    settingsNav.back.push(settingsNav.cur);
    settingsNav.fwd.length = 0;
  }
  const changed = settingsNav.cur !== tabId;
  settingsNav.cur = tabId;
  syncSettingsNav();

  // Hide all panels
  document.querySelectorAll('.settings-panel-content').forEach(el => el.style.display = 'none');

  // Reset all buttons
  document.querySelectorAll('.settings-nav-btn').forEach(btn => {
    btn.classList.remove('active', 'bg-gs-primary/10', 'border-gs-primary/20', 'text-gs-text');
    btn.classList.add('text-gs-muted', 'border-transparent');
  });

  // Activate selected panel. A page-kit form takes its display from the kit — one column, or
  // two or three on a wide window (page-kit.css › Modules); an inline `flex` would pin it to one.
  const panel = document.getElementById('panel-set-' + tabId);
  if (panel) panel.style.display = panel.classList.contains('mv-form') ? '' : 'flex';
  // A different pane opens at its top, with the toolbar's scroll edge cleared.
  const scroller = panel && panel.closest('.mv-pane-scroll');
  if (scroller && changed) {
    scroller.scrollTop = 0;
    const pane = scroller.closest('.mv-pane');
    if (pane) pane.classList.remove('is-scrolled');
  }

  // Activate selected button
  const btn = document.getElementById('btn-set-' + tabId);
  if (btn) {
    btn.classList.remove('text-gs-muted', 'border-transparent');
    btn.classList.add('active', 'bg-gs-primary/10', 'border-gs-primary/20', 'text-gs-text');
    // The pane's title band (page kit) names the selected section.
    const title = document.getElementById('mv-set-title');
    if (title) title.textContent = btn.textContent.trim();
  }
}



function saveGlobalSettings() {
  const speedUrlEl = document.getElementById('setting-speed-url');
  const pingUrlEl = document.getElementById('setting-ping-url');
  const udpUrlEl = document.getElementById('setting-udp-url');

  if (speedUrlEl) PersistentStorage.setItem('setting-speed-url', speedUrlEl.value);
  if (pingUrlEl) PersistentStorage.setItem('setting-ping-url', pingUrlEl.value);
  if (udpUrlEl) PersistentStorage.setItem('setting-udp-url', udpUrlEl.value);

  if (typeof toast === 'function') {
    toast('تنظیمات با موفقیت ذخیره شد');
  }
}

// Load settings
setTimeout(() => {
  const speedUrl = PersistentStorage.getItem('setting-speed-url');
  const pingUrl = PersistentStorage.getItem('setting-ping-url');
  const udpUrl = PersistentStorage.getItem('setting-udp-url');

  if (speedUrl) {
    const el = document.getElementById('setting-speed-url');
    if (el) el.value = speedUrl;
  }
  if (pingUrl) {
    const el = document.getElementById('setting-ping-url');
    if (el) el.value = pingUrl;
  }
  if (udpUrl) {
    const el = document.getElementById('setting-udp-url');
    if (el) el.value = udpUrl;
  }
}, 500);

// ── Settings that survive a restart ─────────────────────────────────────────
// Each control keeps its id (the code that obeys it reads the control directly); its value
// is saved in PersistentStorage under that same id the moment it changes, and put back at
// start. Before this, every one of these went back to its default on each launch.
const SETTINGS_SAVED = [
  'autosave-interval-input',       // history.js › auto-save interval (minutes)
  'net-check-toggle',              // app.js › startScan › pauseOnNetworkDown
  'setting-disable-total-traffic', // header-traffic.js, shell/widgets.js
  'setting-disable-core-log',      // scanner-sidebar.js
  'setting-disable-monitoring',    // server: /api/traffic/monitoring
  'setting-disable-live-speed',    // live-speed.js, shell/widgets.js
  'setting-concurrent-tests',      // v2ray.js › group test
  'setting-speed-timeout',         // speed-test.js
];

// What a change does beyond being saved. `atStart` is true for the value put back at launch.
function settingApplied(id, el, atStart) {
  if (id === 'autosave-interval-input') {
    const v = Math.min(120, Math.max(1, parseInt(el.value, 10) || 1));
    if (String(v) !== el.value) el.value = String(v);
  }
  if (id === 'setting-disable-monitoring') {
    // The server starts every run with monitoring on, so only a real change — or «off»
    // at launch — needs telling.
    if (!atStart || el.checked) {
      fetch('/api/traffic/monitoring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !el.checked })
      }).catch(() => {});
    }
    // Nothing will arrive to overwrite the last figures, so say so instead of freezing them.
    if (el.checked) {
      ['speed-up', 'speed-down', 'traffic-up', 'traffic-down'].forEach(k => {
        const t = document.getElementById(k);
        if (t) t.textContent = '-';
      });
    }
  }
  if (/^setting-disable-(monitoring|total-traffic|live-speed)$/.test(id)) {
    document.dispatchEvent(new CustomEvent('mv-traffic-prefs'));
  }
}

function initSavedSettings() {
  SETTINGS_SAVED.forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.dataset.saved) return;
    el.dataset.saved = '1';
    const v = PersistentStorage.getItem(id);
    if (v !== null) {
      if (el.type === 'checkbox') el.checked = v === '1';
      else if (el.tagName !== 'SELECT' || [...el.options].some(o => o.value === v)) el.value = v;
    }
    el.addEventListener('change', () => {
      settingApplied(id, el, false);
      PersistentStorage.setItem(id, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
    });
    settingApplied(id, el, true);
  });
  // «ذخیره‌ی خودکار» itself lives in app.js (window.autoSaveEnabled); this draws its twin.
  if (typeof updateAutoSaveUI === 'function') updateAutoSaveUI();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initSavedSettings);
else initSavedSettings();

window.isSidebarMaximized = false;
function toggleMaximizeSidebar() {
  const sb = $('left-sidebar');
  const editorArea = $('editor-area');

  if (!sb) return;
  window.isSidebarMaximized = !window.isSidebarMaximized;

  if (window.isSidebarMaximized) {
    sb.dataset.origW = sb.style.width;
    sb.dataset.origMaxW = sb.style.maxWidth;

    sb.style.flex = '1';
    sb.style.width = 'auto';
    sb.style.maxWidth = 'none';

    // Hide the center area entirely
    if (editorArea) editorArea.style.display = 'none';
    if ($('ls-resizer')) $('ls-resizer').style.display = 'none';
  } else {
    sb.style.flex = 'none';
    sb.style.width = sb.dataset.origW || '450px';
    sb.style.maxWidth = sb.dataset.origMaxW || '800px';
    if ($('ls-resizer')) $('ls-resizer').style.display = 'block';

    if (editorArea) editorArea.style.display = 'flex';

    // Restore center panels correctly using existing logic
    if (typeof renderActiveTab === 'function') {
      renderActiveTab();
    }
  }
}
