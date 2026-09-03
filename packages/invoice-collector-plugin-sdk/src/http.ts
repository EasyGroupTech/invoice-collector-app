export interface HttpRequestInput {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /**
   * Core resolves this session and attaches the right auth (header, cookie, or request signing)
   * automatically, recovers it via that session's own refresh on a 401 and retries once, and
   * retries on throttling responses per the app's Advanced Settings policy — none of this is the
   * calling plugin's own responsibility.
   */
  sessionId?: string;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  json(): unknown;
  text(): string;
  arrayBuffer(): ArrayBuffer;
}

/**
 * Core-provided HTTP client. Every outbound call a plugin makes goes through this, not a raw
 * `fetch` — request/response logging (sanitized) and 401/throttling retry are enforced here,
 * once, rather than left to each plugin to reimplement.
 */
export interface HttpApi {
  request(input: HttpRequestInput, signal?: AbortSignal): Promise<HttpResponse>;
}
