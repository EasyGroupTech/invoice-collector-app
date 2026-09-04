import { readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateManifest,
  validateSessionRequirements,
  validateWizardDataSources,
  type DestinationPlugin,
  type PluginManifest,
  type SourcePlugin,
} from 'invoice-collector-plugin-sdk';
import { parseGithubRepoUrl, verifyGithubArtifactAttestation, type VerifyAttestationOptions } from './github-attestation.js';
import { isPluginApiVersionSupported } from './plugin-api-version.js';
import type { PluginRegistry } from './plugin-registry.js';
import { resolveInstallSource, type ResolveInstallSourceOptions } from './plugin-source-resolve.js';
import type { SessionsRegistry } from './sessions-registry.js';
import {
  acknowledgeUnverifiedInstall,
  hasAcknowledgedUnverifiedInstall,
  loadTrustAckFile,
  saveTrustAckFile,
} from './trust-ack-store.js';
import { extractZipSafely } from './zip-extract.js';

export type TrustTier = 'open-source' | 'unverified';

export interface PluginInstallResult {
  status: 'installed';
  manifest: PluginManifest;
  tier: TrustTier;
}

/**
 * Returned instead of installing when the plugin lands in the Unverified tier (§9) and hasn't
 * been confirmed past the warning before (by id+version, via trust-ack-store). ic-core owns no
 * UI (§8) — the caller (eventually the renderer, via IPC) shows the warning dialog and re-invokes
 * installPlugin with `confirmUnverified: true` once the user agrees.
 */
export interface PluginInstallNeedsConfirmation {
  status: 'needs-confirmation';
  manifest: PluginManifest;
  tier: 'unverified';
}

export interface PluginInstallOptions {
  pluginsDir: string;
  coreSdkVersion: string;
  trustAckFilePath: string;
  registry: PluginRegistry;
  /**
   * Where a plugin's own `sessionPlugin` (§6 — a custom session type it brings itself, e.g. a
   * local-filesystem destination's folder-access session) gets registered so `SessionsApi.create()`
   * can actually route to it. Optional, matching this plugin field itself being optional: a plugin
   * with no `sessionPlugin` needs nothing registered, and a caller not yet wired up to a real
   * SessionsRegistry (nothing has been, before this) just skips this step rather than failing —
   * install still succeeds, but that plugin's own session type won't be creatable until a caller
   * starts supplying one.
   */
  sessionsRegistry?: SessionsRegistry;
  confirmUnverified?: boolean;
  fetchImpl?: typeof fetch;
  resolveSourceOptions?: ResolveInstallSourceOptions;
  verifyAttestationOptions?: VerifyAttestationOptions;
  /** Real dynamic import by default — injectable so tests don't need a real built module on disk
   * for every case, and so this stays free of a hardcoded assumption about module resolution. */
  importModule?: (fileUrl: string) => Promise<{ default: unknown }>;
}

/**
 * §9.1's full install pipeline: resolve → download → extract → validate (manifest shape,
 * pluginApiVersion window, sbom present/parseable) → GitHub Artifact Attestation (OSS path only)
 * → trust-tier decision → dynamic import → sessionRequirements validation → register (plugin
 * itself, then its own `sessionPlugin`, if any).
 *
 * Every call re-runs resolve/download/extract/validate/attestation from scratch, even a second
 * call made purely to supply `confirmUnverified: true` — simpler and safer than trying to resume
 * from a partially-validated state, at the cost of a second download. Not a concern this phase
 * needs to optimize away.
 */
export async function installPlugin(
  rawInput: string,
  options: PluginInstallOptions,
): Promise<PluginInstallResult | PluginInstallNeedsConfirmation> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const importModule = options.importModule ?? ((url: string) => import(url));

  const source = await resolveInstallSource(rawInput, { ...options.resolveSourceOptions, fetchImpl });

  const response = await fetchImpl(source.downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download plugin package: status ${response.status}`);
  }
  const zipBytes = new Uint8Array(await response.arrayBuffer());

  // manifest.id (the final directory name) isn't known until after extraction.
  const stagingDir = path.join(options.pluginsDir, `.staging-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  let installDir = stagingDir;

  try {
    await extractZipSafely(zipBytes, stagingDir);

    const manifest = JSON.parse(await readFile(path.join(stagingDir, 'manifest.json'), 'utf-8')) as PluginManifest;

    const manifestCheck = validateManifest(manifest);
    if (!manifestCheck.valid) {
      throw new Error(`Invalid plugin manifest: ${manifestCheck.errors.join('; ')}`);
    }

    if (!isPluginApiVersionSupported(manifest.pluginApiVersion, options.coreSdkVersion)) {
      throw new Error(
        `Plugin ${manifest.id}'s pluginApiVersion (${manifest.pluginApiVersion}) is outside the supported window for core ${options.coreSdkVersion}`,
      );
    }

    try {
      JSON.parse(await readFile(path.join(stagingDir, manifest.sbom), 'utf-8'));
    } catch {
      throw new Error(`Plugin ${manifest.id}'s declared sbom (${manifest.sbom}) is missing or not valid JSON`);
    }

    const tier: TrustTier = manifest.repository ? 'open-source' : 'unverified';

    if (tier === 'open-source') {
      const repo = source.repo ?? parseGithubRepoUrl(manifest.repository as string);
      if (!repo) {
        throw new Error(
          `Plugin ${manifest.id} declares repository "${manifest.repository}" but it isn't a GitHub URL — cannot verify its attestation`,
        );
      }
      const attestation = await verifyGithubArtifactAttestation(repo, zipBytes, {
        ...options.verifyAttestationOptions,
        fetchImpl,
      });
      if (!attestation.verified) {
        throw new Error(`GitHub Artifact Attestation check failed for ${manifest.id}: ${attestation.reason ?? 'unknown reason'}`);
      }
    }

    if (tier === 'unverified') {
      const trustAck = await loadTrustAckFile(options.trustAckFilePath);
      const alreadyAcknowledged = hasAcknowledgedUnverifiedInstall(trustAck, manifest.id, manifest.version);
      if (!alreadyAcknowledged && !options.confirmUnverified) {
        // Not installing (yet) — nothing should be left on disk from this attempt. The caller's
        // eventual confirmUnverified:true call re-downloads and re-validates from scratch.
        await rm(stagingDir, { recursive: true, force: true });
        return { status: 'needs-confirmation', manifest, tier };
      }
      if (!alreadyAcknowledged) {
        await saveTrustAckFile(options.trustAckFilePath, acknowledgeUnverifiedInstall(trustAck, manifest.id, manifest.version));
      }
    }

    // Every check passed — move from the anonymous staging directory to the plugin's real home.
    // A pre-existing directory at that path (a previous install of the same id) is replaced;
    // update/rollback staging (§5) is a separate mechanism, out of this phase's scope.
    const finalDir = path.join(options.pluginsDir, manifest.id);
    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
    installDir = finalDir;

    const moduleUrl = pathToFileURL(path.join(finalDir, manifest.main)).href;
    const loaded = await importModule(moduleUrl);
    const plugin = loaded.default as SourcePlugin | DestinationPlugin;

    const sessionRequirementsCheck = validateSessionRequirements(plugin.sessionRequirements);
    if (!sessionRequirementsCheck.valid) {
      throw new Error(`Plugin ${manifest.id}'s sessionRequirements are invalid: ${sessionRequirementsCheck.errors.join('; ')}`);
    }

    const wizardDataSourcesCheck = validateWizardDataSources(plugin);
    if (!wizardDataSourcesCheck.valid) {
      throw new Error(`Plugin ${manifest.id}'s wizard/settingsPanel is invalid: ${wizardDataSourcesCheck.errors.join('; ')}`);
    }

    options.registry.register(plugin);
    if (plugin.sessionPlugin) {
      options.sessionsRegistry?.registerSessionPlugin(plugin.sessionPlugin);
    }

    return { status: 'installed', manifest, tier };
  } catch (err) {
    await rm(installDir, { recursive: true, force: true });
    throw err;
  }
}

export interface UninstallPluginOptions {
  pluginsDir: string;
  registry: PluginRegistry;
}

/**
 * §5's "Uninstall: preserve, don't delete" — this only unregisters the plugin (so
 * discover()/fetchContent()/upload()/resolveListData() calls have nowhere to route to) and
 * removes its own installed package files. It never touches PluginBackedRecords, invoice history,
 * or Sessions — those stay put, inactive, and come back with no data loss if the same plugin (or
 * a different version of it, via migrate()) is installed again later.
 */
export async function uninstallPlugin(pluginId: string, options: UninstallPluginOptions): Promise<void> {
  options.registry.unregister(pluginId);
  await rm(path.join(options.pluginsDir, pluginId), { recursive: true, force: true });
}
