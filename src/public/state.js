const ADMIN_TOKEN_KEY = 'getagents_admin_token';

const appConfig = window.__GETAGENTS_CONFIG__ || {};

const state = {
  // Admin
  editingAgent: null,
  showAgentForm: false,
  agentForm: createAgentForm(),
  agentFormFile: null,

  // Agent detail
  detailAgentId: null,
  detailVersions: [],
  detailDiff: null,

  // Marketplace
  marketplaceSearch: '',
  marketplaceCategory: '',
  marketplaceTag: '',
  marketplaceSort: 'popular',

  // Toast
  toasts: [],
};

function createAgentForm() {
  return {
    name: '',
    description: '',
    enabled: true,
    tags: '',
    category: '',
    isPublic: false,
  };
}

function resetAgentForm() {
  state.agentForm = createAgentForm();
  state.agentFormFile = null;
}

export {
  ADMIN_TOKEN_KEY,
  appConfig,
  state,
  createAgentForm,
  resetAgentForm,
};