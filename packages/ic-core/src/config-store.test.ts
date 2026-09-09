import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createRecord,
  deleteFlow,
  emptyConfigStore,
  loadConfigFile,
  removeRecord,
  saveConfigFile,
  upsertRecord,
  type ConfigStore,
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

  it('carries an optional sessionId through, if supplied', () => {
    const record = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {}, sessionId: 'session-1' });
    expect(record.sessionId).toBe('session-1');
  });

  it('leaves sessionId undefined when not supplied', () => {
    const record = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    expect(record.sessionId).toBeUndefined();
  });

  it('carries an optional scope through, if supplied', () => {
    const record = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {}, scope: 'Finance department' });
    expect(record.scope).toBe('Finance department');
  });

  it('leaves scope undefined when not supplied — empty by default', () => {
    const record = createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    expect(record.scope).toBeUndefined();
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

describe('deleteFlow', () => {
  function store(overrides: Partial<ConfigStore> = {}): ConfigStore {
    return { version: 1, sources: [], destinations: [], ...overrides };
  }

  it('removes the source', () => {
    const source = createRecord({ name: 'Mailbox', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    const result = deleteFlow(store({ sources: [source] }), source.id);
    expect(result.sources).toEqual([]);
  });

  it("removes the flow's own destination too, when nothing else uses it", () => {
    const destination = createRecord({ name: 'Downloads', pluginId: 'd', pluginVersion: '1.0.0', config: {} });
    const source = createRecord({ name: 'Mailbox', pluginId: 's', pluginVersion: '1.0.0', config: {}, destinationId: destination.id });
    const result = deleteFlow(store({ sources: [source], destinations: [destination] }), source.id);
    expect(result.destinations).toEqual([]);
  });

  it('keeps the destination when another remaining flow still uses it', () => {
    const destination = createRecord({ name: 'Downloads', pluginId: 'd', pluginVersion: '1.0.0', config: {} });
    const a = createRecord({ name: 'Mailbox A', pluginId: 's', pluginVersion: '1.0.0', config: {}, destinationId: destination.id });
    const b = createRecord({ name: 'Mailbox B', pluginId: 's', pluginVersion: '1.0.0', config: {}, destinationId: destination.id });
    const result = deleteFlow(store({ sources: [a, b], destinations: [destination] }), a.id);
    expect(result.sources).toEqual([b]);
    expect(result.destinations).toEqual([destination]);
  });

  it("orphans the source's own session when nothing else references it", () => {
    const source = createRecord({ name: 'Mailbox', pluginId: 's', pluginVersion: '1.0.0', config: {}, sessionId: 'session-1' });
    const result = deleteFlow(store({ sources: [source] }), source.id);
    expect(result.orphanedSessionIds).toEqual(['session-1']);
  });

  it("orphans the destination's own session too, when the destination itself gets removed", () => {
    const destination = createRecord({ name: 'Downloads', pluginId: 'd', pluginVersion: '1.0.0', config: {}, sessionId: 'dest-session' });
    const source = createRecord({
      name: 'Mailbox',
      pluginId: 's',
      pluginVersion: '1.0.0',
      config: {},
      destinationId: destination.id,
      sessionId: 'source-session',
    });
    const result = deleteFlow(store({ sources: [source], destinations: [destination] }), source.id);
    expect(result.orphanedSessionIds.sort()).toEqual(['dest-session', 'source-session']);
  });

  it("does not orphan the destination's session when another flow keeps the destination alive", () => {
    const destination = createRecord({ name: 'Downloads', pluginId: 'd', pluginVersion: '1.0.0', config: {}, sessionId: 'dest-session' });
    const a = createRecord({ name: 'Mailbox A', pluginId: 's', pluginVersion: '1.0.0', config: {}, destinationId: destination.id, sessionId: 'a-session' });
    const b = createRecord({ name: 'Mailbox B', pluginId: 's', pluginVersion: '1.0.0', config: {}, destinationId: destination.id });
    const result = deleteFlow(store({ sources: [a, b], destinations: [destination] }), a.id);
    expect(result.orphanedSessionIds).toEqual(['a-session']);
  });

  it('does not orphan a session another remaining source still shares (two sources, same session)', () => {
    const a = createRecord({ name: 'Mailbox A', pluginId: 's', pluginVersion: '1.0.0', config: {}, sessionId: 'shared-session' });
    const b = createRecord({ name: 'Mailbox B', pluginId: 's', pluginVersion: '1.0.0', config: {}, sessionId: 'shared-session' });
    const result = deleteFlow(store({ sources: [a, b] }), a.id);
    expect(result.orphanedSessionIds).toEqual([]);
  });

  it('is a no-op for a sourceId that does not exist', () => {
    const existing = store({ sources: [createRecord({ name: 'A', pluginId: 'p', pluginVersion: '1.0.0', config: {} })] });
    const result = deleteFlow(existing, 'does-not-exist');
    expect(result.sources).toEqual(existing.sources);
    expect(result.destinations).toEqual(existing.destinations);
    expect(result.orphanedSessionIds).toEqual([]);
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
