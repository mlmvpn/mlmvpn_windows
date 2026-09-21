// ip-provider.js — دریافت خودکار لیست آیپی‌های CDN
const https = require('https');

// رنج‌های آکامای (رسمی Site Shield)
const AKAMAI_RANGES = [
  '2.16.0.0/13',
  '23.0.0.0/12',
  '23.32.0.0/11',
  '23.192.0.0/11',
  '95.100.0.0/15',
  '184.24.0.0/13'
];

// رنج‌های پشتیبان Cloudflare (در صورت عدم دسترسی به API)
const CF_FALLBACK = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22',
  '103.31.4.0/22', '141.101.64.0/18', '108.162.192.0/18',
  '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22',
  '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22'
];

/** دریافت رنج‌های Cloudflare از API رسمی */
function fetchCloudflareRanges() {
  return new Promise((resolve) => {
    const req = https.get('https://www.cloudflare.com/ips-v4', { headers: { 'User-Agent': 'MLMVPN-Scanner' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const ranges = data.trim().split('\n').filter(l => l.trim());
        resolve(ranges.length > 0 ? ranges : CF_FALLBACK);
      });
    });
    req.on('error', () => resolve(CF_FALLBACK));
    req.setTimeout(10000, () => { req.destroy(); resolve(CF_FALLBACK); });
  });
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'MLMVPN-Scanner' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// 1. Fastly
async function fetchFastlyRanges() {
  try {
    const data = await fetchJson('https://api.fastly.com/public-ip-list');
    if (data && data.addresses) return data.addresses;
  } catch (e) {}
  return ['151.101.0.0/16', '199.232.0.0/16', '146.75.0.0/16']; // Fallback
}

// 2. AWS CloudFront
async function fetchAwsRanges() {
  try {
    const data = await fetchJson('https://ip-ranges.amazonaws.com/ip-ranges.json');
    if (data && data.prefixes) {
      return data.prefixes.filter(p => p.service === 'CLOUDFRONT' && p.ip_prefix).map(p => p.ip_prefix);
    }
  } catch (e) {}
  return ['13.224.0.0/14', '13.32.0.0/15', '18.64.0.0/14', '18.68.0.0/16']; // Fallback
}

// 3. Google Cloud CDN
async function fetchGoogleRanges() {
  try {
    const data = await fetchJson('https://www.gstatic.com/ipranges/cloud.json');
    if (data && data.prefixes) {
      return data.prefixes.map(p => p.ipv4Prefix).filter(Boolean);
    }
  } catch (e) {}
  return ['34.80.0.0/15', '34.96.0.0/13', '35.192.0.0/14']; // Fallback
}

// 4. Azure & Gcore (BGPView)
async function fetchAsnRanges(asn) {
  try {
    const data = await fetchJson(`https://api.bgpview.io/asn/${asn}/prefixes`);
    if (data && data.status === 'ok' && data.data && data.data.ipv4_prefixes) {
      return data.data.ipv4_prefixes.map(p => p.prefix);
    }
  } catch (e) {}
  return [];
}

async function fetchAzureRanges() {
  const r = await fetchAsnRanges(8075);
  return r.length ? r : ['13.64.0.0/11', '13.96.0.0/13', '20.33.0.0/16'];
}

async function fetchGcoreRanges() {
  const r = await fetchAsnRanges(199524);
  return r.length ? r : ['92.223.0.0/16', '146.185.240.0/20'];
}

function ipToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(x => isNaN(x) || x < 0 || x > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIp(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function cidrInfo(cidr) {
  const [ip, bits] = cidr.split('/');
  const b = parseInt(bits, 10);
  if (isNaN(b) || b < 0 || b > 32) return null;
  const ipInt = ipToInt(ip);
  if (ipInt === null) return null;
  if (b === 32) return { start: ipInt, count: 1 };
  if (b === 0) return { start: 0, count: 0x100000000 };
  const hostBits = 32 - b;
  const count = Math.pow(2, hostBits);
  const mask = (0xffffffff << hostBits) >>> 0;
  const network = (ipInt & mask) >>> 0;
  return { start: network, count };
}

function normalizeRangeEntry(entry) {
  if (typeof entry === 'string') return { cidr: entry, provider: 'generic' };
  if (entry && typeof entry.cidr === 'string') {
    return { cidr: entry.cidr, provider: entry.provider || 'generic' };
  }
  return null;
}

/** نمونه‌گیری تصادفی از رنج‌ها */

function isIPv6Cidr(cidr) {
  return cidr.includes(':');
}

function expandIPv6(cidr) {
  // Simple /48 expander for WARP
  const [prefix, bits] = cidr.split('/');
  return { prefix, bits: parseInt(bits, 10) };
}

function randomHex16() {
  return Math.floor(Math.random() * 65536).toString(16);
}

function sampleIPv6Ranges(ranges, count) {
  const ips = [];
  if (!ranges.length || count <= 0) return [];
  
  // برای جلوگیری از کرش کردن حافظه (V8 String limit) روی مقادیر خیلی بزرگ
  const safeCount = Math.min(count, 1500000); 

  for(let i=0; i<safeCount; i++) {
    const range = ranges[Math.floor(Math.random() * ranges.length)];
    if (range.bits === 48) {
      let parts = range.prefix.split(':').filter(Boolean);
      if (parts.length >= 3) {
        const base = `${parts[0]}:${parts[1]}:${parts[2]}`;
        // ساخت سریع
        const ip = base + ':' + Math.floor(Math.random() * 65536).toString(16) + ':' + Math.floor(Math.random() * 65536).toString(16) + ':' + Math.floor(Math.random() * 65536).toString(16) + ':' + Math.floor(Math.random() * 65536).toString(16) + ':' + Math.floor(Math.random() * 65536).toString(16);
        ips.push({ ip, provider: range.provider });
      }
    }
  }
  return ips;
}

function sampleFromRanges(ranges, maxIps) {
  if (maxIps <= 0) return [];

  const normalized = ranges.map(normalizeRangeEntry).filter(Boolean);
  
  const ipv6Entries = normalized.filter(e => isIPv6Cidr(e.cidr));
  const ipv4Entries = normalized.filter(e => !isIPv6Cidr(e.cidr));

  let v6Samples = [];
  if (ipv6Entries.length > 0) {
    const v6Parsed = ipv6Entries.map(e => ({ ...expandIPv6(e.cidr), provider: e.provider }));
    // Divide maxIps proportionally or just take half if both exist
    let v6Count = maxIps;
    if (ipv4Entries.length > 0) v6Count = Math.floor(maxIps / 2);
    v6Samples = sampleIPv6Ranges(v6Parsed, v6Count);
  }

  let v4Samples = [];
  if (ipv4Entries.length > 0) {
    let v4Count = maxIps - v6Samples.length;
    
    const parsed = ipv4Entries.map((entry) => {
      const info = cidrInfo(entry.cidr);
      return info ? { ...info, provider: entry.provider } : null;
    }).filter(Boolean);

    if (parsed.length > 0) {
      const totalAvailable = parsed.reduce((s, r) => s + r.count, 0);
      if (totalAvailable <= v4Count) {
        const ips = new Map();
        for (const r of parsed) {
          for (let i = 0; i < r.count; i++) {
            const ip = intToIp((r.start + i) >>> 0);
            if (!ips.has(ip)) ips.set(ip, { ip, provider: r.provider });
          }
        }
        v4Samples = Array.from(ips.values());
      } else {
        const ips = new Map();
        const cumulative = [];
        let runningTotal = 0;
        for (const r of parsed) {
          runningTotal += r.count;
          cumulative.push(runningTotal);
        }

        v4Count = Math.min(v4Count, 1500000);
        let attempts = 0;
        const maxAttempts = Math.max(v4Count * 30, 500);
        while (ips.size < v4Count && attempts < maxAttempts) {
          const pick = Math.floor(Math.random() * totalAvailable);
          let left = 0;
          let right = cumulative.length - 1;

          while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (pick < cumulative[mid]) right = mid;
            else left = mid + 1;
          }

          const range = parsed[left];
          const offset = Math.floor(Math.random() * range.count);
          const ip = intToIp((range.start + offset) >>> 0);
          if (!ips.has(ip)) ips.set(ip, { ip, provider: range.provider });
          attempts++;
        }

        if (ips.size < v4Count) {
          for (const r of parsed) {
            for (let i = 0; i < r.count && ips.size < v4Count; i++) {
              const ip = intToIp((r.start + i) >>> 0);
              if (!ips.has(ip)) ips.set(ip, { ip, provider: r.provider });
            }
            if (ips.size >= v4Count) break;
          }
        }
        v4Samples = Array.from(ips.values());
      }
    }
  }

  // Combine and shuffle
  const combined = [...v6Samples, ...v4Samples];
  for (let i = combined.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [combined[i], combined[j]] = [combined[j], combined[i]];
  }

  return combined.slice(0, maxIps);
}

/** پارس ورودی دستی کاربر */
function parseUserInput(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const ranges = [];
  const singleIps = [];
  let currentProvider = 'custom';

  for (const line of lines) {
    if (line.startsWith('#')) {
      const p = line.substring(1).trim().toLowerCase();
      if (['cloudflare', 'akamai', 'fastly', 'cloudfront', 'google', 'azure', 'gcore'].includes(p)) {
        currentProvider = p;
      }
      continue;
    }

    if (line.includes('/')) {
      ranges.push({ cidr: line, provider: currentProvider });
    } else if (line.includes('-')) {
      const [start, end] = line.split('-').map(s => s.trim());
      const s = ipToInt(start), e = ipToInt(end);
      if (s !== null && e !== null && e >= s) {
        const count = Math.min(e - s + 1, 10000);
        for (let i = 0; i < count; i++) singleIps.push({ ip: intToIp((s + i) >>> 0), provider: currentProvider });
      }
    } else {
      let ipStr = line;
      if (ipStr.includes(':')) {
        const parts = ipStr.split(':');
        // If it's not an IPv6 address, strip the port
        if (parts.length === 2) {
          ipStr = parts[0];
        }
      }
      if (ipStr.includes(":") || ipToInt(ipStr) !== null) {
        singleIps.push({ ip: ipStr, provider: currentProvider });
      }
    }
  }
  return { ranges, singleIps };
}

module.exports = { AKAMAI_RANGES, fetchCloudflareRanges, fetchFastlyRanges, fetchAwsRanges, fetchGoogleRanges, fetchAzureRanges, fetchGcoreRanges, sampleFromRanges, parseUserInput, ipToInt, intToIp };
