import { useEffect, useRef, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { Copy, FileSpreadsheet, FileText, Loader2, PlayCircle, Plus, Settings as SettingsIcon, StopCircle, Wrench, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { InstalledPluginSummary, InvoiceHistoryRecord } from '../../../electron/shared/ipcContracts';
import { AddRecordDialog, SessionEstablishPanel, sessionFor, type RecordKind } from './SourcesDestinationsSection';

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

/** The whole calendar month a Collect run's own `period` (§14) covers. */
function periodForMonth(year: number, month: number): { start: string; end: string } {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const end = new Date(year, month, 0).toISOString().slice(0, 10);
  return { start, end };
}

function issuedMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function formatAmount(amount?: { value: number; currency: string }): string {
  return amount ? `${amount.value.toFixed(2)} ${amount.currency}` : '—';
}

// Character-count truncation (not just CSS overflow) so the table's columns stay a predictable
// width regardless of how long a destination name actually is — the full value is still available
// via the cell's title tooltip and the copy button, matching the reference app's own pattern.
function truncateText(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

async function copyToClipboard(value: string) {
  await navigator.clipboard.writeText(value);
  toast.success('Copied');
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
  const [invoiceHistory, setInvoiceHistory] = useState<InvoiceHistoryRecord[]>([]);
  const [nameFilter, setNameFilter] = useState('');
  const [exportingInvoices, setExportingInvoices] = useState(false);
  const [currentJobId, setCurrentJobId] = useState<string | undefined>(undefined);
  // The upload pipeline catches an in-flight cancellation between invoices and keeps whatever it
  // already finished (job:done still arrives with ok:false, error:'...cancelled') — tracked in a
  // ref, not state, so runCollect()'s own already-running closure sees the flip immediately
  // instead of the stale value it closed over (same reasoning as the reference app's own
  // wasCancelledRef), letting it show a neutral "cancelled" toast instead of an error one.
  const wasCancelledRef = useRef(false);

  async function refresh() {
    setSources(await window.api.configListSources());
    setDestinations(await window.api.configListDestinations());
    setSessions(await window.api.sessionsList());
    setAllPlugins(await window.api.pluginsList());
  }

  async function refreshInvoiceHistory() {
    setInvoiceHistory(await window.api.historyListForMonth(issuedMonthKey(collectYear, collectMonth)));
  }

  useEffect(() => {
    void refresh();
  }, []);

  // §14.1 US13's collected-invoices table (below) — reloaded whenever the selected month changes,
  // same as the reference app's own "switching to a month already worked on immediately shows its
  // full history."
  useEffect(() => {
    void refreshInvoiceHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectMonth, collectYear]);

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

  async function runCollect() {
    setCollecting(true);
    setProgressLog([]);
    wasCancelledRef.current = false;
    try {
      const result = await window.api.collectRun({ sourceIds: 'all', period: periodForMonth(collectYear, collectMonth) });
      if ('error' in result) {
        toast.error(result.error);
        return;
      }
      setCurrentJobId(result.jobId);
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = window.api.onJobDone((event) => {
          if (event.jobId !== result.jobId) return;
          unsubscribe();
          if (event.ok) resolve();
          else reject(new Error(event.error));
        });
      });
      toast.success('Collect run finished');
      await refreshInvoiceHistory();
    } catch (err) {
      if (wasCancelledRef.current) {
        toast('Collection cancelled');
      } else {
        toast.error(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setCollecting(false);
      setCurrentJobId(undefined);
    }
  }

  async function cancelCollect() {
    if (!currentJobId) return;
    wasCancelledRef.current = true;
    await window.api.jobsCancel(currentJobId);
  }

  function sourceName(id: string): string {
    return sources.find((s) => s.id === id)?.name ?? id;
  }

  function destinationName(id: string): string {
    return destinations.find((d) => d.id === id)?.name ?? id;
  }

  const filteredInvoiceHistory = invoiceHistory.filter((r) => {
    const needle = nameFilter.trim().toLowerCase();
    if (!needle) return true;
    return [sourceName(r.sourceId), destinationName(r.destinationId), r.invoiceId].some((value) => value.toLowerCase().includes(needle));
  });

  async function exportInvoices(format: 'excel' | 'pdf') {
    setExportingInvoices(true);
    try {
      const result = await window.api.reportExportRows({
        records: filteredInvoiceHistory,
        period: periodForMonth(collectYear, collectMonth),
        format,
      });
      if (result.exported) toast.success(`Saved to ${result.filePath}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingInvoices(false);
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

      <div className="flex flex-wrap items-center gap-2">
        <fieldset disabled={collecting} className="contents">
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
          <Input
            id="collect-year"
            type="number"
            value={collectYear}
            onChange={(e) => setCollectYear(e.target.valueAsNumber)}
            className="w-28"
          />
          <Button type="button" disabled={sources.length === 0 || connectedCount < totalNeeded} onClick={() => void runCollect()}>
            {collecting ? <Loader2 className="animate-spin" /> : <PlayCircle />}
            {collecting ? 'Collecting…' : 'Collect'}
          </Button>
        </fieldset>
        {collecting && (
          <Button type="button" size="sm" variant="outline" onClick={() => void cancelCollect()}>
            <StopCircle />
            Cancel
          </Button>
        )}
        {totalNeeded > 0 && (
          <div className="flex items-center gap-2">
            <p className="text-sm text-muted-foreground">
              {connectedCount} of {totalNeeded} sessions connected
            </p>
            {connectedCount < totalNeeded && (
              <Button type="button" size="sm" variant="outline" disabled={collecting} onClick={() => setFixOpen(true)}>
                <Wrench />
                Fix
              </Button>
            )}
          </div>
        )}
        <Button type="button" variant="outline" className="ml-auto" disabled={collecting} onClick={() => setAddingKind('source')}>
          <Plus />
          Add
        </Button>
      </div>

      <ProgressLog lines={progressLog} />

      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold tracking-tight">Collected invoices</h3>
        <div className="flex items-center gap-2">
          <div className="relative w-48">
            <Input placeholder="Filter…" value={nameFilter} onChange={(e) => setNameFilter(e.target.value)} className="pr-7" />
            {nameFilter && (
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1/2 right-1 size-4.5 -translate-y-1/2 rounded-full"
                onClick={() => setNameFilter('')}
              >
                <X className="size-3" />
              </Button>
            )}
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={exportingInvoices || filteredInvoiceHistory.length === 0}
            onClick={() => void exportInvoices('excel')}
          >
            <FileSpreadsheet />
            Save Excel
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={exportingInvoices || filteredInvoiceHistory.length === 0}
            onClick={() => void exportInvoices('pdf')}
          >
            <FileText />
            Save PDF
          </Button>
        </div>
      </div>

      {filteredInvoiceHistory.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {invoiceHistory.length === 0 ? 'Nothing collected for this month yet.' : 'No invoices match this filter.'}
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Source</TableHead>
                <TableHead>Date issued</TableHead>
                <TableHead>Total amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Collected</TableHead>
                <TableHead>Uploaded destination path</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredInvoiceHistory.map((r) => {
                const destination = destinationName(r.destinationId);
                return (
                  <TableRow key={`${r.sourceId}-${r.invoiceId}`}>
                    <TableCell className="font-medium">{r.invoiceId}</TableCell>
                    <TableCell className="text-muted-foreground">{sourceName(r.sourceId)}</TableCell>
                    <TableCell>{r.issuedDate}</TableCell>
                    <TableCell>{formatAmount(r.amount)}</TableCell>
                    <TableCell>{r.status}</TableCell>
                    <TableCell className="text-muted-foreground">{r.collectedAt}</TableCell>
                    <TableCell className="text-xs text-muted-foreground" title={destination}>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-6 shrink-0"
                          onClick={() => void copyToClipboard(destination)}
                        >
                          <Copy className="size-3.5" />
                        </Button>
                        <span>{truncateText(destination, 26)}</span>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

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

const DEFAULT_LOG_LINES = 3;
const MIN_LOG_LINES = 1;
const FALLBACK_LINE_HEIGHT_PX = 20;

/**
 * Always rendered (not just while a run is in flight) — a run's own history is worth glancing at
 * even after it finishes, and a placeholder is clearer than the block just not existing yet.
 * Height defaults to `DEFAULT_LOG_LINES` and is user-resizable via the bottom drag handle; the
 * resize snaps to whole line increments as you drag (measured from the element's own computed
 * `line-height`, not a hardcoded guess) rather than tracking the mouse pixel-for-pixel, so the
 * bottom edge never stops mid-line.
 */
function ProgressLog({ lines }: { lines: string[] }) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [visibleLines, setVisibleLines] = useState(DEFAULT_LOG_LINES);
  const [lineHeight, setLineHeight] = useState(FALLBACK_LINE_HEIGHT_PX);

  useEffect(() => {
    if (!contentRef.current) return;
    const parsed = parseFloat(window.getComputedStyle(contentRef.current).lineHeight);
    if (!Number.isNaN(parsed)) setLineHeight(parsed);
  }, []);

  // Keeps the log scrolled to its latest line as events stream in.
  useEffect(() => {
    const el = contentRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  function onDragStart(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startLines = visibleLines;

    function onMove(ev: MouseEvent) {
      const deltaLines = Math.round((ev.clientY - startY) / lineHeight);
      setVisibleLines(Math.max(MIN_LOG_LINES, startLines + deltaLines));
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div className="rounded-lg border bg-muted/30">
      <div
        ref={contentRef}
        className="overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
        style={{ height: visibleLines * lineHeight }}
      >
        {lines.length === 0 ? (
          <div className="text-muted-foreground">Start collection to see the progress.</div>
        ) : (
          // A plain progress transcript, appended in arrival order — no id to key by.
          lines.map((line, index) => (
            <div key={index} className={line.includes('FAILED') ? 'text-destructive' : undefined}>
              {line}
            </div>
          ))
        )}
      </div>
      <div
        onMouseDown={onDragStart}
        title="Drag to resize"
        className="mx-auto my-1 h-1.5 w-10 cursor-ns-resize rounded-full bg-border hover:bg-muted-foreground/50"
      />
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
