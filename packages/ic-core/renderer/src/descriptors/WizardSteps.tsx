import { useEffect, useRef, useState } from 'react';
import type { CapturedTextSelection, TextSelectField, WizardStepDescriptor } from 'invoice-collector-plugin-sdk';
import { Loader2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
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
          return (
            <ListStep
              key={step.name}
              pluginId={pluginId}
              dataSource={step.dataSource}
              columns={step.columns}
              label={step.label}
              fieldValues={values}
              sessionId={sessionId}
              selectedRow={selection[step.name]}
              onSelect={(row) => setSelection((prev) => ({ ...prev, [step.name]: row }))}
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
  pluginId: string;
  dataSource: string;
  columns: { key: string; label: string }[];
  label: string;
  fieldValues: WizardFieldValues;
  sessionId?: string;
  selectedRow: Record<string, unknown> | undefined;
  onSelect: (row: Record<string, unknown>) => void;
}

function ListStep({ pluginId, dataSource, columns, label, fieldValues, sessionId, selectedRow, onSelect }: ListStepProps) {
  const [rows, setRows] = useState<Array<Record<string, unknown>> | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  async function load(values: WizardFieldValues) {
    setLoading(true);
    setError(undefined);
    try {
      const result = await window.api.wizardResolveListData({ pluginId, request: { dataSource, fieldValues: values, sessionId } });
      setRows(result.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
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
              className={cn('cursor-pointer p-3 hover:bg-accent/50', row === selectedRow && 'bg-accent')}
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
