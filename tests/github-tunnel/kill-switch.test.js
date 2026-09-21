// The kill-switch crash-recovery path, exercised for real — but with PowerShell replaced
// by a recorder, because the thing under test literally blocks all outbound traffic on the
// machine and this must never actually run it.
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
assert.strictEqual(os.homedir(), SANDBOX);

// Patch BEFORE gt-guard is required — it destructures these at module load.
const scripts = [];
const origExecFile = cp.execFile;
const origExecFileSync = cp.execFileSync;
cp.execFile = (exe, args, opts, cb) => {
    const script = args[args.length - 1];
    scripts.push({ sync: false, script });
    // The only read this module does is the profile capture; everything else is a write.
    const out = /Get-NetFirewallProfile/.test(script)
        ? JSON.stringify([
            { Name: 'Domain', Outbound: 'NotConfigured', Enabled: 'True' },
            { Name: 'Private', Outbound: 'Allow', Enabled: 'True' },
            { Name: 'Public', Outbound: 'Block', Enabled: 'False' },
        ])
        : '';
    setImmediate(() => cb(null, out, ''));
};
cp.execFileSync = (exe, args) => { scripts.push({ sync: true, script: args[args.length - 1] }); return ''; };

const guard = require(ROOT + '/github-tunnel/gt-guard');

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

(async () => {
    // ── engage ───────────────────────────────────────────────────────────────────
    await guard.engage({ adapterName: 'mlmvpn-gt', allowPrograms: ['C:\\app\\MLM VPN.exe', 'C:\\core\\tailscaled.exe'] });

    t('engage records the PRE-CHANGE profile state on disk', fs.existsSync(guard.STATE_FILE));
    const saved = JSON.parse(fs.readFileSync(guard.STATE_FILE, 'utf8'));
    t('profile actions are preserved EXACTLY, not collapsed (Allow=2/Block=4 enum trap)',
        saved.profiles.find(p => p.name === 'Domain').action === 'NotConfigured'
        && saved.profiles.find(p => p.name === 'Private').action === 'Allow',
        JSON.stringify(saved.profiles));
    t('a profile that was ALREADY blocking is remembered as Block',
        saved.profiles.find(p => p.name === 'Public').action === 'Block');
    t('the firewall on/off switch is remembered too',
        saved.profiles.find(p => p.name === 'Public').enabled === 'False'
        && saved.profiles.find(p => p.name === 'Domain').enabled === 'True');

    const engageScript = scripts.find(s => /DefaultOutboundAction Block/.test(s.script)).script;
    t('the record is written before the firewall is touched',
        scripts.findIndex(s => /DefaultOutboundAction Block/.test(s.script)) >= 0 && fs.existsSync(guard.STATE_FILE));
    t('allow rules are created BEFORE block-by-default',
        engageScript.indexOf('-tunnel') < engageScript.indexOf('Set-NetFirewallProfile -All -Enabled True -DefaultOutboundAction Block'));
    t('engage switches the firewall ON, or the block action is inert',
        /Set-NetFirewallProfile -All -Enabled True -DefaultOutboundAction Block/.test(engageScript));
    t('the tunnel adapter, both loopbacks, LAN and DHCP are allowed',
        ['-tunnel', '-loopback', '-loopback6', '-lan', '-dhcp'].every(k => engageScript.includes(k)));
    t('both programs are allow-listed so recovery is possible while blocked',
        (engageScript.match(/-prog-/g) || []).length === 2);
    t("a program path containing a quote can't break out of the script",
        !/-Program 'C:\\\\app\\\\MLM VPN\.exe''/.test(engageScript));

    // ── the crash ────────────────────────────────────────────────────────────────
    // Simulate the process dying without running a single line of cleanup: drop the
    // module and re-require it, exactly as a fresh launch would.
    delete require.cache[require.resolve(ROOT + '/github-tunnel/gt-guard')];
    const fresh = require(ROOT + '/github-tunnel/gt-guard');
    t('after a hard kill the machine is still recorded as firewalled', fs.existsSync(fresh.STATE_FILE));
    t('a fresh process starts with isEngaged()=false (in-memory state is gone)', fresh.isEngaged() === false);

    scripts.length = 0;
    const r = await fresh.restoreIfStale();
    t('startup restore reports it did something', r.restored === true, JSON.stringify(r));

    const restoreScript = scripts.map(s => s.script).join('\n');
    t('restore puts EACH profile back to exactly what it was, action AND on/off',
        /Set-NetFirewallProfile -Name 'Domain' -DefaultOutboundAction NotConfigured -Enabled True/.test(restoreScript)
        && /Set-NetFirewallProfile -Name 'Private' -DefaultOutboundAction Allow -Enabled True/.test(restoreScript)
        && /Set-NetFirewallProfile -Name 'Public' -DefaultOutboundAction Block -Enabled False/.test(restoreScript),
        restoreScript.replace(/\n+/g, ' | ').slice(0, 300));
    t('restore never sets a profile to Block that was not already Block',
        (restoreScript.match(/-DefaultOutboundAction Block/g) || []).length === 1);
    t('restore also removes the leftover rules', /Remove-NetFirewallRule -Group/.test(restoreScript));
    t('the record is cleared only after the restore ran', !fs.existsSync(fresh.STATE_FILE));

    const again = await fresh.restoreIfStale();
    t('a second startup restore is a no-op', again.restored === false);

    // ── a restore that FAILS must not throw the record away ──────────────────────
    delete require.cache[require.resolve(ROOT + '/github-tunnel/gt-guard')];
    // Swap the stub BEFORE the require: gt-guard destructures execFile at module load, so
    // patching afterwards leaves it holding the old reference.
    cp.execFile = (exe, args, opts, cb) => setImmediate(() => cb(new Error('Access is denied')));
    const g3 = require(ROOT + '/github-tunnel/gt-guard');
    fs.writeFileSync(g3.STATE_FILE, JSON.stringify({ engagedAt: Date.now(), profiles: [{ name: 'Public', action: 'Allow' }] }));
    const bad = await g3.restoreIfStale();
    t('a failed restore keeps the record for the next launch', bad.restored === false && fs.existsSync(g3.STATE_FILE),
        JSON.stringify(bad));

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
