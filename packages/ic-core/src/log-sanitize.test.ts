import { describe, expect, it } from 'vitest';
import {
  sanitizeBodyForLog,
  sanitizeHeadersForLog,
  sanitizeMessageForLog,
  sanitizeResponseBodyForLog,
  sanitizeUrlForAudit,
  sanitizeUrlForLog,
  sanitizeValueForLog,
} from './log-sanitize.js';

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

describe('sanitizeUrlForAudit (§7 audit log, phase 1.22 — less lossy than sanitizeUrlForLog)', () => {
  it('keeps the full path shape, unlike sanitizeUrlForLog collapsing everything but the last segment', () => {
    expect(sanitizeUrlForAudit('https://management.azure.com/providers/Microsoft.Billing/billingAccounts/acct-1/invoices')).toBe(
      'https://management.azure.com/providers/Microsoft.Billing/billingAccounts/acct-1/invoices',
    );
  });

  it('masks a GUID inside the path but keeps the surrounding resource-shape segments', () => {
    expect(sanitizeUrlForAudit('https://management.azure.com/subscriptions/11111111-2222-3333-4444-555555555555/invoices')).toBe(
      'https://management.azure.com/subscriptions/[id]/invoices',
    );
  });

  it('masks a long numeric id inside the path', () => {
    expect(sanitizeUrlForAudit('https://example.com/subscriptions/123456789012/invoices')).toBe('https://example.com/subscriptions/[id]/invoices');
  });

  it('keeps a genuinely useful, non-secret query param like api-version', () => {
    expect(sanitizeUrlForAudit('https://management.azure.com/invoices?api-version=2024-04-01')).toBe(
      'https://management.azure.com/invoices?api-version=2024-04-01',
    );
  });

  it('redacts a credential-shaped query param by name, keeping the param present but not its value', () => {
    expect(sanitizeUrlForAudit('https://example.com/file?sig=SECRET123&expires=123')).toBe('https://example.com/file?sig=%5BREDACTED%5D&expires=123');
  });

  it('redacts every credential-shaped query param name it knows about', () => {
    const url = sanitizeUrlForAudit('https://example.com/x?token=t1&apiKey=k1&sas=s1&password=p1&client_secret=c1');
    expect(url).not.toContain('t1');
    expect(url).not.toContain('k1');
    expect(url).not.toContain('s1');
    expect(url).not.toContain('p1');
    expect(url).not.toContain('c1');
  });

  it('still masks a *.sharepoint.com tenant-identifying hostname', () => {
    expect(sanitizeUrlForAudit('https://contoso.sharepoint.com/sites/Finance/doc.pdf')).toBe('https://[tenant].sharepoint.com/sites/Finance/doc.pdf');
  });

  it('drops the query string entirely when there is none', () => {
    expect(sanitizeUrlForAudit('https://example.com/health')).toBe('https://example.com/health');
  });

  it('leaves a non-URL string alone rather than throwing', () => {
    expect(sanitizeUrlForAudit('not a url at all')).toBe('not a url at all');
  });
});

describe('sanitizeHeadersForLog (§7 audit log, phase 1.22)', () => {
  it('redacts well-known credential-carrying header names that do not match the generic key pattern', () => {
    expect(
      sanitizeHeadersForLog({
        Authorization: 'Bearer abc123',
        Cookie: 'session=xyz',
        'Set-Cookie': 'session=xyz',
        'Proxy-Authorization': 'Basic abc',
        'X-Api-Key': 'k-123',
        'X-Auth-Token': 't-123',
        'X-Amz-Security-Token': 'sts-123',
      }),
    ).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'Set-Cookie': '[REDACTED]',
      'Proxy-Authorization': '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      'X-Auth-Token': '[REDACTED]',
      'X-Amz-Security-Token': '[REDACTED]',
    });
  });

  it('is case-insensitive on the header name', () => {
    expect(sanitizeHeadersForLog({ authorization: 'Bearer abc' })).toEqual({ authorization: '[REDACTED]' });
  });

  it('still catches a plugin-specific header via the generic sensitive-key pattern', () => {
    expect(sanitizeHeadersForLog({ 'X-Custom-Secret': 'shh' })).toEqual({ 'X-Custom-Secret': '[REDACTED]' });
  });

  it('leaves an ordinary header untouched', () => {
    expect(sanitizeHeadersForLog({ 'Content-Type': 'application/json', 'X-Request-Id': 'abc' })).toEqual({
      'Content-Type': 'application/json',
      'X-Request-Id': 'abc',
    });
  });
});

describe('sanitizeBodyForLog (request-body side, §7 audit log)', () => {
  it('reports empty for undefined/null/empty-string bodies', () => {
    expect(sanitizeBodyForLog(undefined, undefined)).toEqual({ kind: 'omitted', reason: 'empty' });
    expect(sanitizeBodyForLog('application/json', null)).toEqual({ kind: 'omitted', reason: 'empty' });
    expect(sanitizeBodyForLog('application/json', '')).toEqual({ kind: 'omitted', reason: 'empty' });
  });

  it('parses and redacts a JSON string body when the content-type says JSON', () => {
    expect(sanitizeBodyForLog('application/json', JSON.stringify({ clientSecret: 'shh', tenantId: 't1' }))).toEqual({
      kind: 'json',
      value: { clientSecret: '[REDACTED]', tenantId: 't1' },
    });
  });

  it('falls back to truncated text if the content-type says JSON but the string is not actually parseable', () => {
    expect(sanitizeBodyForLog('application/json', 'not json')).toEqual({ kind: 'text', value: 'not json' });
  });

  it('treats a non-JSON string body as plain text', () => {
    expect(sanitizeBodyForLog('application/x-www-form-urlencoded', 'grant_type=client_credentials')).toEqual({
      kind: 'text',
      value: 'grant_type=client_credentials',
    });
  });

  it('redacts a plain object body directly, without needing a content-type at all', () => {
    expect(sanitizeBodyForLog(undefined, { apiKey: 'shh', name: 'ok' })).toEqual({ kind: 'json', value: { apiKey: '[REDACTED]', name: 'ok' } });
  });

  it('never decodes a binary-shaped body (ArrayBuffer/Uint8Array)', () => {
    expect(sanitizeBodyForLog('application/octet-stream', new Uint8Array([1, 2, 3]))).toEqual({ kind: 'omitted', reason: 'binary' });
    expect(sanitizeBodyForLog(undefined, new ArrayBuffer(4))).toEqual({ kind: 'omitted', reason: 'binary' });
  });

  it('reports too-large for a string body over the size cap, without ever parsing it', () => {
    expect(sanitizeBodyForLog('application/json', 'x'.repeat(300_000))).toEqual({ kind: 'omitted', reason: 'too-large' });
  });
});

describe('sanitizeResponseBodyForLog (response-body side, §7 audit log)', () => {
  function bytesOf(text: string): ArrayBuffer {
    return new TextEncoder().encode(text).buffer;
  }

  it('reports empty for a zero-length response', () => {
    expect(sanitizeResponseBodyForLog('application/json', new ArrayBuffer(0))).toEqual({ kind: 'omitted', reason: 'empty' });
  });

  it('never even decodes bytes for a non-text content-type — the real "never log raw PDF bytes" guarantee', () => {
    expect(sanitizeResponseBodyForLog('application/pdf', bytesOf('%PDF-1.4 fake pdf bytes'))).toEqual({ kind: 'omitted', reason: 'binary' });
  });

  it('omits when there is no content-type at all, rather than guessing', () => {
    expect(sanitizeResponseBodyForLog(undefined, bytesOf('{}'))).toEqual({ kind: 'omitted', reason: 'binary' });
  });

  it('parses and redacts a JSON response body', () => {
    expect(sanitizeResponseBodyForLog('application/json; charset=utf-8', bytesOf(JSON.stringify({ access_token: 'shh', expires_in: 3600 })))).toEqual({
      kind: 'json',
      value: { access_token: '[REDACTED]', expires_in: 3600 },
    });
  });

  it('treats a text/* or XML content-type as plain text', () => {
    expect(sanitizeResponseBodyForLog('text/plain', bytesOf('hello'))).toEqual({ kind: 'text', value: 'hello' });
    expect(sanitizeResponseBodyForLog('application/xml', bytesOf('<a/>'))).toEqual({ kind: 'text', value: '<a/>' });
  });

  it('truncates a long text/JSON body rather than storing it in full', () => {
    const long = 'a'.repeat(5000);
    const result = sanitizeResponseBodyForLog('text/plain', bytesOf(long));
    expect(result).toEqual({ kind: 'text', value: `${'a'.repeat(4000)}…[truncated]` });
  });

  it('omits a response over the size cap without ever decoding it', () => {
    const huge = new ArrayBuffer(300_000);
    expect(sanitizeResponseBodyForLog('application/json', huge)).toEqual({ kind: 'omitted', reason: 'too-large' });
  });
});
