import { describe, expect, it } from 'vitest';
import type { PluginBackedRecord, Session, SessionRequirement } from 'invoice-collector-plugin-sdk';
import { computeSessionUsage, sessionCoversScopes, sessionServesRequirement } from './session-usage.js';

const TYPE = 'microsoft-entra-delegated-device-code';

function session(scopes?: string[]): Session {
  return { id: 's1', sessionTypeId: TYPE, label: 'Sign-in', createdByPluginId: 'p', createdAt: '', updatedAt: '', status: 'active', scopes };
}
function record(id: string, pluginId: string, extra: Partial<PluginBackedRecord> = {}): PluginBackedRecord {
  return { id, name: id, pluginId, pluginVersion: '1', config: {}, createdAt: '', updatedAt: '', sessionId: 's1', ...extra } as PluginBackedRecord;
}
function req(scopes: string[]): SessionRequirement {
  return { sessionTypeId: TYPE, confirmsBuiltIn: true, requiredScopesOrRoles: scopes, collects: '', connectHow: '', connectInstructions: '' };
}
const requirements: Record<string, SessionRequirement> = {
  mail: req(['Mail.Read']),
  sharepoint: req(['Sites.ReadWrite.All', 'Files.ReadWrite.All']),
  azure: req(['https://management.azure.com/.default']),
};
const lookup = { requirementFor: (pluginId: string) => requirements[pluginId], pluginName: (id: string) => id };

describe('computeSessionUsage', () => {
  it('lists consumers with their flows and unions same-audience scopes', () => {
    const usage = computeSessionUsage(
      session(['Mail.Read', 'offline_access']),
      [record('inbox', 'mail', { destinationId: 'sp' })],
      [record('sp', 'sharepoint')],
      lookup,
    );
    expect(usage.consumers.map((c) => [c.kind, c.id, c.flows])).toEqual([
      ['source', 'inbox', ['inbox']],
      ['destination', 'sp', ['inbox']],
    ]);
    expect(usage.requiredScopes).toEqual(['Mail.Read', 'Sites.ReadWrite.All', 'Files.ReadWrite.All']);
    expect(usage.audienceConflict).toBe(false);
  });

  it('flags consumers that need different audiences', () => {
    const usage = computeSessionUsage(session(['Mail.Read']), [record('inbox', 'mail'), record('bill', 'azure')], [], lookup);
    expect(usage.audienceConflict).toBe(true);
    expect(usage.audienceLabels).toEqual(['Microsoft Graph', 'Azure Resource Manager']);
  });

  it('reports no scopes for a session type without scope tracking', () => {
    const usage = computeSessionUsage(session(undefined), [record('inbox', 'mail')], [], lookup);
    expect(usage.requiredScopes).toEqual([]);
    expect(usage.audienceConflict).toBe(false);
  });
});

describe('sessionServesRequirement', () => {
  it('rejects a Graph-only session for an ARM requirement (the Invalid audience case)', () => {
    expect(sessionServesRequirement(session(['Mail.Read', 'offline_access']), requirements.azure)).toBe(false);
  });
  it('accepts a same-audience session even if it needs wider scopes', () => {
    expect(sessionServesRequirement(session(['Mail.Read']), requirements.sharepoint)).toBe(true);
  });
  it('gives sessions with unknown scopes the benefit of the doubt', () => {
    expect(sessionServesRequirement(session(undefined), requirements.azure)).toBe(true);
  });
});

describe('sessionCoversScopes', () => {
  it('is case-insensitive and false when scopes are unknown', () => {
    expect(sessionCoversScopes(session(['mail.read']), ['Mail.Read'])).toBe(true);
    expect(sessionCoversScopes(session(['Mail.Read']), ['Sites.ReadWrite.All'])).toBe(false);
    expect(sessionCoversScopes(session(undefined), ['Mail.Read'])).toBe(false);
  });
});
