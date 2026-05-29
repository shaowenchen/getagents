import mysql, { type Pool, type PoolOptions, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { v4 as uuid } from 'uuid';
import type { AgentConfig, AgentVersion, AgentSnapshot, ManagedAgentType, ManagedTag, User } from '../shared/types.js';

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

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(255) NOT NULL UNIQUE,
      login_key_hash TEXT NOT NULL,
      upload_key_hash TEXT NOT NULL,
      download_key_hash TEXT NOT NULL,
      login_key TEXT,
      upload_key TEXT,
      download_key TEXT,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS managed_tags (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uniq_managed_tags_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS managed_agent_types (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      backup_dirs_json JSON NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uniq_managed_agent_types_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      agent_type VARCHAR(32) NOT NULL DEFAULT 'currentdir',
      avatar TEXT,
      description TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_size INT NOT NULL DEFAULT 0,
      file_hash VARCHAR(128) NOT NULL,
      is_public TINYINT(1) NOT NULL DEFAULT 0,
      tags_json JSON,
      download_count INT NOT NULL DEFAULT 0,
      likes_count INT NOT NULL DEFAULT 0,
      share_token VARCHAR(64),
      share_password VARCHAR(255),
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL,
      deleted_at BIGINT,
      deleted_by VARCHAR(64),
      INDEX idx_agents_user_id (user_id),
      INDEX idx_agents_updated_at (updated_at),
      INDEX idx_agents_deleted_at (deleted_at),
      INDEX idx_agents_public (is_public),
      INDEX idx_agents_share_token (share_token),
      CONSTRAINT fk_agents_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_versions (
      id VARCHAR(64) PRIMARY KEY,
      agent_id VARCHAR(64) NOT NULL,
      version INT NOT NULL,
      snapshot_json JSON NOT NULL,
      comment TEXT,
      is_published TINYINT(1) NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL,
      INDEX idx_agent_versions_agent (agent_id, version),
      CONSTRAINT fk_versions_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS agent_imports (
      id VARCHAR(64) PRIMARY KEY,
      source_type VARCHAR(32) NOT NULL,
      source_url TEXT,
      agent_id VARCHAR(64) NOT NULL,
      imported_at BIGINT NOT NULL,
      CONSTRAINT fk_imports_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await migrateSchema(db);
}

async function mysqlColumnExists(db: Pool, table: string, column: string): Promise<boolean> {
  const [rows] = await db.execute<RowDataPacket[]>(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function ensureMysqlColumn(db: Pool, table: string, column: string, definition: string): Promise<void> {
  if (await mysqlColumnExists(db, table, column)) return;
  await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function migrateGlobalTags(db: Pool): Promise<void> {
  if (!await mysqlColumnExists(db, 'managed_tags', 'user_id')) return;

  await db.query('DROP TABLE IF EXISTS managed_tags_global');
  await db.query(`
    CREATE TABLE managed_tags_global (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uniq_managed_tags_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await db.execute<ManagedTagRow[]>(
    'SELECT id, name, created_at FROM managed_tags ORDER BY created_at ASC, id ASC'
  );
  for (const row of rows) {
    await db.execute(
      'INSERT IGNORE INTO managed_tags_global (id, name, created_at) VALUES (?,?,?)',
      [row.id, row.name, row.created_at]
    );
  }

  await db.query('DROP TABLE managed_tags');
  await db.query('RENAME TABLE managed_tags_global TO managed_tags');
}

async function migrateGlobalAgentTypes(db: Pool): Promise<void> {
  if (!await mysqlColumnExists(db, 'managed_agent_types', 'user_id')) return;

  await db.query('DROP TABLE IF EXISTS managed_agent_types_global');
  await db.query(`
    CREATE TABLE managed_agent_types_global (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      backup_dirs_json JSON NOT NULL,
      created_at BIGINT NOT NULL,
      UNIQUE KEY uniq_managed_agent_types_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [rows] = await db.execute<ManagedAgentTypeRow[]>(
    'SELECT id, name, backup_dirs_json, created_at FROM managed_agent_types ORDER BY created_at ASC, id ASC'
  );
  for (const row of rows) {
    await db.execute(
      'INSERT IGNORE INTO managed_agent_types_global (id, name, backup_dirs_json, created_at) VALUES (?,?,?,?)',
      [row.id, row.name, JSON.stringify(parseJson<string[]>(row.backup_dirs_json, [])), row.created_at]
    );
  }

  await db.query('DROP TABLE managed_agent_types');
  await db.query('RENAME TABLE managed_agent_types_global TO managed_agent_types');
}

async function migrateSchema(db: Pool): Promise<void> {
  await ensureMysqlColumn(db, 'users', 'login_key_hash', 'TEXT');
  await ensureMysqlColumn(db, 'users', 'upload_key_hash', 'TEXT');
  await ensureMysqlColumn(db, 'users', 'download_key_hash', 'TEXT');
  await ensureMysqlColumn(db, 'users', 'login_key', 'TEXT');
  await ensureMysqlColumn(db, 'users', 'upload_key', 'TEXT');
  await ensureMysqlColumn(db, 'users', 'download_key', 'TEXT');
  await ensureMysqlColumn(db, 'agents', 'agent_type', "VARCHAR(32) NOT NULL DEFAULT 'currentdir'");
  await ensureMysqlColumn(db, 'agents', 'is_public', 'TINYINT(1) NOT NULL DEFAULT 0');
  await ensureMysqlColumn(db, 'agents', 'likes_count', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn(db, 'agents', 'share_token', 'VARCHAR(64)');
  await ensureMysqlColumn(db, 'agents', 'share_password', 'VARCHAR(255)');
  await ensureMysqlColumn(db, 'agents', 'deleted_at', 'BIGINT');
  await ensureMysqlColumn(db, 'agents', 'deleted_by', 'VARCHAR(64)');
  await ensureMysqlColumn(db, 'agent_versions', 'is_published', 'TINYINT(1) NOT NULL DEFAULT 0');

  if (await mysqlColumnExists(db, 'users', 'password_hash')) {
    await db.query(`
      UPDATE users
      SET login_key_hash = COALESCE(login_key_hash, password_hash),
          upload_key_hash = COALESCE(upload_key_hash, password_hash),
          download_key_hash = COALESCE(download_key_hash, password_hash)
    `);
    await db.query('ALTER TABLE users DROP COLUMN password_hash');
  }

  if (await mysqlColumnExists(db, 'agents', 'is_public') && await mysqlColumnExists(db, 'agent_versions', 'is_published')) {
    await db.query(`
      UPDATE agent_versions av
      JOIN (
        SELECT agent_id, MAX(version) AS max_version
        FROM agent_versions
        GROUP BY agent_id
      ) latest ON latest.agent_id = av.agent_id AND latest.max_version = av.version
      JOIN agents a ON a.id = av.agent_id
      LEFT JOIN (
        SELECT DISTINCT agent_id
        FROM agent_versions
        WHERE is_published = 1
      ) existing ON existing.agent_id = av.agent_id
      SET av.is_published = 1
      WHERE a.is_public = 1
        AND existing.agent_id IS NULL
    `);
  }

  await migrateGlobalTags(db);
  await migrateGlobalAgentTypes(db);

  await db.query(`
    UPDATE managed_agent_types
    SET name = 'currentdir'
    WHERE name = 'workspace'
      AND NOT EXISTS (
        SELECT 1
        FROM (SELECT id FROM managed_agent_types WHERE name = 'currentdir') existing
      )
  `);
  await db.query("UPDATE agents SET agent_type = 'currentdir' WHERE agent_type = 'workspace'");
  await db.query(`
    DELETE FROM managed_agent_types
    WHERE name = 'workspace'
      AND EXISTS (
        SELECT 1
        FROM (SELECT id FROM managed_agent_types WHERE name = 'currentdir') existing
      )
  `);

  await db.execute(
    `UPDATE managed_agent_types
     SET backup_dirs_json = ?
     WHERE name = 'openclaw'
       AND JSON_LENGTH(backup_dirs_json) = 1
       AND JSON_UNQUOTE(JSON_EXTRACT(backup_dirs_json, '$[0]')) = ?`,
    [JSON.stringify(['${OPENCLAW_HOME:-${HOME}/.openclaw}']), '${HOME}/.openclaw']
  );
  await db.execute(
    `UPDATE managed_agent_types
     SET backup_dirs_json = ?
     WHERE name = 'hermes-agent'
       AND JSON_LENGTH(backup_dirs_json) = 1
       AND JSON_UNQUOTE(JSON_EXTRACT(backup_dirs_json, '$[0]')) = ?`,
    [JSON.stringify(['${HERMES_HOME:-${HOME}/.hermes}']), '${HOME}/.hermes']
  );

  if (await mysqlColumnExists(db, 'agents', 'enabled')) {
    await db.query('ALTER TABLE agents DROP COLUMN enabled');
  }
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
  is_public: number; tags_json: string | null;
  download_count: number; likes_count: number;
  share_token: string | null; share_password: string | null; published_version?: number | null;
  owner_username?: string | null; deleted_at: number | null; deleted_by: string | null;
  created_at: number; updated_at: number;
};

type UserRow = RowDataPacket & {
  id: string; username: string; login_key_hash: string; upload_key_hash: string; download_key_hash: string;
  login_key: string | null; upload_key: string | null; download_key: string | null; created_at: number;
};

type ManagedTagRow = RowDataPacket & {
  id: string; name: string; created_at: number;
};

type ManagedAgentTypeRow = RowDataPacket & {
  id: string; name: string; backup_dirs_json: string; created_at: number;
};

type VersionRow = RowDataPacket & {
  id: string; agent_id: string; version: number; snapshot_json: string;
  comment: string | null; is_published: number; created_at: number;
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
    id: row.id, userId: row.user_id, ownerUsername: row.owner_username ?? undefined, name: row.name, avatar: row.avatar ?? undefined,
    type: (row.agent_type as AgentConfig['type']) || 'currentdir',
    description: row.description, filename: row.filename,
    fileSize: Number(row.file_size || 0), fileHash: row.file_hash,
    tags: parseJson<string[] | undefined>(row.tags_json, undefined),
    isPublic: Boolean(row.is_public),
    publishedVersion: row.published_version === undefined || row.published_version === null ? undefined : Number(row.published_version),
    downloadCount: Number(row.download_count || 0),
    likesCount: Number(row.likes_count || 0),
    shareToken: row.share_token ?? undefined,
    sharePassword: row.share_password ?? undefined,
    deletedAt: row.deleted_at === undefined || row.deleted_at === null ? undefined : Number(row.deleted_at),
    deletedBy: row.deleted_by ?? undefined,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function toVersion(row: VersionRow): AgentVersion {
  return {
    id: row.id, agentId: row.agent_id, version: Number(row.version),
    snapshot: parseJson<AgentSnapshot>(row.snapshot_json, null as unknown as AgentSnapshot) || {} as AgentSnapshot,
    comment: row.comment ?? undefined,
    isPublished: Boolean(row.is_published),
    createdAt: Number(row.created_at),
  };
}

function toManagedAgentType(row: ManagedAgentTypeRow): ManagedAgentType {
  return {
    id: row.id,
    name: row.name,
    backupDirs: parseJson<string[]>(row.backup_dirs_json, []),
    createdAt: Number(row.created_at),
  };
}

const defaultAgentTypes = [
  { name: 'currentdir', backupDirs: ['${PWD}'] },
  { name: 'cursor', backupDirs: ['${HOME}/.cursor'] },
  { name: 'claude', backupDirs: ['${HOME}/.claude'] },
  { name: 'codex', backupDirs: ['${HOME}/.codex'] },
  { name: 'gemini', backupDirs: ['${HOME}/.gemini'] },
  { name: 'openclaw', backupDirs: ['${OPENCLAW_HOME:-${HOME}/.openclaw}'] },
  { name: 'hermes-agent', backupDirs: ['${HERMES_HOME:-${HOME}/.hermes}'] },
];

function normalizeBackupDirs(value: string[]): string[] {
  return [...new Set(value.map(dir => String(dir).trim()).filter(Boolean))];
}

async function seedDefaultAgentTypes(): Promise<void> {
  const db = requirePool();
  const now = Date.now();
  for (const type of defaultAgentTypes) {
    await db.execute(
      'INSERT IGNORE INTO managed_agent_types (id, name, backup_dirs_json, created_at) VALUES (?,?,?,?)',
      [uuid(), type.name, JSON.stringify(type.backupDirs), now]
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
      is_public, tags_json, download_count, likes_count,
      share_token, share_password, created_at, updated_at, deleted_at, deleted_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      name=VALUES(name), agent_type=VALUES(agent_type), avatar=VALUES(avatar), description=VALUES(description),
      filename=VALUES(filename), file_size=VALUES(file_size), file_hash=VALUES(file_hash),
      is_public=VALUES(is_public),
      tags_json=VALUES(tags_json),
      download_count=VALUES(download_count), likes_count=VALUES(likes_count),
      share_token=VALUES(share_token), share_password=VALUES(share_password),
      deleted_at=VALUES(deleted_at), deleted_by=VALUES(deleted_by),
      updated_at=VALUES(updated_at)
  `, [
    agent.id, agent.userId, agent.name, agent.type, agent.avatar ?? null, agent.description,
    agent.filename, agent.fileSize, agent.fileHash,
    agent.isPublic ? 1 : 0,
    stringifyOptional(agent.tags),
    agent.downloadCount || 0, agent.likesCount || 0,
    agent.shareToken ?? null, agent.sharePassword ?? null,
    agent.createdAt, agent.updatedAt, agent.deletedAt ?? null, agent.deletedBy ?? null,
  ]);
}

// ---- Users ----

export async function createUser(
  username: string,
  loginKeyHash: string,
  keys?: { loginKey?: string; uploadKey: string; uploadKeyHash: string; downloadKey: string; downloadKeyHash: string }
): Promise<User> {
  await ensureReady();
  const db = requirePool();
  const id = uuid();
  const now = Date.now();
  await db.execute(
    'INSERT INTO users (id, username, login_key_hash, upload_key_hash, download_key_hash, login_key, upload_key, download_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [id, username, loginKeyHash, keys?.uploadKeyHash || loginKeyHash, keys?.downloadKeyHash || loginKeyHash, keys?.loginKey || null, keys?.uploadKey || null, keys?.downloadKey || null, now, now]
  );
  return { id, username, createdAt: now };
}

export async function getUserByUsername(username: string): Promise<(User & { loginKeyHash: string; uploadKeyHash: string; downloadKeyHash: string; loginKey?: string; uploadKey?: string; downloadKey?: string }) | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<UserRow[]>('SELECT * FROM users WHERE username = ?', [username]);
  if (!rows[0]) return undefined;
  return {
    id: rows[0].id,
    username: rows[0].username,
    loginKeyHash: rows[0].login_key_hash,
    uploadKeyHash: rows[0].upload_key_hash,
    downloadKeyHash: rows[0].download_key_hash,
    loginKey: rows[0].login_key ?? undefined,
    uploadKey: rows[0].upload_key ?? undefined,
    downloadKey: rows[0].download_key ?? undefined,
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

export async function getAllUsers(): Promise<(User & { loginKeyHash: string; uploadKeyHash: string; downloadKeyHash: string; loginKey?: string; uploadKey?: string; downloadKey?: string })[]> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.query<UserRow[]>('SELECT id, username, login_key_hash, upload_key_hash, download_key_hash, login_key, upload_key, download_key, created_at FROM users');
  return rows.map(r => ({
    id: r.id,
    username: r.username,
    loginKeyHash: r.login_key_hash,
    uploadKeyHash: r.upload_key_hash,
    downloadKeyHash: r.download_key_hash,
    loginKey: r.login_key ?? undefined,
    uploadKey: r.upload_key ?? undefined,
    downloadKey: r.download_key ?? undefined,
    createdAt: Number(r.created_at),
  }));
}

export async function updateUserKeys(
  userId: string,
  keys: { loginKey?: string; loginKeyHash?: string; uploadKey?: string; uploadKeyHash?: string; downloadKey?: string; downloadKeyHash?: string }
): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const current = (await getAllUsers()).find(user => user.id === userId);
  if (!current) return false;
  const [result] = await db.execute<ResultSetHeader>(
    `UPDATE users
     SET login_key_hash = ?, upload_key_hash = ?, download_key_hash = ?, login_key = ?, upload_key = ?, download_key = ?, updated_at = ?
     WHERE id = ?`,
    [
      keys.loginKeyHash || current.loginKeyHash,
      keys.uploadKeyHash || current.uploadKeyHash,
      keys.downloadKeyHash || current.downloadKeyHash,
      keys.loginKey || current.loginKey || null,
      keys.uploadKey || current.uploadKey || null,
      keys.downloadKey || current.downloadKey || null,
      Date.now(),
      userId,
    ]
  );
  return result.affectedRows > 0;
}

// ---- Managed Tags ----

function toManagedTag(row: ManagedTagRow): ManagedTag {
  return {
    id: row.id,
    name: row.name,
    createdAt: Number(row.created_at),
  };
}

export async function getManagedTags(): Promise<ManagedTag[]> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<ManagedTagRow[]>(
    'SELECT * FROM managed_tags ORDER BY name'
  );
  return rows.map(toManagedTag);
}

export async function createManagedTag(name: string): Promise<ManagedTag> {
  await ensureReady();
  const db = requirePool();
  const normalized = name.trim();
  if (!normalized) throw new Error('Tag name is required');

  const [existing] = await db.execute<ManagedTagRow[]>(
    'SELECT * FROM managed_tags WHERE name = ?',
    [normalized]
  );
  if (existing[0]) return toManagedTag(existing[0]);

  const id = uuid();
  const now = Date.now();
  await db.execute(
    'INSERT INTO managed_tags (id,name,created_at) VALUES (?,?,?)',
    [id, normalized, now]
  );
  return { id, name: normalized, createdAt: now };
}

export async function deleteManagedTag(tagId: string): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<ManagedTagRow[]>(
    'SELECT * FROM managed_tags WHERE id = ?',
    [tagId]
  );
  const tag = rows[0];
  if (!tag) return false;

  const [result] = await db.execute<ResultSetHeader>(
    'DELETE FROM managed_tags WHERE id = ?',
    [tagId]
  );

  const agents = await getAllAgents(undefined, { includeDeleted: true });
  for (const agent of agents) {
    const tags = (agent.tags || []).filter(t => t !== tag.name);
    if (tags.length !== (agent.tags || []).length) {
      await updateAgent(agent.id, { tags });
    }
  }
  return result.affectedRows > 0;
}

// ---- Managed Agent Types ----

export async function getManagedAgentTypes(): Promise<ManagedAgentType[]> {
  await ensureReady();
  const db = requirePool();
  await seedDefaultAgentTypes();
  const [rows] = await db.execute<ManagedAgentTypeRow[]>(
    'SELECT * FROM managed_agent_types ORDER BY created_at ASC'
  );
  return rows.map(toManagedAgentType);
}

export async function createManagedAgentType(name: string, backupDirs: string[]): Promise<ManagedAgentType> {
  await ensureReady();
  const db = requirePool();
  const id = uuid();
  const now = Date.now();
  const dirs = normalizeBackupDirs(backupDirs);
  await db.execute(
    'INSERT INTO managed_agent_types (id,name,backup_dirs_json,created_at) VALUES (?,?,?,?)',
    [id, name, JSON.stringify(dirs), now]
  );
  return { id, name, backupDirs: dirs, createdAt: now };
}

export async function updateManagedAgentType(typeId: string, input: { name?: string; backupDirs?: string[] }): Promise<ManagedAgentType | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<ManagedAgentTypeRow[]>(
    'SELECT * FROM managed_agent_types WHERE id = ?',
    [typeId]
  );
  const existing = rows[0];
  if (!existing) return undefined;

  const nextName = input.name ?? existing.name;
  const nextDirs = input.backupDirs ? normalizeBackupDirs(input.backupDirs) : parseJson<string[]>(existing.backup_dirs_json, []);
  await db.execute(
    'UPDATE managed_agent_types SET name = ?, backup_dirs_json = ? WHERE id = ?',
    [nextName, JSON.stringify(nextDirs), typeId]
  );

  if (input.name && input.name !== existing.name) {
    await db.execute(
      'UPDATE agents SET agent_type = ?, updated_at = ? WHERE agent_type = ?',
      [input.name, Date.now(), existing.name]
    );
  }

  return { id: typeId, name: nextName, backupDirs: nextDirs, createdAt: Number(existing.created_at) };
}

export async function deleteManagedAgentType(typeId: string): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<ManagedAgentTypeRow[]>(
    'SELECT * FROM managed_agent_types WHERE id = ?',
    [typeId]
  );
  const type = rows[0];
  if (!type) return false;

  const [result] = await db.execute<ResultSetHeader>(
    'DELETE FROM managed_agent_types WHERE id = ?',
    [typeId]
  );
  if (result.affectedRows > 0) {
    await db.execute(
      'UPDATE agents SET agent_type = ?, updated_at = ? WHERE agent_type = ?',
      ['currentdir', Date.now(), type.name]
    );
  }
  return result.affectedRows > 0;
}

// ---- Agents ----

type AgentListOptions = { includeDeleted?: boolean; username?: string };
type AgentLookupOptions = { includeDeleted?: boolean };

function agentWhereClause(userId?: string, options: AgentListOptions = {}): { sql: string; params: string[] } {
  const conditions: string[] = [];
  const params: string[] = [];
  if (userId) {
    conditions.push('a.user_id = ?');
    params.push(userId);
  }
  if (options.username?.trim()) {
    conditions.push('u.username = ?');
    params.push(options.username.trim());
  }
  if (!options.includeDeleted) {
    conditions.push('a.deleted_at IS NULL');
  }
  return {
    sql: conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

export async function getAllAgents(userId?: string, options: AgentListOptions = {}): Promise<AgentConfig[]> {
  await ensureReady();
  const db = requirePool();
  const selectSql = `
    SELECT a.*, u.username AS owner_username, published.version AS published_version
    FROM agents a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN agent_versions published ON published.agent_id = a.id AND published.is_published = 1
  `;
  const where = agentWhereClause(userId, options);
  const [rows] = await db.execute<AgentRow[]>(`${selectSql}${where.sql} ORDER BY a.updated_at DESC`, where.params);
  return rows.map(toAgent);
}

export async function getAgent(id: string, options: AgentLookupOptions = {}): Promise<AgentConfig | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<AgentRow[]>(`
    SELECT a.*, u.username AS owner_username, published.version AS published_version
    FROM agents a
    JOIN users u ON u.id = a.user_id
    LEFT JOIN agent_versions published ON published.agent_id = a.id AND published.is_published = 1
    WHERE a.id = ?
      ${options.includeDeleted ? '' : 'AND a.deleted_at IS NULL'}
  `, [id]);
  return rows[0] ? toAgent(rows[0]) : undefined;
}

export async function createAgent(userId: string, input: Partial<AgentConfig> & { filename: string; fileSize: number; fileHash: string }): Promise<AgentConfig> {
  const now = Date.now();
  const agent: AgentConfig = {
    id: uuid(),
    userId,
    name: input.name || '',
    type: input.type || 'currentdir',
    description: input.description || '',
    filename: input.filename,
    fileSize: input.fileSize,
    fileHash: input.fileHash,
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

export async function deleteAgent(id: string, deletedBy?: string): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const now = Date.now();
  const [result] = await db.execute<ResultSetHeader>(
    'UPDATE agents SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
    [now, deletedBy || null, now, id]
  );
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
    'INSERT INTO agent_versions (id,agent_id,version,snapshot_json,comment,is_published,created_at) VALUES (?,?,?,?,?,?,?)',
    [id, agentId, nextVersion, JSON.stringify(snapshot), comment || null, 0, now]
  );

  return { id, agentId, version: nextVersion, snapshot, comment, isPublished: false, createdAt: now };
}

export async function getPublishedVersion(agentId: string): Promise<AgentVersion | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<VersionRow[]>(
    'SELECT * FROM agent_versions WHERE agent_id = ? AND is_published = 1 ORDER BY version DESC LIMIT 1',
    [agentId]
  );
  return rows[0] ? toVersion(rows[0]) : undefined;
}

export async function publishVersion(agentId: string, version: number): Promise<AgentVersion | undefined> {
  await ensureReady();
  const db = requirePool();
  const existing = await getVersion(agentId, version);
  if (!existing) return undefined;
  await db.execute('UPDATE agent_versions SET is_published = 0 WHERE agent_id = ?', [agentId]);
  await db.execute('UPDATE agent_versions SET is_published = 1 WHERE agent_id = ? AND version = ?', [agentId, version]);
  await db.execute('UPDATE agents SET updated_at = ? WHERE id = ?', [Date.now(), agentId]);
  return getVersion(agentId, version);
}

export async function deleteVersion(agentId: string, version: number): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const [result] = await db.execute<ResultSetHeader>(
    'DELETE FROM agent_versions WHERE agent_id = ? AND version = ?',
    [agentId, version],
  );
  return result.affectedRows > 0;
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
    `SELECT a.*, u.username AS owner_username, published.version AS published_version
     FROM agents a
     JOIN users u ON u.id = a.user_id
     JOIN agent_versions published ON published.agent_id = a.id AND published.is_published = 1
     WHERE a.deleted_at IS NULL
     ORDER BY a.download_count DESC, a.updated_at DESC`
  );
  return rows.map(toAgent);
}

export async function getAgentByShareToken(token: string): Promise<AgentConfig | undefined> {
  await ensureReady();
  const db = requirePool();
  const [rows] = await db.execute<AgentRow[]>(`
    SELECT a.*, u.username AS owner_username
    FROM agents a
    JOIN users u ON u.id = a.user_id
    WHERE a.share_token = ? AND a.deleted_at IS NULL
  `, [token]);
  return rows[0] ? toAgent(rows[0]) : undefined;
}