import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import type { InvoiceContent, UploadResult } from 'invoice-collector-plugin-sdk';

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

/**
 * §14.1 US7's local-folder destination — writes straight into the folder the user picked when
 * creating this destination's session (local-folder-session.ts), no subfolder/naming
 * customization. §5's "trivial, filesystem-based already-exists override behavior": if a file
 * already sits at the exact target path, this never overwrites it — the simplest safe choice —
 * and reports `already-existed` instead of silently clobbering whatever's already there.
 */
export async function writeInvoiceToFolder(
  folderPath: string,
  invoice: { fileName: string } & InvoiceContent,
): Promise<UploadResult> {
  await mkdir(folderPath, { recursive: true });
  const filePath = path.join(folderPath, invoice.fileName);

  if (await fileExists(filePath)) {
    return { status: 'already-existed' };
  }

  await writeFile(filePath, invoice.bytes);
  return { status: 'uploaded' };
}
