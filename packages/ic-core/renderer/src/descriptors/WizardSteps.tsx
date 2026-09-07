import { useEffect, useState } from 'react';
import type { WizardStepDescriptor } from 'invoice-collector-plugin-sdk';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isFieldVisible, seedDetailValuesFromRow, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { FieldInput } from './FieldInput';

const FILTER_APPLY_DEBOUNCE_MS = 400;
const PRIMARY_COLUMN_MAX_LENGTH = 65;
const SECONDARY_COLUMN_MAX_LENGTH = 50;

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
