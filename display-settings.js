// --- Settings › صفحه نمایش › «اندازه متن»: the whole app, larger or smaller (Android's text size) ---
//
// Android: a switch «اندازه متن پیش‌فرض سیستم» (follow the phone's own size), and with it off a
// slider from 60% to 140%. On Windows the system scale is already honoured — Chromium draws at
// Windows' display scaling — so "follow the system" is a zoom of 100%, and the slider scales the
// app on top of it.
//
// It is Electron's zoom factor on the window, not CSS zoom on the page: the window manager
// measures the viewport to maximise and snap windows, and CSS zoom would leave those
// measurements in a different unit from the layout. Applied from the main process (the server
// runs there), saved in ~/.mlmvpn/display.json, and applied again on every page load by
// main.js, because a restart starts every window at 100%.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FILE = path.join(os.homedir(), '.mlmvpn', 'display.json');
const SCALE_MIN = 60;
const SCALE_MAX = 140;

const clamp = (n) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(Number(n) || 100)));

function get() {
    let j = {};
    try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { j = {}; }
    // 1.2.2's first build saved one of four zooms; anything but 100% becomes the slider's value.
    if (j.textAuto === undefined && j.textZoom !== undefined) {
        const z = Number(j.textZoom);
        j = { textAuto: !z || z === 1, textScale: clamp(z * 100) };
    }
    const textAuto = j.textAuto !== false;
    const textScale = clamp(j.textScale === undefined ? 100 : j.textScale);
    return { textAuto, textScale, textZoom: textAuto ? 1 : textScale / 100 };
}

function electron() {
    if (!(process.versions && process.versions.electron)) return null;
    try { return require('electron'); } catch (e) { return null; }
}

/** Apply the saved zoom to one window's contents (main.js calls this on every load). */
function applyTo(webContents) {
    try { if (webContents && !webContents.isDestroyed()) webContents.setZoomFactor(get().textZoom); } catch (e) { /* window gone */ }
}

function set(patch) {
    const p = patch || {};
    const cur = get();
    const next = { textAuto: cur.textAuto, textScale: cur.textScale };
    if (p.textAuto !== undefined) next.textAuto = !!p.textAuto;
    if (p.textScale !== undefined) {
        const n = Number(p.textScale);
        if (!Number.isFinite(n)) throw new Error('اندازه‌ی متن شناخته نشد.');
        next.textScale = clamp(n);
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    const e = electron();
    if (e && e.BrowserWindow) e.BrowserWindow.getAllWindows().forEach((w) => applyTo(w.webContents));
    return Object.assign(get(), { applied: !!e });
}

module.exports = { get, set, applyTo, SCALE_MIN, SCALE_MAX, FILE };
