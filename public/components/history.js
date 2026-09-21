// --- تاریخچهٔ اسکن‌ها ---
//
// The saved scans. This was a body-level slide-in drawer at z-index 9999, from before the app
// had windows: it covered the whole desktop, not the scanner window, and it was the only place
// «ذخیره در تاریخچه» lived. It is a section of the scan page now (components/scan.js › تاریخچه),
// so it obeys the window it belongs to and can be read side by side with the results.
//
// The storage half — saveToHistory, the auto-save clock, restoreHistoryItem — is unchanged.

/** Nothing to build any more; the markup belongs to the scan page. */
async function initHistoryModule() { /* #history-list lives in components/scan.js */ }

// Global initialization
window.initHistoryModule = initHistoryModule;

// Extracted logic from app.js
// ===== History Functions =====
let scanHistory = JSON.parse(PersistentStorage.getItem('ipscanner_history') || '[]');

function saveToHistory(tab) {
    if (!tab || !tab.results || tab.results.length === 0) return;
    
    // Keep only IPs that are either fully alive or at least have an open TCP port
    const usefulResults = tab.results.filter(r => r.alive || (r.tcp && r.tcp.latency > 0) || r.realDelay > 0);
    
    // Sort so best are kept if we exceed limit
    usefulResults.sort((a, b) => {
        let va = a.alive ? (a.realDelay > 0 ? a.realDelay : 9999) : 99999;
        let vb = b.alive ? (b.realDelay > 0 ? b.realDelay : 9999) : 99999;
        return va - vb;
    });

    const historyItem = {
        id: Date.now(),
        key: tab.historyKey || null,
        isp: tab.isp || undefined,
        date: new Date().toLocaleString('fa-IR'),
        alive: tab.alive,
        tested: tab.tested,
        bestIp: usefulResults.length > 0 ? usefulResults[0].ip : '-',
        bestDelay: usefulResults.length > 0 ? usefulResults[0].realDelay : 0,
        results: usefulResults.slice(0, 1500) // Increase limit to 1500 IPs per scan
    };
    // A scan already in history (an auto-save snapshot) is replaced, not listed twice.
    if (historyItem.key) scanHistory = scanHistory.filter(h => !h || h.key !== historyItem.key);
    scanHistory.unshift(historyItem);
    if (scanHistory.length > 20) scanHistory.pop(); // Keep last 20 scans
    PersistentStorage.setItem('ipscanner_history', JSON.stringify(scanHistory));
    renderHistoryList();
}

/**
 * Kept by name — the menu bar, the activity rail and shell/apps.js all call it. It is a section
 * of the scan page now, so "toggle" means: go there, and go back if you are already there.
 */
function toggleHistoryMenu() {
    if (typeof window.scanGo !== 'function') return;
    window.scanGo(window.scanSection && window.scanSection() === 'history' ? 'scan' : 'history');
}

async function clearAllHistory() {
    if (await uiConfirm({
        title: 'کل تاریخچه‌ی اسکن پاک شود؟',
        message: 'همه‌ی نتایج ذخیره‌شده حذف می‌شوند و قابل بازگردانی نیستند.',
        confirmLabel: 'پاک کن', danger: true,
    })) {
        scanHistory = [];
        PersistentStorage.setItem('ipscanner_history', '[]');
        renderHistoryList();
    }
}

function renderHistoryList() {
    const list = document.getElementById('history-list');
    const count = document.getElementById('history-count-text');
    if (!list || !count) return;
    if (!Array.isArray(scanHistory)) {
        scanHistory = [];
        PersistentStorage.setItem('ipscanner_history', '[]');
    }

    const fa = (n) => String(n).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    count.textContent = fa(scanHistory.length) + ' مورد ذخیره شده';

    if (scanHistory.length === 0) {
        list.innerHTML = '<div class="mv-empty">هنوز اسکنی ذخیره نشده. هر اسکنی که تمام شود خودش اینجا می‌آید.</div>';
        return;
    }

    // K3 rows: what it found, when, and the best address in it — the three things you pick by.
    list.innerHTML = scanHistory.map(item => item ? `
      <div class="mv-li" role="option" tabindex="0" data-history="${item.id}" title="باز کردن به‌صورت یک اسکن تازه">
        <span class="mv-li-lead"><i class="ph-fill ph-clock-counter-clockwise" style="color:var(--mv-orange)"></i></span>
        <span class="mv-li-text"><b>${esc(item.isp || 'اسکن')}</b><small>${esc(item.date || '—')} · ${fa(item.alive || 0)} سالم از ${fa(item.tested || 0)}</small></span>
        <span class="mv-li-num">${item.bestDelay ? fa(item.bestDelay) : '—'}<small>ms</small></span>
        <span class="mv-li-end" dir="ltr" style="font-family:var(--mv-font-tech);color:var(--mv-label-2)">${esc(item.bestIp || '')}</span>
      </div>` : '').join('');

    list.querySelectorAll('[data-history]').forEach(row => {
        const id = +row.getAttribute('data-history');
        row.addEventListener('click', () => window.restoreHistoryItem(id));
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); window.restoreHistoryItem(id); }
        });
    });
}

window.saveCurrentTabManual = function() {
    const tab = getActiveTab();
    if(tab) {
        saveToHistory(tab);
        toast('✅ در تاریخچه ذخیره شد');
    }
};

// «ذخیره‌ی خودکار» (menu «اسکن», the top bar, Settings › اسکن): while a scan runs, what it
// has found so far goes into history every N minutes (Settings › اسکن, 1–120, default 1), so
// closing the app mid-scan loses nothing. The end-of-scan save still happens either way.
function autosaveMinutes() {
    const el = document.getElementById('autosave-interval-input');
    const v = parseInt(el ? el.value : PersistentStorage.getItem('autosave-interval-input'), 10);
    return v >= 1 ? Math.min(v, 120) : 1;
}
setInterval(() => {
    if (!window.autoSaveEnabled || typeof tabs === 'undefined') return;
    const tab = tabs.find(t => t.state === 'running');
    if (!tab) return;
    const now = Date.now();
    // The clock starts when this scan is first seen running.
    if (tab._autosaveKey !== tab.historyKey) { tab._autosaveKey = tab.historyKey; tab._autosavedAt = now; return; }
    if (now - tab._autosavedAt < autosaveMinutes() * 60000) return;
    tab._autosavedAt = now;
    saveToHistory(tab);
}, 10000);

window.toggleHistoryMenu = toggleHistoryMenu;
window.clearAllHistory = clearAllHistory;

window.restoreHistoryItem = function(id) {
    const item = scanHistory.find(i => i.id === id);
    if(!item) return;

    const newId = 'tab_' + Date.now();
    const newTab = {
        id: newId,
        isp: (item.isp || 'تاریخچه') + ' (بازگردانی)',
        state: item.tested < item.total ? 'paused' : 'done',
        total: item.total || item.tested || 0,
        tested: item.tested || 0,
        alive: item.alive || 0,
        dead: item.dead || 0,
        results: item.results || [],
        // A restored scan with an empty settings object showed every control at its default and
        // a context line that described nothing; defaultSettings() at least describes itself.
        settings: (item.settings && Object.keys(item.settings).length)
            ? item.settings
            : (typeof defaultSettings === 'function' ? defaultSettings() : {}),
        sortCol: 'realDelay',
        sortAsc: true,
        stage3Total: 0,
        stage3Tested: 0
    }
;
    tabs.push(newTab);
    activeTabId = newId;
    renderTabs();
    renderActiveTab();
    toggleHistoryMenu();
    toast('✅ تاریخچه بازیابی شد');
};