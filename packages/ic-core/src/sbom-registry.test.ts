import { describe, expect, it, vi } from 'vitest';
import { loadSboms, type SbomSource } from './sbom-registry.js';

const sources: SbomSource[] = [
  { id: 'ic-core', label: 'ic-core', filePath: '/repo/packages/ic-core/sbom.cdx.json' },
  { id: 'invoice-collector-plugin-sdk', label: 'invoice-collector-plugin-sdk', filePath: '/repo/packages/invoice-collector-plugin-sdk/sbom.cdx.json' },
  { id: 'a.plugin', label: 'A Plugin', filePath: '/plugins/a.plugin/sbom.cdx.json' },
];

describe('loadSboms', () => {
  it('parses every source that reads successfully', async () => {
    const readFile = vi.fn(async (filePath: string) =>
      JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [{ name: filePath }] }),
    );

    const entries = await loadSboms(sources, readFile);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      id: 'ic-core',
      label: 'ic-core',
      sbom: { bomFormat: 'CycloneDX', specVersion: '1.6', components: [{ name: sources[0].filePath }] },
    });
  });

  it('reports an error for a source instead of throwing, when the file is missing', async () => {
    const readFile = vi.fn(async (filePath: string) => {
      if (filePath === sources[2].filePath) throw new Error('ENOENT: no such file');
      return JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', components: [] });
    });

    const entries = await loadSboms(sources, readFile);

    expect(entries[0].sbom).toBeDefined();
    expect(entries[1].sbom).toBeDefined();
    expect(entries[2]).toEqual({ id: 'a.plugin', label: 'A Plugin', error: 'ENOENT: no such file' });
  });

  it('reports an error instead of throwing when the file is not valid JSON', async () => {
    const readFile = vi.fn(async () => 'not json');

    const entries = await loadSboms([sources[0]], readFile);

    expect(entries[0].sbom).toBeUndefined();
    expect(entries[0].error).toBeTruthy();
  });

  it('returns an empty array for no sources', async () => {
    await expect(loadSboms([], vi.fn())).resolves.toEqual([]);
  });
});
