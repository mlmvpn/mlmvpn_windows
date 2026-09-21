// --- «آرشیو آی‌پی» ---
//
// Every IP a scan proved 100% healthy, kept across scans. Built with the page kit
// (ui/page-kit.css) like the rest of the app: a status head with the count, the base config the
// retest needs, one toolbar band, and the list as a real table.
//
// It is still ONE root (#ip-archive-wrapper) that shell/apps.js adopts as a window
// (sheetWindow), because its own open/close do real work — loadArchive() + render, and
// checkAndArchiveHealthyIps() skips auto-archiving while it is open. Every id and every handler
// name is unchanged; only the markup around them is new.
const archiveHtmlTemplate = `
<style id="ar-css">
  /* آرشیو آی‌پی on the page kit. The window (shell/apps.js › sheetWindow) lays this layer flat and
     already draws a title bar with the window's own close button, so the card fills the window and
     its own ✕ hides. In «چیدمان قدیمی» there is no window, so it stays a centred card with its ✕. */
  #ip-archive-modal {
    display: flex; flex-direction: column; min-height: 0;
    width: 100%; max-width: 980px; max-height: 88vh;
    border-radius: 16px; overflow: hidden;
    background: var(--mv-window);
    box-shadow: var(--mv-e4);
  }
  .mv-win-body > .mv-sheetwin #ip-archive-modal {
    max-width: none; max-height: none; height: 100%;
    border-radius: 0; box-shadow: none; background: var(--mv-pane);
  }
  .mv-win-body > .mv-sheetwin .ar-close { display: none; }
  #ip-archive-modal .mv-scroll { flex: 1; min-height: 0; overflow: auto; padding: 16px 22px 26px; }
  #ip-archive-modal .mv-form { max-width: none; }
  #ip-archive-modal [hidden] { display: none !important; }
  #ip-archive-modal .ar-input {
    width: 100%; margin: 0; border-radius: 8px; padding: 9px 11px;
    font-size: 11.5px; direction: ltr; text-align: left;
    font-family: var(--mv-font-mono); color: var(--mv-label);
    background: var(--mv-field); border: var(--mv-hl) solid var(--mv-sep);
  }
  #ip-archive-modal .ar-input:focus { outline: none; border-color: var(--mv-accent); }
  /* The list scrolls inside the page so the toolbar above it never leaves the screen. */
  #ip-archive-modal .ar-list { max-height: 46vh; overflow: auto; }
  .mv-win-body > .mv-sheetwin #ip-archive-modal .ar-list { max-height: none; }
  #ip-archive-modal .ar-list thead th {
    position: sticky; top: 0; z-index: 1;
    background: var(--mv-group); box-shadow: 0 var(--mv-hl) 0 0 var(--mv-sep);
  }
  /* A toolbar button that carries a word as well as its glyph. */
  #ip-archive-modal .ar-wide { width: auto; padding: 0 11px; font-size: 11.5px; font-weight: 600; }
  #ip-archive-modal .ar-chk { width: 44px; text-align: center; }
  #ip-archive-modal .ar-act { width: 40px; text-align: center; }
  #ip-archive-modal .ar-del {
    border: 0; background: transparent; cursor: pointer; padding: 2px 4px; line-height: 1;
    color: var(--mv-label-3); opacity: 0; transition: opacity var(--mv-d-1) var(--mv-ease-out);
  }
  #ip-archive-modal tbody tr:hover .ar-del, #ip-archive-modal .ar-del:focus-visible { opacity: 1; }
  #ip-archive-modal .ar-del:hover { color: var(--mv-red-ink); }
  #ip-archive-modal .ar-bar { height: 3px; border-radius: 2px; overflow: hidden; background: var(--mv-fill); margin: 0 0 10px; }
  #ip-archive-modal .ar-bar > div { height: 100%; width: 0; background: var(--mv-accent); transition: width var(--mv-d-2) var(--mv-ease-out); }
  #ip-archive-modal .ar-ok { color: var(--mv-green-ink); font-weight: 650; }
  #ip-archive-modal .ar-bad { color: var(--mv-red-ink); }
  #ip-archive-modal .ar-dim { color: var(--mv-label-3); }
  #ip-archive-modal .ar-fig { direction: ltr; unicode-bidi: isolate; }
  @keyframes ar-spin { to { transform: rotate(360deg); } }
  #ip-archive-modal .ar-spin { display: inline-flex; align-items: center; justify-content: center; line-height: 1; }
  /* A drawn ring, never a glyph with a ring on top — see the note in components/assistant.js. */
  #ip-archive-modal .ar-spin::before {
    content: '' !important; display: block; box-sizing: border-box; width: .85em; height: .85em;
    border: .14em solid currentColor; border-top-color: transparent; border-radius: 50%;
    animation: ar-spin .8s linear infinite;
  }
  html[data-motion="reduced"] #ip-archive-modal .ar-spin::before { animation: none; }
</style>
    <div
      id="ip-archive-wrapper"
      style="
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 999999;
        align-items: center;
        justify-content: center;
        padding: 1rem;
      "
    >
      <div id="ip-archive-overlay" class="bg-mv-scrim" style="position:absolute;top:0;left:0;right:0;bottom:0;z-index:-1" onclick="closeIpArchive()"></div>

      <div id="ip-archive-modal" dir="rtl">
        <div class="mv-scroll custom-scrollbar">
          <div class="mv-form">

            <div class="mv-form-section is-wide">
              <div class="mv-form-group">
                <div class="mv-status-head">
                  <span class="mv-side-tile" style="--tint:var(--mv-teal)"><i class="ph-fill ph-archive"></i></span>
                  <div class="mv-sh-text">
                    <h2>آی‌پی‌های ۱۰۰٪ سالم</h2>
                    <p id="archive-modal-subtitle"><span id="archive-count-text">0</span> آی‌پی ذخیره شده — با هر اسکن موفق خودکار اضافه می‌شوند</p>
                  </div>
                  <div class="mv-sh-end">
                    <button type="button" class="mv-btn" onclick="clearIpArchive()">پاکسازی کل آرشیو</button>
                    <button type="button" class="mv-tb-btn ar-close" onclick="closeIpArchive()" title="بستن" aria-label="بستن"><i class="ph-bold ph-x"></i></button>
                  </div>
                </div>
              </div>
            </div>

            <div class="mv-form-section is-wide">
              <div class="mv-form-header">کانفیگ پایه برای تست مجدد</div>
              <div class="mv-form-group">
                <div class="mv-form-row is-stack">
                  <input type="text" id="archive-vless-input" class="ar-input" dir="ltr" spellcheck="false"
                         placeholder="vless://...  یا  trojan://..." />
                </div>
              </div>
              <div class="mv-form-footer">«تست مجدد» هر آی‌پی انتخاب‌شده را <b>با همین کانفیگ</b> امتحان می‌کند و تأخیر واقعی‌اش را تازه می‌کند. بدون آن، تستی انجام نمی‌شود.</div>
            </div>

            <div class="mv-form-section is-wide">
              <div class="mv-form-header">فهرست آی‌پی‌های بایگانی‌شده</div>

              <div class="mv-toolbar">
                <div class="mv-tb-group" role="group" aria-label="آی‌پی‌های انتخاب‌شده">
                  <!-- The retest carries its own word, because it is the one that changes state
                       («در حال تست...») and a spinner with no sentence says nothing. -->
                  <button type="button" class="mv-tb-btn ar-wide" onclick="retestArchiveNodes()" title="تست مجدد آی‌پی‌های انتخاب‌شده">
                    <i class="ph-bold ph-lightning" id="archive-test-icon"></i>
                    <i class="ar-spin" id="archive-test-spinner" hidden></i>
                    <span id="archive-test-text">تست مجدد</span>
                  </button>
                  <button type="button" class="mv-tb-btn" onclick="copySelectedArchive()" title="کپی آی‌پی‌های انتخاب‌شده" aria-label="کپی"><i class="ph-bold ph-copy"></i></button>
                  <button type="button" class="mv-tb-btn" onclick="transferArchiveToCombo()" title="انتقال به مرکز ترکیب" aria-label="انتقال به مرکز ترکیب"><i class="ph-bold ph-paper-plane-tilt"></i></button>
                  <button type="button" class="mv-tb-btn" onclick="deleteSelectedArchive()" title="حذف انتخاب‌شده‌ها" aria-label="حذف انتخاب‌شده‌ها"><i class="ph-bold ph-trash"></i></button>
                </div>
              </div>

              <div class="ar-bar" id="archive-progress-container"><div id="archive-progress-bar"></div></div>

              <div class="mv-form-group">
                <div class="mv-table-wrap ar-list custom-scrollbar">
                  <table class="mv-table">
                    <thead>
                      <tr>
                        <th class="ar-chk"><input type="checkbox" id="archive-master-check" onchange="toggleAllArchiveNodes(this)" checked title="انتخاب همه"></th>
                        <th>مشخصات نود (IP / SNI)</th>
                        <th class="is-num">پورت</th>
                        <th class="is-num">تأخیر ثبت شده</th>
                        <th class="ar-act"></th>
                      </tr>
                    </thead>
                    <tbody id="archive-nodes-list"></tbody>
                  </table>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>

    <!-- Custom Archive Alert Modal -->
    <div id="archive-alert-modal" style="display: none; position: fixed; inset: 0; z-index: 1000001; align-items: center; justify-content: center; padding: 1rem;">
      <div class="bg-mv-scrim absolute inset-0 z-[-1]" onclick="document.getElementById('archive-alert-modal').style.display='none'"></div>
      <div class="w-full max-w-sm bg-gs-panel rounded-2xl p-6 relative shadow-2xl border border-gs-border animate-modal text-center">
        <div class="w-12 h-12 rounded-full bg-gs-panel flex items-center justify-center mx-auto mb-4 text-gs-muted">
          <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        </div>
        <h3 class="text-base font-bold text-gs-muted mb-2" id="archive-alert-title">پیام</h3>
        <p class="text-sm text-gs-muted mb-6" id="archive-alert-msg"></p>
        <button onclick="document.getElementById('archive-alert-modal').style.display='none'" class="w-full py-2.5 bg-gs-panel hover:bg-gs-panel/90 text-mv-label rounded-xl font-medium transition-colors">متوجه شدم</button>
      </div>
    </div>

    <!-- Custom Archive Confirm Modal -->
    <div id="archive-confirm-modal" style="display: none; position: fixed; inset: 0; z-index: 1000001; align-items: center; justify-content: center; padding: 1rem;">
      <div class="bg-mv-scrim absolute inset-0 z-[-1]" onclick="document.getElementById('archive-confirm-modal').style.display='none'"></div>
      <div class="w-full max-w-sm bg-gs-panel rounded-2xl p-6 relative shadow-2xl border border-gs-border animate-modal text-center">
        <div class="w-12 h-12 rounded-full bg-gs-panel/10 flex items-center justify-center mx-auto mb-4 text-gs-muted">
          <svg class="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        </div>
        <h3 class="text-base font-bold text-gs-muted mb-2">تایید عملیات</h3>
        <p class="text-sm text-gs-muted mb-6" id="archive-confirm-msg"></p>
        <div class="flex gap-3">
            <button onclick="document.getElementById('archive-confirm-modal').style.display='none'" class="flex-1 py-2.5 bg-gs-panel border border-gs-border hover:bg-gs-panel text-gs-muted rounded-xl font-medium transition-colors">انصراف</button>
            <button id="archive-confirm-btn" class="flex-1 py-2.5 bg-gs-panel hover:bg-gs-panel/90 text-mv-label rounded-xl font-medium transition-colors">بله، مطمئنم</button>
        </div>
      </div>
    </div>
    <!-- END IP Archive Modal -->
`;


function initArchiveModule() {
    const container = document.getElementById('archive-module-container');
    if (container) {
        container.innerHTML = archiveHtmlTemplate;
        console.log('Archive module HTML injected.');
    }

    // Call initialization logic if exists
    if (typeof loadArchivedIps === 'function') {
        loadArchivedIps();
    }
}

// Original app.archive.js logic
/**
 * app.archive.js - Logic for Permanent IP Archive
 */

let archiveNodes = [];

// Load from LocalStorage
function loadArchive() {
    try {
        const stored = PersistentStorage.getItem("ipscanner_archived_ips");
        if (stored) {
            archiveNodes = JSON.parse(stored);
        } else {
            archiveNodes = [];
        }
    } catch (e) {
        archiveNodes = [];
    }
}

// Save to LocalStorage
function saveArchive() {
    PersistentStorage.setItem("ipscanner_archived_ips", JSON.stringify(archiveNodes));
    renderArchiveModal();
}

// Check and save healthy IPs from the main DOM or from a direct list
function checkAndArchiveHealthyIps() {
    const tab = typeof getActiveTab === "function" ? getActiveTab() : null;
    if (!tab || !tab.results) return;
    
    const cleanResults = tab.results.filter(r => r.alive && r.realDelay > 0);
    if (cleanResults.length === 0) return;

    loadArchive();
    
    let addedCount = 0;
    cleanResults.forEach(r => {
        const exists = archiveNodes.find(n => n.ip === r.ip && n.port === r.port);
        if (!exists) {
            archiveNodes.push({
                ip: r.ip,
                port: r.port || 443,
                proto: "tcp",
                delay: r.realDelay,
                healthy: true
            });
            addedCount++;
        }
    });

    if (addedCount > 0) {
        saveArchive();
    }
}

window.openIpArchive = function() {
    const wrapper = document.getElementById("ip-archive-wrapper");
    if (!wrapper) return;
    
    loadArchive();
    renderArchiveModal();
    wrapper.style.display = "flex";
    wrapper.classList.remove("hidden");
}

window.closeIpArchive = function() {
    const wrapper = document.getElementById("ip-archive-wrapper");
    if (wrapper) {
        wrapper.style.display = "none";
        wrapper.classList.add("hidden");
    }
}

function renderArchiveModal() {
    const list = document.getElementById("archive-nodes-list");
    const countText = document.getElementById("archive-count-text");
    if (!list || !countText) return;

    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    countText.innerText = fa(archiveNodes.length);

    if (archiveNodes.length === 0) {
        list.innerHTML = `<tr><td colspan="5" class="ar-dim" style="text-align:center;padding:34px 16px">هیچ آی‌پی سالمی در آرشیو نیست. با هر اسکن موفق، خودشان اینجا می‌آیند.</td></tr>`;
        return;
    }

    let html = '';
    archiveNodes.forEach((node, index) => {
        // A retest can write a string here ("dead", an error code) as well as a number, so the
        // three cases are told apart rather than formatted blind.
        let delayHtml = '<span class="ar-dim">—</span>';
        if (typeof node.delay === "string") delayHtml = `<span class="ar-bad">${esc(node.delay)}</span>`;
        else if (node.delay > 0) delayHtml = `<span class="ar-ok ar-fig">${fa(node.delay)} ms</span>`;

        html += `
        <tr>
            <td class="ar-chk"><input type="checkbox" class="archive-node-check" data-index="${index}" checked></td>
            <td class="is-ltr">${esc(node.ip)}</td>
            <td class="is-num">${fa(node.port)}</td>
            <td class="is-num" id="archive-delay-${index}">${delayHtml}</td>
            <td class="ar-act"><button type="button" class="ar-del" onclick="deleteArchiveItem(${index})" title="حذف این آی‌پی" aria-label="حذف این آی‌پی"><i class="ph-bold ph-x"></i></button></td>
        </tr>`;
    });

    list.innerHTML = html;
}

function toggleAllArchiveNodes(masterCheck) {
    const checks = document.querySelectorAll(".archive-node-check");
    checks.forEach(c => c.checked = masterCheck.checked);
}

function getSelectedArchiveIndices() {
    const checks = document.querySelectorAll(".archive-node-check:checked");
    return Array.from(checks).map(c => parseInt(c.getAttribute("data-index")));
}

function deleteSelectedArchive() {
    const indices = getSelectedArchiveIndices();
    if (indices.length === 0) return;
    
    // Reverse sort to remove from end without affecting earlier indices
    indices.sort((a, b) => b - a);
    indices.forEach(idx => archiveNodes.splice(idx, 1));
    saveArchive();
}

function deleteArchiveItem(index) {
    archiveNodes.splice(index, 1);
    saveArchive();
}

function clearIpArchive() {
    showArchiveConfirm("آیا از پاکسازی کل آرشیو اطمینان دارید؟", () => {
        archiveNodes = [];
        saveArchive();
    });
}

function transferArchiveToCombo() {
    const indices = getSelectedArchiveIndices();
    if (indices.length === 0) {
        showArchiveAlert("لطفا حداقل یک آی‌پی سالم انتخاب کنید");
        return;
    }

    const healthyNodes = indices.map(idx => archiveNodes[idx]).filter(n => n.healthy !== false);
    
    if (healthyNodes.length === 0) {
        showArchiveAlert("هیچ آی‌پی سالمی برای انتقال وجود ندارد");
        return;
    }

    // Export to global for combo
    window._archiveTransferIps = healthyNodes;
    
    closeIpArchive();
    
    // Open combo and it will use _archiveTransferIps if present
    if (typeof openCombinationCenter === "function") {
        openCombinationCenter();
    }
}

function copySelectedArchive() {
    const indices = getSelectedArchiveIndices();
    const healthyNodes = indices.map(idx => archiveNodes[idx]).filter(n => n.healthy !== false);
    
    if (healthyNodes.length === 0) {
        showArchiveAlert("هیچ نود سالمی انتخاب نشده است.");
        return;
    }

    const text = healthyNodes.map(n => n.ip + ":" + n.port).join("\\n");
    navigator.clipboard.writeText(text).then(() => {
        showArchiveAlert(healthyNodes.length + " آی‌پی سالم کپی شد.");
    });
}

// Retest Archive Nodes
async function retestArchiveNodes() {
    const indices = getSelectedArchiveIndices();
    if (indices.length === 0) {
        showArchiveAlert("لطفا حداقل یک نود برای تست انتخاب کنید.");
        return;
    }

    const btnText = document.getElementById("archive-test-text");
    const iconZap = document.getElementById("archive-test-icon");
    const iconSpinner = document.getElementById("archive-test-spinner");
    const progressBar = document.getElementById("archive-progress-bar");

    if (!btnText || !iconZap || !iconSpinner || !progressBar) return;
    if (btnText.innerText === "در حال تست...") return; // already running

    btnText.innerText = "در حال تست...";
    iconZap.hidden = true;
    iconSpinner.hidden = false;
    progressBar.style.width = "0%";

    const nodesToTest = indices.map(idx => archiveNodes[idx]);

    // We generate dummy configs just for pinging the IPs using Vless
    // The endpoint expects a list of configs. Since we only have IP/Port, we wrap them in a basic VLESS config structure.
    // Read the base config from the main app's input
    const baseConfigRaw = document.getElementById('archive-vless-input')?.value || '';
    const firstConfig = baseConfigRaw.split('\n').filter(l => l.trim().startsWith('vless://') || l.trim().startsWith('trojan://'))[0];
    
    if (!firstConfig) {
        showArchiveAlert("لطفاً برای انجام تست ریلی، ابتدا یک کانفیگ پایه معتبر (vless یا trojan) در کادر قرار دهید.");
        btnText.innerText = "تست مجدد";
        iconZap.hidden = false;
        iconSpinner.hidden = true;
        return;
    }

    const dummyConfigs = nodesToTest.map((node, i) => {
        let modified = firstConfig.trim();
        // Replace IP and Port
        modified = modified.replace(/@([a-zA-Z0-9.-]+):(\d+)/, "@" + node.ip + ":" + node.port);
        // Append archive tag
        modified = modified.replace(/#.*/, "#Archive-" + i);
        if (!modified.includes('#')) modified += "#Archive-" + i;
        return modified;
    });

    try {
        const response = await fetch('/api/v2ray/test-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodes: dummyConfigs.map((c, idx) => ({ id: idx, uri: c })), testType: "delay" })
        });

        const data = await response.json();
        const results = data.results || [];
        
        let processedCount = 0;
        
        nodesToTest.forEach((originalNode, i) => {
            const res = results.find(r => r.id === i);
            const nodeIndex = archiveNodes.findIndex(n => n.ip === originalNode.ip && n.port === originalNode.port);
            
            if (nodeIndex !== -1) {
                // Determine raw state for debugging UI
                let debugState = "Timeout";
                if (!res) debugState = "No Res";
                else if (res.val === -1) debugState = "Timeout";
                else if (res.val === 0) debugState = "Error 0";
                else debugState = res.val + " ms";

                if (!res || res.val === -1 || !res.val) {
                    archiveNodes[nodeIndex].healthy = false;
                    archiveNodes[nodeIndex].delay = debugState; // Storing string for debug!
                } else {
                    archiveNodes[nodeIndex].healthy = true;
                    archiveNodes[nodeIndex].delay = res.val; // Keep as number
                }
            }
            processedCount++;
            progressBar.style.width = ((processedCount / nodesToTest.length) * 100) + "%";
        });

        saveArchive(); // Will re-render visually

    } catch (error) {
        console.error("Archive test error:", error);
        showArchiveAlert("خطا در انجام تست ریلی");
    } finally {
        btnText.innerText = "تست مجدد";
        iconZap.hidden = false;
        iconSpinner.hidden = true;
        setTimeout(() => progressBar.style.width = "0%", 1000);
    }
}

window.showArchiveAlert = function(msg) {
    const msgEl = document.getElementById("archive-alert-msg");
    const modal = document.getElementById("archive-alert-modal");
    if(msgEl && modal) {
        msgEl.innerText = msg;
        modal.style.display = "flex";
    } else {
        // Fallback when the archive panel's own modal is not in the DOM yet. Uses the
        // shared dialog rather than the native box so it still matches the app.
        uiAlert({ title: 'بایگانی', message: msg });
    }
}

window.showArchiveConfirm = function(msg, onConfirm) {
    const msgEl = document.getElementById("archive-confirm-msg");
    const modal = document.getElementById("archive-confirm-modal");
    const btn = document.getElementById("archive-confirm-btn");
    if(msgEl && modal && btn) {
        msgEl.innerText = msg;
        btn.onclick = () => {
            modal.style.display = "none";
            onConfirm();
        };
        modal.style.display = "flex";
    } else {
        uiConfirm({ title: 'تأیید می‌کنید؟', message: msg, danger: true })
            .then(ok => { if (ok) onConfirm(); });
    }
}

// Auto-hook into the app's scanner completion if possible
// We will call checkAndArchiveHealthyIps() periodically or via direct injection.
setInterval(() => {
    // Only check if we are not actively in the archive to avoid jarring updates
    const wrapper = document.getElementById("ip-archive-wrapper");
    if (!wrapper || wrapper.style.display === "none") {
        checkAndArchiveHealthyIps();
    }
}, 5000);

