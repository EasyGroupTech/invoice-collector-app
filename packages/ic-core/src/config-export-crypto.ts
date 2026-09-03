import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const SCHEMA = 'ICCONFIGENC1';

export interface EncryptedConfigExportFile {
  schema: typeof SCHEMA;
  salt: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

export function encryptConfigExport(payload: unknown, password: string): EncryptedConfigExportFile {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const key = scryptSync(password, salt, KEY_LENGTH);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf-8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    schema: SCHEMA,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptConfigExport<T = unknown>(file: EncryptedConfigExportFile, password: string): T {
  if (file?.schema !== SCHEMA) {
    throw new Error('This file is not a recognized Invoice Collector encrypted export.');
  }

  const salt = Buffer.from(file.salt, 'base64');
  const iv = Buffer.from(file.iv, 'base64');
  const authTag = Buffer.from(file.authTag, 'base64');
  const ciphertext = Buffer.from(file.ciphertext, 'base64');
  const key = scryptSync(password, salt, KEY_LENGTH);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString('utf-8')) as T;
  } catch {
    throw new Error('Incorrect password, or the file is corrupted.');
  }
}
