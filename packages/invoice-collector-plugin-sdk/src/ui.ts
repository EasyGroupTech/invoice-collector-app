/**
 * Declarative UI schema — rendered entirely by core's own React components. A plugin never ships
 * renderer-side code (§8); this is data describing a form/list/detail layout, not markup.
 *
 * Beyond flat field forms, this includes list/detail/selection primitives specifically because a
 * flat form schema can't express real cases this SDK already has to support — e.g.
 * `ic-email-to-downloads`'s mail-message preview list and its inline manual-field-rule capture
 * form, driven by whichever row is selected.
 */

export type FieldType = 'text' | 'password' | 'number' | 'select' | 'checkbox' | 'textarea';

export interface FieldOption {
  value: string;
  label: string;
}

/** Show this field only when another field in the same step/panel has a given value. */
export interface FieldVisibleWhen {
  field: string;
  equals: unknown;
}

export interface FieldDescriptor {
  kind: 'field';
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string;
  /** Required, and only meaningful, for type: 'select'. */
  options?: FieldOption[];
  visibleWhen?: FieldVisibleWhen;
}

export interface ListColumn {
  key: string;
  label: string;
}

export interface ListDescriptor {
  kind: 'list';
  name: string;
  label: string;
  columns: ListColumn[];
  /**
   * A plugin-defined key the renderer resolves via an IPC call back into this plugin — rows are
   * never embedded directly in the descriptor, so the list can reflect live plugin state (e.g.
   * scanning a mailbox) rather than a fixed snapshot.
   */
  dataSource: string;
  selectable?: boolean;
}

export interface DetailDescriptor {
  kind: 'detail';
  name: string;
  label: string;
  /** Name of a ListDescriptor in the same wizard/panel whose current selection drives this
   * detail view's field values. */
  showsSelectionFrom: string;
  fields: FieldDescriptor[];
}

export type WizardStepDescriptor = FieldDescriptor | ListDescriptor | DetailDescriptor;

export interface SettingsPanelDescriptor {
  title: string;
  steps: WizardStepDescriptor[];
}
