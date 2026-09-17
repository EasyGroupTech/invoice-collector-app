import type { HttpApi, HttpRequestInput, HttpResponse, Session } from 'invoice-collector-plugin-sdk';
import type { AuditLogEntry } from './audit-log.js';
import { sanitizeBodyForLog, sanitizeHeadersForLog, sanitizeResponseBodyForLog, sanitizeUrlForAudit, sanitizeUrlForLog } from './log-sanitize.js';

/**
 * The two SessionsRegistry primitives HttpApi needs (§7) — narrowed rather than importing the
 * full SessionsRegistry type, so this module's own dependency surface stays minimal and easy to
 * fake in tests. A real SessionsRegistry instance satisfies this structurally.
 */
export interface SessionAuthResolver {
  attachAuth(pluginId: string, sessionId: string, request: HttpRequestInput): Promise<HttpRequestInput>;
  recoverSession(pluginId: string, sessionId: string): Promise<Session>;
}

/** Advanced Settings knobs (§7) — base delay and retry count are user-configurable; the
 * escalating-delay shape itself (doubling each attempt) is the one fixed algorithm. */
export interface RetryPolicy {
  baseDelayMs: number;
  maxRetries: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = { baseDelayMs: 1000, maxRetries: 3 };

export interface HttpLogEntry {
  method: string;
  /** Already sanitized (sanitizeUrlForLog) — origin + final path segment only. */
  url: string;
  status?: number;
  durationMs: number;
  attempt: number;
  outcome: 'ok' | 'retrying-throttled' | 'retrying-after-recovery' | 'error';
}

export interface HttpClientOptions {
  sessionsRegistry: SessionAuthResolver;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called fresh on every request, so a later Advanced Settings UI can change these live without
   * reconstructing HttpApi. Defaults to DEFAULT_RETRY_POLICY. */
  retryPolicy?: () => RetryPolicy;
  /** Never receives headers or body (§7's hard constraint) — only what sanitizeUrlForLog/
   * sanitizeMessageForLog already consider safe. Defaults to a no-op; real persistence is a later
   * phase's concern (mirrors how Encryptor/createPluginServices are injected, not built here). */
  onLog?: (entry: HttpLogEntry) => void;
  /**
   * §7's audit log (phase 1.22) — a separate hook from `onLog` above, deliberately: `onLog`'s own
   * "never receives headers or body" constraint stays exactly as it was, untouched, rather than
   * loosened for this. `onAudit` *does* get headers/body, but only ever the already-redacted
   * form (`sanitizeHeadersForLog`/`sanitizeBodyForLog`/`sanitizeResponseBodyForLog`, computed
   * inside this module) — the real, unredacted values never reach this callback either. Fires
   * at the same three points `onLog` does (success, throttled-retry, recovery-retry), since each
   * is a real request that actually went out and is worth its own audit entry, not just the
   * final outcome. */
  onAudit?: (entry: Omit<AuditLogEntry, 'id' | 'timestamp'>) => void;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request was cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Request was cancelled'));
      },
      { once: true },
    );
  });
}

function getHeaderCaseInsensitive(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

function parseRetryAfterMs(headers: Record<string, string>): number | undefined {
  const raw = headers['retry-after'];
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function toRequestInit(input: HttpRequestInput, signal?: AbortSignal): RequestInit {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (input.timeoutMs !== undefined) signals.push(AbortSignal.timeout(input.timeoutMs));

  return {
    method: input.method ?? 'GET',
    headers: input.headers,
    body: input.body as RequestInit['body'],
    signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
  };
}

async function toHttpResponse(response: Response): Promise<HttpResponse> {
  const bodyBuffer = await response.arrayBuffer();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: response.status,
    headers,
    json: () => JSON.parse(Buffer.from(bodyBuffer).toString('utf-8')) as unknown,
    text: () => Buffer.from(bodyBuffer).toString('utf-8'),
    arrayBuffer: () => bodyBuffer,
  };
}

export function createHttpApi(pluginId: string, options: HttpClientOptions): HttpApi {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;

  return {
    async request(input, signal) {
      const policy = options.retryPolicy?.() ?? DEFAULT_RETRY_POLICY;
      let recoveredOnce = false;
      let throttleAttempts = 0;
      let attempt = 0;

      for (;;) {
        attempt += 1;

        let authed = input;
        if (input.sessionId) {
          authed = await options.sessionsRegistry.attachAuth(pluginId, input.sessionId, input);
        }

        const startedAt = now();
        // authed.url (not input.url) — applyAuth() returns the *whole* modified request, since
        // some mechanisms (SigV4-style presigned variants) can fold auth into the URL itself, not
        // just headers.
        const rawResponse = await fetchImpl(authed.url, toRequestInit(authed, signal));
        const durationMs = now() - startedAt;
        const response = await toHttpResponse(rawResponse);

        // Computed once per attempt regardless of which of the three onAudit call sites below
        // ends up firing — always the *redacted* form; the real headers/body never leave this
        // scope any further than this.
        const auditFields = options.onAudit
          ? {
              pluginId,
              method: input.method ?? 'GET',
              // sanitizeUrlForAudit, not sanitizeUrlForLog — the audit log needs the full path
              // shape and non-secret query params (api-version, …) for "Copy as cURL" to
              // actually be replayable; onLog's own terse summary line below stays on the
              // more aggressive sanitizeUrlForLog, unchanged.
              url: sanitizeUrlForAudit(input.url),
              durationMs,
              requestHeaders: sanitizeHeadersForLog(authed.headers ?? {}),
              responseHeaders: sanitizeHeadersForLog(response.headers),
              requestBody: sanitizeBodyForLog(getHeaderCaseInsensitive(authed.headers, 'content-type'), authed.body),
              responseBody: sanitizeResponseBodyForLog(response.headers['content-type'], response.arrayBuffer()),
            }
          : undefined;

        if (response.status === 401 && input.sessionId && !recoveredOnce) {
          recoveredOnce = true;
          options.onLog?.({
            method: input.method ?? 'GET',
            url: sanitizeUrlForLog(input.url),
            status: response.status,
            durationMs,
            attempt,
            outcome: 'retrying-after-recovery',
          });
          if (auditFields) options.onAudit?.({ ...auditFields, status: response.status });
          try {
            await options.sessionsRegistry.recoverSession(pluginId, input.sessionId);
          } catch {
            return response; // recovery failed — surface the original 401, same as today
          }
          continue;
        }

        if (response.status === 429 && throttleAttempts < policy.maxRetries) {
          const delayMs = parseRetryAfterMs(response.headers) ?? policy.baseDelayMs * 2 ** throttleAttempts;
          throttleAttempts += 1;
          options.onLog?.({
            method: input.method ?? 'GET',
            url: sanitizeUrlForLog(input.url),
            status: response.status,
            durationMs,
            attempt,
            outcome: 'retrying-throttled',
          });
          if (auditFields) options.onAudit?.({ ...auditFields, status: response.status });
          await sleep(delayMs, signal);
          continue;
        }

        if (auditFields) options.onAudit?.({ ...auditFields, status: response.status });

        options.onLog?.({
          method: input.method ?? 'GET',
          url: sanitizeUrlForLog(input.url),
          status: response.status,
          durationMs,
          attempt,
          outcome: 'ok',
        });
        return response;
      }
    },
  };
}
