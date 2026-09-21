// Animated brand wordmark in the header.
//
//   idle   → "Multi Layer Multiplexer", a light sweep crosses the glyphs once
//            a minute (left → right)
//   hover  → "MLMVPN"
//   leave  → "بدون مرز متصل بمانید" holds briefly, then settles back to idle
//
// IMPLEMENTATION NOTES (learned the hard way):
//
// * Text is NEVER split into per-character elements. Persian is a cursive
//   script — one span per character breaks the joining and renders the word as
//   disconnected letterforms. And inside this RTL app, laying characters out as
//   flex items reverses them outright ("Multi" → "itluM").
//   So each state is one intact text node with its own dir, and the *layer* is
//   what animates, not the glyphs.
//
// * The transition is driven by the Web Animations API, not CSS transitions.
//   Global stylesheet rules in this app override `transition` on plain spans,
//   which silently flattened the morph into an instant swap.
//
// * The cross-fade is a wipe: the outgoing layer is erased by a soft-edged mask
//   travelling across it while it blurs and lifts; the incoming layer is
//   revealed by the same mask running behind it. The host's width eases between
//   the two measured widths at the same time, so the whole mark reflows as one
//   object instead of snapping to a new size.

(function () {
  const STATES = {
    idle: { text: 'Multi Layer Multiplexer', dir: 'ltr' },
    hover: { text: 'MLMVPN', dir: 'ltr' },
    farewell: { text: 'بدون مرز متصل بمانید', dir: 'rtl' },
  };

  const SWEEP_EVERY = 20000;
  const SWEEP_DUR = 6000; // half speed again — a slow glide across the mark
  const FAREWELL_HOLD = 2400;
  const DUR = 700; // one full morph
  const HOVER_INTENT = 110; // settle before reacting to the pointer
  const EASE = 'cubic-bezier(.22, 1, .36, 1)';

  // Deliberately NOT gated on prefers-reduced-motion. Windows reports that
  // setting whenever "show animations" is off, and honouring it here killed the
  // morph and the sweep outright — the effect this element exists for.

  const style = document.createElement('style');
  style.id = 'brand-title-styles';
  style.textContent = `
    #brand-title {
      position: relative;
      display: inline-block;
      height: 18px;
      /* Optical nudge: the wordmark still read high against the icons beside it. */
      top: 1px;
      vertical-align: middle;
      white-space: nowrap;
      cursor: default;
      -webkit-app-region: no-drag;
      user-select: none;
    }
    /* Centred by stretching the layer top-to-bottom and using flex, not by a
       line-height guess: the Latin and Persian faces have different metrics, so
       a fixed line box left the mark riding high with a wider gap beneath it. */
    #brand-title .bt-layer {
      position: absolute;
      top: 0;
      bottom: 0;
      right: 0;
      display: flex;
      align-items: center;
      line-height: 1;
      white-space: nowrap;
      font-weight: 700;
      font-size: 12.5px;
      letter-spacing: .06em;
      /* Keep each state's own direction from being flipped by the RTL app. */
      unicode-bidi: isolate;
      will-change: opacity, transform, filter;
      pointer-events: none;
    }
    /* The gradient lives on this inner span, never on .bt-layer: a bare text
       node inside a flex container becomes an anonymous item, and clipping a
       background to *that* is unreliable — it silently stopped the sweep from
       showing. An ordinary inline element clips predictably. */
    #brand-title .bt-ink {
      /* Base stops must not be currentColor: background-clip:text needs the
         text itself transparent, so currentColor would resolve to transparent
         and the wordmark would disappear. */
      --bt-base: var(--ide-text-muted, #A0A6AD);
      background-image: linear-gradient(100deg,
        var(--bt-base) 0%, var(--bt-base) 40%,
        #F5F7FA 47%, #FFFFFF 50%, #F5F7FA 53%,
        var(--bt-base) 60%, var(--bt-base) 100%);
      background-size: 400% 100%;
      background-position: 130% 0;
      -webkit-background-clip: text;
      background-clip: text;
      color: transparent;
      -webkit-text-fill-color: transparent;
    }
    #brand-title .bt-ink.bt-sweeping {
      animation: bt-sweep ${SWEEP_DUR}ms cubic-bezier(.35, 0, .25, 1);
    }
    @keyframes bt-sweep {
      from { background-position: 130% 0; }
      to   { background-position: -30% 0; }
    }
    /* Measuring twin: same metrics, never painted. */
    /* Must mirror .bt-layer's metrics exactly, or the locked width is wrong. */
    #brand-title .bt-ruler {
      position: absolute;
      visibility: hidden;
      white-space: nowrap;
      font-weight: 700;
      font-size: 12.5px;
      letter-spacing: .06em;
    }
  `;
  document.head.appendChild(style);

  function init() {
    const host = document.getElementById('brand-title');
    if (!host) return;

    const ruler = document.createElement('span');
    ruler.className = 'bt-ruler';
    host.appendChild(ruler);

    const measure = (text, dir) => {
      ruler.setAttribute('dir', dir);
      ruler.textContent = text;
      return Math.ceil(ruler.getBoundingClientRect().width) + 2;
    };

    const makeLayer = (state) => {
      const el = document.createElement('span');
      el.className = 'bt-layer';
      el.setAttribute('dir', state.dir);
      const ink = document.createElement('span');
      ink.className = 'bt-ink';
      ink.textContent = state.text;
      el.appendChild(ink);
      return el;
    };
    const inkOf = (el) => el.querySelector('.bt-ink');

    let currentName = 'idle';
    let layer = makeLayer(STATES.idle);
    host.appendChild(layer);

    // The box is locked to the widest state and never resizes. Letting it track
    // each state's width made the whole header breathe on hover: the auto
    // margins redistributed the reclaimed space and everything from the
    // auto-save toggle to the traffic counters slid across.
    const lockedWidth = Math.max(
      ...Object.values(STATES).map((s) => measure(s.text, s.dir))
    );
    host.style.width = lockedWidth + 'px';

    let token = 0;
    let farewellTimer = null;

    function morph(name) {
      if (name === currentName) return;
      const mine = ++token;
      const state = STATES[name];
      currentName = name;

      // Sweeping the cursor across fires enter/leave faster than a morph
      // finishes. Every superseded layer has to go now — the stale onfinish
      // bails out on the token check and would never clean up after itself,
      // which is how all three texts ended up stacked on top of each other.
      [...host.querySelectorAll('.bt-layer')].forEach((el) => {
        if (el !== layer) {
          el.getAnimations().forEach((a) => a.cancel());
          el.remove();
        }
      });

      const from = layer;
      const to = makeLayer(state);
      host.appendChild(to);

      const d = DUR;

      // Outgoing: lift, blur and wipe away from the leading edge.
      from.animate(
        [
          { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0px)' },
          {
            opacity: 0,
            transform: 'translateY(-5px) scale(.98)',
            filter: 'blur(4px)',
          },
        ],
        { duration: d * 0.6, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }
      );

      // Incoming: rises into focus, overlapping the tail of the exit.
      const enter = to.animate(
        [
          {
            opacity: 0,
            transform: 'translateY(6px) scale(.98)',
            filter: 'blur(5px)',
          },
          { opacity: 1, transform: 'translateY(0) scale(1)', filter: 'blur(0px)' },
        ],
        { duration: d, delay: d * 0.28, easing: EASE, fill: 'both' }
      );

      // `layer` must point at the incoming text immediately: a morph that
      // starts before this one finishes has to know what to fade out from.
      layer = to;

      enter.onfinish = () => {
        if (mine !== token) return;
        from.getAnimations().forEach((a) => a.cancel());
        from.remove();
      };
    }

    function sweep() {
      if (currentName !== 'idle') return;
      const ink = inkOf(layer);
      if (!ink) return;
      ink.classList.remove('bt-sweeping');
      void ink.offsetWidth; // restart the animation
      ink.classList.add('bt-sweeping');
    }
    host.addEventListener('animationend', (e) => e.target.classList.remove('bt-sweeping'));

    let intentTimer = null;

    host.addEventListener('mouseenter', () => {
      clearTimeout(farewellTimer);
      clearTimeout(intentTimer);
      // Brief intent delay so brushing past the mark doesn't snap it over.
      intentTimer = setTimeout(() => {
        const ink = inkOf(layer);
        if (ink) ink.classList.remove('bt-sweeping');
        morph('hover');
      }, HOVER_INTENT);
    });

    host.addEventListener('mouseleave', () => {
      clearTimeout(farewellTimer);
      clearTimeout(intentTimer);
      intentTimer = setTimeout(() => {
        morph('farewell');
        farewellTimer = setTimeout(() => {
          if (!host.matches(':hover')) morph('idle');
        }, FAREWELL_HOLD);
      }, HOVER_INTENT);
    });

    setTimeout(sweep, 2500);
    setInterval(sweep, SWEEP_EVERY);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
