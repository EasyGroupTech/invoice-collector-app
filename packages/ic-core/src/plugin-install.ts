import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  validateManifest,
  validateSessionRequirements,
  validateWizardDataSources,
  type DestinationPlugin,
  type FieldDescriptor,
  type PluginImplementationManifest,
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
  /**
   * Present when this package (any one of its bundled implementations — see `installPlugin`'s own
   * loop) declares an `ActivationRequirement` (§9.1/§15) — the caller collects `fields` once, right
   * now, and calls `PluginsActivate` with `pluginId` before considering install fully done.
   * Undefined for a package with nothing to activate.
   */
  activationRequirement?: { pluginId: string; fields: FieldDescriptor[] };
}

/**
 * Returned instead of installing when the package lands in the Unverified tier (§9) and hasn't
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
   * Where an implementation's own `sessionPlugin` (§6 — a custom session type it brings itself,
   * e.g. a local-filesystem destination's folder-access session) gets registered so
   * `SessionsApi.create()` can actually route to it. Optional, matching this field itself being
   * optional: an implementation with no `sessionPlugin` needs nothing registered, and a caller not
   * yet wired up to a real SessionsRegistry (nothing has been, before this) just skips this step
   * rather than failing — install still succeeds, but that session type won't be creatable until a
   * caller starts supplying one.
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
 * pluginApiVersion window, sbom present/parseable) → GitHub Artifact Attestation (OSS path only,
 * covering the whole downloaded zip — one attestation per package, not per implementation) →
 * trust-tier decision → dynamic import of every implementation the manifest declares →
 * sessionRequirements validation → register (§9.4: the package itself, then each implementation it
 * bundles, then each implementation's own `sessionPlugin`, if any).
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
        `Package ${manifest.id}'s pluginApiVersion (${manifest.pluginApiVersion}) is outside the supported window for core ${options.coreSdkVersion}`,
      );
    }

    try {
      JSON.parse(await readFile(path.join(stagingDir, manifest.sbom), 'utf-8'));
    } catch {
      throw new Error(`Package ${manifest.id}'s declared sbom (${manifest.sbom}) is missing or not valid JSON`);
    }

    const tier: TrustTier = manifest.repository ? 'open-source' : 'unverified';

    if (tier === 'open-source') {
      const repo = source.repo ?? parseGithubRepoUrl(manifest.repository as string);
      if (!repo) {
        throw new Error(
          `Package ${manifest.id} declares repository "${manifest.repository}" but it isn't a GitHub URL — cannot verify its attestation`,
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

    // Every check passed — move from the anonymous staging directory to the package's real home.
    // A pre-existing directory at that path (a previous install of the same id) is replaced;
    // update/rollback staging (§5) is a separate mechanism, out of this phase's scope.
    const finalDir = path.join(options.pluginsDir, manifest.id);
    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
    installDir = finalDir;

    // Must run before the implementations are imported below — see hoistVendoredDependencies's
    // own doc comment for why this makes a shared dependency's fix apply to every already-
    // installed plugin using it, not just whichever one happens to be reinstalled.
    await hoistVendoredDependencies(options.pluginsDir, finalDir);

    // Persisted alongside manifest.json so reloadInstalledPlugins() can restore it on the next
    // boot too — PluginRegistry's own installUrl tracking is in-memory only, and a commercial
    // plugin reading its own license/purchase query params off this URL (§15, PluginContext.
    // installUrl) needs that to survive a restart, not just the process that installed it.
    await writeFile(path.join(finalDir, 'install-source.json'), JSON.stringify({ downloadUrl: source.downloadUrl }));

    // First implementation (in manifest order) that declares one — §9.4's package-scoped
    // ActivationRequirement only ever needs to be declared once per package, even one bundling
    // several implementations.
    let activationRequirement: PluginInstallResult['activationRequirement'];
    for (const implementation of manifest.implementations) {
      const moduleUrl = pathToFileURL(path.join(finalDir, implementation.main)).href;
      const loaded = await importModule(moduleUrl);
      const plugin = loaded.default as SourcePlugin | DestinationPlugin;
      validateAndRegisterPlugin(implementation, plugin, options.registry, manifest.id, options.sessionsRegistry);
      if (!activationRequirement && plugin.activationRequirement) {
        activationRequirement = { pluginId: plugin.manifest.id, fields: plugin.activationRequirement.fields };
      }
    }
    options.registry.registerPackage(manifest, source.downloadUrl);

    return { status: 'installed', manifest, tier, activationRequirement };
  } catch (err) {
    await rm(installDir, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Hoists a freshly-installed package's own vendored `node_modules/<dep>` directories up to a
 * single shared `<pluginsDir>/node_modules/<dep>`, the same way an npm workspace hoists a shared
 * dependency to its root instead of duplicating it under every package that needs it — Node's own
 * module resolution already walks up through every ancestor directory's `node_modules` looking for
 * a bare specifier, so a plugin's `import 'license-check'` keeps resolving with no change to the
 * plugin's own code, just to *where* the file it resolves to actually lives.
 *
 * Real bug this closes: a commercial plugin package (§9.4) vendors internal dependencies it needs
 * at runtime (`license-check`, `browser-session-capture`, …) into its own zip at package time
 * (`tools/package-plugin.mjs`, private repo) — confirmed live that fixing a real bug in one of
 * those shared dependencies (license-check's activation storage moving from profile- to
 * install-scoped) only ever took effect for whichever *specific* plugin package happened to be
 * reinstalled afterward; every other already-installed package kept running its own frozen,
 * now-stale vendored copy indefinitely, with no way to fix it short of individually reinstalling
 * every single one. Hoisting to one shared location means the *next* install of *any* plugin that
 * bundles a newer copy of a given dependency upgrades it for every plugin that uses it, not just
 * itself.
 *
 * Deliberately "last install wins" with no version reconciliation: every commercial plugin in this
 * ecosystem is built from the same private monorepo and released in lockstep in practice, so two
 * packages vendoring genuinely different versions of the same shared dependency isn't a real
 * scenario worth the complexity of solving here — an accepted, deliberate trade-off, not an
 * oversight.
 */
async function hoistVendoredDependencies(pluginsDir: string, finalDir: string): Promise<void> {
  const vendoredDir = path.join(finalDir, 'node_modules');
  let depNames: string[];
  try {
    depNames = await readdir(vendoredDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  const sharedNodeModules = path.join(pluginsDir, 'node_modules');
  await mkdir(sharedNodeModules, { recursive: true });
  for (const depName of depNames) {
    const target = path.join(sharedNodeModules, depName);
    await rm(target, { recursive: true, force: true });
    await rename(path.join(vendoredDir, depName), target);
  }
  await rm(vendoredDir, { recursive: true, force: true });
}

/** Shared by `installPlugin()` and `reloadInstalledPlugins()` — the part of the pipeline that
 * runs once one implementation's code has actually been loaded (fresh from a download, or
 * reloaded from an earlier install already sitting on disk): validate its declared shape against
 * what the loaded module actually exports, then register it (and its own `sessionPlugin`, if
 * any). Called once per `manifest.implementations` entry, not once per package. */
function validateAndRegisterPlugin(
  implementation: PluginImplementationManifest,
  plugin: SourcePlugin | DestinationPlugin,
  registry: PluginRegistry,
  packageId: string,
  sessionsRegistry?: SessionsRegistry,
): void {
  const sessionRequirementsCheck = validateSessionRequirements(plugin.sessionRequirements);
  if (!sessionRequirementsCheck.valid) {
    throw new Error(`Implementation ${implementation.id}'s sessionRequirements are invalid: ${sessionRequirementsCheck.errors.join('; ')}`);
  }

  const wizardDataSourcesCheck = validateWizardDataSources(plugin);
  if (!wizardDataSourcesCheck.valid) {
    throw new Error(`Implementation ${implementation.id}'s wizard/settingsPanel is invalid: ${wizardDataSourcesCheck.errors.join('; ')}`);
  }

  registry.register(plugin, packageId);
  if (plugin.sessionPlugin) {
    sessionsRegistry?.registerSessionPlugin(plugin.sessionPlugin);
  }
}

export interface ReloadInstalledPluginsOptions {
  pluginsDir: string;
  coreSdkVersion: string;
  registry: PluginRegistry;
  sessionsRegistry?: SessionsRegistry;
  importModule?: (fileUrl: string) => Promise<{ default: unknown }>;
  /** Called for a package directory that couldn't be reloaded (corrupt manifest, code that no
   * longer imports cleanly, a pluginApiVersion the current core no longer supports, …) — one bad
   * package must never take the rest of them (or the app's own boot) down with it. */
  onError?: (packageId: string, error: unknown) => void;
}

/**
 * The other half of §5's "plugins aren't reloaded from disk at boot yet" gap (tracked since phase
 * 1.11/1.12) — a package installed in an earlier run leaves its files under `pluginsDir` (§9.1's
 * install pipeline never deletes them, "Uninstall: preserve, don't delete" applies just as much to
 * an unclean shutdown as a deliberate uninstall), but nothing re-registers them into a fresh
 * `PluginRegistry`/`SessionsRegistry` on the next launch — call this once at boot, after both
 * registries exist, to close that gap generically for whatever's actually on disk, not for one
 * specific package. Deliberately skips the parts of `installPlugin()` that only make sense for a
 * *fresh* install (download, GitHub Artifact Attestation, the unverified-tier trust-ack prompt) —
 * a package already sitting here was already vetted once; `pluginApiVersion` is the one check
 * worth re-running, since a core upgrade since the last launch could have moved it outside the
 * supported window (§9's own "surfaced as this plugin needs updating rather than silently
 * dropped").
 */
export async function reloadInstalledPlugins(options: ReloadInstalledPluginsOptions): Promise<void> {
  const importModule = options.importModule ?? ((url: string) => import(url));

  let entries: string[];
  try {
    entries = await readdir(options.pluginsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }

  for (const entryName of entries) {
    // '.staging-' is installPlugin()'s own anonymous in-progress extraction dir; 'node_modules' is
    // hoistVendoredDependencies()'s shared location for vendored internal dependencies — neither
    // is a package directory (no manifest.json), so trying to reload either as one is a guaranteed,
    // harmless-but-noisy ENOENT on every single boot, not a real per-package failure worth onError().
    if (entryName.startsWith('.staging-') || entryName === 'node_modules') continue;
    const packageDir = path.join(options.pluginsDir, entryName);

    try {
      const manifest = JSON.parse(await readFile(path.join(packageDir, 'manifest.json'), 'utf-8')) as PluginManifest;

      const manifestCheck = validateManifest(manifest);
      if (!manifestCheck.valid) {
        throw new Error(`Invalid plugin manifest: ${manifestCheck.errors.join('; ')}`);
      }

      if (!isPluginApiVersionSupported(manifest.pluginApiVersion, options.coreSdkVersion)) {
        throw new Error(
          `Package ${manifest.id}'s pluginApiVersion (${manifest.pluginApiVersion}) is outside the supported window for core ${options.coreSdkVersion}`,
        );
      }

      // Absent for a package installed before install-source.json existed — installUrl then
      // stays undefined for it after a reload, same as it would for any plugin with no real
      // install step; not a new failure mode, just a narrower one than before this file existed.
      let installUrl: string | undefined;
      try {
        const installSource = JSON.parse(await readFile(path.join(packageDir, 'install-source.json'), 'utf-8')) as { downloadUrl?: string };
        installUrl = installSource.downloadUrl;
      } catch {
        // Missing or unparsable — leave installUrl undefined rather than failing the whole reload.
      }

      for (const implementation of manifest.implementations) {
        const moduleUrl = pathToFileURL(path.join(packageDir, implementation.main)).href;
        const loaded = await importModule(moduleUrl);
        const plugin = loaded.default as SourcePlugin | DestinationPlugin;
        validateAndRegisterPlugin(implementation, plugin, options.registry, manifest.id, options.sessionsRegistry);
      }
      options.registry.registerPackage(manifest, installUrl);
    } catch (err) {
      options.onError?.(entryName, err);
    }
  }
}

export interface UninstallPluginOptions {
  pluginsDir: string;
  registry: PluginRegistry;
}

/**
 * §5's "Uninstall: preserve, don't delete" — this only unregisters the package (every
 * implementation it bundles at once, §9.4 — so discover()/fetchContent()/upload()/
 * resolveListData() calls have nowhere to route to for any of them) and removes its own installed
 * package files. It never touches PluginBackedRecords, invoice history, or Sessions — those stay
 * put, inactive, and come back with no data loss if the same package (or a different version of
 * it, via migrate()) is installed again later. Also, deliberately, never touches the shared
 * `<pluginsDir>/node_modules` a plugin's own dependencies were hoisted into at install time
 * (`hoistVendoredDependencies`) — another still-installed package may depend on the exact same
 * shared dependency, and there's no cheap way from here to know whether it's the last one using it.
 */
export async function uninstallPlugin(packageId: string, options: UninstallPluginOptions): Promise<void> {
  const manifest = options.registry.getPackage(packageId);
  for (const implementation of manifest?.implementations ?? []) {
    options.registry.unregister(implementation.id);
  }
  options.registry.unregisterPackage(packageId);
  await rm(path.join(options.pluginsDir, packageId), { recursive: true, force: true });
}
