import type { HttpApi } from 'invoice-collector-plugin-sdk';

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export interface GraphMessageSummary {
  id: string;
  subject: string;
  from?: string;
  receivedDateTime: string;
  hasAttachments: boolean;
  bodyPreview: string;
}

export interface GraphMessageDetail {
  id: string;
  subject: string;
  from?: string;
  receivedDateTime: string;
  bodyContentType: 'text' | 'html';
  bodyContent: string;
}

export interface GraphAttachmentSummary {
  id: string;
  name: string;
  contentType: string;
}

export interface ListMessagesOptions {
  /** ISO date (YYYY-MM-DD), inclusive on both ends. */
  start: string;
  end: string;
  hasAttachmentsOnly?: boolean;
}

interface RawEmailAddress {
  emailAddress?: { address?: string; name?: string };
}

interface RawGraphMessage extends RawEmailAddress {
  id: string;
  subject?: string;
  from?: RawEmailAddress;
  receivedDateTime: string;
  hasAttachments?: boolean;
  bodyPreview?: string;
}

interface RawGraphMessageDetail {
  subject?: string;
  from?: RawEmailAddress;
  receivedDateTime: string;
  body?: { contentType?: string; content?: string };
}

interface RawGraphAttachment {
  '@odata.type'?: string;
  id: string;
  name: string;
  contentType?: string;
  isInline?: boolean;
}

interface GraphListResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
}

function assertOk(status: number, what: string): void {
  if (status !== 200) throw new Error(`Graph ${what} request failed: HTTP ${status}`);
}

function graphDateTimeBoundary(isoDate: string, endOfDay: boolean): string {
  return `${isoDate}T${endOfDay ? '23:59:59' : '00:00:00'}Z`;
}

function toMessageSummary(raw: RawGraphMessage): GraphMessageSummary {
  return {
    id: raw.id,
    subject: raw.subject ?? '',
    from: raw.from?.emailAddress?.address,
    receivedDateTime: raw.receivedDateTime,
    hasAttachments: raw.hasAttachments ?? false,
    bodyPreview: raw.bodyPreview ?? '',
  };
}

/**
 * `$filter`'s own `contains()` support for mail properties is unreliable, and `$search` applies
 * relevance ranking that isn't what a deterministic period-bounded scan wants — so this only ever
 * filters by `receivedDateTime` (and, when requested, `hasAttachments`) server-side; subject/sender
 * text filtering happens client-side, in the plugin's own orchestration, not here.
 */
export async function listMessages(http: HttpApi, sessionId: string, options: ListMessagesOptions, signal: AbortSignal): Promise<GraphMessageSummary[]> {
  const filterParts = [
    `receivedDateTime ge ${graphDateTimeBoundary(options.start, false)}`,
    `receivedDateTime le ${graphDateTimeBoundary(options.end, true)}`,
  ];
  if (options.hasAttachmentsOnly) filterParts.push('hasAttachments eq true');

  let url: string | undefined =
    `${GRAPH_BASE}/me/messages?$filter=${encodeURIComponent(filterParts.join(' and '))}` +
    `&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,hasAttachments,bodyPreview&$top=50`;

  const messages: GraphMessageSummary[] = [];
  while (url) {
    const response = await http.request({ url, sessionId }, signal);
    assertOk(response.status, 'messages list');
    const body = response.json() as GraphListResponse<RawGraphMessage>;
    messages.push(...body.value.map(toMessageSummary));
    url = body['@odata.nextLink'];
  }
  return messages;
}

export async function getMessageDetail(http: HttpApi, sessionId: string, messageId: string, signal: AbortSignal): Promise<GraphMessageDetail> {
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}?$select=subject,from,receivedDateTime,body`;
  const response = await http.request({ url, sessionId }, signal);
  assertOk(response.status, 'message detail');
  const raw = response.json() as RawGraphMessageDetail;
  return {
    id: messageId,
    subject: raw.subject ?? '',
    from: raw.from?.emailAddress?.address,
    receivedDateTime: raw.receivedDateTime,
    bodyContentType: raw.body?.contentType === 'text' ? 'text' : 'html',
    bodyContent: raw.body?.content ?? '',
  };
}

/** Excludes inline images referenced from the HTML body (`isInline: true`) and anything that
 * isn't a real file attachment (e.g. a forwarded-message item attachment) — only a genuine
 * attached file is a candidate invoice document. */
export async function listAttachments(http: HttpApi, sessionId: string, messageId: string, signal: AbortSignal): Promise<GraphAttachmentSummary[]> {
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,isInline`;
  const response = await http.request({ url, sessionId }, signal);
  assertOk(response.status, 'attachments list');
  const body = response.json() as GraphListResponse<RawGraphAttachment>;
  return body.value
    .filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment' && !a.isInline)
    .map((a) => ({ id: a.id, name: a.name, contentType: a.contentType ?? 'application/octet-stream' }));
}

/** Graph inlines a fileAttachment's bytes as base64 `contentBytes` for anything under its ~3MB
 * cutoff — every real invoice PDF this source will ever see fits comfortably under that. */
export async function getAttachmentBytes(http: HttpApi, sessionId: string, messageId: string, attachmentId: string, signal: AbortSignal): Promise<Uint8Array> {
  const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}?$select=contentBytes`;
  const response = await http.request({ url, sessionId }, signal);
  assertOk(response.status, 'attachment content');
  const body = response.json() as { contentBytes?: string };
  return new Uint8Array(Buffer.from(body.contentBytes ?? '', 'base64'));
}
