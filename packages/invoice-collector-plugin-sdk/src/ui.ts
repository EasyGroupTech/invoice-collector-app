/**
 * Declarative UI schema — rendered entirely by core's own React components. A plugin never ships
 * renderer-side code (§8); this is data describing a form/list/detail layout, not markup.
 *
 * Beyond flat field forms, this includes list/detail/selection primitives specifically because a
 * flat form schema can't express real cases this SDK needs to support — e.g.
 * `ic-email-to-downloads`'s mail-message preview list (in current use) and its manual-field-rule
 * capture step (§14.3's backlog item, now built — see `TextSelectDescriptor` below).
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
  /**
   * Auto-selects the first resolved row as soon as it loads, if nothing has been explicitly
   * selected yet — for a list whose rows include a deliberate "default" entry a plugin always
   * returns first (e.g. a folder picker's own "/ (library root)" row), so the user sees *something*
   * already selected instead of an ambiguous "nothing chosen" state for a choice that already has
   * a sensible default. Re-fires the same way after a reload clears the selection (e.g. an upstream
   * list's own selection changed) — the newly-loaded list's own first row becomes the new default,
   * which is the right behavior for exactly this case (a fresh drive's own root, not the old one's).
   */
  autoSelectFirstRow?: boolean;
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

/** One field a text selection can be captured *as* — rendered as its own "Set as {label}" button.
 * Purely a display label + identifier; core has no opinion on what a given `name` means. */
export interface TextSelectField {
  name: string;
  label: string;
}

/**
 * The reference app's own manual-field-rule capture, ported: renders one or two blocks of
 * plain text (resolved via `dataSource`, same live-plugin-call mechanism `ListDescriptor` already
 * uses) that the user can highlight a substring of via a real text selection, then capture as one
 * of `fields` via a button — core computes the ~40-char label preceding the selection and hands
 * back a `CapturedTextSelection`, appended to this step's own value array (`values[name]`). Core
 * neither knows nor interprets what a captured selection *means* (which regex it becomes, how it's
 * applied) — that's entirely the owning plugin's own concern, once this step's value lands in its
 * `config` on record creation.
 *
 * `dataSource` must resolve to a `WizardListDataResult` whose first row matches `TextSelectSample`
 * below.
 */
export interface TextSelectDescriptor {
  kind: 'textSelect';
  name: string;
  label: string;
  fields: TextSelectField[];
  dataSource: string;
}

/** The single row a `TextSelectDescriptor`'s own `dataSource` resolves to. */
export interface TextSelectSample {
  bodyText: string;
  /** Omitted when there's no PDF attachment to also offer a selectable block for. */
  pdfText?: string;
  /**
   * True when there was nothing worth capturing a rule against — either every candidate the
   * plugin checked already parses fully with its own built-in rules, or there were no candidates
   * at all. The renderer shows a plain confirmation instead of the capture UI in that case;
   * `bodyText`/`pdfText` are meaningless (and typically empty) when this is true.
   */
  alreadyParsed: boolean;
}

/** What a user captures via a `TextSelectDescriptor` — appended to that step's own value array as
 * they go. Fully generic: `fieldName` is only ever one of the owning descriptor's own `fields`,
 * `source` says which of the two rendered blocks the selection came from, and `label` is the raw
 * text immediately preceding the selected value (used as a literal match anchor, not a regex the
 * user writes themselves). */
export interface CapturedTextSelection {
  fieldName: string;
  source: 'body' | 'pdf';
  label: string;
}

export type WizardStepDescriptor = FieldDescriptor | ListDescriptor | DetailDescriptor | TextSelectDescriptor;

export interface SettingsPanelDescriptor {
  title: string;
  steps: WizardStepDescriptor[];
}
