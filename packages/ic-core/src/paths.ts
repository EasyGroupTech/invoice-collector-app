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

/** Backs `PluginContext.appStorage` — install-scoped, not profile-scoped, so a commercial
 * plugin's own one-time license activation (§9.1/§15) survives a profile switch instead of
 * demanding re-activation for every profile that happens to use it. */
export function pluginActivationFile(baseDir: string, pluginId: string): string {
  return path.join(baseDir, 'plugin-activation', `${pluginId}.json`);
}

/** One continuous operational log, not per-profile — a user's click and the activity it triggered
 * should read in the order they actually happened even across a profile switch. */
export function appLogFile(baseDir: string): string {
  return path.join(baseDir, 'logs', 'app.log');
}

/** §7's network audit log (phase 1.22) — same "one continuous file, not per-profile" reasoning
 * as `appLogFile` above: a Collect run's own sequence of real outbound calls should read in
 * order regardless of a profile switch mid-run. Unlike `appLogFile`, this one is always
 * structured JSON (`audit-log.ts`'s own `AuditLogFile`), never free-text. */
export function auditLogFile(baseDir: string): string {
  return path.join(baseDir, 'logs', 'audit-log.json');
}

/** Advanced Settings (§7's HTTP retry policy today) — an app-behavior preference, not profile
 * data, so it lives here rather than in ProfilePaths: switching profiles shouldn't change how
 * retries behave. */
export function advancedSettingsFile(baseDir: string): string {
  return path.join(baseDir, 'advanced-settings.json');
}
