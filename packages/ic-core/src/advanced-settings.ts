import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './http-client.js';

export interface AdvancedSettings {
  version: 1;
  retryPolicy: RetryPolicy;
}

export function defaultAdvancedSettings(): AdvancedSettings {
  return { version: 1, retryPolicy: DEFAULT_RETRY_POLICY };
}

/** Same ENOENT-tolerant, defaults-on-missing-fields shape as config-store.ts's loadConfigFile —
 * a fresh install (or one from before this file existed) has no advanced-settings.json at all;
 * that's not an error, it's just "use the defaults," so there's nothing to migrate. */
export async function loadAdvancedSettings(filePath: string): Promise<AdvancedSettings> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return defaultAdvancedSettings();
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<AdvancedSettings>;
  return {
    version: 1,
    retryPolicy: {
      baseDelayMs: parsed.retryPolicy?.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
      maxRetries: parsed.retryPolicy?.maxRetries ?? DEFAULT_RETRY_POLICY.maxRetries,
    },
  };
}

export async function saveAdvancedSettings(filePath: string, settings: AdvancedSettings): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(settings, null, 2), 'utf-8');
}
