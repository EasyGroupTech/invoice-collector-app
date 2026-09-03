import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultAdvancedSettings, loadAdvancedSettings, saveAdvancedSettings } from './advanced-settings.js';
import { DEFAULT_RETRY_POLICY } from './http-client.js';

describe('defaultAdvancedSettings', () => {
  it('returns the DEFAULT_RETRY_POLICY http-client.ts already falls back to', () => {
    expect(defaultAdvancedSettings()).toEqual({ version: 1, retryPolicy: DEFAULT_RETRY_POLICY });
  });
});

describe('loadAdvancedSettings / saveAdvancedSettings', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-advanced-settings-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns defaults when the file does not exist yet — a fresh install, not an error', async () => {
    const settings = await loadAdvancedSettings(path.join(dir, 'nested', 'advanced-settings.json'));
    expect(settings).toEqual(defaultAdvancedSettings());
  });

  it('round-trips a saved value', async () => {
    const filePath = path.join(dir, 'advanced-settings.json');
    await saveAdvancedSettings(filePath, { version: 1, retryPolicy: { baseDelayMs: 2000, maxRetries: 5 } });
    const loaded = await loadAdvancedSettings(filePath);
    expect(loaded).toEqual({ version: 1, retryPolicy: { baseDelayMs: 2000, maxRetries: 5 } });
  });

  it('creates the parent directory if it does not exist yet', async () => {
    const filePath = path.join(dir, 'nested', 'advanced-settings.json');
    await saveAdvancedSettings(filePath, defaultAdvancedSettings());
    await expect(readFile(filePath, 'utf-8')).resolves.toBeTruthy();
  });

  it('fills in a missing retryPolicy field from defaults rather than failing', async () => {
    const filePath = path.join(dir, 'advanced-settings.json');
    await saveAdvancedSettings(filePath, { version: 1, retryPolicy: { baseDelayMs: 2000 } as never });
    const loaded = await loadAdvancedSettings(filePath);
    expect(loaded.retryPolicy).toEqual({ baseDelayMs: 2000, maxRetries: DEFAULT_RETRY_POLICY.maxRetries });
  });
});
