import crypto from 'crypto';
import bcrypt from 'bcrypt';

export interface UserApiKeys {
  loginKey: string;
  uploadKey: string;
  downloadKey: string;
}

export interface UserApiKeyHashes {
  loginKeyHash: string;
  uploadKeyHash: string;
  downloadKeyHash: string;
}

export type UserKeyKind = 'login' | 'upload' | 'download';

export function generateUserKey(kind: UserKeyKind): string {
  const prefix = kind === 'login' ? 'user' : kind === 'upload' ? 'up' : 'down';
  return `${prefix}-${crypto.randomBytes(24).toString('base64url')}`;
}

export function generateUserKeys(): UserApiKeys {
  return {
    loginKey: generateUserKey('login'),
    uploadKey: generateUserKey('upload'),
    downloadKey: generateUserKey('download'),
  };
}

export async function hashUserKeys(keys: UserApiKeys): Promise<UserApiKeyHashes> {
  return {
    loginKeyHash: await bcrypt.hash(keys.loginKey, 10),
    uploadKeyHash: await bcrypt.hash(keys.uploadKey, 10),
    downloadKeyHash: await bcrypt.hash(keys.downloadKey, 10),
  };
}
