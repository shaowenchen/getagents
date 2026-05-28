import { Router, type Request, type Response } from 'express';
import { requireUploadAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import * as db from '../db/store.js';
import { hashAgentFile, saveAgentFileFromPath } from '../utils/fileStore.js';
import { cleanupUploadedFile, createZipUpload, normalizeAgentName, validateAgentName, validateAgentType, validateManagedTags } from './agentMetadata.js';

const router = Router();
const upload = createZipUpload();

router.get('/ping', requireUploadAuth, (req: Request, res: Response) => {
  res.json({ ok: true, userId: (req as any).userId, authVia: (req as any).authVia || 'jwt' });
});

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
      await saveAgentFileFromPath(agent.id, 1, req.file.path);
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
    await saveAgentFileFromPath(target.id, nextVersion, req.file.path);

    const patch: Record<string, unknown> = {
      filename,
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
