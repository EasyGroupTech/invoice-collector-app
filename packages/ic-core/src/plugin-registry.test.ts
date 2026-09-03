import type { DestinationPlugin, SourcePlugin } from 'invoice-collector-plugin-sdk';
import { describe, expect, it } from 'vitest';
import { createPluginRegistry } from './plugin-registry.js';

function fakeSourcePlugin(id: string): SourcePlugin {
  return {
    manifest: { id, name: id, version: '1.0.0', pluginApiVersion: '^1.0.0', kind: 'source', sbom: 'sbom.json', main: 'index.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
    wizard: [],
    discover: async function* () {},
    fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
  };
}

function fakeDestinationPlugin(id: string): DestinationPlugin {
  return {
    manifest: { id, name: id, version: '1.0.0', pluginApiVersion: '^1.0.0', kind: 'destination', sbom: 'sbom.json', main: 'index.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
    wizard: [],
    upload: async () => ({ status: 'uploaded' }),
  };
}

describe('PluginRegistry', () => {
  it('registers and retrieves a source plugin by id', () => {
    const registry = createPluginRegistry();
    const plugin = fakeSourcePlugin('app.easygroup.source.email-mail');
    registry.register(plugin);

    expect(registry.get('app.easygroup.source.email-mail')).toBe(plugin);
  });

  it('registers and retrieves a destination plugin by id', () => {
    const registry = createPluginRegistry();
    const plugin = fakeDestinationPlugin('app.easygroup.destination.local-downloads');
    registry.register(plugin);

    expect(registry.get('app.easygroup.destination.local-downloads')).toBe(plugin);
  });

  it('returns undefined for an unregistered id', () => {
    const registry = createPluginRegistry();
    expect(registry.get('does-not-exist')).toBeUndefined();
  });

  it('lists all registered plugins', () => {
    const registry = createPluginRegistry();
    const source = fakeSourcePlugin('source-1');
    const destination = fakeDestinationPlugin('destination-1');
    registry.register(source);
    registry.register(destination);

    expect(registry.list()).toEqual(expect.arrayContaining([source, destination]));
    expect(registry.list()).toHaveLength(2);
  });

  it('lists only source plugins', () => {
    const registry = createPluginRegistry();
    const source = fakeSourcePlugin('source-1');
    registry.register(source);
    registry.register(fakeDestinationPlugin('destination-1'));

    expect(registry.listSources()).toEqual([source]);
  });

  it('lists only destination plugins', () => {
    const registry = createPluginRegistry();
    const destination = fakeDestinationPlugin('destination-1');
    registry.register(fakeSourcePlugin('source-1'));
    registry.register(destination);

    expect(registry.listDestinations()).toEqual([destination]);
  });

  it('registering a plugin with an id already in use replaces the previous one (an update)', () => {
    const registry = createPluginRegistry();
    const v1 = fakeSourcePlugin('source-1');
    v1.manifest.version = '1.0.0';
    const v2 = fakeSourcePlugin('source-1');
    v2.manifest.version = '2.0.0';

    registry.register(v1);
    registry.register(v2);

    expect(registry.get('source-1')).toBe(v2);
    expect(registry.list()).toHaveLength(1);
  });

  it('unregister() removes a plugin by id', () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin('source-1'));

    registry.unregister('source-1');

    expect(registry.get('source-1')).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });
});
