import multer from 'multer';
import { mkdirSync } from 'fs';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';
import * as db from '../db/store.js';

const uploadTempDir = join(tmpdir(), 'getagents-uploads');
const maxUploadSize = Number(process.env.MAX_UPLOAD_MB || 500) * 1024 * 1024;

function parseTagInput(value: unknown): string[] | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value.map((tag) => String(tag).trim()).filter(Boolean);
  return String(value).split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function createZipUpload(): multer.Multer {
  mkdirSync(uploadTempDir, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, uploadTempDir),
      filename: (_req, file, cb) => {
        const suffix = file.originalname.toLowerCase().endsWith('.zip') ? '.zip' : '';
        cb(null, `${Date.now()}-${crypto.randomUUID()}${suffix}`);
      },
    }),
    limits: { fileSize: maxUploadSize },
    fileFilter: (_req, file, cb) => {
      if (!file.originalname.toLowerCase().endsWith('.zip') && file.mimetype !== 'application/zip') {
        cb(new Error('Only ZIP files are allowed'));
        return;
      }
      cb(null, true);
    },
  });
}

export async function cleanupUploadedFile(file?: Express.Multer.File): Promise<void> {
  if (file?.path) await unlink(file.path).catch(() => undefined);
}

export async function validateManagedTags(userId: string, value: unknown): Promise<string[] | undefined> {
  const tags = parseTagInput(value);
  if (tags === undefined) return undefined;

  const allowed = new Set((await db.getManagedTags(userId)).map((tag) => tag.name));
  const invalid = tags.filter((tag) => !allowed.has(tag));
  if (invalid.length) {
    throw new Error(`Unknown tags: ${invalid.join(', ')}`);
  }

  return [...new Set(tags)];
}

export async function validateAgentType(userId: string, value: unknown): Promise<string> {
  const type = String(value || 'currentdir').trim();
  const allowed = new Set((await db.getManagedAgentTypes(userId)).map((item) => item.name));
  if (!allowed.has(type)) throw new Error(`Unknown type: ${type}`);
  return type;
}
