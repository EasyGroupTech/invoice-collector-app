import type { CycloneDxDocument } from 'invoice-collector-plugin-sdk';

/** One package/plugin's SBOM to resolve — `id` is stable (a plugin's manifest.id, or the fixed
 * strings 'ic-core'/'invoice-collector-plugin-sdk' for the app's own two packages), `label` is
 * what the UI shows. */
export interface SbomSource {
  id: string;
  label: string;
  filePath: string;
}

export interface SbomEntry {
  id: string;
  label: string;
  sbom?: CycloneDxDocument;
  /** Set instead of `sbom` when the file is missing or doesn't parse — one bad/missing file
   * (e.g. an installed plugin predating this feature) shouldn't blank the whole screen. */
  error?: string;
}

/**
 * §13's "Third-Party Licenses" screen aggregates ic-core's own SBOM, the SDK's, and every
 * installed plugin's — this resolves that whole list in parallel, tolerating any individual
 * failure rather than letting one missing/corrupt file take down the others.
 */
export async function loadSboms(sources: SbomSource[], readFile: (filePath: string) => Promise<string>): Promise<SbomEntry[]> {
  return Promise.all(
    sources.map(async (source): Promise<SbomEntry> => {
      try {
        const raw = await readFile(source.filePath);
        const sbom = JSON.parse(raw) as CycloneDxDocument;
        return { id: source.id, label: source.label, sbom };
      } catch (err) {
        return { id: source.id, label: source.label, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
}
