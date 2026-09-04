import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import type { DestinationPlugin, SessionPlugin, SourcePlugin } from 'invoice-collector-plugin-sdk';
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

const validManifest = {
  id: 'app.easygroup.source.test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  pluginApiVersion: '^1.0.0',
  kind: 'source' as const,
  sbom: 'sbom.cdx.json',
  main: 'index.js',
};

const validSbom = { bomFormat: 'CycloneDX', specVersion: '1.5', components: [] };

const fakeSourceModuleSource = `
export default {
  manifest: ${JSON.stringify({ ...validManifest, repository: undefined })},
  sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
  wizard: [],
  discover: async function* () {},
  fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
};
`;

function fakeSourcePlugin(overrides: Partial<SourcePlugin['manifest']> = {}): SourcePlugin {
  return {
    manifest: { ...validManifest, ...overrides },
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

  it('installs a real, unverified-tier plugin end-to-end: real zip, real dynamic import, registered for real', async () => {
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
    expect(registry.get(validManifest.id)).toBeDefined();
    expect(registry.get(validManifest.id)?.manifest.id).toBe(validManifest.id);

    const installedFiles = await readdir(path.join(pluginsDir, validManifest.id));
    expect(installedFiles).toEqual(expect.arrayContaining(['manifest.json', 'sbom.cdx.json', 'index.js']));
  });

  it('returns needs-confirmation for an unverified-tier plugin not previously acknowledged, without registering or leaving files behind', async () => {
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
    expect(registry.get(validManifest.id)).toBeUndefined();
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
    expect(registry.get(validManifest.id)).toBeDefined();
  });

  it('installs an open-source-tier plugin once its GitHub Artifact Attestation verifies', async () => {
    const manifestWithRepo = { ...validManifest, repository: 'https://github.com/owner/repo' };
    const zip = buildZip({ 'manifest.json': JSON.stringify(manifestWithRepo), 'sbom.cdx.json': JSON.stringify(validSbom) });
    const verifyImpl = vi.fn(async () => ({}) as never);

    const result = await installPlugin('https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip', {
      pluginsDir,
      coreSdkVersion: CORE_SDK_VERSION,
      trustAckFilePath,
      registry,
      fetchImpl: fetchZipAndAttestations(zip, fakeAttestationsBodyFor(zip)),
      importModule: async () => ({ default: fakeSourcePlugin({ repository: manifestWithRepo.repository }) }),
      verifyAttestationOptions: { verifyImpl },
    });

    expect(result).toEqual({ status: 'installed', manifest: manifestWithRepo, tier: 'open-source' });
    expect(verifyImpl).toHaveBeenCalled();
  });

  it('rejects an open-source-tier plugin whose attestation does not verify, without registering it', async () => {
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
        importModule: async () => ({ default: fakeSourcePlugin({ repository: manifestWithRepo.repository }) }),
        verifyAttestationOptions: { verifyImpl },
      }),
    ).rejects.toThrow(/attestation/i);

    expect(registry.get(validManifest.id)).toBeUndefined();
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

  it('rejects a plugin whose loaded module has invalid sessionRequirements', async () => {
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

    expect(registry.get(validManifest.id)).toBeUndefined();
  });

  it('rejects a plugin whose wizard declares a list step but implements no resolveListData', async () => {
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

    expect(registry.get(validManifest.id)).toBeUndefined();
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

describe('installPlugin (destination plugin)', () => {
  it('installs a destination plugin the same way as a source plugin', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-dest-'));
    try {
      const manifest = { ...validManifest, id: 'app.easygroup.destination.test', kind: 'destination' as const };
      const zip = buildZip({ 'manifest.json': JSON.stringify(manifest), 'sbom.cdx.json': JSON.stringify(validSbom) });
      const registry = createPluginRegistry();
      const destinationPlugin: DestinationPlugin = {
        manifest,
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

  it("registers a plugin's own sessionPlugin (a custom session type it brings itself) when a sessionsRegistry is supplied", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-session-'));
    try {
      const manifest = { ...validManifest, id: 'app.easygroup.destination.custom-session-test', kind: 'destination' as const };
      const zip = buildZip({ 'manifest.json': JSON.stringify(manifest), 'sbom.cdx.json': JSON.stringify(validSbom) });
      const registry = createPluginRegistry();
      const customSessionPlugin: SessionPlugin = {
        sessionTypeId: 'app.easygroup.destination.custom-session-test/folder-access',
        create: async () => ({ label: 'test', secret: {} }),
        test: async () => 'ok',
        applyAuth: (_secret, request) => request,
      };
      const destinationPlugin: DestinationPlugin = {
        manifest,
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

  it('installs successfully without registering anything session-related when the plugin declares no sessionPlugin', async () => {
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

  it('installs successfully even when the plugin declares a sessionPlugin but no sessionsRegistry was supplied', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-install-session-no-registry-'));
    try {
      const manifest = { ...validManifest, id: 'app.easygroup.destination.no-sessions-registry-test', kind: 'destination' as const };
      const zip = buildZip({ 'manifest.json': JSON.stringify(manifest), 'sbom.cdx.json': JSON.stringify(validSbom) });
      const registry = createPluginRegistry();
      const destinationPlugin: DestinationPlugin = {
        manifest,
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

  it('unregisters the plugin and removes its installed package files — preserve, not delete, of everything else (§5)', async () => {
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
    expect(registry.get(validManifest.id)).toBeDefined();

    await uninstallPlugin(validManifest.id, { pluginsDir, registry });

    expect(registry.get(validManifest.id)).toBeUndefined();
    await expect(readdir(path.join(pluginsDir, validManifest.id))).rejects.toThrow();
  });

  it('is a no-op, not a throw, when the plugin is not installed', async () => {
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

  /** Writes a plugin directly onto disk, the shape §9.1's install pipeline would have already
   * left behind from an earlier run — reloadInstalledPlugins() never downloads/extracts anything
   * itself, so tests exercise it against files already in place, not a zip. */
  async function writePluginOnDisk(id: string, manifestOverrides: Partial<typeof validManifest> = {}): Promise<void> {
    const manifest = { ...validManifest, id, ...manifestOverrides };
    const pluginDir = path.join(pluginsDir, id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest), 'utf-8');
    await writeFile(path.join(pluginDir, 'sbom.cdx.json'), JSON.stringify(validSbom), 'utf-8');
    await writeFile(path.join(pluginDir, 'index.js'), fakeSourceModuleSourceFor(id), 'utf-8');
  }

  function fakeSourceModuleSourceFor(id: string): string {
    return `
export default {
  manifest: ${JSON.stringify({ ...validManifest, id, repository: undefined })},
  sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
  wizard: [],
  discover: async function* () {},
  fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
};
`;
  }

  it('re-registers a plugin already sitting on disk from an earlier install, without downloading anything', async () => {
    await writePluginOnDisk('app.easygroup.source.reload-test');

    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry });

    expect(registry.get('app.easygroup.source.reload-test')).toBeDefined();
  });

  it('registers a reloaded plugin\'s own sessionPlugin, same as installPlugin()', async () => {
    const id = 'app.easygroup.destination.reload-session-test';
    const pluginDir = path.join(pluginsDir, id);
    await mkdir(pluginDir, { recursive: true });
    const customSessionTypeId = `${id}/custom`;
    await writeFile(
      path.join(pluginDir, 'manifest.json'),
      JSON.stringify({ ...validManifest, id, kind: 'destination' }),
      'utf-8',
    );
    await writeFile(path.join(pluginDir, 'sbom.cdx.json'), JSON.stringify(validSbom), 'utf-8');
    await writeFile(
      path.join(pluginDir, 'index.js'),
      `
export default {
  manifest: ${JSON.stringify({ ...validManifest, id, kind: 'destination', repository: undefined })},
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

  it('skips (via onError, not a throw) a plugin whose pluginApiVersion no longer supports the current core, while still loading the rest', async () => {
    await writePluginOnDisk('app.easygroup.source.outdated', { pluginApiVersion: '^3.0.0' });
    await writePluginOnDisk('app.easygroup.source.current');

    const onError = vi.fn();
    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry, onError });

    expect(registry.get('app.easygroup.source.outdated')).toBeUndefined();
    expect(registry.get('app.easygroup.source.current')).toBeDefined();
    expect(onError).toHaveBeenCalledWith('app.easygroup.source.outdated', expect.any(Error));
  });

  it('skips (via onError, not a throw) a directory with a missing or corrupt manifest.json', async () => {
    await mkdir(path.join(pluginsDir, 'corrupt-plugin'), { recursive: true });
    await writeFile(path.join(pluginsDir, 'corrupt-plugin', 'manifest.json'), 'not valid json{', 'utf-8');
    await writePluginOnDisk('app.easygroup.source.fine');

    const onError = vi.fn();
    await reloadInstalledPlugins({ pluginsDir, coreSdkVersion: CORE_SDK_VERSION, registry, onError });

    expect(registry.get('app.easygroup.source.fine')).toBeDefined();
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
