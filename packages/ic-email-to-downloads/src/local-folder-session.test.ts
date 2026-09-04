import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext, Session } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showOpenDialog = vi.fn();
vi.mock('electron', () => ({ dialog: { showOpenDialog } }));

const { localFolderAccessSessionPlugin, LOCAL_FOLDER_SESSION_TYPE_ID } = await import('./local-folder-session.js');

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    sessionTypeId: LOCAL_FOLDER_SESSION_TYPE_ID,
    label: 'test',
    createdByPluginId: 'app.easygroup.destination.local-folder',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

function fakeContextWithSecret(secret: unknown): PluginContext {
  return {
    sessions: {
      get: async () => ({ session: fakeSession(), secret }),
    },
  } as unknown as PluginContext;
}

const signal = new AbortController().signal;

describe('localFolderAccessSessionPlugin.create', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-email-to-downloads-session-'));
    showOpenDialog.mockReset();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns a session whose secret carries the picked, writable folder path', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [dir] });

    const result = await localFolderAccessSessionPlugin.create({} as PluginContext, undefined, signal);

    expect(result.label).toBe(dir);
    expect(result.secret).toEqual({ folderPath: dir });
    expect(result.keepAliveIntervalMs).toBeGreaterThan(0);
  });

  it('throws when the user cancels the picker', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });

    await expect(localFolderAccessSessionPlugin.create({} as PluginContext, undefined, signal)).rejects.toThrow('No folder was selected');
  });

  it('throws when the picked folder is not actually writable', async () => {
    const missing = path.join(dir, 'does-not-exist');
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [missing] });

    await expect(localFolderAccessSessionPlugin.create({} as PluginContext, undefined, signal)).rejects.toThrow(/permissions/);
  });
});

describe('localFolderAccessSessionPlugin.refresh (the periodic folder-still-there health check)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-email-to-downloads-session-refresh-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns 'unchanged' when the folder is still there and writable", async () => {
    const ctx = fakeContextWithSecret({ folderPath: dir });
    await expect(localFolderAccessSessionPlugin.refresh!(ctx, fakeSession(), signal)).resolves.toBe('unchanged');
  });

  it('throws when the folder has been removed — the caller flips the session to needs-reconnect on any throw', async () => {
    const ctx = fakeContextWithSecret({ folderPath: path.join(dir, 'gone') });
    await expect(localFolderAccessSessionPlugin.refresh!(ctx, fakeSession(), signal)).rejects.toThrow(/Lost access/);
  });
});

describe('localFolderAccessSessionPlugin.test', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-email-to-downloads-session-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports 'ok' when the folder is still writable", async () => {
    const ctx = fakeContextWithSecret({ folderPath: dir });
    await expect(localFolderAccessSessionPlugin.test(ctx, fakeSession(), signal)).resolves.toBe('ok');
  });

  it("reports 'error' when the folder no longer exists — e.g. the user deleted it", async () => {
    const ctx = fakeContextWithSecret({ folderPath: path.join(dir, 'gone') });
    await expect(localFolderAccessSessionPlugin.test(ctx, fakeSession(), signal)).resolves.toBe('error');
  });

  it("reports 'error' when no stored secret is found at all", async () => {
    const ctx = fakeContextWithSecret(undefined);
    await expect(localFolderAccessSessionPlugin.test(ctx, fakeSession(), signal)).resolves.toBe('error');
  });
});

describe('localFolderAccessSessionPlugin.applyAuth', () => {
  it('passes the request through unchanged — folder access has no per-request auth to attach', () => {
    const request = { url: 'https://example.com' };
    expect(localFolderAccessSessionPlugin.applyAuth({ folderPath: '/tmp' }, request)).toBe(request);
  });
});
