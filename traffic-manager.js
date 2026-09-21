const fs = require('fs');
const path = require('path');
const os = require('os');

// Save DB in user's home directory to prevent data loss on app restart
const DB_PATH = path.join(os.homedir(), '.mlmvpn_traffic_db.json');

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar') ? __dirname.replace(/\.asar/gi, '.asar.unpacked') : __dirname;
}

const OLD_DB_PATH = path.join(getUnpackedDir(), 'traffic_db.json');
if (fs.existsSync(OLD_DB_PATH) && !fs.existsSync(DB_PATH)) {
    try {
        fs.copyFileSync(OLD_DB_PATH, DB_PATH);
    } catch (e) {
        console.error("Failed to migrate traffic DB", e);
    }
}

let trafficData = {
    daily: {},
    totalUp: 0,
    totalDown: 0,
    sessionUp: 0,
    sessionDown: 0
};

let currentSessionDateStr = null;

// «غیرفعال شدن مانیتورینگ مصرف» (Settings › برنامه). Off = nothing is counted and nothing is
// written to disk; the totals already recorded stay as they are. Set by the client at start.
let enabled = true;
function setEnabled(on) { enabled = !!on; }
function isEnabled() { return enabled; }

function loadDB() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const data = fs.readFileSync(DB_PATH, 'utf-8');
            trafficData = JSON.parse(data);
            trafficData.sessionUp = 0;
            trafficData.sessionDown = 0;
        }
    } catch (e) {
        console.error("Failed to load traffic DB", e);
    }
}

function saveDB() {
    try {
        fs.writeFileSync(DB_PATH, JSON.stringify(trafficData, null, 2));
    } catch (e) {
        console.error("Failed to save traffic DB", e);
    }
}

/**
 * The same write, but at most once every few seconds and off the main thread.
 *
 * addTraffic() runs once a SECOND for as long as a connection is up, and it used to call
 * saveDB() every time — a synchronous JSON.stringify + writeFileSync of the whole history,
 * inside Electron's main process. That is a stutter a second, forever, to persist a counter
 * nobody reads between samples. The numbers in memory stay exact either way; only how often
 * they reach the disk changes, and a crash can now cost a few seconds of byte counts.
 * saveDB() itself stays for the paths that must not lose anything (see flush()).
 */
const SAVE_EVERY_MS = 5000;
let saveTimer = null;
function saveSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.writeFile(DB_PATH, JSON.stringify(trafficData), () => {});
        } catch (e) { /* the next sample tries again */ }
    }, SAVE_EVERY_MS);
    if (saveTimer.unref) saveTimer.unref();
}

/** Write now, synchronously. For session end and app exit, where a lost sample is a lost day. */
function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveDB();
}

function getIranTodayStr() {
    // Return YYYY-MM-DD in Asia/Tehran timezone
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

function startSession() {
    currentSessionDateStr = getIranTodayStr();
    if (!trafficData.daily[currentSessionDateStr]) {
        trafficData.daily[currentSessionDateStr] = { up: 0, down: 0 };
    }
}

function addTraffic(upBytes, downBytes) {
    if (!enabled) return;
    if (!upBytes && !downBytes) return;
    
    trafficData.totalUp += upBytes;
    trafficData.totalDown += downBytes;
    trafficData.sessionUp += upBytes;
    trafficData.sessionDown += downBytes;

    // A day is a calendar day in Tehran, not "the day the connection started": a session that
    // runs past midnight counts the new day's bytes into the new day (Settings › مصرف › مصرف کل).
    if (!currentSessionDateStr || currentSessionDateStr !== getIranTodayStr()) startSession();

    trafficData.daily[currentSessionDateStr].up += upBytes;
    trafficData.daily[currentSessionDateStr].down += downBytes;

    saveSoon();
}

function resetSession() {
    // The session is over: whatever the debounce still owes the disk, pay it now.
    flush();
    currentSessionDateStr = null;
    trafficData.sessionUp = 0;
    trafficData.sessionDown = 0;
}

function getTrafficStats() {
    if (!currentSessionDateStr || currentSessionDateStr !== getIranTodayStr()) startSession();
    return {
        ...trafficData,
        today: trafficData.daily[currentSessionDateStr] || { up: 0, down: 0 }
    };
}

loadDB();

module.exports = {
    flush,
    setEnabled,
    isEnabled,
    addTraffic,
    getTrafficStats,
    startSession,
    resetSession
};
