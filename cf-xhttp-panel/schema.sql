-- اسکیمای مرجع (ورکر این جدول‌ها را به‌صورت خودکار با ensureSchema می‌سازد)
-- برای ساخت دستی: wrangler d1 execute xhttp-panel-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  uuid TEXT,
  limit_gb REAL,            -- سقف مصرف کل (GB)
  daily_limit_gb REAL,     -- سقف مصرف روزانه (GB)
  expiry_days INTEGER,     -- مدت اعتبار (روز)
  ips TEXT,
  connection_type TEXT,
  tls TEXT,
  port INTEGER,
  used_gb REAL DEFAULT 0,        -- مصرف کل
  daily_used_gb REAL DEFAULT 0,  -- مصرف امروز
  daily_reset_at INTEGER DEFAULT 0, -- زمان آخرین بازنشانی روزانه
  is_active INTEGER DEFAULT 1,   -- 1=فعال، 0=بن
  last_active INTEGER,
  fingerprint TEXT DEFAULT 'chrome',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
