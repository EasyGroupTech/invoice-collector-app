import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { PluginContext, PluginDestinationRecord, UploadableInvoice } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import localFolderDestination from './local-folder-plugin.js';

const signal = new AbortController().signal;

function fakeRecord(overrides: Partial<PluginDestinationRecord> = {}): PluginDestinationRecord {
  return {
    id: 'dest-1',
    name: 'Local Folder',
    pluginId: 'app.easygroup.destination.local-folder',
    pluginVersion: '0.0.0',
    config: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function fakeInvoice(overrides: Partial<UploadableInvoice> = {}): UploadableInvoice {
  return {
    id: 'inv-1',
    issuedDate: '2026-01-01',
    sourceName: 'Contoso Mailbox',
    fileName: 'INV-1_invoice.pdf',
    mimeType: 'application/pdf',
    bytes: new Uint8Array([1, 2, 3]),
    ...overrides,
  };
}

function fakeContextWithFolder(folderPath: string | undefined): PluginContext {
  return {
    sessions: {
      get: async () => (folderPath === undefined ? undefined : { session: {} as never, secret: { folderPath } }),
    },
  } as unknown as PluginContext;
}

describe('localFolderDestination.upload', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-email-to-downloads-dest-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the invoice into <session-selected folder>/<source>/<issued yyyy-mm>', async () => {
    const ctx = fakeContextWithFolder(dir);
    const result = await localFolderDestination.upload(ctx, fakeRecord({ sessionId: 'session-1' }), fakeInvoice(), signal);

    const expectedPath = path.join(dir, 'Contoso Mailbox', '2026-01', 'INV-1_invoice.pdf');
    expect(result).toEqual({ status: 'uploaded', location: expectedPath });
    expect(await readFile(expectedPath)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('throws when no session is assigned to this destination', async () => {
    const ctx = fakeContextWithFolder(dir);
    await expect(localFolderDestination.upload(ctx, fakeRecord({ sessionId: undefined }), fakeInvoice(), signal)).rejects.toThrow(
      'No destination folder selected',
    );
  });

  it('throws when the session id does not resolve to a stored folder secret', async () => {
    const ctx = fakeContextWithFolder(undefined);
    await expect(localFolderDestination.upload(ctx, fakeRecord({ sessionId: 'session-1' }), fakeInvoice(), signal)).rejects.toThrow(
      'No destination folder found',
    );
  });
});

describe('localFolderDestination.onSourceRenamed', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-email-to-downloads-rename-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renames the session's own folder's per-source subfolder from the old name to the new one, and returns a locationRewrite matching it", async () => {
    const ctx = fakeContextWithFolder(dir);
    const uploadResult = await localFolderDestination.upload(ctx, fakeRecord({ sessionId: 'session-1' }), fakeInvoice({ sourceName: 'Old Name' }), signal);

    const result = await localFolderDestination.onSourceRenamed?.(ctx, fakeRecord({ sessionId: 'session-1' }), 'Old Name', 'New Name', signal);

    const movedPath = path.join(dir, 'New Name', '2026-01', 'INV-1_invoice.pdf');
    await expect(readFile(movedPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(readFile(path.join(dir, 'Old Name', '2026-01', 'INV-1_invoice.pdf'))).rejects.toThrow();

    expect(result?.locationRewrite?.(uploadResult.location!)).toBe(movedPath);
  });

  it('locationRewrite leaves an unrelated location untouched', async () => {
    const ctx = fakeContextWithFolder(dir);
    await localFolderDestination.upload(ctx, fakeRecord({ sessionId: 'session-1' }), fakeInvoice({ sourceName: 'Old Name' }), signal);

    const result = await localFolderDestination.onSourceRenamed?.(ctx, fakeRecord({ sessionId: 'session-1' }), 'Old Name', 'New Name', signal);

    expect(result?.locationRewrite?.('/some/unrelated/path.pdf')).toBe('/some/unrelated/path.pdf');
  });

  it('returns undefined (no locationRewrite) when nothing was actually moved — no invoice was ever written under the old name', async () => {
    const ctx = fakeContextWithFolder(dir);

    const result = await localFolderDestination.onSourceRenamed?.(ctx, fakeRecord({ sessionId: 'session-1' }), 'Old Name', 'New Name', signal);

    expect(result).toBeUndefined();
  });

  it('does nothing when the record has no session assigned yet', async () => {
    const ctx = fakeContextWithFolder(dir);
    await expect(localFolderDestination.onSourceRenamed?.(ctx, fakeRecord({ sessionId: undefined }), 'Old Name', 'New Name', signal)).resolves.toBeUndefined();
  });

  it('does nothing when the session id does not resolve to a stored folder secret', async () => {
    const ctx = fakeContextWithFolder(undefined);
    await expect(
      localFolderDestination.onSourceRenamed?.(ctx, fakeRecord({ sessionId: 'session-1' }), 'Old Name', 'New Name', signal),
    ).resolves.toBeUndefined();
  });
});

describe('localFolderDestination manifest/session declaration', () => {
  it('declares a real, custom session requirement rather than an empty/no-session shortcut', () => {
    expect(localFolderDestination.sessionRequirements).toHaveLength(1);
    expect(localFolderDestination.sessionRequirements[0].confirmsBuiltIn).toBe(false);
    expect(localFolderDestination.sessionPlugin).toBeDefined();
  });

  it('supplies a builtInSessionCreateInput so session creation never needs a wizard-collected input', () => {
    expect(localFolderDestination.builtInSessionCreateInput?.(localFolderDestination.sessionRequirements[0])).toEqual({});
  });
});
