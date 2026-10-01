/**
 * Scope/audience helpers for OAuth-style sessions. A single access token is issued for exactly one
 * resource ("audience") — a Graph token is rejected by ARM with `Invalid audience` and vice versa —
 * so two consumers sharing one session are only compatible when their scopes resolve to the same
 * audience. Bare scope names ("Mail.Read") are Microsoft Graph's; a fully-qualified scope
 * ("https://management.azure.com/.default") names its own resource.
 */

export const GRAPH_AUDIENCE = 'https://graph.microsoft.com';

/** OIDC/OAuth housekeeping scopes that carry no audience of their own. */
const AUDIENCE_NEUTRAL_SCOPES = new Set(['offline_access', 'openid', 'profile', 'email']);

const AUDIENCE_LABELS: Record<string, string> = {
  [GRAPH_AUDIENCE]: 'Microsoft Graph',
  'https://management.azure.com': 'Azure Resource Manager',
};

/** The audience a scope belongs to, or `undefined` for an audience-neutral one. */
export function audienceOfScope(scope: string): string | undefined {
  if (AUDIENCE_NEUTRAL_SCOPES.has(scope)) return undefined;
  const match = /^(https?:\/\/[^/]+)/i.exec(scope);
  return match ? match[1].toLowerCase() : GRAPH_AUDIENCE;
}

/** Distinct audiences across `scopes`, in first-seen order. */
export function audiencesOfScopes(scopes: readonly string[]): string[] {
  const audiences: string[] = [];
  for (const scope of scopes) {
    const audience = audienceOfScope(scope);
    if (audience && !audiences.includes(audience)) audiences.push(audience);
  }
  return audiences;
}

export function audienceLabel(audience: string): string {
  return AUDIENCE_LABELS[audience] ?? audience;
}

/** Splits a space-separated OAuth `scope` string. */
export function splitScopeString(scope: string): string[] {
  return scope.split(/\s+/).filter(Boolean);
}

/** True when every scope in `required` is already in `granted` (case-insensitive, per OAuth
 * scope handling in Entra). An empty `required` is trivially covered. */
export function scopesCover(granted: readonly string[], required: readonly string[]): boolean {
  const have = new Set(granted.map((s) => s.toLowerCase()));
  return required.every((s) => have.has(s.toLowerCase()));
}

/** Union preserving first-seen order, case-insensitively de-duplicated. */
export function unionScopes(...lists: ReadonlyArray<readonly string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const scope of lists.flat()) {
    const key = scope.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(scope);
    }
  }
  return out;
}
