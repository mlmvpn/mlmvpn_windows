/*
 * The collector registry.
 *
 * Order within a wave is irrelevant — collectors in the same wave are independent by
 * definition, which is what lets the runner execute them together under a concurrency cap.
 * Order BETWEEN waves is the design: W0's facts are what the later waves' `when` predicates
 * reason about.
 *
 * Every collector declares `produces`, and the runner turns anything a collector promised but
 * did not deliver into an UNKNOWN fact with a reason. That backstop is why a collector may
 * simply return early on a state it cannot read: silence becomes "we could not observe this",
 * never "we observed that it is false".
 */

'use strict';

const registry = [].concat(
    require('./w0-inventory'),
    require('./w0-winsock'),
    require('./w1-link'),
    require('./w2-transport'),
    require('./w3-resolution'),
    require('./w4-session'),
    require('./w5-application'),
    require('./w5-mtu'),
);

const seen = new Set();
for (const c of registry) {
    if (seen.has(c.id)) throw new Error(`duplicate collector id: ${c.id}`);
    seen.add(c.id);
    if (!c.wave || !Array.isArray(c.produces) || typeof c.run !== 'function') {
        throw new Error(`collector ${c.id} is missing wave/produces/run`);
    }
}

module.exports = registry;
module.exports.byId = new Map(registry.map(c => [c.id, c]));
