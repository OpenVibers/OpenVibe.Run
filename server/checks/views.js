'use strict';
/**
 * The owner-only checks page. It shows the App's state, never one of its secrets: the manifest is public
 * configuration, and the id, slug, account names and whether the App exists are the whole answer. No PEM,
 * webhook secret, client secret or installation token is interpolated here.
 */
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const PAGE = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · OpenVibe Run</title><style>:root{color-scheme:light dark;font:16px/1.6 system-ui}body{margin:0;background:light-dark(#f6f8fa,#101519);color:light-dark(#16232c,#e6edf2)}main{max-width:960px;margin:auto;padding:24px}h1{font-size:2rem;line-height:1.2}h2{margin-top:2rem}section{padding:20px;margin:16px 0;border:1px solid #70809060;border-radius:12px}a{color:light-dark(#075a85,#87d6ff)}code{overflow-wrap:anywhere}.badge{display:inline-block;padding:2px 10px;border-radius:999px;border:1px solid #70809080;font-size:.9rem}.warn{padding:12px 16px;border-radius:8px;background:#b4530920;border:1px solid #b4530980}.ok{padding:12px 16px;border-radius:8px;background:#15803d20;border:1px solid #15803d80}button{font:inherit;min-height:44px;padding:8px 16px;border-radius:8px;border:1px solid #70809080;cursor:pointer}table{display:block;overflow-x:auto;border-collapse:collapse;max-width:100%;text-align:left}th,td{padding:8px 10px;border-bottom:1px solid #70809060;white-space:nowrap}ul{padding-left:22px}@media(max-width:600px){main{padding:16px}h1{font-size:1.7rem}}</style></head><body><main>${body}</main></body></html>`;

function errorPage({ title = 'Checks', text, back = '/admin/checks' } = {}) {
    return PAGE(title, `<h1>${esc(title)}</h1><section><p>${esc(text || 'That did not work.')}</p><p><a href="${esc(back)}">Back to checks</a></p></section>`);
}

function adminPage({ app = null, installations = [], action, manifest, created = false, warnings = [], installUrl = null, keyConfigured = true, projectConfigured = true, org = 'OpenVibers' } = {}) {
    const state = app ? (installations.length ? 'installed' : 'created') : 'none';
    const rows = installations.map((i) => `<tr><td>${esc(i.account_login)}</td><td>${esc(i.account_type || '')}</td><td>${esc(i.installation_id)}</td><td>${i.suspended_at ? 'suspended' : 'active'}</td></tr>`).join('');
    return PAGE('GitHub checks', `
<h1>GitHub checks</h1>
<p>Checks on shared nodes: a workflow job from an <strong>${esc(org)}</strong> repository is planned here and run as a
Run job on a node, with a GitHub check run beside it. The App is the only way Run reads workflows and reports its work.</p>
<section>
  <p>App state: <span class="badge">${esc(state)}</span>${app ? ` · <strong>${esc(app.name)}</strong> (id ${esc(app.app_id)}, slug ${esc(app.slug)})` : ''}</p>
  ${created ? '<p class="ok">The App was created and its key, webhook secret and client secret are stored encrypted. Install it on the organization next.</p>' : ''}
  ${warnings.map((w) => `<p class="warn">${esc(w)}</p>`).join('')}
  ${!keyConfigured ? '<p>Set <code>RUN_SECRETS_KEY</code> (32 bytes, base64 or 64 hex) before creating the App: without it Run cannot store the App\'s secrets.</p>' : ''}
  ${!projectConfigured ? '<p>Set <code>RUN_CHECKS_PROJECT</code> to the project check jobs belong to; no check is planned until it is set.</p>' : ''}
</section>
${app ? `<section>
  <h2>Installed on</h2>
  ${rows ? `<table><tr><th>Account</th><th>Type</th><th>Installation</th><th>State</th></tr>${rows}</table>` : '<p>Not installed on an account yet.</p>'}
  ${installUrl ? `<p><a href="${esc(installUrl)}">Install ${esc(app.name)} on ${esc(org)}</a></p>` : ''}
  <p>Webhook: <code>/webhooks/github</code> · callback: <code>/admin/checks/created</code></p>
</section>` : ''}
<section>
  <h2>${app ? 'Replace the GitHub App' : 'Create the GitHub App'}</h2>
  <p>GitHub registers the App from this manifest and returns its id, private key and webhook secret once. Those are stored
  encrypted; they are never shown here, logged or sent to a node.</p>
  <form method="post" action="${esc(action)}">
    <input type="hidden" name="manifest" value="${esc(manifest)}">
    <button type="submit"${keyConfigured ? '' : ' disabled'}>${app ? 'Create a replacement App' : 'Create the GitHub App'}</button>
  </form>
</section>`);
}

module.exports = { adminPage, errorPage, PAGE, esc };
