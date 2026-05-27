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

const KEY_SUFFIX_LENGTH = 32;
const KEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomKeySuffix(): string {
  let suffix = '';
  for (let i = 0; i < KEY_SUFFIX_LENGTH; i += 1) {
    suffix += KEY_CHARS[crypto.randomInt(KEY_CHARS.length)];
  }
  return suffix;
}

export function generateUserKey(kind: UserKeyKind): string {
  const prefix = kind === 'login' ? 'user' : kind === 'upload' ? 'up' : 'down';
  return `${prefix}-${randomKeySuffix()}`;
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
