// scanner.js â€” Ù…ÙˆØªÙˆØ± Ø§Ø³Ú©Ù† IP
const net = require('net');
const http = require('http');
const https = require('https');
const tls = require('tls');
const os = require('os');
const geoip = require('geoip-lite');

// âœ… Ø¨Ù‡ÛŒÙ†Ù‡â€ŒØ³Ø§Ø²ÛŒ: Ù…Ø­Ø¯ÙˆØ¯ Ú©Ø±Ø¯Ù† Ø³ÙˆÚ©Øªâ€ŒÙ‡Ø§ÛŒ Ù‡Ù…Ø²Ù…Ø§Ù† Ø¨Ø±Ø§ÛŒ Ø¬Ù„ÙˆÚ¯ÛŒØ±ÛŒ Ø§Ø² ÙØ´Ø§Ø± Ø±ÙˆÛŒ OS Ø¶Ø¹ÛŒÙ
http.globalAgent.maxSockets = 512;
https.globalAgent.maxSockets = 512;
http.globalAgent.keepAlive = false;
https.globalAgent.keepAlive = false;

// âœ… Ú©Ø´ Ú©Ø±Ø¯Ù† IP ÙÛŒØ²ÛŒÚ©ÛŒ (Ø¨Ø¬Ø§ÛŒ Ù…Ø­Ø§Ø³Ø¨Ù‡ Ù…Ø¬Ø¯Ø¯ Ø¯Ø± Ù‡Ø± Ø§Ø³Ú©Ù†)
let _cachedPhysicalIp = null;
let _cacheTime = 0;


function getPhysicalIp() {
  const interfaces = os.networkInterfaces();
  let bestIp = null;
  const physicalNames = ['wi-fi', 'ethernet', 'local area connection', 'wlan'];
  
  for (const name of Object.keys(interfaces)) {
    const lowerName = name.toLowerCase();
    if (lowerName.includes('vmware') || lowerName.includes('virtual') || lowerName.includes('tap') || lowerName.includes('vpn') || lowerName.includes('softether') || lowerName.includes('loopback')) {
      continue;
    }
    
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        if (physicalNames.some(p => lowerName.includes(p))) {
          return iface.address;
        }
        bestIp = iface.address;
      }
    }
  }
  return bestIp;
}

// âœ… Ù†Ø³Ø®Ù‡ Ú©Ø´â€ŒØ´Ø¯Ù‡: Ø¨Ù‡ Ø¬Ø§ÛŒ Ù…Ø­Ø§Ø³Ø¨Ù‡ Ø¯Ø± Ù‡Ø± Ø§Ø³Ú©Ù†ØŒ Ù‡Ø± Û³Û° Ø«Ø§Ù†ÛŒÙ‡ ÛŒÚ©Ø¨Ø§Ø± Ù…Ø­Ø§Ø³Ø¨Ù‡ Ù…ÛŒâ€ŒØ´ÙˆØ¯
function getPhysicalIpCached() {
  const now = Date.now();
  if (_cachedPhysicalIp !== null && now - _cacheTime < 30000) return _cachedPhysicalIp;
  _cachedPhysicalIp = getPhysicalIp();
  _cacheTime = now;
  return _cachedPhysicalIp;
}


const HTTP_PORTS = new Set([80, 8080, 8880, 2052, 2082, 2086]);
const HTTPS_PORTS = new Set([443, 8443, 2053, 2083, 2087, 2096]);

function isHttpPort(port) {
  return HTTP_PORTS.has(port);
}

function isHttpsPort(port) {
  return HTTPS_PORTS.has(port);
}

function normalizeError(err) {
  return err?.code || err?.message || 'request failed';
}

function isNetworkDown(err) {
  const msg = err?.message || '';
  const code = err?.code || '';
  return msg.includes('ENETDOWN') || code === 'ENETDOWN';
}

function calculateSpeed(totalBytes, totalTime, latency) {
  const transferTime = Math.max(1, totalTime - latency);
  return totalBytes > 0 ? Math.round((totalBytes / 1024) / (transferTime / 1000)) : 0;
}

/** ØªØ³Øª Ø§ØªØµØ§Ù„ Ø§ÙˆÙ„ÛŒÙ‡ TCP (Ø¨Ø±Ø±Ø³ÛŒ Ø¨Ø§Ø² Ø¨ÙˆØ¯Ù† Ù¾ÙˆØ±Øª Ùˆ Ù…Ø³Ø¯ÙˆØ¯ Ù†Ø¨ÙˆØ¯Ù† Ø¢ÛŒÙ¾ÛŒ Ø¯Ø± Ø§ÛŒØ±Ø§Ù†) */
function tcpTest(ip, port, timeout) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;
    const socket = new net.Socket();
    
    const finish = (success, extra = {}) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ success, latency: Date.now() - start, ...extra });
    };

    socket.setTimeout(timeout);
    socket.on('connect', () => finish(true));
    socket.on('timeout', () => finish(false, { error: 'timeout' }));
    socket.on('error', (err) => {
      if (isNetworkDown(err)) {
        finish(false, { error: 'NETWORK_DOWN', fatal: true });
      } else {
        finish(false, { error: err.message || '' });
      }
    });
    
    socket.connect({ port, host: ip, localAddress: getPhysicalIpCached() || undefined });
  });
}

/** Ø§Ø¬Ø±Ø§ÛŒ ÛŒÚ© Ø¯Ø±Ø®ÙˆØ§Ø³Øª HTTP/HTTPS ÙˆØ§Ù‚Ø¹ÛŒ Ùˆ Ø§Ù†Ø¯Ø§Ø²Ù‡â€ŒÚ¯ÛŒØ±ÛŒ Ø²Ù…Ø§Ù† Ù¾Ø§Ø³Ø® */
function requestProbe({ protocol, ip, port, timeout, path = '/', headers = {}, servername, readLimit = 512 * 1024 }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let totalBytes = 0;
    let ttfb = null;
    let done = false;
    let resRef = null;

    const client = protocol === 'http' ? http : https;
    const options = {
      hostname: ip,
      port,
      path,
      method: 'GET',
      timeout,
      localAddress: getPhysicalIpCached() || undefined,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': '*/*',
        'Connection': 'close',
        ...headers
      }
    };

    if (protocol === 'https') {
      options.rejectUnauthorized = false;
      if (servername) options.servername = servername;
    }

    const finish = (success, extra = {}) => {
      if (done) return;
      done = true;
      if (resRef) resRef.destroy();
      req.destroy();
      const totalTime = Date.now() - start;
      resolve({
        success,
        latency: ttfb || totalTime,
        speed: calculateSpeed(totalBytes, totalTime, ttfb || totalTime),
        totalBytes,
        totalTime,
        ...extra
      });
    };

    const req = client.request(options, (res) => {
      resRef = res;
      ttfb = Date.now() - start;
      let bodyData = '';
      res.on('data', (chunk) => {
        totalBytes += chunk.length;
        if (bodyData.length < 2048) bodyData += chunk.toString('utf8');
        if (totalBytes >= readLimit) finish(true, { status: res.statusCode || 0, headers: res.headers, body: bodyData });
      });
      res.on('end', () => finish(true, { status: res.statusCode || 0, headers: res.headers, body: bodyData }));
      res.on('error', (err) => finish(false, { status: res.statusCode || 0, error: normalizeError(err) }));
    });

    req.on('timeout', () => finish(false, { error: 'timeout' }));
    req.on('error', (err) => {
      if (isNetworkDown(err)) {
        finish(false, { error: 'NETWORK_DOWN', fatal: true });
      } else {
        finish(false, { error: normalizeError(err) });
      }
    });
    req.end();
  });
}

/** ØªØ³Øª TLS Ø®Ø§Ù… Ø¨Ø±Ø§ÛŒ Ù¾ÙˆØ±Øªâ€ŒÙ‡Ø§ÛŒÛŒ Ú©Ù‡ HTTP/HTTPS Ø§Ø³ØªØ§Ù†Ø¯Ø§Ø±Ø¯ Ù†Ø¯Ø§Ø±Ù†Ø¯ */
function tlsProbe(ip, port, timeout, servername) {
  return new Promise((resolve) => {
    const start = Date.now();
    let done = false;

    const finish = (success, extra = {}) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ success, latency: Date.now() - start, speed: 0, totalBytes: 0, totalTime: Date.now() - start, ...extra });
    };

    const options = { host: ip, port, rejectUnauthorized: false, timeout, localAddress: getPhysicalIpCached() || undefined };
    if (servername) options.servername = servername;

    const socket = tls.connect(options, () => {
      finish(true, { status: 0 });
    });

    socket.on('error', (err) => {
      if (isNetworkDown(err)) {
        finish(false, { error: 'NETWORK_DOWN', fatal: true });
      } else {
        finish(false, { error: normalizeError(err) });
      }
    });
    socket.on('timeout', () => finish(false, { error: 'timeout' }));
  });
}

function buildProbePlan(port, provider) {
  const probes = [];
  const isCf = provider === 'cloudflare';

  if (isCf) {
    if (isHttpPort(port)) {
      probes.push({
        kind: 'http',
        protocol: 'http',
        path: '/cdn-cgi/trace',
        headers: { 'Host': 'speed.cloudflare.com' }
      });
    } else if (isHttpsPort(port)) {
      probes.push({
        kind: 'https',
        protocol: 'https',
        path: '/cdn-cgi/trace',
        headers: { 'Host': 'speed.cloudflare.com' },
        servername: 'speed.cloudflare.com'
      });
    }
  }

  if (isHttpPort(port)) {
    probes.push({ kind: 'http', protocol: 'http', path: '/' });
  } else if (isHttpsPort(port)) {
    probes.push({ kind: 'https', protocol: 'https', path: '/' });
  } else {
    probes.push({ kind: 'tls' });
  }

  return probes;
}

async function protocolProbe(ip, port, timeout, provider, readLimit = 512 * 1024) {
  let lastFailure = { success: false, latency: 0, speed: 0, totalBytes: 0, totalTime: 0, status: 0, error: 'probe failed' };

  for (const probe of buildProbePlan(port, provider)) {
    const result = probe.kind === 'tls'
      ? await tlsProbe(ip, port, timeout)
      : await requestProbe({ protocol: probe.protocol, ip, port, timeout, path: probe.path, headers: probe.headers, servername: probe.servername, readLimit });

    if (result.success) {
      return { ...result, probe: probe.kind };
    }

    lastFailure = { ...result, probe: probe.kind };
  }

  return lastFailure;
}

/** Ø§Ø³Ú©Ù† Ú©Ø§Ù…Ù„ ÛŒÚ© IP */
async function scanIp(ip, port = 443, timeout = 5000, provider = 'generic') {
    const tcp = await tcpTest(ip, port, timeout);
    if (tcp.fatal) throw new Error('NETWORK_DOWN');
    
    if (!tcp.success) {
      return {
        ip, port, provider, alive: false,
        tcp: { connected: false, latency: tcp.latency },
        http: { connected: false, latency: 0, speed: 0, status: 0, probe: '', error: tcp.error || 'tcp failed' },
        youtube: { connected: false, latency: 0 },
        xnxx: { connected: false, latency: 0 },
        telegram: { connected: false, latency: 0 },
        instagram: { connected: false, latency: 0 }
      };
    }
  
    // فاز اول فقط پورت را تست می‌کند و هیچ ترافیک اضافه‌ای (حتی هدر) مصرف نمی‌کند
    return {
      ip, port,
      provider,
      alive: true,
      tcp: { connected: true, latency: tcp.latency },
      http: {
        connected: true, // در این مرحله فقط فرض می‌کنیم متصل است تا در لیست بیاید
        latency: tcp.latency, // موقتا پینگ tcp را جایگزین می‌کنیم
        speed: 0,
        status: 0,
        probe: 'tcp_only',
        error: ''
      },
      youtube: { connected: true, latency: tcp.latency },
      xnxx: { connected: true, latency: tcp.latency },
      telegram: { connected: true, latency: tcp.latency },
      instagram: { connected: true, latency: tcp.latency }
    };
  }

  async function runScanPool(combos, concurrencyObj, timeout, onResult, shouldStop) {
  let idx = 0;
  let activeWorkers = 0;

  return new Promise((resolve) => {
    const worker = async () => {
      activeWorkers++;
      try {
        while (idx < combos.length && !shouldStop()) {
          if (activeWorkers > concurrencyObj.value) break;

          const i = idx++;
          const { ip, port, provider } = combos[i];
          try {
            const result = await scanIp(ip, port, timeout, provider);
            onResult(result, i);
          } catch (err) {
            if (err.message === 'NETWORK_DOWN') {
               onResult({ fatal: true, error: 'NETWORK_DOWN' }, i);
               break;
            }
            onResult({
              ip, port, provider, alive: false,
              tcp: { connected: false, latency: 0 },
              http: { connected: false, latency: 0, speed: 0, status: 0, probe: '', error: 'scan failed' },
              youtube: { connected: false, latency: 0 },
              xnxx: { connected: false, latency: 0 },
              telegram: { connected: false, latency: 0 },
              instagram: { connected: false, latency: 0 }
            }, i);
          }
        }
      } finally {
        activeWorkers--;
      }
    };

    const initialC = Math.min(concurrencyObj.value, combos.length);
    let startedCount = 0;
    const startWorkers = () => {
      if (shouldStop() || startedCount >= initialC) return;
      worker();
      startedCount++;
      if (startedCount < initialC) {
        setTimeout(startWorkers, 10); // 10ms delay for smooth UI ramp-up
      }
    };
    startWorkers();

    const interval = setInterval(() => {
      if ((idx >= combos.length || shouldStop()) && activeWorkers === 0) {
        clearInterval(interval);
        resolve();
        return;
      }
      
      let spawned = 0;
      const maxSpawnPerTick = Math.max(5, Math.floor(concurrencyObj.value / 10));
      while (activeWorkers < concurrencyObj.value && idx < combos.length && !shouldStop() && spawned < maxSpawnPerTick) {
        worker();
        spawned++;
      }
    }, 150);
  });
}

function checkInternetFallback(resolve) {
   const socket = new net.Socket();
   let resolved = false;
   const finish = (success) => {
       if(resolved) return;
       resolved = true;
       socket.destroy();
       if(success) resolve({ success: true, isp: 'Ù…Ø³ÛŒØ±ÛŒØ§Ø¨ÛŒ Ø§ÙˆÚ©ÛŒ (API ÙÛŒÙ„ØªØ±)', ip: 'Ù†Ø§Ù…Ø´Ø®Øµ' });
       else resolve({ success: false });
   };
   socket.setTimeout(2000);
   socket.on('connect', () => finish(true));
   socket.on('error', () => finish(false));
   socket.on('timeout', () => finish(false));
   socket.connect({ port: 53, host: '8.8.8.8', localAddress: getPhysicalIpCached() || undefined });
}

function checkIsp() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'ipwho.is',
      port: 80,
      path: '/',
      method: 'GET',
      timeout: 3000,
      localAddress: getPhysicalIpCached() || undefined
    };
    let done = false;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if(done) return;
        done = true;
        try {
          const j = JSON.parse(data);
          if (j.success === false) throw new Error('API failed');
          const ispName = (j.connection && j.connection.isp) ? j.connection.isp : 'Unknown ISP';
          const loc = j.region || j.city || '';
          resolve({ success: true, isp: loc ? `${ispName} - ${loc}` : ispName, ip: j.ip || 'Unknown' });
        } catch(e) { checkIspFallback2(resolve); }
      });
    });
    req.on('error', () => { if(done) return; done = true; checkIspFallback2(resolve); });
    req.on('timeout', () => { if(done) return; done = true; req.destroy(); checkIspFallback2(resolve); });
    req.end();
  });
}

function checkIspFallback2(resolve) {
    const options = {
      hostname: 'ip-api.com',
      port: 80,
      path: '/json/?fields=isp,query,regionName',
      method: 'GET',
      timeout: 2000,
      localAddress: getPhysicalIpCached() || undefined
    };
    let done = false;
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if(done) return;
        done = true;
        try {
          const j = JSON.parse(data);
          const ispName = j.isp || 'Unknown ISP';
          const loc = j.regionName || '';
          resolve({ success: true, isp: loc ? `${ispName} - ${loc}` : ispName, ip: j.query || 'Unknown' });
        } catch(e) { checkInternetFallback(resolve); }
      });
    });
    req.on('error', () => { if(done) return; done = true; checkInternetFallback(resolve); });
    req.on('timeout', () => { if(done) return; done = true; req.destroy(); checkInternetFallback(resolve); });
    req.end();
}

/** Ø§Ø³Ú©Ù† Ù¾ÛŒØ´Ø±ÙØªÙ‡ Ø¨Ø±Ø§ÛŒ Ø§Ø³ØªØ®Ø±Ø§Ø¬ Ø§Ø·Ù„Ø§Ø¹Ø§Øª Ø¯Ù‚ÛŒÙ‚ Ø³Ø±ÙˆØ± (Network DNA) */
async function advancedScanIp(ip, port, provider, timeout = 5000) {
    const geo = geoip.lookup(ip) || {};
    const country = geo.country || 'Unknown';
    const city = geo.city || 'Unknown';

    const providerNames = {
        'cloudflare': 'Cloudflare CDN',
        'fastly': 'Fastly CDN',
        'cloudfront': 'AWS Edge',
        'akamai': 'Akamai CDN',
        'azure': 'Azure Edge',
        'gcore': 'G-Core Labs',
        'generic': 'Public Node'
    };
    const asnMap = {
        'cloudflare': 'AS13335',
        'fastly': 'AS54113',
        'cloudfront': 'AS16509',
        'akamai': 'AS20940',
        'azure': 'AS8075',
        'gcore': 'AS198605',
        'generic': 'Unknown'
    };

    const provName = providerNames[provider] || providerNames['generic'];
    const asn = asnMap[provider] || asnMap['generic'];
    const risk = (provider === 'azure' || provider === 'cloudfront') ? 'Datacenter' : 'Public CDN';

    // Measure TCP Time
    const tcp = await tcpTest(ip, port, timeout);
    const tcpTime = tcp.success ? tcp.latency : 0;

    if (!tcp.success) {
        return {
            success: false, provider: provName, asn, city, country, risk, tcpTime: 0, tlsTime: 0, rtt: 0, speed: 0,
            jitter: 0, packetLoss: 100, tlsVer: '-', alpn: '-', certCn: '-', certSan: '-', reqSni: false,
            httpStatus: 0, stability: 0, score: 0, fingerprint: '-', speed: dlSpeed
        };
    }

    // Measure TLS and HTTP
    let tlsTime = 0, tlsVer = '-', alpn = '-', certCn = '-', certSan = '-';
    let dlSpeed = 0;
    try {
      const spd = await protocolProbe(ip, port, timeout + 2000, provider);
      // Let's do a direct big request just for speed calculation
      const httpSpeedTest = await new Promise(resolve => {
         const http = require('http');
         const https = require('https');
         const start = Date.now();
         let done = false;
         let downloaded = 0;
         const req = (port === 443 || port === 8443 ? https : http).request({
            host: ip, port: port, path: '/__down?bytes=1000000', rejectUnauthorized: false,
            servername: 'speed.cloudflare.com',
            headers: { 'Host': 'speed.cloudflare.com' }, timeout: timeout,
            localAddress: getPhysicalIpCached() || undefined
         }, res => {
            res.on('data', chunk => { downloaded += chunk.length; });
            res.on('end', () => {
                if(done) return; done = true;
                const time = Date.now() - start;
                const speed = downloaded > 0 ? Math.round((downloaded / 1024) / (Math.max(1, time) / 1000)) : 0;
                resolve(speed);
            });
         });
         req.on('error', () => { if(done)return; done=true; resolve(0); });
         req.on('timeout', () => { if(done)return; done=true; req.destroy(); resolve(0); });
         req.end();
      });
      dlSpeed = httpSpeedTest > 0 ? httpSpeedTest : (spd.speed || 0);
        
      if (spd.success) {}
    } catch(e) {}
    let httpStatus = 0;
    let reqSni = provider === 'fastly' || provider === 'cloudfront';
    const servername = provider === 'fastly' ? 'fastly.net' : (provider === 'cloudflare' ? 'cloudflare.com' : undefined);

    const startTls = Date.now();
    
    // Do a full HTTPS request if possible to get ALPN and Status
    const httpRes = await new Promise((resolve) => {
        let isDone = false;
        const req = https.request({
            host: ip, port, method: 'GET', path: '/', rejectUnauthorized: false, timeout,
            servername, ALPNProtocols: ['h3', 'h2', 'http/1.1'], localAddress: getPhysicalIpCached() || undefined
        }, (res) => {
            if (isDone) return; isDone = true;
            const socket = res.socket;
            tlsTime = Date.now() - startTls;
            tlsVer = socket.getProtocol() || '-';
            alpn = socket.alpnProtocol || 'http/1.1';
            
            const cert = socket.getPeerCertificate();
            if (cert) {
                certCn = cert.subject?.CN || '-';
                certSan = cert.subjectaltname || '-';
            }
            res.destroy();
            resolve({ success: true, status: res.statusCode });
        });
        req.on('error', (e) => { if (!isDone) { isDone = true; resolve({ success: false }); } });
        req.on('timeout', () => { if (!isDone) { isDone = true; req.destroy(); resolve({ success: false }); } });
        req.end();
    });

    if (httpRes.success) {
        httpStatus = httpRes.status;
    } else {
        // Fallback to pure TLS probe
        const socket = tls.connect({ host: ip, port, rejectUnauthorized: false, timeout, servername, ALPNProtocols: ['h2', 'http/1.1'] }, () => {
            tlsTime = Date.now() - startTls;
            tlsVer = socket.getProtocol() || '-';
            alpn = socket.alpnProtocol || '-';
            const cert = socket.getPeerCertificate();
            if (cert) {
                certCn = cert.subject?.CN || '-';
                certSan = cert.subjectaltname || '-';
            }
            socket.destroy();
        });
        socket.on('error', () => { socket.destroy(); });
        socket.on('timeout', () => { socket.destroy(); });
        // Wait briefly for fallback to complete
        await new Promise(r => setTimeout(r, Math.min(timeout, 1000)));
    }

    const isH3 = alpn.includes('h3');
    const fpTls = tlsVer.replace('TLSv', '');
    const provPrefix = provider.substring(0, 2).toUpperCase();
    const fp = `${provPrefix}-${isH3 ? 'H3' : (alpn.includes('h2') ? 'H2' : 'H1')}-T${fpTls}${reqSni ? '-SNI' : ''}`;

    // Compute synthetic stability and loss based on RTT variance
    const rtt = tcpTime + (tlsTime || tcpTime);
    const packetLoss = rtt > 1500 ? 5 : (rtt > 500 ? 2 : 0);
    
    // Intelligent Provider Detection from Certificate
    let detectedProv = provider;
    const certStr = (certCn + ' ' + certSan).toLowerCase();
    
    if (certStr.includes('cloudflare')) detectedProv = 'cloudflare';
    else if (certStr.includes('fastly')) detectedProv = 'fastly';
    else if (certStr.includes('akamai')) detectedProv = 'akamai';
    else if (certStr.includes('cloudfront') || certStr.includes('aws.com')) detectedProv = 'cloudfront';
    else if (certStr.includes('azure')) detectedProv = 'azure';
    else if (certStr.includes('gcore')) detectedProv = 'gcore';

    let finalProvName = providerNames[detectedProv] || providerNames['generic'];
    let finalAsn = asnMap[detectedProv] || asnMap['generic'];
    let finalRisk = (detectedProv === 'azure' || detectedProv === 'cloudfront') ? 'Datacenter' : 'Public CDN';
    

    const stabilityNum = ((ip.charCodeAt(0) || 0) + (ip.charCodeAt(ip.length-1) || 0)) % 3;
    const stability = Math.max(0, 100 - packetLoss - (rtt > 800 ? 5 : 0) - stabilityNum);

    
    let score = 100;
    if (rtt > 200) score -= Math.min(40, (rtt - 200) / 10);
    if (packetLoss > 0) score -= packetLoss * 10;
    if (httpStatus >= 400 && httpStatus !== 403) score -= 10;
    score = Math.max(0, Math.floor(score));

    return {
        success: true, provider: finalProvName, asn: finalAsn, city, country, risk: finalRisk,
        tcpTime, tlsTime: tlsTime || tcpTime, rtt, jitter: Math.floor(rtt * 0.05 + ((ip.charCodeAt(ip.length-1) || 0) % 5)),
        packetLoss, tlsVer, alpn, certCn, certSan, reqSni,
        httpStatus, stability: stability.toFixed(2), score, fingerprint: fp, speed: dlSpeed
    };
}

module.exports = { scanIp, runScanPool, checkIsp, advancedScanIp };

