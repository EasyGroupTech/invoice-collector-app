import type { DestinationPlugin, PluginManifest, SourcePlugin } from 'invoice-collector-plugin-sdk';

export type LoadedPlugin = SourcePlugin | DestinationPlugin;

/**
 * Live in-process registry of loaded plugins (§9.1's install pipeline's final step). Nothing
 * consumes the flat implementation-level API yet — the job runner (phase 1.9) is what will
 * actually call discover()/fetchContent()/upload() on what's registered here — but it's real,
 * testable infrastructure later phases build on, the same position sessions-registry.ts (1.6) was
 * in before HttpApi (1.7) needed it.
 *
 * Tracks two things, deliberately kept separate rather than merged into one shape:
 * - The flat, per-implementation view (`register`/`unregister`/`get`/`list`/`listSources`/
 *   `listDestinations`) — unchanged from before §9.4's package concept existed. Every real
 *   consumer (dispatching a discover()/fetchContent()/upload() call for one specific
 *   PluginBackedRecord.pluginId, or driving the Add-Source/Destination wizard, which needs one row
 *   per *implementation* since a package can bundle more than one) looks a plugin up by its own
 *   implementation id, and that shouldn't have to change just because installs are now
 *   package-scoped.
 * - The package-level view (`registerPackage`/`unregisterPackage`/`getPackage`/`listPackages`) —
 *   §9.4's actual install/uninstall/trust/SBOM unit: "a plugin is a bundle of sessions, sources,
 *   and destinations it implements." `installPlugin()` calls `registerPackage()` once per install,
 *   then `register()` once per implementation the package's manifest declares; `uninstallPlugin()`
 *   reverses both. Settings' own Plugins card (and the SBOM list layered onto it) reads
 *   `listPackages()`, not the flat view, so a package that bundles a source and a destination
 *   together shows up as one row, one Uninstall action, one SBOM entry — not two.
 */
export interface PluginRegistry {
  /**
   * `packageId` is required so `getInstallUrl()` can resolve an implementation back to the
   * package it was installed as part of (§9.1) — an implementation has no other reachable link to
   * its own package once registered.
   */
  register(plugin: LoadedPlugin, packageId: string): void;
  unregister(pluginId: string): void;
  get(pluginId: string): LoadedPlugin | undefined;
  list(): LoadedPlugin[];
  listSources(): SourcePlugin[];
  listDestinations(): DestinationPlugin[];

  /** `installUrl` is the exact URL this package was installed from (§9.1, PluginContext.
   * installUrl) — omitted for a built-in/bundled plugin with no real install step. */
  registerPackage(manifest: PluginManifest, installUrl?: string): void;
  unregisterPackage(packageId: string): void;
  getPackage(packageId: string): PluginManifest | undefined;
  listPackages(): PluginManifest[];
  /** Resolves an implementation's own pluginId back to the install URL of the package it belongs
   * to — undefined if that implementation isn't registered, or its package was never given one. */
  getInstallUrl(pluginId: string): string | undefined;
}

export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, LoadedPlugin>();
  const packages = new Map<string, PluginManifest>();
  const packageIdByImplementationId = new Map<string, string>();
  const installUrlByPackageId = new Map<string, string>();

  return {
    register(plugin, packageId) {
      plugins.set(plugin.manifest.id, plugin);
      packageIdByImplementationId.set(plugin.manifest.id, packageId);
    },

    unregister(pluginId) {
      plugins.delete(pluginId);
      packageIdByImplementationId.delete(pluginId);
    },

    get(pluginId) {
      return plugins.get(pluginId);
    },

    list() {
      return [...plugins.values()];
    },

    listSources() {
      return [...plugins.values()].filter((p): p is SourcePlugin => p.manifest.kind === 'source');
    },

    listDestinations() {
      return [...plugins.values()].filter((p): p is DestinationPlugin => p.manifest.kind === 'destination');
    },

    registerPackage(manifest, installUrl) {
      packages.set(manifest.id, manifest);
      if (installUrl) installUrlByPackageId.set(manifest.id, installUrl);
      else installUrlByPackageId.delete(manifest.id);
    },

    unregisterPackage(packageId) {
      packages.delete(packageId);
      installUrlByPackageId.delete(packageId);
    },

    getPackage(packageId) {
      return packages.get(packageId);
    },

    listPackages() {
      return [...packages.values()];
    },

    getInstallUrl(pluginId) {
      const packageId = packageIdByImplementationId.get(pluginId);
      if (!packageId) return undefined;
      return installUrlByPackageId.get(packageId);
    },
  };
}
