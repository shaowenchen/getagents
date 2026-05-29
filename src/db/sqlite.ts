import Database from 'better-sqlite3';
import { dirname } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';
import { v4 as uuid } from 'uuid';
import type { AgentConfig, AgentVersion, AgentSnapshot, ManagedAgentType, ManagedTag, User } from '../shared/types.js';
import { deleteAgentFiles } from '../utils/fileStore.js';

const databasePath = `${homedir()}/.getagents/getagents.sqlite`;

mkdirSync(dirname(databasePath), { recursive: true });

const db = new Database(databasePath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    login_key_hash TEXT NOT NULL,
    upload_key_hash TEXT NOT NULL,
    download_key_hash TEXT NOT NULL,
    login_key TEXT,
    upload_key TEXT,
    download_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS managed_tags (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS managed_agent_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    backup_dirs_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(name)
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    avatar TEXT,
    description TEXT NOT NULL,
    agent_type TEXT NOT NULL DEFAULT 'currentdir',
    filename TEXT NOT NULL,
    file_size INTEGER NOT NULL DEFAULT 0,
    file_hash TEXT NOT NULL,
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

  CREATE TABLE IF NOT EXISTS agent_versions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    comment TEXT,
    is_published INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agent_id, version DESC);

  CREATE TABLE IF NOT EXISTS agent_imports (
    id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_url TEXT,
    agent_id TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  );
`);

function sqliteColumns(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map(row => row.name));
}

function ensureSqliteColumn(table: string, column: string, definition: string): void {
  if (sqliteColumns(table).has(column)) return;
  db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

function migrateGlobalAgentTypes(): void {
  if (!sqliteColumns('managed_agent_types').has('user_id')) return;

  db.exec(`
    DROP TABLE IF EXISTS managed_agent_types_global;
    CREATE TABLE managed_agent_types_global (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      backup_dirs_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO managed_agent_types_global (id, name, backup_dirs_json, created_at)
    SELECT id, name, backup_dirs_json, created_at
    FROM managed_agent_types mat
    WHERE mat.rowid = (
      SELECT rowid
      FROM managed_agent_types candidate
      WHERE candidate.name = mat.name
      ORDER BY candidate.created_at ASC, candidate.id ASC
      LIMIT 1
    );
    DROP TABLE managed_agent_types;
    ALTER TABLE managed_agent_types_global RENAME TO managed_agent_types;
  `);
}

function migrateSchema(): void {
  ensureSqliteColumn('users', 'login_key_hash', 'TEXT');
  ensureSqliteColumn('users', 'upload_key_hash', 'TEXT');
  ensureSqliteColumn('users', 'download_key_hash', 'TEXT');
  ensureSqliteColumn('users', 'login_key', 'TEXT');
  ensureSqliteColumn('users', 'upload_key', 'TEXT');
  ensureSqliteColumn('users', 'download_key', 'TEXT');
  ensureSqliteColumn('agents', 'agent_type', "TEXT NOT NULL DEFAULT 'currentdir'");
  ensureSqliteColumn('agents', 'is_public', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn('agents', 'likes_count', 'INTEGER NOT NULL DEFAULT 0');
  ensureSqliteColumn('agents', 'share_token', 'TEXT');
  ensureSqliteColumn('agents', 'share_password', 'TEXT');
  ensureSqliteColumn('agent_versions', 'is_published', 'INTEGER NOT NULL DEFAULT 0');

  const userColumns = sqliteColumns('users');
  if (userColumns.has('password_hash')) {
    db.prepare(`
      UPDATE users
      SET login_key_hash = COALESCE(login_key_hash, password_hash),
          upload_key_hash = COALESCE(upload_key_hash, password_hash),
          download_key_hash = COALESCE(download_key_hash, password_hash)
    `).run();
    db.prepare('ALTER TABLE users DROP COLUMN password_hash').run();
  }

  const versionColumns = sqliteColumns('agent_versions');
  const agentColumns = sqliteColumns('agents');
  if (agentColumns.has('is_public') && versionColumns.has('is_published')) {
    db.prepare(`
      UPDATE agent_versions
      SET is_published = 1
      WHERE id IN (
        SELECT av.id
        FROM agent_versions av
        JOIN (
          SELECT agent_id, MAX(version) AS max_version
          FROM agent_versions
          GROUP BY agent_id
        ) latest ON latest.agent_id = av.agent_id AND latest.max_version = av.version
        JOIN agents a ON a.id = av.agent_id
        WHERE a.is_public = 1
          AND NOT EXISTS (
            SELECT 1 FROM agent_versions existing
            WHERE existing.agent_id = av.agent_id AND existing.is_published = 1
          )
      )
    `).run();
  }

  migrateGlobalAgentTypes();

  db.prepare(`
    UPDATE managed_agent_types
    SET name = 'currentdir'
    WHERE name = 'workspace'
      AND NOT EXISTS (
        SELECT 1 FROM managed_agent_types existing
        WHERE existing.name = 'currentdir'
      )
  `).run();
  db.prepare("UPDATE agents SET agent_type = 'currentdir' WHERE agent_type = 'workspace'").run();
  db.prepare(`
    DELETE FROM managed_agent_types
    WHERE name = 'workspace'
      AND EXISTS (
        SELECT 1 FROM managed_agent_types existing
        WHERE existing.name = 'currentdir'
      )
  `).run();

  db.prepare(`
    UPDATE managed_agent_types
    SET backup_dirs_json = ?
    WHERE name = 'openclaw'
      AND backup_dirs_json = ?
  `).run(JSON.stringify(['${OPENCLAW_HOME:-${HOME}/.openclaw}']), JSON.stringify(['${HOME}/.openclaw']));
  db.prepare(`
    UPDATE managed_agent_types
    SET backup_dirs_json = ?
    WHERE name = 'hermes-agent'
      AND backup_dirs_json = ?
  `).run(JSON.stringify(['${HERMES_HOME:-${HOME}/.hermes}']), JSON.stringify(['${HOME}/.hermes']));

  if (sqliteColumns('agents').has('enabled')) {
    db.prepare('ALTER TABLE agents DROP COLUMN enabled').run();
  }
}

migrateSchema();

function rowToAgent(row: Record<string, unknown>): AgentConfig {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    type: (row.agent_type as AgentConfig['type']) || 'currentdir',
    avatar: (row.avatar as string) || undefined,
    description: row.description as string,
    filename: row.filename as string,
    fileSize: Number(row.file_size || 0),
    fileHash: row.file_hash as string,
    tags: tryParseJson(row.tags_json as string),
    isPublic: Boolean(row.is_public),
    publishedVersion: row.published_version === undefined || row.published_version === null ? undefined : Number(row.published_version),
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
  if (agent.type !== undefined) row.agent_type = agent.type;
  if (agent.avatar !== undefined) row.avatar = agent.avatar;
  if (agent.description !== undefined) row.description = agent.description;
  if (agent.filename !== undefined) row.filename = agent.filename;
  if (agent.fileSize !== undefined) row.file_size = agent.fileSize;
  if (agent.fileHash !== undefined) row.file_hash = agent.fileHash;
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

function rowToManagedAgentType(row: Record<string, unknown>): ManagedAgentType {
  return {
    id: row.id as string,
    name: row.name as string,
    backupDirs: tryParseJson(row.backup_dirs_json as string) || [],
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
  const now = Date.now();
  const insert = db.prepare('INSERT OR IGNORE INTO managed_agent_types (id, name, backup_dirs_json, created_at) VALUES (?,?,?,?)');
  for (const type of defaultAgentTypes) {
    insert.run(uuid(), type.name, JSON.stringify(type.backupDirs), now);
  }
}

export async function createUser(
  username: string,
  loginKeyHash: string,
  keys?: { loginKey?: string; uploadKey: string; uploadKeyHash: string; downloadKey: string; downloadKeyHash: string }
): Promise<User> {
  const id = uuid();
  const now = Date.now();
  db.prepare('INSERT INTO users (id, username, login_key_hash, upload_key_hash, download_key_hash, login_key, upload_key, download_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, username, loginKeyHash, keys?.uploadKeyHash || loginKeyHash, keys?.downloadKeyHash || loginKeyHash, keys?.loginKey || null, keys?.uploadKey || null, keys?.downloadKey || null, now, now);
  return { id, username, createdAt: now };
}

export async function getUserByUsername(username: string): Promise<(User & { loginKeyHash: string; uploadKeyHash: string; downloadKeyHash: string; loginKey?: string; uploadKey?: string; downloadKey?: string }) | undefined> {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: row.id as string,
    username: row.username as string,
    loginKeyHash: row.login_key_hash as string,
    uploadKeyHash: row.upload_key_hash as string,
    downloadKeyHash: row.download_key_hash as string,
    loginKey: (row.login_key as string) || undefined,
    uploadKey: (row.upload_key as string) || undefined,
    downloadKey: (row.download_key as string) || undefined,
    createdAt: Number(row.created_at),
  };
}

export async function getUserById(id: string): Promise<User | undefined> {
  const row = db.prepare('SELECT id, username, created_at FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : undefined;
}

export async function getAllUsers(): Promise<(User & { loginKeyHash: string; uploadKeyHash: string; downloadKeyHash: string; loginKey?: string; uploadKey?: string; downloadKey?: string })[]> {
  return db.prepare('SELECT id, username, login_key_hash, upload_key_hash, download_key_hash, login_key, upload_key, download_key, created_at FROM users').all().map((row: unknown) => {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      username: r.username as string,
      loginKeyHash: r.login_key_hash as string,
      uploadKeyHash: r.upload_key_hash as string,
      downloadKeyHash: r.download_key_hash as string,
      loginKey: (r.login_key as string) || undefined,
      uploadKey: (r.upload_key as string) || undefined,
      downloadKey: (r.download_key as string) || undefined,
      createdAt: Number(r.created_at),
    };
  });
}

export async function updateUserKeys(
  userId: string,
  keys: { loginKey?: string; loginKeyHash?: string; uploadKey?: string; uploadKeyHash?: string; downloadKey?: string; downloadKeyHash?: string }
): Promise<boolean> {
  const existing = await getUserById(userId);
  if (!existing) return false;
  const current = await getAllUsers().then(users => users.find(user => user.id === userId));
  const result = db.prepare(`
    UPDATE users
    SET login_key_hash = ?, upload_key_hash = ?, download_key_hash = ?, login_key = ?, upload_key = ?, download_key = ?, updated_at = ?
    WHERE id = ?
  `).run(
    keys.loginKeyHash || current?.loginKeyHash,
    keys.uploadKeyHash || current?.uploadKeyHash,
    keys.downloadKeyHash || current?.downloadKeyHash,
    keys.loginKey || current?.loginKey || null,
    keys.uploadKey || current?.uploadKey || null,
    keys.downloadKey || current?.downloadKey || null,
    Date.now(),
    userId
  );
  return result.changes > 0;
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

// ---- Managed Agent Types ----

export async function getManagedAgentTypes(): Promise<ManagedAgentType[]> {
  await seedDefaultAgentTypes();
  const rows = db.prepare('SELECT * FROM managed_agent_types ORDER BY created_at ASC').all() as Record<string, unknown>[];
  return rows.map(rowToManagedAgentType);
}

export async function createManagedAgentType(name: string, backupDirs: string[]): Promise<ManagedAgentType> {
  const id = uuid();
  const now = Date.now();
  const dirs = normalizeBackupDirs(backupDirs);
  db.prepare('INSERT INTO managed_agent_types (id, name, backup_dirs_json, created_at) VALUES (?,?,?,?)')
    .run(id, name, JSON.stringify(dirs), now);
  return { id, name, backupDirs: dirs, createdAt: now };
}

export async function updateManagedAgentType(typeId: string, input: { name?: string; backupDirs?: string[] }): Promise<ManagedAgentType | undefined> {
  const existing = db.prepare('SELECT * FROM managed_agent_types WHERE id = ?').get(typeId) as Record<string, unknown> | undefined;
  if (!existing) return undefined;

  const nextName = input.name ?? existing.name as string;
  const nextDirs = input.backupDirs ? normalizeBackupDirs(input.backupDirs) : (tryParseJson(existing.backup_dirs_json as string) || []);
  db.prepare('UPDATE managed_agent_types SET name = ?, backup_dirs_json = ? WHERE id = ?')
    .run(nextName, JSON.stringify(nextDirs), typeId);

  if (input.name && input.name !== existing.name) {
    db.prepare('UPDATE agents SET agent_type = ?, updated_at = ? WHERE agent_type = ?')
      .run(input.name, Date.now(), existing.name);
  }

  return { id: typeId, name: nextName, backupDirs: nextDirs, createdAt: Number(existing.created_at) };
}

export async function deleteManagedAgentType(typeId: string): Promise<boolean> {
  const type = db.prepare('SELECT * FROM managed_agent_types WHERE id = ?').get(typeId) as Record<string, unknown> | undefined;
  if (!type) return false;

  const result = db.prepare('DELETE FROM managed_agent_types WHERE id = ?').run(typeId);
  if (result.changes > 0) {
    db.prepare('UPDATE agents SET agent_type = ?, updated_at = ? WHERE agent_type = ?')
      .run('currentdir', Date.now(), type.name);
  }
  return result.changes > 0;
}

// ---- Agents ----

export async function getAllAgents(userId?: string): Promise<AgentConfig[]> {
  const selectSql = `
    SELECT a.*, published.version AS published_version
    FROM agents a
    LEFT JOIN agent_versions published ON published.agent_id = a.id AND published.is_published = 1
  `;
  if (userId) {
    return db.prepare(`${selectSql} WHERE a.user_id = ? ORDER BY a.updated_at DESC`).all(userId).map((row: unknown) => rowToAgent(row as Record<string, unknown>));
  }
  return db.prepare(`${selectSql} ORDER BY a.updated_at DESC`).all().map((row: unknown) => rowToAgent(row as Record<string, unknown>));
}

export async function getAgent(id: string): Promise<AgentConfig | undefined> {
  const row = db.prepare(`
    SELECT a.*, published.version AS published_version
    FROM agents a
    LEFT JOIN agent_versions published ON published.agent_id = a.id AND published.is_published = 1
    WHERE a.id = ?
  `).get(id) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : undefined;
}

export async function createAgent(userId: string, data: Partial<AgentConfig> & { filename: string; fileSize: number; fileHash: string }): Promise<AgentConfig> {
  const id = uuid();
  const now = Date.now();
  const agent: AgentConfig = {
    id,
    userId,
    name: data.name || '',
    type: data.type || 'currentdir',
    description: data.description || '',
    filename: data.filename,
    fileSize: data.fileSize,
    fileHash: data.fileHash,
    tags: data.tags,
    isPublic: data.isPublic || false,
    downloadCount: 0,
    likesCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const insert = db.prepare(`INSERT INTO agents (id,user_id,name,agent_type,avatar,description,filename,file_size,file_hash,is_public,tags_json,download_count,likes_count,share_token,share_password,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run(agent.id, agent.userId, agent.name, agent.type, null, agent.description, agent.filename, agent.fileSize, agent.fileHash, agent.isPublic ? 1 : 0, JSON.stringify(agent.tags || []), agent.downloadCount, agent.likesCount, null, null, agent.createdAt, agent.updatedAt);
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
  if (data.name !== undefined || data.type !== undefined || data.description !== undefined || data.filename !== undefined || data.tags !== undefined) {
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
    isPublished: Boolean(row.is_published),
    createdAt: Number(row.created_at),
  };
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
  db.prepare('INSERT INTO agent_versions (id,agent_id,version,snapshot_json,comment,is_published,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(id, agentId, nextVersion, JSON.stringify(snapshot), comment || null, 0, now);

  return { id, agentId, version: nextVersion, snapshot, comment, isPublished: false, createdAt: now };
}

export async function getPublishedVersion(agentId: string): Promise<AgentVersion | undefined> {
  const row = db.prepare('SELECT * FROM agent_versions WHERE agent_id = ? AND is_published = 1 ORDER BY version DESC LIMIT 1').get(agentId) as Record<string, unknown> | undefined;
  return row ? rowToVersion(row) : undefined;
}

export async function publishVersion(agentId: string, version: number): Promise<AgentVersion | undefined> {
  const existing = await getVersion(agentId, version);
  if (!existing) return undefined;
  const tx = db.transaction(() => {
    db.prepare('UPDATE agent_versions SET is_published = 0 WHERE agent_id = ?').run(agentId);
    db.prepare('UPDATE agent_versions SET is_published = 1 WHERE agent_id = ? AND version = ?').run(agentId, version);
    db.prepare('UPDATE agents SET updated_at = ? WHERE id = ?').run(Date.now(), agentId);
  });
  tx();
  return getVersion(agentId, version);
}

export async function deleteVersion(agentId: string, version: number): Promise<boolean> {
  const result = db.prepare('DELETE FROM agent_versions WHERE agent_id = ? AND version = ?').run(agentId, version);
  return result.changes > 0;
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
  return db.prepare(`
    SELECT a.*, published.version AS published_version
    FROM agents a
    JOIN agent_versions published ON published.agent_id = a.id AND published.is_published = 1
    ORDER BY a.download_count DESC, a.updated_at DESC
  `).all().map((row: unknown) => rowToAgent(row as Record<string, unknown>));
}

export async function getAgentByShareToken(token: string): Promise<AgentConfig | undefined> {
  const row = db.prepare('SELECT * FROM agents WHERE share_token = ?').get(token) as Record<string, unknown> | undefined;
  return row ? rowToAgent(row) : undefined;
}