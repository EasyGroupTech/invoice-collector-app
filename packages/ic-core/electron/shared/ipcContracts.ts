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
  ConfigExportAll: 'config:exportAll',
  ConfigImportAll: 'config:importAll',

  ProfilesList: 'profiles:list',
  ProfilesSwitch: 'profiles:switch',
  ProfilesCreate: 'profiles:create',
  ProfilesDelete: 'profiles:delete',

  SessionsList: 'sessions:list',
  SessionsCreate: 'sessions:create',
  SessionsReconnect: 'sessions:reconnect',

  PluginsList: 'plugins:list',
  PluginsInstall: 'plugins:install',
  PluginsUninstall: 'plugins:uninstall',

  WizardResolveListData: 'wizard:resolveListData',

  CollectRun: 'collect:run',
  JobsCancel: 'jobs:cancel',
  JobProgress: 'job:progress',
  JobDone: 'job:done',

  HistoryListForMonth: 'history:listForMonth',

  SbomList: 'sbom:list',
  SbomExport: 'sbom:export',

  SettingsGetAdvanced: 'settings:getAdvanced',
  SettingsSaveAdvanced: 'settings:saveAdvanced',
} as const;

export interface CreateRecordInput {
  kind: 'source' | 'destination';
  pluginId: string;
  pluginVersion: string;
  name: string;
  config: unknown;
  destinationId?: string | null;
  sessionId?: string;
}

export interface RemoveRecordInput {
  kind: 'source' | 'destination';
  id: string;
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

export interface ReconnectSessionInput {
  pluginId: string;
  sessionId: string;
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
 * which isn't an error, just nothing written. */
export type SbomExportResult = { exported: true; filePath: string } | { exported: false };

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
