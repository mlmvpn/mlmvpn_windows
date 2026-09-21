#!/usr/bin/env node
/*
 * Phase-4 colour migration. Rewrites hard-coded colours in the UI sources onto the design
 * tokens (public/ui/tokens.css) by the ROLE each colour plays — text, background, border —
 * so the result flips correctly between the dark and light appearances.
 *
 *   node .claude/tokenize.js <file…> [--write] [--changes] [--quiet]
 *
 * Without --write it only reports. --changes lists every rewrite (line, role, old → new).
 * Whatever it cannot decide on its own — white text with no coloured fill beside it,
 * white/black/pale fills, dark text, colours held in JS variables — is listed with its
 * line so it can be finished by hand.
 *
 * Three passes over each file:
 *   1. CSS declarations (style="…", <style> blocks, CSS inside JS templates)
 *   2. JS style assignments (el.style.color = '…')
 *   3. Tailwind colour utilities (palette, white/black, arbitrary [#hex])
 */
const fs = require('fs');

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const CHANGES = argv.includes('--changes');
const QUIET = argv.includes('--quiet');
const files = argv.filter((a) => !a.startsWith('--'));

const FAMS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'];

// ── colour maths ──────────────────────────────────────────────────────────────────────────
function parseColor(lit) {
  const s = lit.trim().toLowerCase();
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 5 || h.length === 7) return null;
    if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
    return {
      r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }
  m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)(%?)\s*)?\)$/);
  if (m) {
    let a = m[4] === undefined ? 1 : parseFloat(m[4]);
    if (m[5] === '%') a /= 100;
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}
function hsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: h * 60, s, l };
}
function family(c) {
  const { h, s, l } = hsl(c);
  // Chroma, not HSL saturation: near-black #0d1117 has s = .28 but no visible hue.
  const chroma = (Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)) / 255;
  if (chroma < 0.08 || s < 0.2 || l > 0.96 || l < 0.06) return null; // neutral
  if (h < 14 || h >= 345) return 'red';
  if (h < 38) return 'orange';
  if (h < 62) return (h >= 46 || l >= 0.72) ? 'yellow' : 'orange';
  if (h < 165) return 'green';
  if (h < 200) return 'teal';
  if (h < 240) return 'blue';
  if (h < 262) return 'indigo';
  if (h < 300) return 'purple';
  return 'pink';
}
const pct = (a) => Math.max(1, Math.round(a * 100));

// descriptor: { tok, pct?, mix? } | { keep: true } | { todo: reason }
function mapColor(c, role, ctx) {
  const fam = family(c);
  const { l } = hsl(c);
  const a = c.a;
  if (fam) {
    if (role === 'text') return { tok: fam + '-ink', pct: a < 0.98 ? pct(a) : null };
    if (role === 'shadow') return { tok: fam, pct: a < 0.98 ? pct(a) : null };
    if (role === 'border') {
      if (a < 0.98) return { tok: fam, pct: pct(a) };
      return l < 0.3 ? { tok: fam, pct: 35 } : { tok: fam };
    }
    // bg
    if (a < 0.98) return { tok: fam, pct: pct(a) };
    if (l < 0.3) return { tok: fam, pct: 24, mix: 'surface' };
    // Material's pale "tonal" blue (#a8c7fa, #aecbfa) was this app's primary button.
    if (l > 0.8) return fam === 'blue' ? { tok: 'accent', pale: true } : { todo: 'pale fill' };
    return { tok: fam === 'blue' ? 'accent' : fam };
  }
  // neutral
  const whiteish = l >= 0.9, blackish = l <= 0.15;
  if (role === 'shadow') return { keep: true };
  if (role === 'text') {
    if (a < 0.98) {
      if (whiteish) return { tok: a >= 0.8 ? 'label' : a >= 0.5 ? 'label-2' : a >= 0.3 ? 'label-3' : 'label-4' };
      return { todo: 'translucent dark text' };
    }
    if (l >= 0.97) return ctx.onFill ? { keep: true } : { tok: 'label' };
    if (l >= 0.8) return { tok: 'label' };
    if (l >= 0.6) return { tok: 'label-2' };
    if (l >= 0.44) return { tok: 'label-3' };
    if (l >= 0.3) return { tok: 'label-4' };
    // Dark ink on the old pale-blue button becomes white on the accent fill.
    return ctx.onFill ? { white: true } : { todo: 'dark text' };
  }
  if (role === 'border') {
    if (a < 0.98) {
      // A strong white line (≥ .3) is nearly always drawn on a coloured fill — a spinner
      // ring inside a button — and must stay white; decide those by hand.
      if (whiteish) return a >= 0.3 ? { todo: 'strong white line' } : { tok: a <= 0.1 ? 'sep' : a <= 0.16 ? 'sep-2' : 'sep-3' };
      return { tok: 'sep-2' };
    }
    if (l < 0.3) return { tok: 'sep-2' };
    if (l < 0.62) return { tok: 'sep-3' };
    if (l >= 0.97) return ctx.onFill ? { keep: true } : { todo: 'white border' };
    return { tok: 'sep-3' };
  }
  // bg
  if (a < 0.9) {
    if (whiteish) {
      if (a <= 0.05) return { tok: 'fill' };
      if (a <= 0.1) return { tok: 'fill-2' };
      if (a <= 0.2) return { tok: 'fill-3' };
      return { todo: 'strong white veil' };
    }
    if (blackish) return a >= 0.4 ? { tok: 'scrim' } : { tok: 'field', check: true };
    return { tok: 'fill-2' };
  }
  if (l < 0.14) return { tok: 'surface' };
  if (l < 0.185) return { tok: 'surface-2' };
  if (l < 0.225) return { tok: 'surface-3' };
  if (l < 0.3) return { tok: 'surface-4' };
  if (l < 0.55) return { tok: 'fill-3', check: true };
  // A white disc is a switch knob.
  if (l >= 0.97 && ctx.round) return { tok: 'knob' };
  return { todo: l >= 0.97 ? 'white fill' : 'light fill' };
}
function cssOf(d) {
  if (d.white) return '#fff';
  if (d.mix) return `color-mix(in srgb, var(--mv-${d.tok}) ${d.pct}%, var(--mv-${d.mix}))`;
  if (d.pct) return `color-mix(in srgb, var(--mv-${d.tok}) ${d.pct}%, transparent)`;
  return `var(--mv-${d.tok})`;
}
function twOf(d) {
  if (d.white) return 'white';
  if (d.mix) return `[color-mix(in_srgb,var(--mv-${d.tok})_${d.pct}%,var(--mv-${d.mix}))]`;
  return `mv-${d.tok}` + (d.pct ? '/' + d.pct : '');
}

// ── context: is this text sitting on a coloured fill? ────────────────────────────────────────
const FILL_RE = new RegExp(
  '(?:background(?:-color|-image)?\\s*:[^;"`}]*(?:gradient|var\\(--mv-(?:accent|' + FAMS.join('|') + ')\\)|#[0-9a-f]{3,8}|rgba?\\([^)]*\\)))' +
  '|(?:background(?:-color)?\\s*:[^;"`}]*var\\(--(?:syn-[a-z]+|gs-primary|m3-primary)\\b)' +
  '|(?:(?:^|[\\s"\'`])bg-(?:(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:[3-9]00|950)|gs-primary|m3-primary|m3-(?:error|success|warning)|gs-(?:success|danger|warning|info)|google-(?:blue|green|red)|syn-[a-z]+|gradient-[a-z-]+|mv-(?:accent|' + FAMS.join('|') + '))(?![\\w/-]))' +
  '|btn-primary|mv-btn--primary|mv-btn--danger-fill', 'i');
function hasChromaticFill(text) {
  if (!FILL_RE.test(text) && !/bg-\[/.test(text)) return false;
  // A background literal only counts if it is actually chromatic or solid dark-on-light.
  const bgs = text.match(/background(?:-color)?\s*:\s*([^;"`}]*)/gi) || [];
  const classHit = /(?:^|[\s"'`])bg-(?!mv-(?:label|fill|sep|surface|window|desk|field|code|scrim|control))(?:(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:[3-9]00|950)|gs-primary|m3-primary|m3-(?:error|success|warning)|gs-(?:success|danger|warning|info)|google-(?:blue|green|red)|syn-[a-z]+|gradient-[a-z-]+|mv-(?:accent|red|orange|yellow|green|teal|blue|indigo|purple|pink))(?![\w/-])|btn-primary|mv-btn--primary|mv-btn--danger-fill/i.test(text);
  if (classHit) return true;
  // A solid chromatic literal counts — but not a pale chip (#fde293), whose dark ink is right.
  const solid = (lit) => {
    const c = parseColor(lit);
    if (!c || c.a <= 0.5) return false;
    const f = family(c);
    return !!f && (hsl(c).l <= 0.8 || f === 'blue');
  };
  const arb = text.match(/(?:^|[\s"'`])(?:[a-z-]+:)*bg-\[([^\]]+)\]/gi) || [];
  for (const t of arb) if (!/(hover|active|focus):/.test(t) && solid(t.replace(/^.*\[|\]$/g, ''))) return true;
  for (const b of bgs) {
    if (/gradient|var\(--mv-(?:accent|red|orange|yellow|green|teal|blue|indigo|purple|pink)\)|var\(--(?:syn-[a-z]+|gs-primary|m3-primary)\b/i.test(b)) return true;
    const lits = b.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) || [];
    for (const l of lits) if (solid(l)) return true;
  }
  return false;
}
function contextAt(src, p) {
  const tagStart = src.lastIndexOf('<', p);
  let braceStart = src.lastIndexOf('{', p);
  if (braceStart >= 0 && src.slice(braceStart, p).includes('}')) braceStart = -1;
  if (braceStart > tagStart) {
    const end = src.indexOf('}', p);
    return src.slice(braceStart, end < 0 ? p + 400 : end);
  }
  const end = src.indexOf('>', p);
  return src.slice(Math.max(0, tagStart), end < 0 ? p + 400 : end);
}
function classListAt(src, p) {
  let best = -1, q = '"';
  for (const ch of ['"', "'", '`']) { const i = src.lastIndexOf(ch, p); if (i > best) { best = i; q = ch; } }
  const end = src.indexOf(q, p);
  return src.slice(best + 1, end < 0 ? p + 300 : end);
}
const lineOf = (src, p) => src.slice(0, p).split('\n').length;

// ── the passes ────────────────────────────────────────────────────────────────────────────
const LIT_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/g;
const PROP_RE = /(^|[\s;{"'`(])(color|background(?:-color|-image)?|border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-color)?|outline(?:-color)?|fill|stroke|box-shadow|text-shadow|caret-color|column-rule(?:-color)?|text-decoration-color|-webkit-text-fill-color|accent-color)(\s*:\s*)((?:\$\{[^}]*\}|[^;"'`}{<>\n])+)/gi;

function roleOfProp(p) {
  p = p.toLowerCase();
  if (p.startsWith('background')) return 'bg';
  if (p.includes('shadow')) return 'shadow';
  if (p.startsWith('border') || p.startsWith('outline') || p.startsWith('column-rule')) return 'border';
  return 'text';
}

function processFile(file) {
  const raw = fs.readFileSync(file, 'utf8');
  // Regions fenced with `tokenize:off … tokenize:on` (in any comment style) hold colours that
  // are fixed on purpose — e.g. the dark/light preview cards in Settings › ظاهر. They are
  // swapped for same-height placeholders so line numbers in the report stay true.
  const fenced = [];
  const orig = raw.replace(/(?:<!--|\/\*|\/\/)\s*tokenize:off[\s\S]*?tokenize:on\s*(?:-->|\*\/)?/g, (m) => {
    fenced.push(m);
    return ` OFF${fenced.length - 1}` + '\n'.repeat((m.match(/\n/g) || []).length) + ' ';
  });
  const unfence = (s) => s.replace(/ OFF(\d+)\n* /g, (m, i) => fenced[+i]);
  const changes = [], todos = [];

  function mapValue(src, offset, prop, value, ctxFn) {
    const role = roleOfProp(prop);
    return value.replace(LIT_RE, (lit, i, whole) => {
      // Leave var(--x, #fallback) fallbacks and url(data:…) alone.
      const before = whole.slice(0, i);
      if (/var\([^)]*$/.test(before) || /url\([^)]*$/.test(before)) return lit;
      if (/^(white|black)$/i.test(lit) && /[-\w]$/.test(before)) return lit;
      const c = parseColor(lit);
      if (!c) return lit;
      const ctxText = ctxFn();
      const ctx = {
        onFill: role === 'text' || role === 'border' ? hasChromaticFill(ctxText) : false,
        round: role === 'bg' && /border-radius\s*:\s*50%|rounded-full/.test(ctxText),
      };
      const d = mapColor(c, role, ctx);
      const line = lineOf(src, offset);
      if (d.keep) return lit;
      if (d.todo) { todos.push(`${line}: ${d.todo} — ${prop}: ${value.trim().slice(0, 70)}`); return lit; }
      const out = cssOf(d);
      changes.push(`${line}: [${role}] ${lit} → ${out}` + (d.check ? '   (check)' : ''));
      return out;
    });
  }

  // 1 — CSS declarations
  let src = orig.replace(PROP_RE, (m, pre, prop, colon, value, offset, whole) => {
    const at = offset + pre.length;
    const nv = mapValue(whole, at, prop, value, () => contextAt(whole, at));
    return pre + prop + colon + nv;
  });

  // 2 — el.style.x = '…'
  const JS_ROLE = { color: 'color', background: 'background', backgroundColor: 'background', borderColor: 'border',
    border: 'border', borderTop: 'border', borderBottom: 'border', borderLeft: 'border', borderRight: 'border',
    boxShadow: 'box-shadow', outline: 'outline', fill: 'fill', stroke: 'stroke', outlineColor: 'outline' };
  src = src.replace(/\.style\.(color|background|backgroundColor|borderColor|border|borderTop|borderBottom|borderLeft|borderRight|boxShadow|outline|outlineColor|fill|stroke)(\s*=\s*)(['"`])((?:(?!\3).)*)\3/g,
    (m, prop, eq, q, value, offset, whole) => {
      const nv = mapValue(whole, offset, JS_ROLE[prop], value, () => '');
      return `.style.${prop}${eq}${q}${nv}${q}`;
    });

  // 3 — Tailwind utilities
  const PAL = 'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';
  const TW_RE = new RegExp(`(?<![\\w\\-\\[/])((?:[a-z0-9\\-]+:)*)(bg|text|border(?:-[trblxyse])?|ring|ring-offset|from|via|to|divide|outline|fill|stroke|placeholder|decoration|accent|caret)-(\\[(?:#[0-9a-fA-F]{3,8}|rgba?\\([^\\]\\s]*\\))\\]|(?:${PAL})-(?:50|100|200|300|400|500|600|700|800|900|950)|white|black)(\\/(?:\\d+|\\[[\\d.]+\\]))?(?![\\w\\-\\[])`, 'g');
  const TW_FAM = { red: 'red', rose: 'red', orange: 'orange', amber: 'orange', yellow: 'yellow', lime: 'green', green: 'green', emerald: 'green',
    teal: 'teal', cyan: 'teal', sky: 'teal', blue: 'blue', indigo: 'indigo', violet: 'purple', purple: 'purple', fuchsia: 'purple', pink: 'pink' };
  const NEUTRAL = /^(slate|gray|zinc|neutral|stone)$/;
  src = src.replace(TW_RE, (m, variants, util, color, opac, offset, whole) => {
    const role = /^(bg|from|via|to)$/.test(util) ? 'bg' : /^(border|ring|divide|outline)/.test(util) ? 'border' : 'text';
    const line = lineOf(whole, offset);
    const N = opac ? parseFloat(opac.replace(/[\/\[\]]/g, '')) : null;
    const hover = /(hover|active|focus|group-hover):/.test(variants);
    let tok = null, keep = false, todo = null;
    if (color.startsWith('[')) {
      const c = parseColor(color.slice(1, -1));
      if (!c) return m;
      if (N != null) c.a *= N / 100;
      const cls = classListAt(whole, offset);
      const d = mapColor(c, role, { onFill: role === 'text' && hasChromaticFill(cls), round: /rounded-full/.test(cls) });
      if (d.keep) keep = true; else if (d.todo) todo = d.todo; else tok = twOf(d);
      // hover:bg-[#aecbfa]: brighten the accent button it sits on, or — on a plain button —
      // become the ordinary hover fill.
      if (d.pale && hover) tok = hasChromaticFill(cls.replace(m, '')) ? 'mv-accent/90' : 'mv-fill-2';
    } else if (color === 'white' || color === 'black') {
      const a = N == null ? 1 : N / 100;
      if (color === 'white') {
        if (role === 'text') {
          if (a >= 0.98) { if (hasChromaticFill(classListAt(whole, offset))) keep = true; else tok = 'mv-label'; }
          else tok = a >= 0.8 ? 'mv-label' : a >= 0.5 ? 'mv-label-2' : a >= 0.3 ? 'mv-label-3' : 'mv-label-4';
        } else if (role === 'border') tok = a >= 0.98 ? null : a <= 0.1 ? 'mv-sep' : a <= 0.16 ? 'mv-sep-2' : 'mv-sep-3';
        else tok = a >= 0.98 ? null : a <= 0.05 ? 'mv-fill' : a <= 0.1 ? 'mv-fill-2' : a <= 0.2 ? 'mv-fill-3' : null;
        if (!tok && !keep) todo = 'white ' + role;
      } else {
        if (role === 'bg' && a < 0.98) tok = a >= 0.4 ? 'mv-scrim' : 'mv-field';
        else if (role === 'border' && a < 0.98) tok = 'mv-sep-2';
        else todo = 'black ' + role;
      }
    } else {
      const [fam0, shadeS] = color.split('-');
      const shade = +shadeS;
      if (NEUTRAL.test(fam0)) {
        if (role === 'text') tok = shade <= 300 ? 'mv-label' : shade === 400 ? 'mv-label-2' : shade === 500 ? 'mv-label-3' : shade <= 700 ? 'mv-label-4' : null;
        else if (role === 'border') tok = shade <= 400 ? 'mv-sep-3' : shade <= 600 ? 'mv-sep-3' : shade === 700 ? 'mv-sep-2' : 'mv-sep';
        else tok = shade <= 200 ? null : shade <= 500 ? 'mv-fill-3' : shade === 600 ? 'mv-fill-3' : shade === 700 ? 'mv-fill-2' : shade === 800 ? 'mv-surface-2' : 'mv-surface';
        if (!tok) todo = `${color} ${role}`;
        else if (N != null && /surface/.test(tok)) tok += '/' + N;
      } else {
        const fam = TW_FAM[fam0];
        if (role === 'text') tok = `mv-${fam}-ink` + (N != null ? '/' + N : '');
        else if (role === 'border') tok = `mv-${fam}/` + (N != null ? (shade >= 700 ? Math.round(N * 0.6) : N) : (shade >= 700 ? 35 : 60));
        else if (shade <= 200) todo = `pale ${color} fill`;
        else if (shade >= 800) tok = `mv-${fam}/` + (N != null ? Math.max(8, Math.min(25, Math.round(N * 0.5))) : 22);
        else if (shade === 700 && hover && N == null) tok = `mv-${fam === 'blue' ? 'accent' : fam}/85`;
        else tok = `mv-${fam === 'blue' && util === 'bg' ? 'accent' : fam}` + (N != null ? '/' + N : '');
      }
    }
    if (keep) return m;
    if (todo || !tok) { todos.push(`${line}: ${todo || 'unmapped'} — ${m}`); return m; }
    const out = `${variants}${util}-${tok}`;
    changes.push(`${line}: [tw ${role}] ${m} → ${out}`);
    return out;
  });

  // 4 — what is left: literals outside the three shapes above.
  const left = [];
  src.split('\n').forEach((ln, i) => {
    const stripped = ln.replace(/var\([^)]*\)/g, '').replace(/url\([^)]*\)/g, '');
    const lits = stripped.match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![\w-])|rgba?\([\d\s.,%]+\)/g);
    if (lits) left.push(`${i + 1}: ${lits.join(' ')}   ⟵ ${ln.trim().slice(0, 110)}`);
  });

  if (!QUIET) {
    console.log(`\n══ ${file}: ${changes.length} rewrites, ${todos.length} to do, ${left.length} lines with literals left`);
    if (CHANGES) changes.forEach((c) => console.log('   ' + c));
    todos.forEach((t) => console.log(' ✋ ' + t));
    left.forEach((t) => console.log(' ·  ' + t));
  } else {
    console.log(`${file}: ${changes.length} rewrites, ${todos.length} todo, ${left.length} left`);
  }
  src = unfence(src);
  if (WRITE && src !== raw) fs.writeFileSync(file, src);
}

if (require.main === module) files.forEach(processFile);
module.exports = { parseColor, hsl, family, mapColor, hasChromaticFill, contextAt, classListAt };
