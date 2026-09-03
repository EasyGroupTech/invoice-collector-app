import path from 'node:path';

/**
 * Every file that lives inside one profile's own directory (§16's isolation: sources,
 * destinations, sessions, history are all per-profile). Electron-agnostic, matching
 * profiles.ts/config-store.ts — the caller resolves `profileDir` (e.g.
 * `profileManager.getActiveProfileDir()`) and passes it in, rather than this module reaching for
 * `app.getPath()` itself.
 */
export interface ProfilePaths {
  configFile: string;
  sessionsFile: string;
  trustAckFile: string;
  invoiceHistoryFile: string;
  pluginStorageFile: (pluginId: string) => string;
}

export function profilePaths(profileDir: string): ProfilePaths {
  return {
    configFile: path.join(profileDir, 'config.json'),
    sessionsFile: path.join(profileDir, 'sessions.json'),
    trustAckFile: path.join(profileDir, 'trust-ack.json'),
    invoiceHistoryFile: path.join(profileDir, 'invoice-history.json'),
    pluginStorageFile: (pluginId) => path.join(profileDir, 'plugin-storage', `${pluginId}.json`),
  };
}

/** Installed plugin code lives once per install, shared across every profile — reinstalling the
 * same plugin per profile would make no sense, only its *data* (via ProfilePaths) is isolated. */
export function pluginsDir(baseDir: string): string {
  return path.join(baseDir, 'plugins');
}

/** One continuous operational log, not per-profile — a user's click and the activity it triggered
 * should read in the order they actually happened even across a profile switch. */
export function appLogFile(baseDir: string): string {
  return path.join(baseDir, 'logs', 'app.log');
}

/** Advanced Settings (§7's HTTP retry policy today) — an app-behavior preference, not profile
 * data, so it lives here rather than in ProfilePaths: switching profiles shouldn't change how
 * retries behave. */
export function advancedSettingsFile(baseDir: string): string {
  return path.join(baseDir, 'advanced-settings.json');
}
