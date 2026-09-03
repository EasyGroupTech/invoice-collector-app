import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { advancedSettingsFile, appLogFile, pluginsDir, profilePaths } from './paths.js';

describe('profilePaths', () => {
  const dir = '/base/profiles/default';
  const paths = profilePaths(dir);

  it('resolves every per-profile file under the given profile directory', () => {
    expect(paths.configFile).toBe(path.join(dir, 'config.json'));
    expect(paths.sessionsFile).toBe(path.join(dir, 'sessions.json'));
    expect(paths.trustAckFile).toBe(path.join(dir, 'trust-ack.json'));
    expect(paths.invoiceHistoryFile).toBe(path.join(dir, 'invoice-history.json'));
  });

  it('resolves a distinct plugin-storage file per pluginId', () => {
    const a = paths.pluginStorageFile('app.easygroup.source.email-mail');
    const b = paths.pluginStorageFile('app.easygroup.destination.local-downloads');
    expect(a).not.toBe(b);
    expect(a).toBe(path.join(dir, 'plugin-storage', 'app.easygroup.source.email-mail.json'));
  });
});

describe('pluginsDir', () => {
  it('resolves under the base dir, not per-profile — plugin code is shared across profiles', () => {
    expect(pluginsDir('/base')).toBe(path.join('/base', 'plugins'));
  });
});

describe('appLogFile', () => {
  it('resolves under the base dir, not per-profile — one continuous operational log', () => {
    expect(appLogFile('/base')).toBe(path.join('/base', 'logs', 'app.log'));
  });
});

describe('advancedSettingsFile', () => {
  it('resolves under the base dir, not per-profile — an app behavior preference, not profile data', () => {
    expect(advancedSettingsFile('/base')).toBe(path.join('/base', 'advanced-settings.json'));
  });
});
