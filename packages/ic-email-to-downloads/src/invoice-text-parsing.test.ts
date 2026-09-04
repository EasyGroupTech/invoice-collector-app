import { describe, expect, it } from 'vitest';
import { htmlToText, parseInvoiceFields } from './invoice-text-parsing.js';

describe('parseInvoiceFields', () => {
  it('extracts invoice number, long-form date, and a labeled amount from a typical billing notification', () => {
    const text = `
      Thank you for your business.
      Invoice Number: INV-20260115-042
      Invoice Date: January 15, 2026
      Amount: $1,234.56 USD
      Please find your invoice attached.
    `;
    expect(parseInvoiceFields(text)).toEqual({
      invoiceNumber: 'INV-20260115-042',
      issuedDate: '2026-01-15',
      amount: { value: 1234.56, currency: 'USD' },
    });
  });

  it('extracts a numeric MM/DD/YYYY date and a "Total Amount CCY X.XX" style amount', () => {
    const text = `
      Invoice number: 998877
      Invoice Date In UTC: 02/03/2026
      Total Amount USD 89.00
    `;
    expect(parseInvoiceFields(text)).toEqual({
      invoiceNumber: '998877',
      issuedDate: '2026-02-03',
      amount: { value: 89, currency: 'USD' },
    });
  });

  it('falls back to a bare "CCY X.XX" amount with no label at all', () => {
    const text = 'Your subscription renewed. EUR 15.99 was charged to your card on file.';
    expect(parseInvoiceFields(text).amount).toEqual({ value: 15.99, currency: 'EUR' });
  });

  it('falls back to a bare "X.XX CCY" amount when currency trails the number', () => {
    const text = 'Order total: 42.50 GBP';
    expect(parseInvoiceFields(text).amount).toEqual({ value: 42.5, currency: 'GBP' });
  });

  it('does not mistake a random three-letter word after a number for a currency code', () => {
    // Regression guard for why the currency match is case-sensitive: with a case-insensitive
    // match, "42.50 due" would wrongly be read as amount 42.50 in currency "DUE".
    const text = 'Balance: 42.50 due by Friday.';
    expect(parseInvoiceFields(text).amount).toBeUndefined();
  });

  it('returns an entirely empty result for text with no recognizable fields at all', () => {
    expect(parseInvoiceFields('Hello, just checking in — no invoice content here.')).toEqual({
      invoiceNumber: undefined,
      issuedDate: undefined,
      amount: undefined,
    });
  });

  it('handles a comma thousands-separator in the amount', () => {
    const text = 'Amount: $12,345.67 USD';
    expect(parseInvoiceFields(text).amount).toEqual({ value: 12345.67, currency: 'USD' });
  });
});

describe('htmlToText', () => {
  it('strips tags and decodes common entities', () => {
    const html = '<html><body><p>Invoice &amp; Number: <b>INV-1</b></p><p>Amount: &quot;42.00&quot; USD</p></body></html>';
    expect(htmlToText(html)).toBe('Invoice & Number: INV-1 Amount: "42.00" USD');
  });

  it('drops the contents of script and style tags entirely, not just the tags', () => {
    const html = '<style>.x{color:red}</style><script>alert(1)</script><p>Amount: 5.00 USD</p>';
    expect(htmlToText(html)).toBe('Amount: 5.00 USD');
  });

  it('collapses runs of whitespace left behind by stripped tags', () => {
    const html = '<div>  <span>A</span>   <span>B</span>  </div>';
    expect(htmlToText(html)).toBe('A B');
  });
});
