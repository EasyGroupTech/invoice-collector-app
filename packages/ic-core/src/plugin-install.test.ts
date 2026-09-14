import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import type { DestinationPlugin, PluginImplementationManifest, PluginManifest, SessionPlugin, SourcePlugin } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPlugin, reloadInstalledPlugins, uninstallPlugin } from './plugin-install.js';
import { createPluginRegistry, type PluginRegistry } from './plugin-registry.js';
import type { SessionsRegistry } from './sessions-registry.js';

const CORE_SDK_VERSION = '1.0.0';

function fakeAttestationsBodyFor(artifactBytes: Uint8Array): unknown {
  const digestHex = createHash('sha256').update(artifactBytes).digest('hex');
  const statement = { subject: [{ name: 'artifact.zip', digest: { sha256: digestHex } }] };
  return {
    attestations: [
      {
        bundle: {
          mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement), 'utf-8').toString('base64'),
            payloadType: 'application/vnd.in-toto+json',
            signatures: [],
          },
          verificationMaterial: { tlogEntries: [] },
        },
      },
    ],
  };
}

function buildZip(entries: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    files[name] = new TextEncoder().encode(content);
  }
  return zipSync(files);
}

// §9.4: manifest.json describes a *package* — one or more session/source/destination
// implementations, bundled, installed, and removed together. One implementation is the common
// case exercised throughout this file; a dedicated describe block below covers a package that
// bundles more than one.
const validImplementation = { id: 'app.easygroup.source.test-plugin', name: 'Test Plugin', kind: 'source' as const, main: 'index.js' };

const validManifest: PluginManifest = {
  id: 'app.easygroup.test-package',
  name: 'Test Package',
  version: '1.0.0',
  pluginApiVersion: '^1.0.0',
  sbom: 'sbom.cdx.json',
  implementations: [validImplementation],
};

const validSbom = { bomFormat: 'CycloneDX', specVersion: '1.5', components: [] };

function fakeModuleSourceFor(implementation: PluginImplementationManifest): string {
  return `
export default {
  manifest: ${JSON.stringify({ id: implementation.id, name: implementation.name, kind: implementation.kind, main: implementation.main })},
  sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
  wizard: [],
  discover: async function* () {},
  fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
};
`;
}

const fakeSourceModuleSource = fakeModuleSourceFor(validImplementation);

function fakeSourcePlugin(overrides: Partial<SourcePlugin['manifest']> = {}): SourcePlugin {
  return {
    manifest: { id: validImplementation.id, name: validImplementation.name, kind: validImplementation.kind, main: validImplementation.main, ...overrides },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
    wizard: [],
    discover: async function* () {},
    fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
  } as unknown as SourcePlugin;
}

function fetchReturningZip(zip: Uint8Array): typeof fetch {
  return vi.fn(async () => new Response(zip, { status: 200 })) as unknown as typeof fetch;
}

/** Routes the download URL to the zip bytes and any GitHub API URL to a JSON attestations
 * response — the attestation check reuses the same injected fetchImpl as the download itself. */
function fetchZipAndAttestations(zip: Uint8Array, attestationsBody: unknown): typeof fetch {
  return vi.fn(async (url: string) => {
    if (url.includes('api.github.com')) {
      return new Response(JSON.stringify(attestationsBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(zip, { status: 200 });
  }) as unknown as typeof fetch;
}

describe('installPlugin', () => {
  let dir: string;
  let pluginsDir: string;
  let trustAckFilePath: string;
  let registry: PluginRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-'));
    pluginsDir = path.join(dir, 'plugins');
    trustAckFilePath = path.join(dir, 'trust-ack.json');
    registry = createPluginRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('installs a real, unverified-tier package end-to-end: real zip, real dynamic import, registered for real', async () => {
    const zip = buildZip({
      'manifest.json': JSON.stringify(validManifest),
      'sbom.cdx.json': JSON.stringify(validSbom),
      'index.js': fakeSourceModuleSource,
    });

    const result = await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      confirmUnverified: true,
      fetchImpl: fetchReturningZip(zip),
      // No importModule override here — this is the real dynamic import() default, proving the
      // whole pipeline (extract -> validate -> trust-tier -> import -> register) truly works.
    });

    expect(result.status).toBe('installed');
    expect(registry.get(validImplementation.id)).toBeDefined();
    expect(registry.get(validImplementation.id)?.manifest.id).toBe(validImplementation.id);
    expect(registry.getPackage(validManifest.id)).toEqual(validManifest);

    const installedFiles = await readdir(path.join(pluginsDir, validManifest.id));
    expect(installedFiles).toEqual(expect.arrayContaining(['manifest.json', 'sbom.cdx.json', 'index.js']));
  });

  it('surfaces activationRequirement (§9.1/§15) in the result when the loaded implementation declares one, real dynamic import', async () => {
    const moduleSourceWithActivation = `
export default {
  manifest: ${JSON.stringify(validImplementation)},
  sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
  wizard: [],
  activationRequirement: {
    fields: [{ kind: 'field', name: 'verificationEmail', label: 'Purchase email', type: 'text', required: true }],
    activate: async () => ({ ok: true }),
  },
  discover: async function* () {},
  fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
};
`;
    const zip = buildZip({
      'manifest.json': JSON.stringify(validManifest),
      'sbom.cdx.json': JSON.stringify(validSbom),
      'index.js': moduleSourceWithActivation,
    });

    const result = await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      confirmUnverified: true,
      fetchImpl: fetchReturningZip(zip),
    });

    expect(result.status).toBe('installed');
    expect(result.status === 'installed' && result.activationRequirement).toEqual({
      pluginId: validImplementation.id,
      fields: [{ kind: 'field', name: 'verificationEmail', label: 'Purchase email', type: 'text', required: true }],
    });
  });

  it('omits activationRequirement from the result when nothing declares one', async () => {
    const zip = buildZip({
      'manifest.json': JSON.stringify(validManifest),
      'sbom.cdx.json': JSON.stringify(validSbom),
      'index.js': fakeSourceModuleSource,
    });

    const result = await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      confirmUnverified: true,
      fetchImpl: fetchReturningZip(zip),
    });

    expect(result.status).toBe('installed');
    expect(result.status === 'installed' && result.activationRequirement).toBeUndefined();
  });

  it('persists the resolved download URL (install-source.json) and exposes it via registry.getInstallUrl (§9.1, PluginContext.installUrl)', async () => {
    const zip = buildZip({
      'manifest.json': JSON.stringify(validManifest),
      'sbom.cdx.json': JSON.stringify(validSbom),
      'index.js': fakeSourceModuleSource,
    });

    await installPlugin('https://cdn.example.com/plugin.zip?e=abc123', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      confirmUnverified: true,
      fetchImpl: fetchReturningZip(zip),
    });

    expect(registry.getInstallUrl(validImplementation.id)).toBe('https://cdn.example.com/plugin.zip?e=abc123');
    const installSource = JSON.parse(await readFile(path.join(pluginsDir, validManifest.id, 'install-source.json'), 'utf-8'));
    expect(installSource).toEqual({ downloadUrl: 'https://cdn.example.com/plugin.zip?e=abc123' });
  });

  it('returns needs-confirmation for an unverified-tier package not previously acknowledged, without registering or leaving files behind', async () => {
    const zip = buildZip({ 'manifest.json': JSON.stringify(validManifest), 'sbom.cdx.json': JSON.stringify(validSbom) });

    const result = await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      fetchImpl: fetchReturningZip(zip),
      importModule: async () => ({ default: fakeSourcePlugin() }),
    });

    expect(result).toEqual({ status: 'needs-confirmation', manifest: validManifest, tier: 'unverified' });
    expect(registry.get(validImplementation.id)).toBeUndefined();
    expect(registry.getPackage(validManifest.id)).toBeUndefined();
    await expect(readdir(pluginsDir)).resolves.toEqual([]);
  });

  it('installs without re-confirming once the same id+version was already acknowledged', async () => {
    const zip = buildZip({ 'manifest.json': JSON.stringify(validManifest), 'sbom.cdx.json': JSON.stringify(validSbom) });
    const install = () =>
      installPlugin('https://example.com/plugin.zip', {
        pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath,
        registry,
        fetchImpl: fetchReturningZip(zip),
        importModule: async () => ({ default: fakeSourcePlugin() }),
      });

    const first = await install();
    expect(first.status).toBe('needs-confirmation');

    await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      confirmUnverified: true,
      fetchImpl: fetchReturningZip(zip),
      importModule: async () => ({ default: fakeSourcePlugin() }),
    });

    registry = createPluginRegistry();
    const second = await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      fetchImpl: fetchReturningZip(zip),
      importModule: async () => ({ default: fakeSourcePlugin() }),
    });

    expect(second.status).toBe('installed'); // no confirmUnverified needed the second time
    expect(registry.get(validImplementation.id)).toBeDefined();
  });

  it('installs an open-source-tier package once its GitHub Artifact Attestation verifies', async () => {
    const manifestWithRepo = { ...validManifest, repository: 'https://github.com/owner/repo' };
    const zip = buildZip({ 'manifest.json': JSON.stringify(manifestWithRepo), 'sbom.cdx.json': JSON.stringify(validSbom) });
    const verifyImpl = vi.fn(async () => ({}) as never);

    const result = await installPlugin('https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      fetchImpl: fetchZipAndAttestations(zip, fakeAttestationsBodyFor(zip)),
      importModule: async () => ({ default: fakeSourcePlugin() }),
      verifyAttestationOptions: { verifyImpl },
    });

    expect(result).toEqual({ status: 'installed', manifest: manifestWithRepo, tier: 'open-source' });
    expect(verifyImpl).toHaveBeenCalled();
  });

  it('rejects an open-source-tier package whose attestation does not verify, without registering it', async () => {
    const manifestWithRepo = { ...validManifest, repository: 'https://github.com/owner/repo' };
    const zip = buildZip({ 'manifest.json': JSON.stringify(manifestWithRepo), 'sbom.cdx.json': JSON.stringify(validSbom) });
    const verifyImpl = vi.fn(async () => {
      throw new Error('bad signature');
    });

    await expect(
      installPlugin('https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip', {
        pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath,
        registry,
        fetchImpl: fetchZipAndAttestations(zip, fakeAttestationsBodyFor(zip)),
        importModule: async () => ({ default: fakeSourcePlugin() }),
        verifyAttestationOptions: { verifyImpl },
      }),
    ).rejects.toThrow(/attestation/i);

    expect(registry.get(validImplementation.id)).toBeUndefined();
    await expect(readdir(pluginsDir)).resolves.toEqual([]);
  });

  it('rejects an invalid manifest, leaving no directory behind', async () => {
    const zip = buildZip({ 'manifest.json': JSON.stringify({ id: 'x' }), 'sbom.cdx.json': JSON.stringify(validSbom) });

    await expect(
      installPlugin('https://example.com/plugin.zip', {
        pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath,
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
      }),
    ).rejects.toThrow(/invalid plugin manifest/i);

    await expect(readdir(pluginsDir)).resolves.toEqual([]);
  });

  it('rejects a pluginApiVersion outside the two-major supported window', async () => {
    const manifest = { ...validManifest, pluginApiVersion: '^99.0.0' };
    const zip = buildZip({ 'manifest.json': JSON.stringify(manifest), 'sbom.cdx.json': JSON.stringify(validSbom) });

    await expect(
      installPlugin('https://example.com/plugin.zip', {
        pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath,
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
      }),
    ).rejects.toThrow(/pluginApiVersion/);
  });

  it('rejects a missing/unparseable sbom file', async () => {
    const zip = buildZip({ 'manifest.json': JSON.stringify(validManifest) }); // no sbom.cdx.json at all

    await expect(
      installPlugin('https://example.com/plugin.zip', {
        pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath,
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
      }),
    ).rejects.toThrow(/sbom/i);
  });

  it('rejects a package whose loaded implementation has invalid sessionRequirements', async () => {
    const zip = buildZip({ 'manifest.json': JSON.stringify(validManifest), 'sbom.cdx.json': JSON.stringify(validSbom) });

    await expect(
      installPlugin('https://example.com/plugin.zip', {
        pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath,
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
        importModule: async () => ({ default: { ...fakeSourcePlugin(), sessionRequirements: [] } }),
      }),
    ).rejects.toThrow(/sessionRequirements/);

    expect(registry.get(validImplementation.id)).toBeUndefined();
    expect(registry.getPackage(validManifest.id)).toBeUndefined();
  });

  it('rejects a package whose loaded implementation declares a list step but implements no resolveListData', async () => {
    const zip = buildZip({ 'manifest.json': JSON.stringify(validManifest), 'sbom.cdx.json': JSON.stringify(validSbom) });

    await expect(
      installPlugin('https://example.com/plugin.zip', {
        pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath,
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
        importModule: async () => ({
          default: {
            ...fakeSourcePlugin(),
            wizard: [{ kind: 'list', name: 'messages', label: 'Messages', columns: [], dataSource: 'mailPreview' }],
          },
        }),
      }),
    ).rejects.toThrow(/resolveListData/);

    expect(registry.get(validImplementation.id)).toBeUndefined();
  });

  it('propagates a download failure clearly', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;

    await expect(
      installPlugin('https://example.com/plugin.zip', {
        pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath,
        registry,
        fetchImpl,
      }),
    ).rejects.toThrow(/download/i);
  });
});

describe('installPlugin (a package bundling more than one implementation, §9.4)', () => {
  const sourceImpl = { id: 'app.easygroup.source.bundle-test', name: 'Bundle Source', kind: 'source' as const, main: 'source.js' };
  const destinationImpl = { id: 'app.easygroup.destination.bundle-test', name: 'Bundle Destination', kind: 'destination' as const, main: 'destination.js' };
  const bundleManifest: PluginManifest = {
    id: 'app.easygroup.bundle-test',
    name: 'Bundle Test Package',
    version: '1.0.0',
    pluginApiVersion: '^1.0.0',
    sbom: 'sbom.cdx.json',
    implementations: [sourceImpl, destinationImpl],
  };

  let dir: string;
  let pluginsDir: string;
  let registry: PluginRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-bundle-'));
    pluginsDir = path.join(dir, 'plugins');
    registry = createPluginRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('registers every implementation the manifest declares, and the package once, from a single install', async () => {
    const zip = buildZip({
      'manifest.json': JSON.stringify(bundleManifest),
      'sbom.cdx.json': JSON.stringify(validSbom),
      'source.js': fakeModuleSourceFor(sourceImpl),
      'destination.js': fakeModuleSourceFor(destinationImpl),
    });

    const result = await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath: path.join(dir, 'trust-ack.json'),
      registry,
      confirmUnverified: true,
      fetchImpl: fetchReturningZip(zip),
    });

    expect(result.status).toBe('installed');
    expect(registry.get(sourceImpl.id)).toBeDefined();
    expect(registry.get(destinationImpl.id)).toBeDefined();
    expect(registry.listPackages()).toEqual([bundleManifest]);
  });

  it('uninstalling the package unregisters every implementation it bundled, together', async () => {
    const zip = buildZip({
      'manifest.json': JSON.stringify(bundleManifest),
      'sbom.cdx.json': JSON.stringify(validSbom),
      'source.js': fakeModuleSourceFor(sourceImpl),
      'destination.js': fakeModuleSourceFor(destinationImpl),
    });
    await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath: path.join(dir, 'trust-ack.json'),
      registry,
      confirmUnverified: true,
      fetchImpl: fetchReturningZip(zip),
    });

    await uninstallPlugin(bundleManifest.id, { pluginsDir, registry });

    expect(registry.get(sourceImpl.id)).toBeUndefined();
    expect(registry.get(destinationImpl.id)).toBeUndefined();
    expect(registry.getPackage(bundleManifest.id)).toBeUndefined();
  });
});

describe('installPlugin (destination plugin)', () => {
  it('installs a destination plugin the same way as a source plugin', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-dest-'));
    try {
      const implementation = { ...validImplementation, id: 'app.easygroup.destination.test', kind: 'destination' as const };
      const manifest: PluginManifest = { ...validManifest, id: 'app.easygroup.destination-test-package', implementations: [implementation] };
      const zip = buildZip({ 'manifest.json': JSON.stringify(manifest), 'sbom.cdx.json': JSON.stringify(validSbom) });
      const registry = createPluginRegistry();
      const destinationPlugin: DestinationPlugin = {
        manifest: implementation,
        sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
        wizard: [],
        upload: async () => ({ status: 'uploaded' }),
      };

      const result = await installPlugin('https://example.com/plugin.zip', {
        pluginsDir: path.join(dir, 'plugins'),
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath: path.join(dir, 'trust-ack.json'),
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
        importModule: async () => ({ default: destinationPlugin }),
      });

      expect(result.status).toBe('installed');
      expect(registry.listDestinations()).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("registers an implementation's own sessionPlugin (a custom session type it brings itself) when a sessionsRegistry is supplied", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-session-'));
    try {
      const implementation = { ...validImplementation, id: 'app.easygroup.destination.custom-session-test', kind: 'destination' as const };
      const manifest: PluginManifest = { ...validManifest, id: 'app.easygroup.custom-session-test-package', implementations: [implementation] };
      const zip = buildZip({ 'manifest.json': JSON.stringify(manifest), 'sbom.cdx.json': JSON.stringify(validSbom) });
      const registry = createPluginRegistry();
      const customSessionPlugin: SessionPlugin = {
        sessionTypeId: 'app.easygroup.destination.custom-session-test/folder-access',
        create: async () => ({ label: 'test', secret: {} }),
        test: async () => 'ok',
        applyAuth: (_secret, request) => request,
      };
      const destinationPlugin: DestinationPlugin = {
        manifest: implementation,
        sessionRequirements: [{ sessionTypeId: customSessionPlugin.sessionTypeId, confirmsBuiltIn: false, requiredScopesOrRoles: [] }],
        sessionPlugin: customSessionPlugin,
        wizard: [],
        upload: async () => ({ status: 'uploaded' }),
      };
      const registerSessionPlugin = vi.fn();

      const result = await installPlugin('https://example.com/plugin.zip', {
        pluginsDir: path.join(dir, 'plugins'),
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath: path.join(dir, 'trust-ack.json'),
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
        importModule: async () => ({ default: destinationPlugin }),
        sessionsRegistry: { registerSessionPlugin } as unknown as SessionsRegistry,
      });

      expect(result.status).toBe('installed');
      expect(registerSessionPlugin).toHaveBeenCalledWith(customSessionPlugin);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('installs successfully without registering anything session-related when the implementation declares no sessionPlugin', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-no-session-'));
    try {
      const zip = buildZip({ 'manifest.json': JSON.stringify(validManifest), 'sbom.cdx.json': JSON.stringify(validSbom) });
      const registry = createPluginRegistry();
      const registerSessionPlugin = vi.fn();

      const result = await installPlugin('https://example.com/plugin.zip', {
        pluginsDir: path.join(dir, 'plugins'),
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath: path.join(dir, 'trust-ack.json'),
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
        importModule: async () => ({ default: fakeSourcePlugin() }),
        sessionsRegistry: { registerSessionPlugin } as unknown as SessionsRegistry,
      });

      expect(result.status).toBe('installed');
      expect(registerSessionPlugin).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('installs successfully even when the implementation declares a sessionPlugin but no sessionsRegistry was supplied', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-session-no-registry-'));
    try {
      const implementation = { ...validImplementation, id: 'app.easygroup.destination.no-sessions-registry-test', kind: 'destination' as const };
      const manifest: PluginManifest = { ...validManifest, id: 'app.easygroup.no-sessions-registry-test-package', implementations: [implementation] };
      const zip = buildZip({ 'manifest.json': JSON.stringify(manifest), 'sbom.cdx.json': JSON.stringify(validSbom) });
      const registry = createPluginRegistry();
      const destinationPlugin: DestinationPlugin = {
        manifest: implementation,
        sessionRequirements: [{ sessionTypeId: 'custom-type', confirmsBuiltIn: false, requiredScopesOrRoles: [] }],
        sessionPlugin: {
          sessionTypeId: 'custom-type',
          create: async () => ({ label: 'test', secret: {} }),
          test: async () => 'ok',
          applyAuth: (_secret, request) => request,
        },
        wizard: [],
        upload: async () => ({ status: 'uploaded' }),
      };

      const result = await installPlugin('https://example.com/plugin.zip', {
        pluginsDir: path.join(dir, 'plugins'),
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath: path.join(dir, 'trust-ack.json'),
        registry,
        confirmUnverified: true,
        fetchImpl: fetchReturningZip(zip),
        importModule: async () => ({ default: destinationPlugin }),
      });

      expect(result.status).toBe('installed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('uninstallPlugin', () => {
  let dir: string;
  let pluginsDir: string;
  let registry: PluginRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-uninstall-'));
    pluginsDir = path.join(dir, 'plugins');
    registry = createPluginRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('unregisters the package (and its implementation) and removes its installed package files — preserve, not delete, of everything else (§5)', async () => {
    const zip = buildZip({
      'manifest.json': JSON.stringify(validManifest),
      'sbom.cdx.json': JSON.stringify(validSbom),
      'index.js': fakeSourceModuleSource,
    });
    await installPlugin('https://example.com/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath: path.join(dir, 'trust-ack.json'),
      registry,
      confirmUnverified: true,
      fetchImpl: fetchReturningZip(zip),
    });
    expect(registry.get(validImplementation.id)).toBeDefined();

    await uninstallPlugin(validManifest.id, { pluginsDir, registry });

    expect(registry.get(validImplementation.id)).toBeUndefined();
    expect(registry.getPackage(validManifest.id)).toBeUndefined();
    await expect(readdir(path.join(pluginsDir, validManifest.id))).rejects.toThrow();
  });

  it('is a no-op, not a throw, when the package is not installed', async () => {
    await expect(uninstallPlugin('not-installed', { pluginsDir, registry })).resolves.toBeUndefined();
  });
});

describe('reloadInstalledPlugins', () => {
  let dir: string;
  let pluginsDir: string;
  let registry: PluginRegistry;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-reload-'));
    pluginsDir = path.join(dir, 'plugins');
    registry = createPluginRegistry();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Writes a package directly onto disk, the shape §9.1's install pipeline would have already
   * left behind from an earlier run — reloadInstalledPlugins() never downloads/extracts anything
   * itself, so tests exercise it against files already in place, not a zip. */
  async function writePluginOnDisk(id: string, manifestOverrides: Partial<PluginManifest> = {}): Promise<void> {
    const implementation = { ...validImplementation, id };
    const manifest: PluginManifest = { ...validManifest, id, implementations: [implementation], ...manifestOverrides };
    const packageDir = path.join(pluginsDir, id);
    await mkdir(packageDir, { recursive: true });
    await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
    await writeFile(path.join(packageDir, 'sbom.cdx.json'), JSON.stringify(validSbom), 'utf-8');
    await writeFile(path.join(packageDir, 'index.js'), fakeModuleSourceFor(implementation), 'utf-8');
  }

  it('re-registers a package already sitting on disk from an earlier install, without downloading anything', async () => {
    await writePluginOnDisk('app.easygroup.reload-test');

    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry });

    expect(registry.get('app.easygroup.reload-test')).toBeDefined();
    expect(registry.getPackage('app.easygroup.reload-test')).toBeDefined();
  });

  it('restores installUrl from install-source.json, the same value installPlugin() itself would have persisted', async () => {
    const id = 'app.easygroup.reload-install-url-test';
    await writePluginOnDisk(id);
    await writeFile(path.join(pluginsDir, id, 'install-source.json'), JSON.stringify({ downloadUrl: 'https://cdn.example.com/plugin.zip?e=abc123' }), 'utf-8');

    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry });

    expect(registry.getInstallUrl(id)).toBe('https://cdn.example.com/plugin.zip?e=abc123');
  });

  it('leaves installUrl undefined (not a throw) for a package installed before install-source.json existed', async () => {
    const id = 'app.easygroup.reload-no-install-source-test';
    await writePluginOnDisk(id); // no install-source.json written at all — an older install

    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry });

    expect(registry.get(id)).toBeDefined();
    expect(registry.getInstallUrl(id)).toBeUndefined();
  });

  it("registers a reloaded implementation's own sessionPlugin, same as installPlugin()", async () => {
    const id = 'app.easygroup.reload-session-test';
    const implementation = { ...validImplementation, id: 'app.easygroup.destination.reload-session-test', kind: 'destination' as const };
    const packageDir = path.join(pluginsDir, id);
    await mkdir(packageDir, { recursive: true });
    const customSessionTypeId = `${id}/custom`;
    const manifest: PluginManifest = { ...validManifest, id, implementations: [implementation] };
    await writeFile(path.join(packageDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
    await writeFile(path.join(packageDir, 'sbom.cdx.json'), JSON.stringify(validSbom), 'utf-8');
    await writeFile(
      path.join(packageDir, 'index.js'),
      `
export default {
  manifest: ${JSON.stringify(implementation)},
  sessionRequirements: [{ sessionTypeId: ${JSON.stringify(customSessionTypeId)}, confirmsBuiltIn: false, requiredScopesOrRoles: [] }],
  sessionPlugin: {
    sessionTypeId: ${JSON.stringify(customSessionTypeId)},
    create: async () => ({ label: 'test', secret: {} }),
    test: async () => 'ok',
    applyAuth: (_secret, request) => request,
  },
  wizard: [],
  upload: async () => ({ status: 'uploaded' }),
};
`,
      'utf-8',
    );

    const registerSessionPlugin = vi.fn();
    await reloadInstalledPlugins({
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      registry,
      sessionsRegistry: { registerSessionPlugin } as unknown as SessionsRegistry,
    });

    expect(registerSessionPlugin).toHaveBeenCalledWith(expect.objectContaining({ sessionTypeId: customSessionTypeId }));
  });

  it('skips (via onError, not a throw) a package whose pluginApiVersion no longer supports the current core, while still loading the rest', async () => {
    await writePluginOnDisk('app.easygroup.outdated', { pluginApiVersion: '^99.0.0' });
    await writePluginOnDisk('app.easygroup.current');

    const onError = vi.fn();
    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry, onError });

    expect(registry.get('app.easygroup.outdated')).toBeUndefined();
    expect(registry.get('app.easygroup.current')).toBeDefined();
    expect(onError).toHaveBeenCalledWith('app.easygroup.outdated', expect.any(Error));
  });

  it('skips (via onError, not a throw) a directory with a missing or corrupt manifest.json', async () => {
    await mkdir(path.join(pluginsDir, 'corrupt-plugin'), { recursive: true });
    await writeFile(path.join(pluginsDir, 'corrupt-plugin', 'manifest.json'), 'not valid json{', 'utf-8');
    await writePluginOnDisk('app.easygroup.fine');

    const onError = vi.fn();
    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry, onError });

    expect(registry.get('app.easygroup.fine')).toBeDefined();
    expect(onError).toHaveBeenCalledWith('corrupt-plugin', expect.anything());
  });

  it('ignores a leftover .staging- directory from an interrupted install', async () => {
    await mkdir(path.join(pluginsDir, '.staging-123-abc'), { recursive: true });
    await writeFile(path.join(pluginsDir, '.staging-123-abc', 'manifest.json'), 'not valid json{', 'utf-8');

    const onError = vi.fn();
    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry, onError });

    expect(onError).not.toHaveBeenCalled();
  });

  it('is a no-op, not a throw, when pluginsDir does not exist yet (a fresh install with nothing installed)', async () => {
    await expect(reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry })).resolves.toBeUndefined();
    expect(registry.list()).toHaveLength(0);
  });
});
