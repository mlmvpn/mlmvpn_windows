/*
 * The hypothesis registry.
 *
 * Order here is irrelevant to the outcome — that is the point. The first design ranked causes
 * by their position in a list, which is how a stale hosts entry got reported as the reason
 * nothing opened while a dead system proxy sat below it. Ranking comes from evidence and from
 * the causes graph, so this file is an inventory, not a priority list.
 *
 * Registering a new family: add the file, add it here, and add its ids to ./ids.js. A test
 * asserts that every fact id any rule references exists in that catalog, so a typo shows up
 * as a failing test rather than as a gate that is silently UNKNOWN forever.
 */

'use strict';

const registry = [].concat(
    require('./proxy'),
    require('./dns'),
    require('./vpn'),
    require('./system'),
);

const byId = new Map(registry.map(h => [h.id, h]));
if (byId.size !== registry.length) {
    const seen = new Set();
    const dupes = registry.map(h => h.id).filter(id => (seen.has(id) ? true : (seen.add(id), false)));
    throw new Error(`duplicate hypothesis id(s): ${[...new Set(dupes)].join(', ')}`);
}

module.exports = registry;
module.exports.byId = byId;
