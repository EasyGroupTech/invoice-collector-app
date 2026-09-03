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
