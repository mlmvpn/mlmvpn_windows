'use strict';

/**
 * Tor's control port — the half of the engine this app was never speaking to.
 *
 * Everything «تور» knew about itself used to come from parsing stdout: a bootstrap percentage and
 * nothing else. Which relay is carrying the connection, whether any circuit is alive at all, how
 * many bytes have crossed, which country the exit is in, whether a stuck circuit can be replaced
 * without restarting the whole engine — tor answers every one of those, on a port we never opened.
 *
 * That gap is why the three complaints («کند است», «قطع و وصل می‌شود», «دیر وصل می‌شود») had no
 * instrument behind them. The SOCKS port stays open and accepting while every circuit through it
 * is failing, so a watchdog that only asks «is the port alive?» reports a healthy engine.
 *
 * ## The protocol, in the four lines that matter
 *
 *   - A reply line is `NNN<sep>text`. `<sep>` is `-` for "more coming", `+` for "more coming and
 *     the next lines are a data block ending in a lone `.`", and a space for the last line.
 *   - `650` is an asynchronous event and can arrive between any two lines of anything. It is NOT
 *     a reply to the command in flight, which is why events are split out before the queue sees
 *     the line rather than after.
 *   - Commands are answered strictly in order, so one queue with one command in flight is the
 *     whole concurrency model.
 *   - Authentication is the bytes of `<DataDirectory>/control_auth_cookie`, hex-encoded. The file
 *     is written when tor opens the port, so a reader that starts too early sees ENOENT rather
 *     than a wrong answer — hence the retry in [open].
 *
 * Nothing here blocks: the module lives in Electron's main thread beside everything else (see
 * main-process-blocking), so every read is async and every wait is a timer.
 */

const net = require('net');
const fs = require('fs');

/** A command that has not answered in this long is not going to. */
const CMD_TIMEOUT_MS = 8000;

class TorControl {
    constructor() {
        this.sock = null;
        this.buf = '';
        this.queue = [];        // {line, resolve, reject, lines, data, timer}
        this.handlers = [];     // (eventName, restOfLine) => void
        this.ready = false;
        this.closed = false;
        this.inData = false;
        this.dataTarget = null;
    }

    /** Fires for every 650 line. The caller decides what is interesting. */
    onEvent(fn) { if (typeof fn === 'function') this.handlers.push(fn); }

    /** Stop listening. A handler left attached after its caller is gone is a slow leak. */
    offEvent(fn) {
        const i = this.handlers.indexOf(fn);
        if (i >= 0) this.handlers.splice(i, 1);
    }

    /**
     * Open and authenticate.
     *
     * The cookie is read fresh on every attempt: tor rewrites it each time it starts, and a stale
     * one from the previous run authenticates against nothing.
     */
    open(port, cookiePath, { retries = 12, retryMs = 300 } = {}) {
        return new Promise((resolve, reject) => {
            const attempt = (left) => {
                if (this.closed) return reject(new Error('closed'));
                const sock = new net.Socket();
                let settled = false;
                const retry = (err) => {
                    if (settled) return;
                    settled = true;
                    try { sock.destroy(); } catch (e) { /* gone */ }
                    if (left > 0) return setTimeout(() => attempt(left - 1), retryMs);
                    reject(err);
                };
                sock.setTimeout(5000, () => retry(new Error('control port timeout')));
                sock.on('error', retry);
                sock.connect(port, '127.0.0.1', () => {
                    let cookie;
                    try { cookie = fs.readFileSync(cookiePath); }
                    catch (e) { return retry(new Error('cookie unreadable: ' + e.message)); }
                    settled = true;
                    sock.setTimeout(0);
                    sock.removeListener('error', retry);
                    this._attach(sock);
                    this.cmd('AUTHENTICATE ' + cookie.toString('hex'))
                        .then(() => { this.ready = true; resolve(this); })
                        .catch((e) => { this.close(); reject(e); });
                });
            };
            attempt(retries);
        });
    }

    _attach(sock) {
        this.sock = sock;
        sock.setNoDelay(true);
        sock.on('data', (chunk) => this._feed(chunk));
        sock.on('close', () => this._drop(new Error('control port closed')));
        sock.on('error', () => this._drop(new Error('control port error')));
    }

    _drop(err) {
        this.ready = false;
        const q = this.queue.splice(0);
        q.forEach((c) => { clearTimeout(c.timer); c.reject(err); });
        this.sock = null;
    }

    _feed(chunk) {
        this.buf += chunk.toString('utf8');
        let nl;
        while ((nl = this.buf.indexOf('\r\n')) >= 0) {
            const line = this.buf.slice(0, nl);
            this.buf = this.buf.slice(nl + 2);
            this._line(line);
        }
    }

    _line(line) {
        // A data block is being collected — everything up to a lone '.' belongs to it, and the
        // control spec's dot-stuffing means a line that really starts with a dot arrives doubled.
        if (this.inData) {
            if (line === '.') { this.inData = false; return; }
            this.dataTarget.push(line.startsWith('..') ? line.slice(1) : line);
            return;
        }
        const code = line.slice(0, 3);
        const sep = line[3];
        const text = line.slice(4);

        if (code === '650') {
            // `650-` opens a multi-line event; this app reads only the first line of each, which
            // carries the name and the fields. Continuation lines are dropped on purpose.
            const sp = text.indexOf(' ');
            const name = sp === -1 ? text : text.slice(0, sp);
            const rest = sp === -1 ? '' : text.slice(sp + 1);
            this.handlers.forEach((h) => {
                try { h(name, rest); } catch (e) { /* a bad handler must not kill the socket */ }
            });
            return;
        }

        const cur = this.queue[0];
        if (!cur) return;   // an answer to a command that already timed out
        if (sep === '+') {
            cur.lines.push(text);
            this.inData = true;
            this.dataTarget = (cur.data[text.split('=')[0]] = []);
            return;
        }
        if (sep === '-') { cur.lines.push(text); return; }
        // A space: the final line of this reply.
        cur.lines.push(text);
        clearTimeout(cur.timer);
        this.queue.shift();
        if (code.charAt(0) === '2') cur.resolve({ code: +code, lines: cur.lines, data: cur.data });
        else cur.reject(new Error(code + ' ' + text));
        this._pump();
    }

    _pump() {
        const next = this.queue[0];
        if (next && !next.sent && this.sock) {
            next.sent = true;
            try { this.sock.write(next.line + '\r\n'); } catch (e) { /* _drop cleans up */ }
        }
    }

    /** One command, answered in order. Rejects on any non-2xx reply and on silence. */
    cmd(line, timeoutMs = CMD_TIMEOUT_MS) {
        return new Promise((resolve, reject) => {
            if (!this.sock) return reject(new Error('control port not open'));
            const entry = {
                line, resolve, reject, lines: [], data: {}, sent: false,
                timer: setTimeout(() => {
                    const i = this.queue.indexOf(entry);
                    if (i >= 0) this.queue.splice(i, 1);
                    reject(new Error('control timeout: ' + line.split(' ')[0]));
                }, timeoutMs),
            };
            this.queue.push(entry);
            this._pump();
        });
    }

    /**
     * GETINFO, as a plain object.
     *
     * Values arrive two ways — inline (`250-version=0.4.9.12`) and as a data block
     * (`250+circuit-status=` … `.`) — and the caller should not have to care which, so a block is
     * joined back into one newline-separated string.
     */
    async getInfo(...keys) {
        const r = await this.cmd('GETINFO ' + keys.join(' '));
        const out = {};
        keys.forEach((k) => { out[k] = ''; });
        for (const k of Object.keys(r.data)) out[k] = r.data[k].join('\n');
        for (const line of r.lines) {
            const eq = line.indexOf('=');
            if (eq === -1) continue;
            const k = line.slice(0, eq);
            if (!keys.includes(k)) continue;
            if (r.data[k]) continue;         // the block already holds the real value
            out[k] = line.slice(eq + 1);
        }
        return out;
    }

    setConf(pairs) {
        const parts = Object.entries(pairs).map(([k, v]) => (
            v === null || v === '' ? k : k + '="' + String(v).replace(/"/g, '\\"') + '"'
        ));
        return this.cmd('SETCONF ' + parts.join(' '));
    }

    resetConf(...keys) { return this.cmd('RESETCONF ' + keys.join(' ')); }

    signal(name) { return this.cmd('SIGNAL ' + name); }

    setEvents(...names) { return this.cmd('SETEVENTS ' + names.join(' ')); }

    close() {
        this.closed = true;
        this._drop(new Error('closed'));
        if (this.sock) { try { this.sock.destroy(); } catch (e) { /* gone */ } }
        this.sock = null;
    }
}

// ============================================================
// Parsers for the answers this app actually reads
// ============================================================

/**
 * `circuit-status` into objects.
 *
 * A line is `<id> <status> [<path>] [<key>=<value> …]`, and the path is
 * `$FINGERPRINT~nickname,$FINGERPRINT~nickname,…` — first hop the guard, last the exit. A circuit
 * that is not BUILT may have a short path or none: that is not an error but a circuit still being
 * extended, and counting those is how «tor is trying and getting nowhere» is told apart from
 * «tor is idle».
 */
function parseCircuits(text) {
    return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        const parts = line.split(' ');
        const id = parts[0];
        const status = parts[1];
        let path = [];
        let rest = parts.slice(2);
        if (rest.length && rest[0].charAt(0) === '$') {
            path = rest[0].split(',').map((h) => {
                const [fp, nick] = h.replace(/^\$/, '').split('~');
                return { fp, nick: nick || '' };
            });
            rest = rest.slice(1);
        }
        const flags = {};
        rest.forEach((kv) => {
            const eq = kv.indexOf('=');
            if (eq > 0) flags[kv.slice(0, eq)] = kv.slice(eq + 1);
        });
        return { id, status, path, flags };
    });
}

/** `stream-status`: `<id> <status> <circuitId> <target>`. */
function parseStreams(text) {
    return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        const [id, status, circ, target] = line.split(' ');
        return { id, status, circ, target: target || '' };
    });
}

/** The `r` line of an `ns/id/$FP` answer: `r <nick> <id> <digest> <date> <time> <ip> <or> <dir>`. */
function parseNs(text) {
    const line = String(text || '').split('\n').find((l) => l.indexOf('r ') === 0);
    if (!line) return null;
    const p = line.split(' ');
    return { nick: p[1], ip: p[6], orPort: +p[7] || 0 };
}

module.exports = { TorControl, parseCircuits, parseStreams, parseNs };
