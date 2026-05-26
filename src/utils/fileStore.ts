import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, copyFileSync, rmSync, createReadStream } from 'fs';
import { readdir } from 'fs/promises';
import { Readable } from 'stream';
import crypto from 'crypto';

const AGENTS_ROOT = join(homedir(), '.getagents', 'agents');
const STORAGE_DRIVER = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const AGFS_API_URL = (process.env.AGFS_API_URL || 'http://localhost:8080').replace(/\/+$/g, '');
const AGFS_ROOT_PATH = normalizeAgfsPath(process.env.AGFS_ROOT_PATH || '/s3fs/getagents');

type AgentFileStream = NodeJS.ReadableStream;

function normalizeAgfsPath(path: string): string {
  const trimmed = String(path || '').trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

function agfsPath(...parts: string[]): string {
  const suffix = parts.map((part) => part.replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
  return `${AGFS_ROOT_PATH}/${suffix}`.replace(/\/+/g, '/');
}

function agfsUrl(endpoint: string, path: string): string {
  const url = new URL(`/api/v1/${endpoint.replace(/^\/+/, '')}`, AGFS_API_URL);
  url.searchParams.set('path', path);
  return url.toString();
}

async function agfsFetch(endpoint: string, path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(agfsUrl(endpoint, path), init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AGFS ${init.method || 'GET'} ${path} failed: ${res.status}${text ? ` ${text}` : ''}`);
  }
  return res;
}

async function ensureAgfsDir(path: string): Promise<void> {
  if (!path) return;
  await fetch(agfsUrl('directories', path), { method: 'POST' }).catch(() => undefined);
}

async function ensureAgfsAgentDir(agentId: string): Promise<void> {
  await ensureAgfsDir(AGFS_ROOT_PATH);
  await ensureAgfsDir(agfsPath('agents'));
  await ensureAgfsDir(agfsPath('agents', agentId));
}

function ensureAgentDir(): void {
  mkdirSync(AGENTS_ROOT, { recursive: true });
}

function getAgentDir(agentId: string): string {
  const dir = join(AGENTS_ROOT, agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function versionFileName(version: number): string {
  return `v${version}.zip`;
}

function getVersionPath(agentId: string, version: number): string {
  return join(getAgentDir(agentId), versionFileName(version));
}

function getCurrentPath(agentId: string): string {
  return join(getAgentDir(agentId), 'current.zip');
}

async function saveLocalAgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  ensureAgentDir();
  const { writeFileSync } = await import('fs');
  const dir = getAgentDir(agentId);
  const versionPath = join(dir, versionFileName(version));
  writeFileSync(versionPath, buffer);
  // Update current.zip symlink/copy
  const currentPath = join(dir, 'current.zip');
  writeFileSync(currentPath, buffer);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function saveAgfsAgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  await ensureAgfsAgentDir(agentId);
  await agfsFetch('files', agfsPath('agents', agentId, versionFileName(version)), { method: 'PUT', body: buffer });
  await agfsFetch('files', agfsPath('agents', agentId, 'current.zip'), { method: 'PUT', body: buffer });
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function saveAgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  if (STORAGE_DRIVER === 'agfs') return saveAgfsAgentFile(agentId, version, buffer);
  return saveLocalAgentFile(agentId, version, buffer);
}

function getAgentFilePath(agentId: string, version?: number): string {
  if (version !== undefined) {
    return getVersionPath(agentId, version);
  }
  return getCurrentPath(agentId);
}

async function copyLocalAgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
  ensureAgentDir();
  const fromDir = getAgentDir(fromAgentId);
  const toDir = getAgentDir(toAgentId);
  const entries = await readdir(fromDir);
  for (const entry of entries) {
    const src = join(fromDir, entry);
    const dst = join(toDir, entry);
    copyFileSync(src, dst);
  }
}

async function listAgfsAgentFiles(agentId: string): Promise<string[]> {
  const dir = agfsPath('agents', agentId);
  const res = await fetch(agfsUrl('directories', dir));
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`AGFS list ${dir} failed: ${res.status}`);
  const data = await res.json().catch(() => null) as unknown;
  const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  const rawEntries = Array.isArray(data) ? data : (record.entries || record.files || record.children || []);
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.map((entry: unknown) => {
    if (typeof entry === 'string') return entry;
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      return String(record.name || record.path || '').split('/').filter(Boolean).at(-1) || '';
    }
    return '';
  }).filter(Boolean);
}

async function copyAgfsAgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
  await ensureAgfsAgentDir(toAgentId);
  const entries = await listAgfsAgentFiles(fromAgentId);
  for (const entry of entries) {
    const source = await getAgfsAgentFileBuffer(fromAgentId, entry);
    if (source) {
      await agfsFetch('files', agfsPath('agents', toAgentId, entry), { method: 'PUT', body: source });
    }
  }
}

async function copyAgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
  if (STORAGE_DRIVER === 'agfs') return copyAgfsAgentFiles(fromAgentId, toAgentId);
  return copyLocalAgentFiles(fromAgentId, toAgentId);
}

async function deleteLocalAgentFiles(agentId: string): Promise<void> {
  const dir = join(AGENTS_ROOT, agentId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function deleteAgfsAgentFiles(agentId: string): Promise<void> {
  const entries = await listAgfsAgentFiles(agentId);
  for (const entry of entries) {
    await fetch(agfsUrl('files', agfsPath('agents', agentId, entry)), { method: 'DELETE' }).catch(() => undefined);
  }
}

async function deleteAgentFiles(agentId: string): Promise<void> {
  if (STORAGE_DRIVER === 'agfs') return deleteAgfsAgentFiles(agentId);
  return deleteLocalAgentFiles(agentId);
}

async function getLocalAgentFileStream(agentId: string, version?: number): Promise<AgentFileStream | null> {
  const path = getAgentFilePath(agentId, version);
  if (!existsSync(path)) return null;
  return createReadStream(path);
}

async function getAgfsAgentFileBuffer(agentId: string, fileName: string): Promise<Buffer | null> {
  const res = await fetch(agfsUrl('files', agfsPath('agents', agentId, fileName)));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`AGFS read ${fileName} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getAgfsAgentFileStream(agentId: string, version?: number): Promise<AgentFileStream | null> {
  const fileName = version !== undefined ? versionFileName(version) : 'current.zip';
  const res = await fetch(agfsUrl('files', agfsPath('agents', agentId, fileName)));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`AGFS read ${fileName} failed: ${res.status}`);
  if (!res.body) return null;
  return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
}

async function getAgentFileStream(agentId: string, version?: number): Promise<AgentFileStream | null> {
  if (STORAGE_DRIVER === 'agfs') return getAgfsAgentFileStream(agentId, version);
  return getLocalAgentFileStream(agentId, version);
}

export {
  ensureAgentDir,
  getAgentDir,
  saveAgentFile,
  getAgentFilePath,
  copyAgentFiles,
  deleteAgentFiles,
  getAgentFileStream,
};