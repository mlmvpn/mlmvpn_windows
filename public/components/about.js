// --- About Modal Module ---
// Laid out as the macOS «About» panel: icon, name, version, then the team's words, the two
// channel buttons and the donation address. Same content and links as before.
const aboutHtmlTemplate = `
<style>
  #about-modal .ab-card {
    position: relative;
    width: 440px; max-width: calc(100vw - 32px); max-height: 90vh; overflow-y: auto;
    padding: 28px 28px 22px;
    border-radius: 14px;
    background: var(--mv-window);
    box-shadow: var(--mv-e5);
    color: var(--mv-label);
    direction: rtl;
    text-align: center;
    font-family: var(--mv-font);
  }
  #about-modal .ab-close {
    position: absolute; top: 14px; right: 14px;
    width: 12px; height: 12px; padding: 0; border: 0; border-radius: 50%;
    background: var(--mv-tl-close); cursor: pointer;
    box-shadow: inset 0 0 0 .5px rgba(0, 0, 0, .18);
  }
  #about-modal .ab-close:focus-visible { outline: 2px solid var(--mv-accent-ring); outline-offset: 2px; }
  #about-modal .ab-icon { width: 72px; height: 72px; display: block; margin: 0 auto 10px; border-radius: 22.5%; }
  #about-modal .ab-name { margin: 0; font-size: 18px; font-weight: 800; font-family: var(--mv-font-tech); }
  #about-modal .ab-ver { margin-top: 2px; font-size: 11.5px; color: var(--mv-label-2); }
  #about-modal .ab-ver span { font-family: var(--mv-font-tech); }
  #about-modal .ab-text { margin: 16px 0 0; font-size: 12.5px; line-height: 1.95; color: var(--mv-label); }
  #about-modal .ab-cta { margin: 14px 0 0; font-size: 12px; font-weight: 700; line-height: 1.8; color: var(--mv-orange-ink); }
  #about-modal .ab-btns { display: flex; gap: 8px; justify-content: center; margin: 12px 0 0; }
  #about-modal .ab-btns button {
    flex: 1; max-width: 170px; height: 30px; border: 0; border-radius: var(--mv-r-sm);
    font: inherit; font-size: 12.5px; font-weight: 600; color: #fff; cursor: pointer;
    transition: filter var(--mv-d-1) var(--mv-ease-out);
  }
  #about-modal .ab-btns button:hover { filter: brightness(1.08); }
  #about-modal .ab-btns button:active { filter: brightness(.9); }
  #about-modal .ab-hint { margin: 8px 0 0; font-size: 11px; color: var(--mv-label-3); }
  #about-modal .ab-donate {
    display: flex; gap: 14px; align-items: center; margin-top: 18px; padding-top: 16px;
    border-top: var(--mv-hl) solid var(--mv-sep-2); text-align: right;
  }
  #about-modal .ab-donate img {
    width: 92px; height: 92px; flex: none; border-radius: var(--mv-r-md);
    background: #fff; padding: 4px; box-shadow: var(--mv-hair);
  }
  #about-modal .ab-donate p { margin: 0; font-size: 11.5px; line-height: 1.85; color: var(--mv-label-2); }
  #about-modal .ab-addr {
    margin-top: 8px; padding: 6px 8px; border-radius: var(--mv-r-sm); background: var(--mv-fill);
    direction: ltr; text-align: left; font-family: var(--mv-font-mono); font-size: 10.5px;
    line-height: 1.6; word-break: break-all; user-select: all; color: var(--mv-label);
  }
  #about-modal .ab-addr b { font-weight: 600; color: var(--mv-label-2); }
</style>
<div
      id="about-modal"
      style="
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: var(--mv-scrim);
        z-index: 9999;
        align-items: center;
        justify-content: center;
      "
      onclick="if (event.target === this) hideModal('about-modal')"
    >
      <div class="ab-card" role="dialog" aria-labelledby="about-title">
        <button class="ab-close" onclick="hideModal('about-modal')" aria-label="بستن" title="بستن"></button>
        <img class="ab-icon" src="icon.png" alt="" />
        <h3 class="ab-name" id="about-title">MLMVPN</h3>
        <div class="ab-ver" id="about-version"></div>

        <p class="ab-text">
          این برنامه کاملاً <b>۱۰۰٪ رایگان</b> و با عشق برای مردم ایران ساخته
          شده است. ❤️<br />به یاد جاویدنامان 🖤 برای گذر از شرایط سخت<br />
          توسعه‌دهنده: <b>تیم MLMVPN</b>
        </p>

        <p class="ab-cta">
          حتما عضو کانال یوتوب و تلگرام ما شوید جهت دریافت آخرین نسخه‌ها و آموزش‌ها!
        </p>
        <div class="ab-btns">
          <button onclick="window.open('https://t.me/mlmvpn', '_blank')" style="background: var(--mv-accent);">عضویت در تلگرام</button>
          <button onclick="window.open('https://www.youtube.com/@marketmlm', '_blank')" style="background: var(--mv-red);">کانال یوتیوب</button>
        </div>
        <p class="ab-hint">پیشنهادات خود را از طریق نظرات یوتیوب برای ما ارسال کنید.</p>

        <div class="ab-donate">
          <img src="qrcodewallet.png" alt="Donate QR Code" />
          <div>
            <p>این ابزار برای همیشه رایگان است، اما توسعه آن نیازمند صرف وقت و انرژی فراوان است. اگر این نرم‌افزار گره‌ای از کارتان باز کرده، <b>حمایت مالی شما</b> بزرگ‌ترین پشتوانه ماست.</p>
            <div class="ab-addr"><b>USDT (BEP20):</b><br />0x82caa55d51a060c28802271f55bb2b077bbac118</div>
          </div>
        </div>
      </div>
    </div>
`;
function initAboutModule() {
    const container = document.getElementById('about-module-container');
    if (container) {
        container.innerHTML = aboutHtmlTemplate;
        // The version is the newest changelog entry — the same list the «تغییرات» window shows.
        const ver = document.getElementById('about-version');
        const top = typeof CHANGELOG !== 'undefined' && CHANGELOG[0];
        if (ver && top && top.version) ver.innerHTML = 'نسخه <span>' + top.version + '</span>';
        console.log('About module HTML injected.');
    }
}
