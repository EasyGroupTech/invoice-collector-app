import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { HttpResponse, PluginContext, SessionCreateResult, SessionPlugin, SessionRefreshResult } from 'invoice-collector-plugin-sdk';
import { microsoftEntraDelegatedDeviceCodeSessionPlugin } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Encryptor } from './encryptor.js';
import * as sessionStoreModule from './session-store.js';
import type { SessionsFile } from './session-store.js';
import { createSessionsRegistry, type SessionsRegistry } from './sessions-registry.js';

// A trivial reversible fake — round-trip correctness is what these tests care about, not any
// specific cipher (that's Electron's safeStorage, wired in behind this interface later).
const fakeEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, 'utf-8'),
  decrypt: (ciphertext) => ciphertext.toString('utf-8'),
};

function stubPluginServices(_pluginId: string): Omit<PluginContext, 'sessions'> {
  return {
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    http: { request: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progress: { report: vi.fn() },
  };
}

const BUILT_IN_TYPE = 'microsoft-entra-delegated-device-code';
const CUSTOM_TYPE = 'aws-sigv4-keypair';

function jsonResponse(body: unknown): HttpResponse {
  return {
    status: 200,
    headers: {},
    json: () => body,
    text: () => JSON.stringify(body),
    arrayBuffer: () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  };
}

function fakeSessionPlugin(sessionTypeId: string, overrides: Partial<SessionPlugin> = {}): SessionPlugin {
  return {
    sessionTypeId,
    create: vi.fn(async (_ctx, input): Promise<SessionCreateResult> => ({
      label: (input as { label?: string })?.label ?? 'A session',
      secret: { token: 'initial-token' },
      expiresAt: undefined,
    })),
    test: vi.fn(async () => 'ok' as const),
    applyAuth: vi.fn((secret, request) => ({
      ...request,
      headers: { ...request.headers, Authorization: `Bearer ${(secret as { token: string }).token}` },
    })),
    ...overrides,
  };
}

describe('SessionsRegistry', () => {
  let dir: string;
  let filePath: string;
  let registry: SessionsRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-sessions-registry-'));
    filePath = path.join(dir, 'sessions.json');
    registry = createSessionsRegistry({
      filePath,
      encryptor: fakeEncryptor,
      createPluginServices: stubPluginServices,
    });
  });

  afterEach(async () => {
    registry.stopScheduler();
    await rm(dir, { recursive: true, force: true });
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('create() rejects a sessionTypeId with no registered SessionPlugin', async () => {
    const api = registry.forPlugin('ic-email-to-downloads');
    await expect(api.create('unknown-type', {})).rejects.toThrow(/no sessionplugin registered/i);
  });

  it('create() persists the session and returns it without exposing the secret', async () => {
    registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE));
    const api = registry.forPlugin('ic-email-to-downloads');

    const session = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

    expect(session.sessionTypeId).toBe(BUILT_IN_TYPE);
    expect(session.label).toBe('Mailbox sign-in');
    expect(session.createdByPluginId).toBe('ic-email-to-downloads');
    expect(session).not.toHaveProperty('secret');
    expect(session).not.toHaveProperty('secretCiphertext');
  });

  it('stores the secret encrypted at rest, not as plaintext JSON on disk', async () => {
    registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE));
    const api = registry.forPlugin('ic-email-to-downloads');
    await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

    const raw = await readFile(filePath, 'utf-8');
    expect(raw).not.toContain('initial-token');
  });

  it('get() returns the decrypted secret back to the creating plugin', async () => {
    registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE));
    const api = registry.forPlugin('ic-email-to-downloads');
    const created = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

    const fetched = await api.get(created.id);

    expect(fetched?.secret).toEqual({ token: 'initial-token' });
  });

  it('a built-in-typed session is visible to any plugin, not just its creator', async () => {
    registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE));
    const creator = registry.forPlugin('ic-email-to-downloads');
    const created = await creator.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

    const other = registry.forPlugin('some-other-plugin');
    expect(await other.list()).toEqual([created]);
    expect((await other.get(created.id))?.session).toEqual(created);
  });

  it('a custom-typed session is never visible to a different plugin', async () => {
    registry.registerSessionPlugin(fakeSessionPlugin(CUSTOM_TYPE));
    const creator = registry.forPlugin('commercial-aws-plugin');
    await creator.create(CUSTOM_TYPE, { label: 'AWS keys' });

    const other = registry.forPlugin('some-other-plugin');
    expect(await other.list()).toEqual([]);
  });

  it('list() can filter by sessionTypeId', async () => {
    registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE));
    registry.registerSessionPlugin(fakeSessionPlugin(CUSTOM_TYPE));
    const api = registry.forPlugin('ic-email-to-downloads');
    await api.create(BUILT_IN_TYPE, { label: 'A' });
    await api.create(CUSTOM_TYPE, { label: 'B' });

    const onlyBuiltIn = await api.list(BUILT_IN_TYPE);
    expect(onlyBuiltIn).toHaveLength(1);
    expect(onlyBuiltIn[0].sessionTypeId).toBe(BUILT_IN_TYPE);
  });

  it('reconnect() replays the original create() input and refreshes the stored secret', async () => {
    let call = 0;
    registry.registerSessionPlugin(
      fakeSessionPlugin(BUILT_IN_TYPE, {
        create: vi.fn(async (_ctx, input): Promise<SessionCreateResult> => {
          call += 1;
          return { label: (input as { label: string }).label, secret: { token: `token-${call}` } };
        }),
      }),
    );
    const api = registry.forPlugin('ic-email-to-downloads');
    const created = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });
    expect((await api.get(created.id))?.secret).toEqual({ token: 'token-1' });

    const reconnected = await api.reconnect(created.id);

    expect(reconnected.id).toBe(created.id);
    expect(reconnected.createdAt).toBe(created.createdAt);
    expect((await api.get(created.id))?.secret).toEqual({ token: 'token-2' });
  });

  it('reconnect() rejects a session id that is not visible to the calling plugin', async () => {
    registry.registerSessionPlugin(fakeSessionPlugin(CUSTOM_TYPE));
    const creator = registry.forPlugin('commercial-aws-plugin');
    const created = await creator.create(CUSTOM_TYPE, { label: 'AWS keys' });

    const other = registry.forPlugin('some-other-plugin');
    await expect(other.reconnect(created.id)).rejects.toThrow(/session not found/i);
  });

  describe('attachAuth (internal, used by HttpApi)', () => {
    it('resolves the session, decrypts its secret, and delegates to the SessionPlugin.applyAuth()', async () => {
      const plugin = fakeSessionPlugin(BUILT_IN_TYPE);
      registry.registerSessionPlugin(plugin);
      const api = registry.forPlugin('ic-email-to-downloads');
      const created = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      const request = await registry.attachAuth('ic-email-to-downloads', created.id, { url: 'https://example.com' });

      expect(request.headers).toEqual({ Authorization: 'Bearer initial-token' });
      expect(plugin.applyAuth).toHaveBeenCalledWith({ token: 'initial-token' }, { url: 'https://example.com' });
    });

    it('rejects a session id not visible to the calling plugin', async () => {
      registry.registerSessionPlugin(fakeSessionPlugin(CUSTOM_TYPE));
      const creator = registry.forPlugin('commercial-aws-plugin');
      const created = await creator.create(CUSTOM_TYPE, { label: 'AWS keys' });

      await expect(
        registry.attachAuth('some-other-plugin', created.id, { url: 'https://example.com' }),
      ).rejects.toThrow(/session not found/i);
    });
  });

  describe('recoverSession (internal, used by HttpApi on a 401)', () => {
    it('refreshes the session and returns the updated public Session', async () => {
      const refresh = vi.fn(async (): Promise<SessionRefreshResult> => ({ secret: { token: 'recovered-token' } }));
      registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE, { refresh }));
      const api = registry.forPlugin('ic-email-to-downloads');
      const created = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      const recovered = await registry.recoverSession('ic-email-to-downloads', created.id);

      expect(recovered.status).toBe('active');
      expect((await api.get(created.id))?.secret).toEqual({ token: 'recovered-token' });
    });

    it('persists needs-reconnect and throws when the refresh attempt itself fails', async () => {
      const refresh = vi.fn(async (): Promise<SessionRefreshResult> => {
        throw new Error('refresh token revoked');
      });
      registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE, { refresh }));
      const api = registry.forPlugin('ic-email-to-downloads');
      const created = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      await expect(registry.recoverSession('ic-email-to-downloads', created.id)).rejects.toThrow(/failed to refresh/i);
      expect((await api.get(created.id))?.session.status).toBe('needs-reconnect');
    });

    it('throws for a session type with no refresh() mechanism at all', async () => {
      registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE)); // no refresh
      const api = registry.forPlugin('ic-email-to-downloads');
      const created = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      await expect(registry.recoverSession('ic-email-to-downloads', created.id)).rejects.toThrow(/no refresh mechanism/i);
    });

    it('rejects a session id not visible to the calling plugin', async () => {
      registry.registerSessionPlugin(fakeSessionPlugin(CUSTOM_TYPE));
      const creator = registry.forPlugin('commercial-aws-plugin');
      const created = await creator.create(CUSTOM_TYPE, { label: 'AWS keys' });

      await expect(registry.recoverSession('some-other-plugin', created.id)).rejects.toThrow(/session not found/i);
    });
  });

  describe('proactive refresh scheduling', () => {
    // Real fs I/O (used by loadSessionsFile/saveSessionsFile elsewhere in this file's other
    // tests) doesn't resolve within vitest's fake-timer flush budget — confirmed empirically:
    // even a single real disk write inside a fake-timer callback silently drops the tick
    // entirely. An in-memory stand-in keeps persistence semantics (still round-trips through
    // JSON, still async) without the real-I/O timing hazard.
    let memory: SessionsFile;

    beforeEach(() => {
      vi.useFakeTimers();
      memory = { version: 1, sessions: [] };
      vi.spyOn(sessionStoreModule, 'loadSessionsFile').mockImplementation(async () => memory);
      vi.spyOn(sessionStoreModule, 'saveSessionsFile').mockImplementation(async (_filePath, file) => {
        memory = JSON.parse(JSON.stringify(file)) as SessionsFile;
      });
    });

    it('schedules a refresh ahead of expiresAt and applies the new secret/expiry', async () => {
      const refresh = vi.fn(
        async (): Promise<SessionRefreshResult> => ({
          secret: { token: 'refreshed-token' },
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      );
      registry.registerSessionPlugin(
        fakeSessionPlugin(BUILT_IN_TYPE, {
          create: vi.fn(
            async (): Promise<SessionCreateResult> => ({
              label: 'Mailbox sign-in',
              secret: { token: 'initial-token' },
              expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min out
            }),
          ),
          refresh,
        }),
      );
      const api = registry.forPlugin('ic-email-to-downloads');
      const created = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      // Default refresh margin is 5 min ahead of expiresAt (10 min out) => fires at ~5 min.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);

      expect(refresh).toHaveBeenCalledTimes(1);
      expect((await api.get(created.id))?.secret).toEqual({ token: 'refreshed-token' });
    });

    it('reschedules after a successful refresh using the new expiresAt', async () => {
      let refreshCount = 0;
      const refresh = vi.fn(async (): Promise<SessionRefreshResult> => {
        refreshCount += 1;
        return { secret: { token: `token-${refreshCount}` }, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() };
      });
      registry.registerSessionPlugin(
        fakeSessionPlugin(BUILT_IN_TYPE, {
          create: vi.fn(
            async (): Promise<SessionCreateResult> => ({
              label: 'Mailbox sign-in',
              secret: { token: 'initial-token' },
              expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            }),
          ),
          refresh,
        }),
      );
      const api = registry.forPlugin('ic-email-to-downloads');
      await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      // One consolidated advance covering both refreshes — splitting this into two separate
      // advanceTimersByTimeAsync calls is unreliable here: the refresh path's real fs I/O
      // (saveSessionsFile) doesn't always settle within a single call's flush before it returns,
      // so the reschedule set up by the first refresh can be missed by a second, separate call.
      await vi.advanceTimersByTimeAsync(12 * 60 * 1000);

      expect(refresh).toHaveBeenCalledTimes(2);
    });

    it('marks the session needs-reconnect on refresh failure and stops rescheduling it', async () => {
      const refresh = vi.fn(async (): Promise<SessionRefreshResult> => {
        throw new Error('refresh token revoked');
      });
      registry.registerSessionPlugin(
        fakeSessionPlugin(BUILT_IN_TYPE, {
          create: vi.fn(
            async (): Promise<SessionCreateResult> => ({
              label: 'Mailbox sign-in',
              secret: { token: 'initial-token' },
              expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            }),
          ),
          refresh,
        }),
      );
      const api = registry.forPlugin('ic-email-to-downloads');
      const created = await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
      expect((await api.get(created.id))?.session.status).toBe('needs-reconnect');

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(refresh).toHaveBeenCalledTimes(1); // no further attempts scheduled
    });

    it('does not schedule anything for a SessionPlugin with no refresh()', async () => {
      registry.registerSessionPlugin(fakeSessionPlugin(BUILT_IN_TYPE)); // no refresh
      const api = registry.forPlugin('ic-email-to-downloads');
      await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      // Nothing to assert on directly beyond "this doesn't throw" — absence of a refresh() means
      // there's no timer to have fired in the first place.
    });

    it('honors keepAliveIntervalMs, calling refresh() repeatedly on that cadence', async () => {
      const refresh = vi.fn(async (): Promise<SessionRefreshResult> => ({ secret: { token: 'still-alive' } }));
      registry.registerSessionPlugin(
        fakeSessionPlugin(BUILT_IN_TYPE, {
          create: vi.fn(
            async (): Promise<SessionCreateResult> => ({
              label: 'Captured session',
              secret: { token: 'initial-token' },
              keepAliveIntervalMs: 60_000,
            }),
          ),
          refresh,
        }),
      );
      const api = registry.forPlugin('ic-email-to-downloads');
      await api.create(BUILT_IN_TYPE, { label: 'Captured session' });

      // One consolidated advance, same reasoning as the reschedule test above.
      await vi.advanceTimersByTimeAsync(60_000 * 3 + 1000);

      expect(refresh).toHaveBeenCalledTimes(3);
    });

    it('startScheduler() resumes scheduling for sessions persisted by an earlier registry instance', async () => {
      const refresh = vi.fn(async (): Promise<SessionRefreshResult> => ({ secret: { token: 'refreshed' } }));
      const plugin = fakeSessionPlugin(BUILT_IN_TYPE, {
        create: vi.fn(
          async (): Promise<SessionCreateResult> => ({
            label: 'Mailbox sign-in',
            secret: { token: 'initial-token' },
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          }),
        ),
        refresh,
      });

      registry.registerSessionPlugin(plugin);
      await registry.forPlugin('ic-email-to-downloads').create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });
      registry.stopScheduler();

      const reopened = createSessionsRegistry({ filePath, encryptor: fakeEncryptor, createPluginServices: stubPluginServices });
      reopened.registerSessionPlugin(plugin);
      await reopened.startScheduler();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000);
      expect(refresh).toHaveBeenCalledTimes(1);
      reopened.stopScheduler();
    });

    it('stopScheduler() cancels pending timers so no further refresh fires', async () => {
      const refresh = vi.fn(async (): Promise<SessionRefreshResult> => ({ secret: { token: 'refreshed' } }));
      registry.registerSessionPlugin(
        fakeSessionPlugin(BUILT_IN_TYPE, {
          create: vi.fn(
            async (): Promise<SessionCreateResult> => ({
              label: 'Mailbox sign-in',
              secret: { token: 'initial-token' },
              expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            }),
          ),
          refresh,
        }),
      );
      const api = registry.forPlugin('ic-email-to-downloads');
      await api.create(BUILT_IN_TYPE, { label: 'Mailbox sign-in' });

      registry.stopScheduler();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

      expect(refresh).not.toHaveBeenCalled();
    });
  });

  describe('integration: the real SDK built-in', () => {
    it('creates a session end-to-end through microsoftEntraDelegatedDeviceCodeSessionPlugin against a mocked token endpoint', async () => {
      const httpRequest = vi.fn(async (input: { url: string }) => {
        if (input.url === 'https://example.com/device') {
          return jsonResponse({
            device_code: 'dc',
            user_code: 'UC-1',
            verification_uri: 'https://example.com/verify',
            expires_in: 600,
            interval: 0,
          });
        }
        if (input.url === 'https://example.com/token') {
          return jsonResponse({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer' });
        }
        throw new Error(`unexpected request to ${input.url}`);
      });

      const integrationRegistry = createSessionsRegistry({
        filePath,
        encryptor: fakeEncryptor,
        createPluginServices: () => ({
          storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
          http: { request: httpRequest },
          log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          progress: { report: vi.fn() },
        }),
      });
      integrationRegistry.registerSessionPlugin(microsoftEntraDelegatedDeviceCodeSessionPlugin);

      const api = integrationRegistry.forPlugin('ic-email-to-downloads');
      const session = await api.create(BUILT_IN_TYPE, {
        deviceAuthorizationEndpoint: 'https://example.com/device',
        tokenEndpoint: 'https://example.com/token',
        clientId: 'client-1',
        scope: 'Mail.Read',
        label: 'Mailbox sign-in',
      });

      expect(session.label).toBe('Mailbox sign-in');
      expect((await api.get(session.id))?.secret).toMatchObject({ accessToken: 'at-1', refreshToken: 'rt-1' });

      integrationRegistry.stopScheduler();
    });
  });
});
