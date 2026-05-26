import mysql, { type Pool, type PoolOptions, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { v4 as uuid } from 'uuid';
import type { AgentConfig, AgentVersion, AgentSnapshot, ManagedAgentType, ManagedTag, User } from '../shared/types.js';
import { deleteAgentFiles } from '../utils/fileStore.js';

const dsn = process.env.SQL_DSN;
const pool: Pool | null = dsn ? mysql.createPool(parseDsn(dsn)) : null;
let ready: Promise<void> | null = null;

async function ensureReady(): Promise<void> {
  if (!pool) throw new Error('SQL_DSN is required for MySQL store');
  ready ??= init().catch((err) => {
    ready = null;
    throw err;
  });
  await ready;
}

async function init(): Promise<void> {
  const db = requirePool();

  // Drop and recreate for clean schema
  await db.query(`DROP TABLE IF EXISTS agent_imports`);
  await db.query(`DROP TABLE IF EXISTS agent_versions`);
  await db.query(`DROP TABLE IF EXISTS agents`);
  await db.query(`DROP TABLE IF EXISTS managed_agent_types`);
  await db.query(`DROP TABLE IF EXISTS managed_tags`);
  await db.query(`DROP TABLE IF EXISTS users`);

  await db.query(`
    CREATE TABLE users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE managed_tags (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(64) NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uniq_managed_tags_user_name (user_id, name),
      CONSTRAINT fk_managed_tags_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE managed_agent_types (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(64) NOT NULL,
      backup_dirs_json JSON NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uniq_managed_agent_types_user_name (user_id, name),
      CONSTRAINT fk_managed_agent_types_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE agents (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      agent_type VARCHAR(32) NOT NULL DEFAULT 'workspace',
      avatar TEXT,
      description TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_size INT NOT NULL DEFAULT 0,
      file_hash VARCHAR(128) NOT NULL,
      enabled TINYINT(1) NOT NULL,
      is_public TINYINT(1) NOT NULL DEFAULT 0,
      tags_json JSON,
      download_count INT NOT NULL DEFAULT 0,
      likes_count INT NOT NULL DEFAULT 0,
      share_token VARCHAR(64),
      share_password VARCHAR(255),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      INDEX idx_agents_user_id (user_id),
      INDEX idx_agents_updated_at (updated_at),
      INDEX idx_agents_public (is_public),
      INDEX idx_agents_share_token (share_token),
      CONSTRAINT fk_agents_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE agent_versions (
      id VARCHAR(64) PRIMARY KEY,
      agent_id VARCHAR(64) NOT NULL,
      version INT NOT NULL,
      snapshot_json JSON NOT NULL,
      comment TEXT,
      created_at BIGINT NOT NULL,
      INDEX idx_agent_versions_agent (agent_id, version),
      CONSTRAINT fk_versions_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE agent_imports (
      id VARCHAR(64) PRIMARY KEY,
      source_type VARCHAR(32) NOT NULL,
      source_url TEXT,
      agent_id VARCHAR(64) NOT NULL,
      imported_at BIGINT NOT NULL,
      CONSTRAINT fk_imports_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function requirePool(): Pool {
  if (!pool) throw new Error('SQL_DSN is required for MySQL store');
  return pool;
}

function parseDsn(value: string): PoolOptions {
  const url = new URL(value);
  const tls = url.searchParams.get('tls');
  const ssl = url.searchParams.get('ssl');

  const options: PoolOptions = {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\/+/, '')),
    waitForConnections: true,
    connectionLimit: Number(url.searchParams.get('connectionLimit') || 10),
  };

  const charset = url.searchParams.get('charset');
  if (charset) options.charset = charset;

  const timezone = url.searchParams.get('timezone');
  if (timezone) options.timezone = timezone;

  if (tls || ssl) {
    const mode = (tls || ssl || '').toLowerCase();
    if (mode !== 'false' && mode !== '0' && mode !== 'disabled') {
      options.ssl = mode === 'skip-verify' ? { rejectUnauthorized: false } : {};
    }
  }

  return options;
}

type AgentRow = RowDataPacket & {
  id: string; user_id: string; name: string; agent_type: string; avatar: string | null; description: string;
  filename: string; file_size: number; file_hash: string;
  enabled: number; is_public: number; tags_json: string | null;
  download_count: number; likes_count: number;
  share_token: string | null; share_password: string | null;
  created_at: number; updated_at: number;
};

type UserRow = RowDataPacket & {
  id: string; username: string; password_hash: string; created_at: number;
};

type ManagedTagRow = RowDataPacket & {
  id: string; user_id: string; name: string; created_at: number;
};

type ManagedAgentTypeRow = RowDataPacket & {
  id: string; user_id: string; name: string; backup_dirs_json: string; created_at: number;
};

type VersionRow = RowDataPacket & {
  id: string; agent_id: string; version: number; snapshot_json: string;
  comment: string | null; created_at: number;
};

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function stringifyOptional(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function toAgent(row: AgentRow): AgentConfig {
  return {
    id: row.id, userId: row.user_id, name: row.name, avatar: row.avatar ?? undefined,
    type: (row.agent_type as AgentConfig['type']) || 'workspace',
    description: row.description, filename: row.filename,
    fileSize: Number(row.file_size || 0), fileHash: row.file_hash,
    enabled: Boolean(row.enabled),
    tags: parseJson<string[] | undefined>(row.tags_json, undefined),
    isPublic: Boolean(row.is_public),
    downloadCount: Number(row.download_count || 0),
    likesCount: Number(row.likes_count || 0),
    shareToken: row.share_token ?? undefined,
    sharePassword: row.share_password ?? undefined,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function toVersion(row: VersionRow): AgentVersion {
  return {
    id: row.id, agentId: row.agent_id, version: Number(row.version),
    snapshot: parseJson<AgentSnapshot>(row.snapshot_json, null as unknown as AgentSnapshot) || {} as AgentSnapshot,
    comment: row.comment ?? undefined,
    createdAt: Number(row.created_at),
  };
}

function toManagedAgentType(row: ManagedAgentTypeRow): ManagedAgentType {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    backupDirs: parseJson<string[]>(row.backup_dirs_json, []),
    createdAt: Number(row.created_at),
  };
}

const defaultAgentTypes = [
  { name: 'workspace', backupDirs: ['${PWD}'] },
  { name: 'cursor', backupDirs: ['${HOME}/.cursor'] },
  { name: 'claude', backupDirs: ['${HOME}/.claude'] },
  { name: 'codex', backupDirs: ['${HOME}/.codex'] },
  { name: 'gemini', backupDirs: ['${HOME}/.gemini'] },
  { name: 'openclaw', backupDirs: ['${HOME}/.openclaw'] },
  { name: 'hermes-agent', backupDirs: ['${HOME}/.hermes-agent'] },
];

function normalizeBackupDirs(value: string[]): string[] {
  return [...new Set(value.map(dir => String(dir).trim()).filter(Boolean))];
}

async function seedDefaultAgentTypes(userId: string): Promise<void> {
  const db = requirePool();
  const now = Date.now();
  for (const type of defaultAgentTypes) {
    await db.execute(
      'INSERT IGNORE INTO managed_agent_types (id, user_id, name, backup_dirs_json, created_at) VALUES (?,?,?,?,?)',
      [uuid(), userId, type.name, JSON.stringify(type.backupDirs), now]
    );
  }
}

function agentSnapshotFields(agent: AgentConfig): Record<string, unknown> {
  return {
    name: agent.name,
    type: agent.type,
    description: agent.description,
    filename: agent.filename,
    fileSize: agent.fileSize,
    fileHash: agent.fileHash,
    tags: agent.tags,
    avatar: agent.avatar,
  };
}

async function saveAgent(agent: AgentConfig): Promise<void> {
  await ensureReady();
  const db = requirePool();
  await db.execute(`
    INSERT INTO agents (
      id, user_id, name, agent_type, avatar, description, filename, file_size, file_hash,
      enabled, is_public, tags_json, download_count, likes_count,
      share_token, share_password, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      name=VALUES(name), agent_type=VALUES(agent_type), avatar=VALUES(avatar), description=VALUES(description),
      filename=VALUES(filename), file_size=VALUES(file_size), file_hash=VALUES(file_hash),
      enabled=VALUES(enabled), is_public=VALUES(is_public),
      tags_json=VALUES(tags_json),
      download_count=VALUES(download_count), likes_count=VALUES(likes_count),
      share_token=VALUES(share_token), share_password=VALUES(share_password),
      updated_at=VALUES(updated_at)
  `, [
    agent.id, agent.userId, agent.name, agent.type, agent.avatar ?? null, agent.description,
    agent.filename, agent.fileSize, agent.fileHash,
    agent.enabled ? 1 : 0, agent.isPublic ? 1 : 0,
    stringifyOptional(agent.tags),
    agent.downloadCount || 0, agent.likesCount || 0,
    agent.shareToken ?? null, agent.sharePassword ?? null,
    agent.createdAt, agent.updatedAt,
  ]);
}

// ---- Users ----

export async function createUser(username: string, passwordHash: string): Promise<User> {
  await ensureReady();
  const db = requirePool();
  const id = uuid();
  const now = Date.now();
  await db.execute(
    'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?,?,?,?,?)',
    [id, username, passwordHash, now, now]
  );
  return { id, username, createdAt: now };
}

export async function getUserByUsername(username: string): Promise<(User & { passwordHash: string }) | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<UserRow[]>('SELECT * FROM users WHERE username = ?', [username]);
  if (!rows[0]) return undefined;
  return {
    id: rows[0].id,
    username: rows[0].username,
    passwordHash: rows[0].password_hash,
    createdAt: Number(rows[0].created_at),
  };
}

export async function getUserById(id: string): Promise<User | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<UserRow[]>('SELECT id, username, created_at FROM users WHERE id = ?', [id]);
  if (!rows[0]) return undefined;
  return { id: rows[0].id, username: rows[0].username, createdAt: Number(rows[0].created_at) };
}

export async function getAllUsers(): Promise<(User & { passwordHash: string })[]> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.query<UserRow[]>('SELECT id, username, password_hash, created_at FROM users');
  return rows.map(r => ({
    id: r.id, username: r.username, passwordHash: r.password_hash, createdAt: Number(r.created_at),
  }));
}

export async function updateUserPasswordHash(userId: string, passwordHash: string): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const [result] = await db.execute<ResultSetHeader>(
    'UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    [passwordHash, Date.now(), userId]
  );
  return result.affectedRows > 0;
}

// ---- Managed Tags ----

function toManagedTag(row: ManagedTagRow): ManagedTag {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    createdAt: Number(row.created_at),
  };
}

export async function getManagedTags(userId: string): Promise<ManagedTag[]> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<ManagedTagRow[]>(
    'SELECT * FROM managed_tags WHERE user_id = ? ORDER BY name',
    [userId]
  );
  return rows.map(toManagedTag);
}

export async function createManagedTag(userId: string, name: string): Promise<ManagedTag> {
  await ensureReady();
  const db = requirePool();
  const normalized = name.trim();
  if (!normalized) throw new Error('Tag name is required');

  const [existing] = await db.execute<ManagedTagRow[]>(
    'SELECT * FROM managed_tags WHERE user_id = ? AND name = ?',
    [userId, normalized]
  );
  if (existing[0]) return toManagedTag(existing[0]);

  const id = uuid();
  const now = Date.now();
  await db.execute(
    'INSERT INTO managed_tags (id,user_id,name,created_at) VALUES (?,?,?,?)',
    [id, userId, normalized, now]
  );
  return { id, userId, name: normalized, createdAt: now };
}

export async function deleteManagedTag(userId: string, tagId: string): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<ManagedTagRow[]>(
    'SELECT * FROM managed_tags WHERE id = ? AND user_id = ?',
    [tagId, userId]
  );
  const tag = rows[0];
  if (!tag) return false;

  const [result] = await db.execute<ResultSetHeader>(
    'DELETE FROM managed_tags WHERE id = ? AND user_id = ?',
    [tagId, userId]
  );

  const agents = await getAllAgents(userId);
  for (const agent of agents) {
    const tags = (agent.tags || []).filter(t => t !== tag.name);
    if (tags.length !== (agent.tags || []).length) {
      await updateAgent(agent.id, { tags });
    }
  }
  return result.affectedRows > 0;
}

// ---- Managed Agent Types ----

export async function getManagedAgentTypes(userId: string): Promise<ManagedAgentType[]> {
  await ensureReady();
  const db = requirePool();
  let [rows] = await db.execute<ManagedAgentTypeRow[]>(
    'SELECT * FROM managed_agent_types WHERE user_id = ? ORDER BY created_at ASC',
    [userId]
  );
  if (!rows.length) {
    await seedDefaultAgentTypes(userId);
    [rows] = await db.execute<ManagedAgentTypeRow[]>(
      'SELECT * FROM managed_agent_types WHERE user_id = ? ORDER BY created_at ASC',
      [userId]
    );
  }
  return rows.map(toManagedAgentType);
}

export async function createManagedAgentType(userId: string, name: string, backupDirs: string[]): Promise<ManagedAgentType> {
  await ensureReady();
  const db = requirePool();
  const id = uuid();
  const now = Date.now();
  const dirs = normalizeBackupDirs(backupDirs);
  await db.execute(
    'INSERT INTO managed_agent_types (id,user_id,name,backup_dirs_json,created_at) VALUES (?,?,?,?,?)',
    [id, userId, name, JSON.stringify(dirs), now]
  );
  return { id, userId, name, backupDirs: dirs, createdAt: now };
}

export async function updateManagedAgentType(userId: string, typeId: string, input: { name?: string; backupDirs?: string[] }): Promise<ManagedAgentType | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<ManagedAgentTypeRow[]>(
    'SELECT * FROM managed_agent_types WHERE id = ? AND user_id = ?',
    [typeId, userId]
  );
  const existing = rows[0];
  if (!existing) return undefined;

  const nextName = input.name ?? existing.name;
  const nextDirs = input.backupDirs ? normalizeBackupDirs(input.backupDirs) : parseJson<string[]>(existing.backup_dirs_json, []);
  await db.execute(
    'UPDATE managed_agent_types SET name = ?, backup_dirs_json = ? WHERE id = ? AND user_id = ?',
    [nextName, JSON.stringify(nextDirs), typeId, userId]
  );

  if (input.name && input.name !== existing.name) {
    await db.execute(
      'UPDATE agents SET agent_type = ?, updated_at = ? WHERE user_id = ? AND agent_type = ?',
      [input.name, Date.now(), userId, existing.name]
    );
  }

  return { id: typeId, userId, name: nextName, backupDirs: nextDirs, createdAt: Number(existing.created_at) };
}

export async function deleteManagedAgentType(userId: string, typeId: string): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<ManagedAgentTypeRow[]>(
    'SELECT * FROM managed_agent_types WHERE id = ? AND user_id = ?',
    [typeId, userId]
  );
  const type = rows[0];
  if (!type) return false;

  const [result] = await db.execute<ResultSetHeader>(
    'DELETE FROM managed_agent_types WHERE id = ? AND user_id = ?',
    [typeId, userId]
  );
  if (result.affectedRows > 0) {
    await db.execute(
      'UPDATE agents SET agent_type = ?, updated_at = ? WHERE user_id = ? AND agent_type = ?',
      ['workspace', Date.now(), userId, type.name]
    );
  }
  return result.affectedRows > 0;
}

// ---- Agents ----

export async function getAllAgents(userId?: string): Promise<AgentConfig[]> {
  await ensureReady();
  const db = requirePool();
  if (userId) {
    const [rows] = await db.execute<AgentRow[]>('SELECT * FROM agents WHERE user_id = ? ORDER BY updated_at DESC', [userId]);
    return rows.map(toAgent);
  }
  const [rows] = await db.query<AgentRow[]>('SELECT * FROM agents ORDER BY updated_at DESC');
  return rows.map(toAgent);
}

export async function getAgent(id: string): Promise<AgentConfig | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<AgentRow[]>('SELECT * FROM agents WHERE id = ?', [id]);
  return rows[0] ? toAgent(rows[0]) : undefined;
}

export async function createAgent(userId: string, input: Partial<AgentConfig> & { filename: string; fileSize: number; fileHash: string }): Promise<AgentConfig> {
  const now = Date.now();
  const agent: AgentConfig = {
    id: uuid(),
    userId,
    name: input.name || '',
    type: input.type || 'workspace',
    description: input.description || '',
    filename: input.filename,
    fileSize: input.fileSize,
    fileHash: input.fileHash,
    enabled: input.enabled !== false,
    tags: input.tags,
    isPublic: input.isPublic || false,
    downloadCount: 0,
    likesCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  await saveAgent(agent);
  return agent;
}

export async function updateAgent(id: string, input: Partial<AgentConfig>): Promise<AgentConfig | undefined> {
  const existing = await getAgent(id);
  if (!existing) return undefined;
  const updated: AgentConfig = {
    ...existing,
    ...input,
    id: existing.id,
    userId: existing.userId,
    createdAt: existing.createdAt,
    updatedAt: Date.now(),
  };

  const meaningfulChange = input.name !== undefined || input.description !== undefined
    || input.type !== undefined || input.filename !== undefined || input.tags !== undefined;
  if (meaningfulChange) await createVersion(id, 'Update');

  await saveAgent(updated);
  return updated;
}

export async function deleteAgent(id: string): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const [result] = await db.execute<ResultSetHeader>('DELETE FROM agents WHERE id = ?', [id]);
  if (result.affectedRows > 0) {
    await deleteAgentFiles(id);
  }
  return result.affectedRows > 0;
}

// ---- Agent Versions ----

export async function getVersions(agentId: string): Promise<AgentVersion[]> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<VersionRow[]>(
    'SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC', [agentId]
  );
  return rows.map(toVersion);
}

export async function getVersion(agentId: string, version: number): Promise<AgentVersion | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<VersionRow[]>(
    'SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?', [agentId, version]
  );
  return rows[0] ? toVersion(rows[0]) : undefined;
}

export async function createVersion(agentId: string, comment?: string): Promise<AgentVersion> {
  await ensureReady();
  const db = requirePool();
  const agent = await getAgent(agentId);
  if (!agent) throw new Error('Agent not found');

  const [latestRows] = await db.execute<RowDataPacket[]>(
    'SELECT MAX(version) as max_ver FROM agent_versions WHERE agent_id = ?', [agentId]
  );
  const nextVersion = (latestRows[0]?.max_ver ?? 0) + 1;

  const id = uuid();
  const now = Date.now();
  const snapshot = agentSnapshotFields(agent) as unknown as AgentSnapshot;

  await db.execute(
    'INSERT INTO agent_versions (id,agent_id,version,snapshot_json,comment,created_at) VALUES (?,?,?,?,?,?)',
    [id, agentId, nextVersion, JSON.stringify(snapshot), comment || null, now]
  );

  return { id, agentId, version: nextVersion, snapshot, comment, createdAt: now };
}

export async function rollbackToVersion(agentId: string, targetVersion: number): Promise<AgentConfig | undefined> {
  const versionRecord = await getVersion(agentId, targetVersion);
  if (!versionRecord) throw new Error('Version not found');
  return updateAgent(agentId, { ...versionRecord.snapshot });
}

export async function diffVersions(agentId: string, v1: number, v2: number): Promise<Record<string, { from: unknown; to: unknown }>> {
  const ver1 = await getVersion(agentId, v1);
  const ver2 = await getVersion(agentId, v2);
  if (!ver1 || !ver2) throw new Error('Version not found');

  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const s1 = ver1.snapshot as unknown as Record<string, unknown>;
  const s2 = ver2.snapshot as unknown as Record<string, unknown>;
  for (const key of [...new Set([...Object.keys(s1), ...Object.keys(s2)])]) {
    if (JSON.stringify(s1[key]) !== JSON.stringify(s2[key])) {
      diff[key] = { from: s1[key], to: s2[key] };
    }
  }
  return diff;
}

// ---- Agent Imports ----

export async function recordImport(agentId: string, sourceType: string, sourceUrl?: string): Promise<{ id: string; sourceType: string; sourceUrl?: string; agentId: string; importedAt: number }> {
  await ensureReady();
  const db = requirePool();
  const id = uuid();
  const now = Date.now();
  await db.execute(
    'INSERT INTO agent_imports (id,source_type,source_url,agent_id,imported_at) VALUES (?,?,?,?,?)',
    [id, sourceType, sourceUrl || null, agentId, now]
  );
  return { id, sourceType, sourceUrl, agentId, importedAt: now };
}

// ---- Marketplace ----

export async function getPublicAgents(): Promise<AgentConfig[]> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.query<AgentRow[]>(
    'SELECT * FROM agents WHERE is_public = 1 AND enabled = 1 ORDER BY likes_count DESC, download_count DESC'
  );
  return rows.map(toAgent);
}

export async function getAgentByShareToken(token: string): Promise<AgentConfig | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<AgentRow[]>('SELECT * FROM agents WHERE share_token = ?', [token]);
  return rows[0] ? toAgent(rows[0]) : undefined;
}