import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiscoveredInvoice, InvoiceContent, PluginContext, PluginDestinationRecord } from 'invoice-collector-plugin-sdk';
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

function fakeInvoice(): DiscoveredInvoice & InvoiceContent {
  return {
    id: 'inv-1',
    issuedDate: '2026-01-01',
    fileName: 'INV-1_invoice.pdf',
    mimeType: 'application/pdf',
    bytes: new Uint8Array([1, 2, 3]),
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

  it('writes the invoice into the session-selected folder', async () => {
    const ctx = fakeContextWithFolder(dir);
    const result = await localFolderDestination.upload(ctx, fakeRecord({ sessionId: 'session-1' }), fakeInvoice(), signal);

    expect(result).toEqual({ status: 'uploaded' });
    expect(await readFile(path.join(dir, 'INV-1_invoice.pdf'))).toEqual(Buffer.from([1, 2, 3]));
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
