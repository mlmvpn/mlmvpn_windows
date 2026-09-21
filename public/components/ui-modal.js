// --- Shared modal dialogs ---
// Replaces the browser's native confirm()/alert(), which render as a bare Windows box
// with a Latin title, the wrong font, no RTL, and none of the app's colours — jarring in
// the middle of an otherwise Persian, dark, custom UI.
//
// Promise-based so call sites read the same as the native ones they replace:
//     if (!await uiConfirm({ title, message })) return;
//
// Deliberately dependency-free and self-styling: this file is loaded before the panels
// and must not assume Tailwind classes, since panels are rendered from template strings
// at different times.

(function () {
    const STYLE_ID = 'ui-modal-style';

    // One host element reused for every dialog. Creating and destroying a subtree per
    // call would drop the CSS transition on the way in.
    let host = null;
    let closeCurrent = null;

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const el = document.createElement('style');
        el.id = STYLE_ID;
        el.textContent = `
      /* Animated with CSS keyframes rather than a JS class toggle on the next frame.
         A requestAnimationFrame callback is not guaranteed to run in every embedder —
         in this app's own preview it does not — and when it is skipped the dialog stays
         at opacity 0: present, focusable, blocking input, and invisible. Keyframes make
         the visible state the DEFAULT, so the worst case is a missing fade, not a
         missing dialog. */
      @keyframes uim-fade-in { from { opacity: 0 } to { opacity: 1 } }
      @keyframes uim-rise    { from { transform: translateY(8px) scale(.985) } to { transform: none } }

      .uim-backdrop {
        position: fixed; inset: 0; z-index: 100000;
        display: flex; align-items: center; justify-content: center;
        background: var(--mv-scrim); backdrop-filter: blur(3px);
        opacity: 1;
        /* NO animation-fill-mode here. With fill-mode "both" the element is pinned to the
           animation's FROM frame whenever animations do not advance (throttled tab,
           reduced-motion engine, the preview pane this app is developed against) — i.e.
           permanently invisible while still capturing focus and clicks. Without it, a
           stalled animation simply leaves the base style: fully visible. The fade is
           decoration; being on screen is not.
           (No backticks in this comment: the stylesheet lives in a template literal.) */
        animation: uim-fade-in .16s ease;
        direction: rtl; font-family: Vazirmatn, IRANSansX, sans-serif;
      }
      /* Closing is a class the caller adds right before removal, so it can still fade out. */
      .uim-backdrop.uim-closing { opacity: 0; transition: opacity .16s ease; }

      .uim-box {
        width: min(420px, calc(100vw - 40px));
        border-radius: 16px; overflow: hidden;
        background: var(--ide-panel, #141414);
        border: 1px solid var(--ide-border, #2a2a2a);
        box-shadow: 0 18px 50px rgba(0,0,0,.55);
        animation: uim-rise .18s cubic-bezier(.2,.8,.3,1);
      }

      @media (prefers-reduced-motion: reduce) {
        .uim-backdrop, .uim-box { animation: none; }
      }

      .uim-head { display: flex; align-items: flex-start; gap: 11px; padding: 18px 18px 0; }
      .uim-icon {
        flex: none; width: 34px; height: 34px; border-radius: 10px;
        display: flex; align-items: center; justify-content: center; font-size: 17px;
      }
      .uim-icon.danger  { background: color-mix(in srgb, var(--mv-red) 13%, transparent); color: var(--mv-red-ink); }
      .uim-icon.warn    { background: color-mix(in srgb, var(--mv-orange) 13%, transparent);  color: var(--mv-orange-ink); }
      .uim-icon.info    { background: color-mix(in srgb, var(--mv-blue) 13%, transparent);  color: var(--mv-blue-ink); }
      .uim-icon.success { background: color-mix(in srgb, var(--mv-green) 13%, transparent);  color: var(--mv-green-ink); }

      .uim-title { font-size: 14px; font-weight: 800; color: var(--ide-text-main, #EDEDED);
                   line-height: 1.7; padding-top: 4px; }
      .uim-body { padding: 10px 18px 0; font-size: 12.5px; line-height: 2;
                  color: var(--ide-text-muted, #9a97a3); white-space: pre-line; }
      .uim-body b, .uim-body strong { color: var(--ide-text-main, #EDEDED); font-weight: 700; }

      .uim-foot { display: flex; gap: 8px; padding: 18px; justify-content: flex-start; }
      /* A single line of text. Full width, because a name is longer than a box sized to
         "looks about right". */
      .uim-input { width: 100%; box-sizing: border-box; margin: 12px 18px 0; max-width: calc(100% - 36px);
        padding: 9px 11px; border-radius: 9px; font-size: 13px; font-family: inherit;
        background: var(--ide-bg-inset, rgba(255,255,255,.05));
        border: 1px solid var(--mv-sep, rgba(255,255,255,.14)); color: var(--ide-text-main, #EDEDED); }
      .uim-input:focus { outline: none; border-color: var(--mv-accent); }
      /* A list of options. Scrolls rather than growing: this is fed a machine's running
         processes, and there can be sixty of them. */
      .uim-list { margin: 12px 18px 0; max-height: 46vh; overflow-y: auto; display: flex;
        flex-direction: column; gap: 5px; }
      .uim-opt { display: block; width: 100%; text-align: start; cursor: pointer;
        padding: 9px 11px; border-radius: 9px; font-family: inherit; font-size: 12.5px;
        background: var(--ide-bg-inset, rgba(255,255,255,.05));
        border: 1px solid var(--mv-sep, rgba(255,255,255,.12)); color: var(--ide-text-main, #EDEDED); }
      .uim-opt:hover { border-color: var(--mv-accent); }
      .uim-opt .sub { display: block; margin-top: 2px; font-size: 11px; opacity: .62; }
      .uim-btn {
        flex: 1; padding: 10px 16px; border-radius: 10px; cursor: pointer;
        font-size: 12.5px; font-weight: 700; font-family: inherit;
        border: 1px solid transparent; transition: filter .12s ease, background .12s ease;
      }
      .uim-btn:focus-visible { outline: 2px solid var(--mv-blue); outline-offset: 2px; }
      .uim-btn-ghost   { background: transparent; color: var(--ide-text-main, #EDEDED);
                         border-color: var(--mv-sep-2); }
      .uim-btn-ghost:hover { background: var(--mv-fill-2); }
      .uim-btn-primary { background: var(--mv-accent); color: #fff; }
      .uim-btn-danger  { background: var(--mv-red-fill); color: #fff; }
      .uim-btn-primary:hover, .uim-btn-danger:hover { filter: brightness(1.08); }
    `;
        document.head.appendChild(el);
    }

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[c]));
    }

    const ICONS = { danger: '!', warn: '!', info: 'i', success: '✓', question: '؟' };

    /**
     * Core dialog. Resolves with the `value` of the button the user chose.
     * @param opts.buttons [{ label, value, style: 'primary'|'danger'|'ghost' }]
     */
    function open(opts = {}) {
        injectStyle();
        // Never stack dialogs. The superseded one resolves with ITS OWN dismiss value
        // (false for a confirm), not a hard-coded null — a caller awaiting it must see
        // the same answer it would get from Escape, not a third state it never handles.
        if (closeCurrent) closeCurrent();

        const {
            title = '',
            message = '',
            tone = 'info',
            buttons = [{ label: 'باشه', value: true, style: 'primary' }],
            dismissValue = null,
        } = opts;

        return new Promise(resolve => {
            host = document.createElement('div');
            host.className = 'uim-backdrop';
            host.innerHTML = `
        <div class="uim-box" role="dialog" aria-modal="true">
          <div class="uim-head">
            <div class="uim-icon ${esc(tone)}">${ICONS[tone] || 'i'}</div>
            <div class="uim-title">${esc(title)}</div>
          </div>
          ${message ? `<div class="uim-body">${esc(message)}</div>` : ''}
          <div class="uim-foot">
            ${buttons.map((b, i) =>
                `<button class="uim-btn uim-btn-${esc(b.style || 'ghost')}" data-i="${i}">${esc(b.label)}</button>`
            ).join('')}
          </div>
        </div>`;

            document.body.appendChild(host);

            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                closeCurrent = null;
                document.removeEventListener('keydown', onKey, true);
                host.classList.add('uim-closing');
                const dying = host;
                host = null;
                setTimeout(() => dying.remove(), 170);
                resolve(value);
            };
            // Bound to this dialog's own dismiss value, so being superseded reads the
            // same as being cancelled.
            closeCurrent = () => finish(dismissValue);

            host.querySelectorAll('.uim-btn').forEach(btn => {
                btn.addEventListener('click', () => finish(buttons[+btn.dataset.i].value));
            });

            // Clicking the dimmed area dismisses, the same as pressing Escape.
            host.addEventListener('mousedown', e => { if (e.target === host) finish(dismissValue); });

            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); finish(dismissValue); }
                if (e.key === 'Enter') {
                    // Enter takes the affirmative action — the last button, which is where
                    // the primary/danger action sits in this layout.
                    e.preventDefault();
                    finish(buttons[buttons.length - 1].value);
                }
            }
            document.addEventListener('keydown', onKey, true);

            // Focus the safe choice, so a stray Enter or Space cannot delete something.
            const first = host.querySelector('.uim-btn');
            if (first) first.focus();
        });
    }

    /** Drop-in for confirm(). Resolves true/false. */
    function uiConfirm(opts = {}) {
        const {
            title = 'مطمئن هستید؟',
            message = '',
            confirmLabel = 'تأیید',
            cancelLabel = 'انصراف',
            danger = false,
        } = typeof opts === 'string' ? { message: opts } : opts;

        return open({
            title,
            message,
            tone: danger ? 'danger' : 'question',
            dismissValue: false,
            buttons: [
                { label: cancelLabel, value: false, style: 'ghost' },
                { label: confirmLabel, value: true, style: danger ? 'danger' : 'primary' },
            ],
        });
    }

    /** Drop-in for alert(). Resolves when dismissed. */
    function uiAlert(opts = {}) {
        const {
            title = 'پیام',
            message = '',
            tone = 'info',
            okLabel = 'باشه',
        } = typeof opts === 'string' ? { message: opts } : opts;

        return open({ title, message, tone, dismissValue: true,
            buttons: [{ label: okLabel, value: true, style: 'primary' }] });
    }

    // ── showModal / hideModal ─────────────────────────────────────────────────
    // These are called from markup all over the app (the guide, "about", the cloud
    // panel's help, several confirm dialogs) but were never actually defined anywhere.
    // The result: the X button on the comprehensive guide did nothing and the overlay
    // stayed stuck on screen with no way out. Defining them here — beside the other
    // dialog helpers — fixes every one of those call sites at once.
    //
    // Escape and a backdrop click close the panel too, because a modal whose only exit
    // is one small X is the same trap in a smaller form.
    function showModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.remove('hidden');
        el.style.display = 'flex';

        if (!el.dataset.uimBound) {
            el.dataset.uimBound = '1';
            el.addEventListener('mousedown', e => { if (e.target === el) hideModal(id); });
        }
        // One Escape handler per open modal, removed on close.
        el.__uimEsc = (e) => { if (e.key === 'Escape') hideModal(id); };
        document.addEventListener('keydown', el.__uimEsc, true);
    }

    function hideModal(id) {
        const el = document.getElementById(id);
        if (!el) return;
        el.classList.add('hidden');
        el.style.display = 'none';
        if (el.__uimEsc) {
            document.removeEventListener('keydown', el.__uimEsc, true);
            el.__uimEsc = null;
        }
    }

    /**
     * Ask for one line of text. Resolves with the trimmed string, or null if dismissed.
     *
     * Empty counts as dismissed: a caller that asked for a name and got '' has nothing to do with
     * it, and making every caller re-check is how one of them forgets.
     */
    function uiPrompt(title, initial = '', { placeholder = '', ok = 'تأیید', cancel = 'انصراف' } = {}) {
        injectStyle();
        if (closeCurrent) closeCurrent();

        return new Promise(resolve => {
            host = document.createElement('div');
            host.className = 'uim-backdrop';
            host.innerHTML = `
        <div class="uim-box" role="dialog" aria-modal="true">
          <div class="uim-head">
            <div class="uim-icon info">${ICONS.info || 'i'}</div>
            <div class="uim-title">${esc(title)}</div>
          </div>
          <input class="uim-input" type="text" value="${esc(initial)}" placeholder="${esc(placeholder)}" maxlength="60">
          <div class="uim-foot">
            <button class="uim-btn uim-btn-ghost" data-v="0">${esc(cancel)}</button>
            <button class="uim-btn uim-btn-primary" data-v="1">${esc(ok)}</button>
          </div>
        </div>`;
            document.body.appendChild(host);

            const input = host.querySelector('.uim-input');
            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                closeCurrent = null;
                document.removeEventListener('keydown', onKey, true);
                host.classList.add('uim-closing');
                const dying = host;
                host = null;
                setTimeout(() => dying.remove(), 170);
                resolve(value);
            };
            const take = () => {
                const v = String(input.value || '').trim();
                finish(v || null);
            };
            closeCurrent = () => finish(null);

            host.querySelectorAll('.uim-btn').forEach(b => {
                b.addEventListener('click', () => (b.dataset.v === '1' ? take() : finish(null)));
            });
            host.addEventListener('mousedown', e => { if (e.target === host) finish(null); });

            function onKey(e) {
                if (e.key === 'Escape') { e.preventDefault(); finish(null); }
                if (e.key === 'Enter') { e.preventDefault(); take(); }
            }
            document.addEventListener('keydown', onKey, true);
            setTimeout(() => { try { input.focus(); input.select(); } catch (err) { /* not focusable yet */ } }, 30);
        });
    }

    /**
     * Choose one of a list. Resolves with the chosen option's `id`, or null if dismissed.
     *
     * @param options  [{ id, fa, sub }] — `sub` is the quiet second line, optional.
     */
    function uiChoose(title, options = [], { cancel = 'انصراف' } = {}) {
        injectStyle();
        if (closeCurrent) closeCurrent();

        return new Promise(resolve => {
            host = document.createElement('div');
            host.className = 'uim-backdrop';
            host.innerHTML = `
        <div class="uim-box" role="dialog" aria-modal="true">
          <div class="uim-head">
            <div class="uim-icon info">${ICONS.info || 'i'}</div>
            <div class="uim-title">${esc(title)}</div>
          </div>
          <div class="uim-list">
            ${options.map((o, i) => `<button class="uim-opt" data-i="${i}">${esc(o.fa)}${o.sub ? `<span class="sub">${esc(o.sub)}</span>` : ''}</button>`).join('')}
          </div>
          <div class="uim-foot">
            <button class="uim-btn uim-btn-ghost" data-cancel="1">${esc(cancel)}</button>
          </div>
        </div>`;
            document.body.appendChild(host);

            let done = false;
            const finish = (value) => {
                if (done) return;
                done = true;
                closeCurrent = null;
                document.removeEventListener('keydown', onKey, true);
                host.classList.add('uim-closing');
                const dying = host;
                host = null;
                setTimeout(() => dying.remove(), 170);
                resolve(value);
            };
            closeCurrent = () => finish(null);

            host.querySelectorAll('.uim-opt').forEach(b => {
                b.addEventListener('click', () => finish(options[+b.dataset.i].id));
            });
            host.querySelector('[data-cancel]').addEventListener('click', () => finish(null));
            host.addEventListener('mousedown', e => { if (e.target === host) finish(null); });

            // NO Enter-takes-the-affirmative here, deliberately: there is no affirmative to take.
            // Picking the first option because somebody pressed Enter would be a choice they did
            // not make.
            function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); finish(null); } }
            document.addEventListener('keydown', onKey, true);
        });
    }

    window.uiPrompt = uiPrompt;
    window.uiChoose = uiChoose;
    window.showModal = showModal;
    window.hideModal = hideModal;
    window.uiConfirm = uiConfirm;
    window.uiAlert = uiAlert;
    window.uiModal = { open, confirm: uiConfirm, alert: uiAlert, prompt: uiPrompt, choose: uiChoose, show: showModal, hide: hideModal };
})();
