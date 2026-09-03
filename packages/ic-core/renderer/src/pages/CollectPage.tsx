import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

function defaultPeriod(): { start: string; end: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  return { start, end };
}

/** §14's Collect flow, plus §5/§6/§8's Add-Source/Destination wizard. A record's session step
 * only ever looks at `sessionRequirements[0]` — a real simplification for a plugin that declares
 * more than one alternative session type, deferred until a real plugin actually needs that (same
 * "don't design for a hypothetical" reasoning as the other gaps this phase deferred). */
export function CollectPage() {
  const [sources, setSources] = useState<PluginBackedRecord[]>([]);
  const [destinations, setDestinations] = useState<PluginBackedRecord[]>([]);
  const [addingKind, setAddingKind] = useState<RecordKind | undefined>(undefined);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [reportPeriod, setReportPeriod] = useState(defaultPeriod());
  const [exportingReport, setExportingReport] = useState(false);

  async function refresh() {
    setSources(await window.api.configListSources());
    setDestinations(await window.api.configListDestinations());
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => window.api.onJobProgress((event) => setProgressLog((prev) => [...prev, event.message])), []);

  async function removeRecord(kind: RecordKind, id: string) {
    await window.api.configRemoveRecord({ kind, id });
    await refresh();
  }

  async function runCollect() {
    setCollecting(true);
    setProgressLog([]);
    try {
      const result = await window.api.collectRun({ sourceIds: 'all', period: defaultPeriod() });
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
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Collect</h2>
        <p className="text-sm text-muted-foreground">Download invoices and upload them to each source's destination.</p>
      </div>

      <fieldset disabled={collecting} className="contents">
        <Card>
          <CardHeader>
            <CardTitle>Sources</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <RecordTable records={sources} onRemove={(id) => void removeRecord('source', id)} />
            <div>
              <Button type="button" variant="outline" onClick={() => setAddingKind('source')}>
                Add Source
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Destinations</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <RecordTable records={destinations} onRemove={(id) => void removeRecord('destination', id)} />
            <div>
              <Button type="button" variant="outline" onClick={() => setAddingKind('destination')}>
                Add Destination
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Run</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div>
              <Button type="button" disabled={sources.length === 0} onClick={() => void runCollect()}>
                {collecting ? 'Collecting…' : 'Run Collect'}
              </Button>
            </div>
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
    </div>
  );
}

function RecordTable({ records, onRemove }: { records: PluginBackedRecord[]; onRemove: (id: string) => void }) {
  return (
    <div className="rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Plugin</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {records.map((r) => (
            <TableRow key={r.id}>
              <TableCell>{r.name}</TableCell>
              <TableCell>{r.pluginId}</TableCell>
              <TableCell>
                <Button type="button" variant="outline" size="sm" onClick={() => onRemove(r.id)}>
                  Remove
                </Button>
              </TableCell>
            </TableRow>
          ))}
          {records.length === 0 && (
            <TableRow>
              <TableCell colSpan={3} className="text-muted-foreground">
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
  const [creatingSession, setCreatingSession] = useState(false);
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
  const requirement = plugin?.sessionRequirements[0];
  const compatibleSessions = requirement
    ? sessions.filter(
        (s) => s.sessionTypeId === requirement.sessionTypeId && (requirement.confirmsBuiltIn || s.createdByPluginId === plugin.manifest.id),
      )
    : [];

  async function createSession() {
    if (!plugin || !requirement) return;
    setCreatingSession(true);
    setError(undefined);
    try {
      const session = await runJobAndWait<Session>(
        window.api.sessionsCreate({ pluginId: plugin.manifest.id, sessionTypeId: requirement.sessionTypeId }),
      );
      setSessions((prev) => [...prev, session]);
      setSelectedSessionId(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSession(false);
    }
  }

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

          {plugin && requirement && (
            <div className="flex flex-col gap-2 rounded-lg border p-4">
              <p className="text-sm font-medium">Session ({requirement.sessionTypeId})</p>
              {requirement.permissionsNote && <p className="text-sm text-muted-foreground">{requirement.permissionsNote}</p>}
              <p className="text-sm text-muted-foreground">Requires: {requirement.requiredScopesOrRoles.join(', ') || 'no specific scopes declared'}</p>
              {compatibleSessions.map((s) => (
                <label key={s.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="session"
                    className="accent-primary"
                    checked={selectedSessionId === s.id}
                    onChange={() => setSelectedSessionId(s.id)}
                  />
                  {s.label}
                </label>
              ))}
              <div>
                <Button type="button" variant="outline" size="sm" disabled={creatingSession} onClick={() => void createSession()}>
                  {creatingSession ? 'Creating…' : 'Create new session'}
                </Button>
              </div>
            </div>
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
