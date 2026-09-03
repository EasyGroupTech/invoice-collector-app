import { randomUUID } from 'node:crypto';
import type { PluginBackedRecord } from 'invoice-collector-plugin-sdk';
import type { ConfigStore } from './config-store.js';

// v2 (previous app's export schema was 'ICCONFIG1', for its own SourceRecord/DestinationRecord
// shape): a generic PluginBackedRecord export, so the tag changes to avoid a mismatched-shape
// import silently "succeeding" against an old-format file.
export const CONFIG_EXPORT_SCHEMA = 'ICCONFIG2';

export interface ConfigExportRecord {
  id: string;
  name: string;
  pluginId: string;
  pluginVersion: string;
  destinationId?: string | null;
  config: unknown;
}

export interface ConfigExportFile {
  schema: typeof CONFIG_EXPORT_SCHEMA;
  exportedAt: string;
  sources: ConfigExportRecord[];
  destinations: ConfigExportRecord[];
}

// A record's `config` is contractually plugin-owned, non-secret, non-session JSON (see the SDK's
// PluginBackedRecord doc comment) — so unlike the old per-source-type export logic, there's no
// provider-specific secret field to strip here. The only thing that must never survive an export
// is `sessionId`: it references a Session that lives only on the machine that created it, so on
// any other install it would be either meaningless or (worse) collide with an unrelated session.
function toExportRecord(record: PluginBackedRecord): ConfigExportRecord {
  return {
    id: record.id,
    name: record.name,
    pluginId: record.pluginId,
    pluginVersion: record.pluginVersion,
    destinationId: record.destinationId,
    config: record.config,
  };
}

export function buildConfigExport(store: ConfigStore): ConfigExportFile {
  return {
    schema: CONFIG_EXPORT_SCHEMA,
    exportedAt: new Date().toISOString(),
    sources: store.sources.map(toExportRecord),
    destinations: store.destinations.map(toExportRecord),
  };
}

export interface ConfigImportItemResult {
  name: string;
  action: 'added' | 'overwritten';
  needsReconnect: boolean;
}

export interface ConfigImportResult {
  store: ConfigStore;
  importedSources: ConfigImportItemResult[];
  importedDestinations: ConfigImportItemResult[];
}

function importOne(
  existingList: PluginBackedRecord[],
  incoming: ConfigExportRecord,
  resolveDestinationId?: (oldId: string | null | undefined) => string | null | undefined,
): { list: PluginBackedRecord[]; record: PluginBackedRecord; result: ConfigImportItemResult } {
  const now = new Date().toISOString();
  const existingIndex = existingList.findIndex((r) => r.name === incoming.name);
  const destinationId = resolveDestinationId?.(incoming.destinationId);

  if (existingIndex !== -1) {
    const existing = existingList[existingIndex];
    const updated: PluginBackedRecord = {
      ...existing, // keeps the existing sessionId — re-importing an unchanged config must not sign anything out
      name: incoming.name,
      pluginId: incoming.pluginId,
      pluginVersion: incoming.pluginVersion,
      config: incoming.config,
      updatedAt: now,
      ...(resolveDestinationId ? { destinationId } : {}),
    };
    const list = [...existingList];
    list[existingIndex] = updated;
    return {
      list,
      record: updated,
      result: { name: incoming.name, action: 'overwritten', needsReconnect: !updated.sessionId },
    };
  }

  const created: PluginBackedRecord = {
    id: randomUUID(),
    name: incoming.name,
    pluginId: incoming.pluginId,
    pluginVersion: incoming.pluginVersion,
    ...(resolveDestinationId ? { destinationId } : {}),
    config: incoming.config,
    createdAt: now,
    updatedAt: now,
  };
  return {
    list: [...existingList, created],
    record: created,
    result: { name: incoming.name, action: 'added', needsReconnect: true },
  };
}

export function applyConfigImport(store: ConfigStore, payload: ConfigExportFile): ConfigImportResult {
  if (
    payload?.schema !== CONFIG_EXPORT_SCHEMA ||
    !Array.isArray(payload.sources) ||
    !Array.isArray(payload.destinations)
  ) {
    throw new Error('This file is not a recognized Invoice Collector configuration export.');
  }

  let destinations = [...store.destinations];
  const importedDestinations: ConfigImportItemResult[] = [];
  // Maps the export file's own destination id to the id it actually landed under in this store —
  // a new destination gets a fresh id, an overwritten one keeps its existing local id — so a
  // source referencing that destination (by the export file's id) can be remapped correctly below.
  const destinationIdMap = new Map<string, string | null>();

  for (const incoming of payload.destinations) {
    const { list, record, result } = importOne(destinations, incoming);
    destinations = list;
    destinationIdMap.set(incoming.id, record.id);
    importedDestinations.push(result);
  }

  let sources = [...store.sources];
  const importedSources: ConfigImportItemResult[] = [];

  for (const incoming of payload.sources) {
    const { list, result } = importOne(sources, incoming, (oldId) =>
      oldId ? (destinationIdMap.get(oldId) ?? null) : oldId,
    );
    sources = list;
    importedSources.push(result);
  }

  return {
    store: { ...store, sources, destinations },
    importedSources,
    importedDestinations,
  };
}
