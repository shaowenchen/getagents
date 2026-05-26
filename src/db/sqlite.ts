import Database from 'better-sqlite3';
import { dirname } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { v4 as uuid } from 'uuid';
import type { AgentConfig, AgentVersion, AgentSnapshot, ManagedTag, User } from '../shared/types.js';
import { deleteAgentFiles } from '../utils/fileStore.js';

const databasePath = `${homedir()}/.getagents/getagents.sqlite`;

mkdirSync(dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

// Drop and recreate for clean schema migration
db.exec(`DROP TABLE IF EXISTS agent_imports`);
db.exec(`DROP TABLE IF EXISTS agent_versions`);
db.exec(`DROP TABLE IF EXISTS agents`);
db.exec(`DROP TABLE IF EXISTS managed_tags`);
db.exec(`DROP TABLE IF EXISTS users`);

db.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE managed_tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    description TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    file_hash TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 0,
    tags_json TEXT,
    download_count INTEGER NOT NULL DEFAULT 0,
    likes_count INTEGER NOT NULL DEFAULT 0,
    share_token TEXT,
    share_password TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE agent_versions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    comment TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  CREATE INDEX idx_agent_versions_agent ON agent_versions(agent_id, version DESC);

  CREATE TABLE agent_imports (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_url TEXT,
    agent_id TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );
`);

function rowToAgent(row: Record<string, unknown>): AgentConfig {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    avatar: (row.avatar as string) || undefined,
    description: row.description as string,
    filename: row.filename as string,
    fileSize: Number(row.file_size || 0),
    fileHash: row.file_hash as string,
    enabled: Boolean(row.enabled),
    tags: tryParseJson(row.tags_json as string),
    isPublic: Boolean(row.is_public),
    downloadCount: Number(row.download_count || 0),
    likesCount: Number(row.likes_count || 0),
    shareToken: (row.share_token as string) || undefined,
    sharePassword: (row.share_password as string) || undefined,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function agentToRow(agent: Partial<AgentConfig>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  if (agent.name !== undefined) row.name = agent.name;
  if (agent.avatar !== undefined) row.avatar = agent.avatar;
  if (agent.description !== undefined) row.description = agent.description;
  if (agent.filename !== undefined) row.filename = agent.filename;
  if (agent.fileSize !== undefined) row.file_size = agent.fileSize;
  if (agent.fileHash !== undefined) row.file_hash = agent.fileHash;
  if (agent.enabled !== undefined) row.enabled = agent.enabled ? 1 : 0;
  if (agent.tags !== undefined) row.tags_json = JSON.stringify(agent.tags);
  if (agent.isPublic !== undefined) row.is_public = agent.isPublic ? 1 : 0;
  if (agent.downloadCount !== undefined) row.download_count = agent.downloadCount;
  if (agent.likesCount !== undefined) row.likes_count = agent.likesCount;
  if (agent.shareToken !== undefined) row.share_token = agent.shareToken;
  if (agent.sharePassword !== undefined) row.share_password = agent.sharePassword;
  if (agent.updatedAt !== undefined) row.updated_at = agent.updatedAt;
  return row;
}

function tryParseJson(value: string | null | undefined): string[] | undefined {
  if (!value) return undefined;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : undefined; } catch { return undefined; }
}

// ---- Users ----

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    username: row.username as string,
    createdAt: Number(row.created_at),
  };
}

function rowToManagedTag(row: Record<string, unknown>): ManagedTag {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    createdAt: Number(row.created_at),
  };
}

export async function createUser(username: string, passwordHash: string): Promise<User> {
  const id = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?,?,?,?,?)')
    .run(id, username, passwordHash, now, now);
  return { id, username, createdAt: now };
}

export async function getUserByUsername(username: string): Promise<(User & { passwordHash: string }) | undefined> {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    username: row.username as string,
    passwordHash: row.password_hash as string,
    createdAt: Number(row.created_at),
  };
}

export async function getUserById(id: string): Promise<User | undefined> {
  const row = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : undefined;
}

export async function getAllUsers(): Promise<(User & { passwordHash: string })[]> {
  return db.prepare('SELECT id, username, password_hash, created_at FROM users').all().map((row: unknown) => {
    const r = row as Record<string, unknown>;
    return { id: r.id as string, username: r.username as string, passwordHash: r.password_hash as string, createdAt: Number(r.created_at) };
  });
}

// ---- Managed Tags ----

function normalizeManagedTag(name: string): string {
  return name.trim();
}

export async function getManagedTags(userId: string): Promise<ManagedTag[]> {
  return db.prepare('SELECT * FROM managed_tags WHERE user_id = ? ORDER BY name COLLATE NOCASE')
    .all(userId)
    .map((row: unknown) => rowToManagedTag(row as Record<string, unknown>));
}

export async function createManagedTag(userId: string, name: string): Promise<ManagedTag> {
  const normalized = normalizeManagedTag(name);
  if (!normalized) throw new Error('Tag name is required');
  const existing = db.prepare('SELECT * FROM managed_tags WHERE user_id = ? AND name = ?')
    .get(userId, normalized) as Record<string, unknown> | undefined;
  if (existing) return rowToManagedTag(existing);

  const id = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO managed_tags (id,user_id,name,created_at) VALUES (?,?,?,?)')
    .run(id, userId, normalized, now);
  return { id, userId, name: normalized, createdAt: now };
}

export async function deleteManagedTag(userId: string, tagId: string): Promise<boolean> {
  const row = db.prepare('SELECT * FROM managed_tags WHERE id = ? AND user_id = ?')
    .get(tagId, userId) as Record<string, unknown> | undefined;
  if (!row) return false;
  const tagName = row.name as string;

  const result = db.prepare('DELETE FROM managed_tags WHERE id = ? AND user_id = ?').run(tagId, userId);
  const agents = await getAllAgents(userId);
  for (const agent of agents) {
    const tags = (agent.tags || []).filter(t => t !== tagName);
    if (tags.length !== (agent.tags || []).length) {
      await updateAgent(agent.id, { tags });
    }
  }
  return result.changes > 0;
}

// ---- Agents ----

export async function getAllAgents(userId?: string): Promise<AgentConfig[]> {
  if (userId) {
    return db.prepare('SELECT * FROM agents WHERE user_id = ? ORDER BY updated_at DESC').all(userId).map((row: unknown) => rowToAgent(row as Record<string, unknown>));
  }
  return db.prepare('SELECT * FROM agents ORDER BY updated_at DESC').all().map((row: unknown) => rowToAgent(row as Record<string, unknown>));
}

export async function getAgent(id: string): Promise<AgentConfig | undefined> {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : undefined;
}

export async function createAgent(userId: string, data: Partial<AgentConfig> & { filename: string; fileSize: number; fileHash: string }): Promise<AgentConfig> {
  const id = uuid();
  const now = Date.now();
  const agent: AgentConfig = {
    id,
    userId,
    name: data.name || '',
    description: data.description || '',
    filename: data.filename,
    fileSize: data.fileSize,
    fileHash: data.fileHash,
    enabled: data.enabled !== false,
    tags: data.tags,
    isPublic: data.isPublic || false,
    downloadCount: 0,
    likesCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const insert = db.prepare(`INSERT INTO agents (id,user_id,name,avatar,description,filename,file_size,file_hash,enabled,is_public,tags_json,download_count,likes_count,share_token,share_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(agent.id, agent.userId, agent.name, null, agent.description, agent.filename, agent.fileSize, agent.fileHash, agent.enabled ? 1 : 0, agent.isPublic ? 1 : 0, JSON.stringify(agent.tags || []), agent.downloadCount, agent.likesCount, null, null, agent.createdAt, agent.updatedAt);
  return agent;
}

export async function updateAgent(id: string, data: Partial<AgentConfig>): Promise<AgentConfig | undefined> {
  const existing = await getAgent(id);
  if (!existing) return undefined;

  const row = agentToRow({ ...data, updatedAt: Date.now() });
  const keys = Object.keys(row);
  if (keys.length > 1) {
    const sets = keys.filter(k => k !== 'id').map(k => `${k}=?`).join(',');
    const values = keys.filter(k => k !== 'id').map(k => row[k]);
    db.prepare(`UPDATE agents SET ${sets} WHERE id=?`).run(...values, id);
  }

  // Auto-create version snapshot on meaningful changes
  if (data.name !== undefined || data.description !== undefined || data.filename !== undefined || data.tags !== undefined) {
    await createVersion(id, 'Update');
  }

  return getAgent(id);
}

export async function deleteAgent(id: string): Promise<boolean> {
  const result = db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  if (result.changes > 0) {
    await deleteAgentFiles(id);
  }
  return result.changes > 0;
}

// ---- Agent Versions ----

function rowToVersion(row: Record<string, unknown>): AgentVersion {
  return {
    id: row.id as string,
    agentId: row.agent_id as string,
    version: Number(row.version),
    snapshot: JSON.parse(row.snapshot_json as string),
    comment: (row.comment as string) || undefined,
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
    avatar: agent.avatar,
  };
}

export async function getVersions(agentId: string): Promise<AgentVersion[]> {
  return db.prepare('SELECT * FROM agent_versions WHERE agent_id = ? ORDER BY version DESC').all(agentId).map((row: unknown) => rowToVersion(row as Record<string, unknown>));
}

export async function getVersion(agentId: string, version: number): Promise<AgentVersion | undefined> {
  const row = db.prepare('SELECT * FROM agent_versions WHERE agent_id = ? AND version = ?').get(agentId, version) as Record<string, unknown> | undefined;
  return row ? rowToVersion(row) : undefined;
}

export async function createVersion(agentId: string, comment?: string): Promise<AgentVersion> {
  const agent = await getAgent(agentId);
  if (!agent) throw new Error('Agent not found');

  const latest = db.prepare('SELECT MAX(version) as max_ver FROM agent_versions WHERE agent_id = ?').get(agentId) as { max_ver: number | null };
  const nextVersion = (latest?.max_ver ?? 0) + 1;

  const id = uuid();
  const now = Date.now();
  const snapshot = agentSnapshotFields(agent) as unknown as AgentSnapshot;
  db.prepare('INSERT INTO agent_versions (id,agent_id,version,snapshot_json,comment,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, agentId, nextVersion, JSON.stringify(snapshot), comment || null, now);

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
  const allKeys = new Set([...Object.keys(s1), ...Object.keys(s2)]);

  for (const key of allKeys) {
    const from = s1[key];
    const to = s2[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      diff[key] = { from, to };
    }
  }
  return diff;
}

// ---- Agent Imports ----

export async function recordImport(agentId: string, sourceType: string, sourceUrl?: string): Promise<{ id: string; sourceType: string; sourceUrl?: string; agentId: string; importedAt: number }> {
  const id = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO agent_imports (id,source_type,source_url,agent_id,imported_at) VALUES (?,?,?,?,?)')
    .run(id, sourceType, sourceUrl || null, agentId, now);
  return { id, sourceType, sourceUrl, agentId, importedAt: now };
}

// ---- Marketplace ----

export async function getPublicAgents(): Promise<AgentConfig[]> {
  return db.prepare('SELECT * FROM agents WHERE is_public = 1 AND enabled = 1 ORDER BY likes_count DESC, download_count DESC').all().map((row: unknown) => rowToAgent(row as Record<string, unknown>));
}

export async function getAgentByShareToken(token: string): Promise<AgentConfig | undefined> {
  const row = db.prepare('SELECT * FROM agents WHERE share_token = ?').get(token) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : undefined;
}