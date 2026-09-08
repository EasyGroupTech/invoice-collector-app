import { useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { Button } from '@/components/ui/button';
import type { InstalledPluginSummary } from '../../../electron/shared/ipcContracts';
import { runJobAndWait } from '../jobs';

export type RecordKind = 'source' | 'destination';

/**
 * §14.1's "collection flow" concept (`CollectionFlowsSection`, `AddCollectorWizard`) replaced
 * per-kind Sources/Destinations management in Settings — a user never works with a source or
 * destination directly, only the flow that pairs them. What's left here is the session-lookup/
 * establish-a-session toolkit both `CollectPage` (its own Fix-connections dialog) and
 * `AddCollectorWizard`/`CollectionFlowsSection` still share.
 */
export function sessionFor(record: PluginBackedRecord, sessions: Session[]): Session | undefined {
  return record.sessionId ? sessions.find((s) => s.id === record.sessionId) : undefined;
}

export interface SessionEstablishPanelProps {
  plugin: InstalledPluginSummary;
  sessions: Session[];
  selectedSessionId: string | undefined;
  onSelect: (sessionId: string) => void;
  onSessionCreated: (session: Session) => void;
}

/** The "pick an existing compatible session, or create a new one" block shared by
 * `AddCollectorWizard` and the Collect page's own Fix-connections dialog — only ever looks at
 * `sessionRequirements[0]`, same established simplification as the rest of this app. Renders
 * nothing for a plugin with no session requirement at all. */
export function SessionEstablishPanel({ plugin, sessions, selectedSessionId, onSelect, onSessionCreated }: SessionEstablishPanelProps) {
  const [creatingSession, setCreatingSession] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const requirement = plugin.sessionRequirements[0];

  if (!requirement) return null;

  const compatibleSessions = sessions.filter(
    (s) => s.sessionTypeId === requirement.sessionTypeId && (requirement.confirmsBuiltIn || s.createdByPluginId === plugin.manifest.id),
  );

  async function createSession() {
    setCreatingSession(true);
    setError(undefined);
    try {
      const session = await runJobAndWait<Session>(
        window.api.sessionsCreate({ pluginId: plugin.manifest.id, sessionTypeId: requirement.sessionTypeId }),
      );
      onSessionCreated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSession(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4">
      <p className="text-sm font-medium">Session ({requirement.sessionTypeId})</p>
      {requirement.permissionsNote && <p className="text-sm text-muted-foreground">{requirement.permissionsNote}</p>}
      <p className="text-sm text-muted-foreground">Requires: {requirement.requiredScopesOrRoles.join(', ') || 'no specific scopes declared'}</p>
      {compatibleSessions.map((s) => (
        <label key={s.id} className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name={`session-${plugin.manifest.id}`}
            className="accent-primary"
            checked={selectedSessionId === s.id}
            onChange={() => onSelect(s.id)}
          />
          {s.label}
        </label>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" disabled={creatingSession} onClick={() => void createSession()}>
          {creatingSession ? 'Creating…' : 'Create new session'}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
