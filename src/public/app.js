import { handleRoute, registerRoute } from './router.js';
import { renderAdmin, renderProfile, renderUserAgents } from './admin.js';
import { renderMarketplace } from './marketplace.js';
import { renderAgentDetail } from './agent-detail.js';

registerRoute('/', renderMarketplace);
registerRoute('/agents', renderUserAgents);
registerRoute('/agents/:id', renderAgentDetail);
registerRoute('/admin', renderAdmin);
registerRoute('/profile', renderProfile);

handleRoute();