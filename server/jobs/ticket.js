'use strict';

/**
 * The job stream ticket (run.job-stream-ticket-result@1; plan T14 R1).
 *
 * A browser cannot put a header on an EventSource, so it asks POST /api/v1/jobs/:id/stream/ticket
 * (capability run.job.stream) for a ticket and opens `${stream_url}?ticket=…` at once, resuming with
 * Last-Event-ID. The ticket is a two-minute RS256 compact JWS Run signs with a key of its own:
 *
 *   iss <BASE_URL>   aud openvibe.run   typ run-stream   purpose run-stream
 *   sub <job id>     project <project id>   exp now + 120 s   jti rsk_<24 hex>
 *
 * It is never a session anywhere: besides the signature it carries the audience openvibe.run AND the
 * typ/purpose claims, so a receiver that checks either refuses it, and Run itself refuses it on any route
 * but GET /api/v1/jobs/:id/stream. A ticket opens one stream (the jti is remembered while the ticket is
 * valid) and is never logged or stored.
 *
 * The key is Run's own, never Network's signing key: RUN_STREAM_PRIVATE_KEY (a PEM in the environment) or
 * the file RUN_STREAM_KEY_FILE (data/keys/run-stream.pem by default). In production, with neither set,
 * stream tickets answer 503 and every other route still serves — Run's jobs API never depends on it. In
 * development (and in tests) a key is generated in memory at boot.
 *
 * The used-jti set lives in this process's memory, as OpenVibe.Events' realtime tickets do: it covers the
 * ticket's own two minutes, a restart forgets it (and a ticket that old has expired), and Run runs one
 * process per host today. A second worker would need the set shared (Valkey) to keep "one ticket, one
 * stream" across processes — worth doing when Run is deployed behind more than one.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const JOB_RE = /^job_[0-9A-HJKMNP-TV-Z]{26}$/;
const PROJECT_RE = /^prj_[0-9A-HJKMNP-TV-Z]{26}$/;
const TYP = 'run-stream';
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const decode = (part) => { try { return JSON.parse(fromB64url(part).toString('utf8')); } catch { return null; } };

function createStreamTickets({ config, log = console, now = () => Date.now() }) {
    const ttlS = config.stream.ttlS;
    let privateKey = null;
    let ephemeral = false;
    // jti → exp (seconds). A ticket opens one stream; the map is pruned on every verification.
    const seen = new Map();

    /** Read Run's stream key (never Network's). Production with no key: null, and tickets answer 503. */
    function load() {
        if (config.stream.privateKey) {
            try { privateKey = crypto.createPrivateKey(config.stream.privateKey); return privateKey; }
            catch (e) { log.error(`[Run] RUN_STREAM_PRIVATE_KEY is not a usable private key: ${e.message}`); return null; }
        }
        const file = config.stream.keyFile && path.resolve(process.cwd(), config.stream.keyFile);
        if (file && fs.existsSync(file)) {
            try { privateKey = crypto.createPrivateKey(fs.readFileSync(file, 'utf8')); return privateKey; }
            catch (e) { log.error(`[Run] ${file} is not a usable private key: ${e.message}`); return null; }
        }
        if (config.isProduction) return null;
        privateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
        ephemeral = true;
        log.warn(`[Run] no RUN_STREAM_PRIVATE_KEY or ${config.stream.keyFile}: an ephemeral stream key is in memory (development only; every ticket stops verifying at a restart)`);
        return privateKey;
    }

    const get = () => privateKey;
    const status = () => ({ enabled: Boolean(privateKey), key_id: config.stream.keyId, ttl_s: ttlS, ephemeral });

    /**
     * Mint a ticket for one job. → { ticket, claims } (never logged).
     */
    function mint({ jobId, projectId }) {
        if (!privateKey) throw new Error('stream tickets are disabled: no stream key (RUN_STREAM_PRIVATE_KEY or RUN_STREAM_KEY_FILE)');
        if (!JOB_RE.test(String(jobId))) throw new TypeError(`stream ticket: ${jobId} is not a job id`);
        if (!PROJECT_RE.test(String(projectId))) throw new TypeError(`stream ticket: ${projectId} is not a project id`);
        const iat = Math.floor(now() / 1000);
        const claims = {
            iss: config.baseUrl, sub: jobId, aud: config.audience, typ: TYP, purpose: TYP,
            project: projectId, job_id: jobId, iat, exp: iat + ttlS, jti: `rsk_${crypto.randomBytes(12).toString('hex')}`,
        };
        const header = { alg: 'RS256', typ: 'JWT', kid: config.stream.keyId };
        const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
        const signature = b64url(crypto.sign('RSA-SHA256', Buffer.from(input), privateKey));
        return { ticket: `${input}.${signature}`, claims };
    }

    function prune(t = Math.floor(now() / 1000)) {
        for (const [jti, exp] of seen) if (exp < t) seen.delete(jti);
    }

    /**
     * Verify a ticket: signature, header, audience, typ, expiry — and, with consume (the default), that its
     * jti was never used. → { ok: true, claims } or { ok: false, code, reason } (problem codes ticket.*).
     */
    function verify(token, { consume = true } = {}) {
        const bad = (code, reason) => ({ ok: false, code, reason });
        if (!privateKey) return bad('ticket.unavailable', 'stream tickets are disabled: no stream key is configured');
        if (typeof token !== 'string' || !token.length || token.length > 4096) return bad('ticket.invalid', 'not a ticket');
        const parts = token.split('.');
        if (parts.length !== 3) return bad('ticket.invalid', 'not a ticket');
        const header = decode(parts[0]);
        const claims = decode(parts[1]);
        if (!header || !claims || header.alg !== 'RS256') return bad('ticket.invalid', 'not a ticket');
        if (config.stream.keyId && header.kid !== config.stream.keyId) return bad('ticket.invalid', 'not a ticket (key)');
        let good = false;
        try { good = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey(privateKey), fromB64url(parts[2])); } catch { good = false; }
        if (!good) return bad('ticket.invalid', 'the ticket signature does not verify');
        if (claims.typ !== TYP || claims.purpose !== TYP) return bad('ticket.invalid', 'not a stream ticket');
        if (claims.aud !== config.audience) return bad('ticket.invalid', `not for ${config.audience}`);
        if (!JOB_RE.test(String(claims.sub)) || claims.job_id !== claims.sub || !PROJECT_RE.test(String(claims.project))) return bad('ticket.invalid', 'the ticket names no job');
        const t = Math.floor(now() / 1000);
        // Run mints and verifies its own tickets, so exp is a hard deadline (no receiver-side skew): a
        // ticket that is even a second past two minutes is refused. Only a clock that jumped backwards
        // gets a small allowance on iat.
        if (typeof claims.exp !== 'number' || claims.exp < t) return bad('ticket.expired', 'the ticket expired; ask for a new one');
        if (typeof claims.iat === 'number' && claims.iat - 5 > t) return bad('ticket.invalid', 'the ticket is not valid yet');
        if (typeof claims.jti !== 'string' || !claims.jti) return bad('ticket.invalid', 'the ticket has no jti');
        prune(t);
        if (seen.has(claims.jti)) return bad('ticket.used', 'this ticket already opened a stream; ask for a new one');
        if (consume) seen.set(claims.jti, claims.exp);
        return { ok: true, claims };
    }

    /** Load the key at boot (server/index.js); a second call is a no-op. */
    function start() { if (!privateKey) load(); return status(); }
    function stop() { seen.clear(); }

    return { start, stop, load, get, status, mint, verify, ttlS };
}

module.exports = { createStreamTickets, TYP, JOB_RE, PROJECT_RE };
