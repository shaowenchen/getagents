import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { mkdirSync, existsSync, copyFileSync, rmSync, createReadStream, createWriteStream } from 'fs';
import { readdir, stat, unlink } from 'fs/promises';
import { Readable } from 'stream';
import { finished, pipeline } from 'stream/promises';
import crypto from 'crypto';

/** Safe Content-Disposition for downloads (avoids quoted filenames that S3 URL-encodes as %22). */
export function contentDispositionAttachment(filename: string): string {
  const safe = filename.replace(/[\r\n"\\]/g, '');
  if (/^[-A-Za-z0-9_.]+$/.test(safe)) {
    return `attachment; filename=${safe}`;
  }
  const encoded = encodeURIComponent(safe);
  return `attachment; filename="${safe}"; filename*=UTF-8''${encoded}`;
}

const AGENTS_ROOT = join(homedir(), '.getagents', 'agents');
const STORAGE_DRIVER = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const AGFS_API_URL = (process.env.AGFS_API_URL || 'http://localhost:8080').replace(/\/+$/g, '');
const AGFS_ROOT_PATH = normalizeAgfsPath(process.env.AGFS_ROOT_PATH || '/s3fs/getagents');
const S3_LOCATION = parseS3Uri(process.env.AWS_BUCKET_URI || process.env.S3_URI || '', process.env.S3_BUCKET || 'getagents', process.env.S3_PREFIX || process.env.S3_KEY_PREFIX || 'agents');
const S3_BUCKET = S3_LOCATION.bucket;
const S3_KEY_PREFIX = S3_LOCATION.prefix;
const S3_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || process.env.S3_REGION || 'us-east-1';
const S3_ENDPOINT = normalizeS3Endpoint(process.env.AWS_ENDPOINT_URL || process.env.S3_ENDPOINT_URL || process.env.S3_ENDPOINT);
const S3_FORCE_PATH_STYLE = parseS3ForcePathStyle(
  process.env.AWS_S3_FORCE_PATH_STYLE || process.env.S3_FORCE_PATH_STYLE,
  S3_ENDPOINT
);
const S3_REQUEST_CHECKSUM_CALCULATION = parseS3RequestChecksumCalculation(
  process.env.AWS_S3_REQUEST_CHECKSUM_CALCULATION || process.env.S3_REQUEST_CHECKSUM_CALCULATION
);
const S3_ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID;
const S3_SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY;

type AgentFileStream = NodeJS.ReadableStream;
type FetchInitWithDuplex = RequestInit & { duplex?: 'half' };

function createS3Client(): S3Client {
  return new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: S3_FORCE_PATH_STYLE,
    requestChecksumCalculation: S3_REQUEST_CHECKSUM_CALCULATION,
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

function normalizeS3Endpoint(value: string | undefined): string | undefined {
  const trimmed = String(value || '').trim().replace(/\/+$/g, '');
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function parseS3ForcePathStyle(value: string | undefined, endpoint: string | undefined): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  if (endpoint && /(?:^|\.)ks3[-.]|ksyuncs\.com/i.test(new URL(endpoint).hostname)) return false;
  return true;
}

function parseS3RequestChecksumCalculation(value: string | undefined): 'WHEN_REQUIRED' | 'WHEN_SUPPORTED' {
  const normalized = String(value || '').trim().toUpperCase().replace(/-/g, '_');
  if (normalized === 'WHEN_SUPPORTED') return 'WHEN_SUPPORTED';
  return 'WHEN_REQUIRED';
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

function s3CopySource(sourceKey: string): string {
  const encodedKey = sourceKey.split('/').map(encodeURIComponent).join('/');
  return `${S3_BUCKET}/${encodedKey}`;
}

function s3UploadKey(agentId: string, fileName: string): string {
  return s3Key('uploads', agentId, fileName);
}

function s3DownloadKey(agentId: string, fileName: string): string {
  return s3Key('downloads', agentId, fileName);
}

function s3DirectUploadKey(userId: string, uploadId: string, fileName: string): string {
  return s3Key('direct', userId, uploadId, fileName);
}

function assertDirectUploadKey(userId: string, key: string): void {
  const prefix = s3Key('direct', userId) + '/';
  if (!key.startsWith(prefix)) throw new Error('Invalid direct upload key');
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
  await ensureAgfsDir(agfsPath('uploads'));
  await ensureAgfsDir(agfsPath('uploads', agentId));
  await ensureAgfsDir(agfsPath('downloads'));
  await ensureAgfsDir(agfsPath('downloads', agentId));
}

async function ensureAgfsStoredFileDir(filePath: string): Promise<void> {
  const parts = normalizeStoredFilePath(filePath).split('/').filter(Boolean);
  parts.pop();
  await ensureAgfsDir(AGFS_ROOT_PATH);
  if (parts.length) await ensureAgfsDir(agfsPath(...parts));
}

function ensureAgentDir(): void {
  mkdirSync(AGENTS_ROOT, { recursive: true });
}

function getAgentDir(scope: 'uploads' | 'downloads', agentId: string): string {
  const dir = join(AGENTS_ROOT, scope, agentId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function getLegacyAgentDir(agentId: string): string {
  return join(AGENTS_ROOT, agentId);
}

function versionFileName(version: number): string {
  return `v${version}.zip`;
}

function agentFilePath(agentId: string, version: number): string {
  return `/${agentId}/file-v${version}.zip`;
}

function normalizeStoredFilePath(filePath: string): string {
  return `/${String(filePath || '').replace(/^\/+|\/+$/g, '')}`;
}

function localStoredFilePath(filePath: string): string {
  return join(AGENTS_ROOT, normalizeStoredFilePath(filePath).replace(/^\/+/, ''));
}

function s3StoredFileKey(filePath: string): string {
  return s3Key(normalizeStoredFilePath(filePath));
}

function getVersionPath(agentId: string, version: number): string {
  return join(getAgentDir('uploads', agentId), versionFileName(version));
}

function getCurrentPath(agentId: string): string {
  return join(getAgentDir('downloads', agentId), 'current.zip');
}

async function hashAgentFile(path: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

async function copyFileStream(sourcePath: string, destinationPath: string): Promise<void> {
  mkdirSync(dirname(destinationPath), { recursive: true });
  await pipeline(createReadStream(sourcePath), createWriteStream(destinationPath));
}

async function saveLocalAgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  ensureAgentDir();
  const { writeFileSync } = await import('fs');
  const filePath = agentFilePath(agentId, version);
  const destinationPath = localStoredFilePath(filePath);
  mkdirSync(dirname(destinationPath), { recursive: true });
  writeFileSync(destinationPath, buffer);
  return filePath;
}

async function saveLocalAgentFileFromPath(agentId: string, version: number, sourcePath: string): Promise<string> {
  ensureAgentDir();
  const filePath = agentFilePath(agentId, version);
  await copyFileStream(sourcePath, localStoredFilePath(filePath));
  return filePath;
}

async function saveAgfsAgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  const filePath = agentFilePath(agentId, version);
  await ensureAgfsStoredFileDir(filePath);
  await agfsFetch('files', agfsPath(filePath), { method: 'PUT', body: buffer });
  return filePath;
}

async function putAgfsFile(path: string, sourcePath: string): Promise<void> {
  const body = createReadStream(sourcePath);
  await agfsFetch('files', path, {
    method: 'PUT',
    body,
    duplex: 'half',
  } as FetchInitWithDuplex);
  await finished(body);
}

async function saveAgfsAgentFileFromPath(agentId: string, version: number, sourcePath: string): Promise<string> {
  const filePath = agentFilePath(agentId, version);
  await ensureAgfsStoredFileDir(filePath);
  await putAgfsFile(agfsPath(filePath), sourcePath);
  return filePath;
}

async function putS3Object(key: string, buffer: Buffer): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: 'application/zip',
  }));
}

async function putS3ObjectFromPath(key: string, sourcePath: string): Promise<void> {
  const source = await stat(sourcePath);
  const body = createReadStream(sourcePath);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: body,
    ContentLength: source.size,
    ContentType: 'application/zip',
  }));
  await finished(body);
}

async function copyS3Object(sourceKey: string, targetKey: string): Promise<void> {
  await s3.send(new CopyObjectCommand({
    Bucket: S3_BUCKET,
    CopySource: s3CopySource(sourceKey),
    Key: targetKey,
  }));
}

async function deleteS3Object(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  }));
}

async function deleteS3Objects(keys: string[]): Promise<void> {
  for (const key of keys) {
    await deleteS3Object(key);
  }
}

async function saveS3AgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  const filePath = agentFilePath(agentId, version);
  await putS3Object(s3StoredFileKey(filePath), buffer);
  return filePath;
}

async function saveS3AgentFileFromPath(agentId: string, version: number, sourcePath: string): Promise<string> {
  const filePath = agentFilePath(agentId, version);
  await putS3ObjectFromPath(s3StoredFileKey(filePath), sourcePath);
  return filePath;
}

async function saveAgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
  if (STORAGE_DRIVER === 'agfs') return saveAgfsAgentFile(agentId, version, buffer);
  if (STORAGE_DRIVER === 's3') return saveS3AgentFile(agentId, version, buffer);
  return saveLocalAgentFile(agentId, version, buffer);
}

async function saveAgentFileFromPath(agentId: string, version: number, sourcePath: string): Promise<string> {
  if (STORAGE_DRIVER === 'agfs') return saveAgfsAgentFileFromPath(agentId, version, sourcePath);
  if (STORAGE_DRIVER === 's3') return saveS3AgentFileFromPath(agentId, version, sourcePath);
  return saveLocalAgentFileFromPath(agentId, version, sourcePath);
}

function supportsDirectAgentUpload(): boolean {
  return STORAGE_DRIVER === 's3';
}

function supportsDirectAgentDownload(): boolean {
  return STORAGE_DRIVER === 's3';
}

function isS3MissingObjectError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  const statusCode = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || statusCode === 404;
}

async function resolveS3AgentFileKey(filePath: string, fallback?: { agentId: string; version?: number }): Promise<string | null> {
  const keys = [s3StoredFileKey(filePath)];
  if (fallback) {
    const fileName = fallback.version !== undefined ? versionFileName(fallback.version) : 'current.zip';
    keys.push(
      ...(fallback.version !== undefined
        ? [s3UploadKey(fallback.agentId, fileName), s3Key(fallback.agentId, fileName)]
        : [s3DownloadKey(fallback.agentId, fileName), s3Key(fallback.agentId, fileName)])
    );
  }

  for (const key of keys) {
    try {
      await s3.send(new HeadObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }));
      return key;
    } catch (err) {
      if (isS3MissingObjectError(err)) continue;
      throw err;
    }
  }
  return null;
}

async function createDirectAgentDownload(
  filePath: string,
  fallback: { agentId: string; version?: number } | undefined,
  filename: string,
): Promise<{ url: string; expiresIn: number } | null> {
  if (!supportsDirectAgentDownload()) return null;

  const key = await resolveS3AgentFileKey(filePath, fallback);
  if (!key) return null;

  const expiresIn = Number(process.env.S3_DIRECT_DOWNLOAD_EXPIRES_SECONDS || process.env.S3_DIRECT_UPLOAD_EXPIRES_SECONDS || 900);
  const command = new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    ResponseContentDisposition: contentDispositionAttachment(filename),
    ResponseContentType: 'application/zip',
  });
  const url = await getSignedUrl(s3, command, {
    expiresIn,
    unsignableHeaders: S3_PRESIGN_UNSIGNABLE_HEADERS,
  });
  return { url, expiresIn };
}

const S3_PRESIGN_UNSIGNABLE_HEADERS = new Set([
  'x-amz-checksum-crc32',
  'x-amz-checksum-crc32c',
  'x-amz-checksum-sha1',
  'x-amz-checksum-sha256',
  'x-amz-sdk-checksum-algorithm',
]);

async function createDirectAgentUpload(userId: string, fileName = 'agent.zip'): Promise<{ key: string; url: string; headers: Record<string, string>; expiresIn: number }> {
  if (!supportsDirectAgentUpload()) throw new Error('Direct upload is only supported for S3 storage');

  const uploadId = crypto.randomUUID();
  const safeFileName = fileName.toLowerCase().endsWith('.zip') ? fileName : 'agent.zip';
  const key = s3DirectUploadKey(userId, uploadId, safeFileName);
  const command = new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  });
  const expiresIn = Number(process.env.S3_DIRECT_UPLOAD_EXPIRES_SECONDS || 900);
  const url = await getSignedUrl(s3, command, {
    expiresIn,
    unsignableHeaders: S3_PRESIGN_UNSIGNABLE_HEADERS,
  });
  return { key, url, headers: {}, expiresIn };
}

async function downloadS3ObjectToPath(key: string, destPath: string): Promise<void> {
  const result = await s3.send(new GetObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
  }));
  const body = bodyToStream(result.Body);
  if (!body) throw new Error(`Direct upload object not found: ${key}`);
  await pipeline(body, createWriteStream(destPath));
}

async function commitDirectAgentUpload(userId: string, sourceKey: string, agentId: string, version: number): Promise<string> {
  if (!supportsDirectAgentUpload()) throw new Error('Direct upload is only supported for S3 storage');
  assertDirectUploadKey(userId, sourceKey);

  const filePath = agentFilePath(agentId, version);
  const tmpPath = join(tmpdir(), `getagents-direct-${crypto.randomUUID()}.zip`);
  try {
    try {
      await copyS3Object(sourceKey, s3StoredFileKey(filePath));
    } catch {
      await downloadS3ObjectToPath(sourceKey, tmpPath);
      await saveS3AgentFileFromPath(agentId, version, tmpPath);
    }
    await deleteS3Object(sourceKey);
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
  return filePath;
}

function getAgentFilePath(agentId: string, version?: number): string {
  if (version !== undefined) {
    return getVersionPath(agentId, version);
  }
  return getCurrentPath(agentId);
}

async function copyLocalAgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
  ensureAgentDir();
  const copyDir = async (fromDir: string, toDir: string) => {
    if (!existsSync(fromDir)) return;
    mkdirSync(toDir, { recursive: true });
    const entries = await readdir(fromDir);
    for (const entry of entries) {
      const src = join(fromDir, entry);
      const dst = join(toDir, entry);
      copyFileSync(src, dst);
    }
  };

  await copyDir(join(AGENTS_ROOT, 'uploads', fromAgentId), getAgentDir('uploads', toAgentId));
  await copyDir(join(AGENTS_ROOT, 'downloads', fromAgentId), getAgentDir('downloads', toAgentId));

  // Compatibility with packages written before upload/download prefixes existed.
  const fromDir = getLegacyAgentDir(fromAgentId);
  if (!existsSync(fromDir)) return;
  const entries = await readdir(fromDir);
  for (const entry of entries) {
    const src = join(fromDir, entry);
    const dst = entry === 'current.zip'
      ? join(getAgentDir('downloads', toAgentId), entry)
      : join(getAgentDir('uploads', toAgentId), entry);
    copyFileSync(src, dst);
  }
}

async function listAgfsAgentFiles(scope: 'uploads' | 'downloads' | 'agents' | '', agentId: string): Promise<string[]> {
  const dir = scope ? agfsPath(scope, agentId) : agfsPath(agentId);
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
  for (const scope of ['uploads', 'downloads'] as const) {
    const entries = await listAgfsAgentFiles(scope, fromAgentId);
    for (const entry of entries) {
      const source = await getAgfsAgentFileBuffer(scope, fromAgentId, entry);
      if (source) {
        await agfsFetch('files', agfsPath(scope, toAgentId, entry), { method: 'PUT', body: source });
      }
    }
  }

  // Compatibility with the previous single "agents" prefix.
  const entries = await listAgfsAgentFiles('agents', fromAgentId);
  for (const entry of entries) {
    const source = await getAgfsAgentFileBuffer('agents', fromAgentId, entry);
    if (source) {
      const scope = entry === 'current.zip' ? 'downloads' : 'uploads';
      await agfsFetch('files', agfsPath(scope, toAgentId, entry), { method: 'PUT', body: source });
    }
  }
}

async function listS3AgentKeys(agentId: string): Promise<string[]> {
  const prefixes = [
    `${s3Key(agentId)}/`,
    `${s3Key('uploads', agentId)}/`,
    `${s3Key('downloads', agentId)}/`,
  ];
  const keys: string[] = [];
  for (const prefix of prefixes) {
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
  }

  return [...new Set(keys)];
}

async function copyS3AgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
  const keys = await listS3AgentKeys(fromAgentId);
  for (const key of keys) {
    const fileName = key.split('/').filter(Boolean).at(-1);
    if (!fileName) continue;
    const versionMatch = fileName.match(/^(?:v|file-v?)(\d+)\.zip$/);
    if (!versionMatch) continue;
    const targetKey = s3StoredFileKey(agentFilePath(toAgentId, Number(versionMatch[1])));
    await s3.send(new CopyObjectCommand({
      Bucket: S3_BUCKET,
      CopySource: s3CopySource(key),
      Key: targetKey,
    }));
  }
}

async function copyAgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
  if (STORAGE_DRIVER === 'agfs') return copyAgfsAgentFiles(fromAgentId, toAgentId);
  if (STORAGE_DRIVER === 's3') return copyS3AgentFiles(fromAgentId, toAgentId);
  return copyLocalAgentFiles(fromAgentId, toAgentId);
}

async function copyAgentFile(sourcePath: string, fromAgentId: string, fromVersion: number | undefined, toAgentId: string, toVersion: number): Promise<string> {
  const stream = await getAgentFileStream(sourcePath, { agentId: fromAgentId, version: fromVersion });
  if (!stream) throw new Error('Agent file not found');

  const tmpPath = join(tmpdir(), `getagents-copy-${crypto.randomUUID()}.zip`);
  try {
    await pipeline(stream, createWriteStream(tmpPath));
    return await saveAgentFileFromPath(toAgentId, toVersion, tmpPath);
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

async function deleteLocalAgentFiles(agentId: string): Promise<void> {
  for (const dir of [
    join(AGENTS_ROOT, 'uploads', agentId),
    join(AGENTS_ROOT, 'downloads', agentId),
    getLegacyAgentDir(agentId),
  ]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

async function deleteLocalAgentVersionFile(agentId: string, version: number): Promise<void> {
  for (const path of [
    localStoredFilePath(agentFilePath(agentId, version)),
    getVersionPath(agentId, version),
    join(getLegacyAgentDir(agentId), versionFileName(version)),
  ]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

async function deleteAgfsAgentFiles(agentId: string): Promise<void> {
  for (const scope of ['', 'uploads', 'downloads', 'agents'] as const) {
    const entries = await listAgfsAgentFiles(scope, agentId);
    for (const entry of entries) {
      await fetch(agfsUrl('files', scope ? agfsPath(scope, agentId, entry) : agfsPath(agentId, entry)), { method: 'DELETE' }).catch(() => undefined);
    }
  }
}

async function deleteAgfsAgentVersionFile(agentId: string, version: number): Promise<void> {
  const fileName = versionFileName(version);
  await fetch(agfsUrl('files', agfsPath(agentFilePath(agentId, version))), { method: 'DELETE' }).catch(() => undefined);
  for (const scope of ['uploads', 'agents'] as const) {
    await fetch(agfsUrl('files', agfsPath(scope, agentId, fileName)), { method: 'DELETE' }).catch(() => undefined);
  }
}

async function deleteS3AgentFiles(agentId: string): Promise<void> {
  const keys = await listS3AgentKeys(agentId);
  if (!keys.length) return;

  await deleteS3Objects(keys);
}

async function deleteS3AgentVersionFile(agentId: string, version: number): Promise<void> {
  const fileName = versionFileName(version);
  await deleteS3Objects([
    s3StoredFileKey(agentFilePath(agentId, version)),
    s3UploadKey(agentId, fileName),
    s3Key(agentId, fileName),
  ]);
}

async function deleteAgentFiles(agentId: string): Promise<void> {
  if (STORAGE_DRIVER === 'agfs') return deleteAgfsAgentFiles(agentId);
  if (STORAGE_DRIVER === 's3') return deleteS3AgentFiles(agentId);
  return deleteLocalAgentFiles(agentId);
}

async function deleteAgentVersionFile(agentId: string, version: number): Promise<void> {
  if (STORAGE_DRIVER === 'agfs') return deleteAgfsAgentVersionFile(agentId, version);
  if (STORAGE_DRIVER === 's3') return deleteS3AgentVersionFile(agentId, version);
  return deleteLocalAgentVersionFile(agentId, version);
}

async function getLocalAgentFileStream(filePath: string, fallback?: { agentId: string; version?: number }): Promise<AgentFileStream | null> {
  const storedPath = localStoredFilePath(filePath);
  if (existsSync(storedPath)) return createReadStream(storedPath);
  if (!fallback) return null;

  const legacyPath = fallback.version !== undefined
    ? getVersionPath(fallback.agentId, fallback.version)
    : getCurrentPath(fallback.agentId);
  if (existsSync(legacyPath)) return createReadStream(legacyPath);

  const olderLegacyPath = fallback.version !== undefined
    ? join(getLegacyAgentDir(fallback.agentId), versionFileName(fallback.version))
    : join(getLegacyAgentDir(fallback.agentId), 'current.zip');
  if (existsSync(olderLegacyPath)) return createReadStream(olderLegacyPath);
  return null;
}

async function getAgfsAgentFileBuffer(scope: 'uploads' | 'downloads' | 'agents', agentId: string, fileName: string): Promise<Buffer | null> {
  const res = await fetch(agfsUrl('files', agfsPath(scope, agentId, fileName)));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`AGFS read ${fileName} failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getAgfsAgentFileStream(filePath: string, fallback?: { agentId: string; version?: number }): Promise<AgentFileStream | null> {
  let res = await fetch(agfsUrl('files', agfsPath(filePath)));
  if (res.status === 404 && fallback) {
    const fileName = fallback.version !== undefined ? versionFileName(fallback.version) : 'current.zip';
    const scope = fallback.version !== undefined ? 'uploads' : 'downloads';
    res = await fetch(agfsUrl('files', agfsPath(scope, fallback.agentId, fileName)));
  }
  if (res.status === 404 && fallback) {
    const fileName = fallback.version !== undefined ? versionFileName(fallback.version) : 'current.zip';
    res = await fetch(agfsUrl('files', agfsPath('agents', fallback.agentId, fileName)));
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`AGFS read ${filePath} failed: ${res.status}`);
  if (!res.body) return null;
  return Readable.fromWeb(res.body as import('stream/web').ReadableStream);
}

async function getS3AgentFileStream(filePath: string, fallback?: { agentId: string; version?: number }): Promise<AgentFileStream | null> {
  const keys = [s3StoredFileKey(filePath)];
  if (fallback) {
    const fileName = fallback.version !== undefined ? versionFileName(fallback.version) : 'current.zip';
    keys.push(
      ...(fallback.version !== undefined
        ? [s3UploadKey(fallback.agentId, fileName), s3Key(fallback.agentId, fileName)]
        : [s3DownloadKey(fallback.agentId, fileName), s3Key(fallback.agentId, fileName)])
    );
  }

  for (const key of keys) {
    try {
      const result = await s3.send(new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
      }));
      return bodyToStream(result.Body);
    } catch (err) {
      if (isS3MissingObjectError(err)) continue;
      throw err;
    }
  }
  return null;
}

async function getAgentFileStream(filePath: string, fallback?: { agentId: string; version?: number }): Promise<AgentFileStream | null> {
  if (STORAGE_DRIVER === 'agfs') return getAgfsAgentFileStream(filePath, fallback);
  if (STORAGE_DRIVER === 's3') return getS3AgentFileStream(filePath, fallback);
  return getLocalAgentFileStream(filePath, fallback);
}

async function agentFileExists(filePath: string, fallback?: { agentId: string; version?: number }): Promise<boolean> {
  if (STORAGE_DRIVER === 's3') return (await resolveS3AgentFileKey(filePath, fallback)) !== null;
  const stream = await getAgentFileStream(filePath, fallback);
  if (!stream) return false;
  if (typeof (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy === 'function') {
    (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
  }
  return true;
}

export {
  ensureAgentDir,
  getAgentDir,
  agentFilePath,
  hashAgentFile,
  saveAgentFile,
  saveAgentFileFromPath,
  supportsDirectAgentUpload,
  supportsDirectAgentDownload,
  createDirectAgentUpload,
  createDirectAgentDownload,
  commitDirectAgentUpload,
  getAgentFilePath,
  copyAgentFiles,
  copyAgentFile,
  deleteAgentFiles,
  deleteAgentVersionFile,
  getAgentFileStream,
  agentFileExists,
};