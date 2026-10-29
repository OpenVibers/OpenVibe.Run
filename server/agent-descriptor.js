'use strict';
// What openvibe.run tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this site really serves: the job API behind the SPA-less pages, and the project
// service tokens it verifies. It publishes no documentation page (the README on GitHub is the reference), so
// `docs` is omitted rather than invented.
module.exports = {
    id: 'run',
    name: 'OpenVibe.Run',
    purpose: 'Run jobs on your own machine or on a node that can: one API and a project token; Run places the job, streams its output and meters it per second.',
    home: 'https://openvibe.run',
    site: 'openvibe.run',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network service token (Bearer, per project)'],
    },
};
