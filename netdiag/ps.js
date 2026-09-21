/*
 * NetDiag — PowerShell runner and pure parsers.
 *
 * Two responsibilities, deliberately in one file because they share the same hard-won
 * knowledge about what Windows actually returns:
 *
 *   1. run()      a single batched PowerShell child, script fed over stdin.
 *   2. parsers    pure functions from captured text/JSON to structured data. No I/O, so they
 *                 are testable against fixtures from machines we do not have.
 *
 * The rule every parser here obeys, without exception:
 *
 *     If it cannot be read, the answer is UNKNOWN. Never false. Never an empty list that a
 *     rule will read as "there are none".
 *
 * That is why each parser returns `{ ok, value, reason }` rather than a bare value — a bare
 * `[]` from a parser that failed is indistinguishable from a machine with no default route,
 * and one of those two situations means "do not touch anything".
 *
 * Structured-first is the second rule. netsh and route output is LOCALISED: on a German or
 * Persian Windows the headers, the word "On-link" and "Direct access" are all different
 * text. So wherever a structured source exists (a cmdlet returning JSON, or a registry
 * value), that is the primary and the text parse is only a fallback — and where the parse
 * depends on localised words at all, it refuses rather than guesses.
 */

'use strict';

const { execFile } = require('child_process');

// ── the runner ──────────────────────────────────────────────────────────────────────────

/**
 * Fixed, non-negotiable PowerShell arguments.
 *
 * -NoProfile          a user profile script must not be able to change what an elevated
 *                     child of this app does.
 * -NonInteractive     never block on a prompt; this runs behind a UI with a deadline.
 * -ExecutionPolicy    the script is compiled into the binary, not read from disk.
 * -Command -          the script arrives on STDIN. This is why there is no temp file to
 *                     plant or race, and no argument string for anything to be injected
 *                     into: nothing the caller supplies is ever concatenated into a command
 *                     line. (xray-manager.js:509 writes its refresh script to a fixed path
 *                     under %TEMP% and runs it elevated; NetDiag does not inherit that.)
 */
const PS_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-']);

/**
 * Emitted before every script.
 *
 * Without the encoding line, PS 5.1 hands back the OEM code page and every non-ASCII adapter
 * name arrives as mojibake — which then fails to match the same name read from anywhere else.
 * ErrorActionPreference stays 'Continue' on purpose: one failing cmdlet must not abort the
 * whole batch, because a batch that dies takes a dozen readable facts down with the one that
 * was not.
 */
const PS_PREAMBLE = [
    '$ErrorActionPreference = "Continue"',
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '',
].join('\n');

/**
 * Run one PowerShell script and capture stdout.
 *
 * Resolves — never rejects. A failure is data: the caller turns it into `unknown` facts with
 * a reason, which is the whole point of the three-state fact model.
 */
function run(script, opts) {
    const o = opts || {};
    const timeout = o.timeout || 20000;
    return new Promise(resolve => {
        let child;
        const started = Number(process.hrtime.bigint() / 1000000n);
        const done = (res) => resolve(Object.assign({ ms: Number(process.hrtime.bigint() / 1000000n) - started }, res));
        try {
            child = execFile('powershell.exe', PS_ARGS, {
                timeout,
                windowsHide: true,
                // 4MB is generous for structured inventory (this app's largest real payload,
                // the winsock catalog, is ~100KB) and small enough that a runaway serialisation
                // is killed in a second rather than filling memory for a minute.
                //
                // Runaway is not hypothetical. `Get-Content` attaches PSDrive/PSProvider to
                // every line, and ConvertTo-Json -Depth 6 expanded a 90-line hosts file into
                // 198MB — which surfaced as an unexplained timeout with an empty result, and
                // turned every fact in the wave into UNKNOWN. A cap plus a NAMED reason turns
                // that from an hour of bisecting into one line of output.
                maxBuffer: 4 * 1024 * 1024,
                encoding: 'utf8',
            }, (err, stdout, stderr) => {
                if (err) {
                    const overflow = /maxBuffer/i.test(err.message || '');
                    return done({
                        ok: false,
                        stdout: stdout || '',
                        stderr: stderr || '',
                        overflow,
                        reason: overflow
                            ? 'powershell produced more output than the diagnostic buffer allows '
                              + '(a serialisation is expanding an object graph — cast to plain values and cap the rows)'
                            : (err.killed ? `powershell timed out after ${timeout}ms` : (err.message || 'powershell failed')),
                    });
                }
                done({ ok: true, stdout: stdout || '', stderr: stderr || '', reason: null });
            });
        } catch (e) {
            return done({ ok: false, stdout: '', stderr: '', reason: e.message });
        }
        try {
            child.stdin.end(PS_PREAMBLE + script + '\n');
        } catch (e) {
            done({ ok: false, stdout: '', stderr: '', reason: `could not write script to powershell: ${e.message}` });
        }
    });
}

// ── JSON normalisation ──────────────────────────────────────────────────────────────────

/**
 * Markers PowerShell leaves behind when ConvertTo-Json hits its depth limit.
 *
 * At the default -Depth 2 a nested object is serialised as its type name instead of its
 * contents. A parser that does not notice reads the string "System.Object[]" as a value and
 * reasons about it. Every script this engine runs passes -Depth 6, but a build could regress,
 * and a truncated field must degrade to unknown rather than to a plausible-looking string.
 */
const TRUNCATION_MARKERS = [
    'System.Object[]',
    'Microsoft.Management.Infrastructure.CimInstance',
    'Microsoft.Management.Infrastructure.CimClass',
    'Microsoft.Management.Infrastructure.CimSystemProperties',
    'System.Collections.Hashtable',
];

function isTruncatedValue(v) {
    return typeof v === 'string' && TRUNCATION_MARKERS.some(m => v === m || v.startsWith(m + ','));
}

/**
 * Parse PowerShell JSON into a normalised array.
 *
 * Handles the three traps that have each produced a wrong answer in practice:
 *
 *   BOM            Out-File -Encoding utf8 on PS 5.1 writes a UTF-8 BOM, and JSON.parse
 *                  throws on it. Verified on this machine's own fixtures.
 *   single object  A cmdlet that returns exactly one row serialises as an object, not a
 *                  one-element array. `Get-NetRoute -DestinationPrefix 0.0.0.0/0` on a
 *                  single-homed machine is the common case, so the naive `.forEach` reads
 *                  "no default route" — a total-blackout diagnosis on a healthy machine.
 *   empty          No output at all is not an empty result set; it is an unreadable one.
 */
function parseJson(text) {
    if (text == null) return { ok: false, value: null, reason: 'no output' };
    const s = String(text).replace(/^﻿/, '').trim();
    if (!s) return { ok: false, value: null, reason: 'empty output' };
    let parsed;
    try {
        parsed = JSON.parse(s);
    } catch (e) {
        return { ok: false, value: null, reason: `unparseable JSON: ${e.message}` };
    }
    if (parsed === null) return { ok: false, value: null, reason: 'JSON null' };
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    const truncated = arr.some(row => row && typeof row === 'object'
        && Object.values(row).some(isTruncatedValue));
    return { ok: true, value: arr, reason: null, truncated, wasArray: Array.isArray(parsed) };
}

/**
 * Read one field, refusing a truncated one.
 * Returns `undefined` for "not readable", which callers turn into an `unknown` fact.
 */
function field(row, name) {
    if (!row || typeof row !== 'object') return undefined;
    const v = row[name];
    if (v === undefined || v === null) return undefined;
    return isTruncatedValue(v) ? undefined : v;
}

// ── Windows enumerations ────────────────────────────────────────────────────────────────
//
// These are numeric in the JSON, which is the good news: numbers are not localised. They are
// pinned here as constants and asserted in the tests, in the same spirit as the guard suite
// pinning NetSecurity.Action — reading one of these wrong is silent and total.

/** Winsock/WMI address families as they appear in Get-NetRoute / Get-NetNeighbor JSON. */
const AF = Object.freeze({ INET: 2, INET6: 23 });

function familyOf(afNumber) {
    if (afNumber === AF.INET) return 'v4';
    if (afNumber === AF.INET6) return 'v6';
    return null;                                     // unknown, never a guess
}

/** Get-NetNeighbor State. `Unreachable` is what distinguishes a dead L2 link from routing. */
const NEIGHBOR_STATE = Object.freeze({
    0: 'Unreachable',
    1: 'Incomplete',
    2: 'Probe',
    3: 'Delay',
    4: 'Stale',
    5: 'Reachable',
    6: 'Permanent',
});

function neighborState(v) {
    if (typeof v === 'string') return v;             // some builds emit the name directly
    return NEIGHBOR_STATE[v] || null;
}

// ── route print ─────────────────────────────────────────────────────────────────────────

const IPV4_RX = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * Parse `route print -4`.
 *
 * Locale-independent by construction: it never looks at a header, a section title, or the
 * word "On-link". It looks for lines whose first four columns are dotted quads and whose
 * fifth is an integer — a shape that is identical on every Windows UI language. The gateway
 * column is either a quad or the localised on-link token, so a non-quad there is recorded as
 * `onLink: true` without needing to know what the word says.
 *
 * Used only as the fallback for Get-NetRoute; the structured cmdlet is the primary.
 */
function parseRoutePrint4(text) {
    if (text == null || !String(text).trim()) {
        return { ok: false, value: null, reason: 'no output' };
    }
    const routes = [];
    for (const line of String(text).split(/\r?\n/)) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 5) continue;
        const [dest, mask, gw] = cols;
        const iface = cols[cols.length - 2];
        const metric = cols[cols.length - 1];
        if (!IPV4_RX.test(dest) || !IPV4_RX.test(mask) || !IPV4_RX.test(iface)) continue;
        if (!/^\d+$/.test(metric)) continue;
        const onLink = !IPV4_RX.test(gw);
        routes.push({
            destination: dest,
            netmask: mask,
            gateway: onLink ? null : gw,
            onLink,
            interfaceAddress: iface,
            metric: parseInt(metric, 10),
            isDefault: dest === '0.0.0.0' && mask === '0.0.0.0',
        });
    }
    if (!routes.length) {
        // An unreadable table and a table with no routes are different situations, and only
        // one of them is safe to reason about. Windows always has loopback routes, so zero
        // parsed rows means the parse failed, not that the machine has no routes.
        return { ok: false, value: null, reason: 'no route rows recognised in output' };
    }
    return { ok: true, value: routes, reason: null, defaults: routes.filter(r => r.isDefault) };
}

/**
 * Parse the adapter list at the top of `route print`.
 * Shape is `<index>...<mac bytes> ......<description>`; loopback has no MAC.
 */
function parseRoutePrintInterfaces(text) {
    if (text == null || !String(text).trim()) return { ok: false, value: null, reason: 'no output' };
    const out = [];
    const rx = /^\s*(\d+)\.\.\.((?:[0-9a-f]{2}[ ]){5}[0-9a-f]{2})?\s*\.+(.+)$/i;
    for (const line of String(text).split(/\r?\n/)) {
        const m = line.match(rx);
        if (!m) continue;
        out.push({
            index: parseInt(m[1], 10),
            mac: m[2] ? m[2].trim().toLowerCase().replace(/ /g, '-') : null,
            description: m[3].trim(),
        });
    }
    return out.length
        ? { ok: true, value: out, reason: null }
        : { ok: false, value: null, reason: 'no interface rows recognised' };
}

// ── WinHTTP proxy ───────────────────────────────────────────────────────────────────────

/**
 * Parse the WinHttpSettings registry blob — the STRUCTURED, locale-independent source.
 *
 * Layout (little-endian):
 *   0..3   version
 *   4..7   change counter
 *   8..11  flags: 1 = direct, 2 = named proxy, 4 = autoconfig URL
 *   12..15 proxy string length, then that many bytes of ASCII
 *   then   bypass list length, then that many bytes
 *
 * This is why "direct" can be stated as a fact instead of inferred from the English words
 * "Direct access": the flag bit says so in every locale.
 *
 * `blob` is a hex string or a Buffer (the collector reads it with Get-ItemProperty).
 */
function parseWinhttpSettingsBlob(blob) {
    let buf;
    try {
        buf = Buffer.isBuffer(blob) ? blob : Buffer.from(String(blob).replace(/[^0-9a-f]/gi, ''), 'hex');
    } catch (e) {
        return { ok: false, value: null, reason: 'unreadable WinHttpSettings blob' };
    }
    if (!buf || buf.length < 12) return { ok: false, value: null, reason: 'WinHttpSettings blob too short' };

    const flags = buf.readUInt32LE(8);
    const out = { mode: 'direct', server: null, bypass: null, flags };
    let off = 12;
    const readStr = () => {
        if (off + 4 > buf.length) return null;
        const len = buf.readUInt32LE(off); off += 4;
        if (len === 0 || off + len > buf.length) return '';
        const s = buf.toString('ascii', off, off + len); off += len;
        return s;
    };
    if (flags & 0x2) { out.mode = 'proxy'; out.server = readStr(); out.bypass = readStr(); }
    else if (flags & 0x4) { out.mode = 'autoconfig'; }
    else if (flags & 0x1) { out.mode = 'direct'; }
    else return { ok: false, value: null, reason: `unrecognised WinHttpSettings flags 0x${flags.toString(16)}` };

    return { ok: true, value: out, reason: null };
}

const HOSTPORT_RX = /\b((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-f:]+\]|[a-z0-9][a-z0-9.-]*\.[a-z]{2,}|localhost)\s*:\s*(\d{1,5})\b/i;

/**
 * Parse `netsh winhttp show proxy` — the FALLBACK only.
 *
 * A configured proxy is recognisable in any locale because `host:port` is not translated. The
 * absence of one is NOT: "Direct access (no proxy server)" is German on a German machine and
 * Persian on a Persian one, and there is no way to tell that sentence from an error message
 * or from output this parser simply does not understand.
 *
 * So: a proxy found is `ok`. Nothing found is `unknown` — deliberately not `direct`. The
 * registry blob above is what proves `direct`. This is the Prime Directive applied to a
 * parser: refusing to guess costs one registry read; guessing costs a wrong diagnosis on
 * every non-English machine.
 */
function parseWinhttpShowProxy(text) {
    if (text == null || !String(text).trim()) return { ok: false, value: null, reason: 'no output' };
    const s = String(text);
    const m = s.match(HOSTPORT_RX);
    if (m) {
        const bypassLine = s.split(/\r?\n/).find(l => /[:：]/.test(l) && /[;*]|<[a-z]+>/i.test(l) && !HOSTPORT_RX.test(l));
        return {
            ok: true,
            value: {
                mode: 'proxy',
                server: `${m[1]}:${m[2]}`,
                bypass: bypassLine ? bypassLine.split(/[:：]/).slice(1).join(':').trim() : null,
            },
            reason: null,
        };
    }
    return {
        ok: false,
        value: null,
        reason: 'no proxy endpoint in output; "direct" cannot be confirmed from localised text — read WinHttpSettings instead',
    };
}

// ── winsock catalog ─────────────────────────────────────────────────────────────────────

/**
 * Provider DLLs Windows is known to ship. Annotation only — NOT the classification rule.
 *
 * It was the rule once, and independent validation broke it within a minute: this machine's
 * catalog contains `wshqos.dll`, which is Microsoft-signed, lives in System32, and was not on
 * the list. A name allowlist is a promise to enumerate every provider Microsoft has ever
 * shipped across every Windows build, and that promise cannot be kept — each omission
 * invents a third-party LSP on a healthy machine.
 *
 * Location decides instead (see below), and the phase-5 collector adds the publisher check
 * that only a real file read can perform.
 */
const MS_PROVIDER_DLLS = new Set([
    'mswsock.dll', 'winrnr.dll', 'nlaapi.dll', 'nlasvc.dll', 'napinsp.dll', 'pnrpnsp.dll',
    'wshbth.dll', 'rsvpsp.dll', 'wshqos.dll',
]);

/**
 * A localisation resource reference, not a provider.
 *
 * Catalog entries name their Description as an MUI reference — `@%SystemRoot%\system32\
 * nlasvc.dll,-1000` — which is a pointer to a string table, not a DLL loaded into the socket
 * path. Scraping every `.dll` in the output picks these up, and this machine's own catalog
 * then reported nlasvc.dll as a third-party LSP: a fabricated fault on a perfectly healthy
 * Windows. The `@…,-<id>` shape is syntax, not text, so excluding it costs no locale
 * independence.
 */
const MUI_REF_RX = /@[^\s,]+\.dll,-\d+/gi;

/**
 * Parse `netsh winsock show catalog`.
 *
 * Locale-independent because it never reads a label. Every entry names its provider as a file
 * path, and a path is a path in every language — so the parse keys on the paths themselves
 * and on the provider GUIDs, both of which are values rather than translated text.
 */
function parseWinsockCatalog(text) {
    if (text == null || !String(text).trim()) return { ok: false, value: null, reason: 'no output' };
    // Strip MUI references first, so a Description's string-table pointer can never be
    // mistaken for a provider binary.
    const s = String(text).replace(MUI_REF_RX, '');

    const paths = [];
    const pathRx = /((?:%systemroot%|%windir%|[a-z]:)\\[^\r\n",]*?\.dll)/gi;
    let m;
    while ((m = pathRx.exec(s)) !== null) paths.push(m[1].trim());

    if (!paths.length) {
        return { ok: false, value: null, reason: 'no provider paths recognised in catalog output' };
    }

    const seen = new Map();
    for (const p of paths) {
        const norm = p.toLowerCase().replace(/\//g, '\\');
        const base = norm.split('\\').pop();
        // Location, not name. A provider inside System32 is part of Windows as far as a text
        // parser can tell; one outside it is the third-party LSP worth reporting. Getting
        // past this would need a DLL planted in System32, which already requires the
        // privileges this check is not the last line of defence against.
        const inSystem = /^(%systemroot%|%windir%|[a-z]:\\windows)\\system32\\/.test(norm);
        if (!seen.has(norm)) {
            seen.set(norm, { path: p, base, microsoft: inSystem, wellKnown: MS_PROVIDER_DLLS.has(base), count: 0 });
        }
        seen.get(norm).count++;
    }
    const providers = [...seen.values()];
    return {
        ok: true,
        value: providers,
        reason: null,
        thirdParty: providers.filter(p => !p.microsoft),
        entryCount: paths.length,
    };
}

module.exports = {
    PS_ARGS, PS_PREAMBLE, run,
    parseJson, field, isTruncatedValue, TRUNCATION_MARKERS,
    AF, familyOf, NEIGHBOR_STATE, neighborState,
    parseRoutePrint4, parseRoutePrintInterfaces,
    parseWinhttpSettingsBlob, parseWinhttpShowProxy,
    parseWinsockCatalog, MS_PROVIDER_DLLS,
};
