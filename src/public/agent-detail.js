import { escapeHtml, agentInitial, truncate, avatarColor, formatDateShort } from './utils.js';
import { api } from './api.js';
import { render, navigate } from './router.js';
import { state } from './state.js';
import { toast } from './admin.js';

async function renderAgentDetail(agentId) {
  state.detailAgentId = agentId;
  try {
    const [agent, versions] = await Promise.all([
      api(`/agents/${agentId}`, { admin: true }),
      api(`/agents/${agentId}/versions`, { admin: true }),
    ]);

    state.detailVersions = versions;
    const color = avatarColor(agent.name);
    const initial = agentInitial(agent);
    const tags = (agent.tags || []).map(t => `<span class="agent-tag">${escapeHtml(t)}</span>`).join('');

    render(`
      <div style="margin-bottom:1rem">
        <a href="javascript:void(0)" onclick="navigateTo('/agents')" style="color:var(--primary);font-size:0.9rem">&larr; Back to My Agents</a>
      </div>

      <div class="card" style="margin-bottom:1.5rem">
        <div style="display:flex;gap:1rem;align-items:start">
          <div class="agent-avatar" style="background:${color};width:56px;height:56px;font-size:1.2rem">${initial}</div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.35rem">
              <h2 style="font-size:1.2rem;letter-spacing:-0.01em">${escapeHtml(agent.name)}</h2>
              ${agent.enabled ? '<span class="badge badge-success">Enabled</span>' : '<span class="badge badge-muted">Disabled</span>'}
              ${agent.isPublic ? '<span class="badge" style="background:#8b5cf6">Public</span>' : ''}
            </div>
            <p style="color:var(--muted);line-height:1.5">${escapeHtml(agent.description || 'No description')}</p>
            ${tags ? `<div class="agent-tags" style="margin:0.5rem 0">${tags}</div>` : ''}
            <div class="agent-meta" style="margin-top:0.5rem">
              <span class="agent-chip">File: ${escapeHtml(truncate(agent.filename || 'N/A', 50))}</span>
              <span class="agent-chip">Size: ${formatFileSize(agent.fileSize || 0)}</span>
              <span class="agent-chip">SHA-256: ${escapeHtml(truncate(agent.fileHash || '', 16))}</span>
              ${agent.category ? `<span class="agent-chip">Category: ${escapeHtml(agent.category)}</span>` : ''}
              <span class="agent-chip">Created: ${formatDateShort(agent.createdAt)}</span>
              <span class="agent-chip">Updated: ${formatDateShort(agent.updatedAt)}</span>
              <span class="agent-chip">Downloads: ${agent.downloadCount || 0}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:0.4rem;flex-shrink:0">
            <button class="btn-primary" onclick="downloadAgent('${agent.id}')">Download</button>
            <button class="btn-ghost" onclick="editAgent('${agent.id}')">Edit</button>
            <button class="btn-ghost" onclick="shareAgent('${agent.id}')">${agent.shareToken ? 'Update Share' : 'Share'}</button>
            ${agent.shareToken ? `<button class="btn-ghost btn-danger" onclick="unshareAgent('${agent.id}')">Unshare</button>` : ''}
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:1rem">
        <h3 style="margin-bottom:0.75rem">Version History (${versions.length})</h3>
        ${versions.length ? `
          <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem">
            <button class="btn-ghost" onclick="compareVersions()">Compare Versions</button>
          </div>
          <div id="version-diff" style="margin-bottom:0.75rem">${renderDiff()}</div>
          ${versions.map((v, i) => `
            <div style="display:flex;align-items:center;justify-content:space-between;padding:0.55rem 0;border-bottom:1px solid var(--border);gap:0.5rem">
              <div>
                <strong>v${v.version}</strong>
                ${v.comment ? `<span style="color:var(--muted);margin-left:0.5rem">${escapeHtml(v.comment)}</span>` : ''}
                <span style="color:var(--muted);margin-left:0.5rem;font-size:0.82rem">${formatTime(agent.updatedAt)}</span>
              </div>
              <div style="display:flex;gap:0.35rem">
                <a href="${window.__GETAGENTS_CONFIG__.apiPrefix || '/getagents/api'}/agents/${agent.id}/download/${v.version}" class="btn-ghost" style="font-size:0.78rem;text-decoration:none;display:inline-block;padding:0.28rem 0.58rem">Download</a>
                <button class="btn-ghost" style="font-size:0.78rem" onclick="rollbackVersion('${agent.id}', ${v.version})">Rollback</button>
              </div>
            </div>
          `).join('')}
        ` : '<p class="text-muted">No versions yet. Versions are created automatically when you update an agent.</p>'}
      </div>
    `);
  } catch (e) {
    if (e.status === 404) {
      render(`<div class="empty-state"><h3>Agent not found</h3><p class="text-muted"><a href="javascript:void(0)" onclick="navigateTo('/agents')">Back to My Agents</a></p></div>`);
    } else if (e.status === 401) {
      render(`<div class="empty-state"><h3>Authentication required</h3><p class="text-muted"><a href="javascript:void(0)" onclick="navigateTo('/admin')">Go to Admin</a></p></div>`);
    }
  }
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function renderDiff() {
  if (!state.detailDiff) return '';
  const entries = Object.entries(state.detailDiff);
  if (!entries.length) return '<p class="text-muted">No differences found between selected versions.</p>';

  return `<div style="background:#f8fafc;border:1px solid var(--border);border-radius:10px;padding:0.75rem;font-size:0.85rem">
    <strong style="margin-bottom:0.5rem;display:block">Changes:</strong>
    ${entries.map(([key, { from, to }]) => `
      <div style="margin-bottom:0.4rem">
        <span style="font-weight:600;color:var(--primary)">${escapeHtml(key)}:</span>
        <span style="color:var(--danger);text-decoration:line-through;margin-right:0.5rem">${escapeHtml(truncate(JSON.stringify(from), 60))}</span>
        &rarr;
        <span style="color:#16a34a;margin-left:0.5rem">${escapeHtml(truncate(JSON.stringify(to), 60))}</span>
      </div>
    `).join('')}
  </div>`;
}

window.compareVersions = async () => {
  const versions = state.detailVersions;
  if (versions.length < 2) return alert('Need at least 2 versions to compare');
  const v1 = prompt(`Version 1 (latest is ${versions[0].version}):`, String(versions[1]?.version || ''));
  const v2 = prompt(`Version 2 (latest is ${versions[0].version}):`, String(versions[0]?.version || ''));
  if (!v1 || !v2) return;

  try {
    const diff = await api(`/agents/${state.detailAgentId}/diff?v1=${v1}&v2=${v2}`, { admin: true });
    state.detailDiff = diff;
    await renderAgentDetail(state.detailAgentId);
  } catch (e) {
    alert(e.message);
  }
};

window.rollbackVersion = async (agentId, version) => {
  if (!confirm(`Rollback to version ${version}? This will create a new version with the old settings.`)) return;
  try {
    await api(`/agents/${agentId}/rollback`, { method: 'POST', body: { version }, admin: true });
    toast('Rolled back successfully');
    await renderAgentDetail(agentId);
  } catch (e) {
    alert(e.message);
  }
};

window.navigateTo = (path) => {
  navigate(path);
};

export { renderAgentDetail };