import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '../context.js';
import type { Session } from '../session.js';
import {
  oauth2DelegatedDeviceCodeSessionPlugin,
  type OAuth2DelegatedDeviceCodeCreateInput,
  type OAuth2DelegatedDeviceCodeSecret,
} from './oauth2-delegated-device-code.js';

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    headers: {},
    json: () => body,
    text: () => JSON.stringify(body),
    arrayBuffer: () => new ArrayBuffer(0),
  };
}

function createMockContext() {
  return {
    sessions: {
      list: vi.fn(),
      get: vi.fn(),
      create: vi.fn(),
      reconnect: vi.fn(),
    },
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    http: { request: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progress: { report: vi.fn() },
  } as unknown as PluginContext & {
    sessions: { get: ReturnType<typeof vi.fn> };
    http: { request: ReturnType<typeof vi.fn> };
    progress: { report: ReturnType<typeof vi.fn> };
  };
}

const input: OAuth2DelegatedDeviceCodeCreateInput = {
  deviceAuthorizationEndpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/devicecode',
  tokenEndpoint: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/token',
  clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46',
  scope: 'https://graph.microsoft.com/.default offline_access',
};

const deviceAuthorizationBody = {
  device_code: 'device-code-123',
  user_code: 'ABC-DEF',
  verification_uri: 'https://microsoft.com/devicelogin',
  verification_uri_complete: 'https://microsoft.com/devicelogin?otc=ABC-DEF',
  expires_in: 900,
  interval: 5,
};

const tokenSuccessBody = {
  access_token: 'access-token-1',
  refresh_token: 'refresh-token-1',
  expires_in: 3600,
  token_type: 'Bearer',
};

describe('oauth2DelegatedDeviceCodeSessionPlugin.create', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports the user code/verification URL, then resolves once sign-in completes', async () => {
    const ctx = createMockContext();
    ctx.http.request
      .mockResolvedValueOnce(jsonResponse(200, deviceAuthorizationBody))
      .mockResolvedValueOnce(jsonResponse(200, tokenSuccessBody));

    const controller = new AbortController();
    const promise = oauth2DelegatedDeviceCodeSessionPlugin.create(ctx, input, controller.signal);

    // Let the device-authorization request settle before asserting progress was reported.
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.progress.report).toHaveBeenCalledWith('Sign in required', {
      userCode: 'ABC-DEF',
      verificationUri: 'https://microsoft.com/devicelogin',
      verificationUriComplete: 'https://microsoft.com/devicelogin?otc=ABC-DEF',
    });

    await vi.advanceTimersByTimeAsync(5000);

    await expect(promise).resolves.toEqual({
      label: 'Microsoft sign-in',
      secret: {
        accessToken: 'access-token-1',
        refreshToken: 'refresh-token-1',
        deviceAuthorizationEndpoint: input.deviceAuthorizationEndpoint,
        tokenEndpoint: input.tokenEndpoint,
        clientId: input.clientId,
        scope: input.scope,
      } satisfies OAuth2DelegatedDeviceCodeSecret,
      // expires_in is 3600s from when the token response actually arrives, not from t=0 — and
      // arriving here took the 5s poll-interval wait advanced above.
      expiresAt: '2026-01-01T01:00:05.000Z',
    });
  });

  it('keeps polling on authorization_pending', async () => {
    const ctx = createMockContext();
    ctx.http.request
      .mockResolvedValueOnce(jsonResponse(200, deviceAuthorizationBody))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(jsonResponse(200, tokenSuccessBody));

    const promise = oauth2DelegatedDeviceCodeSessionPlugin.create(ctx, input, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.http.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(ctx.http.request).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toMatchObject({ secret: { accessToken: 'access-token-1' } });
  });

  it('increases the poll interval on slow_down instead of retrying immediately', async () => {
    const ctx = createMockContext();
    ctx.http.request
      .mockResolvedValueOnce(jsonResponse(200, deviceAuthorizationBody))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'slow_down' }))
      .mockResolvedValueOnce(jsonResponse(200, tokenSuccessBody));

    const promise = oauth2DelegatedDeviceCodeSessionPlugin.create(ctx, input, new AbortController().signal);

    await vi.advanceTimersByTimeAsync(5000); // initial 5s interval -> slow_down
    expect(ctx.http.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000); // not enough yet — interval grew to 10s
    expect(ctx.http.request).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000); // now at 10s since slow_down
    expect(ctx.http.request).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toMatchObject({ secret: { accessToken: 'access-token-1' } });
  });

  it('rejects when the device code expires before sign-in completes', async () => {
    const ctx = createMockContext();
    ctx.http.request
      .mockResolvedValueOnce(jsonResponse(200, deviceAuthorizationBody))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'expired_token' }));

    const promise = oauth2DelegatedDeviceCodeSessionPlugin.create(ctx, input, new AbortController().signal);
    // Attach a rejection handler synchronously so the fake-timer-driven rejection is never
    // "unhandled" between here and the assertion below.
    const assertion = expect(promise).rejects.toThrow(/expired/i);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('rejects when the user declines the sign-in', async () => {
    const ctx = createMockContext();
    ctx.http.request
      .mockResolvedValueOnce(jsonResponse(200, deviceAuthorizationBody))
      .mockResolvedValueOnce(jsonResponse(400, { error: 'access_denied' }));

    const promise = oauth2DelegatedDeviceCodeSessionPlugin.create(ctx, input, new AbortController().signal);
    const assertion = expect(promise).rejects.toThrow(/declined/i);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('stops polling and rejects when the caller aborts', async () => {
    const ctx = createMockContext();
    ctx.http.request.mockResolvedValueOnce(jsonResponse(200, deviceAuthorizationBody));

    const controller = new AbortController();
    const promise = oauth2DelegatedDeviceCodeSessionPlugin.create(ctx, input, controller.signal);
    const assertion = expect(promise).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(0); // let the device-authorization call resolve
    controller.abort();
    await vi.advanceTimersByTimeAsync(5000);

    await assertion;
    expect(ctx.http.request).toHaveBeenCalledTimes(1); // never polled after abort
  });

  it('rejects once the whole device-code window elapses, even without an explicit server error', async () => {
    const ctx = createMockContext();
    ctx.http.request.mockResolvedValueOnce(
      jsonResponse(200, { ...deviceAuthorizationBody, expires_in: 8, interval: 5 }),
    );
    ctx.http.request.mockResolvedValue(jsonResponse(400, { error: 'authorization_pending' }));

    const promise = oauth2DelegatedDeviceCodeSessionPlugin.create(ctx, input, new AbortController().signal);
    const assertion = expect(promise).rejects.toThrow(/expired/i);

    await vi.advanceTimersByTimeAsync(5000); // first poll, still pending
    await vi.advanceTimersByTimeAsync(5000); // past the 8s deadline now

    await assertion;
  });

  it('rejects synchronously on a malformed input, without making any request', async () => {
    const ctx = createMockContext();
    await expect(
      oauth2DelegatedDeviceCodeSessionPlugin.create(ctx, { clientId: 'only-this' }, new AbortController().signal),
    ).rejects.toThrow();
    expect(ctx.http.request).not.toHaveBeenCalled();
  });
});

describe('oauth2DelegatedDeviceCodeSessionPlugin.refresh', () => {
  const existingSession: Session = {
    id: 'session-1',
    sessionTypeId: 'oauth2-delegated-device-code',
    label: 'Microsoft sign-in',
    createdByPluginId: 'app.easygroup.source.email-mail',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    expiresAt: '2026-01-01T01:00:00.000Z',
  };

  const storedSecret: OAuth2DelegatedDeviceCodeSecret = {
    accessToken: 'old-access-token',
    refreshToken: 'refresh-token-1',
    deviceAuthorizationEndpoint: input.deviceAuthorizationEndpoint,
    tokenEndpoint: input.tokenEndpoint,
    clientId: input.clientId,
    scope: input.scope,
  };

  beforeEach(() => {
    vi.setSystemTime(new Date('2026-01-01T00:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exchanges the refresh token for a new access token', async () => {
    const ctx = createMockContext();
    ctx.sessions.get.mockResolvedValue({ session: existingSession, secret: storedSecret });
    ctx.http.request.mockResolvedValue(jsonResponse(200, tokenSuccessBody));

    const result = await oauth2DelegatedDeviceCodeSessionPlugin.refresh!(
      ctx,
      existingSession,
      new AbortController().signal,
    );

    expect(ctx.http.request).toHaveBeenCalledWith(
      expect.objectContaining({ url: input.tokenEndpoint, method: 'POST' }),
      expect.anything(),
    );
    expect(result).toEqual({
      secret: {
        ...storedSecret,
        accessToken: 'access-token-1',
        refreshToken: 'refresh-token-1',
      },
      expiresAt: '2026-01-01T01:30:00.000Z',
    });
  });

  it('throws when core has no stored session/secret for this id', async () => {
    const ctx = createMockContext();
    ctx.sessions.get.mockResolvedValue(undefined);

    await expect(
      oauth2DelegatedDeviceCodeSessionPlugin.refresh!(ctx, existingSession, new AbortController().signal),
    ).rejects.toThrow();
  });

  it('throws when the stored secret has no refresh token', async () => {
    const ctx = createMockContext();
    ctx.sessions.get.mockResolvedValue({
      session: existingSession,
      secret: { ...storedSecret, refreshToken: undefined },
    });

    await expect(
      oauth2DelegatedDeviceCodeSessionPlugin.refresh!(ctx, existingSession, new AbortController().signal),
    ).rejects.toThrow(/refresh token/i);
    expect(ctx.http.request).not.toHaveBeenCalled();
  });

  it('throws when the token endpoint rejects the refresh token', async () => {
    const ctx = createMockContext();
    ctx.sessions.get.mockResolvedValue({ session: existingSession, secret: storedSecret });
    ctx.http.request.mockResolvedValue(
      jsonResponse(400, { error: 'invalid_grant', error_description: 'Refresh token expired' }),
    );

    await expect(
      oauth2DelegatedDeviceCodeSessionPlugin.refresh!(ctx, existingSession, new AbortController().signal),
    ).rejects.toThrow(/refresh token expired/i);
  });
});

describe('oauth2DelegatedDeviceCodeSessionPlugin.test', () => {
  const baseSession: Session = {
    id: 'session-1',
    sessionTypeId: 'oauth2-delegated-device-code',
    label: 'Microsoft sign-in',
    createdByPluginId: 'app.easygroup.source.email-mail',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
  };

  it('reports "ok" when expiresAt is in the future', async () => {
    const ctx = createMockContext();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const result = await oauth2DelegatedDeviceCodeSessionPlugin.test(
      ctx,
      { ...baseSession, expiresAt: '2026-01-01T01:00:00.000Z' },
      new AbortController().signal,
    );
    expect(result).toBe('ok');
    vi.useRealTimers();
  });

  it('reports "expired" when expiresAt is in the past', async () => {
    const ctx = createMockContext();
    vi.setSystemTime(new Date('2026-01-01T02:00:00.000Z'));
    const result = await oauth2DelegatedDeviceCodeSessionPlugin.test(
      ctx,
      { ...baseSession, expiresAt: '2026-01-01T01:00:00.000Z' },
      new AbortController().signal,
    );
    expect(result).toBe('expired');
    vi.useRealTimers();
  });

  it('reports "error" when the session has no expiresAt at all', async () => {
    const ctx = createMockContext();
    const result = await oauth2DelegatedDeviceCodeSessionPlugin.test(
      ctx,
      { ...baseSession, expiresAt: undefined },
      new AbortController().signal,
    );
    expect(result).toBe('error');
  });
});
