const UNSAFE_FILENAME_CHARS = /["*:<>?/\\|]/g;

function sanitizeFileNamePart(value: string): string {
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
