#!/usr/bin/env node
/*
 * Contrast audit of the design tokens (public/ui/tokens.css), both appearances.
 *   node .claude/contrast.js
 * Translucent labels are composited over each surface first, as the browser does.
 * WCAG: 4.5 for body text, 3 for large/bold text and for UI graphics.
 */
const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui', 'tokens.css'), 'utf8');

function block(sel) {
  const i = css.indexOf(sel);
  const s = css.indexOf('{', i), e = css.indexOf('\n}', s);
  const out = {};
  css.slice(s + 1, e).replace(/--mv-([\w-]+)\s*:\s*([^;]+);/g, (m, k, v) => { out[k] = v.trim(); });
  return out;
}
const base = block(':root {');
const dark = Object.assign({}, base, block('html[data-appearance="dark"] {'));
const light = Object.assign({}, dark, block('html[data-appearance="light"] {'));

function parse(v) {
  let m = v.match(/^#([0-9a-f]{6})$/i);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = v.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
  return null;
}
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])).concat(1);
const lum = (c) => { const f = (x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const TEXT = ['label', 'label-2', 'label-3', 'accent', 'blue-ink', 'green-ink', 'orange-ink', 'red-ink', 'yellow-ink', 'teal-ink', 'purple-ink', 'indigo-ink', 'pink-ink'];
const GROUND = ['window', 'surface', 'surface-2', 'surface-3'];
const FILLS = ['accent', 'green', 'orange', 'red', 'yellow', 'teal', 'indigo', 'purple', 'pink', 'gray',
  'green-fill', 'orange-fill', 'red-fill', 'yellow-fill', 'teal-fill', 'indigo-fill', 'purple-fill', 'pink-fill'];

for (const [name, T] of [['DARK', dark], ['LIGHT', light]]) {
  console.log(`\n══ ${name} — text on grounds (worst of ${GROUND.join(', ')})`);
  for (const t of TEXT) {
    const fg = parse(T[t]); if (!fg) continue;
    let worst = Infinity, where = '';
    for (const g of GROUND) { const bg = parse(T[g]); const r = ratio(over(fg, bg), bg); if (r < worst) { worst = r; where = g; } }
    const need = t === 'label-3' ? 3 : 4.5;
    console.log(`${worst >= need ? '  ok ' : ' LOW '} ${t.padEnd(11)} ${worst.toFixed(2).padStart(5)} (on ${where}; needs ${need})`);
  }
  console.log(`── white text on fills`);
  for (const f of FILLS) {
    const bg = parse(T[f] || ''); if (!bg) continue;
    const r = ratio([255, 255, 255, 1], bg);
    console.log(`${r >= 4.5 ? '  ok ' : r >= 3 ? ' big ' : ' LOW '} ${f.padEnd(12)} ${r.toFixed(2).padStart(5)}`);
  }
}
