import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DiscoveredInvoice, UploadResult } from 'invoice-collector-plugin-sdk';
import type { CollectPeriod, DedupChecker } from './collect-pipeline.js';

/**
 * One collected invoice, keyed by (sourceId, invoiceId) — §14.1 US13's "deduplicated, per-month
 * record of everything ever collected." Only ever written for a *successful* upload
 * (uploaded/already-existed/overwritten) — collect-pipeline.ts never calls DedupChecker.record()
 * for a failed attempt, so a failure is naturally retried on the next run rather than remembered
 * as done.
 */
export interface InvoiceHistoryRecord {
  sourceId: string;
  destinationId: string;
  invoiceId: string;
  /** Human-readable label (`DiscoveredInvoice.name`) — an invoice number when the plugin found
   * one, a filename otherwise. Unset for a record written before this field existed, or by a
   * plugin that hasn't started supplying one; every display of this record falls back to
   * `invoiceId` in that case, but `invoiceId` is often an opaque API id, never meant to be read. */
  invoiceName?: string;
  issuedDate: string;
  amount?: { value: number; currency: string };
  status: UploadResult['status'];
  /** Where the invoice actually landed — see `UploadResult.location`. Unset for a record written
   * before this field existed, or by a destination type that reported no location. */
  location?: string;
  collectedAt: string;
}

export const DEFAULT_RETENTION_MONTHS = 12;

export interface InvoiceHistoryStore {
  version: 1;
  retentionMonths: number;
  invoices: InvoiceHistoryRecord[];
}

export function emptyInvoiceHistoryStore(): InvoiceHistoryStore {
  return { version: 1, retentionMonths: DEFAULT_RETENTION_MONTHS, invoices: [] };
}

export async function loadInvoiceHistoryFile(filePath: string): Promise<InvoiceHistoryStore> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyInvoiceHistoryStore();
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<InvoiceHistoryStore>;
  return {
    version: 1,
    retentionMonths: parsed.retentionMonths ?? DEFAULT_RETENTION_MONTHS,
    invoices: parsed.invoices ?? [],
  };
}

export async function saveInvoiceHistoryFile(filePath: string, store: InvoiceHistoryStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

function dedupeKey(sourceId: string, invoiceId: string): string {
  return `${sourceId}:${invoiceId}`;
}

/** An invoice already on file gets replaced by the latest record (e.g. a retried upload
 * overwrites an earlier one for the same invoice) rather than duplicated. */
export function upsertInvoiceHistoryRecord(store: InvoiceHistoryStore, record: InvoiceHistoryRecord): InvoiceHistoryStore {
  const byKey = new Map(store.invoices.map((r) => [dedupeKey(r.sourceId, r.invoiceId), r]));
  byKey.set(dedupeKey(record.sourceId, record.invoiceId), record);
  return { ...store, invoices: [...byKey.values()] };
}

/** Drops invoices issued before the retention window — "12 months" means the current month plus
 * the 11 before it. */
export function pruneInvoiceHistory(store: InvoiceHistoryStore, now: Date): InvoiceHistoryStore {
  const cutoff = new Date(now.getFullYear(), now.getMonth() - (store.retentionMonths - 1), 1);
  const cutoffMonth = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
  return {
    ...store,
    invoices: store.invoices.filter((r) => r.issuedDate.slice(0, 7) >= cutoffMonth),
  };
}

export function invoicesForMonth(store: InvoiceHistoryStore, issuedMonth: string): InvoiceHistoryRecord[] {
  return store.invoices.filter((r) => r.issuedDate.slice(0, 7) === issuedMonth);
}

/** §14.1 US20's reporting query — a Collect run's own `period` is an arbitrary ISO date range,
 * not necessarily aligned to calendar months, so `invoicesForMonth`'s month-bucket filter doesn't
 * fit; this filters the same in-memory `store.invoices` directly by `issuedDate`, inclusive on
 * both ends (a period whose `end` is "today" should still include an invoice issued today). */
export function invoicesForPeriod(store: InvoiceHistoryStore, period: CollectPeriod): InvoiceHistoryRecord[] {
  return store.invoices.filter((r) => r.issuedDate >= period.start && r.issuedDate <= period.end);
}

export interface InvoiceHistory extends DedupChecker {
  /** Drops invoices outside the retention window and persists the result — call once per
   * completed collect run (not per invoice), matching the reference app's own call site. */
  prune(now?: Date): Promise<void>;
  listForMonth(issuedMonth: string): Promise<InvoiceHistoryRecord[]>;
  listForPeriod(period: CollectPeriod): Promise<InvoiceHistoryRecord[]>;
  getRetentionMonths(): Promise<number>;
  /** Persists the new retention window only — matches the reference app's own handler exactly:
   * doesn't prune immediately, the new window just takes effect on the next `prune()` call. */
  setRetentionMonths(months: number): Promise<void>;
  /** Wipes every collected-invoice record (e.g. to clear out test data) — keeps the
   * retention-months setting intact, only clears the invoices list. */
  clear(): Promise<void>;
}

export function createInvoiceHistory(filePath: string): InvoiceHistory {
  let cached: InvoiceHistoryStore | null = null;

  async function state(): Promise<InvoiceHistoryStore> {
    if (!cached) {
      cached = await loadInvoiceHistoryFile(filePath);
    }
    return cached;
  }

  async function persist(next: InvoiceHistoryStore): Promise<void> {
    cached = next;
    await saveInvoiceHistoryFile(filePath, next);
  }

  return {
    async has(sourceId, invoiceId) {
      const store = await state();
      return store.invoices.some((r) => r.sourceId === sourceId && r.invoiceId === invoiceId);
    },

    async record(sourceId, destinationId, invoice: DiscoveredInvoice, result: UploadResult) {
      const store = await state();
      const record: InvoiceHistoryRecord = {
        sourceId,
        destinationId,
        invoiceId: invoice.id,
        invoiceName: invoice.name,
        issuedDate: invoice.issuedDate,
        amount: invoice.amount,
        status: result.status,
        location: result.location,
        collectedAt: new Date().toISOString(),
      };
      await persist(upsertInvoiceHistoryRecord(store, record));
    },

    async prune(now = new Date()) {
      const store = await state();
      await persist(pruneInvoiceHistory(store, now));
    },

    async listForMonth(issuedMonth) {
      const store = await state();
      return invoicesForMonth(store, issuedMonth);
    },

    async listForPeriod(period) {
      const store = await state();
      return invoicesForPeriod(store, period);
    },

    async getRetentionMonths() {
      const store = await state();
      return store.retentionMonths;
    },

    async setRetentionMonths(months) {
      const store = await state();
      await persist({ ...store, retentionMonths: months });
    },

    async clear() {
      const store = await state();
      await persist({ ...store, invoices: [] });
    },
  };
}
