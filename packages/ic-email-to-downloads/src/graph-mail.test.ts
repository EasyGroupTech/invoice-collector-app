import type { HttpApi, HttpResponse } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { getAttachmentBytes, getMessageDetail, listAttachments, listMessages } from './graph-mail.js';

function fakeResponse(status: number, body: unknown): HttpResponse {
  return {
    status,
    headers: {},
    json: () => body,
    text: () => JSON.stringify(body),
    arrayBuffer: () => new ArrayBuffer(0),
  };
}

function fakeHttp(responses: HttpResponse[]): HttpApi {
  let call = 0;
  return { request: vi.fn(async () => responses[call++] ?? responses[responses.length - 1]) };
}

describe('listMessages', () => {
  it('maps raw Graph messages, filling in a bare from/subject/bodyPreview when absent', async () => {
    const http = fakeHttp([
      fakeResponse(200, {
        value: [
          { id: 'm1', subject: 'Invoice attached', from: { emailAddress: { address: 'billing@vendor.com' } }, receivedDateTime: '2026-01-10T00:00:00Z', hasAttachments: true, bodyPreview: 'See attached' },
          { id: 'm2', receivedDateTime: '2026-01-11T00:00:00Z' },
        ],
      }),
    ]);

    const messages = await listMessages(http, 'session-1', { start: '2026-01-01', end: '2026-01-31' }, new AbortController().signal);

    expect(messages).toEqual([
      { id: 'm1', subject: 'Invoice attached', from: 'billing@vendor.com', receivedDateTime: '2026-01-10T00:00:00Z', hasAttachments: true, bodyPreview: 'See attached' },
      { id: 'm2', subject: '', from: undefined, receivedDateTime: '2026-01-11T00:00:00Z', hasAttachments: false, bodyPreview: '' },
    ]);
  });

  it('follows @odata.nextLink pagination until it stops appearing', async () => {
    const http = fakeHttp([
      fakeResponse(200, { value: [{ id: 'm1', receivedDateTime: '2026-01-01T00:00:00Z' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/messages?$skip=50' }),
      fakeResponse(200, { value: [{ id: 'm2', receivedDateTime: '2026-01-02T00:00:00Z' }] }),
    ]);

    const messages = await listMessages(http, 'session-1', { start: '2026-01-01', end: '2026-01-31' }, new AbortController().signal);

    expect(messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it('includes hasAttachments eq true in the filter only when requested', async () => {
    const http = fakeHttp([fakeResponse(200, { value: [] })]);
    await listMessages(http, 'session-1', { start: '2026-01-01', end: '2026-01-31', hasAttachmentsOnly: true }, new AbortController().signal);

    const callArgs = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(decodeURIComponent(callArgs.url)).toContain('hasAttachments eq true');
  });

  it('always scopes sessionId on the request, for core to attach real auth', async () => {
    const http = fakeHttp([fakeResponse(200, { value: [] })]);
    await listMessages(http, 'session-42', { start: '2026-01-01', end: '2026-01-31' }, new AbortController().signal);
    expect(http.request).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-42' }), expect.anything());
  });

  it('throws a clear error on a non-200 response', async () => {
    const http = fakeHttp([fakeResponse(403, { error: 'Forbidden' })]);
    await expect(listMessages(http, 'session-1', { start: '2026-01-01', end: '2026-01-31' }, new AbortController().signal)).rejects.toThrow(/HTTP 403/);
  });
});

describe('getMessageDetail', () => {
  it('maps the raw response, defaulting to html body content type', async () => {
    const http = fakeHttp([fakeResponse(200, { subject: 'Invoice', from: { emailAddress: { address: 'billing@vendor.com' } }, receivedDateTime: '2026-01-10T00:00:00Z', body: { contentType: 'html', content: '<p>Amount: 5.00 USD</p>' } })]);

    const detail = await getMessageDetail(http, 'session-1', 'm1', new AbortController().signal);

    expect(detail).toEqual({
      id: 'm1',
      subject: 'Invoice',
      from: 'billing@vendor.com',
      receivedDateTime: '2026-01-10T00:00:00Z',
      bodyContentType: 'html',
      bodyContent: '<p>Amount: 5.00 USD</p>',
    });
  });
});

describe('listAttachments', () => {
  it('keeps only real fileAttachments, excluding inline images and non-file attachments', async () => {
    const http = fakeHttp([
      fakeResponse(200, {
        value: [
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a1', name: 'invoice.pdf', contentType: 'application/pdf', isInline: false },
          { '@odata.type': '#microsoft.graph.fileAttachment', id: 'a2', name: 'logo.png', contentType: 'image/png', isInline: true },
          { '@odata.type': '#microsoft.graph.itemAttachment', id: 'a3', name: 'Forwarded message' },
        ],
      }),
    ]);

    const attachments = await listAttachments(http, 'session-1', 'm1', new AbortController().signal);

    expect(attachments).toEqual([{ id: 'a1', name: 'invoice.pdf', contentType: 'application/pdf' }]);
  });
});

describe('getAttachmentBytes', () => {
  it('decodes the base64 contentBytes into real bytes', async () => {
    const original = new TextEncoder().encode('hello pdf');
    const base64 = Buffer.from(original).toString('base64');
    const http = fakeHttp([fakeResponse(200, { contentBytes: base64 })]);

    const bytes = await getAttachmentBytes(http, 'session-1', 'm1', 'a1', new AbortController().signal);

    expect(new TextDecoder().decode(bytes)).toBe('hello pdf');
  });
});
