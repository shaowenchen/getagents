import { Router, type Request } from 'express';
import * as db from '../db/store.js';
import { requireAuth } from '../middleware/adminAuth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { copyAgentFiles } from '../utils/fileStore.js';
import type { AgentConfig } from '../shared/types.js';

const router = Router();

router.get('/', asyncHandler(async (req, res) => {
  const { search, category, tag, sort } = req.query;
  let agents = await db.getPublicAgents();

  if (typeof search === 'string' && search.trim()) {
    const q = search.trim().toLowerCase();
    agents = agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      (a.description && a.description.toLowerCase().includes(q))
    );
  }

  if (typeof category === 'string' && category.trim()) {
    agents = agents.filter(a => a.category === category.trim());
  }

  if (typeof tag === 'string' && tag.trim()) {
    agents = agents.filter(a => a.tags?.includes(tag.trim()));
  }

  if (sort === 'newest') {
    agents.sort((a, b) => b.updatedAt - a.updatedAt);
  } else if (sort === 'name') {
    agents.sort((a, b) => a.name.localeCompare(b.name));
  }

  res.json(agents);
}));

router.get('/categories', asyncHandler(async (_req, res) => {
  const agents = await db.getPublicAgents();
  const categories = [...new Set(agents.map(a => a.category).filter(Boolean))].sort();
  const tags = [...new Set(agents.flatMap(a => a.tags || []).filter(Boolean))].sort();
  res.json({ categories, tags });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const agent = await db.getAgent(req.params.id);
  if (!agent || !agent.isPublic || !agent.enabled) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json(agent);
}));

router.post('/:id/install', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const source = await db.getAgent(req.params.id);
  if (!source || !source.isPublic) {
    return res.status(404).json({ error: 'Agent not found or not public' });
  }

  // Increment download count on source
  await db.updateAgent(source.id, { downloadCount: (source.downloadCount || 0) + 1 });

  // Create a copy for the current user
  const newAgent = await db.createAgent(userId, {
    name: source.name,
    description: source.description,
    filename: source.filename,
    fileSize: source.fileSize,
    fileHash: source.fileHash,
    tags: source.tags,
    category: source.category,
    enabled: true,
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
  if (!agent || !agent.isPublic) {
    return res.status(404).json({ error: 'Agent not found or not public' });
  }
  const updated = await db.updateAgent(req.params.id, { likesCount: (agent.likesCount || 0) + 1 });
  res.json({ likesCount: updated?.likesCount || 0 });
}));

export default router;