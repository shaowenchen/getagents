import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { requireAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as db from '../db/store.js';
import { saveAgentFile } from '../utils/fileStore.js';

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

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value).split(',').map((t) => t.trim()).filter(Boolean);
}

async function validateManagedTags(userId: string, tags: string[] | undefined): Promise<string[] | undefined> {
  if (tags === undefined) return undefined;
  const allowed = new Set((await db.getManagedTags(userId)).map((tag) => tag.name));
  const invalid = tags.filter((tag) => !allowed.has(tag));
  if (invalid.length) {
    throw new Error(`Unknown tags: ${invalid.join(', ')}`);
  }
  return [...new Set(tags)];
}

function parseBool(value: unknown, defaultValue: boolean): boolean {
  if (value === undefined || value === null || value === '') return defaultValue;
  return value === 'true' || value === true || value === '1' || value === 1;
}

async function validateAgentType(userId: string, value: unknown): Promise<string> {
  const type = String(value || 'workspace').trim();
  const allowed = new Set((await db.getManagedAgentTypes(userId)).map((item) => item.name));
  if (!allowed.has(type)) throw new Error(`Unknown type: ${type}`);
  return type;
}

router.get('/ping', requireAuth, (req: Request, res: Response) => {
  res.json({ ok: true, userId: (req as any).userId, authVia: (req as any).authVia || 'jwt' });
});

router.post('/upload', requireAuth, upload.single('agentFile'), asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string;
  if (!req.file) return res.status(400).json({ error: 'agentFile (ZIP) is required' });

  const name = (req.body.name || '').toString().trim();
  const agentId = (req.body.agentId || req.body.id || '').toString().trim();
  const description = (req.body.description || '').toString();
  let type: string;
  let tags: string[] | undefined;
  try {
    type = await validateAgentType(userId, req.body.type);
    tags = await validateManagedTags(userId, parseTags(req.body.tags));
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid agent metadata' });
  }
  const enabled = parseBool(req.body.enabled, true);
  const isPublic = parseBool(req.body.isPublic, false);
  const versionComment = req.body.comment ? String(req.body.comment) : undefined;

  const fileHash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
  const fileSize = req.file.size;
  const filename = req.file.originalname || `${name || 'agent'}.zip`;

  // Resolve target agent
  let target: Awaited<ReturnType<typeof db.getAgent>> | undefined;
  if (agentId) {
    target = await db.getAgent(agentId);
    if (!target) return res.status(404).json({ error: `Agent ${agentId} not found` });
    if (target.userId !== userId) return res.status(403).json({ error: 'Not your agent' });
  } else if (name) {
    const mine = await db.getAllAgents(userId);
    target = mine.find((a) => a.name === name);
  } else {
    return res.status(400).json({ error: 'name or agentId is required' });
  }

  // ---- Create new agent ----
  if (!target) {
    const agent = await db.createAgent(userId, {
      name,
      type,
      description: description || `Uploaded via CLI on ${new Date().toISOString()}`,
      filename,
      fileSize,
      fileHash,
      enabled,
      tags,
      isPublic,
    });
    await saveAgentFile(agent.id, 1, req.file.buffer);
    await db.createVersion(agent.id, versionComment || 'Initial CLI upload');

    return res.status(201).json({
      action: 'created',
      id: agent.id,
      name: agent.name,
      version: 1,
      fileSize,
      fileHash,
    });
  }

  // ---- Update existing agent ----
  const versions = await db.getVersions(target.id);
  const nextVersion = (versions[0]?.version ?? 0) + 1;
  await saveAgentFile(target.id, nextVersion, req.file.buffer);

  const patch: Record<string, unknown> = {
    filename,
    fileSize,
    fileHash,
  };
  if (description) patch.description = description;
  if (req.body.type !== undefined) patch.type = type;
  if (tags !== undefined) patch.tags = tags;
  if (req.body.enabled !== undefined) patch.enabled = enabled;
  if (req.body.isPublic !== undefined) patch.isPublic = isPublic;

  const updated = await db.updateAgent(target.id, patch);
  return res.json({
    action: 'updated',
    id: target.id,
    name: updated?.name ?? target.name,
    version: nextVersion,
    fileSize,
    fileHash,
  });
}));

export default router;
