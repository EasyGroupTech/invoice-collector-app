#!/usr/bin/env node
// §11's "ic-email-to-downloads bundled into the packaged app" — stages a real, self-contained copy
// of that plugin's build output under packages/ic-core/resources/bundled-plugins/<packageId>/,
// which electron-builder's own `extraResources` config then copies verbatim into the packaged
// app. Not a zip (that's the separate, standalone-download artifact §11 also describes, not built
// yet) — just a plain directory, matching exactly what bundled-plugins.ts's seedBundledPlugins()
// expects to find at runtime and copy into a real pluginsDir on first boot.
//
// Real constraint this script exists to satisfy (docs/architecture-design.md's own noted gap,
// confirmed again while building this): the reference plugin's one genuine runtime npm dependency
// (pdf-parse, for the PDF text-extraction fallback) ships native bindings. A hand `cp -R` of an
// existing node_modules/pdf-parse tree does *not* work — it fails at runtime with "Failed to load
// native binding" because a blind copy doesn't replicate npm's own platform-specific
// optional-dependency resolution. So this script runs a real `npm install` into the staged
// directory instead of copying anything from this repo's own (possibly differently-resolved,
// workspace-hoisted) node_modules — the one and only correct way to get a working native binding
// for the platform actually running this script.
import { execFileSync } from 'node:child_process';
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

// The one real runtime dependency (see the file-level comment above for why this must be a real
// install, never a copy). Pinned to the exact version this repo's own package-lock.json already
// resolves, so the staged bundle isn't testing a different pdf-parse release than the rest of the
// monorepo does.
execFileSync('npm', ['install', 'pdf-parse@2.4.5', '--omit=dev', '--no-save', '--no-package-lock', '--prefix', outDir], {
  stdio: 'inherit',
});

console.log(`Staged bundled plugin "${PACKAGE_MANIFEST.id}" at ${outDir}`);
