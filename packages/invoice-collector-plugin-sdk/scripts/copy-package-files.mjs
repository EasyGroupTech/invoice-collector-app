#!/usr/bin/env node
// Runs as `npm publish`'s own `prepack` hook — copies the repo's root LICENSE into this package
// directory so it's actually included in the published tarball (npm only auto-includes a LICENSE
// file that's physically present *inside* the package being published, never reaching into a
// monorepo's own root). The package's own README.md is a real, hand-written file already
// committed here, not generated — nothing to do for that.
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(here, '..');
const repoRoot = path.join(packageDir, '..', '..');

await copyFile(path.join(repoRoot, 'LICENSE'), path.join(packageDir, 'LICENSE'));
console.log('Copied LICENSE into the package directory for publishing.');
