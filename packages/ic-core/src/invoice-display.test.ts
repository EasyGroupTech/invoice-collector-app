import { describe, expect, it } from 'vitest';
import { displayNameFor } from './invoice-display.js';
import type { InvoiceHistoryRecord } from './invoice-history.js';

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

describe('displayNameFor', () => {
  it('prefers invoiceName when present', () => {
    expect(displayNameFor(record({ invoiceName: 'G181587741', location: '/x/other.pdf' }))).toBe('G181587741');
  });

  it("falls back to the uploaded file's own basename, minus extension, when invoiceName is unset", () => {
    expect(displayNameFor(record({ invoiceName: undefined, location: '/Users/me/Downloads/G181587741_G181587741.pdf' }))).toBe(
      'G181587741_G181587741',
    );
  });

  it('handles a Windows-style backslash path the same way', () => {
    expect(displayNameFor(record({ invoiceName: undefined, location: 'C:\\Users\\me\\Downloads\\invoice-42.pdf' }))).toBe('invoice-42');
  });

  it('falls back to the raw invoiceId when neither invoiceName nor location is available', () => {
    expect(displayNameFor(record({ invoiceId: 'opaque-id-123', invoiceName: undefined, location: undefined }))).toBe('opaque-id-123');
  });

  it('falls back to invoiceId when location has no filename component (a bare directory path)', () => {
    expect(displayNameFor(record({ invoiceId: 'opaque-id-123', invoiceName: undefined, location: '/Users/me/Downloads/' }))).toBe(
      'opaque-id-123',
    );
  });
});
