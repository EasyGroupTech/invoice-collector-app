import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SessionStatus } from 'invoice-collector-plugin-sdk';

/**
 * A Session (SDK shape) plus its own encrypted-at-rest fields. Never leaves ic-core in this
 * shape — `secretCiphertext`/`createInputCiphertext` are stripped before a Session crosses into
 * `SessionsApi`'s public surface.
 */
export interface StoredSession {
  id: string;
  sessionTypeId: string;
  label: string;
  createdByPluginId: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  expiresAt?: string;
  keepAliveIntervalMs?: number;
  /** Encrypted `SessionPlugin.create()`/`refresh()` result secret, base64 via an Encryptor. */
  secretCiphertext: string;
  /** Encrypted original input to `create()` — replayed by `reconnect()`, since core has no
   * generic way to reconstruct a plugin-specific create input from a stored secret alone. */
  createInputCiphertext: string;
}

export interface SessionsFile {
  version: 1;
  sessions: StoredSession[];
}

export function emptySessionsFile(): SessionsFile {
  return { version: 1, sessions: [] };
}

export async function loadSessionsFile(filePath: string): Promise<SessionsFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptySessionsFile();
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<SessionsFile>;
  return { version: 1, sessions: parsed.sessions ?? [] };
}

export async function saveSessionsFile(filePath: string, file: SessionsFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8');
}
