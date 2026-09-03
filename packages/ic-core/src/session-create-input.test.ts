import type { SourcePlugin } from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { resolveSessionCreateInput } from './session-create-input.js';

function fakePlugin(overrides: Partial<SourcePlugin> = {}): SourcePlugin {
  return {
    manifest: { id: 'ic-email-to-downloads', name: 'Mail', version: '1.0.0', pluginApiVersion: '^1.0.0', kind: 'source', sbom: 's.json', main: 'i.js' },
    sessionRequirements: [
      {
        sessionTypeId: 'microsoft-entra-delegated-device-code',
        confirmsBuiltIn: true,
        requiredScopesOrRoles: ['Mail.Read'],
      },
    ],
    wizard: [],
    discover: async function* () {},
    fetchContent: vi.fn(),
    ...overrides,
  };
}

describe('resolveSessionCreateInput', () => {
  it('returns the supplied input unchanged when one is given, without consulting the plugin', () => {
    const plugin = fakePlugin({ builtInSessionCreateInput: vi.fn() });
    const result = resolveSessionCreateInput(plugin, 'microsoft-entra-delegated-device-code', { custom: true });
    expect(result).toEqual({ custom: true });
    expect(plugin.builtInSessionCreateInput).not.toHaveBeenCalled();
  });

  it('falls back to the plugin\'s builtInSessionCreateInput when no input is supplied', () => {
    const builtInInput = { deviceAuthorizationEndpoint: 'https://x', tokenEndpoint: 'https://y', clientId: 'id', scope: 'Mail.Read', label: 'Mail' };
    const plugin = fakePlugin({ builtInSessionCreateInput: vi.fn(() => builtInInput) });

    const result = resolveSessionCreateInput(plugin, 'microsoft-entra-delegated-device-code', undefined);

    expect(result).toEqual(builtInInput);
    expect(plugin.builtInSessionCreateInput).toHaveBeenCalledWith(plugin.sessionRequirements[0]);
  });

  it('throws when no input is supplied and the plugin declares no sessionRequirement for that type', () => {
    const plugin = fakePlugin({ builtInSessionCreateInput: vi.fn() });
    expect(() => resolveSessionCreateInput(plugin, 'unknown-type', undefined)).toThrow(
      /does not declare a sessionRequirement/,
    );
  });

  it('throws when no input is supplied and the plugin has no builtInSessionCreateInput', () => {
    const plugin = fakePlugin();
    expect(() => resolveSessionCreateInput(plugin, 'microsoft-entra-delegated-device-code', undefined)).toThrow(
      /has no builtInSessionCreateInput/,
    );
  });
});
