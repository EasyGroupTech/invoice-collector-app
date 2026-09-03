import { describe, expect, it } from 'vitest';
import { decryptField, encryptField, type Encryptor } from './encryptor.js';

// A trivial reversible fake — real encryption is Electron's safeStorage, wired in behind this
// same interface once the Electron shell lands (later phase); this only tests the field-wrapping
// logic, not any specific cipher.
const fakeEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, 'utf-8'),
  decrypt: (ciphertext) => ciphertext.toString('utf-8'),
};

describe('encryptField / decryptField', () => {
  it('round-trips a plaintext string through the Encryptor as base64', () => {
    const encrypted = encryptField(fakeEncryptor, 'hello secret');
    expect(typeof encrypted).toBe('string');
    expect(decryptField(fakeEncryptor, encrypted)).toBe('hello secret');
  });

  it('produces a base64 string, not raw plaintext, since config/session files are JSON', () => {
    const encrypted = encryptField(fakeEncryptor, 'hello secret');
    expect(encrypted).not.toContain('hello secret');
    expect(Buffer.from(encrypted, 'base64').toString('utf-8')).toBe('hello secret');
  });
});
