const ADMIN_TOKEN_KEY = 'getagents_admin_token';
const ADMIN_API_KEY_KEY = 'getagents_admin_api_key';
const UPLOAD_API_KEY_KEY = 'getagents_upload_api_key';
const DOWNLOAD_API_KEY_KEY = 'getagents_download_api_key';

const appConfig = window.__GETAGENTS_CONFIG__ || {};

const state = {
  // Admin
  currentUser: null,
  adminTab: 'agents',
  editingAgent: null,
  showAgentForm: false,
  typeOptions: [],
  userOptions: [],
  adminUsernameFilter: '',
  resetApiKeyResult: null,
  agentForm: createAgentForm(),
  agentFormFile: null,

  // Agent detail
  detailAgentId: null,
  detailVersions: [],
  detailDiff: null,
  detailExpandedRestoreVersion: null,

  // Marketplace
  marketplaceSearch: '',
  marketplaceType: '',
  marketplaceSort: 'popular',
  marketplaceModalAgentId: null,
  marketplaceModalTab: 'download',
  marketplaceAgents: [],

  // Toast
  toasts: [],
};

function createAgentForm() {
  return {
    name: '',
    type: 'currentdir',
    description: '',
  };
}

function resetAgentForm() {
  state.agentForm = createAgentForm();
  state.agentFormFile = null;
}

export {
  ADMIN_TOKEN_KEY,
  ADMIN_API_KEY_KEY,
  UPLOAD_API_KEY_KEY,
  DOWNLOAD_API_KEY_KEY,
  appConfig,
  state,
  createAgentForm,
  resetAgentForm,
};