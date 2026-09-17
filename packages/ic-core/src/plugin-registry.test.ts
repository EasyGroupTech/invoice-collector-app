import type { DestinationPlugin, PluginManifest, SourcePlugin } from 'invoice-collector-plugin-sdk';
import { describe, expect, it } from 'vitest';
import { createPluginRegistry } from './plugin-registry.js';

function fakeSourcePlugin(id: string): SourcePlugin {
  return {
    manifest: { id, name: id, kind: 'source', main: 'index.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [], collects: 'test', connectHow: 'test', connectInstructions: 'test' }],
    wizard: [],
    discover: async function* () {},
    fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
  };
}

function fakeDestinationPlugin(id: string): DestinationPlugin {
  return {
    manifest: { id, name: id, kind: 'destination', main: 'index.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [], collects: 'test', connectHow: 'test', connectInstructions: 'test' }],
    wizard: [],
    upload: async () => ({ status: 'uploaded' }),
  };
}

function fakePackageManifest(id: string, implementations: PluginManifest['implementations'] = []): PluginManifest {
  return { id, name: id, version: '1.0.0', pluginApiVersion: '^1.0.0', sbom: 'sbom.cdx.json', implementations };
}

describe('PluginRegistry', () => {
  it('registers and retrieves a source plugin by id', () => {
    const registry = createPluginRegistry();
    const plugin = fakeSourcePlugin('app.easygroup.source.email-mail');
    registry.register(plugin, 'test-package');

    expect(registry.get('app.easygroup.source.email-mail')).toBe(plugin);
  });

  it('registers and retrieves a destination plugin by id', () => {
    const registry = createPluginRegistry();
    const plugin = fakeDestinationPlugin('app.easygroup.destination.local-downloads');
    registry.register(plugin, 'test-package');

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
    registry.register(source, 'test-package');
    registry.register(destination, 'test-package');

    expect(registry.list()).toEqual(expect.arrayContaining([source, destination]));
    expect(registry.list()).toHaveLength(2);
  });

  it('lists only source plugins', () => {
    const registry = createPluginRegistry();
    const source = fakeSourcePlugin('source-1');
    registry.register(source, 'test-package');
    registry.register(fakeDestinationPlugin('destination-1'), 'test-package');

    expect(registry.listSources()).toEqual([source]);
  });

  it('lists only destination plugins', () => {
    const registry = createPluginRegistry();
    const destination = fakeDestinationPlugin('destination-1');
    registry.register(fakeSourcePlugin('source-1'), 'test-package');
    registry.register(destination, 'test-package');

    expect(registry.listDestinations()).toEqual([destination]);
  });

  it('registering a plugin with an id already in use replaces the previous one (an update)', () => {
    const registry = createPluginRegistry();
    const v1 = fakeSourcePlugin('source-1');
    const v2 = fakeSourcePlugin('source-1');

    registry.register(v1, 'test-package');
    registry.register(v2, 'test-package');

    expect(registry.get('source-1')).toBe(v2);
    expect(registry.list()).toHaveLength(1);
  });

  it('unregister() removes a plugin by id', () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin('source-1'), 'test-package');

    registry.unregister('source-1');

    expect(registry.get('source-1')).toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });

  describe('package-level tracking (§9.4)', () => {
    it('registers and retrieves a package manifest by id', () => {
      const registry = createPluginRegistry();
      const manifest = fakePackageManifest('app.easygroup.email-to-downloads');
      registry.registerPackage(manifest);

      expect(registry.getPackage('app.easygroup.email-to-downloads')).toBe(manifest);
    });

    it('returns undefined for an unregistered package id', () => {
      const registry = createPluginRegistry();
      expect(registry.getPackage('does-not-exist')).toBeUndefined();
    });

    it('lists every registered package', () => {
      const registry = createPluginRegistry();
      const a = fakePackageManifest('package-a');
      const b = fakePackageManifest('package-b');
      registry.registerPackage(a);
      registry.registerPackage(b);

      expect(registry.listPackages()).toEqual(expect.arrayContaining([a, b]));
      expect(registry.listPackages()).toHaveLength(2);
    });

    it('unregisterPackage() removes a package by id, independent of the flat implementation registry', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('package-a'));
      registry.register(fakeSourcePlugin('source-1'), 'test-package');

      registry.unregisterPackage('package-a');

      expect(registry.getPackage('package-a')).toBeUndefined();
      expect(registry.get('source-1')).toBeDefined();
    });

    it('registering a package with an id already in use replaces the previous one', () => {
      const registry = createPluginRegistry();
      const v1 = fakePackageManifest('package-a');
      const v2 = fakePackageManifest('package-a');

      registry.registerPackage(v1);
      registry.registerPackage(v2);

      expect(registry.getPackage('package-a')).toBe(v2);
      expect(registry.listPackages()).toHaveLength(1);
    });

    it('a package manifest can bundle more than one implementation', () => {
      const registry = createPluginRegistry();
      const manifest = fakePackageManifest('app.easygroup.email-to-downloads', [
        { id: 'app.easygroup.source.email-mail', name: 'Graph Mail', kind: 'source', main: 'index.js' },
        { id: 'app.easygroup.destination.local-folder', name: 'Local Folder', kind: 'destination', main: 'local-folder-plugin.js' },
      ]);
      registry.registerPackage(manifest);

      expect(registry.getPackage('app.easygroup.email-to-downloads')?.implementations).toHaveLength(2);
    });
  });

  describe('getInstallUrl (§9.1, PluginContext.installUrl)', () => {
    it('resolves an implementation back to its own package\'s install URL', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('plugin-azure-billing'), 'https://cdn.example.com/plugin-azure-billing?e=abc123');
      registry.register(fakeSourcePlugin('tech.easygroup.source.azure-billing'), 'plugin-azure-billing');

      expect(registry.getInstallUrl('tech.easygroup.source.azure-billing')).toBe('https://cdn.example.com/plugin-azure-billing?e=abc123');
    });

    it('is undefined for an implementation whose package was registered with no installUrl', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('app.easygroup.email-to-downloads'));
      registry.register(fakeSourcePlugin('app.easygroup.source.email-mail'), 'app.easygroup.email-to-downloads');

      expect(registry.getInstallUrl('app.easygroup.source.email-mail')).toBeUndefined();
    });

    it('is undefined for an implementation id that was never registered', () => {
      const registry = createPluginRegistry();
      expect(registry.getInstallUrl('does-not-exist')).toBeUndefined();
    });

    it('two implementations bundled in the same package share that one package\'s install URL', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('plugin-browser-session-claude'), 'https://cdn.example.com/plugin-browser-session-claude?e=xyz');
      registry.register(fakeSourcePlugin('tech.easygroup.source.claude-team'), 'plugin-browser-session-claude');
      registry.register(fakeSourcePlugin('tech.easygroup.source.claude-api'), 'plugin-browser-session-claude');

      expect(registry.getInstallUrl('tech.easygroup.source.claude-team')).toBe('https://cdn.example.com/plugin-browser-session-claude?e=xyz');
      expect(registry.getInstallUrl('tech.easygroup.source.claude-api')).toBe('https://cdn.example.com/plugin-browser-session-claude?e=xyz');
    });

    it('unregistering the package clears its install URL for every implementation that referenced it', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('plugin-azure-billing'), 'https://cdn.example.com/plugin-azure-billing?e=abc123');
      registry.register(fakeSourcePlugin('tech.easygroup.source.azure-billing'), 'plugin-azure-billing');

      registry.unregisterPackage('plugin-azure-billing');

      expect(registry.getInstallUrl('tech.easygroup.source.azure-billing')).toBeUndefined();
    });

    it('re-registering a package without an installUrl clears any previously stored one (an update with no URL)', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('plugin-azure-billing'), 'https://cdn.example.com/plugin-azure-billing?e=abc123');
      registry.register(fakeSourcePlugin('tech.easygroup.source.azure-billing'), 'plugin-azure-billing');

      registry.registerPackage(fakePackageManifest('plugin-azure-billing'));

      expect(registry.getInstallUrl('tech.easygroup.source.azure-billing')).toBeUndefined();
    });
  });

  describe('getPackageId (§6\'s downloadableAsset — resolving an installed package\'s own on-disk directory)', () => {
    it('resolves an implementation back to its own package id', () => {
      const registry = createPluginRegistry();
      registry.register(fakeSourcePlugin('tech.easygroup.source.azure-billing'), 'plugin-azure-billing');

      expect(registry.getPackageId('tech.easygroup.source.azure-billing')).toBe('plugin-azure-billing');
    });

    it('is undefined for an implementation id that was never registered', () => {
      const registry = createPluginRegistry();
      expect(registry.getPackageId('does-not-exist')).toBeUndefined();
    });

    it('unregistering the implementation clears its package id too', () => {
      const registry = createPluginRegistry();
      registry.register(fakeSourcePlugin('tech.easygroup.source.azure-billing'), 'plugin-azure-billing');

      registry.unregister('tech.easygroup.source.azure-billing');

      expect(registry.getPackageId('tech.easygroup.source.azure-billing')).toBeUndefined();
    });
  });

  describe('siblingImplementationIds (§9.1/§15 activation fan-out)', () => {
    it('returns just the one implementation for a single-implementation package', () => {
      const registry = createPluginRegistry();
      registry.register(fakeSourcePlugin('tech.easygroup.source.azure-billing'), 'plugin-azure-billing');

      expect(registry.siblingImplementationIds('tech.easygroup.source.azure-billing')).toEqual(['tech.easygroup.source.azure-billing']);
    });

    it('returns every implementation bundled in the same package, including the one asked about', () => {
      const registry = createPluginRegistry();
      registry.register(fakeSourcePlugin('tech.easygroup.source.claude-team'), 'plugin-browser-session-claude');
      registry.register(fakeSourcePlugin('tech.easygroup.source.claude-api'), 'plugin-browser-session-claude');

      expect(registry.siblingImplementationIds('tech.easygroup.source.claude-team')).toEqual(
        expect.arrayContaining(['tech.easygroup.source.claude-team', 'tech.easygroup.source.claude-api']),
      );
      expect(registry.siblingImplementationIds('tech.easygroup.source.claude-api')).toEqual(
        expect.arrayContaining(['tech.easygroup.source.claude-team', 'tech.easygroup.source.claude-api']),
      );
    });

    it('does not pull in an implementation from a different package', () => {
      const registry = createPluginRegistry();
      registry.register(fakeSourcePlugin('tech.easygroup.source.claude-team'), 'plugin-browser-session-claude');
      registry.register(fakeSourcePlugin('tech.easygroup.source.aws-invoicing'), 'plugin-browser-session-aws');

      expect(registry.siblingImplementationIds('tech.easygroup.source.claude-team')).toEqual(['tech.easygroup.source.claude-team']);
    });

    it('falls back to just the given id for an implementation that was never registered', () => {
      const registry = createPluginRegistry();
      expect(registry.siblingImplementationIds('does-not-exist')).toEqual(['does-not-exist']);
    });
  });

  describe('setPackageEnabled/isPackageEnabled (phase 1.20)', () => {
    it('defaults to enabled for a package that was never told otherwise', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('plugin-azure-billing'));

      expect(registry.isPackageEnabled('plugin-azure-billing')).toBe(true);
    });

    it('reports disabled after setPackageEnabled(id, false), and enabled again after setPackageEnabled(id, true)', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('plugin-azure-billing'));

      registry.setPackageEnabled('plugin-azure-billing', false);
      expect(registry.isPackageEnabled('plugin-azure-billing')).toBe(false);

      registry.setPackageEnabled('plugin-azure-billing', true);
      expect(registry.isPackageEnabled('plugin-azure-billing')).toBe(true);
    });

    it('disabling one package never affects another', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('plugin-azure-billing'));
      registry.registerPackage(fakePackageManifest('plugin-sharepoint-destination'));

      registry.setPackageEnabled('plugin-azure-billing', false);

      expect(registry.isPackageEnabled('plugin-azure-billing')).toBe(false);
      expect(registry.isPackageEnabled('plugin-sharepoint-destination')).toBe(true);
    });

    it('unregisterPackage clears the disabled flag too, so a later reinstall of the same id starts enabled', () => {
      const registry = createPluginRegistry();
      registry.registerPackage(fakePackageManifest('plugin-azure-billing'));
      registry.setPackageEnabled('plugin-azure-billing', false);

      registry.unregisterPackage('plugin-azure-billing');
      registry.registerPackage(fakePackageManifest('plugin-azure-billing'));

      expect(registry.isPackageEnabled('plugin-azure-billing')).toBe(true);
    });
  });
});
