import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedBundledPlugins } from './bundled-plugins.js';

const PACKAGE_ID = 'app.easygroup.email-to-downloads';

let dir: string;
let resourcesPath: string;
let pluginsDir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'ic-bundled-plugins-'));
  resourcesPath = path.join(dir, 'resources');
  pluginsDir = path.join(dir, 'plugins');
  await mkdir(pluginsDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function stageFakeBundle(): Promise<void> {
  const bundleDir = path.join(resourcesPath, 'bundled-plugins', PACKAGE_ID);
  await mkdir(path.join(bundleDir, 'node_modules', 'pdf-parse'), { recursive: true });
  await writeFile(path.join(bundleDir, 'manifest.json'), JSON.stringify({ id: PACKAGE_ID, version: '0.0.0' }));
  await writeFile(path.join(bundleDir, 'index.js'), 'export default {};');
  await writeFile(path.join(bundleDir, 'node_modules', 'pdf-parse', 'package.json'), '{"name":"pdf-parse"}');
}

describe('seedBundledPlugins', () => {
  it('copies a staged bundle (including its own node_modules) into pluginsDir when not already there', async () => {
    await stageFakeBundle();

    await seedBundledPlugins({ resourcesPath, pluginsDir });

    const manifest = JSON.parse(await readFile(path.join(pluginsDir, PACKAGE_ID, 'manifest.json'), 'utf-8'));
    expect(manifest.id).toBe(PACKAGE_ID);
    await expect(readFile(path.join(pluginsDir, PACKAGE_ID, 'node_modules', 'pdf-parse', 'package.json'), 'utf-8')).resolves.toContain('pdf-parse');
  });

  it('never overwrites an already-seeded (or user-installed/reinstalled) copy', async () => {
    await stageFakeBundle();
    await mkdir(path.join(pluginsDir, PACKAGE_ID), { recursive: true });
    await writeFile(path.join(pluginsDir, PACKAGE_ID, 'manifest.json'), JSON.stringify({ id: PACKAGE_ID, version: '1.2.3' }));

    await seedBundledPlugins({ resourcesPath, pluginsDir });

    const manifest = JSON.parse(await readFile(path.join(pluginsDir, PACKAGE_ID, 'manifest.json'), 'utf-8'));
    expect(manifest.version).toBe('1.2.3');
  });

  it('no-ops when resourcesPath has no staged bundle (e.g. an unpackaged dev run)', async () => {
    await expect(seedBundledPlugins({ resourcesPath, pluginsDir })).resolves.toBeUndefined();
    await expect(readFile(path.join(pluginsDir, PACKAGE_ID, 'manifest.json'), 'utf-8')).rejects.toThrow();
  });
});
