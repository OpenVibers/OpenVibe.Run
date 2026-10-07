'use strict';
/**
 * Boots Run against a Network stub on a random port with a migrated database of its own (helpers/db.js:
 * PGlite, or the containers with RUN_TEST_STORE=pg). Background jobs are off: tests drive the outbox and
 * the stream explicitly. The events relay is off too (EVENTS_URL unset), so run.job.* events are read
 * from run_events_outbox where they were enqueued — the transactional path, without a network.
 *
 *   t.call(method, path, { body, cap, sub, project, token, headers, key })   a service token for audience
 *                                                                            openvibe.run with `cap`
 *   t.sse(path, { headers })          an SSE client: .status, .events, .waitFor(pred), .waitForClose()
 *   t.outboxRows(type)                what the outbox holds (envelope.payload, newest last)
 *   t.mintTicket(jobId, ...)          open a stream as a browser would
 *
 * Every token is signed by the stub Network's own key, which the app's key provider loads (the JWKS
 * route) — the real verification path, never a bypass.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { serviceAuth, ids } = require('openvibe-contracts');
const { testDb } = require('./db');

function listen(server) {
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

/**
 * OpenVibe.Network's three routes Run uses: the JWKS the key provider loads, the tokens it verifies, and
 * the /oauth/token endpoint its own client credentials mint Run's outgoing service tokens from (the
 * dispatcher's token for audience openvibe.bot). tokenRequests counts the mint calls, so a test can see
 * that the client caches its token instead of fetching one per call.
 */
async function startNetwork() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
    const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const issuer = 'http://network.test';
    const tokenRequests = { n: 0, audiences: [], scopes: [] };
    const offers = [];   // what the registry publishes; a test replaces its contents (t.setOffers)
    const server = http.createServer((req, res) => {
        if (req.url === '/api/.well-known/jwks') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ keys: [{ kty: 'RSA', kid: 'n1', ...publicKey.export({ format: 'jwk' }) }], public_key: publicPem }));
        }
        // The public resource registry Run places from (server/dispatch/placement.js): the offers a test
        // publishes with t.setOffers(), filtered the way Network filters them.
        if (req.method === 'GET' && req.url.startsWith('/api/v1/offers')) {
            const query = new URL(req.url, 'http://network.test').searchParams;
            const kind = query.get('kind');
            const docs = kind ? offers.filter((o) => o.kind === kind) : offers;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ offers: docs, count: docs.length, generated_at: new Date().toISOString(), filters: kind ? { kind } : {} }));
        }
        if (req.method === 'POST' && req.url === '/oauth/token') {
            let body = '';
            req.on('data', (chunk) => { body += chunk; });
            req.on('end', () => {
                const form = new URLSearchParams(body);
                const audience = form.get('audience') || 'openvibe.run';
                const scope = form.get('scope') || '';
                if (form.get('grant_type') !== 'client_credentials' || !form.get('client_id') || !form.get('client_secret')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'invalid_client' }));
                }
                tokenRequests.n++;
                tokenRequests.audiences.push(audience);
                tokenRequests.scopes.push(scope);
                const now = Math.floor(Date.now() / 1000);
                const access_token = serviceAuth.signServiceToken({
                    iss: issuer, sub: 'svc:run', actor_type: 'service', aud: [audience],
                    cap: scope ? scope.split(/\s+/).filter(Boolean) : ['bot.job.dispatch'],
                    iat: now, exp: now + 300, jti: crypto.randomBytes(8).toString('hex'),
                }, privatePem);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ access_token, token_type: 'Bearer', expires_in: 300, scope }));
            });
            return undefined;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end('{}');
    });
    const url = await listen(server);
    return {
        url, issuer, publicPem, privatePem, tokenRequests, offers,
        /** Publish exactly these platform.resource-offer@1 documents (the array keeps its identity). */
        setOffers(list) { offers.splice(0, offers.length, ...list); },
        close: () => new Promise((r) => server.close(r)),
        /** A Network service token (identity.service-token-claims@1). */
        signService({ sub = 'svc:live', aud = ['openvibe.run'], cap = ['run.*'], project_id, actor_type = 'service', expSec = 300, env: tokenEnv } = {}) {
            const now = Math.floor(Date.now() / 1000);
            return serviceAuth.signServiceToken({
                iss: issuer, sub, actor_type, aud, cap, iat: now, exp: now + expSec, jti: crypto.randomBytes(8).toString('hex'),
                ...(project_id ? { project_id } : {}), ...(tokenEnv ? { env: tokenEnv } : {}),
            }, privatePem);
        },
        /** A person's SSO token (a user token has no capability and names no project). */
        signUser({ subject = ids.newId('user'), username = 'ada', role = 'user' } = {}) {
            return jwt.sign({ sub: String(Date.parse('2026-01-01T00:00:00Z')), subject_id: subject, username, display_name: username, role }, privatePem, { algorithm: 'RS256', issuer, expiresIn: '1h' });
        },
    };
}

async function boot(opts = {}) {
    const network = await startNetwork();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-test-'));
    const env = {
        NODE_ENV: 'test',
        BASE_URL: 'http://run.test',
        OV_NETWORK_URL: network.url,
        OV_NETWORK_INTERNAL_URL: network.url,
        OV_NETWORK_ISSUER: network.issuer,
        OV_OAUTH_CLIENT_ID: 'run',
        OV_OAUTH_CLIENT_SECRET: '',
        RUN_JOBS: 'off',
        // No offers cache in tests: a check that changes the published offers (t.setOffers) must see them at once.
        RUN_OFFERS_TTL_MS: '0',
        RUN_STREAM_PRIVATE_KEY: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).replace(/\n/g, '\\n'),
        ...(opts.env || {}),
    };
    for (const k of Object.keys(require.cache)) if (k.includes(`${path.sep}server${path.sep}`)) delete require.cache[k];
    const { loadConfig } = require('../../server/config');
    const { createApp } = require('../../server/app');
    const config = loadConfig(env);
    const clock = { offset: 0 };
    const logs = [];
    const log = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) };
    const store = opts.db ? { db: opts.db, store: opts.db.store, close: async () => {} } : await testDb({ store: opts.store });
    const app = createApp({ config, db: store.db, valkey: opts.valkey || null, now: () => Date.now() + clock.offset, log, ...(opts.appOpts || {}) });
    await app.locals.keys.load();
    app.locals.tickets.start();
    const server = await new Promise((resolve) => {
        const s = http.createServer(app);
        s.listen(0, '127.0.0.1', () => resolve(s));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const { stream, outbox, tickets, events: runEvents, dispatch } = app.locals;

    let n = 0;
    async function call(method, p, { body, token, cap = ['run.*'], sub = 'svc:live', project, headers = {}, key } = {}) {
        const h = { ...headers };
        if (token !== null) h.Authorization = `Bearer ${token || network.signService({ cap, sub, ...(project ? { project_id: project } : {}) })}`;
        if (body !== undefined) h['Content-Type'] = 'application/json';
        // The Idempotency-Key header is sent only when the test names one (like a caller who means it).
        if (key != null && h['Idempotency-Key'] === undefined) h['Idempotency-Key'] = key;
        const res = await fetch(base + p, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, headers: res.headers, json, text };
    }

    /** The body of a valid run.job-create-request@1 (PROJECT is not part of it: the token names the project). */
    function request(over = {}) {
        return {
            class: 'function',
            artifact: { name: 'thumbnail', version: '1.2.0' },
            args: { width: 320 },
            limits: { wall_ms: 30_000, cpu_ms: 30_000, mem_bytes: 268_435_456 },
            ...over,
        };
    }

    /** Submit a job through the API (a service token for `project`). */
    async function submit(over = {}, opts2 = {}) {
        const r = await call('POST', '/api/v1/jobs', {
            body: request(over), project: opts2.project || ids.newId('project'), cap: opts2.cap || ['run.job.submit'], sub: opts2.sub || 'svc:builder', key: opts2.key,
        });
        if (r.status !== 201) throw new Error(`submit setup: ${r.status} ${r.text}`);
        return r.json.job;
    }

    const SOCKET_WAIT_MS = 20_000;

    /**
     * An SSE client (GET /jobs/:id/stream?ticket=). Non-2xx answers resolve with .status and .json and no
     * reader; a 200 carries .events and waitFor/waitForClose.
     */
    function sse(p, { headers = {}, ticket } = {}) {
        // No ticket at all (undefined) sends no query parameter: that is the case the API must refuse.
        const url = ticket === undefined ? `${base}${p}` : `${base}${p}${p.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(ticket)}`;
        return fetch(url, { headers })
            .then(async (res) => {
                const client = { status: res.status, events: [], ended: false, closeCode: null, waiters: [] };
                if (!res.ok) { client.text = await res.text(); try { client.json = JSON.parse(client.text); } catch { /* not json */ } return client; }
                client.res = res;
                const push = (e) => {
                    client.events.push(e);
                    client.waiters = client.waiters.filter((w) => (w.pred(e) ? (w.resolve(e), false) : true));
                };
                client.waitFor = (pred, ms = SOCKET_WAIT_MS) => new Promise((ok, fail) => {
                    const hit = client.events.find(pred);
                    if (hit) return ok(hit);
                    if (client.ended) return ok(null);
                    const w = { pred, resolve: ok };
                    client.waiters.push(w);
                    setTimeout(() => { client.waiters = client.waiters.filter((x) => x !== w); fail(new Error(`waitFor timed out; got ${JSON.stringify(client.events)}`)); }, ms).unref();
                });
                client.waitForClose = (ms = SOCKET_WAIT_MS) => new Promise((ok) => {
                    if (client.ended) return ok(true);
                    const t = setTimeout(() => ok(false), ms);
                    client.onEnd = () => { clearTimeout(t); ok(true); };
                });
                client.close = () => { try { if (client.reader) client.reader.cancel().catch(() => {}); } catch { /* already closed */ } };
                const reader = res.body.getReader();
                client.reader = reader;
                const decoder = new TextDecoder();
                let buf = '';
                (async () => {
                    try {
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            buf += decoder.decode(value, { stream: true });
                            let i;
                            while ((i = buf.indexOf('\n\n')) >= 0) {
                                const block = buf.slice(0, i); buf = buf.slice(i + 2);
                                const ev = { id: null, event: null, data: null };
                                for (const line of block.split('\n')) {
                                    if (line.startsWith('id: ')) ev.id = line.slice(4);
                                    else if (line.startsWith('event: ')) ev.event = line.slice(7);
                                    else if (line.startsWith('data: ')) { try { ev.data = JSON.parse(line.slice(6)); } catch { ev.data = line.slice(6); } }
                                }
                                if (ev.event) push(ev);
                            }
                        }
                    } catch { /* the client closed us */ }
                    client.ended = true;
                    client.waiters.forEach((w) => w.resolve(null));
                    client.waiters = [];
                    if (client.onEnd) client.onEnd();
                })();
                return client;
            });
    }

    /**
     * Mint a stream ticket through the API and open the stream with it, as a browser would. The project
     * the job belongs to is read from the row when the caller does not name it (the token names it in
     * production; a test usually has the job it just submitted).
     */
    async function openStream(jobId, { project, cap = ['run.job.stream'], headers = {} } = {}) {
        const owner = project || (await store.db.value('SELECT project_id FROM run_jobs WHERE id = $1', [jobId]));
        const t = await call('POST', `/api/v1/jobs/${jobId}/stream/ticket`, { cap, project: owner, headers });
        if (t.status !== 200) throw new Error(`ticket setup: ${t.status} ${t.text}`);
        return sse(`/api/v1/jobs/${jobId}/stream`, { ticket: t.json.ticket, headers });
    }

    /** What the outbox holds: every row, or the rows of one event type / one job. */
    const outboxRows = async (type, jobId) => (await store.db.many('SELECT event_id, envelope FROM run_events_outbox ORDER BY id'))
        .map((r) => ({ ...r.envelope, outbox_key: r.event_id }))
        .filter((e) => (!type || e.event_type === type) && (!jobId || e.payload.job_id === jobId));

    return {
        app, base, call, sse, openStream, submit, request, db: app.locals.db, store, config, clock, network, logs, dir, stream, outbox, tickets, runEvents, dispatch,
        // What the stub registry publishes for placement (server/dispatch/placement.js).
        setOffers: (list) => network.setOffers(list),
        outboxRows, streamState: (jobId) => stream.ringOf(jobId),
        wait: (ms) => new Promise((r) => setTimeout(r, ms)),
        close: async () => {
            stream.close();
            server.closeAllConnections();
            await new Promise((r) => server.close(r));
            await app.locals.outbox.stop();
            await network.close();
            await store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

let failures = 0;
async function check(name, fn) {
    try { await fn(); console.log('  ✓', name); }
    catch (e) { failures++; console.log('  ✗', name, '\n     ', (e.stack || String(e)).split('\n').slice(0, 8).join('\n      ')); }
}
function done() { console.log(failures ? `\n${failures} failed` : '\nall passed'); process.exit(failures ? 1 : 0); }

module.exports = { boot, check, done, startNetwork };
