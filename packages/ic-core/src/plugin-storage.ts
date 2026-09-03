import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginStorageApi } from 'invoice-collector-plugin-sdk';

type StorageRecord = Record<string, unknown>;

async function loadRecord(filePath: string): Promise<StorageRecord> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as StorageRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }
}

async function saveRecord(filePath: string, record: StorageRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf-8');
}

/** File-backed PluginStorageApi — one JSON file per plugin (paths.ts's
 * `profilePaths().pluginStorageFile(pluginId)`), so it's naturally isolated per profile too. */
export function createPluginStorage(filePath: string): PluginStorageApi {
  let cached: StorageRecord | null = null;

  async function state(): Promise<StorageRecord> {
    if (!cached) {
      cached = await loadRecord(filePath);
    }
    return cached;
  }

  async function persist(next: StorageRecord): Promise<void> {
    cached = next;
    await saveRecord(filePath, next);
  }

  return {
    async get(key) {
      return (await state())[key];
    },

    async set(key, value) {
      const record = await state();
      await persist({ ...record, [key]: value });
    },

    async delete(key) {
      const record = await state();
      if (!(key in record)) return;
      const { [key]: _removed, ...rest } = record;
      await persist(rest);
    },
  };
}
