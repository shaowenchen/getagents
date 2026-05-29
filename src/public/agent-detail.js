import { escapeHtml, agentInitial, truncate, avatarColor, formatDateShort } from './utils.js';
import { api, getAdminApiKey, getUploadApiKey, getDownloadApiKey, publicUrl } from './api.js';
import { render, navigate } from './router.js';
import { state } from './state.js';
import { toast, buildCliCommand, buildCliBaseUrl, agentTypeLabel, agentTypeSource } from './admin.js';

async function renderAgentDetail(agentId) {
  state.detailAgentId = agentId;
  try {
    const [agent, versions, typeOptions] = await Promise.all([
      api(`/agents/${agentId}`, { admin: true }),
      api(`/agents/${agentId}/versions`, { admin: true }),
      api('/admin/types', { admin: true }),
    ]);

    state.detailVersions = versions;
    state.typeOptions = typeOptions;
    const color = avatarColor(agent.name);
    const initial = agentInitial(agent);

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
              ${agent.publishedVersion ? `<span class="badge" style="background:#8b5cf6">Released v${agent.publishedVersion}</span>` : ''}
            </div>
            <p style="color:var(--muted);line-height:1.5">${escapeHtml(agent.description || 'No description')}</p>
            <div class="agent-meta" style="margin-top:0.5rem">
              <span class="agent-chip">Type: ${escapeHtml(agentTypeLabel(agent.type))}</span>
              <span class="agent-chip">Size: ${formatFileSize(agent.fileSize || 0)}</span>
              <span class="agent-chip">SHA-256: ${escapeHtml(truncate(agent.fileHash || '', 16))}</span>
              <span class="agent-chip">Created: ${formatDateShort(agent.createdAt)}</span>
              <span class="agent-chip">Updated: ${formatDateShort(agent.updatedAt)}</span>
              <span class="agent-chip">Downloads: ${agent.downloadCount || 0}</span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:0.4rem;flex-shrink:0">
            <button class="btn-primary" onclick="downloadAgent('${agent.id}')">Download Latest</button>
            <button class="btn-ghost" onclick="editAgent('${agent.id}')">Edit</button>
          </div>
        </div>
      </div>

      ${renderAgentCliPanel(agent)}

      <div class="card" style="margin-bottom:1rem">
        <h3 style="margin-bottom:0.75rem">Version History (${versions.length})</h3>
        ${versions.length ? `
          <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem">
            <button class="btn-ghost" onclick="compareVersions()">Compare Versions</button>
          </div>
          <div id="version-diff" style="margin-bottom:0.75rem">${renderDiff()}</div>
          ${renderVersionRows(agent, versions)}
        ` : '<p class="text-muted">No versions yet. Versions are created automatically when you update an agent.</p>'}
      </div>
    `);
  } catch (e) {
    if (e.status === 404) {
      render(`<div class="empty-state"><h3>Agent not found</h3><p class="text-muted"><a href="javascript:void(0)" onclick="navigateTo('/agents')">Back to My Agents</a></p></div>`);
    } else if (e.status === 401) {
      render(`<div class="empty-state"><h3>Authentication required</h3><p class="text-muted"><a href="javascript:void(0)" onclick="navigateTo('/agents')">Sign in</a></p></div>`);
    }
  }
}

function renderVersionRows(agent, versions) {
  return versions.map((v) => {
    const restorePanelId = `restore-cmd-${agent.id}-${v.version}`;
    const expanded = state.detailExpandedRestoreVersion === v.version;
    const command = restoreVersionCommand(agent.id, v.version);
    return `
      <div style="padding:0.65rem 0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
          <div>
            <strong>v${v.version}</strong>
            ${v.isPublished ? '<span class="badge" style="background:#8b5cf6;margin-left:0.45rem">Released</span>' : ''}
            ${v.comment ? `<span style="color:var(--muted);margin-left:0.5rem">${escapeHtml(v.comment)}</span>` : ''}
            <span style="color:var(--muted);margin-left:0.5rem;font-size:0.82rem">${formatTime(v.createdAt)}</span>
          </div>
          <div style="display:flex;gap:0.35rem;flex-wrap:wrap;justify-content:flex-end">
            ${v.isPublished ? '' : `<button class="btn-ghost" style="font-size:0.78rem" onclick="publishAgentVersion('${agent.id}', ${v.version})">Publish</button>`}
            <button class="btn-ghost" style="font-size:0.78rem" onclick="downloadAgentVersion('${agent.id}', ${v.version})">Download</button>
            <button class="btn-ghost" style="font-size:0.78rem" onclick="toggleVersionRestoreScript(${v.version})">Copy Restore</button>
            <button class="btn-ghost btn-danger" style="font-size:0.78rem" onclick="deleteAgentVersion('${agent.id}', ${v.version})">Delete</button>
          </div>
        </div>
        ${expanded ? `
          <div class="mp-restore-panel" style="position:static;margin-top:0.6rem">
            <div style="display:flex;justify-content:space-between;gap:0.5rem;align-items:center;margin-bottom:0.5rem">
              <strong>Restore v${v.version}</strong>
              <button class="btn-primary" onclick="copyCliCommand('${restorePanelId}')">Copy</button>
            </div>
            <pre class="cli-code"><code id="${restorePanelId}">${escapeHtml(command)}</code></pre>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderAgentCliPanel(agent) {
  const apiKey = getUploadApiKey();
  const base = buildCliBaseUrl();
  const cmd = buildCliCommand({ agentId: agent.id, type: agent.type });
  return `
    <div class="card cli-panel" style="margin-bottom:1rem">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;flex-wrap:wrap">
        <div>
          <h3 style="margin:0">Update from CLI</h3>
          <p class="text-muted" style="margin:0.2rem 0 0;font-size:0.85rem">
            Run this in the agent runtime environment to upload ${escapeHtml(agentTypeLabel(agent.type))}
            files from ${escapeHtml(agentTypeSource(agent.type))} for <strong>${escapeHtml(agent.name)}</strong>.
          </p>
        </div>
      </div>

      ${apiKey ? '' : `
        <div style="margin-top:0.75rem;padding:0.55rem 0.7rem;background:#fff7ed;border:1px solid #fed7aa;border-radius:10px;color:#9a3412;font-size:0.82rem">
          Replace <code>&lt;your-upload-key&gt;</code> with your Upload API Key. Sign in again to inject it automatically.
        </div>
      `}

      <pre class="cli-code" style="margin-top:0.65rem"><code id="cli-cmd-detail">${escapeHtml(cmd)}</code></pre>
      <div style="display:flex;gap:0.5rem;flex-wrap:wrap">
        <button class="btn-ghost" onclick="copyCliCommand('cli-cmd-detail')">Copy command</button>
        <a class="btn-ghost" style="text-decoration:none;display:inline-block" href="${base}/cli/upload.sh" target="_blank" rel="noopener">View script</a>
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

function formatTime(timestamp) {
  const date = new Date(timestamp || Date.now());
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

function versionDownloadUrl(agentId, version) {
  const downloadKey = getDownloadApiKey();
  const keyPart = downloadKey ? `?downloadKey=${encodeURIComponent(downloadKey)}` : '';
  return publicUrl(`/api/agents/${agentId}/download/${version}${keyPart}`);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function restoreVersionCommand(agentId, version) {
  const url = versionDownloadUrl(agentId, version);
  const script = [
    'set -euo pipefail',
    'tmp=$(mktemp -d)',
    'trap \'rm -rf "$tmp"\' EXIT',
    `curl -fsSL ${shellQuote(url)} -o "$tmp/agent-v${version}.zip"`,
    `backup=".getagents-restore-backup-v${version}-$(date +%Y%m%d%H%M%S)"`,
    'mkdir -p "$backup"',
    `python3 - "$tmp/agent-v${version}.zip" "$backup" <<'PYEOF'`,
    'import os, shutil, sys, zipfile',
    'zip_path, backup_dir = sys.argv[1], sys.argv[2]',
    'with zipfile.ZipFile(zip_path) as zf:',
    '    names = [n for n in zf.namelist() if n and not n.endswith("/") and not os.path.isabs(n) and ".." not in n.split("/")]',
    '    targets = sorted({n.split("/", 1)[0] for n in names})',
    '    for target in targets:',
    '        if os.path.exists(target):',
    '            shutil.move(target, os.path.join(backup_dir, target))',
    '    zf.extractall(".")',
    'PYEOF',
    'echo "Restored package. Previous files backed up in $backup"',
  ].join('; ');
  return `bash -c ${shellQuote(script)}`;
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

window.deleteAgentVersion = async (agentId, version) => {
  if (!confirm(`Delete version ${version}? The latest download will not be changed.`)) return;
  try {
    await api(`/agents/${agentId}/versions/${version}`, { method: 'DELETE', admin: true });
    state.detailDiff = null;
    toast(`Deleted version ${version}`);
    await renderAgentDetail(agentId);
  } catch (e) {
    alert(e.message);
  }
};

window.publishAgentVersion = async (agentId, version) => {
  try {
    await api(`/agents/${agentId}/versions/${version}/publish`, { method: 'POST', admin: true });
    state.detailExpandedRestoreVersion = null;
    toast(`Published version ${version}`);
    await renderAgentDetail(agentId);
  } catch (e) {
    alert(e.message);
  }
};

window.downloadAgentVersion = (agentId, version) => {
  const a = document.createElement('a');
  a.href = versionDownloadUrl(agentId, version);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
};

window.toggleVersionRestoreScript = async (version) => {
  state.detailExpandedRestoreVersion = state.detailExpandedRestoreVersion === version ? null : version;
  await renderAgentDetail(state.detailAgentId);
};

window.navigateTo = (path) => {
  navigate(path);
};

export { renderAgentDetail };