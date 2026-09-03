/// <reference types="vite/client" />

// Duplicates the shape preload/index.ts actually exposes via contextBridge, as a global
// `window.api` surface, rather than importing it — contextBridge crosses a real isolation
// boundary, so the renderer can't just import preload's own module. Keep this in sync with
// preload/index.ts and ../../electron/shared/ipcContracts.ts by hand when a channel's signature
// changes (same convention CLAUDE.md already documents for the private predecessor app).
import type {
  AdvancedSettings,
  ConfigImportResult,
  CreateRecordInput,
  CreateSessionInput,
  EncryptedConfigExportFile,
  ExportReportInput,
  FileExportResult,
  InstallPluginInput,
  InstalledPluginSummary,
  InvoiceHistoryRecord,
  JobDoneEvent,
  JobHandle,
  JobProgressEvent,
  PluginBackedRecord,
  PluginInstallNeedsConfirmation,
  PluginInstallResult,
  ProfileCreateInput,
  ProfileSummary,
  ReconnectSessionInput,
  RemoveRecordInput,
  ResolveWizardListDataInput,
  RunCollectInput,
  RunCollectResult,
  SbomEntry,
  Session,
  WizardListDataResult,
} from '../../electron/shared/ipcContracts';

declare global {
  interface Window {
    api: {
      configListSources(): Promise<PluginBackedRecord[]>;
      configListDestinations(): Promise<PluginBackedRecord[]>;
      configCreateRecord(input: CreateRecordInput): Promise<PluginBackedRecord>;
      configRemoveRecord(input: RemoveRecordInput): Promise<void>;
      configExportAll(password: string): Promise<EncryptedConfigExportFile>;
      configImportAll(file: EncryptedConfigExportFile, password: string): Promise<ConfigImportResult>;

      profilesList(): Promise<ProfileSummary[]>;
      profilesSwitch(profileId: string): Promise<void>;
      profilesCreate(input: ProfileCreateInput): Promise<ProfileSummary>;
      profilesDelete(profileId: string): Promise<void>;

      sessionsList(): Promise<Session[]>;
      sessionsCreate(input: CreateSessionInput): Promise<JobHandle>;
      sessionsReconnect(input: ReconnectSessionInput): Promise<JobHandle>;

      pluginsList(): Promise<InstalledPluginSummary[]>;
      pluginsInstall(input: InstallPluginInput): Promise<PluginInstallResult | PluginInstallNeedsConfirmation>;
      pluginsUninstall(pluginId: string): Promise<void>;

      wizardResolveListData(input: ResolveWizardListDataInput): Promise<WizardListDataResult>;

      collectRun(input: RunCollectInput): Promise<RunCollectResult>;
      jobsCancel(jobId: string): Promise<void>;

      historyListForMonth(issuedMonth: string): Promise<InvoiceHistoryRecord[]>;

      sbomList(): Promise<SbomEntry[]>;
      sbomExport(id: string): Promise<FileExportResult>;

      reportExport(input: ExportReportInput): Promise<FileExportResult>;

      settingsGetAdvanced(): Promise<AdvancedSettings>;
      settingsSaveAdvanced(settings: AdvancedSettings): Promise<AdvancedSettings>;

      onJobProgress(callback: (event: JobProgressEvent) => void): () => void;
      onJobDone(callback: (event: JobDoneEvent) => void): () => void;
    };
  }
}

export {};
