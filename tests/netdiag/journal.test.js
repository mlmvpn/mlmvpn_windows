/*
 * The repair journal, treated as what it is: a file on disk that an Administrator process
 * reads and acts on at startup.
 *
 * Half these cases are hostile inputs. That is not paranoia about our own writer — it is that
 * `%USERPROFILE%` is writable by the user (and by anything running as them), so a journal
 * found there could have been written by someone else entirely. The question each case asks
 * is the same: can a crafted file make an elevated process do something it would not
 * otherwise do?
 *
 * The other half is the two-phase recovery table. The window that matters is not "we died
 * before applying" — it is "we applied and died before recording that we had", because that is
 * the state a one-phase journal cannot distinguish, and blindly rolling back an unapplied
 * repair is itself an unwanted privileged write.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'netdiag-journal-'));
process.env.ProgramData = SANDBOX;
process.env.USERPROFILE = SANDBOX;
os.homedir = () => SANDBOX;

const ROOT = path.resolve(__dirname, '..', '..');
const journal = require(ROOT + '/netdiag/journal');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass: !!pass, detail });

const SID = 'a'.repeat(32);
const goodEntry = over => Object.assign({
    sessionId: SID,
    repairId: 'proxy.wininet.disable',
    generation: 0,
    target: { kind: 'machine' },
    preState: { proxyEnable: 1, proxyServer: '127.0.0.1:10809', autoConfigUrl: null, proxyOverride: null },
}, over || {});

/** An ownership oracle we control, standing in for the real ACL check. */
const owned = who => ({ fileOwner: () => who });

(async () => {
    // ── the file lives where a non-admin cannot rewrite it ──────────────────────────────
    t('the journal lives under ProgramData, not the user profile',
        journal.DIR.startsWith(SANDBOX) && /MLMVPN[\\/]netdiag$/.test(journal.DIR), journal.DIR);

    // ── validation: only ids and typed values survive a read ────────────────────────────
    t('a well-formed entry validates', journal.validateEntry(goodEntry({ phase: 'intent' })).ok);

    const rejected = [
        ['an unknown repairId', goodEntry({ phase: 'intent', repairId: 'rm.everything' })],
        ['a command string smuggled in as a repairId', goodEntry({ phase: 'intent', repairId: 'powershell -c calc' })],
        ['an extra key the schema does not describe',
            goodEntry({ phase: 'intent', preState: { proxyEnable: 1, proxyServer: '', autoConfigUrl: null, proxyOverride: null, cmd: 'calc.exe' } })],
        ['a missing key', goodEntry({ phase: 'intent', preState: { proxyEnable: 1 } })],
        ['a wrong-typed value', goodEntry({ phase: 'intent', preState: { proxyEnable: 'yes', proxyServer: '', autoConfigUrl: null, proxyOverride: null } })],
        ['an out-of-range value', goodEntry({ phase: 'intent', preState: { proxyEnable: 7, proxyServer: '', autoConfigUrl: null, proxyOverride: null } })],
        ['a bogus phase', goodEntry({ phase: 'apply-now' })],
        ['a forged sessionId', goodEntry({ phase: 'intent', sessionId: '../../etc' })],
        ['a negative generation', goodEntry({ phase: 'intent', generation: -1 })],
        ['a malformed interface target', goodEntry({ phase: 'intent', target: { kind: 'interface', guid: '../../..' } })],
        ['a target kind outside the allowlist', goodEntry({ phase: 'intent', target: { kind: 'process', name: 'x' } })],
        ['no preState at all', goodEntry({ phase: 'intent', preState: undefined })],
    ];
    for (const [label, entry] of rejected) {
        const v = journal.validateEntry(entry);
        t(`rejected: ${label}`, v.ok === false, v.reason);
    }
    t('a giant string is rejected rather than stored',
        journal.validateEntry(goodEntry({
            phase: 'intent',
            preState: { proxyEnable: 1, proxyServer: 'x'.repeat(5000), autoConfigUrl: null, proxyOverride: null },
        })).ok === false);

    // The writer is held to the same standard as the reader: an entry that would be refused on
    // read must never reach the disk in the first place.
    let threw = false;
    try { journal.writeIntent(goodEntry({ repairId: 'nope' })); } catch (e) { threw = true; }
    t('writeIntent refuses to journal something that would not validate on read', threw);

    // ── ownership ───────────────────────────────────────────────────────────────────────
    journal.clear();
    journal.writeIntent(goodEntry());
    let rec = await journal.restoreIfStale(Object.assign({ observe: async () => 'present', restore: async () => ({ ok: true }) },
        owned('BUILTIN\\Users')));
    t('a journal owned by a non-administrative principal is NOT honoured',
        rec.ok === false && /owned by/.test(rec.note), JSON.stringify(rec));
    t('...and it is left on disk rather than deleted — removing an untrusted file is another privileged act on it',
        journal.load().length === 1);

    rec = await journal.restoreIfStale({ observe: async () => 'present', restore: async () => ({ ok: true }) });
    t('with no ownership check available at all, recovery is skipped rather than trusted',
        rec.ok === false && /ownership check/.test(rec.note), JSON.stringify(rec));

    // ── the two-phase recovery table ────────────────────────────────────────────────────
    const admin = owned('BUILTIN\\Administrators');

    journal.clear();
    journal.writeIntent(goodEntry());
    let restored = 0;
    rec = await journal.restoreIfStale(Object.assign({
        observe: async () => 'absent',
        restore: async () => { restored++; return { ok: true }; },
    }, admin));
    t('intent + change ABSENT: we died before applying, so nothing is undone',
        restored === 0 && rec.outcomes[0].outcome === 'nothing-to-do', JSON.stringify(rec.outcomes));
    t('...and the entry is cleared', journal.load().length === 0);

    journal.clear();
    journal.writeIntent(goodEntry());
    restored = 0;
    rec = await journal.restoreIfStale(Object.assign({
        observe: async () => 'present',
        restore: async () => { restored++; return { ok: true }; },
    }, admin));
    t('intent + change PRESENT: we applied but never marked it, so the pre-state is restored',
        restored === 1 && rec.outcomes[0].outcome === 'restored', JSON.stringify(rec.outcomes));

    // The window a one-phase journal cannot see.
    journal.clear();
    journal.writeIntent(goodEntry());
    journal.markApplied(SID, 'proxy.wininet.disable', { ok: true });
    t('markApplied moves the entry to the applied phase',
        journal.load()[0].phase === 'applied' && journal.load()[0].applyOk === true);
    restored = 0;
    rec = await journal.restoreIfStale(Object.assign({
        observe: async () => 'present',
        restore: async () => { restored++; return { ok: true }; },
    }, admin));
    t('applied + still present: the pre-state is restored', restored === 1);

    journal.clear();
    journal.writeIntent(goodEntry());
    rec = await journal.restoreIfStale(Object.assign({
        observe: async () => 'unknown',
        restore: async () => ({ ok: true }),
    }, admin));
    t('state unobservable: reported unrecoverable and left alone rather than guessed at',
        rec.outcomes[0].outcome === 'unrecoverable' && journal.load().length === 1, JSON.stringify(rec.outcomes));

    journal.clear();
    journal.writeIntent(goodEntry());
    rec = await journal.restoreIfStale(Object.assign({
        observe: async () => 'present',
        restore: async () => { throw new Error('registry write denied'); },
    }, admin));
    t('a restore that throws is recorded and the entry is kept for the next attempt',
        rec.outcomes[0].outcome === 'restore-failed' && journal.load().length === 1);

    // ── tampering ───────────────────────────────────────────────────────────────────────
    journal.clear();
    journal.writeIntent(goodEntry());
    let raw = JSON.parse(fs.readFileSync(journal.FILE, 'utf8'));
    raw.entries[0].repairId = 'shell.exec';
    fs.writeFileSync(journal.FILE, JSON.stringify(raw));
    restored = 0;
    rec = await journal.restoreIfStale(Object.assign({
        observe: async () => 'present',
        restore: async () => { restored++; return { ok: true }; },
    }, admin));
    t('a tampered repairId is discarded and nothing is executed for it',
        restored === 0 && rec.outcomes[0].outcome === 'discarded', JSON.stringify(rec.outcomes));

    journal.clear();
    journal.writeIntent(goodEntry());
    raw = JSON.parse(fs.readFileSync(journal.FILE, 'utf8'));
    raw.entries[0].preState.proxyServer = 'C:\\Windows\\System32\\calc.exe';
    raw.entries[0].preState.cmd = 'whoami';
    fs.writeFileSync(journal.FILE, JSON.stringify(raw));
    rec = await journal.restoreIfStale(Object.assign({
        observe: async () => 'present', restore: async () => ({ ok: true }),
    }, admin));
    t('an injected extra field invalidates the whole entry', rec.outcomes[0].outcome === 'discarded');

    fs.writeFileSync(journal.FILE, 'not json at all');
    rec = await journal.restoreIfStale(Object.assign({ observe: async () => 'present' }, admin));
    t('an unparseable journal is discarded quietly, not half-executed',
        rec.ok === true && rec.outcomes.length === 0, JSON.stringify(rec));

    journal.clear();
    journal.writeIntent(goodEntry());
    raw = JSON.parse(fs.readFileSync(journal.FILE, 'utf8'));
    raw.schema = 99;
    fs.writeFileSync(journal.FILE, JSON.stringify(raw));
    rec = await journal.restoreIfStale(Object.assign({ observe: async () => 'present' }, admin));
    t('a journal from an unknown schema is discarded, never partially understood',
        /bad schema/.test(rec.note || ''), JSON.stringify(rec));

    // ── the file itself ─────────────────────────────────────────────────────────────────
    journal.clear();
    journal.writeIntent(goodEntry());
    const text = fs.readFileSync(journal.FILE, 'utf8');
    t('the journal contains no executable command text',
        !/powershell|cmd\.exe|Invoke-|Start-Process|Set-ItemProperty/i.test(text), text.slice(0, 200));

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    process.exit(failed ? 1 : 0);
})();
