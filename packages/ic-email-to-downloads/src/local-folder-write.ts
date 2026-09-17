import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { InvoiceContent, UploadResult } from 'invoice-collector-plugin-sdk';
import { sanitizeFileNamePart } from './file-naming.js';

/** Whether this folder itself is still there and writable — the session-status check
 * (local-folder-session.ts) and this module's own pre-write check share this, so "does the
 * destination still work" and "can I actually write this invoice" never disagree. */
export async function checkFolderAccess(folderPath: string): Promise<'ok' | 'error'> {
  try {
    await access(folderPath, constants.W_OK);
    return 'ok';
  } catch {
    return 'error';
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Shared with `renameSourceFolder` below — the exact same `<folder>/<source>` join
 * `writeInvoiceToFolder` uses, so a rename ever only touches the one directory a source's own
 * invoices actually live under. */
function sourceDirFor(folderPath: string, sourceName: string): string {
  return path.join(folderPath, sanitizeFileNamePart(sourceName));
}

/** The invoice's own issued-month, "yyyy-mm" — `issuedDate` is always a plain ISO "yyyy-mm-dd"
 * string (every source in this repo produces it that way, e.g. Graph Mail's own
 * `receivedDateTime.slice(0, 10)` fallback), so a plain slice avoids any `Date`/timezone parsing
 * pitfall entirely. */
function issuedMonthOf(issuedDate: string): string {
  return issuedDate.slice(0, 7);
}

/**
 * §14.1 US7's local-folder destination — writes into `<folder>/<source>/<yyyy-mm>/<file>`, where
 * `<folder>` is the one the user picked when creating this destination's session
 * (local-folder-session.ts), `<source>` is the source that discovered the invoice (sanitized — a
 * user-supplied source name is untrusted input the same way a vendor's attachment name is, see
 * file-naming.ts), and `<yyyy-mm>` is the invoice's own issued month. Keeps multiple sources
 * sharing one destination — and, within a source, invoices spanning many months — from dumping
 * everything into a single flat folder. §5's "trivial, filesystem-based already-exists override
 * behavior": if a file already sits at the exact target path, this never overwrites it — the
 * simplest safe choice — and reports `already-existed` instead of silently clobbering whatever's
 * already there.
 */
export async function writeInvoiceToFolder(
  folderPath: string,
  sourceName: string,
  invoice: { fileName: string; issuedDate: string } & InvoiceContent,
): Promise<UploadResult> {
  const targetDir = path.join(sourceDirFor(folderPath, sourceName), issuedMonthOf(invoice.issuedDate));
  await mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, invoice.fileName);

  if (await fileExists(filePath)) {
    return { status: 'already-existed', location: filePath };
  }

  await writeFile(filePath, invoice.bytes);
  return { status: 'uploaded', location: filePath };
}

/**
 * §14.1's "renaming a flow should rename its destination folder too" follow-up — moves
 * `<folder>/<oldSource>` to `<folder>/<newSource>` so a source's already-collected invoices stay
 * unified under its new name instead of a future `writeInvoiceToFolder` call silently starting a
 * second, differently-named sibling directory. Three cases deliberately do nothing (returning
 * `undefined`, not an error) rather than fail loudly:
 * - Sanitizing both names collapses them to the same directory (e.g. a name change that's purely
 *   cosmetic once punctuation/casing gets stripped) — nothing to move.
 * - The old directory never existed (this source never actually wrote an invoice here yet) —
 *   nothing to move.
 * - The new directory already exists (a name reused from an earlier, differently-scoped source,
 *   say) — refuses to merge or overwrite; the old directory is left exactly where it is rather
 *   than risking a silent data mix-up. A real merge is out of scope for this pass.
 *
 * Returns the two absolute directories on an actual move — the caller (local-folder-plugin.ts)
 * uses them to build the `locationRewrite` function `SourceRenameHandler.onSourceRenamed` hands
 * back to core, so an already-recorded `InvoiceHistoryRecord.location` under the old directory
 * gets updated to match, instead of pointing at a path that no longer exists.
 */
export async function renameSourceFolder(folderPath: string, oldSourceName: string, newSourceName: string): Promise<{ oldDir: string; newDir: string } | undefined> {
  const oldDir = sourceDirFor(folderPath, oldSourceName);
  const newDir = sourceDirFor(folderPath, newSourceName);
  if (oldDir === newDir) return undefined;
  if (!(await fileExists(oldDir))) return undefined;
  if (await fileExists(newDir)) return undefined;
  await rename(oldDir, newDir);
  return { oldDir, newDir };
}
