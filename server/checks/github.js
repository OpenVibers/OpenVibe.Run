'use strict';
/**
 * The small GitHub client the checks scheduler needs (no SDK): an App JWT, installation access tokens, the
 * contents of the workflow files at a SHA, check runs, the App's installations and the manifest conversion.
 *
 * Every call takes an explicit token. This module never logs a request header, a token or the PEM; an error
 * says an HTTP status and GitHub's own message, never the credential it was sent with. The base URL is a
 * config value so a test can point it at a stub and the production default stays https://api.github.com.
 */
const crypto = require('crypto');

class GitHubError extends Error {
    constructor(code, detail, { status = null } = {}) {
        super(detail || code);
        this.name = 'GitHubError';
        this.code = code;
        this.detail = detail;
        this.status = status;
    }
}

const b64url = (value) => Buffer.from(value).toString('base64url');
const trim = (u) => String(u || '').replace(/\/+$/, '');

/** A GitHub App JWT (RS256, iss = the App id, under ten minutes), from the App's private key. */
function appJwt(app, nowMs = Date.now()) {
    const iat = Math.floor(nowMs / 1000) - 60;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iat, exp: iat + 540, iss: String(app.app_id) }));
    const signature = crypto.sign('RSA-SHA256', Buffer.from(`${header}.${payload}`, 'utf8'), app.pem).toString('base64url');
    return `${header}.${payload}.${signature}`;
}

function createGitHub({ config, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
    const checks = (config && config.checks) || {};
    const api = trim(checks.githubApi || 'https://api.github.com');
    const timeoutMs = Math.max(1000, Number(checks.requestTimeoutMs) || 8000);
    const agent = 'OpenVibe.Run-checks (+https://openvibe.run)';

    /**
     * One request. `token` is a JWT or an installation token, `raw` asks for the contents API's raw body
     * (text). → { status, text, json } on success; throws GitHubError otherwise. Never echoes the token.
     */
    async function request(path, { method = 'GET', token = null, body = undefined, raw = false } = {}) {
        const headers = { Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'User-Agent': agent, 'X-GitHub-Api-Version': '2022-11-28' };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetchImpl(`${api}${path}`, {
                method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            const why = e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? `no answer within ${timeoutMs} ms` : 'unreachable';
            throw new GitHubError('checks.github_unavailable', `GitHub did not answer (${why})`);
        }
        const text = await res.text().catch(() => '');
        if (!res.ok) {
            let message = '';
            try { message = String((JSON.parse(text) || {}).message || '').slice(0, 300); } catch { /* not json */ }
            throw new GitHubError('checks.github_refused', `GitHub answered HTTP ${res.status}${message ? `: ${message}` : ''}`, { status: res.status });
        }
        let json = null;
        if (!raw && text) { try { json = JSON.parse(text); } catch { /* an empty or non-JSON answer is null */ } }
        return { status: res.status, text, json, headers: res.headers };
    }

    /** A short-lived installation token (one hour). The caller caches and seals it; this module never does. */
    async function createInstallationToken(app, installationId) {
        const out = await request(`/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`, {
            method: 'POST', token: appJwt(app, now()),
        });
        const token = out.json && out.json.token;
        const expiresAt = Date.parse(out.json && out.json.expires_at);
        if (typeof token !== 'string' || !token || !Number.isFinite(expiresAt)) throw new GitHubError('checks.github_refused', 'GitHub issued no installation token');
        return { token, expiresAt };
    }

    /** One file at a ref through the contents API (raw), or null when GitHub says 404. */
    async function readFile(app, token, { owner, repo, path, ref }) {
        const encoded = String(path).split('/').map(encodeURIComponent).join('/');
        try {
            const out = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encoded}?ref=${encodeURIComponent(ref)}`, { token, raw: true });
            return out.text;
        } catch (e) {
            if (e.status === 404) return null;
            throw e;
        }
    }

    /** The workflow files under .github/workflows at a SHA → [{ path, source }]. A repo with none is an empty list. */
    async function listWorkflows(app, token, { owner, repo, sha }) {
        let listing;
        try {
            listing = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.github/workflows?ref=${encodeURIComponent(sha)}`, { token });
        } catch (e) {
            if (e.status === 404) return [];
            throw e;
        }
        const files = Array.isArray(listing.json) ? listing.json : [];
        const out = [];
        for (const file of files) {
            if (!file || file.type !== 'file' || !/\.ya?ml$/i.test(String(file.name || ''))) continue;
            const source = await readFile(app, token, { owner, repo, path: file.path, ref: sha });
            if (source != null) out.push({ path: file.path, source });
        }
        return out;
    }

    /** Create a check run (queued) → { id, html_url }. */
    async function createCheckRun(token, { owner, repo, name, headSha, detailsUrl = null, externalId = null }) {
        const body = { name, head_sha: headSha, status: 'queued', ...(detailsUrl ? { details_url: detailsUrl } : {}), ...(externalId ? { external_id: externalId } : {}) };
        const out = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`, { method: 'POST', token, body });
        if (!out.json || !out.json.id) throw new GitHubError('checks.github_refused', 'GitHub created no check run');
        return { id: out.json.id, html_url: out.json.html_url || null };
    }

    /** Update a check run (status, conclusion, summary, details link). */
    async function updateCheckRun(token, { owner, repo, checkRunId, status, conclusion = null, output = null, detailsUrl = null, startedAt = null, completedAt = null }) {
        const body = {
            status,
            ...(conclusion ? { conclusion } : {}),
            ...(output ? { output } : {}),
            ...(detailsUrl ? { details_url: detailsUrl } : {}),
            ...(startedAt ? { started_at: startedAt } : {}),
            ...(completedAt ? { completed_at: completedAt } : {}),
        };
        const out = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${encodeURIComponent(String(checkRunId))}`, { method: 'PATCH', token, body });
        return out.json;
    }

    /** Exchange a manifest flow code for the App's id, slug, PEM, webhook secret and client credentials. */
    async function convertManifest(code) {
        const out = await request(`/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' });
        const app = out.json;
        if (!app || !app.id || !app.pem || !app.webhook_secret) throw new GitHubError('checks.github_refused', 'GitHub returned an incomplete App registration');
        return app;
    }

    /** Every installation of the App (GET /app/installations), for the owner page. */
    async function listInstallations(app) {
        const out = await request('/app/installations?per_page=100', { token: appJwt(app, now()) });
        return Array.isArray(out.json) ? out.json : [];
    }

    return { request, createInstallationToken, readFile, listWorkflows, createCheckRun, updateCheckRun, convertManifest, listInstallations, api };
}

module.exports = { createGitHub, appJwt, GitHubError };
