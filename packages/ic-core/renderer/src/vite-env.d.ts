/// <reference types="vite/client" />

// Duplicates the shape preload/index.ts actually exposes via contextBridge, as a global
// `window.api` surface, rather than importing it — contextBridge crosses a real isolation
// boundary, so the renderer can't just import preload's own module. Keep this in sync with
// preload/index.ts and ../../electron/shared/ipcContracts.ts by hand when a channel's signature
// changes (same convention CLAUDE.md already documents for the private predecessor app).
import type {
  ActivatePluginInput,
  AdvancedSettings,
  AssignSessionInput,
  ConfigImportResult,
  CreateRecordInput,
  CreateSessionInput,
  DownloadPluginAssetInput,
  EncryptedConfigExportFile,
  ExportInvoiceRowsInput,
  ExportReportInput,
  FileExportResult,
  InstallPluginInput,
  InstalledPluginPackageSummary,
  InstalledPluginSummary,
  InvoiceHistoryRecord,
  JobDoneEvent,
  JobHandle,
  JobProgressEvent,
  LogReadResult,
  PluginBackedRecord,
  PluginInstallNeedsConfirmation,
  PluginInstallResult,
  ProfileCreateInput,
  ProfileSummary,
  ReconnectSessionInput,
  RemoveRecordInput,
  RenameSessionInput,
  ResolveWizardListDataInput,
  RotateSessionInput,
  RunCollectInput,
  RunCollectResult,
  SbomEntry,
  Session,
  SuggestSessionLabelInput,
  SuggestSourceNameInput,
  SuggestWizardValuesInput,
  UpdateFlowInput,
  WizardListDataResult,
} from '../../electron/shared/ipcContracts';

declare global {
  interface Window {
    api: {
      configListSources(): Promise<PluginBackedRecord[]>;
      configListDestinations(): Promise<PluginBackedRecord[]>;
      configCreateRecord(input: CreateRecordInput): Promise<PluginBackedRecord>;
      configRemoveRecord(input: RemoveRecordInput): Promise<void>;
      flowsDelete(sourceId: string): Promise<void>;
      flowsUpdate(input: UpdateFlowInput): Promise<PluginBackedRecord>;
      flowsSweepOrphans(): Promise<void>;
      configAssignSession(input: AssignSessionInput): Promise<PluginBackedRecord>;
      configExportAll(password: string): Promise<FileExportResult>;
      configPickImportFile(): Promise<EncryptedConfigExportFile | undefined>;
      configImportAll(file: EncryptedConfigExportFile, password: string): Promise<ConfigImportResult>;

      profilesList(): Promise<ProfileSummary[]>;
      profilesSwitch(profileId: string): Promise<void>;
      profilesCreate(input: ProfileCreateInput): Promise<ProfileSummary>;
      profilesDelete(profileId: string): Promise<void>;

      sessionsList(): Promise<Session[]>;
      sessionsCreate(input: CreateSessionInput): Promise<JobHandle>;
      sessionsReconnect(input: ReconnectSessionInput): Promise<JobHandle>;
      sessionsRefresh(input: ReconnectSessionInput): Promise<Session>;
      sessionsLogout(sessionId: string): Promise<void>;
      sessionsRotate(input: RotateSessionInput): Promise<JobHandle>;
      sessionsSuggestLabel(input: SuggestSessionLabelInput): Promise<string | undefined>;
      sessionsRename(input: RenameSessionInput): Promise<Session>;

      pluginsList(): Promise<InstalledPluginSummary[]>;
      pluginsListPackages(): Promise<InstalledPluginPackageSummary[]>;
      pluginsInstall(input: InstallPluginInput): Promise<PluginInstallResult | PluginInstallNeedsConfirmation>;
      pluginsActivate(input: ActivatePluginInput): Promise<{ ok: true } | { ok: false; reason: string }>;
      pluginsUninstall(pluginId: string): Promise<void>;
      pluginsDisable(packageId: string): Promise<void>;
      pluginsEnable(packageId: string): Promise<void>;
      pluginsDownloadAsset(input: DownloadPluginAssetInput): Promise<FileExportResult>;

      wizardResolveListData(input: ResolveWizardListDataInput): Promise<WizardListDataResult>;
      wizardSuggestValues(input: SuggestWizardValuesInput): Promise<Record<string, unknown> | undefined>;
      wizardSuggestSourceName(input: SuggestSourceNameInput): Promise<string | undefined>;

      collectRun(input: RunCollectInput): Promise<RunCollectResult>;
      jobsCancel(jobId: string): Promise<void>;

      historyListForMonth(issuedMonth: string): Promise<InvoiceHistoryRecord[]>;
      historyGetRetentionMonths(): Promise<number>;
      historySetRetentionMonths(months: number): Promise<void>;
      historyClearAll(): Promise<void>;

      sbomList(): Promise<SbomEntry[]>;
      sbomExport(id: string): Promise<FileExportResult>;

      reportExport(input: ExportReportInput): Promise<FileExportResult>;
      reportExportRows(input: ExportInvoiceRowsInput): Promise<FileExportResult>;

      settingsGetAdvanced(): Promise<AdvancedSettings>;
      settingsSaveAdvanced(settings: AdvancedSettings): Promise<AdvancedSettings>;

      logsRead(): Promise<LogReadResult>;
      logsDownload(): Promise<FileExportResult>;

      openExternal(url: string): Promise<void>;

      onJobProgress(callback: (event: JobProgressEvent) => void): () => void;
      onJobDone(callback: (event: JobDoneEvent) => void): () => void;
    };
  }
}

export {};
