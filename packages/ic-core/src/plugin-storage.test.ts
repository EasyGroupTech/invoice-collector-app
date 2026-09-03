import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPluginStorage } from './plugin-storage.js';

describe('createPluginStorage', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-storage-'));
    filePath = path.join(dir, 'nested', 'plugin.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('get() returns undefined for a key never set', async () => {
    const storage = createPluginStorage(filePath);
    expect(await storage.get('missing')).toBeUndefined();
  });

  it('set() then get() round-trips a value, including creating missing parent directories', async () => {
    const storage = createPluginStorage(filePath);
    await storage.set('rule', { pattern: 'invoice-*.pdf' });
    expect(await storage.get('rule')).toEqual({ pattern: 'invoice-*.pdf' });
  });

  it('delete() removes a key without disturbing others', async () => {
    const storage = createPluginStorage(filePath);
    await storage.set('a', 1);
    await storage.set('b', 2);
    await storage.delete('a');
    expect(await storage.get('a')).toBeUndefined();
    expect(await storage.get('b')).toBe(2);
  });

  it('persists across instances (real file-backed store)', async () => {
    const first = createPluginStorage(filePath);
    await first.set('key', 'value');

    const second = createPluginStorage(filePath);
    expect(await second.get('key')).toBe('value');
  });

  it('deleting a key that does not exist is a no-op, not an error', async () => {
    const storage = createPluginStorage(filePath);
    await expect(storage.delete('nope')).resolves.toBeUndefined();
  });
});
