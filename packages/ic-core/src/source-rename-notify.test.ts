import type { DestinationPlugin, PluginContext, PluginDestinationRecord, SessionsApi } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { createPluginRegistry } from './plugin-registry.js';
import { notifySourceRenamed } from './source-rename-notify.js';

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

function fakeDestinationPlugin(overrides: Partial<DestinationPlugin> = {}): DestinationPlugin {
  return {
    manifest: { id: 'app.easygroup.destination.local-folder', name: 'Local Folder', kind: 'destination', main: 'i.js' },
    sessionRequirements: [{ sessionTypeId: 'folder-access', confirmsBuiltIn: false, requiredScopesOrRoles: [], collects: 'test', connectHow: 'test', connectInstructions: 'test' }],
    wizard: [],
    upload: vi.fn(),
    ...overrides,
  };
}

function fakeRecord(overrides: Partial<PluginDestinationRecord> = {}): PluginDestinationRecord {
  return {
    id: 'destination-1',
    name: 'My Downloads',
    pluginId: 'app.easygroup.destination.local-folder',
    pluginVersion: '0.0.0',
    sessionId: 'session-1',
    config: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('notifySourceRenamed', () => {
  it("calls the destination plugin's onSourceRenamed with a ctx scoped to that plugin, the record, and both names", async () => {
    const onSourceRenamed = vi.fn(async () => undefined);
    const registry = createPluginRegistry();
    registry.register(fakeDestinationPlugin({ onSourceRenamed }), 'test-package');
    const record = fakeRecord();

    const createPluginServicesSpy = vi.fn(pluginServices);
    const sessionsApiForPluginSpy = vi.fn(fakeSessionsApi);

    await notifySourceRenamed(
      { registry, createPluginServices: createPluginServicesSpy, sessionsApiForPlugin: sessionsApiForPluginSpy },
      'app.easygroup.destination.local-folder',
      record,
      'Old Name',
      'New Name',
      new AbortController().signal,
    );

    expect(createPluginServicesSpy).toHaveBeenCalledWith('app.easygroup.destination.local-folder');
    expect(sessionsApiForPluginSpy).toHaveBeenCalledWith('app.easygroup.destination.local-folder');
    expect(onSourceRenamed).toHaveBeenCalledWith(expect.any(Object), record, 'Old Name', 'New Name', expect.any(AbortSignal));
  });

  it("hands the hook's own locationRewrite straight back up to the caller — invoice-history is core's concern, not this orchestrator's", async () => {
    const locationRewrite = (old: string) => old.replace('/Old Name/', '/New Name/');
    const registry = createPluginRegistry();
    registry.register(fakeDestinationPlugin({ onSourceRenamed: vi.fn(async () => ({ locationRewrite })) }), 'test-package');

    const result = await notifySourceRenamed(
      { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      'app.easygroup.destination.local-folder',
      fakeRecord(),
      'Old Name',
      'New Name',
      new AbortController().signal,
    );

    expect(result?.locationRewrite).toBe(locationRewrite);
  });

  it('does nothing (no throw) when the plugin has no onSourceRenamed at all', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeDestinationPlugin(), 'test-package');

    await expect(
      notifySourceRenamed(
        { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
        'app.easygroup.destination.local-folder',
        fakeRecord(),
        'Old Name',
        'New Name',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('does nothing (no throw) when the plugin is not registered', async () => {
    const registry = createPluginRegistry();

    await expect(
      notifySourceRenamed(
        { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
        'unknown-plugin',
        fakeRecord(),
        'Old Name',
        'New Name',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });

  it('swallows a throw from the hook itself — a failed rename attempt never blocks or surfaces as an error', async () => {
    const registry = createPluginRegistry();
    registry.register(
      fakeDestinationPlugin({
        onSourceRenamed: vi.fn(async () => {
          throw new Error('permission denied');
        }),
      }),
      'test-package',
    );

    await expect(
      notifySourceRenamed(
        { registry, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
        'app.easygroup.destination.local-folder',
        fakeRecord(),
        'Old Name',
        'New Name',
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
  });
});
