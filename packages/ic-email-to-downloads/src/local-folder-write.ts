import { access, mkdir, writeFile } from 'node:fs/promises';
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
  const targetDir = path.join(folderPath, sanitizeFileNamePart(sourceName), issuedMonthOf(invoice.issuedDate));
  await mkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, invoice.fileName);

  if (await fileExists(filePath)) {
    return { status: 'already-existed', location: filePath };
  }

  await writeFile(filePath, invoice.bytes);
  return { status: 'uploaded', location: filePath };
}
