import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { Plus, Settings as SettingsIcon, Wrench } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { InstalledPluginSummary } from '../../../electron/shared/ipcContracts';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { runJobAndWait } from '../jobs';

type RecordKind = 'source' | 'destination';

const NEEDS_ATTENTION_STATUSES: Session['status'][] = ['expired', 'needs-reconnect'];

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** The whole calendar month a Collect run's own `period` (§14) covers — the run-period selector
 * below is deliberately a plain month+year pair, not an arbitrary range, so "collect this month"
 * stays a one-glance decision; the Report card further down keeps its own free-form date range
 * for exporting whatever's already on file. */
function periodForMonth(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(year, month, 0).toISOString().slice(0, 10);
  return { start, end };
}

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  return { start, end };
}

interface CollectPageProps {
  /** Jumps to Settings' Sessions section (phase 1.16) — used by the stale-session summary below,
   * since reconnecting is a session-level action that lives there, not a per-row action here. */
  onOpenSettings: () => void;
}

/** §14's Collect flow, plus §5/§6/§8's Add-Source/Destination wizard. A record's session step
 * only ever looks at `sessionRequirements[0]` — a real simplification for a plugin that declares
 * more than one alternative session type, deferred until a real plugin actually needs that (same
 * "don't design for a hypothetical" reasoning as the other gaps this phase deferred). */
export function CollectPage({ onOpenSettings }: CollectPageProps) {
  const now = new Date();
  const [sources, setSources] = useState<PluginBackedRecord[]>([]);
  const [destinations, setDestinations] = useState<PluginBackedRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [allPlugins, setAllPlugins] = useState<InstalledPluginSummary[]>([]);
  const [addingKind, setAddingKind] = useState<RecordKind | undefined>(undefined);
  const [fixOpen, setFixOpen] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [collectMonth, setCollectMonth] = useState(now.getMonth() + 1);
  const [collectYear, setCollectYear] = useState(now.getFullYear());
  const [reportPeriod, setReportPeriod] = useState(defaultPeriod());
  const [exportingReport, setExportingReport] = useState(false);

  async function refresh() {
    setSources(await window.api.configListSources());
    setDestinations(await window.api.configListDestinations());
    setSessions(await window.api.sessionsList());
    setAllPlugins(await window.api.pluginsList());
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => window.api.onJobProgress((event) => setProgressLog((prev) => [...prev, event.message])), []);

  function pluginFor(record: PluginBackedRecord): InstalledPluginSummary | undefined {
    return allPlugins.find((p) => p.manifest.id === record.pluginId);
  }

  function isConnected(record: PluginBackedRecord): boolean {
    return sessionFor(record, sessions)?.status === 'active';
  }

  // Every source/destination whose installed plugin actually declares a session requirement —
  // a record whose plugin needs no session at all (e.g. a plugin with no sessionRequirements)
  // never counts against, or toward, the summary below.
  const connectableRecords: ConnectableRecord[] = [
    ...sources.map((record) => ({ kind: 'source' as const, record, plugin: pluginFor(record) })),
    ...destinations.map((record) => ({ kind: 'destination' as const, record, plugin: pluginFor(record) })),
  ].filter((r): r is ConnectableRecord => r.plugin !== undefined && r.plugin.sessionRequirements.length > 0);

  const totalNeeded = connectableRecords.length;
  const connectedCount = connectableRecords.filter((r) => isConnected(r.record)).length;
  const brokenRecords = connectableRecords.filter((r) => !isConnected(r.record));

  async function removeRecord(kind: RecordKind, id: string) {
    await window.api.configRemoveRecord({ kind, id });
    await refresh();
  }

  async function runCollect() {
    setCollecting(true);
    setProgressLog([]);
    try {
      const result = await window.api.collectRun({ sourceIds: 'all', period: periodForMonth(collectYear, collectMonth) });
      if ('error' in result) {
        toast.error(result.error);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = window.api.onJobDone((event) => {
          if (event.jobId !== result.jobId) return;
          unsubscribe();
          if (event.ok) resolve();
          else reject(new Error(event.error));
        });
      });
      toast.success('Collect run finished');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCollecting(false);
    }
  }

  async function exportReport(format: 'html' | 'excel') {
    setExportingReport(true);
    try {
      const result = await window.api.reportExport({ period: reportPeriod, format });
      if (result.exported) toast.success(`Report saved to ${result.filePath}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingReport(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Collect</h2>
          <p className="text-sm text-muted-foreground">Download invoices and upload them to each source's destination.</p>
        </div>
        <Button variant="ghost" size="icon" className="size-12" onClick={onOpenSettings}>
          <SettingsIcon className="size-6" />
        </Button>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-4">
          <fieldset disabled={collecting} className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="collect-month">Month</Label>
              <Select value={String(collectMonth)} onValueChange={(value) => setCollectMonth(Number(value))}>
                <SelectTrigger id="collect-month" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MONTH_NAMES.map((label, i) => (
                    <SelectItem key={label} value={String(i + 1)}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="collect-year">Year</Label>
              <Input
                id="collect-year"
                type="number"
                value={collectYear}
                onChange={(e) => setCollectYear(e.target.valueAsNumber)}
                className="w-28"
              />
            </div>
            <Button type="button" disabled={sources.length === 0 || connectedCount < totalNeeded} onClick={() => void runCollect()}>
              {collecting ? 'Collecting…' : 'Collect'}
            </Button>
            {totalNeeded > 0 && (
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  {connectedCount} of {totalNeeded} sessions connected
                </p>
                {connectedCount < totalNeeded && (
                  <Button type="button" size="sm" variant="outline" onClick={() => setFixOpen(true)}>
                    <Wrench />
                    Fix
                  </Button>
                )}
              </div>
            )}
            <Button type="button" variant="outline" className="ml-auto" onClick={() => setAddingKind('source')}>
              <Plus />
              Add
            </Button>
          </fieldset>
          {progressLog.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded-lg border bg-muted/30 px-3 py-2 font-mono text-xs leading-relaxed">
              {progressLog.map((line, index) => (
                // A plain progress transcript, appended in arrival order — no id to key by.
                <div key={index}>{line}</div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <fieldset disabled={collecting} className="contents">
        <RecordCard
          title="Sources"
          records={sources}
          sessions={sessions}
          onRemove={(id) => void removeRecord('source', id)}
          onAdd={() => setAddingKind('source')}
          addLabel="Add Source"
          onOpenSettings={onOpenSettings}
        />

        <RecordCard
          title="Destinations"
          records={destinations}
          sessions={sessions}
          onRemove={(id) => void removeRecord('destination', id)}
          onAdd={() => setAddingKind('destination')}
          addLabel="Add Destination"
          onOpenSettings={onOpenSettings}
        />

        <Card>
          <CardHeader>
            <CardTitle>Report</CardTitle>
            <p className="text-sm text-muted-foreground">Export what's on file for a period as HTML or Excel (§14.1 US20).</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-end gap-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="report-start">Start</Label>
                <Input
                  id="report-start"
                  type="date"
                  value={reportPeriod.start}
                  onChange={(e) => setReportPeriod((prev) => ({ ...prev, start: e.target.value }))}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="report-end">End</Label>
                <Input
                  id="report-end"
                  type="date"
                  value={reportPeriod.end}
                  onChange={(e) => setReportPeriod((prev) => ({ ...prev, end: e.target.value }))}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" disabled={exportingReport} onClick={() => void exportReport('html')}>
                Export as HTML
              </Button>
              <Button type="button" variant="outline" disabled={exportingReport} onClick={() => void exportReport('excel')}>
                Export as Excel
              </Button>
            </div>
          </CardContent>
        </Card>
      </fieldset>

      {addingKind && (
        <AddRecordDialog
          kind={addingKind}
          destinations={destinations}
          onClose={() => setAddingKind(undefined)}
          onCreated={() => {
            setAddingKind(undefined);
            void refresh();
          }}
        />
      )}

      {fixOpen && (
        <FixConnectionsDialog
          brokenRecords={brokenRecords}
          sessions={sessions}
          onClose={() => setFixOpen(false)}
          onFixed={() => void refresh()}
        />
      )}
    </div>
  );
}

function sessionFor(record: PluginBackedRecord, sessions: Session[]): Session | undefined {
  return record.sessionId ? sessions.find((s) => s.id === record.sessionId) : undefined;
}

function needsAttention(record: PluginBackedRecord, sessions: Session[]): boolean {
  const session = sessionFor(record, sessions);
  return session !== undefined && NEEDS_ATTENTION_STATUSES.includes(session.status);
}

interface RecordCardProps {
  title: string;
  records: PluginBackedRecord[];
  sessions: Session[];
  onRemove: (id: string) => void;
  onAdd: () => void;
  addLabel: string;
  onOpenSettings: () => void;
}

/** A record whose session has gone stale (`expired`/`needs-reconnect`) surfaces here as a badge
 * plus a card-level rollup — mirroring the reference app's own per-card `needsLoginCount` on
 * `SourcesPage`/`DestinationsPage` — but the actual Reconnect action lives in Settings' Sessions
 * section (phase 1.16), since a session can be shared across multiple records (§6) and reconnecting
 * it there fixes all of them at once, not just the row you happened to click from. */
function RecordCard({ title, records, sessions, onRemove, onAdd, addLabel, onOpenSettings }: RecordCardProps) {
  const staleCount = records.filter((r) => needsAttention(r, sessions)).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {staleCount > 0 && (
          <>
            <CardDescription>
              {staleCount} need{staleCount === 1 ? 's' : ''} reconnecting
            </CardDescription>
            <CardAction>
              <Button type="button" size="sm" variant="outline" onClick={onOpenSettings}>
                Reconnect
              </Button>
            </CardAction>
          </>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <RecordTable records={records} sessions={sessions} onRemove={onRemove} />
        <div>
          <Button type="button" variant="outline" onClick={onAdd}>
            {addLabel}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
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

interface AddRecordDialogProps {
  kind: RecordKind;
  destinations: PluginBackedRecord[];
  onClose: () => void;
  onCreated: () => void;
}

function AddRecordDialog({ kind, destinations, onClose, onCreated }: AddRecordDialogProps) {
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

interface SessionEstablishPanelProps {
  plugin: InstalledPluginSummary;
  sessions: Session[];
  selectedSessionId: string | undefined;
  onSelect: (sessionId: string) => void;
  onSessionCreated: (session: Session) => void;
}

/** The "pick an existing compatible session, or create a new one" block shared by
 * `AddRecordDialog` and `FixConnectionsDialog` — only ever looks at `sessionRequirements[0]`,
 * same established simplification as the rest of this file. Renders nothing for a plugin with no
 * session requirement at all. */
function SessionEstablishPanel({ plugin, sessions, selectedSessionId, onSelect, onSessionCreated }: SessionEstablishPanelProps) {
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

interface ConnectableRecord {
  kind: RecordKind;
  record: PluginBackedRecord;
  plugin: InstalledPluginSummary;
}

interface FixConnectionsDialogProps {
  brokenRecords: ConnectableRecord[];
  sessions: Session[];
  onClose: () => void;
  /** Called after each successful assignment — lets the Collect page's own connectivity summary
   * and badges update live as the user works through the list, not just once at the end. */
  onFixed: () => void;
}

/** Walks `brokenRecords` one at a time, establishing (or reconnecting) each one's session in turn
 * — the "Fix" shortcut from the Collect page's connectivity summary. Snapshots both props into
 * local state on open rather than reading them live: `onFixed()` triggers the Collect page to
 * refresh, which recomputes its own `brokenRecords` (shrinking it — the record just fixed drops
 * out) and could otherwise change size out from under this dialog's own `index`, skipping the
 * next one. Auto-closes once every record in the snapshot has been fixed. */
function FixConnectionsDialog({ brokenRecords: initialBrokenRecords, sessions: initialSessions, onClose, onFixed }: FixConnectionsDialogProps) {
  const [brokenRecords] = useState(initialBrokenRecords);
  const [index, setIndex] = useState(0);
  const [sessions, setSessions] = useState(initialSessions);
  const [assigning, setAssigning] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const current = brokenRecords[index];

  useEffect(() => {
    if (!current) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  if (!current) return null;

  async function assign(sessionId: string) {
    setAssigning(true);
    setError(undefined);
    try {
      await window.api.configAssignSession({ kind: current.kind, id: current.record.id, sessionId });
      onFixed();
      setIndex((i) => i + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAssigning(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Connect {current.record.name} ({index + 1} of {brokenRecords.length})
          </DialogTitle>
        </DialogHeader>
        <fieldset disabled={assigning} className="contents">
          <SessionEstablishPanel
            plugin={current.plugin}
            sessions={sessions}
            selectedSessionId={undefined}
            onSelect={(sessionId) => void assign(sessionId)}
            onSessionCreated={(session) => {
              setSessions((prev) => [...prev, session]);
              void assign(session.id);
            }}
          />
        </fieldset>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
