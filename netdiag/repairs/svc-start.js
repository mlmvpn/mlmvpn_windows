/*
 * svc.start-* — SCOPE: start ONE whitelisted service. Never change its StartType.
 *
 * The whitelist is the security control. A repair that took a service name from anywhere but
 * this file would be a privileged "start arbitrary service" primitive reachable from an
 * unauthenticated localhost endpoint, and no amount of escaping fixes that — which is why the
 * repair API carries no parameters at all and the name is compiled in.
 *
 * The StartType rule is the safety control. A service set to Disabled is somebody's deliberate
 * action or malware damage; either way, flipping it is a machine-scope change with a story
 * behind it, and the honest response is to report the state rather than silently override it.
 * `Start-Service` on a Disabled service fails, and that failure is the finding.
 */

'use strict';

const ps = require('../ps');
const F = require('../facts');
const { IDS } = require('../rules/ids');

/** Compiled in. There is no path by which a caller can extend this. */
const SERVICES = [
    {
        id: 'svc.start-bfe', name: 'BFE',
        label: 'راه‌اندازی سرویس فیلترینگ پایه (BFE)',
        hint: 'بدون این سرویس ویندوز جلوی همهٔ ترافیک را می‌گیرد.',
        runningFact: IDS.SVC_BFE_RUNNING,
        forHypotheses: ['svc.bfe-stopped'],
        // BFE underpins the whole filtering platform, so starting it changes everything at once.
        expectedChanges: ['reach.*', 'probe.*', 'dns.*', 'proxy.http.*'],
    },
    {
        id: 'svc.start-dnscache', name: 'Dnscache',
        label: 'راه‌اندازی سرویس DNS Client',
        hint: 'بدون این سرویس هیچ نامی ترجمه نمی‌شود.',
        runningFact: IDS.SVC_DNSCACHE_RUNNING,
        forHypotheses: ['svc.dnscache-stopped'],
        expectedChanges: ['dns.resolve.*', 'dns.answer.*'],
    },
];

module.exports = SERVICES.map(svc => ({
    id: svc.id,
    label: svc.label,
    hint: svc.hint,
    forHypotheses: svc.forHypotheses,

    privilege: 'admin',
    blastRadius: 'machine',
    disruptive: false,
    reversible: true,
    requiresReboot: false,
    exposure: 'none',
    subsystem: 'service',
    expectedChanges: svc.expectedChanges,

    target: () => ({ kind: 'service', name: svc.name }),

    preconditions(facts) {
        const running = F.valueOf(facts, svc.runningFact);
        if (running === true) return { ok: false, reason: `سرویس ${svc.name} از قبل در حال اجراست` };
        if (running === undefined) return { ok: false, reason: `وضعیت سرویس ${svc.name} خوانده نشد` };
        return { ok: true };
    },

    async capture(facts, deps) {
        const run = (deps && deps.ps) || ps;
        const r = await run.run(
            `$s = Get-Service -Name '${svc.name}' -ErrorAction SilentlyContinue
if ($s) { @{ status = $s.Status.ToString(); start = $s.StartType.ToString() } | ConvertTo-Json -Compress } else { '{}' }`,
            { timeout: 6000 });
        const j = run.parseJson(r.stdout);
        const v = (j.ok && j.value[0]) || {};
        return {
            status: typeof v.status === 'string' ? v.status : 'unknown',
            startType: typeof v.start === 'string' ? v.start : 'unknown',
        };
    },

    async apply(ctx) {
        const run = (ctx.deps && ctx.deps.ps) || ps;
        if (ctx.pre && ctx.pre.startType === 'Disabled') {
            // Reported, not overridden. Enabling it is a separate decision with a separate
            // conversation, and doing it here would undo somebody's deliberate configuration
            // inside a repair whose label says only "start the service".
            return {
                ok: false,
                reason: `سرویس ${svc.name} روی Disabled تنظیم شده است. این معمولاً یک تصمیم عمدی یا اثر یک بدافزار است و این ابزار خودش آن را تغییر نمی‌دهد.`,
            };
        }
        const r = await run.run(`Start-Service -Name '${svc.name}' -ErrorAction Stop; 'done'`, { timeout: 20000 });
        return { ok: r.ok && /done/.test(r.stdout || ''), reason: r.reason, log: (r.stdout || '').trim() };
    },

    async rollback(pre, deps) {
        // Only if it really was stopped before. Stopping BFE takes the machine offline, so the
        // guard against "roll back into a blackout" matters more than tidiness.
        if (pre.status !== 'Stopped') return { ok: true, reason: 'service was not stopped before; nothing to undo' };
        const run = (deps && deps.ps) || ps;
        const r = await run.run(`Stop-Service -Name '${svc.name}' -Force -ErrorAction Stop; 'done'`, { timeout: 20000 });
        return { ok: r.ok, reason: r.reason };
    },

    // Condition-based, not a sleep: a service takes an unpredictable moment to report Running,
    // and verifying too early is how a working repair gets reported as failed.
    settle: {
        maxMs: 8000,
        async condition(deps) {
            const run = (deps && deps.ps) || ps;
            const r = await run.run(`(Get-Service -Name '${svc.name}' -ErrorAction SilentlyContinue).Status`, { timeout: 4000 });
            return /Running/i.test(r.stdout || '');
        },
    },

    verifyWith: ['w0.inventory'],
}));
