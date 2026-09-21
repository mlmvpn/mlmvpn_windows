// --- GST logging ---
// Every step of the Google Script Tunnel emits a Persian line into the same `core_log`
// websocket channel Xray/Aether already use, so the existing core-log panel shows one
// continuous trace. When something breaks mid-wizard we can point at the exact step.
//
// Line format:  [GST][<step>] <message>
// `step` is a short stable tag (cert, worker, script, relay, scan, ...) so a log can be
// filtered per wizard stage without parsing Persian text.
//
// Secrets NEVER reach the log verbatim — pass them through redact() first. The tunnel's
// auth key and the user's Cloudflare Global API Key both flow through this module's
// callers, and a log panel is trivially screenshot-able.

const MAX_BUFFER = 500;

let buffer = [];
let broadcaster = null;   // injected by routes.js: (line) => void

/**
 * Wire the module to the server's websocket broadcaster. Called once at startup.
 * Until this runs, lines are still buffered — nothing is lost during boot.
 */
function setBroadcaster(fn) {
    broadcaster = typeof fn === 'function' ? fn : null;
}

/**
 * Mask a secret for display: first 4 + ellipsis + last 4. Short secrets are fully
 * masked rather than partially revealed — a 6-char key showing 8 chars would leak
 * the whole thing.
 */
function redact(secret) {
    const s = String(secret == null ? '' : secret);
    if (!s) return '(خالی)';
    if (s.length <= 12) return '••••••';
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

// Depth counter, not a boolean: sweeps can overlap and the inner one must not
// un-quiet the outer.
let quietDepth = 0;

/**
 * Run `fn` with routine progress lines suppressed.
 *
 * The periodic health sweep runs every 5 minutes forever, on relays the user may not be
 * using today, and it was writing a dozen lines into the shared core-log panel each time —
 * burying the Xray/Aether trace the panel exists for. Warnings and errors still come
 * through, because a relay that broke while nobody was looking is exactly what the user
 * needs to see; only the "starting…", "testing…", "✓ healthy" chatter is dropped.
 *
 * The ring buffer keeps everything either way, so the GST panel's own log tab is complete.
 */
async function quiet(fn) {
    quietDepth++;
    try { return await fn(); }
    finally { quietDepth--; }
}

function emit(level, step, message) {
    const line = `[GST][${step}] ${message}`;
    buffer.push({ ts: Date.now(), level, step, line });
    if (buffer.length > MAX_BUFFER) buffer.shift();

    const routine = level === 'info' || level === 'ok';
    if (broadcaster && !(quietDepth > 0 && routine)) {
        try { broadcaster(line); } catch (e) { /* a dead socket must not break the caller */ }
    }
    return line;
}

const info = (step, message) => emit('info', step, message);
const ok = (step, message) => emit('ok', step, `✓ ${message}`);
const warn = (step, message) => emit('warn', step, `⚠ ${message}`);
const error = (step, message) => emit('error', step, `✗ ${message}`);

/** Snapshot of the ring buffer, oldest first. */
function getLogs() {
    return buffer.slice();
}

function clear() {
    buffer = [];
}

module.exports = { setBroadcaster, redact, quiet, info, ok, warn, error, getLogs, clear };
