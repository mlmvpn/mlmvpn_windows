// --- header-traffic Module ---
const headertrafficHtmlTemplate = `<div
          id="header-traffic"
          style="
            font-family:
              'Vazirmatn', 'IRANSans', Tahoma, sans-serif;
            font-size: 12.5px;
            display: flex;
            align-items: center;
            gap: 14px;
            background: transparent;
            /* Same fixed height as the راهنما / درباره ما buttons so all three
               sit on one line with identical breathing room above and below. */
            height: 28px;
            padding: 0 10px;
            border-radius: 7px;
            border: none;
            color: var(--ide-text-main);
          "
        >
          <div
            title="مجموع داده دریافت‌شده از طریق تونل در این نشست"
            style="display: flex; align-items: center; gap: 6px"
          >
            <svg
              style="width: 15px; height: 15px; color: var(--syn-blue)"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="12" y1="5" x2="12" y2="19"></line>
              <polyline points="19 12 12 19 5 12"></polyline>
            </svg>
            <span>دانلود</span>
            <span
              id="traffic-down"
              style="
                font-family:
                  'Fira Code', 'JetBrains Mono', monospace;
                color: var(--syn-blue);
                font-weight: 600;
                direction: ltr;
                /* A fixed 65px well was reserved here, which is why "0 B" sat so
                   far from its label. The value now sizes to its content and
                   pushes the row wider on its own when it grows; tabular figures
                   keep it from twitching digit by digit. */
                font-variant-numeric: tabular-nums;
                min-width: 30px;
                white-space: nowrap;
              "
              >0 B</span
            >
          </div>

          <div
            style="
              width: 1px;
              height: 14px;
              background: var(--mv-fill-2);
            "
          ></div>

          <div
            title="مجموع داده ارسال‌شده از طریق تونل در این نشست"
            style="display: flex; align-items: center; gap: 6px"
          >
            <svg
              style="width: 15px; height: 15px; color: var(--mv-orange-ink)"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <line x1="12" y1="19" x2="12" y2="5"></line>
              <polyline points="5 12 12 5 19 12"></polyline>
            </svg>
            <span>آپلود</span>
            <span
              id="traffic-up"
              style="
                font-family:
                  'Fira Code', 'JetBrains Mono', monospace;
                color: var(--mv-orange-ink);
                font-weight: 600;
                direction: ltr;
                font-variant-numeric: tabular-nums;
                min-width: 30px;
                white-space: nowrap;
              "
              >0 B</span
            >
          </div>
        </div>`;

function initHeaderTrafficModule() {
    const container = document.getElementById('header-traffic-module-container');
    if (container) {
        container.innerHTML = headertrafficHtmlTemplate;
        console.log('header-traffic module HTML injected.');
        startHeaderTrafficPolling();
    }
}

function startHeaderTrafficPolling() {
    if(window.headerTrafficInterval) clearInterval(window.headerTrafficInterval);
    
    // Poll the backend API every second to keep the header UI updated
    window.headerTrafficInterval = setInterval(async () => {
        try {
            const res = await fetch('/api/v2ray/traffic');
            const data = await res.json();
            updateHeaderTrafficUI(data);
        } catch(e) {}
    }, 1000);
}

function updateHeaderTrafficUI(data) {
    if(!data || !data.today) return;
    const formatBytes = window.formatBytes || function(bytes) {
        if (!+bytes) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };
    
    const hTraffic = document.getElementById('header-traffic');
    const upEl = document.getElementById('traffic-up');
    const downEl = document.getElementById('traffic-down');
    
    if (document.getElementById('setting-disable-total-traffic') && document.getElementById('setting-disable-total-traffic').checked) {
        if (upEl) upEl.textContent = '-';
        if (downEl) downEl.textContent = '-';
    } else {
        if (upEl) upEl.textContent = formatBytes(data.today.up);
        if (downEl) downEl.textContent = formatBytes(data.today.down);
    }
    
    if (hTraffic) hTraffic.style.display = 'flex';
}
