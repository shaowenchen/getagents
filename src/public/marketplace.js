import { escapeHtml, agentInitial, formatTime, truncate, avatarColor } from './utils.js';
import { api, publicUrl } from './api.js';
import { render } from './router.js';
import { state } from './state.js';
import { toast } from './admin.js';

async function renderMarketplace() {
  const { search, tag, marketplaceType: type, sort } = state;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (tag) params.set('tag', tag);
  if (type) params.set('type', type);
  if (sort && sort !== 'popular') params.set('sort', sort);

  const [agents, tagMeta, typeMeta] = await Promise.all([
    api(`/marketplace?${params.toString()}`),
    api('/marketplace/tags').catch(() => ({ tags: [] })),
    api('/marketplace/types').catch(() => ({ types: [] })),
  ]);

  const hasActiveFilters = search || tag || type;

  render(`
    <div class="mp-toolbar">
      <div class="mp-search-wrap">
        <svg class="mp-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="search" class="mp-search" placeholder="Search by name or description..."
          value="${escapeHtml(search)}" oninput="marketplaceSearch(this.value)">
        ${search ? `<button class="mp-search-clear" onclick="marketplaceSearch('')">&times;</button>` : ''}
      </div>
      <div class="mp-filter-group">
        <select class="mp-select" onchange="marketplaceFilter('tag', this.value)">
          <option value="">All Tags</option>
          ${tagMeta.tags.map(t => `<option value="${escapeHtml(t)}" ${tag === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
        </select>
        <select class="mp-select" onchange="marketplaceFilter('type', this.value)">
          <option value="">All Types</option>
          ${typeMeta.types.map(t => `<option value="${escapeHtml(t)}" ${type === t ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('')}
        </select>
      </div>
    </div>

    ${hasActiveFilters ? `
    <div class="mp-active-filters">
      <span class="mp-filter-label">Active filters:</span>
      ${search ? `<span class="mp-filter-chip">Search: "${escapeHtml(search)}" <button onclick="marketplaceSearch('')">&times;</button></span>` : ''}
      ${tag ? `<span class="mp-filter-chip">Tag: ${escapeHtml(tag)} <button onclick="marketplaceFilter('tag','')">&times;</button></span>` : ''}
      ${type ? `<span class="mp-filter-chip">Type: ${escapeHtml(type)} <button onclick="marketplaceFilter('type','')">&times;</button></span>` : ''}
      <button class="mp-clear-all" onclick="clearAllFilters()">Clear all</button>
    </div>
    ` : ''}

    ${agents.length ? `
    <div class="mp-grid">
      ${agents.map(a => renderMarketplaceCard(a)).join('')}
    </div>
    ` : `
    <div class="mp-empty">
      <div class="mp-empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#c4c9d4" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </div>
      <h3>No agents found</h3>
      <p>${hasActiveFilters ? 'Try adjusting your filters or search terms.' : 'No public agents have been published yet. Be the first!'}</p>
    </div>
    `}
  `);
}

function renderMarketplaceCard(agent) {
  const initial = agentInitial(agent);
  const color = avatarColor(agent.name);
  const tags = (agent.tags || []).slice(0, 3).map(t => `<span class="mp-tag">${escapeHtml(t)}</span>`).join('');
  const fileLabel = formatFileSize(agent.fileSize || 0);
  const typeLabel = agent.type || 'workspace';

  return `
    <div class="mp-card">
      <div class="mp-card-bg" aria-hidden="true">agent</div>
      <div class="mp-card-header">
        <div class="mp-card-avatar" style="background:${color}">${initial}</div>
        <span class="mp-type-badge">${escapeHtml(typeLabel)}</span>
      </div>
      <div class="mp-card-body">
        <h3 class="mp-card-name">${escapeHtml(agent.name)}</h3>
        <p class="mp-card-desc">${escapeHtml(truncate(agent.description || 'No description', 100))}</p>
        ${tags ? `<div class="mp-card-tags">${tags}</div>` : ''}
      </div>
      <div class="mp-card-meta">
        <span class="mp-meta-item" title="Package size">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          ${fileLabel}
        </span>
        <span class="mp-meta-item" title="Downloads">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          ${agent.downloadCount || 0}
        </span>
      </div>
      <div class="mp-card-footer">
        <button class="mp-btn-install" onclick="getFromMarketplace('${agent.id}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Get
        </button>
      </div>
    </div>
  `;
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let s = bytes;
  while (s >= 1024 && i < units.length - 1) { s /= 1024; i++; }
  return `${s.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function restoreCommand(id) {
  const url = publicUrl(`/api/agents/${id}/download`);
  return `bash -c ${shellQuote(`set -euo pipefail; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; curl -fsSL ${shellQuote(url)} -o "$tmp/agent.zip"; unzip -o "$tmp/agent.zip" -d .`)}`;
}

// ---- Event handlers ----

window.marketplaceSearch = (value) => {
  state.marketplaceSearch = value;
  renderMarketplace();
};

window.marketplaceFilter = (key, value) => {
  if (key === 'tag') state.marketplaceTag = value;
  else if (key === 'type') state.marketplaceType = value;
  else if (key === 'sort') state.marketplaceSort = value;
  renderMarketplace();
};

window.clearAllFilters = () => {
  state.marketplaceSearch = '';
  state.marketplaceTag = '';
  state.marketplaceType = '';
  renderMarketplace();
};

window.getFromMarketplace = async (id) => {
  const command = restoreCommand(id);
  try {
    await navigator.clipboard.writeText(command);
    toast('Restore command copied');
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = command;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    toast('Restore command copied');
  }
};

export { renderMarketplace };