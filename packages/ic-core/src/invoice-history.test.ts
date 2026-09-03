import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DiscoveredInvoice } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createInvoiceHistory,
  DEFAULT_RETENTION_MONTHS,
  emptyInvoiceHistoryStore,
  invoicesForMonth,
  loadInvoiceHistoryFile,
  pruneInvoiceHistory,
  saveInvoiceHistoryFile,
  upsertInvoiceHistoryRecord,
  type InvoiceHistoryRecord,
} from './invoice-history.js';

function record(overrides: Partial<InvoiceHistoryRecord> = {}): InvoiceHistoryRecord {
  return {
    sourceId: 'source-1',
    destinationId: 'dest-1',
    invoiceId: 'inv-1',
    issuedDate: '2026-01-15',
    status: 'uploaded',
    collectedAt: '2026-01-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('emptyInvoiceHistoryStore', () => {
  it('returns an empty v1 store with the default retention window', () => {
    expect(emptyInvoiceHistoryStore()).toEqual({ version: 1, retentionMonths: DEFAULT_RETENTION_MONTHS, invoices: [] });
  });
});

describe('upsertInvoiceHistoryRecord', () => {
  it('adds a new record', () => {
    const store = emptyInvoiceHistoryStore();
    const updated = upsertInvoiceHistoryRecord(store, record());
    expect(updated.invoices).toEqual([record()]);
  });

  it('replaces an existing record for the same (sourceId, invoiceId), not duplicating it', () => {
    const store = upsertInvoiceHistoryRecord(emptyInvoiceHistoryStore(), record({ status: 'already-existed' }));
    const retried = upsertInvoiceHistoryRecord(store, record({ status: 'uploaded' }));
    expect(retried.invoices).toHaveLength(1);
    expect(retried.invoices[0].status).toBe('uploaded');
  });

  it('keeps records for different sources or invoices distinct', () => {
    let store = emptyInvoiceHistoryStore();
    store = upsertInvoiceHistoryRecord(store, record({ invoiceId: 'inv-1' }));
    store = upsertInvoiceHistoryRecord(store, record({ invoiceId: 'inv-2' }));
    store = upsertInvoiceHistoryRecord(store, record({ sourceId: 'source-2', invoiceId: 'inv-1' }));
    expect(store.invoices).toHaveLength(3);
  });
});

describe('pruneInvoiceHistory', () => {
  it('drops invoices issued before the retention window, keeping ones within it', () => {
    const store = {
      version: 1 as const,
      retentionMonths: 12,
      invoices: [
        record({ invoiceId: 'old', issuedDate: '2024-01-01' }),
        record({ invoiceId: 'recent', issuedDate: '2026-01-01' }),
      ],
    };

    const pruned = pruneInvoiceHistory(store, new Date('2026-06-15'));

    expect(pruned.invoices.map((r) => r.invoiceId)).toEqual(['recent']);
  });

  it('treats "12 months" as the current month plus the 11 before it', () => {
    const store = {
      version: 1 as const,
      retentionMonths: 12,
      invoices: [
        record({ invoiceId: 'boundary', issuedDate: '2025-07-01' }), // exactly 11 months before June 2026
        record({ invoiceId: 'just-outside', issuedDate: '2025-06-30' }),
      ],
    };

    const pruned = pruneInvoiceHistory(store, new Date('2026-06-15'));

    expect(pruned.invoices.map((r) => r.invoiceId)).toEqual(['boundary']);
  });
});

describe('invoicesForMonth', () => {
  it('filters to invoices issued in the given month', () => {
    const store = {
      version: 1 as const,
      retentionMonths: 12,
      invoices: [record({ invoiceId: 'a', issuedDate: '2026-01-15' }), record({ invoiceId: 'b', issuedDate: '2026-02-01' })],
    };
    expect(invoicesForMonth(store, '2026-01').map((r) => r.invoiceId)).toEqual(['a']);
  });
});

describe('loadInvoiceHistoryFile / saveInvoiceHistoryFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-invoice-history-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty store when no file exists yet', async () => {
    const store = await loadInvoiceHistoryFile(path.join(dir, 'nested', 'invoice-history.json'));
    expect(store).toEqual(emptyInvoiceHistoryStore());
  });

  it('round-trips a store through save then load', async () => {
    const filePath = path.join(dir, 'invoice-history.json');
    const store = { version: 1 as const, retentionMonths: 6, invoices: [record()] };
    await saveInvoiceHistoryFile(filePath, store);
    expect(await loadInvoiceHistoryFile(filePath)).toEqual(store);
  });
});

describe('createInvoiceHistory (DedupChecker)', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-invoice-history-checker-'));
    filePath = path.join(dir, 'invoice-history.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };

  it('has() reports false for an invoice never recorded', async () => {
    const history = createInvoiceHistory(filePath);
    expect(await history.has('source-1', 'inv-1')).toBe(false);
  });

  it('record() then has() reports true for the same (sourceId, invoiceId)', async () => {
    const history = createInvoiceHistory(filePath);
    await history.record('source-1', 'dest-1', invoice, 'uploaded');
    expect(await history.has('source-1', 'inv-1')).toBe(true);
  });

  it('has() is scoped per source — a different source with the same invoiceId is not a match', async () => {
    const history = createInvoiceHistory(filePath);
    await history.record('source-1', 'dest-1', invoice, 'uploaded');
    expect(await history.has('source-2', 'inv-1')).toBe(false);
  });

  it('persists across instances (real file-backed store, not in-memory only)', async () => {
    const first = createInvoiceHistory(filePath);
    await first.record('source-1', 'dest-1', invoice, 'uploaded');

    const second = createInvoiceHistory(filePath);
    expect(await second.has('source-1', 'inv-1')).toBe(true);
  });

  it('prune() removes invoices outside the retention window and persists the result', async () => {
    const history = createInvoiceHistory(filePath);
    await history.record('source-1', 'dest-1', { id: 'old', issuedDate: '2020-01-01' }, 'uploaded');
    await history.record('source-1', 'dest-1', { id: 'recent', issuedDate: '2026-01-01' }, 'uploaded');

    await history.prune(new Date('2026-06-15'));

    expect(await history.has('source-1', 'old')).toBe(false);
    expect(await history.has('source-1', 'recent')).toBe(true);

    const reopened = createInvoiceHistory(filePath);
    expect(await reopened.has('source-1', 'old')).toBe(false);
  });

  it('listForMonth() returns recorded invoices for the given month', async () => {
    const history = createInvoiceHistory(filePath);
    await history.record('source-1', 'dest-1', { id: 'a', issuedDate: '2026-01-15' }, 'uploaded');
    await history.record('source-1', 'dest-1', { id: 'b', issuedDate: '2026-02-01' }, 'uploaded');

    const january = await history.listForMonth('2026-01');

    expect(january.map((r) => r.invoiceId)).toEqual(['a']);
  });
});
