'use strict';

const fs = require('fs');
const path = require('path');
const MAX_BYTES = 2 * 1024 * 1024;

function readTail(file, bytes = 64 * 1024) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, bytes));
        fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        return buffer.toString('utf8');
    } catch (_) { return ''; }
    finally { if (fd !== undefined) fs.closeSync(fd); }
}

function createDiagnostics(dir) {
    const logFile = path.join(dir, 'diagnostics.jsonl');
    const metadataFile = path.join(dir, 'server-list-status.json');
    let serverList = { automatic: true, lastDownloadAt: null, lastError: null };
    try { serverList = { ...serverList, ...JSON.parse(fs.readFileSync(metadataFile, 'utf8')) }; } catch (_) { /* first run */ }
    let previous = null, lastMoveAt = null;

    function record(event, fields = {}, now = Date.now()) {
        try {
            fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(logFile) && fs.statSync(logFile).size >= MAX_BYTES) {
                fs.rmSync(logFile + '.1', { force: true });
                fs.renameSync(logFile, logFile + '.1');
            }
            const entry = { at: new Date(now).toISOString(), event, ...fields };
            let line = JSON.stringify(entry,
                (_key, value) => typeof value === 'string' ? value.slice(0, 4096) : value);
            // Keep each line valid JSON even when a core notice contains a huge nested payload.
            // Truncating the serialized string would leave a partial record that breaks export.
            if (line.length > 16000) {
                line = JSON.stringify({ at: entry.at, event, message: String(fields.message || fields.error || '').slice(0, 12000), truncated: true });
            }
            fs.appendFileSync(logFile, line + '\n');
        } catch (_) { /* diagnostics must never prevent connect or stop */ }
    }

    function notice(type, data, now = Date.now()) {
        let persist = false;
        if (type === 'RemoteServerListResourceDownloaded') {
            // Download completion is not a claim that a list passed signature validation.
            serverList.lastDownloadAt = new Date(now).toISOString();
            serverList.lastDownloadSource = String(data.url || '').slice(0, 512);
            serverList.lastError = null;
            persist = true;
        } else if ((/^(Warning|Alert|Error)$/.test(type) || (type === 'Info' && /failed|error/i.test(data.message || '')))
            && /remote.?server.?list|server.?list|signature|\bOSL\b/i.test(data.message || '')) {
            serverList.lastError = String(data.message).slice(0, 4096);
            serverList.lastErrorAt = new Date(now).toISOString();
            persist = true;
        }
        if (persist) {
            try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(metadataFile, JSON.stringify(serverList, null, 2)); } catch (_) { /* advisory */ }
        }
        if (persist || /^(Tunnels|ActiveTunnel|ConnectingServer|CandidateServers|ConnectedServerRegion|Warning|Alert|Error|EstablishTunnelTimeout)$/.test(type)
            || (type === 'Info' && /failed|fetch|server entr|download|signature/i.test(data.message || ''))) {
            record('core-' + type, { data }, now);
        }
    }

    function sample(counters, now = Date.now()) {
        if (previous && now > previous.at) {
            const secs = (now - previous.at) / 1000;
            const down = Math.max(0, counters.down - previous.down);
            const up = Math.max(0, counters.up - previous.up);
            if (down || up) lastMoveAt = now;
            record('traffic', {
                seconds: secs, downMbps: +(down * 8 / secs / 1e6).toFixed(3),
                upMbps: +(up * 8 / secs / 1e6).toFixed(3),
                downBytes: counters.down, upBytes: counters.up,
                idleSeconds: Math.floor((now - lastMoveAt) / 1000),
            }, now);
        } else { lastMoveAt = now; }
        previous = { ...counters, at: now };
    }

    return {
        record, notice, sample,
        resetSample() { previous = null; lastMoveAt = null; },
        serverListStatus: () => ({ ...serverList }),
        snapshot: () => ({ logFile, serverList: { ...serverList }, recent: readTail(logFile), previous: readTail(logFile + '.1') }),
    };
}

module.exports = { createDiagnostics, readTail };
