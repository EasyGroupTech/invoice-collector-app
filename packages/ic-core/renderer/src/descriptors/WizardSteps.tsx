import { useEffect, useRef, useState } from 'react';
import type { CapturedTextSelection, TextSelectField, WizardStepDescriptor } from 'invoice-collector-plugin-sdk';
import { ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { isFieldVisible, seedDetailValuesFromRow, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { FieldInput } from './FieldInput';

const FILTER_APPLY_DEBOUNCE_MS = 400;
const PRIMARY_COLUMN_MAX_LENGTH = 65;
const SECONDARY_COLUMN_MAX_LENGTH = 50;
const RULE_BADGE_LABEL_MAX_LENGTH = 24;
/** Matches the reference app's own `computeLabel` — the raw text immediately preceding a
 * captured selection, used as a literal match anchor. */
const LABEL_CONTEXT_CHARS = 40;

// Character-count truncation (not just CSS overflow) so a block's line stays a predictable length
// regardless of how long the underlying value actually is — same convention CollectPage.tsx
// already uses for its own destination-path column.
function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

// A list's own dataSource resolution re-runs on *any* wizard field change (not just fields it
// actually depends on — core has no way to know that, since resolution is opaque plugin logic),
// so `rows` gets fresh row objects on basically every keystroke/selection elsewhere in the same
// wizard. Comparing by reference (`row === selectedRow`) would then lose the highlight the moment
// anything else in the wizard changes, even though the selected row's own data hasn't. Falls back
// to reference equality when a row has no `id` field at all (§8 doesn't require one) — real for a
// plain preview list, just not for anything meant to be selected and depended on downstream.
function rowsMatch(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if ('id' in a && 'id' in b) return a.id === b.id;
  return false;
}

// Radix's own Select needs a stable string identity per option (its `value` prop) — `id` when a
// row has one (every dropdown-worthy row in practice, per ListDescriptor.renderAs's own doc
// comment), falling back to its index otherwise. The fallback isn't reorder-safe, but dropdown
// rendering is meant for rows that already have a real id; an id-less list staying stable across
// reloads was never guaranteed anyway.
function rowKey(row: Record<string, unknown>, index: number): string {
  return typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : `row-${index}`;
}

interface WizardStepsProps {
  pluginId: string;
  steps: WizardStepDescriptor[];
  values: WizardFieldValues;
  onChange: (name: string, value: unknown) => void;
  sessionId?: string;
}

/** Renders a WizardStepDescriptor[] (a plugin's own `wizard`, or a `settingsPanel`'s `steps`, §8)
 * — field/list/detail dispatch. Step navigation (if any) is the caller's own React state; this
 * just renders every step of the array flat, one below the next. */
export function WizardSteps({ pluginId, steps, values, onChange, sessionId }: WizardStepsProps) {
  const [selection, setSelection] = useState<Record<string, Record<string, unknown> | undefined>>({});

  return (
    <div className="flex flex-col gap-4">
      {steps.map((step) => {
        if (step.kind === 'field') {
          if (!isFieldVisible(step, values)) return null;
          return <FieldInput key={step.name} field={step} value={values[step.name]} onChange={(v) => onChange(step.name, v)} />;
        }

        if (step.kind === 'list') {
          // Also lands in `values` under the list's own name — the only way a *later*
          // ListDescriptor's own dataSource resolution (fieldValues, same as any plain field) can
          // see what was picked in an earlier one. Needed for a cascading picker (e.g. site ->
          // library -> folder, each depending on the last selection); purely additive for a list
          // nothing downstream reads back — ic-email-to-downloads's own single-level preview list
          // ignores it today. Shared by a real click (onSelect) and autoSelectFirstRow's own
          // auto-pick — both are "this is now the selection" from the wizard's own point of view.
          const select = (row: Record<string, unknown>) => {
            setSelection((prev) => ({ ...prev, [step.name]: row }));
            onChange(step.name, row);
          };
          // A fresh reload no longer contains what was selected here — e.g. an upstream list's
          // own selection changed (a different site picked after a library was already chosen
          // under the old one), which just silently re-queried this list rather than reset it. A
          // stale selection here isn't just a display problem: a *later* list still keying its own
          // resolution off this one's id would otherwise send an id that no longer means what it
          // used to (confirmed live — a folder id from the old library sent against the new
          // library's own drive 404s as "itemNotFound", not an error a user has any way to
          // self-diagnose).
          const clear = () => {
            setSelection((prev) => ({ ...prev, [step.name]: undefined }));
            onChange(step.name, undefined);
          };
          if (step.renderAs === 'tree') {
            return (
              <TreeListStep
                key={step.name}
                name={step.name}
                pluginId={pluginId}
                dataSource={step.dataSource}
                columns={step.columns}
                label={step.label}
                fieldValues={values}
                sessionId={sessionId}
                selectedRow={selection[step.name]}
                autoSelectFirstRow={step.autoSelectFirstRow}
                onSelect={select}
                onClear={clear}
              />
            );
          }
          return (
            <ListStep
              key={step.name}
              name={step.name}
              pluginId={pluginId}
              dataSource={step.dataSource}
              columns={step.columns}
              label={step.label}
              fieldValues={values}
              sessionId={sessionId}
              selectedRow={selection[step.name]}
              autoSelectFirstRow={step.autoSelectFirstRow}
              renderAs={step.renderAs}
              filterable={step.filterable}
              onSelect={select}
              onClear={clear}
            />
          );
        }

        if (step.kind === 'textSelect') {
          const currentValue = Array.isArray(values[step.name]) ? (values[step.name] as CapturedTextSelection[]) : [];
          return (
            <TextSelectStep
              key={step.name}
              pluginId={pluginId}
              dataSource={step.dataSource}
              label={step.label}
              fields={step.fields}
              fieldValues={values}
              sessionId={sessionId}
              value={currentValue}
              onChange={(v) => onChange(step.name, v)}
            />
          );
        }

        // step.kind === 'detail'
        const selectedRow = selection[step.showsSelectionFrom];
        return (
          <div key={step.name} className="flex flex-col gap-3 rounded-lg border p-4">
            <p className="text-sm font-medium">{step.label}</p>
            {!selectedRow && <p className="text-sm text-muted-foreground">Select a row above first.</p>}
            {step.fields.map((field) => {
              if (!isFieldVisible(field, values)) return null;
              const seeded = seedDetailValuesFromRow(step, selectedRow);
              const value = values[field.name] !== undefined ? values[field.name] : seeded[field.name];
              return <FieldInput key={field.name} field={field} value={value} onChange={(v) => onChange(field.name, v)} />;
            })}
          </div>
        );
      })}
    </div>
  );
}

interface ListStepProps {
  name: string;
  pluginId: string;
  dataSource: string;
  columns: { key: string; label: string }[];
  label: string;
  fieldValues: WizardFieldValues;
  sessionId?: string;
  selectedRow: Record<string, unknown> | undefined;
  autoSelectFirstRow?: boolean;
  renderAs?: 'list' | 'dropdown';
  filterable?: boolean;
  onSelect: (row: Record<string, unknown>) => void;
  onClear: () => void;
}

function ListStep({ name, pluginId, dataSource, columns, label, fieldValues, sessionId, selectedRow, autoSelectFirstRow, renderAs, filterable, onSelect, onClear }: ListStepProps) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // Declared unconditionally (hooks can't be called from inside an `if renderAs === 'dropdown'`
  // branch) — unused, harmless state for the default list style.
  const [filterText, setFilterText] = useState('');
  // Read inside the async load() below without it needing to be an effect dependency (which would
  // re-trigger a reload — a selection change alone shouldn't re-query the server, only fieldValues/
  // session should) — always current as of whatever render most recently committed. Synced via an
  // effect, not assigned during render itself (React's own rule against mutating a ref while
  // rendering — this can run after every render since it's not the source of any reload).
  const selectedRowRef = useRef(selectedRow);
  const onSelectRef = useRef(onSelect);
  const onClearRef = useRef(onClear);
  useEffect(() => {
    selectedRowRef.current = selectedRow;
    onSelectRef.current = onSelect;
    onClearRef.current = onClear;
  });
  // Ignores an in-flight request's own response once a newer one has since started — two
  // resolveListData calls for the same list have no ordering guarantee over the wire, so without
  // this an older, slower response could overwrite a newer selection's own correct rows.
  const requestIdRef = useRef(0);
  // What `fieldValues[name]` (this list's *own* current selection) was as of the last completed
  // load — tracked so a reload can tell apart two very different reasons it might not find the
  // selected row among its fresh rows: (a) *this* list's own selection just changed (the user
  // picked a new row here) — expected for a drill-down list, where selecting a row deliberately
  // re-queries to show *its own children*, which never include the row itself; or (b) some *other*
  // field changed while this list's own selection stayed untouched (e.g. an upstream site/library
  // pick) — the real "stale, no longer valid" case #33 was fixing. Only (b) should clear anything.
  const lastLoadedOwnValueRef = useRef<unknown>(undefined);
  const [loading, setLoading] = useState(false);

  async function load(values: WizardFieldValues) {
    const requestId = ++requestIdRef.current;
    const ownValueThisLoad = values[name];
    const ownValueChangedSinceLastLoad = ownValueThisLoad !== lastLoadedOwnValueRef.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await window.api.wizardResolveListData({ pluginId, request: { dataSource, fieldValues: values, sessionId } });
      if (requestId !== requestIdRef.current) return; // a newer request has since started — this response is stale
      setRows(result.rows);
      lastLoadedOwnValueRef.current = ownValueThisLoad;
      // The previously-selected row (if any) may no longer be one of the fresh rows — an upstream
      // list's own selection changing is exactly what re-triggers this reload in the first place.
      // Clearing it here (rather than leaving a stale id sitting in `values`) is what keeps a
      // *later* list's own dataSource resolution from silently depending on a selection that no
      // longer means what it used to. Skipped when *this* list's own selection is what just
      // changed (ownValueChangedSinceLastLoad) — a drill-down list's own freshly-picked row is
      // expected to be absent from its own freshly-reloaded children (they're its children, not
      // itself), which isn't staleness, it's the whole point of picking it.
      let stillSelected = selectedRowRef.current;
      if (!ownValueChangedSinceLastLoad && stillSelected && !result.rows.some((row) => rowsMatch(row, stillSelected))) {
        onClearRef.current();
        stillSelected = undefined;
      }
      // §8's ListDescriptor.autoSelectFirstRow — picks up right after the block above, so a
      // selection just invalidated by a context change (e.g. a different library picked) gets a
      // fresh default (that library's own root) instead of sitting cleared until the user clicks.
      if (autoSelectFirstRow && !stillSelected && result.rows.length > 0) {
        onSelectRef.current(result.rows[0]);
      }
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  // Applies the filter fields automatically as they change — debounced so a fast typist doesn't
  // fire a round trip per keystroke — and also re-fetches on a session change (switching "use
  // existing session" mid-step shouldn't need an extra manual click either). No manual Refresh
  // control at all — this is the only way the list ever (re)loads.
  useEffect(() => {
    const timer = setTimeout(() => void load(fieldValues), FILTER_APPLY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(fieldValues), sessionId]);

  // A "you are here" breadcrumb for a hierarchical picker (e.g. a folder tree) — opt-in by
  // convention, not a new descriptor field: any row shaped with a string `path` (root = '') gets
  // one, entirely rows'-own data, nothing SharePoint-specific about it here.
  const currentPath = typeof selectedRow?.path === 'string' ? selectedRow.path : undefined;

  if (renderAs === 'dropdown') {
    const needle = filterText.trim().toLowerCase();
    const filteredRows = filterable && needle ? (rows ?? []).filter((row) => columns.some((col) => String(row[col.key] ?? '').toLowerCase().includes(needle))) : (rows ?? []);
    // The currently-selected row stays present even if the filter would otherwise hide it —
    // Radix's own SelectValue needs its matching SelectItem rendered to show the trigger's label
    // correctly, and losing the visible selection just because of an unrelated filter keystroke
    // would be a worse experience than one extra, filter-defying option at the top.
    const visibleRows = selectedRow && !filteredRows.some((row) => rowsMatch(row, selectedRow)) ? [selectedRow, ...filteredRows] : filteredRows;

    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">{label}</p>
          {loading && (
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Loading…
            </span>
          )}
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {filterable && <Input placeholder={`Filter ${label.toLowerCase()}…`} value={filterText} onChange={(e) => setFilterText(e.target.value)} />}
        <Select
          value={selectedRow ? rowKey(selectedRow, -1) : undefined}
          onValueChange={(key) => {
            const row = (rows ?? []).find((candidate, index) => rowKey(candidate, index) === key);
            if (row) onSelect(row);
          }}
          disabled={!rows}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder={rows ? 'Select…' : 'Loading…'} />
          </SelectTrigger>
          <SelectContent>
            {visibleRows.length === 0 && <p className="p-2 text-sm text-muted-foreground">No matches.</p>}
            {visibleRows.map((row, index) => (
              <SelectItem key={rowKey(row, index)} value={rowKey(row, index)}>
                {truncate(String(row[columns[0]?.key] ?? ''), PRIMARY_COLUMN_MAX_LENGTH)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{label}</p>
        {loading && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </span>
        )}
      </div>
      {currentPath !== undefined && (
        <p className="text-xs text-muted-foreground">
          Current: <span className="font-mono">/{currentPath}</span>
        </p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows && (
        // Its own scroll area, bounded independently of the rest of the wizard/dialog — this list
        // can run into the hundreds of rows (a real mailbox's last 30 days), and letting it grow
        // the whole dialog would push every other field out of view.
        <div className="max-h-80 divide-y overflow-y-auto rounded-lg border">
          {rows.length === 0 && <p className="p-3 text-sm text-muted-foreground">No matches.</p>}
          {rows.map((row, index) => (
            // Rows have no declared id field (§8's ListDescriptor doesn't require one) — the index
            // is the only stable-enough key available here. Rendered as a two-line block rather
            // than a table: the first declared column (a message's subject, today's only real
            // consumer) as the prominent first line; every other column (received date, then
            // sender) joined on the second, muted line — each individually truncated, since an
            // unbounded sender address can otherwise run the block wider than the subject line.
            <div
              key={index}
              onClick={() => onSelect(row)}
              className={cn('cursor-pointer p-3 hover:bg-accent/50', rowsMatch(row, selectedRow) && 'bg-accent')}
            >
              <div className="text-sm font-medium">{truncate(String(row[columns[0]?.key] ?? ''), PRIMARY_COLUMN_MAX_LENGTH)}</div>
              {columns.length > 1 && (
                <div className="text-xs text-muted-foreground">
                  {columns
                    .slice(1)
                    .map((col) => truncate(String(row[col.key] ?? ''), SECONDARY_COLUMN_MAX_LENGTH))
                    .join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The tree's own top level — not a row any plugin ever returns itself. Selecting it means "the
// top level" (e.g. a document library's own root); matches every existing resolveListData
// convention of treating an absent selection as exactly that (ListDescriptor.renderAs's own doc,
// ui.ts). Its `path: ''` also feeds the same "you are here" breadcrumb convention any other row
// shaped with a string `path` already gets.
const TREE_ROOT_ROW: Record<string, unknown> = { id: '', name: '/', path: '' };
// Sentinel cache/expansion key for the root — distinct from any real row id (even an empty-string
// one), so a plugin returning a real row shaped with id: '' can't collide with it.
const TREE_ROOT_KEY = '__tree_root__';

function treeNodeKey(row: Record<string, unknown>): string {
  return typeof row.id === 'string' || typeof row.id === 'number' ? String(row.id) : '';
}

interface TreeNodeCacheEntry {
  status: 'loading' | 'loaded' | 'error';
  children: Array<Record<string, unknown>>;
  error?: string;
}

interface TreeListStepProps {
  name: string;
  pluginId: string;
  dataSource: string;
  columns: { key: string; label: string }[];
  label: string;
  fieldValues: WizardFieldValues;
  sessionId?: string;
  selectedRow: Record<string, unknown> | undefined;
  autoSelectFirstRow?: boolean;
  onSelect: (row: Record<string, unknown>) => void;
  onClear: () => void;
}

/**
 * `ListDescriptor.renderAs: 'tree'` (ui.ts) — a real expand/collapse tree, resolved lazily one
 * level at a time via `WizardListDataRequest.parentId`, instead of `ListStep`'s flat
 * click-a-row-to-both-select-and-descend list. Expanding a node (the chevron) and selecting it
 * (clicking its own label) are two entirely separate actions here, each touching its own state —
 * expand only ever reads/writes this component's local `cache`/`expanded`, select only ever calls
 * `onSelect`/`fieldValues[name]`. Neither depends on the other, which is what actually fixes the
 * bug class `ListStep`'s drill-down mode kept hitting (§ PR #33/#36 in invoice-collector-app's own
 * history): there, selecting a row *was* browsing into it, so the exact same request had to double
 * as both "confirm this" and "show me its children", and core had no way to tell a subfolder that
 * just isn't among its own freshly-loaded children apart from a selection that had actually gone
 * stale. A tree never has to guess, because clicking a row's label never re-triggers a fetch.
 */
function TreeListStep({ name, pluginId, dataSource, columns, label, fieldValues, sessionId, selectedRow, autoSelectFirstRow, onSelect, onClear }: TreeListStepProps) {
  const [cache, setCache] = useState<Map<string, TreeNodeCacheEntry>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set([TREE_ROOT_KEY]));
  // Bumped on every full reset (an upstream field or the session changed) — a fetch still in
  // flight when that happens checks this on completion and discards its own result rather than
  // merging a now-irrelevant branch (e.g. the old library's folders) into the tree that replaced it.
  const generationRef = useRef(0);
  const onSelectRef = useRef(onSelect);
  const onClearRef = useRef(onClear);
  useEffect(() => {
    onSelectRef.current = onSelect;
    onClearRef.current = onClear;
  });

  async function fetchChildren(parentRow: Record<string, unknown> | undefined, generation: number) {
    const key = parentRow ? treeNodeKey(parentRow) : TREE_ROOT_KEY;
    setCache((prev) => {
      const next = new Map(prev);
      next.set(key, { status: 'loading', children: prev.get(key)?.children ?? [] });
      return next;
    });
    try {
      const result = await window.api.wizardResolveListData({
        pluginId,
        request: { dataSource, fieldValues, sessionId, parentId: parentRow ? treeNodeKey(parentRow) : undefined },
      });
      if (generation !== generationRef.current) return; // superseded by a reset since this started
      setCache((prev) => {
        const next = new Map(prev);
        next.set(key, { status: 'loaded', children: result.rows });
        return next;
      });
    } catch (err) {
      if (generation !== generationRef.current) return;
      setCache((prev) => {
        const next = new Map(prev);
        next.set(key, { status: 'error', children: [], error: err instanceof Error ? err.message : String(err) });
        return next;
      });
    }
  }

  // Any upstream field (or session) change invalidates the whole tree — core has no way to know
  // which fields a dataSource actually depends on (the same limitation `ListStep`'s own modes
  // already live with), so the safe default is to rebuild from the root rather than risk showing
  // a branch fetched under a now-irrelevant context (e.g. a different library's folder ids).
  // Deliberately excludes this step's *own* value (`fieldValues[name]`) from the dependency key —
  // selecting a row never itself re-fetches anything in tree mode, so it must not reset the tree
  // it's a selection *of*.
  const upstreamDepsKey = JSON.stringify(Object.fromEntries(Object.entries(fieldValues).filter(([key]) => key !== name)));
  useEffect(() => {
    const generation = ++generationRef.current;
    setCache(new Map());
    setExpanded(new Set([TREE_ROOT_KEY]));
    onClearRef.current();
    if (autoSelectFirstRow) onSelectRef.current(TREE_ROOT_ROW);
    void fetchChildren(undefined, generation);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upstreamDepsKey, sessionId]);

  function toggleExpand(row: Record<string, unknown> | 'root') {
    const key = row === 'root' ? TREE_ROOT_KEY : treeNodeKey(row);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        const existing = cache.get(key);
        if (!existing || existing.status === 'error') void fetchChildren(row === 'root' ? undefined : row, generationRef.current);
      }
      return next;
    });
  }

  function renderNode(row: Record<string, unknown> | 'root', depth: number) {
    const key = row === 'root' ? TREE_ROOT_KEY : treeNodeKey(row);
    const displayRow: Record<string, unknown> = row === 'root' ? TREE_ROOT_ROW : row;
    const isExpanded = expanded.has(key);
    const entry = cache.get(key);
    const canExpand = displayRow.hasChildren !== false;
    const indentRem = depth * 1.25 + 0.375;

    return (
      <div key={key}>
        <div className={cn('flex items-center gap-1.5 rounded px-1.5 py-1 hover:bg-accent/50', rowsMatch(displayRow, selectedRow) && 'bg-accent')} style={{ paddingLeft: `${indentRem}rem` }}>
          {canExpand ? (
            <button type="button" onClick={() => toggleExpand(row)} className="flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground">
              {entry?.status === 'loading' ? <Loader2 className="size-3 animate-spin" /> : isExpanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
          ) : (
            <span className="size-4 shrink-0" />
          )}
          <button type="button" onClick={() => onSelect(displayRow)} className="flex-1 cursor-pointer truncate text-left text-sm">
            {truncate(String(displayRow[columns[0]?.key] ?? ''), PRIMARY_COLUMN_MAX_LENGTH)}
          </button>
        </div>
        {isExpanded && entry?.status === 'loaded' && entry.children.length === 0 && (
          <p className="text-xs text-muted-foreground" style={{ paddingLeft: `${indentRem + 1.25}rem` }}>
            No subfolders.
          </p>
        )}
        {isExpanded && entry?.status === 'error' && (
          <p className="text-xs text-destructive" style={{ paddingLeft: `${indentRem + 1.25}rem` }}>
            {entry.error}
          </p>
        )}
        {isExpanded && entry?.status === 'loaded' && entry.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  }

  const currentPath = typeof selectedRow?.path === 'string' ? selectedRow.path : undefined;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{label}</p>
      {currentPath !== undefined && (
        <p className="text-xs text-muted-foreground">
          Current: <span className="font-mono">/{currentPath}</span>
        </p>
      )}
      <div className="max-h-80 overflow-y-auto rounded-lg border p-1">{renderNode('root', 0)}</div>
    </div>
  );
}

/** The reference app's own `computeLabel`, ported: the raw text immediately preceding a captured
 * selection, trimmed of a truncated leading word fragment when the window doesn't start at the
 * very beginning of `fullText`. Deliberately raw text, not an attempt to isolate "the label
 * word" — these are templated, machine-generated emails where matching the literal boilerplate is
 * simpler and more robust than guessing which part of it is "the real label". */
function computeLabel(fullText: string, selectedText: string): string | undefined {
  const index = fullText.indexOf(selectedText);
  if (index === -1) return undefined;
  const start = Math.max(0, index - LABEL_CONTEXT_CHARS);
  let label = fullText.slice(start, index);
  if (start > 0) {
    const firstSpace = label.indexOf(' ');
    if (firstSpace !== -1) label = label.slice(firstSpace + 1);
  }
  const trimmed = label.trim();
  return trimmed || undefined;
}

interface TextSelectStepProps {
  pluginId: string;
  dataSource: string;
  label: string;
  fields: TextSelectField[];
  fieldValues: WizardFieldValues;
  sessionId?: string;
  value: CapturedTextSelection[];
  onChange: (value: CapturedTextSelection[]) => void;
}

/**
 * §14.3's manual field-rule capture, ported from the reference app's own `MailFieldRuleCapture`:
 * renders a representative unparsed sample (resolved the same way a ListStep's rows are — a live
 * plugin call, not a fixed snapshot) as one or two blocks of real, selectable text. A real
 * `window.getSelection()` — no custom highlighter — drives capture: which block the selection
 * landed in decides `source`, `computeLabel()` above derives the anchor text, and "Set as {field}"
 * hands the pair back as this step's own value, one entry per field (capturing a new one for the
 * same field replaces its previous entry). Core never interprets what a captured rule *means* —
 * that's the owning plugin's own concern once it lands in the record's `config`.
 */
function TextSelectStep({ pluginId, dataSource, label, fields, fieldValues, sessionId, value, onChange }: TextSelectStepProps) {
  const [sample, setSample] = useState<{ bodyText: string; pdfText?: string; alreadyParsed: boolean } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [selectedText, setSelectedText] = useState('');
  const [selectionSource, setSelectionSource] = useState<'body' | 'pdf' | undefined>(undefined);
  const bodyRef = useRef<HTMLPreElement | null>(null);
  const pdfRef = useRef<HTMLPreElement | null>(null);

  async function load(values: WizardFieldValues) {
    setLoading(true);
    setError(undefined);
    try {
      const result = await window.api.wizardResolveListData({ pluginId, request: { dataSource, fieldValues: values, sessionId } });
      const row = result.rows[0] as { bodyText?: unknown; pdfText?: unknown; alreadyParsed?: unknown } | undefined;
      setSample({
        bodyText: typeof row?.bodyText === 'string' ? row.bodyText : '',
        pdfText: typeof row?.pdfText === 'string' ? row.pdfText : undefined,
        alreadyParsed: row?.alreadyParsed === true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Same auto-apply-on-filter-change, debounced pattern ListStep uses — the representative sample
  // depends on the same filter fields (subject/sender/etc.), so a filter change can change which
  // message (if any) is even worth showing here.
  useEffect(() => {
    const timer = setTimeout(() => void load(fieldValues), FILTER_APPLY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(fieldValues), sessionId]);

  function handleSelect() {
    const selection = window.getSelection();
    const text = selection?.toString() ?? '';
    if (!text || !selection || selection.rangeCount === 0) {
      setSelectedText('');
      setSelectionSource(undefined);
      return;
    }
    const anchorNode = selection.anchorNode;
    const source = bodyRef.current?.contains(anchorNode) ? 'body' : pdfRef.current?.contains(anchorNode) ? 'pdf' : undefined;
    setSelectedText(text);
    setSelectionSource(source);
  }

  function captureAs(fieldName: string) {
    if (!selectedText || !selectionSource || !sample) return;
    const fullText = selectionSource === 'body' ? sample.bodyText : (sample.pdfText ?? '');
    const computed = computeLabel(fullText, selectedText);
    if (!computed) return;
    onChange([...value.filter((rule) => rule.fieldName !== fieldName), { fieldName, source: selectionSource, label: computed }]);
    setSelectedText('');
    setSelectionSource(undefined);
    window.getSelection()?.removeAllRanges();
  }

  function removeRule(fieldName: string) {
    onChange(value.filter((rule) => rule.fieldName !== fieldName));
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{label}</p>
        {loading && (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Loading…
          </span>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {sample && !loading && (sample.alreadyParsed || !sample.bodyText) && (
        <p className="text-sm text-muted-foreground">
          {sample.alreadyParsed
            ? 'Every matching message already parses correctly — nothing to teach here.'
            : 'No matching messages to preview yet.'}
        </p>
      )}
      {sample && !loading && !sample.alreadyParsed && sample.bodyText && (
        <>
          <p className="text-xs text-muted-foreground">
            Highlight the invoice number, date, or amount in the text below, then click "Set as…" to teach this template.
          </p>
          <pre
            ref={bodyRef}
            onMouseUp={handleSelect}
            className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap select-text"
          >
            {sample.bodyText}
          </pre>
          {sample.pdfText && (
            <pre
              ref={pdfRef}
              onMouseUp={handleSelect}
              className="max-h-48 overflow-y-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap select-text"
            >
              {sample.pdfText}
            </pre>
          )}
          <div className="flex flex-wrap gap-2">
            {fields.map((field) => (
              <Button
                key={field.name}
                type="button"
                variant="outline"
                size="sm"
                disabled={!selectedText || !selectionSource}
                onClick={() => captureAs(field.name)}
              >
                Set as {field.label}
              </Button>
            ))}
          </div>
        </>
      )}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {value.map((rule) => (
            <Badge key={rule.fieldName} variant="secondary" className="gap-1">
              {fields.find((field) => field.name === rule.fieldName)?.label ?? rule.fieldName}: "
              {truncate(rule.label, RULE_BADGE_LABEL_MAX_LENGTH)}"
              <button type="button" onClick={() => removeRule(rule.fieldName)} className="ml-0.5 hover:text-destructive">
                <X className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
