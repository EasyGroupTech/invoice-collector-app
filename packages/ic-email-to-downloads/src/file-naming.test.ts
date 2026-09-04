import { describe, expect, it } from 'vitest';
import { buildInvoiceFileName } from './file-naming.js';

describe('buildInvoiceFileName', () => {
  it('prefixes the original attachment name with the invoice number when one was found', () => {
    expect(buildInvoiceFileName('INV-1001', 'invoice.pdf')).toBe('INV-1001_invoice.pdf');
  });

  it('falls back to the bare attachment name when no invoice number was found', () => {
    expect(buildInvoiceFileName(undefined, 'invoice.pdf')).toBe('invoice.pdf');
  });

  it('sanitizes filesystem-unsafe characters out of both the invoice number and the attachment name', () => {
    expect(buildInvoiceFileName('INV/2026:01', 'weird*name?.pdf')).toBe('INV_2026_01_weird_name_.pdf');
  });
});
