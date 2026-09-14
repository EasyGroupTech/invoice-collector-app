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

/**
 * Fans a single `PluginStorageApi` call out across every given store — `set`/`delete` write to
 * all of them, `get` reads from just the first (kept in sync with the rest by every `set` this
 * same wrapper has made — a store never written through a second wrapper instance can still drift,
 * but that's not a case activation's own one-shot usage below hits). Used to make license-check's
 * own one-time activation step (§9.1/§15, `ActivationRequirement`) actually apply to every
 * implementation a package bundles (e.g. Claude Team + Claude API/Console, one package, two
 * `SourcePlugin`s), not just whichever single implementation core happened to run `activate()`
 * against — core has no idea what `activate()` actually writes into storage
 * (`PluginStorageApi`'s own doc comment: "the SDK has no idea that's what it's being used for"),
 * so this fans out generically by store rather than special-casing any particular key.
 */
export function createPackageWideStorage(stores: PluginStorageApi[]): PluginStorageApi {
  if (stores.length === 0) {
    throw new Error('createPackageWideStorage requires at least one store');
  }
  const [primary] = stores;
  return {
    get: (key) => primary.get(key),
    async set(key, value) {
      await Promise.all(stores.map((store) => store.set(key, value)));
    },
    async delete(key) {
      await Promise.all(stores.map((store) => store.delete(key)));
    },
  };
}
