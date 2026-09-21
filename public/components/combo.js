// --- Combination Center Module ---
const comboHtmlTemplate = `
<style>
  /* The combination centre, laid out as a window: a status line, two grouped lists (the IPs,
     then the base configs), the results, and a bottom bar with the one action. As a window
     (shell on) its dim and header are dropped by shell.css › .mv-sheetwin; with the shell
     off it is the same card over a dim. */
  #combination-center-modal .cc-card { background: var(--mv-window); color: var(--mv-label); text-align: right; }
  #combination-center-modal .cc-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: var(--mv-hl) solid var(--mv-sep-2); }
  #combination-center-modal .cc-head h2 { flex: 1; margin: 0; font-size: 14px; font-weight: 700; }
  #combination-center-modal .cc-head-ic { font-size: 18px; color: var(--mv-label-2); }
  #combination-center-modal .cc-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 20px 22px; }
  #combination-center-modal .cc-status { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: var(--mv-r-lg); background: var(--mv-fill); font-size: 12.5px; color: var(--mv-label-2); }
  #combination-center-modal .cc-sec-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 20px 4px 7px; }
  #combination-center-modal .cc-sec-head .mv-group-title { margin: 0; }
  #combination-center-modal .cc-list { max-height: 290px; overflow-y: auto; }
  /* The list sits inside a .mv-form-group, which already draws the well and the hairlines. */
  #combination-center-modal .cc-list > .mv-row + .mv-row { border-top: var(--mv-hl) solid var(--mv-group-sep, rgba(128,128,128,.2)); }
  /* A header with something on its trailing edge — the form kit's header is text only. */
  #combination-center-modal .cc-sec-head { margin: 0 0 6px; }
  #combination-center-modal .cc-sec-head .mv-form-header { flex: 1; min-width: 0; }
  /* The bottom bar is K5 now; the old footer only has to stop painting its own ground. */
  #combination-center-modal .cc-foot { border-top: 0; background: none; padding: 0; }
  #combination-center-modal .cc-row { cursor: pointer; transition: background var(--mv-d-1) var(--mv-ease-out); }
  #combination-center-modal .cc-row:hover { background: var(--mv-fill); }
  #combination-center-modal .cc-row:has(input:checked) { background: var(--mv-accent-soft); }
  #combination-center-modal .cc-row:has(input:disabled) { cursor: default; opacity: .6; }
  #combination-center-modal .cc-row .mv-row-end .mv-btn--icon { --h: 26px; }
  #combination-center-modal .cc-name { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
  #combination-center-modal .cc-name bdi { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #combination-center-modal .cc-mult { font-family: var(--mv-font-tech); font-variant-numeric: tabular-nums; font-size: 12px; color: var(--mv-label-3); }
  #combination-center-modal .cc-empty { padding: 18px 12px; text-align: center; font-size: 12.5px; color: var(--mv-label-2); }
  #combination-center-modal #combo-archive-section { flex-direction: column; }
  #combination-center-modal .cc-groups { display: flex; flex-direction: column; gap: 12px; }
  #combination-center-modal .cc-group { border-radius: var(--mv-r-lg); background: var(--mv-surface); box-shadow: 0 0 0 var(--mv-hl) var(--mv-sep-2); overflow: hidden; }
  #combination-center-modal .cc-group-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px 8px; cursor: pointer; }
  #combination-center-modal .cc-group-title { font-size: 13px; font-weight: 700; }
  #combination-center-modal .cc-group-meta { margin-top: 1px; font-size: 11.5px; color: var(--mv-label-2); }
  #combination-center-modal .cc-group-badges { display: flex; gap: 6px; flex: none; }
  #combination-center-modal .cc-group-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 0 12px 10px; }
  #combination-center-modal .cc-group-actions .cc-del { margin-inline-start: auto; }
  #combination-center-modal .cc-prog { height: 3px; background: var(--mv-track); }
  #combination-center-modal .cc-prog > div { height: 100%; width: 0; background: var(--mv-accent); transition: width var(--mv-d-2) var(--mv-ease-out); }
  #combination-center-modal .cc-nodes { max-height: 260px; overflow-y: auto; }
  #combination-center-modal .cc-nodes-head,
  #combination-center-modal .cc-node { display: flex; align-items: center; gap: 6px; padding: 6px 12px; }
  #combination-center-modal .cc-nodes-head { position: sticky; top: 0; z-index: 1; font-size: 11px; color: var(--mv-label-3); background: var(--mv-surface-2); }
  #combination-center-modal .cc-node { border-top: var(--mv-hl) solid var(--mv-sep); font-size: 12.5px; cursor: pointer; }
  #combination-center-modal .cc-node:hover { background: var(--mv-fill); }
  #combination-center-modal .cc-c-check { width: 26px; flex: none; display: flex; justify-content: center; }
  #combination-center-modal .cc-c-ip { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  #combination-center-modal .cc-c-ip small { font-size: 10.5px; color: var(--mv-label-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #combination-center-modal .cc-c-proto { width: 76px; flex: none; text-align: center; }
  #combination-center-modal .cc-c-st { width: 84px; flex: none; text-align: left; }
  #combination-center-modal .cc-foot { flex: none; display: flex; align-items: center; gap: 12px; padding: 11px 20px; border-top: var(--mv-hl) solid var(--mv-sep-2); background: var(--mv-window); }
  #combination-center-modal .cc-calc { flex: 1; min-width: 0; font-size: 12.5px; color: var(--mv-label-2); }
  /* The combination centre's own questions, as sheets. */
  .cc-sheet { width: 100%; max-width: 440px; padding: 20px; display: flex; flex-direction: column; gap: 12px; background: var(--mv-window); color: var(--mv-label); text-align: right; }
  .cc-sheet h3 { margin: 0; font-size: 14px; font-weight: 700; }
  .cc-sheet p { margin: 0; font-size: 12.5px; line-height: 1.85; color: var(--mv-label-2); }
  .cc-sheet-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
</style>
<div id="combination-center-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4" dir="rtl">
  <div class="absolute inset-0 bg-mv-scrim" onclick="closeCombinationCenter()" id="combination-center-overlay"></div>
  <div class="cc-card relative z-10 w-full max-w-[860px] max-h-[90vh] flex flex-col overflow-hidden rounded-2xl shadow-2xl">
    <header class="cc-head">
      <i class="ph ph-stack cc-head-ic"></i>
      <h2>مرکز ترکیب کانفیگ‌ها</h2>
      <button type="button" class="mv-btn mv-btn--icon" onclick="closeCombinationCenter()" aria-label="بستن" title="بستن"><i class="ph ph-x"></i></button>
    </header>

    <div class="cc-body custom-scrollbar">
      <div class="mv-form">

        <!-- What the whole page is waiting on, as a callout rather than a grey strip with a dot. -->
        <div class="mv-form-section is-wide">
          <div class="mv-form-group">
            <div class="mv-form-row mv-callout is-warn" id="combo-modal-subtitle">
              <i class="ph-fill ph-info"></i><span>در حال بارگذاری…</span>
            </div>
          </div>
        </div>

        <!-- The numbering («۱.», «۲.») went: nothing else in the app numbers its sections, and
             these two are not steps — the archive alone is already enough to combine. -->
        <div class="mv-form-section is-wide">
          <div class="cc-sec-head"><div class="mv-form-header">آی‌پی‌ها — گروه‌های اسکن</div><span class="mv-pill" id="ip-groups-count">۰ گروه</span></div>
          <div class="mv-form-group"><div id="combo-ip-groups-list" class="cc-list"></div></div>
          <div class="mv-form-footer">آی‌پی‌های سالمِ آرشیو همیشه در ترکیب هستند. هر گروه اسکن را که تیک بزنید، آی‌پی‌هایش هم اضافه می‌شود؛ دکمهٔ ⚡ آی‌پی‌های همان گروه را با یک کانفیگ دوباره تست می‌کند.</div>
        </div>

        <div class="mv-form-section is-wide">
          <div class="mv-form-header">کانفیگ‌های پایه</div>
          <div class="mv-form-group"><div id="combo-base-list" class="cc-list"></div></div>
          <div class="mv-form-footer">هر کانفیگ پایه با هر آی‌پی سالم یک‌بار ترکیب می‌شود؛ عدد کنار هرکدام می‌گوید چند کانفیگ از آن در می‌آید.</div>
        </div>

        <section id="combo-archive-section" class="mv-form-section is-wide" style="display: none">
          <div class="cc-sec-head"><div class="mv-form-header">نتایج ترکیب</div><button type="button" class="mv-btn mv-btn--sm" onclick="clearComboHistory()">پاکسازی همه</button></div>
          <div id="combo-groups-container" class="cc-groups"></div>
        </section>

      </div>
    </div>

    <div class="mv-bottom-bar cc-foot">
      <div class="mv-bb-lead cc-calc" id="combo-calc-bar">لطفاً حداقل یک گروه را انتخاب کنید</div>
      <div class="mv-bb-end"><button id="btn-do-combine" disabled onclick="doCombineSelected()" class="mv-btn mv-btn--lg mv-btn--primary">ترکیب کانفیگ‌ها</button></div>
    </div>
  </div>
</div>

<!-- Retest a scan group: which config to test its IPs through -->
<div id="retest-config-modal" class="hidden fixed inset-0 z-[60] flex items-center justify-center p-4 bg-mv-scrim" dir="rtl">
  <div class="cc-sheet rounded-2xl shadow-2xl" role="dialog" aria-labelledby="retest-config-title">
    <h3 id="retest-config-title">تست مجدد آی‌پی‌های این گروه</h3>
    <p>یک کانفیگ vless، vmess یا trojan بدهید؛ آی‌پی‌های گروه روی آن جای‌گذاری و به‌صورت واقعی تست می‌شوند.</p>
    <textarea id="retest-config-input" rows="4" class="mv-field mv-field--tech" placeholder="vless://..."></textarea>
    <div class="cc-sheet-btns">
      <button type="button" class="mv-btn" onclick="closeRetestModal()">انصراف</button>
      <button type="button" id="btn-start-retest" class="mv-btn mv-btn--primary" onclick="submitRetestConfig()">شروع تست</button>
    </div>
  </div>
</div>

<!-- Retest finished: drop the IPs that failed? -->
<div id="retest-confirm-modal" class="hidden fixed inset-0 z-[60] flex items-center justify-center p-4 bg-mv-scrim" dir="rtl">
  <div class="cc-sheet rounded-2xl shadow-2xl" role="dialog" aria-labelledby="retest-confirm-title">
    <h3 id="retest-confirm-title">نتیجه‌ی تست مجدد</h3>
    <p id="retest-confirm-msg">تست به پایان رسید.</p>
    <div class="cc-sheet-btns">
      <button type="button" class="mv-btn" onclick="finishRetest(false)">نگه‌داشتن همه</button>
      <button type="button" class="mv-btn mv-btn--danger-fill" onclick="finishRetest(true)">حذف ناسالم‌ها</button>
    </div>
  </div>
</div>


<!-- Delete Combo Group Modal -->
    <div id="deleteComboModal" class="fixed inset-0 z-[60] hidden flex items-center justify-center p-4">
        <div class="absolute inset-0 bg-mv-scrim backdrop-blur-sm" onclick="closeComboModal('deleteComboModal')"></div>
        <div class="bg-mv-surface w-full max-w-sm rounded-3xl p-6 md:p-8 transform scale-95 opacity-0 transition-all duration-300 shadow-2xl border border-mv-sep-2 flex flex-col items-center text-center relative z-10" id="deleteComboModalContent">
            
            <div class="w-16 h-16 bg-mv-red/10 text-mv-red-ink rounded-full flex items-center justify-center mb-6">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </div>
            
            <h3 class="text-xl font-bold text-mv-label mb-2">حذف کانفیگ</h3>
            <p class="text-sm text-mv-label-2 mb-8" id="deleteComboModalDesc">آیا از حذف این گروه کانفیگ مطمئن هستید؟</p>
            
            <div class="flex w-full gap-3">
                <button onclick="closeComboModal('deleteComboModal')" class="flex-1 py-3 rounded-full text-sm font-bold text-mv-label bg-mv-surface-3 hover:bg-mv-surface-4 transition-colors">انصراف</button>
                <button id="btn-confirm-delete-combo" class="flex-1 py-3 rounded-full text-sm font-bold bg-mv-red-fill text-white hover:bg-mv-red-fill/90 shadow-lg shadow-mv-red/20 transition-all">بله، حذف کن</button>
            </div>
        </div>
    </div>
`;
function initComboModule() {
    const container = document.getElementById('combo-module-container');
    if (container) {
        container.innerHTML = comboHtmlTemplate;
        console.log('Combo module HTML injected.');
    }
}


// ==========================================
// Combination Center Logic (Google Dark Theme)
// ==========================================

window.getCleanIps = function() {
    let ips = [];
    
    const selectedCheckboxes = document.querySelectorAll('.ip-group-checkbox:checked');
    if (selectedCheckboxes.length > 0) {
        const hist = JSON.parse(PersistentStorage.getItem('ipscanner_history') || '[]');
        selectedCheckboxes.forEach(cb => {
            const groupId = cb.value;
            const group = hist.find(h => h.id === groupId);
            if (group && group.results) {
                let cleanIps = group.results.filter(r => r.alive || r.realDelay > 0 || r.ip);
                ips = ips.concat(cleanIps.map(r => r.ip));
            }
        });
    }

    if (window._archiveTransferIps && window._archiveTransferIps.length > 0) {
        window._archiveTransferIps.forEach(node => {
            if (!ips.includes(node.ip)) ips.push(node.ip);
        });
    }
    
    // Auto-include 100% clean IPs from archive
    try {
        const archived = JSON.parse(PersistentStorage.getItem("ipscanner_archived_ips") || "[]");
        archived.forEach(node => {
            if (node.healthy !== false && !ips.includes(node.ip)) {
                ips.push(node.ip);
            }
        });
    } catch(e) {}

    ips = [...new Set(ips)];
    return ips;
};

// The status line above the lists: how many clean IPs the next combination will use.
function renderComboSubtitle() {
    const cleanIps = getCleanIps();
    const subtitle = document.getElementById("combo-modal-subtitle");
    if(subtitle) {
        // K6 callout: the tone IS the state, and the sentence says it too — colour is never the
        // only signal. Ready is not a warning, so the class moves with the meaning.
        const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
        const ok = cleanIps.length > 0;
        subtitle.className = 'mv-form-row mv-callout' + (ok ? '' : ' is-warn');
        subtitle.innerHTML = ok
            ? `<i class="ph-fill ph-check-circle"></i><span>آمادهٔ ترکیب با <b>${fa(cleanIps.length)} آی‌پی</b> سالم.</span>`
            : '<i class="ph-fill ph-warning"></i><span>هیچ آی‌پی سالمی در دسترس نیست — یک اسکن بزنید، یا گروهی را از پایین تیک کنید.</span>';
    }
}

// A scan group was ticked or unticked: the clean-IP pool changed, so the status line, the
// «n × m» figure on each base, which bases can be picked, and the total all follow it.
window.comboIpGroupsChanged = function() {
    renderComboSubtitle();
    renderBaseConfigs();
};

window.openCombinationCenter = function() {
    const overlay = document.getElementById("combination-center-overlay");
    const modal = document.getElementById("combination-center-modal");
    if (!overlay || !modal) return;

    // The scan groups come first: which of them are ticked is part of the clean-IP pool.
    if (typeof renderIpGroups === 'function') renderIpGroups();
    renderComboSubtitle();

    if (window._archiveTransferIps && window._archiveTransferIps.length > 0) {
        if (!window._archiveAlertShown) {
            toast(window._archiveTransferIps.length + " آی‌پی سالم از آرشیو برای ترکیب آماده شد.");
            window._archiveAlertShown = true; 
        }
    }

    try {
        const comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups"));
        if (comboGroups && comboGroups.length > 0) {
            document.getElementById("combo-archive-section").style.display = "flex";
            if(typeof renderComboGroups === 'function') renderComboGroups();
        } else {
            const sec2 = document.getElementById("combo-archive-section");
            if(sec2) sec2.style.display = "none";
        }
    } catch(e) {
        const sec2 = document.getElementById("combo-archive-section");
        if(sec2) sec2.style.display = "none";
    }
    
    renderBaseConfigs();
    
    overlay.style.display = "block";
    overlay.classList.remove("hidden");
    modal.style.display = "flex";
    modal.classList.remove("hidden");
}

window.closeCombinationCenter = function() {
    const overlay = document.getElementById("combination-center-overlay");
    const modal = document.getElementById("combination-center-modal");
    if (overlay) {
        overlay.style.display = "none";
        overlay.classList.add("hidden");
    }
    if (modal) {
        modal.style.display = "none";
        modal.classList.add("hidden");
    }
}

window.saveBaseConfigGroup = function(url, configs, metadata = null) {
    let bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
    const cleanUrl = url.replace("https://", "");
    
    bases.unshift({
        id: Date.now().toString(),
        name: cleanUrl,
        configs: configs,
        metadata: metadata,
        date: new Date().toLocaleString("fa-IR")
    });
    
    if(bases.length > 20) bases = bases.slice(0, 20);
    PersistentStorage.setItem("cf_base_configs", JSON.stringify(bases));

    // Every panel that receives configs comes through here — BPB, Edge, Zeus, and whatever is
    // added next — so this is the one place the assistant has to be told. It offers to combine
    // them with clean IPs; declining is remembered per group, so it asks once.
    if (window.MVAssistant && typeof window.MVAssistant.notify === 'function') window.MVAssistant.notify();
}

function renderBaseConfigs() {
    const list = document.getElementById("combo-base-list");
    if (!list) return;
    
        const bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
    const cleanIps = getCleanIps();
    // A redraw (a scan group ticked, the window reopened) keeps the bases already ticked.
    const keep = new Set(Array.from(list.querySelectorAll(".base-group-checkbox:checked")).map(cb => cb.value));

    if (bases.length === 0) {
        list.innerHTML = `<div class="cc-empty">هنوز هیچ نود پایه‌ای دریافت نکرده‌اید.</div>`;
        updateComboCalc();
        return;
    }
    
    list.innerHTML = "";
    bases.forEach(base => {
        const canCombine = cleanIps.length > 0;
        
        let badgeHtml = '';
        if (base.metadata && base.metadata.zeusUsername) {
            badgeHtml = `<span class="px-1.5 py-0.5 bg-mv-purple/20 text-mv-purple-ink rounded text-[10px] ml-2 border border-mv-purple/30">زئوس</span>`;
        } else if (base.metadata && base.metadata.edgeUuid) {
            badgeHtml = `<span class="px-1.5 py-0.5 bg-mv-accent/20 text-mv-blue-ink rounded text-[10px] ml-2 border border-mv-blue/30">Edge</span>`;
        }
        
                // A grouped-list row; the ticked state is styled by CSS (.cc-row:has(:checked)).
        const card = document.createElement("label");
        card.className = "mv-row cc-row";
        card.innerHTML = `
            <input type="checkbox" class="md-checkbox base-group-checkbox" value="${base.id}" ${!canCombine ? "disabled" : ""} ${canCombine && keep.has(base.id) ? "checked" : ""} onchange="updateComboCalc()">
            <div class="mv-row-text">
                <span class="cc-name"><bdi class="mv-tech-digits">${base.name}</bdi>${badgeHtml}</span>
                <small>${base.configs.length} کانفیگ • ${base.date}</small>
            </div>
            <div class="mv-row-end cc-mult">${base.configs.length} × ${cleanIps.length || 0}</div>
        `;
        list.appendChild(card);
    });
    updateComboCalc();
}

function toggleGroupStyle(labelEl) {
    setTimeout(() => {
        const cb = labelEl.querySelector("input[type=checkbox]");
        if (cb && cb.checked) {
            labelEl.classList.replace("border-mv-sep-2", "border-mv-blue");
            labelEl.classList.replace("bg-mv-surface", "bg-mv-blue/5");
        } else {
            labelEl.classList.replace("border-mv-blue", "border-mv-sep-2");
            labelEl.classList.replace("bg-mv-blue/5", "bg-mv-surface");
        }
    }, 10);
}

function updateComboCalc() {
    const checkboxes = document.querySelectorAll(".base-group-checkbox:checked");
    const cleanIpsCount = getCleanIps().length;
    const bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
    
    let totalBaseConfigs = 0;
    checkboxes.forEach(cb => {
        const base = bases.find(b => b.id === cb.value);
        if(base) totalBaseConfigs += base.configs.length;
    });
    
    const calcBar = document.getElementById("combo-calc-bar");
    const btn = document.getElementById("btn-do-combine");
    
    if(cleanIpsCount === 0) {
        calcBar.innerHTML = `<span class="text-mv-red-ink">شما هیچ آی‌پی سالم ۱۰۰٪ متصل ندارید! ابتدا اسکن کنید.</span>`;
        btn.disabled = true;
    } else if (checkboxes.length === 0) {
        calcBar.innerHTML = `لطفاً گروهی را انتخاب کنید`;
        btn.disabled = true;
    } else {
        const totalWillBe = totalBaseConfigs * cleanIpsCount;
        calcBar.innerHTML = `تعداد ترکیبات خروجی: <span class="text-mv-blue-ink font-bold text-base mx-1">${totalWillBe}</span> کانفیگ`;
        btn.disabled = false;
    }
}


function doCombineSelected() {
    const checkboxes = document.querySelectorAll(".base-group-checkbox:checked");
    if(checkboxes.length === 0) return;
    
    const bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
    const cleanIps = getCleanIps();
    
    let newNodes = [];
    
    checkboxes.forEach(cb => {
        const base = bases.find(b => b.id === cb.value);
        if(!base) return;
        
        base.configs.forEach(rawConfig => {
            cleanIps.forEach(ip => {
                let modified = rawConfig;
                modified = modified.replace(/@([a-zA-Z0-9.-]+):(\d+)/, "@" + ip + ":$2");
                if (modified.includes('#')) {
                    modified = modified + encodeURIComponent(" [" + ip + "]");
                } else {
                    modified = modified + "#" + ip;
                }
                
                newNodes.push({
                    config: modified,
                    ip: ip,
                    sni: base.name,
                    healthy: null,
                    delay: null
                });
            });
        });
    });
    
    let comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups") || "[]");
    const dateStr = new Date().toLocaleString("fa-IR");
    const groupId = "combo_" + Date.now();
    
    let baseNames = [...new Set(newNodes.map(n => n.sni).filter(Boolean))];
    let titleStr = "ترکیب کانفیگ";
    if (baseNames.length > 0) {
        titleStr = baseNames.length > 2 ? baseNames[0] + " و " + (baseNames.length - 1) + " گروه دیگر" : baseNames.join(' + ');
    }
    
    // Check if we have Zeus or Edge metadata
    let groupMetadata = null;
    let combinedZeusUsers = new Set();
    let zeusAccId = null;
    let zeusUrl = null;
    
    let combinedEdgeUsers = new Set();
    let edgeAccId = null;
    let edgeUrl = null;
    
    let isBpb = false;
    
    checkboxes.forEach(cb => {
        const base = bases.find(b => b.id === cb.value);
        if(base && base.metadata) {
            if (base.metadata.zeusUsername) {
                combinedZeusUsers.add(base.metadata.zeusUsername);
                zeusAccId = base.metadata.zeusAccId;
                zeusUrl = base.metadata.zeusUrl;
            } else if (base.metadata.edgeUuid) {
                combinedEdgeUsers.add(base.metadata.edgeUuid);
                edgeAccId = base.metadata.edgeAccId;
                edgeUrl = base.metadata.edgeUrl;
            } else if (base.metadata.isBpb) {
                isBpb = true;
            }
        }
    });
    
    // Only link if exactly 1 user is combined (cannot push multiple users' configs to 1 sub link easily)
    if (combinedZeusUsers.size === 1) {
        groupMetadata = {
            zeusUsername: Array.from(combinedZeusUsers)[0],
            zeusAccId: zeusAccId,
            zeusUrl: zeusUrl
        };
    } else if (combinedEdgeUsers.size === 1) {
        groupMetadata = {
            edgeUuid: Array.from(combinedEdgeUsers)[0],
            edgeAccId: edgeAccId,
            edgeUrl: edgeUrl
        };
    } else if (isBpb) {
        groupMetadata = { isBpb: true };
    }
    
    comboGroups.unshift({
        id: groupId,
        title: titleStr,
        date: dateStr,
        nodes: newNodes,
        metadata: groupMetadata
    });
    
    PersistentStorage.setItem("ipscanner_combo_groups", JSON.stringify(comboGroups));
    
    document.getElementById("combo-archive-section").style.display = "flex";
    renderComboGroups();
}

function renderComboGroups() {
    const container = document.getElementById("combo-groups-container");
    if (!container) return;
    
    let comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups") || "[]");
    
    if (comboGroups.length === 0) {
                container.innerHTML = `<div class="cc-empty">هیچ ترکیب ذخیره شده‌ای وجود ندارد.</div>`;
        return;
    }
    
    container.innerHTML = "";
    
    comboGroups.forEach(group => {
        let healthyCount = group.nodes.filter(n => n.healthy === true).length;
        let failedCount = group.nodes.filter(n => n.healthy === false).length;
        
        let nodesHtml = group.nodes.map((node, idx) => {
            let proto = "VLESS";
            if (node.config.startsWith("vmess")) proto = "VMess";
            else if (node.config.startsWith("trojan")) proto = "Trojan";

            let delayText = "<span class=\"text-mv-label-2 text-[10px]\">تست نشده</span>";
            if (node.delay !== null) {
                if (node.healthy) delayText = `<span class="text-mv-green-ink font-mono font-bold">${node.delay}ms</span>`;
                else delayText = `<span class="text-mv-red-ink font-mono text-xs">Timeout</span>`;
            }
            
                        return `
            <label class="cc-node">
                <span class="cc-c-check"><input type="checkbox" class="md-checkbox node-check-${group.id}" value="${idx}" checked onclick="event.stopPropagation()"></span>
                <span class="cc-c-ip"><bdi class="mv-tech">${node.ip}</bdi><small>${node.sni}</small></span>
                <span class="cc-c-proto"><span class="mv-pill">${proto}</span></span>
                <span class="cc-c-st" id="delay-${group.id}-${idx}">${delayText}</span>
            </label>`;
        }).join('');
        
                const card = document.createElement('div');
        card.className = "cc-group";
        card.innerHTML = `
            <div class="cc-group-head" onclick="document.getElementById('list-${group.id}').classList.toggle('hidden')">
                <div>
                    <div class="cc-group-title">${group.title.startsWith("ترکیب کانفیگ - ") && group.nodes.length > 0 && group.nodes[0].sni ? ([...new Set(group.nodes.map(n=>n.sni).filter(Boolean))].join(' + ')) : group.title}</div>
                    <div class="cc-group-meta">${group.nodes.length} کانفیگ • ${group.date || ''}</div>
                </div>
                <div class="cc-group-badges">
                    <span class="mv-pill is-ok" id="health-badge-${group.id}">${healthyCount} سالم</span>
                    <span class="mv-pill is-bad" id="fail-badge-${group.id}">${failedCount} ناموفق</span>
                </div>
            </div>
            <div class="cc-group-actions">
                <button id="btn-test-${group.id}" onclick="startTestComboGroup('${group.id}')" class="mv-btn mv-btn--sm">تست اتصال</button>
                <button onclick="copyComboGroup('${group.id}')" class="mv-btn mv-btn--sm">کپی سالم‌ها</button>
                <button onclick="exportComboGroup('${group.id}')" class="mv-btn mv-btn--sm">انتقال به V2ray</button>
                ${group.metadata && group.metadata.zeusUsername ? `<button onclick="updateZeusSubLink('${group.id}')" id="btn-zeus-${group.id}" class="mv-btn mv-btn--sm"><i class="ph-bold ph-cloud-arrow-up"></i>بروز رسانی ساب ${group.metadata.zeusUsername}</button>` : ''}
                ${group.metadata && group.metadata.edgeUuid ? `<button onclick="updateEdgeSubLink('${group.id}')" id="btn-edge-${group.id}" class="mv-btn mv-btn--sm"><i class="ph-bold ph-cloud-arrow-up"></i>بروز رسانی ساب Edge</button>` : ''}
                <button onclick="askDeleteComboGroup('${group.id}')" class="mv-btn mv-btn--sm mv-btn--danger cc-del" title="حذف این گروه">حذف</button>
            </div>
            <div id="progress-${group.id}" class="cc-prog"><div id="bar-${group.id}"></div></div>
            <div id="list-${group.id}" class="cc-nodes hidden">
                <div class="cc-nodes-head">
                    <span class="cc-c-check"><input type="checkbox" onchange="toggleAllGroupNodes('${group.id}', this.checked)" checked class="md-checkbox"></span>
                    <span class="cc-c-ip">آی‌پی / SNI</span>
                    <span class="cc-c-proto">پروتکل</span>
                    <span class="cc-c-st">وضعیت</span>
                </div>
                ${nodesHtml}
            </div>
        `;
        container.appendChild(card);
    });
}

function toggleAllGroupNodes(groupId, checked) {
    const cbs = document.querySelectorAll(`.node-check-${groupId}`);
    cbs.forEach(cb => {
        cb.checked = checked;
    });
}

async function clearComboHistory() {
    if (await uiConfirm({
        title: 'کل تاریخچه‌ی ترکیب پاک شود؟',
        message: 'همه‌ی گروه‌های ذخیره‌شده حذف می‌شوند و قابل بازگردانی نیستند.',
        confirmLabel: 'پاک کن', danger: true,
    })) {
        PersistentStorage.removeItem("ipscanner_combo_groups");
        renderComboGroups();
        document.getElementById("combo-archive-section").style.display = "none";
    }
}

function deleteComboGroup(groupId) {
    let comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups") || "[]");
    comboGroups = comboGroups.filter(g => g.id !== groupId);
    PersistentStorage.setItem("ipscanner_combo_groups", JSON.stringify(comboGroups));
    renderComboGroups();
    if(comboGroups.length === 0) {
        document.getElementById("combo-archive-section").style.display = "none";
    }
}

async function startTestComboGroup(groupId) {
    const btn = document.getElementById(`btn-test-${groupId}`);
    if(btn && btn.disabled) return;
    
    let comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups") || "[]");
    const group = comboGroups.find(g => g.id === groupId);
    if(!group) return;
    
    const checkboxes = Array.from(document.querySelectorAll(`.node-check-${groupId}:checked`));
    if(checkboxes.length === 0) {
        toast("حداقل یک کانفیگ را برای تست انتخاب کنید");
        return;
    }
    
    if(btn) {
        btn.disabled = true;
        btn.innerText = "در حال تست...";
    }
    
    let healthyCount = 0;
    let failedCount = 0;
    let testedCount = 0;
    const total = checkboxes.length;
    
    window.isComboTestingAborted = false;
    const footerContainer = document.getElementById('combo-footer-progress-container');
    const footerBar = document.getElementById('combo-footer-progress-bar');
    const footerText = document.getElementById('combo-footer-progress-text');
    
    if (footerContainer) footerContainer.style.display = 'flex';
    if (footerBar) footerBar.style.width = '0%';
    if (footerText) footerText.innerText = `در حال تست ... 0 / ${total}`;
    
    const configsToTest = checkboxes.map(cb => {
        const idx = parseInt(cb.value);
        return { idx, config: group.nodes[idx].config };
    });
    
    for (let i = 0; i < configsToTest.length; i += 50) {
        if (window.isComboTestingAborted) {
            toast("تست اتصال توسط کاربر متوقف شد.");
            break;
        }
        
        const batch = configsToTest.slice(i, i + 50);
        const configsArr = batch.map(b => b.config);
        
        try {
            const res = await fetch("/api/v2ray/test-nodes", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    nodes: configsArr.map((c, idx) => ({ id: idx, uri: c })),
                    testType: "delay"
                })
            });
            
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            while(true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunks = decoder.decode(value).split('\n');
                for (let chunk of chunks) {
                    if (!chunk.trim()) continue;
                    try {
                        const d = JSON.parse(chunk);
                        if (d.done) continue;
                        
                        const batchIdx = d.id;
                        const b = batch[batchIdx];
                        if (!b) continue;
                        
                        const node = group.nodes[b.idx];
                        testedCount++;
                        
                        const delayEl = document.getElementById(`delay-${groupId}-${b.idx}`);
                        if (d.val > 0) {
                            node.healthy = true;
                            node.delay = d.val;
                            healthyCount++;
                            if(delayEl) delayEl.innerHTML = `<span class="text-mv-green-ink font-mono font-bold">${d.val}ms</span>`;
                        } else {
                            node.healthy = false;
                            node.delay = -1;
                            failedCount++;
                            if(delayEl) delayEl.innerHTML = `<span class="text-mv-red-ink font-mono text-xs">Timeout</span>`;
                        }
                    } catch(e) {}
                }
            }
            
            document.getElementById(`health-badge-${groupId}`).innerText = healthyCount + " سالم";
            document.getElementById(`fail-badge-${groupId}`).innerText = failedCount + " ناموفق";
            
            const pb = document.getElementById(`bar-${groupId}`);
            if(pb) pb.style.width = ((testedCount / total) * 100) + "%";
            
            if (footerBar) footerBar.style.width = ((testedCount / total) * 100) + "%";
            if (footerText) footerText.innerText = `در حال تست ... ${testedCount} / ${total}`;
            
        } catch (err) {
            console.error("Combo test batch err", err);
        }
    }
    
    PersistentStorage.setItem("ipscanner_combo_groups", JSON.stringify(comboGroups));
    
    if (footerContainer && !window.isComboTestingAborted) {
        setTimeout(() => { footerContainer.style.display = 'none'; }, 2000);
    }
    
    if(btn) {
        btn.disabled = false;
        btn.innerText = "تست اتصال";
    }
    if (!window.isComboTestingAborted) {
        toast(`تست گروه کامل شد. ${healthyCount} سالم پیدا شد.`);
    }
}
function copyComboGroup(groupId) {
    const checkboxes = Array.from(document.querySelectorAll(`.node-check-${groupId}:checked`));
    let comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups") || "[]");
    const group = comboGroups.find(g => g.id === groupId);
    if(!group) return;
    
    const selectedNodes = checkboxes.map(cb => group.nodes[parseInt(cb.value)]);
    const healthy = selectedNodes.filter(n => n.healthy);
    const toCopy = healthy.length > 0 ? healthy : selectedNodes;
    
    if (toCopy.length === 0) {
        toast("هیچ کانفیگی برای کپی وجود ندارد");
        return;
    }
    
    const txt = toCopy.map(n => n.config).join("\n");
    navigator.clipboard.writeText(txt).then(() => {
        toast(`${toCopy.length} کانفیگ کپی شد!`);
    });
}

function exportComboGroup(groupId) {
    const checkboxes = Array.from(document.querySelectorAll(`.node-check-${groupId}:checked`));
    let comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups") || "[]");
    const group = comboGroups.find(g => g.id === groupId);
    if(!group) return;
    
    const selectedNodes = checkboxes.map(cb => group.nodes[parseInt(cb.value)]);
    const healthy = selectedNodes.filter(n => n.healthy);
    const toExport = healthy.length > 0 ? healthy : selectedNodes;
    
    if (toExport.length === 0) return;
    
    window.v2rayList = window.v2rayList || [];
    toExport.forEach(n => {
        let name = n.config;
        if(n.config.includes('#')) name = decodeURIComponent(n.config.split('#')[1] || '');
        
        let tagToAppend = '';
        if (group.metadata) {
            if (group.metadata.edgeUuid) tagToAppend = ' (Edge)';
            else if (group.metadata.zeusUrl) tagToAppend = ' (Zeus)';
            else if (group.metadata.isBpb) tagToAppend = ' (BPB)';
        }
        
        let lowerName = name.toLowerCase();
        let hasPanelTag = lowerName.includes('edge') || lowerName.includes('bpb') || lowerName.includes('zeus');
        
        let uri = n.config;
        
        if (!hasPanelTag && tagToAppend) {
            name = name + tagToAppend;
            if (uri.includes('#')) {
                uri = uri + encodeURIComponent(tagToAppend);
            } else {
                uri = uri + '#' + encodeURIComponent(name);
            }
        }

        // Tag as combined if not already tagged
        if (!name.toLowerCase().includes('ترکیب') && !name.toLowerCase().includes('combo')) {
            const comboTag = ' [ترکیب‌شده]';
            if (uri.includes('#')) {
                uri = uri + encodeURIComponent(comboTag);
            } else {
                uri = uri + '#' + encodeURIComponent(name + comboTag);
            }
            name = name + comboTag;
        }
        
        window.v2rayList.unshift({
            id: Date.now() + Math.random().toString(),
            uri: uri,
            name: name,
        });
    });
    if(typeof window.saveV2rayList === 'function') {
        window.saveV2rayList();
    }

    if(typeof renderV2rayList === 'function') {
        renderV2rayList();
    }
    
    toast(`${toExport.length} کانفیگ به پنل v2ray منتقل شد!`);
    closeCombinationCenter();
    if(typeof toggleLeftSidebar === 'function') {
        toggleLeftSidebar('v2ray');
    }
}


window.openComboModal = function(id) {
    const el = document.getElementById(id);
    if(el) {
        el.style.display = 'flex';
        el.classList.remove('hidden');
        setTimeout(() => {
            const content = document.getElementById(id + 'Content');
            if(content) {
                content.classList.remove('scale-95', 'opacity-0');
                content.classList.add('scale-100', 'opacity-100');
            }
        }, 10);
    }
}

window.closeComboModal = function(id) {
    const el = document.getElementById(id);
    if(el) {
        const content = document.getElementById(id + 'Content');
        if(content) {
            content.classList.remove('scale-100', 'opacity-100');
            content.classList.add('scale-95', 'opacity-0');
        }
        setTimeout(() => {
            el.style.display = 'none';
            el.classList.add('hidden');
        }, 300);
    }
}

window.askDeleteComboGroup = function(groupId) {
    const btn = document.getElementById('btn-confirm-delete-combo');
    btn.onclick = function() {
        closeComboModal('deleteComboModal');
        deleteComboGroup(groupId);
    };
    document.getElementById('deleteComboModalDesc').innerText = 'آیا از حذف این گروه کانفیگ مطمئن هستید؟';
    openComboModal('deleteComboModal');
}

window.askClearComboHistory = function() {
    const btn = document.getElementById('btn-confirm-delete-combo');
    btn.onclick = function() {
        closeComboModal('deleteComboModal');
        PersistentStorage.removeItem("ipscanner_combo_groups");
        renderComboGroups();
        document.getElementById("combo-archive-section").style.display = "none";
    };
    document.getElementById('deleteComboModalDesc').innerText = 'آیا از حذف تمامی تاریخچه ترکیبات اطمینان دارید؟ این عملیات غیرقابل بازگشت است.';
    openComboModal('deleteComboModal');
}

/**
 * «بروز رسانی ساب» یعنی آی‌پی‌های تمیزِ سالم را به کاربر زئوس بدهیم، نه فرستادن متنِ
 * کانفیگ‌ها.
 *
 * قبلاً این تابع به `/api/users/<user>/configs` پست می‌کرد — چنین مسیری اصلاً در ورکر
 * زئوس وجود ندارد؛ درخواست به شاخه‌ی «ساخت کاربر» می‌افتاد و با ۴۰۰ برمی‌گشت، ولی دکمه
 * در هر حال «آپدیت موفق» نشان می‌داد. زئوس ساب را خودش از روی `ips` و `port` کاربر
 * می‌سازد، پس راه درست همین دو فیلد است.
 *
 * PUT زئوس کل رکورد را بازنویسی می‌کند (همه‌ی ستون‌ها در یک UPDATE ست می‌شوند)، بنابراین
 * اول کاربر فعلی خوانده می‌شود و فقط ip/port رویش سوار می‌شود؛ وگرنه حجم، انقضا،
 * فینگرپرینت و بقیه‌ی تنظیمات کاربر پاک می‌شد.
 */
window.updateZeusSubLink = async function(groupId) {
    let comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups") || "[]");
    const group = comboGroups.find(g => g.id === groupId);
    if (!group || !group.metadata || !group.metadata.zeusUsername) return;

    const healthyNodes = group.nodes.filter(n => n.healthy);
    if (healthyNodes.length === 0) {
        return toast("هیچ کانفیگ سالمی در این گروه وجود ندارد. ابتدا تست اتصال انجام دهید.");
    }

    const btn = document.getElementById(`btn-zeus-${groupId}`);
    const restoreBtn = (label) => {
        if (!btn) return;
        btn.disabled = false;
        btn.innerHTML = label;
        setTimeout(() => {
            btn.innerHTML = `<i class="ph-bold ph-cloud-arrow-up"></i> بروز رسانی ساب ${group.metadata.zeusUsername}`;
        }, 3000);
    };
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> در حال ارسال...';
    }

    try {
        if (typeof window.callZeusProxy !== 'function') throw new Error("تابع ارتباطی زئوس یافت نشد.");

        let accounts = JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]');
        let zeusAcc = accounts.find(a => a.id === group.metadata.zeusAccId);
        if (!zeusAcc) throw new Error("اکانت زئوس پیدا نشد.");
        const acc = { ...zeusAcc, url: zeusAcc.zeusUrl || group.metadata.zeusUrl };
        const username = group.metadata.zeusUsername;

        const ips = [];
        const ports = [];
        healthyNodes.forEach(n => {
            if (n.ip && !ips.includes(n.ip)) ips.push(n.ip);
            try {
                const p = new URL(n.config).port;
                if (p && !ports.includes(p)) ports.push(p);
            } catch (e) {}
        });
        if (!ips.length) throw new Error("آی‌پی تمیزی در کانفیگ‌های سالم پیدا نشد.");

        const listData = await window.callZeusProxy(acc, '/api/users?t=' + Date.now());
        const current = (listData.users || []).find(u => u.username === username);
        if (!current) throw new Error(`کاربر «${username}» در پنل پیدا نشد.`);

        await window.callZeusProxy(acc, `/api/users/${encodeURIComponent(username)}`, 'PUT', {
            username: current.username,
            limit_gb: current.limit_gb,
            expiry_days: current.expiry_days,
            limit_req: current.limit_req,
            ips: ips.join('\n'),
            tls: ports.some(p => ['443', '2053', '2083', '2087', '2096', '8443'].includes(String(p))) ? 'on' : 'off',
            port: (ports.length ? ports : ['443']).join(','),
            fingerprint: current.fingerprint || 'chrome',
            ip_limit: current.ip_limit,
            block_porn: current.block_porn,
            block_ads: current.block_ads,
            frag_len: current.frag_len,
            frag_int: current.frag_int,
            user_proxy_iata: current.user_proxy_iata,
            user_socks5: current.user_socks5,
            user_proxy_ip: current.user_proxy_ip,
            auto_reset_vol_days: current.auto_reset_vol_days,
            auto_reset_req_days: current.auto_reset_req_days,
            auto_rotate_ip: current.auto_rotate_ip,
            rotate_time: current.rotate_time,
            ip_operator: current.ip_operator,
            ip_count: current.ip_count,
            auto_rotate_user_proxy: current.auto_rotate_user_proxy
        });

        toast(`ساب کاربر ${username} با ${ips.length} آی‌پی تمیز بروزرسانی شد`);
        restoreBtn('<i class="ph-bold ph-check-circle text-mv-green-ink"></i> آپدیت موفق');
    } catch(e) {
        toast("خطا در بروزرسانی زئوس: " + e.message);
        restoreBtn('<i class="ph-bold ph-x-circle text-mv-red-ink"></i> ناموفق');
    }
};

window.updateEdgeSubLink = async function(groupId) {
    let comboGroups = JSON.parse(PersistentStorage.getItem("ipscanner_combo_groups") || "[]");
    const group = comboGroups.find(g => g.id === groupId);
    if (!group || !group.metadata || !group.metadata.edgeUuid) return;

    const healthyNodes = group.nodes.filter(n => n.healthy);
    if (healthyNodes.length === 0) {
        return toast("هیچ کانفیگ سالمی در این گروه وجود ندارد. ابتدا تست اتصال انجام دهید.");
    }

    const btn = document.getElementById(`btn-edge-${groupId}`);
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> در حال ارسال...';
    }

    try {
        const configsText = healthyNodes.map(n => n.config).join('\n');
        
        let edgeAccounts = JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]');
        let edgeAcc = edgeAccounts.find(a => a.id === group.metadata.edgeAccId);
        if (!edgeAcc) throw new Error("اکانت Edge پیدا نشد.");

        const apiUrl = edgeAcc.edgeUrl.endsWith('/') ? edgeAcc.edgeUrl + 'api/manage?action=update_configs' : edgeAcc.edgeUrl + '/api/manage?action=update_configs';
        const adminToken = edgeAcc.edgeUuid || edgeAcc.uuid || 'admin';
        
        const res = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': adminToken
            },
            body: JSON.stringify({
                uuid: group.metadata.edgeUuid,
                configs: configsText
            })
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(txt || 'خطای سرور');
        }

        const data = await res.json();
        if(data.error) throw new Error(data.error);

        toast("ساب لینک کاربر Edge با " + healthyNodes.length + " کانفیگ بروزرسانی شد!");
    } catch(e) {
        toast("خطا در بروزرسانی Edge: " + e.message);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = `<i class="ph-bold ph-check-circle text-mv-green-ink"></i> آپدیت موفق`;
            setTimeout(() => {
                btn.innerHTML = `<i class="ph-bold ph-cloud-arrow-up"></i> بروز رسانی ساب Edge`;
            }, 3000);
        }
    }
};



window.renderIpGroups = function() {
    const list = document.getElementById('combo-ip-groups-list');
    if (!list) return;
    
        const hist = JSON.parse(PersistentStorage.getItem('ipscanner_history') || '[]');
    const groupsWithIps = hist.filter(h => h.results && h.results.some(r => r.alive || r.realDelay > 0));
    // Unticked unless the user ticked it: until this list came back, combining used the
    // archive alone, and ticking every scan in the history by default would multiply that.
    const keep = new Set(Array.from(list.querySelectorAll('.ip-group-checkbox:checked')).map(cb => cb.value));
    
    const countEl = document.getElementById('ip-groups-count');
    if (countEl) countEl.innerText = groupsWithIps.length + ' گروه';
    
    if (groupsWithIps.length === 0) {
                list.innerHTML = '<div class="cc-empty">در تاریخچه‌ی اسکن گروهی با آی‌پی سالم نیست.</div>';
        return;
    }
    
    let html = '';
    groupsWithIps.forEach((group, index) => {
        const healthyCount = group.results.filter(r => r.alive || r.realDelay > 0 || r.ip).length;
        const dateStr = group.date || 'نامشخص';
        const timeStr = group.time || 'نامشخص';
        
                html += `
        <label class="mv-row cc-row">
            <input type="checkbox" class="md-checkbox ip-group-checkbox" value="${group.id}" ${keep.has(group.id) ? 'checked' : ''} onchange="comboIpGroupsChanged()">
            <div class="mv-row-text">اسکن ${dateStr} — ${timeStr}<small>${healthyCount} آی‌پی سالم</small></div>
            <div class="mv-row-end">
                <button type="button" class="mv-btn mv-btn--icon" onclick="copyIpGroup('${group.id}')" title="کپی آی‌پی‌ها" aria-label="کپی آی‌پی‌ها"><i class="ph ph-copy"></i></button>
                <button type="button" class="mv-btn mv-btn--icon" onclick="openRetestModal('${group.id}')" title="تست مجدد" aria-label="تست مجدد"><i class="ph ph-lightning"></i></button>
                <button type="button" class="mv-btn mv-btn--icon" onclick="deleteIpGroup('${group.id}')" title="حذف گروه" aria-label="حذف گروه"><i class="ph ph-trash"></i></button>
            </div>
        </label>`;
    });
    
    list.innerHTML = html;
};

window.copyIpGroup = function(id) {
    const hist = JSON.parse(PersistentStorage.getItem('ipscanner_history') || '[]');
    const group = hist.find(h => h.id === id);
    if (!group) return;
    const cleanIps = group.results.filter(r => r.alive || r.realDelay > 0 || r.ip).map(r => r.ip);
    navigator.clipboard.writeText(cleanIps.join('\n')).then(() => {
        if(typeof toast === 'function') toast('آی‌پی‌های گروه کپی شدند');
    });
};

window.deleteIpGroup = function(id) {
    let hist = JSON.parse(PersistentStorage.getItem('ipscanner_history') || '[]');
    hist = hist.filter(h => h.id !== id);
    PersistentStorage.setItem('ipscanner_history', JSON.stringify(hist));
    renderIpGroups();
    if(typeof updateComboCalc === 'function') updateComboCalc();
};

window._currentRetestGroupId = null;
window._retestFailedIps = [];
window._retestSuccessIps = [];

window.openRetestModal = function(id) {
    window._currentRetestGroupId = id;
    document.getElementById('retest-config-input').value = '';
    document.getElementById('retest-config-modal').classList.remove('hidden');
};

window.closeRetestModal = function() {
    window._currentRetestGroupId = null;
    document.getElementById('retest-config-modal').classList.add('hidden');
};

window.submitRetestConfig = async function() {
    const configStr = document.getElementById('retest-config-input').value.trim();
    if (!configStr.startsWith('vless://') && !configStr.startsWith('vmess://') && !configStr.startsWith('trojan://')) {
        if(typeof toast === 'function') toast('لطفا یک کانفیگ معتبر وارد کنید');
        return;
    }
    
    const hist = JSON.parse(PersistentStorage.getItem('ipscanner_history') || '[]');
    const group = hist.find(h => h.id === window._currentRetestGroupId);
    if (!group) return;
    
    const cleanIps = group.results.filter(r => r.alive || r.realDelay > 0 || r.ip).map(r => r.ip);
    if (cleanIps.length === 0) {
        if(typeof toast === 'function') toast('این گروه آی‌پی سالمی ندارد');
        return;
    }
    
    closeRetestModal();
    if(typeof closeCombinationCenter === 'function') closeCombinationCenter();
    
    if(typeof toast === 'function') toast('تست مجدد آی‌پی‌ها آغاز شد...');
    
    const btnText = document.getElementById('btn-scan-text');
    if (btnText) btnText.innerText = 'تست مجدد...';
    
    let modifiedConfigs = [];
    cleanIps.forEach(ip => {
        let modified = configStr.replace(/@([a-zA-Z0-9.-]+):(\d+)/, "@" + ip + ":$2");
        if (modified.includes('?')) {
            modified = modified.replace(/sni=[^&#]*/, "sni=" + ip);
        }
        modifiedConfigs.push({ id: ip, config: modified, ip: ip });
    });
    
    window._retestFailedIps = [];
    window._retestSuccessIps = [];
    
    try {
        const response = await fetch('/api/v2ray/test-nodes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ nodes: modifiedConfigs })
        });
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            
            for (const line of lines) {
                if (line.trim()) {
                    const data = JSON.parse(line);
                    
                    const progressEl = document.getElementById('footer-progress-bar');
                    const textEl = document.getElementById('footer-status-text');
                    if (progressEl && data.total) {
                        const pct = Math.round((data.progress / data.total) * 100);
                        progressEl.style.width = pct + '%';
                        if (textEl) textEl.innerText = `در حال تست: ${data.progress} از ${data.total} (${pct}%)`;
                    }
                    
                    if (data.nodeId) {
                        if (data.alive) {
                            window._retestSuccessIps.push(data.nodeId);
                        } else {
                            window._retestFailedIps.push(data.nodeId);
                        }
                    }
                }
            }
        }
        
        if (btnText) btnText.innerText = 'شروع اسکن';
        const progressEl = document.getElementById('footer-progress-bar');
        if (progressEl) progressEl.style.width = '0%';
        const textEl = document.getElementById('footer-status-text');
        if (textEl) textEl.innerText = 'آماده برای اسکن...';
        
        if(typeof openCombinationCenter === 'function') openCombinationCenter();
        document.getElementById('retest-confirm-msg').innerText = `تست به پایان رسید. ${window._retestFailedIps.length} آی‌پی از ${cleanIps.length} آی‌پی ناسالم تشخیص داده شد. آیا مایل به حذف آی‌پی‌های ناسالم از این گروه هستید؟`;
        document.getElementById('retest-confirm-modal').classList.remove('hidden');
        
    } catch (e) {
        if(typeof toast === 'function') toast('خطا در تست آی‌پی‌ها');
        if (btnText) btnText.innerText = 'شروع اسکن';
    }
};

window.finishRetest = function(shouldDelete) {
    if (shouldDelete) {
        let hist = JSON.parse(PersistentStorage.getItem('ipscanner_history') || '[]');
        const groupIndex = hist.findIndex(h => h.id === window._currentRetestGroupId);
        if (groupIndex !== -1) {
            hist[groupIndex].results.forEach(r => {
                if (window._retestFailedIps.includes(r.ip)) {
                    r.alive = false;
                    r.realDelay = -1;
                }
            });
            PersistentStorage.setItem('ipscanner_history', JSON.stringify(hist));
            if(typeof toast === 'function') toast('آی‌پی‌های ناسالم از گروه حذف شدند.');
        }
    } else {
        if(typeof toast === 'function') toast('تغییری در گروه ایجاد نشد.');
    }
    
    document.getElementById('retest-confirm-modal').classList.add('hidden');
    renderIpGroups();
    if(typeof updateComboCalc === 'function') updateComboCalc();
};
