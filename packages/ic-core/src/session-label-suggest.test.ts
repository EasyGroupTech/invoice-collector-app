import type { PluginContext, Session, SessionsApi, SourcePlugin } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createPluginRegistry } from './plugin-registry.js';
import { suggestSessionLabel } from './session-label-suggest.js';

function pluginServices(): Omit<PluginContext, 'sessions'> {
  return {
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    appStorage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    http: { request: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progress: { report: vi.fn() },
  };
}

function fakeSessionsApi(): SessionsApi {
  return { list: vi.fn(async () => []), get: vi.fn(async () => undefined), create: vi.fn(), reconnect: vi.fn() } as unknown as SessionsApi;
}

function fakeSourcePlugin(overrides: Partial<SourcePlugin> = {}): SourcePlugin {
  return {
    manifest: { id: 'ic-email-to-downloads', name: 'Mail', kind: 'source', main: 'i.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [], collects: 'test', connectHow: 'test', connectInstructions: 'test' }],
    wizard: [],
    discover: async function* () {},
    fetchContent: vi.fn(),
    ...overrides,
  };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    sessionTypeId: 'microsoft-entra-delegated-device-code',
    label: 'Microsoft 365 sign-in',
    createdByPluginId: 'ic-email-to-downloads',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

describe('suggestSessionLabel', () => {
  it("calls the plugin's suggestSessionLabel with a ctx scoped to that plugin, returning its suggestion", async () => {
    const suggest = vi.fn(async () => 'contoso.com');
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin({ suggestSessionLabel: suggest }), 'test-package');
    const session = fakeSession();

    const createPluginServicesSpy = vi.fn(pluginServices);
    const sessionsApiForPluginSpy = vi.fn(fakeSessionsApi);

    const result = await suggestSessionLabel(
      { registry, createPluginServices: createPluginServicesSpy, sessionsApiForPlugin: sessionsApiForPluginSpy },
      'ic-email-to-downloads',
      session,
      new AbortController().signal,
    );

    expect(result).toBe('contoso.com');
    expect(createPluginServicesSpy).toHaveBeenCalledWith('ic-email-to-downloads');
    expect(sessionsApiForPluginSpy).toHaveBeenCalledWith('ic-email-to-downloads');
    expect(suggest).toHaveBeenCalledWith(expect.any(Object), session, expect.any(AbortSignal));
  });

  it('returns undefined (not a throw) when the plugin has no suggestSessionLabel at all', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin(), 'test-package');

    const result = await suggestSessionLabel(
      { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      'ic-email-to-downloads',
      fakeSession(),
      new AbortController().signal,
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined (not a throw) when the plugin is not registered', async () => {
    const registry = createPluginRegistry();

    const result = await suggestSessionLabel(
      { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      'unknown-plugin',
      fakeSession(),
      new AbortController().signal,
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined (not a throw) when the hook itself throws — a suggestion never blocks session usability', async () => {
    const registry = createPluginRegistry();
    registry.register(
      fakeSourcePlugin({
        suggestSessionLabel: vi.fn(async () => {
          throw new Error('graph call failed');
        }),
      }),
      'test-package',
    );

    const result = await suggestSessionLabel(
      { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      'ic-email-to-downloads',
      fakeSession(),
      new AbortController().signal,
    );

    expect(result).toBeUndefined();
  });
});
