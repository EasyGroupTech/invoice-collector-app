/**
 * One session/source/destination implementation a plugin package bundles. Scoped by the package's
 * own `id` for global uniqueness (§9.4) — this id alone only needs to be unique *within* the
 * package, the same way a file only needs a unique name within its own directory.
 */
export interface PluginImplementationManifest {
  /** Reverse-DNS-style, unique within the package, e.g. "app.easygroup.source.email-mail". */
  id: string;
  name: string;
  kind: 'source' | 'destination';
  /**
   * Path within the plugin package to the compiled entry module core dynamically imports. Its
   * default export is this implementation's SourcePlugin/DestinationPlugin object (matching `kind`).
   */
  main: string;
}

/**
 * manifest.json's real shape (§9.4) — one **package** per `.zip`/install, still exactly one
 * GitHub Artifact Attestation-verified artifact per install (§9.1/§9.2 unaffected: attestation
 * covers the whole zip, not any one implementation inside it). A package is the actual
 * install/uninstall unit — "a plugin is a bundle of sessions, sources, and destinations it
 * implements" — so version, trust tier (`repository`), and dependencies (`sbom`) are properties of
 * the *package*, not of any one implementation inside it; they're built, versioned, attested, and
 * removed together.
 */
export interface PluginManifest {
  /** Reverse-DNS-style unique id for this package, e.g. "app.easygroup.email-to-downloads". */
  id: string;
  name: string;
  /** This package's own semver version — shared by every implementation it bundles. */
  version: string;
  /**
   * Semver range this package was built against. Core refuses to load a package whose range
   * doesn't admit either of the two currently-supported SDK major versions.
   */
  pluginApiVersion: string;
  /**
   * Public git repository URL. Presence is what makes this an OSS-trusted package at install
   * time — absence lands it in the unverified tier, regardless of what it actually is.
   */
  repository?: string;
  /**
   * Path within the package to its one shared CycloneDX SBOM (JSON), describing its third-party
   * dependencies and their licenses — one dependency tree for the whole package, not per
   * implementation. Required — core refuses to load a package that omits this.
   */
  sbom: string;
  /** Every session/source/destination this package implements — must list at least one. */
  implementations: PluginImplementationManifest[];
}
