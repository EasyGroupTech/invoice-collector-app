import type { PluginBackedRecord, Session, SessionRequirement } from 'invoice-collector-plugin-sdk';
import { audienceLabel, audiencesOfScopes, scopesCover, unionScopes } from 'invoice-collector-plugin-sdk/dist/scopes.js';

/** One source or destination record that uses a session, and which collection flow(s) it is part
 * of — a source *is* its flow; a destination belongs to every flow whose source points at it. */
export interface SessionConsumer {
  kind: 'source' | 'destination';
  id: string;
  name: string;
  pluginId: string;
  pluginName: string;
  flows: string[];
  /** What this consumer's plugin declared it needs from a session of this type. */
  requiredScopes: string[];
}

export interface SessionUsage {
  sessionId: string;
  consumers: SessionConsumer[];
  /** Union of every consumer's `requiredScopes`; empty for a session type with no scope concept
   * (`Session.scopes` unset), where scopes/audiences don't apply. */
  requiredScopes: string[];
  /** Human labels of the distinct audiences `requiredScopes` span. More than one is a conflict. */
  audienceLabels: string[];
  /** True when consumers need tokens for different audiences — no single sign-in can serve them. */
  audienceConflict: boolean;
}

export interface SessionUsageLookup {
  requirementFor(pluginId: string, sessionTypeId: string): SessionRequirement | undefined;
  pluginName(pluginId: string): string;
}

export function computeSessionUsage(
  session: Session,
  sources: PluginBackedRecord[],
  destinations: PluginBackedRecord[],
  lookup: SessionUsageLookup,
): SessionUsage {
  const scopeBased = session.scopes !== undefined;
  const requiredFor = (record: PluginBackedRecord) =>
    scopeBased ? (lookup.requirementFor(record.pluginId, session.sessionTypeId)?.requiredScopesOrRoles ?? []) : [];

  const consumers: SessionConsumer[] = [
    ...sources
      .filter((s) => s.sessionId === session.id)
      .map((s): SessionConsumer => ({
        kind: 'source',
        id: s.id,
        name: s.name,
        pluginId: s.pluginId,
        pluginName: lookup.pluginName(s.pluginId),
        flows: [s.name],
        requiredScopes: requiredFor(s),
      })),
    ...destinations
      .filter((d) => d.sessionId === session.id)
      .map((d): SessionConsumer => ({
        kind: 'destination',
        id: d.id,
        name: d.name,
        pluginId: d.pluginId,
        pluginName: lookup.pluginName(d.pluginId),
        flows: sources.filter((s) => s.destinationId === d.id).map((s) => s.name),
        requiredScopes: requiredFor(d),
      })),
  ];

  const requiredScopes = unionScopes(...consumers.map((c) => c.requiredScopes));
  const audiences = audiencesOfScopes(requiredScopes);
  return {
    sessionId: session.id,
    consumers,
    requiredScopes,
    audienceLabels: audiences.map(audienceLabel),
    audienceConflict: audiences.length > 1,
  };
}

/** Whether an existing session could serve `requirement` at all. Unknown scopes (a session type
 * with no scope concept, or one created before scopes were tracked) are given the benefit of the
 * doubt; otherwise the requirement's audience must be one the session's token is issued for —
 * scopes within the right audience can still be widened by a Login, a wrong audience cannot. */
export function sessionServesRequirement(session: Session, requirement: SessionRequirement): boolean {
  if (!session.scopes) return true;
  const wanted = audiencesOfScopes(requirement.requiredScopesOrRoles);
  const have = audiencesOfScopes(session.scopes);
  return wanted.every((a) => have.includes(a));
}

/** Whether the session's current grant already covers every scope in `required`. */
export function sessionCoversScopes(session: Session, required: string[]): boolean {
  return session.scopes !== undefined && scopesCover(session.scopes, required);
}
