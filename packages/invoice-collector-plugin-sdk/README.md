# invoice-collector-plugin-sdk

The plugin interface for [Invoice Collector](https://github.com/EasyGroupTech/invoice-collector-app) — build a source (a cloud service, a mailbox) or destination (a shared drive, a storage backend) plugin against this package, and it runs identically to any built-in or commercial one. The core app has no integrations of its own; every source and destination is a plugin.

```
npm install --save-dev invoice-collector-plugin-sdk
```

## What's in this package

- **`SourcePlugin` / `DestinationPlugin`** — the contract every integration implements: a manifest, declared `sessionRequirements`, a declarative `wizard` (config UI, described via `WizardStepDescriptor` — there's no UI component kit to build against), and `discover()`/`fetchContent()` (source) or `upload()` (destination).
- **`Session` / `SessionPlugin` / `SessionsApi`** — the shared "established connection" concept. Use one of the SDK's own built-ins (currently `microsoft-entra-delegated-device-code`) via `confirmsBuiltIn: true`, or bring your own custom session type via `sessionPlugin`.
- **`PluginContext`** — what a plugin actually gets at runtime: `sessions`, per-plugin `storage`, an install-scoped `appStorage`, a redaction-aware `http` client (`HttpApi`), `log`, and `progress`.
- **Declarative UI descriptors** (`FieldDescriptor`, `ListDescriptor`, `TextSelectDescriptor`, ...) — a plugin's config wizard and settings panel are described as data, rendered by core's own React components. No custom rendering code, ever.
- **`validateManifest` / `validateSessionRequirements` / `validateWizardDataSources`** — the same validation core's own install pipeline runs; use these in your own tests before shipping.
- **`generateSbom`** (and the bundled `generate-sbom` CLI) — produces your plugin's own CycloneDX SBOM and checks every dependency against an MIT-compatible license allowlist. Core requires a plugin to declare one, and this is the tool that builds it.
- **`microsoftEntraDelegatedDeviceCodeSessionPlugin`** — the one built-in `SessionPlugin` this SDK ships a real implementation for, importable directly if your plugin uses it.

## Compatibility

Each package declares a `pluginApiVersion` semver range in its manifest — core supports the current major and the one before it. See `PluginManifest` and the main repo's `docs/architecture-design.md` §5 for the full contract.

## Trust tiers

A plugin whose manifest declares a public `repository` installs as **open source** (verified via a required GitHub Artifact Attestation on the release artifact); anything else installs as **unverified**, with an explicit user confirmation. See `docs/architecture-design.md` §9 in the main repo for the full model.

## Building a plugin

The reference implementation — [`ic-email-to-downloads`](https://github.com/EasyGroupTech/invoice-collector-app/tree/main/packages/ic-email-to-downloads) in the main repo — is a complete, real example: a Graph Mail source plus a local-folder destination, built against this exact SDK.

## License

MIT
