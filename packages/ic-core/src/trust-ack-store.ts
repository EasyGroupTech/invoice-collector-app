import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Persists which Unverified-tier plugin installs (§9) the user has already confirmed past the
 * warning dialog, keyed by exact id+version — "remembered per plugin id+version so it doesn't
 * re-prompt every launch." A version bump is a fresh install as far as this store is concerned:
 * the user re-confirms, since the code they're trusting has changed.
 */
export interface TrustAckFile {
  version: 1;
  acknowledged: string[];
}

function ackKey(pluginId: string, pluginVersion: string): string {
  return `${pluginId}@${pluginVersion}`;
}

export function hasAcknowledgedUnverifiedInstall(file: TrustAckFile, pluginId: string, pluginVersion: string): boolean {
  return file.acknowledged.includes(ackKey(pluginId, pluginVersion));
}

export function acknowledgeUnverifiedInstall(file: TrustAckFile, pluginId: string, pluginVersion: string): TrustAckFile {
  const key = ackKey(pluginId, pluginVersion);
  if (file.acknowledged.includes(key)) return file;
  return { ...file, acknowledged: [...file.acknowledged, key] };
}

export async function loadTrustAckFile(filePath: string): Promise<TrustAckFile> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TrustAckFile>;
    return { version: 1, acknowledged: parsed.acknowledged ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, acknowledged: [] };
    }
    throw err;
  }
}

export async function saveTrustAckFile(filePath: string, file: TrustAckFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8');
}
