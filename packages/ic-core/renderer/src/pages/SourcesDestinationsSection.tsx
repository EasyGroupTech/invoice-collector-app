import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { InstalledPluginSummary } from '../../../electron/shared/ipcContracts';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { runJobAndWait } from '../jobs';

export type RecordKind = 'source' | 'destination';

const NEEDS_ATTENTION_STATUSES: Session['status'][] = ['expired', 'needs-reconnect'];

export function sessionFor(record: PluginBackedRecord, sessions: Session[]): Session | undefined {
  return record.sessionId ? sessions.find((s) => s.id === record.sessionId) : undefined;
}

function needsAttention(record: PluginBackedRecord, sessions: Session[]): boolean {
  const session = sessionFor(record, sessions);
  return session !== undefined && NEEDS_ATTENTION_STATUSES.includes(session.status);
}

function RecordTable({ records, sessions, onRemove }: { records: PluginBackedRecord[]; sessions: Session[]; onRemove: (id: string) => void }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Plugin</TableHead>
            <TableHead />
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.name}</TableCell>
              <TableCell>{r.pluginId}</TableCell>
              <TableCell>{needsAttention(r, sessions) && <Badge variant="destructive">{sessionFor(r, sessions)?.status}</Badge>}</TableCell>
              <TableCell>
                <Button type="button" variant="outline" size="sm" onClick={() => onRemove(r.id)}>
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {records.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="text-muted-foreground">
                None yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export interface SessionEstablishPanelProps {
  plugin: InstalledPluginSummary;
  sessions: Session[];
  selectedSessionId: string | undefined;
  onSelect: (sessionId: string) => void;
  onSessionCreated: (session: Session) => void;
}

/** The "pick an existing compatible session, or create a new one" block shared by
 * `AddRecordDialog` and the Collect page's own Fix-connections dialog — only ever looks at
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

export interface AddRecordDialogProps {
  kind: RecordKind;
  destinations: PluginBackedRecord[];
  onClose: () => void;
  onCreated: () => void;
}

export function AddRecordDialog({ kind, destinations, onClose, onCreated }: AddRecordDialogProps) {
  const [plugins, setPlugins] = useState<InstalledPluginSummary[]>([]);
  const [selectedPluginId, setSelectedPluginId] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  const [name, setName] = useState('');
  const [destinationId, setDestinationId] = useState<string | undefined>(undefined);
  const [values, setValues] = useState<WizardFieldValues>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void window.api.pluginsList().then((all) => setPlugins(all.filter((p) => p.manifest.kind === kind)));
    void window.api.sessionsList().then(setSessions);
  }, [kind]);

  const plugin = plugins.find((p) => p.manifest.id === selectedPluginId);

  async function submit() {
    if (!plugin) return;
    const validation = validateWizardValues(plugin.wizard, values);
    if (!validation.valid) {
      setError(`Missing required field(s): ${validation.missingFields.join(', ')}`);
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await window.api.configCreateRecord({
        kind,
        pluginId: plugin.manifest.id,
        pluginVersion: plugin.manifest.version,
        name: name || plugin.manifest.name,
        config: values,
        destinationId: kind === 'source' ? destinationId : undefined,
        sessionId: selectedSessionId,
      });
      toast.success(`${name || plugin.manifest.name} added`);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add {kind === 'source' ? 'Source' : 'Destination'}</DialogTitle>
        </DialogHeader>

        <fieldset disabled={submitting} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-record-plugin">Plugin</Label>
            <Select value={selectedPluginId} onValueChange={setSelectedPluginId}>
              <SelectTrigger id="add-record-plugin" className="w-full">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {plugins.map((p) => (
                  <SelectItem key={p.manifest.id} value={p.manifest.id}>
                    {p.manifest.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {plugin && (
            <SessionEstablishPanel
              plugin={plugin}
              sessions={sessions}
              selectedSessionId={selectedSessionId}
              onSelect={setSelectedSessionId}
              onSessionCreated={(session) => {
                setSessions((prev) => [...prev, session]);
                setSelectedSessionId(session.id);
              }}
            />
          )}

          {plugin && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-record-name">Name</Label>
              <Input id="add-record-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={plugin.manifest.name} />
            </div>
          )}

          {plugin && kind === 'source' && destinations.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-record-destination">Destination</Label>
              <Select value={destinationId} onValueChange={setDestinationId}>
                <SelectTrigger id="add-record-destination" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {plugin && (
            <WizardSteps
              pluginId={plugin.manifest.id}
              steps={plugin.wizard}
              values={values}
              sessionId={selectedSessionId}
              onChange={(n, v) => setValues((prev) => ({ ...prev, [n]: v }))}
            />
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </fieldset>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!plugin || submitting} onClick={() => void submit()}>
            {submitting ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RecordSectionProps {
  kind: RecordKind;
  title: string;
  addLabel: string;
}

/** A Settings section (phase 1.16 follow-up) for managing sources or destinations — moved here
 * from the Collect page to match the reference app's own IA exactly: `SourcesPage`/
 * `DestinationsPage` were sections of Settings there too, never on the primary Collect view.
 * Self-contained (fetches its own data) the same way `SessionsSection`/`PluginsSection` already
 * do, collapsed by default like both of those. */
function RecordSection({ kind, title, addLabel }: RecordSectionProps) {
  const [records, setRecords] = useState<PluginBackedRecord[]>([]);
  const [destinations, setDestinations] = useState<PluginBackedRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [adding, setAdding] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  async function refresh() {
    const [sources, destinations, sessions] = await Promise.all([
      window.api.configListSources(),
      window.api.configListDestinations(),
      window.api.sessionsList(),
    ]);
    setRecords(kind === 'source' ? sources : destinations);
    setDestinations(destinations);
    setSessions(sessions);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function removeRecord(id: string) {
    await window.api.configRemoveRecord({ kind, id });
    await refresh();
  }

  const staleCount = records.filter((r) => needsAttention(r, sessions)).length;

  return (
    <Card className="py-0">
      <CardHeader className="cursor-pointer gap-1.5 py-4 select-none" onClick={() => setCollapsed((c) => !c)}>
        <CardTitle className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          {title}
        </CardTitle>
        <CardDescription>
          {records.length} {kind === 'source' ? (records.length === 1 ? 'collector' : 'collectors') : records.length === 1 ? 'destination' : 'destinations'}
          {staleCount > 0 && `, ${staleCount} need${staleCount === 1 ? 's' : ''} reconnecting`}
        </CardDescription>
      </CardHeader>
      {!collapsed && (
        <CardContent className="flex flex-col gap-4 pb-4">
          <RecordTable records={records} sessions={sessions} onRemove={(id) => void removeRecord(id)} />
          <div>
            <Button type="button" variant="outline" onClick={() => setAdding(true)}>
              {addLabel}
            </Button>
          </div>
        </CardContent>
      )}
      {adding && (
        <AddRecordDialog
          kind={kind}
          destinations={destinations}
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}
    </Card>
  );
}

export function SourcesSection() {
  return <RecordSection kind="source" title="Sources" addLabel="Add Source" />;
}

export function DestinationsSection() {
  return <RecordSection kind="destination" title="Destinations" addLabel="Add Destination" />;
}
