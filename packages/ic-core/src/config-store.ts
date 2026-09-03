import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginBackedRecord } from 'invoice-collector-plugin-sdk';

export interface ConfigStore {
  version: 1;
  sources: PluginBackedRecord[];
  destinations: PluginBackedRecord[];
}

export function emptyConfigStore(): ConfigStore {
  return { version: 1, sources: [], destinations: [] };
}

export async function loadConfigFile(filePath: string): Promise<ConfigStore> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyConfigStore();
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<ConfigStore>;
  return {
    version: 1,
    sources: parsed.sources ?? [],
    destinations: parsed.destinations ?? [],
  };
}

export async function saveConfigFile(filePath: string, store: ConfigStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

export interface CreateRecordInput {
  name: string;
  pluginId: string;
  pluginVersion: string;
  config: unknown;
  destinationId?: string | null;
}

export function createRecord(input: CreateRecordInput): PluginBackedRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: input.name,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    destinationId: input.destinationId,
    config: input.config,
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertRecord(records: PluginBackedRecord[], record: PluginBackedRecord): PluginBackedRecord[] {
  const index = records.findIndex((r) => r.id === record.id);
  if (index === -1) {
    return [...records, record];
  }
  const next = [...records];
  next[index] = record;
  return next;
}

export function removeRecord(records: PluginBackedRecord[], id: string): PluginBackedRecord[] {
  return records.filter((r) => r.id !== id);
}
