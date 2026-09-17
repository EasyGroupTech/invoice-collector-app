import type { PluginManifest } from 'invoice-collector-plugin-sdk';
import * as semver from 'semver';
import { parseGithubRepoUrl } from './github-attestation.js';

export type PluginUpdateCheckResult =
  | { status: 'up-to-date' }
  | { status: 'update-available'; latestVersion: string }
  /** No repository declared (commercial/unverified tier — phase 2.16's own still-open gap, not
   * this phase's problem to solve), the repository URL didn't parse, the GitHub API call failed,
   * or the response had no usable version — every one of these is "we genuinely don't know",
   * never treated as "no update available". */
  | { status: 'unknown' };

export interface PluginUpdateCheckOptions {
  fetchImpl?: typeof fetch;
  githubApiBaseUrl?: string;
}

interface GithubReleaseResponseBody {
  tag_name?: string;
}

/**
 * §9's update-check (phase 1.23), scoped deliberately to exactly what's discoverable today: an
 * open-source-tier package (manifest.repository set — installPlugin()'s own tier logic makes that
 * the *only* way a package can be open-source tier) has a real "latest version" feed via the same
 * GitHub Releases API plugin-source-resolve.ts's resolveLatestReleaseZipAsset already calls at
 * install time. A commercial/unverified-tier package has no such feed yet — reported as 'unknown',
 * not a false 'up-to-date', since nothing was actually checked.
 */
export async function checkForPluginUpdate(
  manifest: PluginManifest,
  options: PluginUpdateCheckOptions = {},
): Promise<PluginUpdateCheckResult> {
  if (!manifest.repository) return { status: 'unknown' };

  const repo = parseGithubRepoUrl(manifest.repository);
  if (!repo) return { status: 'unknown' };

  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = options.githubApiBaseUrl ?? 'https://api.github.com';

  try {
    const response = await fetchImpl(`${apiBase}/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return { status: 'unknown' };

    const body = (await response.json()) as GithubReleaseResponseBody;
    const latestVersion = body.tag_name ? semver.coerce(body.tag_name)?.version : undefined;
    if (!latestVersion || !semver.valid(manifest.version)) return { status: 'unknown' };

    return semver.gt(latestVersion, manifest.version) ? { status: 'update-available', latestVersion } : { status: 'up-to-date' };
  } catch {
    return { status: 'unknown' };
  }
}
