import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProfileManager, type ProfileManager } from './profiles.js';

describe('ProfileManager', () => {
  let dir: string;
  let manager: ProfileManager;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-profiles-'));
    manager = createProfileManager(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('getActiveProfileDir is synchronous and resolves under the Default profile before init', () => {
    expect(manager.getActiveProfileDir()).toBe(path.join(dir, 'profiles', 'default'));
  });

  it('init() creates a single Default profile on first run', async () => {
    await manager.init();
    const profiles = await manager.list();
    expect(profiles).toEqual([{ id: 'default', name: 'Default', isActive: true, createdAt: expect.any(String) }]);
  });

  it('init() is idempotent — a second call against an already-initialized dir does not duplicate the Default profile', async () => {
    await manager.init();
    await manager.init();
    expect(await manager.list()).toHaveLength(1);
  });

  it('init() picks up an already-initialized profiles.json without recreating it', async () => {
    await manager.init();
    await manager.create('Second', false);

    const reopened = createProfileManager(dir);
    await reopened.init();

    expect(await reopened.list()).toHaveLength(2);
  });

  it('create() adds a new profile with a slugified id, without switching active', async () => {
    await manager.init();
    const created = await manager.create('My Second Profile!', false);

    expect(created.id).toBe('my-second-profile');
    expect(created.isActive).toBe(false);
    expect(manager.getActiveProfileDir()).toBe(path.join(dir, 'profiles', 'default'));
  });

  it('create() disambiguates a colliding slug', async () => {
    await manager.init();
    await manager.create('Work', false);
    const second = await manager.create('Work', false);
    expect(second.id).toBe('work-2');
  });

  it('create() with copyFromCurrent copies the active profile\'s config.json but not its invoice-history.json', async () => {
    await manager.init();
    const activeDir = manager.getActiveProfileDir();
    await writeFile(path.join(activeDir, 'config.json'), '{"version":1}', 'utf-8');
    await writeFile(path.join(activeDir, 'invoice-history.json'), '{"seen":["a"]}', 'utf-8');

    const created = await manager.create('Copy', true);
    const copiedConfigPath = path.join(dir, 'profiles', created.id, 'config.json');
    const copiedHistoryPath = path.join(dir, 'profiles', created.id, 'invoice-history.json');

    await expect(readFileIfExists(copiedConfigPath)).resolves.toBe('{"version":1}');
    await expect(readFileIfExists(copiedHistoryPath)).resolves.toBeNull();
  });

  it('switchActive() changes getActiveProfileDir()', async () => {
    await manager.init();
    const created = await manager.create('Second', false);
    await manager.switchActive(created.id);
    expect(manager.getActiveProfileDir()).toBe(path.join(dir, 'profiles', created.id));
  });

  it('switchActive() rejects an unknown profile id', async () => {
    await manager.init();
    await expect(manager.switchActive('does-not-exist')).rejects.toThrow(/not found/i);
  });

  it('remove() refuses to delete the active profile', async () => {
    await manager.init();
    await manager.create('Second', false);
    await expect(manager.remove('default')).rejects.toThrow(/switch/i);
  });

  it('remove() deletes a non-active profile and its directory', async () => {
    await manager.init();
    const created = await manager.create('Second', false);
    const removedDir = path.join(dir, 'profiles', created.id);
    await mkdir(removedDir, { recursive: true });

    await manager.remove(created.id);

    expect(await manager.list()).toEqual([{ id: 'default', name: 'Default', isActive: true, createdAt: expect.any(String) }]);
    await expect(readFileIfExists(path.join(removedDir, 'marker'))).resolves.toBeNull();
  });
});

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    return await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
