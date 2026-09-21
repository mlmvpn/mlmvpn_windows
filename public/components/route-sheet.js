// --- «تونل کامل یا پروکسی کل سیستم؟» — one sheet for every engine that needs the choice ---
//
// A connected WARP engine (ماسک / وایرگارد / وارپ در وارپ) routes nothing until the full tunnel
// or the system proxy is switched on, and a ready GitHub-tunnel session carries nothing until one
// of its two switches is. So the moment either is ready, this sheet asks which way in the user
// wants. It stays up while the choice comes up — a spinner, then either it closes on the state
// read back from the machine, or it shows the error with both choices again — and it can be
// closed at any time (✕, «بعداً», Esc) without touching the connection: the panel's own
// switches are still there.
//
//   MVRouteSheet.open({
//     owner, title, text,                     // owner: which panel opened it ('aether', 'gt')
//     notes: { tun, proxy },                   // optional per-choice lines
//     choose: async (kind) => ({ ok, error }), // kind: 'tun' | 'proxy'; ok only once it is UP
//     onClosed: () => {},                      // it went away — redraw whatever depended on it
//   })
//   MVRouteSheet.close(owner)                  // e.g. the engine went away
(function () {
    'use strict';

    let current = null;   // { owner, opts, busy }

    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const say = (m) => { if (typeof toast === 'function') toast(m); };

    const DEFAULT_NOTES = {
        tun: 'کل ترافیک ویندوز، همه‌ی برنامه‌ها، DNS و UDP — بدون نشت. پیشنهادی.',
        proxy: 'مرورگرها و برنامه‌هایی که پروکسی ویندوز را می‌خوانند. سبک‌تر، ولی بعضی برنامه‌ها و UDP رد نمی‌شوند.',
    };

    function el() {
        let e = document.getElementById('mv-route-sheet');
        if (e) return e;
        e = document.createElement('div');
        e.id = 'mv-route-sheet';
        e.setAttribute('role', 'dialog');
        e.setAttribute('aria-modal', 'true');
        e.setAttribute('aria-labelledby', 'mv-rs-title');
        e.hidden = true;
        document.body.appendChild(e);
        e.addEventListener('click', (ev) => {
            if (ev.target === e || ev.target.closest('[data-rs-close]')) { close(); return; }
            const b = ev.target.closest('[data-rs-choice]');
            if (b && current && !current.busy) run(b.dataset.rsChoice);
        });
        document.addEventListener('keydown', (ev) => {
            if (ev.key === 'Escape' && !e.hidden) { ev.preventDefault(); close(); }
        });
        return e;
    }

    function render(errorText) {
        if (!current) return;
        const o = current.opts;
        const notes = Object.assign({}, DEFAULT_NOTES, o.notes || {});
        const e = el();
        e.innerHTML = `
          <div class="mv-rs-card">
            <button type="button" class="mv-rs-x" data-rs-close aria-label="بستن" title="بستن (Esc)"><i class="ph-bold ph-x"></i></button>
            <span class="mv-rs-ic"><i class="ph-fill ph-check-circle"></i></span>
            <h3 id="mv-rs-title">${esc(o.title)}</h3>
            <p>${esc(o.text || 'تا یکی از این دو روشن نشود، هیچ ترافیکی از آن رد نمی‌شود. کدام را می‌خواهید؟')}</p>
            ${errorText ? `<div class="mv-rs-err"><i class="ph-fill ph-warning"></i><span>${esc(errorText)}</span></div>` : ''}
            <div class="mv-rs-choices">
              <button type="button" class="mv-rs-choice" data-rs-choice="tun">
                <i class="ph-fill ph-shield-check"></i><b>تونل کامل</b><small>${esc(notes.tun)}</small>
              </button>
              <button type="button" class="mv-rs-choice" data-rs-choice="proxy">
                <i class="ph-fill ph-globe-hemisphere-east"></i><b>پروکسی کل سیستم</b><small>${esc(notes.proxy)}</small>
              </button>
            </div>
            <div class="mv-rs-busy" hidden><i class="ph-bold ph-spinner-gap mv-spin"></i><span></span></div>
            <button type="button" class="mv-rs-later" data-rs-close>بعداً — خودم از پنل روشن می‌کنم</button>
          </div>`;
        e.hidden = false;
        const first = e.querySelector('[data-rs-choice="tun"]');
        if (first) setTimeout(() => first.focus(), 30);
    }

    function setBusy(text) {
        const e = el();
        if (current) current.busy = !!text;
        e.querySelectorAll('[data-rs-choice]').forEach((b) => { b.disabled = !!text; });
        const busy = e.querySelector('.mv-rs-busy');
        if (busy) {
            busy.hidden = !text;
            if (text) busy.querySelector('span').textContent = text;
        }
        const err = e.querySelector('.mv-rs-err');
        if (err && text) err.remove();
    }

    async function run(kind) {
        const mine = current;
        setBusy(kind === 'tun'
            ? 'در حال برقراری تونل کامل… (بررسی عبور واقعی داده، چند ثانیه)'
            : 'در حال روشن کردن پروکسی کل سیستم…');
        let r;
        try { r = await mine.opts.choose(kind); } catch (e) { r = { ok: false, error: e.message }; }
        const stillShown = current === mine && !el().hidden;
        if (r && r.ok) {
            if (stillShown) close();
            say(kind === 'tun' ? '✅ تونل کامل برقرار شد' : '✅ پراکسی کل سیستم روشن شد');
            return;
        }
        const msg = (kind === 'tun' ? 'تونل برقرار نشد: ' : 'پراکسی روشن نشد: ') + ((r && r.error) || 'وضعیت تأیید نشد');
        if (!stillShown) { say('❌ ' + msg); return; }
        mine.busy = false;
        render(msg + ' — دوباره امتحان کنید یا گزینه‌ی دیگر را بزنید.');
    }

    function open(opts) {
        current = { owner: opts.owner || '', opts, busy: false };
        render();
    }

    /** Close the sheet — only if `owner` opened it, when an owner is given. */
    function close(owner) {
        if (owner && (!current || current.owner !== owner)) return;
        const e = document.getElementById('mv-route-sheet');
        if (e) e.hidden = true;
        // A choice still in flight finishes on its own and reports through a banner.
        const gone = current;
        current = null;
        // Whoever opened it may be DRAWING something that depends on the sheet being up — the
        // engine pages show «مسیر ترافیک را انتخاب کنید» with a spinner while it is, and turn to
        // a warning once it is gone. Without this they only find out at the next status event,
        // which can be three quarters of a minute away.
        if (gone && typeof gone.opts.onClosed === 'function') {
            try { gone.opts.onClosed(); } catch (err) { /* a listener must not break the close */ }
        }
    }

    function isOpen(owner) {
        const e = document.getElementById('mv-route-sheet');
        return !!(e && !e.hidden && current && (!owner || current.owner === owner));
    }

    const style = document.createElement('style');
    style.textContent = `
      #mv-route-sheet { position: fixed; inset: 0; z-index: 10050; display: grid; place-items: center; background: var(--mv-scrim, rgba(0,0,0,.45)); }
      #mv-route-sheet[hidden] { display: none; }
      #mv-route-sheet .mv-rs-card { position: relative; width: min(520px, calc(100vw - 32px)); padding: 24px 22px 14px; border-radius: 16px; background: var(--mv-window, var(--mv-surface)); box-shadow: var(--mv-e5, 0 20px 60px rgba(0,0,0,.4)); color: var(--mv-label); text-align: center; direction: rtl; font-family: var(--mv-font, inherit); }
      #mv-route-sheet .mv-rs-x { position: absolute; top: 12px; left: 12px; width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 50%; background: var(--mv-fill); color: var(--mv-label-2); cursor: pointer; font-size: 13px; }
      #mv-route-sheet .mv-rs-x:hover { background: var(--mv-fill-2); color: var(--mv-label); }
      #mv-route-sheet .mv-rs-ic { font-size: 40px; color: var(--mv-green); }
      #mv-route-sheet h3 { margin: 6px 0 4px; font-size: 16px; font-weight: 800; }
      #mv-route-sheet p { margin: 0 0 16px; font-size: 12.5px; line-height: 1.9; color: var(--mv-label-2); }
      #mv-route-sheet .mv-rs-choices { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      #mv-route-sheet .mv-rs-choice { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 16px 12px; border: 0; border-radius: 12px; background: var(--mv-fill); color: var(--mv-label); font: inherit; cursor: pointer; box-shadow: inset 0 0 0 1px var(--mv-sep, transparent); transition: background var(--mv-d-1, .12s) ease; }
      #mv-route-sheet .mv-rs-choice:hover:not(:disabled) { background: color-mix(in srgb, var(--mv-accent) 14%, transparent); box-shadow: inset 0 0 0 1.5px var(--mv-accent); }
      #mv-route-sheet .mv-rs-choice:focus-visible, #mv-route-sheet .mv-rs-x:focus-visible, #mv-route-sheet .mv-rs-later:focus-visible { outline: 2px solid var(--mv-accent-ring, var(--mv-accent)); outline-offset: 2px; }
      #mv-route-sheet .mv-rs-choice:disabled { opacity: .5; cursor: progress; }
      #mv-route-sheet .mv-rs-choice i { font-size: 28px; color: var(--mv-accent); }
      #mv-route-sheet .mv-rs-choice b { font-size: 14px; }
      #mv-route-sheet .mv-rs-choice small { font-size: 11.5px; line-height: 1.75; color: var(--mv-label-2); }
      #mv-route-sheet .mv-rs-busy { display: flex; align-items: center; justify-content: center; gap: 8px; margin-top: 16px; font-size: 12.5px; color: var(--mv-label-2); }
      #mv-route-sheet .mv-rs-busy[hidden] { display: none; }
      #mv-route-sheet .mv-rs-busy i { font-size: 18px; color: var(--mv-accent); }
      #mv-route-sheet .mv-rs-err { display: flex; gap: 8px; align-items: flex-start; margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--mv-red) 12%, transparent); color: var(--mv-red-ink); font-size: 12px; line-height: 1.8; text-align: start; }
      #mv-route-sheet .mv-rs-later { margin-top: 12px; padding: 6px 10px; border: 0; border-radius: 8px; background: none; color: var(--mv-label-2); font: inherit; font-size: 12px; cursor: pointer; }
      #mv-route-sheet .mv-rs-later:hover { background: var(--mv-fill); color: var(--mv-label); }
      @media (max-width: 460px) { #mv-route-sheet .mv-rs-choices { grid-template-columns: 1fr; } }
    `;
    document.head.appendChild(style);

    window.MVRouteSheet = { open, close, isOpen };
})();
