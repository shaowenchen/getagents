import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';

const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

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

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = extractToken(req);
  if (!token) { res.status(401).json({ error: 'Unauthorized' }); return; }
  const result = verifyToken(token);
  if (!result) { res.status(401).json({ error: 'Invalid or expired token' }); return; }
  (req as any).userId = result.userId;
  next();
}