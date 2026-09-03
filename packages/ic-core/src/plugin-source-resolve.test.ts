import { describe, expect, it, vi } from 'vitest';
import { resolveInstallSource } from './plugin-source-resolve.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('resolveInstallSource', () => {
  it('uses a direct GitHub Releases artifact link as-is, no API calls needed', async () => {
    const fetchImpl = vi.fn();
    const result = await resolveInstallSource(
      'https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip',
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(result).toEqual({
      downloadUrl: 'https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip',
      repo: { owner: 'owner', repo: 'repo' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('resolves a bare repository URL to the latest release\'s zip asset, checking the LICENSE first', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === 'https://api.github.com/repos/owner/repo/license') {
        return jsonResponse(200, { license: { spdx_id: 'MIT' } });
      }
      if (url === 'https://api.github.com/repos/owner/repo/releases/latest') {
        return jsonResponse(200, {
          assets: [
            { name: 'checksums.txt', browser_download_url: 'https://example.com/checksums.txt' },
            { name: 'plugin.zip', browser_download_url: 'https://example.com/plugin.zip' },
          ],
        });
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await resolveInstallSource('https://github.com/owner/repo', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ downloadUrl: 'https://example.com/plugin.zip', repo: { owner: 'owner', repo: 'repo' } });
  });

  it('resolves a releases-listing URL the same way as a bare repo URL', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/license')) return jsonResponse(200, { license: { spdx_id: 'Apache-2.0' } });
      if (url.endsWith('/releases/latest')) {
        return jsonResponse(200, { assets: [{ name: 'plugin.zip', browser_download_url: 'https://example.com/plugin.zip' }] });
      }
      throw new Error(`unexpected request to ${url}`);
    });

    const result = await resolveInstallSource('https://github.com/owner/repo/releases', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.downloadUrl).toBe('https://example.com/plugin.zip');
  });

  it('rejects a repository whose declared license is not MIT-compatible', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/license')) return jsonResponse(200, { license: { spdx_id: 'GPL-3.0' } });
      throw new Error(`unexpected request to ${url}`);
    });

    await expect(
      resolveInstallSource('https://github.com/owner/repo', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/license/i);
  });

  it('rejects a repository with no detected license', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(404, {}));
    await expect(
      resolveInstallSource('https://github.com/owner/repo', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/license/i);
  });

  it('rejects a repository whose latest release has no zip asset', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/license')) return jsonResponse(200, { license: { spdx_id: 'MIT' } });
      if (url.endsWith('/releases/latest')) return jsonResponse(200, { assets: [{ name: 'notes.txt', browser_download_url: 'x' }] });
      throw new Error(`unexpected request to ${url}`);
    });

    await expect(
      resolveInstallSource('https://github.com/owner/repo', { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/zip/i);
  });

  it('treats a non-GitHub plain https:// URL as a direct artifact link, no repo/attestation context', async () => {
    const fetchImpl = vi.fn();
    const result = await resolveInstallSource('https://example.com/downloads/plugin.zip', {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ downloadUrl: 'https://example.com/downloads/plugin.zip' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes a non-https input through decodeCommercialInstallToken when provided (§9.1: scheme undefined here)', async () => {
    const decode = vi.fn(() => 'https://commercial.example.com/download?token=abc');
    const result = await resolveInstallSource('opaque-encoded-token', { decodeCommercialInstallToken: decode });

    expect(decode).toHaveBeenCalledWith('opaque-encoded-token');
    expect(result).toEqual({ downloadUrl: 'https://commercial.example.com/download?token=abc' });
  });

  it('without a decoder, treats a non-https input as already being the resolved URL', async () => {
    const result = await resolveInstallSource('opaque-encoded-token');
    expect(result).toEqual({ downloadUrl: 'opaque-encoded-token' });
  });
});
