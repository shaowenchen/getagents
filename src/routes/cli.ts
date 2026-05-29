import { Router, type Request, type Response } from 'express';
import { requireUploadAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as db from '../db/store.js';
import { commitDirectAgentUpload, createDirectAgentUpload, hashAgentFile, saveAgentFileFromPath, supportsDirectAgentUpload } from '../utils/fileStore.js';
import { cleanupUploadedFile, createZipUpload, normalizeAgentName, validateAgentName, validateAgentType, validateManagedTags, validateUploadSize } from './agentMetadata.js';

const router = Router();
const upload = createZipUpload();

router.get('/ping', requireUploadAuth, (req: Request, res: Response) => {
  res.json({ ok: true, userId: (req as any).userId, authVia: (req as any).authVia || 'jwt' });
});

function directUploadUnavailable(res: Response, reason: string): void {
  res.json({ direct: false, reason });
}

router.post('/upload/direct/init', requireUploadAuth, asyncHandler(async (req, res) => {
  if (!supportsDirectAgentUpload()) return directUploadUnavailable(res, 'S3 storage is not enabled');

  const userId = (req as any).userId as string;
  const rawName = (req.body.name || '').toString().trim();
  const agentId = (req.body.agentId || '').toString().trim();
  if (!agentId && !rawName) return res.status(400).json({ error: 'name or agentId is required' });
  try {
    if (agentId) {
      const target = await db.getAgent(agentId);
      if (!target) return res.status(404).json({ error: `Agent ${agentId} not found` });
      if (target.userId !== userId) return res.status(403).json({ error: 'Not your agent' });
    }
    if (rawName) {
      if (agentId) await validateAgentName(userId, rawName, agentId);
      else normalizeAgentName(rawName);
    }
    if (req.body.fileSize !== undefined) validateUploadSize(req.body.fileSize);
    await validateAgentType(userId, req.body.type);
    await validateManagedTags(userId, req.body.tags);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid agent metadata' });
  }

  const filename = (req.body.filename || 'agent.zip').toString();
  const upload = await createDirectAgentUpload(userId, filename);
  res.json({ direct: true, ...upload });
}));

router.post('/upload/direct/complete', requireUploadAuth, asyncHandler(async (req, res) => {
  if (!supportsDirectAgentUpload()) return directUploadUnavailable(res, 'S3 storage is not enabled');

  const userId = (req as any).userId as string;
  const rawName = (req.body.name || '').toString().trim();
  const agentId = (req.body.agentId || '').toString().trim();
  const description = (req.body.description || '').toString();
  const directKey = (req.body.directKey || '').toString();
  const filename = (req.body.filename || `${rawName || 'agent'}.zip`).toString();
  let fileSize: number;
  const fileHash = (req.body.fileHash || '').toString();
  if (!directKey || !fileHash) {
    return res.status(400).json({ error: 'directKey, fileSize, and fileHash are required' });
  }

  let name = rawName;
  let type: string;
  let tags: string[] | undefined;
  try {
    if (rawName) name = agentId ? await validateAgentName(userId, rawName, agentId) : normalizeAgentName(rawName);
    fileSize = validateUploadSize(req.body.fileSize);
    type = await validateAgentType(userId, req.body.type);
    tags = await validateManagedTags(userId, req.body.tags);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid agent metadata' });
  }

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

  if (!target) {
    name = await validateAgentName(userId, name);
    const agent = await db.createAgent(userId, {
      name,
      type,
      description: description || '',
      filename,
      fileSize,
      fileHash,
      tags,
      isPublic: false,
    });
    try {
      const filePath = await commitDirectAgentUpload(userId, directKey, agent.id, 1);
      await db.updateAgent(agent.id, { filePath });
      await db.createVersion(agent.id, req.body.comment ? String(req.body.comment) : 'Initial CLI upload');
    } catch (err) {
      await db.deleteAgent(agent.id);
      throw err;
    }

    return res.status(201).json({
      action: 'created',
      id: agent.id,
      name: agent.name,
      version: 1,
      fileSize,
      fileHash,
    });
  }

  const versions = await db.getVersions(target.id);
  const nextVersion = (versions[0]?.version ?? 0) + 1;
  const filePath = await commitDirectAgentUpload(userId, directKey, target.id, nextVersion);

  const patch: Record<string, unknown> = { filename, filePath, fileSize, fileHash };
  if (description) patch.description = description;
  if (req.body.type !== undefined) patch.type = type;
  if (tags !== undefined) patch.tags = tags;

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

router.post('/upload', requireUploadAuth, upload.single('agentFile'), asyncHandler(async (req, res) => {
  const userId = (req as any).userId as string;
  if (!req.file) return res.status(400).json({ error: 'agentFile (ZIP) is required' });

  try {
    const rawName = (req.body.name || '').toString().trim();
    const agentId = (req.body.agentId || '').toString().trim();
    const description = (req.body.description || '').toString();
    let name = rawName;
    let type: string;
    let tags: string[] | undefined;
    try {
      if (rawName) name = agentId ? await validateAgentName(userId, rawName, agentId) : normalizeAgentName(rawName);
      type = await validateAgentType(userId, req.body.type);
      tags = await validateManagedTags(userId, req.body.tags);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid agent metadata' });
    }
    const versionComment = req.body.comment ? String(req.body.comment) : undefined;

    const fileHash = await hashAgentFile(req.file.path);
    const fileSize = req.file.size;
    const filename = req.file.originalname || `${name || 'agent'}.zip`;

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

    if (!target) {
      name = await validateAgentName(userId, name);
      const agent = await db.createAgent(userId, {
        name,
        type,
        description: description || '',
        filename,
        fileSize,
        fileHash,
        tags,
        isPublic: false,
      });
      const filePath = await saveAgentFileFromPath(agent.id, 1, req.file.path);
      await db.updateAgent(agent.id, { filePath });
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

    const versions = await db.getVersions(target.id);
    const nextVersion = (versions[0]?.version ?? 0) + 1;
    const filePath = await saveAgentFileFromPath(target.id, nextVersion, req.file.path);

    const patch: Record<string, unknown> = {
      filename,
      filePath,
      fileSize,
      fileHash,
    };
    if (description) patch.description = description;
    if (req.body.type !== undefined) patch.type = type;
    if (tags !== undefined) patch.tags = tags;

    const updated = await db.updateAgent(target.id, patch);
    return res.json({
      action: 'updated',
      id: target.id,
      name: updated?.name ?? target.name,
      version: nextVersion,
      fileSize,
      fileHash,
    });
  } finally {
    await cleanupUploadedFile(req.file);
  }
}));

export default router;
