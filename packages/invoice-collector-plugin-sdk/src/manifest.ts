export interface PluginManifest {
  /** Reverse-DNS-style unique id, e.g. "app.easygroup.source.email-mail". */
  id: string;
  name: string;
  /** This plugin's own semver version. */
  version: string;
  /**
   * Semver range this plugin was built against. Core refuses to load a plugin whose range
   * doesn't admit either of the two currently-supported SDK major versions.
   */
  pluginApiVersion: string;
  kind: 'source' | 'destination';
  /**
   * Public git repository URL. Presence is what makes this an OSS-trusted plugin at install
   * time — absence lands it in the unverified tier, regardless of what it actually is.
   */
  repository?: string;
  /**
   * Path within the plugin package to its CycloneDX SBOM (JSON), describing its third-party
   * dependencies and their licenses. Required — core refuses to load a plugin that omits this.
   */
  sbom: string;
}
