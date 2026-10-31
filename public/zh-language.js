(function () {
  const STORAGE_KEY = 'mv-language';
  const DEFAULT_LANG = 'zh';

  const TEXT = {
    zh: {
      'راهنما': '帮助',
      'درباره ما': '关于',
      'بستن منو': '关闭菜单',
      'تنظیمات نوتیفیکیشن': '通知设置',
      'دسترسی ویندوز': 'Windows 授权',
      'تب جدید': '新建标签',
      'کپی تب فعلی': '复制当前标签',
      'تنظیمات اسکن': '扫描设置',
      'تاریخچه اسکن‌ها': '扫描历史',
      'تست سرعت': '速度测试',
      'تنظیمات': '设置',
      'ورژن فعلی برنامه MLMVPN شما': '当前软件版本',
      'جهت مشاهده آخرین تغییرات': '查看最新更新',
      'انتخاب آیپی ثابت': '选择固定 IP',
      'تست و انتخاب آیپی برای قفل لوکیشن': '测试并选择用于定位锁定的 IP',
      'پاک‌سازی عمیق DNS': '深度 DNS 清理',
      'انتخاب DNS و پاک کردن ته‌مانده‌ها': '选择 DNS 并清理残留项',
      'دیاگ اینترنت': '网络诊断',
      'وقتی وصل است ولی صفحه‌ای باز نمی‌شود': '网络已连接但页面无法打开时',
      'لیست تغییرات': '更新日志',
      'تازه‌ها و اصلاحات هر نسخه': '每个版本的新功能与修复',
      'جست‌وجو': '搜索',
      'چیزی پیدا نشد.': '未找到结果。',
      'صفحه نمایش': '显示',
      'شبکه': '网络',
      'تنظیمات پیشرفته VPN': '高级 VPN 设置',
      'مصرف': '流量',
      'سیستم': '系统',
      'درباره': '关于',
      'اسکن': '扫描',
      'برنامه': '应用',
      'V2Ray پیشرفته': 'V2Ray 高级设置',
      'ذخیره‌ی خودکار': '自动保存',
      'ذخیره‌ی خودکار حین اسکن': '扫描时自动保存',
      'نتایج اسکنِ در حال اجرا مرتب در تاریخچه ذخیره می‌شوند.': '正在进行的扫描结果会持续保存到历史记录。',
      'هر چند دقیقه یک بار': '每隔几分钟',
      'دقیقه': '分钟',
      'پایان هر اسکن همیشه در تاریخچه ذخیره می‌شود. هر اسکن فقط یک مورد در تاریخچه دارد و در صورت تکرار، آخرین نسخه جایگزین می‌شود.': '每次扫描结束后总会保存到历史记录，每次扫描只保留一条记录，重复扫描会覆盖旧记录。',
      'قطعی اینترنت': '网络中断',
      'توقف هنگام قطعی اینترنت': '网络中断时停止',
      'اگر حین اسکن کارت شبکه قطع شود، اسکن می‌ایستد و با وصل شدن دوباره ادامه پیدا می‌کند.': '若扫描过程中网络卡被断开，扫描会暂停并在恢复后继续。',
      'ترمینال اسکنر': '扫描终端',
      'همهٔ روش‌ها': '全部方式',
      'زبان سیستم': '系统语言',
      'فارسی': 'فار西语',
      'English': 'English',
      '中文': '中文',
      'تغییر زبان': '切换语言',
      'دسترس‌پذیری': '可访问性',
      'منو': '菜单',
      'بخش قبلی': '上一节',
      'بخش بعدی': '下一节',
      'پیش‌فرض': '默认',
      'خودکار': '自动',
      'روشن': '亮色',
      'تاریک': '深色',
      'حساب کلادفلر': 'Cloudflare 账户',
      'کلادفلر، ورکرها و بیشتر': 'Cloudflare、Workers 及更多',
      'منابع حساب': '账户资源',
      'افزودن زبان': '添加语言',
      'حالت‌های زبان': '语言模式',
      'پیشنهادات': '建议',
      'زبان': '语言',
      'کمک': '帮助'
    },
    fa: {
      '帮助': 'راهنما',
      '关于': 'درباره ما',
      '关闭菜单': 'بستن منو',
      '通知设置': 'تنظیمات نوتیفیکیشن',
      'Windows 授权': 'دسترسی ویندوز',
      '新建标签': 'تب جدید',
      '复制当前标签': 'کپی تب فعلی',
      '扫描设置': 'تنظیمات اسکن',
      '扫描历史': 'تاریخچه اسکن‌ها',
      '速度测试': 'تست سرعت',
      '设置': 'تنظیمات',
      '当前软件版本': 'ورژن فعلی برنامه MLMVPN شما',
      '查看最新更新': 'جهت مشاهده آخرین تغییرات',
      '选择固定 IP': 'انتخاب آیپی ثابت',
      '测试并选择用于定位锁定的 IP': 'تست و انتخاب آیپی برای قفل لوکیشن',
      '深度 DNS 清理': 'پاک‌سازی عمیق DNS',
      '选择 DNS 并清理残留项': 'انتخاب DNS و پاک کردن ته‌مانده‌ها',
      '网络诊断': 'دیاگ اینترنت',
      '网络已连接但页面无法打开时': 'وقتی وصل است ولی صفحه‌ای باز نمی‌شود',
      '更新日志': 'لیست تغییرات',
      '每个版本的新功能与修复': 'تازه‌ها و اصلاحات هر نسخه',
      '搜索': 'جست‌وجو',
      '未找到结果。': 'چیزی پیدا نشد.',
      '显示': 'صفحه نمایش',
      '网络': 'شبکه',
      '高级 VPN 设置': 'تنظیمات پیشرفته VPN',
      '流量': 'مصرف',
      '系统': 'سیستم',
      '关于': 'درباره',
      '扫描': 'اسکن',
      '应用': 'برنامه',
      'V2Ray 高级设置': 'V2Ray پیشرفته',
      '自动保存': 'ذخیره‌ی خودکار',
      '扫描时自动保存': 'ذخیره‌ی خودکار حین اسکن',
      '正在进行的扫描结果会持续保存到历史记录。': 'نتایج اسکنِ در حال اجرا مرتب در تاریخچه ذخیره می‌شوند.',
      '每隔几分钟': 'هر چند دقیقه یک بار',
      '分钟': 'دقیقه',
      '每次扫描结束后总会保存到历史记录，每次扫描只保留一条记录，重复扫描会覆盖旧记录。': 'پایان هر اسکن همیشه در تاریخچه ذخیره می‌شود. هر اسکن فقط یک مورد در تاریخچه دارد و در صورت تکرار، آخرین نسخه جایگزین می‌شود.',
      '网络中断': 'قطعی اینترنت',
      '网络中断时停止': 'توقف هنگام قطعی اینترنت',
      '若扫描过程中网络卡被断开，扫描会暂停并在恢复后继续。': 'اگر حین اسکن کارت شبکه قطع شود، اسکن می‌ایستد و با وصل شدن دوباره ادامه پیدا می‌کند.',
      '扫描终端': 'ترمینال اسکنر',
      '全部方式': 'همهٔ روش‌ها',
      '系统语言': 'زبان سیستم',
      'فار西语': 'فارسی',
      'English': 'English',
      '中文': '中文',
      '切换语言': 'تغییر زبان',
      '可访问性': 'دسترس‌پذیری',
      '菜单': 'منو',
      '上一节': 'بخش قبلی',
      '下一节': 'بخش بعدی',
      '默认': 'پیش‌فرض',
      '自动': 'خودکار',
      '亮色': 'روشن',
      '深色': 'تاریک',
      'Cloudflare 账户': 'حساب کلادفلر',
      'Cloudflare、Workers 及更多': 'کلادفلر، ورکرها و بیشتر',
      '账户资源': 'منابع حساب',
      '添加语言': 'افزودن زبان',
      '语言模式': 'حالت‌های زبان',
      '建议': 'پیشنهادات',
      '语言': 'زبان',
      '帮助': 'کمک'
    }
  };

  function safeGetItem(name, fallback) {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(name) : null;
      return raw == null ? fallback : raw;
    } catch (e) {
      return fallback;
    }
  }

  function safeSetItem(name, value) {
    try {
      if (window.localStorage) window.localStorage.setItem(name, value);
    } catch (e) {}
  }

  function normalizeLang(value) {
    if (value === 'zh' || value === 'fa') return value;
    return DEFAULT_LANG;
  }

  function getLanguage() {
    return normalizeLang(safeGetItem(STORAGE_KEY, DEFAULT_LANG));
  }

  function applyLanguageState() {
    const lang = getLanguage();
    const html = document.documentElement;
    html.lang = lang === 'zh' ? 'zh-CN' : 'fa';
    html.setAttribute('dir', 'rtl');
    html.setAttribute('data-mv-lang', lang);

    const map = TEXT[lang] || TEXT.zh;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue || '';
      if (!text.trim()) continue;
      const out = map[text.trim()];
      if (out) node.nodeValue = text.replace(text.trim(), out);
    }

    document.querySelectorAll('[data-mv-i18n]').forEach((el) => {
      const key = el.getAttribute('data-mv-i18n');
      if (key && map[key]) el.textContent = map[key];
    });
  }

  function setLanguage(lang) {
    safeSetItem(STORAGE_KEY, normalizeLang(lang));
    applyLanguageState();
  }

  window.mvSetLanguage = setLanguage;
  window.mvGetLanguage = getLanguage;
  window.mvToggleLanguage = function () {
    setLanguage(getLanguage() === 'zh' ? 'fa' : 'zh');
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      safeSetItem(STORAGE_KEY, getLanguage());
      applyLanguageState();
    }, { once: true });
  } else {
    safeSetItem(STORAGE_KEY, getLanguage());
    applyLanguageState();
  }
})();
