import { access, cp } from 'node:fs/promises';
import path from 'node:path';

/**
 * Known bundled-plugin package ids — kept as an explicit list rather than reading whatever
 * happens to be under `resourcesPath/bundled-plugins`, so a future second bundled plugin needs a
 * one-line addition here rather than being picked up implicitly by directory presence alone.
 */
export const BUNDLED_PLUGIN_PACKAGE_IDS = ['app.easygroup.email-to-downloads'] as const;

export interface SeedBundledPluginsOptions {
  /** Always `process.resourcesPath` at the real call site — injected so this stays unit-testable
   * with a plain temp directory. In an unpackaged dev run this points inside Electron's own
   * install, which never has a `bundled-plugins` directory, so seeding naturally no-ops there
   * with no `app.isPackaged` check needed. */
  resourcesPath: string;
  pluginsDir: string;
}

/**
 * §11's "`ic-email-to-downloads` bundled into the packaged app ... remains, logically, just an
 * installed plugin like any other" — copies each bundled plugin's already-staged directory
 * (electron-builder's `extraResources`, built by `scripts/stage-bundled-plugin.mjs` — including a
 * real npm-install-produced `node_modules` for any real runtime dependency, never a hand copy;
 * see that script's own doc comment) into the real `pluginsDir`, once, the first time it's
 * missing there. After that it's ordinary installed state — removable/updatable/disableable
 * exactly like a plugin installed through the normal `pluginsInstall` flow, never special-cased
 * again. Deliberately never runs `installPlugin()`'s own network/attestation pipeline —
 * `reloadInstalledPlugins()` (called right after this, at boot) already re-validates manifest
 * shape/`pluginApiVersion` for every package on disk regardless of how it got there, so there's
 * nothing left for this step to re-check.
 */
export async function seedBundledPlugins(options: SeedBundledPluginsOptions): Promise<void> {
  for (const packageId of BUNDLED_PLUGIN_PACKAGE_IDS) {
    const dest = path.join(options.pluginsDir, packageId);

    try {
      await access(path.join(dest, 'manifest.json'));
      continue; // already seeded (or the user installed/reinstalled it themselves) — never overwrite
    } catch {
      // not there yet — fall through to seed it
    }

    const source = path.join(options.resourcesPath, 'bundled-plugins', packageId);
    try {
      await access(source);
    } catch {
      continue; // no staged bundle at this resourcesPath (e.g. an unpackaged dev run) — nothing to seed
    }

    await cp(source, dest, { recursive: true });
  }
}
