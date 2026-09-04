import type { HttpApi, HttpRequestInput, HttpResponse, PluginContext } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import plugin from './plugin.js';

function fakeResponse(status: number, body: unknown): HttpResponse {
  return { status, headers: {}, json: () => body, text: () => JSON.stringify(body), arrayBuffer: () => new ArrayBuffer(0) };
}

/** Dispatches by matching a substring against the request URL, rather than call order —
 * discover() fires some requests concurrently (Promise.all), so order isn't guaranteed. */
function dispatchingHttp(routes: Array<{ match: string; response: HttpResponse }>): HttpApi {
  const request = vi.fn(async (input: HttpRequestInput) => {
    const route = routes.find((r) => input.url.includes(r.match));
    if (!route) throw new Error(`No fake route matched: ${input.url}`);
    return route.response;
  });
  return { request };
}

function fakeContext(http: HttpApi): PluginContext {
  return {
    sessions: { list: vi.fn(), get: vi.fn(), create: vi.fn(), reconnect: vi.fn() } as never,
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    http,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progress: { report: vi.fn() },
  };
}

function record(overrides: Partial<{ sessionId: string; config: unknown }> = {}) {
  return {
    id: 'source-1',
    name: 'Mailbox',
    pluginId: 'app.easygroup.source.email-mail',
    pluginVersion: '0.0.0',
    sessionId: 'session-1',
    config: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function attachmentContentBytes(text: string): { contentBytes: string } {
  return { contentBytes: Buffer.from(text).toString('base64') };
}

describe('builtInSessionCreateInput', () => {
  it('builds the device-code input from the requirement\'s own declared scopes', () => {
    const input = plugin.builtInSessionCreateInput!({
      sessionTypeId: 'microsoft-entra-delegated-device-code',
      confirmsBuiltIn: true,
      requiredScopesOrRoles: ['Mail.Read'],
    }) as Record<string, unknown>;

    expect(input).toEqual({
      deviceAuthorizationEndpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode',
      tokenEndpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
      clientId: '14d82eec-204b-4c2f-b7e8-296a70dab67e',
      scope: 'Mail.Read offline_access',
      label: 'Microsoft 365 sign-in',
    });
  });
});

describe('resolveListData', () => {
  it('returns an empty list, without calling Graph at all, when no session is selected yet', async () => {
    const http = dispatchingHttp([]);
    const result = await plugin.resolveListData!(fakeContext(http), { dataSource: 'messagePreview', fieldValues: {} }, new AbortController().signal);
    expect(result).toEqual({ rows: [] });
    expect(http.request).not.toHaveBeenCalled();
  });

  it('lists recent messages and applies the client-side filter from the current field values', async () => {
    const http = dispatchingHttp([
      {
        match: '/me/messages',
        response: fakeResponse(200, {
          value: [
            { id: 'm1', subject: 'Your Invoice', from: { emailAddress: { address: 'billing@vendor.com' } }, receivedDateTime: '2026-01-10T00:00:00Z', hasAttachments: true },
            { id: 'm2', subject: 'Newsletter', from: { emailAddress: { address: 'news@other.com' } }, receivedDateTime: '2026-01-11T00:00:00Z', hasAttachments: false },
          ],
        }),
      },
    ]);

    const result = await plugin.resolveListData!(
      fakeContext(http),
      { dataSource: 'messagePreview', fieldValues: { subjectContains: 'invoice' }, sessionId: 'session-1' },
      new AbortController().signal,
    );

    expect(result.rows).toEqual([{ subject: 'Your Invoice', from: 'billing@vendor.com', received: '2026-01-10' }]);
  });

  it('rejects an unknown dataSource', async () => {
    await expect(
      plugin.resolveListData!(fakeContext(dispatchingHttp([])), { dataSource: 'nope', fieldValues: {}, sessionId: 's' }, new AbortController().signal),
    ).rejects.toThrow(/Unknown dataSource/);
  });
});

describe('discover', () => {
  it('yields an invoice whose fields the body text alone was enough to extract', async () => {
    const http = dispatchingHttp([
      { match: '/me/messages?', response: fakeResponse(200, { value: [{ id: 'm1', subject: 'Invoice', receivedDateTime: '2026-01-10T00:00:00Z', hasAttachments: true }] }) },
      { match: '/me/messages/m1?', response: fakeResponse(200, { subject: 'Invoice', receivedDateTime: '2026-01-10T00:00:00Z', body: { contentType: 'text', content: 'Invoice Number: INV-1\nInvoice Date: January 10, 2026\nAmount: $50.00 USD' } }) },
      { match: '/attachments?', response: fakeResponse(200, { value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'invoice.pdf', contentType: 'application/pdf', isInline: false }] }) },
    ]);

    const outcomes = [];
    for await (const invoice of plugin.discover(fakeContext(http), record(), { start: '2026-01-01', end: '2026-01-31' }, new AbortController().signal)) {
      outcomes.push(invoice);
    }

    expect(outcomes).toEqual([
      {
        id: 'm1:a1',
        issuedDate: '2026-01-10',
        amount: { value: 50, currency: 'USD' },
        pluginRef: { messageId: 'm1', attachmentId: 'a1', attachmentName: 'invoice.pdf', attachmentContentType: 'application/pdf', invoiceNumber: 'INV-1' },
      },
    ]);
  });

  it('falls back to the PDF attachment when the body has no extractable fields at all', async () => {
    const pdfContent = 'BT /F1 12 Tf 10 100 Td (Invoice Number: INV-2) Tj ET\nBT /F1 12 Tf 10 80 Td (Amount: $75.00 EUR) Tj ET';
    const pdf = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 300 200]/Contents 5 0 R>>endobj\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\n5 0 obj<</Length ${pdfContent.length}>>\nstream\n${pdfContent}\nendstream\nendobj\ntrailer<</Size 6/Root 1 0 R>>\n%%EOF`;

    const http = dispatchingHttp([
      { match: '/me/messages?', response: fakeResponse(200, { value: [{ id: 'm1', subject: 'Your bill is ready', receivedDateTime: '2026-02-05T00:00:00Z', hasAttachments: true }] }) },
      { match: '/me/messages/m1?', response: fakeResponse(200, { subject: 'Your bill is ready', receivedDateTime: '2026-02-05T00:00:00Z', body: { contentType: 'html', content: '<p>Sign in to view your invoice.</p>' } }) },
      { match: '/attachments?', response: fakeResponse(200, { value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'bill.pdf', contentType: 'application/pdf', isInline: false }] }) },
      { match: '/attachments/a1', response: fakeResponse(200, attachmentContentBytes(pdf)) },
    ]);

    const outcomes = [];
    for await (const invoice of plugin.discover(fakeContext(http), record(), { start: '2026-02-01', end: '2026-02-28' }, new AbortController().signal)) {
      outcomes.push(invoice);
    }

    expect(outcomes).toEqual([
      {
        id: 'm1:a1',
        issuedDate: '2026-02-05', // no date found anywhere — falls back to the message's own received date
        amount: { value: 75, currency: 'EUR' },
        pluginRef: { messageId: 'm1', attachmentId: 'a1', attachmentName: 'bill.pdf', attachmentContentType: 'application/pdf', invoiceNumber: 'INV-2' },
      },
    ]);
  });

  it('skips a matching message that has no real file attachment at all', async () => {
    const http = dispatchingHttp([
      { match: '/me/messages?', response: fakeResponse(200, { value: [{ id: 'm1', subject: 'Invoice', receivedDateTime: '2026-01-10T00:00:00Z', hasAttachments: true }] }) },
      { match: '/me/messages/m1?', response: fakeResponse(200, { subject: 'Invoice', receivedDateTime: '2026-01-10T00:00:00Z', body: { contentType: 'text', content: 'Invoice Number: INV-1' } }) },
      { match: '/attachments?', response: fakeResponse(200, { value: [] }) },
    ]);

    const outcomes = [];
    for await (const invoice of plugin.discover(fakeContext(http), record(), { start: '2026-01-01', end: '2026-01-31' }, new AbortController().signal)) {
      outcomes.push(invoice);
    }
    expect(outcomes).toEqual([]);
  });

  it('skips a message where the built-in rules found nothing at all, neither in the body nor the PDF', async () => {
    const http = dispatchingHttp([
      { match: '/me/messages?', response: fakeResponse(200, { value: [{ id: 'm1', subject: 'Invoice', receivedDateTime: '2026-01-10T00:00:00Z', hasAttachments: true }] }) },
      { match: '/me/messages/m1?', response: fakeResponse(200, { subject: 'Invoice', receivedDateTime: '2026-01-10T00:00:00Z', body: { contentType: 'text', content: 'Nothing recognizable here.' } }) },
      { match: '/attachments?', response: fakeResponse(200, { value: [{ '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'invoice.pdf', contentType: 'application/pdf', isInline: false }] }) },
      { match: '/attachments/a1', response: fakeResponse(200, attachmentContentBytes('%PDF-1.4\ncorrupt with no recognizable fields\n%%EOF')) },
    ]);

    const outcomes = [];
    for await (const invoice of plugin.discover(fakeContext(http), record(), { start: '2026-01-01', end: '2026-01-31' }, new AbortController().signal)) {
      outcomes.push(invoice);
    }
    expect(outcomes).toEqual([]);
  });

  it('applies the config\'s own subject/sender filter client-side before fetching detail for anything', async () => {
    const http = dispatchingHttp([
      {
        match: '/me/messages?',
        response: fakeResponse(200, {
          value: [
            { id: 'm1', subject: 'Newsletter', from: { emailAddress: { address: 'news@other.com' } }, receivedDateTime: '2026-01-10T00:00:00Z', hasAttachments: true },
          ],
        }),
      },
    ]);

    const outcomes = [];
    for await (const invoice of plugin.discover(
      fakeContext(http),
      record({ config: { subjectContains: 'invoice' } }),
      { start: '2026-01-01', end: '2026-01-31' },
      new AbortController().signal,
    )) {
      outcomes.push(invoice);
    }
    expect(outcomes).toEqual([]);
    // Only the list call happened — no per-message detail/attachments fetch for a filtered-out message.
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it('logs a warning and yields nothing when the source has no session assigned', async () => {
    const http = dispatchingHttp([]);
    const ctx = fakeContext(http);
    const outcomes = [];
    for await (const invoice of plugin.discover(ctx, record({ sessionId: undefined }), { start: '2026-01-01', end: '2026-01-31' }, new AbortController().signal)) {
      outcomes.push(invoice);
    }
    expect(outcomes).toEqual([]);
    expect(ctx.log.warn).toHaveBeenCalled();
    expect(http.request).not.toHaveBeenCalled();
  });
});

describe('fetchContent', () => {
  it('downloads the attachment and names the file from the invoice number discover() found', async () => {
    const http = dispatchingHttp([{ match: '/attachments/a1', response: fakeResponse(200, attachmentContentBytes('pdf bytes here')) }]);

    const content = await plugin.fetchContent(
      fakeContext(http),
      record(),
      {
        id: 'm1:a1',
        issuedDate: '2026-01-10',
        pluginRef: { messageId: 'm1', attachmentId: 'a1', attachmentName: 'invoice.pdf', attachmentContentType: 'application/pdf', invoiceNumber: 'INV-1' },
      },
      new AbortController().signal,
    );

    expect(content.fileName).toBe('INV-1_invoice.pdf');
    expect(content.mimeType).toBe('application/pdf');
    expect(new TextDecoder().decode(content.bytes)).toBe('pdf bytes here');
  });

  it('throws clearly when the record has no session assigned', async () => {
    await expect(
      plugin.fetchContent(
        fakeContext(dispatchingHttp([])),
        record({ sessionId: undefined }),
        { id: 'm1:a1', issuedDate: '2026-01-10', pluginRef: { messageId: 'm1', attachmentId: 'a1', attachmentName: 'invoice.pdf', attachmentContentType: 'application/pdf' } },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/No session assigned/);
  });
});
