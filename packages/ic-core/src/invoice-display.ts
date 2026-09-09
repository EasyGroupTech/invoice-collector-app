import type { InvoiceHistoryRecord } from './invoice-history.js';

/**
 * Best available display name for a record. `invoiceName` when a plugin supplied one; otherwise
 * the uploaded file's own basename (stripped of its extension) when `location` is a real file
 * path — a genuinely readable fallback for the many records already collected before
 * `invoiceName` existed, which the core-level dedup check (keyed on the unchanging `invoiceId`
 * alone) means will *never* pick one up retroactively just by being re-collected: the exact same
 * invoice is dedup-skipped forever, `record()` never runs for it again. Generic on purpose — no
 * assumption about any one plugin's own file-naming convention, just "the file's own name is more
 * readable than an opaque API id," true regardless of which plugin produced it. Falls back to the
 * raw `invoiceId` only when neither is available.
 *
 * Deliberately its own module, separate from invoice-history.ts — that module also does its own
 * file I/O (`node:fs/promises`), which Vite can't bundle for the renderer; CollectPage.tsx imports
 * this file directly (the same established pattern `wizard-form-state.ts`'s pure functions already
 * use), so it has to stay free of any Node-only import, transitively as well as directly.
 */
export function displayNameFor(record: Pick<InvoiceHistoryRecord, 'invoiceId' | 'invoiceName' | 'location'>): string {
  if (record.invoiceName) return record.invoiceName;
  if (record.location) {
    const base = record.location.split(/[/\\]/).pop();
    const withoutExtension = base?.replace(/\.[^./\\]+$/, '');
    if (withoutExtension) return withoutExtension;
  }
  return record.invoiceId;
}
