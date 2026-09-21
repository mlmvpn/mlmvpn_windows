// The fail-closed guard and the crash-recovery path.
//
// PowerShell is replaced by a recorder. The code under test sets DefaultOutboundAction=Block
// on every firewall profile and rewrites the machine's resolvers — it must NEVER actually run
// during a test, and the recorder is what makes asserting on it possible instead.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

const SANDBOX = path.join(__dirname, 'home-guard');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
assert.strictEqual(os.homedir(), SANDBOX, 'sandbox not in effect — refusing to touch the real profile');

const scripts = [];
const origExecFile = cp.execFile;
const origExecFileSync = cp.execFileSync;

const profileJson = JSON.stringify([
    { Name: 'Domain', Outbound: 'NotConfigured', Enabled: 'True' },
    { Name: 'Private', Outbound: 'Allow', Enabled: 'True' },
    { Name: 'Public', Outbound: 'Block', Enabled: 'False' },
]);

cp.execFile = (exe, args, opts, cb) => {
    const script = args[args.length - 1];
    scripts.push({ sync: false, script });
    const out = /Get-NetFirewallProfile/.test(script) ? profileJson : '';
    setImmediate(() => cb(null, out, ''));
};
cp.execFileSync = (exe, args) => {
    const script = args[args.length - 1];
    scripts.push({ sync: true, script });
    if (/IsInRole/.test(script)) return 'True';              // pretend we are elevated
    if (/Get-NetAdapter/.test(script)) return 'False';        // no stranded loopback DNS
    return '';
};

const guard = require(ROOT + '/aether-guard');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });
const lastEngage = () => (scripts.filter(s => /DefaultOutboundAction Block/.test(s.script)).pop() || {}).script || '';

(async () => {
    // ── DNS ownership marker ─────────────────────────────────────────────────────
    // The marker is the ONLY thing standing between a killed process and a machine that
    // resolves nothing, so it must exist on disk before the change, not after.
    guard.armDns(path.join(SANDBOX, '.mlmvpn', 'dns-before-aether.json'));
    t('arming DNS writes the record to disk immediately', fs.existsSync(guard.STATE_FILE));
    const armed = JSON.parse(fs.readFileSync(guard.STATE_FILE, 'utf8'));
    t('the record says we own the resolvers', armed.dnsOwned === true);
    t('the record names the snapshot to restore from',
        typeof armed.dnsSnapshot === 'string' && armed.dnsSnapshot.includes('dns-before-aether'));
    t('getStatus agrees', guard.getStatus().dnsOwned === true);

    // ── kill switch ──────────────────────────────────────────────────────────────
    const r = await guard.engageKillSwitch({
        adapterAlias: 'MLMVPN',
        allowPrograms: ['C:\\core\\aether.exe', 'C:\\core\\sing-box.exe', 'C:\\app\\MLM VPN.exe'],
    });
    t('the kill switch engages', r.ok === true, JSON.stringify(r));

    const saved = JSON.parse(fs.readFileSync(guard.STATE_FILE, 'utf8'));
    t('profile actions are preserved EXACTLY (the Allow=2 / Block=4 enum trap)',
        saved.profiles.find(p => p.name === 'Domain').action === 'NotConfigured'
        && saved.profiles.find(p => p.name === 'Private').action === 'Allow'
        && saved.profiles.find(p => p.name === 'Public').action === 'Block',
        JSON.stringify(saved.profiles));
    t('the firewall on/off switch is remembered too, or the restore silently re-enables it',
        saved.profiles.find(p => p.name === 'Public').enabled === 'False');

    const eng = lastEngage();
    t('allow rules are created BEFORE block-by-default (the other order is a total outage window)',
        eng.indexOf('-tunnel') < eng.indexOf('Set-NetFirewallProfile -All -Enabled True -DefaultOutboundAction Block'));
    t('the firewall is switched ON, or the block action is inert on a disabled profile',
        /Set-NetFirewallProfile -All -Enabled True -DefaultOutboundAction Block/.test(eng));
    t('the tunnel adapter, loopback, LAN and DHCP stay reachable',
        ['-tunnel', '-loopback', '-lan', '-dhcp'].every(k => eng.includes(k)));
    // Windows Firewall REFUSES a loopback address as -RemoteAddress:
    //   "An unspecified, multicast, broadcast, or loopback IPv6 address was specified."
    // With $ErrorActionPreference='Stop' that aborted the whole script midway — allow-rules
    // half built, and the profiles already switched on. Seen in the field as "محافظ نشت روشن
    // نشد" on a machine that then lost its internet. Windows does not filter loopback anyway.
    // Checked against RULE lines only: the script carries a comment explaining the absence,
    // and a naive substring match on the whole script fails on that comment.
    const ruleLines = eng.split('\n').filter(l => l.trim().startsWith('New-NetFirewallRule'));
    t('no ::1 rule is emitted — Windows rejects it and it aborts the whole allow-list',
        !ruleLines.some(l => l.includes('::1')), ruleLines.find(l => l.includes('::1')) || '');
    t('the engine is allow-listed, or it can never reconnect and the guard becomes permanent',
        eng.includes('aether.exe'));
    t('sing-box is allow-listed — it owns the socket for everything routed `direct`',
        eng.includes('sing-box.exe'));
    t('the app itself is allow-listed so the user can recover while blocked',
        eng.includes('MLM VPN.exe'));
    t('loopback is allowed as the WHOLE 127.0.0.0/8, since the DNS bridge may bind 127.0.0.2',
        /127\.0\.0\.0\/8/.test(eng));

    // A path is attacker-influenced in the sense that matters here: it comes from the
    // filesystem and is interpolated straight into a PowerShell command line. A single quote
    // in it must be doubled, or everything after it is executed as script.
    scripts.length = 0;
    await guard.releaseKillSwitch();
    const inj = await guard.engageKillSwitch({
        adapterAlias: "MLM'VPN",
        allowPrograms: ["C:\\x\\evil'; Remove-Item C:\\ -Recurse; '.exe"],
    });
    const injScript = lastEngage();
    t('a quote in a program path is escaped, not left to terminate the string',
        inj.ok === true && injScript.includes("evil''; Remove-Item") && !injScript.includes("evil'; Remove-Item"),
        injScript.split('\n').find(l => l.includes('evil')) || '(no rule emitted)');
    t('a quote in the adapter name is escaped too',
        injScript.includes("-InterfaceAlias 'MLM''VPN'"),
        injScript.split('\n').find(l => l.includes('InterfaceAlias')) || '');
    await guard.releaseKillSwitch();
    await guard.engageKillSwitch({ adapterAlias: 'MLMVPN', allowPrograms: ['C:\\core\\aether.exe'] });
    t('loopback is allowed as the WHOLE 127.0.0.0/8, since the DNS bridge may bind 127.0.0.2',
        /127\.0\.0\.0\/8/.test(eng));

    // ── restore fidelity ─────────────────────────────────────────────────────────
    const rel = guard._internal.buildReleaseScript();
    t('the release script restores each profile to its exact recorded action',
        /Set-NetFirewallProfile -Name 'Domain' -DefaultOutboundAction NotConfigured/.test(rel)
        && /Set-NetFirewallProfile -Name 'Private' -DefaultOutboundAction Allow/.test(rel)
        && /Set-NetFirewallProfile -Name 'Public' -DefaultOutboundAction Block/.test(rel), rel);
    t('the release script removes our rules and only ours',
        rel.includes(`Remove-NetFirewallRule -Group '${guard.GROUP}'`));

    await guard.releaseKillSwitch();
    t('releasing clears the firewall half of the record', (guard.getStatus().killSwitch) === false);
    t('but the DNS half is still owned, so the record survives', fs.existsSync(guard.STATE_FILE));

    // ── coexistence with the GitHub Tunnel guard ─────────────────────────────────
    // Both modules drive DefaultOutboundAction. If we engaged while GT is engaged we would
    // record ITS Block as "the machine's original state" and make block-by-default permanent
    // on restore — the safety mechanism bricking the machine.
    fs.writeFileSync(path.join(SANDBOX, '.mlmvpn', 'gt-guard-state.json'), JSON.stringify({ profiles: [] }));
    delete require.cache[require.resolve(ROOT + '/aether-guard')];
    const g2 = require(ROOT + '/aether-guard');
    const refused = await g2.engageKillSwitch({ adapterAlias: 'MLMVPN', allowPrograms: [] });
    t('engaging is REFUSED while the GitHub Tunnel guard holds the firewall',
        refused.ok === false && refused.reason === 'gt-guard-engaged', JSON.stringify(refused));
    fs.rmSync(path.join(SANDBOX, '.mlmvpn', 'gt-guard-state.json'), { force: true });

    // ── crash recovery ───────────────────────────────────────────────────────────
    // A run killed while engaged leaves a machine that is block-by-default with an allow rule
    // pointing at an adapter that no longer exists. Nothing on screen explains it and
    // reinstalling does not fix it, so startup must undo it before anything else.
    delete require.cache[require.resolve(ROOT + '/aether-guard')];
    const g3 = require(ROOT + '/aether-guard');
    fs.writeFileSync(g3.STATE_FILE, JSON.stringify({
        at: Date.now(), dnsOwned: true, dnsSnapshot: null, firewallEngaged: true,
        profiles: [{ name: 'Public', action: 'Allow', enabled: 'True' }],
    }));
    scripts.length = 0;
    const rec = await g3.restoreIfStale();
    t('startup recovery releases a firewall left by a dead run', rec.firewall === true, JSON.stringify(rec));
    t('and it restores to the RECORDED action, not to a guessed one',
        scripts.some(s => /Set-NetFirewallProfile -Name 'Public' -DefaultOutboundAction Allow/.test(s.script)));
    t('the record is cleared once the machine is actually back', !fs.existsSync(g3.STATE_FILE));
    const again = await g3.restoreIfStale();
    t('a second startup recovery is a no-op', again.firewall === false && again.dns === false);

    // ── a failed restore must NOT throw the record away ──────────────────────────
    delete require.cache[require.resolve(ROOT + '/aether-guard')];
    cp.execFile = (exe, args, opts, cb) => setImmediate(() => cb(new Error('Access is denied')));
    const g4 = require(ROOT + '/aether-guard');
    fs.writeFileSync(g4.STATE_FILE, JSON.stringify({
        at: Date.now(), dnsOwned: false, firewallEngaged: true,
        profiles: [{ name: 'Public', action: 'Allow', enabled: 'True' }],
    }));
    const bad = await g4.restoreIfStale();
    t('a failed restore keeps the record for the next launch',
        bad.firewall === false && fs.existsSync(g4.STATE_FILE), JSON.stringify(bad));

    // ── never restore to a state that leaves the user offline ────────────────────
    delete require.cache[require.resolve(ROOT + '/aether-guard')];
    cp.execFile = origExecFile; cp.execFileSync = origExecFileSync;
    cp.execFile = (exe, args, opts, cb) => setImmediate(() => cb(null, profileJson, ''));
    cp.execFileSync = () => '';
    const g5 = require(ROOT + '/aether-guard');
    const relEmpty = g5._internal.buildReleaseScript();
    t('with no recorded state the fallback is Allow, never Block',
        /DefaultOutboundAction Allow/.test(relEmpty) && !/DefaultOutboundAction Block/.test(relEmpty), relEmpty);

    cp.execFile = origExecFile;
    cp.execFileSync = origExecFileSync;

    let failed = 0;
    for (const x of results) {
        if (!x.pass) failed++;
        console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass || !x.detail ? '' : `   -> ${x.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})();
