import type { DetailDescriptor, FieldDescriptor, WizardStepDescriptor } from 'invoice-collector-plugin-sdk';

/**
 * Interprets a WizardStepDescriptor[]/SettingsPanelDescriptor's declared fields (§8) — visibility,
 * required-ness, and list/detail row-selection linkage — independent of any UI framework. The
 * actual React rendering (1.12) is a thin consumer of this: step navigation and per-keystroke
 * field-value state are ordinary React state, nothing here needs to own that.
 */
export type WizardFieldValues = Record<string, unknown>;

/** A FieldDescriptor found either as a top-level wizard step, or nested inside a DetailDescriptor. */
export function fieldsOf(step: WizardStepDescriptor): FieldDescriptor[] {
  if (step.kind === 'field') return [step];
  if (step.kind === 'detail') return step.fields;
  return [];
}

/** `visibleWhen` is absent → always visible; present → visible only when the named field's
 * current value strictly equals `equals`. */
export function isFieldVisible(field: FieldDescriptor, values: WizardFieldValues): boolean {
  if (!field.visibleWhen) return true;
  return values[field.visibleWhen.field] === field.visibleWhen.equals;
}

export interface WizardValidationResult {
  valid: boolean;
  /** Names of required, currently-visible fields with no value — a hidden field (its
   * visibleWhen condition unmet) is never required, regardless of its own `required` flag. */
  missingFields: string[];
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/** Validates every FieldDescriptor across a full step list (a wizard, or a settings panel's
 * steps) against one set of field values — required + visible fields must have a non-empty value. */
export function validateWizardValues(steps: WizardStepDescriptor[], values: WizardFieldValues): WizardValidationResult {
  const missingFields: string[] = [];

  for (const step of steps) {
    for (const field of fieldsOf(step)) {
      if (!field.required) continue;
      if (!isFieldVisible(field, values)) continue;
      if (isEmpty(values[field.name])) missingFields.push(field.name);
    }
  }

  return { valid: missingFields.length === 0, missingFields };
}

/**
 * A DetailDescriptor's fields (§8's "inline manual-capture form driven by a selected row's data")
 * are seeded from whichever row is currently selected in its ListDescriptor — this computes that
 * seed, by field name matching the row's own keys. Undefined selection (nothing picked yet) seeds
 * every field to undefined, not an error — the detail form just starts empty.
 */
export function seedDetailValuesFromRow(
  detail: DetailDescriptor,
  selectedRow: Record<string, unknown> | undefined,
): WizardFieldValues {
  const seed: WizardFieldValues = {};
  for (const field of detail.fields) {
    seed[field.name] = selectedRow?.[field.name];
  }
  return seed;
}
