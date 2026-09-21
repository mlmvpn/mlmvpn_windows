console.log("cloud.js version: " + Date.now());
// --- Cloudflare Module ---
const cloudHtmlTemplate = `


<style>
    /* Custom Scrollbar for Terminal */
    .terminal-scroll::-webkit-scrollbar { width: 4px; }
    .terminal-scroll::-webkit-scrollbar-thumb { background: var(--m3-surface3); border-radius: 4px; }
    
    /* Container Queries for Responsive Layout */
    @container cloud (max-width: 1024px) {
        .cloud-pro-main {
            flex-direction: column !important;
            height: auto !important;
            overflow-y: visible !important;
            border-radius: 0 !important;
            border: none !important;
        }
        .cloud-pro-aside {
            width: 100% !important;
            height: auto !important;
            border-right: none !important;
            border-left: none !important;
            border-bottom: 1px solid var(--mv-sep) !important;
            flex: none !important;
        }
        #cloud-accounts-container {
            max-height: 400px !important; /* give it a max height so it doesn't take the WHOLE screen if there are many accounts */
            overflow-y: auto !important;
        }
        .cloud-pro-content {
            width: 100% !important;
            height: auto !important;
            min-height: 500px !important;
            overflow-y: visible !important;
            flex: none !important;
        }
        #cloud-wrapper {
            overflow-y: auto !important;
        }
    }
    
    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>

<style id="cl-kit-css">
  /* «زیرساخت ابری» on the page kit: an inset sidebar of sections instead of a second column of
     its own, and no fake window chrome around the log — the window already is one.
     The account cards keep their own markup (renderCloudAccounts builds ~150 lines of it); what
     changed is the frame around them and the look of the controls inside. */
  .cl-wrap { height: 100%; min-height: 0; flex: 1; min-width: 0; }
  .cl-wrap [hidden], .cl-wrap .hidden { display: none !important; }
  .cl-wrap .cl-acc + .cl-acc { margin-top: 14px; }
  .cl-wrap .cl-usage { flex-direction: column; gap: 7px; }
  .cl-wrap .cl-usage-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; font-size: 11.5px; color: var(--mv-label-2); }
  .cl-wrap .cl-usage-reset { font-size: 10.5px; color: var(--mv-label-3); }
  .cl-wrap .cl-usage-bar { width: 100%; height: 6px; border-radius: 3px; overflow: hidden; background: var(--mv-fill); }
  .cl-wrap .cl-usage-bar > div { height: 100%; background: var(--mv-accent); transition: width var(--mv-d-3) var(--mv-ease-out); }
  .cl-wrap #cloud-accounts-container { display: flex; flex-direction: column; gap: 12px; }
  /* The log is a plain reading surface. It used to sit in a card with three fake traffic lights. */
  .cl-wrap #terminal-content {
    margin: 0; width: 100%; min-height: 240px; max-height: none; overflow: auto;
    font-family: var(--mv-font-mono); font-size: 11.5px; line-height: 1.8;
    color: var(--mv-label-2); text-align: left;
  }
  .cl-wrap #cloud-received-configs-container { display: flex; flex-direction: column; gap: 10px; }
</style>
<div id="cloud-wrapper" dir="rtl" class="cl-wrap mv-split">
  <aside class="mv-side" id="cloud-sidebar" aria-label="بخش‌های زیرساخت ابری">
    <div class="mv-side-top"></div>
    <div class="mv-eng-ident" id="cloud-ident">
      <span class="mv-side-tile" style="--tint:var(--mv-orange)"><i class="ph-fill ph-cloud"></i></span>
      <b>زیرساخت ابری</b>
      <small><i class="mv-eng-dot" id="cloud-dot"></i><span id="cloud-dot-word">اکانتی متصل نیست</span></small>
    </div>
    <nav class="mv-side-list custom-scrollbar">
      <div class="mv-side-group">
        <div class="mv-side-head">بخش‌ها</div>
        <button type="button" class="mv-side-item" data-cl-sec="accounts">
          <span class="mv-side-tile" style="--tint:var(--mv-orange)"><i class="ph-fill ph-user-circle"></i></span><span>اکانت‌ها</span>
        </button>
        <button type="button" class="mv-side-item" data-cl-sec="configs">
          <span class="mv-side-tile" style="--tint:var(--mv-green)"><i class="ph-fill ph-shield-check"></i></span><span>کانفیگ‌های دریافتی</span>
        </button>
        <button type="button" class="mv-side-item" data-cl-sec="log">
          <span class="mv-side-tile" style="--tint:var(--mv-gray)"><i class="ph-fill ph-terminal-window"></i></span><span>گزارش</span>
        </button>
      </div>
      <div class="mv-side-group">
        <button type="button" class="mv-side-item" onclick="showModal('cloud-add-account-modal')">
          <span class="mv-side-tile" style="--tint:var(--mv-blue)"><i class="ph-bold ph-plus"></i></span><span>افزودن اکانت</span>
        </button>
        <button type="button" class="mv-side-item" onclick="showModal('cloud-guide-modal')">
          <span class="mv-side-tile" style="--tint:var(--mv-gray)"><i class="ph-fill ph-question"></i></span><span>راهنمای کلیدِ API</span>
        </button>
      </div>
    </nav>
  </aside>

  <section class="mv-pane">
    <header class="mv-pane-bar">
      <div class="mv-pane-nav" role="group" aria-label="پیمایش بخش‌ها">
        <button type="button" id="cloud-back" aria-label="بخش قبلی" title="بخش قبلی" disabled><i class="ph-bold ph-caret-right"></i></button>
      </div>
      <h1 class="mv-pane-title" id="cloud-title">اکانت‌ها</h1>
    </header>

    <div class="mv-pane-scroll custom-scrollbar">

      <div class="mv-eng-sec is-on" data-cl-sec="accounts">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">اکانت‌های کلودفلر</div>
            <div id="cloud-accounts-container"></div>
            <div class="mv-form-footer">هر اکانت می‌تواند سه پنل بگیرد — BPB، Edge و Zeus. «دریافت کانفیگ» کانفیگ‌های آن پنل را می‌آورد و در بخش «کانفیگ‌های دریافتی» نگه می‌دارد.</div>
          </div>
        </div>
      </div>

      <div class="mv-eng-sec" data-cl-sec="configs">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">کانفیگ‌های دریافت‌شده</div>
            <div id="cloud-received-configs-container"></div>
            <div class="mv-form-footer">این‌ها کانفیگ خام‌اند — تا با آی‌پی تمیز ترکیب نشوند، همان آدرس ورکر را دارند.</div>
          </div>
        </div>
      </div>

      <div class="mv-eng-sec" data-cl-sec="log">
        <div class="mv-form">
          <div class="mv-form-section is-wide">
            <div class="mv-form-header">گزارش زنده</div>
            <div class="mv-form-group">
              <div class="mv-form-row is-stack">
                <div id="terminal-content" class="custom-scrollbar" dir="ltr">
                  <div dir="rtl" style="color:var(--mv-label-3)">سیستم مدیریت ابری آماده است.</div>
                  <div id="term-cursor" dir="rtl" style="display:none"></div>
                </div>
              </div>
            </div>
            <div class="mv-form-footer">خط‌به‌خط، از خودِ استقرار و دریافت — همان چیزی که سرور گزارش می‌دهد.</div>
          </div>
        </div>
      </div>

    </div>
  </section>
</div>
    
    <!-- Add Account Modal -->
    <div id="cloud-add-account-modal" class="fixed inset-0 z-[9999] bg-mv-scrim flex items-center justify-center p-4 backdrop-blur-sm" style="display: none; direction: rtl; font-family: 'Vazirmatn', sans-serif;">
      <div class="bg-m3-surface w-[400px] max-w-full border border-m3-outline rounded-2xl p-6 shadow-2xl flex flex-col gap-4 text-m3-onSurface" style="background-color: var(--mv-surface);">
        <h3 class="text-lg font-bold">افزودن اکانت کلودفلر</h3>
        <input type="text" id="new-cloud-api-token" placeholder="Global API Key" class="w-full bg-m3-surface2 border border-m3-outline rounded-xl p-3 text-left text-mv-label placeholder-mv-label-2 focus:outline-none focus:border-mv-sep-3 text-sm font-bold font-mono" dir="ltr" />
        <input type="email" id="new-cloud-api-email" placeholder="Email Address" class="w-full bg-m3-surface2 border border-m3-outline rounded-xl p-3 text-left text-mv-label placeholder-mv-label-2 focus:outline-none focus:border-mv-sep-3 text-sm font-bold font-mono" dir="ltr" />
        <div class="flex justify-end gap-3 mt-2">
            <button onclick="hideModal('cloud-add-account-modal')" class="px-4 py-2 rounded-xl text-mv-label-2 font-bold hover:bg-mv-fill-2 transition-colors">انصراف</button>
            <button onclick="window.addCloudAccountSubmit()" class="px-5 py-2 rounded-xl bg-mv-fill-2 text-mv-label font-bold hover:bg-mv-fill-3 transition-colors shadow-md">افزودن</button>
        </div>
      </div>
    </div>

    <!-- Cloud Delete Confirmation Modal -->
    <div id="cloudDeleteModal" class="fixed inset-0 z-50 hidden flex-col items-center justify-center p-4">
        <!-- Backdrop -->
        <div class="absolute inset-0 bg-mv-scrim backdrop-blur-sm" onclick="hideModal('cloudDeleteModal')"></div>
        
        <div class="bg-m3-surface w-full max-w-sm rounded-3xl p-6 md:p-8 shadow-2xl border border-m3-outline flex flex-col items-center text-center relative z-10 transform scale-100 transition-all duration-300">
            
            <div class="w-16 h-16 bg-mv-red/10 text-mv-red-ink rounded-full flex items-center justify-center mb-6">
                <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>
            </div>
            
            <h3 class="text-xl font-bold text-mv-label mb-2">حذف اکانت کلودفلر</h3>
            <p class="text-sm text-m3-onSurfaceVariant mb-8">آیا از حذف این اکانت مطمئن هستید؟ این عملیات غیرقابل بازگشت است.</p>
            
            <div class="flex w-full gap-3">
                <button onclick="hideModal('cloudDeleteModal')" class="flex-1 py-3 rounded-full text-sm font-bold text-mv-label bg-m3-background border border-m3-outline hover:bg-m3-surface3 transition-colors">انصراف</button>
                <button id="btn-cloud-confirm-delete" class="flex-1 py-3 rounded-full text-sm font-bold bg-mv-red-fill text-white hover:bg-mv-red-fill/90 shadow-lg shadow-red-500/20 transition-all">بله، حذف کن</button>
            </div>
        </div>
    </div>

    </div>

    <!-- Cloudflare Guide Modal -->
    <div id="cloud-guide-modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-mv-scrim backdrop-blur-sm transition-opacity duration-300">
      <div class="bg-m3-surface w-full max-w-xl rounded-3xl shadow-2xl border border-m3-outline p-6 flex flex-col gap-4 text-m3-onSurface" dir="rtl">
        <div class="flex items-center justify-between border-b border-m3-outline pb-4 mb-2">
          <h3 class="text-lg font-bold text-m3-onSurface m-0">راهنمای دریافت Global API Key کلودفلر</h3>
          <button onclick="hideModal('cloud-guide-modal')" class="text-m3-onSurfaceVariant hover:text-mv-red-ink transition-colors bg-transparent border-none cursor-pointer">
            <i class="ph-bold ph-x text-xl"></i>
          </button>
        </div>
        <div class="text-sm leading-loose max-h-[60vh] overflow-y-auto pl-2 pr-1 custom-scrollbar">
          <p>
            برای استفاده از استقرار خودکار، شما به ایمیل و کلید <b>Global API Key</b> اکانت کلودفلر خود نیاز دارید. لطفاً مراحل زیر را دنبال کنید:
          </p>
          <ol class="mt-2.5 pr-5 list-decimal pl-4">
            <li>ابتدا وارد داشبورد کلودفلر خود شوید (<code>dash.cloudflare.com</code>).</li>
            <li>از بالا سمت راست روی آیکون پروفایل خود کلیک کرده و گزینه <b>My Profile</b> را انتخاب کنید.</li>
            <li>از منوی سمت چپ، روی گزینه <b>API Tokens</b> کلیک کنید.</li>
            <li>به پایین صفحه اسکرول کنید تا به بخش <b>API Keys</b> برسید.</li>
            <li>در ردیف <b>Global API Key</b> روی دکمه <b>View</b> کلیک کنید.</li>
            <li>رمز عبور اکانت کلودفلر خود را وارد کنید تا کلید به شما نمایش داده شود.</li>
            <li>این کلید (ترکیبی طولانی از حروف و اعداد) را کپی کنید.</li>
            <li>در نهایت، ایمیل اکانت کلودفلر و این کلید را در فیلدهای نرم‌افزار وارد کنید.</li>
          </ol>
          <div class="bg-mv-red/10 p-3 rounded-lg mt-4 border border-mv-red/20 text-mv-red-ink">
            <b class="font-bold">⚠️ هشدار امنیتی:</b>
            <p class="mt-1 mb-0 text-xs">
              کلید Global API Key دسترسی کامل به اکانت کلودفلر شما دارد. آن را در اختیار هیچکس قرار ندهید. این کلید فقط به صورت محلی در سیستم شما ذخیره می‌شود.
            </p>
          </div>
        </div>
      </div>
    </div>
              </div>


<!-- Edge Settings Modal -->
<div id="edgeSettingsModal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4">
    <div class="absolute inset-0 bg-mv-scrim backdrop-blur-sm" onclick="hideModal('edgeSettingsModal')"></div>
    <div class="bg-m3-surface w-full max-w-md rounded-3xl p-6 shadow-2xl border border-m3-outline flex flex-col relative z-10 transform scale-100 transition-all duration-300">
        <h3 class="text-lg font-bold text-m3-onSurface mb-4">تنظیمات تونل Edge</h3>
        <div class="flex flex-col gap-3">
            <label class="text-sm font-medium text-m3-onSurfaceVariant">Proxy IP (آی‌پی ثابت)</label>
            <input type="text" id="edge-proxy-ip" dir="ltr" class="w-full bg-m3-surface2 border border-m3-outline rounded-xl p-3 text-sm focus:outline-none focus:border-m3-primary" placeholder="مثال: 192.168.1.1">
        </div>
        <div class="flex gap-3 mt-6">
            <button onclick="hideModal('edgeSettingsModal')" class="flex-1 py-2.5 rounded-xl text-sm font-bold bg-m3-surface2 hover:bg-m3-surface3 text-m3-onSurfaceVariant transition-colors">انصراف</button>
            <button onclick="saveEdgeSettings()" class="flex-1 py-2.5 rounded-xl text-sm font-bold bg-m3-primary text-m3-onPrimary hover:bg-m3-primary/90 transition-colors">ذخیره تنظیمات</button>
        </div>
    </div>
</div>

<!-- Undeployed Modal -->
<div id="undeployed-modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-mv-scrim backdrop-blur-sm opacity-0 transition-opacity duration-300">
    <div class="bg-m3-surface w-[90%] max-w-sm rounded-3xl shadow-2xl border border-m3-outline p-6 flex flex-col gap-4 transform scale-95 transition-transform duration-300">
        <div class="flex items-center gap-3">
            <div class="w-12 h-12 rounded-full bg-mv-yellow/10 flex items-center justify-center text-mv-yellow-ink">
                <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            </div>
            <div>
                <h3 class="text-lg font-bold text-m3-onSurface">پنل مستقر نشده است</h3>
                <p class="text-sm text-m3-onSurfaceVariant">ابتدا باید ورکر را مستقر کنید</p>
            </div>
        </div>
        
        <p class="text-sm text-m3-onSurface leading-relaxed mt-2">
            برای دریافت کانفیگ، این اکانت باید ابتدا روی کلودفلر مستقر (Deploy) شود. آیا مایلید هم‌اکنون استقرار را شروع کنید؟
        </p>
        
        <div class="flex gap-3 mt-4">
            <button onclick="hideUndeployedModal()" class="flex-1 py-3 px-4 bg-m3-surface2 hover:bg-m3-surface3 text-m3-onSurfaceVariant rounded-xl text-sm font-bold transition-colors">
                انصراف
            </button>
            <button id="undeployed-modal-deploy-btn" class="flex-[2] py-3 px-4 bg-m3-primary hover:bg-m3-primary/90 text-m3-onPrimary rounded-xl text-sm font-bold shadow-md transition-all">
                استقرار ورکر
            </button>
        </div>
    </div>
</div>
</div>
`;
/**
 * Section routing for the cloud panel — the same six obligations every kit page has
 * (components/fronts.js › goSec): show the section, mark the sidebar, drop the pane bar on the
 * home section, set the title, disable «برگشت» there, and reset the scroll.
 */
const CLOUD_SEC_TITLE = { accounts: 'اکانت‌ها', configs: 'کانفیگ‌های دریافتی', log: 'گزارش' };
let cloudSec = 'accounts';

window.cloudGo = function (sec) {
    const wrap = document.getElementById('cloud-wrapper');
    if (!wrap) return;
    cloudSec = CLOUD_SEC_TITLE[sec] ? sec : 'accounts';
    wrap.querySelectorAll('.mv-eng-sec').forEach(n => n.classList.toggle('is-on', n.getAttribute('data-cl-sec') === cloudSec));
    wrap.querySelectorAll('.mv-side-item[data-cl-sec]').forEach(b => b.classList.toggle('active', b.getAttribute('data-cl-sec') === cloudSec));
    const pane = wrap.querySelector('.mv-pane');
    if (pane) pane.classList.toggle('is-home', cloudSec === 'accounts');
    const title = document.getElementById('cloud-title');
    if (title) title.textContent = CLOUD_SEC_TITLE[cloudSec] || '';
    const back = document.getElementById('cloud-back');
    if (back) back.disabled = cloudSec === 'accounts';
    const scroll = wrap.querySelector('.mv-pane-scroll');
    if (scroll) scroll.scrollTop = 0;
};

/** The sidebar's identity line: how many accounts are connected, in a word as well as a colour. */
window.cloudRenderIdent = function () {
    const dot = document.getElementById('cloud-dot');
    const word = document.getElementById('cloud-dot-word');
    if (!dot || !word) return;
    let n = 0;
    try { n = (loadCloudAccounts() || []).length; } catch (e) { n = 0; }
    const fa = (v) => String(v).replace(/[0-9]/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]);
    dot.className = 'mv-eng-dot' + (n ? ' is-on' : '');
    word.textContent = n ? `${fa(n)} اکانت متصل` : 'اکانتی متصل نیست';
};

function initCloudModule() {
    // Wired after the template lands; see cloudGo above.
    setTimeout(function () {
        const wrap = document.getElementById('cloud-wrapper');
        if (!wrap) return;
        wrap.querySelectorAll('.mv-side-item[data-cl-sec]').forEach(function (b) {
            b.addEventListener('click', function () { window.cloudGo(b.getAttribute('data-cl-sec')); });
        });
        const back = document.getElementById('cloud-back');
        if (back) back.addEventListener('click', function () { window.cloudGo('accounts'); });
        window.cloudGo('accounts');
        window.cloudRenderIdent();
    }, 0);

    const container = document.getElementById('ls-cloud');
    if (container) {
        container.innerHTML = cloudHtmlTemplate;
        // Re-bind any necessary handlers or initialize view
        if (typeof renderCloudAccounts === 'function') setTimeout(renderCloudAccounts, 50);
        if (typeof window.renderCloudReceivedConfigs === 'function') setTimeout(window.renderCloudReceivedConfigs, 50);
    }
}

// ===== Cloudflare Deploy & Account Management =====

window.deleteCloudAccount = function(id) {
    if (typeof showModal === "function") {
        showModal('cloudDeleteModal');
    } else {
        const modal = document.getElementById('cloudDeleteModal');
        if (modal) {
            modal.classList.remove('hidden');
            modal.classList.add('flex');
            setTimeout(() => {
                modal.classList.remove('opacity-0');
                const content = modal.querySelector('.scale-95');
                if(content) content.classList.replace('scale-95', 'scale-100');
            }, 10);
        }
    }
    
    const confirmBtn = document.getElementById('btn-cloud-confirm-delete');
    if (confirmBtn) {
        confirmBtn.onclick = function() {
            const accounts = loadCloudAccounts();
            const filtered = accounts.filter(a => a.id !== id);
            PersistentStorage.setItem('cf_accounts', JSON.stringify(filtered));
            
            // Critical fix: Prevent resurrection after a deliberate deletion
            PersistentStorage.setItem('cf_migrated_v2', '1');
            
            toast("اکانت با موفقیت حذف شد");
            renderCloudAccounts();
            
            if (window._activeCloudAccount && window._activeCloudAccount.id === id) {
                window._activeCloudAccount = null;
            }
            if (typeof hideModal === "function") {
                hideModal('cloudDeleteModal');
            } else {
                const modal = document.getElementById('cloudDeleteModal');
                if (modal) {
                    modal.classList.add('opacity-0');
                    setTimeout(() => {
                        modal.classList.add('hidden');
                        modal.classList.remove('flex');
                    }, 300);
                }
            }
        };
    }
};


window._activeCloudAccount = null;

window.addCloudAccountSubmit = async function() {
    const token = document.getElementById("new-cloud-api-token").value.trim();
    const email = document.getElementById("new-cloud-api-email").value.trim();
    if (!token || !email) {
        toast("لطفاً هم ایمیل و هم توکن را وارد کنید");
        return;
    }
    
    const accounts = loadCloudAccounts();
    if (accounts.some(a => a.token === token)) {
        toast("این اکانت قبلا اضافه شده است");
        return;
    }

    // UI Loading state
    const btn = document.querySelector('#cloud-add-account-modal button:last-child');
    let originalText = "افزودن";
    if (btn) {
        originalText = btn.innerHTML;
        btn.innerHTML = `<svg class="animate-spin -ml-1 mr-2 h-4 w-4 text-current inline-block" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg> در حال بررسی...`;
        btn.disabled = true;
        btn.classList.add('opacity-70', 'cursor-not-allowed');
    }

    try {
        const response = await fetch('/api/cloudflare/verify', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, token })
        });
        
        
        const text = await response.text();
        console.log("Raw response:", text);
        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new Error("Server returned an invalid response (not JSON). Please check the console.");
        }

        
        if (!data.success) {
            let errorMsg = "اطلاعات وارد شده نامعتبر است.";
            if (data.errors && data.errors.length > 0) {
                const code = data.errors[0].code;
                if (code === 9103) errorMsg = "ایمیل یا توکن اشتباه است (کد 9103). لطفا مطمئن شوید از Global API Key استفاده کرده‌اید.";
                else if (code === 6003) errorMsg = "توکن نامعتبر است (کد 6003).";
                else if (code === 10000) errorMsg = "خطای احراز هویت (کد 10000). ایمیل یا کلید اشتباه است.";
                else errorMsg = "خطای کلودفلر: " + data.errors[0].message;
            }
            throw new Error(errorMsg);
        }
        
        // Success
        accounts.push({
            id: Date.now().toString(),
            email: email,
            token: token,
            name: email,
            url: '',
            subPath: ''
        });
        PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
        
        document.getElementById("new-cloud-api-token").value = "";
        document.getElementById("new-cloud-api-email").value = "";
        
        toast("اکانت با موفقیت تایید و افزوده شد");
        hideModal('cloud-add-account-modal');
        renderCloudAccounts();
        
    } catch (error) {
        toast(error.message || "خطا در ارتباط با سرور کلودفلر");
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
            btn.classList.remove('opacity-70', 'cursor-not-allowed');
        }
    }
};

window.triggerAction = function(btn, actionType, accountId, panelType) {
    const accounts = loadCloudAccounts();
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return;
    
    window._activeCloudAccount = acc;
    window._activePanelType = panelType || 'BPB';
    
    if (panelType === "BPB") {
        if (actionType === "DEPLOY") window.deployCloudflare(false, btn);
        if (actionType === "FETCH") {
            if (!acc.url) {
                window.showUndeployedModal(accountId, btn);
            } else {
                window.prepareCloudFetch(btn, acc.url, acc.subPath);
            }
        }
        if (actionType === "SETTINGS") {
            if (!acc.url) {
                window.showUndeployedModal(accountId, btn);
            } else {
                window.currentCloudFetchUrl = acc.url;
                window.currentCloudFetchSubPath = acc.subPath;
                showSettingsModal();
            }
        }
    } else if (panelType === "ZEUS") {
        if (actionType === "DEPLOY") window.deployCloudflare(false, btn);
        if (actionType === "FETCH") {
            if (!acc.zeusUrl) {
                window.showUndeployedModal(accountId, btn);
            } else {
                if(typeof window.showZeusUsersModal === 'function') {
                    const zeusAcc = { ...acc, url: acc.zeusUrl };
                    window.showZeusUsersModal(zeusAcc);
                } else uiAlert({
                    title: 'در دسترس نیست',
                    message: 'بخش مدیریت کاربران ZEUS هنوز در این نسخه فعال نشده است.',
                    tone: 'warn',
                });
            }
        }
        if (actionType === "SETTINGS") {
            if (!acc.zeusUrl) {
                window.showUndeployedModal(accountId, btn);
            } else {
                if(typeof window.showZeusSettingsModal === 'function') {
                    const zeusAcc = { ...acc, url: acc.zeusUrl };
                    window.showZeusSettingsModal(zeusAcc);
                } else uiAlert({
                    title: 'در دسترس نیست',
                    message: 'بخش تنظیمات ZEUS هنوز در این نسخه فعال نشده است.',
                    tone: 'warn',
                });
            }
        }
    } else if (panelType === "EDGE") {
        if (actionType === "DEPLOY") window.deployEdgeWorker(btn, accountId);
        if (actionType === "FETCH") {
            if (!acc.edgeUrl) {
                window.showUndeployedModal(accountId, btn);
            } else {
                window.fetchEdgeNodes(btn, accountId);
            }
        }
        if (actionType === "SETTINGS") {
            window.showEdgeSettingsModal(acc);
        }
    } else {
        toast("پنل " + panelType + " به زودی اضافه خواهد شد!");
    }
};
function loadCloudAccounts() {
    let saved = PersistentStorage.getItem('cf_accounts');
    let accounts = saved ? JSON.parse(saved) : [];
    
    // Ensure all accounts have an id (backward compatibility for old accounts without id)
    let modified = false;
    accounts.forEach((acc, index) => {
        if (!acc.id) {
            acc.id = 'acc_' + Date.now() + '_' + index;
            modified = true;
        }
    });
    if (modified) {
        PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
    }
    
    // Auto-migrate from old inputs if cf_accounts is empty
    if (accounts.length === 0 && !PersistentStorage.getItem('cf_migrated_v2')) {
        try {
            const inputs = JSON.parse(PersistentStorage.getItem('app_inputs') || '{}');
            const token = inputs['cloud-api-token'];
            const email = inputs['cloud-api-email'];
            if (token) {
                accounts.push({
                    id: 'migrated-account',
                    email: email || '',
                    token: token,
                    name: email || 'My Account',
                    url: inputs['cloud-worker-url'] || '',
                    subPath: inputs['cloud-worker-subpath'] || ''
                });
                PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
            }
            // Mark migration as done so it doesn't resurrect when user deletes all accounts
            PersistentStorage.setItem('cf_migrated_v2', '1');
        } catch(e) {}
    }

    return accounts;
}

function saveCloudAccount(acc) {
    const accounts = loadCloudAccounts();
    accounts.push(acc);
    PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
    renderCloudAccounts();
}



window.checkCloudflareUsage = async function(url, index) {
    const container = document.getElementById(`usage-container-${index}`);
    const bar = document.getElementById(`usage-bar-${index}`);
    const text = document.getElementById(`usage-text-${index}`);
    const btn = event.currentTarget;
    
    if (!container || !bar || !text) return;
    
    // Toggle logic
    if (!container.classList.contains("hidden") && bar.style.width !== "0%") {
        container.classList.add("hidden");
        return;
    }
    
    const email = document.getElementById("cloud-api-email")?.value.trim() || "";
    const token = document.getElementById("cloud-api-token")?.value.trim() || "";
    
    if (!token) {
        toast("لطفا ایمیل و توکن کلودفلر را در فیلدهای بالای صفحه وارد کنید تا آمار واقعی دریافت شود", 4000);
        return;
    }
    
    container.classList.remove("hidden");
    text.innerText = "در حال دریافت آمار از سرور...";
    bar.style.width = "0%";
    
    const originalText = btn.innerText;
    btn.innerText = "...";
    btn.disabled = true;
    
    try {
        const res = await fetch("/api/cloudflare/usage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: url })
        });
        const data = await res.json();
        
        btn.innerText = originalText;
        btn.disabled = false;
        
        if (data.success) {
            const realUsage = data.requests || 0;
            const limit = 100000;
            const percentage = (realUsage / limit) * 100;
            
            text.innerText = `مصرف روزانه: ${realUsage.toLocaleString()} درخواست`;
            bar.style.width = `${Math.min(percentage, 100)}%`;
            
            if (percentage > 85) {
                bar.style.backgroundColor = "var(--mv-red)"; // google-red
            } else if (percentage > 50) {
                bar.style.backgroundColor = "var(--mv-yellow)"; // google-yellow
            } else {
                bar.style.backgroundColor = "var(--mv-green)"; // google-green
            }
        } else {
            text.innerText = "خطا: " + (data.message || "نامشخص");
            bar.style.width = "0%";
        }
    } catch (e) {
        btn.innerText = originalText;
        btn.disabled = false;
        text.innerText = "خطا در ارتباط با سرور محلی";
        bar.style.width = "0%";
    }
}

// Local Config Generator based on BPB Base Raw nodes
function generateLocalNodes(baseConfigs) {
    const useVless = document.getElementById("cloud-proto-vless")?.checked;
    const useTrojan = document.getElementById("cloud-proto-trojan")?.checked;
    
    const tlsCheckboxes = document.querySelectorAll("input[name='cloud-tls-port-new']:checked, input[name='cloud-tls-port']:checked");
    const nonTlsCheckboxes = document.querySelectorAll("input[name='cloud-nontls-port-new']:checked, input[name='cloud-nontls-port']:checked");
    
    const tlsPorts = Array.from(tlsCheckboxes).map(c => c.value);
    const nonTlsPorts = Array.from(nonTlsCheckboxes).map(c => c.value);
    
    const useIpv6 = document.getElementById("cloud-ipv6-enable")?.checked || document.getElementById("cloud-ipv6-new")?.checked;
    const useFrag = document.getElementById("cloud-frag-toggle")?.checked;
    const fragLen = document.getElementById("cloud-frag-len")?.value || "100-200";
    const fragInt = document.getElementById("cloud-frag-int")?.value || "2-10";
    const fragPak = document.getElementById("cloud-frag-pak")?.value || "tlshello";
    
    let proxyIp = document.getElementById("cloud-proxyip-new")?.value || document.getElementById("cloud-proxyip")?.value || "";
    if (proxyIp === "none") proxyIp = "";
    
    const generated = [];
    
    baseConfigs.forEach(baseUri => {
        try {
            const urlObj = new URL(baseUri);
            const protocol = urlObj.protocol.replace(":", "");
            
            if (protocol === "vless" && !useVless) return;
            if (protocol === "trojan" && !useTrojan) return;
            
            const originalHost = urlObj.searchParams.get("host") || urlObj.hostname;
            const originalSni = urlObj.searchParams.get("sni") || originalHost;
            
            const applySettingsToUri = (port, isTls) => {
                const newUri = new URL(baseUri);
                newUri.port = port;
                
                if (proxyIp) {
                    newUri.hostname = proxyIp;
                    newUri.searchParams.set("host", originalHost);
                }
                
                if (isTls) {
                    newUri.searchParams.set("sni", originalSni);
                }
                
                if (isTls) {
                    newUri.searchParams.set("security", "tls");
                } else {
                    newUri.searchParams.set("security", "none");
                    newUri.searchParams.delete("sni");
                    newUri.searchParams.delete("alpn");
                    newUri.searchParams.delete("fp");
                }
                
                if (useFrag && isTls) {
                    newUri.searchParams.set("fragment", `${fragLen},${fragInt},${fragPak}`);
                }
                
                let hash = decodeURIComponent(newUri.hash.substring(1));
                hash = hash.split(" - ")[0]; // Remove existing port info
                newUri.hash = encodeURIComponent(`${hash} - ${port}${isTls ? " TLS" : ""}`);
                
                return newUri.toString();
            };
            
            tlsPorts.forEach(port => generated.push(applySettingsToUri(port, true)));
            nonTlsPorts.forEach(port => generated.push(applySettingsToUri(port, false)));
            
        } catch (e) {
            // Invalid URI
            console.error("Failed to parse base uri", e);
        }
    });
    
    return generated;
}

window._latestGeneratedCloudConfigs = [];


async function fetchCloudNodes(btn) {
    if (!currentCloudFetchUrl || !currentCloudFetchSubPath) {
        toast("خطا: آدرس سرور یا ساب‌پس نامعتبر است");
        return;
    }
    
    const oldText = btn.innerHTML;
    btn.innerHTML = `<i class="ph-bold ph-spinner animate-spin"></i> در حال دریافت...`;
    btn.disabled = true;
    
    try {
        // Upload settings to panel first
        const settingsPayload = {};
        
        settingsPayload.allowLANConnection = document.getElementById("cloud-allow-lan")?.checked || false;
        settingsPayload.enableIPv6 = document.getElementById("cloud-ipv6-new")?.checked || false;
        
        // Use VLConfigs and TRConfigs as expected by BPB Panel API v4.1.3
        settingsPayload.VLConfigs = document.getElementById("cloud-proto-vless")?.checked !== false;
        settingsPayload.TRConfigs = document.getElementById("cloud-proto-trojan")?.checked !== false;
        
        // Backward compatibility
        settingsPayload.vless = settingsPayload.VLConfigs;
        settingsPayload.trojan = settingsPayload.TRConfigs;
        
        const tlsCheckboxes = document.querySelectorAll("input[name='cloud-tls-port-new']:checked");
        const nonTlsCheckboxes = document.querySelectorAll("input[name='cloud-nontls-port-new']:checked");
        
        settingsPayload["tlsPorts"] = Array.from(tlsCheckboxes).map(c => c.value);
        settingsPayload["nonTlsPorts"] = Array.from(nonTlsCheckboxes).map(c => c.value);
        // For BPB 4.1.3+ which only uses "ports"
        settingsPayload["ports"] = [...settingsPayload["tlsPorts"], ...settingsPayload["nonTlsPorts"]].map(p => parseInt(p, 10)).filter(p => !isNaN(p));
        
        const proxyMode = document.querySelector("input[name='cloud-proxy-mode']:checked")?.value || "proxyip";
        settingsPayload.proxyIPMode = proxyMode;
        if (proxyMode === "proxyip") {
            const proxyIp = document.getElementById("cloud-proxyip-new")?.value.trim() || "";
            settingsPayload.proxyIPs = proxyIp ? [proxyIp] : []; // Array format
        } else {
            const prefix = document.getElementById("cloud-nat64-new")?.value.trim() || "";
            settingsPayload.prefixes = prefix ? [prefix] : []; // Array format
        }
        
        const useFrag = document.getElementById("cloud-frag-toggle")?.checked;
        if (useFrag) {
            const fragLen = document.getElementById("cloud-frag-len")?.value.trim() || "100-200";
            const fragInt = document.getElementById("cloud-frag-int")?.value.trim() || "10-20";
            const fragPak = document.getElementById("cloud-frag-pak")?.value.trim() || "tlshello";
            settingsPayload.fragment = `${fragLen},${fragInt},${fragPak}`;
        } else {
            settingsPayload.fragment = "";
        }

        // Proxy IP / NAT64 are compiled into the panel's own script since v5.1.1, so
        // applying them makes the panel rebuild and redeploy itself — that takes a few
        // seconds and can fail on its own. The server reports it separately; say so,
        // because silently ignoring it means the user's choice never took effect.
        try {
            const setRes = await fetch("/api/cloudflare/bpb-settings/update", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // Hard ceiling. Saving settings must never be able to hold the config
                // dialog on its spinner — that is exactly how this looked when the panel
                // domain was filtered and the login helper kept retrying.
                signal: AbortSignal.timeout(45000),
                body: JSON.stringify({
                    url: currentCloudFetchUrl,
                    subPath: currentCloudFetchSubPath,
                    email: window._activeCloudAccount?.email || '',
                    token: window._activeCloudAccount?.token || '',
                    settings: settingsPayload
                })
            });
            const setData = await setRes.json().catch(() => ({}));
            if (setData.mainError) {
                toast("⚠️ تنظیمات Proxy IP اعمال نشد: " + setData.mainError, 5000);
            } else if (setData.mainApplied) {
                toast("تنظیمات Proxy IP اعمال شد (پنل در حال بازسازی خودش است)…");
            }
        } catch (e) { /* دریافت کانفیگ نباید به‌خاطر سینک تنظیمات متوقف شود */ }

        // Then fetch nodes
        const res = await fetch("/api/cloudflare/fetch-nodes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(60000),
            body: JSON.stringify({
                url: currentCloudFetchUrl,
                subPath: currentCloudFetchSubPath,
                uuid: window._activeCloudAccount?.uuid || '',
                trPass: window._activeCloudAccount?.trPass || '',
                protocols: {
                    vless: settingsPayload.VLConfigs,
                    trojan: settingsPayload.TRConfigs
                }
            })
        });
        const data = await res.json();
        
        if (data.success && data.configs && data.configs.length > 0) {
            // Apply local BPB settings to the raw base configs
            const finalNodes = data.configs; // bypassed generateLocalNodes to use exact configs from BPB panel
            
            if (finalNodes.length === 0) {
                toast("با تنظیمات فعلی هیچ نودی ساخته نشد (احتمالا پروتکل‌ها یا پورت‌ها خاموش هستند)");
            } else {
                window._latestGeneratedCloudConfigs = finalNodes;
                
                // IMPORTANT: we should still save it to the existing group logic so Combo center can find it
                if (typeof window.saveBaseConfigGroup === 'function') {
                    window.saveBaseConfigGroup(currentCloudFetchUrl, finalNodes, { isBpb: true });
                } else {
                    console.error("saveBaseConfigGroup is not defined on window");
                }
                
                // Update UI using new dynamic renderer
                if (typeof window.renderCloudReceivedConfigs === 'function') {
                    window.renderCloudReceivedConfigs();
                }
                
                toast(`${finalNodes.length} کانفیگ با موفقیت ساخته شد`);
                hideSettingsModal();
            }
        } else {
            toast(data.error || "خطای ارتباط شبکه");
        }
    } catch (e) {
        toast(e.name === 'TimeoutError'
            ? "زمان دریافت کانفیگ تمام شد — دامنه‌ی ورکر احتمالاً فیلتر است و مسیر جایگزین هم جواب نداد."
            : "خطا: " + e.message);
    } finally {
        btn.innerHTML = oldText;
        btn.disabled = false;
    }
}
window.fetchCloudNodes = fetchCloudNodes;


function copyCloudConfigs() {
    if (window._latestGeneratedCloudConfigs && window._latestGeneratedCloudConfigs.length > 0) {
        const text = window._latestGeneratedCloudConfigs.join("\n");
        navigator.clipboard.writeText(text);
        toast("همه‌ی کانفیگ‌ها کپی شدند!");
    } else {
        toast("کانفیگی برای کپی وجود ندارد");
    }
}
window.copyCloudConfigs = copyCloudConfigs;



function exportCloudConfigs() {
    if (window._latestGeneratedCloudConfigs && window._latestGeneratedCloudConfigs.length > 0) {
        openCombinationCenter();
        toast("کانفیگ‌ها به پنل ترکیب منتقل شدند");
    } else {
        toast("ابتدا کانفیگ‌ها را دریافت کنید");
    }
}
window.exportCloudConfigs = exportCloudConfigs;

// Replace older click handlers correctly
document.addEventListener("DOMContentLoaded", () => {
    // Restore email/token if previously saved
    const savedEmail = PersistentStorage.getItem("cf_saved_email");
    const savedToken = PersistentStorage.getItem("cf_saved_token");
    if (savedEmail) {
        const eInput = document.getElementById("cloud-api-email");
        if (eInput) eInput.value = savedEmail;
    }
    if (savedToken) {
        const tInput = document.getElementById("cloud-api-token");
        if (tInput) tInput.value = savedToken;
    }

    // Restore last received cloud configs
    try {
        const savedCloudConfigs = PersistentStorage.getItem("latest-cloud-configs");
        if (savedCloudConfigs) {
            const finalNodes = JSON.parse(savedCloudConfigs);
            if (Array.isArray(finalNodes) && finalNodes.length > 0) {
                window._latestGeneratedCloudConfigs = finalNodes;
                
                const emptyState = document.getElementById("received-configs-empty");
                const listState = document.getElementById("received-configs-list");
                const countBadge = document.getElementById("recv-config-count");
                
                if (emptyState) emptyState.classList.add("hidden");
                if (listState) listState.classList.remove("hidden");
                if (listState) listState.classList.add("flex");
                if (countBadge) countBadge.innerText = finalNodes.length;
                
                const dateEl = document.getElementById("recv-config-date");
                const savedDate = PersistentStorage.getItem("latest-cloud-date");
                if (dateEl && savedDate) {
                    dateEl.innerText = savedDate;
                }
            }
        }
    } catch(e) {}

    setTimeout(renderCloudAccounts, 500);
    connectWS();
});


let currentCloudFetchUrl = "";
let currentCloudFetchSubPath = "";
let cloudTerminalInterval = null;

function addTerminalLog(msg, type = "info") {
    const term = document.getElementById("terminal-content");
    if (!term) return;
    const cursor = document.getElementById("term-cursor");
    const div = document.createElement("div");
    if (type === "success") div.className = "text-mv-green-ink";
    else if (type === "error") div.className = "text-mv-red-ink";
    else if (type === "warning") div.className = "text-gs-muted";
    else div.className = "text-m3-onSurfaceVariant";
    
    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2,"0") + ":" + now.getMinutes().toString().padStart(2,"0") + ":" + now.getSeconds().toString().padStart(2,"0");
    div.innerHTML = `<span class="text-m3-outline mr-2">[${timeStr}]</span> ${msg}`;
    
    term.insertBefore(div, cursor);
    term.scrollTop = term.scrollHeight;
}

window.deployCloudflare = async function(ignoreWarning = false, btn = null) {
    if (!window._activeCloudAccount) {
        toast("لطفا ابتدا اکانتی را انتخاب کنید");
        return;
    }
    const email = window._activeCloudAccount.email || "";
    const token = window._activeCloudAccount.token;
    
    if (!btn) btn = document.getElementById("btn-deploy-cloud");
    
    if (btn && !btn._originalHtml) {
        btn._originalHtml = btn.innerHTML;
        btn.innerHTML = `<i class="ph-bold ph-spinner animate-spin"></i> <span id="deploy-text">در حال استقرار...</span>`;
    }
    
    const deployText = btn ? btn.querySelector("#deploy-text") || document.getElementById("deploy-text") : null;
    const deployIcon = btn ? btn.querySelector("#deploy-icon") || document.getElementById("deploy-icon") : null;
    
    if (btn) btn.disabled = true;

    // --- Pre-flight Subdomain Check ---
    if (!ignoreWarning) {
        try {
            if (deployText) deployText.innerText = "بررسی ساب‌دامین...";
            const checkRes = await fetch("/api/cloudflare/check-subdomain", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, token })
            });
            const checkData = await checkRes.json();
            if (checkData.success && checkData.isContaminated) {
                if (btn) { btn.disabled = false; if (btn._originalHtml) { btn.innerHTML = btn._originalHtml; delete btn._originalHtml; } }
                
                document.getElementById("current-contaminated-subdomain").innerText = checkData.currentSubdomain;
                const modal = document.getElementById("subdomain-fix-modal");
                if (modal) {
                    modal.classList.remove("hidden");
                    modal.classList.add("flex");
                    if (typeof loadCloudflareWorkers === "function") {
                        loadCloudflareWorkers(email, token);
                    }
                }
                return;
            }
        } catch(e) {
            console.error("Subdomain check failed", e);
        }
    }
    // --- End Pre-flight ---
    
    if (btn) btn.disabled = true;
    if (deployText) deployText.innerText = "در حال استقرار...";
    if (deployIcon) deployIcon.innerHTML = `<circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" fill="none" class="opacity-25"></circle><path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" fill="currentColor" class="opacity-75"></path>`;
    if (deployIcon) deployIcon.classList.add("animate-spin");
    
    const term = document.getElementById("terminal-content");
    if (term) {
        term.innerHTML = `<div id="term-cursor" class="text-right mt-1" dir="rtl"><span class="inline-block w-2 h-3.5 bg-gs-panel animate-blink align-middle"></span></div>`;
    }
    
    addTerminalLog("شروع فرآیند استقرار ورکر...", "info");
    
    let simLogs = [
        "در حال احراز هویت با Cloudflare API...",
        "بررسی اکانت و دسترسی‌ها...",
        "ساخت ساب‌دامین اختصاصی...",
        "ایجاد فضای ذخیره‌سازی KV (bpb-panel)...",
        "تولید توکن‌ها و پسوردهای تصادفی...",
        "آپلود کدهای Worker...",
        "اتصال Worker به فضای KV..."
    ];
    let simIndex = 0;
    cloudTerminalInterval = setInterval(() => {
        if (simIndex < simLogs.length) {
            addTerminalLog(simLogs[simIndex], "info");
            simIndex++;
        }
    }, 1200);
    
    try {
        const res = await fetch("/api/cloudflare/deploy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, token, panelType: window._activePanelType || 'BPB' })
        });
        const data = await res.json();
        
        clearInterval(cloudTerminalInterval);
        
        if (data.success) {
            // `reused` یعنی سرور ورکر و دیتابیس موجود را به‌روزرسانی کرده، نه اینکه
            // نسخه‌ی تازه‌ای ساخته باشد — کاربرِ پنل باید بداند کاربرانش سر جایشان هستند.
            if (data.reused) {
                addTerminalLog("پنل موجود پیدا شد — همان ورکر و دیتابیس به‌روزرسانی شد.", "success");
            }
            addTerminalLog("استقرار با موفقیت انجام شد!", "success");
            addTerminalLog("Worker URL: " + data.url, "success");
            toast(data.reused ? "پنل موجود به‌روزرسانی شد (کاربران حفظ شدند)" : "سرور با موفقیت دیپلوی شد!");
            
            
            // Update existing account instead of duplicating
            const accounts = loadCloudAccounts();
            const existingIdx = accounts.findIndex(a => a.id === window._activeCloudAccount.id);
            if (existingIdx !== -1) {
                if (window._activePanelType === "ZEUS") {
                    accounts[existingIdx].zeusUrl = data.url;
                    PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
                    window._activeCloudAccount = accounts[existingIdx];
                    renderCloudAccounts();
                    
                    if(typeof window.showZeusUsersModal === 'function') {
                        const zeusAcc = { ...accounts[existingIdx], url: accounts[existingIdx].zeusUrl };
                        window.showZeusUsersModal(zeusAcc);
                    }
                } else {
                    accounts[existingIdx].url = data.url;
                    accounts[existingIdx].uuid = data.uuid;
                    accounts[existingIdx].trPass = data.trPass;
                    accounts[existingIdx].subPath = data.subPath;
                    PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
                    window._activeCloudAccount = accounts[existingIdx];
                    renderCloudAccounts();
                    
                    openSettingsModalForAccount(data.url, data.subPath);
                }
            }

        } else {
            addTerminalLog("خطا در استقرار: " + data.error, "error");
            toast("خطا: " + data.error);
        }
    } catch(e) {
        clearInterval(cloudTerminalInterval);
        addTerminalLog("خطا در ارتباط با سرور محلی", "error");
        toast("خطا در ارتباط با سرور محلی");
    }
    
    if (btn) { btn.disabled = false; if (btn._originalHtml) { btn.innerHTML = btn._originalHtml; delete btn._originalHtml; } }
    
    if (deployIcon) {
        deployIcon.classList.remove("animate-spin");
        deployIcon.innerHTML = `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>`;
    }
}
window.hideSubdomainFixModal = function() {
    const modal = document.getElementById("subdomain-fix-modal");
    if (modal) {
        modal.classList.add("hidden");
        modal.classList.remove("flex");
    }
}

window.saveNewSubdomainAndDeploy = async function() {
    if (!window._activeCloudAccount) {
        toast("لطفا ابتدا اکانتی را انتخاب کنید");
        return;
    }
    const email = window._activeCloudAccount.email || "";
    const token = window._activeCloudAccount.token;
    const newSubdomain = document.getElementById("new-subdomain-input")?.value.trim();
    const btn = document.getElementById("btn-save-subdomain");

    if (!newSubdomain) {
        toast("لطفاً نام جدید را وارد کنید");
        return;
    }

    if (btn) btn.disabled = true;
    const oldHtml = btn ? btn.innerHTML : "";
    if (btn) btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> در حال ذخیره...';

    try {
        const res = await fetch("/api/cloudflare/set-subdomain", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, token, newSubdomain })
        });
        const data = await res.json();
        
        if (data.success) {
            toast("ساب‌دامین با موفقیت تغییر کرد! حالا در حال استقرار...");
            hideSubdomainFixModal();
            // Wait a little bit for DNS to propagate locally and state to be saved
            setTimeout(() => {
                deployCloudflare();
            }, 1000);
        } else if (data.requiresManualChange) {
            toast("برای اعمال تغییرات وارد پنل کلودفلر شوید.");
            if (btn) btn.innerHTML = oldHtml;
            const manualSection = document.getElementById("manual-change-section");
            if (manualSection) {
                manualSection.classList.remove("hidden");
                manualSection.classList.add("flex");
            }
            // Hide the input area so they are forced to do it manually
            const inputArea = document.getElementById("new-subdomain-input")?.parentElement;
            if (inputArea) inputArea.classList.add("hidden");
            if (btn) btn.classList.add("hidden");
            
            // Hide workers section
            const workersSection = document.getElementById("workers-management-section");
            if (workersSection) {
                workersSection.classList.add("hidden");
                workersSection.classList.remove("flex");
            }
        } else {
            toast("خطا: " + (data.message || ""));
            const errorEl = document.getElementById("subdomain-error");
            if (errorEl) {
                errorEl.innerText = data.message || "خطای نامشخص";
                errorEl.classList.remove("hidden");
            }
            // Shake the input to draw attention
            const inputEl = document.getElementById("new-subdomain-input");
            if (inputEl) {
                inputEl.classList.add("animate-shake", "border-gs-border");
                setTimeout(() => inputEl.classList.remove("animate-shake", "border-gs-border"), 500);
            }
            if (btn) { btn.disabled = false; if (btn._originalHtml) { btn.innerHTML = btn._originalHtml; delete btn._originalHtml; } }
            if (btn) btn.innerHTML = oldHtml;
        }
    } catch(e) {
        toast("خطا در ارتباط با سرور محلی");
        if (btn) { btn.disabled = false; if (btn._originalHtml) { btn.innerHTML = btn._originalHtml; delete btn._originalHtml; } }
        if (btn) btn.innerHTML = oldHtml;
    }
}

window.loadCloudflareWorkers = async function(email, token) {
    const container = document.getElementById("workers-list-container");
    const section = document.getElementById("workers-management-section");
    const saveBtn = document.getElementById("btn-save-subdomain");
    const manualSection = document.getElementById("manual-change-section");
    const inputArea = document.getElementById("new-subdomain-input")?.parentElement;
    
    // Reset modal state
    if (manualSection) {
        manualSection.classList.add("hidden");
        manualSection.classList.remove("flex");
    }
    if (inputArea) inputArea.classList.remove("hidden");
    if (saveBtn) saveBtn.classList.remove("hidden");
    
    if (!container || !section) return;
    
    section.classList.remove("hidden");
    section.classList.add("flex");
    container.innerHTML = '<div class="text-[11px] text-m3-onSurfaceVariant text-center py-2"><i class="ph-bold ph-spinner animate-spin"></i> در حال بارگذاری ورکرها...</div>';
    
    try {
        const res = await fetch("/api/cloudflare/list-workers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, token })
        });
        const data = await res.json();
        
        if (data.success) {
            window._currentCloudWorkers = data.workers || [];
            renderWorkersList();
            
            // Do not disable save button based on existing workers
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.title = "";
                saveBtn.classList.remove("opacity-50", "cursor-not-allowed");
            }
            if (window._currentCloudWorkers.length === 0) {
                section.classList.add("hidden");
                section.classList.remove("flex");
            }
        } else {
            container.innerHTML = '<div class="text-[11px] text-gs-muted text-center py-2">خطا در دریافت لیست: ' + (data.message || "") + '</div>';
        }
    } catch (e) {
        container.innerHTML = '<div class="text-[11px] text-gs-muted text-center py-2">خطا در ارتباط شبکه</div>';
    }
}

window.renderWorkersList = function() {
    const container = document.getElementById("workers-list-container");
    if (!container) return;
    
    const workers = window._currentCloudWorkers || [];
    if (workers.length === 0) {
        container.innerHTML = '<div class="text-[11px] text-mv-green-ink text-center py-2 font-bold">هیچ ورکری در اکانت وجود ندارد. می‌توانید ساب‌دامین را تغییر دهید.</div>';
        const saveBtn = document.getElementById("btn-save-subdomain");
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.classList.remove("opacity-50", "cursor-not-allowed");
            saveBtn.title = "";
        }
        return;
    }
    
    let html = "";
    workers.forEach(w => {
        const isBad = w.name.toLowerCase().includes("bpb") || w.name.toLowerCase().includes("vpn") || w.name.toLowerCase().includes("panel") || w.name.toLowerCase().includes("vless") || w.name.toLowerCase().includes("proxy");
        
        html += `
            <div class="flex items-center justify-between bg-m3-surface border border-m3-outline rounded p-2 text-xs font-mono">
                <div class="flex items-center gap-2">
                    <span class="${isBad ? 'text-gs-muted font-bold' : 'text-m3-onSurface'}">${w.name}</span>
                    ${isBad ? '<span class="text-[9px] bg-gs-panel/20 text-gs-muted px-1 rounded">آلوده</span>' : ''}
                </div>
                <button onclick="deleteWorker('${w.name}', this)" class="text-gs-muted hover:bg-gs-panel/10 p-1 rounded transition-colors" title="حذف ورکر">
                    <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>
        `;
    });
    container.innerHTML = html;
}

window.deleteWorker = async function(name, btn) {
    if (!await uiConfirm({
        title: `ورکر «${name}» حذف شود؟`,
        message: 'این ورکر از حساب کلادفلر شما پاک می‌شود و کانفیگ‌هایی که از آن استفاده می‌کنند از کار می‌افتند.',
        confirmLabel: 'حذف کن', danger: true,
    })) return;
    
    const email = document.getElementById("cloud-api-email")?.value.trim();
    const token = document.getElementById("cloud-api-token")?.value.trim();
    
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i>';
    }
    
    try {
        const res = await fetch("/api/cloudflare/delete-worker", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, token, workerName: name })
        });
        const data = await res.json();
        
        if (data.success) {
            toast(`ورکر ${name} با موفقیت حذف شد`);
            window._currentCloudWorkers = window._currentCloudWorkers.filter(w => w.name !== name);
            renderWorkersList();
        } else {
            toast("خطا در حذف: " + (data.message || ""));
            if (btn) btn.innerHTML = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
            if (btn) { btn.disabled = false; if (btn._originalHtml) { btn.innerHTML = btn._originalHtml; delete btn._originalHtml; } }
        }
    } catch (e) {
        toast("خطا در شبکه");
        if (btn) btn.innerHTML = '<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
        if (btn) { btn.disabled = false; if (btn._originalHtml) { btn.innerHTML = btn._originalHtml; delete btn._originalHtml; } }
    }
}

window.deleteAllWorkers = async function() {
    const workers = window._currentCloudWorkers || [];
    if (workers.length === 0) return;
    
    if (!await uiConfirm({
        title: `همه‌ی ${workers.length} ورکر حذف شوند؟`,
        message: 'این کار غیرقابل بازگشت است و همه‌ی کانفیگ‌هایی که روی این ورکرها ساخته‌اید از کار می‌افتند.',
        confirmLabel: `حذف هر ${workers.length} ورکر`, danger: true,
    })) return;
    
    const email = document.getElementById("cloud-api-email")?.value.trim();
    const token = document.getElementById("cloud-api-token")?.value.trim();
    
    toast("در حال حذف همه ورکرها... لطفا صبر کنید");
    
    for (let i = 0; i < workers.length; i++) {
        try {
            await fetch("/api/cloudflare/delete-worker", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email, token, workerName: workers[i].name })
            });
        } catch(e) {}
    }
    
    toast("عملیات حذف گروهی به پایان رسید.");
    loadCloudflareWorkers(email, token); // Refresh list
}

async function openSettingsModalForAccount(url, subPath) {
    currentCloudFetchUrl = url;
    currentCloudFetchSubPath = subPath;
    document.getElementById("settings-modal")?.classList.remove("hidden");
    
    try {
        const btn = document.getElementById("cloud-account-name"); // Using some element to know we are fetching
        toast("در حال اتصال و دریافت تنظیمات پنل...");
        const res = await fetch("/api/cloudflare/bpb-settings/get", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url,
                subPath,
                email: window._activeCloudAccount?.email || '',
                token: window._activeCloudAccount?.token || ''
            })
        });
        const data = await res.json();
        
        let settings = data.settings;
        
        if (typeof data === 'string' || typeof data.settings === 'string') {
            toast("خطا: پاسخ نامعتبر از سرور (احتمالاً نیاز به لاگین یا مشکل کلودفلر).");
            return;
        }

        if (data.success && settings) {
            // Extract settings based on BPB API wrapper
            if (settings.body && settings.body.proxySettings) {
                settings = settings.body.proxySettings;
            } else if (settings.proxySettings) {
                settings = settings.proxySettings;
            } else if (settings.settings) {
                settings = settings.settings;
            }

            if (typeof settings === 'object' && !settings.error && (settings.proxyIPs !== undefined || settings.vless !== undefined || Object.keys(settings).length >= 0)) {
                toast("تنظیمات پنل با موفقیت دریافت شد.");
            
            // Common Settings
            if (document.getElementById("cloud-allow-lan")) document.getElementById("cloud-allow-lan").checked = !!settings.allowLANConnection;
            if (document.getElementById("cloud-ipv6-new")) document.getElementById("cloud-ipv6-new").checked = !!settings.enableIPv6;
            
            // Protocols
            if (document.getElementById("cloud-proto-vless")) {
                let vlessVal = settings.VLConfigs !== undefined ? settings.VLConfigs : (settings.vless !== undefined ? settings.vless : true);
                document.getElementById("cloud-proto-vless").checked = !!vlessVal;
            }
            if (document.getElementById("cloud-proto-trojan")) {
                let trojanVal = settings.TRConfigs !== undefined ? settings.TRConfigs : (settings.trojan !== undefined ? settings.trojan : true);
                document.getElementById("cloud-proto-trojan").checked = !!trojanVal;
            }
            
            // Ports (Default to all if missing!)
            const allTlsPorts = ["443", "8443", "2053", "2083", "2087", "2096"];
            const allNonTlsPorts = ["80", "8080", "8880", "2052", "2082", "2086", "2095"];
            const hasPorts = settings.tlsPorts || settings.nonTlsPorts || settings.ports;
            
            const pArray = Array.isArray(settings.ports) ? settings.ports.map(String) : [];
            const tlsP = Array.isArray(settings.tlsPorts) ? settings.tlsPorts.map(String) : pArray;
            const nonTlsP = Array.isArray(settings.nonTlsPorts) ? settings.nonTlsPorts.map(String) : pArray;
            
            document.querySelectorAll("input[name='cloud-tls-port-new']").forEach(cb => {
                cb.checked = hasPorts ? tlsP.includes(String(cb.value)) : allTlsPorts.includes(String(cb.value));
            });
            document.querySelectorAll("input[name='cloud-nontls-port-new']").forEach(cb => {
                cb.checked = hasPorts ? nonTlsP.includes(String(cb.value)) : allNonTlsPorts.includes(String(cb.value));
            });
            
            // Proxy IP Mode
            const mode = settings.proxyIPMode || settings.chainProxy || "proxyip";
            document.querySelectorAll("input[name='cloud-proxy-mode']").forEach(r => r.checked = false);
            const modeRadio = document.querySelector(`input[name='cloud-proxy-mode'][value='${mode}']`);
            if (modeRadio) {
                modeRadio.checked = true;
                // trigger onchange
                if (mode === 'proxyip') {
                    document.getElementById('proxyip-container').classList.remove('hidden');
                    document.getElementById('nat64-container').classList.add('hidden');
                } else {
                    document.getElementById('proxyip-container').classList.add('hidden');
                    document.getElementById('nat64-container').classList.remove('hidden');
                }
            }
            
            // Populate Proxy IP
            const proxyIpInput = document.getElementById("cloud-proxyip-new");
            if (proxyIpInput && settings.proxyIPs) {
                let firstIp = Array.isArray(settings.proxyIPs) && settings.proxyIPs.length > 0 ? settings.proxyIPs[0] : (typeof settings.proxyIPs === 'string' ? settings.proxyIPs : "");
                let exists = false;
                for (let i = 0; i < proxyIpInput.options.length; i++) {
                    if (proxyIpInput.options[i].value === firstIp) exists = true;
                }
                if (!exists && firstIp) {
                    const opt = document.createElement('option');
                    opt.value = firstIp;
                    opt.innerHTML = firstIp;
                    proxyIpInput.appendChild(opt);
                }
                proxyIpInput.value = firstIp;
            }
            
            // Populate NAT64
            const nat64Input = document.getElementById("cloud-nat64-new");
            if (nat64Input && settings.prefixes) {
                let firstPrefix = Array.isArray(settings.prefixes) && settings.prefixes.length > 0 ? settings.prefixes[0] : (typeof settings.prefixes === 'string' ? settings.prefixes : "");
                let exists = false;
                for (let i = 0; i < nat64Input.options.length; i++) {
                    if (nat64Input.options[i].value === firstPrefix) exists = true;
                }
                if (!exists && firstPrefix) {
                    const opt = document.createElement('option');
                    opt.value = firstPrefix;
                    opt.innerHTML = firstPrefix;
                    nat64Input.appendChild(opt);
                }
                nat64Input.value = firstPrefix;
            }
            
            // Populate Fragment
            if (settings.fragment && typeof settings.fragment === 'string') {
                const parts = settings.fragment.split(",");
                if (parts.length >= 3 && document.getElementById("cloud-frag-toggle")) {
                    document.getElementById("cloud-frag-toggle").checked = true;
                    document.getElementById("cloud-frag-len").value = parts[0];
                    document.getElementById("cloud-frag-int").value = parts[1];
                    document.getElementById("cloud-frag-pak").value = parts[2];
                }
            }

            }
        } else if (data.settings && (typeof data.settings === 'string' || data.settings.error)) {
            toast("خطا: رمز عبور پنل تغییر کرده یا پنل در دسترس نیست.");
        } else {
            toast("خطا از سرور: " + (data.error || "نامشخص"));
            console.error("Panel settings error:", data.error);
        }
    } catch(e) {
        console.error("Failed to fetch panel settings", e);
        toast("خطا در ارتباط با سرور محلی.");
    }
}
window.openSettingsModalForAccount = openSettingsModalForAccount;

function showSettingsModal() {
    document.getElementById("settings-modal")?.classList.remove("hidden");
}
window.showSettingsModal = showSettingsModal;

function hideSettingsModal() {
    document.getElementById("settings-modal")?.classList.add("hidden");
}
window.hideSettingsModal = hideSettingsModal;

window.renderCloudAccounts = function() {
    const container = document.getElementById("cloud-accounts-container");
    if (typeof window.cloudRenderIdent === 'function') window.cloudRenderIdent();
    if (!container) return;
    const accounts = loadCloudAccounts();

    const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    if (accounts.length === 0) {
        container.innerHTML = `
        <div class="mv-form-group">
          <div class="mv-empty">
            <i class="ph-fill ph-cloud-slash" style="font-size:30px;opacity:.5"></i>
            <p>هیچ اکانتی متصل نیست.</p>
            <p>از «افزودن اکانت» در نوار کناری شروع کنید — فقط ایمیل و Global API Key کلودفلر لازم است.</p>
          </div>
        </div>`;
        return;
    }

    /**
     * One panel of one account, as a form row.
     *
     * THE PRIMARY BUTTON IS THE NEXT THING TO DO, not always the same one: before a worker is
     * deployed the only useful press is «استقرار»; afterwards it is «دریافت کانفیگ». The old card
     * carried that meaning in six hand-written class strings per panel.
     */
    function panelRow(accId, key, label, deployed, deployLabel, mainLabel, mainAction, hasSettings) {
        const deployCls = 'mv-btn' + (deployed ? '' : ' mv-btn--primary');
        const mainCls = 'mv-btn' + (deployed ? ' mv-btn--primary' : '');
        return `
          <div class="mv-form-row">
            <span class="mv-form-label">${esc(label)}<small${deployed ? ' class="is-on"' : ''}>${deployed ? 'مستقر شده' : 'هنوز مستقر نشده'}</small></span>
            <span class="mv-form-control">
              <button type="button" class="${deployCls}" onclick="window.triggerAction(this, 'DEPLOY', '${accId}', '${key}')">${esc(deployLabel)}</button>
              <button type="button" class="${mainCls}" onclick="window.triggerAction(this, '${mainAction}', '${accId}', '${key}')">${esc(mainLabel)}</button>
              ${hasSettings ? `<button type="button" class="mv-tb-btn" onclick="window.triggerAction(this, 'SETTINGS', '${accId}', '${key}')" title="تنظیمات ${esc(label)}" aria-label="تنظیمات ${esc(label)}"><i class="ph-bold ph-gear"></i></button>` : ''}
            </span>
          </div>`;
    }

    container.innerHTML = accounts.map((acc, i) => {
        const accName = acc.email || acc.name || ("Account " + (i + 1));
        const bpb = !!acc.url, edge = !!acc.edgeUrl, zeus = !!acc.zeusUrl;
        const live = [bpb, edge, zeus].filter(Boolean).length;

        return `
        <div class="mv-form-group cl-acc">
          <div class="mv-status-head">
            <span class="mv-side-tile" style="--tint:var(--mv-orange)"><i class="ph-fill ph-cloud"></i></span>
            <div class="mv-sh-text">
              <h2><bdi dir="ltr" style="font-family:var(--mv-font-tech)">${esc(accName)}</bdi></h2>
              <p>${live ? `${['یک', 'دو', 'سه'][live - 1]} پنل مستقر است` : 'هنوز پنلی مستقر نشده'}</p>
            </div>
            <div class="mv-sh-end">
              <button type="button" class="mv-tb-btn" onclick="window.toggleUsagePanel('${acc.id}')" title="مصرف امروزِ ورکرها" aria-label="مصرف امروز"><i class="ph-bold ph-chart-pie-slice"></i></button>
              <button type="button" class="mv-tb-btn" onclick="window.deleteCloudAccount('${acc.id}')" title="حذف اکانت" aria-label="حذف اکانت"><i class="ph-bold ph-trash"></i></button>
            </div>
          </div>

          <div class="mv-form-row is-stack hidden cl-usage" id="usage-panel-${acc.id}">
            <div class="cl-usage-top">
              <span>درخواست‌های ورکر (امروز)</span>
              <span class="cl-usage-reset">ریست: ۰۳:۳۰ بامداد</span>
            </div>
            <div class="cl-usage-top">
              <span id="usage-text-${acc.id}" class="mv-form-value">در حال دریافت…</span>
              <span class="mv-form-value" style="opacity:.6">100,000</span>
            </div>
            <div class="cl-usage-bar"><div id="usage-bar-${acc.id}" style="width:0%"></div></div>
          </div>

          ${panelRow(acc.id, 'BPB', 'پنل BPB', bpb, bpb ? 'استقرار مجدد' : 'استقرار ورکر', 'دریافت کانفیگ', 'FETCH', false)}
          ${panelRow(acc.id, 'EDGE', 'پنل Edge', edge, edge ? 'استقرار مجدد' : 'استقرار ورکر', 'دریافت کانفیگ', 'FETCH', true)}
          ${panelRow(acc.id, 'ZEUS', 'پنل Zeus', zeus, zeus ? 'استقرار مجدد' : 'استقرار', 'مدیریت کاربران', 'FETCH', true)}
        </div>`;
    }).join('');
};

window.checkCloudflareUsage = async function(btn, url, index, accEmail, accToken) {
    const container = document.getElementById(`usage-container-${index}`);
    const bar = document.getElementById(`usage-bar-${index}`);
    const text = document.getElementById(`usage-text-${index}`);
    
    if (!container || !bar || !text) return;
    
    // Toggle logic
    if (!container.classList.contains("hidden") && bar.style.width !== "0%") {
        container.classList.add("hidden");
        return;
    }
    
    const emailInput = document.getElementById("cloud-api-email");
    const tokenInput = document.getElementById("cloud-api-token");
    const email = accEmail || emailInput?.value.trim() || PersistentStorage.getItem("cf_saved_email") || "";
    const token = accToken || tokenInput?.value.trim() || PersistentStorage.getItem("cf_saved_token") || "";
    
    if (!token) {
        toast("لطفا ایمیل و توکن کلودفلر را در فیلدهای بالای صفحه وارد کنید", 4000);
        return;
    }
    
    // Save to localStorage so user doesn't have to retype
    PersistentStorage.setItem("cf_saved_email", email);
    PersistentStorage.setItem("cf_saved_token", token);
    
    container.classList.remove("hidden");
    text.innerText = "در حال دریافت آمار از سرور...";
    bar.style.width = "0%";
    
    const originalText = btn.innerText;
    btn.innerText = "...";
    btn.disabled = true;
    
    try {
        const res = await fetch("/api/cloudflare/usage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, token })
        });
        const data = await res.json();
        
        btn.innerText = originalText;
        btn.disabled = false;
        
        if (data.success) {
            const realUsage = data.requests || 0;
            const limit = 100000;
            const percentage = (realUsage / limit) * 100;
            
            text.innerText = `مصرف روزانه: ${realUsage.toLocaleString()} درخواست`;
            bar.style.width = `${Math.min(percentage, 100)}%`;
            
            if (percentage > 85) {
                bar.style.backgroundColor = "var(--mv-red)"; // google-red
            } else if (percentage > 50) {
                bar.style.backgroundColor = "var(--mv-yellow)"; // google-yellow
            } else {
                bar.style.backgroundColor = "var(--mv-green)"; // google-green
            }
        } else {
            console.error("Cloudflare usage error:", data);
            text.innerText = "خطا: " + (data.message ? data.message : JSON.stringify(data));
            bar.style.width = "0%";
        }
    } catch (e) {
        btn.innerText = originalText;
        btn.disabled = false;
        text.innerText = "خطا در ارتباط با سرور محلی";
        bar.style.width = "0%";
    }
}








window.prepareCloudFetch = function(btn, url, subPath) {
    if (url) currentCloudFetchUrl = url;
    if (subPath) currentCloudFetchSubPath = subPath;
    
    if (typeof openSettingsModalForAccount === "function") {
        openSettingsModalForAccount(currentCloudFetchUrl, currentCloudFetchSubPath);
    } else if (typeof showSettingsModal === "function") {
        showSettingsModal();
    } else {
        window.fetchCloudNodes(document.getElementById('modal-fetch-btn') || btn);
    }
};

window.renderCloudReceivedConfigs = function() {
    const container = document.getElementById("cloud-received-configs-container");
    if (!container) return;
    
    const bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
    
    if (bases.length === 0) {
        container.innerHTML = `
            <div class="text-center py-6 text-m3-onSurfaceVariant text-sm">
                کانفیگی دریافت نشده است. ابتدا ورکر را مستقر کنید.
            </div>
        `;
        return;
    }
    
    container.innerHTML = bases.map((group, idx) => `
        <div class="p-3.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 bg-m3-surface2 rounded-2xl">
            <div class="flex items-center gap-3 min-w-0 flex-1">
                <div class="w-12 h-12 bg-m3-background rounded-xl flex items-center justify-center shadow-inner shrink-0">
                    <span class="text-xl font-bold text-m3-onSurface font-mono">${group.configs.length}</span>
                </div>
                <div class="flex flex-col text-right min-w-0">
                    <span class="font-bold text-m3-onSurface text-sm truncate" title="${group.name || "کلاستر کلودفلر"}">${group.name || "کلاستر کلودفلر"}</span>
                    <div class="text-[11px] text-m3-onSurfaceVariant mt-1 flex items-center gap-1.5">
                        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        <span class="truncate">تاریخ دریافت: ${group.date || "-"}</span>
                    </div>
                </div>
            </div>

            <div class="flex flex-wrap gap-2 items-center justify-end w-full sm:w-auto">
                <button onclick="window.renameCloudGroup('${group.id}')" class="p-2 rounded-xl bg-m3-surface hover:bg-m3-surface3 text-m3-onSurfaceVariant transition-colors flex items-center justify-center shrink-0" title="تغییر نام">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>
                </button>
                <button onclick="window.deleteCloudGroup('${group.id}')" class="p-2 rounded-xl bg-m3-surface hover:bg-mv-red/10 hover:text-mv-red-ink text-m3-onSurfaceVariant transition-colors flex items-center justify-center shrink-0" title="حذف گروه">
                    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
                </button>
                <button onclick="window.sendCloudConfigsToV2ray('${group.id}')" class="bg-m3-surface hover:bg-m3-primary/10 hover:text-m3-primary text-m3-onSurfaceVariant text-xs font-bold px-3 py-2 rounded-xl transition-all flex-1 min-w-[84px] flex items-center justify-center gap-1.5" title="ارسال به V2Ray">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                    <span class="truncate">به V2Ray</span>
                </button>
                <button onclick="window.copyCloudConfigs('${group.id}')" class="bg-m3-primary text-m3-onPrimary hover:bg-m3-primary/90 text-xs font-bold px-3 py-2 rounded-xl transition-all shadow-sm flex-1 min-w-[72px] flex items-center justify-center gap-1.5">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    <span class="truncate">کپی</span>
                </button>
            </div>
        </div>
    `).join("");
};

window.renameCloudGroup = function(groupId) {
    let bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
    const idx = bases.findIndex(b => b.id === groupId);
    if (idx === -1) return;
    
    const modalId = 'custom-prompt-' + Date.now();
    const modalHtml = `
    <div id="${modalId}" class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-mv-scrim backdrop-blur-sm transition-opacity duration-300">
        <div class="bg-m3-surface border border-m3-outline rounded-2xl p-6 w-full max-w-sm shadow-2xl transform transition-transform duration-300">
            <h3 class="text-xl font-bold text-mv-label mb-4">تغییر نام گروه</h3>
            <input type="text" id="${modalId}-input" value="${bases[idx].name || ''}" class="w-full bg-m3-surface2 border border-m3-outline text-m3-onSurface rounded-xl px-4 py-3 mb-6 focus:outline-none focus:border-m3-primary transition-colors text-right" dir="auto" />
            <div class="flex justify-end gap-3">
                <button id="${modalId}-cancel" class="px-5 py-2 rounded-xl text-m3-secondary hover:bg-m3-surfaceActive transition-colors">انصراف</button>
                <button id="${modalId}-save" class="px-5 py-2 rounded-xl bg-m3-primary text-m3-onPrimary hover:bg-m3-primary/90 transition-colors font-medium">ذخیره</button>
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = document.getElementById(modalId);
    const input = document.getElementById(`${modalId}-input`);
    
    setTimeout(() => {
        if(input) {
            input.focus();
            input.select();
        }
    }, 50);
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('opacity-0');
            if(modal.children[0]) modal.children[0].classList.add('scale-95');
            setTimeout(() => modal.remove(), 300);
        }
    };
    
    document.getElementById(`${modalId}-cancel`).onclick = closeModal;
    
    const applySave = () => {
        const newName = input.value;
        if (newName && newName.trim() !== "") {
            bases[idx].name = newName.trim();
            PersistentStorage.setItem("cf_base_configs", JSON.stringify(bases));
            
            if (typeof window.renderCloudReceivedConfigs === 'function') {
                window.renderCloudReceivedConfigs();
            }
            if (typeof renderBaseConfigs === 'function') {
                renderBaseConfigs();
            }
        }
        closeModal();
    };
    
    document.getElementById(`${modalId}-save`).onclick = applySave;
    input.onkeyup = (e) => { if(e.key === 'Enter') applySave(); };
};

window.deleteCloudGroup = function(groupId) {
    const modalId = 'custom-confirm-' + Date.now();
    const modalHtml = `
    <div id="${modalId}" class="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-mv-scrim backdrop-blur-sm transition-opacity duration-300">
        <div class="bg-m3-surface border border-m3-outline rounded-2xl p-6 w-full max-w-sm shadow-2xl transform transition-transform duration-300">
            <h3 class="text-xl font-bold text-mv-label mb-2">حذف گروه</h3>
            <p class="text-m3-secondary text-sm mb-6 leading-relaxed">آیا از حذف این گروه کانفیگ اطمینان دارید؟ این عمل قابل بازگشت نیست.</p>
            <div class="flex justify-end gap-3">
                <button id="${modalId}-cancel" class="px-5 py-2 rounded-xl text-m3-secondary hover:bg-m3-surfaceActive transition-colors">انصراف</button>
                <button id="${modalId}-confirm" class="px-5 py-2 rounded-xl bg-mv-red-fill text-white hover:bg-mv-red-fill/90 transition-colors font-medium">بله، حذف کن</button>
            </div>
        </div>
    </div>`;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = document.getElementById(modalId);
    
    const closeModal = () => {
        if (modal) {
            modal.classList.add('opacity-0');
            if(modal.children[0]) modal.children[0].classList.add('scale-95');
            setTimeout(() => modal.remove(), 300);
        }
    };
    
    document.getElementById(`${modalId}-cancel`).onclick = closeModal;
    
    document.getElementById(`${modalId}-confirm`).onclick = () => {
        let bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
        bases = bases.filter(b => b.id !== groupId);
        PersistentStorage.setItem("cf_base_configs", JSON.stringify(bases));
        
        if (typeof window.renderCloudReceivedConfigs === 'function') {
            window.renderCloudReceivedConfigs();
        }
        if (typeof renderBaseConfigs === 'function') {
            renderBaseConfigs();
        }
        closeModal();
    };
};

window.copyCloudConfigs = function(groupId) {
    const bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
    const group = bases.find(b => b.id === groupId);
    if (!group || !group.configs) {
        toast("خطا در کپی کانفیگ‌ها");
        return;
    }
    
    let textToCopy = "";
    group.configs.forEach(node => {
        if (typeof node === 'string') {
            textToCopy += node + "\n";
        } else if (typeof window.generateVlessUri === 'function' && node.vless) {
            textToCopy += window.generateVlessUri(node.vless) + "\n";
        } else if (typeof window.generateTrojanUri === 'function' && node.trojan) {
            textToCopy += window.generateTrojanUri(node.trojan) + "\n";
        } else if (node.uri) {
            textToCopy += node.uri + "\n";
        }
    });
    
    if (!textToCopy) {
        toast("فرمت کانفیگ‌ها نامعتبر است");
        return;
    }
    
    navigator.clipboard.writeText(textToCopy).then(() => {
        toast(`${group.configs.length} کانفیگ با موفقیت کپی شد`);
    }).catch(err => {
        toast("مرورگر اجازه کپی به کلیپ‌بورد را نداد");
    });
};

window.sendCloudConfigsToV2ray = function(groupId) {
    const bases = JSON.parse(PersistentStorage.getItem("cf_base_configs") || "[]");
    const group = bases.find(b => b.id === groupId);
    if (!group || !group.configs) {
        toast("این گروه یافت نشد");
        return;
    }
    
    window.v2rayList = window.v2rayList || [];
    let addedCount = 0;
    
    // Determine the sub-group label (user-given name like "احسان", "محسن")
    const subGroupLabel = group.name || 'Cloud';
    
    group.configs.forEach(node => {
        let uriStr = "";
        if (typeof node === 'string') {
            uriStr = node;
        } else if (typeof window.generateVlessUri === 'function' && node.vless) {
            uriStr = window.generateVlessUri(node.vless);
        } else if (typeof window.generateTrojanUri === 'function' && node.trojan) {
            uriStr = window.generateTrojanUri(node.trojan);
        } else if (node.uri) {
            uriStr = node.uri;
        }
        
        if (uriStr) {
            let lowerUri = uriStr.toLowerCase();
            let hasPanelTag = lowerUri.includes('edge') || lowerUri.includes('bpb') || lowerUri.includes('zeus');
            
            let tagToAppend = ' (BPB)';
            if (group.metadata && group.metadata.edgeUuid) tagToAppend = ' (Edge)';
            else if (group.metadata && group.metadata.zeusUrl) tagToAppend = ' (Zeus)';
            
            let subTag = ' [' + subGroupLabel + ']';
            
            if (uriStr.includes('#')) {
                let basePart = uriStr.split('#')[0];
                let fragPart = '';
                try { fragPart = decodeURIComponent(uriStr.split('#')[1] || ''); } catch(e) { fragPart = uriStr.split('#')[1] || ''; }
                if (!hasPanelTag) fragPart += tagToAppend;
                fragPart += subTag;
                uriStr = basePart + '#' + encodeURIComponent(fragPart);
            } else {
                uriStr = uriStr + '#' + encodeURIComponent(subGroupLabel + tagToAppend + subTag);
            }
            
            // No seeded figures: the panel draws "not measured" for a node with no
            // number, and a fake -1 used to read as a failed test on a brand-new import.
            window.v2rayList.unshift({
                id: 'conf_' + Date.now() + Math.random(),
                uri: uriStr,
            });
            addedCount++;
        }
    });
    
    if (addedCount > 0) {
        if (typeof window.saveV2rayList === 'function') window.saveV2rayList();
        if (typeof window.renderV2rayList === 'function') window.renderV2rayList();
        toast(`${addedCount} کانفیگ به V2Ray افزوده شد`);
        if (typeof window.toggleLeftSidebar === 'function') {
            window.toggleLeftSidebar('v2ray');
        }
    } else {
        toast("کانفیگ معتبری یافت نشد");
    }
};


window.showUndeployedModal = function(accountId, btnElement) {
    const modal = document.getElementById('undeployed-modal');
    if (!modal) return;
    
    // Dynamic text based on panelType
    const titleEl = modal.querySelector('h3');
    if (titleEl) {
        if (window._activePanelType === 'ZEUS') titleEl.innerText = "پنل زئوس مستقر نشده است";
        else if (window._activePanelType === 'EDGE') titleEl.innerText = "پنل Edge مستقر نشده است";
        else titleEl.innerText = "پنل مستقر نشده است";
    }
    
    // Setup deploy button
    const deployBtn = document.getElementById('undeployed-modal-deploy-btn');
    deployBtn.onclick = function() {
        hideUndeployedModal();
        if (window._activeCloudAccount) {
            if (window._activePanelType === 'EDGE') {
                if (typeof window.deployEdgeWorker === 'function') window.deployEdgeWorker(btnElement, window._activeCloudAccount.id);
            } else {
                window.deployCloudflare(false, btnElement);
            }
        }
    };
    
    modal.classList.remove('hidden');
    // Animate in
    setTimeout(() => {
        modal.classList.remove('opacity-0');
        modal.querySelector('.transform').classList.remove('scale-95');
    }, 10);
};

window.hideUndeployedModal = function() {
    const modal = document.getElementById('undeployed-modal');
    if (!modal) return;
    
    modal.classList.add('opacity-0');
    modal.querySelector('.transform').classList.add('scale-95');
    setTimeout(() => {
        modal.classList.add('hidden');
    }, 300);
};


window._zeusActiveAcc = null;

window.showZeusUsersModal = function(acc) {
    window._zeusActiveAcc = acc;
    document.getElementById("zeus-users-modal").classList.remove("hidden");
    document.getElementById("zeus-users-modal").classList.add("flex");
    loadZeusUsers(acc);
};

window.hideZeusUsersModal = function() {
    document.getElementById("zeus-users-modal").classList.add("hidden");
    document.getElementById("zeus-users-modal").classList.remove("flex");
    resetZeusForm(true);
};

window.showZeusSettingsModal = function(acc) {
    window._zeusActiveAcc = acc;
    document.getElementById("zeus-settings-modal").classList.remove("hidden");
    document.getElementById("zeus-settings-modal").classList.add("flex");
    loadZeusSettings(acc);
};

window.hideZeusSettingsModal = function() {
    document.getElementById("zeus-settings-modal").classList.add("hidden");
    document.getElementById("zeus-settings-modal").classList.remove("flex");
};

function formatZeusGb(val) {
    if (!val) return 'نامحدود';
    if (val < 1) return (val * 1024).toFixed(0) + ' MB';
    return parseFloat(val).toFixed(2) + ' GB';
}

function calcZeusRemainingDays(created_at, expiry_days, serverTime) {
    if (!expiry_days) return 'نامحدود';
    if (!created_at) return 'نامشخص';
    const created = new Date(created_at);
    const expiryDate = new Date(created.getTime() + (expiry_days * 24 * 60 * 60 * 1000));
    const diffDays = Math.ceil((expiryDate - new Date(serverTime)) / (1000 * 60 * 60 * 24));
    return diffDays > 0 ? diffDays : 0;
}

window.callZeusProxy = async function callZeusProxy(acc, endpoint, method = 'GET', body = null) {
    if(!acc.url) throw new Error("پنل دیپلوی نشده است");
    const res = await fetch("/api/cloudflare/zeus/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            workerUrl: acc.url,
            password: 'Admin123!',
            endpoint,
            method,
            body
        })
    });
    if (!res.ok) {
        const d = await res.json().catch(e=>({}));
        throw new Error(d.error || 'Request Failed');
    }
    return await res.json();
}

async function loadZeusUsers(acc) {
    document.getElementById("zeus-users-loading").classList.remove("hidden");
    try {
        const data = await callZeusProxy(acc, '/api/users?t=' + Date.now());
        const tbody = document.getElementById("zeus-users-tbody");
        const empty = document.getElementById("zeus-users-empty");
        
        if (!data.users || data.users.length === 0) {
            tbody.innerHTML = "";
            empty.classList.remove("hidden");
            acc.zeusUserCount = 0;
            try {
                let accounts = JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]');
                let idx = accounts.findIndex(a => a.id === acc.id);
                if (idx !== -1) {
                    accounts[idx].zeusUserCount = 0;
                    PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
                }
            } catch(e) {}
        } else {
            empty.classList.add("hidden");
            const serverTime = data.serverTime || Date.now();
            window._zeusUsersData = data.users;
            acc.zeusUserCount = data.users.length;
            
            // Save to localStorage so it persists for the status lights
            try {
                let accounts = JSON.parse(PersistentStorage.getItem('cf_accounts') || '[]');
                let idx = accounts.findIndex(a => a.id === acc.id);
                if (idx !== -1) {
                    accounts[idx].zeusUserCount = acc.zeusUserCount;
                    PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
                }
            } catch(e) {}
            
            tbody.innerHTML = data.users.map(u => {
                const isOnline = u.is_online === 1 ? '<span class="text-mv-green-ink font-bold ml-1">●</span>' : '';
                const statusBadge = u.is_active === 1 
                    ? '<span class="bg-mv-green/10 text-mv-green-ink px-2 py-0.5 rounded text-[10px] font-bold">فعال</span>'
                    : '<span class="bg-mv-red/10 text-mv-red-ink px-2 py-0.5 rounded text-[10px] font-bold">قطع</span>';
                
                const remDays = calcZeusRemainingDays(u.created_at, u.expiry_days, serverTime);
                
                return `
                <tr class="border-b border-m3-outline hover:bg-m3-surface3/30 transition-colors">
                    <td class="px-4 py-3 font-medium text-m3-onSurface">
                        ${isOnline}${u.username}
                        <div class="mt-1">${statusBadge}</div>
                    </td>
                    <td class="px-4 py-3 text-center text-xs">
                        <div class="text-m3-onSurface font-bold">${formatZeusGb(u.used_gb)}</div>
                        <div class="text-[10px] opacity-70">از ${formatZeusGb(u.limit_gb)}</div>
                    </td>
                    <td class="px-4 py-3 text-center text-xs">
                        <div class="text-m3-onSurface font-bold">${remDays === 'نامحدود' ? 'نامحدود' : remDays + ' روز'}</div>
                        <div class="text-[10px] opacity-70">از ${u.expiry_days || '∞'}</div>
                    </td>
                    <td class="px-4 py-3 text-center">
                        <div class="grid grid-cols-4 gap-1.5 w-max mx-auto">
                                                                                    <button onclick="zeusCopySubTxt('${u.username}')" class="p-1.5 bg-m3-surface border border-m3-outline hover:bg-m3-primary/10 hover:text-m3-primary text-m3-onSurfaceVariant rounded" title="کپی لینک متنی">
                                <i class="ph-bold ph-link text-sm"></i>
                            </button>
                                                        <button onclick="zeusAskCombinerGroupName('${u.username}')" class="p-1.5 bg-m3-surface border border-m3-outline hover:bg-mv-orange/10 hover:text-mv-orange-ink text-m3-onSurfaceVariant rounded" title="انتقال به پنل ترکیب">
                                <i class="ph-bold ph-git-merge text-sm"></i>
                            </button>
                            <button onclick="zeusTransferToV2ray('${u.username}')" class="p-1.5 bg-m3-surface border border-m3-outline hover:bg-mv-pink/10 hover:text-mv-pink-ink text-m3-onSurfaceVariant rounded" title="انتقال به پنل V2ray">
                                <i class="ph-bold ph-paper-plane-right text-sm"></i>
                            </button>
                            <button onclick="zeusCopySubJson('${u.username}')" class="p-1.5 bg-m3-surface border border-m3-outline hover:bg-mv-purple/10 hover:text-mv-purple-ink text-m3-onSurfaceVariant rounded" title="کپی لینک JSON">
                                <i class="ph-bold ph-brackets-curly text-sm"></i>
                            </button>
                            <button onclick="zeusCopyStatus('${u.username}')" class="p-1.5 bg-m3-surface border border-m3-outline hover:bg-mv-teal/10 hover:text-mv-teal-ink text-m3-onSurfaceVariant rounded" title="کپی صفحه وضعیت">
                                <i class="ph-bold ph-chart-line-up text-sm"></i>
                            </button>
                            <button onclick="zeusEditUser('${u.username}')" class="p-1.5 bg-m3-surface border border-m3-outline hover:bg-mv-yellow/10 hover:text-mv-yellow-ink text-m3-onSurfaceVariant rounded" title="ویرایش">
                                <i class="ph-bold ph-pencil-simple text-sm"></i>
                            </button>
                            <button onclick="zeusToggleStatus('${u.username}')" class="p-1.5 bg-m3-surface border border-m3-outline hover:bg-mv-accent/10 hover:text-mv-blue-ink text-m3-onSurfaceVariant rounded" title="تغییر وضعیت">
                                <i class="ph-bold ph-power text-sm"></i>
                            </button>
                            <button onclick="zeusDeleteUser('${u.username}')" class="p-1.5 bg-m3-surface border border-m3-outline hover:bg-mv-red/10 hover:text-mv-red-ink text-m3-onSurfaceVariant rounded" title="حذف">
                                <i class="ph-bold ph-trash text-sm"></i>
                            </button>
                        </div>
                    </td>
                </tr>
                `;
            }).join('');
        }
    } catch(e) {
        toast("خطا در دریافت لیست کاربران: " + e.message);
    } finally {
        document.getElementById("zeus-users-loading").classList.add("hidden");
    }
}

window.resetZeusForm = function(fromModalClose = false) {
    const editMode = document.getElementById("zeus-edit-mode").value;
    
    document.getElementById("zeus-edit-mode").value = "";
    document.getElementById("zeus-user-name").value = "";
    document.getElementById("zeus-user-name").disabled = false;
    document.getElementById("zeus-user-limit").value = "";
    document.getElementById("zeus-user-expiry").value = "";
    document.getElementById("zeus-user-ips").value = "";
    document.getElementById("zeus-user-port").value = "443";
    document.getElementById("zeus-user-fp").value = "chrome";
    document.getElementById("zeus-form-title").innerText = "کاربر جدید";
    document.getElementById("zeus-submit-btn").innerText = "ثبت کاربر";
    
    if (!editMode && !fromModalClose && typeof hideZeusUsersModal === 'function') {
        hideZeusUsersModal();
    }
};

window.handleZeusAddUser = async function(e) {
    e.preventDefault();
    const btn = document.getElementById("zeus-submit-btn");
    btn.disabled = true;
    
    const editUser = document.getElementById("zeus-edit-mode").value;
    const isEdit = !!editUser;
    
    const username = document.getElementById("zeus-user-name").value;
    const limit_gb = document.getElementById("zeus-user-limit").value || null;
    const expiry_days = document.getElementById("zeus-user-expiry").value || null;
    const ips = document.getElementById("zeus-user-ips").value || null;
    const port = document.getElementById("zeus-user-port").value;
    const fingerprint = document.getElementById("zeus-user-fp").value;
    const tls = port.includes('443') ? 'on' : 'off'; // Simplify logic
    
    try {
        const endpoint = isEdit ? `/api/users/${encodeURIComponent(editUser)}` : '/api/users';
        const method = isEdit ? 'PUT' : 'POST';
        
        await callZeusProxy(window._zeusActiveAcc, endpoint, method, {
            username, limit_gb, expiry_days, ips, port, tls, fingerprint
        });
        
        toast(isEdit ? "کاربر ویرایش شد" : "کاربر جدید ساخته شد");
        resetZeusForm();
        loadZeusUsers(window._zeusActiveAcc);
    } catch(err) {
        toast("خطا: " + err.message);
    } finally {
        btn.disabled = false;
    }
};

window.zeusEditUser = function(username) {
    const u = (window._zeusUsersData || []).find(x => x.username === username);
    if(!u) return;
    
    document.getElementById("zeus-edit-mode").value = u.username;
    document.getElementById("zeus-user-name").value = u.username;
    document.getElementById("zeus-user-name").disabled = true;
    document.getElementById("zeus-user-limit").value = u.limit_gb || "";
    document.getElementById("zeus-user-expiry").value = u.expiry_days || "";
    document.getElementById("zeus-user-ips").value = u.ips || "";
    document.getElementById("zeus-user-port").value = u.port || "443";
    document.getElementById("zeus-user-fp").value = u.fingerprint || "chrome";
    
    document.getElementById("zeus-form-title").innerText = "ویرایش کاربر: " + u.username;
    document.getElementById("zeus-submit-btn").innerText = "ذخیره تغییرات";
};

window.zeusToggleStatus = async function(username) {
    if (!await uiConfirm({
        title: 'وضعیت این کاربر تغییر کند؟',
        message: `کاربر «${username}» فعال/غیرفعال می‌شود.`,
        confirmLabel: 'تغییر بده',
    })) return;
    try {
        await callZeusProxy(window._zeusActiveAcc, `/api/users/${encodeURIComponent(username)}`, 'PUT', { toggle_only: true });
        loadZeusUsers(window._zeusActiveAcc);
    } catch(e) {
        toast("خطا: " + e.message);
    }
};

window.zeusDeleteUser = async function(username) {
    if (!await uiConfirm({
        title: `کاربر «${username}» حذف شود؟`,
        message: 'این عمل غیرقابل بازگشت است.',
        confirmLabel: 'حذف کن', danger: true,
    })) return;
    try {
        await callZeusProxy(window._zeusActiveAcc, `/api/users/${encodeURIComponent(username)}`, 'DELETE');
        loadZeusUsers(window._zeusActiveAcc);
    } catch(e) {
        toast("خطا: " + e.message);
    }
};

/**
 * ساب کاربر زئوس از سمت سرور محلی گرفته می‌شود، نه مستقیم از مرورگر.
 *
 * دامنه‌ی workers.dev فیلتر است؛ `fetch` مستقیمِ رندرر روی شبکه‌ی کاربر خطا می‌داد و
 * «انتقال به پنل ترکیب» همیشه شکست می‌خورد — به همین دلیل مرکز ترکیب همیشه می‌گفت هیچ
 * نود پایه‌ای دریافت نشده. مسیر سرور از gtFetch رد می‌شود (مستقیم، بعد پروکسی لبه).
 */
window.fetchZeusSub = async function(acc, username, format = 'txt') {
    const res = await fetch('/api/cloudflare/zeus/sub', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerUrl: acc.url, username, format })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || 'دریافت ساب از پنل زئوس ناموفق بود');
    const text = String(data.content || '');
    try {
        return decodeURIComponent(escape(atob(text)));
    } catch (e) {
        return text;
    }
};

window.zeusCopySubTxt = function(username) {
    if(!window._zeusActiveAcc) return;
    const txtUrl = `${window._zeusActiveAcc.url}/sub/${encodeURIComponent(username)}`;
    navigator.clipboard.writeText(txtUrl).then(() => { toast("لینک متنی کپی شد"); });
};
window.zeusCopySubJson = function(username) {
    if(!window._zeusActiveAcc) return;
    const jsonUrl = `${window._zeusActiveAcc.url}/sub/json/${encodeURIComponent(username)}`;
    navigator.clipboard.writeText(jsonUrl).then(() => { toast("لینک JSON کپی شد"); });
};
window.zeusCopyStatus = function(username) {
    if(!window._zeusActiveAcc) return;
    const statusUrl = `${window._zeusActiveAcc.url}/status/${encodeURIComponent(username)}`;
    navigator.clipboard.writeText(statusUrl).then(() => { toast("لینک صفحه وضعیت کپی شد"); });
};
window.loadZeusSettings = async function(acc) {
    document.getElementById("zeus-settings-loading").classList.remove("hidden");
    try {
        const data = await callZeusProxy(acc, '/api/proxy-ip', 'GET');
        document.getElementById("zeus-set-proxy").value = data.proxy_ip || "proxyip.cmliussss.net";
        document.getElementById("zeus-set-iata").value = data.iata || "";
        document.getElementById("zeus-set-fraglen").value = data.frag_len || "20-30";
        document.getElementById("zeus-set-fragint").value = data.frag_int || "1-2";
    } catch(e) {
        toast("خطا در دریافت تنظیمات: " + e.message);
    } finally {
        document.getElementById("zeus-settings-loading").classList.add("hidden");
    }
};

window.handleZeusSettings = async function(e) {
    e.preventDefault();
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> در حال ذخیره...';
    try {
        const body = {
            proxy_ip: document.getElementById("zeus-set-proxy").value,
            iata: document.getElementById("zeus-set-iata").value,
            frag_len: document.getElementById("zeus-set-fraglen").value,
            frag_int: document.getElementById("zeus-set-fragint").value
        };
        await callZeusProxy(window._zeusActiveAcc, '/api/proxy-ip', 'POST', body);
        toast("تنظیمات با موفقیت ذخیره شد");
        hideZeusSettingsModal();
    } catch(err) {
        toast("خطا: " + err.message);
    } finally {
        btn.disabled = false;
        btn.innerText = "ذخیره تنظیمات";
    }
};

let _pendingCombinerUsername = null;

window.zeusAskCombinerGroupName = function(username) {
    _pendingCombinerUsername = username;
    const modal = document.getElementById('zeus-combiner-modal');
    if(!modal) return;
    const input = document.getElementById('zeus-combiner-group-input');
    input.value = username; 
    modal.classList.remove('hidden');
};

/**
 * Zeus هر ساب را با چند لینک «بنری» شروع می‌کند که هرگز وصل نمی‌شوند: دو لینک روی
 * `@0.0.0.0:1` که فقط متن تبلیغاتی پنل را در کلاینت نشان می‌دهند. اینها هم دقیقاً با
 * `vless://` شروع می‌شوند، پس فیلتر قبلی واردشان می‌کرد و در پنل ترکیب با هر آی‌پی تمیز
 * ضرب می‌شدند — یعنی فهرستی که نیمی از آن از پیش مرده است و کاربر «کانفیگ‌ها دریافت
 * می‌شوند ولی وصل نمی‌شوند» می‌بیند.
 *
 * فقط ورودی‌های غیرقابل‌اتصال دور ریخته می‌شوند؛ لینک واقعیِ روی پورت ۸۰ (که مصرف را در
 * نامش نشان می‌دهد) یک نود سالم است و دست‌نخورده می‌ماند.
 */
window.parseZeusSubLines = function(decoded) {
    return String(decoded || '').split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('vless://') || l.startsWith('vmess://') || l.startsWith('trojan://'))
        .filter(l => {
            if (l.startsWith('vmess://')) return true;
            try {
                const u = new URL(l);
                const port = parseInt(u.port, 10);
                if (!u.hostname || u.hostname === '0.0.0.0' || u.hostname === '127.0.0.1' || u.hostname === '::') return false;
                if (!Number.isInteger(port) || port < 2) return false;
                return true;
            } catch (e) {
                return false;
            }
        });
};

window.zeusConfirmTransferCombiner = async function() {
    const input = document.getElementById('zeus-combiner-group-input');
    const groupName = input.value.trim();
    if(!groupName) return toast('نام گروه نمی‌تواند خالی باشد');
    
    const username = _pendingCombinerUsername;
    document.getElementById('zeus-combiner-modal').classList.add('hidden');
    
    if(!window._zeusActiveAcc) return;
    toast("در حال دریافت کانفیگ‌ها...");
    try {
        const decoded = await window.fetchZeusSub(window._zeusActiveAcc, username);
        
        const lines = window.parseZeusSubLines(decoded);
        
        if(lines.length === 0) throw new Error("کانفیگی پیدا نشد");
        
        if (typeof window.saveBaseConfigGroup === 'function') {
            window.saveBaseConfigGroup(groupName, lines, {
                zeusUsername: username,
                zeusUrl: window._zeusActiveAcc.url,
                zeusAccId: window._zeusActiveAcc.id
            });
            if(typeof window.openCombinationCenter === 'function') {
                window.openCombinationCenter();
            }
            toast("کانفیگ‌ها با موفقیت منتقل شدند");
        } else {
            toast("پنل ترکیب در دسترس نیست");
        }
    } catch(e) {
        toast("خطا در انتقال: " + e.message);
    }
};

window.zeusCancelCombiner = function() {
    document.getElementById('zeus-combiner-modal').classList.add('hidden');
};

if (!document.getElementById('zeus-combiner-modal')) {
    const div = document.createElement('div');
    div.innerHTML = `
<!-- Zeus Combiner Prompt Modal -->
<div id="zeus-combiner-modal" class="hidden fixed inset-0 z-[100] flex items-center justify-center bg-mv-scrim backdrop-blur-sm transition-opacity duration-300">
    <div class="bg-m3-surface w-[90%] max-w-sm rounded-3xl shadow-2xl border border-m3-outline p-6 flex flex-col gap-4" dir="rtl">
        <h3 class="text-lg font-bold text-m3-onSurface">انتقال به پنل ترکیب</h3>
        <p class="text-sm text-m3-onSurfaceVariant">لطفاً نام گروه (Base Config) را برای کانفیگ‌های این کاربر وارد کنید:</p>
        <input type="text" id="zeus-combiner-group-input" class="w-full bg-m3-surface border border-m3-outline rounded-xl px-4 py-3 text-sm text-mv-label placeholder-mv-label-2 focus:outline-none focus:border-m3-primary transition-colors" style="background-color: var(--mv-surface);" placeholder="نام گروه...">
        <div class="flex gap-3 mt-2">
            <button onclick="zeusCancelCombiner()" class="flex-1 py-3 px-4 bg-m3-surface2 hover:bg-m3-surface3 text-m3-onSurfaceVariant rounded-xl text-sm font-bold transition-colors">انصراف</button>
            <button onclick="zeusConfirmTransferCombiner()" class="flex-1 py-3 px-4 bg-m3-primary hover:bg-m3-primary/90 text-m3-onPrimary rounded-xl text-sm font-bold shadow-md transition-all">انتقال</button>
        </div>
    </div>
</div>
`;
    document.body.appendChild(div.firstElementChild);
}



window.zeusTransferToV2ray = async function(username) {
    if(!window._zeusActiveAcc) return;
    toast("در حال دریافت کانفیگ‌ها...");
    try {
        const decoded = await window.fetchZeusSub(window._zeusActiveAcc, username);
        
        const lines = window.parseZeusSubLines(decoded);
        
        if(lines.length === 0) throw new Error("کانفیگی پیدا نشد");
        
        window.v2rayList = window.v2rayList || [];
        lines.forEach(uri => {
            let name = uri;
            if(uri.includes('#')) {
                try { name = decodeURIComponent(uri.split('#')[1] || ''); } catch(e) { name = uri.split('#')[1] || ''; }
            } else {
                name = "Zeus_Node";
            }
            
            // Ensure the name has 'zeus' so the panel categorizes it correctly
            if (!name.toLowerCase().includes('zeus')) {
                name += ' (Zeus)';
            }
            
            // Add sub-group tag with username
            name += ' [' + username + ']';
            
            uri = uri.split('#')[0] + '#' + encodeURIComponent(name);
            
            window.v2rayList.unshift({
                id: Date.now() + Math.random().toString(),
                uri: uri,
                name: name,
            });
        });
        
        if(typeof window.saveV2rayList === 'function') window.saveV2rayList();
        if(typeof window.renderV2rayList === 'function') window.renderV2rayList();
        
        toast(`${lines.length} کانفیگ با موفقیت به پنل V2ray منتقل شد`);
        
        if(typeof window.toggleLeftSidebar === 'function') {
            window.toggleLeftSidebar('v2ray');
        }
    } catch(e) {
        toast("خطا در انتقال: " + e.message);
    }
};


window.toggleUsagePanel = async function(accId) {
    const panel = document.getElementById(`usage-panel-${accId}`);
    if (!panel) return;
    
    if (panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
        panel.classList.add('flex');
        
        try {
            let saved = PersistentStorage.getItem('cf_accounts');
            let accounts = saved ? JSON.parse(saved) : [];
            const acc = accounts.find(a => a.id === accId);
            if (!acc) return;
            
            const textEl = document.getElementById(`usage-text-${accId}`);
            const barEl = document.getElementById(`usage-bar-${accId}`);
            textEl.innerText = 'در حال دریافت...';
            barEl.style.width = '0%';
            barEl.className = "h-full bg-mv-accent transition-all duration-500";
            
            const res = await fetch('/api/cloudflare/usage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: acc.email, token: acc.token })
            });
            const data = await res.json();
            
            if (data.success) {
                const used = data.requests || 0;
                const max = 100000;
                const percent = Math.min((used / max) * 100, 100);
                
                textEl.innerText = used.toLocaleString('en-US');
                barEl.style.width = percent + '%';
                
                if (percent > 80) barEl.className = "h-full bg-mv-orange transition-all duration-500";
                if (percent > 95) barEl.className = "h-full bg-mv-red transition-all duration-500";
            } else {
                textEl.innerText = 'خطا در دریافت';
            }
        } catch(e) {
            document.getElementById(`usage-text-${accId}`).innerText = 'خطا';
        }
    } else {
        panel.classList.add('hidden');
        panel.classList.remove('flex');
    }
};


window.deployEdgeWorker = async function(btn, accountId) {
    const accounts = loadCloudAccounts();
    const acc = accounts.find(a => a.id === accountId);
    if (!acc) return;
    
    const oldHtml = btn.innerHTML;
    btn.innerHTML = `<i class="ph-bold ph-spinner animate-spin"></i>`;
    btn.disabled = true;

    const term = document.getElementById("terminal-content");
    if (term) {
        term.innerHTML = `<div id="term-cursor" class="text-right mt-1" dir="rtl"><span class="inline-block w-2 h-3.5 bg-gs-panel animate-blink align-middle"></span></div>`;
    }
    const logTerm = (msg) => {
        const term = document.getElementById("terminal-content");
        if (term) {
            const cursor = document.getElementById("term-cursor");
            const div = document.createElement("div");
            div.className = "text-gs-muted mb-1 border-b border-gs-border/30 pb-1";
            div.innerHTML = `<span class="text-gs-muted font-bold tracking-wider mr-2">[${new Date().toLocaleTimeString('en-US', {hour12:false})}]</span> ${msg}`;
            if (cursor) {
                term.insertBefore(div, cursor);
            } else {
                term.appendChild(div);
            }
        }
        if (term) term.scrollTop = term.scrollHeight;
    };
    
    try {
        const workerName = 'w' + Math.random().toString(36).substring(2, 10);
        logTerm('در حال بررسی ساب‌دامین...');
        const subdomainRes = await fetch('/api/cloudflare/check-subdomain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: acc.email, token: acc.token })
        });
        const subData = await subdomainRes.json();
        let subdomain = '';
        if (subData.success && subData.currentSubdomain) {
            subdomain = subData.currentSubdomain;
        } else {
            // Need to set subdomain
            const setSubRes = await fetch('/api/cloudflare/set-subdomain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: acc.email, token: acc.token })
            });
            const setSubData = await setSubRes.json();
            if (setSubData.success) subdomain = setSubData.subdomain;
            else throw new Error("Could not set subdomain");
        }

        logTerm('در حال ایجاد ورکر جدید و آپلود کدها...');
        const res = await fetch('/api/cloudflare/deploy-edge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: acc.email,
                token: acc.token,
                workerName: workerName,
                subdomain: subdomain,
                proxyIp: acc.edgeProxyIp || ''
            })
        });
        const data = await res.json();
        if (data.success) {
            logTerm('<div class="text-mv-green-ink mt-2">استقرار با موفقیت انجام شد! پروکسی روی ' + data.url + ' در دسترس است.</div>');
            acc.edgeUrl = data.url;
            acc.edgeUuid = data.uuid;
            PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
            if (typeof renderCloudAccounts === 'function') renderCloudAccounts();
            toast("پروکسی Edge با موفقیت مستقر شد!");
        } else {
            logTerm('<div class="text-mv-red-ink mt-2">خطا در استقرار: ' + data.error + '</div>');
            toast("خطا در استقرار Edge: " + data.error);
        }
    } catch(e) {
        toast("خطا: " + e.message);
    } finally {
        btn.innerHTML = oldHtml;
        btn.disabled = false;
    }
};

window.showEdgeSettingsModal = function(acc) {
    window._activeEdgeAccount = acc;
    const modal = document.getElementById('edgeSettingsModal');
    document.getElementById('edge-proxy-ip').value = acc.edgeProxyIp || '';
    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

window.saveEdgeSettings = function() {
    if (!window._activeEdgeAccount) return;
    const proxyIp = document.getElementById('edge-proxy-ip').value.trim();
    const accounts = loadCloudAccounts();
    const acc = accounts.find(a => a.id === window._activeEdgeAccount.id);
    if (acc) {
        acc.edgeProxyIp = proxyIp;
        PersistentStorage.setItem('cf_accounts', JSON.stringify(accounts));
        toast("تنظیمات ذخیره شد");
    }
    hideModal('edgeSettingsModal');
};

window.fetchEdgeNodes = function(btn, accountId) {
    const accounts = loadCloudAccounts();
    const acc = accounts.find(a => a.id === accountId);
    if (!acc || !acc.edgeUrl || !acc.edgeUuid) {
        toast("اطلاعات تونل Edge یافت نشد");
        return;
    }
    
    // Construct VLESS websocket URL directly without hitting /sub
    const host = acc.edgeUrl.replace('https://', '').replace('/', '');
    const uuid = acc.edgeUuid;
    
    let pathStr = "/?ed=2560";
    if (acc.edgeProxyIp) {
        pathStr += "&proxyip=" + encodeURIComponent(acc.edgeProxyIp);
    }
    const encodedPath = encodeURIComponent(pathStr);
    // بدون allowInsecure: هسته‌ی 26.7.28 این گزینه را حذف کرده و وجودش کل کانفیگ را
    // از کار می‌اندازد (نه دیلی، نه اتصال). اینجا هم اصلاً لازم نبود — sni روی همان
    // دامنه‌ی ورکر ست است و گواهی کلودفلر برایش معتبر است.
    const vlessLink = `vless://${uuid}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&sni=${host}&fp=random&alpn=http%2F1.1&path=${encodedPath}#Edge-${host}`;
    
    window._latestGeneratedCloudConfigs = [vlessLink];
    window.currentCloudFetchUrl = acc.edgeUrl;
    if (typeof window.saveBaseConfigGroup === 'function') {
        window.saveBaseConfigGroup(acc.edgeUrl, [vlessLink], { edgeUuid: uuid, edgeAccId: acc.id, edgeUrl: acc.edgeUrl });
    }
    if (typeof window.renderCloudReceivedConfigs === 'function') {
        window.renderCloudReceivedConfigs();
    }
    toast("کانفیگ تونل Edge دریافت شد");
};



// Edge users logic removed
