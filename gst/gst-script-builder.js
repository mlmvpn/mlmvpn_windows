// --- GST Apps Script builder ---
// Turns public/gst/Code.gs into the exact text the user pastes into script.google.com:
// their keys injected, comments stripped, folded to pure ASCII.
//
// Why not hand over the file as-is (ported from GstSetupWizard.kt, which learned this
// the hard way):
//   - The raw file is ~29 KB, most of it comment blocks. Clipboards on some systems
//     truncate large pastes, and a truncated script fails at deploy time with an error
//     that says nothing about truncation.
//   - Non-ASCII characters inside comments have shown up mangled after a clipboard
//     round-trip, and the Apps Script editor then flags the file as "changed" even
//     though the user only pasted it.
//   - A user reading a 29 KB wall of English comments cannot tell whether they pasted
//     the whole thing. A ~10 KB body with no comment blocks is verifiable at a glance.
//
// The stripping is safe for THIS file specifically: every block comment in Code.gs is
// full-line, and it contains no multi-line string literals, so no executable code can
// be caught by the line-based rules below. That assumption is asserted at build time —
// see assertStrippable().

const fs = require('fs');
const path = require('path');
const log = require('./gst-log');

function getUnpackedDir() {
    return __dirname.toLowerCase().includes('.asar')
        ? __dirname.replace(/\.asar/gi, '.asar.unpacked')
        : __dirname;
}

const SOURCE = path.join(path.dirname(getUnpackedDir()), 'public', 'gst', 'Code.gs');

/**
 * Guard the assumption the stripper relies on. If someone later adds an inline block
 * comment or a template literal to Code.gs, the line-based stripping could eat real
 * code — better to refuse loudly here than to hand the user a subtly broken script.
 */
function assertStrippable(source) {
    // Only CODE lines are checked. Backticks and /* sequences inside comments are
    // harmless — the stripper deletes those lines wholesale — and flagging them was
    // rejecting a perfectly good Code.gs whose prose happens to quote `identifiers`.
    let inBlock = false;

    source.split(/\r?\n/).forEach((line, i) => {
        const t = line.trim();

        if (inBlock) {
            if (t.includes('*/')) inBlock = false;
            return;
        }
        if (t.startsWith('/*')) {
            if (!t.includes('*/')) inBlock = true;
            return;
        }
        if (t.startsWith('//') || t.startsWith('*') || t === '') return;

        // A block comment opening after code on the same line: the line-based stripper
        // would keep the code but lose track of the comment state.
        if (t.includes('/*')) {
            throw new Error(`Code.gs خط ${i + 1}: کامنت بلاکی وسط کد — سازنده‌ی اسکریپت باید به‌روزرسانی شود.`);
        }
        // A template literal can span lines and contain // or /*, which would let the
        // stripper cut inside a string.
        if (t.includes('`')) {
            throw new Error(`Code.gs خط ${i + 1}: template literal پیدا شد — سازنده‌ی اسکریپت باید به‌روزرسانی شود.`);
        }
    });
}

/** Replace a top-level `const NAME = "...";` with a new value. */
function setConst(source, name, value) {
    const safe = String(value == null ? '' : value)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\r\n]/g, '');
    const re = new RegExp(`^const\\s+${name}\\s*=\\s*"[^"]*"\\s*;`, 'm');
    if (!re.test(source)) {
        throw new Error(`ثابت ${name} در Code.gs پیدا نشد.`);
    }
    return source.replace(re, `const ${name} = "${safe}";`);
}

/**
 * Strip comments and blank lines, and fold to ASCII.
 * Deliberately line-based and conservative — see the assertion above for why that is
 * sound for this file.
 */
function clean(source) {
    const out = [];
    let inBlock = false;

    for (const raw of source.split(/\r?\n/)) {
        const line = raw.replace(/^﻿/, '');   // drop a stray BOM
        const t = line.trim();

        if (inBlock) {
            if (t.includes('*/')) inBlock = false;
            continue;
        }
        if (t.startsWith('/*')) {
            if (!t.includes('*/')) inBlock = true;
            continue;
        }
        if (t.startsWith('//') || t.startsWith('*') || t === '') continue;

        // TRAILING comments on a code line are deliberately left alone.
        //
        // An earlier version scanned for the first `//` outside quotes and cut there.
        // It produced a script that would not even parse, because a regex literal also
        // contains slashes:
        //     item.u.match(/^https?:\/\//i)
        // ends with `//i)` and the scanner cut mid-pattern. Quote tracking does not
        // help — the `//` is inside a regex, not a string, and telling division from a
        // regex needs a real tokenizer. The whole class of bug disappears by only
        // removing lines that are entirely comments, which is also what the Android
        // wizard does. The size win is nearly identical.
        const code = line.replace(/\s+$/, '');
        if (code.trim() === '') continue;

        // Any non-ASCII left at this point sits in an inline comment we kept; fold it
        // so the paste is byte-clean regardless of the clipboard's encoding.
        out.push(code.replace(/[^\x20-\x7E\t]/g, '?'));
    }

    // A guaranteed trailing newline: some paste targets drop a final line that has no
    // terminator, which would swallow the closing brace.
    return out.join('\n') + '\n';
}

/**
 * Build the script for one relay.
 *
 * @param relay    stored relay (supplies the Worker URL and its secret)
 * @param authKey  the shared tunnel key, same for every relay
 * @param opts.withCloudflare  force the Cloudflare path on/off; defaults to
 *                             "on when this relay has a Worker deployed"
 */
function buildForRelay(relay, authKey, opts = {}) {
    let source = fs.readFileSync(SOURCE, 'utf8');
    assertStrippable(source);

    const useCf = opts.withCloudflare === undefined
        ? !!relay.workerUrl
        : !!opts.withCloudflare;

    if (useCf && !relay.workerUrl) {
        throw new Error('برای این ریلی هنوز Worker ساخته نشده است.');
    }

    source = setConst(source, 'AUTH_KEY', authKey);
    // Empty strings switch the script back to the direct path — the same file serves
    // both modes, so turning Cloudflare off later is a re-paste, not a different script.
    source = setConst(source, 'WORKER_URL', useCf ? relay.workerUrl : '');
    source = setConst(source, 'WORKER_AUTH_KEY', useCf ? (relay.cfAuthKey || '') : '');

    const script = clean(source);

    log.info('script', `اسکریپت گوگل برای ریلی «${relay.name}» ساخته شد ` +
        `(${useCf ? 'با کلادفلر' : 'بدون کلادفلر'}، ${script.length} کاراکتر)`);

    return {
        script,
        withCloudflare: useCf,
        bytes: script.length,
        workerUrl: useCf ? relay.workerUrl : '',
        // Shown in the wizard so the user can confirm what they are about to paste
        // without reading the whole thing.
        summary: useCf
            ? `این اسکریپت درخواست‌ها را از Worker شما عبور می‌دهد: ${relay.workerUrl}`
            : 'این اسکریپت مستقیماً از گوگل درخواست می‌فرستد (بدون کلادفلر).',
    };
}

/**
 * The two lines that change when Cloudflare is switched on or off for an existing
 * relay. Re-pasting 10 KB to change two constants is needless work and needless risk,
 * so the panel shows exactly these instead.
 */
function cloudflarePatch(relay, enabled) {
    if (enabled && !relay.workerUrl) {
        throw new Error('برای این ریلی هنوز Worker ساخته نشده است.');
    }
    return {
        lines: [
            `const WORKER_URL = "${enabled ? relay.workerUrl : ''}";`,
            `const WORKER_AUTH_KEY = "${enabled ? (relay.cfAuthKey || '') : ''}";`,
        ],
        instructions: enabled
            ? 'در ویرایشگر اسکریپت گوگل، این دو خط را پیدا کنید و با متن بالا جایگزین کنید. ' +
              'سپس Deploy → Manage deployments → ویرایش → New version → Deploy.'
            : 'این دو خط را خالی کنید تا این ریلی دوباره مستقیم کار کند، سپس نسخه‌ی جدید Deploy کنید.',
    };
}

/** Deployment id sanity check, before the user waits for a probe that cannot succeed. */
function validateDeploymentId(raw) {
    const id = String(raw || '').trim();
    if (!id) return { valid: false, message: 'شناسه‌ی دیپلویمنت خالی است.' };

    // Users often paste the whole /exec URL; take the id out of it instead of refusing.
    const fromUrl = id.match(/\/macros\/s\/([^/]+)\/(?:exec|dev)/);
    const cleaned = fromUrl ? fromUrl[1] : id;

    if (/\s/.test(cleaned)) {
        return { valid: false, message: 'شناسه نباید فاصله داشته باشد.' };
    }
    if (!/^AKfy/i.test(cleaned)) {
        return {
            valid: false,
            cleaned,
            message: 'شناسه‌ی دیپلویمنت با AKfy شروع می‌شود. مطمئن شوید Deployment ID را کپی کرده‌اید، نه Script ID.',
        };
    }
    if (cleaned.length < 40) {
        return { valid: false, cleaned, message: 'شناسه کوتاه‌تر از حد انتظار است — احتمالاً کامل کپی نشده.' };
    }
    return { valid: true, cleaned };
}

module.exports = { SOURCE, buildForRelay, cloudflarePatch, validateDeploymentId, clean };
