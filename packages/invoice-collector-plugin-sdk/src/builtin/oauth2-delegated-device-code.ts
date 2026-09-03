import type { PluginContext } from '../context.js';
import type { Session, SessionCreateResult, SessionPlugin, SessionRefreshResult } from '../session.js';

/**
 * OAuth2 device authorization grant (RFC 8628). Microsoft Entra-based today — both the Azure ARM
 * "Login" connection method and Microsoft Graph delegated sign-in (Graph Mail, SharePoint) use
 * this exact mechanism, differing only in which scope they request — but not Microsoft-specific
 * by design: a plugin supplies its own endpoint URLs, so any provider implementing the same RFC
 * works too (§6.1).
 */

export interface OAuth2DelegatedDeviceCodeCreateInput {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
}

export interface OAuth2DelegatedDeviceCodeSecret {
  accessToken: string;
  refreshToken?: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  scope: string;
}

interface DeviceAuthorizationResponseBody {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

interface TokenSuccessResponseBody {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
}

interface TokenErrorResponseBody {
  error: string;
  error_description?: string;
}

const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };

function isCreateInput(input: unknown): input is OAuth2DelegatedDeviceCodeCreateInput {
  if (typeof input !== 'object' || input === null) return false;
  const i = input as Record<string, unknown>;
  return (
    typeof i.deviceAuthorizationEndpoint === 'string' &&
    typeof i.tokenEndpoint === 'string' &&
    typeof i.clientId === 'string' &&
    typeof i.scope === 'string'
  );
}

function isStoredSecret(secret: unknown): secret is OAuth2DelegatedDeviceCodeSecret {
  if (typeof secret !== 'object' || secret === null) return false;
  const s = secret as Record<string, unknown>;
  return typeof s.accessToken === 'string' && typeof s.tokenEndpoint === 'string' && typeof s.clientId === 'string';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Device code sign-in was cancelled'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Device code sign-in was cancelled'));
      },
      { once: true },
    );
  });
}

function expiresAtFrom(expiresInSeconds: number): string {
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

async function requestDeviceAuthorization(
  ctx: PluginContext,
  input: OAuth2DelegatedDeviceCodeCreateInput,
  signal: AbortSignal,
): Promise<DeviceAuthorizationResponseBody> {
  const response = await ctx.http.request(
    {
      url: input.deviceAuthorizationEndpoint,
      method: 'POST',
      headers: FORM_HEADERS,
      body: new URLSearchParams({ client_id: input.clientId, scope: input.scope }).toString(),
    },
    signal,
  );
  if (response.status !== 200) {
    throw new Error(`Device authorization request failed with status ${response.status}`);
  }
  return response.json() as DeviceAuthorizationResponseBody;
}

async function pollForToken(
  ctx: PluginContext,
  tokenEndpoint: string,
  clientId: string,
  deviceCode: string,
  initialIntervalSeconds: number,
  expiresInSeconds: number,
  signal: AbortSignal,
): Promise<TokenSuccessResponseBody> {
  let intervalSeconds = initialIntervalSeconds;
  const deadline = Date.now() + expiresInSeconds * 1000;

  for (;;) {
    if (Date.now() > deadline) {
      throw new Error('Device code expired before sign-in completed');
    }

    await sleep(intervalSeconds * 1000, signal);

    const response = await ctx.http.request(
      {
        url: tokenEndpoint,
        method: 'POST',
        headers: FORM_HEADERS,
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: clientId,
        }).toString(),
      },
      signal,
    );

    if (response.status === 200) {
      return response.json() as TokenSuccessResponseBody;
    }

    const body = response.json() as TokenErrorResponseBody;
    switch (body.error) {
      case 'authorization_pending':
        continue;
      case 'slow_down':
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
        continue;
      case 'expired_token':
        throw new Error('Device code expired before sign-in completed');
      case 'access_denied':
        throw new Error('Sign-in was declined');
      default:
        throw new Error(body.error_description ?? body.error ?? 'Device code sign-in failed');
    }
  }
}

export const oauth2DelegatedDeviceCodeSessionPlugin: SessionPlugin = {
  sessionTypeId: 'oauth2-delegated-device-code',

  async create(ctx, input, signal): Promise<SessionCreateResult> {
    if (!isCreateInput(input)) {
      throw new Error(
        'oauth2-delegated-device-code requires { deviceAuthorizationEndpoint, tokenEndpoint, clientId, scope }',
      );
    }

    const authorization = await requestDeviceAuthorization(ctx, input, signal);

    ctx.progress.report('Sign in required', {
      userCode: authorization.user_code,
      verificationUri: authorization.verification_uri,
      verificationUriComplete: authorization.verification_uri_complete,
    });

    const token = await pollForToken(
      ctx,
      input.tokenEndpoint,
      input.clientId,
      authorization.device_code,
      authorization.interval ?? DEFAULT_POLL_INTERVAL_SECONDS,
      authorization.expires_in,
      signal,
    );

    const secret: OAuth2DelegatedDeviceCodeSecret = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      deviceAuthorizationEndpoint: input.deviceAuthorizationEndpoint,
      tokenEndpoint: input.tokenEndpoint,
      clientId: input.clientId,
      scope: input.scope,
    };

    return {
      label: 'Microsoft sign-in',
      secret,
      expiresAt: expiresAtFrom(token.expires_in),
    };
  },

  async refresh(ctx, session, signal): Promise<SessionRefreshResult> {
    const stored = await ctx.sessions.get(session.id);
    if (!stored || !isStoredSecret(stored.secret)) {
      throw new Error(`No stored secret found for session ${session.id}`);
    }
    const secret = stored.secret;
    if (!secret.refreshToken) {
      throw new Error('This session has no refresh token — it can only be renewed via Reconnect');
    }

    const response = await ctx.http.request(
      {
        url: secret.tokenEndpoint,
        method: 'POST',
        headers: FORM_HEADERS,
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: secret.refreshToken,
          client_id: secret.clientId,
          scope: secret.scope,
        }).toString(),
      },
      signal,
    );

    if (response.status !== 200) {
      const body = response.json() as TokenErrorResponseBody;
      throw new Error(body.error_description ?? body.error ?? `Refresh failed with status ${response.status}`);
    }

    const token = response.json() as TokenSuccessResponseBody;
    const newSecret: OAuth2DelegatedDeviceCodeSecret = {
      ...secret,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? secret.refreshToken,
    };

    return {
      secret: newSecret,
      expiresAt: expiresAtFrom(token.expires_in),
    };
  },

  // `ctx`/`signal` aren't needed here — this session type has no fixed endpoint to ping across
  // every possible scope/resource, so the honest generic check is purely time-based against the
  // session's own expiresAt, set by create()/refresh() above.
  async test(_ctx: PluginContext, session: Session, _signal: AbortSignal): Promise<'ok' | 'expired' | 'error'> {
    if (!session.expiresAt) {
      return 'error';
    }
    return new Date(session.expiresAt).getTime() > Date.now() ? 'ok' : 'expired';
  },
};
