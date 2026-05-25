import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { createAuthToken, requireAuth } from '../middleware/adminAuth.js';
import {
  createManagedTag,
  createUser,
  deleteManagedTag,
  getAllUsers,
  getManagedTags,
  getUserById,
  getUserByUsername,
} from '../db/store.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('admin-route');
const router = Router();

router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const user = await getUserById((req as any).userId);
  res.json({ authenticated: true, userId: (req as any).userId, username: user?.username });
}));

router.get('/tags', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const tags = await getManagedTags(userId);
  res.json(tags);
}));

router.post('/tags', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 32) return res.status(400).json({ error: 'tag name must be 32 characters or less' });
  if (name.includes(',')) return res.status(400).json({ error: 'tag name cannot contain commas' });

  const tag = await createManagedTag(userId, name);
  res.status(201).json(tag);
}));

router.delete('/tags/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  if (!await deleteManagedTag(userId, req.params.id)) {
    return res.status(404).json({ error: 'Tag not found' });
  }
  res.status(204).end();
}));

router.post('/register', asyncHandler(async (req, res) => {
  const { username } = req.body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 2) {
    log.warn('Register attempt with invalid username', { username });
    return res.status(400).json({ error: 'username must be at least 2 characters' });
  }

  const existing = await getUserByUsername(username.trim());
  if (existing) {
    log.warn('Register attempt with taken username', { username: username.trim() });
    return res.status(409).json({ error: 'Username already taken' });
  }

  const apiKey = `user-${crypto.randomBytes(24).toString('base64url')}`;
  const passwordHash = await bcrypt.hash(apiKey, 10);
  const user = await createUser(username.trim(), passwordHash);
  const token = createAuthToken(user.id);
  log.info('User registered', { username: user.username, userId: user.id });
  res.status(201).json({ token, userId: user.id, username: user.username, apiKey });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) {
    log.warn('Login attempt with empty apiKey');
    return res.status(400).json({ error: 'apiKey is required' });
  }

  const users = await getAllUsers();
  log.debug('Login attempt', {
    apiKeyPrefix: String(apiKey).slice(0, 8),
    apiKeyLength: String(apiKey).length,
    userCount: users.length,
  });

  for (const user of users) {
    log.debug('Comparing against user', { username: user.username, userId: user.id });
    try {
      const valid = await bcrypt.compare(
        typeof apiKey === 'string' ? apiKey : '',
        user.passwordHash
      );
      log.debug('bcrypt compare result', { username: user.username, valid });
      if (valid) {
        const token = createAuthToken(user.id);
        log.info('Login successful', { username: user.username });
        return res.json({ token, userId: user.id, username: user.username });
      }
    } catch (err) {
      log.error('bcrypt compare error', {
        username: user.username,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.warn('Login failed — no matching apiKey', {
    apiKeyPrefix: String(apiKey).slice(0, 8),
    usersChecked: users.length,
  });
  res.status(401).json({ error: 'Invalid API key' });
}));

export default router;