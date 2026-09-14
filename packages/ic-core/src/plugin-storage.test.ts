import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPackageWideStorage, createPluginStorage } from './plugin-storage.js';

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

describe('createPackageWideStorage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-package-wide-storage-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('set() writes to every store, not just the first', async () => {
    const teamStore = createPluginStorage(path.join(dir, 'claude-team.json'));
    const apiStore = createPluginStorage(path.join(dir, 'claude-api.json'));
    const packageStorage = createPackageWideStorage([teamStore, apiStore]);

    await packageStorage.set('license-check:activation', { verifiedEmail: 'buyer@example.com' });

    expect(await teamStore.get('license-check:activation')).toEqual({ verifiedEmail: 'buyer@example.com' });
    expect(await apiStore.get('license-check:activation')).toEqual({ verifiedEmail: 'buyer@example.com' });
  });

  it('get() reads from the first store given', async () => {
    const teamStore = createPluginStorage(path.join(dir, 'claude-team.json'));
    const apiStore = createPluginStorage(path.join(dir, 'claude-api.json'));
    await teamStore.set('key', 'from-team');
    await apiStore.set('key', 'from-api');

    const packageStorage = createPackageWideStorage([teamStore, apiStore]);
    expect(await packageStorage.get('key')).toBe('from-team');
  });

  it('delete() removes the key from every store', async () => {
    const teamStore = createPluginStorage(path.join(dir, 'claude-team.json'));
    const apiStore = createPluginStorage(path.join(dir, 'claude-api.json'));
    const packageStorage = createPackageWideStorage([teamStore, apiStore]);
    await packageStorage.set('key', 'value');

    await packageStorage.delete('key');

    expect(await teamStore.get('key')).toBeUndefined();
    expect(await apiStore.get('key')).toBeUndefined();
  });

  it('a single-implementation package (one store) behaves exactly like createPluginStorage alone', async () => {
    const soloStore = createPluginStorage(path.join(dir, 'azure-billing.json'));
    const packageStorage = createPackageWideStorage([soloStore]);

    await packageStorage.set('key', 'value');

    expect(await packageStorage.get('key')).toBe('value');
    expect(await soloStore.get('key')).toBe('value');
  });

  it('throws if given no stores at all — a caller bug, not a valid empty package', () => {
    expect(() => createPackageWideStorage([])).toThrow(/at least one store/);
  });
});
