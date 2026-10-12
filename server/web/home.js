'use strict';

/**
 * The front page of openvibe.run (GET /): the OpenVibe Frame (openvibe-shared/shell: navbar, footer, theme) around
 * openvibe-shared/showcase sections. The copy says only what works today (README "How a job runs"): submit a job to
 * the API with a project's token, Run places it from the Fabric's node offers, OpenVibe.Bot sends it to the node and
 * meters it per second, the output streams back, and the job ends in one terminal state.
 *
 *   renderHome({ config })   the whole document
 *   HOME_CSP                 its Content-Security-Policy (the Frame's scripts and calls to the Network)
 */
const shell = require('openvibe-shared/shell');
const showcase = require('openvibe-shared/showcase');
const appIcon = require('openvibe-shared/app-icon');
const ovServe = require('openvibe-shared/serve');

const SITE_NAME = 'OpenVibe.Run';
const NETWORK_URL = 'https://openvibe.network';
const DESCRIPTION = 'Run a job on a node that can: submit it to one API with your project\'s token, and Run places it on a node '
    + 'that offers its runtime, streams its output and meters it per second.';

const HOME_CSP = [
    "default-src 'self'",
    // The Frame's theme-loader, navbar and footer are served from /shared; the inline boot is the shell's.
    "script-src 'self' 'unsafe-inline' https://openvibe.network",
    "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    // The navbar asks the Network for the session, menus and notifications.
    "connect-src 'self' https://openvibe.network https://openvibe.events",
    "frame-src 'self' https://openvibe.network",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://openvibe.network",
].join('; ');

const code = (s) => `<code>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`;

const SUBMIT_EXAMPLE = `curl -X POST https://openvibe.run/api/v1/jobs \\
  -H "Authorization: Bearer $PROJECT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"class":"function","artifact":{"name":"thumbnail","version":"1.2.0"},"args":{"width":320},
       "limits":{"wall_ms":30000,"cpu_ms":30000,"mem_bytes":268435456},"ttl_ms":600000}'`;

function renderHome({ config }) {
    const nav = {
        service: 'run',
        apiBase: NETWORK_URL,
        links: [{ label: 'How it works', href: '#how' }, { label: 'API', href: '#api' }],
        history: { type: 'page', title: SITE_NAME },
    };
    return shell.page({
        name: SITE_NAME, service: 'run', lang: 'en',
        title: `${SITE_NAME}: run a job on a node that can`,
        siteName: SITE_NAME, description: DESCRIPTION, summary: DESCRIPTION,
        canonical: `${config.baseUrl}/`, robots: 'index, follow',
        navbar: nav, footer: { service: 'run', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME }, home: '/',
        navLinks: nav.links,
        head: [appIcon.headTags({ site: 'run' }), '<link rel="manifest" href="/manifest.webmanifest">', `<link rel="stylesheet" href="${ovServe.url(showcase.STYLESHEET)}">`].join('\n'),
        body: `<div id="navbar-mount"></div>\n<main id="main">${body()}</main>`,
    });
}

function body() {
    return showcase.hero({
        eyebrow: 'OpenVibe.Run · jobs on nodes · alpha',
        title: 'Run a job.',
        accent: 'On a node that can.',
        lede: 'Send a job to one API with your project\'s token. Run picks a node that offers the runtime the job asks for, '
            + 'hands it over, streams its output back to you and settles it, metered per second it runs.',
        actions: [{ label: 'How it works', href: '#how', primary: true }, { label: 'The API', href: '#api' }],
        note: 'Alpha. A job runs on nodes paired with OpenVibe (the OpenVibe Node); with none online for its class it waits, then expires.',
    }) + showcase.steps({
        id: 'how',
        title: 'How a job runs',
        items: [
            { title: 'Submit', text: 'POST the job to /api/v1/jobs with a project token holding run.job.submit: which artifact to run, its input and its limits. Run checks it against the job contract, stores it queued and answers at once.' },
            { title: 'Place', text: 'Run reads the network\'s node offers for the job\'s class and chooses one its requirements allow. With no eligible node it waits, retrying every second, until its time to live runs out.' },
            { title: 'Run', text: 'OpenVibe.Bot sends the job to the node over its device link and meters every wall-clock second it runs. The node\'s output comes back as it is written.' },
            { title: 'End', text: 'Succeeded, failed, cancelled or expired. An end state never changes, and the job, its timings, its exit and its metered seconds stay readable to the project.' },
        ],
    }) + showcase.features({
        title: 'What you get',
        items: [
            { icon: 'ov:code', title: 'One API', text: 'Submit, read, list, cancel and stream jobs over HTTP, with RFC 9457 problems for every refusal.' },
            { icon: 'ov:account', title: 'Your project\'s jobs only', text: 'A job belongs to a project and is visible only to that project\'s token: never to another project, never by guessing an id.' },
            { icon: 'ov:live', title: 'Live output', text: 'A short-lived ticket opens the job\'s event stream: state changes and the node\'s stdout as they happen.' },
            { icon: 'ov:check', title: 'Placed, not guessed', text: 'Each placement records the node, the provider and the region it chose, from the offers its requirements allow.' },
            { icon: 'ov:history', title: 'Metered per second', text: 'The node link measures each job\'s wall clock; the reading is what the job is charged against, never an estimate.' },
            { icon: 'ov:error', title: 'Ends cleanly', text: 'Cancel a job, or let its time to live expire it. A node that disappears mid-run fails the job instead of leaving it running forever.' },
        ],
    }) + `<section class="sc-sec" id="api"><h2>The API</h2>
<p class="sc-lede">Jobs are created with a project token from ${'<a href="https://openvibe.services">OpenVibe.Services</a>'} (capability ${code('run.job.submit')}; reading, listing, cancelling and streaming take ${code('run.job.read')}, ${code('run.job.list')}, ${code('run.job.cancel')} and ${code('run.job.stream')}). A job names its runtime class, a pre-registered artifact (a name and one exact version), its input and its limits (wall clock, CPU time, memory):</p>
</section>${showcase.code({ title: 'Submit a job', samples: [{ label: 'curl', lang: 'bash', code: SUBMIT_EXAMPLE }] })}<section class="sc-sec" aria-label="Job routes">
<ul class="facts">
<li>${code('GET /api/v1/jobs/:id')}: state, node, timings, exit and metered seconds.</li>
<li>${code('GET /api/v1/jobs')}: the project's jobs, newest first.</li>
<li>${code('POST /api/v1/jobs/:id/cancel')}: stops it; an ended job stays ended.</li>
<li>${code('POST /api/v1/jobs/:id/stream/ticket')} then ${code('GET /api/v1/jobs/:id/stream?ticket=…')}: its events and output as server-sent events (a service may send its own token instead).</li>
</ul>
<p>To run jobs on your own machine, pair it with the <a href="https://github.com/OpenVibers/OpenVibe.Node">OpenVibe Node</a>; it offers the runtimes it can run. The source is <a href="https://github.com/OpenVibers/OpenVibe.Run">OpenVibers/OpenVibe.Run</a> (AGPL-3.0).</p>
</section>`;
}

module.exports = { renderHome, HOME_CSP, SITE_NAME, DESCRIPTION };
