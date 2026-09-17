import type { PluginManifest } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { checkForPluginUpdate } from './plugin-update-check.js';

const baseManifest: PluginManifest = {
  id: 'app.easygroup.test-package',
  name: 'Test Package',
  version: '1.2.0',
  pluginApiVersion: '^1.0.0',
  sbom: 'sbom.cdx.json',
  implementations: [],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('checkForPluginUpdate', () => {
  it('reports unknown for a package with no declared repository — commercial/unverified tier, no discoverable feed', async () => {
    const fetchImpl = vi.fn();
    const result = await checkForPluginUpdate(baseManifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'unknown' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports unknown when the declared repository is not a parseable GitHub URL', async () => {
    const manifest = { ...baseManifest, repository: 'https://gitlab.com/owner/repo' };
    const fetchImpl = vi.fn();
    const result = await checkForPluginUpdate(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'unknown' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports update-available when the latest release tag is newer than the installed version', async () => {
    const manifest = { ...baseManifest, repository: 'https://github.com/owner/repo' };
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('https://api.github.com/repos/owner/repo/releases/latest');
      return jsonResponse(200, { tag_name: 'v1.3.0' });
    });

    const result = await checkForPluginUpdate(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'update-available', latestVersion: '1.3.0' });
  });

  it('reports up-to-date when the latest release tag matches the installed version', async () => {
    const manifest = { ...baseManifest, repository: 'https://github.com/owner/repo' };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { tag_name: 'v1.2.0' }));

    const result = await checkForPluginUpdate(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('reports up-to-date when the latest release is older than the installed version', async () => {
    const manifest = { ...baseManifest, repository: 'https://github.com/owner/repo' };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { tag_name: 'v1.0.0' }));

    const result = await checkForPluginUpdate(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'up-to-date' });
  });

  it('reports unknown when the GitHub API call fails', async () => {
    const manifest = { ...baseManifest, repository: 'https://github.com/owner/repo' };
    const fetchImpl = vi.fn(async () => jsonResponse(404, {}));

    const result = await checkForPluginUpdate(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'unknown' });
  });

  it('reports unknown when the GitHub API call throws (network failure)', async () => {
    const manifest = { ...baseManifest, repository: 'https://github.com/owner/repo' };
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });

    const result = await checkForPluginUpdate(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'unknown' });
  });

  it('reports unknown when the latest release has no usable tag_name', async () => {
    const manifest = { ...baseManifest, repository: 'https://github.com/owner/repo' };
    const fetchImpl = vi.fn(async () => jsonResponse(200, {}));

    const result = await checkForPluginUpdate(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'unknown' });
  });

  it('normalizes a "v"-prefixed tag before comparing', async () => {
    const manifest = { ...baseManifest, repository: 'https://github.com/owner/repo.git' };
    const fetchImpl = vi.fn(async () => jsonResponse(200, { tag_name: 'v2.0.0' }));

    const result = await checkForPluginUpdate(manifest, { fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(result).toEqual({ status: 'update-available', latestVersion: '2.0.0' });
  });
});
