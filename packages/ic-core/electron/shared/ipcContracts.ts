import type {
  PluginBackedRecord,
  PluginDestinationRecord,
  PluginManifest,
  PluginSourceRecord,
  Session,
} from 'invoice-collector-plugin-sdk';
import type { CollectPeriod } from '../../src/collect-pipeline.js';
import type { EncryptedConfigExportFile } from '../../src/config-export-crypto.js';
import type { ConfigImportResult } from '../../src/config-export.js';
import type { InvoiceHistoryRecord } from '../../src/invoice-history.js';
import type { JobDoneEvent, JobHandle, JobProgressEvent } from '../../src/job-runner.js';
import type { PluginInstallNeedsConfirmation, PluginInstallResult } from '../../src/plugin-install.js';
import type { ProfileSummary } from '../../src/profiles.js';

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

  CollectRun: 'collect:run',
  JobsCancel: 'jobs:cancel',
  JobProgress: 'job:progress',
  JobDone: 'job:done',

  HistoryListForMonth: 'history:listForMonth',
} as const;

export interface CreateRecordInput {
  kind: 'source' | 'destination';
  pluginId: string;
  pluginVersion: string;
  name: string;
  config: unknown;
  destinationId?: string | null;
}

export interface RemoveRecordInput {
  kind: 'source' | 'destination';
  id: string;
}

export interface CreateSessionInput {
  pluginId: string;
  sessionTypeId: string;
  input: unknown;
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

export type RunCollectResult = JobHandle | { error: string };

export type {
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
  Session,
};
