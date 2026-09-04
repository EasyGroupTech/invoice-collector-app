/**
 * Phase 1.14's "built-in field-extraction rules" (§14.1 US4) — a fixed set of regex-based
 * extractors run against plain text (an email body, or a PDF attachment's extracted text), never
 * user-editable. Manual field-rule capture (teaching the app a new template by hand) is
 * deliberately out of scope here — see docs/architecture-design.md §14.3.
 */
export interface ParsedInvoiceFields {
  invoiceNumber?: string;
  /** ISO date (YYYY-MM-DD), never a Date — avoids any local-timezone round-trip shifting the
   * day, which a naive `new Date(...)` parse of an ambiguous format is genuinely prone to. */
  issuedDate?: string;
  amount?: { value: number; currency: string };
}

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

function tryInvoiceNumber(text: string): string | undefined {
  const match = text.match(/Invoice\s*(?:number|#|no\.?)\s*:?\s*([A-Za-z0-9-]+)/i);
  return match?.[1];
}

/** Long form ("Invoice Date: January 5, 2026") first, since it's unambiguous; numeric MM/DD/YYYY
 * second (the shape Microsoft's own billing emails use) — hand-parsed field by field rather than
 * `new Date(...)`, which applies the *local* timezone to an otherwise plain calendar date and can
 * genuinely shift the day near a UTC offset boundary. */
function tryIssuedDate(text: string): string | undefined {
  const longForm = text.match(/(?:Billing|Invoice)\s*Date\s*:?\s*([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (longForm) {
    const monthIndex = MONTH_NAMES.indexOf(longForm[1].toLowerCase());
    if (monthIndex >= 0) {
      const month = String(monthIndex + 1).padStart(2, '0');
      const day = longForm[2].padStart(2, '0');
      return `${longForm[3]}-${month}-${day}`;
    }
  }

  const numeric = text.match(/Invoice Date(?:\s*In UTC)?:?\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  if (numeric) {
    const [, month, day, year] = numeric;
    return `${year}-${month}-${day}`;
  }

  return undefined;
}

/**
 * Currency codes are matched case-sensitively (`[A-Z]{3}`, no `/i`) deliberately — with `/i` this
 * would happily match any three letters right after a number ("Due Feb" etc.), not just a real
 * ISO 4217 code.
 */
function tryAmount(text: string): { value: number; currency: string } | undefined {
  const labeled = text.match(/Amount:\s*\$?([\d,]+\.\d{2})\s*([A-Z]{3})/);
  if (labeled) return { value: Number(labeled[1].replace(/,/g, '')), currency: labeled[2] };

  const totalAmount = text.match(/Total Amount\s+([A-Z]{3})\s+([\d,]+\.\d{2})/);
  if (totalAmount) return { value: Number(totalAmount[2].replace(/,/g, '')), currency: totalAmount[1] };

  const bareBefore = text.match(/([A-Z]{3})\s+([\d,]+\.\d{2})\b/);
  if (bareBefore) return { value: Number(bareBefore[2].replace(/,/g, '')), currency: bareBefore[1] };

  const bareAfter = text.match(/([\d,]+\.\d{2})\s+([A-Z]{3})\b/);
  if (bareAfter) return { value: Number(bareAfter[1].replace(/,/g, '')), currency: bareAfter[2] };

  return undefined;
}

export function parseInvoiceFields(text: string): ParsedInvoiceFields {
  return {
    invoiceNumber: tryInvoiceNumber(text),
    issuedDate: tryIssuedDate(text),
    amount: tryAmount(text),
  };
}

/**
 * A minimal HTML-to-plain-text pass — strip tags, decode the handful of entities that actually
 * show up in real billing-email HTML, collapse whitespace. Not a real HTML parser (no DOM, no
 * script/style awareness beyond the tags themselves) — the regexes above only need the visible
 * text, not a faithful rendering.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
