import { escapeHtml, agentInitial, formatTime, truncate, avatarColor } from './utils.js';
import { api, apiUpload, getAdminToken, setAdminToken, clearAdminToken, getAdminApiKey, publicUrl } from './api.js';
import { render, navigate } from './router.js';
import { state, createAgentForm, resetAgentForm } from './state.js';

// ---- Admin login ----

let loginMode = 'login'; // 'login' | 'register'
let registeredKey = ''; // shown after successful registration

function renderAdminLogin(message = '') {
  const isRegister = loginMode === 'register';
  render(`
    <div class="admin-login">
      <h2>${isRegister ? 'Register' : 'Sign In'}</h2>
      <p class="text-muted" style="margin-bottom:1rem">${isRegister ? 'Choose a username to create your account.' : 'Sign in with your API key.'}</p>
      ${message ? `<p class="admin-error">${escapeHtml(message)}</p>` : ''}
      ${registeredKey ? `
      <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:10px;padding:0.75rem;margin-bottom:0.75rem">
        <p style="font-weight:600;color:#065f46;margin-bottom:0.35rem">Account created!</p>
        <p style="color:#065f46;font-size:0.82rem;margin-bottom:0.5rem">Save your API key — you will need it to sign in.</p>
        <code style="display:block;padding:0.5rem;background:#fff;border-radius:6px;word-break:break-all;font-size:0.85rem;user-select:all">${escapeHtml(registeredKey)}</code>
      </div>
      ` : ''}
      ${isRegister ? `
      <input type="text" id="adminUsername" placeholder="Username (display name)"
        onkeydown="if(event.key==='Enter')submitAdminRegister()">
      <button class="btn-primary" style="width:100%;margin-bottom:0.5rem" onclick="submitAdminRegister()">Create Account</button>
      <button class="btn-ghost" style="width:100%" onclick="switchLoginMode('login')">Back to sign in</button>
      ` : `
      <input type="password" id="adminApiKey" placeholder="API Key"
        onkeydown="if(event.key==='Enter')submitAdminLogin()">
      <button class="btn-primary" style="width:100%;margin-bottom:0.5rem" onclick="submitAdminLogin()">Sign in</button>
      <button class="btn-ghost" style="width:100%" onclick="switchLoginMode('register')">Create account</button>
      `}
    </div>
  `);
  (document.getElementById(isRegister ? 'adminUsername' : 'adminApiKey'))?.focus();
}

window.switchLoginMode = (mode) => {
  loginMode = mode;
  registeredKey = '';
  renderAdminLogin();
};

window.submitAdminLogin = async () => {
  const apiKey = document.getElementById('adminApiKey')?.value || '';
  if (!apiKey) {
    renderAdminLogin('API key is required.');
    return;
  }
  try {
    const { token, username: name } = await api('/admin/login', { method: 'POST', body: { apiKey } });
    setAdminToken(token, name, apiKey);
    loginMode = 'login';
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    renderAdminLogin(e.message || 'Invalid API key');
  }
};

window.submitAdminRegister = async () => {
  const username = document.getElementById('adminUsername')?.value || '';
  if (!username) {
    renderAdminLogin('Username is required.');
    return;
  }
  try {
    const { token, username: name, apiKey } = await api('/admin/register', { method: 'POST', body: { username } });
    setAdminToken(token, name, apiKey);
    loginMode = 'login';
    registeredKey = apiKey;
    renderAdminLogin();
  } catch (e) {
    registeredKey = '';
    renderAdminLogin(e.message || 'Registration failed');
  }
};

window.adminLogout = () => {
  clearAdminToken();
  loginMode = 'login';
  renderAdminLogin();
};

function isAdminRoute() {
  return window.location.pathname.replace(/\/+$/g, '').endsWith('/admin');
}

async function renderCurrentAuthenticatedPage() {
  if (isAdminRoute()) await renderAdminDashboard();
  else await renderUserAgentsPage();
}

// ---- Authenticated page entries ----

async function renderAdmin() {
  await renderAuthenticated(renderAdminDashboard);
}

async function renderUserAgents() {
  await renderAuthenticated(renderUserAgentsPage);
}

async function renderAuthenticated(renderPage) {
  let status;
  try {
    status = await api('/admin/status', { admin: true });
  } catch {
    status = { authenticated: false };
  }

  if (!status.authenticated) {
    const hadToken = !!getAdminToken();
    if (hadToken) clearAdminToken();
    renderAdminLogin(hadToken ? 'Session expired. Please sign in again.' : '');
    return;
  }

  await renderPage();
}

// ---- Agent list + form rendering ----

async function renderUserAgentsPage() {
  const [agents, tagOptions] = await Promise.all([
    api('/agents', { admin: true }),
    api('/admin/tags', { admin: true }),
  ]);
  state.tagOptions = tagOptions;
  const username = sessionStorage.getItem('admin_username') || 'User';

  render(`
    <div class="admin-header">
      <div class="admin-title">
        <h1>My Agents</h1>
        <p class="text-muted">${agents.length} agent${agents.length === 1 ? '' : 's'} — signed in as <strong>${escapeHtml(username)}</strong></p>
      </div>
      <div class="admin-actions">
        <button class="btn-ghost" onclick="navigateTo('/marketplace')">Marketplace</button>
        <button class="btn-ghost" onclick="navigateTo('/admin')">Admin</button>
        <button class="btn-primary" onclick="newAgent()">+ New Agent</button>
        <button class="btn-ghost" onclick="adminLogout()">Sign out</button>
      </div>
    </div>
    ${state.showAgentForm ? renderAgentForm() : ''}
    <div class="agent-list">
      ${agents.length ? agents.map(a => renderAgentCard(a)).join('') : `
        <div class="agent-empty empty-state">
          <h3>No agents yet</h3>
          <p class="text-muted" style="margin:0.35rem 0 1rem">Create your first agent or install from the marketplace.</p>
          <button class="btn-primary" onclick="newAgent()">+ New Agent</button>
        </div>
      `}
    </div>
    <div id="import-dialog"></div>
  `);
}

async function renderAdminDashboard() {
  const [agents, tagOptions] = await Promise.all([
    api('/agents', { admin: true }),
    api('/admin/tags', { admin: true }),
  ]);
  state.tagOptions = tagOptions;
  const username = sessionStorage.getItem('admin_username') || 'User';

  render(`
    <div class="admin-header">
      <div class="admin-title">
        <h1>Admin</h1>
      </div>
      <div class="admin-actions">
        <button class="btn-ghost" onclick="navigateTo('/agents')">My Agents</button>
        <button class="btn-ghost" onclick="navigateTo('/marketplace')">Marketplace</button>
        <button class="btn-ghost" onclick="adminLogout()">Sign out</button>
      </div>
    </div>
    ${renderAdminTabs(agents)}
    ${state.adminTab === 'tags' ? renderTagManager() : renderAgentsAdminPanel(agents)}
  `);
}

function renderAdminTabs(agents) {
  const tab = state.adminTab || 'agents';
  return `
    <div class="admin-tabs">
      <button class="admin-tab ${tab === 'agents' ? 'active' : ''}" onclick="setAdminTab('agents')">
        Agents <span>${agents.length}</span>
      </button>
      <button class="admin-tab ${tab === 'tags' ? 'active' : ''}" onclick="setAdminTab('tags')">
        Tags
      </button>
    </div>
  `;
}

function renderAgentsAdminPanel(agents) {
  return `
    <div class="card admin-table-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem">
        <h3 style="margin:0">Agents</h3>
        <span class="text-muted">${agents.length} total</span>
      </div>
      ${renderAgentsTable(agents)}
    </div>
  `;
}

window.setAdminTab = async (tab) => {
  state.adminTab = tab === 'tags' ? 'tags' : 'agents';
  await renderAdminDashboard();
};

function renderAgentsTable(agents) {
  if (!agents.length) {
    return '<div class="empty-state" style="padding:1.5rem">No agents yet.</div>';
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Tags</th>
            <th>Status</th>
            <th>File</th>
            <th>Downloads</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${agents.map(agent => `
            <tr>
              <td>
                <strong>${escapeHtml(agent.name)}</strong>
                <div class="text-small">${escapeHtml(truncate(agent.description || 'No description', 70))}</div>
              </td>
              <td>
                ${(agent.tags || []).length
                  ? `<div class="agent-tags">${(agent.tags || []).map(tag => `<span class="agent-tag">${escapeHtml(tag)}</span>`).join('')}</div>`
                  : '<span class="text-muted">-</span>'}
              </td>
              <td>
                ${agent.enabled ? '<span class="badge badge-success">ENABLED</span>' : '<span class="badge badge-muted">DISABLED</span>'}
                ${agent.isPublic ? '<span class="badge" style="background:#8b5cf6;margin-left:0.25rem">PUBLIC</span>' : ''}
              </td>
              <td>
                <span title="${escapeHtml(agent.filename || '')}">${escapeHtml(truncate(agent.filename || '', 24))}</span>
                <div class="text-small">${formatFileSize(agent.fileSize || 0)}</div>
              </td>
              <td>${agent.downloadCount || 0}</td>
              <td>${formatTime(agent.updatedAt)}</td>
              <td>
                <div class="agent-actions">
                  <button class="btn-ghost" onclick="navigateTo('/agents/${agent.id}')">Detail</button>
                  <button class="btn-ghost" onclick="downloadAgent('${agent.id}')">Download</button>
                  <button class="btn-ghost btn-danger" onclick="deleteAgent('${agent.id}')">Delete</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

// ---- CLI upload panel ----

function buildCliBaseUrl() {
  return publicUrl();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildCliCommand({ agentId, agentName, description, tags } = {}) {
  const base = buildCliBaseUrl();
  const apiKey = getAdminApiKey();
  const keyPart = apiKey ? `GETAGENTS_API_KEY=${apiKey} ` : 'GETAGENTS_API_KEY=<your-api-key> ';
  const args = [];
  if (agentId) args.push('--agent-id', shellQuote(agentId));
  else if (agentName) args.push('--name', shellQuote(agentName));
  else args.push('--name', shellQuote('<agent-name>'));

  if (description) args.push('--description', shellQuote(description));
  if (tags?.length) args.push('--tags', shellQuote(tags.join(',')));

  return `${keyPart}bash <(curl -fsSL ${base}/cli/upload.sh) ${args.join(' ')}`;
}

window.copyCliCommand = async (id) => {
  const el = document.getElementById(id);
  if (!el) return;
  const text = el.innerText;
  try {
    await navigator.clipboard.writeText(text);
    toast('Command copied to clipboard');
  } catch {
    // Fallback: select the text
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    toast('Selected — press Ctrl/Cmd+C to copy');
  }
};

// ---- Managed tags ----

function renderTagManager() {
  const tags = state.tagOptions || [];
  return `
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap">
        <div>
          <h3 style="margin:0">Tags</h3>
        </div>
        <div style="display:flex;gap:0.45rem;align-items:center;flex-wrap:wrap">
          <input id="new-tag-name" placeholder="New tag"
            style="padding:0.45rem 0.6rem;border:1px solid var(--border-strong);border-radius:9px"
            onkeydown="if(event.key==='Enter')addManagedTag()">
          <button class="btn-primary" onclick="addManagedTag()">Add Tag</button>
        </div>
      </div>
      <div class="agent-tags" style="margin-top:0.75rem">
        ${tags.length ? tags.map(tag => `
          <span class="agent-tag" style="display:inline-flex;align-items:center;gap:0.35rem">
            ${escapeHtml(tag.name)}
            <button title="Delete tag" onclick="deleteManagedTag('${tag.id}')"
              style="border:none;background:transparent;color:inherit;cursor:pointer;padding:0;font-size:1rem;line-height:1">&times;</button>
          </span>
        `).join('') : '<span class="text-muted" style="font-size:0.85rem">No tags yet. Add tags here before assigning them to agents.</span>'}
      </div>
    </div>
  `;
}

window.addManagedTag = async () => {
  const input = document.getElementById('new-tag-name');
  const name = input?.value?.trim() || '';
  if (!name) return alert('Tag name is required');
  try {
    await api('/admin/tags', { method: 'POST', body: { name }, admin: true });
    if (input) input.value = '';
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    alert(e.message);
  }
};

window.deleteManagedTag = async (id) => {
  if (!confirm('Delete this tag? It will be removed from existing agents too.')) return;
  try {
    await api(`/admin/tags/${id}`, { method: 'DELETE', admin: true });
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    alert(e.message);
  }
};

window.toggleAgentTag = (tagName) => {
  const current = Array.isArray(state.agentForm.tags) ? state.agentForm.tags : [];
  state.agentForm.tags = current.includes(tagName)
    ? current.filter(t => t !== tagName)
    : [...current, tagName];
  updateAgentFormCliCommand();
};

function buildAgentFormCliCommand() {
  if (state.editingAgent) return buildCliCommand({ agentId: state.editingAgent });
  const name = String(state.agentForm.name || '').trim();
  const description = String(state.agentForm.description || '').trim();
  const tags = Array.isArray(state.agentForm.tags) ? state.agentForm.tags : [];
  return buildCliCommand({ agentName: name, description, tags });
}

function hasRequiredAgentFormInfo() {
  if (state.editingAgent) return true;
  return Boolean(String(state.agentForm.name || '').trim() && String(state.agentForm.description || '').trim());
}

function renderAgentFormCliCommand() {
  return `
    <div id="agent-form-cli-panel" class="cli-panel" style="padding:0.75rem;border:1px solid #c7d2fe;border-radius:12px;background:#f8fbff">
      ${renderAgentFormCliCommandContent()}
    </div>
  `;
}

function renderAgentFormCliCommandContent() {
  const apiKey = getAdminApiKey();
  const base = buildCliBaseUrl();
  const isEditing = Boolean(state.editingAgent);
  if (!hasRequiredAgentFormInfo()) {
    return `
      <div class="cli-step-label">Upload from CLI</div>
      <p class="text-muted" style="margin:0;font-size:0.82rem">
        Fill in Name and Description first, then the upload command will be generated here.
      </p>
    `;
  }

  return `
    <div class="cli-step-label">${isEditing ? 'Update from CLI' : 'Upload from CLI'}</div>
    <p class="text-muted" style="margin:0 0 0.5rem;font-size:0.82rem">
      ${isEditing
        ? 'Run this in the agent working directory to upload a new version.'
        : 'Run this in the agent working directory to create or update by name.'}
    </p>
    ${apiKey ? '' : `
      <div style="margin-bottom:0.5rem;padding:0.5rem 0.6rem;background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;color:#9a3412;font-size:0.8rem">
        Replace <code>&lt;your-api-key&gt;</code> with your API key, or sign in again to inject it automatically.
      </div>
    `}
    <pre class="cli-code cli-mini"><code id="agent-form-cli-cmd">${escapeHtml(buildAgentFormCliCommand())}</code></pre>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
      <button type="button" class="btn-ghost" onclick="copyCliCommand('agent-form-cli-cmd')">Copy command</button>
      <a class="btn-ghost" style="text-decoration:none;display:inline-block" href="${base}/cli/upload.sh" target="_blank" rel="noopener">View script</a>
    </div>
  `;
}

window.updateAgentFormCliCommand = () => {
  const panel = document.getElementById('agent-form-cli-panel');
  if (panel) panel.innerHTML = renderAgentFormCliCommandContent();
};

function renderAgentForm() {
  const f = state.agentForm;
  const selectedTags = Array.isArray(f.tags) ? f.tags : [];
  const tagOptions = state.tagOptions || [];
  return `
    <div class="card" style="margin-bottom:1rem">
      <h3>${state.editingAgent ? 'Edit Agent' : 'New Agent'}</h3>
      <div class="form-group">
        <label class="field">
          <span class="field-label">Name<span class="field-required">*</span></span>
          <input data-agent-field="name" placeholder="e.g. My Assistant" value="${escapeHtml(f.name)}" oninput="agentForm.name=this.value; updateAgentFormCliCommand()">
        </label>
        <label class="field">
          <span class="field-label">Description<span class="field-required">*</span></span>
          <input data-agent-field="description" placeholder="What this agent does" value="${escapeHtml(f.description)}" oninput="agentForm.description=this.value; updateAgentFormCliCommand()">
        </label>
        ${!state.editingAgent ? `
        <label class="field">
          <span class="field-label">Agent ZIP File<span class="field-required">*</span></span>
          <input type="file" id="agent-file-input" accept=".zip" onchange="handleAgentFileChange(event)">
        </label>
        ` : `
        <label class="field">
          <span class="field-label">New ZIP File<span class="field-optional">version upgrade</span></span>
          <input type="file" id="agent-file-input" accept=".zip" onchange="handleAgentFileChange(event)">
          <span class="text-muted" style="font-size:0.75rem">Upload a new ZIP to create a new version. Leave empty to only change metadata.</span>
        </label>
        `}
        <label class="field">
          <span class="field-label">Tags<span class="field-optional">optional</span></span>
          <div class="tag-option-list">
            ${tagOptions.length ? tagOptions.map(tag => `
              <label class="tag-option">
                <input type="checkbox" value="${escapeHtml(tag.name)}" ${selectedTags.includes(tag.name) ? 'checked' : ''} onchange="toggleAgentTag(this.value)">
                <span>${escapeHtml(tag.name)}</span>
              </label>
            `).join('') : '<span class="text-muted" style="font-size:0.82rem">Add tags in the Tags section above before assigning them.</span>'}
          </div>
        </label>
        <label><input data-agent-field="enabled" type="checkbox" ${f.enabled ? 'checked' : ''} onchange="agentForm.enabled=this.checked"> Enabled</label>
        <label><input data-agent-field="isPublic" type="checkbox" ${f.isPublic ? 'checked' : ''} onchange="agentForm.isPublic=this.checked"> Publish to Marketplace</label>
        ${renderAgentFormCliCommand()}
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <button class="btn-primary" onclick="saveAgent()">${state.editingAgent ? 'Update' : 'Create'}</button>
          <button class="btn-ghost" onclick="cancelEdit()">Cancel</button>
        </div>
      </div>
    </div>
  `;
}

function renderAgentCard(agent) {
  const name = escapeHtml(agent.name);
  const initial = agentInitial(agent);
  const color = avatarColor(agent.name);
  const filename = escapeHtml(truncate(agent.filename || '', 40));
  const fileSizeLabel = formatFileSize(agent.fileSize || 0);
  const tags = (agent.tags || []).map(t => `<span class="agent-tag">${escapeHtml(t)}</span>`).join('');

  return `
    <div class="agent-row">
      <div class="card agent-card">
        <div class="agent-avatar" style="background:${color}">${initial}</div>
        <div class="agent-main">
          <div class="agent-title-row">
            <span class="agent-name">${name}</span>
            ${agent.enabled ? '<span class="badge badge-success">ENABLED</span>' : '<span class="badge badge-muted">DISABLED</span>'}
            ${agent.isPublic ? '<span class="badge" style="background:#8b5cf6">PUBLIC</span>' : ''}
            ${agent.shareToken ? '<span class="badge" style="background:#f59e0b">SHARED</span>' : ''}
          </div>
          <p class="agent-description">${escapeHtml(truncate(agent.description || 'No description', 120))}</p>
          ${tags ? `<div class="agent-tags">${tags}</div>` : ''}
          <div class="agent-meta">
            <span class="agent-chip" title="${escapeHtml(agent.fileHash || '')}">${filename}</span>
            <span class="agent-chip">${fileSizeLabel}</span>
            <span class="agent-chip" style="color:var(--muted)">${agent.downloadCount || 0} downloads</span>
          </div>
        </div>
        <div class="agent-actions">
          <button class="btn-ghost" onclick="navigateTo('/agents/${agent.id}')">Detail</button>
          <button class="btn-ghost" onclick="editAgent('${agent.id}')">Edit</button>
          <button class="btn-ghost" onclick="downloadAgent('${agent.id}')">Download</button>
          <button class="btn-ghost" onclick="shareAgent('${agent.id}')">${agent.shareToken ? 'Share' : 'Share'}</button>
          <button class="btn-ghost btn-danger" onclick="deleteAgent('${agent.id}')">Delete</button>
        </div>
      </div>
    </div>
  `;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---- Agent form helpers ----

window.syncAgentFormFromInputs = () => {
  document.querySelectorAll('[data-agent-field]').forEach(input => {
    const field = input.dataset.agentField;
    if (input.type === 'checkbox') {
      state.agentForm[field] = input.checked;
    } else {
      state.agentForm[field] = input.value.trim();
    }
  });
};

window.handleAgentFileChange = (event) => {
  const file = event.target.files[0];
  if (file) state.agentFormFile = file;
};

// ---- Agent CRUD ----

window.newAgent = () => {
  state.editingAgent = null;
  state.showAgentForm = true;
  state.agentForm = createAgentForm();
  state.agentFormFile = null;
  renderUserAgentsPage();
};

window.editAgent = async (id) => {
  const agents = await api('/agents', { admin: true });
  const a = agents.find(x => x.id === id);
  if (!a) return;
  state.editingAgent = id;
  state.showAgentForm = true;
  state.agentFormFile = null;
  state.agentForm = {
    name: a.name,
    description: a.description,
    enabled: a.enabled,
    tags: a.tags || [],
    isPublic: a.isPublic || false,
  };
  await renderUserAgentsPage();
};

window.saveAgent = async () => {
  syncAgentFormFromInputs();
  const formData = new FormData();
  formData.append('name', state.agentForm.name);
  formData.append('description', state.agentForm.description);
  formData.append('enabled', state.agentForm.enabled);
  formData.append('isPublic', state.agentForm.isPublic);
  if ((state.agentForm.tags || []).length) formData.append('tags', state.agentForm.tags.join(','));

  if (!state.agentForm.name || !state.agentForm.description) {
    return alert('Name and description are required');
  }

  if (!state.editingAgent && !state.agentFormFile) {
    return alert('Please select a ZIP file');
  }

  if (state.agentFormFile) {
    formData.append('agentFile', state.agentFormFile);
  }

  try {
    if (state.editingAgent) {
      await apiUpload(`/agents/${state.editingAgent}`, formData, { method: 'PUT', admin: true });
    } else {
      await apiUpload('/agents', formData, { method: 'POST', admin: true });
    }
    cancelEdit();
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    if (e.status === 401) { clearAdminToken(); renderAdminLogin('Session expired.'); }
    else { alert(e.message); }
  }
};

window.deleteAgent = async (id) => {
  if (!confirm('Delete this agent? This cannot be undone.')) return;
  try {
    await api(`/agents/${id}`, { method: 'DELETE', admin: true });
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    if (e.status === 401) { clearAdminToken(); renderAdminLogin('Session expired.'); }
    else { alert(e.message); }
  }
};

window.cancelEdit = () => {
  state.editingAgent = null;
  state.showAgentForm = false;
  state.agentForm = createAgentForm();
  state.agentFormFile = null;
  renderUserAgentsPage();
};

// ---- Download ----

window.downloadAgent = (id) => {
  const url = publicUrl(`/api/agents/${id}/download`);
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

// ---- Import ----

window.showImportDialog = () => {
  const el = document.getElementById('import-dialog');
  if (!el) return;
  el.innerHTML = `
    <div class="card" style="margin-top:1rem">
      <h3>Import Agent</h3>
      <div class="form-group">
        <label class="field">
          <span class="field-label">Agent Name<span class="field-required">*</span></span>
          <input id="import-name" placeholder="e.g. My Imported Agent">
        </label>
        <label class="field">
          <span class="field-label">Description</span>
          <input id="import-description" placeholder="What this agent does">
        </label>
        <label class="field">
          <span class="field-label">ZIP File<span class="field-required">*</span></span>
          <input type="file" id="import-file" accept=".zip">
        </label>
        <div style="display:flex;gap:0.5rem">
          <button class="btn-primary" onclick="doImport()">Import</button>
          <button class="btn-ghost" onclick="cancelImport()">Cancel</button>
        </div>
      </div>
    </div>
  `;
};

window.doImport = async () => {
  const name = document.getElementById('import-name')?.value?.trim();
  const description = document.getElementById('import-description')?.value?.trim();
  const file = document.getElementById('import-file')?.files[0];

  if (!name) return alert('Name is required');
  if (!file) return alert('Please select a ZIP file');

  const formData = new FormData();
  formData.append('name', name);
  formData.append('description', description || '');
  formData.append('agentFile', file);

  try {
    await apiUpload('/agents', formData, { method: 'POST', admin: true });
    toast('Agent imported successfully');
    cancelImport();
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    if (e.status === 401) { clearAdminToken(); renderAdminLogin('Session expired.'); }
    else alert(e.message);
  }
};

window.cancelImport = () => {
  const el = document.getElementById('import-dialog');
  if (el) el.innerHTML = '';
};

// ---- Share ----

window.shareAgent = async (id) => {
  const password = prompt('Set a share password (optional, leave empty for public link):');
  try {
    const result = await api(`/agents/${id}/share`, {
      method: 'POST',
      body: { password: password || undefined },
      admin: true,
    });
    await navigator.clipboard.writeText(result.url);
    toast(`Share link copied! ${result.password ? '(Password protected)' : '(Public)'}`);
  } catch (e) {
    alert(e.message);
  }
};

window.unshareAgent = async (id) => {
  if (!confirm('Remove sharing for this agent?')) return;
  try {
    await api(`/agents/${id}/share`, { method: 'DELETE', admin: true });
    toast('Sharing removed');
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    alert(e.message);
  }
};

// ---- Toast ----

function toast(message) {
  const id = Date.now();
  state.toasts = [...(state.toasts || []), { id, message }];
  renderToasts();
  setTimeout(() => {
    state.toasts = state.toasts.filter(t => t.id !== id);
    renderToasts();
  }, 3000);
}

function renderToasts() {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;z-index:9999;display:flex;flex-direction:column;gap:0.5rem';
    document.body.appendChild(container);
  }
  container.innerHTML = (state.toasts || []).map(t =>
    `<div class="toast" style="padding:0.6rem 1rem;background:#172033;color:white;border-radius:10px;font-size:0.88rem;box-shadow:0 8px 24px rgba(0,0,0,0.2);animation:fadeInUp 0.25s ease">${escapeHtml(t.message)}</div>`
  ).join('');
}

window.syncAgentFormFromInputs = () => {
  document.querySelectorAll('[data-agent-field]').forEach(input => {
    const field = input.dataset.agentField;
    if (input.type === 'checkbox') {
      state.agentForm[field] = input.checked;
    } else {
      state.agentForm[field] = input.value.trim();
    }
  });
};

// Navigation helper
window.navigateTo = (path) => {
  navigate(path);
};

export { renderAdmin, renderUserAgents, toast, buildCliCommand, buildCliBaseUrl };