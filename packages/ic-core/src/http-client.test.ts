import type { HttpRequestInput, Session } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createHttpApi, DEFAULT_RETRY_POLICY, type HttpLogEntry, type SessionAuthResolver } from './http-client.js';

function fakeFetchResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const json = JSON.stringify(body);
  return new Response(json, { status, headers: { 'content-type': 'application/json', ...headers } });
}

function fakeSessionAuthResolver(overrides: Partial<SessionAuthResolver> = {}): SessionAuthResolver {
  return {
    attachAuth: vi.fn(async (_pluginId, _sessionId, request: HttpRequestInput) => ({
      ...request,
      headers: { ...request.headers, Authorization: 'Bearer current-token' },
    })),
    recoverSession: vi.fn(async () => ({ id: 's1' }) as Session),
    ...overrides,
  };
}

describe('createHttpApi', () => {
  it('performs a plain request with no sessionId unauthenticated', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => fakeFetchResponse(200, { ok: true }));
    const api = createHttpApi('ic-email-to-downloads', {
      sessionsRegistry: fakeSessionAuthResolver(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const response = await api.request({ url: 'https://example.com/health' });

    expect(response.status).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toBeUndefined();
  });

  it('attaches auth via SessionAuthResolver.attachAuth() when sessionId is set', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, _init?: RequestInit) => fakeFetchResponse(200, { ok: true }));
    const sessionsRegistry = fakeSessionAuthResolver();
    const api = createHttpApi('ic-email-to-downloads', { sessionsRegistry, fetchImpl: fetchImpl as unknown as typeof fetch });

    await api.request({ url: 'https://example.com/data', sessionId: 'session-1' });

    expect(sessionsRegistry.attachAuth).toHaveBeenCalledWith('ic-email-to-downloads', 'session-1', {
      url: 'https://example.com/data',
      sessionId: 'session-1',
    });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer current-token');
  });

  it('logs method, sanitized host+path, status, and duration — never headers or body', async () => {
    const fetchImpl = vi.fn(async () => fakeFetchResponse(200, { ok: true }));
    const onLog = vi.fn();
    const api = createHttpApi('ic-email-to-downloads', {
      sessionsRegistry: fakeSessionAuthResolver(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onLog,
    });

    await api.request({
      url: 'https://contoso.sharepoint.com/sites/Finance/invoice.pdf?sig=SECRET',
      headers: { 'X-Custom': 'value' },
      body: 'super secret body',
    });

    expect(onLog).toHaveBeenCalledTimes(1);
    const entry = onLog.mock.calls[0][0] as HttpLogEntry;
    expect(entry.method).toBe('GET');
    expect(entry.url).toBe('https://[tenant].sharepoint.com/…/invoice.pdf');
    expect(entry.status).toBe(200);
    expect(typeof entry.durationMs).toBe('number');
    expect(JSON.stringify(entry)).not.toContain('SECRET');
    expect(JSON.stringify(entry)).not.toContain('X-Custom');
    expect(JSON.stringify(entry)).not.toContain('super secret body');
  });

  describe('401 recovery', () => {
    it('recovers the session and retries exactly once on a 401', async () => {
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        return call === 1 ? fakeFetchResponse(401, { error: 'unauthorized' }) : fakeFetchResponse(200, { ok: true });
      });
      const sessionsRegistry = fakeSessionAuthResolver();
      const api = createHttpApi('ic-email-to-downloads', { sessionsRegistry, fetchImpl: fetchImpl as unknown as typeof fetch });

      const response = await api.request({ url: 'https://example.com/data', sessionId: 'session-1' });

      expect(response.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sessionsRegistry.recoverSession).toHaveBeenCalledWith('ic-email-to-downloads', 'session-1');
      expect(sessionsRegistry.attachAuth).toHaveBeenCalledTimes(2);
    });

    it('returns the original 401 unretried when recovery itself fails', async () => {
      const fetchImpl = vi.fn(async () => fakeFetchResponse(401, { error: 'unauthorized' }));
      const sessionsRegistry = fakeSessionAuthResolver({
        recoverSession: vi.fn(async () => {
          throw new Error('reconnect required');
        }),
      });
      const api = createHttpApi('ic-email-to-downloads', { sessionsRegistry, fetchImpl: fetchImpl as unknown as typeof fetch });

      const response = await api.request({ url: 'https://example.com/data', sessionId: 'session-1' });

      expect(response.status).toBe(401);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('does not attempt recovery for a request with no sessionId', async () => {
      const fetchImpl = vi.fn(async () => fakeFetchResponse(401, { error: 'unauthorized' }));
      const sessionsRegistry = fakeSessionAuthResolver();
      const api = createHttpApi('ic-email-to-downloads', { sessionsRegistry, fetchImpl: fetchImpl as unknown as typeof fetch });

      const response = await api.request({ url: 'https://example.com/data' });

      expect(response.status).toBe(401);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sessionsRegistry.recoverSession).not.toHaveBeenCalled();
    });

    it('only ever retries once, even if the retried request also comes back 401', async () => {
      const fetchImpl = vi.fn(async () => fakeFetchResponse(401, { error: 'unauthorized' }));
      const sessionsRegistry = fakeSessionAuthResolver();
      const api = createHttpApi('ic-email-to-downloads', { sessionsRegistry, fetchImpl: fetchImpl as unknown as typeof fetch });

      const response = await api.request({ url: 'https://example.com/data', sessionId: 'session-1' });

      expect(response.status).toBe(401);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(sessionsRegistry.recoverSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('throttling retry', () => {
    it('retries on 429 with exponential backoff (1s/2s/4s by default), succeeding once the server stops throttling', async () => {
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        return call <= 2 ? fakeFetchResponse(429, {}) : fakeFetchResponse(200, { ok: true });
      });
      const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => {});
      const api = createHttpApi('ic-email-to-downloads', {
        sessionsRegistry: fakeSessionAuthResolver(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
      });

      const response = await api.request({ url: 'https://example.com/data' });

      expect(response.status).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 2000]);
    });

    it('honors a Retry-After header (seconds) over the computed backoff', async () => {
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call += 1;
        return call === 1 ? fakeFetchResponse(429, {}, { 'retry-after': '7' }) : fakeFetchResponse(200, { ok: true });
      });
      const sleep = vi.fn(async () => {});
      const api = createHttpApi('ic-email-to-downloads', {
        sessionsRegistry: fakeSessionAuthResolver(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
      });

      await api.request({ url: 'https://example.com/data' });

      expect(sleep).toHaveBeenCalledWith(7000, undefined);
    });

    it('gives up after the configured max retries and returns the last 429 response', async () => {
      const fetchImpl = vi.fn(async () => fakeFetchResponse(429, {}));
      const sleep = vi.fn(async () => {});
      const api = createHttpApi('ic-email-to-downloads', {
        sessionsRegistry: fakeSessionAuthResolver(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
        retryPolicy: () => ({ baseDelayMs: 10, maxRetries: 2 }),
      });

      const response = await api.request({ url: 'https://example.com/data' });

      expect(response.status).toBe(429);
      expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it('uses DEFAULT_RETRY_POLICY when no retryPolicy is supplied', async () => {
      const fetchImpl = vi.fn(async () => fakeFetchResponse(429, {}));
      const sleep = vi.fn(async () => {});
      const api = createHttpApi('ic-email-to-downloads', {
        sessionsRegistry: fakeSessionAuthResolver(),
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep,
      });

      await api.request({ url: 'https://example.com/data' });

      expect(fetchImpl).toHaveBeenCalledTimes(DEFAULT_RETRY_POLICY.maxRetries + 1);
    });
  });
});
