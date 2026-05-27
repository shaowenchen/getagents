import { getUserByUsername, createUser, getAllUsers, updateUserKeys } from '../db/store.js';
import { invalidateApiKeyCache } from '../middleware/adminAuth.js';
import { createLogger } from './logger.js';
import { generateUserKeys, hashUserKeys } from './userKeys.js';

const log = createLogger('ensureAdmin');

const ADMIN_USERNAME = 'admin';

export async function ensureAdminUser(adminApiKey: string) {
  log.info('Ensuring admin user exists', {
    hasExtraAdminLoginKey: Boolean(adminApiKey),
  });

  // First, check all users for debugging
  const allUsers = await getAllUsers();
  log.debug('Current users in DB', { count: allUsers.length, users: allUsers.map(u => u.username) });

  const existing = await getUserByUsername(ADMIN_USERNAME);

  if (existing) {
    const hasNormalKeys = Boolean(
      existing.loginKey &&
      existing.uploadKey &&
      existing.downloadKey &&
      existing.loginKey !== adminApiKey &&
      !existing.uploadKey.startsWith('up-admin-') &&
      !existing.downloadKey.startsWith('down-admin-')
    );
    if (hasNormalKeys) {
      log.debug('Admin user already exists with generated API keys', { username: existing.username, userId: existing.id });
      return { username: existing.username, created: false, updated: false };
    }

    log.info('Generating normal admin API keys', { username: existing.username, userId: existing.id });
    const keys = generateUserKeys();
    const hashes = await hashUserKeys(keys);
    await updateUserKeys(existing.id, {
      loginKey: keys.loginKey,
      loginKeyHash: hashes.loginKeyHash,
      uploadKey: keys.uploadKey,
      uploadKeyHash: hashes.uploadKeyHash,
      downloadKey: keys.downloadKey,
      downloadKeyHash: hashes.downloadKeyHash,
    });
    invalidateApiKeyCache();
    return { username: existing.username, created: false, updated: true };
  }

  log.info('Creating admin user', { username: ADMIN_USERNAME });
  const keys = generateUserKeys();
  const hashes = await hashUserKeys(keys);
  const user = await createUser(ADMIN_USERNAME, hashes.loginKeyHash, {
    loginKey: keys.loginKey,
    uploadKey: keys.uploadKey,
    uploadKeyHash: hashes.uploadKeyHash,
    downloadKey: keys.downloadKey,
    downloadKeyHash: hashes.downloadKeyHash,
  });
  log.info('Admin user created', { username: user.username, userId: user.id });

  return { username: user.username, created: true };
}