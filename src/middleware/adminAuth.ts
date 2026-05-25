import crypto from 'crypto';
import bcrypt from 'bcrypt';
import type { Request, Response, NextFunction } from 'express';
import { getAllUsers } from '../db/store.js';

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

// In-memory cache: apiKey -> userId.
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

function extractApiKey(req: Request): string | undefined {
  const header = req.headers['x-api-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  if (Array.isArray(header) && header[0]) return String(header[0]).trim();

  const auth = req.headers.authorization;
  if (auth?.startsWith('ApiKey ')) return auth.slice(7).trim();
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

async function verifyApiKey(apiKey: string): Promise<string | null> {
  const cached = apiKeyCache.get(apiKey);
  if (cached) return cached;

  const users = await getAllUsers();
  for (const user of users) {
    try {
      if (await bcrypt.compare(apiKey, user.passwordHash)) {
        apiKeyCache.set(apiKey, user.id);
        return user.id;
      }
    } catch { /* ignore */ }
  }
  return null;
}

export function invalidateApiKeyCache(apiKey?: string): void {
  if (apiKey) apiKeyCache.delete(apiKey);
  else apiKeyCache.clear();
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
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
  const apiKey = extractApiKey(req);
  if (apiKey) {
    verifyApiKey(apiKey)
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
