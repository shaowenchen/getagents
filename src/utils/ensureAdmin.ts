import bcrypt from 'bcrypt';
import { getUserByUsername, createUser, getAllUsers } from '../db/store.js';
import { createLogger } from './logger.js';

const log = createLogger('ensureAdmin');

const ADMIN_USERNAME = 'admin';

export async function ensureAdminUser(adminApiKey: string) {
  log.info('Ensuring admin user exists', {
    adminApiKeyPrefix: adminApiKey.slice(0, 8),
    adminApiKeyLength: adminApiKey.length,
  });

  // First, check all users for debugging
  const allUsers = await getAllUsers();
  log.debug('Current users in DB', { count: allUsers.length, users: allUsers.map(u => u.username) });

  const existing = await getUserByUsername(ADMIN_USERNAME);

  if (existing) {
    log.debug('Admin user already exists', { username: existing.username, userId: existing.id });
    return { username: existing.username, created: false };
  }

  log.info('Creating admin user', { username: ADMIN_USERNAME });
  const passwordHash = await bcrypt.hash(adminApiKey, 10);
  const user = await createUser(ADMIN_USERNAME, passwordHash);
  log.info('Admin user created', { username: user.username, userId: user.id });

  // Verify the hash works
  const verify = await bcrypt.compare(adminApiKey, passwordHash);
  log.debug('Hash verification self-test', { ok: verify });

  return { username: user.username, created: true };
}