import { Router, type Request } from 'express';
import * as db from '../db/store.js';
import { requireAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { saveAgentFile, getAgentFileStream, copyAgentFiles, deleteAgentFiles } from '../utils/fileStore.js';
import { inferAccessUrl, normalizeRoutePrefix } from '../utils/accessUrl.js';
import type { AgentConfig } from '../shared/types.js';
import crypto from 'crypto';
import multer from 'multer';
import { existsSync } from 'fs';

const router = Router();

const maxUploadSize = Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxUploadSize },
  fileFilter: (_req, file, cb) => {
    if (!file.originalname.toLowerCase().endsWith('.zip') && file.mimetype !== 'application/zip') {
      cb(new Error('Only ZIP files are allowed'));
      return;
    }
    cb(null, true);
  },
});

function parseTagInput(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((t) => String(t).trim()).filter(Boolean);
  return String(value).split(',').map((t) => t.trim()).filter(Boolean);
}

async function validateManagedTags(userId: string, value: unknown): Promise<string[] | undefined> {
  const tags = parseTagInput(value);
  if (tags === undefined) return undefined;

  const allowed = new Set((await db.getManagedTags(userId)).map((tag) => tag.name));
  const invalid = tags.filter((tag) => !allowed.has(tag));
  if (invalid.length) {
    throw new Error(`Unknown tags: ${invalid.join(', ')}`);
  }

  return [...new Set(tags)];
}

// ---- Agent CRUD ----

router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const agents = await db.getAllAgents(userId);
  res.json(agents);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
}));

router.post('/', requireAuth, upload.single('agentFile'), asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const { name, description, tags, isPublic, avatar } = req.body;
  if (!name || !description) {
    return res.status(400).json({ error: 'name and description are required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'agentFile (ZIP) is required' });
  }

  const enabled = req.body.enabled === undefined ? true : req.body.enabled === 'true' || req.body.enabled === true;
  let selectedTags: string[] | undefined;
  try {
    selectedTags = await validateManagedTags(userId, tags);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid tags' });
  }

  // Create the agent record first to get an ID
  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const agent = await db.createAgent(userId, {
    name,
    description: description || '',
    filename: req.file.originalname,
    fileSize: req.file.size,
    fileHash,
    enabled,
    avatar,
    tags: selectedTags,
    isPublic: isPublic === 'true' || isPublic === true,
  });

  // Save file to disk (version 1)
  await saveAgentFile(agent.id, 1, req.file.buffer);
  // Create initial version record
  await db.createVersion(agent.id, 'Initial upload');

  res.status(201).json(agent);
}));

router.put('/:id', requireAuth, upload.single('agentFile'), asyncHandler(async (req, res) => {
  const existing = await db.getAgent(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Agent not found' });

  const patch: Partial<AgentConfig> = {};
  if (req.body.name !== undefined) patch.name = req.body.name;
  if (req.body.description !== undefined) patch.description = req.body.description;
  if (req.body.enabled !== undefined) patch.enabled = req.body.enabled === 'true' || req.body.enabled === true;
  if (req.body.isPublic !== undefined) patch.isPublic = req.body.isPublic === 'true' || req.body.isPublic === true;
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
    patch.fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');

    // Get next version number and save file
    const versions = await db.getVersions(req.params.id);
    const nextVersion = (versions[0]?.version ?? 0) + 1;
    await saveAgentFile(req.params.id, nextVersion, req.file.buffer);
  }

  const agent = await db.updateAgent(req.params.id, patch);
  res.json(agent);
}));

router.delete('/:id', requireAuth, asyncHandler(async (req, res) => {
  if (!await db.deleteAgent(req.params.id)) return res.status(404).json({ error: 'Agent not found' });
  res.status(204).end();
}));

// ---- File Download ----

router.get('/:id/download', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const stream = await getAgentFileStream(req.params.id);
  if (!stream) return res.status(404).json({ error: 'Agent file not found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${agent.filename}"`);
  res.setHeader('Content-Length', agent.fileSize);
  stream.pipe(res);
}));

router.get('/:id/download/:version', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

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

router.post('/:id/rollback', requireAuth, asyncHandler(async (req, res) => {
  const { version } = req.body;
  if (version === undefined) return res.status(400).json({ error: 'version is required' });
  const agent = await db.rollbackToVersion(req.params.id, Number(version));
  if (!agent) return res.status(404).json({ error: 'Agent or version not found' });
  res.json(agent);
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