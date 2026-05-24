import { Router } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { createAuthToken, requireAuth } from '../middleware/adminAuth.js';
import { createUser, getUserByUsername, getUserById, getAllUsers } from '../db/store.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

const router = Router();

router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const user = await getUserById((req as any).userId);
  res.json({ authenticated: true, userId: (req as any).userId, username: user?.username });
}));

router.post('/register', asyncHandler(async (req, res) => {
  const { username } = req.body || {};
  if (!username || typeof username !== 'string' || username.trim().length < 2) {
    return res.status(400).json({ error: 'username must be at least 2 characters' });
  }

  const existing = await getUserByUsername(username.trim());
  if (existing) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const apiKey = `user-${crypto.randomBytes(24).toString('base64url')}`;
  const passwordHash = await bcrypt.hash(apiKey, 10);
  const user = await createUser(username.trim(), passwordHash);
  const token = createAuthToken(user.id);
  res.status(201).json({ token, userId: user.id, username: user.username, apiKey });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) {
    return res.status(400).json({ error: 'apiKey is required' });
  }

  const users = await getAllUsers();
  for (const user of users) {
    const valid = await bcrypt.compare(typeof apiKey === 'string' ? apiKey : '', user.passwordHash);
    if (valid) {
      const token = createAuthToken(user.id);
      return res.json({ token, userId: user.id, username: user.username });
    }
  }

  res.status(401).json({ error: 'Invalid API key' });
}));

export default router;