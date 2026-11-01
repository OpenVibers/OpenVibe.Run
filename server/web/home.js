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
const seo = require('openvibe-shared/seo');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const appIcon = require('openvibe-shared/app-icon');
const ovServe = require('openvibe-shared/serve');

const SITE_NAME = 'OpenVibe.Run';
// The questions the catalog answers for Run (openvibe-contracts manifests/services/run.json, kept word for word): shown
// on the home and given to search engines as FAQPage data.
const FAQ = ((require('openvibe-contracts/manifests/services/run.json').site || {}).faq || [])
    .filter((f) => f && f.question && f.answer).map((f) => ({ q: String(f.question).trim(), a: String(f.answer).trim() }));
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NETWORK_URL = 'https://openvibe.network';
const DESCRIPTION = 'Run jobs on your own machine or on a node that can: one API and a project token; Run places the job, streams '
    + 'its output and meters it per second.';

const HOME_CSP = [
    "default-src 'self'",
    // The Frame's theme-loader, navbar and footer are served from /shared; the inline boot is the shell's.
    "script-src 'self' 'unsafe-inline' https://openvibe.network https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline' https://openvibe.network https://fonts.googleapis.com https://cdnjs.cloudflare.com",
    "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
    "img-src 'self' data: https:",
    // The navbar asks the Network for the session, menus and notifications.
    "connect-src 'self' https://openvibe.network https://openvibe.events https://cloudflareinsights.com",
    "frame-src 'self' https://openvibe.network",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' https://openvibe.network",
].join('; ');

// The questions' cards, in the kit's tokens (the home has no stylesheet of its own).
const FAQ_CSS = '<style>.run-faq{border:1px solid var(--border,#1f2d47);border-radius:10px;padding:4px 16px;margin:8px 0;background:var(--bg-card,#131c2e)}'
    + '.run-faq[open]{padding-bottom:12px}.run-faq summary{cursor:pointer;font-weight:600;padding:8px 0}'
    + '.run-faq p{margin:4px 0 0;color:var(--text-secondary,#96a7c2)}'
    + '@media (pointer: coarse){.run-faq summary{min-height:44px;box-sizing:border-box}}</style>';

const code = (s) => `<code>${s.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</code>`;

// The samples run as written: the first declares the artifact the other two submit, on the person's own paired machine
// (the OpenVibe Node runs only what its owner declared: OpenVibe.Node docs/worker.md).
const MACHINE_EXAMPLE = `# On your paired machine (installed with --worker): a function is a command you declare.
# Its args arrive as one line of JSON on stdin, its stdout streams back, and fd 3 is its result.
sudo mkdir -p /opt/fn/hello && sudo tee /opt/fn/hello/run > /dev/null <<'EOF'
#!/bin/sh
read -r args
echo "hello from job $OPENVIBE_JOB_ID: $args"
printf '{"ok":true}' >&3
EOF
sudo chmod 755 /opt/fn/hello/run
# Add it to "worker" → "functions" in /etc/openvibe-node/config.json, then: sudo systemctl restart openvibe-node
#   {"name": "hello", "version": "1.0.0", "command": ["/opt/fn/hello/run"]}`;

const SUBMIT_EXAMPLE = `curl -X POST https://openvibe.run/api/v1/jobs \\
  -H "Authorization: Bearer $PROJECT_TOKEN" -H "Content-Type: application/json" \\
  -d '{"class":"function","artifact":{"name":"hello","version":"1.0.0"},"args":{"name":"world"},
       "limits":{"wall_ms":30000,"cpu_ms":30000,"mem_bytes":268435456},"ttl_ms":600000}'`;

function renderHome({ config }) {
    const nav = {
        service: 'run',
        apiBase: NETWORK_URL,
        links: [{ label: 'Your machine', href: '#machine' }, { label: 'How it works', href: '#how' }, { label: 'API', href: '#api' }],
        history: { type: 'page', title: SITE_NAME },
    };
    return shell.page({
        name: SITE_NAME, service: 'run', lang: 'en',
        title: `${SITE_NAME}: run jobs on your own machine`,
        jsonLd: [seo.jsonLd.website({ name: SITE_NAME, url: `${config.baseUrl}/`, description: DESCRIPTION }), seo.jsonLd.organization(), ...(FAQ.length ? [{ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : [])],
        siteName: SITE_NAME, description: DESCRIPTION, summary: DESCRIPTION,
        canonical: `${config.baseUrl}/`, robots: 'index, follow',
        agentLayer: true, llms: `${config.baseUrl}/llms.txt`,
        navbar: nav, footer: FOOTER, home: '/',
        navLinks: nav.links,
        head: [appIcon.headTags({ site: 'run' }), '<link rel="manifest" href="/manifest.webmanifest">', `<link rel="apple-touch-icon" href="${require('openvibe-shared/app-icons').url('run', 192)}">`, `<link rel="stylesheet" href="${ovServe.url(showcase.STYLESHEET)}">`, FAQ_CSS].join('\n'),
        body: `<div id="navbar-mount"></div>\n<main id="main">${body()}</main>`,
    });
}

const FOOTER = { service: 'run', variant: 'full', mount: '#ov-footer', brandName: SITE_NAME, updates: '/updates' };

// The page's type: shell.page sets no font and showcase.css styles only its own sections, so without these rules
// /updates fell back to the browser's Times New Roman (domain sweep, 2026-11-01). Zero specificity: any site rule wins.
const UPDATES_FONT = "<style>:where(body){font-family:var(--ov-font,'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif)}:where(main.page){display:block;max-width:880px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-right,0px)) 56px max(16px,env(safe-area-inset-left,0px))}:where(.ov-updates h1){font-size:clamp(1.6rem,5.4vw,2.2rem);line-height:1.15;margin:0 0 10px;text-wrap:balance}</style>";

/** /updates: what shipped on this site, the network's shared update log (openvibe-shared/frame updatesBody). */
function renderUpdates({ config }) {
    const links = [{ label: 'How it works', href: '/#how' }, { label: 'API', href: '/#api' }];
    return shell.page({
        name: SITE_NAME, service: 'run', lang: 'en',
        title: `What shipped on ${SITE_NAME}`,
        siteName: SITE_NAME, description: `Every change deployed to ${SITE_NAME}, newest first.`,
        canonical: `${config.baseUrl}/updates`, robots: 'index, follow',
        agentLayer: true, llms: `${config.baseUrl}/llms.txt`,
        navbar: { service: 'run', apiBase: NETWORK_URL, links, history: { type: 'page', title: SITE_NAME } },
        footer: FOOTER, home: '/', navLinks: links,
        head: [appIcon.headTags({ site: 'run' }), '<link rel="manifest" href="/manifest.webmanifest">', `<link rel="apple-touch-icon" href="${require('openvibe-shared/app-icons').url('run', 192)}">`, UPDATES_FONT].join('\n'),
        body: `<div id="navbar-mount"></div>\n<main id="main" class="page">\n${frame.updatesBody({ service: 'run', siteName: SITE_NAME })}\n</main>\n<script src="${ovServe.url('shipped.js')}" defer></script>`,
    });
}

/** The page a browser gets for a path nothing serves: the site's own Frame, one way back, and no clue about what was asked for. */
function renderNotFound({ config }) {
    const host = String(config.baseUrl).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const links = [{ label: 'How it works', href: '/#how' }, { label: 'API', href: '/#api' }];
    return shell.page({
        name: SITE_NAME, service: 'run', lang: 'en',
        title: `Page not found · ${SITE_NAME}`,
        siteName: SITE_NAME, description: `There is no page at this address on ${host}.`,
        robots: 'noindex, follow',
        navbar: { service: 'run', apiBase: NETWORK_URL, links, history: { type: 'page', title: SITE_NAME } },
        footer: FOOTER, home: '/', navLinks: links,
        head: [appIcon.headTags({ site: 'run' }), '<link rel="manifest" href="/manifest.webmanifest">',
            `<link rel="apple-touch-icon" href="${require('openvibe-shared/app-icons').url('run', 192)}">`,
            `<link rel="stylesheet" href="${ovServe.url(showcase.STYLESHEET)}">`, UPDATES_FONT].join('\n'),
        body: `<div id="navbar-mount"></div>
<main id="main" class="page">
<h1>Page not found</h1>
<p>There is no page at this address on ${esc(host)}. The link may be old or mistyped.</p>
<div class="sc-actions">
<a class="sc-btn sc-primary" href="/">${SITE_NAME} home</a>
<a class="sc-btn" href="/#how">How it works</a>
<a class="sc-btn" href="/#api">API</a>
</div>
</main>`,
    });
}

const SDK_EXAMPLE = `const { createClient } = require('openvibe-sdk/core');
const { createRunClient } = require('openvibe-sdk/run');

const run = createRunClient(createClient({ tokenProvider: tokens })).forProject('prj_…');
const { job } = await run.jobs.submit({
    class: 'function', artifact: { name: 'hello', version: '1.0.0' }, args: { name: 'world' },
    limits: { wall_ms: 30000, cpu_ms: 30000, mem_bytes: 268435456 }, ttl_ms: 600000,
});
for await (const ev of run.jobs.events(job.id)) console.log(ev.type, ev.data);   // state changes and output, until it ends`;

function body() {
    return showcase.hero({
        eyebrow: 'OpenVibe.Run · part of OpenVibe Services · alpha',
        title: 'Run jobs on your own machine,',
        // The hero's picture is this site's own (2026-11-01): it drew the generic aura, the same on six homes.
        // How a job runs, around the node: pair, submit, sandbox, stream, meter.
        orbit: {
            label: 'How a job runs',
            center: { title: 'Your node', sub: 'runs the job' },
            inner: [
                { icon: 'ov:plug', label: 'Pair', href: 'https://openvibe.bot/machines' },
                { icon: 'ov:code', label: 'Submit', href: '#api' },
                { icon: 'ov:shield', label: 'Sandbox', href: '#how' },
                { icon: 'ov:history', label: 'Stream', href: '#how' },
                { icon: 'ov:gauge', label: 'Meter', href: '#how' },
            ],
            outer: [
                { icon: 'ov:codes', label: 'Codes', href: 'https://openvibe.codes/' },
                { icon: 'ov:bot', label: 'Bot', href: 'https://openvibe.bot/' },
                { icon: 'ov:services', label: 'Services', href: 'https://openvibe.services/' },
                { icon: 'ov:ai', label: 'AI', href: 'https://ai.openvibe.services/' },
                { icon: 'ov:network', label: 'Network', href: 'https://openvibe.network/' },
            ],
        },
        accent: 'or on a node that can.',
        lede: 'Pair a computer once and the jobs you start run there, on your hardware, with their output streamed back to you. '
            + 'Or send a job to one API with your project\'s token: Run picks a node that offers the runtime it asks for and meters it per second.',
        actions: [{ label: 'Pair your machine', href: 'https://openvibe.bot/machines', primary: true }, { label: 'Try it from OpenVibe.Codes', href: 'https://openvibe.codes/run' }, { label: 'The API', href: '#api' }],
        note: 'Alpha. A job runs on nodes paired with OpenVibe (the OpenVibe Node); with none online for its class it waits, then expires.',
    }) + showcase.steps({
        id: 'machine',
        title: 'Your machine, your jobs',
        lede: 'A computer you pair runs only the jobs you start: placement matches its owner before anything else.',
        items: [
            { title: 'Pair it', href: 'https://openvibe.bot/machines', text: 'On openvibe.bot/machines, copy the one-line install command and run it on the computer. It joins as a worker under your account.' },
            { title: 'Start a job', href: 'https://openvibe.codes/run', text: 'OpenVibe.Codes\' "Run on your machine" sends a coding task there, or your own code submits one through the API.' },
            { title: 'Watch it run', text: 'The job\'s event stream shows each state change and the machine\'s output as it is written.' },
            { title: 'Keep the record', text: 'Every job ends succeeded, failed, cancelled or expired, with its timings, its exit and the seconds it ran.' },
        ],
    }) + '<section class="sc-sec sc-part-of"><p class="sc-note">Part of <a href="https://openvibe.services/">OpenVibe Services</a>: the building blocks every OpenVibe product runs on, with one console, one account and one SDK.</p></section>' + showcase.steps({
        id: 'how',
        title: 'How a job runs',
        items: [
            { title: 'Submit', text: 'POST the job to /api/v1/jobs with a project token holding run.job.submit: which artifact to run, its input and its limits. Run checks it against the job contract, stores it queued and answers at once.' },
            { title: 'Place', text: 'Run reads the network\'s node offers for the job\'s class and chooses one its requirements allow. With no eligible node it waits, retrying every second, until its time to live runs out.' },
            { title: 'Run', text: 'OpenVibe.Bot sends the job to the node over its device link and meters every wall-clock second it runs. The node\'s output comes back as it is written.' },
            { title: 'End', text: 'Succeeded, failed, cancelled or expired. An end state never changes, and the job, its timings, its exit and its metered seconds stay readable to the project.' },
        ],
    }) + showcase.compare({
        title: 'Runtime classes',
        lede: 'A job names the class of machine it needs. What each one is today:',
        columns: ['What runs', 'Today'],
        rows: [
            { label: 'function', values: ['A registered artifact on a paired OpenVibe Node', 'Works'] },
            { label: 'code', values: ['An OpenVibe.Codes task on your own machine', 'Works'] },
            { label: 'browser', values: ['A page in a managed browser', 'Built, not switched on yet'] },
            { label: 'linux, desktop, gpu', values: ['Reserved names for the machines they say', 'Not yet'] },
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
    }) + showcase.code({
        id: 'api',
        title: 'The API',
        lede: 'Jobs are created with a project token from OpenVibe.Services (run.job.submit; reading, listing, cancelling and streaming take run.job.read, run.job.list, run.job.cancel and run.job.stream). A job names its runtime class, an artifact a machine declares (a name and one exact version: the first sample declares the one the other two run), its input and its limits.',
        samples: [{ label: 'Your machine', lang: 'bash', code: MACHINE_EXAMPLE }, { label: 'Node (openvibe-sdk)', lang: 'js', code: SDK_EXAMPLE },
            { label: 'curl', lang: 'bash', code: SUBMIT_EXAMPLE }],
    }) + showcase.features({
        title: 'The job routes',
        items: [
            { title: 'GET /api/v1/jobs/:id', text: 'State, node, timings, exit and metered seconds.' },
            { title: 'GET /api/v1/jobs', text: 'The project\'s jobs, newest first.' },
            { title: 'POST /api/v1/jobs/:id/cancel', text: 'Stops it; an ended job stays ended.' },
            { title: 'POST /api/v1/jobs/:id/stream/ticket', text: 'Then GET /api/v1/jobs/:id/stream?ticket=…: its events and output as server-sent events (a service may send its own token instead).' },
        ],
    }) + (FAQ.length ? `<section class="sc-sec" id="questions" aria-labelledby="run-faq-h"><h2 id="run-faq-h">Questions</h2>${FAQ.map((f) => `<details class="run-faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>` : '')
    + showcase.cta({
        title: 'Open source',
        text: 'Run is AGPL-3.0, and so is the OpenVibe Node that turns a computer into a worker.',
        actions: [{ label: 'OpenVibers/OpenVibe.Run', href: 'https://github.com/OpenVibers/OpenVibe.Run' }, { label: 'The OpenVibe Node', href: 'https://github.com/OpenVibers/OpenVibe.Node' }],
    });
}

module.exports = { renderHome, renderUpdates, renderNotFound, HOME_CSP, SITE_NAME, DESCRIPTION, FAQ };
