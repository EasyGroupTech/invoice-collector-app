import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { InstalledPluginSummary } from '../../../electron/shared/ipcContracts';
import { joinScope, splitScope } from '../../../src/scope-format.js';
import { sessionServesRequirement } from '../../../src/session-usage.js';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { sessionFor } from './SourcesDestinationsSection';

const NO_DESTINATION_VALUE = '__none__';

type RecordKind = 'source' | 'destination';

interface EditRecordDialogProps {
  kind: RecordKind;
  record: PluginBackedRecord;
  destinations: PluginBackedRecord[];
  sessions: Session[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Edits one source or destination directly, rather than through the flow that pairs them
 * (`CollectionFlowsSection`'s `EditFlowDialog`, which only ever reaches a flow's source side). The
 * record's plugin can't change — that would change which wizard, session requirements and upload/
 * discover logic apply — so this re-renders the plugin's own `WizardSteps` pre-filled from the
 * record, plus name, session and (for a source) scope/destination.
 *
 * Only sessions that can actually serve this plugin's requirement are offered (same audience check
 * the Add wizard uses) — a Graph token can't be pointed at an Azure-only consumer or vice versa.
 */
function EditRecordDialog({ kind, record, destinations, sessions, onClose, onSaved }: EditRecordDialogProps) {
  const [plugin, setPlugin] = useState<InstalledPluginSummary | undefined>(undefined);
  const [name, setName] = useState(record.name);
  const initialScope = splitScope(record.scope);
  const [scope, setScope] = useState(initialScope.prefix);
  const [destinationId, setDestinationId] = useState<string | undefined>(record.destinationId ?? undefined);
  const [sessionId, setSessionId] = useState<string | undefined>(record.sessionId);
  const [values, setValues] = useState<WizardFieldValues>((record.config as WizardFieldValues) ?? {});
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.api.pluginsList().then((all) => setPlugin(all.find((p) => p.manifest.id === record.pluginId)));
  }, [record.pluginId]);

  const currentSession = sessionFor(record, sessions);
  // Same "first requirement only" simplification the rest of the app makes for a record's session.
  const requirement = plugin?.sessionRequirements.find((r) => r.sessionTypeId === currentSession?.sessionTypeId) ?? plugin?.sessionRequirements[0];
  const selectableSessions = requirement
    ? sessions.filter(
        (s) =>
          s.id === record.sessionId ||
          (s.sessionTypeId === requirement.sessionTypeId &&
            (requirement.confirmsBuiltIn || s.createdByPluginId === record.pluginId) &&
            sessionServesRequirement(s, requirement)),
      )
    : [];

  async function submit() {
    if (!plugin) return;
    const validation = validateWizardValues(plugin.wizard, values);
    if (!validation.valid) {
      setError(`Missing required field(s): ${validation.missingFields.join(', ')}`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const finalName = name || plugin.manifest.name;
      if (sessionId && sessionId !== record.sessionId) {
        await window.api.configAssignSession({ kind, id: record.id, sessionId });
      }
      if (kind === 'source') {
        await window.api.flowsUpdate({
          sourceId: record.id,
          name: finalName,
          scope: joinScope(scope, initialScope.discovered) || undefined,
          config: values,
          destinationId: destinationId ?? null,
        });
      } else {
        await window.api.configUpdateRecord({ kind, id: record.id, name: finalName, config: values });
      }
      // Reassigning a session or repointing a source can leave the old one referenced by nothing —
      // same best-effort cleanup EditFlowDialog does.
      await window.api.flowsSweepOrphans().catch(() => {});
      toast.success(`"${finalName}" saved`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit {kind}</DialogTitle>
        </DialogHeader>

        {plugin && (
          <fieldset disabled={saving} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-record-name">Name</Label>
              <Input id="edit-record-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={plugin.manifest.name} />
            </div>
            <p className="text-xs text-muted-foreground">Plugin: {plugin.manifest.name}</p>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-record-session">Session</Label>
              <Select value={sessionId ?? ''} onValueChange={setSessionId}>
                <SelectTrigger id="edit-record-session" className="w-full">
                  <SelectValue placeholder="No session" />
                </SelectTrigger>
                <SelectContent>
                  {selectableSessions.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {kind === 'source' && (
              <>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="edit-record-scope">Scope (optional)</Label>
                  <Input id="edit-record-scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. Finance department" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="edit-record-destination">Destination</Label>
                  <Select
                    value={destinationId ?? NO_DESTINATION_VALUE}
                    onValueChange={(v) => setDestinationId(v === NO_DESTINATION_VALUE ? undefined : v)}
                  >
                    <SelectTrigger id="edit-record-destination" className="w-full">
                      <SelectValue placeholder="None" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_DESTINATION_VALUE}>None</SelectItem>
                      {destinations.map((d) => (
                        <SelectItem key={d.id} value={d.id}>
                          {d.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </>
            )}

            <WizardSteps
              pluginId={plugin.manifest.id}
              steps={plugin.wizard}
              values={values}
              sessionId={sessionId}
              onChange={(n, v) => setValues((prev) => ({ ...prev, [n]: v }))}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </fieldset>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!plugin || saving} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface AdvancedConfigurationSectionProps {
  /** Same purpose as `CollectionFlowsSection`'s prop — an edit here can reassign or orphan a
   * session, which `SessionStatusSection` fetches independently and can't otherwise learn about. */
  onSessionsChanged?: () => void;
}

/**
 * Direct edit access to every source and destination individually, as a subsection of Advanced
 * Settings. Collection flows only ever expose a flow's source side; a destination (often shared
 * between flows) had no editor at all, so a wrong site/library/folder or session could not be
 * corrected without deleting and rebuilding the flow.
 */
export function AdvancedConfigurationSection({ onSessionsChanged }: AdvancedConfigurationSectionProps) {
  const [sources, setSources] = useState<PluginBackedRecord[]>([]);
  const [destinations, setDestinations] = useState<PluginBackedRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [editing, setEditing] = useState<{ kind: RecordKind; record: PluginBackedRecord } | undefined>(undefined);

  async function refresh() {
    const [nextSources, nextDestinations, nextSessions] = await Promise.all([
      window.api.configListSources(),
      window.api.configListDestinations(),
      window.api.sessionsList(),
    ]);
    setSources(nextSources);
    setDestinations(nextDestinations);
    setSessions(nextSessions);
    onSessionsChanged?.();
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function renderRows(kind: RecordKind, records: PluginBackedRecord[]) {
    if (records.length === 0) return <p className="text-sm text-muted-foreground">None yet.</p>;
    return records.map((record) => (
      <div key={record.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">{record.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {sessionFor(record, sessions)?.label ?? (record.sessionId ? 'Session missing' : 'No session')}
          </span>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing({ kind, record })}>
          <Pencil />
          Edit
        </Button>
      </div>
    ));
  }

  return (
    <div className="flex flex-col gap-4 border-t pt-6">
      <div>
        <h3 className="text-sm font-medium">Advanced configuration</h3>
        <p className="text-sm text-muted-foreground">Edit a source or destination directly — its name, session and plugin settings.</p>
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Sources</h4>
        {renderRows('source', sources)}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Destinations</h4>
        {renderRows('destination', destinations)}
      </div>

      {editing && (
        <EditRecordDialog
          kind={editing.kind}
          record={editing.record}
          destinations={destinations}
          sessions={sessions}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void refresh();
          }}
        />
      )}
    </div>
  );
}
