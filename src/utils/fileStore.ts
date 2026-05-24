import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync, copyFileSync, rmSync, createReadStream } from 'fs';
import { readdir } from 'fs/promises';
import crypto from 'crypto';

const AGENTS_ROOT = join(homedir(), '.getagents', 'agents');

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

async function saveAgentFile(agentId: string, version: number, buffer: Buffer): Promise<string> {
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

function getAgentFilePath(agentId: string, version?: number): string {
  if (version !== undefined) {
    return getVersionPath(agentId, version);
  }
  return getCurrentPath(agentId);
}

async function copyAgentFiles(fromAgentId: string, toAgentId: string): Promise<void> {
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

function deleteAgentFiles(agentId: string): void {
  const dir = join(AGENTS_ROOT, agentId);
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

function getAgentFileStream(agentId: string, version?: number) {
  const path = getAgentFilePath(agentId, version);
  if (!existsSync(path)) return null;
  return createReadStream(path);
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