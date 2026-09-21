// --- VodiWalker feature facade («کانفیگ آیپی ثابت») ---
// Automated VodiWalker panel deployment to the user's own Railway account, plus full
// user/config management of that server — all from inside the app.
//
// Wire-up is one line in server.js:
//     require('./vodi/routes')(app, { broadcastLog });
//
// Modules:
//   vodi-config.js            gateway store (~/.mlmvpn/vodi-gateways.json)
//   vodi-deployer-railway.js  Railway deploy + gateway API proxy
//   routes.js                 /api/vodi/* HTTP routes

module.exports = {
    store: require('./vodi-config'),
    deployer: require('./vodi-deployer-railway'),
    registerRoutes: require('./routes'),
};
