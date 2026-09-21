async function initSpeedTestModule() {
  const container = document.getElementById('speed-test-module-container');
  if (!container) return;

  // Laid out with the page kit (ui/page-kit.css), like every Settings pane.
  container.innerHTML = "<div id=\"panel-set-speed\" class=\"settings-panel-content mv-form\" style=\"display: none\">\n  <div class=\"mv-form-hero\">\n    <span class=\"mv-side-tile\" style=\"--tint:var(--mv-green)\"><i class=\"ph-fill ph-gauge\"></i></span>\n    <div><h2>تست سرعت</h2><p>پینگ، دانلود و آپلود اینترنت شما — با آدرس‌هایی که در «V2Ray پیشرفته» انتخاب کرده‌اید.</p></div>\n  </div>\n  <div class=\"mv-form-section\">\n    <div class=\"mv-form-group\">\n      <div class=\"mv-metrics\">\n        <div class=\"mv-metric\"><span>پینگ</span><b id=\"speed-test-ping\">--</b><small>ms</small></div>\n        <div class=\"mv-metric\"><span>دانلود</span><b id=\"speed-test-down\">--</b><small>Mbps</small></div>\n        <div class=\"mv-metric\"><span>آپلود</span><b id=\"speed-test-up\">--</b><small>Mbps</small></div>\n      </div>\n      <div class=\"mv-form-row\" style=\"justify-content:center;padding-bottom:16px\">\n        <button id=\"btn-start-speed-test\" class=\"mv-btn mv-btn--lg mv-btn--primary\" onclick=\"window.startLocalSpeedTest()\">\n          <svg class=\"w-5 h-5\" fill=\"none\" stroke=\"currentColor\" viewBox=\"0 0 24 24\"><path stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"2\" d=\"M13 10V3L4 14h7v7l9-11h-7z\" /></svg>\n          شروع تست سرعت\n        </button>\n      </div>\n    </div>\n  </div>\n</div>\n";
}

// Ensure the function is globally accessible
window.initSpeedTestModule = initSpeedTestModule;

window.startLocalSpeedTest = async function () {
  const pingEl = document.getElementById('speed-test-ping');
  const downEl = document.getElementById('speed-test-down');
  const upEl = document.getElementById('speed-test-up');
  const btn = document.getElementById('btn-start-speed-test');

  if (!pingEl || !downEl || !upEl || !btn) return;

  // Reset UI
  pingEl.textContent = '...';
  downEl.textContent = '...';
  upEl.textContent = '...';
  btn.disabled = true;
  btn.innerHTML = '<svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> در حال تست...';

  const pingUrl = document.getElementById('setting-ping-url')?.value || 'https://www.google.com/generate_204';
  const downloadUrl = document.getElementById('setting-speed-url')?.value || 'https://speed.cloudflare.com/__down?bytes=10000000';
  const timeoutMs = (parseInt(document.getElementById('setting-speed-timeout')?.value) || 10) * 1000;

  try {
    // 1. Test Ping
    let start = performance.now();
    try {
      await fetch(pingUrl, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      await fetch(pingUrl, { mode: 'no-cors', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    }
    const pingTime = Math.round(performance.now() - start);
    pingEl.textContent = pingTime;

    // 2. Test Download
    start = performance.now();
    const response = await fetch(downloadUrl, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    const reader = response.body.getReader();
    let receivedBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.length;
    }
    const duration = (performance.now() - start) / 1000; // in seconds
    const downMbps = ((receivedBytes * 8) / (1000 * 1000)) / duration;
    downEl.textContent = downMbps.toFixed(2);

    // 3. Test Upload
    const uploadPayload = new Uint8Array(1024 * 1024); // 1 MB
    start = performance.now();
    try {
        await fetch(pingUrl, {
            method: 'POST',
            body: uploadPayload,
            mode: 'no-cors',
            cache: 'no-store',
            signal: AbortSignal.timeout(timeoutMs)
        });
        const upDuration = (performance.now() - start) / 1000;
        const upMbps = ((uploadPayload.length * 8) / (1000 * 1000)) / upDuration;
        upEl.textContent = upMbps.toFixed(2);
    } catch(err) {
        upEl.textContent = "N/A";
    }

  } catch (err) {
    console.error('Speed test error:', err);
    if(pingEl.textContent === '...') pingEl.textContent = 'Err';
    if(downEl.textContent === '...') downEl.textContent = 'Err';
    if(upEl.textContent === '...') upEl.textContent = 'Err';
    if (typeof toast === 'function') toast('خطا در ارتباط. لطفا اینترنت خود را بررسی کنید.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg> شروع مجدد تست';
  }
};

// Use Cloudflare's dedicated speed-test APIs. The old implementation sent the
// upload payload to the ping URL, which is not an upload test endpoint.
const CLOUDFLARE_SPEED_BASE = 'https://speed.cloudflare.com';
const SPEED_TEST_TIMEOUT_MS = 30000;

function speedTestUrl(path, params = {}) {
  const url = new URL(`${CLOUDFLARE_SPEED_BASE}${path}`);
  Object.entries({ ...params, cacheBust: `${Date.now()}-${Math.random()}` }).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });
  return url.toString();
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function responseBytes(response) {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) return (await response.arrayBuffer()).byteLength;

  const reader = response.body.getReader();
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) return bytes;
    bytes += value.byteLength;
  }
}

async function measureLatency() {
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    const url = speedTestUrl('/__down', { bytes: 0 });
    performance.clearResourceTimings?.();
    const startedAt = performance.now();
    const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(SPEED_TEST_TIMEOUT_MS) });
    await responseBytes(response);

    // responseStart - requestStart is the HTTP round-trip to the nearest edge.
    const timing = performance.getEntriesByName(url).pop();
    const requestStart = timing?.requestStart || 0;
    const responseStart = timing?.responseStart || 0;
    samples.push(responseStart > requestStart ? responseStart - requestStart : performance.now() - startedAt);
  }
  return median(samples);
}

async function measureBandwidth(direction, bytes) {
  const endpoint = direction === 'download' ? '/__down' : '/__up';
  const request = async (size) => {
    const options = {
      method: direction === 'upload' ? 'POST' : 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(SPEED_TEST_TIMEOUT_MS)
    };
    if (direction === 'upload') options.body = new Blob([new Uint8Array(size)]);
    const startedAt = performance.now();
    const transferredBytes = await responseBytes(await fetch(speedTestUrl(endpoint, { bytes: size }), options));
    return { transferredBytes, seconds: (performance.now() - startedAt) / 1000 };
  };

  // Warm up the connection so TLS and TCP setup are not reported as bandwidth.
  await request(100000);
  const samples = [await request(bytes), await request(bytes)];
  const mbps = samples.map(({ transferredBytes, seconds }) => {
    const actualBytes = direction === 'upload' ? bytes : transferredBytes;
    if (!actualBytes || seconds <= 0) throw new Error('No test data received');
    return (actualBytes * 8) / 1000000 / seconds;
  });
  return Math.max(...mbps);
}

window.startLocalSpeedTest = async function () {
  const pingEl = document.getElementById('speed-test-ping');
  const downEl = document.getElementById('speed-test-down');
  const upEl = document.getElementById('speed-test-up');
  const btn = document.getElementById('btn-start-speed-test');
  if (!pingEl || !downEl || !upEl || !btn) return;

  pingEl.textContent = '...';
  downEl.textContent = '...';
  upEl.textContent = '...';
  btn.disabled = true;
  btn.innerHTML = '<svg class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg> در حال تست...';

  try {
    pingEl.textContent = Math.round(await measureLatency());
    downEl.textContent = (await measureBandwidth('download', 10_000_000)).toFixed(2);
    upEl.textContent = (await measureBandwidth('upload', 10_000_000)).toFixed(2);
  } catch (error) {
    console.error('Speed test error:', error);
    if (pingEl.textContent === '...') pingEl.textContent = 'Err';
    if (downEl.textContent === '...') downEl.textContent = 'Err';
    if (upEl.textContent === '...') upEl.textContent = 'Err';
    if (typeof toast === 'function') toast('خطا در تست سرعت. اتصال اینترنت یا VPN را بررسی کنید.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg> شروع مجدد تست';
  }
};
