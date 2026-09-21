let speedtestActive = false;

window.formatBytes = function(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

// ===== State =====
let tabs = [];
let activeTabId = null;
let tabIdCounter = 0;
let ws = null;
let currentTheme = localStorage.getItem('scanner-theme') || 'macDark';

function $(id) { return document.getElementById(id); }
function toast(msg, dur = 2500) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), dur);
}
function fallbackCopy(text) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed';
    document.body.appendChild(ta); ta.focus(); ta.select();
    console.log("5"); try { document.execCommand('copy'); toast('📋 کپی شد') } catch (e) { toast('❌ خطا') }
    document.body.removeChild(ta);
}
function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(() => toast('📋 کپی شد')).catch(() => fallbackCopy(text));
    else fallbackCopy(text);
}
function dlFile(name, content, type = 'text/plain') {
    const b = new Blob([content], { type }), u = URL.createObjectURL(b), a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(u), 1000);
}

// ===== Default Settings =====
function defaultSettings() {
    return {
        cdns: ['cloudflare'],
        ports: [443],
        concurrency: 50,
        timeout: 5000,
        maxIps: 400,
        isp: '',
        customInput: ''
    };
}

// ===== Tab Management =====
function createTab(ispName, settings) {
    const id = ++tabIdCounter;
    const s = settings || defaultSettings();
    const tab = {
        id, isp: ispName || 'Scan ' + id,
        settings: { ...s },
        results: [], state: 'idle',
        total: 0, tested: 0, alive: 0, dead: 0,
        // The default used to be http.latency — a column the table has never shown, so the first
        // sort a user saw was by a number they could not see. Sort by the figure that decides
        // whether an address is worth keeping.
        sortCol: 'realDelay', sortAsc: true
    };
    tabs.push(tab);
    renderTabs(); switchTab(id);
    return tab;
}

function duplicateTab() {
    const src = getActiveTab();
    if (!src) { promptNewTab(); return; }
    createTab(src.isp + ' (کپی)', { ...src.settings, customInput: src.settings.customInput });
}

function promptNewTab() {
    createTab('اسکن ' + (tabIdCounter + 1), defaultSettings());
}

/**
 * There is always one scan open.
 *
 * The old page started on an empty state with no tab at all, which meant the first thing a new
 * user saw was a page where every control was disabled and the button said «تبی برای اسکن نیست».
 */
function ensureTab() {
    const real = tabs.filter(t => t && t.id !== 'settings' && !t.type);
    if (real.length) {
        if (!getActiveTab() || getActiveTab().id === 'settings') switchTab(real[0].id);
        return real[0];
    }
    return createTab('اسکن ۱', defaultSettings());
}
window.ensureTab = ensureTab;

function closeTab(id) {
    const idx = tabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    if (tabs[idx].state === 'running') { toast('❌ ابتدا اسکن را متوقف کنید'); return }
    tabs.splice(idx, 1);
    if (activeTabId === id) activeTabId = tabs.length ? tabs[Math.max(0, idx - 1)].id : null;
    renderTabs(); renderActiveTab();
}

function switchTab(id) {
    if (window.isSidebarMaximized && typeof toggleMaximizeSidebar === 'function') {
        toggleMaximizeSidebar();
    }
    activeTabId = id; renderTabs(); 
    if (id !== 'settings') loadTabSettings(); 
    renderActiveTab();
}

function prevTab() {
    if (!tabs.length) return;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    if (idx > 0) switchTab(tabs[idx - 1].id);
    else switchTab(tabs[tabs.length - 1].id);
}

function nextTab() {
    if (!tabs.length) return;
    const idx = tabs.findIndex(t => t.id === activeTabId);
    if (idx < tabs.length - 1) switchTab(tabs[idx + 1].id);
    else switchTab(tabs[0].id);
}

function getActiveTab() { return tabs.find(t => t.id === activeTabId); }

function renderTabs() {
    // The scans live in the scan page's own sidebar now (components/scan.js). The old strip is
    // still painted for the other tab types, and for «چیدمان قدیمی» where there is no sidebar.
    if (typeof window.scanRenderSideTabs === 'function') window.scanRenderSideTabs();
    const bar = $('tabs-bar');
    if (!bar) return;
    let html = '';
    tabs.forEach(t => {
        const isActive = t.id === activeTabId;
        const idArg = typeof t.id === 'string' ? `'${t.id}'` : t.id;
        
        let iconSvg = '<svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>';
        if (t.id === 'settings') iconSvg = '<svg style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09c-.658.003-1.25.396-1.51 1z"></path></svg>';
        else if (t.state === 'running') iconSvg = '<svg class="animate-spin text-gs-primary" style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="2" x2="12" y2="6"></line><line x1="12" y1="18" x2="12" y2="22"></line><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"></line><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"></line><line x1="2" y1="12" x2="6" y2="12"></line><line x1="18" y1="12" x2="22" y2="12"></line><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"></line><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"></line></svg>';
        else if (t.state === 'done') iconSvg = '<svg class="text-gs-success" style="width:14px;height:14px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>';

        // IDE-style pills: the active tab is a filled rounded chip, the rest are
        // plain text until hovered. RTL stays as-is — only the shape changed.
        html += `<div onclick="switchTab(${idArg})" draggable="true" data-tab-id="${t.id}" dir="rtl"
                class="ws-tab group ${isActive ? 'is-active' : ''}">
                <div class="ws-tab-icon shrink-0">${iconSvg}</div>
                <span class="ws-tab-label">${t.isp}</span>
                <button onclick="event.stopPropagation();closeTab(${idArg})" class="ws-tab-close" title="بستن"><svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"></line><line x1="8" y1="2" x2="2" y2="8"></line></svg></button>
            </div>`;
    });
    bar.innerHTML = html;
    if (typeof wireTabDrag === 'function') wireTabDrag(bar);
}

// ===== Save/Load tab settings from sidebar =====
function saveTabSettings() {
    const tab = getActiveTab(); if (!tab) return;
    tab.settings.cdns = getSelectedCdns();
    tab.settings.ports = getSelectedPorts();
    
    const newConc = +$('param-conc').value || 50;
    if (tab.settings.concurrency !== newConc && tab.state === 'running') {
        fetch('/api/scan/concurrency', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ concurrency: newConc })
        }).catch(e => {});
        termLog(`> ⚡ همزمانی به ${newConc} تغییر یافت.`);
    }
    tab.settings.concurrency = newConc;
    
    tab.settings.timeout = +$('param-tout').value || 5000;
    const isScanAll = $('chk-scan-all') && $('chk-scan-all').checked;
    tab.settings.maxIps = isScanAll ? 50000000 : (+$('param-max').value || 400);
    tab.settings.isp = $('param-isp').value.trim() || tab.isp;
    tab.settings.customInput = $('ip-textarea').value;
    tab.settings.finalTestCount = +$('param-final-count')?.value || 50;
    tab.isp = tab.settings.isp;
}

function loadTabSettings() {
    try {
        const tab = getActiveTab(); if (!tab) return;
        const s = tab.settings;
        if (!s) return;
        
        const cdns = s.cdns || [];
        const ports = s.ports || [];
        
        // CDNs
        if ($('chk-cf')) $('chk-cf').checked = cdns.includes('cloudflare');
        if ($('chk-ak')) $('chk-ak').checked = cdns.includes('akamai');
        if ($('chk-fl')) $('chk-fl').checked = cdns.includes('fastly');
        if ($('chk-aws')) $('chk-aws').checked = cdns.includes('cloudfront');
        if ($('chk-goog')) $('chk-goog').checked = cdns.includes('google');
        if ($('chk-az')) $('chk-az').checked = cdns.includes('azure');
        if ($('chk-gc')) $('chk-gc').checked = cdns.includes('gcore');
        if ($('chk-warp-main')) $('chk-warp-main').checked = cdns.includes('warp_main');
        if ($('chk-warp-alt')) $('chk-warp-alt').checked = cdns.includes('warp_alt');
        if ($('chk-warp-ipv6')) $('chk-warp-ipv6').checked = cdns.includes('warp_ipv6');
        
        // Ports
        document.querySelectorAll('.port-chk').forEach(c => { c.checked = ports.includes(+c.value) });
        
        // Params
        if ($('param-conc')) $('param-conc').value = s.concurrency || 50;
        if ($('param-tout')) $('param-tout').value = s.timeout || 5000;

        if ($('param-max')) $('param-max').value = s.maxIps || 400;
        if ($('chk-scan-all')) {
            $('chk-scan-all').checked = (s.maxIps > 50000000);
        }
        if ($('param-isp')) $('param-isp').value = s.isp || tab.isp || '';
        if ($('ip-textarea')) $('ip-textarea').value = s.customInput || '';
        // Both of these were written by saveTabSettings and never read back, so switching scans
        // silently lost them.
        if ($('param-final-count')) $('param-final-count').value = s.finalTestCount || 50;
        if ($('chk-none')) $('chk-none').checked = !(s.cdns && s.cdns.length);
        if (typeof window.scanSyncScanAll === 'function') window.scanSyncScanAll();
    } catch (err) {
        console.error('Error loading tab settings:', err);
    }
}

// ===== Rendering =====
function renderActiveTab() {
    const tab = getActiveTab();
    // The scan page is hidden up front and turned back on by the one branch that owns it, so a
    // branch added later cannot forget it and leave two panels stacked (see the note below).
    if ($('scan-root')) $('scan-root').style.display = 'none';
    if (!tab) {
        // With ensureTab() there is always a scan open; this is the defensive path only.
        if ($('scan-root')) $('scan-root').style.display = 'flex';
        if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'none';
        if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'none';
        if ($('top-nav-container')) $('top-nav-container').style.display = 'none';
        updateStats(null); updateBreadcrumb('—');
        if (typeof window.scanPaint === 'function') window.scanPaint();
        if (typeof window.renderResults === 'function') window.renderResults(null);
        return;
    }
    if (tab.id === 'settings') {
        if ($('fixed-ip-root')) $('fixed-ip-root').style.display = 'none'; // settings
        if ($('dns-clean-root')) $('dns-clean-root').style.display = 'none';
        if ($('net-diag-root')) $('net-diag-root').style.display = 'none';
        if ($('changelog-root')) $('changelog-root').style.display = 'none';
        if ($('guide-root')) $('guide-root').style.display = 'none';
        if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'none';
        if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'flex';
        if ($('top-nav-container')) $('top-nav-container').style.display = 'flex';
        updateStats(null); updateBreadcrumb('تنظیمات'); return;
    }
    
    
    
    if (tab.type === 'fixed-ip') {
        if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'none';
        if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'flex';
        if ($('top-nav-container')) $('top-nav-container').style.display = 'flex';
        
        if (typeof renderFixedIpTab === 'function') renderFixedIpTab();
        return;
    }

    if (tab.type === 'dns-clean') {
        if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'none';
        if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'flex';
        if ($('top-nav-container')) $('top-nav-container').style.display = 'flex';
        if ($('fixed-ip-root')) $('fixed-ip-root').style.display = 'none';
        if ($('changelog-root')) $('changelog-root').style.display = 'none';
        if ($('net-diag-root')) $('net-diag-root').style.display = 'none';

        if (typeof renderDnsCleanTab === 'function') renderDnsCleanTab();
        return;
    }

    // «دیاگ اینترنت» — same shape as the DNS panel above: a full tab, its own root element,
    // and every sibling root hidden explicitly. This function hides siblings by name rather
    // than clearing the container, so a branch that forgets one leaves two panels stacked on
    // top of each other.
    if (tab.type === 'net-diag') {
        if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'none';
        if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'flex';
        if ($('top-nav-container')) $('top-nav-container').style.display = 'flex';
        if ($('fixed-ip-root')) $('fixed-ip-root').style.display = 'none';
        if ($('changelog-root')) $('changelog-root').style.display = 'none';
        if ($('dns-clean-root')) $('dns-clean-root').style.display = 'none';
        if ($('net-diag-root')) $('net-diag-root').style.display = 'none';
        if ($('guide-root')) $('guide-root').style.display = 'none';

        if (typeof renderNetDiagTab === 'function') renderNetDiagTab();
        return;
    }

    if (tab.type === 'changelog') {
        if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'none';
        if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'flex';
        if ($('top-nav-container')) $('top-nav-container').style.display = 'flex';
        if ($('fixed-ip-root')) $('fixed-ip-root').style.display = 'none';
        if ($('dns-clean-root')) $('dns-clean-root').style.display = 'none';
        if ($('net-diag-root')) $('net-diag-root').style.display = 'none';
        if ($('guide-root')) $('guide-root').style.display = 'none';

        if (typeof renderChangelogTab === 'function') renderChangelogTab();
        return;
    }

    if (tab.type === 'guide') {
        if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'none';
        if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'flex';
        if ($('top-nav-container')) $('top-nav-container').style.display = 'flex';
        if ($('fixed-ip-root')) $('fixed-ip-root').style.display = 'none';
        if ($('dns-clean-root')) $('dns-clean-root').style.display = 'none';
        if ($('net-diag-root')) $('net-diag-root').style.display = 'none';
        if ($('changelog-root')) $('changelog-root').style.display = 'none';
        if ($('guide-root')) $('guide-root').style.display = 'none';

        if (typeof renderGuideTab === 'function') renderGuideTab();
        return;
    }

    
    // Normal Scan Tab — the page kit page (components/scan.js). The legacy tab chrome stays in
    // the DOM because the other tab types are still built inside it, but the scanner no longer
    // uses it: its own sidebar carries the scans and the sections.
    if ($('fixed-ip-root')) $('fixed-ip-root').style.display = 'none';
    if ($('dns-clean-root')) $('dns-clean-root').style.display = 'none';
    if ($('net-diag-root')) $('net-diag-root').style.display = 'none';
    if ($('changelog-root')) $('changelog-root').style.display = 'none';
    if ($('guide-root')) $('guide-root').style.display = 'none';
    if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'none';
    if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'none';
    if ($('top-nav-container')) $('top-nav-container').style.display = 'none';
    if ($('scan-root')) $('scan-root').style.display = 'flex';

    loadTabSettings();
    updateStats(tab); updateBreadcrumb(tab.isp || '—'); renderResults(tab); updateProgress(tab);
    if (typeof window.scanSyncScanAll === 'function') window.scanSyncScanAll();
}

// Called by shell/apps.js › restoreCrumb() every time a page window opens, so it must survive
// the scan page no longer using the breadcrumb bar.
function updateBreadcrumb(name) { const el = $('breadcrumb-name'); if (el) el.textContent = name; }

// ===== Sidebar =====
function toggleScan() {
    const tab = getActiveTab();
    if (!tab) { toast('❌ تبی برای اسکن نیست'); return; }
    if (tab.state === 'running') {
        stopScan();
    } else {
        startScan();
    }
}
async function restartScan() {
    const tab = getActiveTab();
    if (!tab) { toast('❌ تبی باز نیست'); return; }

    // Always force stop backend for fresh start
    try { 
        await fetch('/api/stop', { method: 'POST' }); 
        const rt = tabs.find(t=>t.state==='running'); 
        if(rt) rt.state='done'; 
        await new Promise(r=>setTimeout(r,300)); 
    } catch(e) {}

    // Reset state to force fresh start
    tab.state = 'idle';
    tab.tested = 0;
    tab.alive = 0;
    tab.dead = 0;
    tab.results = [];

    startScan(false);
}
async function startScan(isAutoResume = false) {
    let tab = getActiveTab(); if (!tab) { toast('❌ ابتدا تب باز کنید'); return }
    if (tab.state === 'running') { toast('❌ اسکن در حال اجراست'); return }
    let isResume = (isAutoResume === true) || ((tab.state === 'done' || tab.state === 'paused') && tab.tested > 0 && tab.tested < tab.total);

    if (!isResume) {
        saveTabSettings();
    }

    const ports = tab.settings.ports || []; 
    if (!ports.length) { toast('❌ حداقل یک پورت انتخاب کنید'); return }

    let customInput = tab.settings.customInput || '';
    const isScanAll = $('chk-scan-all') && $('chk-scan-all').checked;
    const cdnList = tab.settings.cdns || [];

    if (!isResume && !isScanAll && !customInput) {
        // BUILDING THE LIST IS A STAGE OF THE SCAN, NOT HOMEWORK.
        // It used to be a «دریافت» button the user had to find and press first; pressing start
        // without it just said «لیست آی‌پی خالی». The server can build the ranges from `cdns`
        // on its own, so there is nothing to ask for — the first step does it and says so.
        if (!cdnList.length) { toast('❌ یک منبع انتخاب کنید یا فهرست آی‌پی خودتان را بگذارید'); return }
        if (typeof window.scanSetFetching === 'function') window.scanSetFetching(true);
        let got = false;
        try { got = await fetchIps(); }
        finally { if (typeof window.scanSetFetching === 'function') window.scanSetFetching(false); }
        customInput = tab.settings.customInput || '';
        if (!got || !customInput) return;
    }
    if (!isResume && isScanAll && !cdnList.length && !customInput) { toast('❌ حداقل یک منبع انتخاب کنید'); return }

    if ($('network-isp-wrap')) {
        $('network-isp-wrap').style.display = 'flex';
        $('isp-status').textContent = 'WAIT';
        $('isp-status').className = 'text-gs-warning font-bold';
        $('isp-name').textContent = '...';
        $('isp-loc').textContent = '...';
        try {
            const ispRes = await fetch('/api/check-isp');
            const ispData = await ispRes.json();
            if (ispData.success) {
                const parts = ispData.isp.split(' - ');
                const ispName = parts[0] || 'Unknown';
                const loc = parts[1] || 'Unknown';
                $('isp-status').textContent = 'ONLINE';
                $('isp-status').className = 'text-gs-success font-bold';
                $('isp-name').textContent = ispName;
                $('isp-loc').textContent = loc;
                termLog('> [NETWORK] ISP: ' + ispName + ' | LOC: ' + loc + ' | IP: ' + ispData.ip);
            } else {
                $('isp-status').textContent = 'ERROR';
                $('isp-status').className = 'text-gs-danger font-bold';
                $('isp-name').textContent = 'N/A';
                $('isp-loc').textContent = 'N/A';
                toast('❌ بدون اینترنت یا عدم دسترسی!');
                // This is a genuine network failure rather than a validation error, so it is
                // one of the places «دیاگ اینترنت» is offered: the user has just been told the
                // line is dead and otherwise has nowhere to go with that.
                if (typeof window.ndOfferDiagnosis === 'function') window.ndOfferDiagnosis('شناسایی ISP انجام نشد');
                return;
            }
        } catch(e) {
            $('isp-status').textContent = 'ERROR';
            $('isp-status').className = 'text-gs-danger font-bold';
            $('isp-name').textContent = 'N/A';
            $('isp-loc').textContent = 'N/A';
            toast('❌ خطای اتصال به سرور اسکنر');
            if (typeof window.ndOfferDiagnosis === 'function') window.ndOfferDiagnosis('ارتباط با سرور اسکنر برقرار نشد');
            return;
        }
    }

    if (!isResume) {
        tab.results = []; tab.tested = 0; tab.alive = 0; tab.dead = 0; tab.stage3Total = 0; tab.stage3Tested = 0;
        // One history entry per scan: auto-save snapshots and the end-of-scan save share it.
        tab.historyKey = 'scan_' + Date.now();
    }
    // Settings › اسکن › «توقف هنگام قطعی اینترنت» (on unless the user switched it off).
    const pauseOnNetworkDown = !($('net-check-toggle') && !$('net-check-toggle').checked);
    tabs.forEach(t => { if (t.id !== tab.id && (t.state === 'running' || t.state === 'paused')) t.state = 'done'; });
    tab.state = 'running';
    renderTabs(); renderActiveTab(); updateProgress(tab);
    termLog('> ' + (isResume ? 'Resuming scan: ' : 'Starting scan: ') + tab.isp + ' | Ports: [' + ports.join(',') + ']');
    try {
        const res = await fetch('/api/scan', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pauseOnNetworkDown, resume: isResume, resumeTestedCount: tab.tested, resumeAliveCount: tab.alive, resumeDeadCount: tab.dead, cdns: tab.settings.cdns, concurrency: tab.settings.concurrency, timeout: tab.settings.timeout, maxIps: tab.settings.maxIps, ports, customInput, finalTestCount: tab.settings.finalTestCount, baseConfig: document.getElementById('v2ray-configs-input')?.value.split('\n').filter(l => l.trim())[0] || '' })
        });
        const d = await res.json(); 
        if (!res.ok) { 
            toast('❌ ' + (d.error || 'خطا')); 
            tab.state = (isResume ? 'paused' : 'idle');
            renderTabs(); updateProgress(tab); 
            return false; 
        }
        tab.total = d.total; updateStats(tab); updateProgress(tab);
        termLog('> Scanning ' + d.total + ' combos (' + d.ips + ' IPs × ' + d.ports + ' ports)');
        return true;
    } catch (e) { 
        toast('❌ خطا'); 
        tab.state = (isResume ? 'paused' : 'idle'); 
        renderTabs(); updateProgress(tab); 
        return false; 
    }
}
async function stopScan() {
    if (window._fixedIpsState && window._fixedIpsState.isTesting) {
        window._fixedIpsState.isTesting = false;
        const pc = document.getElementById('footer-progress-container');
        if(pc) pc.style.display = 'none';
        
        const testingCode = window._fixedIpsState.testingCountryCode;
        if (testingCode && window._fixedIpsState.countryDataCache[testingCode]) {
            window._fixedIpsState.countryDataCache[testingCode].forEach(ip => {
                if (ip.status === 'TESTING') ip.status = 'UNKNOWN';
            });
        }
        window._fixedIpsState.testingCountryCode = null;
        window._fixedIpsState.testSessionId = null;
        
        if (typeof renderFixedIpTab === 'function') renderFixedIpTab();
    }

    let tab = tabs.find(t => t.state === 'running' || t.state === 'paused') || getActiveTab();
        if (!tab || (tab.state !== 'running' && tab.state !== 'paused')) return;
    try { 
        await fetch('/api/stop', { method: 'POST' }); 
        tab.state = 'done'; 
        renderTabs(); 
        updateProgress(tab);
        termLog('> ⛔ Scan stopped.'); 
        toast('⏹ متوقف شد');
    } catch (e) { toast('❌ خطا') }
}

// ===== Export (per-tab) =====
function exportTxt() {
    const tab = getActiveTab(); if (!tab) return; const ok = tab.results.filter(r => r.alive && r.sniStatus !== false); if (!ok.length) { toast('❌ نتیجه‌ای نیست'); return }
    const m = new Map(); ok.forEach(r => { if (!m.has(r.ip)) m.set(r.ip, { ...r, allPorts: [r.port] }); else { const e = m.get(r.ip); if (!e.allPorts.includes(r.port)) e.allPorts.push(r.port); if (r.http.latency < e.http.latency) { e.http.latency = r.http.latency; e.http.speed = r.http.speed } } });
    let arr = Array.from(m.values()).sort((a, b) => (a.http.latency || 9999) - (b.http.latency || 9999));
    let t = `ISP: ${tab.isp}
${'='.repeat(65)}
` + 'IP Address'.padEnd(22) + 'Ports'.padEnd(16) + 'Ping'.padEnd(12) + 'Speed\n' + '-'.repeat(65) + '\n';
    arr.forEach(r => { t += r.ip.padEnd(22) + r.allPorts.join(',').padEnd(16) + (r.http.latency + ' ms').padEnd(12) + (r.http.speed || 0) + ' KB/s\n' });
    dlFile(`scan_${tab.isp}.txt`, t); toast('💾 TXT ذخیره شد');
}
function exportCsv() {
    const tab = getActiveTab(); if (!tab) return; const ok = tab.results.filter(r => r.alive && r.sniStatus !== false); if (!ok.length) { toast('❌ نتیجه‌ای نیست'); return }
    const h = 'IP,Port,TCP,TTFB,Speed,YT,TG,IG,XN\n'; const rows = ok.map(r => [r.ip, r.port, r.tcp?.latency, r.http?.latency, r.http?.speed, r.youtube?.connected ? 'Y' : 'N', r.telegram?.connected ? 'Y' : 'N', r.instagram?.connected ? 'Y' : 'N', r.xnxx?.connected ? 'Y' : 'N'].join(','));
    dlFile(`scan_${tab.isp}.csv`, h + rows.join('\n'), 'text/csv'); toast('📊 CSV ذخیره شد');
}
function exportJson() {
    const tab = getActiveTab(); if (!tab) return; const ok = tab.results.filter(r => r.alive && r.sniStatus !== false); if (!ok.length) { toast('❌ نتیجه‌ای نیست'); return }
    dlFile(`scan_${tab.isp}.json`, JSON.stringify(ok, null, 2), 'application/json'); toast('📋 JSON ذخیره شد');
}

function copyAllIps() {
    const tab = getActiveTab(); if (!tab) return; const ok = tab.results.filter(r => r.alive && r.sniStatus !== false); if (!ok.length) { toast('❌ نتیجه‌ای نیست'); return }
    copyText([...new Set(ok.map(r => r.ip))].join('\n'));
}

// The scan page's toolbar used to call four same-named-but-empty stubs of its own
// (results-table.js › exportCleanIps*), so COPY/TXT/CSV/JSON did nothing while the File menu's
// copies worked. One implementation, two names.
window.exportCleanIpsTxt = exportTxt;
window.exportCleanIpsCsv = exportCsv;
window.exportCleanIpsJson = exportJson;
window.copyCleanIps = copyAllIps;

/**
 * «بارگذاری فایل» — wired to the file input since the first version of the sidebar and never
 * written, so picking a file threw ReferenceError and nothing happened.
 */
window.handleFileUpload = function (event) {
    const file = event && event.target && event.target.files && event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const text = String(reader.result || '');
        // Accept anything that has addresses in it — one per line, comma separated, or a CSV
        // column — rather than demanding a particular file shape.
        const found = text.match(/\b\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?\b/g) || [];
        const uniq = [...new Set(found)];
        if (!uniq.length) { toast('❌ در این فایل آی‌پی‌ای پیدا نشد'); return; }
        const ta = $('ip-textarea');
        if (ta) ta.value = uniq.join('\n');
        const tab = getActiveTab();
        if (tab) tab.settings.customInput = uniq.join('\n');
        toast(`✅ ${uniq.length} آی‌پی از فایل خوانده شد`);
        if (typeof window.scanPaint === 'function') window.scanPaint();
    };
    reader.onerror = () => toast('❌ فایل خوانده نشد');
    reader.readAsText(file);
    event.target.value = '';
};

// ===== Terminal & Bottom Tabs =====
function termLog(msg) {
    const el = $('view-terminal'); const div = document.createElement('div');
    div.style.color = msg.includes('✅') ? 'var(--syn-green)' : msg.includes('⛔') ? 'var(--syn-red)' : 'var(--mv-label-2)';
    div.textContent = msg; el.appendChild(div); el.scrollTop = el.scrollHeight;
}

function toggleLeftSidebar(tabName) {
    const sb = $('left-sidebar');
    if (!tabName) {
        const isHidden = sb.style.display === 'none';
        if (!isHidden && window.isSidebarMaximized) {
            if (typeof toggleMaximizeSidebar === 'function') toggleMaximizeSidebar();
        }
        sb.style.display = isHidden ? 'flex' : 'none';
        if ($('ls-resizer')) $('ls-resizer').style.display = isHidden ? 'block' : 'none';
        
        if (!isHidden && typeof renderActiveTab === 'function') {
            renderActiveTab();
        }
        return;
    }
    
    // Check if the requested tab is already the active one and the sidebar is open
    let currentTab = null;
    ['sni', 'v2ray', 'cloud', 'sanction', 'dedidns', 'iran', 'fronting', 'aether', 'gst', 'vodi', 'github-tunnel', 'game', 'quick'].forEach(t => {
        const viewEl = $('ls-' + t);
        if (viewEl && viewEl.style.display !== 'none') {
            currentTab = t;
        }
    });

    if (sb.style.display !== 'none' && currentTab === tabName) {
        // Toggle OFF if clicking the same icon
        if (window.isSidebarMaximized) {
            if (typeof toggleMaximizeSidebar === 'function') toggleMaximizeSidebar();
        }
        sb.style.display = 'none';
        if ($('ls-resizer')) $('ls-resizer').style.display = 'none';
        if (typeof renderActiveTab === 'function') {
            renderActiveTab();
        }
        return;
    }

    sb.style.display = 'flex';
    if (!sb.dataset.resized && !window.isSidebarMaximized) {
        sb.style.width = '450px'; // Open to a reasonable width initially
    }
    if ($('ls-resizer')) $('ls-resizer').style.display = 'block';

    const titles = { 'sni': 'موتور ضد فیلتر (SNI)', 'v2ray': 'نودهای V2RAY', 'cloud': 'تنظیمات ساخت کانفیگ خودکار', 'sanction': 'تحریم شکن', 'dedidns': 'DNS اختصاصی', 'iran': 'کانفیگ ایران', 'fronting': 'دامین فرانتینگ', 'aether': 'ماسک، وایرگارد، وارپ در وارپ', 'gst': 'تونل گوگل اسکریپت', 'vodi': 'railway', 'github-tunnel': 'GitHub Tunnel', 'game': 'موتور مسیر بازی', 'quick': 'اتصال سریع' };
    if ($('left-sidebar-title')) $('left-sidebar-title').textContent = titles[tabName] || 'تنظیمات';

    ['sni', 'v2ray', 'cloud', 'sanction', 'dedidns', 'iran', 'fronting', 'aether', 'gst', 'vodi', 'github-tunnel', 'game', 'quick'].forEach(t => {
        const viewEl = $('ls-' + t);
        if (viewEl) {
            viewEl.style.display = t === tabName ? 'flex' : 'none';
        }
    });
}

function toggleBottomPanel(tabName) {
    if (window.isSidebarMaximized && typeof toggleMaximizeSidebar === 'function') toggleMaximizeSidebar();
    const tp = $('terminal-panel');

    // Clicking the icon of the view that is already showing closes the panel,
    // the way the rail buttons for the side panels behave.
    const isOpen = tp.style.display !== 'none';
    if (isOpen && window.activeBottomPanel === tabName) {
        tp.style.display = 'none';
        window.activeBottomPanel = null;
        return;
    }
    window.activeBottomPanel = tabName;
    tp.style.display = 'flex';

    const titles = { 'core': 'لاگ‌های هسته', 'monitor': 'مانیتورینگ مصرف', 'terminal': 'ترمینال اسکنر' };
    if ($('bottom-panel-title')) $('bottom-panel-title').textContent = titles[tabName] || 'ترمینال';

    ['core', 'monitor', 'terminal'].forEach(t => {
        const viewEl = $('view-' + t);
        if (viewEl) {
            viewEl.style.display = t === tabName ? (t === 'terminal' ? 'block' : 'flex') : 'none';
        }
    });
}

// Resizer logic
function initSidebarResizer() {
    const resizer = document.getElementById('ls-resizer');
    const sidebar = document.getElementById('left-sidebar');
    let isResizing = false;
    let startX, startW;

    if (resizer && sidebar) {
        resizer.addEventListener('mousedown', (e) => {
            isResizing = true;
            startX = e.clientX;
            startW = sidebar.offsetWidth;
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            // Depending on RTL and element placement, the resizer is at the right edge
            const dx = e.clientX - startX;
            let newWidth = startW + dx;
            
            if (newWidth < 250) newWidth = 250;
            const maxW = window.innerWidth - 300;
            if (newWidth > maxW) newWidth = maxW;
            
            sidebar.style.width = newWidth + 'px';
            sidebar.style.maxWidth = 'none';
            sidebar.dataset.resized = 'true';
        });

        document.addEventListener('mouseup', () => {
            if (isResizing) {
                isResizing = false;
                document.body.style.cursor = 'default';
            }
        });
    }
}
initSidebarResizer();

// ==== Terminal Resizer Logic ====
function initTerminalResizer() {
    const termResizer = document.getElementById('terminal-resizer');
    const termPanel = document.getElementById('terminal-panel');
    let isTermResizing = false;
    let termStartY, termStartH;

    if (termResizer && termPanel) {
        termResizer.addEventListener('mousedown', (e) => {
            isTermResizing = true;
            termStartY = e.clientY;
            termStartH = termPanel.offsetHeight;
            document.body.style.cursor = 'row-resize';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isTermResizing) return;
            const dy = termStartY - e.clientY; // e.clientY decreases when dragging UP
            let newH = termStartH + dy;
            
            if (newH < 40) newH = 40;
            const maxH = window.innerHeight - 80;
            if (newH > maxH) newH = maxH;
            
            termPanel.style.height = newH + 'px';
            termPanel.style.maxHeight = 'none'; // Overide CSS max-height during drag
        });

        document.addEventListener('mouseup', () => {
            if (isTermResizing) {
                isTermResizing = false;
                document.body.style.cursor = 'default';
            }
        });
    }
}
initTerminalResizer();

// ==== Maximize Terminal Logic ====
window.isTerminalMaximized = false;
let preMaxTermHeight = '300px';

function toggleMaximizeTerminal() {
    const tp = document.getElementById('terminal-panel');
    if (!tp) return;

    if (!window.isTerminalMaximized) {
        // Maximize
        preMaxTermHeight = tp.style.height;
        tp.style.height = '100%';
        tp.style.flex = '1';
        tp.style.maxHeight = 'none';
        
        if ($('editor-content-wrap')) $('editor-content-wrap').style.display = 'none';
        if ($('settings-tab-wrap')) $('settings-tab-wrap').style.display = 'none';
        
        window.isTerminalMaximized = true;
    } else {
        // Restore
        tp.style.height = preMaxTermHeight || '300px';
        tp.style.flex = 'none';
        window.isTerminalMaximized = false;
        
        // Restore visibility based on current active tab
        if (typeof renderActiveTab === 'function') {
            renderActiveTab();
        }
    }
}

window.closeTerminalPanel = function() {
    const tp = document.getElementById('terminal-panel');
    if (tp) {
        if (window.isTerminalMaximized) {
            toggleMaximizeTerminal(); // Un-maximize first
        }
        tp.style.display = 'none';
    }
};

// ==== Core Logs Actions ====
window.isLogPaused = false;
window.toggleLogPause = function() {
    window.isLogPaused = !window.isLogPaused;
    const btn = document.getElementById('btn-log-pause');
    if (btn) {
        btn.style.color = window.isLogPaused ? 'var(--syn-red)' : 'var(--syn-yellow)';
    }
    toast(window.isLogPaused ? 'لاگ‌ها متوقف شدند' : 'دریافت لاگ ادامه یافت');
};

window.copyLogs = function() {
    const logs = document.getElementById('core-logs');
    if (logs && logs.textContent) {
        navigator.clipboard.writeText(logs.textContent).then(() => {
            toast('✅ لاگ‌ها کپی شدند');
        });
    } else {
        toast('❌ لاگی برای کپی وجود ندارد');
    }
};

window.exportLogs = function() {
    const logs = document.getElementById('core-logs');
    if (logs && logs.textContent) {
        const blob = new Blob([logs.textContent], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `core_logs_${new Date().getTime()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        toast('✅ لاگ‌ها دانلود شدند');
    } else {
        toast('❌ لاگی برای دانلود وجود ندارد');
    }
};

window.clearCoreLogs = function() {
    const logs = document.getElementById('core-logs');
    if (logs) logs.textContent = '';
    toast('✅ لاگ‌ها پاک شدند');
};


// --- Auto Save Logic ---
window.autoSaveEnabled = localStorage.getItem('autoSaveEnabled') === 'true';

window.toggleAutoSave = function() {
    window.autoSaveEnabled = !window.autoSaveEnabled;
    localStorage.setItem('autoSaveEnabled', window.autoSaveEnabled);
    updateAutoSaveUI();
};

function updateAutoSaveUI() {
    const twin = document.getElementById('setting-autosave-enabled');
    if (twin) twin.checked = !!window.autoSaveEnabled;
    // The same switch on the scan page (components/scan.js › تنظیمات اسکن). Three places can
    // flip this now, so each one re-reads the value rather than tracking its own.
    const onPage = document.getElementById('scan-autosave');
    if (onPage) onPage.checked = !!window.autoSaveEnabled;
    const every = document.getElementById('autosave-interval-input');
    if (every) every.disabled = !window.autoSaveEnabled;
    const knob = document.getElementById('auto-save-knob');
    if(knob) {
        if(window.autoSaveEnabled) {
            knob.style.transform = 'translateX(12px)';
            knob.style.background = 'var(--m3-primary, #4ade80)';
        } else {
            knob.style.transform = 'translateX(0px)';
            knob.style.background = 'var(--ide-text-muted, #5c6370)';
        }
    }
}

document.addEventListener('DOMContentLoaded', updateAutoSaveUI);
// If DOM is already loaded, update immediately
if (document.readyState === 'interactive' || document.readyState === 'complete') {
    updateAutoSaveUI();
}


// ==========================================
// WORKERS MANAGER LOGIC
// ==========================================

window.toggleMainMenu = function() {
    const menu = document.getElementById('main-menu');
    const overlay = document.getElementById('main-menu-overlay');
    const btn = document.getElementById('btn-hamburger');
    if (!menu || !overlay || !btn) return;
    
    if (menu.classList.contains('hidden')) {
        const rect = btn.getBoundingClientRect();
        // Remove default fixed classes
        menu.classList.remove('top-12', 'right-4');
        menu.style.top = (rect.bottom + 10) + 'px';
        menu.style.left = rect.left + 'px';
        
        menu.classList.remove('hidden');
        overlay.classList.remove('hidden');
    } else {
        menu.classList.add('hidden');
        overlay.classList.add('hidden');
    }
};







// ==========================================
// STATIC IP TAB
// ==========================================
window._fixedIpsState = {
    countries: [],
    selectedCountry: null,
    countryDataCache: {}, // { "US": [ {ip, port, status}, ... ] }
    testingCountryCode: null,
    isTesting: false
};

const COUNTRY_NAMES_FA = {
    "AD": "آندورا", "AE": "امارات متحده عربی", "AL": "آلبانی", "AM": "ارمنستان", "AR": "آرژانتین",
    "AT": "اتریش", "AU": "استرالیا", "AZ": "آذربایجان", "BA": "بوسنی و هرزگوین", "BD": "بنگلادش",
    "BE": "بلژیک", "BG": "بلغارستان", "BH": "بحرین", "BR": "برزیل", "BY": "بلاروس",
    "CA": "کانادا", "CH": "سوئیس", "CL": "شیلی", "CN": "چین", "CO": "کلمبیا",
    "CY": "قبرس", "CZ": "جمهوری چک", "DE": "آلمان", "DK": "دانمارک", "DO": "جمهوری دومینیکن",
    "EE": "استونی", "EG": "مصر", "ES": "اسپانیا", "FI": "فنلاند", "FR": "فرانسه",
    "GB": "بریتانیا", "GE": "گرجستان", "GI": "جبل الطارق", "GR": "یونان", "HK": "هنگ کنگ",
    "HR": "کرواسی", "HU": "مجارستان", "ID": "اندونزی", "IE": "ایرلند", "IL": "اسرائیل",
    "IN": "هند", "IQ": "عراق", "IR": "ایران", "IS": "ایسلند", "IT": "ایتالیا",
    "JP": "ژاپن", "KE": "کنیا", "KG": "قرقیزستان", "KR": "کره جنوبی", "KW": "کویت",
    "KZ": "قزاقستان", "LI": "لیختن‌اشتاین", "LT": "لیتوانی", "LU": "لوکزامبورگ", "LV": "لتونی",
    "MA": "مراکش", "MD": "مولداوی", "MK": "مقدونیه", "MN": "مغولستان", "MU": "موریس",
    "MX": "مکزیک", "MY": "مالزی", "NG": "نیجریه", "NL": "هلند", "NO": "نروژ",
    "NP": "نپال", "NZ": "نیوزیلند", "PE": "پرو", "PH": "فیلیپین", "PK": "پاکستان",
    "PL": "لهستان", "PR": "پورتوریکو", "PT": "پرتغال", "QA": "قطر", "RO": "رومانی",
    "RS": "صربستان", "RU": "روسیه", "SA": "عربستان سعودی", "SC": "سیشل", "SE": "سوئد",
    "SG": "سنگاپور", "SI": "اسلوونی", "SK": "اسلواکی", "SY": "سوریه", "TF": "سرزمین‌های جنوبی فرانسه",
    "TH": "تایلند", "TR": "ترکیه", "TW": "تایوان", "UA": "اوکراین", "US": "ایالات متحده آمریکا",
    "UZ": "ازبکستان", "VN": "ویتنام", "ZA": "آفریقای جنوبی", "ZW": "زیمبابوه"
};

function getFlagEmoji(countryCode) {
    if (!countryCode || countryCode.length !== 2) return "🌍";
    const codePoints = countryCode
        .toUpperCase()
        .split('')
        .map(char => 127397 + char.charCodeAt(0));
    return String.fromCodePoint(...codePoints);
}

function getCountryName(code) {
    return COUNTRY_NAMES_FA[code.toUpperCase()] || code.toUpperCase();
}

window.openFixedIpTab = async function() {
    if (window.isSidebarMaximized && typeof toggleMaximizeSidebar === 'function') toggleMaximizeSidebar();
    
    const existingTab = tabs.find(t => t.type === 'fixed-ip');
    if (existingTab) {
        switchTab(existingTab.id);
        return;
    }
    
    const newId = 'tab_' + Date.now();
    const newTab = {
        id: newId,
        isp: 'انتخاب آیپی ثابت',
        state: 'done',
        type: 'fixed-ip',
        total: 0, tested: 0, alive: 0, dead: 0, results: [], settings: {}
    };
    tabs.push(newTab);
    switchTab(newId);
    
    const btnScan = document.getElementById('btn-tab-scan');
    if (btnScan) btnScan.click();
    
    if (window._fixedIpsState.countries.length === 0) {
        try {
            const res = await fetch('/assets/ip/countries.json');
            const list = await res.json();
            window._fixedIpsState.countries = list.map(code => ({
                code, name: getCountryName(code), flag: getFlagEmoji(code)
            })).sort((a, b) => a.name.localeCompare(b.name, 'fa'));
        } catch(e) {
            console.error(e);
        }
    }
    
    renderFixedIpTab();
};

// ── «آیپی لوکیشن» ────────────────────────────────────────────────────────────────
//
// The engine page (ui/page-kit.css › .mv-split + .mv-eng-*), the same one every other window
// wears. This one carries no traffic, so its round button is the one action it has: testing
// the addresses of the chosen country.

const FX_SECTIONS = [
    { id: 'ips', label: 'آی‌پی‌ها', icon: 'ph-fill ph-list-numbers', tint: 'var(--mv-pink, #FF2D55)' },
    { id: 'countries', label: 'کشورها', icon: 'ph-fill ph-globe-hemisphere-west', tint: 'var(--mv-blue)' },
];

window._fxSec = 'countries';
window._fxQuery = '';

function fxEsc(x) {
    return String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fxFa(n) { return String(n).replace(/[0-9]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]); }

function fxShell() {
    return `
<div class="mv-split" id="fx-split" dir="rtl">
  <aside class="mv-side" aria-label="بخش‌های آی‌پی لوکیشن">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="fx-ident"></div>
    <nav class="mv-side-list">
      <div class="mv-side-group">
        ${FX_SECTIONS.map((x) => `
        <button type="button" class="mv-side-item" data-fx-sec="${x.id}">
          <span class="mv-side-tile" style="--tint:${x.tint}"><i class="${x.icon}"></i></span><span>${x.label}</span>
        </button>`).join('')}
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="fx-back" aria-label="کشورها" title="کشورها"><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="fx-title">کشورها</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar" id="fx-scroll">
      <div class="mv-eng-sec" data-sec="ips">
        <div class="mv-eng-stage" id="fx-stage" style="--tint:var(--mv-pink, #FF2D55)"></div>
        <div class="mv-form" id="fx-ips"></div>
      </div>
      <div class="mv-eng-sec is-on" data-sec="countries">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">برای دیدن آی‌پی‌های یک کشور، رویش بزنید</div>
            <div style="padding:0 0 10px">
              <label class="mv-side-search" style="width:100%; margin:0"><i class="ph-bold ph-magnifying-glass"></i>
                <input id="fx-search" type="search" placeholder="جست‌وجوی کشور…" spellcheck="false" aria-label="جست‌وجوی کشور">
              </label>
            </div>
            <div id="fx-countries" class="mv-list"></div>
          </div>
        </div>
      </div>
    </div>

    <div class="mv-eng-foot" id="fx-foot"></div>
  </section>
</div>
<style>
  #fixed-ip-root { display:flex; flex-direction:column; min-height:0; }
  #fx-split { position:relative; z-index:0; flex:1 1 auto; min-height:0; color:var(--mv-label); }
  #fx-countries { display:grid; gap:2px; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); }
  #fx-countries .mv-li { border-radius:var(--mv-r-sm, 8px); cursor:pointer; }
  #fx-countries .mv-li + .mv-li::before { content:none; }
  #fx-countries .mv-li:hover { background:var(--mv-fill); }
  #fx-countries img { width:26px; height:auto; border-radius:3px; box-shadow:inset 0 0 0 var(--mv-hl) var(--mv-sep-2); }
  #fx-ip-list { display:grid; gap:2px; grid-template-columns:repeat(auto-fill, minmax(280px, 1fr)); }
  #fx-ip-list > .mv-form-row + .mv-form-row::before { content:none; }
  .fx-ip { font-family:var(--mv-font-tech, ui-monospace, monospace); font-variant-numeric:tabular-nums; font-size:13px; font-weight:600; }
  .fx-chip { display:inline-flex; align-items:center; gap:4px; font-size:10.5px; font-weight:600;
             padding:2px 8px; border-radius:999px; background:var(--mv-fill); color:var(--mv-label-2); }
  .fx-chip.is-green { background:color-mix(in srgb, var(--mv-green) 14%, transparent); color:var(--mv-green-ink); }
  .fx-chip.is-red { background:color-mix(in srgb, var(--mv-red) 14%, transparent); color:var(--mv-red-ink); }
</style>`;
}

function fxState() {
    const st = window._fixedIpsState;
    const c = st.selectedCountry;
    const ips = c ? (st.countryDataCache[c.code] || []) : [];
    const valid = ips.filter((x) => x.status === 'VALID').length;
    const invalid = ips.filter((x) => x.status === 'INVALID').length;
    const tested = valid + invalid;
    const testingHere = st.isTesting && st.testingCountryCode === (c && c.code);
    return { st, c, ips, valid, invalid, tested, testingHere };
}

function fxRenderIdent() {
    const host = $('fx-ident');
    if (!host) return;
    const v = fxState();
    const app = window.MV && MV.apps && MV.apps.get && MV.apps.get('fixedip');
    const icon = (app && MV.apps.iconHTML) ? MV.apps.iconHTML(app, 54)
        : '<span class="mv-side-tile" style="--tint:var(--mv-pink, #FF2D55)"><svg aria-hidden="true"><use href="#g-pin"/></svg></span>';
    host.innerHTML = `${icon}
      <b>آی‌پی لوکیشن</b>
      <small><i class="mv-eng-dot${v.testingHere ? ' is-busy' : v.valid ? ' is-on' : ''}"></i>${v.testingHere ? 'در حال تست' : v.valid ? fxFa(v.valid) + ' سالم' : 'آماده'}</small>`;
}

/** BUILT ONCE and then updated — replacing the node restarts the ring's animation. */
function fxRenderStage() {
    const host = $('fx-stage');
    if (!host) return;
    const v = fxState();
    const st = v.st;

    if (host.dataset.built !== '1') {
        host.innerHTML = `
      <div class="mv-eng-stage-text">
        <h1 data-part="head"></h1>
        <p data-part="line"></p>
      </div>
      <div class="mv-eng-power-wrap">
        <button type="button" class="mv-eng-power" data-fx-act="test" data-part="power">
          <i data-part="glyph"></i>
        </button>
      </div>`;
        host.dataset.built = '1';
    }

    const q = (n) => host.querySelector(`[data-part="${n}"]`);
    const busyElsewhere = st.isTesting && !v.testingHere;

    let head, line, tone;
    if (!v.c) {
        tone = 'off';
        head = 'یک کشور انتخاب کنید';
        line = 'برای هر کشور یک فهرست آی‌پی همراه برنامه هست. دکمهٔ بالا آن‌ها را یکی‌یکی از همین خط امتحان می‌کند و می‌گوید کدام‌ها واقعاً جواب می‌دهند.';
    } else if (v.testingHere) {
        tone = 'busy';
        head = `در حال تست ${fxEsc(v.c.name)}`;
        line = `${fxFa(v.tested)} از ${fxFa(v.ips.length)} امتحان شد — ${fxFa(v.valid)} سالم. دکمهٔ بالا متوقفش می‌کند.
          <span class="mv-prog" style="display:block;margin-top:9px;max-width:320px"><i style="width:${v.ips.length ? Math.round(v.tested / v.ips.length * 100) : 0}%"></i></span>`;
    } else if (busyElsewhere) {
        tone = 'busy';
        head = fxEsc(v.c.name);
        line = `تست ${fxEsc(getCountryName(st.testingCountryCode))} هنوز تمام نشده — یک تست در هر لحظه.`;
    } else if (v.tested) {
        tone = v.valid ? 'on' : 'off';
        head = fxEsc(v.c.name);
        line = `${fxFa(v.valid)} آی‌پی سالم از ${fxFa(v.tested)} امتحان‌شده. سالم‌ها بالای فهرست‌اند و با دکمهٔ کپی برداشته می‌شوند.`;
    } else {
        tone = 'off';
        head = fxEsc(v.c.name);
        line = `${fxFa(v.ips.length)} آی‌پی در فهرست این کشور هست و هیچ‌کدام هنوز امتحان نشده‌اند. دکمهٔ بالا شروع می‌کند.`;
    }

    q('head').innerHTML = head;
    q('line').innerHTML = line;

    const ring = tone === 'on' ? ' is-on' : tone === 'busy' ? ' is-busy' : '';
    const btn = q('power');
    const want = 'mv-eng-power' + ring;
    if (btn.className !== want) btn.className = want;
    btn.disabled = !v.c || !v.ips.length || busyElsewhere;
    btn.title = v.testingHere ? 'توقف تست' : 'تست آی‌پی‌ها';
    btn.setAttribute('aria-label', btn.title);
    const glyph = v.testingHere ? 'mv-spin-ring' : 'ph-bold ph-play';
    const gl = q('glyph');
    if (gl.className !== glyph) gl.className = glyph;
}

function fxRenderIps() {
    const host = $('fx-ips');
    if (!host) return;
    const v = fxState();
    if (!v.c) { host.innerHTML = ''; return; }

    if (!v.ips.length) {
        host.innerHTML = '<div class="mv-form-section is-wide"><div class="mv-form-group"><div class="mv-form-row"><span class="mv-form-label">در حال خواندن فهرست این کشور…</span></div></div></div>';
        return;
    }

    // Healthy first, then untested, then the ones that failed — the order the reader wants.
    const rank = { VALID: 0, TESTING: 1, UNKNOWN: 2, INVALID: 3 };
    const rows = v.ips.slice().sort((a, b) => (rank[a.status] ?? 2) - (rank[b.status] ?? 2));

    const chip = (s) => s === 'VALID' ? '<span class="fx-chip is-green">سالم</span>'
        : s === 'INVALID' ? '<span class="fx-chip is-red">نامعتبر</span>'
            : s === 'TESTING' ? '<span class="fx-chip"><i class="mv-spin-ring"></i> تست…</span>'
                : '<span class="fx-chip">امتحان نشده</span>';

    host.innerHTML = `
  <div class="mv-form-section is-wide">
    <div class="mv-form-header">آی‌پی‌های ${fxEsc(v.c.name)} — ${fxFa(v.ips.length)} نشانی</div>
    <div class="mv-form-group" id="fx-ip-list">
      ${rows.map((o) => `
      <div class="mv-form-row">
        <span class="mv-form-label"><span class="fx-ip" dir="ltr">${fxEsc(o.ip)}:${fxEsc(o.port)}</span><small>${chip(o.status)}</small></span>
        ${o.status === 'VALID' ? `<span class="mv-form-control"><button type="button" class="mv-btn mv-btn--sm" data-fx-copy="${fxEsc(o.ip)}" title="کپی آی‌پی بدون پورت"><i class="ph-bold ph-copy"></i></button></span>` : ''}
      </div>`).join('')}
    </div>
    <div class="mv-form-footer">این نشانی‌ها همراه برنامه‌اند و تست، آن‌ها را از <b>همین خط</b> امتحان می‌کند — نتیجه روی خط دیگری می‌تواند فرق کند. دکمهٔ کپی فقط خود آی‌پی را برمی‌دارد، بدون پورت.</div>
  </div>`;

    host.querySelectorAll('[data-fx-copy]').forEach((b) => {
        b.onclick = () => window.copyFixedIp(b.getAttribute('data-fx-copy'));
    });
}

function fxRenderCountries() {
    const host = $('fx-countries');
    if (!host) return;
    const st = window._fixedIpsState;
    const q = String(window._fxQuery || '').trim().toLowerCase();
    const list = st.countries.filter((c) => !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q));

    if (!st.countries.length) {
        host.innerHTML = '<div class="mv-empty"><b>در حال خواندن فهرست کشورها…</b></div>';
        return;
    }
    if (!list.length) { host.innerHTML = '<div class="mv-empty"><b>کشوری پیدا نشد</b></div>'; return; }

    const sel = st.selectedCountry && st.selectedCountry.code;
    host.innerHTML = list.map((c) => `
      <button type="button" class="mv-li${c.code === sel ? ' is-sel' : ''}" data-fx-country="${fxEsc(c.code)}">
        <span class="mv-li-lead"><img src="/assets/flags/${fxEsc(c.code.toLowerCase())}.svg" alt="" onerror="this.remove()"></span>
        <span class="mv-li-text"><b>${fxEsc(c.name)}</b></span>
        ${c.code === sel ? '<i class="ph-bold ph-check mv-li-end" style="color:var(--mv-accent)"></i>' : ''}
      </button>`).join('');

    host.querySelectorAll('[data-fx-country]').forEach((b) => {
        b.onclick = () => window.selectFixedIpCountry(b.getAttribute('data-fx-country'));
    });
}

function fxRenderFoot() {
    const host = $('fx-foot');
    if (!host) return;
    const v = fxState();
    const word = !v.c ? 'کشوری انتخاب نشده'
        : v.testingHere ? `در حال تست — ${fxFa(v.tested)} از ${fxFa(v.ips.length)}`
            : v.tested ? `${fxFa(v.valid)} سالم از ${fxFa(v.tested)} امتحان‌شده`
                : `${fxFa(v.ips.length)} نشانی، هیچ‌کدام امتحان نشده`;
    host.innerHTML = `
      <i class="mv-eng-dot${v.testingHere ? ' is-busy' : v.valid ? ' is-on' : ''}"></i>
      <span>${word}</span>
      <span class="mv-eng-foot-end"><span>${v.c ? fxEsc(v.c.name) : '—'}</span></span>`;
}

window.fxGoSec = function (id) {
    const wrap = $('fx-split');
    if (!wrap) return;
    window._fxSec = FX_SECTIONS.some((x) => x.id === id) ? id : 'countries';
    const sec = window._fxSec;
    wrap.querySelectorAll('.mv-eng-sec').forEach((n) => n.classList.toggle('is-on', n.getAttribute('data-sec') === sec));
    wrap.querySelectorAll('.mv-side-item[data-fx-sec]').forEach((b) => b.classList.toggle('active', b.getAttribute('data-fx-sec') === sec));
    const found = FX_SECTIONS.find((x) => x.id === sec);
    const title = $('fx-title');
    if (title) title.textContent = found ? found.label : '';
    const back = $('fx-back');
    if (back) back.disabled = sec === 'countries';
    // The hero owns the top of the list section, so the drag strip narrows there.
    const pane = wrap.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', sec === 'ips');
    const sc = $('fx-scroll');
    if (sc) sc.scrollTop = 0;
    renderFixedIpTab();
};

window.renderFixedIpTab = function () {
    if (!$('fixed-ip-root')) {
        const root = document.createElement('div');
        root.id = 'fixed-ip-root';
        root.className = 'w-full h-full flex flex-col hidden';
        $('editor-content-wrap').appendChild(root);
    }
    const root = $('fixed-ip-root');
    root.style.display = 'flex';

    if (!$('fx-split')) {
        root.innerHTML = fxShell();
        const wrap = $('fx-split');
        wrap.querySelectorAll('.mv-side-item[data-fx-sec]').forEach((b) => {
            b.onclick = () => window.fxGoSec(b.getAttribute('data-fx-sec'));
        });
        $('fx-back').onclick = () => window.fxGoSec('countries');
        $('fx-search').oninput = (e) => { window._fxQuery = e.target.value; fxRenderCountries(); };
        window.fxGoSec(window._fixedIpsState.selectedCountry ? 'ips' : 'countries');
        return;                      // fxGoSec calls back in, with the shell in place
    }

    updateBreadcrumb('انتخاب آیپی ثابت');

    fxRenderIdent();
    fxRenderFoot();
    if (window._fxSec === 'ips') { fxRenderStage(); fxRenderIps(); }
    else fxRenderCountries();

    const wrap = $('fx-split');
    wrap.querySelectorAll('[data-fx-act]').forEach((b) => {
        b.onclick = () => {
            const v = fxState();
            if (v.testingHere) window.stopFixedIpTest();
            else window.startFixedIpTest();
        };
    });
};

/**
 * The repaint the test loop uses.
 *
 * Five workers finishing an address each repaint the whole list, and a country can hold six
 * hundred of them — so a straight redraw per result is six hundred full rebuilds of a
 * six-hundred-row grid. Coalescing them onto one animation frame keeps the numbers moving
 * without the page doing that work.
 */
let _fxPaintQueued = false;
window.fxPaintSoon = function () {
    if (_fxPaintQueued) return;
    _fxPaintQueued = true;
    requestAnimationFrame(() => { _fxPaintQueued = false; renderFixedIpTab(); });
};

/** Cancel a run in flight. The worker loop checks the session id, so clearing it is the stop. */
window.stopFixedIpTest = function () {
    const st = window._fixedIpsState;
    if (!st.isTesting) return;
    st.testSessionId = null;
    st.isTesting = false;
    const code = st.testingCountryCode;
    st.testingCountryCode = null;
    if (code && st.countryDataCache[code]) {
        st.countryDataCache[code].forEach((ip) => { if (ip.status === 'TESTING') ip.status = 'UNKNOWN'; });
    }
    renderFixedIpTab();
};

window.selectFixedIpCountry = async function(code) {
    const country = window._fixedIpsState.countries.find(c => c.code === code);
    window._fixedIpsState.selectedCountry = country;
    // Picking one is the answer to the question the countries section asks, so it goes to
    // the list the choice was for; the fetch below then fills it in place.
    window.fxGoSec('ips');
    
    renderFixedIpTab();
    
    if (!window._fixedIpsState.countryDataCache[code]) {
        try {
            const res = await fetch(`/assets/ip/${code}.txt`);
            const text = await res.text();
            const lines = text.split('\n');
            
            const ips = [];
            for (let line of lines) {
                line = line.trim();
                if (!line) continue;
                let parts = line.split(/[ :]/);
                if (parts.length >= 2) {
                    ips.push({ ip: parts[0], port: parts[1], status: 'UNKNOWN' });
                }
            }
            window._fixedIpsState.countryDataCache[code] = ips;
        } catch(e) {
            console.error(e);
        }
        renderFixedIpTab();
    }
};

window.backToFixedIpCountries = function() {
    window.fxGoSec('countries');
};

window.copyFixedIp = function(ip) {
    navigator.clipboard.writeText(ip);
    if (typeof toast === 'function') toast('✅ آیپی با موفقیت کپی شد');
};

window.startFixedIpTest = async function() {
    if (window._fixedIpsState.isTesting) return;
    
    const code = window._fixedIpsState.selectedCountry.code;
    window._fixedIpsState.testingCountryCode = code;
    window._fixedIpsState.isTesting = true;
    const sessionId = Date.now();
    window._fixedIpsState.testSessionId = sessionId;
    renderFixedIpTab();
    
    const ips = window._fixedIpsState.countryDataCache[code] || [];
    ips.forEach(ip => ip.status = 'UNKNOWN');
    
    let testedCount = 0;
    const totalCount = ips.length;
    const progCont = document.getElementById('footer-progress-container');
    const progBar = document.getElementById('footer-progress-bar');
    const progText = document.getElementById('footer-progress-text');
    if (progCont) progCont.style.display = 'flex';
    if (progBar) progBar.style.width = '0%';
    if (progText) progText.innerText = `0 / ${totalCount}`;
    
    const MAX_CONCURRENT = 5;
    let index = 0;
    
    async function worker() {
        while (index < ips.length && window._fixedIpsState.testSessionId === sessionId) {
            const currentIndex = index++;
            const ipObj = ips[currentIndex];
            
            ipObj.status = 'TESTING';
            if (window._fixedIpsState.selectedCountry && window._fixedIpsState.selectedCountry.code === code) {
                window.fxPaintSoon();
            }
            
            try {
                const res = await fetch('/api/test-fixed-ip', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ip: ipObj.ip, port: ipObj.port })
                });
                const data = await res.json();
                if (window._fixedIpsState.testSessionId !== sessionId) break; // if cancelled
                ipObj.status = data.isValid ? 'VALID' : 'INVALID';
            } catch(e) {
                if (window._fixedIpsState.testSessionId !== sessionId) break;
                ipObj.status = 'INVALID';
            }
            
            testedCount++;
            if (window._fixedIpsState.testingCountryCode === code) {
                if (progBar) progBar.style.width = `${(testedCount / totalCount) * 100}%`;
                if (progText) progText.innerText = `${testedCount} / ${totalCount}`;
            }
            
            if (window._fixedIpsState.selectedCountry && window._fixedIpsState.selectedCountry.code === code) {
                window.fxPaintSoon();
            }
        }
    }
    
    const workers = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) workers.push(worker());
    await Promise.all(workers);
    
    if (window._fixedIpsState.testSessionId === sessionId) {
        window._fixedIpsState.isTesting = false;
        window._fixedIpsState.testingCountryCode = null;
        window._fixedIpsState.testSessionId = null;
        if (progCont) progCont.style.display = 'none';
        
        if (typeof window.triggerNotification === 'function') {
            window.triggerNotification('fixedIpFinished', 'تست آی‌پی ثابت', `تست آی‌پی ثابت برای کشور انتخابی تمام شد.`);
        }
        
        if (window._fixedIpsState.selectedCountry && window._fixedIpsState.selectedCountry.code === code) {
            renderFixedIpTab();
        }
    }
};

// ==========================================
// NOTIFICATION MANAGER
// ==========================================

window.notificationSettings = {
    scanFinished: true,
    delayFinished: true,
    pingFinished: true,
    v2rayStarted: true,
    sniStarted: true,
    fixedIpFinished: true
};

function initNotificationManager() {
    const saved = localStorage.getItem('notificationSettings');
    if (saved) {
        try {
            window.notificationSettings = { ...window.notificationSettings, ...JSON.parse(saved) };
        } catch (e) {}
    }
    renderNotificationMenu();
    updateNotificationIndicator();
}

function saveNotificationSettings() {
    localStorage.setItem('notificationSettings', JSON.stringify(window.notificationSettings));
    updateNotificationIndicator();
}

function updateNotificationIndicator() {
    const perm = Notification.permission;
    const indicator = document.getElementById('notif-indicator');
    if (indicator) {
        if (perm === 'granted') {
            indicator.style.display = 'block';
            indicator.style.background = 'var(--mv-green)'; // green
            indicator.style.boxShadow = '0 0 4px var(--mv-green)';
        } else if (perm === 'denied') {
            indicator.style.display = 'block';
            indicator.style.background = 'var(--mv-red)'; // red
            indicator.style.boxShadow = '0 0 4px var(--mv-red)';
        } else {
            indicator.style.display = 'none';
        }
    }
}

window.toggleNotificationMenu = function() {
    const menu = document.getElementById('notification-menu');
    const overlay = document.getElementById('notification-menu-overlay');
    if (menu.classList.contains('hidden')) {
        menu.classList.remove('hidden');
        overlay.classList.remove('hidden');
        renderNotificationMenu();
    } else {
        menu.classList.add('hidden');
        overlay.classList.add('hidden');
    }
};

window.requestNotificationPermission = function() {
    if (!("Notification" in window)) {
        uiAlert({
            title: 'نوتیفیکیشن پشتیبانی نمی‌شود',
            message: 'سیستم‌عامل شما از نوتیفیکیشن دسکتاپ پشتیبانی نمی‌کند.',
            tone: 'warn',
        });
        return;
    }
    Notification.requestPermission().then(function (permission) {
        if (permission === "granted") {
            triggerNotification('test', 'دسترسی داده شد!', 'نوتیفیکیشن‌ها با موفقیت فعال شدند.', true);
        }
        updateNotificationIndicator();
    });
};

function renderNotificationMenu() {
    const list = document.getElementById('notif-settings-list');
    if (!list) return;

    const items = [
        { id: 'scanFinished', label: 'تمام شدن اسکن', icon: 'ph-magnifying-glass' },
        { id: 'delayFinished', label: 'تمام شدن تست تأخیر', icon: 'ph-clock' },
        { id: 'pingFinished', label: 'تمام شدن تست پینگ', icon: 'ph-lightning' },
        { id: 'v2rayStarted', label: 'روشن شدن موتور v2ray', icon: 'ph-engine' },
        { id: 'sniStarted', label: 'روشن شدن موتور ضد فیلتر sni', icon: 'ph-shield-check' },
        { id: 'fixedIpFinished', label: 'تمام شدن تست آیپی ثابت', icon: 'ph-globe-hemisphere-west' }
    ];

    let html = '';
    items.forEach(item => {
        const checked = window.notificationSettings[item.id] ? 'checked' : '';
        html += `
            <label class="flex items-center justify-between p-2 hover:bg-gs-bg rounded-lg cursor-pointer transition-colors group">
                <div class="flex items-center gap-2">
                    <i class="ph-fill ${item.icon} text-gs-muted group-hover:text-gs-text transition-colors text-lg"></i>
                    <span class="text-[11px] font-medium text-gs-text">${item.label}</span>
                </div>
                <div class="relative">
                    <input type="checkbox" class="sr-only" onchange="toggleNotifSetting('${item.id}', this.checked)" ${checked}>
                    <div class="w-8 h-4 bg-gs-bg border border-gs-border rounded-full shadow-inner transition-colors ${checked ? 'bg-gs-primary/20 border-gs-primary/50' : ''}"></div>
                    <div class="absolute w-3 h-3 bg-gs-muted rounded-full shadow top-0.5 transition-transform ${checked ? 'translate-x-[-16px] bg-gs-primary' : 'translate-x-[-2px]'}"></div>
                </div>
            </label>
        `;
    });

    list.innerHTML = html;
}

window.toggleNotifSetting = function(id, value) {
    window.notificationSettings[id] = value;
    saveNotificationSettings();
    renderNotificationMenu();
};

window.triggerNotification = function(id, title, message, bypassCheck = false) {
    if (!("Notification" in window)) return;
    
    // Check if it's enabled in settings
    if (!bypassCheck && window.notificationSettings && window.notificationSettings[id] === false) {
        return;
    }

    if (Notification.permission === "granted") {
        new Notification(title, {
            body: message,
            icon: 'icon.png' // ensure this exists in public folder
        });
    }
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    initNotificationManager();
    updatePanelStatusLights();
    setInterval(updatePanelStatusLights, 2000);
    initGlobalTooltip();
});

window.initGlobalTooltip = function() {
    const tooltip = document.createElement('div');
    tooltip.id = 'global-custom-tooltip';
    document.body.appendChild(tooltip);

    const style = document.createElement('style');
    style.innerHTML = `
        #global-custom-tooltip {
            position: fixed;
            background: var(--mv-surface);
            color: var(--mv-label);
            padding: 8px 12px;
            border-radius: 8px;
            font-size: 11px;
            font-weight: 500;
            white-space: normal;
            width: max-content;
            max-width: 200px;
            text-align: center;
            line-height: 1.6;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1), transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            border: 1px solid var(--mv-sep);
            backdrop-filter: blur(8px);
            pointer-events: none;
            z-index: 999999;
            font-family: inherit;
            direction: rtl;
        }
        #global-custom-tooltip.show {
            opacity: 1;
            visibility: visible;
        }
        #global-custom-tooltip::after {
            content: '';
            position: absolute;
            border-width: 5px;
            border-style: solid;
            pointer-events: none;
        }
        #global-custom-tooltip.arrow-bottom::after {
            bottom: -10px;
            left: var(--arrow-pos, 50%);
            transform: translateX(-50%);
            border-color: var(--mv-sep-2) transparent transparent transparent;
        }
        #global-custom-tooltip.arrow-top::after {
            top: -10px;
            left: var(--arrow-pos, 50%);
            transform: translateX(-50%);
            border-color: transparent transparent var(--mv-sep-2) transparent;
        }
        #global-custom-tooltip.arrow-right::after {
            right: -10px;
            top: var(--arrow-pos, 50%);
            transform: translateY(-50%);
            border-color: transparent transparent transparent var(--mv-sep-2);
        }
        #global-custom-tooltip.arrow-left::after {
            left: -10px;
            top: var(--arrow-pos, 50%);
            transform: translateY(-50%);
            border-color: transparent var(--mv-sep-2) transparent transparent;
        }
    `;
    document.head.appendChild(style);

    let currentTarget = null;
    let hideTimeout = null;

    document.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[title], [data-tooltip]');
        if (!target) return;

        // Ignore if element prefers native title or is disabled
        if (target.hasAttribute('data-no-tooltip')) return;

        // Move title to data-tooltip
        if (target.hasAttribute('title') && target.getAttribute('title').trim() !== '') {
            target.setAttribute('data-tooltip', target.getAttribute('title'));
            target.removeAttribute('title');
        }

        const text = target.getAttribute('data-tooltip');
        if (!text) return;

        clearTimeout(hideTimeout);
        currentTarget = target;
        tooltip.innerHTML = text.replace(/\\n/g, '<br>');

        // Opt-in interactive tooltips: `data-tooltip-interactive` lets the
        // pointer travel into the bubble and click links inside it. Every other
        // tooltip stays click-through, so nothing else changes behaviour.
        const interactive = target.hasAttribute('data-tooltip-interactive');
        tooltip.style.pointerEvents = interactive ? 'auto' : 'none';
        tooltip.style.maxWidth = interactive ? '270px' : '';
        
        // Temporarily show to get dimensions
        tooltip.classList.add('show');
        tooltip.style.opacity = '0'; 
        
        const rect = target.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        
        const spaceTop = rect.top;
        const spaceBottom = window.innerHeight - rect.bottom;
        const spaceLeft = rect.left;
        const spaceRight = window.innerWidth - rect.right;
        
        const margin = 10;
        let top = 0;
        let left = 0;
        let arrowClass = '';
        
        tooltip.style.transform = 'none';

        if (spaceLeft < 80 && spaceRight > tooltipRect.width) {
            // Left edge
            left = rect.right + margin;
            top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
            arrowClass = 'arrow-left';
            tooltip.style.transform = 'translateX(-10px)';
        } else if (spaceRight < 80 && spaceLeft > tooltipRect.width) {
            // Right edge
            left = rect.left - tooltipRect.width - margin;
            top = rect.top + (rect.height / 2) - (tooltipRect.height / 2);
            arrowClass = 'arrow-right';
            tooltip.style.transform = 'translateX(10px)';
        } else if (spaceBottom < 60 && spaceTop > tooltipRect.height) {
            // Bottom edge
            top = rect.top - tooltipRect.height - margin;
            left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
            arrowClass = 'arrow-bottom';
            tooltip.style.transform = 'translateY(10px)';
        } else {
            // Default (show below)
            top = rect.bottom + margin;
            left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
            arrowClass = 'arrow-top';
            tooltip.style.transform = 'translateY(-10px)';
        }
        
        // Prevent going off-screen horizontally
        let arrowPos = '50%';
        if (left < 10) {
            const shift = 10 - left;
            left = 10;
            arrowPos = `calc(50% - ${shift}px)`;
        } else if (left + tooltipRect.width > window.innerWidth - 10) {
            const shift = (left + tooltipRect.width) - (window.innerWidth - 10);
            left = window.innerWidth - tooltipRect.width - 10;
            arrowPos = `calc(50% + ${shift}px)`;
        }
        
        // Prevent going off-screen vertically
        if (top < 10) {
            const shift = 10 - top;
            top = 10;
            if (arrowClass === 'arrow-left' || arrowClass === 'arrow-right') {
                arrowPos = `calc(50% - ${shift}px)`;
            }
        } else if (top + tooltipRect.height > window.innerHeight - 10) {
            const shift = (top + tooltipRect.height) - (window.innerHeight - 10);
            top = window.innerHeight - tooltipRect.height - 10;
            if (arrowClass === 'arrow-left' || arrowClass === 'arrow-right') {
                arrowPos = `calc(50% + ${shift}px)`;
            }
        }
        
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
        tooltip.style.setProperty('--arrow-pos', arrowPos);
        
        tooltip.className = 'show ' + arrowClass;
        
        void tooltip.offsetWidth;
        
        tooltip.style.opacity = '1';
        if (arrowClass === 'arrow-bottom' || arrowClass === 'arrow-top') {
            tooltip.style.transform = 'translateY(0)';
        } else {
            tooltip.style.transform = 'translateX(0)';
        }
    });

    const hideTooltip = () => {
        tooltip.classList.remove('show');
        tooltip.style.opacity = '0';
        currentTarget = null;
    };

    document.addEventListener('mouseout', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target && target === currentTarget) {
            // Interactive bubbles need long enough for the pointer to cross the
            // gap between the trigger and the tooltip without it vanishing.
            const grace = target.hasAttribute('data-tooltip-interactive') ? 260 : 50;
            hideTimeout = setTimeout(hideTooltip, grace);
        }
    });

    // Keep it open while the pointer is inside an interactive bubble.
    tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimeout));
    tooltip.addEventListener('mouseleave', hideTooltip);

    document.addEventListener('mousedown', (e) => {
        // A click *inside* the tooltip is the point of an interactive one —
        // closing on mousedown would swallow it before the click fires.
        if (tooltip.contains(e.target)) return;
        hideTooltip();
    });
};

window.updatePanelStatusLights = function() {
    const lights = {
        'bpb': document.getElementById('light-bpb'),
        'edge': document.getElementById('light-edge'),
        'zeus': document.getElementById('light-zeus')
    };
    if(!lights.bpb || !lights.edge || !lights.zeus) return;

    let accounts = [];
    try {
        accounts = JSON.parse(localStorage.getItem('cf_accounts') || '[]');
    } catch(e) {}

    let bases = [];
    try {
        bases = JSON.parse(localStorage.getItem('cf_base_configs') || '[]');
    } catch(e) {}

    const panelNames = {
        'bpb': 'bpb',
        'edge': 'Edge',
        'zeus': 'Zeus'
    };

    if (accounts.length === 0) {
        ['bpb', 'edge', 'zeus'].forEach(p => {
            lights[p].style.background = 'var(--mv-fill-3)'; // Gray
            lights[p].setAttribute('data-tooltip', 'شما هیچ اکانت کلادفلری متصل نکرده اید');
            lights[p].style.boxShadow = '0 0 2px rgba(0,0,0,0.5)';
        });
        return;
    }

    // BPB checks
    let bpbDeployed = accounts.some(a => !!a.url);
    let bpbConfigs = bases.some(b => (!b.metadata || (!b.metadata.zeusUsername && !b.metadata.edgeUuid)) && accounts.some(a => a.url && b.name.includes(a.url.replace('https://',''))));
    
    // EDGE checks
    let edgeDeployed = accounts.some(a => !!a.edgeUrl);
    let edgeConfigs = bases.some(b => (b.metadata && b.metadata.edgeUuid) || accounts.some(a => a.edgeUrl && b.name.includes(a.edgeUrl.replace('https://',''))));

    // ZEUS checks
    let zeusDeployed = accounts.some(a => !!a.zeusUrl);
    let totalZeusUsers = accounts.reduce((sum, a) => sum + (a.zeusUserCount || 0), 0);
    // If we have zeusUserCount > 0, it's green. Or if we have exported configs for Zeus (fallback)
    let zeusConfigs = totalZeusUsers > 0 || bases.some(b => b.metadata && b.metadata.zeusUsername);

    const states = {
        'bpb': { deployed: bpbDeployed, configs: bpbConfigs },
        'edge': { deployed: edgeDeployed, configs: edgeConfigs },
        'zeus': { deployed: zeusDeployed, configs: zeusConfigs, usersCount: totalZeusUsers }
    };

    ['bpb', 'edge', 'zeus'].forEach(p => {
        let st = states[p];
        if (st.configs) {
            lights[p].style.background = 'var(--mv-green)'; // Green
            if (p === 'zeus') {
                lights[p].setAttribute('data-tooltip', st.usersCount > 0 ? `شما ${st.usersCount} کاربر در پنل زئوس دارید` : `کانفیگ های پنل زئوس با موفقیت دریافت شدند`);
            } else {
                lights[p].setAttribute('data-tooltip', `کانفیگ های پنل ${panelNames[p]} با موفقیت دریافت شدند`);
            }
            lights[p].style.boxShadow = '0 0 4px var(--mv-green)';
        } else if (st.deployed) {
            lights[p].style.background = 'var(--mv-yellow)'; // Yellow
            lights[p].setAttribute('data-tooltip', `اکانت ${panelNames[p]} دیپلوی شده و آماده ${p === 'zeus' ? 'مدیریت کاربران' : 'دریافت کانفیگ'} است`);
            lights[p].style.boxShadow = '0 0 4px var(--mv-yellow)';
        } else {
            lights[p].style.background = 'var(--mv-red)'; // Red
            lights[p].setAttribute('data-tooltip', `شما پنل ${panelNames[p]} را دیپلوی نکردید`);
            lights[p].style.boxShadow = '0 0 4px var(--mv-red)';
        }
    });
};

// ===== fragment+fingerprint (جایگزین SNI-Spoofing برای کانفیگ‌های کلودفلر) =====
//
// عملاً همیشه روشن است و خودکار اعمال می‌شود؛ این کلید فقط برای عیب‌یابی است. هر
// تغییر بلافاصله روی اتصالِ زنده هم بازسازی می‌شود (سرور restartXray می‌کند)، چون
// این تنظیم داخل کانفیگ تولیدشده می‌نشیند و بدون بازسازی هیچ اثری ندارد.
(function initTlsFingerprintToggle() {
    const box = document.getElementById('setting-tlsfp-enabled');
    const state = document.getElementById('tlsfp-state');
    if (!box) return;

    const render = (cfg) => {
        box.checked = !!(cfg && cfg.enabled && cfg.mode !== 'off');
        if (state) {
            state.textContent = box.checked
                ? 'وضعیت: فعال — fingerprint=unsafe + fragment (tlshello / 1-1)'
                : 'وضعیت: غیرفعال — کانفیگ‌های کلودفلر ممکن است روی نت محدود وصل نشوند';
        }
    };

    fetch('/api/tlsfp/status')
        .then(r => r.json())
        .then(d => render(d.config))
        .catch(() => {});

    box.addEventListener('change', async () => {
        const enabled = box.checked;
        try {
            const res = await fetch('/api/tlsfp/config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, mode: enabled ? 'auto' : 'off' })
            });
            const d = await res.json();
            if (d.error) throw new Error(d.error);
            render(d.config);
            toast(d.applied
                ? (enabled ? '✅ فینگرپرینت فعال شد و روی اتصال اعمال گردید' : '⚠️ فینگرپرینت خاموش شد و اتصال بازسازی شد')
                : (enabled ? '✅ فینگرپرینت فعال شد' : '⚠️ فینگرپرینت خاموش شد'));
        } catch (e) {
            // برگرداندن کلید به وضعیت واقعی، تا کاربر فکر نکند ذخیره شده
            box.checked = !enabled;
            toast('❌ خطا در ذخیره: ' + e.message);
        }
    });
})();
