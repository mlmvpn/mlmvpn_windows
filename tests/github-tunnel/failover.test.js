// The acceptance scenario, driven through the REAL createSession():
//
//   Account 1 -> exhausted
//   Account 2 -> exhausted
//   Account 3 -> available  ->  session created here, bound to account 3
//
// GitHub, the broker and Tailscale are all stubbed at global.fetch, so nothing leaves the
// machine and no runner is ever dispatched. USERPROFILE is redirected first, so the real
// ~/.mlmvpn is untouched.
const ROOT = require('path').resolve(__dirname, '..', '..');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const SANDBOX = path.join(__dirname, 'home-failover');
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '.mlmvpn'), { recursive: true });
process.env.USERPROFILE = SANDBOX;
process.env.HOME = SANDBOX;
process.env.MLMVPN_GT_BROKER_URL = 'https://relay.test';
assert.strictEqual(os.homedir(), SANDBOX);

const GT = ROOT + '/github-tunnel';
const accounts = require(`${GT}/gt-accounts`);
const allocator = require(`${GT}/gt-allocator`);
const store = require(`${GT}/gt-config`);
const deployer = require(`${GT}/gt-deployer`);

const results = [];
const t = (name, pass, detail) => results.push({ name, pass, detail });

function reset() {
    fs.rmSync(accounts.STORE_FILE, { force: true });
    fs.rmSync(store.STORE_FILE, { force: true });
    accounts._tokenCache.clear();
    allocator._leases.clear();
}

/**
 * A fake GitHub whose behaviour is decided per ACCOUNT, keyed on the bearer token — which
 * is also how this test proves session affinity: if the deployer ever used the wrong
 * account's credential, the wrong behaviour would fire and the assertions would catch it.
 */
function stubWorld({ behaviour, seen }) {
    let nextRunId = 5000;
    const runs = new Map();     // runId -> { token, state }

    global.fetch = async (url, opts = {}) => {
        const u = String(url);
        const auth = (opts.headers && (opts.headers.Authorization || opts.headers.authorization)) || '';
        const token = auth.replace('Bearer ', '');
        const who = token.replace('tok_', '');
        const json = (o, s = 200) => new Response(JSON.stringify(o), {
            status: s, headers: { 'Content-Type': 'application/json', Date: new Date().toUTCString() },
        });

        if (u.startsWith('https://relay.test')) return json({ key: 'tskey-fake', expiresAt: '2030-01-01' });

        if (token) seen.add(who);

        if (u.endsWith('/user')) return json({ login: who, name: who, type: 'User' });
        if (/\/repos\/[^/]+\/mlmvpn-cloud-tunnel$/.test(u)) {
            return json({ full_name: `${who}/mlmvpn-cloud-tunnel`, name: 'mlmvpn-cloud-tunnel', default_branch: 'main' });
        }
        if (u.includes('/contents/.github/workflows/')) {
            // GET = "does the workflow exist yet" (no), PUT = push it.
            if (opts.method === 'PUT') return json({ content: {}, commit: {} }, 201);
            return json({ message: 'Not Found' }, 404);
        }
        if (u.includes('/actions/secrets/public-key')) {
            // A real curve25519 public key: libsodium's crypto_box_seal rejects anything
            // that is not a valid point, so a buffer of zeroes will not do.
            const sodium = require(ROOT + '/node_modules/libsodium-wrappers');
            const kp = sodium.crypto_box_keypair();
            return json({ key: Buffer.from(kp.publicKey).toString('base64'), key_id: '1' });
        }
        // 204 must carry a null body — constructing one with a body throws in undici.
        if (u.includes('/actions/secrets/')) return new Response(null, { status: 204, headers: { Date: new Date().toUTCString() } });

        if (u.includes('/dispatches')) {
            const id = ++nextRunId;
            runs.set(id, { token: who });
            return new Response(null, { status: 204, headers: { Date: new Date().toUTCString() } });
        }
        if (u.includes('/runs?')) {
            const mine = [...runs.entries()].filter(([, r]) => r.token === who);
            return json({
                total_count: mine.length,
                workflow_runs: mine.map(([id]) => ({
                    id, status: 'queued', created_at: new Date().toISOString(),
                    run_started_at: new Date().toISOString(), updated_at: new Date().toISOString(),
                })),
            });
        }
        if (/\/actions\/runs\/\d+$/.test(u)) {
            const id = Number(u.match(/\/runs\/(\d+)$/)[1]);
            const owner = runs.get(id);
            const mode = behaviour[owner ? owner.token : who] || 'ok';
            const started = new Date().toISOString();
            if (mode === 'dies') {
                // Starts and dies instantly: the signature of a spent allowance.
                return json({ id, status: 'completed', conclusion: 'failure', run_started_at: started, updated_at: started });
            }
            return json({ id, status: 'in_progress', conclusion: null, run_started_at: started, updated_at: started });
        }
        if (u.includes('/contents/sessions/')) {
            if (opts.method === 'DELETE') return json({});
            const mode = behaviour[who] || 'ok';
            if (mode !== 'ok') return json({ message: 'Not Found' }, 404);
            return json({
                content: Buffer.from(JSON.stringify({ ip: '100.64.0.9', port: 3389, username: 'mlmvpn', password: 'p' })).toString('base64'),
                sha: 'abc',
            });
        }
        if (u.includes('/cancel')) return json({}, 202);
        return json({ message: 'Not Found' }, 404);
    };
}

function addAccount(login) {
    const { account } = accounts.upsert({ login, name: login, scopes: 'repo,workflow', token: `tok_${login}` });
    return accounts.get(account.id);
}

(async () => {
    // ── the acceptance scenario ─────────────────────────────────────────────────────
    reset();
    const a1 = addAccount('acct1');
    const a2 = addAccount('acct2');
    const a3 = addAccount('acct3');
    const seen = new Set();
    stubWorld({ behaviour: { acct1: 'dies', acct2: 'dies', acct3: 'ok' }, seen });

    const logs = [];
    let session = null;
    let createError = null;
    try {
        session = await deployer.createSession({ onLog: (m) => logs.push(m) });
    } catch (e) { createError = e; }
    if (process.env.GT_TEST_VERBOSE) {
        console.log(logs.join('\n'));
        if (createError) console.log('ERR>', createError.stack);
    }

    t('a session is created despite the first two accounts being spent',
        !!session && !createError, createError && createError.message);
    t('the session is bound to the account that actually ran it',
        !!session && session.accountId === a3.id && session.accountLogin === 'acct3',
        session && `${session.accountLogin}`);
    t('every account was tried in order until one worked',
        seen.has('acct1') && seen.has('acct2') && seen.has('acct3'));
    t('the two spent accounts are marked exhausted, not merely retried',
        accounts.get(a1.id).health === accounts.HEALTH.EXHAUSTED
        && accounts.get(a2.id).health === accounts.HEALTH.EXHAUSTED,
        `${accounts.get(a1.id).health}/${accounts.get(a2.id).health}`);
    t('the account that worked is marked healthy',
        accounts.get(a3.id).health === accounts.HEALTH.OK);
    t('failover is visible in the log rather than silent',
        logs.some(l => /سهم اجرا تمام شده/.test(l)), logs.filter(l => l.includes('acct')).slice(0, 2).join(' | '));
    t('no lease is left holding an account after the create finishes',
        allocator.leasedIds().length === 0, allocator.leasedIds().join(','));
    t('a session was recorded against the winning account for this cycle',
        (accounts.get(a3.id).usage[accounts.currentCycle()] || {}).sessions === 1);

    // ── scenario 7: quota running out must NOT kill a live session ──────────────────
    t('an account going exhausted mid-session leaves that session running', (() => {
        // The tunnel is on acct3. Now acct3 runs out — a NEW session cannot go there, but
        // the machine already running is paid for and must be left alone.
        accounts.markUnhealthy(a3.id, accounts.HEALTH.EXHAUSTED, 'spent');
        const live = deployer.activeSession();
        const stillOwned = live && live.accountId === a3.id;
        const stillSelectable = accounts.isSelectable(accounts.get(a3.id));
        // Session intact and still resolvable to its own credential; account no longer
        // eligible for NEW work.
        return stillOwned && !stillSelectable && deployer.tokenForSession(live) === 'tok_acct3';
    })());

    t('the busy account is ranked behind idle ones for the NEXT session', (() => {
        accounts.update(a3.id, { cooldownUntil: 0, health: accounts.HEALTH.OK });
        accounts.update(a1.id, { cooldownUntil: 0, health: accounts.HEALTH.OK });
        const busy = deployer.busyAccountIds();
        const { account } = allocator.claim({ busyIds: busy });
        if (account) allocator.release(account.id);
        return busy.includes(a3.id) && account && account.id !== a3.id;
    })());

    // ── an account with no capacity anywhere reports the real reason ────────────────
    reset();
    addAccount('only');
    stubWorld({ behaviour: { only: 'dies' }, seen: new Set() });
    let soloErr = null;
    try { await deployer.createSession({ onLog: () => {} }); } catch (e) { soloErr = e; }
    t('a single spent account fails with a message about the allowance, not a generic error',
        !!soloErr && /سهم|تمام/.test(soloErr.message), soloErr && soloErr.message);
    t('a single spent account is left marked exhausted for the UI to explain',
        accounts.list()[0].health === accounts.HEALTH.EXHAUSTED);

    // ── shared infrastructure failure must not burn the pool ────────────────────────
    reset();
    const b1 = addAccount('b1');
    const b2 = addAccount('b2');
    const brokerSeen = new Set();
    stubWorld({ behaviour: { b1: 'ok', b2: 'ok' }, seen: brokerSeen });
    const realFetch = global.fetch;
    global.fetch = async (url, opts) => {
        if (String(url).startsWith('https://relay.test')) {
            return new Response(JSON.stringify({ error: 'nope', code: 'X' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        return realFetch(url, opts);
    };
    let brokerErr = null;
    try { await deployer.createSession({ onLog: () => {} }); } catch (e) { brokerErr = e; }
    t('a broker outage fails without condemning any account',
        !!brokerErr
        && accounts.get(b1.id).health !== accounts.HEALTH.EXHAUSTED
        && accounts.get(b2.id).health !== accounts.HEALTH.EXHAUSTED,
        `${accounts.get(b1.id).health}/${accounts.get(b2.id).health}`);
    t('a broker outage does not stampede through every account',
        brokerSeen.size <= 1, `touched ${[...brokerSeen].join(',')}`);

    // ── report ──────────────────────────────────────────────────────────────────────
    let failed = 0;
    for (const r of results) {
        if (!r.pass) failed++;
        console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass || !r.detail ? '' : `   -> ${r.detail}`}`);
    }
    console.log(`\n${results.length - failed}/${results.length} passed`);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
})().catch(e => { console.error('SUITE CRASHED:', e); process.exit(1); });
