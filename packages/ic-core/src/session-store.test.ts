import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptySessionsFile, loadSessionsFile, saveSessionsFile, type StoredSession } from './session-store.js';

const sample: StoredSession = {
  id: 's1',
  sessionTypeId: 'microsoft-entra-delegated-device-code',
  label: 'admin@contoso.com',
  createdByPluginId: 'ic-email-to-downloads',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'active',
  expiresAt: '2026-01-01T01:00:00.000Z',
  secretCiphertext: 'ZmFrZQ==',
  createInputCiphertext: 'ZmFrZQ==',
};

describe('emptySessionsFile', () => {
  it('returns an empty v1 file', () => {
    expect(emptySessionsFile()).toEqual({ version: 1, sessions: [] });
  });
});

describe('loadSessionsFile / saveSessionsFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-session-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty file when none exists yet', async () => {
    const file = await loadSessionsFile(path.join(dir, 'nested', 'sessions.json'));
    expect(file).toEqual(emptySessionsFile());
  });

  it('round-trips a file through save then load', async () => {
    const filePath = path.join(dir, 'sessions.json');
    const file = { version: 1 as const, sessions: [sample] };
    await saveSessionsFile(filePath, file);
    expect(await loadSessionsFile(filePath)).toEqual(file);
  });

  it('creates missing parent directories on save', async () => {
    const filePath = path.join(dir, 'a', 'b', 'sessions.json');
    await saveSessionsFile(filePath, emptySessionsFile());
    expect(await loadSessionsFile(filePath)).toEqual(emptySessionsFile());
  });
});
