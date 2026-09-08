import type { PluginImplementationManifest } from './manifest.js';
import type { Session, SessionPlugin, SessionRequirement } from './session.js';
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
  /**
   * Sources only. A free-text label the user optionally assigns when creating the source (§14.1's
   * Add Collector wizard), shown alongside its own invoices in the Collect page's history table.
   * Empty/unset by default — purely a user organizational label (e.g. distinguishing two Graph
   * Mail collectors against the same mailbox with different filters), never derived automatically
   * the way a multi-scope billing provider might set one per discovered invoice.
   */
  scope?: string;
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

/**
 * What a destination's own `upload()` actually receives — `DiscoveredInvoice` and `InvoiceContent`
 * merged, plus `sourceName`: core supplies this (from the `PluginSourceRecord` that discovered the
 * invoice), not the destination plugin itself, since a destination has no other way to know which
 * source an upload came from. Useful for e.g. organizing uploads into a per-source subfolder.
 */
export interface UploadableInvoice extends DiscoveredInvoice, InvoiceContent {
  sourceName: string;
}

export interface UploadResult {
  status: 'uploaded' | 'already-existed' | 'overwritten';
  /**
   * Where the invoice actually landed — a filesystem path for a local-folder-style destination, a
   * URL for a cloud one, whatever's meaningful for a user to go find the file afterward. Optional:
   * a destination type without a stable "here's where it is" answer can omit this; the UI falls
   * back to the destination's own name instead.
   */
  location?: string;
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
 * **Partial gap, still open**: this doesn't solve the general problem for a *custom* session
 * type's own `create()` input when that input is a real, non-trivial shape (structured fields a
 * plugin author needs collected from the user) — there's still no generic UI mechanism for that.
 * The trivial sub-case — a custom `create()` that needs no programmatic input at all because it
 * gathers everything interactively itself (an OS-native picker/prompt, e.g. the local-filesystem
 * destination's folder-access session) — is already covered: this same hook works for a custom
 * type too, since `resolveSessionCreateInput()` falls back to it whenever no input was otherwise
 * supplied, regardless of `confirmsBuiltIn`. Only the non-trivial, real-input case is still
 * deferred until a plugin actually needs it.
 */
export interface BuiltInSessionInputProvider {
  builtInSessionCreateInput?(requirement: SessionRequirement): unknown;
}

/**
 * Called once, right after a session this plugin uses has just been created — an opportunity to
 * suggest a friendlier label than whatever the session type itself set (a built-in like the
 * device-code one has no way to know it's talking to, say, "Graph Mail for Contoso Ltd" — it just
 * sets whatever generic label the calling plugin supplied via `builtInSessionCreateInput`). The
 * suggestion is made by calling *through* the now-established session (`ctx.http` with the
 * session's own id already works for this — the session is fully persisted by the time this
 * runs), e.g. looking up the signed-in tenant's own verified domain. Optional — a plugin with
 * nothing better to suggest just omits this; a thrown/rejected call is treated the same as
 * returning `undefined`, since a suggestion is a nice-to-have, never something session creation
 * itself should be blocked on. The caller (core's own Sessions UI/wizard) decides whether and how
 * to let the user accept, edit, or ignore the suggestion — this hook only ever proposes a string.
 */
export interface SessionLabelSuggester {
  suggestSessionLabel?(ctx: PluginContext, session: Session, signal: AbortSignal): Promise<string | undefined>;
}

export interface PluginLifecycle {
  /**
   * Called once, automatically, when core detects the *package* this implementation belongs to
   * has a version increased from fromVersion to the package's own current version (§9.4 — version
   * is a package-level property, shared by every implementation the package bundles) — before the
   * new version's discover()/fetchContent()/upload() ever runs. Responsible for migrating anything
   * this implementation owns: its own PluginContext.storage entries and the `config` field of
   * every existing PluginBackedRecord referencing it. Optional — not every version bump needs a
   * data migration.
   */
  migrate?(
    ctx: PluginContext,
    fromVersion: string,
    records: PluginBackedRecord[],
  ): Promise<{ records: PluginBackedRecord[] }>;
}

export interface SourcePlugin extends PluginLifecycle, WizardDataSourceProvider, BuiltInSessionInputProvider, SessionLabelSuggester {
  manifest: PluginImplementationManifest;
  /** Which session type(s) this plugin can use, and what it needs from each — required, must
   * list at least one entry. */
  sessionRequirements: SessionRequirement[];
  /** Present when this plugin brings its own custom session type (one or more
   * `sessionRequirements` entries with `confirmsBuiltIn: false`) — core registers it in the
   * Sessions registry alongside the plugin itself, at install time, the same way it registers the
   * SDK's own built-ins at boot (§6). Omit when every declared sessionTypeId is a built-in. */
  sessionPlugin?: SessionPlugin;
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

export interface DestinationPlugin extends PluginLifecycle, WizardDataSourceProvider, BuiltInSessionInputProvider, SessionLabelSuggester {
  manifest: PluginImplementationManifest;
  sessionRequirements: SessionRequirement[];
  /** See `SourcePlugin.sessionPlugin` — same mechanism, same reason. */
  sessionPlugin?: SessionPlugin;
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
    invoice: UploadableInvoice,
    signal: AbortSignal,
  ): Promise<UploadResult>;
}
