// --- The app's live socket, and the scan helpers that read the scan page ---
//
// THE NAME NO LONGER MATCHES THE CONTENTS, ON PURPOSE.
//
// This file used to build the 320px scan sidebar. That sidebar is gone — the scan page is now
// one page-kit page in components/scan.js. What stayed behind is the part that was never about
// the sidebar: connectWS(), the ONE WebSocket the whole program listens on (netdiag, aether,
// sanction, the fronts, game, quick-connect, traffic, core logs and the scan all arrive here),
// opened by components/cloud.js on DOMContentLoaded. Moving it would mean moving every branch
// and every caller with it, so it kept its home and its name.
//
// Also here: the three readers of the scan form (getSelectedCdns, getSelectedPorts, fetchIps).
// They address their controls by id, so they did not care that the markup moved.

/** Kept so index.html's safeInit() has something to call. The page builds itself now. */
function initScannerSidebarModule() { /* the sidebar lives in components/scan.js */ }

// id → what the server calls that network. Guarded reads: this is called from saveTabSettings,
// which startScan calls, and an exception there would abandon the scan silently.
const CDN_BY_ID = {
    'chk-cf': 'cloudflare', 'chk-ak': 'akamai', 'chk-fl': 'fastly', 'chk-aws': 'cloudfront',
    'chk-goog': 'google', 'chk-az': 'azure', 'chk-gc': 'gcore',
    'chk-warp-main': 'warp_main', 'chk-warp-alt': 'warp_alt', 'chk-warp-ipv6': 'warp_ipv6',
};

function getSelectedCdns() {
    if ($('chk-none') && $('chk-none').checked) return [];
    const c = [];
    Object.keys(CDN_BY_ID).forEach(id => { const el = $(id); if (el && el.checked) c.push(CDN_BY_ID[id]); });
    return c;
}


function getSelectedPorts() { const p = []; document.querySelectorAll('.port-chk:checked').forEach(c => p.push(+c.value)); return p }



// ===== Accordion =====
function toggleSection(id) {
    const el = $(id); if (!el) return;
    const arrow = el.previousElementSibling?.querySelector('.section-arrow');
    if (el.style.display === 'none') { el.style.display = ''; if (arrow) arrow.style.transform = 'rotate(0deg)' }
    else { el.style.display = 'none'; if (arrow) arrow.style.transform = 'rotate(-90deg)' }
}

// ===== Fetch IPs =====
/** Returns whether a list was actually built — startScan runs this itself when the list is empty. */
async function fetchIps() {
    saveTabSettings();
    const tab = getActiveTab(); if (!tab) { toast('❌ ابتدا تب باز کنید'); return false }
    let cdns = tab.settings.cdns, maxIps = tab.settings.maxIps;
    if (maxIps > 100000) maxIps = 5000; // Cap fetch preview
    if (!cdns.length) { toast('❌ حداقل یک منبع انتخاب کنید'); return false }
    const btn = $('btn-fetch');
    if (btn) btn.disabled = true;
    try {
        const res = await fetch('/api/get-ips', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cdns, maxIps }) });
        const d = await res.json(); if (!res.ok) throw new Error(d.error);
        const ta = $('ip-textarea');
        if (ta) ta.value = d.ipsText;
        tab.settings.customInput = d.ipsText;
        toast(`✅ ${d.count} آی‌پی آماده شد`);
        if (typeof window.scanPaint === 'function') window.scanPaint();
        return !!d.count;
    } catch (e) { toast('❌ ساختن فهرست آی‌پی انجام نشد'); return false }
    finally { if (btn) btn.disabled = false }
}

// ===== WebSocket =====
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onmessage = e => {
        const msg = JSON.parse(e.data);

        if (msg.type === 'system_log') {
            termLog('[DEBUG] ' + msg.data.message);
            return;
        }

        // «دیاگ اینترنت» progress. Carries a stage id and a percentage and nothing else — no
        // fact, no address, no adapter name — because this socket accepts any Origin
        // (server.js:36) and is therefore readable by any local process. The diagnosis itself
        // comes over the authenticated REST route.
        if (msg.type === 'netdiag') {
            if (typeof window.handleNetDiagEvent === 'function') window.handleNetDiagEvent(msg.data);
            return;
        }

        if (msg.type === 'openvpn') {
            if (typeof window.handleOpenVpnEvent === 'function') window.handleOpenVpnEvent(msg.data);
            return;
        }

        if (msg.type === 'traffic_update') {
            const t = msg.data;
            // updateHeaderTrafficUI, not updateHeaderTraffic — THE LATTER DOES NOT EXIST.
            //
            // A dead call, and it had a real cost: every engine's bytes reach the header only
            // through its own once-a-second poll of the totals, so the one live path — the feed,
            // which already knows about every engine — was being dropped on the floor. The
            // figures were right and always up to a second stale, and nothing said why.
            if (typeof updateHeaderTrafficUI === 'function') updateHeaderTrafficUI(t);
            if (typeof updateLiveSpeed === 'function') updateLiveSpeed(t);
            if (typeof updateMonitor === 'function') updateMonitor(t);
            // And one plain event for everything else that wants the same figures — the engine
            // pages' live chart listens for it. A page that arrives later just adds a listener,
            // instead of wrapping whichever global happens to be on the way past (which is how
            // the dead `updateHeaderTraffic` call above went unnoticed for so long).
            try { document.dispatchEvent(new CustomEvent('mv-traffic', { detail: t })); } catch (e) { /* no CustomEvent: nothing to draw */ }
        }

        if (msg.type === 'core_log') {
            // «اوپن‌وی‌پی‌ان» tags its own lines on this shared stream, the way the gateway tags
            // its own on front_log — one channel, each panel taking the lines that are its own.
            if (typeof window.handleOpenVpnLog === 'function') window.handleOpenVpnLog(msg.data);
            if (msg.data.includes('[TUN]') || msg.data.includes('[FATAL]') || msg.data.includes('[CLOUD]')) {
                if (typeof termLog === 'function') termLog(msg.data);
            }
            if (msg.data.includes('[CLOUD] Successfully fetched')) {
                const match = msg.data.match(/fetched (\d+) cloud configurations/);
                if (match && $('cloud-sync-badge')) {
                    const cnt = match[1];
                    $('cloud-sync-badge').style.display = 'flex';
                    if ($('cloud-sync-text')) $('cloud-sync-text').textContent = `CLOUD SYNC: ${cnt} WORKERS ACTIVE`;
                }
            }
            if (window.isLogPaused || ($('setting-disable-core-log') && $('setting-disable-core-log').checked)) return;
            const el = $('core-logs');
            if (!el) return;
            const text = msg.data.trim();
            if (!text) return;

            const div = document.createElement('div');
            div.style.lineHeight = "1.4";
            div.textContent = text;
            el.appendChild(div);
            if (el.childNodes.length > 1000) el.removeChild(el.firstChild);
            el.scrollTop = el.scrollHeight;
            return;
        }

        if (msg.type === 'aether_status') {
            if (typeof handleAetherStatusEvent === 'function') handleAetherStatusEvent(msg.data);
            return;
        }

        // «وارپ» is its own engine on its own routes (warp-manager.js), so it has its own pair
        // of events. Keeping them separate is the point: an aether fault must not be able to
        // move this page's state.
        if (msg.type === 'warp_status') {
            if (typeof handleWarpStatusEvent === 'function') handleWarpStatusEvent(msg.data);
            return;
        }
        if (msg.type === 'warp_log') {
            if (window.isLogPaused || ($('setting-disable-core-log') && $('setting-disable-core-log').checked)) return;
            const el = $('core-logs');
            if (!el || !msg.data) return;
            const div = document.createElement('div');
            div.style.lineHeight = '1.4';
            div.textContent = '[وارپ] ' + String(msg.data).trim();
            el.appendChild(div);
            if (el.childNodes.length > 1000) el.removeChild(el.firstChild);
            el.scrollTop = el.scrollHeight;
            return;
        }

        // The server has always broadcast these two. Nothing listened for them, so when the
        // server tore the tunnel down — after a dropped engine, a dead sing-box, a stolen
        // default route — the toggle stayed green on "تمام ترافیک سیستم — بدون نشت" while the
        // machine was routing normally with the real IP. A switch that lies about whether the
        // user is protected is the most dangerous thing this panel can do, so these events
        // are now the UI's source of truth.
        // The free-config run reports itself here: it can take minutes over ten thousand
        // entries, so it streams instead of holding a request open.
        // «سایفون» and «تور» (components/fronts.js). Two messages and not one: the log is a
        // stream the panel appends, the status is a snapshot it repaints from — sending the
        // status inside every log line would repaint the window thousands of times during a
        // Tor bootstrap at `info`.
        if (msg.type === 'sanction_log') {
            if (typeof window.handleSanctionLog === 'function') window.handleSanctionLog(msg.data);
            return;
        }
        if (msg.type === 'front_log') {
            if (typeof window.handleFrontLog === 'function') window.handleFrontLog(msg.data);
            // The gateway writes to the same channel, tagged with its own prefix — one stream, and
            // each panel takes the lines that are its own.
            if (typeof window.handleGatewayLog === 'function') window.handleGatewayLog(msg.data);
            return;
        }
        // «گف»'s sign-up puzzle, which is seconds of CPU with a real progress fraction. Its own
        // message rather than a log line: the bar is repainted from it many times a second and the
        // log must not grow by one line per repaint.
        // The exit sweep, one country at a time. Pushed rather than polled: a four-second poll
        // would make a thirty-second sweep look like four steps instead of twelve.
        if (msg.type === 'geph_sweep') {
            if (typeof window.handleGephSweep === 'function') window.handleGephSweep(msg.data);
            return;
        }
        // تور's own kind of measurement: each draw is a settled circuit, pushed as it lands.
        if (msg.type === 'tor_path') {
            if (typeof window.handleTorPath === 'function') window.handleTorPath(msg.data);
            return;
        }
        if (msg.type === 'geph_register') {
            if (typeof window.handleGephRegister === 'function') window.handleGephRegister(msg.data);
            return;
        }
        if (msg.type === 'front_status') {
            if (typeof window.handleFrontStatus === 'function') window.handleFrontStatus(msg.data);
            // The gateway applies the pushed status directly rather than answering it with a
            // fetch. Its status now carries the progress of a «تست واقعی» sweep, which lands two
            // or three times a second — and `/api/gateway/list` sends the whole archive, so a
            // round trip per push would be a megabyte a second to move a progress bar.
            if (msg.data && msg.data.engine === 'gateway') {
                if (typeof window.handleGatewayStatus === 'function') window.handleGatewayStatus(msg.data.status);
                else if (typeof window.gatewayRefresh === 'function') window.gatewayRefresh();
            }
            return;
        }

        if (msg.type === 'free_configs') {
            if (typeof window.handleFreeConfigsEvent === 'function') window.handleFreeConfigsEvent(msg.data);
            return;
        }
        if (msg.type === 'game_event') {
            if (typeof window.handleGameEvent === 'function') window.handleGameEvent(msg.data);
            return;
        }
        // The «اتصال سریع» server sweep reports itself here: it walks thousands of endpoints
        // and would blow past any request timeout held open.
        if (msg.type === 'quick_event') {
            if (typeof window.handleQuickEvent === 'function') window.handleQuickEvent(msg.data);
            return;
        }
        if (msg.type === 'tun') {
            if (typeof applyTunState === 'function') applyTunState(msg.data);
            // The V2Ray panel has its own switch onto the same adapter, and the server tears
            // that tunnel down on its own (engine gone, proxy chosen, node switched). Same
            // reasoning as above: a switch that keeps claiming "no leaks" over a machine
            // routing normally is worse than no switch at all.
            if (typeof window.syncV2raySwitches === 'function') window.syncV2raySwitches();
            return;
        }
        if (msg.type === 'aether_guard') {
            if (typeof applyGuardState === 'function') applyGuardState(msg.data);
            return;
        }
        if (msg.type === 'system_proxy') {
            if (typeof refreshSystemProxy === 'function') refreshSystemProxy();
            return;
        }

        if (msg.type === 'vpngate-count') {
            const statusEl = $('vpngate-status');
            if (statusEl) {
                if (msg.data.status) {
                    statusEl.textContent = msg.data.status;
                }
                if (msg.data.done) {
                    isUpdatingVpnGate = false;
                    const btn = document.querySelector('button[onclick="updateVpnGate()"]');
                    if (btn) btn.textContent = 'آپدیت آنلاین فایل سرورها';
                    statusEl.style.color = 'var(--syn-cyan)';
                    loadVpnGate();
                } else {
                    statusEl.style.color = 'var(--ide-text-dim)';
                }
            }
            return;
        }

        let tab = tabs.find(t => t.state === 'running' || t.state === 'paused') || getActiveTab();
        if (!tab || (tab.state !== 'running' && tab.state !== 'paused')) return;
        
        if (msg.type === 'error' && msg.data && msg.data.message === 'NETWORK_DOWN') {
            tab.state = 'paused'; renderTabs(); updateStats(tab); updateProgress(tab);
            termLog('> ⚠️ اینترنت قطع شد! اسکن متوقف شد و در انتظار اتصال مجدد است...');
            toast('⚠️ قطعی اینترنت! در انتظار اتصال...');
            
            if (Notification.permission === 'granted') {
                new Notification('هشدار قطعی اینترنت', { body: 'اینترنت قطع شد. اسکن متوقف شد و با اتصال مجدد ادامه می‌یابد.' });
            } else if (Notification.permission !== 'denied') {
                Notification.requestPermission().then(p => {
                    if (p === 'granted') new Notification('هشدار قطعی اینترنت', { body: 'اینترنت قطع شد. اسکن متوقف شد.' });
                });
            }

            if ($('isp-status')) {
                $('isp-status').textContent = 'OFFLINE';
                $('isp-status').className = 'text-gs-danger font-bold';
            }
            if (window.autoResumeInterval) clearInterval(window.autoResumeInterval);
            let isResuming = false;
            window.autoResumeInterval = setInterval(async () => {
                if (tab.state !== 'paused') { clearInterval(window.autoResumeInterval); return; }
                if (isResuming) return;
                try {
                    isResuming = true;
                    const res = await fetch('/api/check-isp');
                    const d = await res.json();
                    if (d.success) {
                        termLog('> 🟢 اینترنت متصل شد! ادامه خودکار اسکن...');
                        toast('🟢 اینترنت وصل شد! ادامه اسکن...');
                        if (Notification.permission === 'granted') {
                            new Notification('اتصال اینترنت', { body: 'اینترنت مجدداً متصل شد. ادامه اسکن...' });
                        }
                        const success = await startScan(true);
                        if (success) clearInterval(window.autoResumeInterval);
                    }
                } catch(e) {
                } finally {
                    isResuming = false;
                }
            }, 3000);
            return;
        }

        if (msg.type === 'cloud_log') {
            cloudLog(msg.data);
            return;
        }

        if (msg.type === 'started') {
            if (tab && tab.state === 'running') {
                tab.total = msg.data.total;
                updateStats(tab);
                updateProgress(tab);
            }
            return;
        }

        // ✅ Batch result handler - HIGH PERFORMANCE MODE
        if (msg.type === 'batch_result') {
            const batch = msg.data.results;
            const progress = msg.data.progress;
            for (const result of batch) {
                tab.results.push(result);
                if (result.alive) termLog(`> ✅ ${result.ip}:${result.port} سالم است!`);
            }
            tab.tested = progress.tested;
            tab.alive = progress.alive;
            tab.dead = progress.dead;
            updateStats(tab);
            updateProgress(tab);
            window.scanScheduleRender(tab);
            return;
        }

        if (msg.type === 'result') {
            tab.results.push(msg.data.result);
            tab.tested = msg.data.progress.tested;
            tab.alive = msg.data.progress.alive;
            tab.dead = msg.data.progress.dead;
            updateStats(tab);
            updateProgress(tab);
            if (!msg.data.result.alive && Math.random() < 0.05) {
                const err = msg.data.result.http?.error || 'timeout';
                termLog(`> ❌ بررسی ${msg.data.result.ip}:${msg.data.result.port} ناموفق (${err})`);
            } else if (msg.data.result.alive) {
                termLog(`> ✅ ${msg.data.result.ip}:${msg.data.result.port} سالم است!`);
            }
            window.scanScheduleRender(tab);
            return;
        }


        if (msg.type === 'stage2_start') {
            termLog('> ⏳ ' + msg.data.message);
            if (tab) {
                tab.status = 'مرتب‌سازی';
                updateStats(tab);
                updateProgress(tab, msg.data.message);
            }
            return;
        }

        if (msg.type === 'stage3_start') {
            termLog('> 🚀 ' + msg.data.message);
            if (tab) {
                tab.status = 'تست قطعی Xray';
                if (msg.data.total !== undefined) {
                    tab.stage3Total = msg.data.total;
                    tab.stage3Tested = 0;
                }
                updateStats(tab);
                updateProgress(tab, msg.data.message);
            }
            return;
        }

        if (msg.type === 'stage3_progress') {
            if (tab) {
                if (tab.stage3Tested !== undefined) tab.stage3Tested++;
                const ipObj = tab.results.find(r => r.ip === msg.data.ip);
                if (ipObj) {
                    ipObj.realDelay = msg.data.realDelay;
                    if (msg.data.realDelay > 0) {
                        termLog('> ⚡ IP: ' + msg.data.ip + ' | Delay: ' + msg.data.realDelay + 'ms');
                    } else {
                        termLog('> ❌ IP: ' + msg.data.ip + ' | Delay: ناموفق');
                    }
                    window.scanScheduleRender(tab);
                }
                updateProgress(tab);
            }
            return;
        }

        // ('v2ray_test_progress' was handled here, with a leftover debug toast that showed
        //  every node id on screen. The delay tester has streamed its results over the
        //  /api/v2ray/test-nodes response body for a long time and nothing broadcasts that
        //  message any more, so the branch and the toast are gone.)

        if (msg.type === 'finished') {

            tab.state = 'done'; 
            if(typeof window.saveToHistory === 'function') window.saveToHistory(tab); else if(typeof saveToHistory === 'function') saveToHistory(tab);
            renderTabs(); renderResults(tab); updateStats(tab); updateProgress(tab);
            termLog('> ✅ Scan complete. ' + tab.alive + ' clean IPs found.'); toast(`✅ اسکن تمام — ${tab.alive} آی‌پی سالم`);
            
            if (typeof window.triggerNotification === 'function') {
                window.triggerNotification('scanFinished', 'اسکن تمام شد', `اسکن با موفقیت به پایان رسید. ${tab.alive} آی‌پی سالم پیدا شد.`);
            }
            // A scan that found nothing is a failure with a known cause and a known next step,
            // so it goes to the assistant rather than leaving the user in front of an empty table.
            if (!tab.alive && window.MVAssistant && typeof window.MVAssistant.trouble === 'function') {
                try { window.MVAssistant.trouble({ kind: 'scan-empty', detail: tab.isp || '' }); } catch (e) { /* the table still says it */ }
            }
        }
    };
    ws.onclose = () => setTimeout(connectWS, 2000);
}

// ===== Scan =====



// Expose functions to global scope for app.js
window.getSelectedCdns = getSelectedCdns;
window.getSelectedPorts = getSelectedPorts;
window.toggleSection = toggleSection;
