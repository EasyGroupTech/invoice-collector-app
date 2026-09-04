import type {
  DiscoveredInvoice,
  InvoiceContent,
  PluginContext,
  PluginSourceRecord,
  SessionRequirement,
  SourcePlugin,
  WizardListDataRequest,
  WizardListDataResult,
} from 'invoice-collector-plugin-sdk';
import { buildInvoiceFileName } from './file-naming.js';
import { getAttachmentBytes, getMessageDetail, listAttachments, listMessages } from './graph-mail.js';
import { htmlToText, parseInvoiceFields } from './invoice-text-parsing.js';
import { matchesMailFilter, type MailSourceConfig } from './mail-filter.js';
import { extractPdfText } from './pdf-text.js';

const SESSION_TYPE_ID = 'microsoft-entra-delegated-device-code';
const REQUIRED_SCOPES = ['Mail.Read'];

/**
 * `14d82eec-204b-4c2f-b7e8-296a70dab67e` — Microsoft's own well-known multi-tenant public client
 * (the "Microsoft Graph PowerShell" app registration). Already trusted for broad delegated Graph
 * scopes without a new app registration of this plugin's own; a device-code flow needs *some*
 * `clientId`, and standing up and maintaining a dedicated one buys nothing a well-known public
 * client doesn't already provide for this exact flow.
 */
const DEVICE_CODE_CLIENT_ID = '14d82eec-204b-4c2f-b7e8-296a70dab67e';
const AUTHORITY = 'https://login.microsoftonline.com/organizations';

/** How far back the wizard's own live message-list preview looks — entirely separate from a
 * real Collect run's own period (always supplied by core, via `discover()`'s own argument),
 * matching §5's note that a source's `config` is never allowed to carry a captured date range. */
const PREVIEW_WINDOW_DAYS = 30;

interface PdfAttachmentRef {
  messageId: string;
  attachmentId: string;
  attachmentName: string;
  attachmentContentType: string;
  invoiceNumber?: string;
}

function isoDateNDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function resolveListData(ctx: PluginContext, request: WizardListDataRequest, signal: AbortSignal): Promise<WizardListDataResult> {
  if (request.dataSource !== 'messagePreview') {
    throw new Error(`Unknown dataSource "${request.dataSource}"`);
  }
  if (!request.sessionId) {
    return { rows: [] };
  }

  const config = request.fieldValues as MailSourceConfig;
  const messages = await listMessages(
    ctx.http,
    request.sessionId,
    { start: isoDateNDaysAgo(PREVIEW_WINDOW_DAYS), end: todayIsoDate(), hasAttachmentsOnly: config.hasAttachmentsOnly },
    signal,
  );

  return {
    rows: messages
      .filter((message) => matchesMailFilter(message, config))
      .map((message) => ({
        subject: message.subject,
        from: message.from ?? '',
        received: message.receivedDateTime.slice(0, 10),
      })),
  };
}

/** Finds fields via the built-in rules: the message body first (cheap, no extra request), then —
 * only if that came up empty and a real file attachment exists — that attachment's own PDF text.
 * Manual field-rule capture (reconciling what these rules miss) is deliberately out of scope
 * here, per §14.3. */
async function extractInvoiceFields(
  ctx: PluginContext,
  sessionId: string,
  messageId: string,
  bodyContentType: 'text' | 'html',
  bodyContent: string,
  fileAttachment: { id: string; name: string; contentType: string } | undefined,
  signal: AbortSignal,
) {
  const bodyText = bodyContentType === 'html' ? htmlToText(bodyContent) : bodyContent;
  const bodyFields = parseInvoiceFields(bodyText);
  if (bodyFields.invoiceNumber ?? bodyFields.issuedDate ?? bodyFields.amount) {
    return bodyFields;
  }

  if (!fileAttachment) return bodyFields;

  try {
    const bytes = await getAttachmentBytes(ctx.http, sessionId, messageId, fileAttachment.id, signal);
    const pdfText = await extractPdfText(bytes);
    return parseInvoiceFields(pdfText);
  } catch (err) {
    ctx.log.warn('Could not extract text from the attached PDF', {
      messageId,
      attachmentId: fileAttachment.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return bodyFields;
  }
}

async function* discover(
  ctx: PluginContext,
  record: PluginSourceRecord,
  period: { start: string; end: string },
  signal: AbortSignal,
): AsyncGenerator<DiscoveredInvoice> {
  const config = record.config as MailSourceConfig;
  if (!record.sessionId) {
    ctx.log.warn('No session assigned to this source — nothing to discover', { sourceId: record.id });
    return;
  }

  // A hard requirement regardless of the config's own hasAttachmentsOnly — fetchContent() has to
  // hand back a real file, and there's nothing to fetch from a message with no attachment at all.
  const messages = await listMessages(ctx.http, record.sessionId, { start: period.start, end: period.end, hasAttachmentsOnly: true }, signal);

  for (const message of messages) {
    if (!matchesMailFilter(message, config)) continue;

    const [detail, attachments] = await Promise.all([
      getMessageDetail(ctx.http, record.sessionId, message.id, signal),
      listAttachments(ctx.http, record.sessionId, message.id, signal),
    ]);
    const fileAttachment = attachments[0];
    if (!fileAttachment) {
      ctx.log.warn('Message matched the filter but has no real file attachment — skipping', { messageId: message.id });
      continue;
    }

    const fields = await extractInvoiceFields(ctx, record.sessionId, message.id, detail.bodyContentType, detail.bodyContent, fileAttachment, signal);
    if (fields.invoiceNumber === undefined && fields.issuedDate === undefined && fields.amount === undefined) {
      // The built-in rules found nothing at all — not confidently an invoice in this phase's
      // scope (manual field-rule capture, for exactly this case, is §14.3's backlog item).
      continue;
    }

    const pluginRef: PdfAttachmentRef = {
      messageId: message.id,
      attachmentId: fileAttachment.id,
      attachmentName: fileAttachment.name,
      attachmentContentType: fileAttachment.contentType,
      invoiceNumber: fields.invoiceNumber,
    };

    yield {
      id: `${message.id}:${fileAttachment.id}`,
      issuedDate: fields.issuedDate ?? message.receivedDateTime.slice(0, 10),
      amount: fields.amount,
      pluginRef,
    };
  }
}

async function fetchContent(
  ctx: PluginContext,
  record: PluginSourceRecord,
  discovered: DiscoveredInvoice,
  signal: AbortSignal,
): Promise<InvoiceContent> {
  if (!record.sessionId) throw new Error('No session assigned to this source');
  const pluginRef = discovered.pluginRef as PdfAttachmentRef;

  const bytes = await getAttachmentBytes(ctx.http, record.sessionId, pluginRef.messageId, pluginRef.attachmentId, signal);
  return {
    fileName: buildInvoiceFileName(pluginRef.invoiceNumber, pluginRef.attachmentName),
    mimeType: pluginRef.attachmentContentType,
    bytes,
  };
}

function builtInSessionCreateInput(requirement: SessionRequirement): unknown {
  return {
    deviceAuthorizationEndpoint: `${AUTHORITY}/oauth2/v2.0/devicecode`,
    tokenEndpoint: `${AUTHORITY}/oauth2/v2.0/token`,
    clientId: DEVICE_CODE_CLIENT_ID,
    scope: [...requirement.requiredScopesOrRoles, 'offline_access'].join(' '),
    label: 'Microsoft 365 sign-in',
  };
}

const graphMailSource: SourcePlugin = {
  manifest: {
    id: 'app.easygroup.source.email-mail',
    name: 'Graph Mail',
    version: '0.0.0',
    pluginApiVersion: '0.0.0',
    kind: 'source',
    // Genuinely true — this bundled reference plugin lives in this same public repo (§2/§9).
    // Whether that fact is ever actually checked against an attestation, or this simply loads
    // as a first-party bundled plugin without going through the generic install pipeline at
    // all, is phase 1.17's own packaging decision, not this manifest's concern.
    repository: 'https://github.com/EasyGroupTech/invoice-collector-app',
    sbom: 'sbom.cdx.json',
    main: 'index.js',
  },
  sessionRequirements: [
    {
      sessionTypeId: SESSION_TYPE_ID,
      confirmsBuiltIn: true,
      requiredScopesOrRoles: REQUIRED_SCOPES,
      permissionsNote: 'Needed to list mailbox messages and download invoice attachments. Read-only — this plugin never sends, deletes, or modifies anything in the mailbox.',
    },
  ],
  wizard: [
    { kind: 'field', name: 'subjectContains', label: 'Subject contains', type: 'text', placeholder: 'e.g. Invoice' },
    { kind: 'field', name: 'senderContains', label: 'Sender contains', type: 'text', placeholder: 'e.g. billing@vendor.com' },
    { kind: 'field', name: 'hasAttachmentsOnly', label: 'Only messages with attachments', type: 'checkbox' },
    {
      kind: 'list',
      name: 'messagePreview',
      label: `Matching messages (last ${PREVIEW_WINDOW_DAYS} days)`,
      columns: [
        { key: 'subject', label: 'Subject' },
        { key: 'from', label: 'From' },
        { key: 'received', label: 'Received' },
      ],
      dataSource: 'messagePreview',
    },
  ],
  resolveListData,
  builtInSessionCreateInput,
  discover,
  fetchContent,
};

export default graphMailSource;
