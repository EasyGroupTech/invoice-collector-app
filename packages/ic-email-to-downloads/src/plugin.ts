import type {
  DiscoveredInvoice,
  InvoiceContent,
  PluginContext,
  PluginSourceRecord,
  Session,
  SessionRequirement,
  SourcePlugin,
  WizardListDataRequest,
  WizardListDataResult,
} from 'invoice-collector-plugin-sdk';
import { buildInvoiceFileName } from './file-naming.js';
import { getAttachmentBytes, getMessageDetail, getSignedInMailboxAddress, listAttachments, listMessages } from './graph-mail.js';
import { htmlToText, parseInvoiceFields, type ParsedInvoiceFields } from './invoice-text-parsing.js';
import { extractFieldsWithRules } from './mail-field-rules.js';
import { matchesMailFilter, type MailSourceConfig } from './mail-filter.js';

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

/** How many of the preview window's matching messages the field-rule-capture step will examine
 * (detail + attachment fetches, real API calls each) looking for one the built-in rules can't
 * fully parse — a defensive cap so a large, loosely-filtered mailbox can't make this wizard step
 * hang scanning dozens of messages one by one. */
const FIELD_RULE_SAMPLE_SCAN_LIMIT = 20;

function isComplete(fields: ParsedInvoiceFields): boolean {
  return fields.invoiceNumber !== undefined && fields.issuedDate !== undefined && fields.amount !== undefined;
}

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

async function resolveMessagePreview(ctx: PluginContext, request: WizardListDataRequest, signal: AbortSignal): Promise<WizardListDataResult> {
  if (!request.sessionId) return { rows: [] };

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

/**
 * §14.3's manual field-rule capture — the wizard's own `textSelect` step, one row deep. Scans the
 * same preview-window/filtered candidates `messagePreview` does, looking for the first one the
 * built-in rules (body-only, then PDF-only, then a body+PDF per-field merge — see
 * `extractInvoiceFields`'s own three stages) still can't fully parse, and hands back its raw
 * body/PDF text for the wizard to render selectably. `alreadyParsed: true` means every candidate
 * examined already parses fine (or there were none at all) — nothing to teach here.
 */
async function resolveFieldRuleSample(ctx: PluginContext, request: WizardListDataRequest, signal: AbortSignal): Promise<WizardListDataResult> {
  if (!request.sessionId) return { rows: [] };

  const config = request.fieldValues as MailSourceConfig;
  const messages = await listMessages(
    ctx.http,
    request.sessionId,
    { start: isoDateNDaysAgo(PREVIEW_WINDOW_DAYS), end: todayIsoDate(), hasAttachmentsOnly: config.hasAttachmentsOnly },
    signal,
  );
  const candidates = messages.filter((message) => matchesMailFilter(message, config)).slice(0, FIELD_RULE_SAMPLE_SCAN_LIMIT);

  for (const message of candidates) {
    const detail = await getMessageDetail(ctx.http, request.sessionId, message.id, signal);
    const bodyText = detail.bodyContentType === 'html' ? htmlToText(detail.bodyContent) : detail.bodyContent;
    if (isComplete(parseInvoiceFields(bodyText))) continue;

    let pdfText: string | undefined;
    const attachments = await listAttachments(ctx.http, request.sessionId, message.id, signal);
    const fileAttachment = attachments[0];
    if (fileAttachment) {
      try {
        const bytes = await getAttachmentBytes(ctx.http, request.sessionId, message.id, fileAttachment.id, signal);
        pdfText = await ctx.pdf.extractText(bytes);
        if (isComplete(parseInvoiceFields(pdfText))) continue;
      } catch (err) {
        ctx.log.warn('Could not extract text from the attached PDF while sampling for field-rule capture', {
          messageId: message.id,
          attachmentId: fileAttachment.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // A field found in the body and another only in the PDF can still add up to a fully parsed
    // invoice even though neither text alone was complete — only genuinely offer this message up
    // for manual capture once the combined result still falls short.
    if (isComplete(extractFieldsWithRules(bodyText, pdfText, []).fields)) continue;

    return { rows: [{ bodyText, pdfText, alreadyParsed: false }] };
  }

  return { rows: [{ bodyText: '', alreadyParsed: candidates.length > 0 }] };
}

async function resolveListData(ctx: PluginContext, request: WizardListDataRequest, signal: AbortSignal): Promise<WizardListDataResult> {
  if (request.dataSource === 'messagePreview') return resolveMessagePreview(ctx, request, signal);
  if (request.dataSource === 'fieldRuleSample') return resolveFieldRuleSample(ctx, request, signal);
  throw new Error(`Unknown dataSource "${request.dataSource}"`);
}

/**
 * Finds fields via three stages, each trying harder than the last: the message body alone (cheap,
 * no extra request) — if that's not already a *complete* result, the attachment's own PDF text
 * alone (if one exists) — and if that's still not complete, a per-field reconciliation
 * (§14.3, `extractFieldsWithRules`) that merges body and PDF field-by-field (a field found in one
 * and another only in the other can still add up to complete) and, for whatever's still missing,
 * tries a user-captured field rule before giving up on that one field. Passing an empty
 * `fieldRules` array degrades stage 3 to just that body+PDF merge, so this stays the right final
 * fallback even for a source with no rules configured at all.
 */
async function extractInvoiceFields(
  ctx: PluginContext,
  sessionId: string,
  messageId: string,
  bodyContentType: 'text' | 'html',
  bodyContent: string,
  fileAttachment: { id: string; name: string; contentType: string } | undefined,
  config: MailSourceConfig,
  signal: AbortSignal,
): Promise<ParsedInvoiceFields> {
  const bodyText = bodyContentType === 'html' ? htmlToText(bodyContent) : bodyContent;
  const bodyFields = parseInvoiceFields(bodyText);
  if (isComplete(bodyFields)) return bodyFields;

  let pdfText: string | undefined;
  if (fileAttachment) {
    try {
      const bytes = await getAttachmentBytes(ctx.http, sessionId, messageId, fileAttachment.id, signal);
      pdfText = await ctx.pdf.extractText(bytes);
      const pdfFields = parseInvoiceFields(pdfText);
      if (isComplete(pdfFields)) return pdfFields;
    } catch (err) {
      ctx.log.warn('Could not extract text from the attached PDF', {
        messageId,
        attachmentId: fileAttachment.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return extractFieldsWithRules(bodyText, pdfText, config.fieldRules ?? []).fields;
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

    const fields = await extractInvoiceFields(ctx, record.sessionId, message.id, detail.bodyContentType, detail.bodyContent, fileAttachment, config, signal);
    if (fields.invoiceNumber === undefined && fields.issuedDate === undefined && fields.amount === undefined) {
      // Nothing at all found, even after a configured field rule got its own chance — not
      // confidently an invoice.
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
      // Same preference order buildInvoiceFileName() already uses for the downloaded file's own
      // name — a parsed invoice number when there is one, else the attachment's own filename,
      // either way readable, unlike `id` (a Graph message+attachment id pair, never meant for
      // display).
      name: fields.invoiceNumber ?? fileAttachment.name,
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

/** The wizard's own friendly-name follow-up (§6): once a device-code session is established, the
 * signed-in mailbox's own address (§14.1: "who logs in, where") reads far better as a session
 * name than the generic built-in label — the shared `microsoftEntraDelegatedDeviceCodeSessionPlugin`
 * doesn't know this (it also serves ARM consumers, which have no mailbox concept at all), so it
 * lives here, in the one plugin that actually wants it. */
async function suggestSessionLabel(ctx: PluginContext, session: Session, signal: AbortSignal): Promise<string | undefined> {
  if (session.sessionTypeId !== SESSION_TYPE_ID) return undefined;
  return getSignedInMailboxAddress(ctx.http, session.id, signal);
}

/** §14.1's source auto-naming: the session's own address plus a short summary of whichever
 * filter fields the user actually set — a source with no filter at all still gets a real,
 * distinguishing name (just the mailbox address alone) rather than nothing. */
function suggestSourceName(_ctx: PluginContext, session: Session, configValues: unknown, _signal: AbortSignal): Promise<string | undefined> {
  const config = configValues as Partial<MailSourceConfig> | undefined;
  const parts: string[] = [];
  if (config?.subjectContains) parts.push(`Subject contains "${config.subjectContains}"`);
  if (config?.senderContains) parts.push(`Sender contains "${config.senderContains}"`);
  if (config?.hasAttachmentsOnly) parts.push('has attachments');
  return Promise.resolve(parts.length > 0 ? `${session.label} (${parts.join(', ')})` : session.label);
}

const graphMailSource: SourcePlugin = {
  // §9.4: version/pluginApiVersion/repository/sbom are package-level now (this implementation's
  // package is app.easygroup.email-to-downloads — see package-manifest.ts). Whether that package
  // is ever actually checked against a GitHub Artifact Attestation, or this simply loads as a
  // first-party bundled package without going through the generic install pipeline at all, is
  // phase 1.17's own packaging decision, not this manifest's concern.
  manifest: {
    id: 'app.easygroup.source.email-mail',
    name: 'Graph Mail',
    kind: 'source',
    main: 'index.js',
  },
  sessionRequirements: [
    {
      sessionTypeId: SESSION_TYPE_ID,
      confirmsBuiltIn: true,
      requiredScopesOrRoles: REQUIRED_SCOPES,
      permissionsNote: 'Needed to list mailbox messages and download invoice attachments. Read-only — this plugin never sends, deletes, or modifies anything in the mailbox.',
      collects: 'invoices from my Microsoft Email',
      connectHow: "I'll authenticate this device.",
      connectInstructions:
        "You'll get a one-time code and a Microsoft sign-in link — open the link, enter the code, and sign in with the mailbox's own account.",
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
      // Order matters here beyond just labeling — the wizard renders this as a two-line block per
      // message (subject, then every other column joined), not a table, so this is display order:
      // subject as the prominent first line, received-date-then-sender as the second.
      columns: [
        { key: 'subject', label: 'Subject' },
        { key: 'received', label: 'Received' },
        { key: 'from', label: 'From' },
      ],
      dataSource: 'messagePreview',
    },
    {
      kind: 'textSelect',
      name: 'fieldRules',
      label: 'Teach a template the built-in rules miss (optional)',
      fields: [
        { name: 'invoiceNumber', label: 'Invoice Number' },
        { name: 'issuedDate', label: 'Issued Date' },
        { name: 'amount', label: 'Amount' },
      ],
      dataSource: 'fieldRuleSample',
    },
  ],
  resolveListData,
  builtInSessionCreateInput,
  suggestSessionLabel,
  suggestSourceName,
  discover,
  fetchContent,
};

export default graphMailSource;
