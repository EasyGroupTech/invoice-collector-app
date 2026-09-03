import writeXlsxFile from 'write-excel-file/node';
import type { CollectPeriod } from './collect-pipeline.js';
import type { InvoiceHistoryRecord } from './invoice-history.js';

export interface ReportRow {
  sourceName: string;
  destinationName: string;
  invoiceId: string;
  issuedDate: string;
  amount?: { value: number; currency: string };
  status: InvoiceHistoryRecord['status'];
  collectedAt: string;
}

export interface NameLookup {
  id: string;
  name: string;
}

/**
 * §14.1 US20's report — joins invoice-history's bare `sourceId`/`destinationId` (§14.1 US13,
 * kept minimal on purpose) against the *current* config's source/destination names, so a report
 * reads as "Contoso Mailbox" rather than a bare UUID. A record whose source/destination has since
 * been removed from config still gets a row — falls back to the bare id rather than being dropped,
 * since the invoice was genuinely collected regardless of what happened to the record afterward.
 */
export function buildReportRows(records: InvoiceHistoryRecord[], sources: NameLookup[], destinations: NameLookup[]): ReportRow[] {
  const sourceNames = new Map(sources.map((s) => [s.id, s.name]));
  const destinationNames = new Map(destinations.map((d) => [d.id, d.name]));

  return records.map((r) => ({
    sourceName: sourceNames.get(r.sourceId) ?? r.sourceId,
    destinationName: destinationNames.get(r.destinationId) ?? r.destinationId,
    invoiceId: r.invoiceId,
    issuedDate: r.issuedDate,
    amount: r.amount,
    status: r.status,
    collectedAt: r.collectedAt,
  }));
}

function formatAmount(amount?: { value: number; currency: string }): string {
  return amount ? `${amount.value.toFixed(2)} ${amount.currency}` : '—';
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const REPORT_COLUMNS = ['Source', 'Destination', 'Invoice', 'Issued', 'Amount', 'Status', 'Collected'] as const;

function rowCells(row: ReportRow): string[] {
  return [row.sourceName, row.destinationName, row.invoiceId, row.issuedDate, formatAmount(row.amount), row.status, row.collectedAt];
}

/** A self-contained HTML document (inline `<style>`, no external assets) — meant to be handed
 * back as one file, not rendered inside the app itself. */
export function buildHtmlReport(rows: ReportRow[], period: CollectPeriod): string {
  const bodyRows = rows
    .map((row) => `<tr>${rowCells(row).map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
    .join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Invoice Collector report</title>
<style>
  body { font-family: -apple-system, Segoe UI, sans-serif; margin: 24px; color: #111; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 14px; }
  th { background: #f5f5f5; }
</style>
</head>
<body>
<h1>Invoice Collector report</h1>
<p>Period: ${escapeHtml(period.start)} to ${escapeHtml(period.end)} — ${rows.length} invoice${rows.length === 1 ? '' : 's'}</p>
<table>
<thead><tr>${REPORT_COLUMNS.map((col) => `<th>${col}</th>`).join('')}</tr></thead>
<tbody>
${bodyRows}
</tbody>
</table>
</body>
</html>
`;
}

/**
 * `write-excel-file` over `exceljs` — the latter's `unzipper` dependency (needed only for
 * *reading* an existing .xlsx, never used by this write-only path) pulls in a small tree of
 * long-abandoned, license-unverifiable micro-packages (`buffers`, `chainsaw`, `traverse` — one
 * with no license information at all, and a now-deleted upstream repo). `write-excel-file`'s own
 * dependency tree is just `fflate` (§9's own zip library, already vetted and in use here).
 */
export async function buildExcelReport(rows: ReportRow[], period: CollectPeriod): Promise<Uint8Array> {
  const sheetData = [
    [{ value: `Period: ${period.start} to ${period.end} — ${rows.length} invoice(s)` }],
    [{ value: '' }],
    REPORT_COLUMNS.map((col) => ({ value: col, fontWeight: 'bold' as const })),
    ...rows.map((row) => rowCells(row).map((cell) => ({ value: cell }))),
  ];

  const buffer = await writeXlsxFile(sheetData).toBuffer();
  return new Uint8Array(buffer);
}
