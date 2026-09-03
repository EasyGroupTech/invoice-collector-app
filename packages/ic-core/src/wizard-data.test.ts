import type { PluginContext, SessionsApi, SourcePlugin, WizardListDataResult } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { resolveWizardListData } from './wizard-data.js';
import { createPluginRegistry } from './plugin-registry.js';

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
    manifest: { id: 'ic-email-to-downloads', name: 'Mail', version: '1.0.0', pluginApiVersion: '^1.0.0', kind: 'source', sbom: 's.json', main: 'i.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
    wizard: [],
    discover: async function* () {},
    fetchContent: vi.fn(),
    ...overrides,
  };
}

describe('resolveWizardListData', () => {
  it('calls the plugin\'s resolveListData with a ctx scoped to that plugin', async () => {
    const rows: WizardListDataResult['rows'] = [{ subject: 'Invoice #1' }];
    const resolveListData = vi.fn(async () => ({ rows }));
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin({ resolveListData }));

    const createPluginServicesSpy = vi.fn(pluginServices);
    const sessionsApiForPluginSpy = vi.fn(fakeSessionsApi);

    const result = await resolveWizardListData(
      { registry, createPluginServices: createPluginServicesSpy, sessionsApiForPlugin: sessionsApiForPluginSpy },
      'ic-email-to-downloads',
      { dataSource: 'mailPreview', fieldValues: { folder: 'Inbox' } },
      new AbortController().signal,
    );

    expect(result).toEqual({ rows });
    expect(createPluginServicesSpy).toHaveBeenCalledWith('ic-email-to-downloads');
    expect(sessionsApiForPluginSpy).toHaveBeenCalledWith('ic-email-to-downloads');
    expect(resolveListData).toHaveBeenCalledWith(
      expect.any(Object),
      { dataSource: 'mailPreview', fieldValues: { folder: 'Inbox' } },
      expect.any(AbortSignal),
    );
  });

  it('throws when the plugin is not registered', async () => {
    const registry = createPluginRegistry();

    await expect(
      resolveWizardListData(
        { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
        'unknown-plugin',
        { dataSource: 'mailPreview', fieldValues: {} },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Plugin "unknown-plugin" is not installed');
  });

  it('throws when the registered plugin has no resolveListData — an install-validation invariant, not a normal case', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin());

    await expect(
      resolveWizardListData(
        { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
        'ic-email-to-downloads',
        { dataSource: 'mailPreview', fieldValues: {} },
        new AbortController().signal,
      ),
    ).rejects.toThrow('Plugin "ic-email-to-downloads" has no resolveListData for dataSource "mailPreview"');
  });
});
