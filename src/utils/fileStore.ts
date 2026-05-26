import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
const S3_LOCATION = parseS3Uri(process.env.AWS_BUCKET_URI || process.env.S3_URI || '', process.env.S3_BUCKET || 'getagents', process.env.S3_PREFIX || process.env.S3_KEY_PREFIX || 'agents');
const S3_BUCKET = S3_LOCATION.bucket;
const S3_KEY_PREFIX = S3_LOCATION.prefix;
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.S3_REGION || 'us-east-1';
const S3_ENDPOINT = process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT_URL || process.env.S3_ENDPOINT || undefined;
const S3_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;

type AgentFileStream = NodeJS.ReadableStream;

function createS3Client(): S3Client {
  return new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: true,
    credentials: S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY
      ? {
          accessKeyId: S3_ACCESS_KEY_ID,
          secretAccessKey: S3_SECRET_ACCESS_KEY,
        }
      : undefined,
  });
}

const s3 = createS3Client();

function normalizeS3Prefix(prefix: string): string {
  return String(prefix || '').replace(/^\/+|\/+$/g, '');
}

function parseS3Uri(value: string, fallbackBucket: string, fallbackPrefix: string): { bucket: string; prefix: string } {
  const trimmed = String(value || '').trim();
  if (!trimmed) return { bucket: fallbackBucket, prefix: normalizeS3Prefix(fallbackPrefix) };

  const withoutScheme = trimmed.replace(/^s3:\/\//i, '');
  const [bucket, ...prefixParts] = withoutScheme.split('/');
  return {
    bucket: bucket || fallbackBucket,
    prefix: normalizeS3Prefix(prefixParts.join('/')),
  };
}

function s3Key(...parts: string[]): string {
  return [S3_KEY_PREFIX, ...parts]
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return Boolean(value && typeof (value as NodeJS.ReadableStream).pipe === 'function');
}

function bodyToStream(body: unknown): AgentFileStream | null {
  if (!body) return null;
  if (isReadableStream(body)) return body;
  if (body instanceof ReadableStream) return Readable.fromWeb(body);
  return Readable.from(body as AsyncIterable<Uint8Array>);
}

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

async function putS3Object(key: string, buffer: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'application/zip',
  }));
}

async function saveS3AgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  await putS3Object(s3Key(agentId, versionFileName(version)), buffer);
  await putS3Object(s3Key(agentId, 'current.zip'), buffer);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function saveAgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  if (STORAGE_DRIVER === 'agfs') return saveAgfsAgentFile(agentId, version, buffer);
  if (STORAGE_DRIVER === 's3') return saveS3AgentFile(agentId, version, buffer);
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

async function listS3AgentKeys(agentId: string): Promise<string[]> {
  const prefix = `${s3Key(agentId)}/`;
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    for (const item of result.Contents || []) {
      if (item.Key) keys.push(item.Key);
    }
    continuationToken = result.NextContinuationToken;
  } while (continuationToken);

  return keys;
}

async function copyS3AgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
  const keys = await listS3AgentKeys(fromAgentId);
  for (const key of keys) {
    const fileName = key.split('/').filter(Boolean).at(-1);
    if (!fileName) continue;
    await s3.send(new CopyObjectCommand({
      Bucket: S3_BUCKET,
      CopySource: encodeURIComponent(`${S3_BUCKET}/${key}`),
      Key: s3Key(toAgentId, fileName),
      ContentType: 'application/zip',
    }));
  }
}

async function copyAgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
  if (STORAGE_DRIVER === 'agfs') return copyAgfsAgentFiles(fromAgentId, toAgentId);
  if (STORAGE_DRIVER === 's3') return copyS3AgentFiles(fromAgentId, toAgentId);
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

async function deleteS3AgentFiles(agentId: string): Promise<void> {
  const keys = await listS3AgentKeys(agentId);
  if (!keys.length) return;

  await s3.send(new DeleteObjectsCommand({
    Bucket: S3_BUCKET,
    Delete: {
      Objects: keys.map((Key) => ({ Key })),
      Quiet: true,
    },
  }));
}

async function deleteAgentFiles(agentId: string): Promise<void> {
  if (STORAGE_DRIVER === 'agfs') return deleteAgfsAgentFiles(agentId);
  if (STORAGE_DRIVER === 's3') return deleteS3AgentFiles(agentId);
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

async function getS3AgentFileStream(agentId: string, version?: number): Promise<AgentFileStream | null> {
  const fileName = version !== undefined ? versionFileName(version) : 'current.zip';
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: s3Key(agentId, fileName),
    }));
    return bodyToStream(result.Body);
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'NoSuchKey' || name === 'NotFound') return null;
    const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    if (statusCode === 404) return null;
    throw err;
  }
}

async function getAgentFileStream(agentId: string, version?: number): Promise<AgentFileStream | null> {
  if (STORAGE_DRIVER === 'agfs') return getAgfsAgentFileStream(agentId, version);
  if (STORAGE_DRIVER === 's3') return getS3AgentFileStream(agentId, version);
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