import type { Request, Response } from 'express';
import { agentFilePath, agentFileExists, createDirectAgentDownload, getAgentFileStream, supportsDirectAgentDownload } from './fileStore.js';
import { authenticateApiKey } from '../middleware/adminAuth.js';
import type { AgentConfig, AgentVersion } from '../shared/types.js';
import * as db from '../db/store.js';

export function downloadFileName(agentName: string, version: number): string {
  const safeName = agentName.replace(/[^a-z0-9-]/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'agent';
  return `${safeName}-v${version}.zip`;
}

export type ResolvedAgentDownload = {
  agent: AgentConfig;
  version: number;
  versionRecord?: AgentVersion;
  filePath: string;
  filename: string;
  fileSize: number;
  publicVersion?: number;
};

export type PreparedAgentDownload =
  | { ok: true; mode: 'redirect'; download: ResolvedAgentDownload; url: string; expiresIn: number; storage: string }
  | { ok: true; mode: 'stream'; download: ResolvedAgentDownload; stream: NodeJS.ReadableStream; storage: string }
  | { ok: false; status: number; error: string; download?: ResolvedAgentDownload };

export function hasDownloadAuthKey(req: Request): boolean {
  return Boolean(req.headers.authorization || req.headers['x-api-key'] || req.query.downloadKey);
}

export async function resolveAgentDownload(agentId: string, requestedVersion?: number): Promise<ResolvedAgentDownload | null> {
  const agent = await db.getAgent(agentId);
  if (!agent) return null;

  let versionRecord: AgentVersion | undefined;
  let version: number;

  if (requestedVersion !== undefined) {
    if (isNaN(requestedVersion)) return null;
    version = requestedVersion;
    versionRecord = await db.getVersion(agentId, version);
  } else {
    versionRecord = (await db.getVersions(agentId))[0];
    version = versionRecord?.version ?? 1;
  }

  const filePath = versionRecord?.snapshot.filePath || agent.filePath || agentFilePath(agentId, version);
  const filename = downloadFileName(agent.name, version);
  const fileSize = versionRecord?.snapshot.fileSize || agent.fileSize;

  return { agent, version, versionRecord, filePath, filename, fileSize };
}

export async function authorizeAgentDownload(
  req: Request,
  agentId: string,
  requestedVersion?: number,
): Promise<{ ok: true; download: ResolvedAgentDownload } | { ok: false; status: number; error: string }> {
  const download = await resolveAgentDownload(agentId, requestedVersion);
  if (!download) return { ok: false, status: 404, error: 'Agent not found' };
  if (requestedVersion !== undefined && isNaN(requestedVersion)) {
    return { ok: false, status: 400, error: 'Invalid version number' };
  }

  const published = await db.getPublishedVersion(agentId);
  const hasAuthKey = hasDownloadAuthKey(req);
  if (published && !hasAuthKey && (requestedVersion === undefined || published.version === requestedVersion)) {
    return { ok: true, download: { ...download, publicVersion: published.version } };
  }

  const userId = await authenticateApiKey(req, ['download']);
  if (!userId) return { ok: false, status: 401, error: 'Unauthorized' };

  return { ok: true, download };
}

function storageDriverLabel(): string {
  return (process.env.STORAGE_DRIVER || 'local').toLowerCase();
}

export async function prepareAgentDownload(
  download: ResolvedAgentDownload,
  agentId: string,
): Promise<PreparedAgentDownload> {
  const storageVersion = download.publicVersion ?? download.version;
  const fallback = { agentId, version: storageVersion };
  const exists = await agentFileExists(download.filePath, fallback);
  if (!exists) {
    return {
      ok: false,
      status: 404,
      error: 'Agent file not found in storage',
      download,
    };
  }

  const direct = await createDirectAgentDownload(download.filePath, fallback, download.filename);
  if (direct) {
    return {
      ok: true,
      mode: 'redirect',
      download,
      url: direct.url,
      expiresIn: direct.expiresIn,
      storage: 's3',
    };
  }

  const stream = await getAgentFileStream(download.filePath, fallback);
  if (stream) {
    return {
      ok: true,
      mode: 'stream',
      download,
      stream,
      storage: storageDriverLabel(),
    };
  }

  return {
    ok: false,
    status: 404,
    error: 'Agent file not found in storage',
    download,
  };
}

export function buildAgentRelayDownloadUrl(baseUrl: string, agentId: string, version?: number): string {
  const normalized = baseUrl.replace(/\/+$/g, '');
  return version === undefined
    ? `${normalized}/api/agents/${agentId}/download`
    : `${normalized}/api/agents/${agentId}/download/${version}`;
}

export async function sendPreparedAgentDownload(res: Response, prepared: PreparedAgentDownload): Promise<void> {
  if (!prepared.ok) {
    res.status(prepared.status).json({ error: prepared.error });
    return;
  }

  if (prepared.mode === 'redirect') {
    res.redirect(302, prepared.url);
    return;
  }

  const { download, stream } = prepared;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${download.filename}"`);
  res.setHeader('Content-Length', download.fileSize);
  stream.pipe(res);
}
