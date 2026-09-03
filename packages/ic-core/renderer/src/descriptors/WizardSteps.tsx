import { useEffect, useState } from 'react';
import type { WizardStepDescriptor } from 'invoice-collector-plugin-sdk';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { isFieldVisible, seedDetailValuesFromRow, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { FieldInput } from './FieldInput';

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

  async function load() {
    setLoading(true);
    setError(undefined);
    try {
      const result = await window.api.wizardResolveListData({ pluginId, request: { dataSource, fieldValues, sessionId } });
      setRows(result.rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  // Only on mount — refetching on every keystroke elsewhere in the wizard isn't worth the round
  // trips; a Refresh button covers "my filter fields changed" instead.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{label}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                {columns.map((col) => (
                  <TableHead key={col.key}>{col.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, index) => (
                // Rows have no declared id field (§8's ListDescriptor doesn't require one) — the
                // index is the only stable-enough key available here.
                <TableRow key={index} onClick={() => onSelect(row)} className={cn('cursor-pointer', row === selectedRow && 'bg-accent')}>
                  {columns.map((col) => (
                    <TableCell key={col.key}>{String(row[col.key] ?? '')}</TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
