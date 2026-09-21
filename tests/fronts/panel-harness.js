'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

module.exports = function panelHarness(fetch) {
    const parts = {};
    for (const name of ['head', 'line', 'power', 'glyph', 'extra', 'live']) {
        const attrs = {};
        parts[name] = { innerHTML: '', className: '', disabled: false,
            setAttribute: (k, v) => { attrs[k] = String(v); }, getAttribute: k => attrs[k] };
    }
    const stage = { dataset: { built: '1' }, querySelector: selector => parts[selector.match(/"(.*?)"/)[1]] };
    const document = { getElementById: id => id === 'psiphon-stage' ? stage : null };
    const window = {};
    const source = fs.readFileSync(path.join(__dirname, '../../public/components/fronts.js'), 'utf8');
    // Expose the existing closure for tests; production carries no test hooks.
    const exposed = source.replace(/\}\)\(\);\s*$/, 'window.panel = { st, state, toggle, setCoverage, renderStage, refresh }; })();');
    vm.runInNewContext(exposed, { window, document, fetch, console, setTimeout, clearTimeout, setInterval, clearInterval });
    const api = window.panel;
    api.st.psiphon.payload = { installed: true, status: { running: true, connected: true }, tun: true };
    return { ...api, parts };
};
