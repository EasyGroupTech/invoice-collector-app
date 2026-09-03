import { safeStorage } from 'electron';
import type { Encryptor } from '../../src/encryptor.js';

// If isAvailable() is false, callers must block secret-dependent actions with a clear error —
// never fall back to plaintext silently.
export const safeStorageEncryptor: Encryptor = {
  isAvailable: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plaintext: string) => safeStorage.encryptString(plaintext),
  decrypt: (ciphertext: Buffer) => safeStorage.decryptString(ciphertext),
};
