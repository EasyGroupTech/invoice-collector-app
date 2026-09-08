import { describe, expect, it } from 'vitest';
import { extractFieldsWithRules, type MailFieldRule } from './mail-field-rules.js';

describe('extractFieldsWithRules', () => {
  it('resolves a field via its own rule when the generic extractor cannot find it', () => {
    const bodyText = 'Ref# ZX-9981 for your recent purchase, thanks for shopping with us.';
    const rules: MailFieldRule[] = [{ fieldName: 'invoiceNumber', source: 'body', label: 'Ref#' }];

    const result = extractFieldsWithRules(bodyText, undefined, rules);

    expect(result.fields.invoiceNumber).toBe('ZX-9981');
  });

  it('resolves the long-form date shape through a rule', () => {
    const bodyText = 'Charged on March 3, 2026 for services rendered.';
    const rules: MailFieldRule[] = [{ fieldName: 'issuedDate', source: 'body', label: 'Charged on' }];

    const result = extractFieldsWithRules(bodyText, undefined, rules);

    expect(result.fields.issuedDate).toBe('2026-03-03');
  });

  it('resolves the numeric mm/dd/yyyy date shape through a rule', () => {
    const bodyText = 'Billed 04/07/2026 to your account.';
    const rules: MailFieldRule[] = [{ fieldName: 'issuedDate', source: 'body', label: 'Billed' }];

    const result = extractFieldsWithRules(bodyText, undefined, rules);

    expect(result.fields.issuedDate).toBe('2026-04-07');
  });

  it('resolves an amount through a rule, value-first', () => {
    const bodyText = 'You owe: 250.00 USD by the due date.';
    const rules: MailFieldRule[] = [{ fieldName: 'amount', source: 'body', label: 'You owe:' }];

    const result = extractFieldsWithRules(bodyText, undefined, rules);

    expect(result.fields.amount).toEqual({ value: 250, currency: 'USD' });
  });

  it('resolves an amount through a rule, currency-first', () => {
    const bodyText = 'Balance due USD 75.50 as of today.';
    const rules: MailFieldRule[] = [{ fieldName: 'amount', source: 'body', label: 'Balance due' }];

    const result = extractFieldsWithRules(bodyText, undefined, rules);

    expect(result.fields.amount).toEqual({ value: 75.5, currency: 'USD' });
  });

  it("applies a rule against the PDF text, not the body, when the rule's own source is pdf", () => {
    const bodyText = 'Please see the attached PDF for your invoice.';
    const pdfText = 'Invoice Ref XJ-4471 issued this month.';
    const rules: MailFieldRule[] = [{ fieldName: 'invoiceNumber', source: 'pdf', label: 'Invoice Ref' }];

    const result = extractFieldsWithRules(bodyText, pdfText, rules);

    expect(result.fields.invoiceNumber).toBe('XJ-4471');
  });

  it('falls back to the generic extractor for a field with no rule at all', () => {
    const bodyText = 'Invoice number: GEN-1 Invoice Date: January 1, 2026 Amount: $10.00 USD';

    const result = extractFieldsWithRules(bodyText, undefined, []);

    expect(result.fields).toEqual({ invoiceNumber: 'GEN-1', issuedDate: '2026-01-01', amount: { value: 10, currency: 'USD' } });
  });

  it("falls back to the generic extractor when a rule's own label does not match this message", () => {
    const bodyText = 'Invoice number: GEN-2';
    const rules: MailFieldRule[] = [{ fieldName: 'invoiceNumber', source: 'body', label: 'Ref#' }];

    const result = extractFieldsWithRules(bodyText, undefined, rules);

    expect(result.fields.invoiceNumber).toBe('GEN-2');
  });

  it('lists every field that resolved neither via a rule nor generically as missing', () => {
    const result = extractFieldsWithRules('Nothing recognizable here at all.', undefined, []);

    expect(result.missingFields).toEqual(['invoiceNumber', 'issuedDate', 'amount']);
    expect(result.fields).toEqual({});
  });

  it('resolves each field independently — one rule does not block the other two', () => {
    const bodyText = 'Ref# QQ-1 Invoice Date: February 2, 2026 Amount: $5.00 USD';
    const rules: MailFieldRule[] = [{ fieldName: 'invoiceNumber', source: 'body', label: 'Ref#' }];

    const result = extractFieldsWithRules(bodyText, undefined, rules);

    expect(result.fields).toEqual({ invoiceNumber: 'QQ-1', issuedDate: '2026-02-02', amount: { value: 5, currency: 'USD' } });
  });
});
