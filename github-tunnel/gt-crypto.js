// --- GitHub Tunnel: credentials at rest ---
//
// WHAT THIS PROTECTS AGAINST, AND WHAT IT DOES NOT
// A GitHub OAuth token with `repo` + `workflow` is a serious credential: it can read and
// write every repository the user owns and push workflow files that then run with their
// identity. With an account POOL there are now up to ten of them in one file. Stored as
// plaintext JSON under the user's profile, that file is readable by every other account on
// the machine, by anything running as the user, and by anything that gets a copy of the
// profile directory — a backup, a synced folder, a forensic image, a stolen laptop.
//
// Windows already has the right primitive: DPAPI, user-scoped. The ciphertext can only be
// turned back into a token by the SAME Windows user on the SAME machine. That is the
// meaningful boundary: it does not stop malware already running as the user (nothing at
// this layer can), but it does stop every one of the copy-the-file cases above.
//
// It is reached through PowerShell's ConvertFrom-SecureString / ConvertTo-SecureString,
// which are DPAPI wrappers, because Node has no binding for CryptProtectData.
//
// THE PLAINTEXT NEVER GOES ON A COMMAND LINE. It is written to the child's stdin instead.
// A command line is visible to every process on the machine through Win32_Process, so
// `powershell -Command "... 'gho_realtoken' ..."` would broadcast the very thing being
// protected — which is the same mistake the removed RDP code made with cmdkey.

const { execFileSync } = require('child_process');

const PREFIX = 'dpapi:';
const PLAIN_PREFIX = 'plain:';

function ps(script, input) {
    return execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, timeout: 20000, encoding: 'utf8', input: input === undefined ? '' : input },
    );
}

let dpapiUsable = null;

/** One probe per process. If DPAPI cannot be reached (non-Windows dev box, PowerShell
 *  locked down by policy), we must know BEFORE storing something we can never read back. */
function dpapiAvailable() {
    if (dpapiUsable !== null) return dpapiUsable;
    try {
        const probe = 'mlmvpn-probe';
        dpapiUsable = unprotectRaw(protectRaw(probe)) === probe;
    } catch (e) {
        dpapiUsable = false;
    }
    return dpapiUsable;
}

function protectRaw(plain) {
    // ReadToEnd, then trim only the trailing newline the pipe adds — a token never ends in
    // whitespace, but trimming the whole string would silently corrupt one that did.
    const out = ps(
        '$p = [Console]::In.ReadToEnd(); ' +
        '$p = $p -replace "\\r?\\n$", ""; ' +
        'ConvertTo-SecureString -String $p -AsPlainText -Force | ConvertFrom-SecureString',
        plain,
    );
    const hex = (out || '').trim();
    if (!/^[0-9a-fA-F]{16,}$/.test(hex)) throw new Error('DPAPI returned no ciphertext');
    return hex;
}

function unprotectRaw(hex) {
    // Validated before interpolation. The ciphertext is not secret, but it IS about to
    // become part of a command line, so it must be provably hex and nothing else.
    if (!/^[0-9a-fA-F]{16,}$/.test(hex)) throw new Error('not a DPAPI blob');
    const out = ps(
        `$s = ConvertTo-SecureString -String '${hex}'; ` +
        '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ' +
        'try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($b) } ' +
        'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }',
    );
    return (out || '').replace(/\r?\n$/, '');
}

/**
 * Wrap a secret for storage. Returns a self-describing string so the reader never has to
 * guess which scheme was used — that guess is how a migration turns into data loss.
 *
 * If DPAPI is unavailable the value is stored readable and SAYS SO in the stored string
 * itself. Silently falling back to plaintext while the code claims to encrypt is worse
 * than not encrypting: it produces a system nobody audits again.
 */
function protect(plain) {
    if (plain === null || plain === undefined || plain === '') return '';
    if (!dpapiAvailable()) return PLAIN_PREFIX + Buffer.from(String(plain), 'utf8').toString('base64');
    try {
        return PREFIX + protectRaw(String(plain));
    } catch (e) {
        return PLAIN_PREFIX + Buffer.from(String(plain), 'utf8').toString('base64');
    }
}

/** Unwrap. Understands both schemes, plus a bare legacy value from before this existed. */
function unprotect(stored) {
    if (!stored) return '';
    const s = String(stored);
    if (s.startsWith(PREFIX)) {
        try { return unprotectRaw(s.slice(PREFIX.length)); } catch (e) { return ''; }
    }
    if (s.startsWith(PLAIN_PREFIX)) {
        try { return Buffer.from(s.slice(PLAIN_PREFIX.length), 'base64').toString('utf8'); } catch (e) { return ''; }
    }
    // A token written by a build from before this module — used as-is, and re-protected by
    // the caller on next write.
    return s;
}

/** True when the stored form is genuinely protected, so the UI can be honest about it. */
function isProtected(stored) {
    return typeof stored === 'string' && stored.startsWith(PREFIX);
}

/** Never log or display a token. When one has to be referred to at all, refer to this. */
function fingerprint(plain) {
    if (!plain) return '';
    return require('crypto').createHash('sha256').update(String(plain)).digest('hex').slice(0, 8);
}

module.exports = { protect, unprotect, isProtected, dpapiAvailable, fingerprint };
