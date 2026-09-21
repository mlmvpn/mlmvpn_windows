// --- Google Script Tunnel (تونل گوگل اسکریپت) ---
// Public face of the GST module. Nothing outside gst/ should reach past this file.
//
// Layout:
//   gst-log.js            Persian step logging into the shared core_log channel
//   gst-config.js         data/gst-relays.json — unlimited relays, per-relay CF switch
//   gst-core.js           core/gst.exe lifecycle + config.toml generation
//   gst-runtime.js        the three connection modes; system-proxy/TUN exclusion
//   gst-test.js           real probes of both legs (Apps Script and Worker)
//   gst-health.js         sweeps every relay, assembles the health-tab verdict
//   gst-repair.js         turns a failed probe into Persian advice + an action
//   gst-quota.js          daily budgets and the real reset times per provider
//   gst-cert.js           MITM CA generation, install, verification, removal
//   gst-deployer-cf.js    deploys public/gst/relay_worker.js to the user's Cloudflare
//   gst-script-builder.js builds the paste-ready Apps Script from public/gst/Code.gs
//   gst-google-reach.js   opens the road to script.google.com, silently
//   gst-scan.js           clean-IP and SNI scanning + auto-optimisation
//   gst-backup.js         encrypted gst:// export/import
//   routes.js             /api/gst/* wiring

module.exports = {
    store: require('./gst-config'),
    core: require('./gst-core'),
    runtime: require('./gst-runtime'),
    health: require('./gst-health'),
    log: require('./gst-log'),
    registerRoutes: require('./routes'),
};
