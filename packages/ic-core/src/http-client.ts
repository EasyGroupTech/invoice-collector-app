import type { HttpApi, HttpRequestInput, HttpResponse, Session } from 'invoice-collector-plugin-sdk';
import { sanitizeUrlForLog } from './log-sanitize.js';

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
          await sleep(delayMs, signal);
          continue;
        }

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
