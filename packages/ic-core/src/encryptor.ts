// Kept dependency-free so everything that uses it in ic-core stays plain-Node testable — the real
// safeStorage-backed implementation lives in the Electron shell (a later phase) and is injected
// here, never imported directly.
export interface Encryptor {
  isAvailable(): boolean;
  encrypt(plaintext: string): Buffer;
  decrypt(ciphertext: Buffer): string;
}

// Secret fields are stored as base64 strings in JSON (a config/session file can't hold raw
// Buffers), wrapping the Encryptor's Buffer-based interface.
export function encryptField(encryptor: Encryptor, plaintext: string): string {
  return encryptor.encrypt(plaintext).toString('base64');
}

export function decryptField(encryptor: Encryptor, base64Ciphertext: string): string {
  return encryptor.decrypt(Buffer.from(base64Ciphertext, 'base64'));
}
