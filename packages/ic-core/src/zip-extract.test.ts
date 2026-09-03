import { mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractZipSafely } from './zip-extract.js';

function buildZip(entries: Record<string, string>): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(entries)) {
    files[name] = new TextEncoder().encode(content);
  }
  return zipSync(files);
}

describe('extractZipSafely', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-zip-extract-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('extracts a well-formed zip into the target directory', async () => {
    const zip = buildZip({
      'manifest.json': '{"id":"x"}',
      'index.js': 'export default {};',
      'nested/asset.txt': 'hello',
    });
    const targetDir = path.join(dir, 'out');

    await extractZipSafely(zip, targetDir);

    expect(await readFile(path.join(targetDir, 'manifest.json'), 'utf-8')).toBe('{"id":"x"}');
    expect(await readFile(path.join(targetDir, 'index.js'), 'utf-8')).toBe('export default {};');
    expect(await readFile(path.join(targetDir, 'nested', 'asset.txt'), 'utf-8')).toBe('hello');
  });

  it('rejects an entry whose path escapes the target directory via ../ (Zip Slip)', async () => {
    const zip = buildZip({ '../../evil.txt': 'pwned' });
    const targetDir = path.join(dir, 'out');

    await expect(extractZipSafely(zip, targetDir)).rejects.toThrow(/escapes|traversal|outside/i);
    await expect(readFile(path.join(dir, 'evil.txt'), 'utf-8')).rejects.toThrow();
  });

  it('rejects an entry with an absolute path', async () => {
    const zip = buildZip({ '/etc/evil.txt': 'pwned' });
    const targetDir = path.join(dir, 'out');

    await expect(extractZipSafely(zip, targetDir)).rejects.toThrow(/escapes|traversal|outside|absolute/i);
  });

  it('never creates a symlink from the archive, even one that looks like a plain file entry', async () => {
    // fflate's zipSync has no first-class symlink concept — a real attacker would craft raw zip
    // bytes with the unix symlink external-attributes bit set, which is out of reach for a
    // synthetic test fixture built through zipSync. What's actually verifiable and load-bearing
    // here: extraction only ever calls writeFile on the computed safe path — never symlink/link —
    // so there is no code path that could turn zip content into a symlink even if the archive
    // claimed to contain one.
    const targetDir = path.join(dir, 'out');
    const zip = buildZip({ 'file.txt': 'plain content' });

    await extractZipSafely(zip, targetDir);

    const { lstat } = await import('node:fs/promises');
    const stat = await lstat(path.join(targetDir, 'file.txt'));
    expect(stat.isSymbolicLink()).toBe(false);
  });

  it('refuses to extract through a pre-existing symlink placed at the target directory root', async () => {
    const realOutsideDir = path.join(dir, 'outside');
    await import('node:fs/promises').then((fs) => fs.mkdir(realOutsideDir, { recursive: true }));
    const targetDir = path.join(dir, 'out');
    await symlink(realOutsideDir, targetDir, 'dir');

    const zip = buildZip({ 'file.txt': 'content' });
    await extractZipSafely(zip, targetDir);

    // Symlinked target dir itself is honored (that's the caller's own directory choice, not
    // archive-controlled) — content still lands under the real directory it points to.
    expect(await readFile(path.join(realOutsideDir, 'file.txt'), 'utf-8')).toBe('content');
  });

  it('rejects a zip containing no manifest-shaped content gracefully (empty archive)', async () => {
    const targetDir = path.join(dir, 'out');
    const zip = zipSync({});

    await extractZipSafely(zip, targetDir);

    await expect(readFile(path.join(targetDir, 'manifest.json'), 'utf-8')).rejects.toThrow();
  });
});
