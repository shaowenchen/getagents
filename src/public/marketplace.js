import { escapeHtml, agentInitial, truncate, avatarColor } from './utils.js';
import { api } from './api.js';
import { render } from './router.js';
import { state } from './state.js';
import { toast, buildDownloadCliCommand, buildRestoreCliCommand, buildCliBaseUrl } from './admin.js';

async function renderMarketplace() {
  const { search, marketplaceType: type, sort } = state;
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (sort && sort !== 'popular') params.set('sort', sort);

  const [agents, typeMeta] = await Promise.all([
    api(`/marketplace?${params.toString()}`),
    api('/marketplace/types').catch(() => ({ types: [] })),
  ]);

  state.marketplaceAgents = agents;
  const hasActiveFilters = search || type;
  const modalAgent = agents.find((agent) => agent.id === state.marketplaceModalAgentId);

  render(`
    <div class="mp-toolbar">
      <div class="mp-search-wrap">
        <svg class="mp-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
        <input type="search" class="mp-search" placeholder="Search by name or description..."
          value="${escapeHtml(search)}" oninput="marketplaceSearch(this.value)">
        ${search ? `<button class="mp-search-clear" onclick="marketplaceSearch('')">&times;</button>` : ''}
      </div>
      <div class="mp-filter-group">
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
      ${type ? `<span class="mp-filter-chip">Type: ${escapeHtml(type)} <button onclick="marketplaceFilter('type','')">&times;</button></span>` : ''}
      <button class="mp-clear-all" onclick="clearAllFilters()">Clear all</button>
    </div>
    ` : ''}

    ${agents.length ? `
    <div class="mp-grid">
      ${agents.map((a) => renderMarketplaceCard(a)).join('')}
    </div>
    ` : `
    <div class="mp-empty">
      <div class="mp-empty-icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#c4c9d4" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </div>
      <h3>No agents found</h3>
      <p>${hasActiveFilters ? 'Try adjusting your filters or search terms.' : 'No released agents have been published yet. Be the first!'}</p>
    </div>
    `}

    ${modalAgent ? renderMarketplaceModal(modalAgent) : ''}
  `);
}

function renderMarketplaceCard(agent) {
  const initial = agentInitial(agent);
  const color = avatarColor(agent.name);
  const fileLabel = formatFileSize(agent.fileSize || 0);
  const typeLabel = agent.type || 'currentdir';

  return `
    <div class="mp-card">
      <div class="mp-card-bg" aria-hidden="true">agent</div>
      <div class="mp-card-header">
        <div class="mp-card-avatar" style="background:${color}">${initial}</div>
        <span class="mp-type-badge">${escapeHtml(typeLabel)}</span>
        ${agent.publishedVersion ? `<span class="mp-type-badge">v${agent.publishedVersion}</span>` : ''}
      </div>
      <div class="mp-card-body">
        <h3 class="mp-card-name">${escapeHtml(agent.name)}</h3>
        <p class="mp-card-desc">${escapeHtml(truncate(agent.description || 'No description', 100))}</p>
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
        <button class="mp-btn-install" onclick="openMarketplaceModal('${agent.id}')">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Get
        </button>
      </div>
    </div>
  `;
}

function renderMarketplaceModal(agent) {
  const tab = state.marketplaceModalTab === 'restore' ? 'restore' : 'download';
  const version = agent.publishedVersion || undefined;
  const command = tab === 'restore'
    ? buildRestoreCliCommand({ agentId: agent.id, version })
    : buildDownloadCliCommand({ agentId: agent.id, version });
  const base = buildCliBaseUrl();
  const versionLabel = version ? `v${version}` : 'latest';

  return `
    <div class="mp-modal-overlay" onclick="closeMarketplaceModal()">
      <div class="mp-modal" role="dialog" aria-modal="true" aria-labelledby="mp-modal-title" onclick="event.stopPropagation()">
        <div class="mp-modal-header">
          <div>
            <h3 class="mp-modal-title" id="mp-modal-title">${escapeHtml(agent.name)}</h3>
            <p class="mp-modal-subtitle">${escapeHtml(agent.type || 'currentdir')} · ${versionLabel} · ${formatFileSize(agent.fileSize || 0)}</p>
          </div>
          <button type="button" class="mp-modal-close" aria-label="Close" onclick="closeMarketplaceModal()">&times;</button>
        </div>
        <div class="mp-modal-tabs">
          <button type="button" class="mp-modal-tab ${tab === 'download' ? 'active' : ''}" onclick="switchMarketplaceTab('download')">Download</button>
          <button type="button" class="mp-modal-tab ${tab === 'restore' ? 'active' : ''}" onclick="switchMarketplaceTab('restore')">Restore</button>
        </div>
        <div class="mp-modal-body">
          <p class="mp-modal-hint">${tab === 'download'
    ? 'Download the published package with download.sh. Published releases do not require an API key. When object storage is enabled, downloads go directly to storage.'
    : 'Download and unzip the package into the current directory.'}</p>
          <pre class="cli-code"><code id="mp-modal-cmd">${escapeHtml(command)}</code></pre>
          <div class="mp-modal-actions">
            ${tab === 'download' ? `<button type="button" class="btn-primary" onclick="downloadAgentVersion('${agent.id}', ${agent.publishedVersion || 1})">Download ZIP</button>` : ''}
            <button type="button" class="${tab === 'download' ? 'btn-ghost' : 'btn-primary'}" onclick="copyCliCommand('mp-modal-cmd')">Copy command</button>
            ${tab === 'download' ? `<a class="btn-ghost" style="text-decoration:none;display:inline-block" href="${base}/cli/download.sh" target="_blank" rel="noopener">View script</a>` : ''}
          </div>
        </div>
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

// ---- Event handlers ----

window.marketplaceSearch = (value) => {
  state.marketplaceSearch = value;
  renderMarketplace();
};

window.marketplaceFilter = (key, value) => {
  if (key === 'type') state.marketplaceType = value;
  else if (key === 'sort') state.marketplaceSort = value;
  renderMarketplace();
};

window.clearAllFilters = () => {
  state.marketplaceSearch = '';
  state.marketplaceType = '';
  renderMarketplace();
};

window.openMarketplaceModal = (id) => {
  state.marketplaceModalAgentId = id;
  state.marketplaceModalTab = 'download';
  renderMarketplace();
};

window.closeMarketplaceModal = () => {
  state.marketplaceModalAgentId = null;
  renderMarketplace();
};

window.switchMarketplaceTab = (tab) => {
  state.marketplaceModalTab = tab === 'restore' ? 'restore' : 'download';
  renderMarketplace();
};

window.getFromMarketplace = (id) => {
  window.openMarketplaceModal(id);
};

export { renderMarketplace };
