import { describe, expect, it } from 'vitest';
import { sanitizeMessageForLog, sanitizeUrlForLog, sanitizeValueForLog } from './log-sanitize.js';

describe('sanitizeUrlForLog', () => {
  it('keeps only the origin and final path segment, dropping the rest of the path', () => {
    expect(sanitizeUrlForLog('https://graph.microsoft.com/v1.0/me/messages/abc123')).toBe(
      'https://graph.microsoft.com/…/abc123',
    );
  });

  it('keeps a single-segment path as-is', () => {
    expect(sanitizeUrlForLog('https://example.com/health')).toBe('https://example.com/health');
  });

  it('keeps the bare origin when the path is empty', () => {
    expect(sanitizeUrlForLog('https://example.com')).toBe('https://example.com/');
  });

  it('drops query strings and hashes entirely — SAS tokens/signatures live there', () => {
    expect(sanitizeUrlForLog('https://example.com/file?sig=SECRET&expires=123')).toBe(
      'https://example.com/file',
    );
  });

  it('replaces a *.sharepoint.com hostname — the subdomain itself is tenant-identifying', () => {
    expect(sanitizeUrlForLog('https://contoso.sharepoint.com/sites/Finance/doc.pdf')).toBe(
      'https://[tenant].sharepoint.com/…/doc.pdf',
    );
  });

  it('leaves a non-URL string alone rather than throwing', () => {
    expect(sanitizeUrlForLog('not a url at all')).toBe('not a url at all');
  });
});

describe('sanitizeMessageForLog', () => {
  it('sanitizes any embedded URL, leaving surrounding prose intact', () => {
    expect(sanitizeMessageForLog('uploaded to https://contoso.sharepoint.com/sites/Finance/inv.pdf ok')).toBe(
      'uploaded to https://[tenant].sharepoint.com/…/inv.pdf ok',
    );
  });

  it('redacts a bare GUID even outside of any URL', () => {
    expect(
      sanitizeMessageForLog('billingAccounts/11111111-2222-3333-4444-555555555555/invoices failed'),
    ).toBe('billingAccounts/[id]/invoices failed');
  });

  it('redacts a long numeric id even outside of any URL', () => {
    expect(sanitizeMessageForLog('subscription 123456789012 not found')).toBe('subscription [id] not found');
  });
});

describe('sanitizeValueForLog', () => {
  it('redacts a key that looks like a secret, case-insensitively, at any nesting depth', () => {
    expect(sanitizeValueForLog({ clientSecret: 'shh', nested: { refreshToken: 'shh2' } })).toEqual({
      clientSecret: '[REDACTED]',
      nested: { refreshToken: '[REDACTED]' },
    });
  });

  it('leaves non-sensitive keys untouched', () => {
    expect(sanitizeValueForLog({ sourceId: 'abc', name: 'Mailbox' })).toEqual({
      sourceId: 'abc',
      name: 'Mailbox',
    });
  });

  it('recurses into arrays', () => {
    expect(sanitizeValueForLog([{ apiKey: 'shh' }, { name: 'ok' }])).toEqual([
      { apiKey: '[REDACTED]' },
      { name: 'ok' },
    ]);
  });

  it('handles a circular reference without infinite recursion', () => {
    const obj: Record<string, unknown> = { name: 'a' };
    obj.self = obj;
    expect(sanitizeValueForLog(obj)).toEqual({ name: 'a', self: '[circular]' });
  });
});
