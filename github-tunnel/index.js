// --- GitHub Tunnel feature facade ---
// A disposable Windows Cloud Session (GitHub Actions runner + Tailscale relay), wired up
// to feel like a native MLMVPN Connection Method — see public/components/github-tunnel.js.
//
// Wire-up is one line in server.js:
//     require('./github-tunnel/routes')(app, { broadcastLog });
//
// Modules:
//   gt-config.js             session store (~/.mlmvpn/github-tunnel.json)
//   gt-github.js              GitHub device-flow auth + repo/workflow/run automation
//   gt-broker.js              Tailscale ephemeral-key broker client (Cloudflare Worker)
//   gt-workflow-template.js   the Windows runner workflow YAML
//   gt-deployer.js            session state machine + orchestration
//   routes.js                 /api/github-tunnel/* HTTP routes

module.exports = {
    store: require('./gt-config'),
    github: require('./gt-github'),
    deployer: require('./gt-deployer'),
    brokerDeploy: require('./gt-broker-deploy'),
    registerRoutes: require('./routes'),
};
