import type { PluginContext, Session, SessionsApi, SourcePlugin } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createPluginRegistry } from './plugin-registry.js';
import { suggestWizardValues } from './wizard-value-suggest.js';

function pluginServices(): Omit<PluginContext, 'sessions'> {
  return {
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
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
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
    wizard: [],
    discover: async function* () {},
    fetchContent: vi.fn(),
    ...overrides,
  };
}

function fakeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    sessionTypeId: 'browser-captured-session',
    label: 'Claude Team sign-in',
    createdByPluginId: 'ic-email-to-downloads',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

describe('suggestWizardValues', () => {
  it("calls the plugin's suggestWizardValues with a ctx scoped to that plugin, returning its suggestion", async () => {
    const suggest = vi.fn(async () => ({ orgId: 'a1b2c3-org' }));
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin({ suggestWizardValues: suggest }), 'test-package');
    const session = fakeSession();

    const createPluginServicesSpy = vi.fn(pluginServices);
    const sessionsApiForPluginSpy = vi.fn(fakeSessionsApi);

    const result = await suggestWizardValues(
      { registry, createPluginServices: createPluginServicesSpy, sessionsApiForPlugin: sessionsApiForPluginSpy },
      'ic-email-to-downloads',
      session,
      new AbortController().signal,
    );

    expect(result).toEqual({ orgId: 'a1b2c3-org' });
    expect(createPluginServicesSpy).toHaveBeenCalledWith('ic-email-to-downloads');
    expect(sessionsApiForPluginSpy).toHaveBeenCalledWith('ic-email-to-downloads');
    expect(suggest).toHaveBeenCalledWith(expect.any(Object), session, expect.any(AbortSignal));
  });

  it('returns undefined (not a throw) when the plugin has no suggestWizardValues at all', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin(), 'test-package');

    const result = await suggestWizardValues(
      { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      'ic-email-to-downloads',
      fakeSession(),
      new AbortController().signal,
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined (not a throw) when the plugin is not registered', async () => {
    const registry = createPluginRegistry();

    const result = await suggestWizardValues(
      { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      'unknown-plugin',
      fakeSession(),
      new AbortController().signal,
    );

    expect(result).toBeUndefined();
  });

  it('returns undefined (not a throw) when the hook itself throws — a suggestion never blocks the wizard', async () => {
    const registry = createPluginRegistry();
    registry.register(
      fakeSourcePlugin({
        suggestWizardValues: vi.fn(async () => {
          throw new Error('could not read stored secret');
        }),
      }),
      'test-package',
    );

    const result = await suggestWizardValues(
      { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      'ic-email-to-downloads',
      fakeSession(),
      new AbortController().signal,
    );

    expect(result).toBeUndefined();
  });
});
