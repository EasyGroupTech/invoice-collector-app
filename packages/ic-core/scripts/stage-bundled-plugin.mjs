#!/usr/bin/env node
// §11's "ic-email-to-downloads bundled into the packaged app" — stages a real, self-contained copy
// of that plugin's build output under packages/ic-core/resources/bundled-plugins/<packageId>/,
// which electron-builder's own `extraResources` config then copies verbatim into the packaged
// app. Not a zip (that's the separate, standalone-download artifact §11 also describes) — just a
// plain directory, matching exactly what bundled-plugins.ts's seedBundledPlugins() expects to
// find at runtime and copy into a real pluginsDir on first boot.
//
// Pure JS, nothing else needed — the plugin has no runtime npm dependency of its own any more
// (phase 1.19's own real fix: it used to bundle `pdf-parse` directly, which ships a native,
// platform-specific binding, and this script's own real `npm install` into the staged directory
// was the only correct way to get a working binary for whatever platform built it — except the
// standalone downloadable zip (§11 item 2) is built once, not per platform, and broke on any
// platform other than whichever one happened to build that release. Fixed at the root: `pdf-parse`
// is `ic-core`'s own dependency now, exposed to any plugin as a real `PluginContext.pdf`
// capability instead — see the SDK's own `PdfApi` doc comment. Nothing platform-specific is ever
// bundled into a plugin's own artifact again.
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const icCoreDir = path.join(here, '..');
const repoRoot = path.join(icCoreDir, '..', '..');
const pluginDir = path.join(repoRoot, 'packages', 'ic-email-to-downloads');

const { PACKAGE_MANIFEST } = await import(pathToFileURL(path.join(pluginDir, 'dist', 'package-manifest.js')).href);

const outDir = path.join(icCoreDir, 'resources', 'bundled-plugins', PACKAGE_MANIFEST.id);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Every compiled implementation entry point, plus every sibling module it imports by relative
// path (graph-mail.js, invoice-text-parsing.js, ...) — manifest.implementations[i].main is
// resolved relative to this directory's own root, exactly like a real installed plugin.
const distDir = path.join(pluginDir, 'dist');
const distEntries = await readdir(distDir);
await Promise.all(
  distEntries
    .filter((name) => name.endsWith('.js') && !name.endsWith('.d.ts'))
    .map((name) => cp(path.join(distDir, name), path.join(outDir, name))),
);

await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(PACKAGE_MANIFEST, null, 2));
await cp(path.join(pluginDir, 'sbom.cdx.json'), path.join(outDir, 'sbom.cdx.json'));

console.log(`Staged bundled plugin "${PACKAGE_MANIFEST.id}" at ${outDir}`);
