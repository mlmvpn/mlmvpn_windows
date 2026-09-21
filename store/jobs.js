// --- «ام‌ال‌ام استور» — work that outlives the request that started it ---
//
// A core download takes minutes on a filtered line (142 s for 21 MB through گف, measured). The
// window must not hold a request open for that long: see the express req-close trap this project
// already hit, where a long request's `close` fired immediately and cancelled the work behind it.
//
// So every action starts a JOB and returns at once; the window polls. A job is a plain record —
// phase, progress, the route the bytes are coming through, what it has said so far, and how it
// ended — and it stays readable after it finishes so a panel that was closed can still show the
// outcome. Nothing here runs on Electron's main thread beyond bookkeeping.

'use strict';

const jobs = new Map();
const MAX_LOG = 60;
const KEEP_MS = 30 * 60 * 1000;

let seq = 0;

function now() { return Date.now(); }

function create(key, { title = '', kind = '' } = {}) {
    const existing = jobs.get(key);
    if (existing && existing.running) return { job: existing, started: false };
    const job = {
        id: ++seq, key, kind, title,
        running: true, phase: 'start', detail: '',
        progress: 0, bytes: 0, total: 0, route: '',
        log: [], error: null, result: null,
        startedAt: now(), endedAt: 0,
        controller: new AbortController(),
    };
    jobs.set(key, job);
    return { job, started: true };
}

const get = (key) => jobs.get(key) || null;

/** Everything the window needs, without the AbortController. */
function view(job) {
    if (!job) return null;
    const { controller, ...rest } = job;
    return rest;
}

function all() {
    const out = {};
    for (const [k, j] of jobs) out[k] = view(j);
    return out;
}

function phase(job, name, detail = '') {
    if (!job) return;
    job.phase = name;
    if (detail) job.detail = detail;
}

function log(job, line) {
    if (!job || !line) return;
    job.log.push({ at: now(), line: String(line) });
    if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
}

function progress(job, done, total) {
    if (!job) return;
    job.bytes = done;
    job.total = total || job.total;
    job.progress = job.total ? Math.min(1, done / job.total) : 0;
}

function finish(job, result) {
    if (!job) return;
    job.running = false;
    job.phase = 'done';
    job.result = result || null;
    job.endedAt = now();
    sweep();
}

function fail(job, err) {
    if (!job) return;
    job.running = false;
    job.phase = err && err.code === 'cancelled' ? 'cancelled' : 'failed';
    job.error = { message: (err && err.message) || String(err), code: (err && err.code) || '' };
    job.endedAt = now();
    sweep();
}

function cancel(key) {
    const job = jobs.get(key);
    if (!job || !job.running) return false;
    try { job.controller.abort(); } catch (e) { /* already gone */ }
    return true;
}

/** Finished jobs are kept for half an hour — long enough for a closed window to come back to them. */
function sweep() {
    for (const [k, j] of jobs) {
        if (!j.running && j.endedAt && now() - j.endedAt > KEEP_MS) jobs.delete(k);
    }
}

/**
 * Run `fn(job)` as the job for `key`, catching everything. Returns the job view immediately; the
 * work continues in the background.
 */
function start(key, meta, fn) {
    const { job, started } = create(key, meta);
    if (!started) return { job: view(job), already: true };
    Promise.resolve()
        .then(() => fn(job))
        .then((result) => finish(job, result))
        .catch((err) => fail(job, err));
    return { job: view(job), already: false };
}

module.exports = { start, get, view, all, phase, log, progress, cancel, finish, fail };
