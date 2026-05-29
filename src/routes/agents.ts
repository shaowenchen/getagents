import { Router, type NextFunction, type Request, type Response } from 'express';
import * as db from '../db/store.js';
import { requireAuth, requireDownloadAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { hashAgentFile, saveAgentFileFromPath, getAgentFileStream, deleteAgentVersionFile } from '../utils/fileStore.js';
import { inferAccessUrl, normalizeRoutePrefix } from '../utils/accessUrl.js';
import { cleanupUploadedFile, createZipUpload, validateAgentName, validateAgentType, validateManagedTags } from './agentMetadata.js';
import type { AgentConfig } from '../shared/types.js';
import crypto from 'crypto';

const router = Router();
const upload = createZipUpload();

async function allowPublicOrDownloadAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const agent = await db.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ error: 'Agent not found' });
    return;
  }

  (req as any).agent = agent;
  const requestedVersion = req.params.version ? Number(req.params.version) : undefined;
  const published = await db.getPublishedVersion(req.params.id);
  const hasAuthKey = Boolean(req.headers.authorization || req.headers['x-api-key'] || req.query.apiKey || req.query.downloadKey);
  if (published && !hasAuthKey && (requestedVersion === undefined || published.version === requestedVersion)) {
    (req as any).publicVersion = published.version;
    return next();
  }

  requireDownloadAuth(req, res, next);
}

// ---- Agent CRUD ----

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const user = await db.getUserById(userId);
  const isSystemAdmin = user?.username === 'admin';
  const includeAll = isSystemAdmin && req.query.all === '1';
  const username = includeAll && typeof req.query.username === 'string' ? req.query.username.trim() : '';
  const agents = includeAll
    ? await db.getAllAgents(undefined, { includeDeleted: true, username })
    : await db.getAllAgents(userId);
  res.json(agents);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
}));

router.post('/', requireAuth, upload.single('agentFile'), asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const { name, description, tags, avatar } = req.body;
  if (!req.file) {
    return res.status(400).json({ error: 'agentFile (ZIP) is required' });
  }

  try {
    let selectedName: string;
    let selectedTags: string[] | undefined;
    let selectedType: string;
    try {
      selectedName = await validateAgentName(userId, name);
      selectedTags = await validateManagedTags(userId, tags);
      selectedType = await validateAgentType(userId, req.body.type);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid agent metadata' });
    }

    const fileHash = await hashAgentFile(req.file.path);
    const agent = await db.createAgent(userId, {
      name: selectedName,
      type: selectedType,
      description: description || '',
      filename: req.file.originalname,
      fileSize: req.file.size,
      fileHash,
      avatar,
      tags: selectedTags,
      isPublic: false,
    });

    await saveAgentFileFromPath(agent.id, 1, req.file.path);
    await db.createVersion(agent.id, 'Initial upload');

    res.status(201).json(agent);
  } finally {
    await cleanupUploadedFile(req.file);
  }
}));

router.put('/:id', requireAuth, upload.single('agentFile'), asyncHandler(async (req, res) => {
  const existing = await db.getAgent(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agent not found' });
  const userId = (req as any).userId as string;
  const user = await db.getUserById(userId);
  if (existing.userId !== userId && user?.username !== 'admin') {
    return res.status(403).json({ error: 'Not your agent' });
  }

  const patch: Partial<AgentConfig> = {};
  try {
    if (req.body.name !== undefined) {
      try {
        patch.name = await validateAgentName((req as any).userId, req.body.name, req.params.id);
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid name' });
      }
    }
    if (req.body.type !== undefined) {
      try {
        patch.type = await validateAgentType((req as any).userId, req.body.type);
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid type' });
      }
    }
    if (req.body.description !== undefined) patch.description = req.body.description;
    if (req.body.tags !== undefined) {
      try {
        patch.tags = await validateManagedTags((req as any).userId, req.body.tags);
      } catch (err) {
        return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid tags' });
      }
    }

    if (req.file) {
      patch.filename = req.file.originalname;
      patch.fileSize = req.file.size;
      patch.fileHash = await hashAgentFile(req.file.path);

      const versions = await db.getVersions(req.params.id);
      const nextVersion = (versions[0]?.version ?? 0) + 1;
      await saveAgentFileFromPath(req.params.id, nextVersion, req.file.path);
    }

    const agent = await db.updateAgent(req.params.id, patch);
    res.json(agent);
  } finally {
    await cleanupUploadedFile(req.file);
  }
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string;
  const existing = await db.getAgent(req.params.id, { includeDeleted: true });
  if (!existing) return res.status(404).json({ error: 'Agent not found' });
  const user = await db.getUserById(userId);
  if (existing.userId !== userId && user?.username !== 'admin') {
    return res.status(403).json({ error: 'Not your agent' });
  }
  if (!await db.deleteAgent(req.params.id, userId)) return res.status(404).json({ error: 'Agent not found' });
  res.status(204).end();
}));

// ---- File Download ----

router.get('/:id/download', asyncHandler(allowPublicOrDownloadAuth), asyncHandler(async (req, res) => {
  const agent = (req as any).agent || await db.getAgent(req.params.id);
  const publicVersion = (req as any).publicVersion;
  const versionRecord = publicVersion ? await db.getVersion(req.params.id, publicVersion) : undefined;

  const stream = await getAgentFileStream(req.params.id, publicVersion);
  if (!stream) return res.status(404).json({ error: 'Agent file not found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${versionRecord ? `${agent.name}-v${publicVersion}.zip` : agent.filename}"`);
  res.setHeader('Content-Length', versionRecord?.snapshot.fileSize || agent.fileSize);
  stream.pipe(res);
}));

router.get('/:id/download/:version', asyncHandler(allowPublicOrDownloadAuth), asyncHandler(async (req, res) => {
  const agent = (req as any).agent || await db.getAgent(req.params.id);

  const version = Number(req.params.version);
  if (isNaN(version)) return res.status(400).json({ error: 'Invalid version number' });

  const stream = await getAgentFileStream(req.params.id, version);
  if (!stream) return res.status(404).json({ error: 'Version file not found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${agent.name}-v${version}.zip"`);
  stream.pipe(res);
}));

// ---- Version Management ----

router.get('/:id/versions', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const versions = await db.getVersions(req.params.id);
  res.json(versions);
}));

router.get('/:id/versions/:version', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const version = await db.getVersion(req.params.id, Number(req.params.version));
  if (!version) return res.status(404).json({ error: 'Version not found' });
  res.json(version);
}));

router.post('/:id/versions', requireAuth, asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const version = await db.createVersion(req.params.id, req.body?.comment);
  res.status(201).json(version);
}));

router.post('/:id/versions/:version/publish', requireAuth, asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const version = Number(req.params.version);
  if (isNaN(version)) return res.status(400).json({ error: 'Invalid version number' });

  const published = await db.publishVersion(req.params.id, version);
  if (!published) return res.status(404).json({ error: 'Version not found' });
  res.json(published);
}));

router.delete('/:id/versions/:version', requireAuth, asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const version = Number(req.params.version);
  if (isNaN(version)) return res.status(400).json({ error: 'Invalid version number' });

  const deleted = await db.deleteVersion(req.params.id, version);
  if (!deleted) return res.status(404).json({ error: 'Version not found' });

  await deleteAgentVersionFile(req.params.id, version);
  res.status(204).end();
}));

router.get('/:id/diff', asyncHandler(async (req, res) => {
  const v1 = Number(req.query.v1);
  const v2 = Number(req.query.v2);
  if (isNaN(v1) || isNaN(v2)) return res.status(400).json({ error: 'v1 and v2 query params required' });
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  const diff = await db.diffVersions(req.params.id, v1, v2);
  res.json(diff);
}));

// ---- Sharing ----

router.post('/:id/share', requireAuth, asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const shareToken = agent.shareToken || crypto.randomBytes(12).toString('hex');
  const sharePassword = req.body?.password || undefined;

  const updated = await db.updateAgent(req.params.id, { shareToken, sharePassword });
  res.json({
    token: shareToken,
    password: sharePassword,
    url: `${inferAccessUrl(req, normalizeRoutePrefix(process.env.URI_PREFIX || '/getagents'))}/share/${shareToken}`,
  });
}));

router.delete('/:id/share', requireAuth, asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  await db.updateAgent(req.params.id, { shareToken: undefined, sharePassword: undefined });
  res.status(204).end();
}));

export default router;