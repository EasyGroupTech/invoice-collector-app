import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { unzipSync } from 'fflate';

/**
 * Extracts a zip archive's bytes into targetDir, defending against Zip Slip (an entry path that
 * escapes the target directory via `../` or an absolute path) — a real, unfixed vulnerability
 * class found in at least one popular Node zip-extraction library while building this (see
 * docs/architecture-design.md §9.4/implementation-plan.md phase 1.8's notes). Deliberately
 * low-level: fflate's
 * unzipSync only ever returns file bytes keyed by their in-archive path, so this function is the
 * *entire* trust boundary between untrusted archive content and the real filesystem — every write
 * goes through the same validated-path check, and nothing here ever calls `symlink()`.
 */
export async function extractZipSafely(zipBytes: Uint8Array, targetDir: string): Promise<void> {
  const resolvedTargetDir = path.resolve(targetDir);
  const entries = unzipSync(zipBytes);

  for (const [entryName, content] of Object.entries(entries)) {
    if (entryName.endsWith('/')) continue; // an explicit directory entry — nothing to write

    if (path.isAbsolute(entryName) || /^[a-zA-Z]:/.test(entryName)) {
      throw new Error(`Zip entry has an absolute path, refusing to extract: "${entryName}"`);
    }

    const destPath = path.resolve(resolvedTargetDir, entryName);
    const withinTarget =
      destPath === resolvedTargetDir || destPath.startsWith(resolvedTargetDir + path.sep);
    if (!withinTarget) {
      throw new Error(`Zip entry escapes the extraction directory (Zip Slip), refusing to extract: "${entryName}"`);
    }

    await mkdir(path.dirname(destPath), { recursive: true });
    await writeFile(destPath, content);
  }
}
