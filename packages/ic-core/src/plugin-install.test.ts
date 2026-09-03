import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import type { DestinationPlugin, SourcePlugin } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPlugin } from './plugin-install.js';
import { createPluginRegistry, type PluginRegistry } from './plugin-registry.js';

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
});
