// --- live-speed Module ---
const livespeedHtmlTemplate = "<div\n          id=\"live-speed\"\n          style=\"\n            display: flex;\n            align-items: center;\n            gap: 8px;\n            font-size: 11px;\n            color: var(--ide-text-dim);\n            font-family:var(--mv-font-mono);\n          \"\n        >\n          <span\n            style=\"\n              font-family:\n                &quot;Vazirmatn&quot;, &quot;IRANSans&quot;, Tahoma, sans-serif;\n            \"\n            >سرعت لحظه ای:</span\n          >\n          <span style=\"color: var(--syn-cyan)\"\n            >↑<span id=\"speed-up\">0 B/s</span></span\n          >\n          <span style=\"color: var(--syn-green)\"\n            >↓<span id=\"speed-down\">0 B/s</span></span\n          >\n        </div>";

function initLiveSpeedModule() {
    const container = document.getElementById('live-speed-module-container');
    if (container) {
        container.innerHTML = livespeedHtmlTemplate;
        console.log('live-speed module HTML injected.');
    }
}

function updateLiveSpeed(t) {
    const formatBytes = window.formatBytes || function(bytes) { return bytes + ' B'; };
    const speedUp = document.getElementById('speed-up');
    const speedDown = document.getElementById('speed-down');
    
    if (!(document.getElementById('setting-disable-live-speed') && document.getElementById('setting-disable-live-speed').checked)) {
        if (speedUp) speedUp.textContent = formatBytes(t.speed.up) + '/s';
        if (speedDown) speedDown.textContent = formatBytes(t.speed.down) + '/s';
    } else {
        if (speedUp) speedUp.textContent = '-';
        if (speedDown) speedDown.textContent = '-';
    }
}


// HTTP polling fallback for live speed
let _liveSpeedInterval = null;
let _lastSpeedStats = null;
let _lastSpeedTime = null;

function startLiveSpeedPolling() {
    if (_liveSpeedInterval) clearInterval(_liveSpeedInterval);
    _lastSpeedStats = null;
    _lastSpeedTime = Date.now();
    
    _liveSpeedInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/v2ray/traffic');
            const data = await res.json();
            const now = Date.now();
            
            if (_lastSpeedStats) {
                const dt = (now - _lastSpeedTime) / 1000;
                if (dt > 0) {
                    const speedUp = Math.max(0, (data.sessionUp - _lastSpeedStats.sessionUp) / dt);
                    const speedDown = Math.max(0, (data.sessionDown - _lastSpeedStats.sessionDown) / dt);
                    const sample = { speed: { up: speedUp, down: speedDown } };
                    updateLiveSpeed(sample);
                    // The socket is the usual source of this event; when it is down and we are
                    // polling instead, the live charts should keep drawing rather than freeze.
                    try { document.dispatchEvent(new CustomEvent('mv-traffic', { detail: sample })); } catch (e) { }
                }
            }
            
            _lastSpeedStats = data;
            _lastSpeedTime = now;
        } catch(e) {}
    }, 1000);
}

function stopLiveSpeedPolling() {
    if (_liveSpeedInterval) clearInterval(_liveSpeedInterval);
    _liveSpeedInterval = null;
    _lastSpeedStats = null;
    const speedUp = document.getElementById('speed-up');
    const speedDown = document.getElementById('speed-down');
    if (speedUp) speedUp.textContent = '0 B/s';
    if (speedDown) speedDown.textContent = '0 B/s';
}
