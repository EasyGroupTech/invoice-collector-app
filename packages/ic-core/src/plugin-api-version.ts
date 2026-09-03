import * as semver from 'semver';

/**
 * §5's compatibility policy: core supports the last two SDK major versions — the current one and
 * the one before it. A plugin's declared pluginApiVersion is a semver range; it's supported if
 * that range admits any version in either supported major's band.
 */
export function isPluginApiVersionSupported(pluginApiVersionRange: string, coreSdkVersion: string): boolean {
  const currentMajor = semver.major(coreSdkVersion);
  const lowestSupportedMajor = Math.max(currentMajor - 1, 0);
  const supportedBand = `>=${lowestSupportedMajor}.0.0 <${currentMajor + 1}.0.0`;

  try {
    return semver.intersects(pluginApiVersionRange, supportedBand, { includePrerelease: true });
  } catch {
    return false; // not a parseable semver range at all
  }
}
