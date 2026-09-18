import type { PluginManifest } from 'invoice-collector-plugin-sdk';

/**
 * §9.4's package-level manifest.json shape for this whole package — one bundle, one install/
 * uninstall/trust/SBOM unit, wrapping both `graphMailSource` (plugin.ts) and
 * `localFolderDestination` (local-folder-plugin.ts) as its two `implementations`. Not yet fed into
 * a real zip-packaging step (phase 1.17's own concern, still not built — see plugin.ts's own doc
 * comment); this is the authoritative source for what that step's `manifest.json` output should
 * contain once it exists.
 */
export const PACKAGE_MANIFEST: PluginManifest = {
  id: 'app.easygroup.email-to-downloads',
  name: 'Microsoft Graph Email to Downloads',
  version: '0.1.0',
  pluginApiVersion: '^0.1.0',
  // Genuinely true — this bundled reference plugin lives in this same public repo (§2/§9).
  repository: 'https://github.com/EasyGroupTech/invoice-collector-app',
  sbom: 'sbom.cdx.json',
  implementations: [
    { id: 'app.easygroup.source.email-mail', name: 'Graph Mail', kind: 'source', main: 'index.js' },
    { id: 'app.easygroup.destination.local-folder', name: 'Local Folder', kind: 'destination', main: 'local-folder-plugin.js' },
  ],
};
