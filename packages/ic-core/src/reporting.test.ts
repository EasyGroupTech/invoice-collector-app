import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildExcelReport, buildHtmlReport, buildReportRows, type ReportRow } from './reporting.js';
import type { InvoiceHistoryRecord } from './invoice-history.js';

function historyRecord(overrides: Partial<InvoiceHistoryRecord> = {}): InvoiceHistoryRecord {
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

describe('buildReportRows', () => {
  it('joins source/destination names by id', () => {
    const rows = buildReportRows(
      [historyRecord()],
      [{ id: 'source-1', name: 'Contoso Mailbox' }],
      [{ id: 'dest-1', name: 'Downloads' }],
    );
    expect(rows).toEqual([
      {
        sourceName: 'Contoso Mailbox',
        destinationName: 'Downloads',
        invoiceId: 'inv-1',
        issuedDate: '2026-01-15',
        amount: undefined,
        status: 'uploaded',
        collectedAt: '2026-01-16T00:00:00.000Z',
      },
    ]);
  });

  it('falls back to the bare id when the source/destination is no longer in config', () => {
    const rows = buildReportRows([historyRecord()], [], []);
    expect(rows[0].sourceName).toBe('source-1');
    expect(rows[0].destinationName).toBe('dest-1');
  });

  it('carries amount through unchanged when present', () => {
    const rows = buildReportRows([historyRecord({ amount: { value: 42.5, currency: 'USD' } })], [], []);
    expect(rows[0].amount).toEqual({ value: 42.5, currency: 'USD' });
  });
});

const sampleRows: ReportRow[] = [
  {
    sourceName: 'Contoso Mailbox',
    destinationName: 'Downloads',
    invoiceId: 'inv-1',
    issuedDate: '2026-01-15',
    amount: { value: 42.5, currency: 'USD' },
    status: 'uploaded',
    collectedAt: '2026-01-16T00:00:00.000Z',
  },
];

describe('buildHtmlReport', () => {
  it("uses the same column order/labels as the Collect page's own Collected invoices table", () => {
    const html = buildHtmlReport(sampleRows, { start: '2026-01-01', end: '2026-01-31' });
    const headers = [...html.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1]);
    expect(headers).toEqual(['Name', 'Source', 'Date issued', 'Total amount', 'Status', 'Collected', 'Uploaded destination path']);
  });

  it('includes the period, row count, and every row cell', () => {
    const html = buildHtmlReport(sampleRows, { start: '2026-01-01', end: '2026-01-31' });
    expect(html).toContain('2026-01-01');
    expect(html).toContain('2026-01-31');
    expect(html).toContain('1 invoice');
    expect(html).toContain('Contoso Mailbox');
    expect(html).toContain('Downloads');
    expect(html).toContain('42.50 USD');
    expect(html).toContain('uploaded');
  });

  it('escapes HTML-significant characters in row values', () => {
    const html = buildHtmlReport(
      [{ ...sampleRows[0], sourceName: '<script>alert(1)</script>' }],
      { start: '2026-01-01', end: '2026-01-31' },
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('pluralizes "invoices" correctly for zero and multiple rows', () => {
    expect(buildHtmlReport([], { start: '2026-01-01', end: '2026-01-31' })).toContain('0 invoices');
    expect(buildHtmlReport([sampleRows[0], sampleRows[0]], { start: '2026-01-01', end: '2026-01-31' })).toContain('2 invoices');
  });
});

/**
 * Verifies the real produced bytes rather than trusting buildExcelReport() didn't throw — an
 * .xlsx is a real zip container; unzip it with fflate (already a real dependency, see
 * buildExcelReport()'s own doc comment for why this avoids a second xlsx-reading library) and
 * check the actual text landed in xl/sharedStrings.xml, where write-excel-file puts every string
 * cell's value.
 */
function sharedStringsOf(bytes: Uint8Array): string {
  const files = unzipSync(bytes);
  return strFromU8(files['xl/sharedStrings.xml']);
}

describe('buildExcelReport', () => {
  it('produces a real xlsx a real unzip can read back, with every row present', async () => {
    const bytes = await buildExcelReport(sampleRows, { start: '2026-01-01', end: '2026-01-31' });

    const strings = sharedStringsOf(bytes);
    expect(strings).toContain('2026-01-01');
    expect(strings).toContain('Contoso Mailbox');
    expect(strings).toContain('Downloads');
    expect(strings).toContain('inv-1');
  });

  it('produces a valid (if header-only) workbook when there are no rows', async () => {
    const bytes = await buildExcelReport([], { start: '2026-01-01', end: '2026-01-31' });
    const files = unzipSync(bytes);
    expect(files['xl/worksheets/sheet1.xml']).toBeDefined();
  });
});
