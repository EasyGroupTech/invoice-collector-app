import type { PluginManifest } from './manifest.js';
import type { SessionRequirement } from './session.js';
import type { PluginContext } from './context.js';
import type { WizardStepDescriptor, SettingsPanelDescriptor } from './ui.js';

export interface PluginBackedRecord {
  id: string;
  name: string;
  pluginId: string;
  pluginVersion: string;
  /** Which Session this record authenticates through, if any. */
  sessionId?: string;
  /** Sources only. */
  destinationId?: string | null;
  /**
   * Destinations only. ISO date (YYYY-MM-DD) — the job runner never calls discover() with a
   * period starting earlier than this for sources routed to this destination, guarding against a
   * brand-new destination accidentally backfilling years of history on its first run (§14.1
   * US11). Not a hard filter: a collect run explicitly requesting an earlier period is treated as
   * an intentional backfill and lowers this value to match, remembered for next time — it never
   * silently truncates what the user just asked for.
   */
  collectFromDate?: string;
  /** Plugin-owned JSON, non-secret, non-session config only. */
  config: unknown;
  createdAt: string;
  updatedAt: string;
}

/**
 * Same shape as PluginBackedRecord, just narrowed to `destinationId` present vs. absent
 * respectively — not a separately-defined interface, named where it matters whether a record is
 * a source's or a destination's.
 */
export type PluginSourceRecord = PluginBackedRecord;
export type PluginDestinationRecord = PluginBackedRecord;

export interface DiscoveredInvoice {
  /** Core's dedup key, scoped per-source — never guessed at, always plugin-supplied. */
  id: string;
  issuedDate: string;
  amount?: { value: number; currency: string };
  /** Opaque to core — whatever this plugin's own fetchContent() needs to resolve the actual
   * document later (a pre-signed URL, an API-specific id, …). */
  pluginRef?: unknown;
}

export interface InvoiceContent {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface UploadResult {
  status: 'uploaded' | 'already-existed' | 'overwritten';
}

/**
 * A ListDescriptor's `dataSource` (§8) is a plugin-defined key, not embedded rows — this is the
 * call core's renderer makes (via IPC) to actually resolve it. Fired while a wizard/settings-panel
 * is mid-flow, so there's no PluginBackedRecord yet — only whatever field values have been entered
 * in the same wizard/panel run so far, plus the session established earlier in that same run, if
 * any.
 */
export interface WizardListDataRequest {
  dataSource: string;
  fieldValues: Record<string, unknown>;
  sessionId?: string;
}

export interface WizardListDataResult {
  rows: Array<Record<string, unknown>>;
}

/**
 * Optional — only a plugin whose `wizard`/`settingsPanel` actually contains a ListDescriptor needs
 * to implement this (enforced at install time, see `validateWizardDataSources` in validate.ts).
 */
export interface WizardDataSourceProvider {
  resolveListData?(
    ctx: PluginContext,
    request: WizardListDataRequest,
    signal: AbortSignal,
  ): Promise<WizardListDataResult>;
}

/**
 * A wizard's "create a new session" step (§6) needs *some* `input` to pass into
 * `SessionsApi.create(sessionTypeId, input, ...)` — for a built-in session type
 * (`confirmsBuiltIn: true`), that shape is entirely the built-in's own (e.g. the device-code
 * built-in's `{ deviceAuthorizationEndpoint, tokenEndpoint, clientId, scope, label }`), fixed and
 * known only to the plugin declaring the requirement, not something a generic form could collect.
 * Optional — only meaningful for a `confirmsBuiltIn: true` requirement; a plugin whose
 * `sessionRequirements` are all custom (`confirmsBuiltIn: false`) doesn't need it, since its own
 * `SessionPlugin.create()` already defines what its input shape means.
 *
 * **Known gap, not yet closed**: this doesn't solve the same problem for a *custom* session
 * type's own `create()` input — collecting whatever a third-party `SessionPlugin` expects still
 * has no generic UI mechanism. Deferred until a real plugin actually needs one (the SDK ships
 * exactly one session type today, and it's built-in) rather than guessing the shape now.
 */
export interface BuiltInSessionInputProvider {
  builtInSessionCreateInput?(requirement: SessionRequirement): unknown;
}

export interface PluginLifecycle {
  /**
   * Called once, automatically, when core detects this plugin's version increased from
   * fromVersion to manifest.version — before the new version's discover()/fetchContent()/
   * upload() ever runs. Responsible for migrating anything this plugin owns: its own
   * PluginContext.storage entries and the `config` field of every existing PluginBackedRecord
   * referencing this plugin. Optional — not every version bump needs a data migration.
   */
  migrate?(
    ctx: PluginContext,
    fromVersion: string,
    records: PluginBackedRecord[],
  ): Promise<{ records: PluginBackedRecord[] }>;
}

export interface SourcePlugin extends PluginLifecycle, WizardDataSourceProvider, BuiltInSessionInputProvider {
  manifest: PluginManifest;
  /** Which session type(s) this plugin can use, and what it needs from each — required, must
   * list at least one entry. */
  sessionRequirements: SessionRequirement[];
  wizard: WizardStepDescriptor[];
  settingsPanel?: SettingsPanelDescriptor;
  /** Lightweight enumeration only — metadata, never content. */
  discover(
    ctx: PluginContext,
    record: PluginSourceRecord,
    period: { start: string; end: string },
    signal: AbortSignal,
  ): AsyncGenerator<DiscoveredInvoice>;
  /** Called by core once per discovered invoice, but only for the ones core's own dedup check
   * says aren't already downloaded. */
  fetchContent(
    ctx: PluginContext,
    record: PluginSourceRecord,
    discovered: DiscoveredInvoice,
    signal: AbortSignal,
  ): Promise<InvoiceContent>;
}

export interface DestinationPlugin extends PluginLifecycle, WizardDataSourceProvider, BuiltInSessionInputProvider {
  manifest: PluginManifest;
  sessionRequirements: SessionRequirement[];
  wizard: WizardStepDescriptor[];
  settingsPanel?: SettingsPanelDescriptor;
  /**
   * Core always calls this unconditionally — it never pre-checks whether the destination already
   * has the file. This plugin's own upload() is responsible for implementing whatever override
   * behavior makes sense (skip/overwrite/version) when asked to upload something that already
   * exists, and reporting which via the returned status.
   */
  upload(
    ctx: PluginContext,
    record: PluginDestinationRecord,
    invoice: DiscoveredInvoice & InvoiceContent,
    signal: AbortSignal,
  ): Promise<UploadResult>;
}
