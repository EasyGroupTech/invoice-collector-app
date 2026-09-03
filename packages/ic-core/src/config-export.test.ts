import { describe, expect, it } from 'vitest';
import { applyConfigImport, buildConfigExport, CONFIG_EXPORT_SCHEMA } from './config-export.js';
import { createRecord, emptyConfigStore, type ConfigStore } from './config-store.js';

function storeWith(source: ReturnType<typeof createRecord>, destination?: ReturnType<typeof createRecord>): ConfigStore {
  return {
    version: 1,
    sources: [source],
    destinations: destination ? [destination] : [],
  };
}

describe('buildConfigExport', () => {
  it('carries plugin-owned config through verbatim — no secret-field stripping needed', () => {
    const destination = createRecord({ name: 'Downloads', pluginId: 'ic-local-downloads', pluginVersion: '1.0.0', config: { folder: '/tmp' } });
    const source = { ...createRecord({ name: 'Mailbox', pluginId: 'ic-email-to-downloads', pluginVersion: '1.0.0', config: { mailbox: 'a@b.com' }, destinationId: destination.id }), sessionId: 'session-123' };

    const exported = buildConfigExport(storeWith(source, destination));

    expect(exported.schema).toBe(CONFIG_EXPORT_SCHEMA);
    expect(exported.sources).toHaveLength(1);
    expect(exported.sources[0].config).toEqual({ mailbox: 'a@b.com' });
    expect(exported.destinations[0].config).toEqual({ folder: '/tmp' });
  });

  it('never includes sessionId — a Session reference is local-machine-only and must not leak into an export', () => {
    const source = { ...createRecord({ name: 'Mailbox', pluginId: 'p', pluginVersion: '1.0.0', config: {} }), sessionId: 'session-123' };
    const exported = buildConfigExport(storeWith(source));
    expect(exported.sources[0]).not.toHaveProperty('sessionId');
  });
});

describe('applyConfigImport', () => {
  it('rejects a payload with the wrong or missing schema tag', () => {
    expect(() => applyConfigImport(emptyConfigStore(), { schema: 'NOT-IT', exportedAt: '', sources: [], destinations: [] } as never)).toThrow(
      /not a recognized/i,
    );
  });

  it('adds a source with a fresh id when no existing record shares its name, and flags it as needing reconnect', () => {
    const source = createRecord({ name: 'Mailbox', pluginId: 'p', pluginVersion: '1.0.0', config: { a: 1 } });
    const exported = buildConfigExport(storeWith(source));

    const result = applyConfigImport(emptyConfigStore(), exported);

    expect(result.store.sources).toHaveLength(1);
    expect(result.store.sources[0].id).not.toBe(source.id);
    expect(result.store.sources[0].config).toEqual({ a: 1 });
    expect(result.importedSources).toEqual([{ name: 'Mailbox', action: 'added', needsReconnect: true }]);
  });

  it('overwrites an existing record by matching name, preserving its local id and sessionId', () => {
    const existing = { ...createRecord({ name: 'Mailbox', pluginId: 'p', pluginVersion: '1.0.0', config: { a: 1 } }), sessionId: 'kept-session' };
    const incomingSource = createRecord({ name: 'Mailbox', pluginId: 'p', pluginVersion: '2.0.0', config: { a: 2 } });
    const exported = buildConfigExport(storeWith(incomingSource));

    const result = applyConfigImport({ version: 1, sources: [existing], destinations: [] }, exported);

    expect(result.store.sources).toHaveLength(1);
    expect(result.store.sources[0].id).toBe(existing.id);
    expect(result.store.sources[0].sessionId).toBe('kept-session');
    expect(result.store.sources[0].config).toEqual({ a: 2 });
    expect(result.store.sources[0].pluginVersion).toBe('2.0.0');
    expect(result.importedSources).toEqual([{ name: 'Mailbox', action: 'overwritten', needsReconnect: false }]);
  });

  it('flags overwritten records with no surviving sessionId as needing reconnect', () => {
    const existing = createRecord({ name: 'Mailbox', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    const incomingSource = createRecord({ name: 'Mailbox', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    const exported = buildConfigExport(storeWith(incomingSource));

    const result = applyConfigImport({ version: 1, sources: [existing], destinations: [] }, exported);

    expect(result.importedSources[0].needsReconnect).toBe(true);
  });

  it('remaps a source destinationId from the export file id to the id the destination was actually stored under', () => {
    const destination = createRecord({ name: 'Downloads', pluginId: 'p', pluginVersion: '1.0.0', config: {} });
    const source = createRecord({ name: 'Mailbox', pluginId: 'p', pluginVersion: '1.0.0', config: {}, destinationId: destination.id });
    const exported = buildConfigExport(storeWith(source, destination));

    const result = applyConfigImport(emptyConfigStore(), exported);

    const importedDestinationId = result.store.destinations[0].id;
    expect(importedDestinationId).not.toBe(destination.id);
    expect(result.store.sources[0].destinationId).toBe(importedDestinationId);
  });

  it('imports destinations and sources independently by name, with no cross-matching', () => {
    const destination = createRecord({ name: 'Shared Name', pluginId: 'p', pluginVersion: '1.0.0', config: { kind: 'dest' } });
    const source = createRecord({ name: 'Shared Name', pluginId: 'p', pluginVersion: '1.0.0', config: { kind: 'source' } });
    const exported = buildConfigExport(storeWith(source, destination));

    const result = applyConfigImport(emptyConfigStore(), exported);

    expect(result.store.sources[0].config).toEqual({ kind: 'source' });
    expect(result.store.destinations[0].config).toEqual({ kind: 'dest' });
  });
});
