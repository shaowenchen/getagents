import 'dotenv/config';
import express, { type NextFunction, type Request, type Response } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import agentsRouter from './routes/agents.js';
import marketplaceRouter from './routes/marketplace.js';
import shareRouter from './routes/share.js';
import adminRouter from './routes/admin.js';
import cliRouter from './routes/cli.js';
import { createLogger } from './utils/logger.js';
import { renderUploadScript } from './utils/cliScript.js';
import { ensureAdminUser } from './utils/ensureAdmin.js';
import { getConfiguredAccessUrl, inferAccessUrl } from './utils/accessUrl.js';

const log = createLogger('server');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const URI_PREFIX = normalizeRoutePrefix(process.env.URI_PREFIX || '/getagents');
const ACCESS_URL = getConfiguredAccessUrl();
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || 'user-admin-api-key-change-me';
const publicDir = join(__dirname, 'public');
const indexHtmlPath = join(publicDir, 'index.html');
const indexHtmlCached = readFileSync(indexHtmlPath, 'utf8');
const HOT_RELOAD_HTML = process.env.NODE_ENV !== 'production';

function loadIndexHtml(): string {
  const raw = HOT_RELOAD_HTML ? readFileSync(indexHtmlPath, 'utf8') : indexHtmlCached;
  return raw.replaceAll('__ROUTE_PREFIX__', URI_PREFIX);
}

function normalizeRoutePrefix(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const appConfigScript = `window.__GETAGENTS_CONFIG__ = ${JSON.stringify({
  routePrefix: URI_PREFIX,
  apiPrefix: `${URI_PREFIX}/api`,
  accessUrl: ACCESS_URL,
})};`;

function mountApp(prefix: string) {
  const base = prefix || '';

  app.use(`${base}/api/admin`, adminRouter);
  app.use(`${base}/api/agents`, agentsRouter);
  app.use(`${base}/api/marketplace`, marketplaceRouter);
  app.use(`${base}/api/cli`, cliRouter);
  app.use(`${base}/share`, shareRouter);

  app.get(`${base}/app-config.js`, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('application/javascript').send(appConfigScript);
  });

  app.get(`${base}/cli/upload.sh`, (req, res) => {
    const endpoint = inferAccessUrl(req, base);
    res.setHeader('Cache-Control', 'no-store');
    res.type('text/x-shellscript').send(renderUploadScript(endpoint));
  });

  app.use(base || '/', express.static(publicDir, {
    index: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store');
    },
  }));

  const fallback = base ? [base, `${base}/*`] : ['*'];
  app.get(fallback, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(loadIndexHtml());
  });
}

if (URI_PREFIX) {
  app.get('/', (_req, res) => res.redirect(`${URI_PREFIX}/`));
  mountApp(URI_PREFIX);
} else {
  mountApp('');
}

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : 'Internal server error';
  log.error('Unhandled request error', {
    method: req.method,
    path: req.originalUrl,
    error: message,
    stack: err instanceof Error ? err.stack : undefined,
  });
  if (res.headersSent) return;
  res.status(500).json({ error: message });
});

app.listen(Number(PORT), HOST, async () => {
  // Ensure the admin account exists. ADMIN_API_KEY remains an extra login-only key.
  try {
    const admin = await ensureAdminUser(ADMIN_API_KEY);
    log.info('Admin user ready', { username: admin.username, usingDefaultAdminApiKey: !process.env.ADMIN_API_KEY });
  } catch (err) {
    log.error('Failed to ensure admin user', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info('GetAgents started', {
    host: HOST,
    port: Number(PORT),
    uriPrefix: URI_PREFIX || '/',
    logLevel: (process.env.LOG_LEVEL || 'debug').toLowerCase(),
    sqlDsn: Boolean(process.env.SQL_DSN),
    maxUploadMb: process.env.MAX_UPLOAD_MB || '100',
    accessUrl: ACCESS_URL || 'auto',
  });
});