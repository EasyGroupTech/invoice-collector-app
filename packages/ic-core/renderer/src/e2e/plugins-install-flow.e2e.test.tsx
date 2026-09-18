// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { zipSync } from 'fflate';
import type { PluginImplementationManifest, PluginManifest, SourcePlugin } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPlugin } from '../../../src/plugin-install.js';
import { PluginsSection } from '../pages/PluginsSection.js';
import { createTestBackend, type TestBackend } from './test-backend.js';

const CORE_SDK_VERSION = '1.0.0';

const implementation: PluginImplementationManifest = {
  id: 'app.easygroup.source.fake-plugin',
  name: 'Fake Test Plugin',
  kind: 'source',
  main: 'index.js',
};

function manifestFor(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: 'app.easygroup.fake-package',
    name: 'Fake Test Plugin Package',
    version: '1.0.0',
    pluginApiVersion: '^1.0.0',
    sbom: 'sbom.cdx.json',
    implementations: [implementation],
    ...overrides,
  };
}

function buildZip(manifest: PluginManifest): Uint8Array {
  return zipSync({
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest)),
    'sbom.cdx.json': new TextEncoder().encode(JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [] })),
    // installPlugin() never actually reads this file's *content* — only that it's present, so the
    // zip is real and its extraction/manifest-validation is exercised for real. What it would
    // export if dynamically imported is supplied directly below instead (see fakeSourcePlugin's
    // own doc comment for why a real dynamic import can't be exercised in this test process at all).
    'index.js': new TextEncoder().encode('export default {};'),
  });
}

function fetchReturningZip(zip: Uint8Array): typeof fetch {
  return vi.fn(async () => new Response(zip as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
}

// A package must declare at least one real sessionRequirement (CLAUDE.md's own hard constraint,
// enforced by validateAndRegisterPlugin) — an empty array is rejected outright, not treated as
// "this plugin needs no session."
function fakeSourcePlugin(): SourcePlugin {
  return {
    manifest: implementation,
    sessionRequirements: [
      { sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [], collects: 'test invoices', connectHow: 'signing in.', connectInstructions: 'Sign in to test.' },
    ],
    wizard: [],
    discover: async function* () {},
    fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
  };
}

/**
 * `installPlugin()`'s own dynamic `import()` of the freshly-extracted implementation module can't
 * be exercised for real from inside this test process at all — vite-node runs this whole file
 * (and `plugin-install.ts`, which it imports) inside a Node `vm` module context, and Node's `vm`
 * throws "A dynamic import callback was not specified" for *any* `import()` reached from code
 * running in that context, real file on disk or not (confirmed live: even hiding the call inside
 * a runtime-constructed `Function` body to dodge Vite's own static-analysis interception still
 * hits this deeper, unrelated VM-level restriction). `plugin-install.test.ts`'s own unit tests
 * already avoid this by always mocking `importModule` — never once doing a real dynamic import —
 * for exactly this reason; this E2E test follows the same, already-established pattern. Every
 * other step (download, zip extraction, manifest/sbom/pluginApiVersion validation, attestation,
 * trust-tier decision) still runs for real against the real zip built above.
 */
function fakeImportModule(): Promise<{ default: unknown }> {
  return Promise.resolve({ default: fakeSourcePlugin() });
}

let backend: TestBackend;

beforeEach(async () => {
  backend = await createTestBackend();
  window.api = backend.api;
});

afterEach(async () => {
  await backend.cleanup();
});

/**
 * §9's trust-tier warning (install flow) — real `installPlugin()`, a real zip built on the fly
 * (fflate), downloaded via a fake `fetchImpl` (the only thing standing in for the network, per
 * §10's "no real connection in any test" rule) rather than a canned IPC response, so this exercises
 * the actual trust-tier decision and confirmation-gating logic, not a UI-only mock of it.
 */
describe('Plugins section — install flow and trust-tier warning', () => {
  it('warns before installing an unverified (no repository) package, then installs it once confirmed', async () => {
    const zip = buildZip(manifestFor()); // no `repository` field — unverified tier
    window.api.pluginsInstall = (input) =>
      installPlugin(input.rawInput, {
        pluginsDir: backend.pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath: backend.trustAckFilePath,
        registry: backend.registry,
        confirmUnverified: input.confirmUnverified,
        fetchImpl: fetchReturningZip(zip),
        importModule: fakeImportModule,
      });

    const user = userEvent.setup();
    render(<PluginsSection />);

    await user.click(screen.getByText('Plugins')); // expand the collapsed card
    await user.type(screen.getByPlaceholderText('Plugin URL'), 'my-test-token');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(screen.getByText(/is from an unverified developer/)).toBeInTheDocument());
    expect(screen.queryByText('Unverified — no public repository')).not.toBeInTheDocument(); // not installed yet — only the warning's own text mentions the name so far

    await user.click(screen.getByRole('button', { name: 'Install anyway' }));

    // The name appears both inside the (still-visible-until-install-finishes) warning's own
    // <strong> and, once installed, the plugin-list row — waiting on the warning's disappearance
    // first is the unambiguous "the async install actually finished" signal.
    await waitFor(() => expect(screen.queryByText(/is from an unverified developer/)).not.toBeInTheDocument());
    expect(screen.getByText('Fake Test Plugin Package')).toBeInTheDocument();
    expect(screen.getByText('Unverified — no public repository')).toBeInTheDocument();
  });

  it('installs an open-source (repository set) package with no warning at all', async () => {
    // A direct-artifact release-download link skips resolveInstallSource's own license check, but
    // installPlugin() still requires a real GitHub Artifact Attestation for *any* open-source-tier
    // package regardless of how it was resolved (§9.1) — faked the same way plugin-install.test.ts
    // already does: a real-shaped attestation response routed by URL, plus a fake verifyImpl
    // standing in for the real sigstore cryptographic check.
    const ossManifest = manifestFor({ id: 'app.easygroup.fake-oss-package', repository: 'https://github.com/example-org/example-repo' });
    const zip = buildZip(ossManifest);
    const digestHex = createHash('sha256').update(zip).digest('hex');
    const attestationsBody = {
      attestations: [
        {
          bundle: {
            mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
            dsseEnvelope: {
              payload: Buffer.from(JSON.stringify({ subject: [{ name: 'artifact.zip', digest: { sha256: digestHex } }] }), 'utf-8').toString('base64'),
              payloadType: 'application/vnd.in-toto+json',
              signatures: [],
            },
            verificationMaterial: { tlogEntries: [] },
          },
        },
      ],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/attestations/')) return new Response(JSON.stringify(attestationsBody), { status: 200 });
      return new Response(zip as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    window.api.pluginsInstall = (input) =>
      installPlugin(input.rawInput, {
        pluginsDir: backend.pluginsDir,
        coreSdkVersion: CORE_SDK_VERSION,
        trustAckFilePath: backend.trustAckFilePath,
        registry: backend.registry,
        confirmUnverified: input.confirmUnverified,
        fetchImpl,
        importModule: fakeImportModule,
        verifyAttestationOptions: { verifyImpl: async () => ({}) as never },
      });

    const user = userEvent.setup();
    render(<PluginsSection />);

    await user.click(screen.getByText('Plugins'));
    await user.type(screen.getByPlaceholderText('Plugin URL'), 'https://github.com/example-org/example-repo/releases/download/v1.0.0/plugin.zip');
    await user.click(screen.getByRole('button', { name: 'Install' }));

    await waitFor(() => expect(screen.getByText('Fake Test Plugin Package')).toBeInTheDocument());
    expect(screen.queryByText(/unverified developer/)).not.toBeInTheDocument();
    expect(screen.getByText('https://github.com/example-org/example-repo')).toBeInTheDocument();
  });
});
