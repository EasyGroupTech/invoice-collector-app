import type {
  PluginBackedRecord,
  PluginDestinationRecord,
  PluginManifest,
  PluginSourceRecord,
  SessionRequirement,
  Session,
  SettingsPanelDescriptor,
  WizardListDataRequest,
  WizardListDataResult,
  WizardStepDescriptor,
} from 'invoice-collector-plugin-sdk';
import type { AdvancedSettings } from '../../src/advanced-settings.js';
import type { CollectPeriod } from '../../src/collect-pipeline.js';
import type { EncryptedConfigExportFile } from '../../src/config-export-crypto.js';
import type { ConfigImportResult } from '../../src/config-export.js';
import type { InvoiceHistoryRecord } from '../../src/invoice-history.js';
import type { JobDoneEvent, JobHandle, JobProgressEvent } from '../../src/job-runner.js';
import type { PluginInstallNeedsConfirmation, PluginInstallResult } from '../../src/plugin-install.js';
import type { ProfileSummary } from '../../src/profiles.js';
import type { SbomEntry } from '../../src/sbom-registry.js';

/**
 * The one shared source of truth for every IPC channel name and payload type — imported by main,
 * preload, and (via the window.api surface below, duplicated by hand — see renderer/src/
 * vite-env.d.ts) the renderer. §11's mapping calls for a small set of generic, plugin-routed
 * channels here, not one channel per provider the way the reference app's own (568-line)
 * ipcContracts.ts had — this is the whole set ic-core actually has behavior for as of phase 1.11.
 */
export const Channels = {
  ConfigListSources: 'config:listSources',
  ConfigListDestinations: 'config:listDestinations',
  ConfigCreateRecord: 'config:createRecord',
  ConfigRemoveRecord: 'config:removeRecord',
  ConfigAssignSession: 'config:assignSession',
  ConfigExportAll: 'config:exportAll',
  ConfigPickImportFile: 'config:pickImportFile',
  ConfigImportAll: 'config:importAll',

  ProfilesList: 'profiles:list',
  ProfilesSwitch: 'profiles:switch',
  ProfilesCreate: 'profiles:create',
  ProfilesDelete: 'profiles:delete',

  SessionsList: 'sessions:list',
  SessionsCreate: 'sessions:create',
  SessionsReconnect: 'sessions:reconnect',
  SessionsRefresh: 'sessions:refresh',
  SessionsLogout: 'sessions:logout',
  SessionsSuggestLabel: 'sessions:suggestLabel',
  SessionsRename: 'sessions:rename',

  AppOpenExternal: 'app:openExternal',

  PluginsList: 'plugins:list',
  PluginsInstall: 'plugins:install',
  PluginsUninstall: 'plugins:uninstall',

  WizardResolveListData: 'wizard:resolveListData',

  CollectRun: 'collect:run',
  JobsCancel: 'jobs:cancel',
  JobProgress: 'job:progress',
  JobDone: 'job:done',

  HistoryListForMonth: 'history:listForMonth',
  HistoryGetRetentionMonths: 'history:getRetentionMonths',
  HistorySetRetentionMonths: 'history:setRetentionMonths',
  HistoryClearAll: 'history:clearAll',

  SbomList: 'sbom:list',
  SbomExport: 'sbom:export',

  ReportExport: 'report:export',
  ReportExportRows: 'report:exportRows',

  SettingsGetAdvanced: 'settings:getAdvanced',
  SettingsSaveAdvanced: 'settings:saveAdvanced',

  LogsRead: 'logs:read',
  LogsDownload: 'logs:download',
} as const;

export interface CreateRecordInput {
  kind: 'source' | 'destination';
  pluginId: string;
  pluginVersion: string;
  name: string;
  config: unknown;
  destinationId?: string | null;
  sessionId?: string;
  /** Sources only — see `PluginBackedRecord.scope`. */
  scope?: string;
}

export interface RemoveRecordInput {
  kind: 'source' | 'destination';
  id: string;
}

/** Attaches a session to a record created without one yet (or replaces a stale one) — the "Fix
 * connections" flow (Collect page, phase 1.16 follow-up) walks broken records one at a time and
 * calls this after each. Distinct from `CreateRecordInput.sessionId`, which only ever applies at
 * creation time. */
export interface AssignSessionInput {
  kind: 'source' | 'destination';
  id: string;
  sessionId: string;
}

export interface CreateSessionInput {
  pluginId: string;
  sessionTypeId: string;
  /** Omitted for a confirmsBuiltIn: true requirement whose plugin implements
   * BuiltInSessionInputProvider — main resolves it via resolveSessionCreateInput(). Required
   * otherwise. */
  input?: unknown;
}

export interface ResolveWizardListDataInput {
  pluginId: string;
  request: WizardListDataRequest;
}

/** Also reused as-is for SessionsRefresh (§6's "Refresh" action, `SessionsRegistry.recoverSession`)
 * — same (pluginId, sessionId) shape, just a silent-only attempt rather than
 * SessionsReconnect/`SessionsApi.reconnect`'s silent-refresh-then-interactive-fallback. */
export interface ReconnectSessionInput {
  pluginId: string;
  sessionId: string;
}

/** §6's "friendly session name" follow-up — see `SessionLabelSuggester` in the SDK for what the
 * plugin side of this actually does. */
export interface SuggestSessionLabelInput {
  pluginId: string;
  sessionId: string;
}

export interface RenameSessionInput {
  pluginId: string;
  sessionId: string;
  label: string;
}

export interface ProfileCreateInput {
  name: string;
  copyFromCurrent: boolean;
}

export interface InstallPluginInput {
  rawInput: string;
  confirmUnverified?: boolean;
}

export interface RunCollectInput {
  sourceIds: 'all' | string[];
  period: CollectPeriod;
}

/**
 * What PluginsList actually returns — a bare PluginManifest[] alone can't drive an Add-Source/
 * Destination wizard, since sessionRequirements/wizard/settingsPanel (§5, §6, §8) live on the
 * loaded SourcePlugin/DestinationPlugin object, not the manifest. This is that object's UI-facing
 * subset, serializable across the IPC boundary (no functions — resolveListData etc. stay
 * main-process-only, reached instead via WizardResolveListData).
 */
export interface InstalledPluginSummary {
  manifest: PluginManifest;
  sessionRequirements: SessionRequirement[];
  wizard: WizardStepDescriptor[];
  settingsPanel?: SettingsPanelDescriptor;
}

export type RunCollectResult = JobHandle | { error: string };

/** `filePath` is only set when `exported` is true — the user can cancel the native Save dialog,
 * which isn't an error, just nothing written. Shared by every "hand back a generated file via a
 * native Save dialog" channel (SBOM export, report export, log download). */
export type FileExportResult = { exported: true; filePath: string } | { exported: false };

/** `content` is the log's own tail (see app-log.ts's `readLogTail`'s `TAIL_BYTES_FOR_VIEW`) —
 * `truncated` tells the Settings viewer to say so; `LogsDownload` always copies the full file
 * regardless of what's been read for on-screen viewing. */
export interface LogReadResult {
  content: string;
  truncated: boolean;
}

export interface ExportReportInput {
  period: CollectPeriod;
  format: 'html' | 'excel';
}

/**
 * Exports exactly the rows the Collect page's "Collected invoices" table currently shows (already
 * filtered client-side, per the reference app's own `exportCollected(filteredRows)`) — unlike
 * `ExportReportInput` above, which re-derives everything for a period server-side and has no way
 * to know about a client-side filter. `period` here is display-only (the exported file's own
 * "Period: X to Y" header), not used to re-query.
 */
export interface ExportInvoiceRowsInput {
  records: InvoiceHistoryRecord[];
  period: CollectPeriod;
  format: 'excel' | 'pdf';
}

export type {
  AdvancedSettings,
  ConfigImportResult,
  EncryptedConfigExportFile,
  InvoiceHistoryRecord,
  JobDoneEvent,
  JobHandle,
  JobProgressEvent,
  PluginBackedRecord,
  PluginDestinationRecord,
  PluginInstallNeedsConfirmation,
  PluginInstallResult,
  PluginManifest,
  PluginSourceRecord,
  ProfileSummary,
  SbomEntry,
  Session,
  SessionRequirement,
  SettingsPanelDescriptor,
  WizardListDataRequest,
  WizardListDataResult,
  WizardStepDescriptor,
};
