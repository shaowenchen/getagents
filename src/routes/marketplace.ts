import { Router, type Request } from 'express';
import * as db from '../db/store.js';
import { requireAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { copyAgentFiles } from '../utils/fileStore.js';
import type { AgentConfig } from '../shared/types.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const { search, tag, type, sort } = req.query;
  let agents = await db.getPublicAgents();

  if (typeof search === 'string' && search.trim()) {
    const q = search.trim().toLowerCase();
    agents = agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      (a.description && a.description.toLowerCase().includes(q))
    );
  }

  if (typeof tag === 'string' && tag.trim()) {
    agents = agents.filter(a => a.tags?.includes(tag.trim()));
  }

  if (typeof type === 'string' && type.trim()) {
    agents = agents.filter(a => a.type === type.trim());
  }

  if (sort === 'newest') {
    agents.sort((a, b) => b.updatedAt - a.updatedAt);
  } else if (sort === 'name') {
    agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  res.json(agents);
}));

router.get('/tags', asyncHandler(async (_req, res) => {
  const agents = await db.getPublicAgents();
  const tags = [...new Set(agents.flatMap(a => a.tags || []).filter(Boolean))].sort();
  res.json({ tags });
}));

router.get('/types', asyncHandler(async (_req, res) => {
  const agents = await db.getPublicAgents();
  const types = [...new Set(agents.map(a => a.type || 'currentdir').filter(Boolean))].sort();
  res.json({ types });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  const published = agent ? await db.getPublishedVersion(req.params.id) : undefined;
  if (!agent || !published) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json(agent);
}));

router.post('/:id/install', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const source = await db.getAgent(req.params.id);
  const published = source ? await db.getPublishedVersion(req.params.id) : undefined;
  if (!source || !published) {
    return res.status(404).json({ error: 'Agent not found or not released' });
  }

  // Increment download count on source
  await db.updateAgent(source.id, { downloadCount: (source.downloadCount || 0) + 1 });

  // Create a copy for the current user
  const newAgent = await db.createAgent(userId, {
    name: source.name,
    type: source.type,
    description: source.description,
    filename: source.filename,
    fileSize: source.fileSize,
    fileHash: source.fileHash,
    tags: source.tags,
    isPublic: false,
  });

  // Copy agent files
  await copyAgentFiles(source.id, newAgent.id);

  // Create version record
  await db.createVersion(newAgent.id, 'Installed from marketplace');
  await db.recordImport(newAgent.id, 'marketplace');

  res.status(201).json(newAgent);
}));

router.post('/:id/like', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  const published = agent ? await db.getPublishedVersion(req.params.id) : undefined;
  if (!agent || !published) {
    return res.status(404).json({ error: 'Agent not found or not released' });
  }
  const updated = await db.updateAgent(req.params.id, { likesCount: (agent.likesCount || 0) + 1 });
  res.json({ likesCount: updated?.likesCount || 0 });
}));

export default router;