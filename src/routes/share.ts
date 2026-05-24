import { Router } from 'express';
import * as db from '../db/store.js';
import { requireAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { copyAgentFiles } from '../utils/fileStore.js';

const router = Router();

router.get('/:token', asyncHandler(async (req, res) => {
  const agent = await db.getAgentByShareToken(req.params.token);
  if (!agent) return res.status(404).json({ error: 'Share link not found or expired' });

  if (agent.sharePassword) {
    const provided = req.headers['x-share-password'] || req.query.password || '';
    if (provided !== agent.sharePassword) {
      return res.status(401).json({ error: 'Password required', passwordProtected: true });
    }
  }

  res.json(agent);
}));

router.post('/:token/install', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const agent = await db.getAgentByShareToken(req.params.token);
  if (!agent) return res.status(404).json({ error: 'Share link not found or expired' });

  if (agent.sharePassword) {
    const provided = req.headers['x-share-password'] || req.query.password || req.body?.password || '';
    if (provided !== agent.sharePassword) {
      return res.status(401).json({ error: 'Password required', passwordProtected: true });
    }
  }

  // Increment download count
  await db.updateAgent(agent.id, { downloadCount: (agent.downloadCount || 0) + 1 });

  // Create copy
  const newAgent = await db.createAgent(userId, {
    name: agent.name,
    description: agent.description,
    filename: agent.filename,
    fileSize: agent.fileSize,
    fileHash: agent.fileHash,
    tags: agent.tags,
    category: agent.category,
    enabled: true,
    isPublic: false,
  });

  // Copy files from source
  await copyAgentFiles(agent.id, newAgent.id);
  await db.recordImport(newAgent.id, 'share');

  res.status(201).json(newAgent);
}));

export default router;