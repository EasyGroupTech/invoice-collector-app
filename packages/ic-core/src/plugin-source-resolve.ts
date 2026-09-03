import { MIT_COMPATIBLE_LICENSE_IDS } from 'invoice-collector-plugin-sdk';
import { parseGithubRepoUrl, type GithubRepoRef } from './github-attestation.js';

export interface ResolvedInstallSource {
  downloadUrl: string;
  /** Present only for the OSS (plain GitHub URL) path — used by the attestation check that
   * follows download (§9.1). Absent for a direct non-GitHub link or the commercial/encoded path. */
  repo?: GithubRepoRef;
}

export interface ResolveInstallSourceOptions {
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
  /**
   * §9.1: the commercial install token's encoding scheme is explicitly not designed in this
   * OSS-facing repo — a later commercial-specific layer injects real decoding here. Absent, a
   * non-https:// input is treated as already being the resolved URL.
   */
  decodeCommercialInstallToken?: (token: string) => string;
}

interface GithubLicenseResponseBody {
  license?: { spdx_id?: string };
}

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubReleaseResponseBody {
  assets?: GithubReleaseAsset[];
}

async function assertAcceptableRepositoryLicense(
  repo: GithubRepoRef,
  fetchImpl: typeof fetch,
  apiBase: string,
): Promise<void> {
  const response = await fetchImpl(`${apiBase}/repos/${repo.owner}/${repo.repo}/license`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`Could not determine ${repo.owner}/${repo.repo}'s license — refusing to install`);
  }
  const body = (await response.json()) as GithubLicenseResponseBody;
  const spdxId = body.license?.spdx_id;
  if (!spdxId || !MIT_COMPATIBLE_LICENSE_IDS.has(spdxId)) {
    throw new Error(
      `${repo.owner}/${repo.repo}'s declared license (${spdxId ?? 'none detected'}) is not MIT-compatible — refusing to install`,
    );
  }
}

async function resolveLatestReleaseZipAsset(
  repo: GithubRepoRef,
  fetchImpl: typeof fetch,
  apiBase: string,
): Promise<string> {
  const response = await fetchImpl(`${apiBase}/repos/${repo.owner}/${repo.repo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    throw new Error(`Could not find a latest release for ${repo.owner}/${repo.repo}`);
  }
  const body = (await response.json()) as GithubReleaseResponseBody;
  const zipAsset = body.assets?.find((asset) => asset.name.toLowerCase().endsWith('.zip'));
  if (!zipAsset) {
    throw new Error(`${repo.owner}/${repo.repo}'s latest release has no .zip asset to install`);
  }
  return zipAsset.browser_download_url;
}

const DIRECT_ARTIFACT_LINK_PATTERN = /\/releases\/download\/.+\.zip(\?.*)?$/i;

/**
 * Resolves whatever the user typed into the Install Plugin field (§9.1) down to one download URL
 * — a plain https:// GitHub link (repo, releases listing, or direct artifact — all three shapes
 * §9.1 names), a plain https:// link to some other host, or an opaque commercial install token.
 */
export async function resolveInstallSource(
  rawInput: string,
  options: ResolveInstallSourceOptions = {},
): Promise<ResolvedInstallSource> {
  const trimmed = rawInput.trim();
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.githubApiBaseUrl ?? 'https://api.github.com';

  if (!/^https:\/\//i.test(trimmed)) {
    const decoded = options.decodeCommercialInstallToken?.(trimmed) ?? trimmed;
    return { downloadUrl: decoded };
  }

  const repo = parseGithubRepoUrl(trimmed);
  if (!repo) {
    return { downloadUrl: trimmed };
  }

  if (DIRECT_ARTIFACT_LINK_PATTERN.test(trimmed)) {
    return { downloadUrl: trimmed, repo };
  }

  await assertAcceptableRepositoryLicense(repo, fetchImpl, apiBase);
  const downloadUrl = await resolveLatestReleaseZipAsset(repo, fetchImpl, apiBase);
  return { downloadUrl, repo };
}
