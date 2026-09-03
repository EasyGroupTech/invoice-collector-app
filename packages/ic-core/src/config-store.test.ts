import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRecord,
  emptyConfigStore,
  loadConfigFile,
  removeRecord,
  saveConfigFile,
  upsertRecord,
} from './config-store.js';

describe('emptyConfigStore', () => {
  it('returns an empty v1 store', () => {
    expect(emptyConfigStore()).toEqual({ version: 1, sources: [], destinations: [] });
  });
});

describe('createRecord', () => {
  it('stamps a fresh id and matching createdAt/updatedAt', () => {
    const record = createRecord({ name: 'My Mailbox', pluginId: 'ic-email-to-downloads', pluginVersion: '1.0.0', config: { mailbox: 'a@b.com' } });
    expect(record.id).toBeTruthy();
    expect(record.name).toBe('My Mailbox');
    expect(record.config).toEqual({ mailbox: 'a@b.com' });
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it('gives each record a distinct id', () => {
    const a = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    const b = createRecord({ name: 'B', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    expect(a.id).not.toBe(b.id);
  });
});

describe('upsertRecord / removeRecord', () => {
  it('appends a new record when its id is not already present', () => {
    const record = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    expect(upsertRecord([], record)).toEqual([record]);
  });

  it('replaces the existing record in place when the id already exists', () => {
    const record = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    const updated = { ...record, name: 'A renamed' };
    expect(upsertRecord([record], updated)).toEqual([updated]);
  });

  it('removes a record by id, leaving the rest untouched', () => {
    const a = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    const b = createRecord({ name: 'B', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    expect(removeRecord([a, b], a.id)).toEqual([b]);
  });
});

describe('loadConfigFile / saveConfigFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-config-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty store when the file does not exist yet', async () => {
    const store = await loadConfigFile(path.join(dir, 'nested', 'config.json'));
    expect(store).toEqual(emptyConfigStore());
  });

  it('round-trips a store through save then load', async () => {
    const filePath = path.join(dir, 'config.json');
    const record = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: { x: 1 } });
    const store = { version: 1 as const, sources: [record], destinations: [] };

    await saveConfigFile(filePath, store);
    expect(await loadConfigFile(filePath)).toEqual(store);
  });

  it('creates any missing parent directories on save', async () => {
    const filePath = path.join(dir, 'a', 'b', 'config.json');
    await saveConfigFile(filePath, emptyConfigStore());
    expect(await readFile(filePath, 'utf-8')).toContain('"version": 1');
  });
});
