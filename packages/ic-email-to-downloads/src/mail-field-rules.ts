/**
 * §14.3's manual field-rule capture — the reference app's own "teach the app a template it can't
 * parse automatically" fallback, ported. A `MailFieldRule` is the raw text a user selected as the
 * anchor immediately preceding a field's value (captured via the wizard's `textSelect` step, see
 * `WizardSteps.tsx`'s own `computeLabel()`), stored per source (`MailSourceConfig.fieldRules`) —
 * never a regex the user writes by hand, just a literal boilerplate anchor these templated,
 * machine-generated emails already contain.
 */
import { MONTH_NAMES, parseInvoiceFields, type ParsedInvoiceFields } from './invoice-text-parsing.js';

export type MailFieldRuleField = 'invoiceNumber' | 'issuedDate' | 'amount';

/**
 * Deliberately shaped to match the SDK's own generic `CapturedTextSelection` exactly (`fieldName`,
 * not `field`) — the wizard's `textSelect` step hands back `CapturedTextSelection[]` with no
 * plugin-specific knowledge of what a `fieldName` means; narrowing that string to
 * `MailFieldRuleField` here is the only "conversion" actually needed, so a captured selection
 * lands directly in `MailSourceConfig.fieldRules` with no separate transform step.
 */
export interface MailFieldRule {
  fieldName: MailFieldRuleField;
  /** Which of the message's own body text or its PDF attachment's extracted text this rule's
   * label was captured from — applying it against the other one would never match. */
  source: 'body' | 'pdf';
  label: string;
}

const ALL_FIELDS: MailFieldRuleField[] = ['invoiceNumber', 'issuedDate', 'amount'];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function applyInvoiceNumberRule(text: string, label: string): string | undefined {
  const match = text.match(new RegExp(`${escapeRegExp(label)}\\s*([A-Za-z0-9-]+)`, 'i'));
  return match?.[1];
}

/** Same long-form-then-numeric fallback order as the generic extractor (invoice-text-parsing.ts's
 * own `tryIssuedDate`), just anchored on the captured label instead of a fixed English keyword. */
function applyIssuedDateRule(text: string, label: string): string | undefined {
  const escapedLabel = escapeRegExp(label);

  const longForm = text.match(new RegExp(`${escapedLabel}\\s*([A-Za-z]+)\\s+(\\d{1,2}),?\\s+(\\d{4})`, 'i'));
  if (longForm) {
    const monthIndex = MONTH_NAMES.indexOf(longForm[1].toLowerCase());
    if (monthIndex >= 0) {
      const month = String(monthIndex + 1).padStart(2, '0');
      const day = longForm[2].padStart(2, '0');
      return `${longForm[3]}-${month}-${day}`;
    }
  }

  const numeric = text.match(new RegExp(`${escapedLabel}\\s*(\\d{2})\\/(\\d{2})\\/(\\d{4})`, 'i'));
  if (numeric) {
    const [, month, day, year] = numeric;
    return `${year}-${month}-${day}`;
  }

  return undefined;
}

/** Case-insensitive here (unlike the generic extractor's deliberately case-sensitive currency
 * match) — the label itself already anchors specificity, so there's no bare-number false-positive
 * risk to guard against the way there is when scanning a whole message for any `[A-Z]{3}`. */
function applyAmountRule(text: string, label: string): { value: number; currency: string } | undefined {
  const escapedLabel = escapeRegExp(label);

  const valueFirst = text.match(new RegExp(`${escapedLabel}\\s*\\$?([\\d,]+\\.\\d{2})\\s*\\b([A-Za-z]{3})\\b`, 'i'));
  if (valueFirst) return { value: Number(valueFirst[1].replace(/,/g, '')), currency: valueFirst[2].toUpperCase() };

  const currencyFirst = text.match(new RegExp(`${escapedLabel}\\s*([A-Za-z]{3})\\s*([\\d,]+\\.\\d{2})`, 'i'));
  if (currencyFirst) return { value: Number(currencyFirst[2].replace(/,/g, '')), currency: currencyFirst[1].toUpperCase() };

  return undefined;
}

function applyFieldRule(text: string, field: MailFieldRuleField, label: string): Partial<ParsedInvoiceFields> | undefined {
  if (field === 'invoiceNumber') {
    const invoiceNumber = applyInvoiceNumberRule(text, label);
    return invoiceNumber ? { invoiceNumber } : undefined;
  }
  if (field === 'issuedDate') {
    const issuedDate = applyIssuedDateRule(text, label);
    return issuedDate ? { issuedDate } : undefined;
  }
  const amount = applyAmountRule(text, label);
  return amount ? { amount } : undefined;
}

export interface FieldsWithRulesResult {
  fields: ParsedInvoiceFields;
  missingFields: MailFieldRuleField[];
}

/**
 * Stage 3 of the extraction fallback — only ever reached once both all-or-nothing generic passes
 * (body-only, then PDF-only) have already failed to resolve every field. Unlike those two, this
 * resolves each field *independently*: a rule for one field never blocks the other two from
 * resolving via their own path (a rule match first, falling back to the same generic extractor —
 * body then PDF — if there's no rule for that field or it doesn't match this particular message).
 */
export function extractFieldsWithRules(bodyText: string, pdfText: string | undefined, rules: MailFieldRule[]): FieldsWithRulesResult {
  const fields: ParsedInvoiceFields = {};
  const missingFields: MailFieldRuleField[] = [];

  for (const field of ALL_FIELDS) {
    const rule = rules.find((r) => r.fieldName === field);
    let resolved: Partial<ParsedInvoiceFields> | undefined;

    if (rule) {
      const ruleText = rule.source === 'pdf' ? pdfText : bodyText;
      if (ruleText) resolved = applyFieldRule(ruleText, field, rule.label);
    }

    if (!resolved) {
      const bodyValue = parseInvoiceFields(bodyText)[field];
      if (bodyValue !== undefined) {
        resolved = { [field]: bodyValue } as Partial<ParsedInvoiceFields>;
      } else if (pdfText) {
        const pdfValue = parseInvoiceFields(pdfText)[field];
        if (pdfValue !== undefined) resolved = { [field]: pdfValue } as Partial<ParsedInvoiceFields>;
      }
    }

    if (resolved) Object.assign(fields, resolved);
    else missingFields.push(field);
  }

  return { fields, missingFields };
}
