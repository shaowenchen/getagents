import { escapeHtml, agentInitial, formatTime, truncate, avatarColor } from './utils.js';
import { api, apiUpload, getAdminToken, setAdminToken, clearAdminToken, getAdminApiKey, getUploadApiKey, getDownloadApiKey, setUserApiKeys, publicUrl, routePrefix } from './api.js';
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
    const { token, userId, username: name, loginKey, uploadKey, downloadKey } = await api('/admin/login', { method: 'POST', body: { apiKey } });
    setAdminToken(token, name, loginKey || apiKey, uploadKey, downloadKey);
    state.currentUser = { userId, username: name };
    updateUserNavInfo();
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
    const { token, userId, username: name, apiKey, uploadKey, downloadKey } = await api('/admin/register', { method: 'POST', body: { username } });
    setAdminToken(token, name, apiKey, uploadKey, downloadKey);
    state.currentUser = { userId, username: name };
    updateUserNavInfo();
    loginMode = 'login';
    registeredKey = apiKey;
    renderAdminLogin();
  } catch (e) {
    registeredKey = '';
    renderAdminLogin(e.message || 'Registration failed');
  }
};

window.adminLogout = () => {
  state.currentUser = null;
  state.resetApiKeyResult = null;
  updateUserNavInfo();
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

async function renderProfile() {
  await renderAuthenticated(renderProfilePage);
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
    state.currentUser = null;
    updateUserNavInfo();
    renderAdminLogin(hadToken ? 'Session expired. Please sign in again.' : '');
    return;
  }

  state.currentUser = { userId: status.userId, username: status.username || 'User' };
  if (status.username) sessionStorage.setItem('admin_username', status.username);
  updateUserNavInfo();
  await renderPage();
}

function currentUsername() {
  return state.currentUser?.username || sessionStorage.getItem('admin_username') || 'User';
}

function userInitial() {
  return currentUsername().trim().slice(0, 1).toUpperCase() || 'U';
}

function isSystemAdminUser() {
  return currentUsername() === 'admin';
}

function updateUserNavInfo() {
  const userInfo = document.getElementById('nav-user-info');
  const loginLink = document.getElementById('nav-login-link');
  if (!userInfo) return;
  if (!state.currentUser) {
    if (loginLink) loginLink.style.display = '';
    userInfo.style.display = 'none';
    userInfo.classList.remove('open');
    userInfo.innerHTML = '';
    return;
  }
  if (loginLink) loginLink.style.display = 'none';
  userInfo.style.display = 'block';
  userInfo.innerHTML = `
    <button class="user-menu-button" onclick="toggleUserMenu(event)" title="${escapeHtml(currentUsername())}" aria-label="User menu">
      ${escapeHtml(userInitial())}
    </button>
    <div class="user-menu-dropdown">
      <div class="user-menu-name">Signed in as <strong>${escapeHtml(currentUsername())}</strong></div>
      <button class="user-menu-item" onclick="navigateToProfile()">Profile</button>
      <button class="user-menu-item" onclick="adminLogout()">Sign out</button>
    </div>
  `;
}

async function initializeUserNavInfo() {
  if (!getAdminToken()) {
    state.currentUser = null;
    updateUserNavInfo();
    return;
  }

  state.currentUser = {
    userId: state.currentUser?.userId || '',
    username: currentUsername(),
  };
  updateUserNavInfo();

  try {
    const status = await api('/admin/status', { admin: true });
    if (!status.authenticated) {
      clearAdminToken();
      state.currentUser = null;
      updateUserNavInfo();
      return;
    }
    state.currentUser = { userId: status.userId, username: status.username || currentUsername() };
    if (status.username) sessionStorage.setItem('admin_username', status.username);
    updateUserNavInfo();
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      clearAdminToken();
      state.currentUser = null;
      updateUserNavInfo();
    }
  }
}

initializeUserNavInfo();

window.toggleUserMenu = (event) => {
  event?.stopPropagation();
  document.getElementById('nav-user-info')?.classList.toggle('open');
};

window.navigateToProfile = () => {
  document.getElementById('nav-user-info')?.classList.remove('open');
  navigate('/profile');
};

document.addEventListener('click', (event) => {
  const menu = document.getElementById('nav-user-info');
  if (menu && !menu.contains(event.target)) menu.classList.remove('open');
});

function renderProfileKeyRow(label, optional, keyValue, codeId, keyType) {
  const missingKey = '<span class="text-muted">Not available in this session. Sign in again or reset the key to view it.</span>';
  return `
    <label class="field">
      <span class="field-label">${label}${optional ? `<span class="field-optional">${optional}</span>` : ''}</span>
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <div style="flex:1;min-width:260px">
          ${keyValue ? `<code id="${codeId}" class="cli-code cli-mini" data-profile-key-type="${keyType}" data-visible="false">********</code>` : missingKey}
        </div>
        ${keyValue ? `
          <button id="${codeId}-toggle" class="btn-ghost" onclick="toggleProfileKey('${codeId}')">Show</button>
          <button class="btn-ghost" onclick="copyProfileKey('${codeId}')">Copy</button>
        ` : ''}
        <button class="btn-ghost btn-danger" onclick="resetCurrentUserKey('${keyType}')">Reset</button>
      </div>
    </label>
  `;
}

function profileKeyValue(keyType) {
  if (keyType === 'login') return getAdminApiKey();
  if (keyType === 'upload') return getUploadApiKey();
  if (keyType === 'download') return getDownloadApiKey();
  return '';
}

window.toggleProfileKey = (codeId) => {
  const el = document.getElementById(codeId);
  if (!el) return;
  const isVisible = el.dataset.visible === 'true';
  el.dataset.visible = isVisible ? 'false' : 'true';
  el.textContent = isVisible ? '********' : profileKeyValue(el.dataset.profileKeyType);
  const toggle = document.getElementById(`${codeId}-toggle`);
  if (toggle) toggle.textContent = isVisible ? 'Show' : 'Hide';
};

window.copyProfileKey = async (codeId) => {
  const el = document.getElementById(codeId);
  if (!el) return;
  const key = profileKeyValue(el.dataset.profileKeyType);
  try {
    await navigator.clipboard.writeText(key);
    toast('Key copied to clipboard');
  } catch {
    toast('Unable to copy key');
  }
};

function keyTypeLabel(keyType) {
  if (keyType === 'login') return 'login';
  if (keyType === 'upload') return 'upload';
  if (keyType === 'download') return 'download';
  return 'all';
}

function renderResetKeyRow(label, keyValue, codeId) {
  if (!keyValue) return '';
  return `
    <label class="field">
      <span class="field-label">${label}</span>
      <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <div style="flex:1;min-width:260px">
          <code id="${codeId}" class="cli-code cli-mini">${escapeHtml(keyValue)}</code>
        </div>
        <button class="btn-ghost" onclick="copyCliCommand('${codeId}')">Copy</button>
      </div>
    </label>
  `;
}

window.resetCurrentUserKey = async (keyType) => {
  const label = keyTypeLabel(keyType);
  if (!confirm(`Reset your ${label} key? The old key will stop working.`)) return;
  try {
    const result = await api(`/admin/keys/${keyType}/reset`, { method: 'POST', admin: true });
    setUserApiKeys(result);
    toast(`${label[0].toUpperCase()}${label.slice(1)} key reset`);
    await renderProfilePage();
  } catch (e) {
    alert(e.message);
  }
};

async function renderProfilePage() {
  const user = state.currentUser || {};
  const apiKey = getAdminApiKey();
  const uploadKey = getUploadApiKey();
  const downloadKey = getDownloadApiKey();
  render(`
    <div class="admin-header">
      <div class="admin-title">
        <h1>Profile</h1>
        <p class="text-muted">Your signed-in account information.</p>
      </div>
      <div class="admin-actions">
        <button class="btn-ghost" onclick="navigateTo('/agents')">My Agents</button>
      </div>
    </div>
    <div class="card">
      <div style="display:flex;align-items:center;gap:0.75rem">
        <div class="agent-avatar" style="background:#2563eb">${escapeHtml(userInitial())}</div>
        <div>
          <h3 style="margin:0">${escapeHtml(currentUsername())}</h3>
          <p class="text-muted" style="margin:0.2rem 0 0">${currentUsername() === 'admin' ? 'Administrator' : 'User'}</p>
        </div>
      </div>
    </div>
    <div class="card">
      <h3 style="margin:0 0 0.75rem">Keys</h3>
      <div class="form-group">
        ${renderProfileKeyRow('Login API Key', '', apiKey, 'profile-login-key', 'login')}
        ${renderProfileKeyRow('Upload API Key', 'GETAGENTS_API_KEY / X-API-Key', uploadKey, 'profile-upload-key', 'upload')}
        ${renderProfileKeyRow('Download API Key', 'downloadKey query / X-API-Key', downloadKey, 'profile-download-key', 'download')}
        <label class="field">
          <span class="field-label">User ID</span>
          <input value="${escapeHtml(user.userId || '')}" readonly>
        </label>
      </div>
    </div>
  `);
}

// ---- Agent list + form rendering ----

async function renderUserAgentsPage() {
  state.resetApiKeyResult = null;
  const [agents, typeOptions] = await Promise.all([
    api('/agents', { admin: true }),
    api('/admin/types', { admin: true }),
  ]);
  state.typeOptions = typeOptions;

  render(`
    <div class="admin-header">
      <div class="admin-title">
        <h1>My Agents</h1>
        <p class="text-muted">${agents.length} agent${agents.length === 1 ? '' : 's'}</p>
      </div>
      <div class="admin-actions">
        <button class="btn-primary" onclick="newAgent()">+ New Agent</button>
      </div>
    </div>
    ${state.showAgentForm ? renderAgentForm() : ''}
    <div class="agent-list">
      ${agents.length ? agents.map(a => renderAgentCard(a)).join('') : `
        <div class="agent-empty empty-state">
          <h3>No agents yet</h3>
          <p class="text-muted" style="margin:0.35rem 0 1rem">Create your first agent or install from the marketplace.</p>
        </div>
      `}
    </div>
    <div id="import-dialog"></div>
  `);
}

async function renderAdminDashboard() {
  const username = currentUsername();
  const isSystemAdmin = username === 'admin';
  if (!isSystemAdmin) {
    state.currentUser = null;
    state.resetApiKeyResult = null;
    clearAdminToken();
    updateUserNavInfo();
    loginMode = 'login';
    renderAdminLogin('Admin access requires signing in with the admin API key.');
    return;
  }

  const [agents, typeOptions, userOptions] = await Promise.all([
    api('/agents', { admin: true }),
    api('/admin/types', { admin: true }),
    isSystemAdmin ? api('/admin/users', { admin: true }) : Promise.resolve([]),
  ]);
  state.typeOptions = typeOptions;
  state.userOptions = userOptions;
  if (!isSystemAdmin && state.adminTab === 'users') state.adminTab = 'agents';

  render(`
    <div class="admin-header">
      <div class="admin-title">
        <h1>Admin</h1>
      </div>
      <div class="admin-actions">
        <button class="btn-ghost" onclick="navigateTo('/agents')">My Agents</button>
        <button class="btn-ghost" onclick="navigateTo('/marketplace')">Marketplace</button>
      </div>
    </div>
    ${renderAdminTabs(agents, isSystemAdmin)}
    ${renderAdminPanel(agents)}
  `);
}

function renderAdminTabs(agents, isSystemAdmin = false) {
  const tab = state.adminTab || 'agents';
  return `
    <div class="admin-tabs">
      <button class="admin-tab ${tab === 'agents' ? 'active' : ''}" onclick="setAdminTab('agents')">
        Agents <span>${agents.length}</span>
      </button>
      <button class="admin-tab ${tab === 'types' ? 'active' : ''}" onclick="setAdminTab('types')">
        Types
      </button>
      ${isSystemAdmin ? `
      <button class="admin-tab ${tab === 'users' ? 'active' : ''}" onclick="setAdminTab('users')">
        Users
      </button>
      ` : ''}
    </div>
  `;
}

function renderAdminPanel(agents) {
  if (state.adminTab === 'types') return renderTypeManager();
  if (state.adminTab === 'users') return renderUserManager();
  return renderAgentsAdminPanel(agents);
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
  const nextTab = ['agents', 'types', 'users'].includes(tab) ? tab : 'agents';
  if (state.adminTab !== nextTab) state.resetApiKeyResult = null;
  state.adminTab = nextTab;
  await renderAdminDashboard();
};

function renderAgentsTable(agents) {
  if (!agents.length) {
    return '<div class="empty-state" style="padding:1.5rem">No agents yet.</div>';
  }

  return `
    <div class="admin-table-wrap">
      <table class="admin-table">
        <colgroup>
          <col class="admin-col-name">
          <col class="admin-col-type">
          <col class="admin-col-status">
          <col class="admin-col-file">
          <col class="admin-col-downloads">
          <col class="admin-col-updated">
          <col class="admin-col-actions">
        </colgroup>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th>File</th>
            <th>Downloads</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${agents.map(agent => `
            <tr class="admin-agent-row">
              <td>
                <div class="admin-agent-name-cell">
                  <div class="agent-avatar admin-agent-avatar" style="background:${avatarColor(agent.name)}">${escapeHtml(agentInitial(agent))}</div>
                  <div>
                    <strong class="admin-agent-name">${escapeHtml(agent.name)}</strong>
                    <div class="text-small admin-agent-desc">${escapeHtml(truncate(agent.description || 'No description', 70))}</div>
                  </div>
                </div>
              </td>
              <td><span class="admin-type-badge">${escapeHtml(agentTypeLabel(agent.type))}</span></td>
              <td>
                <div class="admin-status-stack">
                  ${agent.publishedVersion ? `<span class="admin-status-badge status-public">RELEASED v${agent.publishedVersion}</span>` : '<span class="text-muted">—</span>'}
                </div>
              </td>
              <td>
                <div class="admin-file-cell">
                  <span title="${escapeHtml(agent.filename || '')}">${escapeHtml(truncate(agent.filename || '', 24))}</span>
                  <div class="text-small">${formatFileSize(agent.fileSize || 0)}</div>
                </div>
              </td>
              <td><span class="admin-count">${agent.downloadCount || 0}</span></td>
              <td class="admin-updated-cell">${formatTime(agent.updatedAt)}</td>
              <td>
                <div class="agent-actions admin-agent-actions">
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
  const value = publicUrl();
  if (value && !/^ACCESS_URL$/i.test(value) && !/\$\{?ACCESS_URL\}?/.test(value)) return value;
  return `${window.location.origin}${routePrefix || ''}`;
}

function buildCliScriptUrl() {
  return `${buildCliBaseUrl().replace(/\/+$/g, '')}/cli/upload.sh`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeAgentType(type) {
  const options = state.typeOptions || [];
  return options.some(option => option.name === type) ? type : (options[0]?.name || 'currentdir');
}

function findAgentType(type) {
  const value = normalizeAgentType(type);
  return (state.typeOptions || []).find(item => item.name === value) || { name: value, backupDirs: ['${PWD}'] };
}

function agentTypeLabel(type) {
  return findAgentType(type).name;
}

function agentTypeSource(type) {
  const dirs = findAgentType(type).backupDirs || [];
  return dirs.length ? dirs.join(', ') : '${PWD}';
}

function buildAgentTypeOptions(selected) {
  const value = normalizeAgentType(selected);
  return (state.typeOptions || []).map(option => `
    <option value="${escapeHtml(option.name)}" ${option.name === value ? 'selected' : ''}>
      ${escapeHtml(option.name)} (${escapeHtml((option.backupDirs || []).join(', ') || '${PWD}')})
    </option>
  `).join('');
}

function buildCliCommand({ agentId, agentName, type, backupDirs, description } = {}) {
  const apiKey = getUploadApiKey() || getAdminApiKey();
  const keyPart = `GETAGENTS_API_KEY=${shellQuote(apiKey || '<your-upload-key>')}`;
  const args = [];
  args.push('--type', shellQuote(normalizeAgentType(type)));
  const dirs = backupDirs || findAgentType(type).backupDirs || [];
  dirs.forEach(dir => args.push('--source', shellQuote(dir)));
  if (agentId) args.push('--agent-id', shellQuote(agentId));
  else if (agentName) args.push('--name', shellQuote(agentName));
  else args.push('--name', shellQuote('<agent-name>'));

  if (description) args.push('--description', shellQuote(description));

  return `${keyPart} bash <(curl -fsSL ${shellQuote(buildCliScriptUrl())}) ${args.join(' ')}`;
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

// ---- Managed agent types ----

function parseDirsText(value) {
  return String(value || '').split(/\r?\n|,/).map(dir => dir.trim()).filter(Boolean);
}

function renderTypeManager() {
  const types = state.typeOptions || [];
  return `
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap">
        <div>
          <h3 style="margin:0">Types</h3>
          <p class="text-muted" style="margin:0.25rem 0 0;font-size:0.85rem">Each type can define one or more directories for CLI backup.</p>
        </div>
        <div style="display:grid;gap:0.45rem;min-width:280px">
          <input id="new-type-name" placeholder="Type name, e.g. cursor"
            style="padding:0.45rem 0.6rem;border:1px solid var(--border-strong);border-radius:9px">
          <textarea id="new-type-dirs" placeholder="Backup directories, one per line&#10;\${HOME}/.cursor"
            style="padding:0.45rem 0.6rem;border:1px solid var(--border-strong);border-radius:9px;min-height:72px"></textarea>
          <button class="btn-primary" onclick="addManagedType()">Add Type</button>
        </div>
      </div>
    </div>
    <div class="card admin-table-card">
      ${types.length ? `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Backup Directories</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${types.map(type => `
                <tr>
                  <td><strong>${escapeHtml(type.name)}</strong></td>
                  <td>
                    ${(type.backupDirs || []).length
                      ? (type.backupDirs || []).map(dir => `<code style="display:inline-block;margin:0.12rem 0.25rem 0.12rem 0;padding:0.15rem 0.35rem;background:#f1f5f9;border-radius:6px">${escapeHtml(dir)}</code>`).join('')
                      : '<span class="text-muted">-</span>'}
                  </td>
                  <td>
                    <div class="agent-actions">
                      <button class="btn-ghost" onclick="editManagedType('${type.id}')">Edit</button>
                      <button class="btn-ghost btn-danger" onclick="deleteManagedType('${type.id}')">Delete</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-state" style="padding:1.5rem">No types yet.</div>'}
    </div>
  `;
}

window.addManagedType = async () => {
  const nameInput = document.getElementById('new-type-name');
  const dirsInput = document.getElementById('new-type-dirs');
  const name = nameInput?.value?.trim() || '';
  const backupDirs = parseDirsText(dirsInput?.value || '');
  if (!name) return alert('Type name is required');
  if (!backupDirs.length) return alert('At least one backup directory is required');
  try {
    await api('/admin/types', { method: 'POST', body: { name, backupDirs }, admin: true });
    if (nameInput) nameInput.value = '';
    if (dirsInput) dirsInput.value = '';
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    alert(e.message);
  }
};

window.editManagedType = async (id) => {
  const type = (state.typeOptions || []).find(item => item.id === id);
  if (!type) return;
  const name = prompt('Type name:', type.name);
  if (name === null) return;
  const dirsText = prompt('Backup directories, one per line:', (type.backupDirs || []).join('\n'));
  if (dirsText === null) return;
  const backupDirs = parseDirsText(dirsText);
  if (!backupDirs.length) return alert('At least one backup directory is required');
  try {
    await api(`/admin/types/${id}`, { method: 'PUT', body: { name: name.trim(), backupDirs }, admin: true });
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    alert(e.message);
  }
};

window.deleteManagedType = async (id) => {
  if (!confirm('Delete this type? Existing agents using it will be moved to currentdir.')) return;
  try {
    await api(`/admin/types/${id}`, { method: 'DELETE', admin: true });
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    alert(e.message);
  }
};

// ---- User management ----

function renderUserManager() {
  const users = state.userOptions || [];
  const reset = state.resetApiKeyResult;
  return `
    ${reset ? `
      <div class="card" style="margin-bottom:1rem;border-color:#6ee7b7;background:#ecfdf5">
        <h3 style="margin:0 0 0.35rem;color:#065f46">API keys reset for ${escapeHtml(reset.username)}</h3>
        <p style="margin:0 0 0.5rem;color:#065f46;font-size:0.85rem">Copy these keys now. They will not be shown again.</p>
        <div class="form-group">
          ${renderResetKeyRow('Login key', reset.loginKey || reset.apiKey || '', 'reset-login-key')}
          ${renderResetKeyRow('Upload key', reset.uploadKey || '', 'reset-upload-key')}
          ${renderResetKeyRow('Download key', reset.downloadKey || '', 'reset-download-key')}
        </div>
        <div style="display:flex;gap:0.5rem;margin-top:0.55rem;flex-wrap:wrap;justify-content:flex-end">
          <button class="btn-ghost" onclick="dismissResetApiKey()">Dismiss</button>
        </div>
      </div>
    ` : ''}
    <div class="card admin-table-card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem">
        <h3 style="margin:0">Users</h3>
        <span class="text-muted">${users.length} total</span>
      </div>
      ${users.length ? `
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>User ID</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${users.map(user => `
                <tr>
                  <td><strong>${escapeHtml(user.username)}</strong></td>
                  <td><code style="font-size:0.78rem">${escapeHtml(user.id)}</code></td>
                  <td>${formatTime(user.createdAt)}</td>
                  <td>
                    <div style="display:flex;gap:0.35rem;flex-wrap:wrap">
                      <button class="btn-ghost btn-danger" onclick="resetUserApiKey('${user.id}', 'login')">Reset login</button>
                      <button class="btn-ghost btn-danger" onclick="resetUserApiKey('${user.id}', 'upload')">Reset upload</button>
                      <button class="btn-ghost btn-danger" onclick="resetUserApiKey('${user.id}', 'download')">Reset download</button>
                      <button class="btn-ghost btn-danger" onclick="resetUserApiKey('${user.id}', 'all')">Reset all</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty-state" style="padding:1.5rem">No users found.</div>'}
    </div>
  `;
}

window.resetUserApiKey = async (id, keyType = 'all') => {
  const username = (state.userOptions || []).find(user => user.id === id)?.username || 'this user';
  const label = keyTypeLabel(keyType);
  if (!confirm(`Reset ${label} key${keyType === 'all' ? 's' : ''} for ${username}? The old key${keyType === 'all' ? 's' : ''} will stop working.`)) return;
  try {
    state.resetApiKeyResult = await api(`/admin/users/${id}/reset-api-key`, { method: 'POST', admin: true, body: { keyType } });
    if (state.currentUser?.userId === id) setUserApiKeys(state.resetApiKeyResult);
    await renderCurrentAuthenticatedPage();
  } catch (e) {
    alert(e.message);
  }
};

window.dismissResetApiKey = async () => {
  state.resetApiKeyResult = null;
  await renderCurrentAuthenticatedPage();
};

function buildAgentFormCliCommand() {
  const type = normalizeAgentType(state.agentForm.type);
  if (state.editingAgent) return buildCliCommand({ agentId: state.editingAgent, type });
  const name = String(state.agentForm.name || '').trim();
  return buildCliCommand({ agentName: name, type });
}

function renderCliCommandParams() {
  const type = normalizeAgentType(state.agentForm.type);
  const typeInfo = findAgentType(type);
  const name = String(state.agentForm.name || '').trim() || '<agent-name>';
  const sources = (typeInfo.backupDirs || []).join(', ') || '${PWD}';
  return `
    <div class="cli-param-list">
      <span class="cli-param-chip"><span>name</span>${escapeHtml(name)}</span>
      <span class="cli-param-chip"><span>type</span>${escapeHtml(type)}</span>
      <span class="cli-param-chip"><span>source</span>${escapeHtml(sources)}</span>
    </div>
  `;
}

function renderAgentFormCliCommand() {
  return `
    <div id="agent-form-cli-panel" class="cli-panel" style="padding:0.75rem;border:1px solid #c7d2fe;border-radius:12px;background:#f8fbff">
      ${renderAgentFormCliCommandContent()}
    </div>
  `;
}

function renderAgentFormCliCommandContent() {
  const apiKey = getUploadApiKey() || getAdminApiKey();
  const isEditing = Boolean(state.editingAgent);

  return `
    <div class="cli-step-label">${isEditing ? 'Update from CLI' : 'Generated upload command'}</div>
    <p class="text-muted" style="margin:0 0 0.5rem;font-size:0.82rem">
      ${isEditing
        ? `Run this in the agent runtime environment to upload ${escapeHtml(agentTypeLabel(state.agentForm.type))} files from ${escapeHtml(agentTypeSource(state.agentForm.type))}.`
        : `This page only generates CLI upload parameters. Run the command in the agent runtime environment to create or update by name.`}
    </p>
    ${isEditing ? '' : renderCliCommandParams()}
    ${apiKey ? '' : `
      <div style="margin-bottom:0.5rem;padding:0.5rem 0.6rem;background:#fff7ed;border:1px solid #fed7aa;border-radius:9px;color:#9a3412;font-size:0.8rem">
        Replace <code>&lt;your-api-key&gt;</code> with your API key, or sign in again to inject it automatically.
      </div>
    `}
    <pre class="cli-code cli-mini"><code id="agent-form-cli-cmd">${escapeHtml(buildAgentFormCliCommand())}</code></pre>
    <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
      <button type="button" class="btn-ghost" onclick="copyCliCommand('agent-form-cli-cmd')">Copy command</button>
      <a class="btn-ghost" style="text-decoration:none;display:inline-block" href="${buildCliScriptUrl()}" target="_blank" rel="noopener">View script</a>
    </div>
  `;
}

window.updateAgentFormCliCommand = () => {
  document.querySelectorAll('[data-agent-field]').forEach(input => {
    const field = input.dataset?.agentField;
    if (!field) return;
    state.agentForm[field] = input.type === 'checkbox' ? input.checked : input.value;
  });
  const panel = document.getElementById('agent-form-cli-panel');
  if (panel) panel.innerHTML = renderAgentFormCliCommandContent();
};

window.updateAgentFormField = (field, value) => {
  state.agentForm[field] = value;
  updateAgentFormCliCommand();
};

document.addEventListener('input', (event) => {
  const input = event.target;
  if (!input?.matches?.('[data-agent-field]')) return;
  updateAgentFormField(input.dataset.agentField, input.type === 'checkbox' ? input.checked : input.value);
});

document.addEventListener('change', (event) => {
  const input = event.target;
  if (!input?.matches?.('[data-agent-field]')) return;
  updateAgentFormField(input.dataset.agentField, input.type === 'checkbox' ? input.checked : input.value);
});

function renderAgentForm() {
  const f = state.agentForm;
  const isEditing = Boolean(state.editingAgent);
  return `
    <div class="card" style="margin-bottom:1rem">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:0.75rem">
        <h3 style="margin:0">${isEditing ? 'Edit Agent' : 'New Agent'}</h3>
        <button class="btn-ghost" onclick="cancelEdit()">${isEditing ? 'Cancel' : 'Back to list'}</button>
      </div>
      <div class="form-group">
        <label class="field">
          <span class="field-label">Name<span class="field-required">*</span></span>
          <input data-agent-field="name" placeholder="e.g. My Assistant" value="${escapeHtml(f.name)}" oninput="updateAgentFormField('name', this.value)">
        </label>
        <label class="field">
          <span class="field-label">Type<span class="field-required">*</span></span>
          <select class="form-select" data-agent-field="type" onchange="updateAgentFormField('type', this.value)">
            ${buildAgentTypeOptions(f.type)}
          </select>
        </label>
        ${isEditing ? `
        <label class="field">
          <span class="field-label">Description<span class="field-optional">optional</span></span>
          <input data-agent-field="description" placeholder="What this agent does" value="${escapeHtml(f.description)}" oninput="updateAgentFormField('description', this.value)">
        </label>
        <label class="field">
          <span class="field-label">New ZIP File<span class="field-optional">version upgrade</span></span>
          <input type="file" id="agent-file-input" accept=".zip" onchange="handleAgentFileChange(event)">
          <span class="text-muted" style="font-size:0.75rem">Upload a new ZIP to create a new version. Leave empty to only change metadata.</span>
        </label>
        ` : ''}
        ${renderAgentFormCliCommand()}
        ${isEditing ? `
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <button class="btn-primary" onclick="saveAgent()">Update</button>
          <button class="btn-ghost" onclick="cancelEdit()">Cancel</button>
        </div>
        ` : `
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
          <button class="btn-ghost" onclick="cancelEdit()">Back to list</button>
        </div>
        `}
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

  return `
    <div class="agent-row">
      <div class="card agent-card">
        <div class="agent-avatar" style="background:${color}">${initial}</div>
        <div class="agent-main">
          <div class="agent-title-row">
            <span class="agent-name">${name}</span>
            <span class="badge badge-muted">${escapeHtml(agentTypeLabel(agent.type))}</span>
            ${agent.publishedVersion ? `<span class="badge" style="background:#8b5cf6">RELEASED v${agent.publishedVersion}</span>` : ''}
          </div>
          <p class="agent-description">${escapeHtml(truncate(agent.description || 'No description', 120))}</p>
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
    type: normalizeAgentType(a.type),
    description: a.description,
  };
  await renderUserAgentsPage();
};

window.saveAgent = async () => {
  if (!state.editingAgent) {
    return alert('New agents are created from the CLI upload command.');
  }
  syncAgentFormFromInputs();
  const formData = new FormData();
  formData.append('name', state.agentForm.name);
  formData.append('type', normalizeAgentType(state.agentForm.type));
  formData.append('description', state.agentForm.description);

  if (!state.agentForm.name) {
    return alert('Name is required');
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
  const downloadKey = getDownloadApiKey() || getAdminApiKey();
  const suffix = downloadKey ? `?downloadKey=${encodeURIComponent(downloadKey)}` : '';
  const url = publicUrl(`/api/agents/${id}/download${suffix}`);
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
  state.resetApiKeyResult = null;
  navigate(path);
};

export { renderAdmin, renderProfile, renderUserAgents, toast, buildCliCommand, buildCliBaseUrl, agentTypeLabel, agentTypeSource };