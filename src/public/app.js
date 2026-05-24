import { handleRoute, registerRoute } from './router.js';
import { renderAdmin } from './admin.js';
import { renderMarketplace } from './marketplace.js';
import { renderAgentDetail } from './agent-detail.js';

registerRoute('/', renderMarketplace);
registerRoute('/agents', renderAdmin);
registerRoute('/agents/:id', renderAgentDetail);
registerRoute('/admin', renderAdmin);

handleRoute();