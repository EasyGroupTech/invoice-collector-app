import { useEffect, useRef, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import {
  ChevronDown,
  Columns3,
  Copy,
  FileSpreadsheet,
  FileText,
  Loader2,
  PlayCircle,
  Plus,
  Settings as SettingsIcon,
  StopCircle,
  Wrench,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { InstalledPluginSummary, InvoiceHistoryRecord } from '../../../electron/shared/ipcContracts';
import { displayNameFor } from '../../../src/invoice-display.js';
import { AddCollectorWizard } from './AddCollectorWizard';
import { SessionEstablishPanel, sessionFor, type RecordKind } from './SourcesDestinationsSection';

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

/** Column customization is display-only — it never touches `exportInvoices()`/`reportExportRows`,
 * which always exports every column regardless of what's currently shown on screen (a filtered
 * report and a filtered *view* are different concerns; the report's own "Same columns... as the
 * Collect page's own table" doc comment (reporting.ts) predates this feature and refers to
 * content, not visibility). */
const INVOICE_TABLE_COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'source', label: 'Source' },
  { key: 'scope', label: 'Scope' },
  { key: 'issuedDate', label: 'Date issued' },
  { key: 'amount', label: 'Total amount' },
  { key: 'status', label: 'Status' },
  { key: 'collectedAt', label: 'Collected' },
  { key: 'destination', label: 'Uploaded destination path' },
] as const;

type InvoiceTableColumnKey = (typeof INVOICE_TABLE_COLUMNS)[number]['key'];

const DEFAULT_HIDDEN_COLUMNS: readonly InvoiceTableColumnKey[] = ['status', 'collectedAt'];

// Per-viewer preference, not app config — a plain localStorage key is enough, matching how a
// column-visibility choice like this is usually scoped in similar apps, and avoids a config-file/
// IPC round trip for something this lightweight. Wrapped defensively since a private-window-style
// storage block would otherwise crash column customization outright.
const COLUMN_VISIBILITY_STORAGE_KEY = 'collect-page:invoice-table-columns';

function defaultColumnVisibility(): Record<InvoiceTableColumnKey, boolean> {
  return Object.fromEntries(INVOICE_TABLE_COLUMNS.map((c) => [c.key, !DEFAULT_HIDDEN_COLUMNS.includes(c.key)])) as Record<
    InvoiceTableColumnKey,
    boolean
  >;
}

function loadColumnVisibility(): Record<InvoiceTableColumnKey, boolean> {
  const defaults = defaultColumnVisibility();
  try {
    const raw = localStorage.getItem(COLUMN_VISIBILITY_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<InvoiceTableColumnKey, boolean>>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function saveColumnVisibility(visibility: Record<InvoiceTableColumnKey, boolean>): void {
  try {
    localStorage.setItem(COLUMN_VISIBILITY_STORAGE_KEY, JSON.stringify(visibility));
  } catch {
    // Best-effort only — a blocked/full storage just means the choice doesn't persist.
  }
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
  const [addWizardOpen, setAddWizardOpen] = useState(false);
  const [fixOpen, setFixOpen] = useState(false);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [collectMonth, setCollectMonth] = useState(now.getMonth() + 1);
  const [collectYear, setCollectYear] = useState(now.getFullYear());
  const [invoiceHistory, setInvoiceHistory] = useState<InvoiceHistoryRecord[]>([]);
  const [nameFilter, setNameFilter] = useState('');
  const [exportingInvoices, setExportingInvoices] = useState(false);
  const [columnVisibility, setColumnVisibility] = useState<Record<InvoiceTableColumnKey, boolean>>(loadColumnVisibility);
  const [columnsDialogOpen, setColumnsDialogOpen] = useState(false);
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

  // Per-source readiness for the split Collect button's "collect one" dropdown — narrower than the
  // "Collect" (all) button's own global `connectedCount < totalNeeded` gate, since a single source
  // only needs its own session and its own destination's session, not every record's.
  function sourceReady(source: PluginBackedRecord): boolean {
    const sourcePlugin = pluginFor(source);
    if (sourcePlugin && sourcePlugin.sessionRequirements.length > 0 && !isConnected(source)) return false;
    const destination = destinations.find((d) => d.id === source.destinationId);
    const destinationPlugin = destination ? pluginFor(destination) : undefined;
    if (destination && destinationPlugin && destinationPlugin.sessionRequirements.length > 0 && !isConnected(destination)) return false;
    return true;
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

  async function runCollect(sourceIds: 'all' | string[]) {
    setCollecting(true);
    setProgressLog([]);
    wasCancelledRef.current = false;

    // Subscribed *before* collectRun is even awaited, and buffered until its own jobId is known —
    // mirrors useJob.ts's own fix (PR #38): a collect job that finishes before any real async work
    // (e.g. a run with nothing actually selected) can broadcast its own done event before
    // collectRun's own promise resolves, so subscribing only afterward (the previous code here)
    // would silently miss it and hang this whole function — and the finally block below — forever.
    const pending: { jobId: string | undefined; done: { jobId: string; ok: boolean; error?: string } | undefined } = {
      jobId: undefined,
      done: undefined,
    };
    let settleDone: ((event: { ok: boolean; error?: string }) => void) | undefined;
    const donePromise = new Promise<void>((resolve, reject) => {
      settleDone = (event) => (event.ok ? resolve() : reject(new Error(event.error)));
    });
    const unsubscribe = window.api.onJobDone((event) => {
      if (pending.jobId === undefined) {
        pending.done = event;
        return;
      }
      if (event.jobId !== pending.jobId) return;
      unsubscribe();
      settleDone?.(event);
    });

    try {
      const result = await window.api.collectRun({ sourceIds, period: periodForMonth(collectYear, collectMonth) });
      if ('error' in result) {
        unsubscribe();
        toast.error(result.error);
        return;
      }
      pending.jobId = result.jobId;
      setCurrentJobId(result.jobId);
      if (pending.done && pending.done.jobId === pending.jobId) {
        unsubscribe();
        settleDone?.(pending.done);
      }
      await donePromise;
      toast.success(sourceIds === 'all' ? 'Collect run finished' : `Collected ${sourceName(sourceIds[0])}`);
      await refreshInvoiceHistory();
    } catch (err) {
      unsubscribe();
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

  // Looked up live from the current source config, not persisted per invoice-history record —
  // unlike the reference app's own per-discovery `scopeLabel` (a multi-scope billing provider's
  // own concept), this is a single label the user sets once when creating the source (§14.1's Add
  // Collector wizard), so it never varies row to row within one source.
  function sourceScope(id: string): string {
    return sources.find((s) => s.id === id)?.scope ?? '';
  }

  function destinationName(id: string): string {
    return destinations.find((d) => d.id === id)?.name ?? id;
  }

  const filteredInvoiceHistory = invoiceHistory.filter((r) => {
    const needle = nameFilter.trim().toLowerCase();
    if (!needle) return true;
    return [sourceName(r.sourceId), sourceScope(r.sourceId), destinationName(r.destinationId), displayNameFor(r)].some((value) =>
      value.toLowerCase().includes(needle),
    );
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

  function toggleColumn(key: InvoiceTableColumnKey, visible: boolean) {
    setColumnVisibility((prev) => {
      const next = { ...prev, [key]: visible };
      saveColumnVisibility(next);
      return next;
    });
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
          <div className="flex">
            <Button
              type="button"
              className="rounded-r-none"
              disabled={sources.length === 0 || connectedCount < totalNeeded}
              onClick={() => void runCollect('all')}
            >
              {collecting ? <Loader2 className="animate-spin" /> : <PlayCircle />}
              {collecting ? 'Collecting…' : 'Collect'}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  className="rounded-l-none border-l border-l-primary-foreground/20 px-2"
                  disabled={sources.length === 0}
                >
                  <ChevronDown />
                  <span className="sr-only">Collect a specific collector</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Collect one</DropdownMenuLabel>
                {sources.map((source) => (
                  <DropdownMenuItem
                    key={source.id}
                    disabled={!sourceReady(source)}
                    onSelect={() => void runCollect([source.id])}
                  >
                    {source.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
        <Button type="button" variant="outline" className="ml-auto" disabled={collecting} onClick={() => setAddWizardOpen(true)}>
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
          <Button variant="outline" size="sm" onClick={() => setColumnsDialogOpen(true)}>
            <Columns3 />
            Columns
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
                {columnVisibility.name && <TableHead>Name</TableHead>}
                {columnVisibility.source && <TableHead>Source</TableHead>}
                {columnVisibility.scope && <TableHead>Scope</TableHead>}
                {columnVisibility.issuedDate && <TableHead>Date issued</TableHead>}
                {columnVisibility.amount && <TableHead>Total amount</TableHead>}
                {columnVisibility.status && <TableHead>Status</TableHead>}
                {columnVisibility.collectedAt && <TableHead>Collected</TableHead>}
                {columnVisibility.destination && <TableHead>Uploaded destination path</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredInvoiceHistory.map((r) => {
                // The invoice's own actual upload location, when known — falls back to the
                // destination's bare name only for a record written before that field existed, or
                // by a destination type that reported no location.
                const destination = r.location ?? destinationName(r.destinationId);
                const scope = sourceScope(r.sourceId);
                const displayName = displayNameFor(r);
                return (
                  <TableRow key={`${r.sourceId}-${r.invoiceId}`}>
                    {columnVisibility.name && (
                      <TableCell className="font-medium" title={displayName}>
                        {truncateText(displayName, 30)}
                      </TableCell>
                    )}
                    {columnVisibility.source && <TableCell className="text-muted-foreground">{sourceName(r.sourceId)}</TableCell>}
                    {columnVisibility.scope && (
                      <TableCell className="text-muted-foreground" title={scope}>
                        {truncateText(scope, 20)}
                      </TableCell>
                    )}
                    {columnVisibility.issuedDate && <TableCell>{r.issuedDate}</TableCell>}
                    {columnVisibility.amount && <TableCell>{formatAmount(r.amount)}</TableCell>}
                    {columnVisibility.status && <TableCell>{r.status}</TableCell>}
                    {columnVisibility.collectedAt && <TableCell className="text-muted-foreground">{r.collectedAt}</TableCell>}
                    {columnVisibility.destination && (
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
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {addWizardOpen && (
        <AddCollectorWizard
          onClose={() => setAddWizardOpen(false)}
          onCreated={() => {
            setAddWizardOpen(false);
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

      <Dialog open={columnsDialogOpen} onOpenChange={setColumnsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Table columns</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {INVOICE_TABLE_COLUMNS.map((column) => {
              const isLastVisible = columnVisibility[column.key] && Object.values(columnVisibility).filter(Boolean).length === 1;
              return (
                <div key={column.key} className="flex items-center gap-2">
                  <Checkbox
                    id={`column-${column.key}`}
                    checked={columnVisibility[column.key]}
                    disabled={isLastVisible}
                    onCheckedChange={(checked) => toggleColumn(column.key, checked === true)}
                  />
                  <Label htmlFor={`column-${column.key}`} className="font-normal">
                    {column.label}
                  </Label>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setColumnsDialogOpen(false)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
