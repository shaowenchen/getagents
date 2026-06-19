import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { Request, Response, NextFunction } from 'express';
import { getAllUsers } from '../db/store.js';

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

type ApiKeyPurpose = 'login' | 'upload' | 'download';

// In-memory cache: purpose:apiKey -> userId.
// We cache after the first successful bcrypt comparison so subsequent CLI
// uploads are O(1) instead of scanning every user on every request.
const apiKeyCache = new Map<string, string>();

export function createAuthToken(userId: string): string {
  const payload = JSON.stringify({ userId, exp: Date.now() + 7 * 24 * 3600 * 1000 });
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return Buffer.from(JSON.stringify({ p: payload, s: sig })).toString('base64url');
}

function extractToken(req: Request): string | undefined {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

function extractApiKey(req: Request, purposes: ApiKeyPurpose[]): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]) return String(header[0]).trim();

  const auth = req.headers.authorization;
  if (auth?.startsWith('ApiKey ')) return auth.slice(7).trim();

  const queryKey = purposes.includes('download') ? req.query.downloadKey : undefined;
  if (typeof queryKey === 'string' && queryKey.trim()) return queryKey.trim();
  return undefined;
}

function verifyToken(token: string): { userId: string } | null {
  try {
    const { p, s } = JSON.parse(Buffer.from(token, 'base64url').toString());
    const expected = crypto.createHmac('sha256', SECRET).update(p).digest('hex');
    if (s.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
    const { userId, exp } = JSON.parse(p);
    if (Date.now() > exp) return null;
    return { userId };
  } catch { return null; }
}

async function verifyApiKey(apiKey: string, purposes: ApiKeyPurpose[]): Promise<string | null> {
  for (const purpose of purposes) {
    const cached = apiKeyCache.get(`${purpose}:${apiKey}`);
    if (cached) return cached;
  }

  const users = await getAllUsers();
  for (const user of users) {
    const checks: Array<[ApiKeyPurpose, string | undefined]> = [
      ['login', user.loginKeyHash],
      ['upload', user.uploadKeyHash],
      ['download', user.downloadKeyHash],
    ];
    for (const [purpose, hash] of checks) {
      if (!purposes.includes(purpose) || !hash) continue;
      try {
        if (await bcrypt.compare(apiKey, hash)) {
          apiKeyCache.set(`${purpose}:${apiKey}`, user.id);
          return user.id;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function invalidateApiKeyCache(apiKey?: string): void {
  if (apiKey) {
    for (const purpose of ['login', 'upload', 'download'] as const) apiKeyCache.delete(`${purpose}:${apiKey}`);
  }
  else apiKeyCache.clear();
}

function requireAuthWithPurposes(req: Request, res: Response, next: NextFunction, purposes: ApiKeyPurpose[]): void {
  // 1) Bearer JWT (browser sessions)
  const token = extractToken(req);
  if (token) {
    const result = verifyToken(token);
    if (result) {
      (req as any).userId = result.userId;
      return next();
    }
  }

  // 2) X-API-Key / Authorization: ApiKey <key> (CLI / automation)
  const apiKey = extractApiKey(req, purposes);
  if (apiKey) {
    verifyApiKey(apiKey, purposes)
      .then((userId) => {
        if (userId) {
          (req as any).userId = userId;
          (req as any).authVia = 'apiKey';
          return next();
        }
        res.status(401).json({ error: 'Invalid API key' });
      })
      .catch((err) => next(err));
    return;
  }

  res.status(401).json({ error: 'Unauthorized' });
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  requireAuthWithPurposes(req, res, next, ['login']);
}

export function requireUploadAuth(req: Request, res: Response, next: NextFunction): void {
  requireAuthWithPurposes(req, res, next, ['upload']);
}

export function requireDownloadAuth(req: Request, res: Response, next: NextFunction): void {
  requireAuthWithPurposes(req, res, next, ['download']);
}

export async function authenticateApiKey(req: Request, purposes: ApiKeyPurpose[]): Promise<string | null> {
  const apiKey = extractApiKey(req, purposes);
  if (!apiKey) return null;
  return verifyApiKey(apiKey, purposes);
}

export function getSessionUserId(req: Request): string | null {
  const token = extractToken(req);
  if (!token) return null;
  return verifyToken(token)?.userId ?? null;
}
