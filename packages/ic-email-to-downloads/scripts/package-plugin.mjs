#!/usr/bin/env node
// §11 item 2's standalone downloadable plugin bundle — a real installable zip (the same artifact
// shape any third-party plugin would ship), released as a GitHub Release asset so this plugin can
// be updated without a full app release, and so it can be manually installed into an ic-core
// build that doesn't already have it bundled. Distinct from ic-core/scripts/stage-bundled-plugin.mjs
// (phase 1.17), which stages the *same shape* directly into the packaged app's own resources —
// this script's own output is the thing a user (or `installPlugin()`, via a plain https:// link)
// actually downloads.
//
// Pure JS, no runtime npm install needed — real, confirmed-live bug this fixes for good (phase
// 1.19's own follow-up): this zip used to bundle `pdf-parse` directly, which ships a native,
// platform-specific binding; built once on whichever CI runner happened to build a given release,
// it broke outright on any *other* platform trying to install it. Fixed at the root — `pdf-parse`
// is `ic-core`'s own dependency now, exposed to any plugin as a real `PluginContext.pdf`
// capability instead (see the SDK's own `PdfApi` doc comment) — so this plugin has no runtime npm
// dependency of its own left to stage at all, and this same zip genuinely works on every platform.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.join(here, '..');

const { PACKAGE_MANIFEST } = await import(pathToFileURL(path.join(pluginDir, 'dist', 'package-manifest.js')).href);

const releaseDir = path.join(pluginDir, 'release');
const stagingDir = path.join(releaseDir, '.staging');
await rm(stagingDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

// Every compiled implementation entry point, plus every sibling module it imports by relative
// path — manifest.implementations[i].main is resolved relative to this directory's own root,
// exactly like a real installed plugin (see plugin-install.ts's own moduleUrlFor).
const distDir = path.join(pluginDir, 'dist');
const distEntries = await readdir(distDir);
await Promise.all(
  distEntries
    .filter((name) => name.endsWith('.js') && !name.endsWith('.d.ts'))
    .map(async (name) => writeFile(path.join(stagingDir, name), await readFile(path.join(distDir, name)))),
);

await writeFile(path.join(stagingDir, 'manifest.json'), JSON.stringify(PACKAGE_MANIFEST, null, 2));
await writeFile(path.join(stagingDir, 'sbom.cdx.json'), await readFile(path.join(pluginDir, 'sbom.cdx.json')));

async function collectFiles(dir, prefix, files) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await collectFiles(absolute, relative, files);
    else files[relative] = await readFile(absolute);
  }
}

const files = {};
await collectFiles(stagingDir, '', files);
const zipBytes = zipSync(files);

await mkdir(releaseDir, { recursive: true });
const outputPath = path.join(releaseDir, `${PACKAGE_MANIFEST.id}-v${PACKAGE_MANIFEST.version}.zip`);
await writeFile(outputPath, zipBytes);
await rm(stagingDir, { recursive: true, force: true });

console.log(`Packaged ${PACKAGE_MANIFEST.id} v${PACKAGE_MANIFEST.version} -> ${outputPath}`);
