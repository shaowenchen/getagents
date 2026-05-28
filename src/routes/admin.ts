import { Router } from 'express';
import bcrypt from 'bcrypt';
import { createAuthToken, invalidateApiKeyCache, requireAuth } from '../middleware/adminAuth.js';
import {
  createManagedAgentType,
  createManagedTag,
  createUser,
  deleteManagedAgentType,
  deleteManagedTag,
  getAllUsers,
  getManagedAgentTypes,
  getManagedTags,
  getUserById,
  getUserByUsername,
  updateManagedAgentType,
  updateUserKeys,
} from '../db/store.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { createLogger } from '../utils/logger.js';
import { generateUserKey, generateUserKeys, hashUserKeys, type UserKeyKind } from '../utils/userKeys.js';

const log = createLogger('admin-route');
const router = Router();
const DEFAULT_EXTRA_ADMIN_API_KEY = 'user-adminAPIKeyChangeMe0000000000000';
const USERNAME_PATTERN = /^[a-z0-9]{8,20}$/;
const USERNAME_RULE_MESSAGE = 'username must be 8-20 characters and contain only lowercase letters and numbers';

function parseBackupDirs(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((dir) => String(dir).trim()).filter(Boolean))];
  return String(value || '')
    .split(/\r?\n|,/)
    .map((dir) => dir.trim())
    .filter(Boolean);
}

async function requireSystemAdmin(req: any, res: any): Promise<boolean> {
  const user = await getUserById(req.userId);
  if (user?.username !== 'admin') {
    res.status(403).json({ error: 'Admin user required' });
    return false;
  }
  return true;
}

function extraAdminApiKey(): string {
  return process.env.ADMIN_API_KEY || DEFAULT_EXTRA_ADMIN_API_KEY;
}

function isExtraAdminLoginKey(apiKey: unknown): boolean {
  const value = typeof apiKey === 'string' ? apiKey : '';
  const extraKey = extraAdminApiKey();
  return Boolean(value && extraKey && value === extraKey);
}

function loginResponse(user: Awaited<ReturnType<typeof getUserByUsername>>, apiKey: unknown) {
  if (!user) throw new Error('User is required');
  return {
    token: createAuthToken(user.id),
    userId: user.id,
    username: user.username,
    apiKey: user.loginKey || String(apiKey),
    loginKey: user.loginKey || String(apiKey),
    uploadKey: user.uploadKey || '',
    downloadKey: user.downloadKey || '',
  };
}

function parseKeyKind(value: unknown): UserKeyKind | 'all' {
  const kind = String(value || 'all');
  if (kind === 'login' || kind === 'upload' || kind === 'download' || kind === 'all') return kind;
  throw new Error('keyType must be one of login, upload, download, all');
}

async function resetUserKeys(userId: string, keyType: UserKeyKind | 'all') {
  if (keyType === 'all') {
    const keys = generateUserKeys();
    const hashes = await hashUserKeys(keys);
    await updateUserKeys(userId, {
      loginKey: keys.loginKey,
      loginKeyHash: hashes.loginKeyHash,
      uploadKey: keys.uploadKey,
      uploadKeyHash: hashes.uploadKeyHash,
      downloadKey: keys.downloadKey,
      downloadKeyHash: hashes.downloadKeyHash,
    });
    return keys;
  }

  const key = generateUserKey(keyType);
  const hash = await bcrypt.hash(key, 10);
  await updateUserKeys(userId, {
    ...(keyType === 'login' ? { loginKey: key, loginKeyHash: hash } : {}),
    ...(keyType === 'upload' ? { uploadKey: key, uploadKeyHash: hash } : {}),
    ...(keyType === 'download' ? { downloadKey: key, downloadKeyHash: hash } : {}),
  });
  return {
    ...(keyType === 'login' ? { loginKey: key } : {}),
    ...(keyType === 'upload' ? { uploadKey: key } : {}),
    ...(keyType === 'download' ? { downloadKey: key } : {}),
  };
}

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

router.get('/types', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const types = await getManagedAgentTypes(userId);
  res.json(types);
}));

router.post('/types', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const name = String(req.body?.name || '').trim();
  const backupDirs = parseBackupDirs(req.body?.backupDirs);
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (name.length > 32) return res.status(400).json({ error: 'type name must be 32 characters or less' });
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'type name can only contain letters, numbers, underscores, and dashes' });
  if (!backupDirs.length) return res.status(400).json({ error: 'at least one backup directory is required' });

  const type = await createManagedAgentType(userId, name, backupDirs);
  res.status(201).json(type);
}));

router.put('/types/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  const name = req.body?.name === undefined ? undefined : String(req.body.name || '').trim();
  const backupDirs = req.body?.backupDirs === undefined ? undefined : parseBackupDirs(req.body.backupDirs);
  if (name !== undefined && !name) return res.status(400).json({ error: 'name is required' });
  if (name !== undefined && name.length > 32) return res.status(400).json({ error: 'type name must be 32 characters or less' });
  if (name !== undefined && !/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'type name can only contain letters, numbers, underscores, and dashes' });
  if (backupDirs !== undefined && !backupDirs.length) return res.status(400).json({ error: 'at least one backup directory is required' });

  const type = await updateManagedAgentType(userId, req.params.id, { name, backupDirs });
  if (!type) return res.status(404).json({ error: 'Type not found' });
  res.json(type);
}));

router.delete('/types/:id', requireAuth, asyncHandler(async (req, res) => {
  const userId = (req as any).userId;
  if (!await deleteManagedAgentType(userId, req.params.id)) {
    return res.status(404).json({ error: 'Type not found' });
  }
  res.status(204).end();
}));

router.get('/users', requireAuth, asyncHandler(async (req, res) => {
  if (!await requireSystemAdmin(req as any, res)) return;
  const users = await getAllUsers();
  res.json(users.map(({ loginKeyHash: _loginKeyHash, uploadKeyHash: _uploadKeyHash, downloadKeyHash: _downloadKeyHash, loginKey: _loginKey, uploadKey: _uploadKey, downloadKey: _downloadKey, ...user }) => user));
}));

router.post('/users/:id/reset-api-key', requireAuth, asyncHandler(async (req, res) => {
  if (!await requireSystemAdmin(req as any, res)) return;
  const target = await getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });

  let keyType: UserKeyKind | 'all';
  try {
    keyType = parseKeyKind(req.body?.keyType);
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid key type' });
  }

  const keys = await resetUserKeys(target.id, keyType);
  invalidateApiKeyCache();
  log.info('User API key reset', { username: target.username, userId: target.id, keyType, resetBy: (req as any).userId });
  res.json({ userId: target.id, username: target.username, keyType, apiKey: keys.loginKey, ...keys });
}));

router.post('/keys/:keyType/reset', requireAuth, asyncHandler(async (req, res) => {
  let keyType: UserKeyKind;
  try {
    const parsed = parseKeyKind(req.params.keyType);
    if (parsed === 'all') throw new Error('keyType must be one of login, upload, download');
    keyType = parsed;
  } catch (err) {
    return res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid key type' });
  }

  const user = await getUserById((req as any).userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const keys = await resetUserKeys(user.id, keyType);
  invalidateApiKeyCache();
  log.info('User reset own API key', { username: user.username, userId: user.id, keyType });
  res.json({ userId: user.id, username: user.username, keyType, apiKey: keys.loginKey, ...keys });
}));

router.post('/register', asyncHandler(async (req, res) => {
  const { username } = req.body || {};
  const normalizedUsername = typeof username === 'string' ? username.trim() : '';
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    log.warn('Register attempt with invalid username', { username });
    return res.status(400).json({ error: USERNAME_RULE_MESSAGE });
  }

  const existing = await getUserByUsername(normalizedUsername);
  if (existing) {
    log.warn('Register attempt with taken username', { username: normalizedUsername });
    return res.status(409).json({ error: 'Username already taken' });
  }

  const keys = generateUserKeys();
  const hashes = await hashUserKeys(keys);
  const user = await createUser(normalizedUsername, hashes.loginKeyHash, {
    loginKey: keys.loginKey,
    uploadKey: keys.uploadKey,
    uploadKeyHash: hashes.uploadKeyHash,
    downloadKey: keys.downloadKey,
    downloadKeyHash: hashes.downloadKeyHash,
  });
  const token = createAuthToken(user.id);
  log.info('User registered', { username: user.username, userId: user.id });
  res.status(201).json({ token, userId: user.id, username: user.username, apiKey: keys.loginKey, loginKey: keys.loginKey, uploadKey: keys.uploadKey, downloadKey: keys.downloadKey });
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

  if (isExtraAdminLoginKey(apiKey)) {
    const admin = await getUserByUsername('admin');
    if (admin) {
      log.info('Admin logged in with extra ADMIN_API_KEY');
      return res.json(loginResponse(admin, admin.loginKey || apiKey));
    }
  }

  for (const user of users) {
    log.debug('Comparing against user', { username: user.username, userId: user.id });
    try {
      const valid = await bcrypt.compare(
        typeof apiKey === 'string' ? apiKey : '',
        user.loginKeyHash
      );
      log.debug('bcrypt compare result', { username: user.username, valid });
      if (valid) {
        log.info('Login successful', { username: user.username });
        return res.json(loginResponse(user, apiKey));
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