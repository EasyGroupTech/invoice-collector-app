import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  parseGithubRepoUrl,
  verifyGithubArtifactAttestation,
  type VerifyAttestationOptions,
} from './github-attestation.js';

function digestHexOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fakeBundleFor(digestHex: string): unknown {
  const statement = { subject: [{ name: 'artifact.zip', digest: { sha256: digestHex } }] };
  return {
    mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
    dsseEnvelope: {
      payload: Buffer.from(JSON.stringify(statement), 'utf-8').toString('base64'),
      payloadType: 'application/vnd.in-toto+json',
      signatures: [],
    },
    verificationMaterial: { tlogEntries: [] },
  };
}

function fakeGithubApiResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('parseGithubRepoUrl', () => {
  it('parses a bare repository URL', () => {
    expect(parseGithubRepoUrl('https://github.com/EasyGroupTech/invoice-collector-app')).toEqual({
      owner: 'EasyGroupTech',
      repo: 'invoice-collector-app',
    });
  });

  it('parses a URL with a trailing .git', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses a releases/artifact sub-path, taking just owner/repo', () => {
    expect(parseGithubRepoUrl('https://github.com/owner/repo/releases/download/v1.0.0/plugin.zip')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });

  it('returns undefined for a non-GitHub URL', () => {
    expect(parseGithubRepoUrl('https://example.com/owner/repo')).toBeUndefined();
  });
});

describe('verifyGithubArtifactAttestation', () => {
  const repo = { owner: 'owner', repo: 'repo' };
  const artifactBytes = new TextEncoder().encode('a fake plugin package');
  const digestHex = digestHexOf(artifactBytes);

  it('verifies successfully when GitHub returns a matching, cryptographically valid attestation', async () => {
    const bundle = fakeBundleFor(digestHex);
    const fetchImpl = vi.fn(async () => fakeGithubApiResponse(200, { attestations: [{ bundle }] }));
    const verifyImpl = vi.fn(async () => ({}) as never);

    const result = await verifyGithubArtifactAttestation(repo, artifactBytes, { fetchImpl: fetchImpl as unknown as typeof fetch, verifyImpl } as VerifyAttestationOptions);

    expect(result).toEqual({ verified: true });
    expect(verifyImpl).toHaveBeenCalledWith(
      bundle,
      expect.objectContaining({
        certificateIssuer: 'https://token.actions.githubusercontent.com',
        certificateIdentityURI: expect.stringContaining('owner/repo'),
      }),
    );
  });

  it('requests the correct GitHub attestations API URL for the computed digest', async () => {
    const fetchImpl = vi.fn(async () => fakeGithubApiResponse(200, { attestations: [{ bundle: fakeBundleFor(digestHex) }] }));
    await verifyGithubArtifactAttestation(repo, artifactBytes, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      verifyImpl: vi.fn(async () => ({}) as never),
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      `https://api.github.com/repos/owner/repo/attestations/sha256:${digestHex}`,
      expect.anything(),
    );
  });

  it('fails closed when no attestation exists for this artifact (404)', async () => {
    const fetchImpl = vi.fn(async () => fakeGithubApiResponse(404, {}));
    const result = await verifyGithubArtifactAttestation(repo, artifactBytes, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/no attestation/i);
  });

  it('fails closed when the GitHub API errors', async () => {
    const fetchImpl = vi.fn(async () => fakeGithubApiResponse(500, {}));
    const result = await verifyGithubArtifactAttestation(repo, artifactBytes, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.verified).toBe(false);
  });

  it('fails closed when the attestation list is empty', async () => {
    const fetchImpl = vi.fn(async () => fakeGithubApiResponse(200, { attestations: [] }));
    const result = await verifyGithubArtifactAttestation(repo, artifactBytes, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.verified).toBe(false);
  });

  it('fails closed when the attestation subject digest does not match the downloaded bytes', async () => {
    const bundle = fakeBundleFor('0000000000000000000000000000000000000000000000000000000000000000');
    const fetchImpl = vi.fn(async () => fakeGithubApiResponse(200, { attestations: [{ bundle }] }));
    const verifyImpl = vi.fn(async () => ({}) as never);

    const result = await verifyGithubArtifactAttestation(repo, artifactBytes, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      verifyImpl,
    });

    expect(result.verified).toBe(false);
    expect(verifyImpl).not.toHaveBeenCalled(); // never even attempts crypto verification of a mismatched digest
  });

  it('fails closed when sigstore verification itself throws (invalid signature/identity)', async () => {
    const bundle = fakeBundleFor(digestHex);
    const fetchImpl = vi.fn(async () => fakeGithubApiResponse(200, { attestations: [{ bundle }] }));
    const verifyImpl = vi.fn(async () => {
      throw new Error('certificate identity mismatch');
    });

    const result = await verifyGithubArtifactAttestation(repo, artifactBytes, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      verifyImpl,
    });

    expect(result.verified).toBe(false);
  });

  it('tries every returned attestation, succeeding on a later one that matches', async () => {
    const wrongBundle = fakeBundleFor('1111111111111111111111111111111111111111111111111111111111111111');
    const rightBundle = fakeBundleFor(digestHex);
    const fetchImpl = vi.fn(async () =>
      fakeGithubApiResponse(200, { attestations: [{ bundle: wrongBundle }, { bundle: rightBundle }] }),
    );
    const verifyImpl = vi.fn(async () => ({}) as never);

    const result = await verifyGithubArtifactAttestation(repo, artifactBytes, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      verifyImpl,
    });

    expect(result.verified).toBe(true);
    expect(verifyImpl).toHaveBeenCalledTimes(1);
    expect(verifyImpl).toHaveBeenCalledWith(rightBundle, expect.anything());
  });
});
