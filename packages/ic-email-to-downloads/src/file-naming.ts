const UNSAFE_FILENAME_CHARS = /["*:<>?/\\|]/g;

/** Sanitizes one path segment (a file name, or — see local-folder-write.ts — a per-source
 * subfolder name) against characters no real filesystem accepts. Shared across this package since
 * both a vendor's attachment name and a user-supplied source name are untrusted input. */
export function sanitizeFileNamePart(value: string): string {
  return value.replace(UNSAFE_FILENAME_CHARS, '_');
}

/** `${invoiceNumber}_${originalAttachmentName}` when a built-in rule found an invoice number,
 * else just the attachment's own name — either way, sanitized against characters no real
 * filesystem accepts (a vendor's own attachment name is untrusted input). */
export function buildInvoiceFileName(invoiceNumber: string | undefined, originalAttachmentName: string): string {
  const safeName = sanitizeFileNamePart(originalAttachmentName);
  if (!invoiceNumber) return safeName;
  return `${sanitizeFileNamePart(invoiceNumber)}_${safeName}`;
}
