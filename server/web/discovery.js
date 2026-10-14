'use strict';
/**
 * What openvibe.run tells crawlers about itself: /llms.txt and /llms-full.txt (openvibe-shared/seo) and the
 * IndexNow notifier. Only the public pages are listed — never the API, the admin routes, a job or its stream.
 */
const seo = require('openvibe-shared/seo');
const home = require('./home');

const MAX_BYTES = 512 * 1024;
const REPO = 'https://github.com/OpenVibers/OpenVibe.Run';
const NODE_REPO = 'https://github.com/OpenVibers/OpenVibe.Node';

// The public pages, in the order the sitemap lists them.
const PAGES = ['/', '/terms', '/privacy', '/dmca'];

function sections(base) {
    return [
        { title: 'Pages', links: [
            { title: 'OpenVibe.Run', url: `${base}/`, note: 'what a job is, how it runs, and the API in brief' },
            { title: 'Terms', url: `${base}/terms` },
            { title: 'Privacy', url: `${base}/privacy` },
            { title: 'DMCA', url: `${base}/dmca` },
        ] },
        { title: 'Docs', links: [
            { title: 'OpenVibe.Run on GitHub', url: REPO, note: 'the source and the README: the job API, its states and its capabilities' },
            { title: 'OpenVibe Node', url: NODE_REPO, note: 'pair your own machine to run jobs' },
        ] },
    ];
}

function llmsTxt(config) {
    return seo.llmsTxt({ name: home.SITE_NAME, summary: home.DESCRIPTION, sections: sections(config.baseUrl) });
}

function llmsFull(config) {
    const page = home.renderHome({ config });
    const main = /<main id="main">([\s\S]*)<\/main>/.exec(page);
    return seo.llmsFull({
        site: home.SITE_NAME,
        summary: home.DESCRIPTION,
        base: config.baseUrl,
        maxBytes: MAX_BYTES,
        sections: [{ title: 'Pages', pages: [{ title: home.SITE_NAME, url: '/', html: main ? main[1] : '' }] }],
    });
}

/**
 * Tells search engines the public pages changed (once at boot; a deploy is what changes them). Sends only
 * when IndexNow is enabled, i.e. INDEXNOW_KEY is set; returns whether anything was queued. Never throws.
 */
function notify(indexnow, config) {
    try {
        if (!indexnow || !indexnow.enabled) return false;
        return indexnow.pingSoon([...PAGES, '/llms.txt', '/sitemap.xml'].map((p) => `${config.baseUrl}${p}`)) > 0;
    } catch (err) {
        console.warn('[IndexNow] notify failed:', err.message);
        return false;
    }
}

module.exports = { llmsTxt, llmsFull, notify, sections, MAX_BYTES, PAGES };
