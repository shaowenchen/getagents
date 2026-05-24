import mysql, { type Pool, type PoolOptions, type RowDataPacket, type ResultSetHeader } from 'mysql2/promise';
import { v4 as uuid } from 'uuid';
import type { AgentConfig, AgentVersion, AgentSnapshot, User } from '../shared/types.js';
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
    CREATE TABLE agents (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      name VARCHAR(255) NOT NULL,
      avatar TEXT,
      description TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_size INT NOT NULL DEFAULT 0,
      file_hash VARCHAR(128) NOT NULL,
      enabled TINYINT(1) NOT NULL,
      is_public TINYINT(1) NOT NULL DEFAULT 0,
      tags_json JSON,
      category VARCHAR(64),
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
  id: string; user_id: string; name: string; avatar: string | null; description: string;
  filename: string; file_size: number; file_hash: string;
  enabled: number; is_public: number; tags_json: string | null;
  category: string | null; download_count: number; likes_count: number;
  share_token: string | null; share_password: string | null;
  created_at: number; updated_at: number;
};

type UserRow = RowDataPacket & {
  id: string; username: string; password_hash: string; created_at: number;
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
    description: row.description, filename: row.filename,
    fileSize: Number(row.file_size || 0), fileHash: row.file_hash,
    enabled: Boolean(row.enabled),
    tags: parseJson<string[] | undefined>(row.tags_json, undefined),
    category: row.category ?? undefined,
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

function agentSnapshotFields(agent: AgentConfig): Record<string, unknown> {
  return {
    name: agent.name,
    description: agent.description,
    filename: agent.filename,
    fileSize: agent.fileSize,
    fileHash: agent.fileHash,
    tags: agent.tags,
    category: agent.category,
    avatar: agent.avatar,
  };
}

async function saveAgent(agent: AgentConfig): Promise<void> {
  await ensureReady();
  const db = requirePool();
  await db.execute(`
    INSERT INTO agents (
      id, user_id, name, avatar, description, filename, file_size, file_hash,
      enabled, is_public, tags_json, category, download_count, likes_count,
      share_token, share_password, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      name=VALUES(name), avatar=VALUES(avatar), description=VALUES(description),
      filename=VALUES(filename), file_size=VALUES(file_size), file_hash=VALUES(file_hash),
      enabled=VALUES(enabled), is_public=VALUES(is_public),
      tags_json=VALUES(tags_json), category=VALUES(category),
      download_count=VALUES(download_count), likes_count=VALUES(likes_count),
      share_token=VALUES(share_token), share_password=VALUES(share_password),
      updated_at=VALUES(updated_at)
  `, [
    agent.id, agent.userId, agent.name, agent.avatar ?? null, agent.description,
    agent.filename, agent.fileSize, agent.fileHash,
    agent.enabled ? 1 : 0, agent.isPublic ? 1 : 0,
    stringifyOptional(agent.tags), agent.category ?? null,
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
    description: input.description || '',
    filename: input.filename,
    fileSize: input.fileSize,
    fileHash: input.fileHash,
    enabled: input.enabled !== false,
    tags: input.tags,
    category: input.category,
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
    || input.filename !== undefined || input.tags !== undefined
    || input.category !== undefined;
  if (meaningfulChange) await createVersion(id, 'Update');

  await saveAgent(updated);
  return updated;
}

export async function deleteAgent(id: string): Promise<boolean> {
  await ensureReady();
  const db = requirePool();
  const [result] = await db.execute<ResultSetHeader>('DELETE FROM agents WHERE id = ?', [id]);
  if (result.affectedRows > 0) {
    deleteAgentFiles(id);
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