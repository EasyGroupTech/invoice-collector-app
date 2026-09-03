import { createHash } from 'node:crypto';
import { verify as sigstoreVerify, type Bundle as SerializedBundle } from 'sigstore';

export interface GithubRepoRef {
  owner: string;
  repo: string;
}

const GITHUB_REPO_URL_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i;

export function parseGithubRepoUrl(url: string): GithubRepoRef | undefined {
  const match = GITHUB_REPO_URL_PATTERN.exec(url.trim());
  if (!match) return undefined;
  return { owner: match[1], repo: match[2] };
}

interface InTotoStatement {
  subject?: Array<{ name?: string; digest?: { sha256?: string } }>;
}

function decodeInTotoStatement(bundle: SerializedBundle): InTotoStatement | undefined {
  if (!bundle.dsseEnvelope) return undefined;
  try {
    const json = Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf-8');
    return JSON.parse(json) as InTotoStatement;
  } catch {
    return undefined;
  }
}

export interface VerifyAttestationOptions {
  fetchImpl?: typeof fetch;
  verifyImpl?: typeof sigstoreVerify;
  githubApiBaseUrl?: string;
}

export interface VerifyAttestationResult {
  verified: boolean;
  reason?: string;
}

interface GithubAttestationsResponseBody {
  attestations?: Array<{ bundle: SerializedBundle }>;
}

/**
 * §9.1's required check for the OSS install path: confirms the exact downloaded artifact was
 * produced by `repo`'s own CI, via a GitHub Artifact Attestation (Sigstore-backed). Fails closed
 * on every ambiguous case (no attestation, API error, digest mismatch, signature/identity
 * mismatch) — a missing or bad attestation is a hard install-blocking failure, not a soft warning.
 */
export async function verifyGithubArtifactAttestation(
  repo: GithubRepoRef,
  artifactBytes: Uint8Array,
  options: VerifyAttestationOptions = {},
): Promise<VerifyAttestationResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const verifyImpl = options.verifyImpl ?? sigstoreVerify;
  const apiBase = options.githubApiBaseUrl ?? 'https://api.github.com';

  const digestHex = createHash('sha256').update(artifactBytes).digest('hex');

  const response = await fetchImpl(`${apiBase}/repos/${repo.owner}/${repo.repo}/attestations/sha256:${digestHex}`, {
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (response.status === 404) {
    return { verified: false, reason: 'No attestation found for this artifact' };
  }
  if (!response.ok) {
    return { verified: false, reason: `GitHub attestations API returned status ${response.status}` };
  }

  const body = (await response.json()) as GithubAttestationsResponseBody;
  const attestations = body.attestations ?? [];
  if (attestations.length === 0) {
    return { verified: false, reason: 'No attestation found for this artifact' };
  }

  const certificateIssuer = 'https://token.actions.githubusercontent.com';
  const certificateIdentityURI = `^https://github\\.com/${repo.owner}/${repo.repo}/`;

  for (const attestation of attestations) {
    const statement = decodeInTotoStatement(attestation.bundle);
    if (statement?.subject?.[0]?.digest?.sha256 !== digestHex) {
      continue; // this attestation's own claimed subject isn't this exact artifact
    }

    try {
      await verifyImpl(attestation.bundle, { certificateIssuer, certificateIdentityURI });
      return { verified: true };
    } catch {
      continue; // signature/identity verification failed — try any other returned attestation
    }
  }

  return { verified: false, reason: 'No attestation matched this artifact and repository' };
}
