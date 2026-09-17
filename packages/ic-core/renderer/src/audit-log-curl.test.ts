import { describe, expect, it } from 'vitest';
import type { AuditLogEntry } from '../../electron/shared/ipcContracts';
import { buildCurlCommand } from './audit-log-curl.js';

function sampleEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
  return {
    id: 'e1',
    timestamp: '2026-01-01T00:00:00.000Z',
    pluginId: 'tech.easygroup.source.azure-billing',
    method: 'GET',
    url: 'https://management.azure.com/…/invoices',
    status: 200,
    durationMs: 120,
    requestHeaders: { 'Content-Type': 'application/json' },
    responseHeaders: { 'Content-Type': 'application/json' },
    requestBody: { kind: 'omitted', reason: 'empty' },
    responseBody: { kind: 'json', value: { value: [] } },
    ...overrides,
  };
}

describe('buildCurlCommand', () => {
  it('builds a GET request with headers and no body', () => {
    const command = buildCurlCommand(sampleEntry());
    expect(command).toBe(
      ["curl -X GET \\", "  -H 'Content-Type: application/json' \\", "  'https://management.azure.com/…/invoices'"].join('\n'),
    );
  });

  it('includes a redacted header verbatim — the literal [REDACTED] placeholder, never a real secret', () => {
    const command = buildCurlCommand(sampleEntry({ requestHeaders: { Authorization: '[REDACTED]' } }));
    expect(command).toContain("-H 'Authorization: [REDACTED]'");
  });

  it('includes a JSON request body as -d', () => {
    const command = buildCurlCommand(
      sampleEntry({ method: 'POST', requestBody: { kind: 'json', value: { clientSecret: '[REDACTED]', tenantId: 't1' } } }),
    );
    expect(command).toContain(`-d '${JSON.stringify({ clientSecret: '[REDACTED]', tenantId: 't1' })}'`);
  });

  it('includes a plain-text request body as -d', () => {
    const command = buildCurlCommand(sampleEntry({ method: 'POST', requestBody: { kind: 'text', value: 'grant_type=client_credentials' } }));
    expect(command).toContain("-d 'grant_type=client_credentials'");
  });

  it('notes an omitted (non-empty-reason) body as a comment rather than silently dropping it', () => {
    const command = buildCurlCommand(sampleEntry({ requestBody: { kind: 'omitted', reason: 'binary' } }));
    expect(command).toContain('# request body omitted (binary)');
  });

  it('says nothing at all about an empty body', () => {
    const command = buildCurlCommand(sampleEntry({ requestBody: { kind: 'omitted', reason: 'empty' } }));
    expect(command).not.toContain('omitted');
  });

  it('escapes a single quote embedded in a header value', () => {
    const command = buildCurlCommand(sampleEntry({ requestHeaders: { 'X-Note': `it's here` } }));
    expect(command).toContain(`-H 'X-Note: it'\\''s here'`);
  });

  it('ends with the request URL as the final line', () => {
    const command = buildCurlCommand(sampleEntry());
    expect(command.split('\n').at(-1)).toBe("  'https://management.azure.com/…/invoices'");
  });
});
