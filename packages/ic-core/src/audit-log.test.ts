import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuditLog, emptyAuditLogFile, loadAuditLogFile, saveAuditLogFile, type AuditLogEntry } from './audit-log.js';

function sampleEntry(overrides: Partial<Omit<AuditLogEntry, 'id' | 'timestamp'>> = {}): Omit<AuditLogEntry, 'id' | 'timestamp'> {
  return {
    pluginId: 'tech.easygroup.source.azure-billing',
    method: 'GET',
    url: 'https://management.azure.com/…/invoices',
    status: 200,
    durationMs: 120,
    requestHeaders: { 'Content-Type': 'application/json' },
    responseHeaders: { 'Content-Type': 'application/json' },
    requestBody: { kind: 'omitted', reason: 'empty' },
    responseBody: { kind: 'json', value: { value: [] } },
    ...overrides,
  };
}

describe('emptyAuditLogFile', () => {
  it('returns an empty v1 file', () => {
    expect(emptyAuditLogFile()).toEqual({ version: 1, entries: [] });
  });
});

describe('loadAuditLogFile / saveAuditLogFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-audit-log-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty file when nothing has been saved yet (ENOENT)', async () => {
    const file = await loadAuditLogFile(path.join(dir, 'audit-log.json'));
    expect(file).toEqual({ version: 1, entries: [] });
  });

  it('round-trips a saved file', async () => {
    const filePath = path.join(dir, 'audit-log.json');
    const entry: AuditLogEntry = { id: 'e1', timestamp: '2026-01-01T00:00:00.000Z', ...sampleEntry() };
    await saveAuditLogFile(filePath, { version: 1, entries: [entry] });

    expect(await loadAuditLogFile(filePath)).toEqual({ version: 1, entries: [entry] });
  });

  it('creates the parent directory if it does not exist yet', async () => {
    const filePath = path.join(dir, 'nested', 'audit-log.json');
    await saveAuditLogFile(filePath, emptyAuditLogFile());
    await expect(readFile(filePath, 'utf-8')).resolves.toContain('"entries"');
  });
});

describe('createAuditLog', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-audit-log-registry-'));
    filePath = path.join(dir, 'audit-log.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('list() is empty before anything is recorded', async () => {
    const log = createAuditLog({ filePath });
    expect(await log.list()).toEqual([]);
  });

  it('record() persists an entry with a generated id/timestamp, retrievable via list()', async () => {
    const log = createAuditLog({ filePath, now: () => new Date('2026-01-01T00:00:00.000Z'), randomId: () => 'fixed-id' });
    await log.record(sampleEntry());

    const entries = await log.list();
    expect(entries).toEqual([{ id: 'fixed-id', timestamp: '2026-01-01T00:00:00.000Z', ...sampleEntry() }]);
  });

  it('record() survives across a fresh createAuditLog against the same file (persisted, not just in-memory)', async () => {
    const first = createAuditLog({ filePath });
    await first.record(sampleEntry({ url: 'https://example.com/a' }));

    const second = createAuditLog({ filePath });
    const entries = await second.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe('https://example.com/a');
  });

  it('caps at maxEntries, dropping the oldest first (a bounded ring buffer)', async () => {
    const log = createAuditLog({ filePath, maxEntries: 2 });
    await log.record(sampleEntry({ url: 'https://example.com/1' }));
    await log.record(sampleEntry({ url: 'https://example.com/2' }));
    await log.record(sampleEntry({ url: 'https://example.com/3' }));

    const entries = await log.list();
    expect(entries.map((e) => e.url)).toEqual(['https://example.com/2', 'https://example.com/3']);
  });

  it('clear() empties the log, persisted', async () => {
    const log = createAuditLog({ filePath });
    await log.record(sampleEntry());
    await log.clear();

    expect(await log.list()).toEqual([]);
    const freshLog = createAuditLog({ filePath });
    expect(await freshLog.list()).toEqual([]);
  });
});
