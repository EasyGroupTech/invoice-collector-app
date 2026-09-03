import { describe, expect, it } from 'vitest';
import { decryptConfigExport, encryptConfigExport } from './config-export-crypto.js';

const payload = { schema: 'ICCONFIG2', exportedAt: '2026-01-01T00:00:00.000Z', sources: [], destinations: [] };

describe('encryptConfigExport / decryptConfigExport', () => {
  it('round-trips a payload with the correct password', () => {
    const encrypted = encryptConfigExport(payload, 'correct horse battery staple');
    expect(decryptConfigExport(encrypted, 'correct horse battery staple')).toEqual(payload);
  });

  it('produces an opaque file — no plaintext JSON anywhere in the encrypted output', () => {
    const encrypted = encryptConfigExport(payload, 'a password');
    expect(JSON.stringify(encrypted)).not.toContain('ICCONFIG2');
    expect(JSON.stringify(encrypted)).not.toContain('exportedAt');
  });

  it('uses a fresh random salt/iv per call — two encryptions of the same payload look different', () => {
    const a = encryptConfigExport(payload, 'same password');
    const b = encryptConfigExport(payload, 'same password');
    expect(a.salt).not.toBe(b.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('rejects the wrong password with a clear error, not silently garbled JSON', () => {
    const encrypted = encryptConfigExport(payload, 'right password');
    expect(() => decryptConfigExport(encrypted, 'wrong password')).toThrow(/incorrect password|corrupted/i);
  });

  it('rejects a tampered ciphertext (auth-tag verification failure), not silent corruption', () => {
    const encrypted = encryptConfigExport(payload, 'a password');
    const tampered = { ...encrypted, ciphertext: Buffer.from('tampered-bytes').toString('base64') };
    expect(() => decryptConfigExport(tampered, 'a password')).toThrow(/incorrect password|corrupted/i);
  });

  it('rejects a file with the wrong/missing schema tag before even attempting to decrypt', () => {
    // @ts-expect-error deliberately malformed input for the test
    expect(() => decryptConfigExport({ schema: 'SOMETHING-ELSE' }, 'any password')).toThrow(
      /not a recognized/i,
    );
  });
});
