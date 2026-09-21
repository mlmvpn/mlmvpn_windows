/* Appearance, decided before the first paint.
 *
 * Loaded synchronously in <head>, right after the server-injected storage state, so the
 * page never flashes the wrong appearance. ui/mv.js owns everything after load and reads
 * its decisions from here — this file is the only place the rules live.
 *
 *   mv-appearance          'dark' | 'light' | 'auto'  — what the user chose ('auto' follows
 *                          Windows' light/dark, as Android's «خودکار» follows the phone's)
 *   mv-reduce-transparency '1' | '0'
 *   mv-reduce-motion       '1' (always) | '0' (follow Windows)
 *
 * Only two appearances exist. The eight old themes collapse onto them once: 'light' and
 * 'macLight' become light, everything else dark. With nothing saved at all, Windows'
 * own setting decides.
 */
(function () {
  'use strict';

  // Light was locked until every panel had been moved onto the tokens (redesign phase 4,
  // done 2026-09-10). The choice was recorded all along, so unlocking needed no migration:
  // whoever picked light — or runs Windows in light with nothing saved — now gets it.
  // `false` again would park everyone on dark without losing their choice.
  var LIGHT_READY = true;

  var state = window.__INITIAL_STORAGE_STATE__ || {};
  function read(key) {
    if (Object.prototype.hasOwnProperty.call(state, key) && state[key] != null) return String(state[key]);
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function fromLegacy(name) {
    if (!name) return null;
    return (name === 'light' || name === 'macLight') ? 'light' : 'dark';
  }

  function systemPrefers() {
    try { return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
    catch (e) { return 'dark'; }
  }

  var saved = read('mv-appearance');
  var preferred = (saved === 'light' || saved === 'dark' || saved === 'auto') ? saved : (fromLegacy(read('scanner-theme')) || systemPrefers());
  var lightUnlocked = LIGHT_READY || read('mv-light-preview') === '1';
  var wanted = preferred === 'auto' ? systemPrefers() : preferred;
  var effective = (wanted === 'light' && !lightUnlocked) ? 'dark' : wanted;

  var root = document.documentElement;
  root.setAttribute('data-appearance', effective);
  if (read('mv-reduce-transparency') === '1') root.setAttribute('data-transparency', 'reduced');
  if (read('mv-reduce-motion') === '1') root.setAttribute('data-motion', 'reduced');

  window.MVBoot = {
    LIGHT_READY: LIGHT_READY,
    lightUnlocked: lightUnlocked,
    preferred: preferred,
    effective: effective,
    // True when nothing was saved under the new key yet, so mv.js persists the migration.
    needsSave: saved !== preferred,
    read: read,
    systemPrefers: systemPrefers,
  };
})();
