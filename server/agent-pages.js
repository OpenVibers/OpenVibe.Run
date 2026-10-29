'use strict';
// The Markdown twins of openvibe.run's public pages (openvibe-shared/agent-layer), rendered by the same page
// builders the routes use (server/web/home.js), so a twin cannot drift from its page. Anonymous only: this site
// has no signed-in views. The legal pages are served by openvibe-shared/legal, which has no page builder to
// render signed out, so they are not twinned.
const home = require('./web/home');

function createAgentPages({ config }) {
    async function renderPublicPage(path) {
        if (path === '/') return { html: home.renderHome({ config }) };
        if (path === '/updates') return { html: home.renderUpdates({ config }) };
        return null;
    }

    return { renderPublicPage };
}

module.exports = { createAgentPages };
