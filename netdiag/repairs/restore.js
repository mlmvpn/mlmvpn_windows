/*
 * The recovery restorer.
 *
 * Puts back the pre-state recorded in a journal entry, by routing to the repair's OWN
 * `rollback()`. There is deliberately no separate restore implementation: a second one would
 * drift from the first, and the drift would be permanent machine state written by an elevated
 * process at startup with nobody watching.
 *
 * The pre-state reaching here has already been schema-validated and range-checked by the
 * journal, so `rollback()` receives typed values from a known shape — the property that makes
 * a tampered journal inert rather than dangerous.
 */

'use strict';

const registry = require('./index');

module.exports = async function restore(entry) {
    const repair = registry.byId.get(entry && entry.repairId);
    if (!repair) return { ok: false, reason: `no repair named ${entry && entry.repairId}` };
    if (typeof repair.rollback !== 'function') {
        return { ok: false, reason: `${repair.id} has no rollback path` };
    }
    try {
        const r = await repair.rollback(entry.preState, {});
        return { ok: !!(r && r.ok), reason: r && r.reason };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
};
