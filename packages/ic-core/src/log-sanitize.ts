// Ported from the reference app's electron/main/appLog.ts — the pure sanitization logic only,
// kept Electron-free so it's usable both by HttpApi's own request logging and by whatever
// implements PluginLogApi for real later (a later phase).

// Key names that must never reach a log line in plaintext, matched case-insensitively against
// object keys anywhere in a (possibly nested) value — covers clientSecret/refreshToken/
// accessToken/apiKey/awsSecretAccessKey and anything named similarly, without needing an
// exhaustive per-field list.
const SENSITIVE_KEY_PATTERN = /password|secret|token|credential|apikey|api_key/i;

export function sanitizeValueForLog(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);

  if (Array.isArray(value)) return value.map((v) => sanitizeValueForLog(v, seen));

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : sanitizeValueForLog(val, seen);
  }
  return out;
}

// A *.sharepoint.com hostname is tenant-identifying on its own (the subdomain IS the tenant
// name), so it gets its own placeholder rather than being kept as "context."
const SHAREPOINT_HOST = /^[^.]+\.sharepoint\.com$/i;

export function sanitizeUrlForLog(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl; // not a URL after all — leave whatever text it was alone
  }
  const host = SHAREPOINT_HOST.test(url.hostname) ? '[tenant].sharepoint.com' : url.hostname;
  const segments = url.pathname.split('/').filter(Boolean);
  const lastSegment = segments.length > 0 ? segments[segments.length - 1] : '';
  const path = segments.length > 1 ? `/…/${lastSegment}` : segments.length === 1 ? `/${lastSegment}` : '/';
  // Query string and hash dropped entirely — SAS tokens, signatures, and other sensitive params
  // live there, with no benign case worth preserving them for.
  return `${url.protocol}//${host}${path}`;
}

// Query parameter names that commonly carry a credential/signature — a SAS token, an Azure ARM
// invoice-download SAS, an API key passed as `?key=`/`?apikey=`, etc. Matched against the param
// *name*, not its value, same convention as SENSITIVE_KEY_PATTERN/SENSITIVE_HEADER_NAMES.
const SENSITIVE_QUERY_PARAM_PATTERN = /sig|signature|token|key|secret|sas|password|credential/i;

/**
 * §7's audit log (phase 1.22) needs a *less* lossy URL than `sanitizeUrlForLog` above —
 * confirmed live: reducing a URL to "origin + last path segment, no query string at all" made
 * the audit log's own "Copy as cURL" action produce a command that couldn't actually be replayed
 * (wrong path — every id/resource-name segment gone — and missing genuinely useful, non-secret
 * params like `api-version`). `sanitizeUrlForLog` itself is intentionally left alone — it backs
 * `onLog`'s own terse per-call summary line in the plain-text app.log, where that brevity is
 * still the right trade-off and replayability was never a design goal.
 *
 * Keeps the *full* path shape, with only a GUID or long numeric id inside it masked (reusing the
 * same `GUID_PATTERN`/`LONG_NUMERIC_PATTERN` `sanitizeMessageForLog` already uses) — a
 * subscription id or invoice id becomes `[id]`, but "billingAccounts"/"invoices" segments (the
 * actual resource shape a cURL replay needs) survive. Keeps every query parameter whose *name*
 * doesn't look credential-shaped, redacting only the ones that do (a SAS/signature/API key) —
 * `api-version` and similar genuinely useful, non-secret params stay real.
 */
export function sanitizeUrlForAudit(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  const host = SHAREPOINT_HOST.test(url.hostname) ? '[tenant].sharepoint.com' : url.hostname;
  const path = url.pathname.replace(GUID_PATTERN, '[id]').replace(LONG_NUMERIC_PATTERN, '[id]');

  const params = new URLSearchParams();
  for (const [key, value] of url.searchParams) {
    params.set(key, SENSITIVE_QUERY_PARAM_PATTERN.test(key) ? '[REDACTED]' : value);
  }
  const query = params.toString();

  return `${url.protocol}//${host}${path}${query ? `?${query}` : ''}`;
}

// HTTP header names that carry credentials by convention but don't contain any of
// SENSITIVE_KEY_PATTERN's own substrings ("authorization"/"cookie" match none of
// password/secret/token/credential/apikey) — §7's audit log (phase 1.22) needs both checks, not
// either alone, since a plugin-specific custom header (`X-Custom-Secret`) still needs the
// generic pattern.
const SENSITIVE_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'x-amz-security-token',
]);

export function sanitizeHeadersForLog(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADER_NAMES.has(key.toLowerCase()) || SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : value;
  }
  return out;
}

export type AuditBody = { kind: 'json'; value: unknown } | { kind: 'text'; value: string } | { kind: 'omitted'; reason: 'empty' | 'binary' | 'too-large' };

// Never even attempted past this size — protects against decoding a large XML/JSON payload just
// to throw it away, on top of the hard "never log raw PDF bytes" requirement below.
const MAX_AUDIT_BODY_SOURCE_BYTES = 256 * 1024;
const MAX_AUDIT_BODY_TEXT_LENGTH = 4000;

function truncateForLog(text: string): string {
  return text.length > MAX_AUDIT_BODY_TEXT_LENGTH ? `${text.slice(0, MAX_AUDIT_BODY_TEXT_LENGTH)}…[truncated]` : text;
}

/**
 * The *request*-body side of §7's audit log — `HttpRequestInput.body` is `unknown` (a plugin can
 * pass a plain object, a pre-stringified JSON/form-encoded string, or a binary payload), unlike a
 * response's own raw `ArrayBuffer` (see `sanitizeResponseBodyForLog`). Never returns the real
 * value un-redacted: an object goes through `sanitizeValueForLog` same as anywhere else; a string
 * is parsed as JSON when the content-type says so (falling back to plain truncated text if that
 * fails); anything binary-shaped (ArrayBuffer/Uint8Array/Blob/FormData) is never decoded at all.
 */
export function sanitizeBodyForLog(contentType: string | undefined, body: unknown): AuditBody {
  if (body === undefined || body === null || body === '') return { kind: 'omitted', reason: 'empty' };

  if (typeof body === 'string') {
    if (body.length > MAX_AUDIT_BODY_SOURCE_BYTES) return { kind: 'omitted', reason: 'too-large' };
    if (contentType && /json/i.test(contentType)) {
      try {
        return { kind: 'json', value: sanitizeValueForLog(JSON.parse(body)) };
      } catch {
        return { kind: 'text', value: truncateForLog(body) };
      }
    }
    return { kind: 'text', value: truncateForLog(body) };
  }

  if (typeof body === 'object' && !ArrayBuffer.isView(body) && !(body instanceof ArrayBuffer)) {
    return { kind: 'json', value: sanitizeValueForLog(body) };
  }

  return { kind: 'omitted', reason: 'binary' };
}

/**
 * The *response*-body side — always real raw bytes (`HttpResponse.arrayBuffer()`), never decoded
 * to text at all unless the response's own content-type says it's actually text/JSON/XML — a
 * real PDF response never gets its bytes even touched, let alone stored, matching the hard
 * "never log raw PDF bytes" requirement directly rather than relying on a size cap alone.
 */
export function sanitizeResponseBodyForLog(contentType: string | undefined, bytes: ArrayBuffer): AuditBody {
  if (bytes.byteLength === 0) return { kind: 'omitted', reason: 'empty' };
  if (bytes.byteLength > MAX_AUDIT_BODY_SOURCE_BYTES) return { kind: 'omitted', reason: 'too-large' };
  if (!contentType || !/json|^text\/|xml/i.test(contentType)) return { kind: 'omitted', reason: 'binary' };

  const text = Buffer.from(bytes).toString('utf-8');
  if (/json/i.test(contentType)) {
    try {
      return { kind: 'json', value: sanitizeValueForLog(JSON.parse(text)) };
    } catch {
      return { kind: 'text', value: truncateForLog(text) };
    }
  }
  return { kind: 'text', value: truncateForLog(text) };
}

const URL_PATTERN = /https?:\/\/\S+/g;
const GUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_NUMERIC_PATTERN = /\b\d{9,}\b/g;

// An id can reach a log message without ever being part of a proper URL (a bare API path in an
// error message, say) — GUID/long-numeric redaction runs independently of URL handling, directly
// against the whole message, so an id leaks the same way whether or not it happened to be wrapped
// in a full URL this time.
export function sanitizeMessageForLog(message: string): string {
  return message
    .replace(URL_PATTERN, (match) => sanitizeUrlForLog(match))
    .replace(GUID_PATTERN, '[id]')
    .replace(LONG_NUMERIC_PATTERN, '[id]');
}
